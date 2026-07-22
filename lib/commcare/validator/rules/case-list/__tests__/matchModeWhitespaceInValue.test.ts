import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
/**
 * Tests for `matchModeWhitespaceInValue`. CCHQ's CSQL evaluator
 * OR-tokenizes whitespace-bearing values for `fuzzy` and `phonetic`
 * matches; the rule rejects authored multi-word values for those
 * two modes only.
 */

import { describe, expect, it } from "vitest";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { asUuid, plainColumn } from "@/lib/domain";
import {
	literal,
	match,
	multiSelectAll,
	multiSelectAny,
	prop,
} from "@/lib/domain/predicate";
import { runValidation } from "../../../runner";

const CODE = "CASE_LIST_MATCH_MODE_TOKENIZES_WHITESPACE" as const;

const standardForm = {
	name: "Reg",
	type: "registration" as const,
	fields: [
		f({
			kind: "text" as const,
			id: "case_name",
			label: "Name",
			case_property_on: "patient",
		}),
	],
};

const standardCaseTypes = [
	{
		name: "patient",
		properties: [
			{ name: "case_name", label: "Name", data_type: "text" as const },
		],
	},
];

describe("matchModeWhitespaceInValue", () => {
	it("fires for fuzzy match against a multi-word literal", () => {
		const doc = buildDoc({
			appName: "T",
			modules: [
				{
					name: "Mod",
					caseType: "patient",
					caseListConfig: {
						columns: [plainColumn(asUuid("c-1"), "case_name", "Name")],
						filter: match(prop("patient", "case_name"), "Alice Smith", "fuzzy"),
						searchInputs: [],
					},
					forms: [standardForm],
				},
			],
			caseTypes: standardCaseTypes,
		});
		const hits = runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE).filter((e) => e.code === CODE);
		expect(hits).toHaveLength(1);
		expect(hits[0].message).toContain('"Alice Smith"');
		expect(hits[0].message).toContain("fuzzy");
		expect(hits[0].message).toContain("OR");
	});

	it("fires for phonetic match against a multi-word literal", () => {
		const doc = buildDoc({
			appName: "T",
			modules: [
				{
					name: "Mod",
					caseType: "patient",
					caseListConfig: {
						columns: [plainColumn(asUuid("c-1"), "case_name", "Name")],
						filter: match(
							prop("patient", "case_name"),
							"John  Doe",
							"phonetic",
						),
						searchInputs: [],
					},
					forms: [standardForm],
				},
			],
			caseTypes: standardCaseTypes,
		});
		const hits = runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE).filter((e) => e.code === CODE);
		expect(hits).toHaveLength(1);
		expect(hits[0].message).toContain("phonetic");
	});

	it("is silent for fuzzy match against a single-word literal", () => {
		const doc = buildDoc({
			appName: "T",
			modules: [
				{
					name: "Mod",
					caseType: "patient",
					caseListConfig: {
						columns: [plainColumn(asUuid("c-1"), "case_name", "Name")],
						filter: match(prop("patient", "case_name"), "Alice", "fuzzy"),
						searchInputs: [],
					},
					forms: [standardForm],
				},
			],
			caseTypes: standardCaseTypes,
		});
		const hits = runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE).filter((e) => e.code === CODE);
		expect(hits).toHaveLength(0);
	});

	it("is silent for starts-with against multi-word literal (CCHQ prefix-matches the whole string)", () => {
		const doc = buildDoc({
			appName: "T",
			modules: [
				{
					name: "Mod",
					caseType: "patient",
					caseListConfig: {
						columns: [plainColumn(asUuid("c-1"), "case_name", "Name")],
						filter: match(
							prop("patient", "case_name"),
							"Alice Smith",
							"starts-with",
						),
						searchInputs: [],
					},
					forms: [standardForm],
				},
			],
			caseTypes: standardCaseTypes,
		});
		const hits = runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE).filter((e) => e.code === CODE);
		expect(hits).toHaveLength(0);
	});

	// ── multi-select-contains coverage ──────────────────────────────
	//
	// CCHQ's `selected` and `selected-any` are the SAME runtime
	// function (verified at
	// `commcare-hq/.../case_search/xpath_functions/__init__.py`:
	// `'selected': selected_any`). Both tokenize their value argument
	// through ES's `match` query. A `multi-select-contains` value
	// like "Alice Smith" silently OR-tokenizes downstream.

	it("fires for multi-select-contains any with a multi-word value", () => {
		const doc = buildDoc({
			appName: "T",
			modules: [
				{
					name: "Mod",
					caseType: "patient",
					caseListConfig: {
						columns: [plainColumn(asUuid("c-1"), "case_name", "Name")],
						filter: multiSelectAny(
							prop("patient", "case_name"),
							literal("Alice Smith"),
							literal("Bob"),
						),
						searchInputs: [],
					},
					forms: [standardForm],
				},
			],
			caseTypes: standardCaseTypes,
		});
		const hits = runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE).filter((e) => e.code === CODE);
		expect(hits).toHaveLength(1);
		expect(hits[0].message).toContain('"Alice Smith"');
		expect(hits[0].message).toContain("multi-select-contains");
	});

	it("fires for multi-select-contains all with a multi-word value", () => {
		const doc = buildDoc({
			appName: "T",
			modules: [
				{
					name: "Mod",
					caseType: "patient",
					caseListConfig: {
						columns: [plainColumn(asUuid("c-1"), "case_name", "Name")],
						filter: multiSelectAll(
							prop("patient", "case_name"),
							literal("Big Apple"),
						),
						searchInputs: [],
					},
					forms: [standardForm],
				},
			],
			caseTypes: standardCaseTypes,
		});
		const hits = runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE).filter((e) => e.code === CODE);
		expect(hits).toHaveLength(1);
	});

	it("is silent for multi-select-contains with single-token values", () => {
		const doc = buildDoc({
			appName: "T",
			modules: [
				{
					name: "Mod",
					caseType: "patient",
					caseListConfig: {
						columns: [plainColumn(asUuid("c-1"), "case_name", "Name")],
						filter: multiSelectAny(
							prop("patient", "case_name"),
							literal("Alice"),
							literal("Bob"),
						),
						searchInputs: [],
					},
					forms: [standardForm],
				},
			],
			caseTypes: standardCaseTypes,
		});
		const hits = runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE).filter((e) => e.code === CODE);
		expect(hits).toHaveLength(0);
	});
});
