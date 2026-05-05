// lib/case-store/__tests__/storeContract.ts
//
// Pure interface-compliance harness for `CaseStore`. The harness
// is a function that takes a factory `(ownerId) => Promise<CaseStore>`
// plus a `describeContract` callback the caller invokes from inside
// a `describe(...)` block — the harness owns the test definitions
// and the caller owns the per-test database lifecycle.
//
// ## Why a harness, not a per-implementation test file
//
// `PostgresCaseStore` is the only implementation today, but the
// `CaseStore` interface is the seam Plans 3 / 4 / 5 bind against.
// Every method-level contract this harness exercises (predicate-
// filtered reads, JSONB merge on update, relation-path traversal,
// schema-sync atomicity, tenant isolation) is part of the
// architectural contract — Plan 1's compilers, the `(app_id,
// owner_id)` tenant model, the JSONB validator. A future
// implementation that diverges from this contract is a regression,
// not a feature; the harness pins the contract independently from
// any one implementation's source.
//
// ## What the caller wires
//
// Each `runStoreContract({ factory, ... })` call configures one
// describe-block of contract tests against the supplied factory.
// The harness handles `beforeEach` / `afterEach` for the per-test
// state it owns (e.g. seeding `case_type_schemas` for tests that
// insert / update); the caller's setup callbacks own the
// per-test database lifecycle (creating + dropping a fresh
// database each test).
//
// The factory is async because production's `withOwnerContext`
// resolves the singleton `Kysely<Database>` via Cloud SQL's
// connector; tests bypass `withOwnerContext` and construct
// `PostgresCaseStore` directly with an isolated per-test handle,
// but the async signature keeps the harness implementation-
// agnostic.
//
// ## Why each test seeds its own schema
//
// `PostgresCaseStore.insert` / `update` validate against
// `case_type_schemas[appId, caseType]` via ajv before the row
// hits Postgres; an absent schema row throws (see
// `lib/case-store/postgres/store.ts` `getValidator`). Tests that
// exercise inserts therefore call `applySchemaChange` (no-`change`
// arm) inside the test body to seed the schema row. The
// `seedSchema` helper below makes that one line per test rather
// than four.

import { describe, expect, it } from "vitest";
import type { BlueprintDoc, CaseProperty, CaseType } from "@/lib/domain";
import {
	ancestorPath,
	gt,
	literal,
	prop,
	subcasePath,
} from "@/lib/domain/predicate/builders";
import type { CaseStore } from "../store";

// ---------------------------------------------------------------
// Public types
// ---------------------------------------------------------------

/**
 * Configuration for a contract-test run.
 *
 * `factory` constructs a `CaseStore` bound to the supplied
 * `ownerId`. The harness invokes the factory once per test (or
 * twice in the tenant-isolation test) — every call binds against
 * the same per-test database the caller's setup hook provisioned.
 *
 * `describeName` lets the caller name the describe block (e.g. the
 * concrete implementation under test). Defaults to a generic
 * label.
 */
export interface RunStoreContractOptions {
	/**
	 * Construct a `CaseStore` for the supplied owner id. The harness
	 * calls this inside test bodies — the caller must ensure the
	 * factory closes over the per-test database handle their setup
	 * hook provisions.
	 */
	factory: (ownerId: string) => Promise<CaseStore>;
	/**
	 * Optional describe-block label. The caller usually passes the
	 * implementation name (e.g. `"PostgresCaseStore"`); defaults to
	 * `"CaseStore contract"` so a stripped-down call still produces
	 * a readable test list.
	 */
	describeName?: string;
}

// ---------------------------------------------------------------
// Test fixture data
// ---------------------------------------------------------------
//
// Stable IDs and case-type definitions used across every test in
// the harness. Per-test BEGIN/ROLLBACK or per-test database drops
// keep these reusable without conflict, and stable identifiers
// keep failing-test traces readable.

const APP_ID = "app-contract";
const OWNER_A = "owner-a";
const OWNER_B = "owner-b";

const PATIENT_ALICE_ID = "30000000-0000-0000-0000-000000000001";
const PATIENT_BOB_ID = "30000000-0000-0000-0000-000000000002";
const PATIENT_CAROL_ID = "30000000-0000-0000-0000-000000000003";
const HOUSEHOLD_ID = "30000000-0000-0000-0000-000000000010";
const CHILD_PATIENT_ID = "30000000-0000-0000-0000-000000000020";

