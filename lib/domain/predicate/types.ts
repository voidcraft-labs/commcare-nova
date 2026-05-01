// lib/domain/predicate/types.ts
//
// Predicate AST. Source of truth for every filter, sort key, calculated
// column, search input default, and default search filter in the case-list
// and search system. Compiled to CommCare XPath/CSQL at HQ wire emission
// and to Kysely query-builder calls at runtime — never round-tripped
// through strings.
//
// Why an AST instead of strings: every authored predicate must compile to
// two different targets (CommCare XPath/CSQL going up to HQ, Kysely SQL
// running locally) AND drive an editing UI. A string-only representation
// would force a parser at every boundary; storing the AST keeps each
// surface as a one-way emitter and locks the semantics in one place.
// Concretely, this is the structural defense against the
// accretion-and-untyped-strings pattern that produced CommCare HQ's
// case-search XPath dialect over 25 years — every new capability there
// became another function added to the same untyped expression
// language. By forcing every authored predicate through this typed
// AST, that pattern is structurally prevented here. (See the design
// spec at docs/superpowers/specs/2026-04-30-case-list-search-design.md
// "Design properties — the quality bar" for the full rationale.)
//
// The AST uses Zod-discriminated unions on a `kind` field, matching
// Nova's existing patterns (see `lib/domain/fields/index.ts` for the
// flagship example). New operators are explicit additions to the union;
// behavior is never tucked under existing kinds via hidden state.
//
// Recursive shape note: `and` / `or` / `not` / `when-input-present`
// reference the predicate union itself. The cycle goes through a
// `z.discriminatedUnion(...)` (not a single self-referencing object), so
// the cleanest Zod 4 fallback documented for union recursion applies —
// each recursive slot wraps its predicate reference in `z.lazy(...)`,
// and `predicateSchema` carries an explicit `z.ZodType<Predicate>`
// annotation. The block below the operators explains why.

import { z } from "zod";

// ---------- Terms (anything that resolves to a value) ----------
//
// Terms are the leaves of the AST. They never contain predicates and so
// are not recursive. Each term variant is a flat `z.object` joined by a
// flat `z.discriminatedUnion("kind", ...)`. Compilers pattern-match on
// `kind` and emit the corresponding XPath/SQL node.

/**
 * Reference to a property on a specific case type. The `caseType`
 * qualifier matters: a search-detail predicate may reach across the
 * primary case type and a related parent (`patient` → `clinic`), so the
 * AST records WHICH case type the property lives on rather than relying
 * on positional context.
 */
export const propertyRefSchema = z.object({
	kind: z.literal("prop"),
	caseType: z.string(),
	property: z.string(),
});
export type PropertyRef = z.infer<typeof propertyRefSchema>;

/**
 * Reference to a value the user typed into a search input on the
 * case-search screen. Resolved at compile time by mapping `name` to the
 * search input's runtime value (XPath: `instance('commcaresession')...`
 * or similar; SQL: a bound parameter).
 */
export const searchInputRefSchema = z.object({
	kind: z.literal("input"),
	name: z.string(),
});
export type SearchInputRef = z.infer<typeof searchInputRefSchema>;

/**
 * Reference to a field on the current session user (e.g. their assigned
 * region, their role). Compiled to `instance('commcaresession')/.../user/data/<field>`
 * on the XPath side and to a request-context parameter on the SQL side.
 */
export const userContextRefSchema = z.object({
	kind: z.literal("user"),
	field: z.string(),
});
export type UserContextRef = z.infer<typeof userContextRefSchema>;

/**
 * A primitive constant. Numbers, booleans, and `null` are first-class
 * (rather than serialized to strings) so the type checker can validate
 * compatibility with the referenced property's data type without
 * round-tripping through string parsing.
 */
export const literalSchema = z.object({
	kind: z.literal("literal"),
	value: z.union([z.string(), z.number(), z.boolean(), z.null()]),
});
export type Literal = z.infer<typeof literalSchema>;

