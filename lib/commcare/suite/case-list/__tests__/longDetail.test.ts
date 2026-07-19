// lib/commcare/suite/case-list/__tests__/longDetail.test.ts
//
// Golden-file acceptance tests for `emitLongDetail` — the
// orchestrator that walks `module.caseListConfig.columns`, applies
// the `visibleInDetail` filter, and produces the suite-XML
// `<detail id="m{n}_case_long">` block. Each fixture pins the wire
// shape against canonical CCHQ-HQ source fixtures at
// `commcare-hq/corehq/apps/app_manager/tests/data/suite/`:
//
//   - `normal-suite.xml::<detail id="m0_case_long">` — covers
//     `<template form="phone">` on long-detail phone columns,
//     `case_long` locale-id substring, and calc-property numbering
//     across regular columns.
//   - `multi-sort.xml::<detail id="m0_case_long">` — confirms zero
//     `<sort>` blocks on long detail despite a multi-key sort
//     active on the parent module's short detail.
//
// Tests organize around three shells:
//
//   1. Empty / minimal — no caseListConfig OR no case type collapses
//      to a title-only `<detail>` block.
//   2. Long-detail divergences from short — no `<sort>` blocks,
//      `<template form="phone">`, position counter advances for
//      hidden columns.
//   3. Visibility + multi-kind integration.

import { describe, expect, it } from "vitest";
import {
	asUuid,
	type BlueprintDoc,
	type CaseListConfig,
	type CaseType,
	type Column,
	calculatedColumn,
	dateColumn,
	idMappingColumn,
	idMappingEntry,
	intervalColumn,
	type Module,
	phoneColumn,
	plainColumn,
} from "@/lib/domain";
import { prop, term } from "@/lib/domain/predicate";
import { emitLongDetail } from "../longDetail";

// ============================================================
// Test helpers
// ============================================================

const MODULE_UUID = asUuid("00000000-0000-4000-8000-000000000001");
const COL = (n: number): import("@/lib/domain").Uuid =>
	asUuid(`00000000-0000-4000-8000-bbbb${String(n).padStart(8, "0")}`);

function makeModule(args: {
	readonly caseType?: string;
	readonly caseListConfig?: CaseListConfig;
}): Module {
	return {
		uuid: MODULE_UUID,
		id: "test_module",
		name: "Test Module",
		...(args.caseType !== undefined && { caseType: args.caseType }),
		...(args.caseListConfig !== undefined && {
			caseListConfig: args.caseListConfig,
		}),
	};
}

function makeConfig(overrides: Partial<CaseListConfig> = {}): CaseListConfig {
	return {
		columns: [],
		searchInputs: [],
		...overrides,
	};
}

/**
 * Sparse case-type spec the per-test fixtures pass to `buildDoc`.
 * Mirrors the shortDetail helper; `properties[].label` is filled
 * in by the helper so the tests stay focused on `data_type` (the
 * slot the wire emitter consults for sort-comparator derivation).
 */
type SparseCaseType = {
	readonly name: string;
	readonly properties: ReadonlyArray<{
		readonly name: string;
		readonly data_type?: import("@/lib/domain").CasePropertyDataType;
	}>;
};

function buildDoc(args: {
	readonly module: Module;
	readonly caseTypes?: readonly SparseCaseType[];
}): BlueprintDoc {
	const caseTypes: CaseType[] = (args.caseTypes ?? []).map((ct) => ({
		name: ct.name,
		properties: ct.properties.map((p) => ({
			name: p.name,
			label: p.name,
			...(p.data_type !== undefined && { data_type: p.data_type }),
		})),
	}));
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
		caseTypes,
	};
}

// ============================================================
// Shell 1 — empty / minimal
// ============================================================

describe("emitLongDetail — empty cases", () => {
	it("emits a title-only detail when caseListConfig is absent", () => {
		const mod = makeModule({ caseType: "patient" });
		const out = emitLongDetail({
			module: mod,
			moduleIndex: 0,
			doc: buildDoc({ module: mod }),
		});
		expect(out.xml).toContain('<detail id="m0_case_long">');
		expect(out.xml).toContain('<locale id="cchq.case"/>');
		expect(out.xml).not.toContain("<field>");
		expect(out.strings).toEqual({});
	});

	it("emits a title-only detail when the module has no case type", () => {
		const mod = makeModule({
			caseListConfig: makeConfig({
				columns: [plainColumn(COL(1), "full_name", "Name")],
			}),
		});
		const out = emitLongDetail({
			module: mod,
			moduleIndex: 0,
			doc: buildDoc({ module: mod }),
		});
		expect(out.xml).toContain('<detail id="m0_case_long">');
		expect(out.xml).not.toContain("<field>");
	});

	it("emits a title-only detail when caseListConfig has empty columns", () => {
		const mod = makeModule({
			caseType: "patient",
			caseListConfig: makeConfig(),
		});
		const out = emitLongDetail({
			module: mod,
			moduleIndex: 0,
			doc: buildDoc({ module: mod }),
		});
		expect(out.xml).toContain('<detail id="m0_case_long">');
		expect(out.xml).not.toContain("<field>");
		expect(out.strings).toEqual({});
	});
});