const PATIENT_PROPERTIES: CaseProperty[] = [
	{ name: "name", label: "Name", data_type: "text" },
	{ name: "age", label: "Age", data_type: "int" },
];

/**
 * Build a `BlueprintDoc` carrying just the case types the harness
 * needs. `BlueprintDoc` carries many more fields than the case-
 * store cares about (modules, forms, fields, etc.); the unused
 * ones are filled with empty defaults so the harness focuses on
 * the case-type surface.
 *
 * Caller passes the case types they want for a given test; the
 * helper bakes the rest of the doc shape so each test body reads
 * as one line.
 */
function buildBlueprint(caseTypes: CaseType[]): BlueprintDoc {
	return {
		appId: APP_ID,
		appName: "contract-test-app",
		connectType: null,
		caseTypes,
		modules: {},
		forms: {},
		fields: {},
		moduleOrder: [],
		formOrder: {},
		fieldOrder: {},
		fieldParent: {},
	};
}

const PATIENT_CASE_TYPE: CaseType = {
	name: "patient",
	properties: PATIENT_PROPERTIES,
};

const PATIENT_WITH_PARENT_CASE_TYPE: CaseType = {
	name: "patient",
	parent_type: "household",
	properties: PATIENT_PROPERTIES,
};

const HOUSEHOLD_CASE_TYPE: CaseType = {
	name: "household",
	properties: [{ name: "region", label: "Region", data_type: "text" }],
};

// ---------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------

/**
 * Seed `case_type_schemas` for one case type by running the
 * additive arm of `applySchemaChange`. Subsequent `insert` /
 * `update` calls under the same `(appId, caseType)` then have a
 * schema row to validate against.
 *
 * `appId` defaults to the harness's shared `APP_ID` so the common
 * one-app-per-test pattern reads as a three-argument call; tests
 * exercising multi-app behavior pass an explicit `appId`.
 */
async function seedSchema(
	store: CaseStore,
	blueprint: BlueprintDoc,
	caseType: string,
	appId: string = APP_ID,
): Promise<void> {
	await store.applySchemaChange({
		appId,
		caseType,
		blueprint,
	});
}

/**
 * Build the JSON-stringified `properties` payload Kysely's
 * `JSONColumnType` insert-side accepts. The harness treats the
 * payload as JSON-shaped; downstream tests that reach into the
 * row read it back as a parsed object via `CaseRow.properties`.
 */
function makeProperties(payload: Record<string, unknown>): string {
	return JSON.stringify(payload);
}

// ---------------------------------------------------------------
// The harness — one describe block, one set of tests
// ---------------------------------------------------------------

/**
 * Execute the `CaseStore` contract tests against the supplied
 * factory. The caller wraps this call in their own setup that
 * provisions per-test database isolation (see
 * `lib/case-store/postgres/__tests__/store.test.ts` for the
 * canonical wiring).
 */
