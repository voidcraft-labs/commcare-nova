# lib/codemirror — XPath editor extensions

CodeMirror 6 extensions for editing CommCare XPath inside the builder: language binding, autocomplete, linting, hashtag chips, source formatting, theme. The grammar + parser live in `lib/commcare/xpath/` (shared with the carrier capability contract, lowerer, and deep validator); this package only consumes `parser` + the term constants it re-exports.

## No offer-then-reject

Autocomplete's per-case-type namespaces (`#<type>/`) and properties come from the SAME accept set the validator enforces (`caseRefAcceptMap`), so the editor never offers a reference it would then reject. Keep completion and validation reading one source.

## Session scope

`XPathLintContext.scope` says where the expression runs. `"form"` (the default, `buildLintContext`) is a field's slot inside the open form instance. `"session"` (`buildSessionLintContext`) is an after-submit link's condition or carried value, which CommCare evaluates after the form has closed: the context carries the form's readable case types (one derivation, `formReachableCaseTypes`, through `caseRefAcceptMap(index, formType, "session")` exactly as the deep validator's form-link pass reads it — a registration form's links read the case it created, so no narrowing applies there) and NO form paths — `validPaths` and `formEntries` are empty on purpose. Under it, autocomplete withholds `#form/` and `/data/` instead of offering what the gate refuses, and the validator itself (`validateXPath(…, "session")`) turns a form read or a bare relative name into the author-facing reason (`SESSION_FORM_READ_MESSAGE`) rather than "unknown field" — the linter adds no rule of its own. `xpathDiagnostics` is the pure, testable heart of `xpathLinter`.

## Ordering a time of day

Both lint contexts carry `timeOrderings` (`buildLintContext.ts::formTimeOrderings`): the text parsed to the stored expression a save writes, read by the validator's own `lib/commcare/validator/timeOrdering.ts::findTimeOrderingComparisons` over the document the context was built from, each finding placed on the text as typed by its ordinal among the orderings (`orderingSpans`), since a reference can print at another length than it was typed. `xpathDiagnostics` underlines each ordering on a time with `XPATH_TIME_ORDERING`'s sentence once the expression has no other finding, so the editor refuses exactly what the commit gate refuses. The function is a projection of one snapshot, never part of what the reference cache keys on.

## Node type comparisons

Always compare pre-resolved `NodeType` objects from `parser.nodeSet.types` (each consumer builds its own `T` lookup from it, as `xpath-format.ts` does), never string names. Applies to operators, delimiters, keywords, and composite node types.
