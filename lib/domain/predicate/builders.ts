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
	RelationPath,
	RelationStep,
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
 * Constructs a property reference.
 *
 * `caseType` names the **originating case-type scope** — the case type
 * the predicate runs against, NOT the case type the property lives on
 * when `via` is present. When `via` is absent or `selfPath()`, the
 * property is read directly on a case of `caseType`. When `via` is a
 * relation walk, the walk resolves to a destination case type and
 * `property` is read on that destination.
 *
 * Example: a predicate on the `patient` case list filtering by
 * `region` on the patient's `household` parent —
 * `prop("patient", "region", ancestorPath(relationStep("parent",
 * "household")))`. `caseType` is `patient` (originating scope);
 * `property` is `region` on the `household` destination.
 *
 * The `caseType` qualifier is required even with `via` present so the
 * originating scope is always explicit at the call site — readers see
 * the predicate's home scope without tracing back through nesting,
 * and the type checker can resolve the relation walk against that
 * scope's schema directly. See the JSDoc on `propertyRefSchema` in
 * `types.ts` for the full contract.
 *
 * `via` is the optional relational-read slot — pass an `ancestorPath` /
 * `subcasePath` / `anyRelationPath` / `selfPath` to reach a property
 * on a related case. When omitted, the constructed object intentionally
 * has NO `via` key (not `via: undefined`) so existing equality
 * assertions like `expect(predicateSchema.parse(p)).toEqual(p)`
 * continue to hold — Zod's `.optional()` strips absent keys on parse,
 * and a builder that materialized `via: undefined` would silently
 * break the round-trip shape pin downstream tests rely on.
 */
