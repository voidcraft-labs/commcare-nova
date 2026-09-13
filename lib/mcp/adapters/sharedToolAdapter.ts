/**
 * `sharedToolAdapter` — the single wrapper every shared SA tool goes
 * through to mount on the MCP server.
 *
 * Every module in `lib/agent/tools/<name>.ts` is a self-contained unit
 * of domain logic — it computes + (for writers) persists mutations
 * against a `BlueprintDoc`, then returns a typed result. The shared
 * tool contract standardizes the shape so that both the chat-side
 * `ToolLoopAgent` factory in `lib/agent/solutionsArchitect.ts` and
 * this adapter can consume the same module without duplicating the
 * core behavior.
 *
 * What this adapter adds around each tool call:
 *
 *   1. **Ownership** — `loadAppBlueprint(appId, userId)` ownership-gates
 *      and loads the doc in one read, so a cross-tenant probe
 *      throws before the tool body runs.
 *   2. **Per-call `McpContext` + canonical workspace** — the context is
 *      the `CanonicalMutationHost` a fresh `CanonicalMutationWorkspace`
 *      commits through; it owns event-log writer + progress emitter +
 *      run id, and the workspace owns the per-call document snapshot.
 *   3. **Server-derived run id** — after the app is loaded, the
 *      adapter derives a run id from the app's own state (current
 *      `run_id` + `updated_at` sliding window) and passes it into the
 *      context. Clients never see or supply a run id; see
 *      `lib/mcp/runId.ts` for the derivation semantics.
 *   4. **Progress emitter** — adapters inside the tool body emit
 *      fine-grained stage notifications; the emitter no-ops when the
 *      client didn't opt in.
 *   5. **Log-writer flush** — `finally`-block drain so conversation
 *      events + mutation envelopes always reach the event log even on
 *      throw. `LogWriter.logEvent` is fire-and-forget and a missed
 *      flush silently drops everything that hadn't hit the batch-size
 *      trigger yet.
 *   6. **Result projection** — two tagged-union shapes (`"read"` /
 *      `"mutate"`) reduce to a single MCP text payload the LLM can
 *      reason over via an exhaustive `kind`-switch.
 *
 * **Hard invariant — the adapter MUST NOT re-persist mutations.**
 * Every shared mutating tool commits through its invocation context's
 * `applyBatch`/`applyStages` inside its own body, and the workspace routes
 * the accepted batch to the host's `recordMutations` exactly once, before
 * the tool returns its `MutatingToolResult`. Persisting again here would
 * double-write the blueprint AND emit two copies of every mutation event
 * into the log stream. The adapter's job is to delegate + envelope, never
 * to re-apply.
 *
 * The registered Standard JSON Schema adds app_id to the shared authored
 * grammar without expanding reusable definitions. After authorization, the
 * callback binds names and runs the original canonical schema, including every
 * relational refinement. It strips app_id before invoking the tool.

 */

import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { prepareAuthoringInput } from "@/lib/agent/authoring/input";
import { projectAuthoringReadInContext } from "@/lib/agent/authoring/output";
import { authoringToolSchema } from "@/lib/agent/authoring/toolSchema";
import type {
	MutatingToolResult,
	ReadToolResult,
} from "@/lib/agent/tools/common";
import { CanonicalMutationWorkspace } from "@/lib/agent/workspace/canonicalWorkspace";
import type { ToolInvocationContext } from "@/lib/agent/workspace/types";
import type { AppCapability } from "@/lib/auth/projectRoles";
import { initMcpCall } from "../context";
import {
	type McpToolErrorResult,
	type McpToolSuccessResult,
	toMcpErrorResult,
} from "../errors";
import { loadAppBlueprint } from "../loadApp";
import { projectResult } from "../resultProjection";
import { LARGE_RESULT_META } from "../resultSize";
import { deriveRunId } from "../runId";
import type { ToolContext } from "../types";

/**
 * Union of every envelope shape an MCP tool callback resolves to. The
 * success branch shape is defined in `../errors.ts` (both
 * `McpToolSuccessResult` and `McpToolErrorResult` carry the open
 * `[extra: string]: unknown` index signature the SDK's internal
 * `CallToolResult` target requires). Aliased here so the registered
 * callback's return type is a single readable expression.
 */
