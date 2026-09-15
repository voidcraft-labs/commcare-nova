/** Operator-only cutover. Serving code never interprets the old design graph. */
import { type Kysely, sql, type Transaction } from "kysely";
import {
	lockActorGenerationGateForAppHolder,
	lockActorGenerationGateForSessionHolder,
} from "@/lib/db/actorGenerationGate";
import { releaseDesignLookupProtectionsInTransaction } from "@/lib/db/designLookupMaterializations";
import { LEASE_COLUMNS, leaseView } from "@/lib/db/leaseView";
import { type AppDatabase, getAppDb, withAppTx } from "@/lib/db/pg";
import { designSessionLeaseState, runLeaseState } from "@/lib/db/runLiveness";
import { canonicalJsonDigest } from "@/lib/utils/canonicalJson";

type Db = Kysely<AppDatabase> | Transaction<AppDatabase>;
export interface AuthoringMigrationFinding {
	sessionId: string;
	appId: string | null;
	status:
		| "ready"
		| "busy"
		| "unaccounted-usage"
		| "current"
		| "migrated"
		| "retry";
}

async function inspect(
	db: Db,
	sessionId: string,
): Promise<AuthoringMigrationFinding | null> {
	const session = await db
		.selectFrom("design_sessions")
		.selectAll()
		.where("id", "=", sessionId)
		.executeTakeFirst();
	if (!session) return null;
	const finding = { sessionId, appId: session.app_id };
	if (session.authoring_version === 1) return { ...finding, status: "current" };
	const sessionLease = designSessionLeaseState(session);
	if (sessionLease.present || sessionLease.markerSettleable)
		return { ...finding, status: "busy" };
	if (session.app_id !== null) {
		const app = await db
			.selectFrom("apps")
			.select(LEASE_COLUMNS)
			.where("id", "=", session.app_id)
			.executeTakeFirstOrThrow();
		const lease = runLeaseState(leaseView(app));
		if (lease.holderIdentity !== null || lease.markerSettleable)
			return { ...finding, status: "busy" };
	}
	const { rows } = await sql<{ unaccounted: boolean }>`SELECT (
		EXISTS (
			SELECT 1 FROM design_model_steps step
			JOIN design_model_contexts context ON context.id = step.context_id
			WHERE context.design_session_id = ${sessionId}::uuid
			AND step.event_kind = 'completed' AND step.usage IS NOT NULL
			AND NOT EXISTS (SELECT 1 FROM design_model_step_usage_accounts account
				WHERE account.context_id = step.context_id AND account.step_key = step.step_key AND account.event_kind = step.event_kind)
		) OR EXISTS (
			SELECT 1 FROM design_localization_batches batch
			JOIN design_localization_attempts attempt ON attempt.id = batch.attempt_id
			WHERE attempt.design_session_id = ${sessionId}::uuid AND batch.usage IS NOT NULL
			AND NOT EXISTS (SELECT 1 FROM design_localization_batch_usage_accounts account WHERE account.batch_id = batch.id)
		)
	) AS unaccounted`.execute(db);
	return {
		...finding,
		status: rows[0]?.unaccounted ? "unaccounted-usage" : "ready",
	};
}

export async function scanLegacyAuthoring(): Promise<
	AuthoringMigrationFinding[]
> {
	const db = await getAppDb();
	const sessions = await db
		.selectFrom("design_sessions")
		.select("id")
		.where("authoring_version", "=", 0)
		.orderBy("id")
		.execute();
	const findings: AuthoringMigrationFinding[] = [];
	for (const session of sessions) {
		const finding = await inspect(db, session.id);
		if (finding) findings.push(finding);
	}
	return findings;
}

