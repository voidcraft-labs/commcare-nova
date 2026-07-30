/**
 * Final database ownership invariant for Nova apps.
 *
 * Better Auth owns `auth_organization`, so this exact cutover belongs to the
 * Nova auth-app ledger that runs after Better Auth's migrator. The preceding
 * case-store cutover has already established the final Project-bearing columns
 * and permanent app-change fold. This migration locks every relation it owns,
 * classifies the complete column/index/constraint/data state before its first
 * write, and accepts only the exact all-four-absent pristine or
 * all-four-present final shape.
 */

import { createHash } from "node:crypto";
import { type Kysely, sql } from "kysely";

export const APPS_PROJECT_FOREIGN_KEY = "apps_project_id_auth_organization_fk";
export const APPS_PROJECT_FOREIGN_KEY_DEFINITION =
	"FOREIGN KEY (project_id) REFERENCES auth_organization(id) ON UPDATE RESTRICT ON DELETE RESTRICT";
export const APP_CHANGES_FROM_PROJECT_FOREIGN_KEY =
	"app_changes_from_project_id_auth_organization_fk";
export const APP_CHANGES_FROM_PROJECT_FOREIGN_KEY_DEFINITION =
	"FOREIGN KEY (from_project_id) REFERENCES auth_organization(id) ON UPDATE RESTRICT ON DELETE RESTRICT";
export const APP_CHANGES_TO_PROJECT_FOREIGN_KEY =
	"app_changes_to_project_id_auth_organization_fk";
export const APP_CHANGES_TO_PROJECT_FOREIGN_KEY_DEFINITION =
	"FOREIGN KEY (to_project_id) REFERENCES auth_organization(id) ON UPDATE RESTRICT ON DELETE RESTRICT";
export const APP_CHANGE_FOLD_BASELINES_PROJECT_FOREIGN_KEY =
	"app_change_fold_baselines_project_id_auth_organization_fk";
export const APP_CHANGE_FOLD_BASELINES_PROJECT_FOREIGN_KEY_DEFINITION =
	"FOREIGN KEY (project_id) REFERENCES auth_organization(id) ON UPDATE RESTRICT ON DELETE RESTRICT";

interface ProjectPrivilegeRoleConfig {
	readonly migrationRole: string;
	readonly runtimeRole: string;
	readonly cleanupRole: string;
	readonly auditRole: string;
}

type ProjectAclFact = readonly [
	grantee: string,
	grantor: string,
	privilege: string,
	grantable: boolean,
];

interface ProjectColumnCatalog {
	readonly schema_name: string;
	readonly relation_name: string;
	readonly relation_kind: string;
	readonly persistence: string;
	readonly row_security: boolean;
	readonly force_row_security: boolean;
	readonly relation_owner: string;
	readonly relation_acl: readonly ProjectAclFact[];
	readonly ordinal: number;
	readonly column_name: string;
	readonly data_type: string;
	readonly not_null: boolean;
	readonly default_expression: string | null;
}

interface ProjectConstraintCatalog {
	readonly name: string;
	readonly constraint_type: string;
	readonly local_schema: string;
	readonly local_relation: string;
	readonly local_columns: string[];
	readonly referenced_schema: string | null;
	readonly referenced_relation: string | null;
	readonly referenced_columns: string[];
	readonly update_action: string | null;
	readonly delete_action: string | null;
	readonly deferrable: boolean;
	readonly initially_deferred: boolean;
	readonly validated: boolean;
	readonly definition: string;
}

interface ProjectIndexCatalog {
	readonly schema_name: string;
	readonly relation_name: string;
	readonly name: string;
	readonly access_method: string;
	readonly unique: boolean;
	readonly primary: boolean;
	readonly valid: boolean;
	readonly ready: boolean;
	readonly live: boolean;
	readonly owner_name: string;
	readonly acl: string;
	readonly definition: string;
}

interface AppsProjectCatalog {
	readonly current_user: string;
	readonly apps_column: ProjectColumnCatalog;
	readonly app_changes_from_column: ProjectColumnCatalog;
	readonly app_changes_to_column: ProjectColumnCatalog;
	readonly app_change_fold_baselines_column: ProjectColumnCatalog;
	readonly project_column: ProjectColumnCatalog;
	readonly project_key_constraints: readonly ProjectConstraintCatalog[];
	readonly constraints: readonly ProjectConstraintCatalog[];
	readonly apps_indexes: readonly ProjectIndexCatalog[];
	readonly app_changes_from_indexes: readonly ProjectIndexCatalog[];
	readonly app_changes_to_indexes: readonly ProjectIndexCatalog[];
	readonly app_change_fold_baselines_indexes: readonly ProjectIndexCatalog[];
	readonly project_indexes: readonly ProjectIndexCatalog[];
	readonly invalid_apps: string;
	readonly missing_app_projects: string;
	readonly invalid_change_from_projects: string;
	readonly missing_change_from_projects: string;
	readonly invalid_change_to_projects: string;
	readonly missing_change_to_projects: string;
	readonly invalid_fold_projects: string;
	readonly missing_fold_projects: string;
}

type ProjectColumnShape = Omit<
	ProjectColumnCatalog,
	"relation_owner" | "relation_acl"
>;

const EXPECTED_APPS_PROJECT_COLUMN: ProjectColumnShape = {
	schema_name: "public",
	relation_name: "apps",
	relation_kind: "r",
	persistence: "p",
	row_security: false,
	force_row_security: false,
	ordinal: 3,
	column_name: "project_id",
	data_type: "text",
	not_null: true,
	default_expression: null,
};

const EXPECTED_APP_CHANGES_FROM_PROJECT_COLUMN: ProjectColumnShape = {
	schema_name: "public",
	relation_name: "app_changes",
	relation_kind: "r",
	persistence: "p",
	row_security: false,
	force_row_security: false,
	ordinal: 9,
	column_name: "from_project_id",
	data_type: "text",
	not_null: false,
	default_expression: null,
};

