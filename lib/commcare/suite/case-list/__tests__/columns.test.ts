// lib/commcare/suite/case-list/__tests__/columns.test.ts
//
// Acceptance tests for the per-Column / per-CalculatedColumn
// `<field>` block emitter. Each test pins the wire shape against
// the CCHQ source citations live alongside each per-format helper
// in `../columns.ts`. Coverage walks every arm of the `Column`
// discriminated union plus the calculated-column emit path,
// asserts XML-attribute escaping where applicable, and pins
// the locale-id composition rule for header strings.
//
// Tests organize around three shells:
//
//   1. Per-kind regular column emission (one test per arm of
//      `Column` — `plain` / `date` / `time-since-until` / `phone`
//      / `id-mapping` / `late-flag` / `search-only`).
//   2. Calculated column emission, including the inline-variable
//      template shape and per-calc / module-level sort routing.
//   3. Sort integration — verifies a property-rooted column picks
//      up the matching sort key when `ctx.sort` carries one.

import { describe, expect, it } from "vitest";
import {
	type Column,
	calculatedColumn,
	calculatedSortSource,
	dateColumn,
	idMappingColumn,
	idMappingEntry,
	lateFlagColumn,
	phoneColumn,
	plainColumn,
	propertySortSource,
	searchOnlyColumn,
	sortKey,
	timeSinceUntilColumn,
} from "@/lib/domain";
import { literal, prop, term } from "@/lib/domain/predicate/builders";
import { emitCalculatedColumnField, emitColumnField } from "../columns";
import type { CaseListEmitContext } from "../types";

// Empty context — module index 0, no sort keys. Tests that need
// a sort key construct their own context locally.
const emptyCtx: CaseListEmitContext = {
	moduleIndex: 0,
	sort: [],
};

// ============================================================
// Shell 1 — per-kind regular column emission
// ============================================================

describe("emitColumnField — plain", () => {
	it("emits a bare property reference inside the template", () => {
		const col = plainColumn("name", "Name");
		const out = emitColumnField({ column: col, position: 1, ctx: emptyCtx });
		expect(out.xml).toContain("<field>");
		expect(out.xml).toContain('<xpath function="name"/>');
		// The header references the CCHQ-canonical locale id shape.
		expect(out.xml).toContain('locale id="m0.case_short.case_name_1.header"');
		// app_strings entry registers the column header.
		expect(out.strings).toEqual({
			"m0.case_short.case_name_1.header": "Name",
		});
	});

	it("uses the 1-based position to disambiguate two columns on the same property", () => {
		const colA = plainColumn("name", "Name A");
		const colB = plainColumn("name", "Name B");
		const a = emitColumnField({ column: colA, position: 1, ctx: emptyCtx });
		const b = emitColumnField({ column: colB, position: 2, ctx: emptyCtx });
		expect(a.xml).toContain("m0.case_short.case_name_1.header");
		expect(b.xml).toContain("m0.case_short.case_name_2.header");
	});
});

describe("emitColumnField — date", () => {
	it("wraps the property in CCHQ's empty-string-guarded format-date shape", () => {
		const col = dateColumn("opened_on", "Opened", "%d/%m/%Y");
		const out = emitColumnField({ column: col, position: 1, ctx: emptyCtx });
		// CCHQ's date-format wire shape: per
		// `detail_screen.py:367-370`, `if({xpath} = '', '', format-date(date({xpath}), 'pattern'))`.
		// Attribute escaping flips `'` to `&apos;` … no, single quotes
		// survive verbatim because the helper escapes only `&`, `<`,
		// `>`, and `"`. The pattern's own quotes show as `'`.
		expect(out.xml).toContain(
			"if(opened_on = '', '', format-date(date(opened_on), '%d/%m/%Y'))",
		);
	});

	it("threads the pattern through quoteLiteral's concat-fallback when it carries an embedded quote", () => {
		// `'em%dpattern` would break the `format-date(date(...), '<pattern>')`
		// shape if the helper interpolated naively; the concat-fallback
		// shape `concat('', "'", 'em%dpattern')` preserves the literal.
		const col = dateColumn("opened_on", "Opened", "'em%dpattern");
		const out = emitColumnField({ column: col, position: 1, ctx: emptyCtx });
		expect(out.xml).toContain("concat(");
		expect(out.xml).toContain(`&quot;'&quot;`);
	});
});

