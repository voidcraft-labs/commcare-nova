import type { Kysely } from "kysely";
import { Client } from "pg";
import { beforeEach, describe, expect, test } from "vitest";
import { runCaseStoreMigrations } from "@/lib/case-store/migrate";
import { setupPerTestDatabase } from "@/lib/case-store/sql/__tests__/perTestDatabase";
import {
	DEPLOYMENT_CUTOVER_GATE_KEY,
	DEPLOYMENT_CUTOVER_GATE_NAMESPACE,
} from "@/lib/db/deploymentCutoverGate";
import { __setAppDbForTests, type AppDatabase } from "@/lib/db/pg";
import {
	RolloutCompatibilityError,
	raiseMinimumRuntimeReaderVersion,
	reconcileReceivingRevisionCapabilities,
} from "@/lib/db/rolloutCompatibility";

const h = setupPerTestDatabase({ databaseNamePrefix: "runtime_cutoff_" });

beforeEach(async () => {
	await runCaseStoreMigrations(h.db);
});

async function backendPid(client: Client): Promise<number> {
	const result = await client.query<{ pid: number }>(
		"SELECT pg_backend_pid() AS pid",
	);
	const pid = result.rows[0]?.pid;
	if (pid === undefined) throw new Error("backend pid query returned no row");
	return pid;
}

