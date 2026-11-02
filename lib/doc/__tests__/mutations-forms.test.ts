import { produce } from "immer";
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import {
	moveCaseOperationAfterMutation,
	moveCaseOperationMutation,
	removeCaseOperationMutation,
} from "@/lib/doc/caseOperationMutations";
import { mutationCommitVerdict } from "@/lib/doc/commitVerdicts";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { applyMutations } from "@/lib/doc/mutations";
import {
	type BlueprintDoc,
	type Mutation,
	mutationSchema,
} from "@/lib/doc/types";
import { proseText } from "@/lib/domain";
import { assertAdmittedDoc } from "./admittedDoc";

const M = (key: string) => testUuid(`forms-module-${key}`);
const F = (key: string) => testUuid(`forms-form-${key}`);
const Q = (key: string) => testUuid(`forms-question-${key}`);
function fixture(): BlueprintDoc {
	const doc = buildDoc({
		modules: ["a", "b"].map((module) => ({
			uuid: M(module),
			name: `Module ${module}`,
			forms: ["1", "2"].map((number) => {
				const key = module + number;
				return {
					uuid: F(key),
					name: `Form ${key}`,
					type: "survey",
					fields: [
						f({
							uuid: Q(key),
							kind: "group",
							id: "group",
							children: [
								f({
									uuid: Q(`${key}-child`),
									kind: "text",
									id: "notes",
									label: proseText("Notes"),
								}),
							],
						}),
					],
				};
			}),
		})),
	});
	assertAdmittedDoc(doc);
	return doc;
}
function commit(
	doc: BlueprintDoc,
	mutations: readonly Mutation[],
): BlueprintDoc {
	const parsed = mutations.map((mutation) =>
		mutationSchema.parse(JSON.parse(JSON.stringify(mutation))),
	);
	const verdict = mutationCommitVerdict(
		doc,
		parsed,
		LOOKUP_CONTEXT_UNAVAILABLE,
	);
	expect(verdict.ok ? [] : verdict.findings).toEqual([]);
	return verdict.nextDoc;
}
describe("form membership and content edits", () => {
	it("births a complete form at its authored anchor and leaves the prior document unchanged", () => {
		const before = fixture();
		const next = commit(before, [
			{
				kind: "addForm",
				moduleUuid: M("a"),
				after: F("a1"),
				form: { uuid: F("born"), id: "born", name: "Born", type: "survey" },
			},
			{
				kind: "addField",
				parentUuid: F("born"),
				field: {
					uuid: Q("born"),
					id: "notes",
					kind: "text",
					label: proseText("Notes"),
				},
			},
		]);
		expect(next.formOrder[M("a")]).toEqual([F("a1"), F("born"), F("a2")]);
		expect(next.fieldOrder[F("born")]).toEqual([Q("born")]);
		expect(next.forms[F("born")]).toMatchObject({ id: "born", name: "Born" });
		expect(before.forms[F("born")]).toBeUndefined();
	});
	it("removes a form and its complete nested field topology while retaining its sibling", () => {
		const next = commit(fixture(), [{ kind: "removeForm", uuid: F("a1") }]);
		expect(next.formOrder[M("a")]).toEqual([F("a2")]);
		expect(next.forms[F("a1")]).toBeUndefined();
		expect(next.fieldOrder[F("a1")]).toBeUndefined();
		for (const uuid of [Q("a1"), Q("a1-child")]) {
			expect(next.fields[uuid]).toBeUndefined();
			expect(next.fieldParent[uuid]).toBeUndefined();
			expect(next.fieldOrder[uuid]).toBeUndefined();
		}
		expect(next.fields[Q("a2-child")]).toBeDefined();
	});
	it("reorders within a module and moves across modules without losing the field tree", () => {
		const before = fixture();
		const reordered = commit(before, [
			{ kind: "moveForm", uuid: F("a1"), toModuleUuid: M("a"), after: F("a2") },
		]);
		expect(reordered.formOrder[M("a")]).toEqual([F("a2"), F("a1")]);
		const moved = commit(reordered, [
			{ kind: "moveForm", uuid: F("a1"), toModuleUuid: M("b"), after: null },
		]);
		expect(moved.formOrder[M("a")]).toEqual([F("a2")]);
		expect(moved.formOrder[M("b")]).toEqual([F("a1"), F("b1"), F("b2")]);
		expect(moved.fields[Q("a1-child")]).toEqual(before.fields[Q("a1-child")]);
		expect(moved.fieldParent[Q("a1-child")]).toBe(Q("a1"));
	});
	it("keeps semantic form id and field contents when display name and purpose change", () => {
		const before = fixture();
		const next = commit(before, [
			{ kind: "renameForm", uuid: F("a1"), newId: "Renamed" },
			{
				kind: "updateForm",
				uuid: F("a1"),
				patch: { purpose: "Collect follow-up notes" },
			},
		]);
		expect(next.forms[F("a1")]).toEqual({
			...before.forms[F("a1")],
			name: "Renamed",
			purpose: "Collect follow-up notes",
		});
		expect(next.fields).toEqual(before.fields);
	});
	it.each(["missing-destination", "missing-form", "missing-anchor"] as const)(
		"refuses %s and leaves unguarded stale replay intact",
		(scenario) => {
			const before = fixture();
			const mutation: Mutation = {
				kind: "moveForm",
				uuid: scenario === "missing-form" ? F("gone") : F("a1"),
				toModuleUuid: scenario === "missing-destination" ? M("gone") : M("b"),
				after: scenario === "missing-anchor" ? F("gone") : null,
			};
			expect(
				mutationCommitVerdict(before, [mutation], LOOKUP_CONTEXT_UNAVAILABLE)
					.ok,
			).toBe(false);
			const replayed = produce(before, (draft) => {
				applyMutations(draft, [mutation]);
			});
			expect(toPersistableDoc(replayed)).toEqual(toPersistableDoc(before));
		},
	);
	it.each(["deleted-module", "deleted-anchor"] as const)(
		"refuses stale form birth against %s without materializing an orphan",
		(scenario) => {
			const before = fixture();
			const mutation: Mutation = {
				kind: "addForm",
				moduleUuid: scenario === "deleted-module" ? M("gone") : M("a"),
				after: F("gone"),
				form: { uuid: F("born"), id: "born", name: "Born", type: "survey" },
			};
			expect(
				mutationCommitVerdict(before, [mutation], LOOKUP_CONTEXT_UNAVAILABLE)
					.ok,
			).toBe(false);
			expect(
				toPersistableDoc(
					produce(before, (draft) => {
						applyMutations(draft, [mutation]);
					}),
				),
			).toEqual(toPersistableDoc(before));
		},
	);
});

