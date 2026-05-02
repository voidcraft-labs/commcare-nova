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
// session-user / session-context refs, boolean literals).

import { describe, expect, it } from "vitest";
import type { CaseType } from "@/lib/domain";
import {
	ancestorPath,
	and,
	anyRelationPath,
	arith,
	between,
	coalesce,
	concat,
	count,
	dateAdd,
	dateCoerce,
	dateLiteral,
	datetimeCoerce,
	double,
	eq,
	exists,
	formatDate,
	gt,
	ifExpr,
	input,
	isBlank,
	isIn,
	isNull,
	literal,
	lt,
	match,
	matchAll,
	matchNone,
	missing,
	multiSelectAll,
	multiSelectAny,
	not,
	now,
	or,
	prop,
	relationStep,
	selfPath,
	sessionContext,
	sessionUser,
	subcasePath,
	switchCase,
	switchExpr,
	term,
	timeLiteral,
	today,
	unwrapList,
	whenInput,
	within,
} from "../builders";
import { checkExpression, checkPredicate } from "../typeChecker";
import { MATCH_MODES, MULTI_SELECT_QUANTIFIERS } from "../types";

// Single fixture reused across every test. Includes one property of
// each data-type family exercised by the type-rule matrix: text
// (unordered), int (ordered numeric), decimal (numeric promotion
// counterpart), date / datetime / time (three temporal kinds — used to
// verify they don't widen across each other and to exercise each
// ordered-temporal arm of `ORDERED_TYPES`), single_select and
// multi_select (string-coerced, with options — covers both arms of the
// match text-shaped allow-list and the select-to-text widening).
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

	// Session-user refs (open-namespace `/session/user/data/<field>`)
	// always resolve to text — `addUserProperties` at
	// `commcare-core/src/main/java/org/commcare/session/SessionInstanceBuilder.java`
	// writes a Hashtable's string values, so every custom user-data
	// field comes back as a string regardless of project semantics.
	// Comparing a text-typed property against a session-user reference
	// is the canonical shape; pinning it locks the resolution rule.
	it("accepts text prop = session-user field (both resolve to text)", () => {
		const p = eq(prop("patient", "name"), sessionUser("display_name"));
		expect(checkPredicate(p, ctx).ok).toBe(true);
	});

	// Session-context refs (closed-enum `/session/context/<field>`)
	// also resolve to text for v1's four-field set — `userid` /
	// `username` / `deviceid` / `appversion` are all wire strings at
	// `/session/context/<field>`. The type checker's job here is to
	// resolve the term's wire type, not to police semantic-version
	// gating semantics on `appversion` (lex compare disagrees with
	// semver once digit counts diverge — see the `session-context`
	// arm comment in `typeChecker.ts` for the detail). A comparison
	// against a text-typed property is well-typed under the
	// text-shaped rule regardless.
	it("accepts text prop = session-context field (both resolve to text)", () => {
		const p = eq(prop("patient", "name"), sessionContext("username"));
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

describe("checkPredicate — operand resolution on in / within-distance / match / multi-select-contains", () => {
	// `in`, `within-distance`, `match`, and `multi-select-contains`
	// resolve their term operands uniformly with comparison operators so
	// unknown-property / unknown-case-type / unknown-input errors surface
	// the same way no matter which operator the bad term sits under. The
	// per-operator semantic checks (membership-value compatibility on
	// `in`, geopoint-property requirement on `within-distance`, text-
	// property requirement on `match`, multi_select-only requirement on
	// `multi-select-contains`) are separate concerns and not covered here.
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

	it("rejects match(...) with an unknown property reference", () => {
		const p = match(prop("patient", "bogus"), "alice", "fuzzy");
		const result = checkPredicate(p, ctx);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.errors[0].path).toEqual(["property"]);
			expect(result.errors[0].message).toMatch(/unknown property/i);
		}
	});

	it("rejects multi-select-contains(...) with an unknown property reference", () => {
		const p = multiSelectAny(prop("patient", "bogus"), literal("vip"));
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

describe("checkPredicate — match property-shape requirement", () => {
	// `match` carries a `mode` discriminator across four CCHQ wire forms
	// — `fuzzy-match`, `phonetic-match`, `fuzzy-date`, `starts-with` —
	// each landing on a different CCHQ ES path. Three of the four modes
	// share a text-shaped allow-list (text / single_select /
	// multi_select); the fourth, `fuzzy-date`, widens to additionally
	// accept date / datetime. The branching rationale lives on the
	// allow-list constants in `typeChecker.ts`; tests below pin the
	// per-mode acceptance / rejection matrix.

	// Three text-shaped accepts × three text-shaped property kinds
	// (text / single_select / multi_select). `fuzzy-date` is exercised
	// separately below because its allow-list is wider.
	const TEXT_SHAPED_MATCH_MODES = ["fuzzy", "phonetic", "starts-with"] as const;

	it.each(
		TEXT_SHAPED_MATCH_MODES,
	)("accepts match on a text property (mode: %s)", (mode) => {
		const p = match(prop("patient", "name"), "alice", mode);
		expect(checkPredicate(p, ctx).ok).toBe(true);
	});

	it.each(
		TEXT_SHAPED_MATCH_MODES,
	)("accepts match on a single_select property (mode: %s)", (mode) => {
		const p = match(prop("patient", "status"), "ope", mode);
		expect(checkPredicate(p, ctx).ok).toBe(true);
	});

	// `multi_select` is stored as text and structurally indistinguishable
	// from `single_select` at the wire — pinning both arms of the
	// text-shaped allow-list locks the rule against a regression that
	// dropped one without breaking the other.
	it.each(
		TEXT_SHAPED_MATCH_MODES,
	)("accepts match on a multi_select property (mode: %s)", (mode) => {
		const p = match(prop("patient", "tags"), "vip", mode);
		expect(checkPredicate(p, ctx).ok).toBe(true);
	});

	// `fuzzy-date` widens the allow-list to additionally accept date /
	// datetime properties. CCHQ's `fuzzy_date` (verified at
	// `commcare-hq/corehq/apps/case_search/xpath_functions/query_functions.py:101-113`)
	// is specifically designed to recover from transposed YYYY-MM-DD
	// inputs, so authors targeting a `date`-typed property must be able
	// to use the operator without re-declaring the property as text —
	// otherwise the typed-property model the blueprint already
	// establishes (typed `dateLiteral` / `datetimeLiteral` builders)
	// breaks down at the predicate layer. The text-shaped trio also
	// passes `fuzzy-date` because the underlying ES match runs against
	// the shared `PROPERTY_VALUE` text field for every property type.
	it("accepts fuzzy-date match on a date property", () => {
		const p = match(prop("patient", "dob"), "2024-12-03", "fuzzy-date");
		expect(checkPredicate(p, ctx).ok).toBe(true);
	});

	it("accepts fuzzy-date match on a datetime property", () => {
		const p = match(prop("patient", "last_seen"), "2024-12-03", "fuzzy-date");
		expect(checkPredicate(p, ctx).ok).toBe(true);
	});

	it.each([
		"name",
		"status",
		"tags",
	] as const)("accepts fuzzy-date match on a text-shaped property (%s)", (propName) => {
		const p = match(prop("patient", propName), "2024-12-03", "fuzzy-date");
		expect(checkPredicate(p, ctx).ok).toBe(true);
	});

	// Parameterized rejection across every property type that does NOT
	// pass the text-shaped trio (excluding `geopoint`, which lives on
	// the `ctxWithGeo` fixture and is exercised separately below).
	// `fuzzy-date` is excluded from this rejection pass for `date` /
	// `datetime` because its allow-list widens to include them — the
	// rejection table below carves date / datetime out of `fuzzy-date`'s
	// row while still rejecting them for the other three modes.
	const REJECTED_NON_TEXT_PROPS = [
		{ propName: "age", dataType: "int" },
		{ propName: "weight_kg", dataType: "decimal" },
		{ propName: "dob", dataType: "date" },
		{ propName: "last_seen", dataType: "datetime" },
		{ propName: "appointment_time", dataType: "time" },
	] as const;

	// Helper: a (mode, property) row is rejected unless `fuzzy-date`
	// would accept the date/datetime. Every other combination rejects.
	const isAccepted = (mode: (typeof MATCH_MODES)[number], dataType: string) =>
		mode === "fuzzy-date" && (dataType === "date" || dataType === "datetime");

	it.each(
		REJECTED_NON_TEXT_PROPS.flatMap((prop) =>
			MATCH_MODES.filter((mode) => !isAccepted(mode, prop.dataType)).map(
				(mode) => ({ ...prop, mode }),
			),
		),
	)("rejects match on a $dataType property (mode: $mode)", ({
		propName,
		mode,
	}) => {
		const p = match(prop("patient", propName), "alice", mode);
		const result = checkPredicate(p, ctx);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.errors).toHaveLength(1);
			expect(result.errors[0].path).toEqual(["property"]);
			// Error message names the offending mode and the
			// allow-list contents — both load-bearing for the
			// editor's per-mode highlighting.
			expect(result.errors[0].message).toMatch(new RegExp(`mode='${mode}'`));
		}
	});

	// `geopoint` lives on the `ctxWithGeo` fixture (the base PATIENT
	// fixture deliberately omits a geopoint to keep the comparison-rule
	// matrix unaffected by it). Tested separately rather than in the
	// table above so the fixture switch is visible in the test name.
	// A match against the wire-form `"lat lon"` coordinate string is
	// meaningless — none of the four match metrics is defined on a
	// structured pair of floats. Pinning the rejection here locks the
	// rule against a regression that widened the allow-list to "anything
	// stored as text on the wire." `fuzzy-date` rejects geopoint too —
	// its widening covers date / datetime only.
	it.each(
		MATCH_MODES,
	)("rejects match on a geopoint property (mode: %s)", (mode) => {
		const p = match(prop("patient", "location"), "40.7 -74.0", mode);
		const result = checkPredicate(p, ctxWithGeo);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.errors).toHaveLength(1);
			expect(result.errors[0].path).toEqual(["property"]);
			expect(result.errors[0].message).toMatch(new RegExp(`mode='${mode}'`));
		}
	});
});

