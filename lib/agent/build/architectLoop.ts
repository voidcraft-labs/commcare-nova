import "server-only";
import { asSchema, type ModelMessage, type ToolSet } from "ai";
import { durableModelValueDigest } from "@/lib/agent/modelMessagePersistence";
import {
	type AgentModelRequest,
	type AgentModelStep,
	AgentModelStepError,
	type AgentModelStepFn,
} from "@/lib/agent/modelStep";
import { canonicalJsonDigest } from "@/lib/utils/canonicalJson";
import {
	appendDesignModelContext,
	completeDesignModelStep,
	type DesignModelContextSpec,
	type DurableModelUsageIdentity,
	openDesignModelContext,
	recordDesignModelStepEvent,
	recoverableCompletedModelSteps,
} from "./modelContextStore";

export const ARCHITECT_MAX_STEPS = 120;
// Entry-to-next-task checks need several observations per journey. The first
// role-gated trial used 18 scoped reads and 22 journey calls before completing
// its first review. Retain a durable bound, with room to finish the evidence.
export const PEER_MAX_STEPS = 80;
export const TRANSLATOR_MAX_STEPS = 40;

export interface ArchitectToolCall {
	readonly toolCallId: string;
	readonly toolName: string;
	readonly input: unknown;
}

export type ArchitectToolOutcome =
	| { readonly kind: "result"; readonly output: unknown }
	| { readonly kind: "awaiting-input" };

/** Provider-managed calls already have their own results in the response. */
export function unansweredToolCalls(
	messages: readonly ModelMessage[],
): ArchitectToolCall[] {
	const calls = new Map<string, ArchitectToolCall>();
	const answered = new Set<string>();
	for (const message of messages) {
		if (message.role === "assistant" && Array.isArray(message.content)) {
			for (const part of message.content) {
				if (part.type !== "tool-call" || part.providerExecuted === true)
					continue;
				const call = {
					toolCallId: part.toolCallId,
					toolName: part.toolName,
					input: part.input,
				};
				const prior = calls.get(call.toolCallId);
				if (prior && canonicalJsonDigest(prior) !== canonicalJsonDigest(call))
					throw new Error(
						"A model response reused a tool call identity with different input.",
					);
				calls.set(call.toolCallId, call);
			}
		} else if (message.role === "tool") {
			for (const part of message.content)
				if (part.type === "tool-result") answered.add(part.toolCallId);
		}
	}
	return [...calls.values()].filter((call) => !answered.has(call.toolCallId));
}

function finalText(messages: readonly ModelMessage[]): string | null {
	const last = messages.at(-1);
	if (last?.role !== "assistant") return null;
	if (typeof last.content === "string") return last.content.trim() || null;
	if (
		last.content.some(
			(part) => part.type === "tool-call" && part.providerExecuted !== true,
		)
	)
		return null;
	return (
		last.content
			.filter((part) => part.type === "text")
			.map((part) => part.text)
			.join("\n")
			.trim() || null
	);
}

/** The complete declared definitions, including deferred tools. This is an
 * SDK schema projection for inspection and change detection, not a token bill. */
export async function describeModelTools(tools: ToolSet): Promise<unknown[]> {
	return Promise.all(
		Object.entries(tools).map(async ([name, definition]) => ({
			name,
			type: definition.type ?? "function",
			description: definition.description,
			inputSchema: await asSchema(definition.inputSchema).jsonSchema,
			strict: definition.strict,
			providerOptions: definition.providerOptions,
			...(definition.type === "provider" && {
				id: definition.id,
				args: definition.args,
			}),
		})),
	);
}

export interface ArchitectLoopArgs {
	readonly responseSchema?: AgentModelRequest["responseSchema"];
	readonly maxOutputTokens?: number;
	readonly spec: DesignModelContextSpec;
	readonly system: string;
	readonly turnId: string;
	readonly maxSteps: number;
	readonly signal: AbortSignal;
	readonly modelStep: AgentModelStepFn;
	/** On a process restart, answer outstanding calls before adding user input. */
	readonly additions: readonly { key: string; message: ModelMessage }[];
	/** Refresh recovery context once per run, after replaying outstanding effects. */
	currentState?(): Promise<ModelMessage>;
	tools(): ToolSet;
	dispatch(call: ArchitectToolCall): Promise<ArchitectToolOutcome>;
	onStep(
		step: AgentModelStep,
		identity: DurableModelUsageIdentity,
	): Promise<void>;
	onRecoveredUsage(
		usage: NonNullable<AgentModelStep["usage"]>,
		identity: DurableModelUsageIdentity,
	): void;
	onReasoning?(
		part: Parameters<NonNullable<AgentModelRequest["onReasoning"]>>[0],
		identity: DurableModelUsageIdentity,
	): void;
	onToolResult?(call: ArchitectToolCall, output: unknown): void;
	onFinish(
		text: string,
		context: { hasMessage(key: string): boolean },
	): Promise<
		| { kind: "complete" }
		| { kind: "awaiting-input" }
		| { kind: "continue"; message: string; key?: string }
	>;
}

/** One durable conversation for either the architect or one independent peer.
 * Responses and usage land together before any tool executes. Every effect
 * reuses its original call id on recovery; its owning transaction supplies the
 * exact receipt. No workflow graph or model-authored completion schema sits
 * between the conversation and those operations. */
