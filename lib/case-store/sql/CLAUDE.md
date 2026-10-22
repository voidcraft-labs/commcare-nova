# lib/case-store/sql — AST → Kysely compilers

Lowers `Expression` / `RelationPath` AST nodes into Kysely typed-builder calls Postgres executes natively. The test harness is documented in the parent `lib/case-store/CLAUDE.md`; this file holds the compiler-stack contracts.

## Dispatch + the cycle break

Every operand is one `Expression`; condition arms dispatch through the predicate compiler and value arms through the expression compiler. `expressionContextFor` lifts a predicate context into an expression context by attaching a `compilePredicate` callback — that callback is the cycle break letting the expression compiler's predicate-bearing arms (`if.cond`, `count.where`) recurse back without an import cycle. The per-data-type cast/read-operator tables live in one data-only module so extending the `data_type` enum surfaces a single `Record` exhaustivity error.

Every type-dependent SQL decision uses `recordQueryContextFor`: a `RecordQueryContext` derived from the current row schemas, lookup-row scope, form field types, search input declarations, and resolved operation identities. This runtime context has no authored slot or device profile. It is rebuilt after lexical rebinding rather than cached beside mutable compiler metadata.

The generic AST also carries contextual case-operation leaves: `field { uuid }`, `id-of { opUuid }`, `acting-user`, and `unowned`. SQL callers that genuinely evaluate an operation must supply `TermBindings.formFields`, `TermBindings.operationIds`, and a server-resolved `TermBindings.actingUserId` when referenced; each runtime identity is bound as data, never interpolated. `formFields` alone admits the real multi-select answer shape (`readonly string[]`); the term compiler serializes that array and casts it explicitly to JSONB, rather than letting node-postgres turn it into a Postgres text array. Other binding namespaces remain scalar. `unowned` resolves only to Nova's fixed CommCare `-` sentinel. Case-list/search callers omit submission bindings and the compiler throws a missing-binding invariant if a contextual leaf escapes its admitted context. There is no fallback to UUID text or client-provided identity.

## Relation walks

- Every JOIN-ed `cases` row inside `compileRelationPath`'s subquery applies the `(app_id, project_id)` tenant filter — a missing filter on any intermediate hop would let a walk reach another Project's row. (`owner_id`, the CommCare case-owner, is a separate axis and is NOT a relation-walk filter.) Each JOIN-ed row also applies the HOLD filter (`whereNotHeld` — no active `parked_case_values` entry), the join-side twin of the outer scan's `QueryArgs.includeHeld` exclusion: relation predicates, count-of-related projections, and calculated columns must see the same population as the list beside them, and the opt-in readers never compile relation walks.
- `compilePredicate` first consumes the domain's `normalizeRelationEvaluationScopes`. A scalar leaf with one relation scope becomes one correlated related-row `EXISTS`, so every property in that leaf reads the same row. Separate leaves quantify independently; generic `between` lowers to independent bound comparisons. An explicit `exists(via, where: between(prop(self), ...))` is how an author requires both bounds on one row.
- Any non-self `PropertyRef` surviving predicate normalization is a compiler bug and throws. Predicate compilation never falls back to a scalar `LIMIT 1`, pairwise node-set comparison, or a relation cross-product. `compileTerm` retains its correlated scalar-subquery path only for standalone expression compilation outside the normalized predicate entry point.
- Standalone relational terms (calculated columns, sort expressions, and defaults) canonicalize the walk from `currentCaseType` before both resolving the destination schema and compiling joins. This materializes every inferable `parent` qualifier, treats `any-relation(parent)` as parent-plus-children, and preserves explicit custom-index destinations; SQL must never re-infer a custom identifier from `parent_type` or omit a same-identifier case-type filter that the on-device wire applies.
- `count(self)` reduces to `1`, or `CASE WHEN <where> THEN 1 ELSE 0`; it does not enter the relation-path compiler.
- Every non-self scalar `count` correlates the relation leaf's `anchor_case_id` to the current anchor's `case_id`, before applying its optional leaf predicate. The relation-path subquery contains walks for all anchors; tenancy and leaf filtering alone cannot make a count row-specific. Nested counts use the depth-specific leaf alias for the same correlation.
- **Leaf-alias depth thread.** Hop aliases are isolated by SQL subquery scoping, but the leaf alias is NOT for inner→outer correlation: an inner subquery reusing `rp_leaf` shadows the outer leaf and the correlation collapses into self-equality on the inner row. `relationPathDepth` increments on every recursion into a walk's inner predicate, and `leafAliasForDepth` derives `rp_leaf` / `rp_leaf_<N>` so inner blocks never shadow outer ones. `compileTerm`'s non-self via reads inherit the same depth.

## No raw-SQL escape hatches

The stack emits no `sql.raw`. `sql` tagged templates appear only in `compilePredicate.ts`'s dynamic fuzzy-date helpers, where every interpolation is a typed-builder expression. Three Postgres features that look like they need raw emission are routed through typed-builder primitives instead:

