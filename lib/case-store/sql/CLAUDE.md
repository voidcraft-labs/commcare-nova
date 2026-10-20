# lib/case-store/sql — AST → Kysely compilers

Lowers `Expression` / `RelationPath` AST nodes into Kysely typed-builder calls Postgres executes natively. The test harness is documented in the parent `lib/case-store/CLAUDE.md`; this file holds the compiler-stack contracts.

## Dispatch + the cycle break

Every operand is one `Expression`; condition arms dispatch through the predicate compiler and value arms through the expression compiler. `expressionContextFor` lifts a predicate context into an expression context by attaching a `compilePredicate` callback — that callback is the cycle break letting the expression compiler's predicate-bearing arms (`if.cond`, `count.where`) recurse back without an import cycle. The per-data-type cast/read-operator tables live in one data-only module so extending the `data_type` enum surfaces a single `Record` exhaustivity error. An arm no profile with a Postgres target admits, and a read no reading holds (`closed_on` outside `search`), throws an invariant through `lib/domain/expression/errors.ts::compilerBugMessage`, whose sentence names the profile rule that keeps it out: among them a `session-datum` other than a `selected-case`, and a `project` other than of the chosen case. A case-list filter that reads the case chosen in an earlier menu compiles its id as a bound parameter from the entry's session map (`TermBindings.chosenCaseIds`, module UUID to case id), and a property of it as a correlated read of that case's row (this app, its Project, the menu's case type, not held, inside the restore scope), under the slot's reading; an id that names no such row reads the property as absent. `lib/domain/expression/chosenCase.ts::readChosenCaseProperty` is the one recognizer of that read.

Every type-dependent SQL decision uses `recordQueryContextFor`: a `RecordQueryContext` derived from the current row schemas, lookup-row scope, form field types, search input declarations, and resolved operation identities. This runtime context has no authored slot or device profile. It is rebuilt after lexical rebinding rather than cached beside mutable compiler metadata.

