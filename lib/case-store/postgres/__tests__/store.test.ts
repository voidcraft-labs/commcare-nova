// lib/case-store/postgres/__tests__/store.test.ts
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
// Per-test databases give every test its own engine state without
// any outer-transaction wrapping. Each test pays for `CREATE
// DATABASE` + `CREATE EXTENSION` + `atlas migrate apply` once
// (~50 ms on a modern laptop) but the store's transaction-using
// methods execute as authored.
//
// `setupPerTestDatabase` is the canonical fresh-database helper in
// this package; see `lib/case-store/sql/__tests__/perTestDatabase.ts`
// for the contract.
//
// ## Why migrations run inside `beforeEach`, not the helper
//
// `setupPerTestDatabase` provisions the database + installs
// extensions; it does NOT apply migrations. The store needs every
// case-store table to exist before any method runs, so this file
// shells out to `atlas migrate apply --env testcontainer
// --url <perTestUri> --allow-dirty` in a sibling `beforeEach`
// after the database handle is provisioned.
//
// The split mirrors the production split between Cloud SQL
// provisioning (Phase 5 of the runbook installs extensions under
// `postgres` superuser) and migration application (Cloud Run
// startup CMD under the IAM-auth runtime SA). In tests, the
// helper plays the role of the superuser provisioning; the atlas
// shell-out plays the role of the Cloud Run startup migration.

import type { Kysely } from "kysely";
import { beforeEach, describe, expect, it } from "vitest";
import type { BlueprintDoc, CaseProperty, CaseType } from "@/lib/domain";
import { buildSimpleBlueprint } from "../../__tests__/fixtures/simpleBlueprint";
import { runStoreContract } from "../../__tests__/storeContract";
import { HeuristicCaseGenerator } from "../../sample/heuristic";
import { applyMigrationsViaAtlas } from "../../sql/__tests__/applyMigrationsViaAtlas";
import { setupPerTestDatabase } from "../../sql/__tests__/perTestDatabase";
import type { Database } from "../../sql/database";
import { PostgresCaseStore } from "../store";

// ---------------------------------------------------------------
// Per-test database lifecycle
// ---------------------------------------------------------------
//
// `setupPerTestDatabase` wires `beforeEach` / `afterEach` for
// `CREATE DATABASE store_test_<rand>` + `DROP DATABASE WITH
// (FORCE)`. The default extension set (`pg_trgm`,
// `fuzzystrmatch`, `postgis`) is what the store's compiler stack
// expects — production parity.
//
// The handle's `db` field is a `Kysely<unknown>` from the helper;
// the store's constructor wants `Kysely<Database>`. The cast at
// the construction call site is the established pattern —
// `Kysely<unknown>` is the schema-mid-creation shape; once atlas
// has applied the migrations, the database matches `Database`'s
// contract.

const dbHandle = setupPerTestDatabase({
	databaseNamePrefix: "store_test_",
});

// ---------------------------------------------------------------
// Apply migrations before every test
// ---------------------------------------------------------------
//
// The contract harness exercises every method on the live
// database. All four case-store tables (`cases`,
// `case_type_schemas`, `case_indices`, `cases_quarantine`) must
// exist before the first method call — `atlas migrate apply` is
// the canonical path that creates them.
//
// The shared `applyMigrationsViaAtlas` helper handles the shell-
// out; this site uses `stdio: "pipe"` so atlas's per-test output
// stays out of the test runner's stderr (the dozens of per-test
// applies would otherwise drown the actual test results) and
// surfaces only inside any failure message. The call runs inside
// `beforeEach` so each test starts with a fresh-migrated
// database. Vitest fires this `beforeEach` AFTER the helper's own
// `beforeEach` (Vitest hooks run in registration order); when
// this body executes, `dbHandle.uri` is bound to the freshly-
// created per-test database.

beforeEach(() => {
	applyMigrationsViaAtlas(dbHandle.uri, { stdio: "pipe" });
});

// ---------------------------------------------------------------
// Wire the contract harness to PostgresCaseStore
// ---------------------------------------------------------------
//
// The harness consumes a factory that constructs a `CaseStore`
// for a supplied owner id. Bypassing `withOwnerContext` lets
// tests bind against the per-test handle rather than the
// production singleton — the factory is production-only by
// design.
//
// `dbHandle.db` is `Kysely<unknown>`; the store constructor
// wants `Kysely<Database>`. The cast is type-only — the runtime
// shape after `atlas migrate apply` matches `Database` exactly.

