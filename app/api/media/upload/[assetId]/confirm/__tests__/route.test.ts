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
	confirmAssetReady,
	deleteAsset as deleteAssetRow,
	findReadyAssetByProjectAndHash,
	hasOtherAssetForGcsObjectKey,
	loadAssetById,
	type MediaAssetRecord,
} from "@/lib/db/mediaAssets";
import { asAssetId } from "@/lib/domain/multimedia";
import { validateMediaBytes } from "@/lib/media/validate";
import {
	copyAssetObject,
	deleteAsset as deleteGcsObject,
	downloadAssetBytes,
	getStoredObjectSize,
} from "@/lib/storage/media";
import { POST } from "../route";

const HASH = "b".repeat(64);

const {
	requireSessionMock,
	userInProjectMock,
	confirmAssetReadyMock,
	deleteAssetRowMock,
	findReadyAssetByProjectAndHashMock,
	hasOtherAssetForGcsObjectKeyMock,
	loadAssetByIdMock,
	copyAssetObjectMock,
	deleteGcsObjectMock,
	downloadAssetBytesMock,
	getStoredObjectSizeMock,
	validateMediaBytesMock,
	withMediaObjectKeyLockMock,
} = vi.hoisted(() => ({
	requireSessionMock: vi.fn(),
	userInProjectMock: vi.fn(),
	confirmAssetReadyMock: vi.fn(() => Promise.resolve()),
	deleteAssetRowMock: vi.fn(() => Promise.resolve()),
	findReadyAssetByProjectAndHashMock: vi.fn(),
	hasOtherAssetForGcsObjectKeyMock: vi.fn(),
	loadAssetByIdMock: vi.fn(),
	copyAssetObjectMock: vi.fn(() => Promise.resolve()),
	deleteGcsObjectMock: vi.fn(() => Promise.resolve()),
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
		confirmAssetReady: confirmAssetReadyMock,
		deleteAsset: deleteAssetRowMock,
		findReadyAssetByProjectAndHash: findReadyAssetByProjectAndHashMock,
		hasOtherAssetForGcsObjectKey: hasOtherAssetForGcsObjectKeyMock,
		loadAssetById: loadAssetByIdMock,
		toWireMediaAsset: vi.fn((asset: MediaAssetRecord) => ({
			id: asset.id,
			status: asset.status,
			gcsObjectKey: asset.gcsObjectKey,
		})),
	};
});
vi.mock("@/lib/storage/media", () => ({
	copyAssetObject: copyAssetObjectMock,
	deleteAsset: deleteGcsObjectMock,
	downloadAssetBytes: downloadAssetBytesMock,
	getStoredObjectSize: getStoredObjectSizeMock,
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
	vi.mocked(hasOtherAssetForGcsObjectKey).mockResolvedValue(false);
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
		expect(confirmAssetReady).toHaveBeenCalledWith(
			{
				assetId: "asset-1",
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
		expect(deleteGcsObject).toHaveBeenCalledWith(
			"pending/project-1/asset-1.png",
		);
		expect(body.asset.gcsObjectKey).toBe(`projects/project-1/${HASH}.png`);
		expect(withMediaObjectKeyLockMock).toHaveBeenNthCalledWith(
			1,
			`projects/project-1/${HASH}.png`,
			expect.any(Function),
		);
		expect(withMediaObjectKeyLockMock).toHaveBeenNthCalledWith(
			2,
			"pending/project-1/asset-1.png",
			expect.any(Function),
		);
	});

	it("does not delete a validation-failed object when another row shares it", async () => {
		vi.mocked(loadAssetById).mockResolvedValue(
			pendingAsset({ gcsObjectKey: `projects/project-1/${HASH}.png` }),
		);
		vi.mocked(hasOtherAssetForGcsObjectKey).mockResolvedValue(true);
		vi.mocked(validateMediaBytes).mockResolvedValue({
			ok: false,
			reason: "hash-claim-mismatch",
			message: "The uploaded file did not match the declared hash.",
		});

		const res = await callConfirm();
		await res.json();

		expect(res.status).toBe(400);
		expect(deleteAssetRow).toHaveBeenCalledWith("asset-1");
		expect(deleteGcsObject).not.toHaveBeenCalled();
	});

	it("collapses a confirm race under the final-key lock and cleans only the losing pending object", async () => {
		const sibling = pendingAsset({
			id: asAssetId("asset-winner"),
			status: "ready",
			gcsObjectKey: `projects/project-1/${HASH}.png`,
		});
		vi.mocked(findReadyAssetByProjectAndHash).mockResolvedValue(sibling);

		const res = await callConfirm();
		const body = (await res.json()) as { asset: { id: string } };

		expect(res.status).toBe(200);
		expect(body.asset.id).toBe("asset-winner");
		expect(deleteAssetRow).toHaveBeenCalledWith("asset-1", expect.anything());
		expect(copyAssetObject).not.toHaveBeenCalled();
		expect(confirmAssetReady).not.toHaveBeenCalled();
		expect(deleteGcsObject).toHaveBeenCalledWith(
			"pending/project-1/asset-1.png",
		);
	});
});
