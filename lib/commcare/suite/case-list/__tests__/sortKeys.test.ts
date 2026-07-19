// lib/commcare/suite/case-list/__tests__/sortKeys.test.ts
//
// Acceptance tests for the sort-directive build pipeline + emit
// helpers that drive case-list short-detail `<sort>` blocks. Each
// test pins behavior against the column-on-sort schema's contract:
//
//   - Sortable columns are the ones with `column.sort` defined.
//   - The wire `order` attribute is the 1-based position after
//     priority-ascending sort with display-order tie-break.
//   - Comparator type is derived (not authored) from the case
//     property's `data_type` for non-calculated arms and from the
//     expression's resolved result type for calculated arms.
//   - Three checker-side failure shapes route to comparator type
//     `"plain"`: `undefined` (resolution failure), `ANY_TYPE`
//     (null-literal arm), unmapped `ResolvedType` (e.g.
//     `SEQUENCE_TYPE`).
//
// Tests organize around five shells:
//
//   1. `applicableSortTypes` — per-`data_type` table.
//   2. `buildSortDirectives` — sortable-column collection, priority
//      ordering, tie-break to Results order, comparator-type
//      derivation per kind, calc-column expression typing.
//   3. The three calc-column fallback shapes — separate tests per
//      shape, never collapsed.
//   4. `emitSortBlock` — both directive arms (property + calc),
//      attribute composition, XML escaping.
//   5. Wire-vocab maps — `SORT_TYPE_WIRE_MAP` /
//      `SORT_DIRECTION_WIRE_MAP` direct assertions pin the
//      Nova → CCHQ translation.

import { describe, expect, it } from "vitest";
import {
	asUuid,
	type BlueprintDoc,
	calculatedColumn,
	dateColumn,
	type Module,
	plainColumn,
} from "@/lib/domain";
import { literal, prop, term, unwrapList } from "@/lib/domain/predicate";
import {
	applicableSortTypes,
	buildSortDirectives,
	emitSortBlock,
	type ResolvedSortDirective,
	SORT_DIRECTION_WIRE_MAP,
	SORT_TYPE_WIRE_MAP,
} from "../sortKeys";

// ============================================================
// Test helpers
// ============================================================

const MODULE_UUID = asUuid("00000000-0000-4000-8000-000000000010");

/**
 * Build a minimal `BlueprintDoc` carrying one module + a populated
 * `caseTypes` array. The case-type definition supplies the property
 * `data_type` annotations the sort-directive builder consults via
 * `resolvePropertyDataType`. Tests that need richer fixtures pass
 * additional case types or properties through `properties`.
 */
function buildDoc(args: {
	readonly module: Module;
	readonly caseType?: string;
	readonly properties?: ReadonlyArray<{
		readonly name: string;
		readonly data_type?: import("@/lib/domain").CasePropertyDataType;
	}>;
}): BlueprintDoc {
	return {
		appId: "test-app",
		appName: "Test App",
		connectType: null,
		moduleOrder: [args.module.uuid],
		modules: { [args.module.uuid]: args.module },
		formOrder: { [args.module.uuid]: [] },
		forms: {},
		fields: {},
		fieldOrder: {},
		fieldParent: {},
		caseTypes:
			args.caseType !== undefined
				? [
						{
							name: args.caseType,
							properties: (args.properties ?? []).map((p) => ({
								name: p.name,
								label: p.name,
								...(p.data_type !== undefined && { data_type: p.data_type }),
							})),
						},
					]
				: [],
	};
}

/**
 * Assemble a `Module` carrying the supplied column membership under a fixed
 * uuid + case type. Results order comes from each column's
 * `listOrder ?? order` key; the wrapper's `uuid` is only a readable test tag
 * because each column already carries its own uuid.
 */
