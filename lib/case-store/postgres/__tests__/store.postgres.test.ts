// lib/case-store/postgres/__tests__/store.postgres.test.ts
//
// Concrete contract-test runner for `PostgresCaseStore`. Wires the
// implementation-agnostic harness from
// `lib/case-store/__tests__/storeContract.ts` to the real
// implementation, executing every test against a per-test isolated
// Postgres database from `setupPerTestDatabase`.
//
// ## Why per-test databases instead of the harness's BEGIN/ROLLBACK
//
// The standard fixture in `lib/case-store/sql/__tests__/setup.ts`
// wraps every test in an outer BEGIN, runs the test against a
// shared transaction, and ROLLBACKs on cleanup. That fixture is
// incompatible with `PostgresCaseStore.insert` / `update` /
// `applySchemaChange` — each method calls `db.transaction()`,
// which Kysely's PostgresDriver lowers to a literal `BEGIN`
// statement. Postgres rejects nested BEGIN inside an outer
// transaction with `WARNING: there is already a transaction in
// progress` and the inner SQL leaks into the outer transaction's
// state, corrupting per-test isolation.
//
// Each test clones the production-migrated template. Real COMMIT and DDL
// behavior stays intact without replaying extensions and migrations per case.

import { Kysely, PostgresDialect, type PostgresPool } from "kysely";
import { Client, Pool } from "pg";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { withTransientRetry } from "@/lib/db/schemaSyncRetry";
import type { BlueprintDoc, CaseType } from "@/lib/domain";
import { eq, literal, prop } from "@/lib/domain/expression/builders";
import { caseTypeToJsonSchema } from "@/lib/domain/expression/jsonSchema";
import { SEARCH_READING } from "@/lib/domain/expression/temporalType";
import { proseText } from "@/lib/domain/prose";
import { buildSimpleBlueprint } from "../../__tests__/fixtures/simpleBlueprint";
import { runStoreContract } from "../../__tests__/storeContract";
import { CaseNotFoundError, CasePropertiesValidationError } from "../../errors";
import { HeuristicCaseGenerator } from "../../sample/heuristic";
import { setupPerTestDatabase } from "../../sql/__tests__/perTestDatabase";
import type { Database } from "../../sql/database";
import { buildCaseTypeMap } from "../../store";
import { caseSchemaIndexLockScope } from "../indexIdentity";
import { PostgresCaseStore } from "../store";

// ---------------------------------------------------------------
// Per-test database lifecycle
// ---------------------------------------------------------------
//
const dbHandle = setupPerTestDatabase({
	schema: "migrated",
	databaseNamePrefix: "store_test_",
});

// Seed only the rows this contract needs; the fixture supplies the schema.
beforeEach(async () => {
	await dbHandle.pool.query(`
		INSERT INTO apps (id, owner, project_id, app_name, app_name_lower)
		VALUES
			('app-contract', 'user-a', 'project-a', 'Contract', 'contract'),
			('app-index-ddl', 'owner-a', 'owner-a', 'Index DDL', 'index ddl'),
			('app-explain', 'owner-a', 'owner-a', 'Explain', 'explain'),
			('app-cross-a', 'owner-a', 'owner-a', 'Cross A', 'cross a'),
			('app-cross-b', 'owner-a', 'owner-a', 'Cross B', 'cross b'),
			('app-synced-seq', 'app-synced-seq', 'app-synced-seq',
			 'Synced sequence', 'synced sequence')
	`);
});

// ---------------------------------------------------------------
// Wire the contract harness to PostgresCaseStore
// ---------------------------------------------------------------
//
// The harness consumes a factory that constructs a `CaseStore`
// for a supplied tenant binding (Project + actor). Bypassing
// `withProjectContext` lets tests bind against the per-test handle
// rather than the production singleton — the factory is
// production-only by design.
//
// `dbHandle.db` is `Kysely<unknown>`; the store constructor
// wants `Kysely<Database>`. The cast is type-only — the runtime
// shape after the migrations apply matches `Database` exactly.

runStoreContract({
	describeName: "PostgresCaseStore",
	factory: async (tenant) => {
		return new PostgresCaseStore({
			projectId: tenant.projectId,
			actorUserId: tenant.actorUserId,
			ownerId: tenant.actorUserId,
			db: dbHandle.db as unknown as Kysely<Database>,
			sampleGenerator: new HeuristicCaseGenerator(),
		});
	},
});

const APP_ID = "app-index-ddl";
const OWNER_A = "owner-a";
const OWNER_B = "owner-b";

/** The final store never creates property expression indexes. */
async function readCaseExpressionIndexes(
	pool: import("pg").Pool,
): Promise<{ name: string; def: string }[]> {
	const result = await pool.query<{ name: string; def: string }>(
		"SELECT c.relname AS name,pg_get_indexdef(c.oid) AS def FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid WHERE i.indrelid='cases'::regclass AND i.indexprs IS NOT NULL ORDER BY c.relname",
	);
	return result.rows;
}

/**
 * Build a `BlueprintDoc` whose only case type is the supplied one.
 * Wraps `buildSimpleBlueprint` with the test suite's fixed app id
 * so callers state only the case type they're exercising.
 */
function buildBlueprint(caseType: CaseType): BlueprintDoc {
	return buildSimpleBlueprint([caseType], APP_ID);
}

/**
 * Build the schema map `applySchemaChange` accepts directly. Pure
 * sugar over `buildCaseTypeMap(buildBlueprint(...))` — every test in
 * this file converts a one-case-type fixture into the map shape, so
 * the helper keeps the call sites to one line each.
 */
function buildSchemaMap(caseType: CaseType): ReadonlyMap<string, CaseType> {
	return buildCaseTypeMap(buildBlueprint(caseType));
}

/**
 * Construct a `PostgresCaseStore` for the supplied Project against the
 * per-test database. `actorUserId` (the `owner_id` stamped on inserts)
 * defaults to the Project id — these store tests are app-scoped and
 * don't exercise the actor axis. Keeping this in one helper keeps every
 * test below to a single line of setup before the meaningful
 * assertions.
 */
function makeStore(
	projectId: string,
	actorUserId: string = projectId,
): PostgresCaseStore {
	return new PostgresCaseStore({
		projectId,
		actorUserId,
		ownerId: actorUserId,
		db: dbHandle.db as unknown as Kysely<Database>,
		sampleGenerator: new HeuristicCaseGenerator(),
	});
}

describe("PostgresCaseStore selected-parent sets", () => {
	it("returns the union of direct children only after validating the complete parent set", async () => {
		const store = makeStore(OWNER_A);
		const caseTypes: CaseType[] = [
			{ name: "household", properties: [] },
			{ name: "visit", parent_type: "household", properties: [] },
		];
		const caseTypeSchemas = buildCaseTypeMap(
			buildSimpleBlueprint(caseTypes, APP_ID),
		);
		for (const caseType of caseTypes) {
			await store.applySchemaChange({
				appId: APP_ID,
				caseType: caseType.name,
				caseTypeSchemas,
			});
		}
		for (const parentId of ["household-a", "household-b"] as const) {
			await store.insert({
				appId: APP_ID,
				row: {
					case_id: parentId,
					case_type: "household",
					case_name: parentId,
					properties: {},
				},
			});
		}
		for (const [caseId, parentCaseId] of [
			["visit-a", "household-a"],
			["visit-b", "household-b"],
		] as const) {
			await store.insert({
				appId: APP_ID,
				parentRelationship: "child",
				row: {
					case_id: caseId,
					case_type: "visit",
					case_name: caseId,
					parent_case_id: parentCaseId,
					properties: {},
				},
			});
		}

		const parentCases = {
			caseType: "household",
			caseIds: ["household-b", "household-a"],
		} as const;
		expect(
			(
				await store.query({
					reading: SEARCH_READING,
					appId: APP_ID,
					caseType: "visit",
					parentCases,
				})
			)
				.map((row) => row.case_id)
				.sort(),
		).toEqual(["visit-a", "visit-b"]);
		expect(
			await store.count({
				reading: SEARCH_READING,
				appId: APP_ID,
				caseType: "visit",
				parentCases,
			}),
		).toBe(2);

		for (const invalidParentCases of [
			{ caseType: "visit", caseIds: ["household-a"] },
			{
				caseType: "household",
				caseIds: ["household-a", "missing-household"],
			},
		] as const) {
			expect(
				await store.query({
					reading: SEARCH_READING,
					appId: APP_ID,
					caseType: "visit",
					parentCases: invalidParentCases,
				}),
			).toEqual([]);
		}
	});
});

