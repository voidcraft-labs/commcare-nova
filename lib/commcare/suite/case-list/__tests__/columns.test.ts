// lib/commcare/suite/case-list/__tests__/columns.test.ts
//
// Acceptance tests for the per-Column `<field>` block emitter. Each
// test pins the wire shape against the CCHQ source citations live
// alongside each per-format helper in `../columns.ts`. Coverage
// walks every arm of the `Column` discriminated union (plain / date
// / phone / id-mapping / interval / calculated), asserts XML-
// attribute escaping where applicable, and pins the locale-id
// composition rule for header strings.
//
// Tests organize around three shells:
//
//   1. Per-kind regular column emission (one test per arm).
//   2. Calculated column emission — including the inline-variable
//      template shape and short-detail sort routing via the
//      `sortByUuid` map.
//   3. Sort integration — verifies a property-rooted column picks
//      up the matching directive when `ctx.sortByUuid` carries one
//      keyed under the column's uuid.

import { describe, expect, it } from "vitest";
import {
	asUuid,
	type Column,
	calculatedColumn,
	dateColumn,
	idMappingColumn,
	idMappingEntry,
	intervalColumn,
	phoneColumn,
	plainColumn,
	type Uuid,
} from "@/lib/domain";
import { literal, prop, term } from "@/lib/domain/predicate";
import { emitColumnField } from "../columns";
import type { ResolvedSortDirective } from "../sortKeys";
import type { CaseListEmitContext } from "../types";

// ============================================================
// Test helpers
// ============================================================

const COL_UUIDS = {
	a: asUuid("00000000-0000-4000-8000-cccc00000001"),
	b: asUuid("00000000-0000-4000-8000-cccc00000002"),
	c: asUuid("00000000-0000-4000-8000-cccc00000003"),
	d: asUuid("00000000-0000-4000-8000-cccc00000004"),
	e: asUuid("00000000-0000-4000-8000-cccc00000005"),
	f: asUuid("00000000-0000-4000-8000-cccc00000006"),
} as const;

/**
 * Empty short-detail context — module index 0, no sort directives.
 * Tests that need a sort directive construct their own context
 * locally with a populated `sortByUuid` map.
 */
const emptyCtx: CaseListEmitContext = {
	moduleIndex: 0,
	sortByUuid: new Map(),
	detailKind: "short",
	target: "case",
	caseProperties: [],
};

/** Build a single-entry sort map keyed under a column's uuid. */
function singleSort(
	uuid: Uuid,
	directive: ResolvedSortDirective,
): ReadonlyMap<Uuid, ResolvedSortDirective> {
	return new Map([[uuid, directive]]);
}

// ============================================================
// Shell 1 — per-kind regular column emission
// ============================================================

