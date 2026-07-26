import { describe, expect, it, vi } from "vitest";
import {
	CAPTURE_CLEANUP_DB_ROLE_CONNECTION_LIMIT,
	MIGRATION_DB_ROLE_CONNECTION_LIMIT,
	RUNTIME_DB_ROLE_CONNECTION_LIMIT,
} from "@/lib/case-store/postgres/connection";
import {
	type DatabaseCapacityRoleConfig,
	type DatabaseCapacitySqlClient,
	readDatabaseCapacityRoleConfig,
	runDatabaseCapacityPreflight,
} from "../databaseCapacityPreflight";

const config: DatabaseCapacityRoleConfig = {
	runtimeRole: "runtime",
	migrationRole: "migration",
	cleanupRole: "cleanup",
};

function capacityClient(options?: {
	readonly runtimeSessions?: readonly number[];
	readonly roleLimits?: Readonly<Record<string, number>>;
	readonly maxConnections?: number;
	readonly superuserReservedConnections?: number;
	readonly reservedConnections?: number;
	readonly pgauditPresent?: boolean;
}): {
	readonly client: DatabaseCapacitySqlClient;
	readonly query: ReturnType<typeof vi.fn>;
} {
	const sessions = [...(options?.runtimeSessions ?? [16])];
	const roleLimits = options?.roleLimits ?? {
		runtime: 16,
		migration: 1,
		cleanup: 3,
	};
	const query = vi.fn(async (text: string) => {
		if (text.includes("FROM pg_catalog.pg_extension")) {
			return {
				rows: [{ pgaudit_present: options?.pgauditPresent ?? true }],
			};
		}
		if (text.includes("current_setting('max_connections')")) {
			return {
				rows: [
					{
						max_connections: options?.maxConnections ?? 25,
						superuser_reserved_connections:
							options?.superuserReservedConnections ?? 3,
						reserved_connections: options?.reservedConnections ?? 0,
					},
				],
			};
		}
		if (text.includes("FROM pg_catalog.pg_roles")) {
			return {
				rows: Object.entries(roleLimits).map(([rolname, rolconnlimit]) => ({
					rolname,
					rolconnlimit,
				})),
			};
		}
		if (text.includes("FROM pg_catalog.pg_stat_activity")) {
			const sessionCount = sessions.shift() ?? sessions.at(-1) ?? 16;
			return { rows: [{ session_count: sessionCount }] };
		}
		throw new Error(`Unexpected query: ${text}`);
	});
	return {
		client: { query: query as DatabaseCapacitySqlClient["query"] },
		query,
	};
}

describe("database capacity preflight", () => {
	it("requires three explicit, distinct login roles", () => {
		expect(() => readDatabaseCapacityRoleConfig({})).toThrow(
			"missing role configuration",
		);
		expect(() =>
			readDatabaseCapacityRoleConfig({
				NOVA_RUNTIME_DB_USER: "same",
				NOVA_MIGRATION_DB_USER: "same",
				NOVA_CAPTURE_CLEANUP_DB_USER: "cleanup",
			}),
		).toThrow("three distinct login roles");
		expect(
			readDatabaseCapacityRoleConfig({
				NOVA_RUNTIME_DB_USER: "runtime",
				NOVA_MIGRATION_DB_USER: "migration",
				NOVA_CAPTURE_CLEANUP_DB_USER: "cleanup",
			}),
		).toEqual(config);
	});

	it("audits settings and the migration-plus-cleanup overlap inside the hard ceiling", async () => {
		const { client } = capacityClient();
		const result = await runDatabaseCapacityPreflight(client, config);

		expect({
			runtime: RUNTIME_DB_ROLE_CONNECTION_LIMIT,
			migration: MIGRATION_DB_ROLE_CONNECTION_LIMIT,
			cleanup: CAPTURE_CLEANUP_DB_ROLE_CONNECTION_LIMIT,
			total:
				RUNTIME_DB_ROLE_CONNECTION_LIMIT +
				MIGRATION_DB_ROLE_CONNECTION_LIMIT +
				CAPTURE_CLEANUP_DB_ROLE_CONNECTION_LIMIT,
		}).toEqual({ runtime: 16, migration: 1, cleanup: 3, total: 20 });
		expect(result).toEqual({
			settings: {
				maxConnections: 25,
				superuserReservedConnections: 3,
				reservedConnections: 0,
			},
			roleLimits: { runtime: 16, migration: 1, cleanup: 3 },
			runtimeSessions: 16,
			pgauditPresent: true,
		});
	});

	it("waits for sessions opened before the cap to drain to sixteen", async () => {
		const { client } = capacityClient({ runtimeSessions: [19, 17, 16] });
		let clock = 0;
		const waits: number[] = [];

		const result = await runDatabaseCapacityPreflight(client, config, {
			timeoutMs: 10_000,
			pollIntervalMs: 100,
			now: () => clock,
			sleep: async (milliseconds) => {
				clock += milliseconds;
			},
			onWait: (sessions) => waits.push(sessions),
		});

		expect(waits).toEqual([19, 17]);
		expect(result.runtimeSessions).toBe(16);
	});

	it("fails before migration when a role limit drifts", async () => {
		const { client } = capacityClient({
			roleLimits: { runtime: 16, migration: 2, cleanup: 3 },
		});
		await expect(runDatabaseCapacityPreflight(client, config)).rejects.toThrow(
			"migration: expected 1, found 2",
		);
	});

	it("fails before migration when Cloud SQL settings drift", async () => {
		const { client } = capacityClient({ maxConnections: 24 });
		await expect(runDatabaseCapacityPreflight(client, config)).rejects.toThrow(
			"max_connections: expected 25, found 24",
		);
	});

	it("fails before migration when the pgaudit extension is absent", async () => {
		const { client } = capacityClient({ pgauditPresent: false });
		await expect(runDatabaseCapacityPreflight(client, config)).rejects.toThrow(
			"pgaudit extension is missing",
		);
	});

	it("fails closed when old runtime sessions do not drain", async () => {
		const { client } = capacityClient({ runtimeSessions: [17, 17, 17] });
		let clock = 0;
		await expect(
			runDatabaseCapacityPreflight(client, config, {
				timeoutMs: 100,
				pollIntervalMs: 100,
				now: () => clock,
				sleep: async (milliseconds) => {
					clock += milliseconds;
				},
			}),
		).rejects.toThrow("Timed out waiting for runtime database sessions");
	});
});
