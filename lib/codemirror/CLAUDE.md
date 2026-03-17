# CommCare XPath Language (CodeMirror 6)

Custom XPath 1.0 language with CommCare hashtag references (`#case/prop`, `#form/question`, `#user/prop`), built on a Lezer grammar.

## Grammar (`xpath.grammar`)

**Design decisions:**
- Keyword operators (`and`, `or`, `div`, `mod`) use `@specialize` wrapped in uppercase `Keyword<w>` — lowercase inline rules make specialized tokens invisible in the parse tree.
- Standalone `/` uses `RootPath` with dynamic precedence `~-10` — parser prefers path interpretation (`/step`) over bare root.
- Token precedence: `NumberLiteral` beats `"."` so `.666` parses as a number, not a self-step + digits.
- Known limitation: context-sensitive cases like `3mod4` (no space) require a stateful lexer. Doesn't occur in real CommCare XPath.

**Rebuild after grammar changes:** `npx tsx scripts/build-xpath-parser.ts`

## Formatter (`xpath-format.ts`)

Two-phase architecture:

1. **Phase 1 (format)**: Walk Lezer tree → produce `FormatNode` tree with `Layout.Space` tokens between children. Source text is never modified — only whitespace is controlled.
2. **Phase 2 (render)**: Walk `FormatNode` tree → map to output (`Space → ' '`, `NewLine → '\n'`, `Tab → '\t'`).

`FormatNode.type` is a union of Lezer's `NodeType` and the `Layout` enum — one type, no discriminator wrappers.

**Node type comparisons**: Always use pre-resolved `NodeType` objects from `parser.nodeSet.types` (the `T` lookup), never string name comparisons. This applies to operators, delimiters, keywords, and composite node types.

**Spacing rules** (by parent node type):
- Binary expressions (`AddExpr`, `AndExpr`, etc.) → space around operator
- Paths (`Child`, `Descendant`) → no space
- Brackets/parens (`Filtered`, `ArgumentList`) → no space around delimiters, space after comma

## Pretty Printer

`prettyPrintXPath()` — additional tree-walking pass between format and render. Only activates when single-line result > 60 chars.

Replaces `Layout.Space` with `Layout.NewLine` + `Layout.Tab`:
- **ArgumentList** — newline + indent after `(`, after `,`, before `)`. Empty calls like `today()` stay inline.
- **Filtered** — newline + indent after `[`, before `]`
- **AndExpr / OrExpr** — newline before keyword when inside expanded context (depth > 0)

`XPathField` uses `prettyPrintXPath` for display; `formatXPath` (single-line) for storage/export.

## Language & Theme

- `xpath-language.ts` — CodeMirror `LanguageSupport` with `styleTags` highlighting and `foldNodeProp` (folds `ArgumentList` and `Filtered`).
- `xpath-theme.ts` — Nova dark theme for CodeMirror. Used by `XPathField` and `XPathEditorModal`.
