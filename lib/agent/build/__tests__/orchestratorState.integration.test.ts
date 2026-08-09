/**
 * The orchestration event chain + slice attempts against a REAL Postgres —
 * §20.16's structural half: predecessor uniqueness rejects forks, the fold
 * re-proves the whole chain, and one running attempt per slice.
 */

import { describe, expect, it } from "vitest";
import { asDesignId } from "@/lib/agent/design/ids";
import { setupAppStateTestDb } from "@/lib/db/__tests__/appStateTestDb";
import {
	appendOrchestrationEvent as appendOrchestrationEventAuthorized,
	type BuildOrchestratorState,
	OrchestrationForkError,
	readOrchestrationHead,
} from "../orchestratorState";
import {
	beginOrRecoverSliceAttempt,
	countDesignIssueAttempts,
	loadRunningSliceAttempt,
	markSliceAttempt,
} from "../sliceAttempts";

const h = setupAppStateTestDb("orchestrator_state_");

const RUN = "run-orch";
const NONCE = "6a0a35a4-1111-4222-8333-944445555666";
const ACTOR = "owner-test";
const PROJECT = "project-test";
const DIGEST = "a".repeat(64);

function appendOrchestrationEvent(
	args: Omit<
		Parameters<typeof appendOrchestrationEventAuthorized>[0],
		"actorUserId" | "expectedProjectId"
	>,
) {
	return appendOrchestrationEventAuthorized({
		...args,
		actorUserId: ACTOR,
		expectedProjectId: PROJECT,
	});
}

function seedHeldSession(): Promise<string> {
	return h.seedDesignSession({
		owner_user_id: ACTOR,
		project_id: PROJECT,
		run_id: RUN,
		run_holder_nonce: NONCE,
		run_actor_user_id: ACTOR,
		run_lease_expires_at: new Date(Date.now() + 60_000),
		reservation: {
			period: "2026-08",
			reserved: 1,
			settled: false,
			userId: ACTOR,
			runId: RUN,
		},
	});
}

function designing(designSessionId: string): BuildOrchestratorState {
	return { kind: "designing", designSessionId, sourcePackageDigest: DIGEST };
}

describe("orchestration event chain", () => {
	it("refuses a stale holder before it can consume the next revision", async () => {
		const sessionId = await seedHeldSession();
		await expect(
			appendOrchestrationEvent({
				designSessionId: sessionId,
				runId: RUN,
				holderNonce: crypto.randomUUID(),
				state: designing(sessionId),
				expectedHead: null,
			}),
		).rejects.toMatchObject({ name: "RunHolderLostError" });
		expect(await readOrchestrationHead(sessionId)).toBeNull();
	});

	it("refuses an append after current Project membership is revoked", async () => {
		const sessionId = await seedHeldSession();
		await h
			.pool()
			.query(
				`DELETE FROM auth_member WHERE "userId" = $1 AND "organizationId" = $2`,
				[ACTOR, PROJECT],
			);
		await expect(
			appendOrchestrationEvent({
				designSessionId: sessionId,
				runId: RUN,
				holderNonce: NONCE,
				state: designing(sessionId),
				expectedHead: null,
			}),
		).rejects.toThrow(/edit access/);
		expect(await readOrchestrationHead(sessionId)).toBeNull();
	});

	it("appends, folds, and refuses a forked continuation", async () => {
		const sessionId = await seedHeldSession();
		expect(await readOrchestrationHead(sessionId)).toBeNull();

		const first = await appendOrchestrationEvent({
			designSessionId: sessionId,
			runId: RUN,
			holderNonce: NONCE,
			state: designing(sessionId),
			expectedHead: null,
		});
		expect(first.revision).toBe(1);

		const second = await appendOrchestrationEvent({
			designSessionId: sessionId,
			runId: RUN,
			holderNonce: NONCE,
			state: {
				kind: "planning",
				designRevisionId: crypto.randomUUID(),
				designRevisionDigest: DIGEST,
			},
			expectedHead: first,
		});
		expect(second.revision).toBe(2);

		/* A second continuation still holding the OLD head cannot advance the
		 * same state — the predecessor uniqueness rejects the fork. */
		await expect(
			appendOrchestrationEvent({
				designSessionId: sessionId,
				runId: RUN,
				holderNonce: NONCE,
				state: {
					kind: "failed",
					failureId: crypto.randomUUID(),
					recoverable: true,
					errorType: "provider",
				},
				expectedHead: first,
			}),
		).rejects.toBeInstanceOf(OrchestrationForkError);

		const head = await readOrchestrationHead(sessionId);
		expect(head?.revision).toBe(2);
		expect(head?.state.kind).toBe("planning");
		expect(head?.eventId).toBe(second.eventId);
		expect(head?.digest).toBe(second.digest);
	});

	it("adopts an identical transition that won the predecessor race", async () => {
		const sessionId = await seedHeldSession();
		const state = designing(sessionId);
		const [left, right] = await Promise.all([
			appendOrchestrationEvent({
				designSessionId: sessionId,
				runId: RUN,
				holderNonce: NONCE,
				state,
				expectedHead: null,
			}),
			appendOrchestrationEvent({
				designSessionId: sessionId,
				runId: RUN,
				holderNonce: NONCE,
				state,
				expectedHead: null,
			}),
		]);
		expect(right).toEqual(left);
		expect((await readOrchestrationHead(sessionId))?.revision).toBe(1);
	});

	it("the fold fails closed on a tampered payload", async () => {
		const sessionId = await seedHeldSession();
		const first = await appendOrchestrationEvent({
			designSessionId: sessionId,
			runId: RUN,
			holderNonce: NONCE,
			state: designing(sessionId),
			expectedHead: null,
		});
		await h
			.db()
			.updateTable("design_orchestration_events")
			.set({ kind: "planning" })
			.where("design_session_id", "=", sessionId)
			.where("event_id", "=", first.eventId)
			.execute();
		await expect(readOrchestrationHead(sessionId)).rejects.toThrow(
			/folds to designing/,
		);
	});
});

