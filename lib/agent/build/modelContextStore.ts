/** Durable, exact, append-only model context for reviewed design/build roles. */

import { randomUUID } from "node:crypto";
import type { LanguageModelUsage, ModelMessage } from "ai";
import { sql, type Transaction } from "kysely";
import { z } from "zod";
import {
	durableModelValueDigest,
	persistModelMessage,
	rehydrateModelMessage,
} from "@/lib/agent/modelMessagePersistence";
import { withoutModelCompaction } from "@/lib/chat/compaction";
import { CommitReauthError, RunHolderLostError } from "@/lib/db/commitGuard";
import { assertDesignSessionRunAuthorityInTransaction } from "@/lib/db/designSessions";
import { getCurrentPeriod } from "@/lib/db/period";
import { parsePersistedJsonText } from "@/lib/db/persistedJson";
import { type AppDatabase, withAppTx } from "@/lib/db/pg";
import { writeRunSummaryInTransaction } from "@/lib/db/runSummary";
import { estimateCost } from "@/lib/db/usage";
import { canonicalJsonDigest } from "@/lib/utils/canonicalJson";
import { safePersistedSequence } from "@/lib/utils/persistedSequence";

export type DesignModelContextKind = "architect" | "peer" | "translator";

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
	/** Definitions at context creation; phase changes preserve the conversation. */
	readonly toolsetDigest: string;
	/** A peer review uses its review id; the architect keeps one conversation. */
	readonly contextVersion: string;
	readonly authority: DesignModelContextAuthority;
}

