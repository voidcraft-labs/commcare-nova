// __tests__/integration/case-list-authoring.test.ts
//
// End-to-end coverage for the case-list authoring surface. The
// test exercises every shipped layer in the order an authoring
// run touches them:
//
//   1. Schema parse — feed a fully-populated `CaseListConfig`
//      literal through the live `caseListConfigSchema`. A drift
//      between the test fixture and the schema surfaces here as a
//      Zod parse failure, NOT as a downstream "the validator
//      doesn't catch it" silence.
//   2. Validator (`runValidation`) on the assembled blueprint.
//      The well-formed arm asserts a clean run; the broken-variant
//      arm flips a single column reference to a non-existent
//      property and pins the matching error code.
//   3. Wire emission — `emitShortDetail` / `emitLongDetail` /
//      `emitNodesetFilter` produce the suite-XML / XPath strings
//      the per-surface goldens already cover at the unit level.
//      Here we assert the full pipeline (`expandDoc → compileCcz`)
//      packages a well-formed archive and that the per-emitter
//      structural fingerprints land in `suite.xml`.
//   4. Preview rendering — `PostgresCaseStore.queryWithCalculated`
//      against a per-test Postgres testcontainer. Insert fixture
//      rows, run the case list (filter + sort + calculated column)
//      end-to-end, and assert the rendered shape matches the
//      authored config's intent. `PostgresCaseStore` is the live
//      runtime; no in-memory parity layer exists.
//
// The fixture covers four of the seven `ColumnKind` arms (plain,
// date, time-since-until, id-mapping), a real `eq` predicate
// against the standard `status` property, multi-key sort with
// mixed direction + type, a calculated column referencing the
// case-property age plus a literal, a search input on a text
// property, and `detailColumns` distinct from `columns` so the
// long-detail override path is exercised. A second case-typed
// module without `caseListConfig` proves the emitter handles
// absence gracefully and the well-formed validator stays clean
// across the multi-module shape.
//
// Per-test database lifecycle: each `it(...)` runs against a fresh
// Postgres database via `setupPerTestDatabase`. Atlas applies the
// shipped migrations at the top of every test so the schema rows
// (`case_type_schemas`, `cases`, `case_indices`) are present
// before the harness seeds them. The container itself boots once
// per `vitest run` per the project's `globalSetup.ts` contract.

import AdmZip from "adm-zip";
import type { Kysely } from "kysely";
import { beforeEach, describe, expect, it } from "vitest";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { PostgresCaseStore } from "@/lib/case-store/postgres/store";
import { HeuristicCaseGenerator } from "@/lib/case-store/sample/heuristic";
import { applyMigrationsViaAtlas } from "@/lib/case-store/sql/__tests__/applyMigrationsViaAtlas";
import { setupPerTestDatabase } from "@/lib/case-store/sql/__tests__/perTestDatabase";
import type { Database } from "@/lib/case-store/sql/database";
import { compileCcz } from "@/lib/commcare/compiler";
import { expandDoc } from "@/lib/commcare/expander";
import { emitLongDetail } from "@/lib/commcare/suite/case-list/longDetail";
import { emitNodesetFilter } from "@/lib/commcare/suite/case-list/nodesetFilter";
import { emitShortDetail } from "@/lib/commcare/suite/case-list/shortDetail";
import { runValidation } from "@/lib/commcare/validator/runner";
import {
	type CaseListConfig,
	calculatedColumn,
	caseListConfigSchema,
	dateColumn,
	idMappingColumn,
	idMappingEntry,
	plainColumn,
	propertySortSource,
	rangeMode,
	searchInputDef,
	sortKey,
	timeSinceUntilColumn,
} from "@/lib/domain";
import {
	arith,
	eq,
	literal,
	prop,
	term,
} from "@/lib/domain/predicate/builders";

// ── Per-test database harness ────────────────────────────────────
//
// One per-test database per case + atlas migrations applied in a
// sibling `beforeEach`. Mirrors the saga integration test's shape;
// the per-test database is required because `applySchemaChange` /
// `insert` open inner transactions Kysely lowers to literal `BEGIN`
// statements. Postgres rejects nested BEGIN inside the harness's
// shared-database BEGIN/ROLLBACK fixture.

const dbHandle = setupPerTestDatabase({
	databaseNamePrefix: "case_list_int_",
});

beforeEach(() => {
	applyMigrationsViaAtlas(dbHandle.uri, { stdio: "pipe" });
});

