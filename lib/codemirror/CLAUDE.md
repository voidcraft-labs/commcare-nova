# lib/codemirror — XPath editor extensions

CodeMirror 6 extensions for editing CommCare XPath inside the builder: language binding, autocomplete, linting, hashtag chips, source formatting, theme. The grammar + parser live in `lib/commcare/xpath/` (shared with the carrier capability contract, lowerer, and deep validator); this package only consumes `parser` + the term constants it re-exports.

## No offer-then-reject

Autocomplete's per-case-type namespaces (`#<type>/`) and properties come from the SAME accept set the validator enforces (`caseRefAcceptMap`), so the editor never offers a reference it would then reject. Keep completion and validation reading one source.

## Session scope

`XPathLintContext.scope` says where the expression runs. `"form"` (the default, `buildLintContext`) is a field's slot inside the open form instance. `"session"` (`buildSessionLintContext`) is an after-submit link's condition or carried value, which CommCare evaluates after the form has closed: the context carries the SAME readable case types as the form's slots (one derivation, `formReachableCaseTypes`, narrowed by `caseRefAcceptMap` exactly as the deep validator's form-link pass is) and NO form paths — `validPaths` and `formEntries` are empty on purpose. Under it, autocomplete withholds `#form/` and `/data/` instead of offering what the gate refuses, and the linter turns a form read into the author-facing reason (`SESSION_FORM_READ_MESSAGE`) rather than "unknown field". `xpathDiagnostics` is the pure, testable heart of `xpathLinter`.

## Node type comparisons

Always compare pre-resolved `NodeType` objects from `parser.nodeSet.types` (each consumer builds its own `T` lookup from it, as `xpath-format.ts` does), never string names. Applies to operators, delimiters, keywords, and composite node types.
