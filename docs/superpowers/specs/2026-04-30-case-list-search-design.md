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
3. **Search config** — claim flow, display labels, platform-aware compilation. Search inputs and the search default filter live on `caseListConfig` (one source for both case-list and search) — `caseSearchConfig` carries only the search-specific authoring concerns that have no case-list parallel.

These ship together because the foundation gates both. Shipping case list filters and search filters with different expression dialects would re-create the cross-surface footguns CommCare has lived with for a decade.

## Goals

- Author writes one expression system (typed Predicate AST + typed Expression AST) for every filter, sort, calculated column, search input default, and default search filter.
- Author never writes a predicate or expression as a string. Every node is composed in the UI as typed cards or via the SA's typed tool surface.
- Type errors are caught at the editor — comparing an `int` property to a string literal fails at construction, not at runtime.
- Case data is typed end-to-end. Property types declared in the blueprint flow into the database write boundary, the predicate type checker, and the UI surface for editing.
- The CommCare wire format is an emission target, not the authoring surface. Authors and the SA never see XPath/CSQL strings.
- The wire emitters faithfully translate any AST into CCHQ's wire format. Every AST shape produces a wire string (closest CCHQ form for shapes with no exact equivalent; literal function-call syntax for shapes whose AST kind has a named CCHQ function). Nova targets the maximum web-apps-supported CCHQ feature subset; what a runtime player chooses to render is Dimagi's concern.
- The user is always in the real app — there is no preview mode. The flipbook UI toggles between editing app structure and using the running app; both views read/write the same Cloud SQL Postgres `cases` rows. Sample data generation is a user action, not a mode.

## Design properties — the quality bar

This spec ships an expression layer that authors and the SA agent compose against. The risk is the same accretion-and-untyped-strings failure that produced CCHQ's case-search XPath dialect over 25 years. The design properties below define what prevents that failure mode. Any implementation that fails these properties is wrong regardless of how cleanly it ships otherwise.

1. **Typed at construction.** Invalid predicates and expressions cannot be represented in the AST type. Comparing an `int` property to a string literal fails at the discriminated-union level, not at runtime. Constructing a typed AST is the only way to author; the constructor refuses anything ill-typed against the case-type schema in scope.
2. **Schema-driven, single source.** The blueprint's `CaseType.properties[].data_type` is the one source of truth for property types. From it, three derived artifacts follow: the JSON Schema enforced at the database write boundary, the type context used by the AST type checker, and the typed extraction emitted by the SQL compiler.
3. **One source, multiple targets.** A predicate or expression is authored once as an AST. It compiles to Postgres SQL (the live runtime), three CommCare wire dialects (case-list filter, CSQL `_xpath_query`, post-ES search filter), and UI cards (authoring surface). The AST is the source; everything else is emission. There is no string→re-parse→AST round-tripping anywhere in the pipeline.
4. **Semantics-aware UI.** Each operator gets a card fitted to its meaning. A `within-distance` predicate renders as a geo card with property + center + distance + unit fields. A `match` predicate with `mode: "fuzzy"` renders as a property + value + tolerance card. Comparisons render with type-appropriate value inputs (date pickers for `date` properties, multi-select for enum properties). The UI is *not* a generic field/op/value row table that pretends every operator is the same shape.
5. **Two emitters, three slots.** CCHQ's wire format has three slots that consume XPath strings: case-list-filter (on-device), CSQL (`_xpath_query`, server-parsed by ElasticSearch), and post-ES search-filter (on-device, after server narrowing). Two of those slots — case-list-filter and search-filter — share the same on-device XPath grammar and emit through one Nova emitter. The third slot — CSQL — has a restricted ES-parsed grammar; Nova emits to it through a separate emitter that runs a hoisting pass to lift non-CSQL-grammar nodes into the on-device wrapper that builds the `_xpath_query` string. The hoisting pass is total; every AST shape produces a CSQL emission via hoist + faithful emission. There is no shared "context branch" that conditionally enables operators.
6. **Faithful wire emission, no per-dialect rejection.** Every AST node, given a wire slot, produces a wire string. Shapes with no exact CCHQ equivalent emit the closest CCHQ form (e.g. `is-null` → `prop = ''`); shapes whose AST kind has a CCHQ function emit the literal function call (e.g. `match(mode: fuzzy)` → `fuzzy-match(prop, 'v')`). Nova does not surface "this AST shape won't render on a runtime player" as an authoring-layer signal — Dimagi's runtime fragmentation across players (Android vs web vs whatever) is their structural concern, not Nova's. Nova targets the maximum web-apps-supported CCHQ feature subset.

Together these are the structural defenses against CommCare's accretion pattern. The implementation must demonstrate all six.

## Architecture

### Two stores, separated by concern

- **Firestore** continues to own the blueprint document, event log, chat threads, run summaries, and the Better Auth user collection. Access patterns map cleanly to Firestore's strengths: single-doc reads by ID, owner-filtered listings, append-only event subcollections.
- **Cloud SQL for PostgreSQL** owns case data. Case data is typed structured records with parent/child/extension relationships, indexed search across properties, fuzzy matching, and geo predicates — patterns that don't fit Firestore.

The two stores share no record identity. Blueprint mutations don't reference case rows; case rows don't reference blueprint docs. The decoupling avoids the cross-store sync coupling that produced two decades of pain in CommCare HQ's CouchDB+Elasticsearch architecture. Retiring Firestore entirely is a separate decision deferred to its own spec.

### Two AST families

CommCare authoring requires two distinct AST families that share Term shapes but produce different result types:

- **Predicate AST** — produces a boolean. Used in case-list filter, default search filter, post-ES search filter, search-button display condition, the `required` assertion on a search input.
- **Expression AST** — produces a typed value. Used in calculated columns (display values), sort calculations (sort key derivation), search-input default values, the interval column's date argument (the kind covers both relative-display and threshold-flag UX), ID Mapping's source value.

The v1 of this spec collapsed calculated columns onto the Predicate AST. That was a category error: calculated columns return values, not booleans. Splitting into two families lets each carry the operators that make sense for it (`if` / `switch` / `concat` / `arith` / `count` are Expression-only; `compare` / `exists` / `match-all` are Predicate-only) and lets the type checker validate that an expression appears where an expression is expected.

The two families share Term shapes — a `case-property` term, a `search-input` term, a `session-context` term, a typed literal — and Predicates compose Expressions through their operand slots, while Expressions compose other Expressions and may compose Predicates inside `if` / `switch` / `count` arms.