export const termSchema = z.discriminatedUnion("kind", [
	propertyRefSchema,
	searchInputRefSchema,
	userContextRefSchema,
	literalSchema,
]);
export type Term = z.infer<typeof termSchema>;

// ---------- Predicate operators (anything that resolves to a boolean) ----------

/**
 * Comparison operators. Keeping them in a single tuple lets the schema
 * narrow them collectively (`z.enum(COMPARISON_KINDS)`) and lets the
 * compilers iterate the set when emitting (one mapping table for all
 * six). Strict ordering doesn't matter — the type checker treats the
 * set as semantically equivalent up to operand-type rules.
 *
 * The enum collapse is correct *only because all six share the same
 * operand shape* (`left`/`right`, both `termSchema`). If a future
 * operator needs an asymmetric field — e.g. `case_sensitive` only on
 * `eq`/`neq` — split the enum back into per-literal arms (one
 * `z.object` per operator) rather than tacking optional fields onto
 * this schema. Smuggling per-operator behavior under an optional
 * shared field would violate the design property "behavior is never
 * tucked under existing kinds via hidden state".
 */
const COMPARISON_KINDS = ["eq", "neq", "gt", "gte", "lt", "lte"] as const;
export type ComparisonKind = (typeof COMPARISON_KINDS)[number];

const comparisonSchema = z.object({
	kind: z.enum(COMPARISON_KINDS),
	left: termSchema,
	right: termSchema,
});

/**
 * Membership: `left` ∈ `values`. Right side is restricted to literals
 * (not arbitrary terms) because the wire targets — XPath `selected-any`
 * / SQL `IN (...)` — both demand a static value list.
 *
 * `values` is `.min(1)`: an empty `in(...)` is trivially false at every
 * target and is virtually always an authoring bug (e.g. a filter UI
 * that bound to an unset variable). Reject at the AST layer so
 * downstream compilers don't have to encode the policy.
 */
const inSchema = z.object({
	kind: z.literal("in"),
	left: termSchema,
	values: z.array(literalSchema).min(1),
});

/**
 * Distance units accepted by `within-distance`. Pattern mirrors
 * `COMPARISON_KINDS` above: a local `as const` tuple feeds the schema
 * via `z.enum(...)`, and the exported `DistanceUnit` type derives from
 * it so the builder's `unit` parameter shares this single source of
 * truth. Adding a unit (e.g. `"meters"`) here automatically expands
 * the builder's accepted argument set rather than silently letting
 * the builder reject what the schema accepts.
 */
const DISTANCE_UNITS = ["miles", "kilometers"] as const;
export type DistanceUnit = (typeof DISTANCE_UNITS)[number];

/**
 * Geo predicate: include cases whose `property` (a geopoint) lies
 * within `distance` of `center`. `property` is constrained to a direct
 * property reference (the geopoint can't be a literal or an input —
 * those shapes don't make geometric sense), but `center` is a
 * full term so a search-input geopoint or a session user location
 * can drive the query.
 *
 * `distance` is `.nonnegative()` — a negative radius is geometrically
 * meaningless and would propagate to two compilers (XPath/CSQL and
 * Kysely) that don't share a rejection layer. Reject at the AST. Zod
 * 4's `z.number()` already rejects `NaN` and `±Infinity`, so the only
 * structural concern left here is the sign.
 */
const withinDistanceSchema = z.object({
	kind: z.literal("within-distance"),
	property: propertyRefSchema,
	center: termSchema,
	distance: z.number().nonnegative(),
	unit: z.enum(DISTANCE_UNITS),
});

/**
 * Phonetic / fuzzy match. Like `within-distance`, the left side must be
 * a direct property reference — fuzzy match against a literal or input
 * is meaningless. The right side is a string (not a term) because the
 * operator is unambiguously textual at every target.
 */
const fuzzySchema = z.object({
	kind: z.literal("fuzzy"),
	property: propertyRefSchema,
	value: z.string(),
});

