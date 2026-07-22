import { type Kysely, sql } from "kysely";
import { beforeEach, describe, expect, test } from "vitest";
import { runCaseStoreMigrations } from "@/lib/case-store/migrate";
import { setupPerTestDatabase } from "@/lib/case-store/sql/__tests__/perTestDatabase";
import {
	DEPLOYMENT_CUTOVER_GATE_KEY,
	DEPLOYMENT_CUTOVER_GATE_NAMESPACE,
} from "@/lib/db/deploymentCutoverGate";
import {
	type AppDatabase,
	RUNTIME_READER_VERSION_GUC,
	setTransactionRuntimeReaderVersion,
} from "@/lib/db/pg";

const h = setupPerTestDatabase({ databaseNamePrefix: "runtime_reader_" });

beforeEach(async () => {
	await runCaseStoreMigrations(h.db);
});

async function expectSqlState(
	statement: string,
	code: string,
	params: readonly unknown[] = [],
): Promise<void> {
	await expect(h.pool.query(statement, [...params])).rejects.toMatchObject({
		code,
	});
}

async function runtimeStamp(appId: string): Promise<number | null> {
	const result = await h.pool.query<{ stamp: number | null }>(
		`SELECT run_runtime_reader_version AS stamp FROM apps WHERE id = $1`,
		[appId],
	);
	if (!result.rows[0]) throw new Error("runtime stamp query returned no row");
	return result.rows[0].stamp;
}

