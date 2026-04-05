# XPath Transpiler

Transforms Nova's XPath dialect into CommCare-compatible XPath 1.0 at export time. Nova extends XPath with better type semantics (e.g. date-aware arithmetic); the transpiler emits equivalent XPath 1.0 that CommCare's runtime can evaluate identically.

## Architecture

Parse → type inference → pass pipeline → source edits → output string. Single-stage: all passes see the original tree, edits are merged and applied once.

**Type inference** uses Lezer's `NodeWeakMap<XPathType>` to associate inferred types with specific CST nodes. This is critical — nested nodes can share a start offset (e.g. `AddExpr` and `GreaterThanExpr` both start at 0 in `today() + 7 > today()`), so offset-based keying collides. `NodeWeakMap` keys by Lezer's internal buffer identity, which is unique per node instance.

**Passes** are `(tree, types, source) → SourceEdit[]`. Add new passes to the `PASSES` array in `index.ts`. Extend type inference by adding entries to `FUNCTION_TYPES` in `typeInfer.ts`.

## Current Passes

- **dateArithmetic** — wraps date-typed `+`/`-` expressions in `date()`. Skips date-date subtraction (produces a number) and expressions already inside `date()`.
