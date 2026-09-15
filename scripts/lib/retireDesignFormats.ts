/** One-time retirement of obsolete private design formats. Never imported by
 * serving code; sealed history and billing records are retained verbatim. */
import { type Kysely, sql, type Transaction } from "kysely";
import {
	lockActorGenerationGateForAppHolder,
	lockActorGenerationGateForSessionHolder,
} from "@/lib/db/actorGenerationGate";
import { releaseDesignLookupProtectionsInTransaction } from "@/lib/db/designLookupMaterializations";
import { LEASE_COLUMNS, leaseView } from "@/lib/db/leaseView";
import { type AppDatabase, getAppDb, withAppTx } from "@/lib/db/pg";
import { designSessionLeaseState, runLeaseState } from "@/lib/db/runLiveness";

type Db = Kysely<AppDatabase> | Transaction<AppDatabase>;

export interface DesignFormatRetirement {
	sessionId: string;
	appId: string | null;
	status:
		| "ready"
		| "busy"
		| "incomplete-app"
		| "unaccounted-usage"
		| "current"
		| "retired"
		| "retry";
	obsoleteRevisions: number;
	obsoleteOperations: number;
	threads: number;
}

async function oldFormatCounts(db: Db, sessionId: string) {
	const result = await sql<{
		revisions: number;
		operations: number;
		threads: number;
		unaccounted: boolean;
	}>`select
		(select count(*)::int from design_revisions
		 where design_session_id = ${sessionId}::uuid
		 and envelope->'payload'->>'schemaVersion' is distinct from '2') as revisions,
		(select count(*)::int from design_artifact_workspace_steps step
		 join design_artifact_workspaces workspace on workspace.id = step.workspace_id
		 where workspace.design_session_id = ${sessionId}::uuid
		 and step.operation->>'storageVersion' is distinct from '3') as operations,
		(select count(*)::int from threads where design_session_id = ${sessionId}::uuid) as threads,
		(exists (
			select 1 from design_model_steps step
			join design_model_contexts context on context.id = step.context_id
			where context.design_session_id = ${sessionId}::uuid
			and step.event_kind = 'completed' and step.usage is not null
			and not exists (
				select 1 from design_model_step_usage_accounts account
				where account.context_id = step.context_id and account.step_key = step.step_key
				and account.event_kind = step.event_kind
			)
		) or exists (
			select 1 from design_localization_batches batch
			join design_localization_attempts attempt on attempt.id = batch.attempt_id
			where attempt.design_session_id = ${sessionId}::uuid and batch.usage is not null
			and not exists (
				select 1 from design_localization_batch_usage_accounts account
				where account.batch_id = batch.id
			)
		)) as unaccounted
	`.execute(db);
	const row = result.rows[0];
	if (!row) throw new Error("Design-format scan returned no result.");
	return row;
}

async function inspectSession(
	db: Db,
	sessionId: string,
): Promise<DesignFormatRetirement | null> {
	const session = await db
		.selectFrom("design_sessions")
		.selectAll()
		.where("id", "=", sessionId)
		.executeTakeFirst();
	if (!session) return null;
	const counts = await oldFormatCounts(db, sessionId);
	const result: DesignFormatRetirement = {
		sessionId,
		appId: session.app_id,
		status: "ready",
		obsoleteRevisions: counts.revisions,
		obsoleteOperations: counts.operations,
		threads: counts.threads,
	};
	if (session.state === "retired") return { ...result, status: "retired" };
	if (counts.revisions + counts.operations === 0)
		return { ...result, status: "current" };
	const sessionLease = designSessionLeaseState(session);
	if (sessionLease.present || sessionLease.markerSettleable)
		return { ...result, status: "busy" };
	if (session.app_id !== null) {
		const app = await db
			.selectFrom("apps")
			.select(LEASE_COLUMNS)
			.where("id", "=", session.app_id)
			.executeTakeFirstOrThrow();
		const lease = runLeaseState(leaseView(app));
		if (lease.holderIdentity !== null || lease.markerSettleable)
			return { ...result, status: "busy" };
		if (session.mode === "build" && app.status !== "complete")
			return { ...result, status: "incomplete-app" };
	}
	if (counts.unaccounted) return { ...result, status: "unaccounted-usage" };
	return result;
}

