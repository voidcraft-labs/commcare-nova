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
import {
	confirmAssetReady,
	deleteAsset as deleteAssetRow,
	findReadyAssetByOwnerAndHash,
	hasOtherAssetForGcsObjectKey,
	loadAssetForOwner,
	type MediaAssetRecord,
} from "@/lib/db/mediaAssets";
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
	confirmAssetReadyMock,
	deleteAssetRowMock,
	findReadyAssetByOwnerAndHashMock,
	hasOtherAssetForGcsObjectKeyMock,
	loadAssetForOwnerMock,
	copyAssetObjectMock,
	deleteGcsObjectMock,
	downloadAssetBytesMock,
	getStoredObjectSizeMock,
	validateMediaBytesMock,
} = vi.hoisted(() => ({
	requireSessionMock: vi.fn(),
	confirmAssetReadyMock: vi.fn(() => Promise.resolve()),
	deleteAssetRowMock: vi.fn(() => Promise.resolve()),
	findReadyAssetByOwnerAndHashMock: vi.fn(),
	hasOtherAssetForGcsObjectKeyMock: vi.fn(),
	loadAssetForOwnerMock: vi.fn(),
	copyAssetObjectMock: vi.fn(() => Promise.resolve()),
	deleteGcsObjectMock: vi.fn(() => Promise.resolve()),
	downloadAssetBytesMock: vi.fn(),
	getStoredObjectSizeMock: vi.fn(),
	validateMediaBytesMock: vi.fn(),
}));

vi.mock("@/lib/auth-utils", () => ({ requireSession: requireSessionMock }));
vi.mock("@/lib/db/mediaAssets", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/lib/db/mediaAssets")>();
	return {
		...actual,
		confirmAssetReady: confirmAssetReadyMock,
		deleteAsset: deleteAssetRowMock,
		findReadyAssetByOwnerAndHash: findReadyAssetByOwnerAndHashMock,
		hasOtherAssetForGcsObjectKey: hasOtherAssetForGcsObjectKeyMock,
		loadAssetForOwner: loadAssetForOwnerMock,
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

function pendingAsset(
	overrides: Partial<MediaAssetRecord> = {},
): MediaAssetRecord {
	return {
		id: "asset-1",
		owner: "user-1",
		contentHash: HASH,
		mimeType: "image/png",
		kind: "image",
		extension: ".png",
		sizeBytes: 10,
		gcsObjectKey: "pending/user-1/asset-1.png",
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
	vi.mocked(loadAssetForOwner).mockResolvedValue(pendingAsset());
	vi.mocked(getStoredObjectSize).mockResolvedValue(10);
	vi.mocked(downloadAssetBytes).mockResolvedValue(Buffer.from("bytes"));
	vi.mocked(findReadyAssetByOwnerAndHash).mockResolvedValue(null);
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
			"pending/user-1/asset-1.png",
			`users/user-1/${HASH}.png`,
		);
		expect(confirmAssetReady).toHaveBeenCalledWith({
			assetId: "asset-1",
			gcsObjectKey: `users/user-1/${HASH}.png`,
			// The confirm step writes the validator's authoritative
			// mimeType/extension (refines a document's create-time guess;
			// a no-op for media).
			mimeType: "image/png",
			extension: ".png",
			dimensions: { width: 1, height: 1 },
			durationMs: undefined,
		});
		expect(deleteGcsObject).toHaveBeenCalledWith("pending/user-1/asset-1.png");
		expect(body.asset.gcsObjectKey).toBe(`users/user-1/${HASH}.png`);
	});

	it("does not delete a validation-failed object when another row shares it", async () => {
		vi.mocked(loadAssetForOwner).mockResolvedValue(
			pendingAsset({ gcsObjectKey: `users/user-1/${HASH}.png` }),
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
});
