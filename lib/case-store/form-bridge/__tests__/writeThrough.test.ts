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
import type {
	BlueprintDoc,
	CaseType,
	Field,
	FieldKind,
	Form,
	FormType,
	Uuid,
} from "@/lib/domain";
import { asUuid } from "@/lib/domain";
import { PostgresCaseStore } from "../../postgres/store";
import { HeuristicCaseGenerator } from "../../sample/heuristic";
import { applyMigrationsViaAtlas } from "../../sql/__tests__/applyMigrationsViaAtlas";
import { setupPerTestDatabase } from "../../sql/__tests__/perTestDatabase";
import type { Database } from "../../sql/database";
import type { CaseStore } from "../../store";
import type { CompletedForm, DerivedProperties } from "../deriveFromForm";
import { writeFormCompletionThrough } from "../writeThrough";

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
// Test fixtures
// ---------------------------------------------------------------

const APP_ID = "app-form-bridge-test";
const OWNER_ID = "owner-form-bridge-test";
const FORM_UUID = asUuid("test-form-uuid");
const MODULE_UUID = asUuid("test-module-uuid");

const PATIENT_CASE_TYPE: CaseType = {
	name: "patient",
	properties: [
		{ name: "case_name", label: "Name", data_type: "text" },
		{ name: "age", label: "Age", data_type: "int" },
	],
};

const VISIT_CASE_TYPE: CaseType = {
	name: "visit",
	parent_type: "patient",
	properties: [
		{ name: "case_name", label: "Visit", data_type: "text" },
		{ name: "notes", label: "Notes", data_type: "text" },
	],
};

interface DField {
	id: string;
	kind: FieldKind;
	label?: string;
	case_property_on?: string;
	children?: DField[];
}

interface BuildBlueprintArgs {
	formType: FormType;
	moduleCaseType?: string;
	caseTypes: ReadonlyArray<CaseType>;
	fields: ReadonlyArray<DField>;
}

interface BuiltBlueprint {
	blueprint: BlueprintDoc;
	formUuid: Uuid;
	formType: FormType;
}

/**
 * Build a single-form blueprint for the integration tests. Same
 * shape as the deriveFromForm pure-test fixture; replicated here
 * (rather than imported) to keep the integration suite self-
 * contained — the unit-test fixture is a per-call helper, not a
 * stable export, and re-fixturing is cheap.
 */
function buildBlueprint(args: BuildBlueprintArgs): BuiltBlueprint {
	const form: Form = {
		uuid: FORM_UUID,
		id: "test-form",
		name: "Test Form",
		type: args.formType,
	};
	const fields: Record<string, Field> = {};
	const fieldOrder: Record<string, Uuid[]> = {};
	const fieldParent: Record<string, Uuid | null> = {};

	const walk = (nodes: ReadonlyArray<DField>, parentUuid: Uuid): Uuid[] => {
		const order: Uuid[] = [];
		for (const node of nodes) {
			const uuid = asUuid(`${parentUuid}.${node.id}`);
			order.push(uuid);
			fieldParent[uuid] = parentUuid;
			const { children, ...rest } = node;
			fields[uuid] = { uuid, ...rest } as Field;
			if (node.kind === "group" || node.kind === "repeat") {
				fieldOrder[uuid] = walk(children ?? [], uuid);
			}
		}
		return order;
	};

	fieldOrder[FORM_UUID] = walk(args.fields, FORM_UUID);

	return {
		blueprint: {
			appId: APP_ID,
			appName: "test-app",
			connectType: null,
			caseTypes: [...args.caseTypes],
			modules: {
				[MODULE_UUID]: {
					uuid: MODULE_UUID,
					id: "test-module",
					name: "Test Module",
					...(args.moduleCaseType !== undefined
						? { caseType: args.moduleCaseType }
						: {}),
				},
			},
			forms: { [FORM_UUID]: form },
			fields,
			moduleOrder: [MODULE_UUID],
			formOrder: { [MODULE_UUID]: [FORM_UUID] },
			fieldOrder,
			fieldParent,
		},
		formUuid: FORM_UUID,
		formType: args.formType,
	};
}

