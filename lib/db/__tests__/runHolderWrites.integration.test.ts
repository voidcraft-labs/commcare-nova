/**
 * Exact-holder pause/cleanup writers against real Postgres contention.
 *
 * Both regressions freeze a replacement/reap transition while it owns the app
 * row, then start the stale writer. The stale writer must visibly wait for that
 * row lock and decide from the committed successor state — never from a
 * non-locking pre-read. This is the race the old tokenless
 * `setAwaitingInput(appId, ...)` and `editRunLockHeldBy` → `clearRunLock(appId)`
 * pair lost.
 */

import { sql } from "kysely";
import { Client } from "pg";
import { describe, expect, it } from "vitest";
import {
	clearRunLock,
	type ReacquireOutcome,
	recoverAppStatus,
	setAwaitingInput,
} from "../apps";
import { CREDITS_PER_BUILD, CREDITS_PER_EDIT } from "../creditPolicy";
import { refundStaleGeneration } from "../credits";
import { getCurrentPeriod } from "../period";
import { setupAppStateTestDb } from "./appStateTestDb";

const h = setupAppStateTestDb("run_holder_writes_");

const PROJECT = "run-holder-project";
const ACTOR = "run-holder-actor";
const OLD_RUN = "run-holder-old";
const NEW_RUN = "run-holder-new";
const OLD_NONCE = "00000000-0000-4000-8000-000000000001";
const NEW_NONCE = "00000000-0000-4000-8000-000000000002";
const period = getCurrentPeriod();

async function enableNonceEnforcement(): Promise<void> {
	await h
		.db()
		.updateTable("lookup_reference_compatibility")
		.set({
			minimum_runtime_reader_version: 1,
			run_holder_nonce_enforced: true,
		})
		.where("id", "=", 1)
		.execute();
}

type Outcome<T> =
	| { readonly ok: true; readonly value: T }
	| { readonly ok: false; readonly error: unknown };

function captureOutcome<T>(promise: Promise<T>): Promise<Outcome<T>> {
	return promise.then(
		(value) => ({ ok: true as const, value }),
		(error: unknown) => ({ ok: false as const, error }),
	);
}

async function backendPid(client: Client): Promise<number> {
	const result = await client.query<{ pid: number }>(
		"SELECT pg_backend_pid() AS pid",
	);
	const pid = result.rows[0]?.pid;
	if (pid === undefined) throw new Error("backend pid query returned no row");
	return pid;
}

