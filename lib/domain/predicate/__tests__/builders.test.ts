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
// new required field on a builder's target arm and the matching builder
// isn't updated, the round-trip parse for that builder fails — the new
// required field is missing from the constructed AST, so
// `predicateSchema.parse(p)` throws.
//
// Because the builders return precise per-operator types (rather than
// the full `Predicate` union), tests access fields like `p.clauses`,
// `p.clause`, `p.values` directly without `if (p.kind === "...")`
// re-narrowing. The continued absence of those guards is itself a
// regression check — if a future refactor widens a builder return type
// back to `Predicate`, the field accesses below would stop compiling.

import { describe, expect, it } from "vitest";
import {
	and,
	eq,
	fuzzy,
	gt,
	gte,
	input,
	isIn,
	literal,
	lt,
	lte,
	neq,
	not,
	or,
	prop,
	userField,
	whenInput,
	within,
} from "../builders";
import { predicateSchema } from "../types";

describe("predicate builders", () => {
	it("constructs a nested and(eq, gt) predicate", () => {
		const p = and(
			eq(prop("patient", "status"), literal("open")),
			gt(prop("patient", "age"), literal(18)),
		);
		expect(p.kind).toBe("and");
		// `p.clauses` is directly accessible — `and` returns the precise
		// `{ kind: "and"; clauses: Predicate[] }` shape, not the wider
		// `Predicate` union. If a future refactor widens this back to
		// `Predicate`, this line stops compiling.
		expect(p.clauses).toHaveLength(2);
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
		expect(p.unit).toBe("miles");
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
		expect(p.clause.kind).toBe("eq");
		expect(predicateSchema.parse(p)).toEqual(p);
	});

	it("constructs or(not(...), fuzzy(...))", () => {
		const p = or(
			not(eq(prop("patient", "status"), literal("closed"))),
			fuzzy(prop("patient", "name"), "alice"),
		);
		expect(p.kind).toBe("or");
		expect(p.clauses[0].kind).toBe("not");
		expect(p.clauses[1].kind).toBe("fuzzy");
		expect(predicateSchema.parse(p)).toEqual(p);
	});

	// Coverage parity for builders that lacked a dedicated test before.
	// `userField` is exported but only structurally implied through
	// other builders; pinning it here prevents a silent rename/removal
	// from passing CI. `isIn` likewise needs an explicit happy-path
	// test (the variadic-with-required-first contract is tested
	// separately via the type-level guard at the bottom of this file).

	it("constructs a userField reference round-tripping inside a comparison", () => {
		const t = userField("region");
		expect(t.kind).toBe("user");
		// Wrap in an eq so the term flows through `predicateSchema` —
		// terms don't parse standalone via `predicateSchema`.
		const p = eq(t, literal("north"));
		expect(predicateSchema.parse(p)).toEqual(p);
	});

	it("constructs an isIn membership predicate", () => {
		const p = isIn(
			prop("patient", "status"),
			literal("open"),
			literal("active"),
		);
		expect(p.kind).toBe("in");
		expect(p.values).toHaveLength(2);
		expect(predicateSchema.parse(p)).toEqual(p);
	});

	// Parameterized comparison coverage. The original tests only
	// exercised `eq` and `gt` directly; the other four shared the same
	// curried helper and risked silent drift if the helper's per-kind
	// return-type pinning broke. Exercising all six in a single
	// parameterized test keeps the file compact while pinning each
	// kind's `kind` discriminator and round-trip parse.

	it.each([
		"eq",
		"neq",
		"gt",
		"gte",
		"lt",
		"lte",
	] as const)("constructs a %s comparison that round-trips", (opName) => {
		const op = { eq, neq, gt, gte, lt, lte }[opName];
		const p = op(prop("patient", "age"), literal(18));
		expect(p.kind).toBe(opName);
		expect(predicateSchema.parse(p)).toEqual(p);
	});

	// Variadic-with-required-first boundary check. The single-clause
	// case is the smallest valid input; verifying it parses confirms
	// the spread-into-array path works at the lower bound of the
	// schema's `.min(1)` constraint.

	it("accepts a single-clause and / or / isIn (variadic min-1 boundary)", () => {
		const single = eq(prop("patient", "status"), literal("open"));
		const a = and(single);
		const o = or(single);
		const i = isIn(prop("patient", "status"), literal("open"));
		expect(predicateSchema.parse(a)).toEqual(a);
		expect(predicateSchema.parse(o)).toEqual(o);
		expect(predicateSchema.parse(i)).toEqual(i);
	});
});

/* --- Type-level tests -------------------------------------------------
 *
 * Compile-time regression lock for the variadic-with-required-first
 * contract on `and`, `or`, and `isIn`. If any of these builders are
 * loosened to plain `...args: T[]`, the `@ts-expect-error` directives
 * stop matching a real TypeScript error and the test file fails to
 * compile — Vitest treats the broken transform as a test failure.
 *
 * Calls are guarded behind a `neverRun` branch so the references don't
 * execute at runtime — the directives ARE the assertions, not any
 * runtime behavior. (Pattern borrowed from
 * `lib/mcp/__tests__/createApp.test.ts`.)
 */
function typeCheckVariadicMinOne(): void {
	const neverRun = false;
	if (neverRun) {
		// @ts-expect-error — and() with no arguments must not type-check
		void and();
		// @ts-expect-error — or() with no arguments must not type-check
		void or();
		// @ts-expect-error — isIn requires a left term and at least one literal
		void isIn(prop("patient", "status"));
	}
}
/* Reference the guard so lint doesn't flag it as unused — the
 * directives inside are what the compiler enforces. */
void typeCheckVariadicMinOne;
