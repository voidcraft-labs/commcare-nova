// components/builder/shared/__tests__/choiceValueModel.test.ts
//
// "A choice of this question" over a real case-change condition: a form
// answer from a select with written choices is compared with one of them,
// stored as a `choice`. The source is offered only opposite such a question,
// every value it seeds is admitted by the slot's own verdict, and moving a
// comparison between questions keeps what it compares with. No renderer.

import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { expressionEditVerdict } from "@/lib/doc/hooks/predicateVerdicts";
import type { BlueprintDoc, Uuid } from "@/lib/domain";
import {
	type Choice,
	type Expression,
	type ExpressionContext,
	eq,
	formField,
	isIn,
	literal,
	slotContext,
	term,
} from "@/lib/domain/expression";
import {
	asChoiceOf,
	asLiteral,
	CHOICE_SOURCE_LABEL,
	choiceOf,
	firstUntakenChoice,
	retargetSelectionValues,
	staticSelectSubject,
} from "../choiceValueModel";
import { replaceComparisonSubject } from "../comparisonModel";
import { editorAxesOf } from "../editorAxes";
import type { PredicateEditContext } from "../editorSchemas";
import {
	buildTermDefault,
	CHOICE_SOURCE_UNAVAILABLE_REASON,
	computeModeAdmission,
	termMode,
	termModeLabel,
} from "../termEditorModel";

const MODULE = testUuid("choice-module");
const FORM = testUuid("choice-form");
const VISIT = testUuid("choice-visit-type");
const NOTE = testUuid("choice-note");
const HOUSEHOLD = testUuid("choice-household");
const OPERATION = testUuid("choice-operation");

function fixture(): BlueprintDoc {
	const doc = buildDoc({
		caseTypes: [{ name: "patient", properties: [] }],
		modules: [
			{
				uuid: MODULE,
				name: "Patients",
				caseType: "patient",
				forms: [
					{
						uuid: FORM,
						name: "Visit",
						type: "followup",
						fields: [
							f({
								uuid: VISIT,
								id: "visit_type",
								kind: "single_select",
								options: [
									{ value: "yes", label: "Yes" },
									{ value: "no", label: "No" },
								],
							}),
							f({ uuid: NOTE, id: "note", kind: "text" }),
							f({
								uuid: HOUSEHOLD,
								id: "household",
								kind: "single_select",
								optionsSource: {
									kind: "cases",
									caseType: "patient",
									labelProperty: "case_name",
								},
							}),
						],
					},
				],
			},
		],
	});
	doc.forms[FORM].caseOperations = [
		{
			uuid: OPERATION,
			id: "update_patient",
			action: "update",
			caseType: "patient",
			target: { kind: "session" },
		},
	];
	return doc;
}

const DOC = fixture();
const CONTEXT: ExpressionContext = (() => {
	const context = slotContext(
		DOC,
		{
			entity: "form",
			uuid: FORM,
			slot: "case_operation_condition",
			member: { operationUuid: OPERATION },
		},
		new Map(),
	);
	if (context === undefined) throw new Error("The fixture has no slot.");
	return context;
})();
const EDIT: PredicateEditContext = {
	expressionContext: CONTEXT,
	caseTypes: CONTEXT.facts.caseTypes,
	currentCaseType: "patient",
	knownInputs: [],
	...editorAxesOf(CONTEXT),
};

function optionUuid(value: string): Uuid {
	const field = DOC.fields[VISIT];
	if (!("optionsSource" in field) || field.optionsSource.kind !== "inline")
		throw new Error("The visit type has written choices.");
	const option = field.optionsSource.options.find(
		(candidate) => candidate.value === value,
	);
	if (option === undefined) throw new Error(`No choice ${value}.`);
	return option.uuid;
}

const VISIT_ANSWER = term(formField(VISIT));
const NOTE_ANSWER = term(formField(NOTE));
const admits = (candidate: Expression) =>
	expressionEditVerdict(candidate, CONTEXT).ok;

