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

Form positions keep Core's coercions and refuse only comparisons Core would
answer wrongly, one finding per comparison: a time ordered before or after
(`time-ordering`); a date against a date and time with no `date()` on either
side, an ordering of a date and time against a known value that is none, and
`true()`/`false()` against a known non-yes/no value (`incompatible-values`,
reasons `date-datetime`, `datetime-ordering` and `boolean`); then a provably
non-numeric literal in an ordering. A string literal opposite a typed operand
takes the type its ISO date, date-and-time or `HH:MM[:SS]` shape spells. Record
positions keep the typed condition/value grammar, scalar compatibility (a
date/datetime pair is `incompatible-values` reason `date-datetime`),
relationship resolution, assignment representation rules, and slot-specific
availability.

Both rule sets refuse a structural many: a read of a repeat's answer from outside
that repeat, across a step no filter narrows, or a `selected-cases` read, in a
position that needs one value (`many-values`, reason `repeat` or
`selected-cases`). Positions that take a node-set (`expressionFunctions.ts`'
`manyArguments`, a node-set profile or expectation) admit it; pass-through
positions (`if` branches, `coalesce`'s last, `switch` results) carry the mark
to their consumer. A date-and-time literal finer than a millisecond is
`datetime-literal-precision` in every profile; a `format-date` pattern that is
not one fixed CommCare pattern is `format-date-pattern-not-fixed` where the
profile targets the case store. `here()` is admitted only where the profile's
`here` fact holds, a case-list calculated column; elsewhere it is
`arm-unavailable` reason `here`. `choice-name` is unavailable everywhere, reason
`choice-name-dynamic` when the named question's choices are not inline. A
Hidden Value leaf reads inference's data type, held class and lost clock
(`inference.ts`); an untyped one is `_any` with its held class, so it holds no
opinion yet stays comparable. A date and time whose clock may be gone carries
`clockLost`, and an assignment of it to a date-and-time destination is
`expected-value` reason `clock-lost`.

`instantOperand.ts` is the one classification of a comparison over dates and
times, read by the checker and by the on-device emitter
(`lib/commcare/xpath/wire/fromExpression.ts`), so neither lowers or refuses
what the other does not. It classifies each operand by its leaves, recursing
into `if`, `coalesce` and `switch` branches (Core passes the chosen branch's
value through unchanged, so each branch keeps its own held representation),
and `comparisonPlan` says how a device runs the comparison: `lowered` (an
ordering with a moment on either side, an equality, `in` member or `switch`
case with a moment on one side and a moment or a value of unknown type on the
other), `day` (a `casedb` `date_opened` or
`last_modified` ordered against a day-aligned operand, or two system dates,
under any operator) or `bare`. A form literal leaf, a direct operand or a
branch of an `if`, `coalesce` or `switch`, takes the type its comparison gives
it (`comparisonOperands`, `formLiteralsShaped`), so a literal shaped as a date
and time ordered against one is folded like a record literal, to its integer
directly and to its canonical text as a branch. Wherever `toWire` prints the
expression (`onDeviceContext`): in a slot whose targets include `XF` or `SU`,
and in a value of a server search condition that a device works out before
the search runs (`searchRuntimeValues.ts`, the walk the CSQL emitter and its
validators share; `checkExpression` infers each such value again with
`runsOnDevice`), a `lowered` comparison with a leaf that has no instant text
is `incompatible-values`, one finding per comparison and none where it
already holds another: a `casedb` system date (`day-only-on-device`, with
`instant.comparison` and `instant.property`), a clock-lost value (`clock-lost`,
with `instant.field`), a date (`date-datetime`), a literal no spelling reads
(`unreadable-datetime`, by `literalInstantMicros`, the fold's own grammar,
which reads a four-digit year, a day that exists, a clock to 23:59:59 and an
offset's two-digit hours and minutes, and whose `literalInstantText` prints
any literal it reads in the literal's own date and offset), and a literal or a
branch of another known kind, or a branch of unknown type holding neither
text nor a typed date (`datetime-ordering`, or `datetime-equality` under `=` /
`!=`); a blank literal names no moment and is admitted. A `datetime-coerce` of
a literal that names no moment is `unreadable-datetime` in the same places,
since a device prints the moment as a value (`instant.ts::datetimeCoerceValue`).
`dayOnlyRefusalCopy` and `systemDateWhen` are the day-only sentences every
surface assembles, whose next step (`date()` on both sides) the checker
admits. An unknown operand against a moment takes the row of what it holds,
text or a typed date, in an ordering and an equality alike, so an untyped
Hidden Value holding a moment's text equals that moment in any spelling; two
unknown operands, or one against a value that names no moment (`x = ''`), stay
bare. A comparison a server search makes itself never lowers, so these never
fire there. CSQL text is a `CsqlNode` tree printed by
`lib/commcare/csql/print.ts`; a value the grammar cannot hold is a runtime
segment of device XPath, which is how `today()` reaches HQ's search as the
worker's day. Which subtree is which is one position function,
`csqlPositions.ts` (query, anchor, server value, raw argument, runtime), which
this checker reads for its position-dependent findings and the emitter and
the fold read through `lib/commcare/csql/positions.ts`. `ruleSets.ts` owns their scalar tables; editor
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
current admission.

`entryDatumSupplies` owns domain entry identities. The checker admits a scalar
session datum only when that entry supplies that identity as scalar. A worker-record datum needs an active write; a `session-user` leaf
whose source is the worker record reads it directly and needs no such datum. Form-link datum names must occur
in the destination frame's supplies. Wire names remain in the entry projection.
`formLogicFindings` is a presentation projection of `CheckError`; the builder and
commit/export validator share it. Parser syntax failures are authoring errors,
never stored raw-XPath validation codes. There is no printed-source checker.

## Non-obvious arm facts

- `in.values` and `switch` cases hold literals or `choice` leaves.
  `multi-select-contains` values admit computed values where the slot's profile
  admits them; where a device evaluates one, it must be a single choice, since a
  device tests the whole value as one choice.
- `switch` is the simple-CASE form (`on`, then `cases`), so the discriminator
  evaluates once per row at the Postgres target.
- `table-lookup` resolves one result column from the first authored-order row
  whose table-scoped predicate matches. Its stored table and column references
  are UUIDs; Preview and CommCare projection resolve current names only at their
  boundaries.
- Every leaf enters through the `term` arm, and `Term` has no expression arm.
  Row leaves read the row of the nearest enclosing row-scoped construct; a row
  leaf with no row in scope is the checker's `row-scope`.
- Custom worker information is `session-user-property { userPropertyUuid }`,
  stored by stable identity and resolved to its current slug only at Preview,
  SQL, or CommCare emission. `source: "worker-record"` reads the worker's own
  case (a form's `#user/`); no `source` reads session user data. The separate
  `session-user { field }` arm stays name-backed for CommCare-provided or
  external worker fields that have no Nova entity, and authoring never infers
  one arm from the other's text.
- A `via` of kind `self` collapses to the inner `where` (no identity join).
- `any-relation` is direction-agnostic: for the canonical `parent` index its
  possible destination types are the origin's parent UNION its direct children,
  and an omitted `ofCaseType` is valid only when that union has one member.
  Where the destination is exclusively the parent or exclusively a child,
  normalization materializes that proven direction. Remaining paths expand to
  `(<ancestor-form> or <subcase-form>)` in CSQL; Postgres compiles their two
  single-hop variants as a `unionAll`.
- `parent` is the only relation identifier the `CaseType.parent_type` graph can
  infer. Every custom saved index name needs an explicit `throughCaseType` /
  `ofCaseType`; never pretend a custom index follows the `parent_type` graph.
- `count(self)` is the cardinality of the current row: `1` without a filter, or
  `1`/`0` according to its `where`.

## Blank semantics: a locked invariant

`is-blank` is the one stored absence operator. It matches an absent or empty
value, including literals and calculated values. Zero, false and whitespace are
not blank. Device expressions compare a string projection; CSQL retains its
property-missing query semantics. No strict-absent arm exists for some targets
to widen.

## `matches-pattern`: one leaf, one runtime

`matches-pattern { left, pattern }` is JavaRosa's `regex(str, re)` and nothing
else: `Pattern.compile(re).matcher(str).find()`, so the pattern is Java
`Pattern` syntax and unanchored. CSQL has no regex function and Postgres's
regex dialect differs from Java's, so the leaf is admitted only where the
device alone evaluates it: the slot profile's `patternMatching`, true for a
Search prompt's `required.when` and `validation.rule` and false everywhere
else. `lib/commcare/csql/representability.ts` refuses it with
`pattern-match-not-csql`, the checker with `pattern-match-unavailable`, and
`walk.ts::expressionUsesPattern` is the reader Preview uses to route a
pattern-bearing constraint to the XPath worker. It is deliberately not the
automations' portable regex subset (`lib/domain/automations.ts`): that subset
exists because HQ runs those rules in Python, and this leaf never reaches
Python or Postgres.

## Record rules worth knowing

- Record slots keep condition and value positions as a rule: a value where a
  condition belongs, or a condition where a value belongs, is `record-position`
  (reasons `condition-expected` and `value-expected`). Form logic takes Core's
  coercions instead.
- Strings are excluded from `ORDERED_TYPES`: locale-dependent string ordering is
  rarely meaningful for a case-list filter, so `gt`/`lt` refuse text.
- A time of day is excluded too, and `time-ordering` is one rule for both rule
  sets, ahead of the ordered-types test; a date and a date and time keep their
  order.
- Property references inside a relational `where` resolve against the
  surrounding `via`'s destination scope, not the originating one.
- Lookup-aware callers supply a rows-free lookup index. A `table-lookup` checks
  its nested predicate under one table scope; `table-column` is legal only for
  that exact table. A field's lookup row filter is one explicit table-row scope:
  columns of that table, literals, worker and session values, and eligible
  earlier form fields. Case properties, Search inputs, later answers, and
  answers in a child or sibling repeat are absent from the context and so
  invalid.
- The checker is the gate every emitter trusts. Emitter code that reaches a
  state the checker should have refused throws; it never falls back to a
  default.

## Exact calendar-day search

A simple `date` search input in exact mode means the whole selected calendar
day, never string equality. CSQL and Preview/Postgres derive the same half-open
predicate through `dateSearch.ts::exactDateSearchPredicate`: a date property
uses `[date(day), date-add(date(day), 1 day))`; a date-and-time property uses
`[datetime(day), datetime-add(datetime(day), 1 day))`, a UTC day. This applies
to `date_opened` and `last_modified` as well, so standard and custom date-and-time
properties behave alike. For a related property both bounds live inside ONE
`exists(via, where: lower AND upper)`, so one related row satisfies both.

A `date-range` prompt is one indivisible `__range__<start>__<end>` value in
CommCare, so Preview keeps a partial picker state only as a draft and runs
nothing until both valid, ordered bounds exist. A date property keeps inclusive
`[start, end]` comparisons; a date-and-time property uses the UTC half-open
interval `[datetime(start), datetime-add(datetime(end), 1 day))`.
`dateSearch.ts::dateRangeSearchPredicate` owns that lowering beside exact-day
search.

## Relation-read target contracts

`normalizeRelationEvaluationScopes` is the shared semantic boundary before every
record target. A scalar condition leaf whose non-self properties all share
relation `R` becomes `exists(R, where: <the leaf rebased to self>)`, so its
property reads refer to the same related row; separate boolean leaves quantify
independently. Generic `between(prop(via), lower, upper)` becomes two
independent bound comparisons; a caller that needs one row to satisfy both
bounds writes `exists(via, where: between(prop(self), …))`, which the exact-day
and date-range helpers build. The normalizer fails closed when one scalar leaf
mixes self and related properties, combines two relation scopes, or combines an
outer related read with an anchor-sensitive nested quantifier; the module
validator surfaces the repair before an emitter reaches the exception.

On a device, `exists` and `missing` never compare two node-sets: Core does not
implement XPath general node-set equality, and nested `current()` still points
at the listed case. The emitter uses guarded immediate-scope membership
(`lib/commcare/xpath/wire/rowScope.ts::immediateRelationPresence`:
`count(index/<relationship>) > 0 and selected(join(' ', <candidate ids>),
index/<relationship>)`) at every level; the guard is required because Core
treats `selected('', '')` as true. CSQL then runs
`normalizeRelationReads.ts::normalizeRelationPropertyReads` only as a grammar
adapter. Postgres consumes the same normalized tree and rejects any non-self
property read that survives normalization; it never invents `LIMIT 1`,
pairwise node-set, or cross-product semantics.

## JSON Schema generator

`jsonSchema.ts::caseTypeToJsonSchema` feeds the case store's write-time AJV
validator. Properties without a declared `data_type` default to
`{ type: "string" }`. `int` is bounded to int4's signed 32-bit range so AJV's
acceptance set matches the Postgres `::integer` cast. Select values validate as
plain strings, never an option enum: the write path validates the merged row,
so an enum would turn every option edit into a row poisoner.

## Named tool-schema definitions

The union and its reused members carry registered ids (`z.globalRegistry.add`,
end of `types.ts`), so a `z.toJSONSchema` caller extracts each once into
`definitions` under a stable name and `$ref`s it at every use site. The ids
`Predicate` and `ValueExpression` name `conditionSchema` and `valueSchema`;
`formLogicSchema` is unregistered. The authoring projection
(`lib/agent/authoring/schema.ts::authoringJsonSchema`) substitutes each family
position with its authored string schema and keeps the family's id, so a served
tool schema names `Predicate` and `ValueExpression` definitions while their
canonical structure never reaches it.
Register via `globalRegistry.add` (attaches in place), never `.meta()`.

## Two simplification layers, opposite contracts

Construction-time reduction (`reduction.ts`: `reduceAnd` / `reduceOr` /
`reduceNot`) is scoped to empty, single-clause and double-negation lists;
multi-clause lists stay as written, because a multi-clause `and` holding
`match-all` is a meaningful editing state. Emission-time simplification
(`simplify.ts::simplifyForEmission`) drops every boolean identity at every
depth, recursing through every nested condition position (`count.where`,
`if.cond`, every `where`). Never call it from the construction or doc layer.

`effectiveFilterForEmission` simplifies a `caseListConfig.filter` and folds an
all-true result to `undefined`; it is the single home of "match-all means no
filter", so "does this filter narrow anything?" and "what do we emit?" never
disagree. `displayConditionForEmission` does not simplify: a display condition
is held as written, absent only when it is absent or its root is `match-all`.
A condition that is `match-none`, or an `and` whose first clause is, would print
the hidden flag's spelling, so the validator refuses it
(`displayConditionStartsWithNever`).

## Wire-emission boundary

Every target consumes this one union from outside the package:
`lib/commcare/xpath/wire`'s `toWire` (XForm, Vellum shadow, suite, HQ JSON and
Preview modes), CSQL (`lib/commcare/csql`), and Postgres via
`lib/case-store/sql`. Each first takes the same relation-scope normalization,
then applies only its own grammar and runtime restrictions.

## Barrel

`index.ts` re-exports each public module wholesale via `export *`, so a new
helper needs no parallel barrel edit. No shim remains at the old `predicate/` or
`xpath/` paths.
