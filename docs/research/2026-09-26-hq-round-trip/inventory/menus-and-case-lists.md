# Menus and case lists

Part of the surface inventory of the HQ round-trip research. Section names in quotes and defect numbers refer to the main document, [`../README.md`](../README.md). Rows that point elsewhere with `→` name the section that owns the item; the inventory [`README.md`](README.md) says which file holds each section.

## Module types

| HQ item | Disposition | Web Apps / Android | Emission |
|---|---|---|---|
| `Module` with `case_type` (case list module) | **HELD**: `Module` with `caseType` | RUNS / RUNS | `doc_type: Module`, `module_type: basic` |
| `Module` with `case_type: ""` (survey module) | **HELD**: `Module` without `caseType` | RUNS / RUNS | same, `case_type: ""`, short detail holding HQ's default `name` column (Nova emits an empty short list today) |
| `Module` with `is_training_module: true` (training menu, `root="training-root"`) | **REFUSED**: retiring (TRAINING_MODULE) | — | — |
| biometric template (`views/modules.py::new_module` `biometrics`) | → Module types, Case list callout and Question types: no state of its own; it yields ordinary `Module`s, a case list form and a callout with a placeholder response, each classified in those sections | — | — |
| `AdvancedModule` | **HELD-NEW**: derived: a module is emitted as advanced exactly when one of its forms holds case selections (`Form.caseSelections`, Advanced form actions) or holds an operation placed on an advanced action ("Case writes"), its case list or detail holds several address columns or a detail tile row across tabs (rows below), its case type is `commcare-user` (the usercase list module), it holds `Module.autoSelectSingle`, or it was published or imported as advanced (a module's kind is then held like a placement, so an advanced module that no longer needs it, such as one of surveys, stays advanced until an edit needs a basic module, "Case writes"); no `parent_select` | RUNS / RUNS | `doc_type: AdvancedModule`; APP_BUILDER_ADVANCED (frozen) gates only creating an advanced module in HQ, so it is no precondition |
| `ShadowModule`, `shadow_module_version: 2` | **HELD-NEW**: `Module.mirrorOf`: re-lists another module's forms under its own menu, case list, search and parent selection; a mirror of a menu with child menus has one child mirror per child menu of its source (below); when a mirror's source is chosen, HQ also gives the mirror its source's parent (`views/utils.py::handle_shadow_child_modules`), and the mirror's parent-menu selector is disabled (`module_view_settings.html`) | RUNS / RUNS | `doc_type: ShadowModule`, `shadow_module_version: 2` |
| `ShadowModule` with no `source_module_id`, or one naming no module | **REFUSED**: not HQ-buildable: `no source module id` (`ShadowModuleValidator`; `ShadowModule.source_module` is then None) | — | — |
| `ShadowModule`, version `1` or key absent (model default 1) | **REFUSED**: retiring (V1_SHADOW_MODULES) | — | — |
| `ReportModule` (mobile UCR) and all of `report_configs` / `ReportAppConfig` / report filters / `complete_graph_configs` | **REFUSED**: retiring (MOBILE_UCR) | — | — |
| unknown module `doc_type` | **REFUSED**: not HQ-buildable: `ModuleBase.wrap` raises | — | — |
| child menu, one tier (`root_module_id` → a parentless module) | **HELD**: `Module.parentModuleUuid`; widen: a child of another case type under a parent with no forms, which HQ builds (`entries.py::add_parent_datums`) and Nova refuses today (`NESTED_MENU_CROSS_TYPE_ROOT_REQUIRES_FORM`) | RUNS / RUNS | `root_module_id`; add-on `submenus` |
| child menu deeper than one tier (grandchild) | **REFUSED**: not HQ-editable: `views/modules.py::_get_valid_parents_for_child_module` offers a parent only to a menu with no children, and offers only parentless menus | — | — |
| `ShadowModule` v2 under a v2 shadow menu, mirroring a non-shadow child of that menu's source (a child mirror) | **HELD-NEW**: `Module.mirrorOf` child mirrors, kept in step with the source's child menus as HQ keeps them: HQ creates one per source child when a mirror's source or a child's parent changes, deletes it with its source or its mirror parent, and offers no way to re-source, re-parent or delete one alone (`views/utils.py::handle_shadow_child_modules`, `views/modules.py::delete_module`, `ModuleBase.user_deletable`); each holds its own menu fields like any mirror | RUNS / RUNS | `root_module_id` naming the mirror parent, `source_module_id` the source child |
| any other module under a shadow menu | **REFUSED**: not HQ-editable: `_get_valid_parents_for_child_module` never offers a shadow parent, and HQ puts a module under a shadow only as one of the child mirrors above | — | — |
| any module under a training menu | **REFUSED**: retiring (TRAINING_MODULE); for a basic module also not HQ-buildable: `training module parent` (`ModuleValidator` only) | — | — |
| `root_module_id` naming a missing module, or a cycle | **REFUSED**: not HQ-buildable: `unknown root`, `root cycle` | — | — |
| menu order that separates a child from its parent | **REFUSED**: retiring (LEGACY_CHILD_MODULES) | — | — |

## Module fields

| HQ item | Disposition | Web Apps / Android | Emission |
|---|---|---|---|
| `ModuleBase.case_list_form` | → Case selection extras | — | — |
| `ModuleBase.name` | **HELD**: `Module.name` (+ localization) | RUNS / RUNS | `name{lang}` |
| `ModuleBase.unique_id` | **TARGET-OWNED**: HQ's id for the menu in each project space, recorded in the deployment ledger against the Nova menu and written back on every update (form links to menus, shadow sources, child menus, parent selection, persistent tiles from another menu, media references and Bulk App Translations workbooks key on it) | n/a | the target's recorded id; Nova-minted for a project space Nova creates the app in (today random per expansion) |
| `ModuleBase.case_type` | **HELD**: `Module.caseType`; widen: the editor's ASCII `^[\w-]+$` (a leading digit, `_` or `-` is authorable; today Nova requires a leading letter) | RUNS / RUNS | `case_type` (Nova writes `''` today for a module whose forms are all surveys and which lists no cases, `formLinkProjection.ts::moduleCaseTypeForActions`, dropping a held case type on publish; defect 14's fix writes the held type) |
| `case_type` = `commcare-user` or `user-owner-mapping-case` on a basic module | **REFUSED**: not HQ-editable: the menu settings page marks the value an error (`modules/bootstrap3/module_view.js` via `app_manager.js::valueIsReservedWord`), though its save does not block it | — | — |
| `case_type` = `commcare-user` on an AdvancedModule | **HELD-NEW**: usercase list module (Usercase) | RUNS / RUNS | `case_type: commcare-user`; privilege `user_case` |
| `module_filter`, value lifts into Predicate | **HELD**: `Module.displayCondition` | RUNS / RUNS | `module_filter`; add-on `display_conditions` |
| `module_filter`, value outside Predicate (any XPath HQ's validator accepts: global casedb counts, lookup reads, `#user` usercase reads) | **HELD-NEW**: typed expression model in `Module.displayCondition` (session-profile `XPathExpression`) | RUNS / RUNS | `module_filter`, printed |
| `module_filter` = `false()`, or `false() and <rest>` (menu reached only by links and entry points) | **HELD-NEW**: `Module.displayCondition` always-false arm, holding `<rest>` as the condition that applies once the menu is back on (today refused: `DISPLAY_CONDITION_ALWAYS_FALSE`) | RUNS / RUNS | `false()` or `false() and (<rest>)` |
| `form_filter` = `false()`, or `false() and <rest>` (form reached only by links and entry points) | **HELD-NEW**: `Form.displayCondition` always-false arm, holding `<rest>` as the condition that applies once the form is back on the menu (today refused: `DISPLAY_CONDITION_ALWAYS_FALSE`) | RUNS / RUNS | `false()` or `false() and (<rest>)` |
| `module_filter` referencing `#case`, `#parent`, `#host` or a bare `.` | **REFUSED**: not HQ-buildable: `invalid case xpath reference` (`xpath.py::_ensure_no_case_references`) | — | — |
| `put_in_root` (display only forms) | **HELD-NEW**: `Module.showFormsInParent` | RUNS / RUNS | `put_in_root: true`; add-on `menu_mode` |
| `put_in_root` + `session_endpoint_id` or inline search, or an end-of-form return to it (`post_form_workflow` `module`, or `parent_module` from a child) | **REFUSED**: not HQ-buildable: `endpoint to display only forms`, `inline search to display only forms`, `form link to display only forms` (a form link to such a menu is not HQ-editable: the editor's link targets leave it out, `views/forms.py`) | — | — |
| `root_module_id` | → Module types (child menus) | — | — |
| `fixture_select.active: true` | **REFUSED**: retiring (FIXTURE_CASE_SELECTION) | — | — |
| `fixture_select.active: false` (stale keys) | **INERT**: nothing emitted | n/a | omit |
| `report_context_tile: true` | **REFUSED**: retiring (MOBILE_UCR) | — | — |
| `auto_select_case` on an advanced module | **HELD-NEW**: `Module.autoSelectSingle` on the list module: HQ applies it to each advanced form's selected-case datum whose case list comes from this module (`suite_xml/sections/entries.py::get_target_module`, `get_manual_datum`); the module's own case list menu item never auto-selects (`AdvancedModule.is_auto_select` returns false) | UNAVAILABLE when exactly one row matches and the datum has `detail-confirm` (null payload, `title.trim()` throws) / RUNS | `auto_select_case: true` |
| `auto_select_case: true` on a basic module | **REFUSED**: not HQ-editable: the menu settings show the checkbox only for an advanced module (`module_view_settings.html`), though HQ reads it when an advanced form's load lists cases from this module (`entries.py::get_manual_datum`) | — | — |
| `is_training_module: true` | → Module types | — | — |
| `session_endpoint_id` | **HELD**: `Module.entryPoint.id`; narrow: HQ's editor requires `slugify(id) == id` and uniqueness across module and form ids (Nova admits `-x`, `x_`, `a--b`) | DIFFERENT (URL launch; toggle checked at runtime) / DIFFERENT (intent/Connect launch only) | `session_endpoint_id`; SESSION_ENDPOINTS precondition |
| `case_list_session_endpoint_id` | **HELD**: `Module.caseListEntryPoint.id` (same grammar) | DIFFERENT / DIFFERENT | same |
| module endpoint id that is not a `slugify` fixed point | **REFUSED**: not HQ-editable: under SESSION_ENDPOINTS, which every endpoint needs, a menu-settings save fails (`views/utils.py::get_cleaned_session_endpoint_id`) | — | — |
| two endpoints sharing an id (module, case-list, form or mirror-form) | **REFUSED**: not HQ-editable where a save compares them (`views/utils.py::_duplicate_endpoint_ids` compares module, form and mirror-form ids, never two case-list ids or a menu's own two ids); otherwise broken at runtime: Core keys endpoints by id (`SuiteParser`), so one replaces the other | — | — |
| `custom_assertions` (module) | **REFUSED**: freeform + retiring (CUSTOM_ASSERTIONS) | — | — |
| `media_image`, `media_audio` (same asset in every language) | **HELD**: `Module.icon`, `Module.audioLabel` | RUNS (on a grid menu, audio IGNORED: no audio control) / RUNS | `media_image{lang}`, `media_audio{lang}` |
| `media_image`, `media_audio` differing by language | **HELD-NEW**: `localizedMedia` on the menu slots | RUNS / RUNS | per-language paths |
| `use_default_image_for_all`, `use_default_audio_for_all` | **HELD**: folded into the media slot (true ⇒ the default language's asset in every language) | RUNS / RUNS | `false` with the same path per language (in-envelope) |
| `custom_icons[0]` (badge: localized text or XPath) | **HELD-NEW**: `Module.badge` (`{text{lang}} \| {expression}`) | RUNS / DIFFERENT (hides `0`; shows text longer than 3 characters as `999+` when it parses as an integer and otherwise as its first 3 characters and `..`, `MenuAdapter.updateBadgeView`) | `custom_icons[0]`; privilege `custom_icon_badges` |
| `custom_icons[1:]` | **INERT**: only `[0]` is read | n/a | omit |
| `comment` (module) | **INERT**: builder note, no reader | n/a | omit |
| `Module.forms` | **HELD**: `formOrder[module]` | RUNS / RUNS | ordered `forms` (positional `m{i}-f{j}`) |
| `Module.case_details` | → Case list and case detail | — | — |
| `Module.ref_details` | **INERT**: never emitted (`get_details` hard-codes `ref_*` off) | n/a | HQ default shell |
| `Module.case_list` on a formless module (`show: true`) | **HELD**: `Module.caseListMenuItem` on a menu with no forms (Nova's `caseListOnly` today, which migrates into it) | DIFFERENT (selecting a case leaves an empty list) / RUNS (with no case detail, selecting a case returns to the home screen) | `case_list.show/label`; add-on `case_list_menu_item`; label required |
| `Module.case_list.show: true` on a module with forms | **HELD-NEW**: `Module.caseListMenuItem` beside forms (today refused: `CASE_LIST_ONLY_HAS_FORMS`) | DIFFERENT (selecting a case from that list leaves an empty list) / RUNS | `case_list.show: true` + label |
| `Module.case_list.label{lang}` | **HELD-NEW**: `Module.caseListLabel` (Nova reuses the module name today) | RUNS / RUNS | `case_list.label` |
| `Module.case_list.media_image`, `.media_audio` | **HELD**: `caseListConfig.icon`, `audioLabel` | RUNS / RUNS | `case_list.media_*` |
| `Module.referral_list` | **INERT**: emits only an unread app string (`app_strings.py::_create_referral_list_app_strings`), no command | n/a | omit |
| `Module.task_list.show: true` | **REFUSED**: not HQ-editable: the Task List setting renders only with the case list menu item add-on, outside shadow and survey menus, and then only when already on or, in a basic module, `Domain.survey_management_enabled`, which nothing sets (`module_view_settings.html`); it also injects a `cc_delegation_stub` block (`xform.py::_create_casexml`) | — | — |
| `Module.task_list.show: false` | **INERT**: default | n/a | omit |
| `Module.parent_select` | → Case selection extras | — | — |
| `Module.search_config` | → Case search | — | — |
| `Module.display_style` (`list`/`grid`, read when `grid_form_menus == some`) | **HELD-NEW**: `menuStyle.moduleGrid` | RUNS / RUNS | `display_style` |
| `Module.lazy_load_case_list_fields: true` | **REFUSED**: retiring (CASE_LIST_LAZY) | — | — |
| `Module.show_case_list_optimization_options` | **HELD-NEW**: `caseListConfig.optimizations` (enables per-column cache/lazy, Detail columns) | DIFFERENT (no cache; laziness whole-detail) / RUNS | `show_case_list_optimization_options: true`; CASE_LIST_OPTIMIZATIONS |
| `Module.display_separately` | **INERT**: written by `edit_module_attr`, read by nothing | n/a | omit |
| `AdvancedModule.product_details` equal to the default single `name` column | **INERT**: created by `AdvancedModule.new_module`, not content, in a project space without CommTrack; where `Domain.commtrack_enabled` is on, HQ builds the product list (`AdvancedModule.get_details`) and gives the module's case list menu item a `product_id` datum (`entries.py::EntriesHelper.entry_for_module`), COMMTRACK content, which defect 20's confirmation covers | n/a | the default |
| `AdvancedModule.product_details` differing from the default | **REFUSED**: retiring (COMMTRACK) | — | — |
| `AdvancedModule.has_schedule`, `schedule_phases`, `SchedulePhase{anchor, forms}` | **REFUSED**: retiring (VISIT_SCHEDULER) | — | — |
| `ShadowModule.source_module_id` | → Module types (`Module.mirrorOf`) | — | — |
| `ShadowModule.excluded_form_ids` empty | **HELD**: the mirror re-lists every source form | RUNS / RUNS | `[]` |
| `ShadowModule.excluded_form_ids` non-empty | **HELD-NEW**: `Module.mirrorOf.excludedForms` (form identities): the app source keeps these as real form ids while re-minting the forms' own ids, and the reader maps them through the real ids from `ApplicationResource` | RUNS / RUNS | real form `unique_id`s |
| `ShadowModule.form_session_endpoints` empty | **INERT**: default | n/a | `[]` |
| `ShadowModule.form_session_endpoints` non-empty | **HELD-NEW**: `Module.mirrorOf.formEntryPoints` (form identity + endpoint id), mapped through the real form ids from `ApplicationResource` | DIFFERENT / DIFFERENT (as for module and form entry points, Module fields) | `form_session_endpoints`; SESSION_ENDPOINTS |
| `ShadowModule.case_type` (stored key) | **INERT**: shadowed by a property derived from the source | n/a | omit |
| `ShadowModule` own `case_details`, `search_config`, `parent_select` | → Case list and case detail, Case search and Case selection extras (as for basic modules; multi-select is inherited from the source) | — | — |
| `ShadowModule.case_list.show: true` | **REFUSED**: not HQ-editable: the menu page hides the setting for shadows (`module_view_settings.html`), and HQ would build a case-list entry with no case datum (`suite_xml/sections/entries.py::entry_for_module` adds it only for `Module` and `AdvancedModule`) | — | — |
| `ShadowModule.case_list.show: false` | **INERT**: default | n/a | omit |
| module `unique_id` missing | **REFUSED**: unrepresentable identity: the module has no stable id until HQ saves one; HQ's build catches `ModuleIdMissingException` and gives the build copy a random id (`make_build` validates its copy), while the app keeps none, until HQ gives its menus ids and saves: App Preview downloads the current app (`views/cli.py::get_direct_ccz` validates the app itself), a menu's page opens (`views/modules.py::get_module_view_context`, reached from a menu with an id, from adding a menu, or through the legacy `/modules-<index>/` address), or an edit that looks a menu up by id saves (`Application.get_module_by_unique_id`); HQ's menu list links an id-less menu to `/module/None/`, "Page not found" (executed); so opening App Preview once in HQ fixes it, and making a new version does not | — | — |

## Case list and case detail

HQ's build runs its case list and case detail checks (`ModuleDetailValidatorMixin.validate_details_for_build`) only for basic and shadow modules; an advanced module's validator never calls them (`helpers/validators.py::AdvancedModuleValidator`; executed: two address columns, a bad filter and a bad sort field build there). A row refused by one of those checks names what happens in an advanced module. Search-result details (`search_short`/`search_long`) are deep copies of the case list with `instance_name='results'` (`ModuleDetailsMixin.search_detail`, and `AdvancedModule.search_detail`), so every row applies to them too. Nova's one column set serves both surfaces (`visibleInList` / `visibleInDetail`, two orders); an HQ property shown differently on the list and the detail imports as two Nova columns.

### Detail screens (`Detail`)

| HQ item | Disposition | Web Apps / Android | Emission |
|---|---|---|---|
| `Detail.display` | **INERT**: forced by `DetailPair.wrap` | n/a | `short` / `long` |
| `Detail.columns` (short) | **HELD**: `caseListConfig.columns` + `listColumnOrder` (`visibleInList`) | RUNS / RUNS | `case_details.short.columns` |
| `Detail.columns` (long) | **HELD**: `caseListConfig.columns` + `detailColumnOrder` (`visibleInDetail`) | RUNS / RUNS | `case_details.long.columns` |
| short `columns` empty on a module that needs case details | **REFUSED**: not HQ-buildable: `no case detail` | — | — |
| short `columns` empty on a survey or registration-only module that no module's active `parent_select` names | **INERT**: no runtime shows it (`requires_case_details()` false; a detail with no columns is never active, `DetailsHelper.active_details`) | n/a | HQ's default `name` column (the editor keeps ≥1 short column; empty is unproducible) |
| short `columns` empty on a module another module's active `parent_select` names | **REFUSED**: broken at runtime: HQ offers any non-multi-select module of another case type as the parent selection (`views/modules.py::get_modules_with_parent_case_type`) and writes the parent datum with no `detail-select`, since the empty detail is never active (`DetailsHelper.get_detail_id_safe`, `active_details`; executed), and Core refuses an entity selection with no short detail (`EntityScreen.setSession`) | — | — |
| long `columns` empty | **HELD**: no long detail (selection is immediate) | RUNS / RUNS | `[]` |
| `Detail.filter`, value lifts into Predicate | **HELD**: `caseListConfig.filter` | RUNS / RUNS | `filter` (dot-interpolated XPath) |
| `Detail.filter`, value outside Predicate | **HELD-NEW**: typed expression model in `caseListConfig.filter` (row-context `XPathExpression`) | RUNS / RUNS | `filter`, printed |
| `Detail.filter` failing `etree.XPath('dummy[<filter>]')` | **REFUSED**: not HQ-buildable in a basic or shadow module: `invalid filter xpath`; in an advanced one, where HQ does not check it, broken at runtime: Core cannot parse the nodeset (executed) | — | — |
| `Detail.instance_name` = `casedb` | **INERT**: the default; HQ switches it for search details | n/a | omit |
| `Detail.instance_name` any other stored value | **REFUSED**: not HQ-editable: no editor sets it, and `Detail.get_instance_name` puts it in relation-column XPath and tab nodesets | — | — |
| `Detail.multi_select` | **HELD**: `caseListConfig.selection {kind: multiple}` | RUNS / UNAVAILABLE (navigation stalls on the home screen) | `multi_select: true`; CASE_SEARCH_ADVANCED; never on shadow or advanced modules |
| `Detail.auto_select` (multi-select) | **HELD-NEW**: `caseListConfig.selection.autoSelect` | RUNS / UNAVAILABLE | `auto_select: true` |
| `Detail.auto_select: true` on a single-select basic list | **REFUSED**: not HQ-editable: the editor enables the auto-select box only with multi-select (`case_list_multi_select.html`) and clears auto-select when multi-select is turned off (`details/screen.js`) | — | — |
| `multi_select`, `auto_select` or `max_select_value` on an advanced or shadow module's own case list | **INERT**: HQ's "Overwrite case list" copies them there (`views/modules.py::overwrite_module_case_list`, `_update_module_short_detail`), but nothing reads them: `AdvancedModule.is_multi_select` returns False and a shadow module reads its source | n/a | omit |
| `Detail.max_select_value` | **HELD**: `selection.maximum`; widen: any positive integer (Nova caps at 100; a 0 or empty value saves as 100, `views/modules.py::_update_short_details`, and a negative one makes every selection exceed it) | RUNS / UNAVAILABLE | `max_select_value` |
| `Detail.case_tile_template: custom` | **HELD**: `caseListConfig.tile` + `column.tile` cells | RUNS / RUNS | `custom`; CASE_LIST_TILE + CASE_LIST_TILE_CUSTOM (custom is dropped by a save under CASE_LIST_TILE alone) |
| `Detail.case_tile_template: icon_text_grid` | **HELD-NEW**: `caseListConfig.tile.template: icon_text_grid` (+ per-column slot mapping, Detail columns) | RUNS (each slot renders its column's format) / DIFFERENT (icon and clickable-icon slots print raw `jr://` paths) | `icon_text_grid` with all ten template fields mapped (HQ's build refuses a missing one: `invalid tile configuration`, and in an advanced module by raising `SuiteError` from `case_tiles.py::_get_matched_detail_column`, which `validate_app` does not catch); CASE_LIST_TILE |
| `Detail.case_tile_template: person_simple` | **REFUSED**: broken at runtime: Web Apps shows a literal `<b>Header </b>` per slot, and the template hard-codes a registration action to `m0-f0` / `case_id_new_rec_child_0` whatever the module (`case_tile_templates/person_simple.xml`) | — | — |
| `Detail.case_tile_template` other than `custom`, `person_simple` or `icon_text_grid` (such as a removed slug: `bha_referrals`, `one_3X_two_4X_one_2X`, `one_one_two`, `one_two_one`, `one_two_one_one`, `one_two_two`, `clinic_and_unit_tile_with_centered_last_field`, `parent_and_child`) | **REFUSED**: not HQ-buildable: `invalid case type template`, and in an advanced module by raising `CaseTileMisconfigurationError` (`case_tiles.py::case_tile_template_config`), which `validate_app` does not catch | — | — |
| long-detail `custom` tile (case detail laid out as a tile) | **HELD-NEW**: `caseListConfig.detailTile` | RUNS / IGNORED (standard rows) | long `case_tile_template: custom`; CASE_LIST_TILE + CASE_LIST_TILE_CUSTOM |
| long-detail non-`custom` tile | **REFUSED**: not HQ-editable: HQ's Case Detail editor offers only "Don't Use Case Tiles" and `custom` (`details/bootstrap5/screen.js` adds the named templates only for the case list), in any module; in a basic or shadow module HQ's build also refuses it ("Case tiles on the case detail must be manually configured"; an advanced module builds it, executed) | — | — |
| `Detail.persist_tile_on_forms` | **HELD**: `tile.persistOnForms` | RUNS / RUNS | `persist_tile_on_forms: true` |
| `Detail.persistent_case_tile_from_module` | **HELD-NEW**: `tile.persistFrom` (another module's tile) | RUNS / RUNS | module unique id; CASE_LIST_TILE |
| `Detail.pull_down_tile` | **HELD-NEW**: `tile.pullDown` (`detail-inline`) | RUNS / RUNS | `pull_down_tile: true` (with persist) |
| `Detail.case_tile_group` (`index_identifier`, `header_rows`) | **HELD**: `tile.grouping {identifier, headerRows}` | RUNS / IGNORED (flat list) | `case_tile_group`; CASE_LIST_TILE |
| `Detail.persist_case_context` + `persistent_case_context_xml` | **HELD-NEW**: `caseListConfig.persistentContext` (one-field persistent tile; value lifts into ValueExpression, else the typed expression model) | RUNS / RUNS | both keys; SHOW_PERSIST_CASE_CONTEXT_SETTING |
| `Detail.custom_xml` | **REFUSED**: freeform + retiring (CASE_LIST_CUSTOM_XML) | — | — |
| `Detail.custom_variables_dict` | **REFUSED**: freeform + retiring (CASE_LIST_CUSTOM_VARIABLES) | — | — |
| legacy `Detail.custom_variables` key | **INERT**: pre-migration key with no reader | n/a | omit (Nova emits `null` today: unproducible) |
| `Detail.no_items_text` other than HQ's default `{en: "List is empty."}` | **HELD-NEW**: `caseListConfig.emptyText` | RUNS / IGNORED | `no_items_text{lang}`; USH_EMPTY_CASE_LIST_TEXT on the target (HQ emits the text only there, `feature_support.py::supports_empty_case_list_text`) |
| `Detail.no_items_text` equal to HQ's default | **INERT**: HQ's model default (`models/case_list.py::Detail`), which HQ emits in a target with the flag whether or not the app carries it | n/a | omit |
| `Detail.select_text` = default `{en: Continue}` | **INERT**: default | n/a | omit |
| `Detail.select_text` non-default | **HELD-NEW**: `caseListConfig.selectButtonText` (editor: Bulk App Translations edits the existing string; saves keep it) | DIFFERENT (labels only the multi-select Continue) / IGNORED | `select_text{lang}` |
| `Detail.lookup_*` (callout) | → Case list callout | — | — |
| `Detail.sort_elements` | → Sorting | — | — |
| `Detail.tabs` | → Detail tabs | — | — |
| `Detail.print_template` | **INERT**: removed-toggle residue (`case_detail_print`), no reader | n/a | omit |
| `module.lazy_load_case_list_fields` detail flag | → Module fields | — | — |

### Detail columns (`DetailColumn`)

| HQ item | Disposition | Web Apps / Android | Emission |
|---|---|---|---|
| `header` | **HELD**: `column.header` (+ localization) | RUNS / RUNS | `header{lang}` |
| `model: case` | **HELD**: implicit | n/a | `case` |
| `model: product` | **REFUSED**: retiring (COMMTRACK) | — | — |
| `field` (property; paths in Column field paths) | **HELD**: `column.field` | RUNS / RUNS | `field` |
| `field` failing `details/utils.js::isValidPropertyName` (non-calculated) | **REFUSED**: not HQ-editable (save blocked) and, in a basic or shadow module, not HQ-buildable (`invalid sort field` for sorts) | — | — |
| `useXpathExpression` + `field` XPath lifting into ValueExpression | **HELD**: `calculated` column | RUNS / RUNS | `useXpathExpression: true`, `format: plain`; add-on `calc_xpaths` |
| `useXpathExpression` + `field` XPath outside ValueExpression | **HELD-NEW**: typed expression model in the `calculated` column | RUNS / RUNS | same |
| calculated column reading `results`/`search-input` instances in a non-search detail without auto-launch | **REFUSED**: not HQ-buildable: `case search instance used in casedb case details` | — | — |
| `format` | → Column formats | — | — |
| `enum[]` `MappingItem.key` / `.value{lang}` | → Column formats (id-mapping, image-map, conditional and translated-text entries) | — | — |
| `enum[]` `MappingItem.alt_text{lang}` | **HELD-NEW**: `imageMap[].altText` | RUNS / IGNORED | `alt_text` |
| `graph_configuration` non-empty on a `graph` column | → Column formats, `graph` (refused) | — | — |
| `graph_configuration` non-empty on any other column | **INERT**: only the `graph` format reads it (`detail_screen.py::Graph`, app strings), and every save writes `null` there (`column.js::serialize`) | n/a | omit |
| `graph_configuration: null` | **INERT**: every column save writes it | n/a | `null` |
| `case_tile_field` (template slot) on `icon_text_grid` | **HELD-NEW**: `column.tileSlot` | RUNS / DIFFERENT (as for the template) | `case_tile_field` |
| `grid_x`, `grid_y`, `width`, `height` (custom tile) | **HELD**: `column.tile.{x, y, width, height}` | RUNS / RUNS | the four keys |
| custom-tile column with `grid_*` `null` (unplaced) | **REFUSED**: not HQ-editable: the editor stores coordinates for every column; a save rewrites to (0,0,6,1), which Android draws over the top-left cell | — | — (Nova emits unplaced carriers today: save-breaking; in-envelope: every tile column placed, sort carriers kept out of the tile detail) |
| `horizontal_align`, `vertical_align` | **HELD**: `tile.horizontalAlign`, `verticalAlign` | RUNS / DIFFERENT (`vert-align` only `center` honoured) | keys, always explicit |
| `horizontal_align: null` on a placed custom tile column | **REFUSED**: not HQ-editable: every save writes `left` (`column.js` defaults and `serialize`), which Android aligns with `Gravity.LEFT` while a missing value takes the text's own start (`EntityViewTile.computeGravity`), so they differ in a right-to-left language | — | — (Nova writes null for a cell with no alignment today, `applyTileLayoutToShortDetail`: save-breaking) |
| `font_size` | **HELD**: `tile.fontSize` | RUNS / RUNS | always explicit (`null` becomes `medium` on save, visibly: save-breaking today) |
| custom-tile `font_size: null` | **REFUSED**: not HQ-editable (the editor always stores a size) | — | — |
| `show_border`, `show_shading` | **HELD**: `tile.showBorder`, `showShading` | RUNS / IGNORED | keys |
| `late_flag` | → Column formats, `late-flag` | — | — |
| `time_ago_interval` | → Column formats, `time-ago` | — | — |
| `date_format` | → Column formats, `date` | — | — |
| `optimization` (`cache`/`lazy_load`/`cache_and_lazy_load`) | **HELD-NEW**: `column.optimization` (calculated columns in address/date/markdown/phone/plain/enum formats) | DIFFERENT (no cache; laziness applies to the whole detail) / RUNS | `optimization`; CASE_LIST_OPTIMIZATIONS + module option |
| `endpoint_action_id` | → Column formats, `clickable-icon` | — | — |
| `filter_xpath` | **INERT**: legacy; no emitter reads it | n/a | `''` |
| `advanced` | **INERT**: no reference anywhere | n/a | `''` |
| UI bookkeeping keys `hasAutocomplete`, `calc_xpath`, `isTab`, `hasNodeset`, `nodeset`, `relevant`, `nodesetCaseType`, `nodesetFilter` | **INERT**: dynamic properties no emitter reads | n/a | HQ's own values (`hasAutocomplete: true` on property columns, `false` on calculated, and `false` on a property column after a save when a new module's Name column lacked it) |

### Column formats (the 24 registered in `detail_screen.py`)

| HQ item | Disposition | Web Apps / Android | Emission |
|---|---|---|---|
| 1 `plain` over a property that is not a select with options | **HELD**: `plain` column | RUNS / RUNS | `plain` |
| 1′ `plain` over a property select questions write | **HELD-NEW**: a plain column that shows the raw value: Nova's `plain` column over a select property shows and sorts by option labels (`hqJson/caseList.ts::projectColumnToDetail` emits `translatable-enum`), while HQ's `plain` shows and sorts the raw value (`detail_screen.py::Plain`) | RUNS / RUNS | `plain` (Nova has no raw-value column over a select property today; its label-showing plain column stays `translatable-enum`, row 21 and defect 10) |
| 2 `date` + `date_format` ∈ {`%d/%m/%y`, `%d/%m/%Y`, `%m/%d/%Y`, `%m/%d/%y`, `%b %d, %Y`} | **HELD**: `date` column `pattern`; narrow: HQ's five patterns (Nova admits any today; the migration turns each Nova date column with another pattern into a calculated `format-date` column with the same display; a new date column takes `%b %d, %Y`) | RUNS / RUNS | `date` + that pattern |
| 2′ `date` + any other `date_format` | **REFUSED**: not HQ-editable: the editor offers five patterns (`column.js` `date_extra`) | — | — (every Nova pattern outside the five, such as `%Y-%m-%d` or any custom pattern, is unproducible today; in-envelope: a calculated `format-date` column with the same display) |
| 3 `time-ago` + `time_ago_interval` ∈ the 7 menu values (years/months/weeks/days since; days/weeks/months until) | **HELD-NEW**: `interval` column widened: threshold optional (count only) and signed direction (since/until) | RUNS / RUNS | `time-ago` + interval |
| 3′ `time-ago` + other interval | **REFUSED**: not HQ-editable (7-value menu) | — | — |
| 4 `phone` | **HELD**: `phone` | RUNS (detail `tel:`) / RUNS (call button) | `phone` |
| 5 `enum` (ID Mapping) | **HELD**: `id-mapping`; narrow: a value holds none of `& < > " '` (5′) | RUNS / RUNS | `enum`: `field` the property, one key per value, sorted by mapping position on every runtime, the position compared as text, so `10` sorts before `2` (`detail_screen.py::Enum`, Core `EntitySorter`); Nova emits `translatable-enum` sorted by label today: defect 10) |
| 5″ `enum` key that is empty or holds whitespace | **HELD-NEW**: ID-mapping keys under Core's `selected()`, which trims only the key and matches it as one token sequence (`XPathSelectedFunc.multiSelected`; executed): an empty key, and a whitespace-only one, which is the same state, labels a blank value (and a value holding two spaces in a row or a leading or trailing space), and a key with inner spaces labels a value holding that token sequence; HQ's editor accepts both (`ui-element-key-val-mapping.js::hasBadXML` checks only XML characters), and Nova refuses them today (`lib/domain/modules.ts`, defect 16) | RUNS / RUNS | the key, a whitespace-only one as `''` |
| `translatable-enum` on a column that is not a calculated property, over a property of the case itself | **HELD-NEW**: the same state as a calculated `translatable-enum` over that property (`translatedExpression`, row 21): HQ's build differs only in the ids it derives for the column's app strings, whose text every runtime reads identically (executed) | RUNS / RUNS | the calculated spelling |
| `translatable-enum` on a column that is not a calculated property, over a relation path, in a module that offers search | **REFUSED**: not HQ-editable: the editor offers it only on calculated properties (`column.js::filterFormats`; it offered it from `44fdd0ba8f7` until `c1697fb5b6e`), and the calculated spelling is not the same state there, since the search fetches related cases for non-calculated relation paths (`case_search/utils.py::get_search_detail_relationship_paths`; executed) | — | — |
| `translatable-enum` on a column that is not a calculated property, over a relation path, in a module that does not offer search | **HELD-NEW**: the same state as the calculated `translatable-enum` over that path (`translatedExpression`): HQ's build differs only in the column's app-string ids, and nothing reads the relation path, which HQ collects only for modules that offer search (executed) | RUNS / RUNS | the calculated spelling |
| 5′ `enum` key containing `& < > " '` | **REFUSED**: not HQ-editable: the mapping editor marks it an error (`ui-element-key-val-mapping.js::hasBadXML`) | — | — |
| 6 `late-flag`, `late_flag` ≥ 1 | **HELD**: `interval` display `flag`, unit days, text `*`, header empty on the case list and the stored header on the case detail (`detail_screen.py::LateFlag` extends `HideShortHeaderColumn`, which blanks a list header, and a detail header only in a nodeset tab of a detail that sorts its nodeset columns, `has_sort_node_for_nodeset_column`) | RUNS / RUNS | `late-flag` + `late_flag` |
| 6′ `late-flag`, `late_flag` ≤ 0 | **HELD-NEW**: `interval` threshold widened to integers ≤ 0, with text and header as in 6 | RUNS / RUNS | same |
| 7 `invisible` ("Search Only") on the case list, outside a custom tile | **HELD**: `visibleInList: false` (a search and sort carrier) | DIFFERENT (searchable; sortable only from the tile "Sort By") / RUNS | `invisible` (Nova drops one that sorts nothing today, `hqJson/caseList.ts::hqShortSourceColumns` and the suite's short detail, though both runtimes' list search matches every field, `EntitySortUtil.sortEntities`: defect 16) |
| `invisible` or `address` column in a custom tile | **HELD-NEW**: the column's tile cell, held with it: HQ's editor saves grid coordinates for every column though it hides them for these formats (`details/bootstrap5/column.js`, `coordinatesVisible`, `serialize`), so a new one sits at `(0,0,6,1)`, and HQ builds the cell (`case_tiles.py::build_case_tile_detail`) | RUNS (hidden: a field whose width hint is 0, `tile_item.html`) / DIFFERENT (drawn at its stored cell, `EntityViewTile.addFieldView`, unless a coordinate is negative) | the column with its cell |
| 7′ `invisible` on the case detail, outside a data tab over a nodeset | **HELD**: a plain column shown on the detail (`visibleInDetail: true`): `Invisible` hides only short-detail columns (`detail_screen.py::HideShortColumn`) | RUNS / RUNS | `plain` |
| 7″ `invisible` inside a data tab over a nodeset | **HELD-NEW**: a hidden ascending sort of that tab's rows (`details.py::get_nodeset_sort_elements`; executed: width 0 and `<sort type="string" order="1" direction="ascending">`) | RUNS / RUNS | `invisible` in the tab |
| 8 `address` | **HELD-NEW**: `address` column kind | DIFFERENT (hidden in the list, plain text on the detail; a map only under the CASE_LIST_MAP flag) / RUNS (Map menu, "show address") | `address`; at most one per detail of a basic or shadow module |
| 9 `distance` | **HELD-NEW**: `distance` column kind (from `here()`) | UNAVAILABLE (never from the user: São Paulo placeholder or blank) / RUNS | `distance` |
| 10 `markdown` (any property or expression) | **HELD-NEW**: `markdown` column kind (Nova's `link` is the fixed `[text](value)` case) | RUNS / DIFFERENT (markdown only on the detail; raw in rows, HTML in tiles) | `markdown` |
| 11 `geo-boundary` | **HELD-NEW**: `mapLayer` column kind `boundary` | IGNORED / RUNS | `geo-boundary`, on the case list only; needs an `address` column |
| 12 `geo-boundary-color`, on the case list only; needs an `address` column and a `geo-boundary` column | **HELD-NEW**: `mapLayer` `boundaryColor` | IGNORED / RUNS | `geo-boundary-color`, on the case list only; needs an `address` column and a `geo-boundary` column |
| 13 `geo-points`, on the case list only | **HELD-NEW**: `mapLayer` `points` | IGNORED / RUNS | `geo-points`, on the case list only, beside an `address` column (the editor resets it to `plain` without one, `details/utils.js` `COLUMN_FORMAT_DEPENDENCIES`) |
| 14 `geo-points-colors`, on the case list only; needs an `address` column and a `geo-points` column | **HELD-NEW**: `mapLayer` `pointColors` | IGNORED / RUNS | `geo-points-colors`, on the case list only; needs an `address` column and a `geo-points` column |
| a geo-* column without the column it depends on | **REFUSED**: not HQ-editable: the editor resets a geo column missing its dependency to `plain` when the page loads (`column.js::updateFormatOptions`) | — | — |
| a geo-* column on the case detail, beside the column it depends on (the editor offers geo formats only on the case list, but pasting a copied column keeps its format, `screen.js::pasteCallback`, `column.js::filterFormats`) | **HELD**: a plain column on the detail: both runtimes show a value whose format they do not know as text (Core's `Style.setDisplayFormatFromString` knows no geo format; Web Apps `case_detail.html`; Android `EntityDetailView`, `setUpText`) | RUNS / RUNS | `plain` |
| 15 `address-popup` | **REFUSED**: retiring (CASE_LIST_MAP) | — | — |
| 16 `clickable-icon` + `endpoint_action_id` | **HELD-NEW**: `clickableIcon` column kind (icon mapping + form entry-point target) | RUNS / UNAVAILABLE (raw `jr://` path as text) | `clickable-icon`; CASE_LIST_CLICKABLE_ICON + SESSION_ENDPOINTS |
| 16′ `clickable-icon` without a valid `endpoint_action_id` on the case list | **REFUSED**: not HQ-buildable: `invalid clickable icon configuration`, `case list field action endpoint missing`; in an advanced module, which skips the first check, an empty id is broken at runtime: HQ emits no action, and Web Apps' click reads it (`menus/views.js::iconClick`) | — | — |
| 16″ `clickable-icon` on the case detail whose `endpoint_action_id` names no entry point | **REFUSED**: broken at runtime: HQ's check that the entry point exists reads only the case list (`validate_case_list_field_actions`), so it builds (an empty id fails `invalid clickable icon configuration` on either detail, `_validate_clickable_icons`), and the icon's action names nothing | — | — |
| `enum-image` column carrying an `endpoint_action_id`: on the case list, one that names a form's entry point; on the case detail, any | **INERT**: HQ emits the endpoint action only with CASE_LIST_CLICKABLE_ICON at 2.54 or later (`EnumImage.action`, `supports_detail_field_action`), except in an `icon_text_grid` tile, which emits it unconditionally (`case_tiles.py::_get_column_context`), and no runtime reads it: Core maps `enum-image` to a plain image (`Style.setDisplayFormatFromString`), Web Apps binds clicks only to clickable icons (`menus/views.js::CaseView`), and Android has no endpoint-action handling | n/a | omit |
| a case list column of any format carrying an `endpoint_action_id` that names no form's entry point | **REFUSED**: not HQ-buildable: `case list field action endpoint missing` (`ModuleBaseValidator.validate_case_list_field_actions` checks every column with one, whatever its format, against form `session_endpoint_id`s only, so a menu's or case list's entry point fails too; `column.js` keeps the value when the format changes) | — | — |
| a column of a format other than `clickable-icon` or `enum-image` carrying an `endpoint_action_id`: on the case list, one that names a form's entry point; on the case detail, any | **INERT**: HQ emits it only in an `icon_text_grid` tile (`case_tiles.py::_get_column_context`), and no runtime reads it there | n/a | omit |
| 17 `picture` | **REFUSED**: retiring (MM_CASE_PROPERTIES) | — | — |
| 18 `audio` | **REFUSED**: retiring (MM_CASE_PROPERTIES) | — | — |
| 19 `enum-image` whose keys are plain values | **HELD-NEW**: `image-map` equality keys: HQ matches by equality (`prop = 'key'`, `MappingItem.key_as_condition`), while Nova's image-map matches `selected()` tokens today (19′) | RUNS / DIFFERENT (in an `icon_text_grid` tile, the raw path) | `enum-image`; add-on `enum_image` |
| 19′ `enum-image` whose keys are conditions (contain any of `{}()[]=<>."'/`), each a key `selected(., '<value>')` | **HELD**: `image-map`, which is how Nova emits its token-matching image map today | RUNS / DIFFERENT (in an `icon_text_grid` tile, the raw path) | `enum-image` |
| 19″ `enum-image` whose keys are conditions of any other form (dot-interpolated XPath) | **HELD-NEW**: `image-map` condition keys | RUNS / DIFFERENT (in an `icon_text_grid` tile, the raw path) | `enum-image` |
| 20 `conditional-enum` | **HELD-NEW**: `conditionalText` column kind (condition → localized text) | RUNS / RUNS | `conditional-enum`; add-on `conditional_enum` |
| 21 `translatable-enum` (authored) | **HELD-NEW**: `translatedExpression` column kind: a calculated expression whose key substrings are replaced by localized variables (one that is exactly Nova's label projection of a select property, `plainSelectDisplayXpath` over the property's options, reads back as a plain column over that property) | RUNS / RUNS | `translatable-enum` + `useXpathExpression`; add-on `calc_xpaths` |
| 21′ `translatable-enum` key outside `[A-Za-z0-9_-]` | **REFUSED**: not HQ-editable: the mapping editor marks it an error and keeps its OK button disabled (`ui-element-key-val-mapping.js::hasBadXML`) | — | — |
| 22 `graph` | **REFUSED**: retiring (GRAPH_CREATION) | — | — |
| 23 `image` (`cc_case_image`) | **REFUSED**: not HQ-editable: its flag (`case_micro_image`) and UI were removed in `1d0f049d84f` | — | — |
| 24 `filter` | **INERT**: emits nothing (`Filter.fields → []`); every save drops it (`screen.js`) | n/a | omit |
| unregistered `format` slug (incl. Nova's own `calculate`) | **HELD**: read as `plain`: `detail_screen.py::get_class_for_format` falls back to `FormattedDetailColumn`, build-identical where the column sets no `optimization` (the `calculate` slug drops cache and lazy loading, `DetailColumn.supports_optimizations`), apart from the slug HQ writes as a field's `form` in an `icon_text_grid` tile (`case_tiles.py::_get_column_context`), which no runtime reads (`Style.setDisplayFormatFromString` knows neither) | RUNS / RUNS | `plain` (Nova writes `calculate` today: unproducible) |
| more than one `address`, `image` or geo-* column in a detail of a basic or shadow module | **REFUSED**: not HQ-editable: the Case List and Case Detail saves refuse a second column of the same `image` or geo-* format (`screen.js::save` counts each format separately); not HQ-buildable: a second `address` fails `invalid tile configuration` (`ModuleDetailValidatorMixin._validate_fields_with_format_duplicate`) | — | — |
| more than one `address` column in a detail of an advanced module | **HELD-NEW**: several address columns, which the map reads differently: Web Apps takes the first address column (`menus/views.js` `findIndex`), and Android, per case, the first address field that yields a location (`gis/EntityMapUtils.kt::getDisplayInfoForEntity`); the editor allows it (`screen.js::save` counts only image and geo-*) and HQ's build does not check it there (executed); holding it makes the module emitted as advanced ("Case writes") | RUNS / DIFFERENT (a blank first address falls through to the next) | the columns |
| more than one `image` or geo-* column of the same format in a detail of an advanced module | **REFUSED**: not HQ-editable: the Case List and Case Detail saves refuse a second column of the same `image` or geo-* format in any module (`screen.js::save`) | — | — |

### Column field paths (`DetailColumn.field` paths and prefixes)

| HQ item | Disposition | Web Apps / Android | Emission |
|---|---|---|---|
| `prop` | **HELD**: `column.field` | RUNS / RUNS | `prop` |
| `name`, `date-opened`, `external-id`, `status`, `owner_id` (HQ renames to `case_name`, `date_opened`, `external_id`, `@status`, `@owner_id`) | **HELD**: standard readables (`lib/domain/standardCaseProperties.ts`) | RUNS / RUNS | HQ spelling |
| `last_modified` | **HELD**: standard readable | RUNS / RUNS | `last_modified` |
| `idx/…/prop` (`parent/`, `host/`, any index names, chained) | **HELD-NEW**: `column.via` relation path on property columns (today only calculated columns read through relations) | RUNS / RUNS | `parent/prop` form |
| `user/prop` (usercase) | **HELD-NEW**: column over the usercase property | RUNS / RUNS | `user/prop`; privilege `user_case` |
| `#owner_name` | **HELD-NEW**: `ownerName` column (the owning group's name, else the current worker's username for a case they own, else blank) | RUNS / RUNS | `#owner_name` (HQ always syncs the `user-groups` fixture, `PropertyXpathGenerator.owner_name`) |
| `attachment:name` with `picture`/`audio` | → Column formats, `picture` and `audio` (refused) | — | — |
| `attachment:name` with any other format | **REFUSED**: retiring (MM_CASE_PROPERTIES): HQ keeps and syncs case attachments only under that flag (`form_processor/backends/sql/update_strategy.py::_apply_attachments_action`), so without it the column is blank | — | — |
| `ledger:section` | **REFUSED**: retiring (COMMTRACK) | — | — |
| `location:type…` | **REFUSED**: retiring (HIERARCHICAL_LOCATION_FIXTURE: `validate_detail_columns` refuses it without the hierarchical fixture) | — | — |
| `schedule:var` | **REFUSED**: retiring (VISIT_SCHEDULER) | — | — |
| `indicator:call-center/<name>` | **REFUSED**: untypeable: its rows come from the target's call-center configuration (`callcenter/fixturegenerators.py::IndicatorsFixturesProvider`), which Nova cannot read, as for `indicators:*` (Secondary instances) | — | — |
| `indicator:<any other set>/<name>` | **REFUSED**: broken at runtime: HQ declares `jr://fixture/indicators:<set>` (`detail_screen.py::IndicatorXpathGenerator`), no HQ fixture serves it, and Core fails to initialize the instance (`CommCareInstanceInitializer.loadFixtureRoot`) | — | — |

### Sorting (`SortElement`)

| HQ item | Disposition | Web Apps / Android | Emission |
|---|---|---|---|
| `field` naming a displayed column | **HELD**: `column.sort` | RUNS / RUNS | `field` |
| `field` naming a property not displayed (HQ appends a hidden column, `util.create_temp_sort_column`) | **HELD**: invisible sort-carrier column | RUNS / RUNS | `field` |
| `field` = `_cc_calculated_N` | **HELD**: sort on the calculated column | RUNS / RUNS | `_cc_calculated_N` |
| `field` = `_cc_calculated_N` naming a missing or non-calculated column | **REFUSED**: not HQ-buildable: `util.py::get_sort_and_sort_only_columns` raises `AppManagerException` | — | — |
| sort order across elements | **HELD**: `sort.priority` | RUNS / RUNS | element order |
| `direction` | **HELD**: `sort.direction` | RUNS / RUNS | `ascending`/`descending` |
| `type` ∈ {`plain`,`date`,`int`,`double`} equal to the type Nova derives, differing only between `plain` and `date`, or any `type` in {`plain`,`date`,`int`,`double`} on a column whose format has its own sort (enum family, clickable-icon, date, time-ago, distance) | **HELD**: same state: HQ writes `string` for both `plain` and `date`, and a format's own sort type wins (`FormattedDetailColumn.sort_node`) | RUNS / RUNS | the derived type |
| `type` `int` or `double` differing from the derived type, on a column without its own sort | **HELD-NEW**: `sort.comparator` (authored) | RUNS / RUNS | `type` |
| `type: distance` | **HELD-NEW**: `sort.comparator: distance` (on a column whose format has its own sort, HQ keeps that format's sort type with the distance function: `double` for `distance`, and `string` for date, time-ago and the ID-mapping formats, where distances compare as text: executed) | UNAVAILABLE (sorted from São Paulo) / RUNS | `distance` |
| `type: index` ("Cache and Index", `order="-2"`) | **REFUSED**: retiring (CACHE_AND_INDEX) | — | — |
| `type: string` (not a menu value) | **HELD**: read as `plain` (build-identical, `FormattedDetailColumn.sort_node`) | RUNS / RUNS | `plain` (Nova writes `string` for plain and date sorts today: unproducible) |
| `blanks` ∈ {`first`,`last`} | **HELD-NEW**: `sort.blanks` | RUNS / RUNS | `blanks` |
| `blanks: ''` | **HELD**: read as `first` (ascending) / `last` (descending): Core's default (`DetailFieldParser.parseBlanksPreference`) | RUNS / RUNS | the explicit value (Nova writes `''` today: unproducible) |
| `display{lang}` (Sort By label) on a sort-only element | **HELD-NEW**: `sort.label`: HQ makes it the header of the invisible sort column and an app string (`util.py::create_temp_sort_column`) | DIFFERENT (only the tile "Sort By" lists it) / RUNS | `display{lang}` |
| `display{lang}` on a sort joined to an `invisible` column | **HELD-NEW**: `sort.label` presence, which alone decides whether the column is listed under Sort By (`detail_screen.py::Invisible.header`); Nova writes `display: {}` on every sort today (`hqJson/caseList.ts`) | DIFFERENT (only the tile "Sort By" lists it) / RUNS | `display{lang}` |
| `display{lang}` on a sort joined to a displayed column | **INERT**: never read (executed: identical suite and app strings with and without it; HQ's help text says Display Text is for sort-only properties) | n/a | `{lang: ''}`, the editor's spelling of no label |
| `display: {}` | **HELD**: no sort label, the same state as `{lang: ''}` (Nova writes `display: {}` today) | n/a | `{lang: ''}` |
| `sort_calculation` equal to the referenced calculated column | **HELD**: same as the column sort | RUNS / RUNS | `_cc_calculated_N` alone (Nova writes `_cc_calculated_N` with its own expression today, `projectSortElements`, which is this state: unproducible; HQ builds it with the expression inlined where the column form uses a variable, which every runtime reads identically) |
| `sort_calculation` authored (calculation row, `field ''`) | **HELD-NEW**: `sort.expression` (lifts into ValueExpression, else the typed expression model) | RUNS / RUNS | `sort_calculation`; SORT_CALCULATION_IN_CASE_LIST (a save without it strips the value, leaving a row HQ's build refuses, `invalid sort field`) |
| `field` and a differing `sort_calculation` on a column whose format has its own sort (enum family, clickable-icon, date, time-ago, distance) | **HELD**: same state as `field` alone: `FormattedDetailColumn.sort_node` never reads `sort_calculation` there | RUNS / RUNS | `field` alone (Nova writes the pair for its label columns today: unproducible) |
| `field` and a differing `sort_calculation` on any other column | **REFUSED**: not HQ-editable (the editor writes `field ''` for calculation rows) | — | — (Nova writes the pair for sorted link columns today: unproducible; in-envelope: a sort element on the raw property, `field: <property>`, which HQ carries as a hidden sort column) |
| no `sort_elements` | **HELD**: HQ's implicit order, the first case-list column, ascending, as a string unless its format has its own sort (`suite_xml/sections/details.py::get_default_sort_elements`) | RUNS / RUNS | `[]`; Nova's `.ccz` and Preview must apply the same order (defect 10) |
| sort on a `translatable-enum` column (Nova's label projection of a select property, or an authored translated-text column) | **HELD**: HQ sorts by the translated label (the format's own sort function wins, `FormattedDetailColumn.sort_node`) | RUNS / RUNS | Nova's `.ccz` and Preview must sort by label too (defect 10) |

### Detail tabs (`DetailTab`)

| HQ item | Disposition | Web Apps / Android | Emission |
|---|---|---|---|
| plain tab (`header`, `starting_index`) | **HELD-NEW**: `caseListConfig.detailTabs[] {header, startColumn}` | RUNS / RUNS | `tabs[]`, each with `isTab: true` (the Case Detail page loads a tab without it as a property column and then cannot save) |
| a stored tab without `isTab` | **HELD**: same state: `isTab` is page state that no build or server code reads | RUNS / RUNS | `isTab: true` |
| tab `relevant` (lifts into Predicate / not) | **HELD-NEW**: `detailTabs[].displayCondition` (Predicate, or the typed expression model) | RUNS / RUNS | `relevant` |
| data tab over child cases (`has_nodeset`, `nodeset_case_type`, `nodeset_filter`) | **HELD-NEW**: `detailTabs[].rows: childCases {caseType, filter}` | RUNS / RUNS | tab keys; DETAIL_LIST_TAB_NODESETS |
| data tab over a custom `nodeset` XPath | **HELD-NEW**: `detailTabs[].rows: expression` (typed expression model) | RUNS / RUNS | `nodeset`; DETAIL_LIST_TAB_NODESETS |
| columns above the first tab when tabs exist | **REFUSED**: not HQ-editable: "All properties must be below a tab" (`screen.js::save`) | — | — |
| a custom long tile row mixing fields of two tabs, in a basic or shadow module | **REFUSED**: not HQ-buildable: `invalid tile configuration` | — | — |
| a custom long tile row mixing fields of two tabs, in an advanced module | **HELD-NEW**: a detail tile whose row holds cells of two tabs: HQ builds each tab with its cells at their stored positions (`suite_xml/sections/details.py`, `case_tiles.py::build_case_tile_detail`), and does not check the row there; holding it makes the module emitted as advanced ("Case writes") | RUNS / RUNS | the positions |

### Case list callout (`Detail.lookup_*`, CaseListLookupMixin)

| HQ item | Disposition | Web Apps / Android | Emission |
|---|---|---|---|
| `lookup_enabled` + `lookup_action` | **HELD-NEW**: `caseListConfig.callout {action}` | IGNORED (no button) / RUNS | `lookup_enabled`, `lookup_action`; CASE_LIST_LOOKUP (or BIOMETRIC_INTEGRATION); HQ builds no callout on a case list using the `icon_text_grid` template (the template has no lookup slot, `case_tiles.py::build_case_tile_detail`; executed), so a callout needs a plain or `custom` list |
| `lookup_name` | **HELD-NEW**: `callout.name` | IGNORED / RUNS | `lookup_name` |
| `lookup_image` (`jr://`) | **HELD-NEW**: `callout.icon` (media asset) | IGNORED / RUNS | `lookup_image` |
| `lookup_autolaunch` | **HELD-NEW**: `callout.autoLaunch` | IGNORED / RUNS | `lookup_autolaunch` |
| `lookup_extras[] {key, value}` | **HELD-NEW**: `callout.extras` | IGNORED / RUNS | `lookup_extras` |
| `lookup_responses[] {key}` | **HELD-NEW**: `callout.responses` | IGNORED / RUNS | `lookup_responses` |
| callout with no extras or no responses | **REFUSED**: not HQ-editable: the callout editor requires at least one of each (`case_list_callout.js::validate`) | — | — |
| `lookup_display_results` + `lookup_field_header` + `lookup_field_template` | **HELD-NEW**: `callout.resultsColumn {header, expression}` | IGNORED / RUNS | the three keys |
| `lookup_enabled: false` with stale keys | **INERT**: nothing a runtime reads (HQ still emits an unread `callout_header` app string when a stale `lookup_display_results` is true) | n/a | omit |
| `lookup_enabled` on an `icon_text_grid` case list | **INERT**: HQ builds no `<lookup>` there (`case_tiles.py::build_case_tile_detail`; executed), so no runtime shows a callout | n/a | omit |
| `lookup_*` on the long detail (tabbed or not) | **REFUSED**: not HQ-editable: the editor writes callouts only on the case list (`views/modules.py::_save_case_list_lookup_params(detail.short, …)`); HQ would build it into the long detail, or, when tabbed, into each tab's sub-detail only (`suite_xml/sections/details.py::DetailContributor.build_detail`) | — | — |

## Case selection extras

| HQ item | Disposition | Web Apps / Android | Emission |
|---|---|---|---|
| `parent_select {active: true, relationship: parent, module_id}` (a non-multi-select module of another case type) | **HELD**: `Module.parentCaseModuleUuid`; widen: a module of any other case type HQ offers, not only the declared parent type (`views/modules.py::get_modules_with_parent_case_type` offers every non-multi-select module whose case type differs, and `validate_parent_select` accepts it; executed), and a child type whose relationship to it is an extension, where the child list shows the cases whose non-extension index names the selected case (Nova's `lib/domain/caseParentSelection.ts::caseParentSelectionVerdict` accepts only the declared parent type today) | RUNS / RUNS | that shape |
| `parent_select.relationship: null` ("Other") | **REFUSED**: retiring (NON_PARENT_MENU_SELECTION) | — | — |
| `parent_select.active: false` | **INERT**: nothing emitted | n/a | HQ's default `{active: false, relationship: parent, module_id: null}`, as Nova writes today |
| `parent_select.module_id` naming a multi-select module or an invalid candidate, or forming a cycle | **REFUSED**: not HQ-editable/buildable: `get_modules_with_parent_case_type` excludes multi-select; `invalid parent select id`, `parent cycle`, `circular case hierarchy` | — | — |
| inline search in a parent-select module (HQ adds `_xpath_query` `ancestor-exists(parent, @case_type='…')`) | **HELD**: derived by HQ from `searchFirst` + parent selection | RUNS / UNAVAILABLE | nothing extra (HQ generates it); CASE_SEARCH_RELATED_LOOKUPS precondition |
| `case_list_form` pointing at a registration form in another module for this case type | **HELD-NEW**: `Module.caseListRegistrationForm` (today only the search-no-matches entry exists) | RUNS / RUNS | `case_list_form.form_id`; add-on `register_from_case_list` |
| `case_list_form` on a search-first host pointing at a registration form in a `module_filter: false()` module | **HELD**: `Module.caseListRegistrationForm` (the reader reads a `false()` module holding only that form, with no other link or entry point to it, as part of the host's registration form, and the ledger records that menu's id against the form) (Nova's `Form.entry {kind: search-no-matches}` today, which migrates into it) | RUNS / UNAVAILABLE (Android shows a toast for an empty search response and never the case list, `QueryRequestActivity`) | as today; FOLLOWUP_FORMS_AS_CASE_LIST_FORM gates only a `relevancy_expression` here |
| `case_list_form` pointing at a follow-up form of the parent case type | **HELD-NEW**: `caseListRegistrationForm` follow-up arm (offered only where the module selects its parent through `parent_select`, `views/modules.py::get_parent_select_followup_forms`) | RUNS / RUNS | same; FOLLOWUP_FORMS_AS_CASE_LIST_FORM (build validator reads the toggle) |
| `case_list_form.label{lang}` | **HELD-NEW**: `caseListRegistrationForm.label` | RUNS / RUNS | `label` |
| `case_list_form.post_form_workflow` (`default` / `case_list`) | **HELD-NEW**: `caseListRegistrationForm.afterSubmit` | RUNS / RUNS | the value |
| `case_list_form.relevancy_expression` with FOLLOWUP_FORMS_AS_CASE_LIST_FORM | **HELD-NEW**: `caseListRegistrationForm.displayCondition` (Predicate, else the typed expression model) | RUNS / RUNS | `relevancy_expression` |
| `case_list_form.relevancy_expression` without that toggle | **INERT**: never emitted (`get_case_list_form_action`) | n/a | omit |
| `case_list_form.media_image` / `media_audio` | **HELD-NEW**: `caseListRegistrationForm.icon`, `audioLabel` | IGNORED (label text only) / RUNS | media dicts |
| `case_list_form` on a `put_in_root` module whose case list is not a tile | **INERT**: HQ builds no registration action there (`details.py::DetailContributor.build_detail` gates it on `not module.put_in_root`), and the only output, a `<create>` frame guarded by `return_to = 'root'`, never fires, since only that action sets `return_to` (executed) | n/a | omit |
| `case_list_form` on a `put_in_root` module whose case list is a tile | **REFUSED**: not HQ-editable: the editor withdraws registration from the case list there (`views/modules.py::_case_list_form_not_allowed_reasons`, "Registration from the case list is not available because…"), though a form set before the menu mode changes stays stored, and HQ builds its action in the tile (`features/case_tiles.py::CaseTileHelper.build_case_tile_detail`; executed) | — | — |
| `case_list_form` on a module whose forms do not all require a case | **REFUSED**: not HQ-editable: `_case_list_form_not_allowed_reasons`, as for `put_in_root` | — | — |
| `case_list_form` missing, not a registration form (toggle off), or breaking the advanced case-list-module rules | **REFUSED**: not HQ-buildable: `case list form missing`, `case list form not registration`, `invalid case list followup form`, the six advanced rules | — | — |
| HQ-computed datums (`case_id_new_<type>_<n>`, `usercase_id`, `<datum>_parent_ids`, `return_to`) | **HELD**: derived by HQ from forms and modules | RUNS / RUNS | nothing (HQ generates) |
