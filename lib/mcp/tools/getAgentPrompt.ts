/**
 * `nova.get_agent_prompt` — self-fetch bootstrap tool.
 *
 * Scope: `nova.read` (enforced at the verify layer — the route handler
 * declares this tool's mount with `scopes: ["nova.read"]` so by the time
 * this body runs the JWT already proved the scope; no per-handler check).
 *
 * The plugin ships one static subagent file (autonomous mode) and two
 * top-level skills (build, edit) whose bodies instruct their executor
 * to call this tool on turn 0 and treat the returned text as their
 * full operating instructions. Hosting the renderer server-side is
 * what lets us iterate the SA's prompt body without a plugin release —
 * every spawn / skill invocation fetches fresh.
 *
 * **Edit mode loads the blueprint here.** When `mode === "edit"`, the
 * tool requires `app_id`, ownership-gates on it, loads the blueprint,
 * and passes the doc through to `renderAgentPrompt` so the caller boots
 * with `EDIT_PREAMBLE` framing + an inlined `summarizeBlueprint(doc)` —
 * exact parity with the web flow's edit mode (`/api/chat`). Without
 * this round trip the edit caller would have to spend its first tool
 * call re-fetching what the server already has on hand.
 *
 * Build modes (`build` and `autonomous_build`) ignore `app_id` even
 * when present. Skill simplicity wins here: `mode` is the authoritative
 * flag, and a spurious id shouldn't cause a blueprint load.
 *
 * **Single string discriminator, no boolean.** Earlier revisions used
 * `mode: enum + interactive: boolean` as two parallel inputs. The model
 * fumbled the boolean repeatedly at the tool-call boundary (serializing
 * `true` as the string `"true"`), wasting retry turns. Folding the
 * interactivity axis into a 3-value `mode` enum (`build`,
 * `autonomous_build`, `edit`) collapses both axes onto the one shape
 * the model handles reliably. `autonomous_edit` is intentionally not
 * representable — no skill needs it.
 *
 * **Plain text when it fits; lossless pages when it does not.** A prompt inside
 * the transport budget remains one plain MCP `text` content block. One larger than the
 * conservative model-facing single-result budget is returned as a
 * snapshot-bound JSON page; callers follow `next_cursor`, concatenate
 * `prompt_chunk`, verify the advertised length/digest, then check the terminal
 * marker. No authored guidance or app-summary prose is trimmed.
 *
 * **No event-log write.** The bootstrap fetch is a pure read; event-log
 * rows for the run are written by the mutating tool calls that follow.
 */

import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import {
	McpInvalidInputError,
	type McpToolErrorResult,
	type McpToolSuccessResult,
	toMcpErrorResult,
} from "../errors";
import { loadAppBlueprint } from "../loadApp";
import { deliverAgentPrompt } from "../promptDelivery";
import { type PromptMode, renderAgentPrompt } from "../prompts";
import { LARGE_RESULT_META } from "../resultSize";
import type { ToolContext } from "../types";

/**
 * Register the mode/app/cursor `get_agent_prompt` tool on an `McpServer`.
 *
 * Inputs:
 *   - `mode` is the single decision discriminator. It picks the prompt
 *     framing (build vs. edit) and the interactivity block (interactive
 *     for `build` / `edit`, autonomous for `autonomous_build`). Edit
 *     mode additionally triggers blueprint loading so the rendered text
 *     can inline the summary at boot.
 *   - `app_id` is conditionally required: required in edit mode (so the
 *     handler can ownership-gate + inline the blueprint summary into
 *     the system prompt), ignored in build modes (skill convenience —
 *     `mode` is the authoritative discriminator). The conditional is a
 *     cross-field rule the wire schema doesn't express, so the handler
 *     enforces it via a typed `McpInvalidInputError` throw at the top.
 *   - `cursor` is absent on the first call and repeats the opaque
 *     `next_cursor` from an oversized response. Every page re-renders (and in
 *     edit mode reloads) the prompt; its digest refuses mixed snapshots.
 *
 * `ctx.userId` rides every error envelope so cross-tenant audit logging
 * (in `toMcpErrorResult`'s `McpAccessError` branch) stays uniform across
 * every tool. The build-mode happy paths don't read `ctx.userId`; edit
 * mode reads it for `loadAppBlueprint` to gate the blueprint load.
 */
