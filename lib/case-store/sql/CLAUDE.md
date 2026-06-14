# lib/case-store/sql — AST → Kysely compilers

Lowers `Predicate` / `ValueExpression` / `RelationPath` AST nodes into Kysely typed-builder calls Postgres executes natively. The test harness is documented in the parent `lib/case-store/CLAUDE.md`; this file holds the compiler-stack contracts.

## Dispatch + the cycle break

Every `ValueExpression` operand slot routes through one shared helper that forks term vs expression. `expressionContextFor` lifts a predicate context into an expression context by attaching a `compilePredicate` callback — that callback is the cycle break letting the expression compiler's predicate-bearing arms (`if.cond`, `count.where`) recurse back without an import cycle. The per-data-type cast/read-operator tables live in one data-only module so extending the `data_type` enum surfaces a single `Record` exhaustivity error.

## Relation walks

- Every JOIN-ed `cases` row inside `compileRelationPath`'s subquery applies the `(app_id, owner_id)` tenant filter — a missing filter on any intermediate hop would let a walk reach another tenant's row.
- **Leaf-alias depth thread.** Hop aliases are isolated by SQL subquery scoping, but the leaf alias is NOT for inner→outer correlation: an inner subquery reusing `rp_leaf` shadows the outer leaf and the correlation collapses into self-equality on the inner row. `relationPathDepth` increments on every recursion into a walk's inner predicate, and `leafAliasForDepth` derives `rp_leaf` / `rp_leaf_<N>` so inner blocks never shadow outer ones. `compileTerm`'s non-self via reads inherit the same depth.

## Zero raw-SQL emission

The stack emits ZERO raw SQL — no `sql\`...\`` templates, no `sql.raw`. Three Postgres features that look like they need raw emission are routed through typed-builder primitives instead:

- `current_date` is a niladic keyword `eb.fn` can't emit → `today` lifts `now()::date` (documented transaction-stable equivalent, postgresql.org/docs/18 § datetime).
- `interval` isn't in Kysely's castable types → `date-add` builds through `make_interval(...)`, which returns interval directly.
- `geography` isn't castable either → `within-distance` builds via `ST_GeogFromText('POINT(lon lat)')` (SRID 4326 default per postgis.net docs), with the WKT composed through `concat(...)` so numerics stay typed-builder arguments.

A new arm needing an off-surface Postgres feature follows the same shape: find the function-call form that returns the typed value directly; never reach for `sql.raw`.

## Postgres-strict null semantics

`is-null` matches strict-absent only; `is-blank` widens to absent-or-empty; "present with JSON null" and "present with empty string" are distinct states. CCHQ's wire layer collapses all of these — the strict semantic is the AST's contract, and the harness round-trip pins the four cases.

## Tenant-scope contract

No dispatch entry point emits the outer-query `(app_id, owner_id)` filter — the caller that emits the outer `selectFrom('cases')` owns it (`PostgresCaseStore`). The compiler stack owns only the JOIN-side filter inside relation walks. The two halves together make cross-tenant reads structurally impossible.

## Barrel-only surface

External consumers import from the package barrel. Internal helpers stay package-private — their existence is the dispatch shape, not part of the public contract.
