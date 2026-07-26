import { beforeEach, describe, expect, it, vi } from "vitest";
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

import { buildSubmissionOperationProgram } from "../caseDataBindingHelpers";

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

function emptyCaptureProjection(): SubmissionMutation {
	return {
		kind: "survey",
		formUuid: FORM_UUID,
		entryKey: ENTRY_KEY,
		attachmentNames: [],
		attachmentRefs: [],
	};
}

beforeEach(() => {
	loadAppMock.mockReset();
});

describe("capture submission intent", () => {
	it("keeps the replay latch for an attachment-capable form with an empty projection", async () => {
		loadAppMock.mockResolvedValue({
			blueprint: surveyDoc("image"),
			mutation_seq: 17,
		});

		const built = await buildSubmissionOperationProgram({
			appId: APP_ID,
			identity: IDENTITY,
			mutation: emptyCaptureProjection(),
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
	});

	it("leaves an empty projection outside the capture protocol for a text-only form", async () => {
		loadAppMock.mockResolvedValue({
			blueprint: surveyDoc("text"),
			mutation_seq: 17,
		});

		const built = await buildSubmissionOperationProgram({
			appId: APP_ID,
			identity: IDENTITY,
			mutation: emptyCaptureProjection(),
			viewerTimeZone: "UTC",
		});

		expect(built.captureIntent).toBeUndefined();
	});
});