export function registerGetAgentPrompt(
	server: McpServer,
	ctx: ToolContext,
): void {
	server.registerTool(
		"get_agent_prompt",
		{
			description:
				"Return the current nova-architect operating instructions for the given mode. A prompt that fits the conservative model-facing result budget arrives as complete plain text ending in `NOVA-PROMPT-END`. Otherwise the text block is a `nova-agent-prompt-page` JSON object: `offset_unit` is `unicode-code-points`, so `chunk_start`, `chunk_end`, and `prompt_length` count Unicode code points and chunks never split a surrogate pair. Concatenate `prompt_chunk` in order by calling this tool with the same mode/app_id and each `next_cursor`; require one unchanged `prompt_sha256`, adjacent chunk offsets, final `chunk_end === prompt_length`, `complete: true`, and the `NOVA-PROMPT-END` ending before following it. Edit mode requires `app_id` and every continuation reloads it so a changed snapshot is refused instead of mixed.",
			/* This tool returns a whole system prompt, an order of
			 * magnitude past what a typical tool result carries, so it
			 * declares its own size rather than inheriting a default
			 * tuned for ordinary payloads. See `../resultSize`. */
			_meta: LARGE_RESULT_META,
			inputSchema: z.object({
				/* `as const satisfies readonly PromptMode[]` ties the wire
				 * enum to the renderer's exported `PromptMode` union: if a
				 * new flavor lands in `prompts.ts` the `satisfies`
				 * constraint becomes a compile error here until the literal
				 * list is updated, instead of silently rejecting the new
				 * mode at runtime as a Zod `invalid_enum_value`. The
				 * renderer is the single source of truth; this is the wire
				 * side accepting it. */
				mode: z
					.enum([
						"build",
						"autonomous_build",
						"edit",
					] as const satisfies readonly PromptMode[])
					.describe(
						"Selects the prompt body and interactivity. `build` and `edit` permit AskUserQuestion for genuine ambiguities; `autonomous_build` instructs the agent to commit to defaults instead. `edit` inlines the target app's blueprint summary into the returned text. (`autonomous_edit` isn't a real workflow and isn't representable.)",
					),
				app_id: z
					.string()
					.optional()
					.describe(
						"Required when `mode === 'edit'`, the app id whose blueprint summary should be inlined into the returned text. The user must own this app. Ignored for `build` and `autonomous_build` (no app to read from).",
					),
				cursor: z
					.string()
					.max(512)
					.optional()
					.describe(
						"Opaque continuation cursor from an oversized `nova-agent-prompt-page`. Repeat the same mode and app_id. Omit on the first call or when restarting after a changed-snapshot refusal.",
					),
			}),
		},
		async (args): Promise<McpToolSuccessResult | McpToolErrorResult> => {
			/* `appId` is captured here (rather than read inline in the
			 * branches) so the `catch` can stamp it onto the error
			 * payload when the failure originates from the edit branch.
			 * Build modes leave it `undefined`, which the error builder
			 * correctly omits from the JSON content. */
			const appId = args.mode === "edit" ? args.app_id : undefined;
			/* The interactive/autonomous split was previously a separate
			 * `interactive: boolean` input. We collapsed it into `mode`
			 * because Anthropic's tool-call surface fumbles boolean
			 * literals far more often than enum strings; the handler
			 * reconstructs the boolean here so `renderAgentPrompt`'s
			 * signature stays unchanged. Only `autonomous_build` sets
			 * this false; both `build` and `edit` are interactive. */
			const interactive = args.mode !== "autonomous_build";
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
					/* `loadAppBlueprint` ownership-gates and loads in one
					 * read; throws `McpAccessError` on cross-tenant
					 * probe or vanished row. The renderer itself decides the
					 * build/edit framing off the doc. Every persisted app has the
					 * canonical starter, so edit mode receives its preamble and
					 * inlined blueprint summary. */
					const loaded = await loadAppBlueprint(args.app_id, ctx.userId);
					const systemPrompt = renderAgentPrompt(interactive, loaded.doc);
					return deliverAgentPrompt(systemPrompt, args.cursor);
				}

				/* Build modes (`build` and `autonomous_build`): `app_id` is
				 * intentionally ignored even when supplied (sharp-edge —
				 * skill convenience, `mode` is the authoritative flag). */
				const systemPrompt = renderAgentPrompt(interactive);
				return deliverAgentPrompt(systemPrompt, args.cursor);
			} catch (err) {
				return toMcpErrorResult(err, {
					appId,
					userId: ctx.userId,
				});
			}
		},
	);
}
