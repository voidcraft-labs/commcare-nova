import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { isAutomationMessageShadowedCaseProperty } from "@/lib/domain";
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

	it("escapes literal braces and projects every structural context atom", () => {
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
					{ kind: "text", text: " {case.owner.name} " },
					{
						kind: "context-property",
						context: "case-owner",
						property: "name",
					},
					{ kind: "text", text: " " },
					{
						kind: "context-property",
						context: "recipient",
						property: "phone_number",
					},
				],
			}),
		).toBe(
			"{case.type} {case.name} {case.parent.opened_on} {case.host.modified_on} {{case.owner.name}} {case.owner.name} {recipient.phone_number}",
		);
	});

	it("fails closed when a bypassed message part names an HQ-shadowed custom property", () => {
		for (const scope of ["case", "parent", "host"] as const) {
			for (const property of ["owner", "host", "last_modified_by"] as const) {
				expect(isAutomationMessageShadowedCaseProperty(property)).toBe(true);
				expect(
					projectAutomationTemplateForHq({
						parts: [
							{
								kind: "case-property",
								scope,
								caseType: "visit",
								property,
							},
						],
					}),
				).toBe("{case.[reference needs repair]}");
			}
		}
		expect(isAutomationMessageShadowedCaseProperty("owner_id")).toBe(false);
	});
});

it("projected literal and reference atoms are consumed distinctly by Python Formatter", async () => {
	const projected = projectAutomationTemplateForHq({
		parts: [
			{
				kind: "text",
				text: "Literal {case.owner.name}; { arbitrary }; owner ",
			},
			{ kind: "context-property", context: "case-owner", property: "name" },
			{ kind: "text", text: "; case " },
			{
				kind: "case-property",
				scope: "case",
				caseType: "visit",
				property: "case_name",
			},
		],
	});
	const { stdout } = await promisify(execFile)("python3", [
		"-c",
		`import string,sys
from types import SimpleNamespace
case=SimpleNamespace(name="Ana",owner=SimpleNamespace(name="Nurse"))
print(string.Formatter().vformat(sys.argv[1],[],{"case":case}))`,
		projected,
	]);
	expect(stdout.trimEnd()).toBe(
		"Literal {case.owner.name}; { arbitrary }; owner Nurse; case Ana",
	);
});
