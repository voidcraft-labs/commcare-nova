# Case List & Search — Design (v2)

**Status:** Draft (v2 — supersedes v1)
**Date:** 2026-05-01
**Authors:** Braxton Perry, Claude
**Supersedes:** v1 of this same file dated 2026-04-30, which had structural gaps in operator coverage, conflated wire targets, and miscategorized calculated columns. This v2 is the result of an independent design pass plus advisor pressure-test that surfaced the v1 gaps, plus a follow-up Opus review that surfaced additional gaps still present after the first v2 draft.

## Overview

CommCare app builders today have to learn CommCare's wire dialect (XPath 1.0 with accreted CSQL extensions), edit predicates as raw strings in tiny textareas, and compose multi-line metaprograms by hand. The pain compounds: untyped properties leak into search; filter and default-filter footguns produce silent UX failures; the same expression behaves differently on mobile and web because *two on-device dialects and one server dialect* share one syntax with different operator coverage; renaming a property is a grep-and-pray operation.

Nova replaces that authoring model with a typed expression system, a structured authoring surface that never asks the user to write a string, a runtime layer that executes against typed case data, and a compiler that emits CommCare-compatible suite XML at upload — split across three distinct wire dialects.

The work splits into three coordinated layers that ship together:

1. **Foundation** — typed Predicate AST + typed Expression AST, schema-driven type checker, JSON Schema generator, three wire emitters (one per dialect), Postgres compiler.
2. **Case list config** — columns, filters, sorts, calculated columns. Full builder UI.
3. **Search config** — search inputs, default filters, claim flow, platform-aware compilation.

These ship together because the foundation gates both. Shipping case list filters and search filters with different expression dialects would re-create the cross-surface footguns CommCare has lived with for a decade.

## Goals

- Author writes one expression system (typed Predicate AST + typed Expression AST) for every filter, sort, calculated column, search input default, and default search filter.
- Author never writes a predicate or expression as a string. Every node is composed in the UI as typed cards or via the SA's typed tool surface.
- Type errors are caught at the editor — comparing an `int` property to a string literal fails at construction, not at runtime.
- Case data is typed end-to-end. Property types declared in the blueprint flow into the database write boundary, the predicate type checker, and the UI surface for editing.
- The CommCare wire format is an emission target, not the authoring surface. Authors and the SA never see XPath/CSQL strings.
- The system surfaces, at authoring time, which AST shapes are unrepresentable on which CCHQ dialect — turning the "this query won't run on Android" silent-failure pattern into a build-time error with a clear pointer.
- Preview executes searches against real, typed case data so authors validate behavior before upload.
- The architecture works at preview scale day-1 (in-memory) and promotes cleanly to Cloud SQL Postgres at deploy time without a code rewrite.

## Design properties — the quality bar

This spec ships an expression layer that authors and the SA agent compose against. The risk is the same accretion-and-untyped-strings failure that produced CCHQ's case-search XPath dialect over 25 years. The design properties below define what prevents that failure mode. Any implementation that fails these properties is wrong regardless of how cleanly it ships otherwise.

1. **Typed at construction.** Invalid predicates and expressions cannot be represented in the AST type. Comparing an `int` property to a string literal fails at the discriminated-union level, not at runtime. Constructing a typed AST is the only way to author; the constructor refuses anything ill-typed against the case-type schema in scope.
2. **Schema-driven, single source.** The blueprint's `CaseType.properties[].data_type` is the one source of truth for property types. From it, three derived artifacts follow: the JSON Schema enforced at the database write boundary, the type context used by the AST type checker, and the typed extraction emitted by the SQL compiler.
3. **One source, multiple targets.** A predicate or expression is authored once as an AST. It compiles to Postgres SQL (preview/runtime), three CommCare wire dialects (case-list filter, CSQL `_xpath_query`, post-ES search filter), and UI cards (authoring surface). The AST is the source; everything else is emission. There is no string→re-parse→AST round-tripping anywhere in the pipeline.
4. **Semantics-aware UI.** Each operator gets a card fitted to its meaning. A `within-distance` predicate renders as a geo card with property + center + distance + unit fields. A `match` predicate with `mode: "fuzzy"` renders as a property + value + tolerance card. Comparisons render with type-appropriate value inputs (date pickers for `date` properties, multi-select for enum properties). The UI is *not* a generic field/op/value row table that pretends every operator is the same shape.
5. **Targets dispatch to separate visitors, not a context branch.** The three wire dialects are not stylistic variants of one emitter — they have different operator coverage. The case-list-filter dialect (on-device, all platforms) supports plain XPath 1.0 plus `selected()` and nothing else from CSQL's extension set. The CSQL dialect (in `_xpath_query` for case-search default filters, server-evaluated by Elasticsearch) supports CCHQ's full extension set: `selected-any`, `fuzzy-match`, `phonetic-match`, `fuzzy-date`, `within-distance`, `subcase-exists`, `subcase-count`, `ancestor-exists`, `match-all`, `match-none`. The post-ES search-filter dialect (on-device, runs on the truncated 500-result ES response) is the same vocabulary as the case-list-filter dialect. The compiler dispatches to one of three visitors per emission; there is no shared "context branch" that conditionally enables operators.
6. **Representability is an authoring-time signal, not a runtime surprise.** Every AST node, given a target dialect, either compiles cleanly, compiles with a known lossy transformation (e.g., `multi-select-contains` with multi-value `any` quantifier expands to OR-of-`selected()` on-device), or is unrepresentable. The validator surfaces representability at the editor, not at upload.