describe("PostgresCaseStore.readDeviceCaseDatabase", () => {
	it("returns every direct parent and custom edge with ancestor metadata", async () => {
		const store = makeStore(OWNER_A);
		const caseTypes: CaseType[] = [
			{ name: "household", properties: [] },
			{ name: "host", properties: [] },
			{
				name: "patient",
				properties: [
					{
						name: "score",
						label: proseText("Score"),
						data_type: "decimal",
					},
				],
			},
		];
		const caseTypeSchemas = buildCaseTypeMap(
			buildSimpleBlueprint(caseTypes, APP_ID),
		);
		for (const caseType of caseTypes) {
			await store.applySchemaChange({
				appId: APP_ID,
				caseType: caseType.name,
				caseTypeSchemas,
			});
		}
		for (const [caseId, caseType] of [
			["household-1", "household"],
			["host-1", "host"],
		] as const) {
			await store.insert({
				appId: APP_ID,
				row: {
					case_id: caseId,
					case_type: caseType,
					case_name: caseId,
					properties: {},
				},
			});
		}
		await store.insert({
			appId: APP_ID,
			row: {
				case_id: "patient-1",
				case_type: "patient",
				case_name: "Patient",
				parent_case_id: "household-1",
				properties: {},
			},
			parentRelationship: "child",
		});
		await (dbHandle.db as unknown as Kysely<Database>)
			.insertInto("case_indices")
			.values({
				case_id: "patient-1",
				ancestor_id: "host-1",
				target_case_type: "host",
				identifier: "host_case",
				relationship: "extension",
				depth: 1,
			})
			.execute();
		// Core's CaseIndex keeps the type captured on the edge. A later target
		// retype must not rewrite what casedb exposes on @case_type.
		await (dbHandle.db as unknown as Kysely<Database>)
			.updateTable("cases")
			.set({ case_type: "renamed-host" })
			.where("case_id", "=", "host-1")
			.execute();

		const snapshot = await store.readDeviceCaseDatabase({
			appId: APP_ID,
			restoreScope: { ownerIds: [OWNER_A] },
		});
		expect(snapshot.rows.map((row) => row.case_id).sort()).toEqual([
			"host-1",
			"household-1",
			"patient-1",
		]);
		expect(snapshot.indices).toEqual([
			{
				case_id: "patient-1",
				ancestor_id: "host-1",
				identifier: "host_case",
				relationship: "extension",
				depth: 1,
				target_case_type: "host",
			},
			{
				case_id: "patient-1",
				ancestor_id: "household-1",
				identifier: "parent",
				relationship: "child",
				depth: 1,
				target_case_type: "household",
			},
		]);
		expect(snapshot.propertyTypes).toEqual({
			household: {},
			patient: { score: "decimal" },
		});
	});

	it("reads a committed closed or reassigned row that a fresh restore omits", async () => {
		const store = makeStore(OWNER_A);
		const patient: CaseType = { name: "patient", properties: [] };
		await store.applySchemaChange({
			appId: APP_ID,
			caseType: patient.name,
			caseTypeSchemas: buildSchemaMap(patient),
		});
		await store.insert({
			appId: APP_ID,
			row: {
				case_id: "landed-case",
				case_type: "patient",
				case_name: "Landed case",
				properties: {},
			},
		});
		await (dbHandle.db as unknown as Kysely<Database>)
			.updateTable("cases")
			.set({ owner_id: OWNER_B, status: "closed", closed_on: new Date() })
			.where("app_id", "=", APP_ID)
			.where("project_id", "=", OWNER_A)
			.where("case_id", "=", "landed-case")
			.execute();

		const restore = await store.readDeviceCaseDatabase({
			appId: APP_ID,
			restoreScope: { ownerIds: [OWNER_A] },
		});
		expect(restore.rows).toEqual([]);
		const patch = await store.readCaseDatabasePatch({
			appId: APP_ID,
			caseIds: ["landed-case"],
		});
		expect(patch.rows).toHaveLength(1);
		expect(patch.rows[0]).toMatchObject({
			case_id: "landed-case",
			owner_id: OWNER_B,
			status: "closed",
			properties: {},
		});
	});
});

describe("PostgresCaseStore — standalone schema authorization fence", () => {
	it("runs before apply, drop, and parked-value restore work in each transaction", async () => {
		const observed: Array<{ appId: string; schemaPresent: boolean }> = [];
		const store = new PostgresCaseStore({
			projectId: null,
			actorUserId: null,
			ownerId: null,
			db: dbHandle.db as unknown as Kysely<Database>,
			sampleGenerator: new HeuristicCaseGenerator(),
			authorizeSchemaMutation: async (tx, args) => {
				const schema = await tx
					.selectFrom("case_type_schemas")
					.select("app_id")
					.where("app_id", "=", args.appId)
					.where("case_type", "=", "household")
					.executeTakeFirst();
				observed.push({
					appId: args.appId,
					schemaPresent: schema !== undefined,
				});
			},
		});
		const caseType: CaseType = { name: "household", properties: [] };

		await store.applySchemaChange({
			appId: APP_ID,
			caseType: caseType.name,
			caseTypeSchemas: buildSchemaMap(caseType),
		});
		await store.purgeSchemaForMaintenance({
			appId: APP_ID,
			caseType: caseType.name,
		});
		await store.unparkValues({
			appId: APP_ID,
			ids: [crypto.randomUUID()],
		});

		expect(observed).toEqual([
			{ appId: APP_ID, schemaPresent: false },
			{ appId: APP_ID, schemaPresent: true },
			{ appId: APP_ID, schemaPresent: false },
		]);
	});
});

