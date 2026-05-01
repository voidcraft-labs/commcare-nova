// lib/domain/predicate/builders.ts
//
// Typed construction helpers for predicate ASTs. Engineers and the SA
// agent build predicates by calling these — never by composing AST
// objects by hand. Each builder returns a typed AST node that, by
// construction, parses successfully through `predicateSchema`.
//
// Why these exist (and why callers must use them rather than composing
// objects directly): the predicate AST has structural constraints the
// raw object literal can't express by itself. The schema rejects empty
// `and` / `or` clause lists, empty `in` value lists, and negative
// `within-distance` radii at parse time. The builders absorb the
// structurally-encodable subset of those constraints at the type
// system level — `and` / `or` / `isIn` use a variadic-with-required-
// first signature so an empty argument list is a *compile-time* error
// rather than a runtime parse failure. Catching the failure at type
// check is strictly more useful than at parse: the failure surfaces in
// the editor, not in a CI run.
//
// Each builder also returns a precise per-operator type rather than the
// full `Predicate` union. Callers narrowing on `kind` after a builder
// call would be forced to either re-narrow with an `if` block or accept
// a widened type they can't access fields on; returning the precise arm
// makes `and(...).clauses`, `not(...).clause`, etc. directly accessible
// at the call site. Comparison builders use a small `ComparisonPredicate<K>`
// generic because `Extract<Predicate, { kind: "eq" }>` resolves to
// `never` — the schema collapses all six comparison kinds into one arm
// via `z.enum(COMPARISON_KINDS)`, so per-kind extraction can't reach
// them. The generic shape is structurally identical to the schema's
// comparison arm and is provably assignable to `Predicate`.
//
// Distance constraint trade-off: `within`'s `distance` is plain
// `number`. TypeScript can't cheaply express "non-negative number" (it
// requires a branded subtype with a runtime guard at every
// constructor), so the structural defense lives at the schema layer
// (`z.number().nonnegative()`) rather than here. A negative radius
// reaches a runtime parse failure when the AST is later validated;
// that's the same failure mode every other illegal-but-typeable
// payload produces, so leaving it at the schema is consistent.

import type {
	ComparisonKind,
	DistanceUnit,
	Literal,
	Predicate,
	PropertyRef,
	SearchInputRef,
	Term,
	UserContextRef,
} from "./types";

// ---------- Term builders ----------
//
// Terms are the leaves of the AST — they never contain predicates and
// the matching schemas are flat. Each builder is a thin object
// constructor; the value lives in pinning the discriminator (`kind`)
// to the correct literal so callers don't have to remember it and so
// the return type narrows precisely on the call site.

/**
 * Constructs a property reference. The `caseType` qualifier is required
 * because a search-detail predicate may reach across a related parent
 * case type (e.g. `patient` → `clinic`), so the AST records WHICH case
 * type the property lives on rather than relying on positional context.
 */
export function prop(caseType: string, property: string): PropertyRef {
	return { kind: "prop", caseType, property };
}

/**
 * Constructs a reference to a value the user typed into a search
 * input. Resolved at compile time (XPath / SQL) by mapping `name` to
 * the search input's runtime binding.
 */
export function input(name: string): SearchInputRef {
	return { kind: "input", name };
}

/**
 * Constructs a reference to a field on the current session user
 * (e.g. their assigned region). Compiled to the appropriate session
 * lookup at each wire target.
 */
export function userField(field: string): UserContextRef {
	return { kind: "user", field };
}

/**
 * Constructs a primitive constant. Numbers, booleans, and `null` are
 * first-class so the type checker can validate compatibility with
 * the referenced property's data type without round-tripping through
 * string parsing.
 */
export function literal(value: string | number | boolean | null): Literal {
	return { kind: "literal", value };
}

// ---------- Comparison builders ----------
//
// All six comparison operators share an identical structural shape
// (`{ kind, left, right }`), so they're constructed via a curried
// helper rather than restating the body six times. The factory takes
// the comparison kind and returns a binary function that produces a
// per-kind narrowed value.
//
// `ComparisonPredicate<K>` exists because `Extract<Predicate, { kind:
// "eq" }>` resolves to `never` — the schema's `comparisonSchema`
// collapses all six kinds into one arm via `z.enum(COMPARISON_KINDS)`,
// so the union has a single comparison arm with `kind: ComparisonKind`
// rather than per-kind arms. Defining the per-kind shape here, with
// the same `{ kind, left, right }` structure as `comparisonSchema`,
// gives each builder a precise return type that's still assignable to
// `Predicate`.
//
// (See the JSDoc on `COMPARISON_KINDS` / `comparisonSchema` in
// `types.ts` for why this collapse is correct only as long as all six
// share the same operand shape — if a future operator needs an
// asymmetric field, this curried helper has to split.)

