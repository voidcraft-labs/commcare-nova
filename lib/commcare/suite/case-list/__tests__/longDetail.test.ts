// lib/commcare/suite/case-list/__tests__/longDetail.test.ts
//
// Golden-file acceptance tests for `emitLongDetail` — the
// orchestrator that walks `module.caseListConfig` and produces
// the suite-XML `<detail id="m{n}_case_long">` block. Each
// fixture pins the wire shape against canonical CCHQ-HQ source
// fixtures at `commcare-hq/corehq/apps/app_manager/tests/data/suite/`:
//
//   - `normal-suite.xml::<detail id="m0_case_long">` — covers
//     `<template form="phone">` on long-detail phone columns,
//     `case_long` locale-id substring, and calc-property
//     numbering continuing past regular columns.
//   - `multi-sort.xml::<detail id="m0_case_long">` — confirms
//     zero `<sort>` blocks on long detail despite a multi-key
//     sort active on the parent module's short detail.
//
// Tests organize around three shells:
//
//   1. Empty / minimal — no caseListConfig OR no case type
//      collapses to a title-only `<detail>` block.
//   2. Source-list resolution — `detailColumns` present uses
//      that override; absent falls back to `columns`.
//   3. Per-kind goldens + multi-kind integration — one regular
//      column per kind, the calc shape, and the long-detail
//      divergences from short detail (no `<sort>`,
//      `<template form="phone">`, search-only skip with
//      position-counter advance).

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
import { emitLongDetail } from "../longDetail";

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

describe("emitLongDetail — empty cases", () => {
	it("emits a title-only detail when caseListConfig is absent", () => {
		const mod = makeModule({ caseType: "patient" });
		const out = emitLongDetail({ module: mod, moduleIndex: 0 });
		// CCHQ's `xml_models.py::Detail` model declares `title` as a
		// non-optional `NodeField`, so a zero-field detail still
		// carries the `<title>` element.
		expect(out.xml).toContain('<detail id="m0_case_long">');
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
		const out = emitLongDetail({ module: mod, moduleIndex: 0 });
		expect(out.xml).toContain('<detail id="m0_case_long">');
		expect(out.xml).not.toContain("<field>");
	});

	it("emits a title-only detail when caseListConfig has empty columns and calcs", () => {
		const mod = makeModule({
			caseType: "patient",
			caseListConfig: makeConfig(),
		});
		const out = emitLongDetail({ module: mod, moduleIndex: 0 });
		expect(out.xml).toContain('<detail id="m0_case_long">');
		expect(out.xml).not.toContain("<field>");
		expect(out.strings).toEqual({});
	});
});

// ============================================================
// Shell 2 — source list resolution (detailColumns vs columns)
// ============================================================

describe("emitLongDetail — source list resolution", () => {
	it("uses detailColumns when present (override)", () => {
		// `detailColumns` is the optional long-detail override per
		// the schema's authoring contract. When present it replaces
		// the short-detail's `columns` list as the long-detail
		// source.
		const mod = makeModule({
			caseType: "patient",
			caseListConfig: makeConfig({
				columns: [plainColumn("name", "Name")],
				detailColumns: [
					plainColumn("name", "Full Name"),
					plainColumn("dob", "Date of Birth"),
				],
			}),
		});
		const out = emitLongDetail({ module: mod, moduleIndex: 0 });
		// The override populates the long detail with two fields.
		expect(out.xml).toContain('<xpath function="name"/>');
		expect(out.xml).toContain('<xpath function="dob"/>');
		// Headers register the override's text (not the short
		// detail's "Name").
		expect(out.strings).toEqual({
			"m0.case_long.case_name_1.header": "Full Name",
			"m0.case_long.case_dob_2.header": "Date of Birth",
		});
	});

	it("falls back to columns when detailColumns is absent (mirror)", () => {
		// When `detailColumns` is omitted, the long detail mirrors
		// the short detail's column list — Nova's "no separate long
		// detail" authoring shape.
		const mod = makeModule({
			caseType: "patient",
			caseListConfig: makeConfig({
				columns: [plainColumn("name", "Name"), plainColumn("dob", "DOB")],
			}),
		});
		const out = emitLongDetail({ module: mod, moduleIndex: 0 });
		expect(out.xml).toContain('<xpath function="name"/>');
		expect(out.xml).toContain('<xpath function="dob"/>');
		expect(out.strings).toEqual({
			"m0.case_long.case_name_1.header": "Name",
			"m0.case_long.case_dob_2.header": "DOB",
		});
	});

	it("uses detailColumns even when both columns and detailColumns are populated", () => {
		// Override semantic — `detailColumns` doesn't merge with
		// `columns`; it replaces.
		const mod = makeModule({
			caseType: "patient",
			caseListConfig: makeConfig({
				columns: [
					plainColumn("name", "Short Name"),
					plainColumn("phone", "Phone"),
				],
				detailColumns: [plainColumn("dob", "DOB")],
			}),
		});
		const out = emitLongDetail({ module: mod, moduleIndex: 0 });
		// Only the override's field renders; short-detail fields
		// don't bleed through.
		expect(out.xml).toContain('<xpath function="dob"/>');
		expect(out.xml).not.toContain('<xpath function="phone"/>');
		expect(out.strings).toEqual({
			"m0.case_long.case_dob_1.header": "DOB",
		});
	});
});

