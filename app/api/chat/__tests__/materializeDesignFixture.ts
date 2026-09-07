import {
	briefDigest,
	deriveSliceExecutionBrief,
} from "@/lib/agent/build/executionBrief";
import { beginOrRecoverSliceAttempt } from "@/lib/agent/build/sliceAttempts";
import { emptyGenesisBase } from "@/lib/agent/change-set/baseLoader";
import {
	evaluateOverlayFindings,
	findingFingerprint,
} from "@/lib/agent/change-set/diagnostics";
import { workspaceCallInputDigest } from "@/lib/agent/change-set/digest";
import { materializeAppFromGenesis } from "@/lib/agent/change-set/materializeGenesis";
import {
	beginGenesisChangeSet,
	stageChangeSetRequest,
} from "@/lib/agent/change-set/store";
import { persistAcceptedDesignFixture } from "@/lib/agent/design/__tests__/persistedFixtures";
import { prepareGenesisCandidate } from "@/lib/db/appGenesis";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { canonicalAppGenesis, emptyBlueprintDoc } from "@/lib/doc/scaffolds";

/** Controlled accepted design and private candidate content; every durable
 * artifact, attempt, change set and genesis transfer uses its production
 * writer. The route test chooses orchestration outcomes, not canonical SQL. */
export async function materializeDesignFixture(args: {
	designSessionId: string;
	appId: string;
	runId: string;
	holderNonce: string;
	actorUserId: string;
	projectId: string;
}) {
	const authority = {
		actorUserId: args.actorUserId,
		runId: args.runId,
		holderNonce: args.holderNonce,
		expectedProjectId: args.projectId,
	};
	const persisted = await persistAcceptedDesignFixture({
		designSessionId: args.designSessionId,
		authority,
	});
	const plan = persisted.plan.envelope.payload;
	const slice = plan.slices.find(
		(slice) => slice.role === "materialization-root",
	);
	if (!slice) throw new Error("Accepted fixture has no materialization root");
	const brief = deriveSliceExecutionBrief({
		contract: persisted.accepted.envelope.payload,
		revision: {
			id: persisted.accepted.id,
			digest: persisted.accepted.artifactDigest,
		},
		plan,
		sliceId: slice.id,
	});
	const base = emptyGenesisBase(args.appId);
	const { attempt } = await beginOrRecoverSliceAttempt({
		...authority,
		designSessionId: args.designSessionId,
		designRevisionId: persisted.accepted.id,
		designRevisionDigest: persisted.accepted.artifactDigest,
		buildPlanId: persisted.plan.id,
		buildPlanDigest: persisted.plan.planDigest,
		sliceId: slice.id,
		baseTarget: {
			kind: "empty-genesis",
			proposedAppId: args.appId,
			digest: base.digest,
		},
		executorModel: "offline-fixture",
		promptVersion: "offline-fixture-v1",
		briefDigest: briefDigest(brief),
	});
	const changeSet = await beginGenesisChangeSet({
		proposedAppId: args.appId,
		projectId: args.projectId,
		baseSnapshotDigest: base.digest,
		lineage: {
			designSessionId: args.designSessionId,
			designRevisionId: persisted.accepted.id,
			designRevisionDigest: persisted.accepted.artifactDigest,
			buildPlanId: persisted.plan.id,
			buildPlanDigest: persisted.plan.planDigest,
			sliceId: slice.id,
			attemptId: attempt.id,
		},
		ownerUserId: args.actorUserId,
		ownerRunId: args.runId,
		attemptAuthority: {
			holderNonce: args.holderNonce,
			expectedProjectId: args.projectId,
		},
	});
	const genesis = canonicalAppGenesis(
		emptyBlueprintDoc(args.appId),
		"Materialized design app",
	);
	const candidate = prepareGenesisCandidate({
		appId: args.appId,
		projectId: args.projectId,
		mutations: genesis.mutations,
	});
	const findings = evaluateOverlayFindings(
		candidate.prepared.nextDoc,
		LOOKUP_CONTEXT_UNAVAILABLE,
	);
	await stageChangeSetRequest({
		changeSetId: changeSet.id,
		requestId: "route-genesis-fixture",
		toolName: "createModule",
		inputDigest: workspaceCallInputDigest({
			toolName: "createModule",
			expectedWorkspaceRevision: 0,
			projectedInput: { fixture: "canonical-starter" },
		}),
		expectedRevision: 0,
		actorUserId: args.actorUserId,
		runId: args.runId,
		outcome: {
			kind: "stage",
			mutations: candidate.admittedMutations,
			stageSlices: [],
			handles: [],
			retainedHandleUuids: [],
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
	const outcome = await materializeAppFromGenesis({
		changeSetId: changeSet.id,
		...authority,
		expectedRevision: 1,
	});
	if (outcome.kind !== "materialized")
		throw new Error(`Genesis fixture failed: ${outcome.kind}`);
	return outcome.receipt;
}
