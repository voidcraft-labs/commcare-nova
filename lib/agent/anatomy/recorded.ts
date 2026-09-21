/**
 * Read-only access to what local runs recorded: design sessions, their
 * model contexts, items, and completed steps; local apps with their newest
 * thread. Plain selects only. Nothing here takes run authority, opens a
 * context, or resolves an attachment.
 *
 * Append keys supply display categories. Unrecognized items remain visible.
 */

import { rehydrateModelMessage } from "@/lib/agent/modelMessagePersistence";
import type { NovaUIMessage } from "@/lib/chat/attachmentRefs";
import { modelMessagesContainCompaction } from "@/lib/chat/compaction";
import { loadAppForInspection } from "@/lib/db/apps";
import { getAppDb } from "@/lib/db/pg";
import { hydratePersistedBlueprint } from "@/lib/doc/fieldParent";
import type { PersistableDoc } from "@/lib/domain";
import { canonicalJsonDigest } from "@/lib/utils/canonicalJson";
import type {
	AppInput,
	DesignSessionInput,
	RecordedContext,
	RecordedItem,
	RecordedItemKind,
	RecordedStep,
	RecordedUsage,
} from "./types";

/** Display categories only; unknown keys remain visible without interpretation. */
export function classifyAppendKey(key: string): RecordedItemKind {
	if (
		key.startsWith("request:") ||
		key.startsWith("attachments:") ||
		key.startsWith("answers:")
	)
		return "source";
	if (key.startsWith("response:")) return "response";
	if (key.startsWith("tool:")) return "tool-result";
	if (
		key.startsWith("peer-feedback:") ||
		key.startsWith("completion-feedback:")
	)
		return "feedback";
	if (
		key === "review-context" ||
		key.startsWith("review-context:") ||
		key.startsWith("current-state:")
	)
		return "plan";
	if (key === "source") return "source";
	if (key.startsWith("translation-repair:")) return "feedback";
	if (key === "previous-conversation") return "previous-conversation";
	return "unknown";
}

// ── Usage ────────────────────────────────────────────────────────────────