// ── Fixture identifiers ──────────────────────────────────────────
//
// Fixed app id + owner id keep the test bodies short and the SQL
// traces readable when a failure surfaces. Fixed case ids let us
// pin exact insertion order against returned-row assertions
// regardless of UUID v7's internal timestamp prefix.

const APP_ID = "case-list-authoring-int";
const OWNER_ID = "owner-int";
const PATIENT_ALICE_ID = "30000000-0000-0000-0000-000000000001";
const PATIENT_BOB_ID = "30000000-0000-0000-0000-000000000002";
const PATIENT_CAROL_ID = "30000000-0000-0000-0000-000000000003";

// Region id-mapping table — re-used in three sites: the column
// definition, the emitted XML's `selected(...)` chain, and the
// inserted rows' `region` values. Centralizing it keeps the three
// surfaces in lockstep and structurally rejects the "test data
// drifts past the column's mapping table" failure mode.
const REGION_MAPPING = [
	idMappingEntry("N", "North"),
	idMappingEntry("S", "South"),
] as const;

/**
 * Construct the well-formed case-list configuration. Single source
 * of truth for the fixture's shape — the schema-parse arm, the
 * validator arms, the wire-emission arms, and the preview-render
 * arms all consume this same literal so a regression in any layer
 * surfaces against one canonical shape rather than four
 * independent hand-rolled mocks.
 *
 * Coverage rationale:
 *   - `plain` covers the bare `<xpath function="case_name"/>` shape
 *     (twice — `case_name` and `age` — so the multi-key sort can
 *     attach `<sort>` blocks to both targets per the wire layer's
 *     "sort attaches to a column whose `field` matches" contract).
 *   - `date` covers the format-date wrap used by the runtime
 *     formatter.
 *   - `time-since-until` covers the divisor + threshold branch
 *     CCHQ's `detail_screen.py::TimeAgo` emits.
 *   - `id-mapping` covers the `selected()` chain wrapped in
 *     `replace(join(' ', ...), '\\s+', ' ')`.
 *   - The standard `status` property powers a real `eq(...)`
 *     filter (not match-all — the predicate path actually
 *     compiles + runs against the Postgres backend).
 *   - The `age` property powers a calculated column (`age + 1`),
 *     a primary integer-typed sort key, and a plain column so the
 *     primary sort emits inline against it.
 *   - `name` powers a real text-typed search-input declaration so
 *     the search-input section has a non-empty cell to render.
 *   - `detailColumns` differs from `columns` (replaces the `age`
 *     plain column with the standard `last_modified` datetime
 *     column) so the long-detail's "override present" branch in
 *     `emitLongDetail` is exercised against a non-trivial shape.
 */
function buildWellFormedCaseListConfig(): CaseListConfig {
	return {
		columns: [
			plainColumn("case_name", "Patient"),
			dateColumn("date_opened", "Opened", "%Y-%m-%d"),
			timeSinceUntilColumn(
				"last_visit",
				"Weeks since visit",
				2,
				"weeks",
				"Overdue",
			),
			idMappingColumn("region", "Region", REGION_MAPPING),
			plainColumn("age", "Age"),
		],
		// Filter: only show open cases. `status` is a CommCare
		// standard property (text-typed via
		// `STANDARD_CASE_LIST_PROPERTY_DATA_TYPES.status`), so the
		// type checker resolves the property reference without a
		// declared `caseTypes[].properties[]` entry — exercising the
		// shared 3-arm admission set the validator's
		// `filterTypeCheck` rule routes through.
		filter: eq(prop("patient", "status"), literal("open")),
		// Multi-key sort. Primary key targets the `age` column
		// (descending integer); secondary tiebreaker targets the
		// `case_name` column (ascending plain). Both sort keys
		// reference columns present in `columns` above so the
		// `<sort>` blocks attach inline to those columns' `<field>`
		// elements per the wire layer's column-targeted attachment
		// contract.
		sort: [
			sortKey(propertySortSource("age"), "integer", "desc"),
			sortKey(propertySortSource("case_name"), "plain", "asc"),
		],
		// Calculated column referencing the case type's
		// `data_type: "int"` property. The expression flows through
		// the typed expression compiler verbatim; the
		// preview-render arm exercises the end-to-end pipeline.
		calculatedColumns: [
			calculatedColumn(
				"age_next_year",
				"Age next year",
				arith(
					"+",
					term(prop("patient", "age")),
					term({ kind: "literal", value: 1, data_type: "int" }),
				),
			),
		],
		searchInputs: [
			searchInputDef("patient_name", "Patient name", "text", {
				property: "name",
			}),
			// Range mode on a numeric property — the search-input
			// applicability tables admit `(text-input, int-property,
			// range-mode)` because the `int` data type sits inside
			// `SEARCH_MODE_PROPERTY_TYPES["range"]`. The validator's
			// per-input mode-vs-property-type rule clears this
			// configuration on its pass-through path.
			searchInputDef("age_range", "Age range", "text", {
				property: "age",
				mode: rangeMode(),
			}),
		],
		// Long-detail override: replaces the `age` plain column
		// with the standard `last_modified` datetime column. The
		// long detail's rendered shape is `[plain, date,
		// time-since-until, id-mapping, last-modified date]` —
		// exercising the override path AND the cross-kind
		// composition. `last_modified` resolves through the 3-arm
		// admission set's standard-property branch (typed
		// `datetime` via
		// `STANDARD_CASE_LIST_PROPERTY_DATA_TYPES.last_modified`).
		detailColumns: [
			plainColumn("case_name", "Patient"),
			dateColumn("date_opened", "Opened", "%Y-%m-%d"),
			timeSinceUntilColumn(
				"last_visit",
				"Weeks since visit",
				2,
				"weeks",
				"Overdue",
			),
			idMappingColumn("region", "Region", REGION_MAPPING),
			dateColumn("last_modified", "Modified", "%Y-%m-%d"),
		],
	};
}