function makeModule(args: {
	readonly caseType?: string;
	readonly columns: ReadonlyArray<{
		readonly uuid: string;
		readonly column: import("@/lib/domain").Column;
	}>;
}): Module {
	return {
		uuid: MODULE_UUID,
		id: "test_module",
		name: "Test Module",
		...(args.caseType !== undefined && { caseType: args.caseType }),
		caseListConfig: {
			columns: args.columns.map((c) => c.column),
			searchInputs: [],
		},
	};
}

// ============================================================
// Shell 1 — applicableSortTypes per data_type
// ============================================================

describe("applicableSortTypes", () => {
	it("collapses `text` to a single plain entry", () => {
		expect(applicableSortTypes("text")).toEqual(["plain"]);
	});

	it("collapses select-shaped types to plain", () => {
		expect(applicableSortTypes("single_select")).toEqual(["plain"]);
		expect(applicableSortTypes("multi_select")).toEqual(["plain"]);
	});

	it("returns numeric types ahead of plain for `int`", () => {
		expect(applicableSortTypes("int")).toEqual(["integer", "plain"]);
	});

	it("returns numeric types ahead of plain for `decimal`", () => {
		expect(applicableSortTypes("decimal")).toEqual(["decimal", "plain"]);
	});

	it("returns date type ahead of plain for `date` / `datetime` / `time`", () => {
		expect(applicableSortTypes("date")).toEqual(["date", "plain"]);
		expect(applicableSortTypes("datetime")).toEqual(["date", "plain"]);
		expect(applicableSortTypes("time")).toEqual(["date", "plain"]);
	});

	it("collapses `geopoint` to plain (lexicographic compare on string-shaped wire form)", () => {
		expect(applicableSortTypes("geopoint")).toEqual(["plain"]);
	});

	it("falls back to plain when the data_type is unresolved", () => {
		expect(applicableSortTypes(undefined)).toEqual(["plain"]);
	});
});

// ============================================================
// Shell 2 — buildSortDirectives priority + tie-break
// ============================================================

describe("buildSortDirectives — sortable-column collection", () => {
	it("returns an empty map when no column carries sort", () => {
		const mod = makeModule({
			caseType: "patient",
			columns: [
				{
					uuid: "a",
					column: plainColumn(
						asUuid("00000000-0000-4000-8000-aaaa00000001"),
						"name",
						"Name",
					),
				},
			],
		});
		const doc = buildDoc({
			module: mod,
			caseType: "patient",
			properties: [{ name: "name", data_type: "text" }],
		});
		const directives = buildSortDirectives(mod, doc);
		expect(directives.size).toBe(0);
	});

	it("returns an empty map when the module has no caseListConfig", () => {
		const mod: Module = {
			uuid: MODULE_UUID,
			id: "test_module",
			name: "Test Module",
			caseType: "patient",
		};
		const doc = buildDoc({ module: mod, caseType: "patient" });
		const directives = buildSortDirectives(mod, doc);
		expect(directives.size).toBe(0);
	});

	it("includes only the columns whose `sort` slot is defined", () => {
		const sorted = plainColumn(
			asUuid("00000000-0000-4000-8000-aaaa00000010"),
			"name",
			"Name",
			{ sort: { direction: "asc", priority: 0 } },
		);
		const unsorted = plainColumn(
			asUuid("00000000-0000-4000-8000-aaaa00000011"),
			"phone",
			"Phone",
		);
		const mod = makeModule({
			caseType: "patient",
			columns: [
				{ uuid: "a", column: sorted },
				{ uuid: "b", column: unsorted },
			],
		});
		const doc = buildDoc({
			module: mod,
			caseType: "patient",
			properties: [
				{ name: "name", data_type: "text" },
				{ name: "phone", data_type: "text" },
			],
		});
		const directives = buildSortDirectives(mod, doc);
		expect(directives.size).toBe(1);
		expect(directives.has(sorted.uuid)).toBe(true);
		expect(directives.has(unsorted.uuid)).toBe(false);
	});
});

