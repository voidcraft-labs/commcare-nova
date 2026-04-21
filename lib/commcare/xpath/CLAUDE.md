# lib/commcare/xpath

CommCare's XPath dialect: the Lezer grammar + generated parser and the export-time transpiler that rewrites Nova's extended dialect into CommCare-safe XPath 1.0. Lives under `lib/commcare/` because XPath is the expression language CommCare defines — the "one-way emission boundary" rule for `lib/commcare/` is about wire-format emission (XForm XML, HqApplication JSON), not about shared parsing infrastructure that other layers legitimately read.

## Layout

- `grammar.lezer.grammar` — grammar source.
- `parser.ts` + `parser.terms.ts` — committed, regenerated via `scripts/build-xpath-parser.ts`.
- `transpiler.ts` — public `transpile(source)` entry point.
- `typeInfer.ts` — internal bottom-up type inference over the Lezer CST.
- `passes/` — internal transform passes, each shaped `(tree, types, source) → SourceEdit[]`.
- `detectUnquotedStringLiteral.ts` — standalone parser-backed check for the "bare word where a string literal was intended" authoring mistake. Used by the deep validator's form + field rules.
- `index.ts` — public barrel: `parser`, parser term constants, `transpile`, `detectUnquotedStringLiteral`. Internals (`typeInfer`, `passes`) are not exported.

## Transpiler pipeline

Parse → type inference → pass pipeline → source edits → output string. Single stage: every pass sees the original tree; edits are merged and applied once at the end. Passes must produce non-overlapping ranges; the pipeline throws on overlap.

## Type inference keys by Lezer's `NodeWeakMap`, not offsets

Nested nodes can share a start offset — e.g. `AddExpr` and `GreaterThanExpr` both start at 0 in `today() + 7 > today()` — so offset-based keying collides. `NodeWeakMap` keys by Lezer's internal buffer identity, which is unique per node instance.

## Adding a pass or extending type inference

A pass has the shape `(tree, types, source) → SourceEdit[]`. Register new passes in the `PASSES` array in `transpiler.ts`; extend type inference by adding entries to the `FUNCTION_TYPES` table in `typeInfer.ts`.

## Current passes

- **dateArithmetic** — wraps date-typed `+`/`-` expressions in `date()`. Skips date-date subtraction (produces a number) and expressions already inside `date()`.
