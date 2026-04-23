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
 * Two flags drive the rendered output:
 *
 * 1. **`mode`** (`"build"` | `"edit"`) selects the tool surface. Build
 *    mode exposes the generation tools (`generate_schema`,
 *    `generate_scaffold`, `add_module`, `create_app`); edit mode hides
 *    them because they would either no-op against an existing app or
 *    catastrophically replace its structure. The deliberate design is to
 *    use the *build* SA system prompt as the base in both modes (calling
 *    `buildSolutionsArchitectPrompt(undefined)`) and append a small
 *    `## Edit Mode` header — the per-skill task prompt carries the actual
 *    blueprint summary, so we avoid pre-rendering one for an app the
 *    skill may not have read yet.
 * 2. **`interactive`** controls whether the spawned subagent can call the
 *    `AskUserQuestion` tool. When `false`, the frontmatter emits
 *    `disallowedTools: ["AskUserQuestion"]` so Claude Code physically
 *    blocks the tool — a prompt-only "don't ask" instruction is weaker
 *    than a tool-allowlist gate. The interactivity *prompt block* is
 *    appended either way so the subagent understands the contract.
 */

import { buildSolutionsArchitectPrompt } from "@/lib/agent/prompts";
import { SA_MODEL, SA_REASONING } from "@/lib/models";

/**
 * Discriminator for the two agent flavors we emit. Build flavor exposes
 * the full generation toolset; edit flavor strips creators in favor of
 * fine-grained mutators.
 */
export type PromptMode = "build" | "edit";

/**
 * Wire shape for the YAML frontmatter the plugin skill writes above the
 * system prompt body. Mirrors Claude Code's `agents/*.md` schema:
 *
 * - `name` — agent slug, used by the parent agent's `Agent` tool to
 *   reference this subagent. Always `"nova-architect"`; uniqueness across
 *   parallel runs is handled by the per-run filename suffix the skill
 *   appends, not by varying this field.
 * - `description` — one-line summary surfaced in `/agents` listings.
 * - `model` — short Claude Code slug (`opus` | `sonnet` | `haiku`) so
 *   the harness picks up the current version of that tier automatically.
 * - `effort` — Anthropic adaptive-thinking effort token, mirrors what the
 *   web SA uses so behavior matches across surfaces.
 * - `maxTurns` — safety bound on the subagent's tool-call loop.
 * - `allowedTools` / `disallowedTools` — Claude Code tool-allowlist
 *   discipline. Both fields are emitted as small string arrays; the
 *   subagent sees the union of (allowedTools − disallowedTools).
 */
export interface AgentPromptFrontmatter {
	name: "nova-architect";
	description: string;
	model: string;
	effort: string;
	maxTurns: number;
	allowedTools?: string[];
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
 * The system prompt body reuses `buildSolutionsArchitectPrompt`
 * (Nova's web-flow SA renderer) so both surfaces stay in sync — any
 * tweak to the SA's core prompt shows up in the spawned subagent on the
 * next render. Edit mode passes `undefined` for the doc; the per-skill
 * task prompt provides the blueprint summary instead, because the skill
 * may invoke this tool before it has fetched the app.
 */
export function renderAgentPrompt(
	mode: PromptMode,
	interactive: boolean,
): AgentPromptPayload {
	/* Use the build-mode rendering as the base for both modes. The edit
	 * preamble Nova's web flow uses is replaced by a much shorter
	 * `## Edit Mode` header below, because the skill's task prompt
	 * already frames the edit and includes the live blueprint summary. */
	const baseSystem = buildSolutionsArchitectPrompt(undefined);

	const interactivityBlock = interactive
		? INTERACTIVITY_INSTRUCTIONS.interactive
		: INTERACTIVITY_INSTRUCTIONS.autonomous;

	/* Edit mode appends a tight directive: the subagent must read the
	 * blueprint via `nova.get_app` before mutating, even if the task
	 * prompt already includes a summary — the task prompt's summary may
	 * be stale by the time the subagent acts on it. */
	const modeHeader =
		mode === "edit"
			? "\n\n## Edit Mode\n\nThe user has asked you to modify an existing app. The task prompt carries the app_id and the user's instruction. Before making changes, call `nova.get_app` with the app_id to read the current blueprint summary."
			: "";

	const system_prompt = `${baseSystem}${modeHeader}${interactivityBlock}`;

	/* Description shows up in `/agents` listings and the Agent-tool
	 * picker, so it should describe the *spawned* agent's capability
	 * shape — the three combinations are meaningfully distinct from the
	 * caller's perspective. */
	const description =
		mode === "edit"
			? "Edit an existing Nova CommCare app via the nova MCP tools."
			: interactive
				? "Build a Nova CommCare app via the nova MCP tools, asking clarifying questions when needed."
				: "Build a Nova CommCare app autonomously via the nova MCP tools.";

	const allowedTools =
		mode === "edit" ? ALLOWED_MCP_TOOLS_EDIT : ALLOWED_MCP_TOOLS_BUILD;

	const frontmatter: AgentPromptFrontmatter = {
		name: "nova-architect",
		description,
		model: mapModelToClaudeCode(SA_MODEL),
		effort: SA_REASONING.effort,
		maxTurns: 100,
		/* Interactive mode adds `AskUserQuestion` to `allowedTools`;
		 * autonomous mode both omits it from `allowedTools` *and* lists
		 * it in `disallowedTools` so Claude Code physically blocks the
		 * call. Belt-and-suspenders: if a future schema change makes
		 * `allowedTools` permissive-by-default, the deny list still
		 * holds. */
		allowedTools: interactive
			? [...allowedTools, "AskUserQuestion"]
			: allowedTools,
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
 */
function mapModelToClaudeCode(modelId: string): string {
	if (modelId.startsWith("claude-opus")) return "opus";
	if (modelId.startsWith("claude-sonnet")) return "sonnet";
	if (modelId.startsWith("claude-haiku")) return "haiku";
	return modelId;
}