describe("checkPredicate — multi-select-contains property requirement", () => {
	// `multi-select-contains` is the typed structural shape for CCHQ's
	// `selected-any` / `selected-all` query functions. The dispatch at
	// `commcare-hq/corehq/apps/case_search/xpath_functions/query_functions.py:46-51`
	// (`_selected_query` calls `case_property_query`) accepts text /
	// single_select / multi_select properties uniformly, but the *Nova*
	// authoring-time policy is stricter: only a multi_select property
	// has the structural notion of "contains" (multi-token storage,
	// per-token containment). Routing single_select or text through
	// `multi-select-contains` is virtually always an authoring bug
	// (e.g. the author meant `match` or `eq`), so the type checker
	// rejects everything but multi_select. Authors who genuinely want
	// "field contains a value" against a non-multi_select property use
	// `match(..., starts-with)` or a comparison.

	it.each(
		MULTI_SELECT_QUANTIFIERS,
	)("accepts multi-select-contains on a multi_select property (quantifier: %s)", (quantifier) => {
		const p =
			quantifier === "any"
				? multiSelectAny(prop("patient", "tags"), literal("vip"))
				: multiSelectAll(prop("patient", "tags"), literal("vip"));
		expect(checkPredicate(p, ctx).ok).toBe(true);
	});

	// Parameterized rejection across every non-multi_select data type
	// (text, single_select, ordered numerics, temporals, geopoint).
	// Without iterating the full set, a regression that loosened the
	// allow-list to "anything text-shaped" (the looser allow-list `match`
	// uses) would slip through — text and single_select would silently
	// pass while int / decimal / date would still fail. The table closes
	// that gap.
	const REJECTED_NON_MULTI_SELECT = [
		{ propName: "name", dataType: "text" },
		{ propName: "status", dataType: "single_select" },
		{ propName: "age", dataType: "int" },
		{ propName: "weight_kg", dataType: "decimal" },
		{ propName: "dob", dataType: "date" },
		{ propName: "last_seen", dataType: "datetime" },
		{ propName: "appointment_time", dataType: "time" },
	] as const;
	it.each(
		REJECTED_NON_MULTI_SELECT,
	)("rejects multi-select-contains on a $dataType property", ({ propName }) => {
		const p = multiSelectAny(prop("patient", propName), literal("x"));
		const result = checkPredicate(p, ctx);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			// Property-rule errors attach to the operator's `property`
			// path, parallel to `match` and `within-distance`.
			expect(result.errors[0].path).toEqual(["property"]);
			expect(result.errors[0].message).toMatch(/multi_select/i);
		}
	});

	it("rejects multi-select-contains on a geopoint property", () => {
		const p = multiSelectAny(
			prop("patient", "location"),
			literal("40.7 -74.0"),
		);
		const result = checkPredicate(p, ctxWithGeo);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.errors[0].path).toEqual(["property"]);
			expect(result.errors[0].message).toMatch(/multi_select/i);
		}
	});

	// Each value in `values` is type-checked against the property's
	// resolved type. The membership-compatibility table reuses
	// `typesCompatible` so the same widenings apply (null-as-universal,
	// select-to-text). Pinning a per-value mismatch locks the per-value
	// path-tracking convention, parallel to `in`.
	it("rejects multi-select-contains when a value's type doesn't match the property", () => {
		const p = multiSelectAny(
			prop("patient", "tags"),
			literal(42), // numeric literal against multi_select (string-coerced)
		);
		const result = checkPredicate(p, ctx);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			// One error, on `values[0]`. Property-side stays valid (the
			// property exists and is multi_select).
			expect(result.errors).toHaveLength(1);
			expect(result.errors[0].path).toEqual(["values", 0]);
			expect(result.errors[0].message).toMatch(/type mismatch/i);
		}
	});

	it("accepts a null literal in the values list (null-as-universal carries over)", () => {
		// Null literals resolve to the internal `_any` sentinel and are
		// compatible with every property type — the same widening that
		// applies to `in` and to comparison operators.
		const p = multiSelectAny(
			prop("patient", "tags"),
			literal(null),
			literal("vip"),
		);
		expect(checkPredicate(p, ctx).ok).toBe(true);
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

// `between` is the structural range predicate — bounded interval on
// `left` with optional lower / upper bounds and per-bound inclusivity
// flags. The type checker enforces three rules:
//   1. `left` must resolve to an ordered type (int / decimal / date /
//      datetime / time) — the same `ORDERED_TYPES` set comparison
//      operators reuse for the `gt` / `gte` / `lt` / `lte` family.
//   2. Each provided bound (`lower` / `upper`) must resolve to a type
//      compatible with `left` — same `typesCompatible` widenings
//      comparison operators use, so numeric promotion / null-as-
//      universal carry over.
//   3. When both bounds are typed-literal Terms and `lower > upper`,
//      the predicate is identically false at every wire target. The
//      schema admits this shape because bounds may be Term refs whose
//      values aren't known at parse time; the checker is the right
//      place to catch the literal-pair case (per the spec's "Range
//      predicate" subsection).
describe("checkPredicate — between operator rules", () => {
	it("accepts between on an int property with int bounds", () => {
		// Canonical positive case: `age` is int, both bounds are int
		// literals, the predicate type-checks cleanly. Pins the happy
		// path through the ordered-type + per-bound resolution +
		// per-bound compatibility cascade.
		const p = between(prop("patient", "age"), {
			lower: literal(18),
			upper: literal(65),
		});
		expect(checkPredicate(p, ctx).ok).toBe(true);
	});

	it("accepts between on a date property with typed dateLiteral bounds", () => {
		// Date kinds are ordered; typed-date literals carry their
		// `data_type` explicitly so the comparator resolves them as
		// `date` rather than the generic JS-string fallback.
		const p = between(prop("patient", "dob"), {
			lower: dateLiteral("2000-01-01"),
			upper: dateLiteral("2024-12-31"),
		});
		expect(checkPredicate(p, ctx).ok).toBe(true);
	});

	it("accepts between with only a lower bound (open-upper interval)", () => {
		// The schema admits the half-open interval shape. The checker
		// resolves the present bound and skips the absent one — pinning
		// the absence-tolerant resolution rule.
		const p = between(prop("patient", "age"), { lower: literal(18) });
		expect(checkPredicate(p, ctx).ok).toBe(true);
	});

	it("accepts between with only an upper bound (open-lower interval)", () => {
		// Symmetric to the lower-only case — locks both halves of the
		// optional-bound resolution against a one-sided regression.
		const p = between(prop("patient", "age"), { upper: literal(65) });
		expect(checkPredicate(p, ctx).ok).toBe(true);
	});

	it("rejects between on a text property (text is not ordered)", () => {
		// Text is intentionally excluded from `ORDERED_TYPES` — locale-
		// dependent string ordering rarely produces meaningful filters,
		// and routing authors to a different operator (`match` /
		// `starts-with`) is the deliberate UX. The error attaches to
		// the predicate's own path (parallel to comparison operators'
		// ordered-type rejection).
		const p = between(prop("patient", "name"), {
			lower: literal("a"),
			upper: literal("m"),
		});
		const result = checkPredicate(p, ctx);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.errors[0].path).toEqual([]);
			expect(result.errors[0].message).toMatch(/ordered|not ordered/i);
		}
	});

	it("rejects between when a bound's type is incompatible with left", () => {
		// `age` is int, the literal `"forty-two"` resolves to text —
		// the per-bound compatibility check rejects with the same
		// "type mismatch" framing comparison operators use, on the
		// failing bound's own path so the editor highlights the
		// offending operand directly.
		const p = between(prop("patient", "age"), {
			lower: literal("forty-two"),
			upper: literal(65),
		});
		const result = checkPredicate(p, ctx);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.errors).toHaveLength(1);
			expect(result.errors[0].path).toEqual(["lower"]);
			expect(result.errors[0].message).toMatch(/type mismatch/i);
		}
	});

	it("rejects between when literal bounds are inverted (lower > upper)", () => {
		// Both bounds are typed-literal Terms with comparable values:
		// `100 > 18`, so the interval `[100, 18]` is empty by
		// construction. The checker rejects with a dedicated message
		// naming the impossibility — the schema admits the shape
		// because bounds may be Term refs whose values aren't known
		// at parse time, but the literal-pair case is statically
		// decidable here.
		const p = between(prop("patient", "age"), {
			lower: literal(100),
			upper: literal(18),
		});
		const result = checkPredicate(p, ctx);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.errors[0].message).toMatch(
				/lower.*greater|inverted|empty/i,
			);
		}
	});

	it("accepts between with mixed numeric promotion (int prop, decimal bounds)", () => {
		// Numeric promotion (`int` ↔ `decimal`) carries over from the
		// comparison checker's compatibility table — locks the rule
		// that bounds reuse `typesCompatible` rather than enforcing
		// strict type identity.
		const p = between(prop("patient", "age"), {
			lower: literal(18.5),
			upper: literal(65.0),
		});
		expect(checkPredicate(p, ctx).ok).toBe(true);
	});

	it("accepts between directly on a decimal property", () => {
		// Decimal is in `ORDERED_TYPES`. Direct decimal-to-decimal bound
		// pairing exercises the path that numeric promotion (above) only
		// reaches transitively — locks the rule that decimal is a
		// first-class ordered type, not just a target for int-promotion.
		const p = between(prop("patient", "weight_kg"), {
			lower: literal(40.0),
			upper: literal(120.0),
		});
		expect(checkPredicate(p, ctx).ok).toBe(true);
	});

	it("accepts between directly on a time property with timeLiteral bounds", () => {
		// Time is in `ORDERED_TYPES` alongside date/datetime. timeLiteral
		// carries `data_type: "time"` so the comparator resolves the
		// bounds as time rather than the generic JS-string fallback.
		const p = between(prop("patient", "appointment_time"), {
			lower: timeLiteral("09:00:00"),
			upper: timeLiteral("17:00:00"),
		});
		expect(checkPredicate(p, ctx).ok).toBe(true);
	});

	it("propagates errors through wrapper recursion (between inside and)", () => {
		// Pins the wrapper-recursion contract: a `between` violation
		// nested inside `and` surfaces with a path that threads the
		// wrapper's `kind` and clause index. Replaces the throw-on-
		// between coverage that the dedicated A5 rule supersedes —
		// the regression target shifts from "throws inside wrappers"
		// to "real rule fires inside wrappers."
		const p = and(
			eq(prop("patient", "name"), literal("Alice")),
			between(prop("patient", "name"), {
				lower: literal("a"),
				upper: literal("m"),
			}),
		);
		const result = checkPredicate(p, ctx);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.errors[0].message).toMatch(/ordered|not ordered/i);
			expect(result.errors[0].path).toEqual(["and", 1]);
		}
	});
});

