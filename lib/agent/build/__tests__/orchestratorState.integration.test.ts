/**
 * The orchestration event chain + slice attempts against a REAL Postgres —
 * §20.16's structural half: predecessor uniqueness rejects forks, the fold
 * re-proves the whole chain, and one running attempt per slice.
 */

import { afterEach, describe, expect, it } from "vitest";
import { beginGenesisChangeSet } from "@/lib/agent/change-set/store";
import { asDesignId } from "@/lib/agent/design/ids";
import { setupAppStateTestDb } from "@/lib/db/__tests__/appStateTestDb";
import { reapStaleGenerating } from "@/lib/db/apps";
import {
	__setCompletionCommitFaultHookForTests,
	appendOrchestrationEvent as appendOrchestrationEventAuthorized,
	type BuildOrchestratorState,
	completeBuildOrchestration,
	OrchestrationForkError,
	readOrchestrationHead,
} from "../orchestratorState";
import {
	beginOrRecoverSliceAttempt,
	beginSliceAttemptOutcomeCollection,
	checkpointSliceAttemptFinalization,
	claimSliceAttemptBudget,
	countSliceRebaseAttempts,
	finishSliceAttemptOutcomeCollection,
	loadRunningSliceAttempt,
	markSliceAttempt,
	recordSliceAttemptDiagnostic,
	supersedeSliceAttempt,
} from "../sliceAttempts";

const h = setupAppStateTestDb("orchestrator_state_");

const RUN = "run-orch";
const NONCE = "6a0a35a4-1111-4222-8333-944445555666";
const ACTOR = "owner-test";
const PROJECT = "project-test";
const DIGEST = "a".repeat(64);

