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
import { CHANGE_SET_HANDLE_PATTERN } from "@/lib/agent/change-set/schemas";
import type { CommittedSliceReceipt } from "@/lib/agent/change-set/types";
import type { ChangeSetMutationWorkspace } from "@/lib/agent/change-set/workspace";
import { designIdSchema } from "@/lib/agent/design/ids";
import { markStablePrefixBoundary } from "@/lib/agent/prompts";
import type { AppMaterializationReceipt } from "@/lib/db/appGenesis";
import { type ReasoningEffort, reasoningProviderOptions } from "@/lib/models";
import type { SliceExecutionBudget } from "./budgets";
import {
	type ArchitectBlockerDecision,
	type ExecutionBlocker,
	executionBlockerSchema,
} from "./executionBlocker";
import { renderBriefMessage, type SliceExecutionBrief } from "./executionBrief";
import { EXECUTOR_SYSTEM } from "./executorPrompt";
import { executorWireToolSchema } from "./executorWireSchemas";

/**
 * The workspace surface the loop uses. Structurally the change-set workspace
 * (which satisfies it) — narrowed so the loop depends on exactly the three
 * operations it performs, and so a test can drive it without a database.
 */
export type ExecutorWorkspace = Pick<
	ChangeSetMutationWorkspace,
	"stageDispatch" | "inspect" | "currentSnapshot" | "currentExecutionCheckpoint"
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
			spent: { modelSteps: number; stagedRequests: number };
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
	| "wire-invalid"
	| "stage-rejected"
	| "validator-repair"
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

const INSPECT_TOOL = "inspectChangeSet";
const COMMIT_TOOL = "commitChangeSet";
const REPORT_BLOCKER_TOOL = "reportExecutionBlocker";
const READ_BATCH_TOOL = "readBatch";
const STAGE_BATCH_TOOL = "stageBatch";
const MAX_READ_BATCH_OPERATIONS = 4;
const MAX_STAGE_BATCH_OPERATIONS = 12;

const noArgumentsSchema = z.object({}).strict();

/** Server-owned tools mounted beside the compiler's read and batch surface. */
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
	[REPORT_BLOCKER_TOOL]: {
		description:
			"Report exact observations that cannot be resolved locally and request one construction decision. This is evidence for the server-owned architect, not a design verdict or a user message.",
		schema: executionBlockerSchema,
	},
};

const BATCH_LOCAL_HANDLE_FAMILIES = [
	"worker-property",
	"user-type",
	"persona",
] as const;

const SERVER_MINTED_OUTPUT_COLLECTIONS = new Map<string, string>([
	["addUserProperties", "properties"],
	["addUserTypes", "userTypes"],
	["addPersonas", "personas"],
]);

const ITEM_HANDLE_SCHEMA: JSONSchema7 = {
	type: "string",
	pattern: CHANGE_SET_HANDLE_PATTERN.source,
	description:
		'A compiler-local name for this new item. Later operations in the same batch may reference it as { handle: "@name" }.',
};

/** Put a server-minted identity declaration beside the item it names. This is
 * executor-only projection: the declaration is stripped before the original
 * shared-tool schema parses, so canonical tools remain UUID-only. */
function addItemHandleDeclarations(
	name: string,
	inputSchema: JSONSchema7,
): void {
	const collectionName = SERVER_MINTED_OUTPUT_COLLECTIONS.get(name);
	if (collectionName === undefined) return;
	const collection = inputSchema.properties?.[collectionName];
	if (
		collection === undefined ||
		typeof collection === "boolean" ||
		collection === null ||
		collection.items === undefined ||
		Array.isArray(collection.items) ||
		typeof collection.items === "boolean"
	) {
		throw new Error(
			`The executor cannot project item handles onto ${name}.${collectionName}.`,
		);
	}
	const item = collection.items;
	item.properties ??= {};
	item.properties.handle = ITEM_HANDLE_SCHEMA;
	item.required = [...new Set([...(item.required ?? []), "handle"])];
}

function mutatingInputSchema(name: string): JSONSchema7 {
	const entry = CHANGE_SET_TOOL_REGISTRY.get(name);
	if (entry === undefined || entry.policy.effect !== "mutate-blueprint") {
		throw new Error(`The stage batch cannot mount non-mutating tool ${name}.`);
	}
	const inputSchema = executorWireToolSchema(name, entry.tool.inputSchema, {
		additionalHandleFamilies: BATCH_LOCAL_HANDLE_FAMILIES,
	});
	inputSchema.properties ??= {};
	inputSchema.properties.constructionGroupIds = {
		type: "array",
		items: { type: "string", format: "uuid" },
		minItems: 1,
		uniqueItems: true,
		description: "The exact construction groups this operation implements.",
	};
	inputSchema.required = [
		...new Set([...(inputSchema.required ?? []), "constructionGroupIds"]),
	];
	addItemHandleDeclarations(name, inputSchema);
	return inputSchema;
}

function readBatchSchema(): JSONSchema7 {
	const operationArms = Array.from(CHANGE_SET_TOOL_REGISTRY.values())
		.filter((entry) => entry.policy.effect === "read-blueprint")
		.map((entry) => ({
			type: "object",
			properties: {
				toolName: { const: entry.name },
				input: executorWireToolSchema(entry.name, entry.tool.inputSchema),
			},
			required: ["toolName", "input"],
			additionalProperties: false,
		})) satisfies JSONSchema7[];
	return {
		type: "object",
		properties: {
			operations: {
				type: "array",
				items: { oneOf: operationArms },
				minItems: 1,
				maxItems: MAX_READ_BATCH_OPERATIONS,
			},
		},
		required: ["operations"],
		additionalProperties: false,
	};
}