describe("PostgresCaseStore — atomic case schema changes", () => {
	// -----------------------------------------------------------
	// Property-by-data-type — the per-arm DDL shape verifications
	// -----------------------------------------------------------

	// -----------------------------------------------------------
	// Diff shapes — the verb-by-verb mutation paths
	// -----------------------------------------------------------

	it("keeps explicit canonical scalars in the catalog while excluding them from JSONB schema and indexes", async () => {
		const store = makeStore(OWNER_A);
		const caseType: CaseType = {
			name: "patient",
			properties: [
				{
					name: "external_id",
					label: proseText("External ID"),
					data_type: "text",
				},
				{
					name: "status",
					label: proseText("Status"),
					data_type: "text",
				},
			],
		};
		const caseTypeSchemas = buildSchemaMap(caseType);
		expect(
			caseTypeSchemas.get("patient")?.properties.map((p) => p.name),
		).toEqual(["external_id", "status"]);

		await store.applySchemaChange({
			appId: APP_ID,
			caseType: "patient",
			caseTypeSchemas,
		});

		const stored = await dbHandle.pool.query<{
			schema: { properties: Record<string, unknown> };
		}>(
			"SELECT schema FROM case_type_schemas WHERE app_id = $1 AND case_type = $2",
			[APP_ID, "patient"],
		);
		expect(stored.rows[0]?.schema.properties).toEqual({});
		expect(await readCaseExpressionIndexes(dbHandle.pool)).toEqual([]);

		await store.insert({
			appId: APP_ID,
			row: {
				case_type: "patient",
				case_name: "\u0000 Patient \u001f",
				external_id: "\u001f PX-1 \u0000",
				status: "open",
				properties: {},
			},
		});

		const byExternalId = await store.query({
			reading: SEARCH_READING,
			appId: APP_ID,
			caseType: "patient",
			caseTypeSchemas,
			predicate: eq(prop("patient", "external_id"), literal("PX-1")),
		});
		expect(byExternalId).toHaveLength(1);
		expect(byExternalId[0]).toMatchObject({
			case_name: "Patient",
			external_id: "PX-1",
			status: "open",
			properties: {},
		});
		const caseId = byExternalId[0]?.case_id;
		if (caseId === undefined) throw new Error("inserted scalar row is missing");
		await store.update({
			appId: APP_ID,
			caseId,
			patch: {
				case_name: "\u001f Renamed \u0000",
				external_id: "\t\r\n",
			},
		});
		expect(
			(
				await store.query({
					reading: SEARCH_READING,
					appId: APP_ID,
					caseType: "patient",
				})
			).find((row) => row.case_id === caseId),
		).toMatchObject({
			case_name: "Renamed",
			external_id: "",
			properties: {},
		});
		const byStatus = await store.query({
			reading: SEARCH_READING,
			appId: APP_ID,
			caseType: "patient",
			caseTypeSchemas,
			predicate: eq(prop("patient", "status"), literal("open")),
		});
		expect(byStatus).toHaveLength(1);

		expect(
			await store.generateSampleData({
				appId: APP_ID,
				caseType,
				count: 2,
				seed: "explicit-standard-scalars",
			}),
		).toEqual({ inserted: 2 });
		const withSamples = await store.query({
			reading: SEARCH_READING,
			appId: APP_ID,
			caseType: "patient",
		});
		expect(withSamples).toHaveLength(3);
		expect(
			withSamples.every(
				(row) =>
					row.status === "open" &&
					row.external_id !== null &&
					Object.keys(row.properties).length === 0,
			),
		).toBe(true);
	});

	it("int to decimal retyping admits fractional values without schema-specific indexes", async () => {
		const store = makeStore(OWNER_A);
		const initial: CaseType = {
			name: "patient",
			properties: [
				{ name: "weight", label: proseText("Weight"), data_type: "int" },
			],
		};
		await store.applySchemaChange({
			appId: APP_ID,
			caseType: "patient",
			caseTypeSchemas: buildSchemaMap(initial),
		});
		const before = await readCaseExpressionIndexes(dbHandle.pool);
		expect(before).toEqual([]);

		const retyped: CaseType = {
			name: "patient",
			properties: [
				{ name: "weight", label: proseText("Weight"), data_type: "decimal" },
			],
		};
		await store.applySchemaChange({
			appId: APP_ID,
			caseType: "patient",
			caseTypeSchemas: buildSchemaMap(retyped),
			property: "weight",
			change: { kind: "retype", fromType: "int", toType: "decimal" },
		});

		const after = await readCaseExpressionIndexes(dbHandle.pool);
		expect(after).toEqual([]);

		const { caseId } = await store.insert({
			appId: APP_ID,
			row: {
				case_id: "40000000-0000-0000-0000-000000000001",
				case_type: "patient",
				case_name: "fractional-case",
				properties: { weight: 17.01 },
			},
		});
		expect(caseId).toBe("40000000-0000-0000-0000-000000000001");

		// The fractional value round-trips through the JSONB document unchanged.
		const rows = await store.query({
			reading: SEARCH_READING,
			appId: APP_ID,
			caseType: "patient",
		});
		expect(rows).toHaveLength(1);
		expect(rows[0]?.properties.weight).toBe(17.01);
	});

	it("retyping parks incompatible values and commits the new schema", async () => {
		const store = makeStore(OWNER_A);
		const initial: CaseType = {
			name: "patient",
			properties: [{ name: "age", label: proseText("Age"), data_type: "text" }],
		};
		await store.applySchemaChange({
			appId: APP_ID,
			caseType: "patient",
			caseTypeSchemas: buildSchemaMap(initial),
		});

		// Both values satisfy the initial text schema, but only one can be
		// retained as an integer when the schema changes.
		await store.insert({
			appId: APP_ID,
			row: {
				case_id: "30000000-0000-0000-0000-000000000001",
				case_type: "patient",
				case_name: "test-case",
				properties: { age: "30" },
			},
		});
		await store.insert({
			appId: APP_ID,
			row: {
				case_id: "30000000-0000-0000-0000-000000000002",
				case_type: "patient",
				case_name: "test-case",
				properties: { age: "abc" },
			},
		});

		const retyped: CaseType = {
			name: "patient",
			properties: [{ name: "age", label: proseText("Age"), data_type: "int" }],
		};
		const report = await store.applySchemaChange({
			appId: APP_ID,
			caseType: "patient",
			caseTypeSchemas: buildSchemaMap(retyped),
			property: "age",
			change: { kind: "retype", fromType: "text", toType: "int" },
		});
		// Both rows rewrite: Alice's "30" → 30 in place; Bob's "abc"
		// can't cast, so his value parks and the key drops.
		expect(report.migrated).toBe(2);
		expect(report.parkedIds).toHaveLength(1);

		const indexes = await readCaseExpressionIndexes(dbHandle.pool);
		expect(indexes).toEqual([]);
	});

	it("on multi_select→text retype: array values join space-separated (the XForms wire convention)", async () => {
		// A multi-select property's stored value is a JSONB array of
		// selected option values; its string projection is the XForms
		// space-separated convention, NOT JS's default comma join —
		// `["en","fr"]` must land as `"en fr"`.
		const store = makeStore(OWNER_A);
		const initial: CaseType = {
			name: "patient",
			properties: [
				{
					name: "languages",
					label: proseText("Languages"),
					data_type: "multi_select",
					options: [
						{ value: "en", label: proseText("English") },
						{ value: "fr", label: proseText("French") },
					],
				},
			],
		};
		await store.applySchemaChange({
			appId: APP_ID,
			caseType: "patient",
			caseTypeSchemas: buildSchemaMap(initial),
		});
		await store.insert({
			appId: APP_ID,
			row: {
				case_id: "31000000-0000-0000-0000-000000000001",
				case_type: "patient",
				case_name: "test-case",
				properties: { languages: ["en", "fr"] },
			},
		});

		const retyped: CaseType = {
			name: "patient",
			properties: [
				{ name: "languages", label: proseText("Languages"), data_type: "text" },
			],
		};
		const report = await store.applySchemaChange({
			appId: APP_ID,
			caseType: "patient",
			caseTypeSchemas: buildSchemaMap(retyped),
			property: "languages",
			change: { kind: "retype", fromType: "multi_select", toType: "text" },
		});
		expect(report.migrated).toBe(1);
		expect(report.parkedIds).toEqual([]);

		const { rows } = await dbHandle.pool.query(
			`SELECT properties->>'languages' AS languages FROM cases WHERE app_id = $1 AND case_id = $2`,
			[APP_ID, "31000000-0000-0000-0000-000000000001"],
		);
		expect(rows[0]?.languages).toBe("en fr");
	});

	it("Schema change rolls back atomically on per-row migration failure: schema row stays unchanged", async () => {
		// Sabotage the second `applySchemaChange` call by removing
		// `parked_case_values` from the database mid-flight — the
		// retype's park INSERT fails, and the schema transaction rolls
		// back the new schema UPSERT alongside the failed migration.
		// The probe verifies the schema row is preserved at its
		// pre-call shape.
		const store = makeStore(OWNER_A);
		const initial: CaseType = {
			name: "patient",
			properties: [{ name: "age", label: proseText("Age"), data_type: "text" }],
		};
		await store.applySchemaChange({
			appId: APP_ID,
			caseType: "patient",
			caseTypeSchemas: buildSchemaMap(initial),
		});
		await store.insert({
			appId: APP_ID,
			row: {
				case_id: "30000000-0000-0000-0000-000000000001",
				case_type: "patient",
				case_name: "test-case",
				properties: { age: "abc" },
			},
		});

		// Drop `parked_case_values` so the retype's park INSERT
		// throws. This is a controlled sabotage of the engine state;
		// the production pipeline never drops the table.
		await dbHandle.pool.query("DROP TABLE parked_case_values");

		const retyped: CaseType = {
			name: "patient",
			properties: [{ name: "age", label: proseText("Age"), data_type: "int" }],
		};
		await expect(
			store.applySchemaChange({
				appId: APP_ID,
				caseType: "patient",
				caseTypeSchemas: buildSchemaMap(retyped),
				property: "age",
				change: { kind: "retype", fromType: "text", toType: "int" },
			}),
		).rejects.toMatchObject({ code: "42P01" });

		// The schema row in `case_type_schemas` still carries the
		// pre-call (text) shape because the transaction rolled back. Probe
		// the row directly — the store's `query` would surface the
		// shape only indirectly.
		const schemaRow = await dbHandle.pool.query<{ schema: unknown }>(
			"SELECT schema FROM case_type_schemas WHERE app_id = $1 AND case_type = $2",
			[APP_ID, "patient"],
		);
		expect(schemaRow.rows).toHaveLength(1);
		// The schema's `properties.age` declares the pre-call type.
		const schema = schemaRow.rows[0]?.schema as {
			properties: { age: { type: string } };
		};
		expect(schema.properties.age.type).toBe("string");

		// The row's properties are also untouched. The
		// per-row migration would have dropped the row's
		// `properties.age` into the park; the rollback returns it to
		// the pre-call value. Asserting the JSONB document confirms
		// the schema-and-data invariant the test labels.
		const row = await dbHandle.pool.query<{ properties: unknown }>(
			"SELECT properties FROM cases WHERE case_id = $1",
			["30000000-0000-0000-0000-000000000001"],
		);
		expect(row.rows[0]?.properties).toEqual({ age: "abc" });
	});

	it("Caller-owned schema change rolls back with its outer transaction", async () => {
		const store = makeStore(OWNER_A);
		const caseType: CaseType = {
			name: "patient",
			properties: [
				{ name: "name", label: proseText("Name"), data_type: "text" },
			],
		};

		const caseDb = dbHandle.db as unknown as Kysely<Database>;
		await expect(
			caseDb.transaction().execute(async (tx) => {
				await store.applySchemaChangeInTransaction(tx, {
					appId: APP_ID,
					caseType: "patient",
					caseTypeSchemas: buildSchemaMap(caseType),
				});
				throw new Error("abort caller transaction");
			}),
		).rejects.toThrow("abort caller transaction");

		const schema = await dbHandle.pool.query<{ count: string }>(
			`SELECT count(*)::text AS count
			 FROM case_type_schemas
			 WHERE app_id = $1 AND case_type = $2`,
			[APP_ID, "patient"],
		);
		expect(schema.rows[0]?.count).toBe("0");
		expect(await readCaseExpressionIndexes(dbHandle.pool)).toEqual([]);
	});

	// Tenant-scoped schema and row semantics remain independent.

	it("two apps sharing a case-type + property name with different data_types stay independent", async () => {
		const store = makeStore(OWNER_A);
		const appA = "app-cross-a";
		const appB = "app-cross-b";

		// App B (decimal) first, then App A (int) — the order that
		// previously left App A's `::integer` index as the sole
		// survivor covering both apps' patient rows.
		await store.applySchemaChange({
			appId: appB,
			caseType: "patient",
			caseTypeSchemas: buildSchemaMap({
				name: "patient",
				properties: [
					{ name: "weight", label: proseText("Weight"), data_type: "decimal" },
				],
			}),
		});
		await store.applySchemaChange({
			appId: appA,
			caseType: "patient",
			caseTypeSchemas: buildSchemaMap({
				name: "patient",
				properties: [
					{ name: "weight", label: proseText("Weight"), data_type: "int" },
				],
			}),
		});

		expect(await readCaseExpressionIndexes(dbHandle.pool)).toEqual([]);

		await store.insert({
			appId: appB,
			row: {
				case_id: "70000000-0000-0000-0000-000000000001",
				case_type: "patient",
				case_name: "b-frac",
				properties: { weight: 17.01 },
			},
		});
		// App A inserts an integer weight against its own property schema.
		await store.insert({
			appId: appA,
			row: {
				case_id: "70000000-0000-0000-0000-000000000002",
				case_type: "patient",
				case_name: "a-int",
				properties: { weight: 42 },
			},
		});

		const bRows = await store.query({
			reading: SEARCH_READING,
			appId: appB,
			caseType: "patient",
		});
		const aRows = await store.query({
			reading: SEARCH_READING,
			appId: appA,
			caseType: "patient",
		});
		expect(bRows).toHaveLength(1);
		expect(aRows).toHaveLength(1);
		expect(bRows[0]?.properties.weight).toBe(17.01);
	});
});

