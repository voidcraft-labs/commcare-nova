# lib/commcare/xpath

CommCare's XPath dialect: the Lezer grammar + generated parser and the export-time transpiler that rewrites Nova's extended dialect into CommCare-safe XPath 1.0. Lives under `lib/commcare/` because XPath is the expression language CommCare defines — the "one-way emission boundary" rule is about wire-format emission, not shared parsing infrastructure other layers legitimately read.

`parser.ts` / `parser.terms.ts` are committed generated artifacts — regenerate via `scripts/build-xpath-parser.ts` after grammar changes. Internals (`typeInfer`, `passes/`) are not exported from the barrel.

## Transpiler pipeline

Parse → type inference → pass pipeline → source edits → output string. Single stage: every pass sees the ORIGINAL tree; edits merge and apply once at the end, and the pipeline throws on overlapping ranges. New passes register in the `PASSES` array; type inference extends via the `FUNCTION_TYPES` table.

## Type inference keys by Lezer's `NodeWeakMap`, not offsets

Nested nodes can share a start offset (`AddExpr` and `GreaterThanExpr` both start at 0 in `today() + 7 > today()`), so offset keying collides. `NodeWeakMap` keys by node identity.
