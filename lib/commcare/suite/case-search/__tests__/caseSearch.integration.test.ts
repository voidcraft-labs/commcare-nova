import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
// lib/commcare/suite/case-search/__tests__/caseSearch.integration.test.ts
//
// End-to-end integration test for the case-search authoring →
// wire emission pipeline. The per-emitter, per-rule, and per-tool
// tests pin fine-grained behavior on each surface; this file wires
// every surface together against ONE realistic blueprint and pins
// the composition contract: schema → validator → SA tool →
// mutations → blueprint state → compile → suite XML.
//
// Coverage map (one assertion-cluster per surface; no duplication
// of fine-grained per-surface coverage):
//
//   1. `caseSearchConfig` round-trips through `caseSearchConfigSchema`.
//   2. `runValidation` stays silent on a structurally-clean blueprint
//      that exercises every covered slot; one error code is sampled
//      to confirm the validator wires through the same realistic
//      shape.
//   3. `setCaseSearchDisplay` then `setCaseSearchAdvanced` chain
//      through the same context — both clusters land, neither
//      clobbers the other.
//   4. `compileCcz` produces suite XML carrying the canonical
//      `<remote-request>` shape (post → command → instance → session
//      → stack), the dual-detail blocks (`m{N}_case_*` +
//      `m{N}_search_*`), `<action auto_launch>` on the case target
//      with `relevant` set when `searchButtonDisplayCondition` is
//      authored, the `<query>` `<data>` slot order
//      (`case_type` → `commcare_blacklisted_owner_ids` → `_xpath_query`),
//      `<title>` + `<prompt>` blocks per the search inputs, the
//      `<datum>` referencing `m{N}_search_short` /
//      `m{N}_search_long`, and the `<stack>` rewind frame.
//   5. `compileForPlatform` returns the right `WireShape` per
//      branch of the platform decision tree.
//
// CCHQ verification gates for the wire shape (cited by stable name):
//
//   - `~/code/commcare-hq/.../tests/data/suite/remote_request.xml` —
//     canonical `<remote-request>` child order.
//   - `~/code/commcare-hq/.../tests/data/suite/search_config_blacklisted_owners.xml` —
//     blacklist-on-`<query>` shape.
//   - `~/code/commcare-hq/.../tests/data/suite/search_command_detail.xml` —
//     dual-detail emission with `<action auto_launch>` on the case
//     target only.
//   - `~/code/commcare-hq/.../suite_xml/post_process/remote_requests.py::RemoteRequestFactory` —
//     orchestrator Nova mirrors.
//   - `~/code/commcare-hq/.../suite_xml/sections/details.py::DetailContributor._get_relevant_expression` —
//     `<action relevant>` wiring.
//   - `~/code/commcare-hq/.../case_search/const.py::EXCLUDE_RELATED_CASES_FILTER` —
//     `[not(commcare_is_related_case=true())]`.
//   - `~/code/commcare-hq/.../case_search/models.py::CASE_SEARCH_BLACKLISTED_OWNER_ID_KEY` /
//     `CASE_SEARCH_XPATH_QUERY_KEY` — wire-key constants.

import AdmZip from "adm-zip";
import { decodeXML } from "entities";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { makeCaseSearchFixture } from "@/lib/agent/tools/case-search-config/__tests__/fixtures";
import { setCaseSearchAdvancedTool } from "@/lib/agent/tools/case-search-config/setCaseSearchAdvanced";
import { setCaseSearchDisplayTool } from "@/lib/agent/tools/case-search-config/setCaseSearchDisplay";
import { compileCcz } from "@/lib/commcare/compiler";
import { expandDoc } from "@/lib/commcare/expander";
import { runValidation } from "@/lib/commcare/validator/runner";
import {
	advancedSearchInputDef,
	asUuid,
	type BlueprintDoc,
	caseSearchConfigSchema,
	plainColumn,
	simpleSearchInputDef,
} from "@/lib/domain";
import {
	eq,
	input,
	literal,
	matchAll,
	prop,
	sessionUser,
	term,
	toValueExpression,
	whenInput,
} from "@/lib/domain/predicate";
import { compileForPlatform } from "../compileForPlatform";

// ============================================================
// Test fixtures
// ============================================================
//
// The integration suite uses two fixtures, each scoped to the work
// it pins:
//
//   - `buildSearchBlueprint` — the realistic search-enabled
//     blueprint. Sections 1 (schema round-trip), 2 (validator
//     surface), 4 (suite XML wire emission), and 5 (platform decision
//     tree) all boot from this shape. One shape across those four
//     sections means every slot they pin sees the same realistic
//     blueprint — drift in any wire-emission surface surfaces across
//     the file.
//   - `makeCaseSearchFixture` (imported from
//     `@/lib/agent/tools/case-search-config/__tests__/fixtures`) —
//     the SA tool round-trip fixture used by Section 3. The SA tools
//     need a paired `GenerationContext` shim (vi.fn-stubbed SSE
//     writer + log writer) and the wholesale-replace contract is
//     best demonstrated starting from an empty `caseSearchConfig` so
//     each `set*` call's slot-set is observable.
//
// `buildSearchBlueprint` exercises every slot the case-search
// authoring surface introduces:
//
//   - `caseSearchConfig.searchScreenTitle` + `searchButtonLabel` —
//     display cluster slots that land in `app_strings.txt` and on
//     the `<query>` `<title>` block.
//   - `caseSearchConfig.searchButtonDisplayCondition` — the predicate
//     compiled to on-device XPath and stamped on
//     `<action relevant>`.
//   - `caseSearchConfig.excludedOwnerIds` — the value expression
//     that emits as `<data key="commcare_blacklisted_owner_ids">` on
//     `<query>`.
//   - `caseListConfig.filter` + `caseListConfig.searchInputs` (one
//     simple + one advanced) — AND-composed into one
//     `<data key="_xpath_query">` element on `<query>`.

