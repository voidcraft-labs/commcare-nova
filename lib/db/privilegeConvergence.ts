import { type Kysely, sql, type Transaction } from "kysely";
import { AUTH_TABLE_NAMES } from "@/lib/auth-schema-shared";
import {
	AUDIT_DB_ROLE_CONNECTION_LIMIT,
	CAPTURE_CLEANUP_DB_ROLE_CONNECTION_LIMIT,
	CASE_RUNTIME_SCHEMA,
	MIGRATION_DB_ROLE_CONNECTION_LIMIT,
	RUNTIME_DB_ROLE_CONNECTION_LIMIT,
} from "@/lib/case-store/postgres/connection";

export const DATABASE_PRIVILEGE_ROLE_ENV_KEYS = [
	"NOVA_MIGRATION_DB_USER",
	"NOVA_RUNTIME_DB_USER",
	"NOVA_CAPTURE_CLEANUP_DB_USER",
	"NOVA_AUDIT_DB_USER",
] as const;

export interface DatabasePrivilegeRoleConfig {
	readonly migrationRole: string;
	readonly runtimeRole: string;
	readonly cleanupRole: string;
	readonly auditRole: string;
}

export class DatabasePrivilegeConvergenceError extends Error {
	readonly code:
		| "role_config_missing"
		| "role_config_partial"
		| "role_config_invalid"
		| "role_policy_invalid"
		| "runtime_sessions_remain"
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

	const [migrationRole, runtimeRole, cleanupRole, auditRole] = values as [
		string,
		string,
		string,
		string,
	];
	const roles = [migrationRole, runtimeRole, cleanupRole, auditRole];
	if (
		new Set(roles).size !== roles.length ||
		roles.some((role) => role.toUpperCase() === "PUBLIC")
	) {
		throw new DatabasePrivilegeConvergenceError(
			"role_config_invalid",
			"Migration, runtime, capture-cleanup, and audit database roles must be distinct and cannot be PUBLIC.",
		);
	}
	return { migrationRole, runtimeRole, cleanupRole, auditRole };
}

export type PublicTableClass = "application" | "control" | "migration";

/**
 * The serving role's exact capability on a fixed public table. PostgreSQL
 * requires `UPDATE` privilege for every table named by `SELECT ... FOR
 * UPDATE/SHARE`, so only `read-write` tables are row-lockable at runtime.
 * Keep each table in exactly one capability list below: inventory, grants,
 * sequence access, and the row-lock source guard all derive from this policy.
 */
export type RuntimeTableCapability =
	| "read-write"
	| "append-only"
	| "insert-delete"
	| "read-only"
	| "none";

export interface PublicTablePolicy {
	readonly name: string;
	readonly classification: PublicTableClass;
	readonly runtimeCapability: RuntimeTableCapability;
}

const RUNTIME_READ_WRITE_TABLES = [
	"case_indices",
	"case_type_schemas",
	"parked_case_values",
	"apps",
	"blueprint_entities",
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
	"media_upload_aliases",
	"form_attachments",
	"form_attachment_rate_limits",
	"form_submission_intents",
	"lookup_project_state",
	"lookup_tables",
	"lookup_columns",
	"lookup_rows",
	"lookup_table_references",
	"lookup_column_references",
	"app_organization_state",
	"app_locations",
	"app_deployments",
	"app_deployment_resources",
	"design_change_sets",
	"design_sessions",
	"design_slice_attempts",
	"design_external_action_receipts",
	"design_artifact_workspaces",
	"design_model_contexts",
	...Object.values(AUTH_TABLE_NAMES),
	"auth_oauth_grant_revocation",
] as const;

/** The change-set runtime's durable staging ledgers are append-only: the
 * mutable authority row (`design_change_sets`) serializes them, so no code
 * may row-lock or update a request, step, stage, handle, or receipt row —
 * retention is a future, separately-owned service path. */
const RUNTIME_APPEND_ONLY_TABLES = [
	"app_changes",
	"design_change_set_requests",
	"design_change_set_steps",
	"design_change_set_step_stages",
	"design_change_set_handles",
	"design_committed_slices",
	"design_source_packages",
	"design_revisions",
	"design_reviews",
	"design_review_dispositions",
	"design_build_plans",
	"design_orchestration_events",
	"design_artifact_workspace_steps",
	"design_model_context_items",
	"design_model_steps",
	"design_model_step_usage_accounts",
	"design_identity_handles",
	"design_slice_attempt_budget_claims",
] as const;

/** Runtime owns each tombstone/reference-edge lifecycle but never mutates a
 * row in place: writers insert, reconcilers delete, and every other path reads. */
const RUNTIME_INSERT_DELETE_TABLES = [
	"case_schema_index_deletions",
	"media_asset_refs",
	"app_location_references",
	"thread_media_refs",
] as const;

const RUNTIME_READ_ONLY_TABLES = ["app_change_fold_baselines"] as const;

