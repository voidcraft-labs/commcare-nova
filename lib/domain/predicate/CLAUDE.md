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

`caseTypeToJsonSchema` feeds the case-store's write-time AJV validator (rationale for TS-side validation lives in `lib/case-store/CLAUDE.md`). Properties without a declared `data_type` default to `{ type: "string" }` — deliberately matching the term compiler's `text` default at the same site. `int` emits a bounded `{ type: "integer", minimum, maximum }` at int4's signed-32-bit range so AJV's acceptance set matches the Postgres `::integer` cast — an out-of-range value fails as a typed validation error, never a raw Postgres error at INSERT.

## Named tool-schema definitions

The AST family schemas carry registered ids (`z.globalRegistry.add`, end of `types.ts`), so every `z.toJSONSchema` emission — the SA tool wire, the MCP listing — extracts each one ONCE into `definitions` under a stable human name (`#/definitions/Predicate`, `Term`, `ValueExpression`, …) and `$ref`s it at every use site. Without the ids, each predicate-carrying tool re-inlines the term structure per operator arm (~28k tokens of duplication across the SA tool set) and the recursion-forced extractions get per-tool `__schemaN` names. Register via `globalRegistry.add` (attaches in place), never `.meta()` (clones, and double-serializes shared child nodes into stray micro-definitions). A new reused-or-recursive family member should get an id here too.

## Two simplification layers — opposite contracts

**Construction-time reduction** (`reduction.ts`: `reduceAnd` / `reduceOr` / `reduceNot`) is scoped DELIBERATELY to empty / single-clause / double-negation: `and([])` → match-all, `or([])` → match-none, `[single]` → single, `not(not(x))` → x. Multi-clause lists are preserved verbatim — embedded sentinels are NOT dropped, same-kind nesting is NOT flattened — because a multi-clause `and` whose middle element is `match-all` is a meaningful intermediate editing state. Builders apply these on every call; hand-built object literals bypass them.

**Emission-time simplification** (`simplify.ts`: `simplifyForEmission`) is the DEEP normalizer applied right before a filter is serialized to the wire. It drops every boolean identity at every depth (`and` drops match-all / absorbs match-none; `or` is the dual; same-kind nesting flattens; `not` folds), recursing through nested predicate slots including those under a ValueExpression operand (`count.where`, `if.cond`). Emission's contract is wire accuracy, so the identity reduction deliberately keeps is stripped HERE — left in place it emits a `match-all() and X` conjunct (inaccurate config). NEVER call it from the construction / doc layer; it destroys editing state.

**`effectiveFilterForEmission`** (`simplify.ts`) wraps it for the common case: simplify a `caseListConfig.filter`, then fold an all-true result to `undefined` ("narrows nothing"). It is the SINGLE home of the "match-all ≡ no filter" decision — every consumer of the filter goes through it (the search `_xpath_query` composer, the case-list nodeset filter on suite XML + HQ JSON, the preview query, `compileForPlatform`'s skip-to-results decision, and the searchable-surface validator) — so "does this filter narrow anything?" (`=== undefined`) and "what do we emit?" can never disagree. A shallow `isMatchAll` at a decision site while emission simplifies deeply would let `and(match-all, match-all)` read as effective on one side and vanish on the other. (`match-none` is NOT folded — it narrows to the empty set, a real query.) Use the shallow `isMatchAll` / `isMatchNone` guards (builders.ts) only for a literal sentinel check.

## Wire-emission boundary

Three wire targets consume this one AST, all from outside the package: the on-device XPath dialect, the CSQL dialect (with a property-via lift that rewrites operator-direct `prop(via)` refs into enclosing `exists` envelopes before emission; non-grammar value expressions inline as on-device XPath fragments inside a wrapper `concat(...)` — the canonical CCHQ pattern per `commcare-hq/docs/case_search_query_language.rst`), and Postgres SQL via `lib/case-store/sql`. The type checker runs before any emission, so a typed AST is the single contract every consumer trusts.

## Barrel

The barrel re-exports every module wholesale via `export *` — each sibling module curates its own export surface, so new helpers need no parallel barrel edit.
