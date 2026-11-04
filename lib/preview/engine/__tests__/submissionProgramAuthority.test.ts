import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { CaptureSubmissionRejectedError } from "@/lib/case-store/errors";
import type { CaseOperation } from "@/lib/domain";
import { eq, formField, literal, term } from "@/lib/domain/expression";
import { webAppsDevice } from "@/lib/preview/engine/__tests__/fixtures/previewDevices";
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
	it("builds every case change from the committed form, whatever case structure the client sends", () => {
		// The client names answers. A client that also names destinations, a
		// worker-record write or a close answer changes nothing the program
		// does: the own case, the child creates and the close all come from
		// the committed form.
		const { doc, formUuid } = ordinaryAuthorityDoc();
		const mutation = ordinaryAuthorityMutation(doc, formUuid);
		const build = (submitted: SubmissionMutation, committed = doc) =>
			buildCaseOperationProgramFromDoc({
				device: webAppsDevice(),
				blueprint: committed,
				mutation: submitted,
				projection: validateCaptureSubmissionProjection(submitted),
				identity: IDENTITY,
			});
		const built = build(mutation);
		const forged = {
			...mutation,
			primary: {
				caseType: "visit",
				caseName: "Forged",
				properties: { nickname: "The Countess" },
			},
			children: [{ caseType: "lab_result", properties: {} }],
			ordinaryChildBuckets: [{ caseType: "lab_result" }],
			usercase: { role: "admin" },
			closeConditionAnswers: { fieldUuid: formUuid, values: ["done"] },
		} as SubmissionMutation;
		expect(build(forged)).toEqual(built);
		expect(built.ordinaryAction).toEqual({ kind: "registration" });
		expect(
			built.program?.operations.map(({ operation }) => [
				operation.action,
				operation.action === "own" ? undefined : operation.caseType,
				operation.forEach !== undefined,
			]),
		).toEqual([
			["own", undefined, false],
			["create", "visit", false],
			["create", "medication_order", true],
		]);

		const close = conditionalCloseDoc();
		const closeEngine = engineFor(close.doc, close.formUuid);
		closeEngine.setValue("/data/close_when", "done");
		const closeMutation = closeEngine.computeSubmissionMutation({
			caseIds: [SESSION_CASE, SECOND_SESSION_CASE],
			entryKey: ENTRY_KEY,
		});
		const closeProgram = build(closeMutation, close.doc).program;
		expect(closeProgram?.ownCase).toEqual({
			caseType: "patient",
			formType: "close",
			closeCondition: close.doc.forms[close.formUuid]?.closeCondition,
		});
		expect(closeProgram?.scopes[0]?.iterations[0]?.formFields).toEqual(
			new Map([[close.conditionFieldUuid, "done"]]),
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
				device: webAppsDevice(),
				blueprint: doc,
				mutation: forged,
				projection,
				identity: IDENTITY,
			}),
		).toThrow(CaptureSubmissionRejectedError);
	});

	it("an operation reading an answer the client did not send rejects the final protocol", async () => {
		const { doc, formUuid } = acceptanceDoc((ids) => [
			{
				uuid: OP_ROOT,
				id: "op_root",
				action: "update",
				caseType: "patient",
				target: { kind: "session" },
				writes: [{ property: "op_status", value: term(formField(ids.note)) }],
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
				device: webAppsDevice(),
				blueprint: doc,
				mutation: missingAnswers,
				projection,
				identity: IDENTITY,
			}),
		).toThrow(CaptureSubmissionRejectedError);
	});
});

describe("an own-case answer that takes no part in the submission", () => {
	it("saves nothing to the case while its question is not relevant, as the wire's update does", () => {
		const { doc, formUuid, uuids } = acceptanceDoc(() => []);
		const shown = eq(formField(uuids.note), literal("show"));
		const gated = {
			...doc,
			fields: {
				...doc.fields,
				[uuids.externalCode]: {
					...doc.fields[uuids.externalCode],
					relevant: shown,
				},
			},
		} as typeof doc;
		const ownWrites = (note: string) => {
			const engine = engineFor(gated, formUuid);
			engine.setValue("/data/note", note);
			engine.setValue("/data/external_code", "EX-1");
			const mutation = engine.computeSubmissionMutation({
				caseIds: [SESSION_CASE],
				entryKey: ENTRY_KEY,
			});
			const program = buildCaseOperationProgramFromDoc({
				device: webAppsDevice(),
				blueprint: gated,
				mutation,
				projection: validateCaptureSubmissionProjection(mutation),
				identity: IDENTITY,
			}).program;
			const own = program?.operations.find(
				({ operation }) => operation.action === "own",
			);
			return own?.operation.writes?.map((write) => write.property);
		};
		expect(ownWrites("show")).toEqual(["external_id"]);
		expect(ownWrites("hide")).toEqual([]);
	});
});
