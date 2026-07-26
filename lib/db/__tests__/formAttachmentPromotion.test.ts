import { beforeEach, describe, expect, it, vi } from "vitest";
import { promotePendingFormAttachments } from "../formAttachmentPromotion";
import type { FormAttachmentRecord } from "../formAttachments";

const mocks = vi.hoisted(() => ({
	claim: vi.fn(),
	complete: vi.fn(),
	recordFailure: vi.fn(),
	copy: vi.fn(),
	deleteGeneration: vi.fn(),
	error: vi.fn(),
	critical: vi.fn(),
	warn: vi.fn(),
}));

vi.mock("../formAttachments", () => ({
	claimFormAttachmentPromotions: mocks.claim,
	completeFormAttachmentPromotion: mocks.complete,
	recordFormAttachmentPromotionFailure: mocks.recordFailure,
}));

vi.mock("@/lib/storage/media", () => ({
	copyAssetObjectIfAbsent: mocks.copy,
	deleteAssetGeneration: mocks.deleteGeneration,
}));

vi.mock("@/lib/logger", () => ({
	log: {
		error: mocks.error,
		critical: mocks.critical,
		warn: mocks.warn,
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
	status: "promotion_pending",
};

describe("promotePendingFormAttachments", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.claim.mockResolvedValue([candidate]);
		mocks.copy.mockResolvedValue({
			destinationGeneration: "23",
			replay: false,
		});
		mocks.complete.mockResolvedValue({
			...candidate,
			status: "submitted",
			objectGeneration: "23",
		});
		mocks.deleteGeneration.mockResolvedValue(undefined);
	});

	it("copies the claimed immutable generation, commits it, then deletes that exact source", async () => {
		await expect(
			promotePendingFormAttachments({
				appId: candidate.appId,
				entryKey: candidate.entryKey,
				actorUserId: candidate.createdBy,
				projectId: candidate.projectId,
				limit: 7,
			}),
		).resolves.toEqual({ promoted: 1, failed: 0 });

		expect(mocks.claim).toHaveBeenCalledWith({
			appId: candidate.appId,
			entryKey: candidate.entryKey,
			actorUserId: candidate.createdBy,
			expectedProjectId: candidate.projectId,
			limit: 7,
		});
		expect(mocks.copy).toHaveBeenCalledWith({
			sourceGcsObjectKey: candidate.gcsObjectKey,
			sourceGeneration: "17",
			destinationGcsObjectKey:
				"projects/project-1/captures/11111111-1111-4111-8111-111111111111.jpg",
			expectedSize: 5,
			expectedChecksum: "crc32c",
			expectedContentType: "image/jpeg",
		});
		expect(mocks.complete).toHaveBeenCalledWith(candidate.attachmentId, "23");
		expect(mocks.deleteGeneration).toHaveBeenCalledWith(
			candidate.gcsObjectKey,
			"17",
		);
	});

	it("keeps the intent retryable and escalates a repeatedly failing promotion", async () => {
		const copyError = new Error("copy unavailable");
		mocks.copy.mockRejectedValue(copyError);
		mocks.recordFailure.mockResolvedValue(10);

		await expect(promotePendingFormAttachments()).resolves.toEqual({
			promoted: 0,
			failed: 1,
		});

		expect(mocks.complete).not.toHaveBeenCalled();
		expect(mocks.deleteGeneration).not.toHaveBeenCalled();
		expect(mocks.recordFailure).toHaveBeenCalledWith(
			candidate.attachmentId,
			copyError,
		);
		expect(mocks.critical).toHaveBeenCalledWith(
			"[attachments] durable promotion repeatedly failed",
			expect.objectContaining({
				err: copyError,
				attachmentId: candidate.attachmentId,
				attempts: 10,
			}),
		);
	});
});
