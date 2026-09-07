/**
 * The orchestration event chain + slice attempts against a REAL Postgres —
 * §20.16's structural half: predecessor uniqueness rejects forks, the fold
 * re-proves the whole chain, and one running attempt per slice.
 */

import { sql } from "kysely";
import type { Client } from "pg";
import { afterEach, describe, expect, it } from "vitest";
import { whileBlocked } from "@/__tests__/helpers/postgresBarrier";
import { emptyGenesisBase } from "@/lib/agent/change-set/baseLoader";
import { beginGenesisChangeSet } from "@/lib/agent/change-set/store";
import { persistAcceptedDesignFixture } from "@/lib/agent/design/__tests__/persistedFixtures";
import { asDesignId } from "@/lib/agent/design/ids";
import { setupAppStateTestDb } from "@/lib/db/__tests__/appStateTestDb";
import { reapStaleGenerating } from "@/lib/db/apps";
import { hasUnfinishedMaterializedDesignInTransaction } from "@/lib/db/unfinishedMaterializedDesign";
import { briefDigest, deriveSliceExecutionBrief } from "../executionBrief";
import {
	__setCompletionCommitFaultHookForTests,
	appendOrchestrationEvent as appendOrchestrationEventAuthorized,
	type BuildOrchestratorState,
	buildOrchestratorStateSchema,
	completeBuildOrchestration,
	OrchestrationForkError,
	readOrchestrationHead,
} from "../orchestratorState";
import {
	beginOrRecoverSliceAttempt,
	beginSliceAttemptOutcomeCollection,
	claimSliceAttemptBudget,
	countSliceRebaseAttempts,
	finishSliceAttemptOutcomeCollection,
	loadRunningSliceAttempt,
	markSliceAttempt,
	recordSliceAttemptDiagnostic,
	supersedeSliceAttempt,
} from "../sliceAttempts";

const h = setupAppStateTestDb("orchestrator_state_", {
	poolMax: 3,
	authSchema: "migrated",
});

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

