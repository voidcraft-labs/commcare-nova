/**
 * `POST /api/media/upload/[assetId]/confirm` — storage lifecycle tests.
 *
 * Confirm is the only place untrusted browser bytes become reusable
 * library bytes. These tests pin the two safety invariants: validation
 * failure never deletes a shared object, and validation success promotes
 * a pending object to the final content-hash key before marking the row
 * ready.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { requireSession } from "@/lib/auth-utils";
import { userInProject } from "@/lib/db/appAccess";
import {
	deletePendingAssetForActor,
	findReadyAssetByProjectAndHash,
	loadAssetById,
	type MediaAssetRecord,
	publishPendingAssetForActor,
} from "@/lib/db/mediaAssets";
import { asAssetId } from "@/lib/domain/multimedia";
import {
	cleanupReleasedAssetStorage,
	cleanupUnpublishedAssetObject,
} from "@/lib/media/assetDeletion";
import { validateMediaBytes } from "@/lib/media/validate";
import {
	copyAssetObject,
	downloadAssetBytes,
	getStoredObjectSize,
} from "@/lib/storage/media";
import { POST } from "../route";

const HASH = "b".repeat(64);

const {
	requireSessionMock,
	userInProjectMock,
	deletePendingAssetForActorMock,
	findReadyAssetByProjectAndHashMock,
	loadAssetByIdMock,
	publishPendingAssetForActorMock,
	cleanupReleasedAssetStorageMock,
	cleanupUnpublishedAssetObjectMock,
	copyAssetObjectMock,
	downloadAssetBytesMock,
	getStoredObjectSizeMock,
	validateMediaBytesMock,
	withMediaObjectKeyLockMock,
} = vi.hoisted(() => ({
	requireSessionMock: vi.fn(),
	userInProjectMock: vi.fn(),
	deletePendingAssetForActorMock: vi.fn(),
	findReadyAssetByProjectAndHashMock: vi.fn(),
	loadAssetByIdMock: vi.fn(),
	publishPendingAssetForActorMock: vi.fn(),
	cleanupReleasedAssetStorageMock: vi.fn(() => Promise.resolve()),
	cleanupUnpublishedAssetObjectMock: vi.fn(() => Promise.resolve()),
	copyAssetObjectMock: vi.fn(() => Promise.resolve()),
	downloadAssetBytesMock: vi.fn(),
	getStoredObjectSizeMock: vi.fn(),
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
		deletePendingAssetForActor: deletePendingAssetForActorMock,
		findReadyAssetByProjectAndHash: findReadyAssetByProjectAndHashMock,
		loadAssetById: loadAssetByIdMock,
		publishPendingAssetForActor: publishPendingAssetForActorMock,
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
	vi.mocked(getStoredObjectSize).mockResolvedValue(10);
	vi.mocked(downloadAssetBytes).mockResolvedValue(Buffer.from("bytes"));
	vi.mocked(findReadyAssetByProjectAndHash).mockResolvedValue(null);
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
	it("promotes validated pending bytes to the final content-hash key before ready", async () => {
		const res = await callConfirm();
		const body = (await res.json()) as { asset: { gcsObjectKey: string } };

		expect(res.status).toBe(200);
		expect(copyAssetObject).toHaveBeenCalledWith(
			"pending/project-1/asset-1.png",
			`projects/project-1/${HASH}.png`,
		);
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
		vi.mocked(deletePendingAssetForActor).mockResolvedValue({
			kind: "deleted",
			asset: pendingAsset(),
		});

		const res = await callConfirm();
		const body = (await res.json()) as { asset: { id: string } };

		expect(res.status).toBe(200);
		expect(body.asset.id).toBe("asset-winner");
		expect(deletePendingAssetForActor).toHaveBeenCalledWith(
			{
				assetId: "asset-1",
				actorUserId: "user-1",
				expectedProjectId: "project-1",
			},
			expect.anything(),
		);
		expect(copyAssetObject).not.toHaveBeenCalled();
		expect(publishPendingAssetForActor).not.toHaveBeenCalled();
		expect(cleanupReleasedAssetStorage).toHaveBeenCalledWith(
			expect.objectContaining({
				id: "asset-1",
				gcsObjectKey: "pending/project-1/asset-1.png",
			}),
		);
	});

	it("cleans the copied final object when fresh publication loses", async () => {
		vi.mocked(publishPendingAssetForActor).mockResolvedValue({
			kind: "not_found",
		});

		const res = await callConfirm();
		await res.json();

		expect(res.status).toBe(404);
		expect(copyAssetObject).toHaveBeenCalledOnce();
		expect(cleanupUnpublishedAssetObject).toHaveBeenCalledWith(
			`projects/project-1/${HASH}.png`,
		);
		expect(cleanupReleasedAssetStorage).not.toHaveBeenCalled();
	});
});
