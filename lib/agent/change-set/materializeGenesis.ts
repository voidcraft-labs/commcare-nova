/**
 * Design-slice materialization — the one transaction that turns a complete
 * genesis Atomic Change Set into a real app (§12.4): the app row plus its
 * entities, edges, runtime schema rows, and immutable sequence-1 baseline are
 * born in the same commit that flips the change set `committed`, writes the
 * slice receipt, and transfers the design session's
 * holder and reservation onto the new app row. Nothing exists if any
 * pre-commit step fails, and there is never an interval with two holders or
 * an ownerless unsettled reservation (§11.5).
 *
 * The candidate is never caller-prepared: the transaction reloads the change
 * set under its locks, replays the admitted steps from the canonical empty
 * base, and re-evaluates everything through the shared genesis write tail
 * (`lib/db/appGenesis.ts`), which owns membership reauthorization, the
 * absolute gate, export readiness, the exact media/lookup projections, and
 * transactional case-schema admission. Post-commit, the idempotent pending
 * index drain converges the performance indexes — a transient DDL failure
 * leaves durable work, never a partial app.
 *
 * Lock order (§11.13 rule 6): actor generation gate → design-session row →
 * change-set row → membership gate/member row → new app insert → dependent
 * rows. The gate is what makes the transfer atomic against a concurrent
 * cross-target admission for the same actor.
 *
 * Retry idempotency: a lost response replays through the durable state — a
 * session already `materialized` onto this change set's proposed app returns
 * the stored receipt, rebuilt from the committed slice receipt and the exact
 * sequence-1 baseline fold.
 */

import { assertDesignLookupMaterializationCurrentInTransaction } from "@/lib/agent/design/lookupMaterialization";
import { roleAllowsApp } from "@/lib/auth/projectRoles";
import { lockActorGenerationGate } from "@/lib/db/actorGenerationGate";
import {
	type AppMaterializationReceipt,
	GenesisGateRejectedError,
	genesisBatchId,
	prepareGenesisCandidate,
	writePreparedGenesisInTransaction,
} from "@/lib/db/appGenesis";
import { executeCanonicalCommitSidecars } from "@/lib/db/canonicalCommitSidecars";
import { releaseDesignLookupProtectionsInTransaction } from "@/lib/db/designLookupMaterializations";
import { type LockedSessionRow, lockSessionRow } from "@/lib/db/designSessions";
import { designSessionReservation } from "@/lib/db/leaseView";
import { drainPendingCaseSchemaIndexes } from "@/lib/db/materializeCaseStoreSchemas";
import { parsePersistedMutationBatchText } from "@/lib/db/persistedJson";
import { getAppDb, withAppTx } from "@/lib/db/pg";
import { projectRoleForInTransaction } from "@/lib/db/projectMembership";
import {
	designSessionAuthorityCleared,
	type ExactRunHolderIdentity,
	exactRunHolderMatches,
	expectedDesignSessionHolderPredicate,
	updatedExactlyOne,
} from "@/lib/db/runHolderWrites";
import { designSessionLeaseState } from "@/lib/db/runLiveness";
import { encodeAdmittedMutationEnvelope } from "@/lib/doc/mutationAdmission";
import { log } from "@/lib/logger";
import {
	emptyGenesisBase,
	loadCanonicalBlueprintAtSequence,
} from "./baseLoader";
import { ChangeSetIntegrityError, ChangeSetScopeLostError } from "./errors";
import type { ReadSetStatus } from "./readSets";
import { evaluateReadSetCurrency, normalizeReadSet } from "./readSets";
import { loadChangeSet, loadChangeSetSteps, lockChangeSetRow } from "./store";
import type { DesignChangeSet } from "./types";

export type MaterializeGenesisOutcome =
	| {
			readonly kind: "materialized";
			readonly receipt: AppMaterializationReceipt;
			/** True when a prior attempt had already materialized (idempotent
			 * replay — nothing written). */
			readonly replayed: boolean;
	  }
	| {
			/** The fresh whole-document gate or export readiness rejected the
			 * candidate. Steps are retained; the executor amends and retries. */
			readonly kind: "gate-rejected";
			readonly message: string;
	  }
	| {
			/** A captured external read set is no longer current. The change set
			 * stays open; the orchestrator refreshes or supersedes. */
			readonly kind: "read-set-stale";
			readonly stale: readonly ReadSetStatus[];
	  };

