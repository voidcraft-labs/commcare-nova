// lib/doc/__tests__/repeatCountWraps.test.ts
//
// `planRepeatCountWraps` is the defect 30 rule the fuzz mapping and the
// cutover share: every count the checker refuses as not a whole number is
// wrapped in int(...), and the result passes the real commit gate. Plausible
// failures: a refused count left unwrapped (the gate refuses the batch), an
// admitted count wrapped as well (an edit no author asked for), or a second
// run that wraps again.

import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import { lookupTypeIndex } from "@/lib/commcare/validator/lookupTypeContext";
import { mutationCommitVerdict } from "@/lib/doc/commitVerdicts";
import type { LookupValidationContext } from "@/lib/doc/lookupReferences";
import { planRepeatCountWraps } from "@/lib/doc/repeatCountWraps";
import type { BlueprintDoc } from "@/lib/domain";
import {
	lookupColumnIdSchema,
	lookupTableIdSchema,
} from "@/lib/domain/lookupIds";
import { proseText } from "@/lib/domain/prose";
import type { Uuid } from "@/lib/domain/uuid";
import type { LookupRevision } from "@/lib/lookup/types";

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

/** Count repeats, each over its count text: the refused ones, one per
 * reason, and the whole ones the planner leaves alone. */
const refusedCounts = {
	decimal: "#form/amount",
	text: "#form/words",
	expression: "#form/n div 2",
	halves: "#form/pick",
	table: "#form/from_table",
	cases: "#form/from_cases",
} as const;
const wholeCounts = {
	whole: "#form/n + 1",
	select: "#form/whole_pick",
	wrapped: "int(#form/amount)",
} as const;
const repeatUuid = (name: string): Uuid =>
	testUuid(`repeat-count-wraps-${name}`);

const choices = (field: string, values: readonly string[]) => ({
	kind: "inline" as const,
	options: values.map((value, index) => ({
		uuid: testUuid(`repeat-count-wraps-${field}-${index}`),
		value,
		label: proseText(`Choice ${index + 1}`),
	})),
});

function countsDoc(): BlueprintDoc {
	const repeats = Object.entries({ ...refusedCounts, ...wholeCounts }).map(
		([name, count]) =>
			f({
				uuid: repeatUuid(name),
				id: `rows_${name}`,
				kind: "repeat",
				repeat_mode: "count_bound",
				repeat_count: count,
				children: [f({ id: "note", kind: "text" })],
			}),
	);
	return buildDoc({
		appName: "Counts",
		caseTypes: [
			{ name: "household", properties: [{ name: "case_name", label: "Name" }] },
		],
		modules: [
			{
				name: "Households",
				caseType: "household",
				caseListConfig: caseListConfig([
					{ field: "case_name", header: "Name" },
				]),
				forms: [
					{
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
							f({
								id: "pick",
								kind: "single_select",
								optionsSource: choices("pick", ["1", "2.5"]),
							}),
							f({
								id: "whole_pick",
								kind: "single_select",
								optionsSource: choices("whole_pick", ["1", "2"]),
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
							...repeats,
						],
					},
				],
			},
		],
	});
}

describe("planRepeatCountWraps", () => {
	const doc = countsDoc();
	const tables = lookupTypeIndex(lookup);

	it("starts from a document the gate refuses for its counts alone", () => {
		const verdict = mutationCommitVerdict(doc, [], lookup);
		if (verdict.ok) throw new Error("The refused counts were admitted.");
		expect(new Set(verdict.findings.map((finding) => finding.code))).toEqual(
			new Set(["REPEAT_COUNT_TYPE"]),
		);
		expect(
			verdict.findings.map((finding) => finding.location.fieldUuid).sort(),
		).toEqual(Object.keys(refusedCounts).map(repeatUuid).sort());
	});

	it("wraps each refused count in int(...), and the gate admits the result", () => {
		const mutations = planRepeatCountWraps(doc, tables);
		expect(
			mutations.map((mutation) => "uuid" in mutation && mutation.uuid),
		).toEqual(Object.keys(refusedCounts).map(repeatUuid).sort());
		for (const mutation of mutations) {
			if (mutation.kind !== "updateField" || mutation.targetKind !== "repeat")
				throw new Error("The planner wrote something other than a count.");
			const field = doc.fields[mutation.uuid];
			if (field?.kind !== "repeat" || field.repeat_mode !== "count_bound")
				throw new Error(
					"The planner named a field that isn't a counted repeat.",
				);
			expect(mutation.patch).toEqual({
				repeat_count: { kind: "call", fn: "int", args: [field.repeat_count] },
			});
		}
		const verdict = mutationCommitVerdict(doc, mutations, lookup);
		if (!verdict.ok)
			throw new Error(
				`The wrapped counts were refused: ${verdict.findings.map((finding) => finding.message).join(" ")}`,
			);
		for (const name of Object.keys(wholeCounts))
			expect(verdict.nextDoc.fields[repeatUuid(name)]).toEqual(
				doc.fields[repeatUuid(name)],
			);
	});

	it("plans the same wraps for the same document, and none after them", () => {
		expect(planRepeatCountWraps(doc, tables)).toEqual(
			planRepeatCountWraps(doc, tables),
		);
		const verdict = mutationCommitVerdict(
			doc,
			planRepeatCountWraps(doc, tables),
			lookup,
		);
		if (!verdict.ok) throw new Error("The wrapped counts were refused.");
		expect(planRepeatCountWraps(verdict.nextDoc, tables)).toEqual([]);
	});
});