describe("buildSortDirectives — priority ordering", () => {
	it("orders directives ascending by `priority` regardless of source-array order", () => {
		const colA = plainColumn(
			asUuid("00000000-0000-4000-8000-aaaa00000020"),
			"a",
			"A",
			{ sort: { direction: "asc", priority: 2 } },
		);
		const colB = plainColumn(
			asUuid("00000000-0000-4000-8000-aaaa00000021"),
			"b",
			"B",
			{ sort: { direction: "asc", priority: 0 } },
		);
		const colC = plainColumn(
			asUuid("00000000-0000-4000-8000-aaaa00000022"),
			"c",
			"C",
			{ sort: { direction: "asc", priority: 1 } },
		);
		const mod = makeModule({
			caseType: "patient",
			columns: [
				{ uuid: "b", column: colB },
				{ uuid: "c", column: colC },
				{ uuid: "a", column: colA },
			],
		});
		const doc = buildDoc({
			module: mod,
			caseType: "patient",
			properties: [
				{ name: "a", data_type: "text" },
				{ name: "b", data_type: "text" },
				{ name: "c", data_type: "text" },
			],
		});
		const directives = buildSortDirectives(mod, doc);
		// Wire `order`: B (priority 0) → 1, C (priority 1) → 2,
		// A (priority 2) → 3.
		expect(directives.get(colB.uuid)?.order).toBe(1);
		expect(directives.get(colC.uuid)?.order).toBe(2);
		expect(directives.get(colA.uuid)?.order).toBe(3);
	});
});

describe("buildSortDirectives — tie-break to Results order", () => {
	it("uses Results order for priority ties and ignores the independent Details order", () => {
		const colA = plainColumn(
			asUuid("00000000-0000-4000-8000-aaaa00000033"),
			"a",
			"A",
			{
				sort: { direction: "asc", priority: 0 },
				listOrder: "b",
				detailOrder: "a",
			},
		);
		const colB = plainColumn(
			asUuid("00000000-0000-4000-8000-aaaa00000034"),
			"b",
			"B",
			{
				sort: { direction: "asc", priority: 0 },
				listOrder: "a",
				detailOrder: "b",
			},
		);
		const mod = makeModule({
			caseType: "patient",
			columns: [
				{ uuid: "a", column: colA },
				{ uuid: "b", column: colB },
			],
		});
		const doc = buildDoc({
			module: mod,
			caseType: "patient",
			properties: [
				{ name: "a", data_type: "text" },
				{ name: "b", data_type: "text" },
			],
		});

		const directives = buildSortDirectives(mod, doc);
		expect(directives.get(colB.uuid)?.order).toBe(1);
		expect(directives.get(colA.uuid)?.order).toBe(2);
	});

	it("breaks priority ties by Results order — earlier display wins", () => {
		// Three columns at the same priority. Explicit Results order A, B, C
		// determines wire orders 1, 2, 3 regardless of membership position.
		const colA = plainColumn(
			asUuid("00000000-0000-4000-8000-aaaa00000030"),
			"a",
			"A",
			{ sort: { direction: "asc", priority: 0 }, listOrder: "a" },
		);
		const colB = plainColumn(
			asUuid("00000000-0000-4000-8000-aaaa00000031"),
			"b",
			"B",
			{ sort: { direction: "asc", priority: 0 }, listOrder: "b" },
		);
		const colC = plainColumn(
			asUuid("00000000-0000-4000-8000-aaaa00000032"),
			"c",
			"C",
			{ sort: { direction: "asc", priority: 0 }, listOrder: "c" },
		);
		const mod = makeModule({
			caseType: "patient",
			columns: [
				{ uuid: "a", column: colA },
				{ uuid: "b", column: colB },
				{ uuid: "c", column: colC },
			],
		});
		const doc = buildDoc({
			module: mod,
			caseType: "patient",
			properties: [
				{ name: "a", data_type: "text" },
				{ name: "b", data_type: "text" },
				{ name: "c", data_type: "text" },
			],
		});
		const directives = buildSortDirectives(mod, doc);
		expect(directives.get(colA.uuid)?.order).toBe(1);
		expect(directives.get(colB.uuid)?.order).toBe(2);
		expect(directives.get(colC.uuid)?.order).toBe(3);
	});

	it("interleaves priority + tie-break: shared-priority pairs respect display order, lower-priority block runs first", () => {
		// Results order: A (priority 1), B (priority 0), C (priority 1).
		// Sort: B (priority 0, order 1), A (priority 1, display 0,
		// order 2), C (priority 1, display 2, order 3).
		const colA = plainColumn(
			asUuid("00000000-0000-4000-8000-aaaa00000040"),
			"a",
			"A",
			{ sort: { direction: "asc", priority: 1 }, listOrder: "a" },
		);
		const colB = plainColumn(
			asUuid("00000000-0000-4000-8000-aaaa00000041"),
			"b",
			"B",
			{ sort: { direction: "asc", priority: 0 }, listOrder: "b" },
		);
		const colC = plainColumn(
			asUuid("00000000-0000-4000-8000-aaaa00000042"),
			"c",
			"C",
			{ sort: { direction: "asc", priority: 1 }, listOrder: "c" },
		);
		const mod = makeModule({
			caseType: "patient",
			columns: [
				{ uuid: "a", column: colA },
				{ uuid: "b", column: colB },
				{ uuid: "c", column: colC },
			],
		});
		const doc = buildDoc({
			module: mod,
			caseType: "patient",
			properties: [
				{ name: "a", data_type: "text" },
				{ name: "b", data_type: "text" },
				{ name: "c", data_type: "text" },
			],
		});
		const directives = buildSortDirectives(mod, doc);
		expect(directives.get(colB.uuid)?.order).toBe(1);
		expect(directives.get(colA.uuid)?.order).toBe(2);
		expect(directives.get(colC.uuid)?.order).toBe(3);
	});
});

