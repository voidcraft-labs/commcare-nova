# lib/codemirror — XPath editor extensions

CodeMirror 6 extensions for editing CommCare XPath inside the builder: language binding, autocomplete, linting, hashtag chips, source formatting, theme. The grammar and the form-XPath parser live in `lib/commcare/xpath/` (shared with the checker and the emitter); this package consumes the Lezer `parser`, the term constants it re-exports, and `lib/doc/expressionText.ts::parseFormExpressionForSlot`.

## No offer-then-reject

Autocomplete's per-case-type namespaces (`#<type>/`) and properties come from the SAME accept set the validator enforces (`caseRefAcceptMap`), so the editor never offers a reference it would then reject. Keep completion and validation reading one source.

## Actual expression slots

`buildExpressionLintContext` (`buildLintContext.ts`) takes the real `ExpressionSlotRef` and current lookup definitions. It derives `slotContext` once and supplies the production parser to `xpathDiagnostics`; the same canonical `checkExpression` and target-compatibility verdict used by admission decide the result. There is no independent time-ordering or session-expression scanner.

A valid optional slot receives context even before it holds an expression. A deleted owner or nested member returns no context, and the editor refuses a nonempty save with a reason. Pending complete fields and members use a candidate document; not-yet-committed form declarations use the immutable `FormStructure` passed in parser and lint options. Connect drafts finalize every block identity before reading their sources and resolve dependencies lazily with cycle refusal.

`buildLintContext` is the shared per-form reference projection. It returns only a read-only `XPathReferenceContext` for chips and autocomplete; it cannot validate or save an expression. `buildExpressionLintContext` includes that projection, and `ReferenceProvider` reads it for any form through `components/builder/BuilderReferenceProvider.tsx`. The provider's cache is invalidated by `components/builder/referenceContextChanged.ts` exactly when a slice that projection reads changes; expression checks are not part of the reference-cache key.

## Session scope

After-submit conditions and carried values use their actual link UUID and typed datum identity. Their profile supplies session scope, so autocomplete withholds form paths and the shared checker refuses form reads. `formReachableCaseTypes` supplies the form's readable case catalog; autocomplete applies `caseRefAcceptMap(index, formType, "session")`, matching the form-link profile's case scope. Registration links can read the case just created, so form-open registration narrowing does not apply.

The parser names a bare relative read as `relative-no-context`, and a form read receives `SESSION_FORM_READ_MESSAGE` through the shared checker finding projection (`lib/commcare/validator/formLogicFindings.ts`). Both explain that the form has closed instead of reporting an unknown field. The linter adds no session rule of its own.

## Spans place findings

Parsing and printing return spans keyed by the stored tree's semantic paths, which are also the paths on checker findings. `xpathDiagnostics` is the pure, testable heart of `xpathLinter`: it returns parse issues at their source spans, then the parsed expression's checker findings, including `XPATH_TIME_ORDERING`, at the corresponding spans in the text as typed. Reference spellings and whitespace can change those positions without changing identity. A target-compatibility refusal covers the whole draft.

Inline lint and `XPathField`'s save gate consume the same `xpathDiagnostics` result. The document commit gate still checks invariants that require the complete app, and a refusal there keeps the draft visible with its reason.

## Node type comparisons

Always compare pre-resolved `NodeType` objects from `parser.nodeSet.types` (each consumer builds its own `T` lookup from it, as `xpath-format.ts` does), never string names. Applies to operators, delimiters, keywords, and composite node types.
