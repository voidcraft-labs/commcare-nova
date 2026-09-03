/**
 * The slice executor loop (the plan's §13.5–§13.9) — the bounded, server-owned
 * machine that turns one accepted Build Slice into one committed canonical
 * revision.
 *
 * Three properties are the whole point:
 *
 *  1. **Native calls, ordered by the server.** The model can return several
 *     ordinary Nova calls in one response. The response is persisted first,
 *     then calls are dispatched serially in provider order. Every call result
 *     is persisted independently; a rejected call preserves the accepted
 *     prefix and marks the dependent suffix skipped.
 *  2. **The model never holds authority.** `finishWorkflow` is a request. The
 *     loop re-runs the real diagnostics and only then calls the server-owned
 *     commit. A model assertion that the work is done proves nothing.
 *  3. **Every axis is bounded.** Model steps, mutation calls, commit and
 *     rebase attempts, and wall clock all cap. Exhausting one ends the
 *     attempt as `budget-exhausted` — never as a partial commit and never as
 *     a completion claim.
 *
 * The loop owns no persistence: the workspace stages durably, `commit` is
 * supplied by the caller, and the outcome is what the orchestrator records.
 */

import type { OpenAIResponsesProviderOptions } from "@ai-sdk/openai";
import type { JSONSchema7 } from "@ai-sdk/provider";
import {
	jsonSchema,
	type LanguageModel,
	type LanguageModelUsage,
	type ModelMessage,
	stepCountIs,
	streamText,
	tool,
} from "ai";
import { z } from "zod";
import { findingFingerprint } from "@/lib/agent/change-set/diagnostics";
import {
	ChangeSetIntegrityError,
	ChangeSetRequestIdCollisionError,
	ChangeSetScopeLostError,
	ChangeSetStagingRejectedError,
	ChangeSetWorkspaceRevisionStaleError,
} from "@/lib/agent/change-set/errors";
import { CHANGE_SET_TOOL_REGISTRY } from "@/lib/agent/change-set/registry";
import type { CommittedSliceReceipt } from "@/lib/agent/change-set/types";
import type { ChangeSetMutationWorkspace } from "@/lib/agent/change-set/workspace";
import { durableModelValueDigest } from "@/lib/agent/modelMessagePersistence";
import {
	modelMessagesContainCompaction,
	projectModelHistoryFromNewestCompaction,
} from "@/lib/chat/compaction";
import type { AppMaterializationReceipt } from "@/lib/db/appGenesis";
import type { DurableUsageIdentity } from "@/lib/db/usage";
import { type ReasoningEffort, reasoningProviderOptions } from "@/lib/models";
import { canonicalJsonDigest } from "@/lib/utils/canonicalJson";
import {
	type AcceptedInputRequirementIssue,
	acceptedInputRequirementIssues,
} from "./acceptedInputParity";
import {
	type AcceptedModulePlacementIssue,
	acceptedModulePlacementIssues,
	realizedModuleUuid,
} from "./acceptedModulePlacement";
import {
	type AcceptedSelectionRealizationIssue,
	acceptedSelectionRealizationIssues,
} from "./acceptedSelectionParity";
import {
	BLOCKER_RESOLUTION_ALLOWANCE,
	type SliceAttemptBudgetClaimResult,
	type SliceAttemptBudgetCounter,
	type SliceAttemptBudgetSpent,
	type SliceExecutionBudget,
	totalWallClockAllowanceMs,
} from "./budgets";
import {
	type ArchitectBlockerDecision,
	type ExecutionBlocker,
	executionBlockerSchema,
} from "./executionBlocker";
import { renderBriefMessage, type SliceExecutionBrief } from "./executionBrief";
import { EXECUTOR_SYSTEM } from "./executorPrompt";
import { STABLE_EXECUTOR_TOOL_PROFILE } from "./executorToolProfile";
import {
	executorCatalogDefaultHandleIssue,
	executorCreationHandleIssue,
	executorWireToolSchema,
} from "./executorWireSchemas";

/**
 * The workspace surface the loop uses. Structurally the change-set workspace
 * (which satisfies it) — narrowed so the loop depends on exactly the three
 * operations it performs, and so a test can drive it without a database.
 */
export type ExecutorWorkspace = Pick<
	ChangeSetMutationWorkspace,
	| "stageDispatch"
	| "inspect"
	| "currentSnapshot"
	| "currentExecutionCheckpoint"
	| "projectDesignLookupReferences"
>;

/** Caller-owned transcript for one durable slice attempt. The orchestrator
 * reopens this exact generation after process replacement and rolls to a new
 * immutable generation for every new slice or retry. */
export interface ExecutorConversationContext {
	readonly contextId?: string;
	messages: ModelMessage[];
	items?: Array<{ readonly appendKey: string; readonly message: ModelMessage }>;
	appendKeys?: Set<string>;
	completedStepKeys?: Set<string>;
	append?: (
		appendKey: string,
		messages: readonly ModelMessage[],
	) => Promise<void>;
	recordStep?: (
		stepKey: string,
		event:
			| { readonly eventKind: "started"; readonly requestDigest: string }
			| {
					readonly eventKind: "completed";
					readonly responseDigest: string;
					readonly usage?: Record<string, unknown>;
			  },
	) => Promise<void>;
	completeStep?: (args: {
		readonly appendKey: string;
		readonly messages: readonly ModelMessage[];
		readonly stepKey: string;
		readonly responseDigest: string;
		readonly usage?: Record<string, unknown>;
	}) => Promise<void>;
}

/** One model step: the messages in, the model's tool calls and text out. The
 *  loop supplies no `execute`; dispatch is the loop's own job. */
export type ExecutorStepFn = (args: {
	system: string;
	messages: ModelMessage[];
	tools: Record<string, { description: string; inputSchema: JSONSchema7 }>;
	allowedTools?: readonly string[];
	signal: AbortSignal;
}) => Promise<{
	toolCalls: Array<{ toolCallId: string; toolName: string; input: unknown }>;
	text: string;
	/** The step's display-safe reasoning summary, when the provider streamed
	 *  one; persisted to the run event log by the loop's `onReasoning`. */
	reasoningText?: string;
	usage: LanguageModelUsage | undefined;
	responseMessages: ModelMessage[];
}>;

/** What the server-owned commit answered. Semantic rebase conflicts and stale
 * external reads end this append-only attempt; gate rejections can be
 * corrected in place. */
export type SliceCommitResult =
	| {
			kind: "committed";
			receipt: CommittedSliceReceipt | AppMaterializationReceipt;
	  }
	| { kind: "gate-rejected"; message: string }
	| { kind: "rebase-conflict"; report: unknown }
	| { kind: "read-set-stale"; stale: unknown };

/** The longest a single slice-commit transaction may run. The slice
 * deadline funds model pacing, but the commit transaction holds the app
 * row lock, so its PostgreSQL timeout is capped here independently of how
 * much wall-clock budget the attempt still carries. */
const MAX_COMMIT_TRANSACTION_WINDOW_MS = 10 * 60_000;

/** The budget axis whose limit ended a slice attempt. */
export type SliceBudgetAxis =
	| "wall-clock"
	| "model-steps"
	| "mutation-calls"
	| "commit-attempts";

export type SliceExecutionOutcome =
	| {
			kind: "committed";
			receipt: CommittedSliceReceipt | AppMaterializationReceipt;
	  }
	| { kind: "rebase-conflict"; report: unknown }
	| { kind: "read-set-stale"; stale: unknown }
	| { kind: "architect-decision"; decision: ArchitectBlockerDecision }
	| {
			kind: "budget-exhausted";
			axis: SliceBudgetAxis;
			spent: {
				modelSteps: number;
				mutationCalls: number;
				commitAttempts: number;
				wallClockMs: number;
				/** Paid architect blockers: each one extended the enforced step,
				 * call, and wall-clock limits by one BLOCKER_RESOLUTION_ALLOWANCE
				 * past the base budget. */
				blockerReports: number;
			};
	  }
	| { kind: "protocol-failure"; code: string; message: string };

export type SliceBlockerResolver = (args: {
	readonly blocker: ExecutionBlocker;
	readonly brief: SliceExecutionBrief;
	readonly diagnostics: unknown;
	readonly signal: AbortSignal;
}) => Promise<ArchitectBlockerDecision>;

export type ExecutorToolOutcomeKind =
	| "accepted"
	| "non-applied"
	| "skipped"
	| "wire-invalid"
	| "operation-rejected"
	| "mutation-rejected"
	| "validator-repair"
	| "finalization-rejected"
	| "committed"
	| "terminal-protocol";

export interface ExecutorToolOutcomeEvent {
	readonly modelStep: number;
	readonly toolName: string;
	readonly operationIndex?: number;
	readonly workspaceRevision: number;
	readonly outcome: ExecutorToolOutcomeKind;
	readonly code: string;
}

// ── The mounted tool surface ─────────────────────────────────────────

const FINISH_TOOL = "finishWorkflow";
const REPORT_BLOCKER_TOOL = "reportExecutionBlocker";

const noArgumentsSchema = z.object({}).strict();

/** Server-owned tools mounted beside the ordinary Nova read/mutation surface. */
const SERVER_TOOLS: Readonly<
	Record<string, { description: string; schema: z.ZodType }>
> = {
	[FINISH_TOOL]: {
		description:
			"Finish this workflow. The server inspects the complete private candidate, verifies current external reads and export readiness, and commits the workflow as one canonical revision only when every check is clean. Otherwise it returns exact corrections to make with ordinary Nova tools before calling finishWorkflow again.",
		schema: noArgumentsSchema,
	},
	[REPORT_BLOCKER_TOOL]: {
		description:
			"Report exact observations that cannot be resolved locally and request one construction decision. This is evidence for the server-owned architect, not a design verdict or a user message.",
		schema: executionBlockerSchema,
	},
};

/** The immutable mounted tool definitions for every slice. Keeping the full
 * native registry stable preserves prompt-cache shape; provider `allowedTools`
 * and the server-side dispatch check enforce the slice-specific profile. */
export function buildExecutorTools(
	_brief?: SliceExecutionBrief,
): Record<string, { description: string; inputSchema: JSONSchema7 }> {
	const tools: Record<
		string,
		{ description: string; inputSchema: JSONSchema7 }
	> = {};
	for (const name of [
		...STABLE_EXECUTOR_TOOL_PROFILE.readTools,
		...STABLE_EXECUTOR_TOOL_PROFILE.mutationTools,
	]) {
		const entry = CHANGE_SET_TOOL_REGISTRY.get(name);
		if (entry === undefined) {
			throw new Error(
				`The stable executor profile names unknown tool ${name}.`,
			);
		}
		tools[name] = {
			description: entry.tool.description,
			inputSchema: executorWireToolSchema(name, entry.tool.inputSchema),
		};
	}
	for (const [name, definition] of Object.entries(SERVER_TOOLS)) {
		tools[name] = {
			description: definition.description,
			inputSchema: executorWireToolSchema(name, definition.schema),
		};
	}
	return tools;
}

// ── The production step ──────────────────────────────────────────────

