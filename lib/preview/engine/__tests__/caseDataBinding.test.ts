// lib/preview/engine/__tests__/caseDataBinding.test.ts
//
// Contract tests for the running-app view's data-binding helpers
// (`lib/preview/engine/caseDataBindingHelpers.ts`). The helpers
// take a `CaseStore` instance and a typed argument bundle; tests
// inject a per-test `PostgresCaseStore` from `setupPerTestDatabase`
// and exercise the discriminated-union return shapes against real
// Postgres state.
//
// ## Why the helpers, not the Server Actions
//
// `caseDataBinding.ts` exports `"use server"` actions that wrap
// `getSession()` + `withProjectContext`. Driving those through a
// real session is heavy (Better Auth + Postgres); the
// architecture splits the action wrapper from the underlying
// helpers precisely so tests can bind against a `CaseStore`
// instance from the contract harness without spinning up a
// session. The helpers carry every behavior the actions delegate
// to; the actions are thin wrappers.
//
// ## Tenant-scope coverage
//
// The "tenant boundary structural" assertion mirrors the contract
// harness's existing tenant-isolation tests: a row inserted by
// owner A is not readable by a store bound to owner B; the
// `LoadCasesResult` returned for owner B is `{ kind: "empty" }`,
// not an error. The case-store layer enforces the filter at the
// SQL layer; the binding inherits the structural enforcement.

import type { Kysely } from "kysely";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	buildCaseTypeMap,
	CaseNotFoundError,
	CasePropertiesValidationError,
	type CasePropertyFailure,
	type CaseRow,
	type CaseStore,
	CaseTypeNotInBlueprintError,
	type JsonObject,
	SchemaNotSyncedError,
} from "@/lib/case-store";
import { buildSimpleBlueprint } from "@/lib/case-store/__tests__/fixtures/simpleBlueprint";
import { runCaseStoreMigrations } from "@/lib/case-store/migrate";
import { PostgresCaseStore } from "@/lib/case-store/postgres/store";
import { HeuristicCaseGenerator } from "@/lib/case-store/sample/heuristic";
import { setupPerTestDatabase } from "@/lib/case-store/sql/__tests__/perTestDatabase";
// `Database` is the Kysely type contract for the four case-store
// tables — package-private, so the test reaches in via the
// internal subpath rather than the curated public barrel.
import type { Database } from "@/lib/case-store/sql/database";
import {
	advancedSearchInputDef,
	asUuid,
	type BlueprintDoc,
	type CaseListConfig,
	type CaseType,
	calculatedColumn,
	exactMode,
	multiSelectContainsMode,
	plainColumn,
	simpleSearchInputDef,
	startsWithMode,
} from "@/lib/domain";
import {
	eq,
	gt,
	input,
	isIn,
	literal,
	not,
	prop,
	sessionContext,
	term,
} from "@/lib/domain/predicate";
import {
	caseRowDisplayValue,
	caseRowsToFormPreloads,
	caseRowToFormPreload,
	mapCaseListPreviewError,
	mapFilterPreviewError,
	mapPopulateSampleCasesError,
	mapSubmitFormError,
	pickBlueprintDoc,
} from "../caseDataBindingClient";
import {
	applyCloseMutation,
	applyFollowupMutation,
	applyRegistrationMutation,
	applySurveyMutation,
	readCaseData,
	readCaseListPreview,
	readCases,
	readFilterPreview,
	resetSampleCases,
	SAMPLE_CASE_DEFAULT_COUNT,
	seedSampleCases,
} from "../caseDataBindingHelpers";
import type { SubmissionMutation } from "../caseDataBindingTypes";
import type { SearchInputValues } from "../runtimeBindings";

// ---------------------------------------------------------------
// Module mocks for the `submitFormAction` Server Action tests
// ---------------------------------------------------------------
//
// `vi.mock` calls are hoisted above every import — they apply to
// the whole file. The helper-level tests above the
// `submitFormAction` block don't import `getSession` or
// `withProjectContext`, so the mock surface is invisible to them.
// `vi.importActual` preserves every other case-store export so the
// typed-error classes the helper-level tests rely on stay real
// (`instanceof` checks would break otherwise).
vi.mock("@/lib/auth-utils", () => ({
	getSession: vi.fn(),
}));
vi.mock("@/lib/case-store", async () => {
	const actual =
		await vi.importActual<typeof import("@/lib/case-store")>(
			"@/lib/case-store",
		);
	return {
		...actual,
		withProjectContext: vi.fn(),
	};
});
// The schema heal's Postgres boundary, stubbed for the SAME reason the
// auth boundary is: the actions wrap their store in
// `schemaHealingCaseStore`, whose heal loads the persisted blueprint via
// `loadApp` — the REAL one lazily constructs the shared Cloud SQL
// `Connector` + `pg.Pool`, whose background keepalive is an async-resource
// leak no unit test may create. The heal-reaching action test scripts these per
// call; every other test never enters the heal (only
// `SchemaNotSyncedError` does), so the stubs stay invisible to them.
const { loadAppMock, materializeMock, resolveAppScopeMock } = vi.hoisted(
	() => ({
		loadAppMock: vi.fn(),
		materializeMock: vi.fn(),
		resolveAppScopeMock: vi.fn(),
	}),
);
vi.mock("@/lib/db/apps", () => ({ loadApp: loadAppMock }));
vi.mock("@/lib/db/materializeCaseStoreSchemas", () => ({
	materializeCaseStoreSchemas: materializeMock,
}));
// `gatedCaseStore` (the actions' store constructor) resolves the app's
// Project + verifies membership through `resolveAppScope`; the real one
// reads Postgres + the auth tables. Mock it to a success by default (see
// `beforeEach`); the IDOR-denial tests override it per-test with a
// rejected `AppAccessError`. Spread the actual module so `AppAccessError`
// stays the real class — the actions' catch does `err instanceof
// AppAccessError`.
vi.mock("@/lib/db/appAccess", async () => {
	const actual =
		await vi.importActual<typeof import("@/lib/db/appAccess")>(
			"@/lib/db/appAccess",
		);
	return { ...actual, resolveAppScope: resolveAppScopeMock };
});

// ---------------------------------------------------------------
// Per-test database lifecycle (mirrors PostgresCaseStore tests)
// ---------------------------------------------------------------

const dbHandle = setupPerTestDatabase({
	databaseNamePrefix: "binding_test_",
});

beforeEach(async () => {
	// The action tests queue per-call resolutions on the shared
	// `getSession` / `withProjectContext` module mocks via
	// `mockResolvedValueOnce`. The `clearMocks` config runs `mockClear`
	// (call history only) — it does NOT drain a `*Once` queue, so a test
	// that short-circuits before consuming its queued value would leak it
	// to the next test and misattribute that test's failure. Reset every
	// mock's queue so each test is diagnostically independent. (Only the
	// module mocks — auth, store context, and the heal's Postgres
	// boundary — are vi.fn()s at this point; in-test spies/stubs are
	// created inside the bodies that follow.)
	vi.resetAllMocks();
	// Default the membership gate to success — the common case. The
	// denial-path tests override this with a rejected `AppAccessError`.
	// `withProjectContext` is mocked per-test to return the store under
	// test, so the resolved `projectId` here is inert; it only needs to
	// not throw.
	resolveAppScopeMock.mockResolvedValue({
		projectId: PROJECT_A,
		role: "owner",
		actorUserId: OWNER_A,
	});
	await runCaseStoreMigrations(dbHandle.db);
});

// ---------------------------------------------------------------
// Test fixture
// ---------------------------------------------------------------

const APP_ID = "app-binding";
const OWNER_A = "owner-a";
const OWNER_B = "owner-b";
const PROJECT_A = "project-a";

const ALICE_CASE_ID = "40000000-0000-0000-0000-000000000001";
const BOB_CASE_ID = "40000000-0000-0000-0000-000000000002";
const HOUSEHOLD_CASE_ID = "40000000-0000-0000-0000-000000000003";
const VISIT_CASE_ID = "40000000-0000-0000-0000-000000000004";

/**
 * The case type the binding tests bind against — `patient` with
 * one text property (`name`) and one int property (`age`). Same
 * shape the contract harness uses, intentionally — the binding
 * tests are the case-store contract's running-app-view-side
 * acceptance tests.
 */
const PATIENT_CASE_TYPE: CaseType = {
	name: "patient",
	properties: [
		{ name: "name", label: "Name", data_type: "text" },
		{ name: "age", label: "Age", data_type: "int" },
	],
};

/**
 * Child case-type with `parent_type: "patient"` so the submission-
 * mutation tests exercise the child-insert + parent-threading path
 * without re-deriving the schema. Two simple text properties keep
 * the assertion targets stable across child-related tests.
 */
const VISIT_CASE_TYPE: CaseType = {
	name: "visit",
	parent_type: "patient",
	properties: [{ name: "notes", label: "Notes", data_type: "text" }],
};

/**
 * Grandparent case-type for the ancestor-walk tests — `household ←
 * patient ← visit` gives `readCaseData` a two-hop chain to return
 * nearest-first. (The catalog's `parent_type` is authoring metadata;
 * the walk itself follows the ROWS' `parent_case_id` links.)
 */
const HOUSEHOLD_CASE_TYPE: CaseType = {
	name: "household",
	properties: [{ name: "head_name", label: "Head of household" }],
};

/**
 * Case-type carrying every formatted-property data type AJV's strict
 * mode rejects on an empty string — `format: date`, `format: time`,
 * `format: date-time`, the geopoint pattern, plus `integer` and
 * `number` types. Used by the registration helper test that pins
 * the empty-properties round-trip: a registration mutation whose
 * `properties` is `{}` must clear AJV against this schema.
 *
 * `caseTypeToJsonSchema` emits `{ type: "object" }` with no
 * `required` keys, so an empty `properties` document trivially
 * passes any case-type schema. The structural protection is real
 * but easy to break — adding `required` keys to the generator
 * would silently regress every running-app form whose user fills
 * only `case_name` against a case-type with formatted properties.
 * This fixture turns the structural protection into an asserted
 * invariant.
 */
const FORMATTED_PROPS_CASE_TYPE: CaseType = {
	name: "patient",
	properties: [
		{ name: "name", label: "Name", data_type: "text" },
		{ name: "age", label: "Age", data_type: "int" },
		{ name: "weight", label: "Weight", data_type: "decimal" },
		{ name: "dob", label: "DOB", data_type: "date" },
		{ name: "wake_time", label: "Wake time", data_type: "time" },
		{ name: "last_seen", label: "Last seen", data_type: "datetime" },
		{ name: "home_location", label: "Home", data_type: "geopoint" },
	],
};

/**
 * Local wrapper that pins this suite's `APP_ID`. The shared
 * `buildSimpleBlueprint` helper takes `(caseTypes, appId)`;
 * wrapping it here keeps each test body to a one-liner.
 */
function buildBlueprint(caseTypes: CaseType[]) {
	return buildSimpleBlueprint(caseTypes, APP_ID);
}

/**
 * Construct a `PostgresCaseStore` bound to `ownerId` against the
 * per-test database. Bypasses `withProjectContext` (which threads
 * through the production singleton) — same shape the contract
 * harness's factory uses.
 */
function makeStore(
	projectId: string,
	actorUserId: string = projectId,
): CaseStore {
	return new PostgresCaseStore({
		projectId,
		actorUserId,
		db: dbHandle.db as unknown as Kysely<Database>,
		sampleGenerator: new HeuristicCaseGenerator(),
	});
}

/**
 * Seed the case-type's JSON Schema so subsequent inserts pass
 * AJV validation. Mirrors the shape the contract harness uses —
 * one call per test body before the first `insert`. Builds the
 * `caseTypeSchemas` map at the call boundary so the test reuses
 * the same `BlueprintDoc → ReadonlyMap<string, CaseType>` lift the
 * production helpers run.
 */
async function seedSchema(
	store: CaseStore,
	blueprint: BlueprintDoc,
	caseType: string,
): Promise<void> {
	await store.applySchemaChange({
		appId: APP_ID,
		caseType,
		caseTypeSchemas: buildCaseTypeMap(blueprint),
	});
}

/**
 * Build a synthetic `CaseRow` literal for tests that exercise the
 * helpers' coercion behavior on JSONB shapes the JSON Schema
 * validator would reject at write time (boolean / null / array /
 * object values against typed properties). The helpers are pure
 * and operate against `CaseRow.properties` directly, so a synthetic
 * row sidesteps the round-trip through `insert` without losing
 * coverage — other write paths (sample-data generator, direct
 * admin writes, future bulk-import flows) can produce these
 * shapes, so the helper has to handle the full `JsonValue` tree.
 */
function buildSyntheticRow(properties: JsonObject): CaseRow {
	return {
		case_id: "test-id",
		app_id: APP_ID,
		case_type: "patient",
		owner_id: OWNER_A,
		status: "open",
		opened_on: null,
		modified_on: null,
		closed_on: null,
		case_name: "Synthetic Case",
		external_id: null,
		parent_case_id: null,
		properties,
	};
}

// ---------------------------------------------------------------
// `readCases`
// ---------------------------------------------------------------

describe("readCases", () => {
	it("returns the empty arm when no rows exist", async () => {
		const store = makeStore(OWNER_A);
		const blueprint = buildBlueprint([PATIENT_CASE_TYPE]);
		await seedSchema(store, blueprint, "patient");

		const result = await readCases(store, {
			appId: APP_ID,
			caseType: "patient",
		});
		expect(result.kind).toBe("empty");
	});

	it("returns the rows arm with the inserted rows", async () => {
		const store = makeStore(OWNER_A);
		const blueprint = buildBlueprint([PATIENT_CASE_TYPE]);
		await seedSchema(store, blueprint, "patient");

		await store.insert({
			appId: APP_ID,
			row: {
				case_id: ALICE_CASE_ID,
				case_type: "patient",
				case_name: "test-case",
				status: "open",
				properties: { name: "Alice", age: 30 },
			},
		});
		await store.insert({
			appId: APP_ID,
			row: {
				case_id: BOB_CASE_ID,
				case_type: "patient",
				case_name: "test-case",
				status: "open",
				properties: { name: "Bob", age: 45 },
			},
		});

		const result = await readCases(store, {
			appId: APP_ID,
			caseType: "patient",
		});
		expect(result.kind).toBe("rows");
		if (result.kind !== "rows") return;
		expect(result.rows).toHaveLength(2);
		const ids = result.rows.map((r) => r.case_id).sort();
		expect(ids).toEqual([ALICE_CASE_ID, BOB_CASE_ID].sort());
	});

	it("uses Results order, not Details order, to break equal sort priorities", async () => {
		const store = makeStore(OWNER_A);
		const blueprint = buildBlueprint([PATIENT_CASE_TYPE]);
		await seedSchema(store, blueprint, "patient");

		const CAROL_CASE_ID = "40000000-0000-0000-0000-000000000003";
		for (const row of [
			{ caseId: ALICE_CASE_ID, name: "A", age: 2 },
			{ caseId: BOB_CASE_ID, name: "A", age: 1 },
			{ caseId: CAROL_CASE_ID, name: "B", age: 0 },
		]) {
			await store.insert({
				appId: APP_ID,
				row: {
					case_id: row.caseId,
					case_type: "patient",
					case_name: row.name,
					status: "open",
					properties: { name: row.name, age: row.age },
				},
			});
		}

		const result = await readCases(store, {
			appId: APP_ID,
			caseType: "patient",
			caseTypeSchemas: buildCaseTypeMap(blueprint),
			caseListConfig: {
				columns: [
					plainColumn(NAME_COLUMN_UUID, "name", "Name", {
						sort: { direction: "asc", priority: 0 },
						listOrder: "a",
						detailOrder: "b",
					}),
					plainColumn(
						asUuid("10000000-0000-0000-0000-000000000003"),
						"age",
						"Age",
						{
							sort: { direction: "asc", priority: 0 },
							listOrder: "b",
							detailOrder: "a",
						},
					),
				],
				searchInputs: [],
			},
		});

		expect(result.kind).toBe("rows");
		if (result.kind !== "rows") return;
		// Results order makes `name` primary, then `age`: B, A, C. If
		// Details order leaked into sorting, `age` would lead: C, B, A.
		expect(result.rows.map((row) => row.case_id)).toEqual([
			BOB_CASE_ID,
			ALICE_CASE_ID,
			CAROL_CASE_ID,
		]);
	});

	it("respects tenant scope — owner B sees an empty case-type that owner A populated", async () => {
		const storeA = makeStore(OWNER_A);
		const blueprint = buildBlueprint([PATIENT_CASE_TYPE]);
		await seedSchema(storeA, blueprint, "patient");
		await storeA.insert({
			appId: APP_ID,
			row: {
				case_id: ALICE_CASE_ID,
				case_type: "patient",
				case_name: "test-case",
				status: "open",
				properties: { name: "Alice", age: 30 },
			},
		});

		const storeB = makeStore(OWNER_B);
		const result = await readCases(storeB, {
			appId: APP_ID,
			caseType: "patient",
		});
		expect(result.kind).toBe("empty");
	});
});