// `exists` and `missing` are the relational quantifiers — "at least
// one related case along `via` satisfies `where`" / "no related case
// along `via` satisfies `where`." The type checker enforces:
//   1. `via` resolves to a destination case type via `checkRelationPath`
//      (walks `parent_type` for ancestors; reverse-walks for subcase /
//      any-relation). The destination must exist in `ctx.caseTypes`.
//   2. `where` (if present) is type-checked recursively in the
//      destination scope — `prop` references inside `where` resolve
//      against the destination case type, not the originating one.
//   3. `via.kind === "self"` at the top-level (no parent destination
//      to anchor on) is a meaningless self-relation and emits an
//      error; inside a `where` clause `self` is the explicit no-
//      traversal form and routes through to the current scope.
//
// Fixtures below model a small relationship graph: visit → patient →
// household. Visit is a child of patient; patient is a child of
// household. Subcase / any-relation walks reverse the direction.
const HOUSEHOLD: CaseType = {
	name: "household",
	properties: [
		{ name: "region", label: "Region", data_type: "text" },
		{ name: "size", label: "Size", data_type: "int" },
	],
};

const PATIENT_WITH_PARENT: CaseType = {
	...PATIENT,
	parent_type: "household",
};

const VISIT: CaseType = {
	name: "visit",
	properties: [
		{ name: "kind", label: "Kind", data_type: "text" },
		{ name: "completed", label: "Completed", data_type: "text" },
	],
	parent_type: "patient",
};

