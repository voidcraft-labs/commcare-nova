# lib/domain/predicate — Predicate + ValueExpression AST

The single package that owns Nova's two structurally-related AST
families: `Predicate` (boolean-typed expressions for filters,
default search filters, claim conditions, EXISTS clauses) and
`ValueExpression` (typed-value expressions for calculated columns,
sort calculations, search-input defaults, conditional branches,
aggregation operands). Spec source:
`docs/superpowers/specs/2026-04-30-case-list-search-design.md`,
"Two AST families" section (lines 54-187) and "Wire emission" section
(lines 455-493) for V1 operator coverage.

## Why two families share one package

Every `Predicate` node IS a `ValueExpression` (the boolean-typed arm
of the broader expression family). Conversely, the expression
family's conditional arms (`if.cond`, `count.where`) carry
`Predicate` operands. The cross-cycle recursion — Predicate
operators carrying `ValueExpression` operands; `ValueExpression`'s
`if` / `switch` / `count` carrying `Predicate` clauses — needs
intra-file `z.lazy` to resolve. Splitting the two unions into
sibling packages would force a cross-package `z.lazy`, which Zod
doesn't ergonomically support across module boundaries. One shared
package lets both unions reach each other.

## File map

```
types.ts        — Zod schemas, type aliases, per-arm operand
                  constants, validation patterns
builders.ts     — typed construction helpers; Term-vs-ValueExpression
                  auto-wrap at widened operand slots
typeChecker.ts  — checkPredicate / checkExpression and supporting
                  resolution / compatibility primitives
jsonSchema.ts   — caseTypeToJsonSchema for the case-store write-time
                  validator
reduction.ts    — reduceAnd / reduceOr / reduceNot invariants the
                  builders apply at construction time
__tests__/      — per-module test suite; reduction tests exercise the
                  builder-applied invariants end-to-end
```

## The Predicate AST family

Boolean-typed expressions. Every arm resolves to true or false at
evaluation time. Coverage matches the spec's V1-IN list:

- **Sentinels:** `match-all`, `match-none` — boolean-algebra
  identity / absorbing elements. Builders return precise per-kind
  arms so call-sites read `.kind === "match-all"` directly.
- **Logical:** `and`, `or`, `not` — composition with
  schema-rejected empty clause lists. The reduction module
  collapses no-op shapes (`and([])` → `match-all`, `or([single])`
  → single, `not(not(x))` → x) at construction time.
- **Comparison:** `eq` / `neq` / `gt` / `gte` / `lt` / `lte` —
  one schema arm via `z.enum(COMPARISON_KINDS)`. The type checker
  enforces the per-operator type-compatibility rules (e.g.,
  `gt`/`lt` require operands drawn from `ORDERED_TYPES`).
- **Membership:** `in` (literal-only values list per the wire
  target's static-list expectation), `between` (at-least-one-bound
  with per-bound inclusivity flags).
- **Multi-select:** `multi-select-contains` with an `any` / `all`
  quantifier. Property + values are literal-only — the wire target
  expects a static list.
- **Text match:** `match` with four modes — `fuzzy` (pg_trgm `%`),
  `phonetic` (`fuzzystrmatch` Soundex / Metaphone), `fuzzy-date`
  (digit-permutation lookup), `starts-with` (prefix match). Each
  mode has a per-mode property-type allow-list (text-shaped types
  for the three approximate-string modes; `date` only for
  `fuzzy-date`).
- **Geo:** `within-distance` — PostGIS `ST_DWithin` over a
  `(property, center, distance, unit)` quad. Unit conversion to
  meters happens at the SQL emission layer.
- **Relational:** `exists` / `missing` over a `RelationPath` with
  an optional inner `where` predicate. `via.kind === "self"`
  collapses to the inner where (no redundant identity join).
- **Conditional:** `when-input-present` — compile-time short-
  circuit on a search-input binding's presence.
- **Null / blank:** `is-null` (strict-absent) / `is-blank` (absent
  or empty). The two operators encode the spec's locked
  null-vs-blank semantic — see "Null vs blank semantics" below.

## The ValueExpression AST family

Typed-value expressions. Every arm resolves to a value of a
specific Postgres / wire type at evaluation time. Coverage matches
the spec's V1-IN list:

- **Term lift:** `term` — structural lifter for any `Term`. Lets a
  property / input / session ref / literal flow through any value
  slot without explicit wrapping.
- **Date constants:** `today` (project-timezone ISO date), `now`
  (UTC ISO datetime).
- **Date arithmetic:** `date-add` (interval × quantity), `date-coerce`
  (string → typed date), `datetime-coerce` (string → typed datetime).
