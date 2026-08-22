import { describe, expect, it } from "vitest";
import { isDesignProtocolToolPartType } from "@/lib/chat/internalToolParts";
import {
	isEditToolPart,
	toolAction,
	toolDetail,
	toolStatus,
} from "@/lib/chat/toolSummary";

describe("design protocol tool presentation", () => {
	const DESIGN_PART_TYPES = [
		"tool-setDesignRoot",
		"tool-updateActors",
		"tool-updateRecords",
		"tool-updateWorkflows",
		"tool-updateLists",
		"tool-updateAccess",
		"tool-updateNavigation",
		"tool-updateModuleCompositions",
		"tool-updateFormCompositions",
		"tool-updateExternalRequirements",
		"tool-updateDecisions",
		"tool-updateAssumptions",
		"tool-updateOpenQuestions",
		"tool-updateFindingDispositions",
		"tool-inspectDesign",
		"tool-finishDesign",
		"tool-requestReview",
	] as const;

	it.each(DESIGN_PART_TYPES)("classifies %s as protocol", (type) => {
		expect(isDesignProtocolToolPartType(type)).toBe(true);
	});

	it("keeps ordinary builder edits out of the protocol set", () => {
		expect(isDesignProtocolToolPartType("tool-addFields")).toBe(false);
	});

	it("keeps the explicit wait terminal internal and out of mutation summaries", () => {
		expect(isDesignProtocolToolPartType("tool-waitForInput")).toBe(true);
		expect(
			isEditToolPart({
				type: "tool-waitForInput",
				toolCallId: "wait-1",
				state: "output-available",
				output: { ok: true, awaitingInput: true },
			} as never),
		).toBe(false);
	});

	it.each(DESIGN_PART_TYPES)(
		"projects %s to a friendly phrase, never the raw name",
		(type) => {
			const part = {
				type,
				toolCallId: "call-1",
				state: "input-available",
			} as never;
			const action = toolAction(part);
			expect(action).not.toContain(type.replace(/^tool-/, ""));
			expect(action).toMatch(/^[A-Z]/);
		},
	);

	it("suppresses model-facing payloads on both result branches", () => {
		/* The success message is an instruction to the model and the error is a
		 * protocol rejection diagnostic; neither may face the user. Status stays
		 * honest: a rejected call still reads as failed, silently. */
		const success = {
			type: "tool-updateWorkflows",
			toolCallId: "call-1",
			state: "output-available",
			output: { ok: true, message: "Continue staging related items." },
		} as never;
		expect(toolDetail(success)).toBeNull();
		expect(toolStatus(success)).toBe("done");

		const rejection = {
			type: "tool-updateFindingDispositions",
			toolCallId: "call-2",
			state: "output-available",
			output: {
				error: "The finding handle @f4 does not exist on this review.",
			},
		} as never;
		expect(toolDetail(rejection)).toBeNull();
		expect(toolStatus(rejection)).toBe("failed");
	});
});