// ============================================================
// Shell 2 — long-detail divergences from short
// ============================================================

describe("emitLongDetail — per-kind goldens", () => {
	it("emits a plain text column matching the CCHQ canonical structure", () => {
		const mod = makeModule({
			caseType: "patient",
			caseListConfig: makeConfig({
				columns: [plainColumn(COL(1), "full_name", "Name")],
			}),
		});
		const out = emitLongDetail({
			module: mod,
			moduleIndex: 0,
			doc: buildDoc({ module: mod }),
		});
		// Golden: full <detail> block. Locale id substring is
		// `case_long` per CCHQ's `id_strings.py::detail`. The serializer
		// emits compact output with no per-element whitespace.
		expect(out.xml).toBe(
			`<detail id="m0_case_long">` +
				`<title><text><locale id="cchq.case"/></text></title>` +
				`<field>` +
				`<header><text><locale id="m0.case_long.case_full_name_1.header"/></text></header>` +
				`<template><text><xpath function="full_name"/></text></template>` +
				`</field>` +
				`</detail>`,
		);
		expect(out.strings).toEqual({
			"m0.case_long.case_full_name_1.header": "Name",
		});
	});

	it("emits a phone column with template form='phone' (long-detail divergence)", () => {
		// CCHQ's `detail_screen.py::Phone.template_form` returns
		// `'phone'` only when `detail.display == 'long'` — verified
		// at `commcare-hq/corehq/apps/app_manager/tests/data/suite/normal-suite.xml::<detail id="m0_case_long">`'s
		// phone field which carries `<template form="phone">`.
		const mod = makeModule({
			caseType: "patient",
			caseListConfig: makeConfig({
				columns: [phoneColumn(COL(1), "phone", "Phone")],
			}),
		});
		const out = emitLongDetail({
			module: mod,
			moduleIndex: 0,
			doc: buildDoc({ module: mod }),
		});
		expect(out.xml).toContain(`<template form="phone">`);
		expect(out.xml).toContain('<xpath function="phone"/>');
	});

	it("emits a calc column with the inline-variable shape under case_long locale", () => {
		// CCHQ's `useXpathExpression` branch in
		// `detail_screen.py::FormattedDetailColumn.template` produces
		// the inline `<variable name="calculated_property">` shape.
		// The long-detail locale-id substring is `case_long` per
		// `id_strings.py::detail`.
		const mod = makeModule({
			caseType: "patient",
			caseListConfig: makeConfig({
				columns: [
					calculatedColumn(COL(1), "My Calc", term(prop("patient", "phone"))),
				],
			}),
		});
		const out = emitLongDetail({
			module: mod,
			moduleIndex: 0,
			doc: buildDoc({ module: mod }),
		});
		expect(out.xml).toContain(
			'locale id="m0.case_long.case_calculated_property_1.header"',
		);
		// `$calculated_property` serializes verbatim — `$` is not a special
		// XML character, matching CCHQ's own bare-`$` suite.xml.
		expect(out.xml).toContain('<xpath function="$calculated_property">');
		expect(out.xml).toContain('<variable name="calculated_property">');
		expect(out.xml).toContain('<xpath function="phone"/>');
		expect(out.strings).toEqual({
			"m0.case_long.case_calculated_property_1.header": "My Calc",
		});
	});
});

