import { testUuid } from "@/__tests__/helpers/uuid";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { proseText } from "@/lib/domain/prose";
/**
 * Contract tests for the assigned-case exclusion expression.
 *
 * The value is resolved once from global Search/session state, before any case
 * row exists. Property and relationship reads must therefore be rejected even
 * when they happen to type-check as text: Preview has no row to read, while an
 * ordinary CommCare list would otherwise evaluate the same XPath per row.
 */

import { describe, expect, it } from "vitest";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { plainColumn } from "@/lib/domain";
import {
	concat,
	count,
	eq,
	exists,
	ifExpr,
	literal,
	prop,
	sessionContext,
	sessionUser,
	term,
	type ValueExpression,
} from "@/lib/domain/predicate";
import { runValidation } from "../../../runner";

const CASE_DATA_CODE =
	"CASE_SEARCH_EXCLUDED_OWNER_IDS_CASE_DATA_UNAVAILABLE" as const;
const TYPE_CODE = "CASE_SEARCH_EXCLUDED_OWNER_IDS_TYPE_ERROR" as const;

function docWithExpression(expression: ValueExpression | undefined) {
	return buildDoc({
		appName: "Test",
		modules: [
			{
				name: "Patients",
				caseType: "patient",
				caseListConfig: {
					columns: [plainColumn(testUuid("col-name"), "case_name", "Name")],
					listColumnOrder: [testUuid("col-name")],
					detailColumnOrder: [testUuid("col-name")],
					searchInputs: [],
				},
				...(expression === undefined
					? {}
					: {
							caseSearchConfig: {
								searchActionEnabled: false as const,
								excludedOwnerIds: expression,
							},
						}),
				forms: [
					{
						name: "Register patient",
						type: "registration",
						fields: [
							f({
								kind: "text",
								id: "case_name",
								label: proseText("Name"),
								caseWrite: { caseType: "patient", property: "case_name" },
							}),
						],
					},
				],
			},
		],
		caseTypes: [
			{
				name: "patient",
				properties: [
					{ name: "case_name", label: proseText("Name"), data_type: "text" },
					{ name: "age", label: proseText("Age"), data_type: "int" },
				],
			},
		],
	});
}

function codesFor(expression: ValueExpression) {
	return runValidation(
		docWithExpression(expression),
		LOOKUP_CONTEXT_UNAVAILABLE,
	).map((finding) => finding.code);
}

describe("excludedOwnerIdsTypeCheck", () => {
	it("rejects a text-valued case property read that would diverge by runtime", () => {
		const findings = runValidation(
			docWithExpression(term(prop("patient", "owner_id"))),
			LOOKUP_CONTEXT_UNAVAILABLE,
		).filter((finding) => finding.code === CASE_DATA_CODE);

		expect(findings).toHaveLength(1);
		expect(findings[0].message).toContain("before a case is selected");
		expect(findings[0].message).toContain("caseSearchConfig.excludedOwnerIds");
		expect(findings[0].details).toMatchObject({
			slot: "caseSearchConfig.excludedOwnerIds",
			surface: "excluded-owner-ids",
		});
	});

	it("finds a property read nested inside a pure-looking calculation", () => {
		const expression = concat(
			term(literal("owner-")),
			term(prop("patient", "case_name")),
		);
		expect(codesFor(expression)).toContain(CASE_DATA_CODE);
	});

	it.each([
		{
			name: "count",
			expression: count({
				kind: "subcase" as const,
				identifier: "parent",
				ofCaseType: "visit",
			}),
		},
		{
			name: "exists inside if",
			expression: ifExpr(
				exists({
					kind: "subcase" as const,
					identifier: "parent",
					ofCaseType: "visit",
				}),
				term(literal("owner-a")),
				term(literal("")),
			),
		},
	])("rejects the relationship read in $name", ({ expression }) => {
		expect(codesFor(expression)).toContain(CASE_DATA_CODE);
	});

	it("retains literals, current-user/session values, and pure calculations", () => {
		const allowed = [
			term(literal("owner-a owner-b")),
			term(sessionContext("userid")),
			term(sessionUser("assigned_owner_ids")),
			ifExpr(
				eq(term(sessionContext("userid")), literal("worker-a")),
				concat(
					term(sessionUser("assigned_owner_ids")),
					term(literal(" owner-a")),
				),
				term(literal("")),
			),
		];

		for (const expression of allowed) {
			// Full-gate assertion, not just this rule's two codes: a direct Search
			// answer is useful here because blank is the safe "exclude nobody"
			// identity on Preview, remote Search, and the guarded ordinary list.
			expect(
				runValidation(
					docWithExpression(expression),
					LOOKUP_CONTEXT_UNAVAILABLE,
				),
			).toEqual([]);
		}
	});

	it("still rejects a row-independent expression that does not resolve to text", () => {
		const findings = runValidation(
			docWithExpression(term(literal(42))),
			LOOKUP_CONTEXT_UNAVAILABLE,
		).filter((finding) => finding.code === TYPE_CODE);
		expect(findings).toHaveLength(1);
		expect(findings[0].message).toContain("Expected 'text'");
		expect(findings[0].message).toContain("resolves to 'int'");
		expect(codesFor(term(literal(42)))).not.toContain(CASE_DATA_CODE);
	});

	it("short-circuits when the assigned-case slot is absent", () => {
		const codes = runValidation(
			docWithExpression(undefined),
			LOOKUP_CONTEXT_UNAVAILABLE,
		).map((finding) => finding.code);
		expect(codes).not.toContain(CASE_DATA_CODE);
		expect(codes).not.toContain(TYPE_CODE);
	});
});
