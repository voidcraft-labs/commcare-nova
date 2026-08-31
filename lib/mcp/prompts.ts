/**
 * Server-side source of truth for the `nova-architect` subagent's system
 * prompt body.
 *
 * The plugin ships two static bootstrap subagents whose bodies instruct
 * the spawned subagent to call `get_agent_prompt` as its first tool use
 * and treat the returned text as its full operating instructions.
 * Frontmatter (model, effort, tool allowlist, AskUserQuestion gate) is
 * baked into those plugin files because Claude Code memoizes agent
 * definitions at session start; the server cannot drive dynamic
 * frontmatter. What the server owns here is the prompt *body*: the
 * build/edit framing, the blueprint summary inlined for edit runs, and
 * the interaction-mode section.
 *
 * Two flags drive the rendered output:
 *
 * 1. **`interactive`** picks the Interaction Mode section (the
 *    autonomous variant instructs the subagent not to call
 *    AskUserQuestion; tool-level enforcement lives in the plugin's
 *    autonomous agent file's `disallowedTools` frontmatter).
 * 2. **`editDoc`** (optional `BlueprintDoc`) is the build/edit switch.
 *    Threading it through to `buildSolutionsArchitectPrompt` is what
 *    gives edit-mode subagents their full edit framing
 *    (`EDIT_PREAMBLE`), and this renderer appends the "Current app
 *    state" block (`summarizeBlueprint(doc)`) the preamble promises —
 *    INLINED here, unlike the web flow, which delivers it as a
 *    per-turn message to keep its system prompt cache-stable: a
 *    subagent fetches this prompt exactly once as its boot
 *    instructions, so there is no cross-turn prefix to protect and no
 *    message channel to ride. Build callers pass `undefined`; edit
 *    callers pass the loaded blueprint. Empty docs
 *    (`moduleOrder.length === 0`) fall back to the build prompt inside
 *    the renderer — there's nothing to edit yet, so the planning flow
 *    is the right boot — and get no state block (`isEditableDoc` is
 *    the one shared predicate, so framing and summary can't come
 *    apart).
 *
 * **Tool-name vocabulary.** `EDIT_PREAMBLE` and `SHARED_TAIL` in
 * `lib/agent/prompts.ts` reference the SA's camelCase tool names
 * (`searchBlueprint`, `createModule`). The MCP surface exposes the same
 * tools under snake_case (`search_blueprint`, `create_module`). The
 * model resolves the two by name at call time.
 */

import {
	buildMcpAgentBuildPrompt,
	buildSolutionsArchitectPrompt,
	isEditableDoc,
} from "@/lib/agent/prompts";
import { summarizeBlueprint } from "@/lib/agent/summarizeBlueprint";
import type { BlueprintDoc } from "@/lib/domain";

/**
 * Wire enum for the three modes the MCP surface accepts at the
 * `get_agent_prompt` tool boundary. The interactive/autonomous axis is
 * folded into this enum to remove the only `boolean` field in the
 * Nova MCP surface — model tool-call serialization fumbles boolean
 * literals (e.g. emits the string `"true"` instead of the literal
 * `true`) far more often than enum strings, so a single string
 * discriminator is the more reliable shape. Only the three
 * combinations actually used by the plugin's skills are expressible:
 * `autonomous_edit` isn't a real workflow and is intentionally not
 * representable.
 *
 * Exported so `get_agent_prompt`'s Zod input schema can
 * `satisfies`-check its enum literals against this union. The
 * renderer itself does not branch on `mode` — the build/edit fork
 * runs inside `buildSolutionsArchitectPrompt` via `editDoc` presence,
 * and the interactive/autonomous split is decided by the handler
 * before `renderAgentPrompt` is called.
 */
export type PromptMode = "build" | "autonomous_build" | "edit";

/**
 * Terminal marker on every rendered prompt — the proof-of-delivery the
 * plugin's bootstrap checks before it builds anything.
 *
 * The prompt reaches its executor as an MCP *tool result*, and tool
 * results can be size-capped by rules the server can't observe. The marker
 * makes a short delivery loud: the bootstrap refuses to build without it
 * rather than silently running on a fraction of its instructions.
 *
 * Anything appended after this constant is invisible to that check, so
 * it stays last in `renderAgentPrompt` — including after the edit-mode
 * app-state block.
 */
