# Forms, case changes and XForms

An advanced form can ask the worker to choose two records from the same list, load a value from each, update one
and open a third. A second entry can run those same questions with different selections. Both entries must still
edit the same form in HQ, submit to the same form namespace, and keep each property, connection, datum and
export column under its existing identity. That is the group 7 acceptance app. Group 8 adds a form made in
Vellum whose controls, submitted data and case changes have different orders. Its load, worker answers, case
effects and forwarded Connect records must survive a Vellum save and a Nova publish.

This plan covers all 45 manifest entries owned by `forms-and-case-management` and all 40 owned by `xform` at
Nova `9a6dc789`. Neither owns a circumstance in `lib/publish/hqFindings.ts`. The ledger at the end assigns each
entry to its implementation and controls. The gate, corpus, first-publish and release rules in the
[Step 7 plan](../7-rest-of-model.md) apply to every slice. The source evidence below is static at the five
revisions in [proof/pins.json](../../../../proof/pins.json) and Vellum `01215f251c57`. The experiments below are
**implementation acceptance tests**. They are separate from what the existing corpus has already demonstrated.

## F1. Selection identity and entry execution

**Document.** Add ordered, form-local `caseSelections` and `computedDatums`. A selection has a UUID, its
expected case type, an author-facing name, its stable submission tag, and exactly one source. A chosen source
names the list module by UUID and may narrow by one named index to an earlier selection. The four new automatic
sources are an entry expression giving a case ID, a worker data key, a Project lookup table and column UUID, and
a named index on an earlier selection. Retain the existing automatic worker-record source. Require the expected
case type and mode in the automatic-selection editor and gate. HQ's advanced actions page requires both even
where its build would accept a blank. The worker-record mode supplies the worker's record type. Give a computed
value a UUID, session key and entry expression. Bind each referenced case or computed value to that UUID before
resolving any wire name. Never infer one of two choices from the case type, source list, translated caption or
array index. Keep list identities distinct from entry-supply identities. An edit to an order or label leaves all
references intact.

The expected case type on an automatic action belongs to the editor and its catalog. For a raw ID, worker-data,
lookup-row or earlier-index supply, resolve the ID against the worker's authorized case snapshot. Preserve HQ's
count/existence assertion. An existing case of another type can satisfy it. The built automatic datum has no
case-type predicate. The worker-record mode has its own type predicate. Neither the expected type nor an ID
can grant access to a case. Evaluate reads against the reached row and keep its actual type for downstream
effects. Apply F4’s admissibility rules when a write would violate that case’s stored type or property
semantics. An absent ID, inaccessible case and an ID of another type each get the native outcome appropriate
to the supply. Prove this with a declared household supply whose ID resolves to a visit, independently through
a raw expression, worker data, a table and an earlier index. Compare it with the worker-record mode, an empty
value and an out-of-snapshot ID. Verify the emitted datum and assertion, the Preview entry and the exact row
touched by a submission. See pinned `EntriesHelper.get_auto_select_datums_and_assertions`,
`get_auto_select_assertions` and `get_datum_meta_assertions_advanced`.

Absence of an explicit selection list keeps the existing derivation from the menu chain plus the worker load. An
explicit empty list means no loads. Derive repeatable synthetic identities for the implicit entries from form
UUID, supplier UUID and role, including the automatic worker. Materializing the list on the first edit keeps
those identities and allocated/held tags. On reading a source, canonicalize to the implicit form only if
re-deriving gives the identical effective sequence, tags, supply identities and all writes. Resolve a re-read by
form identity and held tag, then the existing identity matcher, rejecting ambiguous matches. Split compound
edits into one batch that can update references, placements and ordering. The first publish holding a
selection's tag keeps it even if the selection writes no case. Use the existing identity-move review before
changing published tags, switching module kind, removing a referenced supply, or moving an action to a different
submission path. No durable HQ object identity newly belongs to the blueprint.

**One entry plan.** Extend `advancedEntryDatums.ts`, `entryDatumSupplies.ts`, `entryCaseIdentity.ts`,
`advancedSelections.ts`, `formCaseEntryPlan.ts` and `formLinkProjection.ts::entryDatumIds` to return ordered
supplies, their identities, when each is visible, the realigned emitted ids, list/detail configuration,
assertions and carried values. Share it between the checker, module kind, generated session paths, local suite
and XForm, HQ writer, link/endpoint arguments, Preview and the reader's post-emission check. A form expression
can read all supplies available at entry. Each auto-selection and computed value can read only the preceding
supplies actually bound there. Menu displays and deep links use their own entry point and stage. A computed
`supply_point_id` is a normal supply on that advanced form. The decoded source still participates in the
existing `commtrack-off` publish check. A different form or a duplicate datum supplied by CommTrack gets no
borrowed value. Treat ambiguous or malformed generated keys under the existing collision/build/runtime rows.

Keep the four author-facing form types. For an advanced form, HQ's registration test for the module type, with a
qualifying **single root open**, supplies the form's own newly created case. Otherwise the last manually chosen
selection of the module case type is the own case. A qualifying unlinked repeat open with no manual selections
creates per row and supplies no singular own case. An entry with other chosen cases and no own case is
representable. An author can add selections to a registration. Derive form-entry sync reasons from actual
selections, even for registration, and update reads of `CASE_LOADING_FORM_TYPES` that choose screens, filters,
own writes or links. Keep the menu's shared selection only where the effective prefix agrees between the actual
entries. Do not convert one form's loads into another form's parent chain.

**Build and read.** The HQ source for this is `models/forms.py::AdvancedForm.is_registration_form`,
`models/form_actions.py::{LoadUpdateAction,AdvancedOpenCaseAction,ArbitraryDatum}` and
`suite_xml/sections/entries.py::EntriesHelper.{get_datum_meta_assertions_advanced,get_auto_select_datums_and_assertions,add_parent_datums,configure_entry_advanced_form}`.
Loads are ordered as stored, followed by arbitrary datums and then new-case datums in the built entry,
accounting for parent realignment. Manual selection uses the load's case type and the chosen module's short/long
details and filter. HQ resolves absent details-module references by type with its
own-module/first-matching-module precedence. Resolve that choice once on read. Recompute long-detail
confirmation based on whether another load references the selection and whether details are inline. A
worker-record load can stand first and supply the filter of the next manual selection. For automatic fixture
selection, assert one fixture row, one value and one case. Worker-data and earlier-index modes assert one value
and one case. Raw and worker-record modes require one matching case. Preserve the exact suite assertions and
failure ordering rather than silently selecting a first row.

Add explicit selections, computed datums, a worker-record list and `autoSelectSingle` to the existing reasons
for an advanced menu. An imported advanced menu retains its kind. Give its own case-list menu item the rows HQ
builds (open cases of the menu type), even when a form's selection or inline search draws different rows. Model
each surface's effective selection separately with the list/search work. For an edit that would broaden a
published basic menu's narrowed menu item, show the actual move and affected item before accepting the edit, or
keep the menu basic if its required behavior cannot be reproduced by advanced emission. Apply the actual
registration-from-case-list contract across forms: the same set of manually loaded types, predecessor chain,
last type equal to the module type and same final tag. Keep advanced multi-select unavailable. See HQ
`helpers/validators.py::AdvancedModuleValidator.validate_with_raise`. A worker-record list declares the existing
`user_case` privilege and uses the same Project-scoped store and worker-record identity rules as other reads.

`Module.autoSelectSingle` takes effect on a manual datum that uses that list module. The advanced module's own
list menu item never auto-selects. Refuse Web Apps on a datum that can auto-select its single row with a confirm
detail, regardless of the current row count. A future single row suffices. Offer Android, removing the
auto-select or removing the confirmation where meaningful. In Preview, walk ordered, UUID-keyed list steps on
real data. Back truncates the executed prefix to the manual-input boundary. Discard every value from that
boundary forward, including independent manual selections, auto-selected datum values and generated values.
Retain authoring UUIDs and the prior prefix. Re-execute the suffix against the current scope, as Core
`CommCareSession.stepBack` unwinds non-user-input steps and Formplayer replays the selected prefix. Deep-link
launches bind the same supplies. Select A and B at two independent lists, generate a value and back up to A.
Choose A2. Ask for B again, generate a fresh value, and assert the submission reaches A2/B2 and neither former
target. Test
zero, one and two matches, confirm/no-confirm, same-list choices with distinct IDs, parent realignment, first
worker load, missing automatic row, missing computed input, a registration that loads another case and a handset
opening the module's list menu item.

Builder puts an ordered “Cases this form uses” editor next to case changes and a computed-values editor at form
entry. Extend existing case-operation tools with a selection target and entry-value reads, selection
add/edit/remove/order on the form, and equivalent mutation/diff/import paths. Expose the source list, what it
chooses and dependent references. Keep tags in placement/identity details. Use bound session references in
public tools. No form author has to construct a datum ID.

## F2. Several entries running one form

Store `shadowOf` as a parent form UUID plus an **ordered** list of either a referenced parent selection and its
replacement source/settings or an extra local selection. The entry owns its name, display condition, workflow,
media, submit label, arguments and computed values as allowed by its own fields. It opens the parent's questions
and parent open actions. The parent holds the only form content and case-write definitions. Prevent cycles and
dangling uses. The shadow must live in an advanced module and the parent must be an ordinary advanced form. A
basic parent is an error in the outline: HQ's `ShadowForm.get_shadow_parent_options` offers only
`form_type == "advanced_form"`, and `_merge_actions` reads `source_actions.load_update_cases`. A parent
conversion is a separate ordinary, valid module-kind edit with its existing identity-move consequences; choosing
a basic form alone cannot silently convert it.