const MOD_UUID = asUuid("11111111-1111-1111-1111-111111111111");
const COL_NAME_UUID = asUuid("22222222-2222-2222-2222-aaaaaaaa0001");
const COL_REGION_UUID = asUuid("22222222-2222-2222-2222-aaaaaaaa0002");
const SI_NAME_UUID = asUuid("33333333-3333-3333-3333-bbbbbbbb0001");
const SI_STATUS_UUID = asUuid("33333333-3333-3333-3333-bbbbbbbb0002");

/**
 * Build the realistic search-enabled blueprint. Returns a fully-
 * normalized `BlueprintDoc` (uuids, fieldParent, formOrder, etc.)
 * via `buildDoc`. Sections 1, 2, 4, and 5 all call this helper
 * rather than rebuilding the spec inline — drift in the spec
 * surfaces across those sections.
 *
 * The always-on filter and both search-input arms compose into one
 * query. The filter walks `region` directly on `patient`; the simple
 * input targets `case_name`; the advanced input is a free-form
 * predicate over `status`.
 */
function buildSearchBlueprint(): BlueprintDoc {
	return buildDoc({
		appName: "Clinic Intake",
		modules: [
			{
				uuid: MOD_UUID,
				name: "Patient",
				caseType: "patient",
				caseListConfig: {
					columns: [
						plainColumn(COL_NAME_UUID, "case_name", "Name"),
						plainColumn(COL_REGION_UUID, "region", "Region"),
					],
					// Filter on `region` — a self-walk on the patient case.
					filter: eq(prop("patient", "region"), literal("North")),
					searchInputs: [
						// Simple input on `case_name`.
						simpleSearchInputDef(
							SI_NAME_UUID,
							"name_search",
							"Search by name",
							"text",
							"case_name",
						),
						// Advanced input — a free-form predicate over `status`
						// whose body composes into `<data key="_xpath_query">`
						// alongside the filter via the AST-level AND.
						advancedSearchInputDef(
							SI_STATUS_UUID,
							"status_search",
							"Status",
							"text",
							eq(prop("patient", "status"), literal("active")),
						),
					],
				},
				caseSearchConfig: {
					searchScreenTitle: "Find a patient",
					searchButtonLabel: "Search patients",
					searchButtonDisplayCondition: eq(
						sessionUser("role"),
						literal("supervisor"),
					),
					excludedOwnerIds: toValueExpression(literal("excluded-owner-id")),
				},
				forms: [
					{
						name: "Register",
						type: "registration",
						fields: [
							f({
								kind: "text",
								id: "case_name",
								label: "Name",
								case_property_on: "patient",
							}),
							f({
								kind: "text",
								id: "region",
								label: "Region",
								case_property_on: "patient",
							}),
							f({
								kind: "text",
								id: "status",
								label: "Status",
								case_property_on: "patient",
							}),
						],
					},
				],
			},
		],
		caseTypes: [
			{
				name: "patient",
				properties: [
					{ name: "case_name", label: "Name", data_type: "text" },
					{ name: "region", label: "Region", data_type: "text" },
					{ name: "status", label: "Status", data_type: "text" },
				],
			},
		],
	});
}

/**
 * Run the doc through the expander + compiler and pull the bundled
 * `suite.xml` back out of the resulting `.ccz` archive. This is the
 * single end-to-end compile path every case-search wire-emission
 * surface composes onto: dual-detail blocks, `<remote-request>`
 * orchestrator, `<query>` body, `<action auto_launch>` threading,
 * instance accumulation, app-strings registration.
 */
function compileSuiteXml(doc: BlueprintDoc): string {
	const hqJson = expandDoc(doc);
	const ccz = compileCcz(hqJson, doc.appName, doc);
	const zip = new AdmZip(ccz);
	const entry = zip.getEntry("suite.xml");
	if (!entry) {
		throw new Error(
			"Compiled .ccz archive is missing the expected suite.xml entry. " +
				"Check that compileCcz ran to completion and that the input " +
				"BlueprintDoc was well-formed.",
		);
	}
	return entry.getData().toString("utf-8");
}

// SA-tool tests need the app-state writes mocked. The mock is at
// module scope per the project's standing pattern (see
// `setCaseSearchAdvanced.test.ts`).
vi.mock("@/lib/db/apps", () => ({
	completeApp: vi.fn(() => Promise.resolve()),
}));

vi.mock("@/lib/db/applyBlueprintChange", () => ({
	applyBlueprintChange: vi.fn(() => Promise.resolve({ seq: 0 })),
}));

beforeEach(() => {
	vi.clearAllMocks();
});

// ============================================================
// 1. Schema round-trip
// ============================================================

describe("case-search integration — schema round-trip", () => {
	it("authors a caseSearchConfig that round-trips through caseSearchConfigSchema", () => {
		// The fixture's `caseSearchConfig` exercises every slot the
		// case-search authoring surface introduces — both display
		// labels, the search-button display condition, and the
		// excluded-owners value expression. The `.strict()` schema
		// rejects unknown keys; a clean parse pins that the fixture's
		// keys match the schema's declared shape.
		const doc = buildSearchBlueprint();
		const config = doc.modules[MOD_UUID]?.caseSearchConfig;
		expect(caseSearchConfigSchema.safeParse(config).success).toBe(true);
	});
});

// ============================================================
// 2. Validator surface
// ============================================================
//
// `runValidation` stays silent on the clean fixture; a single
// targeted mutation flips the validator into firing the matching
// case-search rule. Cross-rule simultaneity is pinned in
// `lib/commcare/validator/rules/case-search/__tests__/integration.test.ts`
// — this layer's job is to confirm the validator wires through the
// same realistic blueprint the compiler walks.

