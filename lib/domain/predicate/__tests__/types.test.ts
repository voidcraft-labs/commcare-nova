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
	ARITH_OPS,
	CASE_PROPERTY_PATTERN,
	CASE_TYPE_PATTERN,
	DATE_ADD_INTERVALS,
	FORMAT_DATE_PRESETS,
	MATCH_MODES,
	predicateSchema,
	relationPathSchema,
	SESSION_CONTEXT_FIELDS,
	termSchema,
	valueExpressionSchema,
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

// Helper: lift a Term-shaped raw object into the structural `term`
// arm of `ValueExpression`. Predicate operator schemas carry
// `ValueExpression` operands; the canonical Term-as-operand shape
// is `{ kind: "term", term: <Term> }`. Centralising the wrapper here
// keeps each individual test's payload readable — the focus stays on
// the predicate operator under test, not on the lifter mechanics.
//
// The helper takes `unknown` so call sites can pass minimal Term
// shapes (`{ kind: "prop", caseType, property }`) without restating
// the full Term type. The schema validates the inner shape at parse
// time, which is the round-trip these tests pin.
function asValueExpr(t: unknown): { kind: "term"; term: unknown } {
	return { kind: "term", term: t };
}

describe("predicate schema", () => {
	it("parses a nested and/eq predicate", () => {
		const result = predicateSchema.parse({
			kind: "and",
			clauses: [
				{
					kind: "eq",
					left: asValueExpr({
						kind: "prop",
						caseType: "patient",
						property: "status",
					}),
					right: asValueExpr({ kind: "literal", value: "open" }),
				},
				{
					kind: "gt",
					left: asValueExpr({
						kind: "prop",
						caseType: "patient",
						property: "age",
					}),
					right: asValueExpr({ kind: "literal", value: 18 }),
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
					left: asValueExpr({
						kind: "prop",
						caseType: "patient",
						property: "status",
					}),
					right: asValueExpr({ kind: "literal", value: "open" }),
				},
				{
					kind: "eq",
					left: asValueExpr({
						kind: "prop",
						caseType: "patient",
						property: "status",
					}),
					right: asValueExpr({ kind: "literal", value: "active" }),
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
			center: asValueExpr({ kind: "input", name: "user_location" }),
			distance: 50,
			unit: "miles",
		});
		expect(result.kind).toBe("within-distance");
	});

	it("rejects an ill-formed predicate (eq missing right)", () => {
		expect(() =>
			predicateSchema.parse({
				kind: "eq",
				left: asValueExpr({
					kind: "prop",
					caseType: "patient",
					property: "age",
				}),
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
				left: asValueExpr({
					kind: "prop",
					caseType: "patient",
					property: "status",
				}),
				right: asValueExpr({ kind: "literal", value: "closed" }),
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
				left: asValueExpr({
					kind: "prop",
					caseType: "patient",
					property: "phone",
				}),
				right: asValueExpr({ kind: "input", name: "phone" }),
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
				left: asValueExpr({
					kind: "prop",
					caseType: "patient",
					property: "status",
				}),
				values: [],
			}),
		).toThrow();
	});

	// `in(...)` with all-null values is a structural degenerate: every
	// wire emission collapses to "is absent OR is absent OR …", which
	// duplicates an absence check rather than expressing real set
	// membership. The canonical authoring shapes for the absence-check
	// intent are `is-null(prop)` (strict-absent, Postgres-only) and
	// `is-blank(prop)` (absent-or-empty, the CCHQ-portable form).
	// Reject at the AST layer so downstream compilers don't have to
	// encode the policy. Mixed null + non-null lists are accepted
	// because they encode the meaningful "absent OR equals one of
	// these values" predicate.
	it("rejects an in(...) where every value is null", () => {
		expect(() =>
			predicateSchema.parse({
				kind: "in",
				left: asValueExpr({
					kind: "prop",
					caseType: "patient",
					property: "name",
				}),
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
			left: asValueExpr({
				kind: "prop",
				caseType: "patient",
				property: "name",
			}),
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
				center: asValueExpr({ kind: "input", name: "user_location" }),
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
				center: asValueExpr({ kind: "input", name: "user_location" }),
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
				center: asValueExpr({ kind: "input", name: "user_location" }),
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
					left: asValueExpr({
						kind: "prop",
						caseType: "patient",
						property: "phone",
					}),
					right: asValueExpr({ kind: "literal", value: "555" }),
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

	// Positive-path coverage parity. Several variants in the file lacked
	// happy-path parse tests:
	//   - `session-user` / `session-context` terms: only structurally
	//     implied by sibling terms; the tests below pin both term shapes
	//     plus the open-vs-closed namespace contract (open names round-
	//     trip through `session-user`; out-of-enum field names reject on
	//     `session-context`).
	//   - `in` operator: had only empty-array + ill-shaped negative
	//     tests; this test confirms a non-empty literal list parses.
	//   - `match` operator: had only the non-prop-property negative
	//     test; this test confirms the canonical happy-path shape
	//     parses.
	// Without these, a future rename like `field` → `fieldName` on
	// `sessionUserSchema` / `sessionContextSchema` (or any happy-path
	// field rename on `in` / `match`) wouldn't trip a single existing
	// test.

	it("parses a session-user reference inside a comparison (open namespace)", () => {
		// `assigned_region` is a custom user-data field — open-namespace
		// vocabulary populated by `addUserProperties` at
		// `commcare-core/src/main/java/org/commcare/session/SessionInstanceBuilder.java`.
		// The schema admits any XML-element-name-valid field here.
		// Predicate operands are `ValueExpression` — terms are admitted
		// via the structural `term` arm (the lifter that flows any
		// Term through a value slot).
		const result = predicateSchema.parse({
			kind: "eq",
			left: {
				kind: "term",
				term: { kind: "prop", caseType: "patient", property: "region" },
			},
			right: {
				kind: "term",
				term: { kind: "session-user", field: "assigned_region" },
			},
		});
		expect(result.kind).toBe("eq");
		if (result.kind === "eq" && result.right.kind === "term") {
			expect(result.right.term.kind).toBe("session-user");
			if (result.right.term.kind === "session-user") {
				expect(result.right.term.field).toBe("assigned_region");
			}
		}
	});

	// `session-context` exposes the closed enum populated by
	// `addMetadata` at the same `SessionInstanceBuilder.java` symbol
	// anchor. Each of the four v1-exposed members
	// (`SESSION_CONTEXT_FIELDS`) is exercised here so a silent narrowing
	// of the enum on either the schema or the type-level constant trips
	// a row of the table.
	it.each(
		SESSION_CONTEXT_FIELDS,
	)("parses a session-context reference for field: %s", (field) => {
		const result = predicateSchema.parse({
			kind: "eq",
			left: asValueExpr({
				kind: "prop",
				caseType: "patient",
				property: "owner_id",
			}),
			right: asValueExpr({ kind: "session-context", field }),
		});
		expect(result.kind).toBe("eq");
		if (result.kind === "eq" && result.right.kind === "term") {
			expect(result.right.term.kind).toBe("session-context");
			if (result.right.term.kind === "session-context") {
				expect(result.right.term.field).toBe(field);
			}
		}
	});

	it("rejects session-context with an enum-miss field", () => {
		// `drift` is in the framework's `addMetadata` set at
		// `commcare-core/src/main/java/org/commcare/session/SessionInstanceBuilder.java`
		// but is intentionally excluded from `SESSION_CONTEXT_FIELDS` —
		// it's a diagnostic clock-skew signal with no authoring semantic
		// (see the `SESSION_CONTEXT_FIELDS` JSDoc in `types.ts` for the
		// rationale and for the parallel exclusions on `window_width` /
		// `applanguage`). Pinning the rejection here doubles as
		// documentation that the v1 narrowing is a deliberate authoring-
		// surface decision, not a coverage gap.
		expect(() =>
			predicateSchema.parse({
				kind: "eq",
				left: asValueExpr({
					kind: "prop",
					caseType: "patient",
					property: "owner_id",
				}),
				right: asValueExpr({ kind: "session-context", field: "drift" }),
			}),
		).toThrow();
	});

	it("rejects session-context with a bogus field outside the framework set", () => {
		// `not_a_metadata_key` is neither in the framework's full seven-
		// field set nor in v1's four-field narrowing. A regression that
		// loosened the schema to `z.string()` would silently accept this
		// payload and emit a wire string that returns empty at runtime.
		expect(() =>
			predicateSchema.parse({
				kind: "eq",
				left: asValueExpr({
					kind: "prop",
					caseType: "patient",
					property: "owner_id",
				}),
				right: asValueExpr({
					kind: "session-context",
					field: "not_a_metadata_key",
				}),
			}),
		).toThrow();
	});

	it("parses an in(...) with a non-empty literal list", () => {
		const result = predicateSchema.parse({
			kind: "in",
			left: asValueExpr({
				kind: "prop",
				caseType: "patient",
				property: "status",
			}),
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
			value: { kind: "term", term: { kind: "literal", value: "alice" } },
			mode: "fuzzy",
		});
		expect(result.kind).toBe("match");
		if (result.kind === "match") {
			expect(result.value).toEqual({
				kind: "term",
				term: { kind: "literal", value: "alice" },
			});
			expect(result.mode).toBe("fuzzy");
		}
	});

	// Each match mode dispatches to a different CCHQ wire form on the
	// CSQL target — `fuzzy-match` (verified at
	// `commcare-hq/corehq/apps/case_search/xpath_functions/query_functions.py::fuzzy_match`),
	// `phonetic-match` (`query_functions.py::phonetic_match`),
	// `fuzzy-date` (`query_functions.py::fuzzy_date`), and `starts-with`
	// (`query_functions.py::starts_with`). Pinning each mode through round-trip
	// parse locks the discriminator-only payload (`{ property, value,
	// mode }`) for every variant; a regression that dropped one mode
	// from the enum would surface here rather than at the emitter.
	// Iterating `MATCH_MODES` shares the source of truth with
	// `matchSchema` so adding a mode automatically extends the table.
	it.each(MATCH_MODES)("parses a match(...) with mode: %s", (mode) => {
		const result = predicateSchema.parse({
			kind: "match",
			property: { kind: "prop", caseType: "patient", property: "name" },
			value: { kind: "term", term: { kind: "literal", value: "alice" } },
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
	// `selected-any` / `selected-all` query functions (registered on
	// `commcare-hq/corehq/apps/case_search/xpath_functions/__init__.py::XPATH_QUERY_FUNCTIONS`).
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

	// All-null rejection mirrors the `inSchema` defense above. Both wire
	// targets collapse an all-null `multi-select-contains` to a
	// duplicated absence check — the CCHQ wire matches absent /
	// cleared / empty alike — see the source citations on
	// `multiSelectContainsSchema`'s `.refine(...)` for the per-target
	// dispatch. The canonical authoring shapes for the absence-check
	// intent are `is-null(prop)` (strict-absent, Postgres-only) and
	// `is-blank(prop)` (absent-or-empty, the CCHQ-portable form), not
	// a token list of nulls.
	it("rejects multi-select-contains where every value is null", () => {
		expect(() =>
			predicateSchema.parse({
				kind: "multi-select-contains",
				property: { kind: "prop", caseType: "patient", property: "tags" },
				values: [
					{ kind: "literal", value: null },
					{ kind: "literal", value: null },
				],
				quantifier: "any",
			}),
		).toThrow();
	});

	// Mixed null + non-null lists are accepted because they encode the
	// meaningful "absent OR / AND has token X" predicate. Pinning the
	// positive case keeps the rejection narrow to the all-null shape.
	it("accepts multi-select-contains with a single null value alongside non-null values", () => {
		const result = predicateSchema.parse({
			kind: "multi-select-contains",
			property: { kind: "prop", caseType: "patient", property: "tags" },
			values: [
				{ kind: "literal", value: null },
				{ kind: "literal", value: "vip" },
			],
			quantifier: "any",
		});
		expect(result.kind).toBe("multi-select-contains");
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
										left: asValueExpr({
											kind: "prop",
											caseType: "patient",
											property: "name",
										}),
										right: asValueExpr({
											kind: "literal",
											value: "Alice",
										}),
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
								left: asValueExpr({
									kind: "prop",
									caseType: "patient",
									property: "name",
								}),
								right: asValueExpr({ kind: "literal", value: "Bob" }),
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
				left: asValueExpr({
					kind: "prop",
					caseType: "patient",
					property: "name'); injected",
				}),
				right: asValueExpr({ kind: "literal", value: "x" }),
			}),
		).toThrow();
	});

	it("rejects prop with an XPath-injection-shaped case type", () => {
		expect(() =>
			predicateSchema.parse({
				kind: "eq",
				left: asValueExpr({
					kind: "prop",
					caseType: "patient' or 1=1",
					property: "name",
				}),
				right: asValueExpr({ kind: "literal", value: "x" }),
			}),
		).toThrow();
	});

	it("rejects input with a name containing internal whitespace", () => {
		expect(() =>
			predicateSchema.parse({
				kind: "eq",
				left: asValueExpr({
					kind: "prop",
					caseType: "patient",
					property: "name",
				}),
				right: asValueExpr({
					kind: "input",
					name: "bad name with spaces",
				}),
			}),
		).toThrow();
	});

	it("rejects session-user ref with a field containing punctuation", () => {
		// `session-user` is the open-namespace term, but `field` is still
		// constrained to XML element-name vocabulary so the slash-bearing
		// payload reaches the regex-rejection arm. A regression that
		// widened the field constraint to `z.string()` would silently
		// emit a broken wire form; this test pins the boundary.
		expect(() =>
			predicateSchema.parse({
				kind: "eq",
				left: asValueExpr({
					kind: "prop",
					caseType: "patient",
					property: "name",
				}),
				right: asValueExpr({
					kind: "session-user",
					field: "field/with/slashes",
				}),
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
				left: asValueExpr({
					kind: "prop",
					caseType: "patient",
					property: "",
				}),
				right: asValueExpr({ kind: "literal", value: "x" }),
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
				left: asValueExpr({
					kind: "prop",
					caseType: "patient",
					property: "name",
				}),
				right: asValueExpr({ kind: "input", name: "name-with-hyphen" }),
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
			left: asValueExpr({
				kind: "prop",
				caseType: "patient",
				property: "external-id",
			}),
			right: asValueExpr({ kind: "literal", value: "abc" }),
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
// (CHILD = 1, EXTENSION = 2 on
// `commcare-hq/corehq/form_processor/models/cases.py::CommCareCaseIndex`). The
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
		// the no-traversal arm) trips this test. Each arm of the union
		// is `.strict()`, so a payload with extra slots fails to parse
		// rather than silently stripping.
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
		// `commcare-hq/corehq/apps/case_search/xpath_functions/ancestor_functions.py::walk_ancestor_hierarchy`.
		// The single-hop
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
		// at `commcare-hq/corehq/apps/case_search/xpath_functions/subcase_functions.py::subcase`.
		// The
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
			left: asValueExpr({
				kind: "prop",
				caseType: "patient",
				property: "region",
				via: {
					kind: "ancestor",
					via: [{ identifier: "parent", throughCaseType: "household" }],
				},
			}),
			right: asValueExpr({ kind: "literal", value: "north" }),
		});
		expect(result.kind).toBe("eq");
		if (
			result.kind === "eq" &&
			result.left.kind === "term" &&
			result.left.term.kind === "prop"
		) {
			expect(result.left.term.via).toBeDefined();
			expect(result.left.term.via?.kind).toBe("ancestor");
		}
	});

	it("parses a property reference without via (no traversal)", () => {
		// Backward-compat lock: the historical no-`via` shape must
		// still parse and round-trip without the optional slot
		// surfacing as `via: undefined`. The shape below is exactly
		// what every existing builder call site produces; if the
		// schema's `.optional()` started materializing the absent
		// key, the assertion below would fail.
		// Predicate operands are wrapped in the structural `term` arm.
		const input = {
			kind: "eq" as const,
			left: asValueExpr({
				kind: "prop" as const,
				caseType: "patient",
				property: "status",
			}),
			right: asValueExpr({ kind: "literal" as const, value: "open" }),
		};
		const result = predicateSchema.parse(input);
		expect(result).toEqual(input);
		if (
			result.kind === "eq" &&
			result.left.kind === "term" &&
			result.left.term.kind === "prop"
		) {
			expect("via" in result.left.term).toBe(false);
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
			left: asValueExpr({
				kind: "prop",
				caseType: "patient",
				property: "status",
				via: { kind: "self" },
			}),
			right: asValueExpr({ kind: "literal", value: "open" }),
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
			left: asValueExpr({
				kind: "prop",
				caseType: "household",
				property: "status",
				via: {
					kind: "subcase",
					identifier: "parent",
					ofCaseType: "patient",
				},
			}),
			right: asValueExpr({ kind: "literal", value: "active" }),
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
			left: asValueExpr({
				kind: "prop",
				caseType: "patient",
				property: "linked_id",
				via: {
					kind: "any-relation",
					identifier: "linked",
					ofCaseType: "referral",
				},
			}),
			right: asValueExpr({ kind: "literal", value: "abc-123" }),
		});
		expect(result.kind).toBe("eq");
		if (
			result.kind === "eq" &&
			result.left.kind === "term" &&
			result.left.term.kind === "prop"
		) {
			expect(result.left.term.via).toEqual({
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
// zero-arg query functions registered on
// `commcare-hq/corehq/apps/case_search/xpath_functions/__init__.py::XPATH_QUERY_FUNCTIONS`
// and implemented at
// `commcare-hq/corehq/apps/case_search/xpath_functions/query_functions.py::match_all`
// and `query_functions.py::match_none` (each implementation rejects
// any argument with an `XPathFunctionException`).
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
		// Every arm in the predicate union is `.strict()`, so a stray key
		// on a discriminator-only payload fails to parse rather than
		// stripping silently. The pin enforces the discriminator-only
		// shape at the schema layer — a payload carrying anything other
		// than `kind` is rejected, matching the rest of the file's
		// strict-mode schemas.
		const parsed = predicateSchema.safeParse({
			kind: "match-all",
			ignored: "value",
		});
		expect(parsed.success).toBe(false);
	});
});

// `is-null` is the strict-absent predicate — the canonical form a UI
// surface or compiler reaches for to ask "is `left` resolved to absent
// (key not present in the JSONB / Map)?" Strict absence is the
// Postgres / in-memory semantic: `Map<string, string>` distinguishes
// "key not in map" from "key present with empty-string value" by
// construction, and JSONB does the same. The Predicate AST is
// Postgres-strict family-wide; CCHQ's wire collapse (where `prop = ''`
// matches absent / cleared / empty alike) is a per-dialect emitter
// concern + representability checker error, not an AST design
// constraint. The dialects diverge on representability — `is-null`
// is unrepresentable on every CCHQ wire target, while the parallel
// `is-blank` operator is portable.
//
// The `left` slot is `termSchema`, not `propertyRefSchema`, so authors
// can ask "is the input X absent" or "is the user's region absent"
// alongside the canonical "is the property absent" shape. The schema
// is intentionally structural-only: it admits every Term variant in
// `left` (including the meaningless `is-null(literal(...))` shape,
// which is a category error — a literal can't be "absent" by
// definition). Whether a checker rejects the literal shape is a
// type-checker concern, not a schema concern.
describe("is-null predicate", () => {
	it("parses is-null with a property reference", () => {
		const result = predicateSchema.parse({
			kind: "is-null",
			left: asValueExpr({
				kind: "prop",
				caseType: "patient",
				property: "status",
			}),
		});
		expect(result.kind).toBe("is-null");
	});

	it("parses is-null with a search-input reference", () => {
		const result = predicateSchema.parse({
			kind: "is-null",
			left: asValueExpr({ kind: "input", name: "phone" }),
		});
		expect(result.kind).toBe("is-null");
	});

	it("parses is-null with a session-user reference", () => {
		// `is-null(sessionUser(...))` asks "is the user-data field
		// unset" — a meaningful predicate at every wire target. The
		// schema accepts the open-namespace shape; the type checker's
		// per-arm rule decides whether the AST has authoring semantics.
		const result = predicateSchema.parse({
			kind: "is-null",
			left: asValueExpr({ kind: "session-user", field: "assigned_region" }),
		});
		expect(result.kind).toBe("is-null");
	});

	it("parses is-null with a session-context reference", () => {
		// Symmetric with the `session-user` case above. `userid` is a
		// closed-enum member; pinning its acceptance here locks the
		// `Term`-discriminated-union path through `is-null` for the
		// closed-namespace arm too.
		const result = predicateSchema.parse({
			kind: "is-null",
			left: asValueExpr({ kind: "session-context", field: "userid" }),
		});
		expect(result.kind).toBe("is-null");
	});

	it("parses is-null with a literal (schema is structurally permissive)", () => {
		// The schema accepts every Term variant in `left` (lifted
		// through the `term` arm of `ValueExpression`), including
		// literals. `is-null(literal(...))` is meaningless (literals
		// can't be "unset" by definition) but parses cleanly here;
		// rejecting the literal shape is a type-checker concern, not
		// a schema concern. Pinning the schema-side acceptance keeps
		// the layering explicit — a refactor that tightened the schema
		// to reject literal `left` would trip this test.
		const result = predicateSchema.parse({
			kind: "is-null",
			left: asValueExpr({ kind: "literal", value: "x" }),
		});
		expect(result.kind).toBe("is-null");
	});

	it("rejects is-null with no left", () => {
		expect(() => predicateSchema.parse({ kind: "is-null" })).toThrow();
	});
});

// `is-blank` is the portable absent-or-empty-string predicate — the
// canonical form for "left resolves to absent OR empty" semantics.
// Where `is-null` is strict (matches only the absent state),
// `is-blank` widens the match set to include the empty-string value
// too. The widening is the operator's purpose: `is-blank` is
// representable on every CCHQ wire target — wire form `prop = ''`
// (the on-device idiom for absent-or-empty; CSQL server-side
// `case_property_query()` short-circuits empty-value queries to
// `case_property_missing()` semantics at
// `commcare-hq/corehq/apps/es/case_search.py::case_property_query`),
// with the
// `if(count(input), real, match-all())` wrapper for input refs in
// case-list / post-ES dialects so absent inputs short-circuit
// cleanly. Authors who need a portable "field set / unset" check
// reach for `is-blank` rather than `is-null` and the wire layer
// emits a clean form. The schema is parallel-shaped to `isNullSchema`:
// same `left: termSchema`, same admission of every Term variant
// (including the meaningless literal shape, rejected by the type
// checker), same operand-validation handoff.
describe("is-blank predicate", () => {
	it("parses is-blank with a property reference", () => {
		const result = predicateSchema.parse({
			kind: "is-blank",
			left: asValueExpr({
				kind: "prop",
				caseType: "patient",
				property: "status",
			}),
		});
		expect(result.kind).toBe("is-blank");
	});

	it("parses is-blank with a search-input reference", () => {
		const result = predicateSchema.parse({
			kind: "is-blank",
			left: asValueExpr({ kind: "input", name: "phone" }),
		});
		expect(result.kind).toBe("is-blank");
	});

	it("parses is-blank with a session-user reference", () => {
		// `is-blank(sessionUser(...))` asks "is the user-data field
		// absent or empty" — a meaningful predicate at every wire
		// target (CCHQ wire collapses the two states and `is-blank` is
		// the natural CCHQ-portable form). The schema accepts the
		// open-namespace shape; the type checker's per-arm rule
		// decides whether the AST has authoring semantics.
		const result = predicateSchema.parse({
			kind: "is-blank",
			left: asValueExpr({ kind: "session-user", field: "assigned_region" }),
		});
		expect(result.kind).toBe("is-blank");
	});

	it("parses is-blank with a session-context reference", () => {
		// Symmetric with the `session-user` case above. `userid` is a
		// closed-enum member; pinning its acceptance here locks the
		// `Term`-discriminated-union path through `is-blank` for the
		// closed-namespace arm too.
		const result = predicateSchema.parse({
			kind: "is-blank",
			left: asValueExpr({ kind: "session-context", field: "userid" }),
		});
		expect(result.kind).toBe("is-blank");
	});

	it("parses is-blank with a literal (schema is structurally permissive)", () => {
		// The schema accepts every Term variant in `left` (lifted
		// through the `term` arm of `ValueExpression`), including
		// literals. `is-blank(literal(...))` is meaningless (a literal
		// is the value itself — it cannot be absent or
		// indistinguishable-from-empty in the way a property read can)
		// but parses cleanly here; rejecting the literal shape is a
		// type-checker concern, not a schema concern. Pinning the
		// schema-side acceptance keeps the layering explicit — a
		// refactor that tightened the schema to reject literal `left`
		// would trip this test.
		const result = predicateSchema.parse({
			kind: "is-blank",
			left: asValueExpr({ kind: "literal", value: "x" }),
		});
		expect(result.kind).toBe("is-blank");
	});

	it("rejects is-blank with no left", () => {
		expect(() => predicateSchema.parse({ kind: "is-blank" })).toThrow();
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
			left: asValueExpr({
				kind: "prop",
				caseType: "patient",
				property: "age",
			}),
			lower: asValueExpr({ kind: "literal", value: 18 }),
			upper: asValueExpr({ kind: "literal", value: 65 }),
			lowerInclusive: true,
			upperInclusive: true,
		});
		expect(result.kind).toBe("between");
	});

	it("parses a half-open range with only a lower bound", () => {
		const result = predicateSchema.parse({
			kind: "between",
			left: asValueExpr({
				kind: "prop",
				caseType: "patient",
				property: "age",
			}),
			lower: asValueExpr({ kind: "literal", value: 18 }),
			lowerInclusive: true,
			upperInclusive: true,
		});
		expect(result.kind).toBe("between");
	});

	it("parses a half-open range with only an upper bound", () => {
		const result = predicateSchema.parse({
			kind: "between",
			left: asValueExpr({
				kind: "prop",
				caseType: "patient",
				property: "age",
			}),
			upper: asValueExpr({ kind: "literal", value: 65 }),
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
			left: asValueExpr({
				kind: "prop",
				caseType: "patient",
				property: "age",
			}),
			lower: asValueExpr({ kind: "literal", value: 18 }),
			upper: asValueExpr({ kind: "literal", value: 65 }),
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
		// Bounds are `ValueExpression`, not literal-only — search-input,
		// session-user, or session-context refs (lifted via the `term`
		// arm) drive the bound at runtime. The pin locks that the schema
		// does NOT narrow `lower`/`upper` to literals the way
		// `inSchema.values` does (the latter has wire-target reasons to
		// demand a static list; bounds don't).
		const result = predicateSchema.parse({
			kind: "between",
			left: asValueExpr({
				kind: "prop",
				caseType: "patient",
				property: "age",
			}),
			lower: asValueExpr({ kind: "input", name: "min_age" }),
			upper: asValueExpr({ kind: "input", name: "max_age" }),
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
				left: asValueExpr({
					kind: "prop",
					caseType: "patient",
					property: "age",
				}),
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
				left: asValueExpr({
					kind: "prop",
					caseType: "patient",
					property: "age",
				}),
				lower: asValueExpr({ kind: "literal", value: 18 }),
				upper: asValueExpr({ kind: "literal", value: 65 }),
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
// `commcare-hq/corehq/apps/case_search/xpath_functions/subcase_functions.py::subcase`
// (filter-optional per the parser at
// `commcare-hq/corehq/apps/case_search/xpath_functions/subcase_functions.py::_extract_subcase_query_parts`)
// and `ancestor-exists` at
// `commcare-hq/corehq/apps/case_search/xpath_functions/ancestor_functions.py::ancestor_exists`
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
		// `commcare-hq/corehq/apps/case_search/xpath_functions/subcase_functions.py::_extract_subcase_query_parts`),
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
				left: asValueExpr({
					kind: "prop",
					caseType: "household",
					property: "region",
				}),
				right: asValueExpr({ kind: "literal", value: "north" }),
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
					left: asValueExpr({
						kind: "prop",
						caseType: "household",
						property: "status",
					}),
					right: asValueExpr({ kind: "literal", value: "active" }),
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
				left: asValueExpr({
					kind: "prop",
					caseType: "patient",
					property: "status",
				}),
				right: asValueExpr({ kind: "literal", value: "active" }),
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
// ---------- ValueExpression schema tests ----------
//
// `valueExpressionSchema` is the value-bearing sister AST to
// `predicateSchema` — every value slot in the system (calculated
// columns, search-input defaults, sort calculations, conditional
// operands inside a Predicate's comparison) composes through this
// union. The 14 arms are: `term` (the Term lifter), `today`, `now`,
// `date-add`, `date-coerce`, `datetime-coerce`, `double`, `arith`,
// `concat`, `coalesce`, `if`, `switch`, `count`, `unwrap-list`,
// `format-date`. The block below pins each arm with a parse round-
// trip; the recursive arms (`if` / `switch` / `count`) double as
// proofs that the cross-family `z.lazy(() => predicateSchema)`
// resolves at parse time, and the self-recursive arms (`arith`
// inside `arith`, `concat` inside `concat`, etc.) double as proofs
// that `z.lazy(() => valueExpressionSchema)` resolves too.

describe("valueExpression schema — leaf arms", () => {
	it("parses a term arm wrapping a property reference", () => {
		// The `term` arm is the structural lifter — every Term shape
		// reaches a value slot through this wrapper, and the predicate
		// operand builders auto-wrap Term inputs at the call boundary.
		// Pinning the explicit shape here locks the schema's
		// discriminator path into the union.
		const result = valueExpressionSchema.parse({
			kind: "term",
			term: { kind: "prop", caseType: "patient", property: "age" },
		});
		expect(result.kind).toBe("term");
	});

	it("parses a term arm wrapping a literal", () => {
		const result = valueExpressionSchema.parse({
			kind: "term",
			term: { kind: "literal", value: 42 },
		});
		expect(result.kind).toBe("term");
	});

	it("parses today() and now() (zero-payload constants)", () => {
		expect(valueExpressionSchema.parse({ kind: "today" }).kind).toBe("today");
		expect(valueExpressionSchema.parse({ kind: "now" }).kind).toBe("now");
	});

	it("rejects a term arm with no inner term", () => {
		expect(() => valueExpressionSchema.parse({ kind: "term" })).toThrow();
	});

	it("rejects an unknown ValueExpression kind", () => {
		expect(() => valueExpressionSchema.parse({ kind: "bogus" })).toThrow();
	});
});

describe("valueExpression schema — date / coercion arms", () => {
	it.each(
		DATE_ADD_INTERVALS,
	)("parses date-add with interval: %s", (interval) => {
		// `DATE_ADD_INTERVALS` is the closed enum of accepted
		// intervals. Iterating it ensures every member parses; a
		// regression that narrowed the enum on either the schema
		// or the type-level constant trips a row of this table.
		const result = valueExpressionSchema.parse({
			kind: "date-add",
			date: { kind: "today" },
			interval,
			quantity: asValueExpr({ kind: "literal", value: 1 }),
		});
		expect(result.kind).toBe("date-add");
	});

	it("rejects date-add with an interval outside the enum", () => {
		expect(() =>
			valueExpressionSchema.parse({
				kind: "date-add",
				date: { kind: "today" },
				interval: "fortnights",
				quantity: asValueExpr({ kind: "literal", value: 1 }),
			}),
		).toThrow();
	});

	it("parses date-coerce / datetime-coerce / double", () => {
		const inner = asValueExpr({ kind: "literal", value: "2024-01-01" });
		expect(
			valueExpressionSchema.parse({ kind: "date-coerce", value: inner }).kind,
		).toBe("date-coerce");
		expect(
			valueExpressionSchema.parse({ kind: "datetime-coerce", value: inner })
				.kind,
		).toBe("datetime-coerce");
		expect(
			valueExpressionSchema.parse({ kind: "double", value: inner }).kind,
		).toBe("double");
	});
});

describe("valueExpression schema — arithmetic + text arms", () => {
	it.each(ARITH_OPS)("parses arith with op: %s", (op) => {
		// The five-op enum is the canonical CCHQ-vocabulary set
		// (`+` / `-` / `*` / `div` / `mod`). Iterating it here pins
		// every op through the schema; a future widening to include
		// e.g. `**` would surface as a missing arm rather than a
		// silent acceptance gap.
		const result = valueExpressionSchema.parse({
			kind: "arith",
			op,
			left: asValueExpr({ kind: "literal", value: 1 }),
			right: asValueExpr({ kind: "literal", value: 2 }),
		});
		expect(result.kind).toBe("arith");
	});

	it("rejects arith with an op outside the enum", () => {
		expect(() =>
			valueExpressionSchema.parse({
				kind: "arith",
				op: "**",
				left: asValueExpr({ kind: "literal", value: 1 }),
				right: asValueExpr({ kind: "literal", value: 2 }),
			}),
		).toThrow();
	});

	it("parses concat with a single part (variadic-with-required-first)", () => {
		const result = valueExpressionSchema.parse({
			kind: "concat",
			parts: [asValueExpr({ kind: "literal", value: "x" })],
		});
		expect(result.kind).toBe("concat");
	});

	it("rejects an empty concat (tuple-with-rest enforces non-empty)", () => {
		expect(() =>
			valueExpressionSchema.parse({ kind: "concat", parts: [] }),
		).toThrow();
	});

	it("parses concat with multiple parts (recursion through the tuple-rest slot)", () => {
		const result = valueExpressionSchema.parse({
			kind: "concat",
			parts: [
				asValueExpr({ kind: "literal", value: "a" }),
				asValueExpr({ kind: "literal", value: "b" }),
				asValueExpr({ kind: "literal", value: "c" }),
			],
		});
		expect(result.kind).toBe("concat");
		if (result.kind === "concat") {
			expect(result.parts).toHaveLength(3);
		}
	});

	it("parses coalesce and rejects empty coalesce (parallel to concat)", () => {
		const filled = valueExpressionSchema.parse({
			kind: "coalesce",
			values: [
				asValueExpr({ kind: "literal", value: null }),
				asValueExpr({ kind: "literal", value: "fallback" }),
			],
		});
		expect(filled.kind).toBe("coalesce");
		expect(() =>
			valueExpressionSchema.parse({ kind: "coalesce", values: [] }),
		).toThrow();
	});
});

describe("valueExpression schema — conditional + aggregation arms", () => {
	// The `if` / `switch` arms cross the family boundary by carrying
	// `Predicate` operands (`if.cond`, plus `switch.cases[].when` is
	// a `Literal` not a Predicate — see the JSDoc on `switchCaseSchema`).
	// `count.where` also references `predicateSchema` via z.lazy. The
	// tests below exercise the cross-family resolution at parse time
	// — a regression that broke the lazy chain (e.g. dropped the
	// `z.lazy` wrapper) would not parse a recursive `if` containing
	// a real Predicate `cond`.

	it("parses if with a real Predicate cond", () => {
		const result = valueExpressionSchema.parse({
			kind: "if",
			cond: { kind: "match-all" },
			// biome-ignore lint/suspicious/noThenProperty: AST shape mirrors `ifSchema`; `then` holds a ValueExpression object, never a callable. See the JSDoc on `ifSchema` in types.ts for the full thenable-hazard analysis.
			then: asValueExpr({ kind: "literal", value: 1 }),
			else: asValueExpr({ kind: "literal", value: 0 }),
		});
		expect(result.kind).toBe("if");
	});

	it("parses if nested inside if (self-recursion through then / else)", () => {
		// Risk-bucket sort calculation shape:
		// `if(risk = 'Very Risky', 1, if(risk = 'Risky', 2, ...))`.
		// Nested-if composes through the schema's recursive then /
		// else slots — both branches are `ValueExpression`, so an
		// inner `if` lives inside its own `else`.
		const result = valueExpressionSchema.parse({
			kind: "if",
			cond: { kind: "match-all" },
			// biome-ignore lint/suspicious/noThenProperty: AST shape mirrors `ifSchema`; see types.ts for thenable-hazard analysis.
			then: asValueExpr({ kind: "literal", value: 1 }),
			else: {
				kind: "if",
				cond: { kind: "match-none" },
				// biome-ignore lint/suspicious/noThenProperty: AST shape mirrors `ifSchema`; see types.ts for thenable-hazard analysis.
				then: asValueExpr({ kind: "literal", value: 2 }),
				else: asValueExpr({ kind: "literal", value: 3 }),
			},
		});
		expect(result.kind).toBe("if");
	});

	it("parses switch with one case + fallback", () => {
		const result = valueExpressionSchema.parse({
			kind: "switch",
			on: asValueExpr({ kind: "literal", value: "low" }),
			cases: [
				{
					when: { kind: "literal", value: "low" },
					// biome-ignore lint/suspicious/noThenProperty: AST shape mirrors `switchCaseSchema`; see types.ts for thenable-hazard analysis.
					then: asValueExpr({ kind: "literal", value: 1 }),
				},
			],
			fallback: asValueExpr({ kind: "literal", value: 0 }),
		});
		expect(result.kind).toBe("switch");
	});

	it("rejects a switch with empty cases", () => {
		expect(() =>
			valueExpressionSchema.parse({
				kind: "switch",
				on: asValueExpr({ kind: "literal", value: "low" }),
				cases: [],
				fallback: asValueExpr({ kind: "literal", value: 0 }),
			}),
		).toThrow();
	});

	it("parses count with a relation walk and an optional where", () => {
		const result = valueExpressionSchema.parse({
			kind: "count",
			via: { kind: "subcase", identifier: "parent" },
			where: { kind: "match-all" },
		});
		expect(result.kind).toBe("count");
		if (result.kind === "count") {
			expect(result.where).toBeDefined();
		}
	});

	it("parses count with no where (degenerate to 'any related case')", () => {
		const result = valueExpressionSchema.parse({
			kind: "count",
			via: { kind: "ancestor", via: [{ identifier: "parent" }] },
		});
		expect(result.kind).toBe("count");
		if (result.kind === "count") {
			expect(result.where).toBeUndefined();
		}
	});
});

describe("valueExpression schema — unwrap-list + format-date", () => {
	it("parses unwrap-list with a text-shaped operand", () => {
		const result = valueExpressionSchema.parse({
			kind: "unwrap-list",
			value: asValueExpr({
				kind: "prop",
				caseType: "patient",
				property: "tags",
			}),
		});
		expect(result.kind).toBe("unwrap-list");
	});

	it.each(
		FORMAT_DATE_PRESETS,
	)("parses format-date with preset pattern: %s", (pattern) => {
		const result = valueExpressionSchema.parse({
			kind: "format-date",
			date: { kind: "today" },
			pattern,
		});
		expect(result.kind).toBe("format-date");
	});

	it("parses format-date with a custom pattern string", () => {
		const result = valueExpressionSchema.parse({
			kind: "format-date",
			date: { kind: "today" },
			pattern: "%Y-%m-%d %H:%M:%S",
		});
		expect(result.kind).toBe("format-date");
	});

	it("rejects format-date with an empty pattern string", () => {
		// The schema's union admits the preset enum or a `.min(1)`
		// string — a zero-length pattern is rejected at parse time so
		// downstream emitters don't have to encode the policy.
		expect(() =>
			valueExpressionSchema.parse({
				kind: "format-date",
				date: { kind: "today" },
				pattern: "",
			}),
		).toThrow();
	});
});

describe("valueExpression schema — cross-family cycle through predicate operands", () => {
	// The cross-family cycle (Predicate operands → ValueExpression →
	// Predicate inside `if` / `count`) is the load-bearing recursion
	// of the operand widening. The test below threads a Predicate
	// (`is-blank` of a property) into a ValueExpression (`if`'s
	// cond), which then compares against a literal in the
	// surrounding predicate's `right` slot — proving the lazy chain
	// resolves cleanly across the family boundary.

	it("parses a comparison whose left is an if-expression with a real Predicate cond", () => {
		const result = predicateSchema.parse({
			kind: "eq",
			left: {
				kind: "if",
				cond: {
					kind: "is-blank",
					left: asValueExpr({
						kind: "prop",
						caseType: "patient",
						property: "name",
					}),
				},
				// biome-ignore lint/suspicious/noThenProperty: AST shape mirrors `ifSchema`; see types.ts for thenable-hazard analysis.
				then: asValueExpr({ kind: "literal", value: "(empty)" }),
				else: asValueExpr({
					kind: "prop",
					caseType: "patient",
					property: "name",
				}),
			},
			right: asValueExpr({ kind: "literal", value: "(empty)" }),
		});
		expect(result.kind).toBe("eq");
	});
});