function stageBatchSchema(): JSONSchema7 {
	const operationArms = Array.from(CHANGE_SET_TOOL_REGISTRY.values())
		.filter((entry) => entry.policy.effect === "mutate-blueprint")
		.map((entry) => ({
			type: "object",
			properties: {
				toolName: { const: entry.name },
				input: mutatingInputSchema(entry.name),
			},
			required: ["toolName", "input"],
			additionalProperties: false,
		})) satisfies JSONSchema7[];
	return {
		type: "object",
		properties: {
			operations: {
				type: "array",
				items: { oneOf: operationArms },
				minItems: 1,
				maxItems: MAX_STAGE_BATCH_OPERATIONS,
			},
		},
		required: ["operations"],
		additionalProperties: false,
	};
}

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
		if (entry.policy.effect !== "read-blueprint") continue;
		const inputSchema = executorWireToolSchema(name, entry.tool.inputSchema);
		tools[name] = {
			description: entry.tool.description,
			inputSchema,
		};
	}
	tools[READ_BATCH_TOOL] = {
		description:
			"Read up to four related current Blueprint structures in one step. Use this when one construction decision needs several views such as a form, its module, case operations, and worker schema. Reads run serially and never mutate the candidate.",
		inputSchema: readBatchSchema(),
	};
	tools[STAGE_BATCH_TOOL] = {
		description:
			"Stage one ordered semantic group. Operations run serially, each is durably idempotent, and execution stops at the first rejected operation while preserving every earlier admitted operation.",
		inputSchema: stageBatchSchema(),
	};
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