// Sibling subcase under patient — used to exercise ambiguity rejection
// when both `visit` and `lab_result` carry `parent_type === "patient"`
// and the author hasn't disambiguated via `ofCaseType`.
const LAB_RESULT: CaseType = {
	name: "lab_result",
	properties: [{ name: "value", label: "Value", data_type: "decimal" }],
	parent_type: "patient",
};

const ctxRelations = {
	caseTypes: [HOUSEHOLD, PATIENT_WITH_PARENT, VISIT, LAB_RESULT],
	knownInputs: [],
};

describe("checkPredicate — exists / missing relation-path resolution", () => {
	it("accepts exists with an ancestor walk (single hop) and no where clause", () => {
		// From `patient`, the ancestor walk via `parent` lands on
		// `household` (patient's `parent_type`). No where-clause means
		// the predicate degenerates to "any household ancestor exists,"
		// which is structurally well-typed regardless of household's
		// properties.
		const p = exists(ancestorPath(relationStep("parent")));
		const result = checkPredicate(p, {
			...ctxRelations,
			currentCaseType: "patient",
		});
		expect(result.ok).toBe(true);
	});

	it("accepts exists with an ancestor walk and a destination-scope where clause", () => {
		// From `patient`, walking the parent index reaches `household`;
		// the where-clause filters that destination by `household.region`.
		// The where-clause's `prop` references explicitly name
		// `household` as the originating scope (matching the spec's
		// originating-scope contract — the case type qualifier names
		// the predicate's "self" position, which inside a where-clause
		// is the destination of the outer `via`).
		const p = exists(
			ancestorPath(relationStep("parent")),
			eq(prop("household", "region"), literal("north")),
		);
		const result = checkPredicate(p, {
			...ctxRelations,
			currentCaseType: "patient",
		});
		expect(result.ok).toBe(true);
	});

	it("accepts exists with a multi-hop ancestor walk (visit → patient → household)", () => {
		// Two-step walk — locks the chained-resolution rule. From
		// `visit`, the first hop's destination is `patient`
		// (visit.parent_type), and the second hop's destination is
		// `household` (patient.parent_type). The where-clause names
		// `household` as its originating scope.
		const p = exists(
			ancestorPath(relationStep("parent"), relationStep("parent")),
			eq(prop("household", "region"), literal("north")),
		);
		const result = checkPredicate(p, {
			...ctxRelations,
			currentCaseType: "visit",
		});
		expect(result.ok).toBe(true);
	});

	it("accepts ancestor step with a matching throughCaseType qualifier", () => {
		// The qualifier validates `origin.parent_type ===
		// step.throughCaseType` at each hop. From `patient`, the
		// expected destination is `household`, and the step explicitly
		// names that — locking the rule that valid qualifiers pass
		// through transparently.
		const p = exists(
			ancestorPath(relationStep("parent", "household")),
			eq(prop("household", "region"), literal("north")),
		);
		const result = checkPredicate(p, {
			...ctxRelations,
			currentCaseType: "patient",
		});
		expect(result.ok).toBe(true);
	});

	it("rejects ancestor step when throughCaseType disagrees with the actual parent_type", () => {
		// From `patient`, the actual `parent_type` is `household`. A
		// step that claims to walk `through visit` is a structural
		// mismatch the type-checker catches — the qualifier exists to
		// pin authoring intent against the schema, not to override it.
		const p = exists(
			ancestorPath(relationStep("parent", "visit")),
			eq(prop("visit", "kind"), literal("intake")),
		);
		const result = checkPredicate(p, {
			...ctxRelations,
			currentCaseType: "patient",
		});
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.errors[0].message).toMatch(
				/throughCaseType|parent_type|household/i,
			);
		}
	});

	it("rejects ancestor walk when origin has no parent_type", () => {
		// `household` is the root of the relationship graph — no
		// `parent_type` field. An ancestor walk from `household`
		// resolves to nothing; the checker emits an error rather than
		// returning a silent undefined.
		const p = exists(ancestorPath(relationStep("parent")));
		const result = checkPredicate(p, {
			...ctxRelations,
			currentCaseType: "household",
		});
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.errors[0].message).toMatch(/no parent|household.*parent/i);
		}
	});

	it("accepts subcase walk with ofCaseType disambiguation", () => {
		// Both `visit` and `lab_result` are subcases of `patient`. The
		// `ofCaseType` qualifier picks the destination unambiguously —
		// pinning the disambiguation rule that resolves the multi-
		// candidate case at authoring time rather than letting the
		// emitter / runtime guess.
		const p = exists(
			subcasePath("parent", "visit"),
			eq(prop("visit", "kind"), literal("intake")),
		);
		const result = checkPredicate(p, {
			...ctxRelations,
			currentCaseType: "patient",
		});
		expect(result.ok).toBe(true);
	});

	it("accepts subcase walk when only one candidate exists (no ofCaseType needed)", () => {
		// Modify the fixture so only `visit` carries `parent_type ===
		// "patient"`; resolution is unambiguous and `ofCaseType` is
		// unnecessary. Locks the single-candidate happy path.
		const ctxOneSubcase = {
			caseTypes: [HOUSEHOLD, PATIENT_WITH_PARENT, VISIT],
			knownInputs: [],
			currentCaseType: "patient" as const,
		};
		const p = exists(
			subcasePath("parent"),
			eq(prop("visit", "kind"), literal("intake")),
		);
		expect(checkPredicate(p, ctxOneSubcase).ok).toBe(true);
	});

	it("rejects subcase walk when multiple candidates exist and ofCaseType is omitted", () => {
		// Both `visit` and `lab_result` carry `parent_type === "patient"`,
		// so the destination is ambiguous. Without `ofCaseType`, the
		// type-checker rejects rather than picking one silently.
		const p = exists(
			subcasePath("parent"),
			eq(prop("visit", "kind"), literal("intake")),
		);
		const result = checkPredicate(p, {
			...ctxRelations,
			currentCaseType: "patient",
		});
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.errors[0].message).toMatch(
				/ambiguous|ofCaseType|multiple/i,
			);
		}
	});

	it("rejects subcase walk when ofCaseType names a non-existent case type", () => {
		// `ghost` isn't in `ctx.caseTypes`. The walk fails with an
		// unknown-case-type error, parallel to the comparison
		// checker's unknown-case-type message.
		const p = exists(subcasePath("parent", "ghost"));
		const result = checkPredicate(p, {
			...ctxRelations,
			currentCaseType: "patient",
		});
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.errors[0].message).toMatch(/unknown case type|ghost/i);
		}
	});

	it("rejects subcase walk when ofCaseType names a declared but non-subcase type", () => {
		// `household` is a real case type but not a subcase of
		// `patient` (the relationship runs the other way: `patient`
		// is a subcase of `household`). Locks the second of the two
		// `ofCaseType` failure modes — the known-but-wrong-subcase
		// case — distinct from the unknown-case-type message.
		const p = exists(subcasePath("parent", "household"));
		const result = checkPredicate(p, {
			...ctxRelations,
			currentCaseType: "patient",
		});
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.errors[0].message).toMatch(/not a subcase|parent_type/i);
		}
	});

	it("rejects subcase walk when zero candidates declare the origin as parent_type", () => {
		// `lab_result` has no case types declaring `parent_type ===
		// "lab_result"` (the schema models lab_result as a leaf in the
		// fixture). The walk produces a distinct error message from
		// "ambiguous" (which fires on multiple candidates) and from
		// "not a subcase" (which fires when ofCaseType names a wrong
		// type). Locks the third reverse-walk failure mode — the
		// no-candidates case — so the editor surfaces the right hint.
		const p = exists(subcasePath("parent"));
		const result = checkPredicate(p, {
			...ctxRelations,
			currentCaseType: "lab_result",
		});
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.errors[0].message).toMatch(
				/no.*subcase|no case type.*parent_type|no candidate/i,
			);
		}
	});

	it("accepts any-relation walk with ofCaseType", () => {
		// Direction-agnostic kind — the resolution semantics mirror
		// `subcase` (find candidates whose `parent_type` matches the
		// origin) because the current `CaseType` schema models only
		// one direction. The ofCaseType qualifier disambiguates exactly
		// as it does for `subcase`.
		const p = exists(
			anyRelationPath("parent", "visit"),
			eq(prop("visit", "kind"), literal("intake")),
		);
		const result = checkPredicate(p, {
			...ctxRelations,
			currentCaseType: "patient",
		});
		expect(result.ok).toBe(true);
	});

	it("rejects exists at top-level with via: self (meaningless self-relation)", () => {
		// `exists(selfPath())` asks "does the current case have itself,"
		// which is always true and almost certainly an authoring bug.
		// At the top level there's no destination to anchor on, so the
		// kind is rejected. (Inside a where-clause, `selfPath()` is
		// the explicit no-traversal form and routes through to the
		// current scope — see the nested-self test below.)
		const p = exists(selfPath());
		const result = checkPredicate(p, {
			...ctxRelations,
			currentCaseType: "patient",
		});
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.errors[0].message).toMatch(/self|meaningless|relation/i);
		}
	});

	it("rejects exists when the originating case type is not provided", () => {
		// The checker has no top-level `currentCaseType` to anchor
		// from — the relation walk has no origin. Plan 3 wires this
		// in at the case-list config UI; the error here pins the
		// requirement so a programmatic source that omits the field
		// fails loudly rather than silently bypassing the walk.
		const p = exists(ancestorPath(relationStep("parent")));
		const result = checkPredicate(p, ctxRelations); // no currentCaseType
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.errors[0].message).toMatch(
				/originating|case type|currentCaseType/i,
			);
		}
	});

	it("rejects when prop.caseType inside where-clause disagrees with the destination", () => {
		// The where-clause's `prop` references must name the
		// destination case type as their originating scope. From
		// `patient`, the parent walk lands on `household`, but the
		// where-clause names `patient` — the constraint catches this
		// at the destination-scope check.
		const p = exists(
			ancestorPath(relationStep("parent")),
			eq(prop("patient", "name"), literal("Alice")),
		);
		const result = checkPredicate(p, {
			...ctxRelations,
			currentCaseType: "patient",
		});
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.errors[0].message).toMatch(
				/destination|household|patient.*scope/i,
			);
		}
	});

	it("rebinds the originating scope across nested exists (chained relation walks)", () => {
		// Outer `exists` walks visit → patient. The where-clause
		// itself contains another `exists` walking patient → household.
		// The inner exists's relation walk anchors on the outer's
		// destination (`patient`) via the `currentCaseType`
		// rebinding inside `checkInDestinationScope`. The innermost
		// where-clause references `household.region` after the second
		// walk lands. Pins the scope-rebinding contract across
		// arbitrarily-nested walks rather than implying it from the
		// single-walk tests alone.
		const p = exists(
			ancestorPath(relationStep("parent")),
			exists(
				ancestorPath(relationStep("parent")),
				eq(prop("household", "region"), literal("north")),
			),
		);
		const result = checkPredicate(p, {
			...ctxRelations,
			currentCaseType: "visit",
		});
		expect(result.ok).toBe(true);
	});

	it("missing operates symmetrically with exists (parallel rule shape)", () => {
		// `missing` is sugar for `not(exists(...))` at the wire layer
		// but carries the same type-checker rule shape — locking the
		// symmetry pins the rule reuse (both kinds dispatch through
		// the same helper) rather than relying on `missing`'s
		// non-coverage to imply `exists`'s coverage.
		const p = missing(
			ancestorPath(relationStep("parent")),
			eq(prop("household", "region"), literal("north")),
		);
		const result = checkPredicate(p, {
			...ctxRelations,
			currentCaseType: "patient",
		});
		expect(result.ok).toBe(true);
	});

	it("propagates errors from inside the where-clause through wrapper recursion", () => {
		// A type-mismatch deep inside the where-clause surfaces with a
		// path that threads the outer operator's `kind`, the `where`
		// slot name, and the comparison-operator's own per-side
		// segment. Pinning the full path locks the kind-segment
		// threading the relational arms add — without it, a
		// regression that dropped `["exists", "where"]` from the
		// recursion would leave the message shape intact and slip
		// past the message-only assertion.
		const p = exists(
			ancestorPath(relationStep("parent")),
			eq(prop("household", "size"), literal("not-a-number")),
		);
		const result = checkPredicate(p, {
			...ctxRelations,
			currentCaseType: "patient",
		});
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.errors[0].path).toEqual(["exists", "where"]);
			expect(result.errors[0].message).toMatch(/type mismatch/i);
		}
	});
});

