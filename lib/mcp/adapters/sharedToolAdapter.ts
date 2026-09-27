/** MCP extends the common grammar with explicit work/saved-app targets.
 * Private execution owns staging, authorization, retries and external effects.
 * Canonical targets are read-only; the adapter never republishes mutations. */
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { executeWorkTool } from "@/lib/agent/authoring/session";
import { runSharedToolCall } from "@/lib/agent/authoring/sharedToolCall";
import { authoringToolSchema } from "@/lib/agent/authoring/toolSchema";
import type {
	SharedToolRegistryEntry,
	ToolExecutionPolicy,
} from "@/lib/agent/sharedToolRegistry";
import type {
	MutatingToolResult,
	ReadToolResult,
} from "@/lib/agent/tools/common";
import { CanonicalMutationWorkspace } from "@/lib/agent/workspace/canonicalWorkspace";
import type { ToolInvocationContext } from "@/lib/agent/workspace/types";
import { initMcpCall } from "../context";
import {
	McpInvalidInputError,
	type McpToolErrorResult,
	type McpToolSuccessResult,
	toMcpErrorResult,
} from "../errors";
import { loadAppBlueprint } from "../loadApp";
import { projectResult } from "../resultProjection";
import { LARGE_RESULT_META } from "../resultSize";
import { deriveRunId } from "../runId";
import type { ToolContext } from "../types";
import { projectWorkPayload } from "../workProjection";

type McpToolResult = McpToolSuccessResult | McpToolErrorResult;

export interface SharedToolModule {
	readonly description: string;
	readonly inputSchema: z.ZodObject<z.ZodRawShape>;
	/** Read an already committed external receipt; never performs a new effect. */
	recover?(
		ctx: ToolInvocationContext,
	): Promise<MutatingToolResult<unknown> | ReadToolResult<unknown> | undefined>;
	execute(
		input: unknown,
		ctx: ToolInvocationContext,
	): Promise<MutatingToolResult<unknown> | ReadToolResult<unknown>>;
}

const mcpSchemas = new WeakMap<object, ReturnType<typeof mcpAuthoringSchema>>();

function mcpAuthoringSchema(
	authoredJson: Record<string, unknown>,
	effect: ToolExecutionPolicy["effect"],
) {
	const write = effect !== "read-blueprint" && effect !== "exercise-app";
	const needsRequest = effect !== "read-blueprint";
	const json = {
		...authoredJson,
		properties: {
			...z.record(z.string(), z.unknown()).parse(authoredJson.properties),
			...(write
				? {
						work_id: {
							type: "string" as const,
							minLength: 1,
							description: "Private work from begin_work.",
						},
					}
				: {
						app_id: {
							type: "string" as const,
							minLength: 1,
							description:
								effect === "exercise-app"
									? "Exercise the saved app. Choose exactly one of app_id or work_id."
									: "Read the saved app. Choose exactly one of app_id or work_id.",
						},
						work_id: {
							type: "string" as const,
							minLength: 1,
							description:
								effect === "exercise-app"
									? "Exercise this work's saved checkpoint after saving pending changes. Choose exactly one of app_id or work_id."
									: "Read private work. Choose exactly one of app_id or work_id.",
						},
					}),
			...(needsRequest
				? {
						request_id: {
							type: "string" as const,
							minLength: 1,
							description:
								"Stable unique request ID. Reuse only for an exact retry.",
						},
					}
				: {}),
		},
		required: [
			...z.array(z.string()).parse(authoredJson.required ?? []),
			...(write ? ["work_id"] : []),
			...(needsRequest ? ["request_id"] : []),
		],
		additionalProperties: false,
		...(!write
			? { oneOf: [{ required: ["app_id"] }, { required: ["work_id"] }] }
			: {}),
	};
	// Zod's JSON Schema reader does not combine required-only oneOf branches
	// with the parent object. Keep the exact choice in the published grammar;
	// enforce that one transport constraint below and parse the full object.
	const { oneOf: _targetChoice, ...valueSchema } = json;
	const schema = z.fromJSONSchema(valueSchema, { registry: z.registry() });
	return {
		"~standard": {
			version: 1 as const,
			vendor: "nova",
			types: undefined as
				| { input: Record<string, unknown>; output: Record<string, unknown> }
				| undefined,
			validate(value: unknown) {
				if (!write && value && typeof value === "object") {
					const target = value as Record<string, unknown>;
					if (
						(target.app_id !== undefined) ===
						(target.work_id !== undefined)
					) {
						return {
							issues: [{ message: "Choose exactly one of app_id or work_id." }],
						};
					}
				}
				const parsed = schema.safeParse(value);
				return parsed.success
					? { value: z.record(z.string(), z.unknown()).parse(parsed.data) }
					: { issues: parsed.error.issues };
			},
			jsonSchema: { input: () => json, output: () => json },
		},
	};
}

