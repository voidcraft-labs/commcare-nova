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
  with per-`data_type` casts (`POSTGRES_CAST_FOR_DATA_TYPE`), scalar-
  column reads for the four reserved columns (`case_id` /
  `case_type` / `owner_id` / `status`), parameter-bound runtime
  bindings (`input` / `session-user` / `session-context`), and
  correlated scalar subqueries for non-self via reads. Delegates
  literal emission to the sibling `compileLiteral` helper.

- **`compileExpression`** — value-bearing composition. Covers all 15
  arms of the `ValueExpression` union: `term` (delegates to
  `compileTerm`), `today` / `now`, `date-coerce` /
  `datetime-coerce` / `double` (typed casts), `arith` (five-op
  binary), `concat` / `coalesce` (Postgres function calls),
  `if` / `switch` (CASE expressions; `switch` is the simple-CASE
  form so the discriminator evaluates ONCE per row),
  `count` (relational aggregation over a `compileRelationPath`
  leaf), `format-date` (Postgres `to_char`), `date-add` (interval
  arithmetic), and the `unwrap-list` defensive throw.

- **`compilePredicate`** — boolean composition. Covers every arm of
  the `Predicate` union: sentinels (`match-all` / `match-none`),
  logical (`and` / `or` / `not`), comparison (six operators),
  membership (`in` / `between`), multi-select (`multi-select-contains`
  with any/all quantifiers), text match (`match` with four modes),
  geo (`within-distance`), relational (`exists` / `missing`),
  conditional (`when-input-present`), and the null/blank operators
  (`is-null` / `is-blank`).

- **`compileRelationPath`** — `case_indices` + `cases` join chains.
  Self paths collapse to a degenerate marker; ancestor / subcase /
  any-relation arms produce an aliased subquery the consumer joins
  in. Every joined `cases` row applies the
  `(app_id, owner_id)` tenant filter (spec § "Risk #1", lines 559-562).

- **`compileLiteral`** — sibling helper consumed by both
  `compileTerm`'s `literal` arm and `compilePredicate`'s `in.values`
  arm. Emits parameter-bound expressions with optional `data_type`
  casts; null literals emit as the SQL `NULL` keyword via
  `eb.lit(null)` rather than as a `$N`-bound parameter. Sibling-
  module placement avoids coupling the predicate compiler's
  `in.values` emission to term-compiler internals.

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

Term-arm operands route through `compileTerm`; every other arm
routes through `compileExpression`. The `expressionContextFor`
helper lifts a `PredicateCompileContext` into an
`ExpressionCompileContext` by attaching a `compilePredicate`
callback — that callback is the cycle break that lets the expression
compiler's predicate-bearing arms (`if.cond`, `count.where`)
recurse back through the predicate compiler without producing an
import cycle.

The dispatch logic is single-source: one helper at the predicate
compiler routes every widened operand, and that helper's contract
is the public composition shape.

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
depth via the shared context, so their correlated scalar subqueries
participate in the same uniquification scheme.

## The four documented `sql.raw` escape hatches

Kysely's typed builder cannot enumerate three Postgres tokens:
`current_date` (a function-shaped keyword that takes no parens),
`interval` (a non-standard cast type), and `geography` (a PostGIS
extension type). Four call sites use `sql.raw(...)` against closed
compile-time constants — no caller-supplied input flows into raw
emission:

- **`compileExpression.ts:354`** — `sql.raw("current_date")` for
  the `today` AST arm. Postgres's `current_date` is a function-
  shaped keyword without parens; `eb.fn("current_date", [])`
  emits invalid `current_date()`.
- **`compileExpression.ts:504`** — `sql.raw("interval")` inside
  the `date-add` arm's interval cast. `cast(... as interval)` is
  not in Kysely's `ColumnDataType` literal set.
- **`compilePredicate.ts:1096,1100`** — two `sql.raw("geography")`
  casts inside `compileWithinDistance` (LHS property and RHS
  center expression). PostGIS `geography` cast type, same API gap
  as `interval`.

Each site has an in-source comment naming the gap, the closed
constant, and the Postgres docs reference. Future `sql.raw` use
sites need the same documentation discipline.

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
strict SQL and the harness round-trip pins the four distinct cases
(`is-null` matches absent only, `is-blank` matches absent or empty,
`compare(prop, "")` matches strictly empty, `compare(prop, null)`
matches strictly null).

## Tenant-scope contract — caller emits the outer-query filter

None of the dispatch entry points emit the outer-query
`(app_id = $1 AND owner_id = $2)` tenant filter. The caller that
emits the `selectFrom('cases as c')` and the corresponding
`where('c.app_id', '=', appId).where('c.owner_id', '=', ownerId)`
owns that filter; the compiler stack only emits its filter on every
JOIN-ed `cases` row inside `compileRelationPath`'s subquery body,
so a relation walk carries its own tenant defense but the outer
scan does not. The structural enforcement of "every joined cases
read carries a tenant filter" lives at `compileRelationPath` only;
the outer-scan responsibility lives at the case-list query layer
(Plan 2 territory).

## Public surface — barrel-only

External consumers import from `@/lib/case-store/sql` (the barrel
at `./index.ts`). The barrel exposes the four compiler entry
points, their compile-context interfaces, the per-data-type cast
table, the relation-path leaf alias constants, the relation-path
leaf row type, and the Database type contract. Internal helpers
(`compileLiteral`, `compileValueExprOperand`,
`expressionContextFor`, `DynamicExprBuilder`,
`DynamicCorrelatedQuery`, `DynamicQuery`, etc.) stay package-
private — their existence is the dispatch shape, not part of the
public composition contract.

## Spec / commit chain

- Spec — `docs/superpowers/specs/2026-04-30-case-list-search-design.md`,
  V1-IN coverage at lines 457-478, CaseStore contract at lines
  350-389.
- Plan — `docs/superpowers/plans/2026-04-30-case-list-search-foundation.md`,
  Tasks C2-C8 (Database type, Term, Predicate, RelationPath,
  Expression, predicate-using-expression integration, testcontainers
  harness, this barrel + CLAUDE.md task).
- Coverage matrix —
  `docs/superpowers/coverage/2026-05-02-foundation-coverage-matrix.md`
  documents every spec V1-IN operator's coverage across the four
  compilation surfaces (type checker, on-device XPath, CSQL,
  Postgres compiler).
