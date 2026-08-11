/**
 * The durable staging protocol against a REAL Postgres — the §20.5
 * statement-boundary fault matrix plus the idempotency, authority, and
 * exclusivity laws the store owns.
 *
 * What this pins:
 *
 *   - a stage request commits its receipt, step, stage ranges, handle
 *     bindings, and the revision advance as ONE transaction: a fault at ANY
 *     statement boundary persists nothing, and the SAME request then stages
 *     cleanly;
 *   - a committed request replays verbatim by `(requestId, digest)` and a
 *     reused id with different content latches as a collision;
 *   - a stale expected revision rejects before anything appends, so two
 *     process continuations cannot allocate the same or inverted ordinal;
 *   - the batch-exclusive fence and owner/status/Project proofs hold under
 *     the lock;
 *   - lifecycle transitions (abandon/supersede) are exact-owner writes and
 *     closed sets stage nothing further.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { asDesignId } from "@/lib/agent/design/ids";
import { setupAppStateTestDb } from "@/lib/db/__tests__/appStateTestDb";
import { createExplicitBlankApp } from "@/lib/db/appGenesis";
import { admitMutationBatch } from "@/lib/doc/mutationAdmission";
import { asUuid } from "@/lib/domain/uuid";
import { emptyGenesisBase } from "../baseLoader";
import { canonicalJsonDigest, stagingInputDigest } from "../digest";
import {
	ChangeSetRequestIdCollisionError,
	ChangeSetScopeLostError,
	ChangeSetWorkspaceRevisionStaleError,
} from "../errors";
import type { ChangeSetDiagnosticsSummary } from "../schemas";
import { changeSetHandleSchema } from "../schemas";
import {
	__setStageTransactionFaultHookForTests,
	abandonChangeSet,
	beginAppEditChangeSet,
	beginGenesisChangeSet,
	loadChangeSet,
	loadChangeSetSteps,
	loadHandleBindings,
	lookupStageRequest,
	type StageChangeSetRequestArgs,
	type StageTransactionBoundary,
	stageChangeSetRequest,
	supersedeChangeSet,
} from "../store";
import type { ChangeSetLineage } from "../types";

const h = setupAppStateTestDb("change_set_store_");

const ACTOR = "actor-user";
const PROJECT = "project-test";
const RUN = "run-1";

/* Every change-set identity column is FK-bound (design_sessions with the
 * design-session unit; revision/plan/attempt with the orchestrator unit),
 * so the lineage helper seeds the whole FK-valid chain. */
async function lineage(): Promise<ChangeSetLineage> {
	const seeded = await h.seedDesignLineage();
	return {
		purpose: "slice",
		designSessionId: seeded.designSessionId,
		designRevisionId: seeded.designRevisionId,
		designRevisionDigest: seeded.designRevisionDigest,
		buildPlanId: seeded.buildPlanId,
		buildPlanDigest: seeded.buildPlanDigest,
		sliceId: asDesignId(seeded.sliceId),
		attemptId: seeded.attemptId,
	};
}

async function createTestApp(): Promise<string> {
	await h.seedProjectMember(ACTOR, PROJECT, "owner");
	const receipt = await createExplicitBlankApp(
		ACTOR,
		PROJECT,
		crypto.randomUUID(),
		{
			name: "Change-set store app",
			status: "complete",
		},
	);
	return receipt.appId;
}

async function openAppEditSet(appId: string) {
	return beginAppEditChangeSet({
		appId,
		expectedProjectId: PROJECT,
		lineage: await lineage(),
		ownerUserId: ACTOR,
		ownerRunId: RUN,
	});
}

const CLEAN_DIAGNOSTICS: ChangeSetDiagnosticsSummary = {
	candidateDigest: canonicalJsonDigest("candidate"),
	findingCount: 0,
	findingFingerprints: [],
	canCommit: false,
};