describe("case-search integration — validator surface", () => {
	it("admits the realistic search-enabled blueprint with no case-search-config errors", () => {
		const doc = buildSearchBlueprint();
		const errors = runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE);
		const caseSearchCodes = new Set([
			"CASE_SEARCH_BUTTON_DISPLAY_CONDITION_TYPE_ERROR",
			"CASE_SEARCH_BUTTON_DISPLAY_CONDITION_CASE_DATA_UNAVAILABLE",
			"CASE_SEARCH_EXCLUDED_OWNER_IDS_CASE_DATA_UNAVAILABLE",
			"CASE_SEARCH_EXCLUDED_OWNER_IDS_TYPE_ERROR",
			"CASE_LIST_SEARCH_INPUT_DEFAULT_TYPE_ERROR",
			"CASE_LIST_SEARCH_INPUT_DEFAULT_CASE_DATA_UNAVAILABLE",
			"CASE_LIST_SEARCH_INPUT_PREDICATE_TYPE_ERROR",
		]);
		expect(errors.filter((e) => caseSearchCodes.has(e.code))).toEqual([]);
	});

	it("fires CASE_SEARCH_BUTTON_DISPLAY_CONDITION_TYPE_ERROR when the predicate references an unknown search input", () => {
		// One representative violation of one type-check rule confirms
		// the rule wires through `runValidation` against this fixture
		// shape. Per-rule fine-grained coverage lives in the rule's
		// own test file; the all-rules-fire-simultaneously proof lives
		// in the case-search rules' integration file.
		const doc = buildSearchBlueprint();
		const broken: BlueprintDoc = {
			...doc,
			modules: {
				...doc.modules,
				[MOD_UUID]: {
					...doc.modules[MOD_UUID],
					caseSearchConfig: {
						...doc.modules[MOD_UUID].caseSearchConfig,
						searchButtonDisplayCondition: eq(input("ghost"), literal("x")),
					},
				},
			},
		};
		const errors = runValidation(broken, LOOKUP_CONTEXT_UNAVAILABLE);
		expect(
			errors.some(
				(e) => e.code === "CASE_SEARCH_BUTTON_DISPLAY_CONDITION_TYPE_ERROR",
			),
		).toBe(true);
	});

	it("rejects property reads in the globally-resolved excluded-owner value", () => {
		// The expression resolves before a case is selected. A property read
		// would be blank in Preview but row-scoped in an ordinary suite list,
		// so the shared validator rejects it before either wire is emitted.
		const doc = buildSearchBlueprint();
		const broken: BlueprintDoc = {
			...doc,
			modules: {
				...doc.modules,
				[MOD_UUID]: {
					...doc.modules[MOD_UUID],
					caseSearchConfig: {
						...doc.modules[MOD_UUID].caseSearchConfig,
						excludedOwnerIds: term(prop("patient", "phantom_property")),
					},
				},
			},
		};
		const errors = runValidation(broken, LOOKUP_CONTEXT_UNAVAILABLE);
		expect(
			errors.some(
				(e) =>
					e.code === "CASE_SEARCH_EXCLUDED_OWNER_IDS_CASE_DATA_UNAVAILABLE",
			),
		).toBe(true);
	});
});

// ============================================================
// 3. SA tool round-trip
// ============================================================
//
// The two case-search-config SA tools (`setCaseSearchDisplay` +
// `setCaseSearchAdvanced`) share the cross-cluster preservation
// contract: each tool replaces its own cluster wholesale and
// preserves the OTHER cluster byte-identically. The fine-grained
// preservation tests live in each tool's dedicated test file. This
// layer confirms the contract holds when both tools fire in
// sequence on the same context, simulating the SA's typical
// authoring flow.

describe("case-search integration — SA tool round-trip", () => {
	it("chains setCaseSearchDisplay then setCaseSearchAdvanced — both clusters land, neither clobbers the other", async () => {
		// Boot the SA fixture's minimal one-module doc — the tool tests'
		// established context. Calls run through the chat-side
		// `GenerationContext`; the cross-surface MCP parity is pinned in
		// each tool's own file.
		const { doc, ctx } = makeCaseSearchFixture();

		// Step 1 — set the display cluster.
		const r1 = await setCaseSearchDisplayTool.execute(
			{
				moduleIndex: 0,
				searchScreenTitle: "Find a patient",
				searchScreenSubtitle: null,
				searchButtonLabel: "Search",
				searchButtonDisplayCondition: matchAll(),
			},
			ctx,
			doc,
		);
		expect(r1.kind).toBe("mutate");
		if ("error" in r1.result) {
			throw new Error(`unexpected error: ${r1.result.error}`);
		}
		expect(r1.result.displaySlotsSet).toContain("searchScreenTitle");
		expect(r1.result.displaySlotsSet).toContain("searchButtonLabel");

		// Step 2 — set the advanced cluster against the doc that
		// just received the display update. The advanced tool must
		// preserve the display labels written in Step 1.
		const excluded = term(literal("owner-x"));
		const r2 = await setCaseSearchAdvancedTool.execute(
			{
				moduleIndex: 0,
				excludedOwnerIds: excluded,
			},
			ctx,
			r1.newDoc,
		);
		expect(r2.kind).toBe("mutate");
		if ("error" in r2.result) {
			throw new Error(`unexpected error: ${r2.result.error}`);
		}
		expect(r2.result.advancedSlotsSet).toEqual(["excludedOwnerIds"]);

		// Final state — both clusters present.
		const moduleUuid = r2.newDoc.moduleOrder[0];
		const config = r2.newDoc.modules[moduleUuid]?.caseSearchConfig;
		expect(config?.searchScreenTitle).toBe("Find a patient");
		expect(config?.searchButtonLabel).toBe("Search");
		expect(config?.searchButtonDisplayCondition).toEqual(matchAll());
		expect(config?.excludedOwnerIds).toEqual(excluded);
		// Strict-schema round-trip — confirms no extra keys leak through
		// the chained mutation path.
		expect(caseSearchConfigSchema.safeParse(config).success).toBe(true);
	});

	it("returns an Elm-style error for an out-of-range moduleIndex", async () => {
		// One representative not-found arm proves the shared
		// `moduleNotFoundResult` wiring routes through the integration
		// path. Per-tool coverage of this arm lives in each tool's own
		// test file.
		const { doc, ctx } = makeCaseSearchFixture();
		const result = await setCaseSearchDisplayTool.execute(
			{
				moduleIndex: 99,
				searchScreenTitle: null,
				searchScreenSubtitle: null,
				searchButtonLabel: null,
				searchButtonDisplayCondition: null,
			},
			ctx,
			doc,
		);
		if (!("error" in result.result)) {
			throw new Error("expected error result");
		}
		expect(result.result.error).toContain("module index 99");
		expect(result.result.error).toContain("Found no module");
	});
});

