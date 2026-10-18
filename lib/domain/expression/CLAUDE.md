# Expressions

Every persisted expression slot holds `Expression`, the one recursive union in
`types.ts`. `Term` holds identity leaves; a leaf enters an ordinary operand through
`{ kind: "term", term }`. Some existing slots hold leaves directly, including
`within-distance.property`, `in.values`, and `switch.cases[].when`.
`ConditionArm`, `ValueArm`, and `InstanceArm` describe syntax subsets. They are
not alternative stored-slot schemas or declarations of runtime types.

`formLogicSchema`, `conditionSchema`, and `valueSchema` are distinct lazy schema
objects over that same union. They choose the authoring grammar and served
description. They do not narrow stored types; their distinct definition identities
are the authoring family's key. The condition and value wrappers retain the
`Predicate` and `ValueExpression` registry names used in served schemas.

The schema admits structural shape. `slotProfile` and the checker decide which
arms and meanings a particular slot admits. Form logic follows Core's coercions;
record positions retain their typed query contract. Never infer a stored slot's
profile from its expression's root kind.

## Identity and spelling

Fields, choices, repeat rows, session datums, lookup columns, and location
metadata carry domain identities. Case property identity is `(caseType, property)`;
relation identifiers remain name-backed. An untyped `prop` is allowed only for a
standard property and has no case-type/property rename edge. A custom property
always stores its resolved type. Worker sources distinguish session data from
the worker record. `datumRefKey` is the sole domain identity key for a datum.

`FieldSpelling` keeps hashtag (absent), absolute, relative, or current spelling.
There is no stored climb: Core contextualizes paths through repeats, and filtered
steps are what suppress that contextualization. `FormNodeRef` identifies logical
fields, query wrappers, generated repeat nodes, Connect nodes, roots, and repeat
attributes. `formNodeKey` is the sole identity key, including the node role.
`formNodes.ts` owns the graph; physical names come from wire projection callbacks.
No wire element names belong in the stored document.

A form step holds a nonempty predicate tuple. The optional filter tuple is itself
nonempty and contains each full form-node identity once. The checker establishes
root-to-target order and configuration existence. Generated-node paths use
relative/current spelling; ordinary repeat attributes retain all field spellings.
The form root has no filters. Every predicate is an `Expression`, since a numeric
predicate selects a position and must not be coerced to boolean.

Computed operand slots retain one literal spelling. A direct property remains
direct in match and multi-select subjects; a direct literal or choice remains
direct in multi-select values. Primitive pattern/distance/unit branches reject
only duplicate untyped literal wrappers. Literal annotations are never discarded.
A wrapped untyped `short`, `long`, or `iso` in a date pattern means those exact
bytes; the bare string retains its existing preset meaning.

## One traversal

`children.ts` enumerates every recursive edge, including direct leaves,
`switch.when`, relation paths, and form-path predicates. `CheckPath` is the stable
semantic address shared by the checker, source spans, and editor. A `term` wrapper
is transparent. Form filters use
`[...path, term.kind, "filters", filterIndex, "where", predicateIndex]`.
Use `walkExpression` for discovery and its convenience visitors for narrower
queries. Do not introduce a second generic recursive switch.

`mapExpressionAst` is pre-order and preserves untouched object identity. Returning
`undefined` or the same object descends; a distinct replacement owns its subtree
and stops descent. `mapTerm` returns a `Term`, including for direct leaf slots.
To replace a wrapped leaf with a compound expression, use `mapExpression` on its
`term` envelope. Constrained direct slots reject the wrong leaf kind. The mapper
preserves direct choice-to-literal replacements and canonicalizes only the approved
duplicate operand spellings. `mapExpressionChildren` maps immediate edges when a
consumer must select a lexical context before descending.

## Context and projection

`ExpressionSlotRef` is the canonical owner UUID, slot, and typed member identity.
Array indexes are never slot identities. `ProseSlotRef` extends context selection
without pretending prose is a stored expression. The reference-slot registry owns
stored access; `FormStructure.expressionAt` supplies the same read to a prepared
form without manufacturing a partial document. `slotContext` retains the actual
slot while lexical row and form-node context can change.

`printFormExpression` is a pure projection with occurrence spans and explicit
unresolved identities. `formStructure` and `formNodeGraph` supply domain topology.
CommCare names and wire function spelling are provided at the one-way emission
boundary. Text parsing belongs to the authoring grammar and always creates this
same tree; it never installs a second stored expression representation.

## Relations and reductions

