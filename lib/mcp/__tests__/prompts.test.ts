/**
 * `renderAgentPrompt` unit tests.
 *
 * Covers the load-bearing behaviors of the agent-prompt-body renderer:
 *
 *   - Autonomous variant appends the "AskUserQuestion tool is not
 *     available" Interaction Mode block so the subagent knows not to
 *     waste a turn discovering the missing tool (tool-level enforcement
 *     lives in the plugin's `disallowedTools` frontmatter — the prompt
 *     reminder is the in-body complement).
 *   - Interactive variant appends the "ask at most a handful of
 *     questions" Interaction Mode block.
 *   - Build-mode call (`editDoc === undefined`) falls through to
 *     `buildSolutionsArchitectPrompt`'s build branch.
 *   - **Edit-mode prompt parity with the web flow.** When a populated
 *     blueprint is threaded through, the rendered prompt carries
 *     `EDIT_PREAMBLE`'s framing (the spawned subagent gets "you have
 *     full visibility, only ask about intent" instead of the build
 *     stage list) plus the fixture's app + module names inlined via
 *     `summarizeBlueprint(doc)`. A regression that fell back to the
 *     build prompt would fail on the `Editing Mode` + fixture-name
 *     checks.
 *   - **Empty/missing doc fallback.** `renderAgentPrompt(_, undefined)`
 *     and `renderAgentPrompt(_, emptyDoc)` both fall back to the build
 *     prompt — `buildSolutionsArchitectPrompt`'s
 *     `moduleOrder.length > 0` branch is the single source of truth
 *     for "is there anything to edit?", and the MCP renderer
 *     intentionally inherits its degenerate-case behavior.
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
	it("interactive variant appends the AskUserQuestion permission block", () => {
		expect(renderAgentPrompt(true)).toContain("AskUserQuestion tool");
	});

	it("autonomous variant appends the 'tool not available' reminder", () => {
		expect(renderAgentPrompt(false)).toContain("not available");
	});

	it("build mode (no editDoc) falls through to the build prompt", () => {
		const sp = renderAgentPrompt(true);
		expect(sp).toContain("Initial Build");
		expect(sp).not.toContain("Editing Mode");
	});

	it("edit mode with a populated doc emits EDIT_PREAMBLE framing + an inlined blueprint summary", () => {
		/* Edit-mode parity with `/api/chat`: when a populated doc is
		 * threaded through, the rendered prompt must carry
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
		const sp = renderAgentPrompt(true, fixturePopulatedDoc());
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

	it("edit mode with an empty-modules doc falls back to the build prompt", () => {
		/* `createApp` writes an empty doc before any generation tools
		 * fire — there's nothing to "edit" yet, so
		 * `buildSolutionsArchitectPrompt` routes empty docs into the
		 * build branch. The test confirms the MCP renderer inherits
		 * that behavior end-to-end. */
		const sp = renderAgentPrompt(true, fixtureEmptyDoc());
		expect(sp).toContain("Initial Build");
		expect(sp).not.toContain("Editing Mode");
	});
});