async function observeWaitingWriters(controller: Client, count: number) {
	const deadline = Date.now() + 2_000;
	for (;;) {
		await controller.query("SELECT pg_stat_clear_snapshot()");
		const result = await controller.query<{ count: number }>(
			"SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'",
		);
		if (result.rows[0].count >= count) return;
		if (Date.now() >= deadline)
			throw new Error(
				`Only ${result.rows[0].count} of ${count} writers reached PostgreSQL lock waits`,
			);
		await new Promise<void>((resolve) => setImmediate(resolve));
	}
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

	it.each(["app-sequence", "predecessor"] as const)(
		"rolls completion and settlement back on a false %s",
		async (fault) => {
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
			// This suite isolates control-row completion at an existing canonical
			// app revision; publication of the revision is owned by commit tests.
			await h
				.db()
				.updateTable("apps")
				.set({ mutation_seq: 1 })
				.where("id", "=", appId)
				.execute();
			const designSessionId = await h.seedDesignSession({
				owner_user_id: ACTOR,
				project_id: PROJECT,
				proposed_app_id: appId,
				app_id: appId,
				state: "materialized",
			});
			const first = await appendOrchestrationEvent({
				designSessionId,
				runId: RUN,
				holderNonce: NONCE,
				state: designing(designSessionId),
				expectedHead: null,
			});
			const before = await h.readAppRow(appId);
			await expect(
				completeBuildOrchestration({
					designSessionId,
					runId: RUN,
					holderNonce: NONCE,
					actorUserId: ACTOR,
					expectedProjectId: PROJECT,
					appId,
					expectedSeq: fault === "app-sequence" ? 2 : 1,
					expectedHead:
						fault === "predecessor"
							? { ...first, digest: "f".repeat(64) }
							: first,
				}),
			).rejects.toMatchObject({
				name:
					fault === "predecessor"
						? "OrchestrationForkError"
						: "RunHolderLostError",
			});
			expect(await h.readAppRow(appId)).toEqual(before);
			expect(await readOrchestrationHead(designSessionId)).toEqual(first);
		},
	);

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

	it.each([true, false])(
		"observes competing appenders before releasing the authority lock (identical=%s)",
		async (identical) => {
			const designSessionId = await seedHeldSession();
			const states = [
				designing(designSessionId),
				{
					...designing(designSessionId),
					sourcePackageDigest: identical ? DIGEST : "b".repeat(64),
				},
			];
			const outcomes = await whileBlocked(
				h,
				(pg) =>
					pg.query("SELECT id FROM design_sessions WHERE id=$1 FOR UPDATE", [
						designSessionId,
					]),
				() =>
					Promise.allSettled(
						states.map((state) =>
							appendOrchestrationEvent({
								designSessionId,
								runId: RUN,
								holderNonce: NONCE,
								state,
								expectedHead: null,
							}),
						),
					),
				async (settled, controller) => {
					expect(settled).toBe(false);
					await observeWaitingWriters(controller, 2);
				},
			);
			const successes = outcomes.filter(
				(outcome) => outcome.status === "fulfilled",
			);
			const failures = outcomes.filter(
				(outcome) => outcome.status === "rejected",
			);
			expect(successes).toHaveLength(identical ? 2 : 1);
			expect(failures).toHaveLength(identical ? 0 : 1);
			if (identical) expect(successes[0]).toEqual(successes[1]);
			else expect(failures[0]?.reason).toBeInstanceOf(OrchestrationForkError);
			expect(await readOrchestrationHead(designSessionId)).toEqual(
				successes[0]?.value,
			);
			expect(
				await h
					.db()
					.selectFrom("design_orchestration_events")
					.select("event_id")
					.where("design_session_id", "=", designSessionId)
					.execute(),
			).toHaveLength(1);
		},
	);

	it.each(["digest", "eventId", "revision"] as const)(
		"refuses a false predecessor %s before persisting a poisoned chain",
		async (field) => {
			const designSessionId = await seedHeldSession();
			const first = await appendOrchestrationEvent({
				designSessionId,
				runId: RUN,
				holderNonce: NONCE,
				state: designing(designSessionId),
				expectedHead: null,
			});
			const expectedHead = {
				...first,
				...(field === "digest"
					? { digest: "f".repeat(64) }
					: field === "eventId"
						? { eventId: crypto.randomUUID() }
						: { revision: 4 }),
			};
			await expect(
				appendOrchestrationEvent({
					designSessionId,
					runId: RUN,
					holderNonce: NONCE,
					state: {
						kind: "planning",
						designRevisionId: crypto.randomUUID(),
						designRevisionDigest: DIGEST,
					},
					expectedHead,
				}),
			).rejects.toBeInstanceOf(OrchestrationForkError);
			expect(await readOrchestrationHead(designSessionId)).toEqual(first);
		},
	);

	it.each([
		"kind",
		"payload",
		"predecessor-digest",
		"predecessor-id",
		"revision-gap",
		"unknown-payload-field",
	] as const)("fails closed on stored %s corruption", async (corruption) => {
		const designSessionId = await seedHeldSession();
		const first = await appendOrchestrationEvent({
			designSessionId,
			runId: RUN,
			holderNonce: NONCE,
			state: designing(designSessionId),
			expectedHead: null,
		});
		const second = await appendOrchestrationEvent({
			designSessionId,
			runId: RUN,
			holderNonce: NONCE,
			state: {
				kind: "planning",
				designRevisionId: crypto.randomUUID(),
				designRevisionDigest: DIGEST,
			},
			expectedHead: first,
		});
		let expected: RegExp;
		if (corruption === "kind") {
			await h
				.db()
				.updateTable("design_orchestration_events")
				.set({ kind: "planning" })
				.where("event_id", "=", first.eventId)
				.execute();
			expected = /folds to designing/;
		} else if (
			corruption === "payload" ||
			corruption === "unknown-payload-field"
		) {
			const payload =
				corruption === "payload"
					? { ...first.state, sourcePackageDigest: "f".repeat(64) }
					: { ...first.state, unexpected: true };
			await h
				.db()
				.updateTable("design_orchestration_events")
				.set({ payload: JSON.stringify(payload) })
				.where("event_id", "=", first.eventId)
				.execute();
			expected =
				corruption === "payload" ? /pins predecessor digest/ : /unexpected/;
		} else if (corruption === "predecessor-digest") {
			await h
				.db()
				.updateTable("design_orchestration_events")
				.set({ predecessor_digest: "f".repeat(64) })
				.where("event_id", "=", second.eventId)
				.execute();
			expected = /pins predecessor digest/;
		} else if (corruption === "predecessor-id") {
			await h
				.db()
				.updateTable("design_orchestration_events")
				.set({ predecessor_event_id: crypto.randomUUID() })
				.where("event_id", "=", second.eventId)
				.execute();
			expected = /names predecessor/;
		} else {
			await h
				.db()
				.updateTable("design_orchestration_events")
				.set({ revision: 3 })
				.where("event_id", "=", second.eventId)
				.execute();
			expected = /not contiguous/;
		}
		await expect(readOrchestrationHead(designSessionId)).rejects.toThrow(
			expected,
		);
	});
});

