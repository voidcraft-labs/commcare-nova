import { beforeEach, describe, expect, it, vi } from "vitest";
import { adjudicateSubmissionReceipt } from "@/lib/case-store";
import { asUuid } from "@/lib/domain";
import { buildDoc, f } from "../../../__tests__/docHelpers";
import type { SubmissionMutation } from "../caseDataBindingTypes";
import type { ResolvedPreviewIdentity } from "../identity";

const { loadAppMock } = vi.hoisted(() => ({
	loadAppMock: vi.fn(),
}));

vi.mock("@/lib/db/apps", () => ({
	loadApp: loadAppMock,
}));

import { validateCaptureSubmissionProjection } from "../captureSubmissionValidation";
import {
	buildSubmissionOperationProgram,
	buildSubmissionReceiptIdentity,
} from "../caseDataBindingHelpers";

const APP_ID = "capture-intent-unit-app";
const ACTOR_ID = "capture-intent-unit-actor";
const ENTRY_KEY = "11111111-1111-4111-8111-111111111111";
const FORM_UUID = asUuid("22222222-2222-4222-8222-222222222222");
const FIELD_UUID = asUuid("33333333-3333-4333-8333-333333333333");

const IDENTITY: ResolvedPreviewIdentity = {
	actorUserId: ACTOR_ID,
	ownerId: ACTOR_ID,
	session: { context: {}, user: {} },
	usercase: {},
};

function surveyDoc(fieldKind: "image" | "text") {
	return buildDoc({
		appName: "Capture intent unit app",
		modules: [
			{
				name: "Module",
				forms: [
					{
						uuid: FORM_UUID,
						name: "Survey",
						type: "survey",
						fields: [
							f({
								uuid: FIELD_UUID,
								kind: fieldKind,
								id: fieldKind === "image" ? "photo" : "note",
								label: fieldKind === "image" ? "Photo" : "Note",
							}),
						],
					},
				],
			},
		],
	});
}

function emptyCaptureMutation(): SubmissionMutation {
	return {
		kind: "survey",
		formUuid: FORM_UUID,
		entryKey: ENTRY_KEY,
		attachmentRefs: [],
	};
}

beforeEach(() => {
	loadAppMock.mockReset();
});

describe("capture submission intent", () => {
	it("keeps the replay latch for an attachment-capable form with an empty projection", async () => {
		const committedApp = {
			blueprint: surveyDoc("image"),
			mutation_seq: 17,
		};

		const mutation = emptyCaptureMutation();
		const built = await buildSubmissionOperationProgram({
			appId: APP_ID,
			committedApp,
			identity: IDENTITY,
			mutation,
			projection: validateCaptureSubmissionProjection(mutation),
			viewerTimeZone: "UTC",
		});

		expect(built.captureIntent).toMatchObject({
			entryKey: ENTRY_KEY,
			formUuid: FORM_UUID,
			expectedAppMutationSeq: 17,
			attachments: [],
			allowedAttachments: [
				expect.objectContaining({
					fieldUuid: FIELD_UUID,
					instancePathTemplate: "/data/photo",
					captureKind: "image",
				}),
			],
		});
		expect(built.captureIntent?.requestDigest).toMatch(/^[0-9a-f]{64}$/);
		expect(built.submissionReceipt).toEqual({
			entryKey: ENTRY_KEY,
			formUuid: FORM_UUID,
			requestDigest: built.captureIntent?.requestDigest,
		});
	});

	it("keeps the submission replay receipt after the current form becomes text-only", async () => {
		const committedApp = {
			blueprint: surveyDoc("text"),
			mutation_seq: 17,
		};

		const mutation = emptyCaptureMutation();
		const built = await buildSubmissionOperationProgram({
			appId: APP_ID,
			committedApp,
			identity: IDENTITY,
			mutation,
			projection: validateCaptureSubmissionProjection(mutation),
			viewerTimeZone: "UTC",
		});

		expect(built.captureIntent).toBeUndefined();
		expect(built.submissionReceipt).toMatchObject({
			entryKey: ENTRY_KEY,
			formUuid: FORM_UUID,
		});
		expect(built.submissionReceipt?.requestDigest).toMatch(/^[0-9a-f]{64}$/);
	});

	it("purely replays an exact receipt and rejects a changed digest before structure", () => {
		const exactMutation = emptyCaptureMutation();
		const exact = buildSubmissionReceiptIdentity({
			appId: APP_ID,
			identity: IDENTITY,
			mutation: exactMutation,
			projection: validateCaptureSubmissionProjection(exactMutation),
			viewerTimeZone: "UTC",
		});
		const changedMutation: SubmissionMutation = {
			...emptyCaptureMutation(),
			attachmentRefs: [
				{
					attachmentName: "changed.png",
					fieldUuid: FIELD_UUID,
					instancePath: "/data/photo",
				},
			],
		};
		const changed = buildSubmissionReceiptIdentity({
			appId: APP_ID,
			identity: IDENTITY,
			mutation: changedMutation,
			projection: validateCaptureSubmissionProjection(changedMutation),
			viewerTimeZone: "UTC",
		});
		const prior = {
			formUuid: exact.formUuid,
			requestDigest: exact.requestDigest,
			result: { childCaseIds: [], operations: [] },
		};
		expect(adjudicateSubmissionReceipt(exact, prior)).toEqual({
			kind: "replay",
			result: { childCaseIds: [], operations: [] },
		});
		expect(adjudicateSubmissionReceipt(changed, prior)).toEqual({
			kind: "mismatch",
		});
	});
});