export function registerSharedTool(
	server: McpServer,
	entry: SharedToolRegistryEntry,
	ctx: ToolContext,
): void {
	const { mcpName: toolName, saName, tool, requires: required, policy } = entry;

	const authoredJson = authoringToolSchema(saName, tool.inputSchema).json;
	let mcpSchema = mcpSchemas.get(authoredJson);
	if (!mcpSchema) {
		mcpSchema = mcpAuthoringSchema(authoredJson, policy.effect);
		mcpSchemas.set(authoredJson, mcpSchema);
	}

	server.registerTool(
		toolName,
		{
			description: tool.description,

			_meta: LARGE_RESULT_META,
			inputSchema: mcpSchema,
		},
		async (args, extra): Promise<McpToolResult> => {
			const appId = typeof args.app_id === "string" ? args.app_id : undefined;

			try {
				if (typeof args.work_id === "string") {
					const {
						app_id: _app,
						work_id: workId,
						request_id: requestId,
						...input
					} = args;
					const outcome = await executeWorkTool({
						actorUserId: ctx.userId,
						workId,
						requestId: typeof requestId === "string" ? requestId : undefined,
						toolName: saName,
						input,
						host: { kind: "mcp" },
					});
					return {
						content: [
							{
								type: "text",
								text: JSON.stringify(
									outcome.kind === "mutate"
										? projectWorkPayload(projectResult(outcome))
										: projectResult(outcome),
								),
							},
						],
					};
				}

				if (!appId) throw new McpInvalidInputError("Choose app_id or work_id.");
				const loaded = await loadAppBlueprint(appId, ctx.userId, required);

				const runId = deriveRunId({
					currentRunId: loaded.app.run_id,
					lastActiveMs: loaded.app.updated_at.getTime(),
					now: new Date(),
				});

				const { mcpCtx, logWriter } = initMcpCall(
					ctx,
					appId,
					loaded.access.projectId,
					loaded.access.role,
					runId,
					extra,
				);

				try {
					const {
						app_id: _discardedAppId,
						request_id: requestId,
						...toolInput
					} = args;
					const workspace = new CanonicalMutationWorkspace({
						host: mcpCtx,
						initialDoc: loaded.doc,
						baseSeq: loaded.app.mutation_seq,
					});
					const outcome = await workspace.invoke({
						toolName,
						requestId: typeof requestId === "string" ? requestId : undefined,
						execute: (invocationCtx) =>
							runSharedToolCall({ saName, tool }, toolInput, invocationCtx),
					});
					const finalPayload = projectResult(
						outcome,
						mcpCtx.consumeSavedDataReview(),
					);
					return {
						content: [{ type: "text", text: JSON.stringify(finalPayload) }],
					};
				} finally {
					await logWriter.flush();
				}
			} catch (err) {
				return toMcpErrorResult(err, {
					appId,
					userId: ctx.userId,
				});
			}
		},
	);
}