// ---------- Recursive predicate operators ----------
//
// `and`, `or`, `not`, and `when-input-present` reference the predicate
// union itself. Two distinct constraints converge here:
//
//   1. Runtime — Zod 4's getter pattern (the documented v4 idiom for
//      self-referential objects, e.g. `Category` referencing
//      `Category`) fails when the recursion goes through a
//      `z.discriminatedUnion(...)`. The union's constructor eagerly
//      reads each member's shape to build the discriminator-to-arm
//      lookup table, and the cycle never resolves because the union
//      doesn't exist yet when the arms are declared.
//      `z.lazy(() => predicateSchema)` defers the access until the
//      first parse, after `predicateSchema`'s `const` binding is
//      complete, so the cycle resolves at use time.
//      (Zod issue #4264.)
//
//   2. TypeScript — TypeScript cannot resolve `z.infer` through a
//      recursive union; recent versions either collapse the chain to
//      `any` or reject the whole expression as a circular mapped type
//      (Zod issue #5035 details the TS 5.9+ behavior). The four
//      recursive arms of `Predicate` are therefore hand-declared, and
//      `predicateSchema` carries an explicit `z.ZodType<Predicate>`
//      annotation so the schema's runtime shape and the hand-declared
//      type stay reconciled. The drift guard at the bottom of this
//      file catches divergence between the hand-declared arms and the
//      schemas' inferred shapes.
//
// Why one schema per recursive operator instead of inlining them in
// the `discriminatedUnion(...)` call: `z.discriminatedUnion` requires
// each member to be a single object schema carrying the discriminant
// key. Defining each as a named const keeps the union list readable
// and lets each operator's contract live next to its discriminator
// declaration.

// `clauses` on `andSchema` and `orSchema` is `.min(1)`: an empty `and`
// trivially evaluates to `true` and an empty `or` trivially evaluates
// to `false` — neither is useful and both almost always indicate an
// authoring bug (e.g. a filter UI that produced no clauses). Reject at
// the AST layer rather than surfacing tautologies/contradictions to
// downstream consumers.

const andSchema = z.object({
	kind: z.literal("and"),
	clauses: z.array(z.lazy(() => predicateSchema)).min(1),
});

const orSchema = z.object({
	kind: z.literal("or"),
	clauses: z.array(z.lazy(() => predicateSchema)).min(1),
});

const notSchema = z.object({
	kind: z.literal("not"),
	clause: z.lazy(() => predicateSchema),
});

/**
 * Conditional inclusion: only apply `clause` if the named search input
 * is set at runtime. Models the common case-search pattern where an
 * optional input filters the result set only when the user typed a
 * value, and is otherwise a no-op. Distinct from `not(eq(input, null))`
 * because the wire targets emit different scaffolding (XPath
 * conditional include vs. SQL guarded subquery).
 *
 * The slot is named `clause` (paralleling `notSchema.clause`) rather
 * than `then`. Both arms wrap a predicate as a structural argument,
 * not a continuation, so naming them identically helps readers tracing
 * AST traversals — every operator that holds one wrapped predicate
 * uses the same field name. "clause" is also semantically more
 * accurate than "then" here: the slot holds the operator's structural
 * argument, not a then-branch in any imperative-control-flow sense, and
 * "then" would visually collide with `if/then/else` reading cues for
 * readers expecting conditional execution semantics.
 */
const whenInputPresentSchema = z.object({
	kind: z.literal("when-input-present"),
	input: searchInputRefSchema,
	clause: z.lazy(() => predicateSchema),
});

/**
 * The full predicate union, discriminated on `kind` — consumers
 * narrowing on `p.kind` get full per-variant typing without manual
 * casts. Adding an operator means: (1) define its schema above, (2) add
 * it to this union, (3) extend the type checker / XPath emitter / SQL
 * compiler.
 *
 * Drift policy — the four non-recursive arms (`comparisonSchema`,
 * `inSchema`, `withinDistanceSchema`, `fuzzySchema`) derive their TS
 * shape from their schema via `z.infer<typeof X>`, so adding a field
 * to those schemas updates the union automatically. The four recursive
 * arms (`and`, `or`, `not`, `when-input-present`) are hand-declared
 * because TypeScript cannot resolve `z.infer` through a
 * discriminated-union recursion cycle (Zod issue #4264). Adding a
 * field to one of those four schemas requires a parallel hand-update
 * to the matching arm here. Any required-field drift surfaces as a CI
 * failure (the schema rejects predicates that don't supply the field;
 * the test suite parses each arm). Optional-field drift is caught by
 * the structural assertion at the bottom of this file.
 */