Together these are the structural defenses against CommCare's accretion pattern. The implementation must demonstrate all six.

## Architecture

### Two stores, separated by concern

- **Firestore** continues to own the blueprint document, event log, chat threads, run summaries, and the Better Auth user collection. Access patterns map cleanly to Firestore's strengths: single-doc reads by ID, owner-filtered listings, append-only event subcollections.
- **Cloud SQL for PostgreSQL** owns case data. Case data is typed structured records with parent/child/extension relationships, indexed search across properties, fuzzy matching, and geo predicates — patterns that don't fit Firestore.

The two stores share no record identity. Blueprint mutations don't reference case rows; case rows don't reference blueprint docs. The decoupling avoids the cross-store sync coupling that produced two decades of pain in CommCare HQ's CouchDB+Elasticsearch architecture. Retiring Firestore entirely is a separate decision deferred to its own spec.

### Two AST families

CommCare authoring requires two distinct AST families that share Term shapes but produce different result types:

- **Predicate AST** — produces a boolean. Used in case-list filter, default search filter, post-ES search filter, claim condition, search-button display condition, the `required` assertion on a search input.
- **Expression AST** — produces a typed value. Used in calculated columns (display values), sort calculations (sort key derivation), search-input default values, the late-flag column's date argument, the time-since/until column's date argument, ID Mapping's source value.

The v1 of this spec collapsed calculated columns onto the Predicate AST. That was a category error: calculated columns return values, not booleans. Splitting into two families lets each carry the operators that make sense for it (`if` / `switch` / `concat` / `arith` / `count` are Expression-only; `compare` / `exists` / `match-all` are Predicate-only) and lets the type checker validate that an expression appears where an expression is expected.

The two families share Term shapes — a `case-property` term, a `search-input` term, a `session-context` term, a typed literal — and Predicates compose Expressions and other Predicates, while Expressions compose other Expressions and may compose Predicates inside `if` / `switch` conditionals.

#### Term family

```ts
type Term =
  | { kind: "case-property"; caseType: string; via?: RelationPath; property: string }
  | { kind: "search-input"; name: string }
  | { kind: "session-user"; field: string }            // /session/user/data/<field>
  | { kind: "session-context"; field: SessionContextField }  // /session/context/<field>
  | { kind: "literal"; type: PrimitiveType; value: string | number | boolean | null }
  | { kind: "value-expression"; expr: ValueExpression }
```

Notable shapes:

- **`case-property` carries an optional `via: RelationPath`.** This is the relational read: `case-property("patient", "age")` reads `age` on the current case; `case-property("patient", "age", via: ancestorPath("parent"))` reads `age` on the parent case. No slash-string templating; the relation is a typed structure.
- **`session-user` and `session-context` are split.** `instance('commcaresession')/session/user/data/<field>` and `instance('commcaresession')/session/context/<field>` are two different wire targets with different valid field sets (`session-context` is restricted to `userid`, `username`, `appid`, `domain`, `device_id`); the v1 AST conflated them under one `kind: "user"`.

#### Predicate family

```ts
type Predicate =
  // Sentinels
  | { kind: "match-all" }
  | { kind: "match-none" }

  // Logical
  | { kind: "and"; clauses: Predicate[] }    // .min(1); reduce empty to match-all at construction
  | { kind: "or"; clauses: Predicate[] }     // .min(1); reduce empty to match-none at construction
  | { kind: "not"; clause: Predicate }

  // Comparison
  | { kind: "compare"; op: "eq" | "neq" | "lt" | "lte" | "gt" | "gte"; left: Term; right: Term }

  // Multi-select reasoning — one operator with quantifier
  | { kind: "multi-select-contains"; property: PropertyRef; values: Literal[]; quantifier: "any" | "all" }

  // Approximate text matching — one operator with mode
  | { kind: "match"; property: PropertyRef; value: string; mode: "fuzzy" | "phonetic" | "fuzzy-date" | "starts-with" }

  // Geo
  | { kind: "within-distance"; property: PropertyRef; center: Term; distance: number; unit: "miles" | "kilometers" | "meters" }

  // Set membership over scalars (or-of-eq)
  | { kind: "in"; left: Term; values: Literal[] }

  // Range — first-class for date-range search inputs
  | { kind: "between"; left: Term; lower?: Term; upper?: Term; lowerInclusive: boolean; upperInclusive: boolean }

  // Null check — first-class so it doesn't compile to `prop = ''` footguns silently
  | { kind: "is-null"; left: Term }

  // Relational — typed paths, no string templates
  | { kind: "exists"; via: RelationPath; where?: Predicate }
  | { kind: "missing"; via: RelationPath; where?: Predicate }   // sugar = not(exists(...))

  // Conditional clause inclusion — input-driven
  | { kind: "when-input-present"; input: SearchInputRef; clause: Predicate }
```

#### Expression family

