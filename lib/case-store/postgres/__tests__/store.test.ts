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
import { beforeEach } from "vitest";
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