async function waitUntilBlockedBy(
	observer: Client,
	waitingPid: number,
	blockingPid: number,
): Promise<void> {
	for (let attempt = 0; attempt < 200; attempt++) {
		const result = await observer.query<{ blockers: number[] }>(
			"SELECT pg_blocking_pids($1) AS blockers",
			[waitingPid],
		);
		if (result.rows[0]?.blockers.includes(blockingPid)) return;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	throw new Error(
		`backend ${waitingPid} did not block behind ${blockingPid} within 1 second`,
	);
}

describe("runtime-reader claim/floor cutoff", () => {
	test("holder-first is caught by the unlocked census; floor-first rejects the old claim", async () => {
		const holder = new Client({ connectionString: h.uri });
		const floor = new Client({ connectionString: h.uri });
		const observer = new Client({ connectionString: h.uri });
		let pendingRaise:
			| Promise<
					| { ok: true; value: unknown; error: undefined }
					| { ok: false; error: unknown }
			  >
			| undefined;
		let pendingOldClaim:
			| Promise<{ ok: true; error: undefined } | { ok: false; error: unknown }>
			| undefined;
		await Promise.all([holder.connect(), floor.connect(), observer.connect()]);
		try {
			// The separate writer floor guards the apps inserts below; declare v1
			// session-wide on both writing clients. The runtime-reader claims under
			// test set (or omit) their own nova.runtime_reader_version GUC.
			await holder.query(
				"SELECT set_config('nova.writer_version', '1', false)",
			);
			await floor.query("SELECT set_config('nova.writer_version', '1', false)");
			await floor.query(
				`INSERT INTO runtime_reader_traffic_epochs
					(target_version, continuous_traffic_since)
				 VALUES (1, clock_timestamp() - interval '2 hours')`,
			);

			// Holder first: the row trigger holds compatibility FOR SHARE through
			// commit. The service floor waits, then its plain MVCC census sees the
			// committed v0 holder and rejects without taking an app-row lock.
			await holder.query("BEGIN");
			await holder.query(
				`INSERT INTO apps (
					id, owner, project_id, app_name, app_name_lower, status, run_id
				 ) VALUES (
					'holder-first', 'actor', 'project-a', 'Holder first',
					'holder first', 'generating', 'run-v0'
				 )`,
			);
			__setAppDbForTests(h.db as Kysely<AppDatabase>);
			const floorPoolPid = await h.pool.query<{ pid: number }>(
				"SELECT pg_backend_pid() AS pid",
			);
			const floorPid = floorPoolPid.rows[0]?.pid;
			if (floorPid === undefined) throw new Error("floor pool pid missing");
			pendingRaise = raiseMinimumRuntimeReaderVersion(1).then(
				(value) => ({ ok: true as const, value, error: undefined }),
				(error: unknown) => ({ ok: false as const, error }),
			);
			const holderPid = await backendPid(holder);
			await waitUntilBlockedBy(observer, floorPid, holderPid);
			await holder.query("COMMIT");
			const outcome = await pendingRaise;
			expect(outcome.ok).toBe(false);
			expect(outcome.error).toBeInstanceOf(RolloutCompatibilityError);
			expect(
				(outcome.error as RolloutCompatibilityError | undefined)?.code,
			).toBe("runtime_holders_not_drained");
			const afterHolderFirst = await floor.query<{
				floor: number;
				stamp: number | null;
			}>(
				`SELECT compatibility.minimum_runtime_reader_version AS floor,
					app.run_runtime_reader_version AS stamp
				 FROM lookup_reference_compatibility AS compatibility
				 CROSS JOIN apps AS app
				 WHERE compatibility.id = 1 AND app.id = 'holder-first'`,
			);
			expect(afterHolderFirst.rows[0]).toEqual({ floor: 0, stamp: null });

			await floor.query(
				`UPDATE apps SET status = 'complete' WHERE id = 'holder-first'`,
			);
			await floor.query(
				`INSERT INTO apps (
					id, owner, project_id, app_name, app_name_lower
				 ) VALUES (
					'floor-first', 'actor', 'project-a', 'Floor first', 'floor first'
				 )`,
			);

			// Floor first: while its compatibility-row update is uncommitted, a
			// v0 claim locks the app row then waits for the trigger's FOR SHARE. It
			// wakes against floor 1 and fails closed.
			await floor.query("BEGIN");
			await floor.query(
				`UPDATE lookup_reference_compatibility
				 SET minimum_runtime_reader_version = 1 WHERE id = 1`,
			);
			await holder.query("BEGIN");
			pendingOldClaim = holder
				.query(
					`UPDATE apps
					 SET status = 'generating', run_id = 'run-v0'
					 WHERE id = 'floor-first'`,
				)
				.then(
					() => ({ ok: true as const, error: undefined }),
					(error: unknown) => ({ ok: false as const, error }),
				);
			const floorPidDirect = await backendPid(floor);
			await waitUntilBlockedBy(observer, holderPid, floorPidDirect);
			await floor.query("COMMIT");
			const oldClaimOutcome = await pendingOldClaim;
			expect(oldClaimOutcome.ok).toBe(false);
			expect(
				(oldClaimOutcome.error as { code?: string } | undefined)?.code,
			).toBe("55000");
			await holder.query("ROLLBACK");
		} finally {
			__setAppDbForTests(null);
			await Promise.allSettled([
				holder.query("ROLLBACK"),
				floor.query("ROLLBACK"),
			]);
			await pendingRaise?.catch(() => undefined);
			await pendingOldClaim?.catch(() => undefined);
			await Promise.all([holder.end(), floor.end(), observer.end()]);
		}
	});

	test("cutover DML waits before tuple locks and epoch TRUNCATE never waits on the gate", async () => {
		const gate = new Client({ connectionString: h.uri });
		const mutation = new Client({ connectionString: h.uri });
		const probe = new Client({ connectionString: h.uri });
		let pendingUpdate: Promise<unknown> | undefined;
		await Promise.all([gate.connect(), mutation.connect(), probe.connect()]);
		try {
			await gate.query("SELECT pg_advisory_lock($1::integer, $2::integer)", [
				DEPLOYMENT_CUTOVER_GATE_NAMESPACE,
				DEPLOYMENT_CUTOVER_GATE_KEY,
			]);
			const gatePid = await backendPid(gate);
			const mutationPid = await backendPid(mutation);
			await mutation.query("BEGIN");
			pendingUpdate = mutation.query(
				`UPDATE lookup_reference_compatibility
				 SET updated_at = clock_timestamp() WHERE id = 1`,
			);
			await waitUntilBlockedBy(probe, mutationPid, gatePid);

			// A row lock remains immediately available: the blocked BEFORE STATEMENT
			// trigger has not reached compatibility tuple acquisition.
			await probe.query("BEGIN");
			await probe.query(
				"SELECT id FROM lookup_reference_compatibility WHERE id = 1 FOR UPDATE",
			);
			await probe.query("ROLLBACK");

			await gate.query("SELECT pg_advisory_unlock($1::integer, $2::integer)", [
				DEPLOYMENT_CUTOVER_GATE_NAMESPACE,
				DEPLOYMENT_CUTOVER_GATE_KEY,
			]);
			await pendingUpdate;
			await mutation.query("COMMIT");

			await gate.query("SELECT pg_advisory_lock($1::integer, $2::integer)", [
				DEPLOYMENT_CUTOVER_GATE_NAMESPACE,
				DEPLOYMENT_CUTOVER_GATE_KEY,
			]);
			await mutation.query("BEGIN");
			await mutation.query("SET LOCAL statement_timeout = '250ms'");
			await expect(
				mutation.query("TRUNCATE runtime_reader_traffic_epochs"),
			).rejects.toMatchObject({ code: "55000" });
			await mutation.query("ROLLBACK");
		} finally {
			await gate
				.query("SELECT pg_advisory_unlock_all()")
				.catch(() => undefined);
			await Promise.allSettled([
				mutation.query("ROLLBACK"),
				probe.query("ROLLBACK"),
			]);
			await pendingUpdate?.catch(() => undefined);
			await Promise.all([gate.end(), mutation.end(), probe.end()]);
		}
	});

	test("captures the control-plane split only after acquiring the cutover gate", async () => {
		const gate = new Client({ connectionString: h.uri });
		const observer = new Client({ connectionString: h.uri });
		let pendingReconciliation: Promise<unknown> | undefined;
		await Promise.all([gate.connect(), observer.connect()]);
		try {
			await gate.query("SELECT pg_advisory_lock($1::integer, $2::integer)", [
				DEPLOYMENT_CUTOVER_GATE_NAMESPACE,
				DEPLOYMENT_CUTOVER_GATE_KEY,
			]);
			const gatePid = await backendPid(gate);
			const poolIdentity = await h.pool.query<{ pid: number }>(
				"SELECT pg_backend_pid() AS pid",
			);
			const operationPid = poolIdentity.rows[0]?.pid;
			if (operationPid === undefined) throw new Error("operation pid missing");

			let callbackCalled = false;
			__setAppDbForTests(h.db as Kysely<AppDatabase>);
			pendingReconciliation = reconcileReceivingRevisionCapabilities(
				async () => {
					callbackCalled = true;
					return [
						{
							revision: "candidate",
							runtimeReaderVersion: 1,
						},
					];
				},
			);
			await waitUntilBlockedBy(observer, operationPid, gatePid);
			expect(callbackCalled).toBe(false);

			await gate.query("SELECT pg_advisory_unlock($1::integer, $2::integer)", [
				DEPLOYMENT_CUTOVER_GATE_NAMESPACE,
				DEPLOYMENT_CUTOVER_GATE_KEY,
			]);
			await pendingReconciliation;
			expect(callbackCalled).toBe(true);
		} finally {
			__setAppDbForTests(null);
			await gate
				.query("SELECT pg_advisory_unlock_all()")
				.catch(() => undefined);
			await pendingReconciliation?.catch(() => undefined);
			await Promise.all([gate.end(), observer.end()]);
		}
	});
});
