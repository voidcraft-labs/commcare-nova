import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
/**
 * Tests for `searchInputRefUsesWhenInputPresent`. The rule walks the
 * wire-emission-bound predicate slots (the always-on filter + every
 * advanced-arm search input's authored predicate) and rejects bare
 * Search-input Term refs that aren't inside an enclosing
 * `when-input-present` envelope. The assigned-case exclusion is a deliberate
 * exception: blank means "exclude nobody" on every runtime, so it may return a
 * Search answer directly.
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
const NAME_QUERY_UUID = asUuid("ee4359e3-6f86-4621-8eec-a613e04ec176");
const OTHER_QUERY_UUID = asUuid("d25765c9-91fb-464c-809a-811ce1213f5f");
const ADVANCED_QUERY_UUID = asUuid("d91a0d70-678f-494a-861b-e0bc97f0dd69");
const PRIMARY_QUERY_UUID = asUuid("e281b620-abd7-4f88-8d24-57d2ee482519");
const FIRST_QUERY_UUID = asUuid("d885cb9d-4f2f-439b-877c-6cad8f7fbf32");
const SECOND_QUERY_UUID = asUuid("e67a3800-e51f-4e73-88b0-ad8e4ea8bc3d");
const ROW_QUERY_UUID = asUuid("d794ebfb-9f47-450f-8af3-964849456a34");
const OWNER_QUERY_UUID = asUuid("0bf77e0c-3111-44dd-836c-270835612450");

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
						listColumnOrder: [asUuid("col-1")],
						detailColumnOrder: [asUuid("col-1")],
						filter: eq(prop("patient", "case_name"), input(NAME_QUERY_UUID)),
						searchInputs: [
							simpleSearchInputDef(
								NAME_QUERY_UUID,
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
		const hits = runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE).filter(
			(e) => e.code === CODE,
		);
		expect(hits).toHaveLength(1);
		// Slot identifier + input name surface in the message; the gating
		// advice names the where-to-look UX slot.
		expect(hits[0].message).toContain("caseListConfig.filter");
		expect(hits[0].message).toContain('"name_q"');
		expect(hits[0].message).toContain("when-input-present");
	});

	it("is silent when the same ref is wrapped in whenInput against the same UUID", () => {
		const doc = buildDoc({
			appName: "T",
			modules: [
				{
					name: "Mod",
					caseType: "patient",
					caseListConfig: {
						columns: [plainColumn(asUuid("col-1"), "case_name", "Name")],
						listColumnOrder: [asUuid("col-1")],
						detailColumnOrder: [asUuid("col-1")],
						filter: whenInput(
							input(NAME_QUERY_UUID),
							eq(prop("patient", "case_name"), input(NAME_QUERY_UUID)),
						),
						searchInputs: [
							simpleSearchInputDef(
								NAME_QUERY_UUID,
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
		const hits = runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE).filter(
			(e) => e.code === CODE,
		);
		expect(hits).toHaveLength(0);
	});

	it("fires when whenInput gates input X but the body references input Y", () => {
		// The envelope only gates the referenced identity — a different input
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
						listColumnOrder: [asUuid("col-1")],
						detailColumnOrder: [asUuid("col-1")],
						filter: whenInput(
							input(NAME_QUERY_UUID),
							eq(prop("patient", "case_name"), input(OTHER_QUERY_UUID)),
						),
						searchInputs: [
							simpleSearchInputDef(
								NAME_QUERY_UUID,
								"name_q",
								"Name",
								"text",
								"case_name",
							),
							simpleSearchInputDef(
								OTHER_QUERY_UUID,
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
		const hits = runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE).filter(
			(e) => e.code === CODE,
		);
		expect(hits).toHaveLength(1);
		expect(hits[0].message).toContain('"other_q"');
	});

	it("does not flag the whenInput trigger ref itself", () => {
		// The trigger ref (`whenInput(inputUuid, ...)`'s first arg) IS a
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
						listColumnOrder: [asUuid("col-1")],
						detailColumnOrder: [asUuid("col-1")],
						filter: whenInput(
							input(NAME_QUERY_UUID),
							// Body has NO input refs — just a property equality.
							eq(prop("patient", "case_name"), literal("Alice")),
						),
						searchInputs: [
							simpleSearchInputDef(
								NAME_QUERY_UUID,
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
		const hits = runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE).filter(
			(e) => e.code === CODE,
		);
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
						listColumnOrder: [asUuid("col-1")],
						detailColumnOrder: [asUuid("col-1")],
						searchInputs: [
							advancedSearchInputDef(
								ADVANCED_QUERY_UUID,
								"adv",
								"Advanced",
								"text",
								eq(prop("patient", "case_name"), input(ADVANCED_QUERY_UUID)),
							),
						],
					},
					forms: [standardForm],
				},
			],
			caseTypes: standardCaseTypes,
		});
		const hits = runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE).filter(
			(e) => e.code === CODE,
		);
		expect(hits).toHaveLength(1);
		expect(hits[0].message).toContain('"adv"');
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
						listColumnOrder: [asUuid("col-1")],
						detailColumnOrder: [asUuid("col-1")],
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
		const hits = runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE).filter(
			(e) => e.code === CODE,
		);
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
						listColumnOrder: [asUuid("col-1")],
						detailColumnOrder: [asUuid("col-1")],
						filter: and(
							eq(prop("patient", "case_name"), input(FIRST_QUERY_UUID)),
							eq(prop("patient", "case_name"), input(SECOND_QUERY_UUID)),
						),
						searchInputs: [
							simpleSearchInputDef(
								FIRST_QUERY_UUID,
								"first_q",
								"First",
								"text",
								"case_name",
							),
							simpleSearchInputDef(
								SECOND_QUERY_UUID,
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
		const hits = runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE).filter(
			(e) => e.code === CODE,
		);
		expect(hits).toHaveLength(2);
	});

	// ── No-input-context slots — forbid input refs outright ──────────

	it("fires when a search input's default value expression references another input", () => {
		// Default values fire at search-screen-open time, before any
		// input is bound. The reference resolves to empty string
		// regardless of envelope; flag every occurrence.
		const doc = buildDoc({
			appName: "T",
			modules: [
				{
					name: "Mod",
					caseType: "patient",
					caseListConfig: {
						columns: [plainColumn(asUuid("c-1"), "case_name", "Name")],
						listColumnOrder: [asUuid("c-1")],
						detailColumnOrder: [asUuid("c-1")],
						searchInputs: [
							{
								...simpleSearchInputDef(
									PRIMARY_QUERY_UUID,
									"primary_q",
									"Primary",
									"text",
									"case_name",
								),
								default: { kind: "term", term: input(PRIMARY_QUERY_UUID) },
							},
						],
					},
					forms: [standardForm],
				},
			],
			caseTypes: standardCaseTypes,
		});
		const hits = runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE).filter(
			(e) => e.code === CODE,
		);
		expect(hits).toHaveLength(1);
		expect(hits[0].message).toContain("default");
		expect(hits[0].message).toContain("can never see a typed search value");
	});

	it("fires when a calculated column expression references an input", () => {
		const doc = buildDoc({
			appName: "T",
			modules: [
				{
					name: "Mod",
					caseType: "patient",
					caseListConfig: {
						columns: [
							plainColumn(asUuid("c-1"), "case_name", "Name"),
							{
								kind: "calculated",
								uuid: asUuid("c-2"),
								header: "Echo",
								expression: { kind: "term", term: input(ROW_QUERY_UUID) },
							},
						],
						listColumnOrder: [asUuid("c-1")],
						detailColumnOrder: [asUuid("c-1")],
						searchInputs: [
							simpleSearchInputDef(
								ROW_QUERY_UUID,
								"query",
								"Query",
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
		const hits = runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE).filter(
			(e) => e.code === CODE,
		);
		expect(hits).toHaveLength(1);
		expect(hits[0].message).toContain("calculated column");
	});

	it("fires when the search-button display condition references an input (even wrapped)", () => {
		// `forbids-input-ref` mode flags the trigger ref too — the
		// envelope doesn't rescue a no-input-context slot.
		const doc = buildDoc({
			appName: "T",
			modules: [
				{
					name: "Mod",
					caseType: "patient",
					caseListConfig: {
						columns: [plainColumn(asUuid("c-1"), "case_name", "Name")],
						listColumnOrder: [asUuid("c-1")],
						detailColumnOrder: [asUuid("c-1")],
						searchInputs: [
							simpleSearchInputDef(
								ROW_QUERY_UUID,
								"query",
								"Query",
								"text",
								"case_name",
							),
						],
					},
					caseSearchConfig: {
						searchButtonDisplayCondition: whenInput(
							input(ROW_QUERY_UUID),
							eq(prop("patient", "case_name"), literal("Alice")),
						),
					},
					forms: [standardForm],
				},
			],
			caseTypes: standardCaseTypes,
		});
		const hits = runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE).filter(
			(e) => e.code === CODE,
		);
		expect(hits.length).toBeGreaterThanOrEqual(1);
		expect(hits[0].message).toContain("search-button display condition");
	});

	// ── excludedOwnerIds — blank is the safe identity ──

	it("allows excludedOwnerIds to return a Search answer directly", () => {
		const doc = buildDoc({
			appName: "T",
			modules: [
				{
					name: "Mod",
					caseType: "patient",
					caseListConfig: {
						columns: [plainColumn(asUuid("c-1"), "case_name", "Name")],
						listColumnOrder: [asUuid("c-1")],
						detailColumnOrder: [asUuid("c-1")],
						searchInputs: [
							simpleSearchInputDef(
								OWNER_QUERY_UUID,
								"owner_q",
								"Owner",
								"text",
								"case_name",
							),
						],
					},
					caseSearchConfig: {
						excludedOwnerIds: { kind: "term", term: input(OWNER_QUERY_UUID) },
					},
					forms: [standardForm],
				},
			],
			caseTypes: standardCaseTypes,
		});
		const hits = runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE).filter(
			(e) => e.code === CODE,
		);
		expect(hits).toHaveLength(0);
	});
});
