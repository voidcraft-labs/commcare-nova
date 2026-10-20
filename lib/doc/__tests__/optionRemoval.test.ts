import { produce } from "immer";
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, caseListConfig } from "@/lib/__tests__/docHelpers";
import { mutationCommitVerdict } from "@/lib/doc/commitVerdicts";
import { projectFormExpression } from "@/lib/doc/expressionText";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { applyMutations } from "@/lib/doc/mutations";
import { buildReferenceIndex } from "@/lib/doc/referenceIndex";
import type { Mutation } from "@/lib/doc/types";
import { type BlueprintDoc, proseText, type SelectOption } from "@/lib/domain";
import { eq, formField, term } from "@/lib/domain/expression/builders";
import type { Choice } from "@/lib/domain/expression/types";
import { projectProseTemplate } from "@/lib/domain/prose";
import { optionRemovalBlocker } from "../optionRemoval";
import { assertAdmittedDoc } from "./admittedDoc";

const MODULE = testUuid("removal-module");
const FORM = testUuid("removal-form");
const SELECT = testUuid("removal-select");
const READER = testUuid("removal-reader");
const YES = testUuid("removal-yes");
const NO = testUuid("removal-no");
const MAYBE = testUuid("removal-maybe");
const OP = testUuid("removal-operation");

const choiceOf = (option: typeof YES): Choice => ({
	kind: "choice",
	field: SELECT,
	options: [option],
});
const OPTIONS: SelectOption[] = [
	{ uuid: YES, value: "yes", label: proseText("Yes") },
	{ uuid: NO, value: "no", label: proseText("No") },
	{ uuid: MAYBE, value: "maybe", label: proseText("Maybe") },
];

function fixture(configure?: (doc: BlueprintDoc) => void): BlueprintDoc {
	return buildDoc(
		{
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
									id: "visit_type",
									label: "Visit type",
									options: OPTIONS,
									default_value: term(choiceOf(YES)),
								},
								{
									uuid: READER,
									kind: "text",
									id: "note",
									relevant: eq(formField(SELECT), term(choiceOf(NO))),
								},
							],
						},
					],
				},
			],
		},
		configure,
	);
}

const blocker = (doc: BlueprintDoc, option: typeof YES) =>
	optionRemovalBlocker(
		doc,
		option,
		(template) => projectProseTemplate(template, doc).text,
	);

function withoutOption(option: typeof YES): Mutation {
	return {
		kind: "updateField",
		uuid: SELECT,
		targetKind: "single_select",
		patch: {
			optionsSource: {
				kind: "inline",
				options: OPTIONS.filter((candidate) => candidate.uuid !== option),
			},
		},
	} as Mutation;
}

describe("removing a choice a formula names", () => {
	it("names the reader the reference index holds, and the gate refuses the same removal", () => {
		const doc = fixture();
		assertAdmittedDoc(doc);
		expect(blocker(doc, YES)).toBe(
			"This choice is the starting value of Visit type. You can change that first.",
		);
		// A reader without a label is named by its id.
		expect(blocker(doc, NO)).toBe(
			"note's display condition compares with this choice. You can change that first.",
		);
		expect(blocker(doc, MAYBE)).toBeUndefined();
		for (const option of [YES, NO]) {
			const verdict = mutationCommitVerdict(
				doc,
				[withoutOption(option)],
				LOOKUP_CONTEXT_UNAVAILABLE,
			);
			expect(verdict.ok).toBe(false);
		}
		expect(
			mutationCommitVerdict(
				doc,
				[withoutOption(MAYBE)],
				LOOKUP_CONTEXT_UNAVAILABLE,
			).ok,
		).toBe(true);
	});

	it("names a case change by its form", () => {
		const doc = fixture((draft) => {
			draft.forms[FORM].caseOperations = [
				{
					uuid: OP,
					id: "save_note",
					action: "update",
					caseType: "patient",
					target: { kind: "session" },
					condition: eq(formField(SELECT), term(choiceOf(MAYBE))),
				},
			];
		});
		doc.refIndex = buildReferenceIndex(doc);
		expect(blocker(doc, MAYBE)).toBe(
			"A case change in Review compares with this choice. You can change that first.",
		);
	});

	it("keeps a reader connected when the choice's value changes, rewriting nothing", () => {
		const doc = fixture();
		const next = produce(doc, (draft) => {
			applyMutations(draft, [
				{
					kind: "updateOption",
					fieldUuid: SELECT,
					uuid: NO,
					option: { uuid: NO, value: "n", label: proseText("No") },
				},
			]);
		});
		const relevant = (d: BlueprintDoc) => {
			const reader = d.fields[READER];
			if (reader?.kind !== "text" || reader.relevant === undefined)
				throw new Error("Fixture requires the reader's condition");
			return reader.relevant;
		};
		expect(relevant(next)).toEqual(relevant(doc));
		expect(
			projectFormExpression(
				next,
				{ entity: "field", uuid: READER, slot: "relevant" },
				relevant(next),
				"unavailable",
			).text,
		).toBe("#form/visit_type = 'n'");
	});
});
