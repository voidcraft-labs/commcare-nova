import { afterEach, describe, expect, it, vi } from "vitest";
import { testMediaAssetId } from "@/__tests__/helpers/uuid";
import type { Media } from "@/lib/domain/multimedia";
import {
	clearMediaSlot,
	deleteMediaAsset,
	fetchAssetExtract,
	fetchAssetExtractMeta,
	fetchAssetsByIds,
	fetchMediaLibrary,
	mediaSrc,
	setMediaSlot,
	sha256Hex,
	uploadMediaAsset,
} from "../mediaClient";

describe("setMediaSlot", () => {
	it("sets a kind on an empty bundle", () => {
		const asset = testMediaAssetId("asset-1");
		expect(setMediaSlot(undefined, "image", asset)).toEqual({
			image: asset,
		});
	});

	it("preserves the other slots", () => {
		const image = testMediaAssetId("img-1");
		const audio = testMediaAssetId("aud-1");
		const video = testMediaAssetId("vid-1");
		const value: Media = Object.freeze({ image, audio });
		expect(setMediaSlot(value, "video", video)).toEqual({
			image,
			audio,
			video,
		});
	});

	it("replaces an existing slot of the same kind", () => {
		const oldAsset = testMediaAssetId("old");
		const newAsset = testMediaAssetId("new");
		expect(setMediaSlot({ image: oldAsset }, "image", newAsset)).toEqual({
			image: newAsset,
		});
	});
});

describe("clearMediaSlot", () => {
	it("returns undefined when clearing the only slot (bundle drops, not {})", () => {
		expect(
			clearMediaSlot({ image: testMediaAssetId("img-1") }, "image"),
		).toBeUndefined();
	});

	it("keeps the remaining slots when clearing one of several", () => {
		const audio = testMediaAssetId("aud-1");
		expect(
			clearMediaSlot(
				Object.freeze({ image: testMediaAssetId("img-1"), audio }),
				"image",
			),
		).toEqual({ audio });
	});

	it("is a no-op (undefined) on an absent bundle", () => {
		expect(clearMediaSlot(undefined, "image")).toBeUndefined();
	});

	it("clearing an absent kind leaves the other slots intact", () => {
		const audio = testMediaAssetId("aud-1");
		expect(clearMediaSlot({ audio }, "image")).toEqual({
			audio,
		});
	});
});

describe("mediaSrc", () => {
	it("points at the session-authed proxy route", () => {
		const assetId = testMediaAssetId("asset-xyz");
		expect(mediaSrc(assetId)).toBe(`/api/media/${assetId}`);
	});
});

const asset = {
	id: testMediaAssetId("uploaded"),
	contentHash: "a".repeat(64),
	mimeType: "image/png",
	kind: "image" as const,
	extension: ".png",
	sizeBytes: 3,
	originalFilename: "photo.png",
	status: "ready" as const,
	createdAt: "2026-09-05T00:00:00Z",
};
const abcHash =
	"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
afterEach(() => vi.restoreAllMocks());

describe("native file hashing", () => {
	it("reads the Blob's exact byte range, including empty files", async () => {
		const padded = new Uint8Array([0, 97, 98, 99, 255]);
		expect(await sha256Hex(new Blob([padded.subarray(1, 4)]))).toBe(abcHash);
		expect(await sha256Hex(new File(["abc"], "photo.png"))).toBe(abcHash);
		expect(await sha256Hex(new Blob([]))).toBe(
			"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
		);
	});
});

