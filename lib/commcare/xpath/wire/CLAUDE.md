# lib/commcare/xpath/wire

This is the resolved XPath emission boundary. `toWire` turns the unified domain `Expression`
into `WireExpr`; generated scaffolding uses `w` directly. Every authored call
requires the actual slot-derived `ExpressionContext`. A caller may supply
wire identity bindings, but cannot reconstruct a partial type context. Names in a tree
are current wire names, resolved from domain identity before construction.
`serializeWire` is the only printer. There is no raw XPath arm, arbitrary call
name, grouping node, raw path fragment, union, or authored variable arm.
The explicit child-wildcard step serves generated parent-index selection,
`index/*[not(@relationship = 'extension')]`; it is not a resolved field name.

`WireFunction` derives from the one pinned native function table, plus
`jr:itext`, `jr:choice-name` and the menu/detail handler `here`. Lowered Nova
functions become native trees before printing. Core cannot execute XPath union;
an old unreachable union printer is an invariant failure, never a new tree arm.

## Printing

Every mode uses canonical comma and binary-operator spacing, shortest finite
decimal numbers without exponents, and precedence-preserving parentheses. A
right operand of equal precedence keeps grouping except within the same n-ary
`and` or `or`. The printer memoizes shared subtrees separately inside and
outside predicates; a repeated subtree is not repeatedly rebuilt.
When a string node is a direct argument of `concat`, its literal-encoding
tokens join that call's arguments, including empty boundary pieces from a
mixed-quote split. This preserves the generated scaffold; actual nested
`concat` nodes retain their structure. No emitter or constructor handles quote
spelling, and the printer never parses rendered text to flatten a call.

The modes are `xform`, `vellum`, `suite`, `hq-json` and `preview`. `preview`
prints as `suite` does, with the instance ids the wire declares: no `./.`
protection, no HQ literal splitting, and a generated suite variable is an
invariant failure. Preview evaluates that text over instances shaped like the
device's. Its one addressing difference is not the printer's: Preview passes
`toWire` its own form-node projection
(`lib/preview/engine/formExpressionRuntime.ts::previewFormNodeProjection`), in
which a field in a query-bound repeat resolves without the `item` step,
because Preview's main instance flattens a query repeat's rows. XForm/Vellum
printing knows whether the slot is a constraint. A lone self path inside a
non-constraint predicate prints `./.` so Vellum does not mistake it for the
question's own answer. A Vellum shadow requires a form-field read with hashtag
spelling; constants, absolute/relative paths and hashtag-shaped literal values
alone produce no shadow. Vellum uses `#form/` only for a hashtag form root and
withholds the entire shadow for case/worker/search expansions, an HQ case root,
or a hashtag form path carrying a predicate or non-child step. A withheld shadow
contributes no declarations. The real attribute and an eligible shadow always
come from the same tree.

HQ JSON also carries the slot's interpolation mode: `none`, `case`, `no-case`,
`no-dots` or `enum-key`. The first two dot-interpolated modes (`case`, `no-case`) reject
self and parent steps. The `hq-case` root belongs only to `case` mode. Literal
values are protected from HQ's string replacements and instance regex without
changing their value: split interpolation tokens after `#`, instance-call text
after `instance`, and entity ampersands when Python's single HTML decode could
assemble an instance call. Numeric character references follow Python's
omission rules for invalid codepoints during hazard detection; they are never
decoded in the emitted value. After every split, an odd trailing backslash
becomes `substr('\\', 0, 1)` because HQ treats backslashes as lexical escapes
and Core does not. XML escaping belongs solely to `serializeXml`.

`enum-key` is the generated image mapping condition consumed by pinned HQ's
`MappingItem.key_as_condition`, which calls `dot_interpolate` directly. It keeps
the intentional self placeholder for the column's property, rejects parent
steps and the HQ case shortcut, and protects literal backslashes and instance
regex hazards. It leaves literal hashtags intact because this path performs no
hashtag replacement. Image alt variable identities hash this exact printed key.