```ts
type ValueExpression =
  | { kind: "term"; term: Term }
  | { kind: "today" }                  // ISO date in project timezone
  | { kind: "now" }                    // ISO datetime in UTC
  | { kind: "date-add"; date: ValueExpression; interval: "seconds"|"minutes"|"hours"|"days"|"weeks"|"months"|"years"; quantity: ValueExpression }
  | { kind: "date-coerce"; value: ValueExpression }     // CommCare's date('YYYY-MM-DD')
  | { kind: "datetime-coerce"; value: ValueExpression }
  | { kind: "double"; value: ValueExpression }          // forced numeric coercion
  | { kind: "arith"; op: "+"|"-"|"*"|"div"|"mod"; left: ValueExpression; right: ValueExpression }
  | { kind: "concat"; parts: ValueExpression[] }
  | { kind: "coalesce"; values: ValueExpression[] }     // first non-empty value; fallback chain
  | { kind: "if"; cond: Predicate; then: ValueExpression; else: ValueExpression }
  | { kind: "switch"; on: ValueExpression; cases: { when: Literal; then: ValueExpression }[]; fallback: ValueExpression }
  | { kind: "count"; via: RelationPath; where?: Predicate }     // value, not predicate
  | { kind: "unwrap-list"; value: ValueExpression }              // unpack JSON-encoded array (CSQL value function)
  | { kind: "format-date"; date: ValueExpression; pattern: "short" | "long" | "iso" | string }
```

Three things to call out:

- **`count` is a value expression, not a predicate.** This is the move that lets `subcase-count > 2` compose naturally as `gt(count(via: subcasePath("parent")), literal(2))` rather than being a special-case predicate. Modeling count as a value also lets `gt(count(...), term(prop("patient", "expected_visits")))` express a comparison between a related-case count and a property on the current case — CCHQ doesn't support this; Nova naturally does (lossy at the CCHQ boundary, clean on Postgres).
- **`if` and `switch` cover the calculated-column UX.** The cache file's example sort-calculation `if(risk = 'Very Risky', 1, if(risk = 'Risky', 2, ...))` is a nested `if`; authors get a structured switch-card UI that compiles to nested `if`s on the wire.
- **Why `when-input-present` stays.** Removing it (the temptation: an unset search-input behaves as null at the binding layer; clauses involving an unset input collapse via standard predicate algebra) is plausible at the SQL/in-memory evaluation layer where you actually have null values. **It is wrong at the CSQL wire layer.** CCHQ's `instance('search-input:results')/input/field[@name='X']` returns an empty string (not null) when the input is unset, and `prop = ''` is a real predicate that matches cases with empty-string properties — wrong semantics. The `if(count(input), expr, '')` wrapper is the correct production form (cache file lines 184-189). Removing `when-input-present` forces the CSQL emitter to walk the AST detecting "this subtree contains an input ref" and synthesize the wrapper implicitly — that's tree-walk logic moved from explicit AST shape to implicit emitter behavior, which is the wrong direction for the typed-AST principle.

#### Relation paths

```ts
type RelationPath =
  | { kind: "self" }
  | { kind: "ancestor"; via: RelationStep[] }                     // walk up via index
  | { kind: "subcase"; identifier: string; ofCaseType?: string }  // walk down via reverse index
  | { kind: "any-relation"; identifier: string; ofCaseType?: string }   // child OR extension

type RelationStep = { identifier: string; throughCaseType?: string }

type RelationQuantifier =
  | { kind: "any" }
  | { kind: "all" }
  | { kind: "none" }
  | { kind: "count"; op: ComparisonOp; value: number };
```

`identifier` is the index name (`parent`, `host`, custom names). `RelationStep[]` represents a multi-hop ancestor walk — `[{ identifier: "parent" }, { identifier: "host" }]` is "host of parent." No string parsing, no slash-separated paths. `ofCaseType` is an optional case-type filter that the type checker uses to narrow the property-resolution context inside `exists` / `count`.

### Three wire targets

The compiler dispatches to one of three visitors per emission. Each visitor has different operator coverage; they are not stylistic variants of one another.

| Target | Where it appears | Operator vocabulary |
|---|---|---|
| **Case-list filter** | `<detail nodeset="instance('casedb')/casedb/case[@case_type='X'][<filter>]">` on Android, Web Apps, every platform | Plain XPath 1.0 + `selected()` (single-value form) + standard XPath function set verified at `commcare-core/.../parser/ast/ASTNodeFunctionCall.java:113-269`: `today`, `now`, `date`, `format-date`, `if`, `count`, `cond`, `coalesce`, `concat`, `not`, `starts-with`, comparison, logical. **`date-add` is NOT in the on-device dispatcher** — it falls through to `XPathCustomRuntimeFunc` and the case-list-filter context does not register a handler for it. Date arithmetic on-device uses XPath operators on date values (`date(prop) + days`); month/year arithmetic is unrepresentable. Relational queries via `instance('casedb')` joins, **not** via `subcase-exists`/`ancestor-exists`. |
| **CSQL `_xpath_query`** | `<data key="_xpath_query" ref="'<csql>'"/>` inside `<remote-request>/<query>`, evaluated server-side by Elasticsearch | Two distinct CSQL function sets, verified at `commcare-hq/corehq/apps/case_search/xpath_functions/__init__.py`. **Query functions** (predicate-position, lines 39-54): `selected`, `selected-any`, `selected-all`, `fuzzy-match`, `phonetic-match`, `fuzzy-date`, `within-distance`, `subcase-exists`, `subcase-count`, `ancestor-exists`, `match-all`, `match-none`, `not`, `starts-with`, `=`, `!=`, `<`, `<=`, `>`, `>=`. **Value functions** (term-position, lines 27-36): `date`, `date-add`, `datetime`, `datetime-add`, `double`, `now`, `today`, `unwrap-list`. **No `if`/`switch`/`count`/`arith`/`concat` inside the CSQL value** — these must be hoisted into the on-device wrapper that builds the `_xpath_query` string. The hoisting pass walks the AST, lifts conditionals/aggregations/concatenations out of the CSQL fragment, and leaves only predicate-and-value-function-position nodes inside the quoted CSQL. `subcase-count` is recognized only as the LHS of a binary comparison (`commcare-hq/.../filter_dsl.py:89-95`); `count(...)` outside a top-level comparison is unrepresentable in CSQL. |
| **Post-ES search filter** | `<search_filter>` on the case-search config — runs on the device against the truncated 500-result ES response | Same vocabulary as case-list-filter (on-device dialect). CCHQ uses this for cross-property comparisons unavailable on the server side. The 500-result truncation makes it last-resort. |