const EXPECTED_APP_CHANGES_TO_PROJECT_COLUMN: ProjectColumnShape = {
	schema_name: "public",
	relation_name: "app_changes",
	relation_kind: "r",
	persistence: "p",
	row_security: false,
	force_row_security: false,
	ordinal: 10,
	column_name: "to_project_id",
	data_type: "text",
	not_null: false,
	default_expression: null,
};

const EXPECTED_APP_CHANGE_FOLD_BASELINES_PROJECT_COLUMN: ProjectColumnShape = {
	schema_name: "public",
	relation_name: "app_change_fold_baselines",
	relation_kind: "r",
	persistence: "p",
	row_security: false,
	force_row_security: false,
	ordinal: 3,
	column_name: "project_id",
	data_type: "text",
	not_null: true,
	default_expression: null,
};

const EXPECTED_PROJECT_ID_COLUMN: ProjectColumnShape = {
	schema_name: "public",
	relation_name: "auth_organization",
	relation_kind: "r",
	persistence: "p",
	row_security: false,
	force_row_security: false,
	ordinal: 1,
	column_name: "id",
	data_type: "text",
	not_null: true,
	default_expression: null,
};

type ProjectIndexShape = Omit<ProjectIndexCatalog, "owner_name">;

const EXPECTED_APPS_PROJECT_INDEXES: readonly ProjectIndexShape[] = [
	{
		schema_name: "public",
		relation_name: "apps",
		name: "apps_project_deleted",
		access_method: "btree",
		unique: false,
		primary: false,
		valid: true,
		ready: true,
		live: true,
		acl: "null",
		definition:
			"CREATE INDEX apps_project_deleted ON public.apps USING btree (project_id, deleted_at DESC, id) WHERE (deleted_at IS NOT NULL)",
	},
	{
		schema_name: "public",
		relation_name: "apps",
		name: "apps_project_id_id_key",
		access_method: "btree",
		unique: true,
		primary: false,
		valid: true,
		ready: true,
		live: true,
		acl: "null",
		definition:
			"CREATE UNIQUE INDEX apps_project_id_id_key ON public.apps USING btree (project_id, id)",
	},
	{
		schema_name: "public",
		relation_name: "apps",
		name: "apps_project_live_name",
		access_method: "btree",
		unique: false,
		primary: false,
		valid: true,
		ready: true,
		live: true,
		acl: "null",
		definition:
			"CREATE INDEX apps_project_live_name ON public.apps USING btree (project_id, app_name_lower, id) WHERE (deleted_at IS NULL)",
	},
	{
		schema_name: "public",
		relation_name: "apps",
		name: "apps_project_live_updated",
		access_method: "btree",
		unique: false,
		primary: false,
		valid: true,
		ready: true,
		live: true,
		acl: "null",
		definition:
			"CREATE INDEX apps_project_live_updated ON public.apps USING btree (project_id, updated_at DESC, id) WHERE (deleted_at IS NULL)",
	},
];

const EXPECTED_PROJECT_ID_INDEXES: readonly ProjectIndexShape[] = [
	{
		schema_name: "public",
		relation_name: "auth_organization",
		name: "auth_organization_pkey",
		access_method: "btree",
		unique: true,
		primary: true,
		valid: true,
		ready: true,
		live: true,
		acl: "null",
		definition:
			"CREATE UNIQUE INDEX auth_organization_pkey ON public.auth_organization USING btree (id)",
	},
];

function constraint(value: ProjectConstraintCatalog): ProjectConstraintCatalog {
	return value;
}

const EXPECTED_PROJECT_KEY_CONSTRAINTS: readonly ProjectConstraintCatalog[] = [
	constraint({
		name: "auth_organization_pkey",
		constraint_type: "p",
		local_schema: "public",
		local_relation: "auth_organization",
		local_columns: ["id"],
		referenced_schema: null,
		referenced_relation: null,
		referenced_columns: [],
		update_action: null,
		delete_action: null,
		deferrable: false,
		initially_deferred: false,
		validated: true,
		definition: "PRIMARY KEY (id)",
	}),
];

