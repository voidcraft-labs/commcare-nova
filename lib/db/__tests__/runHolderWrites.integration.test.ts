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

import { Client } from "pg";
import { describe, expect, it } from "vitest";
import { clearRunLock, type ReacquireOutcome, setAwaitingInput } from "../apps";
import { CREDITS_PER_BUILD, CREDITS_PER_EDIT } from "../creditPolicy";
import { getCurrentPeriod } from "../period";
import { setupAppStateTestDb } from "./appStateTestDb";

const h = setupAppStateTestDb("run_holder_writes_");

const PROJECT = "run-holder-project";
const ACTOR = "run-holder-actor";
const OLD_RUN = "run-holder-old";
const NEW_RUN = "run-holder-new";
const period = getCurrentPeriod();

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
	return setAwaitingInput(appId, OLD_RUN, true, ACTOR, PROJECT);
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
					`UPDATE apps
					 SET res_run_id = $2, updated_at = $3
					 WHERE id = $1`,
					[replacementApp, NEW_RUN, replacementClock],
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
					`UPDATE apps
					 SET lock_run_id = $2, res_run_id = $2
					 WHERE id = $1`,
					[replacementApp, NEW_RUN],
				);
			},
			write: async () => await clearRunLock(replacementApp, OLD_RUN),
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
			write: async () => await clearRunLock(reapedApp, OLD_RUN),
		});

		expect(await h.readRunLock(reapedApp)).toBeUndefined();
		expect(await h.readReservation(reapedApp)).toMatchObject({
			settled: true,
		});
		expect((await h.readReservation(reapedApp))?.runId).toBeUndefined();
	});
});