describe("first case-operation collection member", () => {
	it("appends the first write and link when the optional anchor is omitted", () => {
		const operationUuid = testUuid("first-operation-members");
		const before = commit(fixture(), [
			{ kind: "declareCaseType", caseType: "patient" },
			{ kind: "declareCaseType", caseType: "household" },
			{
				kind: "setCaseTypeMeta",
				caseType: "patient",
				parent_type: "household",
				relationship: "child",
			},
			{
				kind: "addCaseProperty",
				caseType: "patient",
				property: { name: "note", label: proseText("Note"), data_type: "text" },
			},
			{
				kind: "updateForm",
				uuid: F("a1"),
				patch: {},
				caseOperationChange: {
					operation: "add",
					value: {
						uuid: operationUuid,
						id: "update_patient",
						action: "update",
						caseType: "patient",
						target: {
							kind: "expression",
							expr: {
								kind: "term",
								term: { kind: "literal", value: "patient-id" },
							},
						},
						owner: {
							kind: "term",
							term: { kind: "literal", value: "owner-id" },
						},
					},
				},
			},
		]);
		const value = {
			kind: "term" as const,
			term: { kind: "literal" as const, value: "Edited" },
		};
		const link = {
			identifier: "parent",
			targetType: "household",
			relationship: "child" as const,
			target: {
				kind: "expression" as const,
				expr: {
					kind: "term" as const,
					term: { kind: "literal" as const, value: "household-id" },
				},
			},
		};
		const next = commit(before, [
			{
				kind: "updateForm",
				uuid: F("a1"),
				patch: {},
				caseOperationPatch: {
					operation: "add-write",
					uuid: operationUuid,
					value: { property: "note", value },
				},
			},
			{
				kind: "updateForm",
				uuid: F("a1"),
				patch: {},
				caseOperationPatch: {
					operation: "add-link",
					uuid: operationUuid,
					value: link,
				},
			},
		]);
		expect(next.forms[F("a1")].caseOperations?.[0].writes).toEqual([
			{ property: "note", value },
		]);
		expect(next.forms[F("a1")].caseOperations?.[0].links).toEqual([link]);
	});
});

// ── The form's own case and its open and close conditions ────────────