HQ's `models/forms.py::ShadowForm._merge_actions` walks **only** the extra load rows and in their order. A
matching tag copies the parent's load and replaces its selection fields. A new tag starts a fresh load. An
omitted parent load disappears. The parent XForm can only read a tag that the effective shadow entry supplies.
HQ's shadow validator inherits IndexedFormBaseValidator, whose extended validation does not call the shadow's
check_actions method. A parent load that no part of the parent form reads or writes can therefore be omitted; a
parent preload/update/close/index needing its id cannot. A shadow's own extra open actions, preload and property
writes are inert; skip them under their existing manifest classes. Refuse missing parent, shadow-of-shadow,
missing required tag or a retiring stock/fixture setting under its specific row. Show the parent as the edit
destination for shared questions and the entry as the destination for selection overrides.

Current `hq/entryFacts.ts` stores form facts under xmlns and `hq/publishedCaseBlocks.ts` skips shadows. Key
entry facts, reference matching, link/endpoint targets, deployment mapping and editing by aligned form identity
(real target form id / Nova UUID). Key **content** by the ordinary parent. `hq/appReading.ts` already
distinguishes the resource's inherited xmlns from the absent stored shadow xmlns. Emit the parent once, preserve
the shadow's own id and resolve its parent through the target's form-id mapping. Preserve an imported parent's
xmlns at origin and derive it from its UUID on another target. Never give the shadow a second source attachment.
Read/import/baseline comparisons must survive source ids scrubbed by app_source. A shadow with a different load
order, an extra read-only datum and its own workflow must open, save, submit through the parent's namespace,
link to the correct entry, and keep its own form id on republish. Removing a parent or shared question in use
names every dependent entry. Test two shadows of one parent plus an unrelated duplicate non-shadow xmlns that
still refuses.

## F3. Case paths, writes and opening values

Use group 4's named relation path and group 1's platform-proven name token. Store steps as index names beginning
at the *selected* case. The path can be precise even when its destination type is unknown: a selected record and
`index/parent/index/user` determine which record to read. Keep possible destination types from the catalog,
including a child with multiple parents or both relationships, and narrow by an explicitly selected/literal type
when known. For reads with no possible known type use the case property's stored text. For writes resolve the
actual scoped row and apply the typed operation to its real type. For a non-singleton destination expand the one
author-facing write into disjoint, typed cases keyed by the actual destination type. Each case must write its
declared property/facet safely. For an open destination, only the common text/facet mapping safe for every
permitted type has a catch-all branch. A schema-incompatible write names the alternatives and lets the author
constrain the relation or choose a common storage type. Reference indexing covers every branch and any
open-world dependency. No missing index implicitly means the current worker. `user/p` walks an index named
`user` from the loaded case, subject to the relevant project privilege. Apply the target rules below to each emitted effect. Match HQ's separate restrictions on indexed loads, basic forms opening their own cases and preloads.

Expose name, owner, external ID and supported special keys as typed effects at the reached case, including an
ancestor's name/owner via the original action key. A dynamic relationship reads a non-repeat question by UUID
and writes the evaluated connection kind. HQ also selects the unowned extension owner when the answer is
`extension`, otherwise its meta user ID. Honor the editor/build/runtime constraints on source load renaming,
prior open indices and empty/invalid relationships. Keep the exact index name, including hyphen where the
producing editor keeps it. Test two same-type selections with different ancestors, two parent types, child and
extension on successive submissions, an absent index, and a label supplying a name/value.
`forms/advanced/case_config_ui.js` allows labels in its picker. A basic own update keeps its own picker rules.

`location_id` maps to HQ's separate case location, and `hq_user_id` writes through to its external id as well as
its supported dynamic value. On the device ordinary update keys follow `CaseXmlParser.updateCase`; the HQ server
special cases these in
`form_processor/backends/sql/update_strategy.py::SqlCaseUpdateStrategy._apply_update_action`. Model a scoped,
opaque case-location ID and worker identifier as case data. Add a nullable case-location text column to the
active case store; it is distinct from Project place UUID and access membership. Preserve the separate device
transaction patch and server observation where the wire yields different projections, using the existing
snapshot/receipt boundary. Never change authenticated worker identity or Project permissions through a
case-property write. Retain the worker-profile-managed key refusals where applicable. Exercise a non-upload
ordinary/ancestor/child/worker/advanced/Save to Case write followed by a restore and query of both the visible
key and the server facet; an upload still takes the attachment branch.

A condition on a whole nonboolean answer stores an explicit effective-boolean operation on a question reference.
Preserve Core's value conversion, in particular blank versus the text `false`, and the basic/advanced operator
settings HQ's page keeps. For “save only if changed” store it per eligible write, including
name/owner/external-id effects, on basic own and child, worker, advanced load/open. Choose its comparison from
the actual generated case-block target and leaf. HQ's `XFormCaseBlock.add_case_updates` compares the casedb leaf
with the question and checks node presence; a newly created case, absent property, empty answer, and a name
mapped to `case_name` must get the same row-presence decisions. Do not substitute a dirty UI bit or
unconditional write. Retain the separate inert class in a space without `SAVE_ONLY_EDITED_FORM_FIELDS`; apply
existing publish confirmation and adoption checks.

The existing `lib/case-store/postgres/submissionEnvelope.ts` uses the current SQL transaction's pre-effect
rows. Native initialized forms can retain an older device view. At entry issue a server-authenticated snapshot
handle for this form/entry, revision, selected data, tenant, member and effective worker, with the resolved
targets, lookup revision and typed read set needed by its bounded expressions (authorized rows/relations and
absent reads, including repeat/query evaluation). Bind a versioned, signed snapshot manifest to the already
authorized restore projection by content digest. Return the signed evidence with the bounded projection and
keep it beside the tab's running form or its authorized saved draft; verify audience, digest, entry and
current access at submit. For arbitrary supported lookups evaluate against the signed immutable row set
through typed SQL values within the transaction. A resumed draft keeps its original evidence. A mismatched or
unavailable snapshot requires reopening and never falls back to current rows. No shared server form session
is required. Bind answers/new rows to this entry
and evaluate preloads, source lookup, indexed target resolution and only-if-edited comparisons using this view.
SQL resolves the actual emitted effects and rechecks the *current* tenant, worker access, existence/allowed type
and rolling schema under the write lock. It does not recalculate whom a submitted id meant from a later index.
An obsolete/inaccessible target rejects atomically. The receipt binds entry, revision, submitted effects and
instance id to the idempotency key. A retry with the same content returns its original result; differing
content under that key rejects. Check postconditions with independent row/history observations.

Seed property A, enter and preload A, then another submission saves B. An unchanged A omits the leaf and keeps B.
An edited C emits a write to the originally reached authorized id. Relink the child from P1 to P2 between entry
and submit; the scoped action still addresses P1, never P2. If P1 leaves authorized scope the whole submitted
write fails. A missing index gives a blank read; whether a *write* is omitted depends on the actual block
produced. The current Nova SQL test `submissionEnvelope.postgres.test.ts` (household without a parent) proves
only its legacy Preview result: it skips that ancestor write and commits the own-case change. It does not
observe a worker submission. HQ `XForm._add_case_updates` appends an ancestor case block under each named
path. `XFormCaseBlock.make_parent_case_block` binds its `@case_id` to the index chain and supplies no
whole-block target-exists relevance. An irrelevant containing group omits the block. A relevant case element
with an absent or empty id must fail Core `CaseXmlParser.parse` or `BulkProcessingCaseXmlParser` mandatory-id
validation even when its update leaf is irrelevant.

Use an actual HQ-built basic and advanced form, its Vellum-saved version, and Nova's corresponding local
archive with matching source placement. Start with an existing owned case whose parent link is absent and an
own-case sibling write. Inspect Android's and Formplayer's actual serialized submissions, separately for a
relevant ancestor block, a false whole-block/ancestor guard, a missing source answer, and a valid link.
Record whether the case node exists and its exact id before running each native processor, and independently
send that XML to HQ and read receipt, property and case history. A worker that serializes the case with an
empty id fails submission in Preview and leaves every SQL write uncommitted. A worker that genuinely omits
the block keeps the own write with no ancestor effect. Implement the evidenced result through the normal
Preview path per declared worker. Keep the legacy SQL test as evidence for its low-level input with no emitted
ancestor effect, add a separate blank-id rejection, and bind the end-to-end Submit to the actual generated
program. Existing successful receipts and case rows retain their original effects on replay. Where a worker
would fail on already-saved data, show the missing relationship at submit and allow explicitly guarding the
whole transaction in an HQ-editable placement or selecting a case with the link. Never silently add a guard
to a held/issued form. A supplied id from another Project can neither authorize a target nor write a row.
Exercise every branch with an intervening submission or relink and a retry after a committed response is lost.

Keep preloads at their actual stage. Add ordered, typed form opening assignments with a field UUID destination,
selection/worker source and named relation/property path, and attachment to its owning basic/advanced load.
These are one-time reads of case data, independent of a question's default and calculate. HQ's
`XForm.add_case_preloads` maps `name` to `case_name` and `owner_id` to the case attribute, and its case builders
append these setvalues after authored defaults. Preserve the `case_preload` kept through an HQ basic-settings
save, including into a label, calculated hidden field or a repeated question in the classes the manifest allows.
Apply the typed setvalue at its actual event, cardinality, answer cast and position, including zero target
nodes. Use the current canonical default for an equivalent *existing* default; on import retain the actual stage
whenever its removal would change even one later observation, or conservatively retain the late assignment
without trying to prove equivalence. On export use the original action/slot, never move a late read into
Vellum's field default merely because the sampled data agrees. Test an earlier default reading before the
preload, a transitive calculate, a hidden value with a calculation overwriting a preload, zero/one repeat row,
and a group whose relevance changes as a result. Extend `reader/caseManagement/preloads.ts`, its structural
`laterLoadReaders` decision and the load evaluator in X2.

