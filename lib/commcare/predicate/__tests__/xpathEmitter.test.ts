// lib/commcare/predicate/__tests__/xpathEmitter.test.ts
//
// Acceptance tests for the predicate-AST → CommCare XPath/CSQL emitter.
// Each `it` builds an AST via the typed builders and asserts the
// emitter's exact wire string. The strings are pinned to CommCare's
// shipped wire vocabulary, citation-anchored to commcare-hq source so
// any future change in the emitter that drifts from CommCare's accepted
// forms surfaces as a test failure.
//
// Coverage spans three concentric layers: (1) per-operator output for
// every comparison + logical kind landing in this emitter, (2) operand
// emission for each term variant (prop / input / user / literal,
// including the embedded-quote concat fallback), (3) the precedence
// invariant that and-of-or wraps the inner or in parens. A final
// equivalence check verifies that `case-list-filter` and `csql`
// contexts emit identical strings at the operator + quoting layer —
// the two contexts diverge only at the wire-wrapping layer outside
// this emitter, and a regression that introduced an asymmetry would
// silently change one consumer's output.
//
// CCHQ citations for the emitted forms are in xpathEmitter.ts.

import { describe, expect, it } from "vitest";
import {
	and,
	eq,
	gt,
	gte,
	input,
	literal,
	lt,
	lte,
	neq,
	not,
	or,
	prop,
	userField,
} from "@/lib/domain/predicate/builders";
import { emitXPath } from "../xpathEmitter";

describe("emitXPath — comparison operators (case-list-filter context)", () => {
	it("emits eq with a string literal", () => {
		const p = eq(prop("patient", "status"), literal("open"));
		expect(emitXPath(p, "case-list-filter")).toBe("status = 'open'");
	});

	it("emits eq with a numeric literal", () => {
		const p = eq(prop("patient", "age"), literal(42));
		expect(emitXPath(p, "case-list-filter")).toBe("age = 42");
	});

	it("emits neq", () => {
		const p = neq(prop("patient", "status"), literal("closed"));
		expect(emitXPath(p, "case-list-filter")).toBe("status != 'closed'");
	});

	it("emits gt / gte / lt / lte", () => {
		expect(
			emitXPath(gt(prop("patient", "age"), literal(18)), "case-list-filter"),
		).toBe("age > 18");
		expect(
			emitXPath(gte(prop("patient", "age"), literal(18)), "case-list-filter"),
		).toBe("age >= 18");
		expect(
			emitXPath(lt(prop("patient", "age"), literal(18)), "case-list-filter"),
		).toBe("age < 18");
		expect(
			emitXPath(lte(prop("patient", "age"), literal(18)), "case-list-filter"),
		).toBe("age <= 18");
	});

	it("escapes single quotes in string literals via concat()", () => {
		// XPath 1.0 has no string-escape syntax: a literal embedding a
		// single quote inside a single-quoted string cannot be expressed
		// directly. The portable form switches to concat() with
		// alternating single- and double-quoted segments. Pinning the
		// exact concat shape here also locks the segment ordering so a
		// regression that rebuilt the string in some other order would
		// surface as a fixture mismatch rather than a silent encoding
		// drift.
		const p = eq(prop("patient", "name"), literal("O'Brien"));
		expect(emitXPath(p, "case-list-filter")).toBe(
			`name = concat('O', "'", 'Brien')`,
		);
	});

	it("emits user-context refs against session/user/data", () => {
		const p = eq(
			prop("patient", "owner_id"),
			userField("commcare_location_id"),
		);
		expect(emitXPath(p, "case-list-filter")).toBe(
			"owner_id = instance('commcaresession')/session/user/data/commcare_location_id",
		);
	});

	it("emits search-input refs against the search-input results instance", () => {
		const p = eq(prop("patient", "name"), input("name_query"));
		expect(emitXPath(p, "case-list-filter")).toBe(
			"name = instance('search-input:results')/input/field[@name='name_query']",
		);
	});
});

describe("emitXPath — logical operators", () => {
	it("emits and(...) joining clauses with ' and '", () => {
		const p = and(
			eq(prop("patient", "status"), literal("open")),
			gt(prop("patient", "age"), literal(18)),
		);
		expect(emitXPath(p, "case-list-filter")).toBe(
			"status = 'open' and age > 18",
		);
	});

	it("emits or(...) joining clauses with ' or '", () => {
		const p = or(
			eq(prop("patient", "status"), literal("open")),
			eq(prop("patient", "status"), literal("active")),
		);
		expect(emitXPath(p, "case-list-filter")).toBe(
			"status = 'open' or status = 'active'",
		);
	});

	it("parenthesizes or-clauses inside an and (precedence)", () => {
		// XPath's `and` binds tighter than `or`. An or-of-clauses nested
		// inside an and must be wrapped in parens to preserve the
		// authored grouping; emitting `(A or B) and C` as `A or B and C`
		// would silently re-associate to `A or (B and C)`. The emitter's
		// parent-precedence threading is what makes this output correct,
		// so the test is the structural lock on that precedence rule.
		const p = and(
			or(
				eq(prop("patient", "status"), literal("open")),
				eq(prop("patient", "status"), literal("active")),
			),
			gt(prop("patient", "age"), literal(18)),
		);
		expect(emitXPath(p, "case-list-filter")).toBe(
			"(status = 'open' or status = 'active') and age > 18",
		);
	});

	it("emits not(...) wrapping its inner with not(...)", () => {
		// `not` is a function call in XPath, not a unary prefix
		// operator, so the wire form is `not(<expr>)` regardless of the
		// inner's precedence — the parens around the inner are the
		// function-call argument list, not an associativity guard.
		const p = not(eq(prop("patient", "status"), literal("closed")));
		expect(emitXPath(p, "case-list-filter")).toBe("not(status = 'closed')");
	});
});

describe("emitXPath — context equivalence", () => {
	// `case-list-filter` and `csql` contexts share every operator
	// emission and quoting rule. They diverge only at the wire-wrapping
	// layer outside this emitter (csql output gets concatenated into a
	// string template; case-list-filter output is dropped into a nodeset
	// directly). A regression that introduced any per-context behavior
	// at the operator layer would silently change one consumer's
	// output, so the equivalence is locked here against a representative
	// predicate that exercises every term variant + every operator
	// kind in this layer.
	it("emits identical output for case-list-filter and csql at the operator layer", () => {
		const p = and(
			or(
				eq(prop("patient", "status"), literal("open")),
				eq(prop("patient", "status"), literal("active")),
			),
			not(
				and(
					gte(prop("patient", "age"), literal(18)),
					lt(prop("patient", "age"), literal(65)),
					neq(prop("patient", "name"), literal("O'Brien")),
					eq(prop("patient", "owner_id"), userField("commcare_location_id")),
					eq(prop("patient", "name"), input("name_query")),
				),
			),
		);
		expect(emitXPath(p, "csql")).toBe(emitXPath(p, "case-list-filter"));
	});
});