export interface MaterializeGenesisArgs {
	readonly changeSetId: string;
	readonly actorUserId: string;
	readonly runId: string;
	readonly holderNonce: string;
	readonly expectedProjectId: string;
	readonly expectedRevision: number;
	/** Absolute executor wall-clock deadline; direct callers omit it. */
	readonly deadlineAt?: number;
}

/**
 * Materialize one open genesis change set as a complete sequence-1 app. The
 * caller is the run that holds the design session (`(build, runId, nonce)`);
 * the transaction proves that exact holder on the locked session row before
 * anything is written, and the same identity lands on the new app row.
 */
export async function materializeAppFromGenesis(
	args: MaterializeGenesisArgs,
): Promise<MaterializeGenesisOutcome> {
	if (deadlineExpired(args.deadlineAt)) return deadlineRejection();
	const preRead = await loadChangeSet(args.changeSetId);
	if (preRead === undefined) {
		throw new ChangeSetScopeLostError("This change set no longer exists.");
	}
	if (preRead.kind !== "genesis" || preRead.proposedAppId === null) {
		throw new ChangeSetScopeLostError(
			"Only a genesis change set materializes an app; an app-edit change set commits through the app-edit path.",
		);
	}
	const proposedAppId = preRead.proposedAppId;

	/* Idempotent replay before any lock: a session already materialized onto
	 * this proposed app means a prior attempt committed and only the response
	 * was lost. */
	const replayed = await replayIfMaterialized(preRead, args);
	if (replayed !== undefined) return replayed;

	/* Preflight read-set classification against fresh (unlocked) state — the
	 * structured report the orchestrator acts on. The locked verdicts inside
	 * the transaction (lookup context, media admission) remain the
	 * authority; a race between this read and the transaction surfaces as a
	 * gate rejection there. */
	const steps = await loadChangeSetSteps(args.changeSetId);
	if (deadlineExpired(args.deadlineAt)) return deadlineRejection();
	if (steps.length === 0) {
		return {
			kind: "gate-rejected",
			message:
				"This change set has no staged steps, so there is nothing to materialize.",
		};
	}
	const readSet = normalizeReadSet(steps.flatMap((step) => step.readSet));
	const readSetStatus = await evaluateReadSetCurrency({
		appId: null,
		dependencies: readSet,
	});
	if (deadlineExpired(args.deadlineAt)) return deadlineRejection();
	const stale = readSetStatus.filter((status) => status.state !== "current");
	if (stale.length > 0) {
		return { kind: "read-set-stale", stale };
	}

	/* The receipt-row identity is minted OUTSIDE the retryable transaction so
	 * a serialization retry reuses it. */
	const receiptId = crypto.randomUUID();
	const holder: ExactRunHolderIdentity = {
		mode: "build",
		runId: args.runId,
		nonce: args.holderNonce,
	};

	try {
		const receipt = await withAppTx(
			async (tx) => {
				await lockActorGenerationGate(tx, args.actorUserId);
				const session = await lockSessionRow(tx, preRead.designSessionId);
				if (session === undefined) {
					throw new ChangeSetScopeLostError(
						"This design session no longer exists.",
					);
				}
				verifySessionForTransfer(session, args, holder, proposedAppId);

				const changeSet = await lockChangeSetRow(tx, args.changeSetId);
				if (changeSet === undefined) {
					throw new ChangeSetScopeLostError(
						"This change set no longer exists.",
					);
				}
				verifyOpenGenesisSet(changeSet, preRead, args);

				/* Rehydrate the candidate under the locks: the canonical empty base
				 * (digest-proved against what the opener recorded) plus every
				 * admitted step in ordinal order, concatenated into ONE batch
				 * through the byte-faithful envelope round trip. */
				const lockedSteps = await loadChangeSetSteps(args.changeSetId, tx);
				if (lockedSteps.length !== changeSet.nextOrdinal) {
					throw new ChangeSetIntegrityError(
						`Change set ${args.changeSetId} records ${changeSet.nextOrdinal} step(s) but ${lockedSteps.length} are stored.`,
					);
				}
				const base = emptyGenesisBase(proposedAppId);
				if (base.digest !== changeSet.baseSnapshotDigest) {
					throw new ChangeSetIntegrityError(
						`Change set ${args.changeSetId} recorded base digest ${changeSet.baseSnapshotDigest}, but the canonical empty base derives ${base.digest}.`,
					);
				}
				const batch = parsePersistedMutationBatchText(
					encodeAdmittedMutationEnvelope(
						lockedSteps.flatMap((step) => [...step.mutations]),
					).json,
					`change set ${args.changeSetId} concatenated genesis batch`,
				);
				const candidate = prepareGenesisCandidate({
					appId: proposedAppId,
					projectId: changeSet.baseProjectId,
					mutations: batch,
				});

				/* A value COPY for the transfer, not a liveness decision — the exact
				 * session holder was already proved through the one lease reader in
				 * `verifySessionForTransfer`. */
				const sessionHold = designSessionReservation(session);
				if (
					sessionHold === undefined ||
					sessionHold.settled ||
					sessionHold.userId === undefined ||
					sessionHold.runId === undefined
				) {
					throw new ChangeSetScopeLostError(
						"This design session's run no longer carries an unsettled reservation, so its hold cannot transfer to the new app.",
					);
				}

				/* The shared genesis write tail: membership reauthorization, the app
				 * row carrying the TRANSFERRED holder + reservation, the absolute
				 * gate + export readiness under the locked lookup context, exact
				 * media/lookup projections, entities, the fold-baseline change +
				 * immutable baseline, and transactional case-schema admission. */
				await writePreparedGenesisInTransaction(tx, {
					candidate,
					actorUserId: args.actorUserId,
					runId: args.runId,
					status: "generating",
					holderTransfer: {
						runHolderNonce: args.holderNonce,
						reservation: {
							period: sessionHold.period,
							reserved: sessionHold.reserved,
							userId: sessionHold.userId,
							runId: sessionHold.runId,
						},
					},
				});
				await assertDesignLookupMaterializationCurrentInTransaction(tx, {
					designSessionId: changeSet.designSessionId,
					designRevisionId: changeSet.designRevisionId,
					designRevisionDigest: changeSet.designRevisionDigest,
					projectId: changeSet.baseProjectId,
				});
				/* Canonical sequence-one lookup reference edges now protect every
				 * dependency. Retire the accepted-design bridge in this same
				 * transaction so there is never an unprotected interval. */
				await releaseDesignLookupProtectionsInTransaction(
					tx,
					changeSet.designSessionId,
				);

				/* The committed-slice receipt and `open → committed` flip ride the
				 * same closed sidecar vocabulary every canonical commit uses. */
				const batchId = genesisBatchId(proposedAppId);
				await executeCanonicalCommitSidecars(tx, {
					appId: proposedAppId,
					seq: 1,
					batchId,
					committedSnapshot: candidate.persistable,
					sidecars: [
						{
							kind: "commit-design-change-set",
							changeSetId: changeSet.id,
							expectedRevision: changeSet.revision,
							receiptId,
							sliceAttemptId: changeSet.attemptId,
							designSessionId: changeSet.designSessionId,
							designRevisionId: changeSet.designRevisionId,
							designRevisionDigest: changeSet.designRevisionDigest,
							buildPlanId: changeSet.buildPlanId,
							buildPlanDigest: changeSet.buildPlanDigest,
							sliceId: changeSet.sliceId,
							mutationCount: batch.length,
						},
					],
				});

				/* The holder transfer's session half: ONE atomic update — the table
				 * CHECKs force `materialized` to carry the bound app and a complete
				 * authority clear, so a partial transfer is unrepresentable. The
				 * exact-holder predicate is belt over the held lock. */
				const transfer = await tx
					.updateTable("design_sessions")
					.set({
						...designSessionAuthorityCleared(),
						state: "materialized",
						app_id: proposedAppId,
						last_error_type: null,
						updated_at: new Date(),
					})
					.where("id", "=", session.id)
					.where(expectedDesignSessionHolderPredicate(holder))
					.executeTakeFirst();
				if (!updatedExactlyOne(transfer)) {
					throw new ChangeSetScopeLostError(
						"This design session's holder changed underneath its own locked materialization.",
					);
				}

				const role = await projectRoleForInTransaction(
					tx,
					args.actorUserId,
					changeSet.baseProjectId,
				);
				if (role === null) {
					throw new ChangeSetScopeLostError(
						"This materialized app is no longer available in your Project scope.",
					);
				}
				return buildReceipt({
					designSessionId: changeSet.designSessionId,
					appId: proposedAppId,
					projectId: changeSet.baseProjectId,
					role,
					batchId,
					changeSetId: changeSet.id,
					snapshotDigest: candidate.candidateDigest,
					blueprint: candidate.persistable,
				});
			},
			args.deadlineAt === undefined
				? undefined
				: { deadlineAt: args.deadlineAt },
		);

		/* Post-commit: converge the performance indexes the schema admission
		 * recorded as durable pending work. Idempotent; a transient failure
		 * leaves the work durable for the next drain/heal — never a partial
		 * app, never a validity signal. */
		if (args.deadlineAt === undefined) {
			await drainPendingCaseSchemaIndexes(proposedAppId).catch((err) => {
				log.warn(
					"[materializeGenesis] pending index drain failed (transient)",
					{
						appId: proposedAppId,
						err: err instanceof Error ? err.message : String(err),
					},
				);
			});
		}

		return { kind: "materialized", receipt, replayed: false };
	} catch (error) {
		if (error instanceof GenesisGateRejectedError) {
			/* A concurrent duplicate may have won and committed — the honest
			 * answer is then the stored receipt, not a conflict report. */
			const fresh = await loadChangeSet(args.changeSetId);
			if (fresh !== undefined && fresh.status === "committed") {
				const replay = await replayIfMaterialized(fresh, args);
				if (replay !== undefined) return replay;
			}
			return { kind: "gate-rejected", message: error.message };
		}
		throw error;
	}
}

