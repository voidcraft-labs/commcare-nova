# lib/commcare/xpath

CommCare's XPath dialect: the Lezer grammar + generated parser, the carrier capability contract, and the narrow production lowerer that turns explicitly proven Nova extensions into JavaRosa-safe XPath. Lives under `lib/commcare/` because XPath is the expression language CommCare defines — the "one-way emission boundary" rule for `lib/commcare/` is about wire-format emission (XForm XML, HqApplication JSON), not about shared parsing infrastructure that other layers legitimately read.

## Layout

- `grammar.lezer.grammar` — grammar source.
- `parser.ts` + `parser.terms.ts` — committed, regenerated via `scripts/build-xpath-parser.ts`.
- `expressionAst.ts` — the human-editor parser half of the stored-expression pair: source text → `XPathExpression` (the typed AST in `lib/domain/xpath`, whose printer + walks live domain-side because the field/form schemas store the shape). Total over any input. Text between identity leaves stays byte-exact, while reference leaves print canonically. A `path-ref` stores only its field UUID and always prints the absolute `/data/<current path>` spelling; migration rejects a noncanonical legacy path rather than persisting separator bytes. Parsing also receives the app's custom worker-property slug resolver: one exact unique `#user/<slug>` match becomes `user-property-ref { userPropertyUuid }`, while built-in, external, missing, or ambiguous names remain the distinct name-backed `user-ref`. Printing resolves an identity leaf through the property's CURRENT slug, so a rename rewrites no AST.
- `hashtagGuard.ts` — external tokenizer emitting the zero-width adjacency guards `HashtagRef` requires between its tokens (a hashtag is one contiguous span; an open-ended skipless rule is inexpressible in LR). Kept in lockstep with the regex matchers built from `lib/domain/hashtagSegments.ts` by the divergence-corpus test.
- `functionCapabilities.ts` — exact, independently sourced function tables for JavaRosa, Preview, and CCHQ CSQL. A function being valid in one carrier says nothing about another. `instance()` and `current()` are path initializers, not ordinary JavaRosa function calls; Preview support for `instance()` is additionally namespace- and evaluation-context-specific. `here()` is a menu/detail runtime handler and is never valid in an XForm.
- `javaRosaLowering.ts` — the production raw-XPath wire lowerer. It walks the Lezer CST and currently lowers only `normalize-space(value)` to JavaRosa-native `replace()` calls over the XML whitespace set. XForm real attributes, Vellum shadows, suite XPath, and XPath-bearing HQ JSON all cross this boundary before serialization.
- `transpiler.ts` — experimental `transpile(source)` entry point. No production emitter calls it.
- `typeInfer.ts` — internal bottom-up type inference over the Lezer CST.
- `passes/` — internal transform passes, each shaped `(tree, types, source) → SourceEdit[]`.
- `detectUnquotedStringLiteral.ts` — standalone parser-backed check for the "bare word where a string literal was intended" authoring mistake. Used by the deep validator's form + field rules.
- `index.ts` — public barrel: `parser`, parser term constants, `lowerXPathForJavaRosa`, `transpile`, `detectUnquotedStringLiteral`. Internals (`typeInfer`, `passes`) are not exported.

## Production compatibility boundary

`FUNCTION_REGISTRY` may admit only functions classified as JavaRosa native, proven-lowered, or path initializers used in their required path-root position. Do not infer compatibility from an XPath version or a familiar function name: JavaRosa omits some XPath 1.0 functions and adds its own, while CCHQ CSQL exposes a separate value/query whitelist. Preview declares its implemented subset independently and throws on an unsupported call instead of returning a plausible blank value.

Form-link XPath is a distinct carrier context: Core evaluates it from the
suite entry after the XForm has closed. The boundary expands typed case/user
refs against the session stack, rejects form-local refs and empty datum
expressions, and declares every projected secondary instance on the entry.

The source tables are pinned to upstream SHAs in `functionCapabilities.ts`. Update a table only after reading the owning runtime dispatch and exercising the behavior against that frozen source. A new lowered function must have evaluator and XForm-initialization proof, artifact tests that find no unlowered call, and an explicit decision for Preview and CSQL.

`lowerXPathForJavaRosa` preserves all source bytes outside the replacement ranges and applies nested edits from the CST; never replace function text with regex. Malformed input passes through because the commit validator owns syntax. Production emitters must not call the experimental transpiler: activating an unrelated pass changes already-valid app semantics.

## Experimental transpiler pipeline

Parse → type inference → pass pipeline → source edits → output string. Single stage: every pass sees the original tree; edits are merged and applied once at the end. Passes must produce non-overlapping ranges; the pipeline throws on overlap.

## Type inference keys by Lezer's `NodeWeakMap`, not offsets

Nested nodes can share a start offset — e.g. `AddExpr` and `GreaterThanExpr` both start at 0 in `today() + 7 > today()` — so offset-based keying collides. `NodeWeakMap` keys by Lezer's internal buffer identity, which is unique per node instance.

## Adding a pass or extending type inference

A pass has the shape `(tree, types, source) → SourceEdit[]`. Register new passes in the `PASSES` array in `transpiler.ts`; extend type inference by adding entries to the `FUNCTION_TYPES` table in `typeInfer.ts`.

## Current passes

- **dateArithmetic** — wraps date-typed `+`/`-` expressions in `date()`. Skips date-date subtraction (produces a number) and expressions already inside `date()`.
