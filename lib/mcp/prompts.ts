/**
 * Server-side source of truth for the `nova-architect` agent definition.
 *
 * The MCP `get_agent_prompt` tool calls `renderAgentPrompt` to produce the
 * `{ frontmatter, system_prompt }` payload that the plugin skill writes to
 * `<plugin-root>/agents/nova-architect-{runId}.md` before spawning the
 * subagent. Keeping the renderer server-side means iterating on the
 * prompt, the model, the reasoning effort, or the tool allowlist is picked
 * up by the next skill invocation without a plugin release.
 *
 * Three flags drive the rendered output, each with a single concern:
 *
 * 1. **`mode`** (`"build"` | `"edit"`) selects the tool surface only —
 *    build mode exposes the generation tools (`generate_schema`,
 *    `generate_scaffold`, `add_module`, `create_app`); edit mode hides
 *    them because they would either no-op against an existing app or
 *    catastrophically replace its structure. `mode` does **not** branch
 *    the system prompt directly — the doc presence does that (see #3).
 *    `mode` also picks the agent description shown in `/agents`.
 * 2. **`interactive`** controls whether the spawned subagent can call
 *    the `AskUserQuestion` tool. When `false`, the frontmatter emits
 *    `disallowedTools: ["AskUserQuestion"]` so Claude Code physically
 *    blocks the tool — a prompt-only "don't ask" instruction is weaker
 *    than a tool-allowlist gate. The interactivity *prompt block* is
 *    appended either way so the subagent understands the contract.
 * 3. **`editDoc`** (optional `BlueprintDoc`) is what selects the
 *    system-prompt flavor. Threading it through to
 *    `buildSolutionsArchitectPrompt` is what gives the edit-mode
 *    subagent its full edit framing (`EDIT_PREAMBLE`) plus the inlined
 *    `summarizeBlueprint(doc)` at boot — exactly the same prompt the
 *    web flow's `/api/chat` edit mode uses, single source of truth.
 *    Build callers pass `undefined` (or omit it); edit callers pass the
 *    loaded blueprint. Empty docs (`moduleOrder.length === 0`) fall
 *    back to the build prompt because there's nothing to edit yet.
 *
 * **Tool-name vocabulary in the SA prompts.** `EDIT_PREAMBLE` and
 * `SHARED_TAIL` from `lib/agent/prompts.ts` were authored for the web
 * flow and reference the SA's camelCase tool names (`searchBlueprint`,
 * `validateApp`). The MCP surface exposes the same tools under
 * snake_case (`search_blueprint`, `validate_app`). The model bridges
 * the two by name resolution in practice; the cosmetic drift is
 * accepted for v1 and a unified prompt-vocabulary refactor is left for
 * a future iteration when the web/MCP surfaces converge further.
 */

import { buildSolutionsArchitectPrompt } from "@/lib/agent/prompts";
import type { BlueprintDoc } from "@/lib/domain";
import { type ReasoningEffort, SA_MODEL, SA_REASONING } from "@/lib/models";

/**
 * Discriminator for the two agent flavors we emit. Build flavor exposes
 * the full generation toolset; edit flavor strips creators in favor of
 * fine-grained mutators. Note this only controls the *tools* allowlist
 * + the agent description; the *system prompt* branches on `editDoc`
 * presence inside `buildSolutionsArchitectPrompt`.
 */
export type PromptMode = "build" | "edit";

/**
 * Wire shape for the YAML frontmatter the plugin skill writes above the
 * system prompt body. Mirrors Claude Code's `agents/*.md` schema
 * (verified against https://code.claude.com/docs/en/sub-agents):
 *
 * - `name` — agent slug, used by the parent agent's `Agent` tool to
 *   reference this subagent. Always `"nova-architect"`; uniqueness across
 *   parallel runs is handled by the per-run filename suffix the skill
 *   appends, not by varying this field.
 * - `description` — one-line summary surfaced in `/agents` listings.
 * - `model` — Claude Code model selector. Short aliases (`opus` |
 *   `sonnet` | `haiku`) are preferred because the harness resolves them
 *   to the current release of that tier automatically; the mapper falls
 *   back to a full model ID when `SA_MODEL` isn't one of the three
 *   tiers, so the type stays `string` rather than a strict literal union.
 * - `effort` — Anthropic adaptive-thinking effort token. Typed against
 *   the `ReasoningEffort` union so edits to the allowed values in
 *   `lib/models.ts` ripple here automatically.
 * - `maxTurns` — safety bound on the subagent's tool-call loop.
 * - `tools` / `disallowedTools` — Claude Code tool-allowlist discipline.
 *   `tools` is the *allowlist* field (Claude Code silently ignores
 *   unknown frontmatter keys, so the name has to be exact);
 *   `disallowedTools` is the deny overlay. The subagent sees the union
 *   of (tools − disallowedTools). Both fields are optional because
 *   omitting `tools` inherits the parent's tool surface and omitting
 *   `disallowedTools` is a no-op.
 */