Infer property types from *submitted leaf values*. Keep the existing int/decimal join and text/single-select
behavior. Join single- and multi-choice as multi-choice in first writer order; merge options by exact value,
first label/translation wins. Other incompatible writers join on their lossless submitted text, including
date/time/location, and cast only at the receiving question's answer boundary. A direct date-time question into
an untyped update emits a day, so it is a date writer. A full-instant write retains `xform/datetimeCaseValue.ts`
and the current UTC precision. For a source carrying both shapes preserve each write's projection through a
typed value conversion. Keep Core device rendering and HQ's datetime normalization observable in their
respective records. A bad stored string preloaded into a typed answer follows Core's failed cast with a named
field; do not turn it into an arbitrary default. Carry existing data safely through an explicit property retype
with the existing schema preflight/parking and transaction rules. A read-only import does not convert anyone's
existing cases. Include mixed text/date, single/multi, integer/decimal, offsets across midnight, a casting
preload, and two writers from the same hidden question with different load/insert outcomes. The algorithms enter
`casePropertyTypes.ts`, `reader/caseManagement/catalog.ts`, rule sets and store materialization together.

Add a translatable `Form.submitLabel` through the existing unit machinery. Web Apps draws it; Android uses its
own submit control. Prove a non-default label, edit it in Bulk App Translations, and check both workers and the
imported form. Group 3 supplies language-specific media and group 2 supplies shared settings and group 5's
navigation uses group 7's session supply resolver for form filters and endpoint computed arguments. Reuse the
same record-dialect serialization and reference indexing for a navigation slot reading a form's supplied value.
An argument cannot read a datum before it exists.

## F4. An ordered set of effects a worker can actually submit

Seven of group 7's entries are in `questions.json` and do not appear in the original outline. Read an
operation's block, its place in the submission and the repeat instance generating it as one effect group. X3
below adds authored positions and multiple effects sharing a block. F4 owns the meaning of that group. Evaluate
form expressions, index targets and edited-only comparisons against F3's immutable authorized *entry* view and
submitted answers. Correlate repeated creates by operation UUID and row. Recheck scope, worker access, current
target/type and the ordered effects' postconditions under the SQL transaction lock, and keep a single atomic,
idempotent `applySubmission`. Extend `caseOperationOrder.ts`,
`caseRetype.ts`, validator `caseOperations.ts`, `submissionEnvelope.ts` and the operation-order reader. Resolve
addresses from the committed document in scope, even if the client sends an expected type. A rejected effect
rolls back the entire receipt and every write. The preview can show the worker which form and case change
failed.

Pin independent ordering oracles. Core's `CaseXmlParser` walks blocks in XML order. HQ's
`casexml/apps/case/xform.py::{get_case_updates,order_updates}` groups by target id and stably sorts blocks by
the first action kind in HQ's priority order. `update_strategy.py::_apply_create_action` and Core's
create-overwrite path can change the type of an existing id. See X3 for the distinct device and server effects of empty blocks. Do
not sort the authored operations merely to placate the current reader: preserve the exact submitted blocks, and
admit a shared outcome where the concrete aliasable effects commute or run in the same order. Model disjoint
literal IDs, fresh IDs, repeat-local create references, distinct keyed namespaces and proven different targets
separately from two unresolved IDs; different question UUIDs alone prove no separation.

| Source condition | Admission and counterexample |
| --- | --- |
| Several updates to the worker, including conditional or repeated updates | Hold each effect, position and condition. Resolve the worker once to the one eligible open, owned worker row. With two rows writing `visited`, observe the last present value and the number/order of submitted blocks. With a false condition observe no corresponding block. A second worker with the same submitted identifier in another Project remains untouched. |
| Several changes of the form's own case | Keep overlapping property writes and redundant closes as separate ordered effects where the observed native/server effects agree. Test an authored block writing `first` and the appended basic action writing `last`, also one absent on submission. The own operation's lifecycle remains its own action. A second per-case write is not a second own operation. |
| Root or repeat keyed create mixed with other writes | Hold an order when both readers produce the same contract for aliased ids, using the actual placement and typed effects. Split the residual as `questions/keyed-create-incompatible-case-order` (REFUSED, unrepresentable identity/effect). For a pre-existing K compare a root update to K with a later repeated create of K that sets a different name: device form order and HQ's create-first order can select different final names. Repeat with a fresh distinct id and with equal/no overlapping effects as positive controls. Remedy by giving the new case a distinct key or arranging create before its dependent writes on both readers. |
| A form retypes a case another change may address as its old type | Track finite possible types across each ordered effect, also across repeat iterations. An earlier create overwriting K as B followed by a write to K uses B's schema. Admit a write on a common property/facet with the same meaning on both possible types. For an incompatible typed write split `questions/retype-leaves-write-without-common-type` (REFUSED, untypeable): a later write of text to B's integer property cannot keep both the typed property's contract and that raw text. Reorder a type-specific update before retype or narrow the target. Test two rows aliasing K and an unrelated id as control. |
| A block names a different type from the case it reaches | The Vellum block's editor type scopes its exported property inventory and may differ from the actual target. Hold it as an optional **property catalog context**, separate from the reference that identifies and authorizes the target. Preserve `case_references_data.save` and the actual row's schema. A link's declared destination type is also real submitted data: Core and HQ store its type alongside the referenced id. Hold the declaration separately from the per-row type resolved in the tenant, through the group 4 relation model. Looking up the case by a declared type must produce the same result as that reader's lookup, including absence. An editor metadata type alone cannot fail the write. A write whose actual target schema cannot represent its value joins the preceding untypeable class. Control: a form selects a family, a block labelled visit writes a text property on that family, and its link labels a real family as visit; compare both dictionaries, stored records and subsequent relation reads. |
| Retype keeps a property whose types disagree | Use a lossless shared property type on both types where all writers permit it, and the existing explicit, reviewed schema conversion when the author chooses it. For an existing text value `blue` becoming an integer and a later numeric reader, keeping, coercing and discarding/parking it have visibly different results; the pinned case processors simply retain it. Split that residual as `questions/retype-retains-incompatible-value` (REFUSED, untypeable). A fix is to give both types compatible storage or copy/convert the property deliberately before retyping. Exercise already-saved values, including one unparsable value and one compatible value. An HQ read cannot silently convert a fleet's stored case data. |

A split takes effect only with a positive witness from the reader that establishes the reason, both native and
HQ observations for a divergence, and an accepted neighbor. For an order conflict run Android and Formplayer
separately on the same *existing* case. Offer a single declared platform wherever that reader and HQ agree for
the admitted class. A single successful sample, or agreement only on a brand-new case, cannot certify an
unresolved alias. The existing broad not-yet IDs leave with their narrowed HELD classes and these specifically
named refusals. Distinguish an unsafe author edit from a broken HQ app in the copy: for a valid HQ shape that
has no common typed meaning, explain the actual incompatible effects and the repair.

## X1. Question kinds, structure and addresses

Make primary-instance identity a form property: optional `Form.dataRootName` defaults to `data`. Make a field's
control parent and position the existing editable form tree. Give data placement an optional parent reference
(form root or group UUID) and sibling rank sufficient to keep the actual data order independent of body order. A
control-less node, Save to Case or Connect block can participate in that data ordering. Validate one rooted
acyclic tree per form, sibling names after placement, the allowable data parents, the same enclosing repeat of
each moved node, descendant references and generated node collisions. Build one pair of indices from these facts
for import, emitted data and controls, binding, `#form` paths, case-management question paths, generated nodes,
integration/attachment paths, Preview submission paths, and identity-move comparison. Replace literal `/data`
assumptions in `FormPath.root/parse`, parser/binder, printer, compiler, case reader, Preview and proof adapters.
HQ's `XForm.resolve_path` uses the actual root; Vellum's `parseDataTree` preserves it and
`mugs/baseSpecs.js::dataParent.validationFunc` checks the nearest repeat. A group move changes submission
addresses for descendants; present the existing publication-impact review before it commits. Default placement
for existing documents gives the identical XML addresses/order.

Classify submitted data names at two different boundaries. Retain the HQ build refusal
`questions/a-root-question-case-in-a-form-where-hq-writes-the-primary-case` when HQ `XForm.case_node` finds an own-namespace root
child named `case` and `_create_casexml` must add the form's nonempty basic case block. Removing that case
action avoids the build error. Runtime submission still has its own checks. In the generated primary *instance*
walk each reachable submitted descendant, including group/repeat wrappers, hidden nodes with custom
namespaces, embedded integration wrappers and children generated by HQ. Start at the children of the data
envelope, as Core `DataModelPullParser.parseBlock` does. Simulate the receiving parser's dispatch and where it
stops descending. Distinguish data belonging to a recognized transaction from an ordinary node accidentally
consumed as one. Apply this check at every authoring/import gate and to the built projections for each entry.

* Android `FormRecordProcessor` offers only stock-namespace nodes and case-insensitive `case` names to its
  transaction factory. Core `CaseXmlParser` requires a case id and modification date. Formplayer's normal and
  bulk submission factories also dispatch `case` ignoring case; a custom namespace or nested position does
  not make an ordinary case question usable. HQ's `casexml/apps/case/xform.py::_extract_case_blocks` tests
  the exact JSON key `case`, stops descending there, and yields only candidates with a case id; the version
  parser then checks the namespace/shape. A `case` group with no case id around a genuine nested case
  transaction can hide the latter from HQ. An ordinary submitted `case` answer, including `Case`, is
  REFUSED as `questions/submitted-node-consumed-as-case` independently of whether the app builds.