// ---------------------------------------------------------------
// `readCases` — runtime-bindings composition
// ---------------------------------------------------------------
//
// Acceptance tests for the `inputValues?` extension. The helper
// composes `composeRuntimeFilter(searchInputs, inputValues, caseType)`
// (from `../runtimeBindings`) and AND-joins the result with
// `caseListConfig.filter` to form the predicate that flows to
// `store.query(...)`. The unified-filter slot is the single source
// for both the case-list always-on filter and the search-input
// contributions. The tests below pin each compositional arm against
// real Postgres state — the SQL layer is the authoritative semantic.

const READCASES_PRIMARY_INPUT_UUID = asUuid(
	"60000000-0000-0000-0000-000000000001",
);
const READCASES_SECONDARY_INPUT_UUID = asUuid(
	"60000000-0000-0000-0000-000000000002",
);
const READCASES_ADVANCED_INPUT_UUID = asUuid(
	"60000000-0000-0000-0000-000000000003",
);

describe("readCases — running-app search-input composition", () => {
	it("excludes resolved owner ids inside the case-store query", async () => {
		const store = makeStore(OWNER_A);
		const excludedOwnerStore = makeStore(OWNER_A, "excluded-owner");
		const visibleOwnerStore = makeStore(OWNER_A, "visible-owner");
		const blueprint = buildBlueprint([PATIENT_CASE_TYPE]);
		await seedSchema(store, blueprint, "patient");
		await excludedOwnerStore.insert({
			appId: APP_ID,
			row: {
				case_id: ALICE_CASE_ID,
				case_type: "patient",
				case_name: "Alice",
				status: "open",
				properties: { name: "Alice", age: 30 },
			},
		});
		await visibleOwnerStore.insert({
			appId: APP_ID,
			row: {
				case_id: BOB_CASE_ID,
				case_type: "patient",
				case_name: "Bob",
				status: "open",
				properties: { name: "Bob", age: 40 },
			},
		});

		const result = await readCases(store, {
			appId: APP_ID,
			caseType: "patient",
			caseTypeSchemas: buildCaseTypeMap(blueprint),
			caseListConfig: { columns: [], searchInputs: [] },
			excludedOwnerIds: ["excluded-owner"],
		});

		expect(result.kind).toBe("rows");
		if (result.kind !== "rows") return;
		expect(result.rows.map((row) => [row.case_id, row.owner_id])).toEqual([
			[BOB_CASE_ID, "visible-owner"],
		]);
	});

	it("reads as before when caseListConfig has no search inputs (filter alone)", async () => {
		// Pins the no-runtime-contribution short-circuit. The helper
		// MUST pass `caseListConfig.filter` through to `store.query`
		// verbatim when `searchInputs` is empty — the running-app
		// fallback when the author hasn't declared any inputs.
		const store = makeStore(OWNER_A);
		const blueprint = buildBlueprint([PATIENT_CASE_TYPE]);
		await seedSchema(store, blueprint, "patient");
		await store.insert({
			appId: APP_ID,
			row: {
				case_id: ALICE_CASE_ID,
				case_type: "patient",
				case_name: "Alice",
				status: "open",
				properties: { name: "Alice", age: 25 },
			},
		});
		await store.insert({
			appId: APP_ID,
			row: {
				case_id: BOB_CASE_ID,
				case_type: "patient",
				case_name: "Bob",
				status: "open",
				properties: { name: "Bob", age: 40 },
			},
		});

		const result = await readCases(store, {
			appId: APP_ID,
			caseType: "patient",
			caseTypeSchemas: buildCaseTypeMap(blueprint),
			caseListConfig: {
				columns: [],
				searchInputs: [],
				// `age > 30` — only Bob matches the always-on filter.
				filter: gt(prop("patient", "age"), literal(30)),
			},
			// Even with `inputValues` defined, the helper must skip
			// `composeRuntimeFilter` because `searchInputs.length === 0`.
			inputValues: new Map(),
		});
		expect(result.kind).toBe("rows");
		if (result.kind !== "rows") return;
		expect(result.rows).toHaveLength(1);
		expect(result.rows[0]?.case_id).toBe(BOB_CASE_ID);
	});

	it("narrows the row set when a simple-arm exact input matches a single row", async () => {
		// Simple-arm dispatch with `exact` mode. Two cases differ on
		// the `name` property; typing one value into the input must
		// drop the other from the result.
		const store = makeStore(OWNER_A);
		const blueprint = buildBlueprint([PATIENT_CASE_TYPE]);
		await seedSchema(store, blueprint, "patient");
		await store.insert({
			appId: APP_ID,
			row: {
				case_id: ALICE_CASE_ID,
				case_type: "patient",
				case_name: "Alice",
				status: "open",
				properties: { name: "Alice", age: 30 },
			},
		});
		await store.insert({
			appId: APP_ID,
			row: {
				case_id: BOB_CASE_ID,
				case_type: "patient",
				case_name: "Bob",
				status: "open",
				properties: { name: "Bob", age: 40 },
			},
		});

		const result = await readCases(store, {
			appId: APP_ID,
			caseType: "patient",
			caseTypeSchemas: buildCaseTypeMap(blueprint),
			caseListConfig: {
				columns: [],
				searchInputs: [
					simpleSearchInputDef(
						READCASES_PRIMARY_INPUT_UUID,
						"name",
						"Name",
						"text",
						"name",
						{ mode: exactMode() },
					),
				],
			},
			inputValues: new Map([["name", "Alice"]]),
		});
		expect(result.kind).toBe("rows");
		if (result.kind !== "rows") return;
		expect(result.rows).toHaveLength(1);
		expect(result.rows[0]?.case_id).toBe(ALICE_CASE_ID);
	});

	it("narrows the row set when an advanced-arm input substitutes its value", async () => {
		// Advanced-arm: the input's `predicate` AST carries an
		// `input(name)` term reference; `composeRuntimeFilter`'s
		// substituter walks the AST and binds the typed value at every
		// value-position match before the predicate reaches
		// `store.query(...)`.
		const store = makeStore(OWNER_A);
		const blueprint = buildBlueprint([PATIENT_CASE_TYPE]);
		await seedSchema(store, blueprint, "patient");
		await store.insert({
			appId: APP_ID,
			row: {
				case_id: ALICE_CASE_ID,
				case_type: "patient",
				case_name: "Alice",
				status: "open",
				properties: { name: "Alice", age: 30 },
			},
		});
		await store.insert({
			appId: APP_ID,
			row: {
				case_id: BOB_CASE_ID,
				case_type: "patient",
				case_name: "Bob",
				status: "open",
				properties: { name: "Bob", age: 40 },
			},
		});

		// `prop("name") starts-with input("name_prefix")` — the
		// `inputValues` map binds "Al" at the substitution site, so
		// only Alice survives.
		const result = await readCases(store, {
			appId: APP_ID,
			caseType: "patient",
			caseTypeSchemas: buildCaseTypeMap(blueprint),
			caseListConfig: {
				columns: [],
				searchInputs: [
					advancedSearchInputDef(
						READCASES_ADVANCED_INPUT_UUID,
						"name_prefix",
						"Name starts with",
						"text",
						// Wire-shape: match(prop(...), "starts-with", input(...))
						{
							kind: "match",
							property: prop("patient", "name"),
							value: { kind: "term", term: input("name_prefix") },
							mode: "starts-with",
						},
					),
				],
			},
			inputValues: new Map([["name_prefix", "Al"]]),
		});
		expect(result.kind).toBe("rows");
		if (result.kind !== "rows") return;
		expect(result.rows).toHaveLength(1);
		expect(result.rows[0]?.case_id).toBe(ALICE_CASE_ID);
	});

	it("AND-composes multiple contributing inputs across simple-arm modes", async () => {
		// Mixed-arm composition: a `select` exact match on `status`
		// AND a `text` starts-with match on `name`. Each contributes
		// a clause; the helper folds them into one conjunction that
		// reaches `store.query`. Three cases sit in the store; only
		// the row matching BOTH inputs survives.
		const store = makeStore(OWNER_A);
		const blueprint = buildBlueprint([PATIENT_CASE_TYPE]);
		await seedSchema(store, blueprint, "patient");
		const CAROL_CASE_ID = "40000000-0000-0000-0000-000000000003";
		await store.insert({
			appId: APP_ID,
			row: {
				case_id: ALICE_CASE_ID,
				case_type: "patient",
				case_name: "Alice",
				status: "open",
				properties: { name: "Alice", age: 30 },
			},
		});
		await store.insert({
			appId: APP_ID,
			row: {
				case_id: BOB_CASE_ID,
				case_type: "patient",
				case_name: "Bob",
				// Bob's status is closed — the status input drops him.
				status: "closed",
				properties: { name: "Bob", age: 40 },
			},
		});
		await store.insert({
			appId: APP_ID,
			row: {
				case_id: CAROL_CASE_ID,
				case_type: "patient",
				case_name: "Carol",
				// Carol matches the status input but not the name input.
				status: "open",
				properties: { name: "Carol", age: 35 },
			},
		});

		const result = await readCases(store, {
			appId: APP_ID,
			caseType: "patient",
			caseTypeSchemas: buildCaseTypeMap(blueprint),
			caseListConfig: {
				columns: [],
				searchInputs: [
					// `name` starts-with — text-mode input the widget
					// would render as a text field with a starts-with
					// mode. Matches Alice (starts with "Al"); skips Bob
					// + Carol.
					simpleSearchInputDef(
						READCASES_PRIMARY_INPUT_UUID,
						"name",
						"Name starts with",
						"text",
						"name",
						{ mode: startsWithMode() },
					),
					// `status` exact — select-mode input. Matches
					// Alice + Carol; drops Bob.
					simpleSearchInputDef(
						READCASES_SECONDARY_INPUT_UUID,
						"status",
						"Status",
						"select",
						"status",
						{ mode: exactMode() },
					),
				],
			},
			// `name=Al, status=open` — the intersection is Alice
			// alone.
			inputValues: new Map([
				["name", "Al"],
				["status", "open"],
			]),
		});
		expect(result.kind).toBe("rows");
		if (result.kind !== "rows") return;
		expect(result.rows).toHaveLength(1);
		expect(result.rows[0]?.case_id).toBe(ALICE_CASE_ID);
	});

	it("short-circuits to filter-only results when every search-input value is empty", async () => {
		// All-empty `inputValues`: `composeRuntimeFilter` returns
		// `match-all` (the conjunction-identity element), the helper
		// drops it before AND-composing, and the case-store sees the
		// same predicate it would have seen with the no-input
		// passthrough. The always-on `caseListConfig.filter` still
		// applies.
		const store = makeStore(OWNER_A);
		const blueprint = buildBlueprint([PATIENT_CASE_TYPE]);
		await seedSchema(store, blueprint, "patient");
		await store.insert({
			appId: APP_ID,
			row: {
				case_id: ALICE_CASE_ID,
				case_type: "patient",
				case_name: "Alice",
				status: "open",
				properties: { name: "Alice", age: 25 },
			},
		});
		await store.insert({
			appId: APP_ID,
			row: {
				case_id: BOB_CASE_ID,
				case_type: "patient",
				case_name: "Bob",
				status: "open",
				properties: { name: "Bob", age: 40 },
			},
		});

		const result = await readCases(store, {
			appId: APP_ID,
			caseType: "patient",
			caseTypeSchemas: buildCaseTypeMap(blueprint),
			caseListConfig: {
				columns: [],
				searchInputs: [
					simpleSearchInputDef(
						READCASES_PRIMARY_INPUT_UUID,
						"name",
						"Name",
						"text",
						"name",
					),
				],
				// Filter only — `age > 30`. Bob alone survives.
				filter: gt(prop("patient", "age"), literal(30)),
			},
			// Empty values bag — no runtime contribution. The
			// constructed predicate must equal the filter-only path.
			inputValues: new Map() satisfies SearchInputValues,
		});
		expect(result.kind).toBe("rows");
		if (result.kind !== "rows") return;
		expect(result.rows).toHaveLength(1);
		expect(result.rows[0]?.case_id).toBe(BOB_CASE_ID);
	});

	it("AND-composes the unified filter with the runtime contribution", async () => {
		// Both halves contribute non-trivially. `caseListConfig.filter`
		// narrows to `age > 30`; the simple-arm `name` input adds an
		// equality clause. Only the row passing BOTH predicates lands.
		const store = makeStore(OWNER_A);
		const blueprint = buildBlueprint([PATIENT_CASE_TYPE]);
		await seedSchema(store, blueprint, "patient");
		await store.insert({
			appId: APP_ID,
			row: {
				case_id: ALICE_CASE_ID,
				case_type: "patient",
				case_name: "Alice",
				// `age > 30` rejects Alice.
				status: "open",
				properties: { name: "Alice", age: 25 },
			},
		});
		await store.insert({
			appId: APP_ID,
			row: {
				case_id: BOB_CASE_ID,
				case_type: "patient",
				case_name: "Bob",
				status: "open",
				// Bob clears `age > 30` AND matches `name = "Bob"`.
				properties: { name: "Bob", age: 40 },
			},
		});

		const result = await readCases(store, {
			appId: APP_ID,
			caseType: "patient",
			caseTypeSchemas: buildCaseTypeMap(blueprint),
			caseListConfig: {
				columns: [],
				searchInputs: [
					simpleSearchInputDef(
						READCASES_PRIMARY_INPUT_UUID,
						"name",
						"Name",
						"text",
						"name",
						{ mode: exactMode() },
					),
				],
				filter: gt(prop("patient", "age"), literal(30)),
			},
			inputValues: new Map([["name", "Bob"]]),
		});
		expect(result.kind).toBe("rows");
		if (result.kind !== "rows") return;
		expect(result.rows).toHaveLength(1);
		expect(result.rows[0]?.case_id).toBe(BOB_CASE_ID);
	});

	it("AND-composes simple-arm multi-select-contains across a single property", async () => {
		// Pins the multi-select arm: the input value is a
		// comma-separated token list; the runtime layer expands it to
		// a `multi-select-contains` predicate. The case-store's JSONB
		// `?` / `@>` operators select rows whose array property
		// contains the supplied token(s). Two rows differ on a
		// multi-select-typed `tags` property; the input narrows to
		// rows containing "vip".
		const TAGGED_CASE_TYPE: CaseType = {
			name: "patient",
			properties: [
				{ name: "name", label: "Name", data_type: "text" },
				{
					name: "tags",
					label: "Tags",
					data_type: "multi_select",
					options: [
						{ value: "vip", label: "VIP" },
						{ value: "new", label: "New" },
						{ value: "review", label: "Review" },
					],
				},
			],
		};
		const store = makeStore(OWNER_A);
		const blueprint = buildBlueprint([TAGGED_CASE_TYPE]);
		await seedSchema(store, blueprint, "patient");
		await store.insert({
			appId: APP_ID,
			row: {
				case_id: ALICE_CASE_ID,
				case_type: "patient",
				case_name: "Alice",
				status: "open",
				properties: { name: "Alice", tags: ["vip", "review"] },
			},
		});
		await store.insert({
			appId: APP_ID,
			row: {
				case_id: BOB_CASE_ID,
				case_type: "patient",
				case_name: "Bob",
				status: "open",
				properties: { name: "Bob", tags: ["new"] },
			},
		});

		const result = await readCases(store, {
			appId: APP_ID,
			caseType: "patient",
			caseTypeSchemas: buildCaseTypeMap(blueprint),
			caseListConfig: {
				columns: [],
				searchInputs: [
					simpleSearchInputDef(
						READCASES_PRIMARY_INPUT_UUID,
						"tags",
						"Tags",
						"select",
						"tags",
						{ mode: multiSelectContainsMode("any") },
					),
				],
			},
			inputValues: new Map([["tags", "vip"]]),
		});
		expect(result.kind).toBe("rows");
		if (result.kind !== "rows") return;
		expect(result.rows).toHaveLength(1);
		expect(result.rows[0]?.case_id).toBe(ALICE_CASE_ID);
	});
});