// ---------------------------------------------------------------
// Bulk-insert path rollback semantics
// ---------------------------------------------------------------
//
// The bulk-insert path (`insertManyInTransaction`) is
// package-private; tests reach it through the public
// `generateSampleData` entry point with a stub
// `SampleCaseGenerator` that emits a hand-crafted batch with one
// row violating the case-type's JSON Schema. The stub path
// exercises the real bulk-insert code without fighting the
// heuristic generator's seed-driven output (the heuristic always
// produces JSONB-valid rows by construction).
//
// The shape pinned: a validation failure inside the bulk
// transaction rolls back the entire batch — zero rows land in
// `cases`, zero edges in `case_indices`. A future refactor that
// opens an inner transaction or skips the throw would silently
// allow partial commits, and this test is the regression net.

describe("PostgresCaseStore — bulk-insert rollback semantics", () => {
	it("normalizes case_name and external_id for every row without copying scalars into JSONB", async () => {
		const caseType: CaseType = { name: "patient", properties: [] };
		const stubGenerator = {
			generate: () =>
				[
					{
						case_type: "patient",
						case_name: "\u0000 Alice \u001f",
						external_id: " EXT-1 ",
						status: "open",
						properties: {},
					},
					{
						case_type: "patient",
						case_name: "\t Bob \r\n",
						external_id: "\t\r\n",
						status: "open",
						properties: {},
					},
				] as const,
		};
		const store = new PostgresCaseStore({
			projectId: OWNER_A,
			actorUserId: OWNER_A,
			ownerId: OWNER_A,
			db: dbHandle.db as unknown as Kysely<Database>,
			sampleGenerator: stubGenerator,
		});
		await store.applySchemaChange({
			appId: APP_ID,
			caseType: "patient",
			caseTypeSchemas: buildSchemaMap(caseType),
		});

		await expect(
			store.generateSampleData({
				appId: APP_ID,
				caseType,
				count: 2,
				seed: "scalar-normalization",
			}),
		).resolves.toEqual({ inserted: 2 });
		const rows = (
			await store.query({
				reading: SEARCH_READING,
				appId: APP_ID,
				caseType: "patient",
			})
		).sort((left, right) => left.case_name.localeCompare(right.case_name));
		expect(
			rows.map(({ case_name, external_id, properties }) => ({
				case_name,
				external_id,
				properties,
			})),
		).toEqual([
			{ case_name: "Alice", external_id: "EXT-1", properties: {} },
			{ case_name: "Bob", external_id: "", properties: {} },
		]);
	});

	it("rolls back the entire batch when any row fails JSON Schema validation", async () => {
		// Schema declares `age` as `int`; the stub generator emits
		// three rows where the second one's `age` is the string
		// "not-a-number" (rejects against the `integer` schema).
		const caseType: CaseType = {
			name: "patient",
			properties: [
				{ name: "case_name", label: proseText("Name"), data_type: "text" },
				{ name: "age", label: proseText("Age"), data_type: "int" },
			],
		};
		const caseTypeSchemas = buildSchemaMap(caseType);

		// Stub generator returning a fixed three-row batch with one
		// schema-violating row at index 1. The interface admits any
		// implementation; the stub bypasses every randomness /
		// blueprint-walk path the heuristic generator carries.
		const stubGenerator = {
			generate: () =>
				[
					{
						case_type: "patient",
						case_name: "Alice",
						status: "open",
						properties: { age: 30 },
					},
					{
						case_type: "patient",
						case_name: "Bob",
						status: "open",
						// `age` as a non-numeric string violates the
						// `integer` schema; AJV rejects mid-batch.
						properties: { age: "not-a-number" },
					},
					{
						case_type: "patient",
						case_name: "Carol",
						status: "open",
						properties: { age: 40 },
					},
				] as const,
		};

		const store = new PostgresCaseStore({
			projectId: OWNER_A,
			actorUserId: OWNER_A,
			ownerId: OWNER_A,
			db: dbHandle.db as unknown as Kysely<Database>,
			sampleGenerator: stubGenerator,
		});

		await store.applySchemaChange({
			appId: APP_ID,
			caseType: "patient",
			caseTypeSchemas,
		});

		// `generateSampleData` routes through the bulk-insert path.
		// AJV's failure on row 1 throws; the transaction rolls back
		// the whole batch (rows 0 and 2 included).
		await expect(
			store.generateSampleData({
				appId: APP_ID,
				caseType,
				count: 3,
				seed: "rollback-test",
			}),
		).rejects.toBeInstanceOf(CasePropertiesValidationError);

		// Zero rows land in `cases` — the rollback covers EVERY row
		// in the batch, not just the failing one. A regression that
		// commits row 0 before reaching row 1's validation would
		// leak through here.
		const survivors = await store.query({
			reading: SEARCH_READING,
			appId: APP_ID,
			caseType: "patient",
		});
		expect(survivors).toHaveLength(0);
	});
});

