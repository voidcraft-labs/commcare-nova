/**
 * The database half of the undeclared-worker-field repair
 * (`undeclaredWorkerFieldRepair.ts` is the pure half): a read-only plan of one
 * app, and its write as one guarded `blueprint-migration` batch.
 *
 * The plan reads the app row, its document and the lookup definitions it
 * names from one REPEATABLE READ, READ ONLY snapshot, then plans and proves
 * the repair (commit gate, replay, unchanged exports) with no transaction
 * open. The write locks the app, refuses while a run or an unsettled
 * reservation holds it, skips an app edited since its plan (a different
 * sequence or document), plans again from the locked document, requires the
 * same target, and writes through `appendSyntheticBatchInTransaction`, the
 * durable change log every repair writes through, so open builders reload.
 */

import { loadCanonicalBlueprintAtSequence } from "@/lib/agent/change-set/baseLoader";
import { lockActorGenerationGateForAppHolder } from "@/lib/db/actorGenerationGate";
import { appendSyntheticBatchInTransaction } from "@/lib/db/apps";
import { LEASE_COLUMNS, leaseView } from "@/lib/db/leaseView";
import { getAppDb, withAppTx } from "@/lib/db/pg";
import { designSessionLeaseState, runLeaseState } from "@/lib/db/runLiveness";
import { hydratePersistedBlueprint } from "@/lib/doc/fieldParent";
import {
	extractLookupReferenceTargets,
	type LookupValidationContext,
} from "@/lib/doc/lookupReferences";
import { readLookupDefinitionsInTransaction } from "@/lib/lookup/definitionSnapshot";
import { canonicalJsonDigest } from "@/lib/utils/canonicalJson";
import {
	nextPersistedSequence,
	safePersistedSequence,
} from "@/lib/utils/persistedSequence";
import {
	loadPersistedBlueprintInTransaction,
	loadPersistedBlueprintReadOnly,
} from "./loadPersistedBlueprint";
import {
	needsWorkerFieldRepair,
	repairUndeclaredWorkerFields,
	UndeclaredWorkerFieldRefusal,
	type UndeclaredWorkerFieldRefusalReason,
	verifyUndeclaredWorkerFieldRepair,
} from "./undeclaredWorkerFieldRepair";

export const UNDECLARED_WORKER_FIELD_ACTOR =
	"system:undeclared-worker-fields" as const;
const REASON =
	"Declare each worker field an expression reads from the session, and read every declared worker field by its identity.";

/** A repair planned and proved over one snapshot of one app. */
export interface UndeclaredWorkerFieldPlan {
	readonly appId: string;
	readonly expectedBaseSeq: number;
	readonly baseDigest: string;
	readonly targetDigest: string;
	readonly declaredCount: number;
	readonly reboundReads: number;
	readonly translationsKeptCurrent: number;
	readonly comparedArtifacts: number;
}

export type UndeclaredWorkerFieldInspection =
	| { readonly kind: "missing" }
	| { readonly kind: "clean" }
	| {
			readonly kind: "refused";
			readonly reason: UndeclaredWorkerFieldRefusalReason;
			readonly codes: readonly string[];
	  }
	| { readonly kind: "planned"; readonly plan: UndeclaredWorkerFieldPlan };

/** Plan and prove one app's repair. Opens only a read-only transaction. */
export async function inspectUndeclaredWorkerFields(
	appId: string,
): Promise<UndeclaredWorkerFieldInspection> {
	const db = await getAppDb();
	const snapshot = await db
		.transaction()
		.setIsolationLevel("repeatable read")
		.setAccessMode("read only")
		.execute(async (tx) => {
			const app = await tx
				.selectFrom("apps")
				.select(["project_id", "mutation_seq"])
				.where("id", "=", appId)
				.executeTakeFirst();
			if (app === undefined) return null;
			const blueprint = await loadPersistedBlueprintReadOnly(tx, appId);
			if (blueprint === null) return null;
			const targets = extractLookupReferenceTargets(
				hydratePersistedBlueprint(blueprint),
			);
			const lookup = await readLookupDefinitionsInTransaction(
				tx,
				app.project_id,
				targets.tableIds,
			);
			const lookupContext: LookupValidationContext = {
				kind: "available",
				...lookup,
			};
			return {
				expectedBaseSeq: safePersistedSequence(app.mutation_seq),
				blueprint,
				lookupContext,
			};
		});
	if (snapshot === null) return { kind: "missing" };
	if (!needsWorkerFieldRepair(snapshot.blueprint)) return { kind: "clean" };
	try {
		const repair = repairUndeclaredWorkerFields(snapshot.blueprint);
		const proof = verifyUndeclaredWorkerFieldRepair(
			snapshot.blueprint,
			repair,
			snapshot.lookupContext,
		);
		return {
			kind: "planned",
			plan: {
				appId,
				expectedBaseSeq: snapshot.expectedBaseSeq,
				baseDigest: canonicalJsonDigest(snapshot.blueprint),
				targetDigest: canonicalJsonDigest(repair.target),
				declaredCount: repair.declaredSlugs.length,
				reboundReads: repair.reboundReads,
				translationsKeptCurrent: repair.translationsKeptCurrent,
				comparedArtifacts: proof.artifacts,
			},
		};
	} catch (error) {
		if (!(error instanceof UndeclaredWorkerFieldRefusal)) throw error;
		return { kind: "refused", reason: error.reason, codes: error.codes };
	}
}

