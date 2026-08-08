/**
 * The slice executor loop (the plan's §13.5–§13.9) — the bounded, server-owned
 * machine that turns one accepted Build Slice into one committed canonical
 * revision.
 *
 * Three properties are the whole point:
 *
 *  1. **One executable call per step.** Provider-side parallel tool calls are
 *     off, and the loop independently refuses a step carrying more than one
 *     call — it executes NONE of them and answers each with a deterministic
 *     protocol result. Ordering inside a private change set is the
 *     correctness spine; it is not left to the SDK's dispatch behavior.
 *  2. **The model never holds authority.** `commitChangeSet` is a REQUEST:
 *     the loop re-runs the real diagnostics and only then calls the
 *     server-owned commit. A model assertion that the work is done proves
 *     nothing.
 *  3. **Every axis is bounded.** Model steps, staged requests, commit and
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
	generateText,
	jsonSchema,
	type LanguageModel,
	type LanguageModelUsage,
	type ModelMessage,
	stepCountIs,
	tool,
} from "ai";
import { z } from "zod";
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
import type { AppMaterializationReceipt } from "@/lib/db/appGenesis";
import { type ReasoningEffort, reasoningProviderOptions } from "@/lib/models";
import type { SliceExecutionBudget } from "./budgets";
import { renderBriefMessage, type SliceExecutionBrief } from "./executionBrief";
import { EXECUTOR_SYSTEM } from "./executorPrompt";
import { executorWireToolSchema } from "./executorWireSchemas";
import {
	type DesignExecutionIssue,
	designExecutionIssueSchema,
} from "./issueEscalation";

/**
 * The workspace surface the loop uses. Structurally the change-set workspace
 * (which satisfies it) — narrowed so the loop depends on exactly the three
 * operations it performs, and so a test can drive it without a database.
 */
export type ExecutorWorkspace = Pick<
	ChangeSetMutationWorkspace,
	"stageDispatch" | "inspect" | "currentSnapshot"
>;

/** One model step: the messages in, the model's tool calls and text out. The
 *  loop supplies no `execute`; dispatch is the loop's own job. */
