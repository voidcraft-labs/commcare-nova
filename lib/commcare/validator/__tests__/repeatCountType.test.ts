// lib/commcare/validator/__tests__/repeatCountType.test.ts
//
// A repeat's count is a whole number at the commit gate. CommCare reads a
// count as `IntegerData().cast(count.uncast())` (commcare-core
// `FormEntryModel.createModelForGroup`, `FormDef.canCreateRepeat`), which is
// `Integer.parseInt`, and stops the form on anything it cannot read. The
// checker refuses such a count, and the gate presents it as
// `REPEAT_COUNT_TYPE` at the repeat's count. Plausible failures: a refused
// count committed, a finding located away from the count, or a choice edit
// that breaks a count the select feeds committed because the scoped gate
// did not re-check the form.

import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import {
	buildDoc,
	caseListConfig,
	f,
	parseFixtureExpression,
} from "@/lib/__tests__/docHelpers";
import {
	mutationCommitVerdict,
	mutationCommitVerdictWithPrevalidation,
} from "@/lib/doc/commitVerdicts";
import { incrementalValidationScope } from "@/lib/doc/incrementalValidationScope";
import type { LookupValidationContext } from "@/lib/doc/lookupReferences";
import type { Mutation } from "@/lib/doc/types";
import { userFacingError } from "@/lib/doc/userFacingErrors";
import type { BlueprintDoc } from "@/lib/domain";
import {
	lookupColumnIdSchema,
	lookupTableIdSchema,
} from "@/lib/domain/lookupIds";
import { proseText } from "@/lib/domain/prose";
import type { LookupRevision } from "@/lib/lookup/types";
import type { ValidationError } from "../errors";

const ids = {
	module: testUuid("repeat-count-type-module"),
	form: testUuid("repeat-count-type-form"),
	count: testUuid("repeat-count-type-count"),
	pick: testUuid("repeat-count-type-pick"),
};
const tableId = lookupTableIdSchema.parse(
	"018f3e8a-7b2c-7def-8abc-1234567890ab",
);
const valueColumn = lookupColumnIdSchema.parse(
	"018f3e8a-7b2c-7def-8abc-1234567890ad",
);
const labelColumn = lookupColumnIdSchema.parse(
	"018f3e8a-7b2c-7def-8abc-1234567890ae",
);
const revision = "1" as LookupRevision;
const lookup: LookupValidationContext = {
	kind: "available",
	projectId: "default-project",
	projectRevision: revision,
	definitions: [
		{
			id: tableId,
			name: "Sizes",
			tag: "sizes",
			definitionRevision: revision,
			columns: [
				{ id: valueColumn, wireName: "value", label: "Value", dataType: "int" },
				{
					id: labelColumn,
					wireName: "label",
					label: "Label",
					dataType: "text",
				},
			],
		},
	],
};

const choices = (field: string, values: readonly string[]) => ({
	kind: "inline" as const,
	options: values.map((value, index) => ({
		uuid: testUuid(`repeat-count-type-${field}-choice-${index}`),
		value,
		label: proseText(`Choice ${index + 1}`),
	})),
});

/** A registration form with a question of each kind a count might read and
 * a count repeat whose count is `count`. */
function countDoc(count = "2", pickValues = ["1", "2"]): BlueprintDoc {
	return buildDoc({
		appName: "Counts",
		caseTypes: [
			{ name: "household", properties: [{ name: "case_name", label: "Name" }] },
		],
		modules: [
			{
				uuid: ids.module,
				name: "Households",
				caseType: "household",
				caseListConfig: caseListConfig([
					{ field: "case_name", header: "Name" },
				]),
				forms: [
					{
						uuid: ids.form,
						name: "Register",
						type: "registration",
						fields: [
							f({
								id: "name",
								kind: "text",
								caseWrite: { caseType: "household", property: "case_name" },
							}),
							f({ id: "n", kind: "int" }),
							f({ id: "amount", kind: "decimal" }),
							f({ id: "words", kind: "text" }),
							f({ id: "visit", kind: "date" }),
							f({
								id: "many",
								kind: "multi_select",
								optionsSource: choices("many", ["1", "2"]),
							}),
							f({
								uuid: ids.pick,
								id: "pick",
								kind: "single_select",
								optionsSource: choices("pick", pickValues),
							}),
							f({
								id: "from_table",
								kind: "single_select",
								optionsSource: {
									kind: "lookup",
									tableId,
									valueColumnId: valueColumn,
									labelColumnId: labelColumn,
								},
							}),
							f({
								id: "from_cases",
								kind: "single_select",
								optionsSource: {
									kind: "cases",
									caseType: "household",
									labelProperty: "case_name",
								},
							}),
							f({
								uuid: ids.count,
								id: "members",
								kind: "repeat",
								repeat_mode: "count_bound",
								repeat_count: count,
								children: [f({ id: "member", kind: "text" })],
							}),
						],
					},
				],
			},
		],
	});
}

/** `source` parsed in the count slot of `doc`, as an editor stores it. */
const setCount = (doc: BlueprintDoc, source: string): Mutation[] => [
	{
		kind: "updateField",
		uuid: ids.count,
		targetKind: "repeat",
		patch: {
			repeat_count: parseFixtureExpression(
				doc,
				{ entity: "field", uuid: ids.count, slot: "repeat_count" },
				source,
			),
		},
	},
];

