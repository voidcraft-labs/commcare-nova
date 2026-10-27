import { produce } from "immer";
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, caseListConfig } from "@/lib/__tests__/docHelpers";
import { mutationCommitVerdict } from "@/lib/doc/commitVerdicts";
import { withChoicePreservation } from "@/lib/doc/kindConversionCascade";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { applyMutations } from "@/lib/doc/mutations";
import { buildReferenceIndex } from "@/lib/doc/referenceIndex";
import type { Mutation } from "@/lib/doc/types";
import { type BlueprintDoc, expressionSlotValues } from "@/lib/domain";
import { eq, literal, term } from "@/lib/domain/expression/builders";
import type { Choice } from "@/lib/domain/expression/types";
import { walkExpression } from "@/lib/domain/expression/walk";
import { assertAdmittedDoc } from "./admittedDoc";

const MODULE = testUuid("preserve-module");
const FORM = testUuid("preserve-form");
const NEXT = testUuid("preserve-next-form");
const SELECT = testUuid("preserve-select");
const READER = testUuid("preserve-reader");
const YES = testUuid("preserve-yes");
const NO = testUuid("preserve-no");
const OP = testUuid("preserve-operation");
const choice: Choice = { kind: "choice", field: SELECT, options: [YES] };
const condition = eq(choice, literal("yes"));

function fixture(): BlueprintDoc {
	return buildDoc({
		caseTypes: [
			{ name: "patient", properties: [{ name: "note", label: "Note" }] },
		],
		modules: [
			{
				uuid: MODULE,
				name: "Patients",
				caseType: "patient",
				caseListConfig: caseListConfig([
					{ field: "case_name", header: "Name" },
				]),
				forms: [
					{
						uuid: FORM,
						name: "Review",
						type: "followup",
						fields: [
							{
								uuid: SELECT,
								kind: "single_select",
								id: "status",
								options: [
									{ uuid: YES, value: "yes", label: "Yes" },
									{ uuid: NO, value: "no", label: "No" },
								],
							},
							{
								uuid: READER,
								kind: "text",
								id: "note",
								default_value: term(choice),
								relevant: condition,
							},
						],
					},
					{
						uuid: NEXT,
						name: "Next",
						type: "survey",
						fields: [{ kind: "text", id: "details" }],
					},
				],
			},
		],
	});
}
function change(doc: BlueprintDoc, authored: Mutation[]) {
	const planned = withChoicePreservation(doc, authored);
	const next = produce(doc, (draft) => {
		applyMutations(draft, planned.mutations);
	});
	return { ...planned, next };
}
const convert: Mutation = {
	kind: "convertField",
	uuid: SELECT,
	toKind: "text",
};

function choices(doc: BlueprintDoc) {
	let count = 0;
	for (const [entity, values] of [
		["field", doc.fields],
		["form", doc.forms],
		["module", doc.modules],
	] as const) {
		for (const owner of Object.values(values)) {
			for (const { expression } of expressionSlotValues(doc, {
				entity,
				uuid: owner.uuid,
			})) {
				walkExpression(expression, {
					visitTerm: (node) => {
						if (node.kind === "choice") count++;
					},
				});
			}
		}
	}
	return count;
}

describe("choice preservation during field edits", () => {
	it("keeps surviving values when an inline select becomes text, through the real commit gate", () => {
		const doc = fixture();
		assertAdmittedDoc(doc);
		const planned = withChoicePreservation(doc, [convert]);
		expect(planned.preservedChoiceCount).toBe(2);
		const verdict = mutationCommitVerdict(
			doc,
			planned.mutations,
			LOOKUP_CONTEXT_UNAVAILABLE,
		);
		expect(verdict.ok ? [] : verdict.findings).toEqual([]);
		expect(choices(verdict.nextDoc)).toBe(0);
		expect(verdict.nextDoc.fields[READER]).toMatchObject({
			default_value: term(literal("yes")),
			relevant: eq(literal("yes"), literal("yes")),
		});
	});

	it("rewrites admitted field, operation, and Connect carriers", () => {
		const doc = fixture();
		doc.forms[FORM].caseOperations = [
			{
				uuid: OP,
				id: "save_note",
				action: "update",
				caseType: "patient",
				target: { kind: "session" },
				condition,
				writes: [{ property: "note", value: term(choice), condition }],
			},
		];
		doc.connectType = "deliver";
		// A Connect app runs on Android alone.
		doc.appSettings = { ...doc.appSettings, runsOnlyOn: "android" };
		doc.forms[FORM].connect = {
			deliver_unit: {
				id: "visit",
				name: "Visit",
				entity_id: term(choice),
				entity_name: term(choice),
			},
		};
		doc.refIndex = buildReferenceIndex(doc);
		assertAdmittedDoc(doc);
		const before = choices(doc);
		const planned = change(doc, [convert]);
		expect(before).toBe(7);
		expect(planned.preservedChoiceCount).toBe(before);
		expect(choices(planned.next)).toBe(0);
		const admitted = mutationCommitVerdict(
			doc,
			planned.mutations,
			LOOKUP_CONTEXT_UNAVAILABLE,
		);
		expect(admitted.ok ? [] : admitted.findings).toEqual([]);
		expect(
			planned.next.forms[FORM].caseOperations?.[0].writes?.[0],
		).toMatchObject({ property: "note", value: term(literal("yes")) });
	});

	it("respects a formula replaced in the same batch and preserves a newly authored reader", () => {
		const doc = fixture();
		const added = testUuid("preserve-new-reader");
		const planned = change(doc, [
			convert,
			{
				kind: "updateField",
				uuid: READER,
				targetKind: "text",
				patch: {
					default_value: term(literal("replacement")),
					relevant: undefined,
				},
			},
			{
				kind: "addField",
				parentUuid: FORM,
				field: {
					uuid: added,
					id: "new_note",
					kind: "text",
					label: { parts: [{ kind: "text", text: "New note" }] },
					default_value: term(choice),
				},
			},
		]);
		expect(planned.preservedChoiceCount).toBe(1);
		expect(planned.next.fields[READER]).toMatchObject({
			default_value: term(literal("replacement")),
		});
		expect(planned.next.fields[added]).toMatchObject({
			default_value: term(literal("yes")),
		});
	});

	it("preserves an offered choice when an inline source becomes case-backed", () => {
		const doc = fixture();
		const planned = withChoicePreservation(doc, [
			{
				kind: "updateField",
				uuid: SELECT,
				targetKind: "single_select",
				patch: {
					optionsSource: {
						kind: "cases",
						caseType: "patient",
						labelProperty: "case_name",
					},
				},
			},
		]);
		const verdict = mutationCommitVerdict(
			doc,
			planned.mutations,
			LOOKUP_CONTEXT_UNAVAILABLE,
		);
		expect(verdict.ok ? [] : verdict.findings).toEqual([]);
		expect(planned.preservedChoiceCount).toBe(2);
		expect(choices(verdict.nextDoc)).toBe(0);
	});

	it("leaves inline-source changes and field deletion to their ordinary admission rules", () => {
		const doc = fixture();
		const select = doc.fields[SELECT];
		if (select.kind !== "single_select")
			throw new Error("Fixture requires a select");
		const same = change(doc, [
			{
				kind: "updateField",
				uuid: SELECT,
				targetKind: "single_select",
				patch: { optionsSource: select.optionsSource },
			},
		]);
		expect(same.preservedChoiceCount).toBe(0);
		expect(choices(same.next)).toBe(2);
		const deletion = change(doc, [{ kind: "removeField", uuid: SELECT }]);
		expect(deletion.preservedChoiceCount).toBe(0);
	});
});
