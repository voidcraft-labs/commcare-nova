import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface RecordedClient {
	readonly connect: ReturnType<typeof vi.fn>;
	readonly query: ReturnType<typeof vi.fn>;
	readonly end: ReturnType<typeof vi.fn>;
	readonly connection: { stream: { destroy: ReturnType<typeof vi.fn> } };
	deferEnd: boolean;
	emit(event: string, ...args: unknown[]): boolean;
	releaseEnd(): void;
}

const fakePg = vi.hoisted(() => ({
	instances: [] as RecordedClient[],
}));

vi.mock("pg", async () => {
	const { EventEmitter } = await import("node:events");

	class FakeClient extends EventEmitter {
		deferEnd = false;
		private resolveEnd: (() => void) | null = null;

		readonly connect = vi.fn(async () => {});
		readonly query = vi.fn(async () => ({ rows: [] }));
		readonly end = vi.fn(async () => {
			if (!this.deferEnd) return;
			await new Promise<void>((resolve) => {
				this.resolveEnd = resolve;
			});
		});
		readonly connection = {
			stream: { destroy: vi.fn(() => this.releaseEnd()) },
		};

		constructor() {
			super();
			fakePg.instances.push(this as unknown as RecordedClient);
		}

		releaseEnd(): void {
			this.resolveEnd?.();
			this.resolveEnd = null;
		}
	}

	return { Client: FakeClient };
});

vi.mock("@/lib/case-store/postgres/connection", () => ({
	buildDedicatedClientConfig: vi.fn(async () => ({})),
}));

vi.mock("@/lib/logger", () => ({
	log: { warn: vi.fn() },
}));

vi.mock("../pg", () => ({
	APP_STREAM_CHANNEL: "nova_app_stream",
	PRESENCE_CHANNEL: "nova_presence",
	CHAT_STREAM_CHANNEL: "nova_chat_stream",
	LOOKUP_STREAM_CHANNEL: "nova_lookup_stream",
}));

const {
	__setListenerConfigForTests,
	closeStreamListener,
	subscribeAppStream,
	subscribeChatStream,
	subscribeLookupProject,
} = await import("../streamListener");

async function waitForClientCount(count: number): Promise<void> {
	await vi.waitFor(() => expect(fakePg.instances).toHaveLength(count), {
		interval: 1,
		timeout: 1_000,
	});
}

async function settleMicrotasks(): Promise<void> {
	/* A reconnect crosses the old client's end promise, config resolution,
	 * connect, four sequential LISTEN queries, and the connecting-promise
	 * cleanup. Drain that whole deterministic chain without a real timer. */
	for (let i = 0; i < 50; i += 1) await Promise.resolve();
}

function notify(
	client: RecordedClient,
	channel: string,
	payload: Record<string, unknown>,
): void {
	client.emit("notification", { channel, payload: JSON.stringify(payload) });
}

beforeEach(async () => {
	await closeStreamListener();
	__setListenerConfigForTests("postgresql://listener.test/nova");
	fakePg.instances.length = 0;
});

afterEach(async () => {
	await closeStreamListener();
	__setListenerConfigForTests(null);
	vi.useRealTimers();
});