function refusal(doc: BlueprintDoc, mutations: Mutation[]): ValidationError {
	const verdict = mutationCommitVerdict(doc, mutations, lookup);
	if (verdict.ok)
		throw new Error("The gate admitted a count it should refuse.");
	expect(verdict.findings.map((finding) => finding.code)).toEqual([
		"REPEAT_COUNT_TYPE",
	]);
	return verdict.findings[0] as ValidationError;
}

describe("REPEAT_COUNT_TYPE at the commit gate", () => {
	const doc = countDoc();

	it("starts from an admitted document", () => {
		expect(mutationCommitVerdict(doc, [], lookup).ok).toBe(true);
	});

	it.each([
		{ source: "#form/amount", type: "decimal", words: "a decimal number" },
		{ source: "#form/words", type: "text", words: "text" },
		{ source: "#form/many", type: "multi_select", words: "a list of choices" },
		{ source: "#form/visit", type: "date", words: "a date" },
		{ source: "2.5", type: "decimal", words: "a decimal number" },
		{ source: "#form/n div 2", type: "decimal", words: "a decimal number" },
	])(
		"refuses $source as $words at the repeat's count",
		({ source, type, words }) => {
			const finding = refusal(doc, setCount(doc, source));
			const message = `The count for "members" can be ${words}, and a repeat needs a whole number of rows. CommCare stops the form at a count that isn't whole. You can wrap the count in int(...) to keep its whole part.`;
			expect(finding.message).toBe(message);
			expect(finding.location).toMatchObject({
				formUuid: ids.form,
				fieldUuid: ids.count,
				fieldId: "members",
				field: "repeat_count",
			});
			expect(finding.details).toMatchObject({
				reason: "whole-number-count",
				countType: type,
				repeatId: "members",
			});
			expect(userFacingError(finding)).toBe(message);
		},
	);

	it("refuses a single select with a choice that isn't whole, naming it", () => {
		const halves = countDoc("2", ["1", "2.5"]);
		const finding = refusal(halves, setCount(halves, "#form/pick"));
		const message = `"members" counts its rows from "pick", and the choice "2.5" isn't a whole number, so CommCare would stop the form when a worker picks it. You can give that choice a whole-number value, or wrap the count in int(...).`;
		expect(finding.message).toBe(message);
		expect(finding.location).toMatchObject({
			fieldUuid: ids.count,
			field: "repeat_count",
		});
		expect(finding.details).toMatchObject({
			reason: "count-choice-not-whole",
			select: "pick",
			selectUuid: ids.pick,
			value: "2.5",
		});
		expect(userFacingError(finding)).toBe(message);
	});

	it.each([
		{ source: "#form/from_table", from: "a data table", kind: "lookup" },
		{ source: "#form/from_cases", from: "the worker's cases", kind: "cases" },
	])(
		"refuses a select whose choices come from $from",
		({ source, from, kind }) => {
			const finding = refusal(doc, setCount(doc, source));
			const select = source.slice("#form/".length);
			const message = `"members" counts its rows from "${select}", whose choices come from ${from}, so Nova can't tell that each one is a whole number. You can wrap the count in int(...) to keep its whole part.`;
			expect(finding.message).toBe(message);
			expect(finding.location).toMatchObject({
				fieldUuid: ids.count,
				field: "repeat_count",
			});
			expect(finding.details).toMatchObject({
				reason: "count-choices-unknown",
				select,
				source: kind,
			});
			expect(userFacingError(finding)).toBe(message);
		},
	);

	it.each([
		"#form/n",
		"#form/n + 1",
		"int(#form/amount)",
		"count(#form/many)",
		"#form/pick",
		"int(#form/from_table)",
		// The parser stores the literal 2.0 as the number 2.
		"2.0",
	])("admits the whole-number count %s", (source) => {
		expect(mutationCommitVerdict(doc, setCount(doc, source), lookup).ok).toBe(
			true,
		);
	});

	describe("a choice edit under a count that reads its select", () => {
		const doc = countDoc("#form/pick", ["1", "2"]);
		const setChoices = (values: readonly string[]): Mutation[] => [
			{
				kind: "updateField",
				uuid: ids.pick,
				targetKind: "single_select",
				patch: { optionsSource: choices("pick", values) },
			},
		];

		it("starts admitted, and re-checks the select's form in the scoped gate", () => {
			expect(mutationCommitVerdict(doc, [], lookup).ok).toBe(true);
			const candidate = mutationCommitVerdict(
				doc,
				setChoices(["1", "3"]),
				lookup,
			);
			if (!candidate.ok) throw new Error("The whole-number edit was refused.");
			const scope = incrementalValidationScope(
				doc,
				setChoices(["1", "3"]),
				candidate.nextDoc,
			);
			expect(scope).toBeDefined();
			expect(scope?.formUuids?.has(ids.form)).toBe(true);
		});

		it("refuses a choice that makes the count not whole", () => {
			for (const verdict of [
				mutationCommitVerdict(doc, setChoices(["1", "2.5"]), lookup),
				mutationCommitVerdictWithPrevalidation(
					doc,
					setChoices(["1", "2.5"]),
					lookup,
				),
			]) {
				if (verdict.ok) throw new Error("The breaking choice edit committed.");
				expect(verdict.findings.map((finding) => finding.code)).toEqual([
					"REPEAT_COUNT_TYPE",
				]);
				expect(verdict.findings[0]?.details).toMatchObject({
					reason: "count-choice-not-whole",
					value: "2.5",
				});
			}
		});

		it("admits a choice edit that keeps every value whole", () => {
			expect(
				mutationCommitVerdictWithPrevalidation(
					doc,
					setChoices(["1", "3"]),
					lookup,
				).ok,
			).toBe(true);
		});
	});
});