/** Read-only scan, including historical terminal scopes. No old JSON is parsed. */
export async function scanObsoleteDesignFormats(): Promise<
	DesignFormatRetirement[]
> {
	const db = await getAppDb();
	const sessions = await db
		.selectFrom("design_sessions")
		.select("id")
		.where("state", "!=", "retired")
		.orderBy("id")
		.execute();
	const results: DesignFormatRetirement[] = [];
	for (const session of sessions) {
		const result = await inspectSession(db, session.id);
		if (result !== null && result.status !== "current") results.push(result);
	}
	return results;
}

export async function retireObsoleteDesignSession(
	sessionId: string,
): Promise<DesignFormatRetirement | null> {
	return withAppTx(async (tx) => {
		const mapping = await tx
			.selectFrom("design_sessions")
			.select(["app_id"])
			.where("id", "=", sessionId)
			.executeTakeFirst();
		if (!mapping) return null;
		if (mapping.app_id === null) {
			await lockActorGenerationGateForSessionHolder(tx, sessionId);
		} else {
			await lockActorGenerationGateForAppHolder(tx, mapping.app_id);
			await tx
				.selectFrom("apps")
				.select("id")
				.where("id", "=", mapping.app_id)
				.forUpdate()
				.executeTakeFirstOrThrow();
		}
		const session = await tx
			.selectFrom("design_sessions")
			.select(["app_id"])
			.where("id", "=", sessionId)
			.forUpdate()
			.executeTakeFirst();
		if (!session) return null;
		// Materialization won the pre-app lock race. Do not acquire its app lock
		// while holding the session; a new invocation follows app-first order.
		if (session.app_id !== mapping.app_id)
			return {
				sessionId,
				appId: session.app_id,
				status: "retry",
				obsoleteRevisions: 0,
				obsoleteOperations: 0,
				threads: 0,
			};
		const result = await inspectSession(tx, sessionId);
		if (result?.status !== "ready") return result;
		await tx
			.updateTable("design_change_sets")
			.set({ status: "abandoned", updated_at: new Date() })
			.where("design_session_id", "=", sessionId)
			.where("status", "=", "open")
			.execute();
		await tx
			.updateTable("design_slice_attempts")
			.set({
				status: "superseded",
				failure_code: "design-format-retired",
				updated_at: new Date(),
			})
			.where("design_session_id", "=", sessionId)
			.where("status", "=", "running")
			.execute();
		await tx
			.updateTable("design_artifact_workspaces")
			.set({
				status: "superseded",
				updated_by_run_id: "system:design-format-retirement",
				updated_at: new Date(),
			})
			.where("design_session_id", "=", sessionId)
			.where("status", "=", "open")
			.execute();
		await releaseDesignLookupProtectionsInTransaction(tx, sessionId);
		await tx
			.updateTable("threads")
			.set({
				...(session.app_id === null
					? {}
					: { app_id: session.app_id, design_session_id: null }),
				active_stream_id: null,
				active_holder_nonce: null,
				updated_at: new Date().toISOString(),
			})
			.where("design_session_id", "=", sessionId)
			.execute();
		await tx
			.updateTable("design_sessions")
			.set({
				state: "retired",
				awaiting_input: false,
				run_id: null,
				run_holder_nonce: null,
				run_actor_user_id: null,
				run_mode: null,
				run_lease_expires_at: null,
				res_period: null,
				res_reserved: null,
				res_settled: null,
				res_user_id: null,
				res_run_id: null,
				active_design_revision_id: null,
				active_build_plan_id: null,
				updated_at: new Date(),
			})
			.where("id", "=", sessionId)
			.execute();
		return { ...result, status: "retired" };
	});
}
