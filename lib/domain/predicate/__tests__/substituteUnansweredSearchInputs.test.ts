// lib/domain/predicate/__tests__/substituteUnansweredSearchInputs.test.ts
//
// The unanswered-Search substitution: `when-input-present` envelopes
// collapse to `match-all` and bare `input(...)` Terms become the blank
// literal, so wire slots that evaluate before any Search runs never
// reference the unloaded `search-input:results` instance. See
// `walk.ts::substituteUnansweredSearchInputsInPredicate` for the
// runtime-crash rationale. These tests establish structural substitution;
// native Core compatibility belongs to the wire consumer tests.

import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import {
	and,
	concat,
	eq,
	ifExpr,
	input,
	literal,
	matchAll,
	prop,
	sessionUser,
	term,
	whenInput,
} from "../builders";
import {
	substituteUnansweredSearchInputsInExpression,
	substituteUnansweredSearchInputsInPredicate,
} from "../walk";

describe("substituteUnansweredSearchInputsInPredicate", () => {
	it("returns the same reference when no Search input is reachable", () => {
		const filter = and(
			eq(prop("patient", "age"), literal(18)),
			eq(prop("patient", "region"), term(sessionUser("region"))),
		);
		expect(substituteUnansweredSearchInputsInPredicate(filter)).toBe(filter);
	});

	it("collapses an envelope to match-all without touching siblings", () => {
		const always = eq(prop("patient", "is_priority"), literal(true));
		const filter = and(
			whenInput(
				input(testUuid("name_query")),
				eq(prop("patient", "full_name"), term(input(testUuid("name_query")))),
			),
			always,
		);
		const before = structuredClone(filter);
		const substituted = substituteUnansweredSearchInputsInPredicate(filter);
		expect(substituted).toEqual(and(matchAll(), always));
		expect(filter).toEqual(before);
	});

	it("collapses a nested envelope through its enclosing envelope", () => {
		const filter = whenInput(
			input(testUuid("outer")),
			whenInput(
				input(testUuid("inner")),
				eq(prop("patient", "age"), literal(18)),
			),
		);
		expect(substituteUnansweredSearchInputsInPredicate(filter)).toEqual(
			matchAll(),
		);
	});

	it("blanks a bare input ref used as a comparison operand", () => {
		const filter = eq(
			prop("patient", "region"),
			term(input(testUuid("region_query"))),
		);
		expect(substituteUnansweredSearchInputsInPredicate(filter)).toEqual(
			eq(prop("patient", "region"), term(literal(""))),
		);
	});
});

describe("substituteUnansweredSearchInputsInExpression", () => {
	it("returns the same reference when no Search input is reachable", () => {
		const expression = concat(
			term(sessionUser("excluded_owner_ids")),
			term(literal(" unassigned")),
		);
		expect(substituteUnansweredSearchInputsInExpression(expression)).toBe(
			expression,
		);
	});

	it("blanks input refs inside composite expressions", () => {
		const expression = concat(
			term(input(testUuid("excluded_owners"))),
			term(literal(" ")),
			term(sessionUser("excluded_owner_ids")),
		);
		expect(substituteUnansweredSearchInputsInExpression(expression)).toEqual(
			concat(
				term(literal("")),
				term(literal(" ")),
				term(sessionUser("excluded_owner_ids")),
			),
		);
	});

	it("collapses an envelope carried by an if-condition", () => {
		const expression = ifExpr(
			whenInput(
				input(testUuid("q")),
				eq(prop("patient", "age"), term(input(testUuid("q")))),
			),
			term(literal("a")),
			term(literal("b")),
		);
		expect(substituteUnansweredSearchInputsInExpression(expression)).toEqual(
			ifExpr(matchAll(), term(literal("a")), term(literal("b"))),
		);
	});
});
