/**
 * Design-slice materialization against a REAL Postgres — the §20.13 gate:
 * one complete sequence-1 app or no app at every failure point, the holder
 * and reservation transferring exactly once, and lost-response replay
 * converging on the stored receipt.
 *
 * The mid-transaction crash window is exercised through the gate rejection:
 * the absolute verdict runs AFTER the app row insert inside the same
 * transaction, so a rejected candidate proves the app row, entities,
 * baseline, schema rows, and session transfer all rolled back together.
 */

import type { Kysely } from "kysely";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { asDesignId } from "@/lib/agent/design/ids";
import { PostgresCaseStore } from "@/lib/case-store/postgres/store";
import { HeuristicCaseGenerator } from "@/lib/case-store/sample/heuristic";
import type { Database } from "@/lib/case-store/sql/database";
import { setupAppStateTestDb } from "@/lib/db/__tests__/appStateTestDb";
import {
	createAndClaimDesignSessionRun,
	setDesignSessionAwaitingInput,
} from "@/lib/db/designSessions";
import { admitMutationBatch } from "@/lib/doc/mutationAdmission";
import {
	canonicalAppGenesis,
	caseListModuleMutations,
	emptyBlueprintDoc,
} from "@/lib/doc/scaffolds";
import type { Mutation } from "@/lib/doc/types";
import {
	emptyGenesisBase,
	loadCanonicalBlueprintAtSequence,
} from "../baseLoader";
import { canonicalJsonDigest, stagingInputDigest } from "../digest";
import { ChangeSetScopeLostError } from "../errors";
import { materializeAppFromGenesis } from "../materializeGenesis";
import {
	beginGenesisChangeSet,
	loadChangeSet,
	loadChangeSetSteps,
	stageChangeSetRequest,
} from "../store";

/* Route `withSchemaContext` to a store bound to the per-test database —
 * production parity, just bypassing the singleton's Cloud SQL connector
 * (the same recipe as materializeCaseStoreSchemas.integration.test.ts). */
const { withSchemaContextMock } = vi.hoisted(() => ({
	withSchemaContextMock: vi.fn(),
}));
vi.mock("@/lib/case-store", async () => {
	const actual = (await vi.importActual("@/lib/case-store")) as Record<
		string,
		unknown
	>;
	return { ...actual, withSchemaContext: withSchemaContextMock };
});

const h = setupAppStateTestDb("materialize_genesis_");

beforeEach(() => {
	withSchemaContextMock.mockReset();
	withSchemaContextMock.mockImplementation(async () => {
		return new PostgresCaseStore({
			projectId: null,
			actorUserId: null,
			ownerId: null,
			db: h.db() as unknown as Kysely<Database>,
			sampleGenerator: new HeuristicCaseGenerator(),
		});
	});
});

const ACTOR = "genesis-actor";
const PROJECT = "project-test";
const RUN = "run-genesis";

interface ClaimedGenesisFixture {
	readonly designSessionId: string;
	readonly proposedAppId: string;
	readonly holderNonce: string;
	readonly changeSetId: string;
}

/** Claim a real design session through the production protocol, seed its
 *  artifact lineage, and open one genesis change set under it. */
async function claimedGenesisFixture(): Promise<ClaimedGenesisFixture> {
	await h.seedProjectMember(ACTOR, PROJECT, "owner");
	const claimed = await createAndClaimDesignSessionRun({
		projectId: PROJECT,
		actorUserId: ACTOR,
		runId: RUN,
		cost: 100,
	});
	const lineage = await h.seedDesignLineage({
		existingSessionId: claimed.designSessionId,
	});
	const changeSet = await beginGenesisChangeSet({
		proposedAppId: claimed.proposedAppId,
		projectId: PROJECT,
		baseSnapshotDigest: emptyGenesisBase(claimed.proposedAppId).digest,
		lineage: {
			designSessionId: claimed.designSessionId,
			designRevisionId: lineage.designRevisionId,
			designRevisionDigest: lineage.designRevisionDigest,
			buildPlanId: lineage.buildPlanId,
			buildPlanDigest: lineage.buildPlanDigest,
			sliceId: asDesignId(lineage.sliceId),
			attemptId: lineage.attemptId,
		},
		ownerUserId: ACTOR,
		ownerRunId: RUN,
	});
	return {
		designSessionId: claimed.designSessionId,
		proposedAppId: claimed.proposedAppId,
		holderNonce: claimed.holderNonce,
		changeSetId: changeSet.id,
	};
}

