// Preview evaluator semantics over a finite fixture corpus. Native Core carrier
// acceptance is established separately by the CommCare wire fixtures.

import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc } from "@/lib/__tests__/docHelpers";
import { lookupTypeIndexFromNaming } from "@/lib/commcare/lookup/naming";
import { lookupOptionsNodeset } from "@/lib/commcare/lookupOptions";
import { serializeWire } from "@/lib/commcare/xpath/wire/serialize";
import type {
	LookupColumnId,
	LookupOptionsSource,
	LookupTableId,
} from "@/lib/domain";
import {
	arith,
	eq,
	gt,
	isBlank,
	literal,
	tableColumn,
	term,
} from "@/lib/domain/expression";
import { slotContext } from "@/lib/domain/expression/context";
import { lookupRowIdSchema } from "@/lib/domain/lookupIds";
import { parseLookupRevision } from "@/lib/lookup/schema";
import type {
	LookupFixtureRow,
	LookupTableDefinition,
} from "@/lib/lookup/types";
import { evaluateRuntime } from "@/lib/preview/xpath/evaluator";
import { XPathNodeSet } from "@/lib/preview/xpath/runtimeValues";
import {
	lookupChoicesFromNodeset,
	type PreviewLookupData,
	previewLookupData,
} from "../lookupEvaluation";
import { lookupXPathInstances } from "../xpathInstances";

const TABLE = "018f0000-0000-7000-8000-000000000001" as LookupTableId;
const COL_CODE = "018f0000-0000-7000-8000-0000000000c1" as LookupColumnId;
const COL_NAME = "018f0000-0000-7000-8000-0000000000c2" as LookupColumnId;
const COL_STOCK = "018f0000-0000-7000-8000-0000000000c3" as LookupColumnId;
const COL_REGION = "018f0000-0000-7000-8000-0000000000c4" as LookupColumnId;

const DEFINITION: LookupTableDefinition = {
	id: TABLE,
	name: "Clinics",
	tag: "clinics",
	definitionRevision: parseLookupRevision("1"),
	columns: [
		{ id: COL_CODE, wireName: "code", label: "Code", dataType: "text" },
		{ id: COL_NAME, wireName: "clinic_name", label: "Name", dataType: "text" },
		{ id: COL_STOCK, wireName: "stock", label: "Stock", dataType: "int" },
		{ id: COL_REGION, wireName: "region", label: "Region", dataType: "text" },
	],
};

function row(
	id: string,
	values: Partial<
		Record<"code" | "clinic_name" | "stock" | "region", string | number>
	>,
): LookupFixtureRow {
	const byColumn: Record<string, string | number> = {};
	if (values.code !== undefined) byColumn[COL_CODE] = values.code;
	if (values.clinic_name !== undefined) byColumn[COL_NAME] = values.clinic_name;
	if (values.stock !== undefined) byColumn[COL_STOCK] = values.stock;
	if (values.region !== undefined) byColumn[COL_REGION] = values.region;
	return { id: lookupRowIdSchema.parse(id), values: byColumn };
}

const ROWS: readonly LookupFixtureRow[] = [
	row("018f0000-0000-7000-8000-0000000000a1", {
		code: "a1",
		clinic_name: "Arua Clinic",
		stock: 4,
		region: "north",
	}),
	row("018f0000-0000-7000-8000-0000000000a2", {
		code: "b2",
		clinic_name: "Bario Health Post",
		stock: 0,
		region: "south",
	}),
	// Missing clinic_name cell + stored-empty region: both read blank.
	row("018f0000-0000-7000-8000-0000000000a3", {
		code: "c3",
		stock: 9,
		region: "",
	}),
];

function data(): PreviewLookupData {
	return previewLookupData({
		projectRevision: parseLookupRevision("7"),
		definitions: [DEFINITION],
		rowsByTable: new Map([[TABLE, ROWS]]),
	});
}

/** The choice question's slot context in a one-form app. */
function choiceContext(
	choices: LookupOptionsSource,
	fixtureData: PreviewLookupData,
) {
	const CHOICE = testUuid("lookup-choice");
	const doc = buildDoc({
		modules: [
			{
				name: "Clinics",
				forms: [
					{
						uuid: testUuid("lookup-form"),
						name: "Visit",
						type: "survey",
						fields: [
							{
								kind: "single_select" as const,
								id: "choice",
								uuid: CHOICE,
								optionsSource: choices,
							},
						],
					},
				],
			},
		],
	});
	const context = slotContext(
		doc,
		{ entity: "field", uuid: CHOICE, slot: "lookup_options_source" },
		lookupTypeIndexFromNaming(fixtureData.naming) ?? new Map(),
	);
	if (context === undefined)
		throw new Error("The lookup fixture has no owning slot.");
	return context;
}

/** The choices as Preview computes them: the form's itemset nodeset printed
 * at the Preview target and evaluated over the fixture instance. */
function evaluateLookupChoices(
	source: LookupOptionsSource,
	fixtureData: PreviewLookupData,
	sortColumn?: LookupColumnId,
) {
	const nodeset = serializeWire(
		lookupOptionsNodeset(source, {
			target: "preview",
			types: choiceContext(source, fixtureData),
			naming: fixtureData.naming,
			instanceScope: "xform",
		}),
		{ target: "preview" },
	).text;
	const instances = lookupXPathInstances(fixtureData);
	return lookupChoicesFromNodeset(
		source,
		fixtureData,
		evaluateRuntime(nodeset, {
			contextPath: "",
			position: undefined,
			getValue: () => undefined,
			resolveXPathInstance: (id) => instances.get(id),
		}),
		sortColumn,
	);
}