/**
 * The real model call behind one executor step: one generation, tools mounted
 * with NO `execute` (the loop dispatches), and native multi-tool responses
 * enabled. The provider may compose calls; the loop owns their serial order.
 *
 * `strict: false` matches every other Nova tool surface — under Responses
 * strict-mode normalization the model cannot omit an inapplicable slot and
 * invents filler for it; SDK-side Zod validation is the real gate.
 */
export function productionExecutorStep(
	model: LanguageModel,
	reasoningEffort: ReasoningEffort = "xhigh",
	promptCacheKey?: string,
): ExecutorStepFn {
	return async ({
		system,
		messages,
		tools: definitions,
		allowedTools,
		signal,
	}) => {
		const base = reasoningProviderOptions(
			reasoningEffort,
			promptCacheKey === undefined ? undefined : { promptCacheKey },
		);
		/* A dead signal must not construct the stream machinery at all: the
		 * result promises only settle by consumption, and a call aborted
		 * before its first byte strands them (same guard as
		 * `subGeneration.ts`). */
		signal.throwIfAborted();
		/* Streamed like every other Nova call, with blocking semantics — the
		 * stream drains fully before the aggregates resolve. A blocking
		 * Responses call sends no headers until the whole generation
		 * finishes, which the transport's header timeout kills, and the
		 * server delivers context-compaction items only inside a response
		 * stream. */
		const result = streamText({
			model,
			system,
			messages: projectModelHistoryFromNewestCompaction(messages),
			tools: Object.fromEntries(
				Object.entries(definitions).map(([name, definition]) => [
					name,
					tool({
						description: definition.description,
						inputSchema: jsonSchema(definition.inputSchema),
						strict: false,
					}),
				]),
			),
			toolChoice: "auto",
			/* One model step per call; the loop owns what happens next. */
			stopWhen: stepCountIs(1),
			abortSignal: signal,
			providerOptions: {
				openai: {
					...base.openai,
					parallelToolCalls: true,
					...(allowedTools !== undefined && allowedTools.length > 0
						? {
								allowedTools: {
									toolNames: [...allowedTools],
									mode: "auto" as const,
								},
							}
						: {}),
				} satisfies OpenAIResponsesProviderOptions,
			},
		});
		/* The result promises are getters minting a fresh instance per
		 * access; observe one instance of each NOW so a stream-stopping
		 * error rejects promises that already have handlers instead of
		 * escaping as an unhandled rejection. The drain's own throw is what
		 * the caller classifies. */
		const pending: PromiseLike<unknown>[] = [
			result.toolCalls,
			result.text,
			result.reasoningText,
			result.usage,
			result.responseMessages,
		];
		for (const p of pending) void Promise.resolve(p).catch(() => {});
		for await (const _part of result.stream) {
			// Drain — generation advances only by consumption.
		}
		const [toolCalls, text, reasoningText, usage, responseMessages] =
			await Promise.all([
				result.toolCalls,
				result.text,
				result.reasoningText,
				result.usage,
				result.responseMessages,
			]);
		return {
			toolCalls: toolCalls.map((call) => ({
				toolCallId: call.toolCallId,
				toolName: call.toolName,
				input: call.input,
			})),
			text,
			...(reasoningText && { reasoningText }),
			usage,
			responseMessages,
		};
	};
}

// ── Message plumbing ─────────────────────────────────────────────────

type JsonValue = Parameters<typeof JSON.stringify>[0];

/** Force a tool result through JSON so the wire carries only serializable
 *  values (dropped `undefined`s, dates as ISO strings) — the same shape the
 *  provider would see anyway, decided here rather than at serialization. */
function toJsonValue(value: unknown): JsonValue {
	return JSON.parse(JSON.stringify(value ?? null)) as JsonValue;
}

function toolMessage(
	toolCallId: string,
	toolName: string,
	value: unknown,
): ModelMessage {
	return {
		role: "tool",
		content: [
			{
				type: "tool-result",
				toolCallId,
				toolName,
				output: { type: "json", value: toJsonValue(value) },
			},
		],
	};
}

function userMessage(text: string): ModelMessage {
	return { role: "user", content: [{ type: "text", text }] };
}

interface PendingExecutorStep {
	readonly modelStep: number;
	readonly stepKey: string;
	readonly responseMessages: ModelMessage[];
	readonly toolCalls: Array<{
		readonly toolCallId: string;
		readonly toolName: string;
		readonly input: unknown;
	}>;
	/** An earlier call in this same provider response already failed or
	 * finalized. Any unanswered suffix is dependent work and must receive
	 * skipped results rather than execute after recovery. */
	readonly halted: boolean;
}

/** Find the earliest provider response in one attempt whose function call has
 * no matching output yet. Context items retain the append key that binds the
 * response to its exact slice attempt and paid model step; scanning only the
 * flattened transcript would make a prior slice's crash indistinguishable
 * from the currently running one. */
function pendingExecutorStep(
	context: ExecutorConversationContext,
	scopeKey: string,
): PendingExecutorStep | null {
	const prefix = `step:${scopeKey}:`;
	const suffix = ":response";
	const responses = new Map<
		string,
		{ modelStep: number; messages: ModelMessage[] }
	>();
	for (const item of context.items ?? []) {
		if (!item.appendKey.startsWith(prefix) || !item.appendKey.endsWith(suffix))
			continue;
		const encodedStep = item.appendKey.slice(
			prefix.length,
			item.appendKey.length - suffix.length,
		);
		if (!/^\d+$/.test(encodedStep)) continue;
		const modelStep = Number(encodedStep);
		if (!Number.isSafeInteger(modelStep) || modelStep < 1) continue;
		const group = responses.get(item.appendKey) ?? { modelStep, messages: [] };
		group.messages.push(item.message);
		responses.set(item.appendKey, group);
	}
	const answered = new Map<string, unknown>();
	for (const message of context.messages) {
		if (message.role !== "tool") continue;
		for (const part of message.content) {
			if (part.type !== "tool-result") continue;
			const output = part.output;
			answered.set(
				part.toolCallId,
				output.type === "json" ? output.value : output,
			);
		}
	}
	for (const [, response] of [...responses].sort(
		([, left], [, right]) => left.modelStep - right.modelStep,
	)) {
		const allToolCalls = response.messages.flatMap((message) => {
			if (message.role !== "assistant" || typeof message.content === "string")
				return [];
			return message.content.flatMap((part) =>
				part.type === "tool-call"
					? [
							{
								toolCallId: part.toolCallId,
								toolName: part.toolName,
								input: part.input,
							},
						]
					: [],
			);
		});
		const firstUnanswered = allToolCalls.findIndex(
			(call) => !answered.has(call.toolCallId),
		);
		const toolCalls =
			firstUnanswered < 0 ? [] : allToolCalls.slice(firstUnanswered);
		if (toolCalls.length > 0) {
			const halted = allToolCalls.slice(0, firstUnanswered).some((call) => {
				const result = answered.get(call.toolCallId);
				if (result === null || typeof result !== "object") return false;
				const status = (result as { status?: unknown }).status;
				return (
					status === "failed" ||
					status === "not-applied" ||
					status === "needs-correction" ||
					status === "skipped" ||
					status === "committed" ||
					status === "terminal"
				);
			});
			return {
				modelStep: response.modelStep,
				stepKey: `${scopeKey}:${response.modelStep}`,
				responseMessages: response.messages,
				toolCalls,
				halted,
			};
		}
	}
	return null;
}

/** Pair a commit call whose canonical transaction succeeded before its model
 * output was persisted. The caller appends this before any later slice brief
 * or provider request. */
export function recoverCommittedExecutorToolResult(args: {
	readonly context: ExecutorConversationContext;
	readonly attemptId: string;
	readonly receipt: CommittedSliceReceipt;
}): { readonly appendKey: string; readonly message: ModelMessage } | null {
	const pending = pendingExecutorStep(args.context, args.attemptId);
	if (pending === null) return null;
	if (
		pending.toolCalls.length !== 1 ||
		pending.toolCalls[0]?.toolName !== FINISH_TOOL
	) {
		throw new Error(
			`Committed slice attempt ${args.attemptId} has a pending non-finalizer executor call.`,
		);
	}
	const call = pending.toolCalls[0];
	return {
		appendKey: `step:${args.attemptId}:${pending.modelStep}:tool:${call.toolCallId}`,
		message: toolMessage(call.toolCallId, call.toolName, {
			status: "committed",
			code: "WORKFLOW_COMMITTED",
			receipt: args.receipt,
		}),
	};
}

/**
 * Unwrap a shared-tool envelope to the payload the model should read — the
 * same projection chat and MCP perform. `summary` is UI-only presentation and
 * never reaches a model.
 */
function projectBoundIdentities(
	value: unknown,
	workspace: ExecutorWorkspace,
): unknown {
	const byUuid = new Map(
		workspace
			.currentExecutionCheckpoint()
			.handles.map((binding) => [binding.uuid, binding.handle]),
	);
	const walk = (member: unknown): unknown => {
		if (typeof member === "string") {
			const handle = byUuid.get(member);
			return handle === undefined ? member : { handle };
		}
		if (Array.isArray(member)) return member.map(walk);
		if (member !== null && typeof member === "object") {
			return Object.fromEntries(
				Object.entries(member).map(([key, nested]) => [
					byUuid.get(key) ?? key,
					walk(nested),
				]),
			);
		}
		return member;
	};
	return walk(value);
}

function projectToolResult(
	value: unknown,
	workspace: ExecutorWorkspace,
): unknown {
	const project = (member: unknown) =>
		workspace.projectDesignLookupReferences(
			projectBoundIdentities(member, workspace),
		);
	if (value === null || typeof value !== "object") return project(value);
	const envelope = value as {
		kind?: unknown;
		result?: unknown;
		data?: unknown;
	};
	if (envelope.kind === "read") return project(envelope.data);
	if (envelope.kind !== "mutate") return project(value);
	const inner = envelope.result;
	if (inner === null || typeof inner !== "object") return project(inner);
	const { summary: _summary, ...rest } = inner as Record<string, unknown>;
	return project(rest);
}

function resultHasError(result: unknown): boolean {
	return (
		result !== null &&
		typeof result === "object" &&
		typeof (result as { error?: unknown }).error === "string"
	);
}

function caseSelectionNeedsChanges(
	toolName: string,
	result: unknown,
): result is Record<string, unknown> {
	return (
		toolName === "configureCaseSelection" &&
		result !== null &&
		typeof result === "object" &&
		(result as { outcome?: unknown }).outcome === "needs_changes"
	);
}

const CONTINUE_NUDGE =
	"Continue building with the ordinary Nova tools. You may make several independent calls in one response; they run in order. Call finishWorkflow when this workflow is complete.";

const INVENTORY_MODULE_LIMIT = 12;
const INVENTORY_FORM_LIMIT = 24;
const INVENTORY_FIELD_LIMIT_PER_FORM = 12;
const INVENTORY_USER_PROPERTY_LIMIT = 16;
const INVENTORY_CASE_TYPE_LIMIT = 12;
const INVENTORY_CASE_PROPERTY_LIMIT = 24;
const INVENTORY_HANDLE_LIMIT = 128;

