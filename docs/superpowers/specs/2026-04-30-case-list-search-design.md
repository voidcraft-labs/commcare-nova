# Case List & Search — Design

**Status:** Draft
**Date:** 2026-04-30
**Authors:** Braxton Perry, Claude

## Overview

CommCare app builders today have to learn CommCare's wire dialect (XPath 1.0 with accreted CSQL extensions), edit predicates as raw strings in tiny textareas, and compose multi-line metaprograms by hand. The pain compounds: untyped properties leak into search; filter and default-filter footguns produce silent UX failures; the same expression behaves differently on mobile and web because two backends with different semantics share one dialect; renaming a property is a grep-and-pray operation.

Nova replaces that authoring model with a typed expression language, a structured authoring surface that never asks the user to write a string, a runtime layer that executes against typed case data, and a compiler that emits CommCare-compatible suite XML at upload.

The work splits into three coordinated layers that ship together:

1. **Foundation** — typed case data model, predicate AST as the source of truth, compilation pipeline.
2. **Case list config** — columns, filters, sorts, calculated columns. Full builder UI.
3. **Search config** — search inputs, default filters, claim flow, platform-aware compilation.

The three layers ship together because the foundation gates both. Shipping case list filters and search filters with different expression dialects would re-create the cross-surface footguns CommCare has lived with for a decade.

## Goals

- Author writes one expression language (the typed predicate AST) for every filter, sort, calculated column, search input default, and default search filter.
- Author never writes a predicate as a string. Every predicate is composed in the UI as typed cards or via the SA's typed tool surface.
- Type errors are caught at the editor — comparing an `int` property to a string literal fails at construction, not at runtime.
- Case data is typed end-to-end. Property types declared in the blueprint flow into the database write boundary, the predicate type checker, and the UI surface for editing.
- The CommCare wire format is an emission target, not the authoring surface. Authors and the SA never see XPath/CSQL strings.
- Preview executes searches against real, typed case data so authors validate behavior before upload.
- The architecture works at preview scale day-1 (in-memory) and promotes cleanly to Cloud SQL Postgres at deploy time without a code rewrite.

## Design properties — the quality bar

This spec ships an expression layer that Nova authors and the SA agent compose against. The risk is that a custom expression layer turns into the same kind of accreted, untyped, string-based mess that CommCare's XPath dialect became over 25 years. The four design properties below define what prevents that failure mode. Any implementation in the plan that fails these properties is wrong regardless of how cleanly it ships otherwise.

1. **Typed at construction.** Invalid predicates cannot be represented in the AST type. Comparing an `int` property to a string literal fails at the discriminated-union level, not at runtime. The AST is a Zod-validated tagged union; constructing one is the only way to author a predicate, and the constructor refuses anything ill-typed against the case-type schema in scope.
2. **Schema-driven, single source.** The blueprint's `CaseType.properties[].data_type` is the one source of truth for property types. From it, three derived artifacts follow: the JSON Schema enforced at the database write boundary, the type context used by the AST type checker, and the typed extraction emitted by the SQL compiler. No surface duplicates type information; mismatch is impossible by construction.
3. **One source, multiple targets.** A predicate is authored once as an AST. It compiles to Postgres SQL (preview/runtime), CommCare XPath/CSQL (HQ wire), and UI cards (authoring surface). The AST is the source; everything else is emission. There is no string→re-parse→AST round-tripping anywhere in the pipeline.
4. **Semantics-aware UI.** Each operator gets a card fitted to its meaning. A `within-distance` predicate renders as a geo card with property + center + distance + unit fields. A `fuzzy-match` predicate renders as a property + value field. Comparisons render with type-appropriate value inputs (date pickers for `date` properties, multi-select for enum properties). The UI is *not* a generic field/op/value row table that pretends every operator is the same shape.

Together these are the structural defenses against CommCare's accretion pattern. The implementation plan must demonstrate all four.

## Architecture

### Two stores, separated by concern

- **Firestore** continues to own the blueprint document, event log, chat threads, run summaries, and the Better Auth user collection. Access patterns map cleanly to Firestore's strengths: single-doc reads by ID, owner-filtered listings, append-only event subcollections.
- **Cloud SQL for PostgreSQL** owns case data. Case data is typed structured records with parent/child/extension relationships, indexed search across properties, fuzzy matching, and geo predicates — patterns that don't fit Firestore.

The two stores share no record identity. Blueprint mutations don't reference case rows; case rows don't reference blueprint docs. The decoupling avoids the cross-store sync coupling that produced two decades of pain in CommCare HQ's CouchDB+Elasticsearch architecture. Retiring Firestore entirely is a separate decision deferred to its own spec.

