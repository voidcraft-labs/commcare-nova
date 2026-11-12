# Step 6, part 02: Menus: display-only forms and registration from the case list

This part plans two authored concepts in full, each a complete Nova feature that is useful with no
reader: a menu that **shows its forms in the menu above** (what CommCare HQ stores as `put_in_root`
and calls display-only forms), in pull request A4, and **registration from the case list, always
offered** (the second arm of `Module.caseListRegistrationForm`), in pull request A5. Each is planned
across the domain, the validator, both emitters, Preview, the builder, the Solutions Architect and
MCP, the public docs, the platform table, the surface manifest and the proof lane. It adds two optional
document slots and no table, no migration, no route and no MCP tool. Pull requests are named by the ids
of the top-level file (`../6-bring-in.md`, "Work items": A1 to A11, B1 to B15); another part is cited
by its number, its file and its section, with the pull request beside it.

Citations are `path::symbol`: Nova at `main` `15a00a97`, and the Dimagi checkouts at the pins
`proof/pins.json` names: commcare-hq `d6c6e16d8ae1`, commcare-core `8e9ba8d908e9`, commcare-android
`7a5584475580`, formplayer `24383ac71bfb`, commcare-connect `046c7fd78081`, Vellum `01215f251c57`.
Every CommCare fact below was read at those commits for this part; HQ paths are under
`corehq/apps/app_manager/` unless they start elsewhere. A fact marked "(read, not run)" has a run in
"Written and not yet run" that settles it.

Versions at `15a00a97`: `lib/models.ts::MODEL_CONTEXT_VERSION` is `"v6-hq-round-trip-case-writes.14"`
and `lib/db/appTests.ts::RUNTIME_VERSION` is `18`. A4 moves the first to
`"v7-hq-round-trip-bring-in.a4"` and A5 to `"v7-hq-round-trip-bring-in.a5"` (section 12); neither moves
the second (section 8.6).

| Section | Owns | Pull request |
|---|---|---|
| 2 | what HQ generates from `put_in_root`, every reader | A4 (evidence) |
| 3 | the concept, its name and its stored slot | A4 |
| 4 | `lib/domain/menuScreens.ts`: which screen lists what | A4 |
| 5 | validator rules of forms in the menu above | A4 |
| 6 | emission: HQ JSON, the local suite, stack frames | A4 |
| 7 | the doc layer: planners, reducers, the scoped gate | A4 |
| 8 | Preview and App Tests | A4 |
| 9 | the builder | A4 |
| 10 | what HQ does with `case_list_form`, every reader | A5 (evidence) |
| 11 | the `always` arm: schema, readers, rules, emission, Preview, builder | A5 |
| 12 | the Solutions Architect and MCP | A4, A5 (the billed check: A10) |
| 13 | platform rows | A5 |
| 14 | the surface manifest | A4, A5 (reading rows landed by B4 and B5: part 07, section 14) |
| 15 | proof | A4, A5 |
| 16 | the model-addition checklist, line by line | A4, A5 |

---

## Decisions in brief

1. **The concept is "a menu shows its forms in the menu above"**, stored as
   `Module.formsInMenuAbove: true` (section 3). The menu above is the app's first menu for a top-level
   menu and the parent for a submenu. Neither "display only" nor "root" is Nova's word.
2. **One derived projection says which screen lists what**, `lib/domain/menuScreens.ts` (section 4):
   every menu, form and case list entry lists on exactly one screen, in module preorder, as Core merges
   the `<menu>` elements HQ builds. Every reader of "the forms a worker sees here" goes through it.
3. **Whether a screen asks for a case before a form is a fact of the screen, not of one module**
   (section 4.3): `screenChoosesCaseFirst` replaces `moduleIsCaseFirst` at every reader that means "a
   case is chosen before this form is listed", because Core asks one question of every entry a screen
   lists (`CommCareSession.getDataNeededByAllEntries`).
4. **A menu that shows its forms above has no screen of its own, so nothing may open it** (section 5):
   no after-submit link, no `module` destination for its forms, no `parentMenu` for its submenus'
   forms, no entry point, no case list entry point. Its forms stay destinations of links and entry
   points, but for the one shape of decision 19.
5. **Such a menu takes no search and no registration from its case list** (section 5), because HQ's
   build writes neither action on its case list (`suite_xml/sections/details.py::DetailContributor`,
   `not module.put_in_root`), and HQ's build refuses inline search there.
6. **Its name, icon and spoken label stay stored and are shown nowhere while the slot is set**
   (section 3.3), as a display condition stays beside `hiddenFromMenu`. HQ's starter apps hold icons on
   such menus.
7. **Both emitters write what HQ's build writes**: `put_in_root: true` with the `menu_mode` add-on in
   the HQ JSON, and in the local suite the menu id, the `root` attribute, the parent's name, the
   conjoined condition and every stack frame, each from one function that restates
   `id_strings.py::menu_id` and `workflow.py::WorkflowHelper.get_frame_children` (section 6).
8. **Preview lists and lands by the same projection** (section 8): the first menu and a parent menu
   list the forms of menus that show above, in place; a frame that names such a menu lands on the
   screen it lists on.
9. **The `always` arm is `{ kind: "always", formUuid, label?, icon?, audioLabel?, afterSubmit }` with
   `afterSubmit: "case-list" | "new-case"`** (section 11.1). HQ's two values are "Go back to case list"
   and "Proceed with registered case"; neither is Home.
10. **The form an `always` arm names stays on its own menu and is an ordinary form everywhere else**
    (section 11.2): linkable, with its own entry point, display condition and after-submit. Several
    case lists may offer one form.
11. **HQ's return frames fire only when the form was opened from the Register action** (section 10.3):
    they are guarded by the `return_to` value that action pushes. Opened from its own menu the form
    goes where its own after-submit says.
12. **The arm's `afterSubmit` applies while the form's own after-submit is Home; a form with its own
    destination or links follows that from the list too** (section 11.4), which is HQ's rule
    (`workflow.py::WorkflowHelper._get_stack_frames`). The value stays stored and every editor says so.
13. **In step 6 the `always` arm needs a host whose every form opens an existing case, a registration
    form of the host's case type whose case Case Management registers and that registers no second
    case of that type at its root, and both menus basic** (section 11.3). An advanced host or form, a
    form whose one registration of the type is a child case, the follow-up arm and the Register
    action's display condition stay step 7's, each with its reason (section 11.9).
14. **Removing a form a case list offers is refused, naming each list** (section 11.6), as removing a
    link's target is. No planner cascades: the removal waits until each list stops offering the form.
    The reducers still drop a slot whose form a committed removal takes, so a replayed removal leaves
    no dangling identity.
15. **One platform row is added, for the Register action's icon and spoken label**, which Web Apps does
    not draw (section 13). Forms in the menu above run alike on both platforms.
16. **`updateModule` carries both concepts** (`forms_in_menu_above`, `register_from_case_list`), and
    `setMenuMedia` gains the target `case-list-registration` (section 12). The case list menu item's
    media target stays step 7's.
17. **No document migrates and no reducer mints anything**: both slots are optional, and the
    discriminated union admits every stored `after-empty-search` arm as it is.
18. **`previous` is not offered to a form that lists on the app's first menu** (sections 5.1, 5.6,
    6.3). Wherever every such form opens with one chosen case, HQ's frame for it holds that case and no
    command, which no screen stands for and which the two platforms read differently. Its case-loading
    forms default to the first menu. `previous` stays offered in a submenu that shows its forms in a
    parent that keeps its screen. The wider shape stays step 7's `menus`.
19. **No frame Nova writes holds a chosen case ahead of its first command** (sections 5.5, 6.3).
    Where every form of every menu that shows its forms above opens one chosen case, HQ builds each
    frame through the first menu with that case first, and CommCare keeps it on the first menu when a
    worker steps back. A link, an entry point or a Register return whose frame would open that way is
    refused, naming the menu to give its own screen again (run G6 may lift it).
20. **A form a case list offers registers exactly one case of the list's type**, for both arms
    (section 11.3), which is HQ's own count (`Form.get_registration_actions`).

---

## Executed during planning

Read, in source at the pins:

- **`put_in_root`, every reader in commcare-hq**: `models/modules.py::ModuleBase.put_in_root`,
  `root_requires_same_case`, `ReportModule.put_in_root` (a fixed `False`; `ShadowModule` holds the
  live property); `id_strings.py::menu_id`;
  `suite_xml/sections/menus.py::MenuContributor.get_module_contributions`, `_generate_menu`,
  `_generate_v1_shadow_menus`, `_get_commands`; `suite_xml/utils.py::_should_use_root_display`,
  `get_module_locale_id`; `suite_xml/sections/details.py::DetailContributor.build_detail` (the two
  `not module.put_in_root` guards); `suite_xml/post_process/workflow.py::WorkflowHelper`
  (`_root_module_datums`, `_get_id_suffix`, `get_frame_children`, `_get_stack_frames`),
  `EndOfFormNavigationWorkflow` (`_get_static_stack_frame`, `_frame_children_for_module`,
  `_get_link_frame`, `_get_fallback_frame`), `prepend_parent_frame_children`;
  `suite_xml/post_process/endpoints.py::EndpointsHelper` (`update_suite`, `_make_session_endpoint`,
  `get_frame_children`); `suite_xml/post_process/instances.py::InstancesHelper` (`update_suite`,
  `_add_menu_instances`, `_get_all_xpaths_for_entry`, `_menu_xpaths_by_command`) with
  `feature_support.py::supports_menu_instances`; `os.path.commonprefix` as `get_frame_children` calls
  it, with `workflow.py::WorkflowSessionMeta.__eq__` and `__lt__` (by id alone) and
  `_get_entries_datums` (no `*-case-list` entry); `_find_best_match`,
  `_get_datums_matched_to_manual_values`;
  `suite_xml/sections/entries.py::EntriesHelper.include_post_in_entry`;
  `suite_xml/post_process/remote_requests.py` (the update loop); `suite_xml/post_process/menu.py`;
  `helpers/validators.py::ModuleBaseValidator.validate_display_only_forms`,
  `FormBaseValidator` (the `WORKFLOW_MODULE` and `WORKFLOW_PARENT_MODULE` arms);
  `views/modules.py::_case_list_form_not_allowed_reasons` and the `put_in_root` save;
  `views/forms.py::get_form_view_context` (`form_workflows`), `_get_linkable_forms_context`;
  `add_ons.py` (`menu_mode`, `register_from_case_list`);
  `templates/app_manager/partials/modules/bootstrap5/module_view_settings.html`;
  `static/app_manager/js/forms/form_view.js::formFilterModel`; `docs/apps/advanced_app_features.rst`
  ("Menu structure"). Four more readers change nothing a Nova export holds: the training branch of
  `menus.py::_generate_menu` (`module.is_training_module and module.put_in_root and training_menu`;
  Nova refuses training modules); `views/utils.py::MODULE_BASE_PROPERTIES_TO_COPY` (the attribute
  copied between modules); `views/forms.py` (an editor path that sets `put_in_root` on a form, which
  no build code reads from a form); `es/mappings/app_mapping.py` (indexing). HQ's own tests:
  `tests/test_child_module.py` (`test_workflow_with_put_in_root`, `test_menu_display_conditions`),
  `tests/test_form_workflow.py::test_form_workflow_module_in_root` with its fixture
  `tests/data/form_workflow/suite-workflow-module-in-root.xml`,
  `tests/test_suite_instances.py::test_module_filter_instances_on_all_forms_merged_modules`.
- **`case_list_form`, every reader**: `models/modules.py::CaseListForm`; `const.py`
  (`WORKFLOW_CASE_LIST`, `REGISTRATION_FORM_WORFLOWS`, `RETURN_TO`);
  `models/forms.py::FormBase.case_list_modules`, `is_case_list_form`,
  `Form.get_registration_actions`, `Form.is_registration_form`, `AdvancedForm.is_registration_form`;
  `suite_xml/sections/details.py::DetailContributor.add_register_action`,
  `get_case_list_form_action`, `get_datums_for_action`;
  `suite_xml/features/case_tiles.py` (the register action in a tile);
  `suite_xml/post_process/workflow.py::CaseListFormWorkflow` (all of it), `CaseListFormStackFrames`;
  `app_strings.py::_create_case_list_form_app_strings`; `id_strings.py` (`case_list_form_locale`,
  `case_list_form_icon_locale`, `case_list_form_audio_locale`);
  `helpers/validators.py::ModuleBaseValidator.validate_case_list_form`,
  `AdvancedModuleValidator.validate_with_raise` (the six rules);
  `views/modules.py` (`_case_list_form_options`, the save of the five `case_list_form_*` fields);
  `templates/app_manager/partials/modules/bootstrap5/case_list_form_setting.html`;
  `static/app_manager/js/modules/bootstrap5/module_view.js::caseListFormModel`;
  `static/app_manager/js/forms/bootstrap5/form_workflow.js` (`hasWarning`);
  `suite_xml/sections/entries.py::EntriesHelper.add_parent_datums`;
  `hqmedia/models.py::ModuleMediaMixin` (the block's media, read only behind `form_id`).
- **Runtimes**: commcare-core `session/CommCareSession.java` (`getEntriesForCommand`,
  `getStillValidEntriesFromMenu`, `getNeededData`, `getDataNeededByAllEntries`,
  `getFirstMissingDatum`, `getNeededDatum`, `setCommand`, `syncState`), `suite/model/MenuLoader.java`
  (`getMenuDisplayables`, `addUnaddedMenu`, `menuIsRelevant`, `accumulateInstances`),
  `suite/model/Menu.java` (`ROOT_MENU_ID`); formplayer
  `services/MenuSessionFactory.java::rebuildSessionFromFrame`,
  `beans/menus/CommandListResponseBean.java`, `beans/menus/DisplayElement.java` (the `Action`
  constructor); HQ's Web Apps client `cloudcare/templates/cloudcare/partials/case_list/list.html` (the
  action button); commcare-android `activities/MenuActivity.java`,
  `views/EntityActionViewUtils.java`.
