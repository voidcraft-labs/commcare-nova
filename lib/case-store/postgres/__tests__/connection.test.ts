// lib/case-store/postgres/__tests__/connection.test.ts
//
// Unit tests for the Cloud SQL connection layer.
//
// Three contracts get exercised here:
//
//   1. **Env-var validation** — every required variable is checked
//      for absence and for empty string; a missing variable surfaces
//      as a single error naming every gap.
//   2. **Pool-config invariant** — `buildPoolConfig` returns a
//      config whose `max` matches `POOL_MAX_PER_INSTANCE`. This is
//      the runtime side of the connection-budget math; the
//      `enforceConnectionBudget` check in `connection.ts` covers the
//      static side.
//   3. **Kysely type contract** — the exported `getCaseStoreDatabase`
//      promise resolves to `Kysely<Database>`. A compile-only
//      assertion catches a regression that would silently widen the
//      type.
//
// The runtime singleton (`getCaseStoreDatabase` / `closeCaseStoreDatabase`)
// is intentionally not exercised here — it would require a live Cloud
// SQL instance or a heavyweight mock of the connector's TLS handshake.
// Round-trip read/write coverage runs through the testcontainers
// harness at `lib/case-store/sql/__tests__/`, which provides its own
// `Kysely<Database>` instance bound to a per-test transaction.

import type { Kysely } from "kysely";
import type { PoolConfig } from "pg";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";
import {
	buildPoolConfig,
	type CaseStoreEnvConfig,
	type ConnectorClientOptions,
	type Database,
	enforceConnectionBudget,
	getCaseStoreDatabase,
	POOL_MAX_PER_INSTANCE,
	REQUIRED_ENV_VARS,
	readCaseStoreEnvConfig,
} from "../connection";

// ---------------------------------------------------------------
// Env-var validation
// ---------------------------------------------------------------
//
// `readCaseStoreEnvConfig` accepts an env-like stub so the tests
// don't have to mutate `process.env` (which would risk leaking
// state across tests even with `vi.stubEnv`). One stub per test;
// each test names the variable it's exercising.

/** A complete env stub — every required variable present with a non-empty value. */
const completeEnv: Record<string, string> = {
	NOVA_DB_NAME: "nova_cases",
	NOVA_DB_USER: "51003905459-compute@developer",
	NOVA_DB_INSTANCE_CONNECTION_NAME: "commcare-nova:us-central1:nova-cases",
};

describe("readCaseStoreEnvConfig", () => {
	it("returns the validated config when every required variable is set", () => {
		expect(readCaseStoreEnvConfig(completeEnv)).toEqual({
			NOVA_DB_NAME: "nova_cases",
			NOVA_DB_USER: "51003905459-compute@developer",
			NOVA_DB_INSTANCE_CONNECTION_NAME: "commcare-nova:us-central1:nova-cases",
		});
	});

	it.each(
		REQUIRED_ENV_VARS,
	)("throws an error naming the missing variable when %s is absent", (missingVar) => {
		// Build an env with everything except the named variable.
		// Ensures each variable is exercised in isolation rather
		// than in combination with other gaps.
		const env: Record<string, string> = { ...completeEnv };
		delete env[missingVar];
		expect(() => readCaseStoreEnvConfig(env)).toThrowError(
			new RegExp(`missing required environment variables:.*${missingVar}`),
		);
	});

	it.each(
		REQUIRED_ENV_VARS,
	)("throws an error naming the empty variable when %s is set to an empty string", (emptyVar) => {
		// Cloud Run's `--update-env-vars` accepts an empty string
		// silently, so the validator must treat empty-string the
		// same as absent. This test pins that contract.
		const env: Record<string, string> = { ...completeEnv, [emptyVar]: "" };
		expect(() => readCaseStoreEnvConfig(env)).toThrowError(
			new RegExp(`missing required environment variables:.*${emptyVar}`),
		);
	});

	it("aggregates every missing variable into one error message", () => {
		// All three variables missing — the error names every one in
		// a single throw rather than failing on the first and forcing
		// the operator to redeploy three times to discover the rest.
		const env: Record<string, string> = {};
		expect(() => readCaseStoreEnvConfig(env)).toThrowError(
			/missing required environment variables:.*NOVA_DB_NAME.*NOVA_DB_USER.*NOVA_DB_INSTANCE_CONNECTION_NAME/,
		);
	});

	it("references the runbook in the error message so an operator can re-run Phase 6", () => {
		// The error's secondary purpose is operator orientation.
		// Naming the runbook + Phase tells the on-call where to look
		// without grep-the-codebase.
		const env: Record<string, string> = {};
		expect(() => readCaseStoreEnvConfig(env)).toThrowError(
			/2026-05-02-plan-2-task-0-cloud-sql-provisioning\.md/,
		);
	});
});

