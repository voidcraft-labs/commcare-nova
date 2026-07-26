import type { QueryResultRow } from "pg";
import {
	CAPTURE_CLEANUP_DB_ROLE_CONNECTION_LIMIT,
	CLOUD_SQL_CAPACITY_HEADROOM_CONNECTIONS,
	CLOUD_SQL_MAX_CONNECTIONS,
	CLOUD_SQL_RESERVED_CONNECTIONS,
	CLOUD_SQL_SUPERUSER_RESERVED_CONNECTIONS,
	MIGRATION_DB_ROLE_CONNECTION_LIMIT,
	RUNTIME_DB_ROLE_CONNECTION_LIMIT,
} from "@/lib/case-store/postgres/connection";

export const DATABASE_CAPACITY_ROLE_ENV_KEYS = [
	"NOVA_RUNTIME_DB_USER",
	"NOVA_MIGRATION_DB_USER",
	"NOVA_CAPTURE_CLEANUP_DB_USER",
] as const;

export interface DatabaseCapacityRoleConfig {
	readonly runtimeRole: string;
	readonly migrationRole: string;
	readonly cleanupRole: string;
}

export interface DatabaseCapacitySqlClient {
	query<Row extends QueryResultRow = QueryResultRow>(
		queryText: string,
		values?: unknown[],
	): Promise<{ readonly rows: Row[] }>;
}

interface RoleLimitRow extends QueryResultRow {
	readonly rolname: string;
	readonly rolconnlimit: number;
}

interface SessionCountRow extends QueryResultRow {
	readonly session_count: number;
}

interface DatabaseSettingsRow extends QueryResultRow {
	readonly max_connections: number;
	readonly superuser_reserved_connections: number;
	readonly reserved_connections: number;
}

export interface DatabaseCapacitySettings {
	readonly maxConnections: number;
	readonly superuserReservedConnections: number;
	readonly reservedConnections: number;
}

export interface DatabaseCapacityPreflightResult {
	readonly settings: DatabaseCapacitySettings;
	readonly roleLimits: Readonly<Record<string, number>>;
	readonly runtimeSessions: number;
}

export interface DatabaseCapacityPreflightOptions {
	readonly timeoutMs?: number;
	readonly pollIntervalMs?: number;
	readonly now?: () => number;
	readonly sleep?: (milliseconds: number) => Promise<void>;
	readonly onWait?: (runtimeSessions: number) => void;
}

export const DATABASE_CAPACITY_DRAIN_TIMEOUT_MS = 360_000;
export const DATABASE_CAPACITY_POLL_INTERVAL_MS = 2_000;

function nonblank(value: string | undefined): string | null {
	if (value === undefined) return null;
	const trimmed = value.trim();
	return trimmed.length === 0 ? null : trimmed;
}

export function readDatabaseCapacityRoleConfig(
	env: Readonly<Partial<Record<string, string>>> = process.env,
): DatabaseCapacityRoleConfig {
	const values = DATABASE_CAPACITY_ROLE_ENV_KEYS.map((key) =>
		nonblank(env[key]),
	);
	const missing = DATABASE_CAPACITY_ROLE_ENV_KEYS.filter(
		(_key, index) => values[index] === null,
	);
	if (missing.length > 0) {
		throw new Error(
			`Database capacity preflight is missing role configuration: ${missing.join(", ")}.`,
		);
	}
	const [runtimeRole, migrationRole, cleanupRole] = values as [
		string,
		string,
		string,
	];
	if (new Set(values).size !== values.length) {
		throw new Error(
			"Database capacity preflight roles must be three distinct login roles.",
		);
	}
	return { runtimeRole, migrationRole, cleanupRole };
}

export function expectedDatabaseRoleConnectionLimits(
	config: DatabaseCapacityRoleConfig,
): Readonly<Record<string, number>> {
	return Object.freeze({
		[config.runtimeRole]: RUNTIME_DB_ROLE_CONNECTION_LIMIT,
		[config.migrationRole]: MIGRATION_DB_ROLE_CONNECTION_LIMIT,
		[config.cleanupRole]: CAPTURE_CLEANUP_DB_ROLE_CONNECTION_LIMIT,
	});
}

export function assertDatabaseRoleConnectionLimits(
	actual: Readonly<Record<string, number>>,
	config: DatabaseCapacityRoleConfig,
): void {
	const expected = expectedDatabaseRoleConnectionLimits(config);
	const mismatches = Object.entries(expected)
		.filter(([role, limit]) => actual[role] !== limit)
		.map(
			([role, limit]) =>
				`${role}: expected ${limit}, found ${actual[role] ?? "missing"}`,
		);
	if (mismatches.length > 0) {
		throw new Error(
			[
				"Database login-role connection limits do not match the production capacity contract.",
				"",
				...mismatches.map((mismatch) => `    ${mismatch}`),
				"",
				"Apply the privileged database bootstrap before retrying this deploy.",
			].join("\n"),
		);
	}

	const applicationBudget =
		CLOUD_SQL_MAX_CONNECTIONS - CLOUD_SQL_CAPACITY_HEADROOM_CONNECTIONS;
	const hardPeak = Object.values(expected).reduce(
		(total, limit) => total + limit,
		0,
	);
	if (hardPeak > applicationBudget) {
		throw new Error(
			`Database login-role limits total ${hardPeak}, above the ${applicationBudget}-connection application budget.`,
		);
	}
}

