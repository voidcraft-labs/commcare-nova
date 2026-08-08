/**
 * The orchestration event chain + slice attempts against a REAL Postgres —
 * §20.16's structural half: predecessor uniqueness rejects forks, the fold
 * re-proves the whole chain, and one running attempt per slice.
 */

import { describe, expect, it } from "vitest";
import { asDesignId } from "@/lib/agent/design/ids";
import { setupAppStateTestDb } from "@/lib/db/__tests__/appStateTestDb";
import {
	appendOrchestrationEvent,
	type BuildOrchestratorState,
	OrchestrationForkError,
	readOrchestrationHead,
} from "../orchestratorState";
import {
	beginOrRecoverSliceAttempt,
	loadRunningSliceAttempt,
	markSliceAttempt,
} from "../sliceAttempts";

const h = setupAppStateTestDb("orchestrator_state_");

const RUN = "run-orch";
const NONCE = "6a0a35a4-1111-4222-8333-944445555666";
const DIGEST = "a".repeat(64);

function designing(designSessionId: string): BuildOrchestratorState {
	return { kind: "designing", designSessionId, sourcePackageDigest: DIGEST };
}

describe("orchestration event chain", () => {
	it("appends, folds, and refuses a forked continuation", async () => {
		const sessionId = await h.seedDesignSession();
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

	it("the fold fails closed on a tampered payload", async () => {
		const sessionId = await h.seedDesignSession();
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
		const sessionId = await h.seedDesignSession();
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
		const sessionId = await h.seedDesignSession();
		const args = await attemptArgs(sessionId);
		const { attempt } = await beginOrRecoverSliceAttempt(args);
		await markSliceAttempt(attempt.id, "failed", "budget-exhausted");
		/* A stale second terminal write is a no-op — the CAS on `running`. */
		await markSliceAttempt(attempt.id, "design-issue");
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
});
