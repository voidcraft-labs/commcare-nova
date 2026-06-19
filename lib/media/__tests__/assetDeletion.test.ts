// lib/media/__tests__/assetDeletion.test.ts
//
// Tests for the shared media-asset deletion logic both the SA tool and the
// browser DELETE route go through:
//   - `findAppReferencesToAsset` — the reference guard. Given the asset's
//     `referencingAppIds` index it re-walks ONLY those candidate apps (names the
//     app + carrier; skips a given app; ignores deleted/foreign; drops stale
//     candidates); given `undefined` (un-backfilled row) it falls back to the
//     full owner-wide scan.
//   - `purgeAssetStorage` — drop the row always, delete bytes + sibling keys
//     only when the bytes are unshared, fail closed on a probe error.
//
// Driven against mocked db/storage + a mocked `walkAssetRefs`, so no Firestore,
// GCS, or real blueprint walk runs. `walkAssetRefs` is mocked to return chosen
// references — its own traversal is covered in the domain layer.

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ListAppsResult } from "@/lib/db/apps";
import type { MediaAssetRecord } from "@/lib/db/mediaAssets";
import type { BlueprintDoc } from "@/lib/domain";
import {
	carriersForAsset,
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
vi.mock("@/lib/domain/mediaRefs", async (importOriginal) => ({
	// Keep the real `describeCarrier` (a pure domain switch carriersForAsset
	// renders refs through); override only the walk + adapter.
	...(await importOriginal<typeof import("@/lib/domain/mediaRefs")>()),
	walkAssetRefs,
	// `carriersForAsset` calls `asWalkableDoc` before walking; the walk is mocked,
	// so the adapter is a passthrough here.
	asWalkableDoc: (doc: unknown) => doc,
}));

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
	// `clearAllMocks` resets call history but NOT implementations, so a
	// `mockResolvedValue` set in one test would leak into the next. Re-seed every
	// mock's default impl here so each test starts from the same baseline
	// regardless of order.
	vi.clearAllMocks();
	listApps.mockResolvedValue({ apps: [] });
	loadApp.mockResolvedValue(null);
	hasOtherAssetForGcsObjectKey.mockResolvedValue(false);
	walkAssetRefs.mockReturnValue([]);
});

/** A persisted app doc as `loadApp` returns it (only the fields the guard reads). */
function appDoc(over: Record<string, unknown> = {}) {
	return {
		owner: "user-1",
		app_name: "App One",
		deleted_at: null,
		blueprint: {},
		...over,
	};
}

describe("carriersForAsset", () => {
	const doc = {} as BlueprintDoc;

	it("filters to the asset, maps to carrier phrases, and dedups", async () => {
		// Two references to asset-1 (logo + module icon) plus one to asset-2.
		walkAssetRefs.mockReturnValue([
			{ assetId: "asset-1", location: { kind: "app_logo" } },
			{
				assetId: "asset-1",
				slotKind: "image",
				location: { kind: "module_icon", moduleName: "Clients" },
			},
			{ assetId: "asset-2", location: { kind: "app_logo" } },
		] as never);
		const carriers = carriersForAsset(doc, "asset-1");
		expect(carriers).toContain("the app logo");
		expect(carriers).toContain('the icon on module "Clients"');
		// asset-2's carrier is excluded.
		expect(carriers).not.toContain("the app logo the app logo");
		expect(carriers).toHaveLength(2);
	});

	it("dedups identical carriers (same asset on two slots of one form reads once)", async () => {
		walkAssetRefs.mockReturnValue([
			{ assetId: "asset-1", location: { kind: "app_logo" } },
			{ assetId: "asset-1", location: { kind: "app_logo" } },
		] as never);
		expect(carriersForAsset(doc, "asset-1")).toEqual(["the app logo"]);
	});

	it("returns empty when the doc doesn't reference the asset", async () => {
		walkAssetRefs.mockReturnValue([
			{ assetId: "other", location: { kind: "app_logo" } },
		] as never);
		expect(carriersForAsset(doc, "asset-1")).toEqual([]);
	});
});

