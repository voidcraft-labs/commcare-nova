# lib/commcare/xpath

This directory owns Nova's form-expression parser and CommCare's resolved XPath
emission boundary. Authors enter XPath, but documents store the domain
`Expression` union. Parsing infrastructure can be read by the editor and
validator; emitted wire shapes remain behind `lib/commcare`.

## Parsing and identity

`grammar.lezer.grammar` defines the syntax. `parser.ts` and `parser.terms.ts` are
committed generated files; regenerate them with `scripts/build-xpath-parser.ts`.
`hashtagGuard.ts` keeps a hashtag contiguous and stays aligned with the domain
hashtag matchers through the divergence corpus.

`formSyntax.ts` converts the Lezer tree into a finite syntax tree. It retains
source spans for diagnostics, never as saved executable text. `expressionAst.ts`
then binds every operator and reference into `Expression`, or returns bounded
issues. Blank source returns no expression. There is no raw-text fallback,
unknown call, arbitrary path or unresolved name in a successful result.

Every parse receives a `FormParseScope` with the real `ExpressionSlotRef` and an
authoritative rows-free lookup catalog. `formScopeContext` derives the slot's
expected value and evaluation node. An optional complete `FormStructure` supplies
pending declarations during atomic authoring; it is not a partial document.
`formPathBinding.ts` resolves relative paths, `current()`, secondary instances
and logical field paths through the same finite form graph. Predicate context
moves to the addressed node while `current()` retains the source carrier.

A field, choice, worker property, text unit, lookup table or column is saved by
identity. Case reads retain their case type and property; selected-record reads
and query-row reads stay distinct. `referenceBindings.ts` also binds prose
insertions directly to the separate prose-reference union. No expression parser
is used to manufacture prose parts.

The domain printer projects current names and locations. A relative reference
retains its target identity across a move, so its parent steps are derived when
printed. During edits, only a structurally matching source occurrence can reuse
an existing identity hint, and that identity must remain available in the new
declarations. Grouping and whitespace are presentation, never storage.
`sourceProjection` exists only for the raw-snapshot lift's old physical names;
normal authoring always uses the current declared structure.

## Emission and capabilities

`wire/` turns a typed `Expression` and its actual slot-derived context into
`WireExpr`, then `serializeWire` returns target text and the exact instance
declarations it reads. Generated scaffolding uses `w` directly. All authored
form slots, including Connect and after-submit links, use this boundary; no
stored or branded authored string crosses an executable XML or HQ JSON slot.
`wire/CLAUDE.md` owns target modes, literals, shadow eligibility and declarations.

`functionCapabilities.ts` records independently sourced runtime capabilities.
JavaRosa's executable XForm set is the authoring floor, and an admitted form
function also needs Preview execution support. CSQL is classified separately
for Search. `instance()` and `current()` initialize typed paths; `here()` belongs
to menu/detail runtime contexts. A function's signature lives in
`lib/domain/expressionFunctions.ts`; the parser does not maintain another list.

After-submit links run from the suite entry after the form closes. Their real
slot context excludes main-form answers and requires a nonempty datum value.
Session reads bind to the exact target selection member. A Project table tag
resolves through the authorized catalog into stable table and column identities;
printing and emission derive its current name. A loading catalog cannot establish
that a table is missing.

Native or lowered functions need proof against the pinned owning runtime before
admission. `normalize-space` and `is-blank` lower through the wire tree.
`is-blank` means missing or empty; zero, false and whitespace are values.
Emitted XPath is never rewritten after serialization. Never rewrite XPath with
regex.

The parser tests distinguish syntax, identity binding, exact context and strict
refusals. Property tests cover parse/print stability and totality over arbitrary
input. Wire tests inspect structure and declarations; pinned Core and HQ readers
establish executable and editor compatibility.
