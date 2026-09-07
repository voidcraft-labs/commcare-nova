import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, f, xp } from "@/lib/__tests__/docHelpers";
import {
	expectAdmittedDoc,
	surveyFixture,
} from "@/lib/agent/__tests__/admittedFixture";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { lookupTableIdSchema, proseText } from "@/lib/domain";
import { parseLookupRevision } from "@/lib/lookup/schema";
import { runValidation } from "../runner";
import { validateXPath } from "../xpathValidator";

// Exercises Nova's source validator and document admission, not a native JavaRosa execution.
describe("XPath compatibility diagnostics", () => {
	it.each([
		"/data/x[p]/@id",
		"../x",
		"current()/../@id",
		"child::*",
		"attribute::id",
		"self::node()",
	])("accepts supported syntax: %s", (source) => {
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
	] as const)("reports unsupported syntax: %s", (source, code) => {
		expect(validateXPath(source)).toEqual([expect.objectContaining({ code })]);
	});

	it("accepts the nodeset overload under form carrier profiles", () => {
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
		const doc = {
			...expectAdmittedDoc(surveyFixture()),
			caseTypes: [
				{
					name: "person",
					properties: [
						{
							name: "age",
							label: proseText("Age"),
							validation: xp("left | right"),
						},
					],
				},
			],
		};
		expectAdmittedDoc({
			...doc,
			caseTypes: [
				{
					name: "person",
					properties: [
						{ name: "age", label: proseText("Age"), validation: xp(". >= 0") },
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
		expectAdmittedDoc(withInstance("commcaresession"));
		expect(
			runValidation(withInstance("missing"), LOOKUP_CONTEXT_UNAVAILABLE).some(
				(finding) => finding.code === "XPATH_INSTANCE_UNAVAILABLE",
			),
		).toBe(true);

		const availableLookup = {
			kind: "available" as const,
			projectId: "project",
			projectRevision: parseLookupRevision("1"),
			definitions: [
				{
					id: lookupTableIdSchema.parse("01912d68-783e-7000-8000-00000000a001"),
					name: "People",
					tag: "people",
					definitionRevision: parseLookupRevision("1"),
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
								postSubmit: "app_home",
								fields: [f({ kind: "text", id: "note", label: "Note" })],
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
					{
						uuid: targetModuleUuid,
						name: "Target",
						forms: [
							{
								name: "Target survey",
								type: "survey",
								fields: [f({ kind: "text", id: "note", label: "Note" })],
							},
						],
					},
				],
			});
		expectAdmittedDoc(withSessionInstance("commcaresession"), availableLookup);
		expect(
			runValidation(
				withSessionInstance("item-list:people"),
				availableLookup,
			).some((finding) => finding.code === "XPATH_INSTANCE_UNAVAILABLE"),
		).toBe(true);
	});
});
