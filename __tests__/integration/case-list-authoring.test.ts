import { testUuid } from "@/__tests__/helpers/uuid";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { proseText } from "@/lib/domain/prose";
// __tests__/integration/case-list-authoring.test.ts
//
// End-to-end coverage for the case-list authoring surface. Each
// `describe(...)` block exercises one cross-layer contract a single
// per-layer unit test cannot capture:
//
//   - SA tool surface: atomic ops author the same `caseListConfig`
//     shape the schema admits, the wire emitters consume, and the
//     preview engine queries against. uuids surfaced by `add` flow
//     into subsequent `update` / `remove` / `reorder` calls verbatim.
//   - Wire emission: per-column `<sort>` blocks, calc-column inline-
//     variable templates, visibility filtering, comparator-type
//     fallback shapes (`undefined` / `ANY_TYPE`) and rejection of an
//     unsupported server-side-only sequence expression.
//   - Validator: column-uuid not found, orphan search-input
//     references inside the predicate filter, search-input mode-vs-
//     property-type mismatches.
//   - Sort-priority admission: the absolute commit gate rejects a
//     second column authored at an already-used priority.
//   - Migration coverage: the upgrade script (legacy parallel arrays
//     → unified columns array) lands the right visibility flags and
//     resolves header collisions.
//   - Postgres testcontainer round-trip: predicate filter, sort with
//     mixed direction + types, calculated-column projection — all
//     against a real Postgres engine via `setupPerTestDatabase`.
//
// The Postgres-touching arms run against per-test databases; the
// pure-pipeline arms (schema parse, validator, wire emission, SA
// tool path, migration) require no database and run in milliseconds.

import AdmZip from "adm-zip";
import { type Kysely, sql } from "kysely";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildDoc, f, resolveCaseListConfig } from "@/lib/__tests__/docHelpers";
import { makeToolWorkspaceHarness } from "@/lib/agent/__tests__/fixtures";
import { addCaseListColumnsTool } from "@/lib/agent/tools/case-list-config/addCaseListColumns";
import { addSearchInputsTool } from "@/lib/agent/tools/case-list-config/addSearchInputs";
import { removeCaseListColumnTool } from "@/lib/agent/tools/case-list-config/removeCaseListColumn";
import { reorderCaseListColumnsTool } from "@/lib/agent/tools/case-list-config/reorderCaseListColumns";
import { updateCaseListColumnTool } from "@/lib/agent/tools/case-list-config/updateCaseListColumn";
import { updateSearchInputTool } from "@/lib/agent/tools/case-list-config/updateSearchInput";
import { buildCaseTypeMap, type CaseStore } from "@/lib/case-store";
import { runCaseStoreMigrations } from "@/lib/case-store/migrate";
import { PostgresCaseStore } from "@/lib/case-store/postgres/store";
import { HeuristicCaseGenerator } from "@/lib/case-store/sample/heuristic";
import { setupPerTestDatabase } from "@/lib/case-store/sql/__tests__/perTestDatabase";
import type { Database } from "@/lib/case-store/sql/database";
import { compileCcz } from "@/lib/commcare/compiler";
import { expandDoc } from "@/lib/commcare/expander";
import { emitLongDetail } from "@/lib/commcare/suite/case-list/longDetail";
import { emitShortDetail } from "@/lib/commcare/suite/case-list/shortDetail";
import { buildSortDirectives } from "@/lib/commcare/suite/case-list/sortKeys";
import { runValidation } from "@/lib/commcare/validator/runner";
import {
	type BlueprintDoc,
	type CaseListConfig,
	type Column,
	calculatedColumn,
	caseListConfigSchema,
	dateColumn,
	emptyCaseListConfig,
	idMappingColumn,
	idMappingEntry,
	intervalColumn,
	type Module,
	orderedColumns,
	plainColumn,
	rangeMode,
	simpleSearchInputDef,
} from "@/lib/domain";
import {
	arith,
	eq,
	input,
	literal,
	matchAll,
	prop,
	term,
} from "@/lib/domain/predicate";
import { readCases } from "@/lib/preview/engine/caseDataBindingHelpers";

// The SA tool fixtures and the migration script both touch the
// Firestore `apps` collection at module-import / write time. The
// integration test exercises them at the layer above persistence,
// so every Firestore stub returns immediately.
vi.mock("@/lib/db/apps", () => ({
	updateApp: vi.fn(() => Promise.resolve()),
	updateAppForRun: vi.fn(() => Promise.resolve()),
	completeApp: vi.fn(() => Promise.resolve()),
}));
vi.mock("@/lib/db/applyBlueprintChange", () => ({
	applyBlueprintChange: vi.fn(() => Promise.resolve()),
}));

beforeEach(() => {
	vi.clearAllMocks();
});

// ── Per-test database harness ────────────────────────────────────
//
// Every test in `describe("preview rendering", ...)` opens a fresh
// Postgres database via `setupPerTestDatabase`. `PostgresCaseStore`'s
// `applySchemaChange` and `insert` open inner transactions Kysely
// lowers to literal `BEGIN` statements; Postgres rejects nested
// BEGIN inside a shared-database BEGIN/ROLLBACK fixture, so only the
// per-test database shape works for those tests. The pure-pipeline
// arms (schema, validator, wire, SA tool path, migration) skip the
// database entirely — they don't need to pay the per-test create /
// drop cost.

const dbHandle = setupPerTestDatabase({
	databaseNamePrefix: "case_list_int_",
});

