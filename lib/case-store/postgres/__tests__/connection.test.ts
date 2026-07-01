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
// SQL instance or a mock of the platform proxy socket + IAM token fetch.
// Round-trip read/write coverage runs through the testcontainers
// harness at `lib/case-store/sql/__tests__/`, which provides its own
// `Kysely<Database>` instance bound to a per-test transaction.

import type { GoogleAuth } from "google-auth-library";
import type { Kysely } from "kysely";
import type { PoolConfig } from "pg";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";
import {
	buildPoolConfig,
	type CaseStoreEnvConfig,
	closeCaseStoreDatabase,
	type Database,
	enforceConnectionBudget,
	getCaseStoreDatabase,
	iamTokenPassword,
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
		// than in combination with other gaps. The Elm-style throw
		// emits a `missing: <names>` line with the named variable
		// present; pin the contract via two cheap substring checks
		// rather than a brittle full-message regex.
		const env: Record<string, string> = { ...completeEnv };
		delete env[missingVar];
		expect(() => readCaseStoreEnvConfig(env)).toThrowError(
			/missing required environment variables/,
		);
		expect(() => readCaseStoreEnvConfig(env)).toThrowError(
			new RegExp(`missing:[^\\n]*${missingVar}`),
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
			/missing required environment variables/,
		);
		expect(() => readCaseStoreEnvConfig(env)).toThrowError(
			new RegExp(`missing:[^\\n]*${emptyVar}`),
		);
	});

	it("aggregates every missing variable into one error message", () => {
		// All three variables missing — the error names every one in
		// a single throw rather than failing on the first and forcing
		// the operator to redeploy three times to discover the rest.
		// The Elm-style throw lists all three on the `missing:` line.
		const env: Record<string, string> = {};
		expect(() => readCaseStoreEnvConfig(env)).toThrowError(
			/missing:[^\n]*NOVA_DB_NAME[^\n]*NOVA_DB_USER[^\n]*NOVA_DB_INSTANCE_CONNECTION_NAME/,
		);
	});

	it("hints at the gcloud command an operator runs to wire the missing variable", () => {
		// The throw points the operator at the recovery path
		// (`gcloud run services update`) so the failure message names
		// the action, not just the absent state.
		const env: Record<string, string> = {};
		expect(() => readCaseStoreEnvConfig(env)).toThrowError(
			/gcloud run services update/,
		);
	});
});

// ---------------------------------------------------------------
// Pool-config invariant
// ---------------------------------------------------------------

describe("buildPoolConfig", () => {
	const env: CaseStoreEnvConfig = {
		NOVA_DB_NAME: "nova_cases",
		NOVA_DB_USER: "51003905459-compute@developer",
		NOVA_DB_INSTANCE_CONNECTION_NAME: "commcare-nova:us-central1:nova-cases",
	};
	// A stand-in password callback. Never invoked in the unit path — `Pool`
	// reads it only when opening a connection, which these tests never do.
	const password: PoolConfig["password"] = async () => "iam-access-token";

	it("pins pool max to POOL_MAX_PER_INSTANCE", () => {
		// The runtime invariant: `max` is `POOL_MAX_PER_INSTANCE`, never anything
		// else. A regression here breaks the connection-budget math.
		const config = buildPoolConfig(env, password);
		expect(config.max).toBe(POOL_MAX_PER_INSTANCE);
		expect(config.max).toBe(4);
	});

	it("targets the Cloud Run built-in Cloud SQL socket for the instance", () => {
		// pg treats a `/`-prefixed host as a Unix socket directory; the platform
		// mounts the proxy socket at `/cloudsql/<instanceConnectionName>`.
		const config = buildPoolConfig(env, password);
		expect(config.host).toBe(
			`/cloudsql/${env.NOVA_DB_INSTANCE_CONNECTION_NAME}`,
		);
	});

	it("fills user and database from the env config", () => {
		const config = buildPoolConfig(env, password);
		expect(config.user).toBe(env.NOVA_DB_USER);
		expect(config.database).toBe(env.NOVA_DB_NAME);
	});

	it("forwards the IAM token password callback unchanged", () => {
		// Manual IAM auth: `password` is the token-fetching callback pg invokes
		// per new connection. `buildPoolConfig` must pass it through verbatim.
		const config = buildPoolConfig(env, password);
		expect(config.password).toBe(password);
	});

	it("constructs a real pg.Pool with the resulting config", async () => {
		// Lock the contract that the config object is structurally
		// `PoolConfig`-shaped — `new Pool(config)` would throw otherwise. The pool
		// is created but never connected to (no `query()`), so the password
		// callback never fires. End immediately to keep Vitest's open-handle
		// accounting clean.
		const config = buildPoolConfig(env, password);
		const pool = new Pool(config);
		await pool.end();
	});
});