function stageArgs(
	changeSetId: string,
	overrides: Partial<StageChangeSetRequestArgs> = {},
): StageChangeSetRequestArgs {
	const mutations = admitMutationBatch([
		{ kind: "setAppName", name: "Renamed by staging" },
	]);
	const input = { name: "Renamed by staging" };
	return {
		changeSetId,
		requestId: "req-1",
		toolName: "updateApp",
		inputDigest: stagingInputDigest({
			toolName: "updateApp",
			expectedWorkspaceRevision: 0,
			projectedInput: input,
		}),
		expectedRevision: 0,
		actorUserId: ACTOR,
		runId: RUN,
		outcome: {
			kind: "stage",
			mutations,
			stageSlices: [],
			handles: [],
			intentIds: [],
			readSet: [],
			exclusiveKind: null,
			diagnostics: CLEAN_DIAGNOSTICS,
		},
		...overrides,
	};
}

beforeEach(() => {
	__setStageTransactionFaultHookForTests(null);
});

describe("beginChangeSet", () => {
	it("records the exact authorized base: head sequence, Project, and canonical digest", async () => {
		const appId = await createTestApp();
		const changeSet = await openAppEditSet(appId);

		expect(changeSet.kind).toBe("app-edit");
		expect(changeSet.appId).toBe(appId);
		expect(changeSet.baseSeq).toBe(1);
		expect(changeSet.baseProjectId).toBe(PROJECT);
		expect(changeSet.baseSnapshotDigest).toMatch(/^[a-f0-9]{64}$/);
		expect(changeSet.revision).toBe(0);
		expect(changeSet.nextOrdinal).toBe(0);
		expect(changeSet.status).toBe("open");
	});

	it("refuses a caller whose membership lost edit access", async () => {
		const appId = await createTestApp();
		await h.seedProjectMember(ACTOR, PROJECT, "viewer");
		await expect(openAppEditSet(appId)).rejects.toBeInstanceOf(
			ChangeSetScopeLostError,
		);
	});

	it("opens a genesis set against the canonical empty base with no app row", async () => {
		await h.seedProjectMember(ACTOR, PROJECT, "owner");
		const proposedAppId = crypto.randomUUID();
		const base = emptyGenesisBase(proposedAppId);
		const changeSet = await beginGenesisChangeSet({
			proposedAppId,
			projectId: PROJECT,
			baseSnapshotDigest: base.digest,
			lineage: await lineage(),
			ownerUserId: ACTOR,
			ownerRunId: RUN,
		});
		expect(changeSet.kind).toBe("genesis");
		expect(changeSet.appId).toBeNull();
		expect(changeSet.proposedAppId).toBe(proposedAppId);
		expect(changeSet.baseSeq).toBeNull();
	});
});

