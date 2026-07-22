/**
 * Production writer races against Better Auth membership DML, on real
 * Postgres. The generic advisory-gate suite proves INSERT / UPDATE / DELETE
 * semantics; this file pins the six app-row writers whose admission cannot be
 * decided by a route preflight:
 *
 *   - claim + reserve
 *   - new-build reserve
 *   - paused-run reacquire
 *   - pause stamping
 *   - soft delete
 *   - restore
 *
 * Both serialization orders are deliberate and observable. When membership
 * DML wins, its open transaction owns the exclusive gate; each production
 * writer then waits, reads the committed downgrade, rejects, and leaves its
 * app + credit state byte-for-byte unchanged. When a writer wins, a test-only
 * BEFORE UPDATE trigger pauses that writer after it has locked the app and
 * freshly authorized under the shared gate. Membership DML must visibly block
 * behind that exact backend until the writer commits, then it may proceed.
 */

import { Client } from "pg";
import { describe, expect, it } from "vitest";
import {
	claimAndReserveRun,
	reacquireLease,
	reserveForNewBuild,
	restoreApp,
	setAwaitingInput,
	softDeleteApp,
} from "../apps";
import { CommitReauthError } from "../commitGuard";
import { CREDITS_PER_BUILD, CREDITS_PER_EDIT } from "../creditPolicy";
import { getCurrentPeriod } from "../period";
import { setupAppStateTestDb } from "./appStateTestDb";

const h = setupAppStateTestDb("project_membership_writers_");

const PROJECT = "membership-writer-project";
const period = getCurrentPeriod();

type Outcome<T> =
	| { readonly ok: true; readonly value: T }
	| { readonly ok: false; readonly error: unknown };

interface MembershipRacedOperation {
	readonly name: string;
	readonly actor: string;
	readonly appId: string;
	setup(): Promise<void>;
	run(): Promise<unknown>;
	assertCommitted(result: unknown): Promise<void>;
}

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

