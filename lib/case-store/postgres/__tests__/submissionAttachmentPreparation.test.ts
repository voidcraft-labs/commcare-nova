import { beforeEach, describe, expect, it, vi } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { CaptureSubmissionRejectedError } from "../../errors";
import { prepareCaptureSubmissionBytes } from "../submissionAttachments";

const mocks = vi.hoisted(() => ({
	begin: vi.fn(),
	prepare: vi.fn(),
	ready: vi.fn(),
}));

vi.mock("@/lib/db/formAttachments", () => ({
	beginFormAttachmentPreparation: mocks.begin,
	formAttachmentsArePrepared: mocks.ready,
	FormAttachmentWriteRejectedError: class extends Error {},
}));

vi.mock("@/lib/db/formAttachmentPreparation", () => ({
	preparePendingFormAttachments: mocks.prepare,
}));

const args = {
	appId: "app-1",
	projectId: "project-1",
	actorUserId: "user-1",
	intent: {
		entryKey: "11111111-1111-4111-8111-111111111111",
		formUuid: testUuid("22222222-2222-4222-8222-222222222222"),
		expectedAppMutationSeq: 7,
		requestDigest: "digest",
		attachments: [
			{
				attachmentName: "photo.png",
				fieldUuid: testUuid("33333333-3333-4333-8333-333333333333"),
				instancePath: "/data/photo",
			},
		],
		allowedAttachments: [
			{
				fieldUuid: testUuid("33333333-3333-4333-8333-333333333333"),
				instancePathTemplate: "/data/photo",
				captureKind: "image" as const,
				acceptedFormats: [{ extension: ".png", contentType: "image/png" }],
			},
		],
	},
};

describe("prepareCaptureSubmissionBytes", () => {
	beforeEach(() => {
		vi.resetAllMocks();
		mocks.begin.mockResolvedValue({
			kind: "prepare",
			attachmentIds: ["attachment-1"],
		});
		mocks.prepare.mockResolvedValue({
			prepared: 1,
			discarded: 0,
			failed: 0,
		});
		mocks.ready.mockResolvedValue(true);
	});

	it("establishes the DB recovery row before copying and verifies readiness", async () => {
		const recovery = Promise.withResolvers<{
			kind: "prepare";
			attachmentIds: string[];
		}>();
		const copied = Promise.withResolvers<{
			prepared: number;
			discarded: number;
			failed: number;
		}>();
		mocks.begin.mockReturnValue(recovery.promise);
		mocks.prepare.mockReturnValue(copied.promise);
		const work = prepareCaptureSubmissionBytes(args);
		const settled = Promise.allSettled([work]);
		try {
			expect(mocks.prepare).not.toHaveBeenCalled();
			recovery.resolve({ kind: "prepare", attachmentIds: ["attachment-1"] });
			await vi.waitFor(() => expect(mocks.prepare).toHaveBeenCalledTimes(1));
			expect(mocks.ready).not.toHaveBeenCalled();
			copied.resolve({ prepared: 1, discarded: 0, failed: 0 });
			await expect(work).resolves.toBeUndefined();
		} finally {
			recovery.resolve({ kind: "prepare", attachmentIds: ["attachment-1"] });
			copied.resolve({ prepared: 1, discarded: 0, failed: 0 });
			await settled;
		}

		expect(mocks.begin).toHaveBeenCalledWith({
			appId: args.appId,
			projectId: args.projectId,
			actorUserId: args.actorUserId,
			entryKey: args.intent.entryKey,
			formUuid: args.intent.formUuid,
			requestDigest: args.intent.requestDigest,
			attachments: args.intent.attachments,
		});

		expect(mocks.prepare).toHaveBeenCalledWith({
			appId: "app-1",
			projectId: "project-1",
			actorUserId: "user-1",
			entryKey: args.intent.entryKey,
			attachmentIds: ["attachment-1"],
			limit: 1,
		});
		expect(mocks.ready).toHaveBeenCalledWith({
			appId: "app-1",
			projectId: "project-1",
			actorUserId: "user-1",
			entryKey: args.intent.entryKey,
			attachmentIds: ["attachment-1"],
		});
	});

	it("does no object work for an already committed replay", async () => {
		mocks.begin.mockResolvedValue({ kind: "replay" });

		await expect(prepareCaptureSubmissionBytes(args)).resolves.toBeUndefined();
		expect(mocks.prepare).not.toHaveBeenCalled();
		expect(mocks.ready).not.toHaveBeenCalled();
	});

	it("rejects unprepared bytes and accepts a later ready retry", async () => {
		mocks.prepare
			.mockResolvedValueOnce({
				prepared: 0,
				discarded: 0,
				failed: 1,
			})
			.mockResolvedValueOnce({
				prepared: 1,
				discarded: 0,
				failed: 0,
			});
		mocks.ready.mockResolvedValueOnce(false).mockResolvedValueOnce(true);

		await expect(prepareCaptureSubmissionBytes(args)).rejects.toBeInstanceOf(
			CaptureSubmissionRejectedError,
		);
		await expect(prepareCaptureSubmissionBytes(args)).resolves.toBeUndefined();
		expect(mocks.begin).toHaveBeenCalledTimes(2);
		expect(mocks.prepare).toHaveBeenCalledTimes(2);
	});
});