### Typed predicate AST as source of truth

CommCare's surface for filters and search is an XPath text editor. Authors compose predicates by hand, including manual string-template construction with `concat()` and ad-hoc escape sequences. The pattern accretes — every new capability becomes another function added to the same untyped expression language.

Nova replaces the text editor with a typed AST. Every filter, sort key, calculated column, search input default, and default search filter is stored as a structured object. A representative shape (concrete schema lives in code):

```ts
type Predicate =
  | { kind: 'and'; clauses: Predicate[] }
  | { kind: 'or'; clauses: Predicate[] }
  | { kind: 'not'; clause: Predicate }
  | { kind: 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte'; left: Term; right: Term }
  | { kind: 'in'; left: Term; values: Literal[] }
  | { kind: 'within-distance'; property: PropertyRef; center: Term; distance: number; unit: 'miles' | 'kilometers' }
  | { kind: 'fuzzy'; property: PropertyRef; value: string }
  | { kind: 'when-input-present'; input: SearchInputRef; then: Predicate }

type Term = PropertyRef | SearchInputRef | UserContextRef | Literal | Computed
```

Property references resolve against the case-type schema declared in the blueprint. Search input references resolve against the form's declared inputs. The type system catches `compare(int, string)` at construction time. The UI never permits constructing a predicate that wouldn't type-check.

CommCare's form-time XPath dialect stays unchanged. Form `calculate`, `relevant`, `validate`, `constraint`, and similar form-time expressions continue to use the existing typed XPath surface. The AST language is for *case data* surfaces only — filters, sorts, calculated columns, search predicates, default filters. Two different surfaces, two different jobs. We do not extend CommCare XPath with CSQL functions; we do not merge dialects.

### Prior-art alignment

We don't invent shape from first principles. Where convergent prior art exists, we adopt the shape:

- **Zod-discriminated-union of `kind` tags** for the AST, matching Nova's existing pattern (`fieldSchema`, `fieldRegistry`, `Mutation` types). New operators are explicit additions to the union, never accretion of behaviors onto a shared `string` field. The same patterns engineers already work with in this codebase.
- **Predicate-builder API surface modeled on Kysely's typed query builder.** Engineers familiar with Kysely (Nova's typed SQL layer) find the AST construction shape familiar. Composition reads similarly to typed SQL.
- **Operator names aligned with JsonLogic where overlap exists** (`eq`, `gt`, `in`, `and`, `or`, `not`). Recognizable to anyone who's seen JSON-shaped DSLs. CommCare-specific operators (`within-distance`, `fuzzy-match`, `when-input-present`) take their names from CommCare's own dialect for cross-referencing clarity.
- **Type-checker patterns drawn from TypeScript's narrowing/inference rules.** Hint UX in the editor surfaces type errors the way TS surfaces them — at the construction site, with the expected vs. actual type called out, and with a suggested fix when one is unambiguous.

This is "stand on prior art for shape" — not "use a library for implementation." The implementation is ours; the shape draws from the canonical patterns that exist for each piece.

### Compilation pipeline

The AST compiles to three targets, all from the same source:

1. **Postgres SQL** for preview and (eventually) production runtime. Compiled via Kysely's typed query builder — a translator walks the AST and constructs Kysely calls. Kysely owns SQL generation; we own only the AST → builder mapping.
2. **CommCare XPath / CSQL** for HQ wire upload. Compiled at suite-XML emission time. The output may be ugly. No human reads it; no human edits it. It is object code.
3. **UI cards** for the authoring surface. The case-list-config and search-config builder UIs render the AST as composable cards. Editing the cards mutates the AST. No textarea editing of predicate text anywhere — for either humans or the SA.

The author and the SA write the same shape: typed AST objects via SA tool calls or UI interactions. There is no string-as-source-of-truth in the codebase.

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
  parent_case_id UUID,
  properties     JSONB NOT NULL
);

CREATE TABLE case_type_schemas (
  app_id    TEXT NOT NULL,
  case_type TEXT NOT NULL,
  schema    JSONB NOT NULL,  -- JSON Schema describing typed properties
  PRIMARY KEY (app_id, case_type)
);

