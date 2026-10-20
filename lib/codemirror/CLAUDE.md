# lib/codemirror — XPath editor extensions

CodeMirror 6 extensions for editing CommCare XPath inside the builder: language binding, autocomplete, linting, identity chips, theme. This package formats nothing: what the editor shows is the printer's canonical text, laid out over lines past 60 characters by its `layout` option (`lib/domain/expression/print.ts`), and a save stores the parse, never normalized text. The grammar and the form-XPath parser live in `lib/commcare/xpath/` (shared with the checker and the emitter); this package consumes the Lezer `parser`, the term constants it re-exports, and `lib/doc/expressionText.ts::formParseScopeForSlot`.

## No offer-then-reject

Autocomplete's per-case-type namespaces (`#<type>/`) and properties come from the SAME accept set the validator enforces (`caseRefAcceptMap`), so the editor never offers a reference it would then reject. Keep completion and validation reading one source.

Every completion source (instance roots, case-query properties, session values, worker properties, data-table columns, relative steps, a static select's choices) is built from the same `FormParseScope` the parser resolves against, and the slot's profile decides what the checker admits, so autocomplete, the linter and the commit gate read one scope and one profile.

## The editor context

`ExpressionEditorContext { slot, scope: FormParseScope, reference: FormReferenceContext, check }`, built by `buildExpressionEditorContext(state, slot, lookup)` with `reference` the slot form's `buildFormReferenceContext`, says where the expression runs, and the slot's profile is that answer, never a flag. A field's slot reads inside the open form instance. An after-submit link's condition or carried value evaluates after the form has closed, so its scope carries the form's readable case types (one derivation, `formReachableCaseTypes`, exactly as the checker reads the form-link profile: a registration form's links read the case it created, so no narrowing applies there) and NO form paths. Its `reads` hold the completion vocabulary, from the same snapshot.

The context is built from the real `ExpressionSlotRef` and current lookup definitions, before the slot holds an expression too. A deleted owner or nested member gets no context, and the editor refuses a nonempty save with a reason. Pending complete fields and members use a candidate document; not-yet-committed form declarations use the immutable `FormStructure` passed in the options. Connect drafts finalize every block identity before reading their sources and resolve dependencies lazily with cycle refusal.

`formReferenceContext.ts::buildFormReferenceContext` is the per-form half: every editor context spreads it, and `ReferenceProvider` reads it for any form through `components/builder/BuilderReferenceProvider.tsx`, whose cache `components/builder/referenceContextChanged.ts` clears exactly when a slice that walk reads changes. `check` is a projection of one snapshot, never part of what the reference cache keys on.

The parser names a bare relative read in an after-submit slot as `relative-no-context`, and a form read receives `SESSION_FORM_READ_MESSAGE` through the shared checker finding projection (`lib/commcare/validator/formLogicFindings.ts`). Both explain the closed form instead of reporting an unknown field. Autocomplete withholds `#form/`, `/data/` and relative steps there. The linter adds no session rule of its own.

## Spans place findings

Parsing and printing each return a span per node, keyed by the node's path in the stored tree, the same path a checker finding carries, so the linter underlines every finding, `XPATH_TIME_ORDERING` among them, on the text as typed, whatever its spacing. The editor refuses exactly what the commit gate refuses. `xpathDiagnostics` is the pure, testable heart of `xpathLinter`: it returns the context's `check` of the draft, each parse issue at its span, then, when the draft parses, the slot checker's findings placed by span, so the inline lint and `XPathField`'s save gate read one function. A target-compatibility refusal covers the whole draft. The document commit gate still checks invariants that require the complete app, and a refusal there keeps the draft visible with its reason.

## Chips come from the parse

`xpath-chips.ts::expressionChips` parses the editor text with the context's scope and draws a chip over the span of each identity read whose spelling is a machine name: a question in every spelling (its label), worker information, a Search answer, a data table's instance path (the table's name) and its columns, a session value (what it holds), a search's results ("What the search found") and a choice (its option's label). Case properties and case types stay text, because their names are what a person reads. A draft that does not parse has no chips. Chips live in a `StateField`, so they are atomic for the cursor, and backspace over one deletes only its last character. `refreshExpressionChips` recomputes them when the document under an open editor changes without its text changing.

## Node type comparisons

Always compare pre-resolved `NodeType` objects from `parser.nodeSet.types` (each consumer builds its own `T` lookup from it), never string names. Applies to operators, delimiters, keywords, and composite node types. A tree the editor builds comes from the language's configured parser, whose `NodeType`s are its own, so editor-tree consumers resolve them through `xpath-language.ts::xpathNodeTypes`; a name can have several types (the grammar's root step and relative step are both `Child`), so it resolves to a set.
