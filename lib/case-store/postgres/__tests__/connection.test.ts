/** Pure process configuration. Actual singleton sharing, shutdown and dropped
 * connections are exercised in connection.postgres.test.ts. */
import { PassThrough } from "node:stream";
import { IpAddressTypes } from "@google-cloud/cloud-sql-connector";
import { expect, it, vi } from "vitest";
import {
	AUDIT_DB_ROLE_CONNECTION_LIMIT,
	AUDIT_POOL_MAX_PER_EXECUTION,
	buildPoolConfig,
	CAPTURE_CLEANUP_DB_ROLE_CONNECTION_LIMIT,
	CAPTURE_CLEANUP_LOCK_CONTENDER_CONNECTIONS,
	CAPTURE_CLEANUP_POOL_MAX_PER_EXECUTION,
	CLOUD_RUN_MAX_INSTANCES,
	CLOUD_SQL_CAPACITY_HEADROOM_CONNECTIONS,
	CLOUD_SQL_MAX_CONNECTIONS,
	CLOUD_SQL_ORDINARY_LOGIN_HEADROOM_CONNECTIONS,
	CLOUD_SQL_RESERVED_CONNECTIONS,
	CLOUD_SQL_SUPERUSER_RESERVED_CONNECTIONS,
	closeCaseStoreDatabase,
	enforceConnectionBudget,
	getCaseStoreDatabase,
	LISTENER_CONNECTIONS_PER_INSTANCE,
	MIGRATION_DB_ROLE_CONNECTION_LIMIT,
	MIGRATION_POOL_MAX_PER_EXECUTION,
	OPERATOR_POOL_MAX_PER_PROCESS,
	POOL_MAX_PER_INSTANCE,
	poolMaxForWorkload,
	RUNTIME_DB_ROLE_CONNECTION_LIMIT,
	readCaseStoreEnvConfig,
	readCaseStoreIpType,
	readCaseStoreWorkload,
} from "../connection";

const env = {
	NOVA_DB_NAME: "nova_cases",
	NOVA_DB_USER: "nova-runtime@example.iam",
	NOVA_DB_INSTANCE_CONNECTION_NAME: "project:region:instance",
};
it("validates all required connection settings and reports every missing one together", () => {
	expect(readCaseStoreEnvConfig(env)).toEqual(env);
	for (const name of [
		"NOVA_DB_NAME",
		"NOVA_DB_USER",
		"NOVA_DB_INSTANCE_CONNECTION_NAME",
	])
		for (const value of [undefined, ""])
			expect(() => readCaseStoreEnvConfig({ ...env, [name]: value })).toThrow(
				new RegExp(`missing: ${name}\\n`),
			);
	expect(() => readCaseStoreEnvConfig({})).toThrow(
		/missing: NOVA_DB_NAME, NOVA_DB_USER, NOVA_DB_INSTANCE_CONNECTION_NAME/,
	);
});

it("defaults to private IP and accepts public IP only as an explicit exact choice", () => {
	for (const value of [undefined, "", "PRIVATE"])
		expect(readCaseStoreIpType({ NOVA_DB_IP_TYPE: value })).toBe(
			IpAddressTypes.PRIVATE,
		);
	expect(readCaseStoreIpType({ NOVA_DB_IP_TYPE: "PUBLIC" })).toBe(
		IpAddressTypes.PUBLIC,
	);
	for (const value of ["public", "psc", "PSC", "both", " PUBLIC "])
		expect(() => readCaseStoreIpType({ NOVA_DB_IP_TYPE: value })).toThrow(
			/unrecognized NOVA_DB_IP_TYPE/,
		);
});

it.each([
	["service", 3],
	["migration", 1],
	["capture-cleanup", 2],
	["audit", 1],
	["operator", 1],
] as const)(
	"configures the %s workload and keeps connector authentication and schema routing intact",
	(workload, max) => {
		const stream = () => new PassThrough();
		expect(readCaseStoreWorkload({ NOVA_DB_WORKLOAD: workload })).toBe(
			workload,
		);
		expect(poolMaxForWorkload(workload)).toBe(max);
		expect(buildPoolConfig({ stream }, env, workload)).toEqual({
			stream,
			user: env.NOVA_DB_USER,
			database: env.NOVA_DB_NAME,
			options: "-c search_path=public,nova_case_runtime",
			max,
			connectionTimeoutMillis: 10_000,
		});
	},
);

it("requires a production workload but allows explicit local development to use the service default", () => {
	for (const value of [undefined, ""])
		expect(() => readCaseStoreWorkload({ NOVA_DB_WORKLOAD: value })).toThrow(
			/missing its workload declaration/,
		);
	for (const value of ["cleanup", "SERVICE", " service "])
		expect(() => readCaseStoreWorkload({ NOVA_DB_WORKLOAD: value })).toThrow(
			/unrecognized workload declaration/,
		);
	expect(
		readCaseStoreWorkload({ NOVA_DB_LOCAL_URL: "postgres://localhost/local" }),
	).toBe("service");
	// A local URL does not override an explicitly selected maintenance workload.
	expect(
		readCaseStoreWorkload({
			NOVA_DB_LOCAL_URL: "postgres://localhost/local",
			NOVA_DB_WORKLOAD: "migration",
		}),
	).toBe("migration");
});

it("refuses singleton initialization before any connection when the workload is missing", async () => {
	vi.stubEnv("NOVA_DB_WORKLOAD", undefined);
	vi.stubEnv("NOVA_DB_LOCAL_URL", undefined);
	try {
		await expect(getCaseStoreDatabase()).rejects.toThrow(
			/missing its workload declaration/,
		);
	} finally {
		await closeCaseStoreDatabase();
		vi.unstubAllEnvs();
	}
});

it("keeps serving and maintenance allocations within the deployed database capacity", () => {
	expect(() => enforceConnectionBudget()).not.toThrow();
	expect({
		max: CLOUD_SQL_MAX_CONNECTIONS,
		service:
			CLOUD_RUN_MAX_INSTANCES *
			(POOL_MAX_PER_INSTANCE + LISTENER_CONNECTIONS_PER_INSTANCE),
		runtimeRole: RUNTIME_DB_ROLE_CONNECTION_LIMIT,
		migration: [
			MIGRATION_POOL_MAX_PER_EXECUTION,
			MIGRATION_DB_ROLE_CONNECTION_LIMIT,
		],
		cleanup: [
			CAPTURE_CLEANUP_POOL_MAX_PER_EXECUTION +
				CAPTURE_CLEANUP_LOCK_CONTENDER_CONNECTIONS,
			CAPTURE_CLEANUP_DB_ROLE_CONNECTION_LIMIT,
		],
		audit: [AUDIT_POOL_MAX_PER_EXECUTION, AUDIT_DB_ROLE_CONNECTION_LIMIT],
		operator: OPERATOR_POOL_MAX_PER_PROCESS,
		headroom: [
			CLOUD_SQL_CAPACITY_HEADROOM_CONNECTIONS,
			CLOUD_SQL_ORDINARY_LOGIN_HEADROOM_CONNECTIONS,
			CLOUD_SQL_SUPERUSER_RESERVED_CONNECTIONS,
			CLOUD_SQL_RESERVED_CONNECTIONS,
		],
	}).toEqual({
		max: 25,
		service: 16,
		runtimeRole: 16,
		migration: [1, 1],
		cleanup: [3, 3],
		audit: [1, 1],
		operator: 1,
		headroom: [4, 1, 3, 0],
	});
});