// ---------------------------------------------------------------
// Creation stamps — `opened_on` / `modified_on` on every insert path
// ---------------------------------------------------------------
//
// CommCare sets a case's `date_opened` AND `last_modified` at creation
// on-device (`Case.java`'s constructor), and the casedb exposes both
// with no sync involved — so the standard-name aliases must read real
// values the moment a row lands, on every insert path. A regression
// here shows up to users as a blank "Last Modified" / "Date Opened"
// column for freshly registered cases.

describe("PostgresCaseStore — creation stamps", () => {
	const caseType: CaseType = {
		name: "patient",
		properties: [
			{ name: "case_name", label: proseText("Name"), data_type: "text" },
		],
	};

	it("stamps opened_on and modified_on on per-row insert", async () => {
		const store = makeStore(OWNER_A);
		await store.applySchemaChange({
			appId: APP_ID,
			caseType: "patient",
			caseTypeSchemas: buildSchemaMap(caseType),
		});

		await store.insert({
			appId: APP_ID,
			row: {
				case_type: "patient",
				case_name: "Mary",
				status: "open",
				properties: {},
			},
		});

		const [row] = await store.query({
			reading: SEARCH_READING,
			appId: APP_ID,
			caseType: "patient",
		});
		expect(row?.opened_on).toBeInstanceOf(Date);
		expect(row?.modified_on).toBeInstanceOf(Date);
	});

	it("stamps every row of a registration insert (primary + children)", async () => {
		const childType: CaseType = {
			name: "medication_order",
			properties: [
				{ name: "case_name", label: proseText("Name"), data_type: "text" },
			],
		};
		const schemas = buildCaseTypeMap(
			buildSimpleBlueprint([caseType, childType], APP_ID),
		);
		const store = makeStore(OWNER_A);
		for (const name of ["patient", "medication_order"]) {
			await store.applySchemaChange({
				appId: APP_ID,
				caseType: name,
				caseTypeSchemas: schemas,
			});
		}

		await store.applySubmission({
			appId: APP_ID,
			submissionReceipt: {
				entryKey: "store-creation-stamp-entry",
				formUuid: testUuid("66666666-6666-4666-8666-666666666666"),
				expectedAppMutationSeq: 0,
				blueprintDigest: "0".repeat(64),
				requestDigest: "store-creation-stamp-request",
			},
			ordinary: { kind: "registration" },
			operations: {
				formUuid: testUuid("66666666-6666-4666-8666-666666666666"),
				operations: [
					{
						operation: {
							uuid: testUuid("store-creation-stamp-own"),
							id: "patient",
							action: "own",
							name: { kind: "term", term: { kind: "literal", value: "Mary" } },
						},
						guardConditions: [],
						expressionSnapshotTypes: { links: new Map() },
					},
					{
						operation: {
							uuid: testUuid("store-creation-stamp-order"),
							id: "medication_order",
							action: "create",
							caseType: "medication_order",
							target: { kind: "new" },
							name: {
								kind: "term",
								term: { kind: "literal", value: "Rifampin" },
							},
						},
						guardConditions: [],
						expressionSnapshotTypes: { links: new Map() },
					},
				],
				ownCase: { caseType: "patient", formType: "registration" },
				scopes: [{ iterations: [{ formFields: new Map() }] }],
				caseTypeSchemas: schemas,
			},
		});

		for (const name of ["patient", "medication_order"]) {
			const [row] = await store.query({
				reading: SEARCH_READING,
				appId: APP_ID,
				caseType: name,
			});
			expect(row?.opened_on).toBeInstanceOf(Date);
			expect(row?.modified_on).toBeInstanceOf(Date);
		}
	});

	it("an explicit caller-supplied timestamp wins over the stamp", async () => {
		const store = makeStore(OWNER_A);
		await store.applySchemaChange({
			appId: APP_ID,
			caseType: "patient",
			caseTypeSchemas: buildSchemaMap(caseType),
		});

		const supplied = new Date("2025-03-01T12:00:00Z");
		await store.insert({
			appId: APP_ID,
			row: {
				case_type: "patient",
				case_name: "Imported",
				status: "open",
				opened_on: supplied,
				properties: {},
			},
		});

		const [row] = await store.query({
			reading: SEARCH_READING,
			appId: APP_ID,
			caseType: "patient",
		});
		expect(row?.opened_on?.toISOString()).toBe(supplied.toISOString());
		expect(row?.modified_on).toBeInstanceOf(Date);
	});
});

// ---------------------------------------------------------------
// `resetSampleData` — atomic delete + regenerate
// ---------------------------------------------------------------
//
// Pin the all-or-nothing contract: a failure mid-regeneration
// rolls back the deletion alongside the partial regeneration, so
// the case-type's pre-call population stays intact. Manufactures
// the failure via a stub generator that emits one schema-violating
// row (same shape the bulk-insert rollback test uses); the failure
// surfaces during validation inside the bulk path's transaction.
// Without `resetSampleData`'s outer transaction, the pre-call rows
// would already be deleted by the time the regeneration's
// validation rejects.