// ── Fixture identifiers ──────────────────────────────────────────
//
// Fixed app id + owner id keep traces readable. Patient case ids
// are pinned so the sort-direction assertions reference the rows
// by name rather than reading back the order to discover them.

const APP_ID = "case-list-authoring-int";
const OWNER_ID = "owner-int";
const PATIENT_ALICE_ID = "30000000-0000-0000-0000-000000000001";
const PATIENT_BOB_ID = "30000000-0000-0000-0000-000000000002";
const PATIENT_CAROL_ID = "30000000-0000-0000-0000-000000000003";

// Region id-mapping table — re-used by the well-formed wire fixture.
const REGION_MAPPING = [
	idMappingEntry("N", "North"),
	idMappingEntry("S", "South"),
] as const;

// Pre-allocated column uuids the wire-emission fixture references.
// Stable uuids let assertions cross-check the same column at
// multiple layers (sort directives keyed by uuid; preview cell
// rendering keyed by uuid) without snapshotting opaque generated
// strings.
const COL_NAME_UUID = testUuid("00000000-0000-4000-8000-000000000001");
const COL_DATE_UUID = testUuid("00000000-0000-4000-8000-000000000002");
const COL_INTERVAL_UUID = testUuid("00000000-0000-4000-8000-000000000003");
const COL_REGION_UUID = testUuid("00000000-0000-4000-8000-000000000004");
const COL_AGE_UUID = testUuid("00000000-0000-4000-8000-000000000005");
const COL_AGE_NEXT_UUID = testUuid("00000000-0000-4000-8000-000000000006");

const SI_NAME_UUID = testUuid("00000000-0000-4000-8000-000000000010");
const SI_VISIT_RANGE_UUID = testUuid("00000000-0000-4000-8000-000000000011");

/**
 * Construct the well-formed v2 case-list configuration. Single
 * source of truth for the wire-emission + validator + preview
 * arms. The fixture covers five non-calc column kinds (plain
 * twice, date, interval, id-mapping), one calculated column, a
 * real `eq` predicate filter, multi-priority sort, simple +
 * range-mode search inputs, and visibility flags.
 */
function buildWellFormedCaseListConfig(): CaseListConfig {
	return resolveCaseListConfig({
		columns: [
			plainColumn(COL_NAME_UUID, "case_name", "Patient", {
				sort: { direction: "asc", priority: 1 },
			}),
			dateColumn(COL_DATE_UUID, "date_opened", "Opened", "%Y-%m-%d"),
			intervalColumn(
				COL_INTERVAL_UUID,
				"last_visit",
				"Weeks since visit",
				2,
				"weeks",
				"always",
				"Overdue",
			),
			idMappingColumn(COL_REGION_UUID, "region", "Region", REGION_MAPPING),
			plainColumn(COL_AGE_UUID, "age", "Age", {
				sort: { direction: "desc", priority: 0 },
			}),
			calculatedColumn(
				COL_AGE_NEXT_UUID,
				"Age next year",
				arith(
					"+",
					term(prop("patient", "age")),
					term({ kind: "literal", value: 1, data_type: "int" }),
				),
			),
		],
		// `status` is a CommCare standard property (text-typed); the
		// type checker resolves it without a declared `properties[]`
		// entry.
		filter: eq(prop("patient", "status"), literal("open")),
		searchInputs: [
			simpleSearchInputDef(
				SI_NAME_UUID,
				"patient_name",
				"Patient name",
				"text",
				"full_name",
			),
			// CommCare's range prompt carries one inseparable start/end
			// answer, so Nova pairs it only with the date-range widget.
			// Keeping that invariant in the shared well-formed fixture
			// means the validator, HQ JSON, and suite emitters all exercise
			// the same value shape.
			simpleSearchInputDef(
				SI_VISIT_RANGE_UUID,
				"last_visit",
				"Visit dates",
				"date-range",
				"last_visit",
				{ mode: rangeMode() },
			),
		],
	});
}

/**
 * Build a `BlueprintDoc` carrying the well-formed v2 config plus a
 * second case-typed module with no `caseListConfig` (the
 * "absence" arm — the emitter must produce a minimal title-only
 * `<detail>` shell). The `patient` case type declares `name`,
 * `age`, `region`, `last_visit`. Combined with CommCare's
 * standard properties (`case_name`, `status`, `date_opened`),
 * every column / filter / search-input the well-formed config
 * references resolves cleanly.
 */
function buildFixtureDoc(): BlueprintDoc {
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
								label: proseText("Patient name"),
								caseWrite: { caseType: "patient", property: "case_name" },
							}),
							f({
								kind: "text",
								id: "name",
								label: proseText("Full name"),
								caseWrite: { caseType: "patient", property: "full_name" },
							}),
							f({
								kind: "int",
								id: "age",
								label: proseText("Age"),
								caseWrite: { caseType: "patient", property: "age" },
							}),
							f({
								kind: "text",
								id: "region",
								label: proseText("Region"),
								caseWrite: { caseType: "patient", property: "region" },
							}),
							f({
								kind: "date",
								id: "last_visit",
								label: proseText("Last visit"),
								caseWrite: { caseType: "patient", property: "last_visit" },
							}),
						],
					},
					{
						// Followup form drives the entry's case-load datum,
						// which threads `caseListConfig.filter` into the
						// `<nodeset>` predicate. Registration forms create
						// cases (no load); without a followup, the suite's
						// session-datum carries no `@case_type='patient'`
						// chain and the filter fragment never lands on the
						// wire.
						name: "Visit",
						type: "followup",
						fields: [
							f({ kind: "text", id: "notes", label: proseText("Notes") }),
						],
					},
				],
			},
			{
				// Case-typed module without `caseListConfig`. The emitter
				// returns a minimal title-only shell; visibility filters
				// have nothing to drop.
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
								label: proseText("Household name"),
								caseWrite: { caseType: "household", property: "case_name" },
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
					{ name: "full_name", label: proseText("Name"), data_type: "text" },
					{ name: "age", label: proseText("Age"), data_type: "int" },
					{ name: "region", label: proseText("Region"), data_type: "text" },
					{
						name: "last_visit",
						label: proseText("Last visit"),
						data_type: "date",
					},
				],
			},
			{
				name: "household",
				properties: [
					{ name: "full_name", label: proseText("Name"), data_type: "text" },
				],
			},
		],
	});
}

