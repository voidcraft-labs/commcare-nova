/**
 * `renderAgentPrompt` unit tests.
 *
 * Covers the load-bearing behaviors of the agent-definition renderer:
 *
 *   - Autonomous build strips `AskUserQuestion` from `tools` AND lists
 *     it in `disallowedTools` (belt-and-suspenders: prompt-only
 *     instruction would be weaker than a Claude Code tool-allowlist
 *     gate). Note Claude Code's allowlist frontmatter field is
 *     literally `tools` — `allowedTools` would be silently ignored.
 *   - Interactive build includes `AskUserQuestion` in `tools` and omits
 *     `disallowedTools` entirely (no ambiguous deny signal).
 *   - Build mode's `tools` list *includes* the four generation tools
 *     (`create_app`, `generate_schema`, `generate_scaffold`,
 *     `add_module`). Pairs with the edit-mode absence assertion below so
 *     a regression in the derivation filter can't hide behind a
 *     superset that already excluded them.
 *   - Edit mode strips those same four generation tools so the subagent
 *     can't replace an existing app's structure mid-edit.
 *   - `frontmatter.name` is invariant across every mode × interactive
 *     combination — uniqueness across parallel runs is handled by the
 *     plugin's per-run filename suffix, not by varying this field.
 *   - The interactivity block is appended to the system prompt for both
 *     modes, with the right wording per mode.
 *   - **Edit-mode prompt parity with the web flow.** When a populated
 *     blueprint is threaded through, the rendered prompt includes
 *     `EDIT_PREAMBLE`'s framing (the spawned subagent gets "you have
 *     full visibility, only ask about intent" instead of the build
 *     stage list). Verifies the regression where the previous version
 *     rendered build framing for edit mode is closed.
 *   - **Empty/missing doc fallback.** `renderAgentPrompt("edit", _, undefined)`
 *     and `renderAgentPrompt("edit", _, emptyDoc)` both fall back to
 *     the build prompt — `buildSolutionsArchitectPrompt`'s
 *     `moduleOrder.length > 0` branch is the single source of truth
 *     for "is there anything to edit?", and the MCP renderer
 *     intentionally inherits its degenerate-case behavior.
 *   - The emitted model string is the Claude Code short slug
 *     (`opus` | `sonnet` | `haiku`), not Nova's full model id — letting
 *     the harness pick the current version of the tier automatically.
 */

import { describe, expect, it } from "vitest";
import type { BlueprintDoc } from "@/lib/domain";
import { asUuid } from "@/lib/domain";
import { renderAgentPrompt } from "../prompts";

/**
 * Build a minimal-but-renderable blueprint with one module + one form
 * + one field. `summarizeBlueprint` walks `moduleOrder` /
 * `formOrder` / `fieldOrder` so the populated indices are what
 * `buildSolutionsArchitectPrompt` keys off when picking edit vs build
 * branch — and what shows up in the inlined summary the assertions
 * spot-check.
 */
function fixturePopulatedDoc(): BlueprintDoc {
	const modUuid = asUuid("11111111-1111-1111-1111-111111111111");
	const formUuid = asUuid("22222222-2222-2222-2222-222222222222");
	const fieldUuid = asUuid("33333333-3333-3333-3333-333333333333");
	return {
		appId: "a-edit",
		appName: "Vaccine Tracker",
		connectType: null,
		caseTypes: null,
		modules: {
			[modUuid]: {
				uuid: modUuid,
				id: "patients",
				name: "Patients",
				caseType: "patient",
			},
		},
		forms: {
			[formUuid]: {
				uuid: formUuid,
				id: "register",
				name: "Register Patient",
				type: "registration",
			},
		},
		fields: {
			[fieldUuid]: {
				uuid: fieldUuid,
				id: "patient_name",
				kind: "text",
				label: "Patient Name",
				required: "true()",
			},
		},
		moduleOrder: [modUuid],
		formOrder: { [modUuid]: [formUuid] },
		fieldOrder: { [formUuid]: [fieldUuid] },
		fieldParent: {},
	};
}

/**
 * Empty-doc fixture — the degenerate edit case `createApp` produces
 * before any modules land. `buildSolutionsArchitectPrompt` keys off
 * `doc?.moduleOrder.length > 0` and routes empty docs into the build
 * branch; the test confirms that fallthrough is preserved when the doc
 * comes through the MCP renderer.
 */
function fixtureEmptyDoc(): BlueprintDoc {
	return {
		appId: "a-empty",
		appName: "Untitled",
		connectType: null,
		caseTypes: null,
		modules: {},
		forms: {},
		fields: {},
		moduleOrder: [],
		formOrder: {},
		fieldOrder: {},
		fieldParent: {},
	};
}

