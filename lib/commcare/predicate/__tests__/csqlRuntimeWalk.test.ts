import { describe, expect, it } from "vitest";
import type { Predicate, ValueExpression } from "@/lib/domain/predicate";
import {
	count,
	dateAdd,
	dateCoerce,
	eq,
	ifExpr,
	literal,
	match,
	matchAll,
	prop,
	selfPath,
	subcasePath,
	term,
	today,
} from "@/lib/domain/predicate";
import { walkCsqlOnDeviceNodes } from "../csqlRuntimeWalk";

function visitedKinds(predicate: Predicate): {
	readonly expressions: readonly ValueExpression["kind"][];
	readonly predicates: readonly Predicate["kind"][];
} {
	const expressions: ValueExpression["kind"][] = [];
	const predicates: Predicate["kind"][] = [];
	walkCsqlOnDeviceNodes(predicate, {
		visitExpression(expression) {
			expressions.push(expression.kind);
		},
		visitPredicate(node) {
			predicates.push(node.kind);
		},
	});
	return { expressions, predicates };
}

describe("walkCsqlOnDeviceNodes", () => {
	it("leaves a direct native date-add entirely on the CSQL server", () => {
		const predicate = eq(
			prop("patient", "dob"),
			dateAdd(today(), "months", term(literal(1))),
		);
		expect(visitedKinds(predicate)).toEqual({
			expressions: [],
			predicates: [],
		});
	});

	it("switches a non-native root and every descendant to on-device evaluation", () => {
		const predicate = eq(
			prop("patient", "dob"),
			ifExpr(
				match(prop("patient", "case_name"), "A", "fuzzy"),
				dateAdd(today(), "months", term(literal(1))),
				today(),
			),
		);
		expect(visitedKinds(predicate)).toEqual({
			expressions: ["if", "term", "date-add", "today", "term", "today"],
			predicates: ["match"],
		});
	});

	it("switches only a non-native child beneath a native value function", () => {
		const predicate = eq(
			prop("patient", "dob"),
			dateCoerce(
				ifExpr(
					matchAll(),
					dateAdd(today(), "months", term(literal(1))),
					today(),
				),
			),
		);
		expect(visitedKinds(predicate)).toEqual({
			expressions: ["if", "date-add", "today", "term", "today"],
			predicates: ["match-all"],
		});
	});

	it("keeps nested native date-add arguments on the CSQL server", () => {
		const predicate = eq(
			prop("patient", "dob"),
			dateAdd(
				dateAdd(today(), "years", term(literal(1))),
				"months",
				term(literal(1)),
			),
		);
		expect(visitedKinds(predicate).expressions).toEqual([]);
	});

	it("treats count outside the direct comparison-LHS subcase slot as wholly on-device", () => {
		const predicate = eq(
			prop("patient", "child_total"),
			count(
				selfPath(),
				eq(
					prop("patient", "dob"),
					dateAdd(today(), "months", term(literal(1))),
				),
			),
		);
		const visited = visitedKinds(predicate);
		expect(visited.expressions).toContain("count");
		expect(visited.expressions).toContain("date-add");
		expect(visited.predicates).toContain("eq");
	});

	it("keeps a direct comparison-LHS subcase count and its where clause in CSQL", () => {
		const predicate = eq(
			count(
				subcasePath("parent"),
				eq(
					prop("patient", "dob"),
					dateAdd(today(), "months", term(literal(1))),
				),
			),
			literal(0),
		);
		expect(visitedKinds(predicate)).toEqual({
			expressions: [],
			predicates: [],
		});
	});

	it("normalizes a RHS subcase count before deciding the runtime boundary", () => {
		const predicate = eq(
			literal(0),
			count(
				subcasePath("parent"),
				match(prop("patient", "case_name"), "A", "fuzzy"),
			),
		);
		expect(visitedKinds(predicate)).toEqual({
			expressions: [],
			predicates: [],
		});
	});

	it("still finds an on-device subtree inside a native subcase-count where clause", () => {
		const predicate = eq(
			literal(0),
			count(
				subcasePath("parent"),
				eq(
					prop("patient", "dob"),
					ifExpr(
						matchAll(),
						dateAdd(today(), "months", term(literal(1))),
						today(),
					),
				),
			),
		);
		const visited = visitedKinds(predicate);
		expect(visited.expressions).toContain("if");
		expect(visited.expressions).toContain("date-add");
	});
});