function deadlineExpired(deadlineAt: number | undefined): boolean {
	return deadlineAt !== undefined && Date.now() >= deadlineAt;
}

function deadlineRejection(): MaterializeGenesisOutcome {
	return {
		kind: "gate-rejected",
		message: "The slice execution deadline expired before materialization.",
	};
}

/** The lost-response replay arm: a session already `materialized` onto this
 *  change set's proposed app returns the stored receipt rebuilt from durable
 *  state — the committed-slice receipt row plus the exact sequence-1
 *  baseline fold. */
async function replayIfMaterialized(
	changeSet: DesignChangeSet,
	args: MaterializeGenesisArgs,
): Promise<
	Extract<MaterializeGenesisOutcome, { kind: "materialized" }> | undefined
> {
	if (changeSet.status !== "committed" || changeSet.proposedAppId === null) {
		return undefined;
	}
	return {
		kind: "materialized",
		replayed: true,
		receipt: await materializedReceipt(changeSet, args.actorUserId),
	};
}

/** Read-only reconciliation for genesis after a post-COMMIT response race.
 * It reconstructs the ordinary activation receipt from the committed sidecar
 * and canonical sequence-1 fold; it never retries materialization. */
export async function readMaterializedGenesisReceipt(args: {
	readonly changeSetId: string;
	readonly actorUserId: string;
}): Promise<AppMaterializationReceipt | null> {
	const changeSet = await loadChangeSet(args.changeSetId);
	if (changeSet === undefined || changeSet.status !== "committed") return null;
	if (changeSet.kind !== "genesis" || changeSet.proposedAppId === null) {
		throw new ChangeSetIntegrityError(
			`Committed change set ${changeSet.id} is not a genesis materialization.`,
		);
	}
	return await materializedReceipt(changeSet, args.actorUserId);
}

