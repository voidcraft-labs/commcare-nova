import { type Kysely, sql, type Transaction } from "kysely";
import { AUTH_TABLE_NAMES } from "@/lib/auth-schema-shared";

export const DATABASE_PRIVILEGE_ROLE_ENV_KEYS = [
	"NOVA_MIGRATION_DB_USER",
	"NOVA_RUNTIME_DB_USER",
	"NOVA_ROLLOUT_DB_USER",
] as const;

export interface DatabasePrivilegeRoleConfig {
	readonly migrationRole: string;
	readonly runtimeRole: string;
	readonly rolloutRole: string;
}

export class DatabasePrivilegeConvergenceError extends Error {
	readonly code:
		| "role_config_missing"
		| "role_config_partial"
		| "role_config_invalid"
		| "role_policy_invalid"
		| "schema_inventory_drift";

	constructor(
		code: DatabasePrivilegeConvergenceError["code"],
		message: string,
	) {
		super(message);
		this.name = "DatabasePrivilegeConvergenceError";
		this.code = code;
	}
}

function nonblankEnvValue(value: string | undefined): string | null {
	if (value === undefined) return null;
	const trimmed = value.trim();
	return trimmed.length === 0 ? null : trimmed;
}

/** Production must name all three SQL login roles. Local migration explicitly
 * opts out through `NOVA_DB_LOCAL_URL`; an absent production contract never
 * silently preserves the historical owner-everything runtime identity. */
export function readDatabasePrivilegeRoleConfig(
	env: NodeJS.ProcessEnv = process.env,
): DatabasePrivilegeRoleConfig | null {
	const values = DATABASE_PRIVILEGE_ROLE_ENV_KEYS.map((key) =>
		nonblankEnvValue(env[key]),
	);
	const configured = values.filter((value) => value !== null);
	if (configured.length === 0) {
		if (nonblankEnvValue(env.NOVA_DB_LOCAL_URL) !== null) return null;
		throw new DatabasePrivilegeConvergenceError(
			"role_config_missing",
			`Production database privilege convergence requires ${DATABASE_PRIVILEGE_ROLE_ENV_KEYS.join(", ")}.`,
		);
	}
	if (configured.length !== DATABASE_PRIVILEGE_ROLE_ENV_KEYS.length) {
		const missing = DATABASE_PRIVILEGE_ROLE_ENV_KEYS.filter(
			(key) => nonblankEnvValue(env[key]) === null,
		);
		throw new DatabasePrivilegeConvergenceError(
			"role_config_partial",
			`Database privilege role configuration is partial; missing ${missing.join(", ")}.`,
		);
	}

	const [migrationRole, runtimeRole, rolloutRole] = values as [
		string,
		string,
		string,
	];
	const roles = [migrationRole, runtimeRole, rolloutRole];
	if (
		new Set(roles).size !== roles.length ||
		roles.some((role) => role.toUpperCase() === "PUBLIC")
	) {
		throw new DatabasePrivilegeConvergenceError(
			"role_config_invalid",
			"Migration, runtime, and rollout database roles must be distinct and cannot be PUBLIC.",
		);
	}
	return { migrationRole, runtimeRole, rolloutRole };
}

export type PublicTableClass = "application" | "control" | "migration";

const APPLICATION_TABLES = [
	"case_indices",
	"case_type_schemas",
	"cases",
	"cases_quarantine",
	"parked_case_values",
	"apps",
	"blueprint_entities",
	"accepted_mutations",
	"events",
	"threads",
	"chat_stream_chunks",
	"run_summaries",
	"presence",
	"user_settings",
	"usage_months",
	"credit_months",
	"credit_grants",
	"media_assets",
	"media_asset_refs",
	"lookup_project_state",
	"lookup_tables",
	"lookup_columns",
	"lookup_rows",
	"lookup_table_references",
	"lookup_column_references",
	"lookup_stream_capability_leases",
	...Object.values(AUTH_TABLE_NAMES),
	"auth_oauth_grant_revocation",
] as const;

const CONTROL_TABLES = [
	"lookup_reference_compatibility",
	"runtime_reader_traffic_epochs",
	"deployment_rollouts",
	"deployment_rollout_transitions",
] as const;

