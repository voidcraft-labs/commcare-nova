# Phase F — Agent prompt renderer + `get_agent_prompt` tool

**Goal:** Server-side source of truth for the `nova-architect` agent definition. The plugin skills fetch `{ frontmatter, system_prompt }` at invoke time and materialize `<plugin-root>/agents/nova-architect-{runId}.md` (resolved via `$CLAUDE_SKILL_DIR/../..`) before spawning the subagent. Iterating prompt / model / effort / tool restrictions on the server is picked up by the next skill invocation without a plugin release.

**Dependencies:** Phase C (types, errors). Phases D + E aren't prerequisites for rendering — these tools are independent.

> **Plan revision (Phase F-fix).** The original Phase F shipped an edit-mode renderer that called `buildSolutionsArchitectPrompt(undefined)` and only appended a 3-sentence `## Edit Mode` footer telling the subagent to "call `nova.get_app` to read the summary." That regressed from the design spec (`docs/superpowers/specs/2026-04-21-nova-mcp-design.md:476`), which says the edit variant should "carry the blueprint-summary instructions mirroring `/api/chat`'s edit mode" — the web flow inlines `EDIT_PREAMBLE` + `summarizeBlueprint(doc)` at boot. The revision below threads the loaded blueprint through `renderAgentPrompt` so the MCP edit mode produces the same prompt the web flow does, restoring the spec-required parity. The `## Edit Mode` footer is removed because `EDIT_PREAMBLE` already covers it. Fix lands in `lib/mcp/prompts.ts` + `lib/mcp/tools/getAgentPrompt.ts` + tests; sibling `lib/mcp/errors.ts` gains an `McpInvalidInputError` for the conditional-required `app_id` validation in edit mode.

---

## Task F1: Server-side prompt + frontmatter renderer

**Files:**
- Create: `lib/mcp/prompts.ts`
- Create: `lib/mcp/__tests__/prompts.test.ts`

- [ ] **Step 1: Write `lib/mcp/prompts.ts`**

```ts
/**
 * Server-side source of truth for the nova-architect agent definition.
 *
 * `get_agent_prompt` calls the render function to produce the
 * { frontmatter, system_prompt } shape the plugin skill writes to disk.
 *
 * Three flags drive the output, each with a single concern:
 *   - `mode` picks the tools allowlist + agent description only.
 *   - `interactive` picks the AskUserQuestion gate (frontmatter-level
 *     enforcement via `disallowedTools`).
 *   - `editDoc` picks the system-prompt flavor by being threaded
 *     straight through to `buildSolutionsArchitectPrompt`. Build calls
 *     pass `undefined`; edit calls pass the loaded blueprint. Empty
 *     docs (`moduleOrder.length === 0`) intentionally fall back to
 *     the build prompt — same fallthrough the web flow's renderer uses.
 */

import { buildSolutionsArchitectPrompt } from "@/lib/agent/prompts";
import type { BlueprintDoc } from "@/lib/domain";
import { type ReasoningEffort, SA_MODEL, SA_REASONING } from "@/lib/models";

export type PromptMode = "build" | "edit";

export interface AgentPromptFrontmatter {
	name: "nova-architect";
	description: string;
	model: string;
	effort: ReasoningEffort;
	maxTurns: number;
	tools?: string[];
	disallowedTools?: string[];
}

export interface AgentPromptPayload {
	frontmatter: AgentPromptFrontmatter;
	system_prompt: string;
}

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

const ALLOWED_MCP_TOOLS_EDIT = ALLOWED_MCP_TOOLS_BUILD.filter(
	(t) =>
		t !== "mcp__nova__generate_schema" &&
		t !== "mcp__nova__generate_scaffold" &&
		t !== "mcp__nova__add_module" &&
		t !== "mcp__nova__create_app",
);

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

export function renderAgentPrompt(
	mode: PromptMode,
	interactive: boolean,
	editDoc?: BlueprintDoc,
): AgentPromptPayload {
	/* Single delegation: `buildSolutionsArchitectPrompt` already branches
	 * on `doc?.moduleOrder.length > 0`. Threading `editDoc` straight
	 * through means the MCP edit mode produces the same prompt the
	 * web flow's `/api/chat` edit mode does — single source of truth,
	 * one rendering branch, no cross-surface drift. The MCP-specific
	 * concerns (interactivity, tool allowlist, frontmatter) compose
	 * around the body, never inside it. */
	const baseSystem = buildSolutionsArchitectPrompt(editDoc);

	const interactivityBlock = interactive
		? INTERACTIVITY_INSTRUCTIONS.interactive
		: INTERACTIVITY_INSTRUCTIONS.autonomous;

	const system_prompt = `${baseSystem}${interactivityBlock}`;

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
		tools: interactive ? [...baseTools, "AskUserQuestion"] : baseTools,
		...(interactive ? {} : { disallowedTools: ["AskUserQuestion"] }),
	};

	return { frontmatter, system_prompt };
}

function mapModelToClaudeCode(
	modelId: string,
): "opus" | "sonnet" | "haiku" | (string & {}) {
	if (modelId.startsWith("claude-opus")) return "opus";
	if (modelId.startsWith("claude-sonnet")) return "sonnet";
	if (modelId.startsWith("claude-haiku")) return "haiku";
	return modelId;
}
```

