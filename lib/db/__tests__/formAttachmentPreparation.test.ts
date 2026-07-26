import { beforeEach, describe, expect, it, vi } from "vitest";
import { preparePendingFormAttachments } from "../formAttachmentPreparation";
import type { FormAttachmentRecord } from "../formAttachments";

const mocks = vi.hoisted(() => ({
	claim: vi.fn(),
	completePreparation: vi.fn(),
	completeDiscard: vi.fn(),
	recordFailure: vi.fn(),
	copy: vi.fn(),
	deleteGeneration: vi.fn(),
	getMetadata: vi.fn(),
	error: vi.fn(),
	critical: vi.fn(),
}));

vi.mock("../formAttachments", () => ({
	claimFormAttachmentPreparations: mocks.claim,
	completeFormAttachmentPreparation: mocks.completePreparation,
	completeFormAttachmentDiscard: mocks.completeDiscard,
	recordFormAttachmentPreparationFailure: mocks.recordFailure,
}));

vi.mock("@/lib/storage/media", () => ({
	copyAssetObjectIfAbsent: mocks.copy,
	deleteAssetGeneration: mocks.deleteGeneration,
	getStoredObjectMetadata: mocks.getMetadata,
}));

vi.mock("@/lib/logger", () => ({
	log: {
		error: mocks.error,
		critical: mocks.critical,
	},
}));

const candidate: FormAttachmentRecord = {
	attachmentId: "11111111-1111-4111-8111-111111111111",
	attachmentName: "photo.jpg",
	appId: "app-1",
	projectId: "project-1",
	createdBy: "user-1",
	entryKey: "22222222-2222-4222-8222-222222222222",
	fieldUuid: "33333333-3333-4333-8333-333333333333",
	instancePath: "/data/photo",
	originalFilename: "photo.jpg",
	extension: ".jpg",
	contentType: "image/jpeg",
	sizeBytes: 5,
	gcsObjectKey:
		"captures-staged/project-1/11111111-1111-4111-8111-111111111111.jpg",
	objectGeneration: "17",
	objectChecksum: "crc32c",
	preparedGeneration: null,
	status: "preparing",
};

const durableKey =
	"projects/project-1/captures/11111111-1111-4111-8111-111111111111.jpg";

describe("preparePendingFormAttachments", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.claim.mockResolvedValue([candidate]);
		mocks.copy.mockResolvedValue({
			destinationGeneration: "23",
			replay: false,
		});
		mocks.completePreparation.mockResolvedValue({
			...candidate,
			status: "prepared",
			preparedGeneration: "23",
		});
		mocks.completeDiscard.mockResolvedValue(true);
		mocks.deleteGeneration.mockResolvedValue(undefined);
		mocks.getMetadata.mockResolvedValue(null);
	});

	it("copies and verifies selected immutable bytes before marking them prepared", async () => {
		await expect(
			preparePendingFormAttachments({
				appId: candidate.appId,
				entryKey: candidate.entryKey,
				actorUserId: candidate.createdBy,
				projectId: candidate.projectId,
				attachmentIds: [candidate.attachmentId],
				limit: 7,
			}),
		).resolves.toEqual({ prepared: 1, discarded: 0, failed: 0 });

		expect(mocks.claim).toHaveBeenCalledWith({
			appId: candidate.appId,
			entryKey: candidate.entryKey,
			actorUserId: candidate.createdBy,
			expectedProjectId: candidate.projectId,
			attachmentIds: [candidate.attachmentId],
			limit: 7,
		});
		expect(mocks.copy).toHaveBeenCalledWith({
			sourceGcsObjectKey: candidate.gcsObjectKey,
			sourceGeneration: "17",
			destinationGcsObjectKey: durableKey,
			expectedSize: 5,
			expectedChecksum: "crc32c",
			expectedContentType: "image/jpeg",
		});
		expect(mocks.completePreparation).toHaveBeenCalledWith(
			candidate.attachmentId,
			"23",
		);
		expect(mocks.deleteGeneration).not.toHaveBeenCalled();
	});

	it("finishes exact cleanup when Clear wins while the copy is in flight", async () => {
		mocks.completePreparation.mockResolvedValue({
			...candidate,
			status: "discarding",
			preparedGeneration: "23",
		});

		await expect(preparePendingFormAttachments()).resolves.toEqual({
			prepared: 0,
			discarded: 1,
			failed: 0,
		});

		expect(mocks.deleteGeneration).toHaveBeenNthCalledWith(1, durableKey, "23");
		expect(mocks.deleteGeneration).toHaveBeenNthCalledWith(
			2,
			candidate.gcsObjectKey,
			"17",
		);
		expect(mocks.completeDiscard).toHaveBeenCalledWith(
			candidate.attachmentId,
			"23",
		);
	});

	it("recovers a crash-before-row-update discard from verified destination metadata", async () => {
		mocks.claim.mockResolvedValue([
			{ ...candidate, status: "discarding", preparedGeneration: null },
		]);
		mocks.getMetadata.mockResolvedValue({
			size: 5,
			generation: "23",
			checksum: "crc32c",
			contentType: "image/jpeg",
		});

		await expect(preparePendingFormAttachments()).resolves.toEqual({
			prepared: 0,
			discarded: 1,
			failed: 0,
		});

		expect(mocks.copy).not.toHaveBeenCalled();
		expect(mocks.deleteGeneration).toHaveBeenNthCalledWith(1, durableKey, "23");
		expect(mocks.deleteGeneration).toHaveBeenNthCalledWith(
			2,
			candidate.gcsObjectKey,
			"17",
		);
		expect(mocks.completeDiscard).toHaveBeenCalledWith(
			candidate.attachmentId,
			null,
		);
	});

	it("keeps preparation retryable and escalates repeated failures", async () => {
		const copyError = new Error("copy unavailable");
		mocks.copy.mockRejectedValue(copyError);
		mocks.recordFailure.mockResolvedValue(10);

		await expect(preparePendingFormAttachments()).resolves.toEqual({
			prepared: 0,
			discarded: 0,
			failed: 1,
		});

		expect(mocks.completePreparation).not.toHaveBeenCalled();
		expect(mocks.recordFailure).toHaveBeenCalledWith(
			candidate.attachmentId,
			copyError,
		);
		expect(mocks.critical).toHaveBeenCalledWith(
			"[attachments] durable preparation repeatedly failed",
			expect.objectContaining({
				err: copyError,
				attachmentId: candidate.attachmentId,
				attempts: 10,
				status: "preparing",
			}),
		);
	});
});
