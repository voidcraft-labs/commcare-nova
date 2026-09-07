// lib/media/__tests__/assetDeletion.test.ts
//
// Tests for the shared media-asset deletion logic both the SA tool and the
// browser DELETE route go through:
//   - `findAppReferencesToAsset` — the reference guard. Given the asset's
//     `media_asset_refs` reverse-index candidate set it re-walks ONLY those
//     candidate apps (names the app + carrier; skips a given app; ignores
//     deleted/foreign-Project; drops stale candidates). This is only the fast
//     preflight; the metadata-delete transaction locks and re-walks the exact
//     committed reverse projection.
//   - `purgeAssetStorage` — commit metadata deletion first, then under the
//     canonical key lock delete bytes + siblings only when unshared.
//
// Driven against mocked db/storage + a mocked `walkAuthoredAssetRefs`, so no Postgres,
// GCS, or real blueprint walk runs. The authored walk is mocked to return chosen
// references — its own traversal is covered in the domain layer.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { testMediaAssetId, testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc } from "@/lib/__tests__/docHelpers";
import type { MediaAssetRecord } from "@/lib/db/mediaAssets";
import type { AssetRef } from "@/lib/domain/mediaRefs";
import { EXTRACTOR_VERSION } from "@/lib/domain/multimedia";
import {
	carriersForAsset,
	cleanupReleasedAssetStorage,
	cleanupUnpublishedAssetObject,
	cleanupUnpublishedExtractObject,
	findAppReferencesToAsset,
	purgeAssetStorage,
} from "@/lib/media/assetDeletion";

const {
	listApps,
	loadApp,
	hasAssetForGcsObjectKey,
	hasOtherAssetForGcsObjectKey,
	hasReadyExtractForProjectAndHash,
	deleteGcsObject,
	walkAuthoredAssetRefs,
	withMediaObjectKeyLock,
} = vi.hoisted(() => ({
	listApps: vi.fn(() => Promise.resolve({ apps: [] })),
	loadApp: vi.fn(),
	hasAssetForGcsObjectKey: vi.fn(() => Promise.resolve(false)),
	hasOtherAssetForGcsObjectKey: vi.fn(() => Promise.resolve(false)),
	hasReadyExtractForProjectAndHash: vi.fn(() => Promise.resolve(false)),
	deleteGcsObject: vi.fn(() => Promise.resolve()),
	walkAuthoredAssetRefs: vi.fn<() => AssetRef[]>(() => []),
	withMediaObjectKeyLock: vi.fn(
		async (_key: string, body: (lockedDb: unknown) => Promise<unknown>) =>
			body(PINNED_DB),
	),
}));

vi.mock("@/lib/db/apps", () => ({ listApps, loadApp }));
vi.mock("@/lib/db/mediaAssets", () => ({
	hasAssetForGcsObjectKey,
	hasOtherAssetForGcsObjectKey,
	hasReadyExtractForProjectAndHash,
}));
vi.mock("@/lib/storage/media", () => ({ deleteAsset: deleteGcsObject }));
vi.mock("@/lib/storage/mediaObjectKeyLock", () => ({
	withMediaObjectKeyLock,
}));
vi.mock("@/lib/domain/mediaRefs", async (importOriginal) => ({
	// Keep the real `describeCarrier` (a pure domain switch carriersForAsset
	// renders refs through); override only the walk + adapter.
	...(await importOriginal<typeof import("@/lib/domain/mediaRefs")>()),
	walkAuthoredAssetRefs,
	// `carriersForAsset` calls `asWalkableDoc` before walking; the walk is mocked,
	// so the adapter is a passthrough here.
	asWalkableDoc: (doc: unknown) => doc,
}));

const PROJECT = "project-1";
const PINNED_DB = { session: Symbol("cleanup connection") };
const ASSET_ID = testMediaAssetId("asset-1");

/** A ready document asset row, overridable per test. */
function asset(over: Partial<MediaAssetRecord> = {}): MediaAssetRecord {
	return {
		id: ASSET_ID,
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
		created_at: new Date("2026-01-01"),
		...over,
	};
}