export async function runArchitectLoop(args: ArchitectLoopArgs): Promise<{
	kind: "complete" | "awaiting-input";
	contextId: string;
	text: string;
}> {
	args.signal.throwIfAborted();
	const opened = await openDesignModelContext(args.spec);
	const messages = [...opened.messages];
	let revision = opened.revision;
	const keys = new Set(opened.appendKeys);
	const base = {
		designSessionId: args.spec.designSessionId,
		contextId: opened.id,
		authority: args.spec.authority,
	};
	for (const step of recoverableCompletedModelSteps(
		opened.completedSteps,
		args.spec.authority.runId,
	))
		args.onRecoveredUsage(step.usage, {
			contextId: step.contextId,
			stepKey: step.stepKey,
		});

	const append = async (appendKey: string, items: readonly ModelMessage[]) => {
		if (keys.has(appendKey)) return;
		revision = await appendDesignModelContext({
			...base,
			appendKey,
			messages: items,
		});
		messages.push(...items);
		keys.add(appendKey);
	};
	// A provider-contract change preserves the lead's previous conversation,
	// including unacknowledged effects. The peer carries only its own prior
	// investigation; a new review adds the current revisions and correction focus.
	if (!messages.length && opened.predecessorItems.length) {
		await append(
			"previous-conversation",
			opened.predecessorItems.map((item) => item.message),
		);
	}

	const dispatchOutstanding = async (): Promise<boolean> => {
		for (const call of unansweredToolCalls(messages)) {
			args.signal.throwIfAborted();
			const outcome = await args.dispatch(call);
			if (outcome.kind === "awaiting-input") return false;
			await append(`tool:${call.toolCallId}`, [
				{
					role: "tool",
					content: [
						{
							type: "tool-result",
							toolCallId: call.toolCallId,
							toolName: call.toolName,
							output: {
								type: "text",
								value: JSON.stringify(outcome.output) ?? "null",
							},
						},
					],
				},
			]);
			args.onToolResult?.(call, outcome.output);
		}
		return true;
	};
	if (!(await dispatchOutstanding()))
		return { contextId: opened.id, kind: "awaiting-input", text: "" };
	for (const addition of args.additions) {
		if (
			!(args.spec.kind !== "translator" ? opened.lineageAppendKeys : keys).has(
				addition.key,
			)
		)
			await append(addition.key, [addition.message]);
	}

	for (;;) {
		args.signal.throwIfAborted();
		const text = finalText(messages);
		if (text !== null) {
			const finish = await args.onFinish(text, {
				hasMessage: (key) => keys.has(key) || opened.lineageAppendKeys.has(key),
			});
			if (finish.kind !== "continue")
				return { contextId: opened.id, kind: finish.kind, text };
			await append(finish.key ?? `completion-feedback:${revision}`, [
				{ role: "user", content: finish.message },
			]);
		}
		const stateKey = `current-state:${args.spec.authority.runId}`;
		if (
			args.currentState &&
			!keys.has(stateKey) &&
			!opened.lineageAppendKeys.has(stateKey)
		)
			await append(stateKey, [await args.currentState()]);
		const tools = args.tools();
		const toolDefinitions = await describeModelTools(tools);
		// A repeated POST with the same holder cannot purchase the same missing
		// response twice. A newly claimed holder may retry an interrupted call;
		// every start still counts against this user turn's durable allowance.
		const stepKey = `${args.turnId}:${canonicalJsonDigest(args.spec.authority.holderNonce)}:${revision}`;
		const started = await recordDesignModelStepEvent({
			...base,
			stepKey,
			event: {
				eventKind: "started",
				turnProvenanceId: args.turnId,
				requestDigest: durableModelValueDigest({
					system: args.system,
					messages,
					tools: toolDefinitions,
					...(args.responseSchema && {
						responseSchema: args.responseSchema.jsonSchema,
					}),
					...(args.maxOutputTokens && {
						maxOutputTokens: args.maxOutputTokens,
					}),
				}),
			},
			turnBudget: { limit: args.maxSteps },
		});
		if (!started)
			throw new Error(
				"This model step has already started. Its response is not yet available.",
			);
		let step: AgentModelStep;
		try {
			step = await args.modelStep({
				system: args.system,
				messages,
				tools,
				responseSchema: args.responseSchema,
				maxOutputTokens: args.maxOutputTokens,
				signal: args.signal,
				onReasoning: (part) =>
					args.onReasoning?.(part, { contextId: opened.id, stepKey }),
			});
		} catch (error) {
			if (error instanceof AgentModelStepError && error.usage !== undefined) {
				await completeDesignModelStep({
					...base,
					appendKey: `response:${stepKey}`,
					stepKey,
					messages: [],
					responseDigest: durableModelValueDigest([]),
					usage: error.usage as unknown as Record<string, unknown>,
					accountingOnly: true,
				});
			}
			throw error;
		}
		const completedRevision = await completeDesignModelStep({
			...base,
			appendKey: `response:${stepKey}`,
			stepKey,
			messages: step.responseMessages,
			responseDigest: durableModelValueDigest(step.responseMessages),
			usage: step.usage as unknown as Record<string, unknown>,
		});
		if (completedRevision === null)
			throw new Error(
				"The response was accounted for after this run lost its authority.",
			);
		revision = completedRevision;
		messages.push(...step.responseMessages);
		await args.onStep(step, { contextId: opened.id, stepKey });
		if (!(await dispatchOutstanding()))
			return { contextId: opened.id, kind: "awaiting-input", text: "" };
	}
}
