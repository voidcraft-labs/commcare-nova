/** Native genesis transaction admission, holder transfer and stored replay.
 * Direct stage persistence seeds schema-admitted private candidate batches;
 * the materialization owner must recompute its verdict from those mutations.
 * A late SQL trigger failure proves rollback after canonical rows and sidecars
 * were written; ordinary gate refusal separately proves invalid-app admission.
 */

import type { Kysely } from "kysely";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { asDesignId } from "@/lib/agent/design/ids";
import { PostgresCaseStore } from "@/lib/case-store/postgres/store";
import { HeuristicCaseGenerator } from "@/lib/case-store/sample/heuristic";
import type { Database } from "@/lib/case-store/sql/database";
import { setupAppStateTestDb } from "@/lib/db/__tests__/appStateTestDb";
import { prepareGenesisCandidate } from "@/lib/db/appGenesis";
import { BlueprintCommitRejectedError } from "@/lib/db/commitGuard";
import {
	createAndClaimDesignSessionRun,
	setDesignSessionAwaitingInput,
} from "@/lib/db/designSessions";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { admitMutationBatch } from "@/lib/doc/mutationAdmission";
import {
	canonicalAppGenesis,
	caseListModuleMutations,
	emptyBlueprintDoc,
} from "@/lib/doc/scaffolds";
import type { Mutation } from "@/lib/doc/types";
import { builtinIconRef } from "@/lib/domain/builtinIcons";
import { asUuid } from "@/lib/domain/uuid";
import {
	emptyGenesisBase,
	loadCanonicalBlueprintAtSequence,
} from "../baseLoader";
import { evaluateOverlayFindings, findingFingerprint } from "../diagnostics";
import { canonicalJsonDigest, workspaceCallInputDigest } from "../digest";
import { ChangeSetScopeLostError } from "../errors";
import { materializeAppFromGenesis } from "../materializeGenesis";
import { rehydrateChangeSet } from "../runtime";
import { changeSetHandleSchema } from "../schemas";
import {
	beginAppEditChangeSet,
	beginGenesisChangeSet,
	loadChangeSet,
	loadChangeSetSteps,
	type StageHandleAllocation,
	stageChangeSetRequest,
} from "../store";

/* Route `withSchemaContext` to a store bound to the per-test database —
 * production parity, just bypassing the singleton's Cloud SQL connector
 * (the same recipe as materializeCaseStoreSchemas.postgres.test.ts). */
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
	await h
		.db()
		.updateTable("design_slice_attempts")
		.set({ change_set_id: changeSet.id })
		.where("id", "=", lineage.attemptId)
		.execute();
	return {
		designSessionId: claimed.designSessionId,
		proposedAppId: claimed.proposedAppId,
		holderNonce: claimed.holderNonce,
		changeSetId: changeSet.id,
	};
}

