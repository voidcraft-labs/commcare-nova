import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { expect, test } from "vitest";
import { setupPerTestDatabase } from "@/lib/case-store/sql/__tests__/perTestDatabase";
import {
	DATABASE_OWNER_BOOTSTRAP_CONFIG,
	inspectDatabaseOwnerBootstrap,
	quoteIdentifier as q,
} from "../databaseOwnerBootstrap";

const h = setupPerTestDatabase({ databaseNamePrefix: "bootstrap_catalog_" });

test("inspection rejects extra application parents, including indirect access and audit grants, without changing ownership", async () => {
	const suffix = randomUUID().slice(0, 8);
	const config = {
		...DATABASE_OWNER_BOOTSTRAP_CONFIG,
		database: new URL(h.uri).pathname.slice(1),
		migrationRole: `migration_${suffix}`,
		runtimeRole: `runtime_${suffix}`,
		cleanupRole: `cleanup_${suffix}`,
		auditRole: `audit_${suffix}`,
		legacyRole: `absent_${suffix}`,
		requiredExtensions: [],
	};
	const admin = `bootstrap_${suffix}`;
	const bridge = `bridge_${suffix}`;
	const apps = [
		config.migrationRole,
		config.runtimeRole,
		config.cleanupRole,
		config.auditRole,
	];
	const created: string[] = [];
	const client = new Client({ connectionString: h.uri });
	await client.connect();
	try {
		for (const role of apps) {
			await client.query(`CREATE ROLE ${q(role)} LOGIN`);
			created.push(role);
		}
		await client.query(
			`CREATE ROLE ${q(admin)} NOLOGIN SUPERUSER CREATEDB CREATEROLE`,
		);
		created.push(admin);
		await client.query(`CREATE ROLE ${q(bridge)} NOLOGIN`);
		created.push(bridge);
		await client.query(
			`GRANT ${q(config.runtimeRole)} TO ${q(config.migrationRole)}, ${q(bridge)}`,
		);
		await client.query(`GRANT ${apps.map(q).join(", ")} TO ${q(admin)}`);
		await client.query(`SET ROLE ${q(admin)}`);
		const before = await inspectDatabaseOwnerBootstrap(client, config);
		expect(before.before.migrationCanSetRuntime).toBe(true);
		expect(before.before.unexpectedApplicationParents).toEqual([]);
		const problems: string[] = [];
		for (const [parent, member] of [
			[bridge, config.cleanupRole],
			[config.runtimeRole, config.auditRole],
			[config.auditRole, config.runtimeRole],
			[bridge, config.migrationRole],
		] as const) {
			await client.query(`GRANT ${q(parent)} TO ${q(member)}`);
			try {
				await inspectDatabaseOwnerBootstrap(client, config);
				problems.push(`${member} was allowed membership of ${parent}`);
			} catch (error) {
				expect(error).toBeInstanceOf(Error);
				expect((error as Error).message).toContain(
					"one-way migration-to-runtime grant",
				);
			} finally {
				await client.query(`REVOKE ${q(parent)} FROM ${q(member)}`);
			}
			// The inspection must close its transaction and leave the catalog intact.
			expect(
				(await inspectDatabaseOwnerBootstrap(client, config)).before,
			).toEqual(before.before);
		}
		expect(problems).toEqual([]);
	} finally {
		await client.query("RESET ROLE");
		for (const role of created.reverse())
			await client.query(`DROP ROLE ${q(role)}`);
		await client.end();
	}
});
