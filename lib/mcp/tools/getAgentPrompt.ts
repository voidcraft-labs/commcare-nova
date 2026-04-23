/**
 * `nova.get_agent_prompt` — dynamic-agent bootstrap.
 *
 * Scope: `nova.read` (enforced at the verify layer — the route handler
 * declares this tool's mount with `scopes: ["nova.read"]` so by the time
 * this body runs the JWT already proved the scope; no per-handler check).
 *
 * The plugin skills call this tool at the start of every build/edit run.
 * The returned `{ frontmatter, system_prompt }` payload is materialized
 * by the skill at `<plugin-root>/agents/nova-architect-{runId}.md`, then
 * the skill spawns a subagent via the Agent tool with
 * `subagent_type: "nova:nova-architect-{runId}"`. Hosting the renderer
 * server-side is what lets us iterate the SA prompt, model, reasoning
 * effort, and tool allowlist without cutting a new plugin release —
 * the next skill invocation just picks up the fresh render.
 *
 * **Edit mode loads the blueprint here.** When `mode === "edit"`, the
 * tool requires `app_id`, ownership-gates on it, loads the blueprint,
 * and passes the doc through to `renderAgentPrompt` so the spawned
 * subagent boots with `EDIT_PREAMBLE` framing + an inlined
 * `summarizeBlueprint(doc)` — exact parity with the web flow's edit
 * mode (`/api/chat`). Without this round trip the edit subagent would
 * have to spend its first tool call re-fetching what the server already
 * has on hand.
 *
 * Build mode (`mode === "build"`) ignores `app_id` even when present.
 * Skill simplicity wins here: `mode` is the authoritative flag, and a
 * spurious id shouldn't cause a Firestore round-trip or skew the
 * envelope. `_meta.app_id` is therefore only stamped on edit-mode
 * success — a build response with `_meta.app_id` would mislead admin
 * surfaces correlating runs to apps.
 *
 * **Why a JSON-stringified text payload, not structured content.** MCP
 * defines `content` as a typed array — `text`, `image`, `resource`. There
 * is no first-class "JSON object" content kind on the wire, and Nova's
 * other tools that emit structured data (`list_apps`, `get_app`,
 * `compile_app`'s metadata branch) all serialize to a JSON string in a
 * `text` block for the same reason. The plugin skill `JSON.parse`s the
 * text. Keeping the on-the-wire shape uniform also means a single MCP
 * client deserializer can handle every tool's response — no per-tool
 * branching on content kind.
 *
 * **`_meta.run_id` is still threaded.** Same reason `list_apps` does
 * it: MCP clients bundle multi-call runs under one id so admin surfaces
 * grouping by run id can stitch this call to the sibling tool calls the
 * plugin skill makes during the same build (e.g.
 * `get_agent_prompt` → `create_app` → `generate_schema`). Without
 * threading it here the bootstrap call would orphan from the rest of
 * the run on every admin timeline.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
	McpInvalidInputError,
	type McpToolErrorResult,
	type McpToolSuccessResult,
	toMcpErrorResult,
} from "../errors";
import { loadAppBlueprint } from "../loadApp";
import { McpAccessError, requireOwnedApp } from "../ownership";
import { type PromptMode, renderAgentPrompt } from "../prompts";
import { resolveRunId } from "../runId";
import type { ToolContext } from "../types";

/**
 * Register the three-argument `get_agent_prompt` tool on an `McpServer`.
 *
 * Inputs:
 *   - `mode` and `interactive` are the two render-time flags every call
 *     supplies. `mode` picks the agent description + tools allowlist;
 *     `interactive` controls the `AskUserQuestion` allowlist.
 *   - `app_id` is conditionally required: required in edit mode (so the
 *     handler can ownership-gate + inline the blueprint summary into
 *     the system prompt), ignored in build mode (skill convenience —
 *     `mode` is the authoritative discriminator). The conditional is
 *     not expressible in raw-shape Zod, so the handler enforces it via
 *     a typed `McpInvalidInputError` throw at the top.
 *
 * `ctx.userId` rides every error envelope so cross-tenant audit logging
 * (in `toMcpErrorResult`'s `McpAccessError` branch) stays uniform across
 * every tool. The build-mode happy path doesn't read `ctx.userId`; edit
 * mode reads it for `requireOwnedApp` to gate the blueprint load.
 */