function carriesPromptCacheBreakpoint(message: ModelMessage): boolean {
	const hasBreakpoint = (providerOptions: unknown): boolean => {
		if (providerOptions === null || typeof providerOptions !== "object") {
			return false;
		}
		const openai = (providerOptions as { openai?: unknown }).openai;
		return (
			openai !== null &&
			typeof openai === "object" &&
			"promptCacheBreakpoint" in openai
		);
	};
	if (
		hasBreakpoint(
			(message as ModelMessage & { providerOptions?: unknown }).providerOptions,
		)
	) {
		return true;
	}
	return (
		Array.isArray(message.content) &&
		message.content.some((part) =>
			hasBreakpoint((part as { providerOptions?: unknown }).providerOptions),
		)
	);
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
	promptCacheKey?: string,
): ExecutorStepFn {
	return async ({ system, messages, tools: definitions, signal }) => {
		const base = reasoningProviderOptions(
			reasoningEffort,
			promptCacheKey === undefined ? undefined : { promptCacheKey },
		);
		const result = await generateText({
			model,
			system,
			messages:
				promptCacheKey !== undefined &&
				!messages.some(carriesPromptCacheBreakpoint)
					? markStablePrefixBoundary(messages)
					: messages,
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

const stageBatchEnvelopeSchema = z
	.object({
		operations: z
			.array(
				z
					.object({
						toolName: z.string().min(1),
						input: z.unknown(),
					})
					.strict(),
			)
			.min(1)
			.max(MAX_STAGE_BATCH_OPERATIONS),
	})
	.strict();

const readBatchEnvelopeSchema = z
	.object({
		operations: z
			.array(
				z
					.object({
						toolName: z.string().min(1),
						input: z.unknown(),
					})
					.strict(),
			)
			.min(1)
			.max(MAX_READ_BATCH_OPERATIONS),
	})
	.strict();

function resolveBatchLocalHandles(
	value: unknown,
	bindings: ReadonlyMap<string, string>,
): unknown {
	if (Array.isArray(value)) {
		return value.map((member) => resolveBatchLocalHandles(member, bindings));
	}
	if (value === null || typeof value !== "object") return value;
	const record = value as Record<string, unknown>;
	if (
		Object.keys(record).length === 1 &&
		typeof record.handle === "string" &&
		bindings.has(record.handle)
	) {
		return bindings.get(record.handle);
	}
	return Object.fromEntries(
		Object.entries(record).map(([key, member]) => [
			key,
			resolveBatchLocalHandles(member, bindings),
		]),
	);
}

function createdUuids(result: unknown): readonly string[] | null {
	if (result === null || typeof result !== "object") return null;
	const envelope = result as { kind?: unknown; result?: unknown };
	if (envelope.kind !== "mutate") return null;
	if (envelope.result === null || typeof envelope.result !== "object")
		return null;
	const uuids = (envelope.result as { uuids?: unknown }).uuids;
	return Array.isArray(uuids) && uuids.every((uuid) => typeof uuid === "string")
		? uuids
		: null;
}

const itemHandleSchema = z.string().regex(CHANGE_SET_HANDLE_PATTERN);

interface PreparedStageOperation {
	readonly toolName: string;
	readonly input: unknown;
	readonly itemHandles: readonly string[] | null;
}

function prepareStageOperation(
	operation: z.infer<typeof stageBatchEnvelopeSchema>["operations"][number],
): PreparedStageOperation {
	const collectionName = SERVER_MINTED_OUTPUT_COLLECTIONS.get(
		operation.toolName,
	);
	if (collectionName === undefined) {
		return { ...operation, itemHandles: null };
	}
	if (
		operation.input === null ||
		typeof operation.input !== "object" ||
		Array.isArray(operation.input)
	) {
		throw new ChangeSetStagingRejectedError(
			"STAGING_FORBIDDEN",
			`${operation.toolName} input must be an object whose ${collectionName} items each declare a handle.`,
		);
	}
	const input = operation.input as Record<string, unknown>;
	const collection = input[collectionName];
	if (!Array.isArray(collection) || collection.length === 0) {
		throw new ChangeSetStagingRejectedError(
			"STAGING_FORBIDDEN",
			`${operation.toolName}.${collectionName} must contain at least one item, and every item must declare its handle beside the item.`,
		);
	}
	const handles: string[] = [];
	const stripped = collection.map((item, index) => {
		if (item === null || typeof item !== "object" || Array.isArray(item)) {
			throw new ChangeSetStagingRejectedError(
				"STAGING_FORBIDDEN",
				`${operation.toolName}.${collectionName}.${index} must be an object with a handle.`,
			);
		}
		const { handle, ...canonicalItem } = item as Record<string, unknown>;
		const parsed = itemHandleSchema.safeParse(handle);
		if (!parsed.success) {
			throw new ChangeSetStagingRejectedError(
				"STAGING_FORBIDDEN",
				`${operation.toolName}.${collectionName}.${index}.handle must match @name using lowercase letters, numbers, underscores, or hyphens.`,
			);
		}
		handles.push(parsed.data);
		return canonicalItem;
	});
	return {
		toolName: operation.toolName,
		input: { ...input, [collectionName]: stripped },
		itemHandles: handles,
	};
}

function collectHandleReferences(value: unknown, out: Set<string>): void {
	if (Array.isArray(value)) {
		for (const member of value) collectHandleReferences(member, out);
		return;
	}
	if (value === null || typeof value !== "object") return;
	const record = value as Record<string, unknown>;
	if (
		Object.keys(record).length === 1 &&
		typeof record.handle === "string" &&
		itemHandleSchema.safeParse(record.handle).success
	) {
		out.add(record.handle);
		return;
	}
	for (const member of Object.values(record)) {
		collectHandleReferences(member, out);
	}
}

/** Validate the complete declaration graph before staging the first operation.
 * Unknown references may be durable change-set handles; only references to a
 * worker identity declared later in THIS batch are forward references. */
function prepareStageOperations(
	operations: z.infer<typeof stageBatchEnvelopeSchema>["operations"],
	existingHandles: ReadonlySet<string>,
): readonly PreparedStageOperation[] {
	const prepared = operations.map(prepareStageOperation);
	const structuralDeclarations = new Set<string>();
	for (const operation of prepared) {
		const entry = CHANGE_SET_TOOL_REGISTRY.get(operation.toolName);
		for (const declaration of entry?.declaredHandles?.(operation.input) ?? []) {
			structuralDeclarations.add(declaration.handle);
		}
	}
	const declaredAt = new Map<string, number>();
	for (const [index, operation] of prepared.entries()) {
		for (const handle of operation.itemHandles ?? []) {
			if (
				existingHandles.has(handle) ||
				structuralDeclarations.has(handle) ||
				declaredAt.has(handle)
			) {
				throw new ChangeSetStagingRejectedError(
					"HANDLE_RESOLUTION_FAILED",
					`Handle ${handle} is already bound or declared; each handle may name exactly one entity.`,
				);
			}
			declaredAt.set(handle, index);
		}
	}
	for (const [index, operation] of prepared.entries()) {
		const references = new Set<string>();
		collectHandleReferences(operation.input, references);
		for (const handle of references) {
			const declarationIndex = declaredAt.get(handle);
			if (declarationIndex !== undefined && declarationIndex >= index) {
				throw new ChangeSetStagingRejectedError(
					"HANDLE_RESOLUTION_FAILED",
					`Handle ${handle} is referenced before the operation that creates it.`,
				);
			}
		}
	}
	return prepared;
}

function resultHasError(result: unknown): boolean {
	return (
		result !== null &&
		typeof result === "object" &&
		typeof (result as { error?: unknown }).error === "string"
	);
}

const CONTINUE_NUDGE =
	"Continue with exactly one tool call. Stage every remaining construction group before inspecting; once none remain, inspect once and commit if it reports no findings.";

/* One-call read discipline sometimes needs several current structures together
 * (for example a module, a form, and its operations). Keep only this small
 * volatile working set; durable mutations, handles, and group coverage still
 * come exclusively from the freshly rendered workspace checkpoint. */
const RECENT_READ_TURN_LIMIT = 4;

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
	const moduleCount = snapshot.doc.moduleOrder.length;
	const formCount = Object.keys(snapshot.doc.forms).length;
	const lines = [
		"## Current change set",
		`Revision ${snapshot.revision}. The private candidate holds ${moduleCount} module(s) and ${formCount} form(s).`,
		moduleCount === 0 && formCount === 0
			? "Nothing has been staged yet — this is the first step."
			: "Build on what is already staged; never re-create it.",
		`App: ${JSON.stringify(doc.appName)} (${doc.appId})`,
		execution.intentCoverage.length === 0
			? "Durable construction groups: none yet."
			: `Durable construction groups: ${execution.intentCoverage
					.map(
						(coverage) =>
							`${coverage.intentId} (${coverage.stepCount} step${coverage.stepCount === 1 ? "" : "s"})`,
					)
					.join(", ")}.`,
	];
	const handles = execution.handles.slice(0, INVENTORY_HANDLE_LIMIT);
	if (handles.length > 0) {
		lines.push(
			`Durable handles: ${handles
				.map(
					(binding) =>
						`${binding.handle}=${binding.entityKind}:${binding.uuid}`,
				)
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
					return property === undefined ? uuid : `${property.slug} (${uuid})`;
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
			`Module ${moduleUuid}: id=${module.id}, name=${JSON.stringify(module.name)}${module.caseType === undefined ? "" : `, caseType=${module.caseType}`}`,
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
						? uuid
						: `${field.id}:${field.kind} (${uuid})`;
				})
				.join(", ");
			lines.push(
				`  Form ${formUuid}: id=${form.id}, name=${JSON.stringify(form.name)}, type=${form.type}; fields=${fieldInventory || "none"}${more((doc.fieldOrder[formUuid] ?? []).length, fieldIds.length)}`,
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

function executorCheckpoint(
	brief: SliceExecutionBrief,
	workspace: ExecutorWorkspace,
): ModelMessage[] {
	const stableBrief = markStablePrefixBoundary([
		userMessage(
			[
				"## Accepted execution brief",
				"This is the exact accepted slice. It is immutable for this attempt.",
				renderBriefMessage(brief),
			].join("\n\n"),
		),
	])[0];
	if (stableBrief === undefined) {
		throw new Error("The executor's accepted brief could not be rendered.");
	}
	return [
		stableBrief,
		userMessage(
			[
				"## Current authoritative private candidate",
				"Use this current durable checkpoint. Do not rely on an older summarized workspace.",
				renderExecutorWorkspaceSummary(workspace),
			].join("\n\n"),
		),
	];
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
	commit: (
		signal: AbortSignal,
		deadlineAt: number,
	) => Promise<SliceCommitResult>;
	resolveBlocker?: SliceBlockerResolver;
	signal: AbortSignal;
	onProgress?: (phase: "building" | "validating" | "committing") => void;
	/** Each step's display-safe reasoning summary → the run event log, so
	 *  the WHY behind an executor decision is readable beside its artifacts
	 *  (no design table gains a reasoning column). */
	onReasoning?: (text: string) => void;
	/** Meter spent provider usage as soon as an awaited response returns and
	 * before the post-await deadline decision. */
	onUsage?: (usage: LanguageModelUsage) => void;
	onToolCall?: (call: {
		readonly modelStep: number;
		readonly toolName: string;
		readonly workspaceRevision: number;
	}) => void;
	/** Payload-free operator diagnostics for the private compiler. */
	onToolOutcome?: (event: ExecutorToolOutcomeEvent) => void;
}): Promise<SliceExecutionOutcome> {
	const { workspace, brief, budget, signal } = args;
	const tools = executorTools();
	const startedAt = Date.now();
	const deadlineAt = startedAt + budget.maxWallClockMs;
	const deadline = new AbortController();
	const deadlineTimer = setTimeout(
		() =>
			deadline.abort(new Error("Slice execution wall-clock budget expired.")),
		Math.max(0, deadlineAt - Date.now()),
	);
	deadlineTimer.unref?.();
	const boundedSignal = AbortSignal.any([signal, deadline.signal]);
	const deadlineExceeded = () =>
		!signal.aborted && (deadline.signal.aborted || Date.now() >= deadlineAt);

	let modelSteps = 0;
	let stagedRequests = 0;
	let commitAttempts = 0;
	let blockerReports = 0;
	let consecutiveEmptySteps = 0;
	let recentReadTurns: ModelMessage[][] = [];
	/* Once the model asks for validation it has declared construction complete.
	 * A later fully accepted repair batch may consume the final model step while
	 * leaving an already clean candidate. The server may finish that exact
	 * candidate at the step boundary; it may never infer readiness before the
	 * model entered validation, or after a stopped/partial batch. */
	let validationRequested = false;
	let lastActionCanFinalizeAtStepBoundary = false;

	const withCheckpoint = (...tail: ModelMessage[]): ModelMessage[] => [
		...executorCheckpoint(brief, workspace),
		...recentReadTurns.flat(),
		...tail,
	];
	const rememberReadTurn = (turn: ModelMessage[]): void => {
		recentReadTurns = [...recentReadTurns, turn].slice(-RECENT_READ_TURN_LIMIT);
		messages = withCheckpoint();
	};
	const replaceWorkingTurn = (turn: ModelMessage[]): void => {
		recentReadTurns = [];
		messages = [...executorCheckpoint(brief, workspace), ...turn];
	};

	const spent = () => ({ modelSteps, stagedRequests });
	const exhausted = (): SliceExecutionOutcome => ({
		kind: "budget-exhausted",
		spent: spent(),
	});
	const emitBoundaryOutcome = (
		outcome: ExecutorToolOutcomeKind,
		code: string,
	): void => {
		args.onToolOutcome?.({
			modelStep: modelSteps,
			toolName: COMMIT_TOOL,
			workspaceRevision: workspace.currentSnapshot().revision,
			outcome,
			code,
		});
	};
	const finalizeCleanCandidateAtStepBoundary = async (): Promise<
		SliceExecutionOutcome | undefined
	> => {
		if (
			!validationRequested ||
			!lastActionCanFinalizeAtStepBoundary ||
			signal.aborted ||
			deadlineExceeded()
		) {
			return undefined;
		}
		args.onProgress?.("validating");
		let diagnostics: Awaited<ReturnType<ExecutorWorkspace["inspect"]>>;
		try {
			diagnostics = await awaitWithAbort(workspace.inspect(), boundedSignal);
		} catch (error) {
			if (deadlineExceeded()) return exhausted();
			throw error;
		}
		const stale = staleExternalReads(diagnostics);
		if (stale.length > 0) {
			emitBoundaryOutcome("stage-rejected", "READ_SET_STALE");
			return { kind: "read-set-stale", stale };
		}
		if (
			!diagnostics.canCommit ||
			remainingConstructionGroupIds(diagnostics, brief).length > 0
		) {
			return undefined;
		}
		commitAttempts += 1;
		if (commitAttempts > budget.maxCommitAttempts) return exhausted();
		args.onProgress?.("committing");
		let result: SliceCommitResult;
		try {
			result = await awaitWithAbort(
				args.commit(boundedSignal, deadlineAt),
				boundedSignal,
			);
		} catch (error) {
			if (deadlineExceeded()) return exhausted();
			throw error;
		}
		if (result.kind === "committed") {
			emitBoundaryOutcome("committed", "CHANGE_SET_COMMITTED_AT_STEP_BOUNDARY");
			return { kind: "committed", receipt: result.receipt };
		}
		if (result.kind === "rebase-conflict") {
			emitBoundaryOutcome("stage-rejected", "REBASE_CONFLICT");
			return { kind: "rebase-conflict", report: result.report };
		}
		if (result.kind === "read-set-stale") {
			emitBoundaryOutcome("stage-rejected", "READ_SET_STALE");
			return { kind: "read-set-stale", stale: result.stale };
		}
		/* A fresh canonical gate rejection means the candidate is no longer
		 * finalizable without another model correction. The model budget is
		 * already spent, so preserve the ordinary bounded failure. */
		emitBoundaryOutcome("stage-rejected", "CANONICAL_GATE_REJECTED");
		return undefined;
	};

	let messages: ModelMessage[] = executorCheckpoint(brief, workspace);

	args.onProgress?.("building");

	try {
		for (;;) {
			if (signal.aborted) {
				return {
					kind: "protocol-failure",
					code: "aborted",
					message: "This slice attempt was cancelled before it finished.",
				};
			}
			if (modelSteps >= budget.maxModelSteps) {
				const finalized = await finalizeCleanCandidateAtStepBoundary();
				return finalized ?? exhausted();
			}
			if (Date.now() >= deadlineAt || deadline.signal.aborted)
				return exhausted();

			let step: Awaited<ReturnType<ExecutorStepFn>>;
			try {
				step = await awaitWithAbort(
					args.step({
						system: EXECUTOR_SYSTEM,
						messages,
						tools,
						signal: boundedSignal,
					}),
					boundedSignal,
				);
			} catch (error) {
				/* The provider observes the deadline-bound signal while it is awaited.
				 * Convert only OUR deadline abort to the durable budget outcome; caller
				 * cancellation keeps its existing abort semantics. */
				if (deadlineExceeded()) return exhausted();
				throw error;
			}
			/* Meter an observed response before deciding that it arrived too late.
			 * A provider that ignores abort stays detached after the deadline, with
			 * no callback allowed to mutate a finalized run accumulator later. */
			if (step.usage) args.onUsage?.(step.usage);
			if (Date.now() >= deadlineAt || deadline.signal.aborted)
				return exhausted();
			modelSteps += 1;
			/* Eligibility belongs only to an action accepted in THIS model step.
			 * A prose-only or multi-call response executes nothing and must not carry
			 * forward a prior clean inspection into boundary finalization. */
			lastActionCanFinalizeAtStepBoundary = false;
			if (step.reasoningText) args.onReasoning?.(step.reasoningText);

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
				messages = withCheckpoint(
					...step.responseMessages,
					userMessage(CONTINUE_NUDGE),
				);
				continue;
			}
			consecutiveEmptySteps = 0;

			if (step.toolCalls.length > 1) {
				/* §13.6.3: execute none, answer every call deterministically. */
				messages = withCheckpoint(
					...step.responseMessages,
					...step.toolCalls.map((call) =>
						toolMessage(
							call.toolCallId,
							call.toolName,
							ONE_CALL_PROTOCOL_RESULT,
						),
					),
				);
				continue;
			}

			const call = step.toolCalls[0];
			if (call === undefined) continue;
			const toolOutcome = (
				outcome: ExecutorToolOutcomeKind,
				code: string,
				operationIndex?: number,
				toolName = call.toolName,
			): void => {
				args.onToolOutcome?.({
					modelStep: modelSteps,
					toolName,
					...(operationIndex !== undefined && { operationIndex }),
					workspaceRevision: workspace.currentSnapshot().revision,
					outcome,
					code,
				});
			};
			args.onToolCall?.({
				modelStep: modelSteps,
				toolName: call.toolName,
				workspaceRevision: workspace.currentSnapshot().revision,
			});
			const answer = (
				value: unknown,
				options: { readonly rememberRead?: boolean } = {},
			): void => {
				const turn = [
					...step.responseMessages,
					toolMessage(call.toolCallId, call.toolName, value),
				];
				if (options.rememberRead === true) rememberReadTurn(turn);
				else replaceWorkingTurn(turn);
			};

			if (call.toolName === READ_BATCH_TOOL) {
				const parsed = readBatchEnvelopeSchema.safeParse(call.input);
				if (!parsed.success) {
					toolOutcome("wire-invalid", "READ_BATCH_ENVELOPE_INVALID");
					answer(
						{
							error: `The read batch shape is invalid: ${parsed.error.issues
								.map(
									(issue) =>
										`${issue.path.join(".") || "(root)"}: ${issue.message}`,
								)
								.join("; ")}`,
						},
						{ rememberRead: true },
					);
					continue;
				}
				const completed: Array<{
					index: number;
					toolName: string;
					result: unknown;
				}> = [];
				let failed: { index: number; toolName: string; error: string } | null =
					null;
				for (const [index, operation] of parsed.data.operations.entries()) {
					const entry = CHANGE_SET_TOOL_REGISTRY.get(operation.toolName);
					if (entry === undefined || entry.policy.effect !== "read-blueprint") {
						toolOutcome(
							"wire-invalid",
							"READ_OPERATION_NOT_ALLOWED",
							index,
							operation.toolName,
						);
						failed = {
							index,
							toolName: operation.toolName,
							error:
								"Only read-only Blueprint tools are valid read operations.",
						};
						break;
					}
					try {
						if (Date.now() >= deadlineAt || deadline.signal.aborted)
							return exhausted();
						const dispatched = await awaitWithAbort(
							workspace.stageDispatch({
								toolName: operation.toolName,
								requestId: `${call.toolCallId}:${index}`,
								input: operation.input,
								intentIds: [],
								deadlineAt,
							}),
							boundedSignal,
						);
						const projectedResult = projectToolResult(dispatched.result);
						if (resultHasError(projectedResult)) {
							toolOutcome(
								"stage-rejected",
								"TOOL_RESULT_ERROR",
								index,
								operation.toolName,
							);
							failed = {
								index,
								toolName: operation.toolName,
								error: (projectedResult as { error: string }).error,
							};
							break;
						}
						toolOutcome(
							"accepted",
							"READ_COMPLETED",
							index,
							operation.toolName,
						);
						completed.push({
							index,
							toolName: operation.toolName,
							result: projectedResult,
						});
					} catch (error) {
						if (deadlineExceeded()) return exhausted();
						if (error instanceof ChangeSetStagingRejectedError) {
							toolOutcome(
								"stage-rejected",
								error.code,
								index,
								operation.toolName,
							);
							failed = {
								index,
								toolName: operation.toolName,
								error: error.message,
							};
							break;
						}
						const terminal = terminalProtocolCode(error);
						if (terminal === null) throw error;
						toolOutcome(
							"terminal-protocol",
							terminal,
							index,
							operation.toolName,
						);
						return {
							kind: "protocol-failure",
							code: terminal,
							message: (error as Error).message,
						};
					}
				}
				answer(
					{
						completed,
						...(failed === null
							? { status: "completed" }
							: {
									status: "stopped",
									failed,
									unattemptedCount:
										parsed.data.operations.length - failed.index - 1,
								}),
					},
					{ rememberRead: true },
				);
				continue;
			}

			if (call.toolName === STAGE_BATCH_TOOL) {
				const parsed = stageBatchEnvelopeSchema.safeParse(call.input);
				if (!parsed.success) {
					toolOutcome("wire-invalid", "STAGE_BATCH_ENVELOPE_INVALID");
					answer({
						error: `The batch shape is invalid: ${parsed.error.issues
							.map(
								(issue) =>
									`${issue.path.join(".") || "(root)"}: ${issue.message}`,
							)
							.join("; ")}`,
					});
					continue;
				}
				let operations: readonly PreparedStageOperation[];
				try {
					operations = prepareStageOperations(
						parsed.data.operations,
						new Set(
							workspace
								.currentExecutionCheckpoint()
								.handles.map((binding) => binding.handle),
						),
					);
				} catch (error) {
					if (!(error instanceof ChangeSetStagingRejectedError)) throw error;
					toolOutcome("wire-invalid", error.code);
					answer({ error: error.message });
					continue;
				}
				const bindings = new Map<string, string>();
				const completed: Array<{
					index: number;
					toolName: string;
					result: unknown;
				}> = [];
				let failed: { index: number; toolName: string; error: string } | null =
					null;
				for (const [index, operation] of operations.entries()) {
					const entry = CHANGE_SET_TOOL_REGISTRY.get(operation.toolName);
					if (
						entry === undefined ||
						entry.policy.effect !== "mutate-blueprint"
					) {
						toolOutcome(
							"wire-invalid",
							"STAGE_OPERATION_NOT_ALLOWED",
							index,
							operation.toolName,
						);
						failed = {
							index,
							toolName: operation.toolName,
							error:
								"Only private Blueprint mutations are valid batch operations.",
						};
						break;
					}
					stagedRequests += 1;
					if (stagedRequests > budget.maxStagedRequests) return exhausted();
					try {
						if (Date.now() >= deadlineAt || deadline.signal.aborted)
							return exhausted();
						const resolved = resolveBatchLocalHandles(
							operation.input,
							bindings,
						);
						const projected = extractStagingInput(resolved, brief);
						const dispatched = await awaitWithAbort(
							workspace.stageDispatch({
								toolName: operation.toolName,
								requestId: `${call.toolCallId}:${index}`,
								input: projected.input,
								intentIds: projected.intentIds,
								deadlineAt,
							}),
							boundedSignal,
						);
						const projectedResult = projectToolResult(dispatched.result);
						if (resultHasError(projectedResult)) {
							toolOutcome(
								"stage-rejected",
								"TOOL_RESULT_ERROR",
								index,
								operation.toolName,
							);
							failed = {
								index,
								toolName: operation.toolName,
								error: (projectedResult as { error: string }).error,
							};
							break;
						}
						if (operation.itemHandles !== null) {
							const uuids = createdUuids(dispatched.result);
							if (
								uuids === null ||
								uuids.length !== operation.itemHandles.length
							) {
								toolOutcome(
									"terminal-protocol",
									"BATCH_OUTPUT_CONTRACT_INVALID",
									index,
									operation.toolName,
								);
								return {
									kind: "protocol-failure",
									code: "batch-output-contract-invalid",
									message:
										"A staged operation returned identities that do not match its item handle declarations.",
								};
							}
							for (const [
								handleIndex,
								handle,
							] of operation.itemHandles.entries()) {
								const uuid = uuids[handleIndex];
								if (uuid !== undefined) bindings.set(handle, uuid);
							}
						}
						toolOutcome(
							"accepted",
							"STAGE_COMPLETED",
							index,
							operation.toolName,
						);
						completed.push({
							index,
							toolName: operation.toolName,
							result: projectedResult,
						});
					} catch (error) {
						if (deadlineExceeded()) return exhausted();
						if (error instanceof ChangeSetStagingRejectedError) {
							toolOutcome(
								"stage-rejected",
								error.code,
								index,
								operation.toolName,
							);
							failed = {
								index,
								toolName: operation.toolName,
								error: error.message,
							};
							break;
						}
						const terminal = terminalProtocolCode(error);
						if (terminal === null) throw error;
						toolOutcome(
							"terminal-protocol",
							terminal,
							index,
							operation.toolName,
						);
						return {
							kind: "protocol-failure",
							code: terminal,
							message: (error as Error).message,
						};
					}
				}
				answer({
					completed,
					bindings: Object.fromEntries(bindings),
					...(failed === null
						? { status: "completed" }
						: {
								status: "stopped",
								failed,
								unattemptedCount:
									parsed.data.operations.length - failed.index - 1,
							}),
				});
				lastActionCanFinalizeAtStepBoundary =
					validationRequested && failed === null;
				continue;
			}

			if (CHANGE_SET_TOOL_REGISTRY.has(call.toolName)) {
				try {
					if (Date.now() >= deadlineAt || deadline.signal.aborted)
						return exhausted();
					const entry = CHANGE_SET_TOOL_REGISTRY.get(call.toolName);
					if (entry?.policy.effect === "mutate-blueprint") {
						toolOutcome("wire-invalid", "MUTATION_OUTSIDE_STAGE_BATCH");
						answer({
							error:
								"Mutations are available only inside stageBatch; put this operation into one ordered semantic batch.",
						});
						continue;
					}
					const projected = { input: call.input, intentIds: [] as const };
					const dispatched = await awaitWithAbort(
						workspace.stageDispatch({
							toolName: call.toolName,
							requestId: call.toolCallId,
							input: projected.input,
							intentIds: projected.intentIds,
							deadlineAt,
						}),
						boundedSignal,
					);
					const projectedResult = projectToolResult(dispatched.result);
					toolOutcome(
						resultHasError(projectedResult) ? "stage-rejected" : "accepted",
						resultHasError(projectedResult)
							? "TOOL_RESULT_ERROR"
							: "READ_COMPLETED",
					);
					answer(projectedResult, { rememberRead: true });
				} catch (error) {
					if (deadlineExceeded()) return exhausted();
					if (signal.aborted) {
						return {
							kind: "protocol-failure",
							code: "aborted",
							message: "This slice attempt was cancelled before it finished.",
						};
					}
					if (error instanceof ChangeSetStagingRejectedError) {
						/* An ordinary refusal — the model self-corrects. */
						toolOutcome("stage-rejected", error.code);
						answer({ error: error.message }, { rememberRead: true });
						continue;
					}
					const terminal = terminalProtocolCode(error);
					if (terminal === null) throw error;
					toolOutcome("terminal-protocol", terminal);
					return {
						kind: "protocol-failure",
						code: terminal,
						message: (error as Error).message,
					};
				}
				continue;
			}

			if (call.toolName === INSPECT_TOOL) {
				validationRequested = true;
				if (Date.now() >= deadlineAt || deadline.signal.aborted)
					return exhausted();
				args.onProgress?.("validating");
				try {
					const diagnostics = await awaitWithAbort(
						workspace.inspect(),
						boundedSignal,
					);
					const stale = staleExternalReads(diagnostics);
					if (stale.length > 0) {
						toolOutcome("stage-rejected", "READ_SET_STALE");
						return { kind: "read-set-stale", stale };
					}
					toolOutcome(
						diagnostics.allFindings.length > 0
							? "validator-repair"
							: "accepted",
						diagnostics.allFindings.length > 0
							? "VALIDATOR_FINDINGS"
							: "INSPECTION_CLEAN",
					);
					answer(projectDiagnostics(diagnostics, brief), {
						rememberRead: true,
					});
					lastActionCanFinalizeAtStepBoundary = true;
				} catch (error) {
					if (deadlineExceeded()) return exhausted();
					throw error;
				}
				continue;
			}

			if (call.toolName === COMMIT_TOOL) {
				validationRequested = true;
				if (Date.now() >= deadlineAt || deadline.signal.aborted)
					return exhausted();
				let diagnostics: Awaited<ReturnType<ExecutorWorkspace["inspect"]>>;
				try {
					diagnostics = await awaitWithAbort(
						workspace.inspect(),
						boundedSignal,
					);
				} catch (error) {
					if (deadlineExceeded()) return exhausted();
					throw error;
				}
				if (Date.now() >= deadlineAt || deadline.signal.aborted)
					return exhausted();
				const stale = staleExternalReads(diagnostics);
				if (stale.length > 0) {
					toolOutcome("stage-rejected", "READ_SET_STALE");
					return { kind: "read-set-stale", stale };
				}
				const remainingIntents = remainingConstructionGroupIds(
					diagnostics,
					brief,
				);
				if (!diagnostics.canCommit || remainingIntents.length > 0) {
					/* A blocked request is not an attempt — nothing was tried. */
					toolOutcome(
						diagnostics.allFindings.length > 0
							? "validator-repair"
							: "stage-rejected",
						diagnostics.allFindings.length > 0
							? "VALIDATOR_FINDINGS"
							: "COMMIT_PRECONDITION_FAILED",
					);
					answer({
						error: `The change set cannot commit yet: ${describeBlockers(
							diagnostics,
							remainingIntents,
						)}`,
						remainingConstructionGroupIds: remainingIntents,
					});
					continue;
				}
				commitAttempts += 1;
				if (commitAttempts > budget.maxCommitAttempts) return exhausted();
				args.onProgress?.("committing");
				let result: SliceCommitResult;
				try {
					result = await awaitWithAbort(
						args.commit(boundedSignal, deadlineAt),
						boundedSignal,
					);
				} catch (error) {
					if (deadlineExceeded()) return exhausted();
					throw error;
				}
				if (result.kind === "committed") {
					toolOutcome("committed", "CHANGE_SET_COMMITTED");
					return { kind: "committed", receipt: result.receipt };
				}
				if (result.kind === "gate-rejected") {
					toolOutcome("stage-rejected", "CANONICAL_GATE_REJECTED");
					answer({ error: result.message });
					continue;
				}
				if (result.kind === "rebase-conflict") {
					toolOutcome("stage-rejected", "REBASE_CONFLICT");
					/* Admitted steps are append-only. A semantic conflict cannot be
					 * repaired by appending after the invalid step because replay would
					 * still execute it. The orchestrator owns bounded supersession and
					 * restarts from the fresh canonical base. */
					return { kind: "rebase-conflict", report: result.report };
				}
				toolOutcome("stage-rejected", "READ_SET_STALE");
				/* External dependencies are part of immutable staged steps. Appending a
				 * new read cannot erase the stale dependency, so the orchestrator must
				 * supersede this attempt and reconstruct from a fresh snapshot. */
				return { kind: "read-set-stale", stale: result.stale };
			}

			if (call.toolName === REPORT_BLOCKER_TOOL) {
				const parsed = executionBlockerSchema.safeParse(call.input);
				if (!parsed.success) {
					toolOutcome("wire-invalid", "BLOCKER_REPORT_INVALID");
					answer({
						error: `That blocker report is invalid: ${parsed.error.issues
							.map(
								(issue) =>
									`${issue.path.join(".") || "(root)"}: ${issue.message}`,
							)
							.join("; ")}`,
					});
					continue;
				}
				blockerReports += 1;
				if (blockerReports > budget.maxBlockerResolutions) {
					return {
						kind: "protocol-failure",
						code: "blocker-resolution-budget-exhausted",
						message:
							"The compiler exhausted its bounded architect-resolution budget without reaching a safe construction.",
					};
				}
				let diagnostics: ReturnType<typeof projectDiagnostics>;
				try {
					diagnostics = projectDiagnostics(
						await awaitWithAbort(workspace.inspect(), boundedSignal),
						brief,
					);
				} catch (error) {
					if (deadlineExceeded()) return exhausted();
					throw error;
				}
				if (args.resolveBlocker === undefined) {
					return {
						kind: "protocol-failure",
						code: "architect-resolver-unavailable",
						message:
							"The server-owned architect resolver is unavailable for this execution.",
					};
				}
				let decision: ArchitectBlockerDecision;
				try {
					decision = await awaitWithAbort(
						args.resolveBlocker({
							blocker: parsed.data,
							brief,
							diagnostics,
							signal: boundedSignal,
						}),
						boundedSignal,
					);
				} catch (error) {
					if (deadlineExceeded()) return exhausted();
					throw error;
				}
				if (decision.kind === "continue") {
					toolOutcome("accepted", "ARCHITECT_CONTINUE");
					answer({ decision: "continue", guidance: decision.guidance });
					continue;
				}
				toolOutcome("accepted", "ARCHITECT_DECISION");
				return { kind: "architect-decision", decision };
			}

			toolOutcome("wire-invalid", "UNKNOWN_TOOL");
			answer({
				error: `There is no tool named ${call.toolName}. The tools available are: ${Object.keys(tools).join(", ")}.`,
			});
		}
	} finally {
		clearTimeout(deadlineTimer);
	}
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

function extractStagingInput(
	input: unknown,
	brief: SliceExecutionBrief,
): { input: unknown; intentIds: readonly z.infer<typeof designIdSchema>[] } {
	if (input === null || typeof input !== "object" || Array.isArray(input)) {
		throw new ChangeSetStagingRejectedError(
			"STAGING_FORBIDDEN",
			"A staged mutation call must be an object with constructionGroupIds.",
		);
	}
	const { constructionGroupIds, ...toolInput } = input as Record<
		string,
		unknown
	>;
	const parsed = z
		.array(designIdSchema)
		.min(1)
		.refine((ids) => new Set(ids).size === ids.length)
		.safeParse(constructionGroupIds);
	if (!parsed.success) {
		throw new ChangeSetStagingRejectedError(
			"STAGING_FORBIDDEN",
			"A staged mutation call must name at least one valid construction group id.",
		);
	}
	const owned = new Set<string>(brief.constructionGroupIds);
	const foreignGroupIds = parsed.data.filter((id) => !owned.has(id));
	if (foreignGroupIds.length > 0) {
		throw new ChangeSetStagingRejectedError(
			"STAGING_FORBIDDEN",
			`A staged mutation call may name only construction groups in this workflow slice. These ids are outside the slice: ${foreignGroupIds.join(", ")}. Name the group or groups this operation actually implements; a group may appear on more than one corrective step.`,
		);
	}
	return { input: toolInput, intentIds: parsed.data };
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
): unknown {
	const MAX_REPORTED_FINDINGS = 20;
	const remainingIntents = remainingConstructionGroupIds(diagnostics, brief);
	return {
		revision: diagnostics.snapshotRevision,
		findingCount: diagnostics.allFindings.length,
		findings: diagnostics.allFindings
			.slice(0, MAX_REPORTED_FINDINGS)
			.map((finding) => ({
				code: finding.code,
				message: finding.message,
				/* Coordinates and structured details are what distinguish several
				 * instances of the same validator code. They stay inside the private
				 * executor context; stripping them made the worker guess which carrier
				 * to repair and turn a local correction into a false design blocker. */
				location: finding.location,
				details: finding.details,
			})),
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
		remainingConstructionGroupIds: remainingIntents,
		canCommit: diagnostics.canCommit && remainingIntents.length === 0,
	};
}

function describeBlockers(
	diagnostics: Awaited<ReturnType<ExecutorWorkspace["inspect"]>>,
	remainingIntents: readonly string[],
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
	if (remainingIntents.length > 0) {
		return `${remainingIntents.length} owned design intent${remainingIntents.length === 1 ? " has" : "s have"} no staged implementation`;
	}
	return "it holds no staged steps yet";
}

function staleExternalReads(
	diagnostics: Awaited<ReturnType<ExecutorWorkspace["inspect"]>>,
) {
	return diagnostics.readSetStatus.filter(
		(status) => status.state !== "current",
	);
}

/** The exact coverage gap the canonical commit will independently re-prove.
 * Diagnostics derives coverage from durable mutation-bearing steps; the
 * accepted brief is the authority for what this slice owns. */
function remainingConstructionGroupIds(
	diagnostics: Awaited<ReturnType<ExecutorWorkspace["inspect"]>>,
	brief: SliceExecutionBrief,
): string[] {
	const covered = new Set(
		diagnostics.sliceIntentCoverage.map((coverage) => coverage.intentId),
	);
	return brief.constructionGroupIds.filter((groupId) => !covered.has(groupId));
}