// ============================================================
// Shell 3 — per-kind golden cases + long-detail divergences
// ============================================================

describe("emitLongDetail — per-kind goldens", () => {
	it("emits a plain text column matching the CCHQ canonical structure", () => {
		const mod = makeModule({
			caseType: "patient",
			caseListConfig: makeConfig({
				columns: [plainColumn("name", "Name")],
			}),
		});
		const out = emitLongDetail({ module: mod, moduleIndex: 0 });
		// Golden: full <detail> block. Locale id substring is
		// `case_long` per CCHQ's `id_strings.py::detail`.
		expect(out.xml).toBe(
			[
				`  <detail id="m0_case_long">`,
				`    <title>`,
				`      <text>`,
				`        <locale id="cchq.case"/>`,
				`      </text>`,
				`    </title>`,
				`    <field>`,
				`      <header>`,
				`        <text>`,
				`          <locale id="m0.case_long.case_name_1.header"/>`,
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
			"m0.case_long.case_name_1.header": "Name",
		});
	});

	it("emits a phone column with template form='phone' (long-detail divergence)", () => {
		// CCHQ's `detail_screen.py::Phone.template_form` returns
		// `'phone'` only when `detail.display == 'long'` — verified
		// at `commcare-hq/corehq/apps/app_manager/tests/data/suite/normal-suite.xml::<detail id="m0_case_long">`'s
		// phone field which carries `<template form="phone">`.
		// Short-detail phone columns emit a bare `<template>`; this
		// is the per-surface divergence the `detailKind`
		// discriminator routes.
		const mod = makeModule({
			caseType: "patient",
			caseListConfig: makeConfig({
				columns: [phoneColumn("phone", "Phone")],
			}),
		});
		const out = emitLongDetail({ module: mod, moduleIndex: 0 });
		expect(out.xml).toContain(`<template form="phone">`);
		expect(out.xml).toContain('<xpath function="phone"/>');
	});

	it("emits a date column wrapped in CCHQ's empty-string-guarded format-date shape", () => {
		const mod = makeModule({
			caseType: "patient",
			caseListConfig: makeConfig({
				columns: [dateColumn("opened_on", "Opened", "%d/%m/%Y")],
			}),
		});
		const out = emitLongDetail({ module: mod, moduleIndex: 0 });
		expect(out.xml).toContain(
			"if(opened_on = '', '', format-date(date(opened_on), '%d/%m/%Y'))",
		);
	});

	it("emits a time-since-until column with the days-equivalent divisor + threshold", () => {
		const mod = makeModule({
			caseType: "patient",
			caseListConfig: makeConfig({
				columns: [
					timeSinceUntilColumn(
						"last_visit",
						"Weeks since visit",
						4,
						"weeks",
						"Overdue",
					),
				],
			}),
		});
		const out = emitLongDetail({ module: mod, moduleIndex: 0 });
		// Divisor for weeks = 7; threshold in days = 4 * 7 = 28.
		expect(out.xml).toContain(
			"string(int((today() - date(last_visit)) div 7))",
		);
		expect(out.xml).toContain("today() - date(last_visit) &gt; 28");
		expect(out.xml).toContain("'Overdue'");
	});

	it("emits an id-mapping column with the selected() chain wrapped in replace(join())", () => {
		const mod = makeModule({
			caseType: "patient",
			caseListConfig: makeConfig({
				columns: [
					idMappingColumn("region_code", "Region", [
						idMappingEntry("N", "North"),
						idMappingEntry("S", "South"),
					]),
				],
			}),
		});
		const out = emitLongDetail({ module: mod, moduleIndex: 0 });
		expect(out.xml).toContain(
			"replace(join(' ', if(selected(region_code, 'N'), 'North', ''), if(selected(region_code, 'S'), 'South', '')), '\\s+', ' ')",
		);
	});

	it("emits a late-flag column with both absent-and-overdue branches", () => {
		const mod = makeModule({
			caseType: "patient",
			caseListConfig: makeConfig({
				columns: [lateFlagColumn("last_visit", "Overdue", 30, "days", "!")],
			}),
		});
		const out = emitLongDetail({ module: mod, moduleIndex: 0 });
		expect(out.xml).toContain(
			"if(last_visit = '', '!', if(today() - date(last_visit) &gt; 30, '!', ''))",
		);
	});

	it("emits a calc column with the inline-variable shape under case_long locale", () => {
		// CCHQ's `useXpathExpression` branch in
		// `detail_screen.py::FormattedDetailColumn.template` produces
		// the inline `<variable name="calculated_property">` shape.
		// The long-detail locale-id substring is `case_long` per
		// `id_strings.py::detail`; verified at
		// `commcare-hq/corehq/apps/app_manager/tests/data/suite/normal-suite.xml::<detail id="m0_case_long">`'s
		// calc fields (`m0.case_long.case_calculated_property_<N>.header`).
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
		const out = emitLongDetail({ module: mod, moduleIndex: 0 });
		expect(out.xml).toContain(
			'locale id="m0.case_long.case_calculated_property_1.header"',
		);
		expect(out.xml).toContain('<xpath function="$calculated_property">');
		expect(out.xml).toContain('<variable name="calculated_property">');
		expect(out.xml).toContain('<xpath function="phone"/>');
		expect(out.strings).toEqual({
			"m0.case_long.case_calculated_property_1.header": "My Calc",
		});
	});
});

