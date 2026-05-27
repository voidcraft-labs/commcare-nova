// lib/commcare/suite/case-list/__tests__/shortDetail.test.ts
//
// Golden-file acceptance tests for `emitShortDetail` — the
// orchestrator that walks `module.caseListConfig.columns`, applies
// the `visibleInList` filter, and produces the suite-XML
// `<detail id="m{n}_case_short">` block. Each fixture pins the
// wire shape against canonical CCHQ-HQ source fixtures at
// `commcare-hq/corehq/apps/app_manager/tests/data/suite/`:
//
//   - `multi-sort.xml::<detail id="m0_case_short">` — multi-key
//     sort across three property columns (covers the order-attribute
//     composition rule).
//   - `normal-suite.xml::<detail id="m0_case_short">` — every CCHQ
//     format kind (covers the per-kind XPath shapes).
//
// Tests organize around four shells:
//
//   1. Empty / minimal — no caseListConfig OR no case type collapses
//      to a title-only `<detail>` block.
//   2. Single-kind goldens — pin the per-kind wire shape end-to-end.
//   3. Sort emission — multi-key sort with priority ordering and
//      tie-break to display order.
//   4. Visibility + multi-kind integration — `visibleInList` filter
//      + every kind + a calc + a sort directive.

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
import { emitShortDetail } from "../shortDetail";

// ============================================================
// Test helpers
// ============================================================

const MODULE_UUID = asUuid("00000000-0000-4000-8000-000000000001");
const COL = (n: number): import("@/lib/domain").Uuid =>
	asUuid(`00000000-0000-4000-8000-aaaa${String(n).padStart(8, "0")}`);

/**
 * Build a minimal `Module` for testing. `caseType` is threaded
 * through because every emit-active path requires it.
 */
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

/** Build a populated CaseListConfig with sensible defaults. */
function makeConfig(overrides: Partial<CaseListConfig> = {}): CaseListConfig {
	return {
		columns: [],
		searchInputs: [],
		...overrides,
	};
}

/**
 * Sparse case-type spec the per-test fixtures pass to `buildDoc`.
 * `properties[].label` is filled in by the helper so the tests stay
 * focused on the type derivation that matters for sort comparator
 * resolution.
 */
type SparseCaseType = {
	readonly name: string;
	readonly properties: ReadonlyArray<{
		readonly name: string;
		readonly data_type?: import("@/lib/domain").CasePropertyDataType;
	}>;
};

/**
 * Build a minimal `BlueprintDoc` carrying the module and an
 * optional sparse `caseTypes` annotation. The wire emitter reads
 * the doc to resolve property `data_type` for sort comparator
 * derivation; tests that don't exercise sort behavior pass an
 * empty case-types array (unresolved properties fall back to the
 * `"plain"` comparator).
 *
 * The helper auto-fills the required `CaseProperty.label` slot so
 * test fixtures stay focused on `data_type` — the slot the wire
 * emitter consults.
 */
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

describe("emitShortDetail — empty cases", () => {
	it("emits a title-only detail when caseListConfig is absent", () => {
		const mod = makeModule({ caseType: "patient" });
		const out = emitShortDetail({
			module: mod,
			moduleIndex: 0,
			doc: buildDoc({ module: mod }),
		});
		// CCHQ's `xml_models.py::Detail` model declares `title` as a
		// non-optional `NodeField`, so a zero-field detail still
		// carries the `<title>` element.
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
			caseListConfig: makeConfig({
				columns: [plainColumn(COL(1), "name", "Name")],
			}),
		});
		const out = emitShortDetail({
			module: mod,
			moduleIndex: 0,
			doc: buildDoc({ module: mod }),
		});
		expect(out.xml).toContain('<detail id="m0_case_short">');
		expect(out.xml).not.toContain("<field>");
	});

	it("emits a title-only detail when caseListConfig has empty columns", () => {
		const mod = makeModule({
			caseType: "patient",
			caseListConfig: makeConfig(),
		});
		const out = emitShortDetail({
			module: mod,
			moduleIndex: 0,
			doc: buildDoc({ module: mod }),
		});
		expect(out.xml).toContain('<detail id="m0_case_short">');
		expect(out.xml).not.toContain("<field>");
		expect(out.strings).toEqual({});
	});
});