function more(count: number, shown: number): string {
	return count > shown ? `; +${count - shown} more` : "";
}

/** A compact identity-bearing checkpoint beside the brief. It is deliberately
 * richer than counts: remote compaction removes old tool transcripts, and a
 * resumed slice must retain enough durable identity to continue without
 * rediscovering or re-creating the structures already in its candidate. */
export function renderExecutorWorkspaceSummary(
	workspace: ExecutorWorkspace,
): string {
	const snapshot = workspace.currentSnapshot();
	const execution = workspace.currentExecutionCheckpoint();
	const doc = snapshot.doc;
	const handleByUuid = new Map(
		execution.handles.map((binding) => [binding.uuid, binding.handle]),
	);
	const symbol = (uuid: string, kind: string): string =>
		handleByUuid.get(uuid) ?? `[unbound ${kind}]`;
	const moduleCount = snapshot.doc.moduleOrder.length;
	const formCount = Object.keys(snapshot.doc.forms).length;
	const lines = [
		"## Current change set",
		`The private candidate holds ${moduleCount} module(s) and ${formCount} form(s).`,
		moduleCount === 0 && formCount === 0
			? "No private mutations have been applied yet — this is the first step."
			: "Build on what is already in the private workspace; never re-create it.",
		`App: ${JSON.stringify(doc.appName)} (${doc.appId})`,
	];
	const handles = execution.handles.slice(0, INVENTORY_HANDLE_LIMIT);
	if (handles.length > 0) {
		lines.push(
			`Durable handles: ${handles
				.map((binding) => `${binding.handle}:${binding.entityKind}`)
				.join(", ")}${more(execution.handles.length, handles.length)}`,
		);
	}

	const userPropertyOrder = doc.userPropertyOrder ?? [];
	const userProperties = doc.userProperties ?? {};
	const userPropertyIds = userPropertyOrder.slice(
		0,
		INVENTORY_USER_PROPERTY_LIMIT,
	);
	if (userPropertyIds.length > 0) {
		lines.push(
			`Worker information: ${userPropertyIds
				.map((uuid) => {
					const property = userProperties[uuid];
					return property === undefined
						? symbol(uuid, "worker property")
						: `${property.slug} (${symbol(uuid, "worker property")})`;
				})
				.join(", ")}${more(userPropertyOrder.length, userPropertyIds.length)}`,
		);
	}

	const caseTypes = (doc.caseTypes ?? []).slice(0, INVENTORY_CASE_TYPE_LIMIT);
	for (const caseType of caseTypes) {
		const properties = caseType.properties.slice(
			0,
			INVENTORY_CASE_PROPERTY_LIMIT,
		);
		lines.push(
			`Case type ${caseType.name}: ${properties
				.map((property) => property.name)
				.join(", ")}${more(caseType.properties.length, properties.length)}`,
		);
	}
	if ((doc.caseTypes?.length ?? 0) > caseTypes.length) {
		lines.push(
			`Case types: +${(doc.caseTypes?.length ?? 0) - caseTypes.length} more`,
		);
	}

	let shownForms = 0;
	for (const moduleUuid of doc.moduleOrder.slice(0, INVENTORY_MODULE_LIMIT)) {
		const module = doc.modules[moduleUuid];
		if (module === undefined) continue;
		lines.push(
			`Module ${symbol(moduleUuid, "module")}: id=${module.id}, name=${JSON.stringify(module.name)}${module.caseType === undefined ? "" : `, caseType=${module.caseType}`}`,
		);
		for (const formUuid of doc.formOrder[moduleUuid] ?? []) {
			if (shownForms >= INVENTORY_FORM_LIMIT) break;
			const form = doc.forms[formUuid];
			if (form === undefined) continue;
			shownForms += 1;
			const fieldIds = (doc.fieldOrder[formUuid] ?? []).slice(
				0,
				INVENTORY_FIELD_LIMIT_PER_FORM,
			);
			const fieldInventory = fieldIds
				.map((uuid) => {
					const field = doc.fields[uuid];
					return field === undefined
						? symbol(uuid, "field")
						: `${field.id}:${field.kind} (${symbol(uuid, "field")})`;
				})
				.join(", ");
			lines.push(
				`  Form ${symbol(formUuid, "form")}: id=${form.id}, name=${JSON.stringify(form.name)}, type=${form.type}; fields=${fieldInventory || "none"}${more((doc.fieldOrder[formUuid] ?? []).length, fieldIds.length)}`,
			);
		}
	}
	if (moduleCount > INVENTORY_MODULE_LIMIT) {
		lines.push(`Modules: +${moduleCount - INVENTORY_MODULE_LIMIT} more`);
	}
	if (formCount > shownForms)
		lines.push(`Forms: +${formCount - shownForms} more`);

	return lines.join("\n");
}

function projectBlueprintHandles(
	value: unknown,
	handleByUuid: ReadonlyMap<string, string>,
): unknown {
	if (typeof value === "string") return handleByUuid.get(value) ?? value;
	if (Array.isArray(value))
		return value.map((entry) => projectBlueprintHandles(entry, handleByUuid));
	if (value === null || typeof value !== "object") return value;
	return Object.fromEntries(
		Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
			handleByUuid.get(key) ?? key,
			projectBlueprintHandles(entry, handleByUuid),
		]),
	);
}

/** Lossless model-facing private Blueprint checkpoint. Unlike the compact
 * focus inventory, this carries every current field label, hint, help block,
 * expression, ordering relation, case operation, list setting, and media
 * decision. Authored entity identities project to their durable handles in
 * both map keys and reference values. Accepted lookup identities project back
 * to the same semantic references the executor received in its brief. */
export function renderExecutorBlueprintCheckpoint(
	workspace: ExecutorWorkspace,
): string {
	const snapshot = workspace.currentSnapshot();
	const execution = workspace.currentExecutionCheckpoint();
	const handleByUuid = new Map(
		execution.handles.map((binding) => [binding.uuid, binding.handle]),
	);
	return JSON.stringify(
		{
			workspaceRevision: snapshot.revision,
			canonicalBaseSequence: snapshot.canonicalSeq,
			externalContextDigest: snapshot.externalContextDigest,
			blueprint: workspace.projectDesignLookupReferences(
				projectBlueprintHandles(snapshot.doc, handleByUuid),
			),
		},
		null,
		1,
	);
}

/** ONE spelling for the candidate checkpoint heading: the composer writes it
 * and the compaction re-seed detects it by prefix, so a drifted copy would
 * silently stop fresh checkpoints after a compaction boundary. */
const EXECUTOR_CANDIDATE_HEADING = "## Current authoritative private candidate";
const EXECUTOR_BRIEF_HEADING = "## Accepted execution brief";
const EXECUTOR_FOCUS_HEADING = "## Current slice focus";

function renderExecutorSliceFocus(
	brief: SliceExecutionBrief,
	_workspace: ExecutorWorkspace,
): string {
	return [
		`${brief.slice.name}: ${brief.slice.goal}`,
		`Modules: ${brief.moduleRealizations
			.map(
				(module) =>
					`${module.action} ${module.compositionId} (${module.role}, menu parent ${module.parentModuleCompositionId ?? "top-level"}, after ${module.afterSiblingModuleCompositionId ?? "first"}, record host ${module.hostRecord === null ? "none" : `${module.hostRecord.name} -> ${module.hostRecord.blueprintCaseType}`})`,
			)
			.join("; ")}.`,
		`Forms: ${brief.formRealizations
			.map(
				(form) =>
					`${form.name} (${form.blueprintFormType}) in ${form.moduleCompositionId}, ${form.layout.kind}`,
			)
			.join("; ")}.`,
		"Execute this accepted composition exactly. Do not redesign, add a parallel host, flatten a sectioned form, or duplicate a role form. Call finishWorkflow only after the complete workflow is present.",
	].join("\n");
}

function executorSliceStartMessages(
	brief: SliceExecutionBrief,
	workspace: ExecutorWorkspace,
): ModelMessage[] {
	return [
		userMessage(
			[
				EXECUTOR_BRIEF_HEADING,
				"This is the exact current slice in the ongoing accepted build. It is immutable for this attempt.",
				renderBriefMessage(brief),
			].join("\n\n"),
		),
		userMessage(
			[
				EXECUTOR_CANDIDATE_HEADING,
				"This is the complete current private Blueprint, projected through durable authoring handles. It is authority after any compaction or recovery.",
				renderExecutorBlueprintCheckpoint(workspace),
			].join("\n\n"),
		),
		userMessage(
			[
				EXECUTOR_FOCUS_HEADING,
				renderExecutorSliceFocus(brief, workspace),
				"Compact inventory:",
				renderExecutorWorkspaceSummary(workspace),
			].join("\n\n"),
		),
	];
}

function messageStartsWith(message: ModelMessage, heading: string): boolean {
	if (message.role !== "user") return false;
	const text =
		typeof message.content === "string"
			? message.content
			: message.content
					.filter((part) => part.type === "text")
					.map((part) => part.text)
					.join("");
	return text.startsWith(heading);
}

/** The Elm-style one-liner for a rejected wire envelope's Zod issues. */
function wireIssueSummary(error: z.ZodError): string {
	return error.issues
		.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
		.join("; ");
}

function normalizedFailureText(value: string): string {
	return value
		.replace(
			/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/gi,
			"<identity>",
		)
		.replace(/@[a-z0-9_-]+/gi, "<handle>")
		.replace(/\b\d+\b/g, "<number>")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 2_000);
}

function boundedFailureText(value: string): string {
	return value.replace(/\s+/g, " ").trim().slice(0, 2_000);
}

function failureSignature(value: unknown): string {
	return canonicalJsonDigest(value).slice(0, 24);
}

// ── The loop ─────────────────────────────────────────────────────────

export interface RunSliceExecutorArgs {
	workspace: ExecutorWorkspace;
	brief: SliceExecutionBrief;
	budget: SliceExecutionBudget;
	step: ExecutorStepFn;
	context?: ExecutorConversationContext;
	contextScopeKey?: string;
	commit: (
		signal: AbortSignal,
		deadlineAt: number,
	) => Promise<SliceCommitResult>;
	reconcileCommit?: () => Promise<SliceCommitResult | null>;
	budgetLedger?: {
		readonly deadlineAt: number;
		readonly spent: SliceAttemptBudgetSpent;
		claim(
			counter: SliceAttemptBudgetCounter,
			limit: number,
			claimKey: string,
		): Promise<SliceAttemptBudgetClaimResult>;
	};
	resolveBlocker?: SliceBlockerResolver;
	signal: AbortSignal;
	onProgress?: (phase: "building" | "validating" | "committing") => void;
	onReasoning?: (text: string) => void;
	onUsage?: (usage: LanguageModelUsage, identity: DurableUsageIdentity) => void;
	onToolCall?: (call: {
		readonly modelStep: number;
		readonly toolName: string;
		readonly workspaceRevision: number;
	}) => void;
	onToolOutcome?: (event: ExecutorToolOutcomeEvent) => void | Promise<void>;
}