Normalization operates on `{caseTypes, currentCaseType?}` projections, not invented
checker contexts. It gives one boolean test one related-row scope and leaves
scalar roots scalar. Explicit relation/count scopes, query rows, projected row
values, and form-path predicates are lexical boundaries. Numeric form predicates
stay numeric. A hidden current-case dependency (`case-index` or `case-row-type`)
prevents rebasing a sibling relation read to another row. Untouched expressions
retain identity so form emission's precomputed node overrides remain valid.
The optional replacement observer reports changed expression identities after
their children, including relation rebasing. Targets transfer identity-keyed
bindings through those reported replacements instead of matching AST structure.

Actual relation lowering uses the strict destination resolver and fails closed.
Historical reference discovery and rename repair are total: an unresolved relation
has no discovered destination, rather than a guessed syntax hint or an exception
that prevents repair. Property rename helpers require the authoritative catalog.

Construction reductions preserve boolean coercion: a singleton logical join of a
scalar becomes `not(not(value))`; a known condition can unwrap. Double negation
unwraps only a `ConditionArm`. Authored multi-clause joins remain as written.
`simplifyForEmission` is the separate record-emission simplifier, never an editor
normalization pass. Date search lowering is shared by the wire and Preview; dates
use calendar bounds and date-times use the established UTC half-open day interval.

## The semantic authority

`checkExpression(expression, slotContext)` is the one admission and type walk for
stored expressions. A caller obtains the context from `slotContext(doc, ref,
lookupTypes, {form?})`; missing optional source text does not erase a real slot.
Missing owners, member UUIDs, or configuration do. The optional `FormStructure`
is the authoring preparation's complete structural view, not a fake document.
Lookup types are a Project definition snapshot containing no row data.

`sourceNode` is the actual slot's immutable evaluation node. `contextNode` is the
lexical node used inside a form-step predicate. `rows` is an immutable scope
stack; only its top row binds a row leaf. A legacy `table-lookup` alone captures
an active case row for its predicate. A nested case query hides the outer table
row, and an ordinary `table-rows` query never captures one. Form-step predicates
rebind only their context node, retaining the original slot, source node,
profile, and entry supplies. `expressionContextAtPath` performs the same rebinding
for the editor's semantic path.

`typeOf` uses the same walk and cache without applying the slot's root expectation.
Its `NodeType` separates semantic `data`, Core's native `held` class, and optional
record identity `caseIdOf`. `scalarDataType` projects scalar data for consumers
that need it; row nodes and sequences have no scalar projection. Case-query row
typing follows an explicit record-type predicate or identity-bearing case-id
comparison. A custom property's qualifier never invents the query's row type.

A `RecordQueryContext` is the separate SQL/query inference boundary. It has only
catalog, binding, and lexical row facts, with no authored slot, native instance
root, source form node, profile, or supplies. Internal `inferRecordQuery` exposes
errors for writer inference and retained scalar rules. It is not an alternative
stored-slot admission entry point.

Form positions retain Core coercion and the existing time-ordering and literal
numeric refusals. Record positions retain the typed condition/value grammar,
scalar compatibility, relationship resolution, assignment representation rules,
and slot-specific availability. `ruleSets.ts` owns their scalar tables; editor
constraints read those tables rather than introducing another checker. Form
literals must have an exact supported spelling, and static choice defaults must
name a current choice. Numeric defaults use `numericAnswerText`'s native answer
spelling: Core's integer tolerance and signed-long conversion, then the shared
OpenJDK 17 formatter for decimal answers. The finding's value uses the same
spelling; JavaScript's `String(number)` is not the select's answer text. Shared
storage never admits a record-only expression in
form logic: a form count takes its filters inside the node-set, and a form row
property reads the current queried row without a record relation path. New form
table and location reads remain unavailable until
their complete emission and instance-declaration boundary ships; existing record
lookup and owner-location carriers, including a form choice filter, keep their
current admission. Later inference or target-admission work must not silently
change this shape cutover's retained scalar rules.

`entryDatumSupplies` owns domain entry identities. The checker admits a scalar
session datum only when that entry supplies that identity as scalar. A worker-record datum needs an active write; a `session-user` leaf
whose source is the worker record reads it directly and needs no such datum. Form-link datum names must occur
in the destination frame's supplies. Wire names remain in the entry projection.
`formLogicFindings` is a presentation projection of `CheckError`; the builder and
commit/export validator share it. Parser syntax failures are authoring errors,
never stored raw-XPath validation codes. There is no printed-source checker.