CREATE TABLE case_indices (
  case_id     UUID NOT NULL,
  ancestor_id UUID NOT NULL,
  identifier  TEXT NOT NULL,           -- e.g. 'parent', 'host'
  relationship TEXT NOT NULL,          -- 'child' | 'extension'
  depth       INT NOT NULL,            -- 0 = direct, 1 = grandparent, etc.
  PRIMARY KEY (case_id, ancestor_id, identifier)
);
```

System columns get real types so the planner sees them. JSONB holds only user-defined per-case-type properties. `case_indices` is a denormalized side table that materializes every (case → ancestor) edge transitively — populated by trigger on insert/update. Its existence is the architectural answer to CommCare HQ's `TooManyRelatedCasesError`: ancestor and subcase predicates compile to one indexed query against this table, not N sequential queries against an inverted index. Recursive CTEs against `case_indices` traverse arbitrary relationship chains in a single query.

We pick the side-table approach over the `ltree` extension because CommCare cases support multiple typed relationships per case (parent + host + custom extensions). `ltree` assumes a single tree path; the side table generalizes.

#### Write-time validation

A BEFORE INSERT/UPDATE trigger on `cases` validates `properties` against the schema row in `case_type_schemas` for the row's `(app_id, case_type)`. Mismatch raises EXCEPTION; bad writes never land. Validation uses the `pg_jsonschema` extension when Cloud SQL's allowlist permits, or a PL/pgSQL implementation as fallback. The architecture is identical either way; the implementation plan checks the allowlist and wires the appropriate validator.

The blueprint's `CaseType.properties[].data_type` is canonical. Whenever the blueprint changes, the corresponding `case_type_schemas` row is regenerated and synced. Schema changes never trigger DDL on `cases`.

#### Bidirectional typing

The blueprint's `CaseType.properties[].data_type` is the source of truth. From it, three downstream artifacts derive:

- **JSON Schema** in `case_type_schemas` — write-side enforcement
- **Type context** for the predicate type checker — author-time validation
- **Postgres extraction** in the SQL compiler — `(properties->'age')::numeric` for an `int` property; the cast is guaranteed to succeed because writes are validated

A field on a form with `case_property_on: <case_type>` and `id: <property>` is a *writer* to that property. A new validator rule enforces: the field's `kind` must match the declared `data_type`. `kind: text` writes to `data_type: text` only. No coercion. Multiple writers to the same property must agree on type. Mismatch is a build-time error, not a runtime surprise.

### In-memory CaseStore for day-1

The Cloud SQL deployment is Phase-2 work. Day-1 ships an in-memory implementation behind the same query interface:

```ts
interface CaseStore {
  query(args: {
    appId: string
    caseType: string
    predicate?: Predicate
    sort?: SortKey[]
    limit?: number
    offset?: number
  }): Promise<CaseRow[]>

