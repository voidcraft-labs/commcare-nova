// lib/case-store/form-bridge/__tests__/writeThrough.test.ts
//
// Integration tests for `writeFormCompletionThrough` against a real
// Postgres backend. Each test runs against a per-test isolated
// database (via `setupPerTestDatabase`) so `PostgresCaseStore`'s
// transaction-using methods don't collide with an outer test
// transaction. The wiring mirrors `lib/case-store/postgres/__tests__/store.test.ts`.
//
// Coverage:
//
//   - Registration: inserts the primary case row with the right
//     properties, captures the generated `case_id`, threads it as
//     the parent for any child cases.
//   - Followup: updates the bound case's properties; child cases
//     get the bound `caseId` as their parent.
//   - Close: applies updates first, then `closed_on`; the row is
//     still queryable post-close.
//   - Survey: returns the survey marker without writing to `cases`.
//   - Continuous validation: a re-`query` after the write surfaces
//     the new state immediately (no save/refresh gap).

import type { Kysely } from "kysely";
import { beforeEach, describe, expect, it } from "vitest";
import type { BlueprintDoc } from "@/lib/domain";
import { PostgresCaseStore } from "../../postgres/store";
import { HeuristicCaseGenerator } from "../../sample/heuristic";
import { applyMigrationsViaAtlas } from "../../sql/__tests__/applyMigrationsViaAtlas";
import { setupPerTestDatabase } from "../../sql/__tests__/perTestDatabase";
import type { Database } from "../../sql/database";
import type { CaseStore } from "../../store";
import { writeFormCompletionThrough } from "../writeThrough";
import {
	type BuildBlueprintArgs,
	type BuiltBlueprint,
	buildFormBlueprint,
	completed,
	PATIENT_CASE_TYPE,
	VISIT_CASE_TYPE,
} from "./fixtures";

// ---------------------------------------------------------------
// Per-test database lifecycle
// ---------------------------------------------------------------
//
// Same pattern as `postgres/__tests__/store.test.ts`: the helper
// owns `CREATE DATABASE` + extension install; this file's
// `beforeEach` shells out to atlas to apply migrations.

const dbHandle = setupPerTestDatabase({
	databaseNamePrefix: "form_bridge_test_",
});

beforeEach(() => {
	applyMigrationsViaAtlas(dbHandle.uri, { stdio: "pipe" });
});

// ---------------------------------------------------------------
// Per-suite parameters
// ---------------------------------------------------------------
//
// `APP_ID` and `OWNER_ID` carry suite-unique values so a
// per-test-database isolation regression would surface against
// these recognizable namespaces in `pg_database` / `cases.app_id`
// rather than against a generic placeholder. The wrapper around
// the shared `buildBlueprint` injects `APP_ID` so each `it(...)`
// body reads as one call.

const APP_ID = "app-form-bridge-test";
const OWNER_ID = "owner-form-bridge-test";

function buildBlueprint(
	args: Omit<BuildBlueprintArgs, "appId">,
): BuiltBlueprint {
	return buildFormBlueprint({ appId: APP_ID, ...args });
}

/**
 * Construct a `CaseStore` against the per-test handle for one
 * test body. The factory mirrors the production pattern (sample
 * generator threaded through the constructor) without going
 * through `withOwnerContext` — tests bind the per-test Kysely
 * handle directly.
 */
function makeStore(): CaseStore {
	return new PostgresCaseStore({
		ownerId: OWNER_ID,
		db: dbHandle.db as unknown as Kysely<Database>,
		sampleGenerator: new HeuristicCaseGenerator(),
	});
}

/**
 * Seed the case-type schema row for `caseType` so subsequent
 * inserts have a JSON Schema to validate against. The form-bridge
 * itself does not seed schemas — the call to `applySchemaChange`
 * with no `change` runs the additive arm.
 */
async function seedSchema(
	store: CaseStore,
	blueprint: BlueprintDoc,
	caseType: string,
): Promise<void> {
	await store.applySchemaChange({
		appId: APP_ID,
		caseType,
		blueprint,
	});
}

// ---------------------------------------------------------------
// Survey
// ---------------------------------------------------------------