/**
 * Build a `BlueprintDoc` carrying the case-list-authoring fixture.
 *
 * Two case-typed modules: `Patients` carries the well-formed
 * `caseListConfig` from `buildWellFormedCaseListConfig()`;
 * `Households` carries no `caseListConfig` and serves as the
 * "absence" arm — the emitter must produce a minimal title-only
 * `<detail>` shell for it without throwing.
 *
 * The `patient` case type declares `name` (text), `age` (int),
 * `region` (text), `last_visit` (date). Combined with the
 * standard properties (`case_name`, `status`, `date_opened`,
 * `modified_on`, ...) the augmented admission set covers every
 * property the well-formed config references — `columnReferences`
 * + `filterTypeCheck` + `sortTypeCheck` +
 * `calculatedColumnTypeCheck` + `searchInputModeMatchesPropertyType`
 * all stay clean.
 */
function buildFixtureDoc() {
	return buildDoc({
		appId: APP_ID,
		appName: "Case List Authoring Integration",
		modules: [
			{
				name: "Patients",
				caseType: "patient",
				caseListConfig: buildWellFormedCaseListConfig(),
				forms: [
					{
						name: "Register",
						type: "registration",
						fields: [
							f({
								kind: "text",
								id: "case_name",
								label: "Patient name",
								case_property_on: "patient",
							}),
							f({
								kind: "text",
								id: "name",
								label: "Full name",
								case_property_on: "patient",
							}),
							f({
								kind: "int",
								id: "age",
								label: "Age",
								case_property_on: "patient",
							}),
							f({
								kind: "text",
								id: "region",
								label: "Region",
								case_property_on: "patient",
							}),
							f({
								kind: "date",
								id: "last_visit",
								label: "Last visit",
								case_property_on: "patient",
							}),
						],
					},
					{
						// Followup form — case-loading. Drives the entry's
						// case-load datum which threads `caseListConfig.filter`
						// through `emitNodesetFilter` into the `<nodeset>`
						// attribute. Registration forms create cases (no
						// load), so without a followup the suite XML carries
						// no `@case_type='patient'` predicate at all and the
						// filter fragment never lands on the wire.
						name: "Visit",
						type: "followup",
						fields: [f({ kind: "text", id: "notes", label: "Notes" })],
					},
				],
			},
			{
				// Case-typed module without `caseListConfig` — the
				// "absence" arm. The emitter must produce a minimal
				// title-only `<detail>` shell. The form is
				// `registration` (not survey) so the expander's
				// `hasCases` predicate returns true and the compiler
				// emits the detail block; survey-only modules are
				// gated out of detail emission at the expander layer
				// (per `expander.ts::hasCases`).
				name: "Households",
				caseType: "household",
				forms: [
					{
						name: "Register household",
						type: "registration",
						fields: [
							f({
								kind: "text",
								id: "case_name",
								label: "Household name",
								case_property_on: "household",
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
					{ name: "name", label: "Name", data_type: "text" },
					{ name: "age", label: "Age", data_type: "int" },
					{ name: "region", label: "Region", data_type: "text" },
					{ name: "last_visit", label: "Last visit", data_type: "date" },
				],
			},
			{
				name: "household",
				properties: [{ name: "name", label: "Name", data_type: "text" }],
			},
		],
	});
}

/**
 * Construct a `PostgresCaseStore` bound to the harness's per-test
 * database handle. The store reads the handle through Kysely's
 * type slot; the cast-through-`unknown` mirrors the saga
 * integration test's pattern (the per-test handle is typed
 * `Kysely<unknown>` since it composes with arbitrary downstream
 * schemas, while `PostgresCaseStore` requires the case-store-
 * specific `Database` type contract).
 */
function buildStore(): PostgresCaseStore {
	return new PostgresCaseStore({
		ownerId: OWNER_ID,
		db: dbHandle.db as unknown as Kysely<Database>,
		sampleGenerator: new HeuristicCaseGenerator(),
	});
}

// ── 1. Schema parse ──────────────────────────────────────────────

describe("schema parse", () => {
	it("accepts the well-formed case-list configuration through caseListConfigSchema", () => {
		// The fixture must round-trip through the live schema before
		// downstream layers consume it. Routing the fixture through
		// `caseListConfigSchema.parse` (vs hand-rolling a parsed
		// shape) is the structural defense against tautological
		// mocks: a schema arm that drifts from the test fixture
		// surfaces here as a parse failure, not as a silent
		// downstream mismatch.
		const config = buildWellFormedCaseListConfig();
		const parsed = caseListConfigSchema.parse(config);
		expect(parsed).toEqual(config);
	});
});

// ── 2. Validator ─────────────────────────────────────────────────

describe("validator (runValidation)", () => {
	it("emits no case-list errors on the well-formed blueprint", () => {
		const doc = buildFixtureDoc();
		const errors = runValidation(doc);
		// Every case-list rule emits a code with the `CASE_LIST_`
		// prefix; the field-kind-vs-property-type rule emits
		// `FIELD_KIND_PROPERTY_TYPE_MISMATCH`. Filter on those
		// prefixes so unrelated rules (XPath syntax, cycle
		// detection) don't pollute the assertion — they are NOT in
		// scope for this integration arm.
		const caseListErrors = errors.filter(
			(e) =>
				e.code.startsWith("CASE_LIST_") ||
				e.code === "FIELD_KIND_PROPERTY_TYPE_MISMATCH",
		);
		expect(caseListErrors).toEqual([]);
	});

	it("flags an unknown column reference with CASE_LIST_COLUMN_UNKNOWN_FIELD", () => {
		// Surgically corrupt the well-formed shape: replace the
		// last column (the id-mapping cell) with a column whose
		// `field` references a property no writer creates and no
		// case-type declares. Every other rule still resolves
		// cleanly, so the emitted error code is a precise pin —
		// not a false positive from an unrelated drift.
		const doc = buildFixtureDoc();
		const moduleUuid = doc.moduleOrder[0];
		const mod = doc.modules[moduleUuid];
		if (!mod.caseListConfig) {
			throw new Error("fixture module missing caseListConfig");
		}
		const corruptedColumns = [
			...mod.caseListConfig.columns.slice(0, -1),
			plainColumn("ghost_property", "Ghost"),
		];
		mod.caseListConfig = {
			...mod.caseListConfig,
			columns: corruptedColumns,
		};

		const errors = runValidation(doc);
		expect(
			errors.some(
				(e) =>
					e.code === "CASE_LIST_COLUMN_UNKNOWN_FIELD" &&
					e.message.includes("ghost_property"),
			),
		).toBe(true);
	});
});

// ── 3. Wire emission ─────────────────────────────────────────────

describe("wire emission", () => {
	it("emits a populated short detail for the case-typed module", () => {
		const doc = buildFixtureDoc();
		const moduleUuid = doc.moduleOrder[0];
		const mod = doc.modules[moduleUuid];
		const result = emitShortDetail({ module: mod, moduleIndex: 0 });

		// Per-kind structural fingerprints — pulled from the unit-
		// goldens at `lib/commcare/suite/case-list/__tests__/`. The
		// integration arm asserts the orchestrator wires the per-
		// kind shapes together; the unit goldens own the per-kind
		// fingerprint detail.
		expect(result.xml).toContain('<detail id="m0_case_short">');
		expect(result.xml).toContain('<locale id="cchq.case"/>');
		// Plain — bare property reference.
		expect(result.xml).toContain('<xpath function="case_name"/>');
		// Date — empty-string-guard wrapped in format-date.
		expect(result.xml).toContain(
			"if(date_opened = '', '', format-date(date(date_opened), '%Y-%m-%d'))",
		);
		// Time-since-until — divisor 7 (weeks → days) + overdue
		// branch text.
		expect(result.xml).toContain("(today() - date(last_visit)) div 7");
		expect(result.xml).toContain("'Overdue'");
		// Id-mapping — selected() chain wrapped in replace(join(...)).
		expect(result.xml).toContain(
			"replace(join(' ', if(selected(region, 'N'), 'North', ''), if(selected(region, 'S'), 'South', '')), '\\s+', ' ')",
		);
		// Calculated column — inline-variable template shape.
		expect(result.xml).toContain('<variable name="calculated_property">');
		// Multi-key sort — `order=1` on the integer-typed primary
		// key, `order=2` on the plain-typed secondary tiebreaker.
		expect(result.xml).toMatch(
			/<sort type="int" order="1" direction="descending">[\s\S]*?<xpath function="age"\/>/,
		);
		expect(result.xml).toMatch(
			/<sort type="string" order="2" direction="ascending">[\s\S]*?<xpath function="case_name"\/>/,
		);
	});

	it("emits a long detail honoring the detailColumns override", () => {
		const doc = buildFixtureDoc();
		const moduleUuid = doc.moduleOrder[0];
		const mod = doc.modules[moduleUuid];
		const result = emitLongDetail({ module: mod, moduleIndex: 0 });

		// The override replaces the short detail's `age` column
		// with a `last_modified` date-formatted column; both surfaces
		// share the leading four columns. A containment check pins
		// that the override branch fired (`columns` doesn't reference
		// `last_modified`).
		expect(result.xml).toContain('<detail id="m0_case_long">');
		expect(result.xml).toContain(
			"if(last_modified = '', '', format-date(date(last_modified), '%Y-%m-%d'))",
		);
		// Long detail must NOT carry `<sort>` blocks per
		// CCHQ's `detail_screen.py::FormattedDetailColumn.sort_node`
		// short-circuit — sort lives on the short detail only.
		expect(result.xml).not.toContain("<sort");
	});

	it("emits a title-only short detail for the module without caseListConfig", () => {
		const doc = buildFixtureDoc();
		// Module index 1 is `Households` — case-typed with no
		// `caseListConfig`. The emitter must return a minimal
		// title-only shell.
		const moduleUuid = doc.moduleOrder[1];
		const mod = doc.modules[moduleUuid];
		const result = emitShortDetail({ module: mod, moduleIndex: 1 });
		expect(result.xml).toContain('<detail id="m1_case_short">');
		expect(result.xml).not.toContain("<field>");
		expect(result.strings).toEqual({});
	});

	it("emits a bracketed nodeset filter fragment for the case-list filter", () => {
		const config = buildWellFormedCaseListConfig();
		// `emitNodesetFilter` wraps the compiled XPath in `[...]` so
		// it appends after the canonical `[@case_type='X']
		// [@status='open']` predicates at the session-datum nodeset.
		// The fixture's `eq(prop("patient", "status"),
		// literal("open"))` collapses through the on-device emitter
		// into `@status = 'open'` — `status` is in
		// `RESERVED_CASE_ATTRIBUTES` and picks up the `@` prefix at
		// the leaf.
		const fragment = emitNodesetFilter(config.filter);
		expect(fragment.startsWith("[")).toBe(true);
		expect(fragment.endsWith("]")).toBe(true);
		expect(fragment).toContain("@status = 'open'");
	});

	it("packages a well-formed .ccz archive end-to-end via compileCcz", () => {
		// The full pipeline shape: `expandDoc` materializes the HQ
		// JSON projection; `compileCcz` walks the doc + the JSON in
		// lockstep and zips the result. The archive must contain
		// the canonical files AND the case-list-config emitter's
		// fingerprints inside `suite.xml`.
		const doc = buildFixtureDoc();
		const hq = expandDoc(doc);
		const buffer = compileCcz(hq, doc.appName, doc);
		expect(buffer.length).toBeGreaterThan(0);

		const zip = new AdmZip(buffer);
		const entryNames = zip.getEntries().map((e) => e.entryName);
		expect(entryNames).toContain("suite.xml");
		expect(entryNames).toContain("profile.ccpr");
		expect(entryNames).toContain("default/app_strings.txt");

		const suite = zip.readAsText("suite.xml");
		// Both case-typed modules emit short + long details. The
		// case-typed module without `caseListConfig` (Households at
		// `m1`) still emits the title-only shells.
		expect(suite).toContain('<detail id="m0_case_short">');
		expect(suite).toContain('<detail id="m0_case_long">');
		expect(suite).toContain('<detail id="m1_case_short">');
		// The followup form's case-loading datum carries the
		// canonical `@case_type=...][@status='open']` predicate
		// chain plus the `caseListConfig.filter` fragment appended
		// at the trailing position. This pins the full pipeline:
		// the filter walked from the schema's `Predicate` slot,
		// through the on-device emitter, into the bracketed
		// fragment, and onto the suite's session datum nodeset.
		expect(suite).toContain("@case_type='patient'");
		// The on-device emitter `@`-prefixes reserved attributes
		// (`status` ∈ `RESERVED_CASE_ATTRIBUTES`); the filter
		// fragment lands as `[@status = 'open']` after the canonical
		// `[@case_type='patient'][@status='open']` chain. Spacing
		// reflects the AST-driven emitter's pretty-print shape; the
		// canonical chain is hand-built without spaces in
		// `session.ts::deriveSessionDatums`.
		expect(suite).toContain("[@status = 'open']");
	});
});

// ── 4. Preview rendering against PostgresCaseStore ───────────────

describe("preview rendering (PostgresCaseStore.queryWithCalculated)", () => {
	it("filters, sorts, and projects calculated values per the authored config", async () => {
		// Setup: seed `case_type_schemas` for the patient case
		// type, then insert three patients spanning the filter +
		// sort matrix.
		const store = buildStore();
		const doc = buildFixtureDoc();
		await store.applySchemaChange({
			appId: APP_ID,
			caseType: "patient",
			blueprint: doc,
		});

		// Alice — open, age 25. Filter passes; calc = 26.
		await store.insert({
			appId: APP_ID,
			row: {
				case_id: PATIENT_ALICE_ID,
				case_type: "patient",
				case_name: "Alice",
				status: "open",
				properties: { name: "Alice", age: 25, region: "N" },
			},
		});
		// Bob — open, age 40. Filter passes; calc = 41.
		await store.insert({
			appId: APP_ID,
			row: {
				case_id: PATIENT_BOB_ID,
				case_type: "patient",
				case_name: "Bob",
				status: "open",
				properties: { name: "Bob", age: 40, region: "S" },
			},
		});
		// Carol — closed, age 30. Filter rejects.
		await store.insert({
			appId: APP_ID,
			row: {
				case_id: PATIENT_CAROL_ID,
				case_type: "patient",
				case_name: "Carol",
				status: "closed",
				properties: { name: "Carol", age: 30, region: "N" },
			},
		});

		// Run the case list end-to-end. The `sort` argument matches
		// the case-store SortKey shape (`{direction, expression}`);
		// the SortKey domain shape (`{source, type, direction}`)
		// resolves through `sortKeyToExpression` at the
		// `lib/preview/engine/caseDataBindingHelpers.ts` lift point
		// — re-implementing that lift inline keeps the integration
		// arm independent of the helper's changes.
		const config = buildWellFormedCaseListConfig();
		const rows = await store.queryWithCalculated({
			appId: APP_ID,
			caseType: "patient",
			blueprint: doc,
			calculated: config.calculatedColumns,
			predicate: config.filter,
			sort: [
				{
					direction: "desc",
					expression: term(prop("patient", "age")),
				},
				{
					direction: "asc",
					expression: term(prop("patient", "name")),
				},
			],
			limit: 100,
		});

		// Filter eliminated Carol; Alice + Bob survive.
		expect(rows).toHaveLength(2);
		// Sort is age-desc, so Bob (40) precedes Alice (25).
		expect(rows[0]?.case_id).toBe(PATIENT_BOB_ID);
		expect(rows[1]?.case_id).toBe(PATIENT_ALICE_ID);
		// The case-side scalar columns flow through verbatim.
		expect(rows[0]?.status).toBe("open");
		expect(rows[1]?.status).toBe("open");
		// Calculated column projects under its authored id, not
		// the wire-side `__nova_calc__<id>` prefix.
		expect(Number(rows[0]?.calculated.age_next_year)).toBe(41);
		expect(Number(rows[1]?.calculated.age_next_year)).toBe(26);
	});
});