// ---------------------------------------------------------------
// `resetSampleCases`
// ---------------------------------------------------------------

describe("resetSampleCases", () => {
	it("deletes the prior sample population and regenerates a fresh row set", async () => {
		// The helper wraps `CaseStore.resetSampleData` — the atomic
		// delete-then-regenerate path. After the call, the case-type
		// MUST hold `SAMPLE_CASE_DEFAULT_COUNT` rows with case_ids
		// that differ from the prior population (the store picks a
		// fresh seed at call time, so the regenerated rows have new
		// uuids and likely differ in property content).
		const store = makeStore(OWNER_A);
		const blueprint = buildBlueprint([PATIENT_CASE_TYPE]);
		await seedSchema(store, blueprint, "patient");

		// Seed the initial population so the reset has something to
		// drop. Snapshot the resulting case_ids — they're the
		// distinct-row check below.
		const seeded = await seedSampleCases(store, {
			appId: APP_ID,
			caseType: PATIENT_CASE_TYPE,
		});
		expect(seeded.kind).toBe("ok");
		if (seeded.kind !== "ok") return;
		expect(seeded.inserted).toBe(SAMPLE_CASE_DEFAULT_COUNT);
		const before = await readCases(store, {
			appId: APP_ID,
			caseType: "patient",
		});
		if (before.kind !== "rows") throw new Error("expected seeded rows");
		const beforeIds = new Set(before.rows.map((r) => r.case_id));

		const result = await resetSampleCases(store, {
			appId: APP_ID,
			caseType: PATIENT_CASE_TYPE,
		});
		expect(result.kind).toBe("ok");
		if (result.kind !== "ok") return;
		expect(result.inserted).toBe(SAMPLE_CASE_DEFAULT_COUNT);

		// Population after reset MUST equal the default count — the
		// helper deleted the old rows before regenerating.
		const after = await readCases(store, {
			appId: APP_ID,
			caseType: "patient",
		});
		if (after.kind !== "rows") throw new Error("expected regenerated rows");
		expect(after.rows).toHaveLength(SAMPLE_CASE_DEFAULT_COUNT);

		// Every regenerated row's case_id must be new — the reset
		// path generates fresh uuid v7 values, never reuses the
		// prior population's ids.
		for (const row of after.rows) {
			expect(beforeIds.has(row.case_id)).toBe(false);
		}
	});
});

// ---------------------------------------------------------------
// `readCaseData`
// ---------------------------------------------------------------

describe("readCaseData", () => {
	it("returns the row arm for an existing case-id", async () => {
		const store = makeStore(OWNER_A);
		const blueprint = buildBlueprint([PATIENT_CASE_TYPE]);
		await seedSchema(store, blueprint, "patient");
		await store.insert({
			appId: APP_ID,
			row: {
				case_id: ALICE_CASE_ID,
				case_type: "patient",
				case_name: "test-case",
				status: "open",
				properties: { name: "Alice", age: 30 },
			},
		});

		const result = await readCaseData(store, {
			appId: APP_ID,
			caseType: "patient",
			caseId: ALICE_CASE_ID,
			ancestorDepth: 5,
		});
		expect(result.kind).toBe("row");
		if (result.kind !== "row") return;
		expect(result.row.case_id).toBe(ALICE_CASE_ID);
		expect(result.row.properties).toEqual({ name: "Alice", age: 30 });
		// A root case (no parent link) carries an empty ancestor chain.
		expect(result.ancestors).toEqual([]);
	});

	it("walks the ancestor chain nearest-first onto the row arm", async () => {
		const store = makeStore(OWNER_A);
		const blueprint = buildBlueprint([
			HOUSEHOLD_CASE_TYPE,
			PATIENT_CASE_TYPE,
			VISIT_CASE_TYPE,
		]);
		await seedSchema(store, blueprint, "household");
		await seedSchema(store, blueprint, "patient");
		await seedSchema(store, blueprint, "visit");
		await store.insert({
			appId: APP_ID,
			row: {
				case_id: HOUSEHOLD_CASE_ID,
				case_type: "household",
				case_name: "Smith household",
				status: "open",
				external_id: "HH-42",
				properties: { head_name: "John Smith" },
			},
		});
		await store.insert({
			appId: APP_ID,
			row: {
				case_id: ALICE_CASE_ID,
				case_type: "patient",
				case_name: "Alice",
				status: "open",
				parent_case_id: HOUSEHOLD_CASE_ID,
				properties: { name: "Alice", age: 30 },
			},
		});
		await store.insert({
			appId: APP_ID,
			row: {
				case_id: VISIT_CASE_ID,
				case_type: "visit",
				case_name: "Visit 1",
				status: "open",
				parent_case_id: ALICE_CASE_ID,
				properties: { notes: "initial" },
			},
		});

		const result = await readCaseData(store, {
			appId: APP_ID,
			caseType: "visit",
			caseId: VISIT_CASE_ID,
			ancestorDepth: 5,
		});
		expect(result.kind).toBe("row");
		if (result.kind !== "row") return;
		expect(result.ancestors.map((a) => a.case_id)).toEqual([
			ALICE_CASE_ID,
			HOUSEHOLD_CASE_ID,
		]);
		// The rows are full `CaseRow`s — the form engine flattens them
		// per type, so the property bags must arrive intact.
		expect(result.ancestors[1]?.properties).toEqual({
			head_name: "John Smith",
		});
		// `external_id` rides the traverse projection like every other
		// reserved scalar — an ancestor's `#<type>/external-id` must
		// preview the same value the wire's casedb walk returns.
		expect(result.ancestors[1]?.external_id).toBe("HH-42");
	});

	it("walks only as deep as the requested ancestorDepth", async () => {
		const store = makeStore(OWNER_A);
		const blueprint = buildBlueprint([
			HOUSEHOLD_CASE_TYPE,
			PATIENT_CASE_TYPE,
			VISIT_CASE_TYPE,
		]);
		await seedSchema(store, blueprint, "household");
		await seedSchema(store, blueprint, "patient");
		await seedSchema(store, blueprint, "visit");
		await store.insert({
			appId: APP_ID,
			row: {
				case_id: HOUSEHOLD_CASE_ID,
				case_type: "household",
				case_name: "Smith household",
				status: "open",
				properties: {},
			},
		});
		await store.insert({
			appId: APP_ID,
			row: {
				case_id: ALICE_CASE_ID,
				case_type: "patient",
				case_name: "Alice",
				status: "open",
				parent_case_id: HOUSEHOLD_CASE_ID,
				properties: {},
			},
		});
		await store.insert({
			appId: APP_ID,
			row: {
				case_id: VISIT_CASE_ID,
				case_type: "visit",
				case_name: "Visit 1",
				status: "open",
				parent_case_id: ALICE_CASE_ID,
				properties: {},
			},
		});

		// Depth 1: only the direct parent — the caller's blueprint says
		// no ref can address deeper, so no deeper hop is paid for.
		const shallow = await readCaseData(store, {
			appId: APP_ID,
			caseType: "visit",
			caseId: VISIT_CASE_ID,
			ancestorDepth: 1,
		});
		expect(shallow.kind).toBe("row");
		if (shallow.kind !== "row") return;
		expect(shallow.ancestors.map((a) => a.case_id)).toEqual([ALICE_CASE_ID]);

		// Depth 0 (and any non-finite/negative garbage a crafted request
		// could send) clamps to no walk at all.
		const none = await readCaseData(store, {
			appId: APP_ID,
			caseType: "visit",
			caseId: VISIT_CASE_ID,
			ancestorDepth: Number.NaN,
		});
		expect(none.kind).toBe("row");
		if (none.kind !== "row") return;
		expect(none.ancestors).toEqual([]);
	});

	it("degrades to the partial chain when a hop throws mid-walk", async () => {
		const store = makeStore(OWNER_A);
		const blueprint = buildBlueprint([
			HOUSEHOLD_CASE_TYPE,
			PATIENT_CASE_TYPE,
			VISIT_CASE_TYPE,
		]);
		await seedSchema(store, blueprint, "household");
		await seedSchema(store, blueprint, "patient");
		await seedSchema(store, blueprint, "visit");
		await store.insert({
			appId: APP_ID,
			row: {
				case_id: HOUSEHOLD_CASE_ID,
				case_type: "household",
				case_name: "Smith household",
				status: "open",
				properties: {},
			},
		});
		await store.insert({
			appId: APP_ID,
			row: {
				case_id: ALICE_CASE_ID,
				case_type: "patient",
				case_name: "Alice",
				status: "open",
				parent_case_id: HOUSEHOLD_CASE_ID,
				properties: {},
			},
		});
		await store.insert({
			appId: APP_ID,
			row: {
				case_id: VISIT_CASE_ID,
				case_type: "visit",
				case_name: "Visit 1",
				status: "open",
				parent_case_id: ALICE_CASE_ID,
				properties: {},
			},
		});

		// The chain is enrichment: the second hop's failure must not
		// fail a load whose essential row (and first ancestor) already
		// succeeded — the unreached namespace just reads blank. Explicit
		// per-method delegation (a spread would miss the class
		// prototype's methods), same shape as `schemaHealingCaseStore`.
		let calls = 0;
		const flaky: CaseStore = {
			query: (a) => store.query(a),
			count: (a) => store.count(a),
			insert: (a) => store.insert(a),
			insertWithChildren: (a) => store.insertWithChildren(a),
			update: (a) => store.update(a),
			close: (a) => store.close(a),
			traverse: (a) => {
				calls += 1;
				if (calls > 1) throw new Error("connection dropped mid-walk");
				return store.traverse(a);
			},
			applySchemaChange: (a) => store.applySchemaChange(a),
			dropSchema: (a) => store.dropSchema(a),
			generateSampleData: (a) => store.generateSampleData(a),
			resetSampleData: (a) => store.resetSampleData(a),
		};
		const result = await readCaseData(flaky, {
			appId: APP_ID,
			caseType: "visit",
			caseId: VISIT_CASE_ID,
			ancestorDepth: 5,
		});
		expect(result.kind).toBe("row");
		if (result.kind !== "row") return;
		expect(result.ancestors.map((a) => a.case_id)).toEqual([ALICE_CASE_ID]);
	});

	it("ends the walk at a dangling parent link without erroring", async () => {
		const store = makeStore(OWNER_A);
		const blueprint = buildBlueprint([PATIENT_CASE_TYPE]);
		await seedSchema(store, blueprint, "patient");
		// `parent_case_id` carries no FK — a deleted parent leaves a
		// dangling link, which must end the walk, not throw.
		await store.insert({
			appId: APP_ID,
			row: {
				case_id: ALICE_CASE_ID,
				case_type: "patient",
				case_name: "Alice",
				status: "open",
				parent_case_id: "40000000-0000-0000-0000-00000000dead",
				properties: { name: "Alice", age: 30 },
			},
		});

		const result = await readCaseData(store, {
			appId: APP_ID,
			caseType: "patient",
			caseId: ALICE_CASE_ID,
			ancestorDepth: 5,
		});
		expect(result.kind).toBe("row");
		if (result.kind !== "row") return;
		expect(result.ancestors).toEqual([]);
	});

	it("terminates on a parent-link cycle", async () => {
		const store = makeStore(OWNER_A);
		const blueprint = buildBlueprint([PATIENT_CASE_TYPE]);
		await seedSchema(store, blueprint, "patient");
		await store.insert({
			appId: APP_ID,
			row: {
				case_id: ALICE_CASE_ID,
				case_type: "patient",
				case_name: "Alice",
				status: "open",
				properties: { name: "Alice", age: 30 },
			},
		});
		await store.insert({
			appId: APP_ID,
			row: {
				case_id: BOB_CASE_ID,
				case_type: "patient",
				case_name: "Bob",
				status: "open",
				parent_case_id: ALICE_CASE_ID,
				properties: { name: "Bob", age: 60 },
			},
		});
		// Close the loop: Alice's parent becomes Bob. The seen-set must
		// stop the walk after one full lap instead of spinning.
		await store.update({
			appId: APP_ID,
			caseId: ALICE_CASE_ID,
			patch: { parent_case_id: BOB_CASE_ID },
		});

		const result = await readCaseData(store, {
			appId: APP_ID,
			caseType: "patient",
			caseId: BOB_CASE_ID,
			ancestorDepth: 5,
		});
		expect(result.kind).toBe("row");
		if (result.kind !== "row") return;
		expect(result.ancestors.map((a) => a.case_id)).toEqual([ALICE_CASE_ID]);
	});

	it("returns the missing arm for an absent case-id", async () => {
		const store = makeStore(OWNER_A);
		const blueprint = buildBlueprint([PATIENT_CASE_TYPE]);
		await seedSchema(store, blueprint, "patient");

		const result = await readCaseData(store, {
			appId: APP_ID,
			caseType: "patient",
			caseId: "does-not-exist",
			ancestorDepth: 5,
		});
		expect(result.kind).toBe("missing");
	});

	it("returns the missing arm for a cross-tenant case-id (tenant boundary stays structural)", async () => {
		const storeA = makeStore(OWNER_A);
		const blueprint = buildBlueprint([PATIENT_CASE_TYPE]);
		await seedSchema(storeA, blueprint, "patient");
		await storeA.insert({
			appId: APP_ID,
			row: {
				case_id: ALICE_CASE_ID,
				case_type: "patient",
				case_name: "test-case",
				status: "open",
				properties: { name: "Alice", age: 30 },
			},
		});

		// Owner B's store cannot see owner A's case — the binding
		// returns `missing` rather than leaking a row across the
		// tenant boundary.
		const storeB = makeStore(OWNER_B);
		const result = await readCaseData(storeB, {
			appId: APP_ID,
			caseType: "patient",
			caseId: ALICE_CASE_ID,
			ancestorDepth: 5,
		});
		expect(result.kind).toBe("missing");
	});
});

// ---------------------------------------------------------------
// `seedSampleCases`
// ---------------------------------------------------------------

describe("seedSampleCases", () => {
	it("returns the ok arm with the default insert count", async () => {
		const store = makeStore(OWNER_A);
		const blueprint = buildBlueprint([PATIENT_CASE_TYPE]);
		await seedSchema(store, blueprint, "patient");

		const result = await seedSampleCases(store, {
			appId: APP_ID,
			caseType: PATIENT_CASE_TYPE,
		});
		expect(result.kind).toBe("ok");
		if (result.kind !== "ok") return;
		expect(result.inserted).toBe(SAMPLE_CASE_DEFAULT_COUNT);

		// The seeded rows should land in the same case-type's table.
		const after = await readCases(store, {
			appId: APP_ID,
			caseType: "patient",
		});
		expect(after.kind).toBe("rows");
		if (after.kind !== "rows") return;
		expect(after.rows).toHaveLength(SAMPLE_CASE_DEFAULT_COUNT);
	});
});

// ---------------------------------------------------------------
// `caseRowToFormPreload`
// ---------------------------------------------------------------