const CM = testUuid("forms-case-module");
const REG = testUuid("forms-case-registration");
const FUP = testUuid("forms-case-followup");
const CLS = testUuid("forms-case-close");
const REG_NAME = testUuid("forms-case-reg-name");
const REG_NICK = testUuid("forms-case-reg-nick");
const FUP_NOTE = testUuid("forms-case-fup-note");
const CLS_NOTE = testUuid("forms-case-cls-note");
const OWN_REG = testUuid("forms-own-registration");
const OWN_FUP = testUuid("forms-own-followup");
const OWN_CLS = testUuid("forms-own-close");
const FUP_UPDATE = testUuid("forms-followup-update");

const answerOf = (uuid: typeof REG_NAME) => ({
	kind: "term" as const,
	term: { kind: "field" as const, uuid },
});
const literalValue = (value: string) => ({
	kind: "term" as const,
	term: { kind: "literal" as const, value },
});
const answered = (uuid: typeof REG_NAME, value: string) => ({
	kind: "eq" as const,
	left: answerOf(uuid),
	right: literalValue(value),
});

function caseFixture(): BlueprintDoc {
	const doc = buildDoc(
		{
			caseTypes: [
				{
					name: "patient",
					properties: [{ name: "note", label: "Note", data_type: "text" }],
				},
			],
			modules: [
				{
					uuid: CM,
					name: "Patients",
					caseType: "patient",
					caseListConfig: caseListConfig([
						{ field: "case_name", header: "Name" },
					]),
					forms: [
						{
							uuid: REG,
							name: "Register",
							type: "registration",
							fields: [
								f({
									uuid: REG_NAME,
									kind: "text",
									id: "case_name",
									label: "Name",
								}),
								f({
									uuid: REG_NICK,
									kind: "text",
									id: "nickname",
									label: "Nickname",
								}),
							],
						},
						{
							uuid: FUP,
							name: "Visit",
							type: "followup",
							fields: [
								f({ uuid: FUP_NOTE, kind: "text", id: "note", label: "Note" }),
							],
						},
						{
							uuid: CLS,
							name: "Discharge",
							type: "close",
							fields: [
								f({ uuid: CLS_NOTE, kind: "text", id: "note", label: "Note" }),
							],
						},
					],
				},
			],
		},
		(draft) => {
			draft.forms[REG].caseOperations = [
				{
					uuid: OWN_REG,
					id: "patient",
					action: "own",
					name: answerOf(REG_NAME),
				},
			];
			draft.forms[FUP].caseOperations = [
				{ uuid: OWN_FUP, id: "patient", action: "own" },
				{
					uuid: FUP_UPDATE,
					id: "visit_note",
					action: "update",
					caseType: "patient",
					target: { kind: "session" },
					writes: [{ property: "note", value: answerOf(FUP_NOTE) }],
				},
			];
			draft.forms[CLS].caseOperations = [
				{ uuid: OWN_CLS, id: "patient", action: "own" },
			];
		},
	);
	assertAdmittedDoc(doc);
	return doc;
}

function reduce(doc: BlueprintDoc, mutations: readonly Mutation[]) {
	const parsed = mutations.map((mutation) =>
		mutationSchema.parse(JSON.parse(JSON.stringify(mutation))),
	);
	return produce(doc, (draft) => {
		applyMutations(draft, parsed);
	});
}

describe("open and close conditions", () => {
	it("sets and clears a registration's open and close conditions", () => {
		const before = caseFixture();
		const set = commit(before, [
			{
				kind: "updateForm",
				uuid: REG,
				patch: {
					openCondition: answered(REG_NICK, "yes"),
					closeCondition: answered(REG_NICK, "gone"),
				},
			},
		]);
		expect(set.forms[REG].openCondition).toEqual(answered(REG_NICK, "yes"));
		expect(set.forms[REG].closeCondition).toEqual(answered(REG_NICK, "gone"));
		const cleared = commit(set, [
			{
				kind: "updateForm",
				uuid: REG,
				patch: { openCondition: null, closeCondition: null },
			},
		]);
		expect(cleared.forms[REG]).not.toHaveProperty("openCondition");
		expect(cleared.forms[REG]).not.toHaveProperty("closeCondition");
	});

	it("sets and clears a close form's close condition", () => {
		const set = commit(caseFixture(), [
			{
				kind: "updateForm",
				uuid: CLS,
				patch: { closeCondition: answered(CLS_NOTE, "done") },
			},
		]);
		expect(set.forms[CLS].closeCondition).toEqual(answered(CLS_NOTE, "done"));
		const cleared = commit(set, [
			{ kind: "updateForm", uuid: CLS, patch: { closeCondition: null } },
		]);
		expect(cleared.forms[CLS]).not.toHaveProperty("closeCondition");
	});

	it("stores every time as absent for an open condition and a close form's close condition, and keeps a registration's", () => {
		const next = reduce(caseFixture(), [
			{
				kind: "updateForm",
				uuid: REG,
				patch: {
					openCondition: { kind: "match-all" },
					closeCondition: { kind: "match-all" },
				},
			},
			{
				kind: "updateForm",
				uuid: CLS,
				patch: { closeCondition: { kind: "match-all" } },
			},
		]);
		expect(next.forms[REG]).not.toHaveProperty("openCondition");
		// On a registration, absent is "never close", so "close every time"
		// keeps its spelling.
		expect(next.forms[REG].closeCondition).toEqual({ kind: "match-all" });
		expect(next.forms[CLS]).not.toHaveProperty("closeCondition");
	});

	it("drops a registration's every-time close when the same patch makes it a close form", () => {
		const next = reduce(caseFixture(), [
			{
				kind: "updateForm",
				uuid: REG,
				patch: { type: "close", closeCondition: { kind: "match-all" } },
			},
		]);
		expect(next.forms[REG]).not.toHaveProperty("closeCondition");
	});
});

