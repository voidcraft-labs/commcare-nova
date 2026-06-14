// components/builder/case-list-config/__tests__/predicateSummary.test.ts
//
// Pins the human-language filter summary — the phrase the case-list
// canvas stamps on its filter affordance. The contract under test:
// worker-facing words, never AST jargon; vacuous predicates summarize
// to nothing; exotic shapes degrade to honest generic phrases.

import { describe, expect, it } from "vitest";
import {
	and,
	between,
	isBlank,
	isIn,
	literal,
	matchAll,
	matchNone,
	not,
	or,
	type Predicate,
	prop,
	term,
	today,
} from "@/lib/domain/predicate";
import { humanizeName, summarizeFilter } from "../predicateSummary";

const status = () => term(prop("patient", "status"));

const statusIsntClosed: Predicate = {
	kind: "neq",
	left: status(),
	right: term(literal("closed")),
};

describe("summarizeFilter", () => {
	it("returns undefined for an absent filter and for match-all (no narrowing)", () => {
		expect(summarizeFilter(undefined)).toBeUndefined();
		expect(summarizeFilter(matchAll())).toBeUndefined();
	});

	it("renders comparisons as subject-verb-object sentences", () => {
		expect(summarizeFilter(statusIsntClosed)).toBe("status isn't closed");
		expect(
			summarizeFilter({
				kind: "eq",
				left: status(),
				right: term(literal("active")),
			}),
		).toBe("status is active");
		expect(
			summarizeFilter({
				kind: "gt",
				left: term(prop("patient", "age")),
				right: term(literal(5)),
			}),
		).toBe("age is more than 5");
	});

	it("spaces identifier separators so property names read as words", () => {
		expect(
			summarizeFilter({
				kind: "eq",
				left: term(prop("patient", "rash_onset_date")),
				right: today(),
			}),
		).toBe("rash onset date is today");
		expect(humanizeName("follow-up_date")).toBe("follow up date");
	});

	it("joins and/or clauses with words and overflows past two", () => {
		expect(summarizeFilter(and(statusIsntClosed, statusIsntClosed))).toBe(
			"status isn't closed and status isn't closed",
		);
		expect(
			summarizeFilter(
				and(statusIsntClosed, statusIsntClosed, statusIsntClosed),
			),
		).toBe("status isn't closed and status isn't closed and 1 more");
		expect(summarizeFilter(or(statusIsntClosed, statusIsntClosed))).toBe(
			"status isn't closed or status isn't closed",
		);
	});

	it("renders absence and membership tests in worker words", () => {
		expect(summarizeFilter(isBlank(prop("patient", "phone")))).toBe(
			"phone is blank",
		);
		expect(
			summarizeFilter(
				isIn(
					term(prop("patient", "status")),
					literal("active"),
					literal("pending"),
				),
			),
		).toBe("status is one of active, pending");
		expect(
			summarizeFilter(
				between(status(), {
					lower: term(literal("a")),
					upper: term(literal("b")),
				}),
			),
		).toBe("status is between a and b");
	});

	it("wraps negation and renders sentinels honestly", () => {
		expect(summarizeFilter(not(statusIsntClosed))).toBe(
			"not (status isn't closed)",
		);
		expect(summarizeFilter(matchNone())).toBe("no cases");
	});

	it("degrades computed operands to an honest generic", () => {
		expect(
			summarizeFilter({
				kind: "eq",
				left: status(),
				right: {
					kind: "concat",
					parts: [term(literal("a")), term(literal("b"))],
				},
			}),
		).toBe("status is a calculated value");
	});
});
