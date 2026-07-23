/**
 * `POST /api/media/upload/[assetId]/confirm` — storage lifecycle tests.
 *
 * Confirm is the only place untrusted browser bytes become reusable
 * library bytes. These tests pin the safety invariants: validation failure
 * never deletes a shared object, validation success publishes the exact bytes
 * that passed validation, and duplicate confirms converge on one terminal
 * ready row.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { requireSession } from "@/lib/auth-utils";
import { userInProject } from "@/lib/db/appAccess";
import {
	canonicalizePendingAssetForActor,
	deletePendingAssetForActor,
	findReadyAssetByProjectAndHash,
	loadAssetById,
	type MediaAssetRecord,
	publishPendingAssetForActor,
	purgeExpiredMediaUploadAliases,
	resolveReadyUploadAliasForActor,
} from "@/lib/db/mediaAssets";
import { asAssetId } from "@/lib/domain/multimedia";
import {
	cleanupReleasedAssetStorage,
	cleanupUnpublishedAssetObject,
} from "@/lib/media/assetDeletion";
import { validateMediaBytes } from "@/lib/media/validate";
import {
	downloadAssetBytes,
	getStoredObjectSize,
	uploadAssetBytes,
} from "@/lib/storage/media";
import { POST } from "../route";

const HASH = "b".repeat(64);

const {
	requireSessionMock,
	userInProjectMock,
	canonicalizePendingAssetForActorMock,
	deletePendingAssetForActorMock,
	findReadyAssetByProjectAndHashMock,
	loadAssetByIdMock,
	publishPendingAssetForActorMock,
	purgeExpiredMediaUploadAliasesMock,
	resolveReadyUploadAliasForActorMock,
	cleanupReleasedAssetStorageMock,
	cleanupUnpublishedAssetObjectMock,
	copyAssetObjectMock,
	downloadAssetBytesMock,
	getStoredObjectSizeMock,
	uploadAssetBytesMock,
	validateMediaBytesMock,
	withMediaObjectKeyLockMock,
} = vi.hoisted(() => ({
	requireSessionMock: vi.fn(),
	userInProjectMock: vi.fn(),
	canonicalizePendingAssetForActorMock: vi.fn(),
	deletePendingAssetForActorMock: vi.fn(),
	findReadyAssetByProjectAndHashMock: vi.fn(),
	loadAssetByIdMock: vi.fn(),
	publishPendingAssetForActorMock: vi.fn(),
	purgeExpiredMediaUploadAliasesMock: vi.fn(),
	resolveReadyUploadAliasForActorMock: vi.fn(),
	cleanupReleasedAssetStorageMock: vi.fn(() => Promise.resolve()),
	cleanupUnpublishedAssetObjectMock: vi.fn(() => Promise.resolve()),
	copyAssetObjectMock: vi.fn(() => Promise.resolve()),
	downloadAssetBytesMock: vi.fn(),
	getStoredObjectSizeMock: vi.fn(),
	uploadAssetBytesMock: vi.fn(() => Promise.resolve()),
	validateMediaBytesMock: vi.fn(),
	withMediaObjectKeyLockMock: vi.fn(
		async (_key: string, body: (lockedDb: unknown) => Promise<unknown>) =>
			body({ pinned: true }),
	),
}));

vi.mock("@/lib/auth-utils", () => ({ requireSession: requireSessionMock }));
vi.mock("@/lib/db/appAccess", () => ({ userInProject: userInProjectMock }));
vi.mock("@/lib/db/mediaAssets", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/lib/db/mediaAssets")>();
	return {
		...actual,
		canonicalizePendingAssetForActor: canonicalizePendingAssetForActorMock,
		deletePendingAssetForActor: deletePendingAssetForActorMock,
		findReadyAssetByProjectAndHash: findReadyAssetByProjectAndHashMock,
		loadAssetById: loadAssetByIdMock,
		publishPendingAssetForActor: publishPendingAssetForActorMock,
		purgeExpiredMediaUploadAliases: purgeExpiredMediaUploadAliasesMock,
		resolveReadyUploadAliasForActor: resolveReadyUploadAliasForActorMock,
		toWireMediaAsset: vi.fn((asset: MediaAssetRecord) => ({
			id: asset.id,
			status: asset.status,
			gcsObjectKey: asset.gcsObjectKey,
		})),
	};
});
vi.mock("@/lib/storage/media", () => ({
	copyAssetObject: copyAssetObjectMock,
	downloadAssetBytes: downloadAssetBytesMock,
	getStoredObjectSize: getStoredObjectSizeMock,
	uploadAssetBytes: uploadAssetBytesMock,
}));
vi.mock("@/lib/media/assetDeletion", () => ({
	cleanupReleasedAssetStorage: cleanupReleasedAssetStorageMock,
	cleanupUnpublishedAssetObject: cleanupUnpublishedAssetObjectMock,
}));
vi.mock("@/lib/media/validate", () => ({
	validateMediaBytes: validateMediaBytesMock,
}));
vi.mock("@/lib/storage/mediaObjectKeyLock", () => ({
	withMediaObjectKeyLock: withMediaObjectKeyLockMock,
}));

function pendingAsset(
	overrides: Partial<MediaAssetRecord> = {},
): MediaAssetRecord {
	return {
		id: "asset-1",
		owner: "user-1",
		project_id: "project-1",
		contentHash: HASH,
		mimeType: "image/png",
		kind: "image",
		extension: ".png",
		sizeBytes: 10,
		gcsObjectKey: "pending/project-1/asset-1.png",
		originalFilename: "logo.png",
		displayName: "logo.png",
		status: "pending",
		...overrides,
	} as MediaAssetRecord;
}

function callConfirm() {
	return POST({} as Parameters<typeof POST>[0], {
		params: Promise.resolve({ assetId: "asset-1" }),
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(requireSession).mockResolvedValue({
		user: { id: "user-1" },
	} as never);
	vi.mocked(userInProject).mockResolvedValue(true);
	vi.mocked(loadAssetById).mockResolvedValue(pendingAsset());
	vi.mocked(resolveReadyUploadAliasForActor).mockResolvedValue(null);
	vi.mocked(getStoredObjectSize).mockResolvedValue(10);
	copyAssetObjectMock.mockResolvedValue(undefined);
	vi.mocked(downloadAssetBytes).mockResolvedValue(Buffer.from("bytes"));
	vi.mocked(uploadAssetBytes).mockResolvedValue(undefined);
	vi.mocked(findReadyAssetByProjectAndHash).mockResolvedValue(null);
	vi.mocked(canonicalizePendingAssetForActor).mockResolvedValue({
		kind: "not_found",
	});
	vi.mocked(deletePendingAssetForActor).mockResolvedValue({
		kind: "deleted",
		asset: pendingAsset(),
	});
	vi.mocked(publishPendingAssetForActor).mockResolvedValue({
		kind: "published",
		asset: pendingAsset({
			status: "ready",
			gcsObjectKey: `projects/project-1/${HASH}.png`,
		}),
	});
	vi.mocked(purgeExpiredMediaUploadAliases).mockResolvedValue(0);
	vi.mocked(validateMediaBytes).mockResolvedValue({
		ok: true,
		validated: {
			contentHash: HASH,
			mimeType: "image/png",
			extension: ".png",
			sizeBytes: 10,
			kind: "image",
			dimensions: { width: 1, height: 1 },
		},
	});
});

describe("POST /api/media/upload/[assetId]/confirm", () => {
	it("publishes the exact validated bytes even if the pending object is overwritten afterward", async () => {
		let pendingGeneration = Buffer.alloc(10, 1);
		let publishedBytes: Buffer | null = null;
		vi.mocked(downloadAssetBytes).mockImplementation(async () =>
			Buffer.from(pendingGeneration),
		);
		vi.mocked(validateMediaBytes).mockImplementation(async ({ bytes }) => {
			expect(bytes).toEqual(Buffer.alloc(10, 1));
			// The signed URL remains usable while confirm runs. Model a hostile
			// overwrite immediately after generation A passes validation.
			pendingGeneration = Buffer.alloc(10, 2);
			return {
				ok: true,
				validated: {
					contentHash: HASH,
					mimeType: "image/png",
					extension: ".png",
					sizeBytes: 10,
					kind: "image",
					dimensions: { width: 1, height: 1 },
				},
			};
		});
		vi.mocked(uploadAssetBytes).mockImplementation(async ({ bytes }) => {
			publishedBytes = Buffer.from(bytes);
		});
		copyAssetObjectMock.mockImplementation(async () => {
			publishedBytes = Buffer.from(pendingGeneration);
		});

		const res = await callConfirm();
		const body = (await res.json()) as { asset: { gcsObjectKey: string } };

		expect(res.status).toBe(200);
		expect(pendingGeneration).toEqual(Buffer.alloc(10, 2));
		expect(publishedBytes).toEqual(Buffer.alloc(10, 1));
		expect(copyAssetObjectMock).not.toHaveBeenCalled();
		expect(uploadAssetBytes).toHaveBeenCalledWith({
			gcsObjectKey: `projects/project-1/${HASH}.png`,
			bytes: expect.any(Buffer),
			contentType: "image/png",
		});
		expect(publishPendingAssetForActor).toHaveBeenCalledWith(
			{
				assetId: "asset-1",
				actorUserId: "user-1",
				expectedProjectId: "project-1",
				gcsObjectKey: `projects/project-1/${HASH}.png`,
				// The confirm step writes the validator's authoritative
				// mimeType/extension (refines a document's create-time guess;
				// a no-op for media).
				mimeType: "image/png",
				extension: ".png",
				dimensions: { width: 1, height: 1 },
				durationMs: undefined,
			},
			expect.anything(),
		);
		expect(cleanupReleasedAssetStorage).toHaveBeenCalledWith(
			expect.objectContaining({
				id: "asset-1",
				gcsObjectKey: "pending/project-1/asset-1.png",
			}),
		);
		expect(body.asset.gcsObjectKey).toBe(`projects/project-1/${HASH}.png`);
		expect(withMediaObjectKeyLockMock).toHaveBeenNthCalledWith(
			1,
			`projects/project-1/${HASH}.png`,
			expect.any(Function),
		);
	});

	it("returns the ready row when a lagging download loses to winner cleanup", async () => {
		const ready = pendingAsset({
			status: "ready",
			gcsObjectKey: `projects/project-1/${HASH}.png`,
		});
		let loadCount = 0;
		vi.mocked(loadAssetById).mockImplementation(async () => {
			loadCount += 1;
			return loadCount === 1 ? pendingAsset() : ready;
		});
		vi.mocked(downloadAssetBytes).mockRejectedValue(
			Object.assign(new Error("No such object"), { code: 404 }),
		);

		const res = await callConfirm();
		const body = (await res.json()) as {
			asset: { id: string; status: string; gcsObjectKey: string };
		};

		expect(res.status).toBe(200);
		expect(body.asset).toEqual({
			id: "asset-1",
			status: "ready",
			gcsObjectKey: `projects/project-1/${HASH}.png`,
		});
		expect(loadAssetById).toHaveBeenCalledTimes(2);
		expect(userInProject).toHaveBeenCalledTimes(2);
		expect(validateMediaBytes).not.toHaveBeenCalled();
		expect(uploadAssetBytes).not.toHaveBeenCalled();
		expect(publishPendingAssetForActor).not.toHaveBeenCalled();
	});

	it("replays a lost successful response by the original attempt id", async () => {
		const canonical = pendingAsset({
			id: asAssetId("asset-canonical"),
			status: "ready",
			gcsObjectKey: `projects/project-1/${HASH}.png`,
		});
		vi.mocked(loadAssetById).mockResolvedValue(null);
		vi.mocked(resolveReadyUploadAliasForActor).mockResolvedValue(canonical);

		const res = await callConfirm();
		const body = (await res.json()) as {
			asset: { id: string; status: string; gcsObjectKey: string };
		};

		expect(res.status).toBe(200);
		expect(body.asset).toEqual({
			id: "asset-canonical",
			status: "ready",
			gcsObjectKey: `projects/project-1/${HASH}.png`,
		});
		expect(resolveReadyUploadAliasForActor).toHaveBeenCalledWith({
			attemptAssetId: "asset-1",
			actorUserId: "user-1",
		});
		expect(userInProject).not.toHaveBeenCalled();
		expect(getStoredObjectSize).not.toHaveBeenCalled();
	});

	it("returns the canonical sibling when winner cleanup removes the pending bytes and row", async () => {
		const sibling = pendingAsset({
			id: asAssetId("asset-canonical"),
			status: "ready",
			gcsObjectKey: `projects/project-1/${HASH}.png`,
		});
		let loadCount = 0;
		vi.mocked(loadAssetById).mockImplementation(async () => {
			loadCount += 1;
			return loadCount === 1 ? pendingAsset() : null;
		});
		vi.mocked(resolveReadyUploadAliasForActor).mockResolvedValue(sibling);
		vi.mocked(downloadAssetBytes).mockRejectedValue(
			Object.assign(new Error("No such object"), { code: 404 }),
		);

		const res = await callConfirm();
		const body = (await res.json()) as {
			asset: { id: string; status: string; gcsObjectKey: string };
		};

		expect(res.status).toBe(200);
		expect(body.asset).toEqual({
			id: "asset-canonical",
			status: "ready",
			gcsObjectKey: `projects/project-1/${HASH}.png`,
		});
		expect(resolveReadyUploadAliasForActor).toHaveBeenCalledWith({
			attemptAssetId: "asset-1",
			actorUserId: "user-1",
		});
		expect(findReadyAssetByProjectAndHash).not.toHaveBeenCalled();
		expect(userInProject).toHaveBeenCalledOnce();
		expect(validateMediaBytes).not.toHaveBeenCalled();
		expect(deletePendingAssetForActor).not.toHaveBeenCalled();
	});

	it("deletes only a freshly-locked pending row after validation fails", async () => {
		vi.mocked(loadAssetById).mockResolvedValue(
			pendingAsset({ gcsObjectKey: `projects/project-1/${HASH}.png` }),
		);
		vi.mocked(validateMediaBytes).mockResolvedValue({
			ok: false,
			reason: "hash-claim-mismatch",
			message: "The uploaded file did not match the declared hash.",
		});

		const res = await callConfirm();
		await res.json();

		expect(res.status).toBe(400);
		expect(deletePendingAssetForActor).toHaveBeenCalledWith({
			assetId: "asset-1",
			actorUserId: "user-1",
			expectedProjectId: "project-1",
		});
		expect(cleanupReleasedAssetStorage).toHaveBeenCalledOnce();
	});

	it("returns ready when a stale validation rejection loses to publication", async () => {
		const ready = pendingAsset({
			status: "ready",
			gcsObjectKey: `projects/project-1/${HASH}.png`,
		});
		vi.mocked(validateMediaBytes).mockResolvedValue({
			ok: false,
			reason: "hash-claim-mismatch",
			message: "The uploaded file did not match the declared hash.",
		});
		vi.mocked(deletePendingAssetForActor).mockResolvedValue({
			kind: "already_ready",
			asset: ready,
		});

		const res = await callConfirm();
		const body = (await res.json()) as { asset: { status: string } };

		expect(res.status).toBe(200);
		expect(body.asset.status).toBe("ready");
		expect(cleanupReleasedAssetStorage).not.toHaveBeenCalled();
		expect(publishPendingAssetForActor).not.toHaveBeenCalled();
	});

	it("collapses a confirm race under the final-key lock and cleans only the losing pending object", async () => {
		const sibling = pendingAsset({
			id: asAssetId("asset-winner"),
			status: "ready",
			gcsObjectKey: `projects/project-1/${HASH}.png`,
		});
		vi.mocked(findReadyAssetByProjectAndHash).mockResolvedValue(sibling);
		vi.mocked(canonicalizePendingAssetForActor).mockResolvedValue({
			kind: "canonicalized",
			asset: sibling,
			releasedPending: pendingAsset(),
		});

		const res = await callConfirm();
		const body = (await res.json()) as { asset: { id: string } };

		expect(res.status).toBe(200);
		expect(body.asset.id).toBe("asset-winner");
		expect(canonicalizePendingAssetForActor).toHaveBeenCalledWith(
			{
				attemptAssetId: "asset-1",
				canonicalAssetId: "asset-winner",
				actorUserId: "user-1",
				expectedProjectId: "project-1",
				expectedContentHash: HASH,
			},
			expect.anything(),
		);
		expect(deletePendingAssetForActor).not.toHaveBeenCalled();
		expect(uploadAssetBytes).not.toHaveBeenCalled();
		expect(publishPendingAssetForActor).not.toHaveBeenCalled();
		expect(purgeExpiredMediaUploadAliases).toHaveBeenCalledOnce();
		expect(cleanupReleasedAssetStorage).toHaveBeenCalledWith(
			expect.objectContaining({
				id: "asset-1",
				gcsObjectKey: "pending/project-1/asset-1.png",
			}),
		);
	});

	it("returns the canonical sibling when another confirm of the same pending ID already released its row", async () => {
		const sibling = pendingAsset({
			id: asAssetId("asset-canonical"),
			status: "ready",
			gcsObjectKey: `projects/project-1/${HASH}.png`,
		});
		vi.mocked(findReadyAssetByProjectAndHash).mockResolvedValue(sibling);
		vi.mocked(canonicalizePendingAssetForActor).mockResolvedValue({
			kind: "already_canonical",
			asset: sibling,
		});

		const res = await callConfirm();
		const body = (await res.json()) as {
			asset: { id: string; status: string; gcsObjectKey: string };
		};

		expect(res.status).toBe(200);
		expect(body.asset).toEqual({
			id: "asset-canonical",
			status: "ready",
			gcsObjectKey: `projects/project-1/${HASH}.png`,
		});
		expect(canonicalizePendingAssetForActor).toHaveBeenCalledOnce();
		expect(deletePendingAssetForActor).not.toHaveBeenCalled();
		expect(userInProject).toHaveBeenCalledOnce();
		expect(uploadAssetBytes).not.toHaveBeenCalled();
		expect(cleanupReleasedAssetStorage).not.toHaveBeenCalled();
		expect(purgeExpiredMediaUploadAliases).not.toHaveBeenCalled();
	});

	it("does not return a canonical sibling when durable canonicalization rejects authority", async () => {
		const sibling = pendingAsset({
			id: asAssetId("asset-canonical"),
			status: "ready",
			gcsObjectKey: `projects/project-1/${HASH}.png`,
		});
		vi.mocked(findReadyAssetByProjectAndHash).mockResolvedValue(sibling);
		vi.mocked(canonicalizePendingAssetForActor).mockResolvedValue({
			kind: "not_found",
		});

		const res = await callConfirm();
		await res.json();

		expect(res.status).toBe(404);
		expect(canonicalizePendingAssetForActor).toHaveBeenCalledOnce();
		expect(cleanupReleasedAssetStorage).not.toHaveBeenCalled();
	});

	it("returns the same ready asset when a same-ID confirm loses under the final-key lock", async () => {
		const ready = pendingAsset({
			status: "ready",
			gcsObjectKey: `projects/project-1/${HASH}.png`,
		});
		vi.mocked(findReadyAssetByProjectAndHash).mockResolvedValue(ready);

		const res = await callConfirm();
		const body = (await res.json()) as {
			asset: { id: string; status: string; gcsObjectKey: string };
		};

		expect(res.status).toBe(200);
		expect(body.asset).toEqual({
			id: "asset-1",
			status: "ready",
			gcsObjectKey: `projects/project-1/${HASH}.png`,
		});
		expect(uploadAssetBytes).not.toHaveBeenCalled();
		expect(publishPendingAssetForActor).toHaveBeenCalledWith(
			{
				assetId: "asset-1",
				actorUserId: "user-1",
				expectedProjectId: "project-1",
				gcsObjectKey: `projects/project-1/${HASH}.png`,
				mimeType: "image/png",
				extension: ".png",
				dimensions: { width: 1, height: 1 },
				durationMs: undefined,
			},
			expect.anything(),
		);
		expect(deletePendingAssetForActor).not.toHaveBeenCalled();
		expect(cleanupReleasedAssetStorage).not.toHaveBeenCalled();
	});

	it("rejects a same-ID race after fresh edit authority is lost", async () => {
		vi.mocked(findReadyAssetByProjectAndHash).mockResolvedValue(
			pendingAsset({
				status: "ready",
				gcsObjectKey: `projects/project-1/${HASH}.png`,
			}),
		);
		vi.mocked(publishPendingAssetForActor).mockResolvedValue({
			kind: "not_found",
		});

		const res = await callConfirm();
		await res.json();

		expect(res.status).toBe(404);
		expect(publishPendingAssetForActor).toHaveBeenCalledOnce();
		expect(uploadAssetBytes).not.toHaveBeenCalled();
		expect(cleanupReleasedAssetStorage).not.toHaveBeenCalled();
	});

	it("cleans the written final object when fresh publication loses", async () => {
		vi.mocked(publishPendingAssetForActor).mockResolvedValue({
			kind: "not_found",
		});

		const res = await callConfirm();
		await res.json();

		expect(res.status).toBe(404);
		expect(uploadAssetBytes).toHaveBeenCalledOnce();
		expect(cleanupUnpublishedAssetObject).toHaveBeenCalledWith(
			`projects/project-1/${HASH}.png`,
		);
		expect(cleanupReleasedAssetStorage).not.toHaveBeenCalled();
	});
});