/**
 * Construct a `PostgresCaseStore` bound to the harness's per-test
 * database handle. The Kysely<unknown> → Kysely<Database> cast
 * mirrors the saga integration test's pattern — the per-test
 * harness is generic over downstream schemas; the case-store
 * needs the case-store-specific Database contract.
 */
function buildStore(): CaseStore {
	return new PostgresCaseStore({
		projectId: OWNER_ID,
		actorUserId: OWNER_ID,
		ownerId: OWNER_ID,
		db: dbHandle.db as unknown as Kysely<Database>,
		sampleGenerator: new HeuristicCaseGenerator(),
	});
}

// =================================================================
// 1. Schema parse — round-trip the well-formed fixture through
//    `caseListConfigSchema`. Surfaces drift between the test
//    fixture and the schema as a parse failure rather than as a
//    silent downstream mismatch.
// =================================================================

describe("schema parse", () => {
	it("accepts the well-formed v2 case-list configuration", () => {
		const config = buildWellFormedCaseListConfig();
		const parsed = caseListConfigSchema.parse(config);
		expect(parsed).toEqual(config);
	});
});

// =================================================================
// 2. SA tool path — atomic column ops thread uuids through the
//    add → update → reorder → remove sequence. Every call's
//    `result.uuid` is the addressing key for the next call; the
//    final doc state matches the authored shape.
// =================================================================

