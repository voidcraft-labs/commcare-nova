import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, f, xp } from "@/lib/__tests__/docHelpers";
import { proseText } from "@/lib/domain/prose";
import {
	scanBlueprintXPathCarriers,
	summarizeXPathCompatibility,
	xpathCompatibilityScanShouldFail,
} from "../xpathCompatibilityScan";

describe("scanBlueprintXPathCarriers", () => {
	it("scans field, form-link, Connect and catalog carriers under their runtime profiles", () => {
		const moduleUuid = testUuid("scan-module");
		const sourceFormUuid = testUuid("scan-source-form");
		const targetFormUuid = testUuid("scan-target-form");
		const doc = buildDoc({
			connectType: "deliver",
			caseTypes: [
				{
					name: "person",
					properties: [
						{
							name: "age",
							label: "Age",
							required: "true()",
							validation: ". >= 0",
						},
					],
				},
			],
			modules: [
				{
					uuid: moduleUuid,
					name: "Module",
					forms: [
						{
							uuid: sourceFormUuid,
							name: "Source",
							type: "survey",
							connect: {
								deliver_unit: {
									id: "delivery",
									name: "Delivery",
									entity_id: xp("uuid()"),
									entity_name: xp("'Delivery'"),
								},
							},
							formLinks: [
								{
									condition:
										"instance('commcaresession')/session/context/userid != ''",
									datums: [
										{
											name: "case_id",
											xpath: "instance('commcaresession')/session/data/case_id",
										},
									],
									target: {
										type: "form",
										moduleUuid,
										formUuid: targetFormUuid,
									},
								},
							],
							fields: [
								f({
									kind: "hidden",
									id: "normalized",
									calculate: "normalize-space(' value ')",
								}),
								f({
									kind: "hidden",
									id: "legacy_context",
									calculate: "here()",
								}),
								f({
									kind: "hidden",
									id: "union",
									calculate: "/data/one | /data/two",
								}),
								f({ kind: "hidden", id: "empty", calculate: "" }),
							],
						},
						{
							uuid: targetFormUuid,
							name: "Target",
							type: "survey",
							fields: [
								f({
									kind: "text",
									id: "answer",
									label: proseText("Answer"),
								}),
							],
						},
					],
				},
			],
		});
		const occurrences = scanBlueprintXPathCarriers(doc);
		expect(occurrences.map(({ slot, profile }) => ({ slot, profile }))).toEqual(
			[
				...Array.from({ length: 4 }, () => ({
					slot: "calculate",
					profile: "preview-form",
				})),
				{ slot: "deliver_entity_id", profile: "wire-form" },
				{ slot: "deliver_entity_name", profile: "wire-form" },
				{ slot: "form_link_condition", profile: "preview-session" },
				{ slot: "form_link_datum_xpath", profile: "preview-session" },
				{ slot: "case_property_required", profile: "wire-catalog" },
				{ slot: "case_property_validation", profile: "wire-catalog" },
			],
		);
		expect(occurrences.find(({ source }) => source === "")).toMatchObject({
			calls: [],
			findings: [],
		});
		const calls = occurrences.flatMap((occurrence) =>
			occurrence.calls.map((call) => ({ path: occurrence.path, ...call })),
		);

		expect(calls).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					name: "normalize-space",
					javaRosa: "lowered",
				}),
				expect.objectContaining({
					name: "here",
					javaRosa: "context-handler",
				}),
				expect.objectContaining({
					path: expect.stringContaining("formLinks[0].condition"),
					name: "instance",
					javaRosa: "path-initializer",
					validPathInitializer: true,
				}),
			]),
		);

		const summary = summarizeXPathCompatibility(occurrences);
		expect(summary).toEqual({
			expressions: 10,
			functionCalls: 6,
			javaRosaLoweredCalls: 1,
			errorFindings: 3,
			findings: [
				{
					profile: "preview-form",
					code: "XPATH_FUNCTION_UNAVAILABLE",
					severity: "error",
					count: 2,
				},
				{
					profile: "preview-form",
					code: "XPATH_UNSUPPORTED_UNION",
					severity: "error",
					count: 1,
				},
			],
		});
		expect(summarizeXPathCompatibility([...occurrences].reverse())).toEqual(
			summary,
		);
		const aggregateOutput = JSON.stringify(summary);
		expect(aggregateOutput).not.toContain(doc.appId);
		expect(aggregateOutput).not.toContain(sourceFormUuid);
		expect(aggregateOutput).not.toContain("/data/one");
		expect(xpathCompatibilityScanShouldFail(summary, 0)).toBe(true);
		expect(xpathCompatibilityScanShouldFail({ errorFindings: 0 }, 1)).toBe(
			true,
		);
		expect(xpathCompatibilityScanShouldFail({ errorFindings: 0 }, 0)).toBe(
			false,
		);
	});

	it("rejects mutable lookup wire names in raw XPath carriers", () => {
		const moduleUuid = testUuid("instance-scan-module");
		const targetModuleUuid = testUuid("instance-scan-target");
		const doc = buildDoc({
			modules: [
				{
					uuid: moduleUuid,
					name: "Source",
					forms: [
						{
							name: "Form",
							type: "survey",
							formLinks: [
								{
									condition:
										"instance('item-list:people')/people_list/people[1]/enabled = 'yes'",
									target: { type: "module", moduleUuid: targetModuleUuid },
								},
							],
							fields: [
								f({
									kind: "hidden",
									id: "name",
									calculate:
										"instance('item-list:people')/people_list/people[1]/name",
								}),
							],
						},
					],
				},
				{ uuid: targetModuleUuid, name: "Target" },
			],
		});
		const occurrences = scanBlueprintXPathCarriers(doc);
		const instanceFindings = occurrences.filter((occurrence) =>
			occurrence.findings.some(
				(finding) => finding.code === "XPATH_INSTANCE_UNAVAILABLE",
			),
		);
		expect(instanceFindings).toHaveLength(2);
		expect(instanceFindings).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					profile: "preview-form",
					slot: "calculate",
				}),
				expect.objectContaining({
					profile: "preview-session",
					slot: "form_link_condition",
				}),
			]),
		);
	});
});
