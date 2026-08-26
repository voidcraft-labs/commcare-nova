# lib/commcare/xpath

CommCare's XPath dialect: the Lezer grammar + generated parser, the carrier capability contract, and the narrow production lowerer that turns explicitly proven Nova extensions into JavaRosa-safe XPath. Lives under `lib/commcare/` because XPath is the expression language CommCare defines — the "one-way emission boundary" rule for `lib/commcare/` is about wire-format emission (XForm XML, HqApplication JSON), not about shared parsing infrastructure that other layers legitimately read.

## Layout

- `grammar.lezer.grammar` — grammar source.
- `parser.ts` + `parser.terms.ts` — committed, regenerated via `scripts/build-xpath-parser.ts`.
- `expressionAst.ts` — the human-editor parser half of the stored-expression pair: source text → `XPathExpression` (the typed AST in `lib/domain/xpath`, whose printer + walks live domain-side because the field/form schemas store the shape). Total over any input. Text between identity leaves stays byte-exact, while reference leaves print canonically. A `path-ref` stores only its field UUID and always prints the absolute `/data/<current path>` spelling; migration rejects a noncanonical legacy path rather than persisting separator bytes. Parsing also receives the app's custom worker-property slug resolver: one exact unique `#user/<slug>` match becomes `user-property-ref { userPropertyUuid }`, while built-in, external, missing, or ambiguous names remain the distinct name-backed `user-ref`. Printing resolves an identity leaf through the property's CURRENT slug, so a rename rewrites no AST.
- `hashtagGuard.ts` — external tokenizer emitting the zero-width adjacency guards `HashtagRef` requires between its tokens (a hashtag is one contiguous span; an open-ended skipless rule is inexpressible in LR). Kept in lockstep with the regex matchers built from `lib/domain/hashtagSegments.ts` by the divergence-corpus test.
- `functionCapabilities.ts` — exact, independently sourced function tables for JavaRosa, Nova Preview execution, and CCHQ CSQL. JavaRosa's executable XForm set is Nova's authoring floor, so every function or path initializer the authoring registry admits must also appear in Preview's execution contract. CSQL remains independently classified because only case-search carriers reach that server runtime. `instance()` and `current()` are path initializers, not ordinary JavaRosa function calls; each admitted `instance()` namespace also needs an explicit resolver in every owning Preview context. `here()` is a menu/detail runtime handler and is never valid in an XForm.
- `carriers.ts` — the canonical walk of every persisted `XPathExpression`, paired with its closed execution profile. Field expressions are Preview-form-owned, form-link expressions are Preview-session-owned, Connect expressions are wire-form-only, and case-property catalog constraints are wire-catalog-only. Scanners and validators consume this inventory instead of maintaining their own slot lists.
- `compatibility.ts` — the privacy-safe carrier admission verdict. Its source-only pass composes executable language checks with function, signature, and context capabilities for the carrier profile. Its instance pass admits only stable structural ids in raw XPath. Lookup tables stay in UUID-bearing typed carriers because their tags live outside `BlueprintDoc` and can be renamed. Both passes return stable codes and constant prose, never authored source.
- `javaRosaLowering.ts` — the production raw-XPath wire lowerer. It walks the Lezer CST and currently lowers only `normalize-space(value)` to JavaRosa-native `replace()` calls over the XML whitespace set. XForm real attributes, Vellum shadows, suite XPath, and XPath-bearing HQ JSON all cross this boundary before serialization.
- `transpiler.ts` — experimental `transpile(source)` entry point. No production emitter calls it.
- `typeInfer.ts` — internal bottom-up type inference over the Lezer CST.
- `passes/` — internal transform passes, each shaped `(tree, types, source) → SourceEdit[]`.
- `detectUnquotedStringLiteral.ts` — standalone parser-backed check for the "bare word where a string literal was intended" authoring mistake. Used by the deep validator's form + field rules.
- `index.ts` — public barrel: `parser`, parser term constants, `analyzeXPathCompatibility`, `lowerXPathForJavaRosa`, `transpile`, `detectUnquotedStringLiteral`. Internals (`typeInfer`, `passes`) are not exported.

## Production compatibility boundary

`FUNCTION_REGISTRY` may admit only functions classified as JavaRosa native,
proven-lowered, or path initializers used in their required path-root position,
and every admitted call shape must have a faithful Preview execution path. Do
not infer compatibility from an XPath version or a familiar function name:
JavaRosa omits some XPath 1.0 functions and adds its own, while CCHQ CSQL
exposes a separate value/query whitelist. Independent capability evidence is
still necessary, but an authorable JavaRosa/Preview mismatch is an invariant
failure rather than a supported carrier distinction.

Form-link XPath is a distinct carrier context: Core evaluates it from the
suite entry after the XForm has closed, with no main/current reference. The
boundary expands typed case/user refs against the session stack, rejects every
main-context dependency and empty datum expression, and declares every
projected structural secondary instance on the entry. Raw expressions may name
only `casedb` and `commcaresession`; a lookup wire tag is a mutable projection
with no stable identity leaf, so lookup-backed behavior remains on Nova's typed
table carriers. The canonical profile resolver supplies this same closed set to
the validator and fleet scanner.

The source tables are pinned to upstream SHAs in `functionCapabilities.ts`.
Update a table only after reading the owning runtime dispatch and exercising the
behavior against that frozen source. A native or lowered function cannot enter
the authoring registry without Preview execution proof. A new lowering also
needs XForm-initialization proof and artifact tests that find no unlowered call;
CSQL needs an explicit decision only when the expression can reach a CSQL
carrier.

`lowerXPathForJavaRosa` preserves all source bytes outside the replacement ranges and applies nested edits from the CST; never replace function text with regex. Malformed input passes through because the commit validator owns syntax. Production emitters must not call the experimental transpiler: activating an unrelated pass changes already-valid app semantics.

## Experimental transpiler pipeline

Parse → type inference → pass pipeline → source edits → output string. Single stage: every pass sees the original tree; edits are merged and applied once at the end. Passes must produce non-overlapping ranges; the pipeline throws on overlap.

## Type inference keys by Lezer's `NodeWeakMap`, not offsets

Nested nodes can share a start offset — e.g. `AddExpr` and `GreaterThanExpr` both start at 0 in `today() + 7 > today()` — so offset-based keying collides. `NodeWeakMap` keys by Lezer's internal buffer identity, which is unique per node instance.

## Adding a pass or extending type inference

A pass has the shape `(tree, types, source) → SourceEdit[]`. Register new passes in the `PASSES` array in `transpiler.ts`; extend type inference by adding entries to the `FUNCTION_TYPES` table in `typeInfer.ts`.

## Current passes

- **dateArithmetic** — wraps date-typed `+`/`-` expressions in `date()`. Skips date-date subtraction (produces a number) and expressions already inside `date()`.
