import { describe, expect, it } from "vitest";
import type { BlueprintDoc } from "@/lib/domain";
import { asUuid } from "@/lib/domain";
import { renderAgentPrompt } from "../prompts";

function editableDoc(): BlueprintDoc {
	const moduleUuid = asUuid("11111111-1111-1111-1111-111111111111");
	return {
		appId: "app-1",
		appName: "Test",
		connectType: null,
		caseTypes: null,
		modules: {
			[moduleUuid]: {
				uuid: moduleUuid,
				id: "patients",
				name: "Patients",
				caseType: "patient",
			},
		},
		forms: {},
		fields: {},
		moduleOrder: [moduleUuid],
		formOrder: { [moduleUuid]: [] },
		fieldOrder: {},
		fieldParent: {},
	};
}

describe("MCP agent prompt dormant-carrier vocabulary", () => {
	it("omits dormant lookup AST arms in build and edit modes", () => {
		for (const prompt of [
			renderAgentPrompt(true),
			renderAgentPrompt(true, editableDoc()),
		]) {
			expect(prompt).toContain("Filters & expressions");
			expect(prompt).toContain("type Predicate =");
			expect(prompt).toContain("type ValueExpression =");
			expect(prompt).not.toContain("CarrierBlind");
			expect(prompt).not.toContain("table-column");
			expect(prompt).not.toContain("table-lookup");
		}
	});
});
