// lib/domain/predicate/__tests__/types.test.ts
//
// Acceptance tests for the predicate AST schema. These exercise:
//   1. The term-level discriminated union (`prop`, `input`, `user`,
//      `literal`).
//   2. The recursive predicate union, including a nested `and` containing
//      comparisons — proves the recursion works end-to-end.
//   3. A non-logical operator (`within-distance`) to confirm the union
//      covers operators with their own structural shape, not just
//      comparisons.
//   4. Negative cases — wrong `kind`, missing required field — to confirm
//      the schema rejects ill-formed input rather than silently coercing.

import { describe, expect, it } from "vitest";
import {
	CASE_PROPERTY_REGEX,
	CASE_TYPE_REGEX,
	XML_ELEMENT_NAME_REGEX,
} from "@/lib/commcare/constants";
import {
	CASE_PROPERTY_PATTERN,
	CASE_TYPE_PATTERN,
	predicateSchema,
	termSchema,
	XML_ELEMENT_NAME_PATTERN,
} from "../types";

describe("term schema", () => {
	it("parses a property reference", () => {
		const result = termSchema.parse({
			kind: "prop",
			caseType: "patient",
			property: "age",
		});
		expect(result.kind).toBe("prop");
	});

	it("parses a literal", () => {
		expect(termSchema.parse({ kind: "literal", value: 42 })).toEqual({
			kind: "literal",
			value: 42,
		});
	});

	it("rejects an unknown term kind", () => {
		expect(() => termSchema.parse({ kind: "bogus" })).toThrow();
	});
});