- [ ] **Step 2: Write `lib/mcp/__tests__/prompts.test.ts`**

The test file covers the eight load-bearing behaviors of the renderer, with the F-fix additions exercising the new edit-mode parity:

- Autonomous build disallows `AskUserQuestion` (in `disallowedTools`, not in `tools`).
- Interactive build allows `AskUserQuestion` (in `tools`, no `disallowedTools`).
- Build mode exposes all four generation tools.
- Edit mode strips the four generation tools.
- `frontmatter.name === "nova-architect"` across all four mode × interactive combos.
- The interactivity block is appended to the system prompt.
- **Edit mode with a populated doc emits `EDIT_PREAMBLE` framing + an inlined `summarizeBlueprint(doc)`.** Spot-checks for `"Editing Mode"`, `"full visibility"`, plus the fixture's app + module names. Asserts `"Initial Build"` and `"Initial Interaction"` are absent so a regression that fell back to the build prompt would fail loudly.
- **Edit mode with no doc (`undefined`) falls back to the build prompt.** Documents the deliberate fallback — the renderer stays liberal so call sites aren't forced to fabricate a doc; the tool surface enforces the conditional `app_id` requirement separately.
- **Edit mode with an empty-modules doc falls back to the build prompt.** Confirms the degenerate edit case (empty doc from `createApp` before any modules land) inherits `buildSolutionsArchitectPrompt`'s built-in fallthrough.
- The model slug maps to a short Claude Code name (`opus` | `sonnet` | `haiku`).

- [ ] **Step 3: Run + commit**

```bash
npx vitest run lib/mcp/__tests__/prompts.test.ts
npx tsc --noEmit && echo "✓"
git add lib/mcp/prompts.ts lib/mcp/__tests__/prompts.test.ts
git commit -m "feat(mcp): server-side agent prompt + frontmatter renderer"
```

---

## Task F2: `get_agent_prompt` tool

**Files:**
- Create: `lib/mcp/tools/getAgentPrompt.ts`
- Create: `lib/mcp/__tests__/getAgentPrompt.test.ts`

- [ ] **Step 1: Write handler**

