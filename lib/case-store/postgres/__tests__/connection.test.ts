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

import { IpAddressTypes } from "@google-cloud/cloud-sql-connector";
import type { Kysely } from "kysely";
import type { PoolConfig } from "pg";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";
import {
	AUDIT_DB_ROLE_CONNECTION_LIMIT,
	AUDIT_POOL_MAX_PER_EXECUTION,
	buildPoolConfig,
	CAPTURE_CLEANUP_DB_ROLE_CONNECTION_LIMIT,
	CAPTURE_CLEANUP_LOCK_CONTENDER_CONNECTIONS,
	CAPTURE_CLEANUP_POOL_MAX_PER_EXECUTION,
	type CaseStoreEnvConfig,
	CLOUD_RUN_MAX_INSTANCES,
	CLOUD_SQL_CAPACITY_HEADROOM_CONNECTIONS,
	CLOUD_SQL_MAX_CONNECTIONS,
	CLOUD_SQL_ORDINARY_LOGIN_HEADROOM_CONNECTIONS,
	CLOUD_SQL_RESERVED_CONNECTIONS,
	CLOUD_SQL_SUPERUSER_RESERVED_CONNECTIONS,
	type ConnectorClientOptions,
	closeCaseStoreDatabase,
	DATABASE_CONNECTION_OPTIONS,
	DATABASE_SEARCH_PATH,
	type Database,
	enforceConnectionBudget,
	getCaseStoreDatabase,
	LISTENER_CONNECTIONS_PER_INSTANCE,
	MIGRATION_DB_ROLE_CONNECTION_LIMIT,
	MIGRATION_POOL_MAX_PER_EXECUTION,
	OPERATOR_POOL_MAX_PER_PROCESS,
	POOL_MAX_PER_INSTANCE,
	poolMaxForWorkload,
	REQUIRED_ENV_VARS,
	RUNTIME_DB_ROLE_CONNECTION_LIMIT,
	readCaseStoreEnvConfig,
	readCaseStoreIpType,
	readCaseStoreWorkload,
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

	it.each(REQUIRED_ENV_VARS)(
		"throws an error naming the missing variable when %s is absent",
		(missingVar) => {
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
		},
	);

	it.each(REQUIRED_ENV_VARS)(
		"throws an error naming the empty variable when %s is set to an empty string",
		(emptyVar) => {
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
		},
	);

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
// IP-type resolution
// ---------------------------------------------------------------
//
// `readCaseStoreIpType` accepts the same env-like stub pattern as
// `readCaseStoreEnvConfig`. The load-bearing contract is the default:
// Cloud Run never sets `NOVA_DB_IP_TYPE`, so an absent (or empty —
// `--update-env-vars` accepts empty silently) variable MUST resolve
// to the private IP. `PUBLIC` is the laptop-inspection opt-in.

describe("readCaseStoreIpType", () => {
	it("defaults to PRIVATE when NOVA_DB_IP_TYPE is absent", () => {
		expect(readCaseStoreIpType({})).toBe(IpAddressTypes.PRIVATE);
	});

	it("treats an empty string as absent (defaults to PRIVATE)", () => {
		expect(readCaseStoreIpType({ NOVA_DB_IP_TYPE: "" })).toBe(
			IpAddressTypes.PRIVATE,
		);
	});

	it("resolves the PUBLIC opt-in", () => {
		expect(readCaseStoreIpType({ NOVA_DB_IP_TYPE: "PUBLIC" })).toBe(
			IpAddressTypes.PUBLIC,
		);
	});

	it("accepts an explicit PRIVATE", () => {
		expect(readCaseStoreIpType({ NOVA_DB_IP_TYPE: "PRIVATE" })).toBe(
			IpAddressTypes.PRIVATE,
		);
	});

	it("rejects unrecognized values rather than guessing", () => {
		// Lowercase included — a silent case-fold would let `public` in a
		// shell one-liner resolve to PRIVATE-by-fallthrough on a future
		// refactor; requiring the exact literal keeps the failure loud.
		for (const bad of ["public", "psc", "PSC", "both"]) {
			expect(() => readCaseStoreIpType({ NOVA_DB_IP_TYPE: bad })).toThrowError(
				/unrecognized NOVA_DB_IP_TYPE/,
			);
		}
	});
});

describe("readCaseStoreWorkload", () => {
	it.each([
		["service", 3],
		["migration", 1],
		["capture-cleanup", 2],
		["audit", 1],
		["operator", 1],
	] as const)("maps %s to its exact pool maximum", (workload, poolMax) => {
		expect(readCaseStoreWorkload({ NOVA_DB_WORKLOAD: workload })).toBe(
			workload,
		);
		expect(poolMaxForWorkload(workload)).toBe(poolMax);
	});

	it("keeps one-off operator tooling inside one residual ordinary connection", () => {
		expect(OPERATOR_POOL_MAX_PER_PROCESS).toBe(1);
	});

	it("caps the dedicated read-only audit identity at one connection", () => {
		expect(AUDIT_POOL_MAX_PER_EXECUTION).toBe(1);
		expect(AUDIT_DB_ROLE_CONNECTION_LIMIT).toBe(1);
	});

	it("fails loudly when a production process omits the workload", () => {
		expect(() => readCaseStoreWorkload({})).toThrowError(
			/missing its workload declaration/,
		);
		expect(() => readCaseStoreWorkload({ NOVA_DB_WORKLOAD: "" })).toThrowError(
			/missing its workload declaration/,
		);
	});

	it("fails loudly for an unrecognized workload", () => {
		expect(() =>
			readCaseStoreWorkload({ NOVA_DB_WORKLOAD: "cleanup" }),
		).toThrowError(/unrecognized workload declaration/);
	});

	it("allows local development to omit the workload and uses the service pool", () => {
		expect(
			readCaseStoreWorkload({
				NOVA_DB_LOCAL_URL: "postgres://nova@localhost/nova_cases",
			}),
		).toBe("service");
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
		const config = buildPoolConfig(stubClientOpts, env, "service");
		expect(config.max).toBe(POOL_MAX_PER_INSTANCE);
		// Rebalanced from 4 → 3 to leave room for the relay's dedicated LISTEN
		// connection (`LISTENER_CONNECTIONS_PER_INSTANCE`); the two sum to the
		// former per-instance demand, so the total budget is unchanged.
		expect(config.max).toBe(3);
	});

	it.each([
		["migration", 1],
		["capture-cleanup", 2],
		["audit", 1],
		["operator", 1],
	] as const)("applies the %s workload pool maximum", (workload, poolMax) => {
		expect(buildPoolConfig(stubClientOpts, env, workload).max).toBe(poolMax);
	});

	it("forwards the connector's stream factory unchanged", () => {
		// `buildPoolConfig` must not wrap or transform the stream —
		// the connector owns the TLS-handshake logic, and any wrapper
		// here would risk double-buffering or eat error events.
		const config = buildPoolConfig(stubClientOpts, env, "service");
		expect(config.stream).toBe(stubStream);
	});

	it("fills user and database from the env config", () => {
		const config = buildPoolConfig(stubClientOpts, env, "service");
		expect(config.user).toBe(env.NOVA_DB_USER);
		expect(config.database).toBe(env.NOVA_DB_NAME);
	});

	it("resolves fixed public objects before the isolated runtime case schema", () => {
		const config = buildPoolConfig(stubClientOpts, env, "service");
		expect(DATABASE_SEARCH_PATH).toBe("public,nova_case_runtime");
		expect(config.options).toBe(DATABASE_CONNECTION_OPTIONS);
	});

	it("does not set a password (IAM authentication is passwordless)", () => {
		// IAM auth flows the SA's identity through the TLS handshake;
		// `password` must be absent so a future `pg.Pool` upgrade
		// doesn't quietly start interpreting an undefined value as
		// "use empty password" against a non-IAM database user.
		const config = buildPoolConfig(stubClientOpts, env, "service");
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
		const config = buildPoolConfig(stubClientOpts, env, "service");
		const pool = new Pool(config);
		await pool.end();
	});
});

// ---------------------------------------------------------------
// Connection-budget invariant
// ---------------------------------------------------------------

describe("enforceConnectionBudget", () => {
	it("reserves one dedicated LISTEN connection per instance", () => {
		// The relay holds ONE `pg.Client` outside the pool per Cloud Run
		// instance; `enforceConnectionBudget` (exercised below) folds this into
		// its peak-demand math. Pin the split — a bump to either constant that
		// blows the budget would trip the budget check, but pinning the values
		// documents WHY the pool max dropped to 3.
		expect(LISTENER_CONNECTIONS_PER_INSTANCE).toBe(1);
		expect(POOL_MAX_PER_INSTANCE).toBe(3);
	});

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

	it("reserves capacity for service, migration, cleanup, audit, and one rejected overlap", () => {
		const servicePeak =
			CLOUD_RUN_MAX_INSTANCES *
			(POOL_MAX_PER_INSTANCE + LISTENER_CONNECTIONS_PER_INSTANCE);
		const cleanupPeak =
			CAPTURE_CLEANUP_POOL_MAX_PER_EXECUTION +
			CAPTURE_CLEANUP_LOCK_CONTENDER_CONNECTIONS;
		const productionPeak =
			RUNTIME_DB_ROLE_CONNECTION_LIMIT +
			MIGRATION_DB_ROLE_CONNECTION_LIMIT +
			CAPTURE_CLEANUP_DB_ROLE_CONNECTION_LIMIT +
			AUDIT_DB_ROLE_CONNECTION_LIMIT;
		const applicationBudget =
			CLOUD_SQL_MAX_CONNECTIONS - CLOUD_SQL_CAPACITY_HEADROOM_CONNECTIONS;

		expect({
			servicePeak,
			runtimeRoleLimit: RUNTIME_DB_ROLE_CONNECTION_LIMIT,
			migrationPeak: MIGRATION_POOL_MAX_PER_EXECUTION,
			migrationRoleLimit: MIGRATION_DB_ROLE_CONNECTION_LIMIT,
			cleanupPeak,
			cleanupRoleLimit: CAPTURE_CLEANUP_DB_ROLE_CONNECTION_LIMIT,
			auditPeak: AUDIT_POOL_MAX_PER_EXECUTION,
			auditRoleLimit: AUDIT_DB_ROLE_CONNECTION_LIMIT,
			productionPeak,
			applicationBudget,
			ordinaryHeadroom: CLOUD_SQL_ORDINARY_LOGIN_HEADROOM_CONNECTIONS,
			superuserReserved: CLOUD_SQL_SUPERUSER_RESERVED_CONNECTIONS,
			reservedConnectionsSetting: CLOUD_SQL_RESERVED_CONNECTIONS,
		}).toEqual({
			servicePeak: 16,
			runtimeRoleLimit: 16,
			migrationPeak: 1,
			migrationRoleLimit: 1,
			cleanupPeak: 3,
			cleanupRoleLimit: 3,
			auditPeak: 1,
			auditRoleLimit: 1,
			productionPeak: 21,
			applicationBudget: 21,
			ordinaryHeadroom: 1,
			superuserReserved: 3,
			reservedConnectionsSetting: 0,
		});
	});

	it("does not run on module import — the first-call path inside `initialize` owns the check", async () => {
		// The check fires from inside `initialize` (the body that runs
		// on the first `getCaseStoreDatabase()` call), NOT at module
		// top level. Importing the module from this test file is a
		// no-side-effect operation: every test in this suite imports
		// the module via the file-level `import` block above without
		// triggering the budget throw, even when a contributor
		// experimentally edits one of the workload constants out of range.
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
		// workload/env validation. The unit-test environment has no
		// `NOVA_DB_*` set, so a passing budget check transitions
		// control to the workload validator — which rejects the absent
		// declaration. A failing budget check would surface a different
		// error first. Catching the workload error pins the ordering: the
		// budget check fired (and passed) before workload validation
		// reached its throw site.
		//
		// Pinning by the env error message is the only behavioural
		// signal available without stubbing modules. The brief notes
		// `vi.spyOn(connection, "enforceConnectionBudget")` would not
		// observe the call because production code references the
		// local binding, not the module-namespace export.
		await expect(getCaseStoreDatabase()).rejects.toThrow(
			/missing its workload declaration/,
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