type McpToolResult = McpToolSuccessResult | McpToolErrorResult;

/**
 * Structural contract the adapter accepts. Every shared tool module
 * satisfies this — `execute` returns one of the two tagged shapes
 * (`MutatingToolResult` / `ReadToolResult`), collapsed at the union
 * level so the adapter dispatches via a `switch` on the `kind`
 * discriminator. The per-tool generic `R` parameter is erased at the
 * boundary; `projectResult` re-emits the per-tool payload via the
 * discriminator.
 */
export interface SharedToolModule {
	/** Human-readable description surfaced to the LLM in MCP tool listing. */
	readonly description: string;
	/**
	 * The canonical schema used after authored input is bound. Its object-level
	 * refinements remain authoritative; the registered grammar checks authored shapes.
	 */
	readonly inputSchema: z.ZodObject<z.ZodRawShape>;
	execute(
		input: unknown,
		ctx: ToolInvocationContext,
	): Promise<MutatingToolResult<unknown> | ReadToolResult<unknown>>;
}

/**
 * Register one shared tool on the MCP server.
 *
 * @param server - The live `McpServer` instance.
 * @param toolName - The MCP-side tool name (snake_case convention —
 *   e.g. `"search_blueprint"`, `"add_module"`). The MCP tool name is
 *   intentionally independent of the camelCase TypeScript export name
 *   so the wire protocol follows MCP conventions while the
 *   code-internal name stays idiomatic TypeScript.
 * @param tool - The shared tool module (see `SharedToolModule`).
 * @param ctx - Request-scoped context carrying the authenticated
 *   user's id and granted scopes. Constructed once in the MCP route
 *   handler and shared across all `registerSharedTool` calls for that
 *   request-ish lifetime (scope check already happened upstream).
 */
const mcpSchemas = new WeakMap<object, ReturnType<typeof mcpAuthoringSchema>>();