describe("emitColumnField — time-since-until", () => {
	it("emits the days-equivalent divisor + threshold for a weeks-unit column", () => {
		const col = timeSinceUntilColumn(
			"last_visit",
			"Weeks since visit",
			4,
			"weeks",
			"Overdue",
		);
		const out = emitColumnField({ column: col, position: 1, ctx: emptyCtx });
		// Divisor for weeks = 7; threshold in days = 4 * 7 = 28.
		// Inner shape: `string(int((today() - date(last_visit)) div 7))`.
		expect(out.xml).toContain(
			"string(int((today() - date(last_visit)) div 7))",
		);
		// Overdue branch: `if(today() - date(last_visit) > 28, 'Overdue', ...)`.
		expect(out.xml).toContain(
			"if(today() - date(last_visit) &gt; 28, 'Overdue',",
		);
		// Outer empty-string short-circuit.
		expect(out.xml).toContain("if(last_visit = '', '',");
	});

	it("uses 365.25 as the divisor for years-unit columns", () => {
		const col = timeSinceUntilColumn("dob", "Age", 18, "years", "Adult");
		const out = emitColumnField({ column: col, position: 1, ctx: emptyCtx });
		// Divisor for years = 365.25; threshold = 18 * 365.25 = 6574.5.
		expect(out.xml).toContain("(today() - date(dob)) div 365.25");
		expect(out.xml).toContain("today() - date(dob) &gt; 6574.5");
	});

	it("uses 30.4375 (365.25/12) as the divisor for months-unit columns", () => {
		const col = timeSinceUntilColumn(
			"opened_on",
			"Months open",
			3,
			"months",
			"Aged",
		);
		const out = emitColumnField({ column: col, position: 1, ctx: emptyCtx });
		// Divisor for months = 365.25 / 12 = 30.4375; threshold = 3 * 30.4375 = 91.3125.
		expect(out.xml).toContain("(today() - date(opened_on)) div 30.4375");
		expect(out.xml).toContain("today() - date(opened_on) &gt; 91.3125");
	});

	it("uses 1 as the divisor for days-unit columns", () => {
		const col = timeSinceUntilColumn("last_visit", "Days", 7, "days", "Late");
		const out = emitColumnField({ column: col, position: 1, ctx: emptyCtx });
		expect(out.xml).toContain("(today() - date(last_visit)) div 1");
		expect(out.xml).toContain("today() - date(last_visit) &gt; 7");
	});
});

describe("emitColumnField — phone", () => {
	it("emits the bare property reference for short-detail phone columns", () => {
		// CCHQ's `Phone` format inherits the bare-property XPath from
		// the base class on short detail; only the long detail picks
		// up `template_form="phone"` (per `detail_screen.py:393-399`).
		const col = phoneColumn("phone", "Phone");
		const out = emitColumnField({ column: col, position: 1, ctx: emptyCtx });
		expect(out.xml).toContain('<xpath function="phone"/>');
		expect(out.xml).not.toContain('form="phone"');
	});
});