function integer(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** The AI SDK's usage object as the step completion persisted it. */
export function normalizeRecordedUsage(
	usage: Record<string, unknown> | null,
): RecordedUsage | null {
	if (usage === null) return null;
	const inputDetails = usage.inputTokenDetails as
		| Record<string, unknown>
		| undefined;
	const outputDetails = usage.outputTokenDetails as
		| Record<string, unknown>
		| undefined;
	return {
		inputTokens: integer(usage.inputTokens),
		outputTokens: integer(usage.outputTokens),
		totalTokens: integer(usage.totalTokens),
		cachedInputTokens:
			integer(usage.cachedInputTokens) ??
			integer(inputDetails?.cacheReadTokens),
		reasoningTokens:
			integer(usage.reasoningTokens) ?? integer(outputDetails?.reasoningTokens),
	};
}

// ── Sessions ─────────────────────────────────────────────────────────────

export interface DesignSessionSummary {
	readonly designSessionId: string;
	readonly appId: string | null;
	readonly appName: string | null;
	readonly mode: string;
	readonly state: string;
	readonly updatedAt: string;
	readonly architectContexts: number;
	readonly peerContexts: number;
	readonly translatorContexts: number;
	readonly billedInputTokens: number;
	readonly billedOutputTokens: number;
	readonly costEstimate: number;
}

function iso(value: Date | string): string {
	return value instanceof Date
		? value.toISOString()
		: new Date(value).toISOString();
}

export async function listDesignSessions(
	limit = 50,
): Promise<DesignSessionSummary[]> {
	const db = await getAppDb();
	const sessions = await db
		.selectFrom("design_sessions")
		.leftJoin("apps", "apps.id", "design_sessions.app_id")
		.select([
			"design_sessions.id as id",
			"design_sessions.app_id as app_id",
			"design_sessions.mode as mode",
			"design_sessions.state as state",
			"design_sessions.updated_at as updated_at",
			"apps.app_name as app_name",
		])
		.orderBy("design_sessions.updated_at", "desc")
		.limit(limit)
		.execute();
	if (sessions.length === 0) return [];
	const ids = sessions.map((session) => session.id);
	// Postgres groups the counts and sums; one row per session and kind
	// comes back instead of every context and run row.
	const [contextCounts, runTotals] = await Promise.all([
		db
			.selectFrom("design_model_contexts")
			.select(({ fn }) => [
				"design_session_id",
				"context_kind",
				fn.countAll().as("contexts"),
			])
			.where("design_session_id", "in", ids)
			.groupBy(["design_session_id", "context_kind"])
			.execute(),
		db
			.selectFrom("run_summaries")
			.select(({ fn }) => [
				"design_session_id",
				fn.sum("input_tokens").as("input_tokens"),
				fn.sum("output_tokens").as("output_tokens"),
				fn.sum("cost_estimate").as("cost_estimate"),
			])
			.where("design_session_id", "in", ids)
			.groupBy("design_session_id")
			.execute(),
	]);
	const contextsOf = (sessionId: string, kind: string): number =>
		Number(
			contextCounts.find(
				(row) =>
					row.design_session_id === sessionId && row.context_kind === kind,
			)?.contexts ?? 0,
		);
	const totalsById = new Map(
		runTotals.map((row) => [row.design_session_id, row]),
	);
	return sessions.map((session) => {
		const totals = totalsById.get(session.id);
		return {
			designSessionId: session.id,
			appId: session.app_id,
			appName: session.app_name ?? null,
			mode: session.mode,
			state: session.state,
			updatedAt: iso(session.updated_at),
			architectContexts: contextsOf(session.id, "architect"),
			peerContexts: contextsOf(session.id, "peer"),
			translatorContexts: contextsOf(session.id, "translator"),
			billedInputTokens: Number(totals?.input_tokens ?? 0),
			billedOutputTokens: Number(totals?.output_tokens ?? 0),
			costEstimate: Number(totals?.cost_estimate ?? 0),
		};
	});
}

/** `design_sessions.id` is a uuid column; anything else would be a Postgres
 * type error rather than a missing row. */
const UUID_SHAPE =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function readDesignSession(
	designSessionId: string,
): Promise<DesignSessionInput | null> {
	if (!UUID_SHAPE.test(designSessionId)) return null;
	const db = await getAppDb();
	const session = await db
		.selectFrom("design_sessions")
		.leftJoin("apps", "apps.id", "design_sessions.app_id")
		.select(["design_sessions.id as id", "apps.app_name as app_name"])
		.where("design_sessions.id", "=", designSessionId)
		.executeTakeFirst();
	if (session === undefined) return null;
	const contextRows = await db
		.selectFrom("design_model_contexts")
		.selectAll()
		.where("design_session_id", "=", designSessionId)
		.where("context_kind", "in", ["architect", "peer", "translator"])
		.orderBy("generation", "asc")
		.orderBy("created_at", "asc")
		.execute();
	if (contextRows.length === 0) {
		return { designSessionId, appName: session.app_name ?? null, contexts: [] };
	}
	const contextIds = contextRows.map((row) => row.id);
	const [itemRows, stepRows] = await Promise.all([
		db
			.selectFrom("design_model_context_items")
			.selectAll()
			.where("context_id", "in", contextIds)
			.orderBy("context_id", "asc")
			.orderBy("ordinal", "asc")
			.execute(),
		db
			.selectFrom("design_model_steps")
			.selectAll()
			.where("context_id", "in", contextIds)
			.orderBy("created_at", "asc")
			.execute(),
	]);
	const contexts: RecordedContext[] = contextRows.map((row) => {
		const items: RecordedItem[] = itemRows
			.filter((item) => item.context_id === row.id)
			.map((item) => {
				const message = rehydrateModelMessage(item.message);
				const kind = classifyAppendKey(item.append_key);
				return {
					ordinal: Number(item.ordinal),
					appendKey: item.append_key,
					appendIndex: item.append_index,
					itemKind: kind,
					message,
					compaction: modelMessagesContainCompaction([message]),
					// The production reader refuses a row whose message no longer
					// matches its digest; an inspector shows the row and says so.
					verified: canonicalJsonDigest(item.message) === item.item_digest,
					createdAt: iso(item.created_at),
					createdByRunId: item.created_by_run_id,
				};
			});
		const stepsByKey = new Map<string, RecordedStep>();
		for (const step of stepRows.filter(
			(candidate) => candidate.context_id === row.id,
		)) {
			const existing = stepsByKey.get(step.step_key) ?? {
				stepKey: step.step_key,
				startedAt: null,
				completedAt: null,
				requestDigest: null,
				responseDigest: null,
				usage: null,
			};
			stepsByKey.set(step.step_key, {
				...existing,
				...(step.event_kind === "started" && {
					startedAt: iso(step.created_at),
					requestDigest: step.request_digest,
				}),
				...(step.event_kind === "completed" && {
					completedAt: iso(step.created_at),
					responseDigest: step.response_digest,
					usage: normalizeRecordedUsage(step.usage),
				}),
			});
		}
		return {
			contextId: row.id,
			kind: row.context_kind as RecordedContext["kind"],
			generation: row.generation,
			supersedesContextId: row.supersedes_context_id,
			modelId: row.model_id,
			promptVersion: row.prompt_version,
			toolsetDigest: row.toolset_digest,
			contextVersion: row.context_version,
			items,
			steps: [...stepsByKey.values()],
		};
	});
	return { designSessionId, appName: session.app_name ?? null, contexts };
}

// ── Apps ─────────────────────────────────────────────────────────────────

export interface LocalAppSummary {
	readonly appId: string;
	readonly appName: string;
	readonly status: string;
	readonly moduleCount: number;
	readonly formCount: number;
	readonly hasThread: boolean;
}

export async function listLocalApps(limit = 100): Promise<LocalAppSummary[]> {
	const db = await getAppDb();
	const apps = await db
		.selectFrom("apps")
		.select(["id", "app_name", "status", "module_count", "form_count"])
		.where("deleted_at", "is", null)
		.orderBy("app_name_lower", "asc")
		.limit(limit)
		.execute();
	if (apps.length === 0) return [];
	const threads = await db
		.selectFrom("threads")
		.select(["app_id"])
		.where(
			"app_id",
			"in",
			apps.map((app) => app.id),
		)
		.execute();
	const withThread = new Set(threads.map((thread) => thread.app_id));
	return apps.map((app) => ({
		appId: app.id,
		appName: app.app_name,
		status: app.status,
		moduleCount: app.module_count,
		formCount: app.form_count,
		hasThread: withThread.has(app.id),
	}));
}

function isUIMessageShaped(value: unknown): value is NovaUIMessage {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof (value as { role?: unknown }).role === "string" &&
		Array.isArray((value as { parts?: unknown }).parts)
	);
}