afterEach(() => {
	__setCompletionCommitFaultHookForTests(null);
});

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
	it("finishes the exact canonical head after a false stale-build reap", async () => {
		const appId = await h.seedApp({
			id: crypto.randomUUID(),
			owner: ACTOR,
			project_id: PROJECT,
			status: "generating",
			run_id: RUN,
			run_holder_nonce: NONCE,
			updated_at: new Date(Date.now() - 60 * 60_000),
			reservation: {
				period: "2026-08",
				reserved: 1,
				settled: false,
				userId: ACTOR,
				runId: RUN,
			},
		});
		await h
			.db()
			.updateTable("apps")
			.set({ mutation_seq: 1 })
			.where("id", "=", appId)
			.execute();
		const sessionId = await h.seedDesignSession({
			owner_user_id: ACTOR,
			project_id: PROJECT,
			proposed_app_id: appId,
			app_id: appId,
			state: "materialized",
		});

		await reapStaleGenerating(appId, {
			mode: "build",
			runId: RUN,
			nonce: NONCE,
		});
		expect((await h.readAppRow(appId))?.status).toBe("error");

		await expect(
			completeBuildOrchestration({
				designSessionId: sessionId,
				runId: RUN,
				holderNonce: NONCE,
				actorUserId: ACTOR,
				expectedProjectId: PROJECT,
				appId,
				expectedSeq: 1,
				expectedHead: null,
			}),
		).resolves.toMatchObject({
			state: { kind: "finished", appId, appSeq: 1 },
		});
		expect(
			await h
				.db()
				.selectFrom("apps")
				.select(["status", "error_type", "res_settled"])
				.where("id", "=", appId)
				.executeTakeFirstOrThrow(),
		).toEqual({ status: "complete", error_type: null, res_settled: true });
	});

	it("adopts a matching finished head when the terminal commit response is lost", async () => {
		const appId = await h.seedApp({
			id: crypto.randomUUID(),
			owner: ACTOR,
			project_id: PROJECT,
			status: "generating",
			run_id: RUN,
			run_holder_nonce: NONCE,
			reservation: {
				period: "2026-08",
				reserved: 1,
				settled: false,
				userId: ACTOR,
				runId: RUN,
			},
		});
		await h
			.db()
			.updateTable("apps")
			.set({ mutation_seq: 1 })
			.where("id", "=", appId)
			.execute();
		const sessionId = await h.seedDesignSession({
			owner_user_id: ACTOR,
			project_id: PROJECT,
			proposed_app_id: appId,
			app_id: appId,
			state: "materialized",
		});
		__setCompletionCommitFaultHookForTests(() => {
			throw new Error("connection closed after COMMIT");
		});

		await expect(
			completeBuildOrchestration({
				designSessionId: sessionId,
				runId: RUN,
				holderNonce: NONCE,
				actorUserId: ACTOR,
				expectedProjectId: PROJECT,
				appId,
				expectedSeq: 1,
				expectedHead: null,
			}),
		).resolves.toMatchObject({
			revision: 1,
			state: { kind: "finished", appId, appSeq: 1 },
		});
		expect(
			await h
				.db()
				.selectFrom("apps")
				.select(["status", "res_settled"])
				.where("id", "=", appId)
				.executeTakeFirstOrThrow(),
		).toEqual({ status: "complete", res_settled: true });
	});

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
		const session = await h
			.db()
			.selectFrom("design_sessions")
			.select("proposed_app_id")
			.where("id", "=", sessionId)
			.executeTakeFirstOrThrow();
		if (session.proposed_app_id === null) {
			throw new Error("held build session has no proposed app");
		}
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
				proposedAppId: session.proposed_app_id,
				digest: DIGEST,
			},
			executorModel: "test-model",
			promptVersion: "build-executor-v1",
			briefDigest: DIGEST,
		};
	}

	async function openGenesisForAttempt(
		args: Awaited<ReturnType<typeof attemptArgs>>,
		attemptId: string,
	) {
		if (args.baseTarget.kind !== "empty-genesis") {
			throw new Error("fixture is not genesis");
		}
		return beginGenesisChangeSet({
			proposedAppId: args.baseTarget.proposedAppId,
			projectId: PROJECT,
			baseSnapshotDigest: args.baseTarget.digest,
			lineage: {
				designSessionId: args.designSessionId,
				designRevisionId: args.designRevisionId,
				designRevisionDigest: args.designRevisionDigest,
				buildPlanId: args.buildPlanId,
				buildPlanDigest: args.buildPlanDigest,
				sliceId: asDesignId(args.sliceId),
				attemptId,
			},
			ownerUserId: args.actorUserId,
			ownerRunId: args.runId,
			attemptAuthority: {
				holderNonce: args.holderNonce,
				expectedProjectId: PROJECT,
			},
		});
	}

	it("opens and binds a change set under the exact holder in one transaction", async () => {
		const sessionId = await seedHeldSession();
		const args = await attemptArgs(sessionId);
		const { attempt } = await beginOrRecoverSliceAttempt(args);
		const changeSet = await openGenesisForAttempt(args, attempt.id);
		expect(
			await h
				.db()
				.selectFrom("design_slice_attempts")
				.select("change_set_id")
				.where("id", "=", attempt.id)
				.executeTakeFirstOrThrow(),
		).toEqual({ change_set_id: changeSet.id });
	});

	it("persists diagnostic counts and fails evidence closed across a lost process", async () => {
		const sessionId = await seedHeldSession();
		const args = await attemptArgs(sessionId);
		const { attempt } = await beginOrRecoverSliceAttempt(args);
		const authority = { ...args, attemptId: attempt.id };

		await beginSliceAttemptOutcomeCollection(authority);
		await recordSliceAttemptDiagnostic({
			...authority,
			outcome: "wire-invalid",
		});
		await recordSliceAttemptDiagnostic({
			...authority,
			outcome: "stage-rejected",
		});
		await recordSliceAttemptDiagnostic({
			...authority,
			outcome: "validator-repair",
		});
		await finishSliceAttemptOutcomeCollection(authority);
		expect(
			await h
				.db()
				.selectFrom("design_slice_attempts")
				.select([
					"wire_invalid_count",
					"stage_rejected_count",
					"validator_repair_count",
					"outcome_evidence_state",
				])
				.where("id", "=", attempt.id)
				.executeTakeFirstOrThrow(),
		).toEqual({
			wire_invalid_count: 1,
			stage_rejected_count: 1,
			validator_repair_count: 1,
			outcome_evidence_state: "complete",
		});

		await beginSliceAttemptOutcomeCollection(authority);
		/* A replacement begins while the prior collection is still open: there
		 * may have been an observed-but-uncheckpointed outcome, so completion can
		 * never restore this attempt's evidence to authoritative. */
		await beginSliceAttemptOutcomeCollection(authority);
		await finishSliceAttemptOutcomeCollection(authority);
		expect(
			await h
				.db()
				.selectFrom("design_slice_attempts")
				.select("outcome_evidence_state")
				.where("id", "=", attempt.id)
				.executeTakeFirstOrThrow(),
		).toEqual({ outcome_evidence_state: "incomplete" });
	});

	it("recovers the running attempt when digests match, supersedes it when they moved", async () => {
		const sessionId = await seedHeldSession();
		const args = await attemptArgs(sessionId);
		/* seedDesignLineage already minted a running attempt for its own slice;
		 * this test's slice id is fresh, so its lifecycle is isolated. */
		const first = await beginOrRecoverSliceAttempt(args);
		expect(first.recovered).toBe(false);
		expect(first.attempt.attempt).toBe(1);
		expect(first.attempt.status).toBe("running");
		const firstChangeSet = await openGenesisForAttempt(args, first.attempt.id);

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
		expect(
			await h
				.db()
				.selectFrom("design_change_sets")
				.select("status")
				.where("id", "=", firstChangeSet.id)
				.executeTakeFirstOrThrow(),
		).toEqual({ status: "superseded" });
	});

	it("adopts the exact running attempt and open change set after infrastructure replacement", async () => {
		const sessionId = await seedHeldSession();
		const oldArgs = await attemptArgs(sessionId);
		const first = await beginOrRecoverSliceAttempt(oldArgs);
		await expect(
			claimSliceAttemptBudget({
				...oldArgs,
				attemptId: first.attempt.id,
				counter: "modelSteps",
				limit: 2,
				claimKey: "model:attempt:1",
			}),
		).resolves.toBe("claimed");
		await expect(
			claimSliceAttemptBudget({
				...oldArgs,
				attemptId: first.attempt.id,
				counter: "modelSteps",
				limit: 1,
				claimKey: "model:attempt:1",
			}),
		).resolves.toBe("replayed");
		await expect(
			claimSliceAttemptBudget({
				...oldArgs,
				attemptId: first.attempt.id,
				counter: "stagedRequests",
				limit: 2,
				claimKey: "stage:attempt:1:0",
			}),
		).resolves.toBe("claimed");
		await checkpointSliceAttemptFinalization({
			...oldArgs,
			attemptId: first.attempt.id,
			validationRequested: true,
			eligible: true,
		});
		const firstChangeSet = await openGenesisForAttempt(
			oldArgs,
			first.attempt.id,
		);
		const nextRunId = "run-orch-next";
		const nextNonce = "7b0b35b4-1111-4222-8333-944445555666";
		await h
			.db()
			.updateTable("design_sessions")
			.set({
				run_id: nextRunId,
				res_run_id: nextRunId,
				run_holder_nonce: nextNonce,
				run_lease_expires_at: new Date(Date.now() + 60_000),
			})
			.where("id", "=", sessionId)
			.execute();

		const next = await beginOrRecoverSliceAttempt({
			...oldArgs,
			runId: nextRunId,
			holderNonce: nextNonce,
		});
		expect(next.recovered).toBe(true);
		expect(next.attempt.id).toBe(first.attempt.id);
		expect(next.attempt.attempt).toBe(1);
		expect(next.attempt.startedAt.getTime()).toBe(
			first.attempt.startedAt.getTime(),
		);
		expect(next.attempt.budgetSpent).toMatchObject({
			modelSteps: 1,
			stagedRequests: 1,
		});
		expect(next.attempt.finalizationCheckpoint).toEqual({
			validationRequested: true,
			eligible: true,
		});
		expect(next.attempt.executionRunIds).toEqual([RUN, nextRunId]);
		await expect(
			claimSliceAttemptBudget({
				...oldArgs,
				runId: nextRunId,
				holderNonce: nextNonce,
				attemptId: first.attempt.id,
				counter: "modelSteps",
				limit: 1,
				claimKey: "model:attempt:2",
			}),
		).resolves.toBe("exhausted");
		await expect(
			claimSliceAttemptBudget({
				...oldArgs,
				runId: nextRunId,
				holderNonce: nextNonce,
				attemptId: first.attempt.id,
				counter: "modelSteps",
				limit: 2,
				claimKey: "model:attempt:2",
			}),
		).resolves.toBe("claimed");
		expect(
			await h
				.db()
				.selectFrom("design_slice_attempts")
				.select(["validation_requested", "finalization_eligible"])
				.where("id", "=", first.attempt.id)
				.executeTakeFirstOrThrow(),
		).toEqual({
			validation_requested: true,
			finalization_eligible: false,
		});
		expect(
			await h
				.db()
				.selectFrom("design_slice_attempts")
				.select(["status", "failure_code"])
				.where("id", "=", first.attempt.id)
				.executeTakeFirstOrThrow(),
		).toEqual({ status: "running", failure_code: null });
		expect(
			await h
				.db()
				.selectFrom("design_change_sets")
				.select(["status", "owner_user_id", "owner_run_id"])
				.where("id", "=", firstChangeSet.id)
				.executeTakeFirstOrThrow(),
		).toEqual({
			status: "open",
			owner_user_id: ACTOR,
			owner_run_id: nextRunId,
		});
	});

	it("supersedes the attempt and private set before a semantic rebase retry", async () => {
		const sessionId = await seedHeldSession();
		const args = await attemptArgs(sessionId);
		const first = await beginOrRecoverSliceAttempt(args);
		const firstChangeSet = await openGenesisForAttempt(args, first.attempt.id);
		await supersedeSliceAttempt({
			...args,
			attemptId: first.attempt.id,
			failureCode: "rebase-conflict",
		});
		expect(
			await h
				.db()
				.selectFrom("design_slice_attempts")
				.select(["status", "failure_code"])
				.where("id", "=", first.attempt.id)
				.executeTakeFirstOrThrow(),
		).toEqual({ status: "superseded", failure_code: "rebase-conflict" });
		expect(
			await h
				.db()
				.selectFrom("design_change_sets")
				.select("status")
				.where("id", "=", firstChangeSet.id)
				.executeTakeFirstOrThrow(),
		).toEqual({ status: "superseded" });
		expect(
			await countSliceRebaseAttempts({
				designSessionId: args.designSessionId,
				buildPlanId: args.buildPlanId,
				sliceId: args.sliceId,
			}),
		).toBe(1);
		const second = await beginOrRecoverSliceAttempt(args);
		expect(second.attempt.attempt).toBe(2);
		await supersedeSliceAttempt({
			...args,
			attemptId: second.attempt.id,
			failureCode: "read-set-stale",
		});
		expect(
			await countSliceRebaseAttempts({
				designSessionId: args.designSessionId,
				buildPlanId: args.buildPlanId,
				sliceId: args.sliceId,
			}),
		).toBe(2);
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
				to: "failed",
				failureCode: "different-failure",
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

	it("does not rerun a deterministic budget-exhausted attempt under a new holder", async () => {
		const sessionId = await seedHeldSession();
		const args = await attemptArgs(sessionId);
		const { attempt } = await beginOrRecoverSliceAttempt(args);
		const changeSet = await openGenesisForAttempt(args, attempt.id);
		await markSliceAttempt({
			...args,
			attemptId: attempt.id,
			to: "failed",
			failureCode: "budget-exhausted",
		});

		const nextRunId = "run-orch-budget-resume";
		const nextNonce = "8c1c46c5-2222-4333-8444-a55556666777";
		await h
			.db()
			.updateTable("design_sessions")
			.set({
				run_id: nextRunId,
				res_run_id: nextRunId,
				run_holder_nonce: nextNonce,
				run_lease_expires_at: new Date(Date.now() + 60_000),
			})
			.where("id", "=", sessionId)
			.execute();

		await expect(
			beginOrRecoverSliceAttempt({
				...args,
				runId: nextRunId,
				holderNonce: nextNonce,
			}),
		).rejects.toMatchObject({ name: "TerminalSliceAttemptError" });
		expect(
			await h
				.db()
				.selectFrom("design_change_sets")
				.select(["status", "owner_user_id", "owner_run_id"])
				.where("id", "=", changeSet.id)
				.executeTakeFirstOrThrow(),
		).toEqual({
			status: "abandoned",
			owner_user_id: ACTOR,
			owner_run_id: args.runId,
		});
	});

	it("permits a fresh attempt after the immutable compiler inputs change", async () => {
		const sessionId = await seedHeldSession();
		const args = await attemptArgs(sessionId);
		const { attempt } = await beginOrRecoverSliceAttempt(args);
		await openGenesisForAttempt(args, attempt.id);
		await markSliceAttempt({
			...args,
			attemptId: attempt.id,
			to: "failed",
			failureCode: "budget-exhausted",
		});

		const next = await beginOrRecoverSliceAttempt({
			...args,
			briefDigest: "c".repeat(64),
		});

		expect(next.recovered).toBe(false);
		expect(next.attempt.attempt).toBe(2);
		expect(next.attempt.status).toBe("running");
		expect(next.attempt.briefDigest).toBe("c".repeat(64));
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
});
