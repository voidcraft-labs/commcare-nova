# Menus and case search

Groups 5 and 6 extend the menu a worker enters, the records the worker can select and the search that supplies
those records. A menu listing the same form in two places still edits one form. A search that finds records
outside a worker's restore still runs inside one Nova app and Project. These two invariants determine the
identities in the document and the queries in Preview.

The baseline is Nova `9a6dc789`. The evidence below uses local checkouts of HQ `d6c6e16d8ae1`, Core
`8e9ba8d908e9`, Android `7a5584475580`, Formplayer `24383ac71bfb`, Connect `046c7fd78081` and HQ's Vellum
`01215f251c57`. The manifest at this revision assigns 22 entries to `menus` and 45 to `case-search`. Neither
group owns a circumstance in `lib/publish/hqFindings.ts::CIRCUMSTANCE_STANDINGS`. The assignment at the end maps
each entry to its delivery slice. The nearby refused, inert and derived classes keep their own witnesses.

## Implementation order

1. **M1** introduces the menu through which a form is reached, mirror menus and their form links and deep links.
   **M2** uses that projection for selected cases, first-menu frames and computed deep-link arguments. **M3**
   adds badges, display expressions and worker-record reads. **M4** completes actions on case lists using the
   same frame planner.
2. **S1/M5** ships named search results and the child form's read of its parent's answers **together**. This is
   a complete cross-group pull request. It includes both manifest claims, the authoring controls for naming a
   search, the reader of an inactive child's necessary name and the working Web Apps child form. The menus group
   exits here. S1 can precede M3 or M4 if needed, once the menu/entry projection it calls exists.
3. **S2** delivers independent list and server conditions, matching in the project space and the project-space
   day. **S3** delivers Search fields, including fields whose visible and request behavior differ. **S4** covers
   the remaining request and results settings and the two menu workflow shapes. **S5** delivers externally
   managed searches and their project-space bindings.
4. Use the earlier groups' relation catalog, per-slot expression capabilities, ordered case-list/detail
   projections, target capabilities and translation infrastructure. Use the same address component identities
   for question and Search receivers. Group 7 adds the entry datums of its additional advanced loads to the
   M2/M4 projections, with their menus, register actions and endpoint signatures tested when those loads become
   expressible. Group 8 can reuse S3's typed device-data selection and receiver binding where its form profile
   permits them. No slice accepts a dependent document before its own entry, gate, reader, two writers and
   runtime work.

## M1. A form through a second menu

Extend `Module` with an optional mirror reference to a source menu UUID, an ordered subset of excluded source
form UUIDs (canonical order is source order), and optional form entry points indexed by those forms' UUIDs. The
mirror itself has its own UUID, title, translated content, navigation media, display condition, short/long
details, search and parent selection. Derive the case type, form requirements, additional types and selection
cardinality from the source wherever HQ derives them. The menu owns no form entities. The entry shown on a
screen is a pair of **route menu UUID and source form UUID**. Make `lib/domain/menuForms.ts`, `menuScreens.ts`,
source-form enumeration, session suppliers, breadcrumbs, builder navigation, reference indexing, routes and both
wire projections distinguish a form's owner from the menu through which it opened. Identity maps, XForm export,
form history and case writes keep the source form's single identity. HQ's `models/modules.py::ShadowModule`,
especially `get_suite_forms` and `all_forms_require_a_case`, and
`suite_xml/sections/entries.py::get_datum_meta_module` show which properties delegate and where the mirror
supplies its own detail. Test a mirror that excludes the only registration form: the visible form set changes
even where a requirement is derived from the source's full set.

A top-level mirror can point at a basic or advanced source menu (the options in HQ’s
`views/modules.py::_get_shadow_module_view_context`); a mirror of a source child takes the source child's
ordinary parent. A mirror of a source with ordinary children has exactly one mirror child per source child.
Store those child menus as actual editable menu entities with UUIDs and their own settings. An initial mirror
child starts with HQ's copied values (`views/utils.py::handle_shadow_child_modules`,
`MODULE_BASE_PROPERTIES_TO_COPY` and `SHADOW_MODULE_PROPERTIES_TO_COPY`). Subsequent source edits update
inherited properties through derivation and retain the child's independently editable settings. Drive source
choice, source reparenting and removal through one mutation planner. It emits creates, moves and removals for
the required child set in the same batch, reusing each existing child for the same parent/source pair. Preserve
identities on reorder, undo, redo, a reread of an HQ save and retries. Confirm affected dependents with the
ordinary removal review. The gate checks reciprocal topology, no cycles, duplicate mirror children, missing
source or direct edits that detach a generated child. Refuse unsupported v1 and broken/uneditable source
topologies under their existing dispositions. Reconcile a source form's removal with its mirror exclusions,
mirror links and form entry points before committing.

Bring-in first aligns the application resource and source as `lib/commcare/hq/appReading.ts::alignHqForms` does,
then constructs both real-form-id and read-form-id maps. HQ's source rereads mint form ids while the exclusion
and mirror endpoint rows name the **real** form. Bind them to the source form UUID, detect missing or ambiguous
ids and never match two forms merely because their labels agree. Mirror children keep adopted menu ids in the
deployment identity ledger. A reread producing a new mirror or moving a source child uses the same identity and
mutation planners as creation. Read excluded source forms, existing endpoint mappings and target menus in a
second pass after all entities exist. Raise a placed finding for a bad reference before publishing.

At the wire boundary produce `ShadowModule` version 2, its real source menu id, excluded form ids and mappings
in the correct target's ids. For local suites build mirror entries over the visible forms, including their
source XForms, their correct detail, command and stack. For an explicit form link through a mirror, carry the
route-menu identity and write `form_module_id`; from within a mirror a link to its source's form uses the
current mirror when HQ does. Module links to the mirror open it. Preserve its breadcrumb even when source and
destination form content are identical (`post_process/workflow.py::_get_link_frame`).
`post_process/endpoints.py::EndpointsHelper.update_suite` emits mirror-form endpoints only when the mirror has
its own endpoint and only for forms it lists. Require both conditions, app-wide unique slug-safe ids and the
session endpoints capability. Creating a mirror in HQ has its own editor gate; do not turn that editor-only gate
into a build dependency. Prove the ordinary and mirror deep links independently on Web Apps and Android's intent
path. A Connect launch has the platform and arguments of its actual entry point.

Builder offers **Show forms from another menu**, choices of included forms, and editable menu-only properties.
A mirror’s form endpoint takes its function arguments from the source form, including when the source form
has no endpoint of its own. HQ’s form settings save that function list independently of the ordinary endpoint
ID. Permit and retain the computed supply for a mirror-only launch. Relevancy works differently: an ordinary
endpoint can explicitly bypass it, while the mirror endpoint still checks it. Keep that choice on the route
that supplied it. Test a hidden source form with an ordinary bypass, a mirror route to the same form with the
same computed argument, and the excluded-form variant. Verify the worker is admitted or refused on the correct
route in the native launch, including when only the mirror endpoint exists.

Opening a listed form identifies its source menu. The shared tools expose source menu, excluded forms and mirror
endpoints by reference, show the dependent changes before saving, and include the route in link destinations. A
mirror cannot acquire an accidentally empty editable form list through an ordinary form edit.