const MIGRATION_TABLES = [
	"kysely_migration",
	"kysely_migration_lock",
	"auth_app_kysely_migration",
	"auth_app_kysely_migration_lock",
] as const;

/** Atlas preceded Kysely in production. Fresh databases do not have this
 * ledger, but a retained production ledger is known migration-owned state. */
const OPTIONAL_MIGRATION_TABLES = ["atlas_schema_revisions"] as const;

const TABLE_CLASSES = new Map<string, PublicTableClass>([
	...APPLICATION_TABLES.map((name) => [name, "application"] as const),
	...CONTROL_TABLES.map((name) => [name, "control"] as const),
	...MIGRATION_TABLES.map((name) => [name, "migration"] as const),
	...OPTIONAL_MIGRATION_TABLES.map((name) => [name, "migration"] as const),
]);

export const REQUIRED_PUBLIC_TABLES = [
	...APPLICATION_TABLES,
	...CONTROL_TABLES,
	...MIGRATION_TABLES,
] as const;

export function classifyPublicTable(name: string): PublicTableClass | null {
	return TABLE_CLASSES.get(name) ?? null;
}

export interface PublicTableAudit {
	readonly name: string;
	readonly classification: PublicTableClass;
}

/** Pure structural fail-closed audit used by convergence and its unit tests. */
export function auditPublicTableInventory(
	tableNames: readonly string[],
): readonly PublicTableAudit[] {
	const actual = new Set(tableNames);
	const unknown = [...actual]
		.filter((name) => classifyPublicTable(name) === null)
		.sort();
	const missing = REQUIRED_PUBLIC_TABLES.filter((name) => !actual.has(name));
	if (unknown.length > 0 || missing.length > 0) {
		throw new DatabasePrivilegeConvergenceError(
			"schema_inventory_drift",
			[
				"Database privilege inventory does not match the migrated public schema.",
				`unknown tables: ${unknown.join(", ") || "(none)"}`,
				`missing tables: ${missing.join(", ") || "(none)"}`,
			].join("\n"),
		);
	}
	return [...actual].sort().map((name) => ({
		name,
		classification: classifyPublicTable(name) as PublicTableClass,
	}));
}

export interface DatabaseRoleFact {
	readonly name: string;
	readonly superuser: boolean;
	readonly createRole: boolean;
	readonly createDatabase: boolean;
	readonly bypassRls: boolean;
}

export interface DatabaseRoleMembershipFacts {
	readonly currentCanUseMigration: boolean;
	readonly migrationCanUseRuntime: boolean;
	readonly runtimeCanUseMigration: boolean;
	readonly runtimeCanUseRollout: boolean;
	readonly rolloutCanUseMigration: boolean;
	readonly rolloutCanUseRuntime: boolean;
}

/** The migration identity is the only privileged path. Its runtime membership
 * is required to maintain the temporary runtime-owned `cases` table; neither
 * serving identity may inherit another serving/control role. */
export function assertDatabaseRolePolicy(
	config: DatabasePrivilegeRoleConfig,
	roleFacts: readonly DatabaseRoleFact[],
	membership: DatabaseRoleMembershipFacts,
): void {
	const byName = new Map(roleFacts.map((role) => [role.name, role]));
	const missing = [
		config.migrationRole,
		config.runtimeRole,
		config.rolloutRole,
	].filter((name) => !byName.has(name));
	if (missing.length > 0) {
		throw new DatabasePrivilegeConvergenceError(
			"role_policy_invalid",
			`Configured database roles do not exist: ${missing.join(", ")}.`,
		);
	}
	const administrative = [...byName.values()].filter(
		(role) =>
			role.superuser ||
			role.createRole ||
			role.createDatabase ||
			role.bypassRls,
	);
	if (administrative.length > 0) {
		throw new DatabasePrivilegeConvergenceError(
			"role_policy_invalid",
			`Nova database roles cannot hold cluster-administrator attributes: ${administrative.map((role) => role.name).join(", ")}.`,
		);
	}
	if (!membership.currentCanUseMigration) {
		throw new DatabasePrivilegeConvergenceError(
			"role_policy_invalid",
			"The migration connection is not authorized to use the configured migration role.",
		);
	}
	if (!membership.migrationCanUseRuntime) {
		throw new DatabasePrivilegeConvergenceError(
			"role_policy_invalid",
			"The migration role must be a member of the runtime role while `cases` remains runtime-owned.",
		);
	}
	if (
		membership.runtimeCanUseMigration ||
		membership.runtimeCanUseRollout ||
		membership.rolloutCanUseMigration ||
		membership.rolloutCanUseRuntime
	) {
		throw new DatabasePrivilegeConvergenceError(
			"role_policy_invalid",
			"Runtime and rollout roles must not inherit migration or each other's privileges.",
		);
	}
}