async function waitUntilBackendBlockedBy(
	observer: Client,
	blockingPid: number,
): Promise<void> {
	for (let attempt = 0; attempt < 400; attempt += 1) {
		const result = await observer.query<{ pid: number }>(
			`SELECT pid
			 FROM pg_stat_activity
			 WHERE datname = current_database()
				AND pid <> pg_backend_pid()
				AND $1 = ANY(pg_blocking_pids(pid))
			 ORDER BY pid
			 LIMIT 1`,
			[blockingPid],
		);
		if (result.rows[0]?.pid !== undefined) return;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	throw new Error(
		`No lifecycle writer blocked behind backend ${blockingPid} within two seconds.`,
	);
}

async function commitTransitionWhileWriterWaits<T>(args: {
	transition(client: Client): Promise<void>;
	write(): Promise<T>;
}): Promise<T> {
	const controller = new Client({ connectionString: h.uri() });
	const observer = new Client({ connectionString: h.uri() });
	await Promise.all([controller.connect(), observer.connect()]);
	let writeOutcome: Promise<Outcome<T>> | undefined;
	let committed = false;
	try {
		await controller.query("BEGIN");
		await args.transition(controller);
		const controllerPid = await backendPid(controller);

		writeOutcome = captureOutcome(args.write());
		await waitUntilBackendBlockedBy(observer, controllerPid);

		await controller.query("COMMIT");
		committed = true;
		const outcome = await writeOutcome;
		if (!outcome.ok) throw outcome.error;
		return outcome.value;
	} finally {
		if (!committed) {
			await Promise.allSettled([controller.query("ROLLBACK")]);
		}
		if (writeOutcome !== undefined) {
			await Promise.allSettled([writeOutcome]);
		}
		await Promise.all([controller.end(), observer.end()]);
	}
}

function pauseWriter(appId: string): Promise<ReacquireOutcome> {
	return setAwaitingInput(
		appId,
		OLD_RUN,
		OLD_NONCE,
		"build",
		true,
		ACTOR,
		PROJECT,
	);
}

describe("exact-holder pause and prelude-cleanup writers", () => {
	it("a pause stamp waits for replacement/reap and returns the exact lost-ownership outcome", async () => {
		const replacementApp = "pause-replacement-app";
		const replacementClock = new Date("2026-07-22T12:00:00.000Z");
		await h.seedApp({
			id: replacementApp,
			owner: ACTOR,
			project_id: PROJECT,
			status: "generating",
			awaiting_input: false,
			run_holder_nonce: OLD_NONCE,
			updated_at: replacementClock,
			reservation: {
				period,
				reserved: CREDITS_PER_BUILD,
				settled: false,
				userId: ACTOR,
				runId: OLD_RUN,
			},
		});

		const superseded = await commitTransitionWhileWriterWaits({
			transition: async (client) => {
				await client.query(
					"SELECT set_config('nova.runtime_reader_version', '1', true)",
				);
				await client.query(
					`UPDATE apps
					 SET res_run_id = $2, run_holder_nonce = $4, updated_at = $3
					 WHERE id = $1`,
					[replacementApp, NEW_RUN, replacementClock, NEW_NONCE],
				);
			},
			write: async () => await pauseWriter(replacementApp),
		});

		expect(superseded).toBe("superseded");
		const replacement = await h.readAppRow(replacementApp);
		if (!replacement) throw new Error("replacement app row missing");
		expect(replacement.awaiting_input).toBe(false);
		expect((replacement.updated_at as Date).getTime()).toBe(
			replacementClock.getTime(),
		);
		expect(await h.readReservation(replacementApp)).toMatchObject({
			runId: NEW_RUN,
			settled: false,
		});

		const reapedApp = "pause-reaped-app";
		await h.seedApp({
			id: reapedApp,
			owner: ACTOR,
			project_id: PROJECT,
			status: "generating",
			awaiting_input: false,
			run_holder_nonce: OLD_NONCE,
			reservation: {
				period,
				reserved: CREDITS_PER_BUILD,
				settled: false,
				userId: ACTOR,
				runId: OLD_RUN,
			},
		});

		const released = await commitTransitionWhileWriterWaits({
			transition: async (client) => {
				await client.query(
					"SELECT set_config('nova.runtime_reader_version', '1', true)",
				);
				await client.query(
					`UPDATE apps
					 SET status = 'error', error_type = 'internal',
						 res_settled = true, res_run_id = NULL
					 WHERE id = $1`,
					[reapedApp],
				);
			},
			write: async () => await pauseWriter(reapedApp),
		});

		expect(released).toBe("released");
		const reaped = await h.readAppRow(reapedApp);
		expect(reaped).toMatchObject({
			status: "error",
			error_type: "internal",
			awaiting_input: false,
		});
		expect(await h.readReservation(reapedApp)).toMatchObject({
			settled: true,
		});
		expect((await h.readReservation(reapedApp))?.runId).toBeUndefined();
	});

	it("a stale prelude cleanup waits for replacement/reap and never clears successor state", async () => {
		const replacementApp = "cleanup-replacement-app";
		const replacementExpiry = new Date(Date.now() + 10 * 60_000);
		await h.seedApp({
			id: replacementApp,
			owner: ACTOR,
			project_id: PROJECT,
			status: "complete",
			run_holder_nonce: OLD_NONCE,
			run_lock: {
				runId: OLD_RUN,
				actorUserId: ACTOR,
				expireAt: replacementExpiry,
			},
			reservation: {
				period,
				reserved: CREDITS_PER_EDIT,
				settled: true,
				userId: ACTOR,
				runId: OLD_RUN,
			},
		});

		await commitTransitionWhileWriterWaits({
			transition: async (client) => {
				await client.query(
					"SELECT set_config('nova.runtime_reader_version', '1', true)",
				);
				await client.query(
					`UPDATE apps
					 SET lock_run_id = $2, res_run_id = $2, run_holder_nonce = $3
					 WHERE id = $1`,
					[replacementApp, NEW_RUN, NEW_NONCE],
				);
			},
			write: async () => await clearRunLock(replacementApp, OLD_RUN, OLD_NONCE),
		});

		expect(await h.readRunLock(replacementApp)).toMatchObject({
			runId: NEW_RUN,
			actorUserId: ACTOR,
		});
		expect(await h.readReservation(replacementApp)).toMatchObject({
			runId: NEW_RUN,
			settled: true,
		});

		const reapedApp = "cleanup-reaped-app";
		await h.seedApp({
			id: reapedApp,
			owner: ACTOR,
			project_id: PROJECT,
			status: "complete",
			run_holder_nonce: OLD_NONCE,
			run_lock: {
				runId: OLD_RUN,
				actorUserId: ACTOR,
				expireAt: new Date(Date.now() - 60_000),
			},
			reservation: {
				period,
				reserved: CREDITS_PER_EDIT,
				settled: false,
				userId: ACTOR,
				runId: OLD_RUN,
			},
		});

		await commitTransitionWhileWriterWaits({
			transition: async (client) => {
				await client.query(
					`UPDATE apps
					 SET lock_run_id = NULL, lock_actor_user_id = NULL,
						 lock_expire_at = NULL, res_settled = true,
						 res_run_id = NULL
					 WHERE id = $1`,
					[reapedApp],
				);
			},
			write: async () => await clearRunLock(reapedApp, OLD_RUN, OLD_NONCE),
		});

		expect(await h.readRunLock(reapedApp)).toBeUndefined();
		expect(await h.readReservation(reapedApp)).toMatchObject({
			settled: true,
		});
		expect((await h.readReservation(reapedApp))?.runId).toBeUndefined();
	});
});

describe("exact-holder terminal and operator compare-and-set", () => {
	it("keeps legacy mode/run reaper authority before nonce activation", async () => {
		const appId = "legacy-build-reaper";
		await h.seedCreditMonth(ACTOR, period, {
			allowance: 2000,
			consumed: CREDITS_PER_BUILD,
			bonus: 0,
		});
		await h.seedApp({
			id: appId,
			owner: ACTOR,
			project_id: PROJECT,
			status: "generating",
			run_holder_nonce: NEW_NONCE,
			updated_at: new Date(Date.now() - 60 * 60_000),
			reservation: {
				period,
				reserved: CREDITS_PER_BUILD,
				settled: false,
				userId: ACTOR,
				runId: OLD_RUN,
			},
		});

		await expect(
			refundStaleGeneration(appId, {
				mode: "build",
				runId: OLD_RUN,
				nonce: OLD_NONCE,
			}),
		).resolves.toBe("reaped");

		expect((await h.readAppRow(appId))?.status).toBe("error");
		expect(await h.readConsumed(ACTOR, period)).toBe(0);
	});

	it("a delayed build reaper cannot reap a same-run-id successor with a new nonce", async () => {
		const appId = "delayed-build-reaper";
		await h.seedCreditMonth(ACTOR, period, {
			allowance: 2000,
			consumed: CREDITS_PER_BUILD,
			bonus: 0,
		});
		await h.seedApp({
			id: appId,
			owner: ACTOR,
			project_id: PROJECT,
			status: "generating",
			run_holder_nonce: OLD_NONCE,
			updated_at: new Date(Date.now() - 60 * 60_000),
			reservation: {
				period,
				reserved: CREDITS_PER_BUILD,
				settled: false,
				userId: ACTOR,
				runId: OLD_RUN,
			},
		});

		// A new claim in the same thread may intentionally reuse the public run id.
		// Only the server-minted nonce distinguishes it from the queued old reap.
		await h
			.db()
			.transaction()
			.execute(async (tx) => {
				await sql`SELECT set_config('nova.runtime_reader_version', '1', true)`.execute(
					tx,
				);
				await tx
					.updateTable("apps")
					.set({ run_holder_nonce: NEW_NONCE })
					.where("id", "=", appId)
					.execute();
			});
		await enableNonceEnforcement();
		await expect(
			refundStaleGeneration(appId, {
				mode: "build",
				runId: OLD_RUN,
				nonce: OLD_NONCE,
			}),
		).resolves.toBe("state_changed");

		expect(await h.readReservation(appId)).toMatchObject({
			runId: OLD_RUN,
			settled: false,
		});
		expect((await h.readAppRow(appId))?.status).toBe("generating");
		expect(await h.readConsumed(ACTOR, period)).toBe(CREDITS_PER_BUILD);

		await expect(
			refundStaleGeneration(appId, {
				mode: "build",
				runId: OLD_RUN,
				nonce: NEW_NONCE,
			}),
		).resolves.toBe("reaped");
		expect((await h.readAppRow(appId))?.status).toBe("error");
		expect(await h.readConsumed(ACTOR, period)).toBe(0);
	});

	it("operator recovery refuses tokenless, mismatched, and corrupt holders", async () => {
		const appId = "recover-held-app";
		await h.seedApp({
			id: appId,
			owner: ACTOR,
			project_id: PROJECT,
			status: "generating",
			run_id: OLD_RUN,
			run_holder_nonce: OLD_NONCE,
			module_count: 1,
			reservation: {
				period,
				reserved: CREDITS_PER_BUILD,
				settled: false,
				userId: ACTOR,
				runId: OLD_RUN,
			},
		});

		expect(await recoverAppStatus(appId, null)).toMatchObject({
			kind: "holder_token_required",
			holder: { mode: "build", runId: OLD_RUN, nonce: OLD_NONCE },
		});
		expect(
			await recoverAppStatus(appId, {
				mode: "build",
				runId: NEW_RUN,
				nonce: NEW_NONCE,
			}),
		).toMatchObject({
			kind: "holder_token_mismatch",
			holder: { mode: "build", runId: OLD_RUN, nonce: OLD_NONCE },
		});
		expect((await h.readAppRow(appId))?.status).toBe("generating");

		expect(
			await recoverAppStatus(appId, {
				mode: "build",
				runId: OLD_RUN,
				nonce: OLD_NONCE,
			}),
		).toEqual({ kind: "recovered" });
		expect((await h.readAppRow(appId))?.status).toBe("complete");
		expect(await h.readReservation(appId)).toMatchObject({
			runId: OLD_RUN,
			settled: true,
		});

		const corruptId = "recover-corrupt-holder";
		await h.seedApp({
			id: corruptId,
			owner: ACTOR,
			project_id: PROJECT,
			status: "generating",
			module_count: 1,
		});
		expect(
			await recoverAppStatus(corruptId, {
				mode: "build",
				runId: OLD_RUN,
				nonce: OLD_NONCE,
			}),
		).toMatchObject({
			kind: "holder_token_mismatch",
			holder: { mode: "build", runId: null, nonce: null },
		});
		expect((await h.readAppRow(corruptId))?.status).toBe("generating");
	});

	it("operator recovery conditionally repairs a free non-empty app", async () => {
		const appId = "recover-free-app";
		await h.seedApp({
			id: appId,
			owner: ACTOR,
			project_id: PROJECT,
			status: "error",
			error_type: "internal",
			module_count: 1,
		});

		expect(await recoverAppStatus(appId, null)).toEqual({ kind: "recovered" });
		expect(await h.readAppRow(appId)).toMatchObject({
			status: "complete",
			error_type: null,
		});
	});
});
