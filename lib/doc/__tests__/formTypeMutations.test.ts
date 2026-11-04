// What a form-type change carries with it: the form's own case and its open
// and close conditions, each row of the type table, replayed through the commit
// gate. Catches a type change that strands an own case or a condition, and a
// module retype or form move that leaves the own case writing undeclared
// properties.

import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import { mutationCommitVerdict } from "@/lib/doc/commitVerdicts";
import {
	CHOOSE_NAME_QUESTION_MESSAGE,
	type FormTypeChangePlan,
	moduleCaseTypeChangeMutations,
	moveFormMutations,
	NEW_CASE_WRITE_FACETS_MESSAGE,
	planFormTypeChange,
} from "@/lib/doc/formTypeMutations";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import {
	type BlueprintDoc,
	type Mutation,
	mutationSchema,
} from "@/lib/doc/types";
import type { CaseOperation, Expression, Form } from "@/lib/domain";
import { assertAdmittedDoc } from "./admittedDoc";

const PATIENTS = testUuid("type-module-patients");
const HOUSEHOLDS = testUuid("type-module-households");
const SURVEY = testUuid("type-form-survey");
const REG = testUuid("type-form-registration");
const FUP = testUuid("type-form-followup");
const CLS = testUuid("type-form-close");
const HOME = testUuid("type-form-household");
const SURVEY_NAME = testUuid("type-survey-name");
const REG_NAME = testUuid("type-reg-name");
const REG_FLAG = testUuid("type-reg-flag");
const FUP_NOTE = testUuid("type-fup-note");
const CLS_NOTE = testUuid("type-cls-note");
const HOME_NAME = testUuid("type-home-name");
const OWN_REG = testUuid("type-own-registration");
const OWN_FUP = testUuid("type-own-followup");
const OWN_CLS = testUuid("type-own-close");
const OWN_HOME = testUuid("type-own-household");

const answerOf = (uuid: typeof REG_NAME): Expression => ({
	kind: "term",
	term: { kind: "field", uuid },
});
const answered = (uuid: typeof REG_NAME, value: string): Expression => ({
	kind: "eq",
	left: answerOf(uuid),
	right: { kind: "term", term: { kind: "literal", value } },
});