runStoreContract({
	describeName: "PostgresCaseStore",
	factory: async (ownerId: string) => {
		return new PostgresCaseStore({
			ownerId,
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

/**
 * Probe `pg_indexes` for every per-property expression index on the
 * `cases` table whose name starts with the case-type prefix. The
 * filter mirrors the `cases_<case_type>_%` shape the implementation
 * uses for its own diff scan, so the test sees exactly the indexes
 * Task 8 owns and not the static `case_indices_*_idx` set the
 * schema bakes in.
 */
async function readPropertyIndexes(
	pool: import("pg").Pool,
	caseType: string,
): Promise<{ name: string; def: string }[]> {
	const result = await pool.query<{ indexname: string; indexdef: string }>(
		`SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'cases' AND indexname LIKE $1 ORDER BY indexname`,
		[`cases_${caseType}_%`],
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
 * Construct a `PostgresCaseStore` for the supplied owner against
 * the per-test database. Keeping this in one helper keeps every
 * test below to a single line of setup before the meaningful
 * assertions.
 */
function makeStore(ownerId: string): PostgresCaseStore {
	return new PostgresCaseStore({
		ownerId,
		db: dbHandle.db as unknown as Kysely<Database>,
		sampleGenerator: new HeuristicCaseGenerator(),
	});
}

describe("PostgresCaseStore — applySchemaChange index DDL", () => {
	// -----------------------------------------------------------
	// Property-by-data-type — the per-arm DDL shape verifications
	// -----------------------------------------------------------

	it("emits a trgm GIN index for a text property", async () => {
		const store = makeStore(OWNER_A);
		const caseType: CaseType = {
			name: "patient",
			properties: [{ name: "name", label: "Name", data_type: "text" }],
		};
		await store.applySchemaChange({
			appId: APP_ID,
			caseType: "patient",
			blueprint: buildBlueprint(caseType),
		});

		const indexes = await readPropertyIndexes(dbHandle.pool, "patient");
		expect(indexes).toHaveLength(1);
		expect(indexes[0]?.name).toBe("cases_patient_name_fuzzy");
		// `gin_trgm_ops` opclass + `->>` text read + partial predicate.
		expect(indexes[0]?.def).toMatch(/USING gin/);
		expect(indexes[0]?.def).toContain("gin_trgm_ops");
		expect(indexes[0]?.def).toContain("->>");
		expect(indexes[0]?.def).toContain("WHERE");
	});

	it("emits a btree expression index for an int property", async () => {
		const store = makeStore(OWNER_A);
		const caseType: CaseType = {
			name: "patient",
			properties: [{ name: "age", label: "Age", data_type: "int" }],
		};
		await store.applySchemaChange({
			appId: APP_ID,
			caseType: "patient",
			blueprint: buildBlueprint(caseType),
		});

		const indexes = await readPropertyIndexes(dbHandle.pool, "patient");
		expect(indexes).toHaveLength(1);
		expect(indexes[0]?.name).toBe("cases_patient_age_btree");
		expect(indexes[0]?.def).toMatch(/USING btree/);
		// `(... ::integer)` — the cast token from
		// `POSTGRES_CAST_FOR_DATA_TYPE` for int data type.
		expect(indexes[0]?.def).toContain("::integer");
	});

	it("emits no expression index for date / datetime / time properties (Postgres STABLE-cast constraint)", async () => {
		// The `text → date` / `text → timestamptz` / `text → time`
		// casts are STABLE in Postgres (DateStyle / TimeZone session
		// dependency), and expression indexes require IMMUTABLE
		// expressions. Sequential scans on these data types' compare
		// / between operators are correct but slower; the fix needs a
		// Nova-owned IMMUTABLE wrapper function the query side also
		// uses — out of scope for Task 8.
		const store = makeStore(OWNER_A);
		const caseType: CaseType = {
			name: "visit",
			properties: [
				{ name: "scheduled", label: "Scheduled", data_type: "date" },
				{ name: "logged_at", label: "Logged at", data_type: "datetime" },
				{ name: "started", label: "Started", data_type: "time" },
			],
		};
		await store.applySchemaChange({
			appId: APP_ID,
			caseType: "visit",
			blueprint: buildBlueprint(caseType),
		});

		const indexes = await readPropertyIndexes(dbHandle.pool, "visit");
		expect(indexes).toHaveLength(0);
	});

	it("emits a jsonb_path_ops GIN index for a multi_select property using `->`", async () => {
		const store = makeStore(OWNER_A);
		const caseType: CaseType = {
			name: "patient",
			properties: [
				{
					name: "tags",
					label: "Tags",
					data_type: "multi_select",
					options: [
						{ value: "a", label: "A" },
						{ value: "b", label: "B" },
					],
				},
			],
		};
		await store.applySchemaChange({
			appId: APP_ID,
			caseType: "patient",
			blueprint: buildBlueprint(caseType),
		});

		const indexes = await readPropertyIndexes(dbHandle.pool, "patient");
		expect(indexes).toHaveLength(1);
		expect(indexes[0]?.name).toBe("cases_patient_tags_contains");
		expect(indexes[0]?.def).toMatch(/USING gin/);
		expect(indexes[0]?.def).toContain("jsonb_path_ops");
		// `->` (not `->>`) — multi_select returns jsonb to feed the
		// `?|` / `?&` / `@>` operators the predicate compiler emits.
		expect(indexes[0]?.def).toMatch(/->\s*'tags'/);
		expect(indexes[0]?.def).not.toMatch(/->>/);
	});

	it("emits a GiST index using ST_GeogFromText for a geopoint property", async () => {
		const store = makeStore(OWNER_A);
		const caseType: CaseType = {
			name: "patient",
			properties: [{ name: "home", label: "Home", data_type: "geopoint" }],
		};
		await store.applySchemaChange({
			appId: APP_ID,
			caseType: "patient",
			blueprint: buildBlueprint(caseType),
		});

		const indexes = await readPropertyIndexes(dbHandle.pool, "patient");
		expect(indexes).toHaveLength(1);
		expect(indexes[0]?.name).toBe("cases_patient_home_geo");
		expect(indexes[0]?.def).toMatch(/USING gist/);
		expect(indexes[0]?.def).toContain("st_geogfromtext");
	});

	it("emits no per-property index for a single_select property", async () => {
		// Single-select returns from the desired-set computation as
		// "no implied index" — equality on a small option set is
		// fast without an expression index, and an explicit Plan 4
		// mode declaration is the right place to add one if the
		// product calls for it.
		const store = makeStore(OWNER_A);
		const caseType: CaseType = {
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
		await store.applySchemaChange({
			appId: APP_ID,
			caseType: "patient",
			blueprint: buildBlueprint(caseType),
		});

		const indexes = await readPropertyIndexes(dbHandle.pool, "patient");
		expect(indexes).toHaveLength(0);
	});

	// -----------------------------------------------------------
	// Diff shapes — the verb-by-verb mutation paths
	// -----------------------------------------------------------

	it("creates indexes for every property in the desired set on first call", async () => {
		const store = makeStore(OWNER_A);
		const properties: CaseProperty[] = [
			{ name: "name", label: "Name", data_type: "text" },
			{ name: "age", label: "Age", data_type: "int" },
			{
				name: "tags",
				label: "Tags",
				data_type: "multi_select",
				options: [{ value: "a", label: "A" }],
			},
			{ name: "home", label: "Home", data_type: "geopoint" },
		];
		const caseType: CaseType = { name: "patient", properties };
		await store.applySchemaChange({
			appId: APP_ID,
			caseType: "patient",
			blueprint: buildBlueprint(caseType),
		});

		const indexes = await readPropertyIndexes(dbHandle.pool, "patient");
		// One index per property (single_select would be skipped, but
		// none in this fixture). Names follow the
		// `cases_<case_type>_<property>_<mode>` convention.
		const names = indexes.map((i) => i.name).sort();
		expect(names).toEqual([
			"cases_patient_age_btree",
			"cases_patient_home_geo",
			"cases_patient_name_fuzzy",
			"cases_patient_tags_contains",
		]);
	});

	it("drops the index for a removed property on subsequent call", async () => {
		const store = makeStore(OWNER_A);
		const initial: CaseType = {
			name: "patient",
			properties: [
				{ name: "name", label: "Name", data_type: "text" },
				{ name: "age", label: "Age", data_type: "int" },
			],
		};
		await store.applySchemaChange({
			appId: APP_ID,
			caseType: "patient",
			blueprint: buildBlueprint(initial),
		});
		const beforeIndexes = await readPropertyIndexes(dbHandle.pool, "patient");
		expect(beforeIndexes.map((i) => i.name).sort()).toEqual([
			"cases_patient_age_btree",
			"cases_patient_name_fuzzy",
		]);

		// Remove `age`. The diff drops the btree index; the trgm
		// index for `name` stays.
		const reduced: CaseType = {
			name: "patient",
			properties: [{ name: "name", label: "Name", data_type: "text" }],
		};
		await store.applySchemaChange({
			appId: APP_ID,
			caseType: "patient",
			blueprint: buildBlueprint(reduced),
		});

		const afterIndexes = await readPropertyIndexes(dbHandle.pool, "patient");
		expect(afterIndexes.map((i) => i.name)).toEqual([
			"cases_patient_name_fuzzy",
		]);
	});

	it("on rename: drops the old-name index and creates the new-name index", async () => {
		const store = makeStore(OWNER_A);
		const initial: CaseType = {
			name: "patient",
			properties: [{ name: "age", label: "Age", data_type: "int" }],
		};
		await store.applySchemaChange({
			appId: APP_ID,
			caseType: "patient",
			blueprint: buildBlueprint(initial),
		});

		// Rename `age` → `years`. Same data type, so the diff drops
		// `cases_patient_age_btree` and creates
		// `cases_patient_years_btree`.
		const renamed: CaseType = {
			name: "patient",
			properties: [{ name: "years", label: "Years", data_type: "int" }],
		};
		await store.applySchemaChange({
			appId: APP_ID,
			caseType: "patient",
			blueprint: buildBlueprint(renamed),
			property: "years",
			change: { kind: "rename", from: "age", to: "years" },
		});

		const indexes = await readPropertyIndexes(dbHandle.pool, "patient");
		expect(indexes.map((i) => i.name)).toEqual(["cases_patient_years_btree"]);
	});

	it("on retype: drops the old-type index and creates the new-type index", async () => {
		const store = makeStore(OWNER_A);
		const initial: CaseType = {
			name: "patient",
			properties: [{ name: "age", label: "Age", data_type: "text" }],
		};
		await store.applySchemaChange({
			appId: APP_ID,
			caseType: "patient",
			blueprint: buildBlueprint(initial),
		});
		const before = await readPropertyIndexes(dbHandle.pool, "patient");
		expect(before.map((i) => i.name)).toEqual(["cases_patient_age_fuzzy"]);

		// Retype text → int. The diff drops the trgm index, creates
		// the btree expression index.
		const retyped: CaseType = {
			name: "patient",
			properties: [{ name: "age", label: "Age", data_type: "int" }],
		};
		await store.applySchemaChange({
			appId: APP_ID,
			caseType: "patient",
			blueprint: buildBlueprint(retyped),
			property: "age",
			change: { kind: "retype", fromType: "text", toType: "int" },
		});

		const after = await readPropertyIndexes(dbHandle.pool, "patient");
		expect(after.map((i) => i.name)).toEqual(["cases_patient_age_btree"]);
		expect(after[0]?.def).toContain("::integer");
	});

	it("on retype that quarantines bad rows: index DDL succeeds against the post-commit state", async () => {
		// The structural test the dead-tuple investigation produced:
		// retype `text → int` against a row carrying `"abc"` would
		// fail an in-transaction `CREATE INDEX` because PostgreSQL's
		// non-CONCURRENTLY index builder uses `SnapshotAny` semantics
		// and includes the dead tuple from the same transaction's
		// quarantine DELETE. The two-phase split (tx for schema sync
		// + per-row migration → COMMIT → fresh-connection DDL) lets
		// the `CREATE INDEX` see only the post-commit row population.
		const store = makeStore(OWNER_A);
		const initial: CaseType = {
			name: "patient",
			properties: [{ name: "age", label: "Age", data_type: "text" }],
		};
		await store.applySchemaChange({
			appId: APP_ID,
			caseType: "patient",
			blueprint: buildBlueprint(initial),
		});

		// Insert a castable row + a non-castable row. The trgm index
		// happily indexes both — text values fit the gin_trgm_ops
		// shape regardless of whether they look numeric.
		await store.insert({
			appId: APP_ID,
			row: {
				case_id: "30000000-0000-0000-0000-000000000001",
				case_type: "patient",
				properties: { age: "30" },
			},
		});
		await store.insert({
			appId: APP_ID,
			row: {
				case_id: "30000000-0000-0000-0000-000000000002",
				case_type: "patient",
				properties: { age: "abc" },
			},
		});

		const retyped: CaseType = {
			name: "patient",
			properties: [{ name: "age", label: "Age", data_type: "int" }],
		};
		const report = await store.applySchemaChange({
			appId: APP_ID,
			caseType: "patient",
			blueprint: buildBlueprint(retyped),
			property: "age",
			change: { kind: "retype", fromType: "text", toType: "int" },
		});
		// One row migrated (Alice's "30" → 30); one row quarantined
		// (Bob's "abc" can't cast).
		expect(report.migrated).toBe(1);
		expect(report.quarantined).toBe(1);

		const indexes = await readPropertyIndexes(dbHandle.pool, "patient");
		expect(indexes.map((i) => i.name)).toEqual(["cases_patient_age_btree"]);
	});

	// -----------------------------------------------------------
	// Phase A atomicity — Phase A's transaction rolls back independent of Phase B
	// -----------------------------------------------------------

	it("Phase A rolls back atomically on per-row migration failure: schema row stays unchanged", async () => {
		// Sabotage the second `applySchemaChange` call by removing
		// `cases_quarantine` from the database mid-flight — the
		// retype's quarantine attempt fails, and Phase A's
		// transaction rolls back the new schema UPSERT alongside the
		// failed migration. The probe verifies the schema row is
		// preserved at its pre-call shape.
		const store = makeStore(OWNER_A);
		const initial: CaseType = {
			name: "patient",
			properties: [{ name: "age", label: "Age", data_type: "text" }],
		};
		await store.applySchemaChange({
			appId: APP_ID,
			caseType: "patient",
			blueprint: buildBlueprint(initial),
		});
		await store.insert({
			appId: APP_ID,
			row: {
				case_id: "30000000-0000-0000-0000-000000000001",
				case_type: "patient",
				properties: { age: "abc" },
			},
		});

		// Drop `cases_quarantine` so the retype's quarantine INSERT
		// throws. This is a controlled sabotage of the engine state;
		// the production pipeline never drops the table.
		await dbHandle.pool.query("DROP TABLE cases_quarantine");

		const retyped: CaseType = {
			name: "patient",
			properties: [{ name: "age", label: "Age", data_type: "int" }],
		};
		await expect(
			store.applySchemaChange({
				appId: APP_ID,
				caseType: "patient",
				blueprint: buildBlueprint(retyped),
				property: "age",
				change: { kind: "retype", fromType: "text", toType: "int" },
			}),
		).rejects.toThrow();

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
		// per-row migration would have updated the row's
		// `properties.age` from `"abc"` to a typed value or moved
		// it to quarantine; the rollback returns it to the
		// pre-call value. Asserting the JSONB document confirms
		// the schema-and-data invariant the test labels.
		const row = await dbHandle.pool.query<{ properties: unknown }>(
			"SELECT properties FROM cases WHERE case_id = $1",
			["30000000-0000-0000-0000-000000000001"],
		);
		expect(row.rows[0]?.properties).toEqual({ age: "abc" });
	});

	// -----------------------------------------------------------
	// Phase B failure — index name collision surfaces as a thrown error
	// -----------------------------------------------------------

	it("Phase B failure throws but leaves Phase A's commit intact", async () => {
		// Sabotage Phase B by using a property name that exceeds
		// Postgres's 63-byte identifier cap when composed with the
		// case-type prefix. The DDL emitter's `indexName` helper
		// detects the overflow and throws AFTER Phase A's
		// transaction has already committed — the two-phase split
		// makes this a real-world reachable failure path. Phase A's
		// schema UPSERT is preserved because the throw happens in
		// Phase B, after COMMIT.
		const store = makeStore(OWNER_A);
		// Seed the schema row with no properties so the throw
		// path triggers cleanly on the second call.
		await store.applySchemaChange({
			appId: APP_ID,
			caseType: "patient",
			blueprint: buildBlueprint({ name: "patient", properties: [] }),
		});

		// Property name long enough that
		// `cases_patient_<name>_fuzzy` exceeds 63 bytes.
		const longPropertyName = "x".repeat(60);
		const caseType: CaseType = {
			name: "patient",
			properties: [{ name: longPropertyName, label: "X", data_type: "text" }],
		};
		await expect(
			store.applySchemaChange({
				appId: APP_ID,
				caseType: "patient",
				blueprint: buildBlueprint(caseType),
			}),
		).rejects.toThrow(/63-byte identifier cap/);

		// Phase A's commit is intact: the schema row carries the
		// new property declaration. Phase B's failure didn't roll
		// back Phase A.
		const schemaRow = await dbHandle.pool.query<{ schema: unknown }>(
			"SELECT schema FROM case_type_schemas WHERE app_id = $1 AND case_type = $2",
			[APP_ID, "patient"],
		);
		const schema = schemaRow.rows[0]?.schema as {
			properties: Record<string, unknown>;
		};
		expect(Object.keys(schema.properties)).toContain(longPropertyName);

		// No indexes were created — the throw fired during
		// desired-set computation, before any DDL statement
		// reached the engine. A future refactor that moves the
		// identifier check past the first DDL would create a
		// partial-state index set; this assertion guards against
		// that regression.
		const indexes = await readPropertyIndexes(dbHandle.pool, "patient");
		expect(indexes).toHaveLength(0);
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
			blueprint: buildBlueprint({
				name: "patient",
				properties: [{ name: "name", label: "Name", data_type: "text" }],
			}),
		});

		// Add a second property. Additive mutation — no `change`
		// arg supplied. Phase B still emits the new index.
		await store.applySchemaChange({
			appId: APP_ID,
			caseType: "patient",
			blueprint: buildBlueprint({
				name: "patient",
				properties: [
					{ name: "name", label: "Name", data_type: "text" },
					{ name: "age", label: "Age", data_type: "int" },
				],
			}),
		});

		const indexes = await readPropertyIndexes(dbHandle.pool, "patient");
		expect(indexes.map((i) => i.name).sort()).toEqual([
			"cases_patient_age_btree",
			"cases_patient_name_fuzzy",
		]);
	});

	// -----------------------------------------------------------
	// Index-name validation — guards against unsafe identifiers
	// -----------------------------------------------------------

	it("rejects a property name with characters outside [A-Za-z0-9_]", async () => {
		// Unsafe identifier fragments fail at the DDL emission step
		// (the blueprint validator should catch them earlier; the
		// emitter is the last line of defense).
		const store = makeStore(OWNER_A);
		await expect(
			store.applySchemaChange({
				appId: APP_ID,
				caseType: "patient",
				blueprint: buildBlueprint({
					name: "patient",
					properties: [
						{ name: "name with space", label: "X", data_type: "text" },
					],
				}),
			}),
		).rejects.toThrow(/property/);
	});

	// -----------------------------------------------------------
	// Tenant scope — index DDL is shared across owners
	// -----------------------------------------------------------

	it("indexes are shared across tenants — schema is per-app, not per-owner", async () => {
		// `case_type_schemas` is keyed by `(app_id, case_type)` —
		// the schema (and therefore the desired index set) is
		// shared across every tenant under that app. This test
		// verifies that owner-A's `applySchemaChange` provisions
		// the indexes that owner-B's reads will benefit from.
		const storeA = makeStore("owner-a");
		const storeB = makeStore("owner-b");
		await storeA.applySchemaChange({
			appId: APP_ID,
			caseType: "patient",
			blueprint: buildBlueprint({
				name: "patient",
				properties: [{ name: "name", label: "Name", data_type: "text" }],
			}),
		});

		// Both tenants see the same indexes — they share the
		// `cases` table and its expression-index set.
		const seenByA = await readPropertyIndexes(dbHandle.pool, "patient");
		expect(seenByA.map((i) => i.name)).toEqual(["cases_patient_name_fuzzy"]);

		// Owner B running an additive `applySchemaChange` is a
		// no-op for the index set (the diff is empty).
		await storeB.applySchemaChange({
			appId: APP_ID,
			caseType: "patient",
			blueprint: buildBlueprint({
				name: "patient",
				properties: [{ name: "name", label: "Name", data_type: "text" }],
			}),
		});
		const seenByB = await readPropertyIndexes(dbHandle.pool, "patient");
		expect(seenByB.map((i) => i.name)).toEqual(["cases_patient_name_fuzzy"]);
	});
});