function source(filter?: LookupOptionsSource["filter"]): LookupOptionsSource {
	return {
		kind: "lookup",
		tableId: TABLE,
		valueColumnId: COL_CODE,
		labelColumnId: COL_NAME,
		...(filter !== undefined && { filter }),
	};
}

describe("evaluateLookupChoices", () => {
	it("returns every row in authored order when unfiltered", () => {
		const choices = evaluateLookupChoices(source(), data());
		expect(choices).toEqual([
			{
				key: "018f0000-0000-7000-8000-0000000000a1",
				value: "a1",
				label: "Arua Clinic",
			},
			{
				key: "018f0000-0000-7000-8000-0000000000a2",
				value: "b2",
				label: "Bario Health Post",
			},
			{ key: "018f0000-0000-7000-8000-0000000000a3", value: "c3", label: "" },
		]);
	});

	it("filters by same-table column comparison against a literal", () => {
		const choices = evaluateLookupChoices(
			source(eq(term(tableColumn(TABLE, COL_REGION)), literal("north"))),
			data(),
		);
		expect(choices).toEqual([
			{
				key: "018f0000-0000-7000-8000-0000000000a1",
				value: "a1",
				label: "Arua Clinic",
			},
		]);
	});

	it("compares int cells numerically", () => {
		const choices = evaluateLookupChoices(
			source(gt(term(tableColumn(TABLE, COL_STOCK)), literal(2))),
			data(),
		);
		expect(choices.map((c) => c.value)).toEqual(["a1", "c3"]);
	});

	it("distinguishes quotient from real division in the row filter", () => {
		for (const [op, expected] of [
			["quotient", ["a1"]],
			["div", []],
		] as const) {
			const choices = evaluateLookupChoices(
				source(
					eq(
						arith(op, term(tableColumn(TABLE, COL_STOCK)), term(literal(3))),
						literal(1),
					),
				),
				data(),
			);
			expect(choices.map((c) => c.value)).toEqual(expected);
		}
	});

	it("refuses the question when its table has no rows, as Core does", () => {
		// Core's itemset over a table with no rows is an invalid path
		// (emptyInstanceParity.test.ts), and `ItemSetUtils.populateDynamicChoices`
		// throws for it instead of offering no choices.
		const empty = previewLookupData({
			projectRevision: parseLookupRevision("7"),
			definitions: [DEFINITION],
			rowsByTable: new Map([[TABLE, []]]),
		});
		for (const filter of [
			undefined,
			eq(term(tableColumn(TABLE, COL_REGION)), literal("north")),
		])
			expect(() => evaluateLookupChoices(source(filter), empty)).toThrow(
				/which has no rows/,
			);
	});

	it("is-blank matches missing cells and stored-empty cells alike", () => {
		const choices = evaluateLookupChoices(
			source(isBlank(term(tableColumn(TABLE, COL_NAME)))),
			data(),
		);
		expect(choices.map((c) => c.value)).toEqual(["c3"]);
	});

	describe("with a sort column", () => {
		// Labels whose code unit order differs from a locale's, with ties.
		const labels = ["b", "B", "a", "é", "Z", "a", "10", "9", "a"];
		const sortRows = labels.map((label, index) =>
			row(
				`018f0000-0000-7000-8000-0000000001${String(index).padStart(2, "0")}`,
				{
					code: `r${index + 1}`,
					clinic_name: label,
				},
			),
		);
		const sortData = () =>
			previewLookupData({
				projectRevision: parseLookupRevision("7"),
				definitions: [DEFINITION],
				rowsByTable: new Map([[TABLE, sortRows]]),
			});

		it("orders by the column's text code unit by code unit, ties in row order", () => {
			const choices = evaluateLookupChoices(source(), sortData(), COL_NAME);
			expect(choices.map((c) => c.label)).toEqual([
				"10",
				"9",
				"B",
				"Z",
				"a",
				"a",
				"a",
				"b",
				"é",
			]);
			expect(
				choices.filter((c) => c.label === "a").map((c) => c.value),
			).toEqual(["r3", "r6", "r9"]);
		});

		it("keeps the table's row order without one", () => {
			const choices = evaluateLookupChoices(source(), sortData());
			expect(choices.map((c) => c.label)).toEqual(labels);
		});

		it("orders by a column other than the label", () => {
			const choices = evaluateLookupChoices(source(), data(), COL_STOCK);
			expect(choices.map((c) => c.value)).toEqual(["b2", "a1", "c3"]);
		});
	});

	it("throws the validation-bypass invariant for an unknown table", () => {
		const orphan = {
			...source(),
			tableId: "018f0000-0000-7000-8000-00000000dead" as LookupTableId,
		};
		// Printing the itemset already refuses a table the naming lacks; the
		// read-back refuses one the snapshot lacks.
		expect(() =>
			lookupChoicesFromNodeset(orphan, data(), new XPathNodeSet([])),
		).toThrow(/not in the loaded fixture snapshot/);
	});

	it("throws the validation-bypass invariant for an unknown column", () => {
		const orphan = {
			...source(),
			valueColumnId: "018f0000-0000-7000-8000-00000000dead" as LookupColumnId,
		};
		expect(() => evaluateLookupChoices(orphan, data())).toThrow(
			/not declared on lookup table/,
		);
	});
});