describe("writeFormCompletionThrough — survey forms", () => {
	it("returns the survey marker without writing to cases", async () => {
		const store = makeStore();
		const blueprint = buildBlueprint({
			formType: "survey",
			caseTypes: [PATIENT_CASE_TYPE],
			fields: [
				{
					id: "case_name",
					kind: "text",
					label: "Name",
					case_property_on: "patient",
				},
			],
		});

		const result = await writeFormCompletionThrough({
			caseStore: store,
			appId: APP_ID,
			blueprint: blueprint.blueprint,
			formUuid: blueprint.formUuid,
			formType: blueprint.formType,
			moduleCaseType: "patient",
			completedForm: completed([["/data/case_name", "Alice"]]),
		});

		expect(result).toEqual({ operation: "survey" });

		// No row landed for any case type.
		const rows = await store.query({ appId: APP_ID, caseType: "patient" });
		expect(rows).toHaveLength(0);
	});
});

// ---------------------------------------------------------------
// Registration
// ---------------------------------------------------------------

describe("writeFormCompletionThrough — registration forms", () => {
	it("inserts a primary case and threads its caseId to children", async () => {
		const store = makeStore();
		const blueprint = buildBlueprint({
			formType: "registration",
			moduleCaseType: "patient",
			caseTypes: [PATIENT_CASE_TYPE, VISIT_CASE_TYPE],
			fields: [
				{
					id: "case_name",
					kind: "text",
					label: "Name",
					case_property_on: "patient",
				},
				{
					id: "age",
					kind: "int",
					label: "Age",
					case_property_on: "patient",
				},
				// Visit fields nest inside a group so the visit's
				// `case_name` field has a unique path
				// (`/data/visit/case_name`) that doesn't collide with
				// the patient's `/data/case_name`. Real apps wrap
				// child-case property sets in a group / repeat for the
				// same reason — siblings under the same parent need
				// unique paths, and `case_name` is reserved at every
				// case-type's top level.
				{
					id: "visit",
					kind: "group",
					label: "Visit",
					children: [
						{
							id: "case_name",
							kind: "text",
							label: "Visit name",
							case_property_on: "visit",
						},
						{
							id: "notes",
							kind: "text",
							label: "Notes",
							case_property_on: "visit",
						},
					],
				},
			],
		});

		await seedSchema(store, blueprint.blueprint, "patient");
		await seedSchema(store, blueprint.blueprint, "visit");

		const result = await writeFormCompletionThrough({
			caseStore: store,
			appId: APP_ID,
			blueprint: blueprint.blueprint,
			formUuid: blueprint.formUuid,
			formType: blueprint.formType,
			moduleCaseType: "patient",
			completedForm: completed([
				["/data/case_name", "Alice"],
				["/data/age", "30"],
				["/data/visit/case_name", "Visit 1"],
				["/data/visit/notes", "First visit"],
			]),
		});

		expect(result.operation).toBe("registration");
		if (result.operation !== "registration") return;
		expect(result.caseId).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
		);
		expect(result.childCaseIds).toHaveLength(1);

		// Continuous validation principle: the running-app view
		// re-queries after the write completes; this test plays
		// the same role to verify the write landed.
		const patientRows = await store.query({
			appId: APP_ID,
			caseType: "patient",
		});
		expect(patientRows).toHaveLength(1);
		expect(patientRows[0]?.case_id).toBe(result.caseId);
		// `case_name` lands on the column, not in the JSONB document.
		expect(patientRows[0]?.case_name).toBe("Alice");
		expect(patientRows[0]?.properties).toEqual({ age: 30 });

		// The child case row exists under the visit case-type, and
		// its `parent_case_id` is the primary's generated id. The
		// visit's `case_name` lands on the column; only `notes` lives
		// in the JSONB document.
		const visitRows = await store.query({
			appId: APP_ID,
			caseType: "visit",
		});
		expect(visitRows).toHaveLength(1);
		expect(visitRows[0]?.parent_case_id).toBe(result.caseId);
		expect(visitRows[0]?.case_name).toBe("Visit 1");
		expect(visitRows[0]?.properties).toEqual({ notes: "First visit" });
	});

	it("inserts one child case per repeat instance", async () => {
		const store = makeStore();
		const blueprint = buildBlueprint({
			formType: "registration",
			moduleCaseType: "patient",
			caseTypes: [PATIENT_CASE_TYPE, VISIT_CASE_TYPE],
			fields: [
				{
					id: "case_name",
					kind: "text",
					label: "Name",
					case_property_on: "patient",
				},
				{
					id: "visits",
					kind: "repeat",
					label: "Visits",
					children: [
						// Each visit instance carries its own
						// `case_name` (the column is non-null at the DB
						// layer); the path-prefix `/data/visits[N]/`
						// keeps every iteration's name unique.
						{
							id: "case_name",
							kind: "text",
							label: "Visit name",
							case_property_on: "visit",
						},
						{
							id: "notes",
							kind: "text",
							label: "Notes",
							case_property_on: "visit",
						},
					],
				},
			],
		});

		await seedSchema(store, blueprint.blueprint, "patient");
		await seedSchema(store, blueprint.blueprint, "visit");

		const result = await writeFormCompletionThrough({
			caseStore: store,
			appId: APP_ID,
			blueprint: blueprint.blueprint,
			formUuid: blueprint.formUuid,
			formType: blueprint.formType,
			moduleCaseType: "patient",
			completedForm: completed([
				["/data/case_name", "Alice"],
				["/data/visits[0]/case_name", "Visit 1"],
				["/data/visits[0]/notes", "First note"],
				["/data/visits[1]/case_name", "Visit 2"],
				["/data/visits[1]/notes", "Second note"],
			]),
		});

		expect(result.operation).toBe("registration");
		if (result.operation !== "registration") return;
		expect(result.childCaseIds).toHaveLength(2);

		const visitRows = await store.query({
			appId: APP_ID,
			caseType: "visit",
		});
		expect(visitRows).toHaveLength(2);
		// Every visit row should point at the primary patient as its
		// parent — the writeThrough threads the generated id.
		for (const row of visitRows) {
			expect(row.parent_case_id).toBe(result.caseId);
		}
	});

	it("omits empty optional fields so the JSON Schema validator passes", async () => {
		// `FormEngine.getValueSnapshot()` drops empty-string entries
		// at the snapshot boundary (`lib/preview/engine/formEngine.ts:644`),
		// so a field the user never touched arrives at the form-
		// bridge as an absent path in the values map. Absent paths
		// translate to absent JSONB keys; the JSON Schema validator
		// passes (every property is optional). This test pins the
		// round-trip end-to-end: a registration form whose user
		// fills in only `case_name` against a case type with `int`,
		// `decimal`, `date`, and `geopoint` properties lands a row
		// whose JSONB document carries only `case_name` — none of
		// the typed-format ajv keywords (`integer` type, `number`
		// type, `format: date`, geopoint pattern) crash because no
		// value is being validated against them.
		const store = makeStore();
		const blueprint = buildBlueprint({
			formType: "registration",
			moduleCaseType: "patient",
			caseTypes: [
				{
					name: "patient",
					properties: [
						{ name: "case_name", label: "Name", data_type: "text" },
						{ name: "age", label: "Age", data_type: "int" },
						{ name: "weight", label: "Weight", data_type: "decimal" },
						{ name: "dob", label: "DOB", data_type: "date" },
						{
							name: "home_location",
							label: "Home",
							data_type: "geopoint",
						},
					],
				},
			],
			fields: [
				{
					id: "case_name",
					kind: "text",
					label: "Name",
					case_property_on: "patient",
				},
				{
					id: "age",
					kind: "int",
					label: "Age",
					case_property_on: "patient",
				},
				{
					id: "weight",
					kind: "decimal",
					label: "Weight",
					case_property_on: "patient",
				},
				{
					id: "dob",
					kind: "date",
					label: "DOB",
					case_property_on: "patient",
				},
				{
					id: "home_location",
					kind: "geopoint",
					label: "Home",
					case_property_on: "patient",
				},
			],
		});

		await seedSchema(store, blueprint.blueprint, "patient");

		const result = await writeFormCompletionThrough({
			caseStore: store,
			appId: APP_ID,
			blueprint: blueprint.blueprint,
			formUuid: blueprint.formUuid,
			formType: blueprint.formType,
			moduleCaseType: "patient",
			// Only the populated path lives in the values map —
			// matches the production shape after `getValueSnapshot()`.
			completedForm: completed([["/data/case_name", "Alice"]]),
		});

		expect(result.operation).toBe("registration");
		if (result.operation !== "registration") return;

		const rows = await store.query({ appId: APP_ID, caseType: "patient" });
		expect(rows).toHaveLength(1);
		// `case_name` lands on the column; the JSONB document is
		// empty because the only populated field is `case_name`. The
		// absent optional fields stay absent. A subsequent followup
		// form CAN write into any of them without conflict, and the
		// case-list filter compiler's `is-null` operator matches the
		// absent keys.
		expect(rows[0]?.case_name).toBe("Alice");
		expect(rows[0]?.properties).toEqual({});
	});
});