describe("the form's own case", () => {
	it("lands an added own case first, ahead of the changes already there", () => {
		const own = {
			uuid: testUuid("forms-own-new"),
			id: "patient",
			action: "own" as const,
		};
		const next = reduce(caseFixture(), [
			{
				kind: "updateForm",
				uuid: FUP,
				patch: {},
				caseOperationChange: { operation: "remove", uuid: OWN_FUP },
			},
			{
				kind: "updateForm",
				uuid: FUP,
				patch: {},
				caseOperationChange: { operation: "add", value: own },
			},
		]);
		expect(
			next.forms[FUP].caseOperations?.map((operation) => operation.uuid),
		).toEqual([own.uuid, FUP_UPDATE]);
	});

	it("adds the own case with the form type that needs it", () => {
		const before = commit(caseFixture(), [
			{
				kind: "updateForm",
				uuid: FUP,
				patch: {},
				caseOperationChange: { operation: "remove", uuid: FUP_UPDATE },
			},
		]);
		const survey = commit(before, [
			{ kind: "updateForm", uuid: FUP, patch: { type: "survey" } },
			{
				kind: "updateForm",
				uuid: FUP,
				patch: {},
				caseOperationChange: { operation: "remove", uuid: OWN_FUP },
			},
		]);
		expect(survey.forms[FUP]).not.toHaveProperty("caseOperations");
		const own = {
			uuid: testUuid("forms-own-again"),
			id: "patient",
			action: "own" as const,
		};
		const back = commit(survey, [
			{ kind: "updateForm", uuid: FUP, patch: { type: "followup" } },
			{
				kind: "updateForm",
				uuid: FUP,
				patch: {},
				caseOperationChange: { operation: "add", value: own },
			},
		]);
		expect(back.forms[FUP].caseOperations).toEqual([own]);
	});

	it("patches the own case's name and owner, and clears the owner", () => {
		const renamed = commit(caseFixture(), [
			{
				kind: "updateForm",
				uuid: REG,
				patch: {},
				caseOperationPatch: {
					operation: "update",
					uuid: OWN_REG,
					targetAction: "own",
					patch: { name: answerOf(REG_NICK), owner: literalValue("owner-id") },
				},
			},
		]);
		expect(renamed.forms[REG].caseOperations?.[0]).toEqual({
			uuid: OWN_REG,
			id: "patient",
			action: "own",
			name: answerOf(REG_NICK),
			owner: literalValue("owner-id"),
		});
		const unowned = commit(renamed, [
			{
				kind: "updateForm",
				uuid: REG,
				patch: {},
				caseOperationPatch: {
					operation: "update",
					uuid: OWN_REG,
					targetAction: "own",
					patch: { owner: null },
				},
			},
		]);
		expect(unowned.forms[REG].caseOperations?.[0]).not.toHaveProperty("owner");
	});

	it("keys a write by its property and the indices it walks", () => {
		const viaParent = [{ identifier: "parent" }] as [{ identifier: string }];
		const next = reduce(caseFixture(), [
			{
				kind: "updateForm",
				uuid: FUP,
				patch: {},
				caseOperationPatch: {
					operation: "add-write",
					uuid: OWN_FUP,
					value: { property: "note", value: answerOf(FUP_NOTE) },
				},
			},
			{
				kind: "updateForm",
				uuid: FUP,
				patch: {},
				caseOperationPatch: {
					operation: "add-write",
					uuid: OWN_FUP,
					value: {
						property: "note",
						value: answerOf(FUP_NOTE),
						via: viaParent,
					},
					after: null,
				},
			},
			{
				kind: "updateForm",
				uuid: FUP,
				patch: {},
				caseOperationPatch: {
					operation: "update-write",
					uuid: OWN_FUP,
					key: { property: "note" },
					patch: { onlyIfChanged: true },
				},
			},
			{
				kind: "updateForm",
				uuid: FUP,
				patch: {},
				caseOperationPatch: {
					operation: "move-write",
					uuid: OWN_FUP,
					key: { property: "note", via: viaParent },
					after: { property: "note" },
				},
			},
		]);
		expect(next.forms[FUP].caseOperations?.[0].writes).toEqual([
			{ property: "note", value: answerOf(FUP_NOTE), onlyIfChanged: true },
			{ property: "note", value: answerOf(FUP_NOTE), via: viaParent },
		]);
		const removed = reduce(next, [
			{
				kind: "updateForm",
				uuid: FUP,
				patch: {},
				caseOperationPatch: {
					operation: "remove-write",
					uuid: OWN_FUP,
					key: { property: "note", via: viaParent },
				},
			},
		]);
		expect(removed.forms[FUP].caseOperations?.[0].writes).toEqual([
			{ property: "note", value: answerOf(FUP_NOTE), onlyIfChanged: true },
		]);
	});

	it("refuses to remove the own case, to move it, or to move another change above it", () => {
		const doc = caseFixture();
		expect(removeCaseOperationMutation(doc, FUP, OWN_FUP)).toEqual({
			ok: false,
			reason: "own-case",
			message: "This form's own case goes only with its form's type.",
			dependentUuids: [],
		});
		const ownFirst = {
			ok: false,
			reason: "own-first",
			message: "This form's case is always the first change.",
			dependentUuids: [],
		};
		expect(moveCaseOperationMutation(doc, FUP, OWN_FUP, 1)).toEqual(ownFirst);
		expect(moveCaseOperationMutation(doc, FUP, FUP_UPDATE, 0)).toEqual(
			ownFirst,
		);
		expect(
			moveCaseOperationAfterMutation(doc, FUP, OWN_FUP, FUP_UPDATE),
		).toEqual(ownFirst);
		expect(moveCaseOperationAfterMutation(doc, FUP, FUP_UPDATE, null)).toEqual(
			ownFirst,
		);
		// The other change stays where it is behind the own case.
		expect(
			moveCaseOperationAfterMutation(doc, FUP, FUP_UPDATE, OWN_FUP),
		).toEqual({
			ok: true,
			mutations: [],
		});
	});
});