## M2. Selection, first-menu frames and entry arguments

Menu nesting, the menu that supplies a selected case and the relation edges that select child cases are
distinct. Loosen `caseParentSelectionVerdict` and the cross-type-formless-root restriction. A navigation parent
with no forms contributes no first-form datums. At a child of a different type, open the child's own case list
and keep an earlier choice only if its actual datum is still on the frame. For an active basic parent selection,
HQ's `views/modules.py::get_modules_with_parent_case_type` offers menus of other types that are not
multi-select; catalog ancestry merely marks likely parents. The selected module must be usable at this location.
`entries.py::get_parent_filter` matches any direct **non-extension** index to the selected id. This remains true
when the chosen menu lists the extension's host type: an extension-only edge contributes zero eligible rows. An
advanced parent predicate matches only the named index and the selected parent's case ID. The enclosing
nodeset still selects its candidate case types and state. Preserve relation/type information for authoring
without adding it as a runtime predicate on that edge. In M2 and group 7, seed an edge with the same name
and ID but a different stored relationship. Compare the basic non-extension path with the named advanced
path in both the native selector and the SQL case list. Reuse group 4's relation
index and checkers, keep cycle and datum conflicts guarded, and use `QueryArgs.parentCases` for every
page/count. Validate the entire parent id set in the same app and Project. Include ordinary child edge,
extension-only edge, no edge, other record type, other Project and bare-list-parent controls.

Project the actual ordered frame for every after-submit choice, link, case-list return and entry point.
`workflow.py::EndOfFormNavigationWorkflow._get_static_stack_frame` pops the final selection or command for
Previous, discarding trailing nonselection datums as it goes. On a form listed on Home this may produce a frame
containing the form command or the shared first-menu case with no command. Keep that case in Preview's Android
home state for each subsequent command that requests its datum; on Web Apps rebuild the frame according to
Formplayer's `MenuSessionFactory.rebuildSessionFromFrame`. Carry the case through Back and a link/entry/Register
that starts at Home. An explicitly fresh Home or a new worker starts fresh. Calculate this from the whole
screen's common prefix, including every forms-above menu. Recompute after add/remove/move, changes to
case-selection/registration or an edited sibling. The edit planner shows the newly changed destination with the
responsible menu and the two platform results; changing the setting stays explicit. A still-legal Previous stays
Previous. If an edit would make a selected link or computed supplier impossible, return its placed finding and
offer removal/retargeting in the same mutation batch. Remove only the first-menu restrictions proved by this
frame. Existing invalid above-menu module/list endpoints still refuse.

On a form's deep link let the author expose a named computed datum that the built frame contains. Store the
**supplier identity**, for example the case creation operation, on the form's entry configuration. The external
argument id is the id that the entry actually assigns. Route all signatures through
`lib/commcare/entryPointProjection.ts`, `entryPointSignature.ts` and `entryPointSuite.ts`;
`EndpointsHelper.get_argument_ids` walks frame order, includes selected datums as before, and includes
nonselection datums named by `function_datum_endpoints`. Values supplied by the caller replace the computed
value in the navigation frame. HQ creates claim preludes for eligible selection arguments alone, and omits them
on an inline search. Keep scalar arguments separate from ordered collection arguments. The Builder deep-link
panel and served tools offer only computed values actually available on the route, report removals/renames that
change a released signature, and show required arguments at link generation. Preview and launch validate arity,
type, the worker/Project scope of referenced cases and creation-id availability before installing a frame or
writing a case. A caller-supplied identifier grants no rights to an existing case. Apply the stored
manifest/released-suite check to mirror-authored links as well as ordinary ones. Test substitution, missing
argument, collection order, collision on create, stale manifest and failure leaving selection and claims intact.

## M3. Display conditions and badges

Extend the lookup reader’s source-keyed instance resolution to the complete suite entry that evaluates a
condition. In HQ’s `suite_xml/post_process/instances.py`, `_get_all_xpaths_for_entry` scans the command,
reachable details, datums, search request, assertions and stack frames, and selects menu expressions by build
version. `_get_custom_instances` joins declarations to the command’s owning form. The same local ID may be
absent in a neighboring entry. Group 1 witnesses a grouped lookup ID with and without a scanner-visible
sibling in one search request. Carry this pair through a gated Search default, a referenced detail, a
form’s custom instance and an unrelated command when the shared menu/entry projection can name those owners.
Retain the exact built suite’s per-entry declarations and both readers’ worker outcomes for the M3 corpus.


Reuse the existing typed `Expression`, slot scopes and typed relation/table/property references.
`Module.displayCondition` has the menu session context. A form condition may read the case only when its actual
screen already chose it and the HQ build can resolve it on that command. The wider boolean slot admits supported
queries of the restored cases and tables, typed parent/host paths and the worker's record when the entry has the
required worker case/instance and capability. Apply the manifest's worker-record row also to list slots through
the group 4 evaluator/compiler. Preserve the existing visibility flag for an always-hidden menu; keep refusal of
expressions that fail the build, read a missing instance or cannot evaluate in that slot. Menus read the
worker's restored snapshot; a SQL list predicate reads the scoped production case store. Add each pure function
once under its actual operand/result types, lifetime, error, locale, missing and date semantics. Bind a list's
SQL result to the same independent Core/HQ controls before admitting it. No source string is an escape hatch.
Update the expression builder and public typed reference text together, using a picker for available
record/table contexts and showing why a missing case is unavailable.

A menu's or form's first badge has a discriminated localized text or expression value. Use the existing
localization units keyed by owner and role; check an expression against the badge's actual display context.
Extra `custom_icons[1:]` follow their current inert standing. Correct
`reader/menus/modules.ts::caseListCustomIcons`: HQ's `CaseList` inherits the mixin, but `entries.py` builds its
case-list command using the label, picture and audio alone. `views/utils.py` writes a badge on the form or
module. Add a separate inert claim for the inherited case-list field with a planted value, independently
compared suite and editor save; do not offer a badge on the case-list item. Read/write the first `CustomIcon`,
including HQ's locale-id vs XPath branch in `suite_xml/sections/menus.py`, `sections/entries.py` and
`xml_models.py::Display`. Require the `custom_icon_badges` privilege where the manifest requires it. In both
list and grid styles Web Apps shows the provided text. Android's `MenuAdapter.updateBadgeView` hides empty and
exactly “0”. Above three UTF-16 units, a Java signed 32-bit integer reads “999+”, otherwise the first three
units followed by two dots. Test “0000”, “1234”, an integer beyond Java's range and longer localized text. Use
the existing navigator and form/menu settings for each badge, offer the same edit through SA/MCP, and let
Preview choose the platform's presentation.

## M4. One case-list action and the form it launches

