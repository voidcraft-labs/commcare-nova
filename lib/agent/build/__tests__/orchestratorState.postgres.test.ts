/** Native Postgres evidence for event ordering, authority, and atomic completion. */

import type { Client } from "pg";
import { afterEach, describe, expect, it } from "vitest";
import { whileBlocked } from "@/__tests__/helpers/postgresBarrier";
import { setupAppStateTestDb } from "@/lib/db/__tests__/appStateTestDb";
import { reapStaleGenerating } from "@/lib/db/apps";
import { hasUnfinishedMaterializedDesignInTransaction } from "@/lib/db/unfinishedMaterializedDesign";
import {
	__setCompletionCommitFaultHookForTests,
	appendOrchestrationEvent as appendOrchestrationEventAuthorized,
	type BuildOrchestratorState,
	buildOrchestratorStateSchema,
	completeBuildOrchestration,
	OrchestrationForkError,
	readOrchestrationHead,
} from "../orchestratorState";

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

function planning(): BuildOrchestratorState {
	return { kind: "planning", sourceDigest: DIGEST };
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
				state: planning(),
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
				state: planning(),
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
				state: planning(),
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
			state: planning(),
			expectedHead: null,
		});
		expect(first.revision).toBe(1);

		const second = await appendOrchestrationEvent({
			designSessionId: sessionId,
			runId: RUN,
			holderNonce: NONCE,
			state: {
				kind: "building",
				appId: null,
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
		expect(head?.state.kind).toBe("building");
		expect(head?.eventId).toBe(second.eventId);
		expect(head?.digest).toBe(second.digest);
	});

	it.each([true, false])(
		"observes competing appenders before releasing the authority lock (identical=%s)",
		async (identical) => {
			const designSessionId = await seedHeldSession();
			const states = [
				planning(),
				{
					...planning(),
					sourceDigest: identical ? DIGEST : "b".repeat(64),
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
					.selectFrom("authoring_events")
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
				state: planning(),
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
						kind: "building",
						appId: null,
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
			state: planning(),
			expectedHead: null,
		});
		const second = await appendOrchestrationEvent({
			designSessionId,
			runId: RUN,
			holderNonce: NONCE,
			state: {
				kind: "building",
				appId: null,
			},
			expectedHead: first,
		});
		let expected: RegExp;
		if (corruption === "kind") {
			await h
				.db()
				.updateTable("authoring_events")
				.set({ kind: "building" })
				.where("event_id", "=", first.eventId)
				.execute();
			expected = /folds to planning/;
		} else if (
			corruption === "payload" ||
			corruption === "unknown-payload-field"
		) {
			const payload =
				corruption === "payload"
					? { ...first.state, sourceDigest: "f".repeat(64) }
					: { ...first.state, unexpected: true };
			await h
				.db()
				.updateTable("authoring_events")
				.set({ payload: JSON.stringify(payload) })
				.where("event_id", "=", first.eventId)
				.execute();
			expected =
				corruption === "payload" ? /pins predecessor digest/ : /unexpected/;
		} else if (corruption === "predecessor-digest") {
			await h
				.db()
				.updateTable("authoring_events")
				.set({ predecessor_digest: "f".repeat(64) })
				.where("event_id", "=", second.eventId)
				.execute();
			expected = /pins predecessor digest/;
		} else if (corruption === "predecessor-id") {
			await h
				.db()
				.updateTable("authoring_events")
				.set({ predecessor_event_id: crypto.randomUUID() })
				.where("event_id", "=", second.eventId)
				.execute();
			expected = /names predecessor/;
		} else {
			await h
				.db()
				.updateTable("authoring_events")
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

describe("materialized build freeze in PostgreSQL", () => {
	const id = "11111111-1111-4111-8111-111111111111";
	const cases: Array<[BuildOrchestratorState | null, boolean]> = [
		[null, true],
		[{ kind: "planning", sourceDigest: DIGEST }, true],
		[{ kind: "building", appId: null }, true],
		[{ kind: "reviewing-plan", reviewId: id }, true],
		[{ kind: "reviewing-app", reviewId: id, appSeq: 1 }, true],
		[{ kind: "awaiting-input" }, true],
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
				errorType: "internal",
			},
			true,
		],
		[{ kind: "finished", appId: "app", appSeq: 1 }, false],
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
					.insertInto("authoring_events")
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