async function materializedReceipt(
	changeSet: DesignChangeSet,
	actorUserId: string,
): Promise<AppMaterializationReceipt> {
	const db = await getAppDb();
	const stored = await db
		.selectFrom("design_committed_slices")
		.select(["id", "app_id", "batch_id", "committed_snapshot_digest"])
		.where("change_set_id", "=", changeSet.id)
		.executeTakeFirst();
	if (stored === undefined) {
		throw new ChangeSetIntegrityError(
			`Change set ${changeSet.id} is committed but its committed-slice receipt is missing.`,
		);
	}
	const folded = await loadCanonicalBlueprintAtSequence(db, {
		appId: stored.app_id,
		seq: 1,
		expectedDigest: stored.committed_snapshot_digest,
	});
	const role = await withAppTx((tx) =>
		projectRoleForInTransaction(tx, actorUserId, folded.projectId),
	);
	if (role === null) {
		throw new ChangeSetScopeLostError(
			"This materialized app is no longer available in your Project scope.",
		);
	}
	return buildReceipt({
		designSessionId: changeSet.designSessionId,
		appId: stored.app_id,
		projectId: folded.projectId,
		role,
		batchId: stored.batch_id,
		changeSetId: changeSet.id,
		snapshotDigest: stored.committed_snapshot_digest,
		blueprint: folded.snapshot,
	});
}

