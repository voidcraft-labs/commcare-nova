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
	between,
	dateLiteral,
	eq,
	exists,
	fuzzy,
	gt,
	input,
	isIn,
	isNull,
	literal,
	lt,
	matchAll,
	matchNone,
	missing,
	not,
	or,
	prop,
	subcasePath,
	timeLiteral,
	userField,
	whenInput,
	within,
} from "../builders";
import { checkPredicate } from "../typeChecker";

// Single fixture reused across every test. Includes one property of
// each data-type family exercised by the type-rule matrix: text
// (unordered), int (ordered numeric), decimal (numeric promotion
// counterpart), date / datetime / time (three temporal kinds — used to
// verify they don't widen across each other and to exercise each
// ordered-temporal arm of `ORDERED_TYPES`), single_select and
// multi_select (string-coerced, with options — covers both arms of the
// fuzzy text-shaped allow-list and the select-to-text widening).
const PATIENT: CaseType = {
	name: "patient",
	properties: [
		{ name: "name", label: "Name", data_type: "text" },
		{ name: "age", label: "Age", data_type: "int" },
		{ name: "weight_kg", label: "Weight", data_type: "decimal" },
		{ name: "dob", label: "DOB", data_type: "date" },
		{ name: "last_seen", label: "Last seen", data_type: "datetime" },
		{
			name: "appointment_time",
			label: "Appointment time",
			data_type: "time",
		},
		{
			name: "status",
			label: "Status",
			data_type: "single_select",
			options: [
				{ value: "open", label: "Open" },
				{ value: "closed", label: "Closed" },
			],
		},
		{
			name: "tags",
			label: "Tags",
			data_type: "multi_select",
			options: [
				{ value: "vip", label: "VIP" },
				{ value: "urgent", label: "Urgent" },
			],
		},
	],
};

// Default context — no declared search inputs. Tests that exercise
// input-ref behavior shadow `knownInputs` locally so the default fixture
// stays readable.
const ctx = {
	caseTypes: [PATIENT],
	knownInputs: [],
};

