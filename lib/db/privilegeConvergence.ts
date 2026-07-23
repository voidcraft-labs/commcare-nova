import { type Kysely, sql, type Transaction } from "kysely";
import { AUTH_TABLE_NAMES } from "@/lib/auth-schema-shared";
import { CASE_RUNTIME_SCHEMA } from "@/lib/case-store/postgres/connection";

export const DATABASE_PRIVILEGE_ROLE_ENV_KEYS = [
	"NOVA_MIGRATION_DB_USER",
	"NOVA_RUNTIME_DB_USER",
] as const;

export interface DatabasePrivilegeRoleConfig {
	readonly migrationRole: string;
	readonly runtimeRole: string;
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

/** Production must name both SQL login roles. Local migration explicitly
 * opts out through `NOVA_DB_LOCAL_URL`; an absent production contract never
 * silently preserves the historical owner-everything runtime identity. */
export function readDatabasePrivilegeRoleConfig(
	env: Readonly<Partial<Record<string, string>>> = process.env,
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

	const [migrationRole, runtimeRole] = values as [string, string];
	const roles = [migrationRole, runtimeRole];
	if (
		new Set(roles).size !== roles.length ||
		roles.some((role) => role.toUpperCase() === "PUBLIC")
	) {
		throw new DatabasePrivilegeConvergenceError(
			"role_config_invalid",
			"Migration and runtime database roles must be distinct and cannot be PUBLIC.",
		);
	}
	return { migrationRole, runtimeRole };
}

export type PublicTableClass = "application" | "control" | "migration";

const APPLICATION_TABLES = [
	"case_indices",
	"case_type_schemas",
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

/** `cases` alone lives in the isolated runtime-DDL schema. PostgreSQL requires
 * table ownership plus CREATE on the containing schema for CREATE INDEX; the
 * separate schema prevents that grant from covering migration-owned objects. */
export const RUNTIME_CASE_TABLES = ["cases"] as const;

const CONTROL_TABLES = [
	"lookup_reference_compatibility",
	"runtime_reader_traffic_epochs",
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
	...RUNTIME_CASE_TABLES.map((name) => [name, "application"] as const),
	...CONTROL_TABLES.map((name) => [name, "control"] as const),
	...MIGRATION_TABLES.map((name) => [name, "migration"] as const),
	...OPTIONAL_MIGRATION_TABLES.map((name) => [name, "migration"] as const),
]);

export const REQUIRED_PUBLIC_TABLES = [
	...APPLICATION_TABLES,
	...CONTROL_TABLES,
	...MIGRATION_TABLES,
] as const;

const ALLOWED_PUBLIC_TABLES = new Set<string>([
	...REQUIRED_PUBLIC_TABLES,
	...OPTIONAL_MIGRATION_TABLES,
]);

export function auditRuntimeCaseTableInventory(
	tableNames: readonly string[],
): readonly PublicTableAudit[] {
	const actual = [...new Set(tableNames)].sort();
	const expected = [...RUNTIME_CASE_TABLES];
	if (
		actual.length !== expected.length ||
		actual.some((name, index) => name !== expected[index])
	) {
		throw new DatabasePrivilegeConvergenceError(
			"schema_inventory_drift",
			`${CASE_RUNTIME_SCHEMA} must contain exactly ${expected.join(", ")}; found ${actual.join(", ") || "(none)"}.`,
		);
	}
	return actual.map((name) => ({
		name,
		classification: classifyPublicTable(name) as PublicTableClass,
	}));
}

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
		.filter((name) => !ALLOWED_PUBLIC_TABLES.has(name))
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
	readonly migrationIsRuntimeMember: boolean;
	readonly migrationCanSetRuntime: boolean;
	readonly runtimeCanUseMigration: boolean;
	readonly runtimeCanCreateDatabase: boolean;
	readonly runtimeCanCreatePublicSchema: boolean;
	readonly unexpectedMigrationParentRoles: readonly string[];
	readonly unexpectedRuntimeParentRoles: readonly string[];
}

