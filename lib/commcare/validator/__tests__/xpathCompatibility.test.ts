import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { runValidation } from "../runner";
import { validateXPath } from "../xpathValidator";

describe("XPath executable-language admission", () => {
	it.each([
		"/data/x[p]/@id",
		"../x",
		"current()/../@id",
		"child::*",
		"attribute::id",
		"self::node()",
	])("admits JavaRosa-executable syntax: %s", (source) => {
		expect(validateXPath(source)).toEqual([]);
	});

	it.each([
		["left | right", "XPATH_UNSUPPORTED_UNION"],
		["//case", "XPATH_UNSUPPORTED_DESCENDANT"],
		["(case)[1]", "XPATH_UNSUPPORTED_FILTER"],
		["descendant::case", "XPATH_UNSUPPORTED_AXIS"],
		["@*", "XPATH_UNSUPPORTED_NODE_TEST"],
		["a/../b", "XPATH_UNSUPPORTED_PATH"],
		["$value", "XPATH_UNBOUND_VARIABLE"],
	] as const)("rejects non-executable syntax: %s", (source, code) => {
		expect(validateXPath(source)).toEqual([expect.objectContaining({ code })]);
	});

	it("admits JavaRosa nodeset overloads in Preview and wire carriers", () => {
		expect(validateXPath("concat(/data/items)")).toEqual([]);
		expect(
			validateXPath(
				"concat(/data/items)",
				undefined,
				undefined,
				false,
				"form",
				"wire-form",
			),
		).toEqual([]);
	});

	it("gates catalog constraints through the canonical carrier inventory", () => {
		const doc = buildDoc({
			caseTypes: [
				{
					name: "person",
					properties: [
						{
							name: "age",
							label: "Age",
							validation: "left | right",
						},
					],
				},
			],
		});
		const findings = runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE).filter(
			(finding) => finding.code === "CASE_PROPERTY_XPATH_INCOMPATIBLE",
		);
		expect(findings).toEqual([
			expect.objectContaining({
				scope: "app",
				details: expect.objectContaining({
					profile: "wire-catalog",
					findingCode: "XPATH_UNSUPPORTED_UNION",
				}),
			}),
		]);
	});

	it("gates raw instance ids independently of mutable lookup wire names", () => {
		const withInstance = (id: string) =>
			buildDoc({
				modules: [
					{
						name: "Module",
						forms: [
							{
								name: "Form",
								type: "survey",
								fields: [
									f({
										kind: "hidden",
										id: "value",
										calculate: `instance('${id}')/rows/row`,
									}),
								],
							},
						],
					},
				],
			});
		expect(
			runValidation(withInstance("missing"), LOOKUP_CONTEXT_UNAVAILABLE).some(
				(finding) => finding.code === "XPATH_INSTANCE_UNAVAILABLE",
			),
		).toBe(true);

		const availableLookup = {
			kind: "available" as const,
			projectId: "project",
			projectRevision: "1" as never,
			definitions: [
				{
					id: testUuid("lookup-table") as never,
					name: "People",
					tag: "people",
					definitionRevision: "1" as never,
					columns: [],
				},
			],
		};
		expect(
			runValidation(withInstance("people"), availableLookup).some(
				(finding) => finding.code === "XPATH_INSTANCE_UNAVAILABLE",
			),
		).toBe(true);
		expect(
			runValidation(withInstance("item-list:people"), availableLookup).some(
				(finding) => finding.code === "XPATH_INSTANCE_UNAVAILABLE",
			),
		).toBe(true);

		const targetModuleUuid = testUuid("target-module");
		const withSessionInstance = (id: string) =>
			buildDoc({
				modules: [
					{
						name: "Source",
						forms: [
							{
								name: "Source form",
								type: "survey",
								formLinks: [
									{
										condition: `instance('${id}')/people_list/people[1]/enabled = 'yes'`,
										target: {
											type: "module",
											moduleUuid: targetModuleUuid,
										},
									},
								],
							},
						],
					},
					{ uuid: targetModuleUuid, name: "Target" },
				],
			});
		expect(
			runValidation(
				withSessionInstance("item-list:people"),
				availableLookup,
			).some((finding) => finding.code === "XPATH_INSTANCE_UNAVAILABLE"),
		).toBe(true);
	});
});