/** An app that exists but no longer passes the current commit gate. The
 * strict inspection loader refuses it; a page shows the refusal beside the
 * picker instead of failing the whole view. */
export class AppInspectionRefusal extends Error {
	readonly appId: string;
	constructor(appId: string, cause: unknown) {
		super(
			`This app can't be loaded under the current blueprint contract: ${cause instanceof Error ? cause.message : String(cause)}`,
			{ cause },
		);
		this.name = "AppInspectionRefusal";
		this.appId = appId;
	}
}

export async function readAppInput(appId: string): Promise<AppInput | null> {
	let loaded: Awaited<ReturnType<typeof loadAppForInspection>>;
	try {
		loaded = await loadAppForInspection(appId);
	} catch (error) {
		throw new AppInspectionRefusal(appId, error);
	}
	if (loaded === null) return null;
	const doc = hydratePersistedBlueprint(loaded.blueprint as PersistableDoc);
	const db = await getAppDb();
	const thread = await db
		.selectFrom("threads")
		.select(["thread_id", "messages"])
		.where("app_id", "=", appId)
		.orderBy("updated_at", "desc")
		.executeTakeFirst();
	return {
		appId,
		appName: loaded.app_name,
		doc,
		...(thread !== undefined && {
			thread: {
				threadId: thread.thread_id,
				messages: thread.messages.filter(isUIMessageShaped),
			},
		}),
	};
}
