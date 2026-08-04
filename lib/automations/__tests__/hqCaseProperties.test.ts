import { describe, expect, it } from "vitest";
import {
	projectAutomationPropertyForHq,
	projectAutomationTemplateForHq,
} from "../hqCaseProperties";

describe("HQ automation case-property projection", () => {
	it.each([
		["case_id", "case_id"],
		["case_type", "type"],
		["case_name", "name"],
		["date_opened", "opened_on"],
		["last_modified", "modified_on"],
		["owner_id", "owner_id"],
		["external_id", "external_id"],
		["custom_value", "custom_value"],
	])("projects the Nova read name %s to %s", (nova, hq) => {
		expect(projectAutomationPropertyForHq(nova, "read")).toBe(hq);
	});

	it("refuses runtime-divergent standard properties in their exact slots", () => {
		expect(projectAutomationPropertyForHq("status", "read")).toBeUndefined();
		expect(
			projectAutomationPropertyForHq("date_opened", "update-target"),
		).toBeUndefined();
		expect(
			projectAutomationPropertyForHq("last_modified", "update-target"),
		).toBeUndefined();
		expect(
			projectAutomationPropertyForHq("case_name", "dynamic-only"),
		).toBeUndefined();
		expect(
			projectAutomationPropertyForHq("case_id", "dynamic-only"),
		).toBeUndefined();
		expect(
			projectAutomationPropertyForHq("case_type", "dynamic-only"),
		).toBeUndefined();
		expect(
			projectAutomationPropertyForHq("case_type", "update-target"),
		).toBeUndefined();
		expect(projectAutomationPropertyForHq("alarm_time", "dynamic-only")).toBe(
			"alarm_time",
		);
	});

	it("projects structural property atoms while leaving token-looking text literal", () => {
		expect(
			projectAutomationTemplateForHq({
				parts: [
					{
						kind: "case-property",
						scope: "case",
						caseType: "visit",
						property: "case_type",
					},
					{ kind: "text", text: " " },
					{
						kind: "case-property",
						scope: "case",
						caseType: "visit",
						property: "case_name",
					},
					{ kind: "text", text: " " },
					{
						kind: "case-property",
						scope: "parent",
						caseType: "household",
						property: "date_opened",
					},
					{ kind: "text", text: " " },
					{
						kind: "case-property",
						scope: "host",
						caseType: "host",
						property: "last_modified",
					},
					{ kind: "text", text: " {case.owner.name}" },
				],
			}),
		).toBe(
			"{case.type} {case.name} {case.parent.opened_on} {case.host.modified_on} {case.owner.name}",
		);
	});
});
