# Complex app plan

Nova's plan for building complex CommCare apps: lookup tables, display
conditions, case operations, case tiles, media capture, users and locations,
automations, and HQ deployment.

This is the only planning document for that program. It describes the system as
it is today and indexes the work that remains. Its primary sources are the two
research memos in `docs/research/` — `advanced-case-actions.md` and
`commcare-locations.md` — which stay as evidence; where a memo and this document
disagree, this document wins. It carries no history: what shipped, when, in which
PR, and against which revision lives in git. When behavior changes, this file
changes with it in the same PR.

Every CommCare citation uses stable names (`file::function`), never line numbers
— upstream lines rot silently.

---

## How to use this plan

The program spans three kinds of file, and each answers exactly one question:

| File | Answers |
| --- | --- |
| this one | what Nova builds today, and which unit owns what remains |
| [`complex-app/00-contracts.md`](complex-app/00-contracts.md) | the delivery, product, architecture, and UX rules that bind every unit |
| `complex-app/NN-*.md` | one remaining unit: its contract, its binding CommCare facts, what a user observes |

Three rules govern reading them, in order:

- **Open the unit's file before you touch the unit.** The entries under
  [What remains](#what-remains) route you to a file; they do not brief you on it.
  Each one deliberately omits every binding fact, wire contract, and design fence
  the unit rests on — so planning, estimating, implementing, or answering a
  question from an index entry alone produces a confident wrong answer. The
  omitted facts are exactly the ones that decide the shape of the work.
- **Read the contracts file alongside it.** The rules there are stated once and
  never repeated in a unit file. A unit implemented without them will pass its own
  acceptance and still violate the program — a version floor, a draft state, a
  silently adopted remote resource, or a workspace masquerading as app content.
- **Re-verify every CommCare claim in source before you rely on it.** The facts
  recorded here were verified against the Dimagi checkouts at the time they were
  written; upstream moves. Each carries its `file::function` so it can be
  re-verified — never restate one from memory, and never soften one you could not
  re-find.

For shipped behavior, [What is built](#what-is-built) states what exists and why
it takes the shape it does; the code and the nearest subtree `CLAUDE.md` remain
authoritative for how.

---

## What is built

### Lookup tables

Lookup tables are Project-scoped app-state data with stable table, column, and row
UUIDs, typed values, fractional row ordering, raw CSV replacement, exact Postgres
byte accounting, optimistic table revisions, and a Project-wide realtime
invalidation clock. `lib/lookup` is the sole persistence boundary and speaks Nova
vocabulary only; `lib/lookup/CLAUDE.md` is its contract.

Caps are 5,000 rows and 8 MiB per table, measured as exact Postgres bytes rather
than estimated. These bound what a client can be asked to load, which is what
makes client-side choice evaluation viable.

Table schema governance — deleting a table, removing a column, retyping a column —
lives in `lib/lookup/schemaGovernance.ts::applyLookupSchemaGovernanceInTransaction`.
Each requires the `delete` capability and zero applicable reference edges, proved
transactionally rather than by scan, and reaches authors through the three
governed actions in `lib/lookup/actions.ts`.

### The Project data workspace

Project data is a URL-owned builder workspace at
`/build/{appId}/project-data[/{tableId}]`, reachable from the expanded structure
sidebar's footer, the collapsed rail's footer, and therefore the handset
structure drawer. It is deliberately not a child of the structure tree: the tree
represents the runnable app, and a lookup table belongs to the Project and is
shared by every app in it. The `Location` kind carries no `moduleUuid` at all, so
every module-keyed helper branches on it explicitly and the boundary is enforced
by the compiler rather than by convention. `project-data` is a reserved first
path segment matched before any uuid lookup; the location names no blueprint
entity, so it is always valid and always survives recovery, and the workspace
itself owns the "that table is gone" state. Preview from the workspace leaves for
the app home — nobody using the app opens a lookup table. Every screen states
that a change affects every app in the Project, as a permanent subtitle rather
than a dismissible notice, because a deep link never passes the door.

The controller (`ProjectDataWorkspaceProvider`, mounted above the builder row)
owns one read plus scope-keyed selections, dirty row drafts, and conflicts,
shared by the centre canvas and the inspector rail. Closing Properties, Escape,
selecting another row or column, and leaving the table only hide an edit; they
never discard it. A retained draft is marked in the grid, while the table list's
**Row work to review** section links to every retained draft or conflict across
the Project — including a pristine save/delete conflict and work whose table was
deleted while another route was open. If realtime removes its row, the recovery
surface offers Save as new; if the whole table disappears, the last authorized
table/column snapshot becomes a read-only local row copy whose only destructive
choice says **Discard local copy**. Same-named recreation does not rebind it:
table UUID is identity. A user who loses edit access still sees copyable
read-only retained values and can explicitly discard the local copy. Close and
Escape return focus to the exact stable row/column control that opened
Properties across desktop, narrow, and handset layouts, with the table's back
control as the fallback when a peer removed that origin.

Reads are generation-keyed on the reconciler runtime scope, the Project scope
epoch, and the Project lookup clock, so a co-member's edit refetches exactly
what it changed and a cross-Project move invalidates everything; the pushed
manifest is the invalidation signal rather than the data, because a session
with a dormant reconciler receives no frames and must still load. The render
path also fences the resource's Project/table owner synchronously, before the
dependency effect, so direct navigation and browser history never paint the
previous table's snapshot under the new URL.

**Editing is row-shaped.** The grid is a real `<table>` in pages of 50 with a
search box over the text it displays — paging keeps native row and column header
semantics that a virtualized ARIA grid would have to hand-roll, and the running
case list already pages at 50. A selected row opens in the rail, where each value
gets the control its type deserves; bulk change goes through CSV replacement.
That also makes the unit of concurrency the row, which is the unit `lib/lookup`'s
row API and its optimistic revisions already work in.

**The conflict policy is the reason the row is the unit.** A table's optimistic
token is `max(definitionRevision, rowsRevision)`, so any concurrent change
invalidates it — including one to a row nobody in this session touched. Retrying
every drift would let one author overwrite a co-member's edit to the same row;
asking about every drift would put a dialog in front of edits that do not
conflict. So a refused write re-reads the table and
`projectDataModel.ts::rowWriteConflictVerdict` retries only when the fresh state
proves the edit is still the same edit — byte-identical row AND unmoved column
definitions, compared with the immutable row/column/revision baseline captured
when editing began rather than a realtime-refreshed snapshot. Otherwise the
resolution surface is rebuilt against the exact fresh generation the author
reviews. Current columns are editable with their current types, new columns are
present, and retyped values must pass the new control. Values from removed
columns remain separately visible and cannot be silently submitted: the author
copies what they need and explicitly acknowledges that those values have
nowhere to be stored before Keep mine or Save as new enables. A row deleted
underneath is its own verdict and offers the retained draft as a new row; the
returned row id is selected and revealed on its page.

CSV selection is one atomic value carrying the File, copied bytes, filename,
row count, checked schema, Project/table identity, and optimistic revisions.
Last-started file read wins. Any later definition or row-generation drift
disables replacement until the same bytes are checked and explicitly confirmed
against the current table. `replacementConflictVerdict` is unconditionally
"ask": a replacement discards every row by definition, so it never retries
against a moving target. The draft survives every branch.

Text edits preserve empty strings, surrounding whitespace, line breaks, and
missing-cell identity, including in conflict comparisons. Temporal controls
project strict timezone-bearing stored values — including fractional seconds —
into human clock/date controls while retaining the exact offset and stored
spelling for an unchanged round trip; typing away and back to the original clock
is still an unchanged round trip. A new temporal value uses UTC because Nova has
no authored app timezone. Table and column naming drafts capture their optimistic
generation: pristine drafts follow realtime changes, while dirty drift requires
an explicit use-current/keep-mine decision. Table export tags render on the list
and detail screens and are admin-editable through the same policy as established
wire names.

The options-source picker reads a rows-free definition snapshot, never a full
table body. Its optimistic context remains unavailable until the current
Project, manifest Project, definition Project, Project revision, table id, and
definition revision all agree. Equal Project revisions make a double omission a
real deletion; independently settled mismatches fail with **Try again**, whose
gesture reloads both resources, rather than staying on Loading forever or
masquerading as an empty/deleted list. A failed table-list read also keeps the
closed picker neutral instead of labelling the saved table deleted.

**A destructive change names the apps it would break, before it happens.**
`lib/db/lookupReferenceEdges.ts::readLookupReferencingApps` joins the edge tables
to `apps` for names; a soft-deleted app still holds its edges and still blocks
the change, so it is named with its trashed state rather than omitted. That read
is advisory by construction — a scan races a concurrent app commit — and the
transactional edge check under the table lock remains the authority; a refusal
resolves its own returned app-id set to the same named shape, so the warning and
the refusal cannot disagree. Naming leaks nothing: every edge for a
`(project_id, table_id)` belongs to an app in the Project the caller was already
authorized against.

The advisory preflight fails closed: loading, named success, and error-with-retry
are distinct states. A failed reference query never becomes an empty blocker
list and never enables the governed action. If the transactional writer proves
a reference exists but the secondary app-name lookup fails, that unnamed
reference remains an authoritative block and **Check references again** reruns
the advisory scan; the UI never contradicts the refusal with “No app uses it.”
An optimistic refusal refreshes the table generation and reruns the advisory
scan before the author can confirm again; the governed write never repeats
against its stale captured revision.

Create-table and add-column dialogs own their in-flight gesture. Escape, outside
press, and Cancel cannot dismiss while the write is pending; transport rejection
renders in the dialog; and an authority-driven unmount or Project switch cannot
later close, refresh, or navigate a different Project from a stale completion.
Create-table freezes the Project identity it opened under. CSV file selection
clears the native input after capturing the `File`, so the same path can be
chosen again after a read failure, and capped diagnostic lists report the count
hidden after the eight entries actually rendered.

Cap refusals name the size that was actually measured — an oversized CSV reports
its own size, one over the row cap reports its exact row count and how many rows
to remove — through one formatter (`lib/lookup/format.ts`) shared by the service,
the CSV route, and the workspace.

`content/docs/project-data.mdx` is the user-facing guide.

### Exact reference edges

Every app carries an exact, transactional edge set naming the lookup tables and
columns its blueprint references (`lib/db/lookupReferenceEdges.ts`). Composite
foreign keys make a referenced table undeletable and a referencing app unmovable;
`lib/db/apps.ts::repairLookupReferenceEdges` rederives the set from the committed
blueprint without touching history or the mutation sequence, and
`scripts/scan-lookup-reference-edges.ts` reports mismatches read-only.

Edges are derived state. Any authoritative commit reconciles them completely, so
an unrelated edit to an app with stale edges converges them.

### Display conditions

Modules and forms carry a typed `Predicate` display condition, validated by
`lib/commcare/validator/rules/displayConditions.ts` and emitted through
`lib/commcare/suite/displayConditions.ts`.

The validator's restrictions are wire-forced, not stylistic:

- A relevancy expression that throws at render takes down the **entire** Web Apps
  menu screen, not just the offending item — `MenuLoader::getMenuDisplayables`
  catches and `MenuScreen::init` rethrows at screen level. Every condition is
  therefore boolean by construction and checker-gated.
- HQ rejects any casedb reference in a form filter whose module does not
  guarantee a selected case (`menus.py`, via `xpath_references_case` after
  interpolation). Module filters skip that check but hard-reject `#case`,
  `#parent`, `#host`, **and** bare-dot case shorthand
  (`app_manager/xpath.py::_ensure_no_case_references`), so an emitted module
  filter must be dot-free as well as hashtag-free.
- Counts, `exists`/`missing`, and non-self reads are refused.

The form-condition evaluation locus for a case-first module is the case-list
screen after selection — including suppressing the single-form auto-continue. The
module screen's form list is a gating site only for the forms-first flow, where
the validator already rejects `prop` reads.

Display conditions are UX, not access control: a deep link with
`respect-relevancy="false"` traverses menus and cases that conditions would hide.
The authoring surfaces say so in as many words rather than letting an author read
a condition as a permission.

Each carrier is authored on its own URL — `/{moduleUuid}/condition` and
`/{formUuid}/condition` — whose centre-canvas screen leads with where the
condition takes effect and then hosts the shared `PredicateWorkbench`. The module
and form settings panels own the setting itself: a plain-language summary plus
Add / Edit / Clear, through the shared `ConditionSlotSetting`. Adding is one
gesture that commits a valid seed and opens the editor on it, so an author never
lands on an empty screen.

The evaluation locus above is a product requirement, not just a validator rule,
because it decides what the editor may offer. `CaseDataScope` therefore has three
values: `per-case` (case rows and their relatives), `selected-case` (one chosen
case's own properties — relationship walks, relationship counts, and presence
tests are withheld with the scope's own explanation), and `global` (no case at
all). A module condition and a forms-first form condition are `global`; a
case-first form condition is `selected-case`. `PredicateEditProvider` composes
the matching admission oracle in front of any caller oracle, so no surface can
silently offer a read the commit gate would reject.

A second, independent axis governs **Never match**. `DISPLAY_CONDITION_ALWAYS_FALSE`
refuses a navigation condition nobody could satisfy, so the editor withholds
`match-none` there — but the same shape is legitimate authored data in the
Search-action carrier, which shares the `global` scope. `allowsNeverMatch`
therefore stands apart from `CaseDataScope`, defaults to allowed, and governs
exactly one kind; reading it off the scope would have made an existing document
uneditable. A saved `match-none` always renders and re-emits: the flag governs
the add and replace menus, never round-tripping.

Every *single* choice these editors offer is admissible, but "can never match" is
a property of the whole tree — an author can still compose one deliberately by
excluding an always-true rule. The condition canvas therefore commits through the
inline gate flavor and shows a refusal beside the rule, rather than a toast over
a silently reverted edit.

Preview from a condition URL runs the surface the condition governs — the home
screen for a module (entering the module would route straight past the screen the
condition decides), the form itself for a form — and leaves the URL alone, so
exiting Preview returns to the condition being edited.

Removing a condition is an explicit `null` on the `updateModule` / `updateForm`
patch (`lib/doc/displayConditionMutations.ts`), never an omitted key. The
reducers delete on either spelling, so the distinction bites only where a
mutation object is itself the durable event — the SSE frame and the persisted
jsonb are both `JSON.stringify`, which drops an `undefined`-valued key and turns
a clear into "no change". The builder persists a document diff instead, and
`diffDocsToMutations` reaches the same `null` independently; the planners keep
the mutation correct on its own so a durable emitter inherits the right spelling
rather than rediscovering it.

`content/docs/display-conditions.mdx` is the user-facing guide.

### Case operations

Forms carry ordered case operations — create, update, close, with links, renames,
retypes, and owner assignment — validated by
`lib/commcare/validator/rules/caseOperations.ts` and emitted by
`lib/commcare/xform/caseOps.ts`.

Facet legality by action is closed and enforced: `create` requires a new target
and a name and forbids rename/retype; `update` forbids a new target and a name;
`close` forbids a new target, name, owner, rename, retype, **and** links — so
unlinking is always a separate operation from closing, while close may still
carry final property writes.

Reserved case types are `commcare-user`, `commcare-case-claim`, and
`user-owner-mapping-case`. Reserved write properties are
`lib/commcare/constants.ts::RESERVED_CASE_PROPERTIES` — HQ's authoring-side
case-reserved-words list plus `name` and `owner_id` — extended with
`location_id`, `hq_user_id`, `external_id`, `category`, and `state`.

`category` and `state` are reserved because the two runtimes disagree about
them. `case_type`, `case_name`, `owner_id`, `external_id`, `user_id`, and
`date_opened` land in the same dedicated slot on both sides
(`CaseXmlParser::updateCase` and `parser.py::CaseActionBase.V2_PROPERTY_MAPPING`),
but `category` and `state` have dedicated client setters and no server mapping at
all, so the same block sets a reserved slot on the device and an ordinary dynamic
property on HQ. A property that means two different things cannot be authored.

The emitter is total by structural construction, and four wire facts force its
shape:

- A case block with **no** `@case_id` is silently skipped server-side
  (`casexml/apps/case/xform.py::has_case_id` gates `_extract_case_blocks`), so the
  write vanishes with no signal. Guaranteeing `@case_id` structurally is
  mandatory, and the failure mode it prevents is data loss, not an error.
- An index-only block whose own case is locally absent NPEs the client:
  `CaseXmlParser`'s index arm calls `loadCase(errorIfMissing=false)` and
  dereferences unguarded. Pairing every non-create block with an `<update/>` (its
  writes, or an idempotent `case_type`) routes through
  `loadCase(errorIfMissing=true)` and yields a clean readable error instead. An
  empty `<update/>` is a no-op on both runtimes. Attachment-carrying blocks share
  the same null-deref shape and the same guard.
- `<create>` accepts only `case_type`, `case_name`, and `owner_id` children and
  rejects extras, so any additional create-time property write emits in the
  sibling `<update>` of the same block.
- Metadata binds are `@date_modified ← /data/meta/timeEnd` and
  `@user_id ← /data/meta/userID`. The meta block exists post-render on both export
  paths, so source-level binds referencing it are safe.

HQ's render pipeline preserves hand-authored case blocks: `FormBase.render_xform`
wraps the stored source and `xform.py::XForm._create_casexml` only appends
FormActions-driven blocks, with its single collision guard reading the direct
`/data/case` child. Operations therefore ride the XForm source on both export
paths, at nested container paths, never at bare `/data/case`.

Authored case ids follow Vellum's repeat-context split: creates outside a repeat
seed `@case_id` via `<setvalue event="xforms-ready">`, while creates under a
repeat use a bind calculate over the per-instance path. Generated UUIDs take the
setvalue path; authored deterministic keys stay live calculate binds.

An owner expression's result lands verbatim and unvalidated in the case block —
the only server-side check is length ≤ 255. Typed owner addressing is entirely
Nova's guarantee.

Operations are authored on the form's own URL — `/{formUuid}/operations`, with
`/{operationUuid}` selecting one — reached from the form settings panel, whose
row states how many changes the form makes. The list is the answer to "what does
submitting this form do to the case universe?", the question the platform's own
question-scoped surface never puts on a screen: one row per change, in execution
order, each a sentence (`operationSentence.ts`, a display projection that forks
no semantics). A row shows the conditions it inherits from earlier changes at
rest, not on hover.

**Both reorder gestures read one map.** `caseOperationMoveVerdicts`
(`lib/doc/caseOperationReview.ts`) asks the move planner about every destination
at once; drag feeds it to `useReorderableList`'s `canDropAtIndex` — capturing the
source on the handle's pointer-down, so the first pointer move is already gated —
and the keyboard asks the same map before committing. Neither gesture can commit
what the other would refuse, and `view.move` re-plans from the invocation-time
document so a peer edit mid-gesture cannot slip one through. The move mutation
names the operation this one now follows.

**An anchor cannot be shifted by a peer's insert**, which is what removed a
whole layer here. A fractional key named an ABSOLUTE position, so a peer
inserting above the destination moved it out from under the author — hence a
requested-rank fence on the mutation, an authoritative check that the key still
landed where the author asked, and a ranked-move planner that re-keyed tied
siblings to open a gap a single key could not reach. Sequence is array position
now: the move says "after this one", the reducer splices, and a peer's insert
simply lands somewhere else in the same list. There is no rank to fence, no gap
to open, and no tie to break. Successful pointer, keyboard, SA, and MCP outcomes
all report the rank in the committed document. Moving to the rank the operation
already occupies is a true no-op: it reports that rank without persisting an
event or adding undo history. A refused keyboard
move ANNOUNCES why and names the operations involved (`keyboardMove.ts`), which
is the whole point:
a pointer author reads a refusal off a drop zone that will not open, and a
keyboard author would otherwise get a key that silently does nothing. Refusals
go to `role="alert"` (the screen is otherwise unchanged, so the press would read
as a no-op) and the polite region carries only outcomes that did something.
`dependent-reference` and `execution-order` stay distinct: the second is a
property of the submitted form, not the author's mistake, and never says
otherwise. A dependency refusal additionally carries WHICH kind it is —
`reference` for an `id-of` edge, `target-type` for a dependent left acting on a
type the move or removal would stop establishing. The planner's refusal arm is a
discriminated split rather than an optional field, so a dependency refusal with
no cause is un-constructible: the copy layer reads the cause instead of
re-deriving it by walking `id-of` edges, which is how a target-type refusal used
to name an unrelated create the operation was already after. A target-type
sentence claims no direction, because a retype moved either way can leave a
neighbour mistyped.

The rail owns the discrete choices — name, action, case type, target, identity
key, multiplicity, retype, removal — and the centre canvas owns every recursive
AST, the same split the case-list workspace keeps. Adding is chooser-first and
lands a complete operation the commit gate already accepts
(`components/builder/case-operations/seeds.ts`, proved against
`mutationCommitVerdict`). Existing-operation choices ask
`caseOperationEditVerdict` — the real mutation planner plus that same commit
gate — before they are offered. Changing a create into an update/close retargets
both the case identity and its proven rolling type; case-type, retype, link-type,
identity-key, and multiplicity pickers disable every impossible choice
with the gate's exact reason, and omit the three platform-owned types
everywhere. Removal asks `removalPlan` first and, when something depends on the
operation, names each consumer and the exact slot holding the reference instead
of offering a delete that would bounce. Viewer mode renders these controls as
explicit disabled triggers. Choosing the already-active target is also a true
no-op; a keyed new target retains `idFrom`, and an expression target retains its
exact AST rather than being replaced by that choice's creation seed.
Link targets use the same atomic-intent rule: choosing the session case or a
prior create carries the type established by all earlier retypes in the same
edit, unlinking stores the required `target: null` without clearing or
overwriting peer facets, and a runtime-expression target immediately mounts the
full text-scoped expression editor beneath the picker. A blank or inaccessible
runtime id stays repairable as authored expression state, but Preview/device
submission refuses the complete transaction before any case effect executes.

Which form answers an operation may read is ONE rule with two callers:
`lib/domain/caseOperationScope.ts` holds `operationCanReadFormField` and
`formFieldCanKeyCreate`, the validator calls them, and the answer pickers apply
them — so the offered set cannot drift from the accepted set. `field` terms,
`acting-user`, `unowned`, and `id-of` become authorable in the shared expression
editor only when a surface supplies `formFields` / `operationScope`; absent means
unauthorable, which is what keeps every other surface's round-trip-only behavior
exactly as it was (`operationScopeFailsClosed.test.ts` pins it).

The same vocabulary is authorable through the Solutions Architect and MCP.
`getCaseOperations`/`get_case_operations` projects the ordered sequence with
operation ids and form-field paths; batch add plus singular update, move, and
remove use those same author identities and cross to immutable UUID leaves
before checking. Batch add resolves earlier creates within its working overlay
and commits the complete sequence atomically. Full-shape updates emit only
identity-keyed scalar, write-property, link-identifier, and order mutations, so
unrelated concurrent edits compose. Builder full-shape edits additionally
rebase only the slots changed from their render snapshot onto the
invocation-time operation; peer-deleted targets and same-key write/link adds
fail before local state changes. Each non-order granular event carries the
deployed full-operation `caseOperationChange.update.value` as the
immediate-parent fallback and its current intent in top-level
`caseOperationPatch`; an ordinary move uses the deployed carrier-blind
`caseOperationChange.move` as its exact fallback. Current reducers apply only
the intent, immediate-parent reducers apply the equivalent fallback, and
immediate-parent events still replay with their established semantics. Schema
integrity binds both views to one UUID and value. The authoritative commit guard
tracks operation UUIDs, requested move ranks, and write-property/link-identifier
sets through the batch, rejecting peer-deleted targets, shifted destinations,
and same-key peer adds instead of allowing a total reducer no-op to report
success.

The operation id, write property, and link identifier vocabularies share their
validator-owned grammar with the builder and tool schemas: ASCII letters,
digits, and underscores only; an operation id or link identifier starts with a
letter or underscore, and a write property starts with a letter. Action-illegal
facet combinations, platform-owned case types, and reserved write properties
are unconstructible at the shared tool boundary, with the validator as the
replay/import backstop. Case types separately admit hyphens, so chooser-created
operation ids normalize each hyphen to an underscore for every create, update,
and close seed before the first commit.

Lookup-backed predicates and expressions already persisted on a case operation
remain preserved. The builder keeps the operation visible and movable but
renders both the rail and recursive canvas persistently read-only, with the
reason, until lookup authoring owns those slots. The carrier inventory is the
single exhaustive oracle. `getCaseOperations` and `getForm` preserve the full
ordered operation sequence: each carrier-bearing operation keeps its author id,
action, and case type plus
`unavailable: { kind: "lookup-table-logic", reason }`, while every lookup AST
detail is withheld. The id remains addressable by `moveCaseOperation`, so the
operation can move without a partial read ever posing as an editable shape.
Builder edits refuse before dispatching local state, full-shape SA/MCP updates
and removals refuse, and moves stay persistable because their deployed fallback
carries only UUID plus order.

`content/docs/case-changes.mdx` is the user-facing guide.

### Case identity storage

The whole case-identity family — `cases.case_id`, `cases.parent_case_id`,
`case_indices.{case_id,ancestor_id}`, and `parked_case_values.case_id` — is
`text`, because case ids are opaque CommCare wire identities rather than
intrinsically UUIDs. Nova-generated ids default to `uuidv7()::text`. Because ids
carry no time order, the durable default ordering is `(opened_on, case_id)`
ascending. `lib/case-store/CLAUDE.md` holds the detail;
`scripts/scan-case-id-storage.ts` is the durable read-only pre/post scan for the
family.

Client-side, `CaseXmlParser::parse` and `CaseXmlParserUtil::validateMandatoryProperty`
reject only null/empty, and `case_id` is deliberately absent from
`checkForMaxLength`; HQ bounds it by `CommCareCase.case_id` at 255 characters.

### Lookup carriers, table expressions, and itemsets

Selects take a lookup `optionsSource`, and expressions take `table-lookup` value
terms and `table-column` comparison terms
(`lib/commcare/validator/rules/lookupOptionsSource.ts`, `lib/doc/lookupReferences.ts`).
The builder binds one in the select's own editor (`OptionsSourceEditor`).

**That switch is asymmetric, and the asymmetry is its correctness.**
`optionsSource` precedence is presence-based at every consumer —
`lib/commcare/xform/builder.ts` branches on `optionsSource !== undefined`, as does
the preview's choice evaluation. Inline → Table merely SETS the source, and the
inline options stay as the origin-compatible fallback a pre-S05 receiver reads
and a duplicate reverts to. Table → Inline must CLEAR it, or the retained source
keeps winning while the editor claims the field is back on its typed-in list.
The clear is an explicit `null`, for the same reason a display condition's is:
the reducer deletes on either spelling, but the SSE frame and the persisted jsonb
are both `JSON.stringify`, which drops an `undefined`-valued key.
`lib/doc/lookupOptionsSourceMutations.ts` makes the mutation object correct on its
own so a durable emitter inherits the spelling, and its test asserts the clear
survives a real round trip rather than only applying in memory.

The local `.ccz` emits the preservable lookup wire. The binding facts:

- A suite-embedded `<fixture>` may sit at any position, requires `id`, stores as
  global when `user_id` is absent, holds exactly one body element, and is
  overwritten on app upgrade (`SuiteParser`, `FixtureXmlParser`).
- `ItemListsProvider` expects the id `item-list:<tag>`, a `<{tag}_list>` wrapper,
  `<{tag}>` rows, and **every** defined field as a child element in definition
  order — an empty element for a missing value. Instances reference
  `jr://fixture/item-list:<tag>` (`generic_fixture_instances`).
- `XFormParser.parseItemset` requires `nodeset` plus `<label ref>` and
  `<value ref>`, and rejects literal items beside an itemset.
- `ItemSetUtils.populateDynamicChoices` resolves the nodeset by declared id, a
  missing one throwing a runtime `XPathException`, and evaluates the predicate
  with `current()` bound to the question node contextualized to the current
  repeat iteration.
- Decimal cells emit exponent-free. Relation tests inside a fixture-row `where`
  anchor on the containing slot's case. `rootCaseId` is honored. An escaped
  column name is a typed rejection (`lookup-row-escaped-column`), never a
  silently mangled emission.

JavaRosa has no XPath-1.0 first-node coercion — a scalar use of a multi-node path
throws (`XPathNodeset::unpack`) — and JavaRosa numeric predicates are **position**
matches, not value matches. First-match lowering therefore carries an explicit
positional `[1]` predicate structurally; coercion will never supply it.

The aggregate embedded-fixture budget is 10,000 rows, 100,000 cells, and 16 MiB of
exact UTF-8 fixture bytes. These are declared Nova policy sized against an
unindexed runtime that materializes XML as object-heavy `TreeElement` nodes; the
cell cap is what bounds that cardinality.

Lookup references execute in the preview but have no wire spelling on the HQ
paths yet, so `lib/export/boundaryValidation.ts` refuses `hq-json` and `hq-upload`
export for a carrier-bearing document (`LOOKUP_CARRIER_EXPORT_NOT_ACTIVE`). Local
`.ccz` export carries them. That refusal lifts when resource push exists.

### Atomic submission and resolved identity

One submission is one transaction. The preview store exposes a single envelope
carrying ordinary form behavior plus advanced operations; the server builds the
`CaseOperationProgram` from the **committed** document, and identity resolves
server-side at the action boundary rather than being folded into a
client-supplied literal. Every `SubmissionMutation` arm carries the final
plain-JSON protocol: form UUID, controller-owned UUID entry key, and exact
structured attachment references (including explicit `[]`), plus complete
per-scope operation answer bags when the committed form has operations. The
Server Action imperatively validates and normalizes that required projection
before receipt, program, or effect derivation; the retired name-only projection
is rejected. A `Map`, `Set`, or `File` argument would make React encode
multipart, which the edge WAF blocks.

The membership gate precedes the program build, closing a one-bit cross-tenant
survey oracle. If a freshly authorized committed form has operations but the
submission lacks its answer bags, the entire request rejects as stale/skewed:
empty bindings would blank-write and an ordinary-only fallback would silently
skip committed semantics.

Two finer skews reject for the same reason. **A repeat scope the committed
document requires, absent from the payload, is provable staleness rather than an
empty repeat** — `computeOperationAnswers` registers a scope for every repeat in
the client's own document *before* counting instances, so a worker who added no
rows still sends it carrying an empty iteration list. Only a client that never
knew the repeat omits it, and reading that as zero iterations would run the
operation zero times and report success. **A missing form answer rejects too**,
checked per scope against the iterations that will actually compile: a field
inside a repeat the worker left empty is never read, so demanding it would refuse
an honest submission. Without that check the reference reaches `compileBoundRef`,
which deliberately has no fallback for a form field — a blank would change a
predicate's truth value — and its developer-voiced invariant became the worker's
error text plus an alert, for an ordinary multiplayer race. That same authorized boundary projects canonical
lookup-reference occurrences onto the committed form's operation UUIDs and
threads one exact rows-free definition snapshot through the immutable envelope;
carrier-free programs perform no lookup-definition read, while lookup rows
remain current transactional inputs.

Wire facts the envelope rests on:

- A `case_type` update rewrites only the type field: no property pruning, no value
  casting (`CaseXmlParser::updateCase`,
  `SqlCaseUpdateStrategy::_apply_update_action` / `::_update_known_properties`).
- `owner_id` is first-class mutable in create and update, with `@user_id` as the
  acting user and the create-time fallback owner; `-` is HQ's
  `UNOWNED_EXTENSION_OWNER_ID`.
- Blocks apply create → update → close → index regardless of child order
  (`parser.py::CaseUpdate`, `xform.py::order_updates`).
- An empty index target removes the link (`CaseXmlParser::indexCase`), and
  create-of-existing merges (`acceptCreateOverwrites` is true in every runtime
  caller).
- Formplayer commits a submission's case blocks together with the HQ POST as one
  transaction (`FormSubmissionHelper::processAndSubmitForm`).
- A default HQ domain performs **no** extension-close cascade: the cascade
  (`submission_post` → `casexml/apps/case/xform.py::close_extension_cases` →
  `get_all_extensions_to_close`) runs only under
  `toggles.EXTENSION_CASES_SYNC_ENABLED`, a frozen per-domain toggle that is off
  by default. The envelope closing only its target case **is** faithful device
  parity, and Nova adds no cascade.

### User properties, user types, and preview personas

Three flat blueprint collections answer three separate questions, and the
distinction is load-bearing everywhere downstream (`lib/domain/users.ts`):

- a **user property** is a slot workers carry data in — the app's half of
  CommCare's per-domain custom user-data schema;
- a **user type** is a reusable role template that fills those slots with
  default values;
- a **persona** is a named design/test actor with stable identity that
  *references* a user type and may override individual values. It is who Preview
  runs as.

A **deployed worker** — a real identity on a target HQ domain, with credentials
and its own lifecycle — is deliberately absent. It is owned by a deployment,
created *from* a type or persona, and is not a blueprint identity.
The current app export/upload path does not configure HQ's project-level custom
user-data schema, role templates, role/persona values, or worker accounts; these
collections remain Nova authoring and Preview state until unit 12's explicit
provisioning driver applies them.

The builder, Solutions Architect, and MCP API author all three collections
through the same granular mutations and commit gate. The builder's names and
saved property keys draft locally and commit on blur or Enter; accepted-value
lists commit on blur, Apply, or Command/Ctrl+Enter. Each passes its inline
verdict first, so ordinary typing never saves an invalid intermediate or loses
refused text. Each entry disclosure stays mounted while collapsed, so an
invalid or refused name, saved key, or accepted-value draft and its explanation
survive both collapse and switching between entries; Base UI still owns hidden
panel focus and inertness. The shared agent tools expose
`getUsers` plus add/update/remove operations for each collection (snake_case on
MCP); values cross those JSON tool boundaries as
`{ userPropertyUuid, value }[]` and bridge to the UUID-keyed document record at
one boundary. On an initial build, custom properties land immediately after the
app name and before the data model, modules, forms, conditions, or calculations
can reference them; roles and personas may follow the reference-bearing app
structure. Update omission keeps a slot and explicit `null` clears one. Each
changed role/persona value persists as its own semantic mutation, with the
cumulative record only as an origin-compatible fallback, so concurrent edits
to different properties merge instead of replacing one another. In the
builder an absent persona value inherits its role, an explicit `""` overrides
the role with blank, and a nonempty value overrides it with that value; control
item identities are separate from authored strings, so no valid choice is
reserved as a sentinel. Preview identity, expression source, and custom worker-
information choices expose their selected state as checked radio-menu items;
color is only a secondary cue.

All normalized identity-keyed records use own membership and a null prototype,
never prototype lookup or the legacy `__proto__` assignment setter. That
includes the six entity maps, structural membership and reverse maps, every
reference-index root and nested bucket, and role/persona value bags. JSON and
structured-clone hydration rebuilds that representation before any mutation,
diff, query, or projection reads it. Thus schema-valid keys such as
`__proto__` and `constructor` survive persistence and projection without
inherited properties masquerading as members. Accepted choices are unique by
exact value at construction, and duplicate property slugs, user-type names,
and persona names report every member of the duplicate group in deterministic
`(order, uuid)` order, independent of insertion order. Flat collections have
no membership array to break a legacy missing-`order` tie, so two such entries
sort by UUID rather than object insertion order. The document schema uses the
shared `ownRecordSchema` rather than Zod's native record parser, which
intentionally drops `__proto__`; persistence hydration rebuilds every
normalized record through the same prototype-safe record helpers. All six
normalized entity kinds — module, form, field, user property, user type, and
persona — share one global UUID namespace because `blueprint_entities` keys
them all by `(app_id, uuid)`. The commit validator reports every member of a
collision, and `decomposeBlueprint` repeats both global uniqueness and
record-key/embedded-UUID agreement as a persistence tripwire before any rows
can collapse.

Custom worker-information references follow the same stable identity as
role/persona values. Predicate / ValueExpression stores
`session-user-property { userPropertyUuid }`; XPath stores
`user-property-ref { userPropertyUuid }`. Every Preview, Postgres, local-wire,
and HQ-wire target resolves the property's current saved slug only when it
projects the AST, so a rename rewrites nothing and takes effect everywhere
immediately. The parallel name-backed `session-user { field }` and XPath
`user-ref { property }` arms are the final vocabulary for
CommCare-provided or external fields that have no Nova entity — they are not
compatibility spellings of the identity arm. The builder exposes those as two
explicit sources: **Worker information** selects only from the UUID catalog,
while **Other user field** authors only the raw name-backed arm, admits
hyphens after an XML-safe first character, and never infers identity from its
text. An unavailable custom UUID stays visible as a recovery state rather than
falling back to text or exposing the UUID.

Textual XPath parsing converts a custom `#user/<slug>` match to identity only
when the authored capitalization matches exactly, the case-insensitive catalog
has exactly one match, and the slug passes the same reserved-name/format
verdict as construction. A built-in, reserved/invalid legacy custom,
case-insensitive duplicate, case-only match, missing, or external spelling
remains name-backed permanently; a later catalog rename cannot retarget that
raw leaf. While an XPath editor is open, a clean draft adopts a peer's identity
rename. A dirty draft rebases only when the peer projection changes exactly one
complete `#user/<slug>` token and no other byte, that rename is the catalog's
only identity change, the before/after entries prove the same unique
custom-property UUID, and the cleanly parsed local and base texts each contain
the complete old token exactly once. The editor subscribes to the custom-worker
catalog independently of printed text; a catalog-only change that could alter a
dirty token's identity interpretation therefore fails closed immediately.
Namespace matches, bare-slug guesses, parser recovery, token extensions,
deletions, repetitions, and broader peer edits fail closed too. When both edits
replace the same text, CodeMirror preserves the local draft and refuses save
until Escape reloads the shared projection instead of overwriting either edit.
That conflict is sticky for the lifetime of the mounted draft: every later
projection advances the shared base but neither clears the warning nor enables
save.

The reference index records both custom AST arms under one `p:<uuid>` target.
Removing worker information therefore refuses while any condition,
calculation, default, case-list rule, or navigation rule still reads it and
names every exact `(carrier, slot)` occurrence to update. Relevant and required
conditions on the same field remain two settings; friendly descriptions never
deduplicate distinct slots. It never silently deletes those
expressions or degrades their identity to mutable text. Once no reference
remains, the same gated batch clears every role/persona value for the property
and removes it.

The wire facts the shape rests on:

- HQ stores one `CustomDataFieldsDefinition` per `(domain, field_type)`
  (`custom_data_fields/models.py::CustomDataFieldsDefinition`); mobile and web
  users share `field_type='UserFields'`
  (`users/views/mobile/custom_data_fields.py::UserFieldsView`) and split only by
  per-field `required_for`. So one app's catalog compiles to that one
  definition.
- Slug legality is enforced at construction so a push can never fail on identity
  grounds. HQ's Django slug validator
  (`custom_data_fields/edit_model.py::XmlSlugField` lists `validate_slug`) admits
  a leading digit or hyphen, but Nova emits the slug as an XML element in both
  the session and usercase projections. Nova therefore requires a leading
  letter or underscore and admits letters, digits, underscores, and hyphens
  afterward — the intersection that keeps every emitted path representable. The
  remaining clauses are at least one non-digit (its
  `RegexValidator(r'\D', '')`), `SYSTEM_FIELDS` and the
  `commcare` / `xml` prefixes (`models.py::validate_reserved_words`), the
  case-reserved words and case-insensitive uniqueness
  (`edit_model.py::CustomDataFieldsForm.verify_no_reserved_words` /
  `::verify_no_duplicates`), and the 127-character column. `RESERVED_CASE_PROPERTIES`
  is HQ's `case-reserved-words.json` plus `name` and `owner_id`, both already
  system fields, so one list covers every clause. Nova compares it lowercased
  and is therefore marginally stricter than HQ on mixed case (`Name` is refused
  here, accepted there) — stricter never costs a push.
- The restore's `<Registration><user_data>` block injects framework keys **after**
  authored data, so they win collisions
  (`users/models.py::CouchUser.get_user_session_data`): `commcare_project`,
  `commcare_first_name`/`_last_name`/`_phone_number`, `commcare_user_type`,
  `commcare_location_id`/`_ids`/`commcare_primary_case_sharing_id`, plus
  `user_type='demo'` for practice users. `commcare_profile` reaches the same
  block by a different route — `users/user_data.py::UserData._provided_by_system`
  always includes the slot, so it rides in through `to_dict` rather than being
  injected after it. That combined set **is** `BUILT_IN_USER_PROPERTIES` and the
  reserved-name list — there is no second source, and
  `lib/domain/__tests__/users.test.ts` asserts the relationship rather than
  restating it.
- **`user_type` is the one key the restore does not decide.** HQ sends it only
  for a practice user, but the CLIENT seeds it: every
  `commcare-core .../User.java` constructor calls `setUserType(STANDARD)` — a
  plain `properties.put` — and `UserXmlParser::parse` builds the `User` before
  applying any `<data key>`. Both runtimes use that parser
  (`CommCareTransactionParserFactory::initUserParser`; Android subclasses it).
  So an ordinary worker's device holds `user_type = "standard"` and a practice
  user's restore overwrites it with `"demo"`; the key is never absent, which is
  why Preview supplies `"standard"` rather than leaving it out.
- Only three keys are read by the runtime framework: `user_type` (demo
  detection — `commcare-core .../User.java::getUserType`) and `commcare_project`
  + `commcare_location_ids`, read together by
  `formplayer .../UserUtils.java::getUserLocationsByDomain` to drive the local
  case purge in `RestoreFactory`. Everything else in `session/user/data` is
  inert.
- The client's registration parser writes every `<data key>` into
  `User.properties` verbatim — no key restrictions, last-wins on duplicates
  (`commcare-core .../UserXmlParser.java::parse`) — and merges into a retrieved
  user without clearing, so a key deleted on HQ lingers until a full resync.
  Nova documents that staleness rather than simulating it.
- The emitted session lookup is pinned byte-for-byte to
  `commcare-hq/corehq/apps/app_manager/tests/test_suite_remote_request.py::test_required`:
  `instance('commcaresession')/session/user/data/<slug>`. The emitted usercase
  lookup is pinned to
  `corehq/apps/app_manager/tests/data/suite/suite-case-detail-tabs-with-nodesets.xml`:
  `instance('casedb')/casedb/case[@case_type='commcare-user'][hq_user_id=instance('commcaresession')/session/context/userid]/<slug>`.
  HQ JSON, local suite/XForm, and HQ-upload XForm tests assert the exact
  corresponding bytes, including a hyphenated slug and a slug rename against an
  unchanged AST.
- `CustomDataFieldsProfile` sits behind the paid `APP_USER_PROFILES` privilege
  and is deliberately not the provisioning model; a user type compiles to plain
  per-user `user_data` values.

Two of HQ's `Field` columns are deliberately excluded from constructible state.
`regex` / `regex_msg` sit behind the paid `REGEX_FIELD_VALIDATION` privilege —
`edit_model.py::CustomDataModelMixin.get_field` drops the pattern and keeps
`choices` without it — so an authored pattern would silently not validate on a
stock domain. `required_for` is the mobile/web split, and Nova provisions mobile
workers only: web users arrive through HQ's `InvitationResource`, which resolves
a role by name a user type cannot supply.

Whether a persona satisfies a `required` property is likewise not a document
finding. HQ enforces the flag only when the pushed field's `required_for` names
the user type being created
(`users/views/mobile/custom_data_fields.py::UserFieldsView.is_field_required` —
NOT `edit_model.py::CustomDataModelMixin.is_field_required`, a different
function that returns a bare `field.is_required`), so it is a question about
one deployment target, and gating on it would make marking an existing property
required impossible. The authoring surface says so inline instead.

### Preview identity

`lib/preview/engine/identity.ts` carries **two ids that are not
interchangeable**. `actorUserId` is the signed-in member and the only thing that
ever authorizes; `ownerId` is the CommCare worker the preview acts as — the
`owner_id` stamp on rows it writes and the value `session/context/userid`
resolves to. Previewing as a persona makes `ownerId` that persona's UUID while
the member still authorizes, so a case list filtered to the current user shows
that persona's caseload. Keying authorization on `ownerId` would let authored
blueprint content choose whose data a request reads;
`lib/preview/engine/__tests__/identity.test.ts` pins that the two cannot be
re-conflated, and `withProjectContext(projectId, actorUserId, ownerId)` carries
the split into the case store, where authorization fences read the member and
`owner_id` / `acting-user` read the worker.

The identity carries **two projections of one worker**, because the wire has
two. `session` is `instance('commcaresession')/session/…`, built by
`commcare-core .../SessionInstanceBuilder.java::addMetadata` +
`::addUserProperties`. `usercase` is the `commcare-user` case `#user/<prop>`
reads, built independently by `callcenter/sync_usercase.py::_get_user_case_fields`
— same authored data, different built-in keys (`first_name` there,
`commcare_first_name` in the session block). The serializable session
projection additionally carries a custom-property UUID→current-slug binding
map for Predicate/SQL/wire emission; it is projection metadata, not worker
data. Both projections and every evaluator perform own-key reads, so a valid
property named `__proto__` or `constructor` behaves as authored data rather
than inherited prototype state.

**The three location keys diverge between the two projections**, and the
asymmetry is easy to state backwards: `get_user_session_data` writes all three
or none, so the session block omits them while nobody is assigned anywhere,
while `_get_user_case_fields` takes an explicit `else` branch to `''` for all
three, so the usercase always carries them. `commcare_profile` likewise appears
on both.

Preview values are otherwise honest. `commcare_project` is **absent** until a
deployment target supplies a domain. The session's
`commcare_first_name`/`commcare_last_name`/`commcare_phone_number` keys and the
usercase's `first_name`/`last_name`/`phone_number`/`email` keys are always
present because HQ writes them unconditionally; Nova derives values it knows
and preserves the rest as empty rather than changing the node shape.
`commcare_user_type` is `'commcare'`
(`users/models.py::COMMCARE_USER` — not the same-named
`UserFieldsView.COMMCARE_USER`, which is `'commcare_user'`, nor
`change_feed/topics.py::COMMCARE_USER`, which is `'commcare-user'`),
`commcare_profile` is empty, and `user_type` is `"standard"`, because all three
are knowable rather than invented. A **declared** property with no value is
present-and-empty, matching `users/user_data.py::UserData.to_dict`'s
`{field: '' for field in self._schema_fields}` seed, while an undeclared key is
genuinely absent — the split a `= ''` comparison depends on.

Every persona-aware case-data action authorizes `actorUserId` against the app
before it exposes the committed blueprint, resolves the selected persona once
from the blueprint loaded under the same app-row and membership locks, and
binds the resulting
`(actorUserId, ownerId)` pair explicitly. A stale or missing persona returns a
typed refusal; it never changes the write to the signed-in member. The selector
rides Results/Details reads, sample populate/reset, and form submission, while
Project lookup reads continue to authorize as the member. Thus sample rows and
submitted cases are owned by the selected worker, but membership and lookup
access can never be asserted by authored persona identity. The case-store
constructor rejects every blank or undefined supplied Project, actor, or owner
identifier before a query can exist, so a malformed selector cannot degrade
into an ownerless write.

The selected-but-missing state is explicit on the client too: the running shell
replaces every Preview surface with a blocked explanation and **Preview as me**
recovery, and the engine controller refuses activation behind it. It never
renders an anonymous or one-frame member fallback. Leaving Preview clears the
persona selection before edit-only sample/data surfaces become active, so the
next run starts as the signed-in member unless the author chooses a persona
again.

Deleting a persona never deletes case data: rows it owns keep naming it, and the
confirmation must successfully count every retained row for that owner across
current and retired case types before enabling Remove. Held rows are included;
the result is the exact population that stays stored and may remain visible in
unfiltered data views. A failed count offers retry rather than allowing an
unknown-impact removal, and the dialog offers neither reassignment nor row
removal. **This is Nova's own rule, not HQ parity** — HQ has two different
answers and neither is a template for it. Deactivating a worker, or removing
them from the domain, closes their usercase and leaves their cases alone
(`sync_usercase.py::_get_sync_usercase_helper` computes
`close = to_be_deleted or not is_active_in_domain or domain not in domains`).
DELETING one is destructive: `users/models.py::CommCareUser.retire` →
`::delete_user_data` soft-deletes every case the worker owns via
`tag_cases_as_deleted_and_remove_indices` and strips their indices. A persona is
a design and test actor rather than a person who left an organization, and the
cases it created are the author's own test data, so silently soft-deleting them
would be a destructive surprise. Preserving them is the deliberate choice.

### Preview execution

The running preview executes the blueprint in a client-side engine
(`lib/preview/engine`) over real Postgres case rows. There is no mock mode.

- Display conditions evaluate live (`displayConditionEvaluation.ts`). The preview
  hides conditioned items exactly as a device would, and offers a "hidden items
  (N)" reveal with ghosted entries and a person-readable condition summary. That
  summary printer is display-only and forks no predicate semantics. Authoring
  surfaces — canvas, tree, flipbook — never hide conditioned items.
- Lookup-backed selects render live filtered choices
  (`lib/preview/engine/lookupEvaluation.ts` resolves them,
  `lib/preview/engine/formEngine.ts` materializes them into the running form, and
  `lib/preview/engine/useLookupPreviewData.tsx` holds the builder-session table
  cache). Choice rows hold stable within one form session: a
  row edited mid-entry appears on the next form entry, matching the wire's
  install/upgrade fixture semantic, while the builder-session cache refreshes on
  the Project realtime clock between sessions.
- The AST→Kysely compiler (`lib/case-store/sql`) carries `table-lookup` and
  `table-column` arms, so a lookup-bearing case-list filter compiles to SQL.
- Preview runs as the signed-in member or as a named persona, and the two modes
  never blend: the running app always states which identity it is showing, and
  an unavailable selected persona blocks execution until the author explicitly
  switches back.

### Case lists, search, and the case workspace

Every module carries a case-list configuration: one ordered column array carrying
display, sort, calculated, and visibility state together, plus search inputs and
their matching behavior. Predicates are typed ASTs throughout, so a column filter,
a search-input condition, and a display condition all speak the same vocabulary
and all compile to three surfaces — the on-device XPath dialect, CSQL for HQ-side
search, and Postgres for the preview (`lib/case-store/sql`). Search-button display
conditions, results availability, and default ordering are authored in the case
workspace; `content/docs/case-workspace.mdx` is the user-facing guide.

### Case tiles

A module's case list is laid out either as a row of columns or as a **tile** — a
12 × 12 grid where each Results field occupies a rectangle. The layout lives on
`caseListConfig.tile` and its presence IS the switch; each column carries its own
`tile` cell (`{x, y, width, height}` plus optional alignment, text size, border,
and shading). Placement is deliberately separate from the case list's two
ordering arrays: a cell is where a field sits on the tile, a sequence is
where it sits in a sequence.

One short detail drives all three tile surfaces. `models/modules.py::Module.search_detail`
deep-copies it for search results, and `caseListConfig.tile.persistOnForms` turns
the same detail into the persistent tile above every form in the module
(`detail-persistent` on each case-loading datum;
`cloudcare/.../formplayer/menus/views.js::PersistentCaseTileView` renders it in a
sticky region, suppressed only inside HQ's own App Preview pane, which Nova does
not target). The case-detail screen stays a plain field list.

Nova emits only HQ's `custom` tile vocabulary — `case_tile_template = "custom"`
plus per-column grid fields — and never the named templates `person_simple` or
`icon_text_grid`, whose slots are filled by name and whose emission carries a
hardcoded profile-image cell and a literal `m0-f0` registration action. Layout
presets are builder gestures that fill per-column placement; there is no template
slug in the schema, so a preset and a hand-drawn layout take one wire path. HQ's
regeneration is not toggle-gated — `suite_xml/sections/details.py::DetailContributor.build_detail`
fires `CaseTileHelper` on a bare truthiness check of `detail.case_tile_template`,
and `feature_support.py::CommCareFeatureSupportMixin.supports_grouped_case_tiles`
gates only HQ's own authoring template — so an uploaded Nova tile emits on any
domain with no setup artifact first.

The wire facts that shape the emitter:

- **`<style>` and `<grid>` are one indivisible unit.**
  `commcare-core/.../org/commcare/xml/DetailFieldParser.java::DetailFieldParser.parseStyle`
  runs `GridParser` unconditionally after `StyleParser`, and
  `GridParser::parse` opens with `checkNode("grid")` and then reads all four
  coordinates through unguarded `Integer.parseInt` calls. A `<style>` with no
  `<grid>` is an install-time `InvalidStructureException`; a `<grid>` missing one
  attribute is a raw `NumberFormatException` that escapes the parser's structured
  error path. HQ can emit both (its custom branch guards on `any(... is not None ...)`
  across the four, not `all(...)`). Nova cannot: `TileCell` carries the four as
  required slots of one object, so the partial state is unrepresentable. The
  corollary binds authoring too — alignment, text size, border, and shading are
  reachable only for a placed cell, because they have no wire spelling without
  one. A field is a tile cell iff all four are set
  (`DetailField::isCaseTileField`, against a `-1` unset sentinel).
- **The rendered grid is the occupied extent, not the 12-column canvas.**
  `Detail.java::Detail.getMaxWidthHeight` derives it from the cells, Formplayer
  ships it as `maxWidth`/`maxHeight`, and `views.js::buildCellGridStyle` builds
  `repeat(maxWidth, 1fr)`. A tile ending at column 6 renders six equal columns
  filling the width. `lib/preview/caseTileLayout.ts` is the one projection the
  running list and the authoring canvas both derive from, so they cannot disagree.
- **The 12-column cap is Nova's own.** CommCare Core has no column-count
  constant, and HQ has no server-side grid validation at all — its only
  enforcement is a Knockout dropdown range, and its parity assertion
  (`tests/test_suite_case_tiles.py::SuiteCaseTilesTest.test_case_tile_column_count`)
  lints only the two shipped named templates and never sees a `custom` tile.
  Nova enforces 12 columns and 12 rows itself, plus no-overlap and full coverage,
  in `lib/commcare/validator/rules/case-list/caseTileLayout.ts`.
- **Vertical alignment is authored in Nova's words and emitted in the wire's.**
  `top` / `middle` / `bottom` emit as `start` / `center` / `end`, because
  `views.js::getValidFieldAlignment` silently rewrites anything outside
  `constants.js::ALLOWED_FIELD_ALIGNMENTS` (`start`, `end`, `center`, `left`,
  `right`) to `start` — HQ's own shipped `icon_text_grid` template emits
  `vert-align="top"` and its renderer ignores it. A clean instance of the wire
  binding where HQ's authoring shape does not.
- **Border and shading are a tile-wide switch at the runtime.**
  `views.js::buildCellLayout` computes one `borderInTile` / `shadingInTile` over
  the whole tile; if any cell asks for either, every cell changes layout mode.
  Nova's renderer reproduces that rather than reading the flags per cell.
- **Absent text size means inherit, not medium.** An absent `font-size` produces
  an empty `font-size: ;` declaration the browser discards. The `medium` default
  exists only in HQ's authoring UI.
Emitted bytes are asserted against HQ's own fixtures —
`suite-case-tiles.xml` for the `<style>`/`<grid>` shape,
`case-tile-case-detail.xml` for `show-border` / `show-shading`, and
`case_tile_pulldown_session.xml` for `detail-persistent`.

Two scope fences are deliberate. Long-detail tiles stay out: CommCare allows
`custom` on the case-detail screen, and Nova keeps that screen a field list.
Pull-down (`detail-inline`) stays out because it is a navigation change rather
than a layout one — it replaces the case-detail confirm screen by folding the
long detail into the persistent tile.

### Carrying a column without showing it

`width="0"` on a short-detail `<header>` and `<template>` is CommCare's own
reserved spelling for a column the list carries but does not display — not a
Nova convention and not a hack.
`commcare-core/.../org/commcare/suite/model/Style.java::Style(DetailField)`
records it in its own comment ("`'0'` is reserved for hidden (Search) fields")
and defaults an absent width to `-1` precisely to keep `0` free for it. Both
Web Apps tile templates honor the contract explicitly, branching on
`styles[index].widthHint === 0` to render the value inside a `d-none` wrapper —
`cloudcare/templates/cloudcare/partials/case_list/tile_item.html` and the
identical branch in `tile_grouped_item.html`, so grouping inherits it unchanged.

This is what lets Nova's zero-width sort carrier work on a tile with no special
case: the field occupies no cell (its `-grid-style-N` class has no rule, because
`views.js::buildCellLayout` filters null tile entries before building the style
block, and `formplayer-common/grid.scss::.box` adds no box size), and the
ordering still applies because the runtime sorts entities before it draws them.
Ordering by a field workers never see behaves the same on a tile as in a row of
columns.

**That only holds because a hidden column contributes no cell to any surface**,
and that refusal is load-bearing rather than incidental. A hidden column keeps
its stored cell — hiding and unhiding restores the drawing — so without the
refusal a carrier that retained a placement would emit a complete
`<style><grid>`. All four coordinates set makes it a tile cell by
`DetailField::isCaseTileField`, at which point it claims a real `grid-area`,
enlarges the extent `Detail.getMaxWidthHeight` computes across every field, and
joins the tile-wide border/shading switch — while its `width="0"` content still
renders inside `d-none`. The visible consequence is a tile silently widened, or
every cell boxed, by a column no worker can see; and the overlap rule cannot
catch it, because that check deliberately walks only the columns the tile shows.

**The decision therefore has exactly one home**:
`lib/domain/modules.ts::tileCellFor` answers "does this column hold a square?"
and all three emission paths call it — the suite emitter
(`suite/case-list/columns.ts::tileStyleChildren`), the HQ JSON writer
(`hqJson/caseList.ts::applyTileLayoutToShortDetail`), and the preview
(`lib/preview/caseTileRendering.ts::tileResultsColumns`). It is one predicate
because it was briefly three: each path decided independently, and the HQ JSON
writer — the **primary** delivery path — decided wrongly while the other two
were right, so an uploaded app drew a different tile from the local `.ccz` and
the preview. Three paths agreeing by hand is not an invariant, it is a
coincidence with a short half-life. `lib/commcare/__tests__/tileEmissionParity.test.ts`
asserts the agreement directly on one document carrying that exact shape, and
the suite fuzz now generates hidden sort carriers that retain their placement,
which it never did while the divergence shipped.

The validator's visible-only overlap walk is sound **only** while that predicate
governs every path; a fourth delivery path or renderer must call it rather than
re-derive it.

The fact reaches past tiles. Any column that must ride the detail without being
shown — so its value is available to sorting, to a calculation, or to a later
surface — uses this shape rather than being dropped from the detail.

### Media

Assets are Project-scoped: bytes in GCS, a metadata row in Postgres, and
`project_id` set authoritatively at upload as the only access gate. Attach- and
export-time verdicts, the export budget, the wire manifest, and the deletion guard
live in `lib/media`. The manifest filters a document's referenced ids to the
Project, which is also the exfiltration-via-compile defense — a foreign-Project
reference resolves to `MEDIA_ASSET_NOT_FOUND` rather than being emitted. This is
authoring media (menu icons, field images); a worker's own captures are the
attachment questions below and never enter this library.

### Attachment questions

Five capture kinds — image, audio, video, signature, and file — carry a label,
hint, `required`, and `relevant` and nothing else. `captureFieldKinds`
(`lib/domain/fields`) is the single home for which kinds are captures; the
reference-slot applicability groups, the case-property rejection, and the wire
emitter all read it. Each emits `<upload ref mediatype>` over a `<bind
type="binary">` and nothing else — no suite entry, no app-level declaration
(fixture: `form_preparation_v2/attachment.xml`).

**The `mediatype` is a closed four-literal enum with no fallback, and the
emitter makes an unmatched value unrepresentable rather than checking for one.**
`XFormParser::parseUpload` matches with literal `String.equals` against
`image/*`, `audio/*`, `video/*`, and `application/*,text/*` (comma, no space).
Anything else leaves the control at `CONTROL_UPLOAD`, `entries.js::getEntry`
falls through to `UnsupportedEntry`, and that constructor **sets the answer** to
the literal string `Not Supported by Web Entry`, which then submits. The failure
mode is silent bad data, so `UPLOAD_MEDIATYPE_BY_CAPTURE_KIND`
(`lib/commcare/xform/captureUpload.ts`) is a total table over the capture kinds
into a four-member literal type, and a new kind fails `tsc` until it names one.

Signature is its own Nova kind emitted as `image/*` plus
`appearance="signature"` — the wire collapses it onto the image control and
`entries.js::getEntry` splits it back apart on that appearance, but every
worker-visible property differs. `appearance="face"` stays out: Vellum authors it
and it is inert on both runtimes Nova targets. `jr:imageDimensionScaledMax` stays
out for the same reason — `UploadQuestionExtensionParser` is registered only by
`commcare-android`, so Web Apps does no downscaling and uploads the picked bytes.

File attachments are a first-class Web Apps kind (`entries.js::DocumentEntry`,
accept list `.pdf,.xlsx,.docx,.html,.txt,.rtf,.msg`) with full receiver support,
and they carry one asymmetry stated where the author picks the kind:
`CONTROL_DOCUMENT_UPLOAD` appears nowhere in `commcare-android`, so
`WidgetFactory::createWidgetFromPrompt` falls to `StringWidget` and a worker
there types free text into a `binary` node.

`hqShells.ts::applicationShell` emits one fixed `build_spec.version` (`2.54.0`)
as part of Nova's single application-shell target. It is not a feature floor,
reader gate, or capability switch, and no authoring/runtime branch consults it.
The upload path is declarative because `models/applications.py::import_app`
deletes `build_spec` and `ApplicationBase.wrap` substitutes the target domain's
default.

`FORM_TOO_MANY_ATTACHMENTS` rejects a form whose **non-repeating** capture
questions exceed `MAX_FORM_ATTACHMENTS` (50). Formplayer counts at submit time
over the session media directory (`FormSubmissionHelper::getMultiPartFormBody`,
before any per-file logic) and the whole submission aborts, with no worker-facing
way to shed a file — so a form past the cap is a dead end once fully answered.
The walk stops at a repeat deliberately: a capture there produces one attachment
per iteration and the worker chooses the count, so no authoring-time number
bounds it, and counting the template once would imply a guarantee the check
cannot make.

**Every author- and worker-facing string says "attach", never "take" or
"record".** Web Apps has no camera, microphone, or recorder anywhere in
cloudcare — `entry_file.html` binds only `accept` on its file input, and
`getUserMedia` / `MediaRecorder` / `capture=` occur nowhere in it. Every kind but
signature is the OS file picker. CommCare Android is the contrast, and that
contrast is a docs fact rather than a Nova behavior.

`lib/commcare/validator/rules/form.ts::mediaCaseProperty` keeps rejecting a
capture kind carrying `case_property_on`, and `formActions.ts` skips capture
kinds when building the case-update map. Writing a capture onto the case is
inseparable from emitting its URL column, so the two ship together (unit 6).

### Attachments a worker captures

A worker attaches files in the running preview, and they ride the submission.
The lane is `form_attachments` plus two GCS prefixes — **never `media_assets`**:
a captured photo is data, not an authoring asset, and a row in the library would
surface it in the media picker, count it against the export budget, and make it
deletable through the library UI. CommCare's own model agrees, keeping staged
capture bytes under the form session and disposable.

The acceptance lifecycle is
`pending → staged → preparing → prepared → submitted`; Clear or expiry sends a
`preparing`/`prepared` row through `discarding` instead. A form answer may name
an attachment only once it is `staged`, because a `pending` row's object may
never have been PUT. Bytes take the media lane's initiate → signed-PUT →
confirm shape so they never travel through Cloud Run, and the routes nest under
`/api/apps/[id]/attachments`, which needs no `lib/hostnames.ts` entry because
allowlist matching is segment-anchored. The signed PUT binds the exact declared
byte length and creation generation zero; confirm records the immutable GCS
generation, CRC32C, size, and content type.

**Names are server-minted and derived from nothing about the question** — not
the field id, not the node path, not the repeat index — because
`MediaHandler.kt::saveFile` is not either, and a field-derived name would
collide across repeat instances exactly where CommCare's does not. Nova cannot
produce CommCare's trailing-dot edge (`<uuid>.` from a filename with no
extension), since an unrecognized extension is rejected before an id is minted;
a consumer must still not assume a capture answer splits on a dot, because a
submission that went through Formplayer can carry it.

Two tenancy axes. `project_id` is the tenant, matching case rows, so every
member of an app's Project sees the same submissions. `created_by` is narrower
and scopes the writes: reservation is keyed on a client-minted `entry_key`, so
without it a co-member in a shared Project could reserve or delete another
member's in-flight attachments by sending their key.

**Accepted means the bytes are already durable.** The client submits exact
`{ attachmentName, fieldUuid, instancePath }` references. Before any case
effect, the server builds capture authority from the authorized committed
document. A DB transaction then locks that entry, validates the selected rows
against that server-built intent, and moves them from `staged` to `preparing`.
Only then may a bounded worker copy each immutable,
generation-pinned source to its deterministic create-only durable key and
verify size, CRC32C, content type, and concrete generation. The worker records
`prepared` only after that proof. If the request dies after the copy but before
the row update, the deterministic destination plus the prior `preparing` row
lets the scheduled five-minute worker rediscover and verify the exact copy.
There is no cross-system interval in which external bytes exist without a DB
recovery record. Scheduled failures use backoff; pressing Submit again may make
a recorded failure due immediately, but never steals an active copy lease.

The later case-store transaction independently requires every selected row to
be `prepared`, inserts the idempotency intent, moves those rows to `submitted`,
applies every case effect, and stores the replay result atomically. A case
failure rolls all of that back to `prepared`; a matching retry returns the
stored result; a different payload under the same entry key is rejected. No GCS
operation or other post-commit attachment await remains, so an accepted form
cannot be reported failed by a hung copy and cannot point at bytes still
subject to the staging TTL.
The client also emits this intent with `attachments: []` when the committed
form is capture-capable but the current projection is empty. The prior receipt
check therefore still runs before case effects after a worker clears an answer,
a condition hides it, or a repeat removes it: an identical accepted request
replays and a changed digest rejects instead of applying the form twice. Every
submission envelope also carries the actor/app/entry/form identity plus the
canonical payload digest independently of current capture structure. The Server
Action's one authorization transaction locks the app `FOR SHARE`, proves fresh
Project membership, and reads a durable receipt before hydrating the current
blueprint. A receipt returns the stored result without topology access; a new
submission receives its program and capture authority from the committed app
snapshot read in that transaction. Preparation and the entry-locked case-store
transaction each reauthorize again at their mutation boundary and adjudicate
the receipt before current topology or case effects. Exact retries therefore
replay after the form or its capture fields are deleted or converted; a changed
digest rejects before any case effect.

There is deliberately no destructive hook on value change or repeat removal.
Clear/replace deletes `pending`/`staged` metadata directly, moves
`preparing`/`prepared` rows to `discarding`, and can never delete `submitted`
state. The preparation worker observes Clear through the row's serialized
terminal transition, then deletes the exact source and durable generations
before removing the discard row. Unselected attempts expire through the same
distinction. The Project move protocol blocks under the app lock whenever
capture rows or submission intents exist, because no partial move may strand
their rows or bytes in the source tenant.

Initiate is also a lifecycle boundary: once POST has minted a pending row, a
failed/aborted signed PUT or confirm schedules a bounded compensating DELETE.
Signed-URL creation and the final response handoff both remain fenced by the
request abort signal after the insert. If either fails or the request aborts,
the route runs a bounded pending-only compare-and-delete using the full
server-created attempt identity; a row that advanced is preserved, and cleanup
failure leaves the expiry sweep as the explicit backstop without masking the
signing error.
That cleanup, replacement cleanup, explicit removal, repeat deletion, and entry
retirement are all detached from the entry's critical mutation queue. A slow or
hung DELETE can therefore leave only an expiring orphan; it can never hold a
confirmed replacement, answer clear, or Submit behind it.

Nova diverges from the platform in exactly two places, both toward correctness:

- **Only named attachments ride the submission.** The real runtime enumerates
  the session media DIRECTORY, not the answers
  (`FormSubmissionHelper::getMultiPartFormBody`), so a deleted repeat
  instance's file still uploads, still consumes one of the 50 slots, and lands
  in HQ referenced by nothing.
- **Clear and replace touch the answer first, bytes second.** The runtime does
  the reverse and strands a required question naming a file it just deleted.

Retention has two traffic-independent mechanisms with deliberately different
authority. The GCS lifecycle TTL reaps ordinary staged and browser-abandoned
source bytes even if the app receives no traffic, but GCS-only policy cannot
atomically distinguish a DB-accepted submission; therefore an accepted
generation must first live at a durable prefix the lifecycle never matches.
The scheduled bounded worker owns the cross-system `preparing`/`prepared`/
`discarding` recovery and the row `expires_at` sweep, including exact
destination verification after a crash before the row update. Accepted
durability takes priority over staging cleanup.
Cloud Scheduler invokes one Cloud Run cleanup Job every five minutes. A session
advisory lock collapses at-least-once or overlapping delivery to one active
worker; a held lock or pre-lock connection saturation skips only that dispatch.
After winning, the worker prewarms its work connection and then performs the
same bounded preparation, verification, discard, and expiry sweep every time.
There is no deploy-time execution, alternate mode, probe, or release gate. The
IAM condition and its domain mirror reject empty or double-slash segments in
either allowed prefix. The cleanup database login
inherits no application role and holds only public-schema `USAGE` plus
`SELECT`/`UPDATE`/`DELETE` on `form_attachments`. Its custom storage role is
only object get/create/delete, IAM-condition-limited to `captures-staged/` and
`projects/<project>/captures/`; the media-policy identity separately holds only
bucket metadata get/update.
`applyMediaBucketStoragePolicy` converges the bucket's whole temporary-object
retention policy in one metageneration-fenced patch: the exact prefix lifecycle,
soft delete disabled, versioning disabled, and default event holds disabled. It
refuses to remove any operator retention policy and verifies the fresh bucket
metadata after the write. `lib/storage/__tests__/mediaBucketPolicy.test.ts`
pins that complete contract and concurrent-edit fence. The seven-day staging
TTL therefore remains a hard byte-retention backstop for source objects, while
acceptance requires the exact verified copy outside that prefix before the
submission transaction can commit.

Clear and Replace carry no confirmation on the picked kinds, deliberately:
the device does not confirm either, and nothing is actually lost — the file
is still on the worker's disk, and replacing one means they already went
through the picker and chose another. Signature is the carve-out, because
it is drawn rather than picked and clearing destroys the only copy; it gets
inverse-action undo (the retained stroke buffer, re-emitted through the
ordinary upload path) rather than a confirm, per the contracts' preference
for undo over confirm-then-destroy. The real protection on both is the
ordering — answer first, bytes second — not a prompt.

The preview control is device-faithful: a filename and one visible removal
action (Nova says **Remove**, where `entry_file.html` says **Clear**), no
thumbnail, no playback, no way to reopen the file — and Formplayer declares no
route serving a staged capture back. The preview could render a thumbnail,
which is why it must not; an author laying out a form against a preview that
confirms attachments would ship a form whose workers cannot. The filename lives
in the entry's stable-slot registry, so
relevance, collapse, repeat compaction, and Preview/Edit remounts do not erase it;
it still dies with the page/entry, the same lifetime `form_ui.js`'s in-memory
`fileNameCache` gives it. Action rows wrap at compact widths, arbitrary filenames
break rather than overflow, and every Submit/Clear/Retry/Remove/Cancel action
retains at least a 44 CSS-pixel target.

**The preview does not resume a partially-filled form** — nothing persists
runtime answers and `deactivate` wipes the store — so the entry key is minted
per `activateForm` and lives on the `EngineController`, not the engine. It
survives cold identity/lookup/case-data rebuilds and a same-Project access
refresh. Confirmed app/form/Project changes, materially different workers,
terminal revoke/upgrade states, and **Clear form** retire the old entry.
`FormScreen` installs the exact `{ appId, entryKey, formUuid, projectId,
actorUserId, ownerId, scopeEpoch, accessPhase, canEdit }` write-authority tuple
above every capture field, including when all of them are hidden or unmounted.
Every queued capture/maintenance operation also carries the exact stable slot
key and checks the current controller/session coordinates before and after its
awaited work. Missing authority, response methods, instance paths, or stable
slot identity reject in production; test doubles must implement the real
contract. A tuple change aborts the old network generation without erasing
stable slots, drafts, diagnostics, or Submit blockers. The mounted answer tree,
focus, File controls, case/persona binding, and entry key also survive the
uncertain refresh. Even if React coalesces refreshing and same-Project
authorization into one render, active file drafts become retained recovery
state and dirty signature ink is adopted and encoded exactly once under the new
generation.

Capture mutations share one entry-wide serialized queue; same-slot replacement
is latest-wins, but deletion is never queue-critical. Submit classifies every
known/running capture **before** it joins the queue, then keeps reclassifying
while it waits: ordinary signal-aware work for a dormant question is cancelled
without losing its draft/diagnostic, removed work is retired, and only
effectively visible `notReady` state can block. An explicit queued Clear remains
owned and runs despite dormancy, ahead of Submit, so an older answer cannot
revive later. This preflight includes queued retarget maintenance, so a hidden
or removed question cannot
starve Submit behind a never-settling upload or PATCH. A destructive Clear has
a private serialization key but carries its real stable slot, concrete path,
and field UUID into that classification, so an active Clear stays ahead of
Submit. Initiate, PUT, confirm, and retarget each have a 30-second foreground
deadline covering both the fetch and success/error response-body read. A
visible Cancel aborts a file upload generation while preserving the previous
confirmed owner and answer; a late completion is generation-fenced and cleaned
up.
A confirmed retarget cancelled by dormancy keeps a suspended, generation-tagged
blocker. If relevance returns, the next barrier mints a newer generation and
repairs or CAS-converges the owner before Submit; a late cancelled response
cannot clear that repair. A non-abort retarget failure remains failed and does
not auto-retry from barrier polling, preserving the worker's explicit
Retry/replace/remove choice.

Repeat instances keep stable render keys through index compaction. A failed
retarget is recoverable, not destructive: the confirmed row, answer, filename,
signature ink, desired path, and a generation-tagged blocker remain owned by the
slot. Picked-file save diagnostics live in that same stable slot rather than
component-local state, so they survive ordinary remounts and still offer
**Retry** of the exact retained `File`, plus choose-a-different-file/remove.
The structural Remove control stays visible but disabled without current write
authority. At its imperative boundary it requires the exact coordinator
authority generation captured by the handler and rechecks both the controller
entry key and target repeat instance's stable key before compaction; a stale
handler cannot retire a successor or its capture after authority restoration.
Retarget recovery offers Retry plus
replace/remove for picked files; Signature keeps Retry beside its single
**Clear signature** action, and every message names that exact action. Every
recovery action has a question-qualified accessible name. Retry
compare-and-sets the retained row in place; a newer replacement/drawing
generation wins and clears only the older diagnostic. No failed retarget deletes
the only recoverable row or silently submits it under the wrong path. A CAS
mismatch returns the locked server row's authoritative path. The client adopts
that coordinate and converges toward the slot's newest desired path, so a
successful A→B move whose response was lost can continue as B→C rather than
remaining permanently stuck on expected A.

Live authoring topology changes travel from `EngineController` to that same
coordinator as one atomic pre/post batch. Every retained/deleted move includes
the stable identity of each path segment, so capture and ancestor swaps,
cross-parent moves, different-depth moves, group↔repeat conversion, and nested
retained repeats preserve only their real instance indices. Projection is
tri-state: mapped slots retarget; an explicit field deletion or a proven
higher repeat instance with no destination may retire; malformed paths,
missing/duplicate identities, and mismatched events preserve the exact owner,
picked `File`, signature ink, and an invariant Submit blocker. All mapped
destinations install synchronously before any PATCH or DELETE, so simultaneous
swaps never observe a half-migrated topology. Capture-kind changes remain
incompatible and require a replacement at the mapped destination. A malformed
slot with no valid rendered path appears in a form-level, question-qualified
recovery surface; Submit focuses **Remove attachment** or **Clear signature**
there without registering a guessed path. An explicit deleted-field event for
the same stable UUID takes precedence over an unusable old-path projection and
retires only that slot.
Those form-level recovery controls are also destructive authority boundaries:
they disable during access refresh or viewer mode and pass the exact current
coordinator generation into discard. A missing or stale token fails closed
before the owner, retained File/signature ink, or invariant blocker can be
removed.

Signature strokes and the last successfully encoded CSS dimensions, device pixel
ratio, and backing-store dimensions live together in stable draft state. A
material change — including DPR-only change or a remount at a different width —
generation-fences stale `toBlob` callbacks, redraws normalized ink, and re-encodes
before Submit. A failed encode/upload retains both ink and an actionable
Retry/**Clear signature** error across remounts. Clear's inverse stroke buffer
also lives in stable draft state, so Undo survives ordinary remounts until new
ink supersedes it. `pointercancel` and `lostpointercapture` settle the dirty
drawing, and a dirty draft interrupted by unmount starts encoding when the pad
returns.
DPR-only detection uses a self-rearming resolution media query rather than
relying on a resize event; an interaction-blocked canvas exposes
disabled/read-only semantics. Clear is an explicit newer intent even during
an active upload: it cancels that generation and composes exactly one queued
answer-clear transition. The pad does not erase pixels or publish Undo until
that transition explicitly reports `committed`; `canceled` or `refused`
restores the action, retains the ink and blocker, and re-arms the current
authority generation when it is writable. Invalid Submit expands every
collapsed group/repeat ancestor, announces the validation failure, scrolls the
first invalid question, and focuses its actual control (including the signature
canvas). An attachment blocker carries its stable slot, field UUID, and concrete
path through the same reveal flow, which focuses that question's uniquely named
Retry action. Both flows switch to non-animated scrolling when reduced motion is
requested. A kind-change replacement has no Retry action, so its recovery marker
lives on
the new control itself and Submit focuses the blank signature canvas.

Those rules also mean the runtime's blank-pad-over-live-signature behavior has
no Nova counterpart to be faithful to; the comment on
`EngineController.currentEntryKey` is where a future resume story will need to
carry the key forward and leave the pad blank.

### Export and HQ upload

`lib/commcare` compiles a `BlueprintDoc` to the wire on three paths: a downloadable
`.ccz`, an HQ import file, and a direct HQ upload through the REST client. All
three re-run the full validator with zero tolerance, and
`lib/export/boundaryValidation.ts` adds the boundary findings that depend on
things the document alone cannot know — Project media membership, and which
carriers a given export mode can represent. Credentials are KMS-encrypted per
server, and `lib/commcare/client.ts` resolves its base URL from the selected one.

### Projects, moves, and multiplayer

Projects are the tenancy and sharing unit: every app carries a `project_id`, every
user has a personal Project, and shared Projects let members co-edit an app plus
its case, media, and lookup data at viewer/editor/admin/owner roles. Invitations
are domain-gated (`lib/projects/invitePolicy.ts`).

Cross-Project moves are live. An admin/owner of both ends moves an app plus its
case, media, and conversation history — including chat-attached files. Media
bytes copy into the destination Project first — content-addressed, so a retry
dedups rather than duplicating — and the blueprint repoint plus every row move
then commit as one transaction, retrying if the app's run holder or media closure
changed underneath (`lib/db/moveAppToProject.ts::runCrossProjectMove`). The
destination picker is an inline radio list over the Projects
where the member also governs placement, because a second floating surface opened
from inside the popover renders beneath it. Governance requires `delete` on both
ends, `deleted_at IS NULL`, owner retention, and an exact empty lookup closure:
an app whose blueprint references lookup tables or has capture rows or
capture-submission intents cannot move, and stored lookup edges that disagree
with the blueprint are themselves a refusal until repaired. Same-Project
case-data recovery is a separate, always-available repair.

Project deletion is globally disabled until Nova has an audited whole-tenant
deletion lifecycle.

### Run holders and the app-write surface

A run holds its app through a server-minted nonce; every claim mints one and every
terminal write compare-and-sets against it exactly. Only `lib/db/apps.ts` and
`lib/db/credits.ts` may issue `apps` DML, and
`lib/db/__tests__/runHolderWriteGuard.test.ts` pins that structurally — a new
writer outside those two files fails the build rather than quietly skipping the
holder proof. Operator recovery (`scripts/recover-app.ts`) delegates to
`recoverAppStatus` behind paired explicit token flags and never writes directly.

Request and run timings are three independently authored fields in
`config/runtime-capabilities.json`; none derives from another.

---

## What remains

Fourteen units, one file each. **Every entry below is a pointer, not a summary of
record** — the contract, the binding CommCare facts, the wire shapes, and the
observed outcome live only in the linked file, and each entry names what it is
withholding so you can tell when you need it. Read that file, and
[`00-contracts.md`](complex-app/00-contracts.md), before you plan or implement.

### 2 — Project data tables workspace

[`complex-app/02-project-data-workspace.md`](complex-app/02-project-data-workspace.md)
· depends on nothing · blocks unit 3

The Project data workspace — schema and row grid, atomic CSV import, revisions,
conflict handling, permissions — plus the select options-source editor and the
confirmation UX that lets lookup schema governance leave package-private scope.
**The file holds** the asymmetric source-mode switch, the one semantic that
silently ships an inert feature when missed.

### 3 — SA, MCP, and docs for conditions and lookups

[`complex-app/03-sa-mcp-and-docs-for-conditions-lookups.md`](complex-app/03-sa-mcp-and-docs-for-conditions-lookups.md)
· depends on unit 2 · blocks nothing

Expose the shipped condition and lookup vocabulary through both the
camelCase chat tools and the snake_case MCP projection, with public docs and one
integrated end-to-end flow. **The file holds** the two pieces of engineering under
that packaging: the SA identity bridge and the null-clears contract.

### 4 — Grouped case tiles

[`complex-app/04-case-tiles.md`](complex-app/04-case-tiles.md)
· depends on nothing · blocks nothing

Group a child case list under its shared parent, with the header rows drawn from
the group's first case. **The file holds** the `header-rows` attribute and the
core fixture that misspells it, the companion entry datum, why grouping must
happen at the data layer rather than after a page is fetched, and why the group
key must be a real case index.

### 6 — Attachment target-aware emission and link UX

[`complex-app/06-attachment-emission-and-link-ux.md`](complex-app/06-attachment-emission-and-link-ux.md)
· depends on unit 11 · blocks nothing

Save-to-case attachment shapes, target-aware URL-column emission, explicit link
presentation, and the opt-in legacy attachment mode. **The file holds** the exact
bytes endpoint and the HTML viewer route that must never be linked instead, the
calculate that builds the URL, and why Web Apps never displays a case attachment
in-app.

### 8 — Organization model and locations store

[`complex-app/08-organization-model-and-locations-store.md`](complex-app/08-organization-model-and-locations-store.md)
· depends on nothing · blocks units 9, 10, 11, 13

The app-wide custom-field catalog, stable level and site codes, app-scoped
location rows, archive and reassignment rules, and role-aware owner validation.
**The file holds** the two independent flag axes that are classically conflated,
the owner-set assembly with its two easily-dropped filters, and what actually
happens to cases when a location loses its last worker.

### 9 — Usercase, owner sets, restore scope, and wire

[`complex-app/09-usercase-owner-sets-and-wire.md`](complex-app/09-usercase-owner-sets-and-wire.md)
· depends on unit 8 · blocks unit 13

Usercase materialization, owner-set derivation, tenant-complete restore closure,
and the flat location fixture. **The file holds** the three-rule liveness fixpoint
the preview must reproduce rather than approximate, the flat fixture's byte
contract, and the instance-declaration precondition that silently voids the whole
fixture when missed.

### 10 — Representable automations and setup guidance

[`complex-app/10-automations-and-setup-guidance.md`](complex-app/10-automations-and-setup-guidance.md)
· depends on unit 8 · blocks units 11 and 13

Automation schemas limited to what HQ can represent, plus regenerated setup
guidance. **The file holds** the closed criteria, action, recipient, and content
vocabularies, the real cadence and cap (and the widely cited figure that is
wrong), the total absence of a REST surface, and which criteria are constructible
versus setup-artifact-only.

### 11 — Deployment core and artifact

[`complex-app/11-deployment-core-and-artifact.md`](complex-app/11-deployment-core-and-artifact.md)
· depends on units 8 and 10 · blocks units 6, 12, 13

Durable deployment and resource-mapping records, preflight, ownership and
adoption, independently retryable phases, and the target-aware setup artifact.
**The file holds** the state machine enumerated end to end, including which state
a required-phase failure lands in and what it withholds.

### 12 — Push and provisioning drivers

[`complex-app/12-push-and-provisioning-drivers.md`](complex-app/12-push-and-provisioning-drivers.md)
· depends on unit 11 · blocks units 13, 16, 17

Referenced-table push, location push, and explicit worker provisioning against
unit 11's ownership mappings. **The file holds** the fixapi workbook's actual
format, why a tag rename cannot be an in-place PUT, the v0.6 location API's
semantics and caps, the user resource's create-only identity, and which part of
the org model is not pushable at all.

### 13 — App setup UI, SA, MCP, and docs

[`complex-app/13-app-setup-ui-sa-mcp-and-docs.md`](complex-app/13-app-setup-ui-sa-mcp-and-docs.md)
· depends on units 8, 9, 10, 11, 12 · blocks nothing

The App setup workspace's three remaining sections — Organization, Automations,
and Deployment — plus the SA and MCP surfaces and public docs for units 8 through
12. **The file is deliberately short**: its substance is the prerequisite units'
files and the baseline UI review in the contracts.

### 14 — Exclusive form links and sections

[`complex-app/14-form-links-and-sections.md`](complex-app/14-form-links-and-sections.md)
· depends on nothing · blocks unit 15

An exhaustive-`else` link projection with durable link identity in one release,
then form sections in authored order. **The file holds** the six end-of-form
workflow mappings and their traps, the closed stack vocabulary, the negative sweep
proving sections have no wire notion, the no-expression-slots design fence, and
the verified mechanics that make sections beat multi-form chains.

### 15 — Nested menus and linked-form reuse

[`complex-app/15-nested-menus-and-linked-form-reuse.md`](complex-app/15-nested-menus-and-linked-form-reuse.md)
· depends on unit 14 · blocks unit 16

One-tier menu nesting and native linked-form reuse. **The file holds** what
`root_module_id` and `put_in_root` each emit, and why shadow modules are
wire-level duplication rather than reference — which is what lets Nova emit the
shape with no shadow authoring object and no domain toggle.

### 16 — Session endpoints and deep links

[`complex-app/16-session-endpoints-and-deep-links.md`](complex-app/16-session-endpoints-and-deep-links.md)
· depends on units 12 and 15 · blocks nothing

Session endpoints and shareable deep links resolved against the selected HQ
server. **The file holds** the emission shape and why it pushes rather than
creates, why `respect_relevancy` exists only on forms, what a case-list endpoint
excludes, the runtime replay sequence, and the documented divergences that are
sharp edges rather than Nova bugs.

### 17 — Multi-select, related cases, and profile extensions

[`complex-app/17-multi-select-related-cases-and-profile.md`](complex-app/17-multi-select-related-cases-and-profile.md)
· depends on unit 12 · blocks nothing

Three independent vocabularies that ship as three PRs because they share only a
dependency. **The file holds** the multi-select datum and its virtual instance,
the related-case query keys and exclusion filter, the three authorable `cc-*`
profile keys against the reserved emitter-owned ones, and the removed `CaseSearch`
fields that must never be modeled.

---

## Dependency order

Each unit's prerequisites, matching the "Depends on" line in its file:

| Unit | Needs |
| --- | --- |
| [2 Project data workspace](complex-app/02-project-data-workspace.md) | — |
| [3 SA, MCP, docs](complex-app/03-sa-mcp-and-docs-for-conditions-lookups.md) | 2 |
| [4 grouped case tiles](complex-app/04-case-tiles.md) | — |
| [6 save-to-case and attachment link UX](complex-app/06-attachment-emission-and-link-ux.md) | 11 |
| [8 organization and locations store](complex-app/08-organization-model-and-locations-store.md) | — |
| [9 usercase, owner sets, wire](complex-app/09-usercase-owner-sets-and-wire.md) | 8 |
| [10 automations](complex-app/10-automations-and-setup-guidance.md) | 8 |
| [11 deployment core and artifact](complex-app/11-deployment-core-and-artifact.md) | 8, 10 |
| [12 push and provisioning drivers](complex-app/12-push-and-provisioning-drivers.md) | 11 |
| [13 App setup UI, SA, MCP, docs](complex-app/13-app-setup-ui-sa-mcp-and-docs.md) | 8, 9, 10, 11, 12 |
| [14 form links and sections](complex-app/14-form-links-and-sections.md) | — |
| [15 nested menus and linked-form reuse](complex-app/15-nested-menus-and-linked-form-reuse.md) | 14 |
| [16 session endpoints and deep links](complex-app/16-session-endpoints-and-deep-links.md) | 12, 15 |
| [17 multi-select, related cases, profile](complex-app/17-multi-select-related-cases-and-profile.md) | 12 |

Four units have no outstanding prerequisites and can start in any order: 2, 4,
8, and 14. They are the independent entry points — every other unit descends
from one of them.

The deployment chain (8 → 10 → 11 → 12) is the critical path: it gates units 6,
13, and 16, so anything needing a real HQ target waits on it. The navigation
chain (14 → 15) runs independently until unit 16, which needs both.

Units 3, 4, 6, 13, 16, and 17 are leaves — nothing waits on them, so each can land
whenever its own prerequisites are met. Grouped case tiles (unit 4) are both an
entry point and a leaf: nothing blocks them and nothing waits on them, which makes
them the natural filler whenever the deployment chain is blocked on something
external. Unit 9 sits off the critical path too — only the App setup UI waits on
it, so it can follow unit 8 without holding up unit 11.

---

## Keeping these files honest

These files change in the same PR as the behavior they describe. Five rules:

- **Present tense only.** Describe what the system does. If a sentence needs a
  date, a PR number, a revision, or a branch name to make sense, it belongs in the
  commit message.
- **Move a unit, don't annotate it.** When a unit ships, its contract moves into
  [What is built](#what-is-built) rewritten as current behavior, and its unit
  file, its entry under [What remains](#what-remains), and its dependency row all
  disappear together. No "shipped" markers, no status column, no changelog entry.
- **One home per fact.** A binding CommCare fact lives in exactly one place: this
  file once it is shipped behavior, or one unit file while it is not. The index
  entries and the dependency table restate nothing — a fact duplicated into the
  index is a fact that will silently rot there.
- **Anchor every platform claim.** A CommCare constraint carries its
  `file::function` when it is load-bearing. A claim with no anchor is a claim
  nobody can re-verify when upstream moves.
- **A new unit is a new file.** Adding one means a file under `complex-app/`, an
  entry under [What remains](#what-remains), and a dependency row — never a
  section grafted into this file.