describe("emitColumnField — plain", () => {
	it("emits a bare property reference inside the template", () => {
		const col = plainColumn(COL_UUIDS.a, "full_name", "Name");
		const out = emitColumnField({ column: col, position: 1, ctx: emptyCtx });
		expect(out.xml).toContain("<field>");
		expect(out.xml).toContain('<xpath function="full_name"/>');
		// The header references the CCHQ-canonical locale id shape.
		expect(out.xml).toContain(
			'locale id="m0.case_short.case_full_name_1.header"',
		);
		// app_strings entry registers the column header.
		expect(out.strings).toEqual({
			"m0.case_short.case_full_name_1.header": "Name",
		});
	});

	it("uses the 1-based position to disambiguate two columns on the same property", () => {
		const colA = plainColumn(COL_UUIDS.a, "full_name", "Name A");
		const colB = plainColumn(COL_UUIDS.b, "full_name", "Name B");
		const a = emitColumnField({ column: colA, position: 1, ctx: emptyCtx });
		const b = emitColumnField({ column: colB, position: 2, ctx: emptyCtx });
		expect(a.xml).toContain("m0.case_short.case_full_name_1.header");
		expect(b.xml).toContain("m0.case_short.case_full_name_2.header");
	});

	it("labels a plain single-select while preserving an unknown raw value", () => {
		const col = plainColumn(COL_UUIDS.a, "priority", "Priority");
		const ctx: CaseListEmitContext = {
			...emptyCtx,
			caseProperties: [
				{
					name: "priority",
					label: "Priority",
					data_type: "single_select",
					options: [
						{ value: "routine", label: "Routine" },
						{ value: "urgent", label: "Urgent" },
					],
				},
			],
		};
		const out = emitColumnField({ column: col, position: 1, ctx });

		// Exact equality per arm — `selected()` is space-token membership,
		// so it would let a value like "routine" shadow a later multi-word
		// option ("routine check") by chain order, diverging from
		// Preview's exact-match projection.
		expect(out.xml).toContain(
			"if(priority = &apos;routine&apos;, &apos;Routine&apos;, if(priority = &apos;urgent&apos;, &apos;Urgent&apos;, priority))",
		);
	});

	it("labels a multi-word single-select value exactly, never by token prefix", () => {
		const col = plainColumn(COL_UUIDS.a, "region", "Region");
		const ctx: CaseListEmitContext = {
			...emptyCtx,
			caseProperties: [
				{
					name: "region",
					label: "Region",
					data_type: "single_select",
					options: [
						{ value: "north", label: "North" },
						{ value: "north region", label: "North Region" },
					],
				},
			],
		};
		const out = emitColumnField({ column: col, position: 1, ctx });

		// A stored "north region" must render "North Region": the equality
		// chain's first arm (region = 'north') is false for it, unlike the
		// old selected() membership which was true and won by chain order.
		expect(out.xml).toContain(
			"if(region = &apos;north&apos;, &apos;North&apos;, if(region = &apos;north region&apos;, &apos;North Region&apos;, region))",
		);
	});

	it("labels known multi-select tokens and leaves imported tokens visible", () => {
		const col = plainColumn(COL_UUIDS.a, "tags", "Tags");
		const ctx: CaseListEmitContext = {
			...emptyCtx,
			caseProperties: [
				{
					name: "tags",
					label: "Tags",
					data_type: "multi_select",
					options: [
						{ value: "vip", label: "VIP" },
						{ value: "follow.up", label: "Needs follow-up" },
					],
				},
			],
		};
		const out = emitColumnField({ column: col, position: 1, ctx });

		// Known labels use selected() in catalog order. The independent raw-value
		// remainder removes known tokens with escaped regex literals, so an
		// unknown historical token survives the final normalize-space(concat()).
		expect(out.xml).toContain(
			"if(selected(tags, &apos;vip&apos;), &apos;VIP&apos;, &apos;&apos;)",
		);
		expect(out.xml).toContain(
			"if(selected(tags, &apos;follow.up&apos;), &apos;Needs follow-up&apos;, &apos;&apos;)",
		);
		expect(out.xml).toContain("&apos; follow\\.up &apos;");
		expect(out.xml).toContain("normalize-space(concat(");
		// The remainder double-spaces the normalized value so every token owns
		// both flanking spaces: Java regex matching is non-overlapping, and
		// single-space delimiters would let the second copy of a duplicated
		// known token escape removal (` vip vip ` shares the middle space) and
		// render as a bogus unknown on device while Preview hides it.
		expect(out.xml).toContain(
			"concat(&apos;  &apos;, replace(normalize-space(tags), &apos; &apos;, &apos;  &apos;), &apos;  &apos;)",
		);
	});
});

