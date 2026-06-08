// lib/media/__tests__/assetDeletion.test.ts
//
// Tests for the shared media-asset deletion logic both the SA tool and the
// browser DELETE route go through:
//   - `findAppReferencesToAsset` — the owner-wide reference scan (names the
//     referencing app + carrier; skips a given app; ignores deleted/foreign).
//   - `purgeAssetStorage` — drop the row always, delete bytes + sibling keys
//     only when the bytes are unshared, fail closed on a probe error.
//
// Driven against mocked db/storage + a mocked `walkAssetRefs`, so no Firestore,
// GCS, or real blueprint walk runs. `walkAssetRefs` is mocked to return chosen
// references — its own traversal is covered in the domain layer.

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ListAppsResult } from "@/lib/db/apps";
import type { MediaAssetRecord } from "@/lib/db/mediaAssets";
import {
	findAppReferencesToAsset,
	purgeAssetStorage,
} from "@/lib/media/assetDeletion";

const {
	listApps,
	loadApp,
	deleteAssetRow,
	hasOtherAssetForGcsObjectKey,
	deleteGcsObject,
	walkAssetRefs,
} = vi.hoisted(() => ({
	listApps: vi.fn<() => Promise<ListAppsResult>>(() =>
		Promise.resolve({ apps: [] }),
	),
	loadApp: vi.fn(),
	deleteAssetRow: vi.fn(() => Promise.resolve()),
	hasOtherAssetForGcsObjectKey: vi.fn(() => Promise.resolve(false)),
	deleteGcsObject: vi.fn(() => Promise.resolve()),
	walkAssetRefs: vi.fn(() => []),
}));

vi.mock("@/lib/db/apps", () => ({ listApps, loadApp }));
vi.mock("@/lib/db/mediaAssets", () => ({
	deleteAsset: deleteAssetRow,
	hasOtherAssetForGcsObjectKey,
}));
vi.mock("@/lib/storage/media", () => ({ deleteAsset: deleteGcsObject }));
vi.mock("@/lib/domain/mediaRefs", () => ({ walkAssetRefs }));

/** A ready document asset row, overridable per test. */
function asset(over: Partial<MediaAssetRecord> = {}): MediaAssetRecord {
	return {
		id: "asset-1",
		owner: "user-1",
		gcsObjectKey: "users/user-1/asset-1.pdf",
		originalFilename: "spec.pdf",
		contentHash: "abc",
		mimeType: "application/pdf",
		kind: "pdf",
		extension: ".pdf",
		sizeBytes: 100,
		status: "ready",
		...over,
	} as unknown as MediaAssetRecord;
}

/** A library list summary (only the fields the scan reads matter). */
function appSummary(id: string, name: string): ListAppsResult["apps"][number] {
	return {
		id,
		app_name: name,
		connect_type: null,
		module_count: 1,
		form_count: 1,
		status: "complete",
		error_type: null,
		logo: null,
		created_at: "2026-05-29T00:00:00.000Z",
		updated_at: "2026-05-29T00:00:00.000Z",
	};
}

/** A single app-logo reference to the asset (describeCarrier → "the app logo"). */
const logoRef = [
	{ assetId: "asset-1", location: { kind: "app_logo" } },
] as never;

beforeEach(() => {
	vi.clearAllMocks();
	listApps.mockResolvedValue({ apps: [] });
	hasOtherAssetForGcsObjectKey.mockResolvedValue(false);
	walkAssetRefs.mockReturnValue([]);
});

describe("findAppReferencesToAsset", () => {
	it("returns empty when no app references the asset", async () => {
		listApps.mockResolvedValue({ apps: [appSummary("app-1", "App One")] });
		loadApp.mockResolvedValue({
			owner: "user-1",
			deleted_at: null,
			blueprint: {},
		});
		walkAssetRefs.mockReturnValue([]);
		expect(await findAppReferencesToAsset("user-1", "asset-1")).toEqual([]);
	});

	it("names the app and the carrier when an app references it", async () => {
		listApps.mockResolvedValue({ apps: [appSummary("app-1", "App One")] });
		loadApp.mockResolvedValue({
			owner: "user-1",
			deleted_at: null,
			blueprint: {},
		});
		walkAssetRefs.mockReturnValue(logoRef);
		const refs = await findAppReferencesToAsset("user-1", "asset-1");
		expect(refs).toHaveLength(1);
		expect(refs[0]).toContain("App One");
		expect(refs[0]).toContain("the app logo");
	});

	it("skips the app named by skipAppId (without even loading it)", async () => {
		listApps.mockResolvedValue({ apps: [appSummary("current", "Current")] });
		walkAssetRefs.mockReturnValue(logoRef);
		const refs = await findAppReferencesToAsset("user-1", "asset-1", {
			skipAppId: "current",
		});
		expect(refs).toEqual([]);
		expect(loadApp).not.toHaveBeenCalled();
	});

	it("ignores a foreign-owned or deleted app", async () => {
		listApps.mockResolvedValue({ apps: [appSummary("app-1", "App One")] });
		loadApp.mockResolvedValue({
			owner: "user-2", // not the caller
			deleted_at: null,
			blueprint: {},
		});
		walkAssetRefs.mockReturnValue(logoRef);
		expect(await findAppReferencesToAsset("user-1", "asset-1")).toEqual([]);
	});
});

describe("purgeAssetStorage", () => {
	it("deletes the row, the bytes, and the sibling keys when unshared", async () => {
		await purgeAssetStorage(asset(), {
			alsoDelete: ["users/user-1/asset-1.extract.v1.md"],
		});
		expect(deleteAssetRow).toHaveBeenCalledWith("asset-1");
		expect(deleteGcsObject).toHaveBeenCalledWith("users/user-1/asset-1.pdf");
		expect(deleteGcsObject).toHaveBeenCalledWith(
			"users/user-1/asset-1.extract.v1.md",
		);
	});

	it("deletes the row but RETAINS bytes when another row shares them", async () => {
		hasOtherAssetForGcsObjectKey.mockResolvedValue(true);
		await purgeAssetStorage(asset(), { alsoDelete: ["x.extract"] });
		expect(deleteAssetRow).toHaveBeenCalledWith("asset-1");
		expect(deleteGcsObject).not.toHaveBeenCalled();
	});

	it("fails closed (retains bytes) when the shared-bytes probe throws", async () => {
		hasOtherAssetForGcsObjectKey.mockRejectedValue(new Error("firestore down"));
		await purgeAssetStorage(asset());
		expect(deleteAssetRow).toHaveBeenCalledWith("asset-1");
		expect(deleteGcsObject).not.toHaveBeenCalled();
	});

	it("skips null sibling keys (a non-document has no extract)", async () => {
		await purgeAssetStorage(asset(), { alsoDelete: [null] });
		expect(deleteGcsObject).toHaveBeenCalledTimes(1);
		expect(deleteGcsObject).toHaveBeenCalledWith("users/user-1/asset-1.pdf");
	});
});
