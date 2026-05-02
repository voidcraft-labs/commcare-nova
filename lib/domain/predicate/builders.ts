// lib/domain/predicate/builders.ts
//
// Typed construction helpers for predicate AST and value-expression
// AST. Engineers and the SA agent build both families by calling
// these — never by composing AST objects by hand. Each builder
// returns a typed AST node that, by construction, parses
// successfully through its respective schema (`predicateSchema` or
// `valueExpressionSchema`).
//
// Why these exist (and why callers must use them rather than composing
// objects directly): the AST has structural constraints the raw object
// literal can't express by itself. The schema rejects empty `and` /
// `or` clause lists, empty `in` value lists, empty `concat.parts`,
// empty `coalesce.values`, empty `switch.cases`, and negative
// `within-distance` radii at parse time. The builders absorb the
// structurally-encodable subset of those constraints at the type
// system level — non-empty arms use a variadic-with-required-first
// signature so an empty argument list is a *compile-time* error
// rather than a runtime parse failure. Catching the failure at type
// check is strictly more useful than at parse: the failure surfaces
// in the editor, not in a CI run.
//
// Each builder also returns a precise per-operator type rather than
// the full `Predicate` / `ValueExpression` union. Callers narrowing
// on `kind` after a builder call would be forced to either re-narrow
// with an `if` block or accept a widened type they can't access
// fields on; returning the precise arm makes `and(...).clauses`,
// `not(...).clause`, etc. directly accessible at the call site.
// Comparison builders use a small `ComparisonPredicate<K>` generic
// because `Extract<Predicate, { kind: "eq" }>` resolves to `never`
// — the schema collapses all six comparison kinds into one arm via
// `z.enum(COMPARISON_KINDS)`, so per-kind extraction can't reach
// them. The generic shape is structurally identical to the schema's
// comparison arm and is provably assignable to `Predicate`.
//
// **Predicate-operand auto-wrap.** Predicate operators (`compare`,
// `in`, `between`, `is-null`, `is-blank`, `within-distance`) carry
// `ValueExpression`-typed operands. Builders accept
// `ValueExpression | Term` at every operand slot and route Term-
// shaped inputs through `toValueExpression(...)` (declared below)
// which wraps them in `{ kind: "term", term: <Term> }`. Call-sites
// like `eq(prop("name"), literal("Alice"))` pass `Term`-typed
// arguments; the builder wraps each at its boundary and the
// constructed predicate carries `ValueExpression`-typed operand
// slots. Term-vs-ValueExpression discrimination is safe because the
// two unions have disjoint discriminator-value sets: `Term`'s kinds
// are `prop` / `input` / `session-user` / `session-context` /
// `literal` while `ValueExpression`'s are `term` / `today` / `now`
// / `date-add` / `date-coerce` / `datetime-coerce` / `double` /
// `arith` / `concat` / `coalesce` / `if` / `switch` / `count` /
// `unwrap-list` / `format-date`.
//
// Distance constraint trade-off: `within`'s `distance` is plain
// `number`. TypeScript can't cheaply express "non-negative number" (it
// requires a branded subtype with a runtime guard at every
// constructor), so the structural defense lives at the schema layer
// (`z.number().nonnegative()`) rather than here. A negative radius
// reaches a runtime parse failure when the AST is later validated;
// that's the same failure mode every other illegal-but-typeable
// payload produces, so leaving it at the schema is consistent.

import {
	reduceAnd as reduceAndImpl,
	reduceNot as reduceNotImpl,
	reduceOr as reduceOrImpl,
} from "./reduction";
import type {
	ArithOp,
	ComparisonKind,
	DateAddInterval,
	DistanceUnit,
	FormatDatePreset,
	Literal,
	MatchMode,
	Predicate,
	PropertyRef,
	RelationPath,
	RelationStep,
	SearchInputRef,
	SessionContextField,
	SessionContextRef,
	SessionUserRef,
	SwitchCase,
	Term,
	ValueExpression,
} from "./types";

// ---------- Term-vs-ValueExpression discrimination ----------
//
// The two unions have disjoint discriminator-value sets, so a single
// closed Set lookup distinguishes them at runtime without further
// payload inspection. Storing the Term kinds in a `Set<string>` (vs.
// a series of explicit `===` comparisons) keeps the dispatch one
// branch wide and makes a future Term-kind addition surface as a
// single edit site here. The drift guard at the bottom of the
// `types.ts` drift-guard block ensures the kind sets stay distinct
// at compile time.

// `TERM_KINDS` is typed `ReadonlySet<string>` rather than
// `ReadonlySet<Term["kind"]>` so `Set.has(input.kind)` accepts a
// string discriminator without a cast — the call site narrows from
// the wider `Term | ValueExpression` input through `isTerm`'s type
// predicate (`is Term`) instead of a structural cast on the lookup
// key. The runtime contents stay the closed Term-kind set; only the
// nominal Set element type is widened to the discriminator's
// underlying string.
const TERM_KINDS: ReadonlySet<string> = new Set([
	"prop",
	"input",
	"session-user",
	"session-context",
	"literal",
]);

/**
 * Type guard distinguishing a `Term` from a `ValueExpression`. Used
 * by `toValueExpression` to dispatch the auto-wrap. The guard's
 * runtime check is a single `Set.has(...)` call against
 * `TERM_KINDS`; the static narrowing flows from the type predicate.
 */
