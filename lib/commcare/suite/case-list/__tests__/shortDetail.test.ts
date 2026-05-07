// lib/commcare/suite/case-list/__tests__/shortDetail.test.ts
//
// Golden-file acceptance tests for `emitShortDetail` — the
// orchestrator that walks `module.caseListConfig` and produces
// the suite-XML `<detail id="m{n}_case_short">` block. Each
// fixture pins the wire shape against canonical CCHQ-HQ source
// fixtures at
// `commcare-hq/corehq/apps/app_manager/tests/data/suite/`:
//
//   - `multi-sort.xml` — multi-key sort across three property
//     columns (covers the order-attribute composition rule).
//   - `search_command_detail.xml` — calc column inside a short
//     detail (covers the inline-variable template shape).
//   - `normal-suite.xml` — every CCHQ format kind (covers the
//     per-kind XPath shapes).
//
// Tests organize around three shells:
//
//   1. Empty / minimal — no caseListConfig OR no case type
//      collapses to a title-only `<detail>` block.
//   2. Per-kind golden — one regular column per kind plus the
//      two calc shapes (with / without sort).
//   3. Multi-kind / multi-sort integration — pins the order in
//      which columns + calcs render, the `order` attribute on
//      multi-key sort, and the locale-id collision-disambiguation
//      via 1-based positional suffix.

import { describe, expect, it } from "vitest";
import {
	asUuid,
	type CaseListConfig,
	calculatedColumn,
	calculatedSortSource,
	dateColumn,
	idMappingColumn,
	idMappingEntry,
	lateFlagColumn,
	type Module,
	phoneColumn,
	plainColumn,
	propertySortSource,
	searchOnlyColumn,
	sortKey,
	timeSinceUntilColumn,
} from "@/lib/domain";
import { prop, term } from "@/lib/domain/predicate/builders";
import { emitShortDetail } from "../shortDetail";

/**
 * Helper — construct a minimal `Module` for testing. The `uuid`
 * is fixed so test output stays deterministic; `caseType` is
 * threaded through because every emit-active path requires it.
 */
function makeModule(args: {
	readonly caseType?: string;
	readonly caseListConfig?: CaseListConfig;
}): Module {
	return {
		uuid: asUuid("00000000-0000-4000-8000-000000000001"),
		id: "test_module",
		name: "Test Module",
		caseType: args.caseType,
		caseListConfig: args.caseListConfig,
	};
}

/** Build a populated CaseListConfig with sensible defaults. */
function makeConfig(overrides: Partial<CaseListConfig> = {}): CaseListConfig {
	return {
		columns: [],
		sort: [],
		calculatedColumns: [],
		searchInputs: [],
		...overrides,
	};
}

// ============================================================
// Shell 1 — empty / minimal
// ============================================================

describe("emitShortDetail — empty cases", () => {
	it("emits a title-only detail when caseListConfig is absent", () => {
		const mod = makeModule({ caseType: "patient" });
		const out = emitShortDetail({ module: mod, moduleIndex: 0 });
		// Per CCHQ's Detail XSD shape (`xml_models.py:935-958`), the
		// `<title>` element is required; a zero-field detail still
		// carries it.
		expect(out.xml).toContain('<detail id="m0_case_short">');
		expect(out.xml).toContain('<locale id="cchq.case"/>');
		expect(out.xml).not.toContain("<field>");
		expect(out.strings).toEqual({});
	});

	it("emits a title-only detail when the module has no case type", () => {
		// Survey-only modules (no case type) still emit the detail
		// shell so suite-XML structure stays uniform; the validator
		// gates non-empty configs against case-type presence.
		const mod = makeModule({
			caseListConfig: makeConfig({ columns: [plainColumn("name", "Name")] }),
		});
		const out = emitShortDetail({ module: mod, moduleIndex: 0 });
		expect(out.xml).toContain('<detail id="m0_case_short">');
		expect(out.xml).not.toContain("<field>");
	});

	it("emits a title-only detail when caseListConfig has empty columns and calcs", () => {
		const mod = makeModule({
			caseType: "patient",
			caseListConfig: makeConfig(),
		});
		const out = emitShortDetail({ module: mod, moduleIndex: 0 });
		expect(out.xml).toContain('<detail id="m0_case_short">');
		expect(out.xml).not.toContain("<field>");
		expect(out.strings).toEqual({});
	});
});

// ============================================================
// Shell 2 — single-kind golden cases
// ============================================================