The on-device vs. CSQL function-set asymmetry is verified in source: on-device case-list dispatch is `commcare-core/src/main/java/org/javarosa/xpath/parser/ast/ASTNodeFunctionCall.java:113-269`. Functions outside the case (`if`, `count`, comparison, logical, `selected`, the standard XPath set) fall through to `XPathCustomRuntimeFunc` at line 267, which dispatches via `IFunctionHandler` — and the case-list-filter context does not register `selected-any` / `fuzzy-match` / `within-distance` / `subcase-exists` / `ancestor-exists` / `match-all` / `match-none` with that handler. **The result of emitting any CSQL function into the case-list-filter context is a runtime XPath evaluation failure on Android.** This is the bug the implementor's current `xpathEmitter.ts` ships (sends `selected-any` to the case-list-filter context for multi-value `in`); Plan 1's revision fixes it.

### The compilation pipeline

The dual AST compiles to four targets, all from the same source:

1. **Postgres SQL** for preview and (eventually) production runtime. Compiled via Kysely's typed query builder — a translator walks the AST and constructs Kysely calls. Kysely owns SQL generation; we own only the AST → builder mapping. Postgres natively supports the full operator set; nothing is lossy at this boundary.
2. **CommCare wire — case-list filter** — for `<detail>` nodeset filters. Plain XPath 1.0 + `selected()` only.
3. **CommCare wire — CSQL** — for `_xpath_query` values. Full CCHQ extension set. The CSQL emitter wraps its output in `concat(...)` unconditionally so the wire layer is structurally simpler — every CSQL value is a `concat()` template, even those with no input refs.
4. **CommCare wire — post-ES search filter** — same vocabulary as case-list filter; separate visitor for clarity.

Plus **UI cards** for the authoring surface. The case-list-config and search-config builder UIs render the AST as composable cards; editing the cards mutates the AST. No textarea editing of predicate text anywhere — for either humans or the SA.

The author and the SA write the same shape: typed AST objects via SA tool calls or UI interactions. There is no string-as-source-of-truth in the codebase.

### Lossy-but-uploadable shapes

For cross-platform divergence, the validator distinguishes three classes:

