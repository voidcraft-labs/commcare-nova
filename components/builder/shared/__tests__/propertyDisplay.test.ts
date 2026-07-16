import { describe, expect, it } from "vitest";
import { propertyDisplayLabel } from "../primitives/propertyDisplay";

describe("propertyDisplayLabel", () => {
	it("uses friendly system labels instead of stored identifiers", () => {
		expect(
			propertyDisplayLabel({ name: "external_id", label: "external_id" }),
		).toBe("External ID");
		expect(propertyDisplayLabel({ name: "status", label: "Status" })).toBe(
			"Case status (open or closed)",
		);
	});

	it("keeps a meaningful authored label", () => {
		expect(
			propertyDisplayLabel({ name: "case_name", label: "Patient name" }),
		).toBe("Patient name");
		expect(
			propertyDisplayLabel({ name: "current_status", label: "Workflow stage" }),
		).toBe("Workflow stage");
	});
});
