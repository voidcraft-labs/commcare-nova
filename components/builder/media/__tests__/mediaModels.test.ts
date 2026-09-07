import { afterEach, expect, it, vi } from "vitest";
import { testMediaAssetId } from "@/__tests__/helpers/uuid";
import type { MediaAssetView } from "../mediaClient";
import { createMediaLibrary } from "../mediaLibrary";
import { createMediaUpload } from "../mediaUpload";

function image(id: string): MediaAssetView {
	return {
		id: testMediaAssetId(id),
		contentHash: "a".repeat(64),
		mimeType: "image/png",
		kind: "image",
		extension: ".png",
		sizeBytes: 3,
		originalFilename: `${id}.png`,
		status: "ready",
		createdAt: "2026-09-05T00:00:00Z",
	};
}
const file = new File(["abc"], "photo.png", { type: "image/png" });
const models: { stop: () => void }[] = [];
const tasks: Promise<unknown>[] = [];
const pending: ReturnType<typeof Promise.withResolvers<Response>>[] = [];
function own<T>(promise: Promise<T>): Promise<T> {
	tasks.push(promise);
	return promise;
}
function deferred() {
	const gate = Promise.withResolvers<Response>();
	pending.push(gate);
	return gate;
}
function library(
	options: Partial<Parameters<typeof createMediaLibrary>[0]> = {},
) {
	const model = createMediaLibrary({ authorized: true, ...options });
	models.push(model);
	return model;
}
function uploader(canWrite = () => true, appId = "app-a") {
	const model = createMediaUpload({ appId, canWrite });
	models.push(model);
	model.start();
	return model;
}
afterEach(async () => {
	try {
		for (const model of models) model.stop();
		for (const gate of pending)
			gate.resolve(
				Response.json({
					assets: [],
					nextCursor: null,
					deduplicated: true,
					asset: image("cleanup"),
				}),
			);
		const settled = await Promise.allSettled(tasks);
		expect(settled.every((result) => result.status === "fulfilled")).toBe(true);
	} finally {
		models.length = 0;
		tasks.length = 0;
		pending.length = 0;
		vi.restoreAllMocks();
	}
});

it("retries the failed first page and subsequent page without dropping rows or changing the server search", async () => {
	const first = image("first"),
		second = image("second");
	const fetcher = vi
		.spyOn(globalThis, "fetch")
		.mockResolvedValueOnce(
			Response.json({ error: "Library unavailable" }, { status: 403 }),
		)
		.mockResolvedValueOnce(
			Response.json({ assets: [first], nextCursor: "older&match" }),
		)
		.mockResolvedValueOnce(
			Response.json({ error: "Next page unavailable" }, { status: 403 }),
		)
		.mockResolvedValueOnce(
			Response.json({ assets: [second], nextCursor: null }),
		);
	const model = library({
		kinds: ["image"],
		query: " client plan ",
		appId: "app-a",
	});
	const notifications = vi.fn();
	const unsubscribe = model.subscribe(notifications);
	await own(model.start());
	expect(model.getSnapshot()).toEqual({
		assets: [],
		isLoading: false,
		error: "Library unavailable",
		hasMore: false,
	});
	await own(model.retry());
	expect(model.getSnapshot()).toEqual({
		assets: [first],
		isLoading: false,
		error: null,
		hasMore: true,
	});
	await own(model.loadMore());
	expect(model.getSnapshot()).toEqual({
		assets: [first],
		isLoading: false,
		error: "Next page unavailable",
		hasMore: true,
	});
	await own(model.retry());
	expect(model.getSnapshot()).toEqual({
		assets: [first, second],
		isLoading: false,
		error: null,
		hasMore: false,
	});
	await own(model.loadMore());
	expect(fetcher).toHaveBeenCalledTimes(4);
	const queries = fetcher.mock.calls.map(
		([url]) => new URL(String(url), "https://nova.example").searchParams,
	);
	for (const query of queries) {
		expect(query.get("q")).toBe("client plan");
		expect(query.get("kind")).toBe("image");
		expect(query.get("appId")).toBe("app-a");
	}
	expect(queries.map((query) => query.get("cursor"))).toEqual([
		null,
		null,
		"older&match",
		"older&match",
	]);
	expect(notifications).toHaveBeenCalled();
	unsubscribe();
	notifications.mockClear();
	model.addUploaded(image("third"));
	expect(notifications).not.toHaveBeenCalled();
});

it("coalesces concurrent page requests and fences a stopped request even after the same model restarts", async () => {
	const old = deferred(),
		current = deferred();
	const fetcher = vi
		.spyOn(globalThis, "fetch")
		.mockReturnValueOnce(old.promise)
		.mockReturnValueOnce(current.promise);
	const model = library();
	const previous = own(model.start());
	expect(model.retry()).toBe(previous);
	expect(model.loadMore()).toBe(previous);
	const signal = fetcher.mock.calls[0][1]?.signal;
	model.stop();
	expect(signal?.aborted).toBe(true);
	const restarted = own(model.start());
	current.resolve(
		Response.json({ assets: [image("current")], nextCursor: null }),
	);
	await restarted;
	old.resolve(
		Response.json({ assets: [image("retired")], nextCursor: "stale" }),
	);
	await previous;
	expect(model.getSnapshot()).toEqual({
		assets: [image("current")],
		isLoading: false,
		error: null,
		hasMore: false,
	});
	expect(fetcher).toHaveBeenCalledTimes(2);
});

