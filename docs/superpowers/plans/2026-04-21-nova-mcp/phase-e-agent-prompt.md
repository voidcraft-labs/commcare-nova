# Phase E — Agent prompt renderer + `get_agent_prompt` tool

**Goal:** Server-side source of truth for the `nova-architect` agent definition. The plugin skills fetch `{ frontmatter, system_prompt }` at invoke time and materialize `~/.claude/agents/nova-architect.md` before spawning the subagent. Iterating prompt / model / effort / tool restrictions on the server is picked up by the next skill invocation without a plugin release.

**Dependencies:** Phase C (types, scopes, errors, rate limiting). Phase D is not a prerequisite — these tools are independent.

---

## Task E1: Server-side prompt + frontmatter renderer

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
 * Interactivity flag controls one thing: autonomous mode emits
 * `disallowedTools: [AskUserQuestion]` so the spawned subagent physically
 * cannot call it. Prompt-only instruction would be weaker.
 *
 * Mode flag controls two things: (1) build mode exposes generation tools,
 * edit mode hides them; (2) edit mode's system prompt carries the
 * "app already exists" framing from buildSolutionsArchitectPrompt.
 */

import { buildSolutionsArchitectPrompt } from "@/lib/agent/prompts";
import { SA_MODEL, SA_REASONING } from "@/lib/models";

export type PromptMode = "build" | "edit";

export interface AgentPromptFrontmatter {
	name: "nova-architect";
	description: string;
	model: string;
	effort: string;
	maxTurns: number;
	allowedTools?: string[];
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
): AgentPromptPayload {
	/* Reuse the SA's existing prompt renderer as the foundation so both
	 * the web flow and the MCP flow stay in sync. Edit mode passes
	 * undefined doc; the skill includes the blueprint summary in the
	 * task prompt instead. */
	const baseSystem = buildSolutionsArchitectPrompt(undefined);

	const interactivityBlock = interactive
		? INTERACTIVITY_INSTRUCTIONS.interactive
		: INTERACTIVITY_INSTRUCTIONS.autonomous;

	const modeHeader =
		mode === "edit"
			? "\n\n## Edit Mode\n\nThe user has asked you to modify an existing app. The task prompt carries the app_id and the user's instruction. Before making changes, call `nova.get_app` with the app_id to read the current blueprint summary."
			: "";

	const system_prompt = `${baseSystem}${modeHeader}${interactivityBlock}`;

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
		allowedTools: interactive
			? [...allowedTools, "AskUserQuestion"]
			: allowedTools,
		...(interactive ? {} : { disallowedTools: ["AskUserQuestion"] }),
	};

	return { frontmatter, system_prompt };
}

/**
 * Map Nova's SA_MODEL constant to the Claude Code frontmatter slug. Short
 * names ("opus", "sonnet", "haiku") let Claude Code pick the current
 * version of that tier automatically so we don't pin a specific release.
 */
function mapModelToClaudeCode(modelId: string): string {
	if (modelId.startsWith("claude-opus")) return "opus";
	if (modelId.startsWith("claude-sonnet")) return "sonnet";
	if (modelId.startsWith("claude-haiku")) return "haiku";
	return modelId;
}
```

- [ ] **Step 2: Write `lib/mcp/__tests__/prompts.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import { renderAgentPrompt } from "../prompts";