describe("emitLongDetail — long-detail divergences from short", () => {
	it("emits no <sort> blocks even when columns carry sort directives", () => {
		// CCHQ's `detail_screen.py::FormattedDetailColumn.sort_node`
		// short-circuits unless `self.detail.display == 'short'`
		// (modulo nodeset-column tabs not modelled in
		// `caseListConfig`). The canonical fixture
		// `commcare-hq/corehq/apps/app_manager/tests/data/suite/multi-sort.xml::<detail id="m0_case_long">`
		// has zero `<sort>` blocks despite the parent module's short
		// detail carrying a multi-key sort.
		const mod = makeModule({
			caseType: "patient",
			caseListConfig: makeConfig({
				columns: [
					dateColumn(COL(1), "birthdate", "Birthdate", "%d/%m/%y", {
						sort: { direction: "desc", priority: 0 },
					}),
					plainColumn(COL(2), "case_name", "Name", {
						sort: { direction: "asc", priority: 1 },
					}),
				],
			}),
		});
		const doc = buildDoc({
			module: mod,
			caseTypes: [
				{
					name: "patient",
					properties: [
						{ name: "birthdate", data_type: "date" },
						{ name: "case_name", data_type: "text" },
					],
				},
			],
		});
		const out = emitLongDetail({ module: mod, moduleIndex: 0, doc });
		expect(out.xml).not.toContain("<sort");
	});

	it("emits no <sort> blocks for calc columns even when sort directives target them", () => {
		const mod = makeModule({
			caseType: "patient",
			caseListConfig: makeConfig({
				columns: [
					calculatedColumn(COL(1), "My Calc", term(prop("patient", "phone")), {
						sort: { direction: "asc", priority: 0 },
					}),
				],
			}),
		});
		const doc = buildDoc({
			module: mod,
			caseTypes: [
				{
					name: "patient",
					properties: [{ name: "phone", data_type: "text" }],
				},
			],
		});
		const out = emitLongDetail({ module: mod, moduleIndex: 0, doc });
		expect(out.xml).not.toContain("<sort");
	});
});

// ============================================================
// Shell 3 — visibility + multi-kind integration
// ============================================================

describe("emitLongDetail — visibility filter", () => {
	it("hides columns with visibleInDetail: false from the field list", () => {
		const visible = plainColumn(COL(1), "full_name", "Name");
		const hidden = plainColumn(COL(2), "external_id", "External ID", {
			visibleInDetail: false,
		});
		const mod = makeModule({
			caseType: "patient",
			caseListConfig: makeConfig({ columns: [visible, hidden] }),
		});
		const out = emitLongDetail({
			module: mod,
			moduleIndex: 0,
			doc: buildDoc({ module: mod }),
		});
		expect(out.xml).toContain('<xpath function="full_name"/>');
		expect(out.xml).not.toContain('<xpath function="external_id"/>');
		expect(out.strings).toEqual({
			"m0.case_long.case_full_name_1.header": "Name",
		});
	});

	it("renders columns with visibleInDetail: true (or absent) — absent ≡ visible", () => {
		const explicit = plainColumn(COL(1), "full_name", "Name", {
			visibleInDetail: true,
		});
		const implicit = plainColumn(COL(2), "phone", "Phone");
		const mod = makeModule({
			caseType: "patient",
			caseListConfig: makeConfig({ columns: [explicit, implicit] }),
		});
		const out = emitLongDetail({
			module: mod,
			moduleIndex: 0,
			doc: buildDoc({ module: mod }),
		});
		expect(out.xml).toContain('<xpath function="full_name"/>');
		expect(out.xml).toContain('<xpath function="phone"/>');
	});

	it("keeps hidden columns at their source-array position so subsequent locale ids don't shift", () => {
		// `external_id` at source index 0 carries `visibleInDetail: false`
		// — its locale-id slot stays unused. `full_name` at source index
		// 1 lands at `_2`, NOT `_1`.
		const hidden = plainColumn(COL(1), "external_id", "External ID", {
			visibleInDetail: false,
		});
		const visible = plainColumn(COL(2), "full_name", "Name");
		const mod = makeModule({
			caseType: "patient",
			caseListConfig: makeConfig({ columns: [hidden, visible] }),
		});
		const out = emitLongDetail({
			module: mod,
			moduleIndex: 0,
			doc: buildDoc({ module: mod }),
		});
		expect(out.strings).toEqual({
			"m0.case_long.case_full_name_2.header": "Name",
		});
		expect(out.strings).not.toHaveProperty(
			"m0.case_long.case_external_id_1.header",
		);
	});

	it("filters by visibleInDetail independently of visibleInList", () => {
		// `full_name` is visible-in-list but hidden from detail; `phone`
		// is hidden from list but visible in detail. Long detail
		// renders only `phone`.
		const listOnly = plainColumn(COL(1), "full_name", "Name", {
			visibleInDetail: false,
		});
		const detailOnly = plainColumn(COL(2), "phone", "Phone", {
			visibleInList: false,
		});
		const mod = makeModule({
			caseType: "patient",
			caseListConfig: makeConfig({ columns: [listOnly, detailOnly] }),
		});
		const out = emitLongDetail({
			module: mod,
			moduleIndex: 0,
			doc: buildDoc({ module: mod }),
		});
		expect(out.xml).toContain('<xpath function="phone"/>');
		expect(out.xml).not.toContain('<xpath function="full_name"/>');
	});
});