export const PROMPT_END_MARKER = "NOVA-PROMPT-END";

/**
 * Per-mode interaction-policy text appended to the system prompt. Both
 * blocks lead with `\n\n` so the `## Interaction Mode` heading lands
 * after a blank line (markdown idiom); `buildSolutionsArchitectPrompt`'s
 * trailing section already terminates without a blank, so this composes
 * cleanly into a sequence of well-separated sections regardless of
 * which prompt body precedes it.
 *
 * The autonomous block states the contract in-prompt AND relies on the
 * plugin's `disallowedTools` frontmatter for hard enforcement: the
 * prompt-level reminder keeps the model from spending a turn
 * discovering the missing tool, while the tool-allowlist gate is what
 * Claude Code physically enforces.
 */
const INTERACTIVITY_INSTRUCTIONS = {
	interactive: `

## Interaction Mode

You may use the AskUserQuestion tool when a design choice is genuinely
ambiguous and the answer would materially change the build. Do not ask
for permission to proceed; do not ask multiple questions at once; do not
ask things you can reasonably default on. Ask at most a handful of
questions per build. The user sees your question in their main session
and answers it, then you resume.`,
	autonomous: `

## Interaction Mode

You run without user interaction. Commit to a reasonable default for
every ambiguous design choice and report your decisions in the final
summary. Do NOT attempt to ask the user questions, the AskUserQuestion
tool is not available to you in this mode.`,
} as const;

/**
 * Compose the nova-architect subagent's system prompt body.
 *
 * The body delegates to `buildSolutionsArchitectPrompt`, the same
 * renderer the web flow's `/api/chat` route uses — `EDIT_PREAMBLE`
 * framing ("you have full visibility, only ask about intent") when an
 * editable blueprint is threaded through. The "Current app state" block
 * the preamble promises is appended here as the prompt's closing
 * section, so the subagent knows the app's structure at turn 0 instead
 * of having to spend a tool call to fetch it. (The web flow delivers
 * the same summary as a per-turn message instead — its system prompt
 * must stay byte-stable for the provider's exact-prefix cache; a boot
 * prompt fetched once has no such constraint.)
 *
 * Build callers pass `undefined` (or omit `editDoc`); edit callers pass the
 * loaded blueprint when the app is COMPLETE (the status-keyed fork lives in
 * `get_agent_prompt`). The renderer still fails safe to build framing for a
 * missing/in-memory empty doc, but persisted creation always returns the
 * canonical survey starter.
 */
export function renderAgentPrompt(
	interactive: boolean,
	editDoc?: BlueprintDoc,
): string {
	/* Edit mode boots the SA's edit prompt; build mode boots the MCP-only
	 * build composition — the plugin's client-side agent drives direct
	 * canonical tools (`create_app` + the shared set), which remain an
	 * immediate, unreviewed surface (the chat design pipeline never runs
	 * here). */
	const baseSystem = isEditableDoc(editDoc)
		? buildSolutionsArchitectPrompt()
		: buildMcpAgentBuildPrompt();
	const interactivityBlock = interactive
		? INTERACTIVITY_INSTRUCTIONS.interactive
		: INTERACTIVITY_INSTRUCTIONS.autonomous;
	const tail = `\n\n${PROMPT_END_MARKER}`;
	const appStateBlock = isEditableDoc(editDoc) ? appStateBlockFor(editDoc) : "";
	/* `PROMPT_END_MARKER` is last by contract — it proves the executor
	 * received the whole text, so anything after it would be outside
	 * what the check covers. The app-state block precedes it for the
	 * same reason it exists at all: it is the largest and most
	 * app-specific section, so it is the first thing a truncated
	 * delivery loses, and the marker is what turns that loss into a
	 * refusal instead of a quietly worse app. */
	return `${baseSystem}${interactivityBlock}${appStateBlock}${tail}`;
}

/**
 * The complete edit-mode "Current app state" block. The terminal marker
 * remains the delivery proof for the whole rendered prompt.
 */
function appStateBlockFor(doc: BlueprintDoc): string {
	const summary = summarizeBlueprint(doc);
	return `\n\n---\n\n## Current app state\n\n${summary}`;
}