  insert(args: { appId: string; row: CaseRow }): Promise<void>
  update(args: { appId: string; caseId: string; patch: Partial<CaseRow> }): Promise<void>
  close(args: { appId: string; caseId: string }): Promise<void>
  // relationship-traversal helpers
}
```

V1: `InMemoryCaseStore` — implements the interface against an in-memory map keyed by app. Predicate evaluation walks the AST. Relationships traverse `parent_case_id` chains. Replaces today's `lib/preview/engine/dummyData.ts`.

Phase-2: `PostgresCaseStore` — same interface, AST → Kysely → SQL via the query compiler we write in this spec. Promotion is an implementation swap behind the interface. No rework of authoring surface, predicate AST, validator, sample data generation, preview UI, or wire emission.

### Sample data

Schema-driven, deterministic, swappable.

```ts
interface SampleCaseGenerator {
  generate(args: { caseType: CaseType; count: number; seed: string }): CaseRow[]
}
```

V1: `HeuristicCaseGenerator` — typed pools per `data_type` (names, addresses, dates in plausible ranges, valid enum values from `single_select` and `multi_select` options). Default count 30 per case type. Deterministic per `(app, case-type, seed)` so debugging is reproducible. Generates parent linkages for child case types declared in the blueprint.

Phase-2 swap: `LlmCaseGenerator` (Haiku) — calls Haiku with the typed schema and an optional project description. Returns realistic cross-field-consistent rows that heuristics can't produce: DOB matches age, addresses match village context, drug names exist in the real world. Same interface; backlog item.

CSV upload, HQ-import, and hand-typed sample cases are deferred.

### Preview lifecycle

Forms in preview write through the `CaseStore` interface as auto-generated data. A registration form persists a new row; a followup updates an existing row; a close marks closed. Same interface for generated data and form-driven data.

The store is per-session — when the user closes the preview tab or refreshes the builder, the store resets and re-seeds from the schema. A "Reset preview data" button regenerates on demand without a page refresh.

Cross-session persistence requires real Postgres + per-user storage and ships in the Phase-2 deployment spec.

## Authoring surfaces

### One surface, no mode picker

CommCare exposes four workflow modes (Normal / Search First / See More / Skip to Default Results) controlled by two orthogonal booleans on the wire (`auto_launch`, `default_search`). The booleans only meaningfully affect Web Apps; Android always shows the case list first regardless. "Search First" is a screen-real-estate compromise from the mobile-shaped era of the web client.

Nova does not expose workflow modes to the author. The author configures one coherent surface — case list with optional filters, sorts, columns, search inputs, and default filters — and we compile per-platform:

- **Mobile** — emits as a normal case-list module with inline list filtering. Whatever filter inputs the author configured become the inline-search behavior on the case list. Default filters bake into the list nodeset. Mobile always shows the case list first regardless of any wire flag, so the workflow choice is uniform.
- **Web** — emission depends on the deploy's feature flags AND the content the author configured:
  - On deploys with `SPLIT_SCREEN_CASE_SEARCH` enabled, emits the modern split-screen UX (filters in sidebar, results in main panel). This is the preferred target.
  - On deploys without split-screen, emission falls back based on content: `auto_launch=true, default_search=true` (skip to default results) when the author configured only default filters and no user-driven search inputs; `auto_launch=true, default_search=false` (search first) when the author configured search inputs the user needs to fill. Search-first is emitted only as a fallback on non-split-screen deploys with search inputs; it is never the primary target because split-screen is the modern UX. The fallback algorithm is part of the implementation plan.

The author never makes a per-platform or per-deploy decision. The compiler picks the closest CCHQ-supported emission from the content the author configured.

No escape hatch in V1 for forcing a specific CCHQ workflow mode at the authoring layer. If a real customer constraint emerges later, we add it then with evidence.

### Case list config UI — three sections, all AST-backed

1. **Display** — columns and sort.
   - Columns have a `kind` discriminator (Plain, Date, Time Since/Until, Phone Number, ID Mapping, Late Flag, Search Only) and per-kind config.
   - Calculated columns carry a Predicate AST node.
   - Sort keys reference properties or calculations with type discrimination (Plain / Date / Integer / Decimal).
2. **Filters** — always-on filter, expressed as a single `Predicate` AST.
   - Authored via composable cards: AND/OR groups, comparison cards, set-membership cards, distance cards.
   - Cards type-check against the case-type schema at construction.
   - The same Predicate compiles to both the case-list filter and the search default filter at wire emission time. The author writes it once; the two surfaces cannot diverge by construction. CommCare's "filter must mirror default filter" footgun (where users get stuck in a select-and-reject loop because the case-list filter rejects cases the search returned) is structurally prevented because there is one source.
3. **Search inputs** — list of search input definitions.
   - Type (text / select / date / date-range / barcode), label, optional default value (a `Predicate` or `Term`), optional XPath the input compiles to (a `Predicate` for advanced cases).

No textarea anywhere. No string editing. No `_xpath_query` magic-string surfaces — that concept is replaced by AST nodes.

### SA tool surface

The SA writes the same AST. Tool calls accept Predicate objects, Column arrays, SortKey arrays. Never strings. The SA gets a typed interface; humans get a typed interface; they're the same interface.

Contract: the SA cannot author a predicate that humans couldn't construct in the UI, and humans cannot author a predicate the SA can't reason about.

## Wire emission

### V1 scope — IN

- Case list short-detail columns with format kinds: Plain, Date, Time Since/Until, Phone Number, ID Mapping, Late Flag, Search Only
- Calculated columns
- Case list filter (always-on)
- Case list sort (multi-key; types Plain / Date / Integer / Decimal)
- Case detail long-detail columns (same kinds)
- Static detail tabs
- Search input properties (text, select, date, date-range, barcode)
- Default search filters (compiled to `_xpath_query` emission)
- Custom sort properties (incl. `commcare_search_score` for relevance sort)
- Search screen title, subtitle, empty-list text
- Claim condition + `dont_claim_already_owned` toggle
- Workflow handling (no author-facing mode picker; platform-aware compilation per the section above)

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
- Sort calculation (FF-gated)
- Cache and Index pathway (deprecated by CCHQ)
- "Don't search cases owned by following IDs"
- Real Cloud SQL Postgres deployment
- CSV upload, HQ-import, hand-typed sample cases
- LLM-powered sample data generator (Haiku)
- Firestore retirement
- Authoring surface for form-time XPath beyond the existing typed XPath dialect

### Geo — searchable but not visualized in V1

`within-distance` predicates ship in V1 because case search by radius is foundational. Geo *display formats* (map columns, popup columns, distance columns) are deferred to the visual/geo formats spec. The author can search by location in V1; the case list shows the geopoint as text.

### Validator coverage

- Column `field` references must resolve to known case properties.
- Filter / sort / calculated-column ASTs type-check against the case-type schema.
- Search input case-property references must resolve.
- Cross-platform divergence warnings — when an AST predicate uses a function that's web-only or mobile-only, surface which platforms will not honor it.
- Field-kind-vs-property-type mismatch — writers to a typed property must match the declared `data_type`. Multiple writers to the same property must agree on type.

## Migration

We have approximately 100 apps in the system. Operator-scale migration, not codebase-scale.

- `scripts/migrate-case-list-columns.ts` reads all app docs in Firestore.
- For each module's `caseListColumns` / `caseDetailColumns` in the old `{ field, header }` shape, writes the new shape `{ kind: 'plain', field, header }`.
- Idempotent — skips docs already in the new shape.
- Run once, against prod Firestore, before shipping. Dry-run first to confirm the transform.
- Archive or delete the script after run.

The Zod schema in code only has the new shape from day one of the spec landing. No coexistence, no fallback, no doc-loader migration. If an old-shape doc reaches a runtime parser after migration, parsing fails loudly — exactly what we want, because that means the migration script missed something and we need to know.

## Phase-2 follow-up specs

Each deferred item lands cleanly on V1 architecture without rework:

- **Case data persistent backend spec** — `PostgresCaseStore` swap, Cloud SQL deploy, per-user storage, RLS, connection pooling.
- **Visual/geo formats spec** — visual format kinds, case tiles, persistent tiles, map / popup / distance columns. Builds on the format-kind union and the predicate AST.
- **Advanced search spec** — related-case linking, data registries, lookup tables, geocoder receivers, custom related-case property.
- **Multi-select spec** — distinct data + UX surface; builds on the `CaseStore` interface.
- **Sample-data sources spec** — CSV upload, HQ-import, LLM-powered generator. Swap in behind the existing `SampleCaseGenerator`.

## Open verification gates

Items the implementation plan must verify before locking:

- **Cloud SQL extension allowlist** for `pg_jsonschema`. If unavailable, fall back to PL/pgSQL validator. Architecture is identical; choice is a step in the implementation plan, not an architectural branch here.
- **CommCare wire-level resolution of `auto_launch=true`**. Earlier explore agent reports have gaps on the exact suite-XML structural change CCHQ generates. Implementation reads the HQ-side suite emitter directly before locking emission code.
- **`inline_search` real wire behavior**. Cache file lists it; runtime parser appears not to. Verify against `commcare-hq` source before assuming any specific compilation.
- **Existing apps that have columns referencing non-existent case properties** — the migration writes them as-is (preserving data) and the validator surfaces the broken references as warnings on next load, where the user (or SA) repairs. Confirm during dry-run that no live apps have catastrophic mismatches that would require pre-cleanup.

## Testing strategy

- AST type-checker unit tests against the case-type schema.
- AST → SQL compiler tests with property-based generation against expected SQL output.
- AST → CSQL compiler tests with golden files comparing emission against CCHQ-accepted XPath.
- Round-trip tests: AST → SQL execution against the in-memory store; AST → SQL execution against a Postgres test instance via testcontainers (no mocks at the DB boundary).
- Migration script: dry-run mode plus assertion tests against fixture docs.

## Risks and mitigations

- **Cloud SQL extension unavailability for `pg_jsonschema`** — fall back to PL/pgSQL validator function; behavior identical from the application's perspective. Verified during implementation.
- **JSONB write bloat** from frequent updates — full-row replacement on case writes (not partial `jsonb_set`). Monitor `pg_stat_user_tables.n_dead_tup`.
- **Cross-platform divergence confusion** — validator surfaces warnings when AST functions are platform-specific; UI shows per-platform consequence preview in the search-config surface.
- **Existing app migration** — one-shot script, dry-run first, no permanent migration code in runtime; broken references after migration become validator warnings, not silent corruption.

## Effort honesty

This is foundational work — weeks-not-days. Honest scope across all components: roughly 4000–7500 lines of focused code (AST definitions, type checker, two compilers, UI cards in Nova's design system, JSON Schema generator) plus 1000–2000 lines of tests (golden-file XPath emission, property-based SQL generation, round-trip integration via testcontainers). Each piece is well-bounded and replaceable; none of it is "inventing a database, query language, or storage engine" — it's writing focused domain-specific compilers and a typed UI surface fitted to our domain.

The implementation plan breaks this into ordered, separately-shippable slices and provides realistic time estimates per slice.
