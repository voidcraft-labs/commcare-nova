/**
 * One record slot of HQ's JSON read from its text: interpolated as HQ's
 * build interpolates it, bound with the record rule set's folds, printed by
 * the production HQ JSON emitter and interpolated again. The failures this
 * holds: `#parent` not read as the relation, `cond` refused where it is the
 * nested `if` it equals, an `or` of equalities, a pair of orderings or a
 * nested `if` not folded to the one card Nova has, a date literal left text
 * against a date, a filter holding a boolean identity left unrecognized
 * where the withheld print holds it, and `#host` read as a relation Nova
 * cannot write.
 */
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { EMISSION_REWRITE_IDS } from "@/lib/commcare/emissionRewrites";
import type { Expression } from "@/lib/domain/expression/types";
import { calculatedColumn } from "@/lib/domain/modules";
import { readExpression } from "../readExpression";
import { readEnv, registration } from "./expressionReadFixture";

const COLUMN = testUuid("calculated-column");

function patientsDoc() {
	return buildDoc({
		caseTypes: [
			{
				name: "household",
				properties: [{ name: "village", label: "Village" }],
			},
			{
				name: "patient",
				parent_type: "household",
				properties: [
					{ name: "age", label: "Age", data_type: "int" },
					{ name: "dob", label: "Date of birth", data_type: "date" },
					{ name: "p", label: "P" },
				],
			},
		],
		modules: [
			{
				name: "Patients",
				caseType: "patient",
				caseListConfig: {
					columns: [
						calculatedColumn(COLUMN, "Group", {
							kind: "term",
							term: { kind: "literal", value: "" },
						}),
					],
					searchInputs: [],
				},
				forms: [
					{
						name: "Visit",
						type: "followup",
						fields: [f({ kind: "text", id: "q1", label: "Q1" })],
					},
				],
			},
		],
	});
}

function moduleOf(doc: ReturnType<typeof patientsDoc>) {
	return doc.moduleOrder[0] as (typeof doc.moduleOrder)[number];
}

function held(judgment: ReturnType<typeof readExpression>): Expression {
	expect(judgment.kind).toBe("bound");
	if (judgment.kind !== "bound") throw new Error("not bound");
	expect(judgment.equal).toBe(true);
	return judgment.candidate;
}

