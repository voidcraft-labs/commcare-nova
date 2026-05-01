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
});
