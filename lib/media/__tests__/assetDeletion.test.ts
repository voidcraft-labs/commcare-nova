// lib/media/__tests__/assetDeletion.test.ts
//
// Tests for the shared media-asset deletion logic both the SA tool and the
// browser DELETE route go through:
//   - `findAppReferencesToAsset` — the reference guard. Given the asset's
//     `media_asset_refs` reverse-index candidate set it re-walks ONLY those
//     candidate apps (names the app + carrier; skips a given app; ignores
//     deleted/foreign-Project; drops stale candidates). There is no un-indexed
//     full-scan fallback — the migration backfills the join table for every row.
//   - `purgeAssetStorage` — commit metadata deletion first, then under the
//     canonical key lock delete bytes + siblings only when unshared.
//
// Driven against mocked db/storage + a mocked `walkAssetRefs`, so no Postgres,
// GCS, or real blueprint walk runs. `walkAssetRefs` is mocked to return chosen
// references — its own traversal is covered in the domain layer.

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ListAppsResult } from "@/lib/db/apps";
import type { MediaAssetRecord } from "@/lib/db/mediaAssets";
import type { BlueprintDoc } from "@/lib/domain";
import {
	carriersForAsset,
	cleanupReleasedAssetStorage,
	cleanupUnpublishedAssetObject,
	findAppReferencesToAsset,
	purgeAssetStorage,
} from "@/lib/media/assetDeletion";

const {
	listApps,
	loadApp,
	deleteAssetRow,
	hasAssetForGcsObjectKey,
	hasOtherAssetForGcsObjectKey,
	deleteGcsObject,
	walkAssetRefs,
	withMediaObjectKeyLock,
} = vi.hoisted(() => ({
	listApps: vi.fn<() => Promise<ListAppsResult>>(() =>
		Promise.resolve({ apps: [] }),
	),
	loadApp: vi.fn(),
	deleteAssetRow: vi.fn(() => Promise.resolve()),
	hasAssetForGcsObjectKey: vi.fn(() => Promise.resolve(false)),
	hasOtherAssetForGcsObjectKey: vi.fn(() => Promise.resolve(false)),
	deleteGcsObject: vi.fn(() => Promise.resolve()),
	walkAssetRefs: vi.fn(() => []),
	withMediaObjectKeyLock: vi.fn(
		async (_key: string, body: (lockedDb: unknown) => Promise<unknown>) =>
			body({ pinned: true }),
	),
}));

vi.mock("@/lib/db/apps", () => ({ listApps, loadApp }));
vi.mock("@/lib/db/mediaAssets", () => ({
	deleteAsset: deleteAssetRow,
	hasAssetForGcsObjectKey,
	hasOtherAssetForGcsObjectKey,
}));
vi.mock("@/lib/storage/media", () => ({ deleteAsset: deleteGcsObject }));
vi.mock("@/lib/storage/mediaObjectKeyLock", () => ({
	withMediaObjectKeyLock,
}));
vi.mock("@/lib/domain/mediaRefs", async (importOriginal) => ({
	// Keep the real `describeCarrier` (a pure domain switch carriersForAsset
	// renders refs through); override only the walk + adapter.
	...(await importOriginal<typeof import("@/lib/domain/mediaRefs")>()),
	walkAssetRefs,
	// `carriersForAsset` calls `asWalkableDoc` before walking; the walk is mocked,
	// so the adapter is a passthrough here.
	asWalkableDoc: (doc: unknown) => doc,
}));

const PROJECT = "project-1";

/** A ready document asset row, overridable per test. */
function asset(over: Partial<MediaAssetRecord> = {}): MediaAssetRecord {
	return {
		id: "asset-1",
		owner: "user-1",
		project_id: PROJECT,
		gcsObjectKey: "projects/project-1/asset-1.pdf",
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
	hasAssetForGcsObjectKey.mockResolvedValue(false);
	hasOtherAssetForGcsObjectKey.mockResolvedValue(false);
	walkAssetRefs.mockReturnValue([]);
});

