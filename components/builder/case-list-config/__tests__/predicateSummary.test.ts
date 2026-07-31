// components/builder/case-list-config/__tests__/predicateSummary.test.ts
//
// Pins the human-language Cases available summary used in Results. The contract:
// worker-facing words, never AST jargon; vacuous predicates summarize
// to nothing; exotic shapes degrade to honest generic phrases.

import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import type { CaseType } from "@/lib/domain";
import {
	ancestorPath,
	and,
	between,
	eq,
	exists,
	input,
	isBlank,
	isIn,
	literal,
	matchAll,
	matchNone,
	missing,
	multiSelectAny,
	not,
	or,
	type Predicate,
	prop,
	relationStep,
	term,
	today,
	whenInput,
} from "@/lib/domain/predicate";
import { projectProseTemplate, proseText } from "@/lib/domain/prose";
import { humanizeName, summarizeFilter } from "../predicateSummary";

/** These fixtures label every choice with literal prose, so an empty document
 *  resolves everything they reference (nothing). */
const projectProse = (template: Parameters<typeof projectProseTemplate>[0]) =>
	projectProseTemplate(template, { fields: {}, forms: {}, fieldOrder: {} })
		.text;

const status = () => term(prop("patient", "status"));

const statusIsntClosed: Predicate = {
	kind: "neq",
	left: status(),
	right: term(literal("closed")),
};

