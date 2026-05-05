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
import { beforeEach, describe, expect, it } from "vitest";
import type { CaseRow, CaseStore, JsonObject } from "@/lib/case-store";
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
	caseRowDisplayValue,
	caseRowToFormPreload,
	readCaseData,
	readCases,
	SAMPLE_CASE_DEFAULT_COUNT,
	seedSampleCases,
} from "../caseDataBindingHelpers";

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
				status: "open",
				properties: { name: "Alice", age: 30 },
			},
		});
		await store.insert({
			appId: APP_ID,
			row: {
				case_id: BOB_CASE_ID,
				case_type: "patient",
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
});
