import { describe, expect, it } from "vitest";
import { buildDoc } from "@/lib/__tests__/docHelpers";
import {
	ancestorPath,
	count,
	eq,
	gt,
	input,
	isNull,
	literal,
	match,
	matchAll,
	matchNone,
	type Predicate,
	prop,
	relationStep,
	selfPath,
	sessionUser,
} from "@/lib/domain/predicate";
import {
	formDisplayCondition,
	moduleDisplayCondition,
} from "../validator/rules/displayConditions";

function validateModule(condition: Predicate) {
	const doc = buildDoc({
		appName: "Display",
		modules: [
			{
				name: "Visits",
				displayCondition: condition,
				forms: [{ name: "Survey", type: "survey" }],
			},
		],
	});
	const moduleUuid = doc.moduleOrder[0];
	return moduleDisplayCondition(doc.modules[moduleUuid], moduleUuid, doc).map(
		(error) => error.code,
	);
}

function validateForm(
	condition: Predicate,
	formType: "followup" | "survey" = "followup",
) {
	const doc = buildDoc({
		appName: "Display",
		modules: [
			{
				name: "Visits",
				caseType: "patient",
				forms: [
					{
						name: "Visit",
						type: formType,
						displayCondition: condition,
					},
				],
			},
		],
		caseTypes: [
			{
				name: "household",
				properties: [{ name: "name", label: "Name" }],
			},
			{
				name: "patient",
				parent_type: "household",
				properties: [
					{ name: "status", label: "Status" },
					{ name: "age", label: "Age", data_type: "int" },
				],
			},
		],
	});
	const moduleUuid = doc.moduleOrder[0];
	const formUuid = doc.formOrder[moduleUuid][0];
	return formDisplayCondition(doc, formUuid, moduleUuid).map(
		(error) => error.code,
	);
}

describe("module display-condition validation", () => {
	it("allows user/session values and rejects case reads", () => {
		expect(
			validateModule(eq(sessionUser("role"), literal("supervisor"))),
		).toEqual([]);
		expect(
			validateModule(eq(prop("patient", "status"), literal("open"))),
		).toContain("MODULE_DISPLAY_CONDITION_CASE_DATA_UNAVAILABLE");
	});

	it("rejects Search answers and conditions that simplify to false", () => {
		expect(validateModule(eq(input("name"), literal("Ada")))).toContain(
			"DISPLAY_CONDITION_SEARCH_INPUT_UNAVAILABLE",
		);
		expect(validateModule(matchNone())).toContain(
			"DISPLAY_CONDITION_ALWAYS_FALSE",
		);
		expect(validateModule(matchAll())).toEqual([]);
	});
});

describe("form display-condition validation", () => {
	it("allows a direct selected-case read in a case-first module", () => {
		expect(
			validateForm(eq(prop("patient", "status"), literal("open"))),
		).toEqual([]);
	});

	it("rejects case reads when the module is forms-first", () => {
		expect(
			validateForm(eq(prop("patient", "status"), literal("open")), "survey"),
		).toContain("FORM_DISPLAY_CONDITION_CASE_DATA_UNAVAILABLE");
	});

	it("rejects related reads and counts even in a case-first module", () => {
		const parent = ancestorPath(relationStep("parent", "household"));
		expect(
			validateForm(eq(prop("household", "name", parent), literal("Smith"))),
		).toContain("FORM_DISPLAY_CONDITION_CASE_DATA_UNAVAILABLE");
		expect(validateForm(gt(count(selfPath()), literal(0)))).toContain(
			"FORM_DISPLAY_CONDITION_CASE_DATA_UNAVAILABLE",
		);
	});

	it("rejects non-portable on-device operators", () => {
		expect(validateForm(isNull(prop("patient", "status")))).toContain(
			"DISPLAY_CONDITION_NOT_ON_DEVICE",
		);
		expect(
			validateForm(match(prop("patient", "status"), literal("open"), "fuzzy")),
		).toContain("DISPLAY_CONDITION_NOT_ON_DEVICE");
	});

	it("reports type errors independently of context availability", () => {
		expect(
			validateForm(eq(prop("patient", "age"), literal("not a number"))),
		).toContain("FORM_DISPLAY_CONDITION_TYPE_ERROR");
	});
});