describe("predicate schema", () => {
	it("parses a nested and/eq predicate", () => {
		const result = predicateSchema.parse({
			kind: "and",
			clauses: [
				{
					kind: "eq",
					left: { kind: "prop", caseType: "patient", property: "status" },
					right: { kind: "literal", value: "open" },
				},
				{
					kind: "gt",
					left: { kind: "prop", caseType: "patient", property: "age" },
					right: { kind: "literal", value: 18 },
				},
			],
		});
		expect(result.kind).toBe("and");
	});

	it("parses a nested or/eq predicate", () => {
		const result = predicateSchema.parse({
			kind: "or",
			clauses: [
				{
					kind: "eq",
					left: { kind: "prop", caseType: "patient", property: "status" },
					right: { kind: "literal", value: "open" },
				},
				{
					kind: "eq",
					left: { kind: "prop", caseType: "patient", property: "status" },
					right: { kind: "literal", value: "active" },
				},
			],
		});
		expect(result.kind).toBe("or");
		if (result.kind === "or") {
			expect(result.clauses).toHaveLength(2);
		}
	});

	it("parses a within-distance predicate", () => {
		const result = predicateSchema.parse({
			kind: "within-distance",
			property: { kind: "prop", caseType: "clinic", property: "location" },
			center: { kind: "input", name: "user_location" },
			distance: 50,
			unit: "miles",
		});
		expect(result.kind).toBe("within-distance");
	});

	it("rejects an ill-formed predicate (eq missing right)", () => {
		expect(() =>
			predicateSchema.parse({
				kind: "eq",
				left: { kind: "prop", caseType: "patient", property: "age" },
			}),
		).toThrow();
	});

	// Recursive-arm coverage. The four logical/conditional arms are the
	// load-bearing piece of `types.ts` — they're the only operators
	// whose recursion goes through `z.lazy(() => predicateSchema)`. The
	// `and` and `or` tests above exercise two of them; the explicit
	// `not(...)` and `when-input-present(...)` tests below cover the
	// other two. These also pin the field name `clause` (not `then`)
	// so any revert to the rejected `then` name fails CI immediately.

	it("parses a not(...) wrapping a comparison", () => {
		const result = predicateSchema.parse({
			kind: "not",
			clause: {
				kind: "eq",
				left: { kind: "prop", caseType: "patient", property: "status" },
				right: { kind: "literal", value: "closed" },
			},
		});
		expect(result.kind).toBe("not");
		if (result.kind === "not") {
			expect(result.clause.kind).toBe("eq");
		}
	});

	it("parses a when-input-present(...) wrapping a comparison", () => {
		const result = predicateSchema.parse({
			kind: "when-input-present",
			input: { kind: "input", name: "phone" },
			clause: {
				kind: "eq",
				left: { kind: "prop", caseType: "patient", property: "phone" },
				right: { kind: "input", name: "phone" },
			},
		});
		expect(result.kind).toBe("when-input-present");
		if (result.kind === "when-input-present") {
			expect(result.clause.kind).toBe("eq");
		}
	});

	// Empty-collection rejection. An empty `and` evaluates to `true`,
	// an empty `or` evaluates to `false`, and an empty `in` is
	// trivially false — none of these are useful in practice and
	// virtually always indicate an authoring bug. Reject at the AST
	// layer so downstream compilers never have to encode the policy.

	it("rejects an empty and(...)", () => {
		expect(() => predicateSchema.parse({ kind: "and", clauses: [] })).toThrow();
	});

	it("rejects an empty or(...)", () => {
		expect(() => predicateSchema.parse({ kind: "or", clauses: [] })).toThrow();
	});

	it("rejects an empty in(...)", () => {
		expect(() =>
			predicateSchema.parse({
				kind: "in",
				left: { kind: "prop", caseType: "patient", property: "status" },
				values: [],
			}),
		).toThrow();
	});

	// Numeric structural constraint. A negative radius is geometrically
	// meaningless and would propagate to two compilers (XPath/CSQL and
	// Kysely) that don't share a rejection layer — same logic that
	// defends `.min(1)` on collection slots applies.

	it("rejects within-distance with a negative distance", () => {
		expect(() =>
			predicateSchema.parse({
				kind: "within-distance",
				property: { kind: "prop", caseType: "clinic", property: "location" },
				center: { kind: "input", name: "user_location" },
				distance: -10,
				unit: "miles",
			}),
		).toThrow();
	});

	// Shape-pin tests for the two operators that constrain a slot to a
	// specific term subtype rather than a full `termSchema`. These
	// constraints are documented in the schema's JSDoc; pinning them in
	// CI prevents a future "loosen the constraint silently" diff from
	// landing without the test going red.

	it("rejects within-distance whose property is not a prop reference", () => {
		expect(() =>
			predicateSchema.parse({
				kind: "within-distance",
				// literal value where a prop reference is required
				property: { kind: "literal", value: "40.7,-74.0" },
				center: { kind: "input", name: "user_location" },
				distance: 50,
				unit: "miles",
			}),
		).toThrow();
	});

	it("rejects within-distance with an unknown unit", () => {
		expect(() =>
			predicateSchema.parse({
				kind: "within-distance",
				property: { kind: "prop", caseType: "clinic", property: "location" },
				center: { kind: "input", name: "user_location" },
				distance: 50,
				unit: "meters",
			}),
		).toThrow();
	});

	it("rejects fuzzy whose property is not a prop reference", () => {
		expect(() =>
			predicateSchema.parse({
				kind: "fuzzy",
				property: { kind: "input", name: "name_query" },
				value: "alice",
			}),
		).toThrow();
	});

	it("rejects when-input-present whose input is not an input reference", () => {
		expect(() =>
			predicateSchema.parse({
				kind: "when-input-present",
				// prop reference where an input reference is required
				input: { kind: "prop", caseType: "patient", property: "phone" },
				clause: {
					kind: "eq",
					left: { kind: "prop", caseType: "patient", property: "phone" },
					right: { kind: "literal", value: "555" },
				},
			}),
		).toThrow();
	});

	// Missing-required-field symmetry tests. The `eq missing right` test
	// above pins one comparison-arm omission; these pin the same defense
	// for the recursive arms whose `clause` slot is required. Without
	// these, `notSchema.clause` and `whenInputPresentSchema.clause` could
	// silently become optional in a future refactor.

	it("rejects not(...) with no clause", () => {
		expect(() => predicateSchema.parse({ kind: "not" })).toThrow();
	});

	it("rejects when-input-present(...) with no clause", () => {
		expect(() =>
			predicateSchema.parse({
				kind: "when-input-present",
				input: { kind: "input", name: "phone" },
			}),
		).toThrow();
	});

	// Positive-path coverage parity. Three variants in the file lacked
	// happy-path parse tests:
	//   - `user` term: only structurally implied by sibling terms; this
	//     test pins both the term shape and that it flows correctly
	//     through a comparison's `right` slot via nested narrowing.
	//   - `in` operator: had only empty-array + ill-shaped negative
	//     tests; this test confirms a non-empty literal list parses.
	//   - `fuzzy` operator: had only the non-prop-property negative
	//     test; this test confirms the canonical happy-path shape
	//     parses.
	// Without these, a future rename like `field` → `fieldName` on
	// `userContextRefSchema` (or any happy-path field rename on `in` /
	// `fuzzy`) wouldn't trip a single existing test.

	it("parses a user-field reference inside a comparison", () => {
		const result = predicateSchema.parse({
			kind: "eq",
			left: { kind: "prop", caseType: "patient", property: "region" },
			right: { kind: "user", field: "assigned_region" },
		});
		expect(result.kind).toBe("eq");
		if (result.kind === "eq") {
			expect(result.right.kind).toBe("user");
			if (result.right.kind === "user") {
				expect(result.right.field).toBe("assigned_region");
			}
		}
	});

	it("parses an in(...) with a non-empty literal list", () => {
		const result = predicateSchema.parse({
			kind: "in",
			left: { kind: "prop", caseType: "patient", property: "status" },
			values: [
				{ kind: "literal", value: "open" },
				{ kind: "literal", value: "active" },
			],
		});
		expect(result.kind).toBe("in");
		if (result.kind === "in") {
			expect(result.values).toHaveLength(2);
		}
	});

	it("parses a fuzzy(...) match", () => {
		const result = predicateSchema.parse({
			kind: "fuzzy",
			property: { kind: "prop", caseType: "patient", property: "name" },
			value: "alice",
		});
		expect(result.kind).toBe("fuzzy");
		if (result.kind === "fuzzy") {
			expect(result.value).toBe("alice");
		}
	});

	// Deep recursive-arm coverage. The drift guard at the bottom of
	// `types.ts` strips recursive slots before comparing schema-inferred
	// shapes against hand-declared union arms, so a payload-shape change
	// reachable only through recursion would slip past it. This test
	// builds one predicate that nests every recursive arm
	// (`and` / `or` / `not` / `when-input-present`) inside another and
	// parses it end-to-end — the schema's `z.lazy(() => predicateSchema)`
	// resolves through every arm at runtime, so any cross-arm regression
	// in the lazy chain trips this test.
	it("parses a deeply nested predicate exercising every recursive arm", () => {
		const nested = predicateSchema.parse({
			kind: "and",
			clauses: [
				{
					kind: "or",
					clauses: [
						{
							kind: "not",
							clause: {
								kind: "when-input-present",
								input: { kind: "input", name: "x" },
								clause: {
									kind: "eq",
									left: {
										kind: "prop",
										caseType: "patient",
										property: "name",
									},
									right: { kind: "literal", value: "Alice" },
								},
							},
						},
						{
							kind: "eq",
							left: { kind: "prop", caseType: "patient", property: "name" },
							right: { kind: "literal", value: "Bob" },
						},
					],
				},
			],
		});
		expect(nested.kind).toBe("and");
	});

	// Identifier-vocabulary rejection. The wire emitters interpolate
	// `caseType`, `property`, `name`, and `field` directly into XPath
	// strings without quoting or escaping, so any character outside
	// CommCare's identifier vocabulary would either fail downstream
	// parsing or (worse) inject attacker-controlled syntax. The
	// schema layer rejects malformed identifiers at parse time so
	// every emitter and compiler can rely on the constraint without
	// re-defending it. The block below covers each identifier slot
	// with a representative malformed value (the embedded-quote +
	// XPath-suffix shape from the case-list-search threat model);
	// other rejection cases (leading digit, internal space, empty
	// string) are structurally equivalent and surface at the same
	// `.regex()` defense.

	it("rejects prop with an XPath-injection-shaped property name", () => {
		expect(() =>
			predicateSchema.parse({
				kind: "eq",
				left: {
					kind: "prop",
					caseType: "patient",
					property: "name'); injected",
				},
				right: { kind: "literal", value: "x" },
			}),
		).toThrow();
	});

	it("rejects prop with an XPath-injection-shaped case type", () => {
		expect(() =>
			predicateSchema.parse({
				kind: "eq",
				left: {
					kind: "prop",
					caseType: "patient' or 1=1",
					property: "name",
				},
				right: { kind: "literal", value: "x" },
			}),
		).toThrow();
	});

	it("rejects input with a name containing internal whitespace", () => {
		expect(() =>
			predicateSchema.parse({
				kind: "eq",
				left: { kind: "prop", caseType: "patient", property: "name" },
				right: { kind: "input", name: "bad name with spaces" },
			}),
		).toThrow();
	});

	it("rejects user-context ref with a field containing punctuation", () => {
		expect(() =>
			predicateSchema.parse({
				kind: "eq",
				left: { kind: "prop", caseType: "patient", property: "name" },
				right: { kind: "user", field: "field/with/slashes" },
			}),
		).toThrow();
	});

	it("rejects prop with an empty property name", () => {
		// The regex anchors require at least one character matching
		// the leading-letter class; an empty string can't satisfy
		// the anchor + leading-class combination, so the negative
		// case is locked here against a future relaxation that
		// dropped the leading-character requirement.
		expect(() =>
			predicateSchema.parse({
				kind: "eq",
				left: { kind: "prop", caseType: "patient", property: "" },
				right: { kind: "literal", value: "x" },
			}),
		).toThrow();
	});

	it("rejects input whose name has a hyphen (XML element-name vocabulary)", () => {
		// `name` on a search input maps to an XML attribute value at
		// the wire layer, but downstream code paths derive structural
		// identifiers from the input name and rely on the
		// no-hyphen XML element-name shape (mirroring
		// `XML_ELEMENT_NAME_REGEX` in `lib/commcare/constants.ts`).
		// `caseType` and `property` admit hyphens; this test is the
		// asymmetry pin between the two vocabularies.
		expect(() =>
			predicateSchema.parse({
				kind: "eq",
				left: { kind: "prop", caseType: "patient", property: "name" },
				right: { kind: "input", name: "name-with-hyphen" },
			}),
		).toThrow();
	});

	it("accepts prop with a hyphenated property name", () => {
		// Property names mirror `CASE_PROPERTY_REGEX` and admit
		// hyphens — existing CommCare deployments routinely store
		// properties like `external-id`. Pin the positive case so a
		// future tightening that aligned property names with the
		// stricter XML-element-name rules trips this test.
		const result = predicateSchema.parse({
			kind: "eq",
			left: {
				kind: "prop",
				caseType: "patient",
				property: "external-id",
			},
			right: { kind: "literal", value: "abc" },
		});
		expect(result.kind).toBe("eq");
	});
});