The two families live in one package (`lib/domain/predicate`). Predicates ARE expressions that resolve to boolean — the boolean-typed arm of the broader expression family — so collapsing the families into one module eliminates the cross-package `z.lazy` an earlier design needed. Cross-cycle recursion (Predicate operators carrying `ValueExpression` operands; ValueExpression's `if` / `switch` / `count` carrying `Predicate` clauses) goes through `z.lazy` intra-file — the canonical Zod pattern for self-recursion through discriminated unions.

#### Term family

```ts
type Term =
  | { kind: "case-property"; caseType: string; via?: RelationPath; property: string }
  | { kind: "search-input"; name: string }
  | { kind: "session-user"; field: string }                  // /session/user/data/<field> — open namespace, custom user-data fields
  | { kind: "session-context"; field: SessionContextField }  // /session/context/<field> — closed enum: SESSION_CONTEXT_FIELDS
  | { kind: "literal"; type: PrimitiveType; value: string | number | boolean | null }
```

`Term` does NOT carry a `value-expression` arm. The cross-family composition lives one level up — Predicate operators take `ValueExpression` operands directly, and `ValueExpression`'s `term` arm lifts any Term where a value is expected. Builders auto-wrap Term-shaped inputs at the call site (`eq(prop("name"), literal("Alice"))` keeps working — both arguments lift through the structural `term` arm) so the wire-shape change is invisible to existing call sites.

Notable shapes:

- **`case-property` carries an optional `via: RelationPath`.** This is the relational read: `case-property("patient", "age")` reads `age` on the current case; `case-property("patient", "age", via: ancestorPath(relationStep("parent", "household")))` reads `age` on the parent `household` case. No slash-string templating; the relation is a typed structure. The `caseType` slot names the *originating scope* (the case type the predicate runs against — i.e., the case type at the predicate's "self" position), not where the property lives. When `via` is absent or `{ kind: "self" }`, the property is read on a case of `caseType`. When `via` is a relation walk, the walk resolves to a destination case type and `property` is read there. The `caseType` qualifier stays explicit even when `via` is present so the originating scope is always recoverable without tracing back through nesting.
- **`session-user` and `session-context` are split.** `instance('commcaresession')/session/user/data/<field>` (open namespace, custom user-data fields) and `instance('commcaresession')/session/context/<field>` (closed framework-controlled set) are two different wire targets. The full closed set populated by the framework is `deviceid` / `appversion` / `username` / `userid` / `drift` / `window_width` / `applanguage` per `commcare-core/src/main/java/org/commcare/session/SessionInstanceBuilder.java:89-103`; the AST's `SESSION_CONTEXT_FIELDS` exposes `userid` / `username` / `deviceid` / `appversion` (the four with clear authoring semantics — owner / display / device-targeting / version-gating). `drift` is a diagnostic clock-skew signal, `window_width` is a UI-internal viewport metric, and `applanguage` is a localization concern; none has an authoring semantic that justifies AST exposure today, and the closed-enum shape allows fields to be added non-breakingly when a real authoring use case surfaces. The earlier draft of this spec had a single `kind: "user"` term that conflated `/user/data/` and `/context/`, hiding the open/closed distinction; the split exists for that reason.

#### Predicate family

Operand-widening note: every value-bearing slot below (`compare.left`/`right`, `in.left`, `within-distance.center`, `between.left`/`lower`/`upper`, `is-null.left`, `is-blank.left`) carries `ValueExpression`, not bare `Term`. The widening lets arithmetic / conditional / aggregation expressions sit in operand position (`gt(arith("+", prop("age"), literal(1)), literal(18))`) at the AST. Term-shaped operands flow through unchanged — builders auto-wrap them as `{ kind: "term", term: <Term> }` at the call site. The slots that intentionally do NOT widen are `multi-select-contains.values` and `in.values` (literal-only, demanded by the wire-target's static-list expectation), `multi-select-contains.property`, `match.property`, and `within-distance.property` (geo / multi-select dispatches key off a property name, not a value expression), and `match.value` (the operator captures a static match value baked at construction time).

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
  | { kind: "compare"; op: "eq" | "neq" | "lt" | "lte" | "gt" | "gte"; left: ValueExpression; right: ValueExpression }

  // Multi-select reasoning — one operator with quantifier
  | { kind: "multi-select-contains"; property: PropertyRef; values: Literal[]; quantifier: "any" | "all" }

  // Approximate text matching — one operator with mode
  | { kind: "match"; property: PropertyRef; value: string; mode: "fuzzy" | "phonetic" | "fuzzy-date" | "starts-with" }

  // Geo
  | { kind: "within-distance"; property: PropertyRef; center: ValueExpression; distance: number; unit: "miles" | "kilometers" | "meters" }

  // Set membership over scalars (or-of-eq)
  | { kind: "in"; left: ValueExpression; values: Literal[] }

  // Range — first-class for date-range search inputs.
  // At least one of `lower` / `upper` is required (refined by the schema).
  // Builders default `lowerInclusive` / `upperInclusive` to true (mathematical
  // [lower, upper] convention). When both bounds are literal-typed (lifted
  // through the `term` arm of `ValueExpression`) and `lower > upper`, the
  // predicate is trivially false; the schema does NOT reject this at parse
  // time because bounds may also be expression-shaped (search-input refs,
  // arithmetic-derived bounds) whose values are unknown until runtime. The
  // type checker detects the literal-pair impossibility by unwrapping the
  // term arm; runtime checking handles non-literal shapes.
  | { kind: "between"; left: ValueExpression; lower?: ValueExpression; upper?: ValueExpression; lowerInclusive: boolean; upperInclusive: boolean }

  // Null / blank checks — see "Null vs blank semantics" below for the
  // emission behavior. `is-null` is strict (absent only); `is-blank` is
  // portable (absent OR empty). Both emit as `prop = ''` on CCHQ wire
  // — the wire collapses absent / cleared / empty alike.
  | { kind: "is-null"; left: ValueExpression }       // strict: left resolves to absent
  | { kind: "is-blank"; left: ValueExpression }      // portable: absent OR empty-string

  // Relational — typed paths, no string templates
  | { kind: "exists"; via: RelationPath; where?: Predicate }
  | { kind: "missing"; via: RelationPath; where?: Predicate }   // sugar = not(exists(...))

  // Conditional clause inclusion — input-driven
  | { kind: "when-input-present"; input: SearchInputRef; clause: Predicate }
```

#### Null vs blank semantics

CCHQ's wire layer collapses three semantically distinct states — *property never written* / *property written, then cleared* / *property explicitly set to empty* — into one wire-readable state. On every CCHQ dialect, `prop = ''` matches all three states; in CSQL, the server-side `case_property_query()` short-circuits empty-value queries to `case_property_missing()` semantics at `commcare-hq/corehq/apps/es/case_search.py:241-246`, also matching all three states. (`case_property_missing` is a Python helper at the same file's line 378 — not a CSQL function authors can write; the empty-equality form is the only authorable shape and CCHQ does the right thing internally.) The wire conflation is a CCHQ-side accumulation; **Nova's AST and runtime are not bound by it.** Cloud SQL Postgres JSONB distinguishes "key absent" from "key present with empty value"; Nova's live runtime preserves the strict semantic end-to-end. The Predicate AST carries the strict semantic; the wire emitters faithfully emit `prop = ''` for both `is-null` and `is-blank` — the wire's lossiness is faithfully passed through.

The two operators:

| Operator | Semantic | Postgres (live runtime) | CCHQ wire |
|---|---|---|---|
| `is-null(left)` | **Strict.** `left` resolves to absent (key not present in the JSONB / Map). | `NOT (properties ? 'X')` for property refs; `count(...) = 0` for search-input refs. | Wire form `prop = ''`. CCHQ's `case_property_query()` short-circuits to `case_property_missing()` semantics at `case_search.py:241-246` and also matches absent / cleared / empty — broader than the AST's strict semantic. The wire's lossiness is faithfully emitted; Nova's Postgres runtime preserves strict semantics. |
| `is-blank(left)` | **Portable.** `left` resolves to absent OR empty-string. | `(NOT (properties ? 'X')) OR properties->>'X' = ''` for property refs; `count(...) = 0 OR ... = ''` for search-input refs. | Wire form `prop = ''` — same wire emission as `is-null`. Search-input refs in case-list / post-ES filters wrap in the `if(count(input), real_predicate, match-all())` form so absent inputs short-circuit cleanly. |

`compare(prop, literal(""))` and `compare(prop, literal(null))` remain in the AST — sometimes the author really does mean "the value is the literal empty string." On Postgres they execute strictly; on CCHQ wire they emit as `prop = ''` and CCHQ's wire-collapse broadens the match. No authoring-time hint, no soft warning, no validator rejection — the AST is faithful end-to-end and the wire's lossiness is the wire's concern.

Why both operators exist when the UI defaults to `is-blank`: the Predicate AST is the data-model contract — the discriminated-union shape is part of every persisted predicate. Omitting `is-null` from the foundation would be a one-way door: adding it back later changes the closed kind set and breaks every persisted predicate that relied on the previous shape. Keeping it in costs ~12 lines of schema/builder/type-checker; locking it out costs the data-model honesty.

Authoring surfaces (filter UI, SA tool surface) default to `is-blank` for "field is empty" intents — the canonical author-facing operator for absent-or-empty semantics. `is-null` is available for any caller that wants strict-absent: Postgres executes it natively; CCHQ wire emits as `prop = ''` (broader match than the AST says, but the closest CCHQ form). Other Nova surfaces — case-data inspection, audit and admin views, expression operators that need to distinguish absent from empty (e.g. `coalesce`) — consume `is-null` end-to-end on Postgres.

The lived-experience justification: a real prod-app default filter wraps every search-input read in `if(count(instance('search-input')/input/field[@name='X']), real_predicate, match-all())` because CCHQ's input-not-present case silently breaks the filter at search-execution time (no save-time / version-time / app-load-time error surfaces). That `count()`-wrapper boilerplate is exactly what Nova's CSQL emitter generates automatically from a clean `whenInputPresent(input("X"), ...)` AST node — authors never see it; the typed AST captures the intent and the hoisting pass produces the wire structure.

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
- **Why `when-input-present` stays.** Removing it (the temptation: an unset search-input behaves as null at the binding layer; clauses involving an unset input collapse via standard predicate algebra) is plausible at the SQL evaluation layer where you actually have null values. **It is wrong at the CSQL wire layer.** CCHQ's `instance('search-input:results')/input/field[@name='X']` returns an empty string (not null) when the input is unset, and `prop = ''` is a real predicate that matches cases with empty-string properties — wrong semantics. The `if(count(input), expr, '')` wrapper is the correct production form (cache file lines 184-189). Removing `when-input-present` forces the CSQL emitter to walk the AST detecting "this subtree contains an input ref" and synthesize the wrapper implicitly — that's tree-walk logic moved from explicit AST shape to implicit emitter behavior, which is the wrong direction for the typed-AST principle.

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

`any-relation` is direction-agnostic — it matches both CHILD and EXTENSION relationships under the same identifier. The Postgres compiler emits a `case_indices.identifier` lookup that matches both directions. CCHQ's wire grammars expose only direction-specific operators (`ancestor-exists` / `subcase-exists`), so the wire emitters expand `any-relation` to `(<ancestor-form> or <subcase-form>)` on every CCHQ slot — direction-specific OR'd. The expansion is faithful: it matches the same set of cases the AST means.

### Three wire slots, two emitters

CCHQ's wire format has three slots that consume XPath strings; two of those slots share the same XPath grammar (on-device), and one has its own grammar (CSQL).

| Slot | Where it appears | Wire grammar |
|---|---|---|
| **Case-list filter** | `<detail nodeset="instance('casedb')/casedb/case[@case_type='X'][<filter>]">` | On-device XPath. CCHQ HQ accepts arbitrary XPath here at app-import time — no parse-time validation. Runtime players evaluate the filter; what each player can render is the player's concern. |
| **CSQL `_xpath_query`** | `<data key="_xpath_query" ref="'<csql>'"/>` inside `<remote-request>/<query>`, evaluated server-side by Elasticsearch | CSQL — restricted grammar enforced by ES at search time. Two function whitelists at `commcare-hq/corehq/apps/case_search/xpath_functions/__init__.py`: query functions (predicate-position, lines 39-54) and value functions (term-position, lines 27-36). Nodes outside these sets cannot appear inside the CSQL fragment ES parses; the CSQL emitter hoists them into the on-device wrapper that builds the `_xpath_query` string. The hoisting pass is total — every AST shape produces a CSQL emission. |
| **Post-ES search filter** | `<search_filter>` on the case-search config — runs on-device against the truncated 500-result ES response | Same on-device XPath grammar as the case-list filter slot. |

The case-list filter slot and the post-ES search filter slot share the same XPath grammar, so Nova emits both through one on-device emitter. The CSQL slot has a restricted grammar, so Nova emits to it through a separate emitter that runs a hoisting pass before emission. Two emitters; three slots. The wire layer routes each emitter's output into the appropriate slot in the CCHQ XML.

Nova emits the maximum CCHQ feature subset for web apps. Per-runtime-player capability gaps (e.g. an Android player that doesn't dispatch `fuzzy-match` in a case-list slot) are Dimagi's structural concern; Nova does not encode them as authoring-layer rejection rules. The transitional `xpathEmitter.ts` had a single-context bug (sent `selected-any` to the case-list-filter context for multi-value `in`, when CSQL's `selected-any` carries multi-select-token semantics that break value-equality `in` on multi-word values per `corehq/apps/es/case_search.py:291-296`). Plan 1's two-emitter shape eliminates that bug by emitting `(prop = 'v1' or prop = 'v2' or ...)` on the on-device emitter and `selected-any(prop, 'v1 v2')` on the CSQL emitter for the appropriate quantifier.

### The compilation pipeline

The dual AST compiles to four targets, all from the same source:

1. **Postgres SQL** is the live runtime. Compiled via Kysely's typed query builder — a translator walks the AST and constructs Kysely calls. Kysely owns SQL generation; we own only the AST → builder mapping. Postgres natively supports the full operator set; nothing is lossy at this boundary.
2. **CommCare wire — case-list filter** — for `<detail>` nodeset filters. Plain XPath 1.0 + `selected()` only.
3. **CommCare wire — CSQL** — for `_xpath_query` values. Full CCHQ extension set. The CSQL emitter wraps its output in `concat(...)` unconditionally so the wire layer is structurally simpler — every CSQL value is a `concat()` template, even those with no input refs.
4. **CommCare wire — post-ES search filter** — same vocabulary as case-list filter; separate visitor for clarity.

Plus **UI cards** for the authoring surface. The case-list-config and search-config builder UIs render the AST as composable cards; editing the cards mutates the AST. No textarea editing of predicate text anywhere — for either humans or the SA.

The author and the SA write the same shape: typed AST objects via SA tool calls or UI interactions. There is no string-as-source-of-truth in the codebase.

### Wire emission is faithful

The wire emitters translate any AST into CCHQ wire format. Every AST shape produces a wire string. Three emission patterns appear:

- **Direct emission.** AST shape has an exact CCHQ-wire equivalent (e.g. `compare(prop, literal, eq)` → `prop = 'lit'` on every slot).
- **Equivalent expansion.** AST shape compiles to a structurally different wire form that matches the same set of cases (e.g. `multi-select-contains` quantifier=any with N values expands to OR of N `selected(prop, 'v_i')` calls on the on-device emitter, vs. one `selected-any(prop, 'v1 v2 ... vN')` call on the CSQL emitter — both match the same rows). The expansion is invisible to the author; the AST is the source of truth.
- **Closest-form emission.** AST shape has no exact CCHQ-wire equivalent; the emission is the closest CCHQ form, with the AST's strict semantic preserved on Postgres. The canonical case is `is-null(prop)` and `is-blank(prop)`: both emit as `prop = ''` because CCHQ's `case_property_query()` short-circuits absent / cleared / empty alike at `case_search.py:241-246`. The Postgres runtime executes the strict semantic; the CCHQ wire emission collapses to the broader match. This is the wire's lossiness, faithfully emitted.

For shapes whose AST kind has a literal CCHQ function call (e.g. `match(mode: fuzzy)` → `fuzzy-match(prop, 'v')`, `within-distance(...)` → `within-distance(...)`), the emitter produces the function-call syntax directly. The wire string is well-formed; CCHQ HQ accepts the import. Whether a runtime player evaluates the function is the player's concern.

The Postgres runtime is the authoritative semantic — it executes the AST exactly as written. The CCHQ wire emission is a translation to a less expressive grammar, with the lossy boundary compressed to the wire layer alone.

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

`case_indices` stores `(case → ancestor)` edges. `depth=1` is the direct edge; the table can also store deeper transitive rows when the materialization policy populates them. **This is the architectural answer to CCHQ's `MAX_RELATED_CASES = 500_000` per-hop scan** (verified at `commcare-hq/corehq/apps/case_search/const.py:119`). A single indexed lookup on `(case_id, identifier)` traverses any depth the materialization stores — the N+1 ES query pattern at `commcare-hq/corehq/apps/case_search/xpath_functions/ancestor_functions.py:39-94` collapses to a single Postgres query.

#### `case_indices` materialization policy

The transitive-closure approach has bounded cost in typical CommCare apps (1-3 levels deep, modest fan-out) but can blow up pathologically. Two policy options exist; both are within the same architectural commitment:

- **Option A: Full materialization** (every transitive edge stored, depth > 1 rows included). Reads at any depth are one indexed query. Writes pay O(depth × incoming-edges) per insert.
- **Option B: Direct edges only + chain-of-joins on read** (per-hop join chain, depth statically bounded by the AST `RelationPath.via` tuple-with-rest schema). Writes are cheap (one row per direct index). Reads chain one `case_indices` lookup per AST hop; each hop pins `depth = 1` so the SQL is materialization-agnostic (works under either Option).

The Plan 1 compiler (`compileRelationPath`) emits chain-of-joins with `depth = 1` filtered on every hop; the implementation uses **Option B** (direct edges only) for write predictability. If profiling shows the chain-of-joins dominates query cost, switch to Option A — the read-path code stays the same (the `depth = 1` filter still selects the direct edges from the fully-materialized closure); only the `case_indices`-write trigger changes.

#### Write-time validation

Validation runs in TypeScript at every API route writing to `cases`, against the JSON Schema row in `case_type_schemas` for the case's `(app_id, case_type)`. The schema is generated by `lib/domain/predicate/jsonSchema.ts` (Plan 1) and validated against the candidate `properties` payload by `ajv` before the row hits Postgres. Mismatch is a `400` from the API route; bad writes never land in the database.

The API route is the trust boundary; the database is internal. There is no in-database trigger and no `pg_jsonschema` extension dependency — Cloud SQL doesn't allowlist `pg_jsonschema`, and a hand-rolled PL/pgSQL JSON Schema implementation duplicating the TypeScript validator's behavior would just create a second validator to keep in sync. The single TypeScript validator is the single source of truth, runs the same schema in tests and production, and lives at the layer where every write actually arrives.

#### Schema synchronization mechanism

`case_type_schemas` is a derived artifact of the blueprint's `CaseType.properties[].data_type`. Whenever the blueprint mutates in any way that affects a case-type's property surface — a `data_type` change, a property addition, a property removal, a property rename, an option add/remove on a `single_select`/`multi_select` — the case-type's row in `case_type_schemas` is regenerated and upserted. The sync is **synchronous on the blueprint write path** (not a background job), so the database always reflects the blueprint's current schema before any case-store write evaluates against it.

The sync is owned by the blueprint-write pipeline (Plan 3 wires this up at the Module schema mutator). The case-store interface exposes `applySchemaChange(appId, caseType)` — called with no `property` / `change` after additive blueprint mutations — which reads the blueprint, regenerates the JSON Schema via the Plan 1 generator, and upserts. When the mutation also requires per-row migration (rename / retype / narrow-options), the same `applySchemaChange` call carries the `property` + `change` arguments and the schema sync + migration run in a single Postgres transaction (see "Schema migration policy" below). Mutation paths that change the blueprint call `applySchemaChange` before returning success.

#### Schema migration policy

When a blueprint change makes existing case rows incompatible with the new schema, the case-store applies one of three policies depending on the change:

| Change | Policy |
|---|---|
| Property added | No-op for existing rows; new rows must include the property if `required` (else allowed absent) |
| Property removed | Existing values for the removed property remain in JSONB until next write of the row, then dropped. Validator flags the orphaned values for cleanup |
| Property renamed | Atomic rename: existing rows have the old key copied to the new key in the same write transaction. The `applySchemaChange(change: { kind: "rename", from, to })` interface handles this case |
| `data_type` changed | Migrate-or-quarantine: try to re-cast each existing value; successes update in place, failures move to `cases_quarantine` with the original value + failure reason |
| `single_select`/`multi_select` option added | No-op for existing rows |
| `single_select`/`multi_select` option removed | Existing rows with the removed value move to `cases_quarantine` (the value is no longer in the option set; loud failure rather than silent acceptance) |

All migrations run in the application layer (not in Postgres triggers) so they can quarantine rather than reject. Schema sync + migration are exposed as a single atomic call on the case-store interface:

```ts
applySchemaChange(args: {
  appId: string;
  caseType: string;
  property?: string;
  change?:
    | { kind: "rename"; from: string; to: string }
    | { kind: "retype"; fromType: PropertyDataType; toType: PropertyDataType }
    | { kind: "narrow-options"; removedOptions: string[] };
}): Promise<MigrationReport>
```

A single transaction covers both halves: regenerate the JSON Schema and upsert `case_type_schemas`, then run the per-row migration. The transaction commits when both halves succeed or rolls back atomically — the database never holds a new schema with rows that fail validation against it. This is the structural backstop for the "apps are always in a valid state" principle at the storage layer.

`MigrationReport` includes counts of migrated, quarantined, and skipped rows plus the per-row failure reasons for any quarantined items. The validator surfaces quarantined rows to the author with a "review and resolve" affordance.

#### Bidirectional typing

The blueprint's `CaseType.properties[].data_type` is canonical. From it, three downstream artifacts derive:

- **JSON Schema** in `case_type_schemas` — write-side enforcement
- **Type context** for the predicate type checker — author-time validation
- **Postgres extraction** in the SQL compiler — `(properties->'age')::numeric` for an `int` property

A field on a form with `case_property_on: <case_type>` and `id: <property>` is a *writer* to that property. A new validator rule enforces: the field's `kind` must match the declared `data_type`. Multiple writers to the same property must agree on type. The exact field-kind ↔ property-data-type mapping table is a Plan 3 deliverable (e.g., `text` field → `text` property; `single_select` field → `single_select` property; `geopoint` field → `geopoint` property; coercion paths like `text` field → `int` property are explicitly rejected).

### CaseStore — Cloud SQL Postgres from day-1

Cloud SQL Postgres is the live runtime from v1. There is no in-memory variant, no preview/production split, no Phase-2 swap. Case data is the user's real data; the AST→Kysely compiler is the only evaluator.

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

  // Schema sync + property migration are atomic together. `applySchemaChange`
  // takes the schema regeneration and the per-row migration in one transaction
  // so the database never holds a new schema with rows that fail validation
  // against it. See "Schema synchronization mechanism" + "Schema migration
  // policy" sections above.
  applySchemaChange(args: {
    appId: string;
    caseType: string;
    property?: string;
    change?:
      | { kind: "rename"; from: string; to: string }
      | { kind: "retype"; fromType: PropertyDataType; toType: PropertyDataType }
      | { kind: "narrow-options"; removedOptions: string[] };
  }): Promise<MigrationReport>;

  generateSampleData(args: { appId: string; caseType: string; count: number; seed: string }): Promise<{ inserted: number }>;
  resetSampleData(args: { appId: string; caseType: string }): Promise<{ deleted: number; inserted: number }>;
}
```

`applySchemaChange` always re-derives the JSON Schema from the current blueprint and upserts `case_type_schemas[appId, caseType]`. When `property` and `change` are absent, only the schema sync runs (the no-op-migration path used after additive blueprint changes). When they are present, the schema sync and the per-row migration run in a single transaction: rows that fail the new schema move to `cases_quarantine` with the original value + failure reason; the transaction commits once both halves complete or rolls back atomically. `MigrationReport` includes counts of migrated / quarantined / skipped rows plus per-row failure reasons.

`PostgresCaseStore` is the only implementation. Per-user / per-app isolation uses `(app_id, owner_id)` columns on the `cases` table — same pattern every other domain table follows (apps are root-level with an `owner` field). No `session_id` column, no per-session schemas, no TRUNCATE-on-close.

Tests use testcontainers to spin up real Postgres in CI and locally. There is no parallel in-memory test runner.

### Sample data — an action, not a mode

```ts
interface SampleCaseGenerator {
  generate(args: { caseType: CaseType; count: number; seed: string }): CaseRow[];
}
```

V1: `HeuristicCaseGenerator` — typed pools per `data_type`, deterministic per `(app, case-type, seed)`. Default count 30 per case type. Generates parent linkages from the case-type relationship graph so `case_indices` populates and relational reads work end-to-end. The generator output is written through `CaseStore.insert` so the `cases` table holds real rows like any user-authored data.

The user invokes generation explicitly: `Generate sample data` populates an empty case-type; `Reset sample data` deletes existing rows and regenerates. Neither implies a mode switch — the user is still in the live app, just with seeded data.

The same `CaseGenerator` interface accepts an LLM-driven implementation (e.g. an `LlmCaseGenerator` against Haiku) — the seam is in place; the heuristic generator is the shipped implementation.

### No preview lifecycle

Nova has no separate preview mode. The flipbook UI toggles between editing app structure and using the running app — both views read/write the same Cloud SQL `cases` rows. Case data persists across sessions because it's the user's real data. Form submissions in the running-app view (registration, followup, close) write through the same `CaseStore` interface that any production write uses; there is no "preview store" to reset.

This is the deliberate antithesis of CCHQ's App Preview, which lives on its own URL, reloads on every save (starting from the home menu), is locked to a mobile frame regardless of target, and forces an edit→save→preview→reload→navigate-back cycle for every iteration. Nova rejects all of that.

### Where the AST lives persistently

The Predicate and Expression ASTs are persisted in Firestore alongside the blueprint document. This keeps undo/redo, agent writes, and doc-store unity working uniformly. The cost — every runtime interaction reads the AST from Firestore, compiles to Kysely, then runs against the case store — is mitigated by a per-AST-hash query-plan cache: the compilation lands once on first render and reuses thereafter. Cache invalidation is structural: the AST hash changes iff the AST changes.

## Authoring surfaces

### One surface, no mode picker, no platform toggle — locked

CommCare exposes four workflow modes (Normal / Search First / See More / Skip to Default Results) controlled by two orthogonal booleans on the wire (`auto_launch`, `default_search`). The booleans only meaningfully affect Web Apps; Android always shows the case list first regardless. The four modes are CCHQ's compromise between two backends and 25 years of accumulated UX choices; they are not a primitive Nova authoring should reproduce.

Nova does not expose workflow modes to the author. There is no mode picker, no escape hatch, no toggle. The author configures one coherent surface (case list with optional filter, columns + per-column sort, and search inputs; plus an optional case-search config carrying claim flow + display labels); the export adapter compiles per-platform from the configured content. The case-list filter and the search default filter share one source by construction; the case-list display sort projects identically onto both wire detail blocks.

**The principle:** Nova owns the authoring layer; the export layer translates to CCHQ's wire shape. CCHQ's mode picker is a CCHQ authoring-UX problem — solving it correctly there is CCHQ's job. Importing the picker into Nova replicates the underlying confusion. If a Nova-authored app produces a different (sometimes worse) UX on Web Apps than a hand-authored CCHQ app would, that's a CCHQ-side UX cost we accept rather than degrade Nova's authoring experience to match.

**Authoring is web-apps-shaped.** The principle generalizes beyond the workflow-mode picker to every author-facing surface. Nova's primary export target is CCHQ web apps; the live-preview (running-app view) renders the web-apps split-screen experience exclusively. There is no Android-vs-Web toggle, no platform simulator, no "see what this looks like on Android" panel. The wire emitter still produces a complete `<remote-request>` valid for both runtimes — that's the export contract — but the authoring layer doesn't expose CCHQ's runtime fragmentation as an authoring concern. Authors see one canonical rendering; the export adapter compiles to both runtimes silently.

**The deeper principle:** every per-platform UI affordance the author would otherwise be asked to think about (markdown-supported-on-web-only annotations, per-runtime preview panels, platform-shape pickers) is a leak from CCHQ's runtime fragmentation into Nova's authoring layer. Nova rejects each leak. Per-platform validation rules (the operator-allowlist gates that exist because Android can't dispatch certain operators in certain slots) are removed too — Nova emits the maximum CCHQ feature subset for web apps; runtime player capability gaps are Dimagi's structural concern.

**Compilation by platform:**
- **Mobile** — always emits as a normal case-list module with inline list filtering. Mobile always shows the case list first regardless of any wire flag.
- **Web** — compilation depends on what the author configured AND deploy capability:
  - On deploys with `SPLIT_SCREEN_CASE_SEARCH` enabled, emits the modern split-screen UX (filters in sidebar, results in main panel). This is the preferred target.
  - On deploys without split-screen, emits as a normal list-first module (`auto_launch=false, default_search=false`) regardless of whether search inputs are configured. The user sees their local case list first; if they need to search, they hit the search button. This is more user-respectful than search-first because it does not force a user to fill a search form before learning whether they have any local cases at all.
  - Skip-to-results (`auto_launch=true, default_search=true`) is emitted only when the author has configured `caseListConfig.filter` AND zero search inputs (signaling intent: "show filtered results immediately; the user has no inputs to type"). This is content-derived, not author-toggled.

The author never makes a per-platform decision. The compiler picks the closest CCHQ-supported emission from configured content. Per-platform divergence is surfaced visually in the Platform Divergence Panel (Plan 4) — authors see at edit time what their app will look like on each platform.

### Case list config UI — three sections, all AST-backed

`caseListConfig` collapses to three slots: `columns: Column[]`, `filter?: Predicate`, `searchInputs: SearchInputDef[]`. Each column carries display + sort + calc + visibility on itself — there is no parallel `sort` array, no parallel `calculatedColumns` array, no parallel `detailColumns` array. The authoring layer is column-mounted; the wire layer reads from the same column shape.

1. **Display** — `caseListConfig.columns`, the unified column array.
   - Columns are a discriminated union over six kinds: `plain`, `date`, `phone`, `id-mapping`, `interval` (covers both relative-interval and threshold-flag UX through one `display: "always" | "flag"` discriminator), and `calculated` (a `ValueExpression` AST node — calculated columns are a column kind, not a parallel array).
   - Each column carries a `uuid` (UI identity, drag/reorder handle, AST references), an optional `sort: { direction, priority }` (per-column sort directive — sort lives on the column itself, not in a parallel `SortKey[]` array), and optional `visibleInList?` / `visibleInDetail?` flags (absent ≡ visible). "Search-only" semantics — declared and wire-emitted but hidden from the case list — are expressed as `visibleInList: false`, not as a separate column kind.
   - The wire-emission comparator type for each column's sort is derived (not authored): non-calculated columns use `applicableSortTypes(propertyDataType)[0]`; calculated columns use the result type of the column's expression. Three failure shapes route to comparator type `plain`.
2. **Filters** — always-on filter, expressed as a single Predicate AST.
   - Authored via composable cards: AND/OR groups, comparison cards, set-membership cards, distance cards, relational cards (`exists`/`missing`/`count`).
   - Cards type-check against the case-type schema at construction.
   - The same Predicate compiles to both the case-list filter and the search default filter at wire emission time. The author writes it once; the two surfaces cannot diverge by construction.
3. **Search inputs** — discriminated `simple` / `advanced` union.
   - Common slots on every arm: `uuid`, `name`, `label`, `type` (text / select / date / date-range / barcode), optional `default` ValueExpression.
   - `kind: "simple"` carries `(property, mode?, via?)` — the wire layer builds the predicate from the targeted property + mode + optional relation walk. `property` is required on this arm.
   - `kind: "advanced"` carries a `predicate: Predicate` AST — the wire layer emits the predicate verbatim. No `xpath` slot at the authoring layer; "predicate" is the authoring vocabulary, "XPath" is the wire-format vocabulary.

No textarea anywhere. No string editing. No `_xpath_query` magic-string surfaces.

### SA tool surface

The SA writes the same AST. Tool calls accept Predicate AST and ValueExpression AST inputs via Zod. Never strings. The SA gets a typed interface; humans get a typed interface; they're the same interface.

## Wire emission

### V1 scope — IN

**Predicate AST coverage:**
- Sentinels: `match-all`, `match-none`
- Null / blank: `is-null` (strict; CCHQ wire emits as `prop = ''`, broader match than AST says), `is-blank` (portable; CCHQ wire emits as `prop = ''`, exact-semantic match)
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
- Case-list short-detail columns over the six column kinds — Plain, Date, Phone, ID Mapping, Interval (relative-interval / threshold-flag UX, dispatched by `display`), Calculated (Expression AST → wire)
- "Search-only" wire emission for any column with `visibleInList: false` (the column emits as a hidden short-detail field while staying available for sort + index purposes)
- Case list filter (Predicate AST → wire)
- Case list sort (multi-key; per-column `sort: { direction, priority }`; comparator types Plain / Date / Integer / Decimal derived at wire emission from each column's data type or calculated expression's result type)
- Case detail long-detail columns over the same six kinds, filtered by `visibleInDetail`
- Search inputs over both arms: `kind: "simple"` (property + mode + via) and `kind: "advanced"` (free-form predicate); widget types text / select / date / date-range / barcode
- Search default filter — `caseListConfig.filter` (the unified Predicate AST) projects onto the search side at wire emission as `<data key="_xpath_query">` (CSQL). No separate authoring slot for "search-only filter"; the case-list filter and search default filter share one source by construction. Multiple CSQL contributions (the unified filter + every advanced-arm `searchInputs[i].predicate`) AND-compose into one `<data key="_xpath_query">` element.
- Search-results display sort — `caseListConfig.columns[*].sort` (the unified column-mounted sort) projects onto BOTH the case-list `<detail id="m{N}_case_short">` and the search-results `<detail id="m{N}_search_short">` as identical `<sort>` blocks. No separate "custom sort properties" authoring slot; "from the user's perspective there is only one case list" is the structural principle. Nova never emits the `<data key="commcare_sort">` ES retrieval-sort override; ES default `_score` ranking is in effect for fuzzy / phonetic / starts-with match results, ensuring those queries surface their best matches in the 500-result cap regardless of display sort.
- Search screen title, subtitle, empty-list text
- Blacklisted owner ids (advanced cluster) — `ValueExpression` evaluating to a space-separated list of owner ids whose cases are excluded from the search-results scope. Wire form: `<data key="blacklist" ref="..."/>` on `<query>`. Niche affordance; Nova's UI hides it behind a collapsed "Advanced" section in the case-search workspace. There is no claim-condition authoring affordance — CCHQ's runtime fires the case-claim step automatically with the default guard `count(...) = 0`, regardless of any author input. The CCHQ field a Nova claim-condition editor would compile to (`additional_relevant`) is gated `CASE_SEARCH_DEPRECATED` for authoring upstream.
- Workflow handling (per "open question" above)

### V1 scope — OUT (deferred to follow-up specs)

- Visual/geo formats: Image, Icon, Clickable Icon, Address, Distance, Address Popup, Address (map)
- Case tiles (`case_list_tile`, custom XML grid, persistent case tiles)
- Detail tabs (static + nodeset-driven). CCHQ partitions the case detail screen into named tab sections. Mobile / tablet is where tabs land more naturally (the case detail there pulls out as a second column, so tabs read inline). Web apps render the case detail as a modal that interrupts flow, and case tiles are the more idiomatic surface for advanced info — so tabs see less use there. Not landed in v1; may revisit later as one of the CCHQ features in the consider/skip pile, especially if Nova starts importing existing CCHQ apps that already use tabs.
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
- CSV upload, HQ-import, hand-typed sample cases
- LLM-powered sample data generator (Haiku)
- Firestore retirement
- Authoring surface for form-time XPath beyond the existing typed XPath dialect

### Validator coverage

- Column `field` references must resolve to known case properties.
- Filter / sort / calculated-column ASTs type-check against the case-type schema.
- Search input case-property references must resolve.
- Field-kind-vs-property-type mismatch — writers to a typed property must match the declared `data_type`. Multiple writers to the same property must agree on type.
- "Same property in both `caseListConfig.filter` and a simple-arm `caseListConfig.searchInputs[i].property`" config error — fires only when `caseSearchConfig` is present (i.e., the module emits a `<remote-request>`). Both contributions AND-compose into one `<data key="_xpath_query">`; CCHQ's runtime treats the duplicate-property case as a config error.

## Migration

We have approximately 100 apps. Operator-scale migration, not codebase-scale.

- `scripts/migrate-case-list-columns.ts` reads all app docs in Firestore.
- For each module's `caseListColumns` / `caseDetailColumns` in the old `{ field, header }` shape, writes the new shape.
- Idempotent — skips docs already in the new shape.
- Run once, against prod Firestore, before shipping. Dry-run first.
- Archive or delete the script after run.

The Zod schema in code only has the new shape from day one of the spec landing. No coexistence, no fallback, no doc-loader migration. If an old-shape doc reaches a runtime parser after migration, parsing fails loudly at the migration site (not at user-load — the route serves a "this app needs migration; contact support" surface rather than a parser error).

## Follow-up specs (out of scope)

- **Visual/geo formats spec** — visual format kinds, case tiles, persistent tiles, map / popup / distance columns. Builds on the format-kind union and the AST.
- **Advanced search spec** — related-case linking, data registries, lookup tables, geocoder receivers, custom related-case property.
- **Multi-select spec** — distinct data + UX surface; builds on the `CaseStore` interface.
- **Sample-data sources spec** — CSV upload, HQ-import, LLM-powered generator (Haiku).

## Open verification gates

Each gate below is a concrete blocking check that must pass before the corresponding plan task is marked complete. Each gate names the task that owns it and the action the task takes if the gate fails.

- **Cloud SQL extension allowlist for `pg_trgm`, `fuzzystrmatch`, `postgis`.** Owned by Plan 2 Task 2. The task runs `gcloud sql instances describe ... --format='value(databaseFlags)'` against the provisioned instance and queries Postgres `pg_available_extensions` for the three extensions the case-store compilers depend on. All three are on Cloud SQL's documented allowlist as of the current PG 18 default; the gate is a structural check that the provisioned instance hasn't been configured to disable any of them. If any is missing, the corresponding search modes / operators are unauthorable until the instance is re-provisioned with the extension enabled.
- **CommCare wire-level resolution of `auto_launch=true`.** Owned by Plan 4 Task 6 (`compileForPlatform`'s decision tree picks the `autoLaunch` value) and Task 8 (`<remote-request>` orchestrator emits the corresponding wire shape — recall `auto_launch` lives on the `<action>` element inside `m{N}_case_short`, NOT on `<query>`, per `commcare-hq/.../tests/data/suite/search_command_detail.xml::detail/action[@auto_launch]`). Before locking emission code, the implementer reads `commcare-hq/corehq/apps/app_manager/suite_xml/post_process/remote_requests.py` and confirms semantics for both case-search and callout contexts.
- **`inline_search` real wire behavior.** Owned by Plan 4 Task 6 (decision tree) + Task 8 (`<remote-request>` emission). Reads `commcare-hq` source for the `inline_search` flag's effect on `instance('results')` vs `instance('results:inline')` before emitting the `<datum nodeset>` reference. Cite by stable name (no line numbers).
- **`case_indices` materialization policy.** Owned by Plan 2 Task 4 (`PostgresCaseStore`'s `caseIndices.ts`). Start with Option B (direct edges only); profile after V1 ships using `EXPLAIN ANALYZE` against representative datasets; switch to Option A if the per-hop chain-of-joins cost dominates. Both options are within the same architectural commitment; the task ships with Option B. (Plan 1 Task C5 emits a chain-of-joins from the relation-path AST against whatever Plan 2 materializes — `depth = 1` on every hop keeps the SQL materialization-agnostic; the compiler does not own the materialization policy itself.)
- **Existing apps that have columns referencing non-existent case properties.** Owned by Plan 3 Task 15. The migration script's dry-run mode reports references that don't resolve; review before running live.

## Testing strategy

- AST type-checker unit tests against the case-type schema.
- AST → SQL compiler tests with property-based generation against expected SQL output.
- AST → wire emitter tests with golden files comparing emission against CCHQ-accepted XPath, per dialect (one golden-file suite per wire target).
- Round-trip tests: AST → Kysely → SQL execution against a Postgres test instance via testcontainers (no mocks at the DB boundary). One implementation, one test path.
- Migration script: dry-run mode plus assertion tests against fixture docs.

## Risks and mitigations

- **Tenant-isolation leak via missing owner-id filter** — the isolation model is `(app_id, owner_id)` columns + application-layer filtering. A single missed `.where("owner_id", "=", session.user.id)` filter at any read site leaks one tenant's case data to another. Mitigation: tenant scoping is **structural, not by discipline** — the `CaseStore` interface is the only path to case data, and every `CaseStore` method accepts an `appId` and resolves the caller's `owner_id` through a `withOwnerContext(userId)` factory at the request boundary. There is no way to construct a `CaseStore` instance that bypasses the owner-id filter; the factory pattern enforces tenant scoping by construction. RLS policies on the `cases` table land as defense-in-depth in Plan 2 once the application-layer pattern is exercised. For HIPAA / SOC 2 clients requiring stricter isolation (schema-per-tenant or database-per-tenant), the migration path is changing the connection routing in `withOwnerContext` to map `(appId, ownerId) → schema` — bounded by the tooling, no application-code rewrite — at the cost of dump-and-reload per tenant during the cutover.
- **JSONB write bloat** from frequent updates — full-row replacement on case writes (not partial `jsonb_set`). Monitor `pg_stat_user_tables.n_dead_tup`.
- **JSONB cast safety after schema migration** — addressed via the migrate-or-quarantine policy; reads are typed-safe because writes are validated against the current schema; quarantined rows are surfaced rather than silently lost.
- **`case_indices` row-count growth** — start with Option B (direct edges only + chain-of-joins on read) for write predictability; switch to Option A if the per-hop chain cost dominates. Both within the same architectural commitment.
- **Cross-platform divergence confusion** — Nova emits the maximum CCHQ feature subset for web apps; runtime player capabilities are Dimagi's structural concern, not Nova's authoring layer. Authors write the AST; emitters translate faithfully.
- **Existing app migration** — one-shot script, dry-run first, no permanent migration code in runtime; broken references after migration become validator warnings.
- **Spec drift from implementation** — the spec lives at `docs/superpowers/specs/2026-04-30-case-list-search-design.md` and must move with the code. Any PR touching `lib/domain/predicate` (Predicate + ValueExpression families), `lib/commcare/predicate`, `lib/commcare/expression`, `lib/case-store`, or the case-list/search authoring UI must include a one-line "Spec touchpoints" note in the PR description naming the affected spec sections (or "no spec impact"). The CLAUDE.md files in each package list the spec as the source of design truth; the per-PR check ties refresh discipline to the existing review flow rather than to a calendar.

## Scope shape (not effort)

This is foundational work that ships across five separately-reviewable, separately-testable plans. None of it is "inventing a database, query language, or storage engine" — all of it is writing focused domain-specific compilers, type checkers, and a typed UI surface fitted to the domain. Each plan ships independently; subsequent plans depend on prior plans but produce reviewable software on their own.

- **Plan 1 (Foundation):** Predicate AST + Expression AST + type checker + JSON Schema generator + three wire emitters + Postgres compiler + testcontainers infra.
- **Plan 2 (Case data layer):** Cloud SQL provisioning + `PostgresCaseStore` (the only implementation) + `HeuristicCaseGenerator` + per-user `(app_id, owner_id)` isolation + extension allowlist gate. No in-memory variant; testcontainers covers test isolation.
- **Plan 3 (Case list authoring):** Module schema + migration script + case-list config UI + SA tools + validator + wire emission for short/long detail.
- **Plan 4 (Search authoring):** Module schema for `caseSearchConfig` (claim + display only — filter and sort reuse `caseListConfig`) + case-search-config workspace UI + 2 wholesale SA tools + platform-aware compilation + wire emission for `<remote-request>` + claim + dual-detail block emission (`m{N}_search_short` / `m{N}_search_long` carrying identical content to the case-list detail blocks).
- **Plan 5 (Running-app search execution):** Running-app surface (the flipbook's "using" view) + split-screen search + inline filter + form write-through. There is no separate preview lifecycle; the running-app view operates on the same `cases` rows the editor inspects.

The v1 of this spec made an effort estimate that was off by ~5x for Plan 1 alone. The v2 estimates were no more reliable — agentic execution velocity and the iteration tightness of typed-AST work both make conventional day-counts misleading. Effort estimates are removed from this spec and from all five plans.
