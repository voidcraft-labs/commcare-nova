/**
 * Behavioral tests for `list_media_assets`.
 *
 * The tool delegates to `listReadyAssetsForOwner` (mocked) and projects
 * each row through `toWireMediaAsset`. Coverage:
 *   1. Returns the projected wire assets + nextCursor.
 *   2. Threads the owner from ctx.userId and the optional kind/cursor.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MediaAssetRecord } from "@/lib/db/mediaAssets";
import { listMediaAssetsTool } from "../listMediaAssets";
import { makeMediaFixture } from "./fixtures";

// `vi.hoisted` lifts the mock fn above the hoisted `vi.mock` factory so the
// factory can close over it without tripping the "cannot access before
// initialization" hoist error.
const { listReadyAssetsForOwner } = vi.hoisted(() => ({
	listReadyAssetsForOwner: vi.fn(),
}));

vi.mock("@/lib/db/mediaAssets", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/lib/db/mediaAssets")>();
	return {
		...actual,
		listReadyAssetsForOwner,
	};
});

beforeEach(() => {
	vi.clearAllMocks();
});

/** A minimal `ready` asset record for the mock to return. */
function readyRecord(id: string): MediaAssetRecord {
	return {
		id,
		owner: "user-1",
		contentHash: "abc",
		mimeType: "image/png",
		kind: "image",
		extension: ".png",
		sizeBytes: 100,
		originalFilename: `${id}.png`,
		displayName: `${id}.png`,
		status: "ready",
		gcsObjectKey: `users/user-1/abc.png`,
		// `created_at` is a Firestore Timestamp at runtime; the wire
		// projector calls `.toDate().toISOString()` on it.
		created_at: {
			toDate: () => new Date("2026-01-01T00:00:00Z"),
		} as unknown as MediaAssetRecord["created_at"],
	} as MediaAssetRecord;
}

describe("listMediaAssets", () => {
	it("returns projected wire assets and the next cursor", async () => {
		const { doc, ctx } = makeMediaFixture();
		listReadyAssetsForOwner.mockResolvedValue({
			assets: [readyRecord("a1"), readyRecord("a2")],
			nextCursor: "cursor-2",
		});

		const result = await listMediaAssetsTool.execute({}, ctx, doc);

		expect(result.kind).toBe("read");
		expect(result.data.assets).toHaveLength(2);
		expect(result.data.assets[0].id).toBe("a1");
		// Wire shape drops `owner` + `gcsObjectKey`.
		expect(result.data.assets[0]).not.toHaveProperty("owner");
		expect(result.data.assets[0]).not.toHaveProperty("gcsObjectKey");
		expect(result.data.nextCursor).toBe("cursor-2");
	});

	it("passes the owner and the kind/cursor filters through", async () => {
		const { doc, ctx } = makeMediaFixture();
		listReadyAssetsForOwner.mockResolvedValue({ assets: [], nextCursor: null });

		await listMediaAssetsTool.execute(
			{ kind: "audio", cursor: "page-1" },
			ctx,
			doc,
		);

		expect(listReadyAssetsForOwner).toHaveBeenCalledWith("user-1", {
			kind: "audio",
			cursor: "page-1",
		});
	});

	it("omits kind/cursor when not supplied", async () => {
		const { doc, ctx } = makeMediaFixture();
		listReadyAssetsForOwner.mockResolvedValue({ assets: [], nextCursor: null });

		await listMediaAssetsTool.execute({}, ctx, doc);

		expect(listReadyAssetsForOwner).toHaveBeenCalledWith("user-1", {});
	});
});