describe("emitColumnField — id-mapping", () => {
	it("renders a chain of selected() arms wrapped in replace(join(...))", () => {
		const col = idMappingColumn("region_code", "Region", [
			idMappingEntry("N", "North"),
			idMappingEntry("S", "South"),
		]);
		const out = emitColumnField({ column: col, position: 1, ctx: emptyCtx });
		// CCHQ's `XPathEnum.build` shape per
		// `xml_models.py:106-112`: `replace(join(' ', if(selected(...)), ...), '\s+', ' ')`.
		// Nova inlines labels as XPath string literals (no locale-id
		// wiring) — `if(selected(region_code, 'N'), 'North', '')`.
		expect(out.xml).toContain(
			"replace(join(' ', if(selected(region_code, 'N'), 'North', ''), if(selected(region_code, 'S'), 'South', '')), '\\s+', ' ')",
		);
	});

	it("emits the empty-string XPath for a zero-entry mapping", () => {
		const col = idMappingColumn("region_code", "Region", []);
		const out = emitColumnField({ column: col, position: 1, ctx: emptyCtx });
		// Empty mapping => `''` literal.
		expect(out.xml).toContain("<xpath function=\"''\"/>");
	});

	it("escapes embedded quotes in mapping values + labels through quoteLiteral", () => {
		const col = idMappingColumn("region_code", "Region", [
			idMappingEntry("O'Brien", "O'Brien region"),
		]);
		const out = emitColumnField({ column: col, position: 1, ctx: emptyCtx });
		// Each side flips to a concat-fallback shape because the
		// embedded `'` can't fit a single-quoted XPath string literal.
		expect(out.xml).toContain("concat(");
		// `&quot;` is the XML-attribute escape for `"`. The
		// concat-fallback's literal-quote separator is `"'"` which
		// renders as `&quot;'&quot;` inside the attribute.
		expect(out.xml).toContain(`&quot;'&quot;`);
	});
});

describe("emitColumnField — late-flag", () => {
	it("emits both the absent-and-overdue branches with the author's flag string", () => {
		const col = lateFlagColumn("last_visit", "Overdue", 30, "days", "!");
		const out = emitColumnField({ column: col, position: 1, ctx: emptyCtx });
		// CCHQ's wire shape per `detail_screen.py:556`:
		// `if({xpath} = '', '<flag>', if(today() - date({xpath}) > <threshold>, '<flag>', ''))`.
		// Threshold for days × 30 = 30.
		expect(out.xml).toContain(
			"if(last_visit = '', '!', if(today() - date(last_visit) &gt; 30, '!', ''))",
		);
	});

	it("multiplies by the days-equivalent divisor for non-day units", () => {
		const col = lateFlagColumn("last_visit", "Overdue", 4, "weeks", "!");
		const out = emitColumnField({ column: col, position: 1, ctx: emptyCtx });
		// Threshold = 4 * 7 = 28 days.
		expect(out.xml).toContain("today() - date(last_visit) &gt; 28");
	});

	it("escapes embedded quotes in the flag display value", () => {
		const col = lateFlagColumn("last_visit", "Overdue", 30, "days", "I'm late");
		const out = emitColumnField({ column: col, position: 1, ctx: emptyCtx });
		// Concat-fallback flips a single-quoted literal to a concat
		// shape because the value carries `'`.
		expect(out.xml).toContain("concat(");
	});
});

describe("emitColumnField — search-only", () => {
	it("emits a hidden field with width=0 on header and template", () => {
		const col = searchOnlyColumn("phone", "Phone");
		const out = emitColumnField({ column: col, position: 1, ctx: emptyCtx });
		// CCHQ's `Invisible` format pattern — width=0 on both halves
		// per `detail_screen.py:354-359`.
		expect(out.xml).toContain('<header width="0">');
		expect(out.xml).toContain('<template width="0">');
		// No header locale id — search-only columns surface no
		// authored header on the case list.
		expect(out.xml).not.toContain("locale id");
		expect(out.strings).toEqual({});
	});

	it("does not emit a sort block for a search-only column even when ctx.sort matches", () => {
		// A sort key targeting the search-only's property by name is
		// schematically possible (the validator's
		// `searchInputModeMatchesPropertyType` rule pins search-only
		// declarations to search inputs, not to sort keys). The
		// emitter still ignores sort routing for search-only kinds
		// because the hidden body has no slot for it.
		const col = searchOnlyColumn("phone", "Phone");
		const ctx: CaseListEmitContext = {
			moduleIndex: 0,
			sort: [sortKey(propertySortSource("phone"), "plain", "asc")],
		};
		const out = emitColumnField({ column: col, position: 1, ctx });
		expect(out.xml).not.toContain("<sort");
	});
});

// ============================================================
// Shell 2 — calculated column emission
// ============================================================