/** A single app-logo reference to the asset (describeCarrier → "the app logo"). */
const logoRef: AssetRef[] = [
	{ assetId: ASSET_ID, slotKind: "image", location: { kind: "app_logo" } },
];

beforeEach(() => {
	vi.resetAllMocks();
	withMediaObjectKeyLock.mockImplementation(async (_key, body) =>
		body(PINNED_DB),
	);
	deleteGcsObject.mockResolvedValue();
	listApps.mockResolvedValue({ apps: [] });
	loadApp.mockResolvedValue(null);
	hasAssetForGcsObjectKey.mockResolvedValue(false);
	hasOtherAssetForGcsObjectKey.mockResolvedValue(false);
	hasReadyExtractForProjectAndHash.mockResolvedValue(false);
	walkAuthoredAssetRefs.mockReturnValue([]);
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
	const doc = buildDoc({ modules: [] });

	it("filters to the asset and maps to carrier phrases", () => {
		// Two references to asset-1 (logo + module icon) plus one to asset-2.
		walkAuthoredAssetRefs.mockReturnValue([
			{ assetId: ASSET_ID, slotKind: "image", location: { kind: "app_logo" } },
			{
				assetId: ASSET_ID,
				slotKind: "image",
				location: {
					kind: "module_icon",
					moduleName: "Clients",
					moduleUuid: testUuid("clients"),
				},
			},
			{
				assetId: testMediaAssetId("other"),
				slotKind: "audio",
				location: {
					kind: "module_audio_label",
					moduleUuid: testUuid("other"),
					moduleName: "Other",
				},
			},
		]);
		const carriers = carriersForAsset(doc, ASSET_ID);
		expect(carriers).toContain("the app logo");
		expect(carriers).toContain('the icon on module "Clients"');
		// The unrelated asset has a distinct carrier, so exclusion is observable.
		expect(carriers).not.toContain('the audio label on module "Other"');
		expect(carriers).toHaveLength(2);
	});

	it("dedups identical carrier phrases", () => {
		walkAuthoredAssetRefs.mockReturnValue([
			{ assetId: ASSET_ID, slotKind: "image", location: { kind: "app_logo" } },
			{ assetId: ASSET_ID, slotKind: "image", location: { kind: "app_logo" } },
		]);
		expect(carriersForAsset(doc, ASSET_ID)).toEqual(["the app logo"]);
	});

	it("returns empty when the doc doesn't reference the asset", () => {
		walkAuthoredAssetRefs.mockReturnValue([
			{
				assetId: testMediaAssetId("other"),
				slotKind: "image",
				location: { kind: "app_logo" },
			},
		]);
		expect(carriersForAsset(doc, ASSET_ID)).toEqual([]);
	});
});

describe("findAppReferencesToAsset — index path (candidates given)", () => {
	it("loads ONLY the candidate apps, never the Project's whole list", async () => {
		loadApp.mockResolvedValue(appDoc());
		walkAuthoredAssetRefs.mockReturnValue(logoRef);
		const refs = await findAppReferencesToAsset(PROJECT, ASSET_ID, ["app-1"]);
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
		walkAuthoredAssetRefs.mockReturnValue([]); // app loaded, but no carrier points at it
		expect(
			await findAppReferencesToAsset(PROJECT, ASSET_ID, ["app-1"]),
		).toEqual([]);
	});

	it("returns empty for an empty candidate set without touching Postgres", async () => {
		expect(await findAppReferencesToAsset(PROJECT, ASSET_ID, [])).toEqual([]);
		expect(loadApp).not.toHaveBeenCalled();
		expect(listApps).not.toHaveBeenCalled();
	});

	it("skips the candidate named by skipAppId (without loading it)", async () => {
		walkAuthoredAssetRefs.mockReturnValue(logoRef);
		const refs = await findAppReferencesToAsset(
			PROJECT,
			ASSET_ID,
			["current"],
			{
				skipAppId: "current",
			},
		);
		expect(refs).toEqual([]);
		expect(loadApp).not.toHaveBeenCalled();
	});

	it.each([
		null,
		appDoc({ project_id: "project-2" }),
		appDoc({ deleted_at: new Date("2026-01-01") }),
	])(
		"ignores missing, foreign, or deleted candidates: %j",
		async (candidate) => {
			loadApp.mockResolvedValue(candidate);
			walkAuthoredAssetRefs.mockReturnValue(logoRef);
			expect(
				await findAppReferencesToAsset(PROJECT, ASSET_ID, ["app-1"]),
			).toEqual([]);
		},
	);
});