/** The migration identity is the only privileged path. Its runtime membership
 * is required to maintain runtime-owned `cases`; runtime cannot inherit the
 * migration role. */
export function assertDatabaseRolePolicy(
	config: DatabasePrivilegeRoleConfig,
	roleFacts: readonly DatabaseRoleFact[],
	membership: DatabaseRoleMembershipFacts,
): void {
	const byName = new Map(roleFacts.map((role) => [role.name, role]));
	const missing = [config.migrationRole, config.runtimeRole].filter(
		(name) => !byName.has(name),
	);
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
	if (
		!membership.migrationCanUseRuntime ||
		!membership.migrationIsRuntimeMember ||
		!membership.migrationCanSetRuntime
	) {
		throw new DatabasePrivilegeConvergenceError(
			"role_policy_invalid",
			"The migration role must have MEMBER, SET, and inherited access to the runtime role while `cases` remains runtime-owned.",
		);
	}
	if (membership.runtimeCanUseMigration) {
		throw new DatabasePrivilegeConvergenceError(
			"role_policy_invalid",
			"The runtime role must not inherit migration privileges.",
		);
	}
	const unexpectedParents = [
		...membership.unexpectedMigrationParentRoles.map(
			(role) => `migration -> ${role}`,
		),
		...membership.unexpectedRuntimeParentRoles.map(
			(role) => `runtime -> ${role}`,
		),
	];
	if (unexpectedParents.length > 0) {
		throw new DatabasePrivilegeConvergenceError(
			"role_policy_invalid",
			`Nova database roles inherit unexpected direct parent roles: ${unexpectedParents.join(", ")}.`,
		);
	}
	if (
		membership.runtimeCanCreateDatabase ||
		membership.runtimeCanCreatePublicSchema
	) {
		throw new DatabasePrivilegeConvergenceError(
			"role_policy_invalid",
			"The runtime role has effective CREATE on the database or public schema.",
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

interface PublicRelationRow {
	readonly name: string;
	readonly extension_owned: boolean;
}

interface PublicRoutineRow extends PublicRelationRow {
	readonly identity_arguments: string;
}

interface RuntimeSchemaObjectRow {
	readonly object_type: string;
	readonly object_identity: string;
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
	const roleNames = [config.migrationRole, config.runtimeRole];
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
		WITH direct_parents AS (
			SELECT member.rolname AS member_name,
				parent.rolname AS parent_name
			FROM pg_catalog.pg_auth_members AS membership
			JOIN pg_catalog.pg_roles AS member
				ON member.oid = membership.member
			JOIN pg_catalog.pg_roles AS parent
				ON parent.oid = membership.roleid
			WHERE member.rolname IN (
				${config.migrationRole}, ${config.runtimeRole}
			)
		)
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
				${config.migrationRole},
				${config.runtimeRole},
				'MEMBER'
			) AS "migrationIsRuntimeMember",
			pg_catalog.pg_has_role(
				${config.migrationRole},
				${config.runtimeRole},
				'SET'
			) AS "migrationCanSetRuntime",
			pg_catalog.pg_has_role(
				${config.runtimeRole},
				${config.migrationRole},
				'USAGE'
			) AS "runtimeCanUseMigration",
			pg_catalog.has_database_privilege(
				${config.runtimeRole},
				pg_catalog.current_database(),
				'CREATE'
			) AS "runtimeCanCreateDatabase",
			pg_catalog.has_schema_privilege(
				${config.runtimeRole},
				'public',
				'CREATE'
			) AS "runtimeCanCreatePublicSchema",
			ARRAY(
				SELECT parent_name::text
				FROM direct_parents
				WHERE member_name = ${config.migrationRole}
					AND parent_name NOT IN (
						${config.runtimeRole}, 'cloudsqliamserviceaccount'
					)
				ORDER BY parent_name
			) AS "unexpectedMigrationParentRoles",
			ARRAY(
				SELECT parent_name::text
				FROM direct_parents
				WHERE member_name = ${config.runtimeRole}
					AND parent_name <> 'cloudsqliamserviceaccount'
				ORDER BY parent_name
			) AS "unexpectedRuntimeParentRoles"
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

async function readSchemaTables(
	tx: Transaction<unknown>,
	schema: string,
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
		WHERE namespace.nspname = ${schema}
			AND class.relkind IN ('r', 'p')
		ORDER BY class.relname
	`.execute(tx);
	return result.rows;
}

/** Establish the one schema where runtime DDL is permitted, then move the
 * existing case table exactly once. The exact inventory audit prevents the
 * isolated schema from silently becoming a second application namespace. */
async function convergeRuntimeCaseSchema(
	tx: Transaction<unknown>,
	config: DatabasePrivilegeRoleConfig,
): Promise<readonly PublicTableAudit[]> {
	await sql`
		CREATE SCHEMA IF NOT EXISTS ${sql.id(CASE_RUNTIME_SCHEMA)}
		AUTHORIZATION ${sql.id(config.migrationRole)}
	`.execute(tx);
	await sql`
		ALTER SCHEMA ${sql.id(CASE_RUNTIME_SCHEMA)}
		OWNER TO ${sql.id(config.migrationRole)}
	`.execute(tx);
	await sql`
		REVOKE ALL PRIVILEGES ON SCHEMA ${sql.id(CASE_RUNTIME_SCHEMA)}
		FROM PUBLIC, ${sql.id(config.runtimeRole)}
	`.execute(tx);
	await sql`
		GRANT USAGE, CREATE ON SCHEMA ${sql.id(CASE_RUNTIME_SCHEMA)}
		TO ${sql.id(config.migrationRole)}, ${sql.id(config.runtimeRole)}
	`.execute(tx);

	const locations = await sql<{
		in_public: boolean;
		in_runtime_schema: boolean;
	}>`
		SELECT
			pg_catalog.to_regclass('public.cases') IS NOT NULL AS in_public,
			pg_catalog.to_regclass(
				${`${CASE_RUNTIME_SCHEMA}.cases`}
			) IS NOT NULL AS in_runtime_schema
	`.execute(tx);
	const location = locations.rows[0];
	if (!location) throw new Error("Case table location query returned no row.");
	if (location.in_public === location.in_runtime_schema) {
		throw new DatabasePrivilegeConvergenceError(
			"schema_inventory_drift",
			"Exactly one managed cases table must exist before privilege convergence.",
		);
	}
	if (location.in_public) {
		await sql`
			ALTER TABLE public.cases SET SCHEMA ${sql.id(CASE_RUNTIME_SCHEMA)}
		`.execute(tx);
	}

	const tables = (await readSchemaTables(tx, CASE_RUNTIME_SCHEMA)).filter(
		(table) => !table.extension_owned,
	);
	const tableAudit = auditRuntimeCaseTableInventory(
		tables.map((table) => table.name),
	);
	const unexpectedObjects = await readUnexpectedRuntimeSchemaObjects(tx);
	if (unexpectedObjects.length > 0) {
		throw new DatabasePrivilegeConvergenceError(
			"schema_inventory_drift",
			`${CASE_RUNTIME_SCHEMA} contains unexpected objects: ${unexpectedObjects.map((object) => `${object.object_type} ${object.object_identity}`).join(", ")}.`,
		);
	}
	return tableAudit;
}

/** `CREATE` cannot be limited to indexes in PostgreSQL. Audit the schema's
 * generic dependency inventory so views, sequences, routines, types, and
 * every other persistent schema object fail closed. The only admitted objects
 * are `cases`, its indexes and constraints, and the row/array types PostgreSQL
 * creates for the table itself. */
async function readUnexpectedRuntimeSchemaObjects(
	tx: Transaction<unknown>,
): Promise<readonly RuntimeSchemaObjectRow[]> {
	const result = await sql<RuntimeSchemaObjectRow>`
		WITH target_schema AS (
			SELECT oid
			FROM pg_catalog.pg_namespace
			WHERE nspname = ${CASE_RUNTIME_SCHEMA}
		),
		case_relation AS (
			SELECT class.oid, class.reltype
			FROM pg_catalog.pg_class AS class
			JOIN target_schema AS schema
				ON schema.oid = class.relnamespace
			WHERE class.relname = 'cases'
				AND class.relkind IN ('r', 'p')
		),
		case_row_type AS (
			SELECT row_type.oid, row_type.typarray
			FROM pg_catalog.pg_type AS row_type
			JOIN case_relation AS cases ON cases.reltype = row_type.oid
		),
		allowed_object (classid, objid, objsubid) AS (
			SELECT 'pg_catalog.pg_class'::regclass::oid, cases.oid, 0
			FROM case_relation AS cases
			UNION ALL
			SELECT 'pg_catalog.pg_class'::regclass::oid, index_row.indexrelid, 0
			FROM pg_catalog.pg_index AS index_row
			JOIN case_relation AS cases ON cases.oid = index_row.indrelid
			UNION ALL
			SELECT 'pg_catalog.pg_type'::regclass::oid, row_type.oid, 0
			FROM case_row_type AS row_type
			UNION ALL
			SELECT 'pg_catalog.pg_type'::regclass::oid, row_type.typarray, 0
			FROM case_row_type AS row_type
			WHERE row_type.typarray <> 0
			UNION ALL
			SELECT 'pg_catalog.pg_constraint'::regclass::oid,
				table_constraint.oid,
				0
			FROM pg_catalog.pg_constraint AS table_constraint
			JOIN case_relation AS cases
				ON cases.oid = table_constraint.conrelid
		),
		schema_object AS (
			SELECT DISTINCT dependency.classid, dependency.objid,
				dependency.objsubid
			FROM pg_catalog.pg_depend AS dependency
			JOIN target_schema AS schema
				ON dependency.refclassid = 'pg_catalog.pg_namespace'::regclass
				AND dependency.refobjid = schema.oid
		)
		SELECT identified.type AS object_type,
			identified.identity AS object_identity
		FROM schema_object AS catalog_object
		CROSS JOIN LATERAL pg_catalog.pg_identify_object(
			catalog_object.classid,
			catalog_object.objid,
			catalog_object.objsubid
		) AS identified
		LEFT JOIN allowed_object AS allowed
			ON allowed.classid = catalog_object.classid
			AND allowed.objid = catalog_object.objid
			AND allowed.objsubid = catalog_object.objsubid
		WHERE allowed.objid IS NULL
		ORDER BY object_type, object_identity
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
		FROM PUBLIC, ${sql.id(config.runtimeRole)}
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
	const database = await sql<{ name: string }>`
		SELECT pg_catalog.current_database() AS name
	`.execute(tx);
	const databaseName = database.rows[0]?.name;
	if (!databaseName) throw new Error("Current database query returned no row.");

	await sql`
		REVOKE CREATE ON DATABASE ${sql.id(databaseName)}
		FROM PUBLIC, ${sql.id(config.runtimeRole)}
	`.execute(tx);
	await sql`
		GRANT CREATE ON DATABASE ${sql.id(databaseName)}
		TO ${sql.id(config.migrationRole)}
	`.execute(tx);

	const runtimeCaseAudit = await convergeRuntimeCaseSchema(tx, config);
	const tables = (await readSchemaTables(tx, "public")).filter(
		(table) => !table.extension_owned,
	);
	const tableAudit = auditPublicTableInventory(
		tables.map((table) => table.name),
	);
	const routines = await readPublicRoutines(tx);
	const sequences = await readPublicSequences(tx);
	auditPublicRoutines(routines);
	auditPublicSequences(sequences);

	await sql`
		REVOKE ALL PRIVILEGES ON SCHEMA public
		FROM PUBLIC, ${sql.id(config.runtimeRole)}
	`.execute(tx);
	await sql`
		GRANT USAGE, CREATE ON SCHEMA public TO ${sql.id(config.migrationRole)}
	`.execute(tx);
	// Fixed tables stay in public, where the serving identity has no CREATE.
	await sql`
		GRANT USAGE ON SCHEMA public TO ${sql.id(config.runtimeRole)}
	`.execute(tx);

	for (const table of tableAudit) {
		await alterTableOwner(tx, table.name, config.migrationRole);
		await revokeTableAccess(tx, table.name, config);
		if (table.classification === "application") {
			await grantRuntimeDml(tx, table.name, config.runtimeRole);
		}
	}
	for (const table of runtimeCaseAudit) {
		await sql`
			ALTER TABLE ${sql.id(CASE_RUNTIME_SCHEMA)}.${sql.id(table.name)}
			OWNER TO ${sql.id(config.runtimeRole)}
		`.execute(tx);
		await sql`
			REVOKE ALL PRIVILEGES
			ON TABLE ${sql.id(CASE_RUNTIME_SCHEMA)}.${sql.id(table.name)}
			FROM PUBLIC
		`.execute(tx);
	}

	for (const sequence of sequences.filter((row) => !row.extension_owned)) {
		const parent = sequence.owned_by;
		if (parent === null)
			throw new Error("Audited sequence lost its owner table.");
		await sql`
			ALTER SEQUENCE public.${sql.id(sequence.name)}
			OWNER TO ${sql.id(config.migrationRole)}
		`.execute(tx);
		await sql`
			REVOKE ALL PRIVILEGES ON SEQUENCE public.${sql.id(sequence.name)}
			FROM PUBLIC, ${sql.id(config.runtimeRole)}
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
			FROM PUBLIC, ${sql.id(config.runtimeRole)}
		`.execute(tx);
	}
	for (const routine of RUNTIME_ROUTINES) {
		await sql`
			GRANT EXECUTE ON FUNCTION public.${sql.id(routine)}()
			TO ${sql.id(config.runtimeRole)}
		`.execute(tx);
	}
	await sql`
		GRANT SELECT ON TABLE public.lookup_reference_compatibility,
			public.runtime_reader_traffic_epochs
		TO ${sql.id(config.runtimeRole)}
	`.execute(tx);

	for (const objectType of ["TABLES", "SEQUENCES"] as const) {
		await sql`
			ALTER DEFAULT PRIVILEGES FOR ROLE ${sql.id(config.migrationRole)}
			IN SCHEMA public REVOKE ALL PRIVILEGES ON ${sql.raw(objectType)}
			FROM PUBLIC, ${sql.id(config.runtimeRole)}
		`.execute(tx);
	}
	await sql`
		ALTER DEFAULT PRIVILEGES FOR ROLE ${sql.id(config.migrationRole)}
		IN SCHEMA public REVOKE ALL PRIVILEGES ON FUNCTIONS
		FROM PUBLIC, ${sql.id(config.runtimeRole)}
	`.execute(tx);
	for (const objectType of ["TABLES", "SEQUENCES", "FUNCTIONS"] as const) {
		await sql`
			ALTER DEFAULT PRIVILEGES FOR ROLE ${sql.id(config.runtimeRole)}
			IN SCHEMA ${sql.id(CASE_RUNTIME_SCHEMA)}
			REVOKE ALL PRIVILEGES ON ${sql.raw(objectType)} FROM PUBLIC
		`.execute(tx);
	}
	// Re-read effective privileges after every grant. This assertion stays
	// inside the transaction, so privilege drift cannot partially commit.
	await readAndAssertRolePolicy(tx, config);
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