// ---------------------------------------------------------------
// Followup
// ---------------------------------------------------------------

describe("writeFormCompletionThrough — followup forms", () => {
	it("merges the form's properties into the bound case", async () => {
		const store = makeStore();
		const registrationBlueprint = buildBlueprint({
			formType: "registration",
			moduleCaseType: "patient",
			caseTypes: [PATIENT_CASE_TYPE],
			fields: [
				{
					id: "case_name",
					kind: "text",
					label: "Name",
					case_property_on: "patient",
				},
				{
					id: "age",
					kind: "int",
					label: "Age",
					case_property_on: "patient",
				},
			],
		});
		await seedSchema(store, registrationBlueprint.blueprint, "patient");

		// Create the case via a registration writeThrough so the
		// followup target exists. The registration path is exercised
		// in its own test; this is a setup step here.
		const registration = await writeFormCompletionThrough({
			caseStore: store,
			appId: APP_ID,
			blueprint: registrationBlueprint.blueprint,
			formUuid: registrationBlueprint.formUuid,
			formType: registrationBlueprint.formType,
			moduleCaseType: "patient",
			completedForm: completed([
				["/data/case_name", "Alice"],
				["/data/age", "30"],
			]),
		});
		if (registration.operation !== "registration") {
			throw new Error("registration setup failed");
		}

		// Followup form: bumps `age`. Same case-type — the followup
		// blueprint reuses the same case-type definitions but its
		// own form structure.
		const followupBlueprint = buildBlueprint({
			formType: "followup",
			moduleCaseType: "patient",
			caseTypes: [PATIENT_CASE_TYPE],
			fields: [
				{
					id: "age",
					kind: "int",
					label: "Age",
					case_property_on: "patient",
				},
			],
		});

		const result = await writeFormCompletionThrough({
			caseStore: store,
			appId: APP_ID,
			blueprint: followupBlueprint.blueprint,
			formUuid: followupBlueprint.formUuid,
			formType: followupBlueprint.formType,
			moduleCaseType: "patient",
			completedForm: completed([["/data/age", "31"]], registration.caseId),
		});

		expect(result.operation).toBe("followup");
		if (result.operation !== "followup") return;
		expect(result.caseId).toBe(registration.caseId);

		// The bound case carries the merged JSONB properties (only
		// `age` lives in the document; `case_name` is on the column
		// and the followup didn't touch it).
		const rows = await store.query({ appId: APP_ID, caseType: "patient" });
		const row = rows.find((r) => r.case_id === registration.caseId);
		expect(row?.case_name).toBe("Alice");
		expect(row?.properties).toEqual({ age: 31 });
	});

	it("inserts child cases pointed at the bound caseId", async () => {
		const store = makeStore();
		const blueprint = buildBlueprint({
			formType: "registration",
			moduleCaseType: "patient",
			caseTypes: [PATIENT_CASE_TYPE, VISIT_CASE_TYPE],
			fields: [
				{
					id: "case_name",
					kind: "text",
					label: "Name",
					case_property_on: "patient",
				},
			],
		});
		await seedSchema(store, blueprint.blueprint, "patient");
		await seedSchema(store, blueprint.blueprint, "visit");

		const registration = await writeFormCompletionThrough({
			caseStore: store,
			appId: APP_ID,
			blueprint: blueprint.blueprint,
			formUuid: blueprint.formUuid,
			formType: "registration",
			moduleCaseType: "patient",
			completedForm: completed([["/data/case_name", "Alice"]]),
		});
		if (registration.operation !== "registration") {
			throw new Error("registration setup failed");
		}

		// A followup form on the patient module that emits a visit
		// child case. The form has only visit-bound fields — no
		// primary writes — so the writeThrough's update short-circuits.
		const followupBlueprint = buildBlueprint({
			formType: "followup",
			moduleCaseType: "patient",
			caseTypes: [PATIENT_CASE_TYPE, VISIT_CASE_TYPE],
			fields: [
				{
					id: "case_name",
					kind: "text",
					label: "Visit name",
					case_property_on: "visit",
				},
				{
					id: "notes",
					kind: "text",
					label: "Notes",
					case_property_on: "visit",
				},
			],
		});

		const result = await writeFormCompletionThrough({
			caseStore: store,
			appId: APP_ID,
			blueprint: followupBlueprint.blueprint,
			formUuid: followupBlueprint.formUuid,
			formType: "followup",
			moduleCaseType: "patient",
			completedForm: completed(
				[
					["/data/case_name", "Visit 1"],
					["/data/notes", "Follow-up note"],
				],
				registration.caseId,
			),
		});

		expect(result.operation).toBe("followup");
		if (result.operation !== "followup") return;
		expect(result.childCaseIds).toHaveLength(1);

		const visitRows = await store.query({
			appId: APP_ID,
			caseType: "visit",
		});
		expect(visitRows).toHaveLength(1);
		expect(visitRows[0]?.parent_case_id).toBe(registration.caseId);
		expect(visitRows[0]?.case_name).toBe("Visit 1");
		expect(visitRows[0]?.properties).toEqual({ notes: "Follow-up note" });
	});
});

