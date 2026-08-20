import { describe, expect, test } from "vitest";
import {
	AUDIT_SELECT_PUBLIC_TABLES,
	assertDatabaseRolePolicy,
	auditPublicTableInventory,
	auditRuntimeCaseTableInventory,
	classifyPublicTable,
	type DatabasePrivilegeRoleConfig,
	type DatabaseRoleFact,
	PUBLIC_TABLE_POLICIES,
	REQUIRED_PUBLIC_TABLES,
	readDatabasePrivilegeRoleConfig,
	runtimeTableCapability,
} from "../privilegeConvergence";

const config: DatabasePrivilegeRoleConfig = {
	migrationRole: "nova-migrate@commcare-nova.iam",
	runtimeRole: "nova-runtime@commcare-nova.iam",
	cleanupRole: "nova-capture-cleanup@commcare-nova.iam",
	auditRole: "nova-audit@commcare-nova.iam",
};

function role(name: string, patch: Partial<DatabaseRoleFact> = {}) {
	const connectionLimit =
		name === config.runtimeRole ? 16 : name === config.cleanupRole ? 3 : 1;
	return {
		name,
		superuser: false,
		createRole: false,
		createDatabase: false,
		bypassRls: false,
		canLogin: true,
		connectionLimit,
		...patch,
	};
}

const safeMembership = {
	currentCanUseMigration: true,
	migrationCanUseRuntime: true,
	migrationIsRuntimeMember: true,
	migrationCanSetRuntime: true,
	runtimeCanUseMigration: false,
	cleanupCanUseRuntime: false,
	auditCanUseRuntime: false,
	runtimeCanCreateDatabase: false,
	runtimeCanCreatePublicSchema: false,
	cleanupCanCreateDatabase: false,
	cleanupCanCreatePublicSchema: false,
	auditCanCreateDatabase: false,
	auditCanCreatePublicSchema: false,
	unexpectedMigrationParentRoles: [],
	unexpectedRuntimeParentRoles: [],
	unexpectedCleanupParentRoles: [],
	unexpectedAuditParentRoles: [],
};

