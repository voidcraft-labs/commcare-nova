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

	// Each exported builder gets at least one explicit happy-path test
	// here: silent rename or removal of any export must not pass CI.
	// `userField`, `isIn`, and `fuzzy` would otherwise be only
	// structurally implied via other builders' arguments or composite
	// tests. (The `isIn` variadic-with-required-first contract is
	// locked separately by the type-level guard at the bottom of this
	// file.)

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

	it("constructs a fuzzy match predicate", () => {
		const p = fuzzy(prop("patient", "name"), "alice");
		expect(p.kind).toBe("fuzzy");
		expect(p.value).toBe("alice");
		expect(predicateSchema.parse(p)).toEqual(p);
	});

	// All six comparison operators share one curried helper, so a
	// regression in the helper's per-kind return-type pinning could
	// silently widen any one of them. Exercising all six in a single
	// parameterized test pins each kind's `kind` discriminator and
	// round-trip parse without restating six near-identical bodies.

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
 * contract on `and`, `or`, and `isIn`. The `@ts-expect-error`
 * directives below are the assertions: each one expects a real
 * TypeScript error on the call beneath it. If any builder is loosened
 * to plain `...args: T[]`, the matching call becomes valid, the
 * directive becomes unused, and TypeScript emits TS2578.
 *
 * Enforcement surface: `npm run typecheck`, wired into lefthook
 * pre-push. The push fails before the change lands. Vitest itself does
 * not type-check sources by default, so the runtime test runner is not
 * the gate here — the type checker is.
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

/* --- Per-kind comparison narrowing lock -------------------------------
 *
 * The `comparison` curried factory's reason for existing is to produce
 * six per-kind narrowed constructors — `eq` returns
 * `ComparisonPredicate<"eq">`, not `ComparisonPredicate<ComparisonKind>`.
 * Without this lock, a regression that widened the factory's return
 * type generic (e.g. annotating the inner function's return as
 * `ComparisonPredicate<ComparisonKind>`) would silently collapse all
 * six exports back to one shape and call-site narrowing would be lost.
 *
 * The form is "assign a value of type `ReturnType<typeof <op>>["kind"]`
 * to a variable typed as the literal kind." If the factory widens, the
 * source type becomes `ComparisonKind` and the narrow target rejects
 * it → TS2322 fires. The mirror direction `<literal> satisfies
 * <return-kind>` does NOT catch this regression: `"eq" satisfies
 * ComparisonKind` is trivially valid because `"eq"` extends
 * `ComparisonKind`. The assignment direction is the asymmetric one,
 * which is what we need.
 *
 * Same `npm run typecheck` enforcement surface as the variadic block
 * above: lefthook pre-push runs it before the push lands.
 */
function typeCheckComparisonNarrowing(): void {
	const neverRun = false;
	if (neverRun) {
		// One assertion per export. If the curried factory regresses,
		// every line below fires; one would suffice but six is explicit
		// about the intended six-way narrowing the factory promises.
		const _eq: "eq" = null as unknown as ReturnType<typeof eq>["kind"];
		const _neq: "neq" = null as unknown as ReturnType<typeof neq>["kind"];
		const _gt: "gt" = null as unknown as ReturnType<typeof gt>["kind"];
		const _gte: "gte" = null as unknown as ReturnType<typeof gte>["kind"];
		const _lt: "lt" = null as unknown as ReturnType<typeof lt>["kind"];
		const _lte: "lte" = null as unknown as ReturnType<typeof lte>["kind"];
		void _eq;
		void _neq;
		void _gt;
		void _gte;
		void _lt;
		void _lte;
	}
}
void typeCheckComparisonNarrowing;
