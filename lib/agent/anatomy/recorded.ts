/**
 * Read-only access to what local runs recorded: design sessions, their
 * model contexts, items, and completed steps; local apps with their newest
 * thread. Plain selects only. Nothing here takes run authority, opens a
 * context, or resolves an attachment.
 *
 * The append-key classifier is the one place an append key becomes a
 * family. `__tests__/recorded.test.ts` sweeps the runner sources so a new
 * prefix cannot appear without a family here.
 */

import type { ModelMessage } from "ai";
import { rehydrateModelMessage } from "@/lib/agent/modelMessagePersistence";
import type { NovaUIMessage } from "@/lib/chat/attachmentRefs";
import { loadAppForInspection } from "@/lib/db/apps";
import { getAppDb } from "@/lib/db/pg";
import { hydratePersistedBlueprint } from "@/lib/doc/fieldParent";
import type { PersistableDoc } from "@/lib/domain";
import type {
	AppInput,
	DesignSessionInput,
	RecordedContext,
	RecordedItem,
	RecordedItemKind,
	RecordedStep,
	RecordedUsage,
} from "./types";

// ── Append keys ──────────────────────────────────────────────────────────

interface KeyFamily {
	readonly prefix: string;
	readonly kind: RecordedItemKind;
}

/** Message-bearing append keys, by prefix, in the order they are tried. */
export const APPEND_KEY_FAMILIES: readonly KeyFamily[] = [
	{ prefix: "seed:", kind: "seed" },
	{ prefix: "seed-through:", kind: "seed" },
	{ prefix: "ui-turn:", kind: "user-turn" },
	{ prefix: "answer:", kind: "answer" },
	{ prefix: "state:", kind: "state-packet" },
	{ prefix: "compaction-state:", kind: "compaction-state" },
	{ prefix: "required-question-v5:", kind: "required-questions" },
	{ prefix: "required-question-card-v1:", kind: "question-card" },
	{ prefix: "required-question-rejection:", kind: "correction" },
	{ prefix: "required-question-omission:", kind: "correction" },
	{ prefix: "input-terminal-rejection:", kind: "correction" },
	{ prefix: "design-terminal-omission:", kind: "correction" },
	{ prefix: "design-response:", kind: "response" },
	{ prefix: "design-wait:", kind: "wait" },
	{ prefix: "recovered-design-wait:", kind: "wait" },
	{ prefix: "slice-brief:", kind: "slice-brief" },
	{ prefix: "candidate:", kind: "candidate-checkpoint" },
	{ prefix: "focus:", kind: "slice-focus" },
	{ prefix: "compaction-reseed:", kind: "compaction-reseed" },
];

/** Append-key prefixes the runners template that never carry a message:
 * budget claims and idempotency fences. Listed so the source sweep can tell
 * a new message family from a new claim key. */
export const NON_MESSAGE_KEY_PREFIXES: readonly string[] = [
	"model:",
	"mutation:",
	"design-claim:",
	"finish:",
	"design:",
	"ephemeral:",
	"review:",
	"blocker:",
	"auto-blocker:",
];

function stepKeyKind(key: string): RecordedItemKind | undefined {
	if (!key.startsWith("step:")) return undefined;
	if (key.endsWith(":response")) return "response";
	if (key.endsWith(":empty")) return "empty-step-nudge";
	if (key.includes(":tool:")) return "tool-result";
	return undefined;
}

export function classifyAppendKey(key: string): RecordedItemKind {
	const step = stepKeyKind(key);
	if (step !== undefined) return step;
	const family = APPEND_KEY_FAMILIES.find((candidate) =>
		key.startsWith(candidate.prefix),
	);
	return family?.kind ?? "unknown";
}

/** A tool result that carries the architect's guidance or answers a
 * reportExecutionBlocker call is chipped by what it carries, not by its key. */
export function refineToolResultKind(
	kind: RecordedItemKind,
	message: ModelMessage,
): RecordedItemKind {
	if (kind !== "tool-result" || message.role !== "tool") return kind;
	for (const part of message.content) {
		if (part.type !== "tool-result") continue;
		if (part.toolName === "reportExecutionBlocker") return "blocker";
		const output = part.output;
		if (
			output.type === "json" &&
			output.value !== null &&
			typeof output.value === "object" &&
			"architectGuidance" in output.value
		) {
			return "auto-blocker";
		}
	}
	return kind;
}