Generated variables have explicit arms: claim `case_id`, selection `next_input`,
calculated detail values, enum labels, image alt labels, and endpoint argument
datums are suite-only. An endpoint argument must be one grammar-valid local
name and comes only from generated endpoint metadata. The HQ enum placeholder
is HQ-JSON-only. None is reachable from an authored expression.

## Reads of rows that may be empty

Core checks an absolute path before reading it (`XPathPathExpr.evalRaw` →
`DataInstance.hasTemplatePath`, predicates ignored), and an instance Core
builds from its data alone has no template: a lookup table, the flat place
list, the selected entities and the search answers. Their declarations carry
their root and row element names (`instances.ts`, `InstanceDecl.rows`), the
same constants Preview's instance builders build from. With no rows, `count`
of a path into one reads 0 and every value read throws. `casedb` and
`results:inline` read the case template and are never guarded. So
`emitExpression` lowers every expression for its consumer (`Use`): a value
read of such an instance, through its root element and then its row element,
prints `if(count(<root>/<row>) > 0, <read>, '')`; a read through any other
child of the root, or an attribute of it, is not a read of the rows and stays
bare.
With any row present the read answers as written, since `if` returns its
branch unconverted; with none it reads blank, which is also what Core reads
for a valid empty node-set (`XPathNodeset.unpack` →
`XPathPathExpr.unpackValue(null)`). `count`, and the branches of `if`,
`switch`, `coalesce` or a pass-through call that `count` reads, take the bare
path (`count('')` throws). A call's node-set arguments follow
`NODE_SET_ARGUMENT`: `join`, `concat`, `join-chunked`, `checklist`, `min`,
`max`, `distinct-values` and `index-of` take the `''` guard, which they read
as an empty set (`distinct-values` and `index-of` split `''` into no values,
`FunctionUtils.getSequence`). `weighted-checklist` reads its four-argument
pair as node-sets only when both are, so a guard on one set beside the other
would replace Core's answer with a computed one
(`emptyRows.ts::guardChecklistPair`): an `if` or `cond` in the pair moves the
call into its branches; two paths are guarded together, reading the call
over two `''` values, Core's answer for two empty sets, only when each set is
empty or over an instance with no rows, and as written otherwise; a path
beside a value Core never reads as a node-set takes the `''` guard, since Core
then reads the pair value by value; a path beside `coalesce`, `depend` or
`sleep` stays bare. Any other argument count reads every argument value by
value and takes the `''` guard. `sum` refuses
anything but a node-set, so its argument stays bare and the call is guarded
with `0` by `emptyRows.ts::guardNodeSetConsumer`, which follows the set
through pass-through calls: over `if` and `cond` the sum moves into each
branch, so each branch counts only its own rows; through `depend`, `sleep`
and `coalesce`'s last value it sums the rebuilt call. A `coalesce` hands on
its set only when every earlier value is blank, and otherwise returns the
first that is not, which `sum` refuses with or without rows, so behind one
the guard reads `0` only when the rows are missing and
`string(coalesce(<earlier values>, '')) = ''`. `position` keeps it bare,
since Core refuses `position` of an empty set too, and so does `depend`,
which never reads its later arguments. An itemset or repeat nodeset is
generated, never lowered here, and stays bare. So does the case owner moved
to a place (`owner-location-at-level`, marked `WirePath.refusesEmpty`): for a
worker assigned nowhere Core must refuse that read when the form opens, as
`proof/native/core/LocationOwnerRuntimeTest.java::missingDestinationRefusesTheSubmittedForm`
holds it, never write a blank owner or turn the case away after the worker
filled the form. So is a prompt read inside
CSQL text (`predicate/termEmitter.ts::emitSearchInputXPath`), which the
validator admits only inside a presence envelope whose `count` covers it.
Generated scaffolding that reads such an instance as a value guards it
itself: the several-case `join` of the chosen ids, which a batch form, a
nested child list's parent filter and its tile grouping all build with
`instances.ts::joinedSelectedCaseIds`. Zero
chosen cases is reachable through a session endpoint (Formplayer splits the
link's argument on commas), never through the list. A `<data nodeset>` over
the chosen cases is a `TreeReference` that Core expands
(`ListQueryData.getValues`), never checked by `XPathPathExpr`, so it stays bare.

A session read that can be absent (`window_width`, `applanguage`, the case
list's search text) prints `if(count(<read>) > 0, <read>, '')` for the same
reason (`emptyRows.ts::guardAbsentNode`). The search text counts its nodes and
reads the first, `if(count(P) > 0, P[1], '')`, since one Android case list can
leave its text on two frame steps, where a bare read throws.

A form read spelled absolute or as a hashtag prints `current()/<relative>`
(`formReads.ts::formReadToWire`) when it sits in a secondary instance's row
predicate (a `case`, `table` or `location` row, never a form repeat's, and
never a case operation's own case row) and crosses a repeat the slot is in, or
the repeat whose own slot it is. Core evaluates such a predicate in the bind's
context where it is a leading predicate on an indexed path
(`StorageBackedTreeRoot.tryBatchChildFetch`, `TreeUtilities.tryBatchChildFetch`)
and row by row otherwise (`EvaluationContext.expandReferenceAccumulator`),
where an absolute path contextualized against a row is cloned unbound and names
every entry of the repeat, which Core refuses or reads as the entry its reference
cache resolved first (`DataInstance.resolveReference`); `current()` is the
bind's node under both, so the relative read answers per entry wherever Core
evaluates it (`proof/native/core/RowPredicateCurrentRuntimeTest.java`). Every
other read keeps its bytes. The Vellum shadow follows from the printed tree: a
`current` path is no hashtag form read, so where the moved read was the
expression's only one, no `vellum:` shadow is written, and where another
hashtag form read remains, the shadow holds `current()/…` beside it.

## Instances and element slots

Every instance root holds the declaration from `instances.ts`. Serialization
returns precisely the set of roots it prints. An `InstanceSink` unions these
sets per actual evaluation scope, deduplicates by id, refuses conflicting
sources, and orders casedb, session, then the remaining ids by code unit.
Casedb does not imply a session dependency. A selected-case instance is declared
only when a printed tree reads it. Lookup declarations use the form or suite
identity chosen when the root is built.

`elementBuilders.ts::xel` accepts trees in its tag-specific `xpath` map and an
`InstanceSink`. It chooses constraint and shadow modes per attribute and omits
withheld shadows. `el` accepts only non-executable attributes; both its types
and its runtime guard reject known XPath slots. A stack query's URL, numeric
maximum-selection attribute and the presence-only repeat no-add/remove flag
remain raw XML values because Core does not evaluate them as XPath.

`formReads.ts` lowers field, repeat-row and generated-node identities through
one finite form-node graph and a target projection. Relative paths compare
that graph's coordinates; no stored parent-hop count or printed XPath enters
this boundary. A filter evaluates at its exact addressed step, while
`current()` retains the immutable source carrier. The earliest filtered shared
ancestor remains in the emitted path, so no predicate disappears in a common
prefix. Default-value emission anchors references at `current()`.

Case, lookup-table and location queries introduce lexical row scopes. Their
filters and projected row values cannot reuse an outer selected-case override;
legacy table lookups explicitly capture their containing case row. Projection
appends typed leaf steps, including the two-step case-index path. Choice UUIDs
resolve to saved values from the held document's option catalog.

A comparison goes through `fromExpression.ts::compareSides`, which asks
`lib/domain/expression/instantOperand.ts::comparisonPlan` whether a device runs
it between two moments, by day, or as written, and builds each side once per
spelling so `in`, `between` and `switch` share it. A lowered side is
`instant.ts::instantOperandWire`; `lib/commcare/xpath/CLAUDE.md`, "The instant
lowering", owns the parse.

Every authored form slot, including prose outputs and generated mixed
expressions, reaches `xel` as a `WireExpr`. There is no branded authored-text
bridge or secondary instance scanner.

The focused tests prove grammar structure, literal values, slot typing and
declaration sets. Native interpolation proof calls the pinned HQ helpers;
Core and the other proof readers decide executable compatibility.