const EXPECTED_PUBLIC_ROUTINES = [
	"nova_guard_lookup_reference_compatibility_row",
	"nova_require_lookup_reference_writer_version",
	"nova_lock_deployment_cutover_gate",
	"nova_reject_runtime_epoch_truncate",
	"nova_stamp_runtime_reader_holder",
	"nova_lock_auth_member_membership_gate",
	"nova_reject_auth_member_truncate",
] as const;

const RUNTIME_ROUTINES = [
	"nova_require_lookup_reference_writer_version",
	"nova_stamp_runtime_reader_holder",
	"nova_lock_auth_member_membership_gate",
	"nova_reject_auth_member_truncate",
] as const;

const ROLLOUT_ROUTINES = [
	"nova_guard_lookup_reference_compatibility_row",
	"nova_lock_deployment_cutover_gate",
	"nova_reject_runtime_epoch_truncate",
] as const;

interface PublicRelationRow {
	readonly name: string;
	readonly extension_owned: boolean;
}

interface PublicRoutineRow extends PublicRelationRow {
	readonly identity_arguments: string;
}

interface PublicSequenceRow extends PublicRelationRow {
	readonly owned_by: string | null;
}

interface RoleRow {
	readonly name: string;
	readonly superuser: boolean;
	readonly create_role: boolean;
	readonly create_database: boolean;
	readonly bypass_rls: boolean;
}

async function readAndAssertRolePolicy(
	tx: Transaction<unknown>,
	config: DatabasePrivilegeRoleConfig,
): Promise<void> {
	const roleNames = [
		config.migrationRole,
		config.runtimeRole,
		config.rolloutRole,
	];
	const roles = await sql<RoleRow>`
		SELECT
			rolname AS name,
			rolsuper AS superuser,
			rolcreaterole AS create_role,
			rolcreatedb AS create_database,
			rolbypassrls AS bypass_rls
		FROM pg_catalog.pg_roles
		WHERE rolname IN (${sql.join(roleNames)})
	`.execute(tx);
	const membership = await sql<DatabaseRoleMembershipFacts>`
		SELECT
			pg_catalog.pg_has_role(
				current_user,
				${config.migrationRole},
				'USAGE'
			) AS "currentCanUseMigration",
			pg_catalog.pg_has_role(
				${config.migrationRole},
				${config.runtimeRole},
				'USAGE'
			) AS "migrationCanUseRuntime",
			pg_catalog.pg_has_role(
				${config.runtimeRole},
				${config.migrationRole},
				'USAGE'
			) AS "runtimeCanUseMigration",
			pg_catalog.pg_has_role(
				${config.runtimeRole},
				${config.rolloutRole},
				'USAGE'
			) AS "runtimeCanUseRollout",
			pg_catalog.pg_has_role(
				${config.rolloutRole},
				${config.migrationRole},
				'USAGE'
			) AS "rolloutCanUseMigration",
			pg_catalog.pg_has_role(
				${config.rolloutRole},
				${config.runtimeRole},
				'USAGE'
			) AS "rolloutCanUseRuntime"
	`.execute(tx);
	const membershipRow = membership.rows[0];
	if (!membershipRow)
		throw new Error("Database role membership query returned no row.");
	assertDatabaseRolePolicy(
		config,
		roles.rows.map((role) => ({
			name: role.name,
			superuser: role.superuser,
			createRole: role.create_role,
			createDatabase: role.create_database,
			bypassRls: role.bypass_rls,
		})),
		membershipRow,
	);
}

