# lib/case-store/sql — AST → Kysely compilers

The compiler stack that lowers `Predicate` / `ValueExpression` /
`RelationPath` AST nodes (from `lib/domain/predicate`) into Kysely
typed-builder calls Postgres executes natively. Spec source: `docs/superpowers/specs/2026-04-30-case-list-search-design.md`,
"Wire emission" section (lines 455-493) for V1 operator coverage,
"CaseStore" section (lines 350-389) for the runtime contract.

The `__tests__/` harness (testcontainers + container-per-run +
transaction-per-test) is documented in the parent
`lib/case-store/CLAUDE.md`. This file documents the compiler-stack
contract.

## Four compilers, one composition shape

```
compilePredicate ─┬─► compileValueExprOperand ─┬─► compileTerm ─┐
                  │                            │                │
                  ├─► compileRelationPath ◄────┤                │
                  │                            │                │
                  └─► (cycle thunk)─► compileExpression ◄──────┘
```

- **`compileTerm`** — leaf-level value reads. JSONB property reads
  with per-`data_type` casts, scalar-column reads for the reserved
  scalar-column set (both tables live in `dataTypeTokens.ts`),
  parameter-bound runtime bindings (`input` / `session-user` /
  `session-context`), and correlated scalar subqueries for non-self
  via reads. Delegates literal emission to `compileLiteral`.

- **`compileExpression`** — value-bearing composition. Covers all 15
  arms of the `ValueExpression` union: `term`, `today` / `now`,
  `date-coerce` / `datetime-coerce` / `double` (typed casts),
  `arith` (five-op binary), `concat` / `coalesce` (Postgres
  function calls), `if` / `switch` (CASE expressions; `switch` is
  the simple-CASE form so the discriminator evaluates ONCE per
  row), `count` (relational aggregation over a `compileRelationPath`
  leaf), `format-date` (Postgres `to_char`), `date-add` (interval
  arithmetic), and the `unwrap-list` defensive throw.

- **`compilePredicate`** — boolean composition. Covers every arm of
  the `Predicate` union: sentinels (`match-all` / `match-none`),
  logical (`and` / `or` / `not`), comparison (six operators),
  membership (`in` / `between`), multi-select
  (`multi-select-contains` with any/all quantifiers), text match
  (`match` with four modes), geo (`within-distance`), relational
  (`exists` / `missing`), conditional (`when-input-present`), and
  the null/blank operators (`is-null` / `is-blank`).

- **`compileRelationPath`** — `case_indices` + `cases` join chains.
  Self paths collapse to a degenerate marker; ancestor / subcase /
  any-relation arms produce an aliased subquery the consumer joins
  in. Every joined `cases` row applies the
  `(app_id, owner_id)` tenant filter (spec § "Risk #1", lines 559-562).

- **`compileLiteral`** — helper consumed by both `compileTerm`'s
  `literal` arm and `compilePredicate`'s `in.values` arm. Emits
  parameter-bound expressions with optional `data_type` casts;
  null literals emit as the SQL `NULL` keyword via `eb.lit(null)`
  rather than as a `$N`-bound parameter.

- **`dataTypeTokens`** — data-only module owning the two
  `Record<CasePropertyDataType, <Postgres-token>>` tables every
  compiler reads: `POSTGRES_CAST_FOR_DATA_TYPE` and the package-
  internal `JSONB_READ_OPERATOR_FOR_DATA_TYPE`. Extending the
  blueprint's `data_type` enum surfaces a `Record<...>` exhaustivity
  error in this one place rather than across multiple compilers.

## The dispatch shape

The Predicate AST keeps `ValueExpression` operands in seven slots:
`comparison.left` / `.right`, `in.left`, `between.left` / `.lower`
/ `.upper`, `is-null.left`, `is-blank.left`, and
`within-distance.center`. Every site routes through one shared
helper:

```ts
function compileValueExprOperand(
  expr: ValueExpression,
  ctx: PredicateCompileContext,
): AliasableExpression<unknown> {
  if (expr.kind === "term") {
    return compileTerm(expr.term, ctx);
  }
  return compileExpression(expr, expressionContextFor(ctx));
}
```

The `expressionContextFor` helper lifts a `PredicateCompileContext`
into an `ExpressionCompileContext` by attaching a `compilePredicate`
callback — that callback is the cycle break that lets the expression
compiler's predicate-bearing arms (`if.cond`, `count.where`)
recurse back through the predicate compiler without producing an
import cycle.

## The depth-thread for nested-walk composition

Two distinct alias-collision concerns surface across nested
relation walks:

- **Hop aliases (`ci0` / `cs0` / ...)** are isolated by SQL
  subquery scoping. Each `compileRelationPath` call's hops live
  inside their own SELECT block, and SQL identifier resolution
  doesn't leak hop aliases across blocks.