describe("summarizeFilter", () => {
	it("returns undefined for an absent filter and for match-all (no narrowing)", () => {
		expect(summarizeFilter(undefined, { projectProse })).toBeUndefined();
		expect(summarizeFilter(matchAll(), { projectProse })).toBeUndefined();
	});

	it("renders comparisons as subject-verb-object sentences", () => {
		expect(summarizeFilter(statusIsntClosed, { projectProse })).toBe(
			"status isn't closed",
		);
		expect(
			summarizeFilter(
				{
					kind: "eq",
					left: status(),
					right: term(literal("active")),
				},
				{ projectProse },
			),
		).toBe("status is active");
		expect(
			summarizeFilter(
				{
					kind: "gt",
					left: term(prop("patient", "age")),
					right: term(literal(5)),
				},
				{ projectProse },
			),
		).toBe("age is more than 5");
	});

	it("spaces identifier separators so property names read as words", () => {
		expect(
			summarizeFilter(
				{
					kind: "eq",
					left: term(prop("patient", "rash_onset_date")),
					right: today(),
				},
				{ projectProse },
			),
		).toBe("rash onset date is today");
		expect(humanizeName("follow-up_date")).toBe("follow up date");
	});

	it("uses Nova's friendly labels for exact standard property references", () => {
		expect(
			summarizeFilter(
				{
					kind: "eq",
					left: term(prop("patient", "case_name")),
					right: term(literal("Alice")),
				},
				{ projectProse },
			),
		).toBe("case name is Alice");
		expect(
			summarizeFilter(
				{
					kind: "match",
					property: prop("patient", "external_id"),
					value: term(literal("ABC")),
					mode: "fuzzy",
				},
				{ projectProse },
			),
		).toBe("external ID roughly matches ABC");
		expect(
			summarizeFilter(
				{
					kind: "multi-select-contains",
					property: prop("patient", "case_name"),
					values: [literal("Alice")],
					quantifier: "any",
				},
				{ projectProse },
			),
		).toBe("case name includes any of Alice");
		expect(
			summarizeFilter(
				{
					kind: "within-distance",
					property: prop("patient", "date_opened"),
					center: term(literal("0 0")),
					distance: 5,
					unit: "kilometers",
				},
				{ projectProse },
			),
		).toBe("date opened is within 5 kilometers of 0 0");
	});

	it("does not repeat a canonical property label in parentheses", () => {
		const caseTypes: CaseType[] = [
			{
				name: "patient",
				properties: [
					{
						name: "case_name",
						label: proseText("case_name"),
						data_type: "text",
					},
				],
			},
		];
		expect(
			summarizeFilter(
				{
					kind: "eq",
					left: term(prop("patient", "case_name")),
					right: term(literal("Patient name")),
				},
				{ projectProse, caseTypes, currentCaseType: "patient" },
			),
		).toBe("Case name is Patient name");
	});

	it("uses authored property labels in the current and related-case scopes", () => {
		const caseTypes: CaseType[] = [
			{
				name: "household",
				properties: [
					{
						name: "status",
						label: proseText("Household status"),
						data_type: "text",
					},
				],
			},
			{
				name: "patient",
				parent_type: "household",
				properties: [
					{ name: "dob", label: proseText("Birth date"), data_type: "date" },
				],
			},
		];
		const context = {
			caseTypes,
			currentCaseType: "patient",
			projectProse,
		};
		expect(
			summarizeFilter(
				{
					kind: "eq",
					left: term(prop("patient", "dob")),
					right: term(literal("2026-01-01")),
				},
				context,
			),
		).toBe("Birth date is 2026-01-01");

		expect(
			summarizeFilter(
				exists(ancestorPath(relationStep("parent")), {
					kind: "eq",
					left: term(prop("household", "status")),
					right: term(literal("active")),
				}),
				context,
			),
		).toBe("A related case matches Household status is active");
	});

	it("uses authored choice labels for equality, membership, and multi-choice containment", () => {
		const caseTypes: CaseType[] = [
			{
				name: "patient",
				properties: [
					{
						name: "status",
						label: proseText("Client status"),
						data_type: "single_select",
						options: [
							{ value: "active_client", label: proseText("Active") },
							{ value: "follow_up", label: proseText("Needs follow-up") },
						],
					},
					{
						name: "services",
						label: proseText("Services"),
						data_type: "multi_select",
						options: [
							{ value: "maternal_care", label: proseText("Maternal care") },
							{ value: "nutrition", label: proseText("Nutrition") },
						],
					},
				],
			},
		];
		const context = { caseTypes, currentCaseType: "patient", projectProse };

		expect(
			summarizeFilter(
				eq(prop("patient", "status"), literal("active_client")),
				context,
			),
		).toBe("Client status is Active");
		expect(
			summarizeFilter(
				isIn(
					term(prop("patient", "status")),
					literal("active_client"),
					literal("follow_up"),
				),
				context,
			),
		).toBe("Client status is one of Active, Needs follow-up");
		expect(
			summarizeFilter(
				multiSelectAny(
					prop("patient", "services"),
					literal("maternal_care"),
					literal("nutrition"),
				),
				context,
			),
		).toBe("Services includes any of Maternal care, Nutrition");
	});

	it("only reveals stored choice values when authored labels collide", () => {
		const context = {
			caseTypes: [
				{
					name: "patient",
					properties: [
						{
							name: "status",
							label: proseText("Client status"),
							data_type: "single_select" as const,
							options: [
								{ value: "open_a", label: proseText("Open") },
								{ value: "open_b", label: proseText("Open") },
								{ value: "closed", label: proseText("Closed") },
							],
						},
					],
				},
			] satisfies readonly CaseType[],
			currentCaseType: "patient",
			projectProse,
		};

		expect(
			summarizeFilter(
				isIn(
					term(prop("patient", "status")),
					literal("open_a"),
					literal("closed"),
				),
				context,
			),
		).toBe("Client status is one of Open (saved as open_a), Closed");
	});

	it("keeps non-choice literals and resolves choice labels through a related-case path", () => {
		const caseTypes: CaseType[] = [
			{
				name: "household",
				properties: [
					{
						name: "status",
						label: proseText("Household status"),
						data_type: "single_select",
						options: [
							{ value: "active_household", label: proseText("Active") },
						],
					},
				],
			},
			{
				name: "patient",
				parent_type: "household",
				properties: [
					{ name: "note", label: proseText("Case note"), data_type: "text" },
				],
			},
		];
		const context = { caseTypes, currentCaseType: "patient", projectProse };

		expect(
			summarizeFilter(
				eq(prop("patient", "note"), literal("follow_up_needed")),
				context,
			),
		).toBe("Case note is follow_up_needed");
		expect(
			summarizeFilter(
				eq(
					prop("patient", "status", ancestorPath(relationStep("parent"))),
					literal("active_household"),
				),
				context,
			),
		).toBe("Household status is Active");
	});

	it("leads with the search-answer condition instead of adding an afterthought", () => {
		expect(
			summarizeFilter(
				whenInput(input(testUuid("name_search")), statusIsntClosed),
				{ projectProse },
			),
		).toBe("When Search field has an answer, status isn't closed");
	});

	it("uses the authored search-field label while preserving its identity", () => {
		expect(
			summarizeFilter(
				whenInput(input(testUuid("name_search")), statusIsntClosed),
				{
					projectProse,
					knownInputs: [
						{
							uuid: testUuid("name_search"),
							name: "name_search",
							label: "Client name",
							data_type: "text",
						},
					],
				},
			),
		).toBe("When Client name has an answer, status isn't closed");
	});

	it("describes related-case filters as matching conditions", () => {
		const via = ancestorPath(relationStep("parent"));
		expect(
			summarizeFilter(exists(via, statusIsntClosed), { projectProse }),
		).toBe("A related case matches status isn't closed");
		expect(
			summarizeFilter(missing(via, statusIsntClosed), { projectProse }),
		).toBe("No related case matches status isn't closed");
	});

	it("joins and/or clauses with words and overflows past two", () => {
		expect(
			summarizeFilter(and(statusIsntClosed, statusIsntClosed), {
				projectProse,
			}),
		).toBe("status isn't closed and status isn't closed");
		expect(
			summarizeFilter(
				and(statusIsntClosed, statusIsntClosed, statusIsntClosed),
				{ projectProse },
			),
		).toBe("status isn't closed and status isn't closed and 1 more");
		expect(
			summarizeFilter(or(statusIsntClosed, statusIsntClosed), { projectProse }),
		).toBe("status isn't closed or status isn't closed");
	});

	it("renders absence and membership tests in worker words", () => {
		expect(
			summarizeFilter(isBlank(prop("patient", "phone")), { projectProse }),
		).toBe("phone is blank");
		expect(
			summarizeFilter(
				isIn(
					term(prop("patient", "status")),
					literal("active"),
					literal("pending"),
				),
				{ projectProse },
			),
		).toBe("status is one of active, pending");
		expect(
			summarizeFilter(
				between(status(), {
					lower: term(literal("a")),
					upper: term(literal("b")),
				}),
				{ projectProse },
			),
		).toBe("status is between a and b");
	});

	it("describes top-level negation as the filtering outcome", () => {
		expect(summarizeFilter(not(statusIsntClosed), { projectProse })).toBe(
			"Exclude cases when status isn't closed",
		);
		expect(
			summarizeFilter(not(exists(ancestorPath(relationStep("parent")))), {
				projectProse,
			}),
		).toBe("Exclude cases when a related case exists");
		expect(
			summarizeFilter(
				not(whenInput(input(testUuid("name_search")), statusIsntClosed)),
				{
					projectProse,
					knownInputs: [
						{
							uuid: testUuid("name_search"),
							name: "name_search",
							label: "Client name",
							data_type: "text",
						},
					],
				},
			),
		).toBe(
			"Exclude cases when Client name has an answer and status isn't closed",
		);
	});

	it("keeps nested negation grammatical without expression syntax", () => {
		expect(
			summarizeFilter(
				and(
					eq(prop("patient", "status"), literal("active")),
					not(eq(prop("patient", "region"), literal("blocked"))),
				),
				{ projectProse },
			),
		).toBe("status is active and region isn't blocked");
		expect(
			summarizeFilter(
				exists(
					ancestorPath(relationStep("parent")),
					not(eq(prop("household", "status"), literal("closed"))),
				),
				{ projectProse },
			),
		).toBe("A related case matches status isn't closed");
	});

	it("renders sentinels honestly", () => {
		expect(summarizeFilter(matchNone(), { projectProse })).toBe("no cases");
		expect(
			summarizeFilter({ kind: "not", clause: matchAll() }, { projectProse }),
		).toBe("Exclude every case");
		expect(
			summarizeFilter({ kind: "not", clause: matchNone() }, { projectProse }),
		).toBe("No cases are excluded");
	});

	it("degrades computed operands to an honest generic", () => {
		expect(
			summarizeFilter(
				{
					kind: "eq",
					left: status(),
					right: {
						kind: "concat",
						parts: [term(literal("a")), term(literal("b"))],
					},
				},
				{ projectProse },
			),
		).toBe("status is a calculated value");
	});
});
