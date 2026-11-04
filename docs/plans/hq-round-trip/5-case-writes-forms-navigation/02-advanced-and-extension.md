# Step 5, part 02: Advanced modules and extension child cases

Part of [step 5's plan](../5-case-writes-forms-navigation.md) ("Case writes, forms and navigation"),
which holds the baseline, the decisions, the stack and the exit. This part holds the emission of every
case-write placement (a basic form action slot, a Save to Case block, an advanced action and its tag)
from one plan per form; when a module is emitted as CommCare HQ's advanced module, what keeps it
from being one, and the advanced kind a publish holds; the advanced module and form as Nova writes
them in the HQ import body and mirrors them in the local `.ccz`; every rule HQ's build and editors
hold for advanced modules, each placed where Nova enforces it; the case list menu item of an
advanced module; defect 24 (extension child cases as case operations, the inert subcase removed);
the add-ons and the sync-on-form-entry reasons advanced forms touch; CommTrack's wire triggers (the
confirmation itself is part 03's); the platform rows advanced emission reaches; and gated runs G2,
G3, G4 and G6.

Citations are `path::symbol`: Nova at `main` `2f985ed6` (#825, step 4's fifteen pull requests
merged and its cutover run), and the Dimagi checkouts at commcare-hq `d6c6e16d8ae1`, commcare-core
`8e9ba8d908e9`, commcare-android `7a5584475580`, formplayer `24383ac71bfb` and commcare-connect
`046c7fd78081` (the commits `proof/pins.json` names), and Vellum `01215f251c57`, the build HQ vendors
at its pin (`corehq/apps/app_manager/static/app_manager/js/vellum/version.txt`). Every HQ path below is under `corehq/apps/app_manager/` unless it says
otherwise. Every CommCare fact this part states was read at its pin during planning; nothing was
executed (section 28).

Pull request numbers are the stack's (decisions, "Stack"): 2 attachment mode removed, 4 case writes
as one concept, 5 held placements and identity moves, 6 publish placements, 7 advanced modules and
extension child cases, 8 CommTrack and same-type child links at publish, 10 search workflow, menu
concepts and claims, 11 form links, 12 builder, 13 agent, 14 cutover, 15 contracts and public docs.
Pull request 7 is this part's; it also writes the basic and Save to Case arms of the emission plan,
with the read of held paths, into pull request 4 (section 30 says why), one reader into pull request
8, and the advanced module's case list menu item beside forms (its readers, its manifest flip and its
witness) into pull request 10, the first pull request in which a module holds a menu item beside its
forms. The other parts are named by number: part 01 case writes, part 03 publish and the ledger,
part 04 questions, part 05 search and menus, part 06 form links, part 07 authoring, part 08 proof,
part 09 the cutover, part 10 the stack and contracts.

| Section | Owns | Pull request |
|---|---|---|
| 1 | what Nova does today | |
| 2 | the CommCare facts this part relies on | |
| 3 | one plan per form, and the emission of basic and Save to Case placements | 4 |
| 4 | when a module is emitted advanced: the kind, its triggers, its blockers | 7 |
| 5 | the held kind | 7 |
| 6 | the selections of an advanced form, derived from the parent selection | 7 |
| 7 | the HQ JSON of an advanced module and form | 7 |
| 8 | tags | 7 |
| 9 | what an advanced action can express (eligibility) | 7 |
| 10 | the owner of an advanced open action (`nova_owner_<op>`) | 7 |
| 11 | preloads in an advanced form | 7 |
| 12 | the form source and the local injection | 7 |
| 13 | session datums, on both paths | 7 |
| 14 | extension child cases (defect 24) | 4, 7 |
| 15 | `FORM_LINK_NEEDS_NEW_CASE_DATUM` | 7 |
| 16 | every HQ advanced rule, and where Nova holds it | 7 |
| 17 | the case list menu item of an advanced module | 7, 10 |
| 18 | add-ons, plan privileges, sync on form entry | 7 |
| 19 | CommTrack's wire triggers | 7, 8 |
| 20 | platform rows and Preview | 7, 10 |
| 21 | identity moves this part plans | 7 |
| 22 | what the builder, the SA and MCP read from this part | 7, 12, 13 |
| 23 | migration classes for the one cutover | 14 |
| 24 | proof | 4, 7, 8, 10 |
| 25 | contracts and docs these changes make false | 7, 15 |
| 26 | tests, with the boundary each earns | 4, 7, 8 |
| 27 | departures | |
| 28 | executed during planning | |
| 29 | written and not yet run: G2, G3, G4, G6 | 7 |
| 30 | files by pull request | 4, 7, 8, 10 |
| 31 | what other parts read from this one, and what goes to the outlines | |

No change of this part's own moves `MODEL_CONTEXT_VERSION` (`lib/models.ts`,
`"v5-hq-round-trip-platforms.12"` at `main`): none changes a served tool's name, description or input
schema, and the one new refusal reaches the SA and MCP through the gate's ordinary finding text.
Pull request 7 still sets it to `"v6-hq-round-trip-case-writes.7"`, for part 07's guide paragraph
that names advanced menus and, under G6's outcome B, its `addCaseOperations` sentence (part 07 §4.7;
decisions, resolution 14). `RUNTIME_VERSION`
(`lib/db/appTests.ts`, 17 at `main`) moves once, in pull request 3 (decisions, resolution 14); an
App Test's evaluation does not read a module's emitted kind.

---

## Decisions in brief

1. **One plan per form.** `lib/commcare/casePlacementPlan.ts::planFormCaseWire(doc, formUuid)`
   turns the placements part 01's procedure gives (held, else the simplest) into everything the
   wire needs from them: the HQ form actions (basic `FormActions` or `AdvancedFormActions`), the
   Save to Case blocks of the source, the generated nodes those need, the session datums of the
   entry, and the blocks the local `.ccz` splices in. Every emitter, the suite projection, the
   add-on and privilege derivations and Preview read it, so the action list, the datum list and
   the block paths cannot disagree. It lands in pull request 4 with its basic and Save to Case
   arms and the held paths it writes verbatim; pull request 7 adds the advanced arm.
   `subcaseWire.ts::hqCaseActions`, a post-process over finished actions, is deleted in pull
   request 7.
2. **A module is emitted advanced exactly when** its kind is held (`Module.heldKind: "advanced"`),
   or one of its forms holds a create that an after-submit link carries and that no basic
   placement gives a session datum (so the create takes an advanced open action, the only
   advanced-placed operation step 5 has), and in either case no kind blocker holds
   (`lib/commcare/moduleKind.ts::emittedModuleKind`). There is no third trigger in step 5: no form
   selects a case beyond its module's own chain (decision 3). Every form of an advanced module is
   an `AdvancedForm`; a survey there has empty actions.