describe("emitShortDetail — single-kind goldens", () => {
	it("emits a plain text column matching the CCHQ canonical structure", () => {
		const mod = makeModule({
			caseType: "patient",
			caseListConfig: makeConfig({
				columns: [plainColumn("name", "Name")],
			}),
		});
		const out = emitShortDetail({ module: mod, moduleIndex: 0 });
		// Golden: full <detail> block.
		expect(out.xml).toBe(
			[
				`  <detail id="m0_case_short">`,
				`    <title>`,
				`      <text>`,
				`        <locale id="cchq.case"/>`,
				`      </text>`,
				`    </title>`,
				`    <field>`,
				`      <header>`,
				`        <text>`,
				`          <locale id="m0.case_short.case_name_1.header"/>`,
				`        </text>`,
				`      </header>`,
				`      <template>`,
				`        <text>`,
				`          <xpath function="name"/>`,
				`        </text>`,
				`      </template>`,
				`    </field>`,
				`  </detail>`,
			].join("\n"),
		);
		expect(out.strings).toEqual({
			"m0.case_short.case_name_1.header": "Name",
		});
	});

	it("emits a multi-key sort matching the CCHQ multi-sort.xml fixture shape", () => {
		// Cross-reference: `commcare-hq/corehq/apps/app_manager/tests/data/suite/multi-sort.xml`.
		// Three property columns, each carrying a sort key; the wire
		// `order` attributes 1/2/3 come from the keys' index in
		// `caseListConfig.sort`.
		const mod = makeModule({
			caseType: "patient",
			caseListConfig: makeConfig({
				columns: [
					dateColumn("birthdate", "Birthdate", "%d/%m/%y"),
					plainColumn("case_name", "Name"),
					dateColumn("date_opened", "Opened", "%d/%m/%y"),
				],
				sort: [
					sortKey(propertySortSource("birthdate"), "date", "desc"),
					sortKey(propertySortSource("date_opened"), "date", "desc"),
					sortKey(propertySortSource("case_name"), "plain", "asc"),
				],
			}),
		});
		const out = emitShortDetail({ module: mod, moduleIndex: 0 });
		// Each sort block carries its 1-based order.
		expect(out.xml).toMatch(
			/<sort type="string" order="1" direction="descending">[\s\S]*?<xpath function="birthdate"\/>/,
		);
		expect(out.xml).toMatch(
			/<sort type="string" order="2" direction="descending">[\s\S]*?<xpath function="date_opened"\/>/,
		);
		expect(out.xml).toMatch(
			/<sort type="string" order="3" direction="ascending">[\s\S]*?<xpath function="case_name"\/>/,
		);
	});

	it("registers headers under the CCHQ-canonical locale ids", () => {
		const mod = makeModule({
			caseType: "patient",
			caseListConfig: makeConfig({
				columns: [plainColumn("name", "Name"), phoneColumn("phone", "Phone")],
			}),
		});
		const out = emitShortDetail({ module: mod, moduleIndex: 2 });
		expect(out.strings).toEqual({
			"m2.case_short.case_name_1.header": "Name",
			"m2.case_short.case_phone_2.header": "Phone",
		});
	});
});

// ============================================================
// Shell 3 — multi-kind / calc integration
// ============================================================

describe("emitShortDetail — calculated columns", () => {
	it("renders calc columns AFTER regular columns in the field list", () => {
		// CCHQ's wire convention places calc fields at the end of
		// the regular field list.
		const mod = makeModule({
			caseType: "patient",
			caseListConfig: makeConfig({
				columns: [plainColumn("name", "Name")],
				calculatedColumns: [
					calculatedColumn(
						"my_calc",
						"My Calc",
						term(prop("patient", "phone")),
					),
				],
			}),
		});
		const out = emitShortDetail({ module: mod, moduleIndex: 0 });
		// Field order: name comes before the calc. Calc position is
		// global per CCHQ's `column.id + 1` numbering — with 1
		// regular column the calc is at position 2.
		const nameIdx = out.xml.indexOf("case_name_1");
		const calcIdx = out.xml.indexOf("case_calculated_property_2");
		expect(nameIdx).toBeGreaterThan(-1);
		expect(calcIdx).toBeGreaterThan(-1);
		expect(nameIdx).toBeLessThan(calcIdx);
	});

	it("uses the calc's lowered XPath inside a <variable name='calculated_property'>", () => {
		const mod = makeModule({
			caseType: "patient",
			caseListConfig: makeConfig({
				calculatedColumns: [
					calculatedColumn(
						"my_calc",
						"My Calc",
						term(prop("patient", "phone")),
					),
				],
			}),
		});
		const out = emitShortDetail({ module: mod, moduleIndex: 0 });
		expect(out.xml).toContain('<xpath function="$calculated_property">');
		expect(out.xml).toContain('<variable name="calculated_property">');
		expect(out.xml).toContain('<xpath function="phone"/>');
	});

	it("threads calc-targeting sort keys into the calc's <sort> block", () => {
		const mod = makeModule({
			caseType: "patient",
			caseListConfig: makeConfig({
				calculatedColumns: [
					calculatedColumn(
						"my_calc",
						"My Calc",
						term(prop("patient", "phone")),
					),
				],
				sort: [sortKey(calculatedSortSource("my_calc"), "plain", "desc")],
			}),
		});
		const out = emitShortDetail({ module: mod, moduleIndex: 0 });
		// The sort block uses the inline-variable shape — the
		// calc's xpath rides inside `$calculated_property` again.
		expect(out.xml).toMatch(
			/<sort type="string" order="1" direction="descending">[\s\S]*?<xpath function="\$calculated_property">[\s\S]*?<variable name="calculated_property">[\s\S]*?<xpath function="phone"\/>/,
		);
	});
});

