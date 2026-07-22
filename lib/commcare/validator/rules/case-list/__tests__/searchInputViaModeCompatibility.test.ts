import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
/**
 * Tests for `searchInputViaModeCompatibility`. The rule rejects
 * simple-arm `(mode, via, name vs property)` combinations no CCHQ
 * wire shape carries faithfully:
 *
 *   - `multi-select-contains` on every simple-arm input (CCHQ's
 *     prompt slot defaults to full-string exact match, so token
 *     containment silently mismatches regardless of via).
 *   - `range` on simple-arm inputs whose `via` is non-self (CCHQ's
 *     daterange widget binds one encoded start/end pair, but a prompt carries
 *     no relation-walk metadata;
 *     the two-bound semantic can only ride on the self-walk shape).
 *   - `range` on simple-arm inputs whose `name !== property` (CCHQ
 *     auto-matches the typed range against the case property named
 *     by the prompt key, and the simple-arm `_xpath_query` route
 *     has no range arm to fall back to).
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
			{ name: "visit_date", label: "Visit", data_type: "date" as const },
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
	it("rejects range mode paired with a one-date widget", () => {
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
								asUuid("si-date-range-mode"),
								"visit_date",
								"Visit date",
								"date",
								"visit_date",
								{ mode: { kind: "range" } },
							),
						],
					},
					forms: [standardForm],
				},
			],
			caseTypes,
		});

		const hits = runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE).filter((error) => error.code === CODE);
		expect(hits).toHaveLength(1);
		expect(hits[0].details).toMatchObject({
			inputType: "date",
			modeKind: "range",
			reason: "range-needs-date-range-widget",
		});
	});

	it("rejects a date-range widget paired with a one-value mode", () => {
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
								asUuid("si-range-exact-mode"),
								"visit_date",
								"Visit date",
								"date-range",
								"visit_date",
								{ mode: { kind: "exact" } },
							),
						],
					},
					forms: [standardForm],
				},
			],
			caseTypes,
		});

		const hits = runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE).filter((error) => error.code === CODE);
		expect(hits).toHaveLength(1);
		expect(hits[0].details).toMatchObject({
			inputType: "date-range",
			modeKind: "exact",
			reason: "date-range-needs-range-mode",
		});
	});

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
		const hits = runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE).filter((e) => e.code === CODE);
		expect(hits).toHaveLength(1);
		expect(hits[0].message).toContain("child_tags");
		expect(hits[0].message).toContain("multi-select-contains");
		// Error directs to the advanced-arm `selected(...)` shape.
		expect(hits[0].message).toContain("selected(");
	});

	it("fires for `multi-select-contains` mode on a self-walk input", () => {
		// Self-walk `multi-select-contains` mismatches at CCHQ's
		// runtime: the prompt slot binds a single literal string and
		// the default `case_property_query` does full-string exact
		// match — "green" never matches a property storing
		// "red green blue".
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
								asUuid("si-self-multi"),
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
		const hits = runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE).filter((e) => e.code === CODE);
		expect(hits).toHaveLength(1);
		expect(hits[0].message).toContain("tag_pick");
		expect(hits[0].message).toContain("multi-select-contains");
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
		const hits = runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE).filter((e) => e.code === CODE);
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
		expect(runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE).some((e) => e.code === CODE)).toBe(false);
	});

	it("admits `range` on a self-walk input with `name === property` (the only bare-prompt-compatible range shape)", () => {
		// The daterange widget handles the two-value semantic for the
		// current case directly; the prompt slot covers it without
		// needing `_xpath_query` routing. Both halves of CCHQ's
		// auto-match contract have to hold here: self-walk so the
		// daterange's two bindings stay on the current case, AND
		// `name === property` so the prompt key auto-matches the
		// authored target.
		const doc = buildDoc({
			appName: "T",
			modules: [
				{
					name: "Mod",
					caseType: "household",
					caseListConfig: {
						columns: [plainColumn(asUuid("c-1"), "case_name", "Name")],
						searchInputs: [
							simpleSearchInputDef(
								asUuid("si-r"),
								"visit_date",
								"Visit",
								"date-range",
								"visit_date",
							),
						],
					},
					forms: [
						{
							name: "Reg",
							type: "registration" as const,
							fields: [
								f({
									kind: "text" as const,
									id: "case_name",
									label: "Name",
									case_property_on: "household",
								}),
							],
						},
					],
				},
			],
			caseTypes,
		});
		expect(runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE).some((e) => e.code === CODE)).toBe(false);
	});

	it("admits a legacy date-opened target when its prompt name is canonical", () => {
		const doc = buildDoc({
			appName: "T",
			modules: [
				{
					name: "Mod",
					caseType: "household",
					caseListOnly: true,
					caseListConfig: {
						columns: [plainColumn(asUuid("c-legacy"), "case_name", "Name")],
						searchInputs: [
							simpleSearchInputDef(
								asUuid("si-legacy-range"),
								"date_opened",
								"Date opened",
								"date-range",
								"date-opened",
							),
						],
					},
				},
			],
			caseTypes,
		});

		expect(runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE).some((e) => e.code === CODE)).toBe(false);
	});

	it("fires for `range` mode on self-walk when `name !== property`", () => {
		// The bogus-auto-match case for `range`: bare prompt key
		// `window` is what CCHQ's runtime queries as the case property,
		// missing the authored target `visit_date`. The
		// `_xpath_query` route has no range arm; the only remediation
		// is to align name with property, switch to a single-value
		// mode, or move to the advanced arm.
		const doc = buildDoc({
			appName: "T",
			modules: [
				{
					name: "Mod",
					caseType: "household",
					caseListConfig: {
						columns: [plainColumn(asUuid("c-1"), "case_name", "Name")],
						searchInputs: [
							simpleSearchInputDef(
								asUuid("si-range-mismatch"),
								"window",
								"Window",
								"date-range",
								"visit_date",
							),
						],
					},
					forms: [
						{
							name: "Reg",
							type: "registration" as const,
							fields: [
								f({
									kind: "text" as const,
									id: "case_name",
									label: "Name",
									case_property_on: "household",
								}),
							],
						},
					],
				},
			],
			caseTypes,
		});
		const hits = runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE).filter((e) => e.code === CODE);
		expect(hits).toHaveLength(1);
		expect(hits[0].message).toContain("window");
		expect(hits[0].message).toContain("visit_date");
		expect(hits[0].message).toContain("range");
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
		expect(runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE).some((e) => e.code === CODE)).toBe(false);
	});
});