describe("stage request idempotency", () => {
	it("cannot persist a staging side effect after its absolute deadline", async () => {
		const appId = await createTestApp();
		const changeSet = await openAppEditSet(appId);

		await expect(
			stageChangeSetRequest(
				stageArgs(changeSet.id, { deadlineAt: Date.now() - 1 }),
			),
		).rejects.toThrow("transaction deadline expired");
		expect(await lookupStageRequest(changeSet.id, "req-1")).toBeUndefined();
		expect(await loadChangeSetSteps(changeSet.id)).toHaveLength(0);
		expect((await loadChangeSet(changeSet.id))?.revision).toBe(0);
	});

	it("stages once, then replays the identical receipt for the same request", async () => {
		const appId = await createTestApp();
		const changeSet = await openAppEditSet(appId);

		const first = await stageChangeSetRequest(stageArgs(changeSet.id));
		expect(first.replayed).toBe(false);
		expect(first.receipt.disposition).toBe("staged");
		expect(first.receipt.ordinal).toBe(0);
		expect(first.receipt.workspaceRevision).toBe(1);

		const replay = await stageChangeSetRequest(stageArgs(changeSet.id));
		expect(replay.replayed).toBe(true);
		expect(replay.receipt).toEqual(first.receipt);

		const steps = await loadChangeSetSteps(changeSet.id);
		expect(steps).toHaveLength(1);
		const row = await loadChangeSet(changeSet.id);
		expect(row?.revision).toBe(1);
		expect(row?.nextOrdinal).toBe(1);
	});

	it("latches a reused request id whose content diverged", async () => {
		const appId = await createTestApp();
		const changeSet = await openAppEditSet(appId);
		await stageChangeSetRequest(stageArgs(changeSet.id));

		await expect(
			stageChangeSetRequest(
				stageArgs(changeSet.id, {
					inputDigest: canonicalJsonDigest("different-input"),
				}),
			),
		).rejects.toBeInstanceOf(ChangeSetRequestIdCollisionError);
	});

	it("rejects a stale expected revision before anything appends", async () => {
		const appId = await createTestApp();
		const changeSet = await openAppEditSet(appId);
		await stageChangeSetRequest(stageArgs(changeSet.id));

		await expect(
			stageChangeSetRequest(
				stageArgs(changeSet.id, { requestId: "req-2", expectedRevision: 0 }),
			),
		).rejects.toBeInstanceOf(ChangeSetWorkspaceRevisionStaleError);
		expect(await loadChangeSetSteps(changeSet.id)).toHaveLength(1);
	});

	it("keeps two process continuations from allocating the same or inverted ordinal", async () => {
		const appId = await createTestApp();
		const changeSet = await openAppEditSet(appId);

		const results = await Promise.allSettled([
			stageChangeSetRequest(stageArgs(changeSet.id, { requestId: "race-a" })),
			stageChangeSetRequest(stageArgs(changeSet.id, { requestId: "race-b" })),
		]);
		const fulfilled = results.filter((entry) => entry.status === "fulfilled");
		const rejected = results.filter((entry) => entry.status === "rejected");
		expect(fulfilled).toHaveLength(1);
		expect(rejected).toHaveLength(1);
		expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(
			ChangeSetWorkspaceRevisionStaleError,
		);
		const steps = await loadChangeSetSteps(changeSet.id);
		expect(steps.map((step) => step.ordinal)).toEqual([0]);
	});

	it("persists a rejection receipt idempotently without advancing the workspace", async () => {
		const appId = await createTestApp();
		const changeSet = await openAppEditSet(appId);

		const args = stageArgs(changeSet.id, {
			requestId: "rejected-1",
			outcome: {
				kind: "reject",
				code: "TARGET_INVALID",
				message: "The staged target does not exist in the private candidate.",
			},
		});
		const first = await stageChangeSetRequest(args);
		expect(first.receipt.disposition).toBe("rejected");
		expect(first.receipt.workspaceRevision).toBe(0);

		const replay = await stageChangeSetRequest(args);
		expect(replay.replayed).toBe(true);
		expect(replay.receipt).toEqual(first.receipt);

		const row = await loadChangeSet(changeSet.id);
		expect(row?.revision).toBe(0);
		expect(row?.nextOrdinal).toBe(0);
		expect(await loadChangeSetSteps(changeSet.id)).toHaveLength(0);
	});
});