* Formplayer's `CommCareTransactionParserFactory` also dispatches `registration` ignoring case to
  `UserXmlParser`. It requires ordered username/password/uuid/date and commits a user. A normal question
  does not satisfy that contract. Android's form submission filter descends through the same ordinary group,
  and HQ's case extractor also descends through it. Offer ordinary `registration` on Android-only apps with
  an ordinary form namespace and no other dispatch conflict. On Web Apps refuse the ambiguous node, including
  a group shaped like a real user transaction. Do not represent a submitted worker registration as survey
  data. Keep the separate treatment of genuine form-wide registration namespaces.
* Also cover the rest of Formplayer's actual dispatch table. Case-insensitive `fixture` and `schema` need a
  fixture id and consume their subtrees. An ordinary field missing it fails; an actual fixture store write
  cannot stand for an ordinary field. Permit these ordinary names on Android under the same conditions as
  `registration`. Web `sync` dispatches only in `http://commcarehq.org/sync` (expects `restore_id`).
  A stock-namespace ordinary node is intercepted on both clients before local-name dispatch; only recognized
  ledger instructions belong in that namespace. Never classify those as namespace decoration. A different
  ordinary namespace with `sync`, or an ordinary `script` field on either platform, has no such dispatch.
  Retain Vellum's warning if present and the separate meta, invalid name, and generated-address guards.

Use Vellum-saved nested text, a group enclosing a real submitted change, a custom-namespace hidden field and a
generated wrapper as independent fixtures. Compare the emitted XML, Android's actual record processing and
device state, both Formplayer case modes and sandbox state, and a separate POST to HQ followed by its saved
form and case history. The survey question named `case` must reach its runtime refusal even when its build succeeds.
Positive controls are `case_note` and `script` retaining their answers and the nested change, and Android-only
`registration` with that same change. Check web refuses `Registration` and accepts a sibling spelling,
and that the server alone can miss the change under `case`. For a Hidden Value preserve its explicit namespace
URI, including inherited versus explicitly empty where meaningful. Resolve nodes by namespace and local name
under the actual owning parser. Add a lock flag on supported fields; Vellum `src/lock.js` writes it on the
bind, or the data node for its data-only kinds. It governs editing in HQ and the target's lock privilege. It
grants no Nova Project authority; an authorized Nova editor can change the setting with the consequence visible.

Extend the same kind/slot matrix the forms, validator and reader use. Add `acknowledge`, face capture and
Android app callout. Exact appearance `minimal` or `selectable` makes a passive trigger; another string can make
Android's trigger interactive, and a `floating-` prefix hides its widget. Use group 3's whole-string display
classification to preserve the effective kind and tokens. An acknowledge holds its answer and requiredness. Web
Apps auto-answers it, and Android offers a checkbox where visible. Face capture is an ordinary image upload on
Web Apps. Store max image dimension as a positive integer through 2,147,483,647; normalize `-1` as no limit and
preserve Vellum's custom/standard value as the same pixels. Use image resizing on the Android preview path and
original bytes on the Web Apps path. Verify sent file metadata/dimensions independently.

A callout stores the external Android action/template, typed extras (key and expression), and typed response-key
to form-field references, plus its field identity. A second ordinary input can reference this callout's UUID.
Vellum `src/intentManager.js::writeXML` writes the head intent, binds the input and writes the response
destinations. Android `WidgetFactory` uses the intent appearance even on an ordinary input. A standalone callout
requires Android: Web Apps' unsupported placeholder can otherwise be submitted. The auxiliary appearance alone
is ignored on Web Apps. In a form where its referenced callout requires Android, the combined document is
Android-only despite that auxiliary feature's ignored Web Apps cell. Derive template/custom privilege and
separate creation-only gates from emit/publish requirements. No arbitrary head XML. Keep the print callout,
unmapped referenced head and dangling callout rows at their existing standings. In Android-mode browser Preview,
show the target app, invoking input and evaluated extras to the worker. The local return dialog can supply an
optional primary string for the invoking input and any subset of the named results, independently representing
omitted and present-empty values. Offer it even when the mapping is empty. Apply the return through normal
answer, validation and relevance processing. Cancellation leaves prior answers alone. No package launch, server request to an action URI, or fabricated successful
response occurs. On Android itself the device dispatches the intent. The response contract has two parts. Android
`IntentWidget.loadCurrentAnswerToIntent` sends the invoking widget's nonblank current answer as
`odk_intent_data` on relaunch. In a noncancelled valid generic response, `IntentCallout.processOdkResponse`
first writes that primary string to the invoking input with its actual datatype, clearing the old primary when
the extra is absent. An auxiliary ordinary input referencing the same action is itself the invoking input.
Then process only present named keys from the result bundle if one exists, otherwise from the intent extras.
An absent named key leaves its destinations alone; present null is an empty input to their individual casts.
A returned primary empty string is present even if its typed value becomes blank. Keep presence distinct from
the return flag: a bundle-only mapped update with absent primary can write a destination while the generic
handler reports unsuccessful. Direct named extras processed without a bundle report success. Keep the raw return flag in the low-level Android control. The quick-advance
intent appearance is REFUSED under `questions/odkx-intent-appearance-quick`: Vellum retains an unknown attribute
that HQ's editors cannot produce. Exercise its native return-flag branch only in that independent refusal
control. A cancelled, missing-handler or invalid-intent result does not run the generic writes.
Contextualize each mapped reference at the invoking row. Apply the normal typed answer conversion to scalars.
For a binary destination Android copies the file/content URI into the form and stores its filename; blank,
missing or unreadable input clears that destination. Preview uses an explicitly chosen local capture for this
result and the existing attachment boundary. Android routes recognized identity registration/verification/identification parcels to
`IdentityCalloutHandler` first and a Simprints registration parcel to `SimprintsCalloutProcessing` next.
Give each recognized protocol its corresponding typed result adapter for Preview and proof. Use synthetic
guid/match/confidence and opaque template fixtures and compare mapped answers and invoking text to the
relevant pinned handler. Use the generic adapter for an ordinary Android result. These special branches are
selected by returned parcel shape, not by an arbitrary label or intent action name.

Use a controlled Android activity with two invoking inputs and two repeat rows, nonblank prior primary and
named destinations, one key mapped to two different destination types, a named binary result, and success,
cancellation and an unavailable handler. Assert sent previous answer and extras, the invoked answer on return,
kept/cleared/cast answers, copied file bytes and unchanged sibling row, re-invocation and incomplete-form
resume. Mirror admissible outcomes in browser Preview with local result entry or cancel. Add a required
primary-only Android callout with no named mappings. Return its primary value, submit successfully, reinvoke,
and return a result without a primary. The cleared required input must now block submission. Verify that
cancelling instead keeps the prior value on Android and Preview.

Add localized first/subsequent add captions to the repeat; required/hint to supported label/acknowledge
configurations; validation plus its localized message to geopoint, image/audio/video/signature/file, face
capture and the applicable trigger kinds; default, help text and help media to the capture and label kinds named
by their rows. Store each unit under field/slot identity, shared by group 3's localized media selection and
translations. Map from `lib/domain/fields/*` through one capability table into field editor, SA/MCP, checker,
emitter and `reader/xform/{kinds,logic,itext,media}.ts`. Do not synthesize constraints merely to display text:
test constraint with/without a failing answer and with/without its message, a blank capture default, a
literal/attachable capture value, localized captions for no rows/one row, and help with/without text. Expose the
Web Apps markdown hint, Android plain hint, and platform-specific help-media visibility in Preview. A required
passive trigger with exact `minimal` or `selectable` can pass on both platforms. Android’s
`TriggerWidget.getAnswer` returns string `OK` for each passive trigger when its screen is committed. For a
visible interactive trigger the same method returns null until checked, and Core’s
`FormEntryController.answerQuestion` rejects null at a required node. HQ’s
`form_entry/web_form_session.js::submitForm` substitutes `OK` for every info question, and
`form_ui.js::erroredLabels` supplies the same text to clear its validation. Vellum hides the requirement control
on exact minimal (`mugs/types/misc.js::Trigger.spec.requiredAttr`); keep an imported requirement in that form,
and use selectable/acknowledge for a new requirement the person edits there. A `floating-*` Android trigger is
interactive but its checkbox is hidden. A required one with no reachable nonblank value is unavailable on
Android: offer Web Apps, a visible checkbox, a reachable nonblank source or clearing required. The proof
distinguishes exact minimal, selectable, visible unchecked/checked, and a hidden blank trigger.

## X2. Values while a form opens, while a row is added and on resume

Retire the hidden-field single-source invariant across schema, mutation, `HIDDEN_VALUE_BOTH_SOURCES`, tool
precheck/clearing and Builder. Offer separate starting value and calculation controls and an optional admitted
bind/answer type. A change to one preserves the other. Explicit type wins, else use the existing bind inference.
Source defaults and calculates remain separate even when the default is never observed. Keep source lexical
date/time text where the app reads it as text; cast into Core's time precision at the actual typed operation.