describe("PostgresCaseStore — resetSampleData atomicity", () => {
	it("preserves surviving children while detaching every edge to replaced parents", async () => {
		const householdType: CaseType = {
			name: "household",
			properties: [],
		};
		const patientType: CaseType = {
			name: "patient",
			parent_type: "household",
			properties: [],
		};
		const schemas = buildCaseTypeMap(
			buildSimpleBlueprint([householdType, patientType], APP_ID),
		);
		const store = makeStore(OWNER_A);
		for (const caseType of [householdType, patientType]) {
			await store.applySchemaChange({
				appId: APP_ID,
				caseType: caseType.name,
				caseTypeSchemas: schemas,
			});
		}

		const oldParentId = "70000000-0000-0000-0000-000000000001";
		const childId = "70000000-0000-0000-0000-000000000002";
		await store.insert({
			appId: APP_ID,
			row: {
				case_id: oldParentId,
				case_type: "household",
				case_name: "Old household",
				status: "open",
				properties: {},
			},
		});
		await store.insert({
			appId: APP_ID,
			row: {
				case_id: childId,
				case_type: "patient",
				case_name: "Surviving child",
				status: "open",
				parent_case_id: oldParentId,
				properties: {},
			},
		});

		await store.resetSampleData({
			appId: APP_ID,
			caseType: householdType,
			count: 1,
		});

		const [child] = await store.query({
			reading: SEARCH_READING,
			appId: APP_ID,
			caseType: "patient",
		});
		expect(child?.case_id).toBe(childId);
		expect(child?.parent_case_id).toBeNull();
		const edges = await (dbHandle.db as unknown as Kysely<Database>)
			.selectFrom("case_indices")
			.selectAll()
			.execute();
		expect(edges).toEqual([]);
	});

	it("serializes a concurrent child insert and rejects its deleted parent after reset", async () => {
		const householdType: CaseType = {
			name: "household",
			properties: [],
		};
		const patientType: CaseType = {
			name: "patient",
			parent_type: "household",
			properties: [],
		};
		const schemas = buildCaseTypeMap(
			buildSimpleBlueprint([householdType, patientType], APP_ID),
		);
		const seedingStore = makeStore(OWNER_A);
		for (const caseType of [householdType, patientType]) {
			await seedingStore.applySchemaChange({
				appId: APP_ID,
				caseType: caseType.name,
				caseTypeSchemas: schemas,
			});
		}

		const oldParentId = "71000000-0000-0000-0000-000000000001";
		await seedingStore.insert({
			appId: APP_ID,
			row: {
				case_id: oldParentId,
				case_type: "household",
				case_name: "Parent being replaced",
				status: "open",
				properties: {},
			},
		});

		/* Hold reset inside its DELETE trigger after it has acquired the
		 * production relationship lock. This makes the racing child insert
		 * deterministic: it must queue behind reset, then re-check the parent
		 * only after the old id has disappeared. */
		const resetGate = 912_407_311;
		await dbHandle.pool.query(`
			CREATE FUNCTION wait_on_case_reset_gate() RETURNS trigger AS $$
			BEGIN
				PERFORM pg_advisory_xact_lock(${resetGate});
				RETURN OLD;
			END;
			$$ LANGUAGE plpgsql;
			CREATE TRIGGER wait_on_case_reset_gate_trigger
			BEFORE DELETE ON cases
			FOR EACH ROW WHEN (OLD.case_type = 'household')
			EXECUTE FUNCTION wait_on_case_reset_gate();
		`);

		const concurrentPool = new Pool({
			connectionString: dbHandle.uri,
			max: 4,
		});
		const errors: Error[] = [];
		concurrentPool.on("error", (error) => errors.push(error));
		const concurrentDb = new Kysely<Database>({
			dialect: new PostgresDialect({
				pool: concurrentPool as unknown as PostgresPool,
			}),
		});
		const resetStore = new PostgresCaseStore({
			projectId: OWNER_A,
			actorUserId: OWNER_A,
			ownerId: OWNER_A,
			db: concurrentDb,
			sampleGenerator: new HeuristicCaseGenerator(),
		});
		const childStore = new PostgresCaseStore({
			projectId: OWNER_A,
			actorUserId: OWNER_A,
			ownerId: OWNER_A,
			db: concurrentDb,
			sampleGenerator: new HeuristicCaseGenerator(),
		});
		const gateClient = new Client({ connectionString: dbHandle.uri });
		const pending: Promise<PromiseSettledResult<unknown>[]>[] = [];
		try {
			await gateClient.connect();
			await gateClient.query("select pg_advisory_lock($1)", [resetGate]);
			const resetPromise = resetStore.resetSampleData({
				appId: APP_ID,
				caseType: householdType,
				count: 1,
			});

			pending.push(Promise.allSettled([resetPromise]));
			const waitForAdvisoryWaiters = async (minimum: number) => {
				const deadline = Date.now() + 5_000;
				while (Date.now() < deadline) {
					const result = await concurrentPool.query<{ count: number }>(`
						SELECT count(*)::int AS count
						FROM pg_locks
						WHERE locktype = 'advisory'
							AND NOT granted
							AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
					`);
					if ((result.rows[0]?.count ?? 0) >= minimum) return;
					await new Promise((resolve) => setTimeout(resolve, 10));
				}
				throw new Error(`Timed out waiting for ${minimum} advisory waiter(s)`);
			};

			await waitForAdvisoryWaiters(1);
			const childPromise = childStore
				.insert({
					appId: APP_ID,
					row: {
						case_type: "patient",
						case_name: "Racing child",
						status: "open",
						parent_case_id: oldParentId,
						properties: {},
					},
				})
				.then(
					() => ({ error: undefined }),
					(error: unknown) => ({ error }),
				);
			pending.push(Promise.allSettled([childPromise]));
			await waitForAdvisoryWaiters(2);
			await gateClient.query("select pg_advisory_unlock($1)", [resetGate]);

			await resetPromise;
			const childResult = await childPromise;
			expect(childResult.error).toBeInstanceOf(CaseNotFoundError);
			const children = await seedingStore.query({
				reading: SEARCH_READING,
				appId: APP_ID,
				caseType: "patient",
			});
			expect(children).toEqual([]);
			const dangling = await dbHandle.pool.query(
				"select 1 from case_indices where ancestor_id = $1",
				[oldParentId],
			);
			expect(dangling.rowCount).toBe(0);
		} finally {
			await gateClient.end();
			await Promise.all(pending);
			await concurrentDb.destroy();
		}
		expect(errors).toEqual([]);
	});

	it("rolls back the deletion alongside the failed regeneration so the pre-call population is preserved", async () => {
		// Phase 1: seed the case-type with a clean population using
		// the heuristic generator.
		const caseType: CaseType = {
			name: "patient",
			properties: [
				{ name: "case_name", label: proseText("Name"), data_type: "text" },
				{ name: "age", label: proseText("Age"), data_type: "int" },
			],
		};
		const caseTypeSchemas = buildSchemaMap(caseType);

		const seedingStore = new PostgresCaseStore({
			projectId: OWNER_A,
			actorUserId: OWNER_A,
			ownerId: OWNER_A,
			db: dbHandle.db as unknown as Kysely<Database>,
			sampleGenerator: new HeuristicCaseGenerator(),
		});

		await seedingStore.applySchemaChange({
			appId: APP_ID,
			caseType: "patient",
			caseTypeSchemas,
		});
		await seedingStore.generateSampleData({
			appId: APP_ID,
			caseType,
			count: 4,
			seed: "pre-reset-population",
		});

		const beforeRows = await seedingStore.query({
			reading: SEARCH_READING,
			appId: APP_ID,
			caseType: "patient",
		});
		expect(beforeRows).toHaveLength(4);

		// Phase 2: swap to a stub generator whose row-N output is
		// schema-invalid. AJV rejects mid-batch inside the bulk
		// path's transaction, the throw propagates out of
		// `generateSampleDataInTransaction`, and `resetSampleData`'s
		// outer transaction rolls back BOTH the regeneration and
		// the preceding deletion — so the original 4 rows survive.
		const failingSampleGenerator = {
			generate: () => [
				{
					case_type: "patient",
					case_name: "Alice",
					status: "open",
					properties: { age: 30 },
				},
				{
					case_type: "patient",
					case_name: "Bob",
					status: "open",
					// `age` as a non-numeric string fails the int
					// schema; AJV throws and the whole reset rolls back.
					properties: { age: "not-a-number" },
				},
			],
		};
		const failingStore = new PostgresCaseStore({
			projectId: OWNER_A,
			actorUserId: OWNER_A,
			ownerId: OWNER_A,
			db: dbHandle.db as unknown as Kysely<Database>,
			sampleGenerator: failingSampleGenerator,
		});

		await expect(
			failingStore.resetSampleData({
				appId: APP_ID,
				caseType,
				count: 2,
			}),
		).rejects.toBeInstanceOf(CasePropertiesValidationError);

		// Phase 3: verify the pre-reset rows survived. A regression
		// that committed the deletion separately from the
		// regeneration would surface here as an empty case-type.
		const afterRows = await seedingStore.query({
			reading: SEARCH_READING,
			appId: APP_ID,
			caseType: "patient",
		});
		expect(afterRows).toHaveLength(4);
		expect(afterRows).toEqual(beforeRows);
	});
});