type NativeCall = Awaited<ReturnType<ExecutorStepFn>>["toolCalls"][number];

type NativeCallDispatch =
	| { readonly kind: "continue" }
	| { readonly kind: "halt-response" }
	| { readonly kind: "stop"; readonly outcome: SliceExecutionOutcome };

function failedToolResult(args: {
	readonly code: string;
	readonly error: string;
	readonly repeatedFailure?: {
		readonly fingerprint: string;
		readonly occurrence: number;
		readonly architectGuidance?: string;
		readonly recoveryGuidance?: string;
	};
}): Record<string, unknown> {
	return {
		status: "failed",
		code: args.code,
		error: args.error,
		...(args.repeatedFailure !== undefined && {
			repeatedFailure: args.repeatedFailure,
		}),
	};
}

function toolFailureCode(
	receipt: { readonly error?: { readonly code: string } } | undefined,
	result: unknown,
): string {
	if (receipt?.error?.code !== undefined) return receipt.error.code;
	if (
		result !== null &&
		typeof result === "object" &&
		typeof (result as { code?: unknown }).code === "string"
	) {
		return (result as { code: string }).code;
	}
	return "PRIVATE_MUTATION_REJECTED";
}

/** Input-shape and permission mistakes are compiler protocol facts, not
 * evidence that the reviewed design needs architectural reinterpretation. */
function isSemanticConstructionFailure(code: string): boolean {
	return new Set([
		"COMPOSITION_HOST_FORBIDDEN",
		"READ_SET_UNRECORDED",
		"EXCLUSIVE_NOT_ALONE",
		"EXCLUSIVE_SET_CLOSED",
		"REDUCER_FAILURE",
	]).has(code);
}

/**
 * Execute one workflow against the implicit private change-set workspace.
 * Native calls are accepted in the provider's order, persisted one result at
 * a time, and never expose workspace handles, revisions, or construction
 * bookkeeping beyond the ordinary Nova tool inputs.
 */