Extend `reader/xform/{loadOrder,logic,afterBinding,repeats}.ts`, `queryRepeatPlacement.ts`, form initializer and
app-test engine around one event plan constructed from the data tree and F3's assignments. For form open, start
with initial values/relevance, apply Vellum's ordered ready setvalues (defaults, root create ids, iteration
ids/count), then HQ's appended preloads/meta in their build order. Each assignment writes even to an irrelevant
node and triggers calculates/relevance transitively dependent on it. Reads of irrelevant descendants are blank.
Constant `false()` is already applied. Uninitialized nonconstant relevance starts true. Finish by initializing
remaining triggerables. For a row run the insert assignments then the row's dependent triggerables according to
Core's `FormDef.createNewRepeat/processResultOfAction`. Resuming initializes calculations/relevance without
repeating defaults. Web Apps does that on each subsequent request. Android can retain a row's default until a
dependency is committed or the incomplete form resumes. An unchanged, previously nonblank answer committed when
leaving a screen can trigger recalculation. A browser React render alone does not run an entry event. Use the
value captured by a subsequent default as the test observation. A test of the final hidden value alone misses
ordering. Core sources are `FormDef.initialize`, `SetValueAction.processAction`, `Recalculate.wrapData` and
`XPathPathExpr.getRefValue`; Formplayer `FormSession.initialize`, Android
`FormEntryActivity.saveAnswersForCurrentScreen`.

For a model iteration, the loaded row-id sequence is a snapshot. Put ids/count at ready, row index/id on insert,
and the condition on the item. Do not live-requery after an answer changes. A **new** query that is meant to
follow answers keeps count placement. For an imported or held model iteration, retain the typed query and its exact evaluation
point, including earlier initialized answers, blank inputs, current persona/cases and ancestor relevance. At that
event evaluate once with Core-equivalent semantics and freeze the actual ordered result, including an empty
result. A use of a blank input does not prove that it suppresses any row. Accept a blank-insensitive predicate,
an explicit fallback and a conditional that produces different valid snapshots for different workers. An
undecided static truth value is an ordinary runtime input. No proof of universal relevance or of every answer
being nonblank is required. Keep distinct researched failure classes only where their *observed effect* applies:
the nested absolute index can address the wrong inner row; a query that must use a later answer to return the
intended rows can be exhausted before that answer exists; an irrelevant ancestor that suppresses the only
initialization cannot populate the later-displayed result. Contrast an intentionally empty captured set with
the missing initialization/effect. A typed, representable load-time query remains admissible even if subsequent
edits would change a fresh evaluation. Offer an explicit counted repeat to follow those edits, retaining review
for changed published addresses. Distinguish an unsupported expression/slot and a metered work-limit stop from
those data-dependent outcomes. Test both branches of a fallback, a predicate true for either blank or nonblank,
defaults before and after capture, both persona values, ancestor toggled after load and a second nested outer
row. Check row ids, ordering and values at open, after each answer/edit and after resume using each platform's
actual opening/insert events. Move a previously held placement only with the
identity-move review. Keep the count-repeat's extra-row/blank-id guards and old submitted row addresses.

## X3. A case change at an authored position

Use a non-interactive case-change node in the form tree. It points to one case effect group by UUID and owns its
submitted wrapper name, data position and parent. It has no duplicate set of case operations. The field “Saves
to” and form-level case-change tools edit the same effects. Blocks without an authored position use the existing
generated layout; recognize exact generated groups with the existing four structural tests. Ordinary
root/group/repeat placements can now read as an authored node. Preserve actual submitted ordering and position
even when the source block resembles Nova's generated fragment. Bind references to an operation id to the
producing node's UUID and row scope in both form and operation logic; an absolute and a relative path may reach
the same node. Never equate a reference across different iterations.

Represent a group's target id, declared catalog context, open/update, zero or more conditional
property/owner/index effects and an optional close of that same target. The whole-block condition, create
condition and close-leaf condition are distinct. If a close-only block is present but its close leaf is absent, the device receives a
valid, childless case element. Core's normal parser does not resolve, change or persist the case unless a
recognized action loads or creates it. The bulk parser may prefetch the id but leaves it out of the write log.
HQ constructs a `CaseNoopAction` when its case parser finds no actions and records the form against that
case. Project one submission into distinct device-before-sync and HQ history/restore results. Never manufacture
an empty update to obtain that history. An actual `<update/>` loads the existing case, changes its device
modification timestamp and fails if the device lacks the case. Include four independent submissions against an
existing known row: a true close, a false close leaving a childless block, a real empty update, and an
irrelevant ancestor omitting the entire block. Check XML, device timestamp and open state before sync, HQ
transaction/form IDs and dates, and the restored device snapshot after sync. Repeat the latter three with an
id absent from the local snapshot but existing on HQ. The childless block can reach the server while the empty
update fails locally. If the id expression itself becomes empty because the ancestor supplying it is absent,
the present case block fails its mandatory-id check; if the block's own ancestor is absent there is no
transaction at all. Preserve one block for a close beside create/update/link. Serialize root authored create IDs by
ready-time setvalue, row create IDs by the in-repeat calculate; keep Nova's existing keyed-create wrapper where
its identity is already held. Distinguish fresh UUID, Nova's keyed-id derivation with its deployment-held
prefix, and a general typed expression supplying the exact external id. Never add a prefix to an imported
literal. Include a root id that reads an earlier/later default, the same root id reopened, two repeat rows and a
reused pre-existing scoped id. Reject a provably always-blank ID under the existing row; data-dependent absence
produces Core's actual submission failure and a rolled-back Preview receipt.

Allow a create's case type as a typed expression. Branches that resolve to known types take their writers'
checked common shape and verify the resulting type in the transaction. For an open-ended text result, the app
cannot declare fields of every possible case type. Hold the general expression for a schema-neutral create (case
id/name/owner and compatible text writes); derive the schema of that open family from the document program at
app materialization. At submission write only a case row with the evaluated valid discriminator and the family's
lossless value schema; an existing declared type takes its concrete schema. A worker cannot install a schema or
extend the blueprint by submitting a type string. Constrain a type-specific write to valid declared
alternatives, or refuse that specific incompatible write under F4; an invalid concrete type is a runtime error.
Check server and device grammar/length and cross-tenant ID collisions before effects. Preserve form-builder
dictionary metadata separately. `reader/caseManagement/saveToCase.ts`, `xform/{caseOps,caseSaveReferences}.ts`,
`publishedCaseBlocks.ts` and the validator compare the entire region (bindings, values, namespace and setvalues)
with its typed projection. Retain independent refusal of malformed plugin internals, attachments inside a Save
to Case source and forbidden worker creates/closes.

Allow link identifiers Vellum can reproduce, including hyphens. Separate the XML/HQ limits, the Vellum bind
parser's accepted segment and the action recognition bug. `src/saveToCase.js::parseBindElement` accepts the
limited property segment in that branch and `parseDataNode` searches descendants for `create` and `close`. A
link of that name with no such action acquires one on save. Split
`questions/savetocase-link-name-changes-actions-on-save` (not HQ-editable); keep an already-explicit action only
when the saved action set, all binds and every reader agree. A character the bind parser drops needs a
distinguishing save/re-open comparison under `questions/savetocase-link-bind-lost-on-save`. The advanced-action
index editor is a different path and may keep that same name. Use a supported same-length hyphenated name as the
positive control and the existing 255-character refusal at the server boundary. The repair cannot silently
rename an existing case-data index.

## X4. Typed choices and form expressions

Extend `selectOptionsSourceSchema` with a queried choice set. Store a typed source instance (cases, Project
table, places, worker/session or other *admitted* instance), a nodeset expression, and in that row's context a
value, label, optional filter and sort reference. Reuse simple lookup/case shapes when they represent the
complete query. A known table's element/attribute and child field resolve to group 1's table/column/property
identities. A case query uses the form's visible device data as on a device. Do not widen Project scope or read
an arbitrary URL to realize an instance reference. Keep retiring and unsupported-instance rows; reject an
external source with no supported restore/data contract at its own source, not at every member expression.
Vellum `src/itemset.js` gates the sort element on sorted itemsets. Core `ItemsetBinding.sortChoices` uses the
evaluated sort property's Java string order and reindexes choices. Distinguish key and label and keep source
order on ties. Exercise an itemset with form-answer-dependent filter, labels out of order, two tied sort keys,
changed answer and a value absent on reopen. Row membership when the store supplies a case list remains the
domain SQL compiler's concern; itemset evaluation over an already device-visible snapshot uses the question's
actual context. No source is interpolated into SQL.

Add a deterministic XPath literal printer for values with both quote characters. Print the exact value as a
`concat` tree of quoted pieces for XPath and Vellum expressions. The actual select value remains one verbatim,
escaped XML text node. Fold a constant concat back to a choice UUID only in the proper choice reference context,
using parsed arguments and exact equality. Preserve the no-empty/no-whitespace and HQ instance-scan constraints.
In case actions whose HQ page strips quotes for its condition, choose a held expression/Save to Case placement
or the existing identity-move review. Do not emit an unsaveable basic condition merely because the general
expression printer can spell it. Round-trip both quotes through question defaults, selected(), a case action and
a rename changing only the choice value.

Add typed form-profile nodes for Core comparison/coercion, a bounded wildcard path on an admitted instance,
reads of generated form metadata and case-effect nodes, and explicitly unmatched starting values on selects.
Preserve ordinary typed comparisons and their canonical instant guards; a source read as Core coercion uses its
own comparison mode. Core `XPathEqExpr` evaluates boolean before numeric conversion, `XPathCmpExpr` converts
operands to numbers; preserve nodeset expansion, NaN, empty and multivalue behavior using typed native fixtures.
A lexical datetime with more than three fraction digits remains exact as text, and evaluation through a
date/time operation gives Core's instant, including its precision, independently from SQL/CSQL. Keep XPath `*`
as a typed child step with the source context and cardinality. Never turn it into a guessed field UUID. A
generated-node reference addresses a form metadata role, an operation UUID, a repeat row and a supported
leaf/facet. A form-logic reference to a create's id uses its actual load-time value before/after its
initialization. Generated structure visible to a wildcard (including ordering and irrelevant children) must be
supplied by the production XForm/Preview layout. Refuse an absent role or escaping repeated result as its own
scope error. A stale or unmatched select value remains visible and replaceable under the applicable platform
behavior. Binder/printer/re-read, not original XPath strings or regexes, drive these features. Bound
`reader/expressions/findings.ts` by slot and consumer; a construct evaluated by Core need not become valid in
every SQL-backed slot.