// ============================================================
// 4. Wire emission — end-to-end suite XML compile
// ============================================================
//
// One realistic blueprint feeds through `expandDoc` + `compileCcz`;
// structural pins on the resulting `suite.xml` exercise every
// case-search wire-emission surface in composition. CCHQ's
// canonical fixtures carry registry / smart-link / sort-property
// content Nova doesn't emit — direct byte comparison would fail on
// those, so these pins are element-shape assertions over the
// canonical shape, not byte snapshots. The per-emitter unit tests
// own fine-grained shape coverage; this layer pins composition.

describe("case-search integration — suite XML wire emission", () => {
	it("emits both case-target and search-target detail blocks for the search-enabled module", () => {
		// Per `commcare-hq/.../tests/data/suite/search_command_detail.xml`,
		// a search-enabled module emits four `<detail>` blocks:
		// `m{N}_case_short`, `m{N}_case_long`, `m{N}_search_short`,
		// `m{N}_search_long`.
		const doc = buildSearchBlueprint();
		const suite = compileSuiteXml(doc);
		expect(suite).toContain('<detail id="m0_case_short">');
		expect(suite).toContain('<detail id="m0_case_long">');
		expect(suite).toContain('<detail id="m0_search_short">');
		expect(suite).toContain('<detail id="m0_search_long">');
	});

	it("emits a <remote-request> with the canonical child order: post → command → instance → session → stack", () => {
		// CCHQ's `RemoteRequestFactory.build_remote_request` composes
		// the children in a fixed order; the canonical fixture
		// `remote_request.xml` pins that shape. A regression on the
		// orchestrator's composition order would break CCHQ's parser
		// at import time.
		const doc = buildSearchBlueprint();
		const suite = compileSuiteXml(doc);
		const remoteOpenIdx = suite.indexOf("<remote-request>");
		expect(remoteOpenIdx).toBeGreaterThan(-1);
		const postIdx = suite.indexOf("<post ", remoteOpenIdx);
		const commandIdx = suite.indexOf("<command ", remoteOpenIdx);
		const instanceIdx = suite.indexOf("<instance ", remoteOpenIdx);
		const sessionIdx = suite.indexOf("<session>", remoteOpenIdx);
		const stackIdx = suite.indexOf("<stack>", remoteOpenIdx);
		expect(postIdx).toBeGreaterThan(remoteOpenIdx);
		expect(commandIdx).toBeGreaterThan(postIdx);
		expect(instanceIdx).toBeGreaterThan(commandIdx);
		expect(sessionIdx).toBeGreaterThan(instanceIdx);
		expect(stackIdx).toBeGreaterThan(sessionIdx);
	});

	it("emits <post> with the structural default-guard relevant attribute and a single case_id data child", () => {
		// `CaseClaimXpath.default_relevant` is the structural guard
		// every `<remote-request>` carries verbatim — there is no
		// authoring affordance for the claim condition. The `<post>`
		// body carries only the `case_id` data child.
		const doc = buildSearchBlueprint();
		const suite = compileSuiteXml(doc);
		// XPath single-quote literals round-trip through the
		// serializer as `&apos;` inside the double-quoted attribute
		// values.
		expect(suite).toContain(
			"count(instance(&apos;casedb&apos;)/casedb/case[@case_id=instance(&apos;commcaresession&apos;)/session/data/search_case_id]) = 0",
		);
		expect(suite).toContain(
			'<data key="case_id" ref="instance(&apos;commcaresession&apos;)/session/data/search_case_id"/>',
		);
	});

	it("emits <query> data slots in canonical order: case_type → _xpath_query → commcare_blacklisted_owner_ids", () => {
		// Slot order matches
		// `commcare-hq/.../suite_xml/post_process/remote_requests.py::_remote_request_query_datums`:
		// `case_type` first, then every `default_properties[]` entry
		// (where `_xpath_query` lives on CCHQ's side), then
		// `commcare_blacklisted_owner_ids`. The order is
		// runtime-irrelevant (data slots key into a `Multimap` by
		// key), but matching CCHQ's canonical order keeps Nova's
		// local suite.xml structurally mirroring the suite CCHQ
		// regenerates from the HQ JSON upload.
		const doc = buildSearchBlueprint();
		const suite = compileSuiteXml(doc);
		const caseTypeIdx = suite.indexOf('<data key="case_type"');
		const xpathIdx = suite.indexOf('<data key="_xpath_query"');
		const blacklistedIdx = suite.indexOf(
			'<data key="commcare_blacklisted_owner_ids"',
		);
		expect(caseTypeIdx).toBeGreaterThan(-1);
		expect(xpathIdx).toBeGreaterThan(caseTypeIdx);
		expect(blacklistedIdx).toBeGreaterThan(xpathIdx);
	});

	it("emits <query> with <title> + <prompt> elements per authored search inputs", () => {
		// The `<title>` references `case_search.{moduleId}.inputs`
		// (CCHQ's `case_search_title_translation` locale); each
		// search input emits a `<prompt key="...">` carrying the
		// input name.
		const doc = buildSearchBlueprint();
		const suite = compileSuiteXml(doc);
		expect(suite).toContain('<locale id="case_search.m0.inputs"/>');
		// Both inputs (simple + advanced) emit `<prompt>` elements;
		// the advanced arm contributes both a prompt AND a clause
		// inside `_xpath_query`.
		expect(suite).toContain('<prompt key="name_search"');
		expect(suite).toContain('<prompt key="status_search" exclude="true()">');
		// The simple name input is explicitly composed into `_xpath_query`
		// (`name_search !== case_name`), so its prompt blocks the one CSQL
		// value shape that cannot preserve both quote delimiters.
		expect(suite).toContain(
			'<locale id="search_property.m0.name_search.validation.0.text"/>',
		);
		// The advanced fixture predicate is literal-only and never consumes
		// `status_search`; `advanced` alone must not add a needless rule.
		expect(suite).not.toContain(
			'<locale id="search_property.m0.status_search.validation.0.text"/>',
		);
	});

	it("emits a <datum> referencing m{N}_search_short / m{N}_search_long detail ids", () => {
		// The `<datum>` inside `<remote-request>/<session>` references
		// the search-target detail ids — distinct from the case-list
		// entry's `detail-select="m{N}_case_short"`.
		const doc = buildSearchBlueprint();
		const suite = compileSuiteXml(doc);
		expect(suite).toContain('detail-confirm="m0_search_long"');
		expect(suite).toContain('detail-select="m0_search_short"');
		// CCHQ's `EXCLUDE_RELATED_CASES_FILTER` constant rides on
		// the datum nodeset.
		expect(suite).toContain("[not(commcare_is_related_case=true())]");
	});

	it("emits <stack> with a single rewind frame targeting the search_case_id session datum", () => {
		// `RemoteRequestFactory.build_stack`'s no-smart-link branch
		// emits one push frame containing one rewind value.
		const doc = buildSearchBlueprint();
		const suite = compileSuiteXml(doc);
		expect(suite).toContain(
			'<rewind value="instance(&apos;commcaresession&apos;)/session/data/search_case_id"/>',
		);
	});

	it("emits <action auto_launch> on m{N}_case_short with relevant set when searchButtonDisplayCondition is authored", () => {
		// CCHQ's `DetailContributor._get_relevant_expression` wires
		// the search-config display condition onto `<action relevant>`;
		// CCHQ's `AUTO_LAUNCH_EXPRESSIONS["single-select"]` carries
		// `auto_launch`. The case-target detail (m0_case_short) hosts
		// the action; the search-target detail (m0_search_short)
		// never carries an `<action>` child (the search results
		// screen IS the action's destination).
		const doc = buildSearchBlueprint();
		const suite = compileSuiteXml(doc);
		// The action mounts on `m0_case_short`. The fixture's filter
		// lands on `caseListConfig.filter`, which the platform
		// compiler treats as effective; combined with non-empty
		// `searchInputs`, the web fallback branch fires
		// (autoLaunch=false). The `relevant` attribute carries the
		// authored display condition compiled to on-device XPath.
		const caseShortIdx = suite.indexOf('<detail id="m0_case_short">');
		const caseShortEndIdx = suite.indexOf("</detail>", caseShortIdx);
		const caseShortBlock = suite.slice(caseShortIdx, caseShortEndIdx);
		expect(caseShortBlock).toContain("<action ");
		// Web fallback shape (`compileForPlatform` returns
		// `autoLaunch: false`) emits `auto_launch="false()"` per
		// `lib/commcare/suite/case-list/shortDetail.ts::emitSearchActionBlock`.
		expect(caseShortBlock).toContain('auto_launch="false()"');
		expect(caseShortBlock).toContain('redo_last="false"');
		// `relevant` carries the compiled on-device XPath of the
		// authored predicate (the session-user read compared to
		// 'supervisor' — the display condition is a global slot).
		expect(caseShortBlock).toMatch(
			/relevant="[^"]*session\/user\/data\/role[^"]*supervisor/,
		);
		// The search-target detail carries no `<action>` child.
		const searchShortIdx = suite.indexOf('<detail id="m0_search_short">');
		const searchShortEndIdx = suite.indexOf("</detail>", searchShortIdx);
		const searchShortBlock = suite.slice(searchShortIdx, searchShortEndIdx);
		expect(searchShortBlock).not.toContain("<action ");
	});

	it("registers the authored search command label and screen title in app_strings via locale ids", () => {
		// `case_search.{m}` ← search button label;
		// `case_search.{m}.inputs` ← search screen title. Both
		// register at suite-XML emission and serialize into the
		// per-language `app_strings.txt` file the runtime resolves.
		const doc = buildSearchBlueprint();
		const hqJson = expandDoc(doc);
		const ccz = compileCcz(hqJson, doc.appName, doc);
		const zip = new AdmZip(ccz);
		const stringsEntry = zip.getEntry("default/app_strings.txt");
		if (!stringsEntry) {
			throw new Error(
				"Compiled .ccz archive is missing the expected default/app_strings.txt entry. " +
					"Check that compileCcz threaded the per-language string table through the bundler.",
			);
		}
		const strings = stringsEntry.getData().toString("utf-8");
		expect(strings).toContain("case_search.m0=Search patients");
		expect(strings).toContain("case_search.m0.inputs=Find a patient");
	});

	it("emits the AND-composed _xpath_query carrying both the filter and the advanced-arm predicate", () => {
		// CCHQ's `<data key="_xpath_query">` accepts at most one
		// element per `<query>`. Multiple authored predicates
		// (filter + every advanced-arm predicate) AND-compose at the
		// AST level before the CSQL emitter walks the result.
		const doc = buildSearchBlueprint();
		const suite = compileSuiteXml(doc);
		const matches = suite.match(/<data key="_xpath_query"/g) ?? [];
		expect(matches.length).toBe(1);
		// Slice the `_xpath_query` element body so the assertions
		// below scope to the element's contents, not the full suite.
		// Other surfaces in the suite (`<post>` regions, other
		// `<query>` data slots) carry their own ` and ` tokens;
		// checking the suite-level XML would not pin the AND on
		// this element.
		const xpathOpenIdx = suite.indexOf('<data key="_xpath_query"');
		const xpathCloseIdx = suite.indexOf("/>", xpathOpenIdx);
		if (xpathOpenIdx === -1 || xpathCloseIdx === -1) {
			throw new Error(
				'Expected one self-closing `<data key="_xpath_query"/>` element ' +
					"in the compiled suite XML; check that searchSession's " +
					"composeXPathQueryEmission ran on this fixture.",
			);
		}
		const xpathBlock = suite.slice(xpathOpenIdx, xpathCloseIdx);
		// The two predicate fragments AND-compose via CSQL's ` and `
		// operator (space-padded) per
		// `lib/commcare/predicate/csqlEmitter.ts::emitLogicalSegments`.
		// XPath single-quote literals round-trip as `&apos;` inside
		// the double-quoted `ref` attribute value.
		expect(xpathBlock).toContain(" and ");
		expect(xpathBlock).toContain("region = &apos;North&apos;");
		expect(xpathBlock).toContain("status = &apos;active&apos;");
	});

	it("emits a same-property always-on filter and exact search input as cumulative query criteria", () => {
		// This is intentionally one property on both authoring surfaces:
		// the always-on rule narrows every request to Alice, while the
		// exact input lets the user narrow that already-filtered set. CCHQ
		// carries those criteria in separate, cumulative query slots: the
		// rule in `_xpath_query`, and the exact input as a bare prompt whose
		// key names the same case property.
		const doc = buildSearchBlueprint();
		const searchModule = doc.modules[MOD_UUID];
		if (searchModule?.caseListConfig === undefined) {
			throw new Error("Expected the search fixture module and its case list.");
		}
		const samePropertyDoc: BlueprintDoc = {
			...doc,
			modules: {
				...doc.modules,
				[MOD_UUID]: {
					...searchModule,
					caseListConfig: {
						...searchModule.caseListConfig,
						filter: eq(prop("patient", "case_name"), literal("Alice")),
						searchInputs: [
							simpleSearchInputDef(
								SI_NAME_UUID,
								"case_name",
								"Search by name",
								"text",
								"case_name",
							),
						],
					},
				},
			},
		};

		// The shared fixture deliberately carries an unrelated legacy
		// form-level `status` property. Scope this assertion to the module
		// whose case-search configuration is under test.
		expect(
			runValidation(samePropertyDoc, LOOKUP_CONTEXT_UNAVAILABLE).filter(
				(finding) => finding.scope === "module",
			),
		).toEqual([]);
		const suite = compileSuiteXml(samePropertyDoc);
		const queryOpenIdx = suite.indexOf("<query ");
		const queryCloseIdx = suite.indexOf("</query>", queryOpenIdx);
		if (queryOpenIdx === -1 || queryCloseIdx === -1) {
			throw new Error("Expected the compiled suite to contain a search query.");
		}
		const queryBlock = suite.slice(queryOpenIdx, queryCloseIdx);

		expect(queryBlock).toContain(
			'<data key="_xpath_query" ref="concat(&quot;case_name = &apos;Alice&apos;&quot;)"/>',
		);
		expect(queryBlock).toContain('<prompt key="case_name">');
		// Exact self-property prompts are the native CCHQ auto-match
		// route. They must remain active alongside `_xpath_query` rather
		// than being excluded as an explicitly-derived predicate would be.
		expect(queryBlock).not.toContain('<prompt key="case_name" exclude=');
	});

	it("emits <description> + the case_search.m{N}.description app-strings entry when searchScreenSubtitle is authored", () => {
		// CCHQ's `RemoteRequestFactory.build_remote_request_queries`
		// mounts `<description>` on `<query>` only when
		// `module.search_config.description != {}`. Nova mirrors that
		// gate: a non-empty `searchScreenSubtitle` populates the
		// description locale and emits the element; an absent or
		// empty-string subtitle elides it entirely. Composition pin —
		// per-element shape coverage lives in
		// `searchSession.test.ts`.
		const doc = buildSearchBlueprint();
		const subtitled: BlueprintDoc = {
			...doc,
			modules: {
				...doc.modules,
				[MOD_UUID]: {
					...doc.modules[MOD_UUID],
					caseSearchConfig: {
						...doc.modules[MOD_UUID].caseSearchConfig,
						searchScreenSubtitle: "Search by **name** or village.",
					},
				},
			},
		};

		const hqJson = expandDoc(subtitled);
		const ccz = compileCcz(hqJson, subtitled.appName, subtitled);
		const zip = new AdmZip(ccz);
		const suiteEntry = zip.getEntry("suite.xml");
		if (!suiteEntry) {
			throw new Error(
				"Compiled .ccz archive is missing the expected suite.xml entry. " +
					"Check that compileCcz ran to completion and that the input " +
					"BlueprintDoc was well-formed.",
			);
		}
		const suite = suiteEntry.getData().toString("utf-8");

		// `<description>` references the description locale id, and
		// sits between `<title>` and the `<data>` slot list per CCHQ's
		// `RemoteRequestQuery` child order. Scope the ordering check to
		// the `<query>` element so other suite surfaces (detail blocks,
		// case-list action chrome) can't false-positive a misplaced
		// description by carrying their own `<data>` children.
		expect(suite).toContain('<locale id="case_search.m0.description"/>');
		const queryOpenIdx = suite.indexOf("<query ");
		const queryCloseIdx = suite.indexOf("</query>", queryOpenIdx);
		expect(queryOpenIdx).toBeGreaterThan(-1);
		expect(queryCloseIdx).toBeGreaterThan(queryOpenIdx);
		const queryBlock = suite.slice(queryOpenIdx, queryCloseIdx);
		const titleCloseIdx = queryBlock.indexOf("</title>");
		const descriptionOpenIdx = queryBlock.indexOf(
			"<description>",
			titleCloseIdx,
		);
		const firstDataIdx = queryBlock.indexOf("<data ", titleCloseIdx);
		expect(titleCloseIdx).toBeGreaterThan(-1);
		expect(descriptionOpenIdx).toBeGreaterThan(titleCloseIdx);
		expect(firstDataIdx).toBeGreaterThan(descriptionOpenIdx);

		// App-strings entry registers the authored subtitle under the
		// matching locale id, so the runtime resolves the locale to the
		// author's copy rather than the raw id.
		const stringsEntry = zip.getEntry("default/app_strings.txt");
		if (!stringsEntry) {
			throw new Error(
				"Compiled .ccz archive is missing the expected default/app_strings.txt entry. " +
					"Check that compileCcz threaded the per-language string table through the bundler.",
			);
		}
		const strings = stringsEntry.getData().toString("utf-8");
		expect(strings).toContain(
			"case_search.m0.description=Search by **name** or village.",
		);
	});

	it("omits <description> entirely when no subtitle is authored", () => {
		// Mirrors CCHQ's `description != {}` gate — the baseline
		// fixture authors no subtitle, so neither the element nor its
		// app-strings entry should appear in the compiled suite. Keeps
		// the runtime from rendering a blank locale fallback for the
		// unset slot. Scoped to the `<query>` element so the assertion
		// stays robust against future suite surfaces that legitimately
		// emit `<description>` elsewhere (no such surface exists today,
		// but the scope hardening is free).
		const doc = buildSearchBlueprint();
		const suite = compileSuiteXml(doc);
		const queryOpenIdx = suite.indexOf("<query ");
		const queryCloseIdx = suite.indexOf("</query>", queryOpenIdx);
		expect(queryOpenIdx).toBeGreaterThan(-1);
		expect(queryCloseIdx).toBeGreaterThan(queryOpenIdx);
		const queryBlock = suite.slice(queryOpenIdx, queryCloseIdx);
		expect(queryBlock).not.toContain("<description>");
		expect(suite).not.toContain("case_search.m0.description");
	});
});