/** A persisted app doc as `loadApp` returns it (only the fields the guard reads). */
function appDoc(over: Record<string, unknown> = {}) {
	return {
		owner: "user-1",
		project_id: PROJECT,
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
	it("loads ONLY the candidate apps, never the Project's whole list", async () => {
		loadApp.mockResolvedValue(appDoc());
		walkAssetRefs.mockReturnValue(logoRef);
		const refs = await findAppReferencesToAsset(PROJECT, "asset-1", ["app-1"]);
		expect(refs).toHaveLength(1);
		expect(refs[0]).toContain("App One");
		expect(refs[0]).toContain("the app logo");
		// The index path must not page the Project's apps — that's the slow scan it
		// replaces.
		expect(listApps).not.toHaveBeenCalled();
		expect(loadApp).toHaveBeenCalledTimes(1);
		expect(loadApp).toHaveBeenCalledWith("app-1");
	});

	it("returns empty for a STALE candidate that no longer references the asset", async () => {
		loadApp.mockResolvedValue(appDoc());
		walkAssetRefs.mockReturnValue([]); // app loaded, but no carrier points at it
		expect(
			await findAppReferencesToAsset(PROJECT, "asset-1", ["app-1"]),
		).toEqual([]);
	});

	it("returns empty for an empty candidate set without touching Postgres", async () => {
		expect(await findAppReferencesToAsset(PROJECT, "asset-1", [])).toEqual([]);
		expect(loadApp).not.toHaveBeenCalled();
		expect(listApps).not.toHaveBeenCalled();
	});

	it("skips the candidate named by skipAppId (without loading it)", async () => {
		walkAssetRefs.mockReturnValue(logoRef);
		const refs = await findAppReferencesToAsset(
			PROJECT,
			"asset-1",
			["current"],
			{
				skipAppId: "current",
			},
		);
		expect(refs).toEqual([]);
		expect(loadApp).not.toHaveBeenCalled();
	});

	it("ignores a deleted or foreign-Project candidate", async () => {
		loadApp.mockResolvedValue(appDoc({ project_id: "project-2" })); // another Project
		walkAssetRefs.mockReturnValue(logoRef);
		expect(
			await findAppReferencesToAsset(PROJECT, "asset-1", ["app-1"]),
		).toEqual([]);
	});
});

describe("purgeAssetStorage", () => {
	it("deletes the row, the bytes, and the sibling keys when unshared", async () => {
		await purgeAssetStorage(asset(), {
			alsoDelete: ["projects/project-1/asset-1.extract.v1.md"],
		});
		expect(deleteAssetRow).toHaveBeenCalledWith("asset-1");
		expect(deleteGcsObject).toHaveBeenCalledWith(
			"projects/project-1/asset-1.pdf",
		);
		expect(deleteGcsObject).toHaveBeenCalledWith(
			"projects/project-1/asset-1.extract.v1.md",
		);
	});

	it("deletes the row but RETAINS bytes when another row shares them", async () => {
		hasOtherAssetForGcsObjectKey.mockResolvedValue(true);
		await purgeAssetStorage(asset(), { alsoDelete: ["x.extract"] });
		expect(deleteAssetRow).toHaveBeenCalledWith("asset-1");
		expect(deleteGcsObject).not.toHaveBeenCalled();
	});

	it("fails closed (retains bytes) when the shared-bytes probe throws", async () => {
		hasOtherAssetForGcsObjectKey.mockRejectedValue(new Error("db unavailable"));
		await purgeAssetStorage(asset());
		expect(deleteAssetRow).toHaveBeenCalledWith("asset-1");
		expect(deleteGcsObject).not.toHaveBeenCalled();
	});

	it("skips null sibling keys (a non-document has no extract)", async () => {
		await purgeAssetStorage(asset(), { alsoDelete: [null] });
		expect(deleteGcsObject).toHaveBeenCalledTimes(1);
		expect(deleteGcsObject).toHaveBeenCalledWith(
			"projects/project-1/asset-1.pdf",
		);
	});

	it("runs an authoritative row delete before GCS and stops when it lost the row", async () => {
		const deleteRow = vi.fn(() => Promise.resolve(false));
		expect(
			await purgeAssetStorage(asset(), {
				alsoDelete: ["x.extract"],
				deleteRow,
			}),
		).toBe(false);
		expect(deleteRow).toHaveBeenCalledOnce();
		expect(deleteAssetRow).not.toHaveBeenCalled();
		expect(deleteGcsObject).not.toHaveBeenCalled();
	});

	it("commits metadata deletion before taking the object-key cleanup lock", async () => {
		const deleteRow = vi.fn(() => Promise.resolve(true));
		await purgeAssetStorage(asset(), { deleteRow });

		expect(deleteRow.mock.invocationCallOrder[0]).toBeLessThan(
			withMediaObjectKeyLock.mock.invocationCallOrder[0] ?? 0,
		);
		expect(withMediaObjectKeyLock).toHaveBeenCalledWith(
			"projects/project-1/asset-1.pdf",
			expect.any(Function),
		);
	});

	it("cleans the authoritative locked row when publication changed the key after preflight", async () => {
		const locked = asset({
			gcsObjectKey: "projects/project-1/final.pdf",
			contentHash: "final-hash",
		});
		const deleteRow = vi.fn(() => Promise.resolve(locked));
		await purgeAssetStorage(asset({ gcsObjectKey: "pending/asset-1.pdf" }), {
			deleteRow,
			alsoDeleteForAsset: (deletedAsset) => [
				`${deletedAsset.contentHash}.extract`,
			],
		});

		expect(withMediaObjectKeyLock).toHaveBeenCalledWith(
			"projects/project-1/final.pdf",
			expect.any(Function),
		);
		expect(deleteGcsObject).toHaveBeenCalledWith(
			"projects/project-1/final.pdf",
		);
		expect(deleteGcsObject).toHaveBeenCalledWith("final-hash.extract");
	});
});

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