describe("SA tool path — column atomic ops", () => {
	it("threads uuids through add → update → reorder → remove", async () => {
		// Single case-typed module — every SA tool invocation here
		// targets its stable UUID. The `f` helper auto-stamps field
		// uuids; explicit case-list slot is omitted so the first
		// `addCaseListColumns` initializes it.
		const startDoc = buildDoc({
			appId: APP_ID,
			appName: "SA Tool Path",
			modules: [
				{
					name: "Patients",
					caseType: "patient",
					forms: [
						{
							name: "Register",
							type: "registration",
							fields: [
								f({
									kind: "text",
									id: "case_name",
									label: proseText("Patient name"),
									caseWrite: { caseType: "patient", property: "case_name" },
								}),
								f({
									kind: "int",
									id: "age",
									label: proseText("Age"),
									caseWrite: { caseType: "patient", property: "age" },
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
						{ name: "case_name", label: proseText("Name"), data_type: "text" },
						{ name: "age", label: proseText("Age"), data_type: "int" },
					],
				},
			],
		});
		const moduleUuid = startDoc.moduleOrder[0];
		// The workspace owns the document across the whole sequence: each
		// call reads what the previous one committed, so nothing threads a
		// doc by hand.
		const h = makeToolWorkspaceHarness(startDoc, { appId: APP_ID });

		// 1. Add the first column — capture the uuid the tool mints.
		const addNameResult = await h.runTool(addCaseListColumnsTool, {
			moduleUuid,
			columns: [{ kind: "plain", field: "case_name", header: "Patient" }],
		});
		if ("error" in addNameResult.result) {
			throw new Error(
				`add patient column failed: ${addNameResult.result.error}`,
			);
		}
		const nameUuid = addNameResult.result.uuids[0];
		// The success message echoes the header; the `result.uuids`
		// surface the minted uuids structurally so the SA can reference
		// them directly without parsing the string.
		expect(addNameResult.result.message).toContain("Patient");

		// 2. Add a second column on the post-add doc.
		const addAgeResult = await h.runTool(addCaseListColumnsTool, {
			moduleUuid,
			columns: [{ kind: "plain", field: "age", header: "Age" }],
		});
		if ("error" in addAgeResult.result) {
			throw new Error(`add age column failed: ${addAgeResult.result.error}`);
		}
		const ageUuid = addAgeResult.result.uuids[0];
		expect(ageUuid).not.toBe(nameUuid);

		// 3. Update the second column — flip on a sort directive.
		// The replacement carries the same uuid (the tool stamps the
		// existing uuid back onto the supplied body).
		const updateResult = await h.runTool(updateCaseListColumnTool, {
			moduleUuid,
			columnUuid: ageUuid,
			column: {
				kind: "plain",
				field: "age",
				header: "Age",
				sort: { direction: "desc", priority: 0 },
			},
		});
		if ("error" in updateResult.result) {
			throw new Error(`update column failed: ${updateResult.result.error}`);
		}
		expect(updateResult.result.uuid).toBe(ageUuid);

		// 4. Reorder — supply both uuids in age-first order.
		const reorderResult = await h.runTool(reorderCaseListColumnsTool, {
			moduleUuid,
			surface: "results",
			columnUuids: [ageUuid, nameUuid],
		});
		if ("error" in reorderResult.result) {
			throw new Error(`reorder failed: ${reorderResult.result.error}`);
		}
		const reorderedColumns = orderedColumns(configOf(h.currentDoc()), "list");
		expect(reorderedColumns.map((column) => column.uuid)).toEqual([
			ageUuid,
			nameUuid,
		]);

		// 5. Remove the original first column — still keyed by uuid
		// so the address survives the prior reorder.
		const removeResult = await h.runTool(removeCaseListColumnTool, {
			moduleUuid,
			columnUuid: nameUuid,
		});
		if ("error" in removeResult.result) {
			throw new Error(`remove failed: ${removeResult.result.error}`);
		}
		const finalColumns = collectColumns(h.currentDoc());
		expect(finalColumns).toHaveLength(1);
		expect(finalColumns[0]?.uuid).toBe(ageUuid);
		// Sort directive on the survivor survived the reorder + remove.
		expect(finalColumns[0]?.sort).toEqual({ direction: "desc", priority: 0 });
	});

	it("returns Elm-style error when an update targets an unknown column uuid", async () => {
		const doc = buildDoc({
			appId: APP_ID,
			modules: [{ name: "Patients", caseType: "patient", caseListOnly: true }],
			caseTypes: [{ name: "patient", properties: [] }],
		});
		const moduleUuid = doc.moduleOrder[0];
		const h = makeToolWorkspaceHarness(doc, { appId: APP_ID });
		const result = await h.runTool(updateCaseListColumnTool, {
			moduleUuid,
			columnUuid: testUuid("ffffffff-ffff-ffff-ffff-ffffffffffff"),
			column: { kind: "plain", field: "case_name", header: "Patient" },
		});
		if (!("error" in result.result)) {
			throw new Error("expected error result on unknown uuid");
		}
		// The shared `replaceByUuid` helper's voice: "Tried to update
		// X. Found no entry with that uuid. Look at getModule's
		// projection or run searchBlueprint to surface the current
		// uuids."
		expect(result.result.error).toContain("Found no entry");
	});
});

// =================================================================
// 3. Wire emission — golden structural fingerprints across short
//    detail (sort + visibility), long detail (visibility-only,
//    no sort), and the .ccz bundle. Inline shape assertions
//    mirror the per-emitter unit tests' style; goldens are
//    structural fingerprints, not whole-XML snapshots.
// =================================================================

describe("wire emission", () => {
	it("emits per-column <sort> blocks ordered by priority with calc-arm template", () => {
		const doc = buildFixtureDoc();
		const moduleUuid = doc.moduleOrder[0];
		const mod = doc.modules[moduleUuid];
		if (!mod) throw new Error("missing module");
		const result = emitShortDetail({ module: mod, moduleIndex: 0, doc });

		expect(result.xml).toContain('<detail id="m0_case_short">');
		expect(result.xml).toContain('<locale id="cchq.case"/>');
		// Plain — bare property reference.
		expect(result.xml).toContain('<xpath function="case_name"/>');
		// Date — empty-string-guard wrapped in format-date. XPath
		// single-quote literals round-trip through the serializer as
		// `&apos;` inside the double-quoted attribute value.
		expect(result.xml).toContain(
			"if(date_opened = &apos;&apos;, &apos;&apos;, format-date(date(date_opened), &apos;%Y-%m-%d&apos;))",
		);
		// Interval (display: always) — divisor 7 (weeks) + threshold
		// 14 days. Worker text resolves through a locale variable.
		expect(result.xml).toContain("(today() - date(last_visit)) div 7");
		expect(result.xml).toContain("$knova_text_0");
		expect(Object.values(result.strings)).toContain("Overdue");
		// Id-mapping — selected() chain wrapped in replace(join(...)).
		expect(result.xml).toContain(
			"if(selected(region, &apos;N&apos;), $knova_text_0",
		);
		expect(Object.values(result.strings)).toEqual(
			expect.arrayContaining(["North", "South"]),
		);
		// Calculated column emits the inline-variable template per
		// CCHQ's `detail_screen.py::FormattedDetailColumn.template`'s
		// `useXpathExpression` branch.
		expect(result.xml).toContain('<variable name="calculated_property">');
		// Sort priority ordering — `age` carries priority 0 → order=1
		// (descending integer). `case_name` carries priority 1 →
		// order=2 (ascending plain).
		expect(result.xml).toMatch(
			/<sort type="int" order="1" direction="descending">[\s\S]*?<xpath function="age"\/>/,
		);
		expect(result.xml).toMatch(
			/<sort type="string" order="2" direction="ascending">[\s\S]*?<xpath function="case_name"\/>/,
		);
	});

	it("emits long detail without <sort> blocks", () => {
		const doc = buildFixtureDoc();
		const moduleUuid = doc.moduleOrder[0];
		const mod = doc.modules[moduleUuid];
		if (!mod) throw new Error("missing module");
		const result = emitLongDetail({ module: mod, moduleIndex: 0, doc });

		expect(result.xml).toContain('<detail id="m0_case_long">');
		// CCHQ's `detail_screen.py::FormattedDetailColumn.sort_node`
		// short-circuits on long detail; sort lives only on short.
		expect(result.xml).not.toContain("<sort");
	});

	it("filters columns by visibleInList on short detail and visibleInDetail on long detail", () => {
		// Two columns: one hidden from list, one hidden from detail.
		// The shared columns appear on both surfaces.
		const moduleUuid = testUuid("11111111-1111-1111-1111-111111111111");
		const formUuid = testUuid("22222222-2222-2222-2222-222222222222");
		const colShared = testUuid("00000000-0000-4000-8000-aaaa00000001");
		const colListOnly = testUuid("00000000-0000-4000-8000-aaaa00000002");
		const colDetailOnly = testUuid("00000000-0000-4000-8000-aaaa00000003");
		const mod: Module = {
			uuid: moduleUuid,
			id: "patients",
			name: "Patients",
			caseType: "patient",
			caseListConfig: resolveCaseListConfig({
				columns: [
					plainColumn(colShared, "case_name", "Name"),
					plainColumn(colListOnly, "age", "Age", {
						visibleInDetail: false,
					}),
					plainColumn(colDetailOnly, "region", "Region", {
						visibleInList: false,
					}),
				],
				searchInputs: [],
			}),
		};
		const doc: BlueprintDoc = {
			appId: APP_ID,
			appName: "Visibility",
			connectType: null,
			caseTypes: [
				{
					name: "patient",
					properties: [
						{ name: "case_name", label: proseText("Name"), data_type: "text" },
						{ name: "age", label: proseText("Age"), data_type: "int" },
						{ name: "region", label: proseText("Region"), data_type: "text" },
					],
				},
			],
			modules: { [moduleUuid]: mod },
			forms: {
				[formUuid]: {
					uuid: formUuid,
					id: "register",
					name: "Register",
					type: "registration",
				},
			},
			fields: {},
			moduleOrder: [moduleUuid],
			formOrder: { [moduleUuid]: [formUuid] },
			fieldOrder: { [formUuid]: [] },
			fieldParent: {},
		};
		const shortResult = emitShortDetail({ module: mod, moduleIndex: 0, doc });
		const longResult = emitLongDetail({ module: mod, moduleIndex: 0, doc });

		// Short detail — list-only filtered out; detail-only column
		// (`region`) absent from the short XML; shared + list-only
		// (`age`) present.
		expect(shortResult.xml).toContain('<xpath function="case_name"/>');
		expect(shortResult.xml).toContain('<xpath function="age"/>');
		expect(shortResult.xml).not.toContain('<xpath function="region"/>');

		// Long detail — detail-only present; list-only (`age`)
		// absent.
		expect(longResult.xml).toContain('<xpath function="case_name"/>');
		expect(longResult.xml).toContain('<xpath function="region"/>');
		expect(longResult.xml).not.toContain('<xpath function="age"/>');
	});

	it("packages a well-formed .ccz archive end-to-end", () => {
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
		// canonical `@case_type='patient'][@status='open']` chain
		// plus the `caseListConfig.filter` fragment appended at the
		// trailing position. XPath single-quote literals round-trip
		// as `&apos;` inside the double-quoted `nodeset` attribute.
		expect(suite).toContain("@case_type=&apos;patient&apos;");
		expect(suite).toContain("[@status = &apos;open&apos;]");
	});
});

// =================================================================
// 4. Calc-column comparator safety — unresolved and null-shaped
//    values defensively fall back to `plain`, while expressions Core
//    cannot evaluate on-device fail closed at the wire boundary.
// =================================================================

describe("calc-column comparator-type fallback", () => {
	const moduleUuid = testUuid("11111111-1111-1111-1111-111111111111");
	const calcUuid = testUuid("00000000-0000-4000-8000-cccc00000001");

	function buildCalcModule(
		expression: Parameters<typeof calculatedColumn>[2],
	): {
		mod: Module;
		doc: BlueprintDoc;
	} {
		const mod: Module = {
			uuid: moduleUuid,
			id: "patients",
			name: "Patients",
			caseType: "patient",
			caseListConfig: resolveCaseListConfig({
				columns: [
					calculatedColumn(calcUuid, "Calc value", expression, {
						sort: { direction: "asc", priority: 0 },
					}),
				],
				searchInputs: [],
			}),
		};
		const doc: BlueprintDoc = {
			appId: APP_ID,
			appName: "Calc Fallback",
			connectType: null,
			caseTypes: [{ name: "patient", properties: [] }],
			modules: { [moduleUuid]: mod },
			forms: {},
			fields: {},
			moduleOrder: [moduleUuid],
			formOrder: { [moduleUuid]: [] },
			fieldOrder: {},
			fieldParent: {},
		};
		return { mod, doc };
	}

	it("falls back to plain when checkExpression returns undefined (unresolvable property)", () => {
		// Resolution failure — `prop("patient", "ghost")` is not a
		// declared property and not a CCHQ standard property; the
		// type checker returns `undefined`.
		const { mod, doc } = buildCalcModule(term(prop("patient", "ghost")));
		const directives = buildSortDirectives(mod, doc);
		const dir = directives.get(calcUuid);
		if (!dir) throw new Error("missing directive on calc column");
		expect(dir.type).toBe("plain");
	});

	it("falls back to plain when checkExpression returns ANY_TYPE (null literal)", () => {
		// `null` literal — the type checker returns `ANY_TYPE`, the
		// permissive sentinel that compares against every type.
		const { mod, doc } = buildCalcModule(term(literal(null)));
		const directives = buildSortDirectives(mod, doc);
		const dir = directives.get(calcUuid);
		if (!dir) throw new Error("missing directive on calc column");
		expect(dir.type).toBe("plain");
	});
});

// =================================================================
// 5. Discriminated SearchInputDef round-trip — a simple input
//    converts to advanced via the SA `updateSearchInput` tool path,
//    converts back to simple, and the common slots survive both
//    edits byte-identically.
// =================================================================

describe("SearchInputDef exact four-arm round-trip", () => {
	it("converts simple → advanced → simple via updateSearchInput, preserving uuid + common slots", async () => {
		const baseDoc = buildDoc({
			appId: APP_ID,
			modules: [
				{
					name: "Patients",
					caseType: "patient",
					caseListConfig: resolveCaseListConfig({
						columns: [
							plainColumn(
								testUuid("00000000-0000-4000-8000-aaaa00000001"),
								"case_name",
								"Patient",
							),
						],
						searchInputs: [],
					}),
					forms: [
						{
							name: "Register",
							type: "registration",
							fields: [
								f({
									kind: "text",
									id: "case_name",
									label: proseText("Case name"),
									caseWrite: {
										caseType: "patient",
										property: "case_name",
									},
								}),
								f({
									kind: "text",
									id: "name",
									label: proseText("Patient name"),
									caseWrite: {
										caseType: "patient",
										property: "full_name",
									},
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
						{ name: "full_name", label: proseText("Name"), data_type: "text" },
					],
				},
			],
		});
		const moduleUuid = baseDoc.moduleOrder[0];
		const h = makeToolWorkspaceHarness(baseDoc, { appId: APP_ID });

		// Add a simple input — capture the uuid the tool mints.
		const addResult = await h.runTool(addSearchInputsTool, {
			moduleUuid,
			searchInputs: [
				{
					kind: "simple",
					name: "patient_name",
					label: "Patient name",
					type: "text",
					property: "full_name",
					default: term(literal("Alice")),
				},
			],
		});
		if ("error" in addResult.result) {
			throw new Error(`add input failed: ${addResult.result.error}`);
		}
		const inputUuid = addResult.result.uuids[0];
		const afterAdd = collectSearchInputs(h.currentDoc());
		expect(afterAdd).toHaveLength(1);
		expect(afterAdd[0]?.kind).toBe("simple");

		// Convert simple → advanced. The new body carries a free-form
		// predicate; the SA preserves uuid + name + label + type +
		// default across the call.
		const toAdvancedResult = await h.runTool(updateSearchInputTool, {
			moduleUuid,
			searchInputUuid: inputUuid,
			searchInput: {
				kind: "advanced",
				name: "patient_name",
				label: "Patient name",
				type: "text",
				default: term(literal("Alice")),
				predicate: matchAll(),
			},
		});
		if ("error" in toAdvancedResult.result) {
			throw new Error(
				`simple → advanced failed: ${toAdvancedResult.result.error}`,
			);
		}
		const advanced = collectSearchInputs(h.currentDoc())[0];
		if (!advanced) throw new Error("missing input after simple → advanced");
		expect(advanced.kind).toBe("advanced");
		expect(advanced.uuid).toBe(inputUuid);
		expect(advanced.name).toBe("patient_name");
		expect(advanced.label).toBe("Patient name");
		expect(advanced.type).toBe("text");
		if (advanced.type !== "date-range") {
			expect(advanced.default).toEqual(term(literal("Alice")));
		}

		// Convert back to simple. The discriminated SA tool accepts
		// the simple-arm body shape; the advanced predicate is
		// dropped on the conversion (the advanced and simple arms
		// are distinct unions — there is no shared "predicate" slot).
		const toSimpleResult = await h.runTool(updateSearchInputTool, {
			moduleUuid,
			searchInputUuid: inputUuid,
			searchInput: {
				kind: "simple",
				name: "patient_name",
				label: "Patient name",
				type: "text",
				property: "full_name",
				default: term(literal("Alice")),
			},
		});
		if ("error" in toSimpleResult.result) {
			throw new Error(
				`advanced → simple failed: ${toSimpleResult.result.error}`,
			);
		}
		const simple = collectSearchInputs(h.currentDoc())[0];
		if (!simple) throw new Error("missing input after advanced → simple");
		expect(simple.kind).toBe("simple");
		expect(simple.uuid).toBe(inputUuid);
		expect(simple.name).toBe("patient_name");
		expect(simple.label).toBe("Patient name");
		expect(simple.type).toBe("text");
		if (simple.type !== "date-range") {
			expect(simple.default).toEqual(term(literal("Alice")));
		}
		if (simple.kind === "simple") {
			expect(simple.property).toBe("full_name");
		}
	});
});

// =================================================================
// 6. Orphan Search-input identity validator surface. An unresolved
//    Search-input UUID in `caseListConfig.filter` surfaces as
//    `CASE_LIST_FILTER_TYPE_ERROR` via the predicate type checker.
// =================================================================

describe("orphan Search-input identity surfaces a validator error", () => {
	it("flags an unresolvable Search-input identity inside the filter as CASE_LIST_FILTER_TYPE_ERROR", () => {
		const moduleUuid = testUuid("11111111-1111-1111-1111-111111111111");
		const formUuid = testUuid("22222222-2222-2222-2222-222222222222");
		// The filter references an immutable UUID with no matching
		// declaration in `searchInputs`; the validator reports the
		// owning filter slot without inventing a mutable-name fallback.
		const doc: BlueprintDoc = {
			appId: APP_ID,
			appName: "Orphan Input",
			connectType: null,
			caseTypes: [
				{
					name: "patient",
					properties: [
						{ name: "full_name", label: proseText("Name"), data_type: "text" },
					],
				},
			],
			modules: {
				[moduleUuid]: {
					uuid: moduleUuid,
					id: "patients",
					name: "Patients",
					caseType: "patient",
					caseListConfig: resolveCaseListConfig({
						columns: [
							plainColumn(
								testUuid("00000000-0000-4000-8000-aaaa00000001"),
								"full_name",
								"Name",
							),
						],
						filter: eq(
							prop("patient", "full_name"),
							term(input(testUuid("orphan_input"))),
						),
						searchInputs: [
							// A different immutable identity is declared.
							simpleSearchInputDef(
								testUuid("00000000-0000-4000-8000-bbbb00000001"),
								"declared_input",
								"Declared",
								"text",
								"full_name",
							),
						],
					}),
				},
			},
			forms: {
				[formUuid]: {
					uuid: formUuid,
					id: "register",
					name: "Register",
					type: "registration",
				},
			},
			fields: {},
			moduleOrder: [moduleUuid],
			formOrder: { [moduleUuid]: [formUuid] },
			fieldOrder: { [formUuid]: [] },
			fieldParent: {},
		};
		const errors = runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE);
		expect(errors.some((e) => e.code === "CASE_LIST_FILTER_TYPE_ERROR")).toBe(
			true,
		);
	});
});

// =================================================================
// 7. Validator rejection of broken references — orthogonal column-
//    uuid / search-input shape errors fire on their dedicated codes.
// =================================================================

describe("validator rejection of broken references", () => {
	it("emits no case-list errors on the well-formed blueprint", () => {
		const doc = buildFixtureDoc();
		const errors = runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE);
		const caseListErrors = errors.filter(
			(e) =>
				e.code.startsWith("CASE_LIST_") ||
				e.code === "FIELD_KIND_PROPERTY_TYPE_MISMATCH",
		);
		expect(caseListErrors).toEqual([]);
	});

	it("flags a column referencing an unknown property with CASE_LIST_COLUMN_UNKNOWN_FIELD", () => {
		const doc = buildFixtureDoc();
		const moduleUuid = doc.moduleOrder[0];
		const mod = doc.modules[moduleUuid];
		if (!mod?.caseListConfig) {
			throw new Error("fixture module missing caseListConfig");
		}
		// Replace one column with one whose `field` no writer creates
		// and no case type declares.
		const corruptedColumns: Column[] = [
			...mod.caseListConfig.columns.slice(0, -1),
			plainColumn(
				testUuid("00000000-0000-4000-8000-eeee00000001"),
				"ghost_property",
				"Ghost",
			),
		];
		const replacedColumnUuid = mod.caseListConfig.columns.at(-1)?.uuid;
		const ghostColumnUuid = corruptedColumns.at(-1)?.uuid;
		if (!replacedColumnUuid || !ghostColumnUuid) {
			throw new Error("fixture has no column to replace");
		}
		mod.caseListConfig = {
			...mod.caseListConfig,
			columns: corruptedColumns,
			listColumnOrder: mod.caseListConfig.listColumnOrder.map((uuid) =>
				uuid === replacedColumnUuid ? ghostColumnUuid : uuid,
			),
			detailColumnOrder: mod.caseListConfig.detailColumnOrder.map((uuid) =>
				uuid === replacedColumnUuid ? ghostColumnUuid : uuid,
			),
		};
		const errors = runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE);
		expect(
			errors.some(
				(e) =>
					e.code === "CASE_LIST_COLUMN_UNKNOWN_FIELD" &&
					e.message.includes("ghost_property"),
			),
		).toBe(true);
	});

	it("flags a search input mode-vs-property-type mismatch with the dedicated code", () => {
		// `range` mode is forbidden on text-typed properties — the
		// `(text-input, text-property, range-mode)` tuple is not in
		// the `SEARCH_MODE_PROPERTY_TYPES["range"]` allow-list.
		const doc = buildFixtureDoc();
		const moduleUuid = doc.moduleOrder[0];
		const mod = doc.modules[moduleUuid];
		if (!mod?.caseListConfig) {
			throw new Error("fixture module missing caseListConfig");
		}
		mod.caseListConfig = {
			...mod.caseListConfig,
			searchInputs: [
				simpleSearchInputDef(
					testUuid("00000000-0000-4000-8000-ffff00000001"),
					"name_range",
					"Name range",
					"date-range",
					"full_name",
					{ mode: rangeMode() },
				),
			],
		};
		const errors = runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE);
		expect(
			errors.some(
				(e) => e.code === "CASE_LIST_SEARCH_INPUT_MODE_PROPERTY_TYPE_MISMATCH",
			),
		).toBe(true);
	});
});

// =================================================================
// 8. Sort-priority collisions — the absolute gate rejects the edit
//    that would land two sorted columns at one priority.
// =================================================================

describe("sort-priority collision admission", () => {
	const colFirstUuid = testUuid("00000000-0000-4000-8000-bbbb00000001");
	const colSecondUuid = testUuid("00000000-0000-4000-8000-bbbb00000002");

	it("rejects a colliding priority at the commit gate (saga layer) — nothing renumbered, nothing written", async () => {
		// The saga layer never silently renumbers a priority collision —
		// and with the commit gate live, it never PERSISTS one either:
		// the second `updateCaseListColumn` that would land a duplicate
		// priority fails the call with the validator's actionable
		// message and leaves the doc untouched.
		const startDoc = buildDoc({
			appId: APP_ID,
			modules: [
				{
					name: "Patients",
					caseType: "patient",
					caseListOnly: true,
					caseListConfig: resolveCaseListConfig({
						columns: [
							plainColumn(colFirstUuid, "case_name", "Patient"),
							plainColumn(colSecondUuid, "age", "Age"),
						],
						searchInputs: [],
					}),
				},
			],
			caseTypes: [
				{
					name: "patient",
					properties: [
						{ name: "case_name", label: proseText("Name"), data_type: "text" },
						{ name: "age", label: proseText("Age"), data_type: "int" },
					],
				},
			],
		});
		const moduleUuid = startDoc.moduleOrder[0];
		const h = makeToolWorkspaceHarness(startDoc, { appId: APP_ID });

		const firstUpdate = await h.runTool(updateCaseListColumnTool, {
			moduleUuid,
			columnUuid: colFirstUuid,
			column: {
				kind: "plain",
				field: "case_name",
				header: "Patient",
				sort: { direction: "asc", priority: 0 },
			},
		});
		if ("error" in firstUpdate.result) {
			throw new Error(`first update failed: ${firstUpdate.result.error}`);
		}
		const secondUpdate = await h.runTool(updateCaseListColumnTool, {
			moduleUuid,
			columnUuid: colSecondUuid,
			column: {
				kind: "plain",
				field: "age",
				header: "Age",
				sort: { direction: "desc", priority: 0 },
			},
		});
		// The colliding write is rejected with the rule's actionable
		// message — the SA renumbers and retries rather than landing a
		// silent ordering ambiguity.
		if (!("error" in secondUpdate.result)) {
			throw new Error("expected the colliding priority to be rejected");
		}
		expect(secondUpdate.result.error).toContain("sort priority");
		expect(secondUpdate.mutations).toEqual([]);
		// The doc after the rejected call still carries only the FIRST
		// column's sort — the collision never landed.
		const finalCols = collectColumns(h.currentDoc());
		expect(finalCols[0]?.sort?.priority).toBe(0);
		expect(finalCols[1]?.sort).toBeUndefined();
	});
});

// =================================================================
// 10. Preview rendering against PostgresCaseStore — predicate +
//     sort + calculated column end-to-end. Pins the v2 case-store
//     API (`store.query` returning `CaseRowWithCalculated[]`,
//     `caseTypeSchemas` parameter, calc-arm projection by uuid).
// =================================================================

describe("preview rendering (PostgresCaseStore.query against v2 caseListConfig)", () => {
	beforeEach(async () => {
		await runCaseStoreMigrations(dbHandle.db);
		await sql`
			INSERT INTO apps
				(id, owner, project_id, app_name, app_name_lower)
			VALUES
				(${APP_ID}, ${OWNER_ID}, ${OWNER_ID}, 'Case list authoring', 'case list authoring')
		`.execute(dbHandle.db);
	});

	it("filters, sorts, and projects calc values per the authored config", async () => {
		const store = buildStore();
		const doc = buildFixtureDoc();
		await store.applySchemaChange({
			appId: APP_ID,
			caseType: "patient",
			caseTypeSchemas: buildCaseTypeMap(doc),
		});

		// Alice — open, age 25. Filter passes; calc = 26.
		await store.insert({
			appId: APP_ID,
			row: {
				case_id: PATIENT_ALICE_ID,
				case_type: "patient",
				case_name: "Alice",
				status: "open",
				properties: { full_name: "Alice", age: 25, region: "N" },
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
				properties: { full_name: "Bob", age: 40, region: "S" },
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
				properties: { full_name: "Carol", age: 30, region: "N" },
			},
		});

		const moduleUuid = doc.moduleOrder[0];
		const mod = doc.modules[moduleUuid];
		if (!mod) throw new Error("missing patients module");

		// Read through the preview helper — it lowers the v2 config
		// into the v2 case-store API surface (calc projections,
		// per-column sort + tie-break, predicate filter).
		const result = await readCases(store, {
			appId: APP_ID,
			caseType: "patient",
			caseTypeSchemas: buildCaseTypeMap(doc),
			caseListConfig: mod.caseListConfig,
		});
		if (result.kind !== "rows") {
			throw new Error("expected rows from preview");
		}
		// Filter eliminated Carol; Alice + Bob survive.
		expect(result.rows).toHaveLength(2);
		// Sort priority 0 is `age` desc → Bob (40) precedes Alice (25).
		expect(result.rows[0]?.case_id).toBe(PATIENT_BOB_ID);
		expect(result.rows[1]?.case_id).toBe(PATIENT_ALICE_ID);
		// Scalar columns flow through verbatim.
		expect(result.rows[0]?.status).toBe("open");
		expect(result.rows[1]?.status).toBe("open");
		// Calculated column projects under its authored uuid.
		expect(Number(result.rows[0]?.calculated[COL_AGE_NEXT_UUID])).toBe(41);
		expect(Number(result.rows[1]?.calculated[COL_AGE_NEXT_UUID])).toBe(26);
	});
});

// ── Helpers ──────────────────────────────────────────────────────
//
// Two narrow helpers extract the columns / search inputs of the
// first module out of a `BlueprintDoc`. The SA tool path tests
// invoke them after each call to assert the post-mutation shape
// without re-walking `moduleOrder` / `modules` at every site.

function configOf(doc: BlueprintDoc): CaseListConfig {
	return (
		doc.modules[doc.moduleOrder[0]]?.caseListConfig ?? emptyCaseListConfig()
	);
}

function collectColumns(doc: BlueprintDoc): Column[] {
	return [...configOf(doc).columns];
}

function collectSearchInputs(
	doc: BlueprintDoc,
): NonNullable<Module["caseListConfig"]>["searchInputs"] {
	const moduleUuid = doc.moduleOrder[0];
	const mod = doc.modules[moduleUuid];
	if (!mod?.caseListConfig) return [];
	return [...mod.caseListConfig.searchInputs];
}
