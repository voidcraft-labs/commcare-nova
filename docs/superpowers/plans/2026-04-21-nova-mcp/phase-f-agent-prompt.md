# Phase F — Agent prompt renderer + `get_agent_prompt` tool

**Goal:** Server-side source of truth for the `nova-architect` agent's system prompt. Plugin skills don't call this tool directly — the plugin's two static agent files (shipped in the `nova-plugin` repo, see Phase I) are bootstrap stubs whose bodies instruct the spawned subagent to call `get_agent_prompt` as its first tool use and follow the returned text as its full operating instructions. Iterating the prompt body on the server is picked up by the next subagent spawn without a plugin release.

**Dependencies:** Phase C (types, errors). Phases D + E aren't prerequisites for rendering — these tools are independent.

> **Plan revision (Phase F-fix).** The original Phase F shipped an edit-mode renderer that called `buildSolutionsArchitectPrompt(undefined)` and only appended a 3-sentence `## Edit Mode` footer telling the subagent to "call `nova.get_app` to read the summary." That regressed from the design spec (`docs/superpowers/specs/2026-04-21-nova-mcp-design.md:476`), which says the edit variant should "carry the blueprint-summary instructions mirroring `/api/chat`'s edit mode" — the web flow inlines `EDIT_PREAMBLE` + `summarizeBlueprint(doc)` at boot. The revision below threads the loaded blueprint through `renderAgentPrompt` so the MCP edit mode produces the same prompt the web flow does, restoring the spec-required parity. The `## Edit Mode` footer is removed because `EDIT_PREAMBLE` already covers it. Fix lands in `lib/mcp/prompts.ts` + `lib/mcp/tools/getAgentPrompt.ts` + tests; sibling `lib/mcp/errors.ts` gains an `McpInvalidInputError` for the conditional-required `app_id` validation in edit mode.

> **Plan revision (Phase H post-probe contract simplification).** The original Phase F returned `{ frontmatter, system_prompt }` because the plugin-side skill was going to materialize a dynamic `<plugin-root>/agents/nova-architect-{runId}.md` per spawn with server-controlled frontmatter. The Phase H dynamic-discovery probe (see `docs/superpowers/plans/notes/2026-04-21-nova-mcp-infra.md`) proved mid-session agent discovery is structurally impossible in Claude Code 2.1.119 — agent definitions are memoized at session start and `getSystemPrompt` is a closure over a frozen string. Phase I was amended to ship **two static plugin agent files** with fixed frontmatter (`nova-architect-interactive`, `nova-architect-autonomous`); the server contract shrinks to just the system-prompt body text. `renderAgentPrompt` returns `string`; `get_agent_prompt` emits that text directly as the MCP tool's text content (no JSON wrapper needed — the payload is plain text now). The `AgentPromptFrontmatter` type and the `mapModelToClaudeCode` helper go away with it — no call sites remain. Sibling tests are updated to the simplified shape.

---

## Task F1: Server-side prompt renderer

**Files:**
- Create: `lib/mcp/prompts.ts`
- Create: `lib/mcp/__tests__/prompts.test.ts`

- [ ] **Step 1: Write `lib/mcp/prompts.ts`**

```ts
/**
 * Server-side source of truth for the nova-architect subagent's system
 * prompt body.
 *
 * The plugin's static bootstrap agents (see Phase I) instruct the
 * spawned subagent to call `get_agent_prompt` as its first tool use
 * and treat the returned text as its full operating instructions.
 * Frontmatter (model, effort, tool allowlist, AskUserQuestion gate) is
 * baked into those static plugin files, not returned from here — Phase H
 * established that Claude Code caches agent definitions at session start,
 * making server-driven dynamic frontmatter impossible.
 *
 * Three flags drive the output, each with a single concern:
 *   - `mode` has no effect on the body text today (build/edit parity is
 *     handled entirely by `editDoc`); it's still accepted because future
 *     mode-specific guidance could reasonably live here without re-
 *     plumbing the tool signature.
 *   - `interactive` picks the Interaction Mode section (the autonomous
 *     variant instructs the subagent not to call AskUserQuestion;
 *     tool-level enforcement is in the plugin's autonomous agent file).
 *   - `editDoc` picks the system-prompt flavor by being threaded
 *     straight through to `buildSolutionsArchitectPrompt`. Build calls
 *     pass `undefined`; edit calls pass the loaded blueprint. Empty
 *     docs (`moduleOrder.length === 0`) intentionally fall back to
 *     the build prompt — same fallthrough the web flow's renderer uses.
 */

import { buildSolutionsArchitectPrompt } from "@/lib/agent/prompts";
import type { BlueprintDoc } from "@/lib/domain";

export type PromptMode = "build" | "edit";

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
	_mode: PromptMode,
	interactive: boolean,
	editDoc?: BlueprintDoc,
): string {
	const baseSystem = buildSolutionsArchitectPrompt(editDoc);
	const interactivityBlock = interactive
		? INTERACTIVITY_INSTRUCTIONS.interactive
		: INTERACTIVITY_INSTRUCTIONS.autonomous;
	return `${baseSystem}${interactivityBlock}`;
}
```

