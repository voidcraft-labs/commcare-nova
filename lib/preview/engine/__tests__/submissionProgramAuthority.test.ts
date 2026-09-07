import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { CaptureSubmissionRejectedError } from "@/lib/case-store/errors";
import type { CaseOperation } from "@/lib/domain";
import { formField, term } from "@/lib/domain/predicate";
import { validateCaptureSubmissionProjection } from "../captureSubmissionValidation";
import { buildCaseOperationProgramFromDoc } from "../caseDataBindingHelpers";
import type { SubmissionMutation } from "../caseDataBindingTypes";
import type { ResolvedPreviewIdentity } from "../identity";
import {
	acceptanceDoc,
	conditionalCloseDoc,
	engineFor,
	ordinaryAuthorityDoc,
	ordinaryAuthorityMutation,
} from "./fixtures/submissionProgram";

const ACTOR = "worker-1";
const SESSION_CASE = "50000000-0000-0000-0000-000000000001";
const SECOND_SESSION_CASE = "50000000-0000-0000-0000-000000000002";
const ENTRY_KEY = "11111111-1111-4111-8111-111111111111";
const OP_ROOT = testUuid("60000000-0000-7000-8000-00000000a001");
const IDENTITY: ResolvedPreviewIdentity = {
	actorUserId: ACTOR,
	ownerId: ACTOR,
	session: {
		context: { userid: ACTOR, username: "ada" },
		user: { role: "supervisor" },
		userPropertySlugs: {},
	},
	usercase: { role: "supervisor" },
};

describe("committed program input rejection", () => {
	it("rejects every uncommitted ordinary case structure before effects", () => {
		const { doc, formUuid } = ordinaryAuthorityDoc();
		const mutation = ordinaryAuthorityMutation(doc, formUuid);
		const reject = (forged: SubmissionMutation, committed = doc) => {
			const projection = validateCaptureSubmissionProjection(forged);
			expect(() =>
				buildCaseOperationProgramFromDoc({
					blueprint: committed,
					mutation: forged,
					projection,
					identity: IDENTITY,
				}),
			).toThrow(CaptureSubmissionRejectedError);
		};
		const [rootChild, repeatedChild] = mutation.children;
		const [rootBucket, repeatedBucket] = mutation.ordinaryChildBuckets ?? [];
		if (
			rootChild === undefined ||
			repeatedChild === undefined ||
			rootBucket === undefined ||
			repeatedBucket === undefined
		) {
			throw new Error("Ordinary-authority fixture is missing child buckets.");
		}

		reject({
			...mutation,
			primary: { ...mutation.primary, caseType: "visit" },
		});
		reject({
			...mutation,
			primary: {
				...mutation.primary,
				properties: {
					...mutation.primary.properties,
					nickname: "The Countess",
				},
			},
		});
		reject({
			...mutation,
			children: [
				{ ...rootChild, caseType: "lab_result", properties: {} },
				...mutation.children.slice(1),
			],
			ordinaryChildBuckets: [
				{ caseType: "lab_result" },
				...(mutation.ordinaryChildBuckets ?? []).slice(1),
			],
		});
		reject({
			...mutation,
			children: [
				{
					...rootChild,
					properties: { ...rootChild.properties, private_note: "hidden" },
				},
				...mutation.children.slice(1),
			],
		});
		reject({
			...mutation,
			children: [rootChild, rootChild, ...mutation.children.slice(1)],
			ordinaryChildBuckets: [
				rootBucket,
				rootBucket,
				...(mutation.ordinaryChildBuckets ?? []).slice(1),
			],
		});
		reject({
			...mutation,
			children: [...mutation.children, repeatedChild],
			ordinaryChildBuckets: [
				...(mutation.ordinaryChildBuckets ?? []),
				repeatedBucket,
			],
		});
		reject({
			...mutation,
			primary: { ...mutation.primary, externalId: "forged-external" },
		});

		const close = conditionalCloseDoc();
		const closeEngine = engineFor(close.doc, close.formUuid);
		closeEngine.setValue("/data/close_when", "done");
		const closeMutation = closeEngine.computeSubmissionMutation({
			caseIds: [SESSION_CASE, SECOND_SESSION_CASE],
			entryKey: ENTRY_KEY,
		});
		if (closeMutation.kind !== "close") {
			throw new Error("Conditional-close fixture did not produce close.");
		}
		reject(
			{
				...closeMutation,
				patch: { ...closeMutation.patch, caseName: "Forged name" },
			},
			close.doc,
		);
	});

	it("rejects a forged batch-close discriminator against a committed followup form before effects", () => {
		const { doc, formUuid } = acceptanceDoc(() => []);
		const engine = engineFor(doc, formUuid);
		const authored = engine.computeSubmissionMutation({
			caseIds: [SESSION_CASE, SECOND_SESSION_CASE],
			entryKey: ENTRY_KEY,
		});
		expect(authored.kind).toBe("followup");
		const forged = { ...authored, kind: "close" } as SubmissionMutation;
		const projection = validateCaptureSubmissionProjection(forged);

		expect(() =>
			buildCaseOperationProgramFromDoc({
				blueprint: doc,
				mutation: forged,
				projection,
				identity: IDENTITY,
			}),
		).toThrow(CaptureSubmissionRejectedError);
	});

	it("operations present but no collected answer bags rejects the final protocol", async () => {
		const { doc, formUuid } = acceptanceDoc((ids) => [
			{
				uuid: OP_ROOT,
				id: "op_root",
				action: "update",
				caseType: "patient",
				target: { kind: "session" },
				writes: [{ property: "external_id", value: term(formField(ids.note)) }],
			} as CaseOperation,
		]);
		const engine = engineFor(doc, formUuid);
		engine.setValue("/data/note", "collected");
		const mutation = engine.computeSubmissionMutation({
			caseIds: [SESSION_CASE],
			entryKey: ENTRY_KEY,
		});
		const missingAnswers = { ...mutation, operationAnswers: undefined };
		const projection = validateCaptureSubmissionProjection(missingAnswers);
		// A stale client must neither run blank bindings nor silently skip the
		// committed operation program.
		expect(() =>
			buildCaseOperationProgramFromDoc({
				blueprint: doc,
				mutation: missingAnswers,
				projection,
				identity: IDENTITY,
			}),
		).toThrow(CaptureSubmissionRejectedError);
	});
});