describe("emitColumnField — date", () => {
	it("lowers a semantic preset to the same supported pattern as Preview", () => {
		const col = dateColumn(COL_UUIDS.a, "opened_on", "Opened", "long");
		const out = emitColumnField({ column: col, position: 1, ctx: emptyCtx });
		expect(out.xml).toContain(
			"format-date(date(opened_on), &apos;%B %e, %Y&apos;)",
		);
	});

	it("wraps the property in CCHQ's empty-string-guarded format-date shape", () => {
		const col = dateColumn(COL_UUIDS.a, "opened_on", "Opened", "%d/%m/%Y");
		const out = emitColumnField({ column: col, position: 1, ctx: emptyCtx });
		// CCHQ's date-format wire shape: per
		// `detail_screen.py::Date`, `if({xpath} = '', '', format-date(date({xpath}), 'pattern'))`.
		// XPath single-quote literals round-trip through the serializer
		// as `&apos;` inside the double-quoted attribute value.
		expect(out.xml).toContain(
			"if(opened_on = &apos;&apos;, &apos;&apos;, format-date(date(opened_on), &apos;%d/%m/%Y&apos;))",
		);
	});

	it("threads the pattern through quoteLiteral's concat-fallback when it carries an embedded quote", () => {
		// `'em%dpattern` would break the `format-date(date(...), '<pattern>')`
		// shape if the helper interpolated naively; the concat-fallback
		// shape preserves the literal.
		const col = dateColumn(COL_UUIDS.a, "opened_on", "Opened", "'em%dpattern");
		const out = emitColumnField({ column: col, position: 1, ctx: emptyCtx });
		expect(out.xml).toContain("concat(");
		// The concat-fallback's literal-quote separator is `"'"` which
		// the serializer renders as `&quot;&apos;&quot;` inside the
		// attribute value.
		expect(out.xml).toContain(`&quot;&apos;&quot;`);
	});
});

describe("emitColumnField — interval (display: always)", () => {
	it("emits the days-equivalent divisor + threshold for a weeks-unit column", () => {
		const col = intervalColumn(
			COL_UUIDS.a,
			"last_visit",
			"Weeks since visit",
			4,
			"weeks",
			"always",
			"Overdue",
		);
		const out = emitColumnField({ column: col, position: 1, ctx: emptyCtx });
		// Divisor for weeks = 7; threshold in days = 4 * 7 = 28.
		// Inner shape: `string(int((today() - date(last_visit)) div 7))`.
		expect(out.xml).toContain(
			"string(int((today() - date(last_visit)) div 7))",
		);
		// Overdue branch: `if(today() - date(last_visit) > 28, 'Overdue', ...)`.
		// XPath single-quote literals round-trip as `&apos;`.
		expect(out.xml).toContain(
			"if(today() - date(last_visit) &gt; 28, &apos;Overdue&apos;,",
		);
		// Outer empty-string short-circuit.
		expect(out.xml).toContain("if(last_visit = &apos;&apos;, &apos;&apos;,");
	});

	it("uses 365.25 as the divisor for years-unit columns", () => {
		const col = intervalColumn(
			COL_UUIDS.a,
			"dob",
			"Age",
			18,
			"years",
			"always",
			"Adult",
		);
		const out = emitColumnField({ column: col, position: 1, ctx: emptyCtx });
		// Divisor for years = 365.25; threshold = 18 * 365.25 = 6574.5.
		expect(out.xml).toContain("(today() - date(dob)) div 365.25");
		expect(out.xml).toContain("today() - date(dob) &gt; 6574.5");
	});

	it("uses 30.4375 (365.25/12) as the divisor for months-unit columns", () => {
		const col = intervalColumn(
			COL_UUIDS.a,
			"opened_on",
			"Months open",
			3,
			"months",
			"always",
			"Aged",
		);
		const out = emitColumnField({ column: col, position: 1, ctx: emptyCtx });
		// Divisor for months = 365.25 / 12 = 30.4375; threshold = 3 * 30.4375 = 91.3125.
		expect(out.xml).toContain("(today() - date(opened_on)) div 30.4375");
		expect(out.xml).toContain("today() - date(opened_on) &gt; 91.3125");
	});

	it("uses 1 as the divisor for days-unit columns", () => {
		const col = intervalColumn(
			COL_UUIDS.a,
			"last_visit",
			"Days",
			7,
			"days",
			"always",
			"Late",
		);
		const out = emitColumnField({ column: col, position: 1, ctx: emptyCtx });
		expect(out.xml).toContain("(today() - date(last_visit)) div 1");
		expect(out.xml).toContain("today() - date(last_visit) &gt; 7");
	});
});