/** Stage one admitted batch onto the genesis set (revision 0 → 1). */
async function stageBatch(
	changeSetId: string,
	mutations: readonly Mutation[],
	requestId = "genesis-stage-1",
): Promise<void> {
	const admitted = admitMutationBatch(mutations);
	await stageChangeSetRequest({
		changeSetId,
		requestId,
		toolName: "stageModule",
		inputDigest: stagingInputDigest({
			toolName: "stageModule",
			expectedWorkspaceRevision: 0,
			projectedInput: { requestId },
		}),
		expectedRevision: 0,
		actorUserId: ACTOR,
		runId: RUN,
		outcome: {
			kind: "stage",
			mutations: admitted,
			stageSlices: [],
			handles: [],
			intentIds: [asDesignId(crypto.randomUUID())],
			readSet: [],
			exclusiveKind: null,
			diagnostics: {
				candidateDigest: canonicalJsonDigest("candidate"),
				findingCount: 0,
				findingFingerprints: [],
				canCommit: true,
			},
		},
	});
}

/** The canonical starter batch — export-ready by construction. */
function exportReadyBatch(proposedAppId: string): Mutation[] {
	return canonicalAppGenesis(emptyBlueprintDoc(proposedAppId)).mutations;
}

function materializeArgs(fixture: ClaimedGenesisFixture) {
	return {
		changeSetId: fixture.changeSetId,
		actorUserId: ACTOR,
		runId: RUN,
		holderNonce: fixture.holderNonce,
		expectedProjectId: PROJECT,
		expectedRevision: 1,
		owningIntentIds: [asDesignId(crypto.randomUUID())],
	};
}

