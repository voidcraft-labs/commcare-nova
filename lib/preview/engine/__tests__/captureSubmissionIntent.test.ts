import { beforeEach, describe, expect, it, vi } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { adjudicateSubmissionReceipt } from "@/lib/case-store";
import type { CaseOperation } from "@/lib/domain";
import { formField, literal, term } from "@/lib/domain/predicate";
import { proseText } from "@/lib/domain/prose";
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
/** These capture-intent cases carry no lookup carriers, so the scope only has
 *  to be a well-formed authorized triple — the loader takes its empty-id fast
 *  path and performs no lookup read. */
const LOOKUP_SCOPE = {
	projectId: "capture-intent-unit-project",
	actorId: "capture-intent-unit-actor",
	role: "owner",
} as const;
const ACTOR_ID = "capture-intent-unit-actor";
const ENTRY_KEY = "11111111-1111-4111-8111-111111111111";
const FORM_UUID = testUuid("22222222-2222-4222-8222-222222222222");
const FIELD_UUID = testUuid("33333333-3333-4333-8333-333333333333");
const BLUEPRINT_DIGEST = "0".repeat(64);

const IDENTITY: ResolvedPreviewIdentity = {
	actorUserId: ACTOR_ID,
	ownerId: ACTOR_ID,
	session: { context: {}, user: {}, userPropertySlugs: {} },
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

const REPEAT_UUID = testUuid("44444444-4444-4444-8444-444444444444");
const REPEAT_FIELD_UUID = testUuid("55555555-5555-4555-8555-555555555555");
const OPERATION_UUID = testUuid("66666666-6666-4666-8666-666666666666");

/** A form whose one case operation runs once per `visits` iteration. */
function repeatScopedOperationDoc(opts: { readsVisitNote?: boolean } = {}) {
	const doc = buildDoc({
		appName: "Repeat-scoped operation",
		caseTypes: [{ name: "visit", properties: [] }],
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
								uuid: REPEAT_UUID,
								kind: "repeat",
								id: "visits",
								label: proseText("Visits"),
								repeat_mode: "user_controlled",
								children: [
									f({
										uuid: REPEAT_FIELD_UUID,
										kind: "text",
										id: "visit_note",
										label: proseText("Visit note"),
									}),
								],
							}),
						],
					},
				],
			},
		],
	});
	return {
		...doc,
		forms: {
			...doc.forms,
			[FORM_UUID]: {
				...doc.forms[FORM_UUID],
				caseOperations: [
					{
						uuid: OPERATION_UUID,
						id: "log_visit",
						action: "create",
						caseType: "visit",
						target: { kind: "new" },
						forEach: { repeat: REPEAT_UUID },
						name: opts.readsVisitNote
							? term(formField(REPEAT_FIELD_UUID))
							: term(literal("Visit")),
					},
				] satisfies CaseOperation[],
			},
		},
	};
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
			blueprintDigest: BLUEPRINT_DIGEST,
			identity: IDENTITY,
			lookupScope: LOOKUP_SCOPE,
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
			expectedAppMutationSeq: 17,
			blueprintDigest: BLUEPRINT_DIGEST,
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
			blueprintDigest: BLUEPRINT_DIGEST,
			identity: IDENTITY,
			lookupScope: LOOKUP_SCOPE,
			mutation,
			projection: validateCaptureSubmissionProjection(mutation),
			viewerTimeZone: "UTC",
		});

		expect(built.captureIntent).toBeUndefined();
		expect(built.submissionReceipt).toMatchObject({
			entryKey: ENTRY_KEY,
			formUuid: FORM_UUID,
			expectedAppMutationSeq: 17,
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
			result: { primaryCaseIds: [], childCaseIds: [], operations: [] },
		};
		expect(adjudicateSubmissionReceipt(exact, prior)).toEqual({
			kind: "replay",
			result: {
				primaryCaseIds: [],
				createdChildren: [],
				legacyChildCaseIds: [],
				operations: [],
			},
		});
		expect(adjudicateSubmissionReceipt(changed, prior)).toEqual({
			kind: "mismatch",
		});
	});

	/* A repeat scope the committed doc requires, absent from the payload, is
	 * STALENESS, not an empty repeat: the client registers a scope for every
	 * repeat it knows about before counting instances, so a worker who added
	 * no rows still sends the repeat with an empty iteration list. Reading the
	 * absent scope as zero iterations would run the operation zero times and
	 * report success. */
	it("rejects a payload missing a repeat scope its committed operations run over", async () => {
		const committedApp = {
			blueprint: repeatScopedOperationDoc(),
			mutation_seq: 4,
		};
		const mutation: SubmissionMutation = {
			kind: "survey",
			formUuid: FORM_UUID,
			entryKey: ENTRY_KEY,
			attachmentRefs: [],
			// A stale client that never saw the `visits` repeat.
			operationAnswers: { root: [], repeats: [] },
		};

		await expect(
			buildSubmissionOperationProgram({
				appId: APP_ID,
				committedApp,
				blueprintDigest: BLUEPRINT_DIGEST,
				identity: IDENTITY,
				lookupScope: LOOKUP_SCOPE,
				mutation,
				projection: validateCaptureSubmissionProjection(mutation),
				viewerTimeZone: "UTC",
			}),
		).rejects.toThrow(/missing answers for a repeat/i);
	});

	it("accepts the same form when the worker simply added no rows", async () => {
		const committedApp = {
			blueprint: repeatScopedOperationDoc(),
			mutation_seq: 4,
		};
		const mutation: SubmissionMutation = {
			kind: "survey",
			formUuid: FORM_UUID,
			entryKey: ENTRY_KEY,
			attachmentRefs: [],
			// The current client: the repeat is present, with zero iterations.
			operationAnswers: {
				root: [],
				repeats: [{ repeat: REPEAT_UUID as string, iterations: [] }],
			},
		};

		const built = await buildSubmissionOperationProgram({
			appId: APP_ID,
			committedApp,
			blueprintDigest: BLUEPRINT_DIGEST,
			identity: IDENTITY,
			lookupScope: LOOKUP_SCOPE,
			mutation,
			projection: validateCaptureSubmissionProjection(mutation),
			viewerTimeZone: "UTC",
		});
		expect(built.program).toBeDefined();
	});

	/* One level finer than the repeat guard: a peer can add a FIELD an
	 * operation reads without adding a repeat. Left alone, that reference
	 * reaches compileBoundRef, which has no fallback for a form field, and
	 * its developer-voiced invariant becomes the worker's error text plus a
	 * Sentry alert for an ordinary multiplayer race. */
	it("rejects a payload missing an answer its committed operations read", async () => {
		const committedApp = {
			blueprint: repeatScopedOperationDoc({ readsVisitNote: true }),
			mutation_seq: 5,
		};
		const mutation: SubmissionMutation = {
			kind: "survey",
			formUuid: FORM_UUID,
			entryKey: ENTRY_KEY,
			attachmentRefs: [],
			// The repeat is known, but this client never saw `visit_note`.
			operationAnswers: {
				root: [],
				repeats: [{ repeat: REPEAT_UUID as string, iterations: [[]] }],
			},
		};

		await expect(
			buildSubmissionOperationProgram({
				appId: APP_ID,
				committedApp,
				blueprintDigest: BLUEPRINT_DIGEST,
				identity: IDENTITY,
				lookupScope: LOOKUP_SCOPE,
				mutation,
				projection: validateCaptureSubmissionProjection(mutation),
				viewerTimeZone: "UTC",
			}),
		).rejects.toThrow(/missing an answer/i);
	});

	it("does not demand an answer inside a repeat the worker left empty", async () => {
		const committedApp = {
			blueprint: repeatScopedOperationDoc({ readsVisitNote: true }),
			mutation_seq: 5,
		};
		const mutation: SubmissionMutation = {
			kind: "survey",
			formUuid: FORM_UUID,
			entryKey: ENTRY_KEY,
			attachmentRefs: [],
			// Zero iterations: nothing compiles, so nothing is missing.
			operationAnswers: {
				root: [],
				repeats: [{ repeat: REPEAT_UUID as string, iterations: [] }],
			},
		};

		const built = await buildSubmissionOperationProgram({
			appId: APP_ID,
			committedApp,
			blueprintDigest: BLUEPRINT_DIGEST,
			identity: IDENTITY,
			lookupScope: LOOKUP_SCOPE,
			mutation,
			projection: validateCaptureSubmissionProjection(mutation),
			viewerTimeZone: "UTC",
		});
		expect(built.program).toBeDefined();
	});
});