function fixture(configure?: (doc: BlueprintDoc) => void): BlueprintDoc {
	const doc = buildDoc(
		{
			caseTypes: [
				{ name: "household", properties: [] },
				{
					name: "patient",
					parent_type: "household",
					relationship: "child",
					properties: [{ name: "note", label: "Note", data_type: "text" }],
				},
			],
			modules: [
				{
					uuid: PATIENTS,
					name: "Patients",
					caseType: "patient",
					caseListConfig: caseListConfig([
						{ field: "case_name", header: "Name" },
					]),
					forms: [
						{
							uuid: SURVEY,
							name: "Survey",
							type: "survey",
							fields: [
								f({
									uuid: SURVEY_NAME,
									kind: "text",
									id: "full_name",
									label: "Full name",
								}),
							],
						},
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
								f({ uuid: REG_FLAG, kind: "text", id: "flag", label: "Flag" }),
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
				{
					uuid: HOUSEHOLDS,
					name: "Households",
					caseType: "household",
					caseListConfig: caseListConfig([
						{ field: "case_name", header: "Name" },
					]),
					forms: [
						{
							uuid: HOME,
							name: "Add household",
							type: "registration",
							fields: [
								f({
									uuid: HOME_NAME,
									kind: "text",
									id: "case_name",
									label: "Name",
								}),
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
				{
					uuid: OWN_FUP,
					id: "patient",
					action: "own",
					writes: [{ property: "note", value: answerOf(FUP_NOTE) }],
				},
			];
			draft.forms[CLS].caseOperations = [
				{ uuid: OWN_CLS, id: "patient", action: "own" },
			];
			draft.forms[HOME].caseOperations = [
				{
					uuid: OWN_HOME,
					id: "household",
					action: "own",
					name: answerOf(HOME_NAME),
				},
			];
			configure?.(draft);
		},
	);
	assertAdmittedDoc(doc);
	return doc;
}

/** The plan's batch, admitted as every editor admits it and judged by the
 *  gate; the document it lands. */
function land(doc: BlueprintDoc, plan: FormTypeChangePlan): BlueprintDoc {
	if (!plan.ok) throw new Error(`Expected a plan, got "${plan.message}"`);
	return commit(doc, plan.mutations);
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
	if (!verdict.ok) throw new Error("The gate refused the batch.");
	return verdict.nextDoc;
}

const ownOf = (form: Form): CaseOperation | undefined =>
	form.caseOperations?.find((operation) => operation.action === "own");

describe("planFormTypeChange", () => {
	it("survey → registration adds the own case first, named by the chosen question", () => {
		const doc = fixture();
		const next = land(
			doc,
			planFormTypeChange(doc, SURVEY, "registration", {
				nameField: SURVEY_NAME,
			}),
		);
		const form = next.forms[SURVEY];
		expect(form.type).toBe("registration");
		expect(form.caseOperations).toHaveLength(1);
		expect(form.caseOperations?.[0]).toMatchObject({
			action: "own",
			id: "patient",
			name: answerOf(SURVEY_NAME),
		});
	});

	it("survey → registration without a question to name the case refuses", () => {
		expect(planFormTypeChange(fixture(), SURVEY, "registration")).toEqual({
			ok: false,
			message: CHOOSE_NAME_QUESTION_MESSAGE,
		});
		// A question from another form names nothing here.
		expect(
			planFormTypeChange(fixture(), SURVEY, "registration", {
				nameField: REG_NAME,
			}),
		).toEqual({ ok: false, message: CHOOSE_NAME_QUESTION_MESSAGE });
		expect(CHOOSE_NAME_QUESTION_MESSAGE).toBe(
			"Choose the question that names the new case.",
		);
	});

	it.each(["followup", "close"] as const)(
		"survey → %s adds the own case with no writes",
		(type) => {
			const doc = fixture();
			const next = land(doc, planFormTypeChange(doc, SURVEY, type));
			const own = ownOf(next.forms[SURVEY]);
			expect(next.forms[SURVEY].type).toBe(type);
			expect(next.forms[SURVEY].caseOperations?.[0]).toBe(own);
			expect(own).toMatchObject({ action: "own", id: "patient" });
			expect(own).not.toHaveProperty("writes");
			expect(own).not.toHaveProperty("name");
		},
	);

	it.each([
		["registration", REG],
		["followup", FUP],
		["close", CLS],
	] as const)(
		"%s → survey removes the own case, its writes and both conditions",
		(_type, formUuid) => {
			const doc = fixture((draft) => {
				if (formUuid === REG) {
					draft.forms[REG].openCondition = answered(REG_FLAG, "yes");
					draft.forms[REG].closeCondition = answered(REG_FLAG, "gone");
				}
				if (formUuid === CLS)
					draft.forms[CLS].closeCondition = answered(CLS_NOTE, "done");
			});
			const next = land(doc, planFormTypeChange(doc, formUuid, "survey"));
			const form = next.forms[formUuid];
			expect(form.type).toBe("survey");
			expect(form).not.toHaveProperty("caseOperations");
			expect(form).not.toHaveProperty("openCondition");
			expect(form).not.toHaveProperty("closeCondition");
		},
	);

	it("registration → follow-up keeps the own case and clears both conditions", () => {
		const doc = fixture((draft) => {
			draft.forms[REG].openCondition = answered(REG_FLAG, "yes");
			draft.forms[REG].closeCondition = answered(REG_FLAG, "gone");
		});
		const next = land(doc, planFormTypeChange(doc, REG, "followup"));
		expect(next.forms[REG].type).toBe("followup");
		expect(ownOf(next.forms[REG])?.uuid).toBe(OWN_REG);
		expect(next.forms[REG]).not.toHaveProperty("openCondition");
		expect(next.forms[REG]).not.toHaveProperty("closeCondition");
	});

	it("registration → close keeps a close condition that is not every time, and drops one that is", () => {
		const conditional = fixture((draft) => {
			draft.forms[REG].openCondition = answered(REG_FLAG, "yes");
			draft.forms[REG].closeCondition = answered(REG_FLAG, "gone");
		});
		const kept = land(
			conditional,
			planFormTypeChange(conditional, REG, "close"),
		);
		expect(kept.forms[REG].type).toBe("close");
		expect(kept.forms[REG]).not.toHaveProperty("openCondition");
		expect(kept.forms[REG].closeCondition).toEqual(answered(REG_FLAG, "gone"));

		const always = fixture((draft) => {
			draft.forms[REG].closeCondition = { kind: "match-all" };
		});
		const dropped = land(always, planFormTypeChange(always, REG, "close"));
		expect(dropped.forms[REG]).not.toHaveProperty("closeCondition");
		expect(ownOf(dropped.forms[REG])?.uuid).toBe(OWN_REG);
	});

	it("follow-up → registration keeps the own case, names it from the chosen question", () => {
		const doc = fixture();
		const next = land(
			doc,
			planFormTypeChange(doc, FUP, "registration", { nameField: FUP_NOTE }),
		);
		expect(next.forms[FUP].type).toBe("registration");
		expect(ownOf(next.forms[FUP])).toEqual({
			uuid: OWN_FUP,
			id: "patient",
			action: "own",
			name: answerOf(FUP_NOTE),
			writes: [{ property: "note", value: answerOf(FUP_NOTE) }],
		});
	});

	it("follow-up → registration without a name refuses as a survey does", () => {
		expect(planFormTypeChange(fixture(), FUP, "registration")).toEqual({
			ok: false,
			message: CHOOSE_NAME_QUESTION_MESSAGE,
		});
	});

	it.each([
		["a save to the case above it", { via: [{ identifier: "parent" }] }],
		["a save only if changed", { onlyIfChanged: true }],
	] as const)(
		"follow-up → registration refuses an own case with %s",
		(_label, facet) => {
			const doc = fixture((draft) => {
				const own = draft.forms[FUP].caseOperations?.[0];
				if (own?.writes?.[0] !== undefined)
					Object.assign(own.writes[0], structuredClone(facet));
			});
			expect(
				planFormTypeChange(doc, FUP, "registration", { nameField: FUP_NOTE }),
			).toEqual({ ok: false, message: NEW_CASE_WRITE_FACETS_MESSAGE });
			expect(NEW_CASE_WRITE_FACETS_MESSAGE).toBe(
				"A new case has no earlier value or case above it. Remove Save only if changed and any save to a case above it first.",
			);
		},
	);

	it("close → registration drops the close condition", () => {
		const doc = fixture((draft) => {
			draft.forms[CLS].closeCondition = answered(CLS_NOTE, "done");
		});
		const next = land(
			doc,
			planFormTypeChange(doc, CLS, "registration", { nameField: CLS_NOTE }),
		);
		expect(next.forms[CLS].type).toBe("registration");
		expect(next.forms[CLS]).not.toHaveProperty("closeCondition");
		expect(ownOf(next.forms[CLS])?.name).toEqual(answerOf(CLS_NOTE));
	});

	it("close → follow-up keeps the own case and drops the close condition", () => {
		const doc = fixture((draft) => {
			draft.forms[CLS].closeCondition = answered(CLS_NOTE, "done");
		});
		const next = land(doc, planFormTypeChange(doc, CLS, "followup"));
		expect(next.forms[CLS].type).toBe("followup");
		expect(next.forms[CLS]).not.toHaveProperty("closeCondition");
		expect(ownOf(next.forms[CLS])?.uuid).toBe(OWN_CLS);
	});

	it("follow-up → close keeps the own case and its writes", () => {
		const doc = fixture();
		const next = land(doc, planFormTypeChange(doc, FUP, "close"));
		expect(next.forms[FUP].type).toBe("close");
		expect(ownOf(next.forms[FUP])).toEqual(ownOf(doc.forms[FUP]));
	});

	it("leaves a form already of the type unchanged", () => {
		expect(planFormTypeChange(fixture(), FUP, "followup")).toEqual({
			ok: true,
			mutations: [],
		});
	});
});

describe("module case-type changes and form moves", () => {
	it("clearing the module's case type turns its forms into surveys first", () => {
		const doc = fixture();
		const next = commit(doc, [
			...moduleCaseTypeChangeMutations(
				doc,
				HOUSEHOLDS,
				{ kind: "none" },
				undefined,
			),
			{
				kind: "updateModule",
				uuid: HOUSEHOLDS,
				patch: {
					caseType: null,
					caseListConfig: null,
				},
			},
		]);
		expect(next.forms[HOME].type).toBe("survey");
		expect(next.forms[HOME]).not.toHaveProperty("caseOperations");
	});

	it("retyping the module declares what its own cases write on the new type", () => {
		const mutations = moduleCaseTypeChangeMutations(
			fixture(),
			PATIENTS,
			{ kind: "none" },
			"client",
		);
		expect(mutations).toEqual([
			{ kind: "declareCaseType", caseType: "client" },
			expect.objectContaining({
				kind: "addCaseProperty",
				caseType: "client",
				property: expect.objectContaining({ name: "note" }),
			}),
		]);
	});

	it("moving a form to another module declares its own case's writes there", () => {
		const doc = fixture();
		const mutations = moveFormMutations(doc, FUP, HOUSEHOLDS, HOME);
		expect(mutations).toEqual([
			expect.objectContaining({
				kind: "addCaseProperty",
				caseType: "household",
				property: expect.objectContaining({ name: "note" }),
			}),
			{ kind: "moveForm", uuid: FUP, toModuleUuid: HOUSEHOLDS, after: HOME },
		]);
		const next = commit(doc, mutations);
		expect(next.formOrder[HOUSEHOLDS]).toEqual([HOME, FUP]);
		expect(
			next.caseTypes
				?.find((caseType) => caseType.name === "household")
				?.properties.map((property) => property.name),
		).toContain("note");
		// A move within its module declares nothing.
		expect(moveFormMutations(doc, FUP, PATIENTS, null)).toEqual([
			{ kind: "moveForm", uuid: FUP, toModuleUuid: PATIENTS, after: null },
		]);
	});
});