describe("findAppReferencesToAsset — index path (candidates given)", () => {
	it("loads ONLY the candidate apps, never the owner's whole list", async () => {
		loadApp.mockResolvedValue(appDoc());
		walkAssetRefs.mockReturnValue(logoRef);
		const refs = await findAppReferencesToAsset("user-1", "asset-1", ["app-1"]);
		expect(refs).toHaveLength(1);
		expect(refs[0]).toContain("App One");
		expect(refs[0]).toContain("the app logo");
		// The index path must not page the owner's apps — that's the slow scan it
		// replaces.
		expect(listApps).not.toHaveBeenCalled();
		expect(loadApp).toHaveBeenCalledTimes(1);
		expect(loadApp).toHaveBeenCalledWith("app-1");
	});

	it("returns empty for a STALE candidate that no longer references the asset", async () => {
		loadApp.mockResolvedValue(appDoc());
		walkAssetRefs.mockReturnValue([]); // app loaded, but no carrier points at it
		expect(
			await findAppReferencesToAsset("user-1", "asset-1", ["app-1"]),
		).toEqual([]);
	});

	it("returns empty for an empty candidate set without touching Firestore", async () => {
		expect(await findAppReferencesToAsset("user-1", "asset-1", [])).toEqual([]);
		expect(loadApp).not.toHaveBeenCalled();
		expect(listApps).not.toHaveBeenCalled();
	});

	it("skips the candidate named by skipAppId (without loading it)", async () => {
		walkAssetRefs.mockReturnValue(logoRef);
		const refs = await findAppReferencesToAsset(
			"user-1",
			"asset-1",
			["current"],
			{
				skipAppId: "current",
			},
		);
		expect(refs).toEqual([]);
		expect(loadApp).not.toHaveBeenCalled();
	});

	it("ignores a foreign-owned or deleted candidate", async () => {
		loadApp.mockResolvedValue(appDoc({ owner: "user-2" })); // not the caller
		walkAssetRefs.mockReturnValue(logoRef);
		expect(
			await findAppReferencesToAsset("user-1", "asset-1", ["app-1"]),
		).toEqual([]);
	});
});

describe("findAppReferencesToAsset — full-scan fallback (candidates undefined)", () => {
	it("pages the owner's apps when the asset row was never backfilled", async () => {
		listApps.mockResolvedValue({ apps: [appSummary("app-1", "App One")] });
		loadApp.mockResolvedValue(appDoc());
		walkAssetRefs.mockReturnValue(logoRef);
		const refs = await findAppReferencesToAsset("user-1", "asset-1", undefined);
		expect(listApps).toHaveBeenCalled();
		expect(refs).toHaveLength(1);
		expect(refs[0]).toContain("App One");
		expect(refs[0]).toContain("the app logo");
	});

	it("returns empty when no app in the scan references the asset", async () => {
		listApps.mockResolvedValue({ apps: [appSummary("app-1", "App One")] });
		loadApp.mockResolvedValue(appDoc());
		walkAssetRefs.mockReturnValue([]);
		expect(
			await findAppReferencesToAsset("user-1", "asset-1", undefined),
		).toEqual([]);
	});

	it("skips the current app named by skipAppId during the scan", async () => {
		// The SA tool checks its in-hand working doc separately, then scans every
		// OTHER app — so a fallback scan must skip the current app even though
		// listApps returns it.
		listApps.mockResolvedValue({ apps: [appSummary("current", "Current")] });
		loadApp.mockResolvedValue(appDoc({ app_name: "Current" }));
		walkAssetRefs.mockReturnValue(logoRef);
		const refs = await findAppReferencesToAsset(
			"user-1",
			"asset-1",
			undefined,
			{
				skipAppId: "current",
			},
		);
		expect(refs).toEqual([]);
		expect(loadApp).not.toHaveBeenCalled();
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
