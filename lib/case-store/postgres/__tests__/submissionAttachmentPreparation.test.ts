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
		vi.clearAllMocks();
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
		await expect(prepareCaptureSubmissionBytes(args)).resolves.toBeUndefined();

		expect(mocks.begin.mock.invocationCallOrder[0]).toBeLessThan(
			mocks.prepare.mock.invocationCallOrder[0] ?? Infinity,
		);
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

	it("rejects before case acceptance when durable preparation did not settle", async () => {
		mocks.prepare.mockResolvedValue({
			prepared: 0,
			discarded: 0,
			failed: 1,
		});
		mocks.ready.mockResolvedValue(false);

		await expect(prepareCaptureSubmissionBytes(args)).rejects.toBeInstanceOf(
			CaptureSubmissionRejectedError,
		);
	});

	it("succeeds when the user retries after a first preparation failure", async () => {
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
