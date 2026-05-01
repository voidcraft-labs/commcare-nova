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
 * Geo predicate: include cases whose `property` (a geopoint) lies
 * within `distance` of `center`. `property` is constrained to a direct
 * property reference (the geopoint can't be a literal or an input —
 * those shapes don't make geometric sense), but `center` is a
 * full term so a search-input geopoint or a session user location
 * can drive the query.
 */
const withinDistanceSchema = z.object({
	kind: z.literal("within-distance"),
	property: propertyRefSchema,
	center: termSchema,
	distance: z.number(),
	unit: z.enum(["miles", "kilometers"]),
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
// union itself. The Zod 4 getter pattern is preferred for self-recursive
// objects (`Category` referencing `Category`), but here the cycle goes
// through a `z.discriminatedUnion(...)` rather than a single object —
// each operator schema needs to reference `predicateSchema` (the union),
// not itself. Forward-referencing a `const` from inside an object getter
// fails because the union doesn't exist yet during arm declaration; the
// getter return-type annotation has to name `predicateSchema`, which is
// declared later, and TypeScript reports a circular-mapped-type error.
//
// `z.lazy(() => ...)` is the documented Zod 4 fallback for recursion
// through unions/arrays, so each recursive arm wraps its predicate slot
// in `z.lazy`. The explicit `z.ZodType<Predicate>` annotation on
// `predicateSchema` lets the compiler resolve the cycle: the schema's
// runtime shape is built bottom-up at first parse, and the type
// annotation tells TypeScript what value the lazy callbacks will
// eventually deliver.
//
// Why one schema per recursive operator instead of inlining them in the
// `discriminatedUnion(...)` call: `z.discriminatedUnion` requires each
// member to be a single object schema carrying the discriminant key.
// Defining each as a named const keeps the union list readable and lets
// each operator's contract live next to its discriminator declaration.

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
 * The slot is named `clause` (paralleling `notSchema`) rather than
 * `then` to avoid the Promise-thenable footgun that Biome's
 * `noThenProperty` rule guards against — any parsed predicate
 * accidentally returned from an async function would otherwise have its
 * `.then` invoked by JavaScript's await machinery and silently break.
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
 * to those schemas updates the union automatically. The four
 * recursive arms (`and`, `or`, `not`, `when-input-present`) are
 * hand-declared because TypeScript cannot resolve `z.infer` through a
 * discriminated-union recursion cycle (Zod issue #4264). Adding a
 * field to one of those four schemas requires a parallel hand-update
 * to the matching arm here. The recursive shapes stay deliberately
 * narrow (kind + 1–2 fields) and the test suite parses each arm
 * directly, so any drift surfaces as a CI failure rather than a
 * silent runtime mismatch.
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