async function readPublicTables(
	tx: Transaction<unknown>,
): Promise<readonly PublicRelationRow[]> {
	const result = await sql<PublicRelationRow>`
		SELECT
			class.relname AS name,
			EXISTS (
				SELECT 1
				FROM pg_catalog.pg_depend AS dependency
				WHERE dependency.classid = 'pg_catalog.pg_class'::regclass
					AND dependency.objid = class.oid
					AND dependency.refclassid = 'pg_catalog.pg_extension'::regclass
					AND dependency.deptype = 'e'
			) AS extension_owned
		FROM pg_catalog.pg_class AS class
		JOIN pg_catalog.pg_namespace AS namespace
			ON namespace.oid = class.relnamespace
		WHERE namespace.nspname = 'public'
			AND class.relkind IN ('r', 'p')
		ORDER BY class.relname
	`.execute(tx);
	return result.rows;
}

async function readPublicRoutines(
	tx: Transaction<unknown>,
): Promise<readonly PublicRoutineRow[]> {
	const result = await sql<PublicRoutineRow>`
		SELECT
			procedure.proname AS name,
			pg_catalog.pg_get_function_identity_arguments(procedure.oid)
				AS identity_arguments,
			EXISTS (
				SELECT 1
				FROM pg_catalog.pg_depend AS dependency
				WHERE dependency.classid = 'pg_catalog.pg_proc'::regclass
					AND dependency.objid = procedure.oid
					AND dependency.refclassid = 'pg_catalog.pg_extension'::regclass
					AND dependency.deptype = 'e'
			) AS extension_owned
		FROM pg_catalog.pg_proc AS procedure
		JOIN pg_catalog.pg_namespace AS namespace
			ON namespace.oid = procedure.pronamespace
		WHERE namespace.nspname = 'public'
			AND procedure.prokind IN ('f', 'p')
		ORDER BY procedure.proname, identity_arguments
	`.execute(tx);
	return result.rows;
}

async function readPublicSequences(
	tx: Transaction<unknown>,
): Promise<readonly PublicSequenceRow[]> {
	const result = await sql<PublicSequenceRow>`
		SELECT
			sequence.relname AS name,
			(
				SELECT parent.relname
				FROM pg_catalog.pg_depend AS dependency
				JOIN pg_catalog.pg_class AS parent
					ON parent.oid = dependency.refobjid
				WHERE dependency.classid = 'pg_catalog.pg_class'::regclass
					AND dependency.objid = sequence.oid
					AND dependency.refclassid = 'pg_catalog.pg_class'::regclass
					AND dependency.deptype IN ('a', 'i')
				LIMIT 1
			) AS owned_by,
			EXISTS (
				SELECT 1
				FROM pg_catalog.pg_depend AS dependency
				WHERE dependency.classid = 'pg_catalog.pg_class'::regclass
					AND dependency.objid = sequence.oid
					AND dependency.refclassid = 'pg_catalog.pg_extension'::regclass
					AND dependency.deptype = 'e'
			) AS extension_owned
		FROM pg_catalog.pg_class AS sequence
		JOIN pg_catalog.pg_namespace AS namespace
			ON namespace.oid = sequence.relnamespace
		WHERE namespace.nspname = 'public'
			AND sequence.relkind = 'S'
		ORDER BY sequence.relname
	`.execute(tx);
	return result.rows;
}

function auditPublicRoutines(rows: readonly PublicRoutineRow[]): void {
	const actual = rows
		.filter((row) => !row.extension_owned)
		.map((row) => `${row.name}(${row.identity_arguments})`);
	const expected = EXPECTED_PUBLIC_ROUTINES.map((name) => `${name}()`);
	const expectedSet = new Set(expected);
	const actualSet = new Set(actual);
	const unknown = actual.filter((name) => !expectedSet.has(name));
	const missing = expected.filter((name) => !actualSet.has(name));
	if (unknown.length > 0 || missing.length > 0) {
		throw new DatabasePrivilegeConvergenceError(
			"schema_inventory_drift",
			`Public routine inventory drifted; unknown: ${unknown.join(", ") || "(none)"}; missing: ${missing.join(", ") || "(none)"}.`,
		);
	}
}