function messageHasCompactionPart(message: ModelMessage): boolean {
	if (typeof message.content === "string") return false;
	return message.content.some(
		(part) =>
			(part as { type?: unknown; kind?: unknown }).type === "custom" &&
			(part as { kind?: unknown }).kind === "openai.compaction",
	);
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

// ── Context versions ─────────────────────────────────────────────────────

const SEMANTIC_SCOPE = ":semantic-scope:";

/** The slice attempt id an executor context version names, if any. */
export function semanticScopeOf(contextVersion: string): string | null {
	const index = contextVersion.indexOf(SEMANTIC_SCOPE);
	if (index === -1) return null;
	const scope = contextVersion.slice(index + SEMANTIC_SCOPE.length);
	return scope.length > 0 ? scope : null;
}

// ── Sessions ─────────────────────────────────────────────────────────────

export interface DesignSessionSummary {
	readonly designSessionId: string;
	readonly appId: string | null;
	readonly appName: string | null;
	readonly mode: string;
	readonly state: string;
	readonly updatedAt: string;
	readonly designContexts: number;
	readonly executorContexts: number;
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
	const contexts = await db
		.selectFrom("design_model_contexts")
		.select(["design_session_id", "context_kind"])
		.where("design_session_id", "in", ids)
		.execute();
	const summaries = await db
		.selectFrom("run_summaries")
		.select([
			"design_session_id",
			"input_tokens",
			"output_tokens",
			"cost_estimate",
		])
		.where("design_session_id", "in", ids)
		.execute();
	return sessions.map((session) => {
		const own = contexts.filter(
			(context) => context.design_session_id === session.id,
		);
		const runs = summaries.filter(
			(summary) => summary.design_session_id === session.id,
		);
		return {
			designSessionId: session.id,
			appId: session.app_id,
			appName: session.app_name ?? null,
			mode: session.mode,
			state: session.state,
			updatedAt: iso(session.updated_at),
			designContexts: own.filter((context) => context.context_kind === "design")
				.length,
			executorContexts: own.filter(
				(context) => context.context_kind === "executor",
			).length,
			billedInputTokens: runs.reduce(
				(sum, run) => sum + Number(run.input_tokens),
				0,
			),
			billedOutputTokens: runs.reduce(
				(sum, run) => sum + Number(run.output_tokens),
				0,
			),
			costEstimate: runs.reduce(
				(sum, run) => sum + Number(run.cost_estimate),
				0,
			),
		};
	});
}

export async function readDesignSession(
	designSessionId: string,
): Promise<DesignSessionInput | null> {
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
		.orderBy("generation", "asc")
		.orderBy("created_at", "asc")
		.execute();
	if (contextRows.length === 0) {
		return { designSessionId, appName: session.app_name ?? null, contexts: [] };
	}
	const contextIds = contextRows.map((row) => row.id);
	const [itemRows, stepRows, attemptRows] = await Promise.all([
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
		db
			.selectFrom("design_slice_attempts")
			.select(["id", "slice_id", "attempt", "status"])
			.where("design_session_id", "=", designSessionId)
			.execute(),
	]);
	const attemptsById = new Map(attemptRows.map((row) => [row.id, row]));
	const contexts: RecordedContext[] = contextRows.map((row) => {
		const items: RecordedItem[] = itemRows
			.filter((item) => item.context_id === row.id)
			.map((item) => {
				const message = rehydrateModelMessage(item.message);
				const kind = refineToolResultKind(
					classifyAppendKey(item.append_key),
					message,
				);
				return {
					ordinal: Number(item.ordinal),
					appendKey: item.append_key,
					appendIndex: item.append_index,
					itemKind: kind,
					message,
					compaction: messageHasCompactionPart(message),
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
		const scope = semanticScopeOf(row.context_version);
		const attempt = scope === null ? undefined : attemptsById.get(scope);
		return {
			contextId: row.id,
			kind: row.context_kind === "executor" ? "executor" : "design",
			generation: row.generation,
			supersedesContextId: row.supersedes_context_id,
			modelId: row.model_id,
			promptVersion: row.prompt_version,
			toolsetDigest: row.toolset_digest,
			contextVersion: row.context_version,
			...(scope !== null && {
				slice: {
					attemptId: scope,
					sliceId: attempt?.slice_id ?? null,
					attempt: attempt?.attempt ?? null,
					status: attempt?.status ?? null,
				},
			}),
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

export async function readAppInput(appId: string): Promise<AppInput | null> {
	const loaded = await loadAppForInspection(appId);
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

export interface AppRunSummary {
	readonly runId: string;
	readonly startedAt: string;
	readonly finishedAt: string;
	readonly model: string;
	readonly stepCount: number;
	readonly toolCallCount: number;
	readonly inputTokens: number;
	readonly outputTokens: number;
	readonly cacheReadTokens: number;
	readonly costEstimate: number;
}

/** Run-level billed usage for an app's chat runs. There is no per-turn
 * record of the architect's wire, so this is the only calibration it has. */
export async function readAppRunSummaries(
	appId: string,
	limit = 20,
): Promise<AppRunSummary[]> {
	const db = await getAppDb();
	const rows = await db
		.selectFrom("run_summaries")
		.selectAll()
		.where("app_id", "=", appId)
		.orderBy("finished_at", "desc")
		.limit(limit)
		.execute();
	return rows.map((row) => ({
		runId: row.run_id,
		startedAt: iso(row.started_at),
		finishedAt: iso(row.finished_at),
		model: row.model,
		stepCount: row.step_count,
		toolCallCount: row.tool_call_count,
		inputTokens: Number(row.input_tokens),
		outputTokens: Number(row.output_tokens),
		cacheReadTokens: Number(row.cache_read_tokens),
		costEstimate: Number(row.cost_estimate),
	}));
}