The generic AST also carries contextual case-operation leaves: `field { uuid }`, `id-of { opUuid }`, `acting-user`, and `unowned`. SQL callers that genuinely evaluate an operation must supply `TermBindings.formFields`, `TermBindings.operationIds`, and a server-resolved `TermBindings.actingUserId` when referenced; each runtime identity is bound as data, never interpolated. `formFields` alone admits the real multi-select answer shape (`readonly string[]`); the term compiler serializes that array and casts it explicitly to JSONB, rather than letting node-postgres turn it into a Postgres text array. Other binding namespaces remain scalar. `here` binds `TermBindings.viewerLocation` as one text parameter: the text a CommCare location handler given a browser position returns, two Java `Double.toString` values (`lib/preview/engine/runtimeBindings.ts::viewerLocationText` builds it on the server from the client's checked `{ latitude, longitude }`); `null` or absent compiles to `''`, as both runtimes give before a fix. A `within-distance` center therefore accepts Java's E-notation (`5.0E-4`). `unowned` resolves only to Nova's fixed CommCare `-` sentinel. Case-list/search callers omit submission bindings and the compiler throws a missing-binding invariant if a contextual leaf escapes its admitted context. There is no fallback to UUID text or client-provided identity.

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

- `today` takes the date of `timezone(viewerTimeZone, now())`: the transaction-stable instant in the viewer's local calendar, matching form/device `today()`, with the same validated UTC fallback as `format-date`. The database session timezone cannot change overdue decisions. A CSQL slot arrives folded: the day there is the one Core's `today()` gives in the viewer's zone, which is the same day.
- `interval` isn't in Kysely's castable types → `date-add` builds through `make_interval(...)`, which returns interval directly. Fixed-duration units multiply a one-unit interval by a `float8` quantity so fractions remain representable. Calendar units check `q = trunc(q)` before adapting to `make_interval`'s integer slot: integral decimal spellings such as `1.0` work, while `1.5` raises instead of Postgres silently rounding it. The compiler resolves the base through the canonical temporal type rules: date bases cast the shifted result back to `date`, while datetime bases remain `timestamptz`, matching CCHQ's distinct `date-add` / `datetime-add` results.
- `datetime-coerce` must match CCHQ CSQL rather than Postgres's session defaults: every NAIVE value — a date-only string AND a zone-less datetime-with-time — resolves as UTC even when the connection `TimeZone` is not UTC (CCHQ parses naive values on its UTC servers). Offset-bearing values still use `timestamptz` parsing so an explicit `Z` or numeric offset wins. Naive `data_type: "datetime"` literals pin the same way, statically, in `compileLiteral`. A custom `datetime` property read is strict (`compileTerm.ts::compileStoredInstant`): its text names an instant only in the shape a writer stores (`yyyy-MM-ddTHH:mm:ss`, any fraction, then `Z`, `±HH`, `±HH:MM` or no offset) and where `pg_input_is_valid` reads it, a naive value as UTC; any other text, padded text included, is `NULL`, so it neither fails the query nor follows the session `TimeZone`. `today` and `format-date` use the viewer's local calendar; `format-date` it parses naive operands and renders wall-clock tokens in the viewer's timezone (`TermBindings.viewerTimeZone`, browser-supplied, UTC fallback) because the device formats in ITS local zone and the browser stands in for the device — this keeps calculated columns and client-side date columns showing the same wall time. Every such device reading of the viewer's zone goes through `javaZone.ts`, which reads it as `java.util.TimeZone` does rather than as Postgres's `timezone()` does: an instant's wall clock (`javaLocalTimestamp`), its `%Z` offset (`javaOffsetMinutes`, whole minutes truncated) and a wall clock's instant (`javaWallInstant`, a repeated clock at its later reading, a skipped one forward by the gap) all take the zone's standard offset before 1900-01-01T00:00Z, where the tzdb would give local mean time (`lib/domain/javaZoneOffset.ts`). HQ's readings stay at UTC, where the two agree. Keep the non-UTC Postgres harnesses for the coercion, the literal, the exact/range calendar-search lowerings, and the viewer-zone rendering.
- `geography` isn't castable either → `within-distance` builds via `ST_GeogFromText('POINT(lon lat)')` (SRID 4326 default per postgis.net docs), with the WKT composed through `concat(...)` so numerics stay typed-builder arguments.
- `concat` casts every part to `text` explicitly, which is already the AST's per-part coercion rule. Do not rely on Postgres's variadic `concat(any...)` overload to infer prepared-parameter types: the valid one-part editor draft `concat(literal(""))` otherwise fails with `42P18` before the live row sample or match count can run.

A new arm needing an off-surface Postgres feature follows the same shape: find the function-call form that returns the typed value directly; never reach for `sql.raw`.

## Readings

Every compile site states what the rows it reads stand for, in a required
`TermCompileContext.reading: CaseReading` (`lib/domain/expression/temporalType.ts`):

- `casedb`, a device evaluating over its casedb: a browse list's filter,
  calculated columns and sort keys, the filter preview of a module without an
  effective Search, and case operations (`postgres/submissionEnvelope.ts`).
- `results`, a device evaluating over HQ's search results instance: the
  calculated columns and sort keys of an effective Search's results.
- `search`, HQ's case search: an effective Search's composed query, a count,
  and every tenant-wide authoring read (the case workspace, sample data, the
  rename preflight, internal fixed filters), which read the stored truth.

One case-list read can hold two readings, so `QueryArgs.reading` is a
`CaseQueryReading { filter, columns }`: `CASEDB_READING` is casedb throughout,
`SEARCH_READING` is `search` for the filter and `results` for the columns. A
count takes only the filter half (`CaseFilterReading`).
`caseQueryReadingFor(module)` chooses from the module's effective Search,
through the projection `lib/commcare/suite/case-search/xpathQuery.ts` reads for
the wire. Calculated columns and sort keys, ordinary and grouped, compile under
the columns half, the filter under the filter half.

Under `casedb`, `date_opened` and `last_modified` read as the date of
`javaLocalTimestamp(viewerTimeZone, stored_timestamp)`, Core's casedb `DateData`. Under
`results`, `date_opened` is the UTC calendar date of `opened_on` (HQ's
`json_format_date`) and `last_modified` its instant, whose text (a sort key,
an interval column's key) is HQ's `json_format_datetime` built at UTC
(`compileExpression.ts::compileReadingText`), never the session-zoned
`timestamptz` cast. Under `search`, both are
the stored instants, and `closed_on` is readable only there
(`compileTerm.ts::reservedColumnFor`); under any other reading it is an
invariant, because the checker admits it only in an advanced search predicate. The reading follows self, parent and
nested predicate reads, and it decides how a number becomes a date ("Day
numbers").

Temporal result inference (`resolveCaseListTemporalType`, which takes the
reading) does not revalidate an admitted expression against different property
types. It follows value branches independently of conditions. Under `casedb`, a
mixed date/datetime branch, and a system date compared with an instant, promote
the calendar value to midnight in the validated viewer timezone before
PostgreSQL merges or compares them, because the `Date` Core holds is local
midnight; connection timezone must not decide that instant. No other implicit
promotion exists: the checker refuses an uncoerced date against a date and time
in every profile. Calendar-only branches and custom datetime values retain
their existing shapes.

## Datetime comparisons

Every comparison of two datetimes compiles as an instant comparison, equality
included. A custom `datetime` property is the strict stored-instant read, and a
naive literal pins to UTC; `now` is the transaction instant; `datetime-coerce`
of text or a date is `compilePinnedInstant(value, "UTC")`, so a date is UTC
midnight, HQ's meaning; `datetime-coerce` of a number is that many days of
elapsed time after the UTC epoch (`coreDayNumber.ts::compileEpochDayInstant`,
24-hour intervals, which no zone's daylight saving moves). A `casedb` system
date is the viewer-midnight instant of the `DateData` a device holds, a
`results` `date_opened` is the UTC date the results instance holds, and a
`search` system date is the stored instant.
`__tests__/instantOrdering.postgres.test.ts` computes each verdict of the
operand and pair table Core's `InstantOrderingRuntimeTest` reads from the
operands' instants, and holds Postgres to it under every reading, in four viewer
and session zones chosen apart.

## Two-valued predicates

A predicate over a missing value is false, never SQL `NULL`. So `not`, `!=` and
`= ''` keep a case that lacks the property, as a device (an absent node unpacks
to `''`, and `!=` negates `=`) and HQ (`!=` and `not` are `NOT` of the match)
both keep it. The compiler maps unknown to false at each negation point,
`NOT coalesce(<clause>, false)`: under `not`, under `missing(self, where)`, and
for `neq`, which is the negation of the `=` atom at the leaf, after relation
normalization (rewriting first would turn `exists(R, p != x)` into
`not(exists(R, p = x))` and flip the empty relation). A positive atom stays
bare, where `NULL` and false both exclude the row, so its expression index
still applies; `and`, `or` and `CASE` are monotone, so mapping unknown to false
at the leaves equals mapping the whole. A condition read as a value
(`compileExpression`) is `coalesce(<condition>, false)`.

Equality is `compilePredicate.ts::compileEquality`. A comparand decided before
the query runs (a literal, a bound term, `here()`'s bound position) that is
blank makes the comparison the absence check of the other operand, whatever its
type, decided in JavaScript so the positive comparison keeps its index. Two
operands read per row that both read as device text are also equal when both
are blank, as `'' = ''` is on a device; numbers and temporal values are not,
because a device compares a blank number as `NaN` and the instant lowering reads
a blank as no instant. An ordering against a decided blank comparand is false.
A literal `null` is a decided blank comparand, the same as `''`: the device's
wire (`lib/commcare/xpath/wire/fromExpression.ts::wireLiteral`) and a CSQL
search (`lib/commcare/csql/emitter.ts`) both print it as `''`, so
`p = null` is the absence check of `p`, `p != null` its two-valued negation,
an ordering against it is false, and an `in` member that is `null` keeps the
cases that lack the property.
`is-blank` is `coalesce(text, '') = ''`, so absent, JSON `null` and empty text
all read blank.

## Day numbers

`coreDayNumber.ts::compileCoreDayNumber` compiles `date-coerce` of a number by
reading. Under `casedb` and `results` it is Core's, in the validated viewer zone
`z`: `n` truncated toward zero as Core's `toInt` does, then
`javaLocalTimestamp(z, E + n * interval '24 hours' + interval '12 hours')::date`, with
`E = timezone(z, timestamp '1970-01-01 00:00:00')`, as `DateUtils.dateAdd`
computes it; the `integer` cast refuses a day outside the `int` range as Core
does. Under `search` it is HQ's calendar arithmetic,
`date '1970-01-01' + trunc(n)::integer`. The two agree except in the five Pacific
zones whose offset moved by more than twelve hours after 1970, where a device's
list and HQ's search differ by a day and Preview shows each as its runtime does.
The compiler has no formula for a date read as a number: no slot with a
Postgres target reaches one.

## CSQL slots arrive folded

Preview evaluates a Search's runtime segments, runtime choices and obligations
in the browser, and `lib/commcare/csql/fold.ts::foldCsqlRuntime` replaces each
with a literal, its chosen branch or `match-none` before this compiler runs, so
no runtime leaf reaches a CSQL compile. Preview folds the rows of the case list
filter and the advanced inputs' predicates (`lib/preview/engine/searchCsqlRuntime.ts`);
a simple input arrives as the literal its answer is. A row neither Preview's
evaluator nor its XPath worker could work out never reaches this compiler: the
Results read refuses the search (`SearchCsqlRuntimeWire.unevaluated`), as it
refuses a row left holding a device-only read no value arrived for. Any other
node no value arrived for compiles through the ordinary bindings
(`TermBindings.searchInputs`, `sessionContext`), which leave the CSQL path
otherwise. A read keyed by case ids (the registered case) compiles no row of
the search. `value-list` compiles to `<anchor> in (<item>, …)`, each item a
bound literal of the anchor's type; an item that can't be read as that type
matches nothing and is left out, a list with none is false, and `!=` is its
two-valued negation (`compilePredicate.ts::compileValueListEquality`). A
`within-distance` whose radius or unit is a value (a browse list's filter can
hold one; a CSQL slot's fold makes both literal) compiles as a `CASE` over the
nine units' meter factors (`lib/domain/expression/distance.ts::METERS_PER_DISTANCE_UNIT`),
the radius read as Core's `number()` reads plain decimal text; an unknown unit
or a radius not above zero matches nothing. `if` and `switch` over clauses
compile as `CASE WHEN` (`compileExpression.ts::compileIf`), a null condition
taking the else branch. `datetime-coerce` of a number is epoch days as an
instant (`coreDayNumber.ts::compileEpochDayInstant`).

## Case-list sort keys

A Results read orders by the case list's order plan
(`lib/domain/caseListOrder.ts`), each rule one `SortKey` of `lib/case-store/store.ts`. Each key compiles under the read's columns reading (`QueryArgs.reading.columns`, "Readings").
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

`is-blank` matches absent-or-empty, the one absence meaning Nova's Postgres runtime and every CommCare wire target can preserve identically. A comparison with the literal `''` compiles as the same check ("Two-valued predicates").

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