function auditPublicSequences(rows: readonly PublicSequenceRow[]): void {
	const invalid = rows
		.filter((row) => !row.extension_owned)
		.filter(
			(row) =>
				row.owned_by === null || classifyPublicTable(row.owned_by) === null,
		);
	if (invalid.length > 0) {
		throw new DatabasePrivilegeConvergenceError(
			"schema_inventory_drift",
			`Public sequences must belong to a classified table: ${invalid.map((row) => row.name).join(", ")}.`,
		);
	}
}

async function alterTableOwner(
	tx: Transaction<unknown>,
	table: string,
	role: string,
): Promise<void> {
	await sql`ALTER TABLE public.${sql.id(table)} OWNER TO ${sql.id(role)}`.execute(
		tx,
	);
}

async function revokeTableAccess(
	tx: Transaction<unknown>,
	table: string,
	config: DatabasePrivilegeRoleConfig,
): Promise<void> {
	await sql`
		REVOKE ALL PRIVILEGES ON TABLE public.${sql.id(table)}
		FROM PUBLIC, ${sql.id(config.runtimeRole)}, ${sql.id(config.rolloutRole)}
	`.execute(tx);
}

async function grantRuntimeDml(
	tx: Transaction<unknown>,
	table: string,
	runtimeRole: string,
): Promise<void> {
	await sql`
		GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.${sql.id(table)}
		TO ${sql.id(runtimeRole)}
	`.execute(tx);
}