// ============================================================
// 5. Platform decision tree
// ============================================================
//
// `compileForPlatform` is a pure function from `(content, platform)`
// to a `WireShape` flag set. The per-branch fine-grained tests live
// in `compileForPlatform.test.ts`; this layer pins the integration
// contract — the same realistic blueprint produces different shapes
// per platform per the decision tree's branch table.

describe("case-search integration — platform decision tree", () => {
	it("returns the web fallback shape (list-first) on Web for the realistic blueprint", () => {
		// Web + (filter set + non-empty searchInputs) → list-first.
		// The fixture's filter is set, but searchInputs has two
		// entries — skip-to-results requires the simpler
		// "filter set + zero inputs" shape.
		const doc = buildSearchBlueprint();
		const mod = doc.modules[MOD_UUID];
		const config = mod.caseListConfig;
		if (!config) throw new Error("expected caseListConfig");
		const searchConfig = mod.caseSearchConfig;
		if (!searchConfig) throw new Error("expected caseSearchConfig");
		const wire = compileForPlatform(config, searchConfig, { platform: "web" });
		expect(wire).toEqual({
			autoLaunch: false,
			defaultSearch: false,
			inlineSearch: false,
		});
	});

	it("returns the list-first shape (every flag false) on Android regardless of authored content", () => {
		// Android always picks the standard list-first shape — CCHQ's
		// `module_uses_inline_search` requires `auto_launch: true`
		// alongside `inline_search: true`, so the only structurally
		// sound Android emission is the all-flags-false default.
		const doc = buildSearchBlueprint();
		const mod = doc.modules[MOD_UUID];
		const config = mod.caseListConfig;
		if (!config) throw new Error("expected caseListConfig");
		const searchConfig = mod.caseSearchConfig;
		if (!searchConfig) throw new Error("expected caseSearchConfig");
		const wire = compileForPlatform(config, searchConfig, {
			platform: "android",
		});
		expect(wire).toEqual({
			autoLaunch: false,
			defaultSearch: false,
			inlineSearch: false,
		});
	});

	it("returns the skip-to-results shape on Web when filter is set and searchInputs is empty", () => {
		// The third branch — author intent unambiguous: filter
		// narrows the case list and there is nothing to type. The
		// runtime executes the search immediately on screen entry.
		const config = {
			columns: [],
			filter: eq(prop("patient", "active"), literal("yes")),
			searchInputs: [],
		};
		const searchConfig = {};
		const wire = compileForPlatform(config, searchConfig, {
			platform: "web",
		});
		expect(wire).toEqual({
			autoLaunch: true,
			defaultSearch: true,
			inlineSearch: false,
		});
	});
});