// `is-null` and `is-blank` share one rule shape: every non-literal
// Term variant is accepted (property refs, search-input refs, both
// session-ref kinds — any of these can resolve to absent at runtime),
// and literal-shaped `left` is rejected as a category error (a
// literal is the value itself; "is the value 5 absent?" is
// ill-formed, not a runtime question). The two operators are
// distinguished by per-dialect emission (strict-absent vs
// portable-absent-or-empty) — the type checker treats them
// identically because both pose the same operand-shape question.
// Combining the rules into one describe block keeps the parallel
// shape readable; per-operator arms diverge only in `it` names and
// the builder under test.
describe("checkPredicate — is-null and is-blank operand-shape rules", () => {
	it("accepts is-null on a property reference", () => {
		// Any property type can be absent at runtime — the rule
		// resolves the term but does not constrain its type. The pin
		// on `ok: true` locks the "no operand-type narrowing" stance:
		// `is-null` is the structural-absent question, not a typed
		// comparison.
		const p = isNull(prop("patient", "name"));
		expect(checkPredicate(p, ctx).ok).toBe(true);
	});

	it("accepts is-null on a search-input reference", () => {
		// Search inputs default to text when no `data_type` is declared,
		// matching the comparison checker's behavior. Acceptance pins
		// the resolution path through `resolveTermType`'s `case
		// "input"` arm; absent inputs resolve at runtime to the wire-
		// form empty string, which `is-null`'s strict semantic does
		// not match — the wire-emission rule is what diverges.
		const ctxWithInput = {
			...ctx,
			knownInputs: [{ name: "phone" }],
		};
		const p = isNull(input("phone"));
		expect(checkPredicate(p, ctxWithInput).ok).toBe(true);
	});

	it("accepts is-null on a session-user reference", () => {
		const p = isNull(sessionUser("region"));
		expect(checkPredicate(p, ctx).ok).toBe(true);
	});

	it("accepts is-null on a session-context reference", () => {
		const p = isNull(sessionContext("userid"));
		expect(checkPredicate(p, ctx).ok).toBe(true);
	});

	it("rejects is-null on a literal", () => {
		// Category error — a literal is the value, not a property
		// read. Asking "is the literal 'x' absent" is ill-formed, so
		// the type checker rejects rather than silently accept the
		// shape. The error path is `["left"]` so the editor can
		// highlight the offending operand directly.
		const p = isNull(literal("x"));
		const result = checkPredicate(p, ctx);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.errors).toHaveLength(1);
			expect(result.errors[0].path).toEqual(["left"]);
			expect(result.errors[0].message).toMatch(/literal/i);
		}
	});

	it("rejects is-null on a null literal too (parallel shape, parallel rule)", () => {
		// `literal(null)` resolves to the null sentinel and is the
		// canonical universal-comparable in the comparison checker.
		// `is-null(literal(null))` is still a category error — the
		// operand is a literal, not a property read, regardless of
		// what value the literal carries. The rule rejects the shape
		// (literal in `left`) before any value-level resolution runs.
		const p = isNull(literal(null));
		const result = checkPredicate(p, ctx);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.errors[0].message).toMatch(/literal/i);
		}
	});

	it("accepts is-blank on a property reference", () => {
		// Mirrors `is-null`'s acceptance — same operand-shape rule,
		// different wire-emission semantic. The type checker does not
		// narrow on "absent vs absent-or-empty"; both operators
		// resolve the term and accept any non-literal shape.
		const p = isBlank(prop("patient", "name"));
		expect(checkPredicate(p, ctx).ok).toBe(true);
	});

	it("accepts is-blank on a search-input reference", () => {
		const ctxWithInput = {
			...ctx,
			knownInputs: [{ name: "phone" }],
		};
		const p = isBlank(input("phone"));
		expect(checkPredicate(p, ctxWithInput).ok).toBe(true);
	});

	it("accepts is-blank on a session-user reference", () => {
		const p = isBlank(sessionUser("region"));
		expect(checkPredicate(p, ctx).ok).toBe(true);
	});

	it("accepts is-blank on a session-context reference", () => {
		const p = isBlank(sessionContext("userid"));
		expect(checkPredicate(p, ctx).ok).toBe(true);
	});

	it("rejects is-blank on a literal", () => {
		// Same category-error rationale as `is-null` — the literal-
		// in-`left` shape is meaningless. Pinning the rejection
		// independently for each operator (rather than parameterizing
		// over the kind) keeps the failure message naming the operator
		// the author actually used.
		const p = isBlank(literal("x"));
		const result = checkPredicate(p, ctx);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.errors).toHaveLength(1);
			expect(result.errors[0].path).toEqual(["left"]);
			expect(result.errors[0].message).toMatch(/literal/i);
		}
	});

	it("propagates unresolved-property errors from is-null's left", () => {
		// `is-null(prop("nonexistent", ...))` should surface the
		// unknown-case-type error from `resolveTermType` rather than
		// silently accept. The error path is `["left"]` so the editor
		// highlights the same slot a comparison's left-operand error
		// would.
		const p = isNull(prop("ghost", "name"));
		const result = checkPredicate(p, ctx);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.errors[0].path).toEqual(["left"]);
			expect(result.errors[0].message).toMatch(/Unknown case type/);
		}
	});

	it("propagates unresolved-input errors from is-blank's left", () => {
		// Symmetric with `is-null` — input refs flow through the same
		// resolution path. An undeclared input emits the same shape of
		// error a comparison's `input` operand would.
		const p = isBlank(input("phone"));
		const result = checkPredicate(p, ctx);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.errors[0].path).toEqual(["left"]);
			expect(result.errors[0].message).toMatch(/Unknown search input/);
		}
	});
});