function isTerm(input: Term | ValueExpression): input is Term {
	return TERM_KINDS.has(input.kind);
}

/**
 * Auto-wrap helper: lift a Term into the `term` arm of
 * `ValueExpression`, leave a ValueExpression unchanged. Predicate
 * operator builders route every widened operand through this helper
 * so authors can pass either shape interchangeably (`eq(prop("age"),
 * literal(18))` keeps working with both arguments as `Term`; a
 * future call-site that needs arithmetic in the operand position
 * (`eq(arith("+", prop("age"), literal(1)), literal(19))`) passes a
 * ValueExpression directly).
 *
 * The two unions are structurally distinguishable via their
 * discriminator-value sets (see `TERM_KINDS` above), so the dispatch
 * is a single branch on `input.kind` membership in the Term-kind
 * set. The `term` wrapper is the canonical shape consumed by every
 * downstream surface (type checker, wire emitters, SQL compiler);
 * leaving Term-shaped inputs unwrapped at this layer would force
 * each consumer to re-discriminate.
 *
 * Exported for parity with explicit-construction patterns: a
 * builder for a higher-order operator can call
 * `toValueExpression(...)` to normalize a downstream slot's
 * argument when the slot's type is `ValueExpression | Term`. The
 * common call sites are below in this file's predicate operator
 * builders.
 */
export function toValueExpression(
	input: Term | ValueExpression,
): ValueExpression {
	return isTerm(input) ? { kind: "term", term: input } : input;
}

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
 * and a downstream consumer (type checker, emitter, SQL compiler)
 * starts its walk from a known root. See the JSDoc on
 * `propertyRefSchema` in `types.ts` for the full contract.
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
 * Constructs a reference to an open-namespace custom user-data field on
 * the current session user (e.g. `commcare_location_id`,
 * `commcare_project`, `assigned_region`). Compiles to
 * `instance('commcaresession')/session/user/data/<field>` at the wire
 * targets — see `sessionUserSchema` in `types.ts` for the
 * `addUserProperties` source citation and the open-namespace contract.
 *
 * For the framework-controlled closed set (`userid` / `username` /
 * `deviceid` / `appversion`), use `sessionContext` — the two paths
 * point at different wire trees on `commcaresession`, and using
 * `sessionUser("userid")` would emit
 * `instance('commcaresession')/session/user/data/userid` (wrong path —
 * `userid` lives at `/session/context/userid` and the wrong path
 * silently returns empty).
 */
export function sessionUser(field: string): SessionUserRef {
	return { kind: "session-user", field };
}

/**
 * Constructs a reference to a closed-namespace framework-controlled
 * context field on the current session (`userid` / `username` /
 * `deviceid` / `appversion`). Compiles to
 * `instance('commcaresession')/session/context/<field>` at the wire
 * targets — see `sessionContextSchema` in `types.ts` for the
 * `addMetadata` source citation and the closed-enum contract.
 *
 * The `field` parameter type is `SessionContextField`, derived from the
 * `SESSION_CONTEXT_FIELDS` constant tuple — passing a string outside
 * the closed set is a compile-time error rather than a runtime parse
 * rejection. For an open-namespace custom user-data field, use
 * `sessionUser`.
 */
export function sessionContext(field: SessionContextField): SessionContextRef {
	return { kind: "session-context", field };
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
 * encodes "host of parent". Each step's optional `throughCaseType`
 * narrows the destination scope at that step structurally; downstream
 * consumers (type checker, emitter, SQL compiler) read the qualifier
 * to resolve property references along the chain.
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

// Operands are `ValueExpression`; the builder accepts
// `Term | ValueExpression` and routes Term-shaped inputs through
// `toValueExpression` so call-sites like
// `eq(prop("name"), literal("Alice"))` and
// `eq(arith("+", prop("age"), literal(1)), literal(19))`
// compose interchangeably.

type ComparisonPredicate<K extends ComparisonKind> = {
	kind: K;
	left: ValueExpression;
	right: ValueExpression;
};

const comparison =
	<K extends ComparisonKind>(kind: K) =>
	(
		left: Term | ValueExpression,
		right: Term | ValueExpression,
	): ComparisonPredicate<K> => ({
		kind,
		left: toValueExpression(left),
		right: toValueExpression(right),
	});

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
	left: Term | ValueExpression,
	first: Literal,
	...rest: Literal[]
): Extract<Predicate, { kind: "in" }> {
	return {
		kind: "in",
		left: toValueExpression(left),
		values: [first, ...rest],
	};
}