export async function runSliceExecutor(
	args: RunSliceExecutorArgs,
): Promise<SliceExecutionOutcome> {
	const { workspace, brief, budget, signal } = args;
	const tools = buildExecutorTools(brief);
	const allowedReadTools = new Set(brief.toolProfile.readTools);
	const allowedMutationTools = new Set(brief.toolProfile.mutationTools);
	const allowedTools = [
		...brief.toolProfile.readTools,
		...brief.toolProfile.mutationTools,
		FINISH_TOOL,
		REPORT_BLOCKER_TOOL,
	];
	let deadlineAt =
		args.budgetLedger?.deadlineAt ?? Date.now() + budget.maxWallClockMs;
	let deadline = new AbortController();
	let boundedSignal = AbortSignal.any([signal, deadline.signal]);
	let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
	const armDeadlineTimer = () => {
		if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
		if (deadline.signal.aborted) {
			deadline = new AbortController();
			boundedSignal = AbortSignal.any([signal, deadline.signal]);
		}
		const armed = deadline;
		deadlineTimer = setTimeout(
			() =>
				armed.abort(new Error("Slice execution wall-clock budget expired.")),
			Math.max(0, deadlineAt - Date.now()),
		);
		deadlineTimer.unref?.();
	};
	armDeadlineTimer();
	const deadlineExceeded = () =>
		!signal.aborted && (deadline.signal.aborted || Date.now() >= deadlineAt);

	let modelSteps = args.budgetLedger?.spent.modelSteps ?? 0;
	let mutationCalls = args.budgetLedger?.spent.mutationCalls ?? 0;
	let commitAttempts = args.budgetLedger?.spent.commitAttempts ?? 0;
	let blockerReports = args.budgetLedger?.spent.blockerReports ?? 0;
	const ephemeralBudgetClaims = new Map<string, SliceAttemptBudgetCounter>();
	const allowedModelSteps = () =>
		budget.maxModelSteps +
		blockerReports * BLOCKER_RESOLUTION_ALLOWANCE.modelSteps;
	const allowedMutationCalls = () =>
		budget.maxMutationCalls +
		blockerReports * BLOCKER_RESOLUTION_ALLOWANCE.mutationCalls;
	const claimBudget = async (
		counter: SliceAttemptBudgetCounter,
		limit: number,
		claimKey: string,
	): Promise<SliceAttemptBudgetClaimResult> => {
		const used =
			counter === "modelSteps"
				? modelSteps
				: counter === "mutationCalls"
					? mutationCalls
					: counter === "commitAttempts"
						? commitAttempts
						: blockerReports;
		let result: SliceAttemptBudgetClaimResult;
		if (args.budgetLedger !== undefined) {
			result = await args.budgetLedger.claim(counter, limit, claimKey);
		} else {
			const existing = ephemeralBudgetClaims.get(claimKey);
			if (existing !== undefined) {
				if (existing !== counter) {
					throw new Error(
						`Budget claim ${claimKey} was reused for ${counter} after ${existing}.`,
					);
				}
				return "replayed";
			}
			if (used >= limit) return "exhausted";
			ephemeralBudgetClaims.set(claimKey, counter);
			result = "claimed";
		}
		if (result !== "claimed") return result;
		if (counter === "modelSteps") modelSteps += 1;
		else if (counter === "mutationCalls") mutationCalls += 1;
		else if (counter === "commitAttempts") commitAttempts += 1;
		else blockerReports += 1;
		return "claimed";
	};
	/* The ledger deadline embodies (budget + paid blocker allowances − durable
	 * active spend), and each mid-run paid blocker grows `deadlineAt` and
	 * `blockerReports` in lockstep, so allowance minus remaining is the
	 * attempt's total active wall-clock spend across recoveries. */
	const wallClockMsSpent = () =>
		Math.max(
			0,
			totalWallClockAllowanceMs(budget, blockerReports) -
				(deadlineAt - Date.now()),
		);
	const exhausted = (axis: SliceBudgetAxis): SliceExecutionOutcome => ({
		kind: "budget-exhausted",
		axis,
		spent: {
			modelSteps,
			mutationCalls,
			commitAttempts,
			wallClockMs: wallClockMsSpent(),
			blockerReports,
		},
	});

	const context = args.context ?? { messages: [] };
	const appendKeys = context.appendKeys ?? new Set<string>();
	context.appendKeys = appendKeys;
	const contextItems = context.items ?? [];
	context.items = contextItems;
	const completedStepKeys = context.completedStepKeys ?? new Set<string>();
	context.completedStepKeys = completedStepKeys;
	let messages: ModelMessage[] = [...context.messages];
	let persistence = Promise.resolve();
	const adoptMessages = (
		appendKey: string,
		tail: readonly ModelMessage[],
	): void => {
		if (appendKeys.has(appendKey)) return;
		appendKeys.add(appendKey);
		messages = [...messages, ...tail];
		context.messages = messages;
		contextItems.push(...tail.map((message) => ({ appendKey, message })));
	};
	const appendMessages = (appendKey: string, ...tail: ModelMessage[]): void => {
		if (appendKeys.has(appendKey)) return;
		adoptMessages(appendKey, tail);
		if (context.append !== undefined) {
			persistence = persistence.then(() => context.append?.(appendKey, tail));
		}
	};
	const scopeKey = args.contextScopeKey ?? `ephemeral:${brief.slice.id}`;
	const failureOccurrences = new Map<string, number>();
	const architectGuidedFailures = new Set<string>();
	let lastFailureSignature: string | null = null;
	const clearFailureSequence = (): void => {
		failureOccurrences.clear();
		architectGuidedFailures.clear();
		lastFailureSignature = null;
	};
	const recoverFailureState = (value: unknown): boolean => {
		let found = false;
		if (Array.isArray(value)) {
			for (const entry of value) found = recoverFailureState(entry) || found;
			return found;
		}
		if (value === null || typeof value !== "object") return false;
		const record = value as Record<string, unknown>;
		if (
			typeof record.fingerprint === "string" &&
			typeof record.occurrence === "number" &&
			Number.isSafeInteger(record.occurrence)
		) {
			found = true;
			if (
				lastFailureSignature !== null &&
				lastFailureSignature !== record.fingerprint
			) {
				clearFailureSequence();
			}
			lastFailureSignature = record.fingerprint;
			failureOccurrences.set(
				record.fingerprint,
				Math.max(
					record.occurrence,
					failureOccurrences.get(record.fingerprint) ?? 0,
				),
			);
			if (typeof record.architectGuidance === "string") {
				architectGuidedFailures.add(record.fingerprint);
			}
		}
		for (const nested of Object.values(record)) {
			found = recoverFailureState(nested) || found;
		}
		return found;
	};
	for (const message of context.messages) {
		const foundFailure = recoverFailureState(message);
		if (message.role !== "tool" || foundFailure) continue;
		const skippedOnly =
			message.content.length > 0 &&
			message.content.every((part) => {
				if (part.type !== "tool-result" || part.output.type !== "json") {
					return false;
				}
				const value = part.output.value as unknown;
				return (
					value !== null &&
					typeof value === "object" &&
					(value as { status?: unknown }).status === "skipped"
				);
			});
		if (!skippedOnly) clearFailureSequence();
	}
	type FailureObservation =
		| {
				readonly kind: "observed";
				readonly signature: string;
				readonly occurrence: number;
				readonly guidance?: string;
		  }
		| {
				readonly kind: "stop";
				readonly signature: string;
				readonly occurrence: number;
				readonly outcome: SliceExecutionOutcome;
		  };
	const observeSemanticFailure = async (failure: {
		readonly signature: string;
		readonly observations: readonly string[];
		readonly diagnostics?: unknown;
	}): Promise<FailureObservation> => {
		if (
			lastFailureSignature !== null &&
			lastFailureSignature !== failure.signature
		) {
			clearFailureSequence();
		}
		lastFailureSignature = failure.signature;
		const occurrence = (failureOccurrences.get(failure.signature) ?? 0) + 1;
		failureOccurrences.set(failure.signature, occurrence);
		if (occurrence < 2) {
			return { kind: "observed", signature: failure.signature, occurrence };
		}
		if (architectGuidedFailures.has(failure.signature)) {
			return {
				kind: "stop",
				signature: failure.signature,
				occurrence,
				outcome: {
					kind: "protocol-failure",
					code: "repeated-failure-after-architect-guidance",
					message:
						"The compiler repeated the same substantive construction failure after architect guidance.",
				},
			};
		}
		if (args.resolveBlocker === undefined) {
			return {
				kind: "stop",
				signature: failure.signature,
				occurrence,
				outcome: {
					kind: "protocol-failure",
					code: "architect-resolver-unavailable",
					message:
						"The server-owned architect resolver is unavailable for a repeated substantive construction failure.",
				},
			};
		}
		const blockerClaim = await claimBudget(
			"blockerReports",
			budget.maxBlockerResolutions,
			`auto-blocker:${scopeKey}:${failure.signature}`,
		);
		if (blockerClaim !== "claimed") {
			return {
				kind: "stop",
				signature: failure.signature,
				occurrence,
				outcome: {
					kind: "protocol-failure",
					code:
						blockerClaim === "replayed"
							? "architect-decision-response-lost"
							: "blocker-resolution-budget-exhausted",
					message:
						blockerClaim === "replayed"
							? "A paid architect decision was durable without its result, so Nova stopped instead of purchasing or inventing another."
							: "The compiler exhausted its bounded architect-resolution budget.",
				},
			};
		}
		deadlineAt += BLOCKER_RESOLUTION_ALLOWANCE.ms;
		armDeadlineTimer();
		const blocker = executionBlockerSchema.parse({
			schemaVersion: 1,
			observations: failure.observations.slice(0, 12),
			requestedDecision:
				"Give exact implementation guidance for this substantive repeated construction failure without changing the accepted workflow meaning.",
		});
		const decision = await awaitWithAbort(
			args.resolveBlocker({
				blocker,
				brief,
				diagnostics:
					failure.diagnostics ??
					projectDiagnostics(
						await awaitWithAbort(workspace.inspect(), boundedSignal),
						brief,
					),
				signal: boundedSignal,
			}),
			boundedSignal,
		);
		if (decision.kind !== "continue") {
			return {
				kind: "stop",
				signature: failure.signature,
				occurrence,
				outcome: { kind: "architect-decision", decision },
			};
		}
		architectGuidedFailures.add(failure.signature);
		return {
			kind: "observed",
			signature: failure.signature,
			occurrence,
			guidance: decision.guidance,
		};
	};
	const observeDeterministicRejection = (failure: {
		readonly signature: string;
	}): FailureObservation => {
		if (
			lastFailureSignature !== null &&
			lastFailureSignature !== failure.signature
		) {
			clearFailureSequence();
		}
		lastFailureSignature = failure.signature;
		const occurrence = (failureOccurrences.get(failure.signature) ?? 0) + 1;
		failureOccurrences.set(failure.signature, occurrence);
		if (occurrence >= 3) {
			return {
				kind: "stop",
				signature: failure.signature,
				occurrence,
				outcome: {
					kind: "protocol-failure",
					code: "repeated-rejected-call",
					message:
						"The executor repeated the same rejected native call three times without changing its input or private workspace.",
				},
			};
		}
		return {
			kind: "observed",
			signature: failure.signature,
			occurrence,
			...(occurrence === 2 && {
				guidance:
					"This exact call was rejected twice with the same result at the same private-workspace revision. Do not retry it unchanged. Apply the operation-specific correction, choose a different allowed operation, or continue without it when the requested state already exists.",
			}),
		};
	};
	const observeNativeCallFailure = async (args: {
		readonly call: NativeCall;
		readonly code: string;
		readonly error: string;
		readonly diagnostics?: unknown;
	}): Promise<{
		readonly observed: FailureObservation;
		readonly repeatedFailure: {
			readonly fingerprint: string;
			readonly occurrence: number;
			readonly architectGuidance?: string;
			readonly recoveryGuidance?: string;
		};
	}> => {
		const semantic = isSemanticConstructionFailure(args.code);
		const observed = semantic
			? await observeSemanticFailure({
					signature: failureSignature({
						toolName: args.call.toolName,
						code: args.code,
						message: normalizedFailureText(args.error),
					}),
					observations: [
						`${args.call.toolName} failed with ${args.code}.`,
						args.error,
					],
					...(args.diagnostics !== undefined && {
						diagnostics: args.diagnostics,
					}),
				})
			: observeDeterministicRejection({
					signature: failureSignature({
						kind: "rejected-native-call",
						toolName: args.call.toolName,
						input: args.call.input,
						code: args.code,
						message: boundedFailureText(args.error),
						workspaceRevision: workspace.currentSnapshot().revision,
					}),
				});
		const guidance =
			observed.kind === "observed" ? observed.guidance : undefined;
		return {
			observed,
			repeatedFailure: {
				fingerprint: observed.signature,
				occurrence: observed.occurrence,
				...(guidance !== undefined &&
					(semantic
						? { architectGuidance: guidance }
						: { recoveryGuidance: guidance })),
			},
		};
	};

	const compactionBoundaryOrdinal = (): number => {
		let count = 0;
		const visit = (value: unknown): void => {
			if (Array.isArray(value)) {
				for (const item of value) visit(item);
				return;
			}
			if (value === null || typeof value !== "object") return;
			const record = value as Record<string, unknown>;
			if (record.type === "custom" && record.kind === "openai.compaction") {
				count += 1;
				return;
			}
			for (const nested of Object.values(record)) visit(nested);
		};
		visit(messages);
		return count;
	};
	const [briefMessage, candidateMessage, focusMessage] =
		executorSliceStartMessages(brief, workspace);
	if (briefMessage !== undefined)
		appendMessages(`slice-brief:${scopeKey}`, briefMessage);
	if (candidateMessage !== undefined) {
		appendMessages(
			`candidate:${scopeKey}:${canonicalJsonDigest(candidateMessage)}`,
			candidateMessage,
		);
	}
	if (focusMessage !== undefined) {
		appendMessages(
			`focus:${scopeKey}:${canonicalJsonDigest(focusMessage)}`,
			focusMessage,
		);
	}

	const emitOutcome = async (
		call: NativeCall,
		operationIndex: number,
		outcome: ExecutorToolOutcomeKind,
		code: string,
	): Promise<void> => {
		await args.onToolOutcome?.({
			modelStep: modelSteps,
			toolName: call.toolName,
			operationIndex,
			workspaceRevision: workspace.currentSnapshot().revision,
			outcome,
			code,
		});
	};
	const appendToolResult = async (
		call: NativeCall,
		value: unknown,
	): Promise<void> => {
		appendMessages(
			`step:${scopeKey}:${modelSteps}:tool:${call.toolCallId}`,
			toolMessage(call.toolCallId, call.toolName, value),
		);
		await persistence;
	};
	const skipCalls = async (
		calls: readonly NativeCall[],
		start: number,
		reason: string,
	): Promise<void> => {
		for (let index = start; index < calls.length; index += 1) {
			const call = calls[index];
			if (call === undefined) continue;
			await emitOutcome(call, index, "skipped", "DEPENDENT_CALL_SKIPPED");
			await appendToolResult(call, {
				status: "skipped",
				code: "DEPENDENT_CALL_SKIPPED",
				reason,
			});
		}
	};

	args.onProgress?.("building");
	let consecutiveEmptySteps = 0;
	try {
		for (;;) {
			await persistence;
			const compacted = projectModelHistoryFromNewestCompaction(messages);
			if (
				modelMessagesContainCompaction(messages) &&
				(!compacted.some((message) =>
					messageStartsWith(message, EXECUTOR_BRIEF_HEADING),
				) ||
					!compacted.some((message) =>
						messageStartsWith(message, EXECUTOR_CANDIDATE_HEADING),
					) ||
					!compacted.some((message) =>
						messageStartsWith(message, EXECUTOR_FOCUS_HEADING),
					))
			) {
				const boundary = compactionBoundaryOrdinal();
				for (const [index, packet] of executorSliceStartMessages(
					brief,
					workspace,
				).entries()) {
					if (packet === undefined) continue;
					appendMessages(
						`compaction-reseed:${scopeKey}:${boundary}:${index}:${canonicalJsonDigest(packet)}`,
						packet,
					);
				}
				await persistence;
			}
			if (signal.aborted) {
				return {
					kind: "protocol-failure",
					code: "aborted",
					message: "This workflow attempt was cancelled before it finished.",
				};
			}
			if (deadlineExceeded()) return exhausted("wall-clock");

			let step: Awaited<ReturnType<ExecutorStepFn>>;
			let stepKey: string;
			const pending = pendingExecutorStep(context, scopeKey);
			if (pending !== null) {
				if (modelSteps > pending.modelStep) {
					throw new Error(
						`Executor attempt ${scopeKey} has unanswered step ${pending.modelStep} behind durable budget step ${modelSteps}.`,
					);
				}
				modelSteps = pending.modelStep;
				stepKey = pending.stepKey;
				step = {
					toolCalls: pending.toolCalls,
					text: "",
					usage: undefined,
					responseMessages: pending.responseMessages,
				};
				if (!completedStepKeys.has(stepKey)) {
					if (context.completeStep !== undefined) {
						throw new Error(
							`Executor response ${stepKey} is durable without atomic completion evidence.`,
						);
					}
					await context.recordStep?.(stepKey, {
						eventKind: "completed",
						responseDigest: durableModelValueDigest(pending.responseMessages),
					});
					completedStepKeys.add(stepKey);
				}
				if (pending.halted) {
					await skipCalls(
						step.toolCalls,
						0,
						"An earlier call in this response already failed or finalized before recovery.",
					);
					continue;
				}
			} else {
				if (modelSteps >= allowedModelSteps()) return exhausted("model-steps");
				if (
					(await claimBudget(
						"modelSteps",
						allowedModelSteps(),
						`model:${scopeKey}:${modelSteps + 1}`,
					)) === "exhausted"
				) {
					return exhausted("model-steps");
				}
				stepKey = `${scopeKey}:${modelSteps}`;
				await context.recordStep?.(stepKey, {
					eventKind: "started",
					requestDigest: durableModelValueDigest(
						projectModelHistoryFromNewestCompaction(messages),
					),
				});
				try {
					step = await awaitWithAbort(
						args.step({
							system: EXECUTOR_SYSTEM,
							messages,
							tools,
							allowedTools,
							signal: boundedSignal,
						}),
						boundedSignal,
					);
				} catch (error) {
					if (deadlineExceeded()) return exhausted("wall-clock");
					throw error;
				}
				const responseKey = `step:${scopeKey}:${modelSteps}:response`;
				const responseDigest = durableModelValueDigest(step.responseMessages);
				const persistedUsage =
					step.usage === undefined
						? undefined
						: (JSON.parse(JSON.stringify(step.usage)) as Record<
								string,
								unknown
							>);
				if (context.completeStep !== undefined) {
					await persistence;
					await context.completeStep({
						appendKey: responseKey,
						messages: step.responseMessages,
						stepKey,
						responseDigest,
						...(persistedUsage !== undefined && { usage: persistedUsage }),
					});
					adoptMessages(responseKey, step.responseMessages);
				} else {
					appendMessages(responseKey, ...step.responseMessages);
					await persistence;
					await context.recordStep?.(stepKey, {
						eventKind: "completed",
						responseDigest,
						...(persistedUsage !== undefined && { usage: persistedUsage }),
					});
				}
				completedStepKeys.add(stepKey);
				if (step.usage) {
					args.onUsage?.(step.usage, {
						contextId: context.contextId ?? scopeKey,
						stepKey,
					});
				}
			}
			if (deadlineExceeded()) return exhausted("wall-clock");
			if (step.reasoningText) args.onReasoning?.(step.reasoningText);
			if (step.toolCalls.length === 0) {
				consecutiveEmptySteps += 1;
				if (consecutiveEmptySteps > 2) {
					return {
						kind: "protocol-failure",
						code: "no-tool-call",
						message:
							"The executor produced three consecutive responses without a tool call.",
					};
				}
				appendMessages(
					`step:${scopeKey}:${modelSteps}:empty`,
					userMessage(CONTINUE_NUDGE),
				);
				continue;
			}
			consecutiveEmptySteps = 0;

			let haltResponse = false;
			for (const [index, call] of step.toolCalls.entries()) {
				if (haltResponse) {
					await skipCalls(
						step.toolCalls,
						index,
						"A preceding call in this response failed or requested finalization.",
					);
					break;
				}
				args.onToolCall?.({
					modelStep: modelSteps,
					toolName: call.toolName,
					workspaceRevision: workspace.currentSnapshot().revision,
				});
				let dispatch: NativeCallDispatch = { kind: "continue" };

				const registryEntry = CHANGE_SET_TOOL_REGISTRY.get(call.toolName);
				if (registryEntry !== undefined) {
					const allowed =
						(registryEntry.policy.effect === "read-blueprint" &&
							allowedReadTools.has(call.toolName)) ||
						(registryEntry.policy.effect === "mutate-blueprint" &&
							allowedMutationTools.has(call.toolName));
					if (!allowed) {
						const error = `${call.toolName} is not available for this workflow slice.`;
						const failure = await observeNativeCallFailure({
							call,
							code: "TOOL_NOT_ALLOWED",
							error,
						});
						await emitOutcome(call, index, "wire-invalid", "TOOL_NOT_ALLOWED");
						await appendToolResult(
							call,
							failedToolResult({
								code: "TOOL_NOT_ALLOWED",
								error,
								repeatedFailure: failure.repeatedFailure,
							}),
						);
						dispatch =
							failure.observed.kind === "stop"
								? { kind: "stop", outcome: failure.observed.outcome }
								: { kind: "halt-response" };
					} else {
						if (registryEntry.policy.effect === "mutate-blueprint") {
							const claim = await claimBudget(
								"mutationCalls",
								allowedMutationCalls(),
								`mutation:${scopeKey}:${modelSteps}:${call.toolCallId}`,
							);
							if (claim === "exhausted") {
								await appendToolResult(
									call,
									failedToolResult({
										code: "MUTATION_BUDGET_EXHAUSTED",
										error:
											"This workflow exhausted its bounded private-mutation budget.",
									}),
								);
								dispatch = {
									kind: "stop",
									outcome: exhausted("mutation-calls"),
								};
							}
						}
						if (dispatch.kind === "continue") {
							const creationIssue =
								registryEntry.policy.effect === "mutate-blueprint"
									? (executorCreationHandleIssue(call.toolName, call.input) ??
										executorCatalogDefaultHandleIssue(
											call.toolName,
											call.input,
											workspace.currentSnapshot().doc,
										))
									: null;
							const compositionIssue =
								registryEntry.policy.effect === "mutate-blueprint"
									? compositionAdmissionIssue(
											call.toolName,
											call.input,
											brief,
											workspace,
										)
									: null;
							const admissionError = creationIssue ?? compositionIssue;
							const admissionCode =
								creationIssue !== null
									? "CREATION_HANDLE_REQUIRED"
									: compositionIssue !== null
										? "COMPOSITION_HOST_FORBIDDEN"
										: null;
							if (admissionError !== null && admissionCode !== null) {
								const failure = await observeNativeCallFailure({
									call,
									code: admissionCode,
									error: admissionError,
								});
								await emitOutcome(
									call,
									index,
									admissionCode === "CREATION_HANDLE_REQUIRED"
										? "wire-invalid"
										: "mutation-rejected",
									admissionCode,
								);
								await appendToolResult(
									call,
									failedToolResult({
										code: admissionCode,
										error: admissionError,
										repeatedFailure: failure.repeatedFailure,
									}),
								);
								dispatch =
									failure.observed.kind === "stop"
										? { kind: "stop", outcome: failure.observed.outcome }
										: { kind: "halt-response" };
							} else {
								try {
									const dispatched = await awaitWithAbort(
										workspace.stageDispatch({
											toolName: call.toolName,
											requestId: call.toolCallId,
											input: call.input,
											deadlineAt,
										}),
										boundedSignal,
									);
									const projected = projectToolResult(
										dispatched.result,
										workspace,
									);
									if (caseSelectionNeedsChanges(call.toolName, projected)) {
										clearFailureSequence();
										await emitOutcome(
											call,
											index,
											"non-applied",
											"CASE_SELECTION_NEEDS_CHANGES",
										);
										await appendToolResult(call, {
											...projected,
											status: "not-applied",
											code: "CASE_SELECTION_NEEDS_CHANGES",
										});
										dispatch = { kind: "halt-response" };
									} else if (resultHasError(projected)) {
										const code = toolFailureCode(dispatched.receipt, projected);
										const error = (projected as { error: string }).error;
										const failure = await observeNativeCallFailure({
											call,
											code,
											error,
										});
										await emitOutcome(
											call,
											index,
											registryEntry.policy.effect === "read-blueprint"
												? "operation-rejected"
												: "mutation-rejected",
											code,
										);
										await appendToolResult(
											call,
											failedToolResult({
												code,
												error,
												repeatedFailure: failure.repeatedFailure,
											}),
										);
										dispatch =
											failure.observed.kind === "stop"
												? { kind: "stop", outcome: failure.observed.outcome }
												: { kind: "halt-response" };
									} else {
										clearFailureSequence();
										await emitOutcome(
											call,
											index,
											"accepted",
											registryEntry.policy.effect === "read-blueprint"
												? "READ_COMPLETED"
												: "PRIVATE_MUTATION_APPLIED",
										);
										await appendToolResult(call, projected);
									}
								} catch (error) {
									if (deadlineExceeded()) {
										dispatch = {
											kind: "stop",
											outcome: exhausted("wall-clock"),
										};
									} else if (error instanceof ChangeSetStagingRejectedError) {
										const failure = await observeNativeCallFailure({
											call,
											code: error.code,
											error: error.message,
										});
										await emitOutcome(call, index, "wire-invalid", error.code);
										await appendToolResult(
											call,
											failedToolResult({
												code: error.code,
												error: error.message,
												repeatedFailure: failure.repeatedFailure,
											}),
										);
										dispatch =
											failure.observed.kind === "stop"
												? { kind: "stop", outcome: failure.observed.outcome }
												: { kind: "halt-response" };
									} else {
										const terminal = terminalProtocolCode(error);
										if (terminal === null) throw error;
										await emitOutcome(
											call,
											index,
											"terminal-protocol",
											terminal,
										);
										await appendToolResult(call, {
											status: "terminal",
											code: terminal,
											error: (error as Error).message,
										});
										dispatch = {
											kind: "stop",
											outcome: {
												kind: "protocol-failure",
												code: terminal,
												message: (error as Error).message,
											},
										};
									}
								}
							}
						}
					}
				} else if (call.toolName === FINISH_TOOL) {
					const parsed = noArgumentsSchema.safeParse(call.input);
					if (!parsed.success) {
						await emitOutcome(
							call,
							index,
							"wire-invalid",
							"TOOL_INPUT_INVALID",
						);
						await appendToolResult(
							call,
							failedToolResult({
								code: "TOOL_INPUT_INVALID",
								error: wireIssueSummary(parsed.error),
							}),
						);
						dispatch = { kind: "halt-response" };
					} else {
						args.onProgress?.("validating");
						const diagnostics = await awaitWithAbort(
							workspace.inspect(),
							boundedSignal,
						);
						const stale = staleExternalReads(diagnostics);
						const executionHandles =
							workspace.currentExecutionCheckpoint().handles;
						const requirementIssues = acceptedInputRequirementIssues(
							workspace.currentSnapshot().doc,
							brief,
							executionHandles,
						);
						const placementIssues = acceptedModulePlacementIssues(
							workspace.currentSnapshot().doc,
							brief,
							executionHandles,
						);
						const selectionIssues = acceptedSelectionRealizationIssues(
							workspace.currentSnapshot().doc,
							brief,
							executionHandles,
						);
						const acceptedIssues = [
							...requirementIssues,
							...placementIssues,
							...selectionIssues,
						];
						if (stale.length > 0) {
							await emitOutcome(
								call,
								index,
								"finalization-rejected",
								"READ_SET_STALE",
							);
							await appendToolResult(call, {
								status: "terminal",
								code: "READ_SET_STALE",
								error: "The workflow's external read set is stale.",
								stale,
							});
							dispatch = {
								kind: "stop",
								outcome: { kind: "read-set-stale", stale },
							};
						} else if (!diagnostics.canCommit || acceptedIssues.length > 0) {
							const projected = projectDiagnostics(
								diagnostics,
								brief,
								acceptedIssues,
							);
							const observed = await observeSemanticFailure({
								signature: failureSignature({
									kind: "workflow-needs-correction",
									fingerprints: diagnostics.allFindings
										.map(findingFingerprint)
										.concat(
											acceptedIssues.map((issue) => canonicalJsonDigest(issue)),
										)
										.sort(),
									canCommit:
										diagnostics.canCommit && acceptedIssues.length === 0,
								}),
								observations:
									diagnostics.allFindings.length > 0 ||
									acceptedIssues.length > 0
										? [
												...acceptedIssues.map(
													(issue) => `${issue.code}: ${issue.message}`,
												),
												...diagnostics.allFindings.map(
													(finding) => `${finding.code}: ${finding.message}`,
												),
											].slice(0, 12)
										: [describeBlockers(diagnostics)],
								diagnostics: projected,
							});
							await emitOutcome(
								call,
								index,
								"validator-repair",
								"WORKFLOW_NEEDS_CORRECTION",
							);
							await appendToolResult(call, {
								status: "needs-correction",
								code: "WORKFLOW_NEEDS_CORRECTION",
								diagnostics: projected,
								...(observed.kind === "observed" && {
									repeatedFailure: {
										fingerprint: observed.signature,
										occurrence: observed.occurrence,
										...(observed.guidance !== undefined && {
											architectGuidance: observed.guidance,
										}),
									},
								}),
							});
							dispatch =
								observed.kind === "stop"
									? { kind: "stop", outcome: observed.outcome }
									: { kind: "halt-response" };
						} else if (
							(await claimBudget(
								"commitAttempts",
								budget.maxCommitAttempts,
								`finish:${scopeKey}:${modelSteps}:${call.toolCallId}`,
							)) === "exhausted"
						) {
							await appendToolResult(
								call,
								failedToolResult({
									code: "COMMIT_BUDGET_EXHAUSTED",
									error: "This workflow exhausted its bounded commit budget.",
								}),
							);
							dispatch = {
								kind: "stop",
								outcome: exhausted("commit-attempts"),
							};
						} else {
							args.onProgress?.("committing");
							let result: SliceCommitResult;
							try {
								/* The commit converts its deadline into the transaction's
								 * PostgreSQL timeout while holding the app row lock, so it
								 * gets the nearer of executor authority expiry and one
								 * bounded window — a canonical commit finishes in seconds,
								 * and a wedged one must not hold the app for the long
								 * wall-clock budget a ceiling-range slice carries. */
								result = await awaitWithAbort(
									args.commit(
										boundedSignal,
										Math.min(
											deadlineAt,
											Date.now() + MAX_COMMIT_TRANSACTION_WINDOW_MS,
										),
									),
									boundedSignal,
								);
							} catch (error) {
								if (!deadlineExceeded()) throw error;
								const reconciled = await args.reconcileCommit?.();
								if (reconciled?.kind !== "committed") {
									dispatch = { kind: "stop", outcome: exhausted("wall-clock") };
									result = { kind: "gate-rejected", message: "deadline" };
								} else {
									result = reconciled;
								}
							}
							if (dispatch.kind === "continue") {
								if (result.kind === "committed") {
									clearFailureSequence();
									await emitOutcome(
										call,
										index,
										"committed",
										"WORKFLOW_COMMITTED",
									);
									await appendToolResult(call, {
										status: "committed",
										code: "WORKFLOW_COMMITTED",
										receipt: result.receipt,
									});
									dispatch = {
										kind: "stop",
										outcome: {
											kind: "committed",
											receipt: result.receipt,
										},
									};
								} else if (result.kind === "rebase-conflict") {
									await emitOutcome(
										call,
										index,
										"finalization-rejected",
										"REBASE_CONFLICT",
									);
									await appendToolResult(call, {
										status: "terminal",
										code: "REBASE_CONFLICT",
										report: result.report,
									});
									dispatch = {
										kind: "stop",
										outcome: {
											kind: "rebase-conflict",
											report: result.report,
										},
									};
								} else if (result.kind === "read-set-stale") {
									await emitOutcome(
										call,
										index,
										"finalization-rejected",
										"READ_SET_STALE",
									);
									await appendToolResult(call, {
										status: "terminal",
										code: "READ_SET_STALE",
										stale: result.stale,
									});
									dispatch = {
										kind: "stop",
										outcome: {
											kind: "read-set-stale",
											stale: result.stale,
										},
									};
								} else {
									const observed = await observeSemanticFailure({
										signature: failureSignature({
											kind: "canonical-gate-rejection",
											message: normalizedFailureText(result.message),
										}),
										observations: [result.message],
									});
									await emitOutcome(
										call,
										index,
										"validator-repair",
										"CANONICAL_GATE_REJECTED",
									);
									await appendToolResult(call, {
										status: "needs-correction",
										code: "CANONICAL_GATE_REJECTED",
										error: result.message,
										...(observed.kind === "observed" && {
											repeatedFailure: {
												fingerprint: observed.signature,
												occurrence: observed.occurrence,
												...(observed.guidance !== undefined && {
													architectGuidance: observed.guidance,
												}),
											},
										}),
									});
									dispatch =
										observed.kind === "stop"
											? { kind: "stop", outcome: observed.outcome }
											: { kind: "halt-response" };
								}
							}
						}
					}
				} else if (call.toolName === REPORT_BLOCKER_TOOL) {
					const parsed = executionBlockerSchema.safeParse(call.input);
					if (!parsed.success) {
						await emitOutcome(
							call,
							index,
							"wire-invalid",
							"TOOL_INPUT_INVALID",
						);
						await appendToolResult(
							call,
							failedToolResult({
								code: "TOOL_INPUT_INVALID",
								error: wireIssueSummary(parsed.error),
							}),
						);
						dispatch = { kind: "halt-response" };
					} else if (args.resolveBlocker === undefined) {
						dispatch = {
							kind: "stop",
							outcome: {
								kind: "protocol-failure",
								code: "architect-resolver-unavailable",
								message: "The server-owned architect resolver is unavailable.",
							},
						};
					} else {
						const claim = await claimBudget(
							"blockerReports",
							budget.maxBlockerResolutions,
							`blocker:${scopeKey}:${modelSteps}:${call.toolCallId}`,
						);
						if (claim !== "claimed") {
							dispatch = {
								kind: "stop",
								outcome: {
									kind: "protocol-failure",
									code:
										claim === "replayed"
											? "architect-decision-response-lost"
											: "blocker-resolution-budget-exhausted",
									message:
										"The bounded architect-resolution request could not run.",
								},
							};
						} else {
							deadlineAt += BLOCKER_RESOLUTION_ALLOWANCE.ms;
							armDeadlineTimer();
							const decision = await awaitWithAbort(
								args.resolveBlocker({
									blocker: parsed.data,
									brief,
									diagnostics: projectDiagnostics(
										await awaitWithAbort(workspace.inspect(), boundedSignal),
										brief,
									),
									signal: boundedSignal,
								}),
								boundedSignal,
							);
							await emitOutcome(call, index, "accepted", "ARCHITECT_DECISION");
							await appendToolResult(call, {
								status:
									decision.kind === "continue"
										? "needs-correction"
										: "terminal",
								decision,
							});
							dispatch =
								decision.kind === "continue"
									? { kind: "halt-response" }
									: {
											kind: "stop",
											outcome: { kind: "architect-decision", decision },
										};
						}
					}
				} else {
					await emitOutcome(call, index, "wire-invalid", "UNKNOWN_TOOL");
					await appendToolResult(
						call,
						failedToolResult({
							code: "UNKNOWN_TOOL",
							error: `There is no tool named ${call.toolName}.`,
						}),
					);
					dispatch = { kind: "halt-response" };
				}

				if (dispatch.kind === "halt-response") haltResponse = true;
				if (dispatch.kind === "stop") {
					await skipCalls(
						step.toolCalls,
						index + 1,
						"A preceding call ended this workflow attempt.",
					);
					return dispatch.outcome;
				}
			}
		}
	} finally {
		await persistence;
		if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
	}
}