export type ExecutorStepFn = (args: {
	system: string;
	messages: ModelMessage[];
	tools: Record<string, { description: string; inputSchema: JSONSchema7 }>;
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

/** What the server-owned commit answered. `committed` is terminal; the other
 *  three are reports the executor may correct against. */
export type SliceCommitResult =
	| {
			kind: "committed";
			receipt: CommittedSliceReceipt | AppMaterializationReceipt;
	  }
	| { kind: "gate-rejected"; message: string }
	| { kind: "rebase-conflict"; report: unknown }
	| { kind: "read-set-stale"; stale: unknown };

export type SliceExecutionOutcome =
	| {
			kind: "committed";
			receipt: CommittedSliceReceipt | AppMaterializationReceipt;
	  }
	| { kind: "design-issue"; issue: DesignExecutionIssue }
	| {
			kind: "budget-exhausted";
			spent: { modelSteps: number; stagedRequests: number };
	  }
	| { kind: "protocol-failure"; code: string; message: string };

// ── The mounted tool surface ─────────────────────────────────────────

const INSPECT_TOOL = "inspectChangeSet";
const COMMIT_TOOL = "commitChangeSet";
const RAISE_ISSUE_TOOL = "raiseDesignExecutionIssue";

const noArgumentsSchema = z.object({}).strict();

/** The three server-owned tools, mounted beside the staged registry. */
const SERVER_TOOLS: Readonly<
	Record<string, { description: string; schema: z.ZodType }>
> = {
	[INSPECT_TOOL]: {
		description:
			"Run the real validator over the private candidate and report every current finding, what the last steps introduced or resolved, whether external data the change set read is still current, and whether it can commit.",
		schema: noArgumentsSchema,
	},
	[COMMIT_TOOL]: {
		description:
			"Request that this change set commit as one canonical revision. The server independently re-proves the diagnostics and the design digests; if anything blocks the commit you get back what it was.",
		schema: noArgumentsSchema,
	},
	[RAISE_ISSUE_TOOL]: {
		description:
			"Report that the accepted slice cannot be implemented as designed, and end work on it. Name the affected design intents, explain specifically what blocks the implementation, and offer at most three options. Use this instead of choosing a different architecture yourself.",
		schema: designExecutionIssueSchema,
	},
};

/** The complete mounted tool definitions, built once — every stageable
 *  change-set tool plus the three server-owned ones. */
function buildExecutorTools(): Record<
	string,
	{ description: string; inputSchema: JSONSchema7 }
> {
	const tools: Record<
		string,
		{ description: string; inputSchema: JSONSchema7 }
	> = {};
	for (const [name, entry] of CHANGE_SET_TOOL_REGISTRY) {
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

let cachedTools: Record<
	string,
	{ description: string; inputSchema: JSONSchema7 }
> | null = null;

function executorTools() {
	cachedTools ??= buildExecutorTools();
	return cachedTools;
}

// ── The production step ──────────────────────────────────────────────

/**
 * The real model call behind one executor step: one generation, tools mounted
 * with NO `execute` (the loop dispatches), and provider-side parallel tool
 * calls turned off so the one-call law is enforced at the wire as well as in
 * the loop.
 *
 * `strict: false` matches every other Nova tool surface — under Responses
 * strict-mode normalization the model cannot omit an inapplicable slot and
 * invents filler for it; SDK-side Zod validation is the real gate.
 */
export function productionExecutorStep(
	model: LanguageModel,
	reasoningEffort: ReasoningEffort = "high",
): ExecutorStepFn {
	return async ({ system, messages, tools: definitions, signal }) => {
		const base = reasoningProviderOptions(reasoningEffort);
		const result = await generateText({
			model,
			system,
			messages,
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
					parallelToolCalls: false,
				} satisfies OpenAIResponsesProviderOptions,
			},
		});
		return {
			toolCalls: result.toolCalls.map((call) => ({
				toolCallId: call.toolCallId,
				toolName: call.toolName,
				input: call.input,
			})),
			text: result.text,
			...(result.reasoningText && { reasoningText: result.reasoningText }),
			usage: result.usage,
			responseMessages: result.responseMessages,
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

/**
 * Unwrap a shared-tool envelope to the payload the model should read — the
 * same projection chat and MCP perform. `summary` is UI-only presentation and
 * never reaches a model.
 */
function projectToolResult(value: unknown): unknown {
	if (value === null || typeof value !== "object") return value;
	const envelope = value as {
		kind?: unknown;
		result?: unknown;
		data?: unknown;
	};
	if (envelope.kind === "read") return envelope.data;
	if (envelope.kind !== "mutate") return value;
	const inner = envelope.result;
	if (inner === null || typeof inner !== "object") return inner;
	const { summary: _summary, ...rest } = inner as Record<string, unknown>;
	return rest;
}

const ONE_CALL_PROTOCOL_RESULT = {
	error:
		"One executable call per step; nothing was executed. Re-send exactly one call.",
} as const;

const CONTINUE_NUDGE =
	"Continue with exactly one tool call; when the slice is complete and inspectChangeSet reports no findings, call commitChangeSet.";

/** A cheap current-state line beside the brief: what the private candidate
 *  already holds, so the executor never re-creates a structure a recovered
 *  change set already staged. */
function workspaceSummary(workspace: ExecutorWorkspace): string {
	const snapshot = workspace.currentSnapshot();
	const moduleCount = snapshot.doc.moduleOrder.length;
	const formCount = Object.keys(snapshot.doc.forms).length;
	return [
		"## Current change set",
		`Revision ${snapshot.revision}. The private candidate holds ${moduleCount} module(s) and ${formCount} form(s).`,
		moduleCount === 0 && formCount === 0
			? "Nothing has been staged yet — this is the first step."
			: "Build on what is already staged; never re-create it.",
	].join("\n");
}

// ── The loop ─────────────────────────────────────────────────────────

export async function runSliceExecutor(args: {
	workspace: ExecutorWorkspace;
	brief: SliceExecutionBrief;
	budget: SliceExecutionBudget;
	step: ExecutorStepFn;
	/**
	 * Server-owned commit: the loop calls it only after `inspect()` shows
	 * `canCommit` (the model's `commitChangeSet` call is a REQUEST, never
	 * authority).
	 */
	commit: () => Promise<SliceCommitResult>;
	signal: AbortSignal;
	/** Coarse, user-safe notes only ("Checking the app for problems"). */
	onProgress?: (note: string) => void;
	/** Each step's display-safe reasoning summary → the run event log, so
	 *  the WHY behind an executor decision is readable beside its artifacts
	 *  (no design table gains a reasoning column). */
	onReasoning?: (text: string) => void;
}): Promise<SliceExecutionOutcome> {
	const { workspace, brief, budget, signal } = args;
	const tools = executorTools();
	const startedAt = Date.now();

	let modelSteps = 0;
	let stagedRequests = 0;
	let commitAttempts = 0;
	let rebaseAttempts = 0;
	let consecutiveEmptySteps = 0;

	const spent = () => ({ modelSteps, stagedRequests });
	const exhausted = (): SliceExecutionOutcome => ({
		kind: "budget-exhausted",
		spent: spent(),
	});

	let messages: ModelMessage[] = [
		userMessage(
			`${renderBriefMessage(brief)}\n\n---\n\n${workspaceSummary(workspace)}`,
		),
	];

	args.onProgress?.(`Building ${brief.slice.name}`);

	for (;;) {
		if (signal.aborted) {
			return {
				kind: "protocol-failure",
				code: "aborted",
				message: "This slice attempt was cancelled before it finished.",
			};
		}
		if (modelSteps >= budget.maxModelSteps) return exhausted();
		if (Date.now() - startedAt >= budget.maxWallClockMs) return exhausted();

		const step = await args.step({
			system: EXECUTOR_SYSTEM,
			messages,
			tools,
			signal,
		});
		modelSteps += 1;
		if (step.reasoningText) args.onReasoning?.(step.reasoningText);
		messages = [...messages, ...step.responseMessages];

		if (step.toolCalls.length === 0) {
			consecutiveEmptySteps += 1;
			if (consecutiveEmptySteps > 2) {
				return {
					kind: "protocol-failure",
					code: "no-tool-call",
					message:
						"The executor produced three consecutive steps with no tool call. Its work product is tool calls; prose cannot stage or commit anything.",
				};
			}
			messages = [...messages, userMessage(CONTINUE_NUDGE)];
			continue;
		}
		consecutiveEmptySteps = 0;

		if (step.toolCalls.length > 1) {
			/* §13.6.3: execute none, answer every call deterministically. */
			messages = [
				...messages,
				...step.toolCalls.map((call) =>
					toolMessage(call.toolCallId, call.toolName, ONE_CALL_PROTOCOL_RESULT),
				),
			];
			continue;
		}

		const call = step.toolCalls[0];
		if (call === undefined) continue;
		const answer = (value: unknown): void => {
			messages = [
				...messages,
				toolMessage(call.toolCallId, call.toolName, value),
			];
		};

		if (CHANGE_SET_TOOL_REGISTRY.has(call.toolName)) {
			stagedRequests += 1;
			if (stagedRequests > budget.maxStagedRequests) return exhausted();
			try {
				const dispatched = await workspace.stageDispatch({
					toolName: call.toolName,
					requestId: call.toolCallId,
					input: call.input,
				});
				answer(projectToolResult(dispatched.result));
			} catch (error) {
				if (error instanceof ChangeSetStagingRejectedError) {
					/* An ordinary refusal — the model self-corrects. */
					answer({ error: error.message });
					continue;
				}
				const terminal = terminalProtocolCode(error);
				if (terminal === null) throw error;
				return {
					kind: "protocol-failure",
					code: terminal,
					message: (error as Error).message,
				};
			}
			continue;
		}

		if (call.toolName === INSPECT_TOOL) {
			args.onProgress?.("Checking the app for problems");
			answer(projectDiagnostics(await workspace.inspect()));
			continue;
		}

		if (call.toolName === COMMIT_TOOL) {
			const diagnostics = await workspace.inspect();
			if (!diagnostics.canCommit) {
				/* A blocked request is not an attempt — nothing was tried. */
				answer({
					error: `The change set cannot commit yet: ${describeBlockers(diagnostics)}`,
				});
				continue;
			}
			commitAttempts += 1;
			if (commitAttempts > budget.maxCommitAttempts) return exhausted();
			args.onProgress?.(`Saving ${brief.slice.name}`);
			const result = await args.commit();
			if (result.kind === "committed") {
				return { kind: "committed", receipt: result.receipt };
			}
			if (result.kind === "gate-rejected") {
				answer({ error: result.message });
				continue;
			}
			if (result.kind === "rebase-conflict") {
				rebaseAttempts += 1;
				if (rebaseAttempts > budget.maxRebaseAttempts) return exhausted();
				answer({
					error:
						"The app changed underneath this change set, so the commit was replayed and conflicted. Read the report, correct the affected steps, and request the commit again.",
					report: result.report,
				});
				continue;
			}
			answer({
				error:
					"External data this change set read has changed since it was staged. Re-read what changed, correct the affected steps, and request the commit again.",
				stale: result.stale,
			});
			continue;
		}

		if (call.toolName === RAISE_ISSUE_TOOL) {
			const parsed = designExecutionIssueSchema.safeParse(call.input);
			if (!parsed.success) {
				answer({
					error: `That design issue could not be recorded: ${parsed.error.issues
						.map(
							(issue) =>
								`${issue.path.join(".") || "(root)"}: ${issue.message}`,
						)
						.join(
							"; ",
						)}. Re-send it with schemaVersion 1, a fresh id, one of the listed categories, at least one affected design intent id, an explanation, a local or architecture structural impact, and at most three proposed options.`,
				});
				continue;
			}
			/* An escalation ends the loop, so `maxDesignIssueEscalations` is an
			 * ACROSS-attempt budget the orchestrator enforces when it decides
			 * whether to resume this slice with a new brief. */
			return { kind: "design-issue", issue: parsed.data };
		}

		answer({
			error: `There is no tool named ${call.toolName}. The tools available are: ${Object.keys(tools).join(", ")}.`,
		});
	}
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
): unknown {
	const MAX_REPORTED_FINDINGS = 20;
	return {
		revision: diagnostics.snapshotRevision,
		findingCount: diagnostics.allFindings.length,
		findings: diagnostics.allFindings
			.slice(0, MAX_REPORTED_FINDINGS)
			.map((finding) => ({ code: finding.code, message: finding.message })),
		...(diagnostics.allFindings.length > MAX_REPORTED_FINDINGS && {
			truncated: {
				shown: MAX_REPORTED_FINDINGS,
				total: diagnostics.allFindings.length,
			},
		}),
		introducedSincePreviousStep: diagnostics.introducedSincePreviousStep,
		resolvedSincePreviousStep: diagnostics.resolvedSincePreviousStep,
		readSetStatus: diagnostics.readSetStatus.map((status) => ({
			kind: status.dependency.kind,
			state: status.state,
		})),
		canCommit: diagnostics.canCommit,
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
	return "it holds no staged steps yet";
}
