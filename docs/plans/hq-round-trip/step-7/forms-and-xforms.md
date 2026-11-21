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
real data. Backing up invalidates only dependent later values; deep-link launches bind the same supplies. Test
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
`user` from the loaded case, subject to the relevant project privilege. Missing or wrong-Project targets fail
atomically. Match HQ's separate restrictions on indexed loads, basic forms opening their own cases and preloads.

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
expressions against the existing pre-effect, tenant-bound snapshot, correlate repeated creates by operation UUID
and row, and keep a single atomic, idempotent `applySubmission`. Extend `caseOperationOrder.ts`,
`caseRetype.ts`, validator `caseOperations.ts`, `submissionEnvelope.ts` and the operation-order reader. Resolve
addresses from the committed document in scope, even if the client sends an expected type. A rejected effect
rolls back the entire receipt and every write. The preview can show the worker which form and case change
failed.

Pin independent ordering oracles. Core's `CaseXmlParser` walks blocks in XML order. HQ's
`casexml/apps/case/xform.py::{get_case_updates,order_updates}` groups by target id and stably sorts blocks by
the first action kind in HQ's priority order. `update_strategy.py::_apply_create_action` and Core's
create-overwrite path can change the type of an existing id. An empty update/touch still has case history. Do
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

Allow `case`, `registration`, `script` (including the Vellum warning variants) where the actual editor/build
permits them. Retain the independent restrictions on meta, parse-breaking names, colliding generated blocks and
a root own-namespace `case` consumed as the form's actual case block by HQ `XForm.case_node`. Split that last
incompatible case under `questions/question-id-conflicts-with-built-own-case` where HQ’s XForm._create_casexml
raises on the existing root case when adding its nonempty basic case block. A same-named node in a group or a
survey with no such block is the control. A warning emitted on a supported name must match the equivalent
HQ-authored control, separate from an editor error. Add a Hidden Value's explicit data namespace URI, including
the distinction between inherited and explicitly empty namespace when meaningful. Resolve nodes by namespace and
local name when classifying roles. Add a lock flag on supported fields; Vellum `src/lock.js` writes it on the
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
show the target app and evaluated extras to the current worker and offer two local actions: return values for
the declared response fields or cancel. Commit returned answers through the normal form event and relevance
pipeline; cancel leaves them alone. No package launch, server request to an action URI, or fabricated successful
response occurs. On Android itself the device dispatches the intent. Device proof uses a controlled activity
returning multiple fields and a cancelled activity returning none. Exercise an absent Android handler as a real
runtime outcome and verify destinations and recomputation across an incomplete-form resume.

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
follow answers keeps count placement. For an imported or held model iteration, analyze its actual load position,
read dependencies, initialized answers and ancestor relevance. Propagate blank/nonblank/unknown and literal
truth values through the same event graph with typed evaluation of closed terms, symbolic inputs for
session/case/clock and row scope, and explicit dependencies from calculated nodes and ancestor relevance. A
dependency on an answer that an earlier setvalue has already initialized does not by itself invalidate
iteration. Refuse the three researched classes: nested model iteration, a query reading an answer certainly
blank on every opening at this point, and an ancestor that can be irrelevant here and become relevant later in
that opening. A permanently irrelevant ancestor is distinct from a late-relevant one. An undecided case must not
be called certainly blank. For a potentially late ancestor require a safety certificate (invariant relevance,
relevant at capture, or irrelevance persistent until close); if a supported typed expression leaves that
property unprovable, name the structural limit under a distinct
`questions/model-iteration-relevance-not-statically-established` untypeable class with its expression and
equivalent counted-repeat option. Meter dependency work; distinguish the existing work-limit stop from a product
verdict. Validate this boundary on dependent defaults before/after the repeat, both values of a persona flag, a
later relevance toggle, and a nested second outer row. Move a previously held placement only with the
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
condition and close-leaf condition are distinct. An eligible close-only block touches the case even when its
conditional close is absent. Preserve one transaction block on the wire, including a close beside a
create/update/link. An irrelevant ancestor removes the whole group. Serialize root authored create IDs by
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
sync/ordinary sync, and an Android saved incomplete entry reopened by its translated descriptor. Reuse Preview's
true server-backed session lifecycle for cross-session settings.

## X6. Connect blocks are content in a form

Give each Connect block a UUID and one of five typed kinds (learning module, assessment, delivery unit, task,
work-area update). Use a non-interactive question-tree node at its authored position like X3, with data
identity, enclosing group/row and display condition. Rework `lib/domain/connectIds.ts::connectBlocks` to
enumerate actual nodes in submission order. The wrapper and inner Connect id take the same nodeID in Vellum's
writer. Model that one authored ID and preserve it across ordinary edits; a stored mismatch that a Vellum save
renames is an identity change, never normalized silently. Replace single `connectType` and single `Form.connect`
configs with a set of configured roles (including a selected role before a form gets its first block) and plural
typed blocks. Permit learn and deliver roles together in the app. A role alone never implies that a real
opportunity, worker assignment or payment unit exists. Group 2 owns effective GPS and X6 reads it.

A delivery can hold a blank entity input and an optional constant or typed work-area-id expression. Preserve a
deliberate blank independently of a default from Nova's old configuration. A work-area update has expressions
for the area id, requested status, reason, optional details and photo evidence. Preserve an observed fixed value
as a literal expression when its Vellum save produces the same submission. If authored inline data and a bind
differ, compare the saved Vellum form and classify dependence on that data before accepting. Keep zero learn
time estimates. Apply limits to the reader that owns the value: learning/task slug at most 50, delivery at most
100, assessment id under the applicable question grammar. Plural assessments in one submission (including
multiple repeat rows) remain refused; the receiver keys an assessment by submission and returns an error on the
second. Retain the existing separate incompatibility for a delivery and a task in one form: Connect's
process_deliver_form checks the visit before it completes that submission's assigned task. The still-assigned
task can turn away the visit. Use a task form before the delivery form. Do not reject learn and deliver in
different forms of the same app. Respect repeated wrappers, conditional absence and the recursive receiver's
reserved names; preserve its exact namespace and node shape.

Pinned Connect `form_receiver/processor.py::process_xform` looks up deliver and learn roles independently and
its per-role processors traverse the submission recursively. `process_work_area_update` requires a real assigned
area, a supported status transition, reason, matching attachment and no prior pending request.
`process_deliver_unit` associates a nonblank work area and a configured payment unit;
`get_or_create_learn_module` and `process_task_modules` use a block's slug. These are decisions of the receiver
and manager, outside the blueprint. Preview shows the actual submitted blocks, target area and files;
confirmation of payment or acceptance comes only from that receiver. The current not-yet variant
`proof/matrix/variants/questions.py::connect_work_area_update` injects a learn form node with an inner
`work_area` and no required fields. Vellum emits `work_area_update` and Connect matches that exact name. Keep
the old shape as a malformed negative, then create the accepting base through Vellum in a deliver app with all
five child nodes and a real matched attachment. The proof receiver needs both opportunity-role associations for
a mixed app. Include successful delivery, an invalid area, missing photo, a second pending request, two
deliveries in distinct repeat rows, a condition suppressing one, zero estimated hours and a rename of a paid
unit with a retained old-id control. An edit/rename never silently repoints real Connect history. The HQ
forwarding and Connect receiver evidence is necessary even when both device traces agree.

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
app-sequence lock and immutable, Project-bearing fold starts, one atomic change per changed app, idempotent
rerun, restore point, post-scan and old/new reader incompatibility check. Default root/order/hidden fields for
documents without the new settings need no invented migration values. Advance runtime and model context versions
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