async function convergePrivilegesInTransaction(
	tx: Transaction<unknown>,
	config: DatabasePrivilegeRoleConfig,
): Promise<void> {
	await readAndAssertRolePolicy(tx, config);
	const tables = (await readPublicTables(tx)).filter(
		(table) => !table.extension_owned,
	);
	const tableAudit = auditPublicTableInventory(
		tables.map((table) => table.name),
	);
	const routines = await readPublicRoutines(tx);
	const sequences = await readPublicSequences(tx);
	auditPublicRoutines(routines);
	auditPublicSequences(sequences);

	const database = await sql<{ name: string }>`
		SELECT pg_catalog.current_database() AS name
	`.execute(tx);
	const databaseName = database.rows[0]?.name;
	if (!databaseName) throw new Error("Current database query returned no row.");

	await sql`
		REVOKE CREATE ON DATABASE ${sql.id(databaseName)}
		FROM PUBLIC, ${sql.id(config.runtimeRole)}, ${sql.id(config.rolloutRole)}
	`.execute(tx);
	await sql`
		GRANT CREATE ON DATABASE ${sql.id(databaseName)}
		TO ${sql.id(config.migrationRole)}
	`.execute(tx);
	await sql`
		REVOKE ALL PRIVILEGES ON SCHEMA public
		FROM PUBLIC, ${sql.id(config.runtimeRole)}, ${sql.id(config.rolloutRole)}
	`.execute(tx);
	await sql`
		GRANT USAGE, CREATE ON SCHEMA public TO ${sql.id(config.migrationRole)}
	`.execute(tx);
	// Indexes always live in their parent table's schema and CREATE INDEX is an
	// ownership operation. Runtime owns only `cases`; schema CREATE would let a
	// compromised serving process manufacture arbitrary public-schema objects.
	await sql`
		GRANT USAGE ON SCHEMA public TO ${sql.id(config.runtimeRole)}
	`.execute(tx);
	await sql`
		GRANT USAGE ON SCHEMA public TO ${sql.id(config.rolloutRole)}
	`.execute(tx);

	for (const table of tableAudit) {
		const owner =
			table.name === "cases" ? config.runtimeRole : config.migrationRole;
		await alterTableOwner(tx, table.name, owner);
		await revokeTableAccess(tx, table.name, config);
		if (table.classification === "application") {
			await grantRuntimeDml(tx, table.name, config.runtimeRole);
		}
	}

	for (const sequence of sequences.filter((row) => !row.extension_owned)) {
		const parent = sequence.owned_by;
		if (parent === null)
			throw new Error("Audited sequence lost its owner table.");
		const owner =
			parent === "cases" ? config.runtimeRole : config.migrationRole;
		await sql`
			ALTER SEQUENCE public.${sql.id(sequence.name)} OWNER TO ${sql.id(owner)}
		`.execute(tx);
		await sql`
			REVOKE ALL PRIVILEGES ON SEQUENCE public.${sql.id(sequence.name)}
			FROM PUBLIC, ${sql.id(config.runtimeRole)}, ${sql.id(config.rolloutRole)}
		`.execute(tx);
		if (classifyPublicTable(parent) === "application") {
			await sql`
				GRANT USAGE, SELECT ON SEQUENCE public.${sql.id(sequence.name)}
				TO ${sql.id(config.runtimeRole)}
			`.execute(tx);
		}
	}

	for (const routine of routines.filter((row) => !row.extension_owned)) {
		await sql`
			ALTER FUNCTION public.${sql.id(routine.name)}()
			OWNER TO ${sql.id(config.migrationRole)}
		`.execute(tx);
		await sql`
			REVOKE ALL PRIVILEGES ON FUNCTION public.${sql.id(routine.name)}()
			FROM PUBLIC, ${sql.id(config.runtimeRole)}, ${sql.id(config.rolloutRole)}
		`.execute(tx);
	}
	for (const routine of RUNTIME_ROUTINES) {
		await sql`
			GRANT EXECUTE ON FUNCTION public.${sql.id(routine)}()
			TO ${sql.id(config.runtimeRole)}
		`.execute(tx);
	}
	for (const routine of ROLLOUT_ROUTINES) {
		await sql`
			GRANT EXECUTE ON FUNCTION public.${sql.id(routine)}()
			TO ${sql.id(config.rolloutRole)}
		`.execute(tx);
	}

	await sql`
		GRANT SELECT ON TABLE public.lookup_reference_compatibility,
			public.runtime_reader_traffic_epochs
		TO ${sql.id(config.runtimeRole)}
	`.execute(tx);
	await sql`
		GRANT SELECT ON TABLE public.lookup_reference_compatibility
		TO ${sql.id(config.rolloutRole)}
	`.execute(tx);
	await sql`
		GRANT UPDATE (continuous_registry_traffic_since, updated_at)
		ON TABLE public.lookup_reference_compatibility
		TO ${sql.id(config.rolloutRole)}
	`.execute(tx);
	await sql`
		GRANT SELECT, DELETE ON TABLE public.runtime_reader_traffic_epochs
		TO ${sql.id(config.rolloutRole)}
	`.execute(tx);
	await sql`
		GRANT SELECT, INSERT, UPDATE ON TABLE public.deployment_rollouts
		TO ${sql.id(config.rolloutRole)}
	`.execute(tx);
	await sql`
		GRANT SELECT, INSERT ON TABLE public.deployment_rollout_transitions
		TO ${sql.id(config.rolloutRole)}
	`.execute(tx);

	for (const objectType of ["TABLES", "SEQUENCES"] as const) {
		await sql`
			ALTER DEFAULT PRIVILEGES FOR ROLE ${sql.id(config.migrationRole)}
			IN SCHEMA public REVOKE ALL PRIVILEGES ON ${sql.raw(objectType)}
			FROM PUBLIC, ${sql.id(config.runtimeRole)}, ${sql.id(config.rolloutRole)}
		`.execute(tx);
	}
	await sql`
		ALTER DEFAULT PRIVILEGES FOR ROLE ${sql.id(config.migrationRole)}
		IN SCHEMA public REVOKE ALL PRIVILEGES ON FUNCTIONS
		FROM PUBLIC, ${sql.id(config.runtimeRole)}, ${sql.id(config.rolloutRole)}
	`.execute(tx);
}

/** Re-audit and converge ownership/grants after all three migration phases.
 * The transaction guarantees an audit or GRANT failure cannot leave a partial
 * privilege split. */
export async function convergeDatabasePrivileges(
	db: Kysely<unknown>,
	config: DatabasePrivilegeRoleConfig,
): Promise<void> {
	await db
		.transaction()
		.execute((tx) => convergePrivilegesInTransaction(tx, config));
}
