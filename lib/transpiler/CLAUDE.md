# XPath Transpiler

Transforms Nova's XPath dialect into CommCare-compatible XPath 1.0 at export time. Nova extends XPath with better type semantics (e.g. date-aware arithmetic); the transpiler emits equivalent XPath 1.0 that CommCare's runtime evaluates identically.

## Pipeline

Parse → type inference → pass pipeline → source edits → output string. Single stage: every pass sees the original tree; edits are merged and applied once at the end.

## Type inference keys by Lezer's `NodeWeakMap`, not offsets

Nested nodes can share a start offset — e.g. `AddExpr` and `GreaterThanExpr` both start at 0 in `today() + 7 > today()` — so offset-based keying collides. `NodeWeakMap` keys by Lezer's internal buffer identity, which is unique per node instance.

## Adding a pass or extending type inference

A pass has the shape `(tree, types, source) → SourceEdit[]`. Register new passes in the central passes array; extend type inference by adding entries to the function-types table.

## Current passes

- **dateArithmetic** — wraps date-typed `+`/`-` expressions in `date()`. Skips date-date subtraction (produces a number) and expressions already inside `date()`.
