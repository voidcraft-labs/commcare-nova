import { describe, expect, it } from "vitest";
import { isInternalDesignToolPartType } from "@/lib/chat/internalToolParts";

describe("internal design tool presentation", () => {
	it.each([
		"tool-stageContract",
		"tool-stageRevision",
		"tool-inspectDesignWorkspace",
		"tool-submitContract",
		"tool-requestReview",
		"tool-submitRevision",
	])("hides %s", (type) => {
		expect(isInternalDesignToolPartType(type)).toBe(true);
	});

	it("keeps ordinary builder edits visible", () => {
		expect(isInternalDesignToolPartType("tool-addFields")).toBe(false);
	});
});