// ============================================================
// Shell 3 — comparator-type derivation per data type
// ============================================================

describe("buildSortDirectives — comparator type derivation", () => {
	it("picks `plain` for text-typed properties", () => {
		const col = plainColumn(
			asUuid("00000000-0000-4000-8000-aaaa00000050"),
			"name",
			"Name",
			{ sort: { direction: "asc", priority: 0 } },
		);
		const mod = makeModule({
			caseType: "patient",
			columns: [{ uuid: "a", column: col }],
		});
		const doc = buildDoc({
			module: mod,
			caseType: "patient",
			properties: [{ name: "name", data_type: "text" }],
		});
		const directives = buildSortDirectives(mod, doc);
		expect(directives.get(col.uuid)?.type).toBe("plain");
	});

	it("picks `integer` for int-typed properties", () => {
		const col = plainColumn(
			asUuid("00000000-0000-4000-8000-aaaa00000051"),
			"age",
			"Age",
			{ sort: { direction: "asc", priority: 0 } },
		);
		const mod = makeModule({
			caseType: "patient",
			columns: [{ uuid: "a", column: col }],
		});
		const doc = buildDoc({
			module: mod,
			caseType: "patient",
			properties: [{ name: "age", data_type: "int" }],
		});
		const directives = buildSortDirectives(mod, doc);
		expect(directives.get(col.uuid)?.type).toBe("integer");
	});

	it("picks `decimal` for decimal-typed properties", () => {
		const col = plainColumn(
			asUuid("00000000-0000-4000-8000-aaaa00000052"),
			"weight",
			"Weight",
			{ sort: { direction: "asc", priority: 0 } },
		);
		const mod = makeModule({
			caseType: "patient",
			columns: [{ uuid: "a", column: col }],
		});
		const doc = buildDoc({
			module: mod,
			caseType: "patient",
			properties: [{ name: "weight", data_type: "decimal" }],
		});
		const directives = buildSortDirectives(mod, doc);
		expect(directives.get(col.uuid)?.type).toBe("decimal");
	});

	it("picks `date` for date-typed properties", () => {
		const col = dateColumn(
			asUuid("00000000-0000-4000-8000-aaaa00000053"),
			"birthdate",
			"Birthdate",
			"%Y-%m-%d",
			{ sort: { direction: "desc", priority: 0 } },
		);
		const mod = makeModule({
			caseType: "patient",
			columns: [{ uuid: "a", column: col }],
		});
		const doc = buildDoc({
			module: mod,
			caseType: "patient",
			properties: [{ name: "birthdate", data_type: "date" }],
		});
		const directives = buildSortDirectives(mod, doc);
		expect(directives.get(col.uuid)?.type).toBe("date");
	});

	it("picks `date` for datetime-typed properties", () => {
		const col = plainColumn(
			asUuid("00000000-0000-4000-8000-aaaa00000054"),
			"opened_on",
			"Opened",
			{ sort: { direction: "desc", priority: 0 } },
		);
		const mod = makeModule({
			caseType: "patient",
			columns: [{ uuid: "a", column: col }],
		});
		const doc = buildDoc({
			module: mod,
			caseType: "patient",
			properties: [{ name: "opened_on", data_type: "datetime" }],
		});
		const directives = buildSortDirectives(mod, doc);
		expect(directives.get(col.uuid)?.type).toBe("date");
	});

	it("falls back to `plain` when the property is unresolved on the case type", () => {
		const col = plainColumn(
			asUuid("00000000-0000-4000-8000-aaaa00000055"),
			"phantom",
			"Phantom",
			{ sort: { direction: "asc", priority: 0 } },
		);
		const mod = makeModule({
			caseType: "patient",
			columns: [{ uuid: "a", column: col }],
		});
		// Doc declares no `phantom` property — the resolver returns
		// undefined and the comparator collapses to plain.
		const doc = buildDoc({
			module: mod,
			caseType: "patient",
			properties: [],
		});
		const directives = buildSortDirectives(mod, doc);
		expect(directives.get(col.uuid)?.type).toBe("plain");
	});
});