// ---------------------------------------------------------------
// int4 range — AJV's acceptance set matches the `::integer` cast
// ---------------------------------------------------------------
//
// `int` predicates compile to Postgres `integer` (int4). A bare integer
// JSON Schema accepts values outside the query cast's signed-32-bit range.
// Write-time int4 bounds keep admitted rows readable by compiled predicates;
// invalid input must be refused as a typed value error before persistence.

describe("PostgresCaseStore — int property range validation", () => {
	it("rejects an out-of-int4 value as a typed error, but admits the int4 boundary", async () => {
		const store = makeStore(OWNER_A);
		await store.applySchemaChange({
			appId: APP_ID,
			caseType: "counter",
			caseTypeSchemas: buildSchemaMap({
				name: "counter",
				properties: [{ name: "n", label: proseText("N"), data_type: "int" }],
			}),
		});

		// int4 max inserts cleanly — the bound is inclusive and the
		// `::integer` cast accepts it.
		const { caseId } = await store.insert({
			appId: APP_ID,
			row: {
				case_id: "60000000-0000-0000-0000-000000000001",
				case_type: "counter",
				case_name: "max",
				properties: { n: 2_147_483_647 },
			},
		});
		expect(caseId).toBe("60000000-0000-0000-0000-000000000001");

		// int4 max + 1 is rejected by AJV as a typed
		// `CasePropertiesValidationError` BEFORE reaching Postgres —
		// not a raw `integer out of range` failure when a query casts the value.
		await expect(
			store.insert({
				appId: APP_ID,
				row: {
					case_id: "60000000-0000-0000-0000-000000000002",
					case_type: "counter",
					case_name: "overflow",
					properties: { n: 2_147_483_648 },
				},
			}),
		).rejects.toBeInstanceOf(CasePropertiesValidationError);
	});
});

// ---------------------------------------------------------------
// The monotone `synced_seq` gate — concurrent additive convergence
// ---------------------------------------------------------------
//
// `applySchemaChange` gates on `syncedSeq` so concurrent additive
// case-type edits converge instead of one clobbering the other. The
// coarse SELECT skips the WHOLE call for a stale lower seq; the fine
// UPSERT-SET guard keeps the row monotone even under a SELECT→UPSERT
// race. These probe `case_type_schemas` directly for the recorded
// `synced_seq` + schema shape.

describe("PostgresCaseStore — applySchemaChange synced_seq gate", () => {
	const SEQ_APP = "app-synced-seq";

	async function readRow(caseType: string): Promise<{
		syncedSeq: number | null;
		properties: string[];
	}> {
		const res = await dbHandle.pool.query<{
			synced_seq: string;
			schema: { properties?: Record<string, unknown> };
		}>(
			"SELECT synced_seq, schema FROM case_type_schemas WHERE app_id = $1 AND case_type = $2",
			[SEQ_APP, caseType],
		);
		const row = res.rows[0];
		if (row === undefined) return { syncedSeq: null, properties: [] };
		return {
			syncedSeq: Number(row.synced_seq),
			properties: Object.keys(row.schema.properties ?? {}),
		};
	}

	function patientWith(props: string[]): CaseType {
		return {
			name: "patient",
			properties: props.map((name) => ({
				name,
				label: proseText(name),
				data_type: "text" as const,
			})),
		};
	}

	it.each([-1, Number.MAX_SAFE_INTEGER + 1])(
		"rejects the noncanonical synced sequence %s before writing",
		async (syncedSeq) => {
			const store = makeStore(SEQ_APP);
			await expect(
				store.applySchemaChange({
					appId: SEQ_APP,
					caseType: "patient",
					caseTypeSchemas: buildCaseTypeMap(
						buildSimpleBlueprint([patientWith(["name"])], SEQ_APP),
					),
					syncedSeq,
				}),
			).rejects.toThrow(/nonnegative safe integer/);
			expect(await readRow("patient")).toEqual({
				syncedSeq: null,
				properties: [],
			});
		},
	);

	it("admits MAX_SAFE_INTEGER exactly and rejects an older safe sequence as stale", async () => {
		const store = makeStore(SEQ_APP);
		await store.applySchemaChange({
			appId: SEQ_APP,
			caseType: "patient",
			caseTypeSchemas: buildCaseTypeMap(
				buildSimpleBlueprint([patientWith(["name"])], SEQ_APP),
			),
			syncedSeq: Number.MAX_SAFE_INTEGER,
		});
		await store.applySchemaChange({
			appId: SEQ_APP,
			caseType: "patient",
			caseTypeSchemas: buildCaseTypeMap(
				buildSimpleBlueprint([patientWith(["name", "village"])], SEQ_APP),
			),
			syncedSeq: Number.MAX_SAFE_INTEGER - 1,
		});
		expect(await readRow("patient")).toEqual({
			syncedSeq: Number.MAX_SAFE_INTEGER,
			properties: ["name"],
		});
	});

	it("records the incoming syncedSeq on a first sync and advances it on a forward sync", async () => {
		const store = makeStore(SEQ_APP);
		await store.applySchemaChange({
			appId: SEQ_APP,
			caseType: "patient",
			caseTypeSchemas: buildCaseTypeMap(
				buildSimpleBlueprint([patientWith(["name"])], SEQ_APP),
			),
			syncedSeq: 3,
		});
		expect(await readRow("patient")).toEqual({
			syncedSeq: 3,
			properties: ["name"],
		});

		// Forward sync (seq 7 > 3) adds `village` and advances the seq.
		await store.applySchemaChange({
			appId: SEQ_APP,
			caseType: "patient",
			caseTypeSchemas: buildCaseTypeMap(
				buildSimpleBlueprint([patientWith(["name", "village"])], SEQ_APP),
			),
			syncedSeq: 7,
		});
		const forward = await readRow("patient");
		expect(forward.syncedSeq).toBe(7);
		expect(forward.properties).toEqual(["name", "village"]);
	});

	it("rejects a stale lower-sequence schema sync", async () => {
		const store = makeStore(SEQ_APP);
		// Land the fresher two-property state at seq 5.
		await store.applySchemaChange({
			appId: SEQ_APP,
			caseType: "patient",
			caseTypeSchemas: buildCaseTypeMap(
				buildSimpleBlueprint([patientWith(["name", "village"])], SEQ_APP),
			),
			syncedSeq: 5,
		});
		const indexesBefore = await readCaseExpressionIndexes(dbHandle.pool);
		expect(indexesBefore).toHaveLength(0);

		await store.applySchemaChange({
			appId: SEQ_APP,
			caseType: "patient",
			caseTypeSchemas: buildCaseTypeMap(
				buildSimpleBlueprint([patientWith(["name"])], SEQ_APP),
			),
			syncedSeq: 2,
		});
		expect(await readRow("patient")).toEqual({
			syncedSeq: 5,
			properties: ["name", "village"],
		});
		const indexesAfter = await readCaseExpressionIndexes(dbHandle.pool);
		expect(indexesAfter.map((i) => i.name)).toEqual(
			indexesBefore.map((i) => i.name),
		);
	});

	it("contending schema syncs preserve the latest sequence", async () => {
		const store = makeStore(SEQ_APP);
		await store.applySchemaChange({
			appId: SEQ_APP,
			caseType: "patient",
			caseTypeSchemas: buildCaseTypeMap(
				buildSimpleBlueprint([patientWith(["name"])], SEQ_APP),
			),
			syncedSeq: 1,
		});
		const pool = new Pool({ connectionString: dbHandle.uri, max: 3 });
		const errors: Error[] = [];
		pool.on("error", (error) => errors.push(error));
		const db = new Kysely<Database>({
			dialect: new PostgresDialect({ pool: pool as unknown as PostgresPool }),
		});
		const gate = new Client({ connectionString: dbHandle.uri });
		const pending: Promise<PromiseSettledResult<unknown>[]>[] = [];
		try {
			await gate.connect();
			await gate.query("SELECT pg_advisory_lock(hashtextextended($1,0))", [
				caseSchemaIndexLockScope(SEQ_APP, "patient"),
			]);
			const concurrentStore = new PostgresCaseStore({
				projectId: SEQ_APP,
				actorUserId: SEQ_APP,
				ownerId: SEQ_APP,
				db,
				sampleGenerator: new HeuristicCaseGenerator(),
			});
			const work = Promise.allSettled(
				[3, 2].map((syncedSeq) =>
					withTransientRetry(() =>
						concurrentStore.applySchemaChange({
							appId: SEQ_APP,
							caseType: "patient",
							syncedSeq,
							caseTypeSchemas: buildCaseTypeMap(
								buildSimpleBlueprint(
									[
										patientWith(
											syncedSeq === 3 ? ["name", "village"] : ["name"],
										),
									],
									SEQ_APP,
								),
							),
						}),
					),
				),
			);
			pending.push(work);
			await vi.waitFor(async () => {
				const result = await gate.query<{
					count: number;
				}>(`SELECT count(*)::int AS count FROM pg_stat_activity
                    WHERE datname=current_database() AND cardinality(pg_blocking_pids(pid))>0`);
				expect(result.rows[0]?.count).toBe(2);
			});
			await gate.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [
				caseSchemaIndexLockScope(SEQ_APP, "patient"),
			]);
			for (const result of await work)
				if (result.status === "rejected") throw result.reason;
			const row = await readRow("patient");
			expect(row.syncedSeq).toBe(3);
			expect(row.properties.sort()).toEqual(["name", "village"]);
			expect(
				(await readCaseExpressionIndexes(dbHandle.pool))
					.map((i) => i.name)
					.sort(),
			).toEqual([]);
		} finally {
			await gate.end();
			await Promise.all(pending);
			await db.destroy();
		}
		expect(errors).toEqual([]);
	});

	it("throws when `change` and `syncedSeq` are both set (mutually exclusive)", async () => {
		// A per-row migration (`change`) runs pre-commit un-versioned; the
		// additive gate (`syncedSeq`) carries a committed seq and no migration.
		// Combining them could let the coarse gate skip a migration's per-row
		// work on a stale seq, so the implementation rejects the impossible
		// state loudly rather than corrupt data.
		const store = makeStore(SEQ_APP);
		await expect(
			store.applySchemaChange({
				appId: SEQ_APP,
				caseType: "patient",
				caseTypeSchemas: buildCaseTypeMap(
					buildSimpleBlueprint([patientWith(["name"])], SEQ_APP),
				),
				change: {
					kind: "retype",
					fromType: "text",
					toType: "int",
				},
				syncedSeq: 3,
			}),
		).rejects.toThrow(/mutually exclusive|change.*syncedSeq/i);
	});
});