export type UndeclaredWorkerFieldWrite =
	| { readonly status: "committed" | "deduped"; readonly seq: number }
	| { readonly status: "already-applied"; readonly seq: number }
	| { readonly status: "skipped-changed" }
	| { readonly status: "skipped-held" };

/** The idempotency latch of one plan: one batch per app and base sequence. */
export function undeclaredWorkerFieldBatchId(
	plan: Pick<UndeclaredWorkerFieldPlan, "appId" | "expectedBaseSeq">,
): string {
	return `undeclared-worker-fields:${plan.appId}:${plan.expectedBaseSeq}`;
}

/** Write one planned repair in its own transaction, or skip it. */
export async function applyUndeclaredWorkerFieldRepair(
	plan: UndeclaredWorkerFieldPlan,
): Promise<UndeclaredWorkerFieldWrite> {
	const batchId = undeclaredWorkerFieldBatchId(plan);
	return withAppTx(async (tx): Promise<UndeclaredWorkerFieldWrite> => {
		await lockActorGenerationGateForAppHolder(tx, plan.appId);
		const app = await tx
			.selectFrom("apps")
			.select(["id", "mutation_seq", ...LEASE_COLUMNS])
			.where("id", "=", plan.appId)
			.forUpdate()
			.executeTakeFirst();
		if (app === undefined) return { status: "skipped-changed" };
		const sessions = await tx
			.selectFrom("design_sessions")
			.selectAll()
			.where("app_id", "=", plan.appId)
			.orderBy("id")
			.forUpdate()
			.execute();
		const lease = runLeaseState(leaseView(app));
		if (
			lease.present ||
			lease.markerSettleable ||
			sessions.some((session) => {
				const state = designSessionLeaseState(session);
				return state.present || state.markerSettleable;
			})
		)
			return { status: "skipped-held" };

		const receipt = await tx
			.selectFrom("app_changes")
			.select(["seq", "actor_id", "kind"])
			.where("app_id", "=", plan.appId)
			.where("batch_id", "=", batchId)
			.executeTakeFirst();
		if (receipt !== undefined) {
			const seq = safePersistedSequence(receipt.seq);
			if (
				receipt.actor_id !== UNDECLARED_WORKER_FIELD_ACTOR ||
				receipt.kind !== "blueprint-migration" ||
				seq !== nextPersistedSequence(plan.expectedBaseSeq)
			)
				throw new Error("The repair's receipt does not match its plan.");
			await loadCanonicalBlueprintAtSequence(tx, {
				appId: plan.appId,
				seq,
				expectedDigest: plan.targetDigest,
			});
			return { status: "already-applied", seq };
		}

		if (safePersistedSequence(app.mutation_seq) !== plan.expectedBaseSeq)
			return { status: "skipped-changed" };
		const before = await loadPersistedBlueprintInTransaction(tx, plan.appId);
		if (before === null || canonicalJsonDigest(before) !== plan.baseDigest)
			return { status: "skipped-changed" };
		const repair = repairUndeclaredWorkerFields(before);
		if (canonicalJsonDigest(repair.target) !== plan.targetDigest)
			throw new Error("The repair planned again does not reach its plan.");

		const result = await appendSyntheticBatchInTransaction(tx, {
			appId: plan.appId,
			expectedBaseSeq: plan.expectedBaseSeq,
			targetDoc: repair.target,
			batchId,
			authority: {
				kind: "system",
				actorId: UNDECLARED_WORKER_FIELD_ACTOR,
				reason: REASON,
			},
		});
		if (result.kind === "noop")
			throw new Error("The repair wrote no change to an app that needs one.");
		await loadCanonicalBlueprintAtSequence(tx, {
			appId: plan.appId,
			seq: result.seq,
			expectedDigest: plan.targetDigest,
		});
		return { status: result.kind, seq: result.seq };
	});
}
