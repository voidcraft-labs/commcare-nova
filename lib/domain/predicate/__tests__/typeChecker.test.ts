// lib/domain/predicate/__tests__/typeChecker.test.ts
//
// Acceptance tests for the schema-driven predicate type checker. Each
// `it` pins one operand-type rule by constructing a small predicate via
// the builders and asserting the type checker's verdict on it. The
// fixtures double as documentation for the rules themselves — changing
// a test's expected verdict or message regex is the deliberate signal
// that the rule changed at the code layer.
//
// Coverage spans three concentric layers: (1) comparison-operator
// rules (resolution, ordering, compatibility), (2) recursion through
// logical wrappers (errors deep inside `and` / `or` / `not` /
// `when-input-present` still surface), (3) special-case widenings
// (numeric promotion both directions, select-to-text, null-as-universal,
// user-context refs, boolean literals).

import { describe, expect, it } from "vitest";
import type { CaseType } from "@/lib/domain";
import {
	and,
	dateLiteral,
	eq,
	gt,
	input,
	literal,
	lt,
	not,
	prop,
	userField,
} from "../builders";
import { checkPredicate } from "../typeChecker";

// Single fixture reused across every test. Includes one property of
// each data-type family exercised by the comparison-rule matrix: text
// (unordered), int (ordered numeric), decimal (numeric promotion
// counterpart), date and datetime (two date kinds — used to verify
// they don't widen across each other), and single_select (string-
// coerced, with options).
const PATIENT: CaseType = {
	name: "patient",
	properties: [
		{ name: "name", label: "Name", data_type: "text" },
		{ name: "age", label: "Age", data_type: "int" },
		{ name: "weight_kg", label: "Weight", data_type: "decimal" },
		{ name: "dob", label: "DOB", data_type: "date" },
		{ name: "last_seen", label: "Last Seen", data_type: "datetime" },
		{
			name: "status",
			label: "Status",
			data_type: "single_select",
			options: [
				{ value: "open", label: "Open" },
				{ value: "closed", label: "Closed" },
			],
		},
	],
};

// Default context — no declared search inputs. Tests that exercise
// input-ref behavior shadow `knownInputs` locally so the default fixture
// stays readable.
const ctx = {
	caseTypes: [PATIENT],
	currentCaseType: "patient",
	knownInputs: [],
};

