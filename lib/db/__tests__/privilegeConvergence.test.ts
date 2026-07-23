import { describe, expect, test } from "vitest";
import {
	assertDatabaseRolePolicy,
	auditPublicTableInventory,
	classifyPublicTable,
	type DatabasePrivilegeRoleConfig,
	type DatabaseRoleFact,
	REQUIRED_PUBLIC_TABLES,
	readDatabasePrivilegeRoleConfig,
} from "../privilegeConvergence";

const config: DatabasePrivilegeRoleConfig = {
	migrationRole: "nova-migrate@commcare-nova.iam",
	runtimeRole: "nova-runtime@commcare-nova.iam",
	rolloutRole: "nova-rollout@commcare-nova.iam",
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
	runtimeCanUseRollout: false,
	rolloutCanUseMigration: false,
	rolloutCanUseRuntime: false,
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
				NOVA_ROLLOUT_DB_USER: config.rolloutRole,
			}),
		).toEqual(config);
	});

	test("classifies every migrated table and rejects unknown or missing tables", () => {
		const audited = auditPublicTableInventory([
			...REQUIRED_PUBLIC_TABLES,
			"atlas_schema_revisions",
		]);
		expect(audited).toContainEqual({
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
			auditPublicTableInventory(
				REQUIRED_PUBLIC_TABLES.filter((name) => name !== "auth_member"),
			),
		).toThrowError(expect.objectContaining({ code: "schema_inventory_drift" }));
	});

	test("requires non-administrative, non-inheriting serving roles", () => {
		const roles = [
			role(config.migrationRole),
			role(config.runtimeRole),
			role(config.rolloutRole),
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
			assertDatabaseRolePolicy(config, roles, {
				...safeMembership,
				rolloutCanUseRuntime: true,
			}),
		).toThrowError(expect.objectContaining({ code: "role_policy_invalid" }));
	});
});
