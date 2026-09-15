/** One-time operator repair of incomplete historical SQL projections.
 * Canonical content and old history stay intact; a new complete baseline starts
 * future authoring. Serving code has no alternate snapshot reader. */
import { sql, type Transaction } from "kysely";
import { loadCanonicalBlueprintAtSequence } from "@/lib/agent/change-set/baseLoader";
import { lockActorGenerationGateForAppHolder } from "@/lib/db/actorGenerationGate";
import { loadAppInTransaction } from "@/lib/db/apps";
import {
	loadStrictAppSnapshotFromRowInTransaction,
	PERSISTED_BLUEPRINT_APP_COLUMNS,
	type PersistedBlueprintAppRow,
} from "@/lib/db/canonicalCommitKernel";
import { LEASE_COLUMNS, leaseView } from "@/lib/db/leaseView";
import { type AppDatabase, getAppDb, withAppTx } from "@/lib/db/pg";
import { designSessionLeaseState, runLeaseState } from "@/lib/db/runLiveness";
import { blueprintDocSchema } from "@/lib/domain";
import { canonicalJsonDigest } from "@/lib/utils/canonicalJson";
import { nextPersistedSequence } from "@/lib/utils/persistedSequence";

const BATCH = "fold-baseline:unified-authoring";
export interface AuthoringBaselineFinding {
	appId: string;
	status: "current" | "ready" | "busy" | "repaired";
	reason?: string;
}

export async function inspectAuthoringBaseline(
	tx: Transaction<AppDatabase>,
	appId: string,
): Promise<AuthoringBaselineFinding | null> {
	// The scanner owns a repeatable-read, read-only transaction. The writer
	// owns the app lock before calling this same inspection.
	const root = (await tx
		.selectFrom("apps")
		.select(PERSISTED_BLUEPRINT_APP_COLUMNS)
		.select(
			sql<string | null>`${sql.ref("apps.case_types")}::text`.as(
				"case_types_text",
			),
		)
		.select(
			sql<string | null>`${sql.ref("apps.localization")}::text`.as(
				"localization_text",
			),
		)
		.where("id", "=", appId)
		.executeTakeFirst()) as PersistedBlueprintAppRow | undefined;
	if (!root) return null;
	const { app } = await loadStrictAppSnapshotFromRowInTransaction(tx, root);
	const row = await tx
		.selectFrom("apps")
		.select(LEASE_COLUMNS)
		.where("id", "=", appId)
		.executeTakeFirstOrThrow();
	const lease = runLeaseState(leaseView(row));
	if (lease.holderIdentity !== null || lease.markerSettleable)
		return { appId, status: "busy" };
	const sessions = await tx
		.selectFrom("design_sessions")
		.selectAll()
		.where("app_id", "=", appId)
		.execute();
	if (
		sessions.some((session) => {
			const lease = designSessionLeaseState(session);
			return lease.present || lease.markerSettleable;
		})
	)
		return { appId, status: "busy" };
	const canonical = blueprintDocSchema.parse(app.blueprint);
	let reason: string;
	try {
		const folded = await loadCanonicalBlueprintAtSequence(tx, {
			appId,
			seq: app.mutation_seq,
			expectedDigest: null,
		});
		if (
			folded.projectId === app.project_id &&
			canonicalJsonDigest(folded.snapshot) === canonicalJsonDigest(canonical)
		)
			return { appId, status: "current" };
		reason = "Historical fold differs from the current canonical document.";
	} catch (error) {
		// Database failures are not evidence that a baseline needs replacing.
		if (error && typeof error === "object" && "code" in error) throw error;
		reason = error instanceof Error ? error.message : String(error);
	}
	const prior = await tx
		.selectFrom("app_changes")
		.select("seq")
		.where("app_id", "=", appId)
		.where("batch_id", "=", BATCH)
		.executeTakeFirst();
	if (prior)
		throw new Error(
			`App ${appId} no longer folds after its authoring repair: ${reason}`,
		);
	return { appId, status: "ready", reason };
}

