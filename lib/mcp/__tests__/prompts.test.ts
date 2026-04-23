/**
 * `renderAgentPrompt` unit tests.
 *
 * Covers the seven load-bearing behaviors of the agent-definition
 * renderer:
 *
 *   - Autonomous build strips `AskUserQuestion` from `allowedTools` AND
 *     lists it in `disallowedTools` (belt-and-suspenders: prompt-only
 *     instruction would be weaker than a Claude Code tool-allowlist gate).
 *   - Interactive build includes `AskUserQuestion` in `allowedTools` and
 *     omits `disallowedTools` entirely (no ambiguous deny signal).
 *   - Edit mode strips the four generation tools (`create_app`,
 *     `generate_schema`, `generate_scaffold`, `add_module`) so the
 *     subagent can't replace an existing app's structure mid-edit.
 *   - `frontmatter.name` is invariant across all four mode × interactive
 *     combinations — uniqueness across parallel runs is handled by the
 *     plugin's per-run filename suffix, not by varying this field.
 *   - The interactivity block is appended to the system prompt for both
 *     modes, with the right wording per mode.
 *   - Edit mode's system prompt carries the `nova.get_app` directive so
 *     the subagent refreshes the blueprint before mutating.
 *   - The emitted model string is the Claude Code short slug
 *     (`opus` | `sonnet` | `haiku`), not Nova's full model id — letting
 *     the harness pick the current version of the tier automatically.
 */

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
		expect(r.frontmatter.allowedTools).not.toContain(
			"mcp__nova__generate_schema",
		);
		expect(r.frontmatter.allowedTools).not.toContain(
			"mcp__nova__generate_scaffold",
		);
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
