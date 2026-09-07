import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createDocumentExtraction } from "../documentExtraction";

const ready = {
	status: "ready",
	version: 1,
	truncated: false,
	charCount: 12,
	title: "Protocol",
} as const;
const extracting = { ...ready, status: "extracting" } as const;
const failed = { ...ready, status: "failed" } as const;
function response(
	extract: typeof ready | typeof extracting | typeof failed,
	progress = false,
) {
	return new Response(
		(progress ? `${JSON.stringify({ type: "progress", chars: 12 })}\n` : "") +
			`${JSON.stringify({ type: "done", extract })}\n`,
	);
}
const owned: ReturnType<typeof createDocumentExtraction>[] = [];
const deliveries: ReturnType<typeof Promise.withResolvers<Response>>[] = [];
const tasks = new Set<Promise<void>>();
function delivery() {
	const next = Promise.withResolvers<Response>();
	deliveries.push(next);
	return next;
}
function track(task: Promise<void>) {
	tasks.add(task);
	return task;
}
function model(options: Parameters<typeof createDocumentExtraction>[0]) {
	const state = createDocumentExtraction(options);
	owned.push(state);
	return {
		...state,
		start: () => track(state.start()),
		retry: () => track(state.retry()),
	};
}
beforeEach(() => vi.useFakeTimers());
afterEach(async () => {
	try {
		for (const state of owned.splice(0)) state.stop();
		for (const pending of deliveries.splice(0))
			pending.resolve(response(failed));
		const settled = await Promise.allSettled(tasks);
		for (const result of settled) expect(result.status).toBe("fulfilled");
		expect(vi.getTimerCount()).toBe(0);
	} finally {
		tasks.clear();
		vi.useRealTimers();
		vi.restoreAllMocks();
	}
});

test.each([
	{ asset: { id: "a", kind: "image" as const } },
	{ asset: { id: "a", kind: "pdf" as const }, enabled: false },
])(
	"a non-document or viewer cannot start or retry extraction",
	async (options) => {
		const fetch = vi
			.spyOn(globalThis, "fetch")
			.mockRejectedValue(Error("unexpected request"));
		const state = model(options);
		await state.start();
		await state.retry();
		expect(state.getSnapshot()).toBeNull();
		expect(fetch).not.toHaveBeenCalled();
	},
);

test.each(["ready", "failed"] as const)(
	"stored %s is terminal until an explicit retry",
	async (status) => {
		const fetch = vi
			.spyOn(globalThis, "fetch")
			.mockImplementation(async () => response(ready));
		const state = model({
			asset: { id: "a", kind: "pdf", extract: { status } },
		});
		await state.start();
		expect(state.getSnapshot()).toBe(status);
		expect(fetch).not.toHaveBeenCalled();
		await state.retry();
		expect(fetch).toHaveBeenCalledTimes(1);
		expect(state.getSnapshot()).toBe("ready");
	},
);

test("new documents stream progress, share an in-flight retry, and publish metadata once", async () => {
	const pendingResponse = delivery();
	const fetch = vi
		.spyOn(globalThis, "fetch")
		.mockReturnValue(pendingResponse.promise);
	const extracted = vi.fn(),
		progress = vi.fn(),
		changed = vi.fn();
	const state = model({
		asset: { id: "a", kind: "pdf" },
		onExtracted: extracted,
		onProgress: progress,
	});
	const unsubscribe = state.subscribe(changed);
	const pending = state.start();
	expect(state.getSnapshot()).toBe("extracting");
	expect(state.retry()).toBe(pending);
	pendingResponse.resolve(response(ready, true));
	await pending;
	expect(fetch).toHaveBeenCalledTimes(1);
	expect(fetch).toHaveBeenCalledWith(
		"/api/media/a/extract",
		expect.objectContaining({
			method: "POST",
			signal: expect.any(AbortSignal),
		}),
	);
	expect(state.getSnapshot()).toBe("ready");
	expect(extracted.mock.calls).toEqual([[ready]]);
	expect(progress.mock.calls).toEqual([[12]]);
	expect(changed).toHaveBeenCalledTimes(2);
	unsubscribe();
});

