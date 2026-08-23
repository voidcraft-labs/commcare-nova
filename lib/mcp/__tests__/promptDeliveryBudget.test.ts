/**
 * Delivery contract for the served agent prompt. Every mode ends with a
 * marker the plugin checks, and edit mode carries the complete app summary.
 */

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { xp } from "@/lib/__tests__/docHelpers";
import type { BlueprintDoc } from "@/lib/domain";
import { proseText } from "@/lib/domain/prose";

import { type AgentPromptPage, deliverAgentPrompt } from "../promptDelivery";
import { PROMPT_END_MARKER, renderAgentPrompt } from "../prompts";
import { MAX_RESULT_SIZE_CHARS } from "../resultSize";

/**
 * A populated blueprint, so edit mode takes its real branch and inlines
 * a summary. Deliberately small: the point is to measure the fixed cost
 * of the edit prompt, not to guess at a realistic app's summary size.
 */
function fixturePopulatedDoc(): BlueprintDoc {
	const modUuid = testUuid("11111111-1111-1111-1111-111111111111");
	const formUuid = testUuid("22222222-2222-2222-2222-222222222222");
	const fieldUuid = testUuid("33333333-3333-3333-3333-333333333333");
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
				label: proseText("Patient Name"),
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
 * A large app whose first and last module names prove the summary was not
 * replaced by a fallback. Built by repeating the fixture's module so it
 * remains representative when `summarizeBlueprint` changes.
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

	/* Large enough to exercise the former fallback boundary. */
	for (let i = 0; i < 1_200; i++) {
		const uuid = testUuid(
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

describe("served prompt delivery contract", () => {
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
		expect(deliverAgentPrompt(rendered).content[0]?.text).toBe(rendered);
	});

	it("pages and reassembles the complete large blueprint summary losslessly", () => {
		const rendered = renderAgentPrompt(true, fixtureOversizedDoc());
		expect(rendered.length).toBeGreaterThan(MAX_RESULT_SIZE_CHARS);

		const chunks: string[] = [];
		let cursor: string | undefined;
		let expectedStart = 0;
		let expectedDigest: string | undefined;
		do {
			const result = deliverAgentPrompt(rendered, cursor);
			const text = result.content[0]?.text ?? "";
			expect(text.length).toBeLessThanOrEqual(MAX_RESULT_SIZE_CHARS);
			const page = JSON.parse(text) as AgentPromptPage;
			expect(page.kind).toBe("nova-agent-prompt-page");
			expect(page.chunk_start).toBe(expectedStart);
			expect(page.chunk_end).toBe(page.chunk_start + page.prompt_chunk.length);
			expect(page.prompt_length).toBe(rendered.length);
			expectedDigest ??= page.prompt_sha256;
			expect(page.prompt_sha256).toBe(expectedDigest);
			chunks.push(page.prompt_chunk);
			cursor = page.next_cursor;
			expectedStart = page.chunk_end;
			if (page.complete) expect(cursor).toBeUndefined();
			else expect(cursor).toEqual(expect.any(String));
		} while (cursor !== undefined);

		const assembled = chunks.join("");
		expect(assembled).toBe(rendered);
		expect(expectedDigest).toBe(
			createHash("sha256").update(assembled, "utf8").digest("hex"),
		);

		expect(assembled).toContain(
			"Patients 0 — a module name long enough to carry real weight",
		);
		expect(assembled).toContain(
			"Patients 1199 — a module name long enough to carry real weight",
		);
		expect(assembled).not.toContain("too large to include here");
		expect(assembled.endsWith(PROMPT_END_MARKER)).toBe(true);
	});

	it("refuses to continue after the prompt snapshot changes", () => {
		const rendered = renderAgentPrompt(true, fixtureOversizedDoc());
		const firstText = deliverAgentPrompt(rendered).content[0]?.text ?? "";
		const firstPage = JSON.parse(firstText) as AgentPromptPage;
		expect(firstPage.next_cursor).toEqual(expect.any(String));

		expect(() =>
			deliverAgentPrompt(
				rendered.replace("Vaccine Tracker", "Changed Tracker"),
				firstPage.next_cursor,
			),
		).toThrow("changed during get_agent_prompt pagination");
	});
});