// ---------------------------------------------------------------
// Close
// ---------------------------------------------------------------

describe("writeFormCompletionThrough — close forms", () => {
	it("applies any property writes and stamps closed_on", async () => {
		const store = makeStore();
		const registrationBlueprint = buildBlueprint({
			formType: "registration",
			moduleCaseType: "patient",
			caseTypes: [PATIENT_CASE_TYPE],
			fields: [
				{
					id: "case_name",
					kind: "text",
					label: "Name",
					case_property_on: "patient",
				},
			],
		});
		await seedSchema(store, registrationBlueprint.blueprint, "patient");

		const registration = await writeFormCompletionThrough({
			caseStore: store,
			appId: APP_ID,
			blueprint: registrationBlueprint.blueprint,
			formUuid: registrationBlueprint.formUuid,
			formType: "registration",
			moduleCaseType: "patient",
			completedForm: completed([["/data/case_name", "Alice"]]),
		});
		if (registration.operation !== "registration") {
			throw new Error("registration setup failed");
		}

		// Close form with a property write (final age) and the
		// bound caseId.
		const closeBlueprint = buildBlueprint({
			formType: "close",
			moduleCaseType: "patient",
			caseTypes: [PATIENT_CASE_TYPE],
			fields: [
				{
					id: "age",
					kind: "int",
					label: "Final age",
					case_property_on: "patient",
				},
			],
		});

		const result = await writeFormCompletionThrough({
			caseStore: store,
			appId: APP_ID,
			blueprint: closeBlueprint.blueprint,
			formUuid: closeBlueprint.formUuid,
			formType: "close",
			moduleCaseType: "patient",
			completedForm: completed([["/data/age", "45"]], registration.caseId),
		});

		expect(result.operation).toBe("close");
		if (result.operation !== "close") return;

		// The row carries the merged JSONB properties (`age` only)
		// plus the column-level `case_name` and a closed_on stamp.
		const rows = await store.query({ appId: APP_ID, caseType: "patient" });
		const row = rows.find((r) => r.case_id === registration.caseId);
		expect(row).toBeDefined();
		expect(row?.case_name).toBe("Alice");
		expect(row?.properties).toEqual({ age: 45 });
		expect(row?.closed_on).toBeInstanceOf(Date);
	});

	it("stamps closed_on without an update when the form has no primary writes", async () => {
		const store = makeStore();
		const registrationBlueprint = buildBlueprint({
			formType: "registration",
			moduleCaseType: "patient",
			caseTypes: [PATIENT_CASE_TYPE],
			fields: [
				{
					id: "case_name",
					kind: "text",
					label: "Name",
					case_property_on: "patient",
				},
			],
		});
		await seedSchema(store, registrationBlueprint.blueprint, "patient");

		const registration = await writeFormCompletionThrough({
			caseStore: store,
			appId: APP_ID,
			blueprint: registrationBlueprint.blueprint,
			formUuid: registrationBlueprint.formUuid,
			formType: "registration",
			moduleCaseType: "patient",
			completedForm: completed([["/data/case_name", "Alice"]]),
		});
		if (registration.operation !== "registration") {
			throw new Error("registration setup failed");
		}

		// Close form with no fields — pure closure action.
		const closeBlueprint = buildBlueprint({
			formType: "close",
			moduleCaseType: "patient",
			caseTypes: [PATIENT_CASE_TYPE],
			fields: [],
		});

		const result = await writeFormCompletionThrough({
			caseStore: store,
			appId: APP_ID,
			blueprint: closeBlueprint.blueprint,
			formUuid: closeBlueprint.formUuid,
			formType: "close",
			moduleCaseType: "patient",
			completedForm: completed([], registration.caseId),
		});

		expect(result.operation).toBe("close");

		const rows = await store.query({ appId: APP_ID, caseType: "patient" });
		const row = rows.find((r) => r.case_id === registration.caseId);
		// Properties + case_name unchanged; closed_on stamped.
		expect(row?.case_name).toBe("Alice");
		expect(row?.properties).toEqual({});
		expect(row?.closed_on).toBeInstanceOf(Date);
	});
});
