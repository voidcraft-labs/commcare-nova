/**
 * A choice's stored value has to be something the wire can carry.
 *
 * The facts behind the two rules are the runtime's: CommCare Android throws
 * on any select whose value contains a space
 * (`QuestionWidget.java::getSelectChoices`), a multi-select answer is a
 * space-joined token list (`selected()` splits on spaces), and the case
 * list compares a select property inside an XPath literal
 * (`field = 'value'`), which a quote breaks. An empty value saves nothing.
 */

import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, type FieldSpec, f } from "@/lib/__tests__/docHelpers";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { proseText } from "@/lib/domain/prose";
import { runValidation } from "../runner";

const FIELD_CODE = "SELECT_OPTION_VALUE_INVALID";
const CATALOG_CODE = "CASE_PROPERTY_OPTION_VALUE_INVALID";

function option(value: string, label: string, n: number) {
	return { uuid: testUuid(`opt-${n}`), value, label: proseText(label) };
}

function select(
	kind: "single_select" | "multi_select",
	values: Array<[value: string, label: string]>,
): FieldSpec {
	return f({
		kind,
		id: "answer",
		label: proseText("Answer"),
		optionsSource: {
			kind: "inline",
			options: values.map(([value, label], i) => option(value, label, i + 1)),
		},
	});
}

function fieldFindings(field: FieldSpec) {
	const doc = buildDoc({
		appName: "Choices",
		modules: [
			{
				name: "Visits",
				forms: [{ name: "Visit", type: "survey", fields: [field] }],
			},
		],
	});
	return runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE).filter(
		(e) => e.code === FIELD_CODE,
	);
}

describe("SELECT_OPTION_VALUE_INVALID", () => {
	it("says nothing about slugs and safe codes", () => {
		expect(
			fieldFindings(
				select("single_select", [
					["yes", "Yes"],
					["prefer_not_to_say", "Prefer not to say"],
					["ICD10", "ICD-10"],
					["a-b", "A or B"],
				]),
			),
		).toEqual([]);
	});

	it("refuses a value holding a space on a single select, naming the slug to use", () => {
		const findings = fieldFindings(
			select("single_select", [
				["yes", "Yes"],
				["Prefer not to say", "Prefer not to say"],
			]),
		);
		expect(findings).toHaveLength(1);
		const [finding] = findings;
		expect(finding?.scope).toBe("field");
		expect(finding?.location.fieldId).toBe("answer");
		expect(finding?.details).toMatchObject({
			optionUuid: testUuid("opt-2"),
			optionValue: "Prefer not to say",
			problem: "whitespace",
			suggestedValue: "prefer_not_to_say",
		});
		expect(finding?.message).toContain('Option 2 ("Prefer not to say")');
		expect(finding?.message).toContain("contains a space");
		expect(finding?.message).toContain('Use "prefer_not_to_say" instead');
		expect(finding?.message).toContain("underscores");
	});

	it("refuses the same value on a multi select, where the answer is a space-joined list", () => {
		const findings = fieldFindings(
			select("multi_select", [
				["under 5", "Under 5"],
				["over_5", "Over 5"],
			]),
		);
		expect(findings).toHaveLength(1);
		expect(findings[0]?.details).toMatchObject({
			problem: "whitespace",
			suggestedValue: "under_5",
		});
	});

	it("refuses a quote mark, which breaks the XPath literal the case list compares with", () => {
		const findings = fieldFindings(
			select("single_select", [
				["don't_know", "Don't know"],
				["yes", "Yes"],
			]),
		);
		expect(findings).toHaveLength(1);
		expect(findings[0]?.details).toMatchObject({
			problem: "quote",
			suggestedValue: "dont_know",
		});
		expect(findings[0]?.message).toContain("quote mark");
	});

	it("refuses an empty value and suggests a slug from the label", () => {
		const findings = fieldFindings(
			select("single_select", [
				["", "Not applicable"],
				["yes", "Yes"],
			]),
		);
		expect(findings).toHaveLength(1);
		expect(findings[0]?.details).toMatchObject({
			problem: "empty",
			suggestedValue: "not_applicable",
		});
		expect(findings[0]?.message).toContain("has an empty value");
	});

	it("never suggests a value a sibling already holds", () => {
		const findings = fieldFindings(
			select("single_select", [
				["a b", "A b"],
				["a_b", "A b again"],
			]),
		);
		expect(findings).toHaveLength(1);
		expect(findings[0]?.details?.suggestedValue).toBe("a_b_2");
		expect(findings[0]?.message).toContain('Use "a_b_2" instead');
	});

	it("suggests a slug in the label's own script rather than an ASCII stub", () => {
		const findings = fieldFindings(
			select("single_select", [
				["Sí claro", "Sí"],
				["no", "No"],
			]),
		);
		expect(findings[0]?.details?.suggestedValue).toBe("sí_claro");
	});

	it("reports every broken option, one finding each", () => {
		const findings = fieldFindings(
			select("single_select", [
				["a b", "A b"],
				["c d", "C d"],
				["ok", "Ok"],
			]),
		);
		expect(findings.map((e) => e.details?.optionValue)).toEqual(["a b", "c d"]);
	});
});

describe("CASE_PROPERTY_OPTION_VALUE_INVALID", () => {
	function catalogFindings(options: Array<{ value: string; label: string }>) {
		const doc = buildDoc({
			appName: "Choices",
			caseTypes: [
				{
					name: "client",
					properties: [
						{
							name: "status",
							label: "Status",
							data_type: "single_select",
							options,
						},
					],
				},
			],
			modules: [
				{
					name: "Clients",
					caseType: "client",
					forms: [{ name: "Register", type: "registration", fields: [] }],
				},
			],
		});
		return runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE).filter(
			(e) => e.code === CATALOG_CODE,
		);
	}

	it("says nothing about a catalog whose values are slugs", () => {
		expect(
			catalogFindings([
				{ value: "open", label: "Open" },
				{ value: "closed", label: "Closed" },
			]),
		).toEqual([]);
	});

	it("refuses a catalog value the suite could not compare, naming the property", () => {
		const findings = catalogFindings([
			{ value: "in progress", label: "In progress" },
			{ value: "closed", label: "Closed" },
		]);
		expect(findings).toHaveLength(1);
		const [finding] = findings;
		expect(finding?.scope).toBe("app");
		expect(finding?.details).toMatchObject({
			caseType: "client",
			property: "status",
			optionValue: "in progress",
			problem: "whitespace",
			suggestedValue: "in_progress",
		});
		expect(finding?.message).toContain('case property "client.status"');
		expect(finding?.message).toContain('Use "in_progress" instead');
	});
});
