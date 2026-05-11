/**
 * Tests for `searchInputViaModeCompatibility`. CCHQ's wire layer
 * binds exactly one user-typed value per `<prompt>` element, so the
 * simple-arm `(property, mode, via)` derivation only produces a
 * faithful wire shape when the mode reads a single bound value.
 * The rule rejects `range` and `multi-select-contains` modes for
 * simple-arm inputs whose `via` walks a relation.
 */

import { describe, expect, it } from "vitest";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import {
	advancedSearchInputDef,
	asUuid,
	plainColumn,
	simpleSearchInputDef,
} from "@/lib/domain";
import {
	ancestorPath,
	eq,
	literal,
	prop,
	relationStep,
	subcasePath,
} from "@/lib/domain/predicate";
import { runValidation } from "../../../runner";

const CODE = "CASE_LIST_SIMPLE_INPUT_VIA_INCOMPATIBLE_MODE" as const;

const caseTypes = [
	{
		name: "patient",
		parent_type: "household",
		properties: [
			{ name: "case_name", label: "Name", data_type: "text" as const },
			{ name: "tags", label: "Tags", data_type: "multi_select" as const },
		],
	},
	{
		name: "household",
		properties: [
			{ name: "case_name", label: "Name", data_type: "text" as const },
			{ name: "region", label: "Region", data_type: "text" as const },
			{
				name: "visit_date",
				label: "Visit",
				data_type: "date" as const,
			},
		],
	},
	{
		name: "child",
		parent_type: "patient",
		properties: [
			{ name: "tags", label: "Tags", data_type: "multi_select" as const },
		],
	},
];

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

describe("searchInputViaModeCompatibility", () => {
	it("fires for `multi-select-contains` mode on a non-self via", () => {
		const doc = buildDoc({
			appName: "T",
			modules: [
				{
					name: "Mod",
					caseType: "patient",
					caseListConfig: {
						columns: [plainColumn(asUuid("c-1"), "case_name", "Name")],
						searchInputs: [
							simpleSearchInputDef(
								asUuid("si-1"),
								"child_tags",
								"Child tags",
								"select",
								"tags",
								{
									via: subcasePath("child"),
									mode: { kind: "multi-select-contains", quantifier: "any" },
								},
							),
						],
					},
					forms: [standardForm],
				},
			],
			caseTypes,
		});
		const hits = runValidation(doc).filter((e) => e.code === CODE);
		expect(hits).toHaveLength(1);
		expect(hits[0].message).toContain("child_tags");
		expect(hits[0].message).toContain("multi-select-contains");
		expect(hits[0].message).toContain("child case");
	});

	it("fires for `range` mode on a non-self via (date-range default)", () => {
		const doc = buildDoc({
			appName: "T",
			modules: [
				{
					name: "Mod",
					caseType: "patient",
					caseListConfig: {
						columns: [plainColumn(asUuid("c-1"), "case_name", "Name")],
						searchInputs: [
							simpleSearchInputDef(
								asUuid("si-2"),
								"visit_window",
								"Visit window",
								"date-range",
								"visit_date",
								{
									via: ancestorPath(relationStep("parent")),
								},
							),
						],
					},
					forms: [standardForm],
				},
			],
			caseTypes,
		});
		const hits = runValidation(doc).filter((e) => e.code === CODE);
		expect(hits).toHaveLength(1);
		expect(hits[0].message).toContain("range");
		expect(hits[0].message).toContain("ancestor");
	});

	it("admits `exact` / `fuzzy` / `starts-with` / `phonetic` / `fuzzy-date` modes on a non-self via", () => {
		const doc = buildDoc({
			appName: "T",
			modules: [
				{
					name: "Mod",
					caseType: "patient",
					caseListConfig: {
						columns: [plainColumn(asUuid("c-1"), "case_name", "Name")],
						searchInputs: [
							simpleSearchInputDef(
								asUuid("si-exact"),
								"parent_name",
								"Parent name",
								"text",
								"case_name",
								{ via: ancestorPath(relationStep("parent")) },
							),
							simpleSearchInputDef(
								asUuid("si-fuzzy"),
								"parent_name_fuzzy",
								"Parent fuzzy",
								"text",
								"case_name",
								{
									via: ancestorPath(relationStep("parent")),
									mode: { kind: "fuzzy" },
								},
							),
							simpleSearchInputDef(
								asUuid("si-starts"),
								"parent_name_starts",
								"Parent starts",
								"text",
								"case_name",
								{
									via: ancestorPath(relationStep("parent")),
									mode: { kind: "starts-with" },
								},
							),
							simpleSearchInputDef(
								asUuid("si-phon"),
								"parent_name_phon",
								"Parent phonetic",
								"text",
								"case_name",
								{
									via: ancestorPath(relationStep("parent")),
									mode: { kind: "phonetic" },
								},
							),
							simpleSearchInputDef(
								asUuid("si-fdate"),
								"parent_visit",
								"Parent visit",
								"date",
								"visit_date",
								{
									via: ancestorPath(relationStep("parent")),
									mode: { kind: "fuzzy-date" },
								},
							),
						],
					},
					forms: [standardForm],
				},
			],
			caseTypes,
		});
		expect(runValidation(doc).some((e) => e.code === CODE)).toBe(false);
	});

	it("admits `range` and `multi-select-contains` on self-walk inputs (no via)", () => {
		const doc = buildDoc({
			appName: "T",
			modules: [
				{
					name: "Mod",
					caseType: "patient",
					caseListConfig: {
						columns: [plainColumn(asUuid("c-1"), "case_name", "Name")],
						searchInputs: [
							simpleSearchInputDef(
								asUuid("si-r"),
								"window",
								"Window",
								"date-range",
								"visit_date",
							),
							simpleSearchInputDef(
								asUuid("si-m"),
								"tag_pick",
								"Tags",
								"select",
								"tags",
								{
									mode: { kind: "multi-select-contains", quantifier: "any" },
								},
							),
						],
					},
					forms: [standardForm],
				},
			],
			caseTypes,
		});
		expect(runValidation(doc).some((e) => e.code === CODE)).toBe(false);
	});

	it("ignores advanced-arm inputs (they author the predicate by hand)", () => {
		const doc = buildDoc({
			appName: "T",
			modules: [
				{
					name: "Mod",
					caseType: "patient",
					caseListConfig: {
						columns: [plainColumn(asUuid("c-1"), "case_name", "Name")],
						searchInputs: [
							advancedSearchInputDef(
								asUuid("si-adv"),
								"adv",
								"Adv",
								"text",
								eq(prop("patient", "case_name"), literal("X")),
							),
						],
					},
					forms: [standardForm],
				},
			],
			caseTypes,
		});
		expect(runValidation(doc).some((e) => e.code === CODE)).toBe(false);
	});
});