/** Persist one admitted native mutation onto the genesis set (revision 0 → 1). */
async function persistPrivateMutation(
	changeSetId: string,
	mutations: readonly Mutation[],
	requestId = "genesis-stage-1",
	handles: readonly StageHandleAllocation[] = [],
): Promise<void> {
	const admitted = admitMutationBatch(mutations);
	const changeSet = await loadChangeSet(changeSetId);
	if (!changeSet?.proposedAppId) throw new Error("missing genesis change set");
	const candidate = prepareGenesisCandidate({
		appId: changeSet.proposedAppId,
		projectId: PROJECT,
		mutations: admitted,
	});
	const findings = evaluateOverlayFindings(
		candidate.prepared.nextDoc,
		LOOKUP_CONTEXT_UNAVAILABLE,
	);
	await stageChangeSetRequest({
		changeSetId,
		requestId,
		toolName: "createModule",
		inputDigest: workspaceCallInputDigest({
			toolName: "createModule",
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
			handles,
			retainedHandleUuids: handles.map((binding) => binding.uuid),
			readSet: [],
			exclusiveKind: null,
			diagnostics: {
				candidateDigest: candidate.candidateDigest,
				findingCount: findings.length,
				findingFingerprints: findings.map(findingFingerprint).sort(),
				canCommit: findings.length === 0,
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
	};
}

describe("materializeAppFromGenesis", () => {
	it("materializes a genesis app that uses a shipped built-in icon", async () => {
		const fixture = await claimedGenesisFixture();
		const genesis = canonicalAppGenesis(
			emptyBlueprintDoc(fixture.proposedAppId),
		);
		await persistPrivateMutation(fixture.changeSetId, [
			...genesis.mutations,
			{
				kind: "setModuleMedia",
				uuid: genesis.moduleUuid,
				icon: builtinIconRef("nutrition"),
				audioLabel: null,
			},
		]);

		const outcome = await materializeAppFromGenesis(materializeArgs(fixture));
		if (outcome.kind !== "materialized") {
			throw new Error(`expected materialized, got ${outcome.kind}`);
		}
		expect(outcome.receipt.blueprint.modules[genesis.moduleUuid]?.icon).toBe(
			"nova-icon:nutrition",
		);
	});

	it("imports handles committed by the genesis slice into a later app slice", async () => {
		const fixture = await claimedGenesisFixture();
		const genesis = canonicalAppGenesis(
			emptyBlueprintDoc(fixture.proposedAppId),
		);
		const rootHandle = changeSetHandleSchema.parse("@root_module");
		await persistPrivateMutation(
			fixture.changeSetId,
			genesis.mutations,
			"handled-genesis",
			[
				{
					handle: rootHandle,
					uuid: genesis.moduleUuid,
					entityKind: "module",
				},
			],
		);
		const outcome = await materializeAppFromGenesis(materializeArgs(fixture));
		if (outcome.kind !== "materialized") {
			throw new Error(`expected materialized, got ${outcome.kind}`);
		}
		const committedRoot = await loadChangeSet(fixture.changeSetId);
		if (committedRoot === undefined) throw new Error("missing committed root");

		const priorAttempt = await h
			.db()
			.selectFrom("design_slice_attempts")
			.selectAll()
			.where("id", "=", committedRoot.attemptId)
			.executeTakeFirstOrThrow();
		const attemptId = crypto.randomUUID();
		const sliceId = asDesignId(crypto.randomUUID());
		await h
			.db()
			.insertInto("design_slice_attempts")
			.values({
				...priorAttempt,
				id: attemptId,
				slice_id: sliceId,
				attempt: 1,
				base_kind: "app",
				base_app_id: fixture.proposedAppId,
				base_proposed_app_id: null,
				base_seq: outcome.receipt.seq,
				base_snapshot_digest: outcome.receipt.snapshotDigest,
				change_set_id: null,
				brief_digest: canonicalJsonDigest(`brief:${attemptId}`),
				execution_run_ids: JSON.stringify([RUN]),
				status: "running",
				failure_code: null,
				wall_clock_ms_used: 0,
				wall_clock_accrued_at: new Date(),
				created_at: new Date(),
				updated_at: new Date(),
			})
			.execute();
		const next = await beginAppEditChangeSet({
			appId: fixture.proposedAppId,
			expectedProjectId: PROJECT,
			ownerUserId: ACTOR,
			ownerRunId: RUN,
			lineage: {
				designSessionId: committedRoot.designSessionId,
				designRevisionId: committedRoot.designRevisionId,
				designRevisionDigest: committedRoot.designRevisionDigest,
				buildPlanId: committedRoot.buildPlanId,
				buildPlanDigest: committedRoot.buildPlanDigest,
				attemptId,
				sliceId,
			},
		});
		const imported = (await rehydrateChangeSet(next)).handles;
		expect(imported).toEqual([
			expect.objectContaining({
				handle: rootHandle,
				uuid: genesis.moduleUuid,
				entityKind: "module",
			}),
		]);
	});

	it("materializes one complete sequence-1 app with the transferred holder and reservation", async () => {
		const fixture = await claimedGenesisFixture();
		await persistPrivateMutation(
			fixture.changeSetId,
			exportReadyBatch(fixture.proposedAppId),
		);
		await h
			.db()
			.updateTable("design_slice_attempts")
			.set({ outcome_evidence_state: "collecting" })
			.where("design_session_id", "=", fixture.designSessionId)
			.executeTakeFirstOrThrow();

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
			.select(["status", "change_set_id", "outcome_evidence_state"])
			.where("design_session_id", "=", fixture.designSessionId)
			.executeTakeFirst();
		expect(attempt?.status).toBe("committed");
		expect(attempt?.change_set_id).toBe(fixture.changeSetId);
		expect(attempt?.outcome_evidence_state).toBe("complete");

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
		await persistPrivateMutation(
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

	it("denies a lost-response replay after current Project membership is revoked", async () => {
		const fixture = await claimedGenesisFixture();
		await persistPrivateMutation(
			fixture.changeSetId,
			exportReadyBatch(fixture.proposedAppId),
		);
		const first = await materializeAppFromGenesis(materializeArgs(fixture));
		if (first.kind !== "materialized") throw new Error(first.kind);
		await h
			.pool()
			.query(
				`DELETE FROM auth_member WHERE "userId" = $1 AND "organizationId" = $2`,
				[ACTOR, PROJECT],
			);
		await expect(
			materializeAppFromGenesis(materializeArgs(fixture)),
		).rejects.toBeInstanceOf(ChangeSetScopeLostError);
	});

	it("applies organization integrity before persisting sequence one", async () => {
		const fixture = await claimedGenesisFixture();
		const missingLocation = asUuid(crypto.randomUUID());
		await persistPrivateMutation(fixture.changeSetId, [
			...exportReadyBatch(fixture.proposedAppId),
			{
				kind: "addPersona",
				persona: {
					uuid: asUuid(crypto.randomUUID()),
					name: "Asha",
					locations: { primaryUuid: missingLocation },
				},
			},
		]);
		await expect(
			materializeAppFromGenesis(materializeArgs(fixture)),
		).rejects.toBeInstanceOf(BlueprintCommitRejectedError);
		expect(await h.readAppRow(fixture.proposedAppId)).toBeUndefined();
		expect(
			await h
				.db()
				.selectFrom("app_location_references")
				.select("location_id")
				.where("app_id", "=", fixture.proposedAppId)
				.execute(),
		).toEqual([]);
	});

	it("refuses an invalid private candidate without persisting an app", async () => {
		const fixture = await claimedGenesisFixture();
		/* A lone module with neither forms nor case list is a gating finding
		 * (NO_FORMS_OR_CASE_LIST): the verdict runs AFTER the app-row insert,
		 * so the rejection proves that provisional insert rolls back. */
		await persistPrivateMutation(fixture.changeSetId, [
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

	it("rolls back a native failure after app rows, schema rows and the committed receipt exist", async () => {
		const fixture = await claimedGenesisFixture();
		await persistPrivateMutation(
			fixture.changeSetId,
			exportReadyBatch(fixture.proposedAppId),
		);
		await h.pool().query(`
   CREATE FUNCTION audit_refuse_genesis_transfer() RETURNS trigger LANGUAGE plpgsql AS $$
   BEGIN
    IF OLD.state = 'active' AND NEW.state = 'materialized' THEN
     IF NOT EXISTS (SELECT 1 FROM apps WHERE id = NEW.app_id)
      OR NOT EXISTS (SELECT 1 FROM blueprint_entities WHERE app_id = NEW.app_id)
      OR NOT EXISTS (SELECT 1 FROM app_changes WHERE app_id = NEW.app_id)
      OR NOT EXISTS (SELECT 1 FROM app_change_fold_baselines WHERE app_id = NEW.app_id)
      OR NOT EXISTS (SELECT 1 FROM case_type_schemas WHERE app_id = NEW.app_id)
      OR NOT EXISTS (SELECT 1 FROM design_committed_slices WHERE app_id = NEW.app_id)
     THEN RAISE EXCEPTION 'audit failure before required writes'; END IF;
     RAISE EXCEPTION 'audit late transfer failure after all required writes';
    END IF;
    RETURN NEW;
   END $$;
   CREATE TRIGGER audit_refuse_genesis_transfer BEFORE UPDATE ON design_sessions
    FOR EACH ROW EXECUTE FUNCTION audit_refuse_genesis_transfer();
  `);
		try {
			await expect(
				materializeAppFromGenesis(materializeArgs(fixture)),
			).rejects.toThrow(
				"audit late transfer failure after all required writes",
			);
			const remaining = await h.pool().query<{ present: boolean }>(
				`
    SELECT EXISTS (SELECT 1 FROM apps WHERE id = $1)
     OR EXISTS (SELECT 1 FROM blueprint_entities WHERE app_id = $1)
     OR EXISTS (SELECT 1 FROM app_changes WHERE app_id = $1)
     OR EXISTS (SELECT 1 FROM app_change_fold_baselines WHERE app_id = $1)
     OR EXISTS (SELECT 1 FROM case_type_schemas WHERE app_id = $1)
     OR EXISTS (SELECT 1 FROM design_committed_slices WHERE app_id = $1) AS present
   `,
				[fixture.proposedAppId],
			);
			expect(remaining.rows).toEqual([{ present: false }]);
			expect((await loadChangeSet(fixture.changeSetId))?.status).toBe("open");
			expect(await loadChangeSetSteps(fixture.changeSetId)).toHaveLength(1);
			expect(
				await h.readDesignSessionRow(fixture.designSessionId),
			).toMatchObject({
				state: "active",
				run_id: RUN,
				run_holder_nonce: fixture.holderNonce,
			});
			expect(
				await h.readDesignSessionReservation(fixture.designSessionId),
			).toMatchObject({
				reserved: 100,
				settled: false,
				userId: ACTOR,
				runId: RUN,
			});
		} finally {
			await h
				.pool()
				.query(
					"DROP TRIGGER IF EXISTS audit_refuse_genesis_transfer ON design_sessions; DROP FUNCTION IF EXISTS audit_refuse_genesis_transfer();",
				);
		}
		expect(
			(await materializeAppFromGenesis(materializeArgs(fixture))).kind,
		).toBe("materialized");
	});

	it("admits runtime case-schema rows transactionally at synced_seq 1", async () => {
		const fixture = await claimedGenesisFixture();
		const emptyDoc = emptyBlueprintDoc(fixture.proposedAppId);
		await persistPrivateMutation(fixture.changeSetId, [
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
				"SELECT case_type, synced_seq FROM case_type_schemas WHERE app_id = $1 ORDER BY case_type",
				[fixture.proposedAppId],
			);
		expect(
			schema.rows.map((row) => [row.case_type, Number(row.synced_seq)]),
		).toEqual([
			["client", 1],
			["commcare-user", 1],
		]);
	});

	it("refuses a superseded holder and a paused session, touching nothing", async () => {
		const fixture = await claimedGenesisFixture();
		await persistPrivateMutation(
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
		await persistPrivateMutation(
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
