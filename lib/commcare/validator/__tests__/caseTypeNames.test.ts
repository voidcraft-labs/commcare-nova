/**
 * A case type is CommCare HQ's case type grammar and nothing narrower: no
 * name is refused for being one of reference text's words, and a type may
 * start with a digit, an underscore or a hyphen. A reservation or an older
 * pattern left behind in one rule would refuse here what the verdicts take.
 */
import { describe, expect, it } from "vitest";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import type { BlueprintDoc } from "@/lib/domain";
import { runValidation } from "../runner";

/** A registration of `caseType` and a follow-up that creates a child of `childType`. */
function records(caseType: string, childType = "visit"): BlueprintDoc {
	return buildDoc({
		caseTypes: [
			{ name: caseType, properties: [{ name: "case_name", label: "Name" }] },
			{
				name: childType,
				parent_type: caseType,
				properties: [{ name: "case_name", label: "Name" }],
			},
		],
		modules: [
			{
				name: "Records",
				caseType,
				caseListConfig: caseListConfig([
					{ field: "case_name", header: "Name" },
				]),
				forms: [
					{
						name: "Register",
						type: "registration",
						fields: [
							f({
								kind: "text",
								id: "name",
								caseWrite: { caseType, property: "case_name" },
							}),
						],
					},
					{
						name: "Visit",
						type: "followup",
						fields: [
							f({
								kind: "text",
								id: "visit_name",
								caseWrite: { caseType: childType, property: "case_name" },
							}),
						],
					},
				],
			},
		],
	});
}

const codes = (doc: BlueprintDoc) =>
	runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE).map(({ code }) => code);

describe("case type names at the absolute gate", () => {
	it.each([
		"case",
		"parent",
		"user",
		"form",
		"search",
		"record",
		"row",
		"2024",
		"-x",
		"_x",
		"1st-visit",
	])("admits a menu and a child create of the type %j", (caseType) => {
		expect(codes(records(caseType))).toEqual([]);
		expect(codes(records("household", caseType))).toEqual([]);
	});

	it.each([
		["a b", "INVALID_CASE_TYPE_FORMAT"],
		["ñ", "INVALID_CASE_TYPE_FORMAT"],
		["x".repeat(256), "CASE_TYPE_TOO_LONG"],
	])("refuses the menu's case type %j as %s", (caseType, code) => {
		expect(codes(records(caseType))).toContain(code);
	});

	it.each(["a b", "ñ", "", "x".repeat(256)])(
		"refuses a child create of the type %j",
		(caseType) => {
			expect(codes(records("household", caseType))).toContain(
				"CASE_OPERATION_INVALID_CASE_TYPE",
			);
		},
	);
});