// Drift guard for the inlined identifier patterns in `types.ts`. The
// patterns are inlined there because the `noRestrictedImports` rule
// in `biome.json` denies `lib/domain` direct access to
// `lib/commcare/*` at runtime — the boundary keeps `lib/commcare` as
// the one-way emission target and prevents domain types from
// depending on CommCare's wire vocabulary at the source-graph level.
//
// Tests are exempt from that boundary (`biome.json:61` excludes
// `**/__tests__/**`), so this block crosses the boundary at test
// time only and asserts that the inlined patterns' `.source` field
// equals the source-of-truth constants in `lib/commcare/constants`.
// If `lib/commcare`'s identifier vocabulary changes, the test fails
// until the inlined copies in `types.ts` are updated to match. The
// `.source` comparison is the right shape because two `RegExp`
// instances are object-identity-distinct even when constructed from
// the same literal; comparing the underlying pattern strings is the
// only structural-equality check available without depending on
// runtime-equivalence semantics.
describe("inlined identifier patterns match lib/commcare/constants source-of-truth", () => {
	it("CASE_TYPE_PATTERN matches CASE_TYPE_REGEX", () => {
		expect(CASE_TYPE_PATTERN.source).toBe(CASE_TYPE_REGEX.source);
	});

	it("CASE_PROPERTY_PATTERN matches CASE_PROPERTY_REGEX", () => {
		expect(CASE_PROPERTY_PATTERN.source).toBe(CASE_PROPERTY_REGEX.source);
	});

	it("XML_ELEMENT_NAME_PATTERN matches XML_ELEMENT_NAME_REGEX", () => {
		expect(XML_ELEMENT_NAME_PATTERN.source).toBe(XML_ELEMENT_NAME_REGEX.source);
	});
});