describe("slice attempts", () => {
	async function attemptArgs(sessionId: string) {
		const persisted = await persistAcceptedDesignFixture({
			designSessionId: sessionId,
			authority: {
				actorUserId: ACTOR,
				runId: RUN,
				holderNonce: NONCE,
				expectedProjectId: PROJECT,
			},
		});
		const plan = persisted.plan.envelope.payload;
		const slice = plan.slices[0];
		if (!slice) throw new Error("Fixture plan has no slice");
		const brief = deriveSliceExecutionBrief({
			contract: persisted.accepted.envelope.payload,
			revision: {
				id: persisted.accepted.id,
				digest: persisted.accepted.artifactDigest,
			},
			plan,
			sliceId: slice.id,
		});
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
			designRevisionId: persisted.accepted.id,
			designRevisionDigest: persisted.accepted.artifactDigest,
			buildPlanId: persisted.plan.id,
			buildPlanDigest: persisted.plan.planDigest,
			sliceId: slice.id,
			baseTarget: {
				kind: "empty-genesis" as const,
				proposedAppId: session.proposed_app_id,
				digest: emptyGenesisBase(session.proposed_app_id).digest,
			},
			executorModel: "test-model",
			promptVersion: "build-executor-v1",
			briefDigest: briefDigest(brief),
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

	it("serializes two attempt births into one durable attempt", async () => {
		const designSessionId = await seedHeldSession();
		const args = await attemptArgs(designSessionId);
		const outcomes = await whileBlocked(
			h,
			(pg) =>
				pg.query("SELECT id FROM design_sessions WHERE id=$1 FOR UPDATE", [
					designSessionId,
				]),
			() =>
				Promise.all([
					beginOrRecoverSliceAttempt(args),
					beginOrRecoverSliceAttempt(args),
				]),
			async (settled, controller) => {
				expect(settled).toBe(false);
				await observeWaitingWriters(controller, 2);
			},
		);
		expect(outcomes.map((outcome) => outcome.recovered).sort()).toEqual([
			false,
			true,
		]);
		expect(outcomes[0].attempt.id).toBe(outcomes[1].attempt.id);
		expect(
			await h
				.db()
				.selectFrom("design_slice_attempts")
				.select("id")
				.where("design_session_id", "=", designSessionId)
				.execute(),
		).toEqual([{ id: outcomes[0].attempt.id }]);
	});

	it.each(["same-key", "different-keys"] as const)(
		"serializes a final budget unit for %s",
		async (mode) => {
			const designSessionId = await seedHeldSession();
			const args = await attemptArgs(designSessionId);
			const { attempt } = await beginOrRecoverSliceAttempt(args);
			const claim = (claimKey: string) =>
				claimSliceAttemptBudget({
					...args,
					attemptId: attempt.id,
					counter: "modelSteps",
					limit: 1,
					claimKey,
				});
			const outcomes = await whileBlocked(
				h,
				(pg) =>
					pg.query("SELECT id FROM design_sessions WHERE id=$1 FOR UPDATE", [
						designSessionId,
					]),
				() =>
					Promise.all([
						claim("call-1"),
						claim(mode === "same-key" ? "call-1" : "call-2"),
					]),
				async (settled, controller) => {
					expect(settled).toBe(false);
					await observeWaitingWriters(controller, 2);
				},
			);
			expect(outcomes.sort()).toEqual(
				mode === "same-key"
					? ["claimed", "replayed"]
					: ["claimed", "exhausted"],
			);
			expect(
				await h
					.db()
					.selectFrom("design_slice_attempts")
					.select("model_steps_used")
					.where("id", "=", attempt.id)
					.executeTakeFirstOrThrow(),
			).toEqual({ model_steps_used: 1 });
			expect(
				await h
					.db()
					.selectFrom("design_slice_attempt_budget_claims")
					.select("claim_key")
					.where("attempt_id", "=", attempt.id)
					.execute(),
			).toHaveLength(1);
		},
	);

	it("rechecks the holder after waiting, before birthing an attempt", async () => {
		const designSessionId = await seedHeldSession();
		const args = await attemptArgs(designSessionId);
		await expect(
			whileBlocked(
				h,
				(pg) =>
					pg.query("SELECT id FROM design_sessions WHERE id=$1 FOR UPDATE", [
						designSessionId,
					]),
				() => beginOrRecoverSliceAttempt(args),
				async (settled, controller) => {
					expect(settled).toBe(false);
					await controller.query(
						"UPDATE design_sessions SET run_holder_nonce=$1 WHERE id=$2",
						[crypto.randomUUID(), designSessionId],
					);
				},
				undefined,
				"COMMIT",
			),
		).rejects.toMatchObject({ name: "RunHolderLostError" });
		expect(
			await h
				.db()
				.selectFrom("design_slice_attempts")
				.select("id")
				.where("design_session_id", "=", designSessionId)
				.execute(),
		).toEqual([]);
	});

	it("rolls private-set closure back when the attempt's terminal write fails", async () => {
		const designSessionId = await seedHeldSession();
		const args = await attemptArgs(designSessionId);
		const { attempt } = await beginOrRecoverSliceAttempt(args);
		const changeSet = await openGenesisForAttempt(args, attempt.id);
		await h
			.pool()
			.query(`CREATE FUNCTION reject_test_attempt_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected attempt write failure'; END $$;
            CREATE TRIGGER test_attempt_failure BEFORE UPDATE ON design_slice_attempts FOR EACH ROW WHEN (NEW.status = 'failed') EXECUTE FUNCTION reject_test_attempt_failure();`);
		await expect(
			markSliceAttempt({
				...args,
				attemptId: attempt.id,
				to: "failed",
				failureCode: "budget-exhausted",
			}),
		).rejects.toThrow("injected attempt write failure");
		expect(
			await h
				.db()
				.selectFrom("design_change_sets")
				.select("status")
				.where("id", "=", changeSet.id)
				.executeTakeFirstOrThrow(),
		).toEqual({ status: "open" });
		expect(
			await h
				.db()
				.selectFrom("design_slice_attempts")
				.select(["status", "failure_code"])
				.where("id", "=", attempt.id)
				.executeTakeFirstOrThrow(),
		).toEqual({ status: "running", failure_code: null });
	});

	it("admits each budget counter independently and refuses cross-counter replay without writes", async () => {
		const designSessionId = await seedHeldSession();
		const args = await attemptArgs(designSessionId);
		const { attempt } = await beginOrRecoverSliceAttempt(args);
		for (const counter of [
			"modelSteps",
			"mutationCalls",
			"commitAttempts",
			"blockerReports",
		] as const) {
			expect(
				await claimSliceAttemptBudget({
					...args,
					attemptId: attempt.id,
					counter,
					limit: 0,
					claimKey: counter,
				}),
			).toBe("exhausted");
			expect(
				await claimSliceAttemptBudget({
					...args,
					attemptId: attempt.id,
					counter,
					limit: 1,
					claimKey: counter,
				}),
			).toBe("claimed");
		}
		const before = await h
			.db()
			.selectFrom("design_slice_attempts")
			.selectAll()
			.where("id", "=", attempt.id)
			.executeTakeFirstOrThrow();
		await expect(
			claimSliceAttemptBudget({
				...args,
				attemptId: attempt.id,
				counter: "blockerReports",
				limit: 2,
				claimKey: "modelSteps",
			}),
		).rejects.toMatchObject({ name: "SliceAttemptStateError" });
		expect(
			await h
				.db()
				.selectFrom("design_slice_attempts")
				.selectAll()
				.where("id", "=", attempt.id)
				.executeTakeFirstOrThrow(),
		).toEqual(before);
		const claims = await h
			.db()
			.selectFrom("design_slice_attempt_budget_claims")
			.select(["counter", "claim_key"])
			.where("attempt_id", "=", attempt.id)
			.orderBy("counter")
			.execute();
		expect(claims).toEqual(
			["blockerReports", "commitAttempts", "modelSteps", "mutationCalls"].map(
				(counter) => ({ counter, claim_key: counter }),
			),
		);
	});

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
			outcome: "mutation-rejected",
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
					"private_mutation_rejected_count",
					"validator_repair_count",
					"outcome_evidence_state",
				])
				.where("id", "=", attempt.id)
				.executeTakeFirstOrThrow(),
		).toEqual({
			wire_invalid_count: 1,
			private_mutation_rejected_count: 1,
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

	it("accrues wall-clock only at genuine claims and forgives the dead gap on recovery", async () => {
		const sessionId = await seedHeldSession();
		const args = await attemptArgs(sessionId);
		const { attempt } = await beginOrRecoverSliceAttempt(args);
		const authority = { ...args, attemptId: attempt.id };
		expect(attempt.wallClockMsUsed).toBe(0);
		const readSpend = async () =>
			Number(
				(
					await h
						.db()
						.selectFrom("design_slice_attempts")
						.select("wall_clock_ms_used")
						.where("id", "=", attempt.id)
						.executeTakeFirstOrThrow()
				).wall_clock_ms_used,
			);
		const backdateAccrual = (minutes: number) =>
			h
				.db()
				.updateTable("design_slice_attempts")
				.set({
					wall_clock_accrued_at: sql`now() - make_interval(mins => ${minutes})`,
				})
				.where("id", "=", attempt.id)
				.execute();

		/* Five minutes of active work since the last accrual point: the next
		 * genuine claim charges it. */
		await backdateAccrual(5);
		expect(
			await claimSliceAttemptBudget({
				...authority,
				counter: "modelSteps",
				limit: 10,
				claimKey: "step:1",
			}),
		).toBe("claimed");
		const afterActive = await readSpend();
		expect(afterActive).toBeGreaterThanOrEqual(5 * 60_000);
		expect(afterActive).toBeLessThan(6 * 60_000);

		/* A replayed claim never accrues. */
		await backdateAccrual(5);
		expect(
			await claimSliceAttemptBudget({
				...authority,
				counter: "modelSteps",
				limit: 10,
				claimKey: "step:1",
			}),
		).toBe("replayed");
		expect(await readSpend()).toBe(afterActive);

		/* The process dies; thirty minutes pass before a replacement holder
		 * recovers the attempt. Recovery resets the accrual point without
		 * accruing, so the recovered attempt still holds only its active
		 * spend and the next claim charges only post-recovery time. */
		await backdateAccrual(30);
		const recovered = await beginOrRecoverSliceAttempt(args);
		expect(recovered.recovered).toBe(true);
		expect(recovered.attempt.wallClockMsUsed).toBe(afterActive);
		expect(
			await claimSliceAttemptBudget({
				...authority,
				counter: "modelSteps",
				limit: 10,
				claimKey: "step:2",
			}),
		).toBe("claimed");
		const afterRecovery = await readSpend();
		expect(afterRecovery - afterActive).toBeLessThan(60_000);
	});

	it("recovers the running attempt when digests match, supersedes it when they moved", async () => {
		const sessionId = await seedHeldSession();
		const args = await attemptArgs(sessionId);
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
				counter: "mutationCalls",
				limit: 2,
				claimKey: "stage:attempt:1:0",
			}),
		).resolves.toBe("claimed");
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
			mutationCalls: 1,
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
		/* The only persisted attempt is terminal. */
		const running = await loadRunningSliceAttempt(sessionId);
		expect(running).toBeNull();
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

// Stored-reader fixtures isolate the freeze query's classification and scoping.
// App completion and its settlement transaction are exercised above.
describe("materialized build freeze in PostgreSQL", () => {
	const id = "11111111-1111-4111-8111-111111111111";
	const cases: Array<[BuildOrchestratorState | null, boolean]> = [
		[null, true],
		[
			{ kind: "designing", designSessionId: id, sourcePackageDigest: DIGEST },
			true,
		],
		[
			{ kind: "planning", designRevisionId: id, designRevisionDigest: DIGEST },
			true,
		],
		[
			{
				kind: "awaiting-user",
				designSessionId: id,
				designRevisionId: id,
				blockingQuestionIds: [asDesignId(id)],
			},
			true,
		],
		[
			{
				kind: "awaiting-user-questions",
				designSessionId: id,
				designRevisionId: null,
			},
			true,
		],
		[
			{
				kind: "executing-slice",
				designRevisionId: id,
				buildPlanId: id,
				sliceId: asDesignId(id),
				changeSetId: id,
				attempt: 1,
			},
			true,
		],
		[
			{
				kind: "translating",
				designRevisionId: id,
				buildPlanId: id,
				appId: "app",
				sourceSeq: 1,
			},
			true,
		],
		[
			{
				kind: "failed",
				failureId: id,
				recoverable: true,
				errorType: "provider",
			},
			true,
		],
		[
			{
				kind: "failed",
				failureId: id,
				recoverable: false,
				errorType: "compiler",
			},
			true,
		],
		[{ kind: "finished", appId: "app", appSeq: 1 }, false],
		[{ kind: "accepted-partial", appId: "app", appSeq: 1 }, false],
	];
	it.each(cases)(
		"classifies stored head %j with frozen=%s",
		async (state, frozen) => {
			const appId = await h.seedApp();
			const designSessionId = await h.seedDesignSession({
				app_id: appId,
				proposed_app_id: appId,
				state: "materialized",
			});
			if (state !== null) {
				const parsed = buildOrchestratorStateSchema.parse(state);
				await h
					.db()
					.insertInto("design_orchestration_events")
					.values({
						design_session_id: designSessionId,
						revision: 1,
						event_id: crypto.randomUUID(),
						predecessor_event_id: null,
						predecessor_digest: null,
						run_id: RUN,
						holder_nonce_digest: DIGEST,
						kind: parsed.kind,
						payload: JSON.stringify(parsed),
					})
					.execute();
			}
			expect(
				await h.withTransaction((tx) =>
					hasUnfinishedMaterializedDesignInTransaction(tx, appId),
				),
			).toBe(frozen);
			expect(
				await h.withTransaction((tx) =>
					hasUnfinishedMaterializedDesignInTransaction(tx, "unrelated-app"),
				),
			).toBe(false);
			await h
				.db()
				.updateTable("design_sessions")
				.set({ state: "abandoned", app_id: null })
				.where("id", "=", designSessionId)
				.execute();
			expect(
				await h.withTransaction((tx) =>
					hasUnfinishedMaterializedDesignInTransaction(tx, appId),
				),
			).toBe(false);
		},
	);
});
