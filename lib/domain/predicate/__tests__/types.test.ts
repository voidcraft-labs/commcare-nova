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
import { predicateSchema, termSchema } from "../types";

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
	// `and` test above exercises one of them; the explicit `not(...)`
	// and `when-input-present(...)` tests below cover the other two
	// (the `or(...)` shape is identical to `and(...)`). These also
	// pin the field name `clause` (not `then`) so any revert to
	// the rejected `then` name fails CI immediately.

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
});