// Geopoint-extended fixture used by the within-distance describe block.
// The base PATIENT fixture omits a geopoint property because the
// comparison-operator tests don't exercise geo, and adding one to the
// shared fixture would force every comparison test to acknowledge it.
// `ctxWithGeo` derives from `ctx` so the within-distance tests share
// the rest of the property set without divergence from the base.
const ctxWithGeo = {
	...ctx,
	caseTypes: [
		{
			...PATIENT,
			properties: [
				...PATIENT.properties,
				{
					name: "location",
					label: "Location",
					data_type: "geopoint" as const,
				},
			],
		},
	],
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

	// The ordered-types check is `!leftOrdered || !rightOrdered`. The
	// previous test's left operand is text and short-circuits the `||`
	// before the right side is evaluated; pinning the right-side branch
	// requires an int (ordered) left operand and a text (unordered) right
	// operand. Without this test, a regression that dropped the
	// `!rightOrdered` half of the conjunction would slip through.
	it("rejects gt with text on the right side (right-side ordered check)", () => {
		const p = gt(prop("patient", "age"), literal("M"));
		const result = checkPredicate(p, ctx);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.errors[0].message).toMatch(/not ordered/i);
		}
	});

	it("accepts lt on date with a typed dateLiteral", () => {
		const p = lt(prop("patient", "dob"), dateLiteral("2000-01-01"));
		expect(checkPredicate(p, ctx).ok).toBe(true);
	});

	// Exercises the `time` arm of `ORDERED_TYPES`. Without this, a
	// regression that special-cased `time` (e.g. dropped it from the
	// ordered set or mistyped a typed-literal builder) would not fail any
	// existing test — the `date` and `datetime` arms are independently
	// covered.
	it("accepts lt on time with a typed timeLiteral", () => {
		const p = lt(prop("patient", "appointment_time"), timeLiteral("12:00:00"));
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
			knownInputs: [{ name: "min_age", data_type: "int" as const }],
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

	// `or` shares the multi-clause path convention with `and`; pinning
	// the `["or", N]` shape on a non-zero index locks both halves of the
	// convention — the operator-name segment and the array index — for
	// the second multi-clause arm. The failing clause is at index 1, so
	// a regression that mis-indexed (e.g. always emitted 0) would be
	// visible here.
	it("propagates errors from inside or(...) with index-segmented paths", () => {
		const goodComparison = eq(prop("patient", "name"), literal("Alice"));
		const badComparison = eq(prop("patient", "age"), literal("forty-two"));
		const wrapped = or(goodComparison, badComparison);
		const result = checkPredicate(wrapped, ctx);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.errors[0].path).toEqual(["or", 1]);
			expect(result.errors[0].message).toMatch(/type mismatch/i);
		}
	});

	// `when-input-present` recurses into its wrapped clause under the
	// unary-wrapper convention `[operator-name, "clause"]`. Pinning the
	// path here parallels the `not` test above and locks the second of
	// the two unary wrappers.
	it("propagates errors from inside when-input-present's clause", () => {
		const ctxWithInput = {
			...ctx,
			knownInputs: [{ name: "phone" }],
		};
		const p = whenInput(
			input("phone"),
			eq(prop("patient", "age"), literal("forty-two")),
		);
		const result = checkPredicate(p, ctxWithInput);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.errors[0].path).toEqual(["when-input-present", "clause"]);
			expect(result.errors[0].message).toMatch(/type mismatch/i);
		}
	});

	// `when-input-present`'s trigger input must itself be declared in
	// `ctx.knownInputs`. Without this check, an undeclared trigger
	// silently passes — the wrapped clause type-checks fine, the
	// trigger never resolves at runtime, and the predicate becomes a
	// permanent no-op. The error path mirrors the wrapped-clause
	// convention but identifies the operator's `input` slot rather
	// than its `clause` slot.
	it("rejects when-input-present with an undeclared trigger input", () => {
		const p = whenInput(
			input("undeclared"),
			eq(prop("patient", "name"), literal("Alice")),
		);
		const result = checkPredicate(p, ctx);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.errors[0].path).toEqual(["when-input-present", "input"]);
			expect(result.errors[0].message).toMatch(/unknown search input/i);
		}
	});
});

describe("checkPredicate — operand resolution on in / within-distance / fuzzy", () => {
	// `in`, `within-distance`, and `fuzzy` resolve their term operands
	// uniformly with comparison operators so unknown-property /
	// unknown-case-type / unknown-input errors surface the same way no
	// matter which operator the bad term sits under. The per-operator
	// semantic checks (membership-value compatibility on `in`, geopoint-
	// property requirement on `within-distance`, text-property
	// requirement on `fuzzy`) are separate concerns and not covered
	// here.
	it("rejects in(...) with an unknown property reference", () => {
		const p = isIn(prop("patient", "bogus"), literal("x"));
		const result = checkPredicate(p, ctx);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.errors[0].path).toEqual(["left"]);
			expect(result.errors[0].message).toMatch(/unknown property/i);
		}
	});

	// `within-distance` carries two term operands (`property` and
	// `center`). Pinning the path on each lets the editor highlight
	// either operand independently, and the multi-error count locks the
	// "errors accumulate across operands" contract.
	it("rejects within-distance(...) with an unknown property and unknown input", () => {
		const p = within(
			prop("alien_type", "loc"),
			input("undeclared"),
			50,
			"miles",
		);
		const result = checkPredicate(p, ctx);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.errors).toHaveLength(2);
			expect(result.errors.map((e) => e.path)).toEqual([
				["property"],
				["center"],
			]);
		}
	});

	it("rejects fuzzy(...) with an unknown property reference", () => {
		const p = fuzzy(prop("patient", "bogus"), "alice");
		const result = checkPredicate(p, ctx);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.errors[0].path).toEqual(["property"]);
			expect(result.errors[0].message).toMatch(/unknown property/i);
		}
	});
});