export interface AgentPromptFrontmatter {
	name: "nova-architect";
	description: string;
	/** Short alias preferred (`opus` | `sonnet` | `haiku`); a full model
	 * ID is accepted as a fallback when no tier prefix matches. */
	model: string;
	effort: ReasoningEffort;
	maxTurns: number;
	tools?: string[];
	disallowedTools?: string[];
}

/**
 * Composite payload returned by `renderAgentPrompt`. The plugin skill
 * serializes this to disk as `---\n<yaml frontmatter>\n---\n<system_prompt>`
 * before spawning the subagent.
 */
export interface AgentPromptPayload {
	frontmatter: AgentPromptFrontmatter;
	system_prompt: string;
}

/**
 * Full Nova MCP toolset the build-mode subagent may call. Names are the
 * MCP-prefixed identifiers Claude Code expects (`mcp__<server>__<tool>`).
 *
 * The list intentionally enumerates every tool rather than wildcarding —
 * misspellings or new tools that should *not* be exposed (e.g. an admin
 * surface) become explicit additions, not silent inclusions.
 */
const ALLOWED_MCP_TOOLS_BUILD = [
	"mcp__nova__create_app",
	"mcp__nova__generate_schema",
	"mcp__nova__generate_scaffold",
	"mcp__nova__add_module",
	"mcp__nova__search_blueprint",
	"mcp__nova__get_app",
	"mcp__nova__get_module",
	"mcp__nova__get_form",
	"mcp__nova__get_field",
	"mcp__nova__add_fields",
	"mcp__nova__add_field",
	"mcp__nova__edit_field",
	"mcp__nova__remove_field",
	"mcp__nova__update_module",
	"mcp__nova__update_form",
	"mcp__nova__create_form",
	"mcp__nova__remove_form",
	"mcp__nova__create_module",
	"mcp__nova__remove_module",
	"mcp__nova__validate_app",
];

/**
 * Edit-mode toolset — the build set minus the four generators that
 * would either no-op against an existing app or catastrophically replace
 * its structure (`create_app`, `generate_schema`, `generate_scaffold`,
 * `add_module`). Derived from the build set so the two lists cannot
 * drift; adding a new generation tool only needs an entry in the build
 * list and an exclusion here.
 */
const ALLOWED_MCP_TOOLS_EDIT = ALLOWED_MCP_TOOLS_BUILD.filter(
	(t) =>
		t !== "mcp__nova__generate_schema" &&
		t !== "mcp__nova__generate_scaffold" &&
		t !== "mcp__nova__add_module" &&
		t !== "mcp__nova__create_app",
);

/**
 * Per-mode interaction-policy text appended to the system prompt. The
 * `autonomous` block both informs the subagent of the contract *and*
 * tells it that `AskUserQuestion` is unavailable — the frontmatter's
 * `disallowedTools` enforces it, but a prompt-level statement keeps the
 * model from spending a turn discovering the missing tool.
 *
 * Each block leads with `\n\n` so the `## Interaction Mode` heading
 * lands after a blank line (markdown idiom); `buildSolutionsArchitectPrompt`'s
 * trailing section already terminates without a blank, so this composes
 * cleanly into a sequence of well-separated sections regardless of which
 * prompt body precedes it.
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
 * Compose the `{ frontmatter, system_prompt }` payload for the
 * `nova-architect` subagent.
 *
 * The system prompt body delegates entirely to
 * `buildSolutionsArchitectPrompt`, the same renderer the web flow's
 * `/api/chat` route uses. Threading `editDoc` through means the
 * MCP edit-mode subagent boots with exactly the prompt the web flow's
 * SA gets in edit mode — `EDIT_PREAMBLE` framing ("you have full
 * visibility, only ask about intent") plus an inlined
 * `summarizeBlueprint(doc)` so the subagent knows the app's structure
 * at turn 0 instead of having to spend a tool call to fetch it. Single
 * source of truth, single rendering branch, no cross-surface drift.
 *
 * Build callers pass `undefined` (or omit `editDoc`); edit callers
 * pass the loaded blueprint. Empty docs (`moduleOrder.length === 0`)
 * intentionally fall back to the build prompt — there's nothing to
 * edit yet, so `buildSolutionsArchitectPrompt`'s degenerate-edit branch
 * delivers the build framing instead.
 */