export async function scanAuthoringBaselines(
	appId?: string,
): Promise<AuthoringBaselineFinding[]> {
	const db = await getAppDb();
	let query = db.selectFrom("apps").select("id").orderBy("id");
	if (appId !== undefined) query = query.where("id", "=", appId);
	const findings: AuthoringBaselineFinding[] = [];
	for (const app of await query.execute()) {
		const finding = await db
			.transaction()
			.setIsolationLevel("repeatable read")
			.setAccessMode("read only")
			.execute((tx) => inspectAuthoringBaseline(tx, app.id));
		if (finding && finding.status !== "current") findings.push(finding);
	}
	return findings;
}

export async function repairAuthoringBaseline(
	appId: string,
): Promise<AuthoringBaselineFinding | null> {
	return withAppTx((tx) => repairAuthoringBaselineInTransaction(tx, appId));
}

export async function repairAuthoringBaselineInTransaction(
	tx: Transaction<AppDatabase>,
	appId: string,
): Promise<AuthoringBaselineFinding | null> {
	await lockActorGenerationGateForAppHolder(tx, appId);
	const locked = await tx
		.selectFrom("apps")
		.select("id")
		.where("id", "=", appId)
		.forUpdate()
		.executeTakeFirst();
	if (!locked) return null;
	await tx
		.selectFrom("design_sessions")
		.select("id")
		.where("app_id", "=", appId)
		.orderBy("id")
		.forUpdate()
		.execute();
	const finding = await inspectAuthoringBaseline(tx, appId);
	if (finding?.status !== "ready") return finding;
	const app = await loadAppInTransaction(tx, appId);
	if (!app) throw new Error("The locked app disappeared.");
	const projected = await sql<{
		snapshot: unknown;
	}>`SELECT nova_current_app_change_fold_snapshot(${appId}) AS snapshot`.execute(
		tx,
	);
	const snapshot = blueprintDocSchema.parse(projected.rows[0]?.snapshot);
	if (canonicalJsonDigest(snapshot) !== canonicalJsonDigest(app.blueprint))
		throw new Error(
			"Install the complete snapshot projection before repairing authoring.",
		);
	const seq = nextPersistedSequence(
		app.mutation_seq,
		"authoring baseline repair",
	);
	// The admission trigger proves root and entity freshness in this transaction.
	// Values are unchanged; touching the rows gives the new baseline one generation.
	await sql`UPDATE blueprint_entities SET data = data WHERE app_id = ${appId}`.execute(
		tx,
	);
	await tx
		.updateTable("apps")
		.set({ mutation_seq: seq })
		.where("id", "=", appId)
		.execute();
	await tx
		.insertInto("app_changes")
		.values({
			app_id: appId,
			seq,
			batch_id: BATCH,
			actor_id: "system:unified-authoring",
			kind: "fold-baseline",
			mutations: "[]",
			run_id: null,
			from_project_id: null,
			to_project_id: null,
		})
		.execute();
	await sql`INSERT INTO app_change_fold_baselines (app_id, seq, project_id, snapshot, snapshot_digest)
   VALUES (${appId}, ${seq}, ${app.project_id}, ${JSON.stringify(snapshot)}::jsonb,
    nova_app_change_fold_snapshot_digest(${JSON.stringify(snapshot)}::jsonb))`.execute(
		tx,
	);
	// An old private base cannot cross the new horizon. Keep its history, and let
	// recovery start from the unchanged canonical app and retained Markdown plan.
	await tx
		.updateTable("authoring_workspaces")
		.set({ status: "abandoned", updated_at: new Date() })
		.where("app_id", "=", appId)
		.where("status", "=", "open")
		.execute();
	await sql`SELECT pg_notify('nova_app_stream', ${JSON.stringify({ appId, seq })})`.execute(
		tx,
	);
	return { appId, status: "repaired" };
}