- **Numeric:** `arith` (five-op binary: `+` / `-` / `*` / `div` /
  `mod`), `double` (forced numeric coercion).
- **Text:** `concat` (variadic concatenation; each part casts to
  text at evaluation), `format-date` (preset patterns: `short` /
  `long` / `iso`).
- **Conditional:** `if` (boolean condition with eager evaluation
  of both branches; condition is a `Predicate` — cross-family
  reference), `switch` (literal-discriminator dispatch with a
  fallback; the discriminator evaluates ONCE per row at the
  Postgres target).
- **Aggregation:** `count` over a `RelationPath` with an optional
  inner `where` predicate.
- **List unwrap:** `unwrap-list` — produces a `_sequence` type the
  CSQL emitter routes into `selected-any(prop, unwrap-list(...))`.
  The Postgres compiler defensive-throws on this arm because no
  Postgres-side AST consumer accepts a sequence; the wire-emission
  boundary is the only consumer.

## The Term family

Leaf-level values that other AST nodes compose. Five arms:

- **`prop`** — a case property reference qualified by case type
  with an optional `via` (relation walk to a destination case
  type). The `caseType` qualifier names the originating scope; the
  `via`'s destination is where the property is read.
- **`input`** — a search-input ref. The wider pipeline binds the
  input value at request boundary time.
- **`session-user`** — open-namespace user-data field ref.
  Resolves from the authenticated session's user record's
  `additionalFields`.
- **`session-context`** — closed-namespace context field ref. Each
  field name comes from `SESSION_CONTEXT_FIELDS` (`userid` /
  `username` / `deviceid` / `appversion`); the wider pipeline
  resolves these from the request session.
- **`literal`** — primitive constant (string / number / boolean /
  null) with optional `data_type` for typed temporal literals.

Term does NOT carry a `value-expression` arm. Cross-family
composition lives one level up — Predicate operators take
`ValueExpression` operands directly, and `ValueExpression`'s `term`
arm lifts any Term where a value is expected.

## Relation paths

Four arms encode the direction of a case-relation walk:

- **`self`** — no traversal. The anchor IS the destination.
- **`ancestor`** — multi-hop walk along `parent_type` chains. Each
  hop's `RelationStep` carries the relation identifier and an
  optional `throughCaseType` qualifier.
- **`subcase`** — single-hop reverse-direction walk. `identifier`
  selects the relation; optional `ofCaseType` narrows the
  destination case type when more than one child case type
  matches.
- **`any-relation`** — direction-agnostic walk that matches BOTH
  the ancestor and subcase forms under the same identifier. CCHQ's
  wire grammars expose only direction-specific operators
  (`ancestor-exists` / `subcase-exists`), so the wire emitters
  expand `any-relation` to `(<ancestor-form> or <subcase-form>)`
  on every CCHQ slot. Postgres compiles to a `unionAll` of the two
  single-hop variants against the same identifier.

## Null vs blank semantics — locked invariant

`is-null` and `is-blank` distinguish three states at the data-
model layer:

- "key absent in JSONB document"
- "key present with JSON null"
- "key present with empty string"

`is-null` matches strict-absent only; `is-blank` widens to
absent-or-empty. CCHQ's wire layer collapses all three states into
one match set (a CCHQ accumulation), but Nova's Postgres runtime
distinguishes them natively. The strict semantic is the AST's
contract; the type checker enforces it; the wire emitters degrade
faithfully (CCHQ's wire form is `prop = ''` for both operators —
broader than `is-null` says, exact for `is-blank`); the Postgres
compiler emits the strict SQL.

The two operators' on-disk persistence shape is part of every
saved AST. Removing `is-null` from the foundation would be a one-
way door — adding it back later would change the closed kind set
and break every persisted predicate. Authoring surfaces (filter
UI, SA tool surface) default to `is-blank` for "field is empty"
intents; `is-null` is available for any caller that needs strict-
absent semantics (case-data inspection, audit / admin views,
expression operators that need to distinguish absent from empty
like `coalesce`).

## Type checker contract

`checkPredicate(predicate, ctx)` and `checkExpression(expression, ctx)`
validate a constructed AST against the case-type schema and the
search-input declaration list. Both produce a
`CheckResult = { ok: true } | { ok: false; errors: CheckError[] }`
with each error's `path` locating the offending node in the AST.

The `TypeContext` carries:

- `caseTypes` — the blueprint's case-type definitions
- `knownInputs` — declared search inputs (per-screen; each carries
  a name and an optional `data_type`)