- [ ] **Step 2: Write `lib/mcp/__tests__/prompts.test.ts`**

The test file covers the renderer's load-bearing behaviors:

- Autonomous variant appends the "do NOT attempt to ask the user questions" block.
- Interactive variant appends the "ask at most a handful of questions" block.
- Build-mode call (`editDoc === undefined`) falls through to the build prompt.
- **Edit mode with a populated doc emits `EDIT_PREAMBLE` framing + an inlined `summarizeBlueprint(doc)`.** Spot-checks for `"Editing Mode"`, `"full visibility"`, plus the fixture's app + module names. Asserts `"Initial Build"` and `"Initial Interaction"` are absent so a regression that fell back to the build prompt would fail loudly.
- **Edit mode with no doc (`undefined`) falls back to the build prompt.** Documents the deliberate fallback — the renderer stays liberal so call sites aren't forced to fabricate a doc; the tool surface enforces the conditional `app_id` requirement separately.
- **Edit mode with an empty-modules doc falls back to the build prompt.** Confirms the degenerate edit case (empty doc from `createApp` before any modules land) inherits `buildSolutionsArchitectPrompt`'s built-in fallthrough.

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
 * nova.get_agent_prompt — self-fetch bootstrap tool.
 *
 * The plugin ships two static subagent files (`nova-architect-interactive`,
 * `nova-architect-autonomous`) whose bodies instruct the spawned subagent
 * to call this tool as its FIRST action and treat the returned text as
 * its full operating instructions. The server owns the prompt body; the
 * plugin owns the tool allowlist + AskUserQuestion gate (baked into
 * static frontmatter — Phase H proved mid-session agent definitions
 * cannot be server-driven).
 *
 * Edit mode loads the blueprint here so the rendered prompt boots with
 * EDIT_PREAMBLE + an inlined summarizeBlueprint(doc) — exact parity
 * with the web flow's /api/chat edit mode. Build mode ignores app_id;
 * `mode` is the authoritative discriminator.
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
				"Return the current nova-architect operating instructions for the given mode. The plugin's static bootstrap agent calls this as its first tool use and follows the returned text for the rest of the run. Edit mode requires `app_id` so the inlined blueprint summary mirrors the web flow's edit-mode prompt at boot.",
			inputSchema: {
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
						"Required when `mode === 'edit'` — the Firestore app id whose blueprint summary should be inlined into the returned text. The user must own this app. Ignored when `mode === 'build'`.",
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
					const systemPrompt = renderAgentPrompt(
						args.mode,
						args.interactive,
						loaded.doc,
					);
					return {
						content: [{ type: "text", text: systemPrompt }],
						_meta: { app_id: args.app_id, run_id: runId },
					};
				}

				/* Build mode: app_id is ignored even when supplied. _meta.app_id
				 * is NOT stamped — admin surfaces would otherwise correlate
				 * this build run to an unrelated app. */
				const systemPrompt = renderAgentPrompt(args.mode, args.interactive);
				return {
					content: [{ type: "text", text: systemPrompt }],
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

The test file covers the tool's load-bearing behaviors:

- **Build mode** (two combos covering interactive vs autonomous wording) returns a text content block with the rendered prompt, never stamps `_meta.app_id`, and never calls Firestore. A separate test verifies that a spurious `app_id` is ignored quietly (no Firestore call, no app_id on `_meta`).
- **Edit mode happy path** — owned app, populated doc: ownership check + single blueprint load, doc threaded into the renderer (verified via `toHaveBeenCalledWith("edit", true, doc)`), returned text carries `EDIT_PREAMBLE` framing + the fixture's app + module names from the inlined `summarizeBlueprint(doc)`, `_meta.app_id` stamped on success.
- **Edit mode missing `app_id`** — collapses to `error_type: "invalid_input"` with the thrown message text on the wire, never touches Firestore (argument validation runs before any call).
- **Edit mode unowned `app_id`** — collapses to `error_type: "not_found"` (IDOR hardening), never loads the blueprint.
- **Edit mode empty-modules doc** — the loaded doc has no modules, so `buildSolutionsArchitectPrompt` falls back to the build prompt body while the tool still reports edit-mode framing at the envelope level (`_meta.app_id` stamped).
- **`run_id` threading** — client-supplied id rides through; absent id gets a freshly-minted uuid v4.
- **`renderAgentPrompt` throws** — error envelope carries `isError: true`, populated `error_type`, and the resolved `run_id`.

Scope enforcement for `get_agent_prompt` lives at the verify layer (Phase G route handler declares the tool-mount with `scopes: ["nova.read"]`). No per-handler scope check in this tool.

- [ ] **Step 3: Run + commit**

```bash
npx vitest run lib/mcp/__tests__/getAgentPrompt.test.ts
git add lib/mcp/tools/getAgentPrompt.ts lib/mcp/__tests__/getAgentPrompt.test.ts
git commit -m "feat(mcp): get_agent_prompt dynamic-agent bootstrap tool"
```