export type Predicate =
	| z.infer<typeof comparisonSchema>
	| z.infer<typeof inSchema>
	| z.infer<typeof withinDistanceSchema>
	| z.infer<typeof fuzzySchema>
	| { kind: "and"; clauses: Predicate[] }
	| { kind: "or"; clauses: Predicate[] }
	| { kind: "not"; clause: Predicate }
	| {
			kind: "when-input-present";
			input: SearchInputRef;
			clause: Predicate;
	  };

export const predicateSchema: z.ZodType<Predicate> = z.discriminatedUnion(
	"kind",
	[
		comparisonSchema,
		inSchema,
		withinDistanceSchema,
		fuzzySchema,
		andSchema,
		orSchema,
		notSchema,
		whenInputPresentSchema,
	],
);

// ---------- Drift guard ----------
//
// Compile-time check that each hand-written recursive arm of `Predicate`
// matches its schema's inferred shape. If a field is added or removed
// on one of the recursive schemas without a parallel update to the
// matching union arm above, this `_driftGuard` block fails to
// type-check and CI catches it.
//
// `_TypesEqual` is the standard TypeScript-FP pattern for strict
// structural equality (two types are considered equal iff a
// conditional indexing through one matches the other identically).
// Bidirectional `extends` is too loose — `{ a: string } extends
// { a: string; b?: number }` and the reverse are both true, so plain
// `extends` would silently allow optional-field drift. `_TypesEqual`
// is conservative: it treats `b?: number` as a structurally distinct
// type from "field absent", so optional additions/removals trip it.
//
// The recursive slots themselves (`clauses`, `clause`) cannot be
// compared via `z.infer` — through `z.lazy`, the inferred shape of the
// payload widens unpredictably across TS versions. So each arm is
// stripped of its recursive slot before comparison. The recursive
// slot's CONTENT is pinned by parse tests in the adjacent test file
// (`not(...)` and `when-input-present(...)` parse nested predicates),
// so the only escape route this guard misses — a payload-shape change
// reachable only through recursion — is caught there.

type _TypesEqual<X, Y> =
	(<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2
		? true
		: false;

type _AndArm = Omit<Extract<Predicate, { kind: "and" }>, "clauses">;
type _OrArm = Omit<Extract<Predicate, { kind: "or" }>, "clauses">;
type _NotArm = Omit<Extract<Predicate, { kind: "not" }>, "clause">;
type _WhenInputPresentArm = Omit<
	Extract<Predicate, { kind: "when-input-present" }>,
	"clause"
>;

type _AndInferred = Omit<z.infer<typeof andSchema>, "clauses">;
type _OrInferred = Omit<z.infer<typeof orSchema>, "clauses">;
type _NotInferred = Omit<z.infer<typeof notSchema>, "clause">;
type _WhenInputPresentInferred = Omit<
	z.infer<typeof whenInputPresentSchema>,
	"clause"
>;

// `_driftGuard` is intentionally unused at runtime — its sole purpose
// is to fail type-check when the hand-written `Predicate` arms drift
// from their schemas. The leading `_` opts it out of the
// `noUnusedVariables` lint by convention; the assignment must remain
// because removing it loses the type-check site.
const _driftGuard: {
	and: _TypesEqual<_AndArm, _AndInferred>;
	or: _TypesEqual<_OrArm, _OrInferred>;
	not: _TypesEqual<_NotArm, _NotInferred>;
	whenInputPresent: _TypesEqual<
		_WhenInputPresentArm,
		_WhenInputPresentInferred
	>;
} = {
	and: true,
	or: true,
	not: true,
	whenInputPresent: true,
};
