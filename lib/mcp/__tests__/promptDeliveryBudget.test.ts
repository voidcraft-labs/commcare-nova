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

	it("edit mode leaves room for a real app's blueprint summary", () => {
		/* The fixture's summary is a few hundred chars; a production app
		 * runs far larger, and it lands after everything else. Asserting
		 * the fixed part alone clears the budget would pass right up
		 * until the moment a real app arrived, so the assertion is on
		 * the headroom that remains for the variable part. */
		const rendered = renderAgentPrompt(true, fixturePopulatedDoc());
		const headroom = MAX_DELIVERABLE_PROMPT_CHARS - rendered.length;
		expect(
			headroom,
			`The fixed part of the edit prompt leaves only ${headroom} chars for the inlined blueprint summary, which grows with the app. A large app would overrun the budget and lose its summary — the one section edit mode exists to deliver.`,
		).toBeGreaterThan(20_000);
	});
});