describe("renderAgentPrompt", () => {
	it("autonomous build disallows AskUserQuestion", () => {
		const r = renderAgentPrompt("build", false);
		expect(r.frontmatter.disallowedTools).toContain("AskUserQuestion");
		expect(r.frontmatter.tools).not.toContain("AskUserQuestion");
	});

	it("interactive build allows AskUserQuestion", () => {
		const r = renderAgentPrompt("build", true);
		expect(r.frontmatter.tools).toContain("AskUserQuestion");
		expect(r.frontmatter.disallowedTools).toBeUndefined();
	});

	it("build mode exposes all four generation tools", () => {
		/* Positive complement to the edit-mode absence assertion below.
		 * Without this, a derivation filter that accidentally stripped a
		 * generator from the build list (or renamed one on the server
		 * side) would pass the edit-mode test — the tool would be
		 * absent from both lists, which is still "stripped in edit
		 * mode". Pinning presence in build mode fences that regression. */
		const r = renderAgentPrompt("build", true);
		expect(r.frontmatter.tools).toContain("mcp__nova__create_app");
		expect(r.frontmatter.tools).toContain("mcp__nova__generate_schema");
		expect(r.frontmatter.tools).toContain("mcp__nova__generate_scaffold");
		expect(r.frontmatter.tools).toContain("mcp__nova__add_module");
	});

	it("edit mode strips generation tools", () => {
		const r = renderAgentPrompt("edit", true);
		expect(r.frontmatter.tools).not.toContain("mcp__nova__generate_schema");
		expect(r.frontmatter.tools).not.toContain("mcp__nova__generate_scaffold");
		expect(r.frontmatter.tools).not.toContain("mcp__nova__add_module");
		expect(r.frontmatter.tools).not.toContain("mcp__nova__create_app");
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

	it("edit mode with a populated doc emits EDIT_PREAMBLE framing + an inlined blueprint summary", () => {
		/* Edit-mode parity with `/api/chat`: when the handler threads a
		 * populated doc through, the rendered prompt must carry
		 * `EDIT_PREAMBLE`'s "Editing Mode" header + the "full
		 * visibility" framing (so the subagent doesn't ask about app
		 * structure it can already see), plus an inlined
		 * `summarizeBlueprint(doc)` (so it doesn't have to spend a
		 * tool call to read what the server already loaded).
		 *
		 * Spot-checking on the fixture's app + module names is enough
		 * to prove `summarizeBlueprint` ran against this doc — a
		 * regression that fell back to the build prompt would have no
		 * way to surface those strings. */
		const doc = fixturePopulatedDoc();
		const sp = renderAgentPrompt("edit", true, doc).system_prompt;
		expect(sp).toContain("Editing Mode");
		expect(sp).toContain("full visibility");
		expect(sp).toContain("Vaccine Tracker");
		expect(sp).toContain("Patients");
		/* Build framing must NOT appear — the renderer's branches are
		 * mutually exclusive, so the presence of either build marker
		 * here would mean the doc didn't take effect. */
		expect(sp).not.toContain("Initial Build");
		expect(sp).not.toContain("Initial Interaction");
	});

	it("edit mode with no doc (undefined) falls back to the build prompt", () => {
		/* Documents the deliberate fallback: callers that don't yet
		 * have a doc loaded land in the build branch. The MCP tool
		 * surface treats this as an `invalid_input` and refuses, but
		 * the renderer itself stays liberal so call sites aren't forced
		 * to fabricate a doc. */
		const sp = renderAgentPrompt("edit", true).system_prompt;
		expect(sp).toContain("Initial Build");
		expect(sp).not.toContain("Editing Mode");
	});

	it("edit mode with an empty-modules doc falls back to the build prompt", () => {
		/* `createApp` writes an empty doc before any generation tools
		 * fire — there's nothing to "edit" yet, so
		 * `buildSolutionsArchitectPrompt` routes empty docs into the
		 * build branch. The test confirms the MCP renderer inherits
		 * that behavior end-to-end. */
		const sp = renderAgentPrompt("edit", true, fixtureEmptyDoc()).system_prompt;
		expect(sp).toContain("Initial Build");
		expect(sp).not.toContain("Editing Mode");
	});

	it("model slug maps to short Claude Code name", () => {
		const r = renderAgentPrompt("build", true);
		expect(r.frontmatter.model).toMatch(/^(opus|sonnet|haiku)$/);
	});
});