// ============================================================
// Shell 2 — single-kind goldens
// ============================================================

describe("emitShortDetail — single-kind goldens", () => {
	it("emits a plain text column matching the CCHQ canonical structure", () => {
		const mod = makeModule({
			caseType: "patient",
			caseListConfig: makeConfig({
				columns: [plainColumn(COL(1), "name", "Name")],
			}),
		});
		const out = emitShortDetail({
			module: mod,
			moduleIndex: 0,
			doc: buildDoc({ module: mod }),
		});
		// Golden: full <detail> block. The serializer emits compact
		// output with no per-element whitespace — element order and
		// attribute insertion order are the load-bearing properties.
		expect(out.xml).toBe(
			`<detail id="m0_case_short">` +
				`<title><text><locale id="cchq.case"/></text></title>` +
				`<field>` +
				`<header><text><locale id="m0.case_short.case_name_1.header"/></text></header>` +
				`<template><text><xpath function="name"/></text></template>` +
				`</field>` +
				`</detail>`,
		);
		expect(out.strings).toEqual({
			"m0.case_short.case_name_1.header": "Name",
		});
	});

	it("registers headers under the CCHQ-canonical locale ids", () => {
		const mod = makeModule({
			caseType: "patient",
			caseListConfig: makeConfig({
				columns: [
					plainColumn(COL(1), "name", "Name"),
					phoneColumn(COL(2), "phone", "Phone"),
				],
			}),
		});
		const out = emitShortDetail({
			module: mod,
			moduleIndex: 2,
			doc: buildDoc({ module: mod }),
		});
		expect(out.strings).toEqual({
			"m2.case_short.case_name_1.header": "Name",
			"m2.case_short.case_phone_2.header": "Phone",
		});
	});

	it("renders calc columns inline at their source-array position", () => {
		const mod = makeModule({
			caseType: "patient",
			caseListConfig: makeConfig({
				columns: [
					plainColumn(COL(1), "name", "Name"),
					calculatedColumn(COL(2), "My Calc", term(prop("patient", "phone"))),
				],
			}),
		});
		const out = emitShortDetail({
			module: mod,
			moduleIndex: 0,
			doc: buildDoc({ module: mod }),
		});
		// Calc lives at source index 1 → position 2.
		expect(out.xml).toContain("case_name_1");
		expect(out.xml).toContain("case_calculated_property_2");
		// `$calculated_property` round-trips through the serializer as
		// the XML numeric character reference `&#x24;calculated_property`
		// — XML-spec-equivalent, decoded identically by every conforming
		// XML parser.
		expect(out.xml).toContain('<xpath function="&#x24;calculated_property">');
		expect(out.xml).toContain('<variable name="calculated_property">');
		expect(out.xml).toContain('<xpath function="phone"/>');
	});
});

// ============================================================
// Shell 3 — sort emission with priority + tie-break
// ============================================================