export function prop(
	caseType: string,
	property: string,
	via?: RelationPath,
): PropertyRef {
	return via === undefined
		? { kind: "prop", caseType, property }
		: { kind: "prop", caseType, property, via };
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
 *
 * For temporal values — date, datetime, time — use the typed builders
 * (`dateLiteral`, `datetimeLiteral`, `timeLiteral`) below instead. Their
 * wire form is a string, but typing them as plain text via this builder
 * would force the type checker to either format-sniff or reject ordered
 * comparisons against date-typed properties; the typed builders set
 * `data_type` explicitly so the AST carries the author's intent.
 */
export function literal(value: string | number | boolean | null): Literal {
	return { kind: "literal", value };
}

/**
 * Constructs a date-typed literal. The value is the wire-form string
 * (`YYYY-MM-DD` per CommCare convention). `data_type: "date"` declares
 * the semantic type so a comparison like
 * `lt(prop("patient", "dob"), dateLiteral("2000-01-01"))` resolves under
 * the type checker's ordered-types rule rather than falling through to
 * text.
 *
 * Format validation lives at the wire-emit boundary
 * (`lib/commcare/...`), not here — pass a wire-format string and trust
 * the schema layer to reject malformed values at emit time.
 * `dateLiteral("not-a-date")` constructs a valid AST and type-checks
 * against any date-typed property, then fails when the wire emitter
 * renders the predicate. This split keeps the AST library independent
 * of any particular wire emitter's format rules.
 */
export function dateLiteral(value: string): Literal {
	return { kind: "literal", value, data_type: "date" };
}

/**
 * Constructs a datetime-typed literal. The value is the wire-form
 * string (`YYYY-MM-DDTHH:MM:SS`, optionally with a timezone suffix, per
 * CommCare convention).
 *
 * Format validation lives at the wire-emit boundary
 * (`lib/commcare/...`), not here — pass a wire-format string and trust
 * the schema layer to reject malformed values at emit time.
 * `datetimeLiteral("not-a-datetime")` constructs a valid AST and
 * type-checks against any datetime-typed property, then fails when the
 * wire emitter renders the predicate.
 */
export function datetimeLiteral(value: string): Literal {
	return { kind: "literal", value, data_type: "datetime" };
}

/**
 * Constructs a time-typed literal. The value is the wire-form string
 * (`HH:MM[:SS]` per CommCare convention).
 *
 * Format validation lives at the wire-emit boundary
 * (`lib/commcare/...`), not here — pass a wire-format string and trust
 * the schema layer to reject malformed values at emit time.
 * `timeLiteral("not-a-time")` constructs a valid AST and type-checks
 * against any time-typed property, then fails when the wire emitter
 * renders the predicate.
 */
export function timeLiteral(value: string): Literal {
	return { kind: "literal", value, data_type: "time" };
}

// ---------- Relation-path builders ----------
//
// `RelationPath` is a discriminated union of four kinds — `self`,
// `ancestor`, `subcase`, `any-relation` — covering the typed
// equivalents of CommCare's slash-separated index strings. Each
// builder pins one discriminator so the constructed value narrows
// precisely on `kind` at the call site, and each returns the
// per-kind shape rather than the wider `RelationPath` union for the
// same reason `eq` returns `ComparisonPredicate<"eq">` rather than the
// wider comparison arm: callers narrowing on `kind` after a builder
// call get the per-variant fields directly.
//
// The `RelationStep` shape is shared by `ancestor`'s `via` array; the
// `relationStep` builder is a thin object constructor that pins the
// field name `identifier` so callers don't accidentally use `name` or
// `id` (which would silently parse-reject downstream). `relationStep`
// also follows the same absent-not-undefined contract as `prop`'s
// `via` slot — when `throughCaseType` is omitted, the returned object
// has no `throughCaseType` key, matching the schema's
// `.optional()` strip behavior on parse.

/**
 * Constructs one step in an ancestor-path walk. The optional
 * `throughCaseType` is a type-checker narrowing hint used inside
 * `exists` / `count` filter resolution; it's structural here and
 * carries no runtime impact.
 *
 * Following the convention shared with `prop`'s `via` slot: when
 * `throughCaseType` is undefined, the returned object omits the key
 * entirely rather than materializing `throughCaseType: undefined`. This
 * keeps round-trip equality assertions (`expect(parse(p)).toEqual(p)`)
 * stable, since Zod's `.optional()` strips absent keys on parse.
 */
export function relationStep(
	identifier: string,
	throughCaseType?: string,
): RelationStep {
	return throughCaseType === undefined
		? { identifier }
		: { identifier, throughCaseType };
}

/**
 * Constructs the no-traversal relation path. `selfPath()` and an
 * absent `via` slot on a property reference are semantically
 * equivalent; the explicit form exists so a UI surface editing a
 * relational read can flip the kind to/from `self` without reshaping
 * the parent object.
 */
export function selfPath(): Extract<RelationPath, { kind: "self" }> {
	return { kind: "self" };
}

/**
 * Constructs an ancestor walk. Variadic with a required first step:
 * the schema rejects an empty `via` array (a zero-step ancestor walk
 * collapses to `self` semantics but parses as a different kind, so
 * the schema's tuple-with-rest shape rules it out). The compile-time
 * error from the required first parameter is louder than the runtime
 * parse failure — the same logic as `and` / `or` / `isIn` above.
 *
 * Multi-hop walks compose by chaining `relationStep(...)` arguments —
 * `ancestorPath(relationStep("parent"), relationStep("host"))`
 * encodes "host of parent" and compiles to nested `instance('casedb')`
 * joins on-device or to chained `walk_ancestor_hierarchy` steps in
 * CSQL. Each step's `throughCaseType` narrows the type checker's
 * property resolution at that step's destination scope so a chained
 * walk through heterogeneously-typed cases stays well-typed.
 */
export function ancestorPath(
	first: RelationStep,
	...rest: RelationStep[]
): Extract<RelationPath, { kind: "ancestor" }> {
	return { kind: "ancestor", via: [first, ...rest] };
}

/**
 * Constructs a subcase relation. `identifier` is the index name on
 * the *child* case pointing back at the current case (e.g. `parent`
 * for the canonical "households contain patients via the patient's
 * `parent` index" relationship). `ofCaseType` narrows resolution
 * inside subcase filter clauses; omit it when the destination case
 * type is unconstrained or unknown at authoring time.
 */
export function subcasePath(
	identifier: string,
	ofCaseType?: string,
): Extract<RelationPath, { kind: "subcase" }> {
	return ofCaseType === undefined
		? { kind: "subcase", identifier }
		: { kind: "subcase", identifier, ofCaseType };
}

/**
 * Constructs a direction-agnostic relation. Models the case where
 * authoring time can't commit to CHILD vs EXTENSION semantics — e.g.
 * a custom index whose direction isn't known until runtime.
 *
 * On the Postgres target, this compiles to a `case_indices.identifier`
 * lookup that matches both directions. On CCHQ on-device and CSQL
 * targets, only direction-specific operators (`ancestor-exists` /
 * `subcase-exists`) exist, so this kind has no direct CCHQ wire form;
 * any consumer compiling to a CCHQ target rejects or rewrites
 * `any-relation` into a direction-specific kind.
 *
 * Same `ofCaseType` shape as `subcasePath` — omitted when not needed.
 */
export function anyRelationPath(
	identifier: string,
	ofCaseType?: string,
): Extract<RelationPath, { kind: "any-relation" }> {
	return ofCaseType === undefined
		? { kind: "any-relation", identifier }
		: { kind: "any-relation", identifier, ofCaseType };
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
 * (which the schema rejects via the tuple-with-rest shape on
 * `inSchema.values`). The compile-time error is louder than the
 * parse-time one — callers see the failure in their editor, not from
 * a deferred test run.
 *
 * The runtime `[first, ...rest]` literal infers as
 * `[Literal, ...Literal[]]`, matching the tuple-with-rest shape on the
 * schema; consumers reading `p.values[0]` after parse get a guaranteed
 * `Literal` rather than `Literal | undefined`.
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
// the tuple-with-rest shape on `andSchema.clauses` / `orSchema.clauses`
// becomes a compile-time error at the variadic signature. `not` is
// unary so the constraint is moot.

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
 * the wrapper is a no-op. The body slot is named `clause` to parallel
 * `notSchema.clause`: both arms wrap a single predicate as a
 * structural argument (not an imperative continuation), so the field
 * name reads the same way across the two operators that share that
 * shape. Reading semantics: `clause` is the predicate that runs only
 * when the trigger input is set. See `whenInputPresentSchema` in
 * `types.ts` for the same rationale at the schema layer.
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
