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
import { AUTONOMOUS_FEATURE_FLAG_GUIDANCE } from "@/lib/publish/hqFeatureFlags";

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
 * results are size-capped by rules the server can't observe. When a
 * result overruns, the host replaces it with a short preview plus a
 * path to the full text on disk; the autonomous subagent's tool
 * allowlist is MCP tools only, so it cannot open that file and proceeds
 * on the preview. `MAX_DELIVERABLE_PROMPT_CHARS` keeps us clear of the
 * cap, but a cap we don't control can move, so the marker is what makes
 * a short delivery *loud*: the bootstrap refuses to build without it
 * rather than silently running on a fraction of its instructions.
 *
 * Anything appended after this constant is invisible to that check, so
 * it stays last in `renderAgentPrompt` — including after the edit-mode
 * app-state block.
 */
export const PROMPT_END_MARKER = "NOVA-PROMPT-END";

/**
 * Char budget for a rendered prompt, enforced by
 * `lib/mcp/__tests__/promptDeliveryBudget.test.ts`.
 *
 * Two independent host limits sit above this number, and overrunning
 * either one strands the prompt in a file the autonomous subagent
 * cannot read:
 *
 *   - a per-tool-result char cap, which `get_agent_prompt` raises for
 *     itself (see `MAX_RESULT_SIZE_CHARS` in `tools/getAgentPrompt.ts`);
 *   - an MCP-wide token cap of roughly this magnitude in chars, which
 *     nothing server-side can raise.
 *
 * The second is the real ceiling, and it is denominated in TOKENS while
 * everything we can measure here is chars. The host applies a rough
 * 4-chars-per-token estimate only as a fast pre-check and then counts
 * for real, so the conversion has to be assumed pessimistically rather
 * than taken at 4: the blueprint summary is dense with identifiers,
 * paths, and punctuation, which tokenize worse than the prose around
 * it. This number is sized as though a char were a third of a token,
 * which leaves the budget deliberately short of what the cap would
 * probably allow.
 *
 * Being wrong in that direction costs a `get_app` round trip on the
 * largest apps. Being wrong in the other direction costs the whole
 * prompt, so the asymmetry decides the number.
 *
 * **This number is an estimate, and it is not a place to economize.** It
 * was 72,000 and the prompt reached 71,944 through ordinary growth, at
 * which point the next unit to add a paragraph failed CI in test shards
 * that give no hint the cause was prose. That is a tripwire, not a
 * budget, and the answer to it is never to write the guidance worse.
 * 75,000 keeps the same pessimistic char-to-token assumption and stays
 * three quarters of the per-result char cap Nova itself declares
 * (`resultSize.ts::MAX_RESULT_SIZE_CHARS`, 100,000).
 *
 * It does not buy much, and it is not meant to. The prompt cannot keep
 * growing by raising this: the durable fix is moving reference material
 * — the XPath function tables, the field-kind guide — behind a call the
 * agent makes when it needs them, so a section can be added without
 * every consumer paying for it. Raise this again only alongside that
 * work, or after measuring the real cap rather than estimating it.
 */
export const MAX_DELIVERABLE_PROMPT_CHARS = 75_000;

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
tool is not available to you in this mode.

### Publishing FYI

${AUTONOMOUS_FEATURE_FLAG_GUIDANCE}`,
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
	const appStateBlock = isEditableDoc(editDoc)
		? appStateBlockFor(
				editDoc,
				MAX_DELIVERABLE_PROMPT_CHARS -
					baseSystem.length -
					interactivityBlock.length -
					tail.length,
			)
		: "";
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
 * The edit-mode "Current app state" block, or a pointer to the tools
 * that read the same thing when the app is too large to inline.
 *
 * The summary is the one unbounded part of this prompt: it scales with
 * the app, and production apps already render past 70,000 chars — more
 * than the whole rest of the prompt. Inlining one of those would push
 * the result past the host's MCP token cap, which no server-side
 * declaration can lift, and the prompt would arrive as a preview of
 * itself. The caller would then be holding neither its instructions nor
 * the app.
 *
 * So a summary that doesn't fit is not truncated — half a structural
 * summary reads like a whole one, and an agent that believes it has
 * seen the app will confidently edit the part it can't see. It is
 * replaced by the instruction to go read the app through the tools that
 * return it in pieces. That costs a round trip on the largest apps and
 * keeps every other guarantee intact.
 */
function appStateBlockFor(doc: BlueprintDoc, budget: number): string {
	const summary = summarizeBlueprint(doc);
	const block = `\n\n---\n\n## Current app state\n\n${summary}`;
	if (block.length <= budget) return block;
	return `\n\n---\n\n## Current app state

This app's structure is too large to include here, it would push these
instructions past what one tool result can carry, and you would receive
a fragment of them instead.

Read it before you edit: \`get_app\` for the whole summary, \`get_module\`
and \`get_form\` for one piece at a time, \`search_blueprint\` to find a
field or property by name. Do not assume any part of this app's shape
you have not read.`;
}
