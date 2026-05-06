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
// `getSession()` + `withOwnerContext`. Driving those through a
// real session is heavy (Better Auth + Firestore); the
// architecture splits the I/O wrapper from the pure helpers
// precisely so tests can bind against a `CaseStore` instance from
// the contract harness without spinning up a session. The pure
// helpers carry every behavior the actions delegate to; the
// actions are thin wrappers.
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
import { PostgresCaseStore } from "@/lib/case-store/postgres/store";
import { HeuristicCaseGenerator } from "@/lib/case-store/sample/heuristic";
import { applyMigrationsViaAtlas } from "@/lib/case-store/sql/__tests__/applyMigrationsViaAtlas";
import { setupPerTestDatabase } from "@/lib/case-store/sql/__tests__/perTestDatabase";
// `Database` is the Kysely type contract for the four case-store
// tables — package-private, so the test reaches in via the
// internal subpath rather than the curated public barrel.
import type { Database } from "@/lib/case-store/sql/database";
import type { BlueprintDoc, CaseType } from "@/lib/domain";
import {
	applyCloseMutation,
	applyFollowupMutation,
	applyRegistrationMutation,
	applySurveyMutation,
	caseRowDisplayValue,
	caseRowToFormPreload,
	mapPopulateSampleCasesError,
	mapSubmitFormError,
	pickBlueprintDoc,
	readCaseData,
	readCases,
	SAMPLE_CASE_DEFAULT_COUNT,
	seedSampleCases,
} from "../caseDataBindingHelpers";
import type { SubmissionMutation } from "../caseDataBindingTypes";

// ---------------------------------------------------------------
// Module mocks for the `submitFormAction` Server Action tests
// ---------------------------------------------------------------
//
// `vi.mock` calls are hoisted above every import — they apply to
// the whole file. The helper-level tests above the
// `submitFormAction` block don't import `getSession` or
// `withOwnerContext`, so the mock surface is invisible to them.
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
		withOwnerContext: vi.fn(),
	};
});

// ---------------------------------------------------------------
// Per-test database lifecycle (mirrors PostgresCaseStore tests)
// ---------------------------------------------------------------

const dbHandle = setupPerTestDatabase({
	databaseNamePrefix: "binding_test_",
});

beforeEach(() => {
	applyMigrationsViaAtlas(dbHandle.uri, { stdio: "pipe" });
});

// ---------------------------------------------------------------
// Test fixture
// ---------------------------------------------------------------

const APP_ID = "app-binding";
const OWNER_A = "owner-a";
const OWNER_B = "owner-b";

const ALICE_CASE_ID = "40000000-0000-0000-0000-000000000001";
const BOB_CASE_ID = "40000000-0000-0000-0000-000000000002";

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
 * per-test database. Bypasses `withOwnerContext` (which threads
 * through the production singleton) — same shape the contract
 * harness's factory uses.
 */
function makeStore(ownerId: string): CaseStore {
	return new PostgresCaseStore({
		ownerId,
		db: dbHandle.db as unknown as Kysely<Database>,
		sampleGenerator: new HeuristicCaseGenerator(),
	});
}

/**
 * Seed the case-type's JSON Schema so subsequent inserts pass
 * AJV validation. Mirrors the shape the contract harness uses —
 * one call per test body before the first `insert`.
 */
