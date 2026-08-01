/**
 * State-model coverage for the pure media-client helpers (per the
 * project's "test the state model, not the DOM" rule). The fetch
 * helpers + React hooks are I/O and are covered by typecheck + the
 * browser-level pass; the pure slot transforms + hashing are tested
 * here.
 *
 * Hashing is tested through `sha256HexOfBytes` (the pure buffer→hex
 * core), NOT `sha256Hex(Blob)`: `Blob.arrayBuffer()` registers a
 * BLOBREADER async resource that lingers past test-end under the leak
 * detector, and the blob read is I/O: the byte→hash transformation is
 * the part worth unit-testing.
 */

import { describe, expect, it, vi } from "vitest";
import { testMediaAssetId } from "@/__tests__/helpers/uuid";
import type { Media } from "@/lib/domain/multimedia";
import {
	clearMediaSlot,
	fetchAssetExtract,
	fetchAssetExtractMeta,
	fetchMediaLibrary,
	mediaSrc,
	setMediaSlot,
	sha256HexOfBytes,
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
		const value: Media = { image, audio };
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
			clearMediaSlot({ image: testMediaAssetId("img-1"), audio }, "image"),
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

describe("fetchMediaLibrary", () => {
	it("sends the trimmed authoritative search with the pagination scope", async () => {
		const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(JSON.stringify({ assets: [], nextCursor: null }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			}),
		);
		try {
			await fetchMediaLibrary({
				kinds: ["image"],
				cursor: "next-page",
				query: " client plan ",
				appId: "app-1",
			});
			expect(fetchMock).toHaveBeenCalledWith(
				"/api/media/library?kind=image&cursor=next-page&q=client+plan&appId=app-1",
				{ cache: "no-store", signal: undefined },
			);
		} finally {
			fetchMock.mockRestore();
		}
	});
});

describe("Project-scoped extract reads", () => {
	it("forces both extract body and metadata reads past browser caches", async () => {
		const fetchMock = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(new Response("Document summary"))
			.mockResolvedValueOnce(
				Response.json({ title: "Protocol", summary: "Summary" }),
			);
		try {
			const assetId = testMediaAssetId("asset-1");
			await fetchAssetExtract(assetId);
			await fetchAssetExtractMeta(assetId);
			expect(fetchMock).toHaveBeenNthCalledWith(
				1,
				`/api/media/${assetId}/extract`,
				{ cache: "no-store", signal: undefined },
			);
			expect(fetchMock).toHaveBeenNthCalledWith(
				2,
				`/api/media/${assetId}/extract?meta=1`,
				{ cache: "no-store", signal: undefined },
			);
		} finally {
			fetchMock.mockRestore();
		}
	});
});

describe("sha256HexOfBytes", () => {
	it("computes the lowercase-hex SHA-256 of the bytes", async () => {
		// Known vector: sha256("abc").
		const bytes = new TextEncoder().encode("abc");
		expect(await sha256HexOfBytes(bytes)).toBe(
			"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
		);
	});

	it("is deterministic", async () => {
		const bytes = new Uint8Array([1, 2, 3, 4]);
		expect(await sha256HexOfBytes(bytes)).toBe(await sha256HexOfBytes(bytes));
	});
});