describe("materializeAppFromGenesis", () => {
	it("materializes one complete sequence-1 app with the transferred holder and reservation", async () => {
		const fixture = await claimedGenesisFixture();
		await stageBatch(
			fixture.changeSetId,
			exportReadyBatch(fixture.proposedAppId),
		);

		const outcome = await materializeAppFromGenesis(materializeArgs(fixture));
		if (outcome.kind !== "materialized") {
			throw new Error(`expected materialized, got ${outcome.kind}`);
		}
		expect(outcome.replayed).toBe(false);
		expect(outcome.receipt.appId).toBe(fixture.proposedAppId);
		expect(outcome.receipt.seq).toBe(1);
		expect(outcome.receipt.designSessionId).toBe(fixture.designSessionId);
		expect(outcome.receipt.changeSetId).toBe(fixture.changeSetId);
		expect(outcome.receipt.starter).toBeNull();
		expect(outcome.receipt.role).toBe("owner");
		expect(outcome.receipt.canEdit).toBe(true);
		expect(outcome.receipt.batchId).toBe(`genesis:${fixture.proposedAppId}`);

		/* The app row carries the exact transferred holder + unsettled
		 * reservation the session held. */
		const app = await h.readAppRow(fixture.proposedAppId);
		expect(app?.status).toBe("generating");
		expect(app?.run_id).toBe(RUN);
		expect(app?.run_holder_nonce).toBe(fixture.holderNonce);
		expect(app?.mutation_seq).toBe("1");
		const marker = await h.readReservation(fixture.proposedAppId);
		expect(marker?.reserved).toBe(100);
		expect(marker?.settled).toBe(false);
		expect(marker?.userId).toBe(ACTOR);
		expect(marker?.runId).toBe(RUN);

		/* The session transferred: materialized, bound to the app, and every
		 * authority column cleared in the same statement. */
		const session = await h.readDesignSessionRow(fixture.designSessionId);
		expect(session?.state).toBe("materialized");
		expect(session?.app_id).toBe(fixture.proposedAppId);
		expect(session?.run_id).toBeNull();
		expect(session?.run_holder_nonce).toBeNull();
		expect(session?.res_period).toBeNull();
		expect(await h.readDesignSessionReservation(fixture.designSessionId)).toBe(
			undefined,
		);

		/* The change set committed at sequence 1 under the protected genesis
		 * batch identity, with its immutable receipt row. */
		const committed = await loadChangeSet(fixture.changeSetId);
		expect(committed?.status).toBe("committed");
		expect(committed?.committedSeq).toBe(1);
		expect(committed?.committedBatchId).toBe(
			`genesis:${fixture.proposedAppId}`,
		);
		const receiptRow = await h
			.db()
			.selectFrom("design_committed_slices")
			.select(["app_id", "seq"])
			.where("change_set_id", "=", fixture.changeSetId)
			.executeTakeFirst();
		expect(receiptRow?.app_id).toBe(fixture.proposedAppId);
		expect(Number(receiptRow?.seq)).toBe(1);

		/* The slice attempt is committed. */
		const attempt = await h
			.db()
			.selectFrom("design_slice_attempts")
			.select(["status", "change_set_id"])
			.where("design_session_id", "=", fixture.designSessionId)
			.executeTakeFirst();
		expect(attempt?.status).toBe("committed");
		expect(attempt?.change_set_id).toBe(fixture.changeSetId);

		/* Sequence 1 is fold-replay exact: the immutable baseline reproduces
		 * the receipt's snapshot digest. */
		const folded = await loadCanonicalBlueprintAtSequence(h.db(), {
			appId: fixture.proposedAppId,
			seq: 1,
			expectedDigest: outcome.receipt.snapshotDigest,
		});
		expect(canonicalJsonDigest(folded.snapshot)).toBe(
			outcome.receipt.snapshotDigest,
		);

		/* The app's durable history is exactly the fold-baseline row. */
		const changes = await h
			.db()
			.selectFrom("app_changes")
			.select(["kind", "batch_id"])
			.where("app_id", "=", fixture.proposedAppId)
			.execute();
		expect(changes).toEqual([
			{ kind: "fold-baseline", batch_id: `genesis:${fixture.proposedAppId}` },
		]);
	});

	it("replays a lost response as the stored receipt without a second app", async () => {
		const fixture = await claimedGenesisFixture();
		await stageBatch(
			fixture.changeSetId,
			exportReadyBatch(fixture.proposedAppId),
		);
		const first = await materializeAppFromGenesis(materializeArgs(fixture));
		if (first.kind !== "materialized") throw new Error(first.kind);

		const replay = await materializeAppFromGenesis(materializeArgs(fixture));
		if (replay.kind !== "materialized") throw new Error(replay.kind);
		expect(replay.replayed).toBe(true);
		expect(replay.receipt.appId).toBe(first.receipt.appId);
		expect(replay.receipt.snapshotDigest).toBe(first.receipt.snapshotDigest);
		expect(replay.receipt.batchId).toBe(first.receipt.batchId);

		const apps = await h
			.db()
			.selectFrom("apps")
			.select(["id"])
			.where("id", "=", fixture.proposedAppId)
			.execute();
		expect(apps).toHaveLength(1);
	});

	it("a gate-rejected candidate materializes NOTHING — the crash-window proof", async () => {
		const fixture = await claimedGenesisFixture();
		/* A lone module with neither forms nor case list is a gating finding
		 * (NO_FORMS_OR_CASE_LIST): the verdict runs AFTER the app-row insert,
		 * so the rejection proves the whole transaction rolled back. */
		await stageBatch(fixture.changeSetId, [
			{ kind: "setAppName", name: "Half-built" },
			...caseListModuleMutations(emptyBlueprintDoc(fixture.proposedAppId), {
				caseType: "client",
			}).mutations.slice(0, 1),
		]);

		const outcome = await materializeAppFromGenesis(materializeArgs(fixture));
		expect(outcome.kind).toBe("gate-rejected");

		expect(await h.readAppRow(fixture.proposedAppId)).toBeUndefined();
		const entities = await h
			.db()
			.selectFrom("blueprint_entities")
			.select(["uuid"])
			.where("app_id", "=", fixture.proposedAppId)
			.execute();
		expect(entities).toHaveLength(0);
		/* The session keeps its live holder and unsettled reservation; the
		 * change set stays open with its steps retained for amendment. */
		const session = await h.readDesignSessionRow(fixture.designSessionId);
		expect(session?.state).toBe("active");
		expect(session?.run_holder_nonce).toBe(fixture.holderNonce);
		expect(
			(await h.readDesignSessionReservation(fixture.designSessionId))?.settled,
		).toBe(false);
		expect((await loadChangeSet(fixture.changeSetId))?.status).toBe("open");
		expect(await loadChangeSetSteps(fixture.changeSetId)).toHaveLength(1);
	});

	it("admits runtime case-schema rows transactionally at synced_seq 1", async () => {
		const fixture = await claimedGenesisFixture();
		const emptyDoc = emptyBlueprintDoc(fixture.proposedAppId);
		await stageBatch(fixture.changeSetId, [
			...canonicalAppGenesis(emptyDoc).mutations,
			...caseListModuleMutations(emptyDoc, { caseType: "client" }).mutations,
		]);

		const outcome = await materializeAppFromGenesis(materializeArgs(fixture));
		if (outcome.kind !== "materialized") {
			throw new Error(`expected materialized, got ${JSON.stringify(outcome)}`);
		}
		/* `case_type_schemas` lives on the case-store side of the shared
		 * database, outside `AppDatabase` — read it through the raw pool. */
		const schema = await h
			.pool()
			.query<{ case_type: string; synced_seq: string }>(
				"SELECT case_type, synced_seq FROM case_type_schemas WHERE app_id = $1",
				[fixture.proposedAppId],
			);
		expect(schema.rows.map((row) => row.case_type)).toEqual(["client"]);
		expect(Number(schema.rows[0]?.synced_seq)).toBe(1);
	});

	it("refuses a superseded holder and a paused session, touching nothing", async () => {
		const fixture = await claimedGenesisFixture();
		await stageBatch(
			fixture.changeSetId,
			exportReadyBatch(fixture.proposedAppId),
		);

		await expect(
			materializeAppFromGenesis({
				...materializeArgs(fixture),
				holderNonce: crypto.randomUUID(),
			}),
		).rejects.toBeInstanceOf(ChangeSetScopeLostError);

		const paused = await setDesignSessionAwaitingInput(
			fixture.designSessionId,
			RUN,
			fixture.holderNonce,
			true,
			ACTOR,
			PROJECT,
		);
		expect(paused).toBe("owned");
		await expect(
			materializeAppFromGenesis(materializeArgs(fixture)),
		).rejects.toBeInstanceOf(ChangeSetScopeLostError);

		expect(await h.readAppRow(fixture.proposedAppId)).toBeUndefined();
		expect((await h.readDesignSessionRow(fixture.designSessionId))?.state).toBe(
			"active",
		);
	});

	it("rejects a stale expected revision without writing", async () => {
		const fixture = await claimedGenesisFixture();
		await stageBatch(
			fixture.changeSetId,
			exportReadyBatch(fixture.proposedAppId),
		);
		await expect(
			materializeAppFromGenesis({
				...materializeArgs(fixture),
				expectedRevision: 0,
			}),
		).rejects.toBeInstanceOf(ChangeSetScopeLostError);
		expect(await h.readAppRow(fixture.proposedAppId)).toBeUndefined();
	});
});
