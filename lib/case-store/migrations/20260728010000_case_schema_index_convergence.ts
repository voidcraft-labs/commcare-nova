import { createHash } from "node:crypto";
import { type Kysely, sql } from "kysely";

/**
 * Durable expression-index convergence state.
 *
 * This is an exact maintenance cutover, not an adoption migration. It accepts
 * only the complete pre-cutover catalog or the complete final catalog. A
 * partial/alternate shape aborts before the first write, and an exact final
 * rerun is a read-only audit so it cannot reset a newer pending sequence.
 */

const CASE_SCHEMA_TABLE = "case_type_schemas";
const DELETION_TABLE = "case_schema_index_deletions";

interface RelationCatalog {
	readonly schema_name: string;
	readonly relation_name: string;
	readonly relation_kind: string;
	readonly persistence: string;
	readonly owner_name: string;
	readonly raw_acl: string;
	readonly acl: readonly AclGrantCatalog[];
	readonly row_security: boolean;
	readonly force_row_security: boolean;
}

interface AclGrantCatalog {
	readonly grantor: string;
	readonly grantee: string;
	readonly privilege_type: string;
	readonly grantable: boolean;
}

interface ColumnCatalog {
	readonly ordinal: number;
	readonly name: string;
	readonly data_type: string;
	readonly not_null: boolean;
	readonly default_expression: string | null;
}

