import { asUuid } from "@/lib/domain";
// lib/domain/predicate/__tests__/substituteUnansweredSearchInputs.test.ts
//
// The unanswered-Search substitution: `when-input-present` envelopes
// collapse to `match-all` and bare `input(...)` Terms become the blank
// literal, so wire slots that evaluate before any Search runs never
// reference the unloaded `search-input:results` instance. See
// `walk.ts::substituteUnansweredSearchInputsInPredicate` for the
// runtime-crash rationale.

import { describe, expect, it } from "vitest";
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
				input(asUuid("42ab9981-e4f6-4efd-8551-66a8fefaaacf")),
				eq(
					prop("patient", "full_name"),
					term(input(asUuid("42ab9981-e4f6-4efd-8551-66a8fefaaacf"))),
				),
			),
			always,
		);
		const substituted = substituteUnansweredSearchInputsInPredicate(filter);
		expect(substituted).toEqual(and(matchAll(), always));
		// The authored tree is never mutated — emission owns the copy.
		expect(filter.kind).toBe("and");
		if (filter.kind === "and") {
			expect(filter.clauses[0].kind).toBe("when-input-present");
		}
	});

	it("collapses a nested envelope through its enclosing envelope", () => {
		const filter = whenInput(
			input(asUuid("60a5a821-680a-4068-8fcc-66b8098bdb88")),
			whenInput(
				input(asUuid("0fb61eb8-e5f6-4a3b-8814-4286943422a8")),
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
			term(input(asUuid("89d1be2f-959f-4e04-80d5-c75fd093a298"))),
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
			term(input(asUuid("bd984979-3fb6-4806-8292-0ea8be7258f7"))),
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
				input(asUuid("f38dea69-87fd-4b8c-8190-516b176c3b33")),
				eq(
					prop("patient", "age"),
					term(input(asUuid("f38dea69-87fd-4b8c-8190-516b176c3b33"))),
				),
			),
			term(literal("a")),
			term(literal("b")),
		);
		expect(substituteUnansweredSearchInputsInExpression(expression)).toEqual(
			ifExpr(matchAll(), term(literal("a")), term(literal("b"))),
		);
	});
});
