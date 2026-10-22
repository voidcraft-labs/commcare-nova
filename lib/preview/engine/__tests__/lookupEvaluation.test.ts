// Preview evaluator semantics over a finite fixture corpus. Native Core carrier
// acceptance is established separately by the CommCare wire fixtures.

import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc } from "@/lib/__tests__/docHelpers";
import { lookupTypeIndexFromNaming } from "@/lib/commcare/lookup/naming";
import { toWire } from "@/lib/commcare/xpath/wire/fromExpression";
import { serializeWire } from "@/lib/commcare/xpath/wire/serialize";
import type {
	LookupColumnId,
	LookupOptionsSource,
	LookupTableId,
	Uuid,
} from "@/lib/domain";
import {
	and,
	arith,
	eq,
	formField,
	gt,
	isBlank,
	literal,
	qualifiedLiteral,
	tableColumn,
	tableLookup,
	term,
} from "@/lib/domain/expression";
import { slotContext } from "@/lib/domain/expression/context";
import type { Expression } from "@/lib/domain/expression/types";
import { lookupRowIdSchema } from "@/lib/domain/lookupIds";
import { parseLookupRevision } from "@/lib/lookup/schema";
import type {
	LookupFixtureRow,
	LookupTableDefinition,
} from "@/lib/lookup/types";
import { evaluate } from "@/lib/preview/xpath/evaluator";
import type { EvalContext } from "@/lib/preview/xpath/types";
import {
	evaluateLookupChoices as evaluateChoices,
	evaluateTableLookup as evaluateLookup,
	foldTableLookupsInExpression as foldExpression,
	foldTableLookupsInPredicate as foldPredicate,
	type LookupEvaluationBindings,
	type PreviewLookupData,
	previewLookupData,
} from "../lookupEvaluation";

const TABLE = "018f0000-0000-7000-8000-000000000001" as LookupTableId;
const COL_CODE = "018f0000-0000-7000-8000-0000000000c1" as LookupColumnId;
const COL_NAME = "018f0000-0000-7000-8000-0000000000c2" as LookupColumnId;
const COL_STOCK = "018f0000-0000-7000-8000-0000000000c3" as LookupColumnId;
const COL_REGION = "018f0000-0000-7000-8000-0000000000c4" as LookupColumnId;
const FIELD_UUID = "018f0000-0000-7000-8000-00000000f001" as Uuid;

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

function lookupContext(
	expression: Expression,
	fixtureData: PreviewLookupData,
	choices?: LookupOptionsSource,
) {
	const FORM = testUuid("lookup-form"),
		VALUE = testUuid("lookup-value"),
		CHOICE = testUuid("lookup-choice");
	const doc = buildDoc({
		modules: [
			{
				name: "Clinics",
				forms: [
					{
						uuid: FORM,
						name: "Visit",
						type: "survey",
						fields: [
							{ kind: "text", id: "chosen_region", uuid: FIELD_UUID },
							{
								kind: "hidden",
								id: "value",
								uuid: VALUE,
								calculate: expression,
							},
							...(choices === undefined
								? []
								: [
										{
											kind: "single_select" as const,
											id: "choice",
											uuid: CHOICE,
											optionsSource: choices,
										},
									]),
						],
					},
				],
			},
		],
	});
	const context = slotContext(
		doc,
		{
			entity: "field",
			uuid: choices === undefined ? VALUE : CHOICE,
			slot: choices === undefined ? "calculate" : "lookup_options_source",
		},
		lookupTypeIndexFromNaming(fixtureData.naming) ?? new Map(),
	);
	if (context === undefined)
		throw new Error("The lookup fixture has no owning slot.");
	return context;
}
type Bindings = Omit<LookupEvaluationBindings, "types">;
function evaluateLookupChoices(
	source: LookupOptionsSource,
	data: PreviewLookupData,
	bindings: Bindings,
	sortColumn?: LookupColumnId,
) {
	return evaluateChoices(
		source,
		data,
		{
			...bindings,
			types: lookupContext(
				source.filter ?? { kind: "match-all" },
				data,
				source,
			),
		},
		sortColumn,
	);
}
function evaluateTableLookup(
	expression: Extract<Expression, { kind: "table-lookup" }>,
	data: PreviewLookupData,
	bindings: Bindings,
) {
	return evaluateLookup(expression, data, {
		...bindings,
		types: lookupContext(expression, data),
	});
}
function foldTableLookupsInExpression(
	expression: Expression,
	data: PreviewLookupData,
	bindings: Bindings,
) {
	return foldExpression(expression, data, {
		...bindings,
		types: lookupContext(expression, data),
	});
}
function foldTableLookupsInPredicate(
	expression: Expression,
	data: PreviewLookupData,
	bindings: Bindings,
) {
	return foldPredicate(expression, data, {
		...bindings,
		types: lookupContext(expression, data),
	});
}

