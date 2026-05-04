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
// DATABASE` + `CREATE EXTENSION` + `runMigration("latest")` once
// (~50 ms on a modern laptop) but the store's transaction-using
// methods execute as authored.
//
// `setupPerTestDatabase` is the same helper Plan 2 Task 1's
// migration runner test uses (and the same one Task 2's
// extension-allowlist gate test uses); the contract is canonical
// in this package.
//
// ## Why migrations run inside `beforeEach`, not the helper
//
// `setupPerTestDatabase` provisions the database + installs
// extensions; it does NOT apply migrations. The store needs every
// case-store table to exist before any method runs, so this file
// runs `runMigration(db, "latest")` in a sibling `beforeEach`
// after the database handle is provisioned.
//
// The split mirrors the production split between Cloud SQL
// provisioning (Phase 5 of the runbook installs extensions under
// `postgres` superuser) and migration runs (Cloud Run job under
// the IAM-auth runtime SA). In tests, the helper plays the role
// of the superuser provisioning; the explicit migration call
// plays the role of the runtime migration job.

import type { Kysely } from "kysely";
import { beforeEach } from "vitest";
import { runStoreContract } from "../../__tests__/storeContract";
import { runMigration } from "../../migrations/runner";
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
// the store's constructor wants `Kysely<Database>`. Casting at
// the construction call site is the established pattern (the
// migration runner's tests do the same — `Kysely<unknown>` is
// the migration-time shape; once migrations run, the database
// matches `Database`'s contract).

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
// exist before the first method call — `runMigration("latest")`
// is the canonical path that creates them.
//
// The call runs inside `beforeEach` so each test starts with
// a fresh-migrated database. Vitest fires this `beforeEach`
// AFTER the helper's own `beforeEach` (Vitest hooks run in
// registration order); when this body executes, `dbHandle.db`
// is bound to the freshly-created per-test database.

beforeEach(async () => {
	const outcome = await runMigration(dbHandle.db, "latest");
	if (!outcome.success) {
		// A migration failure inside a per-test database is a
		// harness regression, not a test failure. Surface the
		// detail explicitly so a future debugger sees the cause
		// without re-running with extra flags.
		const detail =
			outcome.error instanceof Error
				? outcome.error.message
				: String(outcome.error);
		throw new Error(`migration failure inside per-test database: ${detail}`);
	}
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
// shape after `runMigration("latest")` matches `Database`
// exactly.

runStoreContract({
	describeName: "PostgresCaseStore",
	factory: async (ownerId: string) => {
		return new PostgresCaseStore({
			ownerId,
			db: dbHandle.db as unknown as Kysely<Database>,
		});
	},
});