- **HQ's starter apps**, field by field: `static/app_manager/template_apps/{agriculture,health,wash,
  wash_before_cond_case_update}/app.json`.
- **Nova**, every file sections 1 and 16 cite.

What that reading found, each fact with its source, and each claim of the manifest it corrects:

- **Read at source**: the return frames fire only for a form the Register action opened. HQ puts
  the return frames in the form's one entry, and guards each with
  `count(session/data/return_to) = 1 and session/data/return_to = 'm<N>'`
  (`CaseListFormWorkflow.get_if_clause`). Only the Register action pushes `return_to`
  (`details.py::get_case_list_form_action`). Opened from its own menu the form has no such value and
  goes home, never to the host's case list. Decision 11 follows from it.
- **Read at source**: HQ's two return values are back to the list and on with the new case. Its
  `default` is labelled "Proceed with registered case" (`module_view.js::caseListFormModel`) and
  builds a frame that lands in the list's menu with the new case chosen, and a second that returns
  to the list when no case was created (`CaseListFormWorkflow._get_stack_frames`). No value means
  Home. Not done: `afterSubmit: "home" | "case-list"`, because of those two frames. Decision 9
  follows from it.
- **The eleven generated effects of `put_in_root`**, each read in source and each a rule below. Six
  show in HQ's menu, detail and frame builders, and section 2's table gives each its source: (1) the
  menu's id (row 1); (2) the parent's filter conjoined (row 4); (3) a submenu taking its parent's
  name (row 3); (4) the menu's case list losing its Register and Search actions (row 5); (5) refused
  endpoints, inline search and links (rows 6 and 7); (6) changed end-of-form frames (rows 8, 9 and
  14). Five more reach a document, a suite or a screen. (7) A submenu that does not show its forms
  above, under a top-level menu that does, lists on the first menu (`_generate_menu` writes
  `root="root"`). (8) A frame toward anything listed on the first menu starts with the datums common
  to every form of every menu in the app that shows its forms above, with no menu command
  (`WorkflowHelper._root_module_datums`). (9) A form's display condition may not read the case there
  unless the menu is a submenu of a same-type parent whose forms all need a case
  (`menus.py::_get_commands`, `ModuleBase.root_requires_same_case`). (10) A case list entry point is
  built with no command for its menu (`endpoints.py::_make_session_endpoint` over
  `get_frame_children(module, None)`). (11) At run time Core merges every `<menu>` of one id, so the
  host screen's case-first question changes (section 4.3). Effect 3 is narrower than
  "takes its parent's name": the submenu's `<menu>` takes the parent's locale id and keeps its own
  icon and audio locales. Where a menu condition's instances are declared is no effect at Nova's
  version floor: from CommCare 2.54 HQ declares each `<menu>`'s instances on that `<menu>`
  (`instances.py::InstancesHelper._add_menu_instances` under
  `feature_support.py::supports_menu_instances`), and folds them into entries
  (`_menu_xpaths_by_command`) only below it. Nova publishes at 2.57 and above.
- **Read at source**: the parent's filter is conjoined (effect 2) only for a submenu that shows its
  forms above, and only its direct parent's (`_generate_menu`, `id_module.put_in_root and
  id_module.root_module and id_module.root_module.module_filter`). A submenu that keeps its own screen
  under such a parent carries its own condition alone.
- **Read at source**: the three starter apps hold twelve menus, eight of them with
  `put_in_root: true` (agriculture 2 of 4, health 2 of 3, wash 4 of 5);
  `wash_before_cond_case_update` is a second copy of wash.
- **Claim corrected** (the manifest entry
  `menus-and-case-lists/put-in-root-display-only-forms`, cell "`Module.showFormsInParent`"): a
  top-level menu has no parent, and all eight starter menus are top-level. The slot is
  `Module.formsInMenuAbove`. Not done: a name that says "parent", such as
  `Module.formsInParentMenu`, for that reason.
- **Found at source**: wash's two display-only menus hold a `case_list_form` with a label, the
  workflow `case_list` and no `form_id`. No reader reads a `case_list_form` with a blank `form_id`
  (`details.py`, `app_strings.py::_create_case_list_form_app_strings` and
  `FormBase.case_list_modules` all test `form_id`), so it is inert, and the manifest needs that row
  (section 14).
- **Found at source**: agriculture's two display-only menus hold `media_image`. Decision 6 follows
  from it.
- **Found at source**: Web Apps draws a case list action as its text alone
  (`cloudcare/partials/case_list/list.html`, `action.text`), though formplayer sends the image and
  audio (`DisplayElement(Action, …)`). The manifest's "IGNORED (label text only)" is right.
- **Found at source**: HQ's fixture for `previous` on a menu above
  (`suite-workflow-module-in-root.xml`) shows one shape only, the one whose root prefix is empty
  because its menu mixes a registration form with follow-up forms. Where every form of every menu
  above opens with one datum id, `get_frame_children` puts that datum ahead of the form command, and
  `EndOfFormNavigationWorkflow._get_static_stack_frame` pops the command and stops, so the frame is
  the datum alone. Core then asks for a command with the datum already collected
  (`CommCareSession.getNeededData`, `syncState`), and its next entry that needs that datum id takes
  the value without asking (`getFirstMissingDatum` compares ids, never case types). Formplayer
  rebuilds from an empty session and matches no step to a menu option
  (`MenuSessionFactory.rebuildSessionFromFrame`), so Web Apps keeps nothing. (Read, not run: run G6
  settles it in Core.) Decisions 18 and 19 follow from it.
- **Found at source**: where a `case_list_form` block's label holds no text, HQ's app string is
  "Create a new Case" (`app_strings.py::_create_case_list_form_app_strings`, `fallback_name`), never
  the form's name. Nova always writes a label, so its own exports never meet the fallback; the reader
  does (section 14).
- **Found at source**: `Form.is_registration_form(case_type)` counts: `open_case` where the
  form's own menu has the type, plus every root subcase of the type, and requires exactly one
  (`Form.get_registration_actions`). A registration form that also creates a same-type child at its
  root is no registration form to HQ's build. The existing `after-empty-search` rule on `main` checks
  the form's type and its own arm alone; A5 closes it for both arms (decision 20).

---

## Written and not yet run

Each run names where it runs, every outcome and what lands. None runs on the planning machine.

**G1. HQ's build against the local suite over the new documents (A4, A5).** The proof lane, on hosted
runners, in each pull request's own CI run: proof 3 and the manifest check over
`targeted-forms-in-menu-above`, `targeted-forms-in-menu-above-nested`,
`targeted-forms-in-menu-above-one-case`, `targeted-forms-in-menu-above-registration-only` and
`targeted-register-from-case-list` (section 15).
- *A: no difference.* Nothing more lands.
- *B: any difference.* The emitter is wrong: `lib/commcare/compiler.ts` or
  `formLinkProjection.ts` is corrected to HQ's bytes in the same pull request, with a unit test that
  holds the corrected shape. No register entry and no walk stop. A menu condition's instances are no
  candidate: HQ declares them on each `<menu>` at Nova's version floor (section 2, row 11), where Nova
  writes them.

**G2. The served readers' walks reach every entry and land where Preview does (A4, A5).** The lane's
nightly reader set (Core, formplayer, the Web Apps client, commcare-android), started by hand before
the stack merges over the four A4 documents and, from A5's head, `targeted-register-from-case-list`
(`gh workflow run proof-audit.yml --ref <branch> -f nightly=false -f mechanics=<the five ids>`).
- *A: every walk reaches every form and case list entry listed on a first menu or a merged parent
  menu, and every after-submit and return frame lands where sections 8.5 and 11.5 say.* Nothing more
  lands.
- *B: a walker ends short at a command listed on the first menu, or at a second `<menu>` of one id.*
  The walker is taught (`proof/core/`, `proof/formplayer/`, `proof/webapps/` or `proof/android/`, the
  one that stopped) in the pull request whose document stopped it. No walk stop is registered.
- *C: a runtime lands somewhere section 8.5 or 11.5 does not say.* The candidates: Web Apps after a
  link frame that starts at a form command; either platform after a link frame that opens with a
  computed datum ahead of the form command (`targeted-forms-in-menu-above-registration-only`);
  Android after `previous` in a submenu that shows above, whose frame names the parent menu twice;
  either platform after a Register return whose host's screen lists forms first. The landing is
  corrected in `screenOfFrame`, or for A5 in `alwaysOfferedRegistrationReturn`, to what the runtime
  does, in the pull request whose document showed it. Where the two platforms then land differently,
  that pull request also sets the reading `different` on the platform that departs, in the manifest
  entry the document exercises (`menus-and-case-lists/put-in-root-display-only-forms` for A4's
  documents, `menus-and-case-lists/case-list-form-post-form-workflow-default-case-list` for A5's),
  adds the field of `lib/preview/platform.ts::PreviewPlatformRules` that holds the choice, and adds
  the cell `platformCells.test.ts` then requires (`lib/preview/__tests__/platformCells.ts`, kind
  `model`, its check in `platformCellModels.ts`). No row joins `platforms.ts::PLATFORM_FEATURES`
  under any outcome, since nothing is unavailable on either platform (section 3.3).

**G3. The return frames in Core, by host shape (A5).** `proof/native/core/RegisterFromListRuntimeTest`
(section 15), in the lane, over ten scenarios: a host that is case first, a bare case list, a host
that chooses a parent first, a host with a tile, a submenu host, a host with an ordinary search (the
action on both short details), a host whose forms read the search, a host that selects several cases,
two hosts offering one form, and a host whose screen lists a registration form of a submenu that
shows its forms above (the screen lists forms first); each with `case-list` and `new-case` where the
rules admit both. The bare case list is expected on its list under either value, since HQ's frame for
a host with no forms carries no selection (section 11.5).
- *A: each lands where section 11.5 says.* Nothing more lands.
- *B: `new-case` on a host that selects several cases lands with the new case as the selection.* The
  rule `CASE_LIST_REGISTRATION_MULTIPLE_RETURN` stops applying to the `always` arm, and neither the
  manifest row
  `menus-and-case-lists/case-list-form-post-form-workflow-default-on-a-multi-select-host` nor its
  lane reader `default_on_multi_select_host` is added. Otherwise the rule stands as planned.
- *C: `new-case` on a host whose forms read the search does not land in the menu with the new case
  chosen.* The validator gains `CASE_LIST_REGISTRATION_NEW_CASE_RETURN_UNAVAILABLE` (soundness, at the
  host: `"<host>" has its forms read the search, and CommCare can't go on with a newly registered case
  there. You can set After registering to Back to this list (after_submit "case-list").`), the builder
  disables the choice with that sentence, and the manifest gains the HELD-NEW row
  `menus-and-case-lists/case-list-form-post-form-workflow-default-on-an-inline-search-host` (owner
  `menus`), all in A5. A5's description records the outcome, and A11 reads it there: the public
  section "Register from the list" of `content/docs/case-workspace.mdx` ("Contracts") gains one
  sentence, directly after the one that ends "which goes on to this menu's forms for it.": "On a
  menu whose forms read the search, only **Back to this list** is offered." It is true of this
  outcome as written: on such a host the gate refuses `new-case` and the builder draws **Continue
  with the new case** disabled with the gate's sentence, so the one choice a person can make is
  **Back to this list**.

**G4. The domain's case-first answer against the wire's (A4).** `screenCaseFirstParity.test.ts`
(section "Tests"), in ordinary CI: over the fuzz corpus and the targeted documents, "the screen has
no blocker, or its blocker is `bare-case-list`" (`menuScreens.ts::screenCaseFirstBlocker`) equals
"every entry the screen lists, forms and case list entries alike, has a first datum that is a
selection, and all share one id" read from `formLinkProjection.ts::entrySessionDatums`, which is
Core's rule over the bytes Nova writes (`CommCareSession.getDataNeededByAllEntries` over
`getEntriesForCommand`). A bare case list is the one screen the wire calls case first and Nova names
by its own reader (`screenIsBareCaseList`), as today.
- *A: equal everywhere.* Nothing more lands.
- *B: a document where they differ.* The wire's answer is the authority: `screenChoosesCaseFirst` is
  corrected to it, and the differing document joins the test as a fixed case. A4 does not merge with
  the two unequal.

**G5. The billed schema check.** Stack A asks one billed check, run H1 at A10's head (part 15,
`15-stack-contracts-and-exit.md`, section 3 rule 7 and section 13.4); this part asks nothing and runs
nothing. H1's list is whatever the schema-hash run shows moved: the implementer runs
`npx tsx --conditions=react-server scripts/inspect-tool-schema-hashes.ts` at the `main` stack A was
cut from and at A10's head (free, no network), and the list is every Solutions Architect tool whose
hash differs. Four of this part's tools are expected among them: `updateModule` (A4 and A5),
`setMenuMedia` (A5), and `createForm` and `updateForm` (A5: section 12 adds a closing sentence to
`CASE_LIST_REGISTRATION_DESCRIPTION`, which `lib/agent/tools/createForm.ts` and `updateForm.ts` both
put in an input's description). On the person's yes the implementer runs
`npm run test:schema -- <name>` once for each name on the list, one live OpenAI request each. A
further name the run gives joins the list and the question, and an expected name whose hash did not
move leaves both.

**G6. The first menu's shared case in Core (A4).** `proof/native/core/MenuScreensRuntimeTest`
(section 15), in the lane, over one document the gate refuses and the test builds past it, as the
nested-menu proofs build their counterexamples: two top-level menus that show their forms above, each
holding one follow-up form, the first of case type A and the second of case type B; an ordinary menu
of type A whose follow-up form links to the first of them; and an ordinary menu of type B. On HQ's
build and on the local suite the test runs the link's frame, steps back from the form
(`CommCareSession.stepBack`, which commcare-android calls when a form opened from a menu is
cancelled, `HomeScreenBaseActivity.java`), chooses the ordinary menu of type B and reads
`getNeededData`.
- *A: Core asks for a form and never for that menu's case, and the form it opens holds the type A
  case the frame left* (read: `syncState` collects every datum of the frame, and
  `getFirstMissingDatum` compares datum ids). Decision 19 stands as planned, and the document stays
  the rules' negative control.
- *B: Core asks for that menu's case.* The kept case is read by nothing. A4 lands without
  `FORM_LINK_TARGET_SHARES_FIRST_MENU_CASE`, its rule `firstMenuSharedCaseFrames`, the
  `first-menu-shared-case` reason of `ENTRY_POINT_INVALID` and the `first-menu-shared-case` arms of
  the offering sites (`formLinkReview.ts`, `formLinkTargetChoices.ts`, `entryPointReview.ts`) with
  their sentence in "Copy", and A5 without the reason `parent-shares-first-menu-case`. The readers
  `firstMenuSharedCase` and `frameLeadsWithSelection` stay. Their manifest rows are not added: A5
  leaves out
  `menus-and-case-lists/case-list-form-on-a-host-under-a-menu-that-shares-the-first-menu-s-case`,
  and B4 (part 07, `07-the-reader-cases-menus-lists.md`, section 14) leaves out
  `forms-and-case-writes/form-link-or-endpoint-through-a-first-menu-that-shares-one-case`. The
  shape joins the targeted set in A4 as `targeted-forms-in-menu-above-shared-case`
  (`proof/targeted/documents/formsInMenuAbovePrefixes.ts`, a third document there) with a link and
  an entry point admitted, and `screenOfFrame` lands such a frame on the form it names, with the
  frame's selection applied to the menu that supplies it. No new rule and no new code replaces the
  three refusals. The existing `rules/form.ts::formLinkValidation` judges the frame as it judges
  every other, with one condition added to its automatic match: a link is matched to the shared
  case automatically only where every menu above selects one case type under that datum id, and is
  otherwise `FORM_LINK_DATUMS_INCOMPLETE` until its carried value is named by hand, since HQ
  matches by the case type of whichever list `os.path.commonprefix` took. `previous` stays
  unoffered on the first menu either way (section 5.6).

---

## 1. What Nova does today

**Menus.** `lib/domain/modules.ts::moduleSchema` holds `parentModuleUuid` (one tier,
`lib/domain/moduleHierarchy.ts`), `displayCondition`, `hiddenFromMenu`, `icon`, `audioLabel`,
`caseListMenuItem`, `caseListRegistrationForm`, `entryPoint` and `caseListEntryPoint`. Every module has
a screen of its own: `lib/commcare/compiler.ts::compileCcz` writes one `<menu id="m<N>">` per module
(`root="m<P>"` on a submenu), and `lib/commcare/hqShells.ts` writes `put_in_root: false` on every
module shell. `lib/commcare/CLAUDE.md` ("Ordinary nested menus") says "Never conjoin the parent's
filter, and never project this as `ShadowModule` or `put_in_root`", and
`lib/domain/formLinkTargets.ts::menuTargetOffered` says "Nova has no display-only-forms menu, so HQ's
`put_in_root` exclusion has no input here". `lib/commcare/validator/rules/module.ts` refuses a module
with no menu form and no case list entry, so every module's own `<menu>` holds a command.

**Case first.** `lib/domain/menuForms.ts::moduleIsCaseFirst` answers for one module, over its menu
forms (`isCaseFirstModule`). Its readers: `lib/domain/entryDatumSupplies.ts::entryDatumSupplies` (the
`form-menu` point), `lib/domain/navigation.ts::moduleDestination`,
`lib/domain/expression/context.ts::slotContext` (a form's display condition),
`lib/commcare/validator/rules/displayConditions.ts::formDisplayCondition`,
`rules/case-search/formsReadSearch.ts`, `lib/doc/hooks/useModuleIds.ts`, and Preview
(`components/preview/screens/FormScreen.tsx`, `CaseListScreen.tsx`,
`lib/preview/app-tests/navigation.ts`, `lib/preview/engine/postSubmissionEvaluation.ts`).

**Frames.** `lib/commcare/formLinkProjection.ts` restates HQ's `get_frame_children` for menus that all
have a screen: `frameCommand` writes `m<N>` for every module, `moduleFrameChildren` and
`formFrameChildren` prepend the parent's path, and `baseFormFrameChildren` takes the common prefix of
one module's form entries. `caseListFormReturnFrame` builds the one return frame of the
`after-empty-search` arm.

**After submit.** `lib/domain/postSubmit.ts::postSubmitDestinationsOffered` withholds destinations by
seven reasons (`POST_SUBMIT_NOT_OFFERED_REASONS`), the last two for a menu or a parent that is off the
menu. `lib/commcare/validator/rules/hiddenFromMenu.ts` refuses anything that would open a module that
is off the menu (`HIDDEN_MENU_NOT_A_DESTINATION`, arms `link`, `entry-point`,
`case-list-entry-point`).

**Registration from the case list.** `modules.ts::caseListRegistrationFormSchema` is one strict object,
`{ kind: "after-empty-search", formUuid, label? }`: a registration form of the module, on no menu,
offered on Results after a search finds nothing. `menuForms.ts::caseListRegistrationFormOf` returns its
form, and `menuFormUuidsOf` leaves that form out of the menu.
`lib/commcare/emissionPlan.ts::emissionPlan` lowers the form into a synthetic hidden module, the host
writes `case_list_form` with `post_form_workflow: "case_list"` and the relevancy
`count(instance('results:inline')/results/case) = 0` (`expander.ts`, `suite/case-search/noMatches.ts`),
and the local suite writes the Register action on the short detail
(`suite/case-list/shortDetail.ts::buildRegisterActionBlock`, `compiler.ts::registerActionFor`). Six
rules bound it (`validator/rules/case-search/caseListRegistration.ts`). The reducer deletes the slot
when its form is removed or moved out (`lib/doc/mutations/forms.ts`). Preview admits the form only from
the Register action of a completed empty search (`lib/preview/caseListRegistration.ts`). The builder
offers it in the Search canvas (`components/builder/case-list-config/canvas/
CaseListRegistrationSetting.tsx`) and on the form (`detail/formSettings/FormEntrySection.tsx`); the
form tools take `case_list_registration: { label? }` (`lib/agent/tools/shared/caseListRegistration.ts`).
The publish probe asks the capability "registration offered after an empty search" for any module
holding the slot (`lib/commcare/projectSpaceCompatibility.ts`).

**Menu media.** A module, a form and a case list menu item each hold `icon` and `audioLabel`. The tool
`setMenuMedia` has the targets `module` and `form`; "No tool sets the item's icon or spoken label"
(`lib/agent/tools/shared/caseListMenuItem.ts`), which the builder's `CaseListMenuItemSection` does.
`lib/commcare/multimedia/navMenuMedia.ts` writes the media dicts and the suite's display node.

**The manifest.** `menus-and-case-lists/put-in-root-display-only-forms`,
`menus-and-case-lists/case-list-form-pointing-at-a-registration-form-in-another-module` and
`menus-and-case-lists/case-list-form-media-image-media-audio` are HELD-NEW; the refused and inert
neighbours of both concepts already exist (section 14).

---
## 2. What CommCare HQ does with `put_in_root`

Lifecycle: `ModuleBase.put_in_root` is a live `BooleanProperty(default=False)`, set by the menu
settings page (`views/modules.py`, `should_edit("put_in_root")`), offered while the add-on `menu_mode`
is on (`add_ons.py`; `module_view_settings.html`), read by the build with no toggle, privilege or
version test. `ReportModule.put_in_root` is a fixed `False`; `ShadowModule` holds the live property
(`menus.py::_generate_v1_shadow_menus` reads a shadow's), and Nova emits neither kind. Write M for a
module, P for its parent, "above" for `put_in_root: true`. The table's row numbers are its own.
"Effect N" anywhere in this part counts the other list, the eleven effects "Executed during
planning" numbers (effect 9 is row 10 here, effect 10 row 12, effect 11 the paragraph on Core's
question under the table).

| # | What HQ does | Source | Nova, from step 6 |
|---|---|---|---|
| 1 | A menu's id is `m<N>`; above, it is its parent's id, and `root` with no parent or a parent that is above too | `id_strings.py::menu_id` | `menuScreens.ts::menuScreenOf`; `formLinkProjection.ts::menuIdOf` |
| 2 | An above menu's `<menu>` has that id and no `root` attribute; a menu not above has `root="<menu_id(P)>"`, which is `root` under an above parent | `menus.py::get_module_contributions`, `_generate_menu` | `compiler.ts`, section 6.2; such a submenu lists on the first menu (`menuTileScreenOf`) |
| 3 | An above submenu's `<menu>` takes P's name where P is not above, and keeps its own image and audio locales | `suite_xml/utils.py::_should_use_root_display`; `_generate_menu` | section 6.2; the menu's own name and media are shown nowhere (section 3.3) |
| 4 | An above submenu's condition is `(own) and (P's)`, or P's alone where it has none; nothing else is conjoined | `_generate_menu` | section 6.2; `menuScreens.ts::conditionModulesOf` |
| 5 | The case list of an above menu gets no Register action and no Search action | `details.py::build_detail` | `FORMS_IN_MENU_ABOVE_WITH_SEARCH`, `CASE_LIST_REGISTRATION_HOST_SHOWS_FORMS_ABOVE` |
| 6 | The build refuses an above menu with an endpoint or with inline search | `validators.py::validate_display_only_forms` | `FORMS_IN_MENU_ABOVE_NOT_A_DESTINATION`, `FORMS_IN_MENU_ABOVE_WITH_SEARCH` |
| 7 | The build refuses the after-submit `module` in an above menu and `parent_module` under an above parent; the form page offers neither; the link editor never lists an above menu as a target, and lists its forms | `validators.py::FormBaseValidator`; `views/forms.py::get_form_view_context`, `_get_linkable_forms_context` | two reasons of `POST_SUBMIT_NOT_OFFERED`; `menuTargetOffered` |
| 8 | A frame's module command is the menu id; where that is `root` there is none, and the common datums are those of every form of every above menu in the app, ahead of the form's command | `workflow.py::WorkflowHelper.get_frame_children`, `_root_module_datums` | section 6.3; a frame that would open with a chosen case is refused at its source (decision 19) |
| 9 | `previous` in an above submenu of a parent that keeps its screen names the parent's command twice | `get_frame_children(…, include_root_module=True)` | section 6.3, written as HQ writes it |
| 10 | A form's display condition that reads the case is a build error in an above menu, unless P has the same case type and all P's forms need a case | `menus.py::_get_commands`; `ModuleBase.root_requires_same_case` | `FORM_DISPLAY_CONDITION_CASE_DATA_UNAVAILABLE` over `screenChoosesCaseFirst` (stricter, section 5.4) |
| 11 | From CommCare 2.54 each `<menu>`'s instances are declared on that `<menu>`; below it they are folded into every entry of every menu of the id | `instances.py::InstancesHelper._add_menu_instances`, `_menu_xpaths_by_command`; `feature_support.py::supports_menu_instances` | declared on each `<menu>` from its own printed condition, as HQ does at Nova's floor of 2.57 |
| 12 | A case list endpoint is built with no command for an above menu | `endpoints.py::_make_session_endpoint` | refused (`FORMS_IN_MENU_ABOVE_NOT_A_DESTINATION`, arm `case-list-entry-point`) |
| 13 | The editor withdraws registration from the case list on an above menu | `views/modules.py::_case_list_form_not_allowed_reasons` | `CASE_LIST_REGISTRATION_HOST_SHOWS_FORMS_ABOVE` |
| 14 | The form page offers `previous` in an above menu, and for a form listed on the first menu its frame is the root datums, the form's command and its own datums with the last popped: the form's command alone where the root datums are empty, the root datums and no command otherwise | `views/forms.py::get_form_view_context`; `workflow.py::EndOfFormNavigationWorkflow._get_static_stack_frame` | not offered there (`menu-forms-on-first-menu`, sections 5.1 and 5.6) |

**What a device does with it.** Core lists a screen by walking every `<menu>` in suite order
(`MenuLoader.getMenuDisplayables`): a menu whose id is the screen's adds its commands where its
condition holds; any other menu whose `root` is the screen's id is added once as an entry, by its first
relevant element. So the forms of an above menu appear in place, in module order, between the entries
around them. A `<menu>` with no `root` attribute has the root `root` (`Menu.ROOT_MENU_ID`), which is
why an above top-level menu's commands list on the first menu. Formplayer builds the same list
(`CommandListResponseBean` over Core's `MenuScreen`), and commcare-android opens `MenuActivity` on
`Menu.ROOT_MENU_ID`. The two platforms read the feature alike.

Core then asks, for the command a worker chose, what every entry behind it needs first
(`CommCareSession.getNeededData`, `getEntriesForCommand`, `getDataNeededByAllEntries`): every entry of
every menu with that id. If each needs the same datum id first and it is a case choice, the case list
of the first entry shows before any form; otherwise the forms list first. On the first menu no command
is chosen yet, so a form is always chosen first there. This is effect 11 of "Executed during
planning", and section 4.3 is its rule. "Every entry" counts a case list entry too
(`getStillValidEntriesFromMenu` returns the entry of each command the menu holds), so a menu whose
only entry is its case list still asks for its case first.

Core keeps what a frame collected: `syncState` rebuilds the session's datums from every step of the
current frame, and an entry's next question is its first datum whose id the session lacks
(`getFirstMissingDatum`), whatever case type its nodeset names. So a frame that holds a chosen case
and no command leaves that case on the first menu, where the next form that asks for a case under
that datum id takes it without asking. Formplayer rebuilds its session from empty and matches each
step to a menu option (`MenuSessionFactory.rebuildSessionFromFrame`), so Web Apps keeps nothing
there. Decisions 18 and 19 are how Nova stays out of that shape.

**Starter shapes.** All eight starter menus that are above are top-level, hold one form, and have no
search, endpoint or condition; two hold an icon; three name a registration form another menu's case
list offers (section 10.5).

---

## 3. The concept

### 3.1 Name

A menu **shows its forms in the menu above**. For a top-level menu the menu above is the app's first
menu (Nova's existing name for it, `firstMenu`); for a submenu it is its parent. In prose: "a menu that
shows its forms in the menu above"; where a sentence names the place: "shows its forms on the app's
first menu" or "shows its forms in <parent>". The builder's switch reads "Show its forms in the menu
above". No copy says "display only", "root" or "put in root".

### 3.2 The stored slot

`lib/domain/modules.ts::moduleSchema` gains, after `hiddenFromMenu`:

```ts
/**
 * Present when the module's forms, and its case list entry, are listed in the
 * menu above (the app's first menu for a top-level module, its parent for a
 * submenu) and the module has no entry and no screen of its own. Its name,
 * icon and spoken label stay stored and are shown nowhere while this is set.
 * `menuScreens.ts` is the one reader of what lists where.
 */
formsInMenuAbove: z.literal(true).optional(),
```

Presence is the switch, as `hiddenFromMenu` is. `lib/domain/modules.ts` also exports
`moduleShowsFormsInMenuAbove(module: Pick<Module, "formsInMenuAbove"> | undefined): boolean`.

### 3.3 What it does, stated once

- The menu's forms and its case list entry list on the screen above, where the menu's entry would be,
  in the menu's own order. The menu has no entry there.
- A top-level menu's submenus list on the first menu too: each that keeps its own screen as an entry,
  each that shows above as its forms.
- The menu's own display condition and `hiddenFromMenu` decide whether its forms list; a submenu's
  forms also need its parent's condition and need the parent on the menu. A submenu that keeps its own
  screen under such a top-level menu follows its own condition alone.
- The menu's name, icon and spoken label are shown nowhere. They stay stored, the builder keeps
  showing and editing them under a note, and they apply again when the slot is cleared.
- The menu still owns its case type, case list, columns and filter, and each of its forms still opens
  from its own entry, with the case list its own menu configures.
- Nothing may open the menu itself (section 5.1), and it takes no search and no registration from its
  case list (section 5.2).
- A form listed on the app's first menu is not offered `previous` after submit, and a case-loading
  form there goes to the first menu by default (section 5.1).
- Where every form on a screen opens the same case, the worker chooses the case first and then sees the
  forms; otherwise the worker chooses a form first (section 4.3).

What a worker sees and where a form lands do not differ between Web Apps and Android (section 2), so
it adds no row to the platform table (`platforms.ts::PLATFORM_FEATURES`). The two places where the
platforms rebuild a session differently change no landing Nova writes: the `m<P>`, `m<P>` frame of
`previous` in a submenu above lands alike on both (section 6.3; read, not run, and run G2 is the
check, with what lands where they differ), and a chosen case ahead of a command is never written
(decision 19).

---

## 4. Which screen lists what: `lib/domain/menuScreens.ts`

A new file, exported through the `lib/domain` barrel. It imports `moduleHierarchy.ts`, `menuForms.ts`,
`modules.ts` and `entryDatumSupplies.ts`, and nothing outside `lib/domain`.

### 4.1 Types and readers

```ts
/** A screen a worker chooses from: the app's first menu, or one menu's own screen. */
export type MenuScreen =
	| { readonly kind: "first-menu" }
	| { readonly kind: "menu"; readonly moduleUuid: Uuid };

export type MenuScreenEntry =
	| { readonly kind: "menu"; readonly moduleUuid: Uuid }
	| { readonly kind: "form"; readonly moduleUuid: Uuid; readonly formUuid: Uuid }
	| { readonly kind: "case-list"; readonly moduleUuid: Uuid };

export function menuScreenKey(screen: MenuScreen): string;
/** Whether the module has an entry and a screen of its own. */
export function moduleHasOwnScreen(doc, moduleUuid: Uuid): boolean;
/** The screen that lists the module's forms and its case list entry. */
export function menuScreenOf(doc, moduleUuid: Uuid): MenuScreen;
/** The screen that lists the module's own entry; undefined where it has none. */
export function menuTileScreenOf(doc, moduleUuid: Uuid): MenuScreen | undefined;
/** The modules whose forms list on the screen, in module order. */
export function menuScreenContributors(doc, screen: MenuScreen): Uuid[];
/** Everything the screen lists, in the order a worker meets it. */
export function menuScreenEntries(doc, screen: MenuScreen): MenuScreenEntry[];
/** The modules whose display condition and `hiddenFromMenu` gate a
 *  contributor's entries: the module, then its parent where it shows above. */
export function conditionModulesOf(doc, moduleUuid: Uuid): Uuid[];
/** The menu above, for copy: the first menu, or the parent by name. */
export function menuAbove(doc, moduleUuid: Uuid):
	| { readonly kind: "first-menu" }
	| { readonly kind: "menu"; readonly moduleUuid: Uuid; readonly name: string };
export function screenChoosesCaseFirst(
	doc: MenuScreenSource,
	screen: MenuScreen,
	prepared?: PreparedMenuForm,
): boolean;
export function screenCaseFirstBlocker(doc, screen: MenuScreen): ScreenCaseFirstBlocker | undefined;
export function screenIsBareCaseList(doc, screen: MenuScreen): boolean;
```

Every `doc` above is the file's one source type, which it exports for the Preview wrappers of section
8: `export type MenuScreenSource = Pick<BlueprintDoc, "modules" | "moduleOrder" | "forms" |
"formOrder" | "caseTypes">`. `PreparedMenuForm` is `menuForms.ts`'s.

### 4.2 The rules

Write "above" for a module holding `formsInMenuAbove`, P for a module's parent.

| Function | Rule |
|---|---|
| `moduleHasOwnScreen` | the module exists and is not above |
| `menuScreenOf(M)` | M's own screen where M is not above; P's own screen where M is above and P exists and is not above; else the first menu |
| `menuTileScreenOf(M)` | undefined where M is above; the first menu where M is top-level, or P is above; else P's own screen |
| `menuScreenContributors(screen)` | every module M with `menuScreenOf(M)` equal to the screen, in `projectedModulePreorder` order |
| `menuScreenEntries(screen)` | walk `projectedModulePreorder`; a contributor adds its `menuFormUuidsOf` forms in order, then its case list entry where `moduleHasCaseListMenuItem`; a module whose `menuTileScreenOf` is the screen adds one `menu` entry; any other module adds nothing |
| `conditionModulesOf(M)` | `[M, P]` where M is above and P exists; else `[M]` |
| `screenIsBareCaseList(screen)` | a menu screen whose entries are exactly one `case-list` entry of its own module and, after it, zero or more `menu` entries |

`menuScreenEntries` is `MenuLoader.getMenuDisplayables` over the `<menu>` elements section 6.2 writes:
the same walk, the same order. A `menu` entry stands for the first relevant `<menu>` of its id, which
is always the module's own, because every module's own `<menu>` holds a command (section 1) and an
above submenu's condition implies its parent's.

Visibility is not this file's: it lists structure. A reader shows a contributor's entries when every
module of `conditionModulesOf` is on the menu and its condition holds, and a `menu` entry by its own
module alone where its parent is above, or by itself and its parent where the parent keeps its screen
(today's rule).

### 4.3 Case first

```ts
export interface ScreenCaseFirstBlocker {
	readonly reason:
		| "first-menu"
		| "bare-case-list"
		| "opens-without-a-case"
		| "chooses-another-case";
	/** The contributor that keeps the screen forms first; present for
	 *  `opens-without-a-case` and `chooses-another-case`. */
	readonly moduleUuid?: Uuid;
	/** Its first form that opens without a case; present for `opens-without-a-case`. */
	readonly formUuid?: Uuid;
}
```

`screenCaseFirstBlocker(doc, screen)`, first match:

1. the first menu: `{ reason: "first-menu" }` (Core asks for a command while none is chosen);
2. a bare case list (`screenIsBareCaseList`): `{ reason: "bare-case-list" }`. Core opens such a
   screen on its list, and Nova names it by `screenIsBareCaseList`, never by case first, as
   `moduleIsCaseFirst` answers false for a module with no forms today;
3. the first contributor, in order, that holds a menu form whose type is outside
   `CASE_LOADING_FORM_TYPES`: `{ reason: "opens-without-a-case", moduleUuid, formUuid }`, `formUuid`
   the first such form. A contributor with no menu forms, whose one entry is its case list, holds
   none and passes to the next rule;
4. the first contributor other than the host whose first selection differs from the host's:
   `{ reason: "chooses-another-case", moduleUuid }`, comparing
   `entrySelections(doc, firstEntry)[0]?.key` (`entryDatumSupplies.ts::entrySelections`), where a
   module's first entry is its first menu form's (`{ kind: "form" }`), else its browse entry
   (`{ kind: "browse" }`). That key is the same for two selections exactly where the wire gives them
   one datum id (an aligned selection takes the parent row's key; an unaligned one that collides is
   renamed);
5. otherwise undefined.

Rules 3 and 4 are Core's question over every entry the screen lists, a case list entry included
(section 2): one entry stands for a module because its case-loading menu forms and its browse entry
all start with the module's first selection, which run G4 holds by comparing every entry's first
datum on the wire, never the first entry's alone. A contributor whose only entry is its case list
therefore keeps a case-first screen case first where its list's selection is the host's, and turns
it forms first where it is another.

`screenChoosesCaseFirst(doc, screen, prepared)` is "no blocker", with `prepared` standing for the one
prepared form where rule 3 reads its type. On a screen with one contributor it equals
`moduleIsCaseFirst` of that module, which is today's answer for every existing document; run G4 holds
both to the wire.

The case list a case-first screen shows is its host's: Core takes the needed datum from the first
entry (`CommCareSession.getNeededDatum`), which is the host's first command. A submenu's form listed
there opens with that case where its first selection is the host's, and then asks for any further case
its own entry needs (a child case under the chosen parent).

### 4.4 Who reads which

`moduleIsCaseFirst` keeps its meaning, "every menu form of this module opens a case", and stays the
reader for what is a fact of one module. Each reader that means "a case is chosen before this form is
listed" moves to the screen:

| Reader | From step 6 |
|---|---|
| `lib/domain/entryDatumSupplies.ts::entryDatumSupplies`, `form-menu` point | `screenChoosesCaseFirst(doc, menuScreenOf(doc, point.module), prepared)` |
| `lib/domain/expression/context.ts::slotContext`, `form_display_condition` | the same, for `caseData` and the case row |
| `lib/commcare/validator/rules/displayConditions.ts::formDisplayCondition` | the same, with the blocker for its sentence (section 5.4) |
| `lib/domain/navigation.ts::moduleDestination` | `isCaseFirst` from the module's own screen; `isBareCaseList` from `screenIsBareCaseList`; `{ screen: "unavailable" }` for a module with no screen |
| `lib/doc/hooks/useModuleIds.ts` (`useIsCaseFirstModule`, the case-first set) | the screen's answer, for a module with a screen |
| `components/builder/conditions/useDisplayConditionCarrier.ts` (the form carrier's `caseFirst`) | the screen's answer |
| Preview: `components/preview/screens/FormScreen.tsx`, `CaseListScreen.tsx`, `ModuleScreen.tsx`, `lib/preview/app-tests/navigation.ts`, `lib/preview/engine/postSubmissionEvaluation.ts` | the screen's answer (section 8) |
| `lib/commcare/validator/rules/case-search/formsReadSearch.ts` (`FORMS_READ_SEARCH_REQUIRES_CASE_FIRST_MODULE`) | unchanged: `moduleIsCaseFirst`, since HQ's inline search rule reads the module's own forms |
| `lib/domain/forms.ts::isCaseFirstModule`, `menuForms.ts::moduleIsCaseFirst` | unchanged |

`moduleIsBareCaseList` likewise keeps its module meaning (the nested-menu rule, the planners, the
`menu-is-bare-case-list` after-submit reason), and the two landing readers above take
`screenIsBareCaseList`.

---

## 5. Validator rules of forms in the menu above (A4)

Every new code takes its row in `lib/commcare/validator/errors.ts::ValidationErrorCode`,
`gate.ts::VALIDITY_CLASS_BY_CODE` (`soundness`) and `lib/doc/userFacingErrors.ts` in A4. Messages
below are the validator's (the agent and MCP voice); the builder's sentences are in "Copy". `<above>`
is `the app's first menu` or `"<parent name>"`.

### 5.1 Nothing opens a menu with no screen

`lib/commcare/validator/rules/formsInMenuAbove.ts` (new) has the shape of `rules/hiddenFromMenu.ts`
and exports four rules:

```ts
/** A module rule, in `rules/module.ts::MODULE_RULES` after `hiddenMenuEntryPoints`. */
export function menuAboveEntryPoints(mod: Module, moduleUuid: Uuid, doc: BlueprintDoc): ValidationError[];
/** A module rule, next in `MODULE_RULES` (section 5.2). */
export function menuAboveSearch(mod: Module, moduleUuid: Uuid, doc: BlueprintDoc): ValidationError[];
/** Called from `rules/form.ts::runFormRules` after `hiddenMenuLinkTargets`, with its `location`. */
export function menuAboveLinkTargets(
	doc: BlueprintDoc,
	form: Form,
	location: {
		readonly moduleUuid: Uuid;
		readonly moduleName: string;
		readonly formUuid: Uuid;
		readonly formName: string;
	},
): ValidationError[];
/** An app rule, in `rules/app.ts::APP_RULES` after `validEntryPoints` (section 5.5). */
export function firstMenuSharedCaseFrames(doc: BlueprintDoc): ValidationError[];
```

The first and the third share one code, `FORMS_IN_MENU_ABOVE_NOT_A_DESTINATION`, `details.arm`:

| Arm | Located | Message |
|---|---|---|
| `link` | the source form; `details.linkUuid`, `role`, `targetModuleUuid`, `targetModuleName` | `"<target>" shows its forms in the menu above, so it has no screen of its own for the link from "<form>" to open. You can point the link at one of its forms, or give "<target>" its own screen again (forms_in_menu_above null).` |
| `entry-point` | the module | `"<menu>" shows its forms in the menu above, so it has no screen of its own for its entry point to open. You can give one of its forms an entry point, or give "<menu>" its own screen again (forms_in_menu_above null).` |
| `case-list-entry-point` | the module | `"<menu>" shows its forms in the menu above, so its case list entry point would open <above> and never the list. You can remove that entry point, or give "<menu>" its own screen again (forms_in_menu_above null).` |

A link or an entry point to a form inside the menu is admitted, but for the one shape section 5.5
refuses.

`lib/domain/formLinkTargets.ts::menuTargetOffered` returns false for a target that is above, before
its other tests, and its comment's last sentence is replaced (section "Contracts"). `nearestOfferedMenu`
returns the parent only where the parent has its own screen and is on the menu; otherwise undefined.

`lib/domain/postSubmit.ts` gains three reasons, appended to `POST_SUBMIT_NOT_OFFERED_REASONS` in this
order. `lib/domain/forms.ts::PostSubmitMenuShape` gains two facts, `formsInMenuAbove?: boolean` (the
module holds the slot) and `formsOnFirstMenu?: boolean` (`menuScreenOf` of the module is the first
menu: it is above and top-level, or above under a parent that is above), and `PostSubmitModuleFacts`
gains `parentFormsInMenuAbove: boolean`; `postSubmitModuleFacts` sets all three.

| Reason | Holds where | Withholds | `rules/form.ts::notOfferedSentence` |
|---|---|---|---|
| `menu-forms-in-menu-above` | `formsInMenuAbove` | `module` | `"<form>" goes to its module <when>, but "<menu>" shows its forms in the menu above, so it has no screen of its own to land on.` |
| `parent-forms-in-menu-above` | `parentFormsInMenuAbove` | `parentMenu` | `"<form>" goes to the parent module <when>, but "<parent>" shows its forms in the menu above, so it has no screen of its own to land on.` |
| `menu-forms-on-first-menu` | `formsOnFirstMenu` | `previous` | `"<form>" goes to the previous screen <when>, but "<menu>" shows its forms on the app's first menu, and Nova doesn't offer the previous screen to a form listed there yet.` |

The rule appends its own "Choose one of: …" to each, as it does today.

`previous` stays offered in a submenu that shows its forms in a parent that keeps its screen, where
HQ's frame returns to the parent's screen or to the form's own case list (section 6.3). The existing
codes `POST_SUBMIT_NOT_OFFERED` and `FORM_OTHERWISE_NOT_OFFERED` carry the new reasons;
`lib/agent/tools/form-links/shared.ts`'s reason phrases gain `<own> shows its forms in the menu above,
so it has no screen of its own`, `<parent> shows its forms in the menu above, so it has no screen of
its own` and `<own> shows its forms on the app's first menu, where the previous screen isn't offered
yet`.

`defaultPostSubmit` reads the two new facts, because it derives the default from the shape and never
from the offered set, and `lib/domain/CLAUDE.md` holds the default to the offered set. Its body
becomes:

```ts
if (!CASE_LOADING_FORM_TYPES.has(formType)) return "app_home";
const parentOrSelfWithholds =
	shape.parentMultiSelect === true || shape.offTheMenu === true;
if (
	!parentOrSelfWithholds &&
	shape.multiSelect !== true &&
	shape.formsReadSearch !== true &&
	shape.formsOnFirstMenu !== true
) {
	return "previous";
}
return parentOrSelfWithholds || shape.formsInMenuAbove === true
	? "firstMenu"
	: "module";
```

So a case-loading form listed on the first menu defaults to `firstMenu`, and one in a submenu that
shows above and selects several cases (where `previous` and `module` are both withheld) defaults to
`firstMenu` too. Without the second fact that form's default would be `module`, which HQ's build
refuses in a menu above (`validators.py::FormBaseValidator.validate_for_module`, `form link to display
only forms`). Every other form's default is unchanged, since both facts are absent without the slot.

### 5.2 No search, no registration from its case list

`FORMS_IN_MENU_ABOVE_WITH_SEARCH`, from the module rule `menuAboveSearch` of the same file (section
5.1), on a module that is above, `details.reason`:

| Reason | When | Message |
|---|---|---|
| `forms-read-search` | `moduleFormsReadSearch(mod)` | `"<menu>" shows its forms in the menu above and has its forms read the search, and CommCare HQ can't build a menu that does both. You can turn off Forms read the search (formsReadSearch null), or give "<menu>" its own screen again (forms_in_menu_above null).` |
| `search` | otherwise, `effectiveCaseSearchConfig(mod) !== undefined` | `"<menu>" shows its forms in the menu above, and CommCare offers no Search on the case list of such a menu, so a worker could never open its search. You can remove the search from "<menu>", or give it its own screen again (forms_in_menu_above null).` |

One finding per module, the first reason that holds. The owner-only availability arm
(`searchActionEnabled: false`) is no search and is admitted. The `after-empty-search` arm needs forms
that read the search, so this rule already covers it; the `always` arm's refusal is A5's
(`CASE_LIST_REGISTRATION_HOST_SHOWS_FORMS_ABOVE`, section 11.3).

### 5.3 What is admitted on purpose

A menu above may hold a display condition, `hiddenFromMenu`, a case list entry, a parent-case
selection, a selection of several cases, a tile, and submenus; a submenu of it may be above too. A menu
whose only entry is its case list may be above. Each is a shape HQ builds, the projection lists, and
the targeted documents hold (section 15).

### 5.4 A form's display condition and the case

`rules/displayConditions.ts::formDisplayCondition` passes the screen's answer as `caseFirst` and the
blocker. `validateCarrier`'s explanation gains three arms for the code
`FORM_DISPLAY_CONDITION_CASE_DATA_UNAVAILABLE`, chosen by the blocker where the form's own module is
case first (the fourth blocker, `bare-case-list`, names a screen with no form and so no condition):

| Blocker | Explanation, after "… that case context is unavailable." |
|---|---|
| `first-menu` | `Its forms show on the app's first menu, where a worker chooses a form before any case.` |
| `opens-without-a-case` | `Its forms show with "<blocking menu>"'s on one screen, and "<blocking form>" there opens without a case, so a worker chooses a form before any case.` |
| `chooses-another-case` | `Its forms show with "<blocking menu>"'s on one screen, and those forms choose a different case first, so a worker chooses a form before any case.` |

`details` gains `reason`, `blockingModuleUuid` and `blockingFormUuid`. This is stricter than HQ's test
(effect 9 of "Executed during planning", which is section 2's row 10, reads the parent's own forms
alone), because the condition is evaluated where Core lists the command, and there no case is
chosen whenever any entry of the screen differs. A change that would strand such a condition
(turning the slot on for a menu with a registration form under a case-first parent whose forms read
the case) is refused at that batch with this finding.

### 5.5 No chosen case ahead of a command

`formLinkProjection.ts` exports two readers of the frames section 6.3 builds:

```ts
/** The first selection in the common prefix of the root lists: the chosen
 *  case HQ puts ahead of every frame built through the first menu. Undefined
 *  where that prefix holds no selection. */
export function firstMenuSharedCase(
	doc: BlueprintDoc,
	ctx: FormLinkProjectionContext,
): FrameDatum | undefined;
/** Whether a selection datum stands before the frame's first command. */
export function frameLeadsWithSelection(children: readonly FrameChild[]): boolean;
```

In the frames Nova builds the second holds exactly where the first is defined and the frame is built
through the first menu: its target is a form of a menu whose forms list there, or a form, a case list
or the screen of a submenu that keeps its screen under a top-level menu that shows its forms above.
Core keeps such a case on the first menu when a worker steps back (section 2), so Nova refuses the
frame at its source. Each of the three findings below comes from an app rule, because the shared case
reads every menu above, and each rule returns at once where `firstMenuSharedCase` is undefined and
otherwise judges its projected frames by `frameLeadsWithSelection`: the link's from a new rule,
`firstMenuSharedCaseFrames(doc)` in `rules/formsInMenuAbove.ts`, added to `rules/app.ts`'s list, whose
code joins `runner.ts::SCOPE_EXEMPT_CODES`; the entry point's from the existing `validEntryPoints`;
the Register return's from A5's `caseListRegistrationApp`. `<above menu>` is the target's own menu
where that shows its forms above, else its parent.

| Source | Finding | Message |
|---|---|---|
| an after-submit link, a destination or the otherwise link | `FORM_LINK_TARGET_SHARES_FIRST_MENU_CASE` (new, `soundness`), at the source form; `details.linkUuid`, `role`, `aboveModuleUuid`, `aboveModuleName` | `The link from "<form>" to "<target>" opens through the app's first menu, where every form listed from a menu that shows its forms above opens one chosen case. CommCare HQ puts that case ahead of "<target>" in the link, and on Android CommCare keeps it on the first menu when a worker steps back, for the next form to open on. You can give "<above menu>" its own screen again (forms_in_menu_above null), or remove the link.` |
| an entry point: on a form, or on a submenu or its case list under a top-level menu above | `ENTRY_POINT_INVALID`, new reason `first-menu-shared-case` in `rules/app.ts::validEntryPoints`, chosen where no earlier reason holds and before `destination`; `details.aboveModuleUuid` | `The entry point on "<target>" opens through the app's first menu, where every form listed from a menu that shows its forms above opens one chosen case. CommCare HQ puts that case ahead of "<target>" in the entry point, and on Android CommCare keeps it on the first menu when a worker steps back, for the next form to open on. You can give "<above menu>" its own screen again (forms_in_menu_above null), or remove the entry point.` |
| the Register return of an `always` arm (A5) | `CASE_LIST_REGISTRATION_HOST_SHOWS_FORMS_ABOVE`, reason `parent-shares-first-menu-case` (section 11.3) | section 11.3 |

`formLinkValidation`'s three datum rules run only for a link this rule admits, so each still judges a
frame whose every selection follows a command. The offering sites ask the same reader:
`lib/doc/formLinkReview.ts::FormLinkTargetVerdict` gains the arm `{ readonly ok: false; readonly
reason: "first-menu-shared-case"; readonly aboveModuleUuid: Uuid }`, which `formLinkTargetVerdict`
returns for a form or a menu target; `formLinkTargetChoices.ts::FormLinkMenuChoice`'s unoffered arm
gains `{ readonly offered: false; readonly reason: "first-menu-shared-case"; readonly
aboveModuleUuid: Uuid }` (section 9); and `lib/doc/entryPointReview.ts` returns the entry point's
sentence, so the builder shows the target or the control disabled with it. A batch that would
strand an admitted link (taking the last registration form off the first menu, so every form left
there opens one case) is refused with the link's sentence, as a batch that removes a link's target
is.

### 5.6 What stays step 7's, with the reason

| HQ shape | Stays, as | Why |
|---|---|---|
| `previous` on a form listed on the first menu | HELD-NEW, `menus`, subject `display-only-forms` | HQ's frame returns to the form's own case list only while some form listed on the first menu opens differently; where they all open one chosen case it is that case and no command, which lands on the first menu and is no screen before the form (section 2, row 14). Which of the two a form gets depends on every other menu above, so one form's offered set would move with an edit to another menu, and every such edit would have to reconcile every form listed there. Step 7 brings it with that reconcile |
| a link, an entry point or a Register return built through the first menu while every form above opens one chosen case | HELD-NEW, `menus`, subject `display-only-forms` | Android keeps the case on the first menu when a worker steps back, and Preview has no screen that holds a chosen case there; run G6 may lift it |

---

## 6. Emission (A4)

### 6.1 HQ JSON

`lib/commcare/hqShells.ts` module shells keep `put_in_root: false`; `lib/commcare/expander.ts::expandDoc`
sets `shell.put_in_root = true` for a module that is above, basic or advanced alike (`ModuleBase` holds
the key). `lib/commcare/addOns.ts` adds `menu_mode` to `NEEDED_ADD_ON_SLUGS`, between `enum_image` and
`register_from_case_list` (the list is alphabetical), and to the needed set where a module has
`put_in_root`, as HQ's `used_in_module` reads it; its header comment loses `menu_mode` from the slugs
"never needed" (section "Contracts"). `proof/views/test_add_ons.py` asserts `menu_mode` absent from
Nova's add-ons on `targeted-hq-side-state`, which holds no menu above, so the assertion stays true.
`root_module_id`, `module_filter` (the menu's own), `media_image`, `media_audio` and `name` are
written as today: HQ's build derives every effect of section 2 from the flag.
`lib/commcare/types.ts` already types `put_in_root` as `boolean`, and `validator/hqJsonOracle.ts`
needs no change.

### 6.2 The local suite

`lib/commcare/compiler.ts::compileCcz` writes each module's `<menu>` from five derived values:

| Part | Value |
|---|---|
| `id` | `menuIdOf(doc, ctx, M)`: `m<M>` where M is not above; `m<P>` where M is above under a parent that is not; else `root` |
| `root` attribute | absent where M is above or top-level; else `menuIdOf(doc, ctx, P)`, which prints `root="root"` under an above parent |
| text locale | `modules.m<P>` where M is above, has a parent, and the parent is not above; else `modules.m<M>` |
| image and audio locales | always M's own, `modules.m<M>.icon` and `modules.m<M>.audio`, from M's `icon` and `audioLabel` |
| `relevant` | M's emitted condition (`emitModuleDisplayCondition`, the `hiddenFromMenu` spelling included); where M is above with a parent whose emitted condition exists: `(M's) and (P's)` with both sides parenthesized, or P's alone where M has none |

`formLinkProjection.ts` exports `ROOT_MENU_ID = "root"` and `menuIdOf`. `multimedia/navMenuMedia.ts::
buildNavMenuNode` takes the text locale id and the media locale base as two arguments in place of its
one `baseLocaleId`: `buildNavMenuNode(textLocaleId: string, mediaLocaleBase: string, icon: IconRef |
undefined, audioLabel: MediaAssetId | undefined, manifest: AssetManifest | undefined, where: string):
NavMenuNode`, the media locales being `<mediaLocaleBase>.icon` and `.audio`. The conjunction is
built as a wire tree: `w.and` over the two condition trees, each wrapped in a new parenthesis node.
The wire tree prints parentheses by precedence alone today (`xpath/wire/precedence.ts`), so
`xpath/wire/builders.ts` gains `w.paren(expr: WireExpr): WireExpr`, which `serialize.ts` prints as
its operand in parentheses in every mode and `precedence.ts` treats as a primary. The printed text
is then HQ's `(a) and (b)` (`XPath.paren(force=True)`), and the menu's `<instance>` children are the
instances the whole printed condition reads. Commands, entries, details and `modules.m<N>` app
strings are written as today, for every module. Neither a Search action nor a Register action is
written on the short details of a module that is above (the validator refuses both; the emitter
stays total).

`validator/suiteOracle.ts` admits several `<menu>` elements of one id and the id and root `root`: its
menu-to-command join and its relevance context already read "every menu whose own id matches", and its
uniqueness rules stay on commands, details and instances. `validator/bindingResolutionOracle.ts` is
unchanged.

### 6.3 Stack frames

`formLinkProjection.ts` restates `WorkflowHelper.get_frame_children` with the menu id: `menuIdOf` and
two private helpers, four changed exports, and the two readers of section 5.5; nothing else in the
file changes.

```ts
// `doc` is `BlueprintDoc` and `ctx` is `FormLinkProjectionContext` in all three, as in every
// function of the file.
/** `id_strings.menu_id`. */
export function menuIdOf(doc, ctx, moduleUuid: Uuid): string;
/** The datum lists `get_frame_children` takes the common prefix of: the
 *  module's own form entries, or, where its menu id is `root`, the form
 *  entries of every module that shows its forms above, in module then form
 *  order (`WorkflowHelper._root_module_datums`). */
function frameDatumLists(doc, ctx, moduleUuid: Uuid): readonly (readonly FrameDatum[])[];
/** The module command, or nothing where the menu id is `root`. */
function menuCommand(doc, ctx, moduleUuid: Uuid): FrameChild[];
```

| HQ | Nova, from step 6 |
|---|---|
| `get_frame_children(M)` | `[...menuCommand(M), ...commonPrefixById(frameDatumLists(M))]` |
| `get_frame_children(M, form)` | that, then the form command `m<M>-f<K>`, then the form's own datums from index `common.length` on (`baseFormFrameChildren`) |
| `prepend_parent_frame_children` (form targets, entry points) | `get_frame_children(P)`, then every base child whose id, a command's or a datum's, the parent part does not hold (`formFrameChildren`; today it keeps every command, which is the same wherever no two commands share an id) |
| `_frame_children_for_module(M, include_user_selections=False)` (module targets, `module`) | the parent's `get_frame_children(P)`, then `menuCommand(M)` (`moduleFrameChildren`) |
| `_frame_children_for_module(P)` (`parentMenu`) | as today; refused under an above parent |
| `get_frame_children(M, form, include_root_module=True)` then pop (`previous`) | where `menuIdOf(M)` is not `root` and M has a parent: the datum lists gain the form entries of the module whose index `menuIdOf(P)` names (none where it is `root`), the children start with P's command unless it is `root`, then M's command; then the common prefix, the form command and the rest; then HQ's pop (`previousEntryFrameChildren`). Where `menuIdOf(M)` is `root` no form holds `previous` (section 5.1); `previousEntryFrameChildren` stays total there and returns HQ's children, which no reader asks for |

**The root lists.** Where a module's menu id is `root`, `frameDatumLists` is every form entry of every
module that shows its forms above, whichever screen lists it (`_root_module_datums` takes every
`put_in_root` module, a submenu above under a parent that keeps its screen among them), a case list
entry never (`_get_entries_datums`), and the frame holds no menu command. Their common prefix,
compared by datum id as HQ compares (`WorkflowSessionMeta.__eq__`), stands ahead of the form's
command. It takes one of three shapes:

- *Empty*: some form listed above opens differently from another. This is the starter shape (a
  registration form beside follow-up forms) and HQ's fixture `suite-workflow-module-in-root.xml`. A
  frame toward a form is the form's command, then its own datums.
- *Computed datums alone*: every form above is a registration form of one case type, the lone
  registration form among them. A frame toward it opens
  `<datum id="case_id_new_<t>_0" value="uuid()"/>` and then the form's command. Nova writes it as HQ
  does. A worker who steps back leaves a fresh id on the first menu that no case holds
  (`CommCareSession.stepBack` stops once a command is needed), which the next registration form of
  that type takes as its own, so nothing reads a wrong case (read, not run; a candidate of run G2).
- *A chosen case first*: every form above is case-loading under one datum id.
  `firstMenuSharedCase` is defined, and every link, entry point and Register return built through the
  first menu is refused at its source (section 5.5), so Nova writes no frame of this shape. Nothing
  Nova emits then reads which list's datum the prefix holds, so the projection keeps
  `commonPrefixById`'s first list, where HQ's `os.path.commonprefix` takes the least list by id order.

`formLinkProjection.ts`'s invariant, held by a test over the `menu-screens` corpus (section "Tests"):
no frame it returns for an admitted document has a selection ahead of its first command.

One consequence where the menu id is a parent's, HQ's bytes:

- `previous` in an above submenu of a parent that keeps its screen starts `m<P>`, `m<P>`. Formplayer
  matches both steps to the one menu option when it rebuilds the session
  (`MenuSessionFactory.rebuildSessionFromFrame`); on Android the session holds the parent menu twice in
  that frame. Nova writes it as HQ does and does not offer a different frame. Its common prefix runs
  over the submenu's forms and the parent's, which share a datum id only where they share the case
  (`add_parent_datums`), so the frame returns to the parent's screen with that case chosen. Where the
  prefix is empty it returns to a follow-up form's own command, which asks for its case again, and to
  the parent's screen for a registration form, whose computed datum and command HQ's pop both take.

`ctx.commandTargets` records, for a module command, the module whose screen the id names (P for an
above submenu), so `previousTaskProjection.ts` and Preview resolve a command to a screen that exists.
`caseListFormReturnFrame`, `entryPointProjection.ts`, `parentMenuDestinationFrameChildren` and
`moduleDestinationFrameChildren` call the changed functions and need no edit of their own.
`FORM_LINK_DATUMS_INCOMPLETE`, `FORM_LINK_DATUM_UNUSED` and `FORM_LINK_DATUM_TARGET_COLLISION` keep
judging the projected frame of every link section 5.5 admits. A computed datum of the root prefix
carries its function and needs no match, and a frame that would open with the shared case is refused
before any match is read, so no link is matched against a case type another menu supplies.

---

## 7. The doc layer (A4)

- **The payload.** `updateModule.patch` carries the slot: `canonicalModuleUpdatePatchSchema` is
  `clearablePartialPatch(moduleSchema)`, so `{ formsInMenuAbove: true }` sets it and `null` clears it,
  with no new mutation kind. `lib/doc/displayConditionMutations.ts` gains
  `setModuleFormsInMenuAboveMutation(moduleUuid, on: boolean): Mutation`
  (`patch: { formsInMenuAbove: on ? true : null }`), the one writer the builder and the tool call.
- **The diff.** `lib/doc/diffDocsToMutations.ts` needs no edit: its module patch is
  `propertyPatch(p, n, MODULE_PATCH_SKIP)`, which compares every key outside the skip set, and
  `formsInMenuAbove` is outside it. `formsInMenuAboveMutations.test.ts` holds that the diff carries
  the slot both ways.
- **After submit.** `lib/doc/mutations/modules.ts::reconcilePostSubmitWithMenuShape` already runs for
  every `updateModule`, whatever its patch names, over the module's forms and its submenus' forms. The
  three new reasons reach it through `postSubmitDestinationsOffered` and the default through
  `defaultPostSubmit`'s two new facts, with its existing rule: an explicit `module`, `parentMenu` or
  `previous` that left the offered set moves to the nearest offered (`firstMenu` here); an absent
  slot whose destination left takes the new default; an absent slot whose destination is still
  offered while the default moved is pinned to it. `moveModule` already reconciles the moved module.
- **The scoped gate.** `lib/doc/incrementalValidationScope.ts`: an `updateModule` whose patch names
  `formsInMenuAbove` takes the whole-document gate. For every other scoped batch, each touched module
  adds every contributor of `menuScreenOf` of that module, before and after the batch, with their
  forms, since one module's form types decide another's case-first answer. The first menu's shared
  case needs no addition: its rule is an app rule and runs on every scoped batch (section 5.5).
- **The registries.** `lib/domain/referenceSlots.ts` classifies `formsInMenuAbove` as `"config"` in
  `NON_REFERENCE_MODULE_PATHS`, its one module table, beside `hiddenFromMenu`. It holds no identity,
  so the reference index records nothing.
- **Dependents.** Turning the slot on while something opens the menu, or while the menu searches, is
  refused by the gate with section 5's sentences; no planner cascades. The builder shows the refusal
  beside the switch.

---

## 8. Preview and App Tests (A4)

### 8.1 Listing

`lib/preview/menuProjection.ts` gains `previewScreenEntries(doc: MenuScreenSource, screen:
MenuScreen): MenuScreenEntry[]`, a thin wrapper of `menuScreenEntries` that returns what it returns,
and `previewMenuModuleUuids` is removed with its callers moved
(`components/preview/screens/HomeScreen.tsx`, `ModuleScreen.tsx`, `CaseListScreen.tsx`,
`lib/preview/afterSubmitRouting.ts`, `lib/preview/app-tests/navigation.ts`). The home screen renders
the first menu's entries and a module screen its own, each entry by kind in the projection's order: a
menu tile as today, a form row as `ModuleScreen` renders a form today (its name, icon, spoken label and
display condition are the form's), a case list row from `previewCaseListMenuEntry`. In edit mode the
builder's authoring surfaces are unchanged: a menu that is above still opens as a container of its
forms.

### 8.2 Visibility

`inheritedModuleVisibility` changes its conjunction to section 4.2's: a module's own tile takes its
parent's visibility only where the parent keeps its own screen. A new
`previewContributorVisibility(doc: MenuScreenSource, own: ReadonlyMap<Uuid, NavigationItemVisibility>,
moduleUuid: Uuid): NavigationItemVisibility` takes the map of each module's own visibility that
`inheritedModuleVisibility` takes, and conjoins (`combineNavigationVisibility`, an absent module
reading `shown`) the entries of `conditionModulesOf(doc, moduleUuid)`. The screens
show a contributor's form and case list rows by it and then by each form's own condition.
`OFF_THE_MENU_SUMMARY` and the reveal affordance apply to a contributor's rows as to a tile.

Two more readers walk the structural parent chain today and read a module off the menu as taking
every child with it. Under a top-level menu that shows its forms above that is no longer so: a
submenu that keeps its screen lists on the first menu by its own condition alone (HQ conjoins the
parent's filter only for a submenu that is above, `menus.py::_generate_menu`). Both move to section
4.2's rule:

- `lib/preview/afterSubmitRouting.ts::afterSubmitTargetVisibility` judges a form target by
  `previewContributorVisibility` of its module and then the form's own condition, and a module target
  by its own tile's rule (the module, and its parent only where the parent keeps its screen). Where
  one is hidden, the Web Apps landing is the screen that would have listed it: `menuScreenOf` of a
  hidden form's module, `menuTileScreenOf` of a hidden module, each walked up while that screen's own
  tile is hidden, the first menu at the top. For a document without the slot this is today's "the
  menu above the topmost hidden module".
- `lib/preview/entryPointLaunch.ts::moduleIsUnderOffTheMenu` becomes `moduleEntriesOffTheMenu(doc:
  BlueprintDoc, moduleUuid: Uuid): boolean`: true where any module of `conditionModulesOf` holds
  `hiddenFromMenu`, or the module keeps its screen under a parent that keeps its screen and holds
  it. Its comment drops "takes its child modules off with it".

### 8.3 What a worker chooses first

`ModuleScreen` and `CaseListScreen` take `screenChoosesCaseFirst` for the screen they draw:

- **A case-first screen** opens on the host's case list, as today. After the case is chosen the screen
  lists every entry. A contributor's form opens with that case where `previewMenuCaseContext` gives it
  one: it already inherits a same-type structural parent's selection; from step 6 it also takes the
  host's selection as the parent case of a contributor whose parent case type is the host's, whichever
  module `parentCaseModuleUuid` names, because the wire gives both one datum id (section 4.3, rule 4).
- **Any other screen** lists its entries at once. A form that opens a case then opens its own menu's
  case list, as a form does today in a menu that is forms first (`lib/domain/navigation.ts::formLaunch`),
  whether or not its own menu alone would be case first.
- **A case list row** on a screen that is not case first opens the menu's case list; on a case-first
  screen choosing it is the selection (`previewCaseListMenuEntry`'s two actions, with `isCaseFirst`
  from the screen).

`previewAutomaticForm` (one shown form opens by itself after a case is chosen) counts the screen's form
rows.

### 8.4 Routes

A route that names a menu with no screen (a stored location, a typed URL) resolves to `menuScreenOf`
of that menu in the running app (`lib/preview/hooks/usePreviewScreenForLocation.ts`), with no message:
the worker sees the screen that lists its forms. A form route is unchanged. The breadcrumb of a form
in such a menu names the screen it lists on, never the menu.

### 8.5 After submit

`lib/preview/afterSubmitRouting.ts` reads frames through `previousTaskProjection.ts`, whose commands
now resolve to screens (section 6.3). A new helper there, `screenOfFrame`, turns a frame's commands and
selections into a landing: the last menu command's screen (the first menu where the frame holds none),
with the frame's selections applied to the menus that supply them
(`formLinkProjection.ts::entrySelectionDatumSources`), then the form the frame's form command names
where it has one:

```ts
/** Where a frame leaves a worker, read from the frame's own children. */
export interface FrameLanding {
	/** The screen of the frame's last menu command; the first menu where the frame holds none. */
	readonly screen: MenuScreen;
	/** The form the frame's form command names, where it has one. */
	readonly formUuid?: Uuid;
	/** The menus whose selection the frame carries, in frame order. */
	readonly selectingModuleUuids: readonly Uuid[];
}

export function screenOfFrame(
	ctx: FormLinkProjectionContext,
	children: readonly FrameChild[],
): FrameLanding;
```

`children` are a frame's children before matching (what `targetFrameChildren`,
`previousEntryFrameChildren`, `moduleDestinationFrameChildren`, `parentMenuDestinationFrameChildren`
and, from A5, a return frame's `target` hold), built under the same `ctx`. A command resolves through
`ctx.commandTargets`, as `previousTaskProjection.ts::projectPreviousTask` resolves one today: the last
command whose target holds no `formUuid` gives `screen` as `{ kind: "menu", moduleUuid }`, and a
command whose target holds one gives `formUuid`. `selectingModuleUuids` is, for each datum child that
requires a selection and holds no `query`, its `FrameDatum.selectionSourceModuleUuid`, the provenance
`entrySelectionDatumSources` reads. The caller applies its cases to those menus: a link its
`TargetCaseSelection`s, `previous` its retained selections, a Register return the created case
(section 11.5). A frame that holds no menu command lands on the first menu: the frame of a form
listed there, which goes on to that form (its own case list first where it opens a case), and
`firstMenu`'s empty frame. No frame of an admitted document holds a selection ahead of its first
command (section 6.3), so `screenOfFrame` never lands on the first menu with a chosen case to keep,
and `engine/previousTask.ts` and App Tests read the same landing. `module` is never offered in a menu
that is above, `parentMenu` never under one, and `previous` never to a form listed on the first menu.
In a submenu that shows its forms in a parent that keeps its screen, `previous` lands as section 6.3
says: on the parent's screen, with the case chosen where the frame carries the selection, or on the
form's own case list where the frame ends at the form's command. Both platforms land alike (read, not
run); run G2 is the check.

### 8.6 App Tests

`lib/preview/app-tests/navigation.ts::appTestMenus` and `appTestForms` list by the same projection, so
a journey may choose a form or a case list entry from the home screen or a parent menu where the
screen lists it; `lib/preview/app-tests/actions.ts` admits those choices on `home` and `menu` screens
by membership in `previewScreenEntries`. `RUNTIME_VERSION` stays 18: a journey pins its document, no
document saved before A4 holds the slot, and the runtime reads every such document as it did.

---

## 9. The builder (A4)

- **The control.** `components/builder/detail/moduleSettings/MenuScreenSection.tsx` (new), mounted by
  `ModuleSettingsPanel.tsx` directly under `MenuPlacementSection`: a `ToggleRow` that commits
  `setModuleFormsInMenuAboveMutation` through the `inline` flavor and shows the gate's refusal beside
  the switch (`lib/doc/hooks/useOfferedBatchRefusals.ts`, as `CaseListMenuItemSection` does), so a menu
  that is a link's target, holds an entry point or searches says why it stays as it is. It is never
  hidden.
- **Name, icon and spoken label.** `ModuleNameSection` and `ModuleAppearanceSection` keep their
  controls and show one note while the slot is set (copy below).
- **The tree.** `components/builder/appTree` shows a quiet second line on the menu's row,
  "Forms show in <above>", from `menuAbove`.
- **Display conditions.** `conditions/displayConditionCopy.ts`'s module carrier gains
  `formsInMenuAbove: boolean` and `aboveName: string`, and the form carrier's `caseFirst` is the
  screen's with its blocker; the copy arms are below. `useDisplayConditionCarrier.ts` fills them.
- **After submit and links.** `detail/formSettings/AfterSubmitSection.tsx` and the form-link target
  picker read `postSubmitDestinationsOffered` and `formLinkTargetChoices.ts`, so `Module`, `Parent
  menu` and `Previous screen` show disabled with the new reasons and a menu that is above is listed
  as not offered, with its forms offered. `lib/doc/formLinkTargetChoices.ts`'s unoffered arm gains
  `{ offered: false, reason: "forms-in-menu-above" }` beside its parent arm, and
  `{ offered: false, reason: "first-menu-shared-case", aboveModuleUuid }` for a target section 5.5
  refuses, which the picker shows disabled with that sentence.
- **Entry points.** The entry point controls on a menu that is above are disabled with the gate's
  sentence, and so is the control on a form, a submenu or a case list whose entry point section 5.5
  refuses (`lib/doc/entryPointReview.ts`).
- **Search and the case list workspace.** The Search panel's controls on such a menu are disabled with
  the `search` sentence; the workspace otherwise works as today, since the menu keeps its case list.
- **Offer parity.** `lib/doc/__tests__/platformOfferParity.test.ts` is unchanged (no platform row);
  the new offering sites are held by `menuAboveOffers.test.ts` (section "Tests").

---
## 10. What CommCare HQ does with `case_list_form`

### 10.1 The stored fields, with their lifecycle

`models/modules.py::CaseListForm`, a `SchemaProperty` of every module:

| Field | Lifecycle | Read by |
|---|---|---|
| `form_id` | alive | everything below; a blank `form_id` turns every other field off |
| `label` (by language) | alive | `app_strings.py::_create_case_list_form_app_strings`: the label's text (`clean_trans(label, langs)`), else "Create a new Case" (`gettext`; "Continue To <form name>" under `FOLLOWUP_FORMS_AS_CASE_LIST_FORM`), as `case_list_form.m<N>`. Nova always writes a label (the slot's, else the form's name), so HQ's fallback never applies to a Nova export |
| `media_image`, `media_audio` (by language), `use_default_*`, `custom_icons` | alive (`NavMenuItemMediaMixin`); the action is a `LocalizedAction` at every version Nova publishes to | `details.py::get_case_list_form_action`: the locales `case_list_form.m<N>.icon` and `.audio` |
| `post_form_workflow` | alive; `default` or `case_list` (`const.py::REGISTRATION_FORM_WORFLOWS`) | `workflow.py::CaseListFormWorkflow._get_stack_frames` |
| `relevancy_expression` | flag-gated: written to the action only under `FOLLOWUP_FORMS_AS_CASE_LIST_FORM` | `get_case_list_form_action` |

The editor is the Case List page's "Registration Form Accessible from Case List", shown while the
add-on `register_from_case_list` is on (`case_list_form_setting.html`). It offers every form of the app
for which `is_registration_form(<this menu's case type>)` holds, a label, an icon and audio, and "End
of Registration Action": "Go back to case list" (`case_list`) or "Proceed with registered case"
(`default`). Where the chosen form has its own end-of-form navigation the page hides that choice and
says "The case list form action will be the same as the selected form's end of form navigation"
(`module_view.js::caseListFormModel.formHasEOFNav`).

### 10.2 The action

`details.py::build_detail` adds the action to a module's short details (`detail_type.endswith('short')`,
so the case list and, where the menu has an ordinary search, the search results list) when
`case_list_form.form_id` is set and the module is not above; `features/case_tiles.py` adds it in a
tile, except the `person_simple` template, with no test of the menu's mode (the manifest's refused
row for a tile on a display-only menu). `add_register_action` writes it only where
`form.is_registration_form(module.case_type)` holds (or, under the toggle, the form is one of the
parent's follow-up forms). The action is `<action><display>` the label and its media `</display><stack>
<push>` the form's command, each datum of the form's entry (a computed datum by its function; a
selection datum by the session value of the host's first form's datum of the same case type, dropped
where none matches, `get_datums_for_action`), then `<datum id="return_to" value="'<menu id of the
host>'"/>`. It carries `relevant` only under the toggle. Because the short detail is shared, the action
shows wherever that list shows: before the host's forms, from the host's case list entry, and where
another menu chooses its parent case from the host's list.

`Form.is_registration_form(case_type)` is "exactly one registration action for the type", counted
over both kinds together: the form's `open_case` where the form's own menu has that case type, and
every subcase of that type outside a repeat (`Form.get_registration_actions`). So a registration form
that also creates a child of its own type at its root holds two and is no registration form to the
build (`validate_case_list_form` raises `case list form not registration`, `add_register_action`
writes no action, and `CaseListFormWorkflow.case_list_forms_frames` skips the host), and a form of
another type whose one root child case is of the list's type holds one and is. Section 11.3 refuses
the first and section 11.9 keeps the second for step 7. A Nova registration form has no selection
datum, also in a submenu (`entries.py::add_parent_datums` copies a parent's computed datums and
aligns only the child's own selections), so its action carries computed datums alone.

### 10.3 The return frames

`workflow.py::WorkflowHelper._get_stack_frames(form, module)`: the form's own end-of-form frames where
it has any (every workflow but `default`, and `form` with links); otherwise
`CaseListFormWorkflow.case_list_forms_frames(form)`, which builds, for each module whose
`case_list_form.form_id` is the form, in module order:

| Host's `post_form_workflow` | Frames, each `if` starting `count(S/return_to) = 1 and S/return_to = '<host menu id>'` |
|---|---|
| `case_list` | one frame: the host's frame children (its parent's first, then `get_frame_children(host)`), each selection matched to the form's datums by case type, stopping before the datum the new case satisfies |
| `default` | a frame with `and count(instance('casedb')/casedb/case[@case_id=S/<new case datum>]) > 0` holding every one of those children, the matched datum reading the new case's id; then a frame with `… = 0` holding the children up to that datum |

`S` is `instance('commcaresession')/session/data`; the new case datum is
`form.session_var_for_action('open_case')`, `case_id_new_<type>_0`. So `case_list` returns to the
host's screen with no case chosen, and `default` lands in the host's menu with the new case chosen,
or on the host's screen where the form's open condition created none. Nothing fires where `return_to`
is absent (decision 11). Two shapes follow from the frame and not from the value's name:

- The host's screen is its case list only where it chooses a case first (section 4.3). Where a
  submenu that shows its forms in the host holds a form that opens without a case, the screen lists
  forms first, and `case_list` returns there.
- A host with no forms has no common prefix (`_get_entries_datums` reads form entries alone), so its
  frame is its command and nothing more under either value: the worker returns to its list, and
  `default` carries no selection.

### 10.4 What HQ refuses or withdraws

| Rule | Source | Nova, from step 6 |
|---|---|---|
| the form is missing | `validators.py::validate_case_list_form`, `case list form missing` | `CASE_LIST_REGISTRATION_FORM_NOT_FOUND` |
| the form is no registration form of the host's type | the same, `case list form not registration` | `CASE_LIST_REGISTRATION_NOT_REGISTRATION` |
| the host shows its forms above | `views/modules.py::_case_list_form_not_allowed_reasons` (the editor withdraws it; the build writes no action) | `CASE_LIST_REGISTRATION_HOST_SHOWS_FORMS_ABOVE` |
| some form of the host needs no case | the same ("registration forms must go in a different case list") | `CASE_LIST_REGISTRATION_HOST_NOT_CASE_FIRST` |
| parent selection is configured | the same, only below CommCare 2.23 | none: Nova publishes at 2.57 and above |
| six rules of a host that is an advanced module | `validators.py::AdvancedModuleValidator.validate_with_raise` | `CASE_LIST_REGISTRATION_ADVANCED_MENU`; held in step 7 (section 11.9) |

### 10.5 Starter shapes

In each starter app the second menu (case first, basic, no search) offers the first menu's one
registration form, and that first menu shows its forms above: agriculture with label "Register New
Cooperative" and `default`; health with label "Register a new case", an icon and `case_list`; wash with
label "Register New Water Contract" and `default`. No named form has end-of-form navigation of its
own. wash also holds two blank-`form_id` blocks (section 14).

---

## 11. The `always` arm (A5)

### 11.1 Schema

`lib/domain/modules.ts`:

```ts
/** Where a worker goes after registering from the case list. */
export const CASE_LIST_REGISTRATION_RETURNS = ["case-list", "new-case"] as const;
export type CaseListRegistrationReturn = (typeof CASE_LIST_REGISTRATION_RETURNS)[number];

const afterEmptySearchRegistrationSchema = z.strictObject({
	kind: z.literal("after-empty-search"),
	/** A registration form of this module, on no menu. */
	formUuid: uuidSchema,
	label: z.string().min(1).optional(),
});

const alwaysOfferedRegistrationSchema = z.strictObject({
	kind: z.literal("always"),
	/** A registration form of this module's case type in another menu. It
	 *  stays on its own menu. */
	formUuid: uuidSchema,
	/** The Register action's label. Absent is the form's name. */
	label: z.string().min(1).optional(),
	/** The action's image. Web Apps shows the label alone. */
	icon: formIconRefSchema.optional(),
	/** The action's spoken label, played in audio-prompt mode. */
	audioLabel: mediaAssetIdSchema.optional(),
	/** Back to the list, or on to this menu with the new case chosen. Applies
	 *  while the form's own after-submit is Home (`caseListRegistrationReturnOf`). */
	afterSubmit: z.enum(CASE_LIST_REGISTRATION_RETURNS),
});

export const caseListRegistrationFormSchema = z.discriminatedUnion("kind", [
	afterEmptySearchRegistrationSchema,
	alwaysOfferedRegistrationSchema,
]);
export type AlwaysOfferedRegistration = z.infer<typeof alwaysOfferedRegistrationSchema>;
```

The icon is a form icon (`builtinIcons.ts::formIconRefSchema`, the action catalog: `register` and its
kin), since the action opens a form. `afterSubmit` is required: a stored arm always says where the
worker goes. Every stored `after-empty-search` arm parses unchanged. The module comment on
`caseListRegistrationForm` becomes "A registration form the module's case list offers: its own, on no
menu, after a search finds nothing; or another menu's, always."

### 11.2 Readers

`lib/domain/menuForms.ts`, from step 6:

| Reader | Meaning |
|---|---|
| `caseListRegistrationFormOf(doc, moduleUuid)` | renamed `afterEmptySearchRegistrationFormOf`; returns the slot's form only for the `after-empty-search` arm. Every caller keeps its meaning: the form that is on no menu |
| `alwaysOfferedRegistrationOf(doc, moduleUuid)` | the `always` arm, or undefined |
| `caseListsOffering(doc, formUuid)` | the modules whose `always` arm names the form, in `moduleOrder` |
| `offeredRegistrationFormOf(doc, moduleUuid)` | the slot's form under either arm, for the reference index, removal and the read tools |
| `caseListRegistrationReturnOf(doc, hostUuid)` | for an `always` host: `{ kind: "own" }` where the form holds links or `effectivePostSubmit` is not `app_home`; else `{ kind: "case-list" }` or `{ kind: "new-case" }` from the arm |

Each site that reads the slot today, and the reader it takes:

| Site | From step 6 |
|---|---|
| `menuForms.ts::menuFormUuidsOf`, `searchInputNameResolver`; `emissionPlan.ts::emissionPlan`; `expression/context.ts` (the form fact `caseListRegistrationForm`); `lib/doc/searchReadDependents.ts`; `lib/doc/incrementalValidationScope.ts`; `lib/doc/entryPointReview.ts`; `lib/commcare/entryPointProjection.ts`; `lib/domain/navigation.ts::formNavigation`; `validator/rules/form.ts` (`FORM_LINK_TARGET_CASE_LIST_REGISTRATION_FORM`, the post-submit exemption); `lib/doc/hooks/useModuleIds.ts`, `useOfferedBatchRefusals.ts`; `components/builder/case-list-config/caseListRegistrationReview.tsx`, `canvas/CaseListRegistrationSetting.tsx`, `detail/formSettings/FormEntrySection.tsx`, `NoMatchesAfterSubmitSection.tsx`; `lib/agent/tools/updateForm.ts`, `createForm.ts`, `lib/agent/authoring/formPreparation.ts` | `afterEmptySearchRegistrationFormOf`: unchanged behavior, the `always` arm is invisible to them |
| `lib/commcare/projectSpaceCompatibility.ts` (the capability "registration offered after an empty search") | `afterEmptySearchRegistrationFormOf`: the `always` arm writes no `relevancy_expression`, so it needs no toggle |
| `emissionPlan.ts::caseListFormLabelUnit`; `lib/domain/translationUnits.ts` (`case-list-registration-label`) | either arm: the slot's label, else the form's name |
| `lib/doc/mutations/forms.ts` (`removeForm`, `moveForm`); `lib/domain/referenceSlots.ts` | section 11.6 |
| `lib/agent/tools/getModule.ts`, `lib/agent/summarizeBlueprint.ts`, `scripts/inspect-app.ts` | either arm, with its kind (section 12) |
| `lib/preview/caseListRegistration.ts`; `components/preview/screens/CaseListScreen.tsx`, `FormScreen.tsx` | both, by arm (section 11.5): the existing admission and return read `afterEmptySearchRegistrationFormOf`, the new action and return read `alwaysOfferedRegistrationOf` |
| `lib/preview/app-tests/records.ts`, `run.ts`, `submission.ts`, `types.ts` | both, by arm (section 11.5): a records read offers the `always` arm's form with no search, and the journey carries the launch into the form |

### 11.3 Rules

`validator/rules/case-search/caseListRegistration.ts` holds two rules from A5:

- The module rule `caseListRegistrationForm` keeps the `after-empty-search` arm's
  `CASE_LIST_REGISTRATION_REQUIRES_FORMS_READ_SEARCH` and `CASE_LIST_REGISTRATION_HAS_NAVIGATION`,
  with their messages unchanged, and returns nothing for the `always` arm.
- One app rule, `caseListRegistrationApp(doc: BlueprintDoc): ValidationError[]`, in
  `rules/app.ts::APP_RULES` directly after `caseListRegistrationFormInModule`, emits every other
  finding of both arms: for the `after-empty-search` arm its
  `CASE_LIST_REGISTRATION_NOT_REGISTRATION` and `CASE_LIST_REGISTRATION_MULTIPLE_RETURN` checks,
  moved from the module rule with their conditions and messages unchanged, and for the `always` arm
  the table below. It is an app rule because the `always` arm reads a form in another module.

Every code the app rule emits joins `runner.ts::SCOPE_EXEMPT_CODES`: the four new ones and the two
existing ones it now owns whole. A code must come from one walk for the runner's law to hold
(`runValidation(doc, { scope })` equals the full run filtered by `errorWithinScope`): were the module
rule still to emit `NOT_REGISTRATION` for one arm while the code was exempt, a full run would keep an
out-of-scope module's finding that a scoped run never produces. The two moved findings now precede a
module's own findings in a run's order, on both sides of the law alike.

Every `always` finding sits at the host and carries `details.formUuid`, `formName` and
`kind: "always"`. All are `soundness`.

**One registration, for both arms.** `CASE_LIST_REGISTRATION_NOT_REGISTRATION` gains the reason
`several-registrations`, for either arm: the form is a registration form whose own case Case
Management registers, and `basicCaseSlots.ts::rootBasicSubcaseCreates(doc, formUuid)` holds a create
of the host's case type. That is HQ's count of two or more (section 10.2), where its build refuses
the app. A child of another type, a child inside a repeat and a child Save to Case holds are not
counted by HQ and are admitted. The `after-empty-search` arm's message: `Module "<host>" offers
"<form>" when a search finds nothing, but "<form>" registers more than one "<type>" case, and CommCare
HQ offers a form from a case list only where it registers one. You can move the other "<type>" case
into a repeat or to another form, or stop offering "<form>" there.` The `always` arm's is in the
table. `main` admits this shape for the `after-empty-search` arm today; A5 closes it there too, in the
rule it already edits.

| Code | When | Message |
|---|---|---|
| `CASE_LIST_REGISTRATION_FORM_NOT_FOUND` (new) | the form is in no module | `"<host>" offers a registration form on its case list, but that form is no longer in the app. You can choose another registration form, or stop offering one (register_from_case_list null).` |
| `CASE_LIST_REGISTRATION_NOT_REGISTRATION`, reason `form-type` | the form's type is not `registration` | `"<host>" offers "<form>" on its case list, so "<form>" needs to register a new "<type>" case, and it is a <form type> form. You can choose a registration form, or stop offering it there.` |
| the same, reason `case-type` | its menu's case type is not the host's | `"<host>" lists "<type>" cases and offers "<form>" on its case list, but "<form>" registers a "<form's type>" case in "<form's menu>". You can choose a form that registers a "<type>" case, or stop offering it there.` |
| the same, reason `own-case-save-to-case` | `registrationMintsOwnCaseId` is false | `"<host>" offers "<form>" on its case list, so CommCare HQ needs Case Management to register its new "<type>" case, and "<form>" saves that case through Save to Case. You can change the form's case so Case Management can hold it, or stop offering it there.` |
| the same, reason `several-registrations` | `rootBasicSubcaseCreates` holds a create of the host's case type (`details.operationUuid`, the first such) | `"<host>" offers "<form>" on its case list, but "<form>" registers more than one "<type>" case, and CommCare HQ offers a form from a case list only where it registers one. You can move the other "<type>" case into a repeat or to another form, or stop offering "<form>" there.` |
| the same, reason `after-empty-search-form` | the form is some module's `after-empty-search` form | `"<host>" offers "<form>" on its case list, but "<form>" opens only after a search finds nothing in "<its menu>", so it is on no menu to offer from. You can choose a registration form that is on a menu, or stop offering it there.` |
| `CASE_LIST_REGISTRATION_HOST_NOT_CASE_FIRST` (new), reason `no-case-type` | the host has no case type | `"<host>" offers "<form>" on its case list, but "<host>" has no case type, so it has no case list to offer it from. You can set its case type, or stop offering "<form>" there.` |
| the same, reason `form-opens-without-a-case` | a menu form of the host loads no case (`details.blockingFormUuid`) | `"<host>" offers "<form>" on its case list, but "<blocking form>" in "<host>" opens without a case, and CommCare HQ offers registration from a case list only where every form of the menu opens a case. You can move "<blocking form>" to another menu, or stop offering "<form>" on the list.` |
| `CASE_LIST_REGISTRATION_HOST_SHOWS_FORMS_ABOVE` (new), reason `host` | the host holds `formsInMenuAbove` | `"<host>" shows its forms in the menu above, and CommCare offers no Register on the case list of such a menu, so "<form>" would never be offered. You can give "<host>" its own screen again (forms_in_menu_above null), or stop offering "<form>" there.` |
| the same, reason `parent-shares-first-menu-case` | `frameLeadsWithSelection` holds for a frame of `caseListFormReturnFrames` (section 5.5): the host is a submenu of a top-level menu that shows its forms above, while every form above opens one chosen case (`details.aboveModuleUuid`) | `"<host>" is under "<parent>", which shows its forms on the app's first menu, where every form listed that way opens one chosen case. CommCare HQ would put that case ahead of "<host>" when a worker returns from "<form>". You can give "<parent>" its own screen again (forms_in_menu_above null), or stop offering "<form>" there.` |
| `CASE_LIST_REGISTRATION_MULTIPLE_RETURN` | the host selects several cases and `afterSubmit` is `new-case` (run G3 may lift it) | `"<form>" registers one case, but "<host>" selects several cases, and CommCare can't carry that one new case into a selection of several. You can set After registering to Back to this list (after_submit "case-list"), or let "<host>" select one case.` |
| `CASE_LIST_REGISTRATION_ADVANCED_MENU` (new), reason `host` | `emittedModuleKind(doc, host)` is `advanced` | `"<host>" is kept in CommCare HQ as an advanced menu, and Nova doesn't offer registration from an advanced menu's case list yet. You can stop offering "<form>" there.` |
| the same, reason `form` | the form's menu is emitted advanced | `"<form>" is in "<form's menu>", which CommCare HQ keeps as an advanced menu, and Nova doesn't offer a form of an advanced menu from a case list yet. You can choose a registration form in another menu, or stop offering it there.` |

`CASE_LIST_REGISTRATION_FORM_NOT_IN_MODULE` stays the `after-empty-search` arm's alone. A host under the
`host-not-case-first` rule has no registration form of its own, so the named form is always in another
menu. The named form may be off the menu, in a menu that is off the menu, or in a menu that shows its
forms above (the starter shape): the action's push opens an entry whatever its menu's condition
(`CommCareSession.performPushInner`), which is how the `after-empty-search` arm opens its form today.
A host may have a tile, a parent selection, an ordinary search, forms that read the search, or be a
submenu. `FORMS_IN_MENU_ABOVE_WITH_SEARCH` and this table together refuse both arms on a menu above.

### 11.4 The form keeps its own after-submit

The named form is an ordinary menu form: it may hold `postSubmit`, links, an otherwise, a display
condition, `hiddenFromMenu` and an entry point, and may be a link's target. Where its own after-submit
writes a frame (`caseListRegistrationReturnOf` gives `own`), HQ writes no return frame, so the worker
goes there from the list too. The arm's `afterSubmit` stays stored, is emitted as it is, and applies
again when the form's own after-submit returns to Home; the builder, the read tools and the summary
each say which is in force (section "Copy", section 12). This holds every shape HQ's page can save.

### 11.5 Emission and Preview

**HQ JSON** (`lib/commcare/expander.ts::expandDoc`): a host with the `always` arm writes

```ts
shell.case_list_form = {
	doc_type: "CaseListForm",
	form_id: <the form's HQ id>,
	label: localization.textMap(caseListFormLabelUnit(doc, hostUuid, formUuid)),
	post_form_workflow: slot.afterSubmit === "case-list" ? "case_list" : "default",
	media_image, media_audio,   // buildNavMediaDicts(slot.icon, slot.audioLabel, …), {} with none
};
```

and no `relevancy_expression`. No synthetic module is made: the form is emitted where it is.
`lib/commcare/types.ts`'s `case_list_form` gains optional `media_image` and `media_audio`;
`validator/hqJsonOracle.ts`'s `case_list_form` check already admits `default` and `case_list`.
`addOns.ts` already adds `register_from_case_list` for a set `form_id`.

**The local suite** (`lib/commcare/compiler.ts`):

- *The action.* `suite/case-list/shortDetail.ts::RegisterActionContext` keeps `commandId` and
  `datums` and becomes `{ readonly commandId: string; readonly datums: readonly { readonly id:
  string; readonly value: WireExpr }[]; readonly relevant?: WireExpr; readonly labelLocaleId: string;
  readonly icon?: FormIconRef; readonly audioLabel?: MediaAssetId }`, and
  `buildRegisterActionBlock` writes `<display>` holding the label's `<text>` and, where the arm holds
  them, `<text form="image">` and `<text form="audio">` over `case_list_form.m<H>.icon` and `.audio`.
  `navMenuMedia.ts` gains `buildActionDisplay(labelLocaleId: string, icon: IconRef | undefined,
  audioLabel: MediaAssetId | undefined, manifest: AssetManifest | undefined, where: string):
  NavMenuNode`, which always returns a `<display>` (an action has no bare `<text>` form), takes
  `labelLocaleId` as the media locale base too, and shares `buildNavMenuNode`'s media reading and its
  returned app strings. `relevant` is present only for the `after-empty-search` arm.
  `compiler.ts::registerActionFor(doc: BlueprintDoc, linkContext: FormLinkProjectionContext,
  hostModuleUuid: Uuid, target: { readonly moduleUuid: Uuid; readonly formUuid: Uuid }):
  RegisterActionContext` takes the host and the target in place of its `SyntheticModule` (the
  synthetic module for the one arm, the form's own module for the other), and its `commandId` is the
  target form's own command, `m<M>-f<K>`.
  The action is passed to the host's `m<H>_case_short` and, where the host has an ordinary search, to
  `m<H>_search_short`, in rows and in tiles, before the Search action. App strings gain
  `case_list_form.m<H>` and the media locales.
- *The return frames.* `formLinkProjection.ts` gains

  ```ts
  export interface CaseListFormReturnFrame {
  	readonly ifClause: WireExpr;
  	readonly children: MatchedChild[];
  	/** The frame's children before matching, cut where `children` is cut: what
  	 *  `screenOfFrame` reads (section 8.5). Never emitted. */
  	readonly target: readonly FrameChild[];
  }
  export function caseListFormReturnFrames(
  	doc: BlueprintDoc,
  	ctx: FormLinkProjectionContext,
  	hostUuid: Uuid,
  	/** The form's own new-case datum id, `case_id_new_<type>_0`: today's `sourceSessionVar`. */
  	newCaseId: string,
  	caseType: string,
  	afterSubmit: CaseListRegistrationReturn,
  ): readonly CaseListFormReturnFrame[];
  ```

  It returns one frame for `case-list` (today's `caseListFormReturnFrame`, kept as its body and
  called by the `after-empty-search` arm with `"case-list"`) and two for `new-case`, in this order:
  the first with the extra clause
  `count(instance('casedb')/casedb/case[@case_id = S/<new case datum>]) > 0` (built with
  `xpath/wire/rowScope.ts::caseById`) and every child, the matched selection reading the new case's
  id; the second with `… = 0` and the children up to it. `session.ts::deriveEntryDefinition`'s
  `returnFrame` becomes `returnFrames: readonly { readonly ifClause: WireExpr; readonly children:
  readonly MatchedChild[] }[]`, written in order after the entry's own workflow frames.
- *Where they go.* In the offered form's own entry, and only where `caseListRegistrationReturnOf`
  is not `own` for that form, so the entry holds no frame of its own: the frames of every host, in
  `caseListsOffering(doc, formUuid)` order. The `after-empty-search` form's entry is unchanged.

**Preview.** `lib/preview/caseListRegistration.ts`:

```ts
/** The Register action a case list offers, as the list draws it. */
export interface PreviewRegisterAction {
	readonly arm: "after-empty-search" | "always";
	/** The form the action opens, and the module that holds it (the host
	 *  itself for `after-empty-search`). */
	readonly formUuid: Uuid;
	readonly formModuleUuid: Uuid;
	/** The label's unit (`emissionPlan.ts::caseListFormLabelUnit`) and its
	 *  source text: the slot's `label`, else the form's name. */
	readonly labelUnitId: TranslationUnitId;
	readonly label: string;
	/** The `always` arm's media where the platform draws it; else undefined. */
	readonly icon: FormIconRef | undefined;
	readonly audioLabel: MediaAssetId | undefined;
}
export function previewRegisterAction(
	doc: BlueprintDoc,
	hostUuid: Uuid,
	platform: Platform,
): PreviewRegisterAction | undefined;

/** Where a worker lands after submitting a form the Register action of an
 *  `always` arm opened. Undefined is ordinary routing. */
export function alwaysOfferedRegistrationReturn(
	doc: BlueprintDoc,
	formUuid: Uuid,
	launch: PreviewCaseListRegistrationLaunch | undefined,
	createdCaseId: string | undefined,
): FrameLanding | undefined;
```

- `previewRegisterAction` returns what the list offers, undefined where the host holds no slot. The
  `after-empty-search` action shows under today's condition, which `CaseListScreen.tsx` keeps
  (`noMatchesActionAvailable(searchState)`); the `always` action shows whenever the host's list
  shows (before its forms, from its case list entry, as another menu's parent choice). The icon and
  spoken label are present on Android only, by a new field of
  `lib/preview/platform.ts::PreviewPlatformRules`, `caseListActionMedia: "shown" | "text-only"`
  (Android `shown`, `views/EntityActionViewUtils.java`; Web Apps `text-only`,
  `cloudcare/partials/case_list/list.html`). `CaseListScreen.tsx` draws the action from this one
  function.
- Choosing it opens the form with a launch marker on the session's case target,
  `PreviewCaseListRegistrationLaunch { readonly hostModuleUuid: Uuid }` (`lib/session/types.ts`,
  beside `PreviewSearchLaunch`, as `PreviewCaseTarget.caseListRegistrationLaunch?`; ephemeral, never
  stored).
- `alwaysOfferedRegistrationReturn` decides the landing after submit, and
  `FormScreen.dispatchAfterSubmit` and `lib/preview/app-tests/submission.ts` call it before ordinary
  routing. It returns undefined, which is ordinary routing, where there is no launch, where the
  launch's host no longer holds an `always` arm naming the form, or where
  `caseListRegistrationReturnOf` is `own`. Otherwise it never lands by the value's name: it builds
  `caseListFormReturnFrames` for the launch's host under `formLinkProjectionContext(doc, {
  entryMetadataOnly: true })`, takes the frame whose guard holds (the one frame for `case-list`; for
  `new-case` the first where `createdCaseId` is defined, else the second) and returns
  `afterSubmitRouting.ts::screenOfFrame(ctx, frame.target)`, as every other frame lands. The caller
  sets the host's selection to the created case where `selectingModuleUuids` holds the host, keeps
  the current selection of every other menu it holds, and clears the rest. So:
  - `case-list` lands on the host's screen with no case chosen: its case list where the screen
    chooses a case first, its forms where it lists forms first (a submenu that shows its forms in the
    host holds a form that opens without a case);
  - `new-case` with a created case lands on the host's screen with that case as its selection, so a
    case-first screen lists its forms for the new case; with none, as `case-list`;
  - a host with no forms (a bare case list) lands on its list under either value, since its frame is
    its command alone (section 10.3).
- The form opened any other way (its menu, a link, an entry point) is an ordinary form.

**App Tests.** A journey reaches the Register action as a worker does.
`lib/preview/app-tests/records.ts` returns the `always` arm's form as `registration` on every records
read of the host, with no search and no admission to pass (the `after-empty-search` arm keeps
`caseListRegistrationAdmission`); `run.ts` offers and admits the `form` action for it as it does
today's; the form screen of `types.ts` gains `caseListRegistrationLaunch?:
PreviewCaseListRegistrationLaunch`, set by that action alone; and `submission.ts` passes it to
`alwaysOfferedRegistrationReturn`. `RUNTIME_VERSION` stays 18: no journey saved before A5 holds the
field, and no document saved before it holds the arm.

Both platforms run it alike (read, not run; run G2 is the check), apart from the action's media
(section 13).

### 11.6 The doc layer

- **The payload.** The slot rides `updateModule.patch.caseListRegistrationForm` whole, as today, with
  `null` to clear. `lib/doc/alwaysOfferedRegistration.ts` (new) exports

  ```ts
  export type AlwaysOfferedRegistrationPlan =
  	| { readonly kind: "planned"; readonly mutations: Mutation[] }
  	/** The host holds the `after-empty-search` arm. `message` is the agent's
  	 *  sentence, `userMessage` the builder's. */
  	| { readonly kind: "blocked"; readonly message: string; readonly userMessage: string };
  export function alwaysOfferedRegistrationMutations(
  	doc: BlueprintDoc,
  	hostUuid: Uuid,
  	slot: AlwaysOfferedRegistration | null,
  ): AlwaysOfferedRegistrationPlan;

  export interface AlwaysOfferedRegistrationChoice {
  	readonly formUuid: Uuid;
  	readonly formName: string;
  	readonly moduleUuid: Uuid;
  	readonly moduleName: string;
  	/** The batch that would offer this form on the host. */
  	readonly mutations: readonly Mutation[];
  }
  export function alwaysOfferedRegistrationChoices(
  	doc: BlueprintDoc,
  	hostUuid: Uuid,
  ): readonly AlwaysOfferedRegistrationChoice[];
  ```

  `alwaysOfferedRegistrationMutations` plans one `updateModule` whose patch sets the slot whole, or
  `null`; clearing a host that holds no `always` arm plans no mutation. It is `blocked` where the
  host holds the `after-empty-search` arm, with `message` `"<host>" already offers "<form>" after a
  search finds nothing. You can stop offering that (case_list_registration null on update_form), and
  then offer a form on the list.` and `userMessage` the same sentence without the parenthesis.
  `alwaysOfferedRegistrationChoices` returns every registration form of the host's case type outside
  the host, in module then form order, each with its menu's name and the planner's batch for it
  under the host's stored label, media and `afterSubmit` (`case-list` on a first offer); it returns
  none where the planner is `blocked`. Whether the gate would admit a choice is read from that batch
  where the picker draws it, through `lib/doc/hooks/useOfferedBatchRefusals.ts` keyed by `formUuid`,
  as `CaseListMenuItemSection` reads its own.
- **Reducers.** `mutations/forms.ts::removeForm` deletes the slot from every module whose slot names
  the removed form (today: its own module's), so a replayed removal leaves no dangling identity.
  `moveForm` across modules deletes only an `after-empty-search` slot of the module the form leaves; an
  `always` arm follows its form by identity. `mutations/modules.ts::removeModule` deletes other
  modules' slots that name a removed form.
- **Dependents.** `lib/doc/caseListRegistrationDependents.ts` (new) has the shape of
  `formLinkDependents.ts` and takes its target type:

  ```ts
  export interface CaseListRegistrationDependent {
  	readonly hostModuleUuid: Uuid;
  	readonly hostModuleName: string;
  	readonly formUuid: Uuid;
  	readonly formName: string;
  }
  export type CaseListRegistrationDependentsPlan =
  	| { readonly kind: "none" }
  	| {
  			readonly kind: "blocked";
  			readonly dependents: readonly CaseListRegistrationDependent[];
  			readonly message: string;
  			readonly userMessage: string;
  	  };
  export function planCaseListRegistrationDependentsOnRemove(
  	doc: BlueprintDoc,
  	target: FormLinkRemovalTarget,
  ): CaseListRegistrationDependentsPlan;
  ```

  A dependent is a module outside the removed subtree whose `always` arm names a removed form, in
  `moduleOrder`. It refuses naming every one, `message` in the agent's voice and `userMessage` in
  the person's (copy below). `useBlueprintMutations.removeForm` and `removeModule` call it beside
  the link dependents and return its `userMessage` as they return the link planner's, and the tools
  `removeForm` and `removeModule` return `{ error: message }` as they do for a link. A form's type
  change, its move and its menu's case type change cascade nothing: the gate names the host with
  section 11.3's sentences.
- **The registries.** `referenceSlots.ts` keeps `caseListRegistrationForm.formUuid` (the index then
  records a host in another module as a referencer of the form, with no change), and classifies
  `caseListRegistrationForm.icon` and `.audioLabel` as `"media"` and `.afterSubmit` as `"config"`, in
  `NON_REFERENCE_MODULE_PATHS` beside the slot's `kind` and `label`.
- **Media.** `lib/domain/mediaRefs.ts::MediaRefLocation` gains two kinds,
  `case_list_registration_icon` and `case_list_registration_audio_label`, each `{ moduleUuid,
  moduleName }`, beside `case_list_icon` and `case_list_audio_label`. `walkAssetRefs`, the emitted
  walk the manifest, the export budget and `MEDIA_FORMAT_NOT_PLAYED` read, yields the arm's `icon`
  (where it is an asset, never a built-in slug) and `audioLabel` for a module whose `always` arm
  holds them, after the case list menu item's. `walkAuthoredAssetRefs`, the persistence walk, calls
  `walkAssetRefs` and inherits them, so attach verdicts and deletion guards cover them.
  `remapAssetRefs`, which a Project move uses, gains the arm beside its `caseListMenuItem` arm.
  `describeCarrier` gains "the Register button on <menu>'s case list" for both kinds, and
  `carriesViaBulkUpload` answers for them as it does for the case list menu item's.
- **The scoped gate.** A patch naming `caseListRegistrationForm` keeps taking the whole-document gate
  (`incrementalValidationScope.ts`, case `updateModule`), as today: the slot moves a form on or off
  the menu, which every link targeting the form reads. The `always` arm's rules are an app rule and
  run on every scoped batch, so a batch that touches a form or its module needs no addition for them.

### 11.7 The builder

- **The list's setting.** `components/builder/case-list-config/canvas/RegisterFromListSetting.tsx`
  (new), mounted in the Results canvas (`CaseListCanvas.tsx`) for a module with a case type: a form
  picker over `alwaysOfferedRegistrationChoices` (each unadmitted choice disabled with the gate's
  sentence), the button text, an icon and spoken label (`media/MediaSlot.tsx::SingleAssetSlot`, icon
  library `"form"`), and After registering as two choices. Every change commits the whole slot through
  `alwaysOfferedRegistrationMutations` on the `inline` flavor. A host the gate refuses altogether
  (above, under a menu that shares the first menu's case, not case first, advanced) shows the
  section disabled with that sentence, never hidden. While
  the host holds the `after-empty-search` arm the section says so and links to the Search canvas.
- **In force.** Under After registering, a note names the form's own destination where
  `caseListRegistrationReturnOf` is `own`, with a button that opens the form's After submit.
- **The form's side.** `FormEntrySection.tsx` gains a read-only row naming the lists that offer the
  form (`caseListsOffering`), each a link to that list's setting.
- **Platform note.** `shared/PlatformNoteRow.tsx` for the feature `case-list-registration-media`
  (section 13), shown while the arm holds media and Web Apps is declared.
- **Removal.** Removing an offered form shows the dependents refusal as the link refusal shows, in
  the "Change not applied" toast. `lib/doc/mutations/notify.ts::notifyRejectedCommit` gains an
  optional second argument, `action?: ToastAction` (`lib/ui/toastStore.ts`), which it passes to the
  toast, and `useBlueprintMutations.removeForm` and `removeModule` pass `{ label: "Stop offering
  it", onPress }` for this refusal alone. `onPress` commits, as one batch on the announcing flavor,
  the mutations of `alwaysOfferedRegistrationMutations(doc, hostUuid, null)` for every named host,
  so the refusal is no dead end. It does not go on to remove the form: the person removes it again.

### 11.8 Fields decided

| Field | Decision |
|---|---|
| `formUuid` | identity of the form; never a name or a module pair, so a moved form stays offered |
| `label` | optional, min 1; the translation role `case-list-registration-label` exists and serves both arms |
| `icon`, `audioLabel` | one image and one sound for every language, as every Nova menu label holds media; per-language media is step 7's `question-display` group for every carrier at once |
| `afterSubmit` | required; `case-list` or `new-case`; no third value, since Home is what the form's own after-submit means |

### 11.9 What stays step 7's, with the reason

| HQ shape | Stays, as | Why |
|---|---|---|
| a follow-up form of the parent case as the list's form | HELD-NEW, `menus` | exists only under the toggle `FOLLOWUP_FORMS_AS_CASE_LIST_FORM`, needs a parent selection, and admits only `case_list`; it is a third arm with its own rules, and no starter or plain app holds it |
| the action's display condition (`relevancy_expression`) | HELD-NEW, `menus` | HQ writes it only under that toggle, so an authored condition would make every app that uses it need a project-space flag; without the toggle it is inert and stays INERT |
| a host or a named form in an advanced menu | HELD-NEW, `menus` | HQ's six rules bind every form of the host to one case tag and one detail module, and an advanced form registers through `case_session_var`, a second return-frame source; each needs its own lane proof over `AdvancedModuleValidator` |
| a named form whose one registration of the list's type is a root child case: a follow-up form, or a registration form of another type, with one basic subcase of the type (`Form.get_registration_actions`) | HELD-NEW, `menus` | its action may carry a selection and its return reads a subcase datum (`session_var_for_action` of the subcase); Nova's arm names a registration form of the list's type (reason `case-type` refuses the rest), and the wider shape is a second arm |
| one form offered after an empty search by one list and always by another | HELD-NEW, `menus` | the form is on no menu and Preview admits it from one launch; no plain app holds it |
| `post_form_workflow: default` on the hidden-module shape (a host whose forms read the search) | HELD-NEW, `menus` | Nova's `after-empty-search` arm returns to Results showing the new case, which is `case_list`; `default` goes on into the host's menu with the new case chosen (`CaseListFormWorkflow._get_stack_frames`), a second return of that arm |
| a label that holds no text in any language, beside a `form_id` | HELD-NEW, `menus` | a device shows HQ's own "Create a new Case" (section 10.1), which Nova's arm cannot say: an absent `label` is the form's name, and a republish would change the button's text |
| a host under a top-level menu that shows its forms above, while every form above opens one chosen case | HELD-NEW, `menus` | section 5.6's second row |
| the case list menu item's media target for the tools | step 7, `menus` | step 7's outline at `main` (`7-rest-of-model.md`, group 3, "The case list menu item's media") places it there; this part adds the Register action's target alone, which the arm's two media slots need |
| a link to a mirror menu | step 7, `menus` | Nova has no mirror menus; the display-only half of that outline's bullet "Display-only and shadow menus as link targets" is settled here (section 5.1) |

---

## 12. The Solutions Architect and MCP

Both tools are shared operations (`lib/agent/sharedToolRegistry.ts`), so the builder's assistant and
MCP get the same input. No tool is added, so no `scripts/test-schema.ts` entry is added; `updateModule`
and `setMenuMedia` are registered entries whose schemas change, and `createForm` and `updateForm` are
registered entries whose description changes with `CASE_LIST_REGISTRATION_DESCRIPTION` (run G5).

**`lib/agent/tools/updateModule.ts`** (A4), a new input beside `hiddenFromMenu`:

```ts
forms_in_menu_above: z.literal(true).nullable().optional().describe(
	"true shows this module's forms, and its case list item, in the menu above with no entry for the " +
	"module itself: on the app's first menu for a top-level module, in its parent for a submenu. null " +
	"gives the module its own screen again, omission keeps it. A module that shows its forms above has " +
	"no screen of its own: it takes no search and no registration from its case list, no entry point " +
	"or case list entry point, and can be no after-submit link's target and no form's module " +
	"destination. A form listed on the app's first menu can't go to the previous screen after " +
	"submit. Its submenus show on the app's first menu. Its name and icon are kept and not shown.",
),
```

The tool's description becomes "Update a module's name, case type, parent-record selection,
visibility, where its forms show, whether its menu shows the case list as its own item, or the
registration its case list offers." (the last clause lands in A5). The result gains
`formsInMenuAbove?: boolean`. The empty-call check counts the new inputs.

**`updateModule`** (A5), a second new input, from `lib/agent/tools/shared/registerFromCaseList.ts`
(new, exporting `registerFromCaseListInputSchema` and `REGISTER_FROM_CASE_LIST_DESCRIPTION`):

```ts
export const registerFromCaseListInputSchema = z.strictObject({
	formUuid: uuidSchema.describe(
		"A registration form of this module's case type in another module. It stays on its own menu.",
	),
	label: z.string().min(1).nullable().optional().describe(
		'The button\'s text on the case list, such as "Register a new patient"; null or omitted uses ' +
		"the form name.",
	),
	after_submit: z.enum(CASE_LIST_REGISTRATION_RETURNS).optional().describe(
		'Where a worker goes after registering from the list: "case-list" returns to the list, ' +
		'"new-case" goes on to this module\'s forms for the new case. Omitted keeps the current ' +
		'choice, or uses "case-list" the first time.',
	),
});
```

`REGISTER_FROM_CASE_LIST_DESCRIPTION`: "Offers a registration form on this module's case list, so a
worker can look for a case and add one from the same screen. Every form of this module must open an
existing case. after_submit applies while the form's own after submit is Home; a form with its own
destination or links goes there from the list too. null stops offering it. Set the button's icon and
spoken label with set_menu_media, target case-list-registration. To offer a form only after a search
finds nothing, use case_list_registration on the form instead." The input is
`register_from_case_list: registerFromCaseListInputSchema.nullable().optional()`. The tool keeps the
arm's stored icon and spoken label across an update, plans through
`alwaysOfferedRegistrationMutations`, and returns `registerFromCaseList?: boolean`.

**`lib/agent/tools/media/setMenuMedia.ts`** (A5), a third arm of `items`:

```ts
const caseListRegistrationItemSchema = moduleAddressSchema.extend({
	target: z.literal("case-list-registration").describe("The Register button on a module's case list"),
	icon: nullableIconSlot(FORM_ICON_SLUGS,
		"The image on the Register button. Pass a built-in icon slug (one of the listed action icons, " +
		"e.g. register), OR the asset id of an uploaded image from list_media_assets, OR null to clear " +
		"it. Web Apps shows the button's text only."),
	audioLabel: nullableAssetSlot(
		"Asset id of the audio prompt played for the Register button's label, or null to clear it."),
}).strict();
```

An item whose module holds no `always` arm fails the batch: `items[<i>]: Module "<name>" offers no
registration form on its case list, so there is no Register button to set media on. You can offer one
with register_from_case_list on update_module.` The third arm resolves as the other two do, to one
`ResolvedMediaBatchItem` (`media/shared.ts`) for `commitMediaBatch`: its `mutations` are the one
`updateModule` of `alwaysOfferedRegistrationMutations` with the arm's two media slots replaced and
every other field kept, and its `expectations` one `MediaAttachExpectation` per slot that names an
asset, with the carrier phrase "the Register button on <module>'s case list".

Both of the tool's model-facing strings change, each written whole. The description: "Set or clear
icons and audio labels on module and form menu tiles and on a case list's Register button. Each item
sets BOTH slots of one tile or button (null clears; to keep a slot, pass back its stored value). Style
the whole menu in one call so the icons read coherently together." The `items` description: "The
tiles and buttons to set: module tiles (target: module), form tiles (target: form) and a case list's
Register button (target: case-list-registration), mixed freely."

**Reads.** `getModule` gains `formsInMenuAbove: boolean` and `listsOn: { kind: "first-menu" } | { kind:
"menu"; moduleUuid }`; its `caseListRegistrationForm` becomes `{ kind, formUuid, label, afterSubmit?,
followsFormAfterSubmit?, icon?, audioLabel? } | null` (`afterSubmit` and the three after it for the
`always` arm; `followsFormAfterSubmit` true where `caseListRegistrationReturnOf` is `own`); each form
gains `offeredOnCaseListsOf: Uuid[]` (`caseListsOffering`, empty where no list offers it).
`getForm`'s result gains `offeredOnCaseListsOf: Uuid[]` too. `summarizeBlueprint.ts` writes, on a
menu's line, `forms show in <above> (no screen of its own)` and `case list offers "<form>" (in
"<menu>"); after registering: back to the list | on with the new case | follows the form's own after
submit`. The tools `removeForm` and `removeModule` return `{ error }` holding the `message` of
`planCaseListRegistrationDependentsOnRemove` where it is `blocked`, asked after the link dependents
(section 11.6). The form tools' `CASE_LIST_REGISTRATION_DESCRIPTION` gains one closing sentence: "To
offer a form that stays on its own menu from a case list at any time, use register_from_case_list on
update_module."

**The guide** (`lib/agent/authoring/reference.ts`), two paragraphs in its menus section:

- A4: "A menu can show its forms in the menu above (forms_in_menu_above on update_module): a top-level
  menu's forms then show on the app's first menu and a submenu's in its parent, with no entry for the
  menu itself. Use it for one or two forms a worker should reach without opening a menu. Such a menu
  has no screen of its own, so it takes no search, no registration from its case list and no entry
  point, and can't be a link's target or a form's module destination. A form listed on the app's
  first menu isn't offered the previous screen after submit, so one that opens a case goes to the
  first menu by default. A worker chooses a form there before any case, unless every form on
  that screen opens the same case."
- A5: "A case list can offer a registration form from another menu at any time
  (register_from_case_list on update_module), so a worker looks for a case before adding one. The form
  stays on its own menu. After registering from the list the worker returns to the list or goes on
  with the new case. Use case_list_registration on the form instead when the form should open only
  after a search finds nothing."

**`MODEL_CONTEXT_VERSION`** moves in A4 and in A5, since each changes a served input and the guide
(`lib/agent/CLAUDE.md` binds the literal to every pull request that changes the name, the description
or the input schema of a tool the Solutions Architect is offered, or the guide). The scheme is one
distinct literal per pull request, in stack order. A4 sets `"v7-hq-round-trip-bring-in.a4"` and A5
`"v7-hq-round-trip-bring-in.a5"` (part 15, `15-stack-contracts-and-exit.md`, section 1.3). A10 moves
it to `.a10` only where its billed check forces a schema or description correction (part 15, section
13.2); otherwise stack A deploys `.a9`.
`lib/mcp/__tests__/servedSchemas.test.ts` compiles the changed schemas with no edit.
`../nova-plugin`: its skills are swept for "module" claims these two paragraphs make stale (the claim
that every menu has its own screen, and that registration from a case list needs a search); any edit
rides the plugin's one pull request for stack A.

---

## 13. Platform rows (A5)

Forms in the menu above and the `always` arm both read RUNS on Web Apps and on Android (section 2,
section 10), so neither adds a row, a refusal or a Preview cell.

The Register action's media reads differently: formplayer sends the action's image and audio
(`DisplayElement(Action, …)`) and the Web Apps client draws `action.text` alone
(`cloudcare/partials/case_list/list.html`); commcare-android draws the action's display data
(`views/EntityActionViewUtils.java`). So:

- `lib/domain/platforms.ts`: `PLATFORM_FEATURE_IDS` gains `"case-list-registration-media"`, and
  `PLATFORM_FEATURES["case-list-registration-media"] = { label: "Icon and spoken label on Register",
  channel: "structure", webApps: { reading: "ignored", note: "the button shows its text only" },
  android: { reading: "runs" } }`. No refusal copy: nothing is unavailable.
- `lib/domain/platformUses.ts`: a use at `caseListRegistrationForm.icon` for a module whose `always`
  arm holds an icon or a spoken label.
- `lib/commcare/surface/platformFeatureEntries.ts`: `"case-list-registration-media":
  ["menus-and-case-lists/case-list-form-media-image-media-audio"]`.
- `lib/preview/platform.ts`: `PreviewPlatformRules` gains `caseListActionMedia: "shown" |
  "text-only"` (section 11.5), the one place Preview holds the choice.
- `lib/preview/__tests__/platformCells.ts`:
  `"menus-and-case-lists/case-list-form-media-image-media-audio@web-apps": model("register-action-media")`,
  with the check `register-action-media` in `lib/preview/__tests__/platformCellModels.ts` (an
  existing file) driving `previewRegisterAction` on both platforms (no icon in Web Apps, the icon
  on Android).
- The guide's generated platform sentences gain the row's, which A5's version move covers.
- `content/docs/where-workers-use-your-app.mdx` gains the row's line (A11, section "Contracts").

---

## 14. The surface manifest

Each edit changes its row in `docs/research/2026-09-26-hq-round-trip/inventory/menus-and-case-lists.md`
in the same pull request; a new row sits beside the row it splits from. `owner` and `subject` are the
fields A2 adds (part 01, `01-the-bar-and-the-manifest.md`, sections 2.2 and 2.3); the subjects below
are members of its closed set: `display-only-forms` ("forms shown in the menu above their own"),
`case-list-registration` ("a form offered from the case list"), `display-conditions`, `deep-links`
and `search-setup`. `menus` and `case-search` are step 7 group ids (part 01, section 2.3;
`7-rest-of-model.md`).

**A4.**

| Entry | Edit |
|---|---|
| `menus-and-case-lists/put-in-root-display-only-forms` | HELD-NEW to HELD; cell "**HELD**: `Module.formsInMenuAbove`"; `slotChanges: []`; `subject` and `owner` leave with the disposition; value class, platforms and emission unchanged |
| `menus-and-case-lists/put-in-root-session-endpoint-id-or-inline-search-or-an-end-of` | stays REFUSED, subject `display-only-forms`: its three build errors are section 5's rules. It gains its lane reader (below) and leaves `KNOWN_GAPS` |
| `application-and-settings/menu-mode` (`entries/application-and-settings.json`) | stays INERT; emission cell "`true` when any module shows forms in its parent" becomes "`true` when any module shows its forms in the menu above" (a top-level menu has no parent) |

*The finding copy.* The flip leaves no entry under `display-only-forms` at `not-yet`, and part 01's
copy test holds the finding copy to the manifest both ways (part 01, section 2.6, A2). So A4 removes
that subject's `not-yet` sentence from `lib/publish/hqFindingCopy.ts::FINDING_COPY`; its `fix-in-hq`
sentence and the subject stay, for the four REFUSED entries. B4 adds a `not-yet` sentence back with
its own wording when it lands the two HELD-NEW reading rows below (part 07,
`07-the-reader-cases-menus-lists.md`, "Copy"). A5 empties no pair and changes no copy.

*The lane reader A4 must add.* The REFUSED sibling names the keys `schema:Module.put_in_root`,
`schema:AdvancedModule.put_in_root` and `schema:ShadowModule.put_in_root` with the value class
`true-beside-an-endpoint-inline-search-or-form-return`, and one of its two reasons is
`not-hq-editable`, so `manifest_usage.py::Entry.refused_by_hq_build` is false and the bar does not
take it. It is listed in `test_manifest_value_classes.py::KNOWN_GAPS`, so it has no reader, and
`_standing_plan` then holds every use of those keys `UNDECIDED` before the HELD entry is asked
(`_verdict` returns None for a class with no reader). Today that is no difference, because Nova
writes only `put_in_root: false`, HQ's default, which is no use. From A4 every document with a menu
above would report
`/schema:Module.put_in_root/undecided/true-beside-an-endpoint-inline-search-or-form-return`.
So A4 adds to `proof/checks/manifest_value_classes.py::VALUE_CLASSES` the reader
`put_in_root_beside_an_endpoint_inline_search_or_form_return`, keyed by the entry's id: true where the
use's module holds `put_in_root` and any of `session_endpoint_id`, inline search (`_inline_search`),
a form of its own whose `post_form_workflow` is `module`, a form of a submenu of it whose
`post_form_workflow` is `parent_module`, or a `form_links` entry anywhere in the app that names it by
`module_unique_id` with no `form_id`; false otherwise. A4 removes the id from `KNOWN_GAPS` and adds
the reader's shapes to `test_manifest_value_classes.py` (each of the five refused, and the starter
shape accepted).

**A5.** Write F for the five keys the `form_id` rows share: `schema:CaseListForm`,
`schema:CaseListForm.form_id`, `schema:Module.case_list_form`, `schema:AdvancedModule.case_list_form`
and `schema:ShadowModule.case_list_form`. Every new HELD-NEW and REFUSED row takes subject
`case-list-registration`; every new HELD-NEW row takes owner `menus`.

| Entry | Edit |
|---|---|
| `menus-and-case-lists/case-list-form-pointing-at-a-registration-form-in-another-module` | HELD-NEW to HELD; cell "**HELD**: `Module.caseListRegistrationForm { kind: \"always\" }`: a registration form of the list's type whose one case of that type Case Management registers, in a basic menu, offered by a basic menu whose forms all open a case"; `slotChanges: []` |
| `menus-and-case-lists/case-list-form-media-image-media-audio` | HELD-NEW to HELD; cell "**HELD**: the `always` arm's `icon` and `audioLabel`, one file for every language"; gains value class `beside-a-form-id`; platforms unchanged (IGNORED / RUNS) |
| `menus-and-case-lists/case-list-form-post-form-workflow-default-case-list` | stays HELD, value class `default-or-case-list` kept; cell "**HELD**: `case_list` for the `after-empty-search` arm; the `always` arm's `afterSubmit` (`case-list` is `case_list`, `new-case` is `default`), stored also where the form's own end-of-form navigation overrides it"; the `widen` leaves `slotChanges`, which is row 30 of part 04 (`04-names.md`), section 2.4 (A9) |
| new `menus-and-case-lists/case-list-form-post-form-workflow-default-on-the-hidden-module-shape` | HELD-NEW; key `schema:CaseListForm.post_form_workflow`; value class `default-on-the-hidden-module-shape`; cell "**HELD-NEW**: `default` beside a form in an always-hidden module of a host whose forms read the search: Nova's `after-empty-search` arm returns to Results, and `default` goes on with the new case chosen (`CaseListFormWorkflow._get_stack_frames`)". This is the standing of `default` on the `after-empty-search` arm that part 04 (section 2.4, row 30) asks of this part |
| new `menus-and-case-lists/case-list-form-post-form-workflow-default-on-a-multi-select-host` | REFUSED, `broken-at-runtime`, "the one new case cannot be carried into a selection of several"; key `schema:CaseListForm.post_form_workflow`; value class `default-on-a-multi-select-host`; lands unless run G3 gives outcome B |
| `menus-and-case-lists/case-list-form-label-lang` | stays HELD; cell "**HELD**: the registration's label on the case list where it holds text in some language: the slot's `label`, else the form's name (`emissionPlan.ts::caseListFormLabelUnit`)"; gains value class `with-text-beside-a-form-id` |
| new `menus-and-case-lists/case-list-form-label-empty` | HELD-NEW; key `schema:CaseListForm.label`; value class `no-text-beside-a-form-id`; cell "**HELD-NEW**: a label with no text in any language beside a `form_id`: a device shows HQ's \"Create a new Case\" (`app_strings.py::_create_case_list_form_app_strings`), which Nova's arm cannot hold" |
| new `menus-and-case-lists/case-list-form-fields-beside-a-blank-form-id` | INERT; keys `schema:CaseListForm.label`, `.post_form_workflow`, `.media_image`, `.media_audio`, `.relevancy_expression`; value class `beside-a-blank-form-id`; cell "**INERT**: every reader tests `form_id` first (`details.py`, `app_strings.py::_create_case_list_form_app_strings`, `FormBase.case_list_modules`, `hqmedia/models.py::ModuleMediaMixin`)"; platforms `not-applicable`; emission `omit` |
| new `menus-and-case-lists/case-list-form-on-an-advanced-module-or-naming-an-advanced-form` | HELD-NEW; keys F; value class `advanced-host-or-form` |
| new `menus-and-case-lists/case-list-form-pointing-at-a-form-whose-one-registration-of-the-type-is-a-child-case` | HELD-NEW; keys F; value class `form-registering-the-type-as-a-root-child-case`: a follow-up form, or a registration form of another type, with exactly one root subcase of the list's type (section 11.9) |
| new `menus-and-case-lists/case-list-form-naming-a-form-another-list-offers-after-an-empty-search` | HELD-NEW; keys F; value class `form-of-another-list-s-empty-search` |
| new `menus-and-case-lists/case-list-form-on-a-host-under-a-menu-that-shares-the-first-menu-s-case` | HELD-NEW; keys F; value class `host-under-a-display-only-parent-sharing-one-case` (section 5.6); leaves with decision 19 under run G6's outcome B |
| `menus-and-case-lists/case-list-form-pointing-at-a-follow-up-form-of-the-parent-case`, `menus-and-case-lists/case-list-form-relevancy-expression-with-followup-forms-as-case` | stay HELD-NEW; subject `case-list-registration` and owner `menus`, as part 01 assigns them (its Appendix A.1) |

A form with two registrations of the list's type (reason `several-registrations`) is no new row: HQ's
build refuses it, and the existing REFUSED
`menus-and-case-lists/case-list-form-missing-not-a-registration-form-toggle-off-or` names that
class.

*Census.* Part 01 (`01-the-bar-and-the-manifest.md`), section 2.2 (A2), counts
`case-list-registration` at 4 not-yet, 0 never, 2 fix-in-hq as A2 leaves it. After A5 it is 8, 0, 3:
two of the four flip to HELD, six HELD-NEW rows join (advanced, child case, another
list's empty search, `default` on the hidden-module shape, the empty label, a host under a menu that
shares the first menu's case), and one REFUSED row joins (the multi-select host). Run G3's outcome B
leaves the last out (8, 0, 2), and run G6's outcome B the host row (7, 0, 3). `display-only-forms`
goes from 1, 0, 4 to 0, 0, 4 at A4, and stack B's reading rows below add to it.

The lane already erases the narrowest blank block, a blank `form_id` beside a label holding no text, by
the spelling rule `case-list-form-unset` (`proof/rules/case_list_form_unset.py`), which stays. The new
INERT row is the wider class a rule cannot erase, because dropping it changes stored bytes: a blank
`form_id` beside a label with text, a workflow other than `default`, or media. wash holds it twice.

*Lane readers.* The lane reads REFUSED classes alone:
`test_manifest_value_classes.py::test_every_reader_reads_a_refused_entry_that_names_a_value_class`
holds every id of `VALUE_CLASSES` to a REFUSED entry, and `manifest_usage.py::_standing_plan` asks a
reader only of a refusing entry, holding every other use of a key an allowing entry names. So A5 adds
one reader, `default_on_multi_select_host`, for the one new REFUSED row (true where the module's
`case_list_form` holds a `form_id` and `post_form_workflow: default` and its short detail is
multi-select, `_multi_select`), with its refused and accepted shapes in
`test_manifest_value_classes.py`; `test_every_keyed_refused_class_has_a_reader_or_is_a_known_gap`
requires it. The INERT row and the HELD-NEW rows take value classes, which
`manifest.test.ts`'s `sharedClasses` needs wherever two entries claim one key, and no lane reader:
Nova's gate never emits their shapes, and a HELD-NEW class beside an allowing class on its key is
never judged by the lane. Which row a brought-in block falls in is the reader's rule, handed to B4
(part 07, `07-the-reader-cases-menus-lists.md`, section 8.7) in "What other parts read from this
one".

**Reading rows this part names for stack B**, which the pull request whose reader first claims them
adds (part 01, `01-the-bar-and-the-manifest.md`, section 3; part 15,
`15-stack-contracts-and-exit.md`, section 1.3). Part 07 (`07-the-reader-cases-menus-lists.md`),
section 14, lands the four of B4 and the one of B5 with the disposition, subject, owner and cell
given here, and gives each
the fields the schema needs beside them: its surface keys, its `item`, and for the two REFUSED rows
the lane readers `case_list_endpoint_on_a_put_in_root_module` and
`form_filter_reads_case_off_a_case_first_screen`. Section "What other parts read from this one"
hands them over.

| PR | Entry | Disposition |
|---|---|---|
| B4 | `menus-and-case-lists/case-list-session-endpoint-id-on-a-put-in-root-module` | REFUSED `broken-at-runtime`, subject `deep-links`, value class `on-a-put-in-root-module`: HQ builds the endpoint with no command for the menu, so it opens the menu above and never the list (effect 10) |
| B4 | `menus-and-case-lists/form-filter-reading-the-case-on-a-screen-that-chooses-no-case-first` | REFUSED `broken-at-runtime`, subject `display-conditions`, value class `case-read-off-a-case-first-screen`: a wider class than HQ's own build error (`CaseXPathValidationError`, effect 9; section 5.4) |
| B4 | `forms-and-case-writes/post-form-workflow-previous-screen-on-a-form-listed-on-the-first-menu` | HELD-NEW, owner `menus`, subject `display-only-forms`, value class `previous-screen-on-a-form-listed-on-the-first-menu` (section 5.6) |
| B4 | `forms-and-case-writes/form-link-or-endpoint-through-a-first-menu-that-shares-one-case` | HELD-NEW, owner `menus`, subject `display-only-forms`, value class `through-a-first-menu-that-shares-one-case`: a `form_links` entry or a `session_endpoint_id` whose frame HQ builds through the first menu while every form of every `put_in_root` module opens one chosen case (section 5.6); leaves with decision 19 under run G6's outcome B |
| B5 | `case-search/search-on-a-put-in-root-module` | HELD-NEW, owner `case-search`, subject `search-setup`, value class `on-a-put-in-root-module` (the search reader's row; part 07, sections 8.4 and 14). It is not inert: only the Search and Register actions test `put_in_root` (`details.py::DetailContributor.build_detail`). `entries.py::EntriesHelper.include_post_in_entry` still gives every form entry of a module that offers search its claim `<post>` while the project space syncs cases on form entry, and `remote_requests.py::RemoteRequestsHelper.update_suite` still writes the module's `<remote-request>`. Reading the search away and republishing would drop both. Nova's own gate refuses the shape (`FORMS_IN_MENU_ABOVE_WITH_SEARCH`), so the reader reports it and brings nothing in, and it adds no first-publish change for B7 (part 09, `09-acceptance-and-the-first-publish.md`, section 11) |

Between A4 and B4 the manifest holds these shapes more widely than the gate does: `previous` on a
form listed on the first menu and a frame through a first menu that shares one case stay under their
existing HELD entries (`forms-and-case-writes/post-form-workflow-previous-screen`,
`forms-and-case-writes/form-links-target-a-form-any-suite-form`,
`forms-and-case-writes/session-endpoint-id`) until B4 carves the rows above out of them. Nothing
reads the manifest that way before stack B: the gate keeps both shapes out of every Nova document,
so the lane meets no use of them, and no reader exists until B4, which adds the rows in the pull
request that first reads the keys.

---

## 15. Proof

**Targeted documents** (`proof/targeted/documents/`, registered in `proof/targeted/index.ts` and
`expected.ts`):

- `formsInMenuAbove.ts`, `targeted-forms-in-menu-above` (A4), both platforms: the starter shape and
  its neighbours, whose root prefix is empty. A top-level menu above holding one registration form, an
  icon and a display condition; a top-level menu above holding a follow-up form with no stored
  after-submit (its default there is `firstMenu`), a second follow-up form sent to Home, and its case
  list entry; an ordinary case-first menu between them with a link to the first follow-up form and a
  form entry point on it; a menu above that is off the menu, with a submenu that keeps its screen and
  so stays listed on the first menu.
- `formsInMenuAboveNested.ts`, `targeted-forms-in-menu-above-nested` (A4), both platforms: a case-first
  parent with a same-type submenu above (the screen stays case first) whose form reads the case in its
  display condition; under that parent, a second same-type submenu above whose only entry is its case
  list (the screen still stays case first, section 4.3); a second parent whose submenu above holds a
  registration form (the screen turns forms first); a submenu above that chooses a child case under
  the parent's case; conditions on a parent and its submenu above (the conjunction); a top-level menu
  above with one submenu that keeps its screen and one that is above; `previous` in a submenu above,
  for a follow-up form and for a registration form, `parentMenu` from a submenu that keeps its
  screen, and a link into each.
- `formsInMenuAbovePrefixes.ts` (A4), two documents, both platforms, one for each root prefix that is
  not empty (section 6.3). `targeted-forms-in-menu-above-registration-only`: one top-level menu above
  whose one form registers a case, an ordinary menu with a link to that form and a form entry point
  on it, so the frame opens with the computed datum ahead of the form's command.
  `targeted-forms-in-menu-above-one-case`: two top-level menus above of one case type holding
  follow-up forms alone, with their default after-submit and no link or entry point into them (the
  gate refuses those, section 5.5), which holds the menus, the entries and the `firstMenu` frames of
  the shape whose shared case is defined.
- `registerFromCaseList.ts`, `targeted-register-from-case-list` (A5), both platforms: the ten host
  scenarios of run G3 over one registration form per case type, the health shape among them (the form
  in a menu above, a label, an uploaded icon, `case-list`), one form offered by two lists, and one
  named form with its own after-submit.

**The native family** `menu-screens` (`proof/native/families.py`), in the lane. `FAMILIES` gains the
producer, and `CORE_CLASSES` gains `MenuScreensRuntimeTest` (A4) and `RegisterFromListRuntimeTest`
(A5), each naming `menu-screens`:

- `proof/native/producers/emit-menu-screens-evidence.ts` writes both exports of the five documents,
  and of the two documents the gate refuses that the family builds past it: run G6's (A4) and the
  two-registration form below (A5).
- `proof/native/test_menu_above_emission.py` (A4): for each scenario, every `<menu>`, every
  `<entry>/<stack>` and every `<endpoint>` HQ's contributors build equal Nova's, whole, with XPath
  carriers compared as HQ's parser's trees. It would catch a menu id, a `root` attribute, a locale id,
  a conjunction or a frame child Nova writes differently.
- `proof/native/core/MenuScreensRuntimeTest.java` (A4): over both paths, Core's `MenuLoader` lists each
  screen as `menuScreenEntries` says, in order, with each condition's effect; `getNeededData` after
  choosing each menu agrees with the screen's blocker as run G4 states it; each after-submit frame
  lands on the screen section 8.5 says; and run G6. It would catch a projection that disagrees with
  the runtime it stands for.
- `proof/native/test_register_from_list_emission.py` (A5): the `<detail>/<action>` of every short
  detail and the offered form's `<entry>/<stack>`, HQ's against Nova's, as
  `test_no_matches_emission.py` compares them; the health scenario includes the media locales. One
  negative control, built past the gate: a registration form that also creates a child of its own
  type at its root, offered from a list. HQ's `validate_case_list_form` must raise `case list form
  not registration` on it, which is the refusal `several-registrations` stands for.
- `proof/native/core/RegisterFromListRuntimeTest.java` (A5): run G3.

**The lane.** Proof 1 to 5 run over the five documents as over any targeted document (run G1, run
G2). `proof/corpus/editKinds.ts` gains two edit kinds for proof 5, `setFormsInMenuAbove` (on and off,
on a menu nothing opens) and `setAlwaysOfferedRegistration` (set, change `afterSubmit`, clear), each
built through this part's planners. The fuzz sample keeps its draws; the new shapes come from the
targeted documents and from the Vitest corpus below.

**Starter apps.** The three starter apps as HQ-authored bases are part 14's (`14-proof.md`, section
6.2, B13): `starter-agriculture`, `starter-health` and `starter-wash`, beside its base `hq-menus`
for the shapes of this part no starter holds. This part's contribution is that their menu shapes
are held: every `put_in_root` menu, each `case_list_form` with its label, icon and both workflows,
and the starters' blank blocks as inert.

---

## 16. The model-addition checklist, line by line

The sixteen places of step 5's checklist, for each addition. That checklist was section 6 of step 5's
`10-stack-contracts.md`, which #855 removed from the tree with that plan; the Place column below
names all sixteen.

| # | Place | Forms in the menu above (A4) | The `always` arm (A5) |
|---|---|---|---|
| 1 | Schema | `modules.ts::moduleSchema.formsInMenuAbove`; patch through `clearablePartialPatch`, no new mutation | `modules.ts::caseListRegistrationFormSchema` as a union; `CASE_LIST_REGISTRATION_RETURNS`; patch unchanged |
| 2 | Validator tables | `FORMS_IN_MENU_ABOVE_NOT_A_DESTINATION`, `FORMS_IN_MENU_ABOVE_WITH_SEARCH`, `FORM_LINK_TARGET_SHARES_FIRST_MENU_CASE` in `errors.ts`, `gate.ts`, `userFacingErrors.ts`, the last also in `SCOPE_EXEMPT_CODES`; the reason `first-menu-shared-case` of `ENTRY_POINT_INVALID`; three reasons in `postSubmit.ts`, `rules/form.ts`, `userFacingErrors.ts`, `form-links/shared.ts`, and two facts in `forms.ts::defaultPostSubmit`; three explanations of `FORM_DISPLAY_CONDITION_CASE_DATA_UNAVAILABLE` | `CASE_LIST_REGISTRATION_FORM_NOT_FOUND`, `_HOST_NOT_CASE_FIRST`, `_HOST_SHOWS_FORMS_ABOVE`, `_ADVANCED_MENU` in the three tables; those four and the existing `_NOT_REGISTRATION` and `_MULTIPLE_RETURN`, both arms' now emitted by the one app rule, in `SCOPE_EXEMPT_CODES`; the reason `several-registrations` on `_NOT_REGISTRATION` for both arms |
| 3 | Platform table and manifest | no row (RUNS / RUNS); one entry flips, its REFUSED sibling gains its lane reader, one cell is reworded, and one `not-yet` sentence leaves `lib/publish/hqFindingCopy.ts` (section 14) | `case-list-registration-media` with its entry binding and note; entries of section 14, one lane reader |
| 4 | Wire | `expander.ts` (`put_in_root`), `addOns.ts` (`menu_mode`), `compiler.ts` (the `<menu>`), `formLinkProjection.ts` (`menuIdOf`, the frame functions, `firstMenuSharedCase`, `frameLeadsWithSelection`), `navMenuMedia.ts`, `xpath/wire` (`w.paren`), `suiteOracle.ts`; `lib/commcare/CLAUDE.md` | `expander.ts` (`case_list_form`), `types.ts`, `compiler.ts` (`registerActionFor`, both short details), `shortDetail.ts`, `navMenuMedia.ts::buildActionDisplay`, `formLinkProjection.ts::caseListFormReturnFrames`, `session.ts` (`returnFrames`); `lib/commcare/CLAUDE.md` |
| 5 | Preview | `menuProjection.ts` (`previewScreenEntries`, visibility), the three screens, `afterSubmitRouting.ts` (`screenOfFrame`, `afterSubmitTargetVisibility`), `entryPointLaunch.ts`, the route resolver; no platform cell | `caseListRegistration.ts` (`previewRegisterAction`, `alwaysOfferedRegistrationReturn` over `screenOfFrame`), `CaseListScreen`, `FormScreen`, `lib/session/types.ts`, `lib/preview/platform.ts` (`caseListActionMedia`), App Tests (`records.ts`, `run.ts`, `types.ts`, `submission.ts`); one platform cell and its model check |
| 6 | Postgres | none: no case data, no submission change, no DDL | none: the registration submits as any registration form does |
| 7 | Index | none: the slot names no identity; `referenceSlots.ts` classifies it `config` | `caseListRegistrationForm.formUuid` already registered; `icon`, `audioLabel` as `media`, `afterSubmit` as `config`; `mediaRefs.ts` gains two `MediaRefLocation` kinds, walked by `walkAssetRefs` and remapped by `remapAssetRefs` |
| 8 | Builder cards and offering | `MenuScreenSection`, the tree line, the name and appearance notes, display-condition copy, After submit and link pickers, entry point and Search controls disabled with the gate's sentence | `RegisterFromListSetting`, the form's "offered on" row, the platform note, the removal refusal |
| 9 | SA and MCP | `updateModule.forms_in_menu_above`; `getModule`, the summary; the guide paragraph | `updateModule.register_from_case_list`; `setMenuMedia` target; `getModule`, `getForm`, the summary; the guide paragraph; the form tools' closing sentence |
| 10 | Public docs | `nested-menus.mdx`, `display-conditions.mdx`, `form-links.mdx`, `deep-links.mdx`, `mcp/tools.mdx` (A11) | `case-workspace.mdx`, `where-workers-use-your-app.mdx`, `mcp/tools.mdx` (A11) |
| 11 | Proof | four targeted documents, the `menu-screens` family's A4 half with its refused control, an edit kind, runs G1, G2, G4, G6 | one targeted document, the family's A5 half with its refused control, an edit kind, runs G1, G2, G3 |
| 12 | Existing documents | none: no stored document holds the slot, and every reader's answer for a document without it is unchanged (the G4 test and `menuScreens.test.ts` hold that) | every stored arm is `after-empty-search` and parses unchanged. One rule can newly refuse a stored document: `several-registrations`, where an `after-empty-search` form also creates a same-type child at its root, an app HQ's build already refuses. A5 carries a read-only scan for it (below) |
| 13 | `MODEL_CONTEXT_VERSION` | moves to `"v7-hq-round-trip-bring-in.a4"` (a served input and the guide) | moves to `"v7-hq-round-trip-bring-in.a5"` (two served inputs, the guide, a generated platform sentence) |
| 14 | The billed schema check | `updateModule` changed; asked once at A10, on the hash run's list (run G5) | `updateModule`, `setMenuMedia`, `createForm` and `updateForm` changed; asked once at A10, on the hash run's list (run G5) |
| 15 | Docs | `lib/domain/CLAUDE.md`, `lib/commcare/CLAUDE.md`, `lib/doc/CLAUDE.md`, `lib/preview/CLAUDE.md` and `components/builder/CLAUDE.md` in A4, by the rows of "Contracts"; `docs/architecture/complex-apps.md` in A11. `lib/agent/CLAUDE.md` needs no edit: its one sentence on domain behavior already names registration from the case list and states nothing either pull request makes false | the same five in A5; `complex-apps.md` in A11 |
| 16 | `../nova-plugin` | swept for the claim that every menu has its own screen | swept for the claim that registration from a case list needs a search |

`RUNTIME_VERSION` is no place of the checklist and does not move (section 8.6): the `always` arm, like
the slot, changes how the runtime reads no document saved before it.

**The scan (A5, row 12).** `scripts/scan-case-list-registration-registrations.ts`, read-only, over
every stored app: it lists each app with a module whose `caseListRegistrationForm` names a form for
which `rootBasicSubcaseCreates` holds a create of that module's case type. It runs against the local
database and, with the person's approval, against production (`--prod`) before A5 merges, which is
the one kind of production read this plan allows before a merge: a read-only scan the person
approves (part 15, `15-stack-contracts-and-exit.md`, section 5.3). It reads through
`scripts/lib/prodDb.ts` as the repo's inspectors do and prints app ids alone. It is read-only and
content-free, the person is asked first, each time, with what it reads and prints, and its output
is never committed.
- *None found* (expected: HQ's build refuses the shape, so no such app has published). Nothing more
  lands, and the script is removed in the last commit of A5's pull request, made after the run and
  before stack A merges.
- *Some found.* A5 does not merge while one stands, since a stored app the gate refuses stops at its
  next edit, and the deploy's runtime probe reruns the gate over every saved app
  (`lib/db/runtimeDatabaseProbe.ts`; part 15, section 5.3). Each is repaired where its author can
  see it: the author moves the second case into a repeat or another form in the builder. Or, with
  the person's yes for that app, the one-off repair below stops offering the form through the
  planner's own clear. The scan runs again until it finds none.

**The repair the scan can call for** (part 15, `15-stack-contracts-and-exit.md`, section 5.3, in
the same steps). It exists only on the "Some found" outcome and only for an app the person said yes
to. It writes a production document the one way the repository does, as #879 repaired choice
starting values (`scripts/lib/selectStartingValueRepair.ts::migrateSelectStartingValues`;
`docs/architecture/deployment.md`, "Historical repairs"), and it leaves no trace.

1. **The plan.** The scan, run with `--app <id> --out <path>`, writes that app's entry to a private
   file: the app id, its `mutation_seq`, the digest of the stored document, the module and the
   form, and the digest of the document after
   `lib/doc/caseListRegistrationForm.ts::caseListRegistrationMutations(doc, moduleUuid, formUuid,
   null)`, which leaves a valid app. The person reads it before anything is written.
2. **The writer.** `scripts/migrate-case-list-registration-registrations.ts` over
   `scripts/lib/caseListRegistrationRepair.ts` takes the reviewed plan (`--plan <path>` or
   `--plan-base64 <value>`) and is a dry run without `--execute`. For each app it locks the row,
   refuses an app a run or an unsettled reservation holds, refuses one whose sequence or digest
   moved since the plan, and commits one `blueprint-migration` row by the actor
   `system:case-list-registration-registrations` through
   `lib/db/apps.ts::appendSyntheticBatchInTransaction`, with the reason "Stopped offering a
   registration form after an empty search: the form opens two cases of the list's type, which
   CommCare HQ cannot build." A rerun finds the row by its batch id, verifies it and writes nothing.
3. **Where it runs.** Once locally, against the local database. Then once in production, before
   stack A merges, through the fenced Job runner in a maintenance image built from A5's head
   (`scripts/rollout/deploy-cloud-run.py --execute-job --job=commcare-nova-historical-repair`),
   under the migration Job's identity, with the service serving: the lease refusal is what keeps it
   off an app someone is building. No maintenance window is taken.
4. **What the author sees.** The app's change history (`app_changes`) holds the row with its
   reason. No notice row is written, as #879's repair wrote none: the person approves each app by
   id, and the app could not build in CommCare HQ as it stood.
5. **What is left.** Nothing. The last commit of A5's pull request, made after the run and before
   stack A merges, removes the scan script, the migrate script, the library and its Postgres test,
   the two bundle lines of the `Dockerfile`'s `maintenance-build` stage, the two arms of the Job
   runner (`scripts/rollout/deploy-cloud-run.py::_effective_execution_args`) with their cases in
   `scripts/infra/tests/test_deployment_policy.py`, and the paragraph of `deployment.md`. The stack
   merges by squash, so none of them lands on `main`, and the pull request's commits keep the
   record of what ran.

---
## Copy

Every string a person reads. `<above>` is "the app's first menu" or the parent's name; `<Above>` its
sentence-start form ("The app's first menu"). Builder sentences for the validator's findings are the
same sentences with the tool hints in parentheses removed, in `lib/doc/userFacingErrors.ts`.

**Module settings, `MenuScreenSection` (A4).**

| Where | Text |
|---|---|
| heading | Where its forms show |
| switch | Show its forms in the menu above |
| line, off, top-level | Workers open <menu> from the app's first menu, then choose a form. |
| line, off, submenu | Workers open <menu> from <parent>, then choose a form. |
| line, on | <menu>'s forms show in <above>, and <menu> has no entry of its own. |
| added, on, with a case list entry | Its case list entry shows there too. |
| added, on, top-level with submenus | Its submenus show on the app's first menu too. |
| added, on, where the screen is forms first by this menu | Workers choose a form in <above> before any case, because <blocking form> opens without one. |
| name and appearance sections, on | <menu>'s name, icon and spoken label aren't shown while its forms show in <above>. They're kept for when it has its own screen again. |
| tree row, second line | Forms show in <above> |

**Display conditions (A4).** For a menu that is above, the module carrier's `locus` is: "CommCare
checks this in <above>." and "While it's false, <menu>'s forms don't show there."; for a submenu, a
third line: "<parent>'s condition applies to them too." Its `offTheMenuNote` is "<menu>'s forms are off
<above>." followed by the existing sentence on what still opens a form. For a submenu that keeps its
screen under a top-level menu above, the `locus` names the app's first menu.

**After submit and links (A4).** Disabled choices read, in the picker: "Module: <menu> shows its forms
in the menu above, so it has no screen of its own.", "Parent menu: <parent> shows its forms in the
menu above, so it has no screen of its own." and "Previous screen: <menu> shows its forms on the app's
first menu, where Nova doesn't offer the previous screen yet." A menu that is above reads, in the link
target picker: "Shows its forms in the menu above. You can choose one of its forms." A target or an
entry point section 5.5 refuses reads: "Every form listed on the app's first menu from a menu like
<above menu> opens one chosen case, and CommCare would keep that case on the first menu. You can give
<above menu> its own screen again to use this."

**The case list's setting, `RegisterFromListSetting` (A5).**

| Where | Text |
|---|---|
| heading | Register from this list |
| lede | Offer a registration form on the case list, so workers can look for a case before adding a new one. |
| picker label | Form |
| picker, none | Don't offer one |
| picker option | <form> in <menu> |
| empty state | Once another menu has a registration form for <case type>, you can offer it here. |
| button text label | Button text |
| button text placeholder | <form's name> |
| media labels | Button icon; Spoken label |
| choice group label | After registering |
| choice one | Back to this list |
| choice one, helper | The worker returns to the list, where the new case now shows. |
| choice one, helper, where `screenChoosesCaseFirst(menuScreenOf(host))` is false and the host is no bare case list | The worker returns to <host>, where they choose a form. |
| choice two | Continue with the new case |
| choice two, helper | The worker goes on to this menu's forms for the case they registered. If the form registered no case, they return to the list. |
| choice two, helper, on a bare case list | This list has no forms to go on to, so the worker returns to the list. |
| note, the form's own after-submit in force | <form> has its own After submit (<destination>), so it goes there from this list too. You can set <form>'s After submit to Home to use the choice above. |
| note's button | Open <form>'s After submit |
| while the `after-empty-search` arm is set | This list already offers <form> when a search finds nothing. You can change that under When no cases match. |

**The form's side (A5).** `FormEntrySection` row: "Also offered on <host>'s case list" (two: "Also
offered on the case lists of <a> and <b>"; more: the same with a comma list).

**Removal (A5).** The person's sentence: "<form> is offered on <host>'s case list. You can stop
offering it there, and then remove it." (several hosts: "on the case lists of <a> and <b>"), with a
button on the refusal, "Stop offering it", that clears the arm on each named list in one gated batch.
The agent's: `Form "<form>" is the registration "<host>" offers from its case list
(register_from_case_list on update_module). You can set that to null on each menu that offers it, and
then remove the form.`

**The platform note (A5).** From the table: "Icon and spoken label on Register: in Web Apps the button
shows its text only."

Preview adds no string: the Register action's label is the arm's, and its refusal panel belongs to the
`after-empty-search` arm alone.

---

## Tests

Each test names its boundary and the failure it would catch (`docs/testing.md`). None is a DOM test in
Vitest. A file marked "(extended)" or "(existing)" is on `main`; every other file is new in the pull
request whose table names it.

**A4.**

| Test | Boundary | Catches |
|---|---|---|
| `lib/domain/__tests__/menuScreens.test.ts` | the production projection over documents built by `buildDoc` | an entry listed on the wrong screen or out of order; a tile for a menu with no screen; for a document without the slot, entries differing from today's (`moduleSiblingUuids` and `menuFormUuidsOf`); each blocker reason, the bare case list among them; a submenu above whose only entry is its case list turning a case-first screen forms first, or failing to where its list chooses another case |
| `lib/commcare/__tests__/screenCaseFirstParity.test.ts` | the domain answer against `entrySessionDatums` over the fuzz corpus and the targeted documents (run G4) | a screen Nova calls case first that Core would list forms on, or the reverse |
| `lib/commcare/__tests__/menuAboveEmission.test.ts` | both exports read back by `validateSuite`, `validateHqJson` and the XML parser; stacks compared with the entries of HQ's own fixture `suite-workflow-module-in-root.xml` for the same basic shape | a wrong menu id, `root`, locale, conjunction or add-on; a `previous` frame in a submenu above that differs from HQ's; over the `menu-screens` corpus, a frame of an admitted document with a selection ahead of its first command; a menu condition's instance declared anywhere but on its own `<menu>` |
| `lib/commcare/__tests__/suiteOracle.fuzz.test.ts` (extended), a second seeded corpus `menu-screens` (200 samples) from `lib/commcare/__tests__/menuScreenDocArbitrary.ts` (new), which draws the slot and, from A5, the `always` arm on gate-valid documents | every oracle of `compilerEvidence.ts` | an emitter that throws or writes an unresolvable command, locale or instance for an admitted document |
| `lib/commcare/validator/rules/__tests__/formsInMenuAbove.test.ts` | the commit gate (`mutationCommitVerdict`) over batches that turn the slot on | each refusal of section 5 missing, or firing on its admitted neighbour (a link to a form of the menu, the owner-only arm); for section 5.5, a link or an entry point admitted while every form above opens one case, or refused in the starter shape and the registration-only shape; taking the last registration form off the first menu admitted while a link into a form there stands |
| `lib/domain/__tests__/postSubmit.test.ts` (extended) | the offered set and `defaultPostSubmit` over every shape of the three new facts | `module` or `parentMenu` offered where HQ's build refuses it; `previous` offered to a form listed on the first menu; a default outside the offered set, the follow-up form of a submenu above that selects several cases among them (its default is `firstMenu`) |
| `lib/doc/__tests__/formsInMenuAboveMutations.test.ts` | the mutation applied through the gate, serialized and replayed | a clear that does not survive JSON; an explicit `module` or `previous` destination left stranded; an absent after-submit left unpinned where its destination is still offered and the default moved; a diff that drops the slot |
| `lib/doc/__tests__/incrementalValidationScope.test.ts` (extended) | scoped verdict against the whole-document verdict over the `menu-screens` corpus | a batch in one menu whose finding lands in another menu on the same screen and goes unseen |
| `lib/preview/__tests__/menuProjection.test.ts` (extended), `lib/preview/__tests__/afterSubmitScreens.test.ts` (new) | Preview's production models | a submenu tile hidden by an above parent's condition; a contributor's forms shown while the parent is off the menu; a frame landing on a menu with no screen; on Web Apps, a link to a form in a submenu that keeps its screen under a top-level menu above that is off the menu landing anywhere but on that form; an entry point into that submenu refused as off the menu |
| `lib/preview/app-tests/__tests__/journey.postgres.test.ts` (extended) | a journey over real Postgres | a form listed on the home screen that a journey cannot choose; a case chosen on a merged screen not reaching a submenu's form |
| `lib/agent/tools/__tests__/formsInMenuAboveTools.test.ts` | the shared tool through the workspace and the gate | an input the gate refuses with no sentence; a read that omits `listsOn` |
| `lib/doc/__tests__/menuAboveOffers.test.ts` | every offering site's verdict against the gate | a choice the builder offers that the gate then refuses |
| `e2e/tests/app/menu-above.spec.ts` | Playwright, the seeded builder | the switch missing or silent on refusal; Preview's home not listing the form in place |
| the `menu-screens` native family and runs G1, G2, G6 | CommCare's own code | section 15 |

**A5.**

| Test | Boundary | Catches |
|---|---|---|
| `lib/domain/__tests__/modules.test.ts` (extended), `lib/domain/__tests__/menuForms.test.ts` (new) | the schemas and readers | a stored `after-empty-search` arm that stops parsing; an `always` form dropped from its own menu; `caseListRegistrationReturnOf` wrong for a form with links |
| `lib/commcare/validator/rules/case-search/__tests__/caseListRegistration.test.ts` (extended) | the gate, whole and scoped | each row of section 11.3 missing or firing for the other arm; `several-registrations` missing for either arm (a form with a same-type root child), or firing for a child of another type, a child in a repeat or a child Save to Case holds; a scoped run and the filtered full run differing on a moved code |
| `lib/commcare/__tests__/registerFromListEmission.test.ts` | both exports through the oracles; the action and the two frame shapes compared with HQ's fixture `tests/data/case_list_form/case-list-form-suite.xml` | a synthetic module for the `always` arm; a missing action on the search results list; a frame that omits the created-case clause; the capability probe asked for the `always` arm |
| `lib/doc/__tests__/alwaysOfferedRegistration.test.ts` | planners and reducers through the gate and replay | a removed form leaving a dangling slot in another menu; a moved form losing its offer; an arm switch that silently replaces the other arm |
| `lib/domain/__tests__/multimediaCarriers.test.ts`, `lib/domain/__tests__/remapAssetRefs.test.ts`, `lib/media/__tests__/assetDeletion.test.ts` (each extended with the arm's two slots) | the production walker (`mediaRefs.ts`, which also remaps a moved app's references) and the deletion verdict | an asset used only as a Register icon or spoken label that the walk misses, so it is deleted while referenced, left behind by a Project move, or outside the export budget |
| `lib/preview/__tests__/caseListRegistration.test.ts` (extended) | Preview's models | the action missing from a parent-choice list; a `new-case` return with no created case landing in the menu; a return applied to a form opened from its menu; `case-list` landing on a case list where the host's screen lists forms first; `new-case` carrying a selection onto a bare case list |
| `lib/preview/app-tests/__tests__/journey.postgres.test.ts` (extended) | a journey over real Postgres | a journey that cannot choose the `always` arm's form from a records screen; Register then `new-case` not landing on the host with the created case; Register then `case-list` landing anywhere but where `screenOfFrame` says; the form opened from its own menu taking the return |
| `lib/preview/__tests__/platformCells.test.ts`, `lib/commcare/surface/__tests__/platformFeatures.test.ts` (existing) | the manifest binding | the new row without its cell or its entry |
| `lib/agent/tools/__tests__/registerFromCaseListTools.test.ts` | the shared tools through the gate | `after_submit` omitted on a first offer storing nothing; `setMenuMedia` writing media with no arm; an update dropping stored media |
| `e2e/tests/app/register-from-list.spec.ts` | Playwright | the setting missing from Results; Preview's Register not returning to the list with the new case |
| the family's A5 half and runs G1, G2, G3 | CommCare's own code | section 15 |

---

## Contracts and docs these changes make false

Each "today" was read in the file at `15a00a97`. Subtree `CLAUDE.md` edits land in the pull request
whose behavior makes them false; `docs/architecture/complex-apps.md` and the public docs land in A11.

| Where | Today | From step 6 | PR |
|---|---|---|---|
| `lib/commcare/CLAUDE.md`, "Ordinary nested menus" | "HQ JSON lowers a child to `root_module_id=<root unique_id>` while leaving `put_in_root=false` … Never conjoin the parent's filter, and never project this as `ShadowModule` or `put_in_root`." | "HQ JSON lowers a child to `root_module_id=<root unique_id>`, with `put_in_root` true exactly where the module shows its forms in the menu above (`Module.formsInMenuAbove`). The local suite writes each `<menu>` from `formLinkProjection.ts::menuIdOf`: its id, its `root`, its parent's name and the conjoined condition of a submenu that shows above (`compiler.ts`), as `id_strings.py::menu_id` and `menus.py::_generate_menu` do. No other menu's condition is conjoined, and nothing is projected as `ShadowModule`." | A4 |
| `lib/commcare/CLAUDE.md`, "After-submit links", "Frame children follow `WorkflowHelper.get_frame_children` exactly: module command → longest common prefix …" | as quoted | the same sentence, then: "The module command is the menu id (`menuIdOf`); where that is `root` there is none, and the prefix runs over every form of every menu that shows its forms above (`_root_module_datums`). The parent prepend drops a child whose id, a command's or a datum's, the parent part holds. No frame holds a selection ahead of its first command: `previous` is not offered to a form listed on the first menu, and a link, an entry point or a Register return whose frame would open with the first menu's shared case is refused (`firstMenuSharedCase`, `frameLeadsWithSelection`)." | A4 |
| `lib/commcare/CLAUDE.md`, "`post_submit` defaults" | "`lib/domain/forms.ts::defaultPostSubmit` takes the menu facts `formsReadSearch`, `multiSelect`, `parentMultiSelect` and `offTheMenu`" | "… takes the menu facts `formsReadSearch`, `multiSelect`, `parentMultiSelect`, `offTheMenu`, `formsInMenuAbove` and `formsOnFirstMenu`", and the sentence on what is unoffered gains "`module` in a menu that shows its forms above, `parentMenu` under one, and `previous` for a form listed on the first menu, which is Nova's own narrowing" | A4 |
| `lib/commcare/CLAUDE.md`, "Authored case-operation emission", and the header of `validator/rules/case-search/caseListRegistration.ts` | "it cannot be a menu's case list registration form (`CASE_LIST_REGISTRATION_NOT_REGISTRATION`, since HQ's build admits a case-list form only with `open_case` active, `FormBase.is_registration_form`)" | the same, then: "HQ counts `open_case` and every root subcase of the list's type and admits exactly one (`Form.get_registration_actions`), so a form that also creates a same-type child at its root is refused too (reason `several-registrations`), for both arms." The rule file's header also names the app rule that now emits both arms' `NOT_REGISTRATION` and `MULTIPLE_RETURN` | A5 |
| `lib/commcare/CLAUDE.md`, the hidden-module paragraph of the case list registration form | "`Module.caseListRegistrationForm` (`lib/domain/menuForms.ts::caseListRegistrationFormOf`) is Nova's whole authoring of CommCare's `case_list_form`"; "with the host command plus the `case_fixture` query child (`formLinkProjection.ts::caseListFormReturnFrame`)" | "`Module.caseListRegistrationForm` (`lib/domain/menuForms.ts::afterEmptySearchRegistrationFormOf` for the arm on no menu, `alwaysOfferedRegistrationOf` for the arm that stays on its menu) is Nova's whole authoring of CommCare's `case_list_form`"; the citation reads `formLinkProjection.ts::caseListFormReturnFrames`, and the paragraph gains: "The `always` arm writes the block for a form that stays on its own menu, with no synthetic module and no `relevancy_expression`, the Register action on both short details, and one return frame for `case-list` or two for `new-case`, only where the form's own after-submit is Home." | A5 |
| `lib/commcare/addOns.ts`, header comment | "`menu_mode`, `case_detail_overwrite` and `empty_case_lists` are never needed: Nova writes nothing that uses them." | "`case_detail_overwrite` and `empty_case_lists` are never needed: Nova writes nothing that uses them. `menu_mode` is needed where a module shows its forms in the menu above (`put_in_root`)." | A4 |
| `lib/domain/formLinkTargets.ts::menuTargetOffered`, comment | "Nova has no display-only-forms menu, so HQ's `put_in_root` exclusion has no input here." | "A menu that shows its forms in the menu above is never offered (HQ's `put_in_root` exclusion): it has no screen to open." | A4 |
| `lib/domain/CLAUDE.md`, "Forms and modules" | "`isCaseFirstModule` mirrors `commcare-core`'s `getDataNeededByAllEntries` exactly (a module lands on its case list only when every form is case-loading)" | the same, then: "for a module alone. Core asks the question of every entry a screen lists, so `menuScreens.ts::screenChoosesCaseFirst` is the answer wherever a case must be chosen before a form is listed, and `menuScreens.ts` is the one statement of which screen lists what." | A4 |
| `lib/domain/CLAUDE.md`, "Menus are one tier deep." paragraph | ends "… so every consumer can read the same flat sequence without repairing it." | adds: "A module holding `formsInMenuAbove` has no entry and no screen of its own: its forms and case list entry list in the menu above, and its name and media are kept and not shown." | A4 |
| `lib/domain/modules.ts`, the `hiddenFromMenu` comment | "A child module of a module off the menu is not itself off the menu, but no menu reaches it." | "A child module of a module off the menu is not itself off the menu, but no menu reaches it, unless that module shows its forms in the menu above: then a child that keeps its screen lists on the app's first menu by its own condition alone." | A4 |
| `lib/domain/CLAUDE.md`, "Forms and modules" | "`postSubmitDestinationsOffered(doc, formUuid)` is the ONE statement of what a form may go to, read from its module's shape (forms that read the search, several-case selection, its parent's selection, a bare case list, `hiddenFromMenu` on the module or its parent)" | the list gains "and whether the module or its parent shows its forms in the menu above, and whether its forms list on the app's first menu"; the next sentence, "`defaultPostSubmit(formType, shape)` is the form-type-aware default and is always offered", stands, now by the two facts of section 5.1 | A4 |
| `lib/domain/CLAUDE.md` | "A module's `caseListRegistrationForm` (`{ kind: "after-empty-search", formUuid, label? }`) names a registration form of the module offered on Results only after a search found nothing, on no menu at all (`caseListRegistrationFormOf`)." | "A module's `caseListRegistrationForm` has two arms. `{ kind: "after-empty-search", formUuid, label? }` names a registration form of the module offered on Results only after a search found nothing, on no menu at all (`afterEmptySearchRegistrationFormOf`). `{ kind: "always", formUuid, label?, icon?, audioLabel?, afterSubmit }` names a registration form of the module's case type in another menu, which stays on its menu and which the case list always offers (`alwaysOfferedRegistrationOf`, `caseListsOffering`); `caseListRegistrationReturnOf` says where a worker goes after registering from the list." | A5 |
| `lib/doc/CLAUDE.md` | "`updateModule.patch` carries the nullable `caseListRegistrationForm` slot, and `removeForm` and a cross-module `moveForm` delete it in the same reducer step where it names the form that leaves (a same-module reorder keeps it)." | "`updateModule.patch` carries the nullable `caseListRegistrationForm` slot. `removeForm` deletes it from every module whose slot names the removed form; a cross-module `moveForm` deletes an `after-empty-search` slot of the module the form leaves, and an `always` arm follows its form. `caseListRegistrationDependents.ts` refuses the removal of a form a case list offers, naming each list." | A5 |
| `lib/doc/CLAUDE.md`, `displayConditionMutations.ts` bullet | ends with the `hiddenFromMenu` writers | adds: "and `setModuleFormsInMenuAboveMutation`, which rides the same module patch and takes the whole-document gate." | A4 |
| `lib/doc/CLAUDE.md`, the `reconcilePostSubmitWithMenuShape` bullet | "`updateModule` (forms that read the search, the module's `hiddenFromMenu`, its case list registration form, a whole `caseListConfig`)" | "`updateModule` (forms that read the search, the module's `hiddenFromMenu`, whether it shows its forms in the menu above, its case list registration form, a whole `caseListConfig`)" | A4 |
| `lib/preview/CLAUDE.md`, the section on the case list registration form | describes one arm | gains a paragraph for the `always` arm from section 11.5, and a section "Menus that show their forms above" from section 8 | A4, A5 |
| `lib/preview/CLAUDE.md`, and the comment on `lib/preview/entryPointLaunch.ts::moduleIsUnderOffTheMenu` | "a module off the menu takes its child modules off with it, as on both runtimes"; "a target inside or under a module the menu hides … lands on the menu above the topmost hidden module: its shown parent's, or the app's first screen for a top-level module" | "a module off the menu takes its forms off with it, and its child modules too unless it shows its forms in the menu above, where a child that keeps its screen stays on the app's first menu by its own condition, as on both runtimes"; "a target the menu hides lands on the screen that would have listed it (`menuScreenOf` of a form's module, `menuTileScreenOf` of a module), walked up while that screen's own entry is hidden" (section 8.2) | A4 |
| `components/builder/CLAUDE.md` | "**When no cases match is one decision reachable from two places.**" (the one registration bullet) | unchanged, and two bullets added: "**Where a menu's forms show is one switch in module settings**" (section 9) and "**Register from this list is the Results canvas's setting**" (section 11.7) | A4, A5 |
| `lib/agent/tools/shared/caseListRegistration.ts`, `CASE_LIST_REGISTRATION_DESCRIPTION` | ends "It takes no links, otherwise, display condition or hiddenFromMenu." | adds the closing sentence of section 12 | A5 |
| `lib/commcare/types.ts`, the `case_list_form` comment | names the one arm | "The registration a case list offers (`Module.caseListRegistrationForm`, either arm); every other module keeps the blank block." | A5 |
| `docs/architecture/complex-apps.md`, nested menus | "Every module remains independently runnable with its own native Form or case list, and every Form still has exactly one owning module. Nova does not author linked forms, shadow modules, deeper menu trees, or HQ's unrelated `put_in_root` behavior." | "Every Form still has exactly one owning module. A module may show its forms in the menu above (`Module.formsInMenuAbove`, HQ's `put_in_root`): its forms list on that screen and it has none of its own. Nova does not author linked forms, shadow modules or deeper menu trees." With a new subsection "Forms in the menu above" holding section 2's table and section 4.3's rule | A11 |
| `docs/architecture/complex-apps.md`, "Register when nothing matches" | one arm, citing `lib/domain/menuForms.ts::caseListRegistrationFormOf` | the citation reads `afterEmptySearchRegistrationFormOf`, and a sibling subsection "Register from the case list" holds sections 10.2 to 10.4 and 11.4 | A11 |
| `content/docs/nested-menus.mdx` | no such section | a section "Show a menu's forms in the menu above": "A menu can show its forms in the menu above. You can turn on **Show its forms in the menu above** in the menu's settings, and its forms appear on the app's first menu, or in its parent menu for a submenu, with no entry for the menu itself. It suits one or two forms people should reach without opening a menu, such as a registration form on the first screen. The menu keeps its case type and case list, so each form still opens the right case. Such a menu has no screen of its own, so it can't have a search, a registration from its case list or a deep link, and a link or an after-submit destination can't open it; you can link and deep link to its forms. A form shown on the first menu returns to the first menu after it is sent, since there is no previous screen to offer there yet. Where every form shown on the first menu this way opens the same case, Nova asks you to give the menu its own screen before you link to one of those forms. On a screen that lists forms from more than one menu, people choose a case first only when every form there opens the same case; otherwise they choose a form first." | A11 |
| `content/docs/display-conditions.mdx` | no sentence on such a menu | "A menu that shows its forms in the menu above has no entry to hide, so its condition shows or hides its forms there. A submenu's forms also follow the parent menu's condition." | A11 |
| `content/docs/form-links.mdx`, "Which destinations a form is offered" | lists the reasons a destination is withheld | adds: "**Module** isn't offered in a menu that shows its forms in the menu above, and **Parent menu** isn't offered under one, because neither has a screen of its own. **Previous screen** isn't offered to a form shown on the app's first menu." | A11 |
| `content/docs/deep-links.mdx`, "Choose a destination" | menus, case lists and forms | adds: "A menu that shows its forms in the menu above takes no deep link of its own; link to one of its forms." | A11 |
| `content/docs/case-workspace.mdx`, after "Register when nothing matches" | no such section | a section "Register from the list": "A case list can offer a registration form at any time, so people look for a case before adding a new one. In Results, under **Register from this list**, choose a registration form from another menu. It stays on its own menu too. You can choose where people go after registering from the list: **Back to this list**, or **Continue with the new case**, which goes on to this menu's forms for it. Back to this list returns to the list, where the new case now shows, or to the menu's forms where people choose a form first there. A form that has its own After submit goes there instead. Nova offers this on a list whose menu's forms all open an existing case. In Nova's tools this is `register_from_case_list` on the menu." Under run G3's outcome C alone, one sentence follows "which goes on to this menu's forms for it.": "On a menu whose forms read the search, only **Back to this list** is offered." | A11 |
| `content/docs/where-workers-use-your-app.mdx` | no row | the row "Icon and spoken label on Register: in Web Apps the button shows its text only." | A11 |
| `content/docs/mcp/tools.mdx`, `update_module`, `get_module`, `set_menu_media` rows | as they stand | `update_module` gains "`forms_in_menu_above` (`true` shows its forms in the menu above with no entry for the module, `null` gives it its own screen again) and `register_from_case_list` (`{ formUuid, label?, after_submit? }` offers another menu's registration form on this module's case list, `null` stops)"; `get_module` gains "`formsInMenuAbove`, `listsOn`, and for `caseListRegistrationForm` its `kind`, `afterSubmit`, `followsFormAfterSubmit`, icon and audio label"; `set_menu_media` becomes "… on module home-screen tiles, form menu tiles and a case list's Register button (`target: case-list-registration`) …" | A11 |
| `docs/plans/hq-round-trip/7-rest-of-model.md`, group 3 | "mirror menus, "display only forms", badges …"; the bullets "*The other arms of `Module.caseListRegistrationForm`.*" and "*Display-only and shadow menus as link targets.*" | the rewrite of that file (this plan's own pull request) drops "display only forms" and the always-offered arm, keeps the rows of section 11.9 under `menus`, and keeps the shadow half of the second bullet | the plan's pull request |
| `proof/README.md`, "Native proofs" and the targeted document list | no `menu-screens` family | the family, its two controls built past the gate, and the five documents, each one line | A4, A5 |
| `lib/commcare/surface/entries/application-and-settings.json`, `application-and-settings/menu-mode`, emission cell | "`true` when any module shows forms in its parent" | "`true` when any module shows its forms in the menu above" | A4 |

---

## Departures

Departures from the outline, the research and the manifest, the places where Nova is stricter than
CommCare HQ, and the alternatives weighed and not taken, each with its evidence.

1. **The `always` arm names a narrower form than "any registration form of the case type in any
   menu".** Read at source: the form's own case must take Case Management's slot
   (`registrationMintsOwnCaseId`) and be the form's one registration of the type (HQ's
   `Form.is_registration_form` counts `open_case` and every root subcase of the type through
   `Form.get_registration_actions`, and requires exactly one), neither the host nor the form's menu
   may be emitted advanced, the host's forms must all open a case, and the form may not be another
   list's `after-empty-search` form. Evidence: `validators.py::validate_case_list_form`,
   `AdvancedModuleValidator.validate_with_raise`,
   `views/modules.py::_case_list_form_not_allowed_reasons`. The decision taken: section 11.3, with the
   wider shapes HELD-NEW under `menus` (section 11.9). Every starter shape is inside the narrow one.
   Not done: an arm that admits every registration form of the case type, because HQ's build refuses
   some of those shapes (section 10.4) and Nova cannot yet return from the others (section 11.9).
2. **`put_in_root` has eleven generated effects, and each is held.** Six show in HQ's menu, detail
   and frame builders (the menu id, the parent's filter conjoined, a submenu taking its parent's
   name, the case list losing its Register and Search actions, refused endpoints, inline search and
   links, changed end-of-form frames), and five more reach a document, a suite or a screen
   ("Executed during planning" numbers all eleven). The decision taken: each is a rule of sections
   4 to 6, and effect 11 (Core merging one id's menus) is the reason `screenChoosesCaseFirst`
   exists. Not done: rules for the first six alone, because each of the other five changes what a
   worker sees or where a frame lands.
3. **Stricter than HQ's build on one point.** A form's display condition that reads the case is
   admitted only where its screen chooses a case first (section 5.4); HQ's build admits it wherever the
   parent has the same case type and its own forms all need a case. Evidence: Core evaluates a
   command's condition when it lists the screen (`MenuLoader.addRelevantCommandEntries`), and lists it
   before any case whenever any entry of the screen needs something else first
   (`getDataNeededByAllEntries`), so such a condition reads no case and hides its form. For the reader
   this is a `fix-in-hq` finding (section 14's REFUSED row
   `menus-and-case-lists/form-filter-reading-the-case-on-a-screen-that-chooses-no-case-first`, landed
   by B4: part 07, `07-the-reader-cases-menus-lists.md`, section 14), never a silent difference.
4. **`MODEL_CONTEXT_VERSION` moves in A4 and A5.**
   `lib/agent/CLAUDE.md` binds it to every pull request that changes a served input or the guide, so
   A4 sets `"v7-hq-round-trip-bring-in.a4"` and A5 `"v7-hq-round-trip-bring-in.a5"` (section 12). A10
   keeps the billed check, and moves the literal only where that check forces a correction. Not
   done: one move at A10, beside the billed check, because that contract binds each pull request
   and not the stack.
5. **The outline, item 10, "Search and menus".** It reads `case_list_form` only into the
   `after-empty-search` arm. From this part the reader has two arms to choose between, and the rule is
   the manifest's: the hidden-module shape on a host whose forms read the search is the
   `after-empty-search` arm; a form that is on a menu, under section 11.3's rules, is the `always` arm
   (section "What other parts read from this one"). B4 builds it, in part 07
   (`07-the-reader-cases-menus-lists.md`), section 8.7.
6. **No document migrates; one read-only scan runs.** Neither concept changes a stored document.
   The reason `several-registrations` closes, for the `after-empty-search` arm too, a shape `main`
   admits and HQ's build refuses, so A5 carries the read-only scan of section 16 before it merges,
   which this plan allows as a read-only production read the person approves (part 15,
   `15-stack-contracts-and-exit.md`, section 5.3). Where the scan finds an app and
   the person says yes for it, that app is repaired once through a fenced Job, and nothing of the
   repair stays (section 16). A real defect found in review is
   fixed in the pull request that edits its rule, never left because `main` allows it.
7. **Stricter than HQ's page on `previous`.** HQ's form page offers `previous` in a menu that shows
   its forms above (`views/forms.py::get_form_view_context`), and the changed end-of-form frames are
   effect 6, which this part holds. Nova holds the frame in a submenu that shows its forms in
   a parent that keeps its screen, and does not offer `previous` to a form listed on the first menu.
   Evidence: `WorkflowHelper.get_frame_children` puts the root lists' common prefix ahead of the
   form's command; `EndOfFormNavigationWorkflow._get_static_stack_frame` pops the command and stops,
   so wherever every form above opens one chosen case the frame is that case and no command; Core
   then holds a collected case while asking for a command (`CommCareSession.getNeededData`,
   `syncState`), and Formplayer rebuilds from an empty session
   (`MenuSessionFactory.rebuildSessionFromFrame`). The frame is the previous screen only while the
   prefix is empty, and which of the two a form gets depends on every other menu above. The decision
   taken: sections 5.1 and 5.6, with the shape HELD-NEW under `menus`. No starter app holds it (every
   starter form's workflow is `default`).
8. **Stricter than HQ's build on frames through the first menu.** HQ builds a link, an endpoint and a
   case list form's return through the first menu with the shared case first wherever every form
   above opens one chosen case. Nova refuses each at its source (section 5.5). Evidence: Core's
   `stepBack` pops the form's command and stops where a command is needed, `syncState` keeps the
   frame's datum, and `getFirstMissingDatum` satisfies the next entry by datum id alone; commcare-
   android calls `stepBack` when a form opened from a menu is cancelled
   (`HomeScreenBaseActivity.java`). Read, not run: run G6 settles it in Core and may lift the rule.
   No starter app holds the shape (each shows a registration form above beside its follow-up forms,
   so its prefix is empty).

---

## Files by pull request

**A4, forms in the menu above.**

- New: `lib/domain/menuScreens.ts`; `lib/commcare/validator/rules/formsInMenuAbove.ts`;
  `components/builder/detail/moduleSettings/MenuScreenSection.tsx`;
  `proof/targeted/documents/formsInMenuAbove.ts`, `formsInMenuAboveNested.ts`,
  `formsInMenuAbovePrefixes.ts`;
  `proof/native/producers/emit-menu-screens-evidence.ts`, `proof/native/test_menu_above_emission.py`,
  `proof/native/core/MenuScreensRuntimeTest.java`; `lib/commcare/__tests__/menuScreenDocArbitrary.ts`.
- New tests: `lib/domain/__tests__/menuScreens.test.ts`,
  `lib/commcare/__tests__/screenCaseFirstParity.test.ts`,
  `lib/commcare/__tests__/menuAboveEmission.test.ts`,
  `lib/commcare/validator/rules/__tests__/formsInMenuAbove.test.ts`,
  `lib/doc/__tests__/formsInMenuAboveMutations.test.ts`, `lib/doc/__tests__/menuAboveOffers.test.ts`,
  `lib/preview/__tests__/afterSubmitScreens.test.ts`,
  `lib/agent/tools/__tests__/formsInMenuAboveTools.test.ts`, `e2e/tests/app/menu-above.spec.ts`.
- Extended tests: `lib/commcare/__tests__/suiteOracle.fuzz.test.ts`,
  `lib/domain/__tests__/postSubmit.test.ts`, `lib/doc/__tests__/incrementalValidationScope.test.ts`,
  `lib/preview/__tests__/menuProjection.test.ts`,
  `lib/preview/app-tests/__tests__/journey.postgres.test.ts`.
- Domain (`lib/domain/`): `modules.ts` (the slot, `moduleShowsFormsInMenuAbove`, the `hiddenFromMenu`
  comment), `index.ts` (barrel), `menuForms.ts` (exports `PreparedMenuForm`), `forms.ts`
  (`PostSubmitMenuShape`, `PostSubmitModuleFacts`, `defaultPostSubmit`), `postSubmit.ts`,
  `formLinkTargets.ts`, `navigation.ts`, `entryDatumSupplies.ts`, `expression/context.ts`,
  `referenceSlots.ts`.
- Wire (`lib/commcare/`): `expander.ts`, `addOns.ts`, `compiler.ts`, `formLinkProjection.ts`,
  `previousTaskProjection.ts`, `multimedia/navMenuMedia.ts`, `xpath/wire/builders.ts`,
  `xpath/wire/serialize.ts`, `xpath/wire/precedence.ts`, `validator/suiteOracle.ts`,
  `validator/errors.ts`, `validator/gate.ts`, `validator/runner.ts` (`SCOPE_EXEMPT_CODES`),
  `validator/rules/module.ts` (`MODULE_RULES`), `validator/rules/form.ts`, `validator/rules/app.ts`
  (`APP_RULES` and the `ENTRY_POINT_INVALID` reason), `validator/rules/displayConditions.ts`.
- Doc (`lib/doc/`): `displayConditionMutations.ts`, `incrementalValidationScope.ts`,
  `formLinkTargetChoices.ts`, `formLinkReview.ts`, `entryPointReview.ts`, `userFacingErrors.ts`,
  `hooks/useModuleIds.ts`. `mutations/modules.ts` and `diffDocsToMutations.ts` need no edit (section
  7).
- Preview: `lib/preview/menuProjection.ts`, `afterSubmitRouting.ts`, `entryPointLaunch.ts`,
  `hooks/usePreviewScreenForLocation.ts`, `app-tests/navigation.ts`, `app-tests/actions.ts`,
  `engine/postSubmissionEvaluation.ts`; `components/preview/screens/HomeScreen.tsx`,
  `ModuleScreen.tsx`, `CaseListScreen.tsx`, `FormScreen.tsx`.
- Builder (`components/builder/`): `detail/moduleSettings/ModuleSettingsPanel.tsx`,
  `ModuleNameSection.tsx`, `ModuleAppearanceSection.tsx`; `appTree/ModuleCard.tsx` (the module row's
  second line); `conditions/displayConditionCopy.ts`, `useDisplayConditionCarrier.ts`;
  `detail/formSettings/AfterSubmitSection.tsx`; `form-links/LinkTargetPicker.tsx`.
- Agent: `lib/agent/tools/updateModule.ts`, `getModule.ts`, `form-links/shared.ts`,
  `lib/agent/summarizeBlueprint.ts`, `lib/agent/authoring/reference.ts`; `lib/models.ts`
  (`"v7-hq-round-trip-bring-in.a4"`).
- Manifest and lane: `lib/commcare/surface/entries/menus-and-case-lists.json`,
  `entries/application-and-settings.json` (the `menu-mode` cell),
  `lib/publish/hqFindingCopy.ts` (the `display-only-forms` sentence at `not-yet` leaves, section 14),
  `docs/research/2026-09-26-hq-round-trip/inventory/menus-and-case-lists.md`,
  `proof/checks/manifest_value_classes.py` (the reader
  `put_in_root_beside_an_endpoint_inline_search_or_form_return`),
  `proof/checks/test_manifest_value_classes.py` (its shapes, and the id out of `KNOWN_GAPS`),
  `proof/targeted/index.ts`, `expected.ts`, `proof/native/families.py` (`FAMILIES`, `CORE_CLASSES`),
  `proof/corpus/editKinds.ts`, `proof/README.md`.
- Contracts: `lib/domain/CLAUDE.md`, `lib/commcare/CLAUDE.md`, `lib/doc/CLAUDE.md`,
  `lib/preview/CLAUDE.md`, `components/builder/CLAUDE.md`, each by its A4 rows of "Contracts".

**A5, registration from the case list, always offered** (on A4, and below A9: part 04, `04-names.md`,
section 11.4, removes `widen` from the schema once A5 has taken row 30's).

- New: `lib/doc/alwaysOfferedRegistration.ts`, `lib/doc/caseListRegistrationDependents.ts`;
  `lib/agent/tools/shared/registerFromCaseList.ts`;
  `components/builder/case-list-config/canvas/RegisterFromListSetting.tsx`;
  `proof/targeted/documents/registerFromCaseList.ts`;
  `proof/native/test_register_from_list_emission.py`,
  `proof/native/core/RegisterFromListRuntimeTest.java`;
  `scripts/scan-case-list-registration-registrations.ts` (removed in the last commit of A5's pull
  request, made after its run; section 16).
- Only where the scan finds an app and the person says yes for it (section 16, "The repair the scan
  can call for"): `scripts/migrate-case-list-registration-registrations.ts` with
  `scripts/lib/caseListRegistrationRepair.ts` and its Postgres test, the two bundle lines of the
  `Dockerfile`'s `maintenance-build` stage, the two arms of `scripts/rollout/deploy-cloud-run.py`
  with their cases in `scripts/infra/tests/test_deployment_policy.py`, and one paragraph of
  `docs/architecture/deployment.md`, "Historical repairs". Every one of them is removed in that
  same last commit, after the run.
- New tests: `lib/domain/__tests__/menuForms.test.ts`,
  `lib/commcare/__tests__/registerFromListEmission.test.ts`,
  `lib/doc/__tests__/alwaysOfferedRegistration.test.ts`,
  `lib/agent/tools/__tests__/registerFromCaseListTools.test.ts`,
  `e2e/tests/app/register-from-list.spec.ts`.
- Extended tests: `lib/domain/__tests__/modules.test.ts`,
  `lib/commcare/validator/rules/case-search/__tests__/caseListRegistration.test.ts`,
  `lib/domain/__tests__/multimediaCarriers.test.ts`, `lib/domain/__tests__/remapAssetRefs.test.ts`,
  `lib/media/__tests__/assetDeletion.test.ts`, `lib/preview/__tests__/caseListRegistration.test.ts`,
  `lib/preview/app-tests/__tests__/journey.postgres.test.ts`,
  `lib/commcare/__tests__/suiteOracle.fuzz.test.ts` with `menuScreenDocArbitrary.ts` (the arm joins
  the `menu-screens` corpus). `lib/preview/__tests__/platformCells.test.ts` and
  `lib/commcare/surface/__tests__/platformFeatures.test.ts` hold the new row with no edit.
- Domain (`lib/domain/`): `modules.ts` (the union), `menuForms.ts` (the four new readers and the
  rename), `navigation.ts` (the renamed reader), `mediaRefs.ts` (two `MediaRefLocation` kinds,
  `walkAssetRefs`, `remapAssetRefs`, `describeCarrier`, `carriesViaBulkUpload`), `referenceSlots.ts`,
  `platforms.ts`, `platformUses.ts`, `translationUnits.ts`.
- The other sites of section 11.2's first row. A one-name edit where the file calls the renamed
  reader (`caseListRegistrationFormOf` to `afterEmptySearchRegistrationFormOf`):
  `lib/commcare/entryPointProjection.ts`, `lib/doc/entryPointReview.ts`,
  `lib/doc/searchReadDependents.ts`, `lib/doc/hooks/useModuleIds.ts`,
  `lib/doc/hooks/useOfferedBatchRefusals.ts`, `lib/agent/tools/updateForm.ts`,
  `components/builder/case-list-config/caseListRegistrationReview.tsx`. A move to that reader where
  the file reads `Module.caseListRegistrationForm` itself, since a direct read of the union would
  take an `always` arm's form for the form on no menu: `lib/domain/expression/context.ts`,
  `lib/commcare/validator/rules/form.ts`, `lib/doc/caseListRegistrationForm.ts`,
  `lib/agent/authoring/formPreparation.ts`, `lib/agent/tools/createForm.ts`,
  `components/builder/case-list-config/canvas/CaseListRegistrationSetting.tsx`,
  `components/builder/detail/formSettings/NoMatchesAfterSubmitSection.tsx`.
- Wire (`lib/commcare/`): `expander.ts`, `types.ts`, `compiler.ts`, `emissionPlan.ts` (the renamed
  reader), `suite/case-list/shortDetail.ts`, `multimedia/navMenuMedia.ts`, `formLinkProjection.ts`,
  `session.ts`, `projectSpaceCompatibility.ts`, `validator/rules/case-search/caseListRegistration.ts`,
  `validator/rules/app.ts`, `validator/runner.ts`, `validator/errors.ts`, `validator/gate.ts`,
  `surface/platformFeatureEntries.ts`.
- Doc (`lib/doc/`): `mutations/forms.ts`, `mutations/modules.ts`, `mutations/notify.ts` (the toast's
  action), `incrementalValidationScope.ts` (the renamed reader), `userFacingErrors.ts`,
  `hooks/useBlueprintMutations.ts` (the dependents refusal and its button).
- Preview: `lib/preview/caseListRegistration.ts`, `lib/preview/platform.ts` (`caseListActionMedia`),
  `app-tests/records.ts`, `app-tests/run.ts`, `app-tests/types.ts`, `app-tests/submission.ts`,
  `lib/session/types.ts`, `components/preview/screens/CaseListScreen.tsx`, `FormScreen.tsx`,
  `lib/preview/__tests__/platformCells.ts`, `lib/preview/__tests__/platformCellModels.ts`.
- Builder (`components/builder/`): `case-list-config/canvas/CaseListCanvas.tsx`,
  `detail/formSettings/FormEntrySection.tsx`. The "Stop offering it" button is the toast action of
  `lib/doc/mutations/notify.ts`, set in `useBlueprintMutations.ts` (section 11.7), and needs no
  component.
- Agent: `lib/agent/tools/updateModule.ts`, `media/setMenuMedia.ts`, `getModule.ts`, `getForm.ts`,
  `removeForm.ts`, `removeModule.ts`, `shared/caseListRegistration.ts`,
  `lib/agent/summarizeBlueprint.ts`, `lib/agent/authoring/reference.ts`; `lib/models.ts`
  (`"v7-hq-round-trip-bring-in.a5"`); `scripts/inspect-app.ts`.
- Manifest and lane: the entries of section 14 in
  `lib/commcare/surface/entries/menus-and-case-lists.json` and their rows in
  `docs/research/2026-09-26-hq-round-trip/inventory/menus-and-case-lists.md`,
  `proof/checks/manifest_value_classes.py` (the one reader `default_on_multi_select_host`),
  `proof/checks/test_manifest_value_classes.py`, `proof/targeted/index.ts`, `expected.ts`,
  `proof/native/families.py` (`CORE_CLASSES`),
  `proof/native/producers/emit-menu-screens-evidence.ts`, `proof/corpus/editKinds.ts`,
  `proof/README.md`.
- Contracts: the same five `CLAUDE.md` files, each by its A5 rows of "Contracts".

A10 (run G5, and a corrected guide or schema with `.a10` only where that check forces one) and A11
(`docs/architecture/complex-apps.md`, `content/docs/*`) carry this part's lines as "Contracts" assigns
them; part 15 (`15-stack-contracts-and-exit.md`) plans both.

---

## What this part needs of other parts

Each line below is what this part takes from another part, as that part states it; the line of
part 15 (`15-stack-contracts-and-exit.md`) is what this part hands the stack.

- **Part 01 (`01-the-bar-and-the-manifest.md`; A2).** Settled there, and used here as written:
  `subject` on every HELD-NEW and REFUSED entry (its section 2.2) and `owner` on every HELD-NEW
  entry (its section 2.3); the subjects `case-list-registration` and `display-only-forms` (with
  `display-conditions`, `deep-links` and `search-setup` for the reading rows), each with its sentence
  per standing (its section 9.2); and `menus` and `case-search` as owners. Its section 3.8 assigns
  `menus-and-case-lists/put-in-root-display-only-forms` to A4 and the two `case_list_form` flips to
  A5, as here. Its section 2.6 has A4 remove the `display-only-forms` sentence at `not-yet` with the
  flip that empties the pair, as section 14 here plans. Its section 2.2 gives A5's eight HELD-NEW
  entries and its one new REFUSED entry the subject `case-list-registration`, and its Appendix A.3
  holds this part's new entry ids, read from "What other parts read from this one". A2 lands before
  A4, so every entry of section 14 is written in the new schema.
- **Part 04 (`04-names.md`; A9).** Row 30 of its section 2.4 hands this part the widen on
  `menus-and-case-lists/case-list-form-post-form-workflow-default-case-list` and asks for the
  standing of `default` on the `after-empty-search` arm: A5 removes the widen and adds the HELD-NEW
  row of section 14. Its section 11.4 takes `widen` out of the manifest schema in A9, which holds
  because A5 stands beneath A9 in stack A.
- **Part 07 (`07-the-reader-cases-menus-lists.md`; B4, B5).** Its section 14 lands the five reading
  rows section 14 here names, with their surface keys, items and the two lane readers. Its section
  8.4 reads `put_in_root` and its section 8.7 reads `case_list_form`, each by the rules of "What
  other parts read from this one". Its "Copy" words the `display-only-forms` sentence at `not-yet`
  that B4 adds back.
- **Part 14 (`14-proof.md`; A1, B13).** A1 (lane groundwork): a native family is registered by a
  producer in `FAMILIES` and its Core classes in `CORE_CLASSES` (`proof/native/families.py`), as
  today; A1 changes neither. Its section 11.1 holds A4's and A5's lane lines as section 15 here
  gives them. B13: its section 6.2 holds the starter apps as bases (`starter-agriculture`,
  `starter-health`, `starter-wash`) beside its base `hq-menus`, whose menu shapes this part makes
  holdable.
- **Part 15 (`15-stack-contracts-and-exit.md`).** A4 precedes A5 in stack A, both follow A2, and A5
  stands beneath A9. `MODEL_CONTEXT_VERSION` moves in A4 and in A5 (section 12). A4 sets
  `"v7-hq-round-trip-bring-in.a4"` and A5 `"v7-hq-round-trip-bring-in.a5"` (its section 1.3). A10
  moves it to `.a10` only where its billed check forces a schema or description correction (its
  section 13.2); otherwise stack A deploys `.a9`. A10 asks the stack's one billed question over the hash
  run's list, on which this part expects `updateModule`, `setMenuMedia`, `createForm` and
  `updateForm` (run G5), and leaves the two guide paragraphs of section 12 as A4 and A5 landed
  them. A11 lands the public sentences and the two `complex-apps.md` subsections of "Contracts".
  The pull request for this plan rewrites `7-rest-of-model.md` with the rows of sections 5.6 and
  11.9 under `menus`.

## What other parts read from this one

- **Slots and types**: `Module.formsInMenuAbove`; `caseListRegistrationFormSchema` as a union with the
  arm `{ kind: "always", formUuid, label?, icon?, audioLabel?, afterSubmit }`;
  `CASE_LIST_REGISTRATION_RETURNS`, `CaseListRegistrationReturn`, `AlwaysOfferedRegistration`.
- **Functions**: `lib/domain/menuScreens.ts` (`MenuScreenSource`, `MenuScreen`, `MenuScreenEntry`,
  `ScreenCaseFirstBlocker`, `menuScreenKey`, `menuScreenOf`, `menuTileScreenOf`,
  `menuScreenContributors`, `menuScreenEntries`, `conditionModulesOf`, `menuAbove`,
  `moduleHasOwnScreen`, `screenChoosesCaseFirst`, `screenCaseFirstBlocker`, `screenIsBareCaseList`);
  `moduleShowsFormsInMenuAbove`; `menuForms.ts` (`afterEmptySearchRegistrationFormOf`,
  `alwaysOfferedRegistrationOf`, `caseListsOffering`, `offeredRegistrationFormOf`,
  `caseListRegistrationReturnOf`); `forms.ts` (`PostSubmitMenuShape.formsInMenuAbove` and
  `.formsOnFirstMenu`, `PostSubmitModuleFacts.parentFormsInMenuAbove`, read by `defaultPostSubmit`);
  `formLinkProjection.ts` (`menuIdOf`, `ROOT_MENU_ID`, `CaseListFormReturnFrame`,
  `caseListFormReturnFrames`, `firstMenuSharedCase`, `frameLeadsWithSelection`);
  `xpath/wire/builders.ts::w.paren`; `multimedia/navMenuMedia.ts::buildActionDisplay`;
  `afterSubmitRouting.ts` (`FrameLanding`, `screenOfFrame`); `menuProjection.ts`
  (`previewScreenEntries`, `previewContributorVisibility`);
  `entryPointLaunch.ts::moduleEntriesOffTheMenu`; `caseListRegistration.ts`
  (`PreviewRegisterAction`, `previewRegisterAction`, `alwaysOfferedRegistrationReturn`);
  `PreviewCaseListRegistrationLaunch`; `lib/preview/platform.ts::PreviewPlatformRules`
  (`caseListActionMedia`); the planners `setModuleFormsInMenuAboveMutation`,
  `alwaysOfferedRegistrationMutations` (`AlwaysOfferedRegistrationPlan`),
  `alwaysOfferedRegistrationChoices` (`AlwaysOfferedRegistrationChoice`) and
  `planCaseListRegistrationDependentsOnRemove` (`CaseListRegistrationDependentsPlan`); the
  validator's rules `menuAboveEntryPoints`, `menuAboveSearch`, `menuAboveLinkTargets`,
  `firstMenuSharedCaseFrames` and `caseListRegistrationApp`; the `MediaRefLocation` kinds
  `case_list_registration_icon` and `case_list_registration_audio_label`, which part 11
  (`11-project-data.md`), section 2.1 (B9), files under `register-action`.
- **Codes**: `FORMS_IN_MENU_ABOVE_NOT_A_DESTINATION`, `FORMS_IN_MENU_ABOVE_WITH_SEARCH`,
  `FORM_LINK_TARGET_SHARES_FIRST_MENU_CASE`, `CASE_LIST_REGISTRATION_FORM_NOT_FOUND`,
  `CASE_LIST_REGISTRATION_HOST_NOT_CASE_FIRST`, `CASE_LIST_REGISTRATION_HOST_SHOWS_FORMS_ABOVE`
  (reasons `host`, `parent-shares-first-menu-case`), `CASE_LIST_REGISTRATION_ADVANCED_MENU`; the
  reason `several-registrations` of `CASE_LIST_REGISTRATION_NOT_REGISTRATION`, for both arms; the
  reason `first-menu-shared-case` of `ENTRY_POINT_INVALID`; the after-submit reasons
  `menu-forms-in-menu-above`, `parent-forms-in-menu-above` and `menu-forms-on-first-menu`; the
  platform feature `case-list-registration-media`.
- **Manifest entries this part adds or flips**, for part 01 (`01-the-bar-and-the-manifest.md`),
  section 2.2's census and Appendix A.3 (A2). A4 flips
  `menus-and-case-lists/put-in-root-display-only-forms` to HELD. A5 flips two to HELD:
  - `menus-and-case-lists/case-list-form-pointing-at-a-registration-form-in-another-module`
  - `menus-and-case-lists/case-list-form-media-image-media-audio`

  A5 adds six HELD-NEW entries, under `case-list-registration` and `menus`:
  - `menus-and-case-lists/case-list-form-post-form-workflow-default-on-the-hidden-module-shape`
  - `menus-and-case-lists/case-list-form-label-empty`
  - `menus-and-case-lists/case-list-form-on-an-advanced-module-or-naming-an-advanced-form`
  - `menus-and-case-lists/case-list-form-pointing-at-a-form-whose-one-registration-of-the-type-is-a-child-case`
  - `menus-and-case-lists/case-list-form-naming-a-form-another-list-offers-after-an-empty-search`
  - `menus-and-case-lists/case-list-form-on-a-host-under-a-menu-that-shares-the-first-menu-s-case`
    (left out under run G6's outcome B)

  A5 adds one REFUSED entry, under `case-list-registration`,
  `menus-and-case-lists/case-list-form-post-form-workflow-default-on-a-multi-select-host` (left out
  under run G3's outcome B), and one INERT entry,
  `menus-and-case-lists/case-list-form-fields-beside-a-blank-form-id`. Stack B adds the five
  reading rows of section 14, in B4 and B5.
- **For the reader, how HQ's keys read** (part 07, `07-the-reader-cases-menus-lists.md`, sections
  8.4, 8.7 and 14; B4, B5). The lane resolves refused classes first and holds every other use of a
  key an allowing entry names, so it has no precedence among allowing and HELD-NEW rows; the
  precedence below is the reader's own, over its cursor.
  - `put_in_root: true` reads as `formsInMenuAbove`, with the menu's name and media kept, unless the
    REFUSED sibling's class takes it (an endpoint, inline search, or an end-of-form return to it).
  - `case_list_form` reads, first match: (1) a blank `form_id` is inert with every field beside it;
    (2) the existing refused and inert rows: a missing form or one that is no registration form (two
    registrations of the type among them), a menu above in its three rows, a host whose forms do not
    all need a case; (3) the new rows in section 14's order: an advanced host or form, a form whose
    one registration of the type is a child case, a form another list offers after an empty search,
    a host under a menu that shares the first menu's case; (4) the hidden-module shape on a host
    whose forms read the search, with the no-matches relevancy, is the `after-empty-search` arm,
    where `post_form_workflow` is `case_list` (`default` there is its HELD-NEW row); (5) a form on a
    menu under section 11.3's rules is the `always` arm.
  - For the `always` arm, `post_form_workflow` reads into `afterSubmit` whatever the form's own
    navigation (`default` on a multi-select host is its REFUSED row); media reads where one path
    serves every language; and the label reads into `label`, left absent where it equals the form's
    name in every language. A label with no text in any language is its HELD-NEW row
    (`menus-and-case-lists/case-list-form-label-empty`), never an absent `label`: HQ shows "Create
    a new Case" there and Nova would show the form's name.
  - A `relevancy_expression` on an `always`-shaped block is inert without the toggle's effect and
    `not-yet` otherwise.
  - `post_form_workflow: previous_screen` on a form listed on the first menu, and a `form_links` entry
    or a `session_endpoint_id` built through a first menu that shares one case, are their HELD-NEW
    rows of section 14. The reader decides the second with `firstMenuSharedCase` over the document it
    assembled.
  - The reader admits exactly what the gate admits, so a search or an endpoint on a menu above is its
    row of section 14, never a document the gate would refuse.
- **For acceptance and the first-publish register** (part 09,
  `09-acceptance-and-the-first-publish.md`, sections 10 and 11; B7): neither concept adds a rewrite
  or a first-publish change. Nova writes `put_in_root`, `case_list_form` and the add-ons `menu_mode`
  and `register_from_case_list` as HQ holds them, and dropped inert blocks (blank `form_id`) are the
  manifest's inert rows. A search on a menu above is refused to read (HELD-NEW), so its claim
  `<post>` and `<remote-request>` are never dropped by a first publish.
- **For part 03** (`03-questions-and-text.md`, section 9.5; A6 to A8): its `.a6`, `.a7` and `.a8`
  follow the `.a4` and `.a5` of section 12.
- **For part 04** (`04-names.md`, section 2.4, row 30, and section 11.4; A9): the widen of row 30 is
  removed in A5, beneath A9, and `default` on the `after-empty-search` arm is HELD-NEW
  (`menus-and-case-lists/case-list-form-post-form-workflow-default-on-the-hidden-module-shape`).
- **For part 14** (`14-proof.md`, sections 6.2 and 11.1; A1, B13): the five targeted documents, the
  native family `menu-screens` with its two Core classes, the two lane readers and the two edit
  kinds of section 15, and runs G1, G2, G3 and G6.
- **For part 15** (`15-stack-contracts-and-exit.md`; A10, A11 and the step 7 rewrite): run G5's four
  expected names (`updateModule`, `setMenuMedia`, `createForm`, `updateForm`), the two literals of
  section 12, the A11 rows of "Contracts", and for step 7's `menus` group the rows of sections 5.6 and
  11.9 and the case list menu item's media target.