interface ConstraintCatalog {
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

interface IndexCatalog {
	readonly name: string;
	readonly owner_name: string;
	readonly raw_acl: string;
	readonly access_method: string;
	readonly unique: boolean;
	readonly primary: boolean;
	readonly valid: boolean;
	readonly ready: boolean;
	readonly live: boolean;
	readonly definition: string;
}

interface TableCatalog {
	readonly relation: RelationCatalog;
	readonly columns: readonly ColumnCatalog[];
	readonly constraints: readonly ConstraintCatalog[];
	readonly indexes: readonly IndexCatalog[];
	readonly triggers: readonly string[];
}

interface CaseSchemaDataCatalog {
	readonly row_count: string;
	readonly invalid_legacy_rows: string;
	readonly invalid_final_rows: string;
	readonly deletion_row_count: string;
	readonly invalid_deletion_rows: string;
	readonly overlapping_rows: string;
}

interface CutoverCatalog {
	readonly case_schema: TableCatalog;
	readonly deletion: TableCatalog | null;
	readonly data: CaseSchemaDataCatalog;
	readonly authority: CatalogAuthority;
}

interface DatabasePrivilegeRoleConfig {
	readonly migration_role: string;
	readonly runtime_role: string;
	readonly cleanup_role: string;
	readonly audit_role: string;
}

interface CatalogAuthority {
	readonly current_role: string;
	readonly privilege_roles: DatabasePrivilegeRoleConfig | null;
}

const DATABASE_PRIVILEGE_ROLE_ENV_KEYS = [
	"NOVA_MIGRATION_DB_USER",
	"NOVA_RUNTIME_DB_USER",
	"NOVA_CAPTURE_CLEANUP_DB_USER",
	"NOVA_AUDIT_DB_USER",
] as const;

const TABLE_OWNER_PRIVILEGES = [
	"DELETE",
	"INSERT",
	"MAINTAIN",
	"REFERENCES",
	"SELECT",
	"TRIGGER",
	"TRUNCATE",
	"UPDATE",
] as const;

const TABLE_RUNTIME_PRIVILEGES = [
	"DELETE",
	"INSERT",
	"SELECT",
	"UPDATE",
] as const;

const LEGACY_COLUMNS: readonly ColumnCatalog[] = [
	{
		ordinal: 1,
		name: "app_id",
		data_type: "text",
		not_null: true,
		default_expression: null,
	},
	{
		ordinal: 2,
		name: "case_type",
		data_type: "text",
		not_null: true,
		default_expression: null,
	},
	{
		ordinal: 3,
		name: "schema",
		data_type: "jsonb",
		not_null: true,
		default_expression: null,
	},
	{
		ordinal: 4,
		name: "synced_seq",
		data_type: "bigint",
		not_null: true,
		default_expression: "0",
	},
];

const FINAL_COLUMNS: readonly ColumnCatalog[] = [
	...LEGACY_COLUMNS,
	{
		ordinal: 5,
		name: "index_pending_seq",
		data_type: "bigint",
		not_null: false,
		default_expression: null,
	},
	{
		ordinal: 6,
		name: "index_synced_seq",
		data_type: "bigint",
		not_null: true,
		default_expression: "0",
	},
];

function notNullConstraint(
	relationName: string,
	columnName: string,
): ConstraintCatalog {
	return {
		name: `${relationName}_${columnName}_not_null`,
		constraint_type: "n",
		local_schema: "public",
		local_relation: relationName,
		local_columns: [columnName],
		referenced_schema: null,
		referenced_relation: null,
		referenced_columns: [],
		update_action: null,
		delete_action: null,
		deferrable: false,
		initially_deferred: false,
		validated: true,
		definition: `NOT NULL ${columnName}`,
	};
}

const LEGACY_CASE_SCHEMA_CONSTRAINTS: readonly ConstraintCatalog[] = [
	notNullConstraint(CASE_SCHEMA_TABLE, "app_id"),
	notNullConstraint(CASE_SCHEMA_TABLE, "case_type"),
	{
		name: "case_type_schemas_pkey",
		constraint_type: "p",
		local_schema: "public",
		local_relation: CASE_SCHEMA_TABLE,
		local_columns: ["app_id", "case_type"],
		referenced_schema: null,
		referenced_relation: null,
		referenced_columns: [],
		update_action: null,
		delete_action: null,
		deferrable: false,
		initially_deferred: false,
		validated: true,
		definition: "PRIMARY KEY (app_id, case_type)",
	},
	notNullConstraint(CASE_SCHEMA_TABLE, "schema"),
	notNullConstraint(CASE_SCHEMA_TABLE, "synced_seq"),
];

const FINAL_CASE_SCHEMA_CONSTRAINTS: readonly ConstraintCatalog[] = [
	notNullConstraint(CASE_SCHEMA_TABLE, "app_id"),
	notNullConstraint(CASE_SCHEMA_TABLE, "case_type"),
	notNullConstraint(CASE_SCHEMA_TABLE, "index_synced_seq"),
	...LEGACY_CASE_SCHEMA_CONSTRAINTS.slice(2),
];

function expectedCaseSchemaIndexes(ownerName: string): readonly IndexCatalog[] {
	return [
		{
			name: "case_type_schemas_pkey",
			owner_name: ownerName,
			raw_acl: "null",
			access_method: "btree",
			unique: true,
			primary: true,
			valid: true,
			ready: true,
			live: true,
			definition:
				"CREATE UNIQUE INDEX case_type_schemas_pkey ON public.case_type_schemas USING btree (app_id, case_type)",
		},
	];
}

const DELETION_COLUMNS: readonly ColumnCatalog[] = [
	{
		ordinal: 1,
		name: "app_id",
		data_type: "text",
		not_null: true,
		default_expression: null,
	},
	{
		ordinal: 2,
		name: "case_type",
		data_type: "text",
		not_null: true,
		default_expression: null,
	},
];

const DELETION_CONSTRAINTS: readonly ConstraintCatalog[] = [
	notNullConstraint(DELETION_TABLE, "app_id"),
	notNullConstraint(DELETION_TABLE, "case_type"),
	{
		name: "case_schema_index_deletions_pkey",
		constraint_type: "p",
		local_schema: "public",
		local_relation: DELETION_TABLE,
		local_columns: ["app_id", "case_type"],
		referenced_schema: null,
		referenced_relation: null,
		referenced_columns: [],
		update_action: null,
		delete_action: null,
		deferrable: false,
		initially_deferred: false,
		validated: true,
		definition: "PRIMARY KEY (app_id, case_type)",
	},
];

function expectedDeletionIndexes(ownerName: string): readonly IndexCatalog[] {
	return [
		{
			name: "case_schema_index_deletions_pkey",
			owner_name: ownerName,
			raw_acl: "null",
			access_method: "btree",
			unique: true,
			primary: true,
			valid: true,
			ready: true,
			live: true,
			definition:
				"CREATE UNIQUE INDEX case_schema_index_deletions_pkey ON public.case_schema_index_deletions USING btree (app_id, case_type)",
		},
	];
}

function expectedRelation(
	relationName: string,
	ownerName: string,
	rawAcl: string,
	acl: readonly AclGrantCatalog[],
): RelationCatalog {
	return {
		schema_name: "public",
		relation_name: relationName,
		relation_kind: "r",
		persistence: "p",
		owner_name: ownerName,
		raw_acl: rawAcl,
		acl,
		row_security: false,
		force_row_security: false,
	};
}

function exactJson(left: unknown, right: unknown): boolean {
	return canonicalCatalogJson(left) === canonicalCatalogJson(right);
}

function readPrivilegeRoleConfig(): DatabasePrivilegeRoleConfig | null {
	const values = DATABASE_PRIVILEGE_ROLE_ENV_KEYS.map((key) => {
		const value = process.env[key]?.trim();
		return value === undefined || value.length === 0 ? null : value;
	});
	const configured = values.filter((value) => value !== null);
	if (configured.length === 0) return null;
	if (configured.length !== values.length) {
		throw new Error(
			"Case-schema index convergence blocked: database privilege-role configuration is partial.",
		);
	}
	const [migrationRole, runtimeRole, cleanupRole, auditRole] = values as [
		string,
		string,
		string,
		string,
	];
	if (
		new Set([migrationRole, runtimeRole, cleanupRole, auditRole]).size !== 4 ||
		[migrationRole, runtimeRole, cleanupRole, auditRole].some(
			(role) => role.toUpperCase() === "PUBLIC",
		)
	) {
		throw new Error(
			"Case-schema index convergence blocked: database privilege-role configuration is invalid.",
		);
	}
	return {
		migration_role: migrationRole,
		runtime_role: runtimeRole,
		cleanup_role: cleanupRole,
		audit_role: auditRole,
	};
}

function grants(
	grantor: string,
	grantee: string,
	privileges: readonly string[],
	grantable: boolean,
): readonly AclGrantCatalog[] {
	return privileges.map((privilegeType) => ({
		grantor,
		grantee,
		privilege_type: privilegeType,
		grantable,
	}));
}

function ownerOnlyAcl(ownerName: string): readonly AclGrantCatalog[] {
	return grants(ownerName, ownerName, TABLE_OWNER_PRIVILEGES, false);
}

function convergedApplicationAcl(
	authority: CatalogAuthority,
): readonly AclGrantCatalog[] | null {
	const config = authority.privilege_roles;
	if (config === null) return null;
	return [
		...grants(
			config.migration_role,
			config.migration_role,
			TABLE_OWNER_PRIVILEGES,
			false,
		),
		...grants(config.migration_role, config.audit_role, ["SELECT"], false),
		...grants(
			config.migration_role,
			config.runtime_role,
			TABLE_RUNTIME_PRIVILEGES,
			false,
		),
	].sort(compareAclGrants);
}

function compareUtf8(left: string, right: string): number {
	return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function canonicalCatalogJson(value: unknown): string {
	if (value === null || typeof value !== "object") {
		const encoded = JSON.stringify(value);
		if (encoded === undefined) {
			throw new Error(
				"Case-schema index convergence blocked: catalog evidence is not JSON-serializable.",
			);
		}
		return encoded;
	}
	if (Array.isArray(value)) {
		return `[${value.map(canonicalCatalogJson).join(",")}]`;
	}
	const entries = Object.entries(value).sort(([left], [right]) =>
		compareUtf8(left, right),
	);
	return `{${entries
		.map(
			([key, entry]) => `${JSON.stringify(key)}:${canonicalCatalogJson(entry)}`,
		)
		.join(",")}}`;
}

function compareAclGrants(
	left: AclGrantCatalog,
	right: AclGrantCatalog,
): number {
	return (
		compareUtf8(left.grantee, right.grantee) ||
		compareUtf8(left.grantor, right.grantor) ||
		compareUtf8(left.privilege_type, right.privilege_type) ||
		Number(left.grantable) - Number(right.grantable)
	);
}

function isExpectedApplicationAcl(
	relation: RelationCatalog,
	authority: CatalogAuthority,
): boolean {
	// A fresh database reaches this migration before the migration Job's one
	// terminal privilege-convergence pass, so owner-only is its exact pristine
	// ACL. An existing database has already completed that pass and must carry
	// the exact application-table runtime/audit grants. These are deployment
	// lifecycle prestates of one table contract, not alternate readers or a
	// compatibility schema. The DDL path below copies the latter exactly so the
	// two final relations can never commit with different ACLs.
	const ownerOnly = ownerOnlyAcl(authority.current_role);
	if (relation.raw_acl === "null" && exactJson(relation.acl, ownerOnly)) {
		return true;
	}
	const converged = convergedApplicationAcl(authority);
	return (
		converged !== null &&
		relation.raw_acl !== "null" &&
		exactJson(relation.acl, converged)
	);
}

function catalogDigest(value: unknown): string {
	return createHash("sha256").update(canonicalCatalogJson(value)).digest("hex");
}

function assertExactTable(
	actual: TableCatalog,
	expected: {
		readonly relation: RelationCatalog;
		readonly columns: readonly ColumnCatalog[];
		readonly constraints: readonly ConstraintCatalog[];
		readonly indexes: readonly IndexCatalog[];
	},
): boolean {
	return (
		exactJson(actual.relation, expected.relation) &&
		exactJson(actual.columns, expected.columns) &&
		exactJson(actual.constraints, expected.constraints) &&
		exactJson(actual.indexes, expected.indexes) &&
		actual.triggers.length === 0
	);
}

async function relationExists(
	db: Kysely<unknown>,
	relationName: string,
): Promise<boolean> {
	const result = await sql<{ exists: boolean }>`
		SELECT to_regclass(${`public.${relationName}`}) IS NOT NULL AS exists
	`.execute(db);
	return result.rows[0]?.exists === true;
}

async function readTableCatalog(
	db: Kysely<unknown>,
	relationName: string,
): Promise<TableCatalog> {
	const relationResult = await sql<Omit<RelationCatalog, "acl">>`
		SELECT
			namespace.nspname AS schema_name,
			relation.relname AS relation_name,
			relation.relkind::text AS relation_kind,
			relation.relpersistence::text AS persistence,
			owner_role.rolname AS owner_name,
			COALESCE(to_jsonb(relation.relacl)::text, 'null') AS raw_acl,
			relation.relrowsecurity AS row_security,
			relation.relforcerowsecurity AS force_row_security
		FROM pg_class AS relation
		JOIN pg_namespace AS namespace
		  ON namespace.oid = relation.relnamespace
		JOIN pg_roles AS owner_role
		  ON owner_role.oid = relation.relowner
		WHERE namespace.nspname = 'public'
		  AND relation.relname = ${relationName}
	`.execute(db);
	const relationRow = relationResult.rows[0];
	if (relationRow === undefined) {
		throw new Error(`Required relation public.${relationName} is absent.`);
	}
	const acl = await sql<AclGrantCatalog>`
		SELECT
			grantor_role.rolname AS grantor,
			CASE
				WHEN acl_row.grantee = 0 THEN 'PUBLIC'
				ELSE grantee_role.rolname
			END AS grantee,
			acl_row.privilege_type,
			acl_row.is_grantable AS grantable
		FROM pg_class AS relation
		JOIN pg_namespace AS namespace
		  ON namespace.oid = relation.relnamespace
		CROSS JOIN LATERAL aclexplode(
			COALESCE(relation.relacl, acldefault('r', relation.relowner))
		) AS acl_row
		JOIN pg_roles AS grantor_role
		  ON grantor_role.oid = acl_row.grantor
		LEFT JOIN pg_roles AS grantee_role
		  ON grantee_role.oid = acl_row.grantee
		WHERE namespace.nspname = 'public'
		  AND relation.relname = ${relationName}
		ORDER BY
			convert_to(
				CASE
					WHEN acl_row.grantee = 0 THEN 'PUBLIC'
					ELSE grantee_role.rolname
				END,
				'UTF8'
			),
			convert_to(grantor_role.rolname, 'UTF8'),
			convert_to(acl_row.privilege_type, 'UTF8'),
			acl_row.is_grantable
	`.execute(db);
	const relation: RelationCatalog = {
		...relationRow,
		acl: acl.rows,
	};

	const columns = await sql<ColumnCatalog>`
		SELECT
			attribute.attnum::integer AS ordinal,
			attribute.attname AS name,
			format_type(attribute.atttypid, attribute.atttypmod) AS data_type,
			attribute.attnotnull AS not_null,
			pg_get_expr(default_value.adbin, default_value.adrelid)
				AS default_expression
		FROM pg_attribute AS attribute
		JOIN pg_class AS relation ON relation.oid = attribute.attrelid
		JOIN pg_namespace AS namespace
		  ON namespace.oid = relation.relnamespace
		LEFT JOIN pg_attrdef AS default_value
		  ON default_value.adrelid = attribute.attrelid
		 AND default_value.adnum = attribute.attnum
		WHERE namespace.nspname = 'public'
		  AND relation.relname = ${relationName}
		  AND attribute.attnum > 0
		  AND NOT attribute.attisdropped
		ORDER BY attribute.attnum
	`.execute(db);

	const constraints = await sql<ConstraintCatalog>`
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
		WHERE local_namespace.nspname = 'public'
		  AND local_relation.relname = ${relationName}
		ORDER BY
			convert_to(constraint_row.conname, 'UTF8'),
			convert_to(
				pg_get_constraintdef(constraint_row.oid, true),
				'UTF8'
			)
	`.execute(db);

	const indexes = await sql<IndexCatalog>`
		SELECT
			index_relation.relname AS name,
			index_owner.rolname AS owner_name,
			COALESCE(to_jsonb(index_relation.relacl)::text, 'null') AS raw_acl,
			access_method.amname AS access_method,
			index_row.indisunique AS unique,
			index_row.indisprimary AS primary,
			index_row.indisvalid AS valid,
			index_row.indisready AS ready,
			index_row.indislive AS live,
			pg_get_indexdef(index_row.indexrelid) AS definition
		FROM pg_index AS index_row
		JOIN pg_class AS table_relation
		  ON table_relation.oid = index_row.indrelid
		JOIN pg_namespace AS table_namespace
		  ON table_namespace.oid = table_relation.relnamespace
		JOIN pg_class AS index_relation
		  ON index_relation.oid = index_row.indexrelid
		JOIN pg_roles AS index_owner
		  ON index_owner.oid = index_relation.relowner
		JOIN pg_am AS access_method
		  ON access_method.oid = index_relation.relam
		WHERE table_namespace.nspname = 'public'
		  AND table_relation.relname = ${relationName}
		ORDER BY convert_to(index_relation.relname, 'UTF8')
	`.execute(db);

	const triggers = await sql<{ definition: string }>`
		SELECT pg_get_triggerdef(trigger_row.oid, true) AS definition
		FROM pg_trigger AS trigger_row
		JOIN pg_class AS relation ON relation.oid = trigger_row.tgrelid
		JOIN pg_namespace AS namespace
		  ON namespace.oid = relation.relnamespace
		WHERE namespace.nspname = 'public'
		  AND relation.relname = ${relationName}
		  AND NOT trigger_row.tgisinternal
		ORDER BY
			convert_to(trigger_row.tgname, 'UTF8'),
			convert_to(pg_get_triggerdef(trigger_row.oid, true), 'UTF8')
	`.execute(db);

	return {
		relation,
		columns: columns.rows,
		constraints: constraints.rows,
		indexes: indexes.rows,
		triggers: triggers.rows.map((row) => row.definition),
	};
}

async function readDataCatalog(
	db: Kysely<unknown>,
	deletionExists: boolean,
	canReadLegacySequences: boolean,
	canReadFinalSequences: boolean,
	canReadDeletionRows: boolean,
): Promise<CaseSchemaDataCatalog> {
	const schemaRows = await sql<{ row_count: string }>`
		SELECT count(*)::text AS row_count
		FROM public.case_type_schemas
	`.execute(db);
	const schemaRow = schemaRows.rows[0];
	if (schemaRow === undefined) {
		throw new Error("Could not classify case_type_schemas rows.");
	}
	const invalidLegacyRows = canReadLegacySequences
		? ((
				await sql<{ invalid_legacy_rows: string }>`
					SELECT count(*) FILTER (WHERE synced_seq < 0)::text
						AS invalid_legacy_rows
					FROM public.case_type_schemas
				`.execute(db)
			).rows[0]?.invalid_legacy_rows ?? "1")
		: "1";
	const invalidFinalRows = canReadFinalSequences
		? ((
				await sql<{ invalid_final_rows: string }>`
					SELECT count(*)::text AS invalid_final_rows
					FROM public.case_type_schemas
					WHERE synced_seq < 0
					   OR index_synced_seq < 0
					   OR index_synced_seq > synced_seq
					   OR (
							index_pending_seq IS NULL
							AND index_synced_seq <> synced_seq
					   )
					   OR (
							index_pending_seq IS NOT NULL
							AND (
								index_pending_seq <> synced_seq
								OR index_pending_seq < index_synced_seq
							)
					   )
				`.execute(db)
			).rows[0]?.invalid_final_rows ?? "1")
		: "1";
	if (!deletionExists) {
		return {
			row_count: schemaRow.row_count,
			invalid_legacy_rows: invalidLegacyRows,
			invalid_final_rows: invalidFinalRows,
			deletion_row_count: "0",
			invalid_deletion_rows: "0",
			overlapping_rows: "0",
		};
	}
	if (!canReadDeletionRows) {
		const deletionCount = await sql<{ deletion_row_count: string }>`
			SELECT count(*)::text AS deletion_row_count
			FROM public.case_schema_index_deletions
		`.execute(db);
		return {
			row_count: schemaRow.row_count,
			invalid_legacy_rows: invalidLegacyRows,
			invalid_final_rows: invalidFinalRows,
			deletion_row_count:
				deletionCount.rows[0]?.deletion_row_count ?? "unknown",
			invalid_deletion_rows: "1",
			overlapping_rows: "1",
		};
	}
	const deletionRows = await sql<{
		deletion_row_count: string;
		invalid_deletion_rows: string;
		overlapping_rows: string;
	}>`
		SELECT
			(SELECT count(*)::text
			 FROM public.case_schema_index_deletions) AS deletion_row_count,
			(SELECT count(*)::text
			 FROM public.case_schema_index_deletions
			 WHERE btrim(app_id) = '' OR btrim(case_type) = '')
				AS invalid_deletion_rows,
			(SELECT count(*)::text
			 FROM public.case_schema_index_deletions AS deletion
			 JOIN public.case_type_schemas AS schema_row
			   USING (app_id, case_type)) AS overlapping_rows
	`.execute(db);
	const deletionRow = deletionRows.rows[0];
	if (deletionRow === undefined) {
		throw new Error("Could not classify case_schema_index_deletions rows.");
	}
	return {
		row_count: schemaRow.row_count,
		invalid_legacy_rows: invalidLegacyRows,
		invalid_final_rows: invalidFinalRows,
		...deletionRow,
	};
}

function hasReadableColumn(
	table: TableCatalog,
	name: string,
	dataType: string,
): boolean {
	const matches = table.columns.filter(
		(column) => column.name === name && column.data_type === dataType,
	);
	return matches.length === 1;
}

async function readCatalogAuthority(
	db: Kysely<unknown>,
): Promise<CatalogAuthority> {
	const result = await sql<{ current_role: string }>`
		SELECT current_user AS current_role
	`.execute(db);
	const currentRole = result.rows[0]?.current_role;
	if (currentRole === undefined) {
		throw new Error(
			"Case-schema index convergence blocked: current database role is unavailable.",
		);
	}
	const privilegeRoles = readPrivilegeRoleConfig();
	if (
		privilegeRoles !== null &&
		privilegeRoles.migration_role !== currentRole
	) {
		throw new Error(
			"Case-schema index convergence blocked: current database role is not the configured migration owner.",
		);
	}
	return {
		current_role: currentRole,
		privilege_roles: privilegeRoles,
	};
}

async function captureCutoverCatalog(
	db: Kysely<unknown>,
	deletionExists: boolean,
): Promise<CutoverCatalog> {
	const authority = await readCatalogAuthority(db);
	const caseSchema = await readTableCatalog(db, CASE_SCHEMA_TABLE);
	const deletion = deletionExists
		? await readTableCatalog(db, DELETION_TABLE)
		: null;
	const canReadLegacySequences = hasReadableColumn(
		caseSchema,
		"synced_seq",
		"bigint",
	);
	const canReadFinalSequences =
		canReadLegacySequences &&
		hasReadableColumn(caseSchema, "index_pending_seq", "bigint") &&
		hasReadableColumn(caseSchema, "index_synced_seq", "bigint");
	const canReadDeletionRows =
		deletion !== null &&
		hasReadableColumn(caseSchema, "app_id", "text") &&
		hasReadableColumn(caseSchema, "case_type", "text") &&
		hasReadableColumn(deletion, "app_id", "text") &&
		hasReadableColumn(deletion, "case_type", "text");
	return {
		case_schema: caseSchema,
		deletion,
		authority,
		data: await readDataCatalog(
			db,
			deletionExists,
			canReadLegacySequences,
			canReadFinalSequences,
			canReadDeletionRows,
		),
	};
}

function isLegacyCatalog(catalog: CutoverCatalog): boolean {
	const relation = catalog.case_schema.relation;
	const ownerName = catalog.authority.current_role;
	return (
		catalog.deletion === null &&
		isExpectedApplicationAcl(relation, catalog.authority) &&
		assertExactTable(catalog.case_schema, {
			relation: expectedRelation(
				CASE_SCHEMA_TABLE,
				ownerName,
				relation.raw_acl,
				relation.acl,
			),
			columns: LEGACY_COLUMNS,
			constraints: LEGACY_CASE_SCHEMA_CONSTRAINTS,
			indexes: expectedCaseSchemaIndexes(ownerName),
		}) &&
		catalog.data.invalid_legacy_rows === "0"
	);
}

function isFinalCatalog(catalog: CutoverCatalog): boolean {
	const relation = catalog.case_schema.relation;
	const ownerName = catalog.authority.current_role;
	return (
		catalog.deletion !== null &&
		isExpectedApplicationAcl(relation, catalog.authority) &&
		assertExactTable(catalog.case_schema, {
			relation: expectedRelation(
				CASE_SCHEMA_TABLE,
				ownerName,
				relation.raw_acl,
				relation.acl,
			),
			columns: FINAL_COLUMNS,
			constraints: FINAL_CASE_SCHEMA_CONSTRAINTS,
			indexes: expectedCaseSchemaIndexes(ownerName),
		}) &&
		assertExactTable(catalog.deletion, {
			relation: expectedRelation(
				DELETION_TABLE,
				ownerName,
				relation.raw_acl,
				relation.acl,
			),
			columns: DELETION_COLUMNS,
			constraints: DELETION_CONSTRAINTS,
			indexes: expectedDeletionIndexes(ownerName),
		}) &&
		catalog.data.invalid_final_rows === "0" &&
		catalog.data.invalid_deletion_rows === "0" &&
		catalog.data.overlapping_rows === "0"
	);
}

async function copyExactConvergedApplicationAcl(
	db: Kysely<unknown>,
	catalog: CutoverCatalog,
): Promise<void> {
	const expected = convergedApplicationAcl(catalog.authority);
	if (
		expected === null ||
		!exactJson(catalog.case_schema.relation.acl, expected)
	) {
		return;
	}
	const config = catalog.authority.privilege_roles;
	if (config === null) {
		throw new Error(
			"Case-schema index convergence blocked: converged ACL has no configured role authority.",
		);
	}
	await sql`
		GRANT SELECT, INSERT, UPDATE, DELETE
		ON TABLE public.case_schema_index_deletions
		TO ${sql.id(config.runtime_role)}
	`.execute(db);
	await sql`
		GRANT SELECT
		ON TABLE public.case_schema_index_deletions
		TO ${sql.id(config.audit_role)}
	`.execute(db);
}

async function runLockedCutover(db: Kysely<unknown>): Promise<void> {
	await sql`
		SELECT pg_advisory_xact_lock(
			hashtextextended('nova:case-schema-index-convergence-cutover', 0)
		)
	`.execute(db);
	if (!(await relationExists(db, CASE_SCHEMA_TABLE))) {
		throw new Error(
			"Case-schema index convergence blocked: public.case_type_schemas is absent.",
		);
	}
	await sql`
		LOCK TABLE public.case_type_schemas IN ACCESS EXCLUSIVE MODE
	`.execute(db);
	const deletionExists = await relationExists(db, DELETION_TABLE);
	if (deletionExists) {
		await sql`
			LOCK TABLE public.case_schema_index_deletions
			IN ACCESS EXCLUSIVE MODE
		`.execute(db);
	}

	const before = await captureCutoverCatalog(db, deletionExists);
	if (isFinalCatalog(before)) {
		return;
	}
	if (!isLegacyCatalog(before)) {
		const relation = before.case_schema.relation;
		const ownerName = before.authority.current_role;
		const evidence = {
			aclExpected: isExpectedApplicationAcl(relation, before.authority),
			relationExact: exactJson(
				relation,
				expectedRelation(
					CASE_SCHEMA_TABLE,
					ownerName,
					relation.raw_acl,
					relation.acl,
				),
			),
			columnsExact: exactJson(before.case_schema.columns, LEGACY_COLUMNS),
			constraintsExact: exactJson(
				before.case_schema.constraints,
				LEGACY_CASE_SCHEMA_CONSTRAINTS,
			),
			indexesExact: exactJson(
				before.case_schema.indexes,
				expectedCaseSchemaIndexes(ownerName),
			),
			relation: catalogDigest(before.case_schema.relation),
			columns: catalogDigest(before.case_schema.columns),
			constraints: catalogDigest(before.case_schema.constraints),
			indexes: catalogDigest(before.case_schema.indexes),
			triggers: catalogDigest(before.case_schema.triggers),
			authority: catalogDigest(before.authority),
			data: catalogDigest(before.data),
		};
		throw new Error(
			`Case-schema index convergence blocked: catalog or data is partial or drifted (${catalogDigest(before)}; ${JSON.stringify(evidence)}).`,
		);
	}

	// Plain final DDL is safe only after the complete legacy classification.
	await sql`
		ALTER TABLE public.case_type_schemas
			ADD COLUMN index_pending_seq bigint,
			ADD COLUMN index_synced_seq bigint NOT NULL DEFAULT 0
	`.execute(db);
	await sql`
		CREATE TABLE public.case_schema_index_deletions (
			app_id text NOT NULL,
			case_type text NOT NULL,
			PRIMARY KEY (app_id, case_type)
		)
	`.execute(db);
	await copyExactConvergedApplicationAcl(db, before);
	await sql`
		UPDATE public.case_type_schemas
		SET index_pending_seq = synced_seq
	`.execute(db);

	const after = await captureCutoverCatalog(db, true);
	if (!isFinalCatalog(after)) {
		throw new Error(
			`Case-schema index convergence failed its final catalog/data proof (${catalogDigest(after)}).`,
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
		"Case-schema index convergence is forward-only; restore the authoritative pre-cutover backup instead.",
	);
}
