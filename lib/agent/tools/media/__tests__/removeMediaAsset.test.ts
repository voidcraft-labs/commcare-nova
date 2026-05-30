/**
 * Behavioral tests for `remove_media_asset`.
 *
 * Coverage:
 *   1. Deletes the Firestore row and unshared GCS object when no live reference
 *      exists.
 *   2. Refuses (and deletes nothing) when the current doc still
 *      references the asset, naming the carrier.
 *   3. Refuses when another live app references the asset.
 *   4. Maps a missing/foreign-owned asset to a "not found" message.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ListAppsResult } from "@/lib/db/apps";
import type { MediaAssetRecord } from "@/lib/db/mediaAssets";
import { MediaAssetOwnershipError } from "@/lib/db/mediaAssets";
import type { BlueprintDoc } from "@/lib/domain";
import { asAssetId } from "@/lib/domain";
import { removeMediaAssetTool } from "../removeMediaAsset";
import { makeMediaFixture, TEXT_FIELD } from "./fixtures";

// `vi.hoisted` lifts the mock fns above the hoisted `vi.mock` factories so
// the factories can close over them without a "cannot access before
// initialization" hoist error.
const {
	loadAssetForOwner,
	deleteAssetRow,
	hasOtherAssetForGcsObjectKey,
	deleteGcsObject,
	listApps,
	loadApp,
} = vi.hoisted(() => ({
	loadAssetForOwner: vi.fn(),
	deleteAssetRow: vi.fn(() => Promise.resolve()),
	hasOtherAssetForGcsObjectKey: vi.fn(() => Promise.resolve(false)),
	deleteGcsObject: vi.fn(() => Promise.resolve()),
	listApps: vi.fn<() => Promise<ListAppsResult>>(() =>
		Promise.resolve({ apps: [] }),
	),
	loadApp: vi.fn(),
}));

vi.mock("@/lib/db/mediaAssets", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/lib/db/mediaAssets")>();
	return {
		...actual,
		loadAssetForOwner,
		deleteAsset: deleteAssetRow,
		hasOtherAssetForGcsObjectKey,
	};
});
vi.mock("@/lib/db/apps", () => ({
	listApps,
	loadApp,
}));
vi.mock("@/lib/storage/media", () => ({
	deleteAsset: deleteGcsObject,
}));

beforeEach(() => {
	vi.clearAllMocks();
	hasOtherAssetForGcsObjectKey.mockResolvedValue(false);
	listApps.mockResolvedValue({ apps: [] });
});

/** Minimal owned asset row for the load mock. */
function ownedAsset(id: string): MediaAssetRecord {
	return {
		id,
		owner: "user-1",
		gcsObjectKey: `users/user-1/${id}.png`,
		originalFilename: `${id}.png`,
		contentHash: "abc",
		mimeType: "image/png",
		kind: "image",
		extension: ".png",
		sizeBytes: 100,
		status: "ready",
	} as unknown as MediaAssetRecord;
}

/** Attach an asset to the text field's label_media so the doc references it. */
function docReferencing(assetId: string, base: BlueprintDoc): BlueprintDoc {
	const field = base.fields[TEXT_FIELD];
	return {
		...base,
		fields: {
			...base.fields,
			[TEXT_FIELD]: { ...field, label_media: { image: assetId } } as never,
		},
	};
}

