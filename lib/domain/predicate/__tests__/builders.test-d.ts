// Compiler-only builder contracts, checked by npm run typecheck.
import {
	and,
	eq,
	type gt,
	type gte,
	isIn,
	literal,
	type lt,
	type lte,
	matchAll,
	matchNone,
	multiSelectAll,
	multiSelectAny,
	type neq,
	not,
	or,
	prop,
	term,
} from "../builders";
import type { Predicate, RelationPath } from "../types";

/* --- Type-level tests -------------------------------------------------
 *
 * Compile-time regression lock for the variadic-with-required-first
 * contract on `isIn`, `multiSelectAny`, and `multiSelectAll`. The
 * `@ts-expect-error` directives below are the assertions: each one
 * expects a real TypeScript error on the call beneath it. If any
 * builder is loosened to plain `...args: T[]`, the matching call
 * becomes valid, the directive becomes unused, and TypeScript emits
 * TS2578.
 *
 * Why `and` / `or` are NOT in this block: the construction-time
 * reductions in `reduction.ts` collapse the empty argument list to a
 * sentinel (`and()` → `match-all`, `or()` → `match-none`), so the
 * zero-argument call is now a legitimate API surface — locking it as
 * a compile-time error would conflict with the documented behavior.
 * The remaining variadic builders (`isIn`, `multiSelectAny`,
 * `multiSelectAll`) have no parallel reduction: their value lists are
 * literal-only and the canonical "empty" shape isn't a sentinel, so
 * the empty-list rejection stays at the type layer.
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
		// @ts-expect-error — isIn requires a left term and at least one literal
		void isIn(prop("patient", "status"));
		// `multiSelectAny` / `multiSelectAll` require at least one literal
		// in `values`. The schema's tuple-with-rest shape rejects an empty
		// array at parse time; the variadic-with-required-first signature
		// lifts the rejection to the type layer so the failure surfaces at
		// the call site rather than at runtime.
		// @ts-expect-error — multiSelectAny requires at least one literal
		void multiSelectAny(prop("patient", "tags"));
		// @ts-expect-error — multiSelectAll requires at least one literal
		void multiSelectAll(prop("patient", "tags"));
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

/* --- Reduction-overload narrowing lock --------------------------------
 *
 * `and` / `or` / `not` are declared as overload sets so each call
 * shape's return type is precisely pinned: `and()` returns
 * `match-all`, `and(x)` returns `T` (the inner clause's type),
 * `and(x, y, ...)` returns `Extract<Predicate, { kind: "and" }>`, and
 * the parallel set on `or` / `not`. The narrowing matters because the
 * rest of this file's contract — `and(...).clauses` directly
 * accessible without re-narrowing in the n-ary case, `not(eq(...))
 * .clause` accessible without re-narrowing in the catch-all case —
 * depends on the precise per-overload return shape.
 *
 * The form is "assign the builder result to a variable typed as the
 * expected narrow shape." If a future regression collapses any
 * overload to `Predicate`, the assignment becomes invalid → TS2322
 * fires on the matching line. Same enforcement surface as
 * `typeCheckComparisonNarrowing` above (`npm run typecheck` via
 * lefthook pre-push).
 */
function typeCheckReductionNarrowing(): void {
	const neverRun = false;
	if (neverRun) {
		const x = eq(prop("patient", "status"), literal("open"));
		// `and()` empty → match-all sentinel
		const _emptyAnd: Extract<Predicate, { kind: "match-all" }> = and();
		// `or()` empty → match-none sentinel
		const _emptyOr: Extract<Predicate, { kind: "match-none" }> = or();
		// `and(x)` single → identity (returns x's exact type)
		const _singleAnd: typeof x = and(x);
		// `or(x)` single → identity
		const _singleOr: typeof x = or(x);
		// `and(x, y)` n-ary → precise and-arm
		const _nAnd: Extract<Predicate, { kind: "and" }> = and(x, x);
		// `or(x, y)` n-ary → precise or-arm
		const _nOr: Extract<Predicate, { kind: "or" }> = or(x, x);
		// `not(matchAll())` → match-none
		const _notMA: Extract<Predicate, { kind: "match-none" }> = not(matchAll());
		// `not(matchNone())` → match-all
		const _notMN: Extract<Predicate, { kind: "match-all" }> = not(matchNone());
		// `not(eq(...))` catch-all → precise not-arm. `_notEq.clause` is
		// directly accessible without `if (_notEq.kind === "not")` — the
		// load-bearing assertion the file-level comment in `builders.ts`
		// promises.
		const _notEq: Extract<Predicate, { kind: "not" }> = not(x);
		void _notEq.clause;
		void _emptyAnd;
		void _emptyOr;
		void _singleAnd;
		void _singleOr;
		void _nAnd;
		void _nOr;
		void _notMA;
		void _notMN;
		void _notEq;
	}
}
void typeCheckReductionNarrowing;