export function registerGetAgentPrompt(
	server: McpServer,
	ctx: ToolContext,
): void {
	server.registerTool(
		"get_agent_prompt",
		{
			description:
				"Get the current nova-architect agent definition (frontmatter + system prompt) for the given mode. Plugin skills call this to materialize the subagent file at invoke time so the server stays the source of truth for prompt, model, effort, and tool restrictions. Edit mode requires `app_id` so the inlined blueprint summary mirrors the web flow's edit-mode prompt at boot.",
			/* Raw-shape Zod object — `registerTool` composes the object
			 * validator around it. Wrapping in `z.object(...)` would
			 * register the wrong shape: `{ schema: z.object }` rather
			 * than `{ <field>: z.<field> }`. */
			inputSchema: {
				/* `as const satisfies readonly PromptMode[]` ties the wire
				 * enum to the renderer's exported `PromptMode` union: if a
				 * new flavor lands in `prompts.ts` (e.g. `"review"`) the
				 * `satisfies` constraint becomes a compile error here
				 * until the literal list is updated, instead of silently
				 * rejecting the new mode at runtime as a Zod
				 * `invalid_enum_value`. The renderer is the single source
				 * of truth; this is the wire side accepting it. */
				mode: z
					.enum(["build", "edit"] as const satisfies readonly PromptMode[])
					.describe(
						"Which agent flavor to render. `build` exposes generation tools (create_app, generate_schema, generate_scaffold, add_module); `edit` strips them so the subagent can't replace an existing app's structure mid-edit.",
					),
				interactive: z
					.boolean()
					.describe(
						"When true, the subagent may call AskUserQuestion (added to the `tools` allowlist). When false, the frontmatter emits `disallowedTools: ['AskUserQuestion']` so Claude Code physically blocks the call — a prompt-only 'don't ask' instruction would be weaker.",
					),
				app_id: z
					.string()
					.optional()
					.describe(
						"Required when `mode === 'edit'` — the Firestore app id whose blueprint summary should be inlined into the rendered system prompt. The user must own this app. Ignored when `mode === 'build'` (build mode has no app to read from).",
					),
			},
		},
		async (args, extra): Promise<McpToolSuccessResult | McpToolErrorResult> => {
			/* Resolve `run_id` at the top so both success and error envelopes
			 * thread the same id onto `_meta` — admin surfaces grouping by
			 * run id rely on every exit path stamping it consistently, and
			 * the bootstrap call is usually the first in a run so it sets
			 * the key the rest of the call chain inherits. */
			const runId = resolveRunId(extra);
			/* `appId` is captured here (rather than read inline in the
			 * branches) so the `catch` can stamp it onto error `_meta`
			 * when the failure originates from the edit branch. Build
			 * mode leaves it `undefined`, which is what the spread in
			 * `_meta` correctly omits — see `errors.ts`'s base merge. */
			const appId = args.mode === "edit" ? args.app_id : undefined;
			try {
				if (args.mode === "edit") {
					/* Edit mode is strict on `app_id`: the whole point of
					 * threading the doc through `renderAgentPrompt` is to
					 * inline the blueprint summary at boot. Without an id
					 * we can't ownership-gate or load, so refuse with a
					 * deterministic `invalid_input` rather than rendering a
					 * misleading build-mode prompt under an edit
					 * description. */
					if (!args.app_id) {
						throw new McpInvalidInputError("edit mode requires app_id");
					}
					await requireOwnedApp(ctx.userId, args.app_id);
					/* `loadAppBlueprint` returns null when a concurrent
					 * hard-delete lands between the ownership check and
					 * this read — collapse that race to the same
					 * `not_found` shape a missing-app probe surfaces, the
					 * way `getApp` does. */
					const loaded = await loadAppBlueprint(args.app_id);
					if (!loaded) throw new McpAccessError("not_found");
					const payload = renderAgentPrompt(
						args.mode,
						args.interactive,
						loaded.doc,
					);
					return {
						content: [{ type: "text", text: JSON.stringify(payload) }],
						_meta: { app_id: args.app_id, run_id: runId },
					};
				}

				/* Build mode: `app_id` is intentionally ignored even when
				 * supplied (sharp-edge #2 — skill convenience, `mode` is
				 * the authoritative flag). `_meta.app_id` is therefore
				 * not stamped on the build-mode envelope; an admin
				 * surface seeing `app_id` here would falsely correlate a
				 * build run to an unrelated app. */
				const payload = renderAgentPrompt(args.mode, args.interactive);
				return {
					content: [{ type: "text", text: JSON.stringify(payload) }],
					_meta: { run_id: runId },
				};
			} catch (err) {
				return toMcpErrorResult(err, {
					appId,
					runId,
					userId: ctx.userId,
				});
			}
		},
	);
}
