import { type Kysely, sql } from "kysely";
import { expect, it } from "vitest";
import { proseText } from "@/lib/domain/prose";
import { HeuristicCaseGenerator } from "../../sample/heuristic";
import { setupPerTestDatabase } from "../../sql/__tests__/perTestDatabase";
import type { Database } from "../../sql/database";
import { PostgresCaseStore } from "../store";

const database = setupPerTestDatabase({
	schema: "migrated",
	databaseNamePrefix: "case_index_concurrency_",
	poolMax: 4,
});

it("converges two apps' expression indexes when their builds overlap on the shared cases table", async () => {
	const db = database.db as unknown as Kysely<Database>;
	const appIds = ["index-left", "index-right"];
	for (const appId of appIds) {
		await sql`INSERT INTO apps (id, owner, project_id, app_name, app_name_lower) VALUES (${appId}, 'index-actor', 'index-project', ${appId}, ${appId})`.execute(
			db,
		);
	}
	const blocker = await database.pool.connect();
	let pending: Promise<PromiseSettledResult<unknown>[]> | undefined;
	try {
		await blocker.query("BEGIN");
		await blocker.query("LOCK TABLE cases IN SHARE UPDATE EXCLUSIVE MODE");
		pending = Promise.allSettled(
			appIds.map((appId) => {
				const store = new PostgresCaseStore({
					projectId: "index-project",
					actorUserId: "index-actor",
					ownerId: "index-actor",
					db,
					sampleGenerator: new HeuristicCaseGenerator(),
				});
				return store.applySchemaChange({
					appId,
					caseType: "patient",
					syncedSeq: 1,
					caseTypeSchemas: new Map([
						[
							"patient",
							{
								name: "patient",
								properties: [
									{
										name: "value",
										label: proseText("Value"),
										data_type: "int",
									},
								],
							},
						],
					]),
				});
			}),
		);
		await expect
			.poll(async () => {
				const result = await database.pool.query(
					"SELECT count(*)::integer AS count FROM pg_stat_activity WHERE datname = current_database() AND query LIKE 'CREATE INDEX CONCURRENTLY%' AND wait_event_type = 'Lock'",
				);
				return result.rows[0].count;
			})
			.toBeGreaterThan(0);
		// Both callers must reach their DDL boundary before releasing the table.
		// The old implementation queues two CREATEs; the coordinated one queues
		// one CREATE while the other caller waits outside a database statement.
		await expect
			.poll(async () => {
				const result = await database.pool.query(`
					SELECT count(*)::integer AS count FROM pg_stat_activity
					WHERE datname = current_database() AND pid <> pg_backend_pid()
					AND ((query LIKE 'CREATE INDEX CONCURRENTLY%' AND wait_event_type = 'Lock')
					OR query LIKE 'SELECT pg_try_advisory_lock%')
				`);
				return result.rows[0].count;
			})
			.toBe(2);
		await blocker.query("COMMIT");
		const results = await pending;
		expect(
			results.map((result) =>
				result.status === "fulfilled"
					? "fulfilled"
					: { message: result.reason.message, cause: result.reason.cause },
			),
		).toEqual(["fulfilled", "fulfilled"]);
		expect(
			await db
				.selectFrom("case_type_schemas")
				.select(["app_id", "index_synced_seq"])
				.orderBy("app_id")
				.execute(),
		).toEqual(appIds.map((app_id) => ({ app_id, index_synced_seq: "1" })));
		expect(
			await db
				.selectFrom("case_type_schemas")
				.select("app_id")
				.where("index_pending_seq", "is not", null)
				.execute(),
		).toEqual([]);
		expect(
			(
				await sql`SELECT indexrelid FROM pg_index WHERE indrelid = 'cases'::regclass AND NOT indisvalid`.execute(
					db,
				)
			).rows,
		).toEqual([]);
	} finally {
		try {
			await blocker.query("ROLLBACK");
			await pending;
		} finally {
			blocker.release();
		}
	}
});
