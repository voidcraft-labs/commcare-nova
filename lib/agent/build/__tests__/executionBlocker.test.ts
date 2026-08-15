import { describe, expect, it } from "vitest";
import { strictWireJsonSchema } from "@/lib/agent/strictStructuredOutput";
import {
	architectBlockerDecisionSchema,
	architectBlockerDecisionWireSchemaFor,
	executionBlockerSchema,
} from "../executionBlocker";

describe("architect blocker decisions", () => {
	it("wraps the decision union for provider strict mode", () => {
		const wire = strictWireJsonSchema(architectBlockerDecisionWireSchemaFor());
		expect(wire.type).toBe("object");
		expect(wire.properties).toHaveProperty("decision");
	});

	it("accepts compiler guidance and semantic escalation", () => {
		expect(
			architectBlockerDecisionSchema.safeParse({
				kind: "continue",
				guidance: "Use the selected patient as the parent of the visit.",
			}).success,
		).toBe(true);
		expect(
			architectBlockerDecisionSchema.safeParse({
				kind: "contract-revision",
				reason: "The accepted relationship is ambiguous.",
				question: "Should one visit belong to exactly one patient?",
				options: ["Yes", "No"],
			}).success,
		).toBe(true);
	});

	it("has no model-authored plan-repair branch", () => {
		expect(
			architectBlockerDecisionSchema.safeParse({
				kind: "plan-repair",
				reason: "Try different slices.",
			}).success,
		).toBe(false);
	});

	it("reports exact observations without model-authored tracking ids", () => {
		expect(
			executionBlockerSchema.safeParse({
				schemaVersion: 1,
				observations: ["The current form cannot express the accepted effect."],
				requestedDecision: "Clarify the safe lowering.",
			}).success,
		).toBe(true);
		expect(
			executionBlockerSchema.safeParse({
				schemaVersion: 1,
				affectedConstructionGroupIds: ["11111111-1111-4111-8111-111111111111"],
				observations: ["The current form cannot express the accepted effect."],
				requestedDecision: "Clarify the safe lowering.",
			}).success,
		).toBe(false);
	});
});
