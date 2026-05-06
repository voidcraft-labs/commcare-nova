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
 * LIKE prefix `cases_<case_type>_%` filters to per-property indexes
 * matching the implementation's naming convention; static
 * `case_indices_*_idx` lives on a different table and is excluded
 * by `tablename = 'cases'`. The hyphen-to-underscore transform on
 * the case-type fragment matches the same transform `indexName`
 * applies in the implementation. The `\_` escapes treat the
 * convention's underscores as literal characters rather than
 * LIKE single-char wildcards.
 */
async function readPropertyIndexes(
	pool: import("pg").Pool,
	caseType: string,
): Promise<{ name: string; def: string }[]> {
	const transformed = caseType.replace(/-/g, "_");
	const result = await pool.query<{ indexname: string; indexdef: string }>(
		`SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'cases' AND indexname LIKE $1 ESCAPE '\\' ORDER BY indexname`,
		[`cases\\_${transformed}\\_%`],
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
		// / between operators are correct but slower; the indexed
		// path needs a Nova-owned IMMUTABLE wrapper function the
		// query side also calls.
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

	it("emits a btree expression index for a decimal property using the numeric cast", async () => {
		const store = makeStore(OWNER_A);
		const caseType: CaseType = {
			name: "patient",
			properties: [{ name: "weight", label: "Weight", data_type: "decimal" }],
		};
		await store.applySchemaChange({
			appId: APP_ID,
			caseType: "patient",
			blueprint: buildBlueprint(caseType),
		});

		const indexes = await readPropertyIndexes(dbHandle.pool, "patient");
		expect(indexes).toHaveLength(1);
		expect(indexes[0]?.name).toBe("cases_patient_weight_btree");
		expect(indexes[0]?.def).toMatch(/USING btree/);
		// `(... ::numeric)` — the cast token from
		// `POSTGRES_CAST_FOR_DATA_TYPE` for the decimal data type.
		expect(indexes[0]?.def).toContain("::numeric");
	});

	it("emits a jsonb_ops GIN index for a multi_select property using `->`", async () => {
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
		// `jsonb_ops` is GIN's default opclass for jsonb columns;
		// `pg_indexes.indexdef` omits explicit default opclass
		// tokens. Asserting the ABSENCE of `jsonb_path_ops` pins
		// the discriminator: the predicate compiler emits `?|` /
		// `?&` for `multi-select-contains`, and `jsonb_path_ops`
		// does not support those operators — only `@>` — so the
		// planner would not reach a `jsonb_path_ops` index.
		expect(indexes[0]?.def).not.toContain("jsonb_path_ops");
		// `->` (not `->>`) — multi_select returns jsonb to feed the
		// `?|` / `?&` / `@>` operators the predicate compiler emits.
		expect(indexes[0]?.def).toMatch(/->\s*'tags'/);
		expect(indexes[0]?.def).not.toMatch(/->>/);
	});

	it("emits no expression index for a geopoint property (term-compiler emission shape can't match)", async () => {
		// The predicate compiler's `within-distance` arm emits
		// `ST_DWithin(ST_GeogFromText(concat('POINT(',
		// split_part(properties->>'<key>', ' ', 2), ' ',
		// split_part(properties->>'<key>', ' ', 1), ')')), ...)`
		// because the stored format `"lat lon alt acc"` is not WKT.
		// `concat(...)` over text args is STABLE in Postgres, so an
		// expression index over the full WKT-build form fails the
		// IMMUTABLE check. The simpler `ST_GeogFromText(properties->>'X')`
		// form would index successfully but its expression doesn't
		// match the term-compiler emission, so the planner can't
		// bridge them. `within-distance` runs as a sequential scan
		// over the case-type partition.
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
		expect(indexes).toHaveLength(0);
	});

	it("emits no per-property index for a single_select property", async () => {
		// Single-select equality matches efficiently through the
		// case-type partial filter alone; no expression index is
		// emitted.
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

	it("creates indexes for every indexable property in the desired set on first call", async () => {
		const store = makeStore(OWNER_A);
		const properties: CaseProperty[] = [
			{ name: "name", label: "Name", data_type: "text" },
			{ name: "age", label: "Age", data_type: "int" },
			{ name: "weight", label: "Weight", data_type: "decimal" },
			{
				name: "tags",
				label: "Tags",
				data_type: "multi_select",
				options: [{ value: "a", label: "A" }],
			},
			// Mixed in non-indexable types — they pass through silently
			// with no index emitted (single_select, date, geopoint).
			{
				name: "color",
				label: "Color",
				data_type: "single_select",
				options: [{ value: "red", label: "Red" }],
			},
			{ name: "scheduled", label: "Scheduled", data_type: "date" },
			{ name: "home", label: "Home", data_type: "geopoint" },
		];
		const caseType: CaseType = { name: "patient", properties };
		await store.applySchemaChange({
			appId: APP_ID,
			caseType: "patient",
			blueprint: buildBlueprint(caseType),
		});

		const indexes = await readPropertyIndexes(dbHandle.pool, "patient");
		// One index per indexable property. Names follow the
		// `cases_<case_type>_<property>_<mode>` convention. The
		// non-indexable types (single_select, date, geopoint) are
		// absent from the result.
		const names = indexes.map((i) => i.name).sort();
		expect(names).toEqual([
			"cases_patient_age_btree",
			"cases_patient_name_fuzzy",
			"cases_patient_tags_contains",
			"cases_patient_weight_btree",
		]);
	});

	it("admits hyphenated property names and transforms them to underscores in the composed index name", async () => {
		// Property names follow `CASE_PROPERTY_PATTERN` from
		// `lib/domain/predicate/types.ts:116` — alphanumerics +
		// underscores + hyphens. CommCare convention includes
		// `external-id`. The composed index name transforms hyphens
		// to underscores so it's a legal unquoted Postgres
		// identifier; the JSONB key inside the indexed expression
		// stays exactly as the blueprint declares it.
		const store = makeStore(OWNER_A);
		const caseType: CaseType = {
			name: "patient",
			properties: [
				{ name: "external-id", label: "External ID", data_type: "text" },
			],
		};
		await store.applySchemaChange({
			appId: APP_ID,
			caseType: "patient",
			blueprint: buildBlueprint(caseType),
		});

		const indexes = await readPropertyIndexes(dbHandle.pool, "patient");
		expect(indexes).toHaveLength(1);
		// Index name has the transformed underscore.
		expect(indexes[0]?.name).toBe("cases_patient_external_id_fuzzy");
		// Indexed expression preserves the literal hyphen.
		expect(indexes[0]?.def).toMatch(/->>\s*'external-id'/);
	});

	it("rejects two properties whose names collide after the hyphen-to-underscore transform", async () => {
		// `external-id` and `external_id` both compose to
		// `cases_patient_external_id_fuzzy`. The diff machinery is
		// keyed by index name, so the collision must surface as a
		// blueprint error before any index work runs.
		const store = makeStore(OWNER_A);
		const caseType: CaseType = {
			name: "patient",
			properties: [
				{ name: "external-id", label: "Hyphen", data_type: "text" },
				{ name: "external_id", label: "Underscore", data_type: "text" },
			],
		};
		await expect(
			store.applySchemaChange({
				appId: APP_ID,
				caseType: "patient",
				blueprint: buildBlueprint(caseType),
			}),
		).rejects.toThrow(/compose into the same index name/);
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
				case_name: "test-case",
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
	// Pre-flight identifier validation — runs BEFORE Phase A opens
	// -----------------------------------------------------------

	it("identifier-shape errors surface BEFORE Phase A's transaction opens", async () => {
		// `computeDesiredIndexSet` runs synchronously at the top of
		// `applySchemaChange`, before any I/O. A property name that
		// would compose into an over-long Postgres identifier
		// throws during pre-flight; `case_type_schemas` is never
		// written.
		const store = makeStore(OWNER_A);
		// Seed the schema row with no properties so the failure
		// path can compare against a known-good baseline.
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

		// `case_type_schemas` carries the pre-call shape (empty
		// properties), NOT the over-long property. Pre-flight
		// caught the error before Phase A's UPSERT ran.
		const schemaRow = await dbHandle.pool.query<{ schema: unknown }>(
			"SELECT schema FROM case_type_schemas WHERE app_id = $1 AND case_type = $2",
			[APP_ID, "patient"],
		);
		const schema = schemaRow.rows[0]?.schema as {
			properties: Record<string, unknown>;
		};
		expect(Object.keys(schema.properties)).not.toContain(longPropertyName);
		expect(Object.keys(schema.properties)).toEqual([]);

		// No indexes were created either — the identifier check
		// fires before any DDL statement reaches the engine; this
		// assertion pins that ordering.
		const indexes = await readPropertyIndexes(dbHandle.pool, "patient");
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
			blueprint: buildBlueprint({ name: "patient", properties: [] }),
		});

		// Drop the extension. Production never does this; the test
		// drops it to manufacture an engine-level failure for the
		// CREATE INDEX statement.
		await dbHandle.pool.query("DROP EXTENSION pg_trgm CASCADE");

		// Add the `name` property. Phase A's UPSERT commits the
		// new schema; Phase B's CREATE INDEX with `gin_trgm_ops`
		// fails because the extension is gone.
		const caseType: CaseType = {
			name: "patient",
			properties: [{ name: "name", label: "Name", data_type: "text" }],
		};
		await expect(
			store.applySchemaChange({
				appId: APP_ID,
				caseType: "patient",
				blueprint: buildBlueprint(caseType),
			}),
		).rejects.toThrow(/gin_trgm_ops|pg_trgm|trgm/i);

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
		const beforeRetry = await readPropertyIndexes(dbHandle.pool, "patient");
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
			blueprint: buildBlueprint(caseType),
		});

		const afterRetry = await readPropertyIndexes(dbHandle.pool, "patient");
		expect(afterRetry.map((i) => i.name)).toEqual(["cases_patient_name_fuzzy"]);
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

		// Establish a healthy text-fuzzy index for the `name` property.
		const blueprint = buildBlueprint({
			name: "patient",
			properties: [{ name: "name", label: "Name", data_type: "text" }],
		});
		await store.applySchemaChange({
			appId: APP_ID,
			caseType: "patient",
			blueprint,
		});

		// Confirm the index is present and valid before the catalog
		// mutation, otherwise a regression in the create path would
		// silently masquerade as a recovery success.
		const beforeMutation = await dbHandle.pool.query<{ indisvalid: boolean }>(
			`SELECT i.indisvalid
			   FROM pg_index i
			   JOIN pg_class c ON c.oid = i.indexrelid
			  WHERE c.relname = 'cases_patient_name_fuzzy'`,
		);
		expect(beforeMutation.rows[0]?.indisvalid).toBe(true);

		// Mark the index INVALID in the catalog. The cast through
		// `pg_class.oid` resolves the index's catalog id by name.
		await dbHandle.pool.query(
			`UPDATE pg_index
			    SET indisvalid = false
			  WHERE indexrelid = (
			    SELECT oid FROM pg_class WHERE relname = 'cases_patient_name_fuzzy'
			  )`,
		);

		// Verify the catalog mutation took effect — the test only
		// proves recovery if the precondition is real.
		const afterMutation = await dbHandle.pool.query<{ indisvalid: boolean }>(
			`SELECT i.indisvalid
			   FROM pg_index i
			   JOIN pg_class c ON c.oid = i.indexrelid
			  WHERE c.relname = 'cases_patient_name_fuzzy'`,
		);
		expect(afterMutation.rows[0]?.indisvalid).toBe(false);

		// Re-run `applySchemaChange` with the same blueprint. The diff
		// reads the catalog, sees the INVALID entry, emits a drop +
		// create pair, and converges the live set with the desired
		// set.
		await store.applySchemaChange({
			appId: APP_ID,
			caseType: "patient",
			blueprint,
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
			  WHERE c.relname = 'cases_patient_name_fuzzy'`,
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
		const finalSet = await readPropertyIndexes(dbHandle.pool, "patient");
		expect(finalSet.map((i) => i.name)).toEqual(["cases_patient_name_fuzzy"]);
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

	it("rejects a property name with characters outside the blueprint vocabulary", async () => {
		// `assertSafeIdentifierFragment` enforces the blueprint's
		// `CASE_PROPERTY_PATTERN` shape (letters / digits /
		// underscores / hyphens with a leading letter) at the
		// index-name composition step. A space character violates
		// the pattern and the pre-flight throws before any I/O.
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
	// EXPLAIN — the planner reaches the index for each operator
	// -----------------------------------------------------------
	//
	// These tests are the structural acceptance criterion for Task
	// 8: the indexes exist AND the planner uses them. The compiled
	// SQL shapes mirror the term/predicate compiler's emission for
	// each load-bearing operator (verified end-to-end via empirical
	// probe). Each test:
	//
	//   1. Provisions the index by calling `applySchemaChange` with
	//      a blueprint declaring one indexable property.
	//   2. Inserts enough rows to make a sequential scan more
	//      expensive than an index probe (the planner switches to
	//      index scans only when the cost crosses a threshold).
	//   3. Runs `ANALYZE` so the planner has up-to-date statistics.
	//   4. Runs `EXPLAIN` over a SELECT mirroring the term/predicate
	//      compiler's emission shape.
	//   5. Asserts the index name appears in the plan.

	const EXPLAIN_ROW_COUNT = 2000;

	/**
	 * Bulk-insert `count` patient rows for the EXPLAIN tests. All
	 * rows carry `case_type = 'patient'` so the partial-predicate
	 * index covers every row; each carries a populated value for
	 * `name`, `age`, `weight`, and `tags` so a single fixture
	 * serves every EXPLAIN test below.
	 *
	 * The row count is empirically chosen — the planner switches to
	 * index plans only when the cost crosses a threshold, and the
	 * threshold depends on the table's row count. 2000 rows is
	 * comfortably above where each operator's index becomes the
	 * cheaper plan (verified via probe).
	 */
	async function populateExplainFixture(count: number): Promise<void> {
		const valueRows: string[] = [];
		const params: unknown[] = [];
		let p = 1;
		for (let i = 0; i < count; i++) {
			const tags = i % 7 === 0 ? ["red", "blue"] : ["green"];
			valueRows.push(
				`($${p++}::uuid, 'app-explain', 'patient', 'owner-a', $${p++}, $${p++}::jsonb)`,
			);
			// `case_name` is `text NOT NULL` with a `length > 0` CHECK
			// — a synthetic per-row value satisfies the constraint
			// without affecting the EXPLAIN output, which probes
			// JSONB-property indexes only.
			params.push(
				`00000000-0000-0000-0000-${i.toString(16).padStart(12, "0")}`,
				`Person${i}`,
				JSON.stringify({
					name: `Person${i}`,
					age: i % 100,
					weight: (50 + (i % 50)).toString(),
					tags,
				}),
			);
		}
		await dbHandle.pool.query(
			`INSERT INTO cases (case_id, app_id, case_type, owner_id, case_name, properties) VALUES ${valueRows.join(", ")}`,
			params,
		);
		await dbHandle.pool.query("ANALYZE cases");
	}

	/**
	 * Run an EXPLAIN against the supplied SELECT with sequential
	 * scans disabled. The planner uses the cheapest plan; with
	 * small test fixtures, a sequential scan sometimes wins on
	 * cost even when an index is available. Disabling seqscan
	 * pins the structural assertion ("the index is reachable for
	 * this operator") independent of the per-fixture cost verdict.
	 *
	 * Reserves a dedicated client checkout so the `SET` and the
	 * `EXPLAIN` share one session — `pool.query` would otherwise
	 * return them to the pool independently.
	 */
	async function explainNoSeqScan(select: string): Promise<string> {
		const client = await dbHandle.pool.connect();
		try {
			await client.query("SET enable_seqscan = off");
			const plan = await client.query<{ "QUERY PLAN": string }>(
				`EXPLAIN ${select}`,
			);
			return plan.rows.map((r) => r["QUERY PLAN"]).join("\n");
		} finally {
			await client.query("SET enable_seqscan = on");
			client.release();
		}
	}

	it("EXPLAIN: text fuzzy match plan reaches the trgm GIN index", async () => {
		const store = makeStore(OWNER_A);
		await store.applySchemaChange({
			appId: "app-explain",
			caseType: "patient",
			blueprint: buildSimpleBlueprint(
				[
					{
						name: "patient",
						properties: [{ name: "name", label: "Name", data_type: "text" }],
					},
				],
				"app-explain",
			),
		});
		await populateExplainFixture(EXPLAIN_ROW_COUNT);

		// Mirror the term compiler's emission for `match(prop("patient",
		// "name"), "Person5", "fuzzy")`:
		//   `cast(cast(properties->>'name' as text) as text) % cast('Person5' as text)`
		const planText = await explainNoSeqScan(
			`SELECT * FROM cases c
			 WHERE c.app_id = 'app-explain'
			   AND c.owner_id = 'owner-a'
			   AND c.case_type = 'patient'
			   AND cast(cast(c.properties ->> 'name' as text) as text) % cast('Person5' as text)`,
		);
		expect(planText).toContain("cases_patient_name_fuzzy");
	});

	it("EXPLAIN: int compare plan reaches the btree expression index", async () => {
		const store = makeStore(OWNER_A);
		await store.applySchemaChange({
			appId: "app-explain",
			caseType: "patient",
			blueprint: buildSimpleBlueprint(
				[
					{
						name: "patient",
						properties: [{ name: "age", label: "Age", data_type: "int" }],
					},
				],
				"app-explain",
			),
		});
		await populateExplainFixture(EXPLAIN_ROW_COUNT);

		// Mirror the term compiler's emission for `gt(prop("patient",
		// "age"), literal(50))`:
		//   `cast(properties->>'age' as integer) > 50`
		const planText = await explainNoSeqScan(
			`SELECT * FROM cases c
			 WHERE c.app_id = 'app-explain'
			   AND c.owner_id = 'owner-a'
			   AND c.case_type = 'patient'
			   AND cast(c.properties ->> 'age' as integer) > 50`,
		);
		expect(planText).toContain("cases_patient_age_btree");
	});

	it("EXPLAIN: decimal compare plan reaches the btree expression index", async () => {
		const store = makeStore(OWNER_A);
		await store.applySchemaChange({
			appId: "app-explain",
			caseType: "patient",
			blueprint: buildSimpleBlueprint(
				[
					{
						name: "patient",
						properties: [
							{ name: "weight", label: "Weight", data_type: "decimal" },
						],
					},
				],
				"app-explain",
			),
		});
		await populateExplainFixture(EXPLAIN_ROW_COUNT);

		// Mirror the term compiler's emission for a decimal compare:
		//   `cast(properties->>'weight' as numeric) > 75`
		const planText = await explainNoSeqScan(
			`SELECT * FROM cases c
			 WHERE c.app_id = 'app-explain'
			   AND c.owner_id = 'owner-a'
			   AND c.case_type = 'patient'
			   AND cast(c.properties ->> 'weight' as numeric) > 75`,
		);
		expect(planText).toContain("cases_patient_weight_btree");
	});

	it("EXPLAIN: multi_select contains plan reaches the jsonb_ops GIN index", async () => {
		const store = makeStore(OWNER_A);
		await store.applySchemaChange({
			appId: "app-explain",
			caseType: "patient",
			blueprint: buildSimpleBlueprint(
				[
					{
						name: "patient",
						properties: [
							{
								name: "tags",
								label: "Tags",
								data_type: "multi_select",
								options: [
									{ value: "red", label: "Red" },
									{ value: "blue", label: "Blue" },
									{ value: "green", label: "Green" },
								],
							},
						],
					},
				],
				"app-explain",
			),
		});
		await populateExplainFixture(EXPLAIN_ROW_COUNT);

		// Mirror the predicate compiler's emission for
		// `multiSelectAny(prop("patient", "tags"), literal("red"))`:
		//   `cast(properties->'tags' as jsonb) ?| ARRAY['red']::text[]`
		const planText = await explainNoSeqScan(
			`SELECT * FROM cases c
			 WHERE c.app_id = 'app-explain'
			   AND c.owner_id = 'owner-a'
			   AND c.case_type = 'patient'
			   AND cast(c.properties -> 'tags' as jsonb) ?| ARRAY['red']::text[]`,
		);
		expect(planText).toContain("cases_patient_tags_contains");
		// The plan's `Index Cond` should carry the `?|` operator,
		// not just the partial-predicate `case_type = 'patient'`
		// match. With `jsonb_ops` (vs `jsonb_path_ops`) the planner
		// reaches the index for `?|` directly.
		expect(planText).toMatch(/Index Cond.*\?\|/);
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

// ---------------------------------------------------------------
// `insertMany` — bulk-insert path rollback semantics
// ---------------------------------------------------------------
//
// `insertMany` is package-private; tests reach it through the
// public `generateSampleData` entry point with a stub
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

describe("PostgresCaseStore — insertMany rollback semantics", () => {
	it("rolls back the entire batch when any row fails JSON Schema validation", async () => {
		// Schema declares `age` as `int`; the stub generator emits
		// three rows where the second one's `age` is the string
		// "not-a-number" (rejects against the `integer` schema).
		const caseType: CaseType = {
			name: "patient",
			properties: [
				{ name: "case_name", label: "Name", data_type: "text" },
				{ name: "age", label: "Age", data_type: "int" },
			],
		};
		const blueprint = buildBlueprint(caseType);

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
			ownerId: OWNER_A,
			db: dbHandle.db as unknown as Kysely<Database>,
			sampleGenerator: stubGenerator,
		});

		await store.applySchemaChange({
			appId: APP_ID,
			caseType: "patient",
			blueprint,
		});

		// `generateSampleData` routes through the bulk-insert path.
		// AJV's failure on row 1 throws; the transaction rolls back
		// the whole batch (rows 0 and 2 included).
		await expect(
			store.generateSampleData({
				appId: APP_ID,
				caseType: "patient",
				count: 3,
				seed: "rollback-test",
				blueprint,
			}),
		).rejects.toThrow();

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
