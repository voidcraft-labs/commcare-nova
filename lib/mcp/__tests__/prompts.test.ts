/** Renderer composition checks, not claims about model obedience. Protocol
 * delivery and stored-app authorization are exercised by getAgentPrompt tests. */
import { expect, it } from "vitest";
import { buildDoc } from "@/lib/__tests__/docHelpers";
import { renderAgentPrompt } from "../prompts";
import { promptDoc } from "./promptFixtures";

it.each([true, false])(
	"selects build framing and the requested interaction policy (%s)",
	(interactive) => {
		const prompt = renderAgentPrompt(interactive);
		expect(prompt).toContain("Initial Build");
		expect(prompt).not.toContain("Editing Mode");
		const policy = prompt.slice(prompt.lastIndexOf("## Interaction Mode"));
		expect(policy).toContain(
			interactive
				? "You may use the AskUserQuestion tool"
				: "Do NOT attempt to ask the user questions",
		);
		expect(policy).toContain(
			interactive
				? "Do not ask\nfor permission to proceed"
				: "tool is not available to you in this mode",
		);
		expect(prompt.endsWith("NOVA-PROMPT-END")).toBe(true);
	},
);
it("includes addressable app state under edit framing before the terminal marker", () => {
	const doc = promptDoc();
	const prompt = renderAgentPrompt(true, doc);
	expect(prompt).toContain("Editing Mode");
	expect(prompt).not.toContain("Initial Build");
	const appState = prompt.slice(prompt.lastIndexOf("## Current app state"));
	expect(appState).toContain("Vaccine Tracker");
	expect(appState).toContain(
		`Module "Clinic visits" [uuid ${doc.moduleOrder[0]}]`,
	);
	expect(appState).toContain("Patient intake");
	expect(appState).toContain("patient_name");
	expect(appState.endsWith("NOVA-PROMPT-END")).toBe(true);
});
it("treats an in-memory empty document as build input without app state", () => {
	for (const interactive of [true, false]) {
		expect(renderAgentPrompt(interactive, buildDoc())).toBe(
			renderAgentPrompt(interactive),
		);
	}
});
