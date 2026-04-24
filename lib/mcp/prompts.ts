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
 *    (`EDIT_PREAMBLE`) plus the inlined `summarizeBlueprint(doc)` at
 *    boot — the same prompt the web flow's `/api/chat` edit mode uses,
 *    single source of truth. Build callers pass `undefined`; edit
 *    callers pass the loaded blueprint. Empty docs
 *    (`moduleOrder.length === 0`) fall back to the build prompt because
 *    there's nothing to edit yet — matches the web flow's degenerate
 *    case fallthrough.
 *
 * **Tool-name vocabulary.** `EDIT_PREAMBLE` and `SHARED_TAIL` in
 * `lib/agent/prompts.ts` reference the SA's camelCase tool names
 * (`searchBlueprint`, `validateApp`). The MCP surface exposes the same
 * tools under snake_case (`search_blueprint`, `validate_app`). The
 * model resolves the two by name at call time.
 */

import { buildSolutionsArchitectPrompt } from "@/lib/agent/prompts";
import type { BlueprintDoc } from "@/lib/domain";

/**
 * Wire enum for the two modes the MCP surface accepts at the tool
 * boundary. Exported so `get_agent_prompt`'s Zod input schema can
 * `satisfies`-check its enum literals against this union — the renderer
 * itself does not branch on `mode`; the build/edit fork runs inside
 * `buildSolutionsArchitectPrompt` via `editDoc` presence.
 */
export type PromptMode = "build" | "edit";

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
summary. Do NOT attempt to ask the user questions — the AskUserQuestion
tool is not available to you in this mode.`,
} as const;

/**
 * Compose the nova-architect subagent's system prompt body.
 *
 * The body delegates entirely to `buildSolutionsArchitectPrompt`, the
 * same renderer the web flow's `/api/chat` route uses. Threading
 * `editDoc` through means the MCP edit-mode subagent boots with exactly
 * the prompt the web flow's SA gets in edit mode — `EDIT_PREAMBLE`
 * framing ("you have full visibility, only ask about intent") plus an
 * inlined `summarizeBlueprint(doc)` so the subagent knows the app's
 * structure at turn 0 instead of having to spend a tool call to fetch
 * it. Single source of truth, single rendering branch, no cross-
 * surface drift.
 *
 * Build callers pass `undefined` (or omit `editDoc`); edit callers
 * pass the loaded blueprint. Empty docs (`moduleOrder.length === 0`)
 * intentionally fall back to the build prompt — `buildSolutionsArchitectPrompt`'s
 * degenerate-edit branch delivers the build framing instead.
 */
export function renderAgentPrompt(
	interactive: boolean,
	editDoc?: BlueprintDoc,
): string {
	const baseSystem = buildSolutionsArchitectPrompt(editDoc);
	const interactivityBlock = interactive
		? INTERACTIVITY_INSTRUCTIONS.interactive
		: INTERACTIVITY_INSTRUCTIONS.autonomous;
	return `${baseSystem}${interactivityBlock}`;
}