function rawObject(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function resolveCheckpointIdentity(
	value: unknown,
	workspace: ExecutorWorkspace,
): string | null {
	if (typeof value === "string") return value;
	const object = rawObject(value);
	if (object === null || typeof object.handle !== "string") return null;
	return (
		workspace
			.currentExecutionCheckpoint()
			.handles.find((binding) => binding.handle === object.handle)?.uuid ?? null
	);
}

function rawCheckpointHandle(value: unknown): string | null {
	const object = rawObject(value);
	return object !== null &&
		Object.keys(object).length === 1 &&
		typeof object.handle === "string"
		? object.handle
		: null;
}

function inputSelectionMatches(
	value: unknown,
	expected: { readonly kind: "multiple"; readonly maximum: number } | null,
): boolean {
	if (expected === null) return value == null;
	const selection = rawObject(value);
	return (
		selection?.kind === "multiple" && selection.maximum === expected.maximum
	);
}

/** Critical architecture admission derived from the accepted composition.
 * This is intentionally narrower than a second Blueprint validity gate: it
 * prevents invented module homes and wrong form host/mode choices while the
 * final candidate remains free to realize fields, groups, prose, and layout
 * through the ordinary canonical tools. */
export function compositionAdmissionIssue(
	toolName: string,
	input: unknown,
	brief: SliceExecutionBrief,
	workspace: ExecutorWorkspace,
): string | null {
	const object = rawObject(input);
	if (object === null) return null;
	const snapshot = workspace.currentSnapshot().doc;
	const executionHandles = workspace.currentExecutionCheckpoint().handles;
	if (toolName === "generateSchema") {
		const caseTypes = Array.isArray(object.caseTypes) ? object.caseTypes : [];
		const expectedByKey = new Map(
			brief.recordRealizations.map((record) => [
				record.blueprintCaseType,
				record,
			]),
		);
		for (const caseType of caseTypes) {
			const candidate = rawObject(caseType);
			if (candidate === null || typeof candidate.name !== "string") continue;
			if (!expectedByKey.has(candidate.name)) {
				return `Record case-type names are deterministic compiler keys, not display names. Use the exact accepted lowering: ${brief.recordRealizations.map((record) => `${record.displayName} -> ${record.blueprintCaseType}`).join(", ")}.`;
			}
			const expectedParent = expectedByKey.get(
				candidate.name,
			)?.parentBlueprintCaseType;
			const suppliedParent =
				candidate.parent_type === null ? undefined : candidate.parent_type;
			if (suppliedParent !== expectedParent) {
				return `Record parent_type must use the exact accepted Blueprint key${expectedParent === undefined ? " and this record has no accepted parent" : ` ${expectedParent}`}.`;
			}
		}
		return null;
	}
	if (toolName === "configureCaseSelection") {
		const requestedModuleUuid = resolveCheckpointIdentity(
			object.moduleUuid,
			workspace,
		);
		const realization = brief.moduleRealizations.find(
			(entry) =>
				entry.selectionRealization?.action === "configure-after-forms" &&
				realizedModuleUuid(
					snapshot,
					brief,
					entry.compositionId,
					executionHandles,
				) === requestedModuleUuid,
		);
		if (realization?.selectionRealization === undefined) {
			return "configureCaseSelection may target only the exact module whose selectionRealization is configure-after-forms in this execution brief.";
		}
		const expectedSelection = realization.selectionRealization.selection;
		if (!inputSelectionMatches(object.selection, expectedSelection)) {
			return `configureCaseSelection must use the exact accepted selectionRealization for module composition ${realization.compositionId}: ${JSON.stringify(expectedSelection)}.`;
		}
		const confirmed = Array.isArray(object.confirmedModuleUuids)
			? object.confirmedModuleUuids
			: [];
		for (const confirmedIdentity of confirmed) {
			const confirmedModuleUuid = resolveCheckpointIdentity(
				confirmedIdentity,
				workspace,
			);
			const acceptedLinkedTransition = brief.moduleRealizations.some(
				(entry) =>
					entry.selectionRealization !== undefined &&
					inputSelectionMatches(
						entry.selectionRealization.selection,
						expectedSelection,
					) &&
					realizedModuleUuid(
						snapshot,
						brief,
						entry.compositionId,
						executionHandles,
					) === confirmedModuleUuid,
			);
			if (!acceptedLinkedTransition) {
				return "Every confirmed case-selection transition must resolve to a module realization with the same exact accepted selection in this execution brief.";
			}
		}
		return null;
	}
	const createModule = toolName === "createModule";
	if (createModule) {
		const caseType =
			typeof object.case_type === "string" ? object.case_type : null;
		const name = typeof object.name === "string" ? object.name : null;
		const candidates = brief.moduleRealizations.filter(
			(realization) => realization.action === "create",
		);
		const declaredModuleHandle = rawCheckpointHandle(object.moduleUuid);
		const realization = candidates.find(
			(entry) =>
				entry.blueprintModuleHandle === declaredModuleHandle &&
				(entry.hostRecord?.blueprintCaseType ?? null) === caseType &&
				brief.moduleCompositions.find(
					(composition) => composition.id === entry.compositionId,
				)?.name === name,
		);
		if (realization === undefined) {
			return "This slice may create only the exact accepted module composition, using its blueprintModuleHandle as moduleUuid together with its accepted display name and record host. Reuse an earlier composed module when the brief says reuse; do not create a parallel record home.";
		}
		const creationSelection =
			realization.selectionRealization?.action === "create-with-module"
				? realization.selectionRealization.selection
				: null;
		if (!inputSelectionMatches(object.selection, creationSelection)) {
			return creationSelection === null
				? "This accepted module creation has no create-with-module selectionRealization. Omit selection or pass null instead of inventing several-case behavior."
				: `createModule must use the exact accepted create-with-module selectionRealization for module composition ${realization.compositionId}: ${JSON.stringify(creationSelection)}.`;
		}
		const expectedParentUuid =
			realization.parentModuleCompositionId === null
				? null
				: realizedModuleUuid(
						snapshot,
						brief,
						realization.parentModuleCompositionId,
						executionHandles,
					);
		const suppliedParentUuid =
			object.parentModuleUuid === undefined
				? null
				: resolveCheckpointIdentity(object.parentModuleUuid, workspace);
		const bootstrappingUnresolvedParent =
			realization.parentModuleCompositionId !== null &&
			expectedParentUuid === null &&
			suppliedParentUuid === null;
		if (
			!bootstrappingUnresolvedParent &&
			((realization.parentModuleCompositionId !== null &&
				expectedParentUuid === null) ||
				suppliedParentUuid !== expectedParentUuid)
		) {
			return "Create this module in the exact accepted parent menu. Omit parentModuleUuid only for a top-level composition; otherwise reference the parent module realization from the brief.";
		}
		if (toolName === "createModule") {
			const forms = Array.isArray(object.forms) ? object.forms : [];
			if (
				realization.role === "queue-only" &&
				(object.case_list_only !== true || forms.length > 0)
			) {
				return "The accepted module is queue-only. Create it as a case-list-only module with no forms.";
			}
			for (const form of forms) {
				const nested = rawObject(form);
				if (nested === null) continue;
				const expected = brief.formRealizations.find(
					(entry) =>
						entry.moduleCompositionId === realization.compositionId &&
						entry.name === nested.name &&
						entry.blueprintFormType === nested.type,
				);
				if (expected === undefined) {
					return "A form nested in this module does not match an accepted form name, mode, and module composition for this workflow slice.";
				}
			}
		}
		return null;
	}

	if (toolName === "moveModule") {
		const moduleUuid = resolveCheckpointIdentity(object.moduleUuid, workspace);
		const module =
			moduleUuid === null ? undefined : snapshot.modules[moduleUuid];
		if (module === undefined) return null;
		const realization = brief.moduleRealizations.find(
			(entry) =>
				realizedModuleUuid(
					snapshot,
					brief,
					entry.compositionId,
					executionHandles,
				) === moduleUuid,
		);
		if (realization === undefined) {
			return "This slice may move only a module represented by its accepted module composition.";
		}
		const expectedParentUuid =
			realization.parentModuleCompositionId === null
				? null
				: realizedModuleUuid(
						snapshot,
						brief,
						realization.parentModuleCompositionId,
						executionHandles,
					);
		const expectedAfterUuid =
			realization.afterSiblingModuleCompositionId === null
				? null
				: realizedModuleUuid(
						snapshot,
						brief,
						realization.afterSiblingModuleCompositionId,
						executionHandles,
					);
		const requestedParentUuid =
			object.parentModuleUuid === undefined
				? (module.parentModuleUuid ?? null)
				: resolveCheckpointIdentity(object.parentModuleUuid, workspace);
		const requestedAfterUuid = resolveCheckpointIdentity(
			object.after,
			workspace,
		);
		if (
			(realization.parentModuleCompositionId !== null &&
				expectedParentUuid === null) ||
			(realization.afterSiblingModuleCompositionId !== null &&
				expectedAfterUuid === null) ||
			requestedParentUuid !== expectedParentUuid ||
			requestedAfterUuid !== expectedAfterUuid
		) {
			return "Move this module only to the exact accepted parent and preceding sibling in the execution brief. Omit parentModuleUuid only for an in-menu reorder; pass null to make it top-level.";
		}
		return null;
	}

	if (toolName === "createForm") {
		const moduleUuid = resolveCheckpointIdentity(object.moduleUuid, workspace);
		const module =
			moduleUuid === null ? undefined : snapshot.modules[moduleUuid];
		const expected = brief.formRealizations.find(
			(entry) =>
				entry.blueprintFormType === object.type &&
				entry.name === object.name &&
				realizedModuleUuid(
					snapshot,
					brief,
					entry.moduleCompositionId,
					executionHandles,
				) === moduleUuid,
		);
		const moduleComposition =
			expected === undefined
				? undefined
				: brief.moduleCompositions.find(
						(entry) => entry.id === expected.moduleCompositionId,
					);
		const host =
			expected === undefined
				? undefined
				: brief.moduleRealizations.find(
						(entry) => entry.compositionId === expected.moduleCompositionId,
					)?.hostRecord;
		if (module === undefined) return null;
		if (
			expected === undefined ||
			moduleComposition === undefined ||
			(module.caseType ?? null) !== (host?.blueprintCaseType ?? null)
		) {
			return "This form must use the exact accepted form mode and the accepted module's record host. Do not put a selected-record workflow on a child/outcome record merely because the workflow writes that record.";
		}
		return null;
	}

	if (toolName === "updateModule" && object.case_type !== undefined) {
		const moduleUuid = resolveCheckpointIdentity(object.moduleUuid, workspace);
		const realization = brief.moduleRealizations.find(
			(entry) =>
				realizedModuleUuid(
					snapshot,
					brief,
					entry.compositionId,
					executionHandles,
				) === moduleUuid,
		);
		const host = realization?.hostRecord;
		const requested =
			typeof object.case_type === "string" ? object.case_type : null;
		if (
			realization === undefined ||
			requested !== (host?.blueprintCaseType ?? null)
		) {
			return "A module update may not move this accepted composition to a different record host.";
		}
	}
	return null;
}

/** Bound an awaited operation even when its implementation fails to observe
 * the supplied signal. Production canonical commits additionally install a
 * database transaction timeout before this race, so timeout cannot leave a
 * detached canonical write running toward commit. */
function awaitWithAbort<T>(
	promise: Promise<T>,
	signal: AbortSignal,
): Promise<T> {
	if (signal.aborted) return Promise.reject(signal.reason);
	return new Promise<T>((resolve, reject) => {
		const abort = () => reject(signal.reason);
		signal.addEventListener("abort", abort, { once: true });
		promise.then(resolve, reject).finally(() => {
			signal.removeEventListener("abort", abort);
		});
	});
}

/** The terminal change-set errors, mapped to their stable observability codes.
 *  Anything else is not a protocol failure and belongs to the caller. */
function terminalProtocolCode(error: unknown): string | null {
	if (error instanceof ChangeSetWorkspaceRevisionStaleError) return error.code;
	if (error instanceof ChangeSetRequestIdCollisionError) return error.code;
	if (error instanceof ChangeSetScopeLostError) return error.code;
	if (error instanceof ChangeSetIntegrityError) return error.code;
	return null;
}

/** Bounded diagnostics for the model: enough findings to act on, never the
 *  whole validator dump. */
function projectDiagnostics(
	diagnostics: Awaited<ReturnType<ExecutorWorkspace["inspect"]>>,
	brief: SliceExecutionBrief,
	acceptedRequirementIssues: readonly (
		| AcceptedInputRequirementIssue
		| AcceptedModulePlacementIssue
		| AcceptedSelectionRealizationIssue
	)[] = [],
): unknown {
	const MAX_REPORTED_FINDINGS = 20;
	const initialResultsRealizations = brief.moduleRealizations.filter(
		(realization) =>
			realization.action === "create" &&
			realization.requiredInitialResultsColumn !== undefined,
	);
	const moduleCompositionById = new Map(
		brief.moduleCompositions.map((composition) => [
			composition.id,
			composition,
		]),
	);
	const validatorFindings = diagnostics.allFindings.map((finding) => {
		const matchingRealizations = initialResultsRealizations.filter(
			(realization) =>
				finding.location.moduleName === undefined ||
				moduleCompositionById.get(realization.compositionId)?.name ===
					finding.location.moduleName,
		);
		const initialResultsColumn =
			matchingRealizations.length === 1
				? matchingRealizations[0]?.requiredInitialResultsColumn
				: undefined;
		const missingResultsCorrection =
			initialResultsColumn === undefined
				? undefined
				: brief.toolProfile.mutationTools.includes("addCaseListColumns")
					? `Call addCaseListColumns for the located module with columns: [${JSON.stringify(initialResultsColumn)}]. Results columns configure the module case list, never addFields.`
					: brief.toolProfile.mutationTools.includes("updateModule")
						? `Call updateModule for the located module with its current case_type and case_list_columns: [${JSON.stringify(initialResultsColumn)}]. Results columns configure the module case list, never addFields.`
						: `Re-issue createModule with case_list_columns: [${JSON.stringify(initialResultsColumn)}]. Results columns configure the module case list, never addFields.`;
		return {
			code: finding.code,
			message: finding.message,
			/* Coordinates and structured details are what distinguish several
			 * instances of the same validator code. They stay inside the private
			 * executor context; stripping them made the worker guess which carrier
			 * to repair and turn a local correction into a false design blocker. */
			location: finding.location,
			details: finding.details,
			...(finding.code === "MISSING_CASE_LIST_COLUMNS" &&
				missingResultsCorrection !== undefined && {
					correction: missingResultsCorrection,
				}),
		};
	});
	const allFindings = [...acceptedRequirementIssues, ...validatorFindings];
	return {
		revision: diagnostics.snapshotRevision,
		findingCount: allFindings.length,
		findings: allFindings.slice(0, MAX_REPORTED_FINDINGS),
		...(allFindings.length > MAX_REPORTED_FINDINGS && {
			truncated: {
				shown: MAX_REPORTED_FINDINGS,
				total: allFindings.length,
			},
		}),
		introducedSincePreviousStep: diagnostics.introducedSincePreviousStep,
		resolvedSincePreviousStep: diagnostics.resolvedSincePreviousStep,
		readSetStatus: diagnostics.readSetStatus.map((status) => ({
			kind: status.dependency.kind,
			state: status.state,
		})),
		canCommit: diagnostics.canCommit && acceptedRequirementIssues.length === 0,
	};
}

function describeBlockers(
	diagnostics: Awaited<ReturnType<ExecutorWorkspace["inspect"]>>,
): string {
	const codes = [
		...new Set(diagnostics.allFindings.map((finding) => finding.code)),
	];
	if (codes.length > 0) return codes.join(", ");
	const stale = diagnostics.readSetStatus.filter(
		(status) => status.state !== "current",
	);
	if (stale.length > 0) {
		return `external data it read is ${[...new Set(stale.map((status) => status.state))].join(" and ")}`;
	}
	return diagnostics.snapshotRevision === 0
		? "it holds no private mutation steps yet"
		: `its ${diagnostics.snapshotRevision} private mutation step${diagnostics.snapshotRevision === 1 ? "" : "s"} did not satisfy the final gate, but no specific finding was reported`;
}

function staleExternalReads(
	diagnostics: Awaited<ReturnType<ExecutorWorkspace["inspect"]>>,
) {
	return diagnostics.readSetStatus.filter(
		(status) => status.state !== "current",
	);
}
