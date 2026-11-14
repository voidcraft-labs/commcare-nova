# Step 6, part 07: The reader: case management, menus, lists and search

Part of step 6's plan, "Bringing an app in from CommCare HQ". This part plans the half of the reader that
turns an HQ app's stored JSON, and the case blocks its forms hold, into Nova's case operations with each
placement held, its menus and their nesting, its after-submit destinations, its deep links, its case
lists and details, and its searches. Every rule is written as the inverse of an emitter Nova already
has, and each is accepted the same way: the reader proposes a Nova value, the production emitter writes
it, and the two are compared. It gives the manifest rows these readers flip or add, and it builds one
thing every Nova app gains: a case list column that is not on the list (11.6), without which no
document could say what nearly every HQ app's case detail says. It speaks the reader's frame as part
06 (06-the-reader-forms.md) writes it.

Citations are `path::symbol`. Nova is read at `main` `1f103305`; the Dimagi checkouts at the pins
`proof/pins.json` names: commcare-hq `d6c6e16d8ae1`, commcare-core `8e9ba8d908e9`, commcare-android
`7a5584475580`, commcare-connect `046c7fd78081`, formplayer `24383ac71bfb`, Vellum `01215f251c57`. Every
CommCare fact below was read at those commits for this part, or is the cell of the manifest entry named
beside it, which holds its own citation. HQ paths are relative to `corehq/apps/app_manager/` unless they
start with another app's name. A manifest entry is written `area/id` exactly as
`lib/commcare/surface/entries/<area>.json` holds it; where a table is about one area, its heading names
the area and the rows give the id alone.

What this part changes outside the reader. The reader is server-only code no tool input, tool
description or guide sentence reads, and it changes no document an App Test pins. Section 11.6 is
the exception on one side: it adds an input to two tools the Solutions Architect is offered and a
sentence to the authoring guide, so it is one of the changes the step's one move of
`lib/models.ts::MODEL_CONTEXT_VERSION` carries. Nothing here moves
`lib/db/appTests.ts::RUNTIME_VERSION`: no document that exists holds the new slot, so the runtime
reads every pinned document as it did. No migration, no DDL and no `/api` route is in this part.

| Section | Owns |
|---|---|
| 2 | where these readers stand in the reader: phases, inputs, outputs, the claim rule, the one recognition method as used here |
| 3 | form types and basic form actions: open, update, close, child cases, the worker's record, preloads |
| 4 | advanced forms: loads, open actions, tags, the chain test, the held menu kind |
| 5 | Save to Case blocks: Nova's own shape, and the boundary beyond it |
| 6 | `publishedCaseBlocks` extended, and `hqEntryFacts`: placements and session values compared between the HQ app and Nova's emission |
| 7 | the case catalog: case types, properties, and how a property's type is found |
| 8 | menus: order, nesting, names, kind, display conditions, forms in the menu above, the case list menu item, media, both registration arms, the hidden registration menu |
| 9 | after submit: the workflow word, links, the otherwise, held-case guards |
| 10 | deep links; what this part reads of the CommCare Connect blocks part 06 read |
| 11 | case lists and details: columns, the order plan inverted, the filter, tiles, selection, and the column that is not on the list |
| 12 | search: workflow, fields, the rows of `_xpath_query`, default filters, settings |
| 13 | every finding these readers raise, with its entry id |
| 14 | manifest edits |

---

## Decisions in brief

1. **These readers are modules under `lib/commcare/reader/`, each run in two passes.** The first
   pass reads structure from JSON, parent selection included, and registers every XPath text with the
   expression reader; the second, after the expression reader has bound them, settles what only a typed
   tree can decide (where each search row lives, which default is a preload) and accepts every
   proposal. (Section 2.)
2. **Every recognition is a proposal checked by the production emitter.** The reader proposes Nova
   slots, calls the same projection `expandDoc` uses for that slot over a frozen snapshot of the
   candidate document, with the source's own ids, project space, tables and media paths, and accepts
   the proposal only when the result equals what the HQ app holds, after the manifest's inert and
   same-state rows. No recognizer matches text, and no projection runs over a document that is still
   being written. (Section 2.4.)
3. **A form's type is derived from `requires` and its active actions, never stored on the wire**, by
   the eleven rows of the manifest's "Form types". (Section 3.1.)
4. **A basic action's condition becomes an `Expression` directly**, by the inverse of
   `lib/domain/basicCaseSlots.ts::stateCondition`, and is accepted when `stateCondition` states it back.
   (Section 3.3.)
5. **A case preload is the question's default value**, read only where moving the load from the end of
   the form's load to the question's place in data order changes nothing: no load-time value that
   follows the question in data order reads it. Any other preload is not-yet, basic and advanced
   alike: CommCare HQ builds the load as the app stores it and no setting of HQ's moves it, so
   nothing is the person's to fix. (Section 3.7.)
6. **An advanced menu's parent selection is read from its forms' loads**, since HQ's `AdvancedModule`
   stores no `parent_select`. The reader takes the chain every case-loading form of the menu agrees
   on, writes it as `Module.parentCaseModuleUuid`, and requires Nova's derived loads to equal HQ's.
   (Section 4.2.)
7. **A load that changes no case has no place to hold its tag**, so an advanced form whose such load
   carries a tag Nova would not derive is not-yet, under a new entry. (Section 4.3.)
8. **A Save to Case block is read only in the shape Nova's emitter writes.** The boundary is
   mechanical: the block's path matches `saveToCaseBlockShape` for the operation proposed from it, and
   re-emitting the form's case operations gives the same elements, binds and setvalues. Each value is
   read through the wrapper the emitter writes around it (the text trim, the date-and-time format, the
   presence guard, the capture address), never as the wrapped text. Every other block is not-yet under
   one new entry. (Section 5.)
9. **`publishedCaseBlocks` gains conditions, close conditions, links, owners, write modes and the
   session value each block's case id reads, and reports every form it cannot read with a reason.** A
   second reader, `hqEntryFacts`, lists every fact HQ's entry builder reads, per form and per menu.
   Acceptance (part 09) compares both between the HQ app and Nova's emission. (Section 6.)
10. **Datum id agreement is the equality of those entry facts**, because the reads hold no suite. HQ
    computes each form's session values from facts of the app's JSON; where the HQ app and Nova's
    emission agree on every one of them, HQ builds the same entry for both. The comparison runs once
    every structure is read, parent selection included, and before any expression is bound.
    (Section 6.3.)
11. **A property's type comes from its writers, as in every Nova app**, and the catalog declares a type
    only where no writer pins one and a reader needs it to write the same wire: a numeric sort, a date
    Search field, a select property's choices. (Section 7.)
12. **Menus are read in HQ's stored order, which is the order Nova writes.** A menu's kind is held
    (`Module.heldKind`) exactly where HQ holds an `AdvancedModule`. (Section 8.)
13. **The hidden registration menu Nova emits folds back into its host**, recognized by structure: one
    form, `module_filter` exactly `false()`, named by a host's `case_list_form.form_id`, the host's
    forms reading the search, the no-matches relevancy. Every other `case_list_form` reads by part 02's
    arm order. (Section 8.7.)
14. **`post_form_workflow` is stored only where it differs from the form's own default**
    (`lib/domain/postSubmit.ts::defaultPostSubmitOf`, which gives `lib/domain/forms.ts::defaultPostSubmit`
    the facts of the form's menu), so one meaning has one stored form. (Section 9.1.)
15. **Links read in reverse order; the otherwise is recognized in two shapes; held-case guards are
    stripped before a condition is bound.** Which conjuncts are guards is a fact of structure, so no
    candidate is tried. A link that carries a case by hand holds no guard in HQ and gains one at the
    first publish, which is declared. (Sections 9.2 to 9.4.)
16. **A case list column is read by its format into one of Nova's eight column kinds, and every other
    format is not-yet or refused by its manifest row.** `late-flag` becomes not-yet: Nova's interval
    column shows a header where HQ's late flag shows none. (Section 11.2.)
17. **Sort elements read through the inverse of `caseListOrderPlan`**, accepted when the plan of the
    proposed columns writes the same elements. A sort element no column joins becomes a hidden column,
    last. A rule over a date-and-time property reads by the same rows: part 03 fixes its order in
    the text a phone writes and adds no sort element (its section 7.1). (Section 11.4.)
18. **A search's workflow is read from three booleans by the inverse of `searchWireShape`.** A case
    list first whose search skips to its results is not-yet: Nova's list first always shows the search
    screen. (Section 12.1.)
19. **Each top-level conjunct of each `_xpath_query` row is one of six kinds, A to F.** Four are held
    on every searching menu: Nova's zero-input row (A), a clause of the case list filter restated
    (B), a simple Search field's derivation (C), and a condition that reads Search fields (D), which
    becomes an advanced field's condition or a list filter clause that waits for its fields,
    whichever Nova's emission writes back. The other two are a conjunct that reads no field and
    restates no list clause, and they divide by the menu. Where the menu's forms read the search, HQ
    applies the list filter to the results as well, so there the conjunct joins the list filter (F)
    and an unrestated list clause is held, each a declared change. On every other searching menu the
    two filters are independent, and a conjunct (E) or a list clause the other side lacks is
    not-yet. (Section 12.3.)
20. **A Search field HQ matches by its own exact rule stays as it is only where Nova writes the same
    bare prompt**: text, barcode and choice fields named for a property that is no attribute of the
    case node, and date ranges. A bare date prompt, and a bare prompt named `case_id`, `owner_id` or
    `status`, are not-yet. (Section 12.2.)
21. **Thirty manifest entries are added (twenty-four this part's, five part 02 named for these
    readers, one part 03 named) and fifteen rows or groups of rows re-cut**, each a class that
    splits a row the reader could not otherwise claim truthfully. A class this part can name has an
    entry; `unrecognized` is kept for what no rule here classified. (Sections 13.2 and 14.)
22. **Seven of the reader's choices between two documents that print one source are rows of part
    06's `assemble.ts::READER_CANONICAL_CHOICES`**, each `{ id, kind: "one-wire", apply }`:
    `create-name-required-is-absent`, `registration-form-last`, `default-post-submit-is-absent`,
    `dormant-tile-cells`, `case-catalog-is-as-read`, `unheld-placements-are-held` and
    `unsorted-hidden-tile-columns-are-off-the-list`. Part 09's `canonDocument` wraps them and proof 6
    calls that. (Sections 1, 3.2, 7, 8.7, 9.1, 11.5, 11.6.)
23. **A column the case detail shows and the list does not carry is read exactly.** A column gains
    a third list state, not on the list (`Column.notOnList`), which is no field of the short detail,
    is matched by no list filter and takes no order rule, with its gate rule, its builder switch
    and its tool input. No first-publish entry declares a change for it. (Sections 11.3 and 11.6.)
24. **A case list menu item with no label of its own is read as "Case List"**, the literal
    CommCare HQ's build writes for it in every language, so the reading is exact and no entry
    refuses it. (Section 8.6.)
25. **`update_mode: edit` is read as what the source project space's build does with it.** The read
    probes the project space's flag where the source holds the word. Where the build applies it, a
    follow-up or close form's own update reads `onlyIfChanged` and every other place is not-yet;
    where it does not, the word reads as saved every time everywhere. (Section 3.2.)

---

## Executed during planning

Read in full or by enclosing function, at the pins:

- **Nova, case writes**: `lib/commcare/casePlacementPlan.ts::planFormCaseWire`, `buildPlan`,
  `advancedPlan`, `formActionCondition`, `saveToCaseBlocks`; `lib/commcare/placement.ts` (header,
  `PlannedPlacement`, `InexpressibleHold`, `planAdvancedCore`, `placementExpresses`,
  `placementCandidates`); `lib/commcare/hqShells.ts` (every shell); `lib/commcare/advancedTags.ts`;
  `lib/commcare/advancedSelections.ts`; `lib/commcare/moduleKind.ts`;
  `lib/commcare/hq/publishedCaseBlocks.ts` (whole); `lib/commcare/xform/caseOps.ts::saveToCaseBlockShape`;
  `lib/domain/placements.ts` (whole); `lib/domain/forms.ts` (link, otherwise, case operation and form
  schemas); `lib/domain/basicCaseSlots.ts::stateCondition`, `conditionShape`, `ownSlotReasons`,
  `usercaseSlotReasons`, `subcaseReasons`, `sharingCloses`, `ownOrCreateBlockShape`;
  `lib/domain/advancedEntryDatums.ts::advancedLoadChain`, `chainLoadOfTarget`, `advancedLoadOf`;
  `lib/domain/advancedModule.ts::advancedChainIndex`, `advancedKindBlockers`;
  `lib/domain/casePreload.ts`; `lib/doc/explicitPreloads.ts`;
  `lib/domain/caseWriteViews.ts::caseWriteValueField`; `lib/domain/caseOperationIdentifiers.ts`.
- **Nova, menus and links**: `lib/commcare/expander.ts::expandDoc` (form and module shell assembly);
  `lib/commcare/formLinkProjection.ts::entryDatumIds`, `ProjectedAfterSubmit`, `ProjectedFormLink`;
  `lib/commcare/session.ts::toHqWorkflow`; `lib/domain/forms.ts::defaultPostSubmit`;
  `lib/commcare/CLAUDE.md` ("After-submit links (`form_links`)"); `lib/domain/modules.ts::moduleSchema`,
  `caseListMenuItemSchema`, `caseListRegistrationFormSchema`; `lib/domain/entryPoints.ts`;
  `lib/domain/forms.ts` (the Connect schemas).
- **Nova, lists and search**: `lib/commcare/hqJson/caseList.ts::projectColumnToDetail`,
  `projectColumnForShortDetail`, `projectSortElements`, `sortElementType`, `projectSearchInput`,
  `projectDefaultProperties`, `buildSearchConfigDocument`; `lib/domain/caseListOrder.ts` (the nine
  rules); `lib/commcare/suite/case-list/columns.ts::intervalAlwaysXpath`, `intervalFlagXpath`,
  `linkColumnDisplayXpath`; `lib/commcare/suite/case-search/searchWireShape.ts`,
  `xpathQuery.ts::composeXPathQueryClauses`, `composeXPathQueryEmission`, `xpathQueryRequestValues`,
  `simpleArmDerivation.ts` (whole), `searchPrompts.ts::searchInputSuppressesAutoMatch`;
  `lib/domain/modules.ts` (column, tile, case list, search field and search config schemas);
  `lib/domain/blueprint.ts::caseTypeSchema`; `lib/domain/effectiveCaseTypes.ts`;
  `lib/domain/fieldValueType.ts`.
- **The manifest**: every entry of `entries/forms-and-case-writes.json` (234),
  `entries/menus-and-case-lists.json` (268) and `entries/case-search.json` (127), by id, disposition and
  value class, and the Save to Case and Connect entries of `entries/questions.json`; the full cells of
  the ninety entries this part's tables cite.
- **HQ**: `models/form_actions.py` (whole); `xform.py::XForm._create_casexml`, `action_relevance`,
  `add_case_preloads`, `_add_usercase`, `_add_case_updates`, `XFormCaseBlock.add_case_updates`,
  `add_index_ref`, `autoset_owner_id_for_open_case`, `get_add_case_preloads_case_id_xpath`,
  `get_case_parent_id_xpath`; `models/case_search.py` (every class); `models/forms.py::FormLink`,
  `FormDatum`; `models/modules.py` (class list, `parent_select` placement); `util.py::module_offers_search`,
  `module_uses_inline_search`, `module_uses_include_all_related_cases`;
  `suite_xml/post_process/remote_requests.py::_remote_request_query_datums`, `_build_datum_nodeset`,
  `build_remote_request_queries`; `suite_xml/sections/entries.py::EntriesHelper.get_filter_xpath`,
  `get_datum_meta_module`, `entry_for_module`, `get_datum_meta_assertions_advanced` (its
  `get_manual_datum`);
  `suite_xml/sections/details.py::get_default_sort_elements`; `util.py::get_sort_and_sort_only_columns`;
  `detail_screen.py::LateFlag`, `TimeAgo`, `HideShortHeaderColumn`, `HideShortColumn`, `Invisible`;
  `helpers/validators.py::IndexedFormBaseValidator.check_case_properties`;
  `app_strings.py::_create_case_list_app_strings`; `views/forms.py::get_form_view_context` (the
  workflow labels); `templates/app_manager/partials/forms/case_config_ko_templates.html` (the template
  `case-config:case-transaction:case-preload`), `partials/forms/case_config.html` (the basic page's
  `case-config:case-transaction`, which does not draw it) and `partials/forms/case_config_advanced.html`
  (which does); `static/app_manager/js/forms/case_config_ui.js` (`HQFormActions.to_case_transaction`,
  `from_case_transaction`), `forms/advanced/actions.js` (the only `addPreload` and `removePreload`) and
  `forms/advanced/case_config_ui.js::addFormAction`; `static/app_manager/js/details/utils.js` (the
  format labels) and `details/bootstrap5/column.js` (the tile cell options);
  `corehq/apps/case_search/utils.py::CaseSearchQueryBuilder._apply_filter`, `_get_initial_search_es`;
  `corehq/apps/case_search/const.py::CASE_SEARCH_MAX_RESULTS`.
- **Nova, the emitter's wrappers and its caches**: `xform/caseOps.ts::buildCaseOperations` (the name,
  owner and write arms, `caseScalarTextValueCalculation`, `META_USER_ID`),
  `xform/datetimeCaseValue.ts::datetimeCaseValueExpression`; `placement.ts` (the shared close's `held`);
  `casePlacementPlan.ts::PlanFormCaseWireOptions`; `wireIdentity.ts::targetWireIdentity`;
  `validator/rules/caseOperations.ts::validateOnlyIfChanged`;
  `lib/domain/standardCaseProperties.ts::CASE_NODE_ATTRIBUTE_PROPERTIES`; the `WeakMap` caches of
  `casePlacementPlan.ts`, `placement.ts`, `basicCaseSlots.ts`, `advancedEntryDatums.ts` and
  `effectiveCaseTypes.ts`; `lib/domain/caseListOrder.ts` (rules 5 and 7).
- **What this part shares with other parts**: `xform/builder.ts::buildFieldParts` (the `required` it
  stamps on a question that names a created case) and
  `lib/domain/caseScalarTextGuard.ts::caseCreateNameFields`; HQ's
  `xform.py::XFormCaseBlock.add_create_block`; `lib/domain/postSubmit.ts::defaultPostSubmitOf`;
  `lib/domain/afterSubmit.ts::guardedLinkDatums`; `hq/publishedCaseBlocks.ts::PublishedForm` and
  `activeActions`; `xform/caseOps.ts::CaseOperationsEmission`; `hqShells.ts::caseSearchConfigShell`
  and HQ's `models/case_search.py::CaseSearch` (`title_label`, `description`,
  `get_search_title_label`); the manifest entries
  `questions/bind-required-true`, `questions/bind-required-expr`,
  `case-search/title-label-lang-non-empty`, `menus-and-case-lists/case-list-session-endpoint-id` and
  the eleven `lookup-*` and `callout-*` rows of `entries/menus-and-case-lists.json`; and the parts
  this one names, at the sections cited beside each use.
- **The research**: `docs/research/2026-09-26-hq-round-trip/README.md`, "Load-time values".

**Claims corrected.**

- *Claim corrected (outline item 10, "An advanced form's case selections";
  `forms-and-case-writes/advancedform`).*
  The outline has the reader test an advanced form's loads against "its module's parent-selection
  chain (`Module.parentCaseModuleUuid`)". HQ's `AdvancedModule` extends `ModuleBase` alone and declares
  no `parent_select` (`models/modules.py`: the property is on `Module` and `ShadowModule` only), and
  Nova's own advanced shell writes none (`hqShells.ts::advancedModuleShell`). So there is no stored
  chain to test against. The reader builds it from the loads (section 4.2).
- *Claim corrected (manifest, `menus-and-case-lists/6-late-flag-late-flag-1`).* The entry is HELD with the
  emission cell "`late-flag` + `late_flag`". Nova writes no `late-flag` column:
  `hqJson/caseList.ts::projectColumnToDetail` writes an interval column as a calculated
  `translatable-enum`, and `suite/case-list/columns.ts::intervalFlagXpath`'s own comment says its header
  "diverges from CCHQ". HQ's `LateFlag` extends `HideShortHeaderColumn`, which writes an empty header on
  the case list, at width 11%. A late flag read as an interval column would gain a header on its first
  publish. Section 11.2 re-cuts the entry.
- *A fact that keeps a basic child case a child (`models/form_actions.py::OpenSubCaseAction`, its
  `relationship`).* No first publish moves a stored `relationship: extension`, because no reading holds
  one. HQ's basic build never reads `OpenSubCaseAction.relationship`: `XForm._create_casexml` calls
  `add_index_ref(reference_id, form.get_case_type(), ...)` with the default `relationship='child'`. HQ's
  build never reads the stored value; its form export schema does
  (`corehq/apps/export/models/new.py::_add_export_items_from_subcase_action`). The manifest already
  refuses the value (`forms-and-case-writes/subcases-relationship-extension`), and the reader claims
  that row, so no reading turns a basic child case into an extension.
- *Claim corrected (manifest, `case-search/input-date`, cell "scalar `date`").* A date prompt HQ's own
  matcher compares is not a shape Nova writes. `simpleArmDerivation.ts::simpleArmNeedsXPathQueryEmission`
  returns true for every exact date field, so Nova's date field is always excluded from HQ's matcher and
  carries a whole-day clause. Section 12.2 splits the entry.
- *Claim bounded (outline item 8, "Several `_xpath_query` rows": "HQ ANDs every row", "so one row or
  several find the same cases"; part 01, section 3.5, words the entry's re-cut "read as one condition:
  their conjunction").* True of the cases a search finds, and of the list a worker sees only on one
  kind of menu. HQ builds a
  search's results in two ways. Where the menu's forms read the search
  (`util.py::module_uses_inline_search`), each form entry's case datum reads the results under the
  list filter (`entries.py::EntriesHelper.get_datum_meta_module`: `get_filter_xpath(detail_module)`
  over the search's instance, then the related-case exclusion), so the worker's list is the rows'
  conjunction with `Detail.filter`, and Nova writes the same nodeset
  (`session.ts::inlineSearchNodeset`). On every other searching menu the results datum's nodeset is
  the case type and the related-case exclusion and nothing more
  (`remote_requests.py::_build_datum_nodeset`), so `Detail.filter` narrows the device's own list
  alone. Nova holds one filter that narrows both
  (`xpathQuery.ts::composeXPathQueryClauses` restates every clause of `caseListConfig.filter`). So on a
  menu whose forms do not read the search, a row that restates no list clause and reads no Search
  field has no Nova slot, and a list clause no row restates would start narrowing the search. On a
  menu whose forms read it, both are held, each as a declared change. Section 12.3 writes the two
  cases out.
- *Claim corrected (`update_mode: edit`).* `ConditionalCaseUpdate.update_mode` changes HQ's build only
  under the toggle `SAVE_ONLY_EDITED_FORM_FIELDS` (`xform.py`: `self.save_only_if_edited`, read by
  `add_case_updates`). The field is alive and flag-gated, and the build applies it wherever it writes
  an update row: a follow-up's and a registration's `update_case`, `open_case.external_id`,
  `usercase_update`, a child case's properties, an advanced load's and an advanced open action's
  (`xform.py`, the six `save_only_if_edited=self.save_only_if_edited` calls). HQ's pages write it in
  all of those places (`forms/case_config_ui.js`, `forms/advanced/case_config_ui.js`, each through
  `save_only_if_edited`). Nova holds it in one of them: a write of a follow-up or close form's own
  case in the basic own slot (`validator/rules/caseOperations.ts::validateOnlyIfChanged`). So what
  the stored word means turns on the flag, which the read probes on the source project space
  (section 3.2; part 12, section 3.3, step 3). With it, the own update reads `onlyIfChanged` and
  every other place is not-yet under a new entry. Without it, the own update reads as saved every
  time and is respelled under `case-settings-respelled`, and every other place is the INERT entry
  `forms-and-case-writes/update-mode-edit-in-a-project-space-that-saves-every-time`. A create
  block never reads the mode of its name (`xform.py::XFormCaseBlock.add_create_block`), so
  `name_update.update_mode` is the same state at either value.
- *A manifest cell whose fact stands and whose standing is re-cut
  (`forms-and-case-writes/case-preload-into-a-question-outside-any-repeat-where-the-held`).*
  The entry is REFUSED with the cell "not HQ-editable: no editor writes basic `case_preload` (the basic
  Case Management page has no load section)". The fact stands at the pin. The basic page's transaction
  template (`templates/app_manager/partials/forms/case_config.html`, `case-config:case-transaction`)
  draws the case properties and the close condition and nothing else; the load template
  `case-config:case-transaction:case-preload` ("Load the following properties into the form
  questions", `partials/forms/case_config_ko_templates.html`) is drawn by
  `partials/forms/case_config_advanced.html` alone; and `addPreload` and `removePreload` exist only in
  `static/app_manager/js/forms/advanced/actions.js`. What the cell does not say is that a stored one
  stays and runs: the basic page's script maps a stored `case_preload` into its transaction and writes
  it back on every save (`forms/case_config_ui.js::HQFormActions.to_case_transaction`,
  `from_case_transaction`), `views/forms.py::edit_form_actions` saves the actions it is posted, and
  HQ's build writes each entry as a setvalue (`xform.py::XForm._create_casexml`,
  `add_case_preloads`). The form builder's case references are another thing:
  `case_references_data.load` is read for the case summary
  (`app_schemas/app_case_metadata.py::_add_load_references`) and by no step of the build. So an app
  can hold a basic preload that no page of HQ's adds, moves or removes, and that HQ builds and keeps.
  The standing the manifest derives from the cell, something to change in CommCare HQ because HQ
  will not save or build it, is false of such an app. Section 3.7 and section 14 re-cut the entry to
  HELD-NEW on that ground, and the new cell keeps the fact about the page.
- *A fact about today's reader (`lib/commcare/hq/publishedCaseBlocks.ts::readForm`).*
  `publishedCaseBlocks` leaves a form out without saying so: `readForm` returns `undefined` on
  `Unread`, and the file's header leaves the count to the caller. The extended reader returns the
  reason (section 6.1).

**Decided by reading.**

- *What HQ writes for a case list menu item with no label
  (`app_strings.py::_create_case_list_app_strings`).* For each language the build yields
  `clean_trans(module.case_list.label, langs) or "Case List"`, where `langs` is that language and
  then the build's languages (`app_strings.py`, `ccz_langs`: a build profile's languages where one
  is built, else the app's). An app that holds a build profile is not-yet (part 01,
  01-the-bar-and-the-manifest.md, section 3.7), so for every app that comes in they are the app's
  languages. The fallback is a plain literal, not passed through `gettext` (the registration
  label's fallback beside it, `_create_case_list_form_app_strings`, is). And
  `templatetags/xforms_extras.py::_trans` takes the first language of `langs` that is a key of the
  map with a value other than `None`, a blank string included, so a label blank in the build's
  language gives "Case List" there even where another language holds text. Where no language of
  `langs` is such a key and the map is not empty, it takes the value under the map's first key in
  sorted order and prints it as text (`sorted(name.items())[0]`, then `str(n)`): a label held
  only under languages the build does not name shows that value, and a `null` taken there prints
  as the text `None`. So the text a device shows is a function of the stored map and the build's
  languages alone, and the reader states it (8.6).
- *Where a hidden column reaches the wire (`lib/domain/caseListOrder.ts`, rules 1, 4 and 5;
  `lib/domain/modules.ts::tileCellFor`, `caseListColumnRuns`, `caseListColumnTextShows`).* The
  plan's `fields` is the one statement of the short detail, read by the HQ JSON projection, the
  local suite and Preview; a column hidden from Results is a field of it outside a tile list and
  no field in one, where its order rule rides as a carrier. Every reader that asks whether Results
  shows a column asks `visibleInList`. So a column that is no field of the list is one rule of the
  plan and one new slot (11.6).
- *Whether the gate admits a visible Search field no filter reads.* It does; 12.2 gives the rules
  and the two tests on `main` that hold it.
- *Where `update_mode` is read (`xform.py`).* `XForm` sets `self.save_only_if_edited` from
  `SAVE_ONLY_EDITED_FORM_FIELDS.enabled(domain, NAMESPACE_DOMAIN)` and passes it to every
  `add_case_updates` call; `XFormCaseBlock.add_case_updates` reads a row's mode only where it is
  true. Nova probes the same flag for a publish (`lib/commcare/projectSpaceCompatibility.ts`, the
  capability `save-only-edited-answers`). So one probe of the source project space decides what
  the stored word means (3.2).

---

## Written and not yet run

Nothing in this part was run. Three checks decide a fact no reading settles. Each names where it
runs, and each outcome ends in an edit the session makes.

**A form-builder save of Nova's Save to Case shapes.** It asks whether each block HQ's form builder
saved still passes the recognition of section 5. No retained read holds one today. The reads under
`proof/hq-reads/` whose forms hold a `vellum:role="SaveToCase"` element are
`targeted-migration-case-writes/app-source.json` and
`targeted-migration-extension-children/app-source.json`, and each is HQ's read of that app's export
from before its step 5 migration (`proof/README.md`, the migration witnesses): Nova's earlier
placements, read once, never saved in the form builder. The retained form-builder saves
(`proof/hq-reads/navigation-base/app-source-after-form-builder-save.json` and its siblings) hold no
block. So the check needs a new read: part 14's base `hq-nova-then-builder` (14-proof.md, section
6.2), built from the new corpus document `targeted-save-to-case-shapes`
(`proof/targeted/documents/saveToCaseShapes.ts`), which holds every arm `saveToCaseBlockShape`
returns today (a root create, a keyed create, a create in a repeat, a conditional update, a close,
a several-case form, the own arm in a block, the own close's block): the document's first publish,
then every form saved once in HQ's form builder. Where: ordinary CI, `saveToCase.retained.test.ts`
(`lib/commcare/reader/caseManagement/__tests__/`), which reads
`proof/hq-apps/hq-nova-then-builder/app-source.json` through `retainedBase`
(`__tests__/helpers/retainedHqApps.ts`, part 14, section 10). The two `targeted-migration-*` reads
are no input of this check: the same test file reads them only to hold that a block of a shape
Nova no longer writes is the new entry of 5.1 and never an operation, with no canonicalization.

| Outcome | What the session does |
|---|---|
| A: every block is recognized and its operations equal the corpus document's | nothing more; the test stays as the control |
| B: a block fails only by a spelling the builder changed (attribute order, a namespace prefix, whitespace in a bind's expression, a bind's position among binds) | `lib/commcare/reader/caseManagement/saveToCaseCompare.ts::blockTreesEqual` gains that one canonicalization, with the retained file as its case; no manifest change |
| C: a block fails by structure (the builder moved, added or dropped an element, a bind or a setvalue of Nova's shape) | the saved block is a Save to Case question at an authored position, which Nova holds no model for (5.1): it reads as `questions/savetocase-block-outside-nova-s-own-block-shape`; the shape is recorded under "Found while planning step 6" in `docs/research/2026-09-26-hq-round-trip/harness-findings.md`; the Save to Case forms leave `hq-nova-then-builder`, which keeps its form without one, and become the variant `hq-nova-then-builder/save-to-case-saved`, whose row of `proof/matrix/variants.json` names `questions/savetocase-block-outside-nova-s-own-block-shape` with its standing (part 14) |

**The same-state readings over HQ-authored bases.** It asks whether each reading the manifest holds
as "the same state", and that rewrites stored source on the first publish, builds the same files.
Where: the proof lane on hosted runners, inside the dispatch over the bases that the session starts
itself (the top-level file names it; part 14 holds the bases): proof 3 and proof 2 between HQ's
build of the base and HQ's build of Nova's publish over it.

| Reading | Entry (`forms-and-case-writes/` or `menus-and-case-lists/`) | Base that exhibits it (part 14, section 6.2) |
|---|---|---|
| `open_case.external_id` written back as `update_case.update.external_id` | `open-case-external-id-on-a-form-whose-open-case-is-active` | `hq-case-management` (its form with an external id on `open_case`) |
| `update_case.condition: if` written back `always` | `update-case-condition-if-whose-question-exists` | `hq-case-management` |
| `subcases[].reference_id: "parent"` written back `""` | `subcases-reference-id-null-parent` | `hq-case-management` |
| a `case_preload` written back as a default value | `case-preload-question-property-into-a-question-outside-any` | `hq-case-management` (a preload no later default reads) |
| `update_mode: edit` on a follow-up's own update in a project space without `SAVE_ONLY_EDITED_FORM_FIELDS`, written back `always` | `conditionalcaseupdate-update-mode-edit` | `hq-advanced` |
| a `case_list.label` with no text written back as "Case List" | `module-case-list-label-lang` | `hq-menus` |
| a sort element no column joins, written back as a stored hidden column | `field-naming-a-property-not-displayed-hq-appends-a-hidden-column` | `hq-case-lists` |
| `type: string` or `date` written back as Nova's derived word | `type-string-not-a-menu-value`, `type-plain-date-int-double-equal-to-the-type-nova-derives` | `hq-case-lists` |
| no sort elements over a short detail whose first column is hidden, written back as one explicit element on that column | `no-sort-elements` | `hq-case-lists` |
| `max_select_value: -1` written back `100` | `detail-max-select-value-on-a-multi-select-basic-list` | `hq-case-lists` |
| `blanks: ""` written back as the direction's own word | `blanks` | `hq-case-lists` |
| `_xpath_query` rows written back in Nova's order | `case-search/several-xpath-query-rows` | `hq-search` |

| Outcome | What the session does |
|---|---|
| A: no difference a spelling rule does not erase | nothing; each base stays as the control of its reading |
| B: a build file differs for one reading | the session reads which side is wrong first. Where Nova's emitter or this reader made the difference, it is corrected and the base runs again. Where HQ's build reads the two spellings differently, the reading is not the same state: the entry splits, its value as HQ authors it becoming HELD-NEW with the subject its row holds and the owner of section 14's table for that area, and the reader raises it. No register entry is written for a reading this table called the same state and a worker could meet |
| C: only the stored source differs (the build files are equal) | nothing more: the reading's row of section 13.3 is already an entry of part 09's `FIRST_PUBLISH_CHANGES`, which does not touch workers |

The three changes 13.3 declares as changes (`search-filter-joined-to-list` and the two that touch
workers) are not in this table: each moves a build file by design, and the lane holds each to its
entry of `proof/first-publish-changes.json` on the base that exhibits it (part 14).

**The entry facts over the corpus.** It asks whether the fact list of section 6.3 is complete for
every shape Nova emits: an id the port cannot produce from the facts depends on something the
facts lack. Where: ordinary CI, `lib/commcare/hq/__tests__/entryFacts.corpus.test.ts`. For every
form of every admitted corpus document `D` it asserts that
`entryFacts.ts::datumIdsFromFacts(facts, menus)` over `hqEntryFacts(expandDoc(D))` (a port of HQ's
id rules alone, reading nothing but the facts) deep-equals
`entrySessionDatums(D, ctx, moduleUuid, formUuid).map((datum) => datum.id)`, in order. It does not
show that HQ's entry builder reads nothing else for a shape Nova never emits, and it need not: a
key HQ reads only on a shape the reader refuses decides no reading.

| Outcome | What the session does |
|---|---|
| A: the two lists are equal for every corpus form | section 6.3 as written |
| B: an id depends on a key the fact list lacks | the key joins `HqEntryFacts` or `HqMenuFacts`, its key list and `datumIdsFromFacts`, with the corpus document as its case |

---

## 1. What Nova does today

**Nothing reads an HQ app into a document.** The only reader of HQ's stored case management is
`lib/commcare/hq/publishedCaseBlocks.ts::publishedCaseBlocks`, which has no production caller (its test
and two contract files name it). It returns, per form `xmlns`, the kind, path, case type and
property-to-question map of each block HQ's build writes, and the row paths of model-iteration repeats.
It reads no condition, close condition, index, owner or write mode, and it leaves a form out without
saying so when two forms share an `xmlns`, when the form is a shadow form, has a visit schedule, may
load a data registry's case, or its XForm does not parse (`readForm`, the `Unread` arm).

**The emitters this part inverts**, each a pure function of the document:

| What | Emitter | What it writes |
|---|---|---|
| A form's case actions | `casePlacementPlan.ts::planFormCaseWire` over `placement.ts::planPlacements` | basic `actions` (`open_case`, `update_case`, `close_case`, `subcases`, `usercase_update`; the three preload actions always empty, `hqShells.ts::emptyFormActions`) or advanced `actions` (`load_update_cases`, `open_cases`), plus the Save to Case blocks the form's source holds |
| A condition of a basic slot | `casePlacementPlan.ts::formActionCondition` over `basicCaseSlots.ts::stateCondition` | `{ type: "if", question, answer, operator }` for the three shapes Case Management states, `always` for none |
| A menu's kind | `moduleKind.ts::emittedModuleKind` | `Module` or `AdvancedModule`; advanced where `Module.heldKind` is set or a carried create needs it, and nothing blocks it |
| Advanced tags | `advancedTags.ts::allocateAdvancedTags` | a held tag verbatim, else `load_<type><n>`, `autoload_commcare_user<n>`, `open_<type>_<n>` |
| Menus | `expander.ts::expandDoc` with `hqShells.ts::moduleShell`, `advancedModuleShell` | `modules[]` in `projectedModulePreorder`, `root_module_id`, `parent_select` (basic only), `module_filter`, `case_list`, `case_list_form`, media maps, the two endpoint ids, `search_config` |
| The hidden registration menu | `emissionPlan.ts::emissionPlan` | one extra module per form a case list offers after an empty search, `module_filter: false()`, keyed `syntheticModuleUuid(formUuid)` |
| After submit | `formLinkProjection.ts::projectAfterSubmit`, printed by `expander.ts::toHqFormLink` | `post_form_workflow`, `post_form_workflow_fallback`, `form_links[]` reversed, each `xpath` its condition and then its held-case guards |
| Case list columns | `hqJson/caseList.ts::projectColumnToDetail`, `projectColumnForShortDetail` | one `DetailColumn` per column by kind, an `invisible` column for one hidden from the list |
| Order | `hqJson/caseList.ts::projectSortElements` over `caseListOrder.ts::caseListOrderPlan` | one `SortElement` per written rule |
| Search | `hqJson/caseList.ts::buildSearchConfigDocument` over `searchWireShape.ts::searchWireShape`, `searchPrompts.ts::searchPromptWire`, `xpathQuery.ts::composeXPathQueryEmission` | the three workflow booleans, `properties[]`, one `_xpath_query` row per clause, the title, the subtitle, the two expressions |

**What a document stores and the wire does not.** A form's type (`Form.type`); an operation's `uuid` and
`id`; a column's `uuid`; a menu's `id`. **What the wire stores and a document derives.** Every menu and
form id and `xmlns` (`wireIdentity.ts`); an advanced form's loads (`advancedLoadChain`); every session
value's id (`formLinkProjection.ts::entryDatumIds`); a property's type (`effectiveCaseTypes`);
`case_references_data` (`formActions.ts::buildCaseReferencesLoad`, `xform/caseSaveReferences.ts`).

**Held slots.** `CaseOperation.placement`, `Form.ownClosePlacement`, `Module.heldKind` and a query
repeat's `placement` are written by one mutation, `holdPlacements`, which no editor's payload carries.
This part reads the first three; a query repeat's placement is a fact of the form's own source and is
part 06's. A birth skips the kernel's placement authority check, and the genesis snapshot becomes
the recorded holds (`lib/db/appGenesis.ts`, `lib/db/placementAuthority.ts`), so the holds a reading
carries at birth are what a later editor may restore. Part 06's assembly builds the reader's
construction batch from the assembled document (`lib/doc/diffDocsToMutations.ts::diffDocsToMutations`
from `emptyBlueprintDoc(appId)`, its section 16.1: `ReadDraft.batch`), and that batch ends with one
trailing `holdPlacements` carrying every `placement`, `Form.ownClosePlacement` and `Module.heldKind`
this part read. The birth applies that batch and diffs nothing of its own, and its genesis snapshot
records the holds (part 12, 12-the-reading-and-the-birth.md, section 1, "A birth carries holds",
and section 6, "The `hq-adoption` birth").

So a reading of a Nova-born document holds placements that document did not: a document that
holds none and one that holds every placement its emission derives print one source. The reader
returns the one that holds them: a row of part 06's `assemble.ts::READER_CANONICAL_CHOICES` under
the id `unheld-placements-are-held`, `kind` `one-wire`. `apply` is `holdPlacements` over
`lib/commcare/placementHolds.ts::placementsToHold(doc)`, and it covers a query repeat's placement
too, which part 06 reads. `lib/commcare/__tests__/heldPlacementEmission.test.ts` already proves the
pair prints equal bytes: it prints every fuzz, advanced and fixture document with and without
`placementsToHold` applied.

---

## 2. Where these readers stand

### 2.1 Files and passes

The reader is `lib/commcare/reader/`, outside the `lib/commcare` barrel (part 06,
06-the-reader-forms.md, "Decisions in brief", 1, and section 2.4); its frame
(the cursors, the finding sink, the claim log, the walker and the form reader) is part 06's.
This part adds four directories:

| Directory | Modules |
|---|---|
| `lib/commcare/reader/caseManagement/` | `formType.ts`, `conditions.ts`, `basicActions.ts`, `preloads.ts`, `advancedActions.ts`, `saveToCase.ts`, `saveToCaseCompare.ts`, `catalog.ts`, `index.ts` |
| `lib/commcare/reader/menus/` | `modules.ts`, `navMedia.ts`, `registration.ts`, `afterSubmit.ts`, `entryPoints.ts`, `index.ts` |
| `lib/commcare/reader/caseList/` | `columns.ts`, `order.ts`, `tile.ts`, `details.ts`, `index.ts` |
| `lib/commcare/reader/search/` | `workflow.ts`, `prompts.ts`, `settings.ts`, `rows.ts`, `index.ts` |

`search/rows.ts` and `settleSearches` call part 08's `expressions/searchRows.ts` and `csqlRead.ts`,
so those two files of part 08 exist before them.

There is no `caseManagement/connect.ts`: Connect blocks are read by part 06 (10.2). The stage
functions are ten, one per pass in each `index.ts` and two more:

```ts
// lib/commcare/reader/caseManagement/index.ts
export function readCaseManagement(ctx: ReadContext, app: DraftApp): void;    // pass 1
export function settleCaseManagement(ctx: ReadContext, app: DraftApp): void;  // pass 2
export function compareEntryFacts(ctx: ReadContext, app: DraftApp): void;     // the end of step 4 (6.3)
// lib/commcare/reader/menus/index.ts
export function readMenus(ctx: ReadContext, app: DraftApp): void;
export function settleMenus(ctx: ReadContext, app: DraftApp): void;
// lib/commcare/reader/menus/afterSubmit.ts
export function registerLinkExpressions(ctx: ReadContext, app: DraftApp): void; // the end of step 4 (9.4)
// lib/commcare/reader/caseList/index.ts
export function readCaseLists(ctx: ReadContext, app: DraftApp): void;
export function settleCaseLists(ctx: ReadContext, app: DraftApp): void;
// lib/commcare/reader/search/index.ts
export function readSearches(ctx: ReadContext, app: DraftApp): void;
export function settleSearches(ctx: ReadContext, app: DraftApp): void;
```

`app` is `ctx.draft`, part 06's `DraftApp`, and a menu or a form below is its `DraftModule` or
`DraftForm` (`lib/commcare/reader/context.ts`, part 06 section 2.3).

Part 06's `reader/index.ts::STAGES` runs them at its stages 4, 5, 6 and 8 (its section 2.3), in the
order below. In brief the reader's order is structure, case management, menus, then expressions,
and two reads of this part run out of it (Departure 12): a menu's own keys (its case type, kind and
nesting) are structure every form needs, so `readMenus` runs first here, and the menu readings that
need every entry (registration, links, deep links, display conditions) are settled last:

1. part 06, stages 1 to 3: the application, each menu's and form's own keys and identity (the
   drafts), every form's source (fields, text, media references, generated candidates);
2. stage 4, `readMenus` (kinds, nesting, and each basic menu's parent selection, written here, inside
   `ctx.writeDraft` as every draft write is (2.2): forms need their menu's case type, kind and chain);
3. stage 5, `readCaseManagement` (operations, placements, conditions, the catalog's types and
   properties, an advanced menu's chain; it settles part 06's generated candidates, 3.2), and then
   part 06's stage 5b, `mintFields`;
4. stage 6, `readCaseLists`, `readSearches` (columns, order, tiles, prompts, workflow; every XPath
   registered), then two calls that need every entry's structure and nothing bound:
   `caseManagement/index.ts::compareEntryFacts` (6.3), and
   `menus/afterSubmit.ts::registerLinkExpressions` (9.4), which works out which conjuncts of a link
   are the emitter's guards and so registers the links' conditions and carried values last;
5. stage 7, part 06's `provisional.ts::provisionalDocument` and `provisional.ts::bindExpressions`,
   which calls part 08's `readExpressions` and binds every registered expression against the
   structure 1 to 4 built;
6. stage 8, `settleCaseManagement`, `settleCaseLists`, `settleSearches`, `settleMenus`, in that
   order;
7. part 06, stages 9 to 11: text, the form verdicts over bound trees, assembly. Then part 09's
   acceptance.

Below, "pass 1" and "pass 2" name a module's read function and its settle function; "step N" names a
line of this list.

Nothing a later step first writes is read by an earlier one. A menu's `parentCaseModuleUuid` is a
step 2 write, because three readers ahead of `settleMenus` need it: the catalog's parent types
(section 7), which `via` writes and `parent/` preloads read in step 3; an advanced chain's walk
through a basic menu (4.2); and the entry facts' `parentSelect`. `settleMenus` judges that slot and
removes it where it raises a finding (8.5). It runs last of the four settles because a link's
after-submit is projected over every menu's entry.

The entry facts are compared at the end of step 4, not inside `settleCaseManagement` and not after
the settles. Every key a fact reads is structure that steps 2 to 4 write (a menu's kind, case type,
nesting, parent selection and selection size; whether it offers a search, runs it inline and under
which instance; a form's requirement, loads, open actions, child cases and worker record), so by
then the draft is whole for them, and no placeholder of step 5 stands in a slot a fact reads. Part
08 needs the verdict before it binds: a `session/data/<id>` read is bound against `entryDatumIds`
only for a form whose entry facts agreed. `compareEntryFacts` lists the uuid of each form that
differed in `ctx.facts.entryFactsRefused` (`readonly Uuid[]`), and part 08 takes it as
`ExpressionReadEnv.entryFactsRefused` (`ReadonlySet<Uuid>`, built by part 06's `expressionEnvOf(ctx)`
; part 08, section 2.5). In a form of that set a `session/data/<id>` read Nova's projection does
not give raises no finding of part 08's: its registration's index is listed in
`ExpressionReading.ownerless`, and the frame claims its node under this part's finding at the form,
by the rule part 08's 2.5 writes for a registration with no owner. The frame cannot withdraw a
claim, which is why the comparison runs before the expression stage and never after it. The one
fact a bound tree can still move is a menu's kind, through the `case-list-menu-item-narrowed`
blocker, which reads whether the list has a filter or hidden owners, both slots that are absent
until bound; `settleCaseManagement` judges the blockers over the bound document (4.1).

A form part 06 refused before it minted anything (a form with no `xmlns`, or one that shares its
`xmlns`: part 06's 7.2, by part 10's rule "refuse before minting") has no draft. No function of this
part reads it, mints for it or raises a second finding at it; a link, a registration block or a deep
link that names it resolves to nothing the document holds (9.2).

### 2.2 What these modules read and write

The frame is part 06's (06-the-reader-forms.md, sections 2.3 and 4: `ReadContext`, the cursors,
`defineClaims`, `Accounting`, `PendingRegistry`). The sections below use a shorthand for it, and each
line here says what the shorthand is in the frame's own names:

- `ctx.claim(node, key, entryId)`: one claim of part 06's cursor on one key of a JSON node, or on one
  construct of an XForm, against one manifest entry. The verb is the one the entry's standing permits
  (part 06, 4.2): `take` or `derived` for a HELD entry, `drop` for an INERT one, `refuse` for a
  HELD-NEW or REFUSED one, `account` for an entry whose value never reaches the document. Each claim
  is declared once in its module's `defineClaims` and used by reference. `ctx.inert(node, keys,
  entryId)` is `drop` on several keys. `node.rest()` is the close (part 06, 4.4): every key no module
  claimed at a value other than HQ's schema default becomes `unrecognized`. A menu's and a form's
  `json` cursors are `DraftModule.json` and `DraftForm.json`; the keys part 06 claimed on them
  are no claim of this part (section 8.1).
- `ctx.finding(entryId, place, detail?)`: a finding for a class the reader finds by a rule over several
  keys. Where the class stands on a node, it is the cursor's `refuse` on the first of those keys,
  with the others claimed under the same entry, so one class is one finding. Where it is a relation
  between nodes each already claimed (a finding outside any one node), it is
  `ctx.accounting.finding(claim, place, detail?)`, which claims no node (part 06, 4.3).
  `ctx.unrecognized(place, name)` is `ctx.accounting.circumstance("unrecognized", place, { name })`,
  with `name` the surface key (part 01, 8.3).
- "pending": one XPath text registered with part 08 through `ctx.pending.register(expression, at)`
  (part 06's `PendingRegistry`, its 11.1), which returns the registration's index `i`. `expression`
  is part 08's `PendingExpression` (`lib/commcare/reader/pendingExpressions.ts`; part 08 section
  2.5): `ref`, the `SlotContextRef` (`lib/domain/expression/types.ts`) of the slot the expression will
  live in (a display condition, a link's condition and carried value, each case operation slot, the
  case list filter, a calculated column, each search slot); `text`, HQ's text as stored; `mode`;
  `place`; and `key`, the surface key the claim is logged under (`schema:Detail.filter`). `at` is the
  `ClaimSite` the text was read from, `{ json, key }` for a JSON key and an `XmlNode` for a bind.
  `mode` is `{ target: "hq-json", interpolation }` with the `HqInterpolation` of
  `lib/commcare/hqJson/xpath.ts` that key prints under (`none`, `case`, `no-case`, `no-dots`,
  `enum-key`: the word a table below gives as the slot's mode), `{ target: "xform", constraint: false }`
  for a Save to Case bind, or `{ target: "search-row" }` for an `_xpath_query` value. Where the
  slot's schema requires a tree (a calculated column, an advanced Search field's condition, a
  carried value, a case write's value) the module writes part 08's `pendingPlaceholder` into it, and
  it leaves an optional slot absent. After step 5 `ctx.pending.outcome(i).expression` holds the
  tree, or `.claim` the entry part 08 claimed and why; for a registration nothing
  bound, both are undefined. A settle function reads the outcome of the index it kept. A table in
  sections 3 to 12 that says "pending" means this registration.
- `syntaxOf(text, slot)` and `sameSyntax(a, b)`: the two syntactic reads this part makes of an XPath
  text without binding it. `syntaxOf` is `lib/commcare/reader/hqInterpolation.ts::syntaxOf` (part
  08's file, its section 6.1): HQ's text as a runtime reads it, interpolated for the
  slot and parsed. `slot` is the slot's `HqInterpolationSlot`, built by
  `hqInterpolationSlot(doc, ref, interpolation)` of the same file, or undefined for a slot HQ does
  not interpolate. `sameSyntax` is `lib/commcare/reader/syntaxCompare.ts::sameSyntax`.
  `dotInterpolate` (11.2) is `hqInterpolation.ts`'s too.
- `ctx.draft`: part 06's `DraftApp`. Read functions (pass 1) write the slots they have decided into
  `DraftModule.module` and `DraftForm.form`, and every such write, and every other write to a
  draft (`DraftForm.operationIdPaths`, 5.2), is made inside `ctx.writeDraft(() => { … })`, part
  06's one writer (its 2.3): it counts a draft revision, which is how `provisionalDocument` knows to
  build a new document, and part 06's `provisional.test.ts` fails a stage function that writes a
  draft outside it. A table below that says a key "reads into" a slot, or that a value is "written
  here", means a write inside that call. From step 5 the document is `ctx.doc`, the bound
  provisional document, and a settle function (pass 2) writes a slot only by assigning a new frozen
  document, `ctx.doc = withCandidate(ctx.doc, patch)`, never by mutating it (part 06, 2.3). Below,
  "the draft" names what the reading has decided so far, the drafts before step 5 and `ctx.doc`
  after, and "written into the draft" in a settle function means that assignment. No function calls
  a projection over the mutable drafts.
- "the document", `doc`, `draft` or `snapshot` in a call: the `BlueprintDoc` a projection or a gate
  rule is given. In steps 2 to 4 it is part 06's `provisional.ts::provisionalDocument(ctx)`: the
  document the drafts would assemble to as they stand, total over a draft that holds findings, with
  every registered slot at its placeholder (or absent). In a settle function it is `ctx.doc`, with
  every registered slot at its bound tree. Either is deeply frozen, and `provisionalDocument(ctx)`
  returns the same object until a draft is next written and a new one after. This is what a
  projection is given, because the projections memoize by the document object's identity:
  `casePlacementPlan.ts`'s `plans`, `placement.ts`'s `plans`, `formPlans`, `inexpressibleHolds` and
  `appPlans`, `basicCaseSlots.ts`'s `facts` and `slotPlans`, `advancedEntryDatums.ts`'s `chains` and
  `effectiveCaseTypes.ts`'s `MATERIALIZABLE_CASE_TYPES_CACHE` are each a `WeakMap` keyed by the
  document (`lib/commcare/CLAUDE.md`: "documents are replaced, never changed in place"). A second call
  over one object that had been written to in between would answer with the plan of the earlier state.
- `lib/commcare/reader/candidate.ts::withCandidate(doc, patch)` (new):

  ```ts
  /** `doc` with `patch` applied: a new frozen document, `doc` itself untouched. */
  export function withCandidate(
  	doc: BlueprintDoc,
  	patch: (draft: Draft<BlueprintDoc>) => void,
  ): BlueprintDoc;
  ```

  It is `immer`'s `produce`. A proposal is always judged over `withCandidate(doc, patch)`, `doc` the
  document of the line above and one new object for each candidate, and is written into the draft
  only once its projection passed. No candidate is ever tried by writing it into the draft and
  reading the draft back.
- `ctx.resolver`: part 10's `IdentityResolver` (`ctx.input.resolver`). Every entity this part mints goes
  through `externalKey.<kind>` and `ctx.resolver.claim` with the key parts of part 10
  (10-identity-and-the-ledger.md, section 2.2; the file is `reader/identity.ts`):
  `caseOperation` `[xmlns, place, action, n]`, `formLink` `[xmlns, target, n]`, `entryPoint` (three
  shapes), `caseListColumn` `[moduleUniqueId, columnKind, field, n]`, `searchInput` `[moduleUniqueId,
  name]`. A constructor takes its parts as arguments, one per part, in that order
  (`externalKey.searchInput(moduleUniqueId, name)`), never as one array. A menu's and a form's own UUID
  are minted by part 06's `readStructure` (`externalKey.module` and `externalKey.form`, its 7.2),
  and this part reads them from the drafts (`DraftModule.uuid`, `DraftForm.uuid`).
- `ctx.text(unitId, byLanguage)`: one translatable text handed to part 06's translation sink
  (`ctx.translations`, its 12.5): the first language's value into the slot that holds the source
  text, the others as translation entries.
- `menus/navMedia.ts::readNavMedia` (8.6) is the one reader of a `{lang: jr://...}` map in this
  part:

  ```ts
  /** The two media maps of one menu, list item, form or registration block, each read into the
   *  one asset it names. `slots` are the two `MediaRefLocation` kinds the maps stand in. */
  export function readNavMedia(
  	ctx: ReadContext,
  	node: JsonCursor,
  	slots: { readonly image: string; readonly audio: string },
  	place: HqPlace,
  ): { readonly icon?: string; readonly audioLabel?: string };
  ```

  It reads each map (`media_image`, `media_audio`) through part 06's
  `xform/media.ts::readMediaMap` (its 12.4), with the slot a
  `lib/domain/mediaRefs.ts::MediaRefLocation` kind: `asset` writes the asset id into the slot (and
  this reader makes its `take` claim on the key); `none` and `handed-off` leave the slot absent (the
  second listed in `ctx.facts.pendingMedia`, with no claim); `differs` raises the
  `...-differing-by-language` row. `readMediaMap` adds the `ReadMediaReference` to
  `ctx.facts.mediaReferences` itself. The kinds are `module_icon`, `module_audio_label`,
  `form_icon`, `form_audio_label`, `case_list_icon`, `case_list_audio_label`, `image_map_mapping`
  (11.2, read through `readMediaMap` directly), and part 02's `case_list_registration_icon` and
  `case_list_registration_audio_label` for the always-offered arm. Part 11 (11-project-data.md)
  turns those into its `HqMediaReference`s (`hqMediaReferencesOf`, its section 2.1: slots `tile`,
  `register-action`, `list-image`) and claims each pending reference (its `HqMediaPlan.inert` class
  or a finding). The asset id is the `asset` arm of the reader's media index, built by part 11's
  `readingMediaIndex` (its 14.2), which answers a path the map holds with the id the reading has
  reserved for that file before any byte is fetched (part 06, 17.4), so the document is the same
  before the files are fetched and after.
- `ctx.facts`: part 06's `MutableReadFacts`. This part adds two members to its `ReadFacts`
  (`lib/commcare/reader/types.ts`):

  ```ts
  /** Each same-state rewrite a comparison allowed (13.3): the entry claimed, the JSON Pointer of
   *  the stored value Nova writes back differently, and the first-publish register id it is under. */
  readonly sameStateRewrites: readonly {
  	readonly entry: string; readonly path: string; readonly register: string;
  }[];
  /** The uuid of each form whose entry facts differed (6.3), in menu and form order. */
  readonly entryFactsRefused: readonly Uuid[];
  ```

  Part 09 reads the first (13.3) and part 08 the second (2.1). This part keeps no machine reason
  beside a finding (which kind blocker, which of the four Save to Case tests): no log line of part
  12 carries one and an account carries no `ReadFacts`, so it would be a value with no reader
  (13.1).

### 2.3 The claim rule in these modules

Every table below has the columns **HQ key or construct**, **reads into**, **entry claimed** and, where
a value is not held, the entry that takes it. Three rules hold for all of them:

1. One use, one claim. Where two entries share a key, the reader decides the class by the rule its row
   states, first match in table order, and claims that entry alone.
2. A REFUSED or HELD-NEW class is tested before the HELD class of the same key.
3. An INERT claim reads the value and writes nothing. Its entry's `emission` says what Nova writes in
   its place; where that differs from the stored value the difference is a first-publish spelling
   (section 13.3).

### 2.4 Acceptance by re-emission

The reader has one recognition method for every lowering and generated pattern: parse, propose a
typed value, re-emit with the production emitter, compare trees (part 08,
08-the-reader-expressions.md, section 2, writes it for an expression). In these modules it takes
three forms, each named in the tables as **(R1)**, **(R2)**, **(R3)**:

- **(R1) Slot equality.** The reader builds the Nova value by rule, then calls the production function
  that states it back and requires the stored HQ value: `stateCondition` for a condition,
  `searchWireShape` for a workflow, `defaultPostSubmitOf` for a workflow word.
- **(R2) Projection equality.** In pass 2 the reader calls the HQ JSON projection over `ctx.doc`
  for one menu or one form (`casePlacementPlan.ts::planFormCaseWire`,
  `formLinkProjection.ts::projectAfterSubmit`, `hqJson/caseList.ts::projectCaseListForHq`) and compares
  its output key by key with the stored JSON, XPath values as syntax trees (part 08's `sameSyntax`),
  after dropping every key this part claimed INERT and applying the same-state rows it claimed.
- **(R3) Candidates in order.** Where one HQ value could be several Nova values (a date prompt over a
  date or a date-and-time property; an absent owner or the acting user; a value with or without the
  emitter's wrapper), the reader tries each candidate in a fixed order under (R2), each over its own
  `withCandidate(ctx.doc, patch)`, and keeps the first that passes. A test that lets the first
  candidate fail and the second pass over one draft holds this to separate objects (Tests,
  `candidates.test.ts`).

In the sections below, a projection or a gate rule said to run "over the draft" (`draft` in a call)
runs over the document of 2.2 (`provisionalDocument(ctx)` in steps 2 to 4, `ctx.doc` in a settle
function) or over a candidate of it, never over the mutable drafts.

**What every projection is given.** A projection prints derived ids, a blank capture address, identity
table names and content-hash media paths unless it is told otherwise, and the stored source holds the
HQ app's own. So every projection an (R2) or an (R3) calls, and every `expandDoc` and
`formLinkProjectionContext` call of this part, takes its options from one `ReadProjectionInputs`,
built once per reading (`lib/commcare/reader/projectionInputs.ts`, new):

```ts
export interface ReadProjectionInputs {
	/** The source's own ids over the derivation, for everything the reading minted. */
	readonly identity: WireIdentity;
	/** The project space the source was read from: a capture's link is written against it. */
	readonly attachmentTarget: AttachmentUrlTarget;
	/** Each bound table under the tag and field names the source reads it by. */
	readonly lookupNaming: LookupWireNaming;
	/** Each asset the media index resolved, at the path the source spells for it. */
	readonly assets: AssetManifest;
}
export function readProjectionInputs(ctx: ReadContext): ReadProjectionInputs;
```

- `identity` is `wireIdentity.ts::targetWireIdentity(overrides)`, the function a publish to an adopted
  deployment uses, over one override per menu the reading minted (`{ entityKind: "module",
  novaEntityUuid, uniqueId: <the source's unique_id> }`, a folded hidden menu under
  `syntheticModuleUuid(formUuid)`, 8.7) and one per form (`{ entityKind: "form", novaEntityUuid,
  uniqueId: HqAppSourceForm.readUniqueId, xmlns }`). A source read's form ids are that read's own
  (`hq/appSource.ts`: "a key into this read only"), and `form_links`, `case_list_form` and every other
  reference inside the same source name forms by them, so a projection printed under this identity
  prints the source's ids and equality is literal. Where a table below says "compared as menus" or
  "as forms", this is how.
- `attachmentTarget` is `ctx.input.target` (part 06: the origin and domain the source was read from).
  With none, `planFormCaseWire` withholds a basic slot's link write (`PlanFormCaseWireOptions`), and
  every capture link would differ.
- `lookupNaming` is `lookup/naming.ts::lookupWireNaming(ctx.input.lookup.definitions)`: the bound
  catalog, whose tags and field names are the source's. Without it a Search field's choices, a filter
  and a link condition that read a table print under identity names.
- `assets` maps each asset id of `ctx.facts.mediaReferences` to the path the source spells
  (`ReadMediaReference.path`), which is the path the adopted deployment's media-path rows give a
  publish (part 10, 10-identity-and-the-ledger.md, section 4). A media slot with a pending
  reference holds no asset, and its key is left out of the comparison: part 11 decides it.

Part 09's check 4 expands the document with the same four (section 6), so the two comparisons cannot
differ on an id, an address, a table name or a path.

**When a proposal fails.** Each row names the entry that takes the failure. Where no row names one, the
use is raised as the circumstance `unrecognized` at its place (`ctx.unrecognized`), with the surface
key of the first differing key in `detail.name` as part 01's 8.3 asks of that circumstance; the
read logs it at error (part 12, section 10: the line `[reading] unrecognized: <log key>`, its key
from `gather.ts::unrecognizedLogKey`): an app Nova's reader should have classified. This is the
frame's rule for an unclaimed item (part 06, section 4.4; part 01, section 8.3), applied to a
proposal the emitter did not write back. An accepted reading therefore never holds a slot whose
re-emission the reader did not see equal. Section 13.2 lists what remains under that rule, which is
only what no rule of this part classified.

The projections throw on a document the gate refuses (`planFormCaseWire`'s "reached emission with no
name" among them). A settle function calls a projection only after the checks of its own table passed
for that form or menu, and wraps the call: a throw is `unrecognized` for that form, with the
projection's name in `detail.name`, never an exception out of the reader.

---

## 3. Form types and basic form actions

`caseManagement/basicActions.ts::readBasicActions(ctx, module, form)` reads `form.actions` of a form
whose `doc_type` is `Form`. HQ's model is `models/form_actions.py::FormActions`; every field named below
is alive at the pin unless its row says otherwise. "Active" is HQ's
`models/forms.py::FormBase._get_active_actions`, which `publishedCaseBlocks.ts::activeActions` already
ports and this reader calls: a list is active when it holds an entry, a preload when it maps a question,
any other action when its condition is `if` or `always`, each only for the action types the form's
`requires` admits (`activeActionTypes`).

### 3.1 The form's type

`caseManagement/formType.ts`:

```ts
/** A class this reader refuses: the id of a claim its module declared (`defineClaims`). */
export type FindingEntry = { readonly kind: "finding"; readonly entry: string };
/** `active` is `publishedCaseBlocks.ts::activeActions(actions, requires)`. */
export function readFormType(
	requires: unknown,
	active: ReadonlySet<string>,
	module: DraftModule,
): FormType | FindingEntry;
```

Area `forms-and-case-writes`:

| `requires`, active actions | `Form.type` | Entry claimed |
|---|---|---|
| `none`, `open_case` active, `close_case` inactive | `registration` | `form-requires-none-open-case-active-close-case-inactive` |
| `none`, `open_case.condition.type: if` | `registration` with `openCondition` (3.3) | `form-requires-none-open-case-condition-if` |
| `none`, `open_case` and `close_case` active | `registration` with `closeCondition`: 3.3's expression for `if`, `matchAll()` for `always` | `form-requires-none-open-case-close-case-active` |
| `case`, `close_case` inactive | `followup` | `form-requires-case-no-close` |
| `case`, `close_case` active | `close`; `closeCondition` absent for `always`, else 3.3 | `form-requires-case-close-case` |
| `none`, no active open, update, close or child case (an active `usercase_update` or `usercase_preload` leaves the form a survey: the worker's record reads by 3.2 and 3.7) | `survey` | `form-requires-none-no-case-action` |
| `none`, `close_case` active, no open, menu has a case type | `survey` (HQ builds no case block) | `form-requires-none-with-close-case-active-and-no-open-in-a-module-with-a` |
| `none`, `update_case` active, no open | finding | `form-requires-none-with-update-case-active-and-no-open` |
| `none`, `subcases` non-empty, no open | finding | `form-requires-none-with-child-cases-but-no-open` |
| `none`, `close_case` active, no open, menu has no case type | finding | `form-requires-none-with-close-case-active-and-no-open-in-a-module-with-no` |
| `referral` or any other word | finding | `form-requires-referral` |

A registration that closes its case on every submission stores
`closeCondition: { kind: "match-all" }` (`expression/builders.ts::matchAll`), since an absent one means
"never" on a registration (`forms.ts::formSchema`), and `stateCondition` states `match-all` as no
condition, which `formActionCondition` writes `always`. A close form's `always` is the absent
`closeCondition`.

`open_case` active on a `requires: case` form is claimed
`open-case-active-on-a-requires-case-form` (INERT), and the three referral actions by their rows
(`open-referral-update-referral-or-close-referral-active-in-a-module-with-a` INERT,
`open-referral-update-referral-or-close-referral-active-in-a-module-with-no` REFUSED,
`referral-actions-inactive` INERT). `update_multi` and `name_update_multi` are
`update-multi-name-update-multi` (INERT). A non-empty `open_case.conflicts`, or
an `update_case.conflicts` entry holding a list, is
`a-non-empty-open-case-conflicts-list-or-an-update-case-conflicts`. Any key `FormActions`,
`OpenCaseAction` or `UpdateCaseAction` does not declare is `any-other-undeclared-key`.

### 3.2 The own case, its writes, and the worker's record

The own arm is the first operation of every registration, follow-up and close form of a menu with a case
type: `{ uuid, id, action: "own", name?, owner?, writes?, placement: { kind: "basic", slot: "own" } }`.
`id` is `caseOperationIdentifiers.ts::ownCaseOperationId(moduleCaseType, takenIds)`; `uuid` is minted
from `externalKey.caseOperation(xmlns, ["basic", "own"], "own", 0)`.

**A question path.** Every value of a basic action is the path of a question
(`ConditionalCaseUpdate.question_path`). `basicActions.ts::questionValue(form, path, property)` maps it
through the form's node graph (part 06's `ReadXForm`: `nodes` and `roles`, its 8.6). A node Nova's
emitter generates beside a question is a **candidate** there (`NodeRole` `generated-candidate`, of
purpose `url`, `datetime`, `trimmed` or `owner`): part 06 proposes it and this reader settles it, in
`readCaseManagement`, with `ReadXForm.settle(node, "generated")` where a case action names it in the
shape the emitter writes, and `settle(node, "field")` otherwise, which leaves the person's own Hidden
Value (part 06, 13.3). "A folded node" below is a candidate settled as generated:

| The path names | Value | Entry |
|---|---|---|
| a question of the form | `term(formField(uuid))` | the row's own |
| a folded node of purpose `trimmed`, on a case name or `external_id` write | the same read of its owner question (the trim is derived, `lib/domain/caseScalarTextGuard.ts`) | the row's own |
| a folded node of purpose `datetime` | the read of its owner, a date-and-time question | `update-from-a-date-and-time-question-through-a-hidden-sibling` |
| a Hidden Value whose calculate is the join of a date and a time question (part 06 reads it as an ordinary Hidden Value): the calculate is, by `syntaxCompare.ts::sameXPathText`, the join step 4's split writes over two questions of the form (`lib/doc/datetimeSplit.ts::planDatetimeSplit`) | the read of that field; the property is typed `datetime` (section 7) | `update-through-the-date-and-time-join-of-a-date-and-a-time` (HELD, section 14) |
| a folded node of purpose `url` | `{ kind: "term", term: { kind: "capture-link", field } }` | `capture-link-write-a-hidden-value-whose-calculate-builds-hq-s` |
| an `<upload>` question, bare | finding | `update-from-an-upload-question-attachment-mode` |
| a label, a question in a repeat the transaction does not take | finding | `a-case-write-name-or-preload-on-a-question-the-picker-does-not` |
| no node, in an active action | finding | `update-path-naming-no-question-in-the-form-in-an-active-action` |
| a date-and-time question, bare (no sibling) | finding | `a-datetime-question-saved-straight-to-a-case` |
| a string, not an object (`update: { p: "/data/q" }`) | finding | `update-case-update-value-as-a-bare-string-legacy-pre` |

**`open_case`** (read only where active):

| Key | Reads into | Entry |
|---|---|---|
| `name_update.question_path` | `own.name` | `open-case-name-update-question-path` |
| `name_update.update_mode`, `always` or `edit` | nothing: HQ's create block never reads it (`XFormCaseBlock.add_create_block`), and Nova writes `always` (13.3) | the same |
| `external_id` (a question path) on an active open | a write `{ property: "external_id", value }` on the own arm | `open-case-external-id-on-a-form-whose-open-case-is-active` |
| `external_id.update_mode: "edit"` on an active open | finding: the build applies it (`xform.py::_create_casexml`), and a new case has no earlier value for Nova's write to compare with | `update-mode-edit-off-a-follow-up-form-s-own-update` (new, section 14) |
| `external_id` where `open_case` is inactive | nothing | `open-case-external-id-on-any-other-form` (INERT) |
| `condition` | 3.3, into `Form.openCondition` | 3.3's rows |

**The question that names a created case.** For every question in the draft form's
`caseCreateNameFields` that is no Hidden Value, the draft question holds no `required` condition,
and the bind's own `required` value is claimed under the new INERT entry
`questions/bind-required-on-the-question-that-names-a-created-case` (section 14). The set is
`lib/domain/caseScalarTextGuard.ts::caseCreateNameFields`: the question a create's `name_update`
reads, for the form's own case (this table), a child case (3.4) and an advanced open action (4.4).
HQ's build writes `required="true()"` on that bind whatever the source holds
(`xform.py::XFormCaseBlock.add_create_block`), and so does Nova's emitter
(`xform/builder.ts::buildFieldParts`), so the source's own condition there reaches no build.
`readCaseManagement` runs before part 06's `mintFields` registers a field's logic (its 11.1), so it
makes the claim with the form's cursor (`drop` on the bind's `required`) and clears the `required`
part 06's stage 3 recorded on that draft field; nothing is registered for it, and part 08 claims
neither `questions/bind-required-true` nor `questions/bind-required-expr` there. Two documents print
that one source, one with a `required` condition on the question and one without, and the reader
returns the one without: a row of part 06's `assemble.ts::READER_CANONICAL_CHOICES` under the id
`create-name-required-is-absent`, with its `kind` `one-wire` and its `apply`. `apply`
removes a `required` condition from every question in `caseCreateNameFields` that is no Hidden
Value.

**`update_case`**:

| Key or value | Reads into | Entry |
|---|---|---|
| `condition: always` | nothing: Nova writes `always` on every form that opens or requires a case | `update-case-condition-always` |
| `condition: if` whose question exists | nothing, read as `always` (the build applies only activeness) | `update-case-condition-if-whose-question-exists` |
| `condition: if` whose question is gone | finding | `update-case-condition-if-whose-question-is-gone` |
| `condition: never` | by the four rows `update-case-condition-never-on-a-registration-form`, `update-case-condition-never-on-a-follow-up-with-any-other-entry`, `update-case-condition-never-on-a-follow-up-in-a-multi-select-or` (held: no writes are read from `update`) and `update-case-condition-never-on-a-follow-up-with-no-other-active` (finding) | those |
| `update[key]`, key with no `/` | a write `{ property: key, value }`; key `name` reads into `own.name` on a follow-up or close form and is `unrecognized` on a registration, whose name is `open_case`'s; key `owner_id` reads into `own.owner` | `update-case-update-property-question`, `update-key-name`, `update-key-owner-id` |
| `update[key]`, each index segment `parent` or `host`, on a form that loads its case | a write with `via`: one `RelationStep` per segment, `identifier` the segment, `throughCaseType` from the catalog's parent type of the step before (section 7) | `update-key-whose-index-segments-are-each-parent-or-host-parent-p` |
| the same on a form that opens its case | finding | `an-update-key-with-an-index-segment-on-a-form-that-opens-its` |
| a segment `user` among `parent`, `host`, `user` | finding | `update-key-whose-index-segments-include-user-each-parent-host-or` |
| any other segment | finding | `update-key-with-any-other-index-segment-or-user-where-the` |
| key `location_id` or `hq_user_id` | finding | `forms-and-case-writes/update-keys-location-id-hq-user-id` (part 04's N2) |
| key `category` or `state` | a write | `update-keys-location-id-hq-user-id-category-state` |
| key outside `AUTHORED_CASE_PROPERTY_NAME_PATTERN` (part 04) | by HQ's own rows, first match: `update-key-failing-hq-s-grammar-or-in-case-reserved-words-json`, `update-key-holding-a-character-validate-property-accepts-that-is`, then `forms-and-case-writes/update-key-holding-a-non-ascii-core-name-character` (part 04's N7) | those |
| `update[key].update_mode: "edit"` on a property write of a `requires: case` form | `onlyIfChanged: true` on the write where the source project space applies the mode, and no key where it does not (below) | `conditionalcaseupdate-update-mode-edit` (value class `follow-up-own-update`, section 14) |
| `update[key].update_mode: "edit"` on a registration form, or on the key `name` or `owner_id` of any form (Nova holds the name and the owner as facets with no mode) | finding | `update-mode-edit-off-a-follow-up-form-s-own-update` (new) |
| `update[key].update_mode: "always"` or absent | no key | the write's row |

`via` needs each ancestor's case type. Where the catalog gives the case type no parent type for a
segment (section 7: no child link and no parent selection of the app says what the index reaches, or
two say different types), the reader cannot name the case the write saves to, and the write is the
finding `forms-and-case-writes/index-path-through-a-case-type-the-app-does-not-fix` (new, section 14),
with the key in `detail.name`.

`update_mode: "edit"` means what the source project space's build does with it, and no more. HQ's
build reads the mode only under `SAVE_ONLY_EDITED_FORM_FIELDS` ("Claims corrected"), so the read
probes that flag on the source project space wherever the source holds the word
(`publishedCaseBlocks.ts::sourceHoldsEditMode`, 6.1). Part 05 makes the probe
(05-reading-commcare-hq.md, section 10.5, "The flag a bring-in reads":
`client.ts::readHqSaveOnlyEditedAnswers`), and part 12 places it in the read
(12-the-reading-and-the-birth.md, section 3.3). A probe that cannot answer stops the read, as
`not-a-member` or as the stop its failure gives, and is never a guess. The answer reaches the
reader as `ctx.input.saveOnlyEditedApplied` (a boolean on part 06's `ReaderInput`, absent where no
probe was needed):

- **Applied.** The mode is held in one place: a property write of a follow-up or close form's own
  case in the basic own slot, the only place the gate admits `onlyIfChanged`
  (`validator/rules/caseOperations.ts::validateOnlyIfChanged`: its reasons `new-case`, `target` and
  `placement` refuse the rest). HQ's build applies the mode in every other place it writes an
  update row, and HQ's pages write it there, so each is the class
  `update-mode-edit-off-a-follow-up-form-s-own-update`, tested before the write's own row (2.3,
  rule 2): a registration's `update_case` and `external_id`, the name and owner keys, a child
  case's `case_properties` (3.4), `usercase_update` (below), and an advanced load's or open
  action's `case_properties` (4.4). Every row of sections 3 and 4 that names that class is this
  case.
- **Not applied.** The build saves every answer every time, so the word says nothing. On the
  follow-up or close form's own update it claims its HELD row and reads as a write with no
  `onlyIfChanged`, a same-state rewrite recorded under `case-settings-respelled` (13.3). In every
  other place it claims
  `forms-and-case-writes/update-mode-edit-in-a-project-space-that-saves-every-time` (INERT, new,
  section 14) and no row of sections 3 and 4 raises a finding for it.

Either way Preview and the first publish do what the app's own build does. On a `name_update` of
a create (`open_case`, `subcases[]`, `open_cases[]`) the mode is read by no build under either
answer and claims the name's own row.

`update_case.update.name` on a registration form is the one shape of this table no entry names. HQ's
page never writes it: on a form that opens its case it stores the name as `open_case.name_update`
(`forms/case_config_ui.js`, `from_case_transaction`: `openCasePropertyNames`). It is raised
`unrecognized` (13.2).

**`close_case`**: its condition reads into `Form.closeCondition` by 3.1 and 3.3; the own close shares
the own arm's place, so `Form.ownClosePlacement` stays absent.

**`usercase_update`**:

| Value | Reads into | Entry |
|---|---|---|
| condition `always` or `if`, every key without `/`, at least one key | one operation `{ action: "update", caseType: "commcare-user", target: { kind: "worker-record" }, writes, placement: { kind: "basic", slot: "usercase" } }`, placed after the own arm and every child case | `usercase-update-with-condition-always-or-if-read-as-always-xform` |
| a key holding `/` | finding | `usercase-update-with-condition-always-or-if-a-key-containing` |
| a key whose `update_mode` is `"edit"`, under an active condition | finding: the build applies it (`xform.py::_add_usercase`) and Nova saves the worker's record every time | `update-mode-edit-off-a-follow-up-form-s-own-update` (new) |
| condition `never` | nothing | `usercase-update-with-condition-never` (INERT) |
| an empty `update` under an active condition | nothing: `XForm._add_usercase` writes no block | the first row, no operation |

Its `id` is `ownCaseOperationId("commcare-user", takenIds)`, which gives `commcare_user`.

### 3.3 Conditions

`caseManagement/conditions.ts`:

```ts
export type ReadCondition =
	| { readonly kind: "always" }
	| { readonly kind: "never" }
	| { readonly kind: "if"; readonly expression: Expression }
	| { readonly kind: "finding"; readonly entry: string };

/** The inverse of `basicCaseSlots.ts::stateCondition` for one `FormActionCondition`. */
export function readActionCondition(
	condition: unknown,
	scope: { readonly own: boolean; readonly repeat: Uuid | undefined },
	form: DraftForm,
): ReadCondition;
```

HQ's three operators are `action_relevance`'s three templates (`xform.py::XForm.action_relevance`):
`{path}`, `{path} = '{answer}'`, `selected({path}, '{answer}')`.

| `type`, `operator` | Expression |
|---|---|
| `always` | none (`kind: "always"`) |
| `never` | `kind: "never"` |
| `if`, `boolean_true` | `term(formField(q))` |
| `if`, `=` (also absent: the model's default) | `eq(term(formField(q)), V)` |
| `if`, `selected` | `{ kind: "multi-select-contains", property: term(formField(q)), quantifier: "any", values: [V] }` |

`V` is `term({ kind: "choice", field: q, options: [optionUuid] })` where `q` is a select with inline
choices and `answer` is one choice's value, and `term({ kind: "literal", value: answer })` otherwise.
These are the shapes `basicCaseSlots.ts::conditionShape` reads. Acceptance is (R1):
`stateCondition(caseSlotFacts(draft, formUuid), expression, scope)` must return a `stated` whose
question, answer and operator are the stored ones. Its refusal reasons choose the finding, area
`forms-and-case-writes`:

| `stateCondition` reason, or shape | Scope | Entry |
|---|---|---|
| the question names no node | any | `update-path-naming-no-question-in-the-form-in-an-active-action` |
| `condition-question-kind`, `condition-question-repeat`, `condition-quote-boundary`, `condition-not-a-choice` | the own case's open or close | `a-basic-form-s-own-case-s-close-or-open-condition-on-another` |
| `condition-question-kind`, `condition-question-repeat`, `condition-not-a-choice` | a child case or an advanced action | `a-subcase-or-advanced-action-condition-on-a-question-the-picker` |
| `condition-apostrophe` | any | `an-open-close-child-case-or-advanced-action-condition-with` |

The outline's item 10 has the reader "read the wider set and judge it" for a child case's condition on
another repeat's question. The judge is `stateCondition`'s `condition-question-repeat`: HQ's picker
offers the question, and its bind under this repeat would read several nodes, so it is the second row's
finding. `close_case` with `boolean_true` on a `requires: case` form claims
`close-case-condition-if-operator-boolean-true-on-a-requires-case`; `=` and `selected` claim
`close-case-condition-if-operator-or-selected-on-a-select-hidden`.

### 3.4 Child cases

`subcases[i]`, read in list order, each one operation after the own arm:

```ts
{ uuid, id, action: "create", caseType, target: { kind: "new" }, name, writes?, condition?,
  forEach?: { repeat }, links: [{ identifier: "parent", targetType: <the menu's case type>,
  target: <the own case>, relationship: "child" }], placement }
```

| Key | Reads into | Entry |
|---|---|---|
| `case_type`, one some menu of the app holds | `caseType` | `subcases-child-case-relationship-child-type-a-module-case-type` |
| `case_type` no menu holds | finding | `subcase-type-not-any-module-s-case-type-and-not-commcare-user` |
| `name_update.question_path` | `name` | `subcases-case-properties-name-update` |
| `case_properties[key]`, no `/` | writes, by 3.2's update rows | the same |
| `case_properties[key]` holding `/` | finding: HQ's build refuses it, `update_case word illegal` (`helpers/validators.py::IndexedFormBaseValidator.check_case_properties`, "no parent properties for subcase") | `update-key-failing-hq-s-grammar-or-in-case-reserved-words-json` (its keys gain `schema:OpenSubCaseAction.case_properties`, section 14) |
| `case_properties[key].update_mode: "edit"` | finding: the build applies it (`xform.py::_create_casexml`) and a new case has no earlier value | `update-mode-edit-off-a-follow-up-form-s-own-update` (new) |
| `repeat_context`, the name question's innermost repeat | `forEach: { repeat }` | `subcases-repeat-context` |
| any other `repeat_context` | finding | `subcases-repeat-context-other-than-the-name-question-s-innermost` |
| `relationship: "extension"` | finding | `subcases-relationship-extension` |
| `reference_id` in `""`, `null`, `"parent"` | the link's `identifier: "parent"` | `subcases-reference-id-null-parent` |
| any other `reference_id` | finding | `subcases-reference-id-any-other-value` |
| `condition` | 3.3 with scope `{ own: false, repeat }`; `never` is `subcases-condition-never` | `subcases-condition-if` |
| `close_condition` active | a second operation right after the create: `{ action: "close", caseType, target: { kind: "op", opUuid: <the create> }, condition?, forEach? }` with no `placement` of its own: it shares the create's, and the plan says so (`placement.ts::PlannedPlacement.sharesWith`, which names the create; 3.5 holds it there) | `subcases-close-condition-active` |
| `close_condition` `never` | nothing | `subcases-close-condition-never` (INERT) |

The link's `target` is `{ kind: "op", opUuid: <the own arm> }` in a registration and `{ kind: "session" }`
in a follow-up or close form (`basicCaseSlots.ts::targetsOwnCase`). HQ writes the index only where the
form has its own case block and, for a child of the menu's own type, the project space does not have
`DONT_INDEX_SAME_CASETYPE` on (`xform.py::_create_casexml`); the reader always reads the link, and a
publish asks step 5's `same-type-child-links` question for that project space as it does today
(`projectSpaceCompatibility.ts::sameTypeChildReasons`). Reading the flag is no part of a reading: part 05
keeps the flag probe out of it.

**The placement** is HQ's real position, by `publishedCaseBlocks.ts::basicBlocks`' own rule:
`{ kind: "basic", slot: "subcase", index: i }` where the child is outside a repeat or its repeat holds
more than one child case, and `{ kind: "basic", slot: "subcase-row" }` where it is its repeat's only one.
`i` is the position in `subcases`, so a child Nova would index differently still reads at HQ's node
`subcase_<i>`. `id` is `ownCaseOperationId(case_type, takenIds)` in list order.

A form in a menu that selects several cases, a form whose menu loads a data registry's case, and
`subcases` under them claim the rows `update-case-close-case-on-a-requires-case-form-that-does-not`
(INERT), `subcases-on-such-a-form-in-an-app-that-does-not-share-cases-or` (INERT) and
`subcases-on-such-a-form-in-an-app-that-shares-cases-where-a` (REFUSED), by `case_sharing` of the app.

### 3.5 Acceptance of a basic form

In `settleCaseManagement`, per form, (R2): `planFormCaseWire(draft, formUuid, { identity,
attachmentTarget })` (2.4's inputs) must give `kind: "basic"`, every planned placement must be where
the reader read it, and its `actions` must equal the stored ones after the list below.

**Where the reader read it** is one of two things, by what the plan gives the subject
(`placement.ts::planPlacements(draft, formUuid).placements`):

- An operation that carries a `placement` (the own arm, each child create, the worker's record, each
  Save to Case operation): `held: true`. The plan sets it only where the stored placement equals the
  one it plans (`samePlacement`).
- A close that shares a place and so stores none (a child case's close, 3.4; an advanced open
  action's, 4.4; the form's own close where `Form.ownClosePlacement` is absent, 3.2):
  `sharesWith` equal to the UUID of the operation the reader read it beside (the create, or the own
  arm), and `placement` equal to that operation's. The plan can never mark such a close `held`: it
  computes `held` from the close's own stored placement, which is absent by design
  (`placement.ts`, the `sharers` loop and the `"own-close"` arm, each `held: false` with
  `sharesWith`). A close the plan sends anywhere else (a `derivedPath` block of its own) fails this
  test, and the form is `unrecognized`: HQ holds the close in the action and Nova would move it.

The keys left out of, or mapped before, the comparison of `actions`:

- the INERT claims of 3.1 to 3.4 and 3.7 (the three preload maps, `load_from_form`, referral actions,
  `update_multi`, every `doc_type`);
- `update_case.condition`, which Nova writes `always` or `never` by its own rule;
- `open_case.external_id`, which Nova writes as `update_case.update.external_id`;
- `update_mode` on the `name_update` of `open_case` and of each `subcases[]` entry, which no build
  reads and Nova writes `always` (3.2);
- `subcases[].reference_id`, which Nova writes `""`;
- `update_mode: "edit"` on a write this part read as saved every time, in a project space that
  does not apply the mode (3.2), which Nova writes `always`;
- every `question_path`, compared after mapping both sides through the node graph to the owner question
  (so a path through `nova_trimmed_x` and one through `nova_trimmed_x_1` compare equal when both fold to
  one question).

`planPlacements(draft, formUuid).inexpressible` must be empty: a held placement that does not express
its operation would be refused by the gate (`HELD_PLACEMENT_INEXPRESSIBLE`), so it is raised here as
`unrecognized` with the operation's key, never left for the gate to find.

**The scalar check, held.** Nova conjoins a check onto the `constraint` of a visible question that
names a case or gives its external id (`lib/domain/caseScalarTextGuard.ts::caseScalarTextGuards`:
`reject` for a name, `allow` for an external id). Part 06 folds that check out of the constraint in
stage 3, before this part has settled the `trimmed` candidate beside the question, and records
which of the two it was on the draft field (`DraftField.scalarCheck`, its 13.2 and 8.6). The fold
is right only where Nova's emitter would write the same check back. So `settleCaseManagement`, for
every form it judges, basic or advanced, and every draft field of the form that holds a record,
requires both of:

- `caseScalarTextGuards(ctx.doc, formUuid).get(field.uuid)` equals the record;
- `caseScalarTextGuardIsChecked(field.kind)`.

Where either fails (the candidate was settled as the person's own Hidden Value, a case action
names the question for the other of the two values, or none names it), Nova would publish the
question without the check its source holds, or with the other one. The question is then
`unrecognized` at its place, `ctx.unrecognized(place, "xform:model/bind@constraint")`. Only Nova's
emitter writes the check, so a source that holds it where Nova's rule gives none was changed after
Nova wrote it (13.2).

### 3.6 The worker's record and case sharing in other keys

`#user/` reads in expressions are part 08's. `usercase_preload` is 3.7. A child case of type
`commcare-user`, or a subcase type the usercase row names, follows
`subcase-type-not-any-module-s-case-type-and-not-commcare-user`.

### 3.7 Preloads

HQ loads a case value into a question by appending an `xforms-ready` setvalue after every setvalue the
form's source holds (`xform.py::XForm.add_case_preloads`, called from `_create_casexml` and
`_add_usercase`): `preload` maps a question path to a property, `split_path` gives `parent/` steps, and
`name` and `owner_id` read `case_name` and `@owner_id`. Nova holds a preload as the question's default
value (`lib/domain/casePreload.ts::fieldPreload`): `default_value` exactly the `form-case` read of the
property. Nova writes defaults in data order (`xform/builder.ts::inDataTreeOrder`), so reading a preload
moves its setvalue from the end of the load to the question's place.

`caseManagement/preloads.ts`:

```ts
/** The questions whose load-time value changes when `field` is set earlier in the load. */
export function laterLoadReaders(doc: BlueprintDoc, formUuid: Uuid, field: Uuid): readonly Uuid[];
export function readPreloads(ctx: ReadContext, module: DraftModule, form: DraftForm): void; // pass 1
export function settlePreloads(ctx: ReadContext, form: DraftForm): void;                    // pass 2
```

`laterLoadReaders` computes, over the draft document: the set `S` that starts as `{ field }` and grows
by every field whose `calculate` or `relevant` reads a member of `S` and every field under a container
that is in `S` by its `relevant` (a read gives blank under a group that is not relevant), to a fixed
point, read with `lib/domain/expression/walk.ts::walkExpressionTerms`; then every field outside a repeat,
after `field` in the form's data order, whose `default_value` reads a member of `S`. A default inside a
repeat runs when its row is added, after the load, in both orders, so it is never one.

| Value | Reads into | Entry (`forms-and-case-writes/`) |
|---|---|---|
| `case_preload.preload[path] = prop`, question outside any repeat, menu selects one case, `laterLoadReaders` empty | `default_value: term({ kind: "form-case", caseType: <the menu's>, property })`; `name` reads `case_name`, `owner_id` reads `owner_id`; an authored default of the same question is dropped (HQ's setvalue ran after it and nothing read it between) | `case-preload-question-property-into-a-question-outside-any` |
| the same from `parent/prop`, `parent/parent/prop` | the same term with `caseType` the ancestor's type: the catalog's `parent_type` of the menu's type, once per `parent` step (section 7); a `form-case` term names its case by type (`expression/types.ts::formCasePropertyRefSchema`), and the emitter walks the indices (`xform/formCaseRead.ts::formCasePropertyRead`). Where the catalog gives no parent type at that depth, or two cases of the chain share one type (the term could not say which), the preload is the finding `index-path-through-a-case-type-the-app-does-not-fix` (new, section 14) | `case-preload-from-parent-paths-into-a-question-outside-any` |
| `laterLoadReaders` not empty | finding, `detail.name` the question's id | `case-preload-into-a-question-outside-any-repeat-where-the-held` (re-cut HELD-NEW, section 14) |
| from `host/`, `user/` or a mixed path | finding | `case-preload-from-any-other-index-path-host-user-a-mixed-path` |
| into a question inside a repeat | nothing (it fills no row) | `case-preload-into-a-question-inside-a-repeat` (INERT) |
| in a multi-select menu, by its two rows | finding, or the first row's reading | `case-preload-into-a-question-outside-any-repeat-in-a-multi-select-module`, `case-preload-into-a-question-outside-any-repeat-in-a-multi-select-child` |
| on a `requires: none` form | nothing, or finding for a reserved or illegal property | `case-preload-active-on-a-requires-none-form-naming-valid`, `case-preload-on-a-requires-none-form-naming-a-reserved-or` |
| `usercase_preload.preload[path] = prop`, outside any repeat, the form's active `usercase_update` writing a property, `laterLoadReaders` empty | `default_value`: the worker-record read part 08 builds for `#user/prop` | `usercase-preload-into-a-question-outside-any-repeat-on-a-form` |
| any other `usercase_preload` | finding | `any-other-usercase-preload` |
| `load_from_form` | by its three rows | `load-from-form-whose-paths-the-form-still-has` (INERT), `load-from-form-naming-a-path-the-form-no-longer-has-on-a-form` (REFUSED), `load-from-form-on-a-form-that-does-not-require-a-case` (INERT) |
| `case_preload.condition`, `usercase_preload.condition`, `load_from_form.condition` | nothing | `preload-action-condition` (INERT) |
| a preload on a question whose kind holds no default (`fieldKindDeclaresKey(kind, "default_value")` false), or on a Hidden Value with a calculation (Nova holds one value source on a Hidden Value, `HIDDEN_VALUE_BOTH_SOURCES`) | finding | `a-case-write-name-or-preload-on-a-question-the-picker-does-not` for a label; `case-preload-into-a-question-that-holds-no-default` (new, section 14) otherwise |

`readPreloads` records the candidates; `settlePreloads` runs `laterLoadReaders` once part 08 has bound
every expression, writes each default, and raises the finding. Preload order is not free: the
reader works out the HQ app's effective load-time order (part 06, section 11.3), and a
reordering of a setvalue that reads another node is refused or declared, never passed unseen (part
09, section 11.4, the row "Preload order"). This part decides it as refused, at not-yet, for a
basic and an advanced preload alike (4.4). The
manifest's row said `fix-in-hq` on the ground that no HQ page writes a basic preload. That fact
stands: the basic Case Management page draws no load section ("Claims corrected"). It is no ground
for the standing, though. HQ builds a stored basic preload and its page's save keeps it, so "CommCare
HQ will not save or build this" is false, and the page offers a person no control that moves the load
ahead of the value that reads it, or removes it. What is missing is Nova's: a preload held with its
place at the end of the load, which is step 7's group `forms-and-case-management`. So the person
reads "Nova can't hold this yet", never "Something to change in CommCare HQ".

A writer with no preload claims `a-writer-question-with-no-case-preload-update-only` and reads with no
default. The reader never adds one: `lib/doc/explicitPreloads.ts::planExplicitPreloads` is a cutover's
tool, and an HQ form with no load opens blank.

---

## 4. Advanced forms and the held menu kind

`caseManagement/advancedActions.ts::readAdvancedActions(ctx, module, form)` reads `form.actions` of a
form whose `doc_type` is `AdvancedForm` (`models/form_actions.py::AdvancedFormActions`:
`load_update_cases`, `open_cases`; all alive). Area `forms-and-case-writes` unless a row says otherwise.

### 4.1 The menu's kind

| HQ | Reads into | Entry |
|---|---|---|
| module `doc_type: "AdvancedModule"` | `Module.heldKind: "advanced"` | `menus-and-case-lists/advancedmodule`: claimed by part 06 (its 7.1 to 7.4); read here from `ctx.draft` (`DraftModule.docType`) |
| form `doc_type: "AdvancedForm"`, `form_type` | nothing stored: every form of a menu emitted advanced is one | `advancedform`, `form-type`: claimed by part 06 (its 7.1 to 7.4); read here from `ctx.draft` (`DraftForm.docType`) |
| `product_details` equal to HQ's default single `name` column | nothing | `menus-and-case-lists/advancedmodule-product-details-equal-to-the-default-single-name` (INERT) |
| `product_details` otherwise; `has_schedule` or `schedule_phases` | finding | `menus-and-case-lists/advancedmodule-product-details-differing-from-the-default`, `menus-and-case-lists/advancedmodule-has-schedule-true-or-schedule-phases-non-empty` |
| `auto_select_case: true` | finding | `menus-and-case-lists/auto-select-case-on-an-advanced-module` |
| `display_style` on the menu, which `AdvancedModule` does not declare | nothing | `menus-and-case-lists/display-style-on-an-advanced-or-shadow-module` (INERT): claimed by part 06 (its 7.3); nothing of it is read here |
| `multi_select`, `auto_select`, `max_select_value` on the menu's own case list | nothing | `menus-and-case-lists/multi-select-auto-select-or-max-select-value-on-an-advanced-or` (INERT) |
| `AdvancedForm.schedule` | by its three rows | `advancedform-schedule-with-enabled-false` (INERT), `advancedform-schedule-with-enabled-true-visits-transition`, `advancedform-schedule-with-enabled-false-on-an-advanced-form` |
| `arbitrary_datums` non-empty | finding | `arbitrary-datums-datum-id-datum-function` |

A held kind must still express the menu. In `settleCaseManagement`,
`lib/domain/advancedModule.ts::advancedKindBlockers(draft, moduleUuid)` must be empty for every menu read
with `heldKind`. A blocker (`forms-read-search`, `case-list-menu-item-narrowed`, `chain-index`; the
reader never reads a selection of several cases on an advanced menu, so `several-cases` cannot arise) is
the finding `menus-and-case-lists/advanced-module-nova-would-write-as-a-basic-one` (new, section 14),
one finding at the menu whichever blocker holds. Nova would write such a menu basic, which changes
every form's session values.

### 4.2 The chain test

HQ's advanced menu stores no parent selection ("Claims corrected"). Each form states its own selections
as loads, and Nova stores one chain per menu (`Module.parentCaseModuleUuid`, walked by
`advancedEntryDatums.ts::advancedLoadChain`). `advancedActions.ts::readLoadChain(module, forms)`:

1. For each form, take its **chosen loads**: the entries of `load_update_cases` whose `auto_select` is
   `null`, in order.
2. A chosen load is **well formed** when: its `case_tag` passes `advancedTags.ts::HQ_CASE_TAG_PATTERN`
   and holds no `/` (else `a-load-or-open-action-s-case-tag-containing-which-the-advanced`,
   `case-tag-blank-on-a-non-auto-select-action`, `case-tag-of-a-non-auto-select-action-failing-actions-js`)
   and holds no `-` (else 4.3's `case-tag-holding-a-hyphen`);
   the last one's `case_type` is the menu's and its `details_module` is blank or the menu's own id
   (else `forms-and-case-writes/advanced-form-loads-other-than-its-menu-s-one-chain`: the form's own
   selection is not its menu's list);
   every earlier one's `details_module` names a menu of the app whose case type is the load's (else
   `details-module-naming-another-module-of-a-different-case-type-or`); the first has no `case_index`
   (`case_index.tag` blank) and each later one's `case_index.tag` is the tag of the load before it with
   `relationship: "child"` (else `loadupdateaction-case-index-on-an-auto-selected-load-or-on-the`,
   `case-index-tag-naming-no-action`, `loadupdateaction-case-index-tag-naming-a-load-other-than-the-one`);
   `load_case_from_fixture` is `null` (else `load-case-from-fixture-loadcasefromfixture-all-fields`);
   `show_product_stock` is false and `product_program` blank (else
   `show-product-stock-true-or-a-non-empty-product-program`; the defaults claim
   `show-product-stock-false-and-product-program`, INERT).
3. A form's **chain** is the list of menus its chosen loads name, root first, ending at this menu. A form
   with no chosen load has none (a registration or a survey).
4. The menu's chain is the one chain every form that has one agrees on. The reader writes
   `Module.parentCaseModuleUuid` = the menu before this one in it (absent for a chain of one).
5. In `settleCaseManagement`, (R2): for every form, `planFormCaseWire(draft, formUuid).loads` must equal
   HQ's chosen loads in count, order, `caseType`, `listModule`, and index (`tag`, `identifier`), and then
   the worker's load where HQ holds one (4.4). `identifier` is Nova's derived name
   (`advancedModule.ts::advancedChainIndex`), so HQ's `case_index.reference_id` must be the one name the
   app's child links between the two types use, or `parent` where none does.

Where step 4 finds two chains, or step 5 differs for a reason other than a tag (4.3), the finding is
`forms-and-case-writes/advanced-form-loads-other-than-its-menu-s-one-chain` (new, section 14) at the
form, with the load's tag in `detail.name`. This is the outline's "a load beyond the chain, or a chain
that differs between the module's forms". A chain whose earlier menu is itself a basic menu with its own
`parent_select` must agree with it: step 5 walks `parentCaseModuleUuid` from this menu up, and a basic
menu's is already in the draft by then (`readModules` writes it in step 2, 8.5), so a disagreement shows
as a load count or a `listModule` that differs, and takes the same finding.

Claims: `load-update-cases-loadupdateaction`, `loadupdateaction-case-tag-without`,
`loadupdateaction-case-type`, `loadupdateaction-details-module`,
`loadupdateaction-case-index-tag-reference-id-relationship`.

### 4.3 Tags

A tag is an identity: HQ writes the action's block at `case_<tag>` and its session value at
`case_id_<tag>` (`models/form_actions.py::AdvancedAction.form_element_name`,
`LoadUpdateAction.case_session_var`). Nova holds a tag in the `{ kind: "advanced", tag }` placement of an
operation the action carries (`placement.ts::planAdvancedCore`, `attach`), and derives the tag of an
action that carries none (`advancedTags.ts::allocateAdvancedTags`).

- Every operation read from a load or an open action takes `placement: { kind: "advanced", tag }` with
  HQ's tag, and `row: true` for an open action written at its repeat row's own `case`
  (`publishedCaseBlocks.ts::advancedBlocks`' rule: its repeat holds fewer than two open actions with
  indices).
- A chosen load with no `case_properties` and an inactive `close_condition` carries no operation. Nova
  derives its tag: `load_<case type, each "-" as "_"><n>`, `n` from its position, stepping past taken
  tags and past any `case_<tag>` a root question holds. Where HQ's tag is not that tag (step 5 of 4.2
  finds only `tag` differing), the finding is
  `forms-and-case-writes/load-changing-no-case-with-a-tag-nova-does-not-derive` (new, section 14), with
  the tag in `detail.name`. HQ's own page names a new load after the menu's case type, whatever the
  load's (`advanced/case_config_ui.js::addFormAction`), so a parent load added there and never written
  to carries such a tag; holding it needs the stored selections of step 7's group
  `forms-and-case-management`.
- The same entry takes an auto-selected load of the worker's record that writes nothing: Nova derives
  the worker's load only where an update of the worker's record takes it, and dropping the load drops
  HQ's `usercase` assertion from the form's entry.
- A tag HQ's page accepts and `placements.ts::advancedTagSchema` does not is one holding `-`:
  `HQ_CASE_TAG_PATTERN` admits a hyphen after the first letter and Nova's tag is
  `XML_ELEMENT_NAME_PATTERN`, which admits none. It is the finding
  `forms-and-case-writes/case-tag-holding-a-hyphen` (new, section 14), with the tag in `detail.name`,
  tested before the tag's HELD row. This is no rare shape: HQ's page names a new action's tag from the
  menu's case type as typed (`advanced/case_config_ui.js::addFormAction`: `'load_' +
  caseConfig.caseType + index`, `'open_' + caseConfig.caseType + '_' + index`), so every advanced menu
  of a case type that holds a hyphen carries such tags. Part 04 leaves the tag grammar unchanged and
  hands the wider class to the part that reads it; holding it is step 7's
  (`forms-and-case-management`), because a tag is a submission path (`case_<tag>`) no rename can keep.

### 4.4 Loads and open actions as operations

**A chosen load**, position `i` of `n`:

| Key | Reads into | Entry |
|---|---|---|
| the last load's `case_properties` | the own arm's writes (3.2's update rows; `name` into `own.name`, `owner_id` into `own.owner`), placement the load's tag | `loadupdateaction-case-properties` |
| the last load's `close_condition`, active | `Form.type: "close"`, `closeCondition` by 3.3 with scope `{ own: false, repeat: undefined }` | `loadupdateaction-close-condition-on-the-form-s-own-selection` |
| an earlier load's `case_properties` | `{ action: "update", caseType, target: { kind: "expression", expr: term({ kind: "session-datum", datum: { kind: "selected-case", module: <its menu> } }) }, writes, placement }` | `loadupdateaction-case-properties` |
| an earlier load's `close_condition`, active | `{ action: "close", caseType, target: <the same>, condition?, placement }`, after that load's update | `loadupdateaction-close-condition-on-any-other-selection` |
| a `case_properties` or `preload` key holding `/` on a load with a `case_index` | finding | `loadupdateaction-preload-or-case-properties-property-with-on-a` |
| a `case_properties` entry whose `update_mode` is `"edit"`, on any load | finding: the build applies it (`xform.py::_add_case_updates`), and Nova holds the mode only in the basic own slot (3.2) | `update-mode-edit-off-a-follow-up-form-s-own-update` (new, section 14) |
| `preload[path] = prop`, question outside any repeat, `prop` without `/`, `laterLoadReaders` empty (3.7) | the question's `default_value`: the `form-case` read of `prop` with the load's case type | `loadupdateaction-preload-question-property` (re-cut HELD for this class, section 14) |
| any other `preload` | finding | `forms-and-case-writes/loadupdateaction-preload-read-later-in-the-load` (new, section 14) |
| a write or preload whose question is a label | finding | `an-advanced-load-s-update-or-preload-or-an-open-action-s-name-or` |

The form's type is `followup` where it has a chosen load and its own load does not close, `close` where
it does, and by 4.4's open actions otherwise.

**An auto-selected load** (`auto_select` not `null`):

| `mode` | Reads into | Entry |
|---|---|---|
| `usercase`, with `case_properties`, each a question's answer outside a repeat, no `close_condition`, `value_source` and `value_key` blank | `{ action: "update", caseType: "commcare-user", target: { kind: "worker-record" }, writes, placement: { kind: "advanced", tag } }`, last | `auto-select-mode-usercase`; `menus-and-case-lists/hq-computed-datums-case-id-new-type-n-usercase-id-datum-parent` for the datum |
| `usercase` with nothing written | finding | the new entry of 4.3 |
| `raw`, `user`, `fixture`, `case` | finding | `auto-select-mode-raw-value-key`, `auto-select-mode-user`, `auto-select-mode-fixture`, `auto-select-mode-case-index-of-an-earlier-load` |
| the three malformed shapes | finding | `auto-select-mode-case-naming-itself-a-later-load-or-an-open`, `auto-select-missing-its-key-in-case-fixture-user-or-raw-mode`, `an-auto-select-load-with-a-blank-mode-or-a-blank-case-type` |

**An open action** (`open_cases[j]`):

| Key | Reads into | Entry |
|---|---|---|
| the one open action outside any repeat, of the menu's case type, in a form with no chosen load | the own arm of a `registration`; `open_condition` into `Form.openCondition`, `close_condition` into `Form.closeCondition` | `open-cases-advancedopencaseaction-the-one-open-action-outside` |
| any other | `{ action: "create", caseType, target: { kind: "new" }, name, writes?, owner?, links?, condition?, forEach?, placement }` | `open-cases-advancedopencaseaction-any-other` |
| `name_update.question_path` | `name` | `advancedopencaseaction-name-update` |
| `case_properties[key]`, no `/` | a write; `owner_id` by the next row | `advancedopencaseaction-case-properties-keys-without` |
| `case_properties[key]` with `/` | finding | `advancedopencaseaction-case-properties-key-with-parent-p` |
| `case_properties[key].update_mode: "edit"` | finding: the build applies it (`xform.py::_create_casexml_advanced`) to a case that has no earlier value | `update-mode-edit-off-a-follow-up-form-s-own-update` (new) |
| `case_properties.owner_id` naming part 06's folded node of purpose `owner` | `owner: actingUser()` or `unowned()`, by the node's value (`generatedNodes.ts::advancedOwnerNodeValue`'s two) | the writes row |
| `case_properties.owner_id` naming a question | `owner: term(formField(q))` | the writes row |
| `repeat_context`, the name question's innermost repeat | `forEach` | `advancedopencaseaction-repeat-context-equal-to-the-name-question` |
| any other `repeat_context`; two open actions sharing a row block | finding | `advancedopencaseaction-repeat-context-other-than-the-name`, `two-or-more-open-actions-whose-repeat-context-is-one-repeat` |
| `open_condition` | 3.3 with scope `{ own: false, repeat }` | `advancedopencaseaction-open-condition` |
| `close_condition`, active | a close right after the create, sharing its place (as 3.4) | `advancedopencaseaction-close-condition` |
| `case_indices[k]` naming a chosen load | a link `{ identifier: reference_id, targetType: <the load's type>, target: { kind: "session" } for the own load, else the selected-case expression of 4.4's third row, relationship }` | `advancedopencaseaction-case-indices-child-extension-one-or-many` |
| `case_indices[k]` naming an earlier open action | the same with `target: { kind: "op", opUuid }` | the same; `an-advanced-open-action-indexed-to-an-open-action-that-has-a-equal` for the repeat case |
| `relationship: "question"`, an index to its own or a later action, to a renamed datum, outside its parent's repeat | finding | `caseindex-relationship-question-relationship-question-the-index-naming-a`, `caseindex-relationship-question-inside-a-repeat`, `caseindex-relationship-question-relationship-question-the-index-naming-an`, `caseindex-relationship-question-on-an-index-to-a-load-that`, `relationship-question-without-relationship-question`, `advancedopencaseaction-case-indices-naming-its-own-or-a-later`, `an-advanced-open-action-s-index-to-a-load-whose-datum-hq-renames`, `an-advanced-open-action-indexed-to-an-open-action-that-has-a-neither` |
| a case type no menu holds | finding | `open-case-type-not-any-module-s-case-type-and-not-commcare-user` |

A link's `reference_id` must pass `XML_ELEMENT_NAME_PATTERN`, the grammar of a link's identifier in Nova
(part 04, section 2.5, which hands the wider class to this part).
One that does not (a hyphen, a dot, a leading digit) is the finding
`forms-and-case-writes/index-identifier-outside-an-xml-element-name` (new, section 14), with the name
in `detail.name`: an index name is case data's own key, so Nova can neither rename it nor hold it yet.

A form with no chosen load and no own open action is a `survey`; its other open actions are creates.

**Acceptance** is 3.5's for the advanced arm: `planFormCaseWire` gives `kind: "advanced"`, every
planned placement is where the reader read it (3.5: `held: true` for an operation that carries a
placement, the create's or the own arm's `sharesWith` for a close that shares a place), `inexpressible`
is empty, and `actions` equals the stored ones after the INERT
claims and the `update_mode` of each open action's `name_update` (which no build reads, 3.2), with
question paths compared through the node graph and `details_module` compared as menus (2.4).
`planFormCaseWire`'s `generated` owner nodes must be the folded `owner` nodes part 06 read, one to one.

---

## 5. Save to Case blocks

A Save to Case block is in the form's stored XForm: an element carrying `vellum:role="SaveToCase"`
(`Vellum/src/saveToCase.js`). Part 06 hands each to this module as a `ReadSaveToCaseBlock`
(`ReadXForm.saveToCaseBlocks`, its 8.6 and 13.3): the element, its data path, the repeat it stands in
(or none), every bind and setvalue whose target is under it, and its wrappers, the `case-region`
nodes between its scope and itself, each with the `container` part 06 could tell (`operations`,
`condition`, `keyed`, `keyed-count`, `guard`, `selected-cases`, `selected-case`, `subcases`). Part 06
claims nothing in a case region: this module claims every block, container, condition group, guard
and keyed repeat it reads, and what it does not claim is `unrecognized` at the close.

### 5.1 The boundary

Nova writes a block only in the shape `xform/caseOps.ts::saveToCaseBlockShape` gives its subject: under
its scope (the form root, or its `forEach` repeat's row), a path of wrapper segments
`selected-cases`, `selected-case`, `operations`, `keyed`, `condition`, then `block`, in the combinations
that function and `basicCaseSlots.ts::ownOrCreateBlockShape` return. A held placement keeps the path's
element names verbatim (`placements.ts::saveToCasePlacementSchema`), so the names are free and the shape
is not.

`caseManagement/saveToCase.ts::readSaveToCaseBlocks(ctx, form)` reads a block as Nova's own exactly when
all four hold:

1. **Position.** Every ancestor of the block between its scope and itself is one of part 06's
   case-region nodes (`ReadSaveToCaseBlock.wrappers`, of container `operations`, `condition`,
   `keyed`, `selected-cases` or `selected-case`): none is an authored group, and the block is no
   child of the form root or of an authored group.
2. **Proposal.** The block's content gives one operation by 5.2, and that operation's
   `saveToCaseBlockShape` has as many segments as the block's path from its scope, segment by segment
   of the same purpose.
3. **Guards.** Every `nova_guard_*` block under the same `operations` container (a case-region node
   of container `guard`) is accounted for by an operation proposed in step 2 (a guard is derived: an
   update-only block with one row `update/case_type` whose `@case_id` is `if(OK, ID, '')`).
4. **Re-emission.** In `settleCaseManagement`, with the operation written into the draft carrying
   `placement: { kind: "save-to-case", repeat?, path }` (the path's element names as read),
   `xform/caseOps.ts::buildCaseOperations` over the draft writes, for this block and its wrappers, the
   same elements, attributes, binds and setvalues the stored form holds:

   ```ts
   // lib/commcare/reader/caseManagement/saveToCaseCompare.ts
   /** Whether the block the emitter writes at `stored.path` equals the stored one, with its
    *  wrappers: elements by name and order, attributes as sets, each bind by its nodeset with
    *  `calculate` and `relevant` as syntax trees (`sameXPathText`), each setvalue by event, ref
    *  and value tree. */
   export function blockTreesEqual(
   	stored: ReadSaveToCaseBlock,
   	emitted: CaseOperationsEmission, // xform/caseOps.ts, the form's whole emission
   ): boolean;
   ```

   The `vellum:` shadows are not compared, since part 06 already required each to agree with its
   real attribute (its 14.2).

A block that fails any of them is the finding
`questions/savetocase-block-outside-nova-s-own-block-shape` (new, section 14), at the question's place
(`{ kind: "question", path }`, the block's data path), the same finding whichever of the four tests
(`position`, `shape`, `guards`, `content`) failed. That is the plan's "a Save to Case question at an
authored position", which step 6 does not hold and step 7's group `xform` owns (the top-level file
`../6-bring-in.md`, "What changed from the outline, and why", item 10; `../7-rest-of-model.md`,
section 8), with the boundary stated: it is whatever the emitter does not write back, and position
is its first test because it is the one a person can see.
A block that fails by an entry the manifest already names (a `case_type` given as an XPath, an owner
condition, a close-only block with a close condition, a block that writes and closes, an authored
create id, `<attachment>`, a bind on the block's own node, a reserved case type) raises that entry
in its place; 5.2 lists them.

### 5.2 The proposal

Area `questions`. A pending expression goes to part 08 with the slot named, in the mode
`{ target: "xform", constraint: false }`.

**Each value is read through the wrapper the emitter writes around it.** `buildCaseOperations` never
writes an authored value bare into a fixed text column, a date-and-time property, a question's answer
saved to a loaded case, or a capture's link. Registering the stored text whole would bind the wrapper
as part of the value, and the emitter would then wrap it a second time, so (R2) could never pass for
a block Nova itself wrote. The reader takes each wrapper off syntactically in pass 1 (`syntaxOf(text,
undefined)`, since no form expression is interpolated, and `sameSyntax`, never the text; 2.2) and
registers what is inside, once. Test 4 of 5.1 then
decides by (R3), and no text is bound a second time: the first candidate holds the bound inside as
the value, and the second holds the same bound tree with the wrapper built around it again as
authored content (`lib/domain/expression/builders.ts`), for the rare author who wrote the emitter's
own shape by hand in a slot where the emitter adds none:

| Stored on | The emitter's wrapper (`xform/caseOps.ts::buildCaseOperations`) | Read as |
|---|---|---|
| `create/case_name`; `create/owner_id` and `update/owner_id`; `update/case_name` (a rename); `update/external_id` | `replace(V, P, '')` with `P` the literal of `caseScalarTextValueCalculation` (`CASE_SCALAR_BOUNDARY_CODE_UNIT_PATTERN`) | `V` |
| `update/<prop>` where the catalog types the property `datetime` after the operation's retype | `xform/datetimeCaseValue.ts::datetimeCaseValue` of `V`'s classification, leaf by leaf: the moment as CommCare HQ stores it (part 03, 03-questions-and-text.md, section 7.1) | `V`, where the row's tree is `datetimeCaseValue` of `V`'s classification: a typed leaf read through `xpath/wire/instant.ts::storedInstantSource`, a text leaf as itself, a literal in HQ's spelling as that literal, and a read of a `nova_instant_<operation id>_<n>` node as that node's leaf (below). The spelling Nova wrote before this step, `instant.ts::typedInstantValue(V)`, reads as `V` too, and records the rewrite (below) |
| the `relevant` of `update/<prop>` on an update whose target is the form's own case or the worker's record, where the value is one question's answer as it is | `count(A) > 0`, alone or as the first operand of an `and`, `A` the same path the row's value reads | no condition for the first, the rest of the `and` for the second; a `relevant` that does not lead with that conjunct is the authored condition whole |
| `update/<prop>` whose value is a capture's link | `if(C = '', '', concat('<origin>/a/<domain>/api/form_attachment/v1/', /data/meta/instanceID, '/', C))` over the capture `C` where the row reads it (`captureLinkAt`), with the origin and domain of 2.4's `attachmentTarget` | `{ kind: "term", term: { kind: "capture-link", field: C } }` |
| `create/owner_id`, `update/owner_id`, inside its `replace` | `/data/meta/userID` (`META_USER_ID`), which the emitter writes for an absent owner and for `actingUser()` alike | absent, then `actingUser()` (R3); `'-'` reads `unowned()` |

A wrapper present twice (an authored `replace` of the same pattern inside the emitter's) reads its
outer one off and keeps the inner as authored, and test 4 confirms it.

**A date and time, in both spellings.** Part 03 writes a date-and-time value as the text CommCare
HQ stores, leaf by leaf, and no longer as one wrapper around the whole value (its section 7.1, "The
reader's side"). So the reader takes the spelling off each leaf with the functions the emitter
builds it with, and (R2) holds the result: `datetimeCaseValue` of the proposed value's
classification is the stored tree. A leaf that reads the clock is stored once, in a Hidden Value
`nova_instant_<operation id>_<n>` of the operation's `nova_operations` group, whose calculate is
`typedInstantValue` of the leaf; the row reads that node, and the reader puts the node's leaf back
in its place, so the node is no question of the reading. A row whose whole calculate is
`typedInstantValue(V)` is the spelling Nova wrote before this step. It reads as the same write of
`V`, and the reader appends `{ entry, path, register: "date-and-time-saved-as-hq-stores-it" }` to
`ctx.facts.sameStateRewrites`, with the row's own entry and the form's attachment as the path:
part 09 names this reading as one of that id's two recording sites and says what the first publish
declares for it (09-acceptance-and-the-first-publish.md, section 11.2).

| Block content | Operation facet | Entry |
|---|---|---|
| `vellum:case_type`, a literal | `caseType` | `savetocase-create-case-type-literal-case-name-owner-id-uuid-case` |
| `vellum:case_type` holding an XPath | finding | `savetocase-case-type-given-as-an-xpath` |
| `create`, `@case_id` set by `uuid()` (an `xforms-ready` setvalue at the root, a bind in a repeat) | `action: "create"`, `target: { kind: "new" }` | the create row |
| `create` in a folded `keyed` one-row repeat whose id is the `nova-case-v1:` calculate | `target: { kind: "new", idFrom: <the question the key reads> }` | the create row |
| `create` with any other authored id | finding | `savetocase-create-with-an-authored-non-uuid-case-id-xpath-inside`, or `savetocase-create-at-the-form-root-whose-authored-case-id-xpath` where it is blank on every opening |
| `create/case_name` calculate | `name` (slot `case_operation_name`), inside its trim | the create row |
| `create/owner_id` calculate | `owner` (slot `case_operation_owner`), inside its trim: `/data/meta/userID` reads absent first and `actingUser()` second, `'-'` reads `unowned()`, anything else is the authored expression. `instance('commcaresession')/session/context/userid` is no owner the emitter writes in a block (it is the value of an advanced open action's folded `owner` node, 4.4), so in a block it binds as an authored session read | `savetocase-owner` |
| a `relevant` on `create/owner_id` | finding | `savetocase-owner-id-condition` |
| `update` only, `@case_id` a calculate | `action: "update"`; `target` by the table below | `savetocase-update-case-id-xpath` |
| `update/<prop>` calculate, with or without `relevant` | a write `{ property, value, condition? }` (slots `case_operation_write_value`, `case_operation_write_condition`), the value inside its date-and-time or capture wrapper and the condition after its presence conjunct (the table above); `case_name` into `rename`, `owner_id` into `owner`, `case_type` into `retype` where it is a literal | `savetocase-property-rows-calculation-condition-lifting-into`, `savetocase-property-names-with-hyphens-a-z-w-case-insensitive` |
| `close` only | `action: "close"` | by the wrapper: a folded `condition` group's `relevant` is the operation's condition |
| `close` with its own `relevant`, alone or beside a create or update | finding | `a-close-only-savetocase-block-with-a-close-condition`, `a-savetocase-block-that-creates-or-updates-and-also-closes-under` |
| `relevant` on `.../case` of a create | `condition` (slot `case_operation_condition`) | `savetocase-open-case-condition` |
| a folded `condition` group around an update or close | `condition` | `savetocase-inside-a-group-whose-display-condition-gates-it` |
| `index/<name>` with `case_type` and `relationship`, its calculate | a link `{ identifier: name, targetType, target, relationship }`; an empty index is `target: null` | `savetocase-link-index-name-child-extension-and-unlink-empty` |
| the block in a repeat | `forEach: { repeat }` | `savetocase-inside-a-repeat` |
| a relevance bound on the block's own node; a `constraint` or a `type` on a leaf; `<attachment>`; a create, close or link of `commcare-user` | finding | `relevance-bound-on-the-savetocase-node-itself`, `constraint-on-savetocase-case-leaves`, `type-on-a-savetocase-property-leaf-a-create-update-or-index`, `attachment-inside-a-savetocase-block`, `savetocase-create-close-or-link-of-commcare-user-or-type-user` |
| any expression the checker refuses in its slot | finding (part 08 raises it) | `savetocase-expressions-outside-nova-s-typed-vocabularies-case-id` |

**An update's or a close's target, and a link's**, from the tree part 08 binds, first match:

| The id expression is | Target |
|---|---|
| the session read of the form's own case (`ownCaseSessionRef`'s spelling) | `{ kind: "session" }` |
| the `@case_id` path of an earlier block of this form | `{ kind: "op", opUuid: <that block's operation> }` |
| the worker's record selector (`usercaseWire.ts::USERCASE_CASE_SELECTOR`), on an update of `commcare-user` | `{ kind: "worker-record" }` |
| anything else | `{ kind: "expression", expr }` (slot `case_operation_target_expression`, or `case_operation_link_target_expression`) |

**The own arm in a block.** A registration, follow-up or close form whose own case does not take the
basic slot holds it in a block of shape `operations`, `block` (or the several-case shape). The reader
cannot tell that block from a create's by its content, so it is (R3): where the form's type by 3.1 has
an own arm and no basic own block (`publishedCaseBlocks` gives no `basic-own`), the first block in the
root `operations` container whose case type is the menu's is proposed as the own arm
(`placement: { kind: "save-to-case", path }`), and as a create second. `Form.ownClosePlacement` is read
from a close-only block in a folded `condition` group under the root `operations` container whose
target is the own case, where the form's type has an own close and the own arm sits elsewhere.

**Operation order.** A form's operations are the own arm, then the basic child cases or advanced
actions in HQ's list order, then the worker's record, then the Save to Case operations in document
order of their blocks, except that (R2) is run with the Save to Case operations interleaved at the
positions `buildCaseOperations` needs: a close or update that names an earlier create follows it. The
order the emitter accepts first, trying document order and then "each block's operation directly after
the operation its target names", is the order stored.

A link's name (`index/<name>`) outside `caseOperationIdentifiers.ts::CASE_OPERATION_IDENTIFIER_REGEX`
is the finding `questions/savetocase-link-name-outside-nova-s-identifier-grammar` (new, section 14),
with the name in `detail.name`: part 04 leaves that grammar unchanged and hands the wider class here,
and an index name is a key of case data, which no rename keeps.

**The ids part 08 binds a block's reads against.** One block reads another's case id by a path
(`current()/.../@case_id`), and part 08 binds such a path to an `id-of { opUuid }` leaf only if it knows
which operation each create block is. `readSaveToCaseBlocks` gives it that: for each create block it read
into an operation, the block's `@case_id` path, absolute from the data root, to the operation's UUID.
`readCaseManagement` collects them per form as part 08's `ExpressionReadEnv.operationIdPaths`
(`ReadonlyMap<Uuid, ReadonlyMap<string, Uuid>>`, its section 2.5): it sets each form's map on its draft,
`DraftForm.operationIdPaths` (part 06's member, its 2.3), inside `ctx.writeDraft`, and part
06's `expressionEnvOf(ctx)` passes them through, keyed by the form's UUID, to `readExpressions`
(part 06, 17.2). A block that is 5.1's finding gives no path, so a read of its id binds to nothing and is
part 08's own finding at the reading block.

An operation's `id` is the block's element name where it passes
`caseOperationIdentifiers.ts::isCaseOperationIdentifier` and is free among the form's ids, and
`ownCaseOperationId(caseType, takenIds)` otherwise. Its key is
`externalKey.caseOperation(xmlns, ["save-to-case", repeatPath, path], action, n)`.

### 5.3 `case_references_data`

| Key | Reads into | Entry (`forms-and-case-writes/`) |
|---|---|---|
| `load` | nothing: derived (`formActions.ts::buildCaseReferencesLoad`) | `case-references-data-load` (INERT): claimed by part 06 (its 7.4 and 8.7); no claim is made on it here |
| `save`, equal to what `xform/caseSaveReferences.ts::caseSaveReferencesOf` gives for the form's read source | nothing: derived | `case-references-data-save-equal-to-vellum-s-computation-from-the` |
| `save` otherwise | finding | `case-references-data-save-differing-from-that-computation` |

The `save` comparison runs in `settleCaseManagement`, after every block is read. A form whose block is
5.1's finding raises that finding alone for the form: its `save` map is not judged.

**The computation over a read source.** `caseSaveReferences(root)` takes the `<h:html>` tree Nova's
emitter built. It finds `h:head` and `model` by their prefixed names, takes the primary instance as
the `instance` with no `src`, and throws where the tree is not the emitter's: no model, no primary
instance, a bind with no `nodeset`, a `nodeset` `FormPath.parse` refuses. A source read from
CommCare HQ may be any of those and be a sound form (part 06, 8.3: a bind may hold `ref` for
`nodeset`, and a relative path). So the file is split:

```ts
// lib/commcare/xform/caseSaveReferences.ts
/** One form's `save` map, from its model and its data root. Total: no input makes it throw. */
export function caseSaveReferencesOf(
	model: Element, dataRoot: Element,
): Record<string, HqCaseSaveReference>;
```

It holds today's computation: one reference per `vellum:role="SaveToCase"` element under
`dataRoot`, keyed by the element's absolute data path, its properties the bound `create/` and
`update/` leaves of `model`'s binds in bind order. Three rules make it total:

- a node's data path is `/`, the data root's own name, and each element name down to the node,
  joined as text. No `FormPath` is built, so a name outside Nova's grammar throws nothing;
- a bind's path is its `nodeset`, or its `ref` where it has none, and a path that does not start
  with `/` is taken from the data root, as `Vellum/src/parser.js::parseBindList` and `processPath`
  read one;
- a bind with neither attribute lists no leaf, and so does one whose path, split into steps at `/`
  as `FormPath.parse` splits one, is not a block's path followed by `case`, then `create` or
  `update`, then one leaf.

`caseSaveReferences(root)` stays as the emitter's wrapper: it finds the model and the primary
instance as today, keeps today's throws, each a fault of the emitter, and returns
`caseSaveReferencesOf(model, data)`. Over a tree the emitter built the two give one map, which
`lib/commcare/__tests__/caseSaveReferences.test.ts` and `hqJsonOracle.ts::checkCaseReferences` hold
unchanged. `settleCaseManagement` calls `caseSaveReferencesOf(parsed.model, parsed.dataRoot)` with
part 06's `ParsedXForm` (`DraftForm.xform.parsed`, its 8.2 and 8.7), which found both by namespace.

---

## 6. Placements and session values compared

Acceptance check 4 (part 09, 09-acceptance-and-the-first-publish.md, section 6) compares the HQ
app's source with Nova's emission of the document. This part gives it two readers over an app
source, each a pure function of JSON that works alike on what HQ served and on `expandDoc(D)`'s
output.

### 6.1 `publishedCaseBlocks`, extended

`lib/commcare/hq/publishedCaseBlocks.ts`, extended:

```ts
/** A condition as Case Management states it, the question's path relative to the data root. */
export type PublishedCondition =
	| { readonly type: "always" }
	| { readonly type: "never" }
	| { readonly type: "if"; readonly question: string; readonly answer: string | null;
	    readonly operator: "=" | "selected" | "boolean_true" };

export interface PublishedIndex {
	readonly identifier: string;
	/** `own` for a basic child's index to the form's own case; a tag for an advanced one. */
	readonly target: { readonly kind: "own" } | { readonly kind: "tag"; readonly tag: string };
	readonly relationship: "child" | "extension" | "question";
}

export type PublishedCaseBlock =
	| { readonly kind: "basic-own"; readonly path: "case"; readonly caseType: string;
	    readonly opens: boolean; readonly closes: boolean;
	    readonly condition: PublishedCondition;        // open_case's; `always` where it does not open
	    readonly closeCondition: PublishedCondition;   // close_case's; `never` where inactive
	    /** `session/data/<id>` the block's case id reads: `case_id`, or `case_id_new_<type>_0`. */
	    readonly sessionDatum: string | null;
	    readonly ownerWritten: boolean;                // `owner_id` among the update keys
	    readonly properties: ReadonlyMap<string, string>;
	    readonly editOnly: ReadonlySet<string> }       // keys whose update_mode is `edit`
	| { readonly kind: "basic-usercase"; readonly path: "commcare_usercase";
	    readonly properties: ReadonlyMap<string, string>; readonly editOnly: ReadonlySet<string> }
	| { readonly kind: "basic-subcase"; readonly index: number; readonly path: string;
	    readonly repeatContext: string | null; readonly caseType: string;
	    readonly condition: PublishedCondition; readonly closeCondition: PublishedCondition;
	    readonly indices: readonly PublishedIndex[];   // one `parent` child index, or none
	    readonly ownerWritten: boolean;
	    readonly properties: ReadonlyMap<string, string>; readonly editOnly: ReadonlySet<string> }
	| { readonly kind: "advanced"; readonly action: "load" | "open"; readonly tag: string;
	    readonly path: string; readonly caseType: string;
	    readonly condition: PublishedCondition;        // an open action's open_condition; `always` on a load
	    readonly closeCondition: PublishedCondition;
	    readonly indices: readonly PublishedIndex[];
	    readonly ownerWritten: boolean;
	    readonly properties: ReadonlyMap<string, string>; readonly editOnly: ReadonlySet<string> }
	| { readonly kind: "save-to-case"; readonly path: string; readonly caseType: string | null;
	    /** `create`, `update`, `close`, in that order, each present where the block holds the child. */
	    readonly actions: readonly ("create" | "update" | "close")[];
	    readonly indices: readonly { readonly identifier: string; readonly relationship: string | null }[];
	    /** The block's property leaves, sorted. */
	    readonly properties: readonly string[] };

export type UnreadFormReason =
	| "no-xmlns" | "shared-xmlns" | "shadow-form" | "unknown-form-kind" | "no-xform"
	| "xform-unparsed" | "actions-malformed" | "visit-schedule" | "registry-load";

export interface PublishedCaseBlocks {
	readonly forms: ReadonlyMap<string, PublishedForm>;
	/** Every form left out, by position, with why. */
	readonly unread: readonly { readonly menu: number; readonly form: number;
	    readonly xmlns: string | null; readonly reason: UnreadFormReason }[];
}
export function publishedCaseBlocks(normalizedSource: unknown): PublishedCaseBlocks;
```

- The return type changes from a map to `PublishedCaseBlocks`. Its one test
  (`lib/commcare/hq/__tests__/publishedCaseBlocks.test.ts`) moves to `.forms`; there is no production
  caller to move. `PublishedForm` keeps its three members (`xmlns`, `blocks`, `modelIterationRows`):
  only the blocks it lists change. `activeActions` and `activeActionTypes`, private today, are
  exported unchanged for section 3's reader.
- `sessionDatum` for a basic own block is `case_id` on a form that requires a case in a menu with no
  parent selection and no parent menu, the new case's `case_id_new_<type>_0` where it opens, and `null`
  where HQ reads it from the entry (`xform.py::get_add_case_preloads_case_id_xpath`'s
  `module.root_module_id or module.parent_select.active` arm), which `hqEntryFacts` covers.
- A basic child's `indices` is `[{ identifier: reference_id || "parent", target: own, relationship:
  "child" }]` where the form has an own block, and `[]` otherwise. `relationship` is always `child`:
  the build ignores the stored one.
- `properties` keeps HQ's keys as stored; each path stays as stored. Mapping a generated sibling's path
  back to its owner question is the caller's. Part 09's check 4 maps it by each side's own list of
  generated nodes and imports no reader module (09-acceptance-and-the-first-publish.md, section 6.4
  and Departure 15), so its comparison shares no classification with the reader.
  `caseManagement/basicActions.ts::ownerQuestionPath(form, path)` is this reader's own mapping, for
  3.5's comparison alone.
- `unread` replaces the silent `continue`s and the `Unread` catch. A form in `unread` is never a silent
  pass: part 09 raises it (its section 6.4 gives each reason's finding).
- `sourceHoldsEditMode(blocks: PublishedCaseBlocks): boolean` is new: true where some block's
  `editOnly` is not empty. The read asks it whether to probe the source project space for "save
  only if changed" (3.2; part 05, section 10.5; part 12, section 3.3, which makes the call), so a
  source that holds no `edit` costs no request.

Part 10 asks that the extended reader "says whether a source holds a Save to Case block": a form holds
one exactly where its `blocks` holds a `save-to-case` entry (part 09 reads it as
`AcceptedReading.sourceHoldsSaveToCase`).

### 6.2 What the comparison holds

`expandDoc(D)` here and in 6.3 is `expandDoc(D, readProjectionInputs(ctx))` (2.4): Nova's emission
under the source's own menu ids, form ids and `xmlns`, its project space, its table names and its media
paths. Forms are keyed by `xmlns` on both sides and every menu id a fact holds is the source's, so the
comparison is literal. Part 09's check 4 passes the same four inputs.

For each form `xmlns`, `publishedCaseBlocks(A).forms.get(xmlns)` and
`publishedCaseBlocks(expandDoc(D)).forms.get(xmlns)` must hold the same blocks: by kind and path, with
equal case type, conditions, indices, `ownerWritten`, `editOnly`, and `properties` equal after each
generated sibling's path is mapped to its owner question (6.1). `modelIterationRows` must be equal
as sets. The differences this part's same-state
rows allow are applied before comparing: `basic-own.properties` gains `external_id` from
`open_case.external_id` on both sides (the existing code does this), and nothing else.

This is the check that makes a held placement a fact about the HQ app and not about Nova's plan: an
operation the reader placed at `subcase_2` appears in Nova's emission at `subcase_2` or the reading is
`read-back-differs`.

### 6.3 `hqEntryFacts`: the session values

The reads hold no suite, so "HQ's entry datums for each form" cannot be read. HQ computes them
(`suite_xml/sections/entries.py::EntriesHelper`) from facts of the app's JSON. New file
`lib/commcare/hq/entryFacts.ts`:

```ts
export interface HqEntryFacts {
	readonly moduleKind: "Module" | "AdvancedModule";
	readonly caseType: string;
	readonly rootModule: string | null;            // root_module_id, as a menu id
	readonly putInRoot: boolean;
	readonly parentSelect: string | null;          // module_id where active and relationship "parent"
	readonly multiSelect: boolean;
	readonly maxSelect: number | null;
	readonly autoSelect: boolean;                  // Detail.auto_select on a multi-select list
	readonly autoSelectCase: boolean;
	readonly caseListShown: boolean;
	readonly offersSearch: boolean;                // util.py::module_offers_search
	readonly inlineSearch: boolean;                // module_uses_inline_search
	readonly searchInstance: string | null;        // search_config.instance_name
	readonly additionalCaseTypes: readonly string[];
	readonly requires: "none" | "case" | "advanced";
	readonly opensCase: boolean;
	/** Child cases outside any repeat, by case type, in list order. */
	readonly newChildCases: readonly string[];
	readonly usesWorkerRecord: boolean;            // an active usercase update or preload
	/** An advanced form's loads, in order. */
	readonly loads: readonly { readonly tag: string; readonly caseType: string;
	    readonly detailsModule: string | null; readonly indexTag: string | null;
	    readonly indexName: string | null; readonly autoSelect: string | null }[];
	/** An advanced form's open actions outside any repeat, in order. */
	readonly opens: readonly { readonly tag: string; readonly caseType: string }[];
}
export const ENTRY_FACT_KEYS: readonly (keyof HqEntryFacts)[];

/** What HQ's entry builder reads of a menu when it builds the datums of another menu's forms: a
 *  parent menu, a parent selection's target, a load's `details_module`. A menu with no form has
 *  one too, which is why these are not left to the per-form record. */
export interface HqMenuFacts {
	readonly moduleKind: "Module" | "AdvancedModule";
	readonly caseType: string;
	readonly rootModule: string | null;
	readonly putInRoot: boolean;
	readonly parentSelect: string | null;
	readonly multiSelect: boolean;
	readonly maxSelect: number | null;
	readonly inlineSearch: boolean;
	/** The `xmlns` of the menu's first form, whose datums a child menu aligns against. */
	readonly firstForm: string | null;
}
export const MENU_FACT_KEYS: readonly (keyof HqMenuFacts)[];

export interface HqAppEntryFacts {
	/** One record per form, by `xmlns`. A form `publishedCaseBlocks` leaves unread has none. */
	readonly forms: ReadonlyMap<string, HqEntryFacts>;
	/** One record per menu, by the menu's id, in HQ's menu order. */
	readonly menus: ReadonlyMap<string, HqMenuFacts>;
}
export function hqEntryFacts(source: unknown): HqAppEntryFacts;
/** The first key on which two forms' facts differ, in `ENTRY_FACT_KEYS` order. */
export function entryFactsDifference(a: HqEntryFacts, b: HqEntryFacts): keyof HqEntryFacts | undefined;
/** The first key on which two menus' facts differ, in `MENU_FACT_KEYS` order. */
export function menuFactsDifference(a: HqMenuFacts, b: HqMenuFacts): keyof HqMenuFacts | undefined;
/**
 * The session value ids HQ's entry builder gives a form, in order, from the facts alone: a port of
 * its id rules (`case_id`, a parent selection's `parent_id`, a child menu's renamed id, a load's
 * `case_id_<tag>`, a new case's `case_id_new_<type>_<n>`, `usercase_id`), and of nothing else it
 * builds. It reads `facts` and `menus` and no document.
 */
export function datumIdsFromFacts(
	facts: HqEntryFacts,
	menus: ReadonlyMap<string, HqMenuFacts>,
): readonly string[];
```

**The argument.** `EntriesHelper` reads only these keys, the menu order and each menu's own facts when
it builds a form's datums; Nova's `formLinkProjection.ts::entrySessionDatums` mirrors it, and lane
proof 3 holds the mirror over every corpus document. So where `hqEntryFacts(A)` and
`hqEntryFacts(expandDoc(D))` are equal form by form and menu by menu, with the menus in the same order
under the same ids (2.4's identity makes Nova's the source's), HQ builds the same datums from both,
and they are the ones `entryDatumIds(D, ...)` gives. `entryFacts.corpus.test.ts` holds the fact list
complete for every shape Nova emits, by holding `datumIdsFromFacts` equal to Nova's own projection
over the corpus ("Written and not yet run"); a key HQ reads only on a shape the reader refuses needs
no fact, because no reading of that shape is accepted.

**The finding when they differ.** `caseManagement/index.ts::compareEntryFacts(ctx, app)` runs at the
end of step 4 (2.1), over `provisionalDocument(ctx)`: every slot a fact reads (the parent selection,
the search's shape, the folded registration menu, the kinds, the loads) is written by then, and part
08 needs the verdict before it binds. It compares the menus' facts and then every form's, raises at
the menu or the form, and appends the uuid of each form that differed to
`ctx.facts.entryFactsRefused` (`readonly Uuid[]`; the finding stands at each form) for part 08:

| First differing key | Finding |
|---|---|
| `loads[i].tag` on a load `publishedCaseBlocks` gives no block for | `forms-and-case-writes/load-changing-no-case-with-a-tag-nova-does-not-derive` (4.3) |
| `loads` otherwise | `forms-and-case-writes/advanced-form-loads-other-than-its-menu-s-one-chain` (4.2) |
| `moduleKind`, of a form or of a menu | `menus-and-case-lists/advanced-module-nova-would-write-as-a-basic-one` (4.1) |
| any other key, where a finding of this part already stands at that menu or form | nothing more: the standing finding is why the slot is absent (a parent selection whose shape pass 1 refused, 8.5; a search or a list pass 1 refused, 11 and 12) |
| any other key otherwise | `unrecognized`, with `entry-fact:<key>` in `detail.name` |

Part 08 binds a `session/data/<id>` read against `entryDatumIds` of the draft. With this check passed,
an id an HQ expression reads and Nova's projection lacks is a read of a value HQ's entry does not
supply, which part 08 raises under its own row. In a form of `entryFactsRefused` the same read
raises nothing of part 08's: the registration is listed in `ExpressionReading.ownerless` and the
frame claims its node under the finding this table raised at the form (2.1), so one cause is one
line of the account.

---

## 7. The case catalog

`caseManagement/catalog.ts::readCaseCatalog(ctx, app)` writes `doc.caseTypes`. A document's catalog is a
seed: a property's type is "declared, else the one type its writers agree on"
(`lib/domain/effectiveCaseTypes.ts`), so the reader declares little and lets the writers speak.

**Case types.** One entry per distinct name among: every menu's `case_type` that is not blank; every
child case's, open action's and Save to Case block's case type. A name outside `CASE_TYPE_PATTERN` is
part 04's `menus-and-case-lists/case-type-outside-the-menu-page-s-grammar` (N1). `commcare-user` and
`user-owner-mapping-case` on a basic menu are
`menus-and-case-lists/case-type-commcare-user-or-user-owner-mapping-case-on-a-basic`;
`commcare-user` on an advanced menu is
`menus-and-case-lists/case-type-commcare-user-on-an-advancedmodule`. Order: first appearance in menu
order.

**`parent_type` and `relationship`.** For each child link the reader read (a basic child case's `parent`
index, an open action's index, a Save to Case link with a literal target type), the child type gets
`parent_type` = the link's target type and `relationship` = the link's, where every link out of the
child type under the identifier `parent` agrees. Where they disagree, neither key is written, and a
write or preload that needs the type of that ancestor is the finding
`forms-and-case-writes/index-path-through-a-case-type-the-app-does-not-fix` (3.2, 3.7). A basic menu's
`parent_select` naming a menu of case type `P` also gives its case type `parent_type: P` where no link
contradicts it: `readModules` records that candidate in step 2 (8.5: the named menu's `case_type`, read
from JSON), and `readCaseCatalog` takes the recorded candidates in step 3, so a `via` write or a
`parent/` preload of an app whose child cases are opened in another app still finds its ancestor's
type. Part 04's N14 takes a parent menu of any other type.

**Properties.** One per `(case type, name)` among: every write's property; every preload's; every case
list column's `field`; every simple Search field's property; every property an expression
reads. `label` is the name, as plain prose. Standard properties
(`lib/domain/standardCaseProperties.ts`) are not declared. One function writes a property, so its
order and the standard-property rule are stated once:

```ts
// lib/commcare/reader/caseManagement/catalog.ts
/** Adds `(caseType, name)` to `caseTypes` where the type holds no such property and the name is no
 *  standard property: label the name, no `data_type`, placed in name order by code unit. A no-op
 *  otherwise. It reads and writes the catalog it is given and nothing else. */
export function noteProperty(
	caseTypes: Draft<NonNullable<BlueprintDoc["caseTypes"]>>,
	caseType: string,
	name: string,
): void;
```

It is a function of a catalog, not of the reader's context, because part 08 calls it twice: its scan
applies it to a clone to learn what binding will find, and its stage applies it to the draft (part
08, section 2.5, step 1, which lists what it declared in `declaredProperties`). This part calls it
with the draft's catalog for every property of the list above.

**Types.** `data_type` is declared only by these rules, each a reader's need:

| Reader | Declares | Why |
|---|---|---|
| a sort element with `type: "int"` or `"double"` over a property no writer types | `int` or `decimal` | Nova derives the comparator from the property's type (`caseListOrder.ts`, rule 8); section 11.4 |
| a simple Search field of type `date` whose derived clause is the date-boundary form | `date` | `exactDateSearchPredicate` writes date or date-and-time boundaries by the property's type; section 12.3, (R3): `date` first, then `datetime` |
| the same whose clause is the date-and-time-boundary form | `datetime` | the same |
| a date range Search field over a property no writer types | `date` | `SEARCH_INPUT_TYPE_PROPERTY_TYPE_MISMATCH` asks for a date type |
| a case list column of format `date` over a property no writer types | nothing | a date column runs over any property; the validator treats absent as no opinion |
| a `plain` column over a property with no writer, or an `enum` column | nothing | |

A declared type that a writer contradicts would be the gate's `FIELD_KIND_PROPERTY_TYPE_MISMATCH`, so a
rule above applies only where `effectiveCaseTypes(draft)` gives the property no type without it; where
the writers' type differs from what the reader needs, the sort or the field takes its own finding
(`menus-and-case-lists/type-int-or-double-differing-from-the-derived-type-on-a-column`, or section
12.2's `case-search/search-field-over-a-property-of-another-type`).

**Writers that disagree.** The manifest's four rows are judged over the draft by
`effectiveCaseTypes.ts::concreteCasePropertyWriterTypes`: one type is
`forms-and-case-writes/writers-of-one-property-with-one-type`; `int` with `decimal` is
`forms-and-case-writes/writers-int-decimal`; a single with a multiple choice question is
`forms-and-case-writes/writers-single-select-multi-select`; any other pair is
`forms-and-case-writes/any-other-mixed-writer-pair`. A `now()` Hidden Value saved straight to a case
claims `forms-and-case-writes/a-now-hidden-value-saved-straight-to-a-case`.

**Choices.** A property that select questions write gets `options`: the union of their inline choices
by value, in first-appearance order, the first label winning
(`forms-and-case-writes/select-writers-with-differing-option-catalogs`). Each label is the question's
choice label as prose; its translations are written under the role `case-property-option-label` from
the same choice's itext.

**The date-and-time join.** Step 4's split leaves a date question, a time question and a Hidden Value
whose calculate joins them (`lib/doc/datetimeSplit.ts`). Part 06 reads the three as ordinary questions
(its 16.4: the join is an ordinary Hidden Value's calculate, and no node is marked for it), and 3.2
recognizes a write through the Hidden Value by re-emitting the join. A write through it types the
property `datetime` by the writer rule above (`fieldValueType.ts::fieldValueType` gives a Hidden
Value that writes a date-and-time property `xsd:dateTime`), with no declaration. The entry
`forms-and-case-writes/update-through-the-date-and-time-join-of-a-date-and-a-time` becomes HELD in
part 01's words (section 14).

**The catalog a Nova-born document holds.** A document born in Nova holds authored labels, declared
types and properties nothing reads, and a reading of its emission derives the catalog by the rules
above, so the two differ where no export does: the emitter reads a property's type through
`effectiveCaseTypes`, and a label and an unread property reach no export. The reader's catalog is
the canonical one of the pair. One function states it over any document, and one row
applies it:

```ts
// lib/commcare/reader/caseManagement/catalog.ts
/** The catalog this section's rules give over the document's own menus, operations, preloads,
 *  columns, search fields and expression reads: types in menu order; `parent_type` and
 *  `relationship` where the document's links agree; properties by `noteProperty`; `data_type`
 *  only under the four rules of the table above. */
export function catalogAsRead(doc: BlueprintDoc): NonNullable<BlueprintDoc["caseTypes"]>;
```

It is a row of part 06's `assemble.ts::READER_CANONICAL_CHOICES` under the id
`case-catalog-is-as-read`, with its `kind` `one-wire` and its `apply`: `apply` sets
`doc.caseTypes` to `catalogAsRead(doc)`. Part 09's canon table holds the row and
`canon.test.ts` its case (09-acceptance-and-the-first-publish.md, section 9).

---

## 8. Menus

`menus/modules.ts::readModules(ctx, app)` reads each `DraftModule` of `ctx.draft.modules`, in HQ's
order. A menu's own record (its document type, `unique_id`, `name`, `forms`, `comment`,
`ref_details`, `referral_list`, the undeclared `display_separately`, and `display_style` on an
advanced menu) and a form's (its document type, `form_type`, `unique_id`, `xmlns`, `name`, the
undeclared `put_in_root`) are read and claimed by part 06's `structure.ts::readStructure` (its
sections 7.1 to 7.4): for those keys `readModules` is a reader of the draft and claims nothing. This
part's claims on a menu's cursor are exactly the keys of the last row of part 06's 7.3
(`case_details` by section 11 and `search_config` by section 12); on a form's they are the keys of
the last row of its 7.4, and `case_references_data.save` (5.3). Area `menus-and-case-lists` unless
a row says otherwise. HQ's
models are `models/modules.py::ModuleBase`, `Module`, `AdvancedModule`; every field named is alive
unless its row says otherwise.

### 8.1 Which menus read

| `doc_type` | Reads | Entry |
|---|---|---|
| `Module` with a `case_type` | a menu with `caseType` | `module-with-case-type-case-list-module`, `modulebase-case-type` |
| `Module` with `case_type: ""` | a menu with no `caseType` | `module-with-case-type-survey-module` |
| `AdvancedModule` | the same, `heldKind: "advanced"` (4.1) | `advancedmodule`: claimed by part 06 (its 7.1 to 7.4); read here from `ctx.draft` (`DraftModule.docType`) |
| `ShadowModule` | finding at the menu, by its rows; the menu has no draft | `shadowmodule-shadow-module-version-2` (not-yet), `shadowmodule-with-no-source-module-id-or-one-naming-no-module`, `shadowmodule-version-1-or-key-absent-model-default-1`, `shadowmodule-v2-under-a-v2-shadow-menu-mirroring-a-non-shadow`: claimed by part 06 (its 7.1 to 7.4); read here from `ctx.draft` |
| `ReportModule` | finding; no draft | `reportmodule-mobile-ucr-and-all-of-report-configs`: claimed by part 06 (its 7.1 to 7.4); read here from `ctx.draft` |
| any other | finding; no draft | `unknown-module-doc-type`: claimed by part 06 (its 7.1 to 7.4); read here from `ctx.draft` |
| `is_training_module: true` | finding | `module-with-is-training-module-true-training-menu-root-training` |
| no `unique_id` | finding, before any mint (part 10 section 2.2); no draft | `module-unique-id-missing`: claimed by part 06 (its 7.1 to 7.4); read here from `ctx.draft` |

A menu's `uuid` is `DraftModule.uuid`, minted by part 06 from `externalKey.module` over its
`unique_id` (part 06, 7.2). `unique_id` itself, under `modulebase-unique-id`, is claimed by part 06
(its 7.1 to 7.4); it is read here from `ctx.draft` (`DraftModule.uniqueId`), and the id goes to part 10's
identity rows. A mirror menu's finding is one finding at that menu beside every other finding of the
app (part 05 reads its null `case_type` for that reason); it has no draft, so its forms and lists are
not read.

### 8.2 Order, nesting and names

| Key | Reads into | Entry |
|---|---|---|
| position in `modules[]` | `doc.moduleOrder`, in HQ's order, without the hidden registration menus 8.7 folds | (order has no key) |
| `root_module_id` naming a menu with no parent | `parentModuleUuid` | `child-menu-one-tier-root-module-id-a-parentless-module` |
| `root_module_id` naming a menu that has a parent, a missing menu or a cycle, a mirror or training menu | finding | `child-menu-deeper-than-one-tier-grandchild`, `root-module-id-naming-a-missing-module-or-a-cycle`, `any-other-module-under-a-shadow-menu`, `any-module-under-a-training-menu` |
| an order that puts a child away from its parent | finding | `menu-order-that-separates-a-child-from-its-parent` |
| a child menu of another case type under a parent with no forms | finding | part 04's N9, `child-menu-of-another-case-type-under-a-parent-with-no-forms` |
| `name{lang}` | `Module.name` (the first language's text) and one translation per other language, role `module-name` | `modulebase-name`: claimed by part 06 (its 7.1 to 7.4); read here from `ctx.draft` |
| `forms` | `doc.formOrder[menu]`, in HQ's order (the forms themselves are part 06's) | `module-forms`: claimed by part 06 (its 7.1 to 7.4); read here from `ctx.draft` |
| `comment`, `ref_details`, `referral_list`, `display_separately` | nothing | `comment-module`, `module-ref-details`, `module-referral-list`, `module-display-separately`: claimed by part 06 (its 7.1 to 7.4); read here from `ctx.draft` |
| `task_list.show: false`, `fixture_select.active: false`, `custom_icons[1:]` | nothing | their INERT rows (`module-task-list-show-false`, `fixture-select-active-false-stale-keys`, `custom-icons-1`) |
| `task_list.show: true`, `fixture_select.active: true`, `report_context_tile: true`, `lazy_load_case_list_fields: true`, non-empty `custom_assertions` | finding | `module-task-list-show-true`, `fixture-select-active-true`, `report-context-tile-true`, `module-lazy-load-case-list-fields-true`, `custom-assertions-module-non-empty` |
| a form's non-empty `custom_assertions` (part 06, section 7.4 leaves the key to this part) | finding at the form | `forms-and-case-writes/custom-assertions-form-non-empty` |
| a form's empty `custom_assertions` | nothing | (the schema default) |
| `custom_icons[0]`, `display_style` under some grid menus, `show_case_list_optimization_options` | finding | `custom-icons-0-badge-localized-text-or-xpath`, `module-display-style-list-grid-read-when-grid-form-menus-some-on`, `module-show-case-list-optimization-options` |
| `auto_select_case: true` on a basic menu | by its two rows | `auto-select-case-true-on-a-basic-module-an-advanced-form-s-load` (REFUSED), `auto-select-case-true-on-any-other-basic-module` (INERT) |

`Module.id`, the menu's display slug, is `lib/domain/idSlug.ts::uniqueSlug` over the first language's
name among the menus already read. A name blank in the first language takes the first language that
holds text, as `diffHqAppSource`'s fallback does (part 01 section 8.1).

Acceptance, in `settleMenus`: `lib/domain/moduleHierarchy.ts::projectedModulePreorder(draft)` followed
by the folded hidden menus in HQ's positions must be HQ's menu order. Where it is not, the finding is
`menu-order-that-separates-a-child-from-its-parent`.

### 8.3 Display conditions

`module_filter` and `form_filter` are text for part 08. Each is registered whole in pass 1 (a
`module_filter` under the slot `module_display_condition`, mode `no-case`; a `form_filter` under
`form_display_condition`, mode `case` where the form's entry asks for a case first, else `no-case`:
`expander.ts`'s own choice), because a form's condition cannot be interpolated before its case
datum is known (part 08, sections 6.1 and 8.3). Part 08 binds `false()` to `match-none`, and
`settleMenus` reads Nova's hidden spelling off the registration's outcome
(`ctx.pending.outcome(i).expression`):

| The bound tree | Reads into | Entry |
|---|---|---|
| a `module_filter` that is `match-none` | `hiddenFromMenu: true` and no condition (unless 8.7 folds the menu) | `module-filter-false-or-false-and-rest-menu-reached-only-by-links` |
| a `module_filter` that is an `and` led by `match-none` | `hiddenFromMenu: true`, and `displayCondition` the `and` of its other operands | the same |
| any other `module_filter` | `displayCondition`, the tree | part 08 claims `module-filter-value-lifts-into-predicate` or its HELD-NEW pair, or the two REFUSED rows (`module-filter-referencing-case-parent-host-or-a-bare`, `module-filter-failing-hq-s-validate-xpath`) |
| a `form_filter` that is `match-none` | `Form.hiddenFromMenu: true` and no condition | `form-filter-false-or-false-and-rest-form-reached-only-by-links` |
| a `form_filter` that is an `and` led by `match-none` | `Form.hiddenFromMenu: true`, and `Form.displayCondition` the `and` of its other operands | the same |
| any other `form_filter` | `Form.displayCondition`, the tree | part 08 claims `forms-and-case-writes/form-filter-lifting-into-predicate-a-direct-own-case-property-in` or `forms-and-case-writes/form-filter-outside-predicate-parent-host-user-usercase-reads`, or the REFUSED rows `forms-and-case-writes/form-filter-reading-case-status-case-id-case-type-owner-id`, `forms-and-case-writes/form-filter-referencing-the-case-database-other-than-through`, `forms-and-case-writes/form-filter-using-fixture-value` |

The key's one claim is the one the frame applies for part 08 at the registration's node (part 08,
section 9.2): the hidden rows name the class the reader reads, and this part makes no second claim on
`module_filter` or `form_filter`. A filter part 08 refuses reads to no slot, and its finding stands.

"The form's entry asks for a case first" is `requires === "case"` for a basic form and "has a chosen
load" for an advanced one. In `settleMenus`, a bound form condition that reads the form's case on a
screen that chooses no case first (`lib/domain/menuScreens.ts::screenChoosesCaseFirst` over
`menuScreenOf(draft, moduleUuid)`, part 02) is the finding
`form-filter-reading-the-case-on-a-screen-that-chooses-no-case-first` (REFUSED, part 02's row,
section 14). (R2): `suite/displayConditions.ts::emitModuleDisplayCondition` and
`emitFormDisplayConditionForHq` over the draft must print a tree equal to the stored text's.

### 8.4 Forms in the menu above

`put_in_root: true` reads `formsInMenuAbove: true` (`put-in-root-display-only-forms`, HELD, part 02), the
menu's name and media kept, unless a row below takes it, first match, each tested over the stored JSON
before any slot is written:

| Beside `put_in_root: true` | Finding |
|---|---|
| `session_endpoint_id`, inline search (`module_uses_inline_search`), a form of its own whose `post_form_workflow` is `module`, a form of a submenu of it whose workflow is `parent_module`, or a `form_links` entry naming it by `module_unique_id` | `put-in-root-session-endpoint-id-or-inline-search-or-an-end-of` |
| `case_list_session_endpoint_id` | `case-list-session-endpoint-id-on-a-put-in-root-module` (REFUSED, section 14) |
| a search it offers (`module_offers_search`) | `case-search/search-on-a-put-in-root-module` (HELD-NEW, section 14), raised by `search/workflow.ts::readSearchWorkflow` (12.1), which reads `search_config` |

`put_in_root` on a form, under `forms-and-case-writes/put-in-root-on-a-form-dynamic-key` (INERT), is
claimed by part 06 (its 7.1 to 7.4); read here from `ctx.draft` and claims nothing. Two
readings need the assembled document and run in `settleMenus`: a form listed on the first menu whose
workflow is `previous_screen` is
`forms-and-case-writes/post-form-workflow-previous-screen-on-a-form-listed-on-the-first-menu` (HELD-NEW,
section 14), decided by `forms.ts::PostSubmitMenuShape.formsOnFirstMenu` of the form's menu; and a
`form_links` entry or a `session_endpoint_id` whose frame runs through a first menu that shares one case
(`formLinkProjection.ts::firstMenuSharedCase(draft, ctx)`, part 02's reader, gives one, with `ctx` the
`formLinkProjectionContext` of the same document under 2.4's inputs) is
`forms-and-case-writes/form-link-or-endpoint-through-a-first-menu-that-shares-one-case` (HELD-NEW,
section 14). Both are part 02's rows, with its subjects and owners.

### 8.5 Choosing a parent case first

| `parent_select` | Reads into | Entry |
|---|---|---|
| `active: true`, `relationship: "parent"`, `module_id` a menu `lib/domain/caseParentSelection.ts::caseParentSelectionVerdict` accepts over the draft | `parentCaseModuleUuid` | `parent-select-active-true-relationship-parent-module-id-a-non` |
| the same naming a menu of a case type other than the child's declared parent, or of an extension's host | finding | part 04's N14, `parent-select-naming-a-module-outside-the-declared-parent-type` |
| `relationship: null` | finding | `parent-select-relationship-null-other` |
| naming a multi-select, missing or cyclic menu; a menu that searches inline under the child's results; a survey menu an entry reads | finding | `parent-select-module-id-naming-a-multi-select-module-or-an`, `parent-select-naming-a-module-that-searches-inline-under-the`, `parent-select-naming-a-survey-module-on-a-child-that-shows-its` |
| `active: false`, with whatever else it holds | nothing | `parent-select-active-false` (INERT) |
| naming a survey menu no entry reads | nothing | `parent-select-naming-a-survey-module-on-a-child-that-does-not` (INERT) |

The slot is written early and judged late, because readers ahead of `settleMenus` need it (2.1):

- **Step 2, `readModules`.** Where `parent_select.active` is true, `relationship` is `"parent"` and
  `module_id` names a menu of the app this reading holds, it writes `parentCaseModuleUuid` (the named
  menu's minted UUID) and records the named menu's `case_type` as the candidate `parent_type` of this
  menu's case type, for section 7. Both are read from JSON alone. Every other shape of the table
  writes nothing in this step and is claimed by its row.
- **Step 6, `settleMenus`.** It runs `caseParentSelectionVerdict` over `ctx.doc` for each slot
  written, with the catalog's declared parent types now final, and raises the findings of the table
  (N14, the multi-select, cyclic and inline rows). Where it raises one it removes the slot from the
  draft, so no later reader takes a selection Nova refused. The entry facts were compared at the
  end of step 4 with the slot in place (6.3), which is right: the source holds the selection too.

Between the two steps a slot that will be refused is still in the draft. That is safe: the checks
that read it in between (4.2's chain, 3.5's projections) can only add a finding at a menu that
already gets one here, and no accepted reading holds it.

### 8.6 The case list menu item, and media

| Key | Reads into | Entry |
|---|---|---|
| `case_list.show: true` | `caseListMenuItem: {}` | `module-case-list-on-a-formless-basic-module-show-true`, `module-case-list-show-true-on-a-basic-module-with-forms`, `module-case-list-show-true-on-an-advancedmodule` |
| `case_list.label{lang}` beside it | the text HQ's build writes for each language (`caseListLabelAsBuilt`, below): absent where that equals the menu's name in every language (Nova writes the menu's name for an absent label, `emissionPlan.ts::caseListMenuItemLabelUnit`); else `label` in the first language and a translation for each other language whose text differs, role `case-list-menu-item-label` | `module-case-list-label-lang` |
| a label with no text in any language, beside `show: true` | `label: "Case List"` and no translation: the words HQ's build writes there in every language (below). The stored map then differs from the one Nova writes, a rewrite the register holds (13.3, `list-settings-respelled`) | `module-case-list-label-lang` |
| `case_list.media_image`, `media_audio` beside it | `icon`, `audioLabel` through `readNavMedia`, slots `case_list_icon`, `case_list_audio_label` | `module-case-list-media-image-media-audio` |
| `case_list.show: false` on an advanced menu | nothing | `module-case-list-show-false-on-an-advancedmodule` (INERT) |
| `case_list.label` or media beside `show: false` on a basic menu | nothing: each reader of the label and the media tests `show` first (`app_strings.py::_create_case_list_app_strings`, `suite_xml/sections/entries.py::EntriesHelper.entry_for_module`, `suite_xml/sections/menus.py::MenuContributor._get_commands`, `corehq/apps/hqmedia/models.py::ModuleMediaMixin.all_media`) | `module-case-list-label-or-media-beside-show-false` (INERT, new, section 14) |
| `case_list.custom_icons` | by the menu rows for badges | `custom-icons-0-badge-localized-text-or-xpath`, `custom-icons-1` |
| the menu's `media_image`, `media_audio` | `icon`, `audioLabel` | `media-image-media-audio-same-asset-in-every-language`; differing by language is `media-image-media-audio-differing-by-language` |
| a form's `media_image`, `media_audio` | `Form.icon`, `Form.audioLabel` | `forms-and-case-writes/media-image-media-audio-same-asset-every-language`, or its `differing-by-language` row |
| `use_default_image_for_all`, `use_default_audio_for_all` | nothing stored: Nova holds one file for every language | `use-default-image-for-all-use-default-audio-for-all` (both areas) |

**The label a device shows.** HQ's build does not write a case list menu item's label as stored: for
each language it writes the first value of the map that is not `null` among that language and then
the build's languages in order, a blank value included; the value under the map's first key where
none of those languages is such a key; and "Case List" where the text it took is blank or the map
is empty ("Decided by reading"). The reader states the same function over the app's languages and
reads its result, never the stored map:

```ts
// lib/commcare/reader/menus/modules.ts
/** The text HQ's build writes for a case list menu item in each app language: for `lang`, the
 *  value under the first of `[lang, ...langs]` that is a key of `label` with a non-null value;
 *  where none is, the value of `label`'s first key in sorted order (by code point), as text, a
 *  `null` as "None"; "Case List" where that text is blank or `label` is empty. */
export function caseListLabelAsBuilt(
	label: Readonly<Record<string, string | null>>,
	langs: readonly string[],
): Readonly<Record<string, string>>;
```

So a label with no text in any language (an empty map, or blank strings alone) reads
`label: "Case List"`, the words HQ shows for it in every language, where Nova's absent label would
show the menu's name. A label blank in one language and not another reads that language as "Case
List" and the other as its own text. A label held only under a language the app no longer names
reads as that text in every language. Nova writes the map with every language's text in it, so
wherever the stored map held a blank, or no text for a language, the first publish rewrites it
with the words the build already wrote, a rewrite recorded under `list-settings-respelled`
(13.3). (R2), in `settleMenus`: `caseListLabelAsBuilt` over the `case_list.label` of 8.7's one
expansion equals `caseListLabelAsBuilt` over the stored one.

`menus/navMedia.ts::readNavMedia(ctx, node, slots, place)` is the one reader of the two maps on a menu,
a case list menu item, a form and an always-offered registration (2.2 gives its signature, what it
does with a path and what a slot holds where the path is handed off). `slots` names the two
`MediaRefLocation` kinds the maps
stand in: `module_icon` and `module_audio_label`, `case_list_icon` and `case_list_audio_label`,
`form_icon` and `form_audio_label`, or `case_list_registration_icon` and
`case_list_registration_audio_label`. Reading a map into one path is part 01 section 3.5's re-cut
for menus ("the same path in every language the app has reads as the one shared slot; a path present
in one language and absent in another counts as differing"). (R2):
`multimedia/navMenuMedia.ts::buildNavMediaDicts` over the read slots, with the app's languages and
2.4's `assets`, gives the stored maps; a map whose reference is pending is left out of the comparison
and is part 11's to decide.

### 8.7 Registration from the case list, and the hidden menu

`menus/registration.ts::readCaseListRegistration(ctx, app)` reads `case_list_form`
(`models/modules.py::CaseListForm`; `form_id` alive, `relevancy_expression` flag-gated under
`FOLLOWUP_FORMS_AS_CASE_LIST_FORM`, part 02 section 10.1). `form_id` in a source read is that read's
minted id (`FormIdProperty`), so it is resolved through `HqAppSourceForm.readUniqueId` to the aligned
form, never compared with a real id. First match, in part 02's order (`02-menus.md`, section 14,
"Which row a block made in CommCare HQ falls in"):

| # | Shape | Reads into | Entry |
|---|---|---|---|
| 1 | `form_id` blank | nothing, with every field beside it | `case-list-form-fields-beside-a-blank-form-id` (INERT); the narrowest blank block needs no claim (the lane's rule `case-list-form-unset`) |
| 2 | `form_id` naming no form, or a form that is no registration form of the host's type (two registrations of the type among them) | finding | `case-list-form-missing-not-a-registration-form-toggle-off-or` |
| 2 | the host shows its forms above, by its three rows | nothing or finding | `case-list-form-on-a-top-level-put-in-root-module-whose-case-list` (INERT), `case-list-form-on-a-child-put-in-root-module-whose-parent-s-case`, `case-list-form-on-a-put-in-root-module-whose-case-list-is-a-tile` |
| 2 | some form of the host needs no case | finding | `case-list-form-on-a-module-whose-forms-do-not-all-require-a-case` |
| 3 | the host or the form's menu is an `AdvancedModule` | finding | `case-list-form-on-an-advanced-module-or-naming-an-advanced-form`; `forms-and-case-writes/advanced-forms-in-a-module-whose-case-list-offers-a-registration` where HQ's six rules break |
| 3 | the form's one registration of the type is a root child case | finding | `case-list-form-pointing-at-a-form-whose-one-registration-of-the-type-is-a-child-case` |
| 3 | the form is another list's after-empty-search form | finding | `case-list-form-naming-a-form-another-list-offers-after-an-empty-search` |
| 3 | the host sits under a menu that shares the first menu's case | finding | `case-list-form-on-a-host-under-a-menu-that-shares-the-first-menu-s-case` |
| 3 | the form is a follow-up form of the parent case type | finding | `case-list-form-pointing-at-a-follow-up-form-of-the-parent-case` |
| 4 | **the hidden-menu shape** (below) | `caseListRegistrationForm: { kind: "after-empty-search", formUuid, label? }` on the host; the hidden menu is folded | `case-list-form-on-a-search-first-host-pointing-at-a-registration` |
| 5 | anything else part 02 section 11.3 admits | `caseListRegistrationForm: { kind: "always", formUuid, label?, icon?, audioLabel?, afterSubmit }` | `case-list-form-pointing-at-a-registration-form-in-another-module` |

**The hidden-menu shape**, all of: the named form's menu holds exactly that one form; that menu's
`module_filter` is exactly `false()`; no other key of that menu is at a value other than Nova's shell
(`hqShells.ts::moduleShell` for the form's case type: no parent, no case list item, no search, no media,
the default details); the host's forms read the search (`search_config.inline_search` and `auto_launch`
both true); `relevancy_expression` is the tree of
`suite/case-search/noMatches.ts::NO_MATCHES_RELEVANCY`; `post_form_workflow` is `case_list`; and the
block holds no `media_image` and no `media_audio` (Nova's `after-empty-search` arm holds no media, so
a block with media is not this shape and reads by row 5). The filter is tested in pass 1 with
`syntaxCompare.ts::sameXPathText` against `false()`; a folded menu has no slot for it, so this
reader claims it `derived` under `module-filter-false-or-false-and-rest-menu-reached-only-by-links`
and registers nothing (8.3). Then
the hidden menu is not a Nova menu: its form joins the host's `formOrder` at the end of the host's
forms, and the menu is listed in the reading's identities (`ReadMenuAndFormIdentities.modules`, part
06 section 16.1) under `syntheticModuleUuid(formUuid)`, so its HQ id goes to part 10's identity rows
under that UUID (part 10, 3.1). This part claims no `externalKey` for it, and the draft menu part 06
made for it is left out of `moduleOrder`. The end is the reader's choice, not a fact of the wire:
`emissionPlan.ts::emissionPlan` lifts the form out of the host's `formOrder` from wherever it stands
and the hidden menu carries no trace of where that was, so a Nova-born document whose registration
form stood earlier among its host's forms reads back with it last. Two documents print that one
source, and the reader returns the one with the form last: a row of part 06's
`assemble.ts::READER_CANONICAL_CHOICES` under the id `registration-form-last`, with its `kind`
`one-wire` and its `apply`. `apply` moves each registration form a list offers after an
empty search to the end of its menu's forms. Moving the form to the end of its host's `formOrder`
changes no emitted byte, since the form is on no menu either way. It is one of the rows of
`READER_CANONICAL_CHOICES` this part adds, reaching proof 6 through part 09's `canonDocument`. The
same shape
with `post_form_workflow: "default"` is
`case-list-form-post-form-workflow-default-on-the-hidden-module-shape` (HELD-NEW). A menu that is
always hidden and named by a host, but fails any other test, is an ordinary menu off the menu (8.3) and
the block falls to row 5.

**Fields of both arms:**

| Key | Reads into | Entry |
|---|---|---|
| `label{lang}` with text in some language | `label`, role `case-list-registration-label`; absent where it equals the form's name in every language (`emissionPlan.ts::caseListFormLabelUnit`). A language whose value is an empty string reads as "Create a new Case" in that language, with a record under `registration-label-fixed`; a language the label holds no key for is no translation | `case-list-form-label-lang` |
| `label` with no text in any language | `label: "Create a new Case"`, the words HQ's build writes for it (`app_strings.py::_create_case_list_form_app_strings`), on whichever arm the block reads as; a record `{ entry, path, register: "registration-label-fixed" }` appended to `ctx.facts.sameStateRewrites` | `case-list-form-label-empty` (HELD) |
| `post_form_workflow`, `always` arm | `afterSubmit`: `case_list` is `"case-list"`, `default` is `"new-case"`, whatever the form's own navigation | `case-list-form-post-form-workflow-default-case-list`; `default` on a multi-select host is `case-list-form-post-form-workflow-default-on-a-multi-select-host` |
| `media_image`, `media_audio`, `always` arm | `icon`, `audioLabel` through `readNavMedia`, slots `case_list_registration_icon`, `case_list_registration_audio_label` | `case-list-form-media-image-media-audio` |
| media beside the rest of the hidden-menu shape | never the `after-empty-search` arm: no media is part of that shape, so the block reads by row 5, where its `relevancy_expression` takes the row below | (the rows above and below) |
| `relevancy_expression` on an `always`-shaped block | nothing without the toggle's effect; finding with it | `case-list-form-relevancy-expression-without-that-toggle` (INERT), `case-list-form-relevancy-expression-with-followup-forms-as-case` |

"With the toggle's effect" cannot be read from the app: the toggle is the project space's. The reader
reads a non-blank `relevancy_expression` on an `always`-shaped block as the HELD-NEW row. An HQ app can
hold one only where a page that needs the toggle wrote it, and Nova's `always` arm writes none, so a
publish would drop it.

Acceptance, in `settleMenus`, (R2): the gate's two registration rules
(`validator/rules/case-search/caseListRegistration.ts::caseListRegistrationForm` and
`caseListRegistrationFormInModule`) hold over the draft, and `expandDoc`'s `case_list_form` for the
host equals the stored block after the INERT claims, its `form_id` literally (2.4's identity prints
the source read's id for the form). A language of the `label` read as "Create a new Case" is compared
as those words: the one difference this comparison allows, under its record of
`registration-label-fixed` (13.3). `settleMenus` expands the app once, `expandDoc(ctx.doc,
readProjectionInputs(ctx))`, after every menu slot of step 6 is written, and every check of this
section, of 8.2 and of 8.6 reads that one expansion: a host is one lookup in it, never an expansion of
its own.

---

## 9. After submit

`lib/commcare/reader/menus/afterSubmit.ts` (the reader's file; `lib/domain/afterSubmit.ts` is the
domain's, cited below by its full path):

```ts
export function readAfterSubmit(ctx: ReadContext, app: DraftApp): void;         // pass 1, from readMenus
export function registerLinkExpressions(ctx: ReadContext, app: DraftApp): void; // the end of step 4
export function settleAfterSubmit(ctx: ReadContext, form: DraftForm): void;     // pass 2, from settleMenus
/** Which trailing conjuncts of a stored link `xpath` are the emitter's held-case guards (9.4). */
export function linkGuards(
	doc: BlueprintDoc,
	formUuid: Uuid,
	link: FormLink,
	xpath: string,
): { readonly guards: "none" | "written" | "added"; readonly expected: number };
```

HQ: `FormBase`'s `post_form_workflow`, `post_form_workflow_fallback`, `form_links`
(`models/forms.py::FormLink`: `xpath`, `form_id`, `form_module_id`, `module_unique_id`,
`datums[{name, xpath}]`; all alive). Area `forms-and-case-writes`.

### 9.1 The workflow word

| `post_form_workflow` | Destination | Entry |
|---|---|---|
| `default` | `app_home` | `post-form-workflow-default` |
| `root` | `firstMenu` | `post-form-workflow-root` |
| `module` | `module` | `post-form-workflow-module` |
| `parent_module` | `parentMenu` | `post-form-workflow-parent-module` |
| `previous_screen` | `previous` | `post-form-workflow-previous-screen` |
| `form` | the links of 9.2 | `post-form-workflow-form` |
| a word HQ's build refuses there; any word outside what HQ offers there | finding | `post-form-workflow-hq-s-build-refuses-module-in-a-put-in-root`, `any-other-post-form-workflow-outside-the-offered-set-previous` |

`Form.postSubmit` is written only where the destination differs from
`lib/domain/postSubmit.ts::defaultPostSubmitOf(draft, formUuid)`, in `settleAfterSubmit` (the default
reads the menu's search, selection and nesting). So `default` on a registration stores nothing and
`default` on a follow-up form stores `app_home`. A document that stores the default word and one
that stores none print one source, and the reader returns the one that stores none: a row of part
06's `assemble.ts::READER_CANONICAL_CHOICES` under the id `default-post-submit-is-absent`, with its
`kind` `one-wire` and its `apply`. `apply` removes a `postSubmit` equal to
`defaultPostSubmit` for its type and menu on a form with no destinations. (R1):
`session.ts::toHqWorkflow(effectivePostSubmit(...))`
is the stored word. "Offered" is `postSubmit.ts::postSubmitDestinationsOffered` over the draft: a word
whose destination it does not offer takes the second finding row, with the word's page label in
`detail.name` (13.1, `HQ_PAGE_LABELS.workflow`).

`form_links` beside any workflow but `form` is `form-links-present-while-post-form-workflow-form`
(INERT): nothing is read from it.

### 9.2 Links

Read only under `post_form_workflow: "form"`. Nova writes its destinations in reverse and the otherwise
link last (`formLinkProjection.ts::projectAfterSubmit`), so:

1. Decide the otherwise (9.3). If the last element is the otherwise link, set it aside.
2. The remaining elements, **reversed**, are `Form.formLinks`.

Each element:

| Key | Reads into | Entry |
|---|---|---|
| `form_id` resolving (through `readUniqueId`) to a form, `form_module_id` its menu | `target: { type: "form", moduleUuid, formUuid }`; a link to the source form in its own menu is `{ type: "this-form" }` | `form-links-target-a-form-any-suite-form`, `form-links-form-module-id`, `form-links-target-the-current-form-or-a-link-cycle` |
| `module_unique_id` naming a menu `formLinkTargets.ts::menuTargetOffered` offers | `target: { type: "module", moduleUuid }` | `form-links-target-a-top-level-or-child-matched-module-that-does` |
| `module_unique_id` naming any other menu | finding | `form-links-target-any-other-module` |
| a target that resolves to nothing, both ids set, neither set | finding | `form-links-failing-hq-s-link-checks-no-form-links-and-bad-form` |
| `xpath`, blank | no condition | `form-links-xpath` |
| `xpath`, not blank | `condition` (slot `form_link_condition`, interpolation `none`), registered by `registerLinkExpressions` with its guards stripped (9.4) | `form-links-xpath`; two true at once is `two-or-more-form-links-conditions-true-at-once` |
| `datums[]` on a form target, each `name` a session value the target's entry selects | `datums: [{ name: { kind: "selected-case", module }, xpath }]` (slot `form_link_datum_xpath`); `name` is kept as HQ's id in pass 1 and resolved by `registerLinkExpressions` (9.4, step 1) through `entryDatumIds(snapshot, projectionCtx, targetModule, targetForm)`: the row whose `id` or `chainId` is the name gives the selection | `form-links-datums-on-a-form-target-names-among-the-target-s` |
| `datums: []` | absent | the same |
| `datums` naming anything else, or on a menu target | finding | `form-links-datums-with-other-names-or-on-a-module-target` |
| `datums` that leave the target's case id empty | finding (the gate's `FORM_LINK_DATUMS_INCOMPLETE` over the draft) | `form-links-datums-that-leave-the-target-s-case-id-empty` |

Each link's `uuid` is minted from `externalKey.formLink(xmlns, target, n)`, counting `formLinks` in
their Nova order and then the otherwise link (part 10 section 2.2). A link naming a mirror menu's form
or a menu the reader refused resolves to nothing the document holds; it raises no second finding where
the target's own finding stands.

### 9.3 The otherwise

Exactly two shapes, tested in this order:

| Shape | Reads into | Entry |
|---|---|---|
| `post_form_workflow_fallback` one of `root`, `module`, `parent_module`, `previous_screen`, offered in that menu, where some link's `xpath` is not blank | `otherwise: { kind: "destination", destination }` | `post-form-workflow-fallback-module-or-previous-screen-offered-in`, `post-form-workflow-fallback-root-or-parent-module-offered-in` |
| the same word, not offered there, under a conditional link | finding | `post-form-workflow-fallback-module-parent-module-or-previous` |
| a fallback where no link has a condition, or outside the offered set elsewhere, or `null`, `""`, `default` or any other value | nothing | `post-form-workflow-fallback-offered-in-that-menu-set-where-no`, `post-form-workflow-fallback-outside-the-offered-set-anywhere`, `post-form-workflow-fallback-null-default-or-any-value-other-than` (INERT) |
| no fallback read, at least two elements, and the **last** element's `xpath` tree is `not(x_1) and ... and not(x_n)` over every other element's non-blank `xpath` tree, in stored order, followed by exactly the guards 9.4 expects of that link (none where it carries no guarded value, or where the source wrote none: 9.4's `guards: "added"`) | `otherwise: { kind: "link", uuid, target, datums? }`; the last element leaves the destinations | `form-links-xpath` |

The second shape is syntactic over `syntaxOf(xpath, undefined)` trees (a link's `xpath` is a slot HQ
does not interpolate; `sameSyntax` conjunct by conjunct), decided in `registerLinkExpressions` with
the guards, then accepted by (R2) with the rest. Only the last element can be the otherwise link. An
HQ-authored last link that matches reads as the otherwise, and the round trip keeps HQ's order:
`[L1: c, L2: not(c)]` reads as destination `L1` with otherwise `L2` and is written back `[L1, L2]`.
A fallback read beside a last element of that shape keeps the element as a destination: HQ runs both.

`FORM_OTHERWISE_UNREACHABLE` refuses an otherwise where no destination may fail to run; the reader never
proposes one there (the first row needs a non-blank `xpath`, the last needs another element with one).

### 9.4 Held-case guards

Nova adds one conjunct per carried value on a single-case selection to each link's `xpath`:
`count(instance('casedb')/casedb/case[@case_id = V and @case_type = 'T']) > 0`
(`formLinkProjection.ts::formLinkCarriedCaseGuards`, over
`lib/domain/afterSubmit.ts::guardedLinkDatums`). They are derived, so the reader takes them off
before part 08 sees the condition, as part 08 asks
("every link condition and carried value, after removing the held-case conjuncts it recognized"). A
`casedb` count is nothing the `form_link_condition` slot need bind, so a guard left in the registered
text could be refused there before any settle ran.

Which guards a link carries is a fact of structure, not of any bound tree: `guardedLinkDatums` reads
the link's target and the selections its carried values name, and a link with no `datums` (automatic
matching) carries none. So the strip needs no candidate and no second binding. It runs once every
structure is read and before part 08, in `menus/afterSubmit.ts::registerLinkExpressions(ctx, app)`
(2.1, the last call of step 4), over `snapshot`, which is `provisionalDocument(ctx)`:

1. Resolve each carried value's `name` to the selection it lands on, through
   `entryDatumIds(snapshot, projectionCtx, targetModule, targetForm)`: the row whose `id` or `chainId`
   is the name gives `{ kind: "selected-case", module }` (9.2).
2. `guardedLinkDatums(snapshot, formUuid, link)` gives the carried values the emitter guards, in
   `datums` order: `g` of them. For the `i`-th, the expected guard is the tree of
   `count(instance('casedb')/casedb/case[@case_id = V_i and @case_type = 'T_i']) > 0`, with `V_i`
   the syntax of that datum's stored `xpath` and `T_i` the selection's case type (no type test where
   it has none), built with `xpath/wire/rowScope.ts::caseById` as the emitter builds it.
3. Parse the stored `xpath` with `syntaxOf(xpath, undefined)` and split it at its top-level `and`s
   into conjuncts `c_1 ... c_k`. Where `g > 0` and the last `g` conjuncts are `sameSyntax` to the
   expected guards, in order, they are stripped and the link is `guards: "written"`. Otherwise
   nothing is stripped and, where `g > 0`, the link is `guards: "added"`; where `g` is 0 it is
   `guards: "none"`.
4. Register what is left, joined with `and` in stored order, as the link's pending condition (nothing
   left: no condition, and nothing is registered), and each carried value's `xpath` as its pending
   value.

A conjunct of the guard's shape that is not one of the `g` expected ones is never stripped. It is
the author's, it stays in the registered condition, and part 08 binds it or raises its own finding.

Steps 2 and 3 are the pure function `linkGuards(doc, formUuid, link, xpath)` of section 9's code
block, which answers `guards` and `expected` (the count `g`). The mark is held nowhere:
`registerLinkExpressions` calls it over `snapshot`, and `settleAfterSubmit` calls it again over
`ctx.doc` with the same stored `xpath` (9.5), where the link's target and carried selections are the
ones step 1 wrote, so the two calls agree.

**A link whose guards are added.** HQ's own pages write no guard, so an HQ-authored link that carries
a value onto a single-case selection is `guards: "added"`: Nova's emission of it gains the `g`
conjuncts, and a destination whose carried case is not on the device then does not open, where
HQ's build of the source runs the destination on the author's condition alone
(`suite_xml/post_process/workflow.py::_get_link_frame`). The guard is one of the checks Nova's
emitter conjoins, and each change such a check makes is read exactly, refused or declared (part 09,
section 11.4). This one is declared: the register row `link-held-case-guards-added`
(13.3), which touches workers. Reading it exactly would need a link that carries a value unguarded,
which Nova refuses to write on purpose (`lib/commcare/CLAUDE.md`, "No runtime prompt on an unmatched
datum"), and refusing it would refuse every HQ app whose link carries a case by hand.

### 9.5 Acceptance of a form's after-submit

`settleAfterSubmit`, per form: `formLinkProjection.ts::formLinkActionsBuildable` holds; then (R2):
`projectAfterSubmit` and `expander.ts::toHqFormLink` over the draft, under 2.4's inputs, give
`post_form_workflow`, `post_form_workflow_fallback` and `form_links[]` equal to the stored ones, each
`xpath` and each datum `xpath` as trees, each `form_id` and each `module_unique_id` literally (2.4's
identity prints the source's), after the INERT claims. Where a form holds a link marked
`guards: "added"`, the stored list is first given the guards Nova will write, and Nova's emission is
compared with that: each such link's `xpath` gains its `g` expected conjuncts (9.4, step 2) at its
end, and an otherwise link's `xpath` (9.3, the second shape) has that link's operand rebuilt over
the longer `xpath`, or gains one `not(...)` operand in link order where the link's `xpath` was blank.
Nothing else is adjusted. A difference no row above names is `unrecognized` at the form, with
`schema:Form.form_links` in `detail.name`.

---

## 10. Deep links and CommCare Connect blocks

### 10.1 Deep links

`menus/entryPoints.ts::readEntryPoints(ctx, app)`. HQ's three slots, each alive and each built only
under the toggle `SESSION_ENDPOINTS` (the manifest's precondition; a stored id reads whatever the
toggle):

| Key | Reads into | Entry |
|---|---|---|
| a menu's `session_endpoint_id`, not blank | `Module.entryPoint: { uuid, id }` | `menus-and-case-lists/session-endpoint-id` |
| a menu's `case_list_session_endpoint_id`, not blank | `Module.caseListEntryPoint` | `menus-and-case-lists/case-list-session-endpoint-id` |
| a form's `session_endpoint_id`, not blank | `Form.entryPoint` | `forms-and-case-writes/session-endpoint-id` |
| a form's `respect_relevancy: false` beside an id | `ignoreDisplayConditions: true` | `forms-and-case-writes/respect-relevancy-false` |
| `respect_relevancy` with no id, or `true` | nothing (Nova writes `true` for a form with no deep link) | the same row, no key |
| an id that is not a fixed point of HQ's `slugify`, or one two slots share | finding | `menus-and-case-lists/module-or-mirror-form-endpoint-id-that-is-not-a-slugify-fixed`, `menus-and-case-lists/two-endpoints-sharing-an-id-module-case-list-form-or-mirror-form`, `forms-and-case-writes/session-endpoint-id-not-a-slug-fixed-point-or-duplicated` |
| `function_datum_endpoints[]` | finding | `forms-and-case-writes/function-datum-endpoints` |
| `""` or absent | nothing | (the schema default) |

"A fixed point of `slugify`" is tested with `lib/domain/entryPoints.ts::entryPointIdProblem`, which
states HQ's rule (lower-case letters, digits, `_` and `-`, no edge `-` or `_`, no doubled hyphen); an id
it refuses takes the finding. The `uuid` is minted from `externalKey.entryPoint("module",
moduleUniqueId, "menu")`, `externalKey.entryPoint("module", moduleUniqueId, "case-list")` or
`externalKey.entryPoint("form", xmlns)`. In
`settleMenus` the gate's `ENTRY_POINT_INVALID` over the draft is run for each
(`validator/rules/app.ts`, whose reasons are `id-format`, `display-conditions`, `duplicate-id` and
`destination`). `id-format` and `duplicate-id` are the two rows above, raised from the stored ids
before any slot is written, so the gate never meets them. `display-conditions` cannot arise: the
reader writes `ignoreDisplayConditions` on a form's deep link alone. `destination` with part 02's
shared first-menu case is 8.4's finding. Any other `destination` refusal is a deep link whose frame
Nova cannot build for a reason no row of this part names; it is `unrecognized` at the menu or form,
with the slot's surface key in `detail.name` (13.2). The entry-point links of the ledger wait for the
first publish (part 10, 10-identity-and-the-ledger.md, section 6.1).

### 10.2 Connect blocks

Connect blocks are read by part 06 (its section 15, `reader/xform/connect.ts::readConnectBlocks`).
This part builds no `caseManagement/connect.ts` and claims no Connect entry. It reads
`ReadXForm.connectBlocks` and the draft form's `connect` for its own rows that turn on `connectType`.
An app of both families is part 06's `questions/connect-learn-and-deliver-blocks-in-one-app`, at the
app; an id `CONNECT_ID_PATTERN` refuses is
`questions/question-id-failing-the-grammar-or-meta-in-any-case`.

---

## 11. Case lists and details

`caseList/details.ts::readCaseDetails(ctx, module)` reads `case_details.short` and `case_details.long`
of every menu with a case type (`models/case_list.py::Detail`, `DetailColumn`, `SortElement`; alive
unless a row says otherwise) into `Module.caseListConfig`: `columns`, `listColumnOrder`,
`detailColumnOrder`, `filter`, `selection`, `tile` (`searchInputs` is section 12's). Area
`menus-and-case-lists`. A menu with no case type claims its details by
`short-columns-empty-on-a-survey-or-registration-only-module-that` (INERT) and reads no config.

### 11.1 The detail's own keys

| Key | Reads into | Entry |
|---|---|---|
| `display` | nothing | `detail-display` (INERT) |
| short `columns`, long `columns` | 11.2, 11.3 | `detail-columns-short`, `detail-columns-long`; an empty long is `long-columns-empty`; an empty short by its three rows (`short-columns-empty-on-a-module-that-needs-case-details`, `short-columns-empty-on-a-survey-or-registration-only-module-that` INERT, `short-columns-empty-on-a-module-another-module-s-active-parent`) |
| short `filter` | `caseListConfig.filter`, pending (slot `case_list_filter`, the mode `projectCaseListFilter` prints under), less the owner clause of 12.4 | part 08 claims `detail-filter-value-lifts-into-predicate`, its HELD-NEW pair, or `detail-filter-failing-etree-xpath-dummy-filter` |
| `instance_name` | nothing for `casedb`; finding otherwise | `detail-instance-name-casedb` (INERT), `detail-instance-name-any-other-stored-value` |
| `multi_select: true` on a basic menu | `selection: { kind: "multiple", maximum }` | `detail-multi-select` |
| `max_select_value` beside it: 1 to 100 | `maximum` | `detail-max-select-value-on-a-multi-select-basic-list` |
| `max_select_value: -1` | `maximum: 100` (the same state, by the entry's cell); Nova writes `100`, a source rewrite the register holds (13.3, `list-settings-respelled`) | the same |
| `max_select_value` above 100; 0 or below -1 | finding | part 04's N10 `detail-max-select-value-above-100`; `detail-max-select-value-of-0-or-below-1-on-a-multi-select-basic` |
| `max_select_value` on a list that is not multi-select | nothing | `detail-max-select-value-on-a-basic-list-that-is-not-multi-select` (INERT) |
| `auto_select` | finding on a multi-select list, finding on a single one | `detail-auto-select-multi-select`, `detail-auto-select-true-on-a-single-select-basic-list` |
| `case_tile_template` | 11.5 | 11.5's rows |
| `persistent_case_tile_from_module`, `pull_down_tile`, `persist_case_context` where no tile persists | finding | `detail-persistent-case-tile-from-module`, `detail-pull-down-tile`, `detail-persist-case-context-persistent-case-context-xml` |
| `persist_case_context` beside a persisting tile; `persistent_case_context_xml` at HQ's default | nothing | `persist-case-context-beside-persist-tile-on-forms-on-a-short` (INERT) |
| `custom_xml`, `custom_variables_dict` non-empty | finding | `detail-custom-xml-non-empty`, `detail-custom-variables-dict-non-empty` |
| `custom_variables` (legacy), `print_template` | nothing | `legacy-detail-custom-variables-key`, `detail-print-template` (INERT) |
| `no_items_text`, `select_text` | nothing at HQ's default; finding otherwise | `detail-no-items-text-equal-to-hq-s-default`, `detail-select-text-default-en-continue` (INERT); `detail-no-items-text-other-than-hq-s-default-en-list-is-empty`, `detail-select-text-non-default` |
| `tabs` non-empty | finding, by kind | `plain-tab-header-starting-index`, `tab-relevant-lifts-into-predicate-not`, `data-tab-over-child-cases-has-nodeset-nodeset-case-type-nodeset`, `data-tab-over-a-custom-nodeset-xpath`, `columns-above-the-first-tab-when-tabs-exist`, `a-custom-long-tile-row-mixing-fields-of-two-tabs-in-a-basic-or`, `a-custom-long-tile-row-mixing-fields-of-two-tabs-in-an-advanced` |
| `lookup_enabled: true` and its keys | finding | the seven HELD-NEW rows `lookup-enabled-lookup-action`, `lookup-name`, `lookup-image-jr`, `lookup-autolaunch`, `lookup-extras-key-value`, `lookup-responses-key`, `lookup-display-results-lookup-field-header-lookup-field-template`, and the two REFUSED rows `callout-with-no-extras-or-no-responses`, `lookup-on-the-long-detail-tabbed-or-not`, each tested before the HELD-NEW rows of its keys (2.3, rule 1) |
| `lookup_enabled: false` with whatever else; `lookup_enabled` on an `icon_text_grid` list | nothing | `lookup-enabled-false-with-stale-keys`, `lookup-enabled-on-an-icon-text-grid-case-list` (INERT) |
| any key `Detail` or `DetailColumn` does not declare | finding | `any-other-undeclared-key` |

### 11.2 A column

`caseList/columns.ts`:

```ts
/** One detail column as the Nova column it would be, before the two details are joined (11.3). */
export interface ColumnProposal {
	/** The column less the slots 11.3 to 11.5 set: its kind, its `field` or expression (a
	 *  calculated column at `pendingPlaceholder`), its header's source text, its kind's own slots. */
	readonly column: Omit<Column, "uuid" | "sort" | "tile" | "visibleInList" | "visibleInDetail">;
	/** The header in every app language, for 11.3's equality and the translation sink. */
	readonly header: Readonly<Record<string, string>>;
	/** The registration index of a calculated column's expression (2.2). */
	readonly pending?: number;
	/** True for an `invisible` short column, which joins by `field` alone (11.3, rule 1). */
	readonly invisible: boolean;
}
/** `undefined` where the column's row raised a finding. `screen` is the detail it stands in. */
export function readDetailColumn(
	ctx: ReadContext,
	module: DraftModule,
	column: JsonCursor,
	screen: "short" | "long",
): ColumnProposal | undefined;
```

`Column` is `lib/domain/modules.ts::Column`. HQ
registers its formats in `detail_screen.py` (`register_format_type`). `model: "product"` is
`model-product`; `model: "case"` is `model-case`. The column's `field` first: a name
`details/utils.js::isValidPropertyName` accepts on a column that is not calculated
(`field-property-paths-in-column-field-paths`; else
`field-failing-details-utils-js-isvalidpropertyname-non`); HQ's five renamed names read as Nova's
standard properties (`name-date-opened-external-id-status-owner-id-hq-renames-to-case`,
`last-modified`, `prop`); a relation path, `user/`, `#owner_name` and the prefixed generators are their
rows' findings (`idx-prop-parent-host-any-index-names-other-than-a-first-step`, `user-prop-usercase`,
`user-steps-prop`, `owner-name`, `property-x-or-prefix-x-with-a-prefix-hq-registers-no-generator`,
`attachment-name-with-any-other-format`, `ledger-section`, `location-type`, `schedule-var`,
`indicator-call-center-name`, `indicator-any-other-set-name`). A field outside
`AUTHORED_CASE_PROPERTY_NAME_PATTERN` that HQ's check accepts is the finding
`column-field-outside-nova-s-property-grammar` (HELD-NEW, new, section 14), with the name in
`detail.name`. Part 04 widens the property grammar for a form's writes (its N2 and N7) and names no
row for a column's property, so the wider class is this part's to state: holding it is step 7's
(`case-list-and-detail`), with the same grammar a write takes.

By `format`:

| `format` | Nova column | Entry |
|---|---|---|
| `plain`, property no select question writes | `{ kind: "plain", field, header }` | `1-plain-over-a-property-that-is-not-a-select-with-options` |
| `plain` over a property select questions write | finding: Nova's plain column there shows the choice's label | `1p-plain-over-a-property-select-questions-write` |
| `date` with a `date_format` `COMMCARE_DATE_PATTERN_REGEX` admits | `{ kind: "date", field, header, pattern }` | `2-date-date-format-d-m-y-d-m-y-m-d-y-m-d-y-b-d-y`; else `2p-date-any-other-date-format` |
| `phone` | `{ kind: "phone", ... }` | `4-phone` |
| `enum`, every key one word with none of `& < > " '` | `{ kind: "id-mapping", mapping: [{ value: key, label }] }`, each label's text by language under the role `case-list-mapping-label` | `5-enum-id-mapping`; `5pp-enum-key-that-is-empty-or-holds-whitespace`, `5p-enum-key-containing`, `an-enum-enum-image-conditional-enum-or-translatable-enum-column` for a duplicate key |
| `enum-image`, every key the tree of `selected(., '<value>')` (each key is first passed through part 08's `dotInterpolate(key, <the column's property path>)`, as HQ's `MappingItem.key_as_condition` does, and Nova's emitted key through the same call, before the two trees are compared) | `{ kind: "image-map", mapping: [{ value, assetId }] }`, each asset through part 06's `readMediaMap` as `readNavMedia` calls it (2.2), slot `image_map_mapping` | `19p-enum-image-whose-keys-are-conditions-contain-any-of-each-a`; `19-enum-image-whose-keys-are-plain-values`, `19pp-enum-image-whose-keys-are-conditions-of-any-other-form-dot` |
| `markdown` with `useXpathExpression`, the expression the tree of `columns.ts::linkColumnDisplayXpath(field, text)` for some property and text (R3 over the one shape: the reader reads `text` and the property from the tree, then re-emits) | `{ kind: "link", field, header, linkText }` | `10-markdown-any-property-or-expression` |
| any other `markdown` | finding | part 04's N12, `10-markdown-outside-the-link-shape` |
| `translatable-enum` with `useXpathExpression`, the expression Nova's label projection of a select property (`hqExpressionField` of a plain column over it) and the `enum` its choices | `{ kind: "plain", field, header }`, the property's choices checked against the catalog's (section 7) | `21-translatable-enum-authored` |
| the same, the expression `columns.ts::intervalColumnDisplayXpath` for some field, threshold, unit and display, one `enum` entry | `{ kind: "interval", field, header, threshold, unit, display, text }`, `text` by language under the role `case-list-interval-text` | `21-translatable-enum-authored` |
| any other `translatable-enum` | finding | part 04's N13, `21-translatable-enum-outside-nova-s-two-projections`; `translatable-enum-on-a-column-that-is-not-a-calculated-property-over-a-property`, `translatable-enum-on-a-column-that-is-not-a-calculated-property-relation-offers`, `translatable-enum-on-a-column-that-is-not-a-calculated-property-relation-does`; `21p-translatable-enum-key-outside-a-za-z0-9` |
| `plain` with `useXpathExpression`, the field reading one case attribute | `{ kind: "plain", field: "case_id" \| "owner_id" \| "status", header }` | `usexpathexpression-field-reading-one-case-attribute` |
| `plain` with `useXpathExpression` otherwise | `{ kind: "calculated", header, expression }`, pending (slot `case_list_column_expression`) | part 08 claims `usexpathexpression-field-xpath-lifting-into-valueexpression` or its HELD-NEW pair; `calculated-column-reading-results-search-input-instances-in-a` |
| `invisible` on the short detail, outside a custom tile | the column of the joined long column where one joins (11.3), else `{ kind: "plain", field, header }`; `visibleInList: false` | `7-invisible-search-only-on-the-case-list-outside-a-custom-tile` |
| `invisible` on the long detail, outside a nodeset tab | a plain column shown on the detail | `7p-invisible-on-the-case-detail-outside-a-data-tab-over-a` |
| a geo format on the long detail beside its dependencies | a plain column shown on the detail | `a-geo-column-on-the-case-detail-beside-the-column-it-depends-on` |
| a slug HQ registers no format for | a plain column | `unregistered-format-slug-incl-nova-s-own-calculate` |
| `late-flag` | finding (below) | `6-late-flag-late-flag-1` (re-cut HELD-NEW, section 14), `6p-late-flag-late-flag-0` |
| `time-ago` | finding | `3-time-ago-time-ago-interval-the-7-menu-values-years-months`, `3p-time-ago-other-interval` |
| `address`, `distance`, the four geo formats on the list, `clickable-icon`, `conditional-enum`, `invisible` or `address` in a custom tile, `invisible` in a nodeset tab | finding | `8-address`, `9-distance`, `11-geo-boundary`, `12-geo-boundary-color-on-the-case-list-only-needs-an-address`, `13-geo-points-on-the-case-list-only`, `14-geo-points-colors-on-the-case-list-only-needs-an-address`, `16-clickable-icon-endpoint-action-id-on-the-case-list`, `20-conditional-enum`, `invisible-or-address-column-in-a-custom-tile`, `7pp-invisible-inside-a-data-tab-over-a-nodeset` |
| `address-popup`, `picture`, `audio`, `graph`, `image`, `filter` where it changes the build, a geo column without its dependency, the malformed `clickable-icon` shapes, several of one format | finding | their REFUSED rows (`15-address-popup`, `17-picture`, `18-audio`, `22-graph`, `23-image-cc-case-image`, `24p-filter-otherwise`, `a-geo-column-without-the-column-it-depends-on`, `16p-clickable-icon-with-an-empty-endpoint-action-id-on-the-case`, `16pp-clickable-icon-on-the-case-detail-whatever-its-endpoint`, `more-than-one-address-column-or-more-than-one-image-or-geo`, `more-than-one-image-or-geo-column-of-the-same-format-in-a-detail`; and the HELD-NEW `more-than-one-address-column-in-a-detail-of-an-advanced-module`) |
| `filter` where it changes no build | nothing | `24-filter-other-than-the-first-column-of-a-short-detail-with-no` (INERT) |

**Why `late-flag` waits.** HQ's `LateFlag` (`detail_screen.py`) writes
`if(x = '', '*', if(today() - date(x) > N, '*', ''))` at width 11% with an empty list header. Nova's
interval column in its `flag` display writes the same expression as a calculated `translatable-enum`
with its own header (`columns.ts::intervalFlagXpath`). Reading one as the other would put a header on
the list at the first publish, and Nova's column has one header for both screens. Holding it exactly
needs a column that shows no header on the list, which is step 7's group `case-list-and-detail`. Nova's
own interval columns read back by the `translatable-enum` row above, so no Nova app is affected.

**Every column's other keys.** `header{lang}` reads `header` and its translations, role
`case-list-header` (`header`); a column hidden from both screens keeps its stored header under every
language, as `projectColumnForShortDetail` writes it. `enum[].alt_text` blank is
`enum-mappingitem-alt-text-lang`; with text, part 04's N11. `case_tile_field` blank or off a template
tile is part 01's `case-tile-field-blank-or-off-a-template-tile` (INERT); with text on a template tile,
`case-tile-field-template-slot-on-icon-text-grid`. `graph_configuration: null` or on another format,
`filter_xpath`, `advanced`, and the bookkeeping keys (`hasAutocomplete`, `calc_xpath`, `isTab`,
`hasNodeset`, `nodeset`, `relevant`, `time_ago_interval` and `late_flag` on a column of another format,
`date_format` on a column that is no date) are their INERT rows (`graph-configuration-null`,
`graph-configuration-non-empty-on-any-other-column`, `filter-xpath`, `advanced`,
`ui-bookkeeping-keys-hasautocomplete-calc-xpath-istab-hasnodeset`). `optimization` is
`optimization-cache-lazy-load-cache-and-lazy-load`. `endpoint_action_id` is its three rows
(`enum-image-column-carrying-an-endpoint-action-id-on-the-case`,
`a-column-of-a-format-other-than-clickable-icon-or-enum-image`
INERT; `a-case-list-column-of-any-format-carrying-an-endpoint-action-id` REFUSED).

### 11.3 One set of columns from two details

A Nova column is shown on the list, on the detail, or on both, with one kind, one property and one
header. `details.ts::joinDetailColumns(short, long)`:

1. Each short column joins the first long column not yet joined whose proposal is equal: the same kind,
   the same `field` or expression tree, the same header in every language, the same kind-specific
   slots. An `invisible` short column joins the first unjoined long column over the same `field`,
   and takes that column's proposal.
2. A joined pair is one column, `visibleInDetail` absent, `visibleInList: false` only for the
   `invisible` case.
3. A short column with no partner has `visibleInDetail: false`.
4. A long column with no partner is not on the list: `visibleInList: false` and `notOnList: true`
   (11.6).
5. `listColumnOrder` is the short detail's order, then the columns of rule 4 in the long detail's
   order. `detailColumnOrder` is the long detail's order, then the columns of rule 3.
6. Each column's `uuid` is minted from `externalKey.caseListColumn(moduleUniqueId, kind, field, n)`:
   `field` is the column's case property and `""` for a calculated column, and `n` is the 0-based
   ordinal among the menu's columns of equal `(kind, field)`, in `listColumnOrder` (part 10 section
   2.2).

**A column the detail alone shows** is read exactly. A long column with no partner is in the
source's long detail and not in its short detail, and that is what Nova writes for a column that
is not on the list (11.6): no field of the short detail, in a list of either layout, so no device
matches it when a worker filters the list, as none does in the source. In a tile list one such
column can still carry the list's order, by a sort row with no stored column; 11.4 reads that row
and puts the column back on the list, hidden.

(R2), in `settleCaseLists`: `hqJson/caseList.ts::projectCaseListForHq(module, draft, assets,
lookupNaming)`, with 2.4's `assets` and `lookupNaming`, gives the long detail's columns equal to the
stored ones, and the short detail's equal to the stored ones followed by exactly 11.4's hidden sort
columns, each compared after the INERT claims of 11.2, with `field` and
`enum` keys as trees where they are expressions. This one call per menu is the (R2) of 11.4, 11.5 and
section 12 too: its result holds the columns, the `sort_elements`, the filter, the tile keys and the
`search_config`, and the functions that build each (`projectSortElements`,
`applyTileLayoutToShortDetail`, `projectCaseListFilter`, `buildSearchConfigDocument`) are private to
that file and stay so.

### 11.4 Order

`caseList/order.ts::readSortElements(ctx, module, proposals)` inverts `caseListOrder.ts::caseListOrderPlan`
rule by rule:

| `sort_elements[i]` | Reads into | Entry |
|---|---|---|
| none, and the short detail's first column is shown (or the detail is empty) | no column holds `sort` | `no-sort-elements` |
| none, and the short detail's first column is an `invisible` column | that column takes `sort: { direction: "asc", priority: 0 }`: HQ's build sorts an unsorted list by its column 0 whatever its format (`suite_xml/sections/details.py::get_default_sort_elements`), and Nova's implicit rule is on the first shown field (`caseListOrder.ts`, rule 7), so only an authored rule on the hidden column keeps the order. Nova then writes the one element HQ's default builds, a source rewrite the register holds (13.3) | `no-sort-elements` |
| `field` a property name equal to the join text of a short column | `sort` on the first such column in `listColumnOrder` (rule 5) | `field-naming-a-displayed-column` |
| in a tile list, `field` a property name no short column joins and that a column 11.3's rule 4 made from the long detail reads | that column is on the list, hidden: `visibleInList: false` with the `sort`, and no `notOnList`. It is how Nova writes a tile list's hidden sorted column, as a sort row with no stored column (`caseListOrder.ts`, rule 4, exception iii), so Nova's own tile lists read back as they were | `field-naming-a-property-not-displayed-hq-appends-a-hidden-column` |
| any other `field` that is a property name no short column joins | a new column `{ kind: "plain", field, header: "" , visibleInList: false, visibleInDetail: false, sort }`, last in `listColumnOrder` (rule 5's carrier, stored). A column 11.3's rule 4 made over the same property stays off the list beside it: a column that is not on the list takes no rule (11.6) | `field-naming-a-property-not-displayed-hq-appends-a-hidden-column` |
| two elements whose `field` is one text | the later is read by its own rows, at its place among the elements HQ keeps; the earlier is claimed and dropped. `util.py::get_sort_and_sort_only_columns` keys the elements by `field`, a later one replacing an earlier with the later's order, and it is the one function HQ's build (`suite_xml/sections/details.py`) and its app strings (`app_strings.py`) take a detail's sort elements through. Nova writes the list without the earlier element (13.3, `list-settings-respelled`) | `sort-elements-sharing-a-join-text` (INERT, new, section 14) for the earlier |
| `field` `_cc_calculated_N` where column `N` of the short detail is an expression column | `sort` on the first field whose text is that column's (rule 4) | `field-cc-calculated-n`; else `field-cc-calculated-n-naming-a-missing-or-non-calculated-column` |
| position `i` | `priority: i` | `sort-order-across-elements` |
| `direction` `ascending` or `descending` | `direction` | `direction` |
| `blanks` `first` or `last` | `columnSort(direction, priority, blanks)` (part 03: stored only where it is not the direction's own) | `blanks-first-last` (HELD, part 03 section 7) |
| `blanks: ""` or absent | no `blanks` | `blanks` |
| `type` `plain`, `date` or `string` | nothing: Nova writes its derived word | `type-plain-date-int-double-equal-to-the-type-nova-derives`, `type-string-not-a-menu-value` |
| `type` `int` or `double` equal to the comparator the plan derives, with section 7's declaration where no writer types the property | nothing | the same |
| `type` `int` or `double` the plan does not derive | finding | `type-int-or-double-differing-from-the-derived-type-on-a-column` |
| `type` `distance`, `index` | finding | `type-distance`, `type-index-cache-and-index-order-2` |
| `display` `{}` or blank in every language | nothing | `display` |
| `display` with text, on a sort joined to a displayed column | nothing | `display-lang-on-a-sort-joined-to-a-displayed-column` (INERT) |
| `display` with text on a sort-only element or an `invisible` column | finding | `display-lang-sort-by-label-on-a-sort-only-element`, `display-lang-on-a-sort-joined-to-an-invisible-column` |
| `sort_calculation` blank, equal to the joined calculated column, or beside a field on a format with its own sort | nothing | `sort-calculation-equal-to-the-referenced-calculated-column`, `field-and-a-differing-sort-calculation-on-a-column-whose-format` |
| `sort_calculation` authored | finding | `sort-calculation-authored-calculation-row-field`, `field-and-a-differing-sort-calculation-on-any-other-column` |

(R2), in `settleCaseLists`: the `sort_elements` of `projectCaseListForHq`'s short detail (11.3's one
call) equal the stored list in `field`, `direction` and `blanks` (a stored `""` equal to the
direction's own), element by element, after the earlier of two elements with one `field` is dropped
and, for the second row of the table, with the one element Nova writes where the source held none.
A sort element over a date-and-time property reads by these rows like any other and records
nothing: part 03 fixes that order in the text a phone writes for the value, and changes no sort
element, no column and no rule of the plan (03-questions-and-text.md, section 7.1).

Rule 7 is why that second row exists. With no authored rule the plan puts its implicit rule on the
first shown field and writes it as an element wherever a hidden field comes before it. A reading's
hidden columns are not all last: the carriers of this section are, but an `invisible` column of the
source keeps its place in the short detail (11.3, rule 5), and it can be column 0. Left with no
rule, such a list would be written with an element on its first shown column, and would sort by
another column than HQ's build sorts it by.

One shape the plan cannot write back is left to the gate: a sort that would land on a tile list's
hidden calculated column or hidden `case_id` column (`CASE_TILE_HIDDEN_CALCULATED_SORT`). It cannot
come from a source column, since an `invisible` column in a custom tile and an unplaced one are
findings of their own (11.2, 11.5); it can come only from a sort-only element over `case_id` on a tile
list (`caseListOrder.ts`, rule 4: the bare `case_id` reads a child element no case has). No row names
it, and it is `unrecognized` (13.2).

### 11.5 Tiles

`caseList/tile.ts::readTile(ctx, module, short, proposals)`:

| Key | Reads into | Entry |
|---|---|---|
| `case_tile_template: "custom"` on the short detail | `tile: {}`, and each short column's cell: `tile: { x: grid_x, y: grid_y, width, height, horizontalAlign, verticalAlign, fontSize, showBorder?, showShading? }` | `detail-case-tile-template-custom`, `grid-x-grid-y-width-height-custom-tile`, `horizontal-align-vertical-align`, `font-size`, `show-border-show-shading` |
| a `null` cell key on a placed custom tile column | finding | `custom-tile-column-with-grid-null-unplaced`, `horizontal-align-null-on-a-placed-custom-tile-column`, `custom-tile-font-size-null` |
| `case_tile_template` `null` or `""` | no tile; the nine cell keys on every column are claimed and dropped | part 01's `tile-cell-keys-on-a-list-that-is-not-a-tile` (INERT) |
| `icon_text_grid` | finding | `detail-case-tile-template-icon-text-grid` |
| `person_simple`, any other template | finding | `detail-case-tile-template-person-simple`, `detail-case-tile-template-other-than-custom-person-simple-or` |
| a tile on the long detail | finding | `long-detail-custom-tile-case-detail-laid-out-as-a-tile`, `long-detail-non-custom-tile` |
| `persist_tile_on_forms: true` | `tile.persistOnForms: true` | `detail-persist-tile-on-forms` |
| `case_tile_group { index_identifier, header_rows }`, non-blank | `tile.grouping: { identifier, headerRows }` | `detail-case-tile-group-index-identifier-header-rows` |

HQ's alignment words map through `modules.ts::TILE_HORIZONTAL_ALIGNS`, `TILE_VERTICAL_ALIGNS` and
`TILE_FONT_SIZES` by the table the projection writes them with (`TILE_VERTICAL_ALIGN_WIRE` among it).
Those are every word HQ's Case List page offers
(`static/app_manager/js/details/bootstrap5/column.js`: `horizontalAlignOptions` `left`, `center`,
`right`; `verticalAlignOptions` `start`, `center`, `end`; `fontSizeOptions` `small`, `medium`,
`large`). The three keys are free strings in HQ's model, so a hand-written source can hold another
word; no page writes one and no entry names one, and it is `unrecognized` (13.2). A grouping
identifier outside `XML_ELEMENT_NAME_PATTERN` (an index name with a hyphen, which part 04 leaves
outside Nova's grammar and hands to the part that reads it) is the finding
`case-tile-group-identifier-outside-an-xml-element-name` (HELD-NEW, new, section 14), with the
identifier in `detail.name`. Neither the cells of a list whose tile is off nor the cell of a
column hidden from Results in a tile list is read, since neither is written
(`modules.ts::tileCellFor` gives no cell in either case). So a Nova-born document that keeps such a
cell reads back without it, and the reader returns the one without: a row of part 06's
`assemble.ts::READER_CANONICAL_CHOICES` under the id `dormant-tile-cells` (the id part 01 names,
its section 3.2), with its `kind` `one-wire` and its `apply`. `apply` removes tile cells from a
list whose layout is no tile, and from each column hidden from Results in a tile list. (R2): the
tile keys of `projectCaseListForHq`'s short detail (11.3's one call) equal the stored cell keys.

### 11.6 A column that is not on the list

CommCare HQ's case detail routinely shows more than its list does: a long detail column the short
detail does not hold. Nova held two list states for a column, shown and hidden, and wrote a hidden
one into the short detail as an `invisible` field (`caseListOrder.ts`, rule 1), which a device
matches when a worker filters the list. So no document could say what nearly every HQ app says, a
column the detail shows and the list does not carry. This section gives a column that third state,
for every Nova app, and the reader reads into it (11.3, rule 4).

**The slot.** `lib/domain/modules.ts::columnCommonSlots` gains one optional literal, and
`ColumnCommonSlots` and `withCommonSlots` carry it as they carry the others:

```ts
/** Present when the column is no field of the case list at all: the case's detail alone holds
 *  it. The list does not show it, match it in its filter or sort by it. A column that holds it
 *  holds `visibleInList: false` and no `sort` (`CASE_LIST_COLUMN_NOT_ON_LIST_INVALID`). */
notOnList: z.literal(true).optional(),
```

```ts
/** Whether the column is a field of the list: shown, or hidden and still carried. */
export function columnOnList(column: Pick<Column, "notOnList">): boolean;
```

| List state | Stored | On a list with no tile | On a tile list |
|---|---|---|---|
| shown | `visibleInList` absent or `true` | a field of the short detail | a cell of the tile |
| hidden | `visibleInList: false` | a field at width 0, which the list's filter matches | no field; an order rule on it rides as a sort row with no stored column |
| not on the list | `visibleInList: false`, `notOnList: true` | no field | no field |

The literal stands beside `visibleInList: false` and does not replace it, as
`Module.hiddenFromMenu` stands beside a display condition. Every reader that asks whether Results
shows a column (`tileCellFor`, `caseListColumnTextShows`, the workspace's and the tools'
projections) asks `visibleInList`, and is right about the new state with no change. Both of the
config's sequences still name the column (`lib/domain/CLAUDE.md`: both name every column from
birth), so putting it back on the list returns it to the place it held. A column that is not on
the list and is hidden from Details too is on no screen and no wire; it is valid, as a column
hidden from both screens is.

**The gate.** `lib/commcare/validator/rules/case-list/columnNotOnList.ts`, soundness, located at
the column, code `CASE_LIST_COLUMN_NOT_ON_LIST_INVALID`, with `details.reason`:

| Reason | When | Why |
|---|---|---|
| `shown` | `notOnList` beside a `visibleInList` that is not `false` | one state has one stored form, and every reader of `visibleInList` stays right |
| `sorted` | `notOnList` beside a `sort` | an order rule on a column the list does not hold would reach the wire as a carrier field, which the list's filter matches (`caseListOrder.ts`, rule 5), so the column would be on the list after all |

The rule is a member of `lib/commcare/validator/rules/module.ts::CASE_LIST_ORDER_RULES`, which
`MODULE_RULES` spreads, so the gate runs it and so does the one function Default order's Add menu
asks about a choice (`lib/doc/commitVerdicts.ts::caseListOrderChoiceRefusal` runs exactly that
list). The code is declared in `lib/commcare/validator/errors.ts` and classed `soundness` in
`lib/commcare/validator/gate.ts::VALIDITY_CLASS_BY_CODE`, which makes it a
`UserFacingValidationCode`: `lib/doc/userFacingErrors.ts::USER_MESSAGE_BY_CODE` is a record over
that type, so it holds the code's builder line or `tsc` fails. "Copy" holds the gate's two
messages and the two builder lines. A tile cell on such a column is dormant, as on any
column hidden from Results, and is no finding.

**The plan and the emitters.** `caseListOrder.ts::caseListOrderPlan` is the one statement of the
short detail's fields, and its rules 1 and 4 change: a column for which `columnOnList` is false is
no field in a list of either layout, and no rule is read from it. The plan's three readers (the HQ
JSON projection, the local suite and Preview through the case store) walk its fields and decide
nothing of their own, so none of them changes: the HQ JSON's short detail holds no column for it,
the local suite's short detail no `<field>`, and each long detail holds it as today, by
`visibleInDetail`. `modules.ts::caseListColumnRuns` answers for the new state: a column that is
not on the list runs where Details shows it, and nowhere otherwise. Translations and media follow
`caseListColumnTextShows`, unchanged.

**Preview.** Preview's list filter and its order read the plan's fields (part 01, section 6.4), so
a column that is not on the list is matched by no filter text and orders nothing, and the case's
Details shows it. One reader of Preview's asks the list state itself: the rule that decides whether
a running list evaluates `here()` (`lib/preview/engine/viewerLocation.ts::columnsReadHere`) asks
`columnOnList`, since a calculated column that is not on the list is no field the list evaluates,
as `caseListColumnRuns` says for the compiler's walks.

**The builder.** The workspace keeps one gesture for each fact. **Hide from Results** still
writes `visibleInList: false` alone, so a hidden field is searched as before. A field hidden from
Results, in a list with no tile, shows one switch in its inspector, above **Hide from Details**:
**List search matches this**. On is the hidden state; off writes `notOnList: true`
(`workspaceProjection.ts::takeColumnOffList`), and on again removes it (`keepColumnOnList`). While
Default order uses the field the switch is on and disabled, with its reason. In a tile list the
switch is not shown: a tile's search matches a hidden field only through its sort row, which the
tile's own note already says, and a field a reading brought in off the list stays off it if the
tile is later turned off. Showing a field on Results from **Add information** clears both slots
in one write (`showColumnOnDisplay`).

Default order's Add menu divides by the layout, because a field that is off the list can come
back onto it in only one way in each:

- *In a list with no tile* the menu lists the field disabled. The column it puts to
  `caseListOrderChoiceRefusal` is the field with the rule it would take and its `notOnList`, the
  rule's `sorted` reason refuses it, and the menu shows the code's builder line ("Copy"), whose
  next step is the switch the field's inspector holds.
- *In a tile list* the menu offers the field, and choosing it writes the rule and removes
  `notOnList` in the same write: the column the menu puts to the refusal, and then commits, is
  the field hidden from Results with its rule and no `notOnList`. That is a tile list's hidden
  sorted column, the state 11.4's tile row reads, and there is no switch in a tile list to send a
  person to. `content/docs/case-workspace.mdx`'s "Default order can still sort by a hidden item"
  stays true of every hidden item.

Each write is the column's granular update, as a visibility change is today, so no mutation kind
is added: `updateColumn`'s `visibilityPatch` on Results carries the column's whole list state, an
optional `notOnList` beside `visible: false` (`true` takes it off the list, `false` keeps it on,
absent keeps what it holds), and `visible: true` clears both slots. `notOnList` is no part of a
column's content payload, so a peer's relabel never writes over a list state.

**The Solutions Architect and MCP.** Each column arm of `addCaseListColumns` and
`updateCaseListColumn` (`lib/agent/tools/case-list-config/shared.ts::columnInputSlots`) gains
`notOnList: z.literal(true).optional()`, a plain optional like the slots beside it
(`visibleInList`, `tile`), described in "Copy". In either tool `true` writes `visibleInList: false`
with it. `updateCaseListColumn` replaces the whole column (its header: "The replacement is a full
column body"), so a replacement that leaves `notOnList` out puts the column back on the list, and
the input needs no `null`. A call to either tool that sends `notOnList: true` beside
`visibleInList: true` is refused before staging with the sentence of "Copy", and one beside a
`sort` with the gate's. `configureCaseList` and `updateModule`'s `case_list_columns` take the same
column arms, so they gain the input and refuse the two pairings the same way
(`shared.ts::columnListStateRefusal`). The reads say the state. `lib/agent/summarizeBlueprint.ts` ends the
column's line under `details:` with `(not on the list)`, and lists a column that is on no screen
under `saved_off_screen` only where the list still carries it, so that heading's "the list's
search matches these" stays true; a column on no screen and not on the list is listed under
`saved_off_the_list:`. `getModule` returns `case_list_config` as stored, so it carries `notOnList`
with no change of its own. The authoring guide's case list paragraph gains one sentence saying
when to use the state: for information a worker reads on a case's details and does not look cases
up by. The two tools' served inputs and the guide change, so this is one of the changes the step's
one `MODEL_CONTEXT_VERSION` move carries. Both tools are entries of the billed schema check
already (`scripts/test-schema.ts`); each entry's prompt gains a column that sends
`notOnList: true`, so the check proves the provider accepts the new input.

**One wire, two documents.** In a tile list a column hidden from Results with no order rule is no
field, with or without `notOnList`, so two documents print one source. The reader returns the one
that holds `notOnList` (11.3), since that is the one that stays true if the tile is turned off: a
row of part 06's `assemble.ts::READER_CANONICAL_CHOICES` under the id
`unsorted-hidden-tile-columns-are-off-the-list`, `kind` `one-wire`. `apply` sets `notOnList: true`
on each column of a tile list that is hidden from Results, shown on Details and holds no order
rule.

**What a stored app sees.** Nothing: no stored column holds the slot, so no document, export or
App Test journey reads differently, and no migration runs.

---

## 12. Search

`search/index.ts` reads `search_config` (`models/case_search.py::CaseSearch`, `CaseSearchProperty`,
`DefaultCaseSearchProperty`) of every menu with a case type. Area `case-search`. `readSearches`
reads the workflow (12.1), the Search fields (12.2), the first table of 12.3 and the settings
(12.4) in pass 1. `settleSearches` runs the classification of 12.3 (`search/rows.ts`) and every
"in `settleSearches`" of this section in pass 2, over part 08's `readSearchRowConjuncts` and
`matchSearchRows` (`expressions/searchRows.ts`). A Search field's arm is decided in
`settleSearches` (12.2), so pass 1 writes each field at a proposal that keeps the provisional
document whole: `{ kind: "simple", property: name }` for a prompt without `exclude` and
`{ kind: "advanced", predicate: pendingPlaceholder("condition") }` for one with it.

### 12.1 Whether a menu searches, and its workflow

`search/workflow.ts::readSearchWorkflow(ctx: ReadContext, module: DraftModule): void`. A menu offers
search exactly where `properties` or `default_properties` is not empty
(`util.py::module_offers_search`). Every HQ menu stores a `search_config` with the model's defaults;
where the menu offers none, `readSearchWorkflow` claims the whole block
`the-generated-search-round-trip-remote-request-query-results` and reads nothing, except
`blacklisted_owner_ids_expression` (12.4).

| `auto_launch`, `default_search`, `inline_search` | `caseSearchConfig` | Entry |
|---|---|---|
| true, false, false | `{}`: Search first is the absent `workflow` | `workflow-search-first-auto-launch-true-default-search-false` |
| true, true, false | `workflow: "skipToResults"` | `workflow-skip-to-default-results-auto-launch-true-default-search` |
| true, false, true | `formsReadSearch: true` | `inline-search-true-auto-launch-true-on-a-module-with-visible`, `inline-search-true-auto-launch-true-on-a-module-without-visible` |
| true, true, true | `workflow: "skipToResults"`, `formsReadSearch: true` | `inline-search-default-search-on-a-module-with-visible-inputs`, `inline-search-default-search-on-a-module-without-visible-inputs` |
| false, false, false, the app's `cloudcare_enabled` false | `workflow: "listFirst"` | `auto-launch-false-in-an-app-with-cloudcare-enabled-false` |
| false, true, any, the app's `cloudcare_enabled` false | finding: HQ writes `default_search` into the search's query whatever `auto_launch` says (`remote_requests.py::RemoteRequestsHelper.build_remote_request_queries`), so this is a case list first whose Search action goes straight to its results, and Nova's `listFirst` writes `default_search: false` (`searchWireShape.ts::searchWireShape`) | `case-search/list-first-with-a-search-that-skips-to-results` (HELD-NEW, new, section 14) |
| false, the app's `cloudcare_enabled` true | finding | `workflow-legacy-classic-auto-launch-false-in-an-app-with` |
| false with `inline_search: true` | `inline_search` is dropped; the row above for `auto_launch` | `inline-search-true-with-auto-launch-false` (INERT) |

(R1): `searchWireShape.ts::searchWireShape(config)` gives back the three booleans. A reading that holds
`listFirst` makes the app Android only, since the gate refuses `listFirst` where Web Apps is declared
(`list-first-where-web-apps-is-declared`). No reader module chooses the declaration: part 06's
assembly calls `lib/doc/platformDeclaration.ts::planDeclarationChoices` over the assembled document
(06-the-reader-forms.md, section 16.3), where a `listFirst` menu is a use Web Apps cannot run,
so every choice the reading offers is Android only, and part 12 offers the draft's choices and
proposes none of its own.
A search on a menu that shows its forms above is `search-on-a-put-in-root-module` (8.4). `inline_search`
on an advanced menu is 4.1's blocker.

### 12.2 Search fields

`search/prompts.ts::readSearchPrompts(ctx, module)`. Each entry of `properties[]`, in order
(`prompt-order`), is one `searchInputs` entry; its `uuid` is minted from
`externalKey.searchInput(moduleUniqueId, name)`.

| Key | Reads into | Entry |
|---|---|---|
| `name`, inside `SEARCH_INPUT_NAME_PATTERN` (part 04) | `name` | `name-prompt-key-case-property`; outside it, part 04's N3; a reserved request key, `a-prompt-that-reaches-hq-as-its-own-key-named-as-a-config-keys`; shared with a default filter, `a-default-filter-and-a-search-property-sharing-one-name` |
| `label{lang}`, `hint{lang}` | `label`, `hint`, roles `search-input-label`, `search-input-hint` | `label-lang`, `hint-lang` |
| no `input_`, no `appearance` | `type: "text"` | `text-prompt-no-input` |
| `appearance: "barcode_scan"` | `type: "barcode"` | `appearance-barcode-scan` |
| `input_: "date"` | `type: "date"` | `input-date` (re-cut, section 14: the class Nova writes) |
| `input_: "daterange"` | `type: "date-range"`, `mode: { kind: "range" }` | `input-daterange` |
| `input_: "select1"` or `"select"` with an `itemset` over `item-list:<tag>` | `type: "select"` or `"multi-select"`, `options`: the table by tag from the bound lookup catalog, `valueColumnId`, `labelColumnId` and `sortColumnId` by field name, the nodeset's filter pending (slot `search_input_options`) | `input-select1-lookup-itemset`, `input-select-multi-lookup-itemset`, `itemset-instance-id-item-list-tag-nodeset-label-value-over`, `itemset-sort-over-a-lookup-field`; part 08 claims the filter's pair |
| an itemset over reports, another scheme, attributes or field properties; `checkbox`; `appearance: "address"` | finding | `input-select1-select-commcare-reports-itemset-mobile-ucr`, `itemset-scheme-other-than-item-list-commcare-reports`, `itemset-refs-to-item-attributes-attr-or-property-qualified`, `input-checkbox-itemset`, `appearance-address-geocoder-broadcast-emitted-input-address`, `appearance-address-with-required-or-validations` |
| any other `appearance` | nothing | `appearance-any-other-value` (INERT) |
| `default_value` | `default`, pending (slot `search_input_default`) | part 08 claims `default-value-lifting-into-valueexpression` or its pair; on a date range, part 04's N8 |
| `required { test, text }` | `required: { when?, message? }` (slot `search_input_required_when`, mode `no-case`; a `test` of `true()` is an absent `when`; a text equal to `SEARCH_INPUT_REQUIRED_DEFAULT_MESSAGE` in the first language and untranslated is an absent `message`), role `search-input-required-message` | `required-test-text` |
| `validations[0] { test, text }` | `validation: { rule, message }` (slot `search_input_validation_rule`, mode `no-dots`), role `search-input-validation-message`, after removing the runtime guard Nova conjoins (`xpathQuery.ts::buildRuntimeCsqlPromptValidations`), by (R3): with it, then without | `validations-0-test-text` |
| `validations[1:]`; `hidden` with `required` or `validations` | finding | `validations-1`, `hidden-together-with-required-or-validations` |
| `hidden: true`, `exclude: true`, a `default_value`, no itemset, input type or appearance | `{ kind: "hidden", name, value }` (slot `search_input_hidden_value`) | `hidden-exclude-with-a-default-value-on-a-prompt-with-no-itemset` |
| the three other hidden shapes | finding | `hidden-exclude-without-a-default-value-on-a-prompt-with-no`, `hidden-without-exclude-on-a-prompt-with-no-itemset-input-type-or`, `hidden-on-a-prompt-that-carries-an-itemset-input-type-or` |
| `allow_blank_value: true`, `receiver_expression`, `is_group`, `group_key` | finding | `allow-blank-value`, `receiver-expression`, `receiver-expression-on-a-prompt-whose-editor-appearance-is`, `is-group-group-key`, `groups-present-and-an-input-without-group-key` |

**Which arm a visible field takes** is decided with the conjuncts of 12.3, in `settleSearches`:

| The prompt | A conjunct derives it (12.3, kind C) | Arm | Entry |
|---|---|---|---|
| `exclude` false, type text, barcode, select or multi-select, `name` no attribute of the case node | no | `{ kind: "simple", property: name }`, no `mode`, no `via` | the type's row |
| `exclude` false, any type, `name` one of `case_id`, `owner_id`, `status`: the members of `standardCaseProperties.ts::CASE_NODE_ATTRIBUTE_PROPERTIES` a prompt can be named for (the fourth, `case_type`, is a request configuration key and already took the `name` row's `a-prompt-that-reaches-hq-as-its-own-key-named-as-a-config-keys`) | (any) | finding: Nova writes a field over one of them excluded, with its own `@<name>` clause (`simpleArmDerivation.ts::simpleArmNeedsXPathQueryEmission`: `emitCasePropertyWirePath(property) !== property`), so the bare prompt is no shape it writes back, and HQ's search does not read the three as that clause does: it filters `case_id` and `owner_id` by rules of their own and matches `status` as a case property (`case_search/utils.py::CaseSearchQueryBuilder._apply_filter`) | `case-search/prompt-named-for-a-case-attribute-hq-matches-itself` (HELD-NEW, new, section 14) |
| `exclude` false, type date range, `name` none of the three | no | `{ kind: "simple", property: name, mode: { kind: "range" } }` | `input-daterange` |
| `exclude` false, type date | (any) | finding: HQ's own matcher compares it | `case-search/date-prompt-matched-by-hq-s-own-rule` (new, section 14) |
| `exclude` true | yes | `{ kind: "simple", property, via?, mode? }` as the conjunct gives | `exclude`, the type's row |
| `exclude` true | no, and a conjunct takes it as its field (kind D, the first candidate) | `{ kind: "advanced", predicate }` | `exclude` |
| `exclude` true | no conjunct takes it as its field | `{ kind: "advanced", predicate: matchAll() }` (below) | `exclude` |
| `exclude` false | a conjunct reads it under its presence guard (12.3, kind D, the second candidate) | the arm the rows above give it, unchanged: the conjunct is a clause of the case list filter that waits for the field | the type's row |
| `exclude` false | a conjunct reads it outside its guard | finding: the conjunct has no Nova slot (12.3, kind E) | `case-search/xpath-query-row-reading-a-field-hq-also-matches` (new, section 14) |

A simple field's property must be a property of the catalog with a type its field type admits
(`SEARCH_INPUT_UNKNOWN_PROPERTY`, `SEARCH_INPUT_TYPE_PROPERTY_TYPE_MISMATCH`); section 7 notes the
property and, for a date field, declares its type. Where the app's own writers type the property as
something the field's type does not admit (a date range field over a property a text question saves),
HQ still offers the prompt and Nova's gate would refuse the field, so it is the finding
`case-search/search-field-over-a-property-of-another-type` (HELD-NEW, new, section 14), with the
field's name in `detail.name`.

A field named `owner_id` is held in the one shape Nova writes: `exclude: true` beside its derivation
row (12.3, kind C, whose clause reads `@owner_id`). It claims `a-search-key-named-owner-id`, which the
lane reads from the prompt's name whether or not it is excluded, and reads as a simple field over the
standard property. The same name without `exclude` is the second row of the table above.

**A visible field no filter reads.** A prompt with `exclude: true` that no `_xpath_query` row reads
comes in as `{ kind: "advanced", predicate: matchAll() }`, and the gate admits it. Read on `main`:
the stored shape holds it (`lib/domain/modules.ts::advancedScalarSearchInputSchema`,
`advancedDateRangeSearchInputSchema` and `advancedSelectSearchInputSchema` each hold
`predicate: conditionSchema`); the checker raises nothing for it
(`lib/domain/expression/typeChecker.ts::checkConditionNode` returns at once for `match-all`); and
of the validator rules that read an advanced field's predicate,
`rules/case-list/searchInputPredicateTypeCheck.ts` reports only what `checkExpression` reports,
`searchInputRefUsesWhenInputPresent.ts` reports only `input` leaves, of which the tree holds none,
`csqlPredicateRepresentability.ts` and the judge in `moduleWireSlots.ts` skip a predicate that
`lib/domain/expression/simplify.ts::effectiveFilterForEmission` folds to nothing, and
`matchModeWhitespaceInValue.ts` and `ancestorExistsCannotNestSubcase.ts` walk for match and
relation nodes the tree lacks. No rule under `rules/case-list/` or `rules/case-search/` asks that a
Search field be read by a filter. Two tests on `main` already hold the verdict:
`lib/doc/__tests__/searchInputFinalShape.test.ts` admits a menu whose advanced text field holds
`matchAll()` beside no case list filter, and
`lib/commcare/suite/case-search/__tests__/searchSession.test.ts` requires `runValidation` to return
no finding for such a field. On the way out, `xpathQuery.ts::composeXPathQueryClauses` passes each
advanced condition through `effectiveFilterForEmission`, which drops a `match-all`, so `expandDoc`
writes the prompt with `exclude: true` and no row, which is the source.

### 12.3 The rows of `_xpath_query`, and other default filters

`search/rows.ts`:

```ts
/** Where one top-level conjunct of one `_xpath_query` row was placed: the kinds of the table below. */
export type ConjunctPlacement =
	| { readonly kind: "A" }
	/** `clause` is the index of the list filter's top-level conjunct it restates. */
	| { readonly kind: "B"; readonly clause: number }
	/** `input` is the simple Search field it derives, with the arm's slots as read. */
	| { readonly kind: "C"; readonly input: Uuid; readonly property: string;
	    readonly via?: RelationPath; readonly mode?: SearchInputMode }
	/** `input` is the advanced field whose condition it is, for `from: "field"` alone. */
	| { readonly kind: "D"; readonly from: "field" | "filter"; readonly input?: Uuid }
	| { readonly kind: "F" }
	/** `entry` is the id of the entry the conjunct raised. */
	| { readonly kind: "E"; readonly entry: string };
export interface RowClassification {
	/** One record per top-level conjunct, by source row and then by its place in the row. */
	readonly conjuncts: readonly { readonly row: number; readonly predicate: Expression;
	    readonly placement: ConjunctPlacement }[];
	/** Indexes of the list filter's top-level conjuncts no kind B conjunct restates. */
	readonly unrestated: readonly number[];
}
export function classifySearchRows(ctx: ReadContext, module: DraftModule): RowClassification;
```

`RelationPath` is `lib/domain/expression/types.ts`'s and `SearchInputMode` is
`lib/domain/modules.ts`'s. `default_properties[]` first, by `property` (this first table is
`readSearches`'):

| `property` | Reads | Entry |
|---|---|---|
| `_xpath_query` | below | `several-xpath-query-rows` (HELD, re-cut in section 14); the content of each row by the CSQL rows part 08 claims |
| `include_closed` or `x_commcare_tag_module_name`, on a menu with no prompt whose every default filter is one of the two | Nova's search with no fields and no filter (its `'match-all()'` row) | `default-properties-entries-keyed-include-closed-or-x-commcare` |
| the same beside a prompt or another filter | nothing | `default-properties-entry-keyed-include-closed-beside-a-prompt-or`, `default-properties-entry-keyed-x-commcare-tag-module-name-beside` (INERT) |
| a plain property, an ancestor path, `owner_id`, `case_id`, a project or index key, `case_type`, a request configuration key, `commcare_blacklisted_owner_ids` | finding | its own row, by key: `default-properties-entry-keyed-by-a-plain-property-property-p`, `default-properties-entry-keyed-by-an-ancestor-path-parent-p`, `default-properties-entry-keyed-owner-id-case-id-commcare-project`, `default-properties-entry-keyed-commcare-sort-x-commcare-custom`, `a-commcare-sort-x-commcare-custom-related-case-property-or-case`, `an-x-commcare-custom-related-case-property-entry-together-with`, `default-properties-entry-keyed-case-type`, `default-properties-entry-keyed-x-commcare-endpoint-id`, `default-properties-entry-keyed-x-commcare-data-registry`, `default-properties-entry-keyed-commcare-blacklisted-owner-ids`, `that-entry-together-with-blacklisted-owner-ids-expression` |
| no `defaultValue` | finding | `default-properties-entry-with-no-defaultvalue-hq-stores-an-empty` |

HQ joins every `_xpath_query` value with `and` (`case_search/utils.py::_apply_filter`), so the unit
this part places is a top-level conjunct, never a whole row. In `settleSearches`, each row's
`defaultValue` is read with part 08's `readSearchRowConjuncts(text, context, env)` (its section 7.6),
`context` the case list filter's slot context for the menu and `env` `{ doc: ctx.doc, lookup }`.
It returns the row's top-level conjuncts, each a predicate over the menu's case type with Search field
reads bound (the on-device wrappers, the presence gate and the quote cascades unwrapped by
re-emission; that is part 08's). A row it cannot read answers with part 08's claim or its
`unrecognized`, raised at the row. So a row `c_list and c_field` gives two conjuncts and each goes
where it belongs. Each conjunct is then classified, first match:

| Kind | Test | Reads into |
|---|---|---|
| **A, Nova's zero-input row** | the menu has no prompt, the row is the only default filter, and its value is the literal `'match-all()'` (`xpathQuery.ts::ZERO_INPUT_SEARCH_SENTINEL`) | nothing: a search with no fields and no filter. Claims `match-all-match-none` |
| **B, a list filter clause restated** | the conjunct is deep-equal to one top-level conjunct of the bound `caseListConfig.filter` (after `effectiveFilterForEmission`), not yet matched | nothing: derived |
| **C, a simple field's derivation** | the conjunct is `whenInput(input(P), body)` for a prompt `P` with `exclude: true`, and for some candidate `(property, via, mode)` read from `body`, `simpleArmDerivation.ts::deriveSimpleArmPredicate(candidate, caseType, context)` is deep-equal to it. Candidates, (R3): `eq(prop, input)` gives mode `exact` (absent where it is the type's default, `DEFAULT_SEARCH_MODE_KIND`); a `match` gives its `fuzzy`, `starts-with`, `phonetic` or `fuzzy-date` mode; the whole-day interval gives a date field's `exact` with the property typed `date`, then `datetime` | the field's `property`, `via` (absent for the case itself), `mode` |
| **D, a condition that reads Search fields** | the conjunct reads at least one prompt and is no kind C derivation. Two Nova slots can hold it, and Nova writes it from either as a row alone, so it is (R3) over the two candidates below | the first candidate that applies and that `matchSearchRows` accepts |
| **F, a search's own filter, on a menu whose forms read the search** | the conjunct reads no prompt and restates no list clause; the menu reads `formsReadSearch` (12.1); and no advanced form of the app names the menu in a load's `details_module` | a clause of `caseListConfig.filter`, appended after the clauses the source's `Detail.filter` gave, in row order |
| **E, a search filter with no slot** | anything else | finding: `case-search/xpath-query-row-that-is-neither-a-list-filter-clause-nor-a-search-field-s` (new) for a conjunct that reads no prompt; `case-search/xpath-query-row-reading-a-field-hq-also-matches` (new) for one that reads a prompt and that neither candidate of kind D holds |

**The two candidates of kind D**, in this order:

1. **The field's own condition.** Applies where the first prompt the conjunct reads, in `properties`
   order, has `exclude: true` and is not a kind C field. The conjunct is that advanced field's
   `predicate`; a second conjunct landing on one field is conjoined with `and`, in row order.
2. **A clause of the case list filter that waits for its fields.** Applies where every Search field
   the conjunct reads, it reads under that field's presence guard (part 08's `when-input-present`),
   so the clause is all-true while the worker has answered none of them. The conjunct is appended to
   `caseListConfig.filter`. Nova's filter may hold such a clause, and the detail filter never shows
   it: `projectCaseListFilter` prints `effectiveFilterForEmission(substituteUnansweredSearchInputs(
   filter))`, which turns a clause that waits for a field into `match-all` and drops it, and
   `composeXPathQueryClauses` writes it as a row of its own. This is the slot that holds a condition
   on a field HQ's own matcher also compares (a bare prompt), and it is how Nova's own emission of
   such a filter reads back as the same filter.

Each candidate is judged over `withCandidate(ctx.doc, patch)` by part 08's
`matchSearchRows(candidate, moduleUuid, sourceRows, env)`: it must report the conjunct's row among
`matched`, from `"field"` for the first candidate and from `"filter"` for the second. Where both
do, the one under which every source row comes back in the stored order (`matched[i].source`
ascending) is kept, and the first where neither or both keep the order. That last rule is what makes
a re-read of Nova's own emission exact: Nova writes filter clauses first, then field conditions, then
derivations, so the order of its own rows says which slot each came from. A conjunct that reads a
prompt with no `exclude` outside that prompt's guard has neither slot: as a field's condition the
prompt would have to be excluded, and as a list clause Nova's detail filter would keep it with the
field read as `''`, which the source's `Detail.filter` does not hold. It is kind E.

**Why kinds F and E differ by the menu** ("Claims corrected"). On a menu whose forms read the search,
HQ applies `Detail.filter` to the search's results on the device
(`entries.py::EntriesHelper.get_datum_meta_module`), so the cases a worker can choose are the rows'
conjunction with the list filter whichever of the two a clause sits in. A conjunct moved into Nova's
one filter is still applied by the server as a row, and is now applied a second time on the device,
over results that already satisfy it. The one other reader of that menu's `Detail.filter` is an
advanced form's load that names the menu as `details_module`, which reads the device's own cases
under it (`entries.py::EntriesHelper.get_datum_meta_assertions_advanced`, its `get_manual_datum`); that is
why kind F asks that no load does. Where one does, or on a menu whose forms do not read the search,
the list filter narrows cases the search never returned, and the conjunct is kind E. The first
publish writes the joined clause into `case_details.short.filter`, which is the register row
`search-filter-joined-to-list` (13.3).

Then two checks close the classification:

- **Every list clause is restated, or may be.** Where the menu offers search and a top-level conjunct
  of the list filter has no kind B conjunct: on a menu whose forms read the search it is held, and
  Nova's emission adds its row. The device's list is the same conjunction before and after. What
  moves is where HQ's server stops: it answers at most 500 cases
  (`case_search/const.py::CASE_SEARCH_MAX_RESULTS`, taken in
  `case_search/utils.py::CaseSearchQueryBuilder._get_initial_search_es`; 1500 under a flag), and with
  the clause sent as a row that bound is applied to cases that pass the clause. So a search that
  matched more than the bound can show a worker cases it left out before, and never fewer. That is
  the register row `search-restates-list-filter` (13.3), which touches workers. On any other
  searching menu the finding is `case-search/case-list-filter-clause-the-search-does-not-restate`
  (new, section 14), with the filter's place: Nova would restate the clause
  (`xpathQuery.ts::composeXPathQueryClauses`), and the search would find fewer cases than it does
  today.
- **(R2).** `matchSearchRows(ctx.doc, moduleUuid, sourceRows, env)` over the settled menu must
  report `unmatched` empty, and `extra` empty but for the rows of the first check that Nova adds on
  a menu whose forms read the search. Nova's order is its own (filter clauses, advanced conditions,
  then derivations, each in field order); a stored order that differs is the register entry
  `search-filter-rows-recut` (part 01 names it; section 13.3), as is a stored row whose own text was
  an `and`, which Nova writes as one row for each conjunct.

On a menu whose forms read the search and that chooses a parent first, HQ's build adds its own
`ancestor-exists` row at build time; it is not in the source, and
`menus-and-case-lists/inline-search-in-a-parent-select-module-hq-adds-xpath-query` is claimed by the
workflow row with nothing read.

### 12.4 Settings

| Key | Reads into | Entry |
|---|---|---|
| `title_label{lang}` with text in every language the app has | `searchScreenTitle`, role `search-screen-title`; absent where it is "Search" in the first language and untranslated (`DEFAULT_CASE_SEARCH_TITLE`) | `title-label-lang-non-empty` (its `item` narrowed, section 14) |
| `title_label` `{}` or blank in every language the app has | `searchScreenTitle: NO_SEARCH_SCREEN_TITLE` (part 03 section 6) | `title-label-or-blank-hq-s-default` (HELD, part 03 section 6) |
| `title_label` blank in some languages and not others | finding | `title-label-blank-in-some-languages` (part 03 names it; section 14 adds it) |
| `description{lang}` with text | `searchScreenSubtitle`, role `search-screen-subtitle` | `description-lang-markdown` |
| `search_button_label` equal to `{ en: "Search All Cases" }` | nothing | `search-button-label-hq-default-en-search-all-cases` |
| any other `search_button_label` | finding | `search-button-label-any-other-value` |
| `search_button_display_condition` | `searchButtonDisplayCondition`, pending (slot `search_button_display_condition`) | part 08 claims `search-button-display-condition-lifting-into-predicate` or its pair |
| `blacklisted_owner_ids_expression`, with the list filter holding the owner clause `nodesetFilter.ts::emitExcludedOwnerFilterExpression` writes for it | `excludedOwnerIds`, pending (slot `excluded_owner_ids`, after removing `suite/wire.ts::normalizeSpace`'s wrapper by re-emission); the clause leaves the list filter, by (R2) over the filter of `projectCaseListForHq`'s short detail; on a menu that offers no search the config is `{ searchActionEnabled: false, excludedOwnerIds }` | `blacklisted-owner-ids-expression-lifting-into-valueexpression` |
| the same without that clause in the list filter | finding | `blacklisted-owner-ids-expression-without-that-clause`; part 08 claims `blacklisted-owner-ids-expression-outside-valueexpression` |
| `include_all_related_cases` equal to `searchNeedsSupportingCases(config, contexts)` over the draft | nothing: derived | `include-all-related-cases-implied-by-nova-relation-reads` |
| `include_all_related_cases` otherwise | finding | `include-all-related-cases-false-where-nova-s-relation-reads`, `include-all-related-cases-authored-without-relation-reads` |
| `instance_name` | finding, by its rows | `instance-name-without-casedb-ledgerdb-fixture-or-session-in-it`, `instance-name-containing-casedb-ledgerdb-fixture-or-session`, `a-module-whose-effective-results-instance-results-instance-name`; `an-effective-results-instance-equal-to-a-module-s-that-does-not` (INERT) |
| `additional_case_types`, `custom_related_case_property`, `custom_sort_properties`, `search_on_clear`, `case_search_endpoint_id`, the three registry keys | finding | their rows (`additional-case-types`, `custom-related-case-property`, `custom-sort-properties-property-name-sort-type-exact-date`, `search-on-clear`, `search-on-clear-with-the-case-list-s-auto-select-checked-whether`, `case-search-endpoint-id`, `data-registry-data-registry-workflow-additional-registry-cases`) |
| removed and unknown keys | nothing | `removed-keys-dynamic-search-additional-relevant-search-filter`, `any-other-unknown-casesearch-key` (INERT) |

The claim settings are HQ's own build (`<post>`, `<rewind>`, `redo_last`): nothing in the source holds
them, and `redo-last-on-the-search-action` and the round-trip row are claimed with nothing read. Cases
of type `commcare-case-claim` are case data, read nowhere. The project space's
`CaseSearchConfig.sync_cases_on_form_entry` is kept
(`domain-casesearchconfig-sync-cases-on-form-entry`); step 4's `form-entry-sync-off` question is asked
at the first publish, as for any app.

(R2) for the whole menu, in `settleSearches`: the `search_config` of `projectCaseListForHq`'s result
(11.3's one call) equals the stored one after the INERT claims, key by key, with `properties` compared
in order and each expression as a tree. `default_properties` is the one key not compared that way: its
`_xpath_query` rows are held by 12.3's `matchSearchRows`, which allows the reorder and the split that
section declares, and its other rows by 12.3's first table. One same-state rule applies here:
`title_label` and `description` are compared language by language over the app's languages, a
language the stored map lacks equal to `""`. HQ's model default for both is `{}`
(`models/case_search.py::CaseSearch`), its build reads `title_label.get(lang) or ''`
(`CaseSearch.get_search_title_label`), and Nova writes a blank text under every app language
(`hqShells.ts::caseSearchConfigShell`), which is what HQ's Case List save leaves. A stored map that
lacks a language where every language is blank is that rewrite, recorded under
`list-settings-respelled` (13.3).

---

## 13. Findings

Every finding these readers raise is a manifest entry named in sections 3 to 12, raised through
`ctx.claim` or `ctx.finding`, with the standing, cause and subject the frame's index gives it
(part 01 sections 2 and 8). The reader passes `place` and `detail.name`; it words nothing.

### 13.1 Places

| What | `HqPlace` |
|---|---|
| a menu's own keys, its parent selection, its kind, its media, its deep links | `{ kind: "menu", menu, name }` |
| a case list column, sort element, filter, tile, selection, the registration block, the case list menu item | `{ kind: "case-list", menu, name }` |
| a long detail column or tab | `{ kind: "case-detail", menu, name }` |
| a search setting, a Search field, a default filter | `{ kind: "search", menu, name }` |
| a form's type, actions, after-submit, deep link, display condition | `{ kind: "form", menu, form, menuName, name }` |
| a value or condition that names a question; a Save to Case block | `{ kind: "question", menu, form, menuName, formName, path }` |

**`detail.name` holds only words a person would know from CommCare HQ's pages.** Part 01 shows it
after the sentence as "In CommCare HQ: {name}" (its section 8.4), so a stored key or a wire word
there would read as nonsense: "In CommCare HQ: previous_screen", "In CommCare HQ: _cc_calculated_2".
For a manifest finding of this part it is one of:

- a name the person typed in HQ: a case property, a case type, a Search field's name, a deep link id,
  a question's id, a case tag, an index name, a column's `field` where it is a property name (never
  `_cc_calculated_<n>` or an expression: such a column gives no name);
- the label HQ's own page shows for a closed word, through one map this part writes,
  `lib/commcare/reader/hqPageLabels.ts::HQ_PAGE_LABELS` (new):

  ```ts
  export const HQ_PAGE_LABELS = {
  	/** `static/app_manager/js/details/utils.js`, the format menu. */
  	columnFormat: {
  		plain: "Plain", date: "Date", "time-ago": "Time Since or Until Date",
  		phone: "Phone Number", enum: "ID Mapping", "late-flag": "Late Flag",
  		invisible: "Search Only", address: "Address",
  		distance: "Distance from current location", markdown: "Markdown",
  		"geo-boundary": "Geo Boundary (Mobile only)",
  		"geo-boundary-color": "Geo Boundary Color (Mobile only)",
  		"geo-points": "Geo Points (Mobile only)",
  		"geo-points-colors": "Geo Points Colors (Mobile only)",
  		"address-popup": "Address Popup (Web Apps only)",
  		"clickable-icon": "Clickable Icon (Web Apps only)",
  		picture: "Picture", audio: "Audio", "enum-image": "Icon",
  		"conditional-enum": "Conditional ID Mapping",
  		"translatable-enum": "Translatable Text",
  	},
  	/** `views/forms.py::get_form_view_context`, the form settings page's end-of-form menu. */
  	workflow: {
  		default: "Home Screen", root: "First Menu", module: "Menu",
  		parent_module: "Parent Menu", previous_screen: "Previous Screen",
  		form: "Link to other form or menu",
  	},
  } as const;
  ```

  These are HQ's own English labels, quoted so the person can find the setting, and are never
  translated by Nova. A word the map lacks (a format HQ registers no menu label for, a workflow word
  outside the six) gives no `detail.name`: the place and the sentence stand alone.

At most 200 characters (part 01 section 8.3). An `unrecognized` circumstance is the exception part 01
itself makes: its `detail.name` is the surface key, or the key's path (part 01, 8.3's row for it),
which the read logs at error under that key where it is a declared surface key (part 12, section
10, `gather.ts::unrecognizedLogKey`) and what its block, worded as Nova's own gap, is filed with.
`detail.reason` is set by part 08, for an expression the checker refuses, and by part 06 on
`no-platform-runs-everything` (`split-refused`; part 01, section 8.1); this part sets none. Where this part's rules know a machine reason (which kind
blocker, which of the four Save to Case tests), it is kept nowhere: a finding's sentence comes from
its subject, so a reason no sentence reads would be noise in the account, and no log line carries
one, so a fact kept for the log would have no reader (2.2).

### 13.2 What is still raised as `unrecognized`

`unrecognized` means "the reader met something no manifest entry names" (part 01, 8.3). It has no
subject and no step 7 group, and every one is logged at error as Nova's to classify. So a class
this part can name has an entry (section 14), and what is left under the circumstance is only
what no rule of this part classified:

| Use | Why no entry names it | Section |
|---|---|---|
| an (R1), (R2) or (R3) difference no row names, an entry fact among them | by construction: the emitter did not write the proposal back, and the reader does not know why | 2.4, 6.3 |
| a projection or a gate rule that throws or refuses over the draft for a reason no row names: a deep link's `destination` refusal, a sort the gate refuses on a tile list | the same | 2.4, 10.1, 11.4 |
| a held placement the plan cannot keep (`planPlacements(...).inexpressible`), or a close the plan would move out of the action it shares | the same: HQ holds the block where Nova's plan cannot | 3.5, 4.4 |
| a value no page of CommCare HQ writes and no entry names: `update_case.update.name` on a registration form; a tile alignment or font size word outside the page's three of each | hand-written source; an entry for each conceivable value would be a list with no end, and the frame's rule for an unclaimed value is exactly this circumstance | 3.2, 11.5 |
| Nova's own scalar check on a question's `constraint`, where Nova's rule would write none there or the other of the two | only Nova's emitter writes the check, so the source was changed after Nova wrote it; no page of CommCare HQ makes the shape | 3.5 |

Each class that is a known shape of HQ's own pages has its entry and is never raised here: a tag with
a hyphen, an index name or a Save to Case link name outside Nova's grammar, `update_mode: edit` where
Nova saves every time, an index path whose case type the app does not fix, a preload into a question
that holds no default, a column over a property name outside
Nova's grammar, a tile grouping identifier outside it, a Search field over a property of another
type, and an earlier sort element a later one replaces. An app of both Connect families has part
06's entry (10.2). A child case's property key holding `/` is HQ's own build refusal and claims its
existing row (3.4), and media on a block of the hidden-menu shape reads by part 02's arm order
(8.7).

### 13.3 Rows this part hands to the first-publish register

`FIRST_PUBLISH_CHANGES` is part 09's (09-acceptance-and-the-first-publish.md, section 11.2). These
are the rewrites this part's same-state readings make, each with the predicate over the HQ app,
the paths it allows to differ, and whether it touches workers. The predicate column says when a
reading appends a record under the id; part 09's `applies` is that record's presence in
`ReadFacts.sameStateRewrites`. Each row's sentence is part 09's (its "Copy");
`search-filter-rows-recut` and `list-settings-respelled` are said by the first line of the list,
`forms-and-settings-rewritten`. The lane's comparison of these readings ("Written and not yet
run") moves a row out of this table where a build file differs.

| Id | Predicate over the HQ app | Paths allowed to differ | Touches workers |
|---|---|---|---|
| `case-settings-respelled` | some form holds a non-empty `case_preload` or `usercase_preload` or advanced `preload`, an `open_case.external_id`, an `update_case.condition` Nova writes as another word (an `if`, or a `never` on one of the three shapes 3.2 holds), a `subcases[].reference_id` of `parent`, a `name_update.update_mode` of `edit` on a block that creates, or an `update_mode` of `edit` on a follow-up or close form's own update in a project space that does not apply it (3.2) | `modules[*].forms[*].actions`; the forms' setvalues | no |
| `search-filter-rows-recut` (part 01's name) | some menu's `_xpath_query` rows are not in the order, or the number, Nova writes | `modules[*].search_config.default_properties` | no |
| `sort-rule-kept-as-hidden-column` | some short detail holds a sort element no column joins, or a `type` of `string` or `date` | `modules[*].case_details.short.columns`, `.sort_elements[*].type`, `.sort_elements[*].display` | no |
| `list-settings-respelled` | some short detail holds a `max_select_value` of `-1`, a sort element whose `blanks` is `""`, a `sort_calculation` equal to the column its element joins, two sort elements with one `field`, or no sort elements under a first column that is `invisible`; or some search holds a `title_label` or a `description` that lacks a language where every language is blank (12.4); or some menu holds a `case_list.label` blank, or with no text, in a language beside `show: true` (8.6) | `modules[*].case_details.short.max_select_value`, `.sort_elements`; `modules[*].search_config.title_label`, `.description`; `modules[*].case_list.label` | no |
| `search-filter-joined-to-list` | some menu whose forms read the search holds an `_xpath_query` conjunct that reads no Search field and restates no clause of its list filter (12.3, kind F) | `modules[*].case_details.short.filter` | no |
| `search-restates-list-filter` | some menu whose forms read the search holds a clause of its list filter that no `_xpath_query` conjunct restates (12.3, the first closing check) | `modules[*].search_config.default_properties` (added rows) | yes |
| `link-held-case-guards-added` | some form holds a `form_links` entry that carries a value onto a single-case selection and whose `xpath` does not end in that value's held-case guard (9.4, `guards: "added"`) | `modules[*].forms[*].form_links[*].xpath` | yes |

Two readings record under ids that are no rows of this table. A Save to Case value written to a
date-and-time property in the spelling Nova wrote before this step reads as the same write (5.2),
and appends a record under `date-and-time-saved-as-hq-stores-it`, which part 09 words and holds
(its section 11.2; its `firstPublishChanges.test.ts` holds this recording site, section 11.3, so
`rewrites.test.ts` below counts the rules of this table alone). A sort element over a
date-and-time property records nothing (11.4). A registration label with no text, in every
language or in one, reads as "Create a new Case" there (8.7) and appends a record under
`registration-label-fixed`, which part 09 words and holds (its section 11.2). It touches workers:
CommCare HQ's fallback goes through `gettext` and a toggle of the project space, so a build could
show other words before. `registration.test.ts` (Tests) holds both recordings.

A column the case detail alone shows is in no row: it is read as a column that is not on the list
(11.3, 11.6), and Nova writes the short detail without it, as the source holds it.

**How the table is held complete.** Two mechanisms, neither a list kept by hand:

- A key this part claims INERT and Nova writes at another value (a stale label, a referral action, a
  bookkeeping key, an earlier sort element a later one replaces, an `update_mode` the project space
  does not apply) is covered by the register's rule for inert claims, which part 09 generates from
  the claim log (its section 11.2): this part relies on that rule and writes no row per key.
- A HELD claim whose stored value Nova writes back differently is recorded where the comparison allows
  it. Every (R2) of this part that applies a same-state rule (a key left out of, or mapped before, a
  comparison: 3.5's list, 4.4's, 8.6's blank label, 8.7's label with no text, 9.5's added guards,
  11.1's `max_select_value`, 11.4's, 12.3's reorder, split and added rows, 12.4's blank text map)
  appends `{ entry, path, register }` to `ctx.facts.sameStateRewrites`, a member this part adds to
  `ReadFacts`, with `register` the id of the row the rule falls under. Part 09's register
  test (its section 11.3, `firstPublishChanges.test.ts`) requires every such record to name a
  row of `FIRST_PUBLISH_CHANGES` whose paths cover `path`, and `rewrites.test.ts` (Tests) requires
  every same-state rule in this part's code to carry an id, so a rule added without a row fails.

---

## 14. Manifest edits

Each edit changes the entry in `lib/commcare/surface/entries/<area>.json` and its row in
`docs/research/2026-09-26-hq-round-trip/inventory/<area>.md` with it
(`lib/commcare/CLAUDE.md`, "The surface manifest"). `platforms` is `not-applicable` and `emission` is
`omit` for every new HELD-NEW row (Nova writes none of them) and for every new INERT row, as the
manifest's INERT rows hold both, with one exception: the emission cell of
`questions/bind-required-on-the-question-that-names-a-created-case` is "`required=\"true()\"`, which
Nova's emitter writes on that bind whatever the document holds", with no marker.

**What the manifest tests ask of a new row.** Two tests decide the fields below.
`lib/commcare/surface/__tests__/manifest.test.ts`'s `sharedClasses` refuses two entries that claim one
key at one value class, so every new row that shares a key takes a value class of its own, and a row
it splits from takes one where it had none. `proof/checks/test_manifest_value_classes.py::
test_every_keyed_refused_class_has_a_reader_or_is_a_known_gap` asks of a REFUSED entry with keys and
a value class, unless HQ's own build refuses its state, either a reader in `VALUE_CLASSES` or a line
in `KNOWN_GAPS`. `KNOWN_GAPS` is no option for a key Nova's own exports use: a gap leaves every use of
its keys undecided, and the lane then fails every export that uses one. So the two REFUSED rows part
02 named, whose keys every export uses, each have a lane reader, written out below. A HELD-NEW
or INERT row needs no reader: the lane asks one of a refusing entry alone (part 02 section 14).

**New: forms, case management and menus.**

| Entry | Disposition | `valueClass` | Surface keys | `subject`, `owner` | `item` | `dispositionCell` |
|---|---|---|---|---|---|---|
| `questions/savetocase-block-outside-nova-s-own-block-shape` | HELD-NEW | `outside-nova-block-shape` | those of `questions/savetocase-create-case-type-literal-case-name-owner-id-uuid-case` | `save-to-case`, `xform` | "a SaveToCase block at a position, or with content, Nova's emitter does not write: a child of the form root or of an authored group, or one whose elements, binds and setvalues differ from `saveToCaseBlockShape`'s" | "**HELD-NEW**: a Save to Case question at an authored position" |
| `questions/savetocase-link-name-outside-nova-s-identifier-grammar` | HELD-NEW | `link-name-outside-identifier-grammar` | those of `questions/savetocase-link-index-name-child-extension-and-unlink-empty` | `save-to-case`, `xform` | "a SaveToCase `index/<name>` whose name is outside `[A-Za-z_][A-Za-z0-9_]*`" | "**HELD-NEW**: an index name Nova's link identifier cannot spell (`caseOperationIdentifiers.ts::CASE_OPERATION_IDENTIFIER_REGEX`); the name is a key of case data, so no rename keeps it" |
| `questions/bind-required-on-the-question-that-names-a-created-case` | INERT | `on-the-create-name-question` | `xform:model/bind@required` | none | "a `required` attribute of any value on the bind of a visible question whose answer names a case the form creates" | "**INERT**: HQ's build writes `required="true()"` on that bind whatever the source holds (`xform.py::XFormCaseBlock.add_create_block`), and so does Nova's emitter (`builder.ts::buildFieldParts`)" |
| `forms-and-case-writes/advanced-form-loads-other-than-its-menu-s-one-chain` | HELD-NEW | `loads-outside-one-chain` | those of `forms-and-case-writes/load-update-cases-loadupdateaction` | `advanced-forms`, `forms-and-case-management` | "`load_update_cases[]` whose chosen loads are not one chain every form of the module shares, whose own selection is not the module's list, or whose index names Nova does not derive" | "**HELD-NEW**: stored case selections per form" |
| `forms-and-case-writes/load-changing-no-case-with-a-tag-nova-does-not-derive` | HELD-NEW | `underived-tag-on-a-load-changing-no-case` | `schema:LoadUpdateAction.case_tag`, `schema:LoadUpdateAction.auto_select` | `advanced-forms`, `forms-and-case-management` | "a load with no `case_properties` and no active `close_condition` whose `case_tag` is not `load_<case type><n>`, or an auto-selected `usercase` load that writes nothing" | "**HELD-NEW**: a held tag on a selection that changes no case (`placement.ts::planAdvancedCore` holds a tag only on an operation)" |
| `forms-and-case-writes/case-tag-holding-a-hyphen` | HELD-NEW | `tag-with-a-hyphen` | `schema:LoadUpdateAction.case_tag`, `schema:AdvancedOpenCaseAction.case_tag` | `advanced-forms`, `forms-and-case-management` | "a `case_tag` HQ's page accepts that holds `-` (the page names a tag from the module's case type as typed, `advanced/case_config_ui.js::addFormAction`)" | "**HELD-NEW**: a tag outside Nova's tag grammar (`placements.ts::advancedTagSchema`); the tag is the submission path `case_<tag>` and the session value `case_id_<tag>`, so no rename keeps it" |
| `forms-and-case-writes/index-identifier-outside-an-xml-element-name` | HELD-NEW | `open-action-index-name-outside-xml-name` | those of `forms-and-case-writes/advancedopencaseaction-case-indices-child-extension-one-or-many` | `advanced-forms`, `forms-and-case-management` | "an `AdvancedOpenCaseAction.case_indices[].reference_id` outside `[a-zA-Z_][a-zA-Z0-9_]*`" | "**HELD-NEW**: an index name Nova's link identifier cannot spell (`XML_ELEMENT_NAME_PATTERN`)" |
| `forms-and-case-writes/loadupdateaction-preload-read-later-in-the-load` | HELD-NEW | `selection-preload-read-later` | `schema:LoadUpdateAction.preload` | `case-preloads`, `forms-and-case-management` | "`LoadUpdateAction.preload` into a question a later load-time value reads, into a question in a repeat, or from a property path" | "**HELD-NEW**: a preload held with its place at the end of the load" |
| `forms-and-case-writes/case-preload-into-a-question-that-holds-no-default` | HELD-NEW | `preload-target-holds-no-default` | those of `forms-and-case-writes/case-preload-question-property-into-a-question-outside-any`, and `schema:FormActions.usercase_preload`, `schema:LoadUpdateAction.preload` | `case-preloads`, `forms-and-case-management` | "a preload into a question whose kind holds no default value in Nova, or into a Hidden Value that has a calculation" | "**HELD-NEW**: a load into a question that takes no default: Nova holds a preload as the question's default value, and a Hidden Value holds one value source (`HIDDEN_VALUE_BOTH_SOURCES`)" |
| `forms-and-case-writes/update-mode-edit-off-a-follow-up-form-s-own-update` | HELD-NEW | `edit-where-nova-saves-every-time` | `schema:ConditionalCaseUpdate.update_mode` | `form-case-management`, `forms-and-case-management` | "`update_mode: edit` on a registration form's `update_case` or `external_id`, on the `name` or `owner_id` key of any `update_case`, on `usercase_update`, on a child case's `case_properties`, or on an advanced load's or open action's `case_properties`, in a project space with `SAVE_ONLY_EDITED_FORM_FIELDS`" | "**HELD-NEW**: saving only a changed answer anywhere but a follow-up or close form's own basic update, in a project space with `SAVE_ONLY_EDITED_FORM_FIELDS`: HQ's build applies it there (`xform.py::XFormCaseBlock.add_case_updates`), and Nova holds `onlyIfChanged` on the own arm's property writes in the basic own slot alone (`validateOnlyIfChanged`)" |
| `forms-and-case-writes/index-path-through-a-case-type-the-app-does-not-fix` | HELD-NEW | `ancestor-type-unknown` | those of `forms-and-case-writes/update-key-whose-index-segments-are-each-parent-or-host-parent-p` and of `forms-and-case-writes/case-preload-from-parent-paths-into-a-question-outside-any` | `form-case-management`, `forms-and-case-management` | "an update key or a preload through `parent/` or `host/` where no child link and no parent selection of the app says which case type the index reaches, where two say different types, or where two cases of the chain share one type" | "**HELD-NEW**: a write or a load through an index whose case type the app does not state; Nova names an ancestor by its case type (`RelationStep.throughCaseType`, `formCasePropertyRefSchema`)" |
| `forms-and-case-writes/update-mode-edit-in-a-project-space-that-saves-every-time` | INERT | `edit-the-project-space-does-not-apply` | `schema:ConditionalCaseUpdate.update_mode` | none | "`update_mode: edit`, anywhere but a follow-up or close form's own basic update, in a project space without `SAVE_ONLY_EDITED_FORM_FIELDS`" | "**INERT**: HQ's build reads the mode only under that flag (`xform.py::XForm`, `self.save_only_if_edited`), so without it every answer is saved every time, which is what Nova writes" |
| `menus-and-case-lists/advanced-module-nova-would-write-as-a-basic-one` | HELD-NEW | `advanced-with-a-kind-blocker` | those of `menus-and-case-lists/advancedmodule` | `advanced-menus` (new subject, "Copy"), `forms-and-case-management` | "`AdvancedModule` whose forms read the search, whose case list menu item is narrowed, or whose chain no one index name follows" | "**HELD-NEW**: an advanced module `lib/domain/advancedModule.ts::advancedKindBlockers` keeps Nova from writing advanced" |
| `menus-and-case-lists/module-case-list-label-or-media-beside-show-false` | INERT | `beside-show-false` | `schema:CaseList.label`, `schema:CaseList.media_image`, `schema:CaseList.media_audio` | none | "`case_list.label` or media on a basic module whose `case_list.show` is false" | "**INERT**: each reader of the label and the media tests `show` first (`app_strings.py::_create_case_list_app_strings`, `suite_xml/sections/entries.py::EntriesHelper.entry_for_module`, `suite_xml/sections/menus.py::MenuContributor._get_commands`, `corehq/apps/hqmedia/models.py::ModuleMediaMixin.all_media`)" |

Part 02's four rows that these readers raise. Its section 14 gives each a disposition, a cause and a
subject; the fields the schema and the two tests also need are these:

| Entry | Disposition, cause | `valueClass` | Surface keys | `subject`, `owner` | `item` | `dispositionCell` | Lane reader |
|---|---|---|---|---|---|---|---|
| `menus-and-case-lists/case-list-session-endpoint-id-on-a-put-in-root-module` | REFUSED, `broken-at-runtime` | `on-a-put-in-root-module` | those of `menus-and-case-lists/case-list-session-endpoint-id` | `deep-links`, none | "`case_list_session_endpoint_id` on a module whose `put_in_root` is true" | part 02's: "**REFUSED**: HQ builds the endpoint with no command for the menu, so it opens the menu above and never the list" | `case_list_endpoint_on_a_put_in_root_module`: true where the module's `case_list_session_endpoint_id` is not blank and its `put_in_root` is true. Shapes in `test_manifest_value_classes.py`: refused, a module with both; accepted, the same module with `put_in_root: false` (the HELD row `menus-and-case-lists/case-list-session-endpoint-id` then takes the use) |
| `menus-and-case-lists/form-filter-reading-the-case-on-a-screen-that-chooses-no-case-first` | REFUSED, `broken-at-runtime` | `case-read-off-a-case-first-screen` | those of `forms-and-case-writes/form-filter-lifting-into-predicate-a-direct-own-case-property-in` | `display-conditions`, none | "`form_filter` that reads the form's case where the screen that lists the form chooses no case first" | part 02's: "**REFUSED**: a wider class than HQ's own build error (`CaseXPathValidationError`)" | `form_filter_reads_case_off_a_case_first_screen`: true where the filter's parsed tree holds a case reference (the lane's XPath reader, `proof/rules/_xpath.py`) and the screen the form lists on has a form that needs no case, by part 02 section 5.4's rule over the source's menus. Shapes: refused, a `put_in_root` module's follow-up form with a `#case/` filter beside a registration form listed on the same screen; accepted, the same filter where every form on the screen requires a case |
| `forms-and-case-writes/post-form-workflow-previous-screen-on-a-form-listed-on-the-first-menu` | HELD-NEW | part 02's `previous-screen-on-a-form-listed-on-the-first-menu` | those of `forms-and-case-writes/post-form-workflow-previous-screen` | `display-only-forms`, `menus` | "`post_form_workflow: previous_screen` on a form of a `put_in_root` module listed on the first menu" | "**HELD-NEW**: a return to the screen before a form the first menu lists" | none |
| `forms-and-case-writes/form-link-or-endpoint-through-a-first-menu-that-shares-one-case` | HELD-NEW | `through-a-first-menu-that-shares-one-case` | those of `forms-and-case-writes/form-links-target-a-form-any-suite-form` and of `forms-and-case-writes/session-endpoint-id` | `display-only-forms`, `menus` | "a `form_links` entry or a `session_endpoint_id` whose frame HQ builds through the first menu while every form of every `put_in_root` module opens one chosen case" | "**HELD-NEW**: a link or a deep link through a first menu that keeps one case" | none |

**Re-cut: forms, case management and menus.**

| Entry | Edit |
|---|---|
| `forms-and-case-writes/update-through-the-date-and-time-join-of-a-date-and-a-time` | HELD-NEW to HELD, in part 01 section 3.5's words; `subject` and `owner` leave |
| `forms-and-case-writes/loadupdateaction-preload-question-property` | HELD-NEW to HELD; `valueClass: "selection-preload-as-default"`; `item` "`LoadUpdateAction.preload{question: property}` into a question outside any repeat that no later load-time value reads"; cell "**HELD**: the question's default value reading the selected case's property, the same state (README, \"Load-time values\")"; `subject` and `owner` leave |
| `forms-and-case-writes/case-preload-into-a-question-outside-any-repeat-where-the-held` | REFUSED to HELD-NEW; `valueClass: "load-changes-values"` kept; the refusal reason leaves; `subject: "case-preloads"`, `owner: "forms-and-case-management"`; cell "**HELD-NEW**: a preload held with its place at the end of the load: HQ appends it after every setvalue the form holds (`xform.py::XForm.add_case_preloads`), and a default value runs at the question's place. The basic Case Management page draws no load section, and its save keeps a stored `case_preload` (`forms/case_config_ui.js::HQFormActions.from_case_transaction`)"; the inventory row's "not HQ-editable: no editor writes basic `case_preload` (the basic Case Management page has no load section)" becomes the cell's last sentence, since the fact stands and is no reason to refuse ("Claims corrected"). No lane reader is lost: the entry had none to keep, and a HELD-NEW row needs none |
| `forms-and-case-writes/conditionalcaseupdate-update-mode-edit` | stays HELD; gains `valueClass: "follow-up-own-update"`; `item` "`ConditionalCaseUpdate.update_mode: edit` on a property of a `requires: case` form's `update_case`"; cell gains "read as `onlyIfChanged` where the source project space applies it, and as saved every time where it does not (the same state there: HQ's build reads the mode only under `SAVE_ONLY_EDITED_FORM_FIELDS`)" |
| `forms-and-case-writes/update-key-failing-hq-s-grammar-or-in-case-reserved-words-json` | stays REFUSED (`not-hq-buildable`); gains the key `schema:OpenSubCaseAction.case_properties`; `item` gains "or a child case's property key holding `/`"; cell gains "(`helpers/validators.py::IndexedFormBaseValidator.check_case_properties`: no parent properties for a subcase)". HQ's build refuses the state, so it needs no lane reader |
| `forms-and-case-writes/loadupdateaction-case-tag-without` | stays HELD; `item` "`LoadUpdateAction.case_tag` without `/` and without `-`"; `valueClass` stays `tag-without-slash` |
| the nine HELD Save to Case rows of `questions` (`savetocase-create-case-type-literal-case-name-owner-id-uuid-case`, `savetocase-update-case-id-xpath`, `savetocase-property-rows-calculation-condition-lifting-into`, `savetocase-property-names-with-hyphens-a-z-w-case-insensitive`, `savetocase-open-case-condition`, `savetocase-owner`, `savetocase-link-index-name-child-extension-and-unlink-empty`, `savetocase-inside-a-repeat`, `savetocase-inside-a-group-whose-display-condition-gates-it`) | each `item` gains "in the block shape Nova writes (`xform/caseOps.ts::saveToCaseBlockShape`)"; the last is re-worded "a SaveToCase block in Nova's condition group"; dispositions unchanged |
| `menus-and-case-lists/media-image-media-audio-differing-by-language` and its HELD sibling `menus-and-case-lists/media-image-media-audio-same-asset-in-every-language` | part 01 section 3.5's wording. The form pair is worded by part 06; this part claims the form's `media_image` and `media_audio` (8.6) |
| `questions/bind-required-true`, `questions/bind-required-expr` | each stays HELD; each `item` gains "other than on the question that names a created case", so the three classes on `xform:model/bind@required` are disjoint |

**New: case lists and search.**

| Entry | Disposition | `valueClass` | Surface keys | `subject`, `owner` | `item` | `dispositionCell` |
|---|---|---|---|---|---|---|
| `case-search/date-prompt-matched-by-hq-s-own-rule` | HELD-NEW | `date-not-excluded` | those of `case-search/input-date` | `search-fields`, `case-search` | "`input_: date` on a prompt without `exclude`" | "**HELD-NEW**: a date Search field HQ compares by its own exact rule, with the project space's fuzzy and ignore-pattern settings; Nova's date field is always excluded and carries a whole-day clause (`simpleArmDerivation.ts::simpleArmNeedsXPathQueryEmission`)" |
| `case-search/prompt-named-for-a-case-attribute-hq-matches-itself` | HELD-NEW | `attribute-name-not-excluded` | those of `case-search/name-prompt-key-case-property`, and `csql-key:owner_id` | `search-fields`, `case-search` | "a prompt named `case_id`, `owner_id` or `status` without `exclude`" | "**HELD-NEW**: a Search field over a case attribute that HQ's search reads by its own rule (`case_search/utils.py::CaseSearchQueryBuilder._apply_filter`); Nova writes such a field excluded, with its own `@<name>` clause (`simpleArmDerivation.ts::simpleArmNeedsXPathQueryEmission`)" |
| `case-search/search-field-over-a-property-of-another-type` | HELD-NEW | `field-type-the-property-s-writers-do-not-fit` | those of `case-search/input-daterange` and of `case-search/name-prompt-key-case-property` | `search-fields`, `case-search` | "a date or date range prompt named for a property the app's forms save as something other than a date" | "**HELD-NEW**: a Search field whose type its property's writers do not fit; Nova's gate asks a date type of a date field (`SEARCH_INPUT_TYPE_PROPERTY_TYPE_MISMATCH`)" |
| `case-search/list-first-with-a-search-that-skips-to-results` | HELD-NEW | `list-first-default-search` | those of `case-search/auto-launch-false-in-an-app-with-cloudcare-enabled-false` | `search-setup`, `case-search` | "`auto_launch: false` with `default_search: true` in an app with `cloudcare_enabled: false`" | "**HELD-NEW**: a case list first whose Search action goes straight to its results: HQ writes `default_search` into the query whatever `auto_launch` says (`remote_requests.py::RemoteRequestsHelper.build_remote_request_queries`), and Nova's `listFirst` writes it false" |
| `case-search/xpath-query-row-reading-a-field-hq-also-matches` | HELD-NEW | `conjunct-over-a-matched-field-unguarded` | those of `case-search/several-xpath-query-rows` | `search-default-filters`, `case-search` | "an `_xpath_query` conjunct that reads a prompt with no `exclude` outside that prompt's presence guard" | "**HELD-NEW**: a condition on a Search field HQ's matcher also compares, applied whether or not the field is answered; Nova holds such a condition only as a list filter clause that waits for the field, or on an excluded field (`searchPrompts.ts::searchInputSuppressesAutoMatch`)" |
| `case-search/xpath-query-row-that-is-neither-a-list-filter-clause-nor-a-search-field-s` | HELD-NEW | `conjunct-with-no-slot` | the same | `search-default-filters`, `case-search` | "an `_xpath_query` conjunct that reads no prompt and restates no clause of `Detail.filter`, on a module whose forms do not read the search, or one an advanced form's load names as `details_module`" | "**HELD-NEW**: a filter the search applies and the case list does not: there HQ's results list reads the case type alone (`remote_requests.py::_build_datum_nodeset`), and Nova's one filter narrows both" |
| `case-search/case-list-filter-clause-the-search-does-not-restate` | HELD-NEW | `unrestated-on-a-module-whose-forms-do-not-read-the-search` | `schema:Detail.filter` | `list-and-search-filters` (new subject, "Copy"), `case-search` | "a top-level clause of `Detail.filter` no `_xpath_query` conjunct restates, on a module that offers search and whose forms do not read it" | "**HELD-NEW**: a filter the case list applies and the search does not: there HQ's results list reads the case type alone (`remote_requests.py::_build_datum_nodeset`), and Nova's one filter narrows both" |
| `menus-and-case-lists/column-field-outside-nova-s-property-grammar` | HELD-NEW | `property-name-outside-nova-s-grammar` | `schema:DetailColumn.field` | `case-list-columns`, `case-list-and-detail` | "a column `field` that `details/utils.js::isValidPropertyName` accepts and Nova's case property grammar does not (a hyphen)" | "**HELD-NEW**: a column over a property name outside `AUTHORED_CASE_PROPERTY_NAME_PATTERN`" |
| `menus-and-case-lists/case-tile-group-identifier-outside-an-xml-element-name` | HELD-NEW | `identifier-outside-xml-name` | those of `menus-and-case-lists/detail-case-tile-group-index-identifier-header-rows` | `case-tiles`, `case-list-and-detail` | "`case_tile_group.index_identifier` outside `[a-zA-Z_][a-zA-Z0-9_]*`" | "**HELD-NEW**: a grouping index name Nova's `tile.grouping.identifier` cannot spell" |
| `menus-and-case-lists/sort-elements-sharing-a-join-text` | INERT | `earlier-of-two-with-one-field` | `schema:SortElement.field`, `schema:SortElement.type`, `schema:SortElement.direction`, `schema:SortElement.blanks`, `schema:SortElement.display`, `schema:SortElement.sort_calculation` | none | "a sort element whose `field` a later element of the same detail repeats" | "**INERT**: `util.py::get_sort_and_sort_only_columns` keys the elements by `field`, a later one replacing an earlier, and HQ's build and its app strings both take the elements through it" |

Part 02's row `case-search/search-on-a-put-in-root-module` (HELD-NEW, `search-setup`,
`case-search`) takes `valueClass: "on-a-put-in-root-module"` and the keys of
`case-search/workflow-search-first-auto-launch-true-default-search-false`, with part 02's cell.

Part 03's row, which its section 10 names and this part's reader claims (12.4):

| Entry | Disposition | `valueClass` | Surface keys | `subject`, `owner` | `item` | `dispositionCell` |
|---|---|---|---|---|---|---|
| `case-search/title-label-blank-in-some-languages` | HELD-NEW | `blank-in-some-languages` | `schema:CaseSearch.title_label`, `parser:SessionDatumParser/title` | `search-setup`, `case-search` | "`title_label` blank in some app languages and not in others" | "**HELD-NEW**: a search title blank in one language where another holds text: HQ shows a blank title there, where Nova's translation fill would show the default language's" |

Its `platforms` is `not-applicable` and its `emission` `omit`, as every new HELD-NEW row of this
section.

**Re-cut: case lists and search.**

| Entry | Edit |
|---|---|
| `menus-and-case-lists/6-late-flag-late-flag-1` | HELD to HELD-NEW; `subject: "case-list-columns"`, `owner: "case-list-and-detail"`; cell "**HELD-NEW**: a flag column with no list header: HQ's `LateFlag` writes an empty header on the case list (`detail_screen.py::HideShortHeaderColumn`), and Nova's interval column shows its own"; emission cell "nothing: Nova writes an interval column as a calculated `translatable-enum`" |
| `case-search/several-xpath-query-rows` | HELD-NEW to HELD, in part 01 section 3.5's words, with: "each top-level conjunct a restated clause of the case list filter, a Search field's derivation, a condition on an excluded Search field, a list filter clause that waits for a Search field, or, where the module's forms read the search, a clause the list filter gains" |
| `case-search/input-date` | stays HELD; `valueClass: "date-excluded-with-a-whole-day-clause"`; cell "**HELD**: scalar `date`, excluded from HQ's matcher, beside its whole-day `_xpath_query` clause" |
| `case-search/auto-launch-false-in-an-app-with-cloudcare-enabled-false` | stays HELD, `valueClass` `list-first-android-only` kept; `item` "`auto_launch: false` and `default_search: false` in an app with `cloudcare_enabled: false`" |
| `menus-and-case-lists/field-naming-a-property-not-displayed-hq-appends-a-hidden-column` | stays HELD; emission cell "a stored `invisible` column, last, and its sort element" |
| `case-search/title-label-lang-non-empty` | stays HELD; `item` narrowed to "`title_label{lang}` non-empty in every app language", so its class and that of `case-search/title-label-blank-in-some-languages` on the key are disjoint |

Part 01's Appendix A counts the entries by subject; its counts follow from the `subject` cells of
the tables above, and this part restates none of them.

---

## Copy

**Finding sentences.** What a person reads of a finding is part 01's sentence for its subject and
standing (`lib/publish/hqFindingCopy.ts::FINDING_COPY`, `FIX_IN_HQ_STEMS`;
01-the-bar-and-the-manifest.md, section 9.2, with the subjects in its section 2.2). A new entry
takes a subject only where that subject's sentence is true of it, read as the person will read
it. Most of section 14's rows do: a tag or an index name under `advanced-forms`, a Save to Case
link name under `save-to-case`, a preload under `case-preloads`, a Search field under
`search-fields`, a search's own filter under `search-default-filters`, a list-first search under
`search-setup`, a column under `case-list-columns` (whose sentence part 01 words so that it is
true of a column's property name as of its format; its 2.6), a grouping identifier under
`case-tiles`. Four subject and standing pairs have no sentence that is true of this part's
entries, so part 01 holds a sentence for each, and this is why each exists:

| Subject | Standing | Why the pair needs its own sentence |
|---|---|---|
| `display-only-forms` | `not-yet` | Nova holds forms shown in the menu above (part 02), so the subject's earlier `not-yet` sentence is false. Part 02's two HELD-NEW entries of the subject are a `previous` return from a form on the first menu, and a link or deep link through a first menu that shares one case, and the sentence is worded for those two |
| `advanced-menus` (new; label "Advanced menus") | `not-yet` | `advanced-module-nova-would-write-as-a-basic-one` is about the menu's search or its case list item, not about a load, so `advanced-forms`' sentence would name the wrong thing. What it names to a person: an advanced menu |
| `form-case-management` | `not-yet` | the subject holds only `fix-in-hq` entries today. `update-mode-edit-off-a-follow-up-form-s-own-update` and `index-path-through-a-case-type-the-app-does-not-fix` are both settings of HQ's Case Management page |
| `list-and-search-filters` (new; label "Case list and search filters") | `not-yet` | `case-list-filter`'s sentence says the filter "is more than Nova can read as a condition yet", and this filter reads fine: what Nova lacks is a list filter its search does not share. What it names to a person: a case list filter its search doesn't share |

Each pair's next step is its standing's own (`FINDING_NEXT_STEPS["not-yet"]`). No re-cut of section
14 empties a subject and standing: each subject a row leaves keeps another entry at that standing,
and `case-list-filter` keeps its one `not-yet` entry. `menu-settings` takes no `not-yet` entry
from this part: a case list menu item with no label is read exactly (8.6).

**First-publish sentences.** Each register row of 13.3 is said by part 09's sentence for its id
(09-acceptance-and-the-first-publish.md, "Copy").

**The column that is not on the list** (11.6). The builder's switch, in a column's inspector:

| Where | Text |
|---|---|
| the switch's label | List search matches this |
| under it, on | People filtering the list can find a case by this, though the list doesn't show it. |
| under it, off | Only Details shows this. The list doesn't search or sort by it. |
| under it, disabled while Default order uses the field | The list sorts by this, so its search matches it too. You can remove it from Default order to change that. |

The gate's sentences, `CASE_LIST_COLUMN_NOT_ON_LIST_INVALID`, `<header>` the column's header (its
property where the header is blank):

| Reason | Message |
|---|---|
| `shown` | The "<header>" column is set to show on Results and also to stay off the list. A column that is off the list is hidden on Results. You can hide it on Results, or put it back on the list. |
| `sorted` | The "<header>" column isn't on the list, so the list can't sort by it. You can remove its sort rule, or keep the column on the list as a hidden one, which the list's search then matches. |

Those are the rule's own messages, which a tool's caller reads. The code's builder lines
(`lib/doc/userFacingErrors.ts::USER_MESSAGE_BY_CODE`), `<menu>` the menu's name:

| Reason | Builder line | Where a person meets it |
|---|---|---|
| `sorted` | This isn't on the list, so the list can't sort by it. You can turn on List search matches this to sort by it. | under the field's disabled choice in Default order's Add menu, in a list with no tile |
| `shown` | One item in "<menu>" is set to show on Results and to stay off the list, and it can't be both. You can hide it from Results and try again. | nowhere in the builder's own gestures, which never write the pairing; it is the line a refused commit would carry |

The tools. `notOnList` on each column arm of `addCaseListColumns` and `updateCaseListColumn`:
"true keeps the column off the list: only Details shows it, and the list neither searches nor
sorts by it. It hides the column on Results too. Leave it out for a column on the list." A call
that sends `notOnList: true` with `visibleInList: true` is refused before staging: "A column can't
be shown on Results and off the list at once. Leave out notOnList to show it, or leave out
visibleInList to keep it off the list." The summary line a model reads for such a column ends
`(not on the list)`.

**Log lines.** This part writes none. The reader holds no logger (part 06, 2.2): it returns
findings and `ReadFacts`, and what is logged of an `unrecognized` finding is part 12's (its
section 10). This part
raises no reader defect of its own and words no `why` (part 06, 5.1).

---

## Tests

Method: `docs/testing.md`. Every reader test below runs in ordinary CI with no Docker and no
browser: the reader is a pure function, so its boundary is "HQ JSON in, document or findings out",
exercised through production functions on both sides. Inputs are built by the production emitter
(`expandDoc`) from documents made with the production builders, or are retained HQ answers under
`proof/hq-reads/` and `proof/hq-apps/`; no hand-written HQ JSON stands in for what `expandDoc` can
produce. Where a shape only HQ authors is needed, the test edits `expandDoc`'s output at one key
and names the HQ page or model that writes it. A case that needs a bound expression runs the
reader's own stages through part 06's `STAGES`, part 08's binding included; no test fills a
registration's outcome itself.

**The canonical choices.** This part adds seven rows to part 06's
`assemble.ts::READER_CANONICAL_CHOICES`, each `one-wire`. Each has its equal-bytes case in part
09's `canon.test.ts`, but for `unheld-placements-are-held`, which
`lib/commcare/__tests__/heldPlacementEmission.test.ts` already holds: it prints every fuzz,
advanced and fixture document with and without `placementHolds.ts::placementsToHold` applied and
requires equal bytes. This part's own tests hold the other half, that the reader returns the
canonical member:

| Row | The reader's test |
|---|---|
| `create-name-required-is-absent` (3.2) | `basicActions.hqShapes.test.ts` |
| `registration-form-last` (8.7) | `registration.test.ts` |
| `default-post-submit-is-absent` (9.1) | `afterSubmit.hqShapes.test.ts` |
| `dormant-tile-cells` (11.5) | `tile.test.ts` |
| `case-catalog-is-as-read` (section 7) | `catalog.test.ts` |
| `unheld-placements-are-held` (section 1) | `basicActions.roundTrip.test.ts`, `advancedActions.roundTrip.test.ts` and `saveToCase.roundTrip.test.ts`: every placement of the read document is held |
| `unsorted-hidden-tile-columns-are-off-the-list` (11.6) | `joinDetailColumns.test.ts` |

**Case management, menus and the frame** (`lib/commcare/reader/caseManagement/__tests__/`,
`lib/commcare/reader/menus/__tests__/`, `lib/commcare/hq/__tests__/`, and
`lib/commcare/reader/__tests__/` for the last four rows):

| File and case | Boundary | The failure it would catch |
|---|---|---|
| `formType.test.ts`: the eleven rows of 3.1 | `readFormType` over `requires` and actions | a registration read as a survey, which would drop its case |
| `conditions.test.ts`: each operator, a choice answer, a literal answer, each refusal reason; a property test that `readActionCondition` then `stateCondition` returns the stored condition for every condition `formActionCondition` can write | pure, with `caseSlotFacts` over a built document | an `=` on a choice read as a literal, which the gate would refuse later as `condition-not-a-choice` |
| `basicActions.roundTrip.test.ts`: for every document of `lib/commcare/__tests__/` fuzz generators that emits basic forms, `readCaseManagement` over `expandDoc(D)` gives operations deep-equal to `D`'s with placements `planPlacements(D)` gives | reader over the production emitter | any basic slot the reader maps to the wrong facet; a held `subcase` index off by one |
| `basicActions.hqShapes.test.ts`: `open_case.external_id`; `update_case.condition: if`; `reference_id: "parent"`; with the source project space's flag on, `update_mode: "edit"` on a follow-up's property reads `onlyIfChanged`, and on a registration's update, on `external_id`, on the `name` key, on `usercase_update` and on a child case's property raises the not-yet entry each time; with the flag off, the follow-up's property reads as saved every time and records `case-settings-respelled`, and each of the others claims the INERT entry and raises nothing; a `required` condition on the question that names a created case reads back with none and claims `bind-required-on-the-question-that-names-a-created-case`, and the same on a Hidden Value keeps it; `name_update.update_mode: "edit"` on `open_case` reads as nothing; `parent/p` and `host/p` keys, and one whose ancestor type no link or parent selection fixes raises its entry; a child case's key holding `/` claims HQ's build-refusal row; a child case with a close reads back with the close sharing the create's place; `relationship: "extension"` raises its entry; a key `location_id` raises N2 | reader over one-key edits of emitted JSON | an HQ spelling of a held meaning refused, or a refused one read; a document the gate would refuse later (`CASE_WRITE_ONLY_IF_CHANGED_INVALID`); a write that saves a changed answer alone where the app's own build saves every time |
| `scalarCheck.test.ts`: a registration form Nova emitted, read back, holds no `unrecognized`; the same source with the name action pointed at another question, and with the question's check swapped for the external id's, each raises `unrecognized` at the question with `xform:model/bind@constraint`; a Hidden Value that names the case never holds a record | reader over `buildXFormSource` and one-key edits of it | a check folded out of a constraint and not written back, which would drop a validation at the first publish |
| `caseReferences.test.ts`: a form with Save to Case blocks Nova emitted reads `save` as derived; one stored property removed raises `case-references-data-save-differing-from-that-computation`; a form whose block is 5.1's finding raises that alone. And in `lib/commcare/__tests__/caseSaveReferences.test.ts`: `caseSaveReferencesOf` over a model whose binds hold `ref`, a relative path, no path, and a data root named other than `data` throws nothing and lists the leaves Vellum's rule lists; `caseSaveReferences` over the emitter's trees gives the map it gave before the split | reader over `buildXFormSource`; the split function over hand-built elements | a throw inside the reader for a source HQ serves; a `save` map judged against the wrong computation |
| `preloads.test.ts`: a preload with no later reader reads as the default and drops an authored default; one a later default reads through a calculate raises the entry at `not-yet`, never `fix-in-hq`; one under a group whose relevance a later default reads raises it; one in a repeat is inert; one into a Hidden Value with a calculation raises `case-preload-into-a-question-that-holds-no-default`; `laterLoadReaders` over a document with a default chain | the reader's stages over built sources | a load moved ahead of a value that reads it, which would change what a form opens with |
| `advancedActions.roundTrip.test.ts`: every corpus-shaped document whose menu is emitted advanced (held kind; a carried create), read back equal, tags held | reader over the production emitter | a chain read as a different parent selection; a tag lost |
| `advancedActions.hqShapes.test.ts`: a write-less parent load tagged `load_<menu type>0` raises the tag entry; a tag `load_follow-up0` raises `case-tag-holding-a-hyphen`, and `load_follow_up0` reads; two forms with different chains raise the chain entry; a chain through a basic menu with its own parent selection reads, in an app where that selection is the only evidence of the parent type; an open action's index named `my-parent` raises its entry; `update_mode: "edit"` on a load's property raises its entry with the flag on and reads as saved every time with it off; an open action with a close reads back with the close sharing its place; an advanced menu whose forms read the search raises `advanced-module-nova-would-write-as-a-basic-one`, and so does one whose case list menu item is narrowed, each once at the menu; `auto_select` modes; an open action's `owner_id` naming the folded owner node reads `unowned` | reader over edited emitted JSON | Nova re-tagging a load, which renames a session value HQ's forms read |
| `saveToCase.roundTrip.test.ts`: every Save to Case shape `saveToCaseBlockShape` returns (root create, keyed create, create in a repeat, conditional update, close, several-case forms, the own arm in a block, the own close's block), read back equal with paths held; and one document for each wrapper of 5.2 (a name and an `external_id` under the trim; a write to a date-and-time property of a question's answer, of stored text, of a literal and of `now()`, the last read through its `nova_instant_` node with no question read for the node; an own-case update of a question's answer with no condition and with one; a capture's link; an absent owner, `actingUser()` and `unowned()`), each read back to the authored value with no wrapper in it; and a date-and-time write in the spelling Nova wrote before this step reads as the same write and records `date-and-time-saved-as-hq-stores-it`, where today's spelling records nothing | reader over `buildXFormSource`, and over the same source with the one calculate replaced by `typedInstantValue` of its value | a block read into the wrong operation; a guard read as an operation; a wrapper read as part of the value, so that the emitter wraps it twice and every Nova-born block fails; an app Nova published before this step refused, or brought in with no word of what its first publish changes |
| `saveToCase.boundary.test.ts`: a block moved to the form root; a block inside an authored group; an extra bind on a leaf; a missing guard; each is the new entry, once at the block's place, and never an operation | reader over an edited XForm parsed by `xmlParse.ts::parseXml` | a Vellum-authored block read as Nova's and moved on publish, which would change an export path |
| `saveToCase.retained.test.ts`: the two `targeted-migration-*` reads, whose blocks of an earlier shape each raise the new entry and no operation; and the form-builder save `proof/hq-apps/hq-nova-then-builder/app-source.json`, read through `retainedBase`, whose every block passes the recognition of section 5 ("Written and not yet run") | reader over retained HQ answers | an old shape read as today's; a block the form builder saved read as outside Nova's shape, or read into another operation |
| `catalog.test.ts`: types from menus, child cases and blocks; `parent_type` from agreeing links and none from disagreeing ones; choices merged first-label-wins; the date-and-time join types its property `datetime`; `catalogAsRead(D)` over a Nova-born document with authored labels, a declared type no reader needs and an unread property equals the catalog `readCaseCatalog` gives over `expandDoc(D)` | `readCaseCatalog` then `effectiveCaseTypes` | a declared type that contradicts a writer, which the gate refuses; a canon row that states another catalog than the reader derives |
| `publishedCaseBlocks.test.ts` (existing file, extended): conditions, close conditions, indices, `ownerWritten`, `editOnly`, `sessionDatum` for each block kind; each `UnreadFormReason`; `sourceHoldsEditMode` true for an `edit` in each block kind and false for a source with none | pure, over built sources and the retained `targeted-migration-*` reads | a silent pass for a form the reader left out; a source that holds the word read with no probe of the flag |
| `entryFacts.test.ts`: every key of `HqEntryFacts` and of `HqMenuFacts` from a built source, a menu with no form included; `entryFactsDifference` and `menuFactsDifference` order; `compareEntryFacts` over an app with a basic parent selection and a search finds no difference at the end of step 4 | pure, and the reader over `expandDoc` | a fact HQ's entry builder reads going uncompared; a comparison made before its slots are written, which would refuse every app with a parent selection |
| `entryFacts.corpus.test.ts`: for every form of every admitted corpus document `D`, `datumIdsFromFacts` over `hqEntryFacts(expandDoc(D))` deep-equals the ids `entrySessionDatums` gives, in order ("Written and not yet run") | pure, over the corpus | an id that depends on a key the fact list lacks, so that two apps with equal facts get different session values |
| `modules.roundTrip.test.ts`: order, one-tier nesting, kinds, names in two languages, the case list menu item with and without its own label, forms in the menu above, a parent selection (in the draft before `readCaseManagement` runs, and removed by `settleMenus` where N14 refuses it); a `case_list.label` blank in every language beside `show: true` reads `label: "Case List"`, raises nothing and records `list-settings-respelled`, and `caseListLabelAsBuilt` over a label blank in one of two languages gives that language "Case List" and the other its own text, over a label held only under a language the app does not name gives that text in every language, over one whose only value is `null` gives "None", and over an empty map gives "Case List" | reader over `expandDoc` and edited JSON | a child menu detached; a label stored that equals the menu's name; a blank label read as the menu's name, which changes what a device shows; "Case List" read where the build shows a label kept under another language |
| `registration.test.ts`: the hidden-menu shape folds and the form rejoins its host, last among its forms; each failing test of the shape leaves an ordinary hidden menu, media on the block among them; part 02's arm order row by row; a blank `form_id` beside a label is inert; a label with no text in any language reads as "Create a new Case" and never as an absent `label`; a language whose value is an empty string reads as those words in that language and is never filled from another language's text; a language with no key is no translation; each of the two readings appends its record under `registration-label-fixed` | reader over `expandDoc` and edited JSON | a hidden menu read as a real menu, which would mint a menu id the ledger then holds; a Register button that shows the form's name, or another language's text, where CommCare HQ's build wrote "Create a new Case"; a label rewritten on the first publish with no register record |
| `afterSubmit.roundTrip.test.ts`: property test over the link generator, moved out of `formLinkProjection.property.test.ts` (where `destination`, `otherwise`, `shape` and `buildShape` are file-local today) into `lib/commcare/__tests__/formLinkDocArbitrary.ts`, exported and imported by both files unchanged: read back equal links in order, the otherwise in both shapes, guards stripped | reader over `expandDoc` | links read in HQ's order (reversed); a guard kept as authored content and doubled on publish |
| `afterSubmit.hqShapes.test.ts`: `[L1: c, L2: not(c)]` reads destination and otherwise; a fallback beside unconditional links is inert; an authored conjunct of the guard's shape that the emitter would not add is kept and reaches part 08 in the registered condition; a link that carries a case by hand with no guard reads as its condition alone, is marked `guards: "added"`, passes 9.5 and records `link-held-case-guards-added`; a guard is never in a registered condition; `default` on a follow-up stores `app_home` and on a registration stores nothing | reader over edited JSON | one meaning stored two ways |
| `entryPoints.test.ts`: each slot; an id that is no slug fixed point; an id two slots share; `respect_relevancy: false` beside an id | reader over `expandDoc` | a deep link id changed on publish |
| `twoFindings.test.ts`: one app with a refused child case and a refused link raises both | `readCaseManagement` and `readMenus` together | a reader that stops at its first finding (part 06, "Decisions in brief", 1: every finding in one pass) |
| `candidates.test.ts`: one draft, one slot, two candidates of which the first fails its projection and the second passes (an owner read absent and then `actingUser()`; a date Search field over `date` and then `datetime`): the second is accepted, the draft holds only it, and the document object each projection saw is distinct (`withCandidate`) | the settle functions over a counting wrapper of the production projection | a second candidate judged on the first one's memoized plan, which a shared document object gives (the `WeakMap` caches of 2.2) |
| `projectionInputs.test.ts`: over a source whose menu ids, form ids and `xmlns` are none of Nova's derivations, whose form holds a capture link and whose search reads a table, `expandDoc(read(A), readProjectionInputs(ctx))` prints the source's ids, the source's project space in the link and the source's tag | reader over an `expandDoc` output re-keyed with foreign ids | every (R2) failing on an id, an address or a table name, so that every real app reads `unrecognized` |
| `rewrites.test.ts`: every same-state rule in this part's code appends to `sameStateRewrites` with a register id of 13.3; a reading that applies each rule once lists each id once (the rules of 3.5, 4.4, 8.6, 9.5, 11.1, 11.4, 12.3 and 12.4) | reader over edited JSON | a source rewrite the first publish makes with no register row (the lane would then find a difference no entry holds) |
| `hqPageLabels.test.ts`: a finding at a `previous_screen` workflow carries "Previous Screen"; one at a `late-flag` column carries "Late Flag"; no manifest finding of this part's readers carries a `detail.name` that starts with `schema:`, holds `_cc_calculated_` or is a key of `HQ_PAGE_LABELS` | every finding of the `hqShapes` and `hqFormats` cases | a stored key shown to a person as "In CommCare HQ: previous_screen" |

**Case lists and search** (`lib/commcare/reader/caseList/__tests__/`,
`lib/commcare/reader/search/__tests__/`):

| File and case | Boundary | The failure it would catch |
|---|---|---|
| `columns.roundTrip.test.ts`: each of the eight kinds, shown on both screens, on one, hidden from both, not on the list, read back equal from `projectCaseListForHq` | reader over the production projection | an interval column read as a calculated one; a select property's label column read as calculated |
| `columns.hqFormats.test.ts`: each format of 11.2's table raises or reads as its row says; `late-flag` and `time-ago` raise; an unregistered slug reads plain | reader over edited JSON | a format Nova cannot write back read as held |
| `joinDetailColumns.test.ts`: equal columns join; a detail-only column reads `notOnList` in a list of either layout, and its re-emission holds no short field for it; a list-only column is hidden from the detail; an `invisible` short column joins its long partner; in a tile list a detail-only column whose property a sort-only element names reads hidden with the rule, and a Nova-born tile list's hidden unsorted column reads back `notOnList` | pure, and the reader over `projectCaseListForHq` | a detail column lost, shown on the list, or written into the list as a hidden field a worker's filter then matches |
| `order.roundTrip.test.ts`: property test over `suiteDocArbitrary.ts`'s case lists: the plan of the read columns writes the stored `sort_elements`; blanks first and last in both directions; a rule over a date-and-time property reads back as the rule on its column, element for element, with no record appended | reader over `projectCaseListForHq` | a rule joined to the second column of one text; blanks stored where they are the direction's own; a rewrite declared for a list the first publish writes as the source holds it |
| `order.hqShapes.test.ts`: a sort-only element becomes a hidden column, beside a detail-only column over the same property that stays off the list; a short detail whose first column is `invisible`, with no sort elements, gives that column the rule and writes HQ's default element; two elements with one `field` read the later and drop the earlier; `type: "string"`; `int` on an untyped property declares it; `display` text on a sort-only element raises | reader over edited JSON | a numeric sort read as text |
| `tile.test.ts`: cells, grouping, persistence; dormant cells of a list with no tile are dropped, and a cell on a column hidden from Results in a tile list is dropped | reader over `projectCaseListForHq` | a cell read from a list that shows none, or kept on a column the tile does not draw, so that a Nova-born document reads back unequal |
| `workflow.test.ts`: the eight rows of 12.1, `false, true, false` raising `list-first-with-a-search-that-skips-to-results`; `searchWireShape` gives back the booleans of every row that reads | pure | Results first read as Search first; a list first read from booleans Nova does not write back |
| `prompts.roundTrip.test.ts`: every type, with label, hint, required, validation, default and lookup choices, each read into its slot; every arm of 12.2's second table read back equal; a field over `owner_id` reads back simple from its excluded prompt and row; a bare prompt named `owner_id`, `case_id` or `status` raises its entry; a bare date prompt raises its entry; a date range prompt over a property a text question saves raises its entry | reader over `projectCaseListForHq` and edited JSON | a prompt key read into the wrong slot; a required message stored where it is the default; a simple field read as advanced, which changes what the builder shows; a prompt Nova cannot write back read as held |
| `excludedField.test.ts`: a visible prompt with `exclude: true` that no `_xpath_query` row reads comes in as an advanced field whose condition is `match-all`, `runValidation` over the document returns no finding, and its re-emission writes the prompt with `exclude: true` and no row | reader, then `lib/commcare/validator/runner.ts::runValidation` | a field no filter reads refused, or given a row it never had |
| `settings.test.ts`: the title with text in every language, blank in every language or `{}`, and blank in some (its entry); the owner clause leaves the list filter's registered text; the whole menu's (R2) of 12.4 over a search with every setting; a `title_label` of `{}` passes it and records `list-settings-respelled`; `include_all_related_cases` derived, and raised where it differs | reader over `projectCaseListForHq` and edited JSON | the owner exclusion doubled in the filter; a blank title read as "Search"; a setting the emitter writes back differently read as held |
| `rows.test.ts`: kinds A to F by conjunct; a row `c_list and c_field` gives the list its clause and the field its condition; a Nova document whose list filter holds a clause that waits for a bare Search field reads back with the clause in the filter, and one whose advanced field holds the same condition reads back with it on the field; on a menu whose forms do not read the search, a filter clause not restated raises and a conjunct with no field raises; on one whose forms read it, the first is held with `search-restates-list-filter` and the second joins the filter with `search-filter-joined-to-list`, unless an advanced load names the menu; a conjunct that reads a bare prompt outside its guard raises; rows in another order read equal; a date field over a date and over a date-and-time property | `classifySearchRows` with rows built by `composeXPathQueryEmission` | a derivation read as an authored condition; a filter that starts narrowing a search; Nova's own filter read back as a field's condition, which breaks the fixed point |

**The column that is not on the list** (11.6), each beside the code it holds:

| File and case | Boundary | The failure it would catch |
|---|---|---|
| the order plan's test in `lib/domain/__tests__/`: a `notOnList` column is no field and gives no carrier in a list with and without a tile; `caseListColumnRuns` is true for it where Details shows it and false where neither screen does | `caseListOrderPlan` over built configs | the column written into the short detail, where a worker's filter matches it |
| `lib/commcare/validator/rules/case-list/__tests__/columnNotOnList.test.ts`: each reason of `CASE_LIST_COLUMN_NOT_ON_LIST_INVALID`; a `notOnList` column hidden from Details too is admitted; and `caseListOrderChoiceRefusal` over a `notOnList` column with a rule answers the code's builder line in a list with no tile, and nothing for the same column without `notOnList` in a tile list | `runValidation` and `lib/doc/commitVerdicts.ts::caseListOrderChoiceRefusal` over built documents | a column both shown and off the list reaching an emitter; a choice the Add menu offers that the gate then refuses, or one it withholds with Nova's line for its own failure |
| `lib/commcare/__tests__/caseListOrderParity.test.ts` (existing, one document added): the HQ JSON and the local suite hold no short field for the column, both hold its long field, and Preview's order plan is the same plan | the three readers of the plan over one document | one export path carrying the column and the other not |
| Preview's list filter test, `components/preview/shared/__tests__/listFilterOffTheList.test.ts`: filter text equal to the column's value matches no case, and matches once the column is hidden and on the list | Preview's filter over the plan Preview builds (`previewCaseListOrderPlan`) | Preview matching what no device matches |
| `lib/agent/tools/case-list-config/__tests__/addCaseListColumns.test.ts`, `updateCaseListColumn.test.ts` and `caseListReadProjection.test.ts` (existing, cases added): in each of the two tools `notOnList: true` writes `visibleInList: false` with it, and with `visibleInList: true` or a `sort` the call is refused before staging; an update whose replacement leaves `notOnList` out puts the column back on the list; the summary ends the column's line `(not on the list)` and lists a column on no screen under `saved_off_the_list:` | the shared tools over a private workspace | a tool that can write the pairing the gate refuses, or a read that tells the model a column is searched when it is not |
| `components/builder/case-list-config/__tests__/workspaceProjection.test.ts` (existing, cases added): `takeColumnOffList`, `keepColumnOnList`, and showing a `notOnList` column on Results clears the slot | pure | a field shown on Results that the list still leaves out |
| `e2e/tests/browser/case-workspace-surface.spec.ts` (existing, two journeys added, the second over a new peer scenario `tile-off-list`): hiding a field from Results and turning **List search matches this** off writes `notOnList`; with a sort on the field the switch is disabled with its reason; Default order's Add menu shows a field that is off the list disabled with its line; and in a tile list the same menu offers such a field, and choosing it leaves the field hidden with its rule. The browser spec's component peer runs no Preview, so the half "filtering Preview's list by the field's value finds no case" is held at Preview's own filter over the plan's fields (the row above, `components/preview/shared/__tests__/listFilterOffTheList.test.ts`) | Playwright over the workspace's component peer | a switch that changes nothing a worker meets; a field no gesture can bring back onto a tile list |
| the proof lane's corpus gains the targeted document `targeted-detail-only-column` (part 14, 14-proof.md, section 12.1, counts it in the corpus): on every pull request HQ's build of it and Core read a detail with a column its list lacks, and the lane's proofs hold Nova's two exports to each other; Formplayer, the Web Apps client and Android read the same state before the merge on the base `hq-case-lists`, in the dispatch over the bases (part 14, section 6.2 and P2), and this document in every scheduled lane with the readers after it | CommCare's own code at the pins | a wire shape for the state that a reader of CommCare's refuses or reads as a list field |

No `*.postgres.test.ts` belongs to the reader: it has no table. Proof 6 over the corpus (part 14)
is the whole-app form of the round-trip tests above.

---

## Contracts and docs these changes make false

| Where | Today | From this step |
|---|---|---|
| `lib/deployment/CLAUDE.md`, "Placements" (the paragraph on `publishedCaseBlocks`) | "A source that is not an application gives no form, and a form whose `xmlns` or blocks the source does not say is left out, never guessed; the caller counts what it left out." | "A source that is not an application gives no form. A form whose `xmlns` or blocks the source does not say is listed in `unread` with the reason, never guessed and never passed over. Each block carries its condition, its close condition, its links, whether it writes the owner, and which writes save only a changed answer." |
| `lib/commcare/hq/publishedCaseBlocks.ts`, header | "The reader returns only what it read; the caller counts what it left out." | "The reader returns what it read and, in `unread`, every form it left out with why." |
| `lib/commcare/CLAUDE.md`, new subsection after "Advanced modules" | (none) | "**Reading case management back.** `lib/commcare/reader/caseManagement` reads a form's `actions` and Save to Case blocks into case operations with each placement held at CommCare HQ's real position. A basic condition is the inverse of `stateCondition`; an advanced menu's parent selection is read from its forms' loads, since HQ stores none on the menu; a Save to Case block is read only in the shape `saveToCaseBlockShape` writes, each value inside the wrapper the emitter writes around it (the text trim, the date-and-time format, the presence guard, the capture address). `update_mode: edit` is read as `onlyIfChanged` only where the source project space applies it. Every reading is accepted by writing it back with `planFormCaseWire`, under the source's own ids and project space, over a frozen copy of the draft, and comparing." |
| `lib/commcare/CLAUDE.md`, "After-submit links (`form_links`)", end of "Destinations and the otherwise" | (none) | "The reader takes the list in reverse, reads the otherwise from a fallback word beside a conditional link or from a last link whose condition is the negations of the others, and strips the held-case guards the projection would add before the condition is bound (`reader/menus/afterSubmit.ts`); a link that carries a case by hand and holds no guard gains one at the first publish, which the first-publish register declares." |
| `lib/commcare/CLAUDE.md`, "Case-list emission", first paragraph | "A list's fields and order are one derived plan. ... the short detail's fields in stored order" | the same, with: "A column that is not on the list (`Column.notOnList`) is no field of the short detail in either layout, takes no order rule and has no carrier; the case detail alone holds it. `reader/caseList` inverts the order plan and joins the two details into one set of columns, reading a column the detail alone shows as not on the list." |
| `lib/commcare/CLAUDE.md`, "Case-search emission", one sentence | (none) | "`reader/search` reads each top-level conjunct of each `_xpath_query` row as a restated list filter clause, a Search field's derivation, a condition on an excluded field or a list filter clause that waits for a field. Where a menu's forms read its search, HQ applies the list filter to the results too, so there a conjunct with no field joins the list filter and an unrestated list clause is held; on any other searching menu each is not-yet." |
| `lib/commcare/CLAUDE.md`, "Not-yet-modeled" | "Shadow modules, parent-select cycles" | unchanged; a line is added: "A Save to Case question at an authored position, a late flag column, a search filter the case list does not share on a menu whose forms do not read the search, a preload held at the end of the load, saving only a changed answer anywhere but a follow-up form's own update, an advanced tag or an index name with a hyphen (each a manifest HELD-NEW row the reader raises)." |
| `lib/domain/caseListOrder.ts`, header, rule 1 | "Every column of the Results sequence is a field of the short detail, a column hidden from Results included" | "Every column of the Results sequence that is on the list is a field of the short detail, a column hidden from Results included; a column that is not on the list (`notOnList`) is no field in either layout and has no rule" |
| `lib/domain/CLAUDE.md`, the paragraph "Every saved case-list column is valid unconditionally" | "Every saved case-list column is valid unconditionally, including one hidden from both layouts and absent from sort ... `caseListColumnRuns(column, config)` says a runtime evaluates the column's value: every column of a list with no tile layout, and in a tile list a column shown on Results or Details." | "Every saved case-list column is valid, including one hidden from both layouts and absent from sort, but for one pairing the gate refuses: a column that is not on the list holds `visibleInList: false` and no order rule (`CASE_LIST_COLUMN_NOT_ON_LIST_INVALID`). ... `caseListColumnRuns(column, config)` says a runtime evaluates the column's value: every column on the list of a list with no tile layout; in a tile list a column shown on Results or Details; and a column that is not on the list where Details shows it." |
| `lib/agent/tools/case-list-config/shared.ts::VISIBLE_IN_LIST_DESCRIPTION` | "Leave it out to show the column on Results; false hides it there. The list's search still matches a hidden column. ..." | unchanged: it speaks of a hidden column, which is on the list. The new slot's description stands beside it ("Copy") |
| `components/builder/CLAUDE.md`, "Case-list workspace", the paragraph on the selected field's inspector | "The selected field's inspector ends with the reversible **Hide from results/details** action followed by destructive **Delete information**" | the same, with: "A field hidden from Results shows the switch **List search matches this** above them, in a list with no tile: off is `notOnList`, the field Details alone holds. It is disabled with its reason while Default order uses the field." And its line on Default order's Add menu gains: "A field that is off the list is such a choice in a list with no tile; in a tile list the menu offers it, and choosing it puts it back on the list, hidden, with the rule." |
| `content/docs/case-workspace.mdx`, where it says what hiding a field from Results does | a hidden field is still matched by the list's search | the same, with one sentence: "You can turn **List search matches this** off for a hidden field, and then only Details shows it and Default order can't sort by it." Its "Default order can still sort by a hidden item", of a tile, stays true |
| `content/docs/mcp/tools.mdx`, the paragraph under the case list tools that begins "Hiding a column from Results (`visibleInList: false`) keeps it in the list's search." | it says what hiding does in a list with and without a case tile, and names no other list state (the two tools' rows list no column inputs) | the same, with one sentence: "`notOnList: true` takes a column off the list altogether: only Details shows it, and the list doesn't search or sort by it." |
| `docs/research/2026-09-26-hq-round-trip/inventory/*.md` | the rows of section 14 | as section 14 edits them |

The reader itself changes no public page: what a person reads about what comes in and what does
not is part 13's (13-the-experience.md). The two public pages above change for the column state
of 11.6, which every Nova app gains.

---

## Departures

Each item is a departure from the outline, the manifest or the research, with its evidence, or a
decision this part took with the alternative it weighed and did not take.

1. **From the manifest: `late-flag` is not held.** `menus-and-case-lists/6-late-flag-late-flag-1` is
   HELD with the emission "`late-flag` + `late_flag`". Evidence: Nova writes no `late-flag`
   (`hqJson/caseList.ts::projectColumnToDetail`, the `interval` arm), and HQ's `LateFlag` shows no list
   header (`detail_screen.py::HideShortHeaderColumn`) where Nova's interval column shows its own
   (`columns.ts::intervalFlagXpath`, comment). Decision: HELD-NEW, owner `case-list-and-detail`.
   The step 7 outline already leaves "the remaining column kinds" to its group
   `case-list-and-detail` (`../7-rest-of-model.md`, section 4); this makes the manifest agree.
2. **Several `_xpath_query` rows are held conjunct by conjunct, and two shapes are not-yet where the
   menu's forms do not read the search** (part 01 section 3.5 words the entry's re-cut, "read as one
   condition: their conjunction", and section 14 here narrows it; the outline's item 8 gave the rows
   a new list slot, which is not built). The rows are one conjunction of the cases a search finds,
   and each top-level conjunct
   is held where Nova has a slot that writes it back: a restated clause of the case list filter, a
   Search field's derivation, a condition on an excluded field, or a list filter clause that waits for
   a field. What is left is a conjunct that reads no field and restates no list clause, and a list
   clause the search does not restate, and those two divide by the menu. Evidence: where the menu's
   forms read the search, HQ applies `Detail.filter` to the results
   (`entries.py::EntriesHelper.get_datum_meta_module`), so the two filters are one conjunction on the
   device and both shapes are held, each as a declared change (`search-filter-joined-to-list`,
   `search-restates-list-filter`). On every other searching menu
   `remote_requests.py::_build_datum_nodeset` gives the results no `Detail.filter`, so HQ's two
   filters are independent, and Nova's one `caseListConfig.filter` is written to both
   (`xpathQuery.ts::composeXPathQueryClauses`): reading the conjunct into Nova's one filter would
   narrow the device's list, and dropping a list clause from the search's rows would widen the search.
   Decision: two HELD-NEW entries for the two independent shapes on those menus alone (section 14).
   Not done: holding every row as one conjunction on every searching menu, because on a menu whose
   forms do not read the search that narrows the device's list or widens the search, as above.
3. **From the manifest: a date Search field HQ matches is not held.** `case-search/input-date` is HELD as
   "scalar `date`". Evidence: `simpleArmDerivation.ts::simpleArmNeedsXPathQueryEmission` returns true for
   every exact date field, so Nova always writes `exclude` and a whole-day clause, and
   `case-search/default-properties-entry-keyed-by-a-plain-property-property-p`'s own cell says a clause
   ignores the project space's fuzzy and ignore-pattern settings that HQ's matcher applies. Decision: the
   bare shape is HELD-NEW, owner `case-search`. The same function returns true for a field over
   `case_id`, `owner_id` or `status` (`emitCasePropertyWirePath(property) !== property`), so a bare
   prompt of one of those names is HELD-NEW too, and `case-search/a-search-key-named-owner-id` stays
   HELD for the shape Nova writes, the excluded prompt beside its row.
4. **From the outline (item 10, "Placements": "the reader ... holds each").** A Save to Case block is
   held only in Nova's own shape (the top-level file `../6-bring-in.md`, "What changed from the
   outline, and why", item 10; a Save to Case question at an authored position is step 7's, group
   `xform`); this part states the boundary as four mechanical tests and gives it one entry, and
   narrows the nine HELD Save to Case rows' wording to that shape.
5. **From the outline (item 10, "An advanced form's case selections").** The
   chain is built from the loads, not tested against a stored one (HQ stores none on an advanced menu).
   And a tag on a load that changes no case is a new not-yet class the outline did not name. Evidence:
   `models/modules.py` (`parent_select` on `Module` and `ShadowModule` only);
   `placement.ts::planAdvancedCore` (`attach` holds a tag only from an operation's placement).
6. **Datum id agreement is the equality of the facts HQ's entry builder reads, never of entry datums
   themselves.** No read holds HQ's entry datums: the source has no suite. Decision:
   equality of the facts HQ's entry builder reads (`hqEntryFacts`), form by form and menu by menu, with
   `entryFacts.corpus.test.ts` holding the list complete for every shape Nova emits and lane proof 3
   holding the mirror (section 6.3). Not done: requiring HQ's entry datums for each form to equal
   `entryDatumIds`, because
   nothing a reading holds gives them.
7. **A column the case detail alone shows is read exactly, as a column that is not on the list.**
   Outside a tile list Nova wrote every column of the list sequence into the short detail, one
   hidden from the list as an `invisible` field (`caseListOrder.ts`, rule 1), which a device
   matches when a worker filters the list. A detail column the source's list does not hold would
   so have joined the list's filter at the first publish, in nearly every app whose detail shows
   more than its list. Section 11.6 gives a column its third list state, not on the list, which
   is no field of the short detail, and the reader reads such a column into it (11.3, rule 4).
   Not done: declaring the change as a first-publish entry that touches workers, which changes
   what a worker's filter finds in an app nobody edited. Not done: refusing the column, which
   would turn away nearly every app.
8. **From the outline (item 10, "Case writes": an advanced load's preload stays HELD-NEW in the
   manifest).** It reads as a default under the same rule as a basic preload, so the entry splits and
   its same-state class becomes HELD.
9. **From the manifest's REFUSED row for a basic preload; and a preload a later load-time value
   reads is refused at not-yet, not declared.** A reordering of a setvalue that reads another node is
   never free: each is refused or declared (part 09, section 11.4, the row "Preload order").
   Decided as not-yet, for a basic and an advanced preload alike. Not done: declaring the reordering
   as a first-publish change, because a form would then open with other values than it does today.
   The manifest refuses the basic one as "not HQ-editable: no editor
   writes basic `case_preload`", which would tell a person there is something to change in CommCare
   HQ. The cell's fact stands: the basic Case Management page draws no load section
   (`templates/app_manager/partials/forms/case_config.html`, `case-config:case-transaction`; the
   template `case-config:case-transaction:case-preload` is drawn by `case_config_advanced.html`
   alone). Evidence against the standing: a stored basic preload is kept by that page's save
   (`forms/case_config_ui.js::HQFormActions.from_case_transaction`) and written by HQ's build
   (`xform.py::XForm._create_casexml`, `add_case_preloads`), so CommCare HQ does save and build it,
   and the page gives a person no control that moves or removes it. The shortfall is Nova's: a
   preload held with its place at the end of the load, the same one the advanced load's entry names.
   The entry is re-cut to HELD-NEW with owner `forms-and-case-management` (section 14).
   The rule is structural (`laterLoadReaders`), which is sufficient and may raise the finding for a
   form whose later reader happens to see the same value; exactness there would need Core's load
   executed, which the reader does not do.
10. **From the outline (item 10, "Search and menus": "refuses `auto_launch: false` where Web Apps is
    declared").** A reading has no declaration yet. The reader decides by the HQ app's own
    `cloudcare_enabled`: true is the manifest's `never` row; false reads `listFirst`, and the proposal
    is then Android only (part 06's `planDeclarationChoices` offers no other choice, 12.1). And from
    the manifest's row for that shape, which
    reads `default_search` as "any": HQ writes it into the search's query whatever `auto_launch` says
    (`remote_requests.py::RemoteRequestsHelper.build_remote_request_queries`), and Nova's `listFirst`
    writes it false, so `auto_launch: false` beside `default_search: true` is a new HELD-NEW entry and
    the HELD row is narrowed to `default_search: false`.
11. **Confirmations (outline items 9 and 10).** No confirmation is asked by a reader.
    `commtrack-off`, `form-entry-sync-off` and the `same-type-child-links` probe stay the first
    publish's, as part 10 and part 05 decide. One project-space fact is read with the app, because
    the reading's meaning turns on it: whether the source project space applies "save only if
    changed" (`SAVE_ONLY_EDITED_FORM_FIELDS`, step 5's capability `save-only-edited-answers`,
    `lib/commcare/projectSpaceCompatibility.ts`). HQ's build reads `update_mode: edit` only under
    that flag (`xform.py::XForm`, `self.save_only_if_edited`), so the same stored word saves a
    changed answer alone in one project space and every answer in another. The read probes
    the flag where `publishedCaseBlocks.ts::sourceHoldsEditMode` says the source holds the word
    (part 05, section 10.5, "The flag a bring-in reads"; part 12, section 3.3, places the read),
    and the reader reads the word as what the build does (3.2). The adoption records nothing for
    it: the capability is nothing a person confirms, and every publish probes the project space
    itself, so the first publish finds the flag as the reading found it and asks nothing (part
    10, section 6.5). Not done: reading `edit` as `onlyIfChanged` whatever the flag, which would stop
    the first publish of an app that runs today on a capability its project space never had, and
    would have Preview save a changed answer alone where the app's own build never did.
12. **A menu's own shape is read before case management, and a link's condition is registered
    last.** The reader's work falls into four layers, structure, case management, menus, then
    expressions, and its stages run in that order (part 06's `STAGES`, 06-the-reader-forms.md,
    section 2.3, lists them) but for two structural reads of this part, which run out of that
    order, each for a dependency read at source. A
    basic menu's parent selection is read with the menus, ahead of case management, because the
    catalog's parent types, a `via` write, a `parent/` preload and an advanced chain through a basic
    menu all read it (`advancedEntryDatums.ts::advancedLoadChain` walks
    `Module.parentCaseModuleUuid`). And a link's condition is registered last, after the lists and
    searches, because which of its conjuncts are the emitter's guards is decided by
    `lib/domain/afterSubmit.ts::guardedLinkDatums`, which reads the target entry's selections. Everything an
    expression decides still settles after part 08 binds.
13. **A link that carries a case by hand gains its guard at the first publish, declared, not read
    exactly.** Nova's emission conjoins a held-case guard to every such link, HQ's pages write none, so
    the first publish adds one (9.4). Not done: reading it exactly, which would need a link that
    carries a value unguarded, and Nova refuses to write one on purpose (`lib/commcare/CLAUDE.md`,
    "No runtime prompt on an unmatched datum" and the held-case conjunct of "Destinations and the
    otherwise"). Not done: refusing it, which
    would refuse every HQ app whose link names its target's case. Decision: declared, as the
    worker-touching register entry `link-held-case-guards-added` (part 09, section 11.2).
    The guard is one of the checks Nova's emitter conjoins, each of which is read exactly, refused or
    declared (part 09, section 11.4).
14. **A class this part can name gets an entry, and `unrecognized` is kept for what no rule
    classified.** The rule that an item no entry names is refused under the circumstance
    `unrecognized` (part 01, section 8.3; part 06, section 4.4) is unchanged as a rule, and
    narrowed in use: a class this part can name gets an entry with a subject and an owner (section
    14), because part 04 hands the wider grammars to the part that reads them and because a finding
    under `unrecognized` has no subject and no step 7 group.
    Evidence that the classes are ordinary: HQ's own page builds a tag from the case type as typed
    (`advanced/case_config_ui.js::addFormAction`), so a hyphenated case type alone would give an
    `unrecognized` reading. Not done: leaving those classes under `unrecognized`, where a person
    reads that Nova met something it does not know, of a shape Nova knows well (13.2).
15. **A case list menu item with no label of its own is read as the text CommCare HQ writes for
    it.** HQ's build writes the literal "Case List" for a label with no text
    (`app_strings.py::_create_case_list_app_strings`: `clean_trans(module.case_list.label, langs)
    or "Case List"`, with no `gettext`, so the words are the same in every build and every
    language). Nova's absent label shows the menu's name, so the reader stores the words HQ shows
    (8.6). Not done: a not-yet entry for the blank label, which would turn away an app over text
    Nova can state exactly.
16. **A column the list does not carry is a state of the column, and not the absence of the column
    from the list's sequence.** `caseListConfig.listColumnOrder` names every column from birth
    (`lib/domain/CLAUDE.md`), and every reader of the list's sequence reads it as the whole set.
    Not done: leaving a column out of `listColumnOrder`, which would make "not on the list" a fact
    every such reader had to learn, and would give the detail two spellings of "not shown". Not
    done: replacing `visibleInList` with one three-valued slot, which would change the stored shape
    of every column hidden today for no gain a reader can see. The slot is a literal beside
    `visibleInList: false`, as `Module.hiddenFromMenu` stands beside a display condition (11.6).

---

## Files

**New.**

- `lib/commcare/reader/caseManagement/index.ts` (`readCaseManagement`, `settleCaseManagement`,
  `compareEntryFacts`), `formType.ts` (`readFormType`, `FindingEntry`), `conditions.ts`
  (`readActionCondition`, `ReadCondition`), `basicActions.ts` (`readBasicActions`,
  `questionValue`, `ownerQuestionPath`), `preloads.ts` (`laterLoadReaders`, `readPreloads`,
  `settlePreloads`), `advancedActions.ts` (`readAdvancedActions`, `readLoadChain`),
  `saveToCase.ts` (`readSaveToCaseBlocks`), `saveToCaseCompare.ts` (`blockTreesEqual`),
  `catalog.ts` (`readCaseCatalog`, `noteProperty`, `catalogAsRead`). There is no
  `caseManagement/connect.ts`: Connect blocks are read by part 06 (10.2).
- `lib/commcare/reader/menus/index.ts` (`readMenus`, `settleMenus`), `modules.ts`
  (`readModules`, `caseListLabelAsBuilt`), `navMedia.ts` (`readNavMedia`), `registration.ts`
  (`readCaseListRegistration`), `afterSubmit.ts` (`readAfterSubmit`, `registerLinkExpressions`,
  `settleAfterSubmit`, `linkGuards`), `entryPoints.ts` (`readEntryPoints`).
- `lib/commcare/reader/caseList/index.ts` (`readCaseLists`, `settleCaseLists`), `columns.ts`
  (`readDetailColumn`, `ColumnProposal`), `details.ts` (`readCaseDetails`, `joinDetailColumns`),
  `order.ts` (`readSortElements`), `tile.ts` (`readTile`).
- `lib/commcare/reader/search/index.ts` (`readSearches`, `settleSearches`), `workflow.ts`
  (`readSearchWorkflow`), `prompts.ts` (`readSearchPrompts`), `settings.ts`, `rows.ts`
  (`classifySearchRows`, `RowClassification`, `ConjunctPlacement`).
- `lib/commcare/reader/candidate.ts` (`withCandidate`), `projectionInputs.ts`
  (`ReadProjectionInputs`, `readProjectionInputs`), `hqPageLabels.ts` (`HQ_PAGE_LABELS`).
- `lib/commcare/hq/entryFacts.ts` (`HqEntryFacts`, `ENTRY_FACT_KEYS`, `HqMenuFacts`,
  `MENU_FACT_KEYS`, `HqAppEntryFacts`, `hqEntryFacts`, `entryFactsDifference`,
  `menuFactsDifference`, `datumIdsFromFacts`).
- `lib/commcare/validator/rules/case-list/columnNotOnList.ts` (the rule of 11.6).
- `lib/commcare/__tests__/formLinkDocArbitrary.ts`, the link generator moved out of
  `formLinkProjection.property.test.ts` unchanged, which then imports it.
- Every test file "Tests" names that does not exist today, beside the module it holds.

**Changed.**

- `lib/commcare/hq/publishedCaseBlocks.ts` (section 6.1: the extended blocks, `unread`,
  `sourceHoldsEditMode`; `activeActions` and `activeActionTypes` exported unchanged) and its test.
- `lib/commcare/expander.ts` (`toHqFormLink` exported, unchanged).
- `lib/commcare/xform/caseSaveReferences.ts` (`caseSaveReferencesOf`, split from
  `caseSaveReferences`, 5.3) and its test.
- `lib/commcare/reader/types.ts` (`ReadFacts` gains `sameStateRewrites` and `entryFactsRefused`);
  `lib/commcare/reader/context.ts` (`DraftForm.operationIdPaths`, 5.2);
  `lib/commcare/reader/index.ts` (`STAGES` runs this part's ten functions in the order of 2.1);
  `lib/commcare/reader/assemble.ts` (the seven rows of `READER_CANONICAL_CHOICES` "Tests" lists).
- `lib/domain/modules.ts` (`notOnList` on `columnCommonSlots` and `ColumnCommonSlots`,
  `columnOnList`, `caseListColumnRuns`), `lib/domain/caseListOrder.ts` (rule 1 and rule 4 skip a
  column that is not on the list).
- `lib/commcare/validator/errors.ts` (the code `CASE_LIST_COLUMN_NOT_ON_LIST_INVALID`),
  `lib/commcare/validator/gate.ts` (its class in `VALIDITY_CLASS_BY_CODE`),
  `lib/commcare/validator/rules/module.ts` (the rule joins `CASE_LIST_ORDER_RULES`) and
  `lib/doc/userFacingErrors.ts` (its two builder lines in `USER_MESSAGE_BY_CODE`) (11.6).
- `lib/agent/tools/case-list-config/shared.ts` (the `notOnList` input on `columnInputSlots`),
  `addCaseListColumns.ts` and `updateCaseListColumn.ts` (in each, `true` writes
  `visibleInList: false` with it, and the pairing with `visibleInList: true` is refused before
  staging), `lib/agent/summarizeBlueprint.ts` (the read lines of 11.6), the authoring guide's case
  list paragraph in `lib/agent/authoring/reference.ts`, and `scripts/test-schema.ts` (the prompt
  of each of the two tools' existing entries sends a column with `notOnList: true`).
  `lib/agent/tools/getModule.ts` does not change: it returns the config as stored.
- `components/builder/case-list-config/workspaceProjection.ts` (`takeColumnOffList`,
  `keepColumnOnList`, and `showColumnOnDisplay` clearing `notOnList` with `visibleInList`),
  `CaseListConfigWorkspace.tsx` (the switch of 11.6 in a column's inspector) and
  `SortPriorityStack.tsx` (in a tile list the Add menu's column for a field that is off the list
  drops `notOnList`).
- `lib/commcare/surface/entries/forms-and-case-writes.json`, `menus-and-case-lists.json`,
  `case-search.json`, `questions.json` and the four inventory files (section 14);
  `proof/checks/manifest_value_classes.py` and `proof/checks/test_manifest_value_classes.py` (the
  two lane readers of section 14, with their shapes).
- `lib/publish/hqFindings.ts` and `lib/publish/hqFindingCopy.ts` (the two subjects and the
  sentences "Copy" names, which part 01 words).
- `lib/deployment/CLAUDE.md`, `lib/commcare/CLAUDE.md`, `lib/domain/CLAUDE.md`,
  `components/builder/CLAUDE.md`, `content/docs/case-workspace.mdx` and
  `content/docs/mcp/tools.mdx` ("Contracts and docs these changes make false").

The list and search readers' (R2) is one call to the exported
`hqJson/caseList.ts::projectCaseListForHq` per menu, whose result holds the columns, the sort
elements, the filter, the tile keys and the search config; none of that file's private functions
is exported. `biome.json` needs no edit: the reader is inside `lib/commcare`.
