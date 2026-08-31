// The shared "does this AST need a case row?" guards behind every
// globally-resolved slot: the assigned-case exclusion, a search
// input's starting value, and the search-button display condition.

import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import {
	ancestorPath,
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
	relationStep,
	selfPath,
	sessionContext,
	sessionUser,
	subcasePath,
	term,
	within,
} from "../builders";
import {
	expressionReadsCaseData,
	expressionReadsRelatedCaseData,
	predicateReadsCaseData,
	predicateReadsRelatedCaseData,
} from "../walk";

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
					term(input(testUuid("owner_ids"))),
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
				match(prop("patient", "case_name"), term(literal("amy")), "fuzzy"),
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

describe("expressionReadsRelatedCaseData", () => {
	const parent = ancestorPath(relationStep("parent", "household"));

	it("distinguishes current-case reads from relationship walks", () => {
		expect(
			expressionReadsRelatedCaseData(term(prop("patient", "case_name"))),
		).toBe(false);
		expect(
			expressionReadsRelatedCaseData(
				term(prop("patient", "case_name", selfPath())),
			),
		).toBe(false);
		expect(
			expressionReadsRelatedCaseData(term(prop("patient", "region", parent))),
		).toBe(true);
	});

	it("keeps self cardinality local while detecting nested related reads", () => {
		expect(expressionReadsRelatedCaseData(count(selfPath()))).toBe(false);
		expect(
			expressionReadsRelatedCaseData(
				ifExpr(
					exists(selfPath()),
					term(literal("present")),
					term(literal("missing")),
				),
			),
		).toBe(false);
		expect(
			expressionReadsRelatedCaseData(
				count(
					selfPath(),
					eq(term(prop("patient", "region", parent)), term(literal("north"))),
				),
			),
		).toBe(true);
	});

	it("detects relationship aggregates without property leaves", () => {
		expect(
			expressionReadsRelatedCaseData(count(subcasePath("parent", "visit"))),
		).toBe(true);
	});
});

describe("predicateReadsRelatedCaseData", () => {
	const parent = ancestorPath(relationStep("parent", "household"));

	it("keeps self presence local", () => {
		expect(predicateReadsRelatedCaseData(exists(selfPath()))).toBe(false);
		expect(predicateReadsRelatedCaseData(missing(selfPath()))).toBe(false);
	});

	it("detects direct and nested relationship reads", () => {
		expect(
			predicateReadsRelatedCaseData(
				eq(term(prop("patient", "region", parent)), term(literal("north"))),
			),
		).toBe(true);
		expect(
			predicateReadsRelatedCaseData(
				missing(
					selfPath(),
					eq(term(prop("patient", "region", parent)), term(literal("north"))),
				),
			),
		).toBe(true);
	});
});
