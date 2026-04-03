# CommCare XPath Language (CodeMirror 6)

Custom XPath 1.0 language with CommCare hashtag references (`#case/prop`, `#form/question`, `#user/prop`), built on a Lezer grammar.

## Grammar Design Decisions

**`HashtagRef` uses `!hashtag` precedence** on the inner `/` — without this, the parser reduces early and treats the `/` as a child-step operator, splitting `#case/property` into a hashtag followed by a path.

**Keyword operators** (`and`, `or`, `div`, `mod`) use `@specialize` wrapped in uppercase `Keyword<w>` — lowercase inline rules make specialized tokens invisible in the parse tree, breaking consumer code that needs to identify operators.

**`RootPath` has dynamic precedence `~-10`** on standalone `/` — the parser prefers path interpretation (`/step`) over bare root, which is the correct behavior in virtually all CommCare XPath.

**`NumberLiteral` beats `"."`** in token precedence so `.666` parses as a number, not a self-step followed by digits.

## Node Type Comparisons

Always use pre-resolved `NodeType` objects from `parser.nodeSet.types` (the `T` lookup), never string name comparisons. This applies to operators, delimiters, keywords, and composite node types.

## Known Limitation

Context-sensitive cases like `3mod4` (no space between number and keyword operator) would require a stateful lexer. This doesn't occur in real CommCare XPath.

## Rebuild After Grammar Changes

```bash
npx tsx scripts/build-xpath-parser.ts
```