describe("emitShortDetail — sort emission", () => {
	it("emits sort blocks ordered by priority ascending", () => {
		// Three property columns. Priorities 2 / 0 / 1 → wire orders
		// 3 / 1 / 2 respectively (the `<sort>` block on the column
		// with priority 0 carries `order="1"`, etc).
		const colA = dateColumn(COL(1), "birthdate", "Birthdate", "%d/%m/%y", {
			sort: { direction: "desc", priority: 2 },
		});
		const colB = plainColumn(COL(2), "case_name", "Name", {
			sort: { direction: "asc", priority: 0 },
		});
		const colC = dateColumn(COL(3), "date_opened", "Opened", "%d/%m/%y", {
			sort: { direction: "desc", priority: 1 },
		});
		const mod = makeModule({
			caseType: "patient",
			caseListConfig: makeConfig({ columns: [colA, colB, colC] }),
		});
		const doc = buildDoc({
			module: mod,
			caseTypes: [
				{
					name: "patient",
					properties: [
						{ name: "birthdate", data_type: "date" },
						{ name: "case_name", data_type: "text" },
						{ name: "date_opened", data_type: "date" },
					],
				},
			],
		});
		const out = emitShortDetail({ module: mod, moduleIndex: 0, doc });

		// case_name (priority 0) → order=1, direction=asc, type=string
		// (text-typed → plain → wire string).
		expect(out.xml).toMatch(
			/<sort type="string" order="1" direction="ascending">[\s\S]*?<xpath function="case_name"\/>/,
		);
		// date_opened (priority 1) → order=2, direction=desc, type=string
		// (date-typed → date → wire string per CCHQ's collapse).
		expect(out.xml).toMatch(
			/<sort type="string" order="2" direction="descending">[\s\S]*?<xpath function="date_opened"\/>/,
		);
		// birthdate (priority 2) → order=3, direction=desc, type=string.
		expect(out.xml).toMatch(
			/<sort type="string" order="3" direction="descending">[\s\S]*?<xpath function="birthdate"\/>/,
		);
	});

	it("breaks priority ties to column display order — earlier display wins", () => {
		// All three columns at priority 0; wire orders 1 / 2 / 3 follow
		// source-array order.
		const colA = plainColumn(COL(1), "a", "A", {
			sort: { direction: "asc", priority: 0 },
		});
		const colB = plainColumn(COL(2), "b", "B", {
			sort: { direction: "asc", priority: 0 },
		});
		const colC = plainColumn(COL(3), "c", "C", {
			sort: { direction: "asc", priority: 0 },
		});
		const mod = makeModule({
			caseType: "patient",
			caseListConfig: makeConfig({ columns: [colA, colB, colC] }),
		});
		const doc = buildDoc({
			module: mod,
			caseTypes: [
				{
					name: "patient",
					properties: [
						{ name: "a", data_type: "text" },
						{ name: "b", data_type: "text" },
						{ name: "c", data_type: "text" },
					],
				},
			],
		});
		const out = emitShortDetail({ module: mod, moduleIndex: 0, doc });
		expect(out.xml).toMatch(
			/<sort type="string" order="1" direction="ascending">[\s\S]*?<xpath function="a"\/>/,
		);
		expect(out.xml).toMatch(
			/<sort type="string" order="2" direction="ascending">[\s\S]*?<xpath function="b"\/>/,
		);
		expect(out.xml).toMatch(
			/<sort type="string" order="3" direction="ascending">[\s\S]*?<xpath function="c"\/>/,
		);
	});

	it("emits no sort blocks when no column carries sort", () => {
		const mod = makeModule({
			caseType: "patient",
			caseListConfig: makeConfig({
				columns: [plainColumn(COL(1), "name", "Name")],
			}),
		});
		const out = emitShortDetail({
			module: mod,
			moduleIndex: 0,
			doc: buildDoc({ module: mod }),
		});
		expect(out.xml).not.toContain("<sort");
	});

	it("threads a calc-column sort directive into the inline-variable shape", () => {
		const calc = calculatedColumn(
			COL(1),
			"My Calc",
			term(prop("patient", "phone")),
			{ sort: { direction: "desc", priority: 0 } },
		);
		const mod = makeModule({
			caseType: "patient",
			caseListConfig: makeConfig({ columns: [calc] }),
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
		const out = emitShortDetail({ module: mod, moduleIndex: 0, doc });
		// The sort block uses the inline-variable shape — the calc's
		// xpath rides inside `$calculated_property` (round-tripped
		// through the serializer as `&#x24;calculated_property`).
		expect(out.xml).toMatch(
			/<sort type="string" order="1" direction="descending">[\s\S]*?<xpath function="&#x24;calculated_property">[\s\S]*?<variable name="calculated_property">[\s\S]*?<xpath function="phone"\/>/,
		);
	});
});

// ============================================================
// Shell 4 — visibility + multi-kind integration
// ============================================================

describe("emitShortDetail — visibility filter", () => {
	it("hides columns with visibleInList: false from the field list", () => {
		const visible = plainColumn(COL(1), "name", "Name");
		const hidden = plainColumn(COL(2), "external_id", "External ID", {
			visibleInList: false,
		});
		const mod = makeModule({
			caseType: "patient",
			caseListConfig: makeConfig({ columns: [visible, hidden] }),
		});
		const out = emitShortDetail({
			module: mod,
			moduleIndex: 0,
			doc: buildDoc({ module: mod }),
		});
		expect(out.xml).toContain('<xpath function="name"/>');
		expect(out.xml).not.toContain('<xpath function="external_id"/>');
		// Visible field's locale id stays at its source-array
		// position (1) — visibility filter doesn't churn locale ids.
		expect(out.strings).toEqual({
			"m0.case_short.case_name_1.header": "Name",
		});
	});

	it("renders columns with visibleInList: true (or absent) — absent ≡ visible", () => {
		const explicit = plainColumn(COL(1), "name", "Name", {
			visibleInList: true,
		});
		const implicit = plainColumn(COL(2), "phone", "Phone");
		const mod = makeModule({
			caseType: "patient",
			caseListConfig: makeConfig({ columns: [explicit, implicit] }),
		});
		const out = emitShortDetail({
			module: mod,
			moduleIndex: 0,
			doc: buildDoc({ module: mod }),
		});
		expect(out.xml).toContain('<xpath function="name"/>');
		expect(out.xml).toContain('<xpath function="phone"/>');
	});

	it("keeps hidden columns at their source-array position so subsequent locale ids don't shift", () => {
		// `external_id` at source index 0 carries `visibleInList: false`
		// — its locale id slot (`_1`) stays unused. `name` at source
		// index 1 lands at `_2`.
		const hidden = plainColumn(COL(1), "external_id", "External ID", {
			visibleInList: false,
		});
		const visible = plainColumn(COL(2), "name", "Name");
		const mod = makeModule({
			caseType: "patient",
			caseListConfig: makeConfig({ columns: [hidden, visible] }),
		});
		const out = emitShortDetail({
			module: mod,
			moduleIndex: 0,
			doc: buildDoc({ module: mod }),
		});
		expect(out.strings).toEqual({
			"m0.case_short.case_name_2.header": "Name",
		});
		expect(out.strings).not.toHaveProperty(
			"m0.case_short.case_external_id_1.header",
		);
	});
});

describe("emitShortDetail — multi-kind integration", () => {
	it("emits a populated detail with every kind + a calc + a sort directive", () => {
		const columns: Column[] = [
			plainColumn(COL(1), "name", "Name", {
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
			calculatedColumn(COL(7), "My Calc", term(prop("patient", "name"))),
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
						{ name: "name", data_type: "text" },
						{ name: "birthdate", data_type: "date" },
						{ name: "last_visit", data_type: "date" },
						{ name: "phone", data_type: "text" },
						{ name: "region", data_type: "single_select" },
					],
				},
			],
		});
		const out = emitShortDetail({ module: mod, moduleIndex: 0, doc });

		// Structural assertions — pin the per-kind wire shape lives
		// once in the per-kind tests; this test surfaces the
		// integration check.
		expect(out.xml).toContain('<detail id="m0_case_short">');
		expect(out.xml).toContain('<locale id="cchq.case"/>');

		// Plain field.
		expect(out.xml).toContain('<xpath function="name"/>');
		// Date field. XPath single-quote literals round-trip as
		// `&apos;` inside the double-quoted attribute value.
		expect(out.xml).toContain(
			"if(birthdate = &apos;&apos;, &apos;&apos;, format-date(date(birthdate), &apos;%d/%m/%y&apos;))",
		);
		// Interval-always — divisor 7, threshold 14, label.
		expect(out.xml).toContain("(today() - date(last_visit)) div 7");
		expect(out.xml).toContain("today() - date(last_visit) &gt; 14");
		expect(out.xml).toContain("&apos;Overdue&apos;");
		// Phone — same XPath as plain on short detail.
		expect(out.xml).toContain('<xpath function="phone"/>');
		// ID-mapping — selected() chain wrapped in replace(join(...)).
		expect(out.xml).toContain(
			"replace(join(&apos; &apos;, if(selected(region, &apos;N&apos;), &apos;North&apos;, &apos;&apos;), if(selected(region, &apos;S&apos;), &apos;South&apos;, &apos;&apos;)), &apos;\\s+&apos;, &apos; &apos;)",
		);
		// Interval-flag — threshold 4 weeks = 28 days.
		expect(out.xml).toContain(
			"if(last_visit = &apos;&apos;, &apos;!&apos;, if(today() - date(last_visit) &gt; 28, &apos;!&apos;, &apos;&apos;))",
		);
		// Calculated column — inline-variable template shape.
		// `$calculated_property` → `&#x24;calculated_property` (XML
		// numeric reference, decoded identically).
		expect(out.xml).toContain('<xpath function="&#x24;calculated_property">');
		expect(out.xml).toContain('<variable name="calculated_property">');

		// Sort attached to the name column at order=1.
		expect(out.xml).toMatch(
			/<sort type="string" order="1" direction="ascending">[\s\S]*?<xpath function="name"\/>/,
		);

		// Locale ids registered in app_strings — every column
		// renders so the source-array position 1..7 maps directly to
		// locale-id suffixes.
		expect(out.strings).toEqual({
			"m0.case_short.case_name_1.header": "Name",
			"m0.case_short.case_birthdate_2.header": "Birthdate",
			"m0.case_short.case_last_visit_3.header": "Weeks since visit",
			"m0.case_short.case_phone_4.header": "Phone",
			"m0.case_short.case_region_5.header": "Region",
			"m0.case_short.case_last_visit_6.header": "Late",
			"m0.case_short.case_calculated_property_7.header": "My Calc",
		});
	});

	it("composes locale ids against the supplied moduleIndex", () => {
		const mod = makeModule({
			caseType: "patient",
			caseListConfig: makeConfig({
				columns: [plainColumn(COL(1), "name", "Name")],
			}),
		});
		const out = emitShortDetail({
			module: mod,
			moduleIndex: 5,
			doc: buildDoc({ module: mod }),
		});
		expect(out.xml).toContain('<detail id="m5_case_short">');
		expect(out.xml).toContain('locale id="m5.case_short.case_name_1.header"');
		expect(out.strings).toEqual({
			"m5.case_short.case_name_1.header": "Name",
		});
	});
});

