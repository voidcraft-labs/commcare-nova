import { randomUUID } from "node:crypto";
import { type Kysely, sql, type Transaction } from "kysely";
import { Migrator } from "kysely/migration";
import { describe, expect, it } from "vitest";
import { appTestNamespace, withAppTestNamespace } from "../../appTestNamespace";
import { setupPerTestDatabase } from "../../sql/__tests__/perTestDatabase";
import type { Database } from "../../sql/database";
import { caseStoreMigrations } from "..";
import * as disposalConstraints from "../20260930020000_app_test_disposal_constraints";
import * as lookupDefinitions from "../20261004000000_app_test_lookup_definitions";

function predecessorDatabase(before: string) {
	return setupPerTestDatabase({
		databaseNamePrefix: "app_test_namespace_migration_",
		prepareTemplate: async (db) => {
			const result = await new Migrator({
				db,
				provider: {
					getMigrations: async () =>
						Object.fromEntries(
							Object.entries(caseStoreMigrations).filter(
								([name]) => name < before,
							),
						),
				},
			}).migrateToLatest();
			if (result.error !== undefined) throw result.error;
		},
	});
}

async function definition(db: Kysely<unknown>, routine: string) {
	return (
		await sql<{
			owner: number;
			acl: string[];
			secure: boolean;
			config: string[];
		}>`
		SELECT proowner AS owner, proacl::text[] AS acl, prosecdef AS secure, proconfig AS config
		FROM pg_proc WHERE oid = ${`public.${routine}(uuid)`}::regprocedure
	`.execute(db)
	).rows;
}

async function preserveAcl(db: Kysely<unknown>, routine: string) {
	// An actual nondefault ACL distinguishes CREATE OR REPLACE from a drop and
	// recreation with the same default owner and SECURITY DEFINER declaration.
	await sql`REVOKE ALL ON FUNCTION ${sql.id("public", routine)}(uuid) FROM PUBLIC`.execute(
		db,
	);
	await sql`GRANT EXECUTE ON FUNCTION ${sql.id("public", routine)}(uuid) TO pg_read_all_data`.execute(
		db,
	);
	const original = await definition(db, routine);
	expect(original).toEqual([
		expect.objectContaining({
			secure: true,
			config: ["search_path=pg_catalog"],
			acl: expect.arrayContaining([
				expect.stringMatching(/^pg_read_all_data=X\//),
			]),
		}),
	]);
	return original;
}

async function createNamespace(db: Kysely<unknown>) {
	const testId = randomUUID();
	await sql`SELECT public.nova_create_app_test_namespace(${testId}::uuid)`.execute(
		db,
	);
	return testId;
}

describe("app-test lookup definition migration at its predecessor schema", () => {
	const fixture = predecessorDatabase(
		"20261004000000_app_test_lookup_definitions",
	);
	it("preserves definer privileges, refuses an older namespace, and confines the new lookup foreign key", async () => {
		const routine = "nova_create_app_test_namespace";
		const original = await preserveAcl(fixture.db, routine);
		const oldId = await createNamespace(fixture.db);
		await fixture.db.transaction().execute(lookupDefinitions.up);
		expect(await definition(fixture.db, routine)).toEqual(original);
		const run = <T>(
			testId: string,
			body: Parameters<typeof withAppTestNamespace<T>>[2],
		) =>
			fixture.db.transaction().execute((tx) =>
				withAppTestNamespace(
					tx as Transaction<Database>,
					{
						testId,
						appId: "migration-app",
						actorUserId: "author",
						ownerId: "worker",
						projectId: "project",
						blueprintSeq: 0,
					},
					body,
				),
			);
		let entered = false;
		await expect(
			run(oldId, async () => {
				entered = true;
			}),
		).rejects.toThrow("Start a new test");
		expect(entered).toBe(false);
		const newId = await createNamespace(fixture.db);
		await run(newId, async (_store, tx) => {
			expect(
				await tx.selectFrom("lookup_tables").selectAll().execute(),
			).toEqual([]);
			const foreignKeys = await sql<{ target: string }>`
				SELECT n.nspname AS target FROM pg_constraint c
				JOIN pg_class r ON r.oid = c.confrelid JOIN pg_namespace n ON n.oid = r.relnamespace
				WHERE c.conrelid = ${`${appTestNamespace(newId)}.lookup_rows`}::regclass AND c.contype = 'f'
			`.execute(tx);
			expect(foreignKeys.rows).toEqual([{ target: appTestNamespace(newId) }]);
		});
	});
});

describe("app-test disposal migration at its predecessor schema", () => {
	const fixture = predecessorDatabase(
		"20260930020000_app_test_disposal_constraints",
	);
	it("repairs pending deferred constraint disposal without changing definer privileges", async () => {
		const routine = "nova_drop_app_test_namespace";
		const original = await preserveAcl(fixture.db, routine);
		const testId = await createNamespace(fixture.db);
		const namespace = appTestNamespace(testId);
		await sql`INSERT INTO ${sql.id(namespace, "apps")} (id, owner, project_id, app_name, app_name_lower)
			VALUES ('app', 'author', 'project', 'Migration', 'migration')`.execute(
			fixture.db,
		);
		const insertAndDrop = async (tx: Transaction<unknown>) => {
			await sql`INSERT INTO ${sql.id(namespace, "cases")} (case_id, app_id, project_id, case_type, case_name, owner_id, status, properties)
				VALUES ('pending', 'app', 'project', 'equipment', 'Pump', 'worker', 'open', '{}'::jsonb)`.execute(
				tx,
			);
			await sql`SELECT public.nova_drop_app_test_namespace(${testId}::uuid)`.execute(
				tx,
			);
		};
		await expect(
			fixture.db.transaction().execute(insertAndDrop),
		).rejects.toThrow(
			'cannot DROP TABLE "cases" because it has pending trigger events',
		);
		await fixture.db.transaction().execute(disposalConstraints.up);
		expect(await definition(fixture.db, routine)).toEqual(original);
		await fixture.db.transaction().execute(insertAndDrop);
		expect(
			(
				await sql`SELECT 1 FROM pg_namespace WHERE nspname = ${namespace}`.execute(
					fixture.db,
				)
			).rows,
		).toEqual([]);
	});
});
