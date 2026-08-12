/**
 * The change-set runtime's parsed row and protocol types.
 *
 * These are the shapes the store returns AFTER strict admission: sequences
 * through `safePersistedSequence`, JSON payloads through the exact schemas
 * in `schemas.ts`, mutations through mutation admission. Raw Kysely rows
 * never escape `store.ts`.
 */

import type { DesignId } from "@/lib/agent/design/ids";
import type { AdmittedMutationBatch } from "@/lib/doc/mutationAdmission";
import type { Uuid } from "@/lib/domain";
import type {
	ChangeSetHandle,
	ExternalReadDependency,
	StagedEntityKind,
	StageRequestReceipt,
} from "./schemas";

export type ChangeSetKind = "genesis" | "app-edit";
export type ChangeSetStatus = "open" | "committed" | "abandoned" | "superseded";
export type ChangeSetExclusiveKind = "renameCaseProperties" | "retireCaseType";

/**
 * The immutable design/plan lineage a change set is opened under. Opaque
 * identities until the design-session/orchestrator units land their tables;
 * the digests are proven equal at stage and commit time regardless.
 */
export interface ChangeSetLineage {
	readonly designSessionId: string;
	readonly designRevisionId: string;
	readonly designRevisionDigest: string;
	readonly buildPlanId: string;
	readonly buildPlanDigest: string;
	readonly sliceId: DesignId;
	readonly attemptId: string;
}

/** The parsed authority row. */
export interface DesignChangeSet extends ChangeSetLineage {
	readonly id: string;
	readonly kind: ChangeSetKind;
	/** Present exactly on app-edit sets. */
	readonly appId: string | null;
	/** Present exactly on genesis sets. */
	readonly proposedAppId: string | null;
	/** The exact canonical base sequence — app-edit sets only. */
	readonly baseSeq: number | null;
	readonly baseProjectId: string;
	readonly baseSnapshotDigest: string;
	readonly revision: number;
	readonly nextOrdinal: number;
	readonly exclusiveKind: ChangeSetExclusiveKind | null;
	readonly ownerUserId: string;
	readonly ownerRunId: string;
	readonly status: ChangeSetStatus;
	readonly committedSeq: number | null;
	readonly committedBatchId: string | null;
	readonly committedSnapshotDigest: string | null;
	readonly createdAt: Date;
	readonly updatedAt: Date;
}

/** One admitted staged step, parsed. */
export interface ChangeSetStep {
	readonly ordinal: number;
	readonly requestId: string;
	readonly toolName: string;
	readonly mutations: AdmittedMutationBatch;
	readonly mutationDigest: string;
	readonly intentIds: readonly DesignId[];
	readonly readSet: readonly ExternalReadDependency[];
	readonly stages: readonly ChangeSetStepStage[];
}

/** One stage range of a step — a name plus a span into the step's batch. */
export interface ChangeSetStepStage {
	readonly stageOrdinal: number;
	readonly stageName: string;
	readonly mutationStart: number;
	readonly mutationCount: number;
}

/** One private handle binding. */
export interface ChangeSetHandleBinding {
	readonly handle: ChangeSetHandle;
	readonly uuid: Uuid;
	readonly entityKind: StagedEntityKind;
	readonly bindingRequestId: string;
}

/** A staged-request lookup result: the stored receipt plus what it was
 *  keyed under, for digest comparison on replay. */
export interface StoredStageRequest {
	readonly requestId: string;
	readonly toolName: string;
	readonly inputDigest: string;
	readonly expectedRevision: number;
	readonly resultingRevision: number;
	readonly status: "staged" | "noop" | "rejected";
	readonly receipt: StageRequestReceipt;
}

/** The immutable committed-slice receipt (`design_committed_slices`). */
export interface CommittedSliceReceipt extends ChangeSetLineage {
	readonly id: string;
	readonly changeSetId: string;
	readonly appId: string;
	readonly seq: number;
	readonly batchId: string;
	readonly committedSnapshotDigest: string;
	readonly owningIntentIds: readonly DesignId[];
	readonly mutationCount: number;
	readonly committedAt: Date;
}

/** Deterministic batch-id derivation for an existing-app change-set commit
 *  (genesis keeps the protected `genesis:<appId>` identity instead). */
export function designChangeSetBatchId(args: {
	readonly changeSetId: string;
	readonly revision: number;
	readonly mutationDigest: string;
}): string {
	return `design-change-set:${args.changeSetId}:r${args.revision}:${args.mutationDigest.slice(0, 24)}`;
}

/** The batch-exclusive mutation kinds — a staged batch carrying one of these
 *  must own its change set alone (the change-set admission fence; mutation
 *  admission separately keeps `renameCaseProperties` alone in its batch). */
export const BATCH_EXCLUSIVE_MUTATION_KINDS = [
	"renameCaseProperties",
	"retireCaseType",
] as const;

export function batchExclusiveKind(
	mutations: AdmittedMutationBatch,
): ChangeSetExclusiveKind | null {
	for (const mutation of mutations) {
		if (mutation.kind === "renameCaseProperties") return "renameCaseProperties";
		if (mutation.kind === "retireCaseType") return "retireCaseType";
	}
	return null;
}
