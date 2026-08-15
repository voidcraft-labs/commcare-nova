/** Durable, exact, append-only model context for reviewed design/build roles. */

import { randomUUID } from "node:crypto";
import type { LanguageModelUsage, ModelMessage } from "ai";
import { sql, type Transaction } from "kysely";
import { z } from "zod";
import {
	persistModelMessage,
	rehydrateModelMessage,
} from "@/lib/agent/modelMessagePersistence";
import { assertDesignSessionRunAuthorityInTransaction } from "@/lib/db/designSessions";
import { parsePersistedJsonText } from "@/lib/db/persistedJson";
import { type AppDatabase, withAppTx } from "@/lib/db/pg";
import { canonicalJsonDigest } from "@/lib/utils/canonicalJson";
import { safePersistedSequence } from "@/lib/utils/persistedSequence";

export type DesignModelContextKind = "design" | "executor";

export interface DesignModelContextAuthority {
	readonly actorUserId: string;
	readonly runId: string;
	readonly holderNonce: string;
	readonly expectedProjectId: string;
}

export interface DesignModelContextSpec {
	readonly designSessionId: string;
	readonly kind: DesignModelContextKind;
	readonly modelId: string;
	readonly promptVersion: string;
	readonly toolsetDigest: string;
	readonly contextVersion: string;
	/** Executor-only semantic generation key. A new slice attempt receives a
	 * fresh immutable generation even when its provider contract is unchanged;
	 * recovery of that exact attempt reopens the same generation. */
	readonly semanticScopeKey?: string;
	readonly authority: DesignModelContextAuthority;
}

export interface DesignModelContextState {
	readonly id: string;
	readonly generation: number;
	readonly supersedesContextId: string | null;
	readonly revision: number;
	readonly messages: ModelMessage[];
	readonly items: readonly DesignModelContextItem[];
	readonly appendKeys: ReadonlySet<string>;
	/** Server protocol provenance retained across immutable generations. */
	readonly lineageAppendKeys: ReadonlySet<string>;
	readonly startedStepKeys: ReadonlySet<string>;
	readonly completedStepKeys: ReadonlySet<string>;
	/** Completed calls in this context generation and every immutable
	 * predecessor. Recovery replays usage only for rows authored by its exact
	 * run, so a paid response cannot disappear from the replacement run's
	 * accounting or be inherited by an unrelated later instruction. */
	readonly completedSteps: readonly DesignModelCompletedStep[];
	/** Provider calls spent by this context and every immutable predecessor. */
	readonly totalStartedStepCount: number;
}

export interface DesignModelContextItem {
	readonly appendKey: string;
	readonly message: ModelMessage;
}

export interface DesignModelCompletedStep {
	readonly contextId: string;
	readonly stepKey: string;
	readonly createdByRunId: string;
	readonly createdAt: Date;
	readonly usage: LanguageModelUsage | undefined;
}

/** Project every identity-bearing completed response authored by this run.
 * The usage accumulator registers these identities on every recovery and the
 * run-summary transaction admits each one exactly once. Keeping idempotency at
 * that write boundary avoids timestamp watermarks, which cannot distinguish
 * overlapping POST finalizers for one long-lived run id. */
export function recoverableCompletedModelSteps(
	steps: readonly DesignModelCompletedStep[],
	runId: string,
): Array<DesignModelCompletedStep & { readonly usage: LanguageModelUsage }> {
	const seen = new Set<string>();
	const unaccounted: Array<
		DesignModelCompletedStep & { readonly usage: LanguageModelUsage }
	> = [];
	for (const step of steps) {
		const identity = `${step.contextId}:${step.stepKey}`;
		if (
			seen.has(identity) ||
			step.createdByRunId !== runId ||
			step.usage === undefined
		) {
			continue;
		}
		seen.add(identity);
		unaccounted.push({ ...step, usage: step.usage });
	}
	return unaccounted;
}

export interface DurableModelUsageIdentity {
	readonly contextId: string;
	readonly stepKey: string;
}