function expectedConstraints(
	casesSchema: string,
	includeAuthProjectForeignKeys: boolean,
): readonly ProjectConstraintCatalog[] {
	const constraints: ProjectConstraintCatalog[] = [
		constraint({
			name: "apps_project_id_id_key",
			constraint_type: "u",
			local_schema: "public",
			local_relation: "apps",
			local_columns: ["project_id", "id"],
			referenced_schema: null,
			referenced_relation: null,
			referenced_columns: [],
			update_action: null,
			delete_action: null,
			deferrable: false,
			initially_deferred: false,
			validated: true,
			definition: "UNIQUE (project_id, id)",
		}),
		constraint({
			name: "apps_project_id_nonblank_check",
			constraint_type: "c",
			local_schema: "public",
			local_relation: "apps",
			local_columns: ["project_id"],
			referenced_schema: null,
			referenced_relation: null,
			referenced_columns: [],
			update_action: null,
			delete_action: null,
			deferrable: false,
			initially_deferred: false,
			validated: true,
			definition: "CHECK (btrim(project_id) <> ''::text)",
		}),
		constraint({
			name: "apps_project_id_not_null",
			constraint_type: "n",
			local_schema: "public",
			local_relation: "apps",
			local_columns: ["project_id"],
			referenced_schema: null,
			referenced_relation: null,
			referenced_columns: [],
			update_action: null,
			delete_action: null,
			deferrable: false,
			initially_deferred: false,
			validated: true,
			definition: "NOT NULL project_id",
		}),
		constraint({
			name: "cases_project_app_tenant_fk",
			constraint_type: "f",
			local_schema: casesSchema,
			local_relation: "cases",
			local_columns: ["project_id", "app_id"],
			referenced_schema: "public",
			referenced_relation: "apps",
			referenced_columns: ["project_id", "id"],
			update_action: "a",
			delete_action: "r",
			deferrable: true,
			initially_deferred: true,
			validated: true,
			definition:
				"FOREIGN KEY (project_id, app_id) REFERENCES apps(project_id, id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED",
		}),
		constraint({
			name: "lookup_table_references_app_fk",
			constraint_type: "f",
			local_schema: "public",
			local_relation: "lookup_table_references",
			local_columns: ["project_id", "app_id"],
			referenced_schema: "public",
			referenced_relation: "apps",
			referenced_columns: ["project_id", "id"],
			update_action: "r",
			delete_action: "c",
			deferrable: false,
			initially_deferred: false,
			validated: true,
			definition:
				"FOREIGN KEY (project_id, app_id) REFERENCES apps(project_id, id) ON UPDATE RESTRICT ON DELETE CASCADE",
		}),
		constraint({
			name: "media_asset_refs_project_app_fk",
			constraint_type: "f",
			local_schema: "public",
			local_relation: "media_asset_refs",
			local_columns: ["project_id", "app_id"],
			referenced_schema: "public",
			referenced_relation: "apps",
			referenced_columns: ["project_id", "id"],
			update_action: "r",
			delete_action: "c",
			deferrable: false,
			initially_deferred: false,
			validated: true,
			definition:
				"FOREIGN KEY (project_id, app_id) REFERENCES apps(project_id, id) ON UPDATE RESTRICT ON DELETE CASCADE",
		}),
	];
	if (includeAuthProjectForeignKeys) {
		constraints.push(
			constraint({
				name: APPS_PROJECT_FOREIGN_KEY,
				constraint_type: "f",
				local_schema: "public",
				local_relation: "apps",
				local_columns: ["project_id"],
				referenced_schema: "public",
				referenced_relation: "auth_organization",
				referenced_columns: ["id"],
				update_action: "r",
				delete_action: "r",
				deferrable: false,
				initially_deferred: false,
				validated: true,
				definition: APPS_PROJECT_FOREIGN_KEY_DEFINITION,
			}),
			constraint({
				name: APP_CHANGES_FROM_PROJECT_FOREIGN_KEY,
				constraint_type: "f",
				local_schema: "public",
				local_relation: "app_changes",
				local_columns: ["from_project_id"],
				referenced_schema: "public",
				referenced_relation: "auth_organization",
				referenced_columns: ["id"],
				update_action: "r",
				delete_action: "r",
				deferrable: false,
				initially_deferred: false,
				validated: true,
				definition: APP_CHANGES_FROM_PROJECT_FOREIGN_KEY_DEFINITION,
			}),
			constraint({
				name: APP_CHANGES_TO_PROJECT_FOREIGN_KEY,
				constraint_type: "f",
				local_schema: "public",
				local_relation: "app_changes",
				local_columns: ["to_project_id"],
				referenced_schema: "public",
				referenced_relation: "auth_organization",
				referenced_columns: ["id"],
				update_action: "r",
				delete_action: "r",
				deferrable: false,
				initially_deferred: false,
				validated: true,
				definition: APP_CHANGES_TO_PROJECT_FOREIGN_KEY_DEFINITION,
			}),
			constraint({
				name: APP_CHANGE_FOLD_BASELINES_PROJECT_FOREIGN_KEY,
				constraint_type: "f",
				local_schema: "public",
				local_relation: "app_change_fold_baselines",
				local_columns: ["project_id"],
				referenced_schema: "public",
				referenced_relation: "auth_organization",
				referenced_columns: ["id"],
				update_action: "r",
				delete_action: "r",
				deferrable: false,
				initially_deferred: false,
				validated: true,
				definition: APP_CHANGE_FOLD_BASELINES_PROJECT_FOREIGN_KEY_DEFINITION,
			}),
		);
	}
	return constraints.sort((left, right) =>
		compareUtf8Bytes(left.name, right.name),
	);
}

function exactJson(left: unknown, right: unknown): boolean {
	return canonicalCatalogJson(left) === canonicalCatalogJson(right);
}

