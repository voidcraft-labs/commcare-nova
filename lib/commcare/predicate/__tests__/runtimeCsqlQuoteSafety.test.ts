import { describe, expect, it } from "vitest";
import {
	advancedSearchInputDef,
	asUuid,
	type CaseListConfig,
	simpleSearchInputDef,
} from "@/lib/domain";
import {
	arith,
	count,
	dateCoerce,
	eq,
	gt,
	ifExpr,
	input,
	literal,
	matchAll,
	matchNone,
	prop,
	subcasePath,
	term,
	whenInput,
} from "@/lib/domain/predicate";
import { composeXPathQueryPredicate } from "../../suite/case-search/xpathQuery";
import { collectRuntimeCsqlStringInputNames } from "../runtimeCsqlQuoteSafety";

const u = (tail: number) =>
	asUuid(`00000000-0000-0000-0000-${String(tail).padStart(12, "0")}`);

describe("collectRuntimeCsqlStringInputNames", () => {
	it("collects direct and native-function input values", () => {
		expect(
			collectRuntimeCsqlStringInputNames(
				eq(prop("patient", "name"), input("direct")),
			),
		).toEqual(new Set(["direct"]));
		expect(
			collectRuntimeCsqlStringInputNames(
				eq(prop("patient", "dob"), dateCoerce(term(input("date_text")))),
			),
		).toEqual(new Set(["date_text"]));
	});

	it("skips trigger-only and normalized on-device control values", () => {
		const triggerOnly = whenInput(
			input("trigger"),
			eq(prop("patient", "status"), literal("active")),
		);
		const numericOutput = eq(
			prop("patient", "score"),
			arith("+", term(input("number")), term(literal(1))),
		);
		const conditionalControl = eq(
			prop("patient", "label"),
			ifExpr(
				eq(input("control"), literal("yes")),
				term(literal("accepted")),
				term(literal("rejected")),
			),
		);
		expect(collectRuntimeCsqlStringInputNames(triggerOnly)).toEqual(new Set());
		expect(collectRuntimeCsqlStringInputNames(numericOutput)).toEqual(
			new Set(),
		);
		expect(collectRuntimeCsqlStringInputNames(conditionalControl)).toEqual(
			new Set(),
		);
	});

	it("follows raw output through non-native branches", () => {
		const predicate = eq(
			prop("patient", "label"),
			ifExpr(
				matchAll(),
				term(input("branch_value")),
				term(literal("fallback")),
			),
		);
		expect(collectRuntimeCsqlStringInputNames(predicate)).toEqual(
			new Set(["branch_value"]),
		);
	});

	it("normalizes an RHS subcase-count before walking its native filter", () => {
		const predicate = gt(
			literal(2),
			count(
				subcasePath("visit"),
				whenInput(
					input("visit_name"),
					eq(prop("visit", "name"), input("visit_name")),
				),
			),
		);
		expect(collectRuntimeCsqlStringInputNames(predicate)).toEqual(
			new Set(["visit_name"]),
		);
	});

	it("uses the exact effective composition across filter, advanced, and simple inputs", () => {
		const config: CaseListConfig = {
			columns: [],
			searchInputs: [
				simpleSearchInputDef(
					u(1),
					"client_query",
					"Client",
					"text",
					"case_name",
				),
				advancedSearchInputDef(
					u(2),
					"advanced_owner",
					"Advanced",
					"text",
					whenInput(
						input("sibling"),
						eq(prop("patient", "region"), input("sibling")),
					),
				),
				// This prompt is consumed by the sibling advanced predicate.
				advancedSearchInputDef(u(3), "sibling", "Region", "text", matchAll()),
			],
			filter: whenInput(
				input("filter_value"),
				eq(prop("patient", "status"), input("filter_value")),
			),
		};
		const predicate = composeXPathQueryPredicate(config, "patient");
		expect(collectRuntimeCsqlStringInputNames(predicate)).toEqual(
			new Set(["client_query", "sibling", "filter_value"]),
		);
	});

	it("does not restrict dead clauses absorbed by match-none", () => {
		const config: CaseListConfig = {
			columns: [],
			filter: matchNone(),
			searchInputs: [
				advancedSearchInputDef(
					u(4),
					"query",
					"Query",
					"text",
					whenInput(
						input("query"),
						eq(prop("patient", "name"), input("query")),
					),
				),
			],
		};
		expect(
			collectRuntimeCsqlStringInputNames(
				composeXPathQueryPredicate(config, "patient"),
			),
		).toEqual(new Set());
	});
});