- **Leaf alias (`rp_leaf`)** is NOT isolated by subquery scoping
  for inner→outer references. When an inner subquery's WHERE
  references the outer leaf (the predicate compiler's correlated-
  EXISTS body, or the term compiler's correlated scalar subquery),
  Postgres binds the unqualified `rp_leaf` to the innermost FROM
  list — so an inner alias of the same name shadows the outer one
  and the correlation predicate collapses into self-equality on
  the inner row.

`RelationPathCompileContext.relationPathDepth` is threaded by
consumers when they recurse into an inner `where`. The counter
starts at 0 at the outermost compile site and increments on every
recursion into a relation-walk leaf's inner predicate.
`compileRelationPath` reads the depth via `leafAliasForDepth(depth)`
— `rp_leaf` at depth 0, `rp_leaf_<N>` at deeper nestings — so the
inner block's leaf alias never matches the outer one and the inner
correlation reference resolves unambiguously against the outer
leaf. `compileTerm`'s non-self via prop reads inherit the same
depth via the shared context.

## Zero raw-SQL emission

The compiler stack emits ZERO raw SQL — no `sql\`...\`` template
literals, no `sql.raw(...)` calls. Every Postgres expression flows
through Kysely's typed builder surface (`eb.fn`, `eb.cast`, `eb()`,
`eb.val`, `eb.lit`, `eb.and`, `eb.or`, `eb.not`, `eb.exists`,
`eb.case()`, `eb.selectFrom`, `eb.ref`).

Three Postgres features that look like they need raw emission are
instead routed through typed-builder primitives:

- **`current_date`** — a niladic SQL keyword Kysely's `eb.fn`
  cannot emit (the function module always wraps the name in
  parens). `today` lifts `now()::date` instead — `now()` is a
  paren-friendly function `eb.fn<Date>("now")` accepts and `date`
  is in Kysely's `SIMPLE_COLUMN_DATA_TYPES` so `eb.cast<E>(expr,
  "date")` accepts it. Postgres documents `current_date` and
  `now()::date` as transaction-stable equivalents per
  `https://www.postgresql.org/docs/18/functions-datetime.html#FUNCTIONS-DATETIME-CURRENT`.
- **`interval` cast for `date-add`** — `interval` is not in
  Kysely's `SIMPLE_COLUMN_DATA_TYPES`, so `cast(... as interval)`
  cannot be reached through `eb.cast<E>(expr, "interval")`.
  `date-add` constructs the interval through Postgres's
  `make_interval(years, months, weeks, days, hours, mins, secs)`
  function, which returns the `interval` value directly — no cast
  token needed. The quantity expression occupies the positional
  slot for the AST unit (zero-padded through every preceding slot).
- **`geography` cast for `within-distance`** — same reason
  `interval` doesn't fit `eb.cast`. Instead of casting
  `ST_MakePoint(lon, lat)::geography`, the compiler builds the
  geography point via `ST_GeogFromText('POINT(<lon> <lat>)')`
  which returns geography directly (SRID 4326 is the documented
  default per
  `https://postgis.net/docs/manual-3.6/ST_GeogFromText.html`).
  The WKT payload composes through Postgres's `concat(...)` so
  the lon/lat numerics flow as typed-builder arguments rather
  than being interpolated into a raw string.

A new compiler arm that needs a Postgres feature outside Kysely's
typed-builder surface should follow the same shape: identify the
function-call surface that returns the typed value directly, rather
than reaching for `sql.raw`.

## Postgres-strict null semantics

`is-null` and `is-blank` distinguish three states at the data-
model layer: "key absent in JSONB document", "key present with
JSON null", "key present with empty string". `is-null` matches
strict-absent only; `is-blank` widens to absent-or-empty. CCHQ's
wire layer collapses all three states into one match set; Postgres
distinguishes them natively via:

- `properties ? 'key'` — key existence
- `properties->>'key' IS NULL` — null OR absent
- `properties->>'key' = ''` — empty string

The strict semantic is the AST's contract; this compiler emits the
strict SQL and the harness round-trip pins the four distinct cases.

## Tenant-scope contract — caller emits the outer-query filter

None of the dispatch entry points emit the outer-query
`(app_id = $1 AND owner_id = $2)` tenant filter. The caller that
emits the `selectFrom('cases as c')` and the corresponding
`where('c.app_id', '=', appId).where('c.owner_id', '=', ownerId)`
owns that filter; the compiler stack only emits its filter on every
JOIN-ed `cases` row inside `compileRelationPath`'s subquery body.
The structural enforcement of "every joined cases read carries a
tenant filter" lives at `compileRelationPath` only; the outer-scan
responsibility lives at `PostgresCaseStore`.

## Public surface — barrel-only

External consumers import from `@/lib/case-store/sql` (the barrel
at `./index.ts`). The barrel exposes the four compiler entry
points, their compile-context interfaces, the per-data-type cast
table, the relation-path leaf alias constants, the relation-path
leaf row type, the Database type contract, and the
`expressionContextFor` lift (which the case store's sort-expression
compile site reuses to compose against the predicate-context shape).
Internal helpers (`compileLiteral`, `compileValueExprOperand`,
`DynamicExprBuilder`, `DynamicCorrelatedQuery`, `DynamicQuery`,
etc.) stay package-private — their existence is the dispatch shape,
not part of the public composition contract.

## Spec / commit chain

- Spec — `docs/superpowers/specs/2026-04-30-case-list-search-design.md`,
  V1-IN coverage at lines 457-478, CaseStore contract at lines
  350-389.
- Plan — `docs/superpowers/plans/2026-04-30-case-list-search-foundation.md`,
  Tasks C2-C8.
- Coverage matrix —
  `docs/superpowers/coverage/2026-05-02-foundation-coverage-matrix.md`
  documents every spec V1-IN operator's coverage across the four
  compilation surfaces (type checker, on-device XPath, CSQL,
  Postgres compiler).