describe("emitLongDetail — long-detail divergences from short", () => {
	it("emits no <sort> blocks even when ctx.sort carries a property key", () => {
		// CCHQ's `detail_screen.py::FormattedDetailColumn.sort_node`
		// short-circuits unless `self.detail.display == 'short'`
		// (modulo nodeset-column tabs not modelled in
		// `caseListConfig`). The canonical fixture
		// `commcare-hq/corehq/apps/app_manager/tests/data/suite/multi-sort.xml::<detail id="m0_case_long">`
		// has zero `<sort>` blocks despite the parent module's
		// short detail carrying a multi-key sort.
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
		const out = emitLongDetail({ module: mod, moduleIndex: 0 });
		expect(out.xml).not.toContain("<sort");
	});

	it("emits no <sort> blocks for calc columns even when keys target them", () => {
		// Same CCHQ rule applies to calc columns. Both module-level
		// `caseListConfig.sort` keys targeting a calc by id and
		// calc-local `CalculatedColumn.sort` slots are dropped on
		// long detail.
		const mod = makeModule({
			caseType: "patient",
			caseListConfig: makeConfig({
				calculatedColumns: [
					calculatedColumn(
						"my_calc",
						"My Calc",
						term(prop("patient", "phone")),
						{ type: "plain", direction: "asc" },
					),
				],
				sort: [sortKey(calculatedSortSource("my_calc"), "plain", "desc")],
			}),
		});
		const out = emitLongDetail({ module: mod, moduleIndex: 0 });
		expect(out.xml).not.toContain("<sort");
	});

	it("skips search-only columns entirely on long detail", () => {
		// `search-only` is a Nova authoring vocabulary kind defined
		// as a search/filter target with no display affordance. The
		// case-detail screen has no search/filter affordance, so no
		// `<field>` is emitted. Verified by absence of the property
		// reference in the wire output.
		const mod = makeModule({
			caseType: "patient",
			caseListConfig: makeConfig({
				columns: [
					plainColumn("name", "Name"),
					searchOnlyColumn("external_id", "External ID"),
				],
			}),
		});
		const out = emitLongDetail({ module: mod, moduleIndex: 0 });
		expect(out.xml).toContain('<xpath function="name"/>');
		expect(out.xml).not.toContain('<xpath function="external_id"/>');
		expect(out.xml).not.toContain('width="0"');
		// app_strings carries the visible field's header only.
		expect(out.strings).toEqual({
			"m0.case_long.case_name_1.header": "Name",
		});
	});

	it("advances the position counter for skipped search-only columns", () => {
		// CCHQ's `id_strings.py::detail_column_header_locale` keys
		// the position suffix off `column.id` (the source-array
		// index) rather than a render-time visible-column counter.
		// A search-only column at index 0 still consumes position 1;
		// the next visible column registers at position 2 even
		// though only one field renders.
		const mod = makeModule({
			caseType: "patient",
			caseListConfig: makeConfig({
				columns: [
					searchOnlyColumn("external_id", "External ID"),
					plainColumn("name", "Name"),
				],
			}),
		});
		const out = emitLongDetail({ module: mod, moduleIndex: 0 });
		// `name` is at source-array index 1, so its position
		// suffix is `_2`, NOT `_1`.
		expect(out.strings).toEqual({
			"m0.case_long.case_name_2.header": "Name",
		});
		// And the calc following these would land at position 3
		// (regularCount=2 + calcIndex=0 + 1).
	});

	it("continues the global position count past skipped search-only into calcs", () => {
		const mod = makeModule({
			caseType: "patient",
			caseListConfig: makeConfig({
				columns: [
					plainColumn("name", "Name"),
					searchOnlyColumn("external_id", "External ID"),
				],
				calculatedColumns: [
					calculatedColumn(
						"my_calc",
						"My Calc",
						term(prop("patient", "phone")),
					),
				],
			}),
		});
		const out = emitLongDetail({ module: mod, moduleIndex: 0 });
		// Source columns: 2 (one rendered, one skipped). Calc
		// position = regularCount(2) + calcIndex(0) + 1 = 3.
		expect(out.strings).toMatchObject({
			"m0.case_long.case_name_1.header": "Name",
			"m0.case_long.case_calculated_property_3.header": "My Calc",
		});
		// Search-only column at source index 1 does NOT register
		// any string under position 2.
		expect(out.strings).not.toHaveProperty(
			"m0.case_long.case_external_id_2.header",
		);
	});
});