function record(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

/** Preserve useful prose without carrying UUID graphs or executor instructions
 * into the new conversation. Full original artifacts remain immutable history. */
function historicalMarkdown(envelope: unknown): string | null {
	const payload = record(record(envelope)?.payload);
	if (!payload) return null;
	const proseKeys = new Set([
		"appName",
		"name",
		"title",
		"label",
		"objective",
		"purpose",
		"meaning",
		"summary",
		"description",
		"rationale",
		"text",
		"question",
		"answer",
		"statement",
		"goals",
		"responsibilities",
		"workContext",
		"constraints",
		"excludedWorkflows",
		"requiredWhen",
		"when",
		"outcome",
		"reason",
	]);
	const sections: string[] = [];
	for (const [key, heading] of [
		["charter", "Purpose"],
		["actors", "People"],
		["records", "Records"],
		["workflows", "Workflows"],
		["lists", "Lists"],
		["access", "Access"],
		["externalRequirements", "External requirements"],
		["decisions", "Decisions"],
		["assumptions", "Assumptions"],
		["openQuestions", "Open questions"],
	] as const) {
		const lines = new Set<string>();
		const visit = (value: unknown, includeStrings = false) => {
			if (typeof value === "string") {
				if (includeStrings && value.trim()) lines.add(value.trim());
			} else if (Array.isArray(value)) {
				for (const entry of value) visit(entry, includeStrings);
			} else {
				for (const [name, entry] of Object.entries(record(value) ?? {}))
					visit(entry, proseKeys.has(name));
			}
		};
		visit(payload[key]);
		if (lines.size)
			sections.push(
				`## ${heading}\n\n${[...lines].map((line) => `- ${line}`).join("\n")}`,
			);
	}
	if (!sections.length) return null;
	const text = `# Earlier design\n\nImported from Nova's previous design format. Review against the user's request and current app before continuing. The original artifacts remain in history.\n\n${sections.join("\n\n")}`;
	return text.length <= 200_000
		? text
		: `${text.slice(0, 199_800)}\n\nThe remaining historical detail is in the original artifacts.`;
}

export async function migrateLegacyAuthoring(
	sessionId: string,
): Promise<AuthoringMigrationFinding | null> {
	return withAppTx(async (tx) => {
		const mapping = await tx
			.selectFrom("design_sessions")
			.select("app_id")
			.where("id", "=", sessionId)
			.executeTakeFirst();
		if (!mapping) return null;
		if (mapping.app_id === null)
			await lockActorGenerationGateForSessionHolder(tx, sessionId);
		else {
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
			.selectAll()
			.where("id", "=", sessionId)
			.forUpdate()
			.executeTakeFirstOrThrow();
		if (session.app_id !== mapping.app_id)
			return { sessionId, appId: session.app_id, status: "retry" };
		const finding = await inspect(tx, sessionId);
		if (finding?.status !== "ready") return finding;
		const revision = await tx
			.selectFrom("design_revisions")
			.select("envelope")
			.where("design_session_id", "=", sessionId)
			.orderBy("revision", "desc")
			.executeTakeFirst();
		const markdown = historicalMarkdown(revision?.envelope);
		if (markdown) {
			await tx
				.insertInto("authoring_plans")
				.values({
					session_id: sessionId,
					revision: 1,
					review_id: null,
					review_complete: false,
					reviewed_revision: null,
				})
				.execute();
			await tx
				.insertInto("authoring_plan_revisions")
				.values({
					session_id: sessionId,
					revision: 1,
					markdown,
					editor: "migration",
					run_id: "system:authoring-migration",
					request_id: "historical-plan",
					request_digest: canonicalJsonDigest(markdown),
				})
				.execute();
		}
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
				failure_code: "authoring-migrated",
				updated_at: new Date(),
			})
			.where("design_session_id", "=", sessionId)
			.where("status", "=", "running")
			.execute();
		await tx
			.updateTable("design_artifact_workspaces")
			.set({
				status: "superseded",
				updated_by_run_id: "system:authoring-migration",
				updated_at: new Date(),
			})
			.where("design_session_id", "=", sessionId)
			.where("status", "=", "open")
			.execute();
		await releaseDesignLookupProtectionsInTransaction(tx, sessionId);
		const app =
			session.app_id === null
				? null
				: await tx
						.selectFrom("apps")
						.select("status")
						.where("id", "=", session.app_id)
						.executeTakeFirstOrThrow();
		const finished = app?.status === "complete";
		await tx
			.updateTable("threads")
			.set({
				...(finished
					? { app_id: session.app_id, design_session_id: null }
					: {}),
				active_stream_id: null,
				active_holder_nonce: null,
				updated_at: new Date().toISOString(),
			})
			.where("design_session_id", "=", sessionId)
			.execute();
		await tx
			.updateTable("design_sessions")
			.set({
				authoring_version: 1,
				state: finished ? "retired" : session.state,
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
		return { ...finding, status: "migrated" };
	});
}