describe("caseRowToFormPreload", () => {
	it("flattens the JSONB document into a string-valued Map", async () => {
		const store = makeStore(OWNER_A);
		const blueprint = buildBlueprint([PATIENT_CASE_TYPE]);
		await seedSchema(store, blueprint, "patient");
		await store.insert({
			appId: APP_ID,
			row: {
				case_id: ALICE_CASE_ID,
				case_type: "patient",
				case_name: "test-case",
				status: "open",
				properties: { name: "Alice", age: 30 },
			},
		});

		const result = await readCaseData(store, {
			appId: APP_ID,
			caseType: "patient",
			caseId: ALICE_CASE_ID,
			ancestorDepth: 5,
		});
		if (result.kind !== "row") throw new Error("expected row");

		const preload = caseRowToFormPreload(result.row);
		// `name` is a reserved standard alias for `case_name` — the scalar
		// column SHADOWS the same-named JSONB key, exactly as the SQL term
		// compiler resolves it (`RESERVED_SCALAR_COLUMN_BY_PROPERTY`) and
		// as the device's casedb shadows it.
		expect(preload.get("name")).toBe("test-case");
		expect(preload.get("case_name")).toBe("test-case");
		// Numbers stringify via String() — `30` becomes `"30"`.
		expect(preload.get("age")).toBe("30");
		// The reserved scalar columns ride the preload under their
		// standard names, so form expressions can read them like casedb.
		expect(preload.get("case_id")).toBe(ALICE_CASE_ID);
		expect(preload.get("status")).toBe("open");
		// Creation-stamped at insert — reads as an ISO timestamp string.
		expect(preload.get("date_opened")).toMatch(/^\d{4}-\d{2}-\d{2}T/);
		expect(preload.get("last_modified")).toMatch(/^\d{4}-\d{2}-\d{2}T/);
	});

	it("coerces every JsonValue branch to its string form", () => {
		const row = buildSyntheticRow({
			str_prop: "hello",
			num_prop: 42,
			bool_prop: true,
			null_prop: null,
			array_prop: ["a", "b"],
			object_prop: { nested: "value" },
		});

		const preload = caseRowToFormPreload(row);
		expect(preload.get("str_prop")).toBe("hello");
		expect(preload.get("num_prop")).toBe("42");
		// Booleans stringify via String() — `true` / `false` become
		// `"true"` / `"false"`.
		expect(preload.get("bool_prop")).toBe("true");
		// `null` collapses to the empty string — the form engine
		// treats absent and empty as the same domain state.
		expect(preload.get("null_prop")).toBe("");
		// Arrays are multi_select values and preload in the FORM value
		// convention — space-separated tokens (`SelectMultiField` splits
		// on " ", and submit's coerceValueForProperty splits on /\s+/) —
		// so the stored selections round-trip: options render checked and
		// an untouched submit writes the same array back.
		expect(preload.get("array_prop")).toBe("a b");
		expect(preload.get("object_prop")).toBe('{"nested":"value"}');
	});
});

// ---------------------------------------------------------------
// `caseRowsToFormPreloads`
// ---------------------------------------------------------------

describe("caseRowsToFormPreloads", () => {
	it("binds each reachable namespace to the row at its blueprint depth", () => {
		// `nickname`, not `name` — `name` is a reserved standard alias
		// whose scalar column (`case_name`) shadows the JSONB key.
		const patient = {
			...buildSyntheticRow({ nickname: "Alice" }),
			case_type: "patient",
		};
		const household = {
			...buildSyntheticRow({ head_name: "John Smith" }),
			case_id: "test-household",
			case_type: "household",
		};

		const byType = caseRowsToFormPreloads(
			patient,
			[household],
			[
				{ name: "patient", depth: 0 },
				{ name: "household", depth: 1 },
			],
		);
		expect([...byType.keys()]).toEqual(["patient", "household"]);
		expect(byType.get("patient")?.get("nickname")).toBe("Alice");
		expect(byType.get("household")?.get("head_name")).toBe("John Smith");
		// Reserved scalar aliases flatten per row — an ancestor's
		// `case_id` is addressable as `#household/case_id`.
		expect(byType.get("household")?.get("case_id")).toBe("test-household");
	});

	it("binds by depth, not row type — the wire's positional walk", () => {
		// Blueprint chain visit → patient → household, but the live data
		// chain skips a level (visit's parent IS a household row — data
		// predating a hierarchy edit, or a re-parented case). The wire's
		// `index/parent × depth` walk has NO case-type filter: depth 1
		// lands on the household row for #patient refs, and depth 2
		// walks past the chain's end for #household refs. The preview
		// must read the same rows, not same-named rows elsewhere.
		const visit = {
			...buildSyntheticRow({ notes: "initial" }),
			case_type: "visit",
		};
		const household = {
			...buildSyntheticRow({ head_name: "John Smith" }),
			case_id: "test-household",
			case_type: "household",
		};

		const byType = caseRowsToFormPreloads(
			visit,
			[household],
			[
				{ name: "visit", depth: 0 },
				{ name: "patient", depth: 1 },
				{ name: "household", depth: 2 },
			],
		);
		expect(byType.get("visit")?.get("notes")).toBe("initial");
		expect(byType.get("patient")?.get("head_name")).toBe("John Smith");
		expect(byType.has("household")).toBe(false);
	});

	it("addresses the loaded case at depth 0 on a self-parented chain", () => {
		// `reachableCaseTypes`' cycle guard emits a self-parented type
		// once, at depth 0 — so the deeper same-type row is unaddressed,
		// matching the wire (where #person/ refs always mean the loaded
		// case).
		const person = {
			...buildSyntheticRow({ nickname: "child" }),
			case_type: "person",
		};
		const parentPerson = {
			...buildSyntheticRow({ nickname: "parent" }),
			case_id: "test-parent",
			case_type: "person",
		};

		const byType = caseRowsToFormPreloads(
			person,
			[parentPerson],
			[{ name: "person", depth: 0 }],
		);
		expect(byType.get("person")?.get("nickname")).toBe("child");
		expect(byType.size).toBe(1);
	});
});

// ---------------------------------------------------------------
// `caseRowDisplayValue`
// ---------------------------------------------------------------

describe("caseRowDisplayValue", () => {
	it("reads a property as its display string and falls back to empty for absent properties", async () => {
		const store = makeStore(OWNER_A);
		const blueprint = buildBlueprint([PATIENT_CASE_TYPE]);
		await seedSchema(store, blueprint, "patient");
		await store.insert({
			appId: APP_ID,
			row: {
				case_id: ALICE_CASE_ID,
				case_type: "patient",
				case_name: "test-case",
				status: "open",
				properties: { name: "Alice", age: 30 },
			},
		});

		const result = await readCases(store, {
			appId: APP_ID,
			caseType: "patient",
		});
		if (result.kind !== "rows") throw new Error("expected rows");
		const row = result.rows[0];
		expect(row).toBeDefined();
		if (!row) return;

		// `name` is a CCHQ field ALIAS for the case name (HQ's own
		// detail-screen generator maps it — see the alias test below),
		// so it resolves to `case_name`, shadowing the JSONB property.
		expect(caseRowDisplayValue(row, "name")).toBe("test-case");
		expect(caseRowDisplayValue(row, "age")).toBe("30");
		// Absent property falls back to the empty string — covers the
		// case-list-table empty-cell render path.
		expect(caseRowDisplayValue(row, "does_not_exist")).toBe("");
	});

	it("coerces every JsonValue branch to its display string", () => {
		const row = buildSyntheticRow({
			bool_prop: false,
			null_prop: null,
			array_prop: [1, 2, 3],
			object_prop: { a: 1, b: "two" },
		});

		expect(caseRowDisplayValue(row, "bool_prop")).toBe("false");
		expect(caseRowDisplayValue(row, "null_prop")).toBe("");
		expect(caseRowDisplayValue(row, "array_prop")).toBe("[1,2,3]");
		expect(caseRowDisplayValue(row, "object_prop")).toBe('{"a":1,"b":"two"}');
	});

	// Each reserved scalar column has a dedicated dispatch arm so the
	// helper reads from the column rather than from the JSONB
	// document. The shadowing case (a blueprint declares a property
	// whose name collides with a reserved column) is rejected
	// upstream by the blueprint validator + the JSON Schema generator
	// (`case_name` is filtered, the others would fail the column-
	// name reservation gate at the wire layer); but if a row ever
	// carried a JSONB shadow value, this helper must still surface
	// the column. The synthetic row below pins both the happy path
	// (column populated, JSONB absent) AND the shadow path (JSONB
	// declared with a different value, column wins).
	it.each([
		["case_id", "real-row-id", "shadow-id"],
		["case_type", "patient", "shadow-type"],
		["owner_id", "real-owner", "shadow-owner"],
		["status", "open", "shadow-status"],
		["case_name", "Real Name", "Shadow Name"],
	])("caseRowDisplayValue resolves %s from the column, not from properties", (field, columnValue, shadowValue) => {
		// Construct a row whose JSONB document declares the same
		// key the column carries; the reserved-column dispatch
		// must read the column verbatim and ignore the JSONB shadow.
		const row: CaseRow = {
			case_id: field === "case_id" ? columnValue : "test-id",
			app_id: APP_ID,
			case_type: field === "case_type" ? columnValue : "patient",
			owner_id: field === "owner_id" ? columnValue : OWNER_A,
			status: field === "status" ? columnValue : "open",
			opened_on: null,
			modified_on: null,
			closed_on: null,
			case_name: field === "case_name" ? columnValue : "Synthetic Case",
			external_id: null,
			parent_case_id: null,
			properties: { [field]: shadowValue },
		};
		expect(caseRowDisplayValue(row, field)).toBe(columnValue);
	});

	it("resolves the CCHQ field aliases onto their columns (name / external-id / date-opened / last_modified)", () => {
		// HQ's own detail-screen generator aliases these field names
		// onto case metadata (the module-level alias map in
		// `commcare-hq/corehq/apps/app_manager/detail_screen.py` —
		// `name` → `case_name`, `external-id` → `external_id`,
		// `date-opened` → `date_opened`), so the preview's display
		// seam mirrors it: a JSONB property named `name` is shadowed
		// exactly as the device shadows it, and both spellings of the
		// hyphen/underscore pairs land on the same column. Timestamps
		// render as their ISO form (the calculated-cell coercion).
		const opened = new Date("2026-01-02T03:04:05.000Z");
		const modified = new Date("2026-02-03T04:05:06.000Z");
		const row: CaseRow = {
			case_id: "test-id",
			app_id: APP_ID,
			case_type: "patient",
			owner_id: OWNER_A,
			status: "open",
			opened_on: opened,
			modified_on: modified,
			closed_on: null,
			case_name: "Real Name",
			external_id: "EXT-1",
			parent_case_id: null,
			properties: { name: "Shadow", external_id: "shadow-ext" },
		};
		expect(caseRowDisplayValue(row, "name")).toBe("Real Name");
		expect(caseRowDisplayValue(row, "external_id")).toBe("EXT-1");
		expect(caseRowDisplayValue(row, "external-id")).toBe("EXT-1");
		expect(caseRowDisplayValue(row, "date_opened")).toBe(opened.toISOString());
		expect(caseRowDisplayValue(row, "date-opened")).toBe(opened.toISOString());
		expect(caseRowDisplayValue(row, "last_modified")).toBe(
			modified.toISOString(),
		);
	});

	it.each([
		["owner_id"],
		["status"],
	])("caseRowDisplayValue surfaces null for nullable reserved column %s", (field) => {
		// `owner_id` and `status` are nullable on `cases`; the
		// helper coerces a `null` column read to the empty string
		// (consistent with `jsonValueToString`'s `null` arm) so
		// case-list table cells render empty rather than the literal
		// "null".
		const row: CaseRow = {
			case_id: "test-id",
			app_id: APP_ID,
			case_type: "patient",
			owner_id: field === "owner_id" ? null : OWNER_A,
			status: field === "status" ? null : "open",
			opened_on: null,
			modified_on: null,
			closed_on: null,
			case_name: "Synthetic Case",
			external_id: null,
			parent_case_id: null,
			properties: {},
		};
		expect(caseRowDisplayValue(row, field)).toBe("");
	});
});

// ---------------------------------------------------------------
// `pickBlueprintDoc`
// ---------------------------------------------------------------

describe("pickBlueprintDoc", () => {
	it("strips function-typed extras off a doc-store-shaped state", () => {
		// `BlueprintDocState` (the doc store's shape) carries action
		// methods alongside the data fields. Server Actions reject
		// function values during RSC serialization, so the
		// projection has to drop them. Verify by extending a
		// `BlueprintDoc` with a function-typed key and checking it's
		// absent from the result.
		const blueprint = buildSimpleBlueprint([PATIENT_CASE_TYPE], APP_ID);
		const stateShaped = {
			...blueprint,
			// Synthetic action method the projection must strip.
			applyMany: () => {
				/* no-op */
			},
		};
		const projected = pickBlueprintDoc(stateShaped) as Record<string, unknown>;
		expect(projected.applyMany).toBeUndefined();
	});

	it("preserves every BlueprintDoc data field including fieldParent", () => {
		// `BlueprintDoc` extends `PersistableDoc` (the schema-defined
		// shape) with `fieldParent` (in-memory only, derived from
		// `fieldOrder`). The projection re-attaches `fieldParent` from
		// the source state so the running-app `loadCasesAction` (which
		// never parses) can read it; the parsing preview actions strip
		// it back off before their `.strict()` parse via
		// `toPersistableDoc`. Verify the reverse-index round-trips here.
		const blueprint = buildSimpleBlueprint([PATIENT_CASE_TYPE], APP_ID);
		const withFieldParent = {
			...blueprint,
			fieldParent: { "child-uuid": "parent-uuid" },
		};
		const projected = pickBlueprintDoc(withFieldParent);
		expect(projected.fieldParent).toEqual({ "child-uuid": "parent-uuid" });
		expect(projected.appId).toBe(APP_ID);
		expect(projected.caseTypes).toEqual(blueprint.caseTypes);
		expect(projected.modules).toEqual(blueprint.modules);
		expect(projected.forms).toEqual(blueprint.forms);
		expect(projected.fields).toEqual(blueprint.fields);
		expect(projected.moduleOrder).toEqual(blueprint.moduleOrder);
		expect(projected.formOrder).toEqual(blueprint.formOrder);
		expect(projected.fieldOrder).toEqual(blueprint.fieldOrder);
	});
});

// ---------------------------------------------------------------
// `mapPopulateSampleCasesError`
// ---------------------------------------------------------------

