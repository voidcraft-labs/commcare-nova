import { afterEach, describe, expect, it, vi } from "vitest";
import {
	XPathRuntime,
	type XPathWorkerFactory,
	type XPathWorkerPort,
} from "../workerClient";
import {
	XPATH_WORKER_BUILD_ID,
	XPATH_WORKER_PROTOCOL_VERSION,
	type XPathRuntimeRequest,
	type XPathWorkerRequest,
	type XPathWorkerResponse,
} from "../workerProtocol";

const runtimes: XPathRuntime[] = [];
function ownedRuntime(options: ConstructorParameters<typeof XPathRuntime>[0]) {
	const runtime = new XPathRuntime(options);
	runtimes.push(runtime);
	return runtime;
}
afterEach(() => {
	for (const runtime of runtimes.splice(0)) runtime.dispose();
	if (vi.isFakeTimers()) expect(vi.getTimerCount()).toBe(0);
	vi.useRealTimers();
});

type MessageListener = (event: { readonly data: XPathWorkerResponse }) => void;
type OptionalBuildIdentity<T> = T extends unknown
	? Omit<T, "buildId"> & { readonly buildId?: string }
	: never;

class ControlledWorker implements XPathWorkerPort {
	readonly requests: XPathWorkerRequest[] = [];
	terminated = false;
	postFailure: Error | undefined;
	get listenerCount() {
		return this.messageListeners.size + this.errorListeners.size;
	}
	fail() {
		for (const listener of this.errorListeners) listener();
	}
	private readonly messageListeners = new Set<MessageListener>();
	private readonly errorListeners = new Set<() => void>();

	postMessage(message: XPathWorkerRequest): void {
		if (this.postFailure) throw this.postFailure;
		this.requests.push(message);
	}

	addEventListener(
		type: "message" | "error",
		listener: MessageListener | (() => void),
	) {
		if (type === "message")
			this.messageListeners.add(listener as MessageListener);
		else this.errorListeners.add(listener as () => void);
	}

	removeEventListener(
		type: "message" | "error",
		listener: MessageListener | (() => void),
	) {
		if (type === "message") {
			this.messageListeners.delete(listener as MessageListener);
		} else {
			this.errorListeners.delete(listener as () => void);
		}
	}

	terminate(): void {
		this.terminated = true;
	}

	respond(response: OptionalBuildIdentity<XPathWorkerResponse>): void {
		const data = {
			...response,
			buildId: response.buildId ?? XPATH_WORKER_BUILD_ID,
		} as XPathWorkerResponse;
		for (const listener of this.messageListeners) listener({ data });
	}
}

function controlledFactory(): {
	readonly factory: XPathWorkerFactory;
	readonly workers: ControlledWorker[];
} {
	const workers: ControlledWorker[] = [];
	return {
		workers,
		factory: () => {
			const worker = new ControlledWorker();
			workers.push(worker);
			return worker;
		},
	};
}

function request(
	overrides: Partial<XPathRuntimeRequest> = {},
): XPathRuntimeRequest {
	return {
		entryKey: "entry-a",
		revision: 1,
		profile: "form",
		source: "1 + 1",
		instances: { contextPath: "/data/value" },
		...overrides,
	};
}

function evaluateRequest(worker: ControlledWorker) {
	const message = worker.requests.find(
		(candidate) => candidate.operation === "evaluate",
	);
	if (message?.operation !== "evaluate") {
		throw new Error("Expected an evaluation request");
	}
	return message;
}