describe("emitLongDetail — multi-kind integration", () => {
	it("emits a populated detail with every kind + a calc + a sort directive (suppressed)", () => {
		const columns: Column[] = [
			plainColumn(COL(1), "full_name", "Name", {
				sort: { direction: "asc", priority: 0 },
			}),
			dateColumn(COL(2), "birthdate", "Birthdate", "%d/%m/%y"),
			intervalColumn(
				COL(3),
				"last_visit",
				"Weeks since visit",
				2,
				"weeks",
				"always",
				"Overdue",
			),
			phoneColumn(COL(4), "phone", "Phone"),
			idMappingColumn(COL(5), "region", "Region", [
				idMappingEntry("N", "North"),
				idMappingEntry("S", "South"),
			]),
			intervalColumn(COL(6), "last_visit", "Late", 4, "weeks", "flag", "!"),
			calculatedColumn(COL(7), "My Calc", term(prop("patient", "full_name"))),
		];
		const mod = makeModule({
			caseType: "patient",
			caseListConfig: makeConfig({ columns }),
		});
		const doc = buildDoc({
			module: mod,
			caseTypes: [
				{
					name: "patient",
					properties: [
						{ name: "full_name", data_type: "text" },
						{ name: "birthdate", data_type: "date" },
						{ name: "last_visit", data_type: "date" },
						{ name: "phone", data_type: "text" },
						{ name: "region", data_type: "single_select" },
					],
				},
			],
		});
		const out = emitLongDetail({ module: mod, moduleIndex: 0, doc });

		// Structural — long-detail block id + cchq.case title locale.
		expect(out.xml).toContain('<detail id="m0_case_long">');
		expect(out.xml).toContain('<locale id="cchq.case"/>');

		// Plain field.
		expect(out.xml).toContain('<xpath function="full_name"/>');
		// Date field. XPath single-quote literals round-trip as
		// `&apos;` inside the double-quoted attribute value.
		expect(out.xml).toContain(
			"if(birthdate = &apos;&apos;, &apos;&apos;, format-date(date(birthdate), &apos;%d/%m/%y&apos;))",
		);
		// Interval-always.
		expect(out.xml).toContain("(today() - date(last_visit)) div 7");
		expect(out.xml).toContain("today() - date(last_visit) &gt; 14");
		expect(out.xml).toContain("&apos;Overdue&apos;");
		// Phone — template form='phone' on long detail.
		expect(out.xml).toContain(`<template form="phone">`);
		expect(out.xml).toContain('<xpath function="phone"/>');
		// ID-mapping.
		expect(out.xml).toContain(
			"replace(join(&apos; &apos;, if(selected(region, &apos;N&apos;), &apos;North&apos;, &apos;&apos;), if(selected(region, &apos;S&apos;), &apos;South&apos;, &apos;&apos;)), &apos;\\s+&apos;, &apos; &apos;)",
		);
		// Interval-flag — threshold 4 weeks = 28 days.
		expect(out.xml).toContain(
			"if(last_visit = &apos;&apos;, &apos;!&apos;, if(today() - date(last_visit) &gt; 28, &apos;!&apos;, &apos;&apos;))",
		);
		// Calculated column — inline-variable template shape.
		// `$calculated_property` serializes verbatim (bare `$`).
		expect(out.xml).toContain('<xpath function="$calculated_property">');
		expect(out.xml).toContain('<variable name="calculated_property">');

		// No <sort> blocks — long detail suppresses them per CCHQ's
		// `detail_screen.py::FormattedDetailColumn.sort_node` rule.
		expect(out.xml).not.toContain("<sort");

		// Locale ids registered in app_strings — every column renders
		// (none filtered by `visibleInDetail`) so source-array
		// positions 1..7 map directly to locale-id suffixes.
		expect(out.strings).toEqual({
			"m0.case_long.case_full_name_1.header": "Name",
			"m0.case_long.case_birthdate_2.header": "Birthdate",
			"m0.case_long.case_last_visit_3.header": "Weeks since visit",
			"m0.case_long.case_phone_4.header": "Phone",
			"m0.case_long.case_region_5.header": "Region",
			"m0.case_long.case_last_visit_6.header": "Late",
			"m0.case_long.case_calculated_property_7.header": "My Calc",
		});
	});

	it("composes locale ids against the supplied moduleIndex", () => {
		const mod = makeModule({
			caseType: "patient",
			caseListConfig: makeConfig({
				columns: [plainColumn(COL(1), "full_name", "Name")],
			}),
		});
		const out = emitLongDetail({
			module: mod,
			moduleIndex: 5,
			doc: buildDoc({ module: mod }),
		});
		expect(out.xml).toContain('<detail id="m5_case_long">');
		expect(out.xml).toContain(
			'locale id="m5.case_long.case_full_name_1.header"',
		);
		expect(out.strings).toEqual({
			"m5.case_long.case_full_name_1.header": "Name",
		});
	});
});