describe("checkPredicate — in operator membership compatibility", () => {
	// `in` requires every literal in `values` to be type-compatible with
	// `left`'s resolved type. The check reuses the same `typesCompatible`
	// table that comparison operators use, so the widenings (numeric
	// promotion, select-to-text, null-as-universal) carry over and
	// authors don't have to relearn the rule per operator.

	it("accepts isIn with type-compatible string literals on a single_select property", () => {
		const p = isIn(
			prop("patient", "status"),
			literal("open"),
			literal("closed"),
		);
		expect(checkPredicate(p, ctx).ok).toBe(true);
	});

	it("accepts isIn with int literals on an int property", () => {
		const p = isIn(prop("patient", "age"), literal(18), literal(21));
		expect(checkPredicate(p, ctx).ok).toBe(true);
	});

	// The first literal mismatches (string against int); the second
	// matches. The error path identifies the offending value's index so
	// the editor highlights the bad chip without flagging the whole
	// `in(...)` card. Pinning the index also locks the convention that
	// one error per offending value accumulates rather than a single
	// "first-bad" error short-circuiting the rest.
	it("rejects isIn when a literal's type doesn't match the property", () => {
		const p = isIn(prop("patient", "age"), literal("eighteen"), literal(42));
		const result = checkPredicate(p, ctx);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.errors).toHaveLength(1);
			expect(result.errors[0].path).toEqual(["values", 0]);
			expect(result.errors[0].message).toMatch(/type mismatch/i);
		}
	});

	// Null-as-universal carries over from comparison: a `null` literal
	// in the values list is the structural is-unset filter and must
	// compare-compatible against every property type. Without this,
	// authors writing `isIn(prop, [literal(null), literal("active")])`
	// to express "unset OR active" would see a spurious mismatch.
	it("accepts a null literal in the values list against a typed property", () => {
		const p = isIn(prop("patient", "age"), literal(null), literal(42));
		expect(checkPredicate(p, ctx).ok).toBe(true);
	});
});

describe("checkPredicate — within-distance geopoint requirement", () => {
	// `within-distance` resolves to CCHQ's `case_property_geo_distance`
	// (corehq/apps/es/case_search.py:386), which queries the
	// `PROPERTY_GEOPOINT_VALUE` field — only properties stored as a
	// geopoint participate. The center may be a wire-form coordinate
	// string (`"lat lon altitude accuracy"` per
	// corehq/apps/case_search/xpath_functions/query_functions.py:60,
	// where CCHQ parses the center via `GeoPoint.from_string(...,
	// flexible=True)`) or a typed-geopoint search input, so the
	// allow-list for the center slot is `geopoint | text`.

	it("accepts within-distance with a geopoint property and a text-literal center", () => {
		const p = within(
			prop("patient", "location"),
			literal("40.7 -74.0 0 0"),
			50,
			"miles",
		);
		expect(checkPredicate(p, ctxWithGeo).ok).toBe(true);
	});

	it("accepts within-distance with a geopoint property and a typed-geopoint search input as center", () => {
		const ctxWithGeoInput = {
			...ctxWithGeo,
			knownInputs: [{ name: "user_loc", data_type: "geopoint" as const }],
		};
		const p = within(
			prop("patient", "location"),
			input("user_loc"),
			50,
			"miles",
		);
		expect(checkPredicate(p, ctxWithGeoInput).ok).toBe(true);
	});

	// Property-side rejection: a non-geopoint property cannot back the
	// geo-distance query. The error path identifies the property slot
	// so the editor highlights the operand card directly. The operator
	// resolves the term first (no unknown-property error here — `name`
	// exists), then the semantic check rejects the type mismatch.
	it("rejects within-distance when the property is not geopoint", () => {
		const p = within(
			prop("patient", "name"),
			literal("40.7 -74.0 0 0"),
			50,
			"miles",
		);
		const result = checkPredicate(p, ctx);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.errors).toHaveLength(1);
			expect(result.errors[0].path).toEqual(["property"]);
			expect(result.errors[0].message).toMatch(/geopoint/i);
		}
	});

	// Center-side rejection: a numeric literal isn't a wire-form
	// coordinate string and isn't a geopoint, so the center slot's
	// allow-list rejects it. Property-side stays valid (geopoint), so
	// only the center slot emits an error and the path identifies it
	// independently.
	it("rejects within-distance when the center isn't geopoint or text", () => {
		const p = within(prop("patient", "location"), literal(42), 50, "miles");
		const result = checkPredicate(p, ctxWithGeo);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.errors).toHaveLength(1);
			expect(result.errors[0].path).toEqual(["center"]);
			expect(result.errors[0].message).toMatch(/geopoint|text/i);
		}
	});
});