describe("statement-boundary fault injection", () => {
	const BOUNDARIES: readonly StageTransactionBoundary[] = [
		"after-authority-lock",
		"after-ledger-read",
		"after-request-insert",
		"after-step-insert",
		"after-stage-insert",
		"after-handle-insert",
		"after-advance",
	];

	for (const boundary of BOUNDARIES) {
		it(`persists nothing when the transaction dies at ${boundary}, and the same request then stages cleanly`, async () => {
			const appId = await createTestApp();
			const changeSet = await openAppEditSet(appId);
			const handle = changeSetHandleSchema.parse("@fault");
			const args = stageArgs(changeSet.id, {
				outcome: {
					kind: "stage",
					mutations: admitMutationBatch([
						{ kind: "setAppName", name: "Renamed by staging" },
					]),
					stageSlices: [{ stage: "structure", start: 0, end: 1 }],
					handles: [
						{ handle, uuid: asUuid(crypto.randomUUID()), entityKind: "module" },
					],
					intentIds: [],
					readSet: [],
					exclusiveKind: null,
					diagnostics: CLEAN_DIAGNOSTICS,
				},
			});

			__setStageTransactionFaultHookForTests((at) => {
				if (at === boundary) {
					throw new Error(`forced fault at ${boundary}`);
				}
			});
			await expect(stageChangeSetRequest(args)).rejects.toThrow(
				`forced fault at ${boundary}`,
			);

			// Nothing partial survived the abort — no request, step, stage,
			// handle, or revision advance.
			expect(await lookupStageRequest(changeSet.id, args.requestId)).toBe(
				undefined,
			);
			expect(await loadChangeSetSteps(changeSet.id)).toHaveLength(0);
			expect(await loadHandleBindings(changeSet.id)).toHaveLength(0);
			const row = await loadChangeSet(changeSet.id);
			expect(row?.revision).toBe(0);
			expect(row?.nextOrdinal).toBe(0);

			__setStageTransactionFaultHookForTests(null);
			const retry = await stageChangeSetRequest(args);
			expect(retry.replayed).toBe(false);
			expect(retry.receipt.ordinal).toBe(0);
			expect(retry.receipt.handles).toEqual({
				"@fault": expect.stringMatching(/^[0-9a-f-]{36}$/),
			});
		});
	}

	it("replays the stored receipt when the response was lost AFTER commit", async () => {
		const appId = await createTestApp();
		const changeSet = await openAppEditSet(appId);
		const args = stageArgs(changeSet.id);

		const original = await stageChangeSetRequest(args);
		// The caller never saw `original` — the retry must return the exact
		// same durable facts.
		const retry = await stageChangeSetRequest(args);
		expect(retry.replayed).toBe(true);
		expect(retry.receipt).toEqual(original.receipt);
	});
});

describe("authority and lifecycle", () => {
	it("refuses a different owner and a different run", async () => {
		const appId = await createTestApp();
		const changeSet = await openAppEditSet(appId);
		await h.seedProjectMember("someone-else", PROJECT, "editor");

		await expect(
			stageChangeSetRequest(
				stageArgs(changeSet.id, { actorUserId: "someone-else" }),
			),
		).rejects.toBeInstanceOf(ChangeSetScopeLostError);
		await expect(
			stageChangeSetRequest(stageArgs(changeSet.id, { runId: "other-run" })),
		).rejects.toBeInstanceOf(ChangeSetScopeLostError);
	});

	it("refuses staging after the app moved Projects", async () => {
		const appId = await createTestApp();
		const changeSet = await openAppEditSet(appId);
		await h.seedProjectMember(ACTOR, "project-b", "owner");
		await h.moveAppToProject(appId, "project-b", ACTOR);

		await expect(
			stageChangeSetRequest(stageArgs(changeSet.id)),
		).rejects.toBeInstanceOf(ChangeSetScopeLostError);
	});

	it("abandon and supersede are exact-owner writes that close the set", async () => {
		const appId = await createTestApp();
		const first = await openAppEditSet(appId);
		await expect(
			abandonChangeSet({
				changeSetId: first.id,
				actorUserId: "someone-else",
				runId: RUN,
			}),
		).rejects.toBeInstanceOf(ChangeSetScopeLostError);
		await abandonChangeSet({
			changeSetId: first.id,
			actorUserId: ACTOR,
			runId: RUN,
		});
		expect((await loadChangeSet(first.id))?.status).toBe("abandoned");
		await expect(
			stageChangeSetRequest(stageArgs(first.id)),
		).rejects.toBeInstanceOf(ChangeSetScopeLostError);

		const second = await openAppEditSet(appId);
		await supersedeChangeSet({
			changeSetId: second.id,
			actorUserId: ACTOR,
			runId: RUN,
		});
		expect((await loadChangeSet(second.id))?.status).toBe("superseded");
	});

	it("keeps abandoned steps durable for amendment audit", async () => {
		const appId = await createTestApp();
		const changeSet = await openAppEditSet(appId);
		await stageChangeSetRequest(stageArgs(changeSet.id));
		await abandonChangeSet({
			changeSetId: changeSet.id,
			actorUserId: ACTOR,
			runId: RUN,
		});
		expect(await loadChangeSetSteps(changeSet.id)).toHaveLength(1);
	});
});