function verifySessionForTransfer(
	session: LockedSessionRow,
	args: MaterializeGenesisArgs,
	holder: ExactRunHolderIdentity,
	proposedAppId: string,
): void {
	if (session.mode !== "build" || session.state !== "active") {
		throw new ChangeSetScopeLostError(
			`This design session is ${session.state}, so it cannot materialize.`,
		);
	}
	if (session.project_id !== args.expectedProjectId) {
		throw new ChangeSetScopeLostError(
			"This design session's Project no longer matches the caller's scope.",
		);
	}
	if (session.proposed_app_id !== proposedAppId) {
		throw new ChangeSetIntegrityError(
			`Design session ${session.id} proposes app ${session.proposed_app_id ?? "none"}, but the change set proposes ${proposedAppId}.`,
		);
	}
	if (session.awaiting_input) {
		throw new ChangeSetScopeLostError(
			"This design session is paused awaiting the user's answer; a paused run cannot materialize.",
		);
	}
	const lease = designSessionLeaseState(session);
	if (!exactRunHolderMatches(lease.holderIdentity, holder)) {
		throw new ChangeSetScopeLostError(
			"A newer request took over this design, so this run can no longer materialize it.",
		);
	}
}

function verifyOpenGenesisSet(
	changeSet: DesignChangeSet,
	preRead: DesignChangeSet,
	args: MaterializeGenesisArgs,
): void {
	if (changeSet.kind !== "genesis" || changeSet.proposedAppId === null) {
		throw new ChangeSetIntegrityError(
			`Change set ${changeSet.id} resolved as genesis before its lock but is ${changeSet.kind} under it.`,
		);
	}
	if (changeSet.status !== "open") {
		throw new ChangeSetScopeLostError(
			changeSet.status === "committed"
				? "This change set has already committed."
				: `This change set is ${changeSet.status} and can no longer materialize.`,
		);
	}
	if (
		changeSet.ownerUserId !== args.actorUserId ||
		changeSet.ownerRunId !== args.runId
	) {
		throw new ChangeSetScopeLostError(
			"This change set belongs to a different run.",
		);
	}
	if (changeSet.revision !== args.expectedRevision) {
		throw new ChangeSetScopeLostError(
			`This change set advanced to revision ${changeSet.revision} after this materialization was derived at revision ${args.expectedRevision}; inspect and retry from the current revision.`,
		);
	}
	if (
		changeSet.designSessionId !== preRead.designSessionId ||
		changeSet.designRevisionDigest !== preRead.designRevisionDigest ||
		changeSet.buildPlanDigest !== preRead.buildPlanDigest
	) {
		throw new ChangeSetIntegrityError(
			`Change set ${changeSet.id} no longer matches the lineage it resolved with before its lock.`,
		);
	}
}

function buildReceipt(args: {
	designSessionId: string;
	appId: string;
	projectId: string;
	role: string;
	batchId: string;
	changeSetId: string;
	snapshotDigest: string;
	blueprint: AppMaterializationReceipt["blueprint"];
}): AppMaterializationReceipt {
	return {
		eventVersion: 1,
		designSessionId: args.designSessionId,
		appId: args.appId,
		projectId: args.projectId,
		role: args.role,
		canEdit: roleAllowsApp(args.role, "edit"),
		seq: 1,
		batchId: args.batchId,
		changeSetId: args.changeSetId,
		snapshotDigest: args.snapshotDigest,
		blueprint: args.blueprint,
		starter: null,
	};
}