// ============================================================
// 6. HQ JSON projection — the production export pathway
// ============================================================
//
// `expandDoc` produces the HQ JSON CCHQ ingests at `/api/import_app/`;
// the suite.xml regenerates from that JSON on every runtime sync.
// The suite-XML assertions above only catch wire-form drift on the
// `.ccz` packaging path. This section pins the HQ JSON projection
// directly — drift on the production export pathway lights up here
// without the `.ccz` round-trip in between.
//
// One realistic blueprint feeds `expandDoc`; structural assertions on
// `modules[0].search_config` + `modules[0].case_details` pin every
// case-search authoring slot lands at its CCHQ wire field.

describe("case-search integration — expandDoc HQ JSON projection", () => {
	it("projects display chrome to title_label, search_button_label, and search_button_display_condition", () => {
		const doc = buildSearchBlueprint();
		const searchConfig = expandDoc(doc).modules[0].search_config;
		expect(searchConfig.title_label).toEqual({ en: "Find a patient" });
		expect(searchConfig.search_button_label).toEqual({
			en: "Search patients",
		});
		// `searchButtonDisplayCondition: eq(sessionUser("role"), literal("supervisor"))`
		// compiles to the on-device session-user read — the slot resolves
		// before any case is selected, so the fixture's condition is a
		// global (session-value) comparison.
		expect(searchConfig.search_button_display_condition).toBe(
			"instance('commcaresession')/session/user/data/role = 'supervisor'",
		);
	});

	it("projects excludedOwnerIds to blacklisted_owner_ids_expression", () => {
		const doc = buildSearchBlueprint();
		const searchConfig = expandDoc(doc).modules[0].search_config;
		// `excludedOwnerIds: toValueExpression(literal("excluded-owner-id"))`
		// lowers to the shared normalized on-device value.
		expect(searchConfig.blacklisted_owner_ids_expression).toBe(
			"normalize-space('excluded-owner-id')",
		);
	});

	it("projects both search-input arms to search_config.properties with advanced auto-match suppression", () => {
		const doc = buildSearchBlueprint();
		const properties = expandDoc(doc).modules[0].search_config.properties;
		// CCHQ only creates prompt bindings from `properties`, so the
		// advanced row must remain present as well as contributing its
		// predicate to `_xpath_query`. `exclude` keeps Core from also
		// treating its prompt key as an implicit case-property query.
		expect(properties).toHaveLength(2);
		expect(properties[0].name).toBe("name_search");
		expect(properties[0].label).toEqual({ en: "Search by name" });
		// `name_search !== case_name`, so this simple input also rides on
		// `_xpath_query` and suppresses Core's wrong-key auto-match.
		expect(properties[0].exclude).toBe(true);
		expect(properties[0].validations).toEqual([
			{
				test: `not(count(instance('search-input:results')/input/field[@name='name_search']) and (contains(instance('search-input:results')/input/field[@name='name_search'], "'") and contains(instance('search-input:results')/input/field[@name='name_search'], '"')))`,
				text: {
					en: "This search can't use both single and double quotation marks. Remove one kind and try again",
				},
			},
		]);
		expect(properties[1]).toEqual(
			expect.objectContaining({
				name: "status_search",
				label: { en: "Status" },
				exclude: true,
			}),
		);
		expect(properties[1].validations).toBeUndefined();
	});

	it("keeps filter-derived prompt validation identical in suite XML and HQ JSON", () => {
		const base = buildSearchBlueprint();
		const module = base.modules[MOD_UUID];
		if (module?.caseListConfig === undefined) {
			throw new Error("search fixture must carry a case-list config");
		}
		const doc: BlueprintDoc = {
			...base,
			modules: {
				...base.modules,
				[MOD_UUID]: {
					...module,
					caseListConfig: {
						...module.caseListConfig,
						filter: whenInput(
							input("status_search"),
							eq(prop("patient", "region"), input("status_search")),
						),
					},
				},
			},
		};

		const statusProperty = expandDoc(
			doc,
		).modules[0].search_config.properties.find(
			(property) => property.name === "status_search",
		);
		expect(statusProperty?.validations).toHaveLength(1);
		const hqValidation = statusProperty?.validations?.[0];
		expect(hqValidation?.test).toContain("@name='status_search'");

		const suite = compileSuiteXml(doc);
		const promptStart = suite.indexOf('<prompt key="status_search"');
		const promptEnd = suite.indexOf("</prompt>", promptStart);
		const promptXml = suite.slice(promptStart, promptEnd);
		expect(promptStart).toBeGreaterThan(-1);
		expect(promptEnd).toBeGreaterThan(promptStart);
		expect(promptXml.match(/<validation /g)).toHaveLength(1);
		expect(promptXml).toContain(
			'<locale id="search_property.m0.status_search.validation.0.text"/>',
		);
		const suiteValidation = promptXml.match(/<validation test="([^"]+)">/);
		expect(suiteValidation).not.toBeNull();
		expect(decodeXML(suiteValidation?.[1] ?? "")).toBe(hqValidation?.test);
	});

	it("AND-composes the filter + advanced-arm predicate into _xpath_query on default_properties", () => {
		const doc = buildSearchBlueprint();
		const defaults = expandDoc(doc).modules[0].search_config.default_properties;
		const xpathEntry = defaults.find((d) => d.property === "_xpath_query");
		expect(xpathEntry).toBeDefined();
		// Both authored predicate fragments survive the AST-level AND
		// composition and land in the same `concat(...)` runtime
		// expression.
		expect(xpathEntry?.defaultValue).toMatch(/concat\(/);
		expect(xpathEntry?.defaultValue).toContain("region");
		expect(xpathEntry?.defaultValue).toContain("status");
		expect(xpathEntry?.defaultValue).toContain(" and ");
	});

	it("combines case-list and owner availability rules in case_details.short.filter", () => {
		// CCHQ's `case_list_filter` getter reads through to
		// `case_details.short.filter`; the wire form is the bare
		// on-device XPath (CCHQ wraps it as `[...]` at suite-XML
		// emission time).
		const doc = buildSearchBlueprint();
		const filter = expandDoc(doc).modules[0].case_details.short.filter;
		expect(filter).toBe(
			"(region = 'North') and (normalize-space('excluded-owner-id') = '' or not(selected(normalize-space('excluded-owner-id'), @owner_id)))",
		);
	});

	it("projects authored column kinds to their matching CCHQ format token", () => {
		// The fixture's `caseListConfig.columns` carries two plain
		// columns; both should project to `format: "plain"` on the
		// HQ JSON side. A regression here surfaces the silent-drop
		// failure mode (a column reaching the wire as `format: "plain"`
		// when the author picked a different kind) directly.
		const doc = buildSearchBlueprint();
		const shortCols = expandDoc(doc).modules[0].case_details.short.columns;
		expect(shortCols).toHaveLength(2);
		expect(shortCols[0].format).toBe("plain");
		expect(shortCols[0].field).toBe("case_name");
		expect(shortCols[1].format).toBe("plain");
		expect(shortCols[1].field).toBe("region");
	});
});
