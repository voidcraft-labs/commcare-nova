// lib/case-store/__tests__/storeContract.ts
//
// Pure interface-compliance harness for `CaseStore`. The harness
// is a function that takes a factory `(tenant) => Promise<CaseStore>`
// plus a `describeContract` callback the caller invokes from inside
// a `describe(...)` block — the harness owns the test definitions
// and the caller owns the per-test database lifecycle.
//
// ## Why a harness, not a per-implementation test file
//
// `PostgresCaseStore` is the only implementation today, but the
// `CaseStore` interface is the architectural seam every consumer
// of case data binds against. Every method-level contract this
// harness exercises (predicate-filtered reads, JSONB merge on
// update, relation-path traversal, schema-sync atomicity, tenant
// isolation) is part of the architectural contract — the
// AST→Kysely compilers, the `(app_id, project_id)` tenant model
// (`owner_id` is a separate case-owner axis, never the tenant
// filter), the JSONB validator. A future implementation that diverges from
// this contract is a regression, not a feature; the harness pins
// the contract independently from any one implementation's source.
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
// The factory is async because production's `withProjectContext`
// resolves the singleton `Kysely<Database>` via Cloud SQL's
// connector; tests bypass `withProjectContext` and construct
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
import { asUuid, calculatedColumn } from "@/lib/domain";
import {
	ancestorPath,
	arith,
	gt,
	literal,
	prop,
	subcasePath,
	term,
	today,
} from "@/lib/domain/predicate/builders";
import {
	CaseNotFoundError,
	CasePropertiesValidationError,
	CaseTypeNotInBlueprintError,
	SchemaNotSyncedError,
} from "../errors";
import { buildCaseTypeMap, type CaseStore } from "../store";
import { buildSimpleBlueprint } from "./fixtures/simpleBlueprint";

// ---------------------------------------------------------------
// Public types
// ---------------------------------------------------------------

/**
 * A tenant binding for the contract factory: the Project the store
 * scopes reads/writes to (`projectId`), plus the actor stamped as each
 * new row's `owner_id` (`actorUserId` — the CommCare case-owner, a
 * separate axis from the Project tenant). The common single-member case
 * passes a matching pair; the Project-sharing tests vary them
 * independently.
 */
export interface ContractTenant {
	projectId: string;
	actorUserId: string;
}

/**
 * Configuration for a contract-test run.
 *
 * `factory` constructs a `CaseStore` bound to the supplied
 * {@link ContractTenant}. The harness invokes the factory once per test
 * (or several times in the isolation tests) — every call binds against
 * the same per-test database the caller's setup hook provisioned.
 *
 * `describeName` lets the caller name the describe block (e.g. the
 * concrete implementation under test). Defaults to a generic
 * label.
 */
export interface RunStoreContractOptions {
	/**
	 * Construct a `CaseStore` for the supplied tenant binding. The
	 * harness calls this inside test bodies — the caller must ensure the
	 * factory closes over the per-test database handle their setup
	 * hook provisions.
	 */
	factory: (tenant: ContractTenant) => Promise<CaseStore>;
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
const PROJECT_A = "project-a";
const PROJECT_B = "project-b";
const USER_A = "user-a";
const USER_B = "user-b";
// The common single-member binding: one user, scoped to their own Project.
const TENANT_A: ContractTenant = { projectId: PROJECT_A, actorUserId: USER_A };
const TENANT_B: ContractTenant = { projectId: PROJECT_B, actorUserId: USER_B };

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
 * needs, defaulting `appId` to the harness's shared `APP_ID`.
 * Wraps `buildSimpleBlueprint` so each test body reads as one
 * line (`buildBlueprint([CASE_TYPE])`) without re-stating the
 * suite's app id.
 */
function buildBlueprint(caseTypes: CaseType[]): BlueprintDoc {
	return buildSimpleBlueprint(caseTypes, APP_ID);
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
 *
 * The blueprint is converted to the schema-map shape the case-store
 * accepts — `applySchemaChange` resolves each method's narrow
 * dependency directly via `caseTypeSchemas` rather than threading
 * the full blueprint shape across the layer boundary.
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
		caseTypeSchemas: buildCaseTypeMap(blueprint),
	});
}

/**
 * Resolve one case-type definition by name from the supplied
 * blueprint. The sample-data methods now take a full `CaseType`
 * (not just the name) so the heuristic generator reads the property
 * list + `parent_type` from the same source the schema-sync path
 * does. This helper keeps every test body to a one-liner at the
 * call site.
 */
