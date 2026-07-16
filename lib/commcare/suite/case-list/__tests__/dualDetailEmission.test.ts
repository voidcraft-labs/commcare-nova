// lib/commcare/suite/case-list/__tests__/dualDetailEmission.test.ts
//
// Acceptance tests for the dual-detail emission shape: when a
// module has `caseSearchConfig`, the same `caseListConfig` projects
// onto two pairs of wire ids — `m{N}_case_short` /
// `m{N}_case_long` (the local case list) and `m{N}_search_short` /
// `m{N}_search_long` (the search results). The two pairs share the
// rendered `<field>` content; only three load-bearing slots differ:
// the `<detail id>` attribute, the column header locale ids, and
// the calc-xpath instance reference for cross-case lookups.
//
// Verified against the canonical CCHQ fixture
// `commcare-hq/corehq/apps/app_manager/tests/data/suite/search_command_detail.xml`.
// The fixture's `<partial>` contains both `m0_case_short` (with
// sort) and `m0_search_short` (with same sort, instance-rewritten
// where applicable). The structural pin tests below mirror that
// canonical shape.
//
// Tests organize around four shells:
//
//   1. Module without `caseSearchConfig` — emits ONLY the case
//      pair. Search-target wire ids never appear.
//   2. Module with `caseSearchConfig` + columns + sort — emits all
//      four blocks. Sort blocks ride on `m{N}_search_short`
//      identically to `m{N}_case_short`; long blocks carry no sort.
//   3. Field content identity between case-short and search-short,
//      and between case-long and search-long, after applying the
//      respective visibility filter. Column ordering preserved.
//   4. Localization-key prefix swap and calc-xpath instance
//      rewrite — `case_short.*` ↔ `search_short.*`,
//      `instance('casedb')/casedb/case[...]` ↔
//      `instance('results')/results/case[...]` on calc fields.

import AdmZip from "adm-zip";
import { describe, expect, it } from "vitest";
import { compileCcz } from "@/lib/commcare/compiler";
import { expandDoc } from "@/lib/commcare/expander";
import {
	asUuid,
	type BlueprintDoc,
	type CaseListConfig,
	type CaseSearchConfig,
	type CaseType,
	calculatedColumn,
	dateColumn,
	type Module,
	plainColumn,
} from "@/lib/domain";
import { ancestorPath, prop, relationStep, term } from "@/lib/domain/predicate";
import { emitLongDetail } from "../longDetail";
import { emitShortDetail } from "../shortDetail";

// ============================================================
// Test helpers
// ============================================================

const MODULE_UUID = asUuid("00000000-0000-4000-8000-000000000010");
const COL = (n: number): import("@/lib/domain").Uuid =>
	asUuid(`00000000-0000-4000-8000-cccc${String(n).padStart(8, "0")}`);

/**
 * Build a minimal `Module` for testing. Both optional configs are
 * threaded through individually so each test can pin presence /
 * absence of `caseSearchConfig` independently of the
 * `caseListConfig`.
 *
 * `caseListOnly: true` is the default so the expander treats the
 * module as case-bearing without needing to register a non-survey
 * form. Without one of those two signals, `expandDoc` strips the
 * `case_type` from the HQ JSON projection (see
 * `lib/commcare/expander.ts::expandDoc`'s `hasCases` derivation),
 * which the compiler reads as "no detail blocks to emit." Tests
 * exercising the dual-emit need the case path live, so the
 * default makes the case-bearing branch the test-default shape.
 */
function makeModule(args: {
	readonly caseType?: string;
	readonly caseListConfig?: CaseListConfig;
	readonly caseSearchConfig?: CaseSearchConfig;
}): Module {
	return {
		uuid: MODULE_UUID,
		id: "test_module",
		name: "Test Module",
		caseListOnly: true,
		...(args.caseType !== undefined && { caseType: args.caseType }),
		...(args.caseListConfig !== undefined && {
			caseListConfig: args.caseListConfig,
		}),
		...(args.caseSearchConfig !== undefined && {
			caseSearchConfig: args.caseSearchConfig,
		}),
	};
}