async function waitUntilBlockedBy(
	observer: Client,
	waitingPid: number,
	blockingPid: number,
): Promise<void> {
	for (let attempt = 0; attempt < 400; attempt += 1) {
		const result = await observer.query<{ blockers: number[] }>(
			"SELECT pg_blocking_pids($1) AS blockers",
			[waitingPid],
		);
		if (result.rows[0]?.blockers.includes(blockingPid)) return;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	throw new Error(
		`Backend ${waitingPid} did not block behind ${blockingPid} within two seconds.`,
	);
}

async function waitUntilBackendBlockedBy(
	observer: Client,
	blockingPid: number,
): Promise<number> {
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
		const pid = result.rows[0]?.pid;
		if (pid !== undefined) return pid;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	throw new Error(
		`No backend blocked behind ${blockingPid} within two seconds.`,
	);
}

async function writerSnapshot(operation: MembershipRacedOperation) {
	return {
		app: await h.readAppRow(operation.appId),
		creditMonths: await h
			.db()
			.selectFrom("credit_months")
			.selectAll()
			.where("user_id", "=", operation.actor)
			.orderBy("period")
			.execute(),
	};
}

async function expectMembershipRole(
	operation: MembershipRacedOperation,
	role: string,
): Promise<void> {
	const result = await h.pool().query<{ role: string }>(
		`SELECT role
		 FROM auth_member
		 WHERE "userId" = $1 AND "organizationId" = $2`,
		[operation.actor, PROJECT],
	);
	expect(result.rows, `${operation.name}: committed membership role`).toEqual([
		{ role },
	]);
}

async function downgradeMembership(client: Client, actor: string) {
	return await client.query(
		`UPDATE auth_member
		 SET role = 'viewer'
		 WHERE "userId" = $1 AND "organizationId" = $2`,
		[actor, PROJECT],
	);
}

function racedOperations(): readonly MembershipRacedOperation[] {
	let originalReacquireExpiry = 0;
	const claimActor = "membership-claim-user";
	const claimApp = "membership-claim-app";
	const reserveActor = "membership-reserve-user";
	const reserveApp = "membership-reserve-app";
	const reacquireActor = "membership-reacquire-user";
	const reacquireApp = "membership-reacquire-app";
	const reacquireRun = "membership-paused-edit";
	const pauseActor = "membership-pause-user";
	const pauseApp = "membership-pause-app";
	const pauseRun = "membership-pause-run";
	const deleteActor = "membership-delete-user";
	const deleteApp = "membership-delete-app";
	const restoreActor = "membership-restore-user";
	const restoreAppId = "membership-restore-app";

	return [
		{
			name: "claimAndReserveRun",
			actor: claimActor,
			appId: claimApp,
			setup: async () => {
				await h.seedApp({
					id: claimApp,
					owner: claimActor,
					project_id: PROJECT,
					status: "complete",
				});
			},
			run: async () =>
				await claimAndReserveRun(
					claimApp,
					"edit",
					"membership-claim-run",
					claimActor,
					CREDITS_PER_EDIT,
					PROJECT,
				),
			assertCommitted: async (result) => {
				expect(result).toMatchObject({
					mode: "edit",
					reservation: { period, reserved: CREDITS_PER_EDIT },
				});
				expect(await h.readRunLock(claimApp)).toMatchObject({
					runId: "membership-claim-run",
					actorUserId: claimActor,
				});
				expect(await h.readReservation(claimApp)).toMatchObject({
					runId: "membership-claim-run",
					userId: claimActor,
					settled: false,
				});
				expect(await h.readConsumed(claimActor, period)).toBe(CREDITS_PER_EDIT);
			},
		},
		{
			name: "reserveForNewBuild",
			actor: reserveActor,
			appId: reserveApp,
			setup: async () => {
				await h.seedApp({
					id: reserveApp,
					owner: reserveActor,
					project_id: PROJECT,
					status: "complete",
				});
			},
			run: async () =>
				await reserveForNewBuild(
					reserveApp,
					reserveActor,
					CREDITS_PER_BUILD,
					"membership-reserve-run",
					PROJECT,
				),
			assertCommitted: async (result) => {
				expect(result).toEqual({ period, reserved: CREDITS_PER_BUILD });
				expect(await h.readReservation(reserveApp)).toMatchObject({
					runId: "membership-reserve-run",
					userId: reserveActor,
					settled: false,
				});
				expect(await h.readConsumed(reserveActor, period)).toBe(
					CREDITS_PER_BUILD,
				);
			},
		},
		{
			name: "reacquireLease",
			actor: reacquireActor,
			appId: reacquireApp,
			setup: async () => {
				const expireAt = new Date(Date.now() + 2 * 60_000);
				originalReacquireExpiry = expireAt.getTime();
				await h.seedCreditMonth(reacquireActor, period, {
					allowance: 2000,
					consumed: CREDITS_PER_EDIT,
					bonus: 0,
				});
				await h.seedApp({
					id: reacquireApp,
					owner: reacquireActor,
					project_id: PROJECT,
					status: "complete",
					awaiting_input: true,
					reservation: {
						period,
						reserved: CREDITS_PER_EDIT,
						settled: false,
						userId: reacquireActor,
						runId: reacquireRun,
					},
					run_lock: {
						runId: reacquireRun,
						actorUserId: reacquireActor,
						expireAt,
					},
				});
			},
			run: async () =>
				await reacquireLease(
					reacquireApp,
					reacquireRun,
					"edit",
					reacquireActor,
					PROJECT,
				),
			assertCommitted: async (result) => {
				expect(result).toBe("owned");
				expect((await h.readAppRow(reacquireApp))?.awaiting_input).toBe(false);
				const lock = await h.readRunLock(reacquireApp);
				expect(lock).toMatchObject({
					runId: reacquireRun,
					actorUserId: reacquireActor,
				});
				expect(lock?.expireAt.getTime()).toBeGreaterThan(
					originalReacquireExpiry,
				);
			},
		},
		{
			name: "setAwaitingInput",
			actor: pauseActor,
			appId: pauseApp,
			setup: async () => {
				await h.seedApp({
					id: pauseApp,
					owner: pauseActor,
					project_id: PROJECT,
					status: "generating",
					awaiting_input: false,
					reservation: {
						period,
						reserved: CREDITS_PER_BUILD,
						settled: false,
						userId: pauseActor,
						runId: pauseRun,
					},
				});
			},
			run: async () =>
				await setAwaitingInput(pauseApp, pauseRun, true, pauseActor, PROJECT),
			assertCommitted: async (result) => {
				expect(result).toBe("owned");
				expect((await h.readAppRow(pauseApp))?.awaiting_input).toBe(true);
				expect(await h.readReservation(pauseApp)).toMatchObject({
					runId: pauseRun,
					userId: pauseActor,
					settled: false,
				});
			},
		},
		{
			name: "softDeleteApp",
			actor: deleteActor,
			appId: deleteApp,
			setup: async () => {
				await h.seedApp({
					id: deleteApp,
					owner: deleteActor,
					project_id: PROJECT,
					status: "complete",
				});
			},
			run: async () => await softDeleteApp(deleteApp, deleteActor),
			assertCommitted: async (result) => {
				const row = await h.readAppRow(deleteApp);
				if (!row) throw new Error("soft-deleted app row missing");
				expect(row?.deleted_at).toBeInstanceOf(Date);
				expect(row?.recoverable_until).toBeInstanceOf(Date);
				expect(result).toBe((row.recoverable_until as Date).toISOString());
			},
		},
		{
			name: "restoreApp",
			actor: restoreActor,
			appId: restoreAppId,
			setup: async () => {
				await h.seedApp({
					id: restoreAppId,
					owner: restoreActor,
					project_id: PROJECT,
					status: "error",
					error_type: "internal",
					deleted_at: new Date("2026-06-01T00:00:00Z"),
					recoverable_until: new Date("2026-07-01T00:00:00Z"),
				});
			},
			run: async () => await restoreApp(restoreAppId, restoreActor),
			assertCommitted: async (result) => {
				expect(result).toBeUndefined();
				const row = await h.readAppRow(restoreAppId);
				expect(row?.deleted_at).toBeNull();
				expect(row?.recoverable_until).toBeNull();
				expect(row?.status).toBe("error");
			},
		},
	];
}

async function proveMembershipWins(
	operation: MembershipRacedOperation,
): Promise<void> {
	const before = await writerSnapshot(operation);
	const mutator = new Client({ connectionString: h.uri() });
	const observer = new Client({ connectionString: h.uri() });
	await Promise.all([mutator.connect(), observer.connect()]);
	let operationOutcome: Promise<Outcome<unknown>> | undefined;
	let membershipCommitted = false;
	try {
		await mutator.query("BEGIN");
		await downgradeMembership(mutator, operation.actor);
		const mutatorPid = await backendPid(mutator);

		operationOutcome = captureOutcome(operation.run());
		await waitUntilBackendBlockedBy(observer, mutatorPid);

		await mutator.query("COMMIT");
		membershipCommitted = true;
		const outcome = await operationOutcome;
		if (outcome.ok) {
			throw new Error(
				`${operation.name} unexpectedly committed after the membership downgrade won.`,
			);
		}
		expect(outcome.error).toBeInstanceOf(CommitReauthError);
		expect(await writerSnapshot(operation)).toEqual(before);
		await expectMembershipRole(operation, "viewer");
	} finally {
		if (!membershipCommitted) {
			await Promise.allSettled([mutator.query("ROLLBACK")]);
		}
		if (operationOutcome !== undefined) {
			await Promise.allSettled([operationOutcome]);
		}
		await Promise.all([mutator.end(), observer.end()]);
	}
}

/**
 * Pause every app-row UPDATE on one test-owned row lock. Production writers
 * reach this trigger only after their app lock + authorization decision; the
 * controller can therefore freeze that precise interval without a production
 * hook or timing sleep.
 */
async function installAppUpdatePauseTrigger(): Promise<void> {
	await h.pool().query(`
		CREATE TABLE nova_test_app_update_pause (
			id integer PRIMARY KEY
		);
		INSERT INTO nova_test_app_update_pause (id) VALUES (1);

		CREATE FUNCTION nova_test_pause_app_update()
		RETURNS trigger
		LANGUAGE plpgsql
		AS $trigger$
		BEGIN
			PERFORM 1
			FROM nova_test_app_update_pause
			WHERE id = 1
			FOR UPDATE;
			RETURN NEW;
		END;
		$trigger$;

		CREATE TRIGGER zz_nova_test_pause_app_update
		BEFORE UPDATE ON apps
		FOR EACH ROW
		EXECUTE FUNCTION nova_test_pause_app_update();
	`);
}

async function proveWriterWins(
	operation: MembershipRacedOperation,
): Promise<void> {
	const controller = new Client({ connectionString: h.uri() });
	const mutator = new Client({ connectionString: h.uri() });
	const observer = new Client({ connectionString: h.uri() });
	await Promise.all([
		controller.connect(),
		mutator.connect(),
		observer.connect(),
	]);
	let operationOutcome: Promise<Outcome<unknown>> | undefined;
	let membershipOutcome:
		| Promise<Outcome<Awaited<ReturnType<typeof downgradeMembership>>>>
		| undefined;
	let controllerCommitted = false;
	try {
		await controller.query("BEGIN");
		await controller.query(
			"SELECT id FROM nova_test_app_update_pause WHERE id = 1 FOR UPDATE",
		);
		const controllerPid = await backendPid(controller);

		operationOutcome = captureOutcome(operation.run());
		const writerPid = await waitUntilBackendBlockedBy(observer, controllerPid);

		const mutatorPid = await backendPid(mutator);
		membershipOutcome = captureOutcome(
			downgradeMembership(mutator, operation.actor),
		);
		await waitUntilBlockedBy(observer, mutatorPid, writerPid);

		await controller.query("COMMIT");
		controllerCommitted = true;

		const write = await operationOutcome;
		if (!write.ok) throw write.error;
		const membership = await membershipOutcome;
		if (!membership.ok) throw membership.error;
		expect(
			membership.value.rowCount,
			`${operation.name}: membership update`,
		).toBe(1);
		await operation.assertCommitted(write.value);
		await expectMembershipRole(operation, "viewer");
	} finally {
		if (!controllerCommitted) {
			await Promise.allSettled([controller.query("ROLLBACK")]);
		}
		await Promise.allSettled(
			[operationOutcome, membershipOutcome].filter(
				(value): value is Promise<Outcome<unknown>> => value !== undefined,
			),
		);
		await Promise.all([controller.end(), mutator.end(), observer.end()]);
	}
}

describe("membership DML races with authoritative app writers", () => {
	it("membership-wins rejects every writer without app or credit mutation", async () => {
		for (const operation of racedOperations()) {
			await operation.setup();
			await proveMembershipWins(operation);
		}
	});

	it("writer-wins blocks membership DML until every authorized write commits", async () => {
		await installAppUpdatePauseTrigger();
		for (const operation of racedOperations()) {
			await operation.setup();
			await proveWriterWins(operation);
		}
	});
});
