// lib/domain/predicate/__tests__/builders.test.ts
//
// Acceptance tests for the typed predicate builders. Two things every
// builder test confirms:
//   1. The constructed AST has the right `kind` discriminator (so
//      consumers narrowing on `kind` get the correct variant typing).
//   2. The constructed AST round-trips through `predicateSchema.parse`
//      without modification — i.e. the builder layer cannot produce an
//      AST that the schema would reject.
//
// The round-trip check is the load-bearing assertion: it locks the
// builder layer against drift from the schema. If the schema gains a
// new required field on (say) `within-distance` and the matching
// builder isn't updated, every `within` test goes red simultaneously.

import { describe, expect, it } from "vitest";
import {
	and,
	eq,
	fuzzy,
	gt,
	input,
	literal,
	not,
	or,
	prop,
	whenInput,
	within,
} from "../builders";
import { predicateSchema } from "../types";

describe("predicate builders", () => {
	it("constructs an eq comparison via builders", () => {
		const p = eq(prop("patient", "status"), literal("open"));
		expect(p.kind).toBe("eq");
		// The resulting AST must round-trip through Zod parse.
		expect(predicateSchema.parse(p)).toEqual(p);
	});

	it("constructs a nested and(eq, gt) predicate", () => {
		const p = and(
			eq(prop("patient", "status"), literal("open")),
			gt(prop("patient", "age"), literal(18)),
		);
		expect(p.kind).toBe("and");
		// Narrow before accessing `.clauses` — the union type only
		// surfaces that field on the `and` arm.
		if (p.kind === "and") {
			expect(p.clauses).toHaveLength(2);
		}
		expect(predicateSchema.parse(p)).toEqual(p);
	});

	it("constructs a within-distance predicate", () => {
		const p = within(
			prop("clinic", "location"),
			input("user_location"),
			50,
			"miles",
		);
		expect(p.kind).toBe("within-distance");
		if (p.kind === "within-distance") {
			expect(p.unit).toBe("miles");
		}
		expect(predicateSchema.parse(p)).toEqual(p);
	});

	it("constructs when-input-present wrapping an eq", () => {
		const p = whenInput(
			input("phone_number"),
			eq(prop("patient", "phone"), input("phone_number")),
		);
		expect(p.kind).toBe("when-input-present");
		// The body slot is named `clause` (not `then`) — see the JSDoc
		// on `whenInputPresentSchema` in `types.ts` for the rationale.
		if (p.kind === "when-input-present") {
			expect(p.clause.kind).toBe("eq");
		}
		expect(predicateSchema.parse(p)).toEqual(p);
	});

	it("constructs or(not(...), fuzzy(...))", () => {
		const p = or(
			not(eq(prop("patient", "status"), literal("closed"))),
			fuzzy(prop("patient", "name"), "alice"),
		);
		expect(p.kind).toBe("or");
		if (p.kind === "or") {
			expect(p.clauses[0].kind).toBe("not");
			expect(p.clauses[1].kind).toBe("fuzzy");
		}
		expect(predicateSchema.parse(p)).toEqual(p);
	});
});
