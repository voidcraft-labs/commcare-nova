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
import type { BlueprintDoc, CaseProperty, CaseType } from "@/lib/domain";
import {
	eq,
	gt,
	literal,
	multiSelectAny,
	prop,
} from "@/lib/domain/predicate/builders";
import { caseTypeToJsonSchema } from "@/lib/domain/predicate/jsonSchema";
import { proseText } from "@/lib/domain/prose";
import { buildSimpleBlueprint } from "../../__tests__/fixtures/simpleBlueprint";
import { runStoreContract } from "../../__tests__/storeContract";
import { CaseNotFoundError, CasePropertiesValidationError } from "../../errors";
import { HeuristicCaseGenerator } from "../../sample/heuristic";
import { setupPerTestDatabase } from "../../sql/__tests__/perTestDatabase";
import { compilePredicate } from "../../sql/compilePredicate";
import type { Database } from "../../sql/database";
import { buildCaseTypeMap } from "../../store";
import { caseSchemaIndexLockScope } from "../indexIdentity";
import { indexScopeTag, PostgresCaseStore, propertyIndexTag } from "../store";

/**
 * Compose the expected per-property index name — mirrors the
 * implementation's `indexName`
 * (`cases_<scopeTag>_<propertyTag>_<mode>`). Reuses the exported
 * fixed-width tags so the hashed segments can't drift from
 * production; only the readable `_<mode>` tail is literal here.
 */
function idxName(
	appId: string,
	caseType: string,
	property: string,
	mode: string,
): string {
	return `cases_${indexScopeTag(appId, caseType)}_${propertyIndexTag(property)}_${mode}`;
}

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

// ---------------------------------------------------------------
// Per-property expression-index DDL emission — Postgres-specific
// ---------------------------------------------------------------
//
// These tests live alongside the contract harness rather than
// inside it because the index-DDL discipline is Postgres-specific
// — the assertions read from `pg_indexes`, the catalog view a
// Postgres backend exposes. The contract harness covers behavioral
// assertions that every `CaseStore` implementation should satisfy
// (the fact that `applySchemaChange` produces the expected
// `MigrationReport` shape, that subsequent queries return the
// migrated rows). The catalog-shape probes that pin the exact
// `CREATE INDEX` set need direct table-row access — exposing pool
// access through the contract factory would force every
// implementation to hand out a connection handle the harness
// shouldn't need.

const APP_ID = "app-index-ddl";
const OWNER_A = "owner-a";
const OWNER_B = "owner-b";

/**
 * Probe `pg_indexes` for every per-property expression index on the
 * `cases` table for one `(appId, caseType)` scope. The LIKE prefix
 * `cases_<scopeTag>_%` is the exact app-scoped enumeration the
 * implementation's `readLiveIndexSet` uses — the fixed-width
 * `indexScopeTag` makes it match only this scope's indexes (never a
 * prefix-related case type's, never another app's); static
 * `case_indices_*_idx` lives on a different table and is excluded by
 * `tablename = 'cases'`. The `\_` escapes treat the convention's
 * underscores as literal characters rather than LIKE single-char
 * wildcards.
 */