describe("checkPredicate — fuzzy text-shape requirement", () => {
	// CCHQ's `fuzzy_match` resolves to
	// `case_property_query(..., fuzzy=True)` (corehq/apps/es/case_search.py:237),
	// which dispatches Elasticsearch's `queries.fuzzy(value, PROPERTY_VALUE,
	// ...)` against the property's stored string value. CommCare's wire
	// layer accepts the call against any property, but fuzzy matching
	// against a non-text shape (an int, a date) has no useful semantics
	// — the edit-distance metric is defined on character strings, not
	// on numeric or temporal values. The Nova type checker rejects
	// non-text-shaped properties as a UX policy so the author can't
	// author a predicate that would compile but never produce a useful
	// match. `single_select` and `multi_select` are stored as text
	// under the hood (the schema layer enforces the enum constraint via
	// `jsonSchema.ts`, not at the wire), so they're accepted alongside
	// `text`.

	it("accepts fuzzy on a text property", () => {
		const p = fuzzy(prop("patient", "name"), "alice");
		expect(checkPredicate(p, ctx).ok).toBe(true);
	});

	it("accepts fuzzy on a single_select property", () => {
		const p = fuzzy(prop("patient", "status"), "ope");
		expect(checkPredicate(p, ctx).ok).toBe(true);
	});

	// `multi_select` is stored as text and structurally indistinguishable
	// from `single_select` at the wire — pinning both arms of the
	// text-shaped allow-list locks the rule against a regression that
	// dropped one without breaking the other.
	it("accepts fuzzy on a multi_select property", () => {
		const p = fuzzy(prop("patient", "tags"), "vip");
		expect(checkPredicate(p, ctx).ok).toBe(true);
	});

	// Parameterized rejection across every non-text-shaped data type the
	// blueprint can declare (excluding `geopoint`, which lives on the
	// `ctxWithGeo` fixture and is exercised separately below). Without
	// this table, a regression that loosened the allow-list to "anything
	// except numeric" would slip through — only the int and geopoint
	// arms would fail. The table closes that gap by iterating the full
	// rejected set; adding a new non-text data type to the blueprint
	// later requires extending this list as the visible signal that the
	// fuzzy rule needs an explicit decision for the new type.
	it.each([
		{ propName: "age", dataType: "int" },
		{ propName: "weight_kg", dataType: "decimal" },
		{ propName: "dob", dataType: "date" },
		{ propName: "last_seen", dataType: "datetime" },
		{ propName: "appointment_time", dataType: "time" },
	] as const)("rejects fuzzy on a $dataType property", ({ propName }) => {
		const p = fuzzy(prop("patient", propName), "alice");
		const result = checkPredicate(p, ctx);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.errors).toHaveLength(1);
			expect(result.errors[0].path).toEqual(["property"]);
			expect(result.errors[0].message).toMatch(/text/i);
		}
	});

	// `geopoint` lives on the `ctxWithGeo` fixture (the base PATIENT
	// fixture deliberately omits a geopoint to keep the comparison-rule
	// matrix unaffected by it). Tested separately rather than in the
	// table above so the fixture switch is visible in the test name.
	// A fuzzy match against the wire-form `"lat lon"` coordinate string
	// is meaningless — the edit-distance metric isn't defined on a
	// structured pair of floats. Pinning the rejection here locks the
	// rule against a regression that widened the allow-list to "anything
	// stored as text on the wire."
	it("rejects fuzzy on a geopoint property", () => {
		const p = fuzzy(prop("patient", "location"), "40.7 -74.0");
		const result = checkPredicate(p, ctxWithGeo);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.errors).toHaveLength(1);
			expect(result.errors[0].path).toEqual(["property"]);
			expect(result.errors[0].message).toMatch(/text/i);
		}
	});
});