function findCaseTypeOrFail(
	blueprint: BlueprintDoc,
	caseType: string,
): CaseType {
	const def = buildCaseTypeMap(blueprint).get(caseType);
	if (def === undefined) {
		throw new Error(
			`fixture missing case type '${caseType}' in blueprint — test bug`,
		);
	}
	return def;
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

/**
 * Default `case_name` for a fixture insert. The column is
 * `text NOT NULL` with a `length > 0` CHECK constraint, so every
 * test insert has to carry a value; pinning the constant here
 * keeps the per-test row definitions one line shorter.
 */
const DEFAULT_CASE_NAME = "fixture-case-name";

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
			const store = await options.factory(TENANT_A);
			const blueprint = buildBlueprint([PATIENT_CASE_TYPE]);
			await seedSchema(store, blueprint, "patient");

			const inserted = await store.insert({
				appId: APP_ID,
				row: {
					case_id: PATIENT_ALICE_ID,
					case_type: "patient",
					case_name: DEFAULT_CASE_NAME,
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
			expect(row?.owner_id).toBe(USER_A);
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
			const store = await options.factory(TENANT_A);
			const blueprint = buildBlueprint([PATIENT_CASE_TYPE]);
			await seedSchema(store, blueprint, "patient");

			await store.insert({
				appId: APP_ID,
				row: {
					case_id: PATIENT_ALICE_ID,
					case_type: "patient",
					case_name: DEFAULT_CASE_NAME,
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
			const store = await options.factory(TENANT_A);
			const blueprint = buildBlueprint([PATIENT_CASE_TYPE]);
			await seedSchema(store, blueprint, "patient");

			await store.insert({
				appId: APP_ID,
				row: {
					case_id: PATIENT_ALICE_ID,
					case_type: "patient",
					case_name: DEFAULT_CASE_NAME,
					status: "open",
					properties: makeProperties({ name: "Alice", age: 25 }),
				},
			});
			await store.insert({
				appId: APP_ID,
				row: {
					case_id: PATIENT_BOB_ID,
					case_type: "patient",
					case_name: DEFAULT_CASE_NAME,
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
				caseTypeSchemas: buildCaseTypeMap(blueprint),
				predicate: gt(prop("patient", "age"), literal(30)),
			});
			expect(matched).toHaveLength(1);
			expect(matched[0]?.case_id).toBe(PATIENT_BOB_ID);
		});

		// -----------------------------------------------------------
		// update — JSONB merge + modified_on bump
		// -----------------------------------------------------------

		it("merges patches into JSONB properties and bumps modified_on", async () => {
			const store = await options.factory(TENANT_A);
			const blueprint = buildBlueprint([PATIENT_CASE_TYPE]);
			await seedSchema(store, blueprint, "patient");

			await store.insert({
				appId: APP_ID,
				row: {
					case_id: PATIENT_ALICE_ID,
					case_type: "patient",
					case_name: DEFAULT_CASE_NAME,
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

		it("close owns the canonical closed lifecycle status without deleting the row", async () => {
			const store = await options.factory(TENANT_A);
			const blueprint = buildBlueprint([PATIENT_CASE_TYPE]);
			await seedSchema(store, blueprint, "patient");

			await store.insert({
				appId: APP_ID,
				row: {
					case_id: PATIENT_ALICE_ID,
					case_type: "patient",
					case_name: DEFAULT_CASE_NAME,
					status: "open",
					properties: makeProperties({ name: "Alice", age: 25 }),
				},
			});
			await store.close({
				appId: APP_ID,
				caseId: PATIENT_ALICE_ID,
			});

			const rows = await store.query({
				appId: APP_ID,
				caseType: "patient",
			});
			// Row still present (close is not delete), while one storage
			// operation owns both halves of the lifecycle transition. No
			// caller-provided status is needed (or accepted), so the preview
			// path cannot accidentally leave an `open` @status behind.
			expect(rows).toHaveLength(1);
			expect(rows[0]?.closed_on).not.toBeNull();
			expect(rows[0]?.status).toBe("closed");
		});

		it("an explicit recovery update can reopen a closed case", async () => {
			const store = await options.factory(TENANT_A);
			const blueprint = buildBlueprint([PATIENT_CASE_TYPE]);
			await seedSchema(store, blueprint, "patient");

			await store.insert({
				appId: APP_ID,
				row: {
					case_id: PATIENT_ALICE_ID,
					case_type: "patient",
					case_name: DEFAULT_CASE_NAME,
					status: "open",
					properties: makeProperties({ name: "Alice", age: 25 }),
				},
			});
			await store.close({ appId: APP_ID, caseId: PATIENT_ALICE_ID });

			// Reopening is deliberately explicit rather than an option on
			// `close`: import/recovery code writes the paired lifecycle
			// fields it means to restore.
			await store.update({
				appId: APP_ID,
				caseId: PATIENT_ALICE_ID,
				patch: { status: "open", closed_on: null },
			});

			const rows = await store.query({
				appId: APP_ID,
				caseType: "patient",
			});
			expect(rows).toHaveLength(1);
			expect(rows[0]?.closed_on).toBeNull();
			expect(rows[0]?.status).toBe("open");
		});

		it("re-closing repairs a legacy closed row whose status was left open", async () => {
			const store = await options.factory(TENANT_A);
			const blueprint = buildBlueprint([PATIENT_CASE_TYPE]);
			await seedSchema(store, blueprint, "patient");
			const originalClosedOn = new Date("2026-04-03T10:30:00.000Z");
			const originalModifiedOn = new Date("2026-04-03T10:30:00.000Z");

			// This is the exact row shape the former preview close path left:
			// it stamped `closed_on` but passed no status into the optional
			// store slot, so the registration-time `open` value survived.
			await store.insert({
				appId: APP_ID,
				row: {
					case_id: PATIENT_ALICE_ID,
					case_type: "patient",
					case_name: DEFAULT_CASE_NAME,
					status: "open",
					closed_on: originalClosedOn,
					modified_on: originalModifiedOn,
					properties: makeProperties({ name: "Alice", age: 25 }),
				},
			});

			await store.close({ appId: APP_ID, caseId: PATIENT_ALICE_ID });

			const rows = await store.query({
				appId: APP_ID,
				caseType: "patient",
			});
			expect(rows).toHaveLength(1);
			expect(rows[0]?.status).toBe("closed");
			// Repair completes the original lifecycle write; it must not
			// manufacture a new close event or advance its modification time.
			expect(rows[0]?.closed_on).toEqual(originalClosedOn);
			expect(rows[0]?.modified_on).toEqual(originalModifiedOn);
		});

		it("close is idempotent on row state — re-closing preserves the original closed_on timestamp", async () => {
			// A consistent closed row matches neither close-write arm:
			// `closed_on` is present and status is already `closed`. The
			// original closure timestamp + the `modified_on` from that first
			// close therefore stay intact under repeated calls. Pins the
			// idempotent-on-row-state contract: a duplicate close from a
			// retry path or re-issued submission doesn't advance either
			// timestamp, while the sibling legacy-row test proves a stale
			// status still gets repaired.
			const store = await options.factory(TENANT_A);
			const blueprint = buildBlueprint([PATIENT_CASE_TYPE]);
			await seedSchema(store, blueprint, "patient");

			await store.insert({
				appId: APP_ID,
				row: {
					case_id: PATIENT_ALICE_ID,
					case_type: "patient",
					case_name: DEFAULT_CASE_NAME,
					status: "open",
					properties: makeProperties({ name: "Alice", age: 25 }),
				},
			});

			// First close stamps `closed_on` + `modified_on` to the
			// same `now()`.
			await store.close({
				appId: APP_ID,
				caseId: PATIENT_ALICE_ID,
			});
			const afterFirst = await store.query({
				appId: APP_ID,
				caseType: "patient",
			});
			const firstClosedOn = afterFirst[0]?.closed_on;
			const firstModifiedOn = afterFirst[0]?.modified_on;
			expect(firstClosedOn).not.toBeNull();
			expect(firstModifiedOn).not.toBeNull();

			// Sleep a small amount so a re-stamp would land at a
			// distinguishable timestamp. Postgres `now()` returns
			// microsecond-resolution timestamptz; even a sub-ms gap
			// between the two close calls would yield a different
			// value if the second UPDATE actually fired.
			await new Promise((resolve) => setTimeout(resolve, 10));

			// Second close on the same consistent case is a no-op. Both
			// lifecycle predicates filter it out, preserving the timestamps.
			await store.close({
				appId: APP_ID,
				caseId: PATIENT_ALICE_ID,
			});
			const afterSecond = await store.query({
				appId: APP_ID,
				caseType: "patient",
			});
			expect(afterSecond[0]?.closed_on).toEqual(firstClosedOn);
			expect(afterSecond[0]?.modified_on).toEqual(firstModifiedOn);
		});

		// -----------------------------------------------------------
		// insertWithChildren — atomic registration shape
		// -----------------------------------------------------------

		it("insertWithChildren materializes the primary + every child + their case_indices edges atomically", async () => {
			const store = await options.factory(TENANT_A);
			const blueprint = buildBlueprint([
				HOUSEHOLD_CASE_TYPE,
				PATIENT_WITH_PARENT_CASE_TYPE,
			]);
			await seedSchema(store, blueprint, "household");
			await seedSchema(store, blueprint, "patient");

			// Primary household + two children patients. Children
			// must NOT carry an explicit `parent_case_id` — the
			// case-store threads the primary's generated id.
			const result = await store.insertWithChildren({
				appId: APP_ID,
				primary: {
					case_type: "household",
					case_name: "North household",
					status: "open",
					properties: makeProperties({ region: "North" }),
				},
				children: [
					{
						case_type: "patient",
						case_name: "Alice",
						status: "open",
						properties: makeProperties({ name: "Alice", age: 30 }),
					},
					{
						case_type: "patient",
						case_name: "Bob",
						status: "open",
						properties: makeProperties({ name: "Bob", age: 40 }),
					},
				],
			});
			expect(result.primaryCaseId).toBeDefined();
			expect(result.childCaseIds).toHaveLength(2);

			// Primary row landed.
			const households = await store.query({
				appId: APP_ID,
				caseType: "household",
			});
			expect(households).toHaveLength(1);
			expect(households[0]?.case_id).toBe(result.primaryCaseId);

			// Children landed and carry the primary's id as their
			// `parent_case_id` — the implicit threading the
			// `insertWithChildren` contract pins.
			const patients = await store.query({
				appId: APP_ID,
				caseType: "patient",
			});
			expect(patients).toHaveLength(2);
			for (const patient of patients) {
				expect(patient.parent_case_id).toBe(result.primaryCaseId);
			}

			// `traverse` reaches every child from the primary via
			// `case_indices` — pins that the derived edges
			// materialized inside the same transaction.
			const subcases = await store.traverse({
				appId: APP_ID,
				caseId: result.primaryCaseId,
				via: subcasePath("parent", "patient"),
			});
			expect(subcases).toHaveLength(2);
			const reachedIds = new Set(subcases.map((c) => c.case_id));
			for (const childId of result.childCaseIds) {
				expect(reachedIds.has(childId)).toBe(true);
			}
		});

		it("insertWithChildren rolls back the whole batch if any child's payload fails JSON Schema validation", async () => {
			// Atomicity contract: a validation failure on any child
			// rolls back the primary too. Zero rows visible after
			// the throw, regardless of which row failed.
			const store = await options.factory(TENANT_A);
			const blueprint = buildBlueprint([
				HOUSEHOLD_CASE_TYPE,
				PATIENT_WITH_PARENT_CASE_TYPE,
			]);
			await seedSchema(store, blueprint, "household");
			await seedSchema(store, blueprint, "patient");

			await expect(
				store.insertWithChildren({
					appId: APP_ID,
					primary: {
						case_type: "household",
						case_name: "North household",
						status: "open",
						properties: makeProperties({ region: "North" }),
					},
					children: [
						{
							case_type: "patient",
							case_name: "Alice",
							status: "open",
							// Schema declares `age` as int; the string
							// "not-a-number" fails AJV's integer check.
							properties: makeProperties({
								name: "Alice",
								age: "not-a-number",
							}),
						},
					],
				}),
			).rejects.toThrow();

			// Primary's case-type is empty after rollback — the
			// transaction undid the household insert too.
			const households = await store.query({
				appId: APP_ID,
				caseType: "household",
			});
			expect(households).toHaveLength(0);
			// Children's case-type is empty too.
			const patients = await store.query({
				appId: APP_ID,
				caseType: "patient",
			});
			expect(patients).toHaveLength(0);
		});

		it("insertWithChildren handles mixed child case types and preserves input order in the returned id list", async () => {
			// The implementation chunks children by `case_type`
			// (so the bulk-insert path's hoisted-validator
			// optimization fetches one validator per chunk) and
			// reassembles the returned ids back to the caller's
			// original input order. Pin both the multi-type schema-
			// fetch contract AND the index-preserving reassembly.
			const VISIT_CASE_TYPE: CaseType = {
				name: "visit",
				parent_type: "household",
				properties: [{ name: "outcome", label: "Outcome", data_type: "text" }],
			};
			const store = await options.factory(TENANT_A);
			const blueprint = buildBlueprint([
				HOUSEHOLD_CASE_TYPE,
				PATIENT_WITH_PARENT_CASE_TYPE,
				VISIT_CASE_TYPE,
			]);
			await seedSchema(store, blueprint, "household");
			await seedSchema(store, blueprint, "patient");
			await seedSchema(store, blueprint, "visit");

			// Children alternate between two case types so the
			// chunking logic produces multiple chunks AND the
			// reassembly has to interleave ids back into the original
			// order. With three slots — patient, visit, patient — the
			// chunks-by-type produce two patients in chunk A + one
			// visit in chunk B; the reassembly must place the patient
			// from chunk A index 1 at the caller's index 2, NOT 1.
			const result = await store.insertWithChildren({
				appId: APP_ID,
				primary: {
					case_type: "household",
					case_name: "North household",
					status: "open",
					properties: makeProperties({ region: "North" }),
				},
				children: [
					{
						case_type: "patient",
						case_name: "Alice",
						status: "open",
						properties: makeProperties({ name: "Alice", age: 30 }),
					},
					{
						case_type: "visit",
						case_name: "First visit",
						status: "open",
						properties: makeProperties({ outcome: "complete" }),
					},
					{
						case_type: "patient",
						case_name: "Bob",
						status: "open",
						properties: makeProperties({ name: "Bob", age: 40 }),
					},
				],
			});
			expect(result.childCaseIds).toHaveLength(3);

			// All three rows materialize: 1 household, 2 patients,
			// 1 visit, all under the same primary id.
			const patients = await store.query({
				appId: APP_ID,
				caseType: "patient",
			});
			expect(patients).toHaveLength(2);
			const visits = await store.query({
				appId: APP_ID,
				caseType: "visit",
			});
			expect(visits).toHaveLength(1);

			// Index-preserving reassembly: position 0 in the returned
			// list refers to the FIRST input row (Alice the patient);
			// position 1 to the visit; position 2 to Bob the patient.
			// Look up each row by its returned id and verify the
			// case-type lines up with the input.
			const aliceId = result.childCaseIds[0];
			const visitId = result.childCaseIds[1];
			const bobId = result.childCaseIds[2];
			expect(aliceId).toBeDefined();
			expect(visitId).toBeDefined();
			expect(bobId).toBeDefined();

			const aliceRow = patients.find((p) => p.case_id === aliceId);
			const bobRow = patients.find((p) => p.case_id === bobId);
			const visitRow = visits.find((v) => v.case_id === visitId);
			expect(aliceRow).toBeDefined();
			expect(bobRow).toBeDefined();
			expect(visitRow).toBeDefined();
			expect(aliceRow?.case_name).toBe("Alice");
			expect(bobRow?.case_name).toBe("Bob");
			expect(visitRow?.case_name).toBe("First visit");

			// Every child carries the primary's id as its
			// `parent_case_id`, regardless of which chunk it shipped
			// in.
			for (const child of [...patients, ...visits]) {
				expect(child.parent_case_id).toBe(result.primaryCaseId);
			}
		});

		it("insertWithChildren behaves like insert when children is empty", async () => {
			// The empty-children arm short-circuits the bulk path
			// and lands just the primary inside one transaction.
			const store = await options.factory(TENANT_A);
			const blueprint = buildBlueprint([PATIENT_CASE_TYPE]);
			await seedSchema(store, blueprint, "patient");

			const result = await store.insertWithChildren({
				appId: APP_ID,
				primary: {
					case_type: "patient",
					case_name: "Solo",
					status: "open",
					properties: makeProperties({ name: "Solo", age: 50 }),
				},
				children: [],
			});
			expect(result.primaryCaseId).toBeDefined();
			expect(result.childCaseIds).toHaveLength(0);

			const rows = await store.query({
				appId: APP_ID,
				caseType: "patient",
			});
			expect(rows).toHaveLength(1);
			expect(rows[0]?.case_id).toBe(result.primaryCaseId);
		});

		// -----------------------------------------------------------
		// traverse — relation-path walk
		// -----------------------------------------------------------

		it("traverse walks subcase relations via case_indices", async () => {
			const store = await options.factory(TENANT_A);
			const blueprint = buildBlueprint([
				PATIENT_WITH_PARENT_CASE_TYPE,
				HOUSEHOLD_CASE_TYPE,
			]);
			await seedSchema(store, blueprint, "patient");
			await seedSchema(store, blueprint, "household");

			// Distinct `case_name` per row so the post-traverse
			// assertion catches a "leaf projection drops the column"
			// regression: if the SELECT list omits `case_name`, every
			// returned row carries `undefined` regardless of which row
			// the walk reaches, and a single-name fixture would pass
			// even on the broken path. Different strings per row pin
			// the contract that traverse returns the LEAF's column,
			// not a default or the anchor's.
			const HOUSEHOLD_NAME = "North household";
			const CHILD_NAME = "Child patient";

			// Parent household.
			await store.insert({
				appId: APP_ID,
				row: {
					case_id: HOUSEHOLD_ID,
					case_type: "household",
					case_name: HOUSEHOLD_NAME,
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
					case_name: CHILD_NAME,
					status: "open",
					parent_case_id: HOUSEHOLD_ID,
					properties: makeProperties({ name: "Child", age: 5 }),
				},
			});

			// From the household, walk one hop down via the `parent`
			// identifier — the child patient is the leaf. The leaf row
			// must carry the full `cases` column projection, including
			// `case_name`, so column-display reads from a traverse
			// result match the column-display reads from a direct
			// `query` against the same row.
			const subcases = await store.traverse({
				appId: APP_ID,
				caseId: HOUSEHOLD_ID,
				via: subcasePath("parent", "patient"),
			});
			expect(subcases).toHaveLength(1);
			expect(subcases[0]?.case_id).toBe(CHILD_PATIENT_ID);
			expect(subcases[0]?.case_name).toBe(CHILD_NAME);

			// From the patient, walk one hop up via the same
			// identifier — the household is the ancestor. Same column-
			// projection contract on the ancestor branch.
			const ancestors = await store.traverse({
				appId: APP_ID,
				caseId: CHILD_PATIENT_ID,
				via: ancestorPath({ identifier: "parent" }),
			});
			expect(ancestors).toHaveLength(1);
			expect(ancestors[0]?.case_id).toBe(HOUSEHOLD_ID);
			expect(ancestors[0]?.case_name).toBe(HOUSEHOLD_NAME);
		});

		// -----------------------------------------------------------
		// applySchemaChange — additive (no `change`)
		// -----------------------------------------------------------

		it("applySchemaChange (additive) upserts the JSON Schema row", async () => {
			const store = await options.factory(TENANT_A);
			const blueprint = buildBlueprint([PATIENT_CASE_TYPE]);
			const report = await store.applySchemaChange({
				appId: APP_ID,
				caseType: "patient",
				caseTypeSchemas: buildCaseTypeMap(blueprint),
			});
			// Additive path: zero rows touched, zero quarantined.
			expect(report).toEqual({
				migrated: 0,
				reshaped: 0,
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
				caseTypeSchemas: buildCaseTypeMap(extendedBlueprint),
			});
			expect(second.migrated).toBe(0);
		});

		// -----------------------------------------------------------
		// applySchemaChange — rename
		// -----------------------------------------------------------

		it("applySchemaChange (rename) atomically renames a property in every row", async () => {
			const store = await options.factory(TENANT_A);
			const initialBlueprint = buildBlueprint([PATIENT_CASE_TYPE]);
			await seedSchema(store, initialBlueprint, "patient");

			await store.insert({
				appId: APP_ID,
				row: {
					case_id: PATIENT_ALICE_ID,
					case_type: "patient",
					case_name: DEFAULT_CASE_NAME,
					status: "open",
					properties: makeProperties({ name: "Alice", age: 25 }),
				},
			});
			await store.insert({
				appId: APP_ID,
				row: {
					case_id: PATIENT_BOB_ID,
					case_type: "patient",
					case_name: DEFAULT_CASE_NAME,
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
					case_name: DEFAULT_CASE_NAME,
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
				caseTypeSchemas: buildCaseTypeMap(renamedBlueprint),
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

			// Re-running the same rename is a no-op — no row still
			// carries the old key.
			const rerun = await store.applySchemaChange({
				appId: APP_ID,
				caseType: "patient",
				caseTypeSchemas: buildCaseTypeMap(renamedBlueprint),
				property: "years",
				change: { kind: "rename", from: "age", to: "years" },
			});
			expect(rerun.migrated).toBe(0);
			expect(rerun.quarantined).toBe(0);
		});

		it("applySchemaChange (rename) merging onto an existing declaration keeps destination values and casts moved ones", async () => {
			// A MERGE-rename: the destination name was already declared,
			// so the surviving declaration (here `years: int`) can differ
			// from the source's. Three behaviors under one migration:
			// a destination value wins its conflict, a from-only value
			// casts into the destination type, and an uncastable value
			// quarantines its row.
			const store = await options.factory(TENANT_A);
			const mergedFrom: CaseType = {
				name: "patient",
				properties: [
					{ name: "age", label: "Age", data_type: "text" },
					{ name: "years", label: "Years", data_type: "int" },
				],
			};
			await seedSchema(store, buildBlueprint([mergedFrom]), "patient");

			// From-only, castable — moves and casts "30" → 30.
			await store.insert({
				appId: APP_ID,
				row: {
					case_id: PATIENT_ALICE_ID,
					case_type: "patient",
					case_name: DEFAULT_CASE_NAME,
					status: "open",
					properties: makeProperties({ age: "30" }),
				},
			});
			// Conflict — the destination's already-valid value wins and
			// the old key drops.
			await store.insert({
				appId: APP_ID,
				row: {
					case_id: PATIENT_BOB_ID,
					case_type: "patient",
					case_name: DEFAULT_CASE_NAME,
					status: "open",
					properties: makeProperties({ age: "99", years: 1 }),
				},
			});
			// From-only, uncastable under the surviving `int` — the row
			// moves to quarantine with the original value.
			await store.insert({
				appId: APP_ID,
				row: {
					case_id: PATIENT_CAROL_ID,
					case_type: "patient",
					case_name: DEFAULT_CASE_NAME,
					status: "open",
					properties: makeProperties({ age: "abc" }),
				},
			});

			const mergedCaseType: CaseType = {
				name: "patient",
				properties: [{ name: "years", label: "Years", data_type: "int" }],
			};
			const report = await store.applySchemaChange({
				appId: APP_ID,
				caseType: "patient",
				caseTypeSchemas: buildCaseTypeMap(buildBlueprint([mergedCaseType])),
				property: "years",
				change: { kind: "rename", from: "age", to: "years" },
			});
			expect(report.migrated).toBe(2);
			expect(report.quarantined).toBe(1);
			expect(report.skipped).toBe(0);
			expect(report.failureReasons).toHaveLength(1);
			expect(report.failureReasons[0]).toContain("age");
			expect(report.failureReasons[0]).toContain("years");
			expect(report.failureReasons[0]).toContain("int");

			const rows = await store.query({ appId: APP_ID, caseType: "patient" });
			const byId = new Map(rows.map((r) => [r.case_id, r]));
			expect(rows).toHaveLength(2);
			expect(byId.get(PATIENT_ALICE_ID)?.properties).toEqual({ years: 30 });
			expect(byId.get(PATIENT_BOB_ID)?.properties).toEqual({ years: 1 });
		});

		// -----------------------------------------------------------
		// update — merged-write strip of undeclared inherited keys
		// -----------------------------------------------------------

		it("update() sheds inherited keys the schema no longer declares, while patch keys stay strict", async () => {
			// A row stranded by a pre-migration rename/removal holds a
			// key the current schema does not declare. Its next
			// properties write sheds the orphaned key instead of failing
			// `additionalProperties` forever — but an unknown key in the
			// caller's PATCH is still a validation error.
			const store = await options.factory(TENANT_A);
			const withAge: CaseType = {
				name: "patient",
				properties: [
					{ name: "name", label: "Name", data_type: "text" },
					{ name: "age", label: "Age", data_type: "text" },
				],
			};
			await seedSchema(store, buildBlueprint([withAge]), "patient");
			await store.insert({
				appId: APP_ID,
				row: {
					case_id: PATIENT_ALICE_ID,
					case_type: "patient",
					case_name: DEFAULT_CASE_NAME,
					status: "open",
					properties: makeProperties({ name: "Alice", age: "30" }),
				},
			});

			// The schema regenerates WITHOUT `age` (an additive sync — the
			// legacy stranding shape: no rename migration ran).
			const withoutAge: CaseType = {
				name: "patient",
				properties: [{ name: "name", label: "Name", data_type: "text" }],
			};
			await store.applySchemaChange({
				appId: APP_ID,
				caseType: "patient",
				caseTypeSchemas: buildCaseTypeMap(buildBlueprint([withoutAge])),
			});

			// The write succeeds and sheds the orphaned `age`.
			await store.update({
				appId: APP_ID,
				caseId: PATIENT_ALICE_ID,
				patch: { properties: makeProperties({ name: "Alicia" }) },
			});
			const rows = await store.query({ appId: APP_ID, caseType: "patient" });
			expect(rows[0]?.properties).toEqual({ name: "Alicia" });

			// A patch key the schema doesn't declare still rejects.
			await expect(
				store.update({
					appId: APP_ID,
					caseId: PATIENT_ALICE_ID,
					patch: { properties: makeProperties({ bogus: "x" }) },
				}),
			).rejects.toBeInstanceOf(CasePropertiesValidationError);
		});

		// -----------------------------------------------------------
		// applySchemaChange — retype
		// -----------------------------------------------------------

		it("applySchemaChange (retype) quarantines rows that fail the cast", async () => {
			const store = await options.factory(TENANT_A);
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
					case_name: DEFAULT_CASE_NAME,
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
					case_name: DEFAULT_CASE_NAME,
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
				caseTypeSchemas: buildCaseTypeMap(retypedBlueprint),
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
		// applySchemaChange — string↔array shape reshape (detection)
		// -----------------------------------------------------------
		//
		// A select single↔multi conversion reaches the store as a plain
		// ADDITIVE sync (no `change` hint on any live surface), yet the
		// regenerated schema flips the property between scalar string
		// and array. Every winning sync therefore diffs the stored
		// schema against the derived one and rewrites old-shape rows in
		// the same transaction — without it, every pre-conversion row
		// would fail the merged-document validation on its next write
		// of ANY property.

		it("applySchemaChange (additive) lifts scalar rows when a property flips single→multi select", async () => {
			const store = await options.factory(TENANT_A);
			const singleCaseType: CaseType = {
				name: "patient",
				properties: [
					{ name: "language", label: "Language", data_type: "single_select" },
					{ name: "note", label: "Note", data_type: "text" },
				],
			};
			await seedSchema(store, buildBlueprint([singleCaseType]), "patient");

			await store.insert({
				appId: APP_ID,
				row: {
					case_id: PATIENT_ALICE_ID,
					case_type: "patient",
					case_name: DEFAULT_CASE_NAME,
					status: "open",
					properties: makeProperties({ language: "en", note: "hi" }),
				},
			});
			// A row without the flipped property — untouched, not counted.
			await store.insert({
				appId: APP_ID,
				row: {
					case_id: PATIENT_BOB_ID,
					case_type: "patient",
					case_name: DEFAULT_CASE_NAME,
					status: "open",
					properties: makeProperties({ note: "yo" }),
				},
			});

			const multiCaseType: CaseType = {
				name: "patient",
				properties: [
					{ name: "language", label: "Language", data_type: "multi_select" },
					{ name: "note", label: "Note", data_type: "text" },
				],
			};
			const report = await store.applySchemaChange({
				appId: APP_ID,
				caseType: "patient",
				caseTypeSchemas: buildCaseTypeMap(buildBlueprint([multiCaseType])),
			});
			expect(report.reshaped).toBe(1);
			expect(report.migrated).toBe(0);
			expect(report.quarantined).toBe(0);

			const rows = await store.query({ appId: APP_ID, caseType: "patient" });
			const byId = new Map(rows.map((r) => [r.case_id, r]));
			expect(byId.get(PATIENT_ALICE_ID)?.properties).toEqual({
				language: ["en"],
				note: "hi",
			});
			expect(byId.get(PATIENT_BOB_ID)?.properties).toEqual({ note: "yo" });

			// The acceptance behavior: the pre-conversion row stays
			// writable — an update of an UNRELATED property revalidates
			// the whole merged document against the array-typed schema.
			await store.update({
				appId: APP_ID,
				caseId: PATIENT_ALICE_ID,
				patch: { properties: makeProperties({ note: "updated" }) },
			});
			const after = await store.query({ appId: APP_ID, caseType: "patient" });
			expect(
				after.find((r) => r.case_id === PATIENT_ALICE_ID)?.properties,
			).toEqual({ language: ["en"], note: "updated" });

			// Re-running the same sync detects no remaining flip — the
			// reshape is idempotent and conforming rows are never
			// rewritten.
			const again = await store.applySchemaChange({
				appId: APP_ID,
				caseType: "patient",
				caseTypeSchemas: buildCaseTypeMap(buildBlueprint([multiCaseType])),
			});
			expect(again.reshaped).toBe(0);
		});

		it("applySchemaChange (additive) space-joins array rows when a property flips multi→single select", async () => {
			const store = await options.factory(TENANT_A);
			const multiCaseType: CaseType = {
				name: "patient",
				properties: [
					{ name: "languages", label: "Languages", data_type: "multi_select" },
				],
			};
			await seedSchema(store, buildBlueprint([multiCaseType]), "patient");

			await store.insert({
				appId: APP_ID,
				row: {
					case_id: PATIENT_ALICE_ID,
					case_type: "patient",
					case_name: DEFAULT_CASE_NAME,
					status: "open",
					properties: makeProperties({ languages: ["en", "fr"] }),
				},
			});

			const singleCaseType: CaseType = {
				name: "patient",
				properties: [
					{
						name: "languages",
						label: "Languages",
						data_type: "single_select",
					},
				],
			};
			const report = await store.applySchemaChange({
				appId: APP_ID,
				caseType: "patient",
				caseTypeSchemas: buildCaseTypeMap(buildBlueprint([singleCaseType])),
			});
			expect(report.reshaped).toBe(1);

			// The XForms multi-value convention: space-joined.
			const rows = await store.query({ appId: APP_ID, caseType: "patient" });
			expect(rows[0]?.properties).toEqual({ languages: "en fr" });

			await store.update({
				appId: APP_ID,
				caseId: PATIENT_ALICE_ID,
				patch: { properties: makeProperties({ languages: "en" }) },
			});
			const after = await store.query({ appId: APP_ID, caseType: "patient" });
			expect(after[0]?.properties).toEqual({ languages: "en" });
		});

		it("a stale-seq sync neither rewrites the schema nor reshapes rows", async () => {
			const store = await options.factory(TENANT_A);
			const singleCaseType: CaseType = {
				name: "patient",
				properties: [
					{ name: "language", label: "Language", data_type: "single_select" },
				],
			};
			await store.applySchemaChange({
				appId: APP_ID,
				caseType: "patient",
				caseTypeSchemas: buildCaseTypeMap(buildBlueprint([singleCaseType])),
				syncedSeq: 5,
			});
			await store.insert({
				appId: APP_ID,
				row: {
					case_id: PATIENT_ALICE_ID,
					case_type: "patient",
					case_name: DEFAULT_CASE_NAME,
					status: "open",
					properties: makeProperties({ language: "en" }),
				},
			});

			const multiCaseType: CaseType = {
				name: "patient",
				properties: [
					{ name: "language", label: "Language", data_type: "multi_select" },
				],
			};
			const report = await store.applySchemaChange({
				appId: APP_ID,
				caseType: "patient",
				caseTypeSchemas: buildCaseTypeMap(buildBlueprint([multiCaseType])),
				syncedSeq: 3,
			});
			expect(report.reshaped).toBe(0);

			// The coarse gate no-opped the WHOLE call: the row keeps its
			// scalar, and the stored schema still validates scalars — a
			// fresh scalar write passes.
			const rows = await store.query({ appId: APP_ID, caseType: "patient" });
			expect(rows[0]?.properties).toEqual({ language: "en" });
			await store.update({
				appId: APP_ID,
				caseId: PATIENT_ALICE_ID,
				patch: { properties: makeProperties({ language: "fr" }) },
			});
		});

		it("an array→format-string flip is NOT auto-reshaped (failable rewrite)", async () => {
			const store = await options.factory(TENANT_A);
			const multiCaseType: CaseType = {
				name: "patient",
				properties: [
					{ name: "visits", label: "Visits", data_type: "multi_select" },
				],
			};
			await seedSchema(store, buildBlueprint([multiCaseType]), "patient");
			await store.insert({
				appId: APP_ID,
				row: {
					case_id: PATIENT_ALICE_ID,
					case_type: "patient",
					case_name: DEFAULT_CASE_NAME,
					status: "open",
					properties: makeProperties({ visits: ["2026-01-01", "2026-02-01"] }),
				},
			});

			// The derived target is a `format: "date"` string — the joined
			// value could fail the constraint, so the reshape deliberately
			// leaves the rows alone (quarantine policy is the
			// derived-type-flip reconciliation feature's decision).
			const dateCaseType: CaseType = {
				name: "patient",
				properties: [{ name: "visits", label: "Visits", data_type: "date" }],
			};
			const report = await store.applySchemaChange({
				appId: APP_ID,
				caseType: "patient",
				caseTypeSchemas: buildCaseTypeMap(buildBlueprint([dateCaseType])),
			});
			expect(report.reshaped).toBe(0);
			const rows = await store.query({ appId: APP_ID, caseType: "patient" });
			expect(rows[0]?.properties).toEqual({
				visits: ["2026-01-01", "2026-02-01"],
			});
		});

		it("an int→array flip is NOT reshaped — and the sync survives the live ::integer index", async () => {
			const store = await options.factory(TENANT_A);
			const intCaseType: CaseType = {
				name: "patient",
				properties: [{ name: "age", label: "Age", data_type: "int" }],
			};
			// Phase B of this sync builds the btree expression index on
			// ((properties->>'age')::integer).
			await seedSchema(store, buildBlueprint([intCaseType]), "patient");
			await store.insert({
				appId: APP_ID,
				row: {
					case_id: PATIENT_ALICE_ID,
					case_type: "patient",
					case_name: DEFAULT_CASE_NAME,
					status: "open",
					properties: makeProperties({ age: 30 }),
				},
			});

			// The lift arm is scoped to stored STRING schemas: rewriting
			// this row to ["30"] inside Phase A would be indexed through
			// the still-live ::integer cast and abort the whole sync
			// (Phase B reconciles indexes only after Phase A commits). The
			// narrowed detection leaves the rows alone, so the sync itself
			// must succeed.
			const multiCaseType: CaseType = {
				name: "patient",
				properties: [{ name: "age", label: "Age", data_type: "multi_select" }],
			};
			const report = await store.applySchemaChange({
				appId: APP_ID,
				caseType: "patient",
				caseTypeSchemas: buildCaseTypeMap(buildBlueprint([multiCaseType])),
			});
			expect(report.reshaped).toBe(0);
			const rows = await store.query({ appId: APP_ID, caseType: "patient" });
			expect(rows[0]?.properties).toEqual({ age: 30 });
		});

		it("a caller-intent retype of the flipped property is not double-counted by detection", async () => {
			const store = await options.factory(TENANT_A);
			const singleCaseType: CaseType = {
				name: "patient",
				properties: [
					{ name: "language", label: "Language", data_type: "single_select" },
				],
			};
			await seedSchema(store, buildBlueprint([singleCaseType]), "patient");
			await store.insert({
				appId: APP_ID,
				row: {
					case_id: PATIENT_ALICE_ID,
					case_type: "patient",
					case_name: DEFAULT_CASE_NAME,
					status: "open",
					properties: makeProperties({ language: "en" }),
				},
			});

			// The drift-script path passes an explicit retype for the same
			// transition detection would report; the property is excluded
			// from detection so the row is rewritten (and counted) once.
			const multiCaseType: CaseType = {
				name: "patient",
				properties: [
					{ name: "language", label: "Language", data_type: "multi_select" },
				],
			};
			const report = await store.applySchemaChange({
				appId: APP_ID,
				caseType: "patient",
				caseTypeSchemas: buildCaseTypeMap(buildBlueprint([multiCaseType])),
				property: "language",
				change: {
					kind: "retype",
					fromType: "single_select",
					toType: "multi_select",
				},
			});
			expect(report.migrated).toBe(1);
			expect(report.reshaped).toBe(0);
			const rows = await store.query({ appId: APP_ID, caseType: "patient" });
			expect(rows[0]?.properties).toEqual({ language: ["en"] });
		});

		// -----------------------------------------------------------
		// applySchemaChange — narrow-options
		// -----------------------------------------------------------

		it("applySchemaChange (narrow-options) quarantines rows with removed values", async () => {
			const store = await options.factory(TENANT_A);
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
					case_name: DEFAULT_CASE_NAME,
					status: "open",
					properties: makeProperties({ color: "red" }),
				},
			});
			await store.insert({
				appId: APP_ID,
				row: {
					case_id: PATIENT_BOB_ID,
					case_type: "patient",
					case_name: DEFAULT_CASE_NAME,
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
				caseTypeSchemas: buildCaseTypeMap(narrowedBlueprint),
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
		// applySchemaChange — missing case type in the schema map
		// -----------------------------------------------------------

		it("applySchemaChange throws CaseTypeNotInBlueprintError when the schema map omits the requested case type", async () => {
			// Pin the throw-site contract: the case-store resolves the
			// case-type definition exclusively from the supplied
			// `caseTypeSchemas` map. An empty map (or one whose entries
			// don't carry the requested name) trips the typed
			// `CaseTypeNotInBlueprintError` so Server Actions can map to
			// `missing-case-type` and re-resolve against fresh state.
			// Mirrors the surrounding `SchemaNotSyncedError` rejection
			// shape — the cross-module instanceof check is what the
			// `readonly name` field initializer defends against under
			// minified bundles.
			const store = await options.factory(TENANT_A);
			await expect(
				store.applySchemaChange({
					appId: APP_ID,
					caseType: "patient",
					caseTypeSchemas: new Map(),
				}),
			).rejects.toBeInstanceOf(CaseTypeNotInBlueprintError);
		});

		// -----------------------------------------------------------
		// dropSchema — remove the schema row + per-property indexes
		// -----------------------------------------------------------

		it("dropSchema removes the case_type_schemas row and indexes after applySchemaChange seeded them", async () => {
			// Seed via `applySchemaChange`: materializes the schema
			// row + the trgm GIN index for the `text`-typed `name`
			// property (text properties get a `gin_trgm_ops` partial
			// expression index for `match` / `compare` coverage).
			const store = await options.factory(TENANT_A);
			await seedSchema(store, buildBlueprint([PATIENT_CASE_TYPE]), "patient");

			// Sanity: an insert against the seeded schema lands.
			// Without this, a test that asserts "schema row gone"
			// after `dropSchema` would pass against a regression that
			// silently no-ops `applySchemaChange` itself.
			await store.insert({
				appId: APP_ID,
				row: {
					case_id: PATIENT_ALICE_ID,
					case_type: "patient",
					case_name: DEFAULT_CASE_NAME,
					status: "open",
					properties: makeProperties({ name: "Alice", age: 25 }),
				},
			});
			const beforeDrop = await store.query({
				appId: APP_ID,
				caseType: "patient",
			});
			expect(beforeDrop).toHaveLength(1);

			await store.dropSchema({ appId: APP_ID, caseType: "patient" });

			// After `dropSchema`, an insert against `(appId, "patient")`
			// fails the schema lookup with `SchemaNotSyncedError` — the
			// schema row is gone. This is the interface-level proof
			// that the row was deleted; probing `case_type_schemas`
			// directly would couple the contract test to the Postgres
			// row shape rather than the `CaseStore` surface.
			await expect(
				store.insert({
					appId: APP_ID,
					row: {
						case_id: PATIENT_BOB_ID,
						case_type: "patient",
						case_name: DEFAULT_CASE_NAME,
						status: "open",
						properties: makeProperties({ name: "Bob", age: 30 }),
					},
				}),
			).rejects.toBeInstanceOf(SchemaNotSyncedError);
		});

		it("dropSchema is idempotent — calling against an absent case type is a no-op", async () => {
			const store = await options.factory(TENANT_A);
			// No `applySchemaChange` first — the schema row genuinely
			// doesn't exist. The contract is "drop is safe to call
			// after a partial-failure recovery flow", so this absence
			// path must not throw.
			await expect(
				store.dropSchema({ appId: APP_ID, caseType: "patient" }),
			).resolves.toBeUndefined();
			// Second call is also a no-op — establishes idempotence
			// rather than first-call-only luck.
			await expect(
				store.dropSchema({ appId: APP_ID, caseType: "patient" }),
			).resolves.toBeUndefined();
		});

		// -----------------------------------------------------------
		// Tenant isolation — the `project_id` filter is structural. The
		// Project is the tenant; `owner_id` (the CommCare case-owner) is a
		// SEPARATE axis, so two members of ONE Project share rows while two
		// Projects stay isolated.
		// -----------------------------------------------------------

		it("query is scoped to the bound Project — Project B cannot see Project A's row", async () => {
			const storeA = await options.factory(TENANT_A);
			const storeB = await options.factory(TENANT_B);
			const blueprint = buildBlueprint([PATIENT_CASE_TYPE]);
			// Schema is per-app, not per-owner, so seeding through
			// either store works — pick one.
			await seedSchema(storeA, blueprint, "patient");

			await storeA.insert({
				appId: APP_ID,
				row: {
					case_id: PATIENT_ALICE_ID,
					case_type: "patient",
					case_name: DEFAULT_CASE_NAME,
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

		it("query is shared within a Project — a co-member sees another member's row", async () => {
			// One Project, two different actors (case-owners). The NEW
			// Project-sharing behavior: same `projectId` ⇒ both see the row
			// regardless of who created it. (Pre-rescope this isolated by
			// owner; now the Project is the tenant and `owner_id` is a
			// separate, non-tenant axis.)
			const memberOne = await options.factory({
				projectId: PROJECT_A,
				actorUserId: USER_A,
			});
			const memberTwo = await options.factory({
				projectId: PROJECT_A,
				actorUserId: USER_B,
			});
			const blueprint = buildBlueprint([PATIENT_CASE_TYPE]);
			await seedSchema(memberOne, blueprint, "patient");

			const { caseId } = await memberOne.insert({
				appId: APP_ID,
				row: {
					case_type: "patient",
					case_name: DEFAULT_CASE_NAME,
					status: "open",
					properties: makeProperties({ name: "Alice", age: 25 }),
				},
			});

			// memberTwo (same Project, different actor) sees memberOne's row…
			const seenByTwo = await memberTwo.query({
				appId: APP_ID,
				caseType: "patient",
			});
			expect(seenByTwo).toHaveLength(1);
			// …and the row's `owner_id` records the ACTUAL creator (USER_A),
			// not the reader — attribution is preserved across the share.
			expect(seenByTwo[0]?.owner_id).toBe(USER_A);
			expect(seenByTwo[0]?.case_id).toBe(caseId);
			// The internal tenant key never surfaces on a `query` row either
			// (CaseRow Omit) — guards `query`'s `selectAll` strip.
			expect(seenByTwo[0]).not.toHaveProperty("project_id");
		});

		it("update from another Project cannot mutate the row", async () => {
			const storeA = await options.factory(TENANT_A);
			const storeB = await options.factory(TENANT_B);
			const blueprint = buildBlueprint([PATIENT_CASE_TYPE]);
			await seedSchema(storeA, blueprint, "patient");

			await storeA.insert({
				appId: APP_ID,
				row: {
					case_id: PATIENT_ALICE_ID,
					case_type: "patient",
					case_name: DEFAULT_CASE_NAME,
					status: "open",
					properties: makeProperties({ name: "Alice", age: 25 }),
				},
			});

			// Owner B's update against owner A's case throws because
			// the row is invisible under owner B's filter. The
			// throw shape pins the contract: visibility is the gate,
			// not "always allow but write nothing". The typed
			// `CaseNotFoundError` instance check spans the module
			// boundary (constructed inside `PostgresCaseStore`,
			// caught here) — that's the bundler-edge concern the
			// `readonly name` field initializer defends against, and
			// pinning it through a real cross-module call site is
			// what the contract harness uniquely covers.
			await expect(
				storeB.update({
					appId: APP_ID,
					caseId: PATIENT_ALICE_ID,
					patch: { properties: makeProperties({ age: 99 }) },
				}),
			).rejects.toBeInstanceOf(CaseNotFoundError);

			// The row's data is untouched as seen through owner A.
			const rows = await storeA.query({
				appId: APP_ID,
				caseType: "patient",
			});
			expect(rows).toHaveLength(1);
			expect(rows[0]?.properties).toEqual({ name: "Alice", age: 25 });
		});

		it("close from another owner cannot close the row", async () => {
			const storeA = await options.factory(TENANT_A);
			const storeB = await options.factory(TENANT_B);
			const blueprint = buildBlueprint([PATIENT_CASE_TYPE]);
			await seedSchema(storeA, blueprint, "patient");

			await storeA.insert({
				appId: APP_ID,
				row: {
					case_id: PATIENT_ALICE_ID,
					case_type: "patient",
					case_name: DEFAULT_CASE_NAME,
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
			});

			const rows = await storeA.query({
				appId: APP_ID,
				caseType: "patient",
			});
			expect(rows).toHaveLength(1);
			expect(rows[0]?.closed_on).toBeNull();
			expect(rows[0]?.status).toBe("open");
		});

		it("traverse from another Project cannot reach the row", async () => {
			const storeA = await options.factory(TENANT_A);
			const storeB = await options.factory(TENANT_B);
			const blueprint = buildBlueprint([PATIENT_CASE_TYPE]);
			await seedSchema(storeA, blueprint, "patient");

			await storeA.insert({
				appId: APP_ID,
				row: {
					case_id: PATIENT_ALICE_ID,
					case_type: "patient",
					case_name: DEFAULT_CASE_NAME,
					status: "open",
					properties: makeProperties({ name: "Alice", age: 25 }),
				},
			});

			// `self` traverse against Project B's store returns empty
			// because the case's `project_id` doesn't match Project B.
			const reached = await storeB.traverse({
				appId: APP_ID,
				caseId: PATIENT_ALICE_ID,
				via: { kind: "self" },
			});
			expect(reached).toHaveLength(0);
		});

		it("traverse is shared within a Project — a co-member reaches the row, and the row omits the tenant key", async () => {
			// Same Project, two actors. The new sharing semantics: memberTwo
			// reaches memberOne's row via a `self` traverse — project-scoped,
			// NOT owner-scoped (a regression to `owner_id` would return empty
			// for the co-member, the exact ambiguity the cross-Project test
			// alone can't catch). Also pins the `CaseRow` Omit contract: the
			// returned row must NOT carry the internal `project_id` tenant key
			// (traverse's self arm uses `selectAll`, so this guards the strip).
			const memberOne = await options.factory({
				projectId: PROJECT_A,
				actorUserId: USER_A,
			});
			const memberTwo = await options.factory({
				projectId: PROJECT_A,
				actorUserId: USER_B,
			});
			const blueprint = buildBlueprint([PATIENT_CASE_TYPE]);
			await seedSchema(memberOne, blueprint, "patient");

			await memberOne.insert({
				appId: APP_ID,
				row: {
					case_id: PATIENT_ALICE_ID,
					case_type: "patient",
					case_name: DEFAULT_CASE_NAME,
					status: "open",
					properties: makeProperties({ name: "Alice", age: 25 }),
				},
			});

			const reached = await memberTwo.traverse({
				appId: APP_ID,
				caseId: PATIENT_ALICE_ID,
				via: { kind: "self" },
			});
			expect(reached).toHaveLength(1);
			expect(reached[0]?.case_id).toBe(PATIENT_ALICE_ID);
			// The tenant key never surfaces on a returned row (CaseRow Omit).
			expect(reached[0]).not.toHaveProperty("project_id");
			// …but the case-owner attribution does (USER_A created it).
			expect(reached[0]?.owner_id).toBe(USER_A);
		});

		it("insert lands in the bound Project — Project B cannot see Project A's freshly inserted row", async () => {
			// `insert` stamps `project_id = bound Project` (tenant) and
			// `owner_id = bound actor` (case-owner) at the write
			// boundary (see `PostgresCaseStore.insert`'s row
			// composition). Pin the contract: owner-A inserts, owner-B
			// queries, the row is invisible. Implicit before; explicit
			// here so a regression that admits caller-supplied
			// `owner_id` overrides surfaces immediately.
			const storeA = await options.factory(TENANT_A);
			const storeB = await options.factory(TENANT_B);
			const blueprint = buildBlueprint([PATIENT_CASE_TYPE]);
			await seedSchema(storeA, blueprint, "patient");

			await storeA.insert({
				appId: APP_ID,
				row: {
					case_id: PATIENT_ALICE_ID,
					case_type: "patient",
					case_name: DEFAULT_CASE_NAME,
					status: "open",
					properties: makeProperties({ name: "Alice", age: 25 }),
				},
			});

			const seenByB = await storeB.query({
				appId: APP_ID,
				caseType: "patient",
			});
			expect(seenByB).toHaveLength(0);
		});

		it("applySchemaChange's case_type_schemas row is shared across owners (not per-tenant)", async () => {
			// `case_type_schemas` is keyed by `(app_id, case_type)`,
			// NOT `(app_id, case_type, owner_id)` — the schema is an
			// authoring-layer concern (every tenant under the same
			// app sees the same case-type definitions), not a
			// data-layer concern. Pin the contract: owner-A's schema
			// sync produces a row visible to owner-B's writes
			// targeting the same `(appId, caseType)`; owner-B's
			// writes pass AJV validation against the shared row
			// without owner-B running its own `applySchemaChange`.
			const storeA = await options.factory(TENANT_A);
			const storeB = await options.factory(TENANT_B);
			const blueprint = buildBlueprint([PATIENT_CASE_TYPE]);

			// Owner A's additive `applySchemaChange` writes the
			// shared schema row.
			await storeA.applySchemaChange({
				appId: APP_ID,
				caseType: "patient",
				caseTypeSchemas: buildCaseTypeMap(blueprint),
			});

			// Owner B writes against the same `(appId, caseType)` —
			// no separate sync from B. The write succeeds because
			// `getValidator` reads the shared schema row that A
			// produced.
			await storeB.insert({
				appId: APP_ID,
				row: {
					case_id: PATIENT_BOB_ID,
					case_type: "patient",
					case_name: DEFAULT_CASE_NAME,
					status: "open",
					properties: makeProperties({ name: "Bob", age: 40 }),
				},
			});

			// B's query confirms the row landed in B's tenant scope;
			// A's query confirms tenant separation still holds at the
			// row level even though the schema is shared.
			const seenByB = await storeB.query({
				appId: APP_ID,
				caseType: "patient",
			});
			expect(seenByB).toHaveLength(1);
			expect(seenByB[0]?.case_id).toBe(PATIENT_BOB_ID);

			const seenByA = await storeA.query({
				appId: APP_ID,
				caseType: "patient",
			});
			expect(seenByA).toHaveLength(0);
		});

		it("generateSampleData lands rows in the calling owner's tenant scope only", async () => {
			// Pin the per-row tenant contract for the sample-data
			// path: A generates, A sees the rows, B sees nothing.
			const storeA = await options.factory(TENANT_A);
			const storeB = await options.factory(TENANT_B);
			const blueprint = buildBlueprint([PATIENT_CASE_TYPE]);
			await seedSchema(storeA, blueprint, "patient");

			await storeA.generateSampleData({
				appId: APP_ID,
				caseType: findCaseTypeOrFail(blueprint, "patient"),
				count: 5,
				seed: "tenant-isolation",
			});

			const seenByA = await storeA.query({
				appId: APP_ID,
				caseType: "patient",
			});
			expect(seenByA).toHaveLength(5);

			const seenByB = await storeB.query({
				appId: APP_ID,
				caseType: "patient",
			});
			expect(seenByB).toHaveLength(0);
		});

		it("resetSampleData scopes deletion + regeneration to the calling owner's rows", async () => {
			// A and B both populate. A resets. A's rows are deleted
			// + regenerated; B's rows are UNTOUCHED. Pins the tenant-
			// scoped DELETE inside `resetSampleData`'s atomic
			// transaction.
			const storeA = await options.factory(TENANT_A);
			const storeB = await options.factory(TENANT_B);
			const blueprint = buildBlueprint([PATIENT_CASE_TYPE]);
			await seedSchema(storeA, blueprint, "patient");

			const patientType = findCaseTypeOrFail(blueprint, "patient");
			await storeA.generateSampleData({
				appId: APP_ID,
				caseType: patientType,
				count: 3,
				seed: "owner-a-initial",
			});
			await storeB.generateSampleData({
				appId: APP_ID,
				caseType: patientType,
				count: 4,
				seed: "owner-b-initial",
			});

			const beforeBRows = await storeB.query({
				appId: APP_ID,
				caseType: "patient",
			});
			const beforeBIds = new Set(beforeBRows.map((r) => r.case_id));

			const result = await storeA.resetSampleData({
				appId: APP_ID,
				caseType: patientType,
				count: 2,
			});
			expect(result.deleted).toBe(3);
			expect(result.inserted).toBe(2);

			// B's rows are untouched by A's reset — id set matches
			// the pre-reset population exactly.
			const afterBRows = await storeB.query({
				appId: APP_ID,
				caseType: "patient",
			});
			expect(afterBRows).toHaveLength(4);
			const afterBIds = new Set(afterBRows.map((r) => r.case_id));
			expect(afterBIds).toEqual(beforeBIds);

			// A's rows are the freshly-regenerated set: count 2.
			const afterARows = await storeA.query({
				appId: APP_ID,
				caseType: "patient",
			});
			expect(afterARows).toHaveLength(2);
		});

		// -----------------------------------------------------------
		// generateSampleData — heuristic-driven population
		// -----------------------------------------------------------

		it("generateSampleData inserts the requested count of rows for the case-type", async () => {
			const store = await options.factory(TENANT_A);
			const blueprint = buildBlueprint([PATIENT_CASE_TYPE]);
			await seedSchema(store, blueprint, "patient");

			const result = await store.generateSampleData({
				appId: APP_ID,
				caseType: findCaseTypeOrFail(blueprint, "patient"),
				count: 5,
				seed: "alpha",
			});
			expect(result).toEqual({ inserted: 5 });

			const rows = await store.query({
				appId: APP_ID,
				caseType: "patient",
			});
			expect(rows).toHaveLength(5);
			// Every row carries the bound actor (`owner_id`) + the requested
			// case-type — pins that the generator's output flows
			// through `insert`'s tenant-scoping path.
			for (const row of rows) {
				expect(row.owner_id).toBe(USER_A);
				expect(row.case_type).toBe("patient");
			}
		});

		it("generateSampleData is deterministic per seed", async () => {
			// Two stores against separate owners so generated rows
			// land in distinct tenant scopes; both calls use the same
			// seed and the produced `properties` documents should
			// match by-row.
			const storeA = await options.factory(TENANT_A);
			const storeB = await options.factory(TENANT_B);
			const blueprint = buildBlueprint([PATIENT_CASE_TYPE]);
			await seedSchema(storeA, blueprint, "patient");
			await seedSchema(storeB, blueprint, "patient");

			const patientType = findCaseTypeOrFail(blueprint, "patient");
			await storeA.generateSampleData({
				appId: APP_ID,
				caseType: patientType,
				count: 3,
				seed: "deterministic",
			});
			await storeB.generateSampleData({
				appId: APP_ID,
				caseType: patientType,
				count: 3,
				seed: "deterministic",
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
			const store = await options.factory(TENANT_A);
			const blueprint = buildBlueprint([PATIENT_CASE_TYPE]);
			await seedSchema(store, blueprint, "patient");
			const patientType = findCaseTypeOrFail(blueprint, "patient");

			// Seed an initial population.
			await store.generateSampleData({
				appId: APP_ID,
				caseType: patientType,
				count: 4,
				seed: "before-reset",
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
				caseType: patientType,
				count: 2,
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
			const store = await options.factory(TENANT_A);
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
				caseType: findCaseTypeOrFail(blueprint, "household"),
				count: 3,
				seed: "households",
			});
			await store.generateSampleData({
				appId: APP_ID,
				caseType: findCaseTypeOrFail(blueprint, "patient"),
				count: 5,
				seed: "patients",
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

		// -----------------------------------------------------------
		// query — calculated-column projection
		// -----------------------------------------------------------
		//
		// The case-list authoring-surface live preview routes through
		// `query` (with `calculated`) so each calc-arm column's
		// `expression` evaluates at the SQL layer rather than
		// reconstructed in TypeScript. The contract pins:
		//
		//   1. Every projected column lands on the result row's
		//      `calculated` map, keyed by the column's `uuid`.
		//   2. SQL NULL surfaces as JS `null` (the JsonValue union's
		//      null arm), NOT as omitted from the map. Consumers can
		//      distinguish "column absent from request" (key not in
		//      map) from "column evaluated to null"
		//      (`map[uuid] === null`).
		//   3. The empty / absent `calculated` arm behaves like a
		//      regular `query` with an empty `calculated: {}` map per
		//      row — the projection is additive, not destructive.
		//   4. Predicate / sort / limit / offset arguments compose with
		//      calculated-column projection (the same arguments the
		//      live preview threads).

		it("projects calculated columns onto the result row's `calculated` map", async () => {
			const store = await options.factory(TENANT_A);
			const blueprint = buildBlueprint([PATIENT_CASE_TYPE]);
			await seedSchema(store, blueprint, "patient");
			await store.insert({
				appId: APP_ID,
				row: {
					case_id: PATIENT_ALICE_ID,
					case_type: "patient",
					case_name: DEFAULT_CASE_NAME,
					status: "open",
					properties: makeProperties({ name: "Alice", age: 30 }),
				},
			});

			// `age + 1` exercises the arith arm, the term-via-prop leaf
			// reader, and the literal cast — three independent compiler
			// surfaces in one expression. The cast on each operand is
			// the same `data_type: "int"` shape the editor emits.
			const ageNextYear = arith(
				"+",
				term(prop("patient", "age")),
				term({ kind: "literal", value: 1, data_type: "int" }),
			);

			const ageNextYearUuid = asUuid("age_next_year");
			const rows = await store.query({
				appId: APP_ID,
				caseType: "patient",
				caseTypeSchemas: buildCaseTypeMap(blueprint),
				calculated: [
					calculatedColumn(ageNextYearUuid, "Next year", ageNextYear),
				],
			});
			expect(rows).toHaveLength(1);
			const row = rows[0];
			if (row === undefined) throw new Error("expected one row");
			// Postgres returns the int-typed arithmetic result as a
			// JS number through pg-driver's per-OID deserializer.
			expect(Number(row.calculated[ageNextYearUuid])).toBe(31);
			// The row still carries the `cases`-side columns verbatim.
			expect(row.case_id).toBe(PATIENT_ALICE_ID);
			expect(row.properties).toEqual({ name: "Alice", age: 30 });
		});

		it("emits null for a calculated expression that evaluates to SQL NULL", async () => {
			// A calculated column whose expression resolves to NULL
			// must appear in the result map keyed by its id with
			// JS `null` value — NOT omitted. Consumers depend on the
			// "key always present" invariant to distinguish "column
			// absent from request" (key absent) from "evaluated to null"
			// (key present, value null).
			const store = await options.factory(TENANT_A);
			const blueprint = buildBlueprint([PATIENT_CASE_TYPE]);
			await seedSchema(store, blueprint, "patient");
			await store.insert({
				appId: APP_ID,
				row: {
					case_id: PATIENT_ALICE_ID,
					case_type: "patient",
					case_name: DEFAULT_CASE_NAME,
					status: "open",
					properties: makeProperties({ name: "Alice", age: 30 }),
				},
			});

			// `term(literal(null))` produces a SQL NULL constant.
			const nullExpr = term({ kind: "literal", value: null });
			const nothingUuid = asUuid("nothing");
			const rows = await store.query({
				appId: APP_ID,
				caseType: "patient",
				caseTypeSchemas: buildCaseTypeMap(blueprint),
				calculated: [calculatedColumn(nothingUuid, "Nothing", nullExpr)],
			});
			expect(rows).toHaveLength(1);
			const row = rows[0];
			if (row === undefined) throw new Error("expected one row");
			// Key present, value null.
			expect(nothingUuid in row.calculated).toBe(true);
			expect(row.calculated[nothingUuid]).toBeNull();
		});

		it("emits an empty calculated map when no calculated columns are supplied", async () => {
			const store = await options.factory(TENANT_A);
			const blueprint = buildBlueprint([PATIENT_CASE_TYPE]);
			await seedSchema(store, blueprint, "patient");
			await store.insert({
				appId: APP_ID,
				row: {
					case_id: PATIENT_ALICE_ID,
					case_type: "patient",
					case_name: DEFAULT_CASE_NAME,
					status: "open",
					properties: makeProperties({ name: "Alice", age: 30 }),
				},
			});

			const rows = await store.query({
				appId: APP_ID,
				caseType: "patient",
				caseTypeSchemas: buildCaseTypeMap(blueprint),
				calculated: [],
			});
			expect(rows).toHaveLength(1);
			const row = rows[0];
			if (row === undefined) throw new Error("expected one row");
			expect(row.calculated).toEqual({});
			// The cases-side columns still come through.
			expect(row.case_id).toBe(PATIENT_ALICE_ID);
		});

		it("composes calculated projection with predicate filtering and sort", async () => {
			// Two rows; one passes the predicate, the other doesn't.
			// Sort by age desc; the matched row's calculated value
			// surfaces correctly. Pins the cross-feature composition
			// the live-preview path relies on.
			const store = await options.factory(TENANT_A);
			const blueprint = buildBlueprint([PATIENT_CASE_TYPE]);
			await seedSchema(store, blueprint, "patient");
			await store.insert({
				appId: APP_ID,
				row: {
					case_id: PATIENT_ALICE_ID,
					case_type: "patient",
					case_name: DEFAULT_CASE_NAME,
					status: "open",
					properties: makeProperties({ name: "Alice", age: 25 }),
				},
			});
			await store.insert({
				appId: APP_ID,
				row: {
					case_id: PATIENT_BOB_ID,
					case_type: "patient",
					case_name: DEFAULT_CASE_NAME,
					status: "open",
					properties: makeProperties({ name: "Bob", age: 40 }),
				},
			});

			const ageNextYear = arith(
				"+",
				term(prop("patient", "age")),
				term({ kind: "literal", value: 1, data_type: "int" }),
			);

			const ageNextYearUuid = asUuid("age_next_year");
			const rows = await store.query({
				appId: APP_ID,
				caseType: "patient",
				caseTypeSchemas: buildCaseTypeMap(blueprint),
				calculated: [
					calculatedColumn(ageNextYearUuid, "Next year", ageNextYear),
				],
				predicate: gt(prop("patient", "age"), literal(30)),
				sort: [
					{
						direction: "desc",
						expression: term(prop("patient", "age")),
					},
				],
			});
			expect(rows).toHaveLength(1);
			const row = rows[0];
			if (row === undefined) throw new Error("expected one row");
			expect(row.case_id).toBe(PATIENT_BOB_ID);
			expect(Number(row.calculated[ageNextYearUuid])).toBe(41);
		});

		it("sorts by a calculated column's expression when the same expression is reused in ORDER BY", async () => {
			// The Display section's `sortKeyToExpression` helper lifts
			// a calculated-source `SortKey` to the calculated column's
			// `expression` verbatim, then passes it both as
			// `calculated[0]` AND in the `sort` slot's `expression`.
			// Postgres's planner CSE-folds the redundant evaluation
			// across SELECT and ORDER BY (one evaluation per row), so
			// the runtime cost is no worse than sorting by a plain
			// property. This test pins both halves of the contract:
			//
			//   1. The SQL emitter accepts the same expression in both
			//      slots without duplicate-alias / over-cap throws.
			//   2. The rows return in ascending-by-calculated order.
			//
			// Insert two patients with distinct ages (Alice 25, Bob 40);
			// the calculated column emits `age + 1` (so Alice = 26,
			// Bob = 41). Sort ascending by the same expression; expect
			// Alice first, Bob second.
			const store = await options.factory(TENANT_A);
			const blueprint = buildBlueprint([PATIENT_CASE_TYPE]);
			await seedSchema(store, blueprint, "patient");
			await store.insert({
				appId: APP_ID,
				row: {
					case_id: PATIENT_ALICE_ID,
					case_type: "patient",
					case_name: DEFAULT_CASE_NAME,
					status: "open",
					properties: makeProperties({ name: "Alice", age: 25 }),
				},
			});
			await store.insert({
				appId: APP_ID,
				row: {
					case_id: PATIENT_BOB_ID,
					case_type: "patient",
					case_name: DEFAULT_CASE_NAME,
					status: "open",
					properties: makeProperties({ name: "Bob", age: 40 }),
				},
			});

			// Calculated expression — `age + 1`. Same shape the
			// calc-arm column editor produces.
			const ageNextYear = arith(
				"+",
				term(prop("patient", "age")),
				term({ kind: "literal", value: 1, data_type: "int" }),
			);

			const ageNextYearUuid = asUuid("age_next_year");
			const rows = await store.query({
				appId: APP_ID,
				caseType: "patient",
				caseTypeSchemas: buildCaseTypeMap(blueprint),
				calculated: [
					calculatedColumn(ageNextYearUuid, "Next year", ageNextYear),
				],
				// `sortKeyToExpression`'s lift contract: a calculated-
				// source SortKey passes the calculated column's
				// `expression` verbatim into the case-store's `sort`
				// slot. The case-store reuses the same expression in
				// ORDER BY; Postgres CSE-folds.
				sort: [
					{
						direction: "asc",
						expression: ageNextYear,
					},
				],
			});
			expect(rows).toHaveLength(2);
			// Alice (age + 1 = 26) comes before Bob (age + 1 = 41).
			expect(rows[0]?.case_id).toBe(PATIENT_ALICE_ID);
			expect(rows[1]?.case_id).toBe(PATIENT_BOB_ID);
			// Calculated values surface in declaration order on each row.
			expect(Number(rows[0]?.calculated[ageNextYearUuid])).toBe(26);
			expect(Number(rows[1]?.calculated[ageNextYearUuid])).toBe(41);
		});

		it("does not leak calculated-column aliases onto the row's top-level shape", async () => {
			// The reshape step strips the per-id aliases from the row's
			// top level after extracting them into `calculated`. Without
			// the strip, a sort/filter callback could read the aliased
			// value off the row root rather than the canonical
			// `calculated` map and the two paths would silently drift.
			const store = await options.factory(TENANT_A);
			const blueprint = buildBlueprint([PATIENT_CASE_TYPE]);
			await seedSchema(store, blueprint, "patient");
			await store.insert({
				appId: APP_ID,
				row: {
					case_id: PATIENT_ALICE_ID,
					case_type: "patient",
					case_name: DEFAULT_CASE_NAME,
					status: "open",
					properties: makeProperties({ name: "Alice", age: 30 }),
				},
			});

			const aliasUnderTestUuid = asUuid("alias_under_test");
			const rows = await store.query({
				appId: APP_ID,
				caseType: "patient",
				caseTypeSchemas: buildCaseTypeMap(blueprint),
				calculated: [
					calculatedColumn(
						aliasUnderTestUuid,
						"Alias",
						term({ kind: "literal", value: "x" }),
					),
				],
			});
			expect(rows).toHaveLength(1);
			const row = rows[0];
			if (row === undefined) throw new Error("expected one row");
			// Top-level row carries no extra alias key — calculated
			// columns never collide with `cases` columns because the
			// SQL emitter routes them under a `__nova_calc__<uuid>`
			// alias and the row partition strips that wire alias before
			// returning.
			expect(aliasUnderTestUuid in row).toBe(false);
			// The calculated map carries the value.
			expect(row.calculated[aliasUnderTestUuid]).toBe("x");
		});

		it("emits an empty rows array when the case-type has no cases", async () => {
			const store = await options.factory(TENANT_A);
			const blueprint = buildBlueprint([PATIENT_CASE_TYPE]);
			await seedSchema(store, blueprint, "patient");

			const rows = await store.query({
				appId: APP_ID,
				caseType: "patient",
				caseTypeSchemas: buildCaseTypeMap(blueprint),
				calculated: [calculatedColumn(asUuid("today_iso"), "Today", today())],
			});
			expect(rows).toEqual([]);
		});

		it("returns a Date object for a date-typed calculated expression", async () => {
			// Pin the pg-driver deserialization shape for date-typed
			// calculated columns. `today()` compiles to `now()::date` in
			// the SQL emitter, and pg's per-OID deserializer returns the
			// `date` column as a JS `Date` object — NOT an ISO string.
			// The renderer in `DisplayPreview.tsx` discriminates on
			// `value instanceof Date` so the cell formatting handles
			// both the string and Date arms cleanly. Without this
			// contract test, a future emitter change to a string-shaped
			// date would surface as a silent renderer regression that
			// no test catches.
			const store = await options.factory(TENANT_A);
			const blueprint = buildBlueprint([PATIENT_CASE_TYPE]);
			await seedSchema(store, blueprint, "patient");
			await store.insert({
				appId: APP_ID,
				row: {
					case_id: PATIENT_ALICE_ID,
					case_type: "patient",
					case_name: DEFAULT_CASE_NAME,
					status: "open",
					properties: makeProperties({ name: "Alice", age: 30 }),
				},
			});
			const todayUuid = asUuid("today_iso");
			const rows = await store.query({
				appId: APP_ID,
				caseType: "patient",
				caseTypeSchemas: buildCaseTypeMap(blueprint),
				calculated: [calculatedColumn(todayUuid, "Today", today())],
			});
			expect(rows).toHaveLength(1);
			const row = rows[0];
			if (row === undefined) throw new Error("expected one row");
			// The value must be present on the calculated map.
			expect(todayUuid in row.calculated).toBe(true);
			// pg-driver returns date columns as Date objects. The
			// renderer special-cases `instanceof Date`. Pinning the
			// shape protects the contract — a future change to the
			// emitter that returns a string here would break the
			// cell renderer's date formatting.
			const value = row.calculated[todayUuid];
			expect(value instanceof Date).toBe(true);
		});

		// -----------------------------------------------------------
		// Reserved-column collision protection
		// -----------------------------------------------------------
		//
		// Pre-fix repro: a programmatic caller supplies a calculated-
		// column uuid that matches a reserved `cases` column name
		// (e.g. `case_name`). Postgres allows duplicate output names;
		// pg-driver keeps the LAST occurrence; the row's actual
		// `case_name` becomes the calculated value; the reshape's
		// strip-step then deletes the slot entirely. Real data loss
		// in one composition mistake.
		//
		// Post-fix: calculated aliases are emitted under a fixed
		// `__nova_calc__<uuid>` prefix. The wire and the consumer-
		// facing key live in disjoint keyspaces, so the row's
		// reserved column survives unaltered AND the calculated
		// value lands on `row.calculated[uuid]` under the column's
		// uuid.
		//
		// Test sweeps every reserved column the case-store carries
		// at the row level, plus `app_id` (excluded from the user-
		// facing reserved set but present on the row), and the JSONB
		// `properties` slot. A regression to non-prefixed aliasing
		// would fail this test on multiple discovered slots.

		const RESERVED_COLLISION_UUIDS = [
			"case_name",
			"case_id",
			"case_type",
			"owner_id",
			"status",
			"app_id",
			"opened_on",
			"closed_on",
			"modified_on",
			"parent_case_id",
			"properties",
		] as const;

		for (const collisionName of RESERVED_COLLISION_UUIDS) {
			it(`preserves the row's \`${collisionName}\` column when a calculated uuid collides`, async () => {
				const store = await options.factory(TENANT_A);
				const blueprint = buildBlueprint([PATIENT_CASE_TYPE]);
				await seedSchema(store, blueprint, "patient");
				await store.insert({
					appId: APP_ID,
					row: {
						case_id: PATIENT_ALICE_ID,
						case_type: "patient",
						case_name: DEFAULT_CASE_NAME,
						status: "open",
						properties: makeProperties({ name: "Alice", age: 30 }),
					},
				});

				// The collision uuid mirrors the reserved column name so
				// a regression to non-prefixed aliasing would tee the
				// calculated value over the row's scalar.
				const collisionUuid = asUuid(collisionName);
				// The calculated expression is a constant string sentinel
				// — distinguishes the calculated value from the row's
				// scalar value at every assertion site.
				const SENTINEL = "CALCULATED_VALUE";
				const rows = await store.query({
					appId: APP_ID,
					caseType: "patient",
					caseTypeSchemas: buildCaseTypeMap(blueprint),
					calculated: [
						calculatedColumn(collisionUuid, "Header", term(literal(SENTINEL))),
					],
				});
				expect(rows).toHaveLength(1);
				const row = rows[0];
				if (row === undefined) throw new Error("expected one row");

				// Calculated value lands on the calculated map keyed by
				// the column's uuid.
				expect(row.calculated[collisionUuid]).toBe(SENTINEL);

				// Row's scalar column survives unaltered. Per-slot
				// expected values mirror the inserted row above; the
				// `properties` slot reads the JSONB document; the
				// creation-stamped timestamps read as real dates and
				// `closed_on` stays null.
				switch (collisionName) {
					case "case_name":
						expect(row.case_name).toBe(DEFAULT_CASE_NAME);
						break;
					case "case_id":
						expect(row.case_id).toBe(PATIENT_ALICE_ID);
						break;
					case "case_type":
						expect(row.case_type).toBe("patient");
						break;
					case "owner_id":
						expect(row.owner_id).toBe(USER_A);
						break;
					case "status":
						expect(row.status).toBe("open");
						break;
					case "app_id":
						expect(row.app_id).toBe(APP_ID);
						break;
					case "opened_on":
						// Creation-stamped at insert (CommCare's own
						// case lifecycle: `date_opened` is set the
						// moment a case is created). The collision-
						// protection contract is the load-bearing
						// check: the row's column survives unaltered
						// regardless of the value at insert time.
						expect(row.opened_on).toBeInstanceOf(Date);
						break;
					case "closed_on":
						expect(row.closed_on).toBeNull();
						break;
					case "modified_on":
						// Creation-stamped at insert alongside
						// `opened_on`, then re-stamped on every UPDATE.
						expect(row.modified_on).toBeInstanceOf(Date);
						break;
					case "parent_case_id":
						expect(row.parent_case_id).toBeNull();
						break;
					case "properties":
						expect(row.properties).toEqual({ name: "Alice", age: 30 });
						break;
				}
			});
		}

		it("rejects an empty-string calculated uuid with a typed compiler-bug throw", async () => {
			// Belt-and-suspenders: a programmatic caller (fixtures, SA
			// tools, future surfaces) could supply an empty-string
			// uuid. The store rejects it with the canonical compiler-
			// bug message shape rather than letting Postgres reject an
			// empty SELECT alias and leak its parser error.
			const store = await options.factory(TENANT_A);
			const blueprint = buildBlueprint([PATIENT_CASE_TYPE]);
			await seedSchema(store, blueprint, "patient");

			await expect(
				store.query({
					appId: APP_ID,
					caseType: "patient",
					caseTypeSchemas: buildCaseTypeMap(blueprint),
					calculated: [
						calculatedColumn(asUuid(""), "Header", term(literal("x"))),
					],
				}),
			).rejects.toThrowError(/empty-string uuid/);
		});

		it("rejects a calculated uuid whose composed alias exceeds Postgres' 63-byte cap", async () => {
			// Postgres silently truncates identifiers at
			// `NAMEDATALEN - 1` (63 bytes). The composed wire alias
			// is `__nova_calc__<uuid>` — 13 bytes of prefix, so any
			// uuid ≥ 51 bytes pushes the alias over the cap. Without
			// this guard, truncation kicks in: the downstream row-
			// partition step uses the FULL pre-truncation alias for
			// the lookup, misses, and silently emits `null` for
			// every row. The uuid under test is 60 bytes (alias 73
			// bytes total — safely past the cap).
			//
			// Mirrors the empty-uuid rejection test above and the
			// `indexName` defense pattern at the bottom of
			// `lib/case-store/postgres/store.ts`.
			const store = await options.factory(TENANT_A);
			const blueprint = buildBlueprint([PATIENT_CASE_TYPE]);
			await seedSchema(store, blueprint, "patient");
			const overlongUuid = asUuid("x".repeat(60));
			await expect(
				store.query({
					appId: APP_ID,
					caseType: "patient",
					caseTypeSchemas: buildCaseTypeMap(blueprint),
					calculated: [
						calculatedColumn(overlongUuid, "Header", term(literal("x"))),
					],
				}),
			).rejects.toThrowError(/exceeds Postgres' 63-byte identifier cap/);
		});

		// -----------------------------------------------------------
		// count — predicate-driven row count
		// -----------------------------------------------------------
		//
		// `count(args)` returns the row population the
		// `(appId, caseType, predicate?)` triple resolves to. The
		// Filters-section live preview pairs the count with a
		// limited `query` against the same predicate, so the WHERE
		// clause emitted here MUST match the predicate-narrowed
		// `query` it pairs with — any divergence would surface as a
		// count-vs-row-list mismatch. The four tests pin:
		//
		//   1. Predicate-undefined returns the total population
		//      (matches the "no filter applied" preview state).
		//   2. Predicate-narrowed returns the matching subset only
		//      (the predicate compiles through the same stack as
		//      `query`).
		//   3. Tenant scoping — cross-tenant rows are invisible.
		//   4. The schema map resolves property data types in the
		//      predicate (matches `QueryArgs.caseTypeSchemas`'s
		//      contract).
		//
		// Three patient rows seeded across these tests; the same
		// `(name, age)` shape `query`-related tests use, so any
		// shared compiler-stack regression surfaces in both blocks.

		it("count returns the total row population when predicate is undefined", async () => {
			const store = await options.factory(TENANT_A);
			const blueprint = buildBlueprint([PATIENT_CASE_TYPE]);
			await seedSchema(store, blueprint, "patient");
			await store.insert({
				appId: APP_ID,
				row: {
					case_id: PATIENT_ALICE_ID,
					case_type: "patient",
					case_name: DEFAULT_CASE_NAME,
					status: "open",
					properties: makeProperties({ name: "Alice", age: 30 }),
				},
			});
			await store.insert({
				appId: APP_ID,
				row: {
					case_id: PATIENT_BOB_ID,
					case_type: "patient",
					case_name: DEFAULT_CASE_NAME,
					status: "open",
					properties: makeProperties({ name: "Bob", age: 40 }),
				},
			});

			const total = await store.count({
				appId: APP_ID,
				caseType: "patient",
			});
			expect(total).toBe(2);
		});

		it("count narrows to the predicate-matching subset", async () => {
			const store = await options.factory(TENANT_A);
			const blueprint = buildBlueprint([PATIENT_CASE_TYPE]);
			await seedSchema(store, blueprint, "patient");
			await store.insert({
				appId: APP_ID,
				row: {
					case_id: PATIENT_ALICE_ID,
					case_type: "patient",
					case_name: DEFAULT_CASE_NAME,
					status: "open",
					properties: makeProperties({ name: "Alice", age: 25 }),
				},
			});
			await store.insert({
				appId: APP_ID,
				row: {
					case_id: PATIENT_BOB_ID,
					case_type: "patient",
					case_name: DEFAULT_CASE_NAME,
					status: "open",
					properties: makeProperties({ name: "Bob", age: 40 }),
				},
			});
			await store.insert({
				appId: APP_ID,
				row: {
					case_id: PATIENT_CAROL_ID,
					case_type: "patient",
					case_name: DEFAULT_CASE_NAME,
					status: "open",
					properties: makeProperties({ name: "Carol", age: 35 }),
				},
			});

			// `age > 30` matches Bob + Carol; not Alice.
			const matchedCount = await store.count({
				appId: APP_ID,
				caseType: "patient",
				caseTypeSchemas: buildCaseTypeMap(blueprint),
				predicate: gt(prop("patient", "age"), literal(30)),
			});
			expect(matchedCount).toBe(2);

			// Predicate-undefined returns all three — pins the
			// pair-shape contract the Filters preview relies on
			// ("X of Y total" requires both numbers).
			const totalCount = await store.count({
				appId: APP_ID,
				caseType: "patient",
			});
			expect(totalCount).toBe(3);
		});

		it("count respects the bound Project — cross-Project rows are invisible", async () => {
			const storeA = await options.factory(TENANT_A);
			const blueprint = buildBlueprint([PATIENT_CASE_TYPE]);
			await seedSchema(storeA, blueprint, "patient");
			await storeA.insert({
				appId: APP_ID,
				row: {
					case_id: PATIENT_ALICE_ID,
					case_type: "patient",
					case_name: DEFAULT_CASE_NAME,
					status: "open",
					properties: makeProperties({ name: "Alice", age: 30 }),
				},
			});

			// Owner B sees zero — the structural tenant filter on
			// every method is the same one `query` applies. Mirrors
			// the tenant-isolation tests above.
			const storeB = await options.factory(TENANT_B);
			const otherCount = await storeB.count({
				appId: APP_ID,
				caseType: "patient",
			});
			expect(otherCount).toBe(0);

			// Owner A sees the row they inserted.
			const myCount = await storeA.count({
				appId: APP_ID,
				caseType: "patient",
			});
			expect(myCount).toBe(1);
		});

		it("count uses caseTypeSchemas to resolve typed-property casts in the predicate", async () => {
			// `compileTerm` resolves the property's `data_type` from
			// `caseTypeSchemas` to pick the column cast. A predicate-
			// reading-typed-property `count` call without a schema map
			// means the term compiler reaches an empty schema map
			// and falls through to the default `text` shape — wrong
			// cast for an `int` column would yield zero rows for an
			// otherwise-matching predicate. This test pins the
			// schema-threading contract by asserting the typed-int
			// comparison returns the expected count when the schema
			// map resolves the property's `int` shape.
			const store = await options.factory(TENANT_A);
			const blueprint = buildBlueprint([PATIENT_CASE_TYPE]);
			await seedSchema(store, blueprint, "patient");
			await store.insert({
				appId: APP_ID,
				row: {
					case_id: PATIENT_ALICE_ID,
					case_type: "patient",
					case_name: DEFAULT_CASE_NAME,
					status: "open",
					properties: makeProperties({ name: "Alice", age: 30 }),
				},
			});

			const matched = await store.count({
				appId: APP_ID,
				caseType: "patient",
				caseTypeSchemas: buildCaseTypeMap(blueprint),
				predicate: gt(prop("patient", "age"), literal(20)),
			});
			expect(matched).toBe(1);
		});
	});
}