describe("upload protocol through fetch", () => {
	const file = new File(["abc"], "notes.md", {
		type: "application/octet-stream",
	});
	const initiate = {
		assetId: asset.id,
		deduplicated: false,
		uploadUrl: "https://storage.example/signed",
		uploadContentType: "text/markdown",
		uploadHeaders: { "x-goog-content-length-range": "0,1048576" },
	};
	it("hashes, initiates, sends exact signed headers and bytes, then confirms before returning the ready asset", async () => {
		const gate = Promise.withResolvers<Response>();
		const reachedConfirm = Promise.withResolvers<void>();
		const controller = new AbortController();
		const fetcher = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(Response.json(initiate))
			.mockResolvedValueOnce(new Response(null, { status: 200 }))
			.mockImplementationOnce(() => {
				reachedConfirm.resolve();
				return gate.promise;
			});
		const upload = uploadMediaAsset(file, {
			appId: "app-1",
			signal: controller.signal,
		});
		let settled = false;
		const observed = upload.then((value) => {
			settled = true;
			return value;
		});
		try {
			await reachedConfirm.promise;
			expect(settled).toBe(false);
			expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
				"/api/media/upload",
				initiate.uploadUrl,
				`/api/media/upload/${asset.id}/confirm`,
			]);
			expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body))).toEqual({
				filename: "notes.md",
				mimeType: "text/markdown",
				sizeBytes: 3,
				contentHash: abcHash,
				appId: "app-1",
			});
			const put = fetcher.mock.calls[1][1];
			expect(put).toEqual({
				method: "PUT",
				headers: {
					"Content-Type": "text/markdown",
					"x-goog-content-length-range": "0,1048576",
				},
				body: file,
				signal: controller.signal,
			});
			expect(fetcher.mock.calls[2][1]).toEqual({
				method: "POST",
				signal: controller.signal,
			});
		} finally {
			gate.resolve(Response.json({ ok: true, asset }));
			await observed;
		}
		expect(await upload).toEqual(asset);
	});
	it("returns a deduplicated row with no storage transfer, confirmation, or progress", async () => {
		const fetcher = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(Response.json({ deduplicated: true, asset }));
		const progress = vi.fn();
		expect(await uploadMediaAsset(file, { onProgress: progress })).toEqual(
			asset,
		);
		expect(fetcher).toHaveBeenCalledTimes(1);
		expect(
			JSON.parse(String(fetcher.mock.calls[0][1]?.body)),
		).not.toHaveProperty("appId");
		expect(progress).not.toHaveBeenCalled();
	});
	it.each([
		[{ deduplicated: true }, "already in your library"],
		[{ ...initiate, uploadUrl: undefined }, "prepare the upload"],
		[{ ...initiate, uploadContentType: undefined }, "prepare the upload"],
	])(
		"refuses an incomplete initiate response before sending bytes: %j",
		async (body, message) => {
			const fetcher = vi
				.spyOn(globalThis, "fetch")
				.mockResolvedValueOnce(Response.json(body));
			await expect(uploadMediaAsset(file)).rejects.toThrow(message);
			expect(fetcher).toHaveBeenCalledTimes(1);
		},
	);
	it.each([0, 1, 2])(
		"stops at a refusal in protocol step %i",
		async (stage) => {
			const responses = [
				Response.json(initiate),
				new Response(),
				Response.json({ ok: true, asset }),
			];
			responses[stage] = Response.json(
				{ error: "This Project cannot accept this file." },
				{ status: 403 },
			);
			const fetcher = vi
				.spyOn(globalThis, "fetch")
				.mockImplementation(async () => {
					const next = responses.shift();
					if (!next) throw new Error("Unexpected extra upload request");
					return next;
				});
			await expect(uploadMediaAsset(file)).rejects.toThrow(
				stage === 1
					? "upload didn't finish"
					: "This Project cannot accept this file.",
			);
			expect(fetcher).toHaveBeenCalledTimes(stage + 1);
		},
	);
	it("aborts before initiating and propagates a transport abort without confirming", async () => {
		const controller = new AbortController();
		controller.abort();
		const fetcher = vi.spyOn(globalThis, "fetch");
		await expect(
			uploadMediaAsset(file, { signal: controller.signal }),
		).rejects.toMatchObject({ name: "AbortError" });
		expect(fetcher).not.toHaveBeenCalled();
		fetcher
			.mockResolvedValueOnce(Response.json(initiate))
			.mockRejectedValueOnce(new DOMException("Canceled", "AbortError"));
		await expect(uploadMediaAsset(file)).rejects.toMatchObject({
			name: "AbortError",
		});
		expect(fetcher).toHaveBeenCalledTimes(2);
	});
});