export function renderAgentPrompt(
	mode: PromptMode,
	interactive: boolean,
	editDoc?: BlueprintDoc,
): AgentPromptPayload {
	/* Single delegation: `buildSolutionsArchitectPrompt` already branches
	 * on `doc?.moduleOrder.length > 0`, so passing `editDoc` straight
	 * through here lets one renderer cover both surfaces. Build mode +
	 * empty-doc edit mode both land in the build branch; edit mode with a
	 * populated doc lands in the edit branch with `summarizeBlueprint`
	 * inlined. The MCP-specific concerns (interactivity policy, tool
	 * allowlist, frontmatter shape) compose around the body, never inside
	 * the body — that's what keeps the web/MCP surfaces in lockstep. */
	const baseSystem = buildSolutionsArchitectPrompt(editDoc);

	const interactivityBlock = interactive
		? INTERACTIVITY_INSTRUCTIONS.interactive
		: INTERACTIVITY_INSTRUCTIONS.autonomous;

	const system_prompt = `${baseSystem}${interactivityBlock}`;

	/* Description shows up in `/agents` listings and the Agent-tool
	 * picker, so it should describe the *spawned* agent's capability
	 * shape — the three combinations are meaningfully distinct from the
	 * caller's perspective. Note `mode` is the right discriminator here
	 * (not `editDoc` presence): the description is about which tools the
	 * subagent has, which `mode` controls. */
	const description =
		mode === "edit"
			? "Edit an existing Nova CommCare app via the nova MCP tools."
			: interactive
				? "Build a Nova CommCare app via the nova MCP tools, asking clarifying questions when needed."
				: "Build a Nova CommCare app autonomously via the nova MCP tools.";

	const baseTools =
		mode === "edit" ? ALLOWED_MCP_TOOLS_EDIT : ALLOWED_MCP_TOOLS_BUILD;

	const frontmatter: AgentPromptFrontmatter = {
		name: "nova-architect",
		description,
		model: mapModelToClaudeCode(SA_MODEL),
		effort: SA_REASONING.effort,
		maxTurns: 100,
		/* Interactive mode adds `AskUserQuestion` to `tools`; autonomous
		 * mode both omits it from `tools` *and* lists it in
		 * `disallowedTools` so Claude Code physically blocks the call.
		 * Belt-and-suspenders: if a future schema change widens the
		 * allowlist semantics, the deny list still holds. Note the
		 * Claude Code frontmatter field is literally `tools` (the
		 * allowlist) — `allowedTools` would be silently ignored. */
		tools: interactive ? [...baseTools, "AskUserQuestion"] : baseTools,
		...(interactive ? {} : { disallowedTools: ["AskUserQuestion"] }),
	};

	return { frontmatter, system_prompt };
}

/**
 * Map a Nova `SA_MODEL` constant (e.g. `"claude-opus-4-7"`) to the short
 * Claude Code frontmatter slug (`"opus"` | `"sonnet"` | `"haiku"`). Short
 * names let the harness resolve the *current* version of that tier
 * automatically, so promotions to a new release don't require a plugin
 * publish or a Nova deploy.
 *
 * Falls through to the raw model id when no tier prefix matches — this
 * preserves debuggability if `SA_MODEL` is changed to an exotic id, and
 * lets the test suite assert on the documented short-slug shape.
 *
 * The return type uses the `"opus" | "sonnet" | "haiku" | (string & {})`
 * pattern so callers get IntelliSense on the three short slugs while
 * the fallthrough branch keeps typing honest — TypeScript won't
 * collapse the union to plain `string`, so the literals remain
 * visible in autocomplete.
 */
function mapModelToClaudeCode(
	modelId: string,
): "opus" | "sonnet" | "haiku" | (string & {}) {
	if (modelId.startsWith("claude-opus")) return "opus";
	if (modelId.startsWith("claude-sonnet")) return "sonnet";
	if (modelId.startsWith("claude-haiku")) return "haiku";
	return modelId;
}
