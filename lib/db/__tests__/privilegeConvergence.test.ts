import { describe, expect, test } from "vitest";
import {
	assertDatabaseRolePolicy,
	auditPublicTableInventory,
	auditRuntimeCaseTableInventory,
	classifyPublicTable,
	type DatabasePrivilegeRoleConfig,
	type DatabaseRoleFact,
	REQUIRED_PUBLIC_TABLES,
	readDatabasePrivilegeRoleConfig,
} from "../privilegeConvergence";

const config: DatabasePrivilegeRoleConfig = {
	migrationRole: "nova-migrate@commcare-nova.iam",
	runtimeRole: "nova-runtime@commcare-nova.iam",
};

function role(name: string, patch: Partial<DatabaseRoleFact> = {}) {
	return {
		name,
		superuser: false,
		createRole: false,
		createDatabase: false,
		bypassRls: false,
		...patch,
	};
}

const safeMembership = {
	currentCanUseMigration: true,
	migrationCanUseRuntime: true,
	runtimeCanUseMigration: false,
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
			}),
		).toEqual(config);
		expect(() =>
			readDatabasePrivilegeRoleConfig({
				NOVA_MIGRATION_DB_USER: config.runtimeRole,
				NOVA_RUNTIME_DB_USER: config.runtimeRole,
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
			name: "deployment_rollouts",
			classification: "control",
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

	test("requires non-administrative roles with one-way migration membership", () => {
		const roles = [role(config.migrationRole), role(config.runtimeRole)];
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
			assertDatabaseRolePolicy(config, roles, {
				...safeMembership,
				runtimeCanUseMigration: true,
			}),
		).toThrowError(expect.objectContaining({ code: "role_policy_invalid" }));
		expect(() =>
			assertDatabaseRolePolicy(config, roles, {
				...safeMembership,
				migrationCanUseRuntime: false,
			}),
		).toThrowError(expect.objectContaining({ code: "role_policy_invalid" }));
	});
});