describe("emitCalculatedColumnField", () => {
	it("emits the CCHQ inline-variable template shape", () => {
		// `term(prop("patient", "name"))` lowers to a bare `name`
		// XPath via the on-device emitter — sufficient to pin the
		// surrounding template structure without exercising the full
		// expression-emitter surface (covered by its own unit tests).
		const calc = calculatedColumn(
			"my_calc",
			"My Calc",
			term(prop("patient", "name")),
		);
		const out = emitCalculatedColumnField({
			calculated: calc,
			position: 1,
			ctx: emptyCtx,
		});
		// Header locale id uses the CCHQ `case_calculated_property_<i>`
		// convention.
		expect(out.xml).toContain(
			'locale id="m0.case_short.case_calculated_property_1.header"',
		);
		// Template references `$calculated_property` and embeds the
		// lowered XPath as a `<variable>` block.
		expect(out.xml).toContain('<xpath function="$calculated_property">');
		expect(out.xml).toContain('<variable name="calculated_property">');
		expect(out.xml).toContain('<xpath function="name"/>');
		// The strings map carries the calc's authored header text.
		expect(out.strings).toEqual({
			"m0.case_short.case_calculated_property_1.header": "My Calc",
		});
	});

	it("attaches a sort block when a module-level key targets the calc id", () => {
		const calc = calculatedColumn(
			"my_calc",
			"My Calc",
			term(literal("constant")),
		);
		const ctx: CaseListEmitContext = {
			moduleIndex: 0,
			sort: [sortKey(calculatedSortSource("my_calc"), "plain", "desc")],
		};
		const out = emitCalculatedColumnField({
			calculated: calc,
			position: 1,
			ctx,
		});
		// The sort block uses the inline-variable shape so the sort
		// xpath references `$calculated_property` and the same
		// `<variable>` rides inside it.
		expect(out.xml).toContain("<sort");
		expect(out.xml).toContain('order="1"');
		expect(out.xml).toContain('direction="descending"');
		// The sort xpath shape mirrors the template shape.
		const sortMatches = out.xml.match(/<sort[\s\S]*?<\/sort>/);
		expect(sortMatches).not.toBeNull();
		const sortBlock = sortMatches?.[0] ?? "";
		expect(sortBlock).toContain('<xpath function="$calculated_property">');
		expect(sortBlock).toContain("'constant'");
	});

	it("falls back to the calc-local sort slot when no module-level key targets it", () => {
		const calc = calculatedColumn(
			"my_calc",
			"My Calc",
			term(literal("constant")),
			{ type: "plain", direction: "asc" },
		);
		// Module sort has unrelated property keys; the calc-local
		// `sort` slot takes effect.
		const ctx: CaseListEmitContext = {
			moduleIndex: 0,
			sort: [sortKey(propertySortSource("name"), "plain", "asc")],
		};
		const out = emitCalculatedColumnField({
			calculated: calc,
			position: 1,
			ctx,
		});
		// Calc-local sort emits a `<sort>` block WITHOUT an `order`
		// attribute — CCHQ's per-format-default shape at
		// `multi-sort.xml:78-83`. The runtime treats no-order
		// `<sort>` blocks as per-column defaults that the multi-
		// sort UI surfaces alongside the explicit keys.
		expect(out.xml).toContain("<sort");
		expect(out.xml).toContain('direction="ascending"');
		expect(out.xml).not.toMatch(/<sort[^>]*\border=/);
	});

	it("prefers the module-level sort key over a calc-local sort slot", () => {
		const calc = calculatedColumn(
			"my_calc",
			"My Calc",
			term(literal("constant")),
			{ type: "plain", direction: "asc" }, // calc-local
		);
		const ctx: CaseListEmitContext = {
			moduleIndex: 0,
			sort: [sortKey(calculatedSortSource("my_calc"), "integer", "desc")],
		};
		const out = emitCalculatedColumnField({
			calculated: calc,
			position: 1,
			ctx,
		});
		// Module-level config wins: descending int, order=1.
		expect(out.xml).toContain('order="1"');
		expect(out.xml).toContain('direction="descending"');
		expect(out.xml).toContain('type="int"');
	});

	it("emits no sort block when neither module-level nor calc-local sort is authored", () => {
		const calc = calculatedColumn(
			"my_calc",
			"My Calc",
			term(literal("constant")),
		);
		const out = emitCalculatedColumnField({
			calculated: calc,
			position: 1,
			ctx: emptyCtx,
		});
		expect(out.xml).not.toContain("<sort");
	});
});