// ---------- Logical ----------
//
// `and` / `or` / `not` thread their inputs through the construction-
// time reductions in `lib/domain/predicate/reduction.ts` before
// falling through to the standard n-ary or unary construction. The
// seven reductions (empty / single-clause unwrap for `and` and `or`,
// double-negation elimination, and the two `not(sentinel)`
// collapses) collapse degenerate input shapes into the canonical
// sentinel or unwrapped predicate at the construction boundary, so
// authors who construct `and()` / `or()` / `not(matchAll())` get the
// canonical AST shape without having to compose the reduction by
// hand.
//
// Why this lives at the builder layer (not the schema layer): the
// reductions transform shape A into shape B, but the schema's job is
// to validate that a given shape parses cleanly. A schema-level
// "reduce on parse" would mutate user input on parse, which breaks
// the round-trip equality guarantees the rest of the package relies
// on (`expect(predicateSchema.parse(p)).toEqual(p)`). The builder is
// the right layer: it normalizes input at construction, and the
// schema validates the normalized output. The schema's
// tuple-with-rest shape on `andSchema.clauses` / `orSchema.clauses`
// stays as a defensive backstop — directly-constructed `{ kind:
// "and", clauses: [] }` literals (e.g. parsing persisted JSON from
// an older schema) reject at parse time.
//
// Why function overloads: the reductions can return any of three
// shapes — the canonical envelope (`{ kind: "and", clauses: [...]
// }`), an unwrapped inner predicate (`x` for `and([x])`), or a
// sentinel (`match-all` for `and([])`). A single signature returning
// `Predicate` would force every caller to re-narrow on `kind` to
// access fields, losing the per-arm narrowing the rest of this file
// preserves. The overload set declares each call shape's precise
// return type, so callers passing two-or-more clauses still see the
// `{ kind: "and", clauses }` shape directly without re-narrowing.

/**
 * Constructs a conjunction, applying construction-time reductions:
 * `and()` collapses to the `match-all` sentinel (the boolean-algebra
 * identity element of conjunction), `and(x)` unwraps to `x`, and
 * `and(x, y, ...)` constructs the standard n-ary envelope.
 *
 * Overload set: each argument count's return type is pinned
 * precisely. Callers using the two-or-more case retain access to
 * `.clauses` directly without re-narrowing on `kind` — preserving the
 * per-arm narrowing the rest of the builder surface relies on.
 */
export function and(): Extract<Predicate, { kind: "match-all" }>;
export function and<T extends Predicate>(only: T): T;
export function and(
	first: Predicate,
	second: Predicate,
	...rest: Predicate[]
): Extract<Predicate, { kind: "and" }>;
export function and(...clauses: Predicate[]): Predicate {
	const reduced = reduceAndImpl(clauses);
	if (reduced !== undefined) return reduced;
	// Two-or-more clauses: no reduction applies. Construct the
	// standard `{ kind: "and", clauses }` envelope. The implementation
	// signature accepts `Predicate[]`, but the overload set above
	// guarantees the only path that reaches this branch carries
	// `[Predicate, Predicate, ...Predicate[]]` — i.e. a non-empty
	// tuple-with-rest shape that satisfies `andSchema.clauses` at
	// parse time. The cast through `as` is unavoidable: TypeScript
	// can't see the overload's two-or-more guarantee from inside the
	// implementation body.
	return { kind: "and", clauses: clauses as [Predicate, ...Predicate[]] };
}

/**
 * Constructs a disjunction, applying construction-time reductions:
 * `or()` collapses to the `match-none` sentinel (the boolean-algebra
 * absorbing element of disjunction), `or(x)` unwraps to `x`, and
 * `or(x, y, ...)` constructs the standard n-ary envelope. Symmetric
 * with `and` — same overload pattern, same per-arm precise return
 * types.
 */
export function or(): Extract<Predicate, { kind: "match-none" }>;
export function or<T extends Predicate>(only: T): T;
export function or(
	first: Predicate,
	second: Predicate,
	...rest: Predicate[]
): Extract<Predicate, { kind: "or" }>;
export function or(...clauses: Predicate[]): Predicate {
	const reduced = reduceOrImpl(clauses);
	if (reduced !== undefined) return reduced;
	return { kind: "or", clauses: clauses as [Predicate, ...Predicate[]] };
}

/**
 * Constructs a negation, applying construction-time reductions:
 * `not(matchAll())` collapses to the `match-none` sentinel,
 * `not(matchNone())` collapses to the `match-all` sentinel, and
 * `not(not(x))` collapses to `x` (double-negation elimination). For
 * any other inner predicate, the standard `{ kind: "not", clause }`
 * envelope is constructed.
 *
 * Overload set: each statically-known input shape pins the precise
 * return type, preserving the per-arm narrowing convention the rest
 * of this file uses (`eq(...).left`, `and(...).clauses`, etc.).
 *
 *   - `not(matchAll())`  → `match-none`
 *   - `not(matchNone())` → `match-all`
 *   - `not(not(...))`    → `Predicate` — the inner clause's kind isn't
 *      statically known to the overload set, so the union is the
 *      tightest declarable return. Callers who need the inner kind
 *      either know it from context or narrow after construction.
 *   - `not(<other>)`     → `Extract<Predicate, { kind: "not" }>` —
 *      catch-all for the non-reducing case, preserving direct
 *      `.clause` access at the call site.
 *
 * Parameter-naming policy: builder parameter names track AST field
 * names where possible (`clause` here, `clause` on `whenInput`,
 * `property`/`value`/`mode` on `match`) so readers see the same
 * identifier at every layer from authored predicate to wire emission.
 * The one principled exception is `whenInput`'s `inputRef` parameter
 * — naming it `input` to match the AST field would shadow the
 * term-builder export `input` in this same file. Foundation code
 * structurally prevents footguns rather than relying on "the shadow
 * is currently safe" to hold across edits, so the parameter takes
 * a non-shadowing name even at the cost of one layer of mismatch.
 */
