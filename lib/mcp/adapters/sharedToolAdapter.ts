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
 *   1. **Ownership** — `requireOwnedApp` before anything else, so a
 *      cross-tenant probe never reaches tool code or Firestore reads.
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
 *      events + mutation envelopes always reach Firestore even on
 *      throw. `LogWriter.logEvent` is fire-and-forget and a missed
 *      flush silently drops everything that hadn't hit the batch-size
 *      trigger yet.
 *   6. **Result projection** — three structural shapes (read /
 *      mutating / validateApp) reduce to a single MCP text payload the
 *      LLM can reason over.
 *
 * **Hard invariant — the adapter MUST NOT re-persist mutations.**
 * Every shared mutating tool already calls
 * `ctx.recordMutations(mutations, newDoc, stage)` inside its own body
 * before returning its `MutatingToolResult`. Doing it again here would
 * double-write the blueprint to Firestore AND emit two copies of every
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
import type { MutatingToolResult } from "@/lib/agent/tools/common";
import type { BlueprintDoc } from "@/lib/domain";
import { initMcpCall } from "../context";
import {
	type McpToolErrorResult,
	type McpToolSuccessResult,
	toMcpErrorResult,
} from "../errors";
import { loadAppBlueprint } from "../loadApp";
import { McpAccessError, requireOwnedApp } from "../ownership";
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
 * satisfies this — `execute`'s return can be one of three shapes
 * (read result / `MutatingToolResult<R>` / `ValidateAppResult`) and we
 * intentionally leave it as `unknown` at the generic level.
 *
 * Carrying a three-way discriminated union through this interface
 * would either explode the type into a tagged sum every tool file has
 * to opt into, or force this adapter to special-case per tool. Neither
 * is worth it: the adapter's `projectResult` discriminator runs at
 * runtime exactly where the shape variance matters and leaves the tool
 * authoring surface unchanged.
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
	/**
	 * Optional strictness flag some tools set; currently informational —
	 * the MCP SDK has no corresponding knob, so we mirror it onto the
	 * adapter interface only so TypeScript stops complaining when tool
	 * modules set it and callers pass the module object straight in.
	 */
	readonly strict?: boolean;
	execute(
		input: unknown,
		ctx: ToolExecutionContext,
		doc: BlueprintDoc,
	): Promise<unknown>;
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
			.describe(
				"Firestore app id to target. Must be an app the authenticated user owns.",
			),
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
				await requireOwnedApp(ctx.userId, appId);

				/* `loadAppBlueprint` both fetches the row and rebuilds
				 * the derived `fieldParent` reverse index tools expect.
				 * The load runs AFTER the ownership check; the race
				 * between the two reads — ownership resolves, then a
				 * concurrent hard-delete nulls the row — surfaces as
				 * the same `not_found` an "app never existed" probe
				 * would hit, so MCP clients see one consistent error.
				 * Only the blueprint flows downstream; the helper also
				 * returns the full `AppDoc` for tools that want
				 * denormalized columns. */
				const loaded = await loadAppBlueprint(appId);
				if (!loaded) throw new McpAccessError("not_found");

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
					return {
						content: [{ type: "text", text: JSON.stringify(payload) }],
					};
				} finally {
					/* Drain the event-log buffer before returning OR
					 * throwing. `LogWriter.flush` never throws; it resolves
					 * once every inflight Firestore batch has acknowledged.
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
 * Map a shared tool's return value into the payload the MCP client's
 * LLM sees. Three mutually-exclusive branches, checked in an order
 * that makes misclassification impossible even if a future result
 * shape accidentally shared keys across branches:
 *
 *   1. **`MutatingToolResult<R>`** — requires ALL three keys present
 *      (`mutations`, `newDoc`, `result`). The tool already persisted
 *      `mutations` via `ctx.recordMutations` before returning; we
 *      unwrap to `result.result`, which is the per-tool typed payload
 *      the LLM cares about. `mutations` + `newDoc` are internal wire
 *      data for the chat-side SA wrapper and are deliberately not
 *      surfaced to MCP callers (they re-read state via read tools).
 *   2. **`ValidateAppResult`** — `{ success, doc, hqJson?, errors? }`.
 *      We project to `{ success }` (or `{ success, errors }` on
 *      failure) and drop both `doc` and `hqJson`. The full doc +
 *      compiled HQ JSON would balloon the response by megabytes for
 *      no MCP benefit: callers re-read state via `get_app` or
 *      `compile_app` if they need it.
 *   3. **Read tool** — anything else. Pure pass-through; read tools
 *      are already shaped for direct LLM consumption.
 *
 * Order matters. If we checked `success` + `doc` first, a future
 * `MutatingToolResult` whose `.result` payload coincidentally had
 * both keys would be misclassified. Checking for the mutating tuple
 * first preempts that class of drift.
 *
 * Exported so unit tests can call the three branches directly without
 * spinning up an MCP server.
 */
export function projectResult(raw: unknown): unknown {
	if (typeof raw !== "object" || raw === null) return raw;

	/* 1. MutatingToolResult discrimination: all three keys required.
	 * Checking the full tuple (not just `mutations`) rules out read
	 * results that carry a `mutations` field for unrelated reasons. */
	if (isMutatingToolResult(raw)) {
		return raw.result;
	}

	/* 2. validateApp discrimination: `success` + `doc`, with `doc`
	 * being object-typed (the full `BlueprintDoc`). Mutating tool
	 * results also carry `result`, which the mutating check above
	 * already catches; `isValidateAppResult` additionally ensures
	 * no `result` key on the outer shape as belt-and-suspenders
	 * against a future shape regression. */
	if (isValidateAppResult(raw)) {
		if (raw.success) return { success: true };
		/* On failure we include `errors` even when empty — clients
		 * branch on `success` but benefit from a stable key layout. */
		return { success: false, errors: raw.errors ?? [] };
	}

	/* 3. Read-tool pass-through. */
	return raw;
}

/**
 * Strict structural check for `MutatingToolResult<R>`. All three
 * fields must be present AND typed correctly — `mutations` is an
 * array and `newDoc` is a non-null object. Written this way so a
 * read result that happens to key-match (e.g., carries a
 * `newDoc: "some-string"` alias for unrelated reasons) doesn't
 * false-positive.
 */
function isMutatingToolResult(raw: object): raw is MutatingToolResult<unknown> {
	if (!("mutations" in raw) || !("newDoc" in raw) || !("result" in raw)) {
		return false;
	}
	const r = raw as { mutations: unknown; newDoc: unknown };
	return (
		Array.isArray(r.mutations) &&
		typeof r.newDoc === "object" &&
		r.newDoc !== null
	);
}

/**
 * Structural check for `ValidateAppResult`. `success` is a boolean;
 * `doc` is a non-null object (the full `BlueprintDoc`); there is no
 * `result` key on the outer shape — the latter is what separates
 * this from the `MutatingToolResult`, whose `.result` payload could
 * hypothetically carry a `success` + `doc` pair of its own. We check
 * the OUTER shape, so the presence of `result` on the outer object
 * is a negative signal. Errors are optional.
 */
function isValidateAppResult(raw: object): raw is {
	success: boolean;
	doc: unknown;
	hqJson?: unknown;
	errors?: string[];
} {
	if (!("success" in raw) || !("doc" in raw) || "result" in raw) return false;
	const r = raw as { success: unknown; doc: unknown };
	return (
		typeof r.success === "boolean" &&
		typeof r.doc === "object" &&
		r.doc !== null
	);
}