describe("purgeAssetStorage", () => {
	it("deletes the row, the bytes, and the sibling keys when unshared", async () => {
		const deleted = asset();
		await purgeAssetStorage({
			deleteRow: async () => deleted,
			alsoDelete: ["projects/project-1/asset-1.extract.v1.md"],
		});
		expect(deleteGcsObject).toHaveBeenCalledWith(
			"projects/project-1/asset-1.pdf",
		);
		expect(deleteGcsObject).toHaveBeenCalledWith(
			"projects/project-1/asset-1.extract.v1.md",
		);
	});

	it("deletes the row but RETAINS bytes when another row shares them", async () => {
		hasOtherAssetForGcsObjectKey.mockResolvedValue(true);
		const deleted = asset();
		await purgeAssetStorage({
			deleteRow: async () => deleted,
			alsoDelete: ["x.extract"],
		});
		expect(deleteGcsObject).not.toHaveBeenCalled();
	});

	it("deletes extension-specific bytes but retains a cross-extension shared extract", async () => {
		const deleted = asset({
			contentHash: "a".repeat(64),
			gcsObjectKey: `projects/project-1/${"a".repeat(64)}.txt`,
			extension: ".txt",
			mimeType: "text/plain",
			kind: "text",
			extract: {
				status: "ready",
				version: 2,
				model: "gpt-5.6-luna",
				truncated: false,
				charCount: 12,
				extractedAt: 123,
			},
		});
		const extractKey = `projects/project-1/${"a".repeat(64)}.extract.v2.md`;
		hasOtherAssetForGcsObjectKey.mockResolvedValue(false);
		// A surviving `.md` row for the same bytes names this extract version,
		// even though it does not share the `.txt` base-object key.
		hasReadyExtractForProjectAndHash.mockResolvedValue(true);

		await purgeAssetStorage({
			deleteRow: async () => deleted,
			alsoDelete: [extractKey],
		});

		expect(deleteGcsObject).toHaveBeenCalledWith(deleted.gcsObjectKey);
		expect(deleteGcsObject).not.toHaveBeenCalledWith(extractKey);
		expect(hasReadyExtractForProjectAndHash).toHaveBeenCalledWith(
			"project-1",
			"a".repeat(64),
			2,
			PINNED_DB,
		);
	});

	it("retains a current shared extract when the deleted cross-extension row has no metadata", async () => {
		const deleted = asset({
			contentHash: "c".repeat(64),
			gcsObjectKey: `projects/project-1/${"c".repeat(64)}.txt`,
			extension: ".txt",
			mimeType: "text/plain",
			kind: "text",
			extract: undefined,
		});
		const extractKey = `projects/project-1/${"c".repeat(64)}.extract.v${EXTRACTOR_VERSION}.md`;
		hasReadyExtractForProjectAndHash.mockResolvedValue(true);

		await purgeAssetStorage({
			deleteRow: async () => deleted,
			alsoDelete: [extractKey],
		});

		expect(deleteGcsObject).toHaveBeenCalledWith(deleted.gcsObjectKey);
		expect(deleteGcsObject).not.toHaveBeenCalledWith(extractKey);
		expect(hasReadyExtractForProjectAndHash).toHaveBeenCalledWith(
			"project-1",
			"c".repeat(64),
			EXTRACTOR_VERSION,
			PINNED_DB,
		);
	});

	it("fails closed for a shared-extract probe without retaining unshared base bytes", async () => {
		const deleted = asset({
			contentHash: "b".repeat(64),
			gcsObjectKey: `projects/project-1/${"b".repeat(64)}.md`,
			extension: ".md",
			mimeType: "text/markdown",
			kind: "text",
			extract: {
				status: "ready",
				version: 2,
				model: "gpt-5.6-luna",
				truncated: false,
				charCount: 12,
				extractedAt: 123,
			},
		});
		const extractKey = `projects/project-1/${"b".repeat(64)}.extract.v2.md`;
		hasReadyExtractForProjectAndHash.mockRejectedValue(
			new Error("db unavailable"),
		);

		await purgeAssetStorage({
			deleteRow: async () => deleted,
			alsoDelete: [extractKey],
		});

		expect(deleteGcsObject).toHaveBeenCalledWith(deleted.gcsObjectKey);
		expect(deleteGcsObject).not.toHaveBeenCalledWith(extractKey);
	});

	it("fails closed (retains bytes) when the shared-bytes probe throws", async () => {
		hasOtherAssetForGcsObjectKey.mockRejectedValue(new Error("db unavailable"));
		const deleted = asset();
		await purgeAssetStorage({ deleteRow: async () => deleted });
		expect(deleteGcsObject).not.toHaveBeenCalled();
	});

	it("skips null sibling keys (a non-document has no extract)", async () => {
		const deleted = asset();
		await purgeAssetStorage({
			deleteRow: async () => deleted,
			alsoDelete: [null],
		});
		expect(deleteGcsObject).toHaveBeenCalledTimes(1);
		expect(deleteGcsObject).toHaveBeenCalledWith(
			"projects/project-1/asset-1.pdf",
		);
	});

	it("runs an authoritative row delete before GCS and stops when it lost the row", async () => {
		const deleteRow = vi.fn(() => Promise.resolve(false as const));
		expect(
			await purgeAssetStorage({
				alsoDelete: ["x.extract"],
				deleteRow,
			}),
		).toBe(false);
		expect(deleteRow).toHaveBeenCalledOnce();
		expect(deleteGcsObject).not.toHaveBeenCalled();
	});

	it("waits for committed metadata deletion before taking the cleanup lock", async () => {
		const gate = deferred();
		const deleteRow = vi.fn(async () => {
			await gate.promise;
			return asset();
		});
		const pending = purgeAssetStorage({ deleteRow });
		const settled = Promise.allSettled([pending]);
		try {
			await vi.waitFor(() => expect(deleteRow).toHaveBeenCalledOnce());
			expect(withMediaObjectKeyLock).not.toHaveBeenCalled();
			expect(deleteGcsObject).not.toHaveBeenCalled();
			gate.resolve();
			expect(await pending).toBe(true);
			expect(deleteGcsObject).toHaveBeenCalledWith(asset().gcsObjectKey);
		} finally {
			gate.resolve();
			await settled;
		}
	});

	it("cleans the authoritative locked row when publication changed the key after preflight", async () => {
		const locked = asset({
			gcsObjectKey: "projects/project-1/final.pdf",
			contentHash: "final-hash",
		});
		const deleteRow = vi.fn(() => Promise.resolve(locked));
		await purgeAssetStorage({
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
				return await body(PINNED_DB);
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
		expect(hasAssetForGcsObjectKey).toHaveBeenCalledWith(key, PINNED_DB);
		expect(deleteGcsObject).toHaveBeenCalledWith(key);
	});

	it("retains a copied final object when metadata already names it", async () => {
		hasAssetForGcsObjectKey.mockResolvedValue(true);

		await cleanupUnpublishedAssetObject("projects/project-1/published.pdf");

		expect(deleteGcsObject).not.toHaveBeenCalled();
	});

	it("deletes a copied extract when no ready metadata publication names its version", async () => {
		const key = "projects/project-1/hash.extract.v2.md";

		await cleanupUnpublishedExtractObject({
			gcsObjectKey: key,
			projectId: PROJECT,
			contentHash: "hash",
			version: 2,
		});

		expect(withMediaObjectKeyLock).toHaveBeenCalledWith(
			key,
			expect.any(Function),
		);
		expect(hasReadyExtractForProjectAndHash).toHaveBeenCalledWith(
			PROJECT,
			"hash",
			2,
			PINNED_DB,
		);
		expect(deleteGcsObject).toHaveBeenCalledWith(key);
	});

	it("retains a copied extract when a ready sibling won before cleanup", async () => {
		hasReadyExtractForProjectAndHash.mockResolvedValue(true);

		await cleanupUnpublishedExtractObject({
			gcsObjectKey: "projects/project-1/hash.extract.v2.md",
			projectId: PROJECT,
			contentHash: "hash",
			version: 2,
		});

		expect(deleteGcsObject).not.toHaveBeenCalled();
	});

	it("fails closed when the post-failure extract metadata recheck errors", async () => {
		hasReadyExtractForProjectAndHash.mockRejectedValue(
			new Error("database unavailable"),
		);

		await cleanupUnpublishedExtractObject({
			gcsObjectKey: "projects/project-1/hash.extract.v2.md",
			projectId: PROJECT,
			contentHash: "hash",
			version: 2,
		});

		expect(deleteGcsObject).not.toHaveBeenCalled();
	});

	it("holds the cleanup lock through byte deletion before a waiting publisher runs", async () => {
		installKeyMutex();
		const allowProbe = deferred();
		const events: string[] = [];
		hasOtherAssetForGcsObjectKey.mockImplementation(async () => {
			await allowProbe.promise;
			return false;
		});
		deleteGcsObject.mockImplementation(async () => {
			events.push("delete");
		});
		const cleanup = cleanupReleasedAssetStorage(asset());
		const cleanupSettled = Promise.allSettled([cleanup]);
		let publicationSettled: Promise<unknown> | undefined;
		try {
			await vi.waitFor(() =>
				expect(hasOtherAssetForGcsObjectKey).toHaveBeenCalledWith(
					asset().gcsObjectKey,
					ASSET_ID,
					PINNED_DB,
				),
			);
			const publication = withMediaObjectKeyLock(
				asset().gcsObjectKey,
				async () => {
					events.push("publish");
				},
			);
			publicationSettled = Promise.allSettled([publication]);
			allowProbe.resolve();
			await Promise.all([cleanup, publication]);
			expect(events).toEqual(["delete", "publish"]);
		} finally {
			allowProbe.resolve();
			await cleanupSettled;
			await publicationSettled;
		}
	});

	it("rechecks metadata after a prior publisher releases the shared lock", async () => {
		installKeyMutex();
		let siblingExists = false;
		const allowPublisherCommit = deferred();
		hasOtherAssetForGcsObjectKey.mockImplementation(async () => siblingExists);
		const publication = withMediaObjectKeyLock(
			asset().gcsObjectKey,
			async () => {
				await allowPublisherCommit.promise;
				siblingExists = true;
			},
		);
		const publicationSettled = Promise.allSettled([publication]);
		const cleanup = cleanupReleasedAssetStorage(asset());
		const cleanupSettled = Promise.allSettled([cleanup]);
		try {
			// A queued cleanup must not read metadata until publication completes.
			await vi.waitFor(() =>
				expect(withMediaObjectKeyLock).toHaveBeenCalledTimes(2),
			);
			expect(hasOtherAssetForGcsObjectKey).not.toHaveBeenCalled();
			allowPublisherCommit.resolve();
			await Promise.all([publication, cleanup]);
			expect(hasOtherAssetForGcsObjectKey).toHaveBeenCalledWith(
				asset().gcsObjectKey,
				ASSET_ID,
				PINNED_DB,
			);
			expect(deleteGcsObject).not.toHaveBeenCalled();
		} finally {
			allowPublisherCommit.resolve();
			await Promise.all([publicationSettled, cleanupSettled]);
		}
	});
});