// ============================================================
// Shell 3b — calc-column comparator type derivation
// ============================================================
//
// Calculated columns route through `checkExpression` against the
// module's TypeContext. Three failure shapes route to `"plain"` —
// each gets its own test so a regression that collapses two
// shapes surfaces as a missing assertion rather than a passing
// catch-all.

describe("buildSortDirectives — calculated column happy path", () => {
	it("derives the comparator type from the expression's resolved result type", () => {
		// `term(prop("patient", "age"))` — `age` declared as `int` →
		// expression resolves to `int` → comparator `"integer"`.
		const col = calculatedColumn(
			asUuid("00000000-0000-4000-8000-aaaa00000060"),
			"Age",
			term(prop("patient", "age")),
			{ sort: { direction: "asc", priority: 0 } },
		);
		const mod = makeModule({
			caseType: "patient",
			columns: [{ uuid: "a", column: col }],
		});
		const doc = buildDoc({
			module: mod,
			caseType: "patient",
			properties: [{ name: "age", data_type: "int" }],
		});
		const directives = buildSortDirectives(mod, doc);
		expect(directives.get(col.uuid)?.type).toBe("integer");
	});

	it("derives the `date` comparator from a date-typed expression", () => {
		// `term(prop("patient", "birthdate"))` — `birthdate` declared
		// as `date` → expression resolves to `date` → comparator
		// `"date"`.
		const col = calculatedColumn(
			asUuid("00000000-0000-4000-8000-aaaa00000061"),
			"Birthdate calc",
			term(prop("patient", "birthdate")),
			{ sort: { direction: "desc", priority: 0 } },
		);
		const mod = makeModule({
			caseType: "patient",
			columns: [{ uuid: "a", column: col }],
		});
		const doc = buildDoc({
			module: mod,
			caseType: "patient",
			properties: [{ name: "birthdate", data_type: "date" }],
		});
		const directives = buildSortDirectives(mod, doc);
		expect(directives.get(col.uuid)?.type).toBe("date");
	});
});