describe("PostgresCaseStore — canonical stored-schema boundary", () => {
	it("fails closed on one noncanonical property schema across writes, transitions, and parked-value review", async () => {
		const store = makeStore(OWNER_A);
		const textType: CaseType = {
			name: "patient",
			properties: [
				{
					name: "measurement",
					label: proseText("Measurement"),
					data_type: "text",
				},
			],
		};
		const intType: CaseType = {
			name: "patient",
			properties: [
				{
					name: "measurement",
					label: proseText("Measurement"),
					data_type: "int",
				},
			],
		};
		await store.applySchemaChange({
			appId: APP_ID,
			caseType: "patient",
			caseTypeSchemas: buildSchemaMap(textType),
		});
		const inserted = await store.insert({
			appId: APP_ID,
			row: {
				case_type: "patient",
				case_name: "Patient",
				properties: { measurement: "not-an-integer" },
			},
		});

		const canonicalText = caseTypeToJsonSchema(textType);
		const malformedText = structuredClone(canonicalText);
		(
			malformedText.properties.measurement as unknown as Record<string, unknown>
		).unexpected = true;
		await dbHandle.pool.query(
			"UPDATE case_type_schemas SET schema = $1 WHERE app_id = $2 AND case_type = 'patient'",
			[JSON.stringify(malformedText), APP_ID],
		);
		await expect(
			store.update({
				appId: APP_ID,
				caseId: inserted.caseId,
				patch: { case_name: "Still invalid" },
			}),
		).rejects.toThrow(/unknown or noncanonical property declaration/);
		await expect(
			store.applySchemaChange({
				appId: APP_ID,
				caseType: "patient",
				caseTypeSchemas: buildSchemaMap(intType),
			}),
		).rejects.toThrow(/unknown or noncanonical property declaration/);

		await dbHandle.pool.query(
			"UPDATE case_type_schemas SET schema = $1 WHERE app_id = $2 AND case_type = 'patient'",
			[JSON.stringify(canonicalText), APP_ID],
		);
		const migrated = await store.applySchemaChange({
			appId: APP_ID,
			caseType: "patient",
			caseTypeSchemas: buildSchemaMap(intType),
		});
		expect(migrated.parkedIds).toHaveLength(1);

		const canonicalInt = caseTypeToJsonSchema(intType);
		const malformedInt = structuredClone(canonicalInt);
		(
			malformedInt.properties.measurement as unknown as Record<string, unknown>
		).unexpected = true;
		await dbHandle.pool.query(
			"UPDATE case_type_schemas SET schema = $1 WHERE app_id = $2 AND case_type = 'patient'",
			[JSON.stringify(malformedInt), APP_ID],
		);
		await expect(
			store.listParkedValues({ appId: APP_ID, caseType: "patient" }),
		).rejects.toThrow(/unknown or noncanonical property declaration/);
	});
});

describe("PostgresCaseStore historical row repair", () => {
	it("strips undeclared inherited keys during update while rejecting unknown patch keys", async () => {
		const store = makeStore(OWNER_A);
		await store.applySchemaChange({
			appId: APP_ID,
			caseType: "patient",
			caseTypeSchemas: buildSchemaMap({
				name: "patient",
				properties: [
					{ name: "name", label: proseText("Name"), data_type: "text" },
				],
			}),
		});
		const caseId = testUuid("historical-stranded-key");
		await dbHandle.pool.query(
			`INSERT INTO cases(case_id,app_id,project_id,owner_id,case_type,case_name,properties)
            VALUES($1,$2,$3,$3,'patient','Alice','{"name":"Alice","age":"30"}'::jsonb)`,
			[caseId, APP_ID, OWNER_A],
		);
		expect(
			(
				await store.query({
					reading: SEARCH_READING,
					appId: APP_ID,
					caseType: "patient",
				})
			)[0]?.properties,
		).toEqual({ name: "Alice", age: "30" });
		await store.update({
			appId: APP_ID,
			caseId,
			patch: { properties: { name: "Alicia" } },
		});
		const repaired = await store.query({
			reading: SEARCH_READING,
			appId: APP_ID,
			caseType: "patient",
		});
		expect(repaired[0]?.properties).toEqual({ name: "Alicia" });
		await expect(
			store.update({
				appId: APP_ID,
				caseId,
				patch: { properties: { bogus: "x" } },
			}),
		).rejects.toBeInstanceOf(CasePropertiesValidationError);
		expect(
			await store.query({
				reading: SEARCH_READING,
				appId: APP_ID,
				caseType: "patient",
			}),
		).toEqual(repaired);
	});
});