## X5. Texts that change form behavior

Bind a form's six Web Apps settings and one Android saved-form descriptor to their **carrier text**
(field/choice UUID and label, hint, help, constraint message or repeat-caption slot). Store a reference to the
existing translation unit with the setting role, not two copies of the text. Where several references actually
use one itext identity, preserve that relationship and check mutations on every carrier. The form editor can
select an existing text or create a setting on a supported text slot. For a provided case type and a
case-requiring form, auto-submit on a question's label also changes HQ's clickable-icon target catalog
(FormBase.is_auto_submitting_form). Use that same carrier identity in group 4's target selector. Generic
unreferenced pragma rows and the dependent volatility keys without a volatility key keep their separate
dispositions.

Formplayer `FormSession.getPragma` resolves the current language's text, including interpolations. Auto-submit,
suppress autosync and skip-full-form-validation read presence. The latter skips revalidation of unchanged
answers, with its documented cross-answer consequence. Volatility key, title and window establish the
per-form/key notice, title and integer TTL, default 300 seconds on absent/unparseable window. Android
`SaveToDiskTask` and Core `FormMetaIndicatorUtil` use the descriptor for the saved-form label; these consumers
read different keys. The itext writer relocates the existing carrier to the precise pragma id and prints the
other references consistently. HQ `XForm.normalize_itext` merges identical texts across all languages and forms
under the lexically first id. Reject an edit that would erase an active setting, naming the colliding carrier,
or allow the author to change either text. Don't treat the presence of an id in source XML alone as active.
Positive/negative pairs: auto-submit on a question vs choice label, two roles with identical text, same source
text with a differing translation, two simultaneous Preview sessions on one volatility key, suppressed
sync/ordinary sync, and an Android saved incomplete entry reopened by its translated descriptor. The current `lib/session` provides tab-local runtime state
and an Android sync timestamp. Add a narrowly scoped expiring presence store for Web Apps Preview.

Formplayer `FormSession.setVolatilityIndicators` evaluates the localized key and optional entity title in the
initialized root context and uses `FormInit-<effective form xmlns>-<resolved key>-v2`. A null key creates no
record. Salt that effective identity by authorized (Project, app) in Nova; shadow entries sharing a form use the
same effective namespace. Keep one current event per key, with effective worker, display title, opened/submitted
time, integer window and expiry. Store an opaque keyed digest for the upstream composite key and bound payload
size. The browser starts a Web run through `resolveAuthorizedPreviewContext`; server actions verify membership
and current revision, resolve worker/actor impersonation, derive the form namespace and check the evaluated key
and title against that form's authorized entry snapshot. The title can describe a protected case, so return a
notice only to a member authorized to open that form on that row. Every read, write, sync and deletion includes
the Project and app. Stale personas or lost access cannot read a notice.

In Postgres, serialize an open/submit on its scoped key, treating an expired row as absent and cleaning expired
rows by indexed expiry. Open reads the prior unexpired row and replaces it with the new opened event unless the
prior event was submitted. Only another effective worker sees the prior notice. Opens are eligible regardless
of last sync. A submitted event after the reading worker's last successful restore warns of stale data; one
before the restore is silent; equal timestamps still show the submitted notice without the stale-data warning.
The submitted row keeps precedence even on a silent open. After successful form XML processing and before
optional autosync, submit replaces the record and restarts expiry (reuse an existing same-worker record's
title and TTL). Cancellation and failed validation never mark submitted. Use server time in milliseconds and
a successful Web restore watermark per authorized app/Project, signed-in actor and effective worker, shared
between browser instances for that identity. Initialize from the first actual restore, advance on a completed
manual/configured sync and expire after ten days as Formplayer `RestoreFactory` does. Keep Android's separate
device clock and tab-local answers, navigation, draft and normal session state. No presence on Android.

`FormVolatilityRecord.setTimeout` caps seconds at 3,600. Java integer parse failure, overflow or absent window
defaults to 300. A parsed positive value uses the smaller of itself and 3,600. Nonpositive integers reach
the Redis seconds-expiry write (the pinned Spring Data `DefaultValueOperations.set` calls `SETEX`), which
rejects them. Report a Web failure for that value; don't silently substitute a positive TTL. Test two real
browser profiles with independent authorized workers A/B, the same effective worker from two profiles, aliases
sharing an effective form, different forms/keys and the same source xmlns in another Project. Compare with
served Formplayer's `MenuSessionRunnerService.establishVolatility`, `FormSubmissionHelper.updateVolatility` and
`FormVolatilityRecord.getNotificationIfRelevant`: open A/open B, submit A/open B on both sides of B's sync
and at equality, repeated same-worker opens, cancellation, revoked membership, expired record and a requested
7,200 seconds live at 3,599 and gone at 3,600. Check the server's selected notice and real Web client display.

## X6. Connect blocks are content in a form

Recognize five typed kinds at the wire boundary (learning module, assessment, delivery unit, task and work-area
update). Give each admissible block a UUID. Preserve the fifth kind in the reader and its refusal evidence for
the HQ forwarding path described below. Use a non-interactive question-tree node at its authored position like X3, with data
identity, enclosing group/row and display condition. Rework `lib/domain/connectIds.ts::connectBlocks` to
enumerate actual nodes in submission order. The wrapper and inner Connect id take the same nodeID in Vellum's
writer. Model that one authored ID and preserve it across ordinary edits; a stored mismatch that a Vellum save
renames is an identity change, never normalized silently. Replace single `connectType` and single `Form.connect`
configs with a set of configured roles (including a selected role before a form gets its first block) and plural
typed blocks. Permit learn and deliver roles together in the app. A role alone never implies that a real
opportunity, worker assignment or payment unit exists. Group 2 owns effective GPS and X6 reads it.

A delivery can hold a blank entity input and an optional constant or typed work-area-id expression. Preserve a
deliberate blank independently of a former default. Keep zero learning-time estimates. Learn/task slugs have a
50-character limit, delivery slugs 100, and assessment ids use the question grammar. Keep each Vellum-saved
inline value or calculation that determines the submission. The receiving unit must already have its payment
unit configured. A rename can create an unpaid unit and never repoints historical payments by itself.

**Decide multiplicity for a submission, across the entire tree.** Expand the actual potentially submitted rows,
conditions and receiver field values. Check mutually exclusive guards and bounds on repetitions; a row position
alone cannot make the value supplied to Connect unique. In the canonical document enforce the following four
admissible kinds and give an app stopped on the fifth its exact forwarding diagnosis.

* Learning completions must have distinct module slugs within one submission for one opportunity access. One
  Vellum module at a repeated position uses the same slug on every row. Admit a maximum-one-row or
  mutually-exclusive placement, and any number of distinct module identities. For two jointly reachable rows
  of the same slug, refuse `questions/connect-repeats-module-completion-key`. A new form can put the module
  outside the repeat or submit separate forms for independently earned completions.
* Distinguish repetitions of a delivery by the receiver key `(xform_id, entity_id, deliver_unit)`. Within a
  submission, each emitted non-null entity string must be unique *per unit*. Two distinct unit slugs may
  deliver to the same entity. Same-unit rows may take demonstrably distinct entity ids, for example one
  non-repeated, injectively selected case id per visit with no duplicate occurrence across outer repeats.
  For arbitrary typed entity expressions also admit an existing, worker-enforced full-form constraint that
  compares all reachable same-unit ids with exactly the receiver's equality. For new authoring provide that
  visible rule or let the author change the unit/row selection. A Preview-only check cannot make an unsafe
  imported form eligible. Jointly possible duplicate non-null ids without a preserving worker constraint
  are REFUSED as `questions/connect-deliveries-share-receiver-key`. A blank XML element forwarded as the empty
  string is a non-null key, so two such rows collide. The receiver uses `dict.get`: an omitted or JSON-null
  field becomes SQL NULL, whose unique constraint allows multiple visits. Keep these value classes distinct,
  including when re-posting one xform id. Do not manufacture NULL on export: Vellum's normal delivery writes
  the entity child, and only a proven HQ-editor-stable projection with a truly missing value can use that case.
  Repeated NULL visits can reference one `CompletedWork` for a given access/payment unit, and duplicate flags
  and payout follow Connect's opportunity rules; a new submission id is also a different unique key.
* Permit at most one reachable assessment per submission, independently of slug. The second sees the same
  assessment and raises `ProcessingError`. Sibling alternatives proven exclusive are admissible. For tasks,
  the receiver completes at most the one still-assigned task per slug and access. A second same-slug occurrence
  is a no-op after the first, absent assignment is also a no-op. Represent “complete the assigned task” with
  that idempotent meaning, show the repeated submitted blocks and only one completion. Do not promise two
  separately recorded task completions for one slug. Different assigned tasks can complete together.
* The receiver processes *all* deliveries before tasks, irrespective of placement. Co-emitted delivery and
  task can reject the visit while the task is still assigned and then complete the task. Retain the separate
  incompatibility for that combination. Allow proven mutually exclusive arms, or a task form completed before
  the delivery form. Permit learn and deliver roles in the same app including forms with compatible blocks of
  both roles. Keep the recursive namespace, reserved names and distinct receiver stages.