describe("a record slot's text read as HQ's build interpolates it", () => {
	it("reads #parent in the case list filter as the parent relation", () => {
		const doc = patientsDoc();
		const ref = {
			entity: "module",
			uuid: moduleOf(doc),
			slot: "case_list_filter",
		} as const;
		// HQ's casedb join binds as the relation read; Nova writes a scalar
		// test of a relation as a presence test of the related case, so the
		// join itself prints otherwise and is no exact reading.
		const judgment = readExpression(
			doc,
			registration(doc, ref, "#parent/village = 'x'"),
			readEnv(),
		);
		expect(judgment).toMatchObject({
			kind: "bound",
			equal: false,
			candidate: {
				kind: "eq",
				left: {
					kind: "term",
					term: {
						kind: "prop",
						caseType: "patient",
						property: "village",
						via: { kind: "ancestor", via: [{ identifier: "parent" }] },
					},
				},
			},
		});
		// The presence test Nova writes reads back as the relation's presence.
		const presence = held(
			readExpression(
				doc,
				registration(
					doc,
					ref,
					"count(index/parent) > 0 and selected(join(' ', instance('casedb')/casedb/case[@case_type = 'household' and village = 'x']/@case_id), index/parent)",
				),
				readEnv(),
			),
		);
		expect(presence).toMatchObject({
			kind: "exists",
			via: {
				kind: "ancestor",
				via: [{ identifier: "parent", throughCaseType: "household" }],
			},
		});
	});

	it("refuses a bare dot, which HQ reads as the case node", () => {
		const doc = patientsDoc();
		const ref = {
			entity: "module",
			uuid: moduleOf(doc),
			slot: "case_list_filter",
		} as const;
		const judgment = readExpression(
			doc,
			registration(doc, ref, ". = 'x'"),
			readEnv(),
		);
		expect(judgment.kind === "bound" && judgment.equal).toBe(false);
	});

	it("reads cond in a calculated column as the nested if it equals", () => {
		const doc = patientsDoc();
		const ref = {
			entity: "module",
			uuid: moduleOf(doc),
			slot: "case_list_column_expression",
			member: { columnUuid: COLUMN },
		} as const;
		const tree = held(
			readExpression(
				doc,
				registration(
					doc,
					ref,
					"cond(age > 60, 'old', age > 18, 'adult', 'young')",
				),
				readEnv(),
			),
		);
		expect(tree).toMatchObject({ kind: "if", else: { kind: "if" } });
	});

	it("folds an or of equalities, a bounded pair and a nested if on one subject", () => {
		const doc = patientsDoc();
		const filter = {
			entity: "module",
			uuid: moduleOf(doc),
			slot: "case_list_filter",
		} as const;
		const column = {
			entity: "module",
			uuid: moduleOf(doc),
			slot: "case_list_column_expression",
			member: { columnUuid: COLUMN },
		} as const;
		expect(
			held(
				readExpression(
					doc,
					registration(doc, filter, "p = 'a' or p = 'b'"),
					readEnv(),
				),
			),
		).toMatchObject({ kind: "in", values: [{ value: "a" }, { value: "b" }] });
		expect(
			held(
				readExpression(
					doc,
					registration(doc, filter, "age >= 1 and age < 5"),
					readEnv(),
				),
			),
		).toMatchObject({
			kind: "between",
			lowerInclusive: true,
			upperInclusive: false,
		});
		expect(
			held(
				readExpression(
					doc,
					registration(doc, column, "if(p = 'a', 'x', if(p = 'b', 'y', 'z'))"),
					readEnv(),
				),
			),
		).toMatchObject({ kind: "switch", cases: [{}, {}] });
	});

	it("types a date literal against a date and leaves one against text alone", () => {
		const doc = patientsDoc();
		const ref = {
			entity: "module",
			uuid: moduleOf(doc),
			slot: "case_list_filter",
		} as const;
		expect(
			held(
				readExpression(
					doc,
					registration(doc, ref, "dob > '2000-01-01'"),
					readEnv(),
				),
			),
		).toMatchObject({
			kind: "gt",
			right: {
				kind: "term",
				term: { kind: "literal", value: "2000-01-01", data_type: "date" },
			},
		});
		expect(
			held(
				readExpression(
					doc,
					registration(doc, ref, "p = '2000-01-01'"),
					readEnv(),
				),
			),
		).toMatchObject({
			kind: "eq",
			right: { kind: "term", term: { kind: "literal", value: "2000-01-01" } },
		});
	});

	it("holds a filter with a boolean identity at the withheld print alone", () => {
		const doc = patientsDoc();
		const ref = {
			entity: "module",
			uuid: moduleOf(doc),
			slot: "case_list_filter",
		} as const;
		const pending = registration(doc, ref, "true() and p = 'x'");
		const exact = readExpression(doc, pending, readEnv());
		expect(exact.kind === "bound" && exact.equal).toBe(false);
		const reached: string[] = [];
		const withheld = readExpression(doc, pending, readEnv(), {
			rewrites: {
				withhold: new Set(EMISSION_REWRITE_IDS),
				reached: (id) => reached.push(id),
			},
		});
		expect(withheld.kind === "bound" && withheld.equal).toBe(true);
		expect(reached).toContain("filter-identities-dropped");
	});

	it("leaves #host a query of cases, which no relation Nova writes prints", () => {
		const doc = patientsDoc();
		const ref = {
			entity: "module",
			uuid: moduleOf(doc),
			slot: "case_list_filter",
		} as const;
		const judgment = readExpression(
			doc,
			registration(doc, ref, "#host/village = 'x'"),
			readEnv(),
		);
		if (judgment.kind === "refused") return;
		expect(judgment.candidate).not.toMatchObject({
			left: { kind: "term", term: { kind: "prop", via: { kind: "ancestor" } } },
		});
	});
});
