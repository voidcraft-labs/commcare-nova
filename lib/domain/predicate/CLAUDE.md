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
- `any-relation` is direction-agnostic but CCHQ's grammars are direction-specific, so wire emitters expand it to `(<ancestor-form> or <subcase-form>)`; Postgres compiles a `unionAll` of the two single-hop variants.

## Null vs blank semantics — locked invariant

Three data-model states: key absent, key present with JSON null, key present with empty string. `is-null` matches strict-absent only; `is-blank` widens to absent-or-empty. CCHQ's wire layer collapses all three into one match set (`prop = ''` — broader than `is-null` says, exact for `is-blank`); Nova's Postgres runtime distinguishes them natively and emits the strict SQL. Removing `is-null` would be a one-way door (it changes the closed kind set and breaks every persisted predicate). Authoring surfaces default to `is-blank` for "field is empty"; `is-null` exists for callers that need strict-absent (audit views, `coalesce`-adjacent logic).

## Type checker contract

`checkPredicate` / `checkExpression` validate a constructed AST against the case-type schema + search-input declarations, with per-node error paths. Rules worth knowing beyond the code:

- Strings are deliberately excluded from `ORDERED_TYPES` — locale-dependent string ordering is rarely meaningful for case-list filtering, so `gt`/`lt` reject text.
- Property references inside relational `where` clauses must resolve against the surrounding `via`'s DESTINATION scope, not the originating one.
- **The checker is the gate every emitter trusts.** Compiler/emitter code that hits a state the checker should have rejected throws a "the type checker should have caught this" error — never falls back to a default. Checker coverage is the structural contract, not a hint.

## JSON Schema generator

`caseTypeToJsonSchema` feeds the case-store's write-time AJV validator (rationale for TS-side validation lives in `lib/case-store/CLAUDE.md`). Properties without a declared `data_type` default to `{ type: "string" }` — deliberately matching the term compiler's `text` default at the same site.

## Reduction module

Construction-time boolean-algebra simplification, scoped DELIBERATELY to empty / single-clause / double-negation: `and([])` → match-all, `or([])` → match-none, `[single]` → single, `not(not(x))` → x. Multi-clause lists do NOT collapse embedded sentinels or flatten nested same-kind clauses — a multi-clause `and` whose middle element is `match-all` is a meaningful intermediate editing state, and CCHQ evaluates `true() and X` natively, so the wire passes the sentinel through without cost. Builders apply the reductions on every call; hand-built object literals bypass them.

## Wire-emission boundary

Three wire targets consume this one AST, all from outside the package: the on-device XPath dialect, the CSQL dialect (with a property-via lift that rewrites operator-direct `prop(via)` refs into enclosing `exists` envelopes before emission; non-grammar value expressions inline as on-device XPath fragments inside a wrapper `concat(...)` — the canonical CCHQ pattern per `commcare-hq/docs/case_search_query_language.rst`), and Postgres SQL via `lib/case-store/sql`. The type checker runs before any emission, so a typed AST is the single contract every consumer trusts.

## Barrel

The barrel re-exports every module wholesale via `export *` — each sibling module curates its own export surface, so new helpers need no parallel barrel edit.