describe("emitShortDetail — multi-kind integration", () => {
	it("emits a populated detail with every kind + a calc + a sort key", () => {
		const mod = makeModule({
			caseType: "patient",
			caseListConfig: makeConfig({
				columns: [
					plainColumn("name", "Name"),
					dateColumn("birthdate", "Birthdate", "%d/%m/%y"),
					timeSinceUntilColumn(
						"last_visit",
						"Weeks since visit",
						2,
						"weeks",
						"Overdue",
					),
					phoneColumn("phone", "Phone"),
					idMappingColumn("region", "Region", [
						idMappingEntry("N", "North"),
						idMappingEntry("S", "South"),
					]),
					lateFlagColumn("last_visit", "Late", 4, "weeks", "!"),
					searchOnlyColumn("external_id", "External ID"),
				],
				calculatedColumns: [
					calculatedColumn("my_calc", "My Calc", term(prop("patient", "name"))),
				],
				sort: [sortKey(propertySortSource("name"), "plain", "asc")],
			}),
		});
		const out = emitShortDetail({ module: mod, moduleIndex: 0 });

		// Structural assertions — pin the per-kind wire shape lives
		// once, surfaces here as the integration check.
		expect(out.xml).toContain('<detail id="m0_case_short">');
		expect(out.xml).toContain('<locale id="cchq.case"/>');

		// Plain field — bare property reference.
		expect(out.xml).toContain('<xpath function="name"/>');

		// Date field — empty-string short-circuit + format-date wrap.
		expect(out.xml).toContain(
			"if(birthdate = '', '', format-date(date(birthdate), '%d/%m/%y'))",
		);

		// Time-since-until field — divisor 7, threshold 14, label.
		expect(out.xml).toContain("(today() - date(last_visit)) div 7");
		expect(out.xml).toContain("today() - date(last_visit) &gt; 14");
		expect(out.xml).toContain("'Overdue'");

		// Phone — same XPath as plain on short detail.
		expect(out.xml).toContain('<xpath function="phone"/>');

		// ID-mapping — selected() chain wrapped in replace(join(...)).
		expect(out.xml).toContain(
			"replace(join(' ', if(selected(region, 'N'), 'North', ''), if(selected(region, 'S'), 'South', '')), '\\s+', ' ')",
		);

		// Late-flag — threshold 4 weeks = 28 days.
		expect(out.xml).toContain(
			"if(last_visit = '', '!', if(today() - date(last_visit) &gt; 28, '!', ''))",
		);

		// Search-only — width=0 hidden field.
		expect(out.xml).toContain('<header width="0">');
		expect(out.xml).toContain('<template width="0">');
		expect(out.xml).toContain('<xpath function="external_id"/>');

		// Calculated column — inline-variable template shape.
		expect(out.xml).toContain('<xpath function="$calculated_property">');
		expect(out.xml).toContain('<variable name="calculated_property">');

		// Sort attached to the name column.
		expect(out.xml).toMatch(
			/<sort type="string" order="1" direction="ascending">[\s\S]*?<xpath function="name"\/>/,
		);

		// Locale ids registered in app_strings — only the visible
		// (non-search-only) columns + the calc's calculated_property
		// id surface here. The calc's position continues the global
		// 1-based count (7 regular columns + 1 = position 8) per
		// CCHQ's `detail_column_header_locale` global numbering at
		// `id_strings.py:105-117`.
		expect(out.strings).toMatchObject({
			"m0.case_short.case_name_1.header": "Name",
			"m0.case_short.case_birthdate_2.header": "Birthdate",
			"m0.case_short.case_last_visit_3.header": "Weeks since visit",
			"m0.case_short.case_phone_4.header": "Phone",
			"m0.case_short.case_region_5.header": "Region",
			"m0.case_short.case_last_visit_6.header": "Late",
			"m0.case_short.case_calculated_property_8.header": "My Calc",
		});
		// Search-only columns do NOT register a header string.
		expect(out.strings).not.toHaveProperty(
			"m0.case_short.case_external_id_7.header",
		);
	});

	it("composes locale ids against the supplied moduleIndex", () => {
		const mod = makeModule({
			caseType: "patient",
			caseListConfig: makeConfig({
				columns: [plainColumn("name", "Name")],
			}),
		});
		const out = emitShortDetail({ module: mod, moduleIndex: 5 });
		expect(out.xml).toContain('<detail id="m5_case_short">');
		expect(out.xml).toContain('locale id="m5.case_short.case_name_1.header"');
		expect(out.strings).toEqual({
			"m5.case_short.case_name_1.header": "Name",
		});
	});
});