describe("slice attempts", () => {
	async function attemptArgs(sessionId: string) {
		const lineage = await h.seedDesignLineage({ existingSessionId: sessionId });
		return {
			designSessionId: sessionId,
			actorUserId: ACTOR,
			runId: RUN,
			holderNonce: NONCE,
			expectedProjectId: PROJECT,
			designRevisionId: lineage.designRevisionId,
			designRevisionDigest: lineage.designRevisionDigest,
			buildPlanId: lineage.buildPlanId,
			buildPlanDigest: lineage.buildPlanDigest,
			sliceId: asDesignId(crypto.randomUUID()) as string,
			baseTarget: {
				kind: "empty-genesis" as const,
				proposedAppId: crypto.randomUUID(),
				digest: DIGEST,
			},
			executorModel: "test-model",
			promptVersion: "build-executor-v1",
			briefDigest: DIGEST,
		};
	}

	it("recovers the running attempt when digests match, supersedes it when they moved", async () => {
		const sessionId = await seedHeldSession();
		const args = await attemptArgs(sessionId);
		/* seedDesignLineage already minted a running attempt for its own slice;
		 * this test's slice id is fresh, so its lifecycle is isolated. */
		const first = await beginOrRecoverSliceAttempt(args);
		expect(first.recovered).toBe(false);
		expect(first.attempt.attempt).toBe(1);
		expect(first.attempt.status).toBe("running");

		const recovered = await beginOrRecoverSliceAttempt(args);
		expect(recovered.recovered).toBe(true);
		expect(recovered.attempt.id).toBe(first.attempt.id);

		const superseding = await beginOrRecoverSliceAttempt({
			...args,
			briefDigest: "b".repeat(64),
		});
		expect(superseding.recovered).toBe(false);
		expect(superseding.attempt.attempt).toBe(2);
		const rows = await h
			.db()
			.selectFrom("design_slice_attempts")
			.select(["status", "attempt", "failure_code"])
			.where("design_session_id", "=", sessionId)
			.where("slice_id", "=", args.sliceId)
			.orderBy("attempt", "asc")
			.execute();
		expect(rows.map((row) => row.status)).toEqual(["superseded", "running"]);
		expect(rows[0]?.failure_code).toBe("artifact-superseded");
	});

	it("terminal marks are running-only compare-and-sets", async () => {
		const sessionId = await seedHeldSession();
		const args = await attemptArgs(sessionId);
		const { attempt } = await beginOrRecoverSliceAttempt(args);
		await markSliceAttempt({
			...args,
			attemptId: attempt.id,
			to: "failed",
			failureCode: "budget-exhausted",
		});
		/* An exact replay is idempotent, while a divergent terminal transition
		 * is rejected under the same live authority. */
		await markSliceAttempt({
			...args,
			attemptId: attempt.id,
			to: "failed",
			failureCode: "budget-exhausted",
		});
		await expect(
			markSliceAttempt({
				...args,
				attemptId: attempt.id,
				to: "design-issue",
			}),
		).rejects.toMatchObject({ name: "SliceAttemptStateError" });
		const row = await h
			.db()
			.selectFrom("design_slice_attempts")
			.select(["status", "failure_code"])
			.where("id", "=", attempt.id)
			.executeTakeFirst();
		expect(row?.status).toBe("failed");
		expect(row?.failure_code).toBe("budget-exhausted");
		/* seedDesignLineage's own attempt for its slice is still running; this
		 * slice has none. */
		const running = await loadRunningSliceAttempt(sessionId);
		expect(running?.sliceId).not.toBe(args.sliceId);
	});

	it("refuses attempt transitions after the holder is superseded", async () => {
		const sessionId = await seedHeldSession();
		const args = await attemptArgs(sessionId);
		const { attempt } = await beginOrRecoverSliceAttempt(args);
		await h
			.db()
			.updateTable("design_sessions")
			.set({ run_holder_nonce: "6b0b35b4-1111-4222-8333-944445555666" })
			.where("id", "=", sessionId)
			.execute();

		await expect(
			markSliceAttempt({
				...args,
				attemptId: attempt.id,
				to: "failed",
				failureCode: "stale-worker",
			}),
		).rejects.toMatchObject({ name: "RunHolderLostError" });
		expect(
			await h
				.db()
				.selectFrom("design_slice_attempts")
				.select("status")
				.where("id", "=", attempt.id)
				.executeTakeFirstOrThrow(),
		).toEqual({ status: "running" });
	});

	it("counts persisted design-issue attempts for the slice budget", async () => {
		const sessionId = await seedHeldSession();
		const args = await attemptArgs(sessionId);
		const { attempt } = await beginOrRecoverSliceAttempt(args);
		await markSliceAttempt({
			...args,
			attemptId: attempt.id,
			to: "design-issue",
			failureCode: "platform-gap",
		});
		expect(
			await countDesignIssueAttempts({
				designSessionId: sessionId,
				buildPlanId: args.buildPlanId,
				sliceId: args.sliceId,
			}),
		).toBe(1);
	});
});