export function runStoreContract(options: RunStoreContractOptions): void {
	const describeName = options.describeName ?? "CaseStore contract";

	describe(describeName, () => {
		// -----------------------------------------------------------
		// insert + query roundtrip
		// -----------------------------------------------------------

		it("inserts a row and reads it back via query", async () => {
			const store = await options.factory(OWNER_A);
			const blueprint = buildBlueprint([PATIENT_CASE_TYPE]);
			await seedSchema(store, blueprint, "patient");

			const inserted = await store.insert({
				appId: APP_ID,
				row: {
					case_id: PATIENT_ALICE_ID,
					case_type: "patient",
					status: "open",
					properties: makeProperties({ name: "Alice", age: 30 }),
				},
			});
			expect(inserted.caseId).toBe(PATIENT_ALICE_ID);

			const rows = await store.query({
				appId: APP_ID,
				caseType: "patient",
			});
			expect(rows).toHaveLength(1);
			const row = rows[0];
			expect(row?.case_id).toBe(PATIENT_ALICE_ID);
			expect(row?.case_type).toBe("patient");
			expect(row?.owner_id).toBe(OWNER_A);
			expect(row?.properties).toEqual({ name: "Alice", age: 30 });
		});

		it("inserts a JsonObject `properties` payload (not a JSON string)", async () => {
			// Kysely's `JSONColumnType<JsonObject>` insert side admits
			// either a plain object or a JSON-stringified value;
			// object-literal `properties` payloads round-trip through
			// `query` as the same shape because the case store's
			// stringification path fires for both string and object
			// inputs. pg's parameter binder coerces non-string values
			// to text via `String(value)` for JSONB columns, so the
			// stringification cannot be skipped on the object arm.
			const store = await options.factory(OWNER_A);
			const blueprint = buildBlueprint([PATIENT_CASE_TYPE]);
			await seedSchema(store, blueprint, "patient");

			await store.insert({
				appId: APP_ID,
				row: {
					case_id: PATIENT_ALICE_ID,
					case_type: "patient",
					status: "open",
					// Object literal, NOT a JSON string.
					properties: { name: "Alice", age: 30 },
				},
			});

			const rows = await store.query({
				appId: APP_ID,
				caseType: "patient",
			});
			expect(rows).toHaveLength(1);
			expect(rows[0]?.properties).toEqual({ name: "Alice", age: 30 });
		});

		// -----------------------------------------------------------
		// query with predicate filter
		// -----------------------------------------------------------

		it("filters rows via a property-read predicate", async () => {
			const store = await options.factory(OWNER_A);
			const blueprint = buildBlueprint([PATIENT_CASE_TYPE]);
			await seedSchema(store, blueprint, "patient");

			await store.insert({
				appId: APP_ID,
				row: {
					case_id: PATIENT_ALICE_ID,
					case_type: "patient",
					status: "open",
					properties: makeProperties({ name: "Alice", age: 25 }),
				},
			});
			await store.insert({
				appId: APP_ID,
				row: {
					case_id: PATIENT_BOB_ID,
					case_type: "patient",
					status: "open",
					properties: makeProperties({ name: "Bob", age: 40 }),
				},
			});

			// `age > 30` matches only Bob — pins both that the
			// predicate compiler resolves the property read against
			// the supplied blueprint AND that the integer cast
			// (`(properties->>'age')::int`) executes correctly on
			// the live engine.
			const matched = await store.query({
				appId: APP_ID,
				caseType: "patient",
				blueprint,
				predicate: gt(prop("patient", "age"), literal(30)),
			});
			expect(matched).toHaveLength(1);
			expect(matched[0]?.case_id).toBe(PATIENT_BOB_ID);
		});

		// -----------------------------------------------------------
		// update — JSONB merge + modified_on bump
		// -----------------------------------------------------------

		it("merges patches into JSONB properties and bumps modified_on", async () => {
			const store = await options.factory(OWNER_A);
			const blueprint = buildBlueprint([PATIENT_CASE_TYPE]);
			await seedSchema(store, blueprint, "patient");

			await store.insert({
				appId: APP_ID,
				row: {
					case_id: PATIENT_ALICE_ID,
					case_type: "patient",
					status: "open",
					properties: makeProperties({ name: "Alice", age: 25 }),
				},
			});

			await store.update({
				appId: APP_ID,
				caseId: PATIENT_ALICE_ID,
				patch: {
					// Update one property; leave the other untouched.
					properties: makeProperties({ age: 26 }),
				},
			});

			const rows = await store.query({
				appId: APP_ID,
				caseType: "patient",
			});
			expect(rows).toHaveLength(1);
			const row = rows[0];
			// Merge semantics: name preserved, age updated.
			expect(row?.properties).toEqual({ name: "Alice", age: 26 });
			// `modified_on` is set to a non-null timestamp by the
			// store's `now()` clause.
			expect(row?.modified_on).not.toBeNull();
		});

		// -----------------------------------------------------------
		// close — closed_on transitions to non-null
		// -----------------------------------------------------------

		it("close marks closed_on without deleting the row", async () => {
			const store = await options.factory(OWNER_A);
			const blueprint = buildBlueprint([PATIENT_CASE_TYPE]);
			await seedSchema(store, blueprint, "patient");

			await store.insert({
				appId: APP_ID,
				row: {
					case_id: PATIENT_ALICE_ID,
					case_type: "patient",
					status: "open",
					properties: makeProperties({ name: "Alice", age: 25 }),
				},
			});
			await store.close({
				appId: APP_ID,
				caseId: PATIENT_ALICE_ID,
				status: "closed",
			});

			const rows = await store.query({
				appId: APP_ID,
				caseType: "patient",
			});
			// Row still present (close is not delete) but closed_on
			// stamped and status updated.
			expect(rows).toHaveLength(1);
			expect(rows[0]?.closed_on).not.toBeNull();
			expect(rows[0]?.status).toBe("closed");
		});

		// -----------------------------------------------------------
		// traverse — relation-path walk
		// -----------------------------------------------------------

		it("traverse walks subcase relations via case_indices", async () => {
			const store = await options.factory(OWNER_A);
			const blueprint = buildBlueprint([
				PATIENT_WITH_PARENT_CASE_TYPE,
				HOUSEHOLD_CASE_TYPE,
			]);
			await seedSchema(store, blueprint, "patient");
			await seedSchema(store, blueprint, "household");

			// Parent household.
			await store.insert({
				appId: APP_ID,
				row: {
					case_id: HOUSEHOLD_ID,
					case_type: "household",
					status: "open",
					properties: makeProperties({ region: "North" }),
				},
			});
			// Child patient pointed at the household — the store's
			// `insert` derives a `case_indices` row from
			// `parent_case_id`.
			await store.insert({
				appId: APP_ID,
				row: {
					case_id: CHILD_PATIENT_ID,
					case_type: "patient",
					status: "open",
					parent_case_id: HOUSEHOLD_ID,
					properties: makeProperties({ name: "Child", age: 5 }),
				},
			});

			// From the household, walk one hop down via the `parent`
			// identifier — the child patient is the leaf.
			const subcases = await store.traverse({
				appId: APP_ID,
				caseId: HOUSEHOLD_ID,
				via: subcasePath("parent", "patient"),
			});
			expect(subcases).toHaveLength(1);
			expect(subcases[0]?.case_id).toBe(CHILD_PATIENT_ID);

			// From the patient, walk one hop up via the same
			// identifier — the household is the ancestor.
			const ancestors = await store.traverse({
				appId: APP_ID,
				caseId: CHILD_PATIENT_ID,
				via: ancestorPath({ identifier: "parent" }),
			});
			expect(ancestors).toHaveLength(1);
			expect(ancestors[0]?.case_id).toBe(HOUSEHOLD_ID);
		});

		// -----------------------------------------------------------
		// applySchemaChange — additive (no `change`)
		// -----------------------------------------------------------

		it("applySchemaChange (additive) upserts the JSON Schema row", async () => {
			const store = await options.factory(OWNER_A);
			const blueprint = buildBlueprint([PATIENT_CASE_TYPE]);
			const report = await store.applySchemaChange({
				appId: APP_ID,
				caseType: "patient",
				blueprint,
			});
			// Additive path: zero rows touched, zero quarantined.
			expect(report).toEqual({
				migrated: 0,
				quarantined: 0,
				skipped: 0,
				failureReasons: [],
			});

			// A second call with an extended schema upserts cleanly —
			// no unique-violation, no error.
			const extendedCaseType: CaseType = {
				name: "patient",
				properties: [
					...PATIENT_PROPERTIES,
					{ name: "phone", label: "Phone", data_type: "text" },
				],
			};
			const extendedBlueprint = buildBlueprint([extendedCaseType]);
			const second = await store.applySchemaChange({
				appId: APP_ID,
				caseType: "patient",
				blueprint: extendedBlueprint,
			});
			expect(second.migrated).toBe(0);
		});

		// -----------------------------------------------------------
		// applySchemaChange — rename
		// -----------------------------------------------------------

		it("applySchemaChange (rename) atomically renames a property in every row", async () => {
			const store = await options.factory(OWNER_A);
			const initialBlueprint = buildBlueprint([PATIENT_CASE_TYPE]);
			await seedSchema(store, initialBlueprint, "patient");

			await store.insert({
				appId: APP_ID,
				row: {
					case_id: PATIENT_ALICE_ID,
					case_type: "patient",
					status: "open",
					properties: makeProperties({ name: "Alice", age: 25 }),
				},
			});
			await store.insert({
				appId: APP_ID,
				row: {
					case_id: PATIENT_BOB_ID,
					case_type: "patient",
					status: "open",
					properties: makeProperties({ name: "Bob", age: 40 }),
				},
			});
			// One row that doesn't carry the property — should be
			// untouched and not counted as migrated.
			await store.insert({
				appId: APP_ID,
				row: {
					case_id: PATIENT_CAROL_ID,
					case_type: "patient",
					status: "open",
					properties: makeProperties({ name: "Carol" }),
				},
			});

			// The rename targets `age` → `years`. The new blueprint
			// must reflect the renamed property so the schema regen
			// upserts a schema that accepts `years`.
			const renamedCaseType: CaseType = {
				name: "patient",
				properties: [
					{ name: "name", label: "Name", data_type: "text" },
					{ name: "years", label: "Years", data_type: "int" },
				],
			};
			const renamedBlueprint = buildBlueprint([renamedCaseType]);
			const report = await store.applySchemaChange({
				appId: APP_ID,
				caseType: "patient",
				blueprint: renamedBlueprint,
				property: "years",
				change: { kind: "rename", from: "age", to: "years" },
			});
			// Two rows carried `age`; one didn't.
			expect(report.migrated).toBe(2);
			expect(report.quarantined).toBe(0);
			// Carol's row didn't carry `age`; the count reflects the
			// actual unmatched-row population (one row skipped,
			// neither migrated nor quarantined).
			expect(report.skipped).toBe(1);
			expect(report.failureReasons).toEqual([]);

			const rows = await store.query({
				appId: APP_ID,
				caseType: "patient",
			});
			const byId = new Map(rows.map((r) => [r.case_id, r]));
			expect(byId.get(PATIENT_ALICE_ID)?.properties).toEqual({
				name: "Alice",
				years: 25,
			});
			expect(byId.get(PATIENT_BOB_ID)?.properties).toEqual({
				name: "Bob",
				years: 40,
			});
			// Carol's row didn't carry `age`; her properties stay as
			// `{ name: "Carol" }`.
			expect(byId.get(PATIENT_CAROL_ID)?.properties).toEqual({
				name: "Carol",
			});
		});

		// -----------------------------------------------------------
		// applySchemaChange — retype
		// -----------------------------------------------------------

		it("applySchemaChange (retype) quarantines rows that fail the cast", async () => {
			const store = await options.factory(OWNER_A);
			// Initial schema: `age` is text. AJV will accept either
			// numeric-looking and non-numeric strings on insert.
			const initialCaseType: CaseType = {
				name: "patient",
				properties: [{ name: "age", label: "Age", data_type: "text" }],
			};
			const initialBlueprint = buildBlueprint([initialCaseType]);
			await seedSchema(store, initialBlueprint, "patient");

			await store.insert({
				appId: APP_ID,
				row: {
					case_id: PATIENT_ALICE_ID,
					case_type: "patient",
					status: "open",
					// Castable to int — survives the retype.
					properties: makeProperties({ age: "30" }),
				},
			});
			await store.insert({
				appId: APP_ID,
				row: {
					case_id: PATIENT_BOB_ID,
					case_type: "patient",
					status: "open",
					// Not castable to int — moves to quarantine.
					properties: makeProperties({ age: "abc" }),
				},
			});

			// Retype `age` from text to int. The retyped blueprint
			// must reflect the new type so the schema regen upserts
			// a schema validating against integers.
			const retypedCaseType: CaseType = {
				name: "patient",
				properties: [{ name: "age", label: "Age", data_type: "int" }],
			};
			const retypedBlueprint = buildBlueprint([retypedCaseType]);
			const report = await store.applySchemaChange({
				appId: APP_ID,
				caseType: "patient",
				blueprint: retypedBlueprint,
				property: "age",
				change: {
					kind: "retype",
					fromType: "text",
					toType: "int",
				},
			});
			expect(report.migrated).toBe(1);
			expect(report.quarantined).toBe(1);
			expect(report.skipped).toBe(0);
			expect(report.failureReasons).toHaveLength(1);
			// The reason text names the cast direction + the property.
			expect(report.failureReasons[0]).toContain("text");
			expect(report.failureReasons[0]).toContain("int");
			expect(report.failureReasons[0]).toContain("age");

			// Alice's row stays in `cases` with the value cast to a
			// JS number; Bob's row is gone (moved to quarantine).
			const survivors = await store.query({
				appId: APP_ID,
				caseType: "patient",
			});
			expect(survivors).toHaveLength(1);
			expect(survivors[0]?.case_id).toBe(PATIENT_ALICE_ID);
			expect(survivors[0]?.properties).toEqual({ age: 30 });
		});

		// -----------------------------------------------------------
		// applySchemaChange — narrow-options
		// -----------------------------------------------------------

		it("applySchemaChange (narrow-options) quarantines rows with removed values", async () => {
			const store = await options.factory(OWNER_A);
			const initialCaseType: CaseType = {
				name: "patient",
				properties: [
					{
						name: "color",
						label: "Color",
						data_type: "single_select",
						options: [
							{ value: "red", label: "Red" },
							{ value: "blue", label: "Blue" },
						],
					},
				],
			};
			const initialBlueprint = buildBlueprint([initialCaseType]);
			await seedSchema(store, initialBlueprint, "patient");

			await store.insert({
				appId: APP_ID,
				row: {
					case_id: PATIENT_ALICE_ID,
					case_type: "patient",
					status: "open",
					properties: makeProperties({ color: "red" }),
				},
			});
			await store.insert({
				appId: APP_ID,
				row: {
					case_id: PATIENT_BOB_ID,
					case_type: "patient",
					status: "open",
					properties: makeProperties({ color: "blue" }),
				},
			});

			// Narrow `color` to drop `red`. Alice's row carries
			// `red` and moves to quarantine; Bob's row stays.
			const narrowedCaseType: CaseType = {
				name: "patient",
				properties: [
					{
						name: "color",
						label: "Color",
						data_type: "single_select",
						options: [{ value: "blue", label: "Blue" }],
					},
				],
			};
			const narrowedBlueprint = buildBlueprint([narrowedCaseType]);
			const report = await store.applySchemaChange({
				appId: APP_ID,
				caseType: "patient",
				blueprint: narrowedBlueprint,
				property: "color",
				change: { kind: "narrow-options", removedOptions: ["red"] },
			});
			expect(report.quarantined).toBe(1);
			expect(report.skipped).toBe(1);
			expect(report.failureReasons).toEqual([
				"option 'red' removed from property 'color'",
			]);

			// Alice gone from `cases` (moved to quarantine); Bob
			// remains.
			const survivors = await store.query({
				appId: APP_ID,
				caseType: "patient",
			});
			expect(survivors).toHaveLength(1);
			expect(survivors[0]?.case_id).toBe(PATIENT_BOB_ID);
		});

		// -----------------------------------------------------------
		// Tenant isolation — owner_id filter is structural
		// -----------------------------------------------------------

		it("query is scoped to the bound owner — owner-B cannot see owner-A's row", async () => {
			const storeA = await options.factory(OWNER_A);
			const storeB = await options.factory(OWNER_B);
			const blueprint = buildBlueprint([PATIENT_CASE_TYPE]);
			// Schema is per-app, not per-owner, so seeding through
			// either store works — pick one.
			await seedSchema(storeA, blueprint, "patient");

			await storeA.insert({
				appId: APP_ID,
				row: {
					case_id: PATIENT_ALICE_ID,
					case_type: "patient",
					status: "open",
					properties: makeProperties({ name: "Alice", age: 25 }),
				},
			});

			const seenByA = await storeA.query({
				appId: APP_ID,
				caseType: "patient",
			});
			expect(seenByA).toHaveLength(1);

			const seenByB = await storeB.query({
				appId: APP_ID,
				caseType: "patient",
			});
			expect(seenByB).toHaveLength(0);
		});

		it("update from another owner cannot mutate the row", async () => {
			const storeA = await options.factory(OWNER_A);
			const storeB = await options.factory(OWNER_B);
			const blueprint = buildBlueprint([PATIENT_CASE_TYPE]);
			await seedSchema(storeA, blueprint, "patient");

			await storeA.insert({
				appId: APP_ID,
				row: {
					case_id: PATIENT_ALICE_ID,
					case_type: "patient",
					status: "open",
					properties: makeProperties({ name: "Alice", age: 25 }),
				},
			});

			// Owner B's update against owner A's case throws because
			// the row is invisible under owner B's filter. The
			// throw shape pins the contract: visibility is the gate,
			// not "always allow but write nothing".
			await expect(
				storeB.update({
					appId: APP_ID,
					caseId: PATIENT_ALICE_ID,
					patch: { properties: makeProperties({ age: 99 }) },
				}),
			).rejects.toThrow(/not found/i);

			// The row's data is untouched as seen through owner A.
			const rows = await storeA.query({
				appId: APP_ID,
				caseType: "patient",
			});
			expect(rows).toHaveLength(1);
			expect(rows[0]?.properties).toEqual({ name: "Alice", age: 25 });
		});

		it("close from another owner cannot close the row", async () => {
			const storeA = await options.factory(OWNER_A);
			const storeB = await options.factory(OWNER_B);
			const blueprint = buildBlueprint([PATIENT_CASE_TYPE]);
			await seedSchema(storeA, blueprint, "patient");

			await storeA.insert({
				appId: APP_ID,
				row: {
					case_id: PATIENT_ALICE_ID,
					case_type: "patient",
					status: "open",
					properties: makeProperties({ name: "Alice", age: 25 }),
				},
			});

			// `close` is a fire-and-forget UPDATE; the owner filter
			// reduces the row set to zero so the statement matches
			// no rows. No throw — but no mutation either.
			await storeB.close({
				appId: APP_ID,
				caseId: PATIENT_ALICE_ID,
				status: "closed",
			});

			const rows = await storeA.query({
				appId: APP_ID,
				caseType: "patient",
			});
			expect(rows).toHaveLength(1);
			expect(rows[0]?.closed_on).toBeNull();
			expect(rows[0]?.status).toBe("open");
		});

		it("traverse from another owner cannot reach the row", async () => {
			const storeA = await options.factory(OWNER_A);
			const storeB = await options.factory(OWNER_B);
			const blueprint = buildBlueprint([PATIENT_CASE_TYPE]);
			await seedSchema(storeA, blueprint, "patient");

			await storeA.insert({
				appId: APP_ID,
				row: {
					case_id: PATIENT_ALICE_ID,
					case_type: "patient",
					status: "open",
					properties: makeProperties({ name: "Alice", age: 25 }),
				},
			});

			// `self` traverse against owner B's view returns empty
			// because the case's `owner_id` doesn't match owner B.
			const reached = await storeB.traverse({
				appId: APP_ID,
				caseId: PATIENT_ALICE_ID,
				via: { kind: "self" },
			});
			expect(reached).toHaveLength(0);
		});

		// -----------------------------------------------------------
		// generateSampleData — heuristic-driven population
		// -----------------------------------------------------------

		it("generateSampleData inserts the requested count of rows for the case-type", async () => {
			const store = await options.factory(OWNER_A);
			const blueprint = buildBlueprint([PATIENT_CASE_TYPE]);
			await seedSchema(store, blueprint, "patient");

			const result = await store.generateSampleData({
				appId: APP_ID,
				caseType: "patient",
				count: 5,
				seed: "alpha",
				blueprint,
			});
			expect(result).toEqual({ inserted: 5 });

			const rows = await store.query({
				appId: APP_ID,
				caseType: "patient",
			});
			expect(rows).toHaveLength(5);
			// Every row carries the bound owner + the requested
			// case-type — pins that the generator's output flows
			// through `insert`'s tenant-scoping path.
			for (const row of rows) {
				expect(row.owner_id).toBe(OWNER_A);
				expect(row.case_type).toBe("patient");
			}
		});

		it("generateSampleData is deterministic per seed", async () => {
			// Two stores against separate owners so generated rows
			// land in distinct tenant scopes; both calls use the same
			// seed and the produced `properties` documents should
			// match by-row.
			const storeA = await options.factory(OWNER_A);
			const storeB = await options.factory(OWNER_B);
			const blueprint = buildBlueprint([PATIENT_CASE_TYPE]);
			await seedSchema(storeA, blueprint, "patient");
			await seedSchema(storeB, blueprint, "patient");

			await storeA.generateSampleData({
				appId: APP_ID,
				caseType: "patient",
				count: 3,
				seed: "deterministic",
				blueprint,
			});
			await storeB.generateSampleData({
				appId: APP_ID,
				caseType: "patient",
				count: 3,
				seed: "deterministic",
				blueprint,
			});

			// Sort by `properties.name` so the comparison is index-
			// independent. UUID v7 ordering would already align the
			// two runs, but pulling the rows back through `query`
			// without an explicit sort is implementation-leaky;
			// sorting here pins the contract.
			const rowsA = await storeA.query({
				appId: APP_ID,
				caseType: "patient",
			});
			const rowsB = await storeB.query({
				appId: APP_ID,
				caseType: "patient",
			});
			expect(rowsA).toHaveLength(3);
			expect(rowsB).toHaveLength(3);

			// Compare the deterministic part of each row: the
			// `properties` document. The generated `case_id`s differ
			// (UUID v7 reflects insert time) but the seeded payload
			// must be identical at every row index.
			const propsA = rowsA.map((r) => JSON.stringify(r.properties)).sort();
			const propsB = rowsB.map((r) => JSON.stringify(r.properties)).sort();
			expect(propsA).toEqual(propsB);
		});

		it("resetSampleData deletes existing rows and regenerates", async () => {
			const store = await options.factory(OWNER_A);
			const blueprint = buildBlueprint([PATIENT_CASE_TYPE]);
			await seedSchema(store, blueprint, "patient");

			// Seed an initial population.
			await store.generateSampleData({
				appId: APP_ID,
				caseType: "patient",
				count: 4,
				seed: "before-reset",
				blueprint,
			});
			const beforeRows = await store.query({
				appId: APP_ID,
				caseType: "patient",
			});
			expect(beforeRows).toHaveLength(4);
			const beforeIds = new Set(beforeRows.map((r) => r.case_id));

			// Reset to a smaller population — the deletion should
			// remove all four pre-existing rows; the regeneration
			// should leave exactly two.
			const result = await store.resetSampleData({
				appId: APP_ID,
				caseType: "patient",
				count: 2,
				blueprint,
			});
			expect(result.deleted).toBe(4);
			expect(result.inserted).toBe(2);

			const afterRows = await store.query({
				appId: APP_ID,
				caseType: "patient",
			});
			expect(afterRows).toHaveLength(2);
			// The reset's regeneration uses a fresh seed, so the new
			// rows' case_ids are distinct from the pre-reset rows.
			for (const row of afterRows) {
				expect(beforeIds.has(row.case_id)).toBe(false);
			}
		});

		// -----------------------------------------------------------
		// generateSampleData — parent-child linkage end-to-end
		// -----------------------------------------------------------

		it("generateSampleData populates case_indices for child case-types and traverse resolves parents", async () => {
			// End-to-end check: generated child rows pick parents
			// from already-populated parent rows; the case-store's
			// `insert` derives `case_indices` from `parent_case_id`;
			// `traverse` walks the index. The flow exercises every
			// seam from generator → insert → case_indices → traverse.
			const store = await options.factory(OWNER_A);
			const blueprint = buildBlueprint([
				PATIENT_WITH_PARENT_CASE_TYPE,
				HOUSEHOLD_CASE_TYPE,
			]);
			await seedSchema(store, blueprint, "household");
			await seedSchema(store, blueprint, "patient");

			// Populate parents first so the child generator can
			// resolve them via `parent_case_id`.
			await store.generateSampleData({
				appId: APP_ID,
				caseType: "household",
				count: 3,
				seed: "households",
				blueprint,
			});
			await store.generateSampleData({
				appId: APP_ID,
				caseType: "patient",
				count: 5,
				seed: "patients",
				blueprint,
			});

			// Every child row carries a non-null `parent_case_id`
			// pointing at one of the household rows.
			const households = await store.query({
				appId: APP_ID,
				caseType: "household",
			});
			const patients = await store.query({
				appId: APP_ID,
				caseType: "patient",
			});
			expect(households).toHaveLength(3);
			expect(patients).toHaveLength(5);
			const householdIds = new Set(households.map((h) => h.case_id));
			for (const patient of patients) {
				expect(patient.parent_case_id).not.toBeNull();
				if (patient.parent_case_id !== null) {
					expect(householdIds.has(patient.parent_case_id)).toBe(true);
				}
			}

			// `traverse` from a parent through `subcasePath("parent",
			// "patient")` resolves the children whose `case_indices`
			// row points back at it. Walking from every household and
			// summing the children should yield the full patient
			// population — the `case_indices` rows derive correctly
			// at insert time.
			let traversedTotal = 0;
			for (const household of households) {
				const children = await store.traverse({
					appId: APP_ID,
					caseId: household.case_id,
					via: subcasePath("parent", "patient"),
				});
				traversedTotal += children.length;
			}
			expect(traversedTotal).toBe(5);
		});
	});
}
