import { randomUUID } from "node:crypto";
import { sql, type Transaction } from "kysely";
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import {
	type AppTestCaseStore,
	appTestNamespace,
	withAppTestNamespace,
} from "../appTestNamespace";
import * as disposalConstraints from "../migrations/20260930020000_app_test_disposal_constraints";
import { setupPerTestDatabase } from "../sql/__tests__/perTestDatabase";
import type { Database } from "../sql/database";

const fixture = setupPerTestDatabase({
	schema: "migrated",
	databaseNamePrefix: "app_test_isolation_",
});
const appId = "test-app";
const actorUserId = "real-author";
const ownerId = "preview-worker";
const projectId = "test-project";
const blueprintSeq = 7;

async function createNamespace() {
	const testId = randomUUID();
	await sql`SELECT nova_create_app_test_namespace(${testId}::uuid)`.execute(
		fixture.db,
	);
	await fixture.db.transaction().execute(async (tx) => {
		await withAppTestNamespace(
			tx as Transaction<Database>,
			{ testId, appId, actorUserId, ownerId, projectId, blueprintSeq },
			async (_store, isolated) => {
				await sql`INSERT INTO apps (id, owner, project_id, app_name, app_name_lower, mutation_seq)
				VALUES (${appId}, ${actorUserId}, ${projectId}, 'Test app', 'test app', ${blueprintSeq})`.execute(
					isolated,
				);
				await isolated
					.insertInto("case_type_schemas")
					.values({
						app_id: appId,
						case_type: "equipment",
						synced_seq: blueprintSeq,
						schema: JSON.stringify({
							type: "object",
							properties: { inspection: { type: "string" } },
							additionalProperties: false,
						}),
					})
					.execute();
			},
		);
	});
	return testId;
}

function run<T>(
	testId: string,
	body: Parameters<typeof withAppTestNamespace<T>>[2],
) {
	return fixture.db
		.transaction()
		.execute((tx) =>
			withAppTestNamespace(
				tx as Transaction<Database>,
				{ testId, appId, actorUserId, ownerId, projectId, blueprintSeq },
				body,
			),
		);
}

const receipt = {
	entryKey: "inspection-entry",
	formUuid: testUuid("11111111-1111-4111-8111-111111111111"),
	expectedAppMutationSeq: blueprintSeq,
	blueprintDigest: "a".repeat(64),
	requestDigest: "inspection-answers",
};

async function seed(testId: string) {
	await run(testId, async (store) =>
		store.insert({
			appId,
			row: {
				case_id: "same-authored-id",
				case_type: "equipment",
				case_name: "Pump",
				status: "open",
				properties: { inspection: "due" },
			},
		}),
	);
}