- `currentCaseType` — the originating scope a relational walk
  starts from / a `where`-clause property reference resolves
  against. Optional at the top-level call (the comparison /
  membership / absence operators don't need it); required by the
  relational quantifiers.

The checker's per-arm rules combine:

- **Type compatibility** — `typesCompatible(a, b)` widens the
  per-arm operand pair against numeric promotion (int+decimal),
  select-to-text, and null-as-universal compatibility. The
  `ANY_TYPE` sentinel short-circuits the `null` literal against
  every declared property type.
- **Ordered types** — `gt` / `gte` / `lt` / `lte` reject operands
  drawn from outside `ORDERED_TYPES`. Strings are deliberately
  excluded from the ordered set: locale-dependent string ordering
  is rarely meaningful for case-list filtering.
- **Match-mode allow-lists** — each `match` mode has a per-mode
  property-type allow-list (text-shaped types for `fuzzy` /
  `phonetic` / `starts-with`; `date` only for `fuzzy-date`).
- **Relation-walk validation** — `checkRelationPath` walks the
  AST against the case-type graph, ensuring every step's
  `throughCaseType` matches the previous case type's `parent_type`,
  and `checkInDestinationScope` enforces that property references
  inside `where` clauses resolve against the surrounding `via`'s
  destination scope.
- **Sequence handling** — `unwrap-list` resolves to the
  `SEQUENCE_TYPE` sentinel; no Predicate or Expression operator
  consumes a sequence at the type checker — the only consuming
  surface is the CSQL wire emitter via the `selected-any(prop,
  unwrap-list(...))` pattern.

The checker is the gate every wire emitter and the Postgres
compiler trust upstream. Compiler / emitter rules that the type
checker should have caught (e.g. an unknown case type at the
relation-path resolution step) throw a "the type checker should
have caught this" error rather than fall back to a default — the
checker's coverage is the structural contract, not a hint.

## JSON Schema generator

`caseTypeToJsonSchema(caseType)` produces a JSON Schema document
the case-store's write-time validator runs against. The validator
runs in TypeScript (via `ajv`) at every API route writing to
`cases` — the API route is the trust boundary, and the database is
internal. There is no in-database trigger and no `pg_jsonschema`
dependency: Cloud SQL doesn't allowlist the extension, and a
hand-rolled PL/pgSQL implementation duplicating this generator's
output would just create a second validator to keep in sync.

The generator maps each `CaseProperty.data_type` to its JSON
Schema shape (`text` → `{ type: "string" }`, `int` →
`{ type: "integer" }`, etc.). Properties without a declared
`data_type` default to `{ type: "string" }` — matches the term
compiler's `text` default at the same site.

## Reduction module

Boolean-algebra simplifications applied at construction time:

- `reduceAnd(clauses)` — `[]` → `match-all`, `[single]` → single,
  flattens nested `and` clauses, returns `match-none` if any
  clause is `match-none`, drops `match-all` clauses.
- `reduceOr(clauses)` — `[]` → `match-none`, `[single]` → single,
  flattens nested `or` clauses, returns `match-all` if any clause
  is `match-all`, drops `match-none` clauses.
- `reduceNot(clause)` — `not(match-all)` → `match-none`,
  `not(match-none)` → `match-all`, `not(not(x))` → x.

The builders apply these on every `and(...)` / `or(...)` /
`not(...)` call so the constructed AST is always in canonical
reduced form. Manual AST construction (object literals) bypasses
the reduction; consumers that compose ASTs by hand should call the
reduction helpers themselves to stay in canonical form.

## Wire-emission boundary

This package is the source of truth for the AST shape; consumers
emit to wire formats from outside the package:

- **On-device XPath dialect** (case-list filter, post-ES search
  filter) via `lib/commcare/predicate`'s `emitCaseListFilter` and
  `lib/commcare/expression`'s `emitOnDeviceExpression`.
- **CSQL dialect** (CCHQ ElasticSearch-parsed search filter) via
  the same packages' `emitCsql` / `emitCsqlExpressionSegments`,
  with a hoist pass at `lib/commcare/predicate/csqlHoist.ts` that
  lifts non-CSQL-grammar nodes into on-device wrappers.
- **Postgres SQL** (Nova's live runtime) via `lib/case-store/sql`'s
  compiler stack (`compilePredicate` / `compileExpression` /
  `compileTerm` / `compileRelationPath`).

All three wire targets consume the same AST. The type checker runs
against the AST before any wire emission, so a typed AST is the
single contract every consumer trusts.

## Public surface — barrel

External consumers import from `@/lib/domain/predicate` (the
barrel at `./index.ts`). The barrel re-exports every module
wholesale via `export *` because each sibling module already
curates its export surface — adding a new builder, a new type-
checker helper, or a new reduction rule does not require a parallel
edit to the barrel.
