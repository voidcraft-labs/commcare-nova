import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { resolveCaseListConfig } from "@/lib/__tests__/docHelpers";
import {
	advancedSearchInputDef,
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
import { collectRuntimeCsqlStringInputNames as collectRuntimeCsqlStringInputNamesRaw } from "../runtimeCsqlQuoteSafety";

const u = (tail: number) =>
	testUuid(`00000000-0000-0000-0000-${String(tail).padStart(12, "0")}`);

const TEST_INPUTS = [
	"direct",
	"date_text",
	"trigger",
	"number",
	"control",
	"branch_value",
	"visit_name",
].map((name) => ({
	uuid: testUuid(name),
	name,
	data_type: "text" as const,
}));
TEST_INPUTS.push(
	{ uuid: u(1), name: "client_query", data_type: "text" },
	{ uuid: u(2), name: "advanced_owner", data_type: "text" },
	{ uuid: u(3), name: "sibling", data_type: "text" },
	{ uuid: u(4), name: "query", data_type: "text" },
	{ uuid: u(5), name: "filter_value", data_type: "text" },
);

function collectRuntimeCsqlStringInputNames(
	predicate: Parameters<typeof collectRuntimeCsqlStringInputNamesRaw>[0],
) {
	return collectRuntimeCsqlStringInputNamesRaw(predicate, TEST_INPUTS);
}

describe("collectRuntimeCsqlStringInputNames", () => {
	it("collects direct and native-function input values", () => {
		expect(
			collectRuntimeCsqlStringInputNames(
				eq(prop("patient", "name"), input(testUuid("direct"))),
			),
		).toEqual(new Set(["direct"]));
		expect(
			collectRuntimeCsqlStringInputNames(
				eq(
					prop("patient", "dob"),
					dateCoerce(term(input(testUuid("date_text")))),
				),
			),
		).toEqual(new Set(["date_text"]));
	});

	it("skips trigger-only and normalized on-device control values", () => {
		const triggerOnly = whenInput(
			input(testUuid("trigger")),
			eq(prop("patient", "status"), literal("active")),
		);
		const numericOutput = eq(
			prop("patient", "score"),
			arith("+", term(input(testUuid("number"))), term(literal(1))),
		);
		const conditionalControl = eq(
			prop("patient", "label"),
			ifExpr(
				eq(input(testUuid("control")), literal("yes")),
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
				term(input(testUuid("branch_value"))),
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
					input(testUuid("visit_name")),
					eq(prop("visit", "name"), input(testUuid("visit_name"))),
				),
			),
		);
		expect(collectRuntimeCsqlStringInputNames(predicate)).toEqual(
			new Set(["visit_name"]),
		);
	});

	it("uses the exact effective composition across filter, advanced, and simple inputs", () => {
		const config: CaseListConfig = resolveCaseListConfig({
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
					whenInput(input(u(3)), eq(prop("patient", "region"), input(u(3)))),
				),
				// This prompt is consumed by the sibling advanced predicate.
				advancedSearchInputDef(u(3), "sibling", "Region", "text", matchAll()),
				// The app-wide Results filter owns this independent prompt.
				advancedSearchInputDef(
					u(5),
					"filter_value",
					"Filter",
					"text",
					matchAll(),
				),
			],
			filter: whenInput(
				input(u(5)),
				eq(prop("patient", "status"), input(u(5))),
			),
		});
		const predicate = composeXPathQueryPredicate(config, "patient");
		expect(collectRuntimeCsqlStringInputNames(predicate)).toEqual(
			new Set(["client_query", "sibling", "filter_value"]),
		);
	});

	it("does not restrict dead clauses absorbed by match-none", () => {
		const config: CaseListConfig = resolveCaseListConfig({
			columns: [],
			filter: matchNone(),
			searchInputs: [
				advancedSearchInputDef(
					u(4),
					"query",
					"Query",
					"text",
					whenInput(input(u(4)), eq(prop("patient", "name"), input(u(4)))),
				),
			],
		});
		expect(
			collectRuntimeCsqlStringInputNames(
				composeXPathQueryPredicate(config, "patient"),
			),
		).toEqual(new Set());
	});
});