// ============================================================
// Shell 4 — multi-kind integration
// ============================================================

describe("emitLongDetail — multi-kind integration", () => {
	it("emits a populated detail with every kind + a calc + module-level sort (suppressed)", () => {
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
		const out = emitLongDetail({ module: mod, moduleIndex: 0 });

		// Structural — long-detail block id + cchq.case title locale.
		expect(out.xml).toContain('<detail id="m0_case_long">');
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

		// Phone — template form='phone' on long detail.
		expect(out.xml).toContain(`<template form="phone">`);
		expect(out.xml).toContain('<xpath function="phone"/>');

		// ID-mapping — selected() chain wrapped in replace(join(...)).
		expect(out.xml).toContain(
			"replace(join(' ', if(selected(region, 'N'), 'North', ''), if(selected(region, 'S'), 'South', '')), '\\s+', ' ')",
		);

		// Late-flag — threshold 4 weeks = 28 days.
		expect(out.xml).toContain(
			"if(last_visit = '', '!', if(today() - date(last_visit) &gt; 28, '!', ''))",
		);

		// Search-only — NO field, NO width=0 placeholder.
		expect(out.xml).not.toContain('<xpath function="external_id"/>');
		expect(out.xml).not.toContain('width="0"');

		// Calculated column — inline-variable template shape.
		expect(out.xml).toContain('<xpath function="$calculated_property">');
		expect(out.xml).toContain('<variable name="calculated_property">');

		// No <sort> blocks despite a sort key targeting `name`.
		expect(out.xml).not.toContain("<sort");

		// Locale ids registered in app_strings — the visible
		// (non-search-only) columns + the calc, all under the
		// `case_long` substring. The calc's position continues
		// the global 1-based count: 7 source columns (one skipped
		// but counted) + 1 = position 8.
		expect(out.strings).toMatchObject({
			"m0.case_long.case_name_1.header": "Name",
			"m0.case_long.case_birthdate_2.header": "Birthdate",
			"m0.case_long.case_last_visit_3.header": "Weeks since visit",
			"m0.case_long.case_phone_4.header": "Phone",
			"m0.case_long.case_region_5.header": "Region",
			"m0.case_long.case_last_visit_6.header": "Late",
			"m0.case_long.case_calculated_property_8.header": "My Calc",
		});
		// Search-only columns do NOT register a header string.
		expect(out.strings).not.toHaveProperty(
			"m0.case_long.case_external_id_7.header",
		);
	});

	it("composes locale ids against the supplied moduleIndex", () => {
		const mod = makeModule({
			caseType: "patient",
			caseListConfig: makeConfig({
				columns: [plainColumn("name", "Name")],
			}),
		});
		const out = emitLongDetail({ module: mod, moduleIndex: 5 });
		expect(out.xml).toContain('<detail id="m5_case_long">');
		expect(out.xml).toContain('locale id="m5.case_long.case_name_1.header"');
		expect(out.strings).toEqual({
			"m5.case_long.case_name_1.header": "Name",
		});
	});
});
