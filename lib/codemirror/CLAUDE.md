# lib/codemirror — XPath editor extensions

CodeMirror 6 extensions for editing CommCare XPath inside the builder: language binding, autocomplete, linting, hashtag chips, source formatting, theme. The language grammar + parser itself lives in `lib/commcare/xpath/` (shared with the compile-time transpiler and deep validator); this package only consumes `parser` + the term constants it re-exports.

## Files

- `xpath-language.ts` — wraps the Lezer parser as a CodeMirror `LanguageSupport`.
- `xpath-autocomplete.ts` — hashtag + function completions, scoped to the current form.
- `xpath-lint.ts` / `buildLintContext.ts` — surface validator diagnostics inline; the context object shuttles the doc + target field + function registry into the linter without pulling the validator into every editor mount.
- `xpath-chips.ts` — replaces hashtag tokens with a pill widget backed by the parser's node positions.
- `xpath-format.ts` — canonical-form whitespace normalizer used when committing an edit.
- `xpath-theme.ts` — token colors + decoration styles, driven by `globals.css` custom properties.

## Node type comparisons

Always use pre-resolved `NodeType` objects from `parser.nodeSet.types` (the `T` lookup re-exported alongside `parser`), never string name comparisons. Applies to operators, delimiters, keywords, and composite node types.