describe("removeMediaAsset", () => {
	it("deletes the GCS object and the row when unreferenced", async () => {
		const { doc, ctx } = makeMediaFixture();
		loadAssetForOwner.mockResolvedValue(ownedAsset("free-asset"));

		const result = await removeMediaAssetTool.execute(
			{ assetId: "free-asset" },
			ctx,
			doc,
		);

		expect(result.kind).toBe("read");
		if ("error" in result.data) {
			throw new Error(`unexpected error: ${result.data.error}`);
		}
		expect(result.data.removed).toBe(true);
		expect(hasOtherAssetForGcsObjectKey).toHaveBeenCalledWith(
			"user-1",
			"users/user-1/free-asset.png",
			"free-asset",
		);
		expect(deleteGcsObject).toHaveBeenCalledWith("users/user-1/free-asset.png");
		expect(deleteAssetRow).toHaveBeenCalledWith("free-asset");
	});

	it("deletes only the row when another asset shares the same GCS object", async () => {
		const { doc, ctx } = makeMediaFixture();
		loadAssetForOwner.mockResolvedValue(ownedAsset("shared-asset"));
		hasOtherAssetForGcsObjectKey.mockResolvedValue(true);

		const result = await removeMediaAssetTool.execute(
			{ assetId: "shared-asset" },
			ctx,
			doc,
		);

		if ("error" in result.data) {
			throw new Error(`unexpected error: ${result.data.error}`);
		}
		expect(deleteAssetRow).toHaveBeenCalledWith("shared-asset");
		expect(deleteGcsObject).not.toHaveBeenCalled();
	});

	it("refuses and deletes nothing when the doc still references it", async () => {
		const { doc: baseDoc, ctx } = makeMediaFixture();
		loadAssetForOwner.mockResolvedValue(ownedAsset("used-asset"));
		const doc = docReferencing("used-asset", baseDoc);

		const result = await removeMediaAssetTool.execute(
			{ assetId: "used-asset" },
			ctx,
			doc,
		);

		if (!("error" in result.data)) {
			throw new Error("expected refusal");
		}
		expect(result.data.error).toContain("Can't delete");
		// Names the carrier — the text field's label.
		expect(result.data.error).toContain("patient_name");
		expect(deleteGcsObject).not.toHaveBeenCalled();
		expect(deleteAssetRow).not.toHaveBeenCalled();
	});

	it("refuses and deletes nothing when another live app references it", async () => {
		const { doc, ctx } = makeMediaFixture();
		loadAssetForOwner.mockResolvedValue(ownedAsset("used-elsewhere"));
		listApps.mockResolvedValue({
			apps: [
				{
					id: "other-app",
					app_name: "Other App",
					connect_type: null,
					module_count: 1,
					form_count: 1,
					status: "complete",
					error_type: null,
					created_at: "2026-05-29T00:00:00.000Z",
					updated_at: "2026-05-29T00:00:00.000Z",
				},
			],
		});
		loadApp.mockResolvedValue({
			owner: "user-1",
			deleted_at: null,
			blueprint: docReferencing("used-elsewhere", doc),
		});

		const result = await removeMediaAssetTool.execute(
			{ assetId: "used-elsewhere" },
			ctx,
			doc,
		);

		if (!("error" in result.data)) {
			throw new Error("expected refusal");
		}
		expect(result.data.error).toContain("Other App");
		expect(deleteGcsObject).not.toHaveBeenCalled();
		expect(deleteAssetRow).not.toHaveBeenCalled();
	});

	it("returns a not-found message for a missing asset", async () => {
		const { doc, ctx } = makeMediaFixture();
		loadAssetForOwner.mockResolvedValue(null);

		const result = await removeMediaAssetTool.execute(
			{ assetId: "ghost" },
			ctx,
			doc,
		);
		if (!("error" in result.data)) {
			throw new Error("expected error");
		}
		expect(result.data.error).toContain("No media asset");
		expect(deleteGcsObject).not.toHaveBeenCalled();
	});

	it("treats a foreign-owned asset as not found", async () => {
		const { doc, ctx } = makeMediaFixture();
		loadAssetForOwner.mockRejectedValue(
			new MediaAssetOwnershipError(asAssetId("other"), "user-1", "user-2"),
		);

		const result = await removeMediaAssetTool.execute(
			{ assetId: "other" },
			ctx,
			doc,
		);
		if (!("error" in result.data)) {
			throw new Error("expected error");
		}
		expect(result.data.error).toContain("No media asset");
	});
});