// ============================================================
// Shell 3 — sort integration with regular columns
// ============================================================

describe("emitColumnField — sort integration", () => {
	it("attaches a sort block when ctx.sort carries a matching property key", () => {
		const col = plainColumn("name", "Name");
		const ctx: CaseListEmitContext = {
			moduleIndex: 0,
			sort: [sortKey(propertySortSource("name"), "plain", "asc")],
		};
		const out = emitColumnField({ column: col, position: 1, ctx });
		expect(out.xml).toContain("<sort");
		expect(out.xml).toContain('order="1"');
		expect(out.xml).toContain('direction="ascending"');
		// Sort xpath = display xpath = bare property for plain columns.
		const sortMatches = out.xml.match(/<sort[\s\S]*?<\/sort>/);
		expect(sortMatches?.[0]).toContain('<xpath function="name"/>');
	});

	it("uses the raw property as sort xpath for date columns even when display is formatted", () => {
		// CCHQ's `Date` format keeps the sort xpath at the raw
		// property (`SORT_XPATH_FUNCTION = "{xpath}"`) so ISO-string
		// lexicographic ordering matches calendar order.
		const col = dateColumn("opened_on", "Opened", "%d/%m/%Y");
		const ctx: CaseListEmitContext = {
			moduleIndex: 0,
			sort: [sortKey(propertySortSource("opened_on"), "date", "desc")],
		};
		const out = emitColumnField({ column: col, position: 1, ctx });
		// Display xpath is the wrapped format-date shape; sort xpath
		// is the bare property.
		const sortMatches = out.xml.match(/<sort[\s\S]*?<\/sort>/);
		expect(sortMatches?.[0]).toContain('<xpath function="opened_on"/>');
		expect(sortMatches?.[0]).not.toContain("format-date");
	});

	it("does not attach a sort block when the column's property is not in ctx.sort", () => {
		const col = plainColumn("name", "Name");
		const ctx: CaseListEmitContext = {
			moduleIndex: 0,
			sort: [sortKey(propertySortSource("birthdate"), "date", "desc")],
		};
		const out = emitColumnField({ column: col, position: 1, ctx });
		expect(out.xml).not.toContain("<sort");
	});

	it("computes the order attribute as the 1-based position in the sort array", () => {
		const col = plainColumn("name", "Name");
		const ctx: CaseListEmitContext = {
			moduleIndex: 0,
			sort: [
				sortKey(propertySortSource("birthdate"), "date", "desc"),
				sortKey(propertySortSource("name"), "plain", "asc"),
			],
		};
		const out = emitColumnField({ column: col, position: 99, ctx });
		// `position` (column position) does NOT influence sort order;
		// only the index in `ctx.sort` does. `name` sits at index 1
		// of `ctx.sort`, so order = 2.
		expect(out.xml).toContain('order="2"');
	});
});

// ============================================================
// Compile-time regression — Column union exhaustion
// ============================================================
//
// Constructing a literal column of every kind catches any drift
// between the test surface and the schema's discriminated union.
// Adding a kind to the union surfaces here as a missing arm in
// the helpers consumed by `emitColumnField`'s `switch`.

describe("emitColumnField — Column union coverage", () => {
	it("emits a `<field>` for every Column kind in the discriminated union", () => {
		const columns: Column[] = [
			plainColumn("a", "A"),
			dateColumn("b", "B", "%Y-%m-%d"),
			timeSinceUntilColumn("c", "C", 1, "days", "L"),
			phoneColumn("d", "D"),
			idMappingColumn("e", "E", [idMappingEntry("v", "L")]),
			lateFlagColumn("f", "F", 1, "days", "*"),
			searchOnlyColumn("g", "G"),
		];
		for (let i = 0; i < columns.length; i++) {
			const out = emitColumnField({
				column: columns[i],
				position: i + 1,
				ctx: emptyCtx,
			});
			expect(out.xml.startsWith("    <field>")).toBe(true);
			expect(out.xml.endsWith("    </field>")).toBe(true);
		}
	});
});
