# CommCare XPath Language (CodeMirror 6)

Custom XPath 1.0 language with CommCare hashtag references (`#case/prop`, `#form/question`, `#user/prop`), built on a Lezer grammar.

## Grammar (`xpath.grammar`)

**Design decisions:**
- `HashtagRef` is a grammar rule (not a flat token) with `HashtagType` and `HashtagSegment` child nodes. `!hashtag` precedence on the inner `/` prevents the parser from reducing early and treating it as a child-step operator. Consumers use `getChild(T.HashtagType.id)` and `getChildren(T.HashtagSegment.id)` to read parts directly from the tree.
- Keyword operators (`and`, `or`, `div`, `mod`) use `@specialize` wrapped in uppercase `Keyword<w>` — lowercase inline rules make specialized tokens invisible in the parse tree.
- Standalone `/` uses `RootPath` with dynamic precedence `~-10` — parser prefers path interpretation (`/step`) over bare root.
- Token precedence: `NumberLiteral` beats `"."` so `.666` parses as a number, not a self-step + digits.
- Known limitation: context-sensitive cases like `3mod4` (no space) require a stateful lexer. Doesn't occur in real CommCare XPath.

**Rebuild after grammar changes:** `npx tsx scripts/build-xpath-parser.ts`

## Formatter (`xpath-format.ts`)

Two-phase architecture:

1. **Phase 1 (format)**: Walk Lezer tree → produce `FormatNode` tree with `Layout.Space` tokens between children. Source text is never modified — only whitespace is controlled.
2. **Phase 2 (render)**: Walk `FormatNode` tree → map to output (`Space → ' '`, `NewLine → '\n'`, `Tab → '    '` (4 spaces)).

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

`XPathField` uses `prettyPrintXPath` for display; `XPathEditorModal` opens with `prettyPrintXPath` and saves via `formatXPath` (single-line) for storage/export. `Layout.Tab` renders as 4 spaces (not `\t`) so editor auto-indent matches formatter output.

## Linter (`xpath-lint.ts`)

`xpathLinter(getContext)` — CodeMirror lint extension using `@codemirror/lint`. Takes a getter that reads live from the blueprint (`() => { blueprint, form, moduleCaseType }`). On each lint pass, derives valid paths and case properties from the blueprint, then runs `validateXPath()` for full syntax + semantic validation. Blocks save in `XPathEditorModal` when diagnostics are present.

## Autocomplete (`xpath-autocomplete.ts`)

`xpathAutocomplete(getContext)` — CodeMirror autocomplete extension using `@codemirror/autocomplete`. Same getter pattern as `xpathLinter` — reads live from the blueprint via `XPathLintContext`.

**Three completion sources:**
- **Functions** — all ~65 from `FUNCTION_REGISTRY`, cached at module level. Uses `snippetCompletion` with typed placeholders (e.g. `if(${1:boolean}, ${2}, ${3})`). Suppressed inside `HashtagRef`, `Child`, `Descendant`, `StringLiteral` via `ifNotIn`.
- **Hashtag references** — two-phase: bare `#` shows namespace prefixes (`#case/`, `#form/`, `#user/`); after a namespace, shows properties/questions from the blueprint. `activateOnCompletion` re-triggers after picking a namespace prefix.
- **Data paths** — `/data/...` paths from `collectValidPaths()`.

**Context detection uses Lezer syntax tree nodes** (`syntaxTree().resolveInner()`), not regex. The grammar's `HashtagRef` (opaque token), `Child`/`Descendant` (path chains), and `NameTest`/`FunctionName` nodes drive all context decisions. Node text is only read from identified tree nodes (e.g. extracting the namespace from a `HashtagRef` token, checking a `NameTest` is `"data"`).

## Language & Theme

- `xpath-language.ts` — CodeMirror `LanguageSupport` with `styleTags` highlighting and `foldNodeProp` (folds `ArgumentList` and `Filtered`).
- `xpath-theme.ts` — Nova dark theme for CodeMirror. Used by `XPathField` and `XPathEditorModal`. Also exports `novaAutocompleteTheme` — dark tooltip styling for the autocomplete dropdown (z-index 200 to float above the XPath modal).