function outerContext(values: Record<string, string> = {}): EvalContext {
	return {
		contextPath: "",
		position: 1,
		resolveHashtag: () => "",
		getValue: (path) => values[path],
	};
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
		const choices = evaluateLookupChoices(source(), data(), {
			outer: outerContext(),
		});
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
			{ outer: outerContext() },
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
			{ outer: outerContext() },
		);
		expect(choices.map((c) => c.value)).toEqual(["a1", "c3"]);
	});

	it.each(["/data/chosen_region", "/data/visits[2]/chosen_region"])(
		"resolves the form-answer binding at %s",
		(path) => {
			const filter = eq(
				term(tableColumn(TABLE, COL_REGION)),
				term(formField(FIELD_UUID)),
			);
			const bindings = {
				outer: outerContext({ [path]: "south" }),
				formFields: new Map([[FIELD_UUID, path]]),
			};
			const choices = evaluateLookupChoices(source(filter), data(), bindings);
			expect(choices.map((c) => c.value)).toEqual(["b2"]);
		},
	);

	it("an unanswered form answer matches only blank cells", () => {
		const filter = eq(
			term(tableColumn(TABLE, COL_REGION)),
			term(formField(FIELD_UUID)),
		);
		const bindings = {
			outer: outerContext({}),
			formFields: new Map([[FIELD_UUID, "/data/chosen_region"]]),
		};
		const choices = evaluateLookupChoices(source(filter), data(), bindings);
		expect(choices.map((c) => c.value)).toEqual(["c3"]);
	});

	it("is-blank matches missing cells and stored-empty cells alike", () => {
		const choices = evaluateLookupChoices(
			source(isBlank(term(tableColumn(TABLE, COL_NAME)))),
			data(),
			{ outer: outerContext() },
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
			const choices = evaluateLookupChoices(
				source(),
				sortData(),
				{ outer: outerContext() },
				COL_NAME,
			);
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
			const choices = evaluateLookupChoices(source(), sortData(), {
				outer: outerContext(),
			});
			expect(choices.map((c) => c.label)).toEqual(labels);
		});

		it("orders by a column other than the label", () => {
			const choices = evaluateLookupChoices(
				source(),
				data(),
				{ outer: outerContext() },
				COL_STOCK,
			);
			expect(choices.map((c) => c.value)).toEqual(["b2", "a1", "c3"]);
		});
	});

	it("throws the validation-bypass invariant for an unknown table", () => {
		const orphan = {
			...source(),
			tableId: "018f0000-0000-7000-8000-00000000dead" as LookupTableId,
		};
		expect(() =>
			evaluateLookupChoices(orphan, data(), { outer: outerContext() }),
		).toThrow(/not in the loaded fixture snapshot/);
	});

	it("throws the validation-bypass invariant for an unknown column", () => {
		const orphan = {
			...source(),
			valueColumnId: "018f0000-0000-7000-8000-00000000dead" as LookupColumnId,
		};
		expect(() =>
			evaluateLookupChoices(orphan, data(), { outer: outerContext() }),
		).toThrow(/not declared on lookup table/);
	});
});

describe("evaluateTableLookup", () => {
	it("distinguishes quotient from real division in row filters", () => {
		for (const [op, expected] of [
			["quotient", "a1"],
			["div", ""],
		] as const) {
			const lookup = tableLookup(
				TABLE,
				COL_CODE,
				eq(
					arith(op, term(tableColumn(TABLE, COL_STOCK)), term(literal(3))),
					literal(1),
				),
			);
			expect(
				evaluateTableLookup(lookup, data(), { outer: outerContext() }),
			).toBe(expected);
		}
	});
	it("returns the FIRST matching row's result cell in authored order", () => {
		const lookup = tableLookup(
			TABLE,
			COL_CODE,
			gt(term(tableColumn(TABLE, COL_STOCK)), literal(-1)),
		);
		expect(evaluateTableLookup(lookup, data(), { outer: outerContext() })).toBe(
			"a1",
		);
	});

	it("no match folds to the empty string", () => {
		const lookup = tableLookup(
			TABLE,
			COL_CODE,
			eq(term(tableColumn(TABLE, COL_REGION)), literal("nowhere")),
		);
		expect(evaluateTableLookup(lookup, data(), { outer: outerContext() })).toBe(
			"",
		);
	});

	it("a matched row's absent result cell reads blank", () => {
		const lookup = tableLookup(
			TABLE,
			COL_NAME,
			eq(term(tableColumn(TABLE, COL_CODE)), literal("c3")),
		);
		expect(evaluateTableLookup(lookup, data(), { outer: outerContext() })).toBe(
			"",
		);
	});

	it("lexicalizes int result cells exponent-free", () => {
		const lookup = tableLookup(
			TABLE,
			COL_STOCK,
			eq(term(tableColumn(TABLE, COL_CODE)), literal("c3")),
		);
		expect(evaluateTableLookup(lookup, data(), { outer: outerContext() })).toBe(
			"9",
		);
	});
});

describe("foldTableLookupsInPredicate", () => {
	it("retains the declared numeric result type after replacing a lookup with its current value", () => {
		const lookup = tableLookup(
			TABLE,
			COL_STOCK,
			eq(term(tableColumn(TABLE, COL_CODE)), literal("a1")),
		);
		const expression = arith("quotient", lookup, term(literal(3)));
		const folded = foldTableLookupsInExpression(expression, data(), {
			outer: outerContext(),
		});
		expect(folded).toEqual(
			arith("quotient", term(qualifiedLiteral("4", "int")), term(literal(3))),
		);
		expect(
			evaluate(
				serializeWire(
					toWire(folded, {
						target: "suite",
						types: lookupContext(folded, data()),
					}),
					{
						target: "suite",
					},
				).text,
				outerContext(),
			),
		).toBe(1);
	});
	it("replaces a nested table-lookup with its literal result", () => {
		const predicate = and(
			eq(
				tableLookup(
					TABLE,
					COL_NAME,
					eq(term(tableColumn(TABLE, COL_CODE)), literal("b2")),
				),
				literal("Bario Health Post"),
			),
			eq(literal("x"), literal("x")),
		);
		const folded = foldTableLookupsInPredicate(predicate, data(), {
			outer: outerContext(),
		});
		expect(folded).toEqual(
			and(
				eq(literal("Bario Health Post"), literal("Bario Health Post")),
				eq(literal("x"), literal("x")),
			),
		);
	});

	it("shares the predicate by reference when no lookup is present", () => {
		const predicate = eq(literal("x"), literal("x"));
		expect(
			foldTableLookupsInPredicate(predicate, data(), { outer: outerContext() }),
		).toBe(predicate);
	});
});