export type DesignModelStepEvent =
	| {
			readonly eventKind: "started";
			readonly requestDigest: string;
	  }
	| {
			readonly eventKind: "completed";
			readonly responseDigest: string;
			readonly usage?: Record<string, unknown>;
	  };

export class DesignModelContextError extends Error {
	readonly name = "DesignModelContextError";
}

async function authorize(
	tx: Transaction<AppDatabase>,
	designSessionId: string,
	authority: DesignModelContextAuthority,
): Promise<void> {
	await assertDesignSessionRunAuthorityInTransaction(tx, {
		designSessionId,
		actorUserId: authority.actorUserId,
		expectedProjectId: authority.expectedProjectId,
		holder: {
			mode: "build",
			runId: authority.runId,
			nonce: authority.holderNonce,
		},
	});
}

async function readItems(
	tx: Transaction<AppDatabase>,
	contextId: string,
): Promise<DesignModelContextItem[]> {
	const rows = await tx
		.selectFrom("design_model_context_items")
		.select(["ordinal", "append_key", "item_digest", "message"])
		.where("context_id", "=", contextId)
		.orderBy("ordinal", "asc")
		.execute();
	return rows.map((row) => {
		if (canonicalJsonDigest(row.message) !== row.item_digest) {
			throw new DesignModelContextError(
				`Model context item ${String(row.ordinal)} no longer matches its digest.`,
			);
		}
		try {
			return {
				appendKey: row.append_key,
				message: rehydrateModelMessage(row.message),
			};
		} catch (error) {
			throw new DesignModelContextError(
				`Model context item ${String(row.ordinal)} cannot be rehydrated: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	});
}

/** Both step-key sets in one query — the open path needs started AND
 * completed, and two separate reads over the same rows would double the
 * round trips. */
async function readStepKeysByEvent(
	tx: Transaction<AppDatabase>,
	contextId: string,
): Promise<{ started: Set<string>; completed: Set<string> }> {
	const rows = await tx
		.selectFrom("design_model_steps")
		.select(["step_key", "event_kind"])
		.where("context_id", "=", contextId)
		.where("event_kind", "in", ["started", "completed"])
		.execute();
	const started = new Set<string>();
	const completed = new Set<string>();
	for (const row of rows) {
		(row.event_kind === "started" ? started : completed).add(row.step_key);
	}
	return { started, completed };
}

async function countStartedStepsThroughGeneration(
	tx: Transaction<AppDatabase>,
	context: {
		readonly design_session_id: string;
		readonly context_kind: string;
		readonly generation: number;
	},
): Promise<number> {
	const row = await tx
		.selectFrom("design_model_steps as step")
		.innerJoin(
			"design_model_contexts as context",
			"context.id",
			"step.context_id",
		)
		.select(({ fn }) => fn.countAll<string>().as("n"))
		.where("context.design_session_id", "=", context.design_session_id)
		.where("context.context_kind", "=", context.context_kind)
		.where("context.generation", "<=", context.generation)
		.where("step.event_kind", "=", "started")
		.executeTakeFirst();
	return Number(row?.n ?? 0);
}

const optionalTokenCount = z.number().int().nonnegative().optional();
const persistedModelUsageSchema = z.object({
	inputTokens: optionalTokenCount,
	inputTokenDetails: z
		.object({
			noCacheTokens: optionalTokenCount,
			cacheReadTokens: optionalTokenCount,
			cacheWriteTokens: optionalTokenCount,
		})
		.optional(),
	outputTokens: optionalTokenCount,
	outputTokenDetails: z
		.object({
			textTokens: optionalTokenCount,
			reasoningTokens: optionalTokenCount,
		})
		.optional(),
	totalTokens: optionalTokenCount,
});

function parseModelUsage(source: string, context: string): LanguageModelUsage {
	const parsed = persistedModelUsageSchema.safeParse(
		parsePersistedJsonText(source, context),
	);
	if (!parsed.success) {
		throw new DesignModelContextError(
			`${context} is not a valid persisted model usage report.`,
		);
	}
	return {
		inputTokens: parsed.data.inputTokens,
		inputTokenDetails: {
			noCacheTokens: parsed.data.inputTokenDetails?.noCacheTokens,
			cacheReadTokens: parsed.data.inputTokenDetails?.cacheReadTokens,
			cacheWriteTokens: parsed.data.inputTokenDetails?.cacheWriteTokens,
		},
		outputTokens: parsed.data.outputTokens,
		outputTokenDetails: {
			textTokens: parsed.data.outputTokenDetails?.textTokens,
			reasoningTokens: parsed.data.outputTokenDetails?.reasoningTokens,
		},
		totalTokens: parsed.data.totalTokens,
	};
}

async function readCompletedStepsThroughGeneration(
	tx: Transaction<AppDatabase>,
	context: {
		readonly design_session_id: string;
		readonly context_kind: string;
		readonly generation: number;
	},
): Promise<DesignModelCompletedStep[]> {
	const rows = await tx
		.selectFrom("design_model_steps as step")
		.innerJoin(
			"design_model_contexts as context",
			"context.id",
			"step.context_id",
		)
		.select([
			"step.context_id",
			"step.step_key",
			"step.created_by_run_id",
			"step.created_at",
			sql<string | null>`${sql.ref("step.usage")}::text`.as("usage_text"),
		])
		.where("context.design_session_id", "=", context.design_session_id)
		.where("context.context_kind", "=", context.context_kind)
		.where("context.generation", "<=", context.generation)
		.where("step.event_kind", "=", "completed")
		.orderBy("context.generation", "asc")
		.orderBy("step.created_at", "asc")
		.execute();
	return rows.map((row) => ({
		contextId: row.context_id,
		stepKey: row.step_key,
		createdByRunId: row.created_by_run_id,
		createdAt: row.created_at,
		usage:
			row.usage_text === null
				? undefined
				: parseModelUsage(
						row.usage_text,
						`design_model_steps.usage for ${row.context_id}/${row.step_key}`,
					),
	}));
}

function providerContractMatches(
	row: {
		readonly model_id: string;
		readonly prompt_version: string;
		readonly toolset_digest: string;
		readonly context_version: string;
	},
	spec: DesignModelContextSpec,
): boolean {
	return (
		row.model_id === spec.modelId &&
		row.prompt_version === spec.promptVersion &&
		row.toolset_digest === spec.toolsetDigest &&
		row.context_version === persistedContextVersion(spec)
	);
}

function persistedContextVersion(spec: DesignModelContextSpec): string {
	return spec.semanticScopeKey === undefined
		? spec.contextVersion
		: `${spec.contextVersion}:semantic-scope:${spec.semanticScopeKey}`;
}

async function assertCurrentContext(
	tx: Transaction<AppDatabase>,
	context: {
		readonly id: string;
		readonly design_session_id: string;
		readonly context_kind: string;
	},
): Promise<void> {
	const latest = await tx
		.selectFrom("design_model_contexts")
		.select("id")
		.where("design_session_id", "=", context.design_session_id)
		.where("context_kind", "=", context.context_kind)
		.orderBy("generation", "desc")
		.executeTakeFirstOrThrow();
	if (latest.id !== context.id) {
		throw new DesignModelContextError(
			"The model context was superseded by a newer provider contract or semantic scope.",
		);
	}
}

async function readAppendKeysThroughGeneration(
	tx: Transaction<AppDatabase>,
	context: {
		readonly design_session_id: string;
		readonly context_kind: string;
		readonly generation: number;
	},
): Promise<Set<string>> {
	const rows = await tx
		.selectFrom("design_model_context_items as item")
		.innerJoin(
			"design_model_contexts as context",
			"context.id",
			"item.context_id",
		)
		.select("item.append_key")
		.distinct()
		.where("context.design_session_id", "=", context.design_session_id)
		.where("context.context_kind", "=", context.context_kind)
		.where("context.generation", "<=", context.generation)
		.execute();
	return new Set(rows.map((row) => row.append_key));
}

export async function openDesignModelContext(
	spec: DesignModelContextSpec,
): Promise<DesignModelContextState> {
	if (spec.semanticScopeKey !== undefined && spec.kind !== "executor") {
		throw new DesignModelContextError(
			"Only an executor context may declare a semantic scope key.",
		);
	}
	if (
		spec.semanticScopeKey !== undefined &&
		spec.semanticScopeKey.trim() === ""
	) {
		throw new DesignModelContextError(
			"An executor semantic scope key must not be blank.",
		);
	}
	const contextVersion = persistedContextVersion(spec);
	return withAppTx(async (tx) => {
		await authorize(tx, spec.designSessionId, spec.authority);
		let row = await tx
			.selectFrom("design_model_contexts")
			.selectAll()
			.where("design_session_id", "=", spec.designSessionId)
			.where("context_kind", "=", spec.kind)
			.orderBy("generation", "desc")
			.forUpdate()
			.executeTakeFirst();
		if (row === undefined) {
			row =
				(await tx
					.insertInto("design_model_contexts")
					.values({
						id: randomUUID(),
						design_session_id: spec.designSessionId,
						context_kind: spec.kind,
						generation: 0,
						supersedes_context_id: null,
						model_id: spec.modelId,
						prompt_version: spec.promptVersion,
						toolset_digest: spec.toolsetDigest,
						context_version: contextVersion,
						revision: 0,
					})
					.onConflict((conflict) =>
						conflict
							.columns(["design_session_id", "context_kind", "generation"])
							.doNothing(),
					)
					.returningAll()
					.executeTakeFirst()) ??
				(await tx
					.selectFrom("design_model_contexts")
					.selectAll()
					.where("design_session_id", "=", spec.designSessionId)
					.where("context_kind", "=", spec.kind)
					.orderBy("generation", "desc")
					.forUpdate()
					.executeTakeFirstOrThrow());
		}
		if (!providerContractMatches(row, spec)) {
			const previous = row;
			row = await tx
				.insertInto("design_model_contexts")
				.values({
					id: randomUUID(),
					design_session_id: spec.designSessionId,
					context_kind: spec.kind,
					generation:
						safePersistedSequence(
							previous.generation,
							`design_model_contexts.generation for ${previous.id}`,
						) + 1,
					supersedes_context_id: previous.id,
					model_id: spec.modelId,
					prompt_version: spec.promptVersion,
					toolset_digest: spec.toolsetDigest,
					context_version: contextVersion,
					revision: 0,
				})
				.returningAll()
				.executeTakeFirstOrThrow();
		}
		const items = await readItems(tx, row.id);
		const completedSteps = await readCompletedStepsThroughGeneration(tx, row);
		const generation = safePersistedSequence(
			row.generation,
			`design_model_contexts.generation for ${row.id}`,
		);
		/* The loaded items already carry their append keys — a distinct query
		 * would re-read the same rows. Generation 0 has no predecessors, so its
		 * lineage keys are exactly its own; only a rolled-over context needs
		 * the cross-generation read. */
		const appendKeys = new Set(items.map((item) => item.appendKey));
		const lineageAppendKeys =
			generation === 0
				? new Set(appendKeys)
				: await readAppendKeysThroughGeneration(tx, row);
		const stepKeys = await readStepKeysByEvent(tx, row.id);
		return {
			id: row.id,
			generation,
			supersedesContextId: row.supersedes_context_id,
			revision: safePersistedSequence(
				row.revision,
				`design_model_contexts.revision for ${row.id}`,
			),
			messages: items.map((item) => item.message),
			items,
			appendKeys,
			lineageAppendKeys,
			startedStepKeys: stepKeys.started,
			completedStepKeys: stepKeys.completed,
			completedSteps,
			totalStartedStepCount: await countStartedStepsThroughGeneration(tx, row),
		};
	});
}

export async function appendDesignModelContext(args: {
	readonly designSessionId: string;
	readonly contextId: string;
	readonly appendKey: string;
	readonly messages: readonly ModelMessage[];
	readonly authority: DesignModelContextAuthority;
}): Promise<number> {
	if (args.messages.length === 0) return 0;
	const durableMessages = args.messages.map(persistModelMessage);
	const digests = durableMessages.map(canonicalJsonDigest);
	return withAppTx(async (tx) => {
		await authorize(tx, args.designSessionId, args.authority);
		const context = await tx
			.selectFrom("design_model_contexts")
			.select(["id", "design_session_id", "context_kind", "revision"])
			.where("id", "=", args.contextId)
			.forUpdate()
			.executeTakeFirst();
		if (
			context === undefined ||
			context.design_session_id !== args.designSessionId
		) {
			throw new DesignModelContextError(
				"The model context is outside this design session.",
			);
		}
		await assertCurrentContext(tx, context);
		const replay = await tx
			.selectFrom("design_model_context_items")
			.select(["append_index", "item_digest"])
			.where("context_id", "=", args.contextId)
			.where("append_key", "=", args.appendKey)
			.orderBy("append_index", "asc")
			.execute();
		if (replay.length > 0) {
			if (
				replay.length !== digests.length ||
				replay.some((row, index) => row.item_digest !== digests[index])
			) {
				throw new DesignModelContextError(
					`Append key ${args.appendKey} was reused with different model context bytes.`,
				);
			}
			return safePersistedSequence(
				context.revision,
				`design_model_contexts.revision for ${context.id}`,
			);
		}
		const revision = safePersistedSequence(
			context.revision,
			`design_model_contexts.revision for ${context.id}`,
		);
		await tx
			.insertInto("design_model_context_items")
			.values(
				durableMessages.map((message, index) => ({
					context_id: context.id,
					ordinal: revision + index + 1,
					append_key: args.appendKey,
					append_index: index,
					item_digest: digests[index] as string,
					message: JSON.stringify(message),
					created_by_run_id: args.authority.runId,
				})),
			)
			.execute();
		const nextRevision = revision + args.messages.length;
		await tx
			.updateTable("design_model_contexts")
			.set({ revision: nextRevision, updated_at: new Date() })
			.where("id", "=", context.id)
			.executeTakeFirstOrThrow();
		return nextRevision;
	});
}

/** Persist one returned provider response and its usage-bearing completion
 * event in the same transaction. Recovery can therefore observe neither half
 * without the other: an unanswered durable tool call always retains the exact
 * usage that produced it. */
export async function completeDesignModelStep(args: {
	readonly designSessionId: string;
	readonly contextId: string;
	readonly appendKey: string;
	readonly messages: readonly ModelMessage[];
	readonly stepKey: string;
	readonly responseDigest: string;
	readonly usage?: Record<string, unknown>;
	readonly authority: DesignModelContextAuthority;
}): Promise<number> {
	if (args.messages.length === 0) {
		throw new DesignModelContextError(
			"A completed model step must persist its response messages.",
		);
	}
	const durableMessages = args.messages.map(persistModelMessage);
	const digests = durableMessages.map(canonicalJsonDigest);
	const event: DesignModelStepEvent = {
		eventKind: "completed",
		responseDigest: args.responseDigest,
		...(args.usage !== undefined && { usage: args.usage }),
	};
	const eventDigest = canonicalJsonDigest({ stepKey: args.stepKey, ...event });
	return withAppTx(async (tx) => {
		await authorize(tx, args.designSessionId, args.authority);
		const context = await tx
			.selectFrom("design_model_contexts")
			.select(["id", "design_session_id", "context_kind", "revision"])
			.where("id", "=", args.contextId)
			.forUpdate()
			.executeTakeFirst();
		if (context?.design_session_id !== args.designSessionId) {
			throw new DesignModelContextError(
				"The completed model step is outside this design session.",
			);
		}
		await assertCurrentContext(tx, context);
		const replayItems = await tx
			.selectFrom("design_model_context_items")
			.select(["append_index", "item_digest"])
			.where("context_id", "=", args.contextId)
			.where("append_key", "=", args.appendKey)
			.orderBy("append_index", "asc")
			.execute();
		const replayStep = await tx
			.selectFrom("design_model_steps")
			.select("event_digest")
			.where("context_id", "=", args.contextId)
			.where("step_key", "=", args.stepKey)
			.where("event_kind", "=", "completed")
			.executeTakeFirst();
		if (replayItems.length > 0 || replayStep !== undefined) {
			if (
				replayItems.length !== digests.length ||
				replayItems.some((row, index) => row.item_digest !== digests[index]) ||
				replayStep?.event_digest !== eventDigest
			) {
				throw new DesignModelContextError(
					`Completed model step ${args.stepKey} was replayed with different response evidence.`,
				);
			}
			return safePersistedSequence(
				context.revision,
				`design_model_contexts.revision for ${context.id}`,
			);
		}
		const revision = safePersistedSequence(
			context.revision,
			`design_model_contexts.revision for ${context.id}`,
		);
		await tx
			.insertInto("design_model_context_items")
			.values(
				durableMessages.map((message, index) => ({
					context_id: context.id,
					ordinal: revision + index + 1,
					append_key: args.appendKey,
					append_index: index,
					item_digest: digests[index] as string,
					message: JSON.stringify(message),
					created_by_run_id: args.authority.runId,
				})),
			)
			.execute();
		await tx
			.insertInto("design_model_steps")
			.values({
				context_id: context.id,
				step_key: args.stepKey,
				event_kind: "completed",
				event_digest: eventDigest,
				request_digest: null,
				response_digest: args.responseDigest,
				usage: args.usage === undefined ? null : JSON.stringify(args.usage),
				created_by_run_id: args.authority.runId,
			})
			.execute();
		const nextRevision = revision + args.messages.length;
		await tx
			.updateTable("design_model_contexts")
			.set({ revision: nextRevision, updated_at: new Date() })
			.where("id", "=", context.id)
			.executeTakeFirstOrThrow();
		return nextRevision;
	});
}

/** Append payload-free evidence immediately before and after a provider call.
 * An infrastructure replacement can distinguish an unobserved response from
 * a completed step without copying customer content into operational data. */
export async function recordDesignModelStepEvent(args: {
	readonly designSessionId: string;
	readonly contextId: string;
	readonly stepKey: string;
	readonly event: DesignModelStepEvent;
	readonly authority: DesignModelContextAuthority;
}): Promise<void> {
	const eventPayload = {
		stepKey: args.stepKey,
		...args.event,
	};
	const eventDigest = canonicalJsonDigest(eventPayload);
	await withAppTx(async (tx) => {
		await authorize(tx, args.designSessionId, args.authority);
		const context = await tx
			.selectFrom("design_model_contexts")
			.select(["id", "design_session_id", "context_kind"])
			.where("id", "=", args.contextId)
			.forUpdate()
			.executeTakeFirst();
		if (context?.design_session_id !== args.designSessionId) {
			throw new DesignModelContextError(
				"The model step is outside this design session.",
			);
		}
		await assertCurrentContext(tx, context);
		const existing = await tx
			.selectFrom("design_model_steps")
			.select("event_digest")
			.where("context_id", "=", args.contextId)
			.where("step_key", "=", args.stepKey)
			.where("event_kind", "=", args.event.eventKind)
			.executeTakeFirst();
		if (existing !== undefined) {
			if (existing.event_digest !== eventDigest) {
				throw new DesignModelContextError(
					`Model step ${args.stepKey} was replayed with different ${args.event.eventKind} evidence.`,
				);
			}
			return;
		}
		await tx
			.insertInto("design_model_steps")
			.values({
				context_id: args.contextId,
				step_key: args.stepKey,
				event_kind: args.event.eventKind,
				event_digest: eventDigest,
				request_digest:
					args.event.eventKind === "started" ? args.event.requestDigest : null,
				response_digest:
					args.event.eventKind === "completed"
						? args.event.responseDigest
						: null,
				usage:
					args.event.eventKind === "completed" && args.event.usage !== undefined
						? JSON.stringify(args.event.usage)
						: null,
				created_by_run_id: args.authority.runId,
			})
			.execute();
	});
}