test("an existing job polls after four seconds and stops at its terminal result", async () => {
	const fetch = vi
		.spyOn(globalThis, "fetch")
		.mockImplementationOnce(async () => response(extracting))
		.mockImplementationOnce(async () => response(ready));
	const extracted = vi.fn();
	const state = model({
		asset: { id: "a", kind: "pdf", extract: { status: "extracting" } },
		onExtracted: extracted,
	});
	await state.start();
	await vi.advanceTimersByTimeAsync(3999);
	expect(fetch).not.toHaveBeenCalled();
	await vi.advanceTimersByTimeAsync(1);
	expect(fetch).toHaveBeenCalledTimes(1);
	expect(extracted).not.toHaveBeenCalled();
	await vi.advanceTimersByTimeAsync(4000);
	expect(extracted.mock.calls).toEqual([[ready]]);
	expect(vi.getTimerCount()).toBe(0);
});

test("the poll budget ends in a retryable failure and explicit retry resets it", async () => {
	const fetch = vi
		.spyOn(globalThis, "fetch")
		.mockImplementation(async () => response(extracting));
	const extracted = vi.fn();
	const state = model({
		asset: { id: "a", kind: "pdf" },
		onExtracted: extracted,
	});
	await state.start();
	await vi.advanceTimersByTimeAsync(75 * 4000);
	expect(fetch).toHaveBeenCalledTimes(76);
	expect(state.getSnapshot()).toBe("failed");
	expect(extracted).toHaveBeenCalledWith(
		expect.objectContaining({ status: "failed" }),
	);
	expect(vi.getTimerCount()).toBe(0);
	fetch.mockImplementation(async () => response(ready));
	await state.retry();
	expect(state.getSnapshot()).toBe("ready");
});

test("a retired asset's late response cannot update its replacement", async () => {
	const pendingResponse = delivery();
	const fetch = vi
		.spyOn(globalThis, "fetch")
		.mockReturnValueOnce(pendingResponse.promise)
		.mockImplementationOnce(async () => response(failed));
	const extracted = vi.fn();
	const first = model({
		asset: { id: "a", kind: "pdf" },
		onExtracted: extracted,
	});
	const pending = first.start();
	const signal = fetch.mock.calls[0][1]?.signal;
	first.stop();
	expect(signal?.aborted).toBe(true);
	const second = model({
		asset: { id: "b", kind: "pdf" },
		onExtracted: extracted,
	});
	await second.start();
	pendingResponse.resolve(response(ready));
	await pending;
	expect(fetch.mock.calls.map(([url]) => url)).toEqual([
		"/api/media/a/extract",
		"/api/media/b/extract",
	]);
	expect(second.getSnapshot()).toBe("failed");
	expect(extracted.mock.calls).toEqual([[failed]]);
});

test("a restarted local observer ignores its cancelled predecessor", async () => {
	const pendingResponse = delivery();
	vi.spyOn(globalThis, "fetch")
		.mockReturnValueOnce(pendingResponse.promise)
		.mockImplementationOnce(async () => response(failed));
	const extracted = vi.fn();
	const state = model({
		asset: { id: "a", kind: "pdf" },
		onExtracted: extracted,
	});
	const old = state.start();
	state.stop();
	await state.start();
	await vi.advanceTimersByTimeAsync(4000);
	pendingResponse.resolve(response(ready));
	await old;
	expect(state.getSnapshot()).toBe("failed");
	expect(extracted.mock.calls).toEqual([[failed]]);
});

test("a build owns its request beyond unmount, while terminal observation stops", async () => {
	const pendingResponse = delivery();
	const fetch = vi
		.spyOn(globalThis, "fetch")
		.mockReturnValue(pendingResponse.promise);
	const build = new AbortController();
	const extracted = vi.fn(),
		progress = vi.fn();
	const state = model({
		asset: { id: "a", kind: "pdf" },
		signal: build.signal,
		onExtracted: extracted,
		onProgress: progress,
	});
	const pending = state.start();
	state.stop();
	expect(build.signal.aborted).toBe(false);
	expect(fetch.mock.calls[0][1]?.signal).toBe(build.signal);
	pendingResponse.resolve(response(ready, true));
	await pending;
	expect(progress.mock.calls).toEqual([[12]]);
	expect(extracted).not.toHaveBeenCalled();
});

test("aborting the build stops queued polls and refuses retry", async () => {
	const fetch = vi
		.spyOn(globalThis, "fetch")
		.mockImplementation(async () => response(extracting));
	const build = new AbortController();
	const state = model({
		asset: { id: "a", kind: "pdf" },
		signal: build.signal,
	});
	await state.start();
	expect(vi.getTimerCount()).toBe(1);
	build.abort();
	await state.retry();
	await vi.advanceTimersByTimeAsync(8000);
	expect(fetch).toHaveBeenCalledTimes(1);
	expect(vi.getTimerCount()).toBe(0);
});
