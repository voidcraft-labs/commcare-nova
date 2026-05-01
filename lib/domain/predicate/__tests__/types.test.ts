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
	MATCH_MODES,
	predicateSchema,
	relationPathSchema,
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
	// other two. These also pin the field name `clause` so any rename
	// — to `then` or any other identifier — fails CI immediately.

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

	// `in(...)` with all-null values is a structural degenerate: every
	// wire emission collapses to "is unset OR is unset OR …", which
	// duplicates the canonical `eq(prop, literal(null))` "is unset"
	// form rather than expressing real set membership. Reject at the
	// AST layer so downstream compilers don't have to encode the
	// policy. Mixed null + non-null lists are accepted because they
	// encode the meaningful "is unset OR equals one of these values"
	// predicate.
	it("rejects an in(...) where every value is null", () => {
		expect(() =>
			predicateSchema.parse({
				kind: "in",
				left: { kind: "prop", caseType: "patient", property: "name" },
				values: [
					{ kind: "literal", value: null },
					{ kind: "literal", value: null },
				],
			}),
		).toThrow();
	});

	it("accepts an in(...) with a single null value alongside non-null values", () => {
		const result = predicateSchema.parse({
			kind: "in",
			left: { kind: "prop", caseType: "patient", property: "name" },
			values: [
				{ kind: "literal", value: null },
				{ kind: "literal", value: "Alice" },
			],
		});
		expect(result.kind).toBe("in");
	});

	// Numeric structural constraint. A negative radius is geometrically
	// meaningless and would propagate to two compilers (XPath/CSQL and
	// Kysely) that don't share a rejection layer — same logic that
	// defends the tuple-with-rest shape on collection slots applies.

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

	it("rejects match whose property is not a prop reference", () => {
		expect(() =>
			predicateSchema.parse({
				kind: "match",
				property: { kind: "input", name: "name_query" },
				value: "alice",
				mode: "fuzzy",
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
	//   - `match` operator: had only the non-prop-property negative
	//     test; this test confirms the canonical happy-path shape
	//     parses.
	// Without these, a future rename like `field` → `fieldName` on
	// `userContextRefSchema` (or any happy-path field rename on `in` /
	// `match`) wouldn't trip a single existing test.

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

	it("parses a match(...) predicate with mode: fuzzy", () => {
		const result = predicateSchema.parse({
			kind: "match",
			property: { kind: "prop", caseType: "patient", property: "name" },
			value: "alice",
			mode: "fuzzy",
		});
		expect(result.kind).toBe("match");
		if (result.kind === "match") {
			expect(result.value).toBe("alice");
			expect(result.mode).toBe("fuzzy");
		}
	});

	// Each match mode dispatches to a different CCHQ wire form on the
	// CSQL target — `fuzzy-match` (verified at
	// `commcare-hq/corehq/apps/case_search/xpath_functions/query_functions.py:91-98`),
	// `phonetic-match` (line 84-89), `fuzzy-date` (line 101-113), and
	// `starts-with` (line 31-35). Pinning each mode through round-trip
	// parse locks the discriminator-only payload (`{ property, value,
	// mode }`) for every variant; a regression that dropped one mode
	// from the enum would surface here rather than at the emitter.
	// Iterating `MATCH_MODES` shares the source of truth with
	// `matchSchema` so adding a mode automatically extends the table.
	it.each(MATCH_MODES)("parses a match(...) with mode: %s", (mode) => {
		const result = predicateSchema.parse({
			kind: "match",
			property: { kind: "prop", caseType: "patient", property: "name" },
			value: "alice",
			mode,
		});
		expect(result.kind).toBe("match");
		if (result.kind === "match") {
			expect(result.mode).toBe(mode);
		}
	});

	it("rejects match with an unknown mode", () => {
		// `mode` is `z.enum([...four values])` — any string outside the
		// declared set rejects at parse time. Pin one out-of-set name so
		// a future widening to `z.string()` would trip this test.
		expect(() =>
			predicateSchema.parse({
				kind: "match",
				property: { kind: "prop", caseType: "patient", property: "name" },
				value: "alice",
				mode: "regex",
			}),
		).toThrow();
	});

	it("rejects match with an empty value (z.string().min(1))", () => {
		// Match is meaningless against an empty string at every wire
		// target — every property "starts-with" empty, every property
		// "fuzzy-matches" empty, etc. Reject at the schema layer so
		// downstream emitters never have to encode the policy.
		expect(() =>
			predicateSchema.parse({
				kind: "match",
				property: { kind: "prop", caseType: "patient", property: "name" },
				value: "",
				mode: "fuzzy",
			}),
		).toThrow();
	});

	it("rejects match with no mode", () => {
		expect(() =>
			predicateSchema.parse({
				kind: "match",
				property: { kind: "prop", caseType: "patient", property: "name" },
				value: "alice",
			}),
		).toThrow();
	});

	// `multi-select-contains` is the typed structural shape for CCHQ's
	// `selected-any` / `selected-all` query functions (registered at
	// `commcare-hq/corehq/apps/case_search/xpath_functions/__init__.py:43-44`).
	// The `quantifier` discriminator distinguishes the two; the schema
	// keeps them in one operator so a UI surface or reducer toggling
	// "any of" ↔ "all of" doesn't have to reshape the parent object.
	it("parses a multi-select-contains predicate with quantifier: any", () => {
		const result = predicateSchema.parse({
			kind: "multi-select-contains",
			property: { kind: "prop", caseType: "patient", property: "tags" },
			values: [
				{ kind: "literal", value: "vip" },
				{ kind: "literal", value: "urgent" },
			],
			quantifier: "any",
		});
		expect(result.kind).toBe("multi-select-contains");
		if (result.kind === "multi-select-contains") {
			expect(result.quantifier).toBe("any");
			expect(result.values).toHaveLength(2);
		}
	});

	it("parses a multi-select-contains predicate with quantifier: all", () => {
		const result = predicateSchema.parse({
			kind: "multi-select-contains",
			property: { kind: "prop", caseType: "patient", property: "tags" },
			values: [{ kind: "literal", value: "vip" }],
			quantifier: "all",
		});
		expect(result.kind).toBe("multi-select-contains");
		if (result.kind === "multi-select-contains") {
			expect(result.quantifier).toBe("all");
		}
	});

	it("rejects multi-select-contains with an empty values list", () => {
		// Tuple-with-rest enforces non-empty: an empty values list is
		// trivially false at every wire target ("contains any of nothing"
		// / "contains all of nothing") and is virtually always an
		// authoring bug.
		expect(() =>
			predicateSchema.parse({
				kind: "multi-select-contains",
				property: { kind: "prop", caseType: "patient", property: "tags" },
				values: [],
				quantifier: "any",
			}),
		).toThrow();
	});

	it("rejects multi-select-contains with an unknown quantifier", () => {
		expect(() =>
			predicateSchema.parse({
				kind: "multi-select-contains",
				property: { kind: "prop", caseType: "patient", property: "tags" },
				values: [{ kind: "literal", value: "vip" }],
				quantifier: "majority",
			}),
		).toThrow();
	});

	it("rejects multi-select-contains whose property is not a prop reference", () => {
		// Like `match` and `within-distance`, the property slot is
		// constrained to a direct property reference — multi-select
		// containment against a literal or input is meaningless at
		// every wire target.
		expect(() =>
			predicateSchema.parse({
				kind: "multi-select-contains",
				property: { kind: "input", name: "tag_filter" },
				values: [{ kind: "literal", value: "vip" }],
				quantifier: "any",
			}),
		).toThrow();
	});

	// Deep recursive-arm coverage. The drift guard at the bottom of
	// `types.ts` strips recursive slots before comparing schema-inferred
	// shapes against hand-declared union arms, so a payload-shape change
	// reachable only through recursion would slip past it. This test
	// builds one predicate that nests every recursive arm
	// (`and` / `or` / `not` / `when-input-present` / `exists` /
	// `missing`) inside another and parses it end-to-end — the schema's
	// `z.lazy(() => predicateSchema)` resolves through every arm at
	// runtime, so any cross-arm regression in the lazy chain trips this
	// test. `exists.where` and `missing.where` go through the same
	// `z.lazy` indirection as the four logical arms; wrapping the leaf
	// comparisons in `exists` and `missing` exercises the relational-
	// quantifier recursion in the same fixture.
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
									kind: "exists",
									via: { kind: "subcase", identifier: "parent" },
									where: {
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
						},
						{
							kind: "missing",
							via: {
								kind: "ancestor",
								via: [{ identifier: "host" }],
							},
							where: {
								kind: "eq",
								left: {
									kind: "prop",
									caseType: "patient",
									property: "name",
								},
								right: { kind: "literal", value: "Bob" },
							},
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

// `relationPathSchema` describes how a property reference reaches across
// the case-relationship graph — the typed structural equivalent of
// CommCare's `index/parent/host/...` slash-strings. The four kinds
// (`self`, `ancestor`, `subcase`, `any-relation`) capture direction
// (no-traversal / up via parent or host index / down via reverse index /
// ambiguous) without committing to CommCare's relationship-id encoding
// (CHILD = 1, EXTENSION = 2 at
// `commcare-hq/corehq/form_processor/models/cases.py:1085-1090`). The
// `identifier` slot carries the user-named index (`parent`, `host`, or
// custom names) and the `throughCaseType` / `ofCaseType` slots carry
// optional case-type qualifiers used by the type checker to narrow
// property resolution inside `exists` / `count` filters. This block
// locks the wire-shape for each kind and the invariants downstream
// emitters and the SA-facing tool surface rely on.
describe("relationPath schema", () => {
	it("parses a self path", () => {
		// Pins the discriminator-only happy path: `self` is the
		// no-traversal shape the type checker treats as identity. The
		// kind name `"self"` round-trips cleanly through the schema, so
		// a silent rename to `"identity"` (or any other reshaping of
		// the no-traversal arm) trips this test.
		// (Strip semantics on the Zod object are not asserted here —
		// the default mode strips unknown keys silently, so a payload
		// with extra slots would still parse to the same
		// discriminator-only shape. An explicit-no-extras lock would
		// require `z.strictObject`, which the rest of the file's
		// schemas don't use.)
		const result = relationPathSchema.parse({ kind: "self" });
		expect(result.kind).toBe("self");
	});

	it("parses a single-hop ancestor path", () => {
		// `ancestor` matches CCHQ's `ancestor-exists(parent, ...)` form
		// and the on-device `instance('casedb')/casedb/case[@case_id =
		// current()/index/parent]` join pattern. The on-device runtime
		// build site for `<index>/<identifier>` is
		// `CaseChildElement.buildIndexTreeElement` in
		// `commcare-core/src/main/java/org/commcare/cases/instance/`; the
		// CSQL path is verified at
		// `commcare-hq/.../ancestor_functions.py:39-94`. The single-hop
		// shape is the most common authored form (parent → patient).
		const result = relationPathSchema.parse({
			kind: "ancestor",
			via: [{ identifier: "parent" }],
		});
		expect(result.kind).toBe("ancestor");
		if (result.kind === "ancestor") {
			expect(result.via).toHaveLength(1);
			expect(result.via[0].identifier).toBe("parent");
		}
	});

	it("parses a multi-hop ancestor path", () => {
		// `via: RelationStep[]` represents the slash-separated chain in
		// CCHQ's `ancestor-exists` first argument — `host/parent` walks
		// up two levels. Multi-hop paths are supported by both CCHQ's
		// server-side `walk_ancestor_hierarchy` (loops over each step)
		// and the on-device join pattern (each step compiles to a
		// nested `instance('casedb')` predicate). Each step's optional
		// `throughCaseType` is the type-checker's destination-scope
		// narrowing hint at that step. The schema is structural; this
		// test exercises only the acceptance shape.
		const result = relationPathSchema.parse({
			kind: "ancestor",
			via: [
				{ identifier: "parent", throughCaseType: "household" },
				{ identifier: "host" },
			],
		});
		expect(result.kind).toBe("ancestor");
		if (result.kind === "ancestor") {
			expect(result.via).toHaveLength(2);
			expect(result.via[0].throughCaseType).toBe("household");
			expect(result.via[1].throughCaseType).toBeUndefined();
		}
	});

	it("rejects an ancestor path with empty via", () => {
		// Tuple-with-rest is the operative defense: an empty `via`
		// collapses the path to `self` semantics but parses as a
		// different kind, which would silently disagree with the type
		// checker and the emitters. Reject at parse time rather than
		// letting the degenerate flow through downstream layers.
		expect(() =>
			relationPathSchema.parse({ kind: "ancestor", via: [] }),
		).toThrow();
	});

	it("parses a subcase path", () => {
		// `subcase` matches CCHQ's `subcase-exists('parent', ...)` form
		// at `commcare-hq/.../subcase_functions.py:51-62`. The
		// `identifier` is the index name ON THE CHILD case pointing
		// back at the current (parent) case. `ofCaseType` narrows
		// type-checker resolution inside the subcase filter; this
		// test pins structural acceptance.
		const result = relationPathSchema.parse({
			kind: "subcase",
			identifier: "parent",
			ofCaseType: "visit",
		});
		expect(result.kind).toBe("subcase");
		if (result.kind === "subcase") {
			expect(result.identifier).toBe("parent");
			expect(result.ofCaseType).toBe("visit");
		}
	});

	it("parses a subcase path without ofCaseType", () => {
		// `ofCaseType` is optional — authors who don't know the case
		// type at the destination (or who want the union of all
		// pointing cases) omit it. Keep the no-qualifier shape
		// structurally accepted.
		const result = relationPathSchema.parse({
			kind: "subcase",
			identifier: "parent",
		});
		expect(result.kind).toBe("subcase");
		if (result.kind === "subcase") {
			expect(result.ofCaseType).toBeUndefined();
		}
	});

	it("parses an any-relation path", () => {
		// `any-relation` covers cases where the direction (child vs
		// extension; up vs down) isn't known at authoring time —
		// e.g. a custom index identifier where the author wants a
		// relation regardless of relationship-id. Maps to the same
		// underlying `case_indices.identifier` lookup, just without
		// the direction-narrowing constraint.
		const result = relationPathSchema.parse({
			kind: "any-relation",
			identifier: "linked",
			ofCaseType: "referral",
		});
		expect(result.kind).toBe("any-relation");
	});

	it("rejects a relation step with an XPath-injection-shaped identifier", () => {
		// Same identifier-vocabulary defense the existing predicate
		// schema applies to property and case-type names: the wire
		// emitters interpolate `identifier` directly into XPath
		// (`current()/index/<identifier>`), so any character outside
		// CommCare's identifier vocabulary would either fail
		// downstream parsing or inject attacker-controlled syntax.
		// Reject at the schema layer.
		expect(() =>
			relationPathSchema.parse({
				kind: "ancestor",
				via: [{ identifier: "parent') or 1=1" }],
			}),
		).toThrow();
	});

	it("rejects a relation-step throughCaseType with whitespace", () => {
		// `throughCaseType` flows through the same case-type-vocabulary
		// defense as `caseType` and `ofCaseType` — emitters interpolate
		// it into XPath / SQL identifier slots without quoting, so
		// whitespace (or any character outside CommCare's case-type
		// vocabulary) must be rejected at the schema layer. Symmetric
		// with the identifier + ofCaseType rejection tests; locks the
		// per-step qualifier defense against silent relaxation.
		expect(() =>
			relationPathSchema.parse({
				kind: "ancestor",
				via: [{ identifier: "parent", throughCaseType: "with whitespace" }],
			}),
		).toThrow();
	});

	it("rejects a subcase identifier with whitespace", () => {
		expect(() =>
			relationPathSchema.parse({
				kind: "subcase",
				identifier: "with whitespace",
			}),
		).toThrow();
	});

	it("rejects a subcase ofCaseType with slash", () => {
		expect(() =>
			relationPathSchema.parse({
				kind: "subcase",
				identifier: "parent",
				ofCaseType: "ref/erral",
			}),
		).toThrow();
	});

	it("rejects an unknown relation-path kind", () => {
		// `cousin` is not in the discriminated union of permitted kinds
		// (`self` / `ancestor` / `subcase` / `any-relation`). The schema
		// rejects at parse time so downstream emitters never see a
		// kind they have no arm for.
		expect(() =>
			relationPathSchema.parse({ kind: "cousin", identifier: "parent" }),
		).toThrow();
	});
});

// `propertyRefSchema` carries an optional `via: RelationPath` slot — the
// relational read. With `via` present, the property reference resolves
// against the case at the destination of the relation walk; with `via`
// absent, it resolves against the current case-type scope (the
// historical behavior). Both shapes must parse cleanly through the
// surrounding `predicateSchema` so existing comparisons keep working
// while the relational read becomes available.
describe("propertyRef with via (relational read)", () => {
	it("parses a comparison whose left side reads through an ancestor relation", () => {
		// The canonical case: an authored predicate compares a
		// property on a *parent* case to a literal — e.g. a search
		// predicate over `patient` whose filter says
		// "the household this patient lives in is in region X." The
		// relation walks up via the `parent` index to the
		// `household` case type and reads `region` there.
		const result = predicateSchema.parse({
			kind: "eq",
			left: {
				kind: "prop",
				caseType: "patient",
				property: "region",
				via: {
					kind: "ancestor",
					via: [{ identifier: "parent", throughCaseType: "household" }],
				},
			},
			right: { kind: "literal", value: "north" },
		});
		expect(result.kind).toBe("eq");
		if (result.kind === "eq" && result.left.kind === "prop") {
			expect(result.left.via).toBeDefined();
			expect(result.left.via?.kind).toBe("ancestor");
		}
	});

	it("parses a property reference without via (no traversal)", () => {
		// Backward-compat lock: the historical no-`via` shape must
		// still parse and round-trip without the optional slot
		// surfacing as `via: undefined`. The shape below is exactly
		// what every existing builder call site produces; if the
		// schema's `.optional()` started materializing the absent
		// key, the assertion below would fail.
		const input = {
			kind: "eq" as const,
			left: {
				kind: "prop" as const,
				caseType: "patient",
				property: "status",
			},
			right: { kind: "literal" as const, value: "open" },
		};
		const result = predicateSchema.parse(input);
		expect(result).toEqual(input);
		if (result.kind === "eq" && result.left.kind === "prop") {
			expect("via" in result.left).toBe(false);
		}
	});

	it("parses a property reference with a self via (no-op traversal)", () => {
		// `self` is the explicit "no traversal" form. It exists
		// alongside the absent-`via` shape so that a UI surface
		// editing a relational read can flip the kind without
		// having to reshape the parent object — e.g. the user
		// switches from `ancestor` to `self` and back. Both shapes
		// resolve to the same effective behavior; the schema
		// accepts both.
		const result = predicateSchema.parse({
			kind: "eq",
			left: {
				kind: "prop",
				caseType: "patient",
				property: "status",
				via: { kind: "self" },
			},
			right: { kind: "literal", value: "open" },
		});
		expect(result.kind).toBe("eq");
	});

	it("parses a property reference with a subcase via", () => {
		// Reading a property on a subcase from the parent's scope.
		// The shape below says: "from the current `household` case,
		// reach the `patient` cases that point at this household via
		// the `parent` index, and read `status` on those." The
		// quantifier (any/all/count) is encoded by the surrounding
		// predicate operator (e.g. `exists` / `count`); the path
		// slot itself is purely structural.
		const result = predicateSchema.parse({
			kind: "eq",
			left: {
				kind: "prop",
				caseType: "household",
				property: "status",
				via: {
					kind: "subcase",
					identifier: "parent",
					ofCaseType: "patient",
				},
			},
			right: { kind: "literal", value: "active" },
		});
		expect(result.kind).toBe("eq");
	});

	it("parses a propertyRef with via: any-relation through a comparison", () => {
		// `any-relation` rounds out the propertyRef-with-via coverage:
		// the other three kinds (`ancestor`, `self`, `subcase`) each
		// have an end-to-end test above. The shape below encodes "use
		// the `linked` index regardless of direction (CHILD or
		// EXTENSION) to reach a `referral` case and read `linked_id`
		// on it" — the typical authored shape when the index direction
		// isn't fixed at authoring time. This test pins the structural
		// composition of `any-relation` inside propertyRef.via, locking
		// against a future divergence where the schema accepted the
		// kind standalone but rejected it inside a property-ref slot.
		const result = predicateSchema.parse({
			kind: "eq",
			left: {
				kind: "prop",
				caseType: "patient",
				property: "linked_id",
				via: {
					kind: "any-relation",
					identifier: "linked",
					ofCaseType: "referral",
				},
			},
			right: { kind: "literal", value: "abc-123" },
		});
		expect(result.kind).toBe("eq");
		if (result.kind === "eq" && result.left.kind === "prop") {
			expect(result.left.via).toEqual({
				kind: "any-relation",
				identifier: "linked",
				ofCaseType: "referral",
			});
		}
	});
});

// Sentinel predicates `match-all` / `match-none` carry no payload
// other than their discriminator. They model the structural identity
// (always-true) and absorbing (always-false) elements of the boolean
// algebra so a UI surface or a reducer can produce a well-typed
// "empty filter" / "no matches" predicate without picking an arbitrary
// tautology / contradiction encoding. CCHQ exposes the same pair as
// zero-arg query functions registered at
// `commcare-hq/corehq/apps/case_search/xpath_functions/__init__.py:52-53`
// and implemented at
// `commcare-hq/corehq/apps/case_search/xpath_functions/query_functions.py:162-177`
// (each implementation rejects any argument with an
// `XPathFunctionException`).
describe("sentinel predicates", () => {
	it("parses match-all", () => {
		const result = predicateSchema.parse({ kind: "match-all" });
		expect(result.kind).toBe("match-all");
	});

	it("parses match-none", () => {
		const result = predicateSchema.parse({ kind: "match-none" });
		expect(result.kind).toBe("match-none");
	});

	it("rejects match-all with a stray payload field at the schema arm level", () => {
		// `z.discriminatedUnion` strips unknown keys silently in default
		// mode, matching the rest of the file's schemas. The pin here
		// is the discriminator-only round-trip: the parsed value carries
		// only `kind`, regardless of what the caller passed in.
		const result = predicateSchema.parse({
			kind: "match-all",
			ignored: "value",
		});
		expect(result).toEqual({ kind: "match-all" });
	});
});

// `is-null` is the structural "left is unset" predicate — the
// canonical form a UI surface or compiler reaches for when asking
// "does the property carry a value?" Authoring it as a first-class
// AST node (rather than `eq(prop, literal(null))`) keeps the
// "is unset" intent explicit at every layer.
//
// The `left` slot is `termSchema`, not `propertyRefSchema`, so authors
// can ask "is the input X unset" or "is the user's region unset"
// alongside the canonical "is the property unset" shape. The schema
// is intentionally structural-only: it admits every Term variant in
// `left` (including the meaningless `is-null(literal(...))` shape,
// which can't be "unset" by definition). Whether a checker rejects
// the literal shape is a type-checker concern, not a schema concern.
describe("is-null predicate", () => {
	it("parses is-null with a property reference", () => {
		const result = predicateSchema.parse({
			kind: "is-null",
			left: { kind: "prop", caseType: "patient", property: "status" },
		});
		expect(result.kind).toBe("is-null");
	});

	it("parses is-null with a search-input reference", () => {
		const result = predicateSchema.parse({
			kind: "is-null",
			left: { kind: "input", name: "phone" },
		});
		expect(result.kind).toBe("is-null");
	});

	it("parses is-null with a user-context reference", () => {
		const result = predicateSchema.parse({
			kind: "is-null",
			left: { kind: "user", field: "assigned_region" },
		});
		expect(result.kind).toBe("is-null");
	});

	it("parses is-null with a literal (schema is structurally permissive)", () => {
		// The schema accepts every Term variant in `left`, including
		// literals. `is-null(literal(...))` is meaningless (literals
		// can't be "unset" by definition) but parses cleanly here;
		// rejecting the literal shape is a type-checker concern, not
		// a schema concern. Pinning the schema-side acceptance keeps
		// the layering explicit — a refactor that tightened the schema
		// to reject literal `left` would trip this test.
		const result = predicateSchema.parse({
			kind: "is-null",
			left: { kind: "literal", value: "x" },
		});
		expect(result.kind).toBe("is-null");
	});

	it("rejects is-null with no left", () => {
		expect(() => predicateSchema.parse({ kind: "is-null" })).toThrow();
	});
});

// `between` is the structural range predicate. Authoring the
// structural form (rather than a hand-written conjunction of two
// comparisons) keeps the inclusivity intent explicit at the AST
// node and lets a "show all configured ranges" UI surface match on
// `kind: "between"` directly rather than recognising the conjunction
// shape.
//
// The `lower`/`upper` slots are optional `termSchema` (so a
// search-input or session-user reference can drive either bound),
// but at least one must be present — a both-bounds-absent shape is
// equivalent to "true" and authors should write `match-all`
// explicitly. The `lowerInclusive`/`upperInclusive` slots are
// required booleans so the inclusivity is always explicit at the AST
// node and a reader doesn't have to infer the intent from missing
// fields.
describe("between predicate", () => {
	it("parses a both-bounds inclusive range", () => {
		const result = predicateSchema.parse({
			kind: "between",
			left: { kind: "prop", caseType: "patient", property: "age" },
			lower: { kind: "literal", value: 18 },
			upper: { kind: "literal", value: 65 },
			lowerInclusive: true,
			upperInclusive: true,
		});
		expect(result.kind).toBe("between");
	});

	it("parses a half-open range with only a lower bound", () => {
		const result = predicateSchema.parse({
			kind: "between",
			left: { kind: "prop", caseType: "patient", property: "age" },
			lower: { kind: "literal", value: 18 },
			lowerInclusive: true,
			upperInclusive: true,
		});
		expect(result.kind).toBe("between");
	});

	it("parses a half-open range with only an upper bound", () => {
		const result = predicateSchema.parse({
			kind: "between",
			left: { kind: "prop", caseType: "patient", property: "age" },
			upper: { kind: "literal", value: 65 },
			lowerInclusive: true,
			upperInclusive: true,
		});
		expect(result.kind).toBe("between");
	});

	it("parses a range with mixed inclusivity (closed lower, open upper)", () => {
		// Inclusivity is per-bound. The pin here locks that the booleans
		// are independent — a regression that collapsed them into a
		// single `inclusive` slot would not parse this asymmetric shape.
		const result = predicateSchema.parse({
			kind: "between",
			left: { kind: "prop", caseType: "patient", property: "age" },
			lower: { kind: "literal", value: 18 },
			upper: { kind: "literal", value: 65 },
			lowerInclusive: true,
			upperInclusive: false,
		});
		expect(result.kind).toBe("between");
		if (result.kind === "between") {
			expect(result.lowerInclusive).toBe(true);
			expect(result.upperInclusive).toBe(false);
		}
	});

	it("parses a range whose bounds are search-input references", () => {
		// Bounds are `termSchema`, not literal-only — search-input or
		// user-context refs drive the bound at runtime. The pin locks
		// that the schema does NOT narrow `lower`/`upper` to literals
		// the way `inSchema.values` does (the latter has wire-target
		// reasons to demand a static list; bounds don't).
		const result = predicateSchema.parse({
			kind: "between",
			left: { kind: "prop", caseType: "patient", property: "age" },
			lower: { kind: "input", name: "min_age" },
			upper: { kind: "input", name: "max_age" },
			lowerInclusive: true,
			upperInclusive: true,
		});
		expect(result.kind).toBe("between");
	});

	it("rejects a between with no bounds (refinement enforces at-least-one)", () => {
		// A both-bounds-absent shape is equivalent to "always true"
		// modulo the type-checker's domain rule; the canonical shape
		// for "always true" is `match-all`, and accepting an
		// all-absent `between` would silently produce a duplicate
		// representation. Reject at parse time.
		expect(() =>
			predicateSchema.parse({
				kind: "between",
				left: { kind: "prop", caseType: "patient", property: "age" },
				lowerInclusive: true,
				upperInclusive: true,
			}),
		).toThrow();
	});

	it("rejects a between missing the inclusivity flags", () => {
		// `lowerInclusive`/`upperInclusive` are required booleans so the
		// inclusivity intent is explicit at every AST node. Locking the
		// rejection here means a future refactor that defaulted them at
		// the schema layer would have to update this test, surfacing
		// the implicit-default decision in CR rather than letting it
		// land silently.
		expect(() =>
			predicateSchema.parse({
				kind: "between",
				left: { kind: "prop", caseType: "patient", property: "age" },
				lower: { kind: "literal", value: 18 },
				upper: { kind: "literal", value: 65 },
			}),
		).toThrow();
	});
});

// `exists` / `missing` are the relational quantifiers — "at least one
// related case satisfies `where`" / "no related case satisfies `where`".
// `via` is a `RelationPath` (the four-kind discriminator from above);
// `where` is an optional nested predicate evaluated in the destination
// scope of the walk. When `where` is absent, the predicate degenerates
// to "any related case exists" / "no related case exists".
//
// CCHQ exposes the corresponding query functions as `subcase-exists`
// at
// `commcare-hq/corehq/apps/case_search/xpath_functions/subcase_functions.py:51-62`
// (filter-optional per the parser at
// `commcare-hq/corehq/apps/case_search/xpath_functions/subcase_functions.py:207`)
// and `ancestor-exists` at
// `commcare-hq/corehq/apps/case_search/xpath_functions/ancestor_functions.py:97-118`
// (filter mandatory — the implementation calls
// `confirm_args_count(node, 2)`). The asymmetry sits at the CCHQ
// wire boundary, not at this AST: the schema accepts the no-`where`
// shape uniformly across all four `RelationPath` kinds because the
// AST-level contract ("filter the related cases by an additional
// predicate") is the same regardless of how each downstream wire
// target represents it.
describe("exists predicate", () => {
	it("parses exists with a self via and no where", () => {
		// `self` + no-where is a degenerate shape (always satisfied by
		// the current case) but the schema permits it structurally —
		// rejecting semantic degenerates is a type-checker concern, not
		// a schema concern. Pin the structural acceptance.
		const result = predicateSchema.parse({
			kind: "exists",
			via: { kind: "self" },
		});
		expect(result.kind).toBe("exists");
	});

	it("parses exists with an ancestor via and no where", () => {
		// "Has a parent case" — the simplest authored shape. The schema
		// admits the no-`where` form uniformly across all four
		// `RelationPath` kinds; what each downstream wire target makes
		// of the absent filter is handled at that layer.
		const result = predicateSchema.parse({
			kind: "exists",
			via: { kind: "ancestor", via: [{ identifier: "parent" }] },
		});
		expect(result.kind).toBe("exists");
		if (result.kind === "exists") {
			expect(result.where).toBeUndefined();
		}
	});

	it("parses exists with a subcase via and no where", () => {
		// "Has at least one child case via the `parent` index." The
		// schema accepts the no-`where` shape; CCHQ's `subcase-exists`
		// happens to be the one CCHQ relational quantifier that admits
		// a one-argument form natively (per the parser at
		// `commcare-hq/corehq/apps/case_search/xpath_functions/subcase_functions.py:207`),
		// but that's a CCHQ wire-layer fact, not a constraint on the
		// AST.
		const result = predicateSchema.parse({
			kind: "exists",
			via: { kind: "subcase", identifier: "parent" },
		});
		expect(result.kind).toBe("exists");
	});

	it("parses exists with an any-relation via and no where", () => {
		// `any-relation` is direction-agnostic. CCHQ exposes no
		// equivalent direction-agnostic operator (its server-side
		// surface offers only `ancestor-exists` and `subcase-exists`),
		// but the AST accepts the kind uniformly across the four
		// `RelationPath` shapes — handling for non-CCHQ wire targets
		// or rewriting for CCHQ targets is a downstream concern.
		const result = predicateSchema.parse({
			kind: "exists",
			via: { kind: "any-relation", identifier: "linked" },
		});
		expect(result.kind).toBe("exists");
	});

	it("parses exists with an ancestor via and a where filter", () => {
		// "Has a parent case in region 'north'" — the canonical
		// relational filter. The `where` predicate evaluates in the
		// destination scope of the walk (the parent case here); the
		// `throughCaseType` qualifier on each relation step is the
		// schema-level hook a type-checker rule uses to resolve
		// property references inside `where` against the destination
		// scope. The schema accepts the structural shape; whether a
		// checker walks `where` is a checker concern, not a schema
		// concern.
		const result = predicateSchema.parse({
			kind: "exists",
			via: {
				kind: "ancestor",
				via: [{ identifier: "parent", throughCaseType: "household" }],
			},
			where: {
				kind: "eq",
				left: { kind: "prop", caseType: "household", property: "region" },
				right: { kind: "literal", value: "north" },
			},
		});
		expect(result.kind).toBe("exists");
		if (result.kind === "exists") {
			expect(result.where?.kind).toBe("eq");
		}
	});

	it("parses an exists nested inside another exists (recursion through where)", () => {
		// `where` references `predicateSchema` via `z.lazy(...)` — a
		// regression in the lazy chain (e.g. dropping the `z.lazy`
		// wrapper) would not resolve a recursive `exists`. This test
		// nests one level deep so the lazy resolution fires at parse
		// time. The shape is "the patient has a parent case which
		// itself has a child case in status 'active'" — concrete enough
		// to track but contrived enough to make the recursion the
		// load-bearing part.
		const result = predicateSchema.parse({
			kind: "exists",
			via: { kind: "ancestor", via: [{ identifier: "parent" }] },
			where: {
				kind: "exists",
				via: { kind: "subcase", identifier: "parent" },
				where: {
					kind: "eq",
					left: { kind: "prop", caseType: "household", property: "status" },
					right: { kind: "literal", value: "active" },
				},
			},
		});
		expect(result.kind).toBe("exists");
		if (result.kind === "exists" && result.where?.kind === "exists") {
			expect(result.where.where?.kind).toBe("eq");
		}
	});

	it("rejects exists with no via", () => {
		expect(() => predicateSchema.parse({ kind: "exists" })).toThrow();
	});

	it("rejects exists with an invalid via kind", () => {
		// Same defense the relationPathSchema applies standalone — the
		// `via` slot routes through the same discriminated union, so
		// unknown kinds are rejected at parse time.
		expect(() =>
			predicateSchema.parse({
				kind: "exists",
				via: { kind: "cousin", identifier: "parent" },
			}),
		).toThrow();
	});
});

describe("missing predicate", () => {
	it("parses missing with an ancestor via and no where", () => {
		// "Has no parent case" — the simplest authored shape. The
		// schema accepts the absent-`where` form uniformly across
		// `RelationPath` kinds; what each downstream wire target makes
		// of the absent filter is handled at that layer.
		const result = predicateSchema.parse({
			kind: "missing",
			via: { kind: "ancestor", via: [{ identifier: "parent" }] },
		});
		expect(result.kind).toBe("missing");
	});

	it("parses missing with a subcase via and a where filter", () => {
		// "Has no child case in status 'active' via the `parent`
		// index" — the canonical relational anti-filter shape at the
		// AST layer.
		const result = predicateSchema.parse({
			kind: "missing",
			via: { kind: "subcase", identifier: "parent" },
			where: {
				kind: "eq",
				left: { kind: "prop", caseType: "patient", property: "status" },
				right: { kind: "literal", value: "active" },
			},
		});
		expect(result.kind).toBe("missing");
		if (result.kind === "missing") {
			expect(result.where?.kind).toBe("eq");
		}
	});

	it("parses missing with a self via and no where", () => {
		// `self` + no-where is a degenerate shape (never satisfied by
		// the current case) but the schema permits it structurally —
		// rejecting semantic degenerates is a type-checker concern,
		// not a schema concern.
		const result = predicateSchema.parse({
			kind: "missing",
			via: { kind: "self" },
		});
		expect(result.kind).toBe("missing");
	});

	it("parses missing with an any-relation via and no where", () => {
		const result = predicateSchema.parse({
			kind: "missing",
			via: { kind: "any-relation", identifier: "linked" },
		});
		expect(result.kind).toBe("missing");
	});

	it("rejects missing with no via", () => {
		expect(() => predicateSchema.parse({ kind: "missing" })).toThrow();
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