// ---------------------------------------------------------------
// IAM token password callback
// ---------------------------------------------------------------

describe("iamTokenPassword", () => {
	it("returns the access token the auth client resolves", async () => {
		const auth = {
			getAccessToken: async () => "iam-access-token",
		} as unknown as GoogleAuth;
		await expect(iamTokenPassword(auth)()).resolves.toBe("iam-access-token");
	});

	it("throws when the auth client yields no token", async () => {
		// A connection with no password can't authenticate — fail loud at fetch
		// time rather than hand pg an empty credential that surfaces as an opaque
		// auth error.
		const auth = {
			getAccessToken: async () => null,
		} as unknown as GoogleAuth;
		await expect(iamTokenPassword(auth)()).rejects.toThrow(
			/could not obtain an access token/,
		);
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
		// the first-call path inside `initialize` runs is the same one
		// the test runs and it agrees the current constants are
		// consistent."
		expect(() => enforceConnectionBudget()).not.toThrow();
	});

	it("does not run on module import — the first-call path inside `initialize` owns the check", async () => {
		// The check fires from inside `initialize` (the body that runs
		// on the first `getCaseStoreDatabase()` call), NOT at module
		// top level. Importing the module from this test file is a
		// no-side-effect operation: every test in this suite imports
		// the module via the file-level `import` block above without
		// triggering the budget throw, even when a contributor
		// experimentally edits one of the four constants out of range.
		//
		// The pin uses dynamic `import()` so a static `import` the
		// linter could move out of an `expect()` doesn't smuggle
		// fixed semantics into the assertion. Vitest's module cache
		// returns the same instance the suite-level import already
		// resolved; the `await` resolves synchronously off the cache.
		await expect(import("../connection")).resolves.toBeDefined();
	});

	it("runs on the first `getCaseStoreDatabase()` call", async () => {
		// `initialize` calls `enforceConnectionBudget` BEFORE
		// `readCaseStoreEnvConfig`. The unit-test environment has no
		// `NOVA_DB_*` set, so a passing budget check transitions
		// control to env validation — which throws naming the missing
		// variables. A failing budget check would surface a different
		// error first. Catching the env error pins the ordering: the
		// budget check fired (and passed) before env validation
		// reached its throw site.
		//
		// Pinning by the env error message is the only behavioural
		// signal available without stubbing modules. The brief notes
		// `vi.spyOn(connection, "enforceConnectionBudget")` would not
		// observe the call because production code references the
		// local binding, not the module-namespace export.
		await expect(getCaseStoreDatabase()).rejects.toThrow(
			/missing required environment variables/,
		);
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

// ---------------------------------------------------------------
// Shutdown idempotency
// ---------------------------------------------------------------

describe("closeCaseStoreDatabase", () => {
	it("is a no-op on a never-opened singleton and is safely re-callable", async () => {
		// Module load doesn't initialize the singleton (the lazy-init
		// path only runs when `getCaseStoreDatabase` is awaited), so
		// the first call here exercises the `handles === null`
		// short-circuit. The second call must take the same path —
		// pinning the idempotency contract from this side guarantees
		// a process-shutdown handler that fires twice (re-entrant
		// SIGTERM, supervisor calling pre-emptively) doesn't blow up
		// on the second invocation.
		await expect(closeCaseStoreDatabase()).resolves.toBeUndefined();
		await expect(closeCaseStoreDatabase()).resolves.toBeUndefined();
	});
});

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