/** `cases` alone lives in the isolated runtime-DDL schema. PostgreSQL requires
 * table ownership plus CREATE on the containing schema for CREATE INDEX; the
 * separate schema prevents that grant from covering migration-owned objects. */
export const RUNTIME_CASE_TABLES = ["cases"] as const;

/**
 * Exact public-table read surface required by the immutable canonical-identity
 * scanner. This is deliberately narrower than the application inventory:
 * adding a scanner query requires an explicit privilege review here.
 */
export const AUDIT_SELECT_PUBLIC_TABLES = [
	"app_changes",
	"apps",
	"auth_account",
	"auth_apikey",
	"auth_invitation",
	"auth_member",
	"auth_organization",
	"auth_session",
	"auth_user",
	"blueprint_entities",
	"case_type_schemas",
	"chat_stream_chunks",
	"events",
	"form_attachments",
	"form_submission_intents",
	"lookup_column_references",
	"lookup_columns",
	"lookup_project_state",
	"lookup_rows",
	"lookup_table_references",
	"lookup_tables",
	"media_asset_refs",
	"media_assets",
	"media_upload_aliases",
	"app_change_fold_baselines",
	"parked_case_values",
	"presence",
	"run_summaries",
	"threads",
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

const REQUIRED_PUBLIC_TABLE_POLICIES: readonly PublicTablePolicy[] = [
	...RUNTIME_READ_WRITE_TABLES.map((name) => ({
		name,
		classification: "application" as const,
		runtimeCapability: "read-write" as const,
	})),
	...RUNTIME_APPEND_ONLY_TABLES.map((name) => ({
		name,
		classification: "application" as const,
		runtimeCapability: "append-only" as const,
	})),
	...RUNTIME_INSERT_DELETE_TABLES.map((name) => ({
		name,
		classification: "application" as const,
		runtimeCapability: "insert-delete" as const,
	})),
	...RUNTIME_READ_ONLY_TABLES.map((name) => ({
		name,
		classification: "control" as const,
		runtimeCapability: "read-only" as const,
	})),
	...MIGRATION_TABLES.map((name) => ({
		name,
		classification: "migration" as const,
		runtimeCapability: "none" as const,
	})),
];

const OPTIONAL_PUBLIC_TABLE_POLICIES: readonly PublicTablePolicy[] =
	OPTIONAL_MIGRATION_TABLES.map((name) => ({
		name,
		classification: "migration" as const,
		runtimeCapability: "none" as const,
	}));

export const PUBLIC_TABLE_POLICIES: readonly PublicTablePolicy[] = [
	...REQUIRED_PUBLIC_TABLE_POLICIES,
	...OPTIONAL_PUBLIC_TABLE_POLICIES,
];

const TABLE_POLICIES = new Map(
	PUBLIC_TABLE_POLICIES.map((policy) => [policy.name, policy] as const),
);

const TABLE_CLASSES = new Map<string, PublicTableClass>([
	...PUBLIC_TABLE_POLICIES.map(
		(policy) => [policy.name, policy.classification] as const,
	),
	...RUNTIME_CASE_TABLES.map((name) => [name, "application"] as const),
]);

export const REQUIRED_PUBLIC_TABLES = REQUIRED_PUBLIC_TABLE_POLICIES.map(
	(policy) => policy.name,
);

/** Runtime-visible public tables where PostgreSQL row-lock clauses are
 * structurally forbidden because the serving role intentionally lacks UPDATE. */
export const RUNTIME_TABLES_WITHOUT_UPDATE = PUBLIC_TABLE_POLICIES.filter(
	(policy) =>
		policy.runtimeCapability !== "none" &&
		policy.runtimeCapability !== "read-write",
).map((policy) => policy.name);

const ALLOWED_PUBLIC_TABLES = new Set<string>([
	...PUBLIC_TABLE_POLICIES.map((policy) => policy.name),
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

export function runtimeTableCapability(
	name: string,
): RuntimeTableCapability | null {
	return TABLE_POLICIES.get(name)?.runtimeCapability ?? null;
}

export function runtimeTableCanUseRowLocks(name: string): boolean {
	return runtimeTableCapability(name) === "read-write";
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
		// Two different causes with two different fixes, so each arm says its
		// own. The previous message reported both counts on every failure and
		// explained neither, which reads as "your migration is wrong" — the
		// thing the reader just changed, and usually the one thing that is
		// fine. This runs in the migrate Cloud Run Job on every deploy and a
		// non-zero exit blocks the deploy, so whoever hits it is already
		// under pressure.
		const parts = [
			"Checked the tables in the `public` schema against the privilege inventory in `lib/db/privilegeConvergence.ts`, and they disagree. Every table has to be listed there so convergence knows which role owns it.",
		];
		if (unknown.length > 0) {
			parts.push(
				`The database has ${unknown.length === 1 ? "a table" : "tables"} the inventory doesn't list: ${unknown.join(", ")}. If you just added ${unknown.length === 1 ? "it" : "them"} in a migration, register each table exactly once in the matching runtime-capability list in that file. Choose from read-write, append-only, insert-delete, read-only, or migration-only based on the real serving statements. \`PUBLIC_TABLE_POLICIES\`, inventory, grants, sequence access, and the row-lock source guard all derive from that choice. PostgreSQL row-lock clauses require UPDATE, so only read-write tables may use \`FOR UPDATE\` or \`FOR SHARE\`.`,
			);
		}
		if (missing.length > 0) {
			parts.push(
				`The inventory lists ${missing.length === 1 ? "a table" : "tables"} the database doesn't have: ${missing.join(", ")}. Either the migration that creates ${missing.length === 1 ? "it" : "them"} hasn't run against this database, or it was removed without removing the name from the inventory.`,
			);
		}
		throw new DatabasePrivilegeConvergenceError(
			"schema_inventory_drift",
			parts.join("\n\n"),
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
	readonly canLogin: boolean;
	readonly connectionLimit: number;
}

export interface DatabaseRoleMembershipFacts {
	readonly currentCanUseMigration: boolean;
	readonly migrationCanUseRuntime: boolean;
	readonly migrationIsRuntimeMember: boolean;
	readonly migrationCanSetRuntime: boolean;
	readonly runtimeCanUseMigration: boolean;
	readonly cleanupCanUseRuntime: boolean;
	readonly auditCanUseRuntime: boolean;
	readonly runtimeCanCreateDatabase: boolean;
	readonly runtimeCanCreatePublicSchema: boolean;
	readonly cleanupCanCreateDatabase: boolean;
	readonly cleanupCanCreatePublicSchema: boolean;
	readonly auditCanCreateDatabase: boolean;
	readonly auditCanCreatePublicSchema: boolean;
	readonly unexpectedMigrationParentRoles: readonly string[];
	readonly unexpectedRuntimeParentRoles: readonly string[];
	readonly unexpectedCleanupParentRoles: readonly string[];
	readonly unexpectedAuditParentRoles: readonly string[];
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
	const missing = [
		config.migrationRole,
		config.runtimeRole,
		config.cleanupRole,
		config.auditRole,
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
	const expectedConnectionLimits = new Map([
		[config.migrationRole, MIGRATION_DB_ROLE_CONNECTION_LIMIT],
		[config.runtimeRole, RUNTIME_DB_ROLE_CONNECTION_LIMIT],
		[config.cleanupRole, CAPTURE_CLEANUP_DB_ROLE_CONNECTION_LIMIT],
		[config.auditRole, AUDIT_DB_ROLE_CONNECTION_LIMIT],
	]);
	const malformedLogins = [...byName.values()].filter(
		(role) =>
			!role.canLogin ||
			role.connectionLimit !== expectedConnectionLimits.get(role.name),
	);
	if (malformedLogins.length > 0) {
		throw new DatabasePrivilegeConvergenceError(
			"role_policy_invalid",
			`Nova database roles must be direct LOGIN roles with exact connection limits: ${malformedLogins.map((role) => `${role.name}=${role.connectionLimit}`).join(", ")}.`,
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
	if (membership.cleanupCanUseRuntime) {
		throw new DatabasePrivilegeConvergenceError(
			"role_policy_invalid",
			"The capture-cleanup role must not inherit runtime privileges.",
		);
	}
	if (membership.auditCanUseRuntime) {
		throw new DatabasePrivilegeConvergenceError(
			"role_policy_invalid",
			"The audit role must not inherit runtime privileges.",
		);
	}
	const unexpectedParents = [
		...membership.unexpectedMigrationParentRoles.map(
			(role) => `migration -> ${role}`,
		),
		...membership.unexpectedRuntimeParentRoles.map(
			(role) => `runtime -> ${role}`,
		),
		...membership.unexpectedCleanupParentRoles.map(
			(role) => `capture-cleanup -> ${role}`,
		),
		...membership.unexpectedAuditParentRoles.map((role) => `audit -> ${role}`),
	];
	if (unexpectedParents.length > 0) {
		throw new DatabasePrivilegeConvergenceError(
			"role_policy_invalid",
			`Nova database roles inherit unexpected direct parent roles: ${unexpectedParents.join(", ")}.`,
		);
	}
	if (
		membership.runtimeCanCreateDatabase ||
		membership.runtimeCanCreatePublicSchema ||
		membership.cleanupCanCreateDatabase ||
		membership.cleanupCanCreatePublicSchema ||
		membership.auditCanCreateDatabase ||
		membership.auditCanCreatePublicSchema
	) {
		throw new DatabasePrivilegeConvergenceError(
			"role_policy_invalid",
			"The runtime, capture-cleanup, or audit role has effective CREATE on the database or public schema.",
		);
	}
}

interface PublicRoutineIdentity {
	readonly name: string;
	readonly identityArguments: string;
}

const EXPECTED_PUBLIC_ROUTINES = [
	{
		name: "nova_admit_app_change_fold_baseline_insert",
		identityArguments: "",
	},
	{
		name: "nova_admit_app_change_insert",
		identityArguments: "",
	},
	{
		name: "nova_app_change_fold_snapshot_digest",
		identityArguments: "jsonb",
	},
	{
		name: "nova_current_app_change_fold_snapshot",
		identityArguments: "text",
	},
	{
		name: "nova_insert_app_change_genesis_fold_baseline",
		identityArguments: "text",
	},
	{
		name: "nova_reject_app_change_fold_baseline_change",
		identityArguments: "",
	},
	{
		name: "nova_require_app_change_fold_baseline",
		identityArguments: "",
	},
	{
		name: "nova_require_app_change_project_move_final",
		identityArguments: "",
	},
	{
		name: "nova_require_app_project_move_change",
		identityArguments: "",
	},
	{
		name: "nova_lock_auth_member_membership_gate",
		identityArguments: "",
	},
	{
		name: "nova_reject_auth_member_truncate",
		identityArguments: "",
	},
] as const;

const RUNTIME_ROUTINES = [
	{
		name: "nova_insert_app_change_genesis_fold_baseline",
		identityArguments: "text",
	},
	{
		name: "nova_lock_auth_member_membership_gate",
		identityArguments: "",
	},
	{
		name: "nova_reject_auth_member_truncate",
		identityArguments: "",
	},
] as const satisfies readonly PublicRoutineIdentity[];

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
	readonly can_login: boolean;
	readonly connection_limit: number;
}

interface CleanupPrivilegeRow {
	readonly public_schema_usage: boolean;
	readonly runtime_schema_usage: boolean;
	readonly can_select_attachments: boolean;
	readonly can_update_attachments: boolean;
	readonly can_delete_attachments: boolean;
	readonly can_insert_attachments: boolean;
	readonly can_administer_attachments: boolean;
	readonly other_table_privilege_count: number;
}

interface AuditPrivilegeRow {
	readonly can_connect: boolean;
	readonly public_schema_usage: boolean;
	readonly runtime_schema_usage: boolean;
	readonly can_create_database: boolean;
	readonly can_create_public_schema: boolean;
	readonly can_create_runtime_schema: boolean;
	readonly missing_select_count: number;
	readonly unexpected_table_privilege_count: number;
	readonly mutation_privilege_count: number;
	readonly sequence_privilege_count: number;
	readonly routine_execute_count: number;
}

async function assertCleanupPrivilegeBoundary(
	tx: Transaction<unknown>,
	config: DatabasePrivilegeRoleConfig,
): Promise<void> {
	const result = await sql<CleanupPrivilegeRow>`
		SELECT
			pg_catalog.has_schema_privilege(
				${config.cleanupRole}, 'public', 'USAGE'
			) AS public_schema_usage,
			pg_catalog.has_schema_privilege(
				${config.cleanupRole}, ${CASE_RUNTIME_SCHEMA}, 'USAGE'
			) AS runtime_schema_usage,
			pg_catalog.has_table_privilege(
				${config.cleanupRole}, 'public.form_attachments', 'SELECT'
			) AS can_select_attachments,
			pg_catalog.has_table_privilege(
				${config.cleanupRole}, 'public.form_attachments', 'UPDATE'
			) AS can_update_attachments,
			pg_catalog.has_table_privilege(
				${config.cleanupRole}, 'public.form_attachments', 'DELETE'
			) AS can_delete_attachments,
			pg_catalog.has_table_privilege(
				${config.cleanupRole}, 'public.form_attachments', 'INSERT'
			) AS can_insert_attachments,
			(
				pg_catalog.has_table_privilege(
					${config.cleanupRole}, 'public.form_attachments', 'TRUNCATE'
				)
				OR pg_catalog.has_table_privilege(
					${config.cleanupRole}, 'public.form_attachments', 'REFERENCES'
				)
				OR pg_catalog.has_table_privilege(
					${config.cleanupRole}, 'public.form_attachments', 'TRIGGER'
				)
			) AS can_administer_attachments,
			(
				SELECT count(*)::integer
				FROM pg_catalog.pg_class AS class
				JOIN pg_catalog.pg_namespace AS namespace
					ON namespace.oid = class.relnamespace
				WHERE class.relkind IN ('r', 'p')
					AND namespace.nspname IN ('public', ${CASE_RUNTIME_SCHEMA})
					AND NOT (
						namespace.nspname = 'public'
						AND class.relname = 'form_attachments'
					)
					AND NOT EXISTS (
						SELECT 1
						FROM pg_catalog.pg_depend AS dependency
						WHERE dependency.classid =
								'pg_catalog.pg_class'::regclass
							AND dependency.objid = class.oid
							AND dependency.refclassid =
								'pg_catalog.pg_extension'::regclass
							AND dependency.deptype = 'e'
					)
					AND (
						pg_catalog.has_table_privilege(
							${config.cleanupRole}, class.oid, 'SELECT'
						)
						OR pg_catalog.has_table_privilege(
							${config.cleanupRole}, class.oid, 'INSERT'
						)
						OR pg_catalog.has_table_privilege(
							${config.cleanupRole}, class.oid, 'UPDATE'
						)
						OR pg_catalog.has_table_privilege(
							${config.cleanupRole}, class.oid, 'DELETE'
						)
						OR pg_catalog.has_table_privilege(
							${config.cleanupRole}, class.oid, 'TRUNCATE'
						)
						OR pg_catalog.has_table_privilege(
							${config.cleanupRole}, class.oid, 'REFERENCES'
						)
						OR pg_catalog.has_table_privilege(
							${config.cleanupRole}, class.oid, 'TRIGGER'
						)
					)
			) AS other_table_privilege_count
	`.execute(tx);
	const row = result.rows[0];
	if (
		row === undefined ||
		!row.public_schema_usage ||
		row.runtime_schema_usage ||
		!row.can_select_attachments ||
		!row.can_update_attachments ||
		!row.can_delete_attachments ||
		row.can_insert_attachments ||
		row.can_administer_attachments ||
		row.other_table_privilege_count !== 0
	) {
		throw new DatabasePrivilegeConvergenceError(
			"role_policy_invalid",
			`Capture-cleanup database privileges are wider or narrower than public schema USAGE plus SELECT/UPDATE/DELETE on form_attachments: ${JSON.stringify(row)}.`,
		);
	}
}

async function assertAuditPrivilegeBoundary(
	tx: Transaction<unknown>,
	config: DatabasePrivilegeRoleConfig,
): Promise<void> {
	const expectedRelations = [
		...AUDIT_SELECT_PUBLIC_TABLES.map((table) => sql`('public', ${table})`),
		...RUNTIME_CASE_TABLES.map(
			(table) => sql`(${CASE_RUNTIME_SCHEMA}, ${table})`,
		),
	];
	const result = await sql<AuditPrivilegeRow>`
		WITH expected(schema_name, table_name) AS (
			VALUES ${sql.join(expectedRelations)}
		),
		managed_tables AS (
			SELECT namespace.nspname AS schema_name,
				class.relname AS table_name,
				class.oid
			FROM pg_catalog.pg_class AS class
			JOIN pg_catalog.pg_namespace AS namespace
				ON namespace.oid = class.relnamespace
			WHERE class.relkind IN ('r', 'p')
				AND namespace.nspname IN ('public', ${CASE_RUNTIME_SCHEMA})
				AND NOT EXISTS (
					SELECT 1
					FROM pg_catalog.pg_depend AS dependency
					WHERE dependency.classid = 'pg_catalog.pg_class'::regclass
						AND dependency.objid = class.oid
						AND dependency.refclassid =
							'pg_catalog.pg_extension'::regclass
						AND dependency.deptype = 'e'
				)
		)
		SELECT
			pg_catalog.has_database_privilege(
				${config.auditRole}, pg_catalog.current_database(), 'CONNECT'
			) AS can_connect,
			pg_catalog.has_schema_privilege(
				${config.auditRole}, 'public', 'USAGE'
			) AS public_schema_usage,
			pg_catalog.has_schema_privilege(
				${config.auditRole}, ${CASE_RUNTIME_SCHEMA}, 'USAGE'
			) AS runtime_schema_usage,
			pg_catalog.has_database_privilege(
				${config.auditRole}, pg_catalog.current_database(), 'CREATE'
			) AS can_create_database,
			pg_catalog.has_schema_privilege(
				${config.auditRole}, 'public', 'CREATE'
			) AS can_create_public_schema,
			pg_catalog.has_schema_privilege(
				${config.auditRole}, ${CASE_RUNTIME_SCHEMA}, 'CREATE'
			) AS can_create_runtime_schema,
			(
				SELECT count(*)::integer
				FROM expected
				WHERE NOT pg_catalog.has_table_privilege(
					${config.auditRole},
					pg_catalog.format('%I.%I', schema_name, table_name),
					'SELECT'
				)
			) AS missing_select_count,
			(
				SELECT count(*)::integer
				FROM managed_tables
				LEFT JOIN expected USING (schema_name, table_name)
				WHERE expected.table_name IS NULL
					AND pg_catalog.has_table_privilege(
						${config.auditRole}, managed_tables.oid, 'SELECT'
					)
			) AS unexpected_table_privilege_count,
			(
				SELECT count(*)::integer
				FROM managed_tables
				WHERE pg_catalog.has_table_privilege(
					${config.auditRole}, managed_tables.oid,
					'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
				)
			) AS mutation_privilege_count,
			(
				SELECT count(*)::integer
				FROM pg_catalog.pg_class AS sequence
				JOIN pg_catalog.pg_namespace AS namespace
					ON namespace.oid = sequence.relnamespace
				WHERE sequence.relkind = 'S'
					AND namespace.nspname IN ('public', ${CASE_RUNTIME_SCHEMA})
					AND CASE
						-- PostgreSQL may reorder independent WHERE predicates. Keep the
						-- object-kind check structurally around this throwing catalog
						-- function so extension-owned composite relations (for example,
						-- PostGIS geometry_dump) are never passed as sequences.
						WHEN sequence.relkind = 'S'
							THEN pg_catalog.has_sequence_privilege(
								${config.auditRole},
								sequence.oid,
								'USAGE,SELECT,UPDATE'
							)
						ELSE false
					END
			) AS sequence_privilege_count,
			(
				SELECT count(*)::integer
				FROM pg_catalog.pg_proc AS routine
				JOIN pg_catalog.pg_namespace AS namespace
					ON namespace.oid = routine.pronamespace
				WHERE namespace.nspname IN ('public', ${CASE_RUNTIME_SCHEMA})
					AND NOT EXISTS (
						SELECT 1
						FROM pg_catalog.pg_depend AS dependency
						WHERE dependency.classid =
								'pg_catalog.pg_proc'::regclass
							AND dependency.objid = routine.oid
							AND dependency.refclassid =
								'pg_catalog.pg_extension'::regclass
							AND dependency.deptype = 'e'
					)
					AND pg_catalog.has_function_privilege(
						${config.auditRole}, routine.oid, 'EXECUTE'
					)
			) AS routine_execute_count
	`.execute(tx);
	const row = result.rows[0];
	if (
		row === undefined ||
		!row.can_connect ||
		!row.public_schema_usage ||
		!row.runtime_schema_usage ||
		row.can_create_database ||
		row.can_create_public_schema ||
		row.can_create_runtime_schema ||
		row.missing_select_count !== 0 ||
		row.unexpected_table_privilege_count !== 0 ||
		row.mutation_privilege_count !== 0 ||
		row.sequence_privilege_count !== 0 ||
		row.routine_execute_count !== 0
	) {
		throw new DatabasePrivilegeConvergenceError(
			"role_policy_invalid",
			`Audit database privileges differ from the scanner's exact read-only relation set: ${JSON.stringify(row)}.`,
		);
	}
}

async function readAndAssertRolePolicy(
	tx: Transaction<unknown>,
	config: DatabasePrivilegeRoleConfig,
): Promise<void> {
	const roleNames = [
		config.migrationRole,
		config.runtimeRole,
		config.cleanupRole,
		config.auditRole,
	];
	const roles = await sql<RoleRow>`
		SELECT
			rolname AS name,
			rolsuper AS superuser,
			rolcreaterole AS create_role,
			rolcreatedb AS create_database,
			rolbypassrls AS bypass_rls,
			rolcanlogin AS can_login,
			rolconnlimit AS connection_limit
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
				${config.migrationRole}, ${config.runtimeRole},
				${config.cleanupRole}, ${config.auditRole}
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
			pg_catalog.pg_has_role(
				${config.cleanupRole},
				${config.runtimeRole},
				'USAGE'
			) AS "cleanupCanUseRuntime",
			pg_catalog.pg_has_role(
				${config.auditRole},
				${config.runtimeRole},
				'USAGE'
			) AS "auditCanUseRuntime",
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
			pg_catalog.has_database_privilege(
				${config.cleanupRole},
				pg_catalog.current_database(),
				'CREATE'
			) AS "cleanupCanCreateDatabase",
			pg_catalog.has_schema_privilege(
				${config.cleanupRole},
				'public',
				'CREATE'
			) AS "cleanupCanCreatePublicSchema",
			pg_catalog.has_database_privilege(
				${config.auditRole},
				pg_catalog.current_database(),
				'CREATE'
			) AS "auditCanCreateDatabase",
			pg_catalog.has_schema_privilege(
				${config.auditRole},
				'public',
				'CREATE'
			) AS "auditCanCreatePublicSchema",
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
			,
			ARRAY(
				SELECT parent_name::text
				FROM direct_parents
				WHERE member_name = ${config.cleanupRole}
					AND parent_name <> 'cloudsqliamserviceaccount'
				ORDER BY parent_name
			) AS "unexpectedCleanupParentRoles"
			,
			ARRAY(
				SELECT parent_name::text
				FROM direct_parents
				WHERE member_name = ${config.auditRole}
					AND parent_name <> 'cloudsqliamserviceaccount'
				ORDER BY parent_name
			) AS "unexpectedAuditParentRoles"
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
			canLogin: role.can_login,
			connectionLimit: role.connection_limit,
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
		FROM PUBLIC, ${sql.id(config.runtimeRole)}, ${sql.id(config.cleanupRole)},
			${sql.id(config.auditRole)}
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
	const expected = EXPECTED_PUBLIC_ROUTINES.map(
		(routine) => `${routine.name}(${routine.identityArguments})`,
	);
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
		FROM PUBLIC, ${sql.id(config.runtimeRole)}, ${sql.id(config.cleanupRole)},
			${sql.id(config.auditRole)}
	`.execute(tx);
}

async function grantRuntimeTableCapability(
	tx: Transaction<unknown>,
	table: string,
	capability: RuntimeTableCapability,
	runtimeRole: string,
): Promise<void> {
	switch (capability) {
		case "read-write":
			await sql`
				GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.${sql.id(table)}
				TO ${sql.id(runtimeRole)}
			`.execute(tx);
			return;
		case "append-only":
			await sql`
				GRANT SELECT, INSERT ON TABLE public.${sql.id(table)}
				TO ${sql.id(runtimeRole)}
			`.execute(tx);
			return;
		case "insert-delete":
			await sql`
				GRANT SELECT, INSERT, DELETE ON TABLE public.${sql.id(table)}
				TO ${sql.id(runtimeRole)}
			`.execute(tx);
			return;
		case "read-only":
			await sql`
				GRANT SELECT ON TABLE public.${sql.id(table)}
				TO ${sql.id(runtimeRole)}
			`.execute(tx);
			return;
		case "none":
			return;
	}
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
		REVOKE CONNECT ON DATABASE ${sql.id(databaseName)}
		FROM PUBLIC, ${sql.id(config.migrationRole)}, ${sql.id(config.runtimeRole)},
			${sql.id(config.cleanupRole)}, ${sql.id(config.auditRole)}
	`.execute(tx);
	await sql`
		GRANT CONNECT ON DATABASE ${sql.id(databaseName)}
		TO ${sql.id(config.migrationRole)}, ${sql.id(config.runtimeRole)},
			${sql.id(config.cleanupRole)}, ${sql.id(config.auditRole)}
	`.execute(tx);
	await sql`
			REVOKE CREATE ON DATABASE ${sql.id(databaseName)}
			FROM PUBLIC, ${sql.id(config.runtimeRole)}, ${sql.id(config.cleanupRole)},
				${sql.id(config.auditRole)}
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
			FROM PUBLIC, ${sql.id(config.runtimeRole)}, ${sql.id(config.cleanupRole)},
				${sql.id(config.auditRole)}
	`.execute(tx);
	await sql`
		GRANT USAGE, CREATE ON SCHEMA public TO ${sql.id(config.migrationRole)}
	`.execute(tx);
	// Fixed tables stay in public, where the serving identity has no CREATE.
	await sql`
			GRANT USAGE ON SCHEMA public TO ${sql.id(config.runtimeRole)}
		`.execute(tx);
	await sql`
		GRANT USAGE ON SCHEMA public TO ${sql.id(config.cleanupRole)}
	`.execute(tx);
	await sql`
		GRANT USAGE ON SCHEMA public TO ${sql.id(config.auditRole)}
	`.execute(tx);
	await sql`
		GRANT USAGE ON SCHEMA ${sql.id(CASE_RUNTIME_SCHEMA)}
		TO ${sql.id(config.auditRole)}
	`.execute(tx);

	for (const table of tableAudit) {
		await alterTableOwner(tx, table.name, config.migrationRole);
		await revokeTableAccess(tx, table.name, config);
		const capability = runtimeTableCapability(table.name);
		if (capability === null)
			throw new Error(`Audited table ${table.name} lost its runtime policy.`);
		await grantRuntimeTableCapability(
			tx,
			table.name,
			capability,
			config.runtimeRole,
		);
	}
	for (const table of runtimeCaseAudit) {
		await sql`
			ALTER TABLE ${sql.id(CASE_RUNTIME_SCHEMA)}.${sql.id(table.name)}
			OWNER TO ${sql.id(config.runtimeRole)}
		`.execute(tx);
		await sql`
			REVOKE ALL PRIVILEGES
			ON TABLE ${sql.id(CASE_RUNTIME_SCHEMA)}.${sql.id(table.name)}
			FROM PUBLIC, ${sql.id(config.cleanupRole)}, ${sql.id(config.auditRole)}
		`.execute(tx);
		await sql`
			GRANT SELECT
			ON TABLE ${sql.id(CASE_RUNTIME_SCHEMA)}.${sql.id(table.name)}
			TO ${sql.id(config.auditRole)}
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
				FROM PUBLIC, ${sql.id(config.runtimeRole)},
					${sql.id(config.cleanupRole)}, ${sql.id(config.auditRole)}
		`.execute(tx);
		const capability = runtimeTableCapability(parent);
		if (
			capability === "read-write" ||
			capability === "append-only" ||
			capability === "insert-delete"
		) {
			await sql`
				GRANT USAGE, SELECT ON SEQUENCE public.${sql.id(sequence.name)}
				TO ${sql.id(config.runtimeRole)}
			`.execute(tx);
		}
	}

	for (const routine of routines.filter((row) => !row.extension_owned)) {
		await sql`
			ALTER FUNCTION public.${sql.id(routine.name)}(
				${sql.raw(routine.identity_arguments)}
			)
			OWNER TO ${sql.id(config.migrationRole)}
		`.execute(tx);
		await sql`
				REVOKE ALL PRIVILEGES ON FUNCTION public.${sql.id(routine.name)}(
					${sql.raw(routine.identity_arguments)}
				)
				FROM PUBLIC, ${sql.id(config.runtimeRole)},
					${sql.id(config.cleanupRole)}, ${sql.id(config.auditRole)}
		`.execute(tx);
	}
	for (const routine of RUNTIME_ROUTINES) {
		await sql`
			GRANT EXECUTE ON FUNCTION public.${sql.id(routine.name)}(
				${sql.raw(routine.identityArguments)}
			)
			TO ${sql.id(config.runtimeRole)}
		`.execute(tx);
	}
	await sql`
		GRANT SELECT, UPDATE, DELETE ON TABLE public.form_attachments
		TO ${sql.id(config.cleanupRole)}
	`.execute(tx);
	for (const table of AUDIT_SELECT_PUBLIC_TABLES) {
		await sql`
			GRANT SELECT ON TABLE public.${sql.id(table)}
			TO ${sql.id(config.auditRole)}
		`.execute(tx);
	}

	for (const objectType of ["TABLES", "SEQUENCES"] as const) {
		await sql`
			ALTER DEFAULT PRIVILEGES FOR ROLE ${sql.id(config.migrationRole)}
				IN SCHEMA public REVOKE ALL PRIVILEGES ON ${sql.raw(objectType)}
				FROM PUBLIC, ${sql.id(config.runtimeRole)},
					${sql.id(config.cleanupRole)}, ${sql.id(config.auditRole)}
		`.execute(tx);
	}
	await sql`
		ALTER DEFAULT PRIVILEGES FOR ROLE ${sql.id(config.migrationRole)}
			IN SCHEMA public REVOKE ALL PRIVILEGES ON FUNCTIONS
			FROM PUBLIC, ${sql.id(config.runtimeRole)},
				${sql.id(config.cleanupRole)}, ${sql.id(config.auditRole)}
	`.execute(tx);
	for (const objectType of ["TABLES", "SEQUENCES", "FUNCTIONS"] as const) {
		await sql`
			ALTER DEFAULT PRIVILEGES FOR ROLE ${sql.id(config.runtimeRole)}
				IN SCHEMA ${sql.id(CASE_RUNTIME_SCHEMA)}
				REVOKE ALL PRIVILEGES ON ${sql.raw(objectType)}
				FROM PUBLIC, ${sql.id(config.cleanupRole)}, ${sql.id(config.auditRole)}
		`.execute(tx);
	}
	// Re-read effective privileges after every grant. This assertion stays
	// inside the transaction, so privilege drift cannot partially commit.
	await readAndAssertRolePolicy(tx, config);
	await assertCleanupPrivilegeBoundary(tx, config);
	await assertAuditPrivilegeBoundary(tx, config);
}

/** Re-audit and converge ownership/grants after all migration phases.
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

interface RuntimeSessionTerminationRow {
	readonly pid: number;
	readonly terminated: boolean;
}

/**
 * One-time maintenance-cutover fence after runtime grants are restored.
 *
 * The migration role is a direct MEMBER of the runtime role, so PostgreSQL
 * permits it to terminate those sessions without granting the broad
 * `pg_signal_backend` role. After a short stabilization interval, any
 * reappearance proves an old service revision is still alive and the
 * migration Job fails before deployment.
 */
export async function terminateAndAssertNoRuntimeDatabaseSessions(
	db: Kysely<unknown>,
	runtimeRole: string,
	options: { readonly stabilizationMs?: number } = {},
): Promise<number> {
	const terminated = await sql<RuntimeSessionTerminationRow>`
		SELECT
			activity.pid,
			pg_catalog.pg_terminate_backend(activity.pid) AS terminated
		FROM pg_catalog.pg_stat_activity AS activity
		WHERE activity.usename = ${runtimeRole}
			AND activity.pid <> pg_catalog.pg_backend_pid()
			AND activity.backend_type = 'client backend'
		ORDER BY activity.pid
	`.execute(db);
	const failed = terminated.rows.filter((row) => !row.terminated);
	if (failed.length > 0) {
		throw new DatabasePrivilegeConvergenceError(
			"runtime_sessions_remain",
			"The migration identity could not terminate every pre-cutover runtime database session.",
		);
	}

	const stabilizationMs = options.stabilizationMs ?? 5_000;
	if (
		!Number.isSafeInteger(stabilizationMs) ||
		stabilizationMs < 0 ||
		stabilizationMs > 60_000
	) {
		throw new Error(
			"Runtime-session stabilization must be an integer from 0 through 60000 milliseconds.",
		);
	}
	if (stabilizationMs > 0) {
		await new Promise((resolve) => setTimeout(resolve, stabilizationMs));
	}

	const remaining = await sql<{ count: string | number }>`
		SELECT count(*) AS count
		FROM pg_catalog.pg_stat_activity AS activity
		WHERE activity.usename = ${runtimeRole}
			AND activity.pid <> pg_catalog.pg_backend_pid()
			AND activity.backend_type = 'client backend'
	`.execute(db);
	if (Number(remaining.rows[0]?.count ?? -1) !== 0) {
		throw new DatabasePrivilegeConvergenceError(
			"runtime_sessions_remain",
			"A runtime database session reappeared after the maintenance cutover fence.",
		);
	}
	return terminated.rows.length;
}