Extend `Module.caseListRegistrationForm` and `lib/domain/menuForms.ts` with the target role (registration of the
list's type, or follow-up of the chosen parent), the concrete created-case supplier when appropriate, optional
display condition, its availability and its return. Existing `always` and `after-empty-search` mean what they
mean today by default. Keep the form's own menu membership separate from which hosts offer it. A hidden
registration offered on a second list remains one form and one hidden source menu. Its second launch carries the
invoking host and that host's current session. Form reads must have a supplier on **every** allowed launch or an
explicit expression-path guard with a demonstrated runtime value. Never manufacture another host's search
answers. Show the eligible forms, selected operation/parent record, conditional visibility and after-submit
destination beside the host list; project the same launch sites from the form's settings and tools.

Use HQ's actual rules in `views/modules.py::get_parent_select_followup_forms`,
`models/forms.py::{Form,AdvancedForm}.get_registration_actions`, `helpers/validators.py` and
`suite_xml/sections/details.py::DetailContributor.get_datums_for_action`:

- A basic form registers exactly once for the host type via its own open or one child open **outside** a repeat.
  A different-type registration or follow-up that creates that child is eligible. The independent advanced
  eligibility test allows one open of the target type, with only its allowed parent loads and auto-selected
  cases. Name the operation, derive its wire datum from `session_var_for_action` or the advanced action's
  session variable, and map selection datums from the host's first form only when the case type match is unique.
- On an advanced host, all forms have the same set of non-auto-selected loaded case types, each has such a load,
  the loads form the required parent chain, the final load has the host's type, every form uses the same final
  tag, and the final load uses this host's details. These are the six checks in
  `AdvancedModuleValidator.validate_with_raise`; a newly moved form can invalidate the action. Show the first
  offending form and available repairs before committing. Regenerate the frame from the target form's actual
  placement.
- The parent follow-up requires active parent selection, an eligible case-requiring, non-registration form of
  the parent's type, and `FOLLOWUP_FORMS_AS_CASE_LIST_FORM`. The same gate controls a custom action condition.
  HQ emits the action with the selected parent and `return_to`. A pure follow-up **does not acquire a
  registration return frame**: `CaseListFormWorkflow.case_list_forms_frames` skips a host unless the form
  registers its type. Honor the target form's ordinary end-of-form workflow. A registration uses its
  host-specific frame unless the form has its own overriding navigation.
- For the hidden empty-search arm, keep the existing return to results and add the return corresponding to HQ's
  `post_form_workflow: default`. In the latter, a created case opens the host with that case selected; without a
  created case the shorter frame applies. Generate both guarded frames using the host's identity and the actual
  created-case datum. The pure return-to-list arm has no created-case frame. Combine the solved first-menu frame
  when appropriate. A failed search, pending search and completed zero results have separate activation states.

Extend `lib/commcare/reader/menus/registration.ts`, the common emission plan and Preview's
`caseListRegistrationAdmission`, host return and route history. Read the exact host/form pair before deciding
whether a repeated target is the hidden placement. A publication or HQ change preserves existing form ids,
placement and historic cases. Prove with `RegisterFromListRuntimeTest`, editor save and Launch/Submit/Back on
each offered arm. A source bound from the wrong host and a copied registration frame on the pure follow-up must
both fail the judge.

## S1/M5. A search and the child form that reads it

Add an optional results name on the **menu**, independent of enabling Search. HQ's
`models/case_search.py::CaseSearch.get_instance_name` uses `results:inline` when none is set and
`results:<name>` otherwise; an ordinary Search action still uses its action instance. HQ compares a child's
effective instance name with both its inline-search navigation parent and its inline-search selection parent
even on a child with no search (`ModuleBaseValidator.validate_search_config`, `validate_parent_select`).
Preserve the name there, accept the editor-safe nonreserved values in the named-instance row, and offer unique
names on add or move. A stored expression identifies **which menu supplies** its results/answer and which field
UUID, never its wire instance name. A reference bound today to the current menu keeps that meaning. Update
`lib/commcare/session.ts`, all serializers, the XForm declarations, suite, CSQL interpolation, reader binding
and Preview instance indexing; rename a menu's search and all external instance reads derive the new spelling.

Answer availability is a property of the built form entry. In HQ, `EntriesHelper.add_parent_datums`
aligns/copies navigation datums before queries exist. `add_remote_query_datums` inserts a query immediately
before a case selection sourced from a menu using inline search. Merely being under a searched menu supplies
nothing. In Web Apps `QueryScreen` installs the completed result and search-input instances on the session;
Core's `VirtualInstances.buildSearchInputInstance` and `CommCareInstanceInitializer` resolve by that result's
id. Let the child form read a parent's search fields exactly when its entry loaded the parent's query. Store
completed answers separately for each frame and menu, drop the right ones on Back or new worker, and wait for
their completion on replay. An unloaded read remains the present refusal, and an input read unavailable on
Android remains platform-gated. Ordinary lookup of a case by id and direct entry-point hydration must not
fabricate search answers. Show the supplier's menu name in the child expression picker and in SA/MCP references
when field names overlap.

Extend `reader/search/__tests__/childOfInlineSearch.test.ts` and the independent HQ/Core/Formplayer walk with
two differently named searches sharing a field name. The selected parent's answer and the child's own answer
must remain distinguishable after a retry, a rename, switching child menus, browser Back and changing the
selected parent. Repeat with navigation parent alone, an inactive child name and colliding names. Bind the
positive and negative evidence to the two owner rows before closing M5.

## S2. List filter, search request and the device's results

Today `lib/commcare/hqJson/caseList.ts`, `lib/commcare/suite/case-search/`, `lib/doc/hooks/useSearchFilter.ts`
and `lib/commcare/reader/search/rows.ts` project one list filter into both places. From this slice, the **list
condition** and **server search condition** each have their own edit. Keep the existing list slot. Add an
optional search-condition override with an explicit “all records” arm: absence projects the old search condition
from the list, explicit all records sends no restriction. On a single-surface edit compute both previous
effective values, preserve the unaffected one and canonicalize equal projections back to the shared spelling.
The existing combined authoring command still sets both. This lets old documents and existing callers keep every
previous effect without migrating stored blueprints. A wire read with two equivalent conditions chooses the
canonical shared representation. A runtime value derived from the worker’s clock and the server’s `today()` are
different expressions, even if they match today.

Read the ordered `_xpath_query` values with the CSQL parser. Separate ordinary typed field-generated clauses,
their guards and independently authored conjuncts. Unguarded clauses over a matched prompt keep both automatic
matching and the independent condition. Unguarded clauses over an excluded prompt use its value if present and
the unanswered value otherwise. Do not introduce a presence guard by factoring a conjunction. Read each
`Detail.filter` independently, including when an advanced load selects using that detail. Widen the slot checker
by actual server semantics: exact text vs numeric/range/date conversion, ISO value or runtime failure, metadata
comparison vs an ordinary property and operation-specific missing behavior. The generic manifest classes for
text/time ordering and datetime properties compared with text mean HQ-built **and executable** CSQL.
`case_search/xpath_functions/comparison.py::_case_property_range_query` first attempts numeric conversion, then
a date/datetime; arbitrary ordered strings and bare clock times that fail both are not a new lexical ordering in
Postgres. Split non-executable value classes into placed runtime refusals, with independent HQ query evidence,
and keep actual typed numeric/date/datetime text cases. Keep unrepresentable dynamic property names and broken
expressions under their own refusals.

Project the search in stages. Start from the authorized server population of open requested types, compile
request conditions and native matcher rows, order there and apply the server's result cap **before** evaluating
the device-side selection, result detail order or pagination. Add the related rows needed by HQ, distinct from
primary matches. An ordinary action's results select from its instance by type and exclude tagged related cases
(`post_process/remote_requests.py::_build_datum_nodeset`). An inline entry additionally applies its local detail
filter on the returned instance where HQ builds it (`entries.py::get_datum_meta_module`). A browse list reads
the restore and its own condition alone. Implement the multi-stage membership in `CaseStore.query/count` using
bounded relations/subqueries, including a distinct results-row reading for the device's post-search predicate.
`lib/preview/engine/serverSearchRead.ts`, `searchResultsSnapshot.ts`, case-data binding, app journeys and the
component all consume this result. Use the existing baseline cap of 500
(`lib/commcare/session.ts::SEARCH_RESULTS_CAP`) and a target-confirmed 1,500 for `INCREASED_MAX_SEARCH_RESULTS`
and test search sort/membership on either side of it. Filtering a device array or moving an inline predicate
ahead of the cap changes the answer. Reuse `compilePredicate`, SQL relation resolution and SQL-backed
count/page, preserve `heldOnDevice` and claim on the existing paths. The cases, indexes, supporting cases, owner
lookup and joined lookup fixtures each carry their authoritative app/Project constraints. A request's domain
criterion can exclude this app's rows but cannot select another organization's or Project's data.

**Scores and cutoff ties.** HQ uses Elasticsearch hit score and physical document order as the default
sort (`case_search/utils.py::_apply_sort`). A fuzzy and an exact match can receive different scores.
`es/case_search.py::wrap_case_search_hit` projects the returned hit score into
`commcare_search_score` when requested, replacing any case property with that name in the result. Keep
the result-only score separate from the persisted property and the device restore. A boolean SQL match
alone cannot supply that score. For Nova’s ordinary case-result query, derive proven matching/ordering
classes from the typed request and available target facts. A sufficient explicit order with a unique cutoff
determines membership. An unspecified tie entirely inside a returned set can be compared as a set wherever
no later step observes its order. Use the device detail order when it specifies how to show that set.
HQ's fuzzy query also caps candidate term expansions at 100 (`es/queries.py::fuzzy`). That choice depends
on the index vocabulary. A per-row edit-distance predicate cannot certify membership merely because fewer
than the result cap were returned. For exact native-fuzzy membership require the equivalent indexed corpus
and term-ranking semantics or the authoritative scoped result. A verified exact-query branch or an
index-independent exclusion can still answer its own question. When fuzzy expansion could change the set,
apply the same explicit unavailable outcome below, even below the result cap. Prove a synthetic index
with over 100 eligible near terms, a distinct exact-token control, and cases on both sides of the expansion
boundary. App Test must never mark a guessed match as having completed the worker’s search.

When actual score values, ordering between differently scored hits or an unresolved tie at the cap could
alter what the worker can read, select or claim, require authoritative worker-bound results for that
observation or show that the exact result is unavailable in Preview. Offer a narrower filter or an explicit
sort distinguishing the boundary. A local tie-breaker cannot certify HQ's `_doc` order. Do not issue a
partial claim, count or export of search results on that uncertain input. The app can still run the typed
search against HQ. Pair 501 tied matches at a 500-row cap with 499 matches and with a unique sort crossing
the cap. Include an exact and a fuzzy hit, a stored property colliding with the score, an inline filter that
removes only the last candidate, and a post-search display that reads score. Compare actual covered rows and
score values where promised, and the precise unavailability outcome elsewhere.

A native search filter holds an ordered typed request entry with a stable UUID, target (property, typed ancestor
path, owner, case id, project-space name or named reverse index) and a device-evaluated value. The Search
action's own display condition remains a boolean in the pre-selection screen context: use the same session,
lookup and worker references available on that screen, with no selected-case or form-answer assumption. A
native-matched field is a field whose **request key** chooses HQ's matcher. Its name can identify `case_id`,
`owner_id`, `status`, `name`, a date field or a related property. Apply the pin's distinction between special
id/owner/domain branches, indexed metadata and plain properties. An empty plain value matches empty or absent;
an empty owner or project-space criterion applies no restriction; an empty id still filters on the empty id; the
blank reverse-index criterion has its own removed-index meaning. The cleared-index contract below handles that
last distinction. Use the actual server behavior for ancestors, missing properties and multiple values. Validate
or surface the same query error for a value the ancestor comparison cannot represent. Retain independent
explicit-clause matching for existing fields. An excluded note field is available to expressions even though its
own key does not filter anything.

**Cleared indexes and historical records.** HQ's
`form_processor/backends/sql/update_strategy.py::_apply_index_action` updates an existing index to an empty
referenced id, and creates none for an empty write to a previously absent index. `CommCareCase.indices` and the
raw case serializer retain cleared ids, while `live_indices` excludes them.
`apps/es/case_search.py::reverse_index_case_query` compares the stored id and identifier. Nova’s
`PostgresCaseStore.rebuildParentEdge` and the index writer in `postgres/submissionEnvelope.ts` delete the old
edge. Model three observations for one case/identifier: a live target, a known clear, or known never linked.
Prior information can also be **unknown**.

- Introduce a coverage bit on the case row, set by the store only when the case was created under complete index
  tracking. Existing rows start with incomplete historical coverage; neither a v7 case id nor `opened_on` is a
  creation watermark. Keep cleared identifiers separate from live `case_indices`, scoped to the same app,
  Project and lifetime of the case. A live edge always proves the current target. If there is no live edge, a
  retained clear matches an empty query; on a completely tracked row with neither marker nor edge the query does
  not match. For an older row with neither, the answer is unknown. The case marker and observed identifiers
  follow authorized moves and are removed on deletion, including delete/recreate with the same caller-supplied
  id. In a new case seeded from an incomplete historical external record, mark coverage incomplete unless its
  source actually supplies cleared identifiers.
- Enroll new cases and update edge/clear state in the same case-store transactions as inserts, updates,
  sample/bulk inserts and submitted link operations. Deleting a previously live edge records a clear; assigning
  an id removes the marker. Clearing an already absent edge preserves the previous known/unknown state. Update
  reset, cleanup of inbound links from surviving cases and lifecycle cascades with the same ownership rules. Old
  writers concurrently clearing an edge would invalidate the coverage assertion. Enable complete tracking only
  once every live writer follows the new contract; keep rows created during the change classified incomplete
  unless their full link history is accounted for. Prove rollback and retry preserve the four observations.
- The preflight reads `cases`, `case_indices` and completed `form_submission_intents.result`.
  `SubmissionEnvelopeResult.caseDatabasePatch` can contain the **post-submission** direct edges of touched rows;
  older receipts may omit it. `OperationEffectRecord` carries an operation id, execution flag and case id, not
  the old index target. `cases.parent_case_id` summarizes a current parent only, and `app_changes` records
  blueprint changes. These sources prove current live links and particular observed historical states, **not** a
  complete sequence of case-workspace edits, bulk writes, resets or case incarnations. The scan reports counts
  of existing rows, live edges and available historical observations per authorized scope. Only restore a
  historical clear from a complete, ordered, same-app/Project history for the same case lifetime (for example an
  independently retained transaction history establishing assignment, clearing and all subsequent writes up to
  enrollment). A prior positive receipt plus an absent edge alone cannot exclude deletion and id reuse. Without
  that evidence keep the old absence unknown. Never assume an HQ app's source, which carries its design, is a
  backup of Nova's case rows.
- Resolve uncertainty **before** counting, capping or publishing a completed result snapshot. The query first
  narrows candidates with its known type, status, scope and independently decidable request filters, in the same
  transaction/snapshot. If any still-eligible row has unknown membership for a blank reverse-index criterion,
  return a typed `link-history-unavailable` result to Preview and App Tests, including count/page/detail-support
  reads. The worker sees “This search needs earlier record-link history that Nova doesn’t have.” The builder
  identifies the search field and index and offers to test with newly created records in an isolated App Test
  dataset or change that criterion. Return no partial rows, total or zero-result registration action; make no
  new claim. Other queries and a query that already excludes every unknown record continue normally. A verified
  historical restore resolves that record's state; a subsequent genuine assignment, or a genuine clear of an
  observed live edge, establishes it going forward. Never mutate worker records to manufacture proof. Use four
  cases (known live, never linked, cleared and unknown), then place the unknown case beyond the visible page and
  in another Project to prove both refusal scope and isolation.

HQ applies fuzzy and ignored-text settings on the configured (requested case types, property) combinations,
strips the configured **literal** text from request values, then uses its exact or fuzzy matcher.
`CaseSearchQueryBuilder._get_query`, `_patterns_to_remove`, `_fuzzy_properties`,
`apps/es/case_search.py::case_property_query` constitute the oracle; multi-value fuzzy requests can fail. For
server CSQL add a search-context term for the project-space day. For date-only comparisons on `date_opened`,
`closed_on` and `last_modified` reproduce `comparison.py::_create_system_datetime_query` and
`adjust_input_date_by_timezone`: equality starts at local midnight converted to UTC and ends 24 elapsed hours
later; ordered inequalities use the pin's operator and boundary, including the next local date for `>` and `<=`.
Do not “correct” a daylight-saving boundary in one implementation. `xpath_functions/value_functions.py::today`
uses the domain zone; a device default still uses the worker zone. Use a bound reference instant for all
branches of the same search. Reuse the existing fuzzy matcher only for cases proved equivalent, using HQ's
accepted/returned ids and Project-scoped Postgres results including token boundaries, case, multiword, empty and
exact matches.

**Where Preview gets those facts.** A target's IANA time zone, fuzzy property sets and literal ignore patterns
are project-space configuration, absent from the key-readable app/resource. Give Preview explicit search
settings for the selected server/domain within the Nova Project: a person with edit access confirms the zone and
per-type matcher configuration (including explicitly “no overrides”), or chooses a named local Preview
configuration for an app without a destination. Defaults for a new local configuration are UTC and exact
matching, displayed before use. Store these as revisioned Preview configuration, separate from the app, and
share them only within the authorized Project. For a brought-in app retain the search immediately and let the
person supply the missing facts for Preview; a dependent search shows which settings it needs before running,
while unaffected searches still run. In multiple destinations require an explicit target if target-dependent
facts differ. A remembered value is marked as supplied by the team. Changes to HQ-only settings cannot be
detected by a source digest or asserted current by Nova. Publishing uses HQ's own rules and the target's own
day. Changing Preview settings invalidates completed search state for that configuration; it sends nothing to
HQ. Do not reset another team's configuration during bring-in or an HQ edit.

**Existing first-publish changes.** Remove new occurrences of `search-today-device-day`,
`search-filter-joined-to-list` and `search-restates-list-filter`, their obsolete rewrite/allowance entries and
their controls' positive expectations when the exact native values and independent filters ship. Keep old
durable notice ids renderable wherever historic rows still name them. Plant a missing independent filter, a
wrong-clock result on either side of midnight and a different row beyond the server cap; the stricter
comparisons must fail. Keep `search-filter-rows-recut` for semantically identical CSQL row partitions and
`search-value-guards` for the remaining explicit-value encodings that still need guards. The filter split does
not retire unrelated registration-label, text normalization, language-fill or link-guard allowances. Narrow the
search-title paths of any fill allowance for the exact shape S3 now holds.

## S3. Fields on a Search screen

Extend the existing UUID-bearing `searchInputs` with typed optional choices on their existing arms. A widget,
its scalar/sequence answer, default, data supplier, visibility, validation, inclusion as a request parameter and
its matching strategy describe different things. Do not encode one as another. A reader classifies an HQ field
from its key, widget and `exclude` state together. Preserve the exact parameter name as a name (including path
separators or punctuation that HQ actually accepts); carry the typed path separately when it denotes a property.
Search-answer references use UUIDs internally and a quoted key or selection chip for names that cannot be
written as a simple identifier. Test punctuation, ancestor paths and built-in names. Refuse names in genuinely
reserved or runtime-broken classes (including a spelling that Core cannot parse in an actually evaluated
validation reference). A date field or range used to match a text/wider-writer property keeps its widget type
and reads the stored wire value under the chosen matcher's rule. Changing a widget does not retype a case
property.

- **Defaults and choices.** Support ordered checkbox choices, validating their values against the current
  itemset as the device does, and the typed range value whose runtime spelling is `__range__<start>__<end>`.
  Hold ordered boundaries, a dynamic default in its device expression and the distinction between absent,
  incomplete and invalid values. Give a query in a default, hidden value, owner exclusion or search value an
  expression card for source, filtered rows and selected value/aggregation. Reuse the domain expression, typed
  row scopes and group 4's resolved relation, case, lookup or place identities. On a search screen these reads
  see only the supplied device/fixture snapshot. A table choice can use the table's normal rows, or a typed node
  sequence from a declared or otherwise available instance with item-relative label/value/sort expressions.
  Inventory all declared fixture dependencies even when the nodeset's source differs. Prove node order, absence
  of an optional instance, scoped filters and distinct bindings of current/parent row. An undefined instance, an
  unsupported provider, a surviving report-specific refusal, or a computed reference with no typed target keeps
  its placed finding. Bound all reads by existing reader-work and query-complexity limits.
- **Visibility.** Represent hidden excluded text without a default, hidden matched text, and a hidden field with
  its widget/default as separate combinations of the same settings. Do not conflate omission, deliberately blank
  request and a prefilled answer. Android draws every supported prompt even when hidden; unsupported inputs get
  no default or answer. Web Apps hides the field, and a skip-to-results automatic request sends its query data
  without appending hidden matched prompts as though the worker had submitted them. Checkbox values retain order
  at form submission and use Core's answer encoding. Test initial defaults, invalid/stale choices, refresh after
  another input changes, explicit submit and automatic submit.
- **Blank and grouped inputs.** Keep “Search for blank” independent of no answer and retain `allow_blank_value`
  only where a platform reads it. Give group headings UUIDs, stable keys, localized names and order, with each
  field referencing its group. Group headings do not send a request field. HQ requires a group key for every
  field once a grouping row exists. Reordering or removing a group moves/reassigns its fields in one batch. Web
  Apps renders the grouping and its blank-search affordance; Android shows the plain inputs and ignores them.
  Prove blank, unchecked, missing, empty list and an answered value on the actual query.
- **Geocoder.** The Web Apps address input broadcasts structured address components on selection and clears on
  reset. Bind a receiver by source input UUID and ordered address component choices, with the first available
  component used. A text receiver gets the text; a lookup receiver matches the displayed option label, retaining
  its underlying option value. At the boundary use HQ's actual receive key and component spelling, including
  fallback lists. The address itself does not become an ordinary search parameter. Parse
  `query.js::updateReceiver`'s representable topic and field split exactly. Represent a saved inert/unsubscribed
  receiver separately if the topic cannot resolve; never bind it heuristically to a similarly named field. Reuse
  the earlier address result/selection adapter and the authoring control, with actual geography from the enabled
  provider, request cancellation and an unavailable state on provider failure. Keep worker-typed search text
  local except for the explicit address lookup. Android omits the address prompt and ignores receivers. Gate the
  input and receiver on the corresponding geocoder privilege and advanced setting.
- **Required/check expressions and blank messages.** Add the typed Search screen rule capabilities to the
  existing checker/evaluator. Hold a localized authored message, or the runtime's own message for that check,
  distinct from Nova's existing authored/default sentence. `build_query_prompts` emits required text whenever
  its test exists and validation text only if the validation has text. Compare the actual `QueryPrompt` message
  under each language, including no text at all. Android ignores these checks. For search titles let a
  translation unit explicitly have no visible heading in one language while another has text; preserve HQ's
  per-language *resolved* fallback/blank result. Do not use a whitespace sentinel for an empty title. Check
  localized heading, label, error and no-heading cases on both save and publish.

`lib/commcare/reader/search/{prompts,settings,rows}.ts`, `search/guardSplit.ts`, the two wire projectors,
`components/builder/case-list-config/inspector`, `lib/agent/tools/{case-list-config,case-search-config}`, Search
screen runtime and Preview/Application Test runs change in the same field slice. A field UUID stays stable
through rename, translation, group moves and dependency repair. A UI mutation that removes a referenced query
field or table includes the affected sites. Editor and tools show “Matched by the project space” or the explicit
rule wherever the choice changes which cases can appear.

## S4. Request controls, result settings and workflows

Store ordered server sort choices as (property identity, exact/date/numeric comparison, direction). The server
selects its top results in that order, and the device may then sort the returned rows using its own result
detail. Store the set of additional **result** case types and the typed **request-only** case types separately.
Resolve properties and references across the admitted result types, using group 7's wider writer joins for
shapes newly producible there. Use the case's actual type throughout detail, case selection, claim, form
admission and writes; do not reinterpret a returned case of another type as the menu's primary type. Keep
project-space dependencies and the stricter constraints of advanced form loads in the gate.

Give a search an optional related-id property and an explicit setting for related cases (derive from relation
reads, include, or use HQ's detail-based selection). Canonicalize readings whose emitted field would be
identical. `case_search/utils.py::get_and_tag_related_cases` expands the custom property first, obtains related
records for the combined initial cases, removes duplicate and primary ids, and tags supporting rows. The false
arm can still return records via search-detail paths or child-case tabs. Supporting rows can supply a property
or tab without becoming selectable primary results. On the detail-based arm, build the union of eligible
non-XPath search-detail relationship paths and child tab types across every search-enabled menu for the
requested case types, including sibling menus. Return the terminal records of each requested path. An
intermediate used only for traversal belongs in the fixture only when independently requested. Read
custom expansion from the dynamic property and preserve each supporting row’s actual status. The open-case
predicate on primary hits does not apply to all supporting rows. Replace the unconditional open status in
`searchResultsXPathInstance` with the observed primary/supporting row status. Prove two searches of the same
type with a relation path named only by the sibling, an unrequested intermediate, a closed terminal, a
separately requested intermediate, and a cross-Project edge. Compare the returned tagged instance, counts,
selectable rows and claims independently. A search-only owner exclusion is independent of
`CaseSearchConfig.excludedOwnerIds`'s current both-surfaces availability semantics. Use the S2 canonical
override convention, preserve the no-search owner-only arm, respect the worker-restore restriction on browse,
and ensure a dedicated owner exclusion and a default owner-exclusion filter cannot create the broken duplicate
parameter.

Keep the *placement* of sort, related property, related inclusion, owner exclusion and extra request types when
those controls come from default property rows. In the default filter list, a typed sort or related-property
reference lowers to that request key; dedicated fields retain their own editor gates. Additional request types
can expand the server search without expanding the device list. A nonempty value of the default
related-inclusion parameter enables inclusion even if its text reads “false”. Keep that value as a typed device
expression when it can vary. Check duplicate/incompatible configuration keys and refuse runtime-computed
property/type names according to the established register. Preserve distinct literal/default and dedicated forms
over edit, reread and republish. New authoring uses the dedicated control when it emits the same chosen behavior
and the target supports it; otherwise offer the default-filter spelling by its meaning and state its
prerequisite.

Preserve the menu landing (`auto_launch`) separately from whether the Search action requests default results
(`default_search`). The existing workflows keep their two effective flags; add the list-first/default-results
combination for the app/build shape in its entry. Android still enters the list. Choosing Search opens its query
UI; Android does not use the default-search setting to submit that screen automatically. The stored combination
survives the HQ editor and a later edit to the menu. Web Apps-capable settings saves that force the landing must
still obey that editor constraint. On a menu showing its forms above, HQ refuses inline search and module
endpoints but can build an ordinary search. Its list suppresses the Search/Register action, while a form's claim
post on form entry and a generated remote request can still change behavior. Narrow only the non-inline branch
of `FORMS_IN_MENU_ABOVE_WITH_SEARCH`, suppress unreachable actions in the correct screen, and test form-entry
sync on and off. `search_on_clear` requires advanced search and an eligible menu without auto-select. At desktop
Web Apps widths (992px and up) Clear triggers a new request; at smaller widths and on Android it does not. Newer
requests own their own result, selection and errors. Test Clear after a completed search, with a pending older
response and after Back.

## S5. Search supplied by a project space

A search can name a target-owned endpoint. The document stores a logical dependency UUID, display name, named
parameters and the named result fields consumed by its details or expressions. Derive the parameter contract
from the prompts, default values and extra keys the configured menu actually sends. Keep the result contract
typed against its uses; where a field's type is not established, read it as returned text. A person may describe
this dependency in Nova, or bring it in from the reference in HQ's application. Its destination binding is a
positive integer id scoped to `(app, Project, server, domain, logical dependency)` in the deployment ledger. No
remote query, endpoint content or credentials go in the blueprint. Different menus pointing to the same
dependency at birth reuse its identity. Use the existing source identity bridge, target ownership/transaction
boundary and reviewed changes path; one id in an app is insufficient to infer another destination's id.

HQ's `models.CaseSearchEndpoint`, `utils.get_case_search_results_from_request`, `get_endpoint_results`,
`get_project_db_fixture`, and `project_db/user_sql.py::UserSQL._clean_parameters` establish the difference. An
endpoint runs its current active version, either an Elasticsearch query over cases or a ProjectDB query
returning rows with a case id. Its integer id reveals neither its kind nor its result fields. The API resource
available to Nova does not describe the definition. Parse every surviving default-property key, including an
existing `_xpath_query`, as a named endpoint parameter. A newly authored parameter uses its own key.
Heterogeneous returned fields belong to the result, and a match still needs a valid case id for HQ's normal
claim. ProjectDB rejects unexpected parameter names at this pin, supplies null for missing ones and
distinguishes an empty supplied value. Show the effective parameter contract including any blacklisted-owner key
and the inline-parent `_xpath_query` that HQ generates. Reserve configuration/metrics keys that HQ removes.
Require an actual prompt or default parameter; omit Nova's zero-input match-all sentinel. Disable regular
request sorting/related expansion here. HQ's ordinary and inline endpoint nodesets select the returned case
elements directly, bypassing normal case type/related and inline list-filter narrowing; the tagged and
mixed-field test detects an accidental fallback.

Keep the endpoint’s raw response, the fixture installed in the session and the case selection distinct.
In an inline endpoint, `EntriesHelper.get_datum_meta_module` begins with the returned case nodes, then
appends the parent predicate and the fixture-selection predicate when their owning route emits them.
The ordinary endpoint action in `post_process/remote_requests.py` has a separate result nodeset.
Use the exact selector for each. Use the Elasticsearch provider for rows with and without the requested non-extension
parent edge. ProjectDB serializes each returned column as text in a single child. Even a column named
`index` cannot supply a nested edge. Test that its inline parent selector excludes such a row, then use
the same row in an ordinary endpoint action without the parent predicate. Observe which rows were returned,
which the worker can choose, and which case ID reaches the form. Use ordinary parent selection as the admitted inline case. Exercise a fixture-selection predicate only as
an upstream negative control for the existing refused, retiring fixture-selection feature.

On bring-in, record and review the observed id for the source **only**. Where HQ later changes the id, show the
target dependency and parameter/result contract change, reread under the same version and review digest, and
replace that target's mapping atomically with the accepted app change/baseline. Multiple uses may split or
converge; resolve bindings only from the source snapshot plus saved lineage. An HQ-side edit to the endpoint
behind an unchanged id is invisible to app drift detection and affects even a released build. State that on the
dependency and publish review. No operation creates, copies or reconfigures the external service. On another
eligible destination, direct publish, targeted manual export and targeted Android package all require the
target's own id and capability confirmation **before** generating a file or changing anything there. Revalidate
target identity and app revision on acceptance. Never infer an id by matching a label; a targetless export that
needs the id has no runnable artifact. The contributor may supply it through the same interactive/API target
configuration path as other publish dependencies. Keep setup links and logs free of row data, answers and
credential material.

Preview renders the prompts, settings and the actual platform's availability, then says this search runs in the
connected CommCare HQ project space. It makes no search/claim request to that space and shows no invented
matches or completed empty state. The same limit is recorded for an App Test step requiring this endpoint. A
readonly viewer can inspect this limitation without gaining publish access or an HQ identity. Production Preview
route and MCP access checks remain at the existing Project membership/role boundaries. Proof exercises both
actual upstream endpoint kinds with synthetic data under their configured target, including deactivated, missing
binding, extra and missing parameter, empty field, wrong target and a changed version behind the same id. This
is the external-data exception described under “Case search endpoints” in the
[research](../../../research/2026-09-26-hq-round-trip/README.md).

## Verification, compatibility and delivery

Every slice exercises its real Builder control and a shared-tool mutation, then reopens the committed app, plays
the selected platform and edits the retained source through HQ's own page. Extend the existing planners and
`diffDocsToMutations` so an adoption and a later HQ change install these same typed values in one transaction
with their identities and baselines. Include the derived form route, source/target selection, all referenced
project data, translations, required flags and media in the appropriate diff, validator, tool readback and
export budget. Keep the current target drift and version checks. Test two stale edits against the same mirror
child or search dependency, undo/redo, rename while referenced, and an HQ edit with unpublished Nova changes on
the other side. A review must show exactly the affected menu, form, criterion or parameter and its consequences.

Menu schema additions and the search overrides are optional extensions. Regression fixtures start from old
persisted docs, including the private owner-only arm, old hidden inputs, the default results name, two-surface
filter/owner exclusions and an old after-empty-search form. Check read, mutation replay, multiplayer fold and
canon across both shapes. Additive database migrations own target bindings, Preview facts and retained
cleared-index state. Apply the existing schema admission and runtime invariant checks. The read-only preflight
measures cleared-index coverage as specified in S2 and validates existing tenant references. Apply and verify
all actual conversion work under the group's cutover contract. Successful deployment must preserve
accumulated target ids, prior case rows and claims, receipts and the ability to reread the prior app history.

For each newly held value class change its reader claim, inventory source, authored manifest entry, Python
parity decision if applicable, and the proof matrix's base/variant/exempt partition. Move it from a refusal
variant to an **HQ-editor-authored base** in `proof/matrix/bases/{menus,search}.py` or a dedicated module there.
A doctored payload is a negative control only. Held variants, refusals and inert claims must retain their
independently observed behavior through subsequent pins. Update `lib/domain/platforms.ts`, its detectors and
manifest binding, availability/cause words, Preview cells and generated guide context in the same slice. Add the
new slots and limitations to the nearest contracts, public menu, deep-link and case-list/Search guides, platform
notes and MCP tool reference. Update the version and prose of the model-facing tool/guide and companion Nova
plugin as required by the shared delivery plan.

| Boundary | Required observation and control |
|---|---|
| HQ adoption, save and re-publish | Real menu settings, form settings, case list and translations pages save the mirror source/children, launch mappings, Search fields and both filter surfaces. Adopt each base, re-publish to the source, edit one value in HQ, bring that change in and publish again. Compare target ids, form xmlns, stable field references, locale labels, app source, local and HQ-built suite and app behavior (proofs 1–6). Wrong real-form mapping, wrong mirror target or a silently unfiltered result is a failing control. |
| Core and Android | Extend `MenuScreensRuntimeTest`, `NestedMenuRuntimeTest`, `EndpointRuntimeTest`, `RegisterFromListRuntimeTest` and `SearchPromptRuntimeTest`. Record exact command/datum/query sequence, match and selected case ids, claim, visible fields and Back. Test the first menu's retained case and a synthetic stale case, the parent search with and without its selection, a checkbox with a removed choice, a badge with four characters, unsupported address and shown hidden input on Android. Check the actual Android view and intent readers for platform-specific cells. |
| Formplayer and Web Apps | Use the served worker and Chromium to exercise opening/registering from a mirror, duplicate field names on distinct query steps, required/validation without messages, geocoder receiver/fallback, checkbox, hidden match on manual/default search and desktop/mobile-width Clear. Capture observable values, including counts and field errors, then compare Nova's worker run. For a changed provider response use a controlled provider boundary with a genuine component result, plus a provider-failure state. |
| Server search and tenancy | Use pinned HQ case-search builder and query execution on synthetic records, including domain-specific matcher settings, numeric/date/exact nested sort and index removal. Compare ids, order where the sort defines it, primary/supporting tags, query cap, empty and malformed runtime value to the production Kysely-backed search against real Postgres. Seed two Projects, two apps, worker-owned and other-owner open cases, closed cases, repeated lookup ids/labels, a parent outside the restore, an index pointing to an out-of-scope id and tagged expansion duplicates. A foreign parent/set/id must yield neither a matching row nor a count, detail, option, claim or write. Run the date boundary across both DST changes and worker/target zones on opposite calendar days. |
| External endpoint | Independent HQ bases run both actual providers with typed arguments; capture request parameter multimap, raw returned fixture, selected nodes after route-specific predicates, actual case id and claim. Check same-target republish, changed source id, second target whose same integer belongs elsewhere, targetless archive refusal, role-checked target confirmation and App Test/Preview's external-search stop. Compare source identity and published binding separately. |
| Exit | Every mapped class has its exact base witness or an explicitly narrowed inert/refused class with a retained counterexample. Mutation/deletion guards, stable readback and a changed-HQ review cover each new stored identity. Keep the intent, first-publish, served reader, platform/register, manifest and coverage checks live through CI and the scheduled served lane. |

## Manifest assignment

Rows sharing a design section use the same production contract. The full entry ids preserve distinctions such as
two kinds of `outside-predicate`, or request placement versus a device filter.

### Menus

| Manifest entry | Section |
|---|---|
| `expressions-and-data/search-input-read-in-the-forms-of-a-child-menu-of-an-inline-search-menu` | S1/M5 |
| `forms-and-case-writes/custom-icons-0` | M3 |
| `forms-and-case-writes/form-filter-outside-predicate-parent-host-user-usercase-reads` | M3 |
| `forms-and-case-writes/post-form-workflow-previous-screen-on-a-form-listed-on-the-first-menu` | M2 |
| `forms-and-case-writes/form-link-or-endpoint-through-a-first-menu-that-shares-one-case` | M2 |
| `forms-and-case-writes/function-datum-endpoints` | M2 |
| `forms-and-case-writes/user-prop-in-module-filter-form-filter-case-list-slots-the` | M3 |
| `menus-and-case-lists/shadowmodule-shadow-module-version-2` | M1 |
| `menus-and-case-lists/child-menu-of-another-case-type-under-a-parent-with-no-forms` | M2 |
| `menus-and-case-lists/shadowmodule-v2-under-a-v2-shadow-menu-mirroring-a-non-shadow` | M1 |
| `menus-and-case-lists/module-filter-value-outside-predicate-any-xpath-hq-s-validator` | M3 |
| `menus-and-case-lists/custom-icons-0-badge-localized-text-or-xpath` | M3 |
| `menus-and-case-lists/shadowmodule-excluded-form-ids-non-empty` | M1 |
| `menus-and-case-lists/shadowmodule-form-session-endpoints-non-empty` | M1 |
| `menus-and-case-lists/parent-select-naming-a-module-outside-the-declared-parent-type` | M2 |
| `menus-and-case-lists/case-list-form-pointing-at-a-follow-up-form-of-the-parent-case` | M4 |
| `menus-and-case-lists/case-list-form-post-form-workflow-default-on-the-hidden-module-shape` | M4 |
| `menus-and-case-lists/case-list-form-relevancy-expression-with-followup-forms-as-case` | M4 |
| `menus-and-case-lists/case-list-form-on-an-advanced-module-or-naming-an-advanced-form` | M4 |
| `menus-and-case-lists/case-list-form-pointing-at-a-form-whose-one-registration-of-the-type-is-a-child-case` | M4 |
| `menus-and-case-lists/case-list-form-naming-a-form-another-list-offers-after-an-empty-search` | M4 |
| `menus-and-case-lists/case-list-form-on-a-host-under-a-menu-that-shares-the-first-menu-s-case` | M4 |

### Case search

| Manifest entry | Section |
|---|---|
| `case-search/default-properties-entry-keyed-by-a-plain-property-property-p` | S2 |
| `case-search/default-properties-entry-keyed-by-an-ancestor-path-parent-p` | S2 |
| `case-search/default-properties-entry-keyed-owner-id-case-id-commcare-project` | S2 |
| `case-search/default-properties-entry-keyed-commcare-sort-x-commcare-custom` | S4 |
| `case-search/default-properties-entry-keyed-case-type` | S4 |
| `case-search/default-properties-entry-keyed-commcare-blacklisted-owner-ids` | S4 |
| `case-search/custom-sort-properties-property-name-sort-type-exact-date` | S4 |
| `case-search/search-on-a-put-in-root-module` | S4 |
| `case-search/list-first-with-a-search-that-skips-to-results` | S4 |
| `case-search/search-button-display-condition-outside-predicate` | S3 |
| `case-search/blacklisted-owner-ids-expression-without-that-clause` | S4 |
| `case-search/blacklisted-owner-ids-expression-outside-valueexpression` | S4 |
| `case-search/title-label-blank-in-some-languages` | S3 |
| `case-search/instance-name-without-casedb-ledgerdb-fixture-or-session-in-it` | S1/M5 |
| `case-search/additional-case-types` | S4 |
| `case-search/custom-related-case-property` | S4 |
| `case-search/include-all-related-cases-false-where-nova-s-relation-reads` | S4 |
| `case-search/include-all-related-cases-authored-without-relation-reads` | S4 |
| `case-search/search-on-clear` | S4 |
| `case-search/case-search-endpoint-id` | S5 |
| `case-search/prompt-named-for-a-case-attribute-hq-matches-itself` | S2 |
| `case-search/prompt-key-outside-nova-s-name-grammar` | S3 |
| `case-search/appearance-address-geocoder-broadcast-emitted-input-address` | S3 |
| `case-search/input-checkbox-itemset` | S3 |
| `case-search/date-prompt-matched-by-hq-s-own-rule` | S2 |
| `case-search/search-field-over-a-property-of-another-type` | S3 |
| `case-search/itemset-nodeset-filter-predicate-outside-predicate` | S3 |
| `case-search/itemset-without-the-item-list-its-instance-id-names` | S3 |
| `case-search/default-value-on-a-date-range-input` | S3 |
| `case-search/default-value-outside-valueexpression` | S3 |
| `case-search/hidden-exclude-without-a-default-value-on-a-prompt-with-no` | S3 |
| `case-search/hidden-without-exclude-on-a-prompt-with-no-itemset-input-type-or` | S3 |
| `case-search/hidden-on-a-prompt-that-carries-an-itemset-input-type-or` | S3 |
| `case-search/allow-blank-value` | S3 |
| `case-search/required-or-validation-test-outside-what-nova-types` | S3 |
| `case-search/a-required-or-validation-test-with-no-message-in-any-language` | S3 |
| `case-search/receiver-expression` | S3 |
| `case-search/is-group-group-key` | S3 |
| `case-search/date-only-comparison-on-date-opened-closed-on-last-modified` | S2 |
| `case-search/a-search-value-that-queries-cases-a-table-or-places` | S3 |
| `case-search/xpath-query-row-reading-a-field-hq-also-matches` | S2 |
| `case-search/xpath-query-row-reading-an-excluded-field-outside-its-presence-guard` | S2 |
| `case-search/xpath-query-row-that-is-neither-a-list-filter-clause-nor-a-search-field-s` | S2 |
| `case-search/case-list-filter-clause-the-search-does-not-restate` | S2 |
| `case-search/xpath-query-condition-outside-what-nova-types` | S2 |
