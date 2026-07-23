// lib/domain/predicate/__tests__/simplify.test.ts
//
// Unit coverage for `simplifyForEmission` — the deep boolean-identity
// normalizer the wire-emission filter surfaces apply. The contract:
// drop `match-all` from `and` (absorb `match-none`), drop `match-none`
// from `or` (absorb `match-all`), flatten same-kind nesting, fold
// `not`, recurse through every nested Predicate slot (including the
// ones reached through a ValueExpression operand), and return a
// structurally-equal tree when no identity is present.

import { describe, expect, it } from "vitest";
import {
	and,
	count,
	effectiveDisplayConditionForEmission,
	effectiveFilterForEmission,
	eq,
	exists,
	gt,
	ifExpr,
	input,
	literal,
	matchAll,
	matchNone,
	not,
	or,
	prop,
	simplifyForEmission,
	subcasePath,
	term,
	whenInput,
} from "@/lib/domain/predicate";

const a = eq(prop("patient", "a"), literal(1));
const b = eq(prop("patient", "b"), literal(2));
const c = eq(prop("patient", "c"), literal(3));

describe("simplifyForEmission — sentinels pass through", () => {
	it("returns match-all unchanged", () => {
		expect(simplifyForEmission(matchAll())).toEqual(matchAll());
	});
	it("returns match-none unchanged", () => {
		expect(simplifyForEmission(matchNone())).toEqual(matchNone());
	});
});

describe("simplifyForEmission — conjunction identities", () => {
	it("drops a match-all clause from an and (either position)", () => {
		expect(simplifyForEmission(and(matchAll(), a))).toEqual(a);
		expect(simplifyForEmission(and(a, matchAll()))).toEqual(a);
	});

	it("collapses an all-match-all and to match-all", () => {
		expect(simplifyForEmission(and(matchAll(), matchAll()))).toEqual(
			matchAll(),
		);
	});

	it("absorbs to match-none when any and clause is match-none", () => {
		expect(simplifyForEmission(and(a, matchNone()))).toEqual(matchNone());
		expect(simplifyForEmission(and(matchNone(), a, b))).toEqual(matchNone());
	});

	it("keeps a sentinel-free and structurally unchanged", () => {
		expect(simplifyForEmission(and(a, b))).toEqual(and(a, b));
	});

	it("drops the identity but keeps the real clause as a bare predicate", () => {
		// and(match-all, a) ≡ a — the single survivor unwraps, no `and`
		// envelope around a lone clause.
		const out = simplifyForEmission(and(matchAll(), a));
		expect(out.kind).toBe("eq");
	});
});

describe("simplifyForEmission — disjunction identities", () => {
	it("drops a match-none clause from an or", () => {
		expect(simplifyForEmission(or(matchNone(), a))).toEqual(a);
	});

	it("absorbs to match-all when any or clause is match-all", () => {
		expect(simplifyForEmission(or(a, matchAll()))).toEqual(matchAll());
	});

	it("collapses an all-match-none or to match-none", () => {
		expect(simplifyForEmission(or(matchNone(), matchNone()))).toEqual(
			matchNone(),
		);
	});
});

describe("simplifyForEmission — nesting", () => {
	it("drops a match-all nested inside an authored and (the Finder-A case)", () => {
		// and(and(match-all, a), b) ≡ and(a, b) — the inner identity must
		// vanish at depth, not just at the top level.
		expect(simplifyForEmission(and(and(matchAll(), a), b))).toEqual(and(a, b));
	});

	it("flattens same-kind nesting", () => {
		expect(simplifyForEmission(and(and(a, b), c))).toEqual(and(a, b, c));
	});

	it("propagates inner absorption outward", () => {
		// and(b, or(match-none → drops to a)) → and(b, a); but and(b,
		// and(match-none, …)) absorbs the inner to match-none, which
		// absorbs the outer.
		expect(simplifyForEmission(and(b, and(matchNone(), a)))).toEqual(
			matchNone(),
		);
	});
});