export function not(
	clause: Extract<Predicate, { kind: "match-all" }>,
): Extract<Predicate, { kind: "match-none" }>;
export function not(
	clause: Extract<Predicate, { kind: "match-none" }>,
): Extract<Predicate, { kind: "match-all" }>;
export function not(clause: Extract<Predicate, { kind: "not" }>): Predicate;
export function not(clause: Predicate): Extract<Predicate, { kind: "not" }>;
export function not(clause: Predicate): Predicate {
	const reduced = reduceNotImpl(clause);
	if (reduced !== undefined) return reduced;
	return { kind: "not", clause };
}

// ---------- Geo / text-match / multi-select / conditional ----------

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
	center: Term | ValueExpression,
	distance: number,
	unit: DistanceUnit,
): Extract<Predicate, { kind: "within-distance" }> {
	return {
		kind: "within-distance",
		property,
		center: toValueExpression(center),
		distance,
		unit,
	};
}

/**
 * Constructs an approximate text-match predicate against a property's
 * stored string value. The `mode` discriminator selects one of CCHQ's
 * four text-match wire forms — `fuzzy-match` / `phonetic-match` /
 * `fuzzy-date` / `starts-with`. See `matchSchema` in `types.ts` for
 * the per-mode CCHQ source citations.
 *
 * Like `within`, the `property` slot is constrained to a direct
 * property reference — text match against a literal or input has no
 * useful semantics. The match `value` is a plain string (not a term)
 * because every mode is unambiguously textual at every wire target.
 */
export function match(
	property: PropertyRef,
	value: string,
	mode: MatchMode,
): Extract<Predicate, { kind: "match" }> {
	return { kind: "match", property, value, mode };
}

/**
 * Constructs a multi-select containment predicate with `quantifier:
 * "any"` — the property contains any of the supplied values. Maps to
 * CCHQ's `selected-any` (CSQL) or to OR-of-`selected()` (on-device
 * dialect). See `multiSelectContainsSchema` in `types.ts` for the
 * full contract and CCHQ source citations.
 *
 * Variadic-with-required-first signature: the schema rejects an empty
 * `values` list, and a compile-time error is louder than a runtime
 * parse failure — the same pattern as `and` / `or` / `isIn` /
 * `ancestorPath`. The runtime `[first, ...rest]` literal infers as
 * `[Literal, ...Literal[]]`, matching the tuple-with-rest shape on
 * the schema.
 */
export function multiSelectAny(
	property: PropertyRef,
	first: Literal,
	...rest: Literal[]
): Extract<Predicate, { kind: "multi-select-contains" }> {
	return {
		kind: "multi-select-contains",
		property,
		values: [first, ...rest],
		quantifier: "any",
	};
}

/**
 * Constructs a multi-select containment predicate with `quantifier:
 * "all"` — the property contains every supplied value. Maps to CCHQ's
 * `selected-all` (CSQL) or to AND-of-`selected()` (on-device dialect).
 * Symmetric with `multiSelectAny`: same shape, same variadic-with-
 * required-first signature, same parse-rejection on empty values.
 */
