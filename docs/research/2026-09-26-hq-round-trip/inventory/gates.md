# Gates: toggles, privileges and build versions

Part of the surface inventory of the HQ round-trip research. Section names in quotes and defect numbers refer to the main document, [`../README.md`](../README.md). Rows that point elsewhere with `→` name the section that owns the item; the inventory [`README.md`](README.md) says which file holds each section.

## Toggles, privileges and build versions (Σ)

A summary of the gates behind every row in the other inventory files; these rows are not counted. "Gate" is the class of the flag itself; "content" points at the rows it governs. A gate over held content is a target precondition: Nova's preflight checks feature flags through `user_domains?feature_flag=` (`api/resources/v0_5.py`), and has the person confirm each privilege an app's content needs at publish, since no HQ API returns a project space's privileges to an ordinary credential.

### App-building toggles (70)

| Toggle (slug) [tag] | Gate · content | Web Apps / Android | Preflight / refusal |
|---|---|---|---|
| APP_BUILDER_ADVANCED (`advanced-app-builder`) [frozen] | TARGET-OWNED · HELD-NEW (Module types AdvancedModule, Advanced form actions, Shadow forms) | n/a | none: it gates only creating advanced modules and shadow forms in HQ |
| APP_BUILDER_SHADOW_MODULES (`shadow-app-builder`) [frozen] | TARGET-OWNED · HELD-NEW (Module types mirror) | n/a | none: it gates only creating shadow menus in HQ |
| BIOMETRIC_INTEGRATION [frozen] | TARGET-OWNED · HELD-NEW (Case list callout, as an alternative to CASE_LIST_LOOKUP; Android app callouts need only their privileges) | n/a | precondition: CASE_LIST_LOOKUP or BIOMETRIC_INTEGRATION |
| BULK_UPDATE_MULTIMEDIA_PATHS [frozen] | INERT · no content (a path editor) | n/a | none |
| CASE_LIST_CLICKABLE_ICON [frozen] | TARGET-OWNED · HELD-NEW (Column formats, `clickable-icon`) | n/a | precondition (+ SESSION_ENDPOINTS) |
| CASE_LIST_LAZY [frozen] | RETIRING · REFUSED (see "What is refused") | n/a | refuse |
| CASE_LIST_LOOKUP [frozen] | TARGET-OWNED · HELD-NEW (Case list callout) | n/a | precondition (or BIOMETRIC_INTEGRATION) |
| CASE_LIST_MAP [frozen] | RETIRING · REFUSED (see "What is refused") | n/a | refuse |
| CASE_LIST_OPTIMIZATIONS [frozen] | TARGET-OWNED · HELD-NEW (Module fields, Detail columns) | n/a | precondition |
| CASE_LIST_TILE [frozen] | TARGET-OWNED · HELD (Detail screens tiles; the flag probe does not check it today: defect 12) | n/a | precondition |
| CASE_LIST_TILE_CUSTOM [frozen] | TARGET-OWNED · HELD (Detail screens custom tiles) | n/a | precondition for custom tiles (the flag probe does not check it today: defect 12) |
| CASE_SEARCH_ADVANCED [frozen] | TARGET-OWNED · HELD / HELD-NEW (Detail screens multi-select; Case search, including result sort, search on clear, checkbox prompts and hidden prompts) | n/a | precondition |
| CASE_SEARCH_RELATED_LOOKUPS [frozen] | TARGET-OWNED · HELD / HELD-NEW (CSQL relation arms, related-case inclusion, ancestor default filters) | n/a | precondition (the flag probe does not check it today: defect 12) |
| COMMTRACK [frozen] | RETIRING · REFUSED (see "What is refused") | n/a | refuse |
| CSQL_FIXTURE (`module_badges`) [frozen] | RETIRING · REFUSED (see "What is refused") | n/a | refuse |
| CUSTOM_INSTANCES [frozen] | TARGET-OWNED · REFUSED content (freeform) | n/a | refuse non-empty `custom_instances` |
| CUSTOM_PROPERTIES [frozen] | TARGET-OWNED · REFUSED content except Nova's derived key (freeform) | n/a | none: Nova writes the derived key only where the flag is on, since HQ's build omits custom properties elsewhere |
| DETAIL_LIST_TAB_NODESETS [frozen] | TARGET-OWNED · HELD-NEW (Detail tabs data tabs) | n/a | precondition |
| EXTENSION_CASES_SYNC_ENABLED (`extension_sync`) [frozen] | TARGET-OWNED · restore behavior, no document content: extension cases always sync with their host (`phone/data_providers/case/livequery.py`); the flag gates only closing an extension case with its host (`casexml/apps/case/xform.py`), which Preview follows as off | n/a | none |
| FOLLOWUP_FORMS_AS_CASE_LIST_FORM [frozen] | TARGET-OWNED · HELD / HELD-NEW (Case selection extras) | n/a | precondition (emission and validation read it) |
| FORM_LINK_ADVANCED_MODE [frozen] | RETIRING · REFUSED (see "What is refused") | n/a | refuse |
| GEOCODER_USER_PROXIMITY [frozen] | TARGET-OWNED · no document content | n/a | none |
| MOBILE_UCR [frozen] | RETIRING · REFUSED (see "What is refused") | n/a | refuse |
| NON_PARENT_MENU_SELECTION [frozen] | RETIRING · REFUSED (see "What is refused") | n/a | refuse |
| SESSION_ENDPOINTS [frozen] | TARGET-OWNED · HELD / HELD-NEW (Module fields, Form fields entry points, including computed datum arguments and mirror-form entry points) | n/a | precondition |
| SHOW_PERSIST_CASE_CONTEXT_SETTING [frozen] | TARGET-OWNED · HELD-NEW (Detail screens) | n/a | precondition |
| SYNC_SEARCH_CASE_CLAIM (`search_claim`) [frozen] | TARGET-OWNED · HELD (Case search) | n/a | precondition (+ `CaseSearchConfig.enabled`) |
| VALIDATE_APP_TRANSLATIONS [frozen] | INERT · no content | n/a | none |
| ADD_ROW_INDEX_TO_MOBILE_UCRS [deprecated] | RETIRING · refuses nothing (everything it touches is MOBILE_UCR's) | n/a | none |
| ALLOW_BLANK_CASE_TAGS [deprecated] | RETIRING · refuses nothing (HQ's editor marks a blank case tag an error with or without it; the blank tag is refused as not HQ-editable, Advanced form actions) | n/a | none |
| APP_DEPENDENCIES (toggle) [deprecated] | RETIRING · refuses nothing (dead; the privilege gates `features.dependencies`) | n/a | none |
| CACHE_AND_INDEX [deprecated] | RETIRING · REFUSED (see "What is refused") | n/a | refuse |
| CASE_LIST_CUSTOM_VARIABLES [deprecated] | RETIRING · REFUSED (see "What is refused") | n/a | refuse |
| CASE_LIST_CUSTOM_XML [deprecated] | RETIRING · REFUSED (see "What is refused") | n/a | refuse |
| CASE_SEARCH_DEPRECATED_NORMAL_CASE_LIST [deprecated] | RETIRING · REFUSED (see "What is refused") | n/a | refuse |
| CUSTOM_ASSERTIONS [deprecated] | RETIRING · REFUSED (see "What is refused") | n/a | refuse |
| DATA_REGISTRY [deprecated] | RETIRING · REFUSED (see "What is refused") | n/a | refuse |
| DONT_INDEX_SAME_CASETYPE [deprecated] | RETIRING · REFUSED where on (see "What is refused") | n/a | flag probe; refuse same-type basic child cases |
| FIXTURE_CASE_SELECTION [deprecated] | RETIRING · REFUSED (see "What is refused") | n/a | refuse |
| GRAPH_CREATION [deprecated] | RETIRING · REFUSED (see "What is refused") | n/a | refuse |
| HIERARCHICAL_LOCATION_FIXTURE [deprecated] | RETIRING · REFUSED (see "What is refused") | n/a | refuse |
| LAZY_LOAD_MULTIMEDIA [deprecated] | RETIRING · REFUSED (see "What is refused") | n/a | refuse |
| LEGACY_CHILD_MODULES [deprecated] | RETIRING · REFUSED (see "What is refused") | n/a | refuse |
| MM_CASE_PROPERTIES [deprecated] | RETIRING · REFUSED (see "What is refused") | n/a | refuse |
| TARGET_COMMCARE_FLAVOR [deprecated] | RETIRING · REFUSED (see "What is refused") | n/a | refuse |
| TRAINING_MODULE [deprecated] | RETIRING · REFUSED (see "What is refused") | n/a | refuse |
| USER_CONFIGURABLE_REPORTS [deprecated] | RETIRING · refuses nothing (everything it touches is MOBILE_UCR's) | n/a | none |
| V1_SHADOW_MODULES [deprecated] | RETIRING · REFUSED (see "What is refused") | n/a | refuse |
| VELLUM_DATA_IN_SETVALUE [deprecated] | RETIRING · refuses nothing (a `#form/` read in a default value is the same state as the relative read HQ's editors produce without it, Binds) | n/a | none |
| VELLUM_PRINTING [deprecated] | RETIRING · REFUSED (see "What is refused") | n/a | refuse |
| VISIT_SCHEDULER [deprecated] | RETIRING · REFUSED (see "What is refused") | n/a | refuse |
| CUSTOM_ICON_BADGES [GA path, frozen privilege] | TARGET-OWNED · HELD-NEW (badges Module fields, Form fields) | n/a | privilege `custom_icon_badges` |
| DATA_DICTIONARY [GA path, frozen privilege] | TARGET-OWNED · no content | n/a | none |
| FORM_LINK_WORKFLOW [GA path, frozen privilege] | TARGET-OWNED · HELD (Form fields links) | n/a | privilege `form_link_workflow` |
| GEOCODER_MY_LOCATION_BUTTON [GA path] | TARGET-OWNED · no content | n/a | none |
| MOBILE_USER_DEMO_MODE [GA path, frozen privilege] | TARGET-OWNED · `practice_mobile_worker_id` target value | n/a | none |
| PHONE_HEARTBEAT [GA path, frozen privilege] | TARGET-OWNED · no document content (`GlobalAppConfig`) | n/a | none |
| SAVE_ONLY_EDITED_FORM_FIELDS [GA path] | TARGET-OWNED · HELD-NEW (Basic form actions `update_mode: edit`) | n/a | precondition |
| SORT_CALCULATION_IN_CASE_LIST [GA path] | TARGET-OWNED · HELD-NEW (Sorting `sort_calculation`) | n/a | precondition |
| USH_EMPTY_CASE_LIST_TEXT (`empty_case_list_text`) [GA path] | TARGET-OWNED · HELD-NEW (Detail screens `no_items_text`) | n/a | precondition |
| VELLUM_ALLOW_BULK_FORM_ACTIONS [GA path] | INERT · no content | n/a | none |
| VELLUM_SAVE_TO_CASE [GA path, frozen privilege] | TARGET-OWNED · HELD (Question types SaveToCase) | n/a | privilege `save_to_case`, confirmed at publish (without it a Vellum save breaks every case transaction) |
| WEB_APPS_ANCHORED_SUBMIT [GA path] | TARGET-OWNED · no content | n/a | none |
| CASE_SEARCH_ENDPOINTS [internal] | TARGET-OWNED · HELD-NEW (Search configuration typed endpoint reference) | n/a | precondition; publish states the endpoint dependency, which Nova cannot see |
| COPY_FORM_TO_APP [internal] | INERT · no content | n/a | none |
| CUSTOM_APP_BASE_URL [internal] | TARGET-OWNED · `custom_base_url` target value | n/a | none |
| IS_CONTRACTOR [internal, user] | INERT · no content | n/a | none |
| MOBILE_RECOVERY_MEASURES [internal] | TARGET-OWNED · computed profile URL | n/a | none |
| FACE_CAPTURE [release] | TARGET-OWNED · HELD-NEW (Question types face capture) | n/a | none: it gates only creating the question in Vellum (`core.js`), and HQ reads it nowhere else |
| COMMCARE_CONNECT [connect division] | TARGET-OWNED · HELD / HELD-NEW (Question types Connect blocks) | n/a | precondition |

Publish also checks gates outside the app-building flags above: `VIEW_FORM_ATTACHMENT` [GA path], for an app that shows a link write in a case list or detail; whether case search is on (`CaseSearchConfig.enabled`), which Nova's runtime probe reads for an app with case search (`lib/commcare/client.ts::probeCaseSearchRuntime`); and, by asking the person to confirm, since no API reads those settings: that sync on form entry is off for an app that declares Android and has a module that offers search (defect 20) and that the flat location fixture still syncs for an app that reads locations (Settings and profile); and, at import and publish of an app with an advanced module whose case list menu item is on, by asking the person to confirm, that CommTrack is off in the project space (defect 20).

### Removed toggles with document residue

| Toggle | Gate · content | Web Apps / Android | Preflight / refusal |
|---|---|---|---|
| `inline_case_search` (USH_INLINE_SEARCH, removed) | now CASE_SEARCH_ADVANCED · HELD (Search configuration inline) | n/a | CASE_SEARCH_ADVANCED |
| `ush_case_list_multi_select` (removed) | now CASE_SEARCH_ADVANCED · HELD (Detail screens) | n/a | CASE_SEARCH_ADVANCED |
| `case_search_filter` (removed) | REMOVED · INERT residue `search_filter` (Search configuration) | n/a | drop |
| `case_micro_image` (removed) | REMOVED · REFUSED (not HQ-editable: `image` columns, Column formats) | n/a | refuse |
| `custom-parent-ref` (removed) | REMOVED · REFUSED (not HQ-editable: basic subcase `reference_id`, Basic form actions) | n/a | refuse |
| `case_detail_print` | REMOVED · INERT residue `print_template` (Detail screens) | n/a | drop |
| `dynamically_update_search_results` | REMOVED · INERT residue `dynamic_search`, `split_screen_dynamic_search` | n/a | drop |
| `split_screen_case_search`, `case_claim_autolaunch` | no field of their own | n/a | none |

### Privileges (plan-gated)

| Privilege | Gate · content | Web Apps / Android | Preflight / refusal |
|---|---|---|---|
| `user_case` | TARGET-OWNED · HELD (Basic form actions, Usercase) | n/a | build fails without it; confirmed at publish |
| `lookup_tables` | TARGET-OWNED · HELD (Question types, Secondary instances, Lookup tables) | n/a | build fails without it when a form reads a lookup table, and HQ's lookup table upload, which every push uses, refuses without it (`fixtures/dispatcher.py::require_can_edit_fixtures`); confirmed at publish |
| `templated_intents`, `custom_intents` | TARGET-OWNED · HELD-NEW (Question types callouts) | n/a | the build fails where an intent needs one the space lacks (`helpers/validators.py::_validate_intents`: `custom_intents` covers every intent, `templated_intents` only template ids); confirmed at publish |
| `child_cases` | TARGET-OWNED · HELD (Basic form actions child cases) | n/a | editor gate, confirmed at publish |
| `case_sharing_groups` | TARGET-OWNED · HELD-NEW (Settings and profile, `case_sharing`) | n/a | confirmed at publish |
| `locations` | TARGET-OWNED · HELD (Reference targets, locations; organization levels and location reads) | n/a | confirmed at publish |
| `cloudcare` | TARGET-OWNED · HELD-NEW (Settings and profile, `cloudcare_enabled`) | n/a | confirmed at publish for an app that declares Web Apps |
| `practice_mobile_workers` | TARGET-OWNED · target value | n/a | none |
| `commcare_logo_uploader` | TARGET-OWNED · HELD / HELD-NEW (Application logos) | n/a | not a publish precondition: publish writes no logo (defect 14) and says HQ's builds carry the app's logos only where the plan has this privilege and the person uploaded them in HQ (HQ's build drops the profile logo properties without it, and a plan downgrade archives the logos, `archived_media`) |
| `build_profiles` | TARGET-OWNED · `build_profiles` target value | n/a | none |
| `app_dependencies` | TARGET-OWNED · HELD-NEW (Settings and profile, `features.dependencies`) | n/a | confirmed at publish (HQ drops the content without it) |
| `phone_apk_heartbeat` | TARGET-OWNED · no document content | n/a | none |
| `form_link_workflow` | TARGET-OWNED · HELD (Form fields) | n/a | editor gate, confirmed at publish |
| `custom_icon_badges` | TARGET-OWNED · HELD-NEW (badges) | n/a | editor gate, confirmed at publish |
| `data_dictionary` | TARGET-OWNED · no content | n/a | none |
| `save_to_case` | TARGET-OWNED · HELD (Question types SaveToCase) | n/a | confirmed at publish for any SaveToCase operation |
| `locked_admin_questions` | TARGET-OWNED · HELD-NEW (Question types `lockedInHq`) | n/a | editor gate, confirmed at publish |
| `geocoder` | TARGET-OWNED · HELD-NEW (Search prompts geocoder, Appearances `address`) | n/a | confirmed at publish (+ CASE_SEARCH_ADVANCED) |
| `show_enable_all_add_ons` | TARGET-OWNED · no content | n/a | none |
| `public_webforms`, `view_app_diff`, `release_management`, `lite_release_management`, `login_as` | adjacent · no content | n/a | none |

### Build versions

Every version check in HQ is a minimum (`feature_support.py::_require_minimum_version`, and direct checks in `app_strings.py`, the suite generator, `views/formdesigner.py`, `views/modules.py` and the settings page's per-setting `since` gates, `commcare_settings.js` `versionOK`), and none is above Nova's floor of 2.57 (the case list icon width gate is disabled at every version), so no row carries a version precondition of its own. One gate fails rather than leaving the feature out: multimedia case properties below 2.6 are a build error (`enable_multimedia_case_property`). Generation gates, where HQ leaves the feature out of the build below the version (`feature_support.py`, read by `suite_xml/`, `detail_screen.py`, `xform.py`, `app_strings.py`, `models/applications.py`, `models/forms.py` and `models/modules.py`): multi-sort 2.2 · post-form workflow 2.9 · relative suite paths 2.12 · local media resources 2.13 (offline install, which also needs it, affects only the releases page) · auto GPS 2.14 · menu filtering 2.20 · localized menu media and badges 2.21 · practice users 2.26 · prompt appearance 2.50 · prompt default expressions and session endpoints 2.51 · search title translation and data registries 2.53 · alt text, clickable icons, empty-list text, menu instances and select text 2.54 · case-list optimizations 2.56. Authoring gates, where HQ's editors do not offer the feature below the version: groups in field lists 2.16 · image resize and markdown in groups 2.23 · parent selection with a case-list form 2.23 (`views/modules.py`) · sort blank placement 2.35 · sorted itemsets 2.38 · update prompts 2.38 (a releases-page setting, no app content) · markdown tables 2.50 · training modules 2.43 (`views/apps.py`, the new-menu dialog; retiring content) · grouped tiles, grouped prompts, and module assertions (retiring content) 2.54 · repeat button text 2.55 (`views/formdesigner.py`) · document upload 2.57. Multi-master linked apps 2.47.4 gates only a display on the app's linked-apps page (`views/apps.py`), no app content.