describe("shared stream listener", () => {
	it("uses one client for all four LISTEN channels and preserves existing fan-out", async () => {
		const onMutation = vi.fn();
		const onPresence = vi.fn();
		const onChat = vi.fn();
		const onLookup = vi.fn();

		const unsubscribeApp = subscribeAppStream("app-a", onMutation, onPresence);
		const unsubscribeChat = subscribeChatStream("stream-a", onChat);
		const unsubscribeLookup = subscribeLookupProject("project-a", onLookup);
		await waitForClientCount(1);
		await vi.waitFor(() =>
			expect(fakePg.instances[0]?.query).toHaveBeenCalledTimes(4),
		);
		await vi.waitFor(() => expect(onLookup).toHaveBeenCalledWith("0"));

		const current = fakePg.instances[0];
		if (!current) throw new Error("listener client was not constructed");
		expect(current.query.mock.calls.map(([sql]) => sql)).toEqual([
			"LISTEN nova_app_stream",
			"LISTEN nova_presence",
			"LISTEN nova_chat_stream",
			"LISTEN nova_lookup_stream",
		]);

		// Ignore the initial-connect catch-up; the assertions below pin ordinary
		// notification routing for every pre-existing subscriber kind.
		onMutation.mockClear();
		onPresence.mockClear();
		onChat.mockClear();
		onLookup.mockClear();
		notify(current, "nova_app_stream", { appId: "app-a", seq: 41 });
		notify(current, "nova_presence", { appId: "app-a" });
		notify(current, "nova_chat_stream", { streamId: "stream-a" });

		expect(onMutation).toHaveBeenCalledExactlyOnceWith(41);
		expect(onPresence).toHaveBeenCalledOnce();
		expect(onChat).toHaveBeenCalledOnce();
		expect(onLookup).not.toHaveBeenCalled();

		unsubscribeApp();
		unsubscribeChat();
		unsubscribeLookup();
	});

	it("fans exact bigint revisions only to the named Project", async () => {
		const onA = vi.fn();
		const onB = vi.fn();
		const unsubscribeA = subscribeLookupProject("project-a", onA);
		const unsubscribeB = subscribeLookupProject("project-b", onB);
		await waitForClientCount(1);
		await vi.waitFor(() => expect(onA).toHaveBeenCalledWith("0"));
		onA.mockClear();
		onB.mockClear();

		const current = fakePg.instances[0];
		if (!current) throw new Error("listener client was not constructed");
		const exactRevision = "9223372036854775807";
		notify(current, "nova_lookup_stream", {
			projectId: "project-a",
			revision: exactRevision,
		});

		expect(onA).toHaveBeenCalledExactlyOnceWith(exactRevision);
		expect(onB).not.toHaveBeenCalled();

		// A numeric payload would already have lost bigint precision and must not
		// cross the listener boundary as a rounded revision.
		notify(current, "nova_lookup_stream", {
			projectId: "project-a",
			revision: 9_223_372_036_854_776_000,
		});
		notify(current, "nova_lookup_stream", {
			projectId: "project-a",
			revision: "9223372036854775808",
		});
		expect(onA).toHaveBeenCalledTimes(1);

		unsubscribeA();
		unsubscribeB();
	});

	it("serializes old-client closure before reconnect and emits a catch-up sentinel", async () => {
		const onLookup = vi.fn();
		const unsubscribe = subscribeLookupProject("project-a", onLookup);
		await waitForClientCount(1);
		await vi.waitFor(() => expect(onLookup).toHaveBeenCalledWith("0"));
		onLookup.mockClear();

		const first = fakePg.instances[0];
		if (!first) throw new Error("listener client was not constructed");
		vi.useFakeTimers();
		first.deferEnd = true;
		first.emit("error", new Error("forced disconnect"));

		// The reconnect timer may fire while graceful closure is still pending,
		// but constructing the replacement is forbidden until the old socket is
		// gone. A lookup commit notification in this gap is intentionally missed.
		await vi.advanceTimersByTimeAsync(250);
		expect(fakePg.instances).toHaveLength(1);
		expect(onLookup).not.toHaveBeenCalled();

		first.releaseEnd();
		await settleMicrotasks();
		expect(fakePg.instances).toHaveLength(2);
		const replacement = fakePg.instances[1];
		expect(replacement?.connect).toHaveBeenCalledOnce();
		// The advisory reconnect poke makes the reader re-select the complete
		// manifest, converging any commit whose notification fell in the gap.
		expect(onLookup).toHaveBeenCalledExactlyOnceWith("0");

		unsubscribe();
	});

	it("has idempotent unsubscribe and teardown clears lookup dispatch", async () => {
		const onLookup = vi.fn();
		const unsubscribe = subscribeLookupProject("project-a", onLookup);
		await waitForClientCount(1);
		await vi.waitFor(() => expect(onLookup).toHaveBeenCalledWith("0"));
		onLookup.mockClear();

		const first = fakePg.instances[0];
		if (!first) throw new Error("listener client was not constructed");
		unsubscribe();
		unsubscribe();
		notify(first, "nova_lookup_stream", {
			projectId: "project-a",
			revision: "17",
		});
		expect(onLookup).not.toHaveBeenCalled();

		await closeStreamListener();
		expect(first.end).toHaveBeenCalledOnce();
		notify(first, "nova_lookup_stream", {
			projectId: "project-a",
			revision: "18",
		});
		expect(onLookup).not.toHaveBeenCalled();
	});
});