Share the reachability, key and NULL rules among importer, mutations and exporter. Check each changed repeat,
guard, id source, validation and placement transitively. A gate can prove cardinality one from the repeat
bounds, disjoint static unit/slug values, a structural row uniqueness guarantee across enclosing repeats, or a
preserved final uniqueness rule enforced at the real submission boundary on every declared worker (including
skip-full-validation paths). Otherwise present the two possible row paths and the conflicting key; attaching
a silent new rule on bring-in would change worker behavior. In the submission evaluator use stable field/row
identities to construct the exact worker instance and a nullable, length-bounded (255 for entity id) string
projection for the actual Connect keys. Validate the Nova submission's finalized program on the SQL side within
the existing scoped receipt transaction before committing any case mutation. A receiver-sensitive non-null
entity string longer than 255 is another delivery typed-input failure on insertion; constrain a new entry or
honor a preserving constraint, with 255 and 256-character submitted controls. Run the same duplicate witnesses
through emitted HQ/Vellum-built Web and Android forms; the supported worker-enforced uniqueness control must
prevent submission, not just flag the already-sent form. Preview shows submitted facts; only the real receiver
can attest the actual completed work, flags or payment.

**Trace actual receive and commit.** Connect `config/settings/base.py` enables `ATOMIC_REQUESTS`.
`form_receiver/processor.py::process_xform` runs delivery role first (one savepoint per visit, then one for the
task batch, then work areas), learning role second (one savepoint for module creation and bulk completions,
then assessments). `opportunity/models.py` defines `unique_xform_entity_deliver_unit` and
`unique_xform_completed_module`. `FormReceiver.post` catches exactly these named uniqueness errors and an
older work-area constraint name and returns HTTP 200. A failed visit rolls back its *inner* savepoint;
earlier visits, completed-work/payment bookkeeping and their on-commit callbacks can commit when the view
returns. Later deliveries, tasks, work areas and both learning stages never run. For a duplicate module the
*whole* collection of completions/module creations and access updates in that savepoint rolls back. Prior
successful delivery-role work can commit; assessments are skipped. Under ordinary validation
`ProcessingError` instead reaches the DRF exception handler, marks the request for rollback and returns 400.
A second assessment or missing work-area photo therefore rolls back earlier staged visits/assessments/tasks
and drops their deferred callbacks. Do not use the receiver's HTTP acknowledgement as proof of a stored row.

Prove through `proof/connect/{hq,driver}.py`, actual HQ forwarding, the real HTTP view, and committed
Postgres state outside the request. For learn use a distinct good module plus the repeated slug, another
distinct module, and a subsequent assessment, with an earlier valid delivery role. Expect the earlier visit
only, HTTP 200, no new module completions or assessment, and no learn progress. Restore unique slugs and
expect every permitted row. For delivery submit same unit/ids A,A,B plus independently observable trailing
work and learning modules. Expect exactly the first A visit and its derived records, no B or trailing work
despite 200. Contrast A,B, same id on distinct units, identical empty strings and two true NULLs supplied to
the direct receiver. Repost the identical instance id in each class. Check visit identities, status, shared or
distinct completed-work rows, accrued amount, module rows, assignment status and callbacks after commit.
Include mutually exclusive rows, a genuine pre-existing worker constraint and two outer repeats with locally
unique but globally duplicated inner ids. Choose verification limits and assignment fixtures explicitly, so
each assertion exposes its intended mechanism.

**Work-area updates.** Vellum writes `work_area_update` with expressions for the area id, requested status,
reason, details and photo evidence. `process_work_area_update` accepts an assigned NOT_VISITED area, the
REQUEST_FOR_INACCESSIBLE transition, nonblank reason and photo filename, a matching top-level attachment and
no prior pending request. The current microplanning constraint is on a *pending request per area*.
HQ `corehq/apps/api/resources/v0_4.py::XFormInstanceResource.dehydrate_attachments` produces top-level
attachment metadata containing content type, length and URL. `ConnectFormRepeaterPayloadGenerator.get_payload` in
`corehq/motech/repeaters/repeater_generators.py` keeps six metadata fields and reconstructs only paths to
nodes whose `@xmlns` equals the Connect namespace. It drops the top-level attachment map. Even a real photo
arriving at HQ cannot reach the prescribed receiver lookup. Classify an active update on the HQ forwarding
path as `questions/connect-work-area-update-photo-not-forwarded` (REFUSED, broken at runtime on both workers).
Author repair is a delivery referencing the area if that is the intended operation, or leave inaccessible-area
requests in the existing separate service/workflow. A deliver-unit area *association* alone is admissible and
does not perform this status transition. The stop can retire only when that forwarder carries evidence through
the receiver without changing the saved address or identity.

Keep `proof/matrix/variants/questions.py::connect_work_area_update`'s malformed learn-form `work_area` as
a negative for a different reason. Create the correctly shaped form in Vellum, submit it through each device
with real photo bytes and an earlier valid delivery. Observe the HQ attachment, the actual forwarded filename
and missing manifest, Connect's 400, and no committed earlier visit/request or changed area. In a separate
direct receiver control provide the matching top-level attachment; confirm committed request, status transition
and queued download. Compare invalid area, wrong worker, blank reason, second pending request and missing photo.
A later learn block is not processed on rejection. Include the independent Vellum-saved delivery-unit area id
as a full accepting HQ-forwarded neighbor. Correct the formerly broad not-yet row and its retained controls in
the implementation PR.

## Changes to saved data, releases and permanent evidence

**Group 7.** Keep existing basic and derived-chain documents in their current representation, including all held
advanced tags, existing session references, query placements, historical case ids and guarded full-instant
writes. New selection and computed-datum slots are optional. Materialize them only on an actual edit or
non-derivable import. Add the nullable case-location column via an additive ledgered migration; case rows carry
null until an explicit data write. A preflight scan compares derived entry identities, tags, datum keys, write
paths and emitted suite/XForm on existing apps, verifies decoded target baselines and checks every existing case
location source before adding any data mapping. Never mine a person's HQ baseline for a new field and present it
as a change they made. Where a prior reading folded a preload to a default keep the saved shape; a newly
imported late assignment and a genuinely changed HQ assignment use F3. Narrow the preload portion of
`case-settings-respelled`; the external-id and other respellings keep their own coverage.
`date-and-time-saved-as-hq-stores-it` still covers the previously emitted instant format. The new direct-to-day
writer is a different case. Prove both side by side.