export function multiSelectAll(
	property: PropertyRef,
	first: Literal,
	...rest: Literal[]
): Extract<Predicate, { kind: "multi-select-contains" }> {
	return {
		kind: "multi-select-contains",
		property,
		values: [first, ...rest],
		quantifier: "all",
	};
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

// ---------- Sentinel + null-check + range + relational quantifiers ----------
//
// The remaining predicate kinds. Each builder is a thin object
// constructor pinning the discriminator and threading the structural
// arguments onto the constructed object. Two design decisions worth
// reading at a glance:
//
//   - `between`'s `lowerInclusive` / `upperInclusive` default to `true`
//     when omitted — the standard mathematical `[lower, upper]`
//     convention. Authors who want an exclusive bound pass the flag
//     explicitly.
//   - `exists` / `missing` accept an optional `where` predicate that
//     filters the related cases at the destination scope. When
//     omitted, the predicate degenerates to "any related case exists"
//     / "no related case exists" at the AST layer.
//
// Both `exists` / `missing` follow the same absent-not-undefined
// contract `prop()` / `relationStep()` use: when `where` is omitted,
// the constructed object has no `where` key (not `where: undefined`)
// so round-trip equality checks like
// `expect(predicateSchema.parse(p)).toEqual(p)` continue to hold.

/**
 * Constructs the always-true sentinel. Models the boolean-algebra
 * identity element — useful as the fallback in conditional reductions
 * (e.g. when a UI surface clears its filter list, the resulting
 * predicate is `match-all` rather than "no predicate at all").
 *
 * Returns the precise per-kind shape rather than the wider `Predicate`
 * union for the same reason `eq` returns `ComparisonPredicate<"eq">` —
 * callers narrowing on `kind` get the per-variant fields directly.
 */
export function matchAll(): Extract<Predicate, { kind: "match-all" }> {
	return { kind: "match-all" };
}

/**
 * Constructs the always-false sentinel. Models the boolean-algebra
 * absorbing element — useful as the fallback when a UI surface
 * resolves to "no matches possible" (e.g. an unsatisfiable
 * intersection of filters).
 */
export function matchNone(): Extract<Predicate, { kind: "match-none" }> {
	return { kind: "match-none" };
}

/**
 * Constructs an `is-null` predicate — the strict-absent operator.
 * Asks "does `left` resolve to absent (key not present in the JSONB /
 * Map)?" Postgres / in-memory distinguish absent from cleared and
 * from explicit-empty; the AST is Postgres-strict family-wide.
 *
 * Distinct from `isBlank`: `is-null` matches only the absent state,
 * while `is-blank` widens to include the empty-string value too.
 * `is-null` is **unrepresentable on every CCHQ wire target** — the
 * wire layer collapses absent / cleared / empty into one match set.
 * On-device, `prop = ''` matches all three states; in CSQL, the
 * server-side `case_property_query()` short-circuits `value == ''`
 * to `case_property_missing()` semantics at
 * `commcare-hq/corehq/apps/es/case_search.py:241-246`, also matching
 * all three states. There is no CSQL function authors can write to
 * select strict-absent only — `case_property_missing` is a Python
 * helper at `commcare-hq/corehq/apps/es/case_search.py:378`, not a
 * CSQL function in the table at
 * `commcare-hq/corehq/apps/case_search/xpath_functions/__init__.py:39-54`.
 * Emitting `is-null` against any CCHQ target would silently widen
 * the match set and lose the AST's strictness signal. The
 * representability checker errors at authoring time when an
 * `is-null` reaches a CCHQ-bound context; the per-dialect emitters
 * defensively throw.
 *
 * v1 surface scope: v1 authoring surfaces (filter UI, SA tool
 * surface, validator) have no path producing `is-null` directly.
 * `is-null` is foundation infrastructure for non-filter surfaces
 * (case-data inspection, audit / admin views, expression
 * operators that distinguish absent from empty); Postgres
 * natively represents strict-absent via the JSONB presence
 * test. The operator stays in the AST because the discriminated-
 * union shape is part of the persisted contract — removing a
 * kind invalidates every persisted predicate that used it.
 *
 * The `left` slot accepts any term — property reference,
 * search-input reference, session-user reference, session-context
 * reference, and (structurally only) literal. Whether a checker
 * rejects the literal shape is a type-checker concern; the builder
 * + schema accept it uniformly across every Term variant.
 *
 * Spec subsection: "Null vs blank semantics" under the Predicate
 * family in `docs/superpowers/specs/2026-04-30-case-list-search-design.md`.
 */
export function isNull(
	left: Term | ValueExpression,
): Extract<Predicate, { kind: "is-null" }> {
	return { kind: "is-null", left: toValueExpression(left) };
}

/**
 * Constructs an `is-blank` predicate — the portable absent-or-empty
 * operator. Asks "does `left` resolve to absent OR to the empty
 * string?" The widening over `is-null` is the operator's purpose:
 * `isBlank` is the v1 author-facing "field set / unset" check —
 * filter UI, SA tool surface, and validator all produce this
 * operator (not `is-null`) for predicates targeting CCHQ, and the
 * wire layer emits a clean form on every target.
 *
 * Per-dialect representability:
 *
 *   - **Postgres / in-memory:** disjunction
 *     (`(NOT (properties ? 'X')) OR properties->>'X' = ''` for
 *     property refs; equivalent for input / session refs). The wide
 *     form preserves the AST's split between "absent" and "empty"
 *     for downstream consumers but matches both states alike.
 *   - **CSQL:** wire form `prop = ''`. The CCHQ server-side
 *     `case_property_query()` short-circuits empty-value queries to
 *     `case_property_missing()` semantics at
 *     `commcare-hq/corehq/apps/es/case_search.py:241-246`, matching
 *     absent / cleared / empty alike. (`case_property_missing` is a
 *     Python helper at the same file's line 378 — not a CSQL
 *     function authors can write; the empty-equality form is the
 *     only authorable shape, and CCHQ does the right thing.)
 *   - **Case-list / post-ES filter:** `prop = ''` for property refs
 *     (CCHQ's on-device idiom for absent-or-empty), with the
 *     `if(count(input), real, match-all())` wrapper for refs that
 *     read a search input.
 *
 * The `left` slot is parallel-shaped to `isNull` — every Term
 * variant is admitted at the schema layer, with literal-shaped
 * `left` rejected by the type checker as a category error. Spec
 * subsection: "Null vs blank semantics" under the Predicate family.
 */
export function isBlank(
	left: Term | ValueExpression,
): Extract<Predicate, { kind: "is-blank" }> {
	return { kind: "is-blank", left: toValueExpression(left) };
}

/**
 * Options for the `between` builder. Both bounds are optional but at
 * least one must be present (the schema's `.refine(...)` rejects the
 * all-absent shape — TS can't structurally encode "at least one of
 * two optional fields"); both inclusivity flags default to `true`
 * (the standard `[lower, upper]` mathematical convention).
 */
type BetweenOptions = {
	lower?: Term | ValueExpression;
	upper?: Term | ValueExpression;
	lowerInclusive?: boolean;
	upperInclusive?: boolean;
};

/**
 * Constructs a range predicate.
 *
 * Inclusivity defaults: both `lowerInclusive` and `upperInclusive`
 * default to `true` when omitted — the standard mathematical
 * `[lower, upper]` closed-interval convention. Authors who want a
 * half-open or open interval pass the flag explicitly.
 *
 * Bound shape: `lower` and `upper` are full `Term` slots (not just
 * literals) so a search-input or session-user reference can drive
 * either bound at runtime. When a bound is omitted, the constructed
 * object has no key for it (the absent-not-undefined contract from
 * `prop()` / `relationStep()` applies — Zod's `.optional()` strips
 * absent keys on parse, so a builder that materialized
 * `lower: undefined` would silently break downstream round-trip
 * equality assertions).
 *
 * No-bounds rejection: a both-bounds-absent shape is structurally
 * typeable but parse-rejected. The schema's `.refine(...)` enforces
 * at-least-one-bound at parse time; this is the same pattern as
 * `within(prop, center, -10, "miles")` — the builder layer cannot
 * structurally encode "at least one of two optional fields" in the
 * type system, so the rejection lives at the schema layer.
 */
export function between(
	left: Term | ValueExpression,
	opts: BetweenOptions,
): Extract<Predicate, { kind: "between" }> {
	const lowerInclusive = opts.lowerInclusive ?? true;
	const upperInclusive = opts.upperInclusive ?? true;
	// Conditional construction over `??` defaults so an omitted bound
	// produces no `lower` / `upper` key on the result, matching Zod's
	// `.optional()` strip behavior on parse. A `lower: opts.lower ??
	// undefined` shape would materialize the key as undefined and break
	// the `expect(predicateSchema.parse(p)).toEqual(p)` round-trip
	// assertions every other builder relies on.
	const base = {
		kind: "between" as const,
		left: toValueExpression(left),
		lowerInclusive,
		upperInclusive,
	};
	if (opts.lower !== undefined && opts.upper !== undefined) {
		return {
			...base,
			lower: toValueExpression(opts.lower),
			upper: toValueExpression(opts.upper),
		};
	}
	if (opts.lower !== undefined) {
		return { ...base, lower: toValueExpression(opts.lower) };
	}
	if (opts.upper !== undefined) {
		return { ...base, upper: toValueExpression(opts.upper) };
	}
	// Both bounds absent — structurally typeable but
	// schema-refinement-rejected. Returning the bare shape lets the
	// schema's `.refine(...)` produce the canonical at-parse-time
	// error rather than the builder duplicating the rejection.
	return base;
}

/**
 * Constructs an `exists` predicate — "at least one related case along
 * `via` satisfies `where`." When `where` is omitted, the predicate
 * degenerates to "any related case exists along `via`."
 *
 * The optional `where` predicate evaluates in the destination scope
 * of the relation walk. `via`'s `throughCaseType` / `ofCaseType`
 * qualifiers are the schema-level hooks a type-checker rule uses to
 * resolve property references inside `where` against the destination
 * case-type schema; the structural shape is settled here, the
 * resolution rule lives in the type checker.
 *
 * Returns the precise per-kind shape so call-site narrowing on `kind`
 * exposes `via` and `where` directly, the same convention as `not()`
 * / `whenInput()` / `and()`.
 */
export function exists(
	via: RelationPath,
	where?: Predicate,
): Extract<Predicate, { kind: "exists" }> {
	return where === undefined
		? { kind: "exists", via }
		: { kind: "exists", via, where };
}

/**
 * Constructs a `missing` predicate — "no related case along `via`
 * satisfies `where`." When `where` is omitted, the predicate
 * degenerates to "no related case exists along `via`."
 *
 * Symmetric with `exists`: same `via` / `where` shape, same
 * destination-scope resolution rules, same absent-not-undefined
 * contract on `where`.
 */
export function missing(
	via: RelationPath,
	where?: Predicate,
): Extract<Predicate, { kind: "missing" }> {
	return where === undefined
		? { kind: "missing", via }
		: { kind: "missing", via, where };
}

// ---------- ValueExpression builders ----------
//
// Each ValueExpression operator gets a builder mirroring the
// per-arm pattern Predicate operators use: thin object constructor,
// pinning the discriminator and threading the structural arguments
// onto the constructed object. Builders return the precise per-kind
// extracted shape rather than the wider `ValueExpression` union so
// callers narrowing on `kind` get per-variant fields directly —
// same convention as `not()` / `whenInput()` / `and()` on the
// Predicate side.
//
// Auto-wrap policy: the predicate-operand builders (above) accept
// Term inputs and lift them through `toValueExpression`. The
// ValueExpression builders below do NOT auto-wrap — `arith.left`,
// `concat.parts`, etc. always sit in value position, never in Term
// position, so Term-shaped inputs are explicit-only. Authors thread
// a Term through a value slot via the named lifter `term(t)`.

/**
 * Lifter: wrap a `Term` as the `term` arm of `ValueExpression`. The
 * canonical explicit construction for a value-position term — used
 * when an author needs to pass a Term into a ValueExpression slot
 * that doesn't auto-wrap (e.g. `arith.left`,
 * `concat.parts[i]`). Predicate operator builders handle the
 * auto-wrap internally; this builder is the named explicit form for
 * everywhere else.
 *
 * Returning `Extract<ValueExpression, { kind: "term" }>` (not the
 * wider union) lets call-site narrowing on `kind` reach the inner
 * Term directly.
 */
export function term(t: Term): Extract<ValueExpression, { kind: "term" }> {
	return { kind: "term", term: t };
}

/**
 * `today` constant — resolves to the project-timezone ISO date at
 * evaluation time. Discriminator-only shape; no payload. CCHQ wire
 * form: `today()` (zero-arg value function at
 * `commcare-hq/corehq/apps/case_search/xpath_functions/__init__.py:33`).
 */
export function today(): Extract<ValueExpression, { kind: "today" }> {
	return { kind: "today" };
}

/**
 * `now` constant — resolves to the UTC ISO datetime at evaluation
 * time. Discriminator-only shape; no payload. CCHQ wire form:
 * `now()` (zero-arg value function at the same registration site as
 * `today`).
 */
export function now(): Extract<ValueExpression, { kind: "now" }> {
	return { kind: "now" };
}

/**
 * `date-add` value expression: `date + (interval × quantity)`. CCHQ
 * wire form on CSQL: `date-add(date, interval, quantity)` per the
 * value-function dispatch table. On-device support is interval-
 * limited — the representability checker rejects non-`days`
 * intervals for case-list-filter / post-ES dialects, and the
 * on-device emitter falls back to XPath operator arithmetic
 * (`date(...) + N`) for `days`-only emissions.
 *
 * The signature follows the spec's slot order: `date` (the date or
 * datetime base), `interval` (the unit name from
 * `DATE_ADD_INTERVALS`), `quantity` (the multiplier). Arguments
 * stay strictly typed — the builder doesn't auto-wrap Term inputs
 * here because both slots are always already value-shaped at the
 * call site (a `today()` constant, a `prop`-via-`term(...)`
 * lift, or a recursive `arith(...)` for relative-date arithmetic).
 */
export function dateAdd(
	date: ValueExpression,
	interval: DateAddInterval,
	quantity: ValueExpression,
): Extract<ValueExpression, { kind: "date-add" }> {
	return { kind: "date-add", date, interval, quantity };
}

/**
 * `date-coerce` value expression: text → typed date via CommCare's
 * wire `date(...)` value function. Used to coerce a string-typed
 * read (e.g. a search-input typed as text) into a date for
 * comparison or arithmetic.
 */
export function dateCoerce(
	value: ValueExpression,
): Extract<ValueExpression, { kind: "date-coerce" }> {
	return { kind: "date-coerce", value };
}

/**
 * `datetime-coerce` value expression: text → typed datetime via
 * CommCare's wire `datetime(...)` value function. Sister of
 * `dateCoerce` for datetime targets.
 */
export function datetimeCoerce(
	value: ValueExpression,
): Extract<ValueExpression, { kind: "datetime-coerce" }> {
	return { kind: "datetime-coerce", value };
}

/**
 * `double` value expression: forced numeric coercion via CSQL's
 * `double(...)` value function. CCHQ accepts the function in
 * value-position only (term-side; the predicate-side dispatch table
 * has no `double` entry). Authors who need a numeric coercion
 * outside CSQL should rely on the implicit promotion at the
 * comparison / arithmetic boundary instead — Postgres handles
 * mixed-type numeric promotion natively.
 */
export function double(
	value: ValueExpression,
): Extract<ValueExpression, { kind: "double" }> {
	return { kind: "double", value };
}

/**
 * `arith` value expression: five-op binary numeric arithmetic. The
 * `op` parameter selects between `+` / `-` / `*` / `div` / `mod` —
 * CCHQ's wire-vocabulary names. `div` and `mod` use the spelled-out
 * forms because XPath's `/` is the path separator and `%` has no
 * XPath meaning.
 *
 * Operands are `ValueExpression` directly (no Term auto-wrap) for
 * the same reason as the other higher-order operators — the slots
 * always sit in value position, and Term-shaped inputs lift via
 * `term(...)` explicitly when needed (`arith("+", term(prop("age")),
 * literal(1))`). Type-checker rule: both operands must resolve to
 * a numeric type; the result follows int×int=int / mixed=decimal
 * promotion.
 */
export function arith(
	op: ArithOp,
	left: ValueExpression,
	right: ValueExpression,
): Extract<ValueExpression, { kind: "arith" }> {
	return { kind: "arith", op, left, right };
}

/**
 * `concat` value expression: variadic string concatenation. Each
 * part casts to text at evaluation time, so a numeric or boolean
 * input is converted to its wire-form string at the wire boundary
 * and at the SQL layer.
 *
 * Variadic-with-required-first signature mirrors `and` / `or` /
 * `isIn` — the schema rejects an empty `concat()` (the canonical
 * authoring shape for the empty string is `literal("")`), so the
 * builder demands at least one part. The runtime `[first, ...rest]`
 * literal infers as `[ValueExpression, ...ValueExpression[]]`,
 * matching the tuple-with-rest shape on `concatSchema.parts`.
 */
export function concat(
	first: ValueExpression,
	...rest: ValueExpression[]
): Extract<ValueExpression, { kind: "concat" }> {
	return { kind: "concat", parts: [first, ...rest] };
}

/**
 * `coalesce` value expression: first-non-empty fallback chain. Each
 * value evaluates in order; the first non-null / non-empty result
 * is returned. The fallback semantics mirror SQL's `COALESCE` and
 * CCHQ's `coalesce(...)` value function.
 *
 * Variadic-with-required-first like `concat`: an empty `coalesce()`
 * has no fallback to return, and the canonical "always null" shape
 * is `term(literal(null))`.
 */
export function coalesce(
	first: ValueExpression,
	...rest: ValueExpression[]
): Extract<ValueExpression, { kind: "coalesce" }> {
	return { kind: "coalesce", values: [first, ...rest] };
}

/**
 * `if` value expression: boolean-conditional value selection. `cond`
 * is a `Predicate` (cross-family reference); both branches are
 * `ValueExpression`. CCHQ on-device wire form: `if(cond, then, else)`.
 * CSQL has no native `if` value function — the CSQL wire emitter
 * hoists `if` arms out of CSQL fragments at the wire-emission
 * boundary.
 *
 * The slot order matches the spec — `cond` / `then` / `else` —
 * even though `else` is a JS reserved word in statement positions;
 * it is a legal property name in object literal contexts.
 *
 * The builder is named `ifExpr` (not `if`) to avoid colliding with
 * JS's `if` statement keyword. Authors who want the spec-aligned
 * read at the call site can re-export under an alias at consumer
 * scope.
 */
export function ifExpr(
	cond: Predicate,
	thenBranch: ValueExpression,
	elseBranch: ValueExpression,
): Extract<ValueExpression, { kind: "if" }> {
	return {
		kind: "if",
		cond,
		// biome-ignore lint/suspicious/noThenProperty: AST shape mirrors `ifSchema`; `then` holds a ValueExpression object, never a callable. Full thenable-hazard analysis on `ifSchema`'s JSDoc in types.ts.
		then: thenBranch,
		else: elseBranch,
	};
}

/**
 * Single switch case — `when` literal compared against the outer
 * `switch.on`, plus the `then` value selected on match. The shape
 * mirrors `switchCaseSchema` and the `SwitchCase` type. Authors
 * compose `switchCase(literal("low"), literal(1))` rather than
 * constructing the object literal by hand.
 */
export function switchCase(
	when: Literal,
	thenValue: ValueExpression,
): SwitchCase {
	return {
		when,
		// biome-ignore lint/suspicious/noThenProperty: AST shape mirrors `switchCaseSchema`; `then` holds a ValueExpression object, never a callable. Full thenable-hazard analysis on `ifSchema`'s JSDoc in types.ts.
		then: thenValue,
	};
}

/**
 * `switch` value expression: value-driven multi-case selector.
 * `on` is the discriminator value; each `case.when` literal
 * compares against it in order; the first match's `then` wins.
 * `fallback` runs when no case matches.
 *
 * Cases are a non-empty tuple at the parameter type, so an empty
 * `cases` array fails at the call site rather than at parse — same
 * defense the variadic predicate builders use. The builder is
 * named `switchExpr` (not `switch`) to avoid colliding with JS's
 * `switch` statement keyword.
 */
export function switchExpr(
	on: ValueExpression,
	cases: [SwitchCase, ...SwitchCase[]],
	fallback: ValueExpression,
): Extract<ValueExpression, { kind: "switch" }> {
	return { kind: "switch", on, cases, fallback };
}

/**
 * `count` value expression: relational aggregation. Returns the
 * cardinality of cases reachable along `via` whose optional `where`
 * predicate holds. CCHQ wire form on CSQL: recognised only as the
 * LHS of a binary comparison (`subcase-count(...) > 2`), so a
 * `count(...)` outside a comparison context is unrepresentable in
 * CSQL and the representability checker flags it at authoring time.
 * The Postgres compiler executes the count natively in any value
 * position.
 *
 * Same `via` / `where` shape as `exists` / `missing` on the
 * Predicate side, with the same absent-not-undefined contract on
 * `where`.
 */
export function count(
	via: RelationPath,
	where?: Predicate,
): Extract<ValueExpression, { kind: "count" }> {
	return where === undefined
		? { kind: "count", via }
		: { kind: "count", via, where };
}

/**
 * `unwrap-list` value expression: pull a JSON-encoded array stored
 * in a property's value and surface it as a sequence of values via
 * CCHQ's `unwrap-list(...)` value function. v1 has no AST consumer
 * for the resulting sequence — `in.values` and
 * `multi-select-contains.values` stay literal-only — but the
 * builder exists for the persisted-shape contract and the future
 * `selected-any(prop, unwrap-list(...))` CSQL emission pattern (B-
 * phase).
 */
export function unwrapList(
	value: ValueExpression,
): Extract<ValueExpression, { kind: "unwrap-list" }> {
	return { kind: "unwrap-list", value };
}

/**
 * `format-date` value expression: render a date or datetime as
 * text. The `pattern` slot accepts the three preset names
 * (`short` / `long` / `iso` from `FORMAT_DATE_PRESETS`) plus an
 * arbitrary string for advanced patterns. The schema admits both
 * branches via the union; this builder accepts the common type.
 */
export function formatDate(
	date: ValueExpression,
	pattern: FormatDatePreset | string,
): Extract<ValueExpression, { kind: "format-date" }> {
	return { kind: "format-date", date, pattern };
}
