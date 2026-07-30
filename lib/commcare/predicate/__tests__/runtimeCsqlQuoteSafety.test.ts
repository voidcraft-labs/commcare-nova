import { describe, expect, it } from "vitest";
import { resolveCaseListConfig } from "@/lib/__tests__/docHelpers";
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
import { collectRuntimeCsqlStringInputUuids } from "../runtimeCsqlQuoteSafety";

const u = (tail: number) =>
	asUuid(`00000000-0000-0000-0000-${String(tail).padStart(12, "0")}`);

describe("collectRuntimeCsqlStringInputUuids", () => {
	it("collects direct and native-function input values", () => {
		expect(
			collectRuntimeCsqlStringInputUuids(
				eq(
					prop("patient", "name"),
					input(asUuid("86682ef3-89ba-4086-8cb9-8ba1fd44c162")),
				),
			),
		).toEqual(new Set([asUuid("86682ef3-89ba-4086-8cb9-8ba1fd44c162")]));
		expect(
			collectRuntimeCsqlStringInputUuids(
				eq(
					prop("patient", "dob"),
					dateCoerce(
						term(input(asUuid("2d1ddc69-ad97-4c0c-8b01-2aab2fb10d10"))),
					),
				),
			),
		).toEqual(new Set([asUuid("2d1ddc69-ad97-4c0c-8b01-2aab2fb10d10")]));
	});

	it("skips trigger-only and normalized on-device control values", () => {
		const triggerOnly = whenInput(
			input(asUuid("86f97337-47b3-480b-8fee-c5a918041203")),
			eq(prop("patient", "status"), literal("active")),
		);
		const numericOutput = eq(
			prop("patient", "score"),
			arith(
				"+",
				term(input(asUuid("6ad32d13-f097-40c6-833a-8c124c7ef785"))),
				term(literal(1)),
			),
		);
		const conditionalControl = eq(
			prop("patient", "label"),
			ifExpr(
				eq(
					input(asUuid("3a385156-ab07-4067-80ae-19e880d4bc6b")),
					literal("yes"),
				),
				term(literal("accepted")),
				term(literal("rejected")),
			),
		);
		expect(collectRuntimeCsqlStringInputUuids(triggerOnly)).toEqual(new Set());
		expect(collectRuntimeCsqlStringInputUuids(numericOutput)).toEqual(
			new Set(),
		);
		expect(collectRuntimeCsqlStringInputUuids(conditionalControl)).toEqual(
			new Set(),
		);
	});

	it("follows raw output through non-native branches", () => {
		const predicate = eq(
			prop("patient", "label"),
			ifExpr(
				matchAll(),
				term(input(asUuid("e4c52089-caba-4cff-858c-7297acba8409"))),
				term(literal("fallback")),
			),
		);
		expect(collectRuntimeCsqlStringInputUuids(predicate)).toEqual(
			new Set([asUuid("e4c52089-caba-4cff-858c-7297acba8409")]),
		);
	});

	it("normalizes an RHS subcase-count before walking its native filter", () => {
		const predicate = gt(
			literal(2),
			count(
				subcasePath("visit"),
				whenInput(
					input(asUuid("e91f1dd4-be63-443c-8799-4606aaedfdcd")),
					eq(
						prop("visit", "name"),
						input(asUuid("e91f1dd4-be63-443c-8799-4606aaedfdcd")),
					),
				),
			),
		);
		expect(collectRuntimeCsqlStringInputUuids(predicate)).toEqual(
			new Set([asUuid("e91f1dd4-be63-443c-8799-4606aaedfdcd")]),
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
			],
			filter: whenInput(
				input(asUuid("4dc45fed-572f-4487-8df7-3e6c57d78d21")),
				eq(
					prop("patient", "status"),
					input(asUuid("4dc45fed-572f-4487-8df7-3e6c57d78d21")),
				),
			),
		});
		const predicate = composeXPathQueryPredicate(config, "patient");
		expect(collectRuntimeCsqlStringInputUuids(predicate)).toEqual(
			new Set([u(1), u(3), asUuid("4dc45fed-572f-4487-8df7-3e6c57d78d21")]),
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
			collectRuntimeCsqlStringInputUuids(
				composeXPathQueryPredicate(config, "patient"),
			),
		).toEqual(new Set());
	});
});