// `prop.via` carries a relation walk whose resolution rule —
// "look up `property` on the destination case type, not on
// `caseType`" — is the destination-scope check. The originating-
// scope check (does `property` exist on `caseType`?) is
// structural and runs unconditionally when `via` is absent or
// `self`; with a non-self `via`, the resolution flips: `caseType`
// names the originating scope (the predicate's "self" position),
// the walk resolves to a destination case type, and `property` is
// looked up on the destination. This is the originating-scope
// contract locked by the JSDoc on `propertyRefSchema.caseType`.
describe("checkPredicate — prop.via destination-scope resolution", () => {
	it("resolves prop with an ancestor via on the destination case type", () => {
		// From `patient`, the ancestor walk via `parent` reaches
		// `household`. The property `region` is read on `household`
		// (the destination), not on `patient` (the originating scope).
		// The comparison's compatibility check confirms `region`
		// resolved to text, matching the text literal on the right.
		const p = eq(
			prop("patient", "region", ancestorPath(relationStep("parent"))),
			literal("north"),
		);
		expect(checkPredicate(p, ctxRelations).ok).toBe(true);
	});

	it("resolves prop with multi-hop ancestor via on the final destination", () => {
		// From `visit`, the two-hop walk lands on `household`. The
		// property `region` is read on `household` — locks the chained-
		// resolution rule for property terms (parallel to the chained
		// rule `exists` uses for relation paths).
		const p = eq(
			prop(
				"visit",
				"region",
				ancestorPath(relationStep("parent"), relationStep("parent")),
			),
			literal("north"),
		);
		expect(checkPredicate(p, ctxRelations).ok).toBe(true);
	});

	it("resolves prop with a subcase via on the destination case type", () => {
		// From `patient`, the subcase walk to `visit` (disambiguated
		// via `ofCaseType`) puts `kind` on the destination. The
		// originating scope stays `patient`; the destination scope
		// is where `kind` is resolved.
		const p = eq(
			prop("patient", "kind", subcasePath("parent", "visit")),
			literal("intake"),
		);
		expect(checkPredicate(p, ctxRelations).ok).toBe(true);
	});

	it("rejects prop.via when the property is unknown on the destination", () => {
		// `region` exists on `household` but not on `visit`. The
		// destination-scope lookup fails — the error message names
		// the destination case type so the editor can highlight the
		// real cause rather than steering the author back to
		// `patient`'s property surface.
		const p = eq(
			prop("patient", "region", subcasePath("parent", "visit")),
			literal("x"),
		);
		const result = checkPredicate(p, ctxRelations);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.errors[0].path).toEqual(["left"]);
			expect(result.errors[0].message).toMatch(
				/unknown property.*region.*visit|region.*visit/i,
			);
		}
	});

	it("rejects prop.via when the relation-path resolution itself fails", () => {
		// `household` has no `parent_type`, so the ancestor walk from
		// `household` resolves to nothing. The property lookup never
		// runs; the relation-path error surfaces alone (no cascading
		// "unknown property" message piled on top, matching the
		// resolution-failure short-circuit pattern that comparison
		// operators use).
		const p = eq(
			prop("household", "size", ancestorPath(relationStep("parent"))),
			literal(10),
		);
		const result = checkPredicate(p, ctxRelations);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.errors).toHaveLength(1);
			expect(result.errors[0].path).toEqual(["left"]);
		}
	});

	it("accepts prop with via: self (no-traversal form, originating-scope lookup)", () => {
		// `selfPath()` is the explicit no-traversal kind; the arm
		// passes through to the originating-scope check (looks up
		// `name` on `patient` directly). Pinning the positive case
		// keeps the no-traversal shape distinct from the cross-type
		// traversal kinds.
		const p = eq(prop("patient", "name", selfPath()), literal("Alice"));
		expect(checkPredicate(p, ctx).ok).toBe(true);
	});

	it("accepts prop without via (originating-scope lookup, baseline)", () => {
		// Sanity-check the absent-via shape continues to resolve on
		// the originating scope after the destination-scope code path
		// landed. Locks the no-`via` regression target — a refactor
		// that rerouted absent-via through the destination-scope code
		// would silently break every existing predicate.
		const p = eq(prop("patient", "name"), literal("Alice"));
		expect(checkPredicate(p, ctx).ok).toBe(true);
	});

	it("rejects prop.via when the originating case type itself is unknown", () => {
		// `phantom_origin` is not in `ctx.caseTypes`. Combined with a
		// non-self `via`, the relation walk's first hop fails on the
		// origin lookup — distinct from the "destination case type
		// not found" failure that fires on later hops. Locks the
		// originating-side error message ("Unknown originating case
		// type") so the editor surfaces the right hint when the author
		// typo's the originating case-type name.
		const p = eq(
			prop("phantom_origin", "x", ancestorPath(relationStep("parent"))),
			literal("anything"),
		);
		const result = checkPredicate(p, ctxRelations);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.errors[0].message).toMatch(
				/unknown originating|phantom_origin/i,
			);
		}
	});
});
// ---------- checkExpression tests ----------
//
// `checkExpression(expr, ctx, errors, path)` is the value-side
// analogue of `resolveTermType`. The block below pins each
// ValueExpression arm's resolved type plus the operator-specific
// type rules (numeric promotion in `arith`, branch agreement in
// `if` / `switch`, text-shaped operand in `unwrap-list`,
// date-or-datetime in `format-date`, etc.). Tests use a thin
// wrapper around `checkExpression` so call-site assertions read as
// "given this AST, expect this resolved type." The `errors` array
// is checked separately for the negative cases.

