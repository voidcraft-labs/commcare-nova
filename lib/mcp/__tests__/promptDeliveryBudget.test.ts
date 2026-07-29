/**
 * Delivery contract for the served agent prompt.
 *
 * `get_agent_prompt` hands its caller a whole system prompt through a
 * channel built for ordinary tool results. Hosts cap how large a single
 * result may be and, past the cap, swap it for a short preview plus a
 * path to the full text on disk. The plugin's autonomous subagent is
 * allowlisted to MCP tools only — no filesystem — so for it a persisted
 * result is a lost one: it reads the preview and builds anyway.
 *
 * That failure is invisible from the server. Nothing in a request tells
 * us how much of the response survived, and the app still compiles,
 * because the *what* comes from the caller's task and the *how* is
 * partly recoverable from the tool schemas. The prompt crossed the cap
 * once already and the resulting builds looked fine — structurally
 * valid, conventionally wrong — for eleven days.
 *
 * So the invariant is asserted here, where it is observable:
 *
 *   1. **Every mode stays inside the budget.** This is the whole guard.
 *      `MAX_RESULT_SIZE_CHARS` lifts the per-result cap for this tool,
 *      but an MCP-wide token cap sits above it that nothing server-side
 *      can raise, so the prompt must stay small enough to clear both.
 *      The test fails when a prompt edit pushes it over — at authoring
 *      time, rather than silently in someone's build.
 *   2. **Every mode ends with the marker.** The plugin's bootstrap
 *      refuses to build without it, so a prompt that stops emitting it
 *      strands every caller.
 *
 * Edit mode is measured separately and matters most: its blueprint
 * summary scales with the app, and it is appended last, so it is both
 * the largest contributor and the first thing a short delivery drops.
 * The fixtures here are small, so what edit mode is really asserting is
 * that the *fixed* part leaves usable room for the variable part.
 */

import { describe, expect, it } from "vitest";
import { xp } from "@/lib/__tests__/docHelpers";
import type { BlueprintDoc } from "@/lib/domain";
import { asUuid } from "@/lib/domain";
import {
	MAX_DELIVERABLE_PROMPT_CHARS,
	PROMPT_END_MARKER,
	renderAgentPrompt,
} from "../prompts";

/**
 * A populated blueprint, so edit mode takes its real branch and inlines
 * a summary. Deliberately small: the point is to measure the fixed cost
 * of the edit prompt, not to guess at a realistic app's summary size.
 */
function fixturePopulatedDoc(): BlueprintDoc {
	const modUuid = asUuid("11111111-1111-1111-1111-111111111111");
	const formUuid = asUuid("22222222-2222-2222-2222-222222222222");
	const fieldUuid = asUuid("33333333-3333-3333-3333-333333333333");
	return {
		appId: "a-budget",
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
				required: xp("true()"),
			},
		},
		moduleOrder: [modUuid],
		formOrder: { [modUuid]: [formUuid] },
		fieldOrder: { [formUuid]: [fieldUuid] },
		fieldParent: {},
	};
}

/**
 * An app large enough that its summary cannot be inlined — the shape
 * production's biggest apps have. Built by repeating the fixture's
 * module rather than by hand, so it stays honest if `summarizeBlueprint`
 * changes what it emits per module: the test wants "too big to fit",
 * not a specific byte count.
 */
function fixtureOversizedDoc(): BlueprintDoc {
	const base = fixturePopulatedDoc();
	const modules: BlueprintDoc["modules"] = {};
	const formOrder: BlueprintDoc["formOrder"] = {};
	const moduleOrder: BlueprintDoc["moduleOrder"] = [];
	const baseModUuid = base.moduleOrder[0];
	if (!baseModUuid) throw new Error("fixture lost its module");
	const baseMod = base.modules[baseModUuid];
	if (!baseMod) throw new Error("fixture lost its module record");

	/* Enough modules to clear the budget with the base prompt already
	 * past 51,000 chars, with margin so the test doesn't sit on the
	 * boundary it is asserting about. */
	for (let i = 0; i < 400; i++) {
		const uuid = asUuid(
			`44444444-4444-4444-4444-${String(i).padStart(12, "0")}`,
		);
		modules[uuid] = {
			...baseMod,
			uuid,
			id: `patients_${i}`,
			name: `Patients ${i} — a module name long enough to carry real weight`,
		};
		moduleOrder.push(uuid);
		formOrder[uuid] = base.formOrder[baseModUuid] ?? [];
	}
	return { ...base, modules, moduleOrder, formOrder };
}