describe("A choice of this question", () => {
	it("is a choice source only opposite a question with written choices", () => {
		expect(
			staticSelectSubject(VISIT_ANSWER, CONTEXT)?.options.map(
				({ uuid, value }) => ({ uuid, value }),
			),
		).toEqual([
			{ uuid: optionUuid("yes"), value: "yes" },
			{ uuid: optionUuid("no"), value: "no" },
		]);
		expect(staticSelectSubject(NOTE_ANSWER, CONTEXT)).toBeUndefined();
		// Choices that come from cases are not written in the form.
		expect(
			staticSelectSubject(term(formField(HOUSEHOLD)), CONTEXT),
		).toBeUndefined();
	});

	it("is offered and seeded only where it can be committed", () => {
		const subject = staticSelectSubject(VISIT_ANSWER, CONTEXT);
		const admitExpressionChange = (_path: unknown, next: Expression) => {
			const verdict = expressionEditVerdict(eq(VISIT_ANSWER, next), CONTEXT);
			return verdict.ok
				? ({ admitted: true } as const)
				: ({ admitted: false, reason: verdict.reason } as const);
		};
		const offered = computeModeAdmission(
			{
				...EDIT,
				userProperties: [],
				choiceSubject: subject,
				admitExpressionChange,
			},
			{ accepts: "any" },
			["right"],
		);
		expect(offered.choice).toEqual({ admitted: true });
		const seed = buildTermDefault(
			"choice",
			{ ...EDIT, userProperties: [], choiceSubject: subject },
			{ accepts: "any" },
		);
		expect(seed).toEqual(choiceOf(VISIT, optionUuid("yes")));
		expect(termMode(seed)).toBe("choice");
		expect(termModeLabel("choice", "value")).toBe(CHOICE_SOURCE_LABEL);
		expect(admits(eq(VISIT_ANSWER, term(seed)))).toBe(true);

		// Opposite a question without written choices it is not offered.
		expect(
			computeModeAdmission(
				{ ...EDIT, userProperties: [] },
				{ accepts: "any" },
				["right"],
			).choice,
		).toEqual({ admitted: false, reason: CHOICE_SOURCE_UNAVAILABLE_REASON });
	});

	it("keeps what a comparison compares with when its question changes", () => {
		const onNote = eq(NOTE_ANSWER, term(literal("no")));
		const onVisit = replaceComparisonSubject(onNote, VISIT_ANSWER, EDIT);
		expect(onVisit).toEqual(
			eq(VISIT_ANSWER, term(choiceOf(VISIT, optionUuid("no")))),
		);
		expect(admits(onVisit)).toBe(true);
		// Back on a question without written choices, the choice becomes its
		// current value.
		expect(
			replaceComparisonSubject(
				onVisit as Extract<Expression, { kind: "eq" }>,
				NOTE_ANSWER,
				EDIT,
			),
		).toEqual(onNote);
	});

	it("turns a membership's values into choices and back", () => {
		const subject = staticSelectSubject(VISIT_ANSWER, CONTEXT);
		if (subject === undefined) throw new Error("The visit type has choices.");
		const values = retargetSelectionValues(
			[literal("no"), literal("yes")],
			subject,
			CONTEXT,
		) as [Choice, Choice];
		expect(values).toEqual([
			choiceOf(VISIT, optionUuid("no")),
			choiceOf(VISIT, optionUuid("yes")),
		]);
		expect(admits(isIn(VISIT_ANSWER, ...values))).toBe(true);
		expect(retargetSelectionValues(values, undefined, CONTEXT)).toEqual([
			literal("no"),
			literal("yes"),
		]);
	});

	it("keeps a written value that names no choice exactly as written", () => {
		const subject = staticSelectSubject(VISIT_ANSWER, CONTEXT);
		if (subject === undefined) throw new Error("The visit type has choices.");
		// Only an exact match becomes a choice: "maybe", "No" and a blank
		// name none, and a value that is not text (a switch's "any other
		// value" is a null) is never read as one.
		const written = [
			literal("no"),
			literal("maybe"),
			literal("No"),
			literal(""),
			literal(null),
			literal(3),
		];
		expect(retargetSelectionValues(written, subject, CONTEXT)).toEqual([
			choiceOf(VISIT, optionUuid("no")),
			...written.slice(1),
		]);
		for (const item of written.slice(1))
			expect(asChoiceOf(item, subject, CONTEXT)).toBeUndefined();

		// A comparison moved onto the question keeps its written value too.
		const onNote = eq(NOTE_ANSWER, term(literal("maybe")));
		expect(replaceComparisonSubject(onNote, VISIT_ANSWER, EDIT)).toEqual(
			eq(VISIT_ANSWER, term(literal("maybe"))),
		);
	});

	it("seeds a new value with the first choice not already taken", () => {
		const subject = staticSelectSubject(VISIT_ANSWER, CONTEXT);
		if (subject === undefined) throw new Error("The visit type has choices.");
		expect(firstUntakenChoice(subject, [])).toEqual(
			choiceOf(VISIT, optionUuid("yes")),
		);
		expect(
			firstUntakenChoice(subject, [choiceOf(VISIT, optionUuid("yes"))]),
		).toEqual(choiceOf(VISIT, optionUuid("no")));
		// Every choice taken: the first again, still a choice of the question.
		expect(
			firstUntakenChoice(subject, [
				choiceOf(VISIT, optionUuid("yes")),
				choiceOf(VISIT, optionUuid("no")),
			]),
		).toEqual(choiceOf(VISIT, optionUuid("yes")));
	});

	it("reads a choice whose option is gone as no value rather than a guess", () => {
		const gone = choiceOf(VISIT, testUuid("choice-gone"));
		expect(asLiteral(gone, CONTEXT)).toEqual(literal(""));
		const subject = staticSelectSubject(VISIT_ANSWER, CONTEXT);
		if (subject === undefined) throw new Error("The visit type has choices.");
		// A stored choice of the question stays as it is, so the person sees
		// what to repair.
		expect(asChoiceOf(gone, subject, CONTEXT)).toBe(gone);
	});
});