describe("emitColumnField — interval (display: flag)", () => {
	it("emits both absent-and-overdue branches with the author's text string", () => {
		const col = intervalColumn(
			COL_UUIDS.a,
			"last_visit",
			"Overdue",
			30,
			"days",
			"flag",
			"!",
		);
		const out = emitColumnField({ column: col, position: 1, ctx: emptyCtx });
		// CCHQ's wire shape per `detail_screen.py::LateFlag.XPATH_FUNCTION`:
		// `if({xpath} = '', '<flag>', if(today() - date({xpath}) > <threshold>, '<flag>', ''))`.
		// XPath single-quote literals round-trip as `&apos;`.
		expect(out.xml).toContain(
			"if(last_visit = &apos;&apos;, &apos;!&apos;, if(today() - date(last_visit) &gt; 30, &apos;!&apos;, &apos;&apos;))",
		);
	});

	it("multiplies by the days-equivalent divisor for non-day units", () => {
		const col = intervalColumn(
			COL_UUIDS.a,
			"last_visit",
			"Overdue",
			4,
			"weeks",
			"flag",
			"!",
		);
		const out = emitColumnField({ column: col, position: 1, ctx: emptyCtx });
		// Threshold = 4 * 7 = 28 days.
		expect(out.xml).toContain("today() - date(last_visit) &gt; 28");
	});

	it("escapes embedded quotes in the flag text value", () => {
		const col = intervalColumn(
			COL_UUIDS.a,
			"last_visit",
			"Overdue",
			30,
			"days",
			"flag",
			"I'm late",
		);
		const out = emitColumnField({ column: col, position: 1, ctx: emptyCtx });
		// Concat-fallback flips a single-quoted literal to a concat
		// shape because the value carries `'`.
		expect(out.xml).toContain("concat(");
	});
});

describe("emitColumnField — phone", () => {
	it("emits the bare property reference for short-detail phone columns", () => {
		// CCHQ's `Phone` format inherits the bare-property XPath from
		// the base class on short detail; only the long detail picks
		// up `template_form="phone"` (per
		// `detail_screen.py::Phone.template_form`).
		const col = phoneColumn(COL_UUIDS.a, "phone", "Phone");
		const out = emitColumnField({ column: col, position: 1, ctx: emptyCtx });
		expect(out.xml).toContain('<xpath function="phone"/>');
		expect(out.xml).not.toContain('form="phone"');
	});
});

describe("emitColumnField — id-mapping", () => {
	it("renders a chain of selected() arms wrapped in replace(join(...))", () => {
		const col = idMappingColumn(COL_UUIDS.a, "region_code", "Region", [
			idMappingEntry("N", "North"),
			idMappingEntry("S", "South"),
		]);
		const out = emitColumnField({ column: col, position: 1, ctx: emptyCtx });
		// CCHQ's `xml_models.py::XPathEnum.build` shape (the
		// `enum`-display arm wraps the per-key `if(selected(...))`
		// chain in `replace(join(' ', ..., ''), '\s+', ' ')`).
		// XPath single-quote literals round-trip as `&apos;`.
		expect(out.xml).toContain(
			"replace(join(&apos; &apos;, if(selected(region_code, &apos;N&apos;), &apos;North&apos;, &apos;&apos;), if(selected(region_code, &apos;S&apos;), &apos;South&apos;, &apos;&apos;)), &apos;\\s+&apos;, &apos; &apos;)",
		);
	});

	it("emits the empty-string XPath for a zero-entry mapping", () => {
		const col = idMappingColumn(COL_UUIDS.a, "region_code", "Region", []);
		const out = emitColumnField({ column: col, position: 1, ctx: emptyCtx });
		// Empty mapping => `''` literal — round-trips as `&apos;&apos;`
		// inside the attribute value.
		expect(out.xml).toContain('<xpath function="&apos;&apos;"/>');
	});

	it("escapes embedded quotes in mapping values + labels through quoteLiteral", () => {
		const col = idMappingColumn(COL_UUIDS.a, "region_code", "Region", [
			idMappingEntry("O'Brien", "O'Brien region"),
		]);
		const out = emitColumnField({ column: col, position: 1, ctx: emptyCtx });
		// Each side flips to a concat-fallback shape because the
		// embedded `'` can't fit a single-quoted XPath string literal.
		expect(out.xml).toContain("concat(");
		// `&quot;` / `&apos;` are the XML attribute-value escapes for
		// `"` and `'`. The concat-fallback's literal-quote separator
		// `"'"` renders as `&quot;&apos;&quot;` inside the attribute.
		expect(out.xml).toContain(`&quot;&apos;&quot;`);
	});
});