export interface DesignModelContextState {
	readonly id: string;
	readonly generation: number;
	readonly supersedesContextId: string | null;
	readonly revision: number;
	readonly messages: ModelMessage[];
	readonly items: readonly DesignModelContextItem[];
	/** The latest immutable predecessor generation that contains a provider
	 * response, for architect recovery. Provider-contract rollovers can
	 * append reseeds or state without making another provider call; those
	 * item-only generations must not hide the response that still proves an
	 * outer pause or correction a killed process did not record. The peer retains its own earlier investigation across reviews; current source, plan and app revisions arrive as a new review message. */
	readonly predecessorItems: readonly DesignModelContextItem[];
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
	readonly startedStepsByTurn: ReadonlyMap<string, number>;
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

const modelStepAdmissionSchema = z.strictObject({
	actorUserId: z.string(),
	runId: z.string(),
	holderDigest: z.string(),
	projectId: z.string(),
	billingPeriod: z.string(),
});

export type DesignModelStepEvent =
	| {
			readonly eventKind: "started";
			readonly turnProvenanceId?: string;
			readonly requestDigest: string;
	  }
	| {
			readonly eventKind: "completed";
			readonly responseDigest: string;
			readonly appendKey: string;
			readonly usage?: Record<string, unknown>;
	  };

export class DesignTurnBudgetError extends Error {
	readonly name = "DesignTurnBudgetError";
	constructor() {
		super("The design turn has used its step allowance.");
	}
}

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

/** Carry the latest nonempty conversation across a provider-contract change.
 * A request saved before a failed provider call is meaningful history too.
 * Empty rollover generations fall back to their predecessor. */
async function readLatestPredecessorItems(
	tx: Transaction<AppDatabase>,
	context: {
		readonly design_session_id: string;
		readonly context_kind: string;
		readonly context_version: string;
		readonly generation: number;
		readonly model_id: string;
		readonly prompt_version: string;
		readonly toolset_digest: string;
	},
): Promise<DesignModelContextItem[]> {
	const predecessor = await tx
		.selectFrom("design_model_contexts as context")
		.innerJoin(
			"design_model_context_items as item",
			"item.context_id",
			"context.id",
		)
		.select([
			"context.id",
			"context.model_id",
			"context.prompt_version",
			"context.toolset_digest",
			"context.context_version",
		])
		.where("context.design_session_id", "=", context.design_session_id)
		.where("context.context_kind", "=", context.context_kind)
		.$if(context.context_kind === "translator", (q) =>
			q.where("context.context_version", "=", context.context_version),
		)
		.where("context.generation", "<", context.generation)
		.orderBy("context.generation", "desc")
		.limit(1)
		.executeTakeFirst();
	if (predecessor === undefined) return [];
	const items = await readItems(tx, predecessor.id);
	const compatible =
		predecessor.model_id === context.model_id &&
		predecessor.prompt_version === context.prompt_version &&
		predecessor.toolset_digest === context.toolset_digest &&
		(context.context_kind === "peer" ||
			predecessor.context_version === context.context_version);
	return compatible
		? items
		: items.flatMap((item) => {
				const message = withoutModelCompaction(item.message);
				return message === null ? [] : [{ ...item, message }];
			});
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

function parseModelUsage(value: unknown, context: string): LanguageModelUsage {
	const parsed = persistedModelUsageSchema.safeParse(value);
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

/** Verify persisted event evidence before using it for recovery or accounting. */
async function readStepsThroughGeneration(
	tx: Transaction<AppDatabase>,
	context: {
		readonly design_session_id: string;
		readonly context_kind: string;
		readonly context_version: string;
		readonly generation: number;
		readonly id: string;
	},
): Promise<{
	started: Set<string>;
	completed: Set<string>;
	completedSteps: DesignModelCompletedStep[];
	totalStartedStepCount: number;
	startedStepsByTurn: Map<string, number>;
}> {
	const rows = await tx
		.selectFrom("design_model_steps as step")
		.innerJoin(
			"design_model_contexts as context",
			"context.id",
			"step.context_id",
		)
		.select([
			"step.context_id",
			"step.turn_provenance_id",
			"step.turn_provenance_digest",
			"step.step_key",
			"step.event_kind",
			"step.event_digest",
			"step.request_digest",
			"step.response_digest",
			"step.response_append_key",
			"step.created_by_run_id",
			"step.created_at",
			"step.admission",
			sql<string | null>`${sql.ref("step.usage")}::text`.as("usage_text"),
		])
		.where("context.design_session_id", "=", context.design_session_id)
		.where("context.context_kind", "=", context.context_kind)
		.$if(context.context_kind === "translator", (q) =>
			q.where("context.context_version", "=", context.context_version),
		)
		.where("context.generation", "<=", context.generation)
		.orderBy("context.generation", "asc")
		.orderBy("step.created_at", "asc")
		.execute();
	const started = new Set<string>();
	const completed = new Set<string>();
	const completedSteps: DesignModelCompletedStep[] = [];
	let totalStartedStepCount = 0;
	const startedStepsByTurn = new Map<string, number>();
	for (const row of rows) {
		const label = `design_model_steps for ${row.context_id}/${row.step_key}`;
		const usage =
			row.usage_text === null
				? undefined
				: parsePersistedJsonText(row.usage_text, `${label}.usage`);
		const event =
			row.event_kind === "started"
				? {
						stepKey: row.step_key,
						eventKind: row.event_kind,
						requestDigest: row.request_digest,
						admission: modelStepAdmissionSchema.parse(row.admission),
					}
				: {
						stepKey: row.step_key,
						eventKind: row.event_kind,
						responseDigest: row.response_digest,
						appendKey: row.response_append_key,
						...(usage !== undefined && { usage }),
					};
		if (canonicalJsonDigest(event) !== row.event_digest) {
			throw new DesignModelContextError(
				`${label} no longer matches its digest.`,
			);
		}
		if (
			row.turn_provenance_id !== null &&
			row.turn_provenance_digest !==
				canonicalJsonDigest({
					contextId: row.context_id,
					stepKey: row.step_key,
					turnProvenanceId: row.turn_provenance_id,
					eventDigest: row.event_digest,
				})
		) {
			throw new DesignModelContextError(
				`${label} no longer matches its turn provenance digest.`,
			);
		}
		if (row.event_kind === "started") {
			totalStartedStepCount += 1;
			if (
				row.turn_provenance_id === null &&
				context.context_kind === "architect"
			)
				throw new DesignModelContextError(
					"A design provider start is missing its logical user turn provenance.",
				);
			if (row.turn_provenance_id !== null)
				startedStepsByTurn.set(
					row.turn_provenance_id,
					(startedStepsByTurn.get(row.turn_provenance_id) ?? 0) + 1,
				);
			if (row.context_id === context.id) started.add(row.step_key);
		} else {
			if (row.context_id === context.id) completed.add(row.step_key);
			completedSteps.push({
				contextId: row.context_id,
				stepKey: row.step_key,
				createdByRunId: row.created_by_run_id,
				createdAt: row.created_at,
				usage:
					usage === undefined
						? undefined
						: parseModelUsage(usage, `${label}.usage`),
			});
		}
	}
	return {
		started,
		completed,
		completedSteps,
		totalStartedStepCount,
		startedStepsByTurn,
	};
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
		row.context_version === spec.contextVersion
	);
}

async function assertCurrentContext(
	tx: Transaction<AppDatabase>,
	context: {
		readonly id: string;
		readonly design_session_id: string;
		readonly context_kind: string;
		readonly context_version: string;
	},
): Promise<void> {
	const latest = await tx
		.selectFrom("design_model_contexts")
		.select("id")
		.where("design_session_id", "=", context.design_session_id)
		.where("context_kind", "=", context.context_kind)
		.$if(context.context_kind === "translator", (q) =>
			q.where("context_version", "=", context.context_version),
		)
		.orderBy("generation", "desc")
		.executeTakeFirstOrThrow();
	if (latest.id !== context.id) {
		throw new DesignModelContextError(
			"The model context was superseded by a newer provider contract or review.",
		);
	}
}

async function readAppendKeysThroughGeneration(
	tx: Transaction<AppDatabase>,
	context: {
		readonly design_session_id: string;
		readonly context_kind: string;
		readonly context_version: string;
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
		.$if(context.context_kind === "translator", (q) =>
			q.where("context.context_version", "=", context.context_version),
		)
		.where("context.generation", "<=", context.generation)
		.execute();
	return new Set(rows.map((row) => row.append_key));
}

export async function openDesignModelContext(
	spec: DesignModelContextSpec,
): Promise<DesignModelContextState> {
	const contextVersion = spec.contextVersion;
	return withAppTx(async (tx) => {
		await authorize(tx, spec.designSessionId, spec.authority);
		let row = await tx
			.selectFrom("design_model_contexts")
			.selectAll()
			.where("design_session_id", "=", spec.designSessionId)
			.where("context_kind", "=", spec.kind)
			.$if(spec.kind === "translator", (q) =>
				q.where("context_version", "=", spec.contextVersion),
			)
			.orderBy("generation", "desc")
			.forUpdate()
			.executeTakeFirst();
		if (row === undefined) {
			const previous = await tx
				.selectFrom("design_model_contexts")
				.select("generation")
				.where("design_session_id", "=", spec.designSessionId)
				.where("context_kind", "=", spec.kind)
				.orderBy("generation", "desc")
				.executeTakeFirst();
			// The session/app authority lock already serializes context creation.
			row = await tx
				.insertInto("design_model_contexts")
				.values({
					id: randomUUID(),
					design_session_id: spec.designSessionId,
					context_kind: spec.kind,
					generation: previous
						? safePersistedSequence(previous.generation, "context generation") +
							1
						: 0,
					supersedes_context_id: null,
					model_id: spec.modelId,
					prompt_version: spec.promptVersion,
					toolset_digest: spec.toolsetDigest,
					context_version: contextVersion,
					revision: 0,
				})
				.returningAll()
				.executeTakeFirstOrThrow();
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
		const steps = await readStepsThroughGeneration(tx, row);
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
		const predecessorItems =
			spec.kind !== "translator" && generation > 0
				? await readLatestPredecessorItems(tx, row)
				: [];
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
			predecessorItems,
			appendKeys,
			lineageAppendKeys,
			startedStepKeys: steps.started,
			completedStepKeys: steps.completed,
			completedSteps: steps.completedSteps,
			totalStartedStepCount: steps.totalStartedStepCount,
			startedStepsByTurn: steps.startedStepsByTurn,
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
			.select([
				"id",
				"design_session_id",
				"context_kind",
				"context_version",
				"revision",
			])
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
	/** A failed/aborted response contributes usage but cannot supply actions. */
	readonly accountingOnly?: boolean;
}): Promise<number | null> {
	if (args.messages.length === 0 && !args.accountingOnly) {
		throw new DesignModelContextError(
			"A completed model step must persist its response messages.",
		);
	}
	if (durableModelValueDigest(args.messages) !== args.responseDigest) {
		throw new DesignModelContextError(
			"The completed response messages do not match their digest.",
		);
	}
	const durableMessages = args.messages.map(persistModelMessage);
	const digests = durableMessages.map(canonicalJsonDigest);
	const event: DesignModelStepEvent = {
		eventKind: "completed",
		responseDigest: args.responseDigest,
		appendKey: args.appendKey,
		...(args.usage !== undefined && { usage: args.usage }),
	};
	const eventDigest = canonicalJsonDigest({ stepKey: args.stepKey, ...event });
	return withAppTx(async (tx) => {
		let live = !args.accountingOnly;
		try {
			await authorize(tx, args.designSessionId, args.authority);
		} catch (error) {
			if (
				!(
					error instanceof RunHolderLostError ||
					error instanceof CommitReauthError
				)
			)
				throw error;
			live = false;
		}
		const context = await tx
			.selectFrom("design_model_contexts")
			.select([
				"id",
				"design_session_id",
				"context_kind",
				"context_version",
				"revision",
				"model_id",
			])
			.where("id", "=", args.contextId)
			.forUpdate()
			.executeTakeFirst();
		if (context?.design_session_id !== args.designSessionId) {
			throw new DesignModelContextError(
				"The completed model step is outside this design session.",
			);
		}
		const start = await tx
			.selectFrom("design_model_steps")
			.selectAll()
			.where("context_id", "=", args.contextId)
			.where("step_key", "=", args.stepKey)
			.where("event_kind", "=", "started")
			.executeTakeFirstOrThrow();
		const admission = modelStepAdmissionSchema.parse(start.admission);
		if (
			admission.actorUserId !== args.authority.actorUserId ||
			admission.runId !== args.authority.runId ||
			start.created_by_run_id !== admission.runId ||
			admission.projectId !== args.authority.expectedProjectId ||
			admission.holderDigest !==
				canonicalJsonDigest(args.authority.holderNonce) ||
			start.event_digest !==
				canonicalJsonDigest({
					stepKey: args.stepKey,
					eventKind: "started",
					requestDigest: start.request_digest,
					admission,
				})
		) {
			throw new DesignModelContextError(
				"The response does not belong to this admitted provider request.",
			);
		}
		const latest = await tx
			.selectFrom("design_model_contexts")
			.select("id")
			.where("design_session_id", "=", args.designSessionId)
			.where("context_kind", "=", context.context_kind)
			.$if(context.context_kind === "translator", (q) =>
				q.where("context_version", "=", context.context_version),
			)
			.orderBy("generation", "desc")
			.executeTakeFirstOrThrow();
		live &&= latest.id === context.id;
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
				replayStep?.event_digest !== eventDigest ||
				(replayItems.length > 0 &&
					(replayItems.length !== digests.length ||
						replayItems.some((row, i) => row.item_digest !== digests[i])))
			) {
				throw new DesignModelContextError(
					`Completed model step ${args.stepKey} was replayed with different response evidence.`,
				);
			}
			return live && replayItems.length > 0
				? safePersistedSequence(context.revision, "model context revision")
				: null;
		}
		const revision = safePersistedSequence(
			context.revision,
			"model context revision",
		);
		if (live) {
			await tx
				.insertInto("design_model_context_items")
				.values(
					durableMessages.map((message, i) => ({
						context_id: context.id,
						ordinal: revision + i + 1,
						append_key: args.appendKey,
						append_index: i,
						item_digest: digests[i] as string,
						message: JSON.stringify(message),
						created_by_run_id: admission.runId,
					})),
				)
				.execute();
			await tx
				.updateTable("design_model_contexts")
				.set({
					revision: revision + durableMessages.length,
					updated_at: new Date(),
				})
				.where("id", "=", context.id)
				.execute();
		}
		await tx
			.insertInto("design_model_steps")
			.values({
				context_id: context.id,
				step_key: args.stepKey,
				event_kind: "completed",
				event_digest: eventDigest,
				request_digest: null,
				response_digest: args.responseDigest,
				response_append_key: args.appendKey,
				usage: args.usage === undefined ? null : JSON.stringify(args.usage),
				created_by_run_id: admission.runId,
			})
			.execute();
		if (args.usage !== undefined) {
			const usage = parseModelUsage(args.usage, "completed provider usage");
			const inputTokens = usage.inputTokens ?? 0;
			const outputTokens = usage.outputTokens ?? 0;
			const cacheReadTokens = usage.inputTokenDetails?.cacheReadTokens ?? 0;
			const cacheWriteTokens = usage.inputTokenDetails?.cacheWriteTokens ?? 0;
			const zero = {
				stepCount: 0,
				inputTokens: 0,
				outputTokens: 0,
				cacheReadTokens: 0,
				cacheWriteTokens: 0,
				costEstimate: 0,
			};
			await writeRunSummaryInTransaction(
				tx,
				{ kind: "design-session", designSessionId: args.designSessionId },
				admission.runId,
				{
					...zero,
					runId: admission.runId,
					startedAt: start.created_at.toISOString(),
					finishedAt: new Date().toISOString(),
					promptMode: "build",
					appReady: false,
					moduleCount: 0,
					model: context.model_id,
					toolCallCount: 0,
				},
				[
					{
						contextId: context.id,
						stepKey: args.stepKey,
						stepCount: 1,
						inputTokens,
						outputTokens,
						cacheReadTokens,
						cacheWriteTokens,
						costEstimate: estimateCost(
							context.model_id,
							inputTokens,
							outputTokens,
							cacheReadTokens,
							cacheWriteTokens,
						),
					},
				],
				{ userId: admission.actorUserId, period: admission.billingPeriod },
			);
		}
		return live ? revision + durableMessages.length : null;
	});
}

/** Append payload-free evidence immediately before and after a provider call.
 * An infrastructure replacement can distinguish an unobserved response from
 * a completed step without copying customer content into operational data. */
export async function recordDesignModelStepEvent(args: {
	readonly designSessionId: string;
	readonly contextId: string;
	readonly stepKey: string;
	readonly event: Extract<DesignModelStepEvent, { eventKind: "started" }>;
	readonly turnBudget?: {
		readonly limit: number;
	};
	readonly authority: DesignModelContextAuthority;
}): Promise<boolean> {
	return withAppTx(async (tx) => {
		await authorize(tx, args.designSessionId, args.authority);
		const context = await tx
			.selectFrom("design_model_contexts")
			.select(["id", "design_session_id", "context_kind", "context_version"])
			.where("id", "=", args.contextId)
			.forUpdate()
			.executeTakeFirst();
		if (context?.design_session_id !== args.designSessionId)
			throw new DesignModelContextError(
				"The model step is outside this design session.",
			);
		await assertCurrentContext(tx, context);
		const turnProvenanceId = args.event.turnProvenanceId ?? null;
		if (context.context_kind === "architect" && turnProvenanceId === null)
			throw new DesignModelContextError(
				"Every design provider start requires its logical user turn provenance.",
			);
		const existing = await tx
			.selectFrom("design_model_steps")
			.select(["event_digest", "turn_provenance_id", "admission"])
			.where("context_id", "=", args.contextId)
			.where("step_key", "=", args.stepKey)
			.where("event_kind", "=", "started")
			.executeTakeFirst();
		const admission = {
			actorUserId: args.authority.actorUserId,
			runId: args.authority.runId,
			holderDigest: canonicalJsonDigest(args.authority.holderNonce),
			projectId: args.authority.expectedProjectId,
			billingPeriod: existing
				? modelStepAdmissionSchema.parse(existing.admission).billingPeriod
				: getCurrentPeriod(),
		};
		const eventDigest = canonicalJsonDigest({
			stepKey: args.stepKey,
			eventKind: "started",
			requestDigest: args.event.requestDigest,
			admission,
		});
		if (existing) {
			if (
				existing.event_digest !== eventDigest ||
				existing.turn_provenance_id !== turnProvenanceId
			)
				throw new DesignModelContextError(
					`Model step ${args.stepKey} was replayed with different started evidence.`,
				);
			return false;
		}
		if (args.turnBudget !== undefined) {
			if (turnProvenanceId === null)
				throw new DesignModelContextError(
					"A design turn reservation requires started-step provenance.",
				);
			const count = await tx
				.selectFrom("design_model_steps as step")
				.innerJoin(
					"design_model_contexts as context",
					"context.id",
					"step.context_id",
				)
				.select(sql<string>`count(*)`.as("count"))
				.where("context.design_session_id", "=", args.designSessionId)
				.where("context.context_kind", "=", context.context_kind)
				.$if(context.context_kind === "translator", (q) =>
					q.where("context.context_version", "=", context.context_version),
				)
				.where("step.event_kind", "=", "started")
				.where("step.turn_provenance_id", "=", turnProvenanceId)
				.executeTakeFirstOrThrow();
			if (Number(count.count) >= args.turnBudget.limit)
				throw new DesignTurnBudgetError();
		}
		await tx
			.insertInto("design_model_steps")
			.values({
				context_id: args.contextId,
				step_key: args.stepKey,
				event_kind: "started",
				event_digest: eventDigest,
				admission: JSON.stringify(admission),
				turn_provenance_id: turnProvenanceId,
				turn_provenance_digest:
					turnProvenanceId === null
						? null
						: canonicalJsonDigest({
								contextId: args.contextId,
								stepKey: args.stepKey,
								turnProvenanceId,
								eventDigest,
							}),
				request_digest: args.event.requestDigest,
				response_digest: null,
				usage: null,
				created_by_run_id: args.authority.runId,
			})
			.execute();
		return true;
	});
}