describe("checkPredicate — comparison operators", () => {
	it("accepts int = int", () => {
		const p = eq(prop("patient", "age"), literal(42));
		const result = checkPredicate(p, ctx);
		expect(result.ok).toBe(true);
	});

	it("accepts text = text", () => {
		const p = eq(prop("patient", "name"), literal("Alice"));
		const result = checkPredicate(p, ctx);
		expect(result.ok).toBe(true);
	});

	it("rejects int = string-literal mismatch", () => {
		const p = eq(prop("patient", "age"), literal("forty-two"));
		const result = checkPredicate(p, ctx);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.errors[0].message).toMatch(/type mismatch/i);
		}
	});

	it("accepts gt on int", () => {
		const p = gt(prop("patient", "age"), literal(18));
		expect(checkPredicate(p, ctx).ok).toBe(true);
	});

	it("rejects gt on text (strings aren't ordered)", () => {
		const p = gt(prop("patient", "name"), literal("M"));
		const result = checkPredicate(p, ctx);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.errors[0].message).toMatch(/not ordered/i);
			// Pin the path-tracking contract for the comparison-level
			// verdict: ordered-types rejection attaches to the predicate's
			// own path (not the operand's), so a top-level `gt(...)` with
			// no parent emits an empty-path error. The path shape is
			// architecturally meaningful — the editor highlights the
			// comparison card itself, not one of its operand cards.
			expect(result.errors[0].path).toEqual([]);
		}
	});

	it("accepts lt on date with a typed dateLiteral", () => {
		const p = lt(prop("patient", "dob"), dateLiteral("2000-01-01"));
		expect(checkPredicate(p, ctx).ok).toBe(true);
	});

	it("rejects an unknown property reference", () => {
		const p = eq(prop("patient", "bogus"), literal("x"));
		const result = checkPredicate(p, ctx);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.errors[0].message).toMatch(/unknown property/i);
			// Operand-resolution errors carry the operand's own path so
			// the editor highlights the failing operand card. Top-level
			// `eq`'s left operand resolves at `["left"]`.
			expect(result.errors[0].path).toEqual(["left"]);
		}
	});

	it("rejects an unknown case type reference", () => {
		const p = eq(prop("alien_type", "x"), literal("y"));
		const result = checkPredicate(p, ctx);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.errors[0].message).toMatch(/unknown case type/i);
		}
	});

	it("accepts input ref against int prop when input is declared", () => {
		const ctxWithInput = {
			...ctx,
			knownInputs: [
				{ kind: "input", name: "min_age", data_type: "int" } as const,
			],
		};
		const p = gt(prop("patient", "age"), input("min_age"));
		expect(checkPredicate(p, ctxWithInput).ok).toBe(true);
	});

	it("rejects input ref when input isn't declared", () => {
		const p = gt(prop("patient", "age"), input("undeclared"));
		const result = checkPredicate(p, ctx);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.errors[0].message).toMatch(/unknown search input/i);
		}
	});

	// Multi-error accumulation. The walker collects errors across the
	// whole predicate rather than short-circuiting on the first
	// failure, so an `eq` with two unresolvable operands surfaces both
	// problems in one pass. The editor relies on this behavior to
	// highlight every failing card simultaneously.
	it("accumulates errors from both operands when both fail to resolve", () => {
		const p = eq(prop("patient", "bogus"), input("undeclared"));
		const result = checkPredicate(p, ctx);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.errors).toHaveLength(2);
			expect(result.errors[0].path).toEqual(["left"]);
			expect(result.errors[1].path).toEqual(["right"]);
		}
	});

	// Numeric-promotion symmetry. The widening rule between int and
	// decimal applies regardless of which side the int- vs
	// decimal-typed value sits on; restating both directions guards
	// against a one-sided regression in `typesCompatible`.
	it("accepts int prop = decimal literal (int prop, decimal value)", () => {
		const p = eq(prop("patient", "age"), literal(3.14));
		expect(checkPredicate(p, ctx).ok).toBe(true);
	});

	it("accepts decimal prop = int literal (decimal prop, int value)", () => {
		const p = eq(prop("patient", "weight_kg"), literal(70));
		expect(checkPredicate(p, ctx).ok).toBe(true);
	});

	// Date-kind isolation. `date`, `datetime`, and `time` are all
	// "ordered temporal" types but each has distinct wire semantics —
	// a `date` and a `datetime` can't be compared without lossy
	// coercion, so the type checker rejects the comparison rather
	// than papering over the ambiguity.
	it("rejects eq across distinct date kinds (date prop = datetime prop)", () => {
		const p = eq(prop("patient", "dob"), prop("patient", "last_seen"));
		const result = checkPredicate(p, ctx);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.errors[0].message).toMatch(/type mismatch/i);
		}
	});

	// User-context refs always resolve to text (see `resolveTermType`
	// in typeChecker.ts for the CCHQ source citation). Comparing a
	// text-typed property against a user field is the canonical
	// shape — verifying it passes locks the resolution rule.
	it("accepts text prop = user field (both resolve to text)", () => {
		const p = eq(prop("patient", "name"), userField("display_name"));
		expect(checkPredicate(p, ctx).ok).toBe(true);
	});

	// Boolean literals resolve to text, so a comparison against a
	// text-typed property is well-typed. The same literal compared
	// against a numeric or date property would fail the compatibility
	// check; this test pins only the well-typed direction.
	it("accepts text prop = boolean literal (boolean resolves to text)", () => {
		const p = eq(prop("patient", "name"), literal(true));
		expect(checkPredicate(p, ctx).ok).toBe(true);
	});

	// Null-as-universal. `null` is the structural sentinel for "this
	// property is unset" and must be comparable against any declared
	// property type — otherwise authors couldn't write the is-unset
	// filter without inventing per-type null-equivalents.
	it("accepts null literal compared against any typed property (is-unset filter)", () => {
		const p = eq(prop("patient", "age"), literal(null));
		expect(checkPredicate(p, ctx).ok).toBe(true);
	});
});

describe("checkPredicate — recursion through logical wrappers", () => {
	// The walker descends into every logical wrapper so a comparison
	// violation buried inside an `and` / `or` / `not` /
	// `when-input-present` still surfaces with a precise path. Without
	// this, an author could nest a broken comparison under a logical
	// wrapper and the type checker would silently approve the entire
	// predicate.
	it("flags errors inside logical wrappers (and/or/not)", () => {
		const badComparison = eq(prop("patient", "age"), literal("forty-two"));
		const wrapped = and(
			badComparison,
			eq(prop("patient", "name"), literal("Alice")),
		);
		const result = checkPredicate(wrapped, ctx);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.errors[0].message).toMatch(/type mismatch/i);
			// Path convention: `and` wrapper, then array index of the
			// failing clause. The kind segment disambiguates a clause
			// inside `and(...)` from a clause inside a sibling `or(...)`.
			expect(result.errors[0].path).toEqual(["and", 0]);
		}
	});

	// `not` uses the unary-wrapper path convention (`[operator-name,
	// field-name]`), parallel to `when-input-present`. Pinning the
	// `["not", "clause"]` shape locks the convention against a regression
	// to the old operator-name-only form (`["not"]`), which would have
	// made `not` the only wrapping operator emitting a path that didn't
	// also identify which slot inside the operator the error came from.
	it("propagates errors from inside not(...) with a clause-segmented path", () => {
		const p = not(eq(prop("patient", "age"), literal("forty-two")));
		const result = checkPredicate(p, ctx);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.errors[0].message).toMatch(/type mismatch/i);
			expect(result.errors[0].path).toEqual(["not", "clause"]);
		}
	});
});
