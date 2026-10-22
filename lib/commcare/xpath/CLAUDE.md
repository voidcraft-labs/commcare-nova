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
`wire/instant.ts` is the date-and-time lowering (below).

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

## The instant lowering

`instant.ts::instantMicros` builds, for an operand printed `T`, the zone-free
parse of `T` into integer microseconds: days from the civil date (era
arithmetic) times 86,400, plus the clock, minus the written offset, then
microseconds plus the rounded fraction. It reads the spellings Nova's lookup
cells admit (`lib/lookup/coercion.ts::isLookupDatetime`): `T`, `t` or a space
between date and clock (read by position), `Z` or `z`, `±HH`, `±HHMM`,
`±HH:MM` or no offset (read as UTC), and any number of fraction digits,
rounded to the microsecond with Core's one-argument `round`,
`floor(x + 0.5)`. The tail after the seconds is translated `'Zz+-'` to
`'||||'`; the offset is the text after the first mark, guarded so that no mark
gives `''`, and its minutes are its last two characters when it is longer than
two. Blank text is NaN, so an ordering is false and `!=` true. No input
throws: Core's `substring-after` returns the whole string when the separator
is absent and `substr` returns `''` past the end. Every sub-term is built once
as a shared node, so the memoised print is linear in its bytes. A few
malformed shapes read as a defined number rather than NaN (out-of-range
fields such as `2026-13-45T99:99:99Z`, a bare trailing `+`, `-` or `.`,
`T-4:30:00Z`, `04:30:00e5Z`); none is a spelling Nova, HQ or a device writes,
and the `expression` native family holds each decode as a named constant. A typed
instant whose zone's offset is under an hour but not zero (only historic
offsets, such as Amsterdam before 1937) prints `%Z` as `Z:MM`, which the
parse reads as NaN; seconds in a historic local-mean-time offset are dropped
by Core's `%Z`, a sub-minute error before 1900.

`toWire` applies it to each date-and-time operand of an ordering, and of an
equality between a date and time and a date and time or a value of unknown
type, in every device target, choosing each
operand's instant text by `lib/domain/expression/instantOperand.ts`'s class of
it and folding a literal by `literalInstantMicros`, the checker's own
grammar, computed with the device's own double operations in the device's
order, so a fold equals the parse even past 2^53; it reads a four-digit
year, and an offset's two-digit hours and minutes however large, as Core
adds them to the clock. A literal branch of an `if`, `coalesce` or `switch`
prints as `literalInstantText`, the literal's own date, clock and offset, which
the parse reads back to the fold's microseconds for every four-digit year,
whatever year its UTC moment falls in. It never
applies inside CSQL text: CSQL comparisons print through the CSQL emitter, and
only a runtime segment reaches `toWire`. The tests' `instantParse.ts`
recognises the parse structurally, so they read the tree rather than its
text.
`lib/commcare/CLAUDE.md`, "Dates and times compare as moments on a device",
holds the operand rows and the day rule.

The parser tests distinguish syntax, identity binding, exact context and strict
refusals. Property tests cover parse/print stability and totality over arbitrary
input. Wire tests inspect structure and declarations; pinned Core and HQ readers
establish executable and editor compatibility.