// ---------------------------------------------------------------
// Pool-config invariant
// ---------------------------------------------------------------

describe("buildPoolConfig", () => {
	// The connector returns a `stream` factory; the test stub uses a
	// minimal placeholder cast through `as unknown as`. The factory
	// is never invoked in the unit-test path — only `Pool`'s
	// constructor reads it, and the constructor never opens the
	// connection until a query runs.
	const stubStream = (() => {
		throw new Error(
			"stream factory should not be invoked in unit tests — Pool is constructed but never connected to",
		);
	}) as unknown as PoolConfig["stream"];

	const stubClientOpts: ConnectorClientOptions = { stream: stubStream };

	const env: CaseStoreEnvConfig = {
		NOVA_DB_NAME: "nova_cases",
		NOVA_DB_USER: "51003905459-compute@developer",
		NOVA_DB_INSTANCE_CONNECTION_NAME: "commcare-nova:us-central1:nova-cases",
	};

	it("pins pool max to POOL_MAX_PER_INSTANCE", () => {
		// The runtime invariant: `max` is `POOL_MAX_PER_INSTANCE`,
		// never anything else. A regression here breaks the
		// connection-budget math.
		const config = buildPoolConfig(stubClientOpts, env);
		expect(config.max).toBe(POOL_MAX_PER_INSTANCE);
		expect(config.max).toBe(4);
	});

	it("forwards the connector's stream factory unchanged", () => {
		// `buildPoolConfig` must not wrap or transform the stream —
		// the connector owns the TLS-handshake logic, and any wrapper
		// here would risk double-buffering or eat error events.
		const config = buildPoolConfig(stubClientOpts, env);
		expect(config.stream).toBe(stubStream);
	});

	it("fills user and database from the env config", () => {
		const config = buildPoolConfig(stubClientOpts, env);
		expect(config.user).toBe(env.NOVA_DB_USER);
		expect(config.database).toBe(env.NOVA_DB_NAME);
	});

	it("does not set a password (IAM authentication is passwordless)", () => {
		// IAM auth flows the SA's identity through the TLS handshake;
		// `password` must be absent so a future `pg.Pool` upgrade
		// doesn't quietly start interpreting an undefined value as
		// "use empty password" against a non-IAM database user.
		const config = buildPoolConfig(stubClientOpts, env);
		expect("password" in config).toBe(false);
	});

	it("constructs a real pg.Pool with the resulting config", async () => {
		// Lock the contract that the config object is structurally
		// `PoolConfig`-shaped — `new Pool(config)` would throw
		// otherwise. The pool is created but never connected to (no
		// `query()` call), so the stub stream factory's throw stays
		// inert. End the pool immediately to keep Vitest's open-
		// handle accounting clean; no checked-out clients exist
		// since the constructor doesn't connect, so end() resolves
		// instantly.
		const config = buildPoolConfig(stubClientOpts, env);
		const pool = new Pool(config);
		await pool.end();
	});
});

// ---------------------------------------------------------------
// Connection-budget invariant
// ---------------------------------------------------------------

describe("enforceConnectionBudget", () => {
	it("does not throw for the current constants", () => {
		// Calls the production function directly — re-deriving the
		// peak-demand-vs-budget formula in the test would share the
		// production logic's mental model and fail to catch a
		// regression in either side. The check here is "the function
		// the module-load path runs is the same one the test runs and
		// it agrees the current constants are consistent."
		expect(() => enforceConnectionBudget()).not.toThrow();
	});
});

// ---------------------------------------------------------------
// Kysely type contract — compile-only
// ---------------------------------------------------------------
//
// `getCaseStoreDatabase` resolves to `Kysely<Database>`. This block
// asserts the type at compile time: a regression that widens the
// resolved type to `Kysely<unknown>` (or narrows it to the wrong
// table set) fails the build.

describe("getCaseStoreDatabase type contract", () => {
	it("resolves to Kysely<Database>", () => {
		// The runtime never executes — `_pinType` is a thunk asserting
		// the return type of `getCaseStoreDatabase`. If a regression
		// widens the resolved type away from `Kysely<Database>` (e.g.
		// to `Kysely<unknown>` or to a different table set), the
		// assignment fails compilation. The `void _pinType` reference
		// keeps the variable live so the unused-locals rule passes
		// without a suppression.
		const _pinType = async (): Promise<Kysely<Database>> => {
			return getCaseStoreDatabase();
		};
		void _pinType;
		expect(true).toBe(true);
	});
});
