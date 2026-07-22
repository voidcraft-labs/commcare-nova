import { type Kysely, sql } from "kysely";
import { beforeEach, describe, expect, test } from "vitest";
import { runCaseStoreMigrations } from "@/lib/case-store/migrate";
import { up as installRunHolderNonce } from "@/lib/case-store/migrations/20260722120000_run_holder_nonce";
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
import { raiseMinimumRuntimeReaderVersionInTransaction } from "@/lib/db/rolloutCompatibility";

const h = setupPerTestDatabase({ databaseNamePrefix: "runtime_reader_" });
const NONCE_A = "11111111-1111-4111-8111-111111111111";
const NONCE_B = "22222222-2222-4222-8222-222222222222";
const NONCE_C = "33333333-3333-4333-8333-333333333333";

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
					(table_name = 'apps' AND column_name IN (
						'run_holder_nonce', 'run_runtime_reader_version'
					))
					OR (
						table_name = 'threads' AND column_name = 'active_holder_nonce'
					)
					OR (
						table_name = 'lookup_reference_compatibility'
						AND column_name IN (
							'continuous_registry_traffic_since',
							'run_holder_nonce_enforced'
						)
					)
				)
			 ORDER BY column_name`,
		);
		expect(columns.rows.map((row) => row.column_name)).toEqual([
			"active_holder_nonce",
			"continuous_registry_traffic_since",
			"run_holder_nonce",
			"run_holder_nonce_enforced",
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
			"BEFORE INSERT OR UPDATE OF status, run_id, res_period, res_run_id, lock_run_id, awaiting_input, lock_expire_at, updated_at, run_holder_nonce, run_runtime_reader_version",
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

	test("defaults nonce enforcement off and makes activation floor-gated and irreversible", async () => {
		const initial = await h.pool.query<{
			enforced: boolean;
			floor: number;
		}>(
			`SELECT run_holder_nonce_enforced AS enforced,
				minimum_runtime_reader_version AS floor
			 FROM lookup_reference_compatibility WHERE id = 1`,
		);
		expect(initial.rows[0]).toEqual({ enforced: false, floor: 0 });

		await expectSqlState(
			`UPDATE lookup_reference_compatibility
			 SET run_holder_nonce_enforced = true WHERE id = 1`,
			"23514",
		);
		await h.pool.query(
			`UPDATE lookup_reference_compatibility
			 SET minimum_runtime_reader_version = 1,
				run_holder_nonce_enforced = true
			 WHERE id = 1`,
		);
		await expectSqlState(
			`UPDATE lookup_reference_compatibility
			 SET run_holder_nonce_enforced = false WHERE id = 1`,
			"23514",
		);
	});

	test("migration replay preserves an active concrete v1 holder and stamp", async () => {
		await h.pool.query("BEGIN");
		try {
			await h.pool.query(
				"SELECT set_config('nova.runtime_reader_version', '1', true)",
			);
			await h.pool.query(
				`INSERT INTO apps (
					id, owner, project_id, app_name, app_name_lower,
					status, run_id, run_holder_nonce
				 ) VALUES (
					'replay-holder', 'actor', 'project-a', 'Replay', 'replay',
					'generating', 'same-thread-run', $1
				 )`,
				[NONCE_A],
			);
			await h.pool.query("COMMIT");
		} catch (error) {
			await h.pool.query("ROLLBACK");
			throw error;
		}

		await installRunHolderNonce(h.db);
		const holder = await h.pool.query<{
			nonce: string | null;
			stamp: number | null;
		}>(
			`SELECT run_holder_nonce AS nonce,
				run_runtime_reader_version AS stamp
			 FROM apps WHERE id = 'replay-holder'`,
		);
		expect(holder.rows[0]).toEqual({ nonce: NONCE_A, stamp: 1 });
	});

	test("an undeclared v0 same-run successor clears an inherited v1 generation", async () => {
		await h.pool.query("BEGIN");
		try {
			await h.pool.query(
				"SELECT set_config('nova.runtime_reader_version', '1', true)",
			);
			await h.pool.query(
				`INSERT INTO apps (
					id, owner, project_id, app_name, app_name_lower,
					status, run_id, run_holder_nonce
				 ) VALUES (
					'v0-successor', 'actor', 'project-a', 'Successor', 'successor',
					'generating', 'same-thread-run', $1
				 )`,
				[NONCE_A],
			);
			await h.pool.query("COMMIT");
		} catch (error) {
			await h.pool.query("ROLLBACK");
			throw error;
		}

		// The deployed old revision sets no runtime GUC and omits the nonce
		// column. Reusing the same public thread/run id must still create a v0
		// successor, not inherit the predecessor capability and v1 stamp.
		await h.pool.query(
			`UPDATE apps SET run_id = 'same-thread-run'
			 WHERE id = 'v0-successor'`,
		);
		const downgraded = await h.pool.query<{
			nonce: string | null;
			stamp: number | null;
		}>(
			`SELECT run_holder_nonce AS nonce,
				run_runtime_reader_version AS stamp
			 FROM apps WHERE id = 'v0-successor'`,
		);
		expect(downgraded.rows[0]).toEqual({ nonce: null, stamp: null });

		await h.pool.query(
			`INSERT INTO runtime_reader_traffic_epochs (
				target_version, continuous_traffic_since
			 ) VALUES (1, clock_timestamp() - interval '2 hours')`,
		);
		await expect(
			(h.db as Kysely<AppDatabase>)
				.transaction()
				.execute((tx) => raiseMinimumRuntimeReaderVersionInTransaction(tx, 1)),
		).rejects.toMatchObject({ code: "runtime_holders_not_drained" });
	});

	test("a declared v1 non-holder write preserves an admitted v0 generation", async () => {
		await h.pool.query(
			`INSERT INTO apps (
				id, owner, project_id, app_name, app_name_lower, status, run_id
			 ) VALUES (
				'v0-preserved', 'actor', 'project-a', 'Legacy', 'legacy',
				'generating', 'legacy-run'
			 )`,
		);

		// A current autosave/MCP-style app projection write declares v1 but does
		// not own or replace the legacy holder. Compatibility keeps the v0
		// generation intact and census-visible until it drains.
		await h.pool.query("BEGIN");
		try {
			await h.pool.query(
				"SELECT set_config('nova.runtime_reader_version', '1', true)",
			);
			await h.pool.query(
				`UPDATE apps SET updated_at = now()
				 WHERE id = 'v0-preserved'`,
			);
			await h.pool.query("COMMIT");
		} catch (error) {
			await h.pool.query("ROLLBACK");
			throw error;
		}
		const holder = await h.pool.query<{
			nonce: string | null;
			stamp: number | null;
		}>(
			`SELECT run_holder_nonce AS nonce,
				run_runtime_reader_version AS stamp
			 FROM apps WHERE id = 'v0-preserved'`,
		);
		expect(holder.rows[0]).toEqual({ nonce: null, stamp: null });

		await h.pool.query(
			`INSERT INTO runtime_reader_traffic_epochs (
				target_version, continuous_traffic_since
			 ) VALUES (1, clock_timestamp() - interval '2 hours')`,
		);
		await expect(
			(h.db as Kysely<AppDatabase>)
				.transaction()
				.execute((tx) => raiseMinimumRuntimeReaderVersionInTransaction(tx, 1)),
		).rejects.toMatchObject({ code: "runtime_holders_not_drained" });
	});

	test("deployed v0 build and edit resumes clear inherited v1 generations", async () => {
		await h.pool.query("BEGIN");
		try {
			await h.pool.query(
				"SELECT set_config('nova.runtime_reader_version', '1', true)",
			);
			await h.pool.query(
				`INSERT INTO apps (
					id, owner, project_id, app_name, app_name_lower,
					status, run_id, awaiting_input, run_holder_nonce
				 ) VALUES (
					'v0-build-resume', 'actor', 'project-a', 'Build resume', 'build resume',
					'generating', 'build-run', true, $1
				 )`,
				[NONCE_A],
			);
			await h.pool.query(
				`INSERT INTO apps (
					id, owner, project_id, app_name, app_name_lower,
					status, lock_run_id, lock_actor_user_id, lock_expire_at,
					awaiting_input, run_holder_nonce
				 ) VALUES (
					'v0-edit-resume', 'actor', 'project-a', 'Edit resume', 'edit resume',
					'complete', 'edit-run', 'actor', now() + interval '15 minutes',
					true, $1
				 )`,
				[NONCE_B],
			);
			await h.pool.query("COMMIT");
		} catch (error) {
			await h.pool.query("ROLLBACK");
			throw error;
		}

		// These are the exact SET-column shapes emitted by the deployed v0
		// reacquireLease implementation. It sets no runtime GUC and never touches
		// an identity column or the nonce itself.
		await h.pool.query("BEGIN");
		try {
			await h.pool.query(
				`UPDATE apps
				 SET updated_at = now(), awaiting_input = false
				 WHERE id = 'v0-build-resume'`,
			);
			await h.pool.query(
				`UPDATE apps
				 SET lock_expire_at = now() + interval '15 minutes',
					awaiting_input = false
				 WHERE id = 'v0-edit-resume'`,
			);
			await h.pool.query("COMMIT");
		} catch (error) {
			await h.pool.query("ROLLBACK");
			throw error;
		}

		const downgraded = await h.pool.query<{
			id: string;
			nonce: string | null;
			stamp: number | null;
		}>(
			`SELECT id, run_holder_nonce AS nonce,
				run_runtime_reader_version AS stamp
			 FROM apps
			 WHERE id IN ('v0-build-resume', 'v0-edit-resume')
			 ORDER BY id`,
		);
		expect(downgraded.rows).toEqual([
			{ id: "v0-build-resume", nonce: null, stamp: null },
			{ id: "v0-edit-resume", nonce: null, stamp: null },
		]);

		await h.pool.query(
			`INSERT INTO runtime_reader_traffic_epochs (
				target_version, continuous_traffic_since
			 ) VALUES (1, clock_timestamp() - interval '2 hours')`,
		);
		await expect(
			(h.db as Kysely<AppDatabase>)
				.transaction()
				.execute((tx) => raiseMinimumRuntimeReaderVersionInTransaction(tx, 1)),
		).rejects.toMatchObject({ code: "runtime_holders_not_drained" });
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
					status, run_id, run_holder_nonce
				 ) VALUES (
					'holder', 'actor', 'project-a', 'Holder', 'holder',
					'generating', 'build-a', $1
				 )`,
				[NONCE_A],
			);
			await h.pool.query("COMMIT");
		} catch (error) {
			await h.pool.query("ROLLBACK");
			throw error;
		}
		expect(await runtimeStamp("holder")).toBe(2);

		// Current same-holder writers explicitly declare v1+ on every transaction.
		// The generation remains the same, so its original stamp remains stable.
		await h.pool.query("BEGIN");
		try {
			await h.pool.query(
				"SELECT set_config('nova.runtime_reader_version', '2', true)",
			);
			await h.pool.query(
				`UPDATE apps
				 SET updated_at = now(), awaiting_input = false
				 WHERE id = 'holder'`,
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
				"UPDATE apps SET res_run_id = 'build-b', run_holder_nonce = $1 WHERE id = 'holder'",
				[NONCE_B],
			);
			await h.pool.query("COMMIT");
		} catch (error) {
			await h.pool.query("ROLLBACK");
			throw error;
		}
		expect(await runtimeStamp("holder")).toBe(3);

		await h.pool.query("BEGIN");
		try {
			await h.pool.query(
				"SELECT set_config('nova.runtime_reader_version', '3', true)",
			);
			await h.pool.query(
				`UPDATE apps
				 SET status = 'complete', res_period = NULL, res_run_id = NULL
				 WHERE id = 'holder'`,
			);
			await h.pool.query("COMMIT");
		} catch (error) {
			await h.pool.query("ROLLBACK");
			throw error;
		}
		expect(await runtimeStamp("holder")).toBeNull();

		await h.pool.query("BEGIN");
		try {
			await h.pool.query(
				"SELECT set_config('nova.runtime_reader_version', '4', true)",
			);
			await h.pool.query(
				`UPDATE apps
				 SET lock_run_id = 'edit-a', lock_actor_user_id = 'actor',
					lock_expire_at = now() + interval '15 minutes',
					run_holder_nonce = $1
				 WHERE id = 'holder'`,
				[NONCE_C],
			);
			await h.pool.query("COMMIT");
		} catch (error) {
			await h.pool.query("ROLLBACK");
			throw error;
		}
		expect(await runtimeStamp("holder")).toBe(4);

		await h.pool.query("BEGIN");
		try {
			await h.pool.query(
				"SELECT set_config('nova.runtime_reader_version', '4', true)",
			);
			await h.pool.query(
				`UPDATE apps
				 SET lock_expire_at = now() + interval '15 minutes',
					awaiting_input = false
				 WHERE id = 'holder'`,
			);
			await h.pool.query("COMMIT");
		} catch (error) {
			await h.pool.query("ROLLBACK");
			throw error;
		}
		expect(await runtimeStamp("holder")).toBe(4);

		await h.pool.query("BEGIN");
		try {
			await h.pool.query(
				"SELECT set_config('nova.runtime_reader_version', '4', true)",
			);
			await h.pool.query(
				`UPDATE apps
				 SET lock_run_id = NULL, lock_actor_user_id = NULL, lock_expire_at = NULL
				 WHERE id = 'holder'`,
			);
			await h.pool.query("COMMIT");
		} catch (error) {
			await h.pool.query("ROLLBACK");
			throw error;
		}
		expect(await runtimeStamp("holder")).toBeNull();
	});

	test("rejects an undeclared terminal writer above floor and admits a declared release", async () => {
		await h.pool.query("BEGIN");
		try {
			await h.pool.query(
				"SELECT set_config('nova.runtime_reader_version', '1', true)",
			);
			await h.pool.query(
				`INSERT INTO apps (
					id, owner, project_id, app_name, app_name_lower,
					status, run_id, run_holder_nonce
				 ) VALUES (
					'release-cutoff', 'actor', 'project-a', 'Release', 'release',
					'generating', 'release-run', $1
				 )`,
				[NONCE_A],
			);
			await h.pool.query("COMMIT");
		} catch (error) {
			await h.pool.query("ROLLBACK");
			throw error;
		}
		await h.pool.query(
			`UPDATE lookup_reference_compatibility
			 SET minimum_runtime_reader_version = 1 WHERE id = 1`,
		);

		await expectSqlState(
			`UPDATE apps SET status = 'complete'
			 WHERE id = 'release-cutoff'`,
			"55000",
		);
		const retained = await h.pool.query<{
			status: string;
			nonce: string | null;
			stamp: number | null;
		}>(
			`SELECT status, run_holder_nonce AS nonce,
				run_runtime_reader_version AS stamp
			 FROM apps WHERE id = 'release-cutoff'`,
		);
		expect(retained.rows[0]).toEqual({
			status: "generating",
			nonce: NONCE_A,
			stamp: 1,
		});

		await h.pool.query("BEGIN");
		try {
			await h.pool.query(
				"SELECT set_config('nova.runtime_reader_version', '1', true)",
			);
			await h.pool.query(
				`UPDATE apps SET status = 'complete'
				 WHERE id = 'release-cutoff'`,
			);
			await h.pool.query("COMMIT");
		} catch (error) {
			await h.pool.query("ROLLBACK");
			throw error;
		}
		const released = await h.pool.query<{
			status: string;
			nonce: string | null;
			stamp: number | null;
		}>(
			`SELECT status, run_holder_nonce AS nonce,
				run_runtime_reader_version AS stamp
			 FROM apps WHERE id = 'release-cutoff'`,
		);
		expect(released.rows[0]).toEqual({
			status: "complete",
			nonce: NONCE_A,
			stamp: null,
		});
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
					id, owner, project_id, app_name, app_name_lower, status, run_id,
					run_holder_nonce
				 ) VALUES (
					'current-v1', 'actor', 'project-a', 'Current', 'current',
					'generating', 'current-run', $1
				 )`,
				[NONCE_A],
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
					id, owner, project_id, app_name, app_name_lower, status, run_id,
					run_holder_nonce
				) VALUES (
					'helper-v6', 'actor', 'project-a', 'Helper', 'helper',
					'generating', 'helper-run', ${NONCE_A}::uuid
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