/**
 * The three shapes `get_agent_prompt` can return, named as the wire
 * `mode` values so a failure points straight at the affected caller.
 */
const MODES: ReadonlyArray<{ mode: string; render: () => string }> = [
	{ mode: "build", render: () => renderAgentPrompt(true) },
	{ mode: "autonomous_build", render: () => renderAgentPrompt(false) },
	{
		mode: "edit",
		render: () => renderAgentPrompt(true, fixturePopulatedDoc()),
	},
];

describe("served prompt delivery budget", () => {
	it.each(MODES)("$mode stays within the delivery budget", ({ render }) => {
		const rendered = render();
		/* Reported rather than left to a bare boolean: when this fails,
		 * the first thing anyone needs is how far over it went and how
		 * much room there was, so the message carries both. */
		const overBy = rendered.length - MAX_DELIVERABLE_PROMPT_CHARS;
		expect(
			overBy,
			`The rendered prompt is ${rendered.length} chars, ${overBy} over the ${MAX_DELIVERABLE_PROMPT_CHARS}-char delivery budget. Past the budget the host stops sending the prompt and sends a short preview plus a file path instead, and the autonomous subagent cannot open files — it would build from a fraction of its instructions without reporting anything wrong. Cut prompt content, or move reference material to where it is fetched on demand.`,
		).toBeLessThanOrEqual(0);
	});

	it.each(MODES)("$mode ends with the delivery marker", ({ render }) => {
		const rendered = render();
		expect(
			rendered.endsWith(PROMPT_END_MARKER),
			`The rendered prompt does not end with ${PROMPT_END_MARKER}. The plugin's bootstrap treats a missing marker as a truncated prompt and refuses to build, so appending anything after the marker — or dropping it — strands every caller of this mode.`,
		).toBe(true);
	});

	it("edit mode inlines the blueprint summary when it fits", () => {
		/* The common case, and the one worth protecting: an app small
		 * enough to carry gets its structure in the prompt, so the agent
		 * starts knowing what it is editing. Production measurement at
		 * the time of writing: 338 of 384 editable apps. */
		const rendered = renderAgentPrompt(true, fixturePopulatedDoc());
		expect(rendered).toContain("## Current app state");
		expect(rendered).toContain("Vaccine Tracker");
		expect(rendered).not.toContain("too large to include here");
	});

	it("edit mode points at the read tools instead of inlining an app that will not fit", () => {
		/* An app whose summary would overrun the budget must not be
		 * inlined and must not be cut down: half a structural summary
		 * reads exactly like a whole one, and an agent that believes it
		 * has seen the app will edit the part it cannot see.
		 *
		 * The fixture is inflated with enough modules to blow the budget
		 * on its own, which is what production's largest apps do — the
		 * biggest renders 73,534 chars of summary against a base prompt
		 * already past 51,000. */
		const rendered = renderAgentPrompt(true, fixtureOversizedDoc());

		expect(rendered).toContain("too large to include here");
		/* The remedy has to name the tools, or the agent is told what it
		 * cannot do without being told what it can. */
		expect(rendered).toContain("get_app");
		/* Still deliverable and still provable — the fallback is not
		 * allowed to trade one delivery failure for another. */
		expect(rendered.length).toBeLessThanOrEqual(MAX_DELIVERABLE_PROMPT_CHARS);
		expect(rendered.endsWith(PROMPT_END_MARKER)).toBe(true);
	});
});