describe("held placements are written by no edit", () => {
	const held = { kind: "save-to-case", path: ["nova_operations", "patient"] };
	const refusals = (value: unknown) => {
		const parsed = mutationSchema.safeParse(value);
		expect(parsed.success).toBe(false);
		return parsed.success
			? []
			: parsed.error.issues.map((issue) => issue.message);
	};

	it("refuses an added case change that carries a placement", () => {
		expect(
			refusals({
				kind: "updateForm",
				uuid: FUP,
				patch: {},
				caseOperationChange: {
					operation: "add",
					value: {
						uuid: testUuid("forms-held-add"),
						id: "patient",
						action: "own",
						placement: { kind: "basic", slot: "own" },
					},
				},
			}),
		).toContain(
			"A new case change can't hold where a published app keeps it, since no edit chooses that. Leave out `placement`, and the change takes the placement its shape gives.",
		);
	});

	it("refuses an operation update patch that carries a placement", () => {
		expect(
			refusals({
				kind: "updateForm",
				uuid: FUP,
				patch: {},
				caseOperationPatch: {
					operation: "update",
					uuid: FUP_UPDATE,
					targetAction: "update",
					patch: { placement: held },
				},
			}),
		).toContain(
			"This update also sets where a published app keeps the case change. No edit chooses that, so leave `placement` out of the patch.",
		);
	});

	it("refuses a form patch that carries the own close's placement", () => {
		expect(
			refusals({
				kind: "updateForm",
				uuid: CLS,
				patch: { ownClosePlacement: held },
			}),
		).toContain(
			"This form update also sets where a published app keeps the form's own close. No edit chooses that, so leave `ownClosePlacement` out of the patch.",
		);
	});

	it("refuses a new form that holds a placement, so a duplicate starts unheld", () => {
		expect(
			refusals({
				kind: "addForm",
				moduleUuid: CM,
				form: {
					uuid: testUuid("forms-held-form"),
					id: "copy",
					name: "Copy",
					type: "close",
					ownClosePlacement: held,
				},
			}),
		).toContain(
			"A new form can't hold where a published app keeps its case changes, since no edit chooses that. Leave out `ownClosePlacement` and each case change's `placement`, and the form takes the placements its shape gives.",
		);
	});
});
