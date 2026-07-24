// Device-parity semantics for client lookup-carrier evaluation: the
// filter prints through the SAME on-device emitter the wire uses and
// evaluates per fixture row, so these tests pin authored-order
// first-match, fixture blank semantics, and the binding seams
// (form-answer paths, session paths) — not emitter internals.

import { describe, expect, it } from "vitest";
import type {
	LookupColumnId,
	LookupOptionsSource,
	LookupTableId,
	Uuid,
} from "@/lib/domain";
import {
	and,
	eq,
	formField,
	gt,
	isBlank,
	literal,
	tableColumn,
	tableLookup,
	term,
} from "@/lib/domain/predicate";
import type {
	LookupFixtureRow,
	LookupTableDefinition,
} from "@/lib/lookup/types";
import type { EvalContext } from "@/lib/preview/xpath/types";
import {
	evaluateLookupChoices,
	evaluateTableLookup,
	foldTableLookupsInPredicate,
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
	definitionRevision: "1" as LookupTableDefinition["definitionRevision"],
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
	return { id: id as LookupFixtureRow["id"], values: byColumn };
}

const ROWS: readonly LookupFixtureRow[] = [
	row("018f0000-0000-7000-8000-0000000000r1", {
		code: "a1",
		clinic_name: "Arua Clinic",
		stock: 4,
		region: "north",
	}),
	row("018f0000-0000-7000-8000-0000000000r2", {
		code: "b2",
		clinic_name: "Bario Health Post",
		stock: 0,
		region: "south",
	}),
	// Missing clinic_name cell + stored-empty region: both read blank.
	row("018f0000-0000-7000-8000-0000000000r3", {
		code: "c3",
		stock: 9,
		region: "",
	}),
];

function data(): PreviewLookupData {
	return previewLookupData({
		projectRevision: "7",
		definitions: [DEFINITION],
		rowsByTable: new Map([[TABLE, ROWS]]),
	});
}

function outerContext(values: Record<string, string> = {}): EvalContext {
	return {
		contextPath: "",
		position: 1,
		size: 1,
		resolveHashtag: () => "",
		getValue: (path) => values[path],
	};
}

function source(filter?: LookupOptionsSource["filter"]): LookupOptionsSource {
	return {
		kind: "lookup-table",
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
			{ value: "a1", label: "Arua Clinic" },
			{ value: "b2", label: "Bario Health Post" },
			{ value: "c3", label: "" },
		]);
	});

	it("filters by same-table column comparison against a literal", () => {
		const choices = evaluateLookupChoices(
			source(eq(term(tableColumn(TABLE, COL_REGION)), literal("north"))),
			data(),
			{ outer: outerContext() },
		);
		expect(choices).toEqual([{ value: "a1", label: "Arua Clinic" }]);
	});

	it("compares int cells numerically", () => {
		const choices = evaluateLookupChoices(
			source(gt(term(tableColumn(TABLE, COL_STOCK)), literal(2))),
			data(),
			{ outer: outerContext() },
		);
		expect(choices.map((c) => c.value)).toEqual(["a1", "c3"]);
	});

	it("resolves a form-answer term through formFields + the outer context", () => {
		const filter = eq(
			term(tableColumn(TABLE, COL_REGION)),
			term(formField(FIELD_UUID)),
		);
		const bindings = {
			outer: outerContext({ "/data/chosen_region": "south" }),
			formFields: new Map([[FIELD_UUID, "/data/chosen_region"]]),
		};
		const choices = evaluateLookupChoices(source(filter), data(), bindings);
		expect(choices.map((c) => c.value)).toEqual(["b2"]);
	});

	it("an unanswered form answer matches only blank cells (device raw semantics)", () => {
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

	it("no match folds to the empty string (Core's empty node-set unpack)", () => {
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
		const printed = JSON.stringify(folded);
		expect(printed).not.toContain("table-lookup");
		expect(printed).toContain("Bario Health Post");
	});

	it("shares the predicate by reference when no lookup is present", () => {
		const predicate = eq(literal("x"), literal("x"));
		expect(
			foldTableLookupsInPredicate(predicate, data(), { outer: outerContext() }),
		).toBe(predicate);
	});
});
