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
 * Constructs a property reference. The `caseType` qualifier is
 * mandatory — see `propertyRefSchema` in `types.ts` for why
 * positional context isn't enough (a search-detail predicate can
 * reach across a parent case type, so the AST records WHICH case
 * type the property lives on).
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
// the comparison kind and returns a binary function; calling it
// produces a fully-typed `Predicate` because the schema's
// `comparisonSchema` collapses all six kinds into one shape.
//
// (See the JSDoc on `COMPARISON_KINDS` / `comparisonSchema` in
// `types.ts` for why this collapse is correct only as long as all six
// share the same operand shape — if a future operator needs an
// asymmetric field, this curried helper has to split.)

const comparison =
	(kind: ComparisonKind) =>
	(left: Term, right: Term): Predicate => ({ kind, left, right });

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
): Predicate {
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
export function and(first: Predicate, ...rest: Predicate[]): Predicate {
	return { kind: "and", clauses: [first, ...rest] };
}

/**
 * Constructs a disjunction. Variadic with a required first clause:
 * the schema rejects an empty `or` (which evaluates trivially to
 * `false`), so the builder demands at least one argument.
 */
export function or(first: Predicate, ...rest: Predicate[]): Predicate {
	return { kind: "or", clauses: [first, ...rest] };
}

/**
 * Constructs a negation. The body slot is named `clause` (matching
 * the schema), not `body` or `inner`, to keep the builder name and
 * the AST field name aligned for readers tracing values from
 * authored predicates to the wire emitter.
 */
export function not(clause: Predicate): Predicate {
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
	unit: "miles" | "kilometers",
): Predicate {
	return { kind: "within-distance", property, center, distance, unit };
}

/**
 * Constructs a phonetic / fuzzy match. Like `within`, the left side
 * must be a direct property reference — fuzzy match against a
 * literal or input is meaningless. The match value is a plain
 * string (not a term) because the operator is unambiguously textual
 * at every wire target.
 */
export function fuzzy(property: PropertyRef, value: string): Predicate {
	return { kind: "fuzzy", property, value };
}

/**
 * Constructs a "when input is present" wrapper. The wrapped predicate
 * applies only if the named search input is set at runtime; otherwise
 * the wrapper is a no-op. The body slot is named `clause` (not
 * `then`) — see the JSDoc on `whenInputPresentSchema` in `types.ts`
 * for the runtime rationale (a parsed predicate accidentally returned
 * from an async function would have its `.then` invoked by JS's
 * await machinery and silently break).
 */
export function whenInput(
	inputRef: SearchInputRef,
	clause: Predicate,
): Predicate {
	return { kind: "when-input-present", input: inputRef, clause };
}
