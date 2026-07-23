# lib/domain/predicate — Predicate + ValueExpression AST

The single package owning Nova's two structurally-related AST families: `Predicate` (boolean) and `ValueExpression` (typed values). The Zod schemas in `types.ts` are the shape reference; this file holds only what the schemas can't say.

## Why two families share one package

Predicate operators carry `ValueExpression` operands, and `ValueExpression`'s `if` / `switch` / `count` carry `Predicate` clauses. That cross-cycle recursion needs intra-file `z.lazy`; splitting into sibling packages would force cross-package `z.lazy`, which Zod doesn't support ergonomically. One package lets both unions reach each other.

## Non-obvious arm facts

- `in.values` and `multi-select-contains` are literal-only because the wire targets expect static lists.
- `switch` is the simple-CASE form so the discriminator evaluates ONCE per row at the Postgres target.
- `unwrap-list` resolves to the `SEQUENCE_TYPE` sentinel; no Predicate/Expression operator consumes a sequence — the CSQL wire emitter's `selected-any(prop, unwrap-list(...))` is the only consumer, and the Postgres compiler defensive-throws on the arm.
- `Term` has NO value-expression arm — cross-family composition lives one level up (`ValueExpression.term` lifts any Term; Predicate operators take `ValueExpression` directly).
- A `via` of kind `self` collapses to the inner where (no identity join).
- `any-relation` is direction-agnostic: for the canonical `parent` index its possible destination types are the origin's parent UNION its direct children (deduplicated for recursive case types), and an omitted `ofCaseType` is valid only when that union has one member. When the selected destination is exclusively the parent or exclusively a child, shared normalization materializes that proven direction; this avoids emitting an impossible CSQL arm that can make an otherwise valid nested filter unrepresentable. Recursive, custom-index, and otherwise ambiguous paths stay direction-agnostic. CCHQ's grammars are direction-specific, so those remaining paths expand to `(<ancestor-form> or <subcase-form>)`; Postgres compiles their two single-hop variants as a `unionAll`.
- `parent` is the only relation identifier the `CaseType.parent_type` graph can infer. Every custom saved index name needs an explicit `throughCaseType` / `ofCaseType`; that destination may be any declared case type because Nova has no metadata proving the custom index's direction. Never pretend a custom index follows the `parent_type` graph.
- `count(self)` is the cardinality of the current row: `1` without a filter, or `1`/`0` according to its `where` predicate. It is a useful compositional reduction, not an invalid relation walk.

## Null vs blank semantics — locked invariant

Three data-model states: key absent, key present with JSON null, key present with empty string. `is-null` matches strict-absent only; `is-blank` widens to absent-or-empty. CCHQ's wire layer collapses all three into one match set (`prop = ''` — broader than `is-null` says, exact for `is-blank`); Nova's Postgres runtime distinguishes them natively and emits the strict SQL. Removing `is-null` would be a one-way door (it changes the closed kind set and breaks every persisted predicate). Authoring surfaces default to `is-blank` for "field is empty"; `is-null` exists for callers that need strict-absent (audit views, `coalesce`-adjacent logic).

## Type checker contract

`checkPredicate` / `checkExpression` validate a constructed AST against the case-type schema + search-input declarations, with per-node error paths. Rules worth knowing beyond the code:

- Strings are deliberately excluded from `ORDERED_TYPES` — locale-dependent string ordering is rarely meaningful for case-list filtering, so `gt`/`lt` reject text.
- Property references inside relational `where` clauses must resolve against the surrounding `via`'s DESTINATION scope, not the originating one.
- **The checker is the gate every emitter trusts.** Compiler/emitter code that hits a state the checker should have rejected throws a "the type checker should have caught this" error — never falls back to a default. Checker coverage is the structural contract, not a hint.

## Exact calendar-day search

A simple `date` search input in exact mode means the whole selected calendar day, never string equality and never "the datetime happened exactly at midnight." Both CommCare CSQL and Preview/Postgres derive the same half-open predicate through `dateSearch.ts::exactDateSearchPredicate`: a date property uses `[date(day), date-add(date(day), 1 day))`; a datetime property uses `[datetime(day), datetime-add(datetime(day), 1 day))`. Nova does not yet author an app timezone, so the datetime interval is deliberately a UTC day. This also applies to indexed metadata such as `date_opened` and `last_modified`; explicit datetime bounds bypass CCHQ's hidden project-timezone special case so standard and custom datetime properties behave identically in Nova. If Nova adds an authored app timezone, this one helper is where the contract changes.