function mcpAuthoringSchema(authoredJson: Record<string, unknown>) {
	const json = {
		...authoredJson,
		properties: {
			...z.record(z.string(), z.unknown()).parse(authoredJson.properties),
			app_id: { type: "string" as const, description: "App to open." },
		},
		required: [
			...z.array(z.string()).parse(authoredJson.required ?? []),
			"app_id",
		],
	};
	const schema = z.fromJSONSchema(json, { registry: z.registry() });
	return {
		"~standard": {
			version: 1 as const,
			vendor: "nova",
			types: undefined as
				| { input: Record<string, unknown>; output: Record<string, unknown> }
				| undefined,
			validate(value: unknown) {
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
	toolName: string,
	tool: SharedToolModule,
	ctx: ToolContext,
	required: AppCapability,
	saName = toolName.replace(/_([a-z])/g, (_match, letter: string) =>
		letter.toUpperCase(),
	),
): void {
	/* Preserve the shared authored JSON as registered. Canonical refinements
	 * run after scoped binding inside the authorized invocation. */
	const authoredJson = authoringToolSchema(saName, tool.inputSchema).json;
	let mcpSchema = mcpSchemas.get(authoredJson);
	if (!mcpSchema) {
		mcpSchema = mcpAuthoringSchema(authoredJson);
		mcpSchemas.set(authoredJson, mcpSchema);
	}

	/* Both return branches (success / error envelope) structurally
	 * satisfy the SDK's `CallToolResult` type — success has a
	 * `content` array, error adds `isError: true`. Every structured
	 * signal the model needs lives inside `content[0].text` (JSON for
	 * most tools, plain markdown for renderer passthrough). The SDK's
	 * target type carries an open `[x: string]: unknown` index
	 * signature; we match it by declaring the same index signature on
	 * both result types in `../errors.ts`, which avoids importing
	 * `CallToolResult` here (via two paths `McpServer` + `types.js`
	 * TS otherwise reports "Two different types with this name exist"
	 * for the inferred alias). */
	server.registerTool(
		toolName,
		{
			description: tool.description,
			/* Every tool on this surface returns something a model reads —
			 * a module, a form, a set of matches, a sentence confirming a
			 * mutation — so they share one exposure to the host's result
			 * cap and one declaration lifting it. See `../resultSize`. */
			_meta: LARGE_RESULT_META,
			inputSchema: mcpSchema,
		},
		async (args, extra): Promise<McpToolResult> => {
			/* `args` is typed by the SDK's overload resolution to the
			 * inferred object output of `mcpSchema`. `app_id` is always a
			 * string by schema, so we cache it before branching for both
			 * the ownership check and the error envelope. */
			const appId = args.app_id as string;

			try {
				/* `loadAppBlueprint` ownership-gates and loads in one
				 * read; throws `McpAccessError` on cross-tenant
				 * probe or vanished row, both of which the wire collapses
				 * to `not_found`. The full `AppDoc` is returned alongside
				 * `.doc` for tools that want denormalized columns. */
				const loaded = await loadAppBlueprint(appId, ctx.userId, required);

				/* Derive the run id from the app's own state after loading
				 * but before any event-log write or progress emission.
				 * The sliding-window rule lives in `deriveRunId`: within
				 * the window, reuse the app's current `run_id` so calls
				 * group together in the event log; past the window, mint
				 * a fresh id to start a new run. Clients never supply or
				 * observe this value. */
				const runId = deriveRunId({
					currentRunId: loaded.app.run_id,
					lastActiveMs: loaded.app.updated_at.getTime(),
					now: new Date(),
				});

				/* `initMcpCall` bundles the per-call collaborators the
				 * adapter needs (`LogWriter` + progress emitter +
				 * `McpContext`) and binds them to the derived `runId`.
				 * Shared with `uploadAppToHq` so a single change to
				 * collaborator wiring lands in one place rather than
				 * across every tool handler. */
				const { mcpCtx, logWriter } = initMcpCall(
					ctx,
					appId,
					loaded.access.projectId,
					loaded.access.role,
					runId,
					extra,
				);

				try {
					/* Strip `app_id` before forwarding — it's an MCP-
					 * boundary field only, and shared tool input schemas
					 * don't declare it. `run_id` reaches the shared tool
					 * through `ctx.runId` (already bound on `mcpCtx`), so
					 * the tool body accesses it via the invocation-context
					 * interface — same contract as the chat-side SA. The
					 * per-call canonical workspace owns the loaded document;
					 * its host (`mcpCtx`) has no conflict reload, so an
					 * authoritative rejection propagates to the error
					 * envelope below — the per-call doc lifecycle. */
					const { app_id: _discardedAppId, ...toolInput } = args;
					const workspace = new CanonicalMutationWorkspace({
						host: mcpCtx,
						initialDoc: loaded.doc,
						baseSeq: loaded.app.mutation_seq,
					});
					const outcome = await workspace.invoke({
						toolName,
						execute: async (invocationCtx) => {
							const prepared = await prepareAuthoringInput({
								toolName: saName,
								schema: tool.inputSchema,
								input: toolInput,
								ctx: invocationCtx,
							});
							const result = await tool.execute(prepared, invocationCtx);
							return result.kind === "read"
								? {
										...result,
										data: await projectAuthoringReadInContext(
											saName,
											result.data,
											invocationCtx,
										),
									}
								: result;
						},
					});
					const finalPayload = projectResult(
						outcome,
						mcpCtx.consumeParkedNote(),
					);
					return {
						content: [{ type: "text", text: JSON.stringify(finalPayload) }],
					};
				} finally {
					/* Drain the event-log buffer before returning OR
					 * throwing. `LogWriter.flush` never throws; it resolves
					 * once every inflight log batch has acknowledged.
					 * A missed flush silently drops any events that hadn't
					 * triggered the batch-size flush threshold yet. */
					await logWriter.flush();
				}
			} catch (err) {
				/* Both ownership failures and mid-execute throws land
				 * here. `toMcpErrorResult` classifies via the shared
				 * taxonomy. */
				return toMcpErrorResult(err, {
					appId,
					userId: ctx.userId,
				});
			}
		},
	);
}