// ============================================================
// Shell 2 — calculated column emission
// ============================================================

describe("emitColumnField — calculated", () => {
	it("emits the CCHQ inline-variable template shape with a calc-property locale id", () => {
		// `term(prop("patient", "full_name"))` lowers to a bare `full_name`
		// XPath via the on-device emitter — sufficient to pin the
		// surrounding template structure.
		const calc = calculatedColumn(
			COL_UUIDS.a,
			"My Calc",
			term(prop("patient", "full_name")),
		);
		const out = emitColumnField({
			column: calc,
			position: 1,
			ctx: emptyCtx,
		});
		// Header locale id uses the CCHQ `case_calculated_property_<i>`
		// convention.
		expect(out.xml).toContain(
			'locale id="m0.case_short.case_calculated_property_1.header"',
		);
		// Template references `$calculated_property` and embeds the
		// lowered XPath as a `<variable>` block. `$` is not a special XML
		// character, so it serializes verbatim — matching CCHQ's own
		// bare-`$` suite.xml.
		expect(out.xml).toContain('<xpath function="$calculated_property">');
		expect(out.xml).toContain('<variable name="calculated_property">');
		expect(out.xml).toContain('<xpath function="full_name"/>');
		// The strings map carries the calc's authored header text.
		expect(out.strings).toEqual({
			"m0.case_short.case_calculated_property_1.header": "My Calc",
		});
	});

	it("attaches a sort block when ctx.sortByUuid carries a directive for the calc", () => {
		const calc = calculatedColumn(
			COL_UUIDS.a,
			"My Calc",
			term(literal("constant")),
		);
		const ctx: CaseListEmitContext = {
			moduleIndex: 0,
			detailKind: "short",
			target: "case",
			caseProperties: [],
			sortByUuid: singleSort(calc.uuid, {
				kind: "calculated",
				order: 1,
				direction: "desc",
				type: "plain",
				calcXpath: "'constant'",
			}),
		};
		const out = emitColumnField({ column: calc, position: 1, ctx });
		// The sort block uses the inline-variable shape so the sort
		// xpath references `$calculated_property` and the same
		// `<variable>` rides inside it.
		expect(out.xml).toContain("<sort");
		expect(out.xml).toContain('order="1"');
		expect(out.xml).toContain('direction="descending"');
		const sortMatches = out.xml.match(/<sort[\s\S]*?<\/sort>/);
		expect(sortMatches).not.toBeNull();
		const sortBlock = sortMatches?.[0] ?? "";
		// `$calculated_property` serializes verbatim (bare `$`); XPath
		// `'constant'` literal encodes as `&apos;constant&apos;`.
		expect(sortBlock).toContain('<xpath function="$calculated_property">');
		expect(sortBlock).toContain("&apos;constant&apos;");
	});

	it("emits no sort block when no directive targets the calc's uuid", () => {
		const calc = calculatedColumn(
			COL_UUIDS.a,
			"My Calc",
			term(literal("constant")),
		);
		const out = emitColumnField({
			column: calc,
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
	it("attaches a sort block when ctx.sortByUuid carries a directive keyed by the column uuid", () => {
		const col = plainColumn(COL_UUIDS.a, "full_name", "Name");
		const ctx: CaseListEmitContext = {
			moduleIndex: 0,
			detailKind: "short",
			target: "case",
			caseProperties: [],
			sortByUuid: singleSort(col.uuid, {
				kind: "property",
				order: 1,
				direction: "asc",
				type: "plain",
				xpath: "full_name",
			}),
		};
		const out = emitColumnField({ column: col, position: 1, ctx });
		expect(out.xml).toContain("<sort");
		expect(out.xml).toContain('order="1"');
		expect(out.xml).toContain('direction="ascending"');
		// Sort xpath = bare property for plain columns.
		const sortMatches = out.xml.match(/<sort[\s\S]*?<\/sort>/);
		expect(sortMatches?.[0]).toContain('<xpath function="full_name"/>');
	});

	it("uses the raw property as sort xpath for date columns even when display is formatted", () => {
		// CCHQ's `Date` format keeps the sort xpath at the raw
		// property (`SORT_XPATH_FUNCTION = "{xpath}"`) so ISO-string
		// lexicographic ordering matches calendar order. The directive
		// builder writes the raw property into `directive.xpath`; the
		// emitter passes it through verbatim.
		const col = dateColumn(COL_UUIDS.a, "opened_on", "Opened", "%d/%m/%Y");
		const ctx: CaseListEmitContext = {
			moduleIndex: 0,
			detailKind: "short",
			target: "case",
			caseProperties: [],
			sortByUuid: singleSort(col.uuid, {
				kind: "property",
				order: 1,
				direction: "desc",
				type: "date",
				xpath: "opened_on",
			}),
		};
		const out = emitColumnField({ column: col, position: 1, ctx });
		// Display xpath is the wrapped format-date shape; sort xpath
		// is the bare property.
		const sortMatches = out.xml.match(/<sort[\s\S]*?<\/sort>/);
		expect(sortMatches?.[0]).toContain('<xpath function="opened_on"/>');
		expect(sortMatches?.[0]).not.toContain("format-date");
	});

	it("does not attach a sort block when the column's uuid has no directive in ctx.sortByUuid", () => {
		const col = plainColumn(COL_UUIDS.a, "full_name", "Name");
		const otherUuid = asUuid("00000000-0000-4000-8000-cccc99999999");
		const ctx: CaseListEmitContext = {
			moduleIndex: 0,
			detailKind: "short",
			target: "case",
			caseProperties: [],
			sortByUuid: singleSort(otherUuid, {
				kind: "property",
				order: 1,
				direction: "desc",
				type: "date",
				xpath: "birthdate",
			}),
		};
		const out = emitColumnField({ column: col, position: 1, ctx });
		expect(out.xml).not.toContain("<sort");
	});
});

// ============================================================
// Compile-time regression — Column union exhaustion
// ============================================================
//
// Constructing a literal column of every kind catches any drift
// between the test surface and the schema's discriminated union.
// Adding a kind to the union surfaces here as a missing arm in
// the helpers consumed by `emitColumnField`'s switch.

describe("emitColumnField — Column union coverage", () => {
	it("emits a `<field>` for every Column kind in the discriminated union", () => {
		const columns: Column[] = [
			plainColumn(COL_UUIDS.a, "a", "A"),
			dateColumn(COL_UUIDS.b, "b", "B", "%Y-%m-%d"),
			phoneColumn(COL_UUIDS.c, "c", "C"),
			idMappingColumn(COL_UUIDS.d, "d", "D", [idMappingEntry("v", "L")]),
			intervalColumn(COL_UUIDS.e, "e", "E", 1, "days", "always", "Late"),
			calculatedColumn(COL_UUIDS.f, "F", term(literal("constant"))),
		];
		for (let i = 0; i < columns.length; i++) {
			const out = emitColumnField({
				column: columns[i],
				position: i + 1,
				ctx: emptyCtx,
			});
			// Compact serializer output — `<field>` opens the emission,
			// `</field>` closes it, with no per-element whitespace.
			expect(out.xml.startsWith("<field>")).toBe(true);
			expect(out.xml.endsWith("</field>")).toBe(true);
		}
	});
});