it("applies local additions, deletion and metadata to snapshots without mutating previous snapshots; stopped callbacks do nothing", async () => {
	const a = image("a"),
		b = image("b");
	vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
		Response.json({ assets: [a], nextCursor: null }),
	);
	const model = library();
	await own(model.start());
	const original = model.getSnapshot();
	model.addUploaded(b);
	model.addUploaded(b);
	model.updateAsset(a.id, { displayName: "Renamed" });
	model.removeAsset(b.id);
	expect(model.getSnapshot().assets).toEqual([
		{ ...a, displayName: "Renamed" },
	]);
	expect(original.assets).toEqual([a]);
	model.stop();
	const retired = model.getSnapshot();
	model.addUploaded(b);
	model.updateAsset(a.id, { displayName: "stale" });
	model.removeAsset(a.id);
	await own(model.loadMore());
	await own(model.retry());
	expect(model.getSnapshot()).toBe(retired);
});

it("starts a replacement search empty and prevents retired results from entering it", async () => {
	const old = deferred();
	const fetcher = vi
		.spyOn(globalThis, "fetch")
		.mockReturnValueOnce(old.promise)
		.mockResolvedValueOnce(
			Response.json({ assets: [image("older-match")], nextCursor: null }),
		);
	const previous = library({ query: "", appId: "app-a" });
	const request = own(previous.start());
	previous.stop();
	const current = library({ query: "client", appId: "app-b" });
	expect(current.getSnapshot().assets).toEqual([]);
	await own(current.start());
	old.resolve(Response.json({ assets: [image("foreign")], nextCursor: null }));
	await request;
	expect(current.getSnapshot().assets).toEqual([image("older-match")]);
	expect(fetcher.mock.calls[0][1]?.signal?.aborted).toBe(true);
	expect(String(fetcher.mock.calls[1][0])).toContain("q=client&appId=app-b");
});

it("unauthorized library scopes and viewer uploads never make requests", async () => {
	const fetcher = vi.spyOn(globalThis, "fetch");
	const model = library({ authorized: false });
	await own(model.start());
	await own(model.retry());
	expect(model.getSnapshot()).toEqual({
		assets: [],
		isLoading: false,
		error: null,
		hasMore: false,
	});
	expect(await own(uploader(() => false).upload(file))).toBeNull();
	expect(fetcher).not.toHaveBeenCalled();
});

it("publishes upload refusal, then allows a new upload and returns its confirmed row", async () => {
	const fetcher = vi
		.spyOn(globalThis, "fetch")
		.mockResolvedValueOnce(
			Response.json({ error: "This file is too large" }, { status: 413 }),
		)
		.mockResolvedValueOnce(
			Response.json({ deduplicated: true, asset: image("ready") }),
		);
	const model = uploader();
	const failed = own(model.upload(file));
	expect(model.getSnapshot()).toEqual({ state: "uploading" });
	expect(await failed).toBeNull();
	expect(model.getSnapshot()).toEqual({
		state: "error",
		message: "This file is too large",
	});
	expect(await own(model.upload(file))).toEqual(image("ready"));
	expect(model.getSnapshot()).toEqual({ state: "idle" });
	for (const [, init] of fetcher.mock.calls)
		expect(JSON.parse(String(init?.body)).appId).toBe("app-a");
});

it("a replacement upload aborts its predecessor and alone owns status and return value", async () => {
	const old = deferred();
	const reached = Promise.withResolvers<void>();
	const fetcher = vi
		.spyOn(globalThis, "fetch")
		.mockImplementationOnce(() => {
			reached.resolve();
			return old.promise;
		})
		.mockResolvedValueOnce(
			Response.json({ deduplicated: true, asset: image("new") }),
		);
	const model = uploader();
	const first = own(model.upload(file));
	await reached.promise;
	const second = own(model.upload(file));
	expect(fetcher.mock.calls[0][1]?.signal?.aborted).toBe(true);
	expect(await second).toEqual(image("new"));
	old.resolve(Response.json({ deduplicated: true, asset: image("old") }));
	expect(await first).toBeNull();
	expect(model.getSnapshot()).toEqual({ state: "idle" });
});

it.each(["stop", "permission"] as const)(
	"rechecks %s before delivering a late upload, resets its status, and rejects further writes",
	async (reason) => {
		const gate = deferred();
		const reached = Promise.withResolvers<void>();
		let writable = true;
		const fetcher = vi.spyOn(globalThis, "fetch").mockImplementationOnce(() => {
			reached.resolve();
			return gate.promise;
		});
		const model = uploader(() => writable);
		const upload = own(model.upload(file));
		await reached.promise;
		if (reason === "stop") {
			model.stop();
			expect(fetcher.mock.calls[0][1]?.signal?.aborted).toBe(true);
		} else writable = false;
		gate.resolve(Response.json({ deduplicated: true, asset: image("late") }));
		expect(await upload).toBeNull();
		expect(model.getSnapshot()).toEqual({ state: "idle" });
		expect(await own(model.upload(file))).toBeNull();
		expect(fetcher).toHaveBeenCalledTimes(1);
	},
);