describe("database privilege convergence contract", () => {
	test("skips only for an explicit local database and fails closed in production", () => {
		expect(
			readDatabasePrivilegeRoleConfig({
				NOVA_DB_LOCAL_URL: "postgres://local",
			}),
		).toBeNull();
		expect(() => readDatabasePrivilegeRoleConfig({})).toThrowError(
			expect.objectContaining({ code: "role_config_missing" }),
		);
		expect(() =>
			readDatabasePrivilegeRoleConfig({
				NOVA_MIGRATION_DB_USER: config.migrationRole,
			}),
		).toThrowError(expect.objectContaining({ code: "role_config_partial" }));
		expect(
			readDatabasePrivilegeRoleConfig({
				NOVA_MIGRATION_DB_USER: config.migrationRole,
				NOVA_RUNTIME_DB_USER: config.runtimeRole,
				NOVA_CAPTURE_CLEANUP_DB_USER: config.cleanupRole,
				NOVA_AUDIT_DB_USER: config.auditRole,
			}),
		).toEqual(config);
		expect(() =>
			readDatabasePrivilegeRoleConfig({
				NOVA_MIGRATION_DB_USER: config.runtimeRole,
				NOVA_RUNTIME_DB_USER: config.runtimeRole,
				NOVA_CAPTURE_CLEANUP_DB_USER: config.cleanupRole,
				NOVA_AUDIT_DB_USER: config.auditRole,
			}),
		).toThrowError(expect.objectContaining({ code: "role_config_invalid" }));
	});

	test("classifies every migrated table and rejects unknown or missing tables", () => {
		const audited = auditPublicTableInventory([
			...REQUIRED_PUBLIC_TABLES,
			"atlas_schema_revisions",
		]);
		expect(auditRuntimeCaseTableInventory(["cases"])).toContainEqual({
			name: "cases",
			classification: "application",
		});
		expect(audited).toContainEqual({
			name: "media_upload_aliases",
			classification: "application",
		});
		expect(audited).toContainEqual({
			name: "case_schema_index_deletions",
			classification: "application",
		});
		expect(audited).toContainEqual({
			name: "media_asset_refs",
			classification: "application",
		});
		expect(classifyPublicTable("atlas_schema_revisions")).toBe("migration");
		expect(() =>
			auditPublicTableInventory([
				...REQUIRED_PUBLIC_TABLES,
				"unclassified_table",
			]),
		).toThrowError(expect.objectContaining({ code: "schema_inventory_drift" }));
		expect(() =>
			auditPublicTableInventory([...REQUIRED_PUBLIC_TABLES, "cases"]),
		).toThrowError(expect.objectContaining({ code: "schema_inventory_drift" }));
		expect(() =>
			auditPublicTableInventory(
				REQUIRED_PUBLIC_TABLES.filter((name) => name !== "auth_member"),
			),
		).toThrowError(expect.objectContaining({ code: "schema_inventory_drift" }));
		expect(() => auditRuntimeCaseTableInventory([])).toThrowError(
			expect.objectContaining({ code: "schema_inventory_drift" }),
		);
		expect(() =>
			auditRuntimeCaseTableInventory(["cases", "runtime_shadow"]),
		).toThrowError(expect.objectContaining({ code: "schema_inventory_drift" }));
	});

	test("tells an unknown table apart from a missing one, and says the fix", () => {
		// This error runs in the migrate Cloud Run Job on every deploy and a
		// non-zero exit blocks the deploy, so whoever reads it is under
		// pressure and has usually just written a migration. The two causes
		// have opposite fixes — register the table, or run/restore the
		// migration — and a message that reported both counts on every
		// failure explained neither.
		const unknown = (() => {
			try {
				auditPublicTableInventory([...REQUIRED_PUBLIC_TABLES, "brand_new"]);
			} catch (err) {
				return (err as Error).message;
			}
			throw new Error("expected an unknown-table rejection");
		})();
		expect(unknown).toContain("brand_new");
		// Routes the reader to the registration site, not to their migration.
		expect(unknown).toContain("read-write");
		expect(unknown).toContain("row-lock and write-verb source guards");
		expect(unknown).toContain("lib/db/privilegeConvergence.ts");
		// And does not also lecture them about the cause that did not fire.
		expect(unknown).not.toContain("hasn't run against this database");

		const missing = (() => {
			try {
				auditPublicTableInventory(
					REQUIRED_PUBLIC_TABLES.filter((name) => name !== "apps"),
				);
			} catch (err) {
				return (err as Error).message;
			}
			throw new Error("expected a missing-table rejection");
		})();
		expect(missing).toContain("apps");
		expect(missing).toContain("hasn't run against this database");
		expect(missing).not.toContain("row-lock and write-verb source guards");
	});

	test("derives each table's exact runtime capability from one policy entry", () => {
		expect(
			new Set(PUBLIC_TABLE_POLICIES.map((policy) => policy.name)).size,
		).toBe(PUBLIC_TABLE_POLICIES.length);
		expect(runtimeTableCapability("apps")).toBe("read-write");
		expect(runtimeTableCapability("app_changes")).toBe("append-only");
		expect(runtimeTableCapability("design_identity_handles")).toBe(
			"insert-update",
		);
		expect(runtimeTableCapability("media_asset_refs")).toBe("insert-delete");
		expect(runtimeTableCapability("app_change_fold_baselines")).toBe(
			"read-only",
		);
		expect(runtimeTableCapability("kysely_migration")).toBe("none");
		expect(runtimeTableCapability("not_a_table")).toBeNull();
	});

	test("carries every migrated app-state table, so a deploy is not blocked", () => {
		// `convergeDatabasePrivileges` audits the live schema against this
		// inventory during the migrate Job, so a table that ships in a
		// migration without being registered here fails the BUILD — for every
		// unit, not just the one that added it. Local development skips role
		// convergence entirely, so nothing on the dev path catches it.
		expect(REQUIRED_PUBLIC_TABLES).toContain("form_attachments");
		expect(REQUIRED_PUBLIC_TABLES).toContain("form_attachment_rate_limits");
		expect(REQUIRED_PUBLIC_TABLES).toContain("form_submission_intents");
		expect(REQUIRED_PUBLIC_TABLES).toContain("case_schema_index_deletions");
		expect(AUDIT_SELECT_PUBLIC_TABLES).toContain("app_change_fold_baselines");
		expect(AUDIT_SELECT_PUBLIC_TABLES).toContain("lookup_column_references");
		expect(AUDIT_SELECT_PUBLIC_TABLES).toContain("run_summaries");
		expect(AUDIT_SELECT_PUBLIC_TABLES).not.toContain("credit_grants");
	});

	test("requires non-administrative roles with one-way migration membership", () => {
		const roles = [
			role(config.migrationRole),
			role(config.runtimeRole),
			role(config.cleanupRole),
			role(config.auditRole),
		];
		assertDatabaseRolePolicy(config, roles, safeMembership);
		expect(() =>
			assertDatabaseRolePolicy(
				config,
				roles.map((fact) =>
					fact.name === config.runtimeRole
						? { ...fact, bypassRls: true }
						: fact,
				),
				safeMembership,
			),
		).toThrowError(expect.objectContaining({ code: "role_policy_invalid" }));
		expect(() =>
			assertDatabaseRolePolicy(
				config,
				roles.map((fact) =>
					fact.name === config.auditRole
						? { ...fact, connectionLimit: -1 }
						: fact,
				),
				safeMembership,
			),
		).toThrowError(expect.objectContaining({ code: "role_policy_invalid" }));
		expect(() =>
			assertDatabaseRolePolicy(config, roles, {
				...safeMembership,
				runtimeCanUseMigration: true,
			}),
		).toThrowError(expect.objectContaining({ code: "role_policy_invalid" }));
		expect(() =>
			assertDatabaseRolePolicy(config, roles, {
				...safeMembership,
				cleanupCanUseRuntime: true,
			}),
		).toThrowError(expect.objectContaining({ code: "role_policy_invalid" }));
		expect(() =>
			assertDatabaseRolePolicy(config, roles, {
				...safeMembership,
				auditCanUseRuntime: true,
			}),
		).toThrowError(expect.objectContaining({ code: "role_policy_invalid" }));
		expect(() =>
			assertDatabaseRolePolicy(config, roles, {
				...safeMembership,
				migrationCanUseRuntime: false,
			}),
		).toThrowError(expect.objectContaining({ code: "role_policy_invalid" }));
		expect(() =>
			assertDatabaseRolePolicy(config, roles, {
				...safeMembership,
				migrationCanSetRuntime: false,
			}),
		).toThrowError(expect.objectContaining({ code: "role_policy_invalid" }));
		expect(() =>
			assertDatabaseRolePolicy(config, roles, {
				...safeMembership,
				runtimeCanCreateDatabase: true,
			}),
		).toThrowError(expect.objectContaining({ code: "role_policy_invalid" }));
		expect(() =>
			assertDatabaseRolePolicy(config, roles, {
				...safeMembership,
				runtimeCanCreatePublicSchema: true,
			}),
		).toThrowError(expect.objectContaining({ code: "role_policy_invalid" }));
		expect(() =>
			assertDatabaseRolePolicy(config, roles, {
				...safeMembership,
				unexpectedRuntimeParentRoles: ["legacy-owner"],
			}),
		).toThrowError(expect.objectContaining({ code: "role_policy_invalid" }));
		expect(() =>
			assertDatabaseRolePolicy(config, roles, {
				...safeMembership,
				unexpectedMigrationParentRoles: ["cluster-admin"],
			}),
		).toThrowError(expect.objectContaining({ code: "role_policy_invalid" }));
		expect(() =>
			assertDatabaseRolePolicy(config, roles, {
				...safeMembership,
				unexpectedCleanupParentRoles: ["runtime-owner"],
			}),
		).toThrowError(expect.objectContaining({ code: "role_policy_invalid" }));
		expect(() =>
			assertDatabaseRolePolicy(config, roles, {
				...safeMembership,
				unexpectedAuditParentRoles: ["runtime-owner"],
			}),
		).toThrowError(expect.objectContaining({ code: "role_policy_invalid" }));
	});
});
