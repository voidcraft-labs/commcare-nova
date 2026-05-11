/**
 * Tests for `searchInputRefUsesWhenInputPresent`. The rule walks the
 * wire-emission-bound predicate slots (the always-on filter + every
 * advanced-arm search input's authored predicate) and rejects bare
 * `input(...)` Term refs that aren't inside an enclosing
 * `when-input-present` envelope.
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
	and,
	eq,
	input,
	literal,
	prop,
	whenInput,
} from "@/lib/domain/predicate";
import { runValidation } from "../../../runner";

const CODE = "CASE_LIST_BARE_SEARCH_INPUT_REF" as const;

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

describe("searchInputRefUsesWhenInputPresent", () => {
	it("fires when caseListConfig.filter has a bare input ref", () => {
		const doc = buildDoc({
			appName: "T",
			modules: [
				{
					name: "Mod",
					caseType: "patient",
					caseListConfig: {
						columns: [plainColumn(asUuid("col-1"), "case_name", "Name")],
						filter: eq(prop("patient", "case_name"), input("name_q")),
						searchInputs: [
							simpleSearchInputDef(
								asUuid("si-1"),
								"name_q",
								"Name",
								"text",
								"case_name",
							),
						],
					},
					forms: [standardForm],
				},
			],
			caseTypes: standardCaseTypes,
		});
		const hits = runValidation(doc).filter((e) => e.code === CODE);
		expect(hits).toHaveLength(1);
		// Slot identifier + input name surface in the message; the gating
		// advice names the where-to-look UX slot.
		expect(hits[0].message).toContain("caseListConfig.filter");
		expect(hits[0].message).toContain('input("name_q")');
		expect(hits[0].message).toContain("when-input-present");
	});

	it("is silent when the same ref is wrapped in whenInput against the right name", () => {
		const doc = buildDoc({
			appName: "T",
			modules: [
				{
					name: "Mod",
					caseType: "patient",
					caseListConfig: {
						columns: [plainColumn(asUuid("col-1"), "case_name", "Name")],
						filter: whenInput(
							input("name_q"),
							eq(prop("patient", "case_name"), input("name_q")),
						),
						searchInputs: [
							simpleSearchInputDef(
								asUuid("si-1"),
								"name_q",
								"Name",
								"text",
								"case_name",
							),
						],
					},
					forms: [standardForm],
				},
			],
			caseTypes: standardCaseTypes,
		});
		const hits = runValidation(doc).filter((e) => e.code === CODE);
		expect(hits).toHaveLength(0);
	});

	it("fires when whenInput gates input X but the body references input Y", () => {
		// The envelope only gates the named trigger — a different input
		// ref inside the clause is structurally just as bare as if no
		// envelope existed at all.
		const doc = buildDoc({
			appName: "T",
			modules: [
				{
					name: "Mod",
					caseType: "patient",
					caseListConfig: {
						columns: [plainColumn(asUuid("col-1"), "case_name", "Name")],
						filter: whenInput(
							input("name_q"),
							eq(prop("patient", "case_name"), input("other_q")),
						),
						searchInputs: [
							simpleSearchInputDef(
								asUuid("si-1"),
								"name_q",
								"Name",
								"text",
								"case_name",
							),
							simpleSearchInputDef(
								asUuid("si-2"),
								"other_q",
								"Other",
								"text",
								"case_name",
							),
						],
					},
					forms: [standardForm],
				},
			],
			caseTypes: standardCaseTypes,
		});
		const hits = runValidation(doc).filter((e) => e.code === CODE);
		expect(hits).toHaveLength(1);
		expect(hits[0].message).toContain('input("other_q")');
	});

	it("does not flag the whenInput trigger ref itself", () => {
		// The trigger ref (`whenInput(input("X"), ...)`'s first arg) IS a
		// SearchInputRef but it's the gate, not a bare consumer. The rule
		// must skip it explicitly so we don't report the gate as if it
		// were a bare ref.
		const doc = buildDoc({
			appName: "T",
			modules: [
				{
					name: "Mod",
					caseType: "patient",
					caseListConfig: {
						columns: [plainColumn(asUuid("col-1"), "case_name", "Name")],
						filter: whenInput(
							input("name_q"),
							// Body has NO input refs — just a property equality.
							eq(prop("patient", "case_name"), literal("Alice")),
						),
						searchInputs: [
							simpleSearchInputDef(
								asUuid("si-1"),
								"name_q",
								"Name",
								"text",
								"case_name",
							),
						],
					},
					forms: [standardForm],
				},
			],
			caseTypes: standardCaseTypes,
		});
		const hits = runValidation(doc).filter((e) => e.code === CODE);
		expect(hits).toHaveLength(0);
	});

	it("fires inside advanced-arm search input predicate when ref is bare", () => {
		const doc = buildDoc({
			appName: "T",
			modules: [
				{
					name: "Mod",
					caseType: "patient",
					caseListConfig: {
						columns: [plainColumn(asUuid("col-1"), "case_name", "Name")],
						searchInputs: [
							advancedSearchInputDef(
								asUuid("si-adv"),
								"adv",
								"Advanced",
								"text",
								eq(prop("patient", "case_name"), input("adv")),
							),
						],
					},
					forms: [standardForm],
				},
			],
			caseTypes: standardCaseTypes,
		});
		const hits = runValidation(doc).filter((e) => e.code === CODE);
		expect(hits).toHaveLength(1);
		expect(hits[0].message).toContain('input("adv")');
		expect(hits[0].message).toContain("searchInputs[0].predicate");
	});

	it("is silent when an advanced-arm predicate has zero input refs", () => {
		const doc = buildDoc({
			appName: "T",
			modules: [
				{
					name: "Mod",
					caseType: "patient",
					caseListConfig: {
						columns: [plainColumn(asUuid("col-1"), "case_name", "Name")],
						searchInputs: [
							advancedSearchInputDef(
								asUuid("si-adv"),
								"adv",
								"Advanced",
								"text",
								eq(prop("patient", "case_name"), literal("Alice")),
							),
						],
					},
					forms: [standardForm],
				},
			],
			caseTypes: standardCaseTypes,
		});
		const hits = runValidation(doc).filter((e) => e.code === CODE);
		expect(hits).toHaveLength(0);
	});

	it("reports two refs in one AND-chained filter as two separate errors", () => {
		const doc = buildDoc({
			appName: "T",
			modules: [
				{
					name: "Mod",
					caseType: "patient",
					caseListConfig: {
						columns: [plainColumn(asUuid("col-1"), "case_name", "Name")],
						filter: and(
							eq(prop("patient", "case_name"), input("first_q")),
							eq(prop("patient", "case_name"), input("second_q")),
						),
						searchInputs: [
							simpleSearchInputDef(
								asUuid("si-1"),
								"first_q",
								"First",
								"text",
								"case_name",
							),
							simpleSearchInputDef(
								asUuid("si-2"),
								"second_q",
								"Second",
								"text",
								"case_name",
							),
						],
					},
					forms: [standardForm],
				},
			],
			caseTypes: standardCaseTypes,
		});
		const hits = runValidation(doc).filter((e) => e.code === CODE);
		expect(hits).toHaveLength(2);
	});
});