// `match-all` and `match-none` are nullary discriminator-only
// sentinels — by construction well-typed, no operands and no
// operator-specific semantic rule. The walker accepts them silently
// and recurses no further. The composition test is the load-bearing
// one: a sentinel embedded inside `and(...)` must not crash the walk
// when the recursion reaches the sentinel arm. Without the dedicated
// arm in `walk`, the grouped throwing fall-through would turn every
// composed predicate that includes a sentinel into a runtime crash.
describe("checkPredicate — sentinel predicates", () => {
	it("accepts match-all standalone", () => {
		expect(checkPredicate(matchAll(), ctx).ok).toBe(true);
	});

	it("accepts match-none standalone", () => {
		expect(checkPredicate(matchNone(), ctx).ok).toBe(true);
	});

	it("accepts match-all composed inside an and", () => {
		// The composition path is the bug-prevention case: the walker
		// recurses through `and` into the sentinel arm, so a throwing
		// arm here would surface as a crash on every composed
		// predicate that includes the identity element.
		const p = and(matchAll(), eq(prop("patient", "name"), literal("Alice")));
		expect(checkPredicate(p, ctx).ok).toBe(true);
	});

	it("accepts match-none composed inside an or", () => {
		// Symmetric to the and-with-match-all case: the absorbing
		// element appears as a clause inside `or`, the walker recurses
		// through `or` into the sentinel arm. Pinning the symmetric
		// case keeps the per-sentinel handling explicit rather than
		// implied by the match-all test.
		const p = or(matchNone(), eq(prop("patient", "name"), literal("Alice")));
		expect(checkPredicate(p, ctx).ok).toBe(true);
	});

	it("accepts match-all wrapped in not", () => {
		// `not(matchAll)` is a recursion through the unary wrapper —
		// the walker re-enters `walk` on the wrapped clause, which
		// dispatches into the sentinel arm. Without the dedicated
		// sentinel arm, this would crash inside `not`.
		const p = not(matchAll());
		expect(checkPredicate(p, ctx).ok).toBe(true);
	});
});

// The dispatch arm in `walk` throws on `is-null` / `between` /
// `exists` / `missing` — these four kinds have no dedicated semantic
// rules in this checker, and throwing prevents them from silently
// producing false-positive type-clean verdicts on unchecked
// predicates (the failure mode the checker itself exists to prevent).
// The error-message regex is matched loosely against the kind name
// so phrasing changes around the kind don't trip the lock.
describe("checkPredicate — kinds without dedicated semantic rules throw", () => {
	it("throws on is-null", () => {
		const p = isNull(prop("patient", "name"));
		expect(() => checkPredicate(p, ctx)).toThrow(/no rules for kind 'is-null'/);
	});

	it("throws on between", () => {
		const p = between(prop("patient", "age"), { lower: literal(18) });
		expect(() => checkPredicate(p, ctx)).toThrow(/no rules for kind 'between'/);
	});

	it("throws on exists", () => {
		const p = exists(subcasePath("parent"));
		expect(() => checkPredicate(p, ctx)).toThrow(/no rules for kind 'exists'/);
	});

	it("throws on missing", () => {
		const p = missing(subcasePath("parent"));
		expect(() => checkPredicate(p, ctx)).toThrow(/no rules for kind 'missing'/);
	});

	it("throws when a kind without dedicated rules is composed inside a logical wrapper", () => {
		// The JSDoc on `checkPredicate` documents this case explicitly.
		// The walker recurses through `and` / `or` / `not` /
		// `when-input-present` before dispatching, so a kind without
		// dedicated rules nested inside a wrapper triggers the same
		// throw as the standalone case. Pinning the canonical
		// `and(eq, isNull)` shape locks the wrapper-recursion contract;
		// pinning every wrapper × kind pair would be overkill, but the
		// shape called out in the JSDoc is load-bearing.
		const p = and(
			eq(prop("patient", "name"), literal("Alice")),
			isNull(prop("patient", "name")),
		);
		expect(() => checkPredicate(p, ctx)).toThrow(/no rules for kind 'is-null'/);
	});
});