function resolve(expr: ValueExpressionLike, contextOverride = ctx) {
	const errors: { path: (string | number)[]; message: string }[] = [];
	const type = checkExpression(expr, contextOverride, errors, []);
	return { type, errors };
}

// Local type alias — the test fixtures pass values produced by the
// builders, which return precise per-kind shapes assignable to
// `ValueExpression`. The wrapper-level alias here lets the test
// signatures stay terse.
type ValueExpressionLike = Parameters<typeof checkExpression>[0];

describe("checkExpression — leaf arms", () => {
	it("term arm delegates to resolveTermType for a property reference", () => {
		const { type, errors } = resolve(term(prop("patient", "age")));
		expect(type).toBe("int");
		expect(errors).toEqual([]);
	});

	it("term arm surfaces unknown-property errors via resolveTermType", () => {
		const { type, errors } = resolve(term(prop("patient", "phantom")));
		expect(type).toBeUndefined();
		expect(errors[0].message).toMatch(/Unknown property 'phantom'/);
	});

	it("today / now resolve to date / datetime", () => {
		expect(resolve(today()).type).toBe("date");
		expect(resolve(now()).type).toBe("datetime");
	});
});

describe("checkExpression — date / coercion arms", () => {
	it("date-add returns the date operand's type and accepts numeric quantity", () => {
		const v = dateAdd(today(), "days", term(literal(7)));
		const { type, errors } = resolve(v);
		expect(type).toBe("date");
		expect(errors).toEqual([]);
	});

	it("date-add rejects a non-numeric quantity", () => {
		const v = dateAdd(today(), "days", term(literal("seven")));
		const { errors } = resolve(v);
		expect(errors.some((e) => /numeric quantity/.test(e.message))).toBe(true);
	});

	it("date-add rejects a non-date operand", () => {
		const v = dateAdd(term(literal(42)), "days", term(literal(1)));
		const { errors } = resolve(v);
		expect(
			errors.some((e) => /requires a date or datetime/.test(e.message)),
		).toBe(true);
	});

	it("date-coerce accepts text-shaped and returns date", () => {
		const v = dateCoerce(term(prop("patient", "name")));
		const { type, errors } = resolve(v);
		expect(type).toBe("date");
		expect(errors).toEqual([]);
	});

	it("date-coerce rejects a numeric operand", () => {
		const v = dateCoerce(term(prop("patient", "age")));
		const { type, errors } = resolve(v);
		expect(type).toBe("date");
		expect(errors.some((e) => /text-shaped operand/.test(e.message))).toBe(
			true,
		);
	});

	it("datetime-coerce returns datetime", () => {
		const v = datetimeCoerce(term(prop("patient", "name")));
		expect(resolve(v).type).toBe("datetime");
	});

	it("double accepts text or numeric and returns decimal", () => {
		expect(resolve(double(term(prop("patient", "name")))).type).toBe("decimal");
		expect(resolve(double(term(prop("patient", "age")))).type).toBe("decimal");
	});

	it("double rejects a date operand", () => {
		const v = double(term(prop("patient", "dob")));
		const { errors } = resolve(v);
		expect(errors.some((e) => /text-shaped or numeric/.test(e.message))).toBe(
			true,
		);
	});
});

describe("checkExpression — arith arm + numeric promotion", () => {
	it("int + int = int", () => {
		const v = arith("+", term(literal(1)), term(literal(2)));
		expect(resolve(v).type).toBe("int");
	});

	it("int + decimal = decimal", () => {
		const v = arith("+", term(literal(1)), term(literal(1.5)));
		expect(resolve(v).type).toBe("decimal");
	});

	it("decimal + decimal = decimal", () => {
		const v = arith("*", term(literal(1.5)), term(literal(2.5)));
		expect(resolve(v).type).toBe("decimal");
	});

	it.each([
		"+",
		"-",
		"*",
		"div",
		"mod",
	] as const)("arith(%s) accepts both operands as int", (op) => {
		const v = arith(op, term(literal(1)), term(literal(2)));
		const { type, errors } = resolve(v);
		expect(type).toBe("int");
		expect(errors).toEqual([]);
	});

	it("arith rejects a non-numeric left operand", () => {
		const v = arith("+", term(prop("patient", "name")), term(literal(1)));
		const { errors } = resolve(v);
		expect(
			errors.some((e) => /arith requires numeric.*left/.test(e.message)),
		).toBe(true);
	});

	it("arith rejects a non-numeric right operand", () => {
		const v = arith("+", term(literal(1)), term(prop("patient", "dob")));
		const { errors } = resolve(v);
		expect(
			errors.some((e) => /arith requires numeric.*right/.test(e.message)),
		).toBe(true);
	});
});