describe("XPath worker host protocol", () => {
	it("reuses a settled worker for the next revision of the same entry", async () => {
		const controlled = controlledFactory();
		const runtime = ownedRuntime({ workerFactory: controlled.factory });
		const first = runtime.request(request());
		const worker = controlled.workers[0];
		if (!worker) throw new Error("Expected worker");
		const firstRequest = evaluateRequest(worker);
		worker.respond({
			protocolVersion: XPATH_WORKER_PROTOCOL_VERSION,
			operation: "evaluate",
			requestId: firstRequest.requestId,
			entryKey: firstRequest.entryKey,
			revision: firstRequest.revision,
			profile: firstRequest.profile,
			ok: true,
			value: 2,
		});
		await expect(first).resolves.toMatchObject({ ok: true, value: 2 });

		const second = runtime.request(request({ revision: 2 }));
		expect(controlled.workers).toHaveLength(1);
		expect(worker.terminated).toBe(false);
		const secondRequest = worker.requests.find(
			(candidate) =>
				candidate.operation === "evaluate" && candidate.revision === 2,
		);
		if (secondRequest?.operation !== "evaluate") {
			throw new Error("Expected second-revision request");
		}
		worker.respond({
			protocolVersion: XPATH_WORKER_PROTOCOL_VERSION,
			operation: "evaluate",
			requestId: secondRequest.requestId,
			entryKey: secondRequest.entryKey,
			revision: secondRequest.revision,
			profile: secondRequest.profile,
			ok: true,
			value: 3,
		});
		await expect(second).resolves.toMatchObject({
			ok: true,
			revision: 2,
			value: 3,
		});
		runtime.dispose();
	});

	it("retires the prior worker when the revision changes", async () => {
		const controlled = controlledFactory();
		const runtime = ownedRuntime({ workerFactory: controlled.factory });
		const first = runtime.request(request());
		const second = runtime.request(request({ revision: 2 }));

		expect(controlled.workers).toHaveLength(2);
		expect(controlled.workers[0]?.terminated).toBe(true);
		await expect(first).resolves.toMatchObject({
			ok: false,
			error: { code: "stale", entryKey: "entry-a", revision: 1 },
		});

		const currentWorker = controlled.workers[1];
		if (!currentWorker) throw new Error("Expected replacement worker");
		const sent = evaluateRequest(currentWorker);
		currentWorker.respond({
			protocolVersion: XPATH_WORKER_PROTOCOL_VERSION,
			operation: "evaluate",
			requestId: sent.requestId,
			entryKey: sent.entryKey,
			revision: sent.revision,
			profile: sent.profile,
			ok: true,
			value: 2,
		});
		await expect(second).resolves.toMatchObject({
			ok: true,
			revision: 2,
			value: 2,
		});
		runtime.dispose();
	});

	it("discards a late response from a retired generation", async () => {
		const controlled = controlledFactory();
		const runtime = ownedRuntime({ workerFactory: controlled.factory });
		const first = runtime.request(request());
		const firstWorker = controlled.workers[0];
		if (!firstWorker) throw new Error("Expected first worker");
		const staleRequest = evaluateRequest(firstWorker);
		const second = runtime.request(request({ entryKey: "entry-b" }));
		await expect(first).resolves.toMatchObject({
			ok: false,
			error: { code: "stale" },
		});

		firstWorker.respond({
			protocolVersion: XPATH_WORKER_PROTOCOL_VERSION,
			operation: "evaluate",
			requestId: staleRequest.requestId,
			entryKey: staleRequest.entryKey,
			revision: staleRequest.revision,
			profile: staleRequest.profile,
			ok: true,
			value: "stale-value",
		});

		const secondWorker = controlled.workers[1];
		if (!secondWorker) throw new Error("Expected second worker");
		const currentRequest = evaluateRequest(secondWorker);
		secondWorker.respond({
			protocolVersion: XPATH_WORKER_PROTOCOL_VERSION,
			operation: "evaluate",
			requestId: currentRequest.requestId,
			entryKey: currentRequest.entryKey,
			revision: currentRequest.revision,
			profile: currentRequest.profile,
			ok: true,
			value: "current-value",
		});
		await expect(second).resolves.toMatchObject({
			ok: true,
			entryKey: "entry-b",
			value: "current-value",
		});
		runtime.dispose();
	});

	it("terminates the worker when a request times out", async () => {
		vi.useFakeTimers();
		const controlled = controlledFactory();
		const runtime = ownedRuntime({
			workerFactory: controlled.factory,
			requestTimeoutMilliseconds: 25,
		});
		const result = runtime.request(request());
		await vi.advanceTimersByTimeAsync(25);

		await expect(result).resolves.toMatchObject({
			ok: false,
			error: { code: "timeout", entryKey: "entry-a", revision: 1 },
		});
		expect(controlled.workers[0]?.terminated).toBe(true);
		expect(vi.getTimerCount()).toBe(0);
		runtime.dispose();
	});

	it("pauses the CPU watchdog for a worker yield and restarts it on resume", async () => {
		vi.useFakeTimers();
		const controlled = controlledFactory();
		const runtime = ownedRuntime({
			workerFactory: controlled.factory,
			requestTimeoutMilliseconds: 25,
		});
		const result = runtime.request(request({ source: "sleep(100, 'ok')" }));
		const worker = controlled.workers[0];
		if (!worker) throw new Error("Expected worker");
		const sent = evaluateRequest(worker);

		worker.respond({
			protocolVersion: XPATH_WORKER_PROTOCOL_VERSION,
			operation: "watchdog",
			state: "pause",
			requestId: sent.requestId,
			entryKey: sent.entryKey,
			revision: sent.revision,
			profile: sent.profile,
		});
		await vi.advanceTimersByTimeAsync(100);
		expect(worker.terminated).toBe(false);
		expect(vi.getTimerCount()).toBe(0);

		worker.respond({
			protocolVersion: XPATH_WORKER_PROTOCOL_VERSION,
			operation: "watchdog",
			state: "resume",
			requestId: sent.requestId,
			entryKey: sent.entryKey,
			revision: sent.revision,
			profile: sent.profile,
		});
		await vi.advanceTimersByTimeAsync(25);
		await expect(result).resolves.toMatchObject({
			ok: false,
			error: { code: "timeout", entryKey: "entry-a", revision: 1 },
		});
		expect(worker.terminated).toBe(true);
		expect(vi.getTimerCount()).toBe(0);
		runtime.dispose();
	});

	it("terminates the worker when cancellation may interrupt synchronous work", async () => {
		vi.useFakeTimers();
		const controlled = controlledFactory();
		const runtime = ownedRuntime({
			workerFactory: controlled.factory,
			requestTimeoutMilliseconds: 25,
		});
		const cancellation = new AbortController();
		const result = runtime.request(
			request({ source: "regex('x', '(x+)+y')" }),
			{
				signal: cancellation.signal,
			},
		);
		const worker = controlled.workers[0];
		if (!worker) throw new Error("Expected worker");

		cancellation.abort();

		await expect(result).resolves.toMatchObject({
			ok: false,
			error: { code: "cancelled", entryKey: "entry-a", revision: 1 },
		});
		expect(worker.terminated).toBe(true);
		expect(vi.getTimerCount()).toBe(0);

		const next = runtime.request(request());
		expect(controlled.workers).toHaveLength(2);
		const replacement = controlled.workers[1];
		if (!replacement) throw new Error("Expected replacement worker");
		const sent = evaluateRequest(replacement);
		replacement.respond({
			protocolVersion: XPATH_WORKER_PROTOCOL_VERSION,
			operation: "evaluate",
			requestId: sent.requestId,
			entryKey: sent.entryKey,
			revision: sent.revision,
			profile: sent.profile,
			ok: true,
			value: 2,
		});
		await expect(next).resolves.toMatchObject({ ok: true, value: 2 });
		runtime.dispose();
	});

	it("suspends without permanently disabling a provider-owned runtime", async () => {
		const controlled = controlledFactory();
		const runtime = ownedRuntime({ workerFactory: controlled.factory });
		const pending = runtime.request(request());
		const firstWorker = controlled.workers[0];
		if (!firstWorker) throw new Error("Expected first worker");

		runtime.suspend();

		await expect(pending).resolves.toMatchObject({
			ok: false,
			error: { code: "retired" },
		});
		expect(firstWorker.terminated).toBe(true);
		await expect(runtime.request(request())).resolves.toMatchObject({
			ok: false,
			error: { code: "retired" },
		});
		expect(controlled.workers).toHaveLength(1);

		runtime.resume();
		const resumed = runtime.request(request({ revision: 2 }));
		const replacement = controlled.workers[1];
		if (!replacement) throw new Error("Expected replacement worker");
		const sent = evaluateRequest(replacement);
		replacement.respond({
			protocolVersion: XPATH_WORKER_PROTOCOL_VERSION,
			operation: "evaluate",
			requestId: sent.requestId,
			entryKey: sent.entryKey,
			revision: sent.revision,
			profile: sent.profile,
			ok: true,
			value: "resumed",
		});
		await expect(resumed).resolves.toMatchObject({
			ok: true,
			value: "resumed",
		});

		runtime.dispose();
		runtime.resume();
		await expect(
			runtime.request(request({ revision: 3 })),
		).resolves.toMatchObject({
			ok: false,
			error: { code: "retired" },
		});
		expect(controlled.workers).toHaveLength(2);
	});

	it("retires the matching entry on navigation", async () => {
		const controlled = controlledFactory();
		const runtime = ownedRuntime({ workerFactory: controlled.factory });
		const result = runtime.request(request());
		const worker = controlled.workers[0];
		if (!worker) throw new Error("Expected worker");

		runtime.retire("another-entry");
		expect(worker.terminated).toBe(false);
		runtime.retire("entry-a");

		await expect(result).resolves.toMatchObject({
			ok: false,
			error: { code: "retired", entryKey: "entry-a", revision: 1 },
		});
		expect(worker.terminated).toBe(true);
	});

	it("rejects a response whose revision metadata does not match", async () => {
		const controlled = controlledFactory();
		const runtime = ownedRuntime({ workerFactory: controlled.factory });
		const result = runtime.request(request());
		const worker = controlled.workers[0];
		if (!worker) throw new Error("Expected worker");
		const sent = evaluateRequest(worker);
		worker.respond({
			protocolVersion: XPATH_WORKER_PROTOCOL_VERSION,
			operation: "evaluate",
			requestId: sent.requestId,
			entryKey: sent.entryKey,
			revision: sent.revision + 1,
			profile: sent.profile,
			ok: true,
			value: "wrong-revision",
		});

		await expect(result).resolves.toMatchObject({
			ok: false,
			error: { code: "protocol-mismatch", revision: 1 },
		});
		expect(worker.terminated).toBe(true);
	});

	it("retires the Worker and invokes recovery when it belongs to another build", async () => {
		const controlled = controlledFactory();
		const recover = vi.fn();
		const runtime = ownedRuntime({
			workerFactory: controlled.factory,
			onBuildMismatch: recover,
		});
		const result = runtime.request(request());
		const worker = controlled.workers[0];
		if (!worker) throw new Error("Expected worker");
		const sent = evaluateRequest(worker);
		worker.respond({
			protocolVersion: XPATH_WORKER_PROTOCOL_VERSION,
			buildId: "different-deploy",
			operation: "evaluate",
			requestId: sent.requestId,
			entryKey: sent.entryKey,
			revision: sent.revision,
			profile: sent.profile,
			ok: false,
			error: {
				code: "protocol-mismatch",
				operation: "evaluate",
				entryKey: sent.entryKey,
				revision: sent.revision,
				profile: sent.profile,
			},
		});

		await expect(result).resolves.toMatchObject({
			ok: false,
			error: { code: "protocol-mismatch" },
		});
		expect(worker.terminated).toBe(true);
		expect(recover).toHaveBeenCalledTimes(1);
		runtime.dispose();
	});
	it("rejects invalid requests and pre-cancellation without constructing a worker", async () => {
		const controlled = controlledFactory();
		const runtime = ownedRuntime({ workerFactory: controlled.factory });
		for (const revision of [
			-1,
			0.5,
			Number.NaN,
			Number.POSITIVE_INFINITY,
			Number.MAX_SAFE_INTEGER + 1,
		]) {
			await expect(
				runtime.request(request({ revision })),
			).resolves.toMatchObject({
				ok: false,
				error: { code: "invalid-request" },
			});
		}
		for (const timeoutMilliseconds of [
			-1,
			0.5,
			Number.NaN,
			Number.POSITIVE_INFINITY,
		]) {
			await expect(
				runtime.request(request(), { timeoutMilliseconds }),
			).resolves.toMatchObject({
				ok: false,
				error: { code: "invalid-request" },
			});
		}
		const controller = new AbortController();
		controller.abort();
		await expect(
			runtime.request(request(), { signal: controller.signal }),
		).resolves.toMatchObject({ ok: false, error: { code: "cancelled" } });
		expect(controlled.workers).toEqual([]);
	});

	it("settles sibling work, listeners and timers when one same-revision request is cancelled", async () => {
		vi.useFakeTimers();
		const controlled = controlledFactory();
		const runtime = ownedRuntime({
			workerFactory: controlled.factory,
			requestTimeoutMilliseconds: 100,
		});
		const cancellation = new AbortController();
		const first = runtime.request(request(), { signal: cancellation.signal });
		const second = runtime.request(request({ source: "3 + 4" }));
		const worker = controlled.workers[0];
		expect(controlled.workers).toHaveLength(1);
		expect(worker.listenerCount).toBe(2);
		cancellation.abort();
		await expect(first).resolves.toMatchObject({
			ok: false,
			error: { code: "cancelled" },
		});
		await expect(second).resolves.toMatchObject({
			ok: false,
			error: { code: "retired" },
		});
		expect(worker.listenerCount).toBe(0);
		expect(worker.terminated).toBe(true);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("settles all pending work on native worker errors and postMessage failures", async () => {
		for (const failure of ["event", "post"] as const) {
			const controlled = controlledFactory();
			const runtime = ownedRuntime({ workerFactory: controlled.factory });
			const first = runtime.request(request());
			const worker = controlled.workers[0];
			if (failure === "post") worker.postFailure = new Error("DataCloneError");
			const second = runtime.request(request());
			if (failure === "event") worker.fail();
			await expect(first).resolves.toMatchObject({
				ok: false,
				error: { code: "worker-failed" },
			});
			await expect(second).resolves.toMatchObject({
				ok: false,
				error: {
					code: failure === "post" ? "protocol-mismatch" : "worker-failed",
				},
			});
			expect(worker.terminated).toBe(true);
			expect(worker.listenerCount).toBe(0);
		}
	});
});