```ts
/**
 * nova.get_agent_prompt — dynamic-agent bootstrap.
 *
 * Called by the plugin skills at the start of every build/edit. The
 * returned payload is materialized at <plugin-root>/agents/nova-architect-{runId}.md
 * by the skill, then a subagent is spawned via the Agent tool with
 * subagent_type: "nova:nova-architect-{runId}".
 *
 * Edit mode loads the blueprint here so the rendered system prompt
 * boots with EDIT_PREAMBLE + an inlined summarizeBlueprint(doc) —
 * exact parity with the web flow's /api/chat edit mode. Build mode
 * ignores app_id; mode is the authoritative discriminator.
 *
 * Scope: nova.read — read-only metadata + a single ownership-gated
 * blueprint read in edit mode.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
	type McpToolErrorResult,
	type McpToolSuccessResult,
	McpInvalidInputError,
	toMcpErrorResult,
} from "../errors";
import { loadAppBlueprint } from "../loadApp";
import { McpAccessError, requireOwnedApp } from "../ownership";
import { type PromptMode, renderAgentPrompt } from "../prompts";
import { resolveRunId } from "../runId";
import type { ToolContext } from "../types";

export function registerGetAgentPrompt(
	server: McpServer,
	ctx: ToolContext,
): void {
	server.registerTool(
		"get_agent_prompt",
		{
			description:
				"Get the current nova-architect agent definition (frontmatter + system prompt) for the given mode. Plugin skills call this to materialize the subagent file at invoke time. Edit mode requires `app_id` so the inlined blueprint summary mirrors the web flow's edit-mode prompt at boot.",
			inputSchema: {
				mode: z
					.enum(["build", "edit"] as const satisfies readonly PromptMode[])
					.describe(
						"Which agent flavor to render. `build` exposes generation tools; `edit` strips them.",
					),
				interactive: z
					.boolean()
					.describe(
						"When true, the subagent may call AskUserQuestion. When false, the frontmatter emits `disallowedTools: ['AskUserQuestion']`.",
					),
				app_id: z
					.string()
					.optional()
					.describe(
						"Required when `mode === 'edit'` — the Firestore app id whose blueprint summary should be inlined into the rendered system prompt. The user must own this app. Ignored when `mode === 'build'`.",
					),
			},
		},
		async (args, extra): Promise<McpToolSuccessResult | McpToolErrorResult> => {
			const runId = resolveRunId(extra);
			const appId = args.mode === "edit" ? args.app_id : undefined;
			try {
				if (args.mode === "edit") {
					if (!args.app_id) {
						throw new McpInvalidInputError(
							"edit mode requires app_id",
						);
					}
					await requireOwnedApp(ctx.userId, args.app_id);
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

				/* Build mode: app_id is ignored even when supplied. _meta.app_id
				 * is NOT stamped — admin surfaces would otherwise correlate
				 * this build run to an unrelated app. */
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
```

- [ ] **Step 2: Test**

The test file covers seven describe blocks against the F-fix contract:

- **Build mode** (two combos covering interactive vs autonomous wiring) returns a well-formed payload, never stamps `_meta.app_id`, and never calls Firestore. A separate test verifies that a spurious `app_id` is ignored quietly (no Firestore call, no app_id on `_meta`).
- **Edit mode happy path** — owned app, populated doc: ownership check + single blueprint load, doc threaded into the renderer (verified via `toHaveBeenCalledWith("edit", true, doc)`), system prompt carries `EDIT_PREAMBLE` framing + the fixture's app + module names from the inlined `summarizeBlueprint(doc)`, generators stripped from tools, `_meta.app_id` stamped on success.
- **Edit mode missing `app_id`** — collapses to `error_type: "invalid_input"` with the thrown message text on the wire, never touches Firestore (argument validation runs before any call).
- **Edit mode unowned `app_id`** — collapses to `error_type: "not_found"` (IDOR hardening), never loads the blueprint.
- **Edit mode empty-modules doc** — the loaded doc has no modules, so `buildSolutionsArchitectPrompt` falls back to the build prompt while the *tool surface* still reflects edit mode (generators stripped). Confirms the degenerate-edit fallthrough is preserved end-to-end.
- **`run_id` threading** — client-supplied id rides through; absent id gets a freshly-minted uuid v4.
- **`renderAgentPrompt` throws** — error envelope carries `isError: true`, populated `error_type`, and the resolved `run_id`.

Scope enforcement for `get_agent_prompt` lives at the verify layer (Phase G route handler declares the tool-mount with `scopes: ["nova.read"]`). No per-handler scope check in this tool.

- [ ] **Step 3: Run + commit**

```bash
npx vitest run lib/mcp/__tests__/getAgentPrompt.test.ts
git add lib/mcp/tools/getAgentPrompt.ts lib/mcp/__tests__/getAgentPrompt.test.ts
git commit -m "feat(mcp): get_agent_prompt dynamic-agent bootstrap tool"
```