/* --- Empty-collection construction-site lock --------------------------
 *
 * `and`, `or`, `isIn`, and `ancestorPath` return shapes whose schema
 * enforces non-emptiness via Zod 4's tuple-with-rest idiom
 * (`z.tuple([T], T)` infers as `[T, ...T[]]`). At construction sites,
 * the tuple shape rejects empty-array literals at compile time —
 * `{ kind: "and", clauses: [] }` is `Predicate[]`-acceptable but not
 * `[Predicate, ...Predicate[]]`-acceptable. The directives below pin
 * that distinction so a regression to `z.array(T).min(1)` surfaces as
 * an unused `@ts-expect-error` (TS2578).
 *
 * Why the schema check still matters when the builders apply
 * reductions: the `and` / `or` builders thread their inputs through
 * the construction-time reductions in `reduction.ts` and never
 * construct an empty-clauses literal. But code that bypasses the
 * builders — directly composing an AST literal, or parsing
 * persisted JSON via `predicateSchema.parse(...)` — must still be
 * rejected for the empty-clauses shape. This block is the
 * compile-time guard for the direct-literal path; the schema's
 * tuple-with-rest is the runtime guard for the parse path. Both
 * stay in place even after the builders started swallowing empty
 * input.
 *
 * Note on scope: this block does NOT lock the indexed-access form
 * `result.clauses[0]`. Without `noUncheckedIndexedAccess` enabled in
 * the project's `tsconfig.json`, both `T[]` and `[T, ...T[]]` index-
 * access to `T` (not `T | undefined`), so an indexed-access assertion
 * would not differentiate between the two schema shapes — it would
 * pass under both. The construction-site form is the only one that
 * actually fires under the project's current strictness configuration.
 */
function typeCheckNonEmptyConstructionSite(): void {
	const neverRun = false;
	if (neverRun) {
		// `@ts-expect-error` suppresses the error on the following
		// line. The TS error lands on the property line carrying the
		// empty literal (the `clauses: []` / `values: []` / `via: []`
		// line), so the directive is placed directly above each.
		const _emptyAnd: Extract<Predicate, { kind: "and" }> = {
			kind: "and",
			// @ts-expect-error — `clauses: []` violates the tuple-with-rest non-empty shape
			clauses: [],
		};
		const _emptyOr: Extract<Predicate, { kind: "or" }> = {
			kind: "or",
			// @ts-expect-error — `clauses: []` violates the tuple-with-rest non-empty shape
			clauses: [],
		};
		const _emptyIn: Extract<Predicate, { kind: "in" }> = {
			kind: "in",
			left: term(literal(0)),
			// @ts-expect-error — `values: []` violates the tuple-with-rest non-empty shape
			values: [],
		};
		const _emptyAncestor: Extract<RelationPath, { kind: "ancestor" }> = {
			kind: "ancestor",
			// @ts-expect-error — `via: []` violates the tuple-with-rest non-empty shape
			via: [],
		};
		const _emptyMultiSelect: Extract<
			Predicate,
			{ kind: "multi-select-contains" }
		> = {
			kind: "multi-select-contains",
			property: { kind: "prop", caseType: "patient", property: "tags" },
			// @ts-expect-error — `values: []` violates the tuple-with-rest non-empty shape
			values: [],
			quantifier: "any",
		};
		void _emptyAnd;
		void _emptyOr;
		void _emptyIn;
		void _emptyAncestor;
		void _emptyMultiSelect;
	}
}
void typeCheckNonEmptyConstructionSite;