**Group 8.** One incompatible document conversion for Connect's stored config. In one direct cutover take each
old role into its corresponding role set, map every old form block into its former wire position, and derive a
stable UUID from the old form UUID, kind and id with collision checks. Preserve whether optional expressions
formerly implied defaults; encode the same effective default explicitly where the new empty field would mean
blank. Validate identical proprietary IDs, wrapper paths including generated-prefix avoidance, old block order,
source XML and saved values, per-platform GPS behavior, reference graph and existing deployments' form
identities. Cover an app with a role and zero blocks. A read-only scan identifies every live app, active fold
horizon and replayable suffix, project-bearing fold baselines, active/saved app-test state and adopted targets
affected. Compare the before/after real projections; include local archive, HQ source, Connect registry/delivery
keys and replay. Apply under the [direct-cutover contract](../../../architecture/contracts.md), with an
app-sequence lock and immutable, Project-bearing fold starts. Materialize each usable target’s converted
reference under the [shared fold procedure](../7-rest-of-model.md#a-fold-preserves-each-live-deployments-comparison-point)
before advancing the app horizon. Use one atomic change per changed app, idempotent
rerun, restore point, post-scan and old/new reader incompatibility check. Scan every live app for earlier ordinary/derived
names newly recognized as submission dispatch (including Web fixture/schema), reachable duplicate receiver
keys, existing data-path collisions and affected declared platforms. Keep existing submitted identities and
rows intact. If an existing app triggers one of these real upstream failures, report the exact affected
deployment, form, field, platform and repair with before/after submission evidence. Do not auto-rename a
published address or change the app's platforms in a migration. An affected owner chooses the scoped
repair in the ordinary mutation flow under the current schema, with the first-publish review for any address
move. Run the read-only scan again before the stricter validator cutover. Default root/order/hidden fields on documents without the new settings need no invented
migration values. Advance runtime and model context versions
for their actual changes, update retained snapshots and dependent plugin guidance in the coordinated release
order.

Retire `hidden-value-defaults-dropped` and its proof/register rows for fresh reads when the new reader holds
even a default no runtime previously observed. Existing adopted documents whose first publish still drops an old
default need an explicit reconciliation under the common adoption rule; retain historical notice rendering and a
control until the last applicable pending first publish can describe itself correctly. Keep aggregate
`forms-and-settings-rewritten`, `hidden-values-added`, `case-names-checked`, and the existing
validation/instant/session/repeat guards wherever their predicates still fire. Shrink any exact subplace,
including the generated-operation wrapper when X3 can preserve the original one. The location-capture register
belongs to group 2. Do not erase a historical entry solely because a new source can be read exactly.

**Acceptance matrix.** Extend the existing HQ-authored families `hq-advanced`, `hq-case-management`,
`hq-questions`, `hq-connect-learn`, `hq-connect-deliver` and `hq-expressions` with bases created in the
producing HQ pages (including an action retained by a page save). Preserve independent read evidence from
`app_source`, application resource, source, editor save and built artifacts. Each admitted class must exhibit
baseline bring-in, ordinary builder/SA/MCP mutation, an HQ edit brought in as a mutation batch and published
back, unchanged adopted target identities, fresh-target identities and canonical reread. Group 8 exits with a
palette base per supported kind, an authored Save to Case block between real questions, and
native/device/server/Connect records distinguished by the neighboring negative. Exercise docs, import refusal
messages and atomic creation through the shared tool paths. Revisit the affected fixed-defect controls for
reserved question names, Save to Case/read warnings, model-iteration placement, conditional operation ordering,
date/time and Connect rename. Keep each actual oracle. Narrow a known-defect exemption only once the same pinned
reader distinguishes its old and repaired records.

For each F/X slice change the owned human and machine manifest rows, claim standing, Python value-class
classifier, gate links and base/variant exhibitions in the same PR. Add the new platform feature rows/cause
words, Preview cell data and platform fixtures for the differing or unavailable entries. Bind the worker actions
in Proofs 1–6 to emitted submissions, restore snapshots, menu/relevance results, database effects and the real
editor save. Run focused native readers for the changed behavior, all PR checks and the agreed served-reader
exit proof **during implementation**. A green matrix inventory scan, skipped walk or a Nova emitter round-trip
without an independent reader cannot close a class.

## Entry-to-slice ledger

IDs below are relative to their named inventory area. For entries with subclasses, the accepted class stays
under its original ID with its predicate narrowed and the additional precise IDs above get their own evidence
and disposition. All other listed entries become HELD at the end of their slice. Adjacent refusals mentioned
above keep explicit negative controls. The parent plan owns the shared release requirements.

### Group 7

| Area | Entry | Slice |
| --- | --- | --- |
| `expressions-and-data` | `session-data-supply-point-id-in-an-advanced-form-whose-computed` | F1 |
| `forms-and-case-writes` | `shadowform` | F2 |
| `forms-and-case-writes` | `submit-label-non-default` | F3 |
| `forms-and-case-writes` | `update-key-name-or-owner-id-through-an-index-segment` | F3 |
| `forms-and-case-writes` | `update-key-whose-index-segments-include-user-each-parent-host-or` | F3 |
| `forms-and-case-writes` | `update-keys-location-id-hq-user-id` | F3 |
| `forms-and-case-writes` | `update-key-holding-a-non-ascii-core-name-character` | F3 |
| `forms-and-case-writes` | `case-preload-into-a-question-outside-any-repeat-where-the-held` | F3 |
| `forms-and-case-writes` | `case-preload-from-any-other-index-path-host-user-a-mixed-path` | F3 |
| `forms-and-case-writes` | `a-child-case-or-advanced-action-condition-boolean-true-on-a` | F3 |
| `forms-and-case-writes` | `writers-single-select-multi-select` | F3 |
| `forms-and-case-writes` | `any-other-mixed-writer-pair` | F3 |
| `forms-and-case-writes` | `a-datetime-question-saved-straight-to-a-case` | F3 |
| `forms-and-case-writes` | `a-date-and-time-saved-straight-in-no-shape-nova-keeps` | F3 |
| `forms-and-case-writes` | `update-mode-edit-on-a-case-s-name-or-owner` | F3 |
| `forms-and-case-writes` | `advanced-form-loads-other-than-its-menu-s-one-chain` | F1 |
| `forms-and-case-writes` | `load-changing-no-case-with-a-tag-nova-does-not-derive` | F1 |
| `forms-and-case-writes` | `case-tag-holding-a-hyphen` | F1 |
| `forms-and-case-writes` | `loadupdateaction-preload-read-later-in-the-load` | F3 |
| `forms-and-case-writes` | `loadupdateaction-case-properties-key-with-on-a-load-with-no-case` | F3 |
| `forms-and-case-writes` | `an-index-on-the-first-chosen-load-naming-the-worker-s-record-loaded-before-it` | F1 |
| `forms-and-case-writes` | `the-worker-s-record-s-auto-selected-load-stored-before-a-chosen-load` | F1 |
| `forms-and-case-writes` | `auto-select-mode-raw-value-key` | F1 |
| `forms-and-case-writes` | `auto-select-mode-user` | F1 |
| `forms-and-case-writes` | `auto-select-mode-fixture` | F1 |
| `forms-and-case-writes` | `auto-select-mode-case-index-of-an-earlier-load` | F1 |
| `forms-and-case-writes` | `an-advanced-load-s-update-or-preload-or-an-open-action-s-name-or` | F3 |
| `forms-and-case-writes` | `index-identifier-outside-an-xml-element-name` | F3 |
| `forms-and-case-writes` | `caseindex-relationship-question-relationship-question-the-index-naming-a` | F3 |
| `forms-and-case-writes` | `an-advanced-open-action-s-parent-index-against-a-menu-s-parent-selection` | F3 |
| `forms-and-case-writes` | `arbitrary-datums-datum-id-datum-function` | F1 |
| `forms-and-case-writes` | `shadow-parent-form-id-naming-an-advancedform-that-is-not-a` | F2 |
| `forms-and-case-writes` | `extra-actions-load-update-cases-repeating-a-parent-tag-overrides` | F2 |
| `forms-and-case-writes` | `extra-actions-load-update-cases-with-a-tag-absent-from-the` | F2 |
| `forms-and-case-writes` | `case-preload-into-a-question-that-holds-no-default` | F3 |
| `forms-and-case-writes` | `update-mode-edit-off-a-follow-up-form-s-own-update` | F3 |
| `forms-and-case-writes` | `index-path-through-a-case-type-the-app-does-not-fix` | F3 |
| `menus-and-case-lists` | `advanced-module-nova-would-write-as-a-basic-one` | F1 |
| `menus-and-case-lists` | `case-type-commcare-user-on-an-advancedmodule` | F1 |
| `menus-and-case-lists` | `auto-select-case-on-an-advanced-module` | F1 |
| `questions` | `a-keyed-savetocase-create-in-no-order-nova-holds-beside-the-form-s-other-changes` | F4 |
| `questions` | `a-savetocase-change-of-a-case-s-type-another-change-of-the-form-may-read-as-its-earlier-type` | F4 |
| `questions` | `a-savetocase-update-of-commcare-user-under-a-condition-or-inside-a-repeat` | F4 |
| `questions` | `a-savetocase-update-of-commcare-user-beside-another-update-of-the-worker-s-record` | F4 |
| `questions` | `a-savetocase-change-of-the-form-s-own-case-beside-the-form-s-own-change-of-it` | F4 |
| `questions` | `a-savetocase-change-whose-case-type-is-not-the-type-of-the-case-it-reaches` | F4 |
| `questions` | `a-savetocase-change-of-a-case-s-type-to-a-type-that-holds-one-of-its-properties-as-another-type` | F4 |

### Group 8

| Area | Entry | Slice |
| --- | --- | --- |
| `expressions-and-data` | `a-form-expression-outside-what-nova-types` | X4 |
| `questions` | `question-id-case-registration-script` | X1 |
| `questions` | `choice-value-holding-both-an-apostrophe-and-a-double-quote` | X4 |
| `questions` | `acknowledge-label-a-trigger-whose-appearance-is-neither-exactly` | X1 |
| `questions` | `hidden-value-with-both-calculate-and-a-default-by-any-expression` | X2 |
| `questions` | `hidden-value-bound-a-type-nova-would-not-write` | X2 |
| `questions` | `model-iteration-repeat-outside-nova-s-model-iteration-rule` | X2 |
| `questions` | `repeat-add-captions-jr-addcaption-jr-addemptycaption` | X1 |
| `questions` | `jr-imagedimensionscaledmax-250-500-1000px-or-another-positive` | X1 |
| `questions` | `face-capture-image-face` | X1 |
| `questions` | `android-app-callout-input-appearance-intent-id-bind-type-intent` | X1 |
| `questions` | `itemset-sort-ref` | X4 |
| `questions` | `itemset-filter-outside-predicate` | X4 |
| `questions` | `itemset-over-casedb-or-another-instance-advanced-data-source` | X4 |
| `questions` | `savetocase-block-outside-nova-s-own-block-shape` | X3 |
| `questions` | `savetocase-case-type-given-as-an-xpath` | X3 |
| `questions` | `savetocase-create-with-an-authored-non-uuid-case-id-xpath-inside` | X3 |
| `questions` | `savetocase-expressions-outside-nova-s-typed-vocabularies-case-id` | X3 |
| `questions` | `a-close-only-savetocase-block-with-a-close-condition` | X3 |
| `questions` | `a-savetocase-block-that-creates-or-updates-and-also-closes-under` | X3 |
| `questions` | `savetocase-owner-id-condition` | X3 |
| `questions` | `savetocase-link-name-outside-nova-s-identifier-grammar` | X3 |
| `questions` | `connect-blocks-beyond-one-of-each-kind` | X6 |
| `questions` | `connect-deliver-unit-work-area-id-expression` | X6 |
| `questions` | `connect-learn-and-deliver-blocks-in-one-app` | X6 |
| `questions` | `connect-work-area-update` | X6 |
| `questions` | `data-parent-data-node-under-another-group-than-its-control` | X1 |
| `questions` | `data-node-xmlns-on-a-hidden-value` | X1 |
| `questions` | `vellum-lock-all-locked-question` | X1 |
| `questions` | `bind-required-on-a-label` | X1 |
| `questions` | `bind-constraint-on-a-capture-question-or-a-label` | X1 |
| `questions` | `default-on-a-capture-question-or-a-label` | X1 |
| `questions` | `data-root-element-named-other-than-data` | X1 |
| `questions` | `intent-id-on-any-input-other-than-an-intent-typed-one-where-id` | X1 |
| `questions` | `hint-text-on-a-label` | X1 |
| `questions` | `help-text-on-a-capture-question-or-a-label` | X1 |
| `questions` | `help-media-on-a-capture-question-or-a-label` | X1 |
| `questions` | `validation-message-on-a-capture-question-or-a-label` | X1 |
| `questions` | `a-question-text-label-hint-help-validation-message-repeat-add` | X5 |
| `questions` | `a-question-text-whose-itext-id-is-pragma-form-descriptor-where` | X5 |