// ============================================================
// Search-action emission
// ============================================================
//
// When the surrounding compiler emits a `<remote-request>` for a
// module, it threads a `searchAction` arg into the case-target
// short-detail emitter. The emitter renders an `<action>` element
// after the `<field>` block carrying the search affordance per
// CCHQ's
// `commcare-hq/corehq/apps/app_manager/tests/data/suite/search_command_detail.xml::detail[@id='m0_case_short']/action`
// and `case-search-with-action.xml`. The action mounts only on the
// case target — search-target details never carry an action child.

describe("emitShortDetail — search-action emission", () => {
	const moduleWithName = (caseType: string): Module =>
		makeModule({
			caseType,
			caseListConfig: {
				columns: [plainColumn(COL(1), "name", "Name")],
				searchInputs: [],
			},
		});

	it("emits no <action> element when searchAction is undefined", () => {
		const mod = moduleWithName("patient");
		const out = emitShortDetail({
			module: mod,
			moduleIndex: 0,
			doc: buildDoc({ module: mod }),
		});
		expect(out.xml).not.toContain("<action ");
	});

	it("emits <action auto_launch='false()'> when searchAction.autoLaunch is false", () => {
		const mod = moduleWithName("patient");
		const out = emitShortDetail({
			module: mod,
			moduleIndex: 0,
			doc: buildDoc({ module: mod }),
			searchAction: { autoLaunch: false },
		});
		expect(out.xml).toContain(
			`<action auto_launch="false()" redo_last="false">`,
		);
		// XPath single-quote literals (`'search_command.m0'`) round-trip
		// as `&apos;` inside double-quoted attribute values.
		expect(out.xml).toContain(
			`<command value="&apos;search_command.m0&apos;"/>`,
		);
	});

	it("emits the canonical AUTO_LAUNCH_EXPRESSIONS['single-select'] expression when searchAction.autoLaunch is true", () => {
		// CCHQ's
		// `commcare-hq/corehq/apps/app_manager/suite_xml/sections/details.py::AUTO_LAUNCH_EXPRESSIONS["single-select"]`:
		// `$next_input = '' or count(instance('casedb')/casedb/case[@case_id=$next_input]) = 0`.
		// Lifted verbatim into the wire form.
		const mod = moduleWithName("patient");
		const out = emitShortDetail({
			module: mod,
			moduleIndex: 0,
			doc: buildDoc({ module: mod }),
			searchAction: { autoLaunch: true },
		});
		// `$next_input` round-trips as the XML numeric reference
		// `&#x24;next_input`; XPath single-quote literals round-trip as
		// `&apos;`. Both XML-spec-equivalent encodings decode identically
		// in CCHQ's runtime.
		expect(out.xml).toContain(
			`auto_launch="&#x24;next_input = &apos;&apos; or count(instance(&apos;casedb&apos;)/casedb/case[@case_id=&#x24;next_input]) = 0"`,
		);
	});

	it("emits the action only on the case target — search-target details carry no <action>", () => {
		const mod = moduleWithName("patient");
		const searchOut = emitShortDetail({
			module: mod,
			moduleIndex: 0,
			doc: buildDoc({ module: mod }),
			target: "search",
			searchAction: { autoLaunch: true },
		});
		expect(searchOut.xml).not.toContain("<action ");
	});

	it("renders the relevant attribute when searchAction.displayCondition is supplied", () => {
		// CCHQ's
		// `commcare-hq/corehq/apps/app_manager/suite_xml/sections/details.py::DetailContributor._get_relevant_expression`
		// sources the `<action relevant>` attribute from
		// `module.search_config.search_button_display_condition`.
		// The on-device XPath emitter compiles the predicate; the
		// attribute carries the escaped result.
		const mod = moduleWithName("patient");
		const out = emitShortDetail({
			module: mod,
			moduleIndex: 0,
			doc: buildDoc({
				module: mod,
				caseTypes: [{ name: "patient", properties: [{ name: "active" }] }],
			}),
			searchAction: {
				autoLaunch: false,
				displayCondition: {
					kind: "eq",
					left: { kind: "term", term: prop("patient", "active") },
					right: {
						kind: "term",
						term: { kind: "literal", value: "yes" },
					},
				},
			},
		});
		// The on-device emitter produces `active = 'yes'`; the
		// serializer round-trips XPath single-quote literals as
		// `&apos;` inside the double-quoted `relevant` attribute.
		expect(out.xml).toContain(`relevant="active = &apos;yes&apos;"`);
	});

	it("omits the relevant attribute when searchAction.displayCondition is absent", () => {
		const mod = moduleWithName("patient");
		const out = emitShortDetail({
			module: mod,
			moduleIndex: 0,
			doc: buildDoc({ module: mod }),
			searchAction: { autoLaunch: false },
		});
		expect(out.xml).toContain(
			`<action auto_launch="false()" redo_last="false">`,
		);
		expect(out.xml).not.toContain(` relevant=`);
	});
});
