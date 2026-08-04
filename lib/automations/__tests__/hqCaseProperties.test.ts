import { describe, expect, it } from "vitest";
import {
	projectAutomationPropertyForHq,
	projectAutomationTemplateForHq,
} from "../hqCaseProperties";

describe("HQ automation case-property projection", () => {
	it.each([
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
		expect(projectAutomationPropertyForHq("alarm_time", "dynamic-only")).toBe(
			"alarm_time",
		);
	});

	it("projects exact case-property template tokens without rewriting other HQ namespaces", () => {
		expect(
			projectAutomationTemplateForHq(
				"{case.case_name} {case.parent.date_opened} {case.host.last_modified} {case.owner.name}",
			),
		).toBe(
			"{case.name} {case.parent.opened_on} {case.host.modified_on} {case.owner.name}",
		);
	});
});
