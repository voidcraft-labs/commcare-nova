# lib/case-store/sql — AST → Kysely compilers

Lowers `Predicate` / `ValueExpression` / `RelationPath` AST nodes into Kysely typed-builder calls Postgres executes natively. The test harness is documented in the parent `lib/case-store/CLAUDE.md`; this file holds the compiler-stack contracts.

## Dispatch + the cycle break

Every `ValueExpression` operand slot routes through one shared helper that forks term vs expression. `expressionContextFor` lifts a predicate context into an expression context by attaching a `compilePredicate` callback — that callback is the cycle break letting the expression compiler's predicate-bearing arms (`if.cond`, `count.where`) recurse back without an import cycle. The per-data-type cast/read-operator tables live in one data-only module so extending the `data_type` enum surfaces a single `Record` exhaustivity error.

## Relation walks

- Every JOIN-ed `cases` row inside `compileRelationPath`'s subquery applies the `(app_id, project_id)` tenant filter — a missing filter on any intermediate hop would let a walk reach another Project's row. (`owner_id`, the CommCare case-owner, is a separate axis and is NOT a relation-walk filter.)
- `compilePredicate` first consumes the domain's `normalizeRelationEvaluationScopes`. A scalar leaf with one relation scope becomes one correlated related-row `EXISTS`, so every property in that leaf reads the same row. Separate leaves quantify independently; generic `between` lowers to independent bound comparisons. An explicit `exists(via, where: between(prop(self), ...))` is how an author requires both bounds on one row.
- Any non-self `PropertyRef` surviving predicate normalization is a compiler bug and throws. Predicate compilation never falls back to a scalar `LIMIT 1`, pairwise node-set comparison, or a relation cross-product. `compileTerm` retains its correlated scalar-subquery path only for standalone expression compilation outside the normalized predicate entry point.
- Standalone relational terms (calculated columns, sort expressions, and defaults) canonicalize the walk from `currentCaseType` before both resolving the destination schema and compiling joins. This materializes every inferable `parent` qualifier, treats `any-relation(parent)` as parent-plus-children, and preserves explicit custom-index destinations; SQL must never re-infer a custom identifier from `parent_type` or omit a same-identifier case-type filter that the on-device wire applies.
- `count(self)` reduces to `1`, or `CASE WHEN <where> THEN 1 ELSE 0`; it does not enter the relation-path compiler.
- **Leaf-alias depth thread.** Hop aliases are isolated by SQL subquery scoping, but the leaf alias is NOT for inner→outer correlation: an inner subquery reusing `rp_leaf` shadows the outer leaf and the correlation collapses into self-equality on the inner row. `relationPathDepth` increments on every recursion into a walk's inner predicate, and `leafAliasForDepth` derives `rp_leaf` / `rp_leaf_<N>` so inner blocks never shadow outer ones. `compileTerm`'s non-self via reads inherit the same depth.

## Zero raw-SQL emission

The stack emits ZERO raw SQL — no `sql\`...\`` templates, no `sql.raw`. Three Postgres features that look like they need raw emission are routed through typed-builder primitives instead:

- `current_date` is a niladic keyword `eb.fn` can't emit → `today` lifts `now()::date` (documented transaction-stable equivalent, postgresql.org/docs/18 § datetime).
- `interval` isn't in Kysely's castable types → `date-add` builds through `make_interval(...)`, which returns interval directly. Fixed-duration units multiply a one-unit interval by a `float8` quantity so fractions remain representable. Calendar units check `q = trunc(q)` before adapting to `make_interval`'s integer slot: integral decimal spellings such as `1.0` work, while `1.5` raises instead of Postgres silently rounding it. The compiler resolves the base through the canonical temporal type rules: date bases cast the shifted result back to `date`, while datetime bases remain `timestamptz`, matching CCHQ's distinct `date-add` / `datetime-add` results.
- `datetime-coerce` must match CCHQ CSQL rather than Postgres's session defaults: every NAIVE value — a date-only string AND a zone-less datetime-with-time — resolves as UTC even when the connection `TimeZone` is not UTC (CCHQ parses naive values on its UTC servers). Offset-bearing values still use `timestamptz` parsing so an explicit `Z` or numeric offset wins. Naive `data_type: "datetime"` literals pin the same way, statically, in `compileLiteral`. `format-date` is the one deliberately NON-UTC temporal arm: it parses naive operands and renders wall-clock tokens in the viewer's timezone (`TermBindings.viewerTimeZone`, browser-supplied, UTC fallback) because the device formats in ITS local zone and the browser stands in for the device — this keeps calculated columns and client-side date columns showing the same wall time. Keep the non-UTC Postgres harnesses for the coercion, the literal, the exact/range calendar-search lowerings, and the viewer-zone rendering.
- `geography` isn't castable either → `within-distance` builds via `ST_GeogFromText('POINT(lon lat)')` (SRID 4326 default per postgis.net docs), with the WKT composed through `concat(...)` so numerics stay typed-builder arguments.
- `concat` casts every part to `text` explicitly, which is already the AST's per-part coercion rule. Do not rely on Postgres's variadic `concat(any...)` overload to infer prepared-parameter types: the valid one-part editor draft `concat(literal(""))` otherwise fails with `42P18` before the live row sample or match count can run.

A new arm needing an off-surface Postgres feature follows the same shape: find the function-call form that returns the typed value directly; never reach for `sql.raw`.

## Postgres-strict null semantics

`is-null` matches strict-absent only; `is-blank` widens to absent-or-empty; "present with JSON null" and "present with empty string" are distinct states. CCHQ's wire layer collapses all of these — the strict semantic is the AST's contract, and the harness round-trip pins the four cases.

Typed temporal literals are the one intentional editor-draft exception: an optional date, time, or datetime control commits `""` while unset, and the live Results preview executes that AST immediately. `compileLiteral` must pass temporal strings through `nullif(value, '')` before the cast, so the unset draft becomes typed SQL `NULL` (and therefore no match) instead of a raw Postgres `22007` error. Non-empty malformed values still reach the cast and fail; this is not a general parse-error catch or a widening of valid temporal syntax.

## Tenant-scope contract

No dispatch entry point emits the outer-query `(app_id, project_id)` filter — the caller that emits the outer `selectFrom('cases')` owns it (`PostgresCaseStore`). The compiler stack owns only the JOIN-side `project_id` filter inside relation walks. The two halves together make cross-Project reads structurally impossible.

## Barrel-only surface

External consumers import from the package barrel. Internal helpers stay package-private — their existence is the dispatch shape, not part of the public contract.