- **Cleanly representable.** AST shape compiles directly to the target's vocabulary (e.g., `compare(prop, literal, eq)` → `prop = 'lit'` in every target).
- **Lossy but representable.** AST shape compiles via a known transformation that's correct but slower or uglier (e.g., `multi-select-contains` with `quantifier: any` and N values → OR of N `selected(prop, 'v_i')` calls in case-list-filter context, as opposed to one `selected-any(prop, 'v1 v2 ... vN')` call in CSQL). Surfaced in the UI as an informational notice.
- **Unrepresentable.** AST shape has no equivalent at the target (e.g., `match` with `mode: "fuzzy"` in case-list-filter context — there's no on-device fuzzy match). Surfaced in the UI as a hard authoring-time error before save: "this query won't run on Android — restrict to CSQL contexts (default search filters) or remove."

This is the "lossy at CCHQ boundary as a feature" promise materialized — preview shows richer queries; the validator tells you exactly what won't survive upload to which platform.

### Storage layer for cases

#### Schema

```sql
CREATE TABLE cases (
  case_id        UUID PRIMARY KEY,
  app_id         TEXT NOT NULL,
  case_type      TEXT NOT NULL,
  owner_id       TEXT,
  status         TEXT,
  opened_on      TIMESTAMPTZ,
  modified_on    TIMESTAMPTZ,
  closed_on      TIMESTAMPTZ,
  parent_case_id UUID,                    -- denormalized first parent
  properties     JSONB NOT NULL
);

CREATE TABLE case_type_schemas (
  app_id    TEXT NOT NULL,
  case_type TEXT NOT NULL,
  schema    JSONB NOT NULL,                -- JSON Schema
  PRIMARY KEY (app_id, case_type)
);

CREATE TABLE case_indices (
  case_id      UUID NOT NULL,
  ancestor_id  UUID NOT NULL,
  identifier   TEXT NOT NULL,             -- 'parent', 'host', custom
  relationship TEXT NOT NULL,             -- 'child' | 'extension'
  depth        INT NOT NULL,              -- 1 = direct, 2 = grandparent
  PRIMARY KEY (case_id, ancestor_id, identifier)
);
CREATE INDEX ON case_indices (ancestor_id, identifier);
CREATE INDEX ON case_indices (case_id, identifier);
```

`case_indices` materializes every transitive `(case → ancestor)` edge. `depth=1` is the direct edge; deeper rows are the recursive transitive closure. **This is the architectural answer to CCHQ's `MAX_RELATED_CASES = 500_000` per-hop scan** (verified at `commcare-hq/corehq/apps/case_search/const.py:119`). A single indexed lookup on `(case_id, identifier)` traverses any depth in one query — the N+1 ES query pattern at `commcare-hq/corehq/apps/case_search/xpath_functions/ancestor_functions.py:39-94` becomes a single Postgres recursive CTE.

#### `case_indices` materialization policy

The transitive-closure approach has bounded cost in typical CommCare apps (1-3 levels deep, modest fan-out) but can blow up pathologically. Concrete decision needed at implementation time:

- **Option A: Full materialization** (every transitive edge stored). Reads are one indexed query at any depth. Writes pay O(depth × incoming-edges) per insert.
- **Option B: Direct edges only + recursive CTE on read.** Writes are cheap (one row per direct index). Reads use Postgres recursive CTEs — still one query, slightly slower for deep walks.

V1 implementation uses **Option B** (direct edges + recursive CTE on read) for write predictability. If profiling shows recursive CTE dominates query cost, switch to Option A — the read-path code is the same; only the materialization trigger changes. Both options are within the same architectural commitment.

#### Write-time validation

A BEFORE INSERT/UPDATE trigger on `cases` validates `properties` against the schema row in `case_type_schemas` for the row's `(app_id, case_type)`. Mismatch raises EXCEPTION; bad writes never land. Validation uses `pg_jsonschema` when Cloud SQL's allowlist permits, or a PL/pgSQL implementation as fallback. The architecture is identical either way.

Application-layer validation runs the **same JSON Schema** in TypeScript before every write, so the same code validates the same data in tests and production. The trigger is a defense-in-depth backstop; the primary validator is application-layer.

#### Schema synchronization mechanism

`case_type_schemas` is a derived artifact of the blueprint's `CaseType.properties[].data_type`. Whenever the blueprint mutates in any way that affects a case-type's property surface — a `data_type` change, a property addition, a property removal, a property rename, an option add/remove on a `single_select`/`multi_select` — the case-type's row in `case_type_schemas` is regenerated and upserted. The sync is **synchronous on the blueprint write path** (not a background job), so the database always reflects the blueprint's current schema before any case-store write evaluates against it.

The sync is owned by the blueprint-write pipeline (Plan 3 wires this up at the Module schema mutator). The case-store interface exposes `syncSchemaForCaseType(appId, caseType)`, which reads the blueprint, regenerates the JSON Schema via the Plan 1 generator, and upserts. Mutation paths that change the blueprint call this before returning success.

#### Schema migration policy

When a blueprint change makes existing case rows incompatible with the new schema, the case-store applies one of three policies depending on the change:

| Change | Policy |
|---|---|
| Property added | No-op for existing rows; new rows must include the property if `required` (else allowed absent) |
| Property removed | Existing values for the removed property remain in JSONB until next write of the row, then dropped. Validator flags the orphaned values for cleanup |
| Property renamed | Atomic rename: existing rows have the old key copied to the new key in the same write transaction. The `migrateProperty` interface handles this case |
| `data_type` changed | Migrate-or-quarantine: try to re-cast each existing value; successes update in place, failures move to `cases_quarantine` with the original value + failure reason |
| `single_select`/`multi_select` option added | No-op for existing rows |
| `single_select`/`multi_select` option removed | Existing rows with the removed value move to `cases_quarantine` (the value is no longer in the option set; loud failure rather than silent acceptance) |

All migrations run in the application layer (not in Postgres triggers) so they can quarantine rather than reject. The case-store interface exposes:

```ts
migrateProperty(args: {
  appId: string; caseType: string; property: string;
  change: { kind: "rename"; from: string; to: string }
        | { kind: "retype"; fromType: PropertyDataType; toType: PropertyDataType }
        | { kind: "narrow-options"; removedOptions: string[] }
}): Promise<MigrationReport>
```

`MigrationReport` includes counts of migrated, quarantined, and skipped rows plus the per-row failure reasons for any quarantined items. The validator surfaces quarantined rows to the author with a "review and resolve" affordance.

#### Bidirectional typing

The blueprint's `CaseType.properties[].data_type` is canonical. From it, three downstream artifacts derive:

- **JSON Schema** in `case_type_schemas` — write-side enforcement
- **Type context** for the predicate type checker — author-time validation
- **Postgres extraction** in the SQL compiler — `(properties->'age')::numeric` for an `int` property

A field on a form with `case_property_on: <case_type>` and `id: <property>` is a *writer* to that property. A new validator rule enforces: the field's `kind` must match the declared `data_type`. Multiple writers to the same property must agree on type. The exact field-kind ↔ property-data-type mapping table is a Plan 3 deliverable (e.g., `text` field → `text` property; `single_select` field → `single_select` property; `geopoint` field → `geopoint` property; coercion paths like `text` field → `int` property are explicitly rejected).

### In-memory CaseStore for day-1

The Cloud SQL deployment is Phase-2 work. Day-1 ships an in-memory implementation behind the same query interface:

```ts
interface CaseStore {
  query(args: {
    appId: string; caseType: string; predicate?: Predicate;
    sort?: SortKey[]; limit?: number; offset?: number;
  }): Promise<CaseRow[]>;

  insert(args: { appId: string; row: CaseRow }): Promise<void>;
  update(args: { appId: string; caseId: string; patch: Partial<CaseRow> }): Promise<void>;
  close(args: { appId: string; caseId: string }): Promise<void>;

  traverse(args: { appId: string; caseId: string; via: RelationPath }): Promise<CaseRow[]>;
  migrateProperty(args: { appId: string; caseType: string; property: string; fromType: PropertyDataType; toType: PropertyDataType }): Promise<MigrationReport>;
}
```

V1: `InMemoryCaseStore` — implements the interface against an in-memory map keyed by app. The in-memory predicate / expression / relation evaluators **mirror the Postgres compiler's structure operator-by-operator** so a future bug-fix in one is easy to port to the other. Cross-check golden fixtures verify the two implementations stay in sync.

Phase-2: `PostgresCaseStore` — same interface, AST → Kysely → SQL via the query compiler. Promotion is an implementation swap behind the interface. No rework of authoring surface, predicate AST, expression AST, validator, sample data generation, preview UI, or wire emission.

### Sample data

```ts
interface SampleCaseGenerator {
  generate(args: { caseType: CaseType; count: number; seed: string }): CaseRow[];
}
```

V1: `HeuristicCaseGenerator` — typed pools per `data_type`, deterministic per `(app, case-type, seed)`. Default count 30 per case type. Generates parent linkages from the case-type relationship graph so `case_indices` populates and relational previews work end-to-end.

Phase-2 swap: `LlmCaseGenerator` (Haiku) — same interface; backlog item.

### Preview lifecycle

Forms in preview write through the `CaseStore` interface. A registration form persists a new row; a followup updates an existing row; a close marks closed. The store is per-session — when the user closes the preview tab or refreshes, the store resets and re-seeds from the schema. A "Reset preview data" button regenerates on demand.

Cross-session persistence requires real Postgres + per-user storage and ships in the Phase-2 deployment spec.

### Where the AST lives persistently

The Predicate and Expression ASTs are persisted in Firestore alongside the blueprint document. This keeps undo/redo, agent writes, and doc-store unity working uniformly. The cost — every preview interaction reads the AST from Firestore, compiles, then runs against the case store — is mitigated by a per-AST-hash query-plan cache: the compilation lands once on first render and reuses thereafter. Cache invalidation is structural: the AST hash changes iff the AST changes.

## Authoring surfaces

### One surface, no mode picker — locked

CommCare exposes four workflow modes (Normal / Search First / See More / Skip to Default Results) controlled by two orthogonal booleans on the wire (`auto_launch`, `default_search`). The booleans only meaningfully affect Web Apps; Android always shows the case list first regardless. The four modes are CCHQ's compromise between two backends and 25 years of accumulated UX choices; they are not a primitive Nova authoring should reproduce.

Nova does not expose workflow modes to the author. There is no mode picker, no escape hatch, no toggle. The author configures one coherent surface (case list with optional filters, sorts, columns, search inputs, and default filters); the export adapter compiles per-platform from the configured content.

**The principle:** Nova owns the authoring layer; the export layer translates to CCHQ's wire shape. CCHQ's mode picker is a CCHQ authoring-UX problem — solving it correctly there is CCHQ's job. Importing the picker into Nova replicates the underlying confusion. If a Nova-authored app produces a different (sometimes worse) UX on Web Apps than a hand-authored CCHQ app would, that's a CCHQ-side UX cost we accept rather than degrade Nova's authoring experience to match.

**Compilation by platform:**
- **Mobile** — always emits as a normal case-list module with inline list filtering. Mobile always shows the case list first regardless of any wire flag.
- **Web** — compilation depends on what the author configured AND deploy capability:
  - On deploys with `SPLIT_SCREEN_CASE_SEARCH` enabled, emits the modern split-screen UX (filters in sidebar, results in main panel). This is the preferred target.
  - On deploys without split-screen, emits as a normal list-first module (`auto_launch=false, default_search=false`) regardless of whether search inputs are configured. The user sees their local case list first; if they need to search, they hit the search button. This is more user-respectful than search-first because it does not force a user to fill a search form before learning whether they have any local cases at all.
  - Skip-to-results (`auto_launch=true, default_search=true`) is emitted only when the author has configured default filters AND zero search inputs (signaling intent: "show default-filtered results immediately; the user has no inputs to type"). This is content-derived, not author-toggled.

The author never makes a per-platform decision. The compiler picks the closest CCHQ-supported emission from configured content. Per-platform divergence is surfaced visually in the Platform Divergence Panel (Plan 4) — authors see at edit time what their app will look like on each platform.

### Case list config UI — three sections, all AST-backed

1. **Display** — columns, sort, calculated columns.
   - Columns have a `kind` discriminator (Plain, Date, Time Since/Until, Phone Number, ID Mapping, Late Flag, Search Only) and per-kind config.
   - **Calculated columns carry a ValueExpression AST node** (not a Predicate AST — the v1 fix).
   - Sort keys reference Terms or ValueExpressions with type discrimination (Plain / Date / Integer / Decimal).
2. **Filters** — always-on filter, expressed as a single Predicate AST.
   - Authored via composable cards: AND/OR groups, comparison cards, set-membership cards, distance cards, relational cards (`exists`/`missing`/`count`).
   - Cards type-check against the case-type schema at construction.
   - The same Predicate compiles to both the case-list filter and the search default filter at wire emission time. The author writes it once; the two surfaces cannot diverge by construction.
3. **Search inputs** — list of search input definitions.
   - Type (text / select / date / date-range / barcode), label, optional default value (a ValueExpression), optional XPath the input compiles to (a Predicate for advanced cases).

No textarea anywhere. No string editing. No `_xpath_query` magic-string surfaces.

### SA tool surface

The SA writes the same AST. Tool calls accept Predicate AST and ValueExpression AST inputs via Zod. Never strings. The SA gets a typed interface; humans get a typed interface; they're the same interface.

## Wire emission

### V1 scope — IN

**Predicate AST coverage:**
- Sentinels: `match-all`, `match-none`, `is-null`
- Logical: `and`, `or`, `not`
- Comparison: `compare` (six operators: eq/neq/gt/gte/lt/lte)
- Membership: `in`, `between`
- Multi-select: `multi-select-contains` (any/all quantifiers)
- Text match: `match` (fuzzy / phonetic / fuzzy-date / starts-with modes)
- Geo: `within-distance` (predicates ship; visualization deferred)
- Relational: `exists`, `missing`
- Conditional: `when-input-present`

**Expression AST coverage:**
- Terms (lifted as expressions)
- Date constants: `today`, `now`
- Date arithmetic: `date-add`, `date-coerce`, `datetime-coerce`
- Numeric: `arith`, `double`
- Text: `concat`, `format-date`
- Conditional: `if`, `switch`
- Aggregation: `count`

**Wire emission:**
- Case-list short-detail columns with format kinds: Plain, Date, Time Since/Until, Phone Number, ID Mapping, Late Flag, Search Only
- Calculated columns (Expression AST → wire)
- Case list filter (Predicate AST → wire)
- Case list sort (multi-key; types Plain / Date / Integer / Decimal; sort calculation via Expression AST)
- Case detail long-detail columns (same kinds)
- Static detail tabs
- Search input properties (text, select, date, date-range, barcode)
- Default search filters (Predicate AST → CSQL)
- Custom sort properties (incl. `commcare_search_score` as a separate "sort by relevance" toggle, not an AST term)
- Search screen title, subtitle, empty-list text
- Claim condition (Predicate AST) + `dont_claim_already_owned` toggle
- Workflow handling (per "open question" above)

### V1 scope — OUT (deferred to follow-up specs)

- Visual/geo formats: Image, Icon, Clickable Icon, Address, Distance, Address Popup, Address (map)
- Case tiles (`case_list_tile`, custom XML grid, persistent case tiles)
- Related-case detail tabs (nodeset-driven)
- Multi-select case lists
- Data registries (cross-domain case sharing)
- Lookup-table search format (fixture-dependent)
- Geocoder Broadcast / receiver expressions
- Smart links / session endpoints / clickable icons / clickable-icon auto-submit
- Custom related case property linking
- `dynamic_search`, `search_on_clear` UX
- Sort calculation FF (the Expression AST supports it; the FF gating is out)
- Cache and Index pathway (deprecated by CCHQ)
- "Don't search cases owned by following IDs"
- Real Cloud SQL Postgres deployment
- CSV upload, HQ-import, hand-typed sample cases
- LLM-powered sample data generator (Haiku)
- Firestore retirement
- Authoring surface for form-time XPath beyond the existing typed XPath dialect

### Validator coverage

- Column `field` references must resolve to known case properties.
- Filter / sort / calculated-column ASTs type-check against the case-type schema.
- Search input case-property references must resolve.
- Representability checker fires per emission target — surfaces unrepresentable AST shapes per dialect, plus lossy-but-representable warnings.
- Field-kind-vs-property-type mismatch — writers to a typed property must match the declared `data_type`. Multiple writers to the same property must agree on type.
- "Same property in both default filter and search inputs" config error (cache file line 180).

## Migration

We have approximately 100 apps. Operator-scale migration, not codebase-scale.

- `scripts/migrate-case-list-columns.ts` reads all app docs in Firestore.
- For each module's `caseListColumns` / `caseDetailColumns` in the old `{ field, header }` shape, writes the new shape.
- Idempotent — skips docs already in the new shape.
- Run once, against prod Firestore, before shipping. Dry-run first.
- Archive or delete the script after run.

The Zod schema in code only has the new shape from day one of the spec landing. No coexistence, no fallback, no doc-loader migration. If an old-shape doc reaches a runtime parser after migration, parsing fails loudly at the migration site (not at user-load — the route serves a "this app needs migration; contact support" surface rather than a parser error).

## Phase-2 follow-up specs

- **Case data persistent backend spec** — `PostgresCaseStore` swap, Cloud SQL deploy, per-user storage, RLS, connection pooling.
- **Visual/geo formats spec** — visual format kinds, case tiles, persistent tiles, map / popup / distance columns. Builds on the format-kind union and the AST.
- **Advanced search spec** — related-case linking, data registries, lookup tables, geocoder receivers, custom related-case property.
- **Multi-select spec** — distinct data + UX surface; builds on the `CaseStore` interface.
- **Sample-data sources spec** — CSV upload, HQ-import, LLM-powered generator (Haiku).

## Open verification gates

Each gate below is a concrete blocking check that must pass before the corresponding plan task is marked complete. Each gate names the task that owns it and the action the task takes if the gate fails.

- **Cloud SQL extension allowlist for `pg_jsonschema`.** Owned by Plan 1 Task C2-pre. The task runs `gcloud sql instances describe ... --format='value(databaseFlags)'` against the staging instance and queries Postgres `pg_available_extensions`. If `pg_jsonschema` is not present, the task switches the trigger implementation to the PL/pgSQL fallback (architecture identical; implementation different). Do not write the trigger before the gate runs.
- **CommCare wire-level resolution of `auto_launch=true`.** Owned by Plan 4 Task 9. Before locking emission code, the task reads `commcare-hq/corehq/apps/app_manager/suite_xml/post_process/remote_requests.py` and confirms how `auto_launch` propagates to the suite XML for both case-search and callout contexts (different semantics).
- **`inline_search` real wire behavior.** Owned by Plan 4 Task 9. Read `commcare-hq` source for the `inline_search` flag's effect on `instance('results')` vs `instance('results:inline')` before emitting the search-input refs.
- **`case_indices` materialization policy.** Owned by Plan 1 Task C5. Start with Option B (direct edges + recursive CTE); profile after V1 ships using `EXPLAIN ANALYZE` against representative datasets; switch to Option A if CTE cost dominates. Both options are within the same architectural commitment; the task ships with Option B.
- **Existing apps that have columns referencing non-existent case properties.** Owned by Plan 3 Task 15. The migration script's dry-run mode reports references that don't resolve; review before running live.

## Testing strategy

- AST type-checker unit tests against the case-type schema.
- AST → SQL compiler tests with property-based generation against expected SQL output.
- AST → wire emitter tests with golden files comparing emission against CCHQ-accepted XPath, per dialect (one golden-file suite per wire target).
- Round-trip tests: AST → SQL execution against the in-memory store; AST → SQL execution against a Postgres test instance via testcontainers (no mocks at the DB boundary).
- Cross-implementation parity tests: in-memory evaluator and Postgres compiler produce the same results for golden AST fixtures.
- Migration script: dry-run mode plus assertion tests against fixture docs.

## Risks and mitigations

- **Cloud SQL extension unavailability for `pg_jsonschema`** — fall back to PL/pgSQL validator; behavior identical from the application's perspective.
- **JSONB write bloat** from frequent updates — full-row replacement on case writes (not partial `jsonb_set`). Monitor `pg_stat_user_tables.n_dead_tup`.
- **JSONB cast safety after schema migration** — addressed via the migrate-or-quarantine policy; reads are typed-safe because writes are validated against the current schema; quarantined rows are surfaced rather than silently lost.
- **`case_indices` row-count growth** — start with Option B (direct edges + recursive CTE) for write predictability; switch to Option A if CTE cost dominates. Both within the same architectural commitment.
- **Cross-platform divergence confusion** — representability checker surfaces unrepresentable + lossy AST shapes per dialect at authoring time, not upload time.
- **Existing app migration** — one-shot script, dry-run first, no permanent migration code in runtime; broken references after migration become validator warnings.
- **Spec drift from implementation** — the spec lives at `docs/superpowers/specs/2026-04-30-case-list-search-design.md` and must move with the code. Any PR touching `lib/domain/predicate`, `lib/domain/expression`, `lib/commcare/predicate`, `lib/commcare/expression`, `lib/case-store`, or the case-list/search authoring UI must include a one-line "Spec touchpoints" note in the PR description naming the affected spec sections (or "no spec impact"). The CLAUDE.md files in each package list the spec as the source of design truth; the per-PR check ties refresh discipline to the existing review flow rather than to a calendar.

## Scope shape (not effort)

This is foundational work that ships across five separately-reviewable, separately-testable plans. None of it is "inventing a database, query language, or storage engine" — all of it is writing focused domain-specific compilers, type checkers, and a typed UI surface fitted to the domain. Each plan ships independently; subsequent plans depend on prior plans but produce reviewable software on their own.

- **Plan 1 (Foundation):** Predicate AST + Expression AST + type checker + JSON Schema generator + three wire emitters + Postgres compiler + testcontainers infra + Cloud SQL extension allowlist gate.
- **Plan 2 (Case data layer):** `CaseStore` interface + `InMemoryCaseStore` + `HeuristicCaseGenerator` + parity tests.
- **Plan 3 (Case list authoring):** Module schema + migration script + case-list config UI + SA tools + validator + wire emission for short/long detail.
- **Plan 4 (Search authoring):** Module schema for search + search config UI + SA tools + platform-aware compilation + wire emission for `<remote-request>` + claim.
- **Plan 5 (Preview search execution):** Preview surface + split-screen search + inline filter + form write-through.

The v1 of this spec made an effort estimate that was off by ~5x for Plan 1 alone. The v2 estimates were no more reliable — agentic execution velocity and the iteration tightness of typed-AST work both make conventional day-counts misleading. Effort estimates are removed from this spec and from all five plans.