- `today` takes the date of `timezone(viewerTimeZone, now())`: the transaction-stable instant in the viewer's local calendar, matching form/device `today()`, with the same validated UTC fallback as `format-date`. The database session timezone cannot change overdue decisions.
- `interval` isn't in Kysely's castable types → `date-add` builds through `make_interval(...)`, which returns interval directly. Fixed-duration units multiply a one-unit interval by a `float8` quantity so fractions remain representable. Calendar units check `q = trunc(q)` before adapting to `make_interval`'s integer slot: integral decimal spellings such as `1.0` work, while `1.5` raises instead of Postgres silently rounding it. The compiler resolves the base through the canonical temporal type rules: date bases cast the shifted result back to `date`, while datetime bases remain `timestamptz`, matching CCHQ's distinct `date-add` / `datetime-add` results.
- `datetime-coerce` must match CCHQ CSQL rather than Postgres's session defaults: every NAIVE value — a date-only string AND a zone-less datetime-with-time — resolves as UTC even when the connection `TimeZone` is not UTC (CCHQ parses naive values on its UTC servers). Offset-bearing values still use `timestamptz` parsing so an explicit `Z` or numeric offset wins. Naive `data_type: "datetime"` literals pin the same way, statically, in `compileLiteral`. `today` and `format-date` use the viewer's local calendar; `format-date` it parses naive operands and renders wall-clock tokens in the viewer's timezone (`TermBindings.viewerTimeZone`, browser-supplied, UTC fallback) because the device formats in ITS local zone and the browser stands in for the device — this keeps calculated columns and client-side date columns showing the same wall time. Keep the non-UTC Postgres harnesses for the coercion, the literal, the exact/range calendar-search lowerings, and the viewer-zone rendering.
- `geography` isn't castable either → `within-distance` builds via `ST_GeogFromText('POINT(lon lat)')` (SRID 4326 default per postgis.net docs), with the WKT composed through `concat(...)` so numerics stay typed-builder arguments.
- `concat` casts every part to `text` explicitly, which is already the AST's per-part coercion rule. Do not rely on Postgres's variadic `concat(any...)` overload to infer prepared-parameter types: the valid one-part editor draft `concat(literal(""))` otherwise fails with `42P18` before the live row sample or match count can run.

A new arm needing an off-surface Postgres feature follows the same shape: find the function-call form that returns the typed value directly; never reach for `sql.raw`.

## Portable case-list column reads

Calculated Results/Details values set `TermCompileContext.portableCaseDates`.
Only in that context, `date_opened` and `last_modified` read as the date of
`timezone(viewerTimeZone, stored_timestamp)`, matching Core's casedb DateData.
The flag follows self, parent and nested predicate reads. Calculated sort keys
carry the same flag through ordinary and grouped ordering. Ordinary server
filters, search, operations and stored row metadata retain datetime resolution.

Portable temporal result inference does not revalidate an admitted expression
against different property types. It follows value branches independently of
conditions. Mixed date/datetime branches explicitly promote their calendar arm
to midnight in the validated viewer timezone before PostgreSQL merges them;
connection timezone must not decide that instant. Typed mixed temporal
comparisons, membership, ranges and switch selectors apply the same promotion,
including nested predicates. This preserves Nova's existing typed SQL comparison
contract; native raw DateData-versus-string generalized comparisons have their
own coercion behavior and are not proven equivalent by this date-read change.
Calendar-only branches and
custom datetime values retain their existing shapes.

## Case-list sort keys

A Results read orders by the case list's order plan
(`lib/domain/caseListOrder.ts`), each rule one `SortKey` of `lib/case-store/store.ts`.
Most keys are a `Expression` this compiler already compiles (a property,
a calculation, a select's label `switch`, a link's markdown `concat`), read as the text a device reads
(`compileExpression.ts::compileDeviceTextExpression`): a multi select's stored
JSON array is its tokens joined by one space, blank when none is selected. The
comparator is applied where a key becomes
`ORDER BY`, in `lib/case-store/postgres/store.ts::query` and `queryGrouped`, as
typed-builder expressions: text is the value lowercased with Unicode case
mapping and compared by code point (`lower(coalesce(... ::text, '') collate
"pg_c_utf8") collate "C"`, Postgres 17 and later, no ICU), as Core compares
`toLowerCase()` strings; integer and decimal read a number only where the
trimmed text is a plain decimal (`^-?[0-9]+(\.[0-9]+)?$`), truncated toward zero
for integer, with anything else sorting after every number ascending. A leading
blanks term puts a blank and a missing property first or last as the rule says,
whatever its direction, because Postgres puts `NULL` last ascending and Core
places blanks by the rule's `blanks`.