describe("library and extract requests", () => {
	it("returns the authoritative page and encodes all kinds, search, cursor and app scope", async () => {
		const page = { assets: [asset], nextCursor: "older&next" };
		const fetcher = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(Response.json(page));
		const signal = new AbortController().signal;
		expect(
			await fetchMediaLibrary({
				kinds: ["image", "pdf"],
				cursor: "older&next",
				query: " client plan ",
				appId: "app/1",
				signal,
			}),
		).toEqual(page);
		expect(fetcher).toHaveBeenCalledWith(
			"/api/media/library?kind=image&kind=pdf&cursor=older%26next&q=client+plan&appId=app%2F1",
			{ cache: "no-store", signal },
		);
	});
	it("resolves unique ids in bounded requests, retains scope on every page, and allows missing rows", async () => {
		const ids = Array.from({ length: 103 }, (_, i) =>
			testMediaAssetId(`row-${i}`),
		);
		const fetcher = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(
				Response.json({ assets: [asset], nextCursor: null }),
			)
			.mockResolvedValueOnce(Response.json({ assets: [], nextCursor: null }))
			.mockResolvedValueOnce(
				Response.json({
					assets: [{ ...asset, id: ids[102] }],
					nextCursor: null,
				}),
			);
		const signal = new AbortController().signal;
		expect(
			await fetchAssetsByIds([ids[0], ...ids, ids[102]], "app/1", signal),
		).toEqual([asset, { ...asset, id: ids[102] }]);
		const pages = fetcher.mock.calls.map(([url, init]) => {
			expect(init).toEqual({ cache: "no-store", signal });
			const parsed = new URL(String(url), "https://nova.example");
			expect(parsed.pathname).toBe("/api/media/library");
			expect(parsed.searchParams.get("appId")).toBe("app/1");
			return parsed.searchParams.getAll("id");
		});
		expect(pages.map((p) => p.length)).toEqual([50, 50, 3]);
		expect(pages.flat()).toEqual(ids);
	});
	it("does no empty lookup and cancels between chunks", async () => {
		const controller = new AbortController();
		const fetcher = vi
			.spyOn(globalThis, "fetch")
			.mockImplementationOnce(async () => {
				controller.abort();
				return Response.json({ assets: [asset], nextCursor: null });
			});
		expect(await fetchAssetsByIds([])).toEqual([]);
		expect(fetcher).not.toHaveBeenCalled();
		await expect(
			fetchAssetsByIds(
				Array.from({ length: 51 }, (_, i) => String(i)),
				undefined,
				controller.signal,
			),
		).rejects.toMatchObject({ name: "AbortError" });
		expect(fetcher).toHaveBeenCalledTimes(1);
	});
	it("returns uncached extract text and only the preview metadata", async () => {
		const signal = new AbortController().signal;
		const fetcher = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(new Response("Document summary"))
			.mockResolvedValueOnce(
				Response.json({
					title: "Protocol",
					summary: "Summary",
					ignored: "body",
				}),
			);
		expect(await fetchAssetExtract(asset.id, signal)).toBe("Document summary");
		expect(await fetchAssetExtractMeta(asset.id, signal)).toEqual({
			title: "Protocol",
			summary: "Summary",
		});
		expect(fetcher.mock.calls).toEqual([
			[`/api/media/${asset.id}/extract`, { cache: "no-store", signal }],
			[`/api/media/${asset.id}/extract?meta=1`, { cache: "no-store", signal }],
		]);
	});
	it("treats absent extracts and unreadable metadata as unavailable", async () => {
		vi.spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(new Response(null, { status: 404 }))
			.mockResolvedValueOnce(new Response(null, { status: 403 }))
			.mockResolvedValueOnce(new Response("invalid json"))
			.mockRejectedValueOnce(new DOMException("Canceled", "AbortError"));
		expect(await fetchAssetExtract(asset.id)).toBeNull();
		expect(await fetchAssetExtractMeta(asset.id)).toBeNull();
		expect(await fetchAssetExtractMeta(asset.id)).toBeNull();
		expect(await fetchAssetExtractMeta(asset.id)).toBeNull();
	});
	it("deletes with the caller's signal and accepts the empty 204 response", async () => {
		const signal = new AbortController().signal;
		const fetcher = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(new Response(null, { status: 204 }));
		await expect(deleteMediaAsset(asset.id, signal)).resolves.toBeUndefined();
		expect(fetcher).toHaveBeenCalledWith(`/api/media/${asset.id}`, {
			method: "DELETE",
			signal,
		});
	});
	it.each([
		[() => fetchMediaLibrary(), "Couldn't load your media library."],
		[
			() => fetchAssetsByIds([asset.id]),
			"Couldn't look up the attached files' details.",
		],
		[
			() => fetchAssetExtract(asset.id),
			"Couldn't load what Nova reads from this document.",
		],
		[() => deleteMediaAsset(asset.id), "Couldn't delete this file. Try again."],
	])(
		"preserves server refusals and falls back for non-JSON failures: %s",
		async (request, fallback) => {
			const fetcher = vi
				.spyOn(globalThis, "fetch")
				.mockResolvedValueOnce(
					Response.json({ error: "Used by Household visit" }, { status: 409 }),
				)
				.mockResolvedValueOnce(
					new Response("upstream unavailable", { status: 502 }),
				);
			await expect(request()).rejects.toThrow("Used by Household visit");
			await expect(request()).rejects.toThrow(fallback);
			expect(fetcher).toHaveBeenCalledTimes(2);
		},
	);
});