async function seedSchema(
	store: CaseStore,
	blueprint: BlueprintDoc,
	caseType: string,
): Promise<void> {
	await store.applySchemaChange({ appId: APP_ID, caseType, blueprint });
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
		});
		expect(result.kind).toBe("row");
		if (result.kind !== "row") return;
		expect(result.row.case_id).toBe(ALICE_CASE_ID);
		expect(result.row.properties).toEqual({ name: "Alice", age: 30 });
	});

	it("returns the missing arm for an absent case-id", async () => {
		const store = makeStore(OWNER_A);
		const blueprint = buildBlueprint([PATIENT_CASE_TYPE]);
		await seedSchema(store, blueprint, "patient");

		const result = await readCaseData(store, {
			appId: APP_ID,
			caseType: "patient",
			caseId: "does-not-exist",
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
			caseType: "patient",
			blueprint,
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
		});
		if (result.kind !== "row") throw new Error("expected row");

		const preload = caseRowToFormPreload(result.row);
		expect(preload.get("name")).toBe("Alice");
		// Numbers stringify via String() — `30` becomes `"30"`.
		expect(preload.get("age")).toBe("30");
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
		// Arrays + objects round-trip through JSON.stringify so
		// downstream inspectors (calculate fields, agent debug
		// views) can parse them back.
		expect(preload.get("array_prop")).toBe('["a","b"]');
		expect(preload.get("object_prop")).toBe('{"nested":"value"}');
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

		expect(caseRowDisplayValue(row, "name")).toBe("Alice");
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
			parent_case_id: null,
			properties: { [field]: shadowValue },
		};
		expect(caseRowDisplayValue(row, field)).toBe(columnValue);
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
		// `fieldOrder`). The Zod parse path strips `fieldParent`
		// because the schema doesn't declare it; the projection
		// re-attaches it from the source state. Verify the
		// reverse-index round-trips.
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
	// without driving `getSession` + `withOwnerContext`. The
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

	it("maps a typed CaseTypeNotInBlueprintError thrown by the real seed flow", async () => {
		// End-to-end: the case-store's `generateSampleData` throws
		// `CaseTypeNotInBlueprintError` when the blueprint omits the
		// requested case type; `seedSampleCases` propagates it; the
		// mapping helper translates to the structured arm. Pins the
		// catch path through the real error-thrower.
		const store = makeStore(OWNER_A);
		// Blueprint declares `household` only; the seed call asks
		// for `patient`, which trips `findCaseTypeOrThrow`.
		const blueprint = buildBlueprint([
			{
				name: "household",
				properties: [{ name: "region", label: "Region", data_type: "text" }],
			},
		]);
		// No schema sync at all for any case type — but the throw
		// is `CaseTypeNotInBlueprintError`, NOT `SchemaNotSyncedError`,
		// because the blueprint check runs at the top of the
		// generator's `generate()` (before any schema lookup).
		try {
			await seedSampleCases(store, {
				appId: APP_ID,
				caseType: "patient",
				blueprint,
			});
			throw new Error("seedSampleCases should have thrown");
		} catch (err) {
			const result = mapPopulateSampleCasesError(err);
			expect(result).toEqual({
				kind: "missing-case-type",
				caseType: "patient",
			});
		}
	});

	it("maps a typed SchemaNotSyncedError thrown by the real seed flow", async () => {
		// End-to-end mapping for the schema-sync-skipped path. The
		// blueprint declares the case type but `applySchemaChange`
		// hasn't run, so the case-store's `getValidator` reaches a
		// missing `case_type_schemas` row and throws.
		const store = makeStore(OWNER_A);
		const blueprint = buildBlueprint([PATIENT_CASE_TYPE]);
		// Skip `seedSchema` on purpose — that's the precondition the
		// error covers.
		try {
			await seedSampleCases(store, {
				appId: APP_ID,
				caseType: "patient",
				blueprint,
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
			ownerId: OWNER_A,
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
				caseType: "patient",
				blueprint,
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
		// (`raw === undefined || raw === ""` at `formEngine.ts:402`)
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
		// `modified_on` itself (`postgres/store.ts:572`), so a real
		// close always advances the timestamp regardless of whether
		// the empty patch was short-circuited. A spy on `store.update`
		// is the durable detector: `close()` writes via a direct
		// `db.updateTable(...)` chain, NOT through the public
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
	// `getSession` / `withOwnerContext`.

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
// Auth / Firestore. The `vi.mock` calls at the top of the file
// stub `getSession` and `withOwnerContext` so the action's body
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
		const { withOwnerContext } = await import("@/lib/case-store");
		vi.mocked(getSession).mockResolvedValueOnce({
			user: { id: OWNER_A },
			// The action only reads `session.user.id`; the rest of the
			// shape is irrelevant for this assertion. Cast through
			// `unknown` because Better Auth's `Session` type carries
			// many fields we don't synthesize.
		} as unknown as Awaited<ReturnType<typeof getSession>>);
		// `withOwnerContext` is called but its result is unused for
		// the survey arm; supply a stub that throws if any method is
		// called so a regression to "survey routes through the store"
		// surfaces loudly.
		const stubStore = {
			query: vi.fn(),
			insert: vi.fn(),
			insertWithChildren: vi.fn(),
			update: vi.fn(),
			close: vi.fn(),
			traverse: vi.fn(),
			applySchemaChange: vi.fn(),
			generateSampleData: vi.fn(),
			resetSampleData: vi.fn(),
		} satisfies CaseStore;
		vi.mocked(withOwnerContext).mockResolvedValueOnce(stubStore);

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
		const { withOwnerContext } = await import("@/lib/case-store");
		vi.mocked(getSession).mockResolvedValueOnce({
			user: { id: OWNER_A },
		} as unknown as Awaited<ReturnType<typeof getSession>>);
		const stubStore = {
			query: vi.fn(),
			insert: vi.fn(),
			insertWithChildren: vi.fn(),
			update: vi
				.fn()
				.mockRejectedValueOnce(new CaseNotFoundError(ALICE_CASE_ID)),
			close: vi.fn(),
			traverse: vi.fn(),
			applySchemaChange: vi.fn(),
			generateSampleData: vi.fn(),
			resetSampleData: vi.fn(),
		} satisfies CaseStore;
		vi.mocked(withOwnerContext).mockResolvedValueOnce(stubStore);

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
