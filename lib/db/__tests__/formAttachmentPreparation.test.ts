import { beforeEach, describe, expect, it, vi } from "vitest";
import { preparePendingFormAttachments } from "../formAttachmentPreparation";
import type { FormAttachmentRecord } from "../formAttachments";

const mocks = vi.hoisted(() => ({
	claim: vi.fn(),
	completePreparation: vi.fn(),
	completeDiscard: vi.fn(),
	renewDiscard: vi.fn(),
	recordFailure: vi.fn(),
	copy: vi.fn(),
	deleteGeneration: vi.fn(),
	getMetadata: vi.fn(),
	error: vi.fn(),
	critical: vi.fn(),
	warn: vi.fn(),
}));

vi.mock("../formAttachments", () => ({
	claimFormAttachmentPreparations: mocks.claim,
	completeFormAttachmentPreparation: mocks.completePreparation,
	completeFormAttachmentDiscard: mocks.completeDiscard,
	renewFormAttachmentDiscardLease: mocks.renewDiscard,
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
	preparedGeneration: null,
	status: "preparing",
	preparationAttempts: 1,
};

const durableKey =
	"projects/project-1/captures/11111111-1111-4111-8111-111111111111.jpg";

describe("preparePendingFormAttachments", () => {
	beforeEach(() => {
		vi.resetAllMocks();
		mocks.claim.mockResolvedValueOnce([candidate]).mockResolvedValueOnce([]);
		mocks.copy.mockResolvedValue({
			destinationGeneration: "23",
			replay: false,
		});
		mocks.completePreparation.mockResolvedValue({
			kind: "prepared",
			attachment: {
				...candidate,
				status: "prepared",
				preparedGeneration: "23",
			},
		});
		mocks.completeDiscard.mockResolvedValue({ kind: "discarded" });
		mocks.renewDiscard.mockImplementation(
			async (_attachmentId: string, _attempt: number) => ({
				kind: "leased",
				attachment: candidate,
			}),
		);
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
		).resolves.toEqual({
			prepared: 1,
			discarded: 0,
			failed: 0,
			superseded: 0,
		});

		expect(mocks.claim).toHaveBeenCalledWith({
			appId: candidate.appId,
			entryKey: candidate.entryKey,
			actorUserId: candidate.createdBy,
			expectedProjectId: candidate.projectId,
			attachmentIds: [candidate.attachmentId],
			limit: 5,
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
			1,
			"23",
		);
		expect(mocks.deleteGeneration).not.toHaveBeenCalled();
	});

	it("finishes exact cleanup when Clear wins while the copy is in flight", async () => {
		mocks.completePreparation.mockResolvedValue({
			kind: "discarding",
			attachment: {
				...candidate,
				status: "discarding",
				preparedGeneration: "23",
			},
		});
		mocks.renewDiscard.mockResolvedValue({
			kind: "leased",
			attachment: {
				...candidate,
				status: "discarding",
				preparedGeneration: "23",
			},
		});

		await expect(preparePendingFormAttachments()).resolves.toEqual({
			prepared: 0,
			discarded: 1,
			failed: 0,
			superseded: 0,
		});

		expect(mocks.deleteGeneration).toHaveBeenNthCalledWith(1, durableKey, "23");
		expect(mocks.deleteGeneration).toHaveBeenNthCalledWith(
			2,
			candidate.gcsObjectKey,
			"17",
		);
		expect(mocks.completeDiscard).toHaveBeenCalledWith(
			candidate.attachmentId,
			1,
			"23",
		);
	});

	it("recovers a crash-before-row-update discard from verified destination metadata", async () => {
		mocks.claim
			.mockReset()
			.mockResolvedValueOnce([
				{ ...candidate, status: "discarding", preparedGeneration: null },
			])
			.mockResolvedValueOnce([]);
		mocks.renewDiscard.mockResolvedValue({
			kind: "leased",
			attachment: {
				...candidate,
				status: "discarding",
				preparedGeneration: null,
			},
		});
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
			superseded: 0,
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
			1,
			null,
		);
	});

	it("keeps preparation retryable and escalates repeated failures", async () => {
		const copyError = new Error("copy unavailable");
		mocks.copy.mockRejectedValue(copyError);
		mocks.recordFailure.mockResolvedValue({
			kind: "recorded",
			attempts: 10,
		});

		await expect(preparePendingFormAttachments()).resolves.toEqual({
			prepared: 0,
			discarded: 0,
			failed: 1,
			superseded: 0,
		});

		expect(mocks.completePreparation).not.toHaveBeenCalled();
		expect(mocks.recordFailure).toHaveBeenCalledWith(
			candidate.attachmentId,
			1,
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

	it("does not delete a shared durable generation when an expired worker is superseded", async () => {
		mocks.completePreparation.mockResolvedValue({ kind: "superseded" });

		await expect(preparePendingFormAttachments({ limit: 1 })).resolves.toEqual({
			prepared: 0,
			discarded: 0,
			failed: 0,
			superseded: 1,
		});

		expect(mocks.deleteGeneration).not.toHaveBeenCalled();
		expect(mocks.recordFailure).not.toHaveBeenCalled();
	});

	it("re-proves a discard lease before deleting either shared generation", async () => {
		mocks.claim
			.mockReset()
			.mockResolvedValueOnce([
				{
					...candidate,
					status: "discarding",
					preparedGeneration: "23",
				},
			])
			.mockResolvedValueOnce([]);
		mocks.renewDiscard.mockResolvedValue({ kind: "superseded" });

		await expect(preparePendingFormAttachments({ limit: 1 })).resolves.toEqual({
			prepared: 0,
			discarded: 0,
			failed: 0,
			superseded: 1,
		});

		expect(mocks.deleteGeneration).not.toHaveBeenCalled();
		expect(mocks.completeDiscard).not.toHaveBeenCalled();
	});

	it("reports a stale failure without backing off the newer attempt", async () => {
		const copyError = new Error("expired worker failed");
		mocks.copy.mockRejectedValue(copyError);
		mocks.recordFailure.mockResolvedValue({ kind: "superseded" });

		await expect(preparePendingFormAttachments({ limit: 1 })).resolves.toEqual({
			prepared: 0,
			discarded: 0,
			failed: 0,
			superseded: 1,
		});

		expect(mocks.warn).toHaveBeenCalledWith(
			"[attachments] stale preparation failure was not recorded",
			expect.objectContaining({
				attachmentId: candidate.attachmentId,
				preparationAttempt: 1,
				outcome: "superseded",
			}),
		);
		expect(mocks.error).not.toHaveBeenCalledWith(
			"[attachments] durable preparation failed and will retry",
			expect.anything(),
		);
	});

	it("claims just-in-time waves no larger than concurrency and honors the total limit", async () => {
		vi.resetAllMocks();
		let minted = 0;
		mocks.claim.mockImplementation(async ({ limit }: { limit: number }) =>
			Array.from({ length: limit }, () => ({
				...candidate,
				attachmentId: `11111111-1111-4111-8111-${String(++minted).padStart(
					12,
					"0",
				)}`,
			})),
		);
		mocks.copy.mockResolvedValue({
			destinationGeneration: "23",
			replay: false,
		});
		mocks.completePreparation.mockImplementation(
			async (
				attachmentId: string,
				_expectedAttempt: number,
				destinationGeneration: string,
			) => ({
				kind: "prepared",
				attachment: {
					...candidate,
					attachmentId,
					status: "prepared",
					preparedGeneration: destinationGeneration,
				},
			}),
		);

		await expect(preparePendingFormAttachments({ limit: 12 })).resolves.toEqual(
			{
				prepared: 12,
				discarded: 0,
				failed: 0,
				superseded: 0,
			},
		);

		expect(mocks.claim.mock.calls.map(([args]) => args.limit)).toEqual([
			5, 5, 2,
		]);
		expect(mocks.copy).toHaveBeenCalledTimes(12);
	});
});