export function assertDatabaseCapacitySettings(
	settings: DatabaseCapacitySettings,
): void {
	const mismatches: string[] = [];
	if (settings.maxConnections !== CLOUD_SQL_MAX_CONNECTIONS) {
		mismatches.push(
			`max_connections: expected ${CLOUD_SQL_MAX_CONNECTIONS}, found ${settings.maxConnections}`,
		);
	}
	if (
		settings.superuserReservedConnections !==
		CLOUD_SQL_SUPERUSER_RESERVED_CONNECTIONS
	) {
		mismatches.push(
			`superuser_reserved_connections: expected ${CLOUD_SQL_SUPERUSER_RESERVED_CONNECTIONS}, found ${settings.superuserReservedConnections}`,
		);
	}
	if (settings.reservedConnections !== CLOUD_SQL_RESERVED_CONNECTIONS) {
		mismatches.push(
			`reserved_connections: expected ${CLOUD_SQL_RESERVED_CONNECTIONS}, found ${settings.reservedConnections}`,
		);
	}
	if (mismatches.length > 0) {
		throw new Error(
			[
				"Cloud SQL connection settings do not match the production capacity contract.",
				"",
				...mismatches.map((mismatch) => `    ${mismatch}`),
				"",
				"Re-run the Cloud SQL provisioning convergence before retrying this deploy.",
			].join("\n"),
		);
	}
}

async function readDatabaseCapacitySettings(
	client: DatabaseCapacitySqlClient,
): Promise<DatabaseCapacitySettings> {
	const result = await client.query<DatabaseSettingsRow>(
		`SELECT
			current_setting('max_connections')::integer AS max_connections,
			current_setting('superuser_reserved_connections')::integer
				AS superuser_reserved_connections,
			current_setting('reserved_connections')::integer
				AS reserved_connections`,
	);
	const row = result.rows[0];
	if (row === undefined) {
		throw new Error("Database capacity settings query returned no row.");
	}
	return {
		maxConnections: row.max_connections,
		superuserReservedConnections: row.superuser_reserved_connections,
		reservedConnections: row.reserved_connections,
	};
}

async function readRoleConnectionLimits(
	client: DatabaseCapacitySqlClient,
	config: DatabaseCapacityRoleConfig,
): Promise<Readonly<Record<string, number>>> {
	const roles = [config.runtimeRole, config.migrationRole, config.cleanupRole];
	const result = await client.query<RoleLimitRow>(
		`SELECT rolname, rolconnlimit::integer AS rolconnlimit
		FROM pg_catalog.pg_roles
		WHERE rolname = ANY($1::text[])
			AND rolcanlogin
			AND NOT rolsuper
		ORDER BY rolname`,
		[roles],
	);
	return Object.freeze(
		Object.fromEntries(
			result.rows.map((row) => [row.rolname, row.rolconnlimit]),
		),
	);
}

async function readRuntimeSessionCount(
	client: DatabaseCapacitySqlClient,
	runtimeRole: string,
): Promise<number> {
	const result = await client.query<SessionCountRow>(
		`SELECT count(*)::integer AS session_count
		FROM pg_catalog.pg_stat_activity
		WHERE usename = $1
			AND backend_type = 'client backend'`,
		[runtimeRole],
	);
	const count = result.rows[0]?.session_count;
	if (count === undefined) {
		throw new Error("Database capacity session-count query returned no row.");
	}
	return count;
}

function defaultSleep(milliseconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/**
 * Audit the cluster-wide, non-inherited login-role limits and wait for sessions
 * opened before a lowered limit took effect to drain under the runtime cap.
 */
export async function runDatabaseCapacityPreflight(
	client: DatabaseCapacitySqlClient,
	config: DatabaseCapacityRoleConfig,
	options: DatabaseCapacityPreflightOptions = {},
): Promise<DatabaseCapacityPreflightResult> {
	const timeoutMs = options.timeoutMs ?? DATABASE_CAPACITY_DRAIN_TIMEOUT_MS;
	const pollIntervalMs =
		options.pollIntervalMs ?? DATABASE_CAPACITY_POLL_INTERVAL_MS;
	const now = options.now ?? Date.now;
	const sleep = options.sleep ?? defaultSleep;
	const deadline = now() + timeoutMs;

	for (;;) {
		const settings = await readDatabaseCapacitySettings(client);
		assertDatabaseCapacitySettings(settings);
		const roleLimits = await readRoleConnectionLimits(client, config);
		assertDatabaseRoleConnectionLimits(roleLimits, config);
		const runtimeSessions = await readRuntimeSessionCount(
			client,
			config.runtimeRole,
		);
		if (runtimeSessions <= RUNTIME_DB_ROLE_CONNECTION_LIMIT) {
			return { settings, roleLimits, runtimeSessions };
		}
		if (now() >= deadline) {
			throw new Error(
				`Timed out waiting for runtime database sessions to drain to ${RUNTIME_DB_ROLE_CONNECTION_LIMIT}; found ${runtimeSessions}.`,
			);
		}
		options.onWait?.(runtimeSessions);
		await sleep(pollIntervalMs);
	}
}