3. **No stored `Form.caseSelections` in step 5.** The selections an advanced form makes are its
   module's parent-selection chain, which `Module.parentCaseModuleUuid` already states; this part
   derives each load (its type, its list module, its tag, its index name) from it and stores
   nothing beside it. There is no `selection` operation target and no `form-case.selection` read.
   Stored case selections (several selected cases per form, a second case chosen from another
   menu's list, auto-selection, computed datums) are written into the step 7 outline (group 6), with
   the reason that no Nova document needs them before an imported advanced form; step 6's import
   refuses an advanced form whose selections its module's chain does not give, naming each.
   *Departure* from the briefs and the research, which stored a selection list; the reason is in
   section 6.3.
4. **Four kind blockers keep a module basic:** a several-case list, forms that read the search, a
   case list menu item whose list is narrowed (a filter, a hidden owner, or a case chosen before
   it), and children that link to their parent case under more than one name. A blocked module
   that a carried create needs refuses that create's link (decision 13); a held kind a blocker
   meets is moved back to basic as an identity edit (section 21).
5. **`Module.heldKind?: "advanced"`** is written only through part 03's `holdPlacements` (by a
   `publish-placement` change, or by the cutover's `blueprint-migration`), and an editor clears it
   only where a blocker leaves it unable to express the module, or restores it in the undo of that
   move (part 03's kernel rule). The slot and the `module-kind` target land together in pull request
   7: before it no module is emitted advanced, so nothing can hold one. No authoring tool or builder
   control carries it.
6. **HQ's own key sets.** `AdvancedModule` and `AdvancedForm` are written with the keys HQ's models
   and its advanced pages write, with HQ's `new_module` default `product_details`, no
   `parent_select`, `display_style`, `requires` or `schedule`, `details_module` always written,
   `show_product_stock: false` and `product_program: ""`. Gated run G2 runs HQ's saves over them.
7. **Tags are the advanced page's spelling:** `load_<case type><n>`, `open_<case type>_<n>`,
   `autoload_commcare_user<n>`. A held tag is kept; a derived one steps around every tag of the form
   and every name its root data holds.
8. **HQ's per-action rules are eligibility, never refusals.** Every condition HQ's build or editors
   hold on a load or an open action is a clause of `lib/commcare/advancedPlacement.ts`; an operation
   an advanced action cannot express takes a Save to Case block, which expresses every operation. The
   one rule with no fallback becomes a validator code (decision 13).
9. **Preloads stay the question's default in an advanced form** and every `LoadUpdateAction.preload`
   is `{}`. *Departure* from the research and both case-write briefs (section 11): HQ appends a
   preload after every setvalue, so a preload written there would change what a later default reads
   whenever a module turned advanced.
10. **Extension child cases (defect 24).** An extension child case is a create operation with an
    `extension` link (part 01). It takes a Save to Case block in `nova_operations` with a `uuid()` id,
    or an advanced open action where a link carries it. The inert basic subcase goes, basic subcases
    hold child creates only and renumber, and `nova_subcases` is written only where a held Save to
    Case path names it. A held Save to Case placement of a create a link carries cannot express it,
    so the link edit moves it, stated before it commits.
11. **Carrying is not only for extensions.** The rule of decision 10 applies to every non-repeat,
    unkeyed create a link carries. *Departure* from the wire brief's D8, which named extension
    creates: the same create, carried, needs the same datum whatever its link's relationship.
12. **An extension-only open action owned by the worker writes `owner_id`** from a generated Hidden
    Value `nova_owner_<operation id>` reading the session's user id; HQ's build would otherwise
    leave the case unowned (`-`). Gated run G6 settles that Core applies the worker over the `-`.
13. **One new validator code, `FORM_LINK_NEEDS_NEW_CASE_DATUM`,** refuses a document where a link
    carries a create that no placement can give a datum, naming the link, the blocker or the clause,
    and offering the menu. Gated runs G3 and G4 may add eligibility clauses or a code (section 29).
    The placement gate gains `CASE_PLACEMENT_KIND` and the `module-kind` arm of
    `HELD_PLACEMENT_INEXPRESSIBLE` beside part 01's placement codes (section 5); every other HQ
    advanced rule is an eligibility clause or a kind blocker (section 16).
14. **An advanced module's case list menu item** lists every open case of its type; it is admitted
    only where the module's own list shows the same (blocker 3), so Nova's menu item means one thing
    on both kinds. Pull request 7 emits advanced modules with no menu item beside their forms, since
    no document holds one before pull request 10; the advanced module's case list menu item beside
    forms, its manifest entry (joining `case-list-menu-item` with part 05's G1 outcome), the CommTrack
    menu-item reason's lane witness and `targeted-commtrack-advanced` land in pull request 10.
15. **Add-ons and privileges.** Every advanced form needs `subcases` and `conditional_form_actions`
    (HQ's own in-use predicates); no plan privilege is needed for an advanced module or form.
    `formEntrySyncReasons` keeps step 4's predicate: in step 5 an advanced form requires a chosen
    case exactly when its type is follow-up or close (section 18).
16. **CommTrack's wire triggers.** The emitter's reader `advancedModulesWithCaseListMenuItem(doc)`
    (pull request 8) is the first of part 03's two `commtrack-off` reasons; it reads a menu item
    wherever a module holds one, which before pull request 10 is only a module with no forms. HQ's
    third trigger, `show_product_stock`, is unreachable from a Nova export.
17. **Identity moves.** `lib/doc/moduleKindMoves.ts::planModuleKindMoves` is one source of
    `withIdentityMoves` (decisions, resolution 3), with the one subject `module-kind` (whose sentence
    also names the session values a parent-selecting module's forms read under new names), and runs
    before part 01's `planOperationPlacementMoves`.
18. **Session datums.** The projection gains an advanced branch (`case_id_<tag>` per load,
    `case_id_new_<type>_<i>` per non-repeat open action, HQ's child-module alignment), and every
    `DatumRef` keeps its kinds: a load answers `selected-case`, the registration's open action
    `new-case`, any other open action `new-child-case`, the worker's load `worker-record`.
19. **Nova publishes advanced modules without `APP_BUILDER_ADVANCED`.** The flag gates only adding
    an advanced module in HQ's editor (`views/apps.py`, `show_advanced`); its gate entry keeps
    preflight none, and proof 4 proves HQ's editors keep what Nova writes.

---

## 1. What Nova does today

- Every module is a basic `Module` and every form a basic `Form`:
  `lib/commcare/hqShells.ts::moduleShell` writes `doc_type: "Module"`, `module_type: "basic"`,
  `parent_select`, `display_style: "list"`, `auto_select_case: false`; `formShell` writes
  `doc_type: "Form"`, `requires`, basic `FormActions`. `lib/commcare/types.ts` has no advanced type.
  `proof/targeted/__tests__/unproducedInputs.test.ts`, "defect 20's product_id datum", holds that no
  export reaches an `AdvancedModule`.
- Field writes (`Field.caseWrite`) lower through
  `lib/domain/caseWriteInventory.ts::deriveCaseWriteInventory` and
  `lib/commcare/deriveCaseConfig.ts::deriveCaseConfig` to `lib/commcare/formActions.ts::buildFormActions`:
  `open_case`, `update_case`, `case_preload`, `close_case`, one `OpenSubCaseAction` per child bucket
  (relationship from the catalog's `CaseType.relationship`), `usercase_update`. Authored operations
  (`Form.caseOperations`) are always Save to Case blocks (`lib/commcare/xform/caseOps.ts`) in a
  `nova_operations` group per scope, named by `lib/commcare/xform/generatedNodes.ts::planGeneratedNodes`.
  Part 01 makes the two one concept from pull request 4.
- **Defect 24.** A field write to a direct child type declared `relationship: "extension"` makes a
  child bucket with `relationship: "extension"`. `lib/commcare/subcaseWire.ts::hqCaseActions`
  (called by `lib/commcare/expander.ts::expandDoc`) rewrites every such `OpenSubCaseAction` to
  `condition: never`, keeping its position "because HQ still allocates its session datum and matches
  navigation by that type", while `caseOps.ts` writes the active create as a Save to Case block
  `nova_subcase_<n>` in a `nova_subcases` group, its id an `xforms-ready` setvalue reading the inert
  action's datum (`subcaseSessionDatumId`, `case_id_new_<type>_<i>`). `lib/commcare/session.ts` and
  `lib/commcare/formLinkProjection.ts::entryDatumIds` give the inert subcase its datum and the
  `DatumRef` `{kind: "new-child-case", caseType}`, which after-submit links match by type.
  `lib/commcare/__tests__/extensionCaseFixture.ts` (scenarios `registration`, `followup`, `repeat`,
  `query`, `multiple`, `multiple-repeat`) is the corpus's `case-extension-*` family; its
  `registration` scenario links to an episode follow-up, so the link carries the new extension case
  through the inert datum.
- The case list menu item: `Module.caseListOnly: true` on a formless module emits
  `case_list.show: true`; the platform table's `case-list-menu-item` (`lib/domain/platforms.ts`) reads
  `different` on Web Apps and `runs` on Android; its detector is `lib/domain/platformUses.ts`
  (`module.caseListOnly === true`). Part 05 renames it `Module.caseListMenuItem` and admits it beside
  forms from pull request 10.
- Add-ons (`lib/commcare/addOns.ts::addOnsNeededBy`) read basic actions only; plan privileges
  (`lib/commcare/planPrivileges.ts::requiredPlanPrivileges`) ask `child_cases` where a form's
  `subcases` is non-empty; `formEntrySyncReasons` keys on `CASE_LOADING_FORM_TYPES`.
- `proof/known-defects.json` holds 26 defect 24 entries ("inert subcase"), all on the
  `case-extension-*` documents, held on the controls `case-extension-*-after-13` and `-after-59`:
  6 `manifest`, 19 `proof3`, 1 `proof4` (section 24.1 lists them).

---

## 2. What CommCare does at the pins

| Fact | Source |
|---|---|
| `AdvancedModule(ModuleBase)` holds `module_type = 'advanced'`, `forms`, `case_details`, `product_details`, `case_list`, `search_config`, `show_case_list_optimization_options`, `has_schedule`, `schedule_phases`; it has no `parent_select` and no `display_style` | `models/modules.py::AdvancedModule` |
| A module HQ creates gets one `name` case column and `product_details.short` = one `{format: "plain", header: {<lang>: "Product"}, field: "name", model: "product"}` column, `long` empty | `models/modules.py::AdvancedModule.new_module` |
| `AdvancedModule.is_multi_select()` and `is_auto_select()` are false | `models/modules.py::AdvancedModule` |
| `AdvancedForm`: `form_type = 'advanced_form'`, `actions: AdvancedFormActions`, `arbitrary_datums`, `schedule` (default None), `form_filter`; `requires` is a computed property, `'case'` iff some load is not auto-selected | `models/forms.py::AdvancedForm.requires_case`, `::requires` |
| `LoadUpdateAction`: `case_type`, `case_tag`, `case_properties`, `close_condition`, `details_module`, `preload`, `auto_select`, `load_case_from_fixture`, `show_product_stock`, `product_program`, `case_index`; its session variable is `case_id_<case_tag>` | `models/form_actions.py::LoadUpdateAction`, `::case_session_var` |
| `AdvancedOpenCaseAction`: `name_update`, `repeat_context`, `case_indices`, `open_condition`, `close_condition`, `case_properties`; session variable `case_id_new_<case_type>_<id>`, `id` its index in `open_cases` | `models/form_actions.py::AdvancedOpenCaseAction.case_session_var` |
| `CaseIndex {tag, reference_id = 'parent', relationship in child/extension/question, relationship_question}`; a load's `case_indices` is `[case_index]` when its tag is set | `models/form_actions.py::CaseIndex`, `::LoadUpdateAction.case_indices` |
| An action's data element is `case_<case_tag>` | `models/form_actions.py::AdvancedAction.form_element_name` |
| The advanced page's "add" writes a load tag `('auto' if auto-select else '') + 'load_' + <the module's case type> + <loads so far>` and an open tag `'open_' + <the module's case type> + '_' + <opens so far>` | `static/app_manager/js/forms/advanced/case_config_ui.js::addFormAction` |
| The page checks a tag against `^[a-zA-Z][\w_-]*(\/[a-zA-Z][\w_-]*)*$` and for uniqueness | `static/app_manager/js/forms/advanced/actions.js::actionBase.validate` |
| HQ's advanced save view keeps the posted actions as sent: no quote stripping, unlike the basic save | `views/forms.py::edit_advanced_form_actions`, `::_apply_advanced_form_actions_change` |
| The build of a load: a preload is a setvalue appended after every setvalue already in the form; a load writes `case_<tag>` only when it has `case_properties` or an active close; its id binds the load's session variable (the child-module-adjusted one where `add_parent_datums` renamed it) | `xform.py::XForm._create_casexml_advanced` |
| The build of an open action: `check_case_type` raises `CaseError` unless the type is some module's case type (or `commcare-user` with usercase access); its id is the session variable outside a repeat (a setvalue), `uuid()` inside (a bind); it nests at `case_<tag>/` outside a repeat; inside a repeat, every open action of that repeat (indexed or not) nests at `<repeat>/case_<tag>/` when the repeat holds two or more open actions with `case_indices`, and otherwise its `<case>` is the row's first child at `<repeat>/` | `xform.py::_create_casexml_advanced` (`get_action_path`), `models/form_actions.py::AdvancedFormActions.count_subcases_per_repeat_context` |
| An index to a load reads that load's unadjusted session variable; to an open action, that action's `case/@case_id` path; a `child` index writes no `relationship` attribute, an `extension` one writes `relationship="extension"` | `xform.py::_create_casexml_advanced`, `::XFormCaseBlock.add_index_ref` |
| The owner of an open action is set from `meta/userID` unless `owner_id` is in its `case_properties`, or its indices are all `extension`, or one is `question`; otherwise the `<create><owner_id>` text is `-` | `xform.py::autoset_owner_id_for_advanced_action`, `::XFormCaseBlock.add_create_block` |
| HQ appends `case_<tag>`, `subcase_<i>` and `commcare_usercase` to the data node with no check for an existing child of that name | `xform.py::_create_casexml_advanced` (`create_case_block`, `get_action_path`), `::_create_casexml` |
| An advanced entry's datums are its loads' datums, then `case_id_new_<type>_<id>` with `function="uuid()"` per open action outside a repeat; it adds no query datum for inline search | `suite_xml/sections/entries.py::EntriesHelper.configure_entry_advanced_form`, `::get_new_case_id_datums_meta` |
| A manual load's datum: id `case_id_<tag>`, nodeset `[@case_type][@status='open']` + the target module's list filter + `[index/<reference_id>=<parent load's variable>]`, `detail-select` the target's `case_short`, `detail-confirm` its `case_long` unless a later load indexes this one or the detail is inline, `autoselect` the target's `auto_select_case`; the target is `details_module`, which must hold the load's type, else the form's module when the type matches, else the first module of the type | `suite_xml/sections/entries.py::get_datum_meta_assertions_advanced` (`get_manual_datum`, `get_target_module`), `::get_parent_filter_by_ref_id` |
| A basic parent selection filters `[index/*[not(@relationship='extension')]=<parent>]`: any non-extension index | `suite_xml/sections/entries.py::EntriesHelper.get_parent_filter` |
| The worker's case loaded by `auto_select.mode = 'usercase'`: a function datum `…case[@case_type='commcare-user'][hq_user_id=<session user id>]/@case_id` and an assertion `count(...) = 1` with locale `case_autoload.usercase.case_missing` | `suite_xml/sections/entries.py::get_auto_select_datums_and_assertions` |
| A child module's entry gets its root's first-form datums that need no selection inserted first, as `from_parent` placeholders. A datum whose id collides with a root datum id is renamed `<id>_<case_type>`. Then each selection datum of the root is matched in order against the next remaining datum, which must have the same case type and datum kind and come from a form action, and that datum's id is renamed to the root's (nodeset references rewritten); unmatched datums follow | `suite_xml/sections/entries.py::EntriesHelper.add_parent_datums` |
| The case list menu item of an `AdvancedModule` is one datum `case_id_case_<type>` over `[@case_type][@status='open']` with no filter and no parent; under CommTrack a second `product_id` datum; a basic `Module`'s menu item takes the module's own datums (parent chain and filter) | `suite_xml/sections/entries.py::EntriesHelper.entry_for_module` |
| A form's entry under CommTrack gains a `supply_point_id` datum where its stored source contains `session_var('supply_point_id')` | `suite_xml/sections/entries.py::entry_for_module` |
| The post for sync on form entry is added only where `form.requires_case()` | `suite_xml/sections/entries.py::entry_for_module`, `::include_post_in_entry` |
| An after-submit link matches each target datum to the first source datum of its case type that is not a parent placeholder; an open action's datum carries its `case_type` | `suite_xml/post_process/workflow.py::_find_best_match`, `::_get_datums_matched_to_source` |
| `subcases.used_in_form` is true for any form whose `form_type != "module_form"`; `conditional_form_actions` is true for any such form | `add_ons.py::_ADD_ONS`, `::_uses_conditional_form_actions` |
| Build rules: `AdvancedModuleValidator` (no forms or case list; the six case-list-registration rules; no case type; no case detail; under CommTrack no product detail); `AdvancedFormValidator.check_actions` (missing parent tag, missing relationship question, case_name required, subcase repeat context, `check_case_properties`, no case type in action, auto-select key, source and case ref, Save to Case references, filtering without case, `check_paths`) | `helpers/validators.py` |
| `validate_property` accepts `^[a-zA-Z][\w_-]*(/[a-zA-Z][\w_-]*)*$`; an indexed action's keys must match `^[a-zA-Z][\w_-]*$`; reserved words come from `case-reserved-words.json` | `helpers/validators.py::validate_property`, `::IndexedFormBaseValidator.check_case_properties`, `static/app_manager/json/case-reserved-words.json` |
| A basic form's `all_property_names` includes `usercase_update` keys, all checked by `validate_property` | `models/form_actions.py::FormActions.all_property_names`, `helpers/validators.py::FormValidator.check_actions` |
| No subscription check for advanced modules (only usercase), and the advanced Case Management page reads no add-on privilege | `helpers/validators.py::ApplicationValidator._check_subscription`; `static/app_manager/js/forms/advanced/actions.js` and `forms/advanced/case_config_ui.js` (`hasPrivilege = true`, where the basic page reads `addOnsPrivileges.subcases`) |
| `APP_BUILDER_ADVANCED` (or CommTrack) gates only offering a new advanced module | `views/apps.py` (`show_advanced`), `corehq/toggles/__init__.py::APP_BUILDER_ADVANCED` |
| `Application.commtrack_enabled` reads `Domain.commtrack_enabled`; `show_product_stock` is kept only where the page allows product stock, a checkbox shown only under CommTrack | `models/applications.py`, `static/app_manager/js/forms/advanced/actions.js::loadUpdateAction.unwrap`, `case_config_advanced.html` |

**Claims the pins correct or complete** (each recorded under "Found while planning step 5" in
`docs/research/2026-09-26-hq-round-trip/harness-findings.md` by pull request 7):

- C1. The research's "a parent selection there becomes each form's chained case selections" omits
  that the filter changes: basic lists any non-extension child, advanced only `index/<reference_id>`.
  Section 6.2 decides the index name.
- C2. The research's advanced-module refusals (registration from the case list, a several-case
  list) omit forms that read the search, which an advanced entry cannot carry, and an open action
  indexed to a load HQ renames in a child module. Sections 4.3 and 9.2 hold both.
- C3. The research places a carried extension create on an advanced open action without its owner:
  HQ writes `-` for an open action whose indices are all `extension`, where Nova's Save to Case block
  writes the worker (section 10).
- C4. The outline asks step 5 to decide HQ's third CommTrack trigger, `show_product_stock`: it is
  unreachable from a Nova export (section 19).
- C5. The advanced page tags a load with the module's case type, not the load's; any spelling the
  tag check accepts is one HQ's editors keep. Section 8 uses the load's own type.

**Nova defects found** (no lane check observes them today):

- N1. A question named `subcase_<n>` beside a basic child case's block, or `commcare_usercase` in a
  form that writes the worker's record, collides with the element HQ's build appends (no existence
  check); `lib/domain/questionId.ts::RESERVED_QUESTION_IDS` reserves only `case` for this reason.
  From step 5 `case_<tag>` joins the class. Gated run G3 settles what the collision does.
- N2. A worker property whose slug starts with `_` (admitted by
  `lib/domain/users.ts::USER_PROPERTY_SLUG_PATTERN`, `/^[a-zA-Z_][-a-zA-Z0-9_]*$/`) written by a
  form reaches `validate_property` through `usercase_update`, which reads as `update_case word
  illegal`. Gated run G4 settles it.

---

## 3. One plan per form

### 3.1 The plan

Part 01 decides each operation's placement (`lib/commcare/placement.ts::planPlacements`: held where
held and still expressible, else the first eligible of a basic slot, an advanced action and a Save to
Case block, in the form's operation order). This part turns those placements into the wire. One
function reads them, once per form and document object (documents are replaced, never mutated, so a
`WeakMap` keyed by the document caches it):

```ts
// lib/commcare/casePlacementPlan.ts (new, pull request 4)
export type FormCaseWirePlan =
	| {
			readonly kind: "basic";
			readonly actions: FormActions;                      // HQ basic form actions
			readonly saveToCase: readonly SaveToCaseBlock[];    // blocks the source holds
			readonly datums: readonly PlannedNewCaseDatum[];    // the creates HQ gives a datum
			readonly appendedNames: readonly AppendedBlockName[]; // what HQ's build appends
	  }
	| {
			readonly kind: "advanced";                          // from pull request 7
			readonly actions: AdvancedFormActions;
			readonly saveToCase: readonly SaveToCaseBlock[];
			readonly datums: readonly PlannedNewCaseDatum[];
			readonly appendedNames: readonly AppendedBlockName[];
			readonly loads: readonly PlannedLoad[];             // section 6
			readonly generated: readonly AdvancedGeneratedNode[]; // nova_owner_<op>, section 10
	  };
export interface SaveToCaseBlock {
	readonly subject: { readonly kind: "operation"; readonly operationUuid: Uuid } | { readonly kind: "own-close" };
	readonly scope: FormPath;                 // the form root or the forEach repeat's row
	readonly path: readonly [string, ...string[]]; // element names from the scope to the block
	readonly held: boolean;
}
export interface PlannedNewCaseDatum {
	readonly operationUuid: Uuid;
	readonly id: string;                      // case_id_new_<type>_<i>
	readonly caseType: string;
	readonly ref: DatumRef;                   // new-case or new-child-case
}
export interface AppendedBlockName {
	readonly scope: FormPath;                 // the element HQ's build appends under
	readonly name: string;                    // case, subcase_<i>, commcare_usercase, case_<tag>
	readonly placement: CasePlacement;        // part 01's lib/domain/placements.ts
}
export function planFormCaseWire(doc: BlueprintDoc, formUuid: Uuid): FormCaseWirePlan;
```

Readers: `formActions.ts::buildFormActions` (now the basic projection of the plan), `xform/caseOps.ts`
(Save to Case blocks), `xform/caseBlocks.ts` (the basic local splice), `xform/advancedCaseBlocks.ts`
(the advanced local splice, section 12), `xform/generatedNodes.ts` (held paths and `nova_owner_`
reserved first), `session.ts` and `formLinkProjection.ts` (datums, section 13), `planPrivileges.ts`
(`save_to_case` where `saveToCase` is non-empty; `child_cases` where a basic plan holds `subcases`),
`addOns.ts` (section 18), part 03's `placementsToHold` and `commtrackReasons`, and Preview through the
datum projection. Rejected: a post-process over finished `FormActions`, as `hqCaseActions` is today,
because a placement decides the action list, the datum list and the block path together, and a second
pass could change one without the others.

### 3.2 Basic placements

In a basic form (pull request 4):

| Placement (part 01) | HQ JSON | Source and build |
|---|---|---|
| `{basic, own}` on a registration | `open_case {name_update: {question_path: <the name's nova_trimmed_ sibling>}, external_id: null, condition}` (`condition` from `Form.openCondition`); writes into `update_case.update` (`update_mode: "always"`: part 01 refuses `onlyIfChanged` on a case the form creates); `close_case.condition` from `Form.closeCondition` | HQ's build writes the own `case` block |
| `{basic, own}` on a follow-up or close | `update_case.update` from the own arm's writes (`<via step identifiers>/<property>` for a write with `via`; `update_mode: "edit"` for an `onlyIfChanged` write, else `"always"`), its rename (`name` key: HQ maps `name` to the `case_name` element in `XFormCaseBlock.add_case_updates`, and `case_name` is a reserved word that `check_case_properties` refuses) and its owner (`owner_id` key); `close_case.condition` on a close form, `never` where the own close is placed apart (part 01's `ownClosePlacement`) | HQ's own `case` block; Nova writes no `case_preload` (part 01) |
| `{basic, usercase}` | `usercase_update.update` | HQ's `commcare_usercase` block |
| `{basic, subcase, index}` or `{basic, subcase-row}` | `subcases[index]`: `case_type`, `name_update`, `case_properties`, `repeat_context` (the forEach repeat's path, or `""`), `reference_id: "parent"`, `relationship: "child"`, `condition` from the create's condition, `close_condition` from a sharing close | HQ's `subcase_<index>` block, or the repeat's own row when it is the repeat's only subcase |
| `{save-to-case, path}` | none | a Vellum Save to Case block at `path` from its scope, as `caseOps.ts` writes every operation today |

Conditions are `hqShells.ts::alwaysCondition`, `neverCondition` and `ifCondition` (question, answer,
operator, and nulls on a non-`if` condition, as HQ's page cleans them). Subcases are written in index
order. A basic subcase is always `relationship: "child"`: HQ's basic build ignores
`OpenSubCaseAction.relationship` and its page's save resets it (`case_config_ui.js::
HQOpenSubCaseAction.from_case_transaction`), so `subcases-relationship-extension` and
`subcases-condition-never` stay REFUSED in the manifest and no export writes them after pull request
7 (section 14.4 says what writes them until then).

### 3.3 Save to Case placements

- An unheld block takes the allocator's names as today (`nova_operations`, `nova_condition_<op id>`,
  `nova_keyed_<op id>`, the guards), with every held path at that scope reserved first
  (`planGeneratedNodes` reads the held paths before it allocates; pull request 4, with the
  operation's and the own close's held slots, which only test fixtures and specs write until pull
  request 5's `holdPlacements`).
- A held block is written at its held `path` verbatim, its group elements created where the path
  names them (`nova_subcases` for a published extension create, section 14.3).
- A create's case id outside a repeat is an `xforms-ready` setvalue of `uuid()`, inside one a bind,
  Vellum's spelling for a create (`Vellum/src/saveToCase.js`), as `caseOps.ts` writes every create
  today. No Save to Case block reads a session datum for its id from pull request 7.
- `case_references_data.save` stays derived from the constructed tree
  (`xform/caseSaveReferences.ts::caseSaveReferences`).

### 3.4 Advanced placements

An advanced form's plan (pull request 7) writes `AdvancedFormActions` (section 7.3):

| Operation and placement | Action |
|---|---|
| the `own` arm of a follow-up or close form, `{advanced, tag}` | the own load (the chain's last, section 6.1): its writes and rename (`name` key) into `case_properties`; a close form's close into `close_condition` |
| an `update` or `close` whose target is the own case (`session`) or a chain case (`expression` that is exactly the session datum of a chain selection, `{kind: "session-datum", datum: {kind: "selected-case", module: <list module>}}`), `{advanced, tag}` | that load: writes into `case_properties`, a close into `close_condition`; a close shares the load of an update of the same case (part 01's `CASE_PLACEMENT_SHARED` exception) |
| the `own` arm of a registration, `{advanced, tag}` | `open_cases[0]`, tag `open_<module case type>_0`: `name_update`, `case_properties`, `open_condition` from `Form.openCondition`, `close_condition` from `Form.closeCondition` |
| any other `create`, `{advanced, tag}` | an `open_cases` entry after the registration's: `case_indices` from its links (section 9.2), `repeat_context` from `forEach`, `open_condition` from its condition, `close_condition` from a sharing close |
| a `worker-record` update, `{advanced, tag}` | the worker's load: `case_type: "commcare-user"`, `auto_select: {mode: "usercase"}`, writes into `case_properties`; it is the form's last load |
| `{save-to-case, path}` | none; the block, as in a basic form |

`case_properties` keys follow HQ's: a write's property; `name` for a rename; `owner_id` for an owner
(section 10); `<via step identifiers>/<property>` for a write with `via` on a load that indexes no
other load (section 9.1). `update_mode` is `"edit"` for an `onlyIfChanged` write, else `"always"`.

### 3.5 Readers that change

- `lib/commcare/formActions.ts::buildFormActions(doc, formUuid)` returns `planFormCaseWire(...).actions`
  narrowed to `FormActions`, or throws "This form is emitted as an advanced form; read its advanced
  actions." when the plan is advanced. Its callers that run per form (`expander.ts`, `compiler.ts`,
  `formLinkProjectionContext.formActions`) read the plan instead.
- `lib/commcare/expander.ts::expandDoc` writes `advancedModuleShell` and `advancedFormShell` (section
  7) where `emittedModuleKind` is advanced; the call of `subcaseWire.ts::hqCaseActions` goes in pull
  request 7, with the file (its `subcaseSessionDatumId` moves into `session.ts`).
- `lib/commcare/compiler.ts` calls `addAdvancedCaseBlocks` where it calls `addCaseBlocks` for a basic
  form (section 12).

---

## 4. When a module is emitted advanced

### 4.1 The kind

```ts
// lib/commcare/moduleKind.ts (new, pull request 7)
export type EmittedModuleKind = "basic" | "advanced";
/** The kind the emitter writes for a module: advanced where its kind is held or a carried create
 *  needs it, and nothing blocks it. Memoized per document object. */
export function emittedModuleKind(doc: BlueprintDoc, moduleUuid: Uuid): EmittedModuleKind;
/** Why a module is advanced, for the builder's and the tools' statements (section 22). */
export type AdvancedKindReason =
	| { readonly kind: "held" }
	| { readonly kind: "carried-create"; readonly formUuid: Uuid; readonly operationUuid: Uuid; readonly linkUuid: Uuid };
export function advancedKindReasons(doc: BlueprintDoc, moduleUuid: Uuid): readonly AdvancedKindReason[];
/** Every module emitted advanced whose case list menu item is on, in module order (section 19). */
export function advancedModulesWithCaseListMenuItem(doc: BlueprintDoc): readonly Uuid[];
```

`emittedModuleKind(doc, m)` is `"advanced"` exactly when `advancedKindBlockers(doc, m)` (section 4.3)
is empty and either:

1. `doc.modules[m].heldKind === "advanced"` (section 5); or
2. some form `f` of `m` holds a create `c` in `linkCarriedCreates(doc, f)` (section 4.2) whose
   placement in a basic form gives it no session datum: `planPlacements(doc, f, { moduleKind:
   "basic" })` places `c` neither as the registration's `{basic, own}` nor as a `{basic, subcase}`
   outside a repeat in a module whose list chooses one case.

Otherwise `"basic"`. The option `moduleKind` of part 01's `planPlacements` fixes step 1 of its
procedure ("form kind") for this question, so the kind is computed without asking itself; without the
option, step 1 reads `emittedModuleKind`.

These readers live in `lib/commcare`, not `lib/domain`, because the kind reads part 01's
`planPlacements` and `linkCarriedCreates`, both emission-side. They are the names every other part
reads: whether a menu is emitted advanced is `emittedModuleKind(doc, m) === "advanced"` (the briefs'
`moduleIsAdvanced`), why is `advancedKindReasons` (the briefs' `advancedModuleReason`), and what keeps
a module from being advanced is `advancedKindBlockers` with `heldKindExpresses` (section 4.3; the
briefs' `advancedKindIneligibility`).

A module emitted basic whose `heldKind` is `"advanced"` cannot exist in a committed document: the
blocker that would make it basic makes the held kind unable to express the module, so the
`module-kind` arm of `HELD_PLACEMENT_INEXPRESSIBLE` (section 5) refuses the batch unless it also
clears the hold (section 21).

### 4.2 Which creates a link carries

```ts
// lib/commcare/formLinkProjection.ts (pull request 7)
/** The creates of `formUuid` that its after-submit links carry into a target: the operations whose
 *  new case a link's target receives as its session datum, in operation order. */
export function linkCarriedCreates(doc: BlueprintDoc, formUuid: Uuid): ReadonlySet<Uuid>;
```

It is computed over the form's **candidate new-case datums**: one per create that HQ could give a
datum, which is every `create` with no `forEach` and no `idFrom` (a keyed create's id is built from an
answer, so a `uuid()` datum would never equal it), the registration's `own` arm first, then the others
in operation order, each with its case type. Then, over the form's links (part 06's
`formLinks` and its link otherwise):

- **A link that matches automatically** (`datums` absent) to a form target: the target entry's
  datums that require a selection are matched in order, as HQ's `_find_best_match` does, against the
  source's selection datums followed by the candidate new-case datums, each source datum used once,
  placeholders of a parent module skipped. A candidate the match takes is carried.
- **A link with manual datums, or a link condition,** that reads `{kind: "session-datum", datum:
  {kind: "new-case"}}` carries the registration's own create; one that reads `{kind: "new-child-case",
  caseType: T}` carries the first candidate of type `T` that is not the own create.

The match reads case types only: the source's selection datums and the target's datums are taken from
`formLinkProjectionContext(doc, { entryMetadataOnly: true, moduleKinds: "basic" })`, a context
option that projects every module as basic. Types, order and parent placeholders are the same under
both kinds (only datum ids differ, section 13), so the answer is the same, and the kind of the source
or the target module is never consulted while computing it. A test holds that equality (section 26.1).

The cutover brief's `formLinkCarriesCreatedCase(doc, formUuid, opUuid)` is this function's membership
test; part 09 reads `linkCarriedCreates`.

### 4.3 Kind blockers

```ts
// lib/domain/advancedModule.ts (new, pull request 7)
export type AdvancedKindBlocker =
	| { readonly kind: "several-cases" }                                  // caseSelectionCardinality(module) === "multiple"
	| { readonly kind: "forms-read-search" }                              // inline Search first (formsReadSearch from pull request 10)
	| { readonly kind: "case-list-menu-item-narrowed"; readonly why: "filter" | "hidden-owners" | "chosen-before" }
	| { readonly kind: "chain-index"; readonly childType: string; readonly parentType: string; readonly identifiers: readonly string[] };
export function advancedKindBlockers(doc: BlueprintDoc, moduleUuid: Uuid): readonly AdvancedKindBlocker[];
/** Whether a held advanced kind still expresses the module: part 03's `holdExpresses` for the
 *  `module-kind` target, which its kernel rule reads, and this part's gate arm (section 5). */
export function heldKindExpresses(doc: BlueprintDoc, moduleUuid: Uuid): boolean; // advancedKindBlockers(...).length === 0
```

| Blocker | Holds where | HQ source |
|---|---|---|
| `several-cases` | `lib/domain/modules.ts::caseSelectionCardinality(module) === "multiple"` | `models/modules.py::AdvancedModule.is_multi_select` is false; HQ's advanced entry writes a `SessionDatum` |
| `forms-read-search` | pull request 7: `moduleOpensOnSearch(module)` (today's inline Search first); from pull request 10: part 05's `moduleFormsReadSearch(module)` | `entries.py::configure_entry_advanced_form` adds no query datum, so a form cannot read `results:inline` |
| `case-list-menu-item-narrowed` | the module has its case list menu item (pull request 7: `caseListOnly === true`; from pull request 10: part 05's `moduleHasCaseListMenuItem`) and its list as a basic module shows it is narrowed: `filter`, the effective list rule (`effectiveFilterForEmission(substituteUnansweredSearchInputs(caseListConfig.filter))` is defined); `hidden-owners`, `caseSearchConfig.excludedOwnerIds` is set; `chosen-before`, the module selects a parent (`parentCaseModuleUuid`) or is a child menu whose list follows a case its containing menu chose (`caseSelectionCanFlowBetweenModules`) | `entries.py::entry_for_module`: the advanced menu item lists every open case of the type, with no filter and no parent |
| `chain-index` | the module selects a parent and, for some pair of adjacent modules of its chain (section 6.1), `advancedChainIndex(doc, child's type, parent's type)` (section 6.2) finds more than one link identifier | `entries.py::get_parent_filter_by_ref_id` filters one index by name |

The narrowed test restates in domain terms what the emitter shows: `case_details.short.filter` is
non-null (`hqJson/caseList.ts::projectCaseListFilter`) or the module's basic case-list entry holds
more than one selection datum (`formLinkProjection.ts::entryDatumIds(doc, ctx, moduleUuid)`). A
binding test holds the two equal over every module of the fixture corpus (section 26.1), so the domain
reader the builder offers from can never drift from the wire.

### 4.4 What a blocked module does

- A module that a carried create needs (trigger 2) and a blocker holds stays basic; the create keeps
  the placement a basic form gives it, and `FORM_LINK_NEEDS_NEW_CASE_DATUM` (section 15) refuses the
  document, naming the link and the blocker. So the edit that adds the link, the create or the
  blocker is refused.
- A module whose kind is held and that a blocker meets: the held kind can no longer express it, so the
  batch commits only if it also clears the hold (`holdPlacements` entry with `null`), which
  `planModuleKindMoves` appends and states (section 21). If a carried create still needs the kind, the
  module becomes basic and `FORM_LINK_NEEDS_NEW_CASE_DATUM` refuses the batch as above.

Rejected: a validator code per blocker (`ADVANCED_MULTI_SELECT`, `ADVANCED_INLINE_SEARCH`,
`ADVANCED_CHAIN_INDEX`, `CASE_LIST_MENU_ITEM_KIND_CHANGE`, the wire brief's D11 and D12). Each would
refuse a module for being advanced, but a module is advanced only through a hold, which the identity
move answers, or through a carried create, which the link refusal names. One refusal names the edit
the author can change; four would name a kind the author never chose.

---

## 5. The held kind

**Stored shape** (`lib/domain/modules.ts::moduleSchema`, pull request 7):

```ts
/** Present once a publish or the cutover recorded that CommCare HQ holds this menu as an advanced
 *  module. Written only by `holdPlacements`; an editor clears it only where a blocker leaves it
 *  unable to express the module (`advancedModule.ts::heldKindExpresses`), or restores it in the
 *  undo of that move. */
heldKind: z.literal("advanced").optional(),
```

- **When it lands.** The slot, the `module-kind` target of part 03's `holdPlacements` (its fourth;
  pull request 5 lands the mutation with the other three), the target's dispatch in part 03's
  `holdExpresses`, and this part's gate arms land together in pull request 7. Before pull request 7
  no module is emitted advanced, so no publish, cutover or fixture has a kind to hold, and
  `heldKindExpresses` has no blockers to read.
- **Who writes it.** Part 03's `holdPlacements` mutation, entry target `module-kind`, placement
  `"advanced"` or `null` (decisions, resolution 4). Part 03's `placementsToHold(doc)` holds every
  module whose `emittedModuleKind` is `"advanced"` and whose `heldKind` is absent, in the same
  `publish-placement` change that holds its forms' advanced placements. The reducer
  (`lib/doc/mutations/placements.ts::applyHoldPlacements`, part 03) sets or deletes `Module.heldKind`.
- **Who may change it.** Part 03's kernel rule `lib/db/placementAuthority.ts::placementChangeRefusal`:
  a `publish-placement` or `blueprint-migration` batch may set or clear it. An editor's batch may
  change it in exactly two ways: (a) clear it where the same batch leaves `heldKindExpresses(next,
  moduleUuid)` false (the move of section 21), or (b) restore exactly the hold the latest recording
  for that module wrote (the latest `publish-placement` or `blueprint-migration` row, else the
  greatest fold baseline's snapshot), which admits the undo of that move. Every other editor change
  is refused.
- **No editor writes it.** `updateModule.patch` gains no `heldKind`; no tool schema or builder control
  carries it (part 07's "placements are shown, never chosen").
- **Why the kind is held.** A module published advanced keeps its forms' submission paths
  (`case_<tag>`) and datum ids (`case_id_<tag>`) only while it stays advanced. When the link that made
  it advanced goes, the derived trigger goes; the hold keeps the module advanced so a republish moves
  nothing.
- **Gate.** Two arms join part 01's placement rules in `lib/commcare/validator/rules/casePlacement.ts`
  in pull request 7, both soundness:
  - `HELD_PLACEMENT_INEXPRESSIBLE` gains the subject `module-kind`: a module whose `heldKind` is
    `"advanced"` and `heldKindExpresses` is false, located at the module, `details: {subject: {kind:
    "module-kind", moduleUuid}, held: "advanced", reasons: <the blockers' kinds>}`, with part 01's
    message, `{subject}` reading "the menu “{module name}” as an advanced menu" and the first reason's
    sentence the move reason of section 21.
  - `CASE_PLACEMENT_KIND` (part 01 §13.2 leaves it to this part) refuses a held `advanced` placement in
    a form of a module `emittedModuleKind` reads basic, and a held `basic` one in a module it reads
    advanced, located at the form, `details: {subject, held, moduleKind}`. Message: "CommCare HQ keeps
    “{subject}” in {the held placement's words}, which a form in {an ordinary menu | an advanced menu}
    can't use. Make the change again to see where it moves and confirm it." (`{subject}` as part 01's
    rules name it; the placement words are part 07's `PlacementLabel` words in
    `lib/domain/placementCopy.ts`.)

  Neither is a state an editor reaches: the batch that changes a module's kind also moves its forms'
  held placements, through part 01's planner after `planModuleKindMoves` (section 21).
- `lib/doc/incrementalValidationScope.ts` takes the whole-document gate for any batch that touches a
  module's `heldKind`, `parentCaseModuleUuid`, `caseListConfig.filter`, `caseSearchConfig`,
  `caseListOnly` (`caseListMenuItem` from pull request 10) or case selection cardinality, a form's
  links or otherwise, or an operation's links, `forEach`, `idFrom` or `target`: each can change a
  module's kind, which moves every form of it and every link into it.

---

## 6. The selections of an advanced form

### 6.1 Derived from the parent selection

An advanced form makes the selections its module's parent-selection chain gives, and the worker's
load where it writes the worker's record. No selection is stored:

```ts
// lib/commcare/advancedSelections.ts (new, pull request 7)
export interface PlannedLoad {
	readonly tag: string;                       // section 8
	readonly caseType: string;
	readonly listModule: Uuid | null;           // null for the worker's load
	readonly index?: { readonly tag: string; readonly identifier: string }; // the load it chains to
	readonly own: boolean;                      // the chain's last
	readonly worker: boolean;
}
export function advancedFormLoads(doc: BlueprintDoc, formUuid: Uuid): readonly PlannedLoad[];
```

- **The chain.** For a follow-up or close form of advanced module `m`: the modules from the root of
  `m`'s parent selection down to `m` (`m.parentCaseModuleUuid`, its own `parentCaseModuleUuid`, and so
  on; part of `caseParentSelectionVerdict`'s admitted chain), one load per module in root-first order.
  Each load's `listModule` is its module (HQ's `details_module`, written always), its `caseType` the
  module's case type, and each load after the first indexes the one before it under
  `advancedChainIndex(...)` (section 6.2). The last load is the own load.
- **Registrations and surveys** make no chain load: HQ's basic entry asks for no case before a form
  that requires none (`entries.py::get_case_datums_basic_module`), and an advanced registration
  recognized by `AdvancedForm.is_registration_form` must hold no manual load.
- **The worker's load** comes last when the plan places a `worker-record` update on it (section 3.4).

This is the corrected reading of C1: a parent selection's chain becomes chained loads, and its filter
becomes one named index (section 6.2).

### 6.2 The index name of a chain

```ts
// lib/domain/advancedModule.ts
export type ChainIndex =
	| { readonly kind: "one"; readonly identifier: string }
	| { readonly kind: "several"; readonly identifiers: readonly string[] };
export function advancedChainIndex(doc: BlueprintDoc, childType: string, parentType: string): ChainIndex;
```

The identifiers of every link, in every operation of the app (a `create`'s, an `update`'s, the `own`
arm's), whose case type is `childType`, whose `targetType` is `parentType` and whose relationship is
`child`, deduplicated in document order. None gives `{one, "parent"}` (a basic subcase's index name:
HQ writes `reference_id or 'parent'`, `xform.py::_create_casexml`); one gives it; two or more give
`several`, the `chain-index` blocker. Reason: a basic parent selection lists every child under any
non-extension index; an advanced load lists children under one name. Where the app links a type to
its parent under one name, both lists hold the same cases of the app's own making; where it uses two,
the advanced list would drop some, so the module stays basic.

Rejected: always `parent` (lists none of the children an author linked under another name);
refusing a parent selection where links use a name other than `parent` (refuses what a basic module
lists correctly).

### 6.3 Why no stored selection list (departure)

The briefs and the research name `Form.caseSelections` (`{uuid, tag, caseType, listModule, childOf}`),
with a `selection` operation target and a `form-case.selection` read. In step 5 every selection an advanced form makes is its module's chain: no editor, tool, planner or
migration of step 5 adds a selection the chain does not give. A stored list would be a second
statement of `parentCaseModuleUuid` per form, kept equal to it by a planner that every batch able to
change a module's kind would have to run (the kind is derived from links, creates and settings across
the app), and refused by a rule where the two differed. Deriving the loads keeps one concept (the
parent selection the builder edits today) and leaves nothing to keep in step. What the stored list
would add is identity for a load no chain gives:

- **Tags.** A load's tag is positional (section 8). Where an operation's placement on a load is held,
  its `{advanced, tag}` holds the tag the load then keeps, so a published load keeps its datum and
  block names without a stored selection.
- **A second case from another menu's list**, of any type, beside the chain: written into the step 7
  outline (group 6), with its stored shape, its `DatumRef` (two selections from one list need
  identities `selected-case` cannot tell apart), its Preview list step and its authoring, beside
  auto-selection and computed datums, with the reason that no Nova document needs them before an
  imported advanced form. The step 6 outline records that its import refuses an advanced form holding
  one, naming the form and the load, since the stored selections that would hold it are step 7's.
- **A chain that differs between forms of one module**, which HQ's page allows: written into the step
  7 outline with the stored selections, and into the step 6 outline as the same refusal, since an
  imported app is the first document that can hold one.

So no form selects a case beyond its module's chain in step 5, and `emittedModuleKind` reads the two
triggers that can occur.

### 6.4 The own case of an advanced form

- A follow-up or close form's own case is its own load, the chain's last, which is HQ's
  `last_real_action` (`xform.py::_create_casexml_advanced`): the last non-auto load of the module's
  type. The `own` arm's placement `{advanced, tag}` names that load's tag.
- A registration's own case is `open_cases[0]` (`open_<module type>_0`), so its datum stays
  `case_id_new_<type>_0`, the id the registration's new case has as a basic form, and
  `AdvancedForm.is_registration_form(<module type>)` holds when `open_cases[0]` is the form's only open
  action of the module's type that HQ's `get_registration_actions` counts (no other unindexed create of
  that type, and no indexed one outside a repeat) and the form has no manual load.

---

## 7. The HQ JSON

### 7.1 `AdvancedModule`

`lib/commcare/hqShells.ts::advancedModuleShell(uniqueId, name, caseType, forms, caseDetails,
productHeaderLanguage, languages): HqAdvancedModuleTree` (pull request 7), keys in this order:

| Key | Value |
|---|---|
| `doc_type`, `module_type` | `"AdvancedModule"`, `"advanced"` |
| `unique_id`, `name`, `case_type`, `put_in_root`, `root_module_id` | as `moduleShell` (`put_in_root: false`) |
| `forms` | `HqAdvancedFormTree[]` |
| `case_details` | the same case-list projection a basic module writes (`hqJson/caseList.ts`) |
| `product_details` | `{doc_type: "DetailPair", short: <detailBase with one detailColumn("name", {<default language wire code>: "Product"}), model "product", format "plain">, long: <detailBase with no column>}`: HQ's `new_module` default, INERT without CommTrack (`menus-and-case-lists/advancedmodule-product-details-equal-to-the-default-single-name`) |
| `case_list` | as a basic module (`show`, `label`, media) |
| `case_list_form` | the null shell `{doc_type: "CaseListForm", form_id: null, label: {}}` (a case list registration form needs forms that read the search, a blocker) |
| `search_config` | as a basic module |
| `media_image`, `media_audio`, `custom_icons`, `is_training_module: false`, `module_filter`, `auto_select_case: false`, `comment: ""` | as a basic module |
| `session_endpoint_id`, `case_list_session_endpoint_id` | as a basic module, where it writes them |
| not written | `parent_select`, `display_style` (INERT on an advanced module), `has_schedule`, `schedule_phases`, `show_case_list_optimization_options` |

The default product column is written from pull request 7 on every advanced module, so CommTrack's
sensitivity run (part 03's G1, part 08's G4) reads it from its first half. Under that run's outcome B
(the flipped build fails `validate_app()` with `no product detail`), the column takes the spelling
HQ's check reads in the pull request whose run shows the failure, this table and `hqShells.ts` take it,
and the run repeats; if no spelling prevents the failure at the pin, this section records the build
error beside part 03's changed `COMMTRACK_OFF.consequence`, and section 16's "no product detail" row
reads that consequence instead of "unreachable".

### 7.2 `AdvancedForm`

`hqShells.ts::advancedFormShell(...)`: `doc_type: "AdvancedForm"`, `form_type: "advanced_form"`,
`unique_id`, `name`, `xmlns`, `version: null`, `actions`, `arbitrary_datums: []`,
`case_references_data`, `form_filter`, `post_form_workflow`, `post_form_workflow_fallback`,
`media_image`, `media_audio`, `custom_icons`, `custom_assertions`, `custom_instances`, `form_links`,
`comment`, `session_endpoint_id`, `respect_relevancy`, each with the value a basic form takes. No
`requires` (a computed property of `AdvancedForm`) and no `schedule` (`advancedform-schedule-with-
enabled-false` is INERT: omitted). Where `expander.ts` reads `formShellObj.requires` for a form's
display-condition context, an advanced form reads whether its plan holds a load that is not the
worker's.

### 7.3 Actions

```ts
// lib/commcare/types.ts (pull request 7)
export interface AdvancedFormActions {
	doc_type: "AdvancedFormActions";
	load_update_cases: LoadUpdateAction[];
	open_cases: AdvancedOpenCaseAction[];
}
export interface ConditionalCaseUpdate { question_path: string; update_mode: "always" | "edit" }
export interface CaseIndex {
	doc_type: "CaseIndex";
	tag: string;                       // "" where the load indexes nothing
	reference_id: string;              // "parent" where tag is ""
	relationship: "child" | "extension";
	relationship_question: "";
}
export interface AutoSelectCase { doc_type: "AutoSelectCase"; mode: "usercase"; value_source: ""; value_key: "" }
export interface LoadUpdateAction {
	doc_type: "LoadUpdateAction";
	case_type: string;
	case_tag: string;
	details_module: string | null;     // the list module's unique_id; null for the worker's load
	case_properties: Record<string, ConditionalCaseUpdate>;
	preload: Record<string, never>;    // always {} (section 11)
	close_condition: FormActionCondition;
	case_index: CaseIndex;
	auto_select: AutoSelectCase | null;
	load_case_from_fixture: null;
	show_product_stock: false;
	product_program: "";
}
export interface AdvancedOpenCaseAction {
	doc_type: "AdvancedOpenCaseAction";
	case_type: string;
	case_tag: string;
	name_update: ConditionalCaseUpdate;
	case_properties: Record<string, ConditionalCaseUpdate>;
	repeat_context: string;            // the forEach repeat's path, or ""
	case_indices: CaseIndex[];
	open_condition: FormActionCondition;
	close_condition: FormActionCondition;
}
export interface HqAdvancedForm<XPath = string, LinkXPath = XPath> { /* section 7.2's keys */ }
export interface HqAdvancedModule<XPath = string, LinkXPath = XPath> { /* section 7.1's keys */ }
// HqApplication.modules: (HqModule<XPath, LinkXPath> | HqAdvancedModule<XPath, LinkXPath>)[]
```

Every reader of a basic-only key narrows on `doc_type` first: `addOns.ts`, `session.ts`,
`projectSpaceCompatibility.ts`, `validator/hqJsonOracle.ts`, `xform/caseBlocks.ts`,
`hqJson/caseList.ts`, `hqJson/xpath.ts`, `suite/case-search/claim.ts`,
`suite/case-search/searchSession.ts` and `lib/preview/menuProjection.ts` at `main` (the list is
`rg -l 'parent_select|display_style|\.actions\.subcases|actions\.open_case|HqModule\b|HqForm\b'` over
`lib`, `components`, `proof/corpus` and `scripts`; pull request 7 runs it at its base and narrows each
hit). `hqJson/xpath.ts` serializes the advanced trees, where only `form_filter` is an `HqXPath`.
`validator/hqJsonOracle.ts` gains the two `doc_type`s and their enums (`relationship`,
`auto_select.mode`, condition `type`).

The advanced page's save and the module settings save write every key above with the value Nova
writes, so both are fixed points. Gated run G2 runs both over every advanced document of the corpus.

---

## 8. Tags

```ts
// lib/commcare/advancedTags.ts (new, pull request 7)
export function allocateAdvancedTags(input: {
	readonly loads: readonly { readonly caseType: string; readonly worker: boolean; readonly held?: string }[];
	readonly opens: readonly { readonly caseType: string; readonly held?: string }[];
	readonly rootNames: ReadonlySet<string>;   // every element name the form's root data holds
}): { readonly loads: readonly string[]; readonly opens: readonly string[] };
```

- A load's derived tag is `load_<its case type><n>`, `n` its position among the form's loads; the
  worker's load is `autoload_commcare_user<n>`. An open action's is `open_<its case type>_<n>`, `n`
  its position in `open_cases`. (C5: the page uses the module's type for every new action; using the
  action's own type names what the tag holds, and the page keeps any tag its check accepts.)
- A held tag (an operation's held `{advanced, tag}`) is used as held, before any derived tag is
  chosen. A load holds the tag of any operation placed on it; two operations that share a load share
  its tag (part 01's sharing rule).
- A derived tag takes the smallest `n` at or above its position that leaves it distinct from every
  tag of the form and leaves `case_<tag>` distinct from every name in `rootNames` (authored question
  ids at the root, Nova's generated root names, the root Connect block ids). Rejected: HQ's
  conversion spelling (`load_<type>_0`, `parent`, `models/modules.py::AdvancedModule.add_insert_form`),
  which is not what a person adding actions on the page produces.
- A derived open action's tag in a repeat also leaves `case_<tag>` distinct from every name the
  repeat's rows hold, where HQ's build nests the block when another open action shares the repeat
  (`xform.py::get_action_path`). G3 found outcome A (section 29), so no derived tag ever meets a
  question of its block's name.
- A held tag whose `case_<tag>` an authored question takes where HQ appends it is part 01's
  `HELD_BLOCK_PATH_TAKEN` (gated run G3, outcome A, section 29); the finding offers the next free
  question id.
- Tags never hold `/`: case types exclude it (`lib/commcare/identifierValidation.ts::validateCaseType`),
  and the held tag schema is part 01's `lib/domain/placements.ts::advancedTagSchema` (over
  `XML_ELEMENT_NAME_PATTERN`).

---

## 9. What an advanced action can express

Part 01's procedure tries, in an advanced form, the advanced action before Save to Case. These
predicates decide whether an operation can take one; an operation for which no clause holds is
eligible, one for which any holds is not and takes Save to Case. The values and conditions an action
takes are the basic slots' (part 01): a value is a bare read of a question (`{kind: "term", term:
{kind: "field", uuid}}`), never a label or a container; a name or `external_id` is read through the
question's `nova_trimmed_<question>` sibling where `caseScalarTextGuards` holds it; a capture's link is
its `nova_url_<question>` sibling; a condition is stateable (part 01 §12.1, its forms 1 to 3 over a
select, a Hidden Value or a label) and its answer text holds no `'`, without the own case's
double-quote rule (HQ's advanced save strips nothing, `views/forms.py::edit_advanced_form_actions`).

```ts
// lib/commcare/advancedPlacement.ts (new, pull request 7); part 01's planPlacements calls both
// as the eligibility of its advanced action (a load, or an open action).
export type AdvancedIneligibility =
	| "value-not-a-question" | "write-condition" | "condition-not-stateable" | "name-repeat"
	| "via-on-indexed-load" | "owner" | "retype" | "link-target" | "link-renamed-load"
	| "repeat-shared" | "type-not-a-menu" | "keyed" | "appended-name-taken"
	| "worker-property-name";
export function loadIneligibility(doc: BlueprintDoc, formUuid: Uuid, operationUuid: Uuid | "own"): AdvancedIneligibility | undefined;
export function openActionIneligibility(doc: BlueprintDoc, formUuid: Uuid, operationUuid: Uuid | "own"): AdvancedIneligibility | undefined;
```

The first clause that holds, in the order of the tables, is the one returned; part 01's move reasons
and section 15's copy read it.

### 9.1 A load

An `own` arm of a follow-up or close form, an `update` or `close` of a chain case, or a
`worker-record` update:

| Clause | Holds where | HQ source |
|---|---|---|
| `value-not-a-question` | a write value or a rename is not a bare question read, or reads a question inside a repeat | `xform.py::_create_casexml_advanced` binds a load's update to one absolute path; `check_paths` |
| `write-condition` | a write carries a `condition` | `ConditionalCaseUpdate` holds no condition |
| `condition-not-stateable` | the close's condition is not stateable or its answer holds `'` | `xform.py::XForm.action_relevance` interpolates the answer unescaped |
| `via-on-indexed-load` | a write has `via` and the load indexes an earlier load (a chain load after the first) | `helpers/validators.py::IndexedFormBaseValidator.check_case_properties` (`subcase_names`) |
| `owner` | an `owner` that is not absent, `acting-user`, `unowned` or a bare question read (a location term) | the key `owner_id` takes one question path |
| `retype` | a `retype` | `case_type` is a reserved word (`case-reserved-words.json`) |
| `link-target` | the operation adds or changes a link (a load's one index is its chain's) | `LoadUpdateAction.case_index` is a single index, set by the chain |
| `appended-name-taken` | never met (G3 found outcome A): a load's derived tag steps around every root name (section 8), and a question that takes a held tag's `case_<tag>` is `HELD_BLOCK_PATH_TAKEN` | N1 |
| `worker-property-name` | under G4 outcome A only, the worker's load: a property fails `^[a-zA-Z][\w_-]*$` | N2 |

A chain case is updated or closed through its load only where the operation's target is exactly the
session datum of that chain selection (section 3.4); any other target (an expression computing an id,
an earlier create) takes Save to Case.

### 9.2 An open action

A `create`, or the `own` arm of a registration:

| Clause | Holds where | HQ source |
|---|---|---|
| `keyed` | the create has `target.idFrom` | an open action's id is `uuid()` or its session variable |
| `value-not-a-question` | the name or a write value is not a bare question read, or reads a question in a repeat other than the create's `forEach` repeat | `check_paths`; the page's "Inside the wrong repeat!" |
| `name-repeat` | the name question's innermost repeat is not the create's `forEach` repeat | the page recomputes `repeat_context` from the name question on save |
| `write-condition` | a write carries a `condition` | `ConditionalCaseUpdate` |
| `condition-not-stateable` | the create's condition, or a sharing close's, is not stateable or its answer holds `'` | `XForm.action_relevance` |
| `owner` | as for a load | as for a load |
| `link-target` | a link's target is neither the own load nor a chain load (`session`, or the session datum of a chain selection) nor an earlier create placed as an open action (`op`), or the link has no target (`target: null`) | the page offers loads and earlier opens as parents (`advanced/actions.js`); `helpers/validators.py` "missing parent tag" |
| `link-renamed-load` | a link names a load whose datum HQ's child-module alignment renames (`add_parent_datums`, section 13.3) | `xform.py::_create_casexml_advanced` reads the unadjusted variable for an index to a load |
| `repeat-shared` | the create is in a repeat that also holds another create placed as an open action, and fewer than two of them carry indices | `xform.py::get_action_path`, `AdvancedFormActions.count_subcases_per_repeat_context` |
| `type-not-a-menu` | no module of the app has the create's case type | `xform.py::check_case_type` (`Application.get_case_types`) |
| `appended-name-taken` | never met (G3 found outcome A): an open action's derived tag steps around every name at its block's parent (section 8), and a question that takes a held tag's `case_<tag>` is `HELD_BLOCK_PATH_TAKEN` | N1 |

`repeat-shared` is decided over the whole repeat: part 01's procedure, placing creates in operation
order, keeps an earlier create on its open action and gives a later one Save to Case when the later
one would break the rule. Each indexed open action's `CaseIndex` is `{tag: <the named load's or open
action's tag>, reference_id: <the link identifier>, relationship: <the link's>, relationship_question:
""}`.

### 9.3 The worker's load

The first `worker-record` update of an advanced form takes the worker's load when every write is a
bare question read outside a repeat, with no write condition, no `via` and no `onlyIfChanged`
(part 01's usercase slot, restated): HQ's `AdvancedFormActions` has no `usercase_update`, so a basic
module turned advanced keeps its worker writes only this way. The datum and assertion are HQ's
(section 13.1). There is no authored auto-select in step 5 (decisions, resolution 10); the four other
modes stay HELD-NEW (section 24.3).

---

## 10. The owner of an advanced open action

| The create's owner | Its indices | What Nova writes |
|---|---|---|
| absent or `acting-user` | none, or at least one `child` | nothing: HQ sets the owner from `meta/userID` (`autoset_owner_id_for_advanced_action`) |
| absent or `acting-user` | all `extension` | `case_properties.owner_id` from the generated Hidden Value `nova_owner_<operation id>`, calculate `instance('commcaresession')/session/context/userid` |
| `unowned` | all `extension` | nothing: HQ writes `-` |
| `unowned` | none, or a `child` | `case_properties.owner_id` from `nova_owner_<operation id>`, calculate `'-'` |
| a bare question read | any | `case_properties.owner_id` from that question (its `nova_trimmed_` sibling where guarded) |

`planGeneratedNodes` gains the purpose `owner` and the plan method `owner(operationUuid): string`,
allocated in the operation's scope's namespace (the root, or the create's repeat row) after the
operation's other nodes. With `owner_id` in `case_properties` HQ writes `-` in `<create>` and the
owner in `<update>` (`add_create_block`, `add_case_updates`), and Core applies the create then the
update of one block in order; gated run G6 settles that the case ends owned by the worker.

*Departure* from the research ("never adds a question to make one fit"): the owner node is a
Nova-named Hidden Value like `nova_trimmed_` and `nova_url_`. The only other spelling, no `owner_id`,
leaves a carried extension case owned by no one, which today's Save to Case extension block (owner
`/data/meta/userID`) does not. G6's outcome B removes the node and states the unowned case instead.

---

## 11. Preloads in an advanced form

Part 01 makes a preload the question's default value (`default_value` = the `form-case` read), which a
basic form writes as Vellum's default setvalue at the question's place in the data tree. An advanced
form writes it the same way, and every `LoadUpdateAction.preload` is `{}`. HQ's build appends a
load's preload setvalues after every setvalue the form holds (`xform.py::_create_casexml_advanced`,
`add_setvalue` appending to the model), so a preload written there would load after a later default
that reads the question, where the same form as a basic form loads it before. A module turns advanced
when a link starts carrying a create; that edit must not change what a default reads.

*Departure* from the research and from both case-write briefs, which wrote an advanced form's preload
as HQ's `preload`. `forms-and-case-writes/loadupdateaction-preload-question-property` stays HELD-NEW;
step 6's import reads an HQ preload as a default only where nothing later in the form reads the
question at load (written into the step 6 outline).

---

## 12. The form source and the local injection

- **The source** (the HQ upload and the `.ccz` alike) of an advanced form holds what a basic form's
  holds: questions, Nova's generated nodes (now with `nova_owner_<op>`), and Save to Case blocks. HQ's
  build injects the advanced blocks into the source it stores.
- **The local injection,** `lib/commcare/xform/advancedCaseBlocks.ts::addAdvancedCaseBlocks(xform,
  plan, ctx)` (new, pull request 7), is the `.ccz`'s mirror of `xform.py::_create_casexml_advanced`,
  called by `compiler.ts` in place of `addCaseBlocks` for an advanced form, before `addMetaBlock`.
  Through the shared `xform/domSplice.ts` and one `InstanceSink`, it writes, in this order:
  1. per load, in load order, that has `case_properties` or a close that is not `never`: a
     `case_<tag>` element appended to the data root after every child it already holds, holding
     `<case xmlns="http://commcarehq.org/case/transaction/v2" case_id="" date_modified="" user_id="">`;
     binds `case_<tag>/case/@case_id` calculate the load's session variable read
     (`instance('commcaresession')/session/data/<the load's datum id, after alignment>`),
     `@date_modified` type `xsd:dateTime` calculate `/data/meta/timeEnd`, `@user_id` calculate
     `/data/meta/userID`; an `<update>` with one child per key in code-point order (HQ's
     `sorted(update_mapping.items())`, `name` written `case_name`), each bound `calculate=<path>` and
     `relevant="count(<path>) > 0"`, with ` and <the case's value> != <path>` appended for an
     `update_mode: "edit"` key where the publish target holds Save only answers that changed
     (part 01); keys with a `via` path in a `case_<tag>/parents/<step>/.../case` block per ancestor
     (`XForm._add_case_updates`); a `<close/>` whose bind `relevant` is the close condition
     (`action_relevance`). `casedb` is declared once where any bind reads it.
  2. per open action, in `open_cases` order: its block at HQ's path (`case_<tag>/` at the root;
     inside a repeat, every open action of that repeat, indexed or not, at `<repeat>/case_<tag>/` where
     the repeat holds two or more open actions with `case_indices`, and otherwise at `<repeat>/`), the `<case>` inserted as the first child of its node (HQ's
     `subcase_node.insert(0, ...)`); `@case_id` set by an `xforms-ready` setvalue of the session
     variable outside a repeat, bound to `uuid()` inside one; `<create>` with `case_name` (bound to the
     name path, which also gains `required="true()"`), `owner_id` (bound to `/data/meta/userID`, or
     text `-` where HQ does not set the owner, section 10) and `case_type` (text); `<update>` as for a
     load; `<index>` with one child per `case_indices` entry named by its `reference_id`, attribute
     `case_type` and, for `extension`, `relationship="extension"`, bound to the load's session
     variable read (unadjusted) or the earlier open action's `case/@case_id` path; `<close/>` under its
     relevance; the block's `relevant` is the open condition.
- **Proof 3** compares this injection with HQ's build of the same form for every document that
  declares Android; a difference is an emitter defect fixed in the pull request, never a register
  entry.

---

## 13. Session datums

### 13.1 The advanced entry

`lib/commcare/session.ts::deriveSessionDatums` (the local suite) and
`lib/commcare/formLinkProjection.ts::entrySessionDatums` gain an advanced branch, read from the plan
(pull request 7):

1. per load, in order:
   - a chain load: `<datum id="case_id_<tag>" nodeset="instance('casedb')/casedb/case[@case_type='<T>'][@status='open']<the list module's filter><[index/<identifier>=instance('commcaresession')/session/data/<the previous load's datum id>] for a load after the first>" value="./@case_id" detail-select="m<list>_case_short" detail-confirm="m<list>_case_long"/>`, with no `detail-confirm` where a later load indexes this one or the detail is inline, `detail-persistent` and `detail-inline` as the list module's basic entry writes them, and the list module's `autoselect` (false);
   - the worker's load: `<datum id="case_id_autoload_commcare_user<n>" function="instance('casedb')/casedb/case[@case_type='commcare-user'][hq_user_id=instance('commcaresession')/session/context/userid]/@case_id"/>` and the assertion `count(instance('casedb')/casedb/case[@case_type='commcare-user'][hq_user_id=instance('commcaresession')/session/context/userid]) = 1` with the locale id `case_autoload.usercase.case_missing`, whose text Nova already supplies;
2. per open action outside a repeat, in order: `<datum id="case_id_new_<type>_<i>" function="uuid()"/>`;
3. in a child module, HQ's `add_parent_datums` alignment, which `entrySessionDatums` already mirrors
   for basic forms, applied to the advanced datums: insert the root's first-form datums that need no selection as
   `from_parent` placeholders, rename a datum whose id collides with a root datum id to
   `<id>_<case_type>`, match each root selection datum in order against the next remaining datum of the
   same case type and datum kind, rename that datum's id to the root's, and rewrite each nodeset
   reference.

No query datum is written (forms that read the search are a blocker), and no `supply_point_id` datum
(HQ adds it under CommTrack only, section 19).

### 13.2 Identities

`formLinkProjection.ts::entryDatumIds` maps an advanced entry's rows to the `DatumRef`s every printer
already reads, so no stored expression changes when a module turns advanced and only the printed ids
move:

| Datum | `DatumRef` |
|---|---|
| a chain load | `{kind: "selected-case", module: <its list module>}` (and, after alignment, the root's) |
| the registration's open action | `{kind: "new-case"}` |
| any other open action outside a repeat | `{kind: "new-child-case", caseType}` |
| the worker's load | `{kind: "worker-record"}` |

`entryDatumIdResolver` resolves a ref named by two rows to the first row in entry order (it keeps the
last today). From pull request 4 a form may hold two creates of one type outside a repeat (operations
replace field buckets), and HQ's `_find_best_match` takes the first source datum of a type, so a link
reading `new-child-case` names the case HQ would carry. The change lands in pull request 4 with the
plan's `datums`.

### 13.3 What a renamed load means

`link-renamed-load` (section 9.2) reads the alignment of 13.1 step 3: a load whose datum id the
alignment changes is renamed, and an open action that would index it falls to Save to Case.

---

## 14. Extension child cases (defect 24)

### 14.1 The shape

An extension child case is a `create` operation with a link whose relationship is `extension`
(part 01's model; part 01's planner `planFieldCaseWrite` writes it for a field whose "Saves to" names
a child type declared `relationship: "extension"`, with the link `{identifier: "parent", targetType:
<the form's case type>, target: <the own case>, relationship: "extension"}`). The identifier is
`parent`, the index name today's wire writes for both relationships
(`lib/commcare/xform/caseOps.ts`, `subcase.reference_id || "parent"`), so section 14.4's unchanged
bytes hold.

### 14.2 Placement

| The create | Placement |
|---|---|
| in a basic form, carried by no link | the first eligible of part 01's procedure, which is Save to Case: a basic subcase holds `child` only. Its block is in `nova_operations` at its scope, its id `uuid()` (section 3.3) |
| carried by a link (section 4.2) | an advanced open action: its module is emitted advanced (section 4.1), and part 01's procedure places it there where section 9.2 admits it; else `FORM_LINK_NEEDS_NEW_CASE_DATUM` (section 15) |
| in an advanced form, carried or not | the first eligible: an advanced open action where section 9.2 admits it, else Save to Case |
| held | as held, while it expresses the create (part 01); section 14.5 says when a held Save to Case does not |

### 14.3 The inert subcase goes

- `subcaseWire.ts` is deleted in pull request 7 (`hqCaseActions` and the "including inactive actions"
  reasoning; `subcaseSessionDatumId` moves into `session.ts` and counts basic subcases only).
- Basic `subcases[]` hold `child` creates only, so their indices renumber: a basic child listed after
  a former extension subcase moves down by one, and with it its `subcase_<i>` block, its
  `case_id_new_<type>_<i>` datum and HQ's export columns. A published app meets this as an identity
  move recorded by the cutover (section 23, M2).
- `xform/sourceCaseWrites.ts::subcaseIsWrittenInSource` keeps only its several-case branch.
- `nova_subcases` and `nova_subcase_<n>` are written only where a held Save to Case path names them
  (a published extension create the cutover holds, section 23, M1). `planGeneratedNodes`' `subcases`
  namespace stays for those held names and allocates no new one.

### 14.4 Until pull request 7

From pull request 4 to pull request 6, an extension create that part 01's planner writes for a field
(one `extension` link to the own case, a bare-read name, no other link) is emitted as today: the
plan's basic arm writes the inert `OpenSubCaseAction` (relationship `extension`, condition `never`)
at its place in `subcases` and the active block at `nova_subcases/nova_subcase_<n>`, and its
placement reads `{save-to-case, path: ["nova_subcases", "nova_subcase_<n>"]}`. So the 26 defect 24
entries stay live until the pull request that fixes them, and every emitted byte of the
`case-extension-*` documents is unchanged by pull requests 4 to 6. Pull request 7 deletes that branch.

### 14.5 A held Save to Case placement of a carried create

A Save to Case placement gives a create no session datum, so where a link carries the create it no
longer expresses what the document asks of it. Part 01's expressibility predicate
(`lib/commcare/placement.ts::placementIneligibility`, which `placementExpresses` reads) gains the
clause:
a held placement of a create that `linkCarriedCreates` holds is not expressible unless it is
`{basic, own}` on a registration, a `{basic, subcase}` outside a repeat, or `{advanced, tag}` of an
open action outside a repeat. So the edit that makes a published create carried (a new link, a link
retargeted) moves its placement to an advanced open action, stated before it commits (section 21),
instead of being refused.

---

## 15. `FORM_LINK_NEEDS_NEW_CASE_DATUM`

**Rule** (`lib/commcare/validator/rules/advancedModule.ts`, new, a form rule; class `soundness`; in
`gate.ts` and `errors.ts`; pull request 7). A form `f` holds a create `c` in `linkCarriedCreates(doc,
f)` whose placement (held or derived) gives it no session datum. Located at the form, with
`details: {formUuid, formName, linkUuid, targetName, operationUuid, caseType, cause}`, where
`linkUuid` is the first link that carries `c`, `targetName` its target form's name, and `cause` is
the first of:

- `{kind: "blocker", blocker: AdvancedKindBlocker, moduleName}`: the module's kind is basic because
  of a blocker (section 4.3);
- `{kind: "ineligible", reason: AdvancedIneligibility}`: the module is advanced and section 9.2 keeps
  `c` from an open action.

**Messages** (the rule's message for the SA and MCP; the builder's sentence in
`lib/doc/userFacingErrors.ts`; both one sentence frame with a reason clause and a remedy clause):

- Validator: `"${formName}" can't hand its new ${caseType} case to "${targetName}" after it is
  submitted: ${reason}. You can send that link to the "${menuName}" menu instead, where workers choose
  the case, or ${remedy}.`
- Builder: `After "${formName}", the link to "${targetName}" can't open the new ${caseType} case,
  because ${reason}. You can send it to the "${menuName}" menu, where workers choose the case, or
  ${remedy}.`

`menuName` is the target form's menu, or the nearest menu above it CommCare HQ offers as a link target
(part 06's `lib/domain/formLinkTargets.ts::nearestOfferedMenu`); where neither is offered the first
clause reads "You can send that link to the app's home screen instead" (validator) and "You can send
it to the home screen" (builder).

| Cause | `reason` | `remedy` |
|---|---|---|
| `several-cases` | `"${moduleName}" lets workers choose several cases, and CommCare HQ can hand a new case on only from a menu where they choose one` | `let workers choose one case in "${moduleName}"` |
| `forms-read-search` (pull request 7 wording) | `"${moduleName}" opens on its Search screen, which CommCare HQ can't keep while handing a new case on` | `turn Search first off in "${moduleName}"` |
| `forms-read-search` (from pull request 10) | `the forms in "${moduleName}" read its search, which CommCare HQ can't keep while handing a new case on` | `turn off Forms read the search in "${moduleName}"` |
| `case-list-menu-item-narrowed` | `"${moduleName}" shows its case list in the menu, and handing a new case on would make that list show every open case, without its ${what}`, where `what` is `filter` (`why: "filter"`), `hidden owners` (`"hidden-owners"`) or `parent case` (`"chosen-before"`) | `remove the case list from the menu` |
| `chain-index` | `${childType} cases link to their ${parentType} case under more than one name (${identifiers}), so CommCare HQ couldn't tell which ones to list` | `link them under one name` |
| `value-not-a-question` | `the new case saves a calculated value` | `save that value from a question` |
| `name-repeat` | `the new case takes its name from a question in another repeat` | `name it from a question in its own repeat` |
| `write-condition` | `one of its values is saved only when a condition holds` | `save that value every time` |
| `condition-not-stateable` | `CommCare HQ can't state the condition it is created under` | `compare a question with one of its choices` |
| `owner` | `its owner comes from a place in your organization` | `let the worker who submits it own it` |
| `link-target` | `it links to a case this form doesn't choose or create first` | `link it to the case this form opens or creates` |
| `link-renamed-load` | `it links to a case this menu shares with the menu above it` | `link it to this form's own case` |
| `repeat-shared` | `it shares its repeat with another new case that links to nothing` | `link both to a case` |
| `type-not-a-menu` | `no menu lists ${caseType} cases` | `add a menu for ${caseType} cases` |

`keyed` and `via-*` never reach the rule (a keyed create is never carried; a create holds no `via`),
`retype` and `worker-property-name` belong to loads, and `appended-name-taken` is no open action's
clause (G3's outcome A is met by the tag allocator, section 8, and the basic slots, part 01 §12.2).

Every editor meets it at the commit gate: the builder (the link's editor shows the sentence before
**Add link** or **Save**, through `lib/doc/commitVerdicts.ts`), the SA and MCP (the finding's message
in the refusal). It is never a migration outcome: the cutover retargets such a link before it judges
the target (section 23, M1).

---

## 16. Every HQ advanced rule, and where Nova holds it

| HQ rule | Source | Where Nova holds it |
|---|---|---|
| no forms or case list | `AdvancedModuleValidator.validate_with_raise` | `NO_FORMS_OR_CASE_LIST` (every module, today) |
| the six rules of a case list registration form in an advanced module | `AdvancedModuleValidator.validate_with_raise` | unreachable in step 5: the one arm of part 05's `caseListRegistrationForm` needs forms that read the search, a kind blocker; step 7's arms that need no search carry the six rules (written into the step 7 outline, group 3) |
| no case type | `get_case_errors` | `NO_CASE_TYPE` (an advanced module always has forms that load or create its type) |
| no case detail | `get_case_errors` | `MISSING_CASE_LIST_COLUMNS` (completeness, refused at export as for a basic module) |
| no product detail under CommTrack | `get_case_errors` | unreachable: Nova writes HQ's default product column (section 7.1) |
| missing parent tag; tags blank, failing the page's check, holding `/`, or repeated | `check_actions`, `actions.js`, `xform.py` | unrepresentable: tags come from `allocateAdvancedTags` (section 8) |
| missing relationship question; the `question` relationship | `check_actions` | never written: a Nova link's relationship is `child` or `extension` |
| case_name required | `check_actions`, `add_create_block` | every create has a name (part 01's `CASE_CREATE_NAME_MISSING`) |
| subcase repeat context | `check_actions` | never written: a link to a create in a repeat comes only from a create over that same repeat (`CASE_OPERATION_REPEAT_CORRELATION`) |
| `update_case word illegal`, reserved words | `check_case_properties` | Nova's property names (`authoredCasePropertyNameSchema`, `FORBIDDEN_CASE_WRITE_PROPERTIES`) admit none; `via` steps are only `parent` and `host` (`CASE_WRITE_VIA_INVALID` reason `step`); a worker property, G4 (section 29) |
| no parent paths on an indexed action | `check_case_properties` | eligibility `via-on-indexed-load`; a create holds no `via` (part 01's `CASE_WRITE_VIA_INVALID` reason `new-case`) |
| no case type in action | `check_actions` | unrepresentable |
| auto-select key, source, case ref, mode | `check_actions`, `actions.js` | the worker's load is the only auto-select (`mode: "usercase"`, which needs none) |
| Save to Case creates name a type and a name | `check_save_to_case_references` | `caseOps.ts` writes both on every create |
| filtering without case | `check_actions` | `FORM_DISPLAY_CONDITION_CASE_DATA_UNAVAILABLE` (today) |
| each action path a question; upload paths need case attachments | `check_paths` | every path is a question or a generated Hidden Value (`nova_trimmed_`, `nova_url_`, `nova_owner_`); attachment mode leaves in pull request 2 (part 01) |
| an open action's type is some module's | `xform.py::check_case_type` | eligibility `type-not-a-menu` |
| an open action in a repeat shares its block | `xform.py::get_action_path` | eligibility `repeat-shared` |
| an index to a load whose datum HQ renames | `xform.py::_create_casexml_advanced` | eligibility `link-renamed-load` |
| `details_module` of another type | `entries.py::get_target_module` | unrepresentable: a load's list module is its chain module (`CASE_PARENT_SELECTION_INVALID` holds its type) |
| no query datum for inline search | `entries.py::configure_entry_advanced_form` | kind blocker `forms-read-search` |
| no several-case list | `AdvancedModule.is_multi_select` | kind blocker `several-cases` |
| the menu item lists every open case | `entries.py::entry_for_module` | kind blocker `case-list-menu-item-narrowed` |
| one index name per load | `entries.py::get_parent_filter_by_ref_id` | kind blocker `chain-index` |
| a condition's answer is interpolated unescaped | `XForm.action_relevance` | eligibility `condition-not-stateable` |
| an open action's parents are loads and earlier opens; a load's index names the previous load | `actions.js`, `case_config_ui.js` | eligibility `link-target`; the chain (section 6.1) |
| an open action's `repeat_context` is its name question's | `case_config_ui.js` | eligibility `name-repeat` |
| duplicate property keys | `case_config_ui.js` (`propertyCounts`) | part 01's `CASE_WRITE_DUPLICATE_PROPERTY` |
| an element HQ appends beside a question of the same name | `xform.py` (no existence check) | G3 (section 29) |
| a carried create needs a datum | `workflow.py::_find_best_match`, `entries.py::get_new_case_id_datums_meta` | `FORM_LINK_NEEDS_NEW_CASE_DATUM` (section 15) |

*Departure* from the wire brief's D12 (fourteen codes): eleven of its codes become eligibility clauses
or kind blockers, two (`ADVANCED_MODULE_EMPTY`, `ADVANCED_CASE_LIST_REGISTRATION`) are an existing code
and an unreachable shape, and `FORM_LINK_NEEDS_NEW_CASE_DATUM` stays. Reason: an operation an advanced
action cannot express has Save to Case, and a module a blocker keeps basic has the basic kind; only a
link that needs a datum has no other placement, so only it refuses. `proof/hq/test_advanced_rules.py`
(section 24.5) holds each row's HQ side.

---

## 17. The case list menu item of an advanced module

- On a module emitted advanced, the menu item writes `case_list.show: true`, its label and its media,
  as on a basic module (part 05's `expander.ts` change from pull request 10; in pull request 7 the
  formless `caseListOnly`). Pull request 7 emits advanced modules with no menu item beside their
  forms, since no document holds one before pull request 10 admits `Module.caseListMenuItem` beside
  forms; until then the only advanced module with a menu item is one whose kind is held and whose
  forms are gone. HQ builds its entry from the case type alone: one datum
  `case_id_case_<type>` over every open case of the type, with the module's `case_short` and
  `case_long` details (section 2). The local suite writes the same entry and datum
  (`session.ts`, the case list entry of an advanced module), where a basic module's takes its own
  entry datums.
- The blocker `case-list-menu-item-narrowed` (section 4.3) admits the item on an advanced module only
  where the module's own list holds every open case of the type with no case chosen before it, so
  the advanced entry lists exactly what the basic one would. Nova's menu item therefore means one
  thing on both kinds, and nothing needs saying beside it.
- Part 07's switch **Show the case list in this menu** is offered disabled where the commit verdict
  of turning it on refuses it, which is a module a carried create keeps advanced and whose list is
  narrowed, with that verdict's sentence as its reason: `FORM_LINK_NEEDS_NEW_CASE_DATUM`'s builder
  sentence for the cause `case-list-menu-item-narrowed` (section 15). On a module advanced only
  by its hold, turning the item on is offered: the held kind moves back to basic, which the identity
  move dialog states before it commits (section 21).
- What a worker meets after choosing a case there is part 05's gated run G1 (decisions, resolution 6):
  the advanced entry takes the same reading as the basic beside-forms entry in each of its outcomes
  A, B and C, joins the same feature, and plays the same Preview rule (section 20).
- The menu item of an advanced module is the first of CommTrack's triggers (section 19).

---

## 18. Add-ons, plan privileges, sync on form entry

- **Add-ons** (`lib/commcare/addOns.ts::addOnsNeededBy`, pull request 7): a form whose `form_type` is
  `"advanced_form"` adds `subcases` and `conditional_form_actions` (HQ's `used_in_form` predicates
  hold for every form that is not a `module_form`); `case_list_menu_item` reads `case_list.show` on
  both module types; the basic arms read `form.actions.open_case` and `subcases` only on a basic form.
  `conditional_enum` and `enum_image` read `product_details` too on an advanced module (HQ's
  `add_ons.py::_uses_detail_format`); Nova's product column is `plain`, so neither is added by it.
- **Plan privileges** (`planPrivileges.ts::requiredPlanPrivileges`): `child_cases` counts basic
  `subcases` only; an advanced module or form asks no privilege of its own (HQ's
  `_check_subscription` checks only the worker's record, and the advanced page reads no add-on
  privilege); `save_to_case` keeps reading the plan's `saveToCase`; `user_case` keeps reading
  `formsUsingWorkerRecord`, which counts a worker's load as a write.
- **Sync on form entry** (`formEntrySyncReasons`) keeps step 4's predicate. HQ adds the post where
  `form.requires_case()`, which for an advanced form is "some load is not auto-selected"; in step 5 an
  advanced form holds a non-auto load exactly when it is a follow-up or close form (section 6.1), which
  is `CASE_LOADING_FORM_TYPES`. *Departure* from the wire brief's D14, which keyed on a new
  `formRequiresSelectedCase`: it could not differ in step 5. Step 7's second case selection makes a
  registration that loads a case possible, and the step 7 outline (group 6) records that the predicate
  then reads the selection.

---

## 19. CommTrack's wire triggers

Part 03 owns the `commtrack-off` confirmation, its copy, its migration and both of its gated runs
(decisions, resolution 7). This part gives it what the emitter writes:

- **The advanced menu item.** `lib/commcare/moduleKind.ts::advancedModulesWithCaseListMenuItem(doc)`
  (pull request 8): every module whose `emittedModuleKind` is advanced and whose case list menu item
  is on, in module order. HQ's build adds a `product_id` datum to that entry and a `product_short`
  detail where the project space has CommTrack on (`entries.py::entry_for_module`,
  `models/modules.py::AdvancedModule.get_details`). Part 03's `commtrackReasons` writes one sentence
  per module it returns. It reads the menu item wherever a module holds one: before pull request 10
  through `caseListOnly`, which only a module with no forms holds (an advanced one is a module whose
  kind is held and whose forms are gone), and from pull request 10 through part 05's
  `moduleHasCaseListMenuItem`, which admits the item beside forms. Until pull request 10 builds
  `targeted-commtrack-advanced`, the lane witness of this reason, its advanced menu-item arm is
  witnessed in Vitest: `moduleKind.test.ts` (section 26.1) and the "defect 20's `product_id` datum"
  case part 03's `proof/targeted/__tests__/publishChecks.test.ts` takes over in pull request 8.
- **An advanced module with no menu item** is no reason: under CommTrack HQ adds a `product_short`
  detail no datum reads, and `get_case_errors` finds Nova's default product column.
- **HQ's third trigger,** the last load's `show_product_stock`, is unreachable (C4): Nova always writes
  `false` and `product_program: ""`; HQ's page keeps it false unless the project space has CommTrack on
  (`loadUpdateAction.unwrap`), and a person's change in HQ meets the drift stop at the next publish.
  `forms-and-case-writes/show-product-stock-true-or-a-non-empty-product-program` stays REFUSED.
- **The supply point text** is part 03's second reason (a decoded source holding
  `instance('commcaresession')/session/data/supply_point_id`); the advanced emission adds no such text.
- The lane's sensitivity run that writes `project-space-setting/Domain.commtrack_enabled`'s effects
  (part 03's G1, which is part 08's G4) reads the advanced documents of section 24.4: in pull request
  7 every advanced module's `product_short` detail, extended in pull request 10 to the menu item's
  `product_id` datum on `targeted-commtrack-advanced`.

---

## 20. Platform rows and Preview

- **No new feature row.** `menus-and-case-lists/advancedmodule` and `forms-and-case-writes/advancedform`
  read `RUNS / RUNS`, and so does every advanced action entry this part flips (section 24.3), so no
  feature of `lib/domain/platforms.ts::PLATFORM_FEATURES` and no ambient entry is added for them, and
  `lib/commcare/surface/__tests__/platformFeatures.test.ts` holds that they need none.
- **The case list menu item.** `menus-and-case-lists/module-case-list-show-true-on-an-advancedmodule`
  flips from HELD-NEW to HELD in pull request 10, with the beside-forms entry, joining
  `case-list-menu-item` with the readings part 05's G1 gives in whichever of its outcomes A, B or C
  (or its mixed walks) the run shows, the advanced entry taking the beside-forms reading, its Preview
  cell `…-on-an-advancedmodule@web-apps` taking the same model as the basic entry's
  (`model("case-list-menu-item-web-apps")`). Its detector is part 05's `moduleHasCaseListMenuItem`,
  blind to the kind. The witness is `targeted-commtrack-advanced` (section 24.4), built in pull
  request 10.
- **Entries that stay HELD-NEW with a platform reading:** `auto-select-case-on-an-advanced-module`
  (`UNAVAILABLE` on Web Apps where one row matches and the datum has `detail-confirm`) and
  `more-than-one-address-column-in-a-detail-of-an-advanced-module` (`DIFFERENT` on Android): Nova emits
  neither in step 5 (no `autoSelectSingle`, no address column on an advanced detail), and each is
  written into the step 7 outline (groups 6 and 4) with its feature row then.
- **Preview plays the derived chain.** Preview reads an advanced form's case list steps from the entry
  datums (`lib/preview/engine/entrySessionData.ts` reads `entrySessionDatums` and `entryDatumIds`
  today), so the steps and the ids follow section 13 with no Preview change but one: a chained load's
  list is constrained by the parent case through the index the load names. `lib/case-store/store.ts::
  SelectedParentCases` gains `readonly index?: string`: absent, a child linked through any
  non-extension index (a basic chain, today's); present, a child whose index of that identifier names
  the parent, whatever its relationship (`index/<identifier>`). The SQL is the store's existing
  parent-scope statement with one more condition on the index row's identifier, compiled by
  `lib/case-store/sql`; `lib/preview/caseSelectionNavigation.ts` and
  `lib/preview/app-tests/navigation.ts` pass `index` where the module is advanced. Where the app links
  under one name, the two constraints select the same cases of the app's own making; they differ only
  on cases another app linked otherwise, which Preview then shows as CommCare does.
- **The id of a carried create.** The submission takes, for every create the plan gives a datum
  (`FormCaseWirePlan.datums`), the id the entry's session minted for that datum, whichever its
  placement: `lib/preview`'s `buildSubmissionOperationProgram` marks the create's seed with the
  datum's key (`SubmissionCaseSeed.entryCaseKey`, `new-case` or `new-child-case:<type>`, the first
  datum of a type taking the plain key and a later one `new-child-case:<type>:<i>`), and
  `lib/case-store/postgres/submissionEnvelope.ts` derives it through
  `lib/domain/entryCaseIdentity.ts::entryDatumCaseId`, as it does today for a basic child of a
  one-case form. So the form a link opens next receives the case the submission made, in Preview as
  on a device. Every other create keeps minting `uuidv7()`. `lib/case-store/CLAUDE.md`'s sentence
  "The ordinary action's registration primary, and each child of a one-case form that no repeat
  creates, take the id the entry's session minted" becomes "Every create the entry gives a session
  datum takes the id the entry's session minted".
- **Owners.** A carried extension create owned through `nova_owner_<op>` is owned by the worker in
  Preview, as its Save to Case block is today. Under G6's outcome B Preview changes (section 29).
- **App Tests.** `RUNTIME_VERSION` does not move for this part (an App Test evaluates the document, and
  the steps it plays come from the same projection).

---

## 21. Identity moves this part plans

`lib/doc/moduleKindMoves.ts::planModuleKindMoves(prev, candidate)` (new, pull request 7) is one
source of part 07's `lib/doc/identityMoves.ts::withIdentityMoves` (decisions, resolution 3), the one
that states both of this part's subjects. It runs first, before part 01's
`lib/doc/placementMoves.ts::planOperationPlacementMoves` and part 04's query repeat planner, because
a kind change decides which placements part 01 then moves: part 01's planner reads the candidate this
planner leaves, with any cleared kind applied. It returns its `holdPlacements` entries and its moves,
as every source does:

```ts
export type ModuleKindMoveReason = AdvancedKindBlocker["kind"] | "advanced-change";
export function planModuleKindMoves(
	prev: BlueprintDoc,
	candidate: BlueprintDoc,
): { readonly holds: readonly PlacementHoldEntry[]; readonly moves: readonly IdentityMove[] };
```

- **A held kind a blocker meets.** For each module whose `heldKind` is `"advanced"` in the candidate
  and `heldKindExpresses(candidate, m)` is false: a `holdPlacements` entry clearing the module kind,
  and a move with subject `{kind: "module-kind", moduleUuid}`, from the label `advanced-menu` to
  `ordinary-menu` (part 07's `PlacementLabel`s in `lib/domain/placementCopy.ts`), reason the first
  blocker's kind. Part 01's planner then moves the forms' held advanced placements.
- **A published module a carried create turns advanced.** For each module basic in `prev` and advanced
  in the candidate whose forms hold any held placement: a move with subject `{kind: "module-kind"}`,
  from `ordinary-menu` to `advanced-menu`, reason `advanced-change` (no entry of its own: part 01's
  planner moves the held basic placements, which can no longer express their operations in an
  advanced form).
- **The chain's names.** With either move, where the module selects a parent, its forms read the
  chosen cases under new names (`case_id` and `parent_id` become `case_id_load_<type><n>`, or back).
  That renaming is part of the `module-kind` move itself, not a move of its own: the selections are
  derived (section 6), so they carry no move subject and no placement label. The
  planner gives the move the facts (the module selects a parent, and the direction), and part 07's
  module-kind sentence states the renaming from them.
- A module whose kind changes and whose forms hold no held placement and no held kind moves nothing a
  publish recorded, so no move is stated; the next publish records its placements.

Move reasons, one sentence each, in part 07's `lib/doc/identityMoveCopy.ts`, whose reasons and labels
land whole in pull request 5 (so pull request 7 adds this planner and no copy):

| Reason | Sentence |
|---|---|
| `several-cases` | `It now lets workers choose several cases, which an advanced menu can't do.` |
| `forms-read-search` (part 07's) | `Its forms now read the search, which an advanced menu can't do.` (from pull request 10; in pull request 7, where the blocker reads today's inline Search first, part 07's variant: `It now opens on its Search screen with its forms reading the search, which an advanced menu can't do.`) |
| `case-list-menu-item-narrowed` | `Its case list in the menu now has a filter or a parent case, which an advanced menu would leave out.` |
| `chain-index` | `Its cases now link to their parent case under more than one name.` |
| `advanced-change` (part 07's) | `A form in it now saves a case change only an advanced menu can.` |

Each reason for a held kind a blocker meets is that blocker's kind, so the gate arm of section 5
reads its first reason's sentence from the same record. In step 5 the only case change only an advanced menu can hold is a carried
create's open action, so `advanced-change` names the carried link's effect.

The dialog row for `module-kind` is part 07's (its row copy names the menu, the direction and, where
the module selects a parent, the session values its forms now read under new names). Undo and redo of a move replay the history step's inverse, which restores the
hold the latest recording wrote; part 03's kernel rule admits exactly that restoration (section 5,
way (b)), part 07's `applyHistoryStep` derives each inverse so that it carries only those hold
changes, and `withIdentityMoves` states the move back before it commits.

---

## 22. What the builder, the SA and MCP read from this part

Part 07 owns every surface; these are the readers it calls, the forced ones in pull request 7 (the
dialog's menu rows, `getModule`'s `advanced`, the snapshot's `[advanced]`) and the new surfaces in
pull requests 12 and 13, each reached from `components/**` through a `lib/doc/hooks` hook on the
`biome.json` allow-list `formLinkReview.ts` already uses:

- `emittedModuleKind`, `advancedKindReasons` (the module settings row saying why a menu is advanced,
  part 07's `advancedModuleReason`: held from a publish, or the form and link that carry a new case;
  step 5 has no third reason) and `advancedKindBlockers` (the disabled reason of a setting that would
  block a carried create, through the commit verdict).
- The placement label for an advanced action, `case-actions` (`case actions`, part 07's
  `lib/domain/placementCopy.ts`), on the case changes rail.
- `FORM_LINK_NEEDS_NEW_CASE_DATUM`'s builder sentence on the link editor, and on the case list menu
  item's switch where it refuses turning the item on (section 17).
- `getModule`'s `advanced: { kept: boolean } | null` and the snapshot's `[advanced]` or
  `[advanced, kept]` (part 07, pull request 7) read `emittedModuleKind` and `heldKind`.
- No authoring input carries a kind, a tag, an owner node or a load, and no read names a stored
  selection: there is none (section 6.3).

---

## 23. Migration classes for the one cutover

Part 09 runs these in its transform's `extension-children` step (decisions, resolution 12), with
the production readers this part ships in `lib/commcare` and `lib/domain` (`linkCarriedCreates`,
`emittedModuleKind`, `advancedKindBlockers`), which are emission code and outlive the tooling. Part
08's fuzz mapping calls none of them: no generator draws an extension child or a form link (part 08
§4.3). Order within the step: M1 over the document `writes-into-operations` and part 06's
`form-link-semantics` leave, then M2, then M3. Part 06's link classes L1 to L6 all run before M1, in
part 09's step 7; M1's retarget drops a carried link's datums itself, so it keeps every invariant
they leave (part 06 §14.2), and `linkCarriedCreates` answers the same before and after them.

- **M1. Extension child cases.** Identified per form: the child buckets of the frozen
  `deriveCaseWriteInventory` whose catalog relationship is `extension` (each already a create with an
  `extension` link after `writes-into-operations`), and every other create the head rule carries
  (decision 11). Target, per create:
  - **carried** (`linkCarriedCreates` over the migrated document): an advanced open action, its module
    advanced; where the head gate refuses it (`FORM_LINK_NEEDS_NEW_CASE_DATUM` with a `blocker` or an
    `ineligible` cause), the create keeps a Save to Case placement and each link that carried it is
    retargeted to its target form's menu where CommCare HQ offers it (`menuTargetOffered`), or the
    nearest menu above it CommCare HQ offers (`nearestOfferedMenu`), else removed, so the form returns
    to the app home; its datums are dropped in every case, through part 06's `planFormLinkUpdate` and
    `planFormLinkRemove` (part 09 §7.6); notice `form-link-goes-to-menu`. A carried create moves
    even where a published baseline holds its `nova_subcases` block, because the inert datum that
    carried it is gone (deployment line `form-data-paths-move`, cause `extension-case-moved`); a
    carried create's Save to Case placement is never held;
  - **published, not carried** (a readable baseline, part 03's `publishedCaseBlocks`, holds the block
    at `nova_subcases/nova_subcase_<n>` in that form's `xmlns`, or a published deployment's baseline is
    unread and the frozen classifier of today's placements gives the create that path, decision 5 with
    its `placements-kept-unread`): held `{save-to-case, path: ["nova_subcases", "nova_subcase_<n>"]}`,
    so its submission path stays;
  - **otherwise**: no hold; the simplest placement (`nova_operations`).
  The notice names each module made advanced (`module-made-advanced`, detail `caseType`).
- **M2. Basic children renumbered.** A basic child listed after a former extension subcase moves down
  (section 14.3). No document change; for a published app part 09's deployment line names the cause
  `subcase-renumbered` and the cutover's placement step records the new index as held where a baseline
  holds the child.
- **M3. Modules M1 turns advanced.** Every form's placements become advanced actions (submission paths
  `/data/case` → `/data/case_<tag>/case`, `subcase_<i>` → `case_<tag>`), datums rename (`case_id` →
  `case_id_load_<type><n>`, `parent_id` → the parent load's), no stored selection changes. The cutover
  records no basic hold for a form of such a module (part 03's B1 exception) and holds no module kind:
  the next publish records the kind and the advanced placements. Deployment line cause
  `module-made-advanced`.
- No migration changes the kind of any other module: no module is advanced before step 5, no app
  holds a case list menu item beside forms before pull request 10, and every other trigger is content
  an app gains only by an edit.

What the production scan found (run during planning, content-free, part 09; decisions, resolution
16) decides each class below. Extension child writes exist in production, as field writes and as
operations with an extension link, in unpublished apps only. Every shape below is one an author can
still create before the window (a link added, an app published), so each class ships, and the
cutover's advisory dry run counts what it meets:

- **Carried creates.** Production holds none today: no extension child write is carried by an
  after-submit link into a form of its case type, so no module becomes advanced at the cutover and
  `module-made-advanced` meets no app today. The dry run counts any an author adds before the window:
  each module it makes advanced is named by `module-made-advanced`, and a carried create that is not
  an extension (decision 11) carries the same reason and is listed apart in the cutover's report, so
  the person reviews it in the runbook's dry run.
- **Carried creates a blocker or a clause refuses.** Production holds none today, since it holds no
  carried create. M1's retarget branch ships as the transform's guard; the dry run counts any link
  it retargets, each named by `form-link-goes-to-menu`.
- **Published apps whose baseline holds a `nova_subcases` block.** Production holds none today: no
  published baseline mentions `nova_subcases`, so no HQ app holds an extension child's Save to Case
  block at Nova's path, and no extension path is held at the cutover; from step 5 no export writes a
  new one. A publish before the window can write one, so the dry run counts it, and such a block is
  held at its path and keeps it on every later publish.
- **Published apps with a basic child after an extension subcase.** Production holds none today,
  since no published app holds an extension child write, so no deployment line names
  `subcase-renumbered`. A publish before the window can create one; the dry run counts it, and each
  such deployment's `form-data-paths-move` line names it.

---

## 24. Proof

Part 08 owns the registers, the manifest mechanics, the targeted document list, the native families
and the lane; this section is what pull requests 7, 8 and 10 move in it for this part.

### 24.1 Register moves (pull request 7)

All 26 defect 24 entries move from `proof/known-defects.json` to `proof/fixed-defects.json`, each
without `document`, with its id, check, artifact, path, kind and control unchanged (part 08, decision
1 and §2.3):

| Check | Entries | Document today | Control |
|---|---|---|---|
| `manifest` | `d24-inert-subcase-app-schema-form-actions-extension`, `…-form-actions-subcase-never`, `…-formactions-subcases-extension`, `…-formactions-subcases-subcase-never`, `…-opensubcaseaction-condition-subcase-never`, `…-opensubcaseaction-relationship-extension` | `case-extension-multiple` | `case-extension-registration-after-13` |
| `proof3` | `d24-inert-subcase-trace-case`, `…-trace-subcase-c90a`, `…-trace-casedb-case`, `…-blocks-case-added`, `…-blocks-subcase-case-removed` | `case-extension-repeat` | `case-extension-repeat-after-13` |
| `proof3` | `…-formplayer-local-ccz-submissions-case-unpaired`, `…-submissions-subcase-unpaired` | `case-extension-repeat` | `case-extension-repeat-after-59` |
| `proof3` | `…-trace-item-case`, `…-trace-item-subcase`, `…-formplayer-local-ccz-item-id-case`, `…-item-id-subcase`, `…-blocks-item-case-added`, `…-blocks-item-subcase-case-removed`, `…-blocks-cases` | `case-extension-query` | `case-extension-query-after-13` |
| `proof3` | `…-formplayer-local-ccz-submissions-item-case-unpaired`, `…-submissions-item-subcase-unpaired` | `case-extension-query` | `case-extension-query-after-59` |
| `proof3` | `…-trace-subcase-50ea`, `…-formplayer-local-ccz-output-data-subcase` | `case-extension-registration` | `case-extension-registration-after-13` |
| `proof3` | `…-formplayer-local-ccz-submissions-subcase` | `case-extension-registration` | `case-extension-registration-after-59` |
| `proof4` | `d24-inert-subcase-app-subcases-relationship` | `case-extension-repeat` | `case-extension-registration-after-13` |

`proof/checks/registers.py::OPEN_DEFECTS` drops `24` in the same pull request. The served-reader
entries (`…-formplayer-local-ccz-*`) are seen to move only by a run with the readers: part 08's by-hand
row 7 for this pull request (§8.4: `targeted-advanced-module`, `targeted-extension-carried`,
`targeted-advanced-child-module`, `targeted-advanced-held-kind`, the `case-extension-*` documents,
`targeted-migration-extension-children` and their `control:` ids), each moved entry showing on its
control and not on its document. `case-extension-registration` becomes an advanced module by its own
content (its link carries the episode, part 08 §4.2) and must show no difference. The extension fixture
`extensionCaseFixture.ts` keeps its scenarios; its documents are rebuilt from operations by part 01's
planner (the attachment mode is gone from pull request 2).

### 24.2 Walk stops

None added or moved by this part. A run that ends on the list a case list menu item already showed is
part 05's G1, which decides how the walk reads it.

### 24.3 Manifest entries (each flip edits its row in `docs/research/2026-09-26-hq-round-trip/inventory/`)

Pull request 7, HELD-NEW to HELD, `RUNS / RUNS`, each first emitted by a document of section 24.4:

| Entry | Emitted by |
|---|---|
| `menus-and-case-lists/advancedmodule` | `targeted-advanced-module` |
| `forms-and-case-writes/advancedform` | `targeted-advanced-module` |
| `load-update-cases-loadupdateaction`, `loadupdateaction-case-tag-without`, `loadupdateaction-case-type`, `loadupdateaction-details-module`, `loadupdateaction-case-properties` | `targeted-advanced-module` (the own load's writes) |
| `loadupdateaction-close-condition-on-the-form-s-own-selection` | `targeted-advanced-module` (its close form) |
| `loadupdateaction-close-condition-on-any-other-selection` | `targeted-advanced-module` (a close of the parent case on its load) |
| `loadupdateaction-case-index-tag-reference-id-relationship` | `targeted-advanced-module` (the chain) |
| `auto-select-mode-usercase` | `targeted-advanced-module` (its follow-up's worker write; the only auto-select step 5 writes) |
| `open-cases-advancedopencaseaction-the-one-open-action-outside` | `targeted-advanced-module` (its registration) |
| `open-cases-advancedopencaseaction-any-other`, `advancedopencaseaction-name-update`, `advancedopencaseaction-case-properties-keys-without`, `advancedopencaseaction-case-indices-child-extension-one-or-many` | `targeted-advanced-module` |
| `advancedopencaseaction-open-condition`, `advancedopencaseaction-close-condition` | `targeted-advanced-module` |
| `advancedopencaseaction-repeat-context-equal-to-the-name-question`, `an-advanced-open-action-indexed-to-an-open-action-that-has-a-equal` | `targeted-advanced-module` (two indexed creates in one repeat, the second linked to the first) |

Pull request 10: `menus-and-case-lists/module-case-list-show-true-on-an-advancedmodule` HELD-NEW to
HELD, with the readings part 05's G1 gives (section 20), emitted by `targeted-commtrack-advanced`.

Stay HELD-NEW (no step 5 shape): `loadupdateaction-preload-question-property` (section 11), the four
other `auto-select-mode-*`, `caseindex-relationship-question-…-naming-a`,
`an-advanced-load-s-update-or-preload-or-an-open-action-s-name-or` (a label as a write source),
`arbitrary-datums-datum-id-datum-function`, `menus-and-case-lists/auto-select-case-on-an-advanced-module`,
`case-type-commcare-user-on-an-advancedmodule`, `more-than-one-address-column-in-a-detail-of-an-advanced-module`,
`a-custom-long-tile-row-mixing-fields-of-two-tabs-in-an-advanced`,
`expressions-and-data/session-data-supply-point-id-in-an-advanced-form-whose-computed`.

Stay REFUSED and stop being written: `forms-and-case-writes/subcases-relationship-extension` and
`subcases-condition-never` (the inert subcase). Stay REFUSED: every REFUSED advanced class (section 16).

**Value-class readers** (`proof/checks/manifest_value_classes.py::VALUE_CLASSES`, part 08 §7.2), added
in pull request 7 for each REFUSED class on a key advanced emission now writes, unless the entry's
reason says HQ's build alone refuses it: `tag-with-slash`, `blank-tag`, `tag-failing-editor-check`,
`slash-property-on-indexed-load`, `index-on-auto-select-or-first-load`, `tag-names-no-action`,
`tag-names-other-than-previous-load`, `open-action-slash-key`, `shared-block-in-repeat`,
`not-name-question-repeat`, `tag-names-own-or-later-open-action`, `load-with-renamed-datum`,
`question-relationship-to-open-action`, `question-relationship-after-open-action-index`,
`relationship-question-in-repeat`, `outside-parent-repeat`, `breaks-case-list-form-rules`, and the two
`menus-and-case-lists` classes part 08 names. Each reader is held by part 08's reader test against the
manifest's own example.

**Gate entries.** `toggle/APP_BUILDER_ADVANCED` keeps `target-owned` with preflight none (decision 19);
its effects stay `null` unless the gate-effects run (part 08's G4, which is part 03's G1) shows HQ's
build reads it. Under part 08's G4 outcome C (the build reads the flag), publish probes the flag
wherever an emitted module is advanced, the gate entry's preflight becomes that probe, a space with
the flag off is refused `project_space_incompatible` naming each advanced menu, and decision 19 is
replaced by that rule in pull request 7.
`project-space-setting/Domain.commtrack_enabled` gains its effects from that run: in pull request 7
the `product_short` detail every advanced module gets, in pull request 10 the menu item's
`product_id` datum (part 08 §7.3).

### 24.4 Targeted documents

Part 08 owns the one list (decisions, resolution 15), and every part uses its names. This part's
documents are part 08's `targeted-advanced-module` (which takes in this part's advanced chain, its
worker's load and its extension owner document), `targeted-extension-carried` (this part's carried
and uncarried extension creates in a basic module), `targeted-commtrack-advanced` (this part's
CommTrack menu-item document, decisions-2 R1), part 05's `targeted-case-list-menu-item`, and the four
this part adds to part 08's list. The "Holds" column is what this part needs each to hold:

| Id | Holds | Witnesses | Pull request |
|---|---|---|---|
| `targeted-advanced-module` (part 08) | a household module and a patient module selecting its household (parent selection), made advanced by a carried extension create: a registration of patient (its own open action, open and close conditions), a follow-up of patient writing three questions, closing the household on its load, writing the worker's record through the worker's load and creating two indexed `visit` cases in one repeat (the second linked to the first), an `episode` extension create carried to "Review episode", and a close form | every flip of section 24.3 but the menu item, `auto-select-mode-usercase` by the worker's write; the worker's load's datum and assertion on both paths; proof 4's advanced Case Management and module settings saves (G2); proof 3 between HQ's build and the local injection; the owner of the extension open action (G6) | 7 |
| `targeted-extension-carried` (part 08) | a basic module whose registration creates an extension case carried by its link into a form of its type, beside a form whose extension create no link carries | the carried create on an open action with `case_id_new_<type>_<i>` matched by the link; the uncarried one in `nova_operations` with a `uuid()` id | 7 |
| `targeted-commtrack-advanced` (part 08) | an advanced module (a carried create) with its case list menu item beside its forms, HQ's default product details (section 7.1) and a verdict requiring CommCare Supply off, and no filter, hidden owner or parent selection, since a narrowed list keeps the module basic (section 4.3) | part 03's confirmation verdict and sensitivity; the advanced menu item entry's flip and readings (part 05's G1) | 10 |
| `targeted-case-list-menu-item` (part 08) | part 05's | part 05's G1 | 10 |
| `targeted-advanced-child-module` (added) | a basic case-selecting root menu with an advanced child menu of the same type whose forms' loads HQ aligns to the root's datums, and a create there linked to the aligned load | `add_parent_datums` on both paths; the create falls to Save to Case (`link-renamed-load`) | 7 |
| `targeted-advanced-held-kind` (added) | D: a module advanced by a carried create, published; D′: the link removed | the held kind keeps the module advanced, so proof 1 sees no move across D → D′ | 7 |
| `targeted-root-case-block-names` (added) | a root question `subcase_0` beside a basic child create at the root; a root question `commcare_usercase` in a form writing the worker's record | G3 | 7 |
| `targeted-worker-underscore-write` (added) | a worker property `_visits` written by a basic form through the usercase slot, and by a second form through a Save to Case block (a computed value) | G4 | 7 |

Each is built by Nova's planner and admitted by the gate (`proof/targeted/build.ts::targetedDocument`),
appended to `proof/targeted/index.ts::TARGETED_DOCUMENTS` and to `proof/README.md`, "Targeted
documents"; none needs a control. The pull request 7 documents are written in part 08's
`proof/targeted/documents/advancedModules.ts`. `targeted-advanced-held-kind`'s D is published by the
capture, which records its holds (part 08 §4.5), so D′ is planned over D with the held kind. Under G4's
outcome B the gate refuses `targeted-worker-underscore-write`, so it leaves `TARGETED_DOCUMENTS` in the
same pull request, its first push's records stand as the run's evidence in `harness-findings.md`, and
the code's validator test pairs the refusal with an accepted write (section 29, part 08 §5.1).

### 24.5 Native and reader tests

- `proof/native/core/AdvancedFormRuntimeTest.java` (part 08's name, its `case` family, pull request 7):
  HQ's build and Nova's local injection of `targeted-advanced-module`;
  Core opens each form from its suite
  session with the loads' datums, submits, and `CaseXmlParser` applies: each load updates the case its
  datum names, the household closes, the open actions create with their indices (the `extension` one
  with `relationship="extension"`), the worker's load updates the worker's case, and the extension case
  ends owned by the worker (G6). Plausible failure it catches: a datum id or block path the local suite
  writes differently from HQ's build, which per-document proof 3 shows only for documents that hold it.
- `proof/native/test_advanced_emission.py` (new, HQ side, pull request 7): HQ's
  `_create_casexml_advanced` and `get_datum_meta_assertions_advanced` over Nova's HQ import body of the
  same documents equal, element for element, what `addAdvancedCaseBlocks` and `session.ts` wrote into
  the local `.ccz`; HQ's `validate_app` returns no error.
- `proof/hq/test_advanced_rules.py` (part 08 §6.2): for each row of section 16 that names an
  eligibility clause or a kind blocker, an app built with HQ's own models in the shape Nova avoids
  fails HQ's build, its validator or its page check as the row says, and Nova's emission of the same
  document (falling to Save to Case, or staying basic) passes; the shapes come from the shared fixture
  `proof/hq/fixtures/advanced-rule-shapes.json` (part 08 §6.2), which
  `lib/commcare/__tests__/advancedPlacement.test.ts` writes from the production predicates.
- G3 and G4 have no lane test of their own (part 08 §6.2): each is read on its targeted document
  (`targeted-root-case-block-names`, `targeted-worker-underscore-write`) through the bar, proof 3 and
  the `CaseOperationRuntimeTest` scenario, and its first push's records stand as the run's evidence in
  `harness-findings.md`. Under outcome A of each, the clause it adds (`appended-name-taken`,
  `worker-property-name`) is a section 16 row naming an eligibility clause, so its shape joins
  `advanced-rule-shapes.json` and `test_advanced_rules.py` builds it with HQ's own models beside the
  rest.
- `proof/targeted/__tests__/unproducedInputs.test.ts`: the "defect 20's product_id datum" bullet moves,
  with its case, to part 03's `proof/targeted/__tests__/publishChecks.test.ts` in pull request 8, where
  the advanced menu item asks `commtrack-off` (part 08 §6.2). Before pull request 10 that case's module
  is one whose kind is held and whose forms are gone, the only advanced module a document can give a
  menu item, and it is the advanced menu-item arm's witness until `targeted-commtrack-advanced` lands
  in pull request 10.

---

## 25. Contracts and docs these changes make false

Pull request 7 rewrites the subtree contracts; pull request 15 the architecture and public docs
(part 10 holds the whole list).

- `lib/commcare/CLAUDE.md`, "Case-management scaffolding emission": the sentences beginning
  "`subcaseWire.ts::hqCaseActions` therefore marks extension actions `never` …" through "Source
  extension creates use those same IDs" become: "HQ's basic case builder ignores
  `OpenSubCaseAction.relationship`, so a basic child case is always `child`. An extension case is a
  case operation: a Save to Case block whose case id is `uuid()`, or an advanced open action where an
  after-submit link carries the new case, which makes its module advanced. A `nova_subcases` group is
  written only where a published Save to Case placement names it."
- Same file, the `subcases` bullet: add "An advanced form's datums are `case_id_<tag>` per load and
  `case_id_new_<type>_<i>` per open action outside a repeat (`session.ts`)."
- Same file, new section "Advanced modules": `casePlacementPlan.ts` (one plan per form),
  `moduleKind.ts::emittedModuleKind` (held, or a carried create, and no blocker), the derived loads
  (`advancedSelections.ts`), the HQ keys of section 7, `advancedTags.ts`, the eligibility module,
  `nova_owner_<op>`, preloads as defaults, `advancedCaseBlocks.ts`, the datums, the menu item, the
  add-ons.
- Same file, "Authored case-operation emission": "always lower to Save to Case blocks" becomes "take
  the placement `planPlacements` gives them, emitted by `casePlacementPlan.ts`".
- `lib/domain/CLAUDE.md`, "Forms and modules": `Module.heldKind` and
  `advancedModule.ts::advancedKindBlockers`, `advancedChainIndex`, `heldKindExpresses`.
- `lib/doc/CLAUDE.md`: `moduleKindMoves.ts` as a source of `withIdentityMoves`.
- `lib/case-store/CLAUDE.md`: `SelectedParentCases.index` (section 20), and the entry-minted id
  sentence (section 20).
- `lib/preview/CLAUDE.md`: an advanced chain's list step is constrained through its named index.
- `docs/architecture/complex-apps.md`: the binding facts of section 2, cited, under a new heading
  "Advanced modules"; the "Extension child cases" paragraph rewritten as `lib/commcare/CLAUDE.md`'s.
- `docs/architecture/contracts.md`: no extension sentence changes there, since `contracts.md` holds
  none at `main` (the extension sentence is `lib/commcare/CLAUDE.md`'s and `complex-apps.md`'s, above).
  The sentence "A menu CommCare HQ holds as advanced stays advanced while it can be one." joins part
  10's new "HQ deployment safety" bullet on held placements (part 10 §7.3).
- `content/docs/case-changes.mdx`: a paragraph "When a form's link opens the case it creates" (part
  07's copy): such a menu becomes an advanced menu in CommCare HQ, Nova keeps it so once published, and
  what keeps a menu from being one.

---

## 26. Tests

Each test names the failure it catches, at the smallest boundary that shows it (`docs/testing.md`).
None is a React state test.

### 26.1 Pure

| File | What it proves, and the failure it catches |
|---|---|
| `lib/commcare/__tests__/casePlacementPlan.test.ts` (new, pull request 4; advanced cases from 7) | Over the fuzz corpus's documents (`xformDocArbitrary`, `suiteDocArbitrary` at a fixed seed) and the fixtures: every operation lands in exactly one of the plan's actions or Save to Case blocks; every create the plan gives a datum appears in `deriveSessionDatums` and in `entryDatumIds` with the same id; every appended name is one HQ's build writes. Catches a placement emitted twice, or a datum the suite names that no action allocates. |
| `lib/commcare/__tests__/advancedEmission.test.ts` (new, 7) | The two shells' key sets and values (section 7), each action kind, conditions with nulls, `details_module` always written, `preload` `{}`, against the key sets of HQ's fixture `tests/data/suite/suite-advanced.json` copied into `lib/commcare/__tests__/fixtures/hq-advanced-keys.json` with its pin and path. Catches a key HQ's save would add or drop. |
| `lib/commcare/__tests__/advancedTags.test.ts` (new, 7) | Allocation per position; a held tag kept; the worker's load last; a property test over random root names that no `case_<tag>` equals a root name and tags are distinct. Catches a block appended beside a question of its name. |
| `lib/commcare/__tests__/moduleKind.test.ts` (new, 7; extended 8) | Held, carried, blocked (each of the four blockers, with its twin that differs only in the blocker); a carried create a basic subcase already gives a datum does not make the module advanced; the kind is the same whichever module's kind is asked first. From pull request 8, `advancedModulesWithCaseListMenuItem` over a module whose kind is held and whose case list menu item is its only content (the one such shape before pull request 10), and over the same module without the hold. Catches a module made advanced for no create, a cycle between two modules that link to each other, or an advanced menu item CommTrack's reason misses. |
| `lib/commcare/__tests__/linkCarriedCreates.test.ts` (new, 7) | Matching by type in HQ's order, a selection of the type taking precedence over a new case, a parent placeholder skipped, each source datum used once, manual datums and a link condition reading `new-case` and `new-child-case`, repeat and keyed creates never carried; the same answer with the projection forced basic and forced advanced. Catches a link that would carry a different case on HQ than Nova computes. |
| `lib/commcare/__tests__/advancedPlacement.test.ts` (new, 7) | One row per clause of section 9 with an accepted twin that differs only in that clause, through `planPlacements`; writes `proof/hq/fixtures/advanced-rule-shapes.json` (part 08 §6.2) for `test_advanced_rules.py`. Catches an advanced action HQ's build or page refuses. |
| `lib/commcare/__tests__/advancedSuite.test.ts` (new, 7) | Local datums for the chain (nodeset with the list filter and `index/<identifier>`, `detail-confirm` dropped where a later load indexes it), the worker's load with its assertion, open action datums, child-module alignment, each equal to `entryDatumIds`' ids. Catches a local suite that names a datum HQ's build names otherwise. |
| `lib/commcare/__tests__/advancedCaseBlocks.test.ts` (new, 7) | The injection's block paths for each repeat shape of `get_action_path`, the `<case>` first in its node, the binds' calculates and relevances, `<create>`'s owner text, `<index>` attributes; checked by `xformOracle` first. Catches an injection proof 3 would show only on a document that holds the shape. |
| `lib/commcare/__tests__/advancedKindBlockersBinding.test.ts` (new, 7) | Over every module of the fixture corpus: `case-list-menu-item-narrowed` holds exactly where the basic projection's filter is non-null or its case-list entry holds more than one selection datum. Catches the domain reader the builder offers from drifting from the wire. |
| `lib/commcare/__tests__/extensionCaseEmission.test.ts` (rewrite, 7) | No `subcases` entry with `relationship: "extension"` or `condition: never` anywhere; an uncarried extension create in `nova_operations` with a `uuid()` id (a setvalue at the root, a bind in a repeat); a carried one an open action; basic children renumbered. Catches the inert subcase coming back. |
| `lib/commcare/__tests__/addOns.test.ts` (extend, 7) | An advanced form adds `subcases` and `conditional_form_actions`; an advanced module's menu item adds `case_list_menu_item`; a basic form's arms unchanged. |
| `lib/commcare/__tests__/entryDatumResolver.test.ts` (new, 4) | Two non-repeat creates of one type: `new-child-case` resolves to the first, as HQ's `_find_best_match` would. |
| `lib/commcare/__tests__/hqJsonOracle.test.ts` (extend, 7) | The oracle accepts each advanced `doc_type` and enum and refuses a wrong one. |
| `lib/commcare/validator/rules/__tests__/casePlacement.test.ts` (part 01's, extended 7) | `CASE_PLACEMENT_KIND` for a held advanced placement in a module emitted basic and a held basic one in a module emitted advanced, each with its message; `HELD_PLACEMENT_INEXPRESSIBLE` on a held kind a blocker meets. Catches a held placement emitted in a form kind that cannot hold it. |
| `lib/commcare/validator/rules/__tests__/advancedModule.test.ts` (new, 7) | Through `lib/doc/commitVerdicts.ts::mutationCommitVerdict`: `FORM_LINK_NEEDS_NEW_CASE_DATUM` for each cause of section 15 with its twin admitted; the validator message and `userFacingError` sentence for each cause, verbatim; the menu named by `nearestOfferedMenu`, and the home screen where none is offered. One assertion per cause, since this copy is the person's contract. |
| `lib/doc/__tests__/moduleKindMoves.test.ts` (new, 7) | For a held kind and each blocker: the edit refused by `HELD_PLACEMENT_INEXPRESSIBLE`'s `module-kind` arm without the planner, admitted with it, and the moves' subjects and reasons; part 01's planner, run after it, moves the forms' held advanced placements; a published basic module a carried create turns advanced: the `module-kind` row, with the renamed session values where the module selects a parent; an unpublished one: no move; undo of the move restores the recorded hold and `placementChangeRefusal` admits it. Catches a published path that moves without a statement. |
| `lib/domain/__tests__/advancedModule.test.ts` (new, 7) | `advancedChainIndex` over no link, one name, two names, links of other types and `extension` links (not counted). |

### 26.2 Postgres

- `lib/case-store/postgres/__tests__/parentCasesIndex.postgres.test.ts` (new, 7): a parent with two
  children, one linked under `parent` and one under `mother`, and an extension under `parent`: absent
  `index` lists both children and not the extension; `index: "parent"` lists the `parent` child and
  the extension; `index: "mother"` the other. Catches an advanced chain listing what HQ's `index/<id>`
  does not.
- `lib/case-store/postgres/__tests__/submissionEnvelope.postgres.test.ts` (extend, 7): a carried
  create placed as an open action takes the entry-minted id; a second create of the same type takes its
  own key.

### 26.3 Fuzz and fixtures

The proof sample's generators draw no new shape (part 08 §4.3): no generator draws a form link or an
extension child, so no drawn module is advanced there, and the sample keeps its draws. The Vitest
oracle corpora draw advanced documents through an arbitrary of this part's own,
`lib/commcare/__tests__/advancedDocArbitrary.ts` (new, pull request 7), which the proof sample does not
use: over a document `suiteDocArbitrary` draws, it adds a non-repeat create of a drawn case type and an
after-submit link to a form of that type, which carries the create and makes the module advanced,
keeping only draws the gate admits. `xformOracle.fuzz.test.ts` and
`suiteOracle.fuzz.test.ts` each gain one property over it, so the advanced arm meets both oracles;
their existing properties keep their draws. `lib/__tests__/docHelpers.ts::buildDoc` needs no change: a
document's kind follows from its content.

---

## 27. Departures

From the research, the outline and the wire brief:

- **No stored `Form.caseSelections` in step 5** (decision 3, section 6.3): the loads are derived from
  the parent selection, with no `selection` target; stored selections (a second case, per-form chains,
  auto-selection, computed datums) go to step 7, and step 6's import refuses a form that holds one.
- **Carrying applies to every create** (decision 11), not to extension creates alone.
- **Preloads stay defaults in advanced forms** (decision 9, section 11).
- **HQ's per-action rules are eligibility, and four module rules are kind blockers** (section 16): one
  new validator code where the brief had fourteen, beside the placement gate's two arms (section 5).
- **`formEntrySyncReasons` keeps step 4's predicate** (section 18): no step 5 form can tell the two
  apart.
- **The owner node `nova_owner_<op>`** (section 10): a Nova-named Hidden Value the research's rule
  ("never adds a question") would not add, because the only other spelling leaves the case unowned.
- **Tags use the action's own case type** (section 8), where the page writes the module's.
- **A derived tag spells the case type's `-` as `_`** (section 8 writes `autoload_commcare-user<n>`,
  the page's spelling): the tag names the data-root element `case_<tag>`, and Nova's XForm element
  names hold no `-` (`lib/commcare/constants.ts::XML_ELEMENT_NAME_REGEX`), so the local `.ccz` path
  refused `case_autoload_commcare-user<n>` and any tag of a hyphenated case type. The worker's load is
  `autoload_commcare_user<n>`; HQ's tag check (`actions.js::actionBase.validate`) accepts both, and
  `n` keeps two types that differ only there distinct. A held tag already holds no `-`
  (`placements.ts::advancedTagSchema`).
- **The advanced menu item is admitted only where it lists what the module's list lists** (section
  17), where the brief admitted it everywhere with a statement of the difference.

- **`OpenSubCaseAction.reference_id` stays `""`** (section 3.2 writes `"parent"`): HQ reads both as
  `parent` (`xform.py::XForm._create_casexml`, `subcase.reference_id or 'parent'`;
  `models/form_actions.py::OpenSubCaseAction` defaults to `'parent'`), and `""` keeps every app's HQ
  JSON bytes (`lib/commcare/casePlacementPlan.ts`).
- **A several-case form's own-arm block keeps `main`'s path and meaning**: five segments
  (`nova_selected_cases`, `item`, `nova_operations`, `nova_condition_update_selected_cases`,
  `nova_update_selected_cases`, from `placement.ts::derivedSaveToCase`), each row present only while
  its answer is, so the cutover can hold the path part 09 §8.2 names for it.
- **Basic subcase indices follow the operation array**, whose order rule puts root creates before
  repeat creates, so a form that met a repeat child before a root child in question order renumbers
  its `subcase_<i>` blocks and `case_id_new_<type>_<i>` datums; the cutover holds placements for
  published apps (part 09 C8).
- **`planFormCaseWire(doc, formUuid, options?: {attachmentTarget})`** (section 3.1 has no options): a
  basic link write is withheld without a deployment target (part 01 §10.1), so the plan needs it.

From the code at pull request 7's base:

- **`hq-advanced-keys.json` holds HQ's model key sets beside the fixture's** (section 26.1 names
  the fixture's alone). `tests/data/suite/suite-advanced.json` at the pin is an old document: its
  advanced menus hold `case_label` and `referral_label`, which `models/modules.py::AdvancedModule`
  no longer declares, and none of `case_list_form`, `search_config` or most other keys HQ's model
  declares. So the fixture records both, each with its source path: the keys each kind of object
  holds in that fixture, and every property each HQ model declares with its bases and mixins
  (`AdvancedModule`, `AdvancedForm`, `AdvancedFormActions`, `LoadUpdateAction`,
  `AdvancedOpenCaseAction`, `CaseIndex`, `AutoSelectCase`, `ConditionalCaseUpdate`,
  `FormActionCondition`, read from `models/*.py` at the pin). `advancedEmission.test.ts` holds
  the shells to the model's set, with the keys Nova leaves at HQ's default listed by name, and to
  the fixture's set but for its two retired keys and `show_count`.
- **The HQ JSON oracle takes `CaseIndex.relationship` at HQ's three choices** (`child`,
  `extension`, `question`; section 7.3 says the first two): the code it reports,
  `HQJSON_BAD_SUBCASE_RELATIONSHIP`, is one `proof/native/test_hq_json_oracle.py` holds to HQ's
  own wrap failing, and HQ loads `question`. Nova's `CaseIndex` type admits only `child` and
  `extension`. A wrong `auto_select.mode` is a new code, `HQJSON_BAD_AUTO_SELECT_MODE`
  (`validator/errors.ts`, `validator/gate.ts`), checked at HQ's five `AUTO_SELECT_*` choices.
- **The advanced oracle probes are not written to the native evidence file**:
  `test_hq_json_oracle.py::_load` reads every form's basic actions (`actions.open_case` and the
  rest), which an `AdvancedForm` has none of, so an advanced probe would fail HQ's side for the
  harness's reason. Its `_load` narrowing on `form_type` is the proof lane's (part 08).
- **The widened `modules` reaches the local archive and the tests that read basic keys**: `compiler.ts` reads a
  form's actions through `basicFormActions`, which refuses an advanced form by name (layer 3 gives
  the archive its advanced case blocks and entries), and the tests reach a basic menu or form
  through `lib/commcare/__tests__/hqBasicShape.ts`. `HqForm.form_type` is `"module_form"` and
  `HqModule.module_type` `"basic"`, so `doc_type` and the kind words narrow together.
  `hqShells.ts` also gives `emptyAdvancedFormActions()` and `noCaseIndex()`, the two shells layer
  3's builders start from.
- **`linkCarriedCreates` reads entries through a context with no case actions** (section 4.2 says
  `formLinkProjectionContext(doc, { entryMetadataOnly: true, moduleKinds: "basic" })`). A form's
  placements read which creates its links carry (the `carried-create` clause of section 14.5, and
  `emittedModuleKind`), and the entry datums of that context are built from those placements
  (`entrySessionDatums` reads the form's actions and the plan's new-case datums), so the plain
  context recurses into the form being planned. The context therefore takes two hooks,
  `formActions` (which existed) and `newCaseDatums` (new), and `linkCarriedCreates` gives every form
  empty actions and no new-case datum: the match reads selection datums only (their ids, types and
  order, which no case action changes; `selectableDatums` and `alignWithRootMenu` read no action),
  and the candidate new cases stand in for the new-case datums. A root's computed datums are then
  absent rather than present and skipped, which `_find_best_match` makes the same answer. The
  option `moduleKinds: "basic"` still lands, as the context's `moduleKinds` field; with the default
  hooks it plans each form with `planFormCaseWire(..., { moduleKind: "basic" })`, a new option of
  that plan.
- **An automatic link to a menu also carries** (section 4.2 says a form target). HQ matches a
  module target's frame the same way (`workflow.py::_get_link_frame` runs
  `_get_datums_matched_to_source` over `_frame_children_for_module`), and a child menu's frame holds
  its root's common selections, so a candidate the frame matches is carried there too. A flat menu's
  frame selects nothing and carries nothing.
- **Two clauses join the advanced eligibility, and an update's condition is `write-condition`**
  (section 9's tables have neither). `scope`: a change no load takes (its target is no case the
  form loads, or it is not the form's first worker update) and an update or close that runs in a
  repeat, where a load runs once (`LoadUpdateAction` has no `repeat_context`).
  `case-changed-before-create`: an open action another change updates or closes, since HQ's build
  writes open actions after every Save to Case block (`xform.py::_create_casexml_advanced`), so that
  change would run on a case not yet created; a close that shares the open action is its
  `close_condition`, as for a basic subcase. An update with a condition of its own takes Save to
  Case under `write-condition`: a `LoadUpdateAction` states a condition only for its close
  (`models/form_actions.py::AdvancedAction`, `close_condition`). Both reasons join
  `lib/domain/placements.ts::ADVANCED_INELIGIBILITY_REASONS`, and the sentence of
  `case-changed-before-create` names CommCare HQ instead of Case Management, which it now covers
  too.
- **A load takes no owner but one question's answer** (section 9.1's `owner` admits `acting-user` and
  `unowned`). A load's `owner_id` key names a question path (`check_paths`), and the generated owner
  node `nova_owner_<op>` is an open action's alone (`xform/generatedNodes.ts::advancedOwnerNodeValue`),
  so a load's worker or `unowned` owner has no path to name and takes Save to Case.
- **`link-renamed-load` reads the domain's root alignment** (section 13.3 reads the advanced datum
  projection of section 13.1, step 3, which layer 3 writes): a chain load is renamed where
  `lib/domain/entryDatumSupplies.ts::rootSelectionAlignment` matches its menu to a root selection,
  the same pairing `alignWithRootMenu` renames by. A root whose first form is itself advanced with the
  same tag would keep the id; that load also falls to Save to Case.
- **A held advanced placement's expressibility also reads its tag and row**: a tag another action of
  the form takes, or an action whose tag another change's hold gives, is `scope`; a `row` the
  repeat no longer gives is `repeat-shared`. A carried create's `row: true` is `carried-create`.
- **`worker-property-name` is a reason no predicate tries** (`advancedPlacement.ts`'s comment) until
  gated run G4 shows outcome A on the lane. G3's `appended-name-taken` waited the same way until its
  run found outcome A (the last bullet of this section).
- **`placedBasic` covers advanced actions** (`placement.ts`): an advanced action names a case name's
  `nova_trimmed_` sibling as a basic action does (section 9), so the trimmed set reads both.
- **The rule-shapes fixture holds Nova's documents, not HQ's actions**: each row of
  `proof/hq/fixtures/advanced-rule-shapes.json` is a clause with its two forms' case operations,
  conditions and planned placements, beside the fixture's questions (by uuid, as `/data/` paths) and
  menus, so `test_advanced_rules.py` builds the HQ side with HQ's own models from the shape and
  the placement Nova gives it.
- **The menu's move carries its renaming fact on its reason** (section 21 gives "the move the facts"):
  `IdentityMoveReason`'s `module-kind` arm is `{source, reason: ModuleKindMoveReason,
  chosenCasesRenamed}`, read from the document the move lands in, and the builder's row
  (`lib/doc/hooks/useIdentityMoveRows.ts`) and the tool sentence read it there rather than from the
  live document, which is the one before the edit. `IdentityMoveSubject` stays identity alone, as
  `identityMoveReportSchema` serves it.
- **A carried create's move is stated from the kind change, not a hold change**
  (`lib/doc/moduleKindMoves.ts::carriedCreateKindMoves`): the menu holds nothing of its own, and
  `withIdentityMoves` reports `identityMovesBetween(doc, final)`, so `identityMovesBetween` states the
  move for every menu that holds no kind in `after`, whose forms hold a placement in `before`, and
  that `emittedModuleKind` reads basic before and advanced after; a redo of the change states it the
  same way. A menu whose kind `after` holds is advanced by its hold (a recording, or a restore, which
  states nothing) and is no move.
- **The blockers' four sentences have one owner**: `lib/doc/identityMoveCopy.ts` words `advanced-change`
  and reads the four blocker sentences from `lib/domain/placementCopy.ts::advancedKindBlockerSentence`,
  which the gate's `HELD_PLACEMENT_INEXPRESSIBLE` finding for a menu reads too, so the two cannot
  drift. The sentence `Its forms also read the cases chosen through its parent case under new
  names.` joins `identityMoveSentence` (pull request 5 wrote it only in the dialog row).
- **`documentHoldsIdentity` counts a held kind** (`lib/doc/heldIdentity.ts`, beside the form walk):
  a document whose one hold is a formless menu's kind (Directory in
  `lib/doc/__tests__/moduleKindMoveFixture.ts`) still reaches the planner.
- **Root alignment covers an advanced entry's loads, and its open actions' datums follow it**
  (section 13.1, step 3, applies it to every advanced datum). HQ aligns the datums
  `get_datum_meta_assertions_advanced` returns, the loads alone, and appends the new cases'
  datums after it (`entries.py::EntriesHelper.configure_entry_advanced_form` extends with
  `get_new_case_id_datums_meta` after `add_parent_datums`), so `formLinkProjection.ts::
  advancedEntrySessionDatums` does the same: an open action's datum is never renamed and never
  displaces a root placeholder.
- **A load keeps `detail-confirm` where an open action indexes it** (section 13.1 drops it where a
  later load indexes it). `get_manual_datum` reads `actions_meta_by_parent_tag[tag]`, which
  `AdvancedFormActions._action_meta` fills loads first and open actions after, the last writer
  kept, so a chain load an open action also indexes keeps its confirmation. The projection reads
  the plan's `open_cases[].case_indices` for it.
- **The worker's load renames to `<id>_None` on a collision with a root datum**: HQ's
  `add_parent_datums` suffixes a colliding id with the datum's `FormDatumMeta.case_type`, which is
  `None` for an auto-selected load (`get_datum_meta_assertions_advanced`), though its function names
  `commcare-user`, which the frame reads (`workflow.py::WorkflowDatumMeta.case_type`). `SessionDatum`
  carries both (`alignmentSuffix`, `caseType`).
- **A child menu aligns with an advanced form-less root as with a basic one**: HQ aligns a child
  with its root's first form and with nothing where the root has none
  (`EntriesHelper._get_first_forms_datums`); Nova's basic projection stands that nothing in with
  the root's browse selection, whose id coincides with the child's. An advanced root's browse datum
  is `case_id_case_<type>` (section 17), which would rename the child's datum where HQ renames
  nothing, so the alignment reads the root's basic browse selection
  (`formLinkProjection.ts::basicCaseListSessionDatums`).
- **The advanced case list entry is written for a form-less menu only** (`caseListOnly`, section
  17's one shape in pull request 7). An advanced menu with forms keeps its basic browse projection,
  which `caseListStepDatumId` reads for the ids a case list's filter prints.
- **The new case a `uuid()` datum mints is kept by the datum, not its id**
  (`FormLinkProjectionContext.newCaseSources`), so a create's datum that root alignment renames
  still supplies its `new-case` or `new-child-case`, and a root's placeholder of the same id
  supplies nothing in the child.
- **The local injection finds each load's aligned datum by the load's tag on the entry's datum**
  (section 12 names "the load's datum id, after alignment"). `SessionDatum.advancedLoadTag` is set
  by `session.ts::deriveAdvancedLoadDatums` and survives the rename `add_parent_datums` makes;
  `compiler.ts` reads the last datum of each tag, as HQ's `adjusted_datums` dict comprehension keeps
  the last (`xform.py::_create_casexml_advanced`), since a root's datums copied ahead of the form's
  own may carry a root form's tag.
- **The compiler's link context reads no basic actions of an advanced form**: its `formActions`
  callback answers an `AdvancedForm` with `emptyFormActions()`, and the advanced entry reads the
  plan's loads and new cases instead (`session.ts::deriveSessionDatums`'s `advancedLoads` branch),
  so no reader treats an advanced form's actions as a basic form's.
- **Each owner node is the last child of its scope** (section 10 names its scope and its allocation
  order, not its place in the data tree): appended after every authored child and every generated
  container there (`xform/builder.ts::buildOwnerNodes`), a Hidden Value with a calculate and no
  control, which HQ's form builder reads anywhere among its parent's data-only children.
- **`advancedDocArbitrary` places the carried create deterministically** (section 26.3): over each
  draw it takes the first follow-up of a top-level menu that does not open on its search as the
  link's target, and the first case-bearing form of another menu's type with a root `case_name`
  question as the source, with no draw of its own, so the arbitrary reads `suiteDocArbitrary`'s
  draws unchanged. The create carries no link; its menu is advanced because no basic slot gives it
  a datum.
- **A survey of an advanced menu is an `AdvancedForm` with empty actions** (section 7.2 is silent
  on it): HQ's `AdvancedModule.forms` holds only `AdvancedForm`s, and a survey loads and opens
  nothing (`expander.ts::advancedActions`).
- **The plan takes the export's wire identity** (`PlanFormCaseWireOptions.identity`, section 3.1
  names none): a load's `details_module` is its list menu's HQ `unique_id`, which a target's
  recorded override can replace (`wireIdentity.ts::targetWireIdentity`), so the plan is made per
  identity as well as per attachment target, derived where none is given. The expander passes the
  identity it writes every menu with.
- **A close that shares an open action adds its final writes to that action's
  `case_properties`** (section 3.4 names only its `close_condition`): HQ's build writes an open
  action's create, update and close in one block (`xform.py::_create_casexml_advanced`), so the
  writes a close states run with it.
- **A held `nova_subcases` path is written in a group after the scope's authored children**
  (section 14.3 says "verbatim"): the published wire held that group there, after the scope's
  authored fields, where the root `nova_operations` group stands first, so `caseOps.ts` writes a
  held block whose group is the scope's `nova_subcases` name in that place, and no unheld block is
  placed in it.
- **`subcaseIsWrittenInSource` does not exist at the base** (section 14.3 says it keeps its
  several-case branch): `xform/sourceCaseWrites.ts` reads `caseOps.ts::writtenSaveToCaseBlocks`,
  and the several-case branch is `basicCaseSlots.ts`' `inSource`, which pull request 7 keeps for a
  field-written child only (`isFieldWrittenChild`, a `child` link). The kept child's block now always
  stands in the selected case's row and takes `uuid()`; no block reads a session value for its id.
- **An advanced plan's case name reads the trimmed sibling where the form guards the question**
  (section 9: "where `caseScalarTextGuards` holds it"): `caseScalarTextGuard.ts` counts every
  operation but the worker's record as a candidate, and `casePlacementPlan.ts` reads the guard set
  rather than assuming it, so the plan stays total if the two ever differ.
- **`CASE_PLACEMENT_KIND` takes the holds whose first reason is the menu's kind** (section 5 adds it
  beside `HELD_PLACEMENT_INEXPRESSIBLE`): at the base, `placement.ts::placementIneligibility`
  already answers a held advanced placement in a basic form with `module-basic` and a held basic one
  in an advanced form with `module-advanced` first, so both rules would name one hold. A hold whose
  first reason is either is `CASE_PLACEMENT_KIND`'s (`rules/casePlacement.ts::changedFormKind`), every
  other `HELD_PLACEMENT_INEXPRESSIBLE`'s. `CASE_PLACEMENT_KIND` joins
  `lib/doc/placementHolds.ts::PLACEMENT_CONFLICT_CODES`, so a publish's conflict replays an edit
  that meets it as it does the others. The menu-kind arm of `HELD_PLACEMENT_INEXPRESSIBLE` is a
  module rule (`heldModuleKindInexpressible` in `MODULE_RULES`), located at the menu.
- **`menuName` is the target's menu where HQ offers it, else the menu above it**: part 06's
  `nearestOfferedMenu` does not exist at the base, so `rules/advancedModule.ts::offeredMenuFor`
  reads HQ's own offer (`views/forms.py::_get_linkable_forms_context`: a top-level menu, or a child
  whose parent lists the source's parent's case type). Every top-level menu is offered, so the home
  screen wording is reached only where the target's menu is gone, which other rules refuse; its
  copy is held by a pure assertion.
- **The cause table is total over every open action clause**: `AdvancedIneligibility` also holds
  `scope`, `case-changed-before-create`, `keyed`, `via-on-indexed-load`, `retype` and
  `worker-property-name`. `case-changed-before-create` reaches the rule (a later update or close of
  the carried create) and reads "another case change in the form updates or closes it, which
  CommCare HQ would do before creating it" / "save those values when it is created"; the others
  never reach it (a carried create opens a case, runs in no repeat and holds no key) and carry a
  sentence each so the switch stays total. Section 15's rows are verbatim, the forms-read-search row
  in its pull request 7 wording, the quotes straight as the section writes them. `name-repeat`,
  `link-renamed-load`, `repeat-shared`, `type-not-a-menu`, `appended-name-taken` and
  the narrowed case list menu item reach no document the gate admits in pull request 7 (a carried
  create's name in another repeat is `value-not-a-question` first, a create in a repeat is never
  carried, the menu item stands beside no form before pull request 10, G3 has not run), so
  `advancedModule.test.ts` holds their clauses directly and the reachable causes through
  `mutationCommitVerdict`.
- **`FORM_LINK_DATUMS_INCOMPLETE` leaves the carried case to `FORM_LINK_NEEDS_NEW_CASE_DATUM`**: an
  automatic link whose carried create gets no session value also leaves the destination's datum of
  that type unmatched, so both rules would refuse one edit. `rules/form.ts::formLinkValidation`
  drops an unsatisfied datum whose case type the new rule names for that link, and still names
  every other.
- **The commit gate takes the whole document for any batch that changes a menu's kind**
  (section 5's last bullet lists the edits). `incrementalValidationScope.ts` takes the absolute
  gate for a held kind, a form's links, and, in a form with links, an operation added, removed or
  reordered or its links, repeat or target; `commitVerdicts.ts::menuKindsChanged` takes it for every
  other batch whose candidate emits a shared menu as another kind (a selection, a filter, Search,
  the parent selection), so the bounded footprints those edits keep stay exact. A form's otherwise
  (`postSubmit`) decides no carried create and keeps its footprint.
- **The carried create's key rides the program's existing map, not a seed field** (section 20,
  "The id of a carried create"). At the base, `lib/case-store/submission.ts::CaseOperationProgram.
  entryCaseKeys` (operation uuid → datum key) already carries the key the envelope derives through
  `entryDatumCaseId`, and no `SubmissionCaseSeed` type exists. `buildSubmissionOperationProgram`
  (in `lib/preview/engine/caseDataBindingHelpers.ts`) now fills that map from
  `planFormCaseWire(doc, form).datums`, every create the plan gives a datum whatever its placement,
  in place of the registration's own case and the first root basic subcase of each type. The keys
  are numbered by `lib/domain/entryCaseIdentity.ts::entryNewCaseKeyNumbering`: the first datum of a
  key keeps it plain and the n-th later one takes `:<n>` (`new-child-case:visit:1`), so `<i>` counts
  the earlier datums of the same key, not the datum id's suffix. `entrySessionData` numbers the
  entry's datums the same way, which it had to: it keyed every datum of one type by the plain key, so
  two datums of a type held one id. The first datum of each key derives the same id as before, so
  `RUNTIME_VERSION` does not move. A create a several-case form makes once per selected case
  (`caseOperationRunsPerSelectedCase`) is not named even where the plan gives it a datum, because one
  id cannot name a case per selected case; at the base the first such root subcase was named, so a
  batch of two asked for two cases under one id. Evidence:
  `lib/preview/engine/__tests__/entryNamedCreates.test.ts`.
- **The index rides `ParentCaseSelection`, built in one helper the screens and App Tests share**
  (section 20, "Preview plays the derived chain"). `lib/preview/caseSelectionNavigation.ts` held only
  the Results row action, and `lib/preview/app-tests/navigation.ts` builds no list read (App Tests
  read lists through `engine/serverSearchRead.ts::serverRecordsRead` and Details through
  `app-tests/details.ts`). The parent constraint is built at six sites, so
  `caseSelectionNavigation.ts::parentCaseConstraint` now builds it for all of them, with `index` from
  `parentCaseIndex`: `lib/domain/advancedEntryDatums.ts::menuEmittedAdvanced` (the domain twin of
  `emittedModuleKind`, since `lib/preview` outside `engine` may not import `lib/commcare`) and the
  chain's one name from `lib/domain/advancedModule.ts::advancedChainIndex`.
  `engine/caseDataBindingTypes.ts::ParentCaseSelection` gains `index?`, and the case-data cache key
  (`hooks/useCaseDataBinding.ts`) names it. `app-tests/navigation.ts` and `entrySessionData.ts`'s
  datum reading needed no change. HQ's two filters, at the pin:
  `corehq/apps/app_manager/suite_xml/sections/entries.py::EntriesHelper.get_parent_filter` and
  `get_parent_filter_by_ref_id`. Evidence: `lib/preview/__tests__/caseSelectionNavigation.test.ts`.
- **`via-name` and `link-repeat` are not clauses**: no admitted document reaches either. The gate
  admits only `parent` and `host` as a step of a save to the case above (`CASE_WRITE_VIA_INVALID`
  reason `step`), and both are in HQ's property grammar (`helpers/validators.py::validate_property`).
  A link to a create in a repeat comes only from a create over exactly that repeat
  (`validator/rules/caseOperations.ts::validateRepeatReference`, `CASE_OPERATION_REPEAT_CORRELATION`),
  which is always inside it, so HQ's "subcase repeat context" (`check_actions`) never fires.

- **Section 24.5's lane tests, as built** (pull request 7): `AdvancedFormRuntimeTest` derives what each
  case must hold from the form's own advanced actions in the HQ import body and opens each form from
  its suite entry through Core's session (`proof/native/core/SuiteFormRun.java`); G6 is its assertion
  that a case an open action creates as an extension is owned by the worker. `test_advanced_rules.py`
  builds each avoided shape from the accepted twin's HQ export with the clause changed on the action the
  fixture names, and needs each twin of `advanced-rule-shapes.json` to be a document Nova admits, which
  the producer refuses by name otherwise. Part 08's Departures hold the detail.
- **G3's outcome A reaches the basic slots alone, so no row joins `advanced-rule-shapes.json`**
  (pull request 7). The run (section 29; `harness-findings.md`, N1) found the collision, so an unheld
  basic subcase whose `subcase_<i>` an authored name at its scope takes, and an unheld worker's update
  beside a root `commcare_usercase`, take Save to Case (`lib/domain/basicCaseSlots.ts::appendedNameTaken`,
  read by `basicCaseSlots` and `lib/commcare/placement.ts`). An advanced action never meets it: every
  derived tag already steps around the names where HQ appends its `case_<tag>` (section 8, which the
  run extends to an open action's repeat rows), so the clause would have no refused twin, and the
  fixture's rows are advanced actions' twins (`test_advanced_rules.py` asserts the accepted twin's
  action). The reason leaves `ADVANCED_INELIGIBILITY_REASONS` and section 15's table; it stays in
  part 01's tuple for the basic slots. A held slot or tag keeps its name, and the gate refuses the
  question instead (`HELD_BLOCK_PATH_TAKEN`, `validator/rules/casePlacement.ts::appendedNameFindings`):
  making the hold inexpressible would let an edit's move carry the published block away, where only a
  rename keeps it. Evidence: `lib/commcare/__tests__/placement.test.ts` ("a question named like the
  block HQ's build appends"), `validator/rules/__tests__/casePlacement.test.ts`,
  `advancedTags.test.ts`, and `targeted-root-case-block-names`, which now witnesses the fallback.

---

## 28. Executed during planning

Nothing was run in HQ, Core, Formplayer, Android, Connect or the lane for this part. Read only:

- Every HQ fact of section 2 at `d6c6e16d8ae1`, by `rg` and reading the enclosing function:
  `models/modules.py::AdvancedModule` (and `new_module`, `get_case_types`),
  `models/forms.py::AdvancedForm`, `models/form_actions.py` (`LoadUpdateAction`, `AdvancedOpenCaseAction`,
  `CaseIndex`, `AdvancedFormActions`, `FormActions.all_property_names`), `xform.py`
  (`_create_casexml_advanced`, `add_create_block`, `add_case_updates`, `_add_case_updates`,
  `add_index_ref`, `autoset_owner_id_for_advanced_action`, the subcase `reference_id` default),
  `suite_xml/sections/entries.py` (`entry_for_module`, `include_post_in_entry`,
  `configure_entry_advanced_form`, `get_datum_meta_assertions_advanced`, `get_parent_filter`,
  `get_parent_filter_by_ref_id`, `get_auto_select_datums_and_assertions`, `get_new_case_id_datums_meta`,
  `get_case_datums_basic_module`), `suite_xml/sections/details.py::get_detail_id_safe`,
  `suite_xml/post_process/workflow.py` (`_find_best_match`, `_get_datums_matched_to_source`),
  `helpers/validators.py` (`AdvancedModuleValidator`, `AdvancedFormValidator.check_actions`,
  `check_case_properties`, `validate_property`, `FormValidator.check_actions`,
  `check_save_to_case_references`), `add_ons.py`, `views/forms.py` (`edit_advanced_form_actions`,
  `_apply_advanced_form_actions_change`), `static/app_manager/js/forms/advanced/case_config_ui.js::addFormAction`,
  `static/app_manager/json/case-reserved-words.json`, and the key sets of
  `tests/data/suite/suite-advanced.json` (a three-line `python3` read of the fixture's keys).
- Nova at `2f985ed6`: the files of section 1, `lib/domain/expression/types.ts::datumRefSchema`,
  `lib/domain/forms.ts::caseOperationSchema`, `lib/domain/caseParentSelection.ts`,
  `lib/domain/casePropertyName.ts`, `lib/domain/standardCaseProperties.ts`, `lib/commcare/constants.ts`,
  `lib/commcare/validator/userPropertySlug.ts`, `lib/commcare/hqJson/caseList.ts::projectCaseListFilter`,
  `lib/case-store/store.ts::SelectedParentCases`, `lib/case-store/CLAUDE.md` (restore scope, the
  submission envelope), `lib/preview/formlessCaseListRoute.ts`, `proof/editors/pages.py` (its
  `ADVANCED_CASE_MANAGEMENT` page exists), and a content-free `python3` read of
  `proof/known-defects.json` listing the 26 defect 24 ids, checks, documents and controls of section
  24.1.

---

## 29. Written and not yet run

Every run below is this part's. Part 05 owns the case list menu item's G1 (three outcomes; section 17
and 20 follow it), part 03 the CommTrack sensitivity run (part 08's G4) and the supply point text run
(section 19), part 06 the link order run.

**G2. HQ keeps Nova's advanced JSON.** Where: pull request 7's own lane, which runs proof 4 (HQ's
editors without the served readers) on every pull request, over every document holding an advanced
form (`targeted-advanced-module`, `targeted-extension-carried`, `targeted-advanced-child-module`,
`targeted-advanced-held-kind`, `case-extension-registration`), through the pages
`ADVANCED_CASE_MANAGEMENT`, `MODULE_SETTINGS` and `FORM_SETTINGS` of `proof/editors/pages.py`.

- Outcome A: no proof 4 difference: each save keeps every key and value; section 7 stands.
- Outcome B, a save writes a key differently with no change of meaning (a default HQ fills, such as a
  `CaseIndex` key, `schedule` on a form page save, or a key order): Nova writes the saved spelling in
  `hqShells.ts`, `types.ts` and `hqJsonOracle.ts` in the same pull request, section 7's table takes it,
  and `advancedEmission.test.ts`'s fixture gains it with the run's evidence.
- Outcome C, a save changes a meaning (drops an index, rewrites a tag, clears a condition): that shape
  is not one HQ's editors keep, so a clause is added to section 9 that keeps it from an advanced action
  (the operation falls to Save to Case), its manifest entry becomes REFUSED with the reason
  `not-hq-editable` (part 08 §2.6) and a value-class reader, and `harness-findings.md` records it.

**G3. A question named like the block HQ's build appends.** Where: pull request 7's lane on its first
push, before any clause depends on it, over `targeted-root-case-block-names`: the bar (HQ's build and
its validation of the built form), proof 3 (Core's and Formplayer's case blocks), a scenario in
`proof/native/core/CaseOperationRuntimeTest.java` that opens HQ's build in Core and submits (part 08
§6.2); the first push's records stand as the run's evidence in `harness-findings.md`.

- Outcome A, HQ's build refuses the form, or Core refuses it, or a case write is lost or binds to the
  question: N1 is a Nova defect fixed in step 5. The clause `appended-name-taken` joins section 9 (loads
  and open actions) and part 01's basic subcase and usercase slots (the slot whose name HQ appends is
  taken is not eligible; the operation takes Save to Case), and its shape joins
  `advanced-rule-shapes.json`, which `proof/hq/test_advanced_rules.py` reads; part 01's `HELD_BLOCK_PATH_TAKEN` covers
  the names HQ appends for held basic and advanced placements (a question renamed to one is refused and
  offered the next free id); section 15 gains the cause; `harness-findings.md` records N1 with the run.
  The document then witnesses the fallback.
- Outcome B, both nodes stay apart and every case write lands: no clause and no rule; N1 is recorded as
  a claim corrected; `allocateAdvancedTags` still steps around root names (it costs nothing and keeps
  HQ's injected names distinct).
- Run on pull request 7's first push (Actions run 41505876754): outcome A. Section 27 records how it
  landed, and `harness-findings.md` records N1 with the run's records.

**G4. A worker property whose slug starts with `_`.** Where: pull request 7's lane on its first push
over `targeted-worker-underscore-write`: the bar (HQ's build of both forms), proof 3 (the worker's case
after each submission); the first push's records stand as the run's evidence in `harness-findings.md`
(part 08 §6.2).

- Outcome A, HQ's build refuses the basic write (`update_case word illegal`) and accepts the Save to
  Case one, whose value reaches the worker's case: the clause `worker-property-name` joins section 9.1
  (the worker's load) and part 01's usercase slot, and its shape (`_x` beside `x`) joins
  `advanced-rule-shapes.json`, which `proof/hq/test_advanced_rules.py` reads; such a write takes Save to Case (which asks
  `save_to_case` at publish); N2 is recorded and fixed.
- Outcome B, HQ refuses the basic write and the Save to Case write does not reach the case: a new
  validator code `WORKER_PROPERTY_WRITE_NAME` (soundness, located at the write) refuses a form's write
  of such a property. Validator: `"${formName}" saves the worker property "${slug}", and CommCare HQ
  can't save a property whose name starts with an underscore to a worker's record. You can rename the
  property so it starts with a letter.` Builder: `CommCare HQ can't save "${slug}" to a worker's record,
  because its name starts with an underscore. You can rename it in Worker information so it starts
  with a letter.` The production scan did not count such writes, so the cutover's advisory dry run
  counts them; part 09 §16 meets each as a blocker by rule (`target-gate` with
  `WORKER_PROPERTY_WRITE_NAME`), named only in the evidence archive by app id and finding code, with
  places through `--debug-details` on the operator's terminal, for the person to rename the property
  before the window. `targeted-worker-underscore-write` is then inadmissible: it leaves
  `TARGETED_DOCUMENTS` in the same pull request, its first push's records keep the evidence, and the
  code's validator test pairs the refusal with an accepted write. N2 recorded and fixed.
- Outcome C, HQ builds the basic write and it lands: no clause and no code; N2 is recorded as a claim
  corrected.

**G6. The owner of an extension-only open action.** Where: `AdvancedFormRuntimeTest` (Core over HQ's
build and the local injection) and pull request 7's proof 3 case blocks over `targeted-advanced-module`.

- Outcome A, the case is owned by the worker on both paths and in HQ's case processing: section 10
  stands.
- Outcome B, the case stays owned by `-`: the second row of section 10's table writes nothing (HQ's
  `-`), and `nova_owner_` is written only for an explicit `unowned` with a `child` index (calculate
  `'-'`); a carried extension create placed on an open action is unowned, and the builder, the SA and
  MCP say so before it commits, in part 07's words (its G6 outcome B): under the rail of such a create,
  `CommCare HQ gives this case no owner, so it syncs to whoever holds the case it extends.`;
  `getCaseOperations` gives such a change `unowned: true`; and `addCaseOperations`' description gains
  part 07's sentence, which pull request 7's `MODEL_CONTEXT_VERSION` covers. Preview's
  submission writes owner `-` for such a create (`submissionEnvelope.ts`); its restore scope already
  follows HQ's extension closure (`sql/compileRestoreScope.ts`), so the case reaches whoever holds its
  host. `harness-findings.md` records C3 with the run.

---

## 30. Files by pull request

**Pull request 4** (with part 01; part 10 reconciles):
- `lib/commcare/casePlacementPlan.ts` (new): the plan type, the basic and Save to Case arms, held
  Save to Case paths written verbatim, the interim extension branch of section 14.4, `datums`,
  `appendedNames`.
- `lib/commcare/formActions.ts` (the basic projection of the plan), `lib/commcare/xform/caseOps.ts`,
  `xform/caseBlocks.ts`, `expander.ts`, `compiler.ts`, `session.ts`, `formLinkProjection.ts` (read the
  plan), `planPrivileges.ts` (`save_to_case`, `child_cases` from the plan).
- `xform/generatedNodes.ts` reserves held Save to Case paths before allocating, since the operation's
  and the own close's held slots land in this pull request (written by test fixtures and specs until
  pull request 5's `holdPlacements`).
- `formLinkProjection.ts::entryDatumIdResolver` first-wins; `lib/commcare/__tests__/entryDatumResolver.test.ts`,
  `casePlacementPlan.test.ts` (basic cases and held paths).

Pull request 5 holds no file of this part: the `holdPlacements` mutation, the kernel rule's editor
half, `HELD_PLACEMENT_INEXPRESSIBLE` and `withIdentityMoves` are parts 01, 03 and 07's, and this
part's planner and gate arms join them in pull request 7.

**Pull request 7:**
- New: `lib/commcare/moduleKind.ts`, `lib/commcare/advancedSelections.ts`,
  `lib/commcare/advancedTags.ts`, `lib/commcare/advancedPlacement.ts`,
  `lib/commcare/xform/advancedCaseBlocks.ts`, `lib/domain/advancedModule.ts`,
  `lib/commcare/validator/rules/advancedModule.ts`, `lib/doc/moduleKindMoves.ts`,
  `lib/commcare/__tests__/advancedDocArbitrary.ts`.
- Changed: `lib/commcare/casePlacementPlan.ts` (the advanced arm; the interim branch removed),
  `hqShells.ts` (`advancedModuleShell`, `advancedFormShell`), `types.ts`, `expander.ts`, `compiler.ts`,
  `session.ts`, `formLinkProjection.ts` (`linkCarriedCreates`, the advanced branch, the `moduleKinds`
  context option), `xform/generatedNodes.ts` (purpose `owner`), `xform/sourceCaseWrites.ts`,
  `addOns.ts`, `hqJson/xpath.ts`, `validator/errors.ts`, `validator/gate.ts`,
  `validator/hqJsonOracle.ts`, `validator/rules/index` registration, `validator/rules/casePlacement.ts`
  (`CASE_PLACEMENT_KIND` and `HELD_PLACEMENT_INEXPRESSIBLE`'s `module-kind` arm), and each basic-key
  reader of section 7.3; `lib/commcare/placement.ts` (part 01's procedure calls the eligibility module
  and takes `moduleKind`; its expressibility gains section 14.5's clause); `lib/domain/modules.ts`
  (`heldKind`); `lib/doc/incrementalValidationScope.ts`; `lib/doc/userFacingErrors.ts`
  (`FORM_LINK_NEEDS_NEW_CASE_DATUM`, `CASE_PLACEMENT_KIND`); `lib/doc/identityMoves.ts` (the source
  registered first, with part 07; the reasons and labels it states are part 07's pull request 5 copy);
  `lib/case-store/store.ts` and `lib/case-store/sql` (`SelectedParentCases.index`);
  `lib/case-store/postgres/submissionEnvelope.ts` and `lib/preview` (`buildSubmissionOperationProgram`,
  `caseSelectionNavigation.ts`, `app-tests/navigation.ts`) for sections 20's two changes.
- Riding this pull request, each listed by its owner: part 03's `module-kind` arm of `holdPlacements`
  (`lib/doc/types.ts`, `lib/doc/placementHolds.ts`, `lib/commcare/placementHolds.ts`), and part 07's
  forced surfaces (the dialog's menu rows, `getModule`'s `advanced`, the snapshot's `[advanced]`, the
  guide paragraph and `MODEL_CONTEXT_VERSION` `.7`).
- Deleted: `lib/commcare/subcaseWire.ts`.
- Proof (part 08's files): `proof/known-defects.json`, `proof/fixed-defects.json`,
  `proof/checks/registers.py` (`OPEN_DEFECTS`), `lib/commcare/surface/entries/{menus-and-case-lists,forms-and-case-writes}.json`,
  the inventory rows, `proof/checks/manifest_value_classes.py`, the six targeted documents of section
  24.4 marked 7 (in `proof/targeted/documents/advancedModules.ts`), `proof/targeted/index.ts`,
  `proof/README.md`, `proof/native/core/AdvancedFormRuntimeTest.java`, `proof/native/families.py`,
  `proof/native/producers/*`, `proof/native/test_advanced_emission.py`, `proof/hq/test_advanced_rules.py`
  with `proof/hq/fixtures/advanced-rule-shapes.json`, `lib/commcare/surface/entries/gates.json` (G4's effects),
  `docs/research/2026-09-26-hq-round-trip/harness-findings.md`.
- Tests: section 26 marked 7.
- Docs: `lib/commcare/CLAUDE.md`, `lib/domain/CLAUDE.md`, `lib/doc/CLAUDE.md`, `lib/case-store/CLAUDE.md`,
  `lib/preview/CLAUDE.md` (section 25).

**Pull request 8:** `lib/commcare/moduleKind.ts::advancedModulesWithCaseListMenuItem` (reading
`caseListOnly`) and its `moduleKind.test.ts` cases, the advanced menu-item arm's Vitest witness until
pull request 10; `proof/targeted/__tests__/unproducedInputs.test.ts` (the product_id bullet moved to
part 03's `publishChecks.test.ts`). Part 03 owns the rest.

**Pull request 10** (with part 05): the blockers and `advancedModulesWithCaseListMenuItem` read
`moduleHasCaseListMenuItem` and `moduleFormsReadSearch`; `expander.ts` and `session.ts` write the
advanced module's menu item entry beside forms (its entry and datum exist from pull request 7 for a
module with no forms); the copy row of section 15 marked "from pull request
10"; `menus-and-case-lists/module-case-list-show-true-on-an-advancedmodule` flipped with part 05's
outcome; `targeted-commtrack-advanced` (part 08's file `proof/targeted/documents/advancedModules.ts`),
the CommTrack menu-item reason's lane witness, with the run's `product_id` effect in `gates.json`.

**Pull requests 12 and 13** (part 07): the new surfaces of section 22. **Pull request 14** (part 09): M1
to M3. **Pull request 15** (part 10): `docs/architecture/complex-apps.md`, `contracts.md`,
`content/docs/case-changes.mdx`.

Reason for writing into pull request 4: the plan is the one place every placement becomes wire, and
part 01's operations replace field writes in pull request 4, so the basic and Save to Case arms must
exist there; a held slot lands with the stored concept it holds, so the held paths the plan writes
verbatim land there too, though nothing but fixtures writes a hold before pull request 5; pull request
7 adds the arm that needs advanced modules, and the held kind with it.

---

## 31. What other parts read from this one

| Part (pull request) | Reads |
|---|---|
| Part 01, case writes (4, 5, 7) | `planFormCaseWire` as the emitter of every placement, held paths included from pull request 4; the option `moduleKind` its `planPlacements` takes, its step 1 reading `emittedModuleKind` otherwise (not a `lib/domain` predicate: the kind reads `planPlacements` itself); `loadIneligibility` and `openActionIneligibility` (`lib/commcare/advancedPlacement.ts`) as the advanced arm of its procedure; the clause of section 14.5 in `placementIneligibility`; the advanced target rule (a chain case through the session datum of its selection, section 3.4); from pull request 4 to 6, the placement `{save-to-case, path: ["nova_subcases", "nova_subcase_<n>"]}` for an extension create its planner writes for a field (section 14.4); `CASE_PLACEMENT_KIND` and the `module-kind` arm of `HELD_PLACEMENT_INEXPRESSIBLE` joining its `casePlacement.ts` in pull request 7 (section 5); that `planModuleKindMoves` runs before `planOperationPlacementMoves` (section 21); that no `Form.caseSelections` and no `selection` target or `form-case.selection` exist in step 5 (section 6.3); under G3 outcome A the `appended-name-taken` clause on its basic subcase and usercase slots and the appended names in `HELD_BLOCK_PATH_TAKEN`; under G4 outcome A the `worker-property-name` clause on its usercase slot |
| Part 03, publish (6, 7, 8) | `emittedModuleKind` and `heldKind` for `placementsToHold` (the `module-kind` hold); the `module-kind` target, its slot and its `holdExpresses` dispatch to `heldKindExpresses` landing together in pull request 7; the kernel rule's two editor ways for the held kind, the move and the restoring undo (section 5); `advancedModulesWithCaseListMenuItem` for `commtrackReasons`, reading `caseListOnly` before pull request 10 and `moduleHasCaseListMenuItem` from it, the advanced menu item beside forms first emitted in pull request 10; that `show_product_stock` is never a reason; `publishedCaseBlocks` reads advanced blocks by `get_action_path` (section 2) |
| Part 05, search and menus (10) | the blockers and `advancedModulesWithCaseListMenuItem` read `moduleHasCaseListMenuItem` and `moduleFormsReadSearch`; the advanced menu item entry takes G1's outcome with the basic beside-forms entry, flipped in pull request 10 |
| Part 06, form links (7, 11) | `linkCarriedCreates`; `nearestOfferedMenu` and `menuTargetOffered` in section 15's copy and M1's retarget; the advanced entry datums `resolveFormLinkTarget` and `formLinkTargetDatumIds` read (section 13), each carrying its case type (`FrameDatum.caseType`, which the held-case guard reads); `FORM_LINK_NEEDS_NEW_CASE_DATUM` in its list of codes applied to every entry |
| Part 07, authoring (5, 7, 12, 13) | section 22's readers (`advancedKindReasons` is its `advancedModuleReason`, with the reasons `held` and `carried-create` only); the `module-kind` move, one planner registered first in `withIdentityMoves`, whose sentence states the renamed session values from this part's facts; section 21's reasons (`several-cases`, `case-list-menu-item-narrowed`, `chain-index` added to its pull request 5 copy beside its `forms-read-search` and `advanced-change`) and its labels `advanced-menu`, `ordinary-menu`; the restoring undo of section 21; `FORM_LINK_NEEDS_NEW_CASE_DATUM`'s builder sentence, also the disabled reason of section 17; under G6 outcome B its own unowned sentence, `unowned: true` and the `addCaseOperations` sentence |
| Part 08, proof (7, 8, 10) | section 24: the 26 moves, the flips, the value-class readers, the targeted documents by its names (`targeted-advanced-module`, `targeted-extension-carried`, `targeted-commtrack-advanced`, and the four added, `targeted-advanced-child-module`, `targeted-advanced-held-kind`, `targeted-root-case-block-names`, `targeted-worker-underscore-write`, with the content section 24.4 gives), `AdvancedFormRuntimeTest`, the fixture `proof/hq/fixtures/advanced-rule-shapes.json` `advancedPlacement.test.ts` writes, the reader tests, `advancedDocArbitrary.ts` outside the proof sample, G2, G3, G4, G6 |
| Part 09, cutover (14) | M1 to M3 and the scan's findings of section 23 (each class ships; the dry run counts what it meets); `linkCarriedCreates` (its brief's `formLinkCarriesCreatedCase`), `emittedModuleKind`, `advancedKindBlockers`; that the placement step never holds a Save to Case placement of a carried create, holds an unread baseline's extension create at today's `nova_subcases` path where it is not carried, and holds no basic placement or module kind for a module M1 turns advanced; the notice reasons `module-made-advanced` and `form-link-goes-to-menu`, the deployment causes `extension-case-moved`, `subcase-renumbered` and `module-made-advanced`; under G4 outcome B the dry run's count and the blocker |
| Part 10, contracts (15) | section 25's sentences; the files of section 30, with the held paths in pull request 4 and the held kind in pull request 7 |
| **For the step 6 outline** | import refuses an advanced form whose selections its module's chain does not give (a load beyond the chain, or a chain that differs between the module's forms), naming the form and the load, because the stored selections that would hold it are step 7's (section 6.3); an HQ `preload` becomes a default only where nothing later reads the question at load (section 11); `show_product_stock` true is refused |
| **For the step 7 outline** | group 6: stored case selections, with the reason that no Nova document needs them before an imported advanced form: several selected cases per form, a second case chosen from another menu's list (its stored shape, a `DatumRef` for two selections from one list, its Preview step, its authoring), a chain that differs between a module's forms, auto-selection (`Module.autoSelectSingle` with its Web Apps row, the four other auto-select modes) and computed datums; they make a third advanced trigger reachable (a form selecting a case beyond its module's chain), and `formEntrySyncReasons` then reads the selection (section 18); a relationship chosen per submission and a label as a write source. Group 4: several address columns and the cross-tab tile row on an advanced detail. Group 3: the arms of `caseListRegistrationForm` that need no search, which bring HQ's six advanced case-list rules (section 16) |