For a related property, both bounds live inside ONE `exists(via, where: lower AND upper)`. Two independently lifted `prop(via)` comparisons are not equivalent: different related rows could satisfy each bound. The exact-date helper resolves the destination case type first and constructs one quantifier, preserving one-row semantics on every target.

## Relation-read target contracts

`normalizeRelationEvaluationScopes` is the shared semantic boundary before every predicate target. A scalar predicate leaf whose non-self properties all share relation `R` becomes `exists(R, where: <the leaf rebased to self>)`. Multiple property reads in that leaf therefore refer to the same related row. Separate boolean leaves quantify independently. Generic `between(prop(via), lower, upper)` intentionally becomes two independent bound comparisons, so different related rows may satisfy them; callers that require one row to satisfy both bounds author `exists(via, where: between(prop(self), ...))`. The exact-day and date-range helpers above intentionally build that explicit shape.

The normalizer also descends into scalar-expression slots and normalizes independent boolean boundaries (`if.cond`, explicit `exists`/`missing`, and `count.where`) in place. It fails closed when one scalar leaf mixes self and related properties, combines two different relation scopes, or combines an outer related read with an anchor-sensitive nested quantifier. Those shapes have no faithful implicit row scope; the module validator must surface the authoring repair before an emitter reaches the defensive exception. Relation paths are canonicalized with case-type context so an inferred child hop and its equivalent explicit hop coalesce rather than looking like different scopes.

On-device `exists`/`missing` never compares two XPath node-sets: CommCare Core does not implement XPath general node-set equality, and nested `current()` still points at the original listed case. The emitter uses guarded immediate-scope membership (`count(index/<relationship>) > 0 and selected(join(' ', <candidate ids>), index/<relationship>)`) at every level. The non-empty guard is required because Core treats `selected('', '')` as true. This supports nested ancestor, subcase, and any-relation presence checks without cross-row correlation. Nested subcase/any-relation counts are rejected whenever the current related scope cannot be named as a provable singleton anchor.

CSQL next runs `normalizeRelationReads.ts::normalizeRelationPropertyReads` only as a grammar adapter: supported native operand shapes become query-function envelopes after the shared semantic pass. Its representability validator rejects property/value-expression shapes the server grammar cannot encode faithfully. Postgres consumes the shared normalized AST and defensively rejects any non-self `PropertyRef` that survives predicate normalization; it never invents `LIMIT 1`, pairwise node-set, or cross-product semantics for predicate leaves.

Both passes deliberately leave non-subject properties below scalar expression/value slots (`arith`, `concat`, `coalesce`, `if`, `switch`, `count`, `format-date`, `match.value`, `within-distance.center`) on the scalar contract. The CSQL representability validator separately rejects property-bearing runtime expressions the remote-query wire cannot evaluate.

A `date-range` prompt is also target-type aware in Preview. CommCare represents it as one indivisible `__range__<start>__<end>` value, so Nova preserves partial picker state only as a draft and blocks execution until both valid, ordered bounds exist. A date property keeps inclusive `[start, end]` comparisons. A datetime property uses the UTC half-open interval `[datetime(start), datetime-add(datetime(end), 1 day))`, so an event later on the selected final day is included instead of being cut off at midnight. `dateSearch.ts::dateRangeSearchPredicate` owns that lowering alongside exact-day search.

## JSON Schema generator

