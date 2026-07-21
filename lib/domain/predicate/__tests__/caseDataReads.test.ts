// The shared "does this AST need a case row?" guards behind every
// globally-resolved slot: the assigned-case exclusion, a search
// input's starting value, and the search-button display condition.

import { describe, expect, it } from "vitest";
import {
	and,
	concat,
	count,
	eq,
	exists,
	ifExpr,
	input,
	literal,
	match,
	missing,
	prop,
	sessionContext,
	sessionUser,
	term,
	within,
} from "../builders";
import { expressionReadsCaseData, predicateReadsCaseData } from "../walk";

describe("expressionReadsCaseData", () => {
	it("detects case reads at any expression depth", () => {
		expect(
			expressionReadsCaseData(
				concat(term(literal("owner-")), term(prop("patient", "owner_id"))),
			),
		).toBe(true);
		expect(
			expressionReadsCaseData(
				count({
					kind: "subcase",
					identifier: "parent",
					ofCaseType: "visit",
				}),
			),
		).toBe(true);
		expect(
			expressionReadsCaseData(
				ifExpr(
					exists({
						kind: "subcase",
						identifier: "parent",
						ofCaseType: "visit",
					}),
					term(literal("owner-a")),
					term(literal("")),
				),
			),
		).toBe(true);
	});

	it("keeps global session, Search, and literal expressions available", () => {
		expect(
			expressionReadsCaseData(
				concat(
					term(sessionContext("userid")),
					term(literal(" ")),
					term(input("owner_ids")),
				),
			),
		).toBe(false);
	});
});

describe("predicateReadsCaseData", () => {
	it("detects prop terms inside comparison operands", () => {
		expect(
			predicateReadsCaseData(
				eq(term(prop("patient", "status")), term(literal("open"))),
			),
		).toBe(true);
	});

	it("detects the PropertyRef slots on match / within-distance", () => {
		expect(
			predicateReadsCaseData(
				match(prop("patient", "name"), term(literal("amy")), "fuzzy"),
			),
		).toBe(true);
		expect(
			predicateReadsCaseData(
				within(
					prop("patient", "home"),
					term(literal("1.0 2.0")),
					5,
					"kilometers",
				),
			),
		).toBe(true);
	});

	it("detects relation reads carried without a property term", () => {
		expect(
			predicateReadsCaseData(
				missing({ kind: "subcase", identifier: "parent", ofCaseType: "visit" }),
			),
		).toBe(true);
		expect(
			predicateReadsCaseData(
				eq(
					count({ kind: "subcase", identifier: "parent", ofCaseType: "visit" }),
					term(literal("0")),
				),
			),
		).toBe(true);
	});

	it("keeps global session and fixed-value predicates available", () => {
		expect(
			predicateReadsCaseData(
				and(
					eq(term(sessionUser("role")), term(literal("supervisor"))),
					eq(term(sessionContext("userid")), term(literal("u1"))),
				),
			),
		).toBe(false);
	});
});