function completed(
	values: ReadonlyArray<[string, string]>,
	caseId?: string,
): CompletedForm {
	return {
		values: new Map(values),
		...(caseId !== undefined ? { caseId } : {}),
	};
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

/**
 * Read the typed `properties` JSONB document for one case row,
 * widened to `DerivedProperties` for assertions.
 */
async function readProperties(
	store: CaseStore,
	caseType: string,
	caseId: string,
): Promise<DerivedProperties | undefined> {
	const rows = await store.query({ appId: APP_ID, caseType });
	const row = rows.find((r) => r.case_id === caseId);
	return row?.properties as DerivedProperties | undefined;
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
				{
					id: "notes",
					kind: "text",
					label: "Notes",
					case_property_on: "visit",
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
				["/data/notes", "First visit"],
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
		expect(patientRows[0]?.properties).toEqual({
			case_name: "Alice",
			age: 30,
		});

		// The child case row exists under the visit case-type, and
		// its `parent_case_id` is the primary's generated id.
		const visitRows = await store.query({
			appId: APP_ID,
			caseType: "visit",
		});
		expect(visitRows).toHaveLength(1);
		expect(visitRows[0]?.parent_case_id).toBe(result.caseId);
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
				["/data/visits[0]/notes", "First note"],
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
		// Empty raw values have to translate to absent JSONB keys,
		// not to `null` or to `""`. ajv with `format: date` (and the
		// geopoint pattern, and the `integer` / `number` types) all
		// reject `null` AND empty-string values; the only shape that
		// validates AND aligns with Postgres-strict `is-null` /
		// `is-blank` semantics is to omit the property entirely.
		// This test pins the round-trip end-to-end: a registration
		// form whose user fills in only `case_name` lands a row whose
		// JSONB document carries only `case_name` — the validator
		// accepts it, and the empty optional fields don't crash on
		// any ajv keyword.
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
			completedForm: completed([
				["/data/case_name", "Alice"],
				// Every other field left blank — the engine seeds
				// these with empty strings on form init.
				["/data/age", ""],
				["/data/weight", ""],
				["/data/dob", ""],
				["/data/home_location", ""],
			]),
		});

		expect(result.operation).toBe("registration");
		if (result.operation !== "registration") return;

		const rows = await store.query({ appId: APP_ID, caseType: "patient" });
		expect(rows).toHaveLength(1);
		// Only the non-empty `case_name` made it into the JSONB
		// document; the empty optional fields are absent. A
		// subsequent followup form CAN write into any of them
		// without conflict, and the case-list filter compiler's
		// `is-null` operator matches the absent keys.
		expect(rows[0]?.properties).toEqual({ case_name: "Alice" });
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

		// The bound case now carries the merged properties: case_name
		// retained from registration, age bumped by the followup.
		const properties = await readProperties(
			store,
			"patient",
			registration.caseId,
		);
		expect(properties).toEqual({ case_name: "Alice", age: 31 });
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
		// child case. The form has only the visit-bound field — no
		// primary writes — so the writeThrough's update short-circuits.
		const followupBlueprint = buildBlueprint({
			formType: "followup",
			moduleCaseType: "patient",
			caseTypes: [PATIENT_CASE_TYPE, VISIT_CASE_TYPE],
			fields: [
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
				[["/data/notes", "Follow-up note"]],
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

		// The row carries the merged properties + a closed_on stamp.
		const rows = await store.query({ appId: APP_ID, caseType: "patient" });
		const row = rows.find((r) => r.case_id === registration.caseId);
		expect(row).toBeDefined();
		expect(row?.properties).toEqual({ case_name: "Alice", age: 45 });
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
		// Properties unchanged; closed_on stamped.
		expect(row?.properties).toEqual({ case_name: "Alice" });
		expect(row?.closed_on).toBeInstanceOf(Date);
	});
});