describe("buildSortDirectives — calc fallback: undefined result type", () => {
	it("collapses to `plain` when the checker returns undefined (resolution failure)", () => {
		// `term(prop("patient", "phantom"))` — `phantom` is not
		// declared on the case type, so `checkExpression` pushes an
		// error onto its accumulator AND returns `undefined`. The
		// wire emitter ignores the accumulator (the validator's
		// `calculatedColumnTypeCheck` reports the same failure
		// upstream) and falls back to `"plain"`.
		const col = calculatedColumn(
			asUuid("00000000-0000-4000-8000-aaaa00000070"),
			"Unresolved",
			term(prop("patient", "phantom")),
			{ sort: { direction: "asc", priority: 0 } },
		);
		const mod = makeModule({
			caseType: "patient",
			columns: [{ uuid: "a", column: col }],
		});
		// No `phantom` property declared on the case type.
		const doc = buildDoc({
			module: mod,
			caseType: "patient",
			properties: [],
		});
		const directives = buildSortDirectives(mod, doc);
		expect(directives.get(col.uuid)?.type).toBe("plain");
	});
});

describe("buildSortDirectives — calc fallback: ANY_TYPE result type", () => {
	it("collapses to `plain` for a null-literal expression", () => {
		// `term(literal(null))` — `literalType` returns the `ANY_TYPE`
		// sentinel; the checker propagates it through. The wire
		// emitter's fallback rule routes ANY_TYPE to `"plain"`.
		const col = calculatedColumn(
			asUuid("00000000-0000-4000-8000-aaaa00000071"),
			"Null literal",
			term(literal(null)),
			{ sort: { direction: "asc", priority: 0 } },
		);
		const mod = makeModule({
			caseType: "patient",
			columns: [{ uuid: "a", column: col }],
		});
		const doc = buildDoc({
			module: mod,
			caseType: "patient",
			properties: [],
		});
		const directives = buildSortDirectives(mod, doc);
		expect(directives.get(col.uuid)?.type).toBe("plain");
	});
});

describe("buildSortDirectives — calc fallback: unmapped ResolvedType", () => {
	it("refuses an unwrap-list sort that CommCare Core cannot evaluate on-device", () => {
		// `unwrapList(term(prop("patient", "tags")))` resolves to
		// `SEQUENCE_TYPE`, but `unwrap-list` exists only in CCHQ's server-side
		// case-search function table. A case-list sort executes in CommCare
		// Core's on-device evaluator, so the validator must reject this shape
		// and the low-level emitter must fail closed if a caller bypasses it.
		const col = calculatedColumn(
			asUuid("00000000-0000-4000-8000-aaaa00000072"),
			"Tags sequence",
			unwrapList(term(prop("patient", "tags"))),
			{ sort: { direction: "asc", priority: 0 } },
		);
		const mod = makeModule({
			caseType: "patient",
			columns: [{ uuid: "a", column: col }],
		});
		const doc = buildDoc({
			module: mod,
			caseType: "patient",
			properties: [{ name: "tags", data_type: "text" }],
		});
		expect(() => buildSortDirectives(mod, doc)).toThrow(
			/unwrap-list is a server-side case-search function/i,
		);
	});
});

// ============================================================
// Shell 4 — emitSortBlock wire shape
// ============================================================