describe("simplifyForEmission — not folds via the builder", () => {
	it("not(match-all) → match-none", () => {
		expect(simplifyForEmission(not(matchAll()))).toEqual(matchNone());
	});
	it("not(match-none) → match-all", () => {
		expect(simplifyForEmission(not(matchNone()))).toEqual(matchAll());
	});
	it("simplifies inside not before folding", () => {
		// not(and(match-all, a)) → not(a)
		expect(simplifyForEmission(not(and(matchAll(), a)))).toEqual(not(a));
	});
});

describe("simplifyForEmission — recursion through nested Predicate slots", () => {
	it("recurses into a when-input-present clause", () => {
		const i = input("q");
		expect(simplifyForEmission(whenInput(i, and(matchAll(), a)))).toEqual(
			whenInput(i, a),
		);
	});

	it("recurses into an exists where-clause", () => {
		const via = subcasePath("child");
		expect(simplifyForEmission(exists(via, and(matchAll(), a)))).toEqual(
			exists(via, a),
		);
	});

	it("recurses into a count.where reached through a comparison operand", () => {
		const via = subcasePath("child");
		const out = simplifyForEmission(
			gt(count(via, and(matchAll(), a)), literal(3)),
		);
		expect(out).toEqual(gt(count(via, a), literal(3)));
	});

	it("recurses into an if.cond reached through a comparison operand", () => {
		const out = simplifyForEmission(
			eq(
				ifExpr(and(matchAll(), a), term(literal("x")), term(literal("y"))),
				literal("x"),
			),
		);
		expect(out).toEqual(
			eq(ifExpr(a, term(literal("x")), term(literal("y"))), literal("x")),
		);
	});
});

describe("effectiveFilterForEmission — folds the always-true result to undefined", () => {
	it("returns undefined for an absent filter", () => {
		// Accepting `Predicate | undefined` folds the absent-filter case
		// in, so callers don't repeat the `=== undefined` guard.
		expect(effectiveFilterForEmission(undefined)).toBeUndefined();
	});

	it("returns undefined for a literal match-all", () => {
		expect(effectiveFilterForEmission(matchAll())).toBeUndefined();
	});

	it("returns undefined for a filter that REDUCES to match-all", () => {
		// The deep/shallow trap: `and(match-all, match-all)` is not
		// literally match-all (kind is `and`), but it narrows nothing.
		// Decision sites and emission both consume this helper so they
		// agree it's "no effective filter".
		expect(
			effectiveFilterForEmission(and(matchAll(), matchAll())),
		).toBeUndefined();
		expect(effectiveFilterForEmission(or(matchAll(), a))).toBeUndefined();
	});

	it("returns the narrowing predicate for a real filter (dropping nested identities)", () => {
		expect(effectiveFilterForEmission(a)).toEqual(a);
		expect(effectiveFilterForEmission(and(matchAll(), a))).toEqual(a);
	});

	it("does NOT fold match-none — it narrows to the empty set, a real query", () => {
		expect(effectiveFilterForEmission(matchNone())).toEqual(matchNone());
		expect(effectiveFilterForEmission(and(matchNone(), a))).toEqual(
			matchNone(),
		);
	});
});

describe("effectiveDisplayConditionForEmission", () => {
	it("folds absent and deeply always-true conditions to no wire carrier", () => {
		expect(effectiveDisplayConditionForEmission(undefined)).toBeUndefined();
		expect(
			effectiveDisplayConditionForEmission(or(matchAll(), a)),
		).toBeUndefined();
	});

	it("keeps a real condition and the always-false sentinel", () => {
		expect(effectiveDisplayConditionForEmission(and(matchAll(), a))).toEqual(a);
		expect(effectiveDisplayConditionForEmission(matchNone())).toEqual(
			matchNone(),
		);
	});
});