function installKeyMutex(): void {
	let tail = Promise.resolve();
	withMediaObjectKeyLock.mockImplementation(
		async (_key: string, body: (lockedDb: unknown) => Promise<unknown>) => {
			const prior = tail;
			let release!: () => void;
			tail = new Promise<void>((resolve) => {
				release = resolve;
			});
			await prior;
			try {
				return await body({ pinned: true });
			} finally {
				release();
			}
		},
	);
}

describe("canonical object-key cleanup/publication winner orders", () => {
	it("deletes a copied final object when no metadata publication names it", async () => {
		const key = "projects/project-1/unpublished.pdf";

		await cleanupUnpublishedAssetObject(key);

		expect(withMediaObjectKeyLock).toHaveBeenCalledWith(
			key,
			expect.any(Function),
		);
		expect(hasAssetForGcsObjectKey).toHaveBeenCalledWith(
			key,
			expect.anything(),
		);
		expect(deleteGcsObject).toHaveBeenCalledWith(key);
	});

	it("retains a copied final object when a retry published while cleanup waited", async () => {
		hasAssetForGcsObjectKey.mockResolvedValue(true);

		await cleanupUnpublishedAssetObject("projects/project-1/published.pdf");

		expect(deleteGcsObject).not.toHaveBeenCalled();
	});

	it("lets cleanup finish first, then a waiting publisher restores bytes before ready metadata", async () => {
		installKeyMutex();
		let objectExists = true;
		let siblingExists = false;
		const probeStarted = deferred();
		const allowProbe = deferred();
		hasOtherAssetForGcsObjectKey.mockImplementation(async () => {
			probeStarted.resolve();
			await allowProbe.promise;
			return siblingExists;
		});
		deleteGcsObject.mockImplementation(async () => {
			objectExists = false;
		});

		const cleanup = cleanupReleasedAssetStorage(asset());
		await probeStarted.promise;
		const publication = withMediaObjectKeyLock(
			"projects/project-1/asset-1.pdf",
			async () => {
				objectExists = true;
				siblingExists = true;
			},
		);
		allowProbe.resolve();
		await Promise.all([cleanup, publication]);

		expect(objectExists).toBe(true);
		expect(siblingExists).toBe(true);
	});

	it("lets publication finish first, then cleanup sees its ready sibling and retains bytes", async () => {
		installKeyMutex();
		let objectExists = false;
		let siblingExists = false;
		const publisherEntered = deferred();
		const allowPublisherCommit = deferred();
		hasOtherAssetForGcsObjectKey.mockImplementation(async () => siblingExists);
		deleteGcsObject.mockImplementation(async () => {
			objectExists = false;
		});

		const publication = withMediaObjectKeyLock(
			"projects/project-1/asset-1.pdf",
			async () => {
				publisherEntered.resolve();
				objectExists = true;
				await allowPublisherCommit.promise;
				siblingExists = true;
			},
		);
		await publisherEntered.promise;
		const cleanup = cleanupReleasedAssetStorage(asset());
		allowPublisherCommit.resolve();
		await Promise.all([publication, cleanup]);

		expect(objectExists).toBe(true);
		expect(siblingExists).toBe(true);
		expect(deleteGcsObject).not.toHaveBeenCalled();
	});
});