describe("renderAgentPrompt", () => {
	it("autonomous build disallows AskUserQuestion", () => {
		const r = renderAgentPrompt("build", false);
		expect(r.frontmatter.disallowedTools).toContain("AskUserQuestion");
		expect(r.frontmatter.allowedTools).not.toContain("AskUserQuestion");
	});

	it("interactive build allows AskUserQuestion", () => {
		const r = renderAgentPrompt("build", true);
		expect(r.frontmatter.allowedTools).toContain("AskUserQuestion");
		expect(r.frontmatter.disallowedTools).toBeUndefined();
	});

	it("edit mode strips generation tools", () => {
		const r = renderAgentPrompt("edit", true);
		expect(r.frontmatter.allowedTools).not.toContain("mcp__nova__generate_schema");
		expect(r.frontmatter.allowedTools).not.toContain("mcp__nova__generate_scaffold");
		expect(r.frontmatter.allowedTools).not.toContain("mcp__nova__add_module");
		expect(r.frontmatter.allowedTools).not.toContain("mcp__nova__create_app");
	});

	it("frontmatter name is always nova-architect", () => {
		for (const mode of ["build", "edit"] as const) {
			for (const interactive of [true, false]) {
				expect(renderAgentPrompt(mode, interactive).frontmatter.name).toBe(
					"nova-architect",
				);
			}
		}
	});

	it("system prompt includes interactivity block", () => {
		expect(renderAgentPrompt("build", true).system_prompt).toContain(
			"AskUserQuestion tool",
		);
		expect(renderAgentPrompt("build", false).system_prompt).toContain(
			"not available",
		);
	});

	it("edit mode system prompt instructs to read the existing blueprint", () => {
		expect(renderAgentPrompt("edit", true).system_prompt).toContain(
			"call `nova.get_app`",
		);
	});

	it("model slug maps to short Claude Code name", () => {
		const r = renderAgentPrompt("build", true);
		expect(r.frontmatter.model).toMatch(/^(opus|sonnet|haiku)$/);
	});
});
```

- [ ] **Step 3: Run + commit**

```bash
npx vitest run lib/mcp/__tests__/prompts.test.ts
npx tsc --noEmit && echo "✓"
git add lib/mcp/prompts.ts lib/mcp/__tests__/prompts.test.ts
git commit -m "feat(mcp): server-side agent prompt + frontmatter renderer"
```

---

## Task E2: `get_agent_prompt` tool

**Files:**
- Create: `lib/mcp/tools/getAgentPrompt.ts`
- Create: `lib/mcp/__tests__/getAgentPrompt.test.ts`

- [ ] **Step 1: Write handler**

```ts
/**
 * nova.get_agent_prompt — dynamic-agent bootstrap.
 *
 * Called by the plugin skills at the start of every build/edit. The
 * returned payload is materialized at ~/.claude/agents/nova-architect.md
 * by the skill, then a subagent is spawned via the Agent tool with
 * subagent_type: nova-architect.
 *
 * Scope: nova.read — read-only metadata, no mutation.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { toMcpErrorResult } from "../errors";
import { renderAgentPrompt, type PromptMode } from "../prompts";
import { checkRateLimit } from "../rateLimit";
import { requireScope, SCOPES } from "../scopes";
import type { ToolContext } from "../types";

export function registerGetAgentPrompt(
	server: McpServer,
	ctx: ToolContext,
): void {
	server.tool(
		"get_agent_prompt",
		"Get the current nova-architect agent definition for the given mode. Used by the nova plugin skills to materialize the subagent at invoke time. Returns { frontmatter, system_prompt } — the plugin writes these to ~/.claude/agents/nova-architect.md before spawning.",
		{
			type: "object",
			properties: {
				mode: { type: "string", enum: ["build", "edit"] },
				interactive: { type: "boolean" },
			},
			required: ["mode", "interactive"],
			additionalProperties: false,
		},
		async (args: { mode: PromptMode; interactive: boolean }) => {
			try {
				requireScope(ctx, SCOPES.read);
				await checkRateLimit(ctx.userId, "get_agent_prompt");
				const payload = renderAgentPrompt(args.mode, args.interactive);
				return {
					content: [{ type: "text", text: JSON.stringify(payload) }],
				};
			} catch (err) {
				return toMcpErrorResult(err);
			}
		},
	);
}
```

- [ ] **Step 2: Test**

```ts
import { describe, expect, it, vi } from "vitest";
vi.mock("../rateLimit", () => ({ checkRateLimit: vi.fn() }));
import { registerGetAgentPrompt } from "../tools/getAgentPrompt";

describe("get_agent_prompt", () => {
	it("returns frontmatter + system_prompt for each mode/interactive combo", async () => {
		for (const mode of ["build", "edit"] as const) {
			for (const interactive of [true, false]) {
				let handler!: (a: unknown) => Promise<unknown>;
				const server = {
					tool: (_n: string, _d: string, _s: unknown, h: typeof handler) => {
						handler = h;
					},
				} as unknown as import("@modelcontextprotocol/sdk/server/mcp.js").McpServer;
				registerGetAgentPrompt(server, { userId: "u", scopes: ["nova.read"] });
				const res = (await handler({ mode, interactive })) as {
					content: { text: string }[];
				};
				const parsed = JSON.parse(res.content[0].text);
				expect(parsed.frontmatter.name).toBe("nova-architect");
				expect(typeof parsed.system_prompt).toBe("string");
			}
		}
	});

	it("returns insufficient_scope without nova.read", async () => {
		let handler!: (a: unknown) => Promise<unknown>;
		const server = {
			tool: (_n: string, _d: string, _s: unknown, h: typeof handler) => {
				handler = h;
			},
		} as unknown as import("@modelcontextprotocol/sdk/server/mcp.js").McpServer;
		registerGetAgentPrompt(server, { userId: "u", scopes: [] });
		const res = (await handler({ mode: "build", interactive: true })) as {
			isError?: boolean;
			_meta?: { error_type?: string };
		};
		expect(res.isError).toBe(true);
		expect(res._meta?.error_type).toBe("insufficient_scope");
	});
});
```

- [ ] **Step 3: Run + commit**

```bash
npx vitest run lib/mcp/__tests__/getAgentPrompt.test.ts
git add lib/mcp/tools/getAgentPrompt.ts lib/mcp/__tests__/getAgentPrompt.test.ts
git commit -m "feat(mcp): get_agent_prompt dynamic-agent bootstrap tool"
```
