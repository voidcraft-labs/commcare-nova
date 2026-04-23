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
 * **No ownership check.** Unlike `get_app` / `compile_app` /
 * `upload_app_to_hq`, the agent prompt is not scoped to a specific app —
 * it's a pure metadata read whose output is identical for every caller
 * with `nova.read`. Adding an ownership gate would require an `app_id`
 * argument that has no semantic meaning here. `requireOwnedApp` stays
 * out.
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
	type McpToolErrorResult,
	type McpToolSuccessResult,
	toMcpErrorResult,
} from "../errors";
import { type PromptMode, renderAgentPrompt } from "../prompts";
import { resolveRunId } from "../runId";
import type { ToolContext } from "../types";

/**
 * Register the two-argument `get_agent_prompt` tool on an `McpServer`.
 *
 * Inputs are the two render-time flags `renderAgentPrompt` accepts —
 * everything else (model, effort, tool allowlist) is server-controlled
 * and not exposed to the caller, by design. The skill picks `mode` based
 * on whether it's running the build or edit flow, and `interactive`
 * based on whether the parent session is human-attended.
 *
 * `ctx.userId` rides the error envelope so cross-tenant audit logging
 * (in `toMcpErrorResult`'s `McpAccessError` branch — `errors.ts:171`)
 * stays uniform across every tool, even ones like this that don't gate
 * on ownership. The happy path doesn't read `ctx`; threading it on
 * errors keeps the registration shape uniform with `getApp`,
 * `compileApp`, etc., and leaves the door open for a scope-conditional
 * render without a context refactor.
 */
export function registerGetAgentPrompt(
	server: McpServer,
	ctx: ToolContext,
): void {
	server.registerTool(
		"get_agent_prompt",
		{
			description:
				"Get the current nova-architect agent definition (frontmatter + system prompt) for the given mode. Plugin skills call this to materialize the subagent file at invoke time so the server stays the source of truth for prompt, model, effort, and tool restrictions.",
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
			},
		},
		async (args, extra): Promise<McpToolSuccessResult | McpToolErrorResult> => {
			/* Resolve `run_id` at the top so both success and error envelopes
			 * thread the same id onto `_meta` — admin surfaces grouping by
			 * run id rely on every exit path stamping it consistently, and
			 * the bootstrap call is usually the first in a run so it sets
			 * the key the rest of the call chain inherits. */
			const runId = resolveRunId(extra);
			try {
				/* `renderAgentPrompt` is pure — it builds two strings and an
				 * object literal. The try/catch wrapper looks redundant
				 * today but stays for future-proofing: any future renderer
				 * change that adds I/O (e.g. fetching prompt-fragment from
				 * Firestore) gets the standard error classifier path
				 * automatically, with the right `_meta.run_id` already
				 * stamped, by virtue of being inside this block. */
				const payload = renderAgentPrompt(args.mode, args.interactive);
				return {
					content: [{ type: "text", text: JSON.stringify(payload) }],
					_meta: { run_id: runId },
				};
			} catch (err) {
				return toMcpErrorResult(err, { runId, userId: ctx.userId });
			}
		},
	);
}