describe("mapPopulateSampleCasesError", () => {
	// The Server Action's catch block delegates to this helper so
	// the typed-error → typed-result-arm mapping is testable
	// without driving `getSession` + `withProjectContext`. The
	// integration tests above already exercise the round-trip
	// through `seedSampleCases`; these tests pin the discriminator
	// shape one more layer down.

	it("maps CaseTypeNotInBlueprintError to the missing-case-type arm carrying the case type", () => {
		const err = new CaseTypeNotInBlueprintError("app-1", "patient");
		const result = mapPopulateSampleCasesError(err);
		expect(result).toEqual({ kind: "missing-case-type", caseType: "patient" });
	});

	it("maps SchemaNotSyncedError to the schema-not-synced arm carrying the case type", () => {
		const err = new SchemaNotSyncedError("app-1", "patient");
		const result = mapPopulateSampleCasesError(err);
		expect(result).toEqual({ kind: "schema-not-synced", caseType: "patient" });
	});

	it("maps CasePropertiesValidationError to the validation-failure arm carrying the structured failures", () => {
		// AJV's per-field failure list is the user-actionable shape;
		// the mapping helper preserves it verbatim onto the arm so
		// the consumer renders one entry per offending field. Without
		// this branch, the running-app view's error toast would show
		// the wrapped invariant body (internal vocabulary), defeating
		// the typed-error pattern's purpose.
		const failures: ReadonlyArray<CasePropertyFailure> = [
			{ path: "/age", message: "must be integer" },
			{ path: "/name", message: "must NOT have fewer than 1 characters" },
		];
		const err = new CasePropertiesValidationError("app-1", "patient", failures);
		const result = mapPopulateSampleCasesError(err);
		expect(result).toEqual({
			kind: "validation-failure",
			caseType: "patient",
			failures,
		});
	});

	it("falls through to the generic error arm for an unrelated Error instance", () => {
		const err = new Error("connection refused");
		const result = mapPopulateSampleCasesError(err);
		expect(result.kind).toBe("error");
		if (result.kind !== "error") return;
		expect(result.message).toBe("connection refused");
	});

	it("falls through to the generic error arm with a default message for non-Error throws", () => {
		// JS allows `throw "foo"`. The case-store doesn't, but the
		// catch block has to handle every shape — RSC framework
		// errors in particular can surface as non-Error objects.
		const result = mapPopulateSampleCasesError("some string");
		expect(result.kind).toBe("error");
		if (result.kind !== "error") return;
		expect(result.message).toBe("Failed to seed cases.");
	});

	// `CaseTypeNotInBlueprintError` is no longer thrown by
	// `seedSampleCases` itself — the helper accepts the resolved
	// `CaseType` directly, so the missing-from-blueprint case lives
	// at the Server Action layer (`populateSampleCasesAction`'s
	// boundary resolution). The synthetic mapping test above already
	// pins the typed-arm shape.

	it("maps a typed SchemaNotSyncedError thrown by the real seed flow", async () => {
		// End-to-end mapping for the schema-sync-skipped path. The
		// blueprint declares the case type but `applySchemaChange`
		// hasn't run, so the case-store's `getValidator` reaches a
		// missing `case_type_schemas` row and throws.
		const store = makeStore(OWNER_A);
		// Skip `seedSchema` on purpose — that's the precondition the
		// error covers.
		try {
			await seedSampleCases(store, {
				appId: APP_ID,
				caseType: PATIENT_CASE_TYPE,
			});
			throw new Error("seedSampleCases should have thrown");
		} catch (err) {
			const result = mapPopulateSampleCasesError(err);
			expect(result).toEqual({
				kind: "schema-not-synced",
				caseType: "patient",
			});
		}
	});

	it("maps a typed CasePropertiesValidationError thrown by the real seed flow", async () => {
		// End-to-end mapping for the AJV-rejection path. A stub
		// `SampleCaseGenerator` emits a schema-violating row (`age`
		// declared as `int` but the generator returns the string
		// "not-a-number"); the case-store's bulk-insert path runs
		// AJV inside its transaction and throws
		// `CasePropertiesValidationError`. `seedSampleCases`
		// propagates; the mapping helper translates to the
		// structured `validation-failure` arm with the per-field
		// failure list intact.
		const stubGenerator = {
			generate: () => [
				{
					case_type: "patient",
					case_name: "Alice",
					status: "open",
					// `age` as a non-numeric string fails the int schema.
					properties: { name: "Alice", age: "not-a-number" },
				},
			],
		};
		const store = new PostgresCaseStore({
			projectId: OWNER_A,
			actorUserId: OWNER_A,
			db: dbHandle.db as unknown as Kysely<Database>,
			sampleGenerator: stubGenerator,
		});
		const blueprint = buildBlueprint([PATIENT_CASE_TYPE]);
		// Schema sync runs so the validator fetch succeeds; the
		// failure is on the candidate payload, not on the schema
		// row.
		await seedSchema(store, blueprint, "patient");

		try {
			await seedSampleCases(store, {
				appId: APP_ID,
				caseType: PATIENT_CASE_TYPE,
			});
			throw new Error("seedSampleCases should have thrown");
		} catch (err) {
			const result = mapPopulateSampleCasesError(err);
			expect(result.kind).toBe("validation-failure");
			if (result.kind !== "validation-failure") return;
			expect(result.caseType).toBe("patient");
			// The failure list carries at least the `/age` entry —
			// AJV may surface multiple failures depending on the
			// schema's strictness, so pin the load-bearing entry by
			// substring rather than locking the full array shape.
			expect(result.failures.length).toBeGreaterThan(0);
			const ageFailure = result.failures.find((f) => f.path === "/age");
			expect(ageFailure).toBeDefined();
			expect(ageFailure?.message).toMatch(/integer/);
		}
	});
});

// ---------------------------------------------------------------
// `readCaseListPreview` + `mapCaseListPreviewError`
// ---------------------------------------------------------------
//
// The case-list authoring-surface live-preview helpers route through
// `caseStore.query` (with a `calculated` arg). The integration tests
// here pin the discriminated-union return shapes the live preview's
// UI dispatches on — the empty arm, the rows arm with calculated
// projection, and the typed-error mapping (mirrors the
// `mapPopulateSampleCasesError` pattern).

/**
 * Build a v2 `CaseListConfig` snapshot. The schema collapses to
 * three slots — `columns` (carrying display + sort + calc +
 * visibility), optional `filter`, and `searchInputs`. Tests
 * override `columns` (and occasionally `filter`) per case; the
 * baseline empty arrays cover the rest.
 */
function makeCaseListConfig(
	overrides: Partial<CaseListConfig> = {},
): CaseListConfig {
	return {
		columns: [],
		searchInputs: [],
		...overrides,
	};
}

/**
 * Stable per-test column uuids. Synthetic IDs satisfy the schema's
 * `Uuid` brand without requiring a fresh `crypto.randomUUID()` per
 * column — assertions that read `row.calculated[uuid]` reuse the
 * same constant. The rendered string respects the 8-4-4-4-12
 * grouping the schema accepts.
 */
const NAME_COLUMN_UUID = asUuid("50000000-0000-0000-0000-000000000001");
const NOTE_CALC_COLUMN_UUID = asUuid("50000000-0000-0000-0000-000000000002");

describe("readCaseListPreview", () => {
	it("returns the empty arm when no rows exist", async () => {
		const store = makeStore(OWNER_A);
		const blueprint = buildBlueprint([PATIENT_CASE_TYPE]);
		await seedSchema(store, blueprint, "patient");
		const result = await readCaseListPreview(store, {
			appId: APP_ID,
			caseType: "patient",
			caseTypeSchemas: buildCaseTypeMap(blueprint),
			caseListConfig: makeCaseListConfig({
				columns: [plainColumn(NAME_COLUMN_UUID, "name", "Name")],
			}),
		});
		expect(result.kind).toBe("empty");
	});

	it("returns the rows arm with the calculated map populated", async () => {
		const store = makeStore(OWNER_A);
		const blueprint = buildBlueprint([PATIENT_CASE_TYPE]);
		await seedSchema(store, blueprint, "patient");
		await store.insert({
			appId: APP_ID,
			row: {
				case_id: ALICE_CASE_ID,
				case_type: "patient",
				case_name: "Alice",
				status: "open",
				properties: { name: "Alice", age: 30 },
			},
		});
		// Calculated column emits a literal — predictable shape that
		// pins the rows-arm contract without exercising the AST
		// compiler's per-arm semantics here (the SQL contract test
		// covers that surface). v2 lifts calc into the `columns`
		// union; the case-store keys each row's `calculated` map by
		// the calc column's `uuid`, so the assertion reads the slot
		// at `NOTE_CALC_COLUMN_UUID`.
		const result = await readCaseListPreview(store, {
			appId: APP_ID,
			caseType: "patient",
			caseTypeSchemas: buildCaseTypeMap(blueprint),
			caseListConfig: makeCaseListConfig({
				columns: [
					plainColumn(NAME_COLUMN_UUID, "name", "Name"),
					calculatedColumn(
						NOTE_CALC_COLUMN_UUID,
						"Note",
						term(literal("hello")),
					),
				],
			}),
		});
		expect(result.kind).toBe("rows");
		if (result.kind !== "rows") return;
		expect(result.rows).toHaveLength(1);
		expect(result.rows[0]?.calculated[NOTE_CALC_COLUMN_UUID]).toBe("hello");
	});
});

describe("mapCaseListPreviewError", () => {
	// Mirrors `mapPopulateSampleCasesError` shape — the helper is
	// the catch-block delegate for the Server Action and translates
	// case-store typed errors into the structured arm shape the live-
	// preview consumer dispatches on.

	it("maps CaseTypeNotInBlueprintError to the missing-case-type arm", () => {
		const err = new CaseTypeNotInBlueprintError("app-1", "patient");
		const result = mapCaseListPreviewError(err);
		expect(result).toEqual({ kind: "missing-case-type", caseType: "patient" });
	});

	it("maps SchemaNotSyncedError to the schema-not-synced arm", () => {
		const err = new SchemaNotSyncedError("app-1", "patient");
		const result = mapCaseListPreviewError(err);
		expect(result).toEqual({ kind: "schema-not-synced", caseType: "patient" });
	});

	it("falls through to the generic error arm for an unrelated Error", () => {
		const err = new Error("connection refused");
		const result = mapCaseListPreviewError(err);
		expect(result.kind).toBe("error");
		if (result.kind !== "error") return;
		expect(result.message).toBe("connection refused");
	});

	it("falls through to the generic error arm with a default message for non-Error throws", () => {
		const result = mapCaseListPreviewError("some string");
		expect(result.kind).toBe("error");
		if (result.kind !== "error") return;
		expect(result.message).toBe("Failed to load preview.");
	});
});

// ---------------------------------------------------------------
// `applyRegistrationMutation`
// ---------------------------------------------------------------

describe("applyRegistrationMutation", () => {
	it("dispatches to insertWithChildren and returns the registration arm with the generated ids", async () => {
		const store = makeStore(OWNER_A);
		const blueprint = buildBlueprint([PATIENT_CASE_TYPE, VISIT_CASE_TYPE]);
		await seedSchema(store, blueprint, "patient");
		await seedSchema(store, blueprint, "visit");

		const mutation: Extract<SubmissionMutation, { kind: "registration" }> = {
			kind: "registration",
			primary: {
				caseType: "patient",
				caseName: "Alice",
				properties: { name: "Alice", age: 30 },
			},
			children: [
				{
					caseType: "visit",
					caseName: "First visit",
					properties: { notes: "checkup" },
				},
			],
		};

		const result = await applyRegistrationMutation(store, {
			mutation,
			appId: APP_ID,
		});

		// Primary id was generated by the case-store and surfaces in the
		// helper's return value; child id arrives in input order.
		expect(result.caseId).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
		);
		expect(result.childCaseIds).toHaveLength(1);

		// Read-back through the store confirms the rows landed with the
		// right column values + JSONB document; the visit row's
		// `parent_case_id` is threaded from the primary's generated id.
		const patients = await readCases(store, {
			appId: APP_ID,
			caseType: "patient",
		});
		expect(patients.kind).toBe("rows");
		if (patients.kind !== "rows") return;
		expect(patients.rows).toHaveLength(1);
		expect(patients.rows[0]?.case_name).toBe("Alice");
		expect(patients.rows[0]?.properties).toEqual({ name: "Alice", age: 30 });

		const visits = await readCases(store, {
			appId: APP_ID,
			caseType: "visit",
		});
		expect(visits.kind).toBe("rows");
		if (visits.kind !== "rows") return;
		expect(visits.rows).toHaveLength(1);
		expect(visits.rows[0]?.case_name).toBe("First visit");
		expect(visits.rows[0]?.parent_case_id).toBe(result.caseId);
	});

	it("admits zero children and lands the primary alone", async () => {
		const store = makeStore(OWNER_A);
		const blueprint = buildBlueprint([PATIENT_CASE_TYPE]);
		await seedSchema(store, blueprint, "patient");

		const mutation: Extract<SubmissionMutation, { kind: "registration" }> = {
			kind: "registration",
			primary: {
				caseType: "patient",
				caseName: "Solo",
				properties: { name: "Solo", age: 25 },
			},
			children: [],
		};

		const result = await applyRegistrationMutation(store, {
			mutation,
			appId: APP_ID,
		});
		expect(result.childCaseIds).toEqual([]);

		const patients = await readCases(store, {
			appId: APP_ID,
			caseType: "patient",
		});
		expect(patients.kind).toBe("rows");
		if (patients.kind !== "rows") return;
		expect(patients.rows).toHaveLength(1);
	});

	it("admits an empty properties document against a case-type with formatted properties (AJV does not reject)", async () => {
		// Empty-properties round-trip: a registration whose user filled
		// only `case_name` against a case-type carrying `format: date`,
		// `format: time`, `format: date-time`, geopoint, and numeric
		// properties must clear AJV. The engine's empty-value filter
		// (`raw === undefined || raw === ""` inside
		// `formEngine.ts::FormEngine.computeSubmissionMutation`)
		// guarantees the absent properties never reach the helper, and
		// `caseTypeToJsonSchema` emits `{ type: "object" }` with no
		// `required` keys — so the empty document trivially passes.
		// Pinning the round-trip end-to-end protects against a future
		// generator change that adds `required` keys (which would crash
		// every running-app form whose user fills only `case_name`).
		const store = makeStore(OWNER_A);
		const blueprint = buildBlueprint([FORMATTED_PROPS_CASE_TYPE]);
		await seedSchema(store, blueprint, "patient");

		const mutation: Extract<SubmissionMutation, { kind: "registration" }> = {
			kind: "registration",
			primary: {
				caseType: "patient",
				caseName: "Alice",
				// Every formatted property left absent — `format: date`
				// would crash on `""`, the geopoint pattern would
				// reject `""`, the `integer` / `number` types would
				// reject `null`. Omission is the only shape that lands.
				properties: {},
			},
			children: [],
		};

		const result = await applyRegistrationMutation(store, {
			mutation,
			appId: APP_ID,
		});
		expect(result.childCaseIds).toEqual([]);

		const patients = await readCases(store, {
			appId: APP_ID,
			caseType: "patient",
		});
		if (patients.kind !== "rows") throw new Error("expected rows");
		expect(patients.rows).toHaveLength(1);
		// JSONB document is empty; `case_name` lands on the column.
		expect(patients.rows[0]?.case_name).toBe("Alice");
		expect(patients.rows[0]?.properties).toEqual({});
	});

	it("throws compilerBugMessage when the primary carries no caseName", async () => {
		const store = makeStore(OWNER_A);
		const blueprint = buildBlueprint([PATIENT_CASE_TYPE]);
		await seedSchema(store, blueprint, "patient");

		// `caseName` is `text NOT NULL` at the column; reaching the
		// helper without one is an upstream invariant violation. The
		// engine's walker plucks `case_name` into the slot for every
		// contentful bucket, so this throw is structural.
		const mutation: Extract<SubmissionMutation, { kind: "registration" }> = {
			kind: "registration",
			primary: {
				caseType: "patient",
				properties: { name: "Alice", age: 30 },
			},
			children: [],
		};

		await expect(
			applyRegistrationMutation(store, { mutation, appId: APP_ID }),
		).rejects.toThrow(/no `case_name` value/);
	});

	it("throws compilerBugMessage when a child carries no caseName", async () => {
		const store = makeStore(OWNER_A);
		const blueprint = buildBlueprint([PATIENT_CASE_TYPE, VISIT_CASE_TYPE]);
		await seedSchema(store, blueprint, "patient");
		await seedSchema(store, blueprint, "visit");

		const mutation: Extract<SubmissionMutation, { kind: "registration" }> = {
			kind: "registration",
			primary: {
				caseType: "patient",
				caseName: "Alice",
				properties: { name: "Alice", age: 30 },
			},
			children: [
				{
					caseType: "visit",
					properties: { notes: "checkup" },
				},
			],
		};

		await expect(
			applyRegistrationMutation(store, { mutation, appId: APP_ID }),
		).rejects.toThrow(/no `case_name` value/);
	});
});

// ---------------------------------------------------------------
// `applyFollowupMutation`
// ---------------------------------------------------------------