describe("runtime-reader rollout migration", () => {
	test("installs holder, epoch, cutover, and truncate invariants", async () => {
		const columns = await h.pool.query<{ column_name: string }>(
			`SELECT column_name
			 FROM information_schema.columns
			 WHERE table_schema = 'public'
				AND (
					(table_name = 'apps' AND column_name = 'run_runtime_reader_version')
					OR (
						table_name = 'lookup_reference_compatibility'
						AND column_name = 'continuous_registry_traffic_since'
					)
				)
			 ORDER BY column_name`,
		);
		expect(columns.rows.map((row) => row.column_name)).toEqual([
			"continuous_registry_traffic_since",
			"run_runtime_reader_version",
		]);

		const triggers = await h.pool.query<{
			tgname: string;
			definition: string;
		}>(
			`SELECT trigger.tgname,
				pg_get_triggerdef(trigger.oid) AS definition
			 FROM pg_trigger AS trigger
			 WHERE NOT trigger.tgisinternal
				AND trigger.tgrelid IN (
					'apps'::regclass,
					'lookup_reference_compatibility'::regclass,
					'runtime_reader_traffic_epochs'::regclass
				)
			 ORDER BY trigger.tgname`,
		);
		const byName = new Map(
			triggers.rows.map((row) => [row.tgname, row.definition]),
		);
		expect(byName.get("apps_runtime_reader_holder_stamp")).toContain(
			"BEFORE INSERT OR UPDATE OF status, run_id, res_period, res_run_id, lock_run_id, run_runtime_reader_version",
		);
		for (const name of [
			"lookup_reference_compatibility_cutover_gate",
			"runtime_reader_traffic_epochs_cutover_gate",
		]) {
			const definition = byName.get(name);
			expect(definition).toContain("BEFORE INSERT OR DELETE OR UPDATE");
			expect(definition).toContain("FOR EACH STATEMENT");
		}
		expect(
			byName.get("runtime_reader_traffic_epochs_reject_truncate"),
		).toContain("BEFORE TRUNCATE");

		const gateFunction = await h.pool.query<{ source: string }>(
			`SELECT prosrc AS source
			 FROM pg_proc
			 WHERE proname = 'nova_lock_deployment_cutover_gate'`,
		);
		expect(gateFunction.rows[0]?.source).toContain(
			String(DEPLOYMENT_CUTOVER_GATE_NAMESPACE),
		);
		expect(gateFunction.rows[0]?.source).toContain(
			String(DEPLOYMENT_CUTOVER_GATE_KEY),
		);

		await expectSqlState(
			"INSERT INTO runtime_reader_traffic_epochs (target_version) VALUES (0)",
			"23514",
		);
		await h.pool.query(
			"INSERT INTO runtime_reader_traffic_epochs (target_version) VALUES (1)",
		);
		await expectSqlState("TRUNCATE runtime_reader_traffic_epochs", "55000");
	});

	test("stamps exact holder changes, preserves same identity, and clears releases", async () => {
		await h.pool.query("BEGIN");
		try {
			await h.pool.query(
				"SELECT set_config('nova.runtime_reader_version', '2', true)",
			);
			await h.pool.query(
				`INSERT INTO apps (
					id, owner, project_id, app_name, app_name_lower,
					status, run_id
				 ) VALUES (
					'holder', 'actor', 'project-a', 'Holder', 'holder',
					'generating', 'build-a'
				 )`,
			);
			await h.pool.query("COMMIT");
		} catch (error) {
			await h.pool.query("ROLLBACK");
			throw error;
		}
		expect(await runtimeStamp("holder")).toBe(2);

		// Reservation booking keeps the same effective build identity. A newer
		// caller and even a direct stamp write cannot restamp it.
		await h.pool.query("BEGIN");
		try {
			await h.pool.query(
				"SELECT set_config('nova.runtime_reader_version', '9', true)",
			);
			await h.pool.query(
				`UPDATE apps
				 SET res_period = '2026-07', res_run_id = 'build-a',
					run_runtime_reader_version = 99
				 WHERE id = 'holder'`,
			);
			await h.pool.query("COMMIT");
		} catch (error) {
			await h.pool.query("ROLLBACK");
			throw error;
		}
		expect(await runtimeStamp("holder")).toBe(2);

		await h.pool.query("BEGIN");
		try {
			await h.pool.query(
				"SELECT set_config('nova.runtime_reader_version', '3', true)",
			);
			await h.pool.query(
				"UPDATE apps SET res_run_id = 'build-b' WHERE id = 'holder'",
			);
			await h.pool.query("COMMIT");
		} catch (error) {
			await h.pool.query("ROLLBACK");
			throw error;
		}
		expect(await runtimeStamp("holder")).toBe(3);

		await h.pool.query(
			`UPDATE apps
			 SET status = 'complete', res_period = NULL, res_run_id = NULL
			 WHERE id = 'holder'`,
		);
		expect(await runtimeStamp("holder")).toBeNull();

		await h.pool.query("BEGIN");
		try {
			await h.pool.query(
				"SELECT set_config('nova.runtime_reader_version', '4', true)",
			);
			await h.pool.query(
				`UPDATE apps
				 SET lock_run_id = 'edit-a', lock_actor_user_id = 'actor',
					lock_expire_at = now() + interval '15 minutes'
				 WHERE id = 'holder'`,
			);
			await h.pool.query("COMMIT");
		} catch (error) {
			await h.pool.query("ROLLBACK");
			throw error;
		}
		expect(await runtimeStamp("holder")).toBe(4);

		await h.pool.query(
			`UPDATE apps
			 SET lock_run_id = NULL, lock_actor_user_id = NULL, lock_expire_at = NULL
			 WHERE id = 'holder'`,
		);
		expect(await runtimeStamp("holder")).toBeNull();
	});

	test("never falls back through a present reservation and rejects new old holders above floor", async () => {
		await h.pool.query(
			`INSERT INTO apps (
				id, owner, project_id, app_name, app_name_lower,
				status, run_id, res_period
			 ) VALUES (
				'corrupt-v0', 'actor', 'project-a', 'Corrupt', 'corrupt',
				'generating', 'must-not-fallback', '2026-07'
			 )`,
		);
		expect(await runtimeStamp("corrupt-v0")).toBeNull();

		await h.pool.query(
			`UPDATE apps
			 SET status = 'complete', res_period = NULL
			 WHERE id = 'corrupt-v0'`,
		);
		await h.pool.query(
			`UPDATE lookup_reference_compatibility
			 SET minimum_runtime_reader_version = 1 WHERE id = 1`,
		);

		await expectSqlState(
			`INSERT INTO apps (
				id, owner, project_id, app_name, app_name_lower, status, run_id
			 ) VALUES (
				'old-v0', 'actor', 'project-a', 'Old', 'old', 'generating', 'old-run'
			 )`,
			"55000",
		);
		await expectSqlState(
			`INSERT INTO apps (
				id, owner, project_id, app_name, app_name_lower,
				status, run_id, res_period
			 ) VALUES (
				'corrupt-v1-floor', 'actor', 'project-a', 'Corrupt', 'corrupt',
				'generating', 'must-not-fallback', '2026-07'
			 )`,
			"55000",
		);

		await h.pool.query("BEGIN");
		try {
			await h.pool.query(
				"SELECT set_config('nova.runtime_reader_version', '1', true)",
			);
			await h.pool.query(
				`INSERT INTO apps (
					id, owner, project_id, app_name, app_name_lower, status, run_id
				 ) VALUES (
					'current-v1', 'actor', 'project-a', 'Current', 'current',
					'generating', 'current-run'
				 )`,
			);
			await h.pool.query("COMMIT");
		} catch (error) {
			await h.pool.query("ROLLBACK");
			throw error;
		}
		expect(await runtimeStamp("current-v1")).toBe(1);
	});

	test("keeps the runtime declaration transaction-local across commit and rollback", async () => {
		const db = h.db as Kysely<AppDatabase>;
		const before = await db.transaction().execute(async (tx) => {
			const result = await sql<{ pid: number; setting: string | null }>`
				SELECT pg_backend_pid() AS pid,
					current_setting(${RUNTIME_READER_VERSION_GUC}, true) AS setting
			`.execute(tx);
			return result.rows[0];
		});
		if (!before)
			throw new Error("initial runtime setting query returned no row");

		await db.transaction().execute(async (tx) => {
			await setTransactionRuntimeReaderVersion(tx, 6);
			await sql`
				INSERT INTO apps (
					id, owner, project_id, app_name, app_name_lower, status, run_id
				) VALUES (
					'helper-v6', 'actor', 'project-a', 'Helper', 'helper',
					'generating', 'helper-run'
				)
			`.execute(tx);
		});
		expect(await runtimeStamp("helper-v6")).toBe(6);

		const afterCommit = await db.transaction().execute(async (tx) => {
			const result = await sql<{ pid: number; setting: string | null }>`
				SELECT pg_backend_pid() AS pid,
					current_setting(${RUNTIME_READER_VERSION_GUC}, true) AS setting
			`.execute(tx);
			return result.rows[0];
		});
		expect(afterCommit).toEqual({ pid: before.pid, setting: "" });

		await expect(
			db.transaction().execute(async (tx) => {
				await setTransactionRuntimeReaderVersion(tx, 7);
				throw new Error("intentional runtime declaration rollback");
			}),
		).rejects.toThrow("intentional runtime declaration rollback");
		const afterRollback = await db.transaction().execute(async (tx) => {
			const result = await sql<{ pid: number; setting: string | null }>`
				SELECT pg_backend_pid() AS pid,
					current_setting(${RUNTIME_READER_VERSION_GUC}, true) AS setting
			`.execute(tx);
			return result.rows[0];
		});
		expect(afterRollback).toEqual({ pid: before.pid, setting: "" });
	});
});