function makeListConfig(
	overrides: Partial<CaseListConfig> = {},
): CaseListConfig {
	return {
		columns: [],
		searchInputs: [],
		...overrides,
	};
}

/**
 * Minimal `CaseSearchConfig` that flips presence on. Every slot is
 * optional and unused at this layer — the dual-detail emitter cares
 * about presence-vs-absence of the config (the orchestrator's
 * branch condition); the semantic content of the config drives the
 * `<remote-request>` orchestrator emission, not detail-block
 * content.
 */
function makeSearchConfig(): CaseSearchConfig {
	return {};
}

type SparseCaseType = {
	readonly name: string;
	readonly properties: ReadonlyArray<{
		readonly name: string;
		readonly data_type?: import("@/lib/domain").CasePropertyDataType;
		readonly parent_type?: string;
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
			...(p.parent_type !== undefined && { parent_type: p.parent_type }),
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
// Shell 1 — case-only modules (no caseSearchConfig)
// ============================================================
//
// The dual-emit branch is purely additive. A module without
// `caseSearchConfig` emits the case pair only — exactly the same
// XML the existing case-list emitter has always produced.

describe("dual-detail emission — case-only modules", () => {
	it("emits only m{N}_case_short / m{N}_case_long when caseSearchConfig is absent", () => {
		const mod = makeModule({
			caseType: "patient",
			caseListConfig: makeListConfig({
				columns: [plainColumn(COL(1), "full_name", "Name")],
			}),
		});
		const doc = buildDoc({
			module: mod,
			caseTypes: [
				{
					name: "patient",
					properties: [{ name: "full_name", data_type: "text" }],
				},
			],
		});
		const hqJson = expandDoc(doc);
		const ccz = compileCcz(hqJson, "Test App", doc);
		const suiteXml = readSuiteXml(ccz);

		expect(suiteXml).toContain('<detail id="m0_case_short">');
		expect(suiteXml).toContain('<detail id="m0_case_long">');
		expect(suiteXml).not.toContain('<detail id="m0_search_short"');
		expect(suiteXml).not.toContain('<detail id="m0_search_long"');
	});

	it("emits the case pair byte-identically to the case-only emitter output", () => {
		// The dual-emit's additive promise: case-only modules render
		// exactly as the existing single-target emitter would. Pin
		// that by comparing the orchestrator's rendered case blocks
		// against the per-emitter output called directly with no
		// target (which defaults to "case").
		const mod = makeModule({
			caseType: "patient",
			caseListConfig: makeListConfig({
				columns: [
					plainColumn(COL(1), "full_name", "Name", {
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
					properties: [{ name: "full_name", data_type: "text" }],
				},
			],
		});

		const direct = emitShortDetail({ module: mod, moduleIndex: 0, doc });
		const directLong = emitLongDetail({ module: mod, moduleIndex: 0, doc });

		const hqJson = expandDoc(doc);
		const ccz = compileCcz(hqJson, "Test App", doc);
		const suiteXml = readSuiteXml(ccz);

		expect(suiteXml).toContain(direct.xml);
		expect(suiteXml).toContain(directLong.xml);
	});
});

// ============================================================
// Shell 2 — modules with caseSearchConfig emit four blocks
// ============================================================

describe("dual-detail emission — search-enabled modules", () => {
	it("emits all four detail blocks when caseSearchConfig is present", () => {
		const mod = makeModule({
			caseType: "patient",
			caseListConfig: makeListConfig({
				columns: [
					plainColumn(COL(1), "full_name", "Name", {
						sort: { direction: "asc", priority: 0 },
					}),
					dateColumn(COL(2), "birthdate", "Birthdate", "%d/%m/%Y"),
				],
			}),
			caseSearchConfig: makeSearchConfig(),
		});
		const doc = buildDoc({
			module: mod,
			caseTypes: [
				{
					name: "patient",
					properties: [
						{ name: "full_name", data_type: "text" },
						{ name: "birthdate", data_type: "date" },
					],
				},
			],
		});
		const hqJson = expandDoc(doc);
		const ccz = compileCcz(hqJson, "Test App", doc);
		const suiteXml = readSuiteXml(ccz);

		expect(suiteXml).toContain('<detail id="m0_case_short">');
		expect(suiteXml).toContain('<detail id="m0_case_long">');
		expect(suiteXml).toContain('<detail id="m0_search_short">');
		expect(suiteXml).toContain('<detail id="m0_search_long">');
	});

	it("projects sort blocks identically onto m{N}_search_short", () => {
		// CCHQ's
		// `commcare-hq/corehq/apps/app_manager/tests/data/suite/search_command_detail.xml::detail[@id='m0_search_short']`
		// carries the same `<sort>` directive (order, direction,
		// xpath) as `m0_case_short`. Nova projects the same
		// `caseListConfig.columns[*].sort` through `buildSortDirectives`
		// onto both wire ids.
		const mod = makeModule({
			caseType: "patient",
			caseListConfig: makeListConfig({
				columns: [
					plainColumn(COL(1), "full_name", "Name", {
						sort: { direction: "asc", priority: 0 },
					}),
				],
			}),
			caseSearchConfig: makeSearchConfig(),
		});
		const doc = buildDoc({
			module: mod,
			caseTypes: [
				{
					name: "patient",
					properties: [{ name: "full_name", data_type: "text" }],
				},
			],
		});
		const caseShort = emitShortDetail({
			module: mod,
			moduleIndex: 0,
			doc,
			target: "case",
		});
		const searchShort = emitShortDetail({
			module: mod,
			moduleIndex: 0,
			doc,
			target: "search",
		});

		// Extract the <sort>...</sort> blocks from both. Inner content
		// (xpath, order, direction, type) is identical; only the
		// header locale id of the surrounding field differs.
		const caseSort = extractSortBlocks(caseShort.xml);
		const searchSort = extractSortBlocks(searchShort.xml);
		expect(searchSort).toEqual(caseSort);
		expect(caseSort.length).toBeGreaterThan(0);
	});

	it("emits no <sort> blocks on either long detail when caseSearchConfig is present", () => {
		// Long detail suppresses sort on both the case and the search
		// targets — verified against
		// `commcare-hq/corehq/apps/app_manager/tests/data/suite/search_command_detail.xml::detail[@id='m0_search_long']`
		// which carries zero `<sort>` blocks despite the parent
		// module's case-list short detail having sort directives.
		const mod = makeModule({
			caseType: "patient",
			caseListConfig: makeListConfig({
				columns: [
					plainColumn(COL(1), "full_name", "Name", {
						sort: { direction: "asc", priority: 0 },
					}),
				],
			}),
			caseSearchConfig: makeSearchConfig(),
		});
		const doc = buildDoc({
			module: mod,
			caseTypes: [
				{
					name: "patient",
					properties: [{ name: "full_name", data_type: "text" }],
				},
			],
		});
		const caseLong = emitLongDetail({
			module: mod,
			moduleIndex: 0,
			doc,
			target: "case",
		});
		const searchLong = emitLongDetail({
			module: mod,
			moduleIndex: 0,
			doc,
			target: "search",
		});
		expect(caseLong.xml).not.toContain("<sort");
		expect(searchLong.xml).not.toContain("<sort");
	});
});

// ============================================================
// Shell 3 — field content identity between case and search
// ============================================================
//
// The two wire ids share the rendered `<field>` content. Nova's
// principle is "from the user's perspective there is only one case
// list" — visibility filters, column ordering, and per-kind XPath
// shapes carry identically.

describe("dual-detail emission — field content identity", () => {
	it("orders Results and Details independently without changing case/search target parity", () => {
		const first = plainColumn(COL(1), "first", "First", {
			listOrder: "b",
			detailOrder: "a",
		});
		const second = plainColumn(COL(2), "second", "Second", {
			listOrder: "a",
			detailOrder: "b",
		});
		const mod = makeModule({
			caseType: "patient",
			caseListConfig: makeListConfig({ columns: [first, second] }),
			caseSearchConfig: makeSearchConfig(),
		});
		const doc = buildDoc({
			module: mod,
			caseTypes: [
				{
					name: "patient",
					properties: [
						{ name: "first", data_type: "text" },
						{ name: "second", data_type: "text" },
					],
				},
			],
		});

		const caseShort = emitShortDetail({
			module: mod,
			moduleIndex: 0,
			doc,
			target: "case",
		});
		const searchShort = emitShortDetail({
			module: mod,
			moduleIndex: 0,
			doc,
			target: "search",
		});
		const caseLong = emitLongDetail({
			module: mod,
			moduleIndex: 0,
			doc,
			target: "case",
		});
		const searchLong = emitLongDetail({
			module: mod,
			moduleIndex: 0,
			doc,
			target: "search",
		});

		// Results: second, first. Details: first, second. Case and search
		// targets remain structurally identical within each surface.
		expect(extractFieldTemplates(caseShort.xml)).toEqual([
			'<template><text><xpath function="second"/></text></template>',
			'<template><text><xpath function="first"/></text></template>',
		]);
		expect(extractFieldTemplates(searchShort.xml)).toEqual(
			extractFieldTemplates(caseShort.xml),
		);
		expect(extractFieldTemplates(caseLong.xml)).toEqual([
			'<template><text><xpath function="first"/></text></template>',
			'<template><text><xpath function="second"/></text></template>',
		]);
		expect(extractFieldTemplates(searchLong.xml)).toEqual(
			extractFieldTemplates(caseLong.xml),
		);
	});

	it("renders the same <field> set on case-short and search-short under the visibleInList filter", () => {
		const mod = makeModule({
			caseType: "patient",
			caseListConfig: makeListConfig({
				columns: [
					plainColumn(COL(1), "full_name", "Name"),
					// Hidden from list — must NOT appear on either wire id.
					plainColumn(COL(2), "external_id", "External ID", {
						visibleInList: false,
					}),
					dateColumn(COL(3), "birthdate", "Birthdate", "%d/%m/%Y"),
				],
			}),
			caseSearchConfig: makeSearchConfig(),
		});
		const doc = buildDoc({
			module: mod,
			caseTypes: [
				{
					name: "patient",
					properties: [
						{ name: "full_name", data_type: "text" },
						{ name: "external_id", data_type: "text" },
						{ name: "birthdate", data_type: "date" },
					],
				},
			],
		});
		const caseShort = emitShortDetail({
			module: mod,
			moduleIndex: 0,
			doc,
			target: "case",
		});
		const searchShort = emitShortDetail({
			module: mod,
			moduleIndex: 0,
			doc,
			target: "search",
		});

		// Field templates carry pure-property xpath references with
		// no instance prefix; identical content on both wire ids.
		expect(extractFieldTemplates(searchShort.xml)).toEqual(
			extractFieldTemplates(caseShort.xml),
		);
		// Hidden column is absent from BOTH.
		expect(caseShort.xml).not.toContain('<xpath function="external_id"/>');
		expect(searchShort.xml).not.toContain('<xpath function="external_id"/>');
	});

	it("preserves an off-screen Default-order rule in the compiled CCZ without showing it", () => {
		const sortOnly = plainColumn(COL(2), "external_id", "External ID", {
			visibleInList: false,
			visibleInDetail: false,
			sort: { direction: "asc", priority: 0 },
		});
		const mod = makeModule({
			caseType: "patient",
			caseListConfig: makeListConfig({
				columns: [plainColumn(COL(1), "full_name", "Name"), sortOnly],
			}),
		});
		const doc = buildDoc({
			module: mod,
			caseTypes: [
				{
					name: "patient",
					properties: [
						{ name: "full_name", data_type: "text" },
						{ name: "external_id", data_type: "text" },
					],
				},
			],
		});

		const suiteXml = readSuiteXml(compileCcz(expandDoc(doc), "Test App", doc));
		const short = suiteXml.match(
			/<detail id="m0_case_short">[\s\S]*?<\/detail>/,
		)?.[0];
		const long = suiteXml.match(
			/<detail id="m0_case_long">[\s\S]*?<\/detail>/,
		)?.[0];

		expect(short).toContain('<header width="0">');
		expect(short).toContain('<template width="0">');
		expect(short).toContain('<xpath function="external_id"/>');
		expect(short).toContain(
			'<sort type="string" order="1" direction="ascending">',
		);
		expect(long).not.toContain('<xpath function="external_id"/>');
	});

	it("renders the same <field> set on case-long and search-long under the visibleInDetail filter", () => {
		const mod = makeModule({
			caseType: "patient",
			caseListConfig: makeListConfig({
				columns: [
					plainColumn(COL(1), "full_name", "Name"),
					// Hidden from detail — must NOT appear on either long block.
					plainColumn(COL(2), "external_id", "External ID", {
						visibleInDetail: false,
					}),
					dateColumn(COL(3), "birthdate", "Birthdate", "%d/%m/%Y"),
				],
			}),
			caseSearchConfig: makeSearchConfig(),
		});
		const doc = buildDoc({
			module: mod,
			caseTypes: [
				{
					name: "patient",
					properties: [
						{ name: "full_name", data_type: "text" },
						{ name: "external_id", data_type: "text" },
						{ name: "birthdate", data_type: "date" },
					],
				},
			],
		});
		const caseLong = emitLongDetail({
			module: mod,
			moduleIndex: 0,
			doc,
			target: "case",
		});
		const searchLong = emitLongDetail({
			module: mod,
			moduleIndex: 0,
			doc,
			target: "search",
		});

		expect(extractFieldTemplates(searchLong.xml)).toEqual(
			extractFieldTemplates(caseLong.xml),
		);
		expect(caseLong.xml).not.toContain('<xpath function="external_id"/>');
		expect(searchLong.xml).not.toContain('<xpath function="external_id"/>');
	});
});

// ============================================================
// Shell 4 — localization-key swap and instance-reference rewrite
// ============================================================

describe("dual-detail emission — locale-id prefix swap", () => {
	it("registers headers under m{N}.case_short.* on case target and m{N}.search_short.* on search target", () => {
		// Mirrors the canonical fixture's contrast — `m0_case_short`'s
		// `<header>` locale id is
		// `m0.case_short.case_<field>_<n>.header`, and
		// `m0_search_short`'s is `m0.search_short.case_<field>_<n>.header`.
		// The leading `case_` segment of the suffix is CCHQ's
		// `column.model` token (case-rooted detail), independent of
		// the `case_short` / `search_short` substring.
		const mod = makeModule({
			caseType: "patient",
			caseListConfig: makeListConfig({
				columns: [plainColumn(COL(1), "full_name", "Name")],
			}),
			caseSearchConfig: makeSearchConfig(),
		});
		const doc = buildDoc({
			module: mod,
			caseTypes: [
				{
					name: "patient",
					properties: [{ name: "full_name", data_type: "text" }],
				},
			],
		});
		const caseShort = emitShortDetail({
			module: mod,
			moduleIndex: 0,
			doc,
			target: "case",
		});
		const searchShort = emitShortDetail({
			module: mod,
			moduleIndex: 0,
			doc,
			target: "search",
		});

		expect(caseShort.strings).toEqual({
			"m0.case_short.case_full_name_1.header": "Name",
		});
		expect(searchShort.strings).toEqual({
			"m0.search_short.case_full_name_1.header": "Name",
		});
	});

	it("registers headers under m{N}.case_long.* on case target and m{N}.search_long.* on search target", () => {
		const mod = makeModule({
			caseType: "patient",
			caseListConfig: makeListConfig({
				columns: [plainColumn(COL(1), "full_name", "Name")],
			}),
			caseSearchConfig: makeSearchConfig(),
		});
		const doc = buildDoc({
			module: mod,
			caseTypes: [
				{
					name: "patient",
					properties: [{ name: "full_name", data_type: "text" }],
				},
			],
		});
		const caseLong = emitLongDetail({
			module: mod,
			moduleIndex: 0,
			doc,
			target: "case",
		});
		const searchLong = emitLongDetail({
			module: mod,
			moduleIndex: 0,
			doc,
			target: "search",
		});

		expect(caseLong.strings).toEqual({
			"m0.case_long.case_full_name_1.header": "Name",
		});
		expect(searchLong.strings).toEqual({
			"m0.search_long.case_full_name_1.header": "Name",
		});
	});
});

describe("dual-detail emission — calc-xpath instance rewrite", () => {
	it("rewrites instance('casedb') to instance('results') on calc-column cross-case lookups in search target", () => {
		// The canonical fixture's field 4 on `m0_case_short` carries
		// `instance('casedb')/casedb/case[@case_id=current()/index/parent]/whatever`;
		// the same field on `m0_search_short` carries the
		// instance-rewritten form
		// `instance('results')/results/case[@case_id=current()/index/parent]/whatever`.
		// Nova authoring expresses this kind of cross-case property
		// reference through a calculated column whose `term` walks
		// `via: ancestorPath(...)`.
		const ancestorRef = term(
			prop("parent_type", "whatever", ancestorPath(relationStep("parent"))),
		);
		const mod = makeModule({
			caseType: "patient",
			caseListConfig: makeListConfig({
				columns: [calculatedColumn(COL(1), "Parent Whatever", ancestorRef)],
			}),
			caseSearchConfig: makeSearchConfig(),
		});
		const doc = buildDoc({
			module: mod,
			caseTypes: [
				{
					name: "patient",
					properties: [
						{ name: "x", data_type: "text", parent_type: "parent_type" },
					],
				},
				{
					name: "parent_type",
					properties: [{ name: "whatever", data_type: "text" }],
				},
			],
		});
		const caseShort = emitShortDetail({
			module: mod,
			moduleIndex: 0,
			doc,
			target: "case",
		});
		const searchShort = emitShortDetail({
			module: mod,
			moduleIndex: 0,
			doc,
			target: "search",
		});

		// Case target carries the casedb root. XPath single-quote
		// literals round-trip through the serializer as `&apos;`
		// inside the double-quoted attribute value.
		expect(caseShort.xml).toContain(
			"instance(&apos;casedb&apos;)/casedb/case[@case_id=current()/index/parent]/whatever",
		);
		expect(caseShort.xml).not.toContain(
			"instance(&apos;results&apos;)/results/case[@case_id=current()/index/parent]/whatever",
		);
		// Search target rewrites the root.
		expect(searchShort.xml).toContain(
			"instance(&apos;results&apos;)/results/case[@case_id=current()/index/parent]/whatever",
		);
		expect(searchShort.xml).not.toContain(
			"instance(&apos;casedb&apos;)/casedb/case[@case_id=current()/index/parent]/whatever",
		);
	});

	it("rewrites the instance reference on the corresponding sort directive too", () => {
		// When a calc column with cross-case lookup carries a sort
		// directive, the rendered `<sort>` block on `m{N}_search_short`
		// must carry the rewritten `instance('results')` root —
		// otherwise the runtime would try to evaluate the directive
		// against the wrong roster and fall back to the no-op
		// comparator. The directive ships through the inline-variable
		// shape, so the rewrite needs to apply to the inner
		// `<variable name="calculated_property">` xpath.
		const ancestorRef = term(
			prop("parent_type", "whatever", ancestorPath(relationStep("parent"))),
		);
		const mod = makeModule({
			caseType: "patient",
			caseListConfig: makeListConfig({
				columns: [
					calculatedColumn(COL(1), "Parent Whatever", ancestorRef, {
						sort: { direction: "asc", priority: 0 },
					}),
				],
			}),
			caseSearchConfig: makeSearchConfig(),
		});
		const doc = buildDoc({
			module: mod,
			caseTypes: [
				{
					name: "patient",
					properties: [
						{ name: "x", data_type: "text", parent_type: "parent_type" },
					],
				},
				{
					name: "parent_type",
					properties: [{ name: "whatever", data_type: "text" }],
				},
			],
		});
		const searchShort = emitShortDetail({
			module: mod,
			moduleIndex: 0,
			doc,
			target: "search",
		});

		const sortBlocks = extractSortBlocks(searchShort.xml);
		expect(sortBlocks.length).toBe(1);
		// XPath single-quote literals round-trip as `&apos;` inside
		// the double-quoted attribute value.
		expect(sortBlocks[0]).toContain(
			"instance(&apos;results&apos;)/results/case[",
		);
		expect(sortBlocks[0]).not.toContain(
			"instance(&apos;casedb&apos;)/casedb/case[",
		);
	});

	it("leaves property-rooted column xpath untouched on search target — no instance prefix to rewrite", () => {
		// The five property-rooted column kinds emit bare property
		// references (or wrapped formats around them) with no
		// instance prefix. The search-target emission carries the
		// same xpath as the case target.
		const mod = makeModule({
			caseType: "patient",
			caseListConfig: makeListConfig({
				columns: [plainColumn(COL(1), "full_name", "Name")],
			}),
			caseSearchConfig: makeSearchConfig(),
		});
		const doc = buildDoc({
			module: mod,
			caseTypes: [
				{
					name: "patient",
					properties: [{ name: "full_name", data_type: "text" }],
				},
			],
		});
		const searchShort = emitShortDetail({
			module: mod,
			moduleIndex: 0,
			doc,
			target: "search",
		});

		expect(searchShort.xml).toContain('<xpath function="full_name"/>');
		// No instance reference should leak in either flavor. XPath
		// single-quote literals round-trip through the serializer as
		// `&apos;`, so the negative assertions check the entity-encoded
		// form the rendered XML actually carries.
		expect(searchShort.xml).not.toContain("instance(&apos;casedb&apos;)");
		expect(searchShort.xml).not.toContain("instance(&apos;results&apos;)");
	});
});

// ============================================================
// XML extraction utilities
// ============================================================
//
// The structural-pin tests below operate on the rendered XML by
// extracting subtrees via balanced-tag scans. The wire emitter's
// output is well-formed XML so a regex over the literal `<sort>`
// / `<template>` substrings is sufficient — we don't need a full
// parser at this layer (the compiler at
// `lib/commcare/compiler.ts::compileCcz` runs `parseDocument` over
// the full suite XML before packaging, which is the structural
// gate).

/**
 * Pull every `<sort> ... </sort>` block out of a rendered detail
 * XML fragment. Returns the literal substrings (including the
 * surrounding tags) in source-order.
 */
function extractSortBlocks(xml: string): readonly string[] {
	return Array.from(xml.matchAll(/<sort[\s\S]*?<\/sort>/g)).map((m) => m[0]);
}

/**
 * Pull every `<template> ... </template>` block out of a rendered
 * detail XML fragment. Returns the literal substrings (including
 * the surrounding tags) in source-order. Field content identity
 * tests compare these arrays element-wise to assert that case-
 * target and search-target emit the same column expressions in
 * the same order.
 */
function extractFieldTemplates(xml: string): readonly string[] {
	return Array.from(xml.matchAll(/<template[\s\S]*?<\/template>/g)).map(
		(m) => m[0],
	);
}

/**
 * Read the suite XML out of a compiled `.ccz` archive. The compiler
 * packages the suite as `suite.xml` at the archive root. Used by the
 * Shell-1 / Shell-2 end-to-end tests that walk the orchestrator
 * (rather than calling the per-detail emitters directly), so the
 * `mod.caseSearchConfig`-driven orchestration branch is exercised.
 */
function readSuiteXml(ccz: Buffer): string {
	const zip = new AdmZip(ccz);
	const entry = zip.getEntry("suite.xml");
	if (!entry) {
		throw new Error(
			"Compiled .ccz archive is missing the expected suite.xml entry. " +
				"This indicates the compiler did not package the suite XML — " +
				"check that compileCcz ran to completion and that the input " +
				"BlueprintDoc was well-formed.",
		);
	}
	return entry.getData().toString("utf-8");
}