type ComparisonPredicate<K extends ComparisonKind> = {
	kind: K;
	left: Term;
	right: Term;
};

const comparison =
	<K extends ComparisonKind>(kind: K) =>
	(left: Term, right: Term): ComparisonPredicate<K> => ({ kind, left, right });

export const eq = comparison("eq");
export const neq = comparison("neq");
export const gt = comparison("gt");
export const gte = comparison("gte");
export const lt = comparison("lt");
export const lte = comparison("lte");

// ---------- Membership ----------

/**
 * Constructs `left ∈ values`. Variadic with a required first value
 * so the builder cannot construct an empty-list `in` predicate
 * (which the schema rejects via `.min(1)`). The compile-time error
 * is louder than the parse-time one — callers see the failure in
 * their editor, not from a deferred test run.
 */
export function isIn(
	left: Term,
	first: Literal,
	...rest: Literal[]
): Extract<Predicate, { kind: "in" }> {
	return { kind: "in", left, values: [first, ...rest] };
}

// ---------- Logical ----------
//
// `and` and `or` mirror the same first-required pattern as `isIn` —
// the schema's `.min(1)` on `clauses` becomes a compile-time error.
// `not` is unary so the constraint is moot.

/**
 * Constructs a conjunction. Variadic with a required first clause:
 * the schema rejects an empty `and` (which evaluates trivially to
 * `true`), and a compile-time error is preferable to a runtime
 * parse failure.
 */
export function and(
	first: Predicate,
	...rest: Predicate[]
): Extract<Predicate, { kind: "and" }> {
	return { kind: "and", clauses: [first, ...rest] };
}

/**
 * Constructs a disjunction. Variadic with a required first clause:
 * the schema rejects an empty `or` (which evaluates trivially to
 * `false`), so the builder demands at least one argument.
 */
export function or(
	first: Predicate,
	...rest: Predicate[]
): Extract<Predicate, { kind: "or" }> {
	return { kind: "or", clauses: [first, ...rest] };
}

/**
 * Constructs a negation. The body slot is named `clause` (matching
 * the schema), not `body` or `inner`, to keep the builder name and
 * the AST field name aligned for readers tracing values from
 * authored predicates to the wire emitter.
 *
 * Parameter-naming policy: builder parameter names track AST field
 * names where possible (`clause` here, `clause` on `whenInput`,
 * `property`/`value` on `fuzzy`) so readers see the same identifier
 * at every layer from authored predicate to wire emission. The one
 * principled exception is `whenInput`'s `inputRef` parameter —
 * naming it `input` to match the AST field would shadow the
 * term-builder export `input` in this same file. Foundation code
 * structurally prevents footguns rather than relying on "the shadow
 * is currently safe" to hold across edits, so the parameter takes
 * a non-shadowing name even at the cost of one layer of mismatch.
 */
export function not(clause: Predicate): Extract<Predicate, { kind: "not" }> {
	return { kind: "not", clause };
}

// ---------- Geo / fuzzy / conditional ----------

/**
 * Constructs a geo "within distance" predicate. The `property` slot
 * is constrained to a direct property reference (the geopoint can't
 * be a literal or input — those shapes don't make geometric sense),
 * but `center` is a full term so a search-input geopoint or a
 * session user location can drive the query.
 *
 * `distance` is plain `number`; the schema enforces non-negative at
 * parse time. See the file-level comment for why the constraint
 * doesn't surface in this signature.
 */
export function within(
	property: PropertyRef,
	center: Term,
	distance: number,
	unit: DistanceUnit,
): Extract<Predicate, { kind: "within-distance" }> {
	return { kind: "within-distance", property, center, distance, unit };
}

/**
 * Constructs a phonetic / fuzzy match. Like `within`, the left side
 * must be a direct property reference — fuzzy match against a
 * literal or input is meaningless. The match value is a plain
 * string (not a term) because the operator is unambiguously textual
 * at every wire target.
 */
export function fuzzy(
	property: PropertyRef,
	value: string,
): Extract<Predicate, { kind: "fuzzy" }> {
	return { kind: "fuzzy", property, value };
}

/**
 * Constructs a "when input is present" wrapper. The wrapped predicate
 * applies only if the named search input is set at runtime; otherwise
 * the wrapper is a no-op. The body slot is named `clause` (not
 * `then`) because a parsed predicate accidentally returned from an
 * async function would have its `.then` invoked by JS's await
 * machinery and silently break — picking a different name eliminates
 * the footgun structurally.
 *
 * The first parameter is `inputRef` (not `input`) to avoid shadowing
 * the term-builder export `input` declared above in this file. See
 * the parameter-naming policy comment on `not` for the full
 * rationale.
 */
export function whenInput(
	inputRef: SearchInputRef,
	clause: Predicate,
): Extract<Predicate, { kind: "when-input-present" }> {
	return { kind: "when-input-present", input: inputRef, clause };
}