describe("isolated app-test submissions", () => {
	it("migrates disposal across pending case constraints while preserving its definer privileges and unrelated deferred work", async () => {
		const definition = () =>
			sql<{
				owner: number;
				acl: string[] | null;
				secure: boolean;
				config: string[];
			}>`
			SELECT proowner AS owner, proacl::text[] AS acl, prosecdef AS secure, proconfig AS config
			FROM pg_proc WHERE oid = 'public.nova_drop_app_test_namespace(uuid)'::regprocedure
		`.execute(fixture.db);
		const original = (await definition()).rows;
		expect(original).toEqual([
			expect.objectContaining({
				secure: true,
				config: ["search_path=pg_catalog"],
			}),
		]);
		await disposalConstraints.down(fixture.db);
		const testId = await createNamespace();
		const otherId = await createNamespace();
		const insert = (store: AppTestCaseStore) =>
			store.insert({
				appId,
				row: {
					case_id: "pending",
					case_type: "equipment",
					case_name: "Pump",
					status: "open",
					properties: {},
				},
			});
		await expect(
			run(testId, async (store, tx) => {
				await insert(store);
				await sql`SELECT public.nova_drop_app_test_namespace(${testId}::uuid)`.execute(
					tx,
				);
			}),
		).rejects.toThrow(
			'cannot DROP TABLE "cases" because it has pending trigger events',
		);
		await disposalConstraints.up(fixture.db);
		expect((await definition()).rows).toEqual(original);
		// The clone was created before the migration. An unusual existing name
		// proves the flush quotes identifiers rather than interpreting SQL text.
		await sql`ALTER TABLE ${sql.id(appTestNamespace(testId), "cases")} RENAME CONSTRAINT cases_project_app_tenant_fk TO ${sql.id('Case "tenant"; boundary')}`.execute(
			fixture.db,
		);
		await sql`CREATE TABLE public.disposal_parent(id integer PRIMARY KEY)`.execute(
			fixture.db,
		);
		await sql`CREATE TABLE public.disposal_child(parent_id integer REFERENCES public.disposal_parent(id) DEFERRABLE INITIALLY DEFERRED)`.execute(
			fixture.db,
		);
		await run(testId, async (store, tx) => {
			await insert(store);
			await sql`INSERT INTO public.disposal_child VALUES (1)`.execute(tx);
			await withAppTestNamespace(
				tx,
				{
					testId: otherId,
					appId,
					actorUserId,
					ownerId,
					projectId,
					blueprintSeq,
				},
				async (other) => insert(other),
			);
			await sql`UPDATE ${sql.id(appTestNamespace(otherId), "cases")} SET project_id = 'not-yet-valid'`.execute(
				tx,
			);
			await sql`SELECT public.nova_drop_app_test_namespace(${testId}::uuid)`.execute(
				tx,
			);
			// A global SET CONSTRAINTS ALL would fail on the public table and
			// other namespace before their enclosing transaction can repair them.
			await sql`UPDATE ${sql.id(appTestNamespace(otherId), "cases")} SET project_id = ${projectId}`.execute(
				tx,
			);
			await sql`INSERT INTO public.disposal_parent VALUES (1)`.execute(tx);
		});
		expect(
			(
				await sql`SELECT 1 FROM pg_namespace WHERE nspname = ${appTestNamespace(testId)}`.execute(
					fixture.db,
				)
			).rows,
		).toEqual([]);
		expect(
			await run(otherId, async (_store, tx) =>
				tx.selectFrom("cases").select("case_id").execute(),
			),
		).toEqual([{ case_id: "pending" }]);
		await sql`SELECT public.nova_drop_app_test_namespace(${testId}::uuid)`.execute(
			fixture.db,
		);
		const emptyId = randomUUID();
		await sql`CREATE SCHEMA ${sql.id(appTestNamespace(emptyId))}`.execute(
			fixture.db,
		);
		await sql`SELECT public.nova_drop_app_test_namespace(${emptyId}::uuid)`.execute(
			fixture.db,
		);
	});

	it("refuses disposal when deferred case tenancy is invalid and rolls back the pending row and receipt", async () => {
		const testId = await createNamespace();
		await expect(
			run(testId, async (store, tx) => {
				await store.applySubmission({
					appId,
					submissionReceipt: receipt,
					ordinary: {
						kind: "registration",
						primary: {
							caseType: "equipment",
							caseName: "Pump",
							properties: {},
						},
						children: [],
					},
				});
				await sql`UPDATE cases SET project_id = 'invalid-project'`.execute(tx);
				await sql`SELECT public.nova_drop_app_test_namespace(${testId}::uuid)`.execute(
					tx,
				);
			}),
		).rejects.toThrow(
			'violates foreign key constraint "cases_project_app_tenant_fk"',
		);
		await run(testId, async (_store, tx) => {
			expect(await tx.selectFrom("cases").selectAll().execute()).toEqual([]);
			expect(
				await tx.selectFrom("form_submission_intents").selectAll().execute(),
			).toEqual([]);
		});
	});

	it("refuses an old clone after the production column contract changes", async () => {
		const testId = await createNamespace();
		await sql`ALTER TABLE public.form_submission_intents ADD COLUMN deployment_marker text`.execute(
			fixture.db,
		);
		await expect(run(testId, async () => true)).rejects.toThrow(
			"record storage changed",
		);
	});
	it("keeps identical case identities separate and persists a retryable close through the real submission and restore path", async () => {
		const first = await createNamespace();
		const second = await createNamespace();
		await seed(first);
		await seed(second);
		const close = {
			appId,
			submissionReceipt: receipt,
			ordinary: {
				kind: "close" as const,
				caseIds: ["same-authored-id"],
				caseType: "equipment",
				selection: { kind: "single" as const, maximum: 1 as const },
				patch: { properties: { inspection: "retired" } },
				children: [],
			},
		};
		const result = await run(first, (store) => store.applySubmission(close));
		expect(result.caseDatabasePatch?.rows).toEqual([
			expect.objectContaining({
				case_id: "same-authored-id",
				status: "closed",
				owner_id: ownerId,
				properties: { inspection: "retired" },
			}),
		]);
		expect(await run(first, (store) => store.applySubmission(close))).toEqual(
			result,
		);
		const restored = (testId: string) =>
			run(testId, (store) =>
				store.readDeviceCaseDatabase({
					appId,
					restoreScope: { ownerIds: [ownerId] },
				}),
			);
		expect((await restored(first)).rows).toEqual([]);
		expect((await restored(second)).rows).toEqual([
			expect.objectContaining({
				status: "open",
				properties: { inspection: "due" },
			}),
		]);
		const live = await sql<{
			count: string;
		}>`SELECT count(*)::text AS count FROM cases WHERE app_id = ${appId}`.execute(
			fixture.db,
		);
		expect(live.rows[0].count).toBe("0");
	});

	it("rolls back successful case effects and the submission receipt when the enclosing test step fails", async () => {
		const testId = await createNamespace();
		const submission = {
			appId,
			submissionReceipt: receipt,
			ordinary: {
				kind: "registration" as const,
				primary: {
					caseType: "equipment",
					caseName: "New pump",
					properties: {},
				},
				children: [],
			},
		};
		await expect(
			run(testId, async (store) => {
				await store.applySubmission(submission);
				throw new Error("step evidence failed");
			}),
		).rejects.toThrow("step evidence failed");
		await run(testId, async (_store, tx) => {
			expect(await tx.selectFrom("cases").selectAll().execute()).toEqual([]);
			expect(
				await tx.selectFrom("form_submission_intents").selectAll().execute(),
			).toEqual([]);
		});
		const retry = await run(testId, (store) =>
			store.applySubmission(submission),
		);
		expect(retry.primaryCaseIds).toHaveLength(1);
	});

	it("refuses a missing isolated table instead of falling through to live data, and restores the connection path", async () => {
		const testId = await createNamespace();
		await sql`DROP TABLE ${sql.id(appTestNamespace(testId), "form_submission_intents")}`.execute(
			fixture.db,
		);
		let entered = false;
		await expect(
			run(testId, async () => {
				entered = true;
			}),
		).rejects.toThrow("Start a new test");
		expect(entered).toBe(false);
		const path = await sql<{
			schema: string;
		}>`SELECT current_schema() AS schema`.execute(fixture.db);
		expect(path.rows[0].schema).toBe("public");
		await sql`SELECT nova_drop_app_test_namespace(${testId}::uuid)`.execute(
			fixture.db,
		);
		const namespace = await sql<{
			name: string;
		}>`SELECT nspname AS name FROM pg_namespace WHERE nspname = ${appTestNamespace(testId)}`.execute(
			fixture.db,
		);
		expect(namespace.rows).toEqual([]);
	});
});