A mapping's position is a key of its own (`mapping-position`): the device
orders an ID mapping or an image map by `selected()`, which finds an entry as
one space-separated token of the value, so `store.ts::compileMappingPosition`
tests each entry with `strpos` over the padded device text.

The other key that is no `Expression` is an interval column's shown text: a
date difference, which `arith` refuses. `compileIntervalText.ts` is its own
compiler entry, built from typed-builder calls, spelling the branches the
device evaluates and `formatIntervalForPreview` shows. It reads the stored
value as text and guards it before any cast: a value is a date only where it
has the shape Core's `date()` reads (`year-month-day`, alone or before `T`)
and `pg_input_is_valid` (Postgres 16 and later) reads it as an instant, so
malformed text and the words Postgres reads as instants and a device does not
(`infinity`, `epoch`, `today`, ...) yield their raw text and never fail the
query; its calendar day is the viewer's (`compilePinnedInstant`).

## Numeric expressions

Numeric and boolean literals carry their SQL type explicitly, so expressions such as
`1 + 2` work as prepared statements. Whole numbers in int4 range use `integer`;
fractions and wider numbers use `numeric`. Explicit authored types still win.
`div` is real division; `quotient` is explicit truncating division. Every arithmetic node preserves its grouping, including a nested right operand
with the same precedence: `10 - (5 - 2)` must return `7`.

Numeric coercion binds its input through `text` before the numeric cast. Inside
`if`, `switch` and `coalesce`, the operand's text value is also gated by the
enclosing branch conditions before casting. An outer `CASE` alone is insufficient:
PostgreSQL can fold invalid constant arithmetic during planning even when a
row-backed condition never chooses it. Carry every enclosing condition, preserve
the first matching switch case and the first nonblank coalesce value, and treat a
null condition as the else/fallback branch. Executing arithmetic on invalid
numeric text still fails, as does division by zero; this is not a general
null-on-error rule.

Selected branch indices and preceding coalesce values use private one-row projections
with `OFFSET 0` to prevent planner flattening. Guards refer to projected columns,
so numeric fallback chains do not recursively duplicate parameters and a switch
relation count executes once per row. Keep nested projection aliases distinct.
Keep the final coalesce fallback inside `COALESCE`, where an unknown bound input
inherits the preceding SQL type. Switch dispatch retains its authored comparison
context; numeric question discriminators carry an explicit numeric cast and a
literal null discriminator selects the fallback.

## Blank semantics

`is-blank` matches absent-or-empty, the one absence meaning Nova's Postgres runtime and every CommCare wire target can preserve identically.

Computed and bound scalar operands check their text projection for null or empty.
Comparing a numeric, boolean, or timestamp value directly to `''` makes Postgres
cast the empty string into that type and can fail before filtering any rows.
Property checks retain their storage-aware blank semantics.

`coalesce` skips null and empty values, preserving the selected value's type. The last argument is the fallback even when blank, matching the form runtime.

For `if`, `switch` and `coalesce` result branches, an unanswered bound `int` or
`decimal` question projects to typed numeric `NULL`; an answered question keeps
the same numeric result type, including inside nested branches. Submission storage omits
that property on create and removes it on update; a false per-write condition
preserves the old value instead. Text blanks remain empty strings and zero
remains numeric. This projection is confined to direct result branches;
arithmetic retains the coercion contract above.

Typed temporal literals are the one intentional editor-draft exception: an optional date, time, or datetime control commits `""` while unset, and the live Results preview executes that AST immediately. `compileLiteral` must pass temporal strings through `nullif(value, '')` before the cast, so the unset draft becomes typed SQL `NULL` (and therefore no match) instead of a raw Postgres `22007` error. Non-empty malformed values still reach the cast and fail; this is not a general parse-error catch or a widening of valid temporal syntax.

## Tenant-scope contract

No dispatch entry point emits the outer-query `(app_id, project_id)` filter — the caller that emits the outer `selectFrom('cases')` owns it (`PostgresCaseStore`). The compiler stack owns only the JOIN-side `project_id` filter inside relation walks. The two halves together make cross-Project reads structurally impossible.

## Barrel-only surface

External consumers import from the package barrel. Internal helpers stay package-private — their existence is the dispatch shape, not part of the public contract.

## Compiler test boundaries

Execute value semantics against Postgres: assert returned values and rows, and use
`pg_typeof` when the SQL type is itself the contract. Parameter counts and SQL
fragments cannot prove tenant filtering, relation direction, casts, or correlation.
Keep compile-only tests for preconditions and parameter binding; the large restore
plan test intentionally inspects the planner because it protects a measured query
cost regression.

Adversarial tenant fixtures may explicitly defer only `cases_project_app_tenant_fk`
inside the rollback harness to test compiler filtering independently of storage
constraints. State that the rows are intentionally invalid and never commit them.
Ordinary fixtures retain immediate constraint checking. At each relation hop,
make a wrong identifier, depth, type, app, or Project change the expected result;
do not use an alternate valid path that reaches the same destination.