async function readPropertyIndexes(
	pool: import("pg").Pool,
	appId: string,
	caseType: string,
): Promise<{ name: string; def: string }[]> {
	const result = await pool.query<{ indexname: string; indexdef: string }>(
		`SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'cases' AND indexname LIKE $1 ESCAPE '\\' ORDER BY indexname`,
		[`cases\\_${indexScopeTag(appId, caseType)}\\_%`],
	);
	return result.rows.map((r) => ({ name: r.indexname, def: r.indexdef }));
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
 * defaults to the Project id — these index-DDL tests are app-scoped and
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
			(await store.query({ appId: APP_ID, caseType: "visit", parentCases }))
				.map((row) => row.case_id)
				.sort(),
		).toEqual(["visit-a", "visit-b"]);
		expect(
			await store.count({ appId: APP_ID, caseType: "visit", parentCases }),
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

describe("PostgresCaseStore — applySchemaChange index DDL", () => {
	// -----------------------------------------------------------
	// Property-by-data-type — the per-arm DDL shape verifications
	// -----------------------------------------------------------

	// -----------------------------------------------------------
	// Diff shapes — the verb-by-verb mutation paths
	// -----------------------------------------------------------

	it("creates indexes for every indexable property in the desired set on first call", async () => {
		const store = makeStore(OWNER_A);
		const properties: CaseProperty[] = [
			{ name: "name", label: proseText("Name"), data_type: "text" },
			{ name: "age", label: proseText("Age"), data_type: "int" },
			{ name: "weight", label: proseText("Weight"), data_type: "decimal" },
			{
				name: "tags",
				label: proseText("Tags"),
				data_type: "multi_select",
				options: [{ value: "a", label: proseText("A") }],
			},
			// Mixed in non-indexable types — they pass through silently
			// with no index emitted (single_select, date, geopoint).
			{
				name: "color",
				label: proseText("Color"),
				data_type: "single_select",
				options: [{ value: "red", label: proseText("Red") }],
			},
			{
				name: "logged_at",
				label: proseText("Logged at"),
				data_type: "datetime",
			},
			{ name: "started", label: proseText("Started"), data_type: "time" },
			{ name: "scheduled", label: proseText("Scheduled"), data_type: "date" },
			{ name: "home", label: proseText("Home"), data_type: "geopoint" },
		];
		const caseType: CaseType = { name: "patient", properties };
		await store.applySchemaChange({
			appId: APP_ID,
			caseType: "patient",
			caseTypeSchemas: buildSchemaMap(caseType),
		});

		const indexes = await readPropertyIndexes(dbHandle.pool, APP_ID, "patient");
		// One index per indexable property
		// (`cases_<scopeTag>_<propertyTag>_<mode>`). The non-indexable
		// types (single_select, date, geopoint) are absent. Both
		// segments are hashes, so the live set sorts by hash — compare
		// against the same-sorted expected set.
		const names = indexes.map((i) => i.name).sort();
		expect(names).toEqual(
			[
				idxName(APP_ID, "patient", "age", "int"),
				idxName(APP_ID, "patient", "name", "fuzzy"),
				idxName(APP_ID, "patient", "tags", "contains"),
				idxName(APP_ID, "patient", "weight", "num"),
			].sort(),
		);
		const definition = (property: string, mode: string) =>
			indexes.find((i) => i.name === idxName(APP_ID, "patient", property, mode))
				?.def;
		expect(definition("name", "fuzzy")).toMatch(/USING gin.*->>.*gin_trgm_ops/);
		expect(definition("age", "int")).toMatch(/USING btree.*::integer/);
		expect(definition("weight", "num")).toMatch(/USING btree.*::numeric/);
		expect(definition("tags", "contains")).toMatch(/USING gin.*->\s*'tags'/);
		expect(definition("tags", "contains")).not.toMatch(/jsonb_path_ops|->>/);
		for (const index of indexes) {
			expect(index.def).toContain("app_id = 'app-index-ddl'");
			expect(index.def).toContain("case_type = 'patient'");
		}
	});

	it("gives `external-field` and `external_field` distinct indexes (hashing removes the old name collision)", async () => {
		// The pre-hash naming transformed both to `..._external_field_...`
		// and collided; hashing the RAW property name keeps two distinct
		// properties distinct, so both get their own index.
		const store = makeStore(OWNER_A);
		const caseType: CaseType = {
			name: "patient",
			properties: [
				{
					name: "external-field",
					label: proseText("Hyphen"),
					data_type: "text",
				},
				{
					name: "external_field",
					label: proseText("Underscore"),
					data_type: "text",
				},
			],
		};
		await store.applySchemaChange({
			appId: APP_ID,
			caseType: "patient",
			caseTypeSchemas: buildSchemaMap(caseType),
		});
		const indexes = await readPropertyIndexes(dbHandle.pool, APP_ID, "patient");
		const names = indexes.map((i) => i.name).sort();
		for (const property of ["external-field", "external_field"]) {
			expect(
				indexes.find(
					(i) => i.name === idxName(APP_ID, "patient", property, "fuzzy"),
				)?.def,
			).toContain(`->> '${property}'`);
		}
		expect(names).toEqual(
			[
				idxName(APP_ID, "patient", "external-field", "fuzzy"),
				idxName(APP_ID, "patient", "external_field", "fuzzy"),
			].sort(),
		);
	});

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
		expect(await readPropertyIndexes(dbHandle.pool, APP_ID, "patient")).toEqual(
			[],
		);

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

	it("drops the index for a removed property on subsequent call", async () => {
		const store = makeStore(OWNER_A);
		const initial: CaseType = {
			name: "patient",
			properties: [
				{ name: "name", label: proseText("Name"), data_type: "text" },
				{ name: "age", label: proseText("Age"), data_type: "int" },
			],
		};
		await store.applySchemaChange({
			appId: APP_ID,
			caseType: "patient",
			caseTypeSchemas: buildSchemaMap(initial),
		});
		const beforeIndexes = await readPropertyIndexes(
			dbHandle.pool,
			APP_ID,
			"patient",
		);
		expect(beforeIndexes.map((i) => i.name).sort()).toEqual([
			idxName(APP_ID, "patient", "age", "int"),
			idxName(APP_ID, "patient", "name", "fuzzy"),
		]);

		// Remove `age`. The diff drops the btree index; the trgm
		// index for `name` stays.
		const reduced: CaseType = {
			name: "patient",
			properties: [
				{ name: "name", label: proseText("Name"), data_type: "text" },
			],
		};
		await store.applySchemaChange({
			appId: APP_ID,
			caseType: "patient",
			caseTypeSchemas: buildSchemaMap(reduced),
		});

		const afterIndexes = await readPropertyIndexes(
			dbHandle.pool,
			APP_ID,
			"patient",
		);
		expect(afterIndexes.map((i) => i.name)).toEqual([
			idxName(APP_ID, "patient", "name", "fuzzy"),
		]);
	});

	it("on retype: drops the old-type index and creates the new-type index", async () => {
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
		const before = await readPropertyIndexes(dbHandle.pool, APP_ID, "patient");
		expect(before.map((i) => i.name)).toEqual([
			idxName(APP_ID, "patient", "age", "fuzzy"),
		]);

		// Retype text → int. The diff drops the trgm index, creates
		// the btree expression index.
		const retyped: CaseType = {
			name: "patient",
			properties: [{ name: "age", label: proseText("Age"), data_type: "int" }],
		};
		await store.applySchemaChange({
			appId: APP_ID,
			caseType: "patient",
			caseTypeSchemas: buildSchemaMap(retyped),
			property: "age",
			change: { kind: "retype", fromType: "text", toType: "int" },
		});

		const after = await readPropertyIndexes(dbHandle.pool, APP_ID, "patient");
		expect(after.map((i) => i.name)).toEqual([
			idxName(APP_ID, "patient", "age", "int"),
		]);
		expect(after[0]?.def).toContain("::integer");
	});

	it("on int→decimal retype: rebuilds the btree index to the numeric cast and admits fractional values", async () => {
		// Regression (the `17.01` "Generate sample data" failure):
		// `int` and `decimal` once shared the `btree` index-name
		// suffix, so an `int → decimal` retype's name-keyed diff saw a
		// same-name match and KEPT the stale `::integer` expression
		// index. The next insert of a fractional value passed the
		// `{ type: "number" }` JSON Schema but failed the stale index
		// cast at write time with
		// `invalid input syntax for type integer: "17.01"`. The suffix
		// now encodes the cast, so the retype drops `_int` and creates
		// `_num`.
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
		const before = await readPropertyIndexes(dbHandle.pool, APP_ID, "patient");
		expect(before.map((i) => i.name)).toEqual([
			idxName(APP_ID, "patient", "weight", "int"),
		]);
		expect(before[0]?.def).toContain("::integer");

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

		// The stale `::integer` btree is gone; a `::numeric` btree
		// replaces it under the cast-encoded name.
		const after = await readPropertyIndexes(dbHandle.pool, APP_ID, "patient");
		expect(after.map((i) => i.name)).toEqual([
			idxName(APP_ID, "patient", "weight", "num"),
		]);
		expect(after[0]?.def).toContain("::numeric");
		expect(after[0]?.def).not.toContain("::integer");

		// The actual failure surface: a fractional decimal now inserts
		// cleanly instead of tripping a stale `::integer` index at
		// write time. Pre-fix, this insert threw the Postgres cast
		// error before returning.
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

		// The fractional value round-trips through the JSONB document
		// unchanged — the `::numeric` cast lives in the index
		// expression, not in the stored value.
		const rows = await store.query({ appId: APP_ID, caseType: "patient" });
		expect(rows).toHaveLength(1);
		expect(rows[0]?.properties.weight).toBe(17.01);
	});

	it("on retype that parks bad values: index DDL succeeds against the post-commit state", async () => {
		// The structural two-phase test: retype `text → int` against a
		// row carrying `"abc"` parks the value (its key drops from the
		// row), and the Phase-B `CREATE INDEX CONCURRENTLY` over the
		// `::integer` expression runs only against the post-commit row
		// population — where the uncastable value no longer exists
		// under the key, so the typed index builds cleanly.
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

		// Insert a castable row + a non-castable row. The trgm index
		// happily indexes both — text values fit the gin_trgm_ops
		// shape regardless of whether they look numeric.
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

		const indexes = await readPropertyIndexes(dbHandle.pool, APP_ID, "patient");
		expect(indexes.map((i) => i.name)).toEqual([
			idxName(APP_ID, "patient", "age", "int"),
		]);
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

	// -----------------------------------------------------------
	// Phase A atomicity — Phase A's transaction rolls back independent of Phase B
	// -----------------------------------------------------------

	it("Phase A rolls back atomically on per-row migration failure: schema row stays unchanged", async () => {
		// Sabotage the second `applySchemaChange` call by removing
		// `parked_case_values` from the database mid-flight — the
		// retype's park INSERT fails, and Phase A's transaction rolls
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
		// pre-call (text) shape because Phase A rolled back. Probe
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

		// The row's properties are also untouched. Phase A's
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

	it("caller-owned Phase A rolls back with its outer transaction", async () => {
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
				await store.applySchemaChangePhaseA(tx, {
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
		expect(await readPropertyIndexes(dbHandle.pool, APP_ID, "patient")).toEqual(
			[],
		);
	});

	it("caller-owned Phase B remains dormant until Phase A commits", async () => {
		const store = makeStore(OWNER_A);
		const caseType: CaseType = {
			name: "patient",
			properties: [
				{ name: "name", label: proseText("Name"), data_type: "text" },
			],
		};

		const caseDb = dbHandle.db as unknown as Kysely<Database>;
		const prepared = await caseDb.transaction().execute(async (tx) => {
			return await store.applySchemaChangePhaseA(tx, {
				appId: APP_ID,
				caseType: "patient",
				caseTypeSchemas: buildSchemaMap(caseType),
			});
		});

		const schema = await dbHandle.pool.query<{ count: string }>(
			`SELECT count(*)::text AS count
			 FROM case_type_schemas
			 WHERE app_id = $1 AND case_type = $2`,
			[APP_ID, "patient"],
		);
		expect(schema.rows[0]?.count).toBe("1");
		expect(await readPropertyIndexes(dbHandle.pool, APP_ID, "patient")).toEqual(
			[],
		);

		await prepared.completeAfterCommit();
		expect(
			(await readPropertyIndexes(dbHandle.pool, APP_ID, "patient")).map(
				(index) => index.name,
			),
		).toEqual([idxName(APP_ID, "patient", "name", "fuzzy")]);
	});

	// -----------------------------------------------------------
	// Pre-flight identifier validation — runs BEFORE Phase A opens
	// -----------------------------------------------------------

	it("identifier-shape errors surface BEFORE Phase A's transaction opens", async () => {
		// `computeDesiredIndexSet` runs synchronously at the top of
		// `applySchemaChange`, before any I/O. A property name with
		// characters outside the identifier vocabulary throws during
		// pre-flight (`assertSafeIdentifierFragment` inside `indexName`);
		// `case_type_schemas` is never written. (Name length no longer
		// matters — both name segments are fixed-width hashes.)
		const store = makeStore(OWNER_A);
		// Seed the schema row with no properties so the failure
		// path can compare against a known-good baseline.
		await store.applySchemaChange({
			appId: APP_ID,
			caseType: "patient",
			caseTypeSchemas: buildSchemaMap({ name: "patient", properties: [] }),
		});

		// A property name with a space violates `CASE_PROPERTY_PATTERN`.
		const badPropertyName = "has a space";
		const caseType: CaseType = {
			name: "patient",
			properties: [
				{ name: badPropertyName, label: proseText("X"), data_type: "text" },
			],
		};
		await expect(
			store.applySchemaChange({
				appId: APP_ID,
				caseType: "patient",
				caseTypeSchemas: buildSchemaMap(caseType),
			}),
		).rejects.toThrow(/characters other than/);

		// `case_type_schemas` carries the pre-call shape (empty
		// properties), NOT the bad property. Pre-flight caught the
		// error before Phase A's UPSERT ran.
		const schemaRow = await dbHandle.pool.query<{ schema: unknown }>(
			"SELECT schema FROM case_type_schemas WHERE app_id = $1 AND case_type = $2",
			[APP_ID, "patient"],
		);
		const schema = schemaRow.rows[0]?.schema as {
			properties: Record<string, unknown>;
		};
		expect(Object.keys(schema.properties)).not.toContain(badPropertyName);
		expect(Object.keys(schema.properties)).toEqual([]);

		// No indexes were created either — the identifier check
		// fires before any DDL statement reaches the engine; this
		// assertion pins that ordering.
		const indexes = await readPropertyIndexes(dbHandle.pool, APP_ID, "patient");
		expect(indexes).toHaveLength(0);
	});

	// -----------------------------------------------------------
	// Phase B engine failure — Phase A intact, retry converges
	// -----------------------------------------------------------

	it("Phase B engine failure leaves Phase A intact; next call converges the index set", async () => {
		// Drop the `pg_trgm` extension before calling
		// `applySchemaChange` for a text property. Phase B's
		// CREATE INDEX needs the `gin_trgm_ops` opclass `pg_trgm`
		// provides; without it, the engine throws "operator class
		// gin_trgm_ops does not exist". Phase A's transaction has
		// already committed by the time Phase B runs, so the
		// schema row is preserved. Re-installing the extension and
		// re-calling `applySchemaChange` drives Phase B to
		// convergence — the catalog diff re-derives the missing
		// CREATE INDEX.
		const store = makeStore(OWNER_A);
		await store.applySchemaChange({
			appId: APP_ID,
			caseType: "patient",
			caseTypeSchemas: buildSchemaMap({ name: "patient", properties: [] }),
		});

		// Drop the extension. Production never does this; the test
		// drops it to manufacture an engine-level failure for the
		// CREATE INDEX statement.
		await dbHandle.pool.query("DROP EXTENSION pg_trgm CASCADE");

		// Add the `name` property. Phase A's UPSERT commits the
		// new schema; Phase B's CREATE INDEX with `gin_trgm_ops`
		// fails because the extension is gone. The throw is the
		// typed Phase-B wrapper (its `cause` carries the engine
		// fault) so callers retain the committed Phase-A report —
		// parked ids and all — across the failure.
		const caseType: CaseType = {
			name: "patient",
			properties: [
				{ name: "name", label: proseText("Name"), data_type: "text" },
			],
		};
		await expect(
			store.applySchemaChange({
				appId: APP_ID,
				caseType: "patient",
				caseTypeSchemas: buildSchemaMap(caseType),
			}),
		).rejects.toMatchObject({
			name: "SchemaChangePhaseBError",
			report: { parkedIds: [] },
			cause: expect.objectContaining({
				message: expect.stringMatching(/gin_trgm_ops|pg_trgm|trgm/i),
			}),
		});

		// Phase A's commit is intact: the schema row carries the
		// new `name` property, even though Phase B failed.
		const schemaRow = await dbHandle.pool.query<{ schema: unknown }>(
			"SELECT schema FROM case_type_schemas WHERE app_id = $1 AND case_type = $2",
			[APP_ID, "patient"],
		);
		const schema = schemaRow.rows[0]?.schema as {
			properties: Record<string, unknown>;
		};
		expect(Object.keys(schema.properties)).toContain("name");

		// No `cases_patient_*` indexes exist yet — Phase B's
		// failure prevented the CREATE INDEX from landing.
		const beforeRetry = await readPropertyIndexes(
			dbHandle.pool,
			APP_ID,
			"patient",
		);
		expect(beforeRetry).toHaveLength(0);

		// Re-install the extension — simulating an operator's
		// recovery action — and re-run `applySchemaChange` with
		// the same blueprint. Phase A's UPSERT is a no-op (schema
		// unchanged); Phase B's catalog diff finds the missing
		// trgm-GIN entry and creates it. The retry converges the
		// index state.
		await dbHandle.pool.query("CREATE EXTENSION pg_trgm");
		await store.applySchemaChange({
			appId: APP_ID,
			caseType: "patient",
			caseTypeSchemas: buildSchemaMap(caseType),
		});

		const afterRetry = await readPropertyIndexes(
			dbHandle.pool,
			APP_ID,
			"patient",
		);
		expect(afterRetry.map((i) => i.name)).toEqual([
			idxName(APP_ID, "patient", "name", "fuzzy"),
		]);
		expect(afterRetry[0]?.def).toMatch(/USING gin/);
		expect(afterRetry[0]?.def).toContain("gin_trgm_ops");
	});

	// -----------------------------------------------------------
	// INVALID-index recovery — drop-and-recreate on next retry
	// -----------------------------------------------------------

	it("drops and recreates an INVALID index left by a failed CONCURRENTLY build on the next retry", async () => {
		// `CREATE INDEX CONCURRENTLY` failures (lock conflict,
		// deadlock, disk full, cancelled mid-build) leave the
		// partially-built index visible in the catalog with
		// `pg_index.indisvalid = false`. Postgres treats an INVALID
		// index as "possibly incomplete: it must still be modified by
		// INSERT/UPDATE operations, but it cannot safely be used for
		// queries" (per
		// `https://www.postgresql.org/docs/current/catalog-pg-index.html`).
		// The diff captures `indisvalid` and emits a drop-and-recreate
		// pair for any INVALID artifact so the next `applySchemaChange`
		// call recovers the index without operator intervention.
		//
		// Manufacturing an INVALID index in test goes through the
		// catalog directly: `UPDATE pg_index SET indisvalid = false`
		// against the index's `indexrelid`. The testcontainer's
		// superuser has the privilege; production's IAM-auth runtime
		// SA does not, which is correct (no production code path
		// writes to `pg_index`). The catalog mutation simulates the
		// engine state a real CONCURRENTLY failure would leave.
		const store = makeStore(OWNER_A);
		// The app-scoped index name the raw catalog probes below target.
		const fuzzyIndex = idxName(APP_ID, "patient", "name", "fuzzy");

		// Establish a healthy text-fuzzy index for the `name` property.
		const caseTypeSchemas = buildSchemaMap({
			name: "patient",
			properties: [
				{ name: "name", label: proseText("Name"), data_type: "text" },
			],
		});
		await store.applySchemaChange({
			appId: APP_ID,
			caseType: "patient",
			caseTypeSchemas,
		});

		// Confirm the index is present and valid before the catalog
		// mutation, otherwise a regression in the create path would
		// silently masquerade as a recovery success.
		const beforeMutation = await dbHandle.pool.query<{ indisvalid: boolean }>(
			`SELECT i.indisvalid
			   FROM pg_index i
			   JOIN pg_class c ON c.oid = i.indexrelid
			  WHERE c.relname = '${fuzzyIndex}'`,
		);
		expect(beforeMutation.rows[0]?.indisvalid).toBe(true);

		// Mark the index INVALID in the catalog. The cast through
		// `pg_class.oid` resolves the index's catalog id by name.
		await dbHandle.pool.query(
			`UPDATE pg_index
			    SET indisvalid = false
			  WHERE indexrelid = (
			    SELECT oid FROM pg_class WHERE relname = '${fuzzyIndex}'
			  )`,
		);

		// Verify the catalog mutation took effect — the test only
		// proves recovery if the precondition is real.
		const afterMutation = await dbHandle.pool.query<{ indisvalid: boolean }>(
			`SELECT i.indisvalid
			   FROM pg_index i
			   JOIN pg_class c ON c.oid = i.indexrelid
			  WHERE c.relname = '${fuzzyIndex}'`,
		);
		expect(afterMutation.rows[0]?.indisvalid).toBe(false);

		// Re-run `applySchemaChange` with the same schema map. The
		// diff reads the catalog, sees the INVALID entry, emits a
		// drop + create pair, and converges the live set with the
		// desired set.
		await store.applySchemaChange({
			appId: APP_ID,
			caseType: "patient",
			caseTypeSchemas,
		});

		// The recovered index exists, is valid, and has the same
		// trgm-GIN shape the create path emits.
		const recovered = await dbHandle.pool.query<{
			indisvalid: boolean;
			indexdef: string;
		}>(
			`SELECT i.indisvalid, pg_get_indexdef(i.indexrelid) AS indexdef
			   FROM pg_index i
			   JOIN pg_class c ON c.oid = i.indexrelid
			  WHERE c.relname = '${fuzzyIndex}'`,
		);
		expect(recovered.rows).toHaveLength(1);
		expect(recovered.rows[0]?.indisvalid).toBe(true);
		expect(recovered.rows[0]?.indexdef).toMatch(/USING gin/);
		expect(recovered.rows[0]?.indexdef).toContain("gin_trgm_ops");

		// One index — not two. A regression that emitted a CREATE
		// without the corresponding DROP would leave both the INVALID
		// stub and the new index in the catalog with the same name.
		// `pg_class.relname` is unique within a schema, so the engine
		// would actually reject the CREATE in that scenario; this
		// assertion pins that the recovery path takes the
		// drop-then-create branch rather than relying on engine-side
		// uniqueness as the safety net.
		const finalSet = await readPropertyIndexes(
			dbHandle.pool,
			APP_ID,
			"patient",
		);
		expect(finalSet.map((i) => i.name)).toEqual([
			idxName(APP_ID, "patient", "name", "fuzzy"),
		]);
	});

	// -----------------------------------------------------------
	// The catalog read resolves `cases` through the search path
	// -----------------------------------------------------------

	it("keeps diffing when `cases` lives outside `current_schema()` (production's converged schema)", async () => {
		// Production's privilege convergence moves `cases` into an
		// isolated schema (`nova_case_runtime`) so the runtime role holds
		// `CREATE` nowhere else, while every connection keeps the search
		// path `public,<isolated>` — `public` first, so fixed/auth objects
		// still resolve and get created there. `current_schema()` is
		// therefore `public`, and `cases` is NOT in it.
		//
		// A catalog read keyed on `current_schema()` returns zero rows
		// under that shape, which makes the live set look empty: the diff
		// re-`CREATE`s every desired index (the second sync of a case type
		// dies on `already exists`, and every create queued behind it is
		// skipped) and never emits a drop. This test reproduces the
		// production shape locally so the read stays keyed on the same
		// search-path resolution the DDL uses.
		const isolated = "nova_case_runtime";
		await dbHandle.pool.query(`CREATE SCHEMA ${isolated}`);
		await dbHandle.pool.query(
			`ALTER TABLE public.cases SET SCHEMA ${isolated}`,
		);
		// Session-level for the connection in hand and database-level for
		// any reconnect — the pool holds one connection, but an idle
		// recycle mid-test must not silently restore the default path.
		await dbHandle.pool.query(
			`ALTER DATABASE ${dbHandle.databaseName} SET search_path TO public, ${isolated}`,
		);
		await dbHandle.pool.query(`SET search_path TO public, ${isolated}`);

		// The precondition IS the scenario: assert it rather than trust
		// the DDL above, so a future engine/helper change that leaves
		// `cases` on `current_schema()` fails here instead of passing the
		// whole test vacuously.
		const placement = await dbHandle.pool.query<{
			current: string;
			cases_schema: string;
		}>(
			`SELECT current_schema() AS current,
			        (SELECT n.nspname FROM pg_class c
			           JOIN pg_namespace n ON n.oid = c.relnamespace
			          WHERE c.oid = to_regclass('cases')) AS cases_schema`,
		);
		expect(placement.rows[0]?.current).toBe("public");
		expect(placement.rows[0]?.cases_schema).toBe(isolated);

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

		// Second sync of the SAME case type. With a blind read this throws
		// `already exists` re-creating `name`'s index, and `age` never gets
		// one because the create loop aborts on the first duplicate.
		await store.applySchemaChange({
			appId: APP_ID,
			caseType: "patient",
			caseTypeSchemas: buildSchemaMap({
				name: "patient",
				properties: [
					{ name: "name", label: proseText("Name"), data_type: "text" },
					{ name: "age", label: proseText("Age"), data_type: "int" },
				],
			}),
		});
		expect(
			(await readPropertyIndexes(dbHandle.pool, APP_ID, "patient"))
				.map((i) => i.name)
				.sort(),
		).toEqual([
			idxName(APP_ID, "patient", "age", "int"),
			idxName(APP_ID, "patient", "name", "fuzzy"),
		]);

		// The drop half of the diff: an empty live set emits no drops at
		// all, so a removed property's index would survive forever.
		await store.applySchemaChange({
			appId: APP_ID,
			caseType: "patient",
			caseTypeSchemas: buildSchemaMap({
				name: "patient",
				properties: [
					{ name: "age", label: proseText("Age"), data_type: "int" },
				],
			}),
		});
		expect(
			(await readPropertyIndexes(dbHandle.pool, APP_ID, "patient")).map(
				(i) => i.name,
			),
		).toEqual([idxName(APP_ID, "patient", "age", "int")]);
	});

	// -----------------------------------------------------------
	// Additive (no-`change`) call still emits indexes
	// -----------------------------------------------------------

	it("additive call (no-`change`) emits index DDL for newly added properties", async () => {
		// The no-`change` path: schema sync runs, per-row migration
		// is skipped, and Phase B still runs the index sync.
		// Verifies the early-return for the no-`change` path doesn't
		// short-circuit Phase B.
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

		// Add a second property. Additive mutation — no `change`
		// arg supplied. Phase B still emits the new index.
		await store.applySchemaChange({
			appId: APP_ID,
			caseType: "patient",
			caseTypeSchemas: buildSchemaMap({
				name: "patient",
				properties: [
					{ name: "name", label: proseText("Name"), data_type: "text" },
					{ name: "age", label: proseText("Age"), data_type: "int" },
				],
			}),
		});

		const indexes = await readPropertyIndexes(dbHandle.pool, APP_ID, "patient");
		expect(indexes.map((i) => i.name).sort()).toEqual([
			idxName(APP_ID, "patient", "age", "int"),
			idxName(APP_ID, "patient", "name", "fuzzy"),
		]);
	});

	it("compiled numeric and multi-select predicates can use their expression indexes", async () => {
		const appId = "app-explain";
		const caseType: CaseType = {
			name: "patient",
			properties: [
				{ name: "age", label: proseText("Age"), data_type: "int" },
				{ name: "weight", label: proseText("Weight"), data_type: "decimal" },
				{
					name: "tags",
					label: proseText("Tags"),
					data_type: "multi_select",
					options: [{ value: "red", label: proseText("Red") }],
				},
			],
		};
		const schemas = buildCaseTypeMap(buildSimpleBlueprint([caseType], appId));
		await makeStore(OWNER_A).applySchemaChange({
			appId,
			caseType: "patient",
			caseTypeSchemas: schemas,
		});
		await dbHandle.pool.query(
			`INSERT INTO cases(case_id,app_id,project_id,owner_id,case_type,case_name,properties)
            SELECT gen_random_uuid(),$1,'owner-a','owner-a','patient','Person '||i,
            jsonb_build_object('age',i,'weight',i+0.5,'tags',CASE WHEN i%7=0 THEN '["red"]'::jsonb ELSE '[]'::jsonb END)
            FROM generate_series(1,2000) i`,
			[appId],
		);
		await dbHandle.pool.query("VACUUM ANALYZE cases");
		const probes = [
			{
				predicate: gt(prop("patient", "age"), literal(50)),
				property: "age",
				mode: "int",
			},
			{
				predicate: gt(prop("patient", "weight"), literal(75.5)),
				property: "weight",
				mode: "num",
			},
			{
				predicate: multiSelectAny(prop("patient", "tags"), literal("red")),
				property: "tags",
				mode: "contains",
			},
		];
		const client = await dbHandle.pool.connect();
		try {
			// Assert index eligibility independently of this small fixture's cost estimate.
			await client.query("SET enable_seqscan = off");
			for (const probe of probes) {
				const query = (dbHandle.db as Kysely<Database>)
					.selectFrom("cases as c")
					.selectAll()
					.where("c.app_id", "=", appId)
					.where("c.project_id", "=", OWNER_A)
					.where("c.case_type", "=", "patient")
					.where(
						compilePredicate(probe.predicate, {
							db: dbHandle.db,
							appId,
							projectId: OWNER_A,
							anchorAlias: "c",
							currentCaseType: "patient",
							caseTypeSchemas: schemas,
							bindings: {},
						}),
					)
					.compile();
				const result = await client.query<{ "QUERY PLAN": string }>(
					`EXPLAIN ${query.sql}`,
					[...query.parameters],
				);
				const plan = result.rows.map((row) => row["QUERY PLAN"]).join("\n");
				expect(plan).toContain(
					idxName(appId, "patient", probe.property, probe.mode),
				);
				expect(plan).toContain("Index Cond");
				if (probe.mode === "contains") expect(plan).toMatch(/Index Cond.*\?\|/);
			}
		} finally {
			try {
				await client.query("RESET enable_seqscan");
			} finally {
				client.release();
			}
		}
	});

	// -----------------------------------------------------------
	// Tenant scope — index DDL is shared across owners
	// -----------------------------------------------------------

	it("repeated schema sync by another Project member preserves the index set", async () => {
		const storeA = makeStore("owner-a");
		const storeB = makeStore("owner-a", "owner-b");
		await storeA.applySchemaChange({
			appId: APP_ID,
			caseType: "patient",
			caseTypeSchemas: buildSchemaMap({
				name: "patient",
				properties: [
					{ name: "name", label: proseText("Name"), data_type: "text" },
				],
			}),
		});

		const seenByA = await readPropertyIndexes(dbHandle.pool, APP_ID, "patient");
		expect(seenByA.map((i) => i.name)).toEqual([
			idxName(APP_ID, "patient", "name", "fuzzy"),
		]);

		await storeB.applySchemaChange({
			appId: APP_ID,
			caseType: "patient",
			caseTypeSchemas: buildSchemaMap({
				name: "patient",
				properties: [
					{ name: "name", label: proseText("Name"), data_type: "text" },
				],
			}),
		});
		const seenByB = await readPropertyIndexes(dbHandle.pool, APP_ID, "patient");
		expect(seenByB.map((i) => i.name)).toEqual([
			idxName(APP_ID, "patient", "name", "fuzzy"),
		]);
	});

	it("two apps sharing a case-type + property name with different data_types stay independent", async () => {
		// Regression: index names AND the partial predicate were keyed
		// only on `case_type` (not app_id), so App A's `patient.weight`
		// int index and App B's `patient.weight` decimal index collided
		// on ONE global index. Whichever app materialized last won, and
		// its cast then evaluated the OTHER app's rows: App A's
		// `::integer` index rejected App B's own fractional sample data
		// with `invalid input syntax for type integer: "17.01"`.
		// App-scoping (name tag + `app_id` in the predicate) makes the
		// two indexes fully independent.
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

		// Both indexes coexist under distinct, app-scoped names — App
		// A's materialize did NOT drop App B's index. Each app's scope
		// tag enumerates only its own index.
		const aNames = (
			await readPropertyIndexes(dbHandle.pool, appA, "patient")
		).map((i) => i.name);
		const bNames = (
			await readPropertyIndexes(dbHandle.pool, appB, "patient")
		).map((i) => i.name);
		expect(aNames).toEqual([idxName(appA, "patient", "weight", "int")]);
		expect(bNames).toEqual([idxName(appB, "patient", "weight", "num")]);

		// App B inserts its own fractional weight: under the old global
		// `::integer` index this threw; the app-scoped `::numeric`
		// index admits it because App A's int index's predicate
		// (`app_id = 'app-cross-a'`) excludes App B's row.
		await store.insert({
			appId: appB,
			row: {
				case_id: "70000000-0000-0000-0000-000000000001",
				case_type: "patient",
				case_name: "b-frac",
				properties: { weight: 17.01 },
			},
		});
		// App A inserts an integer weight against its own index.
		await store.insert({
			appId: appA,
			row: {
				case_id: "70000000-0000-0000-0000-000000000002",
				case_type: "patient",
				case_name: "a-int",
				properties: { weight: 42 },
			},
		});

		const bRows = await store.query({ appId: appB, caseType: "patient" });
		const aRows = await store.query({ appId: appA, caseType: "patient" });
		expect(bRows).toHaveLength(1);
		expect(aRows).toHaveLength(1);
		expect(bRows[0]?.properties.weight).toBe(17.01);
	});

	it("a case type whose name is a prefix of another's does not drop the other's indexes on diff", async () => {
		// `patient` is a name-prefix of `patient_visit`. A name prefix
		// built from the literal case type (`..._patient_%`) would match
		// both; the fixed-width `indexScopeTag` instead hashes
		// `(app, case_type)` to DISTINCT tags, so re-materializing
		// `patient` enumerates only its own scope and can't see
		// `patient_visit`'s index as a stray to drop.
		const store = makeStore(OWNER_A);
		const patientSchema = buildSchemaMap({
			name: "patient",
			properties: [{ name: "age", label: proseText("Age"), data_type: "int" }],
		});
		await store.applySchemaChange({
			appId: APP_ID,
			caseType: "patient",
			caseTypeSchemas: patientSchema,
		});
		await store.applySchemaChange({
			appId: APP_ID,
			caseType: "patient_visit",
			caseTypeSchemas: buildSchemaMap({
				name: "patient_visit",
				properties: [
					{ name: "age", label: proseText("Age"), data_type: "int" },
				],
			}),
		});

		// Re-materialize `patient` (additive, identical schema). Its
		// diff must leave `patient_visit`'s index untouched.
		await store.applySchemaChange({
			appId: APP_ID,
			caseType: "patient",
			caseTypeSchemas: patientSchema,
		});

		const patientNames = (
			await readPropertyIndexes(dbHandle.pool, APP_ID, "patient")
		).map((i) => i.name);
		const visitNames = (
			await readPropertyIndexes(dbHandle.pool, APP_ID, "patient_visit")
		).map((i) => i.name);
		expect(patientNames).toEqual([idxName(APP_ID, "patient", "age", "int")]);
		expect(visitNames).toEqual([
			idxName(APP_ID, "patient_visit", "age", "int"),
		]);
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
			await store.query({ appId: APP_ID, caseType: "patient" })
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

		const [row] = await store.query({ appId: APP_ID, caseType: "patient" });
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
			ordinary: {
				kind: "registration",
				primary: { caseType: "patient", caseName: "Mary", properties: {} },
				children: [
					{
						caseType: "medication_order",
						caseName: "Rifampin",
						properties: {},
					},
				],
			},
		});

		for (const name of ["patient", "medication_order"]) {
			const [row] = await store.query({ appId: APP_ID, caseType: name });
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

		const [row] = await store.query({ appId: APP_ID, caseType: "patient" });
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
// `int` compiles to Postgres `integer` (int4). A bare `{ type:
// "integer" }` JSON Schema accepts any integer, but the write-side
// expression index's `(properties->>'k')::integer` cast rejects
// anything outside int4's signed-32-bit range with a raw
// `integer out of range` error at INSERT — the same "AJV accepts,
// the cast rejects" class as a fractional value under an int index.
// The schema's int4 bound closes that gap.

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
		// not a raw `integer out of range` 500 from the index cast.
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

	it("fully no-ops a stale lower-seq sync — schema row AND its expression index untouched", async () => {
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
		const indexesBefore = await readPropertyIndexes(
			dbHandle.pool,
			SEQ_APP,
			"patient",
		);
		expect(indexesBefore).toHaveLength(2);

		// A stale sync at seq 2 with only the OLDER one-property schema must
		// no-op the whole call — the row keeps its seq-5 shape and both
		// expression indexes survive (the Phase-B index-DDL skip is part of
		// the full-call no-op).
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
		const indexesAfter = await readPropertyIndexes(
			dbHandle.pool,
			SEQ_APP,
			"patient",
		);
		expect(indexesAfter.map((i) => i.name)).toEqual(
			indexesBefore.map((i) => i.name),
		);
	});

	it("contending schema syncs recover transient DDL failures and preserve the latest sequence", async () => {
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
				(await readPropertyIndexes(dbHandle.pool, SEQ_APP, "patient"))
					.map((i) => i.name)
					.sort(),
			).toEqual(
				[
					idxName(SEQ_APP, "patient", "name", "fuzzy"),
					idxName(SEQ_APP, "patient", "village", "fuzzy"),
				].sort(),
			);
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
			(await store.query({ appId: APP_ID, caseType: "patient" }))[0]
				?.properties,
		).toEqual({ name: "Alice", age: "30" });
		await store.update({
			appId: APP_ID,
			caseId,
			patch: { properties: { name: "Alicia" } },
		});
		const repaired = await store.query({ appId: APP_ID, caseType: "patient" });
		expect(repaired[0]?.properties).toEqual({ name: "Alicia" });
		await expect(
			store.update({
				appId: APP_ID,
				caseId,
				patch: { properties: { bogus: "x" } },
			}),
		).rejects.toBeInstanceOf(CasePropertiesValidationError);
		expect(await store.query({ appId: APP_ID, caseType: "patient" })).toEqual(
			repaired,
		);
	});
});