`caseTypeToJsonSchema` feeds the case-store's write-time AJV validator (rationale for TS-side validation lives in `lib/case-store/CLAUDE.md`). Properties without a declared `data_type` default to `{ type: "string" }` — deliberately matching the term compiler's `text` default at the same site. `int` emits a bounded `{ type: "integer", minimum, maximum }` at int4's signed-32-bit range so AJV's acceptance set matches the Postgres `::integer` cast — an out-of-range value fails as a typed validation error, never a raw Postgres error at INSERT. The emitted constraints are exactly the cast-protecting ones (int bounds, date/time formats, the geopoint pattern); **select values validate as plain strings, never an option enum** — no cast reads them typed, options are form UI rather than a data constraint (CommCare never re-validates stored case data against current choices), and because the write path validates the MERGED row document, an option enum would turn every option edit or text→select kind conversion into a row poisoner (yesterday's legal value fails the next write of ANY property on the row).

## Named tool-schema definitions

The AST family schemas carry registered ids (`z.globalRegistry.add`, end of `types.ts`), so every `z.toJSONSchema` emission — the SA tool wire, the MCP listing — extracts each one ONCE into `definitions` under a stable human name (`#/definitions/Predicate`, `Term`, `ValueExpression`, …) and `$ref`s it at every use site. Without the ids, each predicate-carrying tool re-inlines the term structure per operator arm (~28k tokens of duplication across the SA tool set) and the recursion-forced extractions get per-tool `__schemaN` names. Register via `globalRegistry.add` (attaches in place), never `.meta()` (clones, and double-serializes shared child nodes into stray micro-definitions). A new reused-or-recursive family member should get an id here too.

## Two simplification layers — opposite contracts

**Construction-time reduction** (`reduction.ts`: `reduceAnd` / `reduceOr` / `reduceNot`) is scoped DELIBERATELY to empty / single-clause / double-negation: `and([])` → match-all, `or([])` → match-none, `[single]` → single, `not(not(x))` → x. Multi-clause lists are preserved verbatim — embedded sentinels are NOT dropped, same-kind nesting is NOT flattened — because a multi-clause `and` whose middle element is `match-all` is a meaningful intermediate editing state. Builders apply these on every call; hand-built object literals bypass them.

**Emission-time simplification** (`simplify.ts`: `simplifyForEmission`) is the DEEP normalizer applied right before a filter is serialized to the wire. It drops every boolean identity at every depth (`and` drops match-all / absorbs match-none; `or` is the dual; same-kind nesting flattens; `not` folds), recursing through nested predicate slots including those under a ValueExpression operand (`count.where`, `if.cond`). Emission's contract is wire accuracy, so the identity reduction deliberately keeps is stripped HERE — left in place it emits a `match-all() and X` conjunct (inaccurate config). NEVER call it from the construction / doc layer; it destroys editing state.

**`effectiveFilterForEmission`** (`simplify.ts`) wraps it for the common case: simplify a `caseListConfig.filter`, then fold an all-true result to `undefined` ("narrows nothing"). It is the SINGLE home of the "match-all ≡ no filter" decision — every consumer of the filter goes through it (the search `_xpath_query` composer, the case-list nodeset filter on suite XML + HQ JSON, the preview query, `compileForPlatform`'s skip-to-results decision, and the searchable-surface validator) — so "does this filter narrow anything?" (`=== undefined`) and "what do we emit?" can never disagree. A shallow `isMatchAll` at a decision site while emission simplifies deeply would let `and(match-all, match-all)` read as effective on one side and vanish on the other. (`match-none` is NOT folded — it narrows to the empty set, a real query.) Use the shallow `isMatchAll` / `isMatchNone` guards (builders.ts) only for a literal sentinel check.

**`effectiveDisplayConditionForEmission`** is the navigation twin: deep-simplify
a module/form display condition and fold an all-true result to no wire
attribute. It intentionally retains `match-none`; the validator rejects that
as an always-hidden navigation item before emission. Display-condition callers
must not reuse filter context assumptions: module relevancy has no case row,
and form relevancy has only the direct selected case when the module is
case-first.

## Wire-emission boundary

Three targets consume this one AST, all from outside the package: the on-device XPath dialect, the CSQL dialect, and Postgres SQL via `lib/case-store/sql`. They first consume the same relation-evaluation-scope normalization, then apply only target grammar/runtime restrictions. Non-grammar CSQL value expressions inline as on-device XPath fragments inside a wrapper `concat(...)` — the canonical CCHQ pattern per `commcare-hq/docs/case_search_query_language.rst`. The type checker and target-compatibility validators run before emission, so a validated typed AST is the single contract every consumer trusts.

## Barrel

The barrel re-exports every module wholesale via `export *` — each sibling module curates its own export surface, so new helpers need no parallel barrel edit.
