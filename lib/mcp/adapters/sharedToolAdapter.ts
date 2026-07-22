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
 *   2. **Per-call `McpContext`** — satisfies `ToolExecutionContext` for
 *      the shared tool and owns event-log writer + progress emitter +
 *      run id.
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
 * Every shared mutating tool already calls
 * `ctx.recordMutations(mutations, newDoc, stage)` inside its own body
 * before returning its `MutatingToolResult`. Doing it again here would
 * double-write the blueprint AND emit two copies of every
 * mutation event into the log stream. The adapter's job is to delegate
 * + envelope, never to re-apply.
 *
 * **`app_id` splicing.** The MCP tool schema injects an `app_id`
 * argument (the shared tool schemas don't declare it — they take
 * `appId` from `ctx`), so we surface it to the LLM at the tool
 * boundary and strip it before forwarding to the shared tool's
 * `execute`. Leaving it in would either be ignored (tool schemas are
 * narrow) or would fail Zod parsing on stricter tools.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ToolExecutionContext } from "@/lib/agent/toolExecutionContext";
import type {
	MutatingToolResult,
	ReadToolResult,
} from "@/lib/agent/tools/common";
import type { AppCapability } from "@/lib/auth/projectRoles";
import type { BlueprintDoc } from "@/lib/domain";
import { initMcpCall } from "../context";
import {
	type McpToolErrorResult,
	type McpToolSuccessResult,
	toMcpErrorResult,
} from "../errors";
import { loadAppBlueprint } from "../loadApp";
import { deriveRunId, timestampToMillis } from "../runId";
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
	 * Full ZodObject input schema — NOT a raw shape. We read `.shape`
	 * internally to hand the raw shape to `McpServer.tool`, which
	 * expects `ZodRawShapeCompat` (`Record<string, AnySchema>`).
	 */
	readonly inputSchema: z.ZodObject<z.ZodRawShape>;
	execute(
		input: unknown,
		ctx: ToolExecutionContext,
		doc: BlueprintDoc,
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
export function registerSharedTool(
	server: McpServer,
	toolName: string,
	tool: SharedToolModule,
	ctx: ToolContext,
	required: AppCapability,
): void {
	/* Compose the MCP-surfaced schema from the tool's own shape plus
	 * the boundary-layer `app_id` injection — shared tool modules
	 * don't declare it because the chat surface passes it via
	 * `ctx.appId`. The adapter strips it before forwarding to
	 * `tool.execute`.
	 *
	 * `ZodObject.shape` is a `ZodRawShape`
	 * (`Record<string, ZodTypeAny>`) — exactly what the SDK's
	 * `ZodRawShapeCompat` expects. We don't wrap back in `z.object`
	 * because `McpServer.tool`'s overload takes the raw shape directly
	 * and wraps it internally. */
	const mcpSchema = {
		...tool.inputSchema.shape,
		app_id: z
			.string()
			.describe("App id to target. Must be an app the caller can access."),
	};

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
		{ description: tool.description, inputSchema: mcpSchema },
		async (args, extra): Promise<McpToolResult> => {
			/* `args` is typed by the SDK's overload resolution to the
			 * inferred object output of `mcpSchema`. `app_id` is always a
			 * string by schema, so we cache it before branching for both
			 * the ownership check and the error envelope. */
			const appId = args.app_id;

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
					lastActiveMs: timestampToMillis(loaded.app.updated_at),
					now: new Date(),
				});

				/* `initMcpCall` bundles the per-call collaborators the
				 * adapter needs (`LogWriter` + progress emitter +
				 * `McpContext`) and binds them to the derived `runId`.
				 * Shared with `uploadAppToHq` so a single change to
				 * collaborator wiring lands in one place rather than
				 * across every tool handler. */
				const { mcpCtx, logWriter } = initMcpCall(
					server,
					ctx,
					appId,
					loaded.access.projectId,
					runId,
					extra,
				);

				try {
					/* Strip `app_id` before forwarding — it's an MCP-
					 * boundary field only, and shared tool input schemas
					 * don't declare it. `run_id` reaches the shared tool
					 * through `ctx.runId` (already bound on `mcpCtx`), so
					 * the tool body accesses it via the execution-context
					 * interface — same contract as the chat-side SA. */
					const { app_id: _discardedAppId, ...toolInput } = args;
					const outcome = await tool.execute(toolInput, mcpCtx, loaded.doc);
					const payload = projectResult(outcome);
					/* A saga commit that PARKED saved case values stashed a note
					 * on the context — append it to a message-bearing payload so
					 * the client hears about the data consequence with the
					 * result, never silently. */
					const parkedNote = mcpCtx.consumeParkedNote();
					const finalPayload =
						parkedNote !== undefined &&
						typeof payload === "object" &&
						payload !== null &&
						"message" in payload &&
						typeof (payload as { message: unknown }).message === "string"
							? {
									...payload,
									message: `${(payload as { message: string }).message}\n\n${parkedNote}`,
								}
							: payload;
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

/**
 * Tagged union of every shape a shared tool can return. The `kind`
 * discriminator is set by each tool's own return statement — the
 * adapter dispatches on it via a `switch`, and the type system catches
 * a future third variant at compile time rather than at runtime
 * structural inspection. See `lib/agent/tools/common.ts` for the
 * per-shape definitions.
 */
type SharedToolReturn = MutatingToolResult<unknown> | ReadToolResult<unknown>;

/**
 * Map a shared tool's return value into the payload the MCP client's
 * LLM sees. Two branches, dispatched on the `kind` discriminator:
 *
 *   - `"mutate"` — unwrap `result`, the per-tool typed payload. The
 *     mutations were already persisted by the tool body via
 *     `ctx.recordMutations`; the adapter does NOT re-apply them.
 *     `mutations` + `newDoc` are internal wire data the chat surface
 *     needs (its SA wrapper advances its working-doc closure when
 *     mutations land); MCP callers re-read state via read tools, so
 *     surfacing them on the wire would be noise.
 *   - `"read"` — unwrap `data`, the bare per-tool payload.
 *
 * Exhaustive switch — TypeScript narrows `kind` to `never` in the
 * `default` branch, so adding a third variant without a matching
 * case becomes a compile error.
 *
 * Exported so unit tests can call the branches directly without
 * spinning up an MCP server.
 */
export function projectResult(raw: SharedToolReturn): unknown {
	switch (raw.kind) {
		case "mutate": {
			/* `result.summary` is UI-only presentation captured for the chat
			 * transcript (a friendly action + a location breadcrumb). MCP clients
			 * read the prose `message`, so strip the summary from the wire — in
			 * their context it would be noise, not signal. A success object that's
			 * then just `{ message }` (a tool whose result was a bare prose string
			 * before `summary` rode along) projects back to that bare string, so
			 * the MCP wire shape is byte-identical to before; objects carrying more
			 * (a minted `uuid`) keep their object shape. */
			const r = raw.result;
			if (r !== null && typeof r === "object") {
				const { summary: _summary, ...rest } = r as Record<string, unknown>;
				const keys = Object.keys(rest);
				if (keys.length === 1 && typeof rest.message === "string") {
					return rest.message;
				}
				return rest;
			}
			return r;
		}
		case "read":
			return raw.data;
		default: {
			const _exhaustive: never = raw;
			return _exhaustive;
		}
	}
}