describe("applyFollowupMutation", () => {
	it("dispatches to update + per-child insert and returns the followup arm", async () => {
		const store = makeStore(OWNER_A);
		const blueprint = buildBlueprint([PATIENT_CASE_TYPE, VISIT_CASE_TYPE]);
		await seedSchema(store, blueprint, "patient");
		await seedSchema(store, blueprint, "visit");
		// Pre-seed the bound primary case so the followup has a row
		// to update.
		await store.insert({
			appId: APP_ID,
			row: {
				case_id: ALICE_CASE_ID,
				case_type: "patient",
				case_name: "Alice",
				status: "open",
				properties: { name: "Alice", age: 30 },
			},
		});

		const mutation: Extract<SubmissionMutation, { kind: "followup" }> = {
			kind: "followup",
			caseId: ALICE_CASE_ID,
			patch: { properties: { age: 31 } },
			children: [
				{
					caseType: "visit",
					caseName: "Followup visit",
					properties: { notes: "stable" },
					parentCaseId: ALICE_CASE_ID,
				},
			],
		};

		const result = await applyFollowupMutation(store, {
			mutation,
			appId: APP_ID,
		});
		expect(result.caseId).toBe(ALICE_CASE_ID);
		expect(result.childCaseIds).toHaveLength(1);

		// Primary's `age` updated; `name` preserved (JSONB merge, not
		// replace).
		const patients = await readCases(store, {
			appId: APP_ID,
			caseType: "patient",
		});
		if (patients.kind !== "rows") throw new Error("expected rows");
		expect(patients.rows[0]?.properties).toEqual({ name: "Alice", age: 31 });

		// Child row's `parent_case_id` matches the bound caseId.
		const visits = await readCases(store, {
			appId: APP_ID,
			caseType: "visit",
		});
		if (visits.kind !== "rows") throw new Error("expected rows");
		expect(visits.rows[0]?.parent_case_id).toBe(ALICE_CASE_ID);
	});

	it("short-circuits the primary update when the patch carries no writes", async () => {
		// Empty-patch short-circuit: a followup whose form has no
		// editable fields (or whose children are the only writes)
		// should NOT bump `modified_on` for nothing. Pre-seed the
		// primary, snapshot its `modified_on`, run an empty-patch
		// followup, then assert the timestamp didn't move.
		const store = makeStore(OWNER_A);
		const blueprint = buildBlueprint([PATIENT_CASE_TYPE, VISIT_CASE_TYPE]);
		await seedSchema(store, blueprint, "patient");
		await seedSchema(store, blueprint, "visit");
		await store.insert({
			appId: APP_ID,
			row: {
				case_id: ALICE_CASE_ID,
				case_type: "patient",
				case_name: "Alice",
				status: "open",
				properties: { name: "Alice", age: 30 },
			},
		});

		// Read the pre-call modified_on for the comparison.
		const before = await readCases(store, {
			appId: APP_ID,
			caseType: "patient",
		});
		if (before.kind !== "rows") throw new Error("expected rows");
		const beforeModifiedOn = before.rows[0]?.modified_on;

		const mutation: Extract<SubmissionMutation, { kind: "followup" }> = {
			kind: "followup",
			caseId: ALICE_CASE_ID,
			patch: { properties: {} },
			children: [
				{
					caseType: "visit",
					caseName: "Followup visit",
					properties: { notes: "stable" },
					parentCaseId: ALICE_CASE_ID,
				},
			],
		};

		await applyFollowupMutation(store, { mutation, appId: APP_ID });

		const after = await readCases(store, {
			appId: APP_ID,
			caseType: "patient",
		});
		if (after.kind !== "rows") throw new Error("expected rows");
		// `modified_on` either stays `null` (insert path didn't set
		// one) or matches the pre-call snapshot — either way, it must
		// not advance.
		expect(after.rows[0]?.modified_on).toEqual(beforeModifiedOn);
	});
});

// ---------------------------------------------------------------
// `applyCloseMutation`
// ---------------------------------------------------------------

describe("applyCloseMutation", () => {
	it("dispatches to update + per-child insert + close and stamps closed_on", async () => {
		const store = makeStore(OWNER_A);
		const blueprint = buildBlueprint([PATIENT_CASE_TYPE, VISIT_CASE_TYPE]);
		await seedSchema(store, blueprint, "patient");
		await seedSchema(store, blueprint, "visit");
		await store.insert({
			appId: APP_ID,
			row: {
				case_id: ALICE_CASE_ID,
				case_type: "patient",
				case_name: "Alice",
				status: "open",
				properties: { name: "Alice", age: 30 },
			},
		});

		const mutation: Extract<SubmissionMutation, { kind: "close" }> = {
			kind: "close",
			caseId: ALICE_CASE_ID,
			patch: { properties: { age: 32 } },
			children: [
				{
					caseType: "visit",
					caseName: "Closing visit",
					properties: { notes: "discharged" },
					parentCaseId: ALICE_CASE_ID,
				},
			],
		};

		const result = await applyCloseMutation(store, {
			mutation,
			appId: APP_ID,
		});
		expect(result.caseId).toBe(ALICE_CASE_ID);
		expect(result.childCaseIds).toHaveLength(1);

		const patients = await readCases(store, {
			appId: APP_ID,
			caseType: "patient",
		});
		if (patients.kind !== "rows") throw new Error("expected rows");
		// Property update + closure timestamp landed atop the same row.
		expect(patients.rows[0]?.properties).toEqual({ name: "Alice", age: 32 });
		expect(patients.rows[0]?.closed_on).not.toBeNull();
	});

	it("skips the primary UPDATE call when the patch carries no writes but still stamps closed_on", async () => {
		// Empty-patch close: a close form whose only effect is the
		// closure stamp itself (no property writes) must skip the
		// primary's UPDATE round-trip but MUST still land `closed_on`.
		// The followup test above asserts the same skip via a
		// `modified_on` snapshot — that approach doesn't translate to
		// the close arm because `PostgresCaseStore.close()` stamps
		// `modified_on` itself (`postgres/store.ts::PostgresCaseStore.close`),
		// so a real close always advances the timestamp regardless of
		// whether the empty patch was short-circuited. A spy on
		// `store.update` is the durable detector: `close()` writes via
		// a direct `db.updateTable(...)` chain, NOT through the public
		// `update()` method, so the spy fires only when
		// `applyPrimaryUpdate` (the shared helper for followup + close
		// primary writes) actually invokes the update path. Pins the
		// close arm against a future refactor that inlines the primary
		// update or stops delegating to the shared helper.
		const store = makeStore(OWNER_A);
		const blueprint = buildBlueprint([PATIENT_CASE_TYPE, VISIT_CASE_TYPE]);
		await seedSchema(store, blueprint, "patient");
		await seedSchema(store, blueprint, "visit");
		await store.insert({
			appId: APP_ID,
			row: {
				case_id: ALICE_CASE_ID,
				case_type: "patient",
				case_name: "Alice",
				status: "open",
				properties: { name: "Alice", age: 30 },
			},
		});

		// Defaults to passthrough; the underlying close + child-insert
		// behavior runs unchanged.
		const updateSpy = vi.spyOn(store, "update");

		const mutation: Extract<SubmissionMutation, { kind: "close" }> = {
			kind: "close",
			caseId: ALICE_CASE_ID,
			patch: { properties: {} },
			children: [
				{
					caseType: "visit",
					caseName: "Closing visit",
					properties: { notes: "discharged" },
					parentCaseId: ALICE_CASE_ID,
				},
			],
		};

		const result = await applyCloseMutation(store, {
			mutation,
			appId: APP_ID,
		});
		expect(result.caseId).toBe(ALICE_CASE_ID);
		expect(result.childCaseIds).toHaveLength(1);

		// The empty patch never reached `store.update` — the shared
		// `applyPrimaryUpdate` helper short-circuited.
		expect(updateSpy).not.toHaveBeenCalled();

		const patients = await readCases(store, {
			appId: APP_ID,
			caseType: "patient",
		});
		if (patients.kind !== "rows") throw new Error("expected rows");
		// Properties unchanged (no UPDATE ran); the closure stamp
		// landed regardless.
		expect(patients.rows[0]?.properties).toEqual({ name: "Alice", age: 30 });
		expect(patients.rows[0]?.closed_on).not.toBeNull();
	});
});

// ---------------------------------------------------------------
// `applySurveyMutation`
// ---------------------------------------------------------------

describe("applySurveyMutation", () => {
	it("returns the survey arm with no I/O", () => {
		// Synchronous — no `CaseStore` parameter required. The Server
		// Action returns the discriminator without touching Postgres.
		const result = applySurveyMutation();
		expect(result).toEqual({ kind: "survey" });
	});
});

// ---------------------------------------------------------------
// `mapSubmitFormError`
// ---------------------------------------------------------------

describe("mapSubmitFormError", () => {
	// Synthetic-error mapping — same shape as the
	// `mapPopulateSampleCasesError` block above. The Server Action's
	// catch block delegates to this helper so the typed-error →
	// typed-result-arm translation is testable without driving
	// `getSession` / `withProjectContext`.

	it("maps CaseNotFoundError to the case-not-found arm carrying the case id", () => {
		const err = new CaseNotFoundError(ALICE_CASE_ID);
		expect(mapSubmitFormError(err)).toEqual({
			kind: "case-not-found",
			caseId: ALICE_CASE_ID,
		});
	});

	it("maps CasePropertiesValidationError to the case-properties-validation arm carrying the failures", () => {
		const failures: ReadonlyArray<CasePropertyFailure> = [
			{ path: "/age", message: "must be integer" },
		];
		const err = new CasePropertiesValidationError(APP_ID, "patient", failures);
		expect(mapSubmitFormError(err)).toEqual({
			kind: "case-properties-validation",
			caseType: "patient",
			failures,
		});
	});

	it("maps CaseTypeNotInBlueprintError to the missing-case-type arm", () => {
		const err = new CaseTypeNotInBlueprintError(APP_ID, "patient");
		expect(mapSubmitFormError(err)).toEqual({
			kind: "missing-case-type",
			caseType: "patient",
		});
	});

	it("maps SchemaNotSyncedError to the schema-not-synced arm", () => {
		const err = new SchemaNotSyncedError(APP_ID, "patient");
		expect(mapSubmitFormError(err)).toEqual({
			kind: "schema-not-synced",
			caseType: "patient",
		});
	});

	it("falls through to the generic error arm for an unrelated Error instance", () => {
		const result = mapSubmitFormError(new Error("connection refused"));
		expect(result).toEqual({
			kind: "error",
			message: "connection refused",
		});
	});

	it("falls through to the generic error arm with a default message for non-Error throws", () => {
		// JS allows `throw "string"`; RSC framework errors can surface
		// as non-Error objects. The helper handles both.
		const result = mapSubmitFormError("plain string");
		expect(result).toEqual({
			kind: "error",
			message: "Failed to submit form.",
		});
	});

	it("maps a typed CaseNotFoundError thrown by the real store update", async () => {
		// End-to-end mapping: `CaseStore.update` against an unknown id
		// throws `CaseNotFoundError`; the helper translates to the
		// structured arm. Pins the catch path through the real
		// error-thrower, paralleling the `seedSampleCases` end-to-end
		// mapping tests above.
		const store = makeStore(OWNER_A);
		const blueprint = buildBlueprint([PATIENT_CASE_TYPE]);
		await seedSchema(store, blueprint, "patient");

		const mutation: Extract<SubmissionMutation, { kind: "followup" }> = {
			kind: "followup",
			caseId: ALICE_CASE_ID,
			patch: { properties: { age: 31 } },
			children: [],
		};

		try {
			await applyFollowupMutation(store, { mutation, appId: APP_ID });
			throw new Error("applyFollowupMutation should have thrown");
		} catch (err) {
			const result = mapSubmitFormError(err);
			expect(result).toEqual({
				kind: "case-not-found",
				caseId: ALICE_CASE_ID,
			});
		}
	});
});

// ---------------------------------------------------------------
// `submitFormAction` (Server Action)
// ---------------------------------------------------------------
//
// The helper-level tests above drive every mutation arm against
// real Postgres; this block exercises the Server Action's
// session-resolution + error-catch wrapper without driving Better
// Auth / Postgres. The `vi.mock` calls at the top of the file
// stub `getSession` and `withProjectContext` so the action's body
// branches are reachable from the test runner.

describe("submitFormAction", () => {
	it("returns the unauthenticated arm when getSession resolves to null", async () => {
		const { getSession } = await import("@/lib/auth-utils");
		vi.mocked(getSession).mockResolvedValueOnce(null);

		const { submitFormAction } = await import("../caseDataBinding");
		const result = await submitFormAction({ kind: "survey" }, "app-anything");
		expect(result).toEqual({ kind: "unauthenticated" });
	});

	it("returns the survey arm without touching the store when the session resolves", async () => {
		const { getSession } = await import("@/lib/auth-utils");
		const { withProjectContext } = await import("@/lib/case-store");
		vi.mocked(getSession).mockResolvedValueOnce({
			user: { id: OWNER_A },
			// The action only reads `session.user.id`; the rest of the
			// shape is irrelevant for this assertion. Cast through
			// `unknown` because Better Auth's `Session` type carries
			// many fields we don't synthesize.
		} as unknown as Awaited<ReturnType<typeof getSession>>);
		// `withProjectContext` is called but its result is unused for
		// the survey arm; supply a stub that throws if any method is
		// called so a regression to "survey routes through the store"
		// surfaces loudly.
		const stubStore = {
			query: vi.fn(),
			count: vi.fn(),
			insert: vi.fn(),
			insertWithChildren: vi.fn(),
			update: vi.fn(),
			close: vi.fn(),
			traverse: vi.fn(),
			applySchemaChange: vi.fn(),
			dropSchema: vi.fn(),
			generateSampleData: vi.fn(),
			resetSampleData: vi.fn(),
		} satisfies CaseStore;
		vi.mocked(withProjectContext).mockResolvedValueOnce(stubStore);

		const { submitFormAction } = await import("../caseDataBinding");
		const result = await submitFormAction({ kind: "survey" }, APP_ID);
		expect(result).toEqual({ kind: "survey" });
		// None of the store's methods should have been called.
		for (const method of Object.values(stubStore)) {
			expect(method).not.toHaveBeenCalled();
		}
	});

	it("translates a CaseNotFoundError thrown by the helper to the case-not-found arm", async () => {
		// The Server Action's catch block delegates to
		// `mapSubmitFormError`; pin that delegation via a stub store
		// whose `update` throws the typed error.
		const { getSession } = await import("@/lib/auth-utils");
		const { withProjectContext } = await import("@/lib/case-store");
		vi.mocked(getSession).mockResolvedValueOnce({
			user: { id: OWNER_A },
		} as unknown as Awaited<ReturnType<typeof getSession>>);
		const stubStore = {
			query: vi.fn(),
			count: vi.fn(),
			insert: vi.fn(),
			insertWithChildren: vi.fn(),
			update: vi
				.fn()
				.mockRejectedValueOnce(new CaseNotFoundError(ALICE_CASE_ID)),
			close: vi.fn(),
			traverse: vi.fn(),
			applySchemaChange: vi.fn(),
			dropSchema: vi.fn(),
			generateSampleData: vi.fn(),
			resetSampleData: vi.fn(),
		} satisfies CaseStore;
		vi.mocked(withProjectContext).mockResolvedValueOnce(stubStore);

		const { submitFormAction } = await import("../caseDataBinding");
		const result = await submitFormAction(
			{
				kind: "followup",
				caseId: ALICE_CASE_ID,
				patch: { properties: { age: 31 } },
				children: [],
			},
			APP_ID,
		);
		expect(result).toEqual({
			kind: "case-not-found",
			caseId: ALICE_CASE_ID,
		});
	});
});

// ---------------------------------------------------------------
// `loadCasesAction` (Server Action)
// ---------------------------------------------------------------
//
// The action's own responsibility is thin: resolve the session, rebuild
// the SQL compiler's `(name → CaseType)` map from the LIVE catalog the
// client sends in `caseTypes` (never a server `loadApp` read), and
// delegate to `readCases`. `readCases` itself is covered by the suites
// above against a real per-test store; here `withProjectContext` is stubbed
// so the wrapper branches are reachable without Postgres.

