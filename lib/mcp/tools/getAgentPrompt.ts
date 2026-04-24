/**
 * `nova.get_agent_prompt` — self-fetch bootstrap tool.
 *
 * Scope: `nova.read` (enforced at the verify layer — the route handler
 * declares this tool's mount with `scopes: ["nova.read"]` so by the time
 * this body runs the JWT already proved the scope; no per-handler check).
 *
 * The plugin ships two static subagent files whose bodies instruct the
 * spawned subagent to call this tool on turn 0 and treat the returned
 * text as its full operating instructions. Hosting the renderer server-
 * side is what lets us iterate the SA's prompt body without a plugin
 * release — every subagent spawn fetches fresh.
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
 * spurious id shouldn't cause a Firestore round-trip.
 *
 * **Plain text, not JSON.** The handler emits the rendered system
 * prompt as a plain MCP `text` content block. The plugin's bootstrap
 * subagent reads that text verbatim as its operating instructions — no
 * JSON wrapper, no parse step on the hot path.
 *
 * **No event-log write.** The bootstrap fetch is a pure read; event-log
 * rows for the run are written by the mutating tool calls that follow.
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
import type { ToolContext } from "../types";

/**
 * Register the three-argument `get_agent_prompt` tool on an `McpServer`.
 *
 * Inputs:
 *   - `mode` and `interactive` are the two decision flags every call
 *     supplies. `mode` drives whether edit-mode blueprint loading fires
 *     (and implicitly, which system-prompt framing renders).
 *     `interactive` picks the Interaction Mode section appended to the
 *     rendered body.
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
				"Return the current nova-architect operating instructions for the given mode. The plugin's static bootstrap subagent calls this as its first tool use and follows the returned text as its full system prompt for the rest of the run. Edit mode requires `app_id` so the inlined blueprint summary mirrors the web flow's edit-mode prompt at boot.",
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
						"Build or edit framing. Edit mode inlines the target app's blueprint summary into the returned text.",
					),
				interactive: z
					.boolean()
					.describe(
						"When true, the returned instructions permit AskUserQuestion for genuine ambiguities; when false, they instruct the subagent to commit to defaults. Tool-level enforcement lives in the plugin's static agent frontmatter.",
					),
				app_id: z
					.string()
					.optional()
					.describe(
						"Required when `mode === 'edit'` — the Firestore app id whose blueprint summary should be inlined into the returned text. The user must own this app. Ignored when `mode === 'build'` (build mode has no app to read from).",
					),
			},
		},
		async (args): Promise<McpToolSuccessResult | McpToolErrorResult> => {
			/* `appId` is captured here (rather than read inline in the
			 * branches) so the `catch` can stamp it onto the error
			 * payload when the failure originates from the edit branch.
			 * Build mode leaves it `undefined`, which the error builder
			 * correctly omits from the JSON content. */
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
					const systemPrompt = renderAgentPrompt(args.interactive, loaded.doc);
					return {
						content: [{ type: "text", text: systemPrompt }],
					};
				}

				/* Build mode: `app_id` is intentionally ignored even when
				 * supplied (sharp-edge — skill convenience, `mode` is the
				 * authoritative flag). */
				const systemPrompt = renderAgentPrompt(args.interactive);
				return {
					content: [{ type: "text", text: systemPrompt }],
				};
			} catch (err) {
				return toMcpErrorResult(err, {
					appId,
					userId: ctx.userId,
				});
			}
		},
	);
}