export function compareUtf8Bytes(left: string, right: string): number {
	return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function canonicalCatalogJson(value: unknown): string {
	if (value === null || typeof value !== "object") {
		const encoded = JSON.stringify(value);
		if (encoded === undefined) {
			throw new Error(
				"Auth-app Project tenancy blocked: catalog evidence is not JSON-serializable.",
			);
		}
		return encoded;
	}
	if (Array.isArray(value)) {
		return `[${value.map(canonicalCatalogJson).join(",")}]`;
	}
	const entries = Object.entries(value).sort(([left], [right]) =>
		compareUtf8Bytes(left, right),
	);
	return `{${entries
		.map(
			([key, entry]) => `${JSON.stringify(key)}:${canonicalCatalogJson(entry)}`,
		)
		.join(",")}}`;
}

function digest(value: unknown): string {
	return createHash("sha256").update(canonicalCatalogJson(value)).digest("hex");
}

function nonblankEnv(value: string | undefined): string | null {
	if (value === undefined) return null;
	const trimmed = value.trim();
	return trimmed.length === 0 ? null : trimmed;
}

function readProjectPrivilegeRoleConfig(
	env: Readonly<Partial<Record<string, string>>> = process.env,
): ProjectPrivilegeRoleConfig | null {
	const localUrl = nonblankEnv(env.NOVA_DB_LOCAL_URL);
	const values = [
		nonblankEnv(env.NOVA_MIGRATION_DB_USER),
		nonblankEnv(env.NOVA_RUNTIME_DB_USER),
		nonblankEnv(env.NOVA_CAPTURE_CLEANUP_DB_USER),
		nonblankEnv(env.NOVA_AUDIT_DB_USER),
	] as const;
	const configured = values.filter((value) => value !== null);
	if (configured.length === 0) {
		if (localUrl !== null) return null;
		throw new Error(
			"Auth-app Project tenancy blocked: production database privilege roles are absent.",
		);
	}
	if (configured.length !== values.length) {
		throw new Error(
			"Auth-app Project tenancy blocked: production database privilege roles are partial.",
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
		throw new Error(
			"Auth-app Project tenancy blocked: production database privilege roles are not distinct.",
		);
	}
	return { migrationRole, runtimeRole, cleanupRole, auditRole };
}

const OWNER_RELATION_PRIVILEGES = [
	"DELETE",
	"INSERT",
	"MAINTAIN",
	"REFERENCES",
	"SELECT",
	"TRIGGER",
	"TRUNCATE",
	"UPDATE",
] as const;

const RUNTIME_RELATION_PRIVILEGES = [
	"DELETE",
	"INSERT",
	"SELECT",
	"UPDATE",
] as const;
const RUNTIME_APP_CHANGE_PRIVILEGES = ["INSERT", "SELECT"] as const;
const RUNTIME_FOLD_BASELINE_PRIVILEGES = ["SELECT"] as const;

function sortedAclFacts(facts: readonly ProjectAclFact[]): ProjectAclFact[] {
	return [...facts].sort((left, right) => {
		for (const index of [0, 1, 2] as const) {
			const compared = compareUtf8Bytes(left[index], right[index]);
			if (compared !== 0) return compared;
		}
		return Number(left[3]) - Number(right[3]);
	});
}

function ownerOnlyAcl(owner: string): readonly ProjectAclFact[] {
	return OWNER_RELATION_PRIVILEGES.map(
		(privilege) => [owner, owner, privilege, false] as const,
	);
}

function convergedAcl(
	owner: string,
	config: ProjectPrivilegeRoleConfig,
	runtimePrivileges: readonly string[],
): readonly ProjectAclFact[] {
	return sortedAclFacts([
		...ownerOnlyAcl(owner),
		...runtimePrivileges.map(
			(privilege) =>
				[config.runtimeRole, config.migrationRole, privilege, false] as const,
		),
		[config.auditRole, config.migrationRole, "SELECT", false],
	]);
}

function expectedColumn(
	shape: ProjectColumnShape,
	owner: string,
	acl: readonly ProjectAclFact[],
): ProjectColumnCatalog {
	return {
		...shape,
		relation_owner: owner,
		relation_acl: acl,
	};
}

function expectedIndexes(
	indexes: readonly ProjectIndexShape[],
	owner: string,
): readonly ProjectIndexCatalog[] {
	return indexes.map((index) => ({ ...index, owner_name: owner }));
}

function exactAclProfile(
	catalog: AppsProjectCatalog,
	config: ProjectPrivilegeRoleConfig | null,
): boolean {
	// A fresh database reaches this migration before its first privilege
	// convergence and therefore has owner-only ACLs. An existing deployment has
	// the one converged runtime/audit profile. Those are two exact migration
	// entry states, not an ACL repair path: a mixed or additional grant blocks.
	const owner = catalog.current_user;
	if (
		catalog.apps_column.relation_owner !== owner ||
		catalog.app_changes_from_column.relation_owner !== owner ||
		catalog.app_changes_to_column.relation_owner !== owner ||
		catalog.app_change_fold_baselines_column.relation_owner !== owner ||
		catalog.project_column.relation_owner !== owner ||
		(config !== null && owner !== config.migrationRole)
	) {
		return false;
	}
	const ownerOnly = ownerOnlyAcl(owner);
	const relationAcls = [
		catalog.apps_column.relation_acl,
		catalog.app_changes_from_column.relation_acl,
		catalog.app_changes_to_column.relation_acl,
		catalog.app_change_fold_baselines_column.relation_acl,
		catalog.project_column.relation_acl,
	];
	if (relationAcls.every((acl) => exactJson(acl, ownerOnly))) {
		return true;
	}
	if (config === null) {
		return false;
	}
	const applicationAcl = convergedAcl(
		owner,
		config,
		RUNTIME_RELATION_PRIVILEGES,
	);
	const appChangesAcl = convergedAcl(
		owner,
		config,
		RUNTIME_APP_CHANGE_PRIVILEGES,
	);
	const foldBaselineAcl = convergedAcl(
		owner,
		config,
		RUNTIME_FOLD_BASELINE_PRIVILEGES,
	);
	return (
		exactJson(catalog.apps_column.relation_acl, applicationAcl) &&
		exactJson(catalog.project_column.relation_acl, applicationAcl) &&
		exactJson(catalog.app_changes_from_column.relation_acl, appChangesAcl) &&
		exactJson(catalog.app_changes_to_column.relation_acl, appChangesAcl) &&
		exactJson(
			catalog.app_change_fold_baselines_column.relation_acl,
			foldBaselineAcl,
		)
	);
}

async function readProjectColumn(
	db: Kysely<unknown>,
	relationName:
		| "apps"
		| "app_changes"
		| "app_change_fold_baselines"
		| "auth_organization",
	columnName: "project_id" | "from_project_id" | "to_project_id" | "id",
): Promise<ProjectColumnCatalog> {
	const result = await sql<ProjectColumnCatalog>`
		SELECT
			namespace.nspname AS schema_name,
			relation.relname AS relation_name,
			relation.relkind::text AS relation_kind,
			relation.relpersistence::text AS persistence,
			relation.relrowsecurity AS row_security,
			relation.relforcerowsecurity AS force_row_security,
			pg_get_userbyid(relation.relowner) AS relation_owner,
			COALESCE(
				(
					SELECT jsonb_agg(
						jsonb_build_array(
							acl_fact.grantee_name,
							acl_fact.grantor_name,
							acl_fact.privilege_type,
							acl_fact.is_grantable
						)
						ORDER BY
							convert_to(acl_fact.grantee_name, 'UTF8'),
							convert_to(acl_fact.grantor_name, 'UTF8'),
							convert_to(acl_fact.privilege_type, 'UTF8'),
							acl_fact.is_grantable
					)
					FROM (
						SELECT
							CASE
								WHEN exploded_acl.grantee = 0 THEN 'PUBLIC'
								ELSE pg_get_userbyid(exploded_acl.grantee)
							END AS grantee_name,
							pg_get_userbyid(exploded_acl.grantor) AS grantor_name,
							exploded_acl.privilege_type,
							exploded_acl.is_grantable
						FROM aclexplode(
							COALESCE(
								relation.relacl,
								acldefault('r', relation.relowner)
							)
						) AS exploded_acl
					) AS acl_fact
				),
				'[]'::jsonb
			) AS relation_acl,
			target_attribute.attnum::integer AS ordinal,
			target_attribute.attname AS column_name,
			format_type(
				target_attribute.atttypid,
				target_attribute.atttypmod
			) AS data_type,
			target_attribute.attnotnull AS not_null,
			pg_get_expr(default_value.adbin, default_value.adrelid)
				AS default_expression
		FROM pg_class AS relation
		JOIN pg_namespace AS namespace
		  ON namespace.oid = relation.relnamespace
		JOIN pg_attribute AS target_attribute
		  ON target_attribute.attrelid = relation.oid
		 AND target_attribute.attname = ${columnName}
		 AND NOT target_attribute.attisdropped
		LEFT JOIN pg_attrdef AS default_value
		  ON default_value.adrelid = target_attribute.attrelid
		 AND default_value.adnum = target_attribute.attnum
		WHERE namespace.nspname = 'public'
		  AND relation.relname = ${relationName}
		GROUP BY
			relation.oid,
			namespace.nspname,
			relation.relowner,
			relation.relacl,
			target_attribute.attnum,
			target_attribute.attname,
			target_attribute.atttypid,
			target_attribute.atttypmod,
			target_attribute.attnotnull,
			default_value.adbin,
			default_value.adrelid
	`.execute(db);
	const row = result.rows[0];
	if (row === undefined) {
		throw new Error(
			`Auth-app Project tenancy blocked: public.${relationName}.${columnName} is absent.`,
		);
	}
	return row;
}

async function readProjectConstraints(
	db: Kysely<unknown>,
): Promise<readonly ProjectConstraintCatalog[]> {
	const result = await sql<ProjectConstraintCatalog>`
		WITH app_project AS (
			SELECT
				relation.oid AS relation_id,
				attribute.attnum AS column_number
			FROM pg_class AS relation
			JOIN pg_namespace AS namespace
			  ON namespace.oid = relation.relnamespace
			JOIN pg_attribute AS attribute
			  ON attribute.attrelid = relation.oid
			 AND attribute.attname = 'project_id'
			 AND NOT attribute.attisdropped
			WHERE namespace.nspname = 'public'
			  AND relation.relname = 'apps'
		),
		auth_project_fk_columns(relation_name, column_name) AS (
			VALUES
				('apps', 'project_id'),
				('app_changes', 'from_project_id'),
				('app_changes', 'to_project_id'),
				('app_change_fold_baselines', 'project_id')
		)
		SELECT
			constraint_row.conname AS name,
			constraint_row.contype::text AS constraint_type,
			local_namespace.nspname AS local_schema,
			local_relation.relname AS local_relation,
			COALESCE(
				ARRAY(
					SELECT local_attribute.attname::text
					FROM unnest(constraint_row.conkey)
						WITH ORDINALITY AS local_key(attnum, position)
					JOIN pg_attribute AS local_attribute
					  ON local_attribute.attrelid = constraint_row.conrelid
					 AND local_attribute.attnum = local_key.attnum
					ORDER BY local_key.position
				),
				ARRAY[]::text[]
			) AS local_columns,
			referenced_namespace.nspname AS referenced_schema,
			referenced_relation.relname AS referenced_relation,
			CASE
				WHEN constraint_row.contype = 'f' THEN ARRAY(
					SELECT referenced_attribute.attname::text
					FROM unnest(constraint_row.confkey)
						WITH ORDINALITY AS referenced_key(attnum, position)
					JOIN pg_attribute AS referenced_attribute
					  ON referenced_attribute.attrelid = constraint_row.confrelid
					 AND referenced_attribute.attnum = referenced_key.attnum
					ORDER BY referenced_key.position
				)
				ELSE ARRAY[]::text[]
			END AS referenced_columns,
			CASE WHEN constraint_row.contype = 'f'
				THEN constraint_row.confupdtype::text END AS update_action,
			CASE WHEN constraint_row.contype = 'f'
				THEN constraint_row.confdeltype::text END AS delete_action,
			constraint_row.condeferrable AS deferrable,
			constraint_row.condeferred AS initially_deferred,
			constraint_row.convalidated AS validated,
			pg_get_constraintdef(constraint_row.oid, true) AS definition
		FROM pg_constraint AS constraint_row
		JOIN pg_class AS local_relation
		  ON local_relation.oid = constraint_row.conrelid
		JOIN pg_namespace AS local_namespace
		  ON local_namespace.oid = local_relation.relnamespace
		LEFT JOIN pg_class AS referenced_relation
		  ON referenced_relation.oid = constraint_row.confrelid
		LEFT JOIN pg_namespace AS referenced_namespace
		  ON referenced_namespace.oid = referenced_relation.relnamespace
		CROSS JOIN app_project
		WHERE (
			constraint_row.conrelid = app_project.relation_id
			AND app_project.column_number = ANY(constraint_row.conkey)
		) OR (
			constraint_row.confrelid = app_project.relation_id
			AND app_project.column_number = ANY(constraint_row.confkey)
		) OR (
			constraint_row.contype = 'f'
			AND EXISTS (
				SELECT 1
				FROM auth_project_fk_columns AS target
				JOIN pg_attribute AS target_attribute
				  ON target_attribute.attrelid = constraint_row.conrelid
				 AND target_attribute.attname = target.column_name
				 AND NOT target_attribute.attisdropped
				WHERE local_namespace.nspname = 'public'
				  AND local_relation.relname = target.relation_name
				  AND target_attribute.attnum = ANY(constraint_row.conkey)
			)
		)
		ORDER BY
			convert_to(constraint_row.conname, 'UTF8'),
			constraint_row.oid
	`.execute(db);
	return result.rows;
}

async function readProjectKeyConstraints(
	db: Kysely<unknown>,
): Promise<readonly ProjectConstraintCatalog[]> {
	const result = await sql<ProjectConstraintCatalog>`
		SELECT
			constraint_row.conname AS name,
			constraint_row.contype::text AS constraint_type,
			namespace.nspname AS local_schema,
			relation.relname AS local_relation,
			ARRAY(
				SELECT local_attribute.attname::text
				FROM unnest(constraint_row.conkey)
					WITH ORDINALITY AS local_key(attnum, position)
				JOIN pg_attribute AS local_attribute
				  ON local_attribute.attrelid = constraint_row.conrelid
				 AND local_attribute.attnum = local_key.attnum
				ORDER BY local_key.position
			) AS local_columns,
			NULL::text AS referenced_schema,
			NULL::text AS referenced_relation,
			ARRAY[]::text[] AS referenced_columns,
			NULL::text AS update_action,
			NULL::text AS delete_action,
			constraint_row.condeferrable AS deferrable,
			constraint_row.condeferred AS initially_deferred,
			constraint_row.convalidated AS validated,
			pg_get_constraintdef(constraint_row.oid, true) AS definition
		FROM pg_constraint AS constraint_row
		JOIN pg_class AS relation ON relation.oid = constraint_row.conrelid
		JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
		JOIN pg_attribute AS id_column
		  ON id_column.attrelid = relation.oid
		 AND id_column.attname = 'id'
		 AND NOT id_column.attisdropped
		WHERE namespace.nspname = 'public'
		  AND relation.relname = 'auth_organization'
		  AND constraint_row.contype IN ('p', 'u')
		  AND id_column.attnum = ANY(constraint_row.conkey)
		ORDER BY
			convert_to(constraint_row.conname, 'UTF8'),
			constraint_row.oid
	`.execute(db);
	return result.rows;
}

async function readProjectIndexes(
	db: Kysely<unknown>,
	relationName:
		| "apps"
		| "app_changes"
		| "app_change_fold_baselines"
		| "auth_organization",
	columnName: "project_id" | "from_project_id" | "to_project_id" | "id",
): Promise<readonly ProjectIndexCatalog[]> {
	const result = await sql<ProjectIndexCatalog>`
		SELECT
			table_namespace.nspname AS schema_name,
			table_relation.relname AS relation_name,
			index_relation.relname AS name,
			access_method.amname AS access_method,
			index_row.indisunique AS unique,
			index_row.indisprimary AS primary,
			index_row.indisvalid AS valid,
			index_row.indisready AS ready,
			index_row.indislive AS live,
			pg_get_userbyid(index_relation.relowner) AS owner_name,
			COALESCE(to_jsonb(index_relation.relacl)::text, 'null') AS acl,
			pg_get_indexdef(index_row.indexrelid) AS definition
		FROM pg_index AS index_row
		JOIN pg_class AS table_relation
		  ON table_relation.oid = index_row.indrelid
		JOIN pg_namespace AS table_namespace
		  ON table_namespace.oid = table_relation.relnamespace
		JOIN pg_attribute AS project_column
		  ON project_column.attrelid = table_relation.oid
		 AND project_column.attname = ${columnName}
		 AND NOT project_column.attisdropped
		JOIN pg_class AS index_relation
		  ON index_relation.oid = index_row.indexrelid
		JOIN pg_am AS access_method
		  ON access_method.oid = index_relation.relam
		WHERE table_namespace.nspname = 'public'
		  AND table_relation.relname = ${relationName}
		  AND (
				project_column.attnum = ANY(index_row.indkey::smallint[])
				OR EXISTS (
					SELECT 1
					FROM pg_depend AS dependency
					WHERE dependency.classid = 'pg_class'::regclass
					  AND dependency.objid = index_row.indexrelid
					  AND dependency.refclassid = 'pg_class'::regclass
					  AND dependency.refobjid = table_relation.oid
					  AND dependency.refobjsubid = project_column.attnum
				)
		  )
		ORDER BY
			convert_to(index_relation.relname, 'UTF8'),
			index_row.indexrelid
	`.execute(db);
	return result.rows;
}

async function captureAppsProjectCatalog(
	db: Kysely<unknown>,
): Promise<AppsProjectCatalog> {
	const appsColumn = await readProjectColumn(db, "apps", "project_id");
	const appChangesFromColumn = await readProjectColumn(
		db,
		"app_changes",
		"from_project_id",
	);
	const appChangesToColumn = await readProjectColumn(
		db,
		"app_changes",
		"to_project_id",
	);
	const appChangeFoldBaselinesColumn = await readProjectColumn(
		db,
		"app_change_fold_baselines",
		"project_id",
	);
	const projectColumn = await readProjectColumn(db, "auth_organization", "id");
	const projectKeyConstraints = await readProjectKeyConstraints(db);
	const constraints = await readProjectConstraints(db);
	const appsIndexes = await readProjectIndexes(db, "apps", "project_id");
	const appChangesFromIndexes = await readProjectIndexes(
		db,
		"app_changes",
		"from_project_id",
	);
	const appChangesToIndexes = await readProjectIndexes(
		db,
		"app_changes",
		"to_project_id",
	);
	const appChangeFoldBaselinesIndexes = await readProjectIndexes(
		db,
		"app_change_fold_baselines",
		"project_id",
	);
	const projectIndexes = await readProjectIndexes(
		db,
		"auth_organization",
		"id",
	);
	const identity = await sql<{ current_user: string }>`
		SELECT current_user
	`.execute(db);
	const currentUser = identity.rows[0]?.current_user;
	if (currentUser === undefined) {
		throw new Error(
			"Auth-app Project tenancy blocked: database identity is unavailable.",
		);
	}
	const canReadRows =
		appsColumn.data_type === "text" &&
		appChangesFromColumn.data_type === "text" &&
		appChangesToColumn.data_type === "text" &&
		appChangeFoldBaselinesColumn.data_type === "text" &&
		projectColumn.data_type === "text";
	const rows = canReadRows
		? ((
				await sql<{
					invalid_apps: string;
					missing_app_projects: string;
					invalid_change_from_projects: string;
					missing_change_from_projects: string;
					invalid_change_to_projects: string;
					missing_change_to_projects: string;
					invalid_fold_projects: string;
					missing_fold_projects: string;
				}>`
					SELECT
						(
							SELECT count(*)::text
							FROM public.apps
							WHERE project_id IS NULL OR btrim(project_id) = ''
						) AS invalid_apps,
						(
							SELECT count(*)::text
							FROM public.apps AS app
							WHERE NOT EXISTS (
								SELECT 1
								FROM public.auth_organization AS project
								WHERE project.id = app.project_id
							)
						) AS missing_app_projects,
						(
							SELECT count(*)::text
							FROM public.app_changes
							WHERE from_project_id IS NOT NULL
							  AND btrim(from_project_id) = ''
						) AS invalid_change_from_projects,
						(
							SELECT count(*)::text
							FROM public.app_changes AS change_row
							WHERE change_row.from_project_id IS NOT NULL
							  AND NOT EXISTS (
									SELECT 1
									FROM public.auth_organization AS project
									WHERE project.id = change_row.from_project_id
								)
						) AS missing_change_from_projects,
						(
							SELECT count(*)::text
							FROM public.app_changes
							WHERE to_project_id IS NOT NULL
							  AND btrim(to_project_id) = ''
						) AS invalid_change_to_projects,
						(
							SELECT count(*)::text
							FROM public.app_changes AS change_row
							WHERE change_row.to_project_id IS NOT NULL
							  AND NOT EXISTS (
									SELECT 1
									FROM public.auth_organization AS project
									WHERE project.id = change_row.to_project_id
								)
						) AS missing_change_to_projects,
						(
							SELECT count(*)::text
							FROM public.app_change_fold_baselines
							WHERE project_id IS NULL OR btrim(project_id) = ''
						) AS invalid_fold_projects,
						(
							SELECT count(*)::text
							FROM public.app_change_fold_baselines AS baseline
							WHERE NOT EXISTS (
								SELECT 1
								FROM public.auth_organization AS project
								WHERE project.id = baseline.project_id
							)
						) AS missing_fold_projects
				`.execute(db)
			).rows[0] ?? {
				invalid_apps: "unknown",
				missing_app_projects: "unknown",
				invalid_change_from_projects: "unknown",
				missing_change_from_projects: "unknown",
				invalid_change_to_projects: "unknown",
				missing_change_to_projects: "unknown",
				invalid_fold_projects: "unknown",
				missing_fold_projects: "unknown",
			})
		: {
				invalid_apps: "1",
				missing_app_projects: "1",
				invalid_change_from_projects: "1",
				missing_change_from_projects: "1",
				invalid_change_to_projects: "1",
				missing_change_to_projects: "1",
				invalid_fold_projects: "1",
				missing_fold_projects: "1",
			};
	return {
		current_user: currentUser,
		apps_column: appsColumn,
		app_changes_from_column: appChangesFromColumn,
		app_changes_to_column: appChangesToColumn,
		app_change_fold_baselines_column: appChangeFoldBaselinesColumn,
		project_column: projectColumn,
		project_key_constraints: projectKeyConstraints,
		constraints,
		apps_indexes: appsIndexes,
		app_changes_from_indexes: appChangesFromIndexes,
		app_changes_to_indexes: appChangesToIndexes,
		app_change_fold_baselines_indexes: appChangeFoldBaselinesIndexes,
		project_indexes: projectIndexes,
		...rows,
	};
}

function casesSchemaFrom(
	constraints: readonly ProjectConstraintCatalog[],
): string | null {
	const caseConstraints = constraints.filter(
		(row) =>
			row.name === "cases_project_app_tenant_fk" &&
			row.local_relation === "cases",
	);
	if (caseConstraints.length !== 1) return null;
	const schema = caseConstraints[0]?.local_schema;
	return schema === "public" || schema === "nova_case_runtime" ? schema : null;
}

function isExactState(
	catalog: AppsProjectCatalog,
	includeAuthProjectForeignKeys: boolean,
	config: ProjectPrivilegeRoleConfig | null,
): boolean {
	const casesSchema = casesSchemaFrom(catalog.constraints);
	const owner = catalog.current_user;
	return (
		casesSchema !== null &&
		exactAclProfile(catalog, config) &&
		exactJson(
			catalog.apps_column,
			expectedColumn(
				EXPECTED_APPS_PROJECT_COLUMN,
				owner,
				catalog.apps_column.relation_acl,
			),
		) &&
		exactJson(
			catalog.app_changes_from_column,
			expectedColumn(
				EXPECTED_APP_CHANGES_FROM_PROJECT_COLUMN,
				owner,
				catalog.app_changes_from_column.relation_acl,
			),
		) &&
		exactJson(
			catalog.app_changes_to_column,
			expectedColumn(
				EXPECTED_APP_CHANGES_TO_PROJECT_COLUMN,
				owner,
				catalog.app_changes_to_column.relation_acl,
			),
		) &&
		exactJson(
			catalog.app_change_fold_baselines_column,
			expectedColumn(
				EXPECTED_APP_CHANGE_FOLD_BASELINES_PROJECT_COLUMN,
				owner,
				catalog.app_change_fold_baselines_column.relation_acl,
			),
		) &&
		exactJson(
			catalog.project_column,
			expectedColumn(
				EXPECTED_PROJECT_ID_COLUMN,
				owner,
				catalog.project_column.relation_acl,
			),
		) &&
		exactJson(
			catalog.project_key_constraints,
			EXPECTED_PROJECT_KEY_CONSTRAINTS,
		) &&
		exactJson(
			catalog.constraints,
			expectedConstraints(casesSchema, includeAuthProjectForeignKeys),
		) &&
		exactJson(
			catalog.apps_indexes,
			expectedIndexes(EXPECTED_APPS_PROJECT_INDEXES, owner),
		) &&
		exactJson(catalog.app_changes_from_indexes, []) &&
		exactJson(catalog.app_changes_to_indexes, []) &&
		exactJson(catalog.app_change_fold_baselines_indexes, []) &&
		exactJson(
			catalog.project_indexes,
			expectedIndexes(EXPECTED_PROJECT_ID_INDEXES, owner),
		) &&
		catalog.invalid_apps === "0" &&
		catalog.missing_app_projects === "0" &&
		catalog.invalid_change_from_projects === "0" &&
		catalog.missing_change_from_projects === "0" &&
		catalog.invalid_change_to_projects === "0" &&
		catalog.missing_change_to_projects === "0" &&
		catalog.invalid_fold_projects === "0" &&
		catalog.missing_fold_projects === "0"
	);
}

async function runLockedCutover(db: Kysely<unknown>): Promise<void> {
	await sql`
		SELECT pg_advisory_xact_lock(
			hashtextextended('nova:apps-project-auth-tenancy-cutover', 0)
		)
	`.execute(db);
	const requiredRelations = await sql<{
		app_change_fold_baselines_exist: boolean;
		app_changes_exist: boolean;
		apps_exists: boolean;
		projects_exist: boolean;
	}>`
		SELECT
			to_regclass('public.app_change_fold_baselines') IS NOT NULL
				AS app_change_fold_baselines_exist,
			to_regclass('public.app_changes') IS NOT NULL AS app_changes_exist,
			to_regclass('public.apps') IS NOT NULL AS apps_exists,
			to_regclass('public.auth_organization') IS NOT NULL AS projects_exist
	`.execute(db);
	const relations = requiredRelations.rows[0];
	if (
		relations?.app_change_fold_baselines_exist !== true ||
		relations.app_changes_exist !== true ||
		relations.apps_exists !== true ||
		relations.projects_exist !== true
	) {
		throw new Error(
			"Auth-app Project tenancy blocked: case-store and Better Auth migrations must create public.app_change_fold_baselines, public.app_changes, public.apps, and public.auth_organization first.",
		);
	}
	await sql`
		LOCK TABLE
			public.app_change_fold_baselines,
			public.app_changes,
			public.apps,
			public.auth_organization
		IN ACCESS EXCLUSIVE MODE
	`.execute(db);

	const privilegeConfig = readProjectPrivilegeRoleConfig();
	const before = await captureAppsProjectCatalog(db);
	if (isExactState(before, true, privilegeConfig)) {
		return;
	}
	if (!isExactState(before, false, privilegeConfig)) {
		throw new Error(
			`Auth-app Project tenancy blocked: project_id catalog, constraints, indexes, or data are partial or drifted (${digest(before)}).`,
		);
	}

	// Plain final DDL is safe only after exact all-four-absent classification.
	await sql`
		ALTER TABLE public.apps
		ADD CONSTRAINT ${sql.id(APPS_PROJECT_FOREIGN_KEY)}
		FOREIGN KEY (project_id)
		REFERENCES public.auth_organization (id)
		ON UPDATE RESTRICT
		ON DELETE RESTRICT
	`.execute(db);
	await sql`
		ALTER TABLE public.app_changes
		ADD CONSTRAINT ${sql.id(APP_CHANGES_FROM_PROJECT_FOREIGN_KEY)}
		FOREIGN KEY (from_project_id)
		REFERENCES public.auth_organization (id)
		ON UPDATE RESTRICT
		ON DELETE RESTRICT
	`.execute(db);
	await sql`
		ALTER TABLE public.app_changes
		ADD CONSTRAINT ${sql.id(APP_CHANGES_TO_PROJECT_FOREIGN_KEY)}
		FOREIGN KEY (to_project_id)
		REFERENCES public.auth_organization (id)
		ON UPDATE RESTRICT
		ON DELETE RESTRICT
	`.execute(db);
	await sql`
		ALTER TABLE public.app_change_fold_baselines
		ADD CONSTRAINT ${sql.id(APP_CHANGE_FOLD_BASELINES_PROJECT_FOREIGN_KEY)}
		FOREIGN KEY (project_id)
		REFERENCES public.auth_organization (id)
		ON UPDATE RESTRICT
		ON DELETE RESTRICT
	`.execute(db);

	const after = await captureAppsProjectCatalog(db);
	if (!isExactState(after, true, privilegeConfig)) {
		throw new Error(
			`Auth-app Project tenancy failed its final catalog/data proof (${digest(after)}).`,
		);
	}
}

export async function up(db: Kysely<unknown>): Promise<void> {
	if (db.isTransaction) {
		await runLockedCutover(db);
		return;
	}
	await db.transaction().execute(runLockedCutover);
}

export async function down(): Promise<void> {
	throw new Error(
		"Project-reference tenancy is forward-only; restore the authoritative pre-cutover backup instead of dropping it.",
	);
}