describe("loadCasesAction", () => {
	it("returns the unauthenticated arm when getSession resolves to null", async () => {
		const { getSession } = await import("@/lib/auth-utils");
		const { withProjectContext } = await import("@/lib/case-store");
		vi.mocked(getSession).mockResolvedValueOnce(null);

		const { loadCasesAction } = await import("../caseDataBinding");
		const result = await loadCasesAction({
			appId: APP_ID,
			caseType: "patient",
		});
		expect(result).toEqual({ kind: "unauthenticated" });
		expect(vi.mocked(withProjectContext)).not.toHaveBeenCalled();
	});

	it("rebuilds the schema map from the client-sent catalog and threads it into the store query", async () => {
		const { getSession } = await import("@/lib/auth-utils");
		const { withProjectContext } = await import("@/lib/case-store");
		vi.mocked(getSession).mockResolvedValueOnce({
			user: { id: OWNER_A },
		} as unknown as Awaited<ReturnType<typeof getSession>>);
		const stubStore = {
			query: vi.fn().mockResolvedValueOnce([]),
			count: vi.fn(),
			insert: vi.fn(),
			insertWithChildren: vi.fn(),
			update: vi.fn(),
			close: vi.fn(),
			traverse: vi.fn(),
			applySchemaChange: vi.fn(),
			dropSchema: vi.fn(),
			generateSampleData: vi.fn(),
			resetSampleData: vi.fn(),
		} satisfies CaseStore;
		vi.mocked(withProjectContext).mockResolvedValueOnce(stubStore);

		const { loadCasesAction } = await import("../caseDataBinding");
		const result = await loadCasesAction({
			appId: APP_ID,
			caseType: "patient",
			caseTypes: [PATIENT_CASE_TYPE],
		});
		expect(result).toEqual({ kind: "empty" });
		// The catalog is rebuilt into the `(name → CaseType)` map the SQL
		// compiler reads — sourced from the wire arg, not a server read.
		const queryArg = stubStore.query.mock.calls[0]?.[0];
		expect(queryArg?.caseTypeSchemas).toBeInstanceOf(Map);
		expect(queryArg?.caseTypeSchemas?.get("patient")).toEqual(
			PATIENT_CASE_TYPE,
		);
	});

	it("evaluates a session-backed excluded-owner expression before querying", async () => {
		const { getSession } = await import("@/lib/auth-utils");
		const { withProjectContext } = await import("@/lib/case-store");
		vi.mocked(getSession).mockResolvedValueOnce({
			user: {
				id: OWNER_A,
				name: "Owner A",
				email: "owner-a@example.org",
			},
		} as unknown as Awaited<ReturnType<typeof getSession>>);
		const stubStore = {
			query: vi.fn().mockResolvedValueOnce([]),
			count: vi.fn(),
			insert: vi.fn(),
			insertWithChildren: vi.fn(),
			update: vi.fn(),
			close: vi.fn(),
			traverse: vi.fn(),
			applySchemaChange: vi.fn(),
			dropSchema: vi.fn(),
			generateSampleData: vi.fn(),
			resetSampleData: vi.fn(),
		} satisfies CaseStore;
		vi.mocked(withProjectContext).mockResolvedValueOnce(stubStore);

		const { loadCasesAction } = await import("../caseDataBinding");
		const result = await loadCasesAction({
			appId: APP_ID,
			caseType: "patient",
			excludedOwnerIdsExpression: term(sessionContext("userid")),
		});

		expect(result).toEqual({ kind: "empty" });
		expect(stubStore.query).toHaveBeenCalledWith(
			expect.objectContaining({
				predicate: not(isIn(prop("patient", "owner_id"), literal(OWNER_A))),
			}),
		);
	});

	it("collapses a Project-membership denial to the not-found arm without binding a store", async () => {
		// The IDOR gate: a non-member / absent / under-privileged request
		// rejects with `AppAccessError` (here from a non-member), which the
		// action maps to the not-found `error` arm. Asserting the exact "App
		// not found." message proves the dedicated short-circuit ran, NOT the
		// generic catch (which would surface the raw error message). And
		// `withProjectContext` is never reached, so no store ever binds to
		// another Project's case data — the gate is the IDOR boundary that
		// replaced owner-scoping making the client-supplied `appId` safe.
		const { getSession } = await import("@/lib/auth-utils");
		const { withProjectContext } = await import("@/lib/case-store");
		const { AppAccessError } = await import("@/lib/db/appAccess");
		vi.mocked(getSession).mockResolvedValueOnce({
			user: { id: OWNER_B },
		} as unknown as Awaited<ReturnType<typeof getSession>>);
		resolveAppScopeMock.mockRejectedValueOnce(new AppAccessError("not_member"));

		const { loadCasesAction } = await import("../caseDataBinding");
		const result = await loadCasesAction({
			appId: APP_ID,
			caseType: "patient",
		});
		expect(result).toEqual({ kind: "error", message: "App not found." });
		expect(vi.mocked(withProjectContext)).not.toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------
// `resetSampleCasesAction` (Server Action)
// ---------------------------------------------------------------
//
// Mirrors `populateSampleCasesAction` over the case-store's atomic
// `resetSampleData` path. The block pins the action's wrapper
// responsibilities — session resolution and the catch-and-map
// delegation through `mapPopulateSampleCasesError` — without driving
// Better Auth / Postgres. The `CaseType` arrives from the client, so
// there is no server-side lookup to stub. The `vi.mock` calls at the top
// of the file stub `getSession` and `withProjectContext` so each branch is
// reachable.

describe("resetSampleCasesAction", () => {
	it("returns the unauthenticated arm when getSession resolves to null", async () => {
		// Session-first ordering means an unauthenticated request
		// short-circuits before the blueprint lookup. `withProjectContext`
		// must not be invoked.
		const { getSession } = await import("@/lib/auth-utils");
		const { withProjectContext } = await import("@/lib/case-store");
		vi.mocked(getSession).mockResolvedValueOnce(null);

		const { resetSampleCasesAction } = await import("../caseDataBinding");
		const result = await resetSampleCasesAction(APP_ID, PATIENT_CASE_TYPE);
		expect(result).toEqual({ kind: "unauthenticated" });
		expect(vi.mocked(withProjectContext)).not.toHaveBeenCalled();
	});

	it("returns the ok arm with the regenerated row count on the success path", async () => {
		// Stub the case-store's atomic `resetSampleData` so the action
		// resolves without touching real Postgres. The action's job is
		// to thread the resolved `CaseType` into the helper; the
		// helper's job is to call `resetSampleData`. Asserting the
		// final result shape pins the full delegation chain.
		const { getSession } = await import("@/lib/auth-utils");
		const { withProjectContext } = await import("@/lib/case-store");
		vi.mocked(getSession).mockResolvedValueOnce({
			user: { id: OWNER_A },
		} as unknown as Awaited<ReturnType<typeof getSession>>);
		const stubStore = {
			query: vi.fn(),
			count: vi.fn(),
			insert: vi.fn(),
			insertWithChildren: vi.fn(),
			update: vi.fn(),
			close: vi.fn(),
			traverse: vi.fn(),
			applySchemaChange: vi.fn(),
			dropSchema: vi.fn(),
			generateSampleData: vi.fn(),
			resetSampleData: vi.fn().mockResolvedValueOnce({
				deleted: SAMPLE_CASE_DEFAULT_COUNT,
				inserted: SAMPLE_CASE_DEFAULT_COUNT,
			}),
		} satisfies CaseStore;
		vi.mocked(withProjectContext).mockResolvedValueOnce(stubStore);

		const { resetSampleCasesAction } = await import("../caseDataBinding");
		const result = await resetSampleCasesAction(APP_ID, PATIENT_CASE_TYPE);
		expect(result).toEqual({
			kind: "ok",
			inserted: SAMPLE_CASE_DEFAULT_COUNT,
		});
		expect(stubStore.resetSampleData).toHaveBeenCalledTimes(1);
	});

	it("translates a CasePropertiesValidationError thrown by the store to the validation-failure arm", async () => {
		// `resetSampleData` runs AJV inside its transaction; a
		// generator emitting a schema-violating row trips
		// `CasePropertiesValidationError`. The action's catch path
		// delegates to `mapPopulateSampleCasesError`; the typed-arm
		// surfaces the per-field failure list verbatim.
		const { getSession } = await import("@/lib/auth-utils");
		const { withProjectContext } = await import("@/lib/case-store");
		vi.mocked(getSession).mockResolvedValueOnce({
			user: { id: OWNER_A },
		} as unknown as Awaited<ReturnType<typeof getSession>>);
		const failures: ReadonlyArray<CasePropertyFailure> = [
			{ path: "/age", message: "must be integer" },
		];
		const stubStore = {
			query: vi.fn(),
			count: vi.fn(),
			insert: vi.fn(),
			insertWithChildren: vi.fn(),
			update: vi.fn(),
			close: vi.fn(),
			traverse: vi.fn(),
			applySchemaChange: vi.fn(),
			dropSchema: vi.fn(),
			generateSampleData: vi.fn(),
			resetSampleData: vi
				.fn()
				.mockRejectedValueOnce(
					new CasePropertiesValidationError(APP_ID, "patient", failures),
				),
		} satisfies CaseStore;
		vi.mocked(withProjectContext).mockResolvedValueOnce(stubStore);

		const { resetSampleCasesAction } = await import("../caseDataBinding");
		const result = await resetSampleCasesAction(APP_ID, PATIENT_CASE_TYPE);
		expect(result).toEqual({
			kind: "validation-failure",
			caseType: "patient",
			failures,
		});
	});

	it("translates a SchemaNotSyncedError thrown by the store to the schema-not-synced arm", async () => {
		// `resetSampleData` reaches `getValidator` which throws
		// `SchemaNotSyncedError` when the case-type's schema row
		// hasn't been materialized via `applySchemaChange`. The
		// action's healing store re-materializes from the persisted
		// blueprint (the stubbed `loadApp` below) and retries the one
		// store call; the retry throws again, and the catch path
		// delegates to `mapPopulateSampleCasesError` which translates
		// to the typed arm carrying the case type — the heal's honest
		// backstop.
		const { getSession } = await import("@/lib/auth-utils");
		const { withProjectContext } = await import("@/lib/case-store");
		vi.mocked(getSession).mockResolvedValueOnce({
			user: { id: OWNER_A },
		} as unknown as Awaited<ReturnType<typeof getSession>>);
		const blueprint = buildBlueprint([PATIENT_CASE_TYPE]);
		// The heal re-materializes from the persisted blueprint, so it reads
		// `loadApp` once — the action itself no longer reads it.
		loadAppMock.mockResolvedValueOnce({ owner: OWNER_A, blueprint });
		materializeMock.mockResolvedValueOnce(undefined);
		const stubStore = {
			query: vi.fn(),
			count: vi.fn(),
			insert: vi.fn(),
			insertWithChildren: vi.fn(),
			update: vi.fn(),
			close: vi.fn(),
			traverse: vi.fn(),
			applySchemaChange: vi.fn(),
			dropSchema: vi.fn(),
			generateSampleData: vi.fn(),
			// Persistent rejection — the healed retry must throw again for
			// the typed arm to surface.
			resetSampleData: vi
				.fn()
				.mockRejectedValue(new SchemaNotSyncedError(APP_ID, "patient")),
		} satisfies CaseStore;
		vi.mocked(withProjectContext).mockResolvedValueOnce(stubStore);

		const { resetSampleCasesAction } = await import("../caseDataBinding");
		const result = await resetSampleCasesAction(APP_ID, PATIENT_CASE_TYPE);
		expect(result).toEqual({
			kind: "schema-not-synced",
			caseType: "patient",
		});
		// The heal genuinely ran before the backstop arm surfaced: one
		// materialize from the persisted blueprint, exactly one retry.
		expect(materializeMock).toHaveBeenCalledTimes(1);
		expect(stubStore.resetSampleData).toHaveBeenCalledTimes(2);
	});
});

// ---------------------------------------------------------------
// `loadCaseListPreviewAction` (Server Action)
// ---------------------------------------------------------------
//
// The action wraps `readCaseListPreview` with three responsibilities
// the helper itself doesn't carry:
//
//   1. Wire-boundary parse via `caseListConfigSchema.safeParse(...)`.
//      An unparseable config returns the `invalid-config` arm
//      WITHOUT touching auth or the store.
//   2. Session resolution + `withProjectContext` construction.
//   3. Catch-and-map for case-store typed errors.
//
// This block pins (1) — the parse-failure path — since the helper
// tests above bypass it by passing an already-typed
// `CaseListConfig`.

describe("loadCaseListPreviewAction", () => {
	it("returns the invalid-config arm with a path-prefixed message when caseListConfig fails Zod parse", async () => {
		// The action runs `getSession()` first (session-first matches
		// every other action in this file), then
		// `caseListConfigSchema.safeParse(...)`. Mock the session so
		// the parse path is reachable; pass a config whose `columns`
		// slot is a string instead of an array; the schema's
		// `z.array(columnSchema)` rejects with a structural type
		// mismatch.
		const { getSession } = await import("@/lib/auth-utils");
		vi.mocked(getSession).mockResolvedValueOnce({
			user: { id: OWNER_A },
		} as unknown as Awaited<ReturnType<typeof getSession>>);

		const { loadCaseListPreviewAction } = await import("../caseDataBinding");
		// Cast through `unknown` because the bad shape intentionally
		// violates the `CaseListConfig` type at the call site — the
		// runtime parse is the structural defense.
		const result = await loadCaseListPreviewAction({
			appId: APP_ID,
			caseType: "patient",
			blueprint: buildBlueprint([PATIENT_CASE_TYPE]),
			caseListConfig: {
				columns: "not an array",
				searchInputs: [],
			} as unknown as Parameters<
				typeof loadCaseListPreviewAction
			>[0]["caseListConfig"],
		});
		expect(result.kind).toBe("invalid-config");
		if (result.kind !== "invalid-config") return;
		// The action prefixes the first Zod issue's path so the
		// client surface dispatches on the structural cause rather
		// than the wrapped invariant body. The path for `columns` is
		// the literal string "columns".
		expect(result.message).toMatch(/^columns:/);
	});

	it("returns the invalid-blueprint arm with a path-prefixed message when blueprint fails Zod parse", async () => {
		// Symmetric to the `invalid-config` test above. After session
		// resolution and the (passing) `caseListConfig` parse, the
		// action runs `blueprintDocSchema.safeParse(...)`. Pass a
		// blueprint whose `appId` is a number — the schema's
		// `z.string()` rejects with a structural type mismatch.
		const { getSession } = await import("@/lib/auth-utils");
		vi.mocked(getSession).mockResolvedValueOnce({
			user: { id: OWNER_A },
		} as unknown as Awaited<ReturnType<typeof getSession>>);

		const { loadCaseListPreviewAction } = await import("../caseDataBinding");
		// Cast through `unknown` because the bad shape intentionally
		// violates the `BlueprintDoc` type at the call site — the
		// runtime parse is the structural defense.
		const result = await loadCaseListPreviewAction({
			appId: APP_ID,
			caseType: "patient",
			blueprint: {
				appId: 42,
				appName: "Test app",
				connectType: null,
				caseTypes: [],
				modules: {},
				forms: {},
				fields: {},
				moduleOrder: [],
				formOrder: {},
				fieldOrder: {},
				fieldParent: {},
			} as unknown as Parameters<
				typeof loadCaseListPreviewAction
			>[0]["blueprint"],
			caseListConfig: makeCaseListConfig(),
		});
		expect(result.kind).toBe("invalid-blueprint");
		if (result.kind !== "invalid-blueprint") return;
		// The path for `appId` is the literal string "appId".
		expect(result.message).toMatch(/^appId:/);
	});

	it("returns the unauthenticated arm before parsing when the session is absent", async () => {
		// Session-first ordering means an unauthenticated request
		// short-circuits BEFORE the Zod parse. Pass a deliberately
		// malformed `caseListConfig`; assert the result is
		// `unauthenticated`, not `invalid-config`.
		const { getSession } = await import("@/lib/auth-utils");
		vi.mocked(getSession).mockResolvedValueOnce(null);

		const { loadCaseListPreviewAction } = await import("../caseDataBinding");
		const result = await loadCaseListPreviewAction({
			appId: APP_ID,
			caseType: "patient",
			blueprint: buildBlueprint([PATIENT_CASE_TYPE]),
			caseListConfig: {
				columns: "not an array",
				searchInputs: [],
			} as unknown as Parameters<
				typeof loadCaseListPreviewAction
			>[0]["caseListConfig"],
		});
		expect(result).toEqual({ kind: "unauthenticated" });
	});

	it("parses a case-list-preview blueprint carrying the in-memory fieldParent index instead of rejecting it as an unrecognized key", async () => {
		// Regression for the live preview that never worked since the
		// case-list/case-search feature landed. The authoring surface
		// ships the doc-store snapshot through `pickBlueprintDoc`, which
		// re-attaches the in-memory `fieldParent` reverse index.
		// `blueprintDocSchema` is `.strict()` and doesn't declare
		// `fieldParent`, so parsing the raw value rejected it with
		// `Unrecognized key: "fieldParent"` and the preview rendered the
		// "Blueprint is malformed" state. The action must strip the
		// derived index before the trust-boundary parse so a real
		// snapshot reaches the store rather than the `invalid-blueprint`
		// arm. The other action tests in this block pass parse-failing
		// shapes (`appId: 42`) whose type error masks the `fieldParent`
		// key error — only a VALID-but-fieldParent-carrying doc exercises
		// the strip.
		const { getSession } = await import("@/lib/auth-utils");
		const { withProjectContext } = await import("@/lib/case-store");
		vi.mocked(getSession).mockResolvedValueOnce({
			user: { id: OWNER_A },
		} as unknown as Awaited<ReturnType<typeof getSession>>);
		const stubStore = {
			query: vi.fn().mockResolvedValueOnce([]),
			count: vi.fn(),
			insert: vi.fn(),
			insertWithChildren: vi.fn(),
			update: vi.fn(),
			close: vi.fn(),
			traverse: vi.fn(),
			applySchemaChange: vi.fn(),
			dropSchema: vi.fn(),
			generateSampleData: vi.fn(),
			resetSampleData: vi.fn(),
		} satisfies CaseStore;
		vi.mocked(withProjectContext).mockResolvedValueOnce(stubStore);

		const { loadCaseListPreviewAction } = await import("../caseDataBinding");
		const result = await loadCaseListPreviewAction({
			appId: APP_ID,
			caseType: "patient",
			blueprint: {
				...buildBlueprint([PATIENT_CASE_TYPE]),
				// The populated reverse index `pickBlueprintDoc` ships on
				// every live-preview call. A populated map makes the
				// regression unmistakable; even `{}` trips strict mode.
				fieldParent: {
					[asUuid("70000000-0000-0000-0000-000000000001")]: asUuid(
						"70000000-0000-0000-0000-000000000002",
					),
				},
			},
			caseListConfig: makeCaseListConfig({
				columns: [plainColumn(NAME_COLUMN_UUID, "name", "Name")],
			}),
		});
		// Empty stub store → `empty`. The load-bearing assertion is the
		// negative: the parse did NOT reject the fieldParent-carrying doc.
		expect(result.kind).toBe("empty");
		expect(stubStore.query).toHaveBeenCalledTimes(1);
	});

	it("returns the invalid-blueprint arm (not a thrown error) for a null blueprint over the wire", async () => {
		// The strip runs BEFORE the trust-boundary parse, so it must not
		// itself throw on a malformed wire payload — a `null`/`undefined`
		// blueprint (a non-editor caller, the exact shape the parse exists
		// to reject gracefully) must still land on the typed
		// `invalid-blueprint` arm, not a raw destructure TypeError routed
		// through the generic `error` arm. Session is mocked so the parse
		// path is reachable; `withProjectContext` must never be constructed
		// because the parse fails first.
		const { getSession } = await import("@/lib/auth-utils");
		const { withProjectContext } = await import("@/lib/case-store");
		vi.mocked(getSession).mockResolvedValueOnce({
			user: { id: OWNER_A },
		} as unknown as Awaited<ReturnType<typeof getSession>>);

		const { loadCaseListPreviewAction } = await import("../caseDataBinding");
		const result = await loadCaseListPreviewAction({
			appId: APP_ID,
			caseType: "patient",
			blueprint: null as unknown as Parameters<
				typeof loadCaseListPreviewAction
			>[0]["blueprint"],
			caseListConfig: makeCaseListConfig(),
		});
		expect(result.kind).toBe("invalid-blueprint");
		expect(vi.mocked(withProjectContext)).not.toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------
// `readFilterPreview` + `mapFilterPreviewError`
// ---------------------------------------------------------------
//
// The Filters-section live preview routes through the case-store's
// `query` (with `calculated`) for the row sample AND `count` for
// the totality figure — both compile the same predicate through the
// same stack so the count + row-list pair is internally consistent.
// These tests pin the discriminated-union return shapes the
// preview's UI dispatches on.

describe("readFilterPreview", () => {
	it("returns the rows arm with empty rows + totalCount: 0 when no cases exist", async () => {
		const store = makeStore(OWNER_A);
		const blueprint = buildBlueprint([PATIENT_CASE_TYPE]);
		await seedSchema(store, blueprint, "patient");
		const result = await readFilterPreview(store, {
			appId: APP_ID,
			caseType: "patient",
			caseTypeSchemas: buildCaseTypeMap(blueprint),
			caseListConfig: makeCaseListConfig({
				columns: [plainColumn(NAME_COLUMN_UUID, "name", "Name")],
			}),
		});
		// Single `rows` arm covers both populated and empty success
		// paths — the empty case is `rows: []` + `totalCount: 0`.
		expect(result).toEqual({ kind: "rows", rows: [], totalCount: 0 });
	});

	it("returns the rows arm with the row sample + total matching count when no filter is applied", async () => {
		const store = makeStore(OWNER_A);
		const blueprint = buildBlueprint([PATIENT_CASE_TYPE]);
		await seedSchema(store, blueprint, "patient");
		await store.insert({
			appId: APP_ID,
			row: {
				case_id: ALICE_CASE_ID,
				case_type: "patient",
				case_name: "Alice",
				status: "open",
				properties: { name: "Alice", age: 30 },
			},
		});
		await store.insert({
			appId: APP_ID,
			row: {
				case_id: BOB_CASE_ID,
				case_type: "patient",
				case_name: "Bob",
				status: "open",
				properties: { name: "Bob", age: 40 },
			},
		});

		const result = await readFilterPreview(store, {
			appId: APP_ID,
			caseType: "patient",
			caseTypeSchemas: buildCaseTypeMap(blueprint),
			caseListConfig: makeCaseListConfig({
				columns: [plainColumn(NAME_COLUMN_UUID, "name", "Name")],
			}),
		});
		expect(result.kind).toBe("rows");
		if (result.kind !== "rows") return;
		expect(result.rows).toHaveLength(2);
		expect(result.totalCount).toBe(2);
	});

	it("narrows to the predicate-matching subset and reports the matching totalCount", async () => {
		// Editing the filter must update BOTH the row sample and
		// the totalCount, identically — applying a predicate
		// affects both surfaces or neither.
		const store = makeStore(OWNER_A);
		const blueprint = buildBlueprint([PATIENT_CASE_TYPE]);
		await seedSchema(store, blueprint, "patient");
		await store.insert({
			appId: APP_ID,
			row: {
				case_id: ALICE_CASE_ID,
				case_type: "patient",
				case_name: "Alice",
				status: "open",
				properties: { name: "Alice", age: 25 },
			},
		});
		await store.insert({
			appId: APP_ID,
			row: {
				case_id: BOB_CASE_ID,
				case_type: "patient",
				case_name: "Bob",
				status: "open",
				properties: { name: "Bob", age: 40 },
			},
		});

		// `age > 30` — only Bob matches.
		const result = await readFilterPreview(store, {
			appId: APP_ID,
			caseType: "patient",
			caseTypeSchemas: buildCaseTypeMap(blueprint),
			caseListConfig: makeCaseListConfig({
				columns: [plainColumn(NAME_COLUMN_UUID, "name", "Name")],
				filter: gt(prop("patient", "age"), literal(30)),
			}),
		});
		expect(result.kind).toBe("rows");
		if (result.kind !== "rows") return;
		expect(result.rows).toHaveLength(1);
		expect(result.rows[0]?.case_id).toBe(BOB_CASE_ID);
		expect(result.totalCount).toBe(1);
	});

	it("populates calculated columns inline when the filter passes", async () => {
		// Pins the cross-feature shape: filter narrowing AND
		// calculated-column projection compose. The Filters preview
		// surfaces the same column-rendering shape the Display
		// section's preview uses, so calculated values must render
		// per row alongside the filter narrowing.
		const store = makeStore(OWNER_A);
		const blueprint = buildBlueprint([PATIENT_CASE_TYPE]);
		await seedSchema(store, blueprint, "patient");
		await store.insert({
			appId: APP_ID,
			row: {
				case_id: ALICE_CASE_ID,
				case_type: "patient",
				case_name: "Alice",
				status: "open",
				properties: { name: "Alice", age: 30 },
			},
		});

		const result = await readFilterPreview(store, {
			appId: APP_ID,
			caseType: "patient",
			caseTypeSchemas: buildCaseTypeMap(blueprint),
			caseListConfig: makeCaseListConfig({
				columns: [
					plainColumn(NAME_COLUMN_UUID, "name", "Name"),
					calculatedColumn(
						NOTE_CALC_COLUMN_UUID,
						"Note",
						term(literal("hello")),
					),
				],
				filter: eq(prop("patient", "name"), literal("Alice")),
			}),
		});
		expect(result.kind).toBe("rows");
		if (result.kind !== "rows") return;
		expect(result.rows[0]?.calculated[NOTE_CALC_COLUMN_UUID]).toBe("hello");
		expect(result.totalCount).toBe(1);
	});
});

describe("mapFilterPreviewError", () => {
	// Mirrors `mapCaseListPreviewError`'s shape — same typed errors,
	// same arm structure (the only difference between the two result
	// types is the paired `totalCount` on the success arms).

	it("maps CaseTypeNotInBlueprintError to the missing-case-type arm", () => {
		const err = new CaseTypeNotInBlueprintError("app-1", "patient");
		expect(mapFilterPreviewError(err)).toEqual({
			kind: "missing-case-type",
			caseType: "patient",
		});
	});

	it("maps SchemaNotSyncedError to the schema-not-synced arm", () => {
		const err = new SchemaNotSyncedError("app-1", "patient");
		expect(mapFilterPreviewError(err)).toEqual({
			kind: "schema-not-synced",
			caseType: "patient",
		});
	});

	it("falls through to the generic error arm for an unrelated Error", () => {
		const err = new Error("connection refused");
		const result = mapFilterPreviewError(err);
		expect(result.kind).toBe("error");
		if (result.kind !== "error") return;
		expect(result.message).toBe("connection refused");
	});

	it("falls through to the generic error arm with a default message for non-Error throws", () => {
		const result = mapFilterPreviewError("some string");
		expect(result.kind).toBe("error");
		if (result.kind !== "error") return;
		expect(result.message).toBe("Failed to load preview.");
	});
});

// ---------------------------------------------------------------
// `loadFilterPreviewAction` (Server Action)
// ---------------------------------------------------------------
//
// Mirrors `loadCaseListPreviewAction`'s test block. Pins the wire-
// boundary parse arms and the session-first ordering invariant.

describe("loadFilterPreviewAction", () => {
	it("returns the invalid-config arm with a path-prefixed message when caseListConfig fails Zod parse", async () => {
		const { getSession } = await import("@/lib/auth-utils");
		vi.mocked(getSession).mockResolvedValueOnce({
			user: { id: OWNER_A },
		} as unknown as Awaited<ReturnType<typeof getSession>>);

		const { loadFilterPreviewAction } = await import("../caseDataBinding");
		const result = await loadFilterPreviewAction({
			appId: APP_ID,
			caseType: "patient",
			blueprint: buildBlueprint([PATIENT_CASE_TYPE]),
			caseListConfig: {
				columns: "not an array",
				searchInputs: [],
			} as unknown as Parameters<
				typeof loadFilterPreviewAction
			>[0]["caseListConfig"],
		});
		expect(result.kind).toBe("invalid-config");
		if (result.kind !== "invalid-config") return;
		expect(result.message).toMatch(/^columns:/);
	});

	it("returns the invalid-blueprint arm with a path-prefixed message when blueprint fails Zod parse", async () => {
		const { getSession } = await import("@/lib/auth-utils");
		vi.mocked(getSession).mockResolvedValueOnce({
			user: { id: OWNER_A },
		} as unknown as Awaited<ReturnType<typeof getSession>>);

		const { loadFilterPreviewAction } = await import("../caseDataBinding");
		const result = await loadFilterPreviewAction({
			appId: APP_ID,
			caseType: "patient",
			blueprint: {
				appId: 42,
				appName: "Test app",
				connectType: null,
				caseTypes: [],
				modules: {},
				forms: {},
				fields: {},
				moduleOrder: [],
				formOrder: {},
				fieldOrder: {},
				fieldParent: {},
			} as unknown as Parameters<
				typeof loadFilterPreviewAction
			>[0]["blueprint"],
			caseListConfig: makeCaseListConfig(),
		});
		expect(result.kind).toBe("invalid-blueprint");
		if (result.kind !== "invalid-blueprint") return;
		expect(result.message).toMatch(/^appId:/);
	});

	it("returns the unauthenticated arm before parsing when the session is absent (session-first ordering)", async () => {
		// Pins the session-first ordering: an unauthenticated
		// request short-circuits BEFORE the Zod parse. The ordering
		// matches `loadCaseListPreviewAction` and every other action
		// in the file. Passing a deliberately malformed
		// `caseListConfig` here would fail `invalid-config` if the
		// parse ran first; the test asserts `unauthenticated` to
		// confirm the session check beats the parse to the punch.
		const { getSession } = await import("@/lib/auth-utils");
		vi.mocked(getSession).mockResolvedValueOnce(null);

		const { loadFilterPreviewAction } = await import("../caseDataBinding");
		const result = await loadFilterPreviewAction({
			appId: APP_ID,
			caseType: "patient",
			blueprint: buildBlueprint([PATIENT_CASE_TYPE]),
			caseListConfig: {
				columns: "not an array",
				searchInputs: [],
			} as unknown as Parameters<
				typeof loadFilterPreviewAction
			>[0]["caseListConfig"],
		});
		expect(result).toEqual({ kind: "unauthenticated" });
	});

	it("parses a filter-preview blueprint carrying the in-memory fieldParent index instead of rejecting it as an unrecognized key", async () => {
		// Sibling of the `loadCaseListPreviewAction` regression — the
		// Filters-section live preview ships the same `pickBlueprintDoc`
		// snapshot (with `fieldParent` re-attached) and runs the same
		// strict `blueprintDocSchema.safeParse`, so it carried the same
		// "Blueprint is malformed" failure. The action must strip the
		// derived index before the parse.
		const { getSession } = await import("@/lib/auth-utils");
		const { withProjectContext } = await import("@/lib/case-store");
		vi.mocked(getSession).mockResolvedValueOnce({
			user: { id: OWNER_A },
		} as unknown as Awaited<ReturnType<typeof getSession>>);
		const stubStore = {
			query: vi.fn().mockResolvedValueOnce([]),
			count: vi.fn().mockResolvedValueOnce(0),
			insert: vi.fn(),
			insertWithChildren: vi.fn(),
			update: vi.fn(),
			close: vi.fn(),
			traverse: vi.fn(),
			applySchemaChange: vi.fn(),
			dropSchema: vi.fn(),
			generateSampleData: vi.fn(),
			resetSampleData: vi.fn(),
		} satisfies CaseStore;
		vi.mocked(withProjectContext).mockResolvedValueOnce(stubStore);

		const { loadFilterPreviewAction } = await import("../caseDataBinding");
		const result = await loadFilterPreviewAction({
			appId: APP_ID,
			caseType: "patient",
			blueprint: {
				...buildBlueprint([PATIENT_CASE_TYPE]),
				fieldParent: {
					[asUuid("70000000-0000-0000-0000-000000000001")]: asUuid(
						"70000000-0000-0000-0000-000000000002",
					),
				},
			},
			caseListConfig: makeCaseListConfig({
				columns: [plainColumn(NAME_COLUMN_UUID, "name", "Name")],
			}),
		});
		// Filter preview returns a single `rows` arm even when empty. The
		// load-bearing assertion is the negative: NOT `invalid-blueprint`.
		expect(result).toEqual({ kind: "rows", rows: [], totalCount: 0 });
	});

	it("returns the invalid-blueprint arm (not a thrown error) for a null blueprint over the wire", async () => {
		// Sibling of the `loadCaseListPreviewAction` null-blueprint guard.
		// The pre-parse strip must not throw on a `null` wire payload — it
		// must reach the typed `invalid-blueprint` arm, not a raw
		// destructure TypeError surfaced through the generic `error` arm.
		const { getSession } = await import("@/lib/auth-utils");
		const { withProjectContext } = await import("@/lib/case-store");
		vi.mocked(getSession).mockResolvedValueOnce({
			user: { id: OWNER_A },
		} as unknown as Awaited<ReturnType<typeof getSession>>);

		const { loadFilterPreviewAction } = await import("../caseDataBinding");
		const result = await loadFilterPreviewAction({
			appId: APP_ID,
			caseType: "patient",
			blueprint: null as unknown as Parameters<
				typeof loadFilterPreviewAction
			>[0]["blueprint"],
			caseListConfig: makeCaseListConfig(),
		});
		expect(result.kind).toBe("invalid-blueprint");
		expect(vi.mocked(withProjectContext)).not.toHaveBeenCalled();
	});
});