describe("checkExpression — concat / coalesce arms", () => {
	it("concat resolves to text regardless of part types", () => {
		const v = concat(term(prop("patient", "name")), term(literal(42)));
		expect(resolve(v).type).toBe("text");
	});

	it("coalesce resolves to the agreed type across compatible values", () => {
		// All-int → int; null literals widen to anything.
		const v = coalesce(
			term(prop("patient", "age")),
			term(literal(null)),
			term(literal(0)),
		);
		expect(resolve(v).type).toBe("int");
	});

	it("coalesce flags type mismatch between values", () => {
		const v = coalesce(
			term(prop("patient", "age")),
			term(prop("patient", "name")),
		);
		const { errors } = resolve(v);
		expect(
			errors.some((e) => /values must agree on type/.test(e.message)),
		).toBe(true);
	});
});

describe("checkExpression — if / switch arms", () => {
	it("if walks cond as a Predicate and returns the branches' agreed type", () => {
		const v = ifExpr(
			isBlank(prop("patient", "name")),
			term(literal("(empty)")),
			term(prop("patient", "name")),
		);
		expect(resolve(v).type).toBe("text");
	});

	it("if surfaces a Predicate-side error inside cond", () => {
		const v = ifExpr(
			eq(prop("patient", "phantom"), literal(0)),
			term(literal("a")),
			term(literal("b")),
		);
		const { errors } = resolve(v);
		expect(
			errors.some((e) => /Unknown property 'phantom'/.test(e.message)),
		).toBe(true);
	});

	it("if flags branch-type disagreement", () => {
		const v = ifExpr(
			matchAll(),
			term(prop("patient", "age")),
			term(prop("patient", "name")),
		);
		const { errors } = resolve(v);
		expect(errors.some((e) => /branches must agree/.test(e.message))).toBe(
			true,
		);
	});

	it("switch checks each case.when against on's type", () => {
		const v = switchExpr(
			term(prop("patient", "status")),
			[
				switchCase(literal("open"), term(literal(1))),
				switchCase(literal("closed"), term(literal(0))),
			],
			term(literal(-1)),
		);
		expect(resolve(v).type).toBe("int");
	});

	it("switch flags a case.when literal incompatible with on", () => {
		const v = switchExpr(
			term(prop("patient", "age")),
			[switchCase(literal("not-a-number"), term(literal(0)))],
			term(literal(-1)),
		);
		const { errors } = resolve(v);
		expect(
			errors.some((e) =>
				/'when' literal.*not comparable with switch.on/.test(e.message),
			),
		).toBe(true);
	});

	it("switch flags case.then incompatible with the established branch type", () => {
		const v = switchExpr(
			term(prop("patient", "status")),
			[
				switchCase(literal("open"), term(literal(1))),
				switchCase(literal("closed"), term(literal("two"))),
			],
			term(literal(-1)),
		);
		const { errors } = resolve(v);
		expect(
			errors.some((e) => /'then' type.*not comparable/.test(e.message)),
		).toBe(true);
	});
});

describe("checkExpression — count + unwrap-list + format-date", () => {
	const ctxRel = {
		caseTypes: [
			{
				name: "household",
				properties: [
					{ name: "region", label: "Region", data_type: "text" as const },
				],
			},
			{
				name: "patient",
				parent_type: "household",
				properties: [
					{ name: "age", label: "Age", data_type: "int" as const },
					{ name: "name", label: "Name", data_type: "text" as const },
					{ name: "dob", label: "DOB", data_type: "date" as const },
				],
			},
		],
		knownInputs: [],
		currentCaseType: "household",
	};

	it("count returns int for a relation walk", () => {
		const v = count(subcasePath("parent", "patient"));
		expect(resolve(v, ctxRel).type).toBe("int");
	});

	it("count walks `where` in the destination scope", () => {
		const v = count(
			subcasePath("parent", "patient"),
			eq(prop("patient", "age"), literal(18)),
		);
		const { type, errors } = resolve(v, ctxRel);
		expect(type).toBe("int");
		expect(errors).toEqual([]);
	});

	it("count surfaces a where-clause violation in destination scope", () => {
		const v = count(
			subcasePath("parent", "patient"),
			eq(prop("patient", "phantom"), literal(0)),
		);
		const { errors } = resolve(v, ctxRel);
		expect(
			errors.some((e) => /Unknown property 'phantom'/.test(e.message)),
		).toBe(true);
	});

	it("count surfaces missing originating scope", () => {
		const v = count(subcasePath("parent", "patient"));
		const { errors } = resolve(v); // ctx has no currentCaseType
		expect(
			errors.some((e) => /originating scope must be set/.test(e.message)),
		).toBe(true);
	});

	it("unwrap-list resolves to the sequence sentinel", () => {
		const v = unwrapList(term(prop("patient", "name")));
		// sequence type is internal — describe(...) renders it as
		// "sequence" but the raw value is the SEQUENCE_TYPE sentinel.
		// Default `ctx` (no currentCaseType) is used so the originating-
		// scope pin doesn't reject the property reference; the rule
		// under test is the unwrap-list arm itself.
		const { type } = resolve(v);
		expect(type).toBe("_sequence");
	});

	it("unwrap-list rejects a non-text operand", () => {
		// `age` is `int` on the patient case type — outside the
		// text-shaped allow-list. Default `ctx` so the originating-
		// scope pin doesn't fire; the test isolates the unwrap-list
		// arm's text-shaped operand rule.
		const v = unwrapList(term(prop("patient", "age")));
		const { errors } = resolve(v);
		expect(
			errors.some((e) => /requires a text-shaped operand/.test(e.message)),
		).toBe(true);
	});

	it("format-date resolves to text given a date or datetime", () => {
		expect(resolve(formatDate(today(), "iso")).type).toBe("text");
		expect(resolve(formatDate(now(), "long")).type).toBe("text");
	});

	it("format-date rejects a numeric operand", () => {
		const v = formatDate(term(literal(42)), "iso");
		const { errors } = resolve(v);
		expect(
			errors.some((e) => /requires a date or datetime/.test(e.message)),
		).toBe(true);
	});
});

describe("checkExpression — sequence type incompatibility", () => {
	// `_sequence` sits outside the scalar compatibility table — no v1
	// operator composes a sequence with a scalar. The block below pins
	// the boundary by routing a sequence into a comparison, where the
	// type checker must reject the shape rather than silently widen.

	it("rejects a sequence operand inside a comparison", () => {
		const p = eq(unwrapList(term(prop("patient", "name"))), literal("x"));
		const result = checkPredicate(p, ctx);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(
				result.errors.some((e) => /'sequence'.*not comparable/.test(e.message)),
			).toBe(true);
		}
	});
});