describe("emitSortBlock — property arm", () => {
	it("emits the bare-XPath shape with type/order/direction attributes", () => {
		const directive: ResolvedSortDirective = {
			kind: "property",
			order: 1,
			direction: "asc",
			type: "plain",
			xpath: "case_name",
		};
		const xml = emitSortBlock(directive);
		expect(xml).toContain('type="string"');
		expect(xml).toContain('order="1"');
		expect(xml).toContain('direction="ascending"');
		expect(xml).toContain('<xpath function="case_name"/>');
	});

	it("renders an int-typed sort for integer comparator", () => {
		const xml = emitSortBlock({
			kind: "property",
			order: 1,
			direction: "asc",
			type: "integer",
			xpath: "age",
		});
		expect(xml).toContain('type="int"');
	});

	it("renders a double-typed sort for decimal comparator", () => {
		const xml = emitSortBlock({
			kind: "property",
			order: 1,
			direction: "asc",
			type: "decimal",
			xpath: "weight_kg",
		});
		expect(xml).toContain('type="double"');
	});

	it("renders a string-typed descending sort for date comparator", () => {
		const xml = emitSortBlock({
			kind: "property",
			order: 2,
			direction: "desc",
			type: "date",
			xpath: "birthdate",
		});
		expect(xml).toContain('type="string"');
		expect(xml).toContain('order="2"');
		expect(xml).toContain('direction="descending"');
	});

	it("XML-escapes the xpath payload to keep attribute-value rules intact", () => {
		const xml = emitSortBlock({
			kind: "property",
			order: 1,
			direction: "asc",
			type: "plain",
			xpath: "if(a < b, 'x', 'y')",
		});
		expect(xml).toContain("a &lt; b");
		// XPath single-quote string literals round-trip through the
		// serializer as `&apos;` inside double-quoted attribute values.
		// XML-spec-equivalent to the literal `'`; CCHQ's XML parser
		// decodes both forms identically before the XPath layer sees
		// the value.
		expect(xml).toContain("&apos;x&apos;");
	});
});

describe("emitSortBlock — calculated arm", () => {
	it("emits the CCHQ inline-variable shape for a calc directive", () => {
		const xml = emitSortBlock({
			kind: "calculated",
			order: 1,
			direction: "desc",
			type: "integer",
			calcXpath: "(today() - date(opened_on)) div 7",
		});
		expect(xml).toContain('type="int"');
		expect(xml).toContain('order="1"');
		expect(xml).toContain('direction="descending"');
		// CCHQ's `useXpathExpression` shape carries the literal
		// `$calculated_property` as the outer xpath function. `$` is not a
		// special XML character, so it serializes verbatim — matching
		// CCHQ's own bare-`$` suite.xml.
		expect(xml).toContain('<xpath function="$calculated_property">');
		expect(xml).toContain('<variable name="calculated_property">');
		// The inner xpath carries the calc's lowered expression.
		expect(xml).toContain("today() - date(opened_on)");
	});

	it("XML-escapes the inner calc xpath", () => {
		const xml = emitSortBlock({
			kind: "calculated",
			order: 1,
			direction: "asc",
			type: "plain",
			calcXpath: "if(a < b, 'x', 'y')",
		});
		expect(xml).toContain("a &lt; b");
		expect(xml).toContain('<xpath function="$calculated_property">');
	});
});

// ============================================================
// Shell 5 — wire-vocab maps
// ============================================================

describe("SORT_TYPE_WIRE_MAP", () => {
	it("maps every Nova SortType arm to the CCHQ wire vocabulary", () => {
		// Pin the four-arm translation table. Adding a SortType arm
		// without updating this map would surface as a Record-
		// exhaustiveness compile error AND a missing assertion here.
		expect(SORT_TYPE_WIRE_MAP.plain).toBe("string");
		expect(SORT_TYPE_WIRE_MAP.date).toBe("string");
		expect(SORT_TYPE_WIRE_MAP.integer).toBe("int");
		expect(SORT_TYPE_WIRE_MAP.decimal).toBe("double");
	});
});

describe("SORT_DIRECTION_WIRE_MAP", () => {
	it("maps Nova SortDirection arms to CCHQ's spelled-out attribute values", () => {
		expect(SORT_DIRECTION_WIRE_MAP.asc).toBe("ascending");
		expect(SORT_DIRECTION_WIRE_MAP.desc).toBe("descending");
	});
});
