// components/builder/case-list-config/__tests__/configValidity.test.ts
//
// Pins the pure whole-config validity gate the workspace's live
// preview sits behind. The verdict must mirror what the entity
// editors surface: a config every editor would render error-free is
// valid; a config any editor would flag is invalid.

import { describe, expect, it } from "vitest";
import {
	advancedSearchInputDef,
	type CaseListConfig,
	type CaseType,
	calculatedColumn,
	dateColumn,
	plainColumn,
	simpleSearchInputDef,
} from "@/lib/domain";
import {
	eq,
	input,
	literal,
	matchAll,
	prop,
	term,
	whenInput,
} from "@/lib/domain/predicate";
import { asUuid } from "@/lib/domain/uuid";
import { isCaseListConfigValid } from "../configValidity";

const CASE_TYPES: CaseType[] = [
	{
		name: "patient",
		properties: [
			{ name: "name", label: "Name", data_type: "text" },
			{ name: "dob", label: "Date of birth", data_type: "date" },
		],
	} as CaseType,
];

function config(partial: Partial<CaseListConfig>): CaseListConfig {
	return { columns: [], searchInputs: [], ...partial };
}

describe("isCaseListConfigValid", () => {
	it("accepts an empty config", () => {
		expect(isCaseListConfigValid(config({}), CASE_TYPES, "patient")).toBe(true);
	});

	it("accepts well-typed columns, filter, and inputs", () => {
		const ok = config({
			columns: [
				plainColumn(asUuid("c1"), "name", "Name"),
				dateColumn(asUuid("c2"), "dob", "DOB", "%d/%m/%Y"),
			],
			filter: {
				kind: "neq",
				left: term(prop("patient", "name")),
				right: term(literal("")),
			},
			searchInputs: [
				simpleSearchInputDef(
					asUuid("s1"),
					"patient_name",
					"Patient name",
					"text",
					"name",
				),
			],
		});
		expect(isCaseListConfigValid(ok, CASE_TYPES, "patient")).toBe(true);
	});

	it("rejects a kind-vs-property mismatch (date column on a text property)", () => {
		const bad = config({
			columns: [dateColumn(asUuid("c1"), "name", "Name", "%d/%m/%Y")],
		});
		expect(isCaseListConfigValid(bad, CASE_TYPES, "patient")).toBe(false);
	});

	it("rejects a calculated column whose expression fails its type check", () => {
		const bad = config({
			columns: [
				// References a property that doesn't exist on the case type.
				calculatedColumn(
					asUuid("c1"),
					"Calc",
					term(prop("patient", "missing_prop")),
				),
			],
		});
		expect(isCaseListConfigValid(bad, CASE_TYPES, "patient")).toBe(false);
	});

	it("rejects a filter that references an unknown property", () => {
		const bad = config({
			filter: {
				kind: "eq",
				left: term(prop("patient", "missing_prop")),
				right: term(literal("x")),
			},
		});
		expect(isCaseListConfigValid(bad, CASE_TYPES, "patient")).toBe(false);
	});

	it("rejects structural search-input errors (empty label, duplicate names)", () => {
		const emptyLabel = config({
			searchInputs: [
				simpleSearchInputDef(asUuid("s1"), "a", "", "text", "name"),
			],
		});
		expect(isCaseListConfigValid(emptyLabel, CASE_TYPES, "patient")).toBe(
			false,
		);

		const duplicateNames = config({
			searchInputs: [
				simpleSearchInputDef(asUuid("s1"), "a", "First", "text", "name"),
				simpleSearchInputDef(asUuid("s2"), "a", "Second", "text", "name"),
			],
		});
		expect(isCaseListConfigValid(duplicateNames, CASE_TYPES, "patient")).toBe(
			false,
		);
	});

	it("accepts an advanced input whose condition references its own input", () => {
		// The custom-condition seed self-references the row's own input
		// via the when-input-present envelope. The edited row must be in
		// scope for that to resolve — otherwise the gate pauses the
		// preview on a condition the commit gate and wire emitter accept.
		const ok = config({
			searchInputs: [
				advancedSearchInputDef(
					asUuid("s1"),
					"name",
					"Name",
					"text",
					whenInput(input("name"), eq(prop("patient", "name"), input("name"))),
				),
			],
		});
		expect(isCaseListConfigValid(ok, CASE_TYPES, "patient")).toBe(true);
	});

	it("accepts a match-all filter (the empty-filter seed)", () => {
		expect(
			isCaseListConfigValid(
				config({ filter: matchAll() }),
				CASE_TYPES,
				"patient",
			),
		).toBe(true);
	});
});
