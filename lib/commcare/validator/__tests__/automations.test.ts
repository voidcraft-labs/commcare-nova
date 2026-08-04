import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc } from "@/lib/__tests__/docHelpers";
import type { Automation, BlueprintDoc } from "@/lib/domain";
import { validateAutomations } from "../rules/automations";

function docWithCriterion(
	scope: "case" | "parent" | "host",
	property: string,
	matchType: "has-value" | "date-days",
): BlueprintDoc {
	const doc = buildDoc({
		appName: "Automation validation",
		caseTypes: [
			{
				name: "household",
				properties: [{ name: "state", label: "State", data_type: "text" }],
			},
			{
				name: "visit",
				parent_type: "household",
				relationship: "child",
				properties: [{ name: "due", label: "Due", data_type: "date" }],
			},
		],
	});
	const uuid = testUuid(`validator-${scope}-${property}-${matchType}`);
	const automation: Automation = {
		uuid,
		kind: "case-update",
		name: "Update related case",
		caseType: "visit",
		criteriaOperator: "all",
		criteria: [
			{
				uuid: testUuid(`criterion-${scope}-${property}-${matchType}`),
				kind: "match-property",
				scope,
				property,
				matchType,
				...(matchType === "date-days" ? { days: 0 } : {}),
			},
		],
		setupOnlyCriteria: [],
		updates: [],
		closeCase: true,
	};
	doc.automations = { [uuid]: automation };
	doc.automationOrder = [uuid];
	return doc;
}

describe("automation property criteria validation", () => {
	it("resolves a parent criterion against the declared parent case type", () => {
		expect(
			validateAutomations(docWithCriterion("parent", "state", "has-value")),
		).toEqual([]);
	});

	it("rejects a scope with no matching relationship", () => {
		expect(
			validateAutomations(docWithCriterion("host", "state", "has-value")),
		).toEqual([
			expect.objectContaining({
				code: "AUTOMATION_INVALID",
				details: expect.objectContaining({ path: "criteria.0.scope" }),
			}),
		]);
	});

	it("type-checks date comparisons in the related case scope", () => {
		expect(
			validateAutomations(docWithCriterion("parent", "state", "date-days")),
		).toEqual([
			expect.objectContaining({
				code: "AUTOMATION_INVALID",
				details: expect.objectContaining({ path: "criteria.0.matchType" }),
			}),
		]);
	});
});
