# lib/codemirror — XPath editor extensions

CodeMirror 6 extensions for editing CommCare XPath inside the builder: language binding, autocomplete, linting, hashtag chips, source formatting, theme. The grammar + parser live in `lib/commcare/xpath/` (shared with the transpiler and deep validator); this package only consumes `parser` + the term constants it re-exports.

## No offer-then-reject

Autocomplete's per-case-type namespaces (`#<type>/`) and properties come from the SAME accept set the validator enforces (`caseRefAcceptMap`), so the editor never offers a reference it would then reject. Keep completion and validation reading one source.

## Node type comparisons

Always compare pre-resolved `NodeType` objects from `parser.nodeSet.types` (each consumer builds its own `T` lookup from it, as `xpath-format.ts` does), never string names. Applies to operators, delimiters, keywords, and composite node types.
