# Round-tripping CommCare HQ apps through Nova

How Nova reads an app from CommCare HQ, holds it as a Nova app, lets people edit
it, and writes it back to the same HQ app; what Nova's model must add to do that;
and how Nova proves each step. Research date 2026-09-26.

Every CommCare fact here was read in, or executed against, the source at:
commcare-hq `f57e85e02913` (2026-09-25), formplayer `24383ac71bfb`,
commcare-core `8e9ba8d908e9`, commcare-android `fd79cac4a0f1`, Vellum
`01215f251c57`, commcare-connect `4a200c9d9` (2026-09-28, for Connect block ids), and Nova `main` at `f3642b34`; one later HQ change, at `525becc2963` (2026-09-28), is named where it applies. Execution means HQ's own Python
(booted offline under its test settings), CommCare Core and Formplayer (their own
test harnesses), and HQ's vendored Vellum build (headless), run against HQ test
apps and Nova exports. CommCare citations use `file::symbol`. This document names
no client app content.

---

## Summary

Importing is reading, not converting. A CommCare HQ app is data in HQ's wire
shape: application JSON plus XForm XML. Nova reads that data through HQ's API,
checks that it meets every guarantee a Nova app carries, and holds it in Nova's
shape. An app that passes is a Nova app. An app that does not is refused, with the
place and the reason. Nothing is repaired, approximated or stored loosely.

An app is importable when five things hold:

1. **HQ builds it, at or above Nova's CommCare version floor.** HQ's own
   validator passes and its build completes, at a CommCare version that carries
   every feature Nova holds. What depends on the target project space (its
   privileges and flags) is checked when the app is published there, and a flag
   that changes what HQ generates is also checked when the app is imported from
   there.
2. **HQ's own editors can produce and keep it.** The app manager and Vellum can
   author every part of it under a configuration HQ still supports, and saving
   it there changes nothing HQ builds or its servers read. A state HQ's build tolerates but no editor
   can produce (a menu nested two levels deep, say) is undefined behavior, and
   Nova neither imports nor emits it.
3. **CommCare Core admits everything HQ generates from it.**
4. **It is a valid Nova document.**
5. **Reading it into Nova changes nothing that any runtime, any HQ server
   feature, or any existing data depends on.**

The second condition binds Nova's exports as much as its imports. Every app Nova
writes must be one a person can open and save in HQ without breaking it or
changing its behavior. Today that is not true (see "Defects in Nova today").

Nova's typed model is the asset. It becomes complete over everything CommCare
builds and runs, and completeness is defined by source code, not sampled from
apps. The complete surface, with each item's fate, is the surface inventory ([`inventory/`](inventory/README.md)).

Correctness is established when each feature is built. Every feature enters
Nova with proof against HQ's real build and CommCare Core's real runtime, over
apps built for that feature and generated combinations of features. The reader
admits only apps made entirely of proven features, so every imported app is
correct without re-checking it in production.

Some defects harm apps Nova builds today, and the order of work fixes most of
them right after the proof exists:

- Every in-place republish gives every form a new `xmlns` and `unique_id`, and every menu a new `unique_id`,
  which splits form exports and silently detaches UCR data sources, form
  forwarding filtered by form, and SMS surveys.
- A form display condition on a case's status makes the app fail HQ's build.
- Opening and saving certain Nova-built forms in HQ's editors breaks the app or
  changes its behavior.
- Nova's lookup table push deletes the properties, attributes and owners of an
  HQ table it overwrites.

A date-and-time question also does not work in Web Apps at all; its fix comes
with the platform model.

---

## What Nova imports

### Source: HQ's API, only

Apps come from CommCare HQ, so Nova imports only through HQ's API. A `.ccz` is a
build HQ already made from the app; it lacks the authored source, and anything
built elsewhere is rarely valid. The API gives Nova the authored application JSON
and XForm sources, the real identities, and the project space's lookup tables and
locations, over the credential Nova already stores.

Nova is used by Dimagi staff, and import requires the project space's API access:
the `API_ACCESS` plan privilege (Pro plans and above, plus the grandfathered
`standard_v0`; `corehq/apps/accounting/bootstrap/features.py`) and the account's
`access_api` permission; an HQ superuser's unscoped credential passes both
checks in every project space except one that restricts superusers
(`Domain.restrict_superusers`), where it needs membership with a role
granting `access_api`
(`api/resources/__init__.py::HqBaseResource.dispatch`,
`users/models.py::_AuthorizableMixin.has_permission`); reading the space's
feature flags also needs the credential's user to be a member (below). Without API
access Nova cannot learn every form's real id (HQ's case summary download names only forms that load or save a case property), and import refuses with that
reason.

### The bar

HQ's import API (`views/app_import_api.py::_handle_import_app`) validates nothing:
it wraps the JSON into jsonobject classes, which check property types and choice
lists and keep unknown keys (a few schemas, such as `CaseReferences`, refuse
them). The build bar is the path behind HQ's "Make new
version" (`views/releases.py::save_copy` → `models/applications.py::ApplicationBase.make_build`).

Let Σ be the project space's configuration: the HQ commit, its enabled toggles,
its plan privileges, and the domain state the build reads (lookup tags, UCR
report configs, the location hierarchy and fixture configuration, practice users,
data registries, case search endpoints, `domain.commtrack_enabled`,
`CaseSearchConfig.sync_cases_on_form_entry`, `ResourceOverride` rows, the
build-version menu). An app D is **HQ-buildable under Σ** when
`util.py::get_correct_app_class(D)` is `Application` or `LinkedApplication`,
`dbaccessors.py::wrap_app(D)` succeeds, `D.application_version == "2.0"`
(`ApplicationBase.assert_app_v2`), `Application.validate_app()` returns `[]` and
raises nothing (it runs every module and form validator, Formplayer's parse of
each form source, and `Application.create_all_files()`), and each build profile's
`create_all_files(build_profile_id)` succeeds. HQ's "Make new version" never
builds a build profile (`validate_app` checks only their practice users,
`_validate_practice_users`); HQ builds each profile later, in a background task when the build is released
in a project space with the `build_profiles` privilege (`views/releases.py`,
`tasks.py::create_build_files_for_all_app_profiles`), or when that profile is
downloaded, where a failure is not reported as a build
error, which is why the last condition is separate.

**HQ-editable** means every part of D is something HQ's current editors (the app
manager, Vellum, and Bulk App Translations editing existing text) can produce
under a configuration HQ still supports, meaning a flag that is not retiring (a
frozen one only in a project space that already carries it) or a plan
privilege, with no error an editor shows (a value an editor marks as an error is
one it does not produce, even where its save does not block it); and every HQ save of any page or form
keeps D or rewrites it to a spelling that HQ builds, and HQ's servers read,
identically. A gate that only creating a state needs is not a precondition for
holding it (a new advanced module needs `APP_BUILDER_ADVANCED`, or a CommTrack project
space, `views/apps.py`, and an existing
one is edited without it, per `views/apps.py`); a gate that editing needs is.
This one definition is the envelope everywhere in this document. The rules HQ's
editors enforce beyond its model and build, and the saves that rewrite stored
data, are listed in "Nova's exports stay inside HQ's editable envelope".

**The CommCare version floor.** Each HQ app carries its own CommCare version
(`build_spec`, the "CommCare version" in the app's settings), and HQ gates
features on it in two ways. Every gate is a minimum, so a newer version carries a
superset of an older one. Below a generation gate HQ does not fail (the one
exception, multimedia case properties below 2.6, is beneath Nova's floor); it
leaves the feature out of what it builds (session endpoints and search prompt defaults below
2.51, case-list optimizations below 2.56; `feature_support.py`, read by
`suite_xml/`, `detail_screen.py`, `app_strings.py`, `xform.py` and the models). Below an authoring gate
HQ's editors do not offer the feature, so an app that uses it is outside the
envelope (document upload below 2.57, sorted itemsets below 2.38; read by `views/formdesigner.py`, `views/modules.py`, `views/forms.py`,
`views/apps.py` and the module templates). The
version is also the oldest CommCare a phone may run: HQ writes it into the profile as `requiredMajor`, `requiredMinor` and
`requiredMinimal`, and Core refuses to install a profile whose major version
differs from the phone's or whose minor version (or, at an equal minor, patch
version) is newer
(`ProfileParser.parseProfileElement`). Web Apps always runs the current server.

So Nova holds one floor: the highest version any feature it holds needs, of
either kind, which is 2.57 today (document upload). Nothing in Nova's vocabulary
varies by version, and Nova raises the floor only when it adopts a feature that
needs a newer one. Raising it stops publishes to every target app below it until
the person raises that app's CommCare version, as below, and, once Nova's `.ccz`
declares the floor (defect 9), phones running an older CommCare can no longer
install it. This floor is a
requirement on the target app, not a gate on rolling out Nova. The floor is the same bar as the rest of this document, apps
that CommCare can build today with every feature Nova holds, rather than every
app CommCare ever built. Nova cannot set an app's version through HQ's API:
create applies HQ's default version and update never changes it. So import
refuses an app below the floor. From step 2, publish reads the target app's version first and stops below it; for a new app, it creates the app, writes the in-place update
that sets its ids, and then stops if HQ's default version is lower. In both cases
the next step is to raise the CommCare version in the app's settings in HQ, and
publish says that phones running an older CommCare will then no longer install
or update the app. That raise is the person's act, because it can switch on
content HQ was leaving out. Nova's local `.ccz` must declare the floor in its
profile, as HQ's does; today it declares none (defect 9).

The privileges an app needs are derived from its content. HQ's build enforces
three checks: `user_case`, `lookup_tables` (only for a form whose source contains the literal
`src="jr://fixture/item-list:`, `FormBase.has_fixtures` through `_validate_fixtures`; a case list or search reading one builds without
it, though every app whose tables Nova pushes needs it for the push, `fixtures/views.py::upload_fixture_api`), and the Android callout privileges `templated_intents` and
`custom_intents` (`helpers/validators.py`). The rest that app content needs
gate HQ's editors, silently drop content, or gate a runtime service:
`save_to_case`, `child_cases`, `form_link_workflow`, `custom_icon_badges`,
`locked_admin_questions`, `case_sharing_groups`, `geocoder`, `cloudcare` (from step 4, for an app that declares Web Apps),
`locations`, `commcare_logo_uploader` and `app_dependencies`. HQ builds an app
without them, but an HQ user on a plan without one cannot edit that content, a
Vellum save without `save_to_case` drops every case attribute bind, Web Apps
refuses mobile workers without `cloudcare` (`cloudcare/views.py::FormplayerMain`),
and Web Apps geocoding needs `geocoder`. No HQ API returns a project space's
privileges to an ordinary credential (the accounting resources in `api/accounting.py`, open only to superusers and
contractors, which expose
plan roles, are admin tools Nova does not use). So from step 2 publish lists every privilege the app
needs, including the four behind the three checks HQ's build makes (`lookup_tables`; `custom_intents`, or `templated_intents` when every callout is a template, `_validate_intents`; `user_case`; `helpers/validators.py`), with the plans that carry each
(`accounting/bootstrap/features.py`), the person confirms each privilege once
for each app and project space, the deployment ledger records it on that
deployment record (the person can revisit it from that target's settings), and
publish refuses without that confirmation. A confirmation stands until the
person revisits it: Nova cannot see a later plan change in HQ, as it cannot see
the settings the other confirmations cover. The logo privilege is the one exception: from step 2 publish writes no logo
(defect 14; today it writes path-only `logo_refs`), so `commcare_logo_uploader` is
not confirmed; publish of an app with a logo says HQ's builds carry it only
where the project space's plan has that privilege (Advanced and above) and the
person has uploaded it there. Plans of one name differ by version
(`pro_v0` carries `cloudcare` and `pro_v1` does not), so the confirmation is per
privilege, never per plan. An app needs `save_to_case`, which Advanced and
Enterprise plans carry, only when it holds a case write placed in a Save to Case
block (see "Case writes"); a Pro project space, although it has the API access
import needs, does not take such an app. Three privileges an app can need,
`save_to_case`, `form_link_workflow` and `custom_icon_badges`, are also granted
by a legacy privilege flag (`FrozenPrivilegeToggle`, tagged GA path rather than
frozen; `toggles.domain_has_privilege_from_toggle`), which the flag probe cannot
read (`user_domains` answers 400 for its slug, since `all_toggle_slugs` leaves
it out; executed), so the per-privilege confirmation covers it. Likewise, from step 4, an app that declares Web Apps
needs `cloudcare`, which the current Pro plan lacks, so publishing a new app,
which declares both platforms, or an existing app whose declaration includes Web
Apps, to such a project space stops at this confirmation until the person
narrows the declaration to Android only, which first needs removing whatever
Android cannot run; the builder names each. A plan never shapes what Nova builds:
the agent, builder and MCP see one vocabulary, and the plan is a fact publish
checks. This document names flags by their constants in `corehq/toggles/__init__.py`; the probe takes each flag's slug from the same definition (`CSQL_FIXTURE` is `module_badges`, `TRAINING_MODULE` is `training-module`). Feature flags are read directly (`user_domains?feature_flag=`,
`api/resources/v0_5.py::UserDomainsResource`), which answers only for project
spaces the credential's user belongs to, and also counts a flag enabled for that
user alone (`toggles.toggles_dict`). So import and publish read a project
space's flags with the publisher's credential where its user is a member, and
otherwise in the order the step 2 cutover uses (the stored credential of the
person who created the deployment, then of other current members of the Project
in the order they joined), each read with another member's key recorded and
shown to that member; where no credential's user is a member, they stop, naming
the space, with the next step to join it; and since Nova cannot tell a flag enabled
for the person alone from the space's own, publish names each flag it relies
on. These checks run at publish, never at commit, because
the commit gate may read only the document (`docs/architecture/contracts.md` §
What the commit gate may read).

### What is refused

The reader admits only what Nova's model holds. Independently of that, these
are refused outright, with a stable code and a sentence naming the place.

**Freeform XML.** HQ stores content its builder does not model: raw XForm
upload and "Edit Source XML" (`util.py::save_xform` stores bytes even when they
are not XML), `Detail.custom_xml`, custom detail variables, custom instances and
custom assertions. Some of it the build and runtimes never consume. The rest
means something only through a runtime parser (for example
`commcare-core .../xml/DetailParser.java`), and a runtime feature enters Nova only
as a typed concept read from that parser. The carrier itself is never modeled.

**Features HQ is retiring.** HQ's code tags each flag
(`corehq/toggles/__init__.py`). A deprecated flag (`TAG_DEPRECATED`, 23
app-building flags) is retiring. A frozen flag (`TAG_FROZEN`) is one whose tag says "This
feature flag will be removed with an alternative solution in future. Do not add
new projects to this list." (advice HQ does not enforce). Nova treats seven
frozen flags as retiring by its own decision: `CASE_LIST_LAZY`, `CASE_LIST_MAP`,
`NON_PARENT_MENU_SELECTION`, `COMMTRACK`, `CSQL_FIXTURE`,
`FORM_LINK_ADVANCED_MODE` and `MOBILE_UCR`. Content under any other frozen flag
(case search itself, advanced case search, session endpoints, case tiles and
others) is held unless it is freeform, and publishing it works only to a project space that already
carries the flag, which the flag probe checks; a frozen flag that gates only
creating a state in HQ (`APP_BUILDER_ADVANCED`, `APP_BUILDER_SHADOW_MODULES`) is
no precondition. The table below is the record of this classification. What a
retiring flag provides is refused, including through any other editor path that
reaches the same feature; a flag whose feature lives on under a supported gate
refuses nothing. The exact refused content:

| Retiring flag | Refused content |
|---|---|
| `CASE_LIST_LAZY` | `Module.lazy_load_case_list_fields` true (column-level lazy loading under `CASE_LIST_OPTIMIZATIONS` stays) |
| `CASE_LIST_MAP` | detail columns with format `address-popup` |
| `NON_PARENT_MENU_SELECTION` | `parent_select` active with `relationship` null ("Other"), and the `#case:<slug>` references it enables |
| `COMMTRACK` | advanced load actions with `show_product_stock` and `product_program`; a non-default `AdvancedModule.product_details`; `model: product` detail columns; ledger questions (Balance, Transfer, Dispense, Receive) and `ledger:section` detail fields; any `commtrack:products`, `commtrack:programs` or `ledgerdb` instance reference |
| `CSQL_FIXTURE` | any `case-search-fixture:*` instance reference |
| `FORM_LINK_ADVANCED_MODE` | form links to modules that are not auto-linkable, datums on module-target links, and datums on form-target links whose name is not one HQ derives for the target |
| `MOBILE_UCR` (parent `USER_CONFIGURABLE_REPORTS`) | `ReportModule`; `report_context_tile`; `reports`, `commcare:reports`, `commcare-reports:*`, `commcare-reports-filters:*` references; `mobile_ucr_restore_version` other than `2.0` |
| `ALLOW_BLANK_CASE_TAGS` | an empty `case_tag` on an advanced action that does not auto-select |
| `CACHE_AND_INDEX` | sort elements of type `index` |
| `CASE_LIST_CUSTOM_VARIABLES`, `CASE_LIST_CUSTOM_XML` | `Detail.custom_variables_dict`, `Detail.custom_xml` |
| `CASE_SEARCH_DEPRECATED_NORMAL_CASE_LIST` | a searching module with `auto_launch` false in an app with `cloudcare_enabled` true, that is, one that declares Web Apps |
| `CUSTOM_ASSERTIONS` | app, module and form `custom_assertions` |
| `DATA_REGISTRY` | `data_registry`, `data_registry_workflow` (registry search, load and smart links), `additional_registry_cases`; the `x_commcare_data_registry` default filter; `registry` instance and `#registry_case` references |
| `FIXTURE_CASE_SELECTION` | `fixture_select` active, and `$fixture_value` references |
| `GRAPH_CREATION` | `graph` columns |
| `HIERARCHICAL_LOCATION_FIXTURE` | `location_fixture_restore` `only_hierarchical_fixture`; `location:` detail fields; `commtrack:locations` references |
| `LAZY_LOAD_MULTIMEDIA` | profile `lazy-load-video-files` true |
| `LEGACY_CHILD_MODULES` | a module order that separates a child menu from its parent |
| `MM_CASE_PROPERTIES` | `picture` and `audio` columns (with their `attachment:` fields), and attachment-mode case properties (a capture saved to its case as a case attachment). A capture reaches a case as a link to the submitted file instead, which needs no flag to write |
| `TRAINING_MODULE` | training modules and release-notes forms (`is_release_notes_form`) |
| `V1_SHADOW_MODULES` | shadow modules at version 1 (an absent version counts, since the model default is 1) |
| `VELLUM_DATA_IN_SETVALUE` | default values that read `#form/` nodes (Vellum reports them as errors without the flag, `baseSpecs.js` `defaultValue.validationFunc`) |
| `VELLUM_PRINTING` | print callouts and their HTML templates (Vellum also turns an Android app callout given the print action into a print callout when it loads the form, `intentManager.js::syncMugWithIntent`, so that path is the same feature) |
| `VISIT_SCHEDULER` | `has_schedule` true, `schedule_phases`, a form's `schedule_form_id`, form schedules with `enabled` true (the disabled schedule HQ writes on every new advanced and shadow form is inert), `schedule:*` references and `schedule:` detail fields |
| `TARGET_COMMCARE_FLAVOR` | `target_commcare_flavor` other than `none` (the settings file spells its gate `toggles:`, so HQ shows the setting in every project space, but the setting is this flag's feature) |

Three retiring flags gate no app content, so nothing is refused for them:
`APP_DEPENDENCIES` (dead; the feature lives under its privilege), and
`ADD_ROW_INDEX_TO_MOBILE_UCRS` and `USER_CONFIGURABLE_REPORTS` (everything they
touch is `MOBILE_UCR`'s). `DONT_INDEX_SAME_CASETYPE` changes generation for a
whole project space: where it is on, HQ drops the parent index of a basic child
case whose type is its parent's own (`xform.py`). From step 2 Nova reads the flag
through the feature-flag probe (whose list lacks it today), and importing from
or publishing to such a project space refuses an app with that content.

An app whose CommCare version is below Nova's floor is refused, as above.

Two settings HQ has discontinued are refused at non-default values:
`use_custom_suite` true (with `custom_suite`) and `translation_strategy` other
than `select-known`; `application_version` 1.0 does not build. Custom profile
properties are freeform and refused, except the one key Nova derives itself
(`cc-index-case-search-results`) when it equals Nova's derivation, as is any
profile value outside its setting's choice list.

**States HQ's editors cannot produce.** A child menu with its own child, or
under a shadow menu other than the child mirrors HQ creates itself
(`views/modules.py::_get_valid_parents_for_child_module` offers only parentless,
non-shadow, non-training menus, and only to a menu with no children; HQ puts a
shadow under another only through `views/utils.py::handle_shadow_child_modules`).
HQ's build refuses cycles, unknown parents and training menus in a hierarchy, and
nothing deeper. A module's Task
List turned on: the setting renders only with the case list menu item add-on,
outside shadow and survey menus, and then only when it is already on or, in a
basic module, the domain record carries `survey_management_enabled`, a leftover of a removed feature that
no current code sets or lets anyone change, and it injects a delegation case
block into every case-requiring form with case actions
(`xform.py::XForm._create_casexml`); Nova
does not read that domain field (only the admin resource, open to superusers and contractors, returns it, and Nova does not use it),
so it refuses Task List everywhere. Content whose
flag HQ has removed: columns with format `image` (the UI went in `1d0f049d84f`)
and a basic subcase `reference_id` other than empty or `parent` (the
`custom-parent-ref` flag). A module with no `unique_id`, which has no stable identity: HQ's build gives
such a module a random id only in the build it makes (`make_build` runs
`Application.validate_app` on its copy), a different id each build, and the app
itself keeps no id until HQ gives its menus ids and saves: App Preview runs it
(`views/cli.py::get_direct_ccz` validates the current app), a menu's page opens
(`views/modules.py::get_module_view_context`, reached from a menu with an id, from
adding a menu, or through the legacy `/modules-<index>/` address, which also
ids that menu, `view_generic.py::_get_module_and_form`), or an edit that looks a
menu up by id saves (`Application.get_module_by_unique_id` ids every menu it
passes). HQ's menu list links a menu with no id to `/module/None/`, which
is "Page not found" (`view_generic.py::_get_module_and_form`; executed). So
opening App Preview once in HQ fixes it. And every other state
"Nova's exports stay inside HQ's editable envelope" lists as producible by no
editor, unless the inventory holds it as the same state as a value an editor
produces (the inventory's "Same state" rule) or marks it INERT.

**Content broken at runtime**, even though HQ builds it: unknown XPath function
names (JavaRosa parses them and fails when they are evaluated), form links whose
datums leave the target's case id empty, lookup table tags containing `casedb` or `ledgerdb` (every runtime's
`CommCareInstanceInitializer.generateRoot` tests the instance source for those
substrings before `fixture`, so the table silently becomes the case or ledger
database), and a form Core's parser rejects.

**Downstream linked apps.** HQ answers an update to a `LinkedApplication` with a
400 (`_merge_source_into_app` compares the `doc_type` Nova always sends,
`hqShells.ts`), and the next upstream pull
would overwrite any change. An upstream app is importable; each of its releases
can be pushed to or pulled into every downstream project space, which publish
discloses.

### HQ's own guarantees, for comparison

- The import API validates nothing.
- HQ never parses its generated artifacts with CommCare Core. Formplayer's
  `/validate_form` sees only the authored form source; the rendered form (with
  injected case and meta blocks), `suite.xml`, app strings and profile are never
  parsed or executed at build.
- When Formplayer is unreachable, the per-form check skips form validation
  (`helpers/validators.py`). The build fails, and "Make new version" lists the build error "Unable to
  connect to Formplayer", only when it must re-validate a form carried from the
  previous build with unchanged build profiles and no cached verdict
  (`set_form_versions`); a form new since the last build is then never validated. The verdict is cached for 7 days by
  `(app_id, form unique_id)`. An in-place update writes form
  sources through `save_attachments`, which never clears that cache, so HQ's App
  Preview can serve a stale verdict in both directions: an invalid form served as
  valid, and a valid form reported with build errors (executed with HQ's real
  `import_app_from_doc` and `overwrite_app_from_source`). "Make new version"
  validates under the new build's id and is not affected.
- At build HQ syntax-checks only `module_filter` and `form_filter` (a node XPath
  parser) and the case-list filter (lxml). Calculated columns, tab nodesets,
  custom variables and prompt expressions are never parsed.
- HQ's editor saves drop or rewrite stored data: every Case List save of a menu whose page
  shows case search settings resets `search_button_label`; saves without the relevant flag drop sort calculations
  and case search endpoint ids; any settings save without the `app_dependencies`
  privilege drops app dependencies; and custom profile properties stay stored but
  HQ's build omits them unless `CUSTOM_PROPERTIES` is on.
- HQ's source export (`views/apps.py::app_source`) replaces every form
  `unique_id` with a fresh random value on each read and leaves
  `ShadowModule.excluded_form_ids` and `form_session_endpoints` pointing at the
  real ids.
- HQ's own `Application.rename_lang` crashes on an app with build profiles.
- HQ deleted six case tile templates in December 2025 (`5f0d9a9554e`); apps
  that used them now fail the build. Removing `ENUM_CALC_VARIABLES` on 2026-09-21
  made its flagged emission unconditional (`fde23f9828a`).
- Vellum keeps only three kinds of content it does not model (unknown attributes
  on data nodes, binds and controls; unknown body controls, kept read-only;
  anything marked `vellum:ignore="retain"`) and loses the rest on first save.

### The surface, sized

| Area | HQ surface |
|---|---|
| Module types | 4: `Module`, `AdvancedModule`, `ShadowModule` (v1, v2), `ReportModule` |
| Form types | 3: `Form`, `AdvancedForm`, `ShadowForm` |
| Application fields | 66; 52 CommCare settings in 6 sections |
| Module fields | 20 shared, plus 11 basic, 8 advanced, 13 shadow, 2 report |
| Basic form actions | 12 slots, 7 of which emit anything |
| Case-list column formats | 24 |
| Case search | `CaseSearch` 20 fields, `CaseSearchProperty` 15 |
| Vellum question types | 42 mug types: 21 always available, 16 gated, 5 never in the Add Question menu (Long, ReadOnly and Ignored are never created; Choice and Itemset are created under a select) |
| JavaRosa | 76 function names (plus the `instance()` and `current()` path heads), 26 bind type spellings (8 unsupported), 9 body element handlers (6 controls plus group, repeat and label), 4 events |
| Feature flags | 207; 70 affect app building (35 target-owned, 24 of them gating held content; 30 retiring; 5 inert); 17 flags and 7 privilege families change or block the build |

---

## The reader

The importer is the inverse of Nova's emitter. It reads an HQ app into Nova's
shape with its meaning unchanged, or it refuses. Re-emitting what it read
reproduces that meaning and every external identity.

**Meaning** is what CommCare's runtimes and HQ's servers derive from the app.
HQ often has several spellings for one meaning. Case writes are the clearest
case: basic form actions, advanced form actions and Vellum's "Advanced Case
Actions" (SaveToCase) blocks all produce `<case>` elements that CommCare Core
processes identically
(`commcare-core .../XmlFormRecordProcessor.java::process`). Nova holds one
concept per meaning, and reading several spellings into it is not a conversion
provided re-emission means the same thing and preserves every identity.

Meaning includes what HQ derives on its servers, because the spelling leaks
there. HQ learns an app's case properties through `IndexedFormBase.get_all_case_updates`,
which reads form actions plus the SaveToCase list in `case_references_data.save`
(`models/forms.py::FormBase.get_save_to_case_updates`); that list feeds
case-export schemas and, where the project space has `save_to_case`, the data
dictionary (`app_manager/tasks.py`). Several build behaviors apply only
to form-action case blocks (the usercase subscription check, "save only if
edited", case-sharing owner assignment, multimedia case properties,
`DONT_INDEX_SAME_CASETYPE`).

This extends `CLAUDE.md`'s rule that the only admissible HQ facts are "the wire
accepts / rejects this": for an app with customer data behind it, what that data
already depends on binds Nova too, and so do HQ's editors. HQ's authoring shapes
still do not.

### External identity

These must be equal after a round trip, not merely equivalent (sources:
`models/applications.py::overwrite_app_from_source`,
`export/models/new.py::FormExportDataSchema._process_app_build` and
`::_add_export_items_for_cases`, `userreports/app_manager/data_source_meta.py`,
`motech/value_source.py::get_form_question_values`, `sms/models.py::KeywordAction`,
Android `FormEntryInstanceState.java::getFormDefIdForRecord`):

| Identity | Breaks if it changes |
|---|---|
| HQ app id: always update in place, never re-create | device updates, exports, UCR, Web Apps permissions, smart links, SMS surveys |
| Form `xmlns` (form JSON and XForm data node) | form exports split; UCR form sources, form forwarding whitelists and DHIS2 configs stop matching; Android cannot reopen incomplete forms after the update |
| Form `unique_id` (the real one) | SMS surveys and keywords stop at the next release; every form re-downloads |
| Module `unique_id`, session endpoint ids | internal references, smart links |
| Session datum ids that form logic reads (`instance('commcaresession')/session/data/<datum>`) | HQ derives them from module configuration and Vellum writes them into form logic; a different name breaks those reads with no build error |
| Full data-tree path of every answer leaf, including group and repeat ancestors | export columns, UCR indicators, DHIS2/OpenMRS/FHIR mappings, SMS keyword arguments |
| Which path segments repeat | each repeat is its own export table |
| Question type class (scalar, multiple choice, geopoint, media, label) | the saved export column goes empty and a new one appears |
| Select option values | split export columns, report-builder columns, integration value maps |
| Position and element names of every case transaction block: `/data/case`, `/data/subcase_<i>/case` (positional), `<repeat>/case` vs `<repeat>/subcase_<i>/case`, `/data/case_<tag>/case`, `/data/commcare_usercase/case`, any SaveToCase wrapper path | every case column in saved exports and app-derived UCR sources |
| `case_references_data` | HQ's case-export schema and data dictionary |
| Case type and case property names; case index identifiers and relationships | existing cases, exports, rules, repeaters, case search config |
| Lookup table tags, field names and field-property names; location type codes; worker-data slugs | fixtures and restore data read by name |
| Multimedia paths (soft) | a changed path is a new file HQ must receive through its multimedia upload, and the old file stays in HQ's media map, which an update cannot change |
| Language codes | build profiles, which an update keeps: a profile whose languages were all renamed fails to build ("Form does not contain any translations for any of the build languages"); a partly renamed profile builds silently without the renamed language. Also device and Web Apps language choice, mobile worker language, and HQ's built-in UI strings (shipped for `en`, `hat`, `hin`, `por`, `sw`) |
| Menu and form order (soft) | Web Apps URLs select menus by position |

Free to differ in bytes: the order of instance nodes and binds (the body's
question order is held, because a structured-SMS keyword without named arguments
fills questions in that order, `sms/handlers/keyword.py`), label and itext text,
expression spelling, setvalue placement, XML formatting, body-only groups, `uiVersion`,
`<h:title>`, data-node `@name` and `@version`. Itext ids are free unless form
logic references them through `jr:itext('…')`.

Each case transaction's submission placement, and each datum name form logic
reads, are therefore part of what Nova holds for a form, like a question's path.
Naming rules follow from the same fact: a correct model represents the customer's
data exactly, so each rule is set by what the name must hold and what every
consumer can carry. Core's XPath reads a name one UTF-16 unit at a time
(`Lexer.matchNCName`): its first character is `_` or one Java counts as
lowercase or uppercase (`Character.isLowerCase`, `isUpperCase`: the upper- and
lowercase letters of the Basic Multilingual Plane, not titlecase letters such as
`ǅ`, and a few other characters such as `ª` and `Ⅷ`), and each later one may
also be a decimal digit, `.` or `-`; a character outside the Basic Multilingual
Plane never qualifies. Call these Core's name characters. Hyphenated question
ids (ordinary XPath names), case types with a leading digit, and case properties
whose characters after HQ's required ASCII first letter
(`helpers/validators.py::validate_property`) are all Core's name characters are
sound end to end, and Nova's grammars widen to admit them, with the reference
syntax, the XPath editor and the emitter all handling them. HQ's lookup tag and field grammar is any XML name
without a colon that does not start with lowercase `xml`
(`fixtures/utils.py::is_identifier_invalid`, which asks lxml), at most 32
characters for a tag; Nova's lookup grammar widens to it (today
`^[A-Za-z_][A-Za-z0-9_]*$`, `lib/lookup/constants.ts`), except tags containing
the `casedb` and `ledgerdb` substrings above and, where an expression reads
them, names holding a character other than Core's name characters (such as a
letter without case, a titlecase letter, a combining mark, `·`, `‿` or `€`, all
of which lxml admits), which Core's XPath cannot read; a table tagged `types` can be referenced but not adopted, since a workbook's `types` sheet holds every table's definition (`fixtures/upload/workbook.py`). The same limit
refuses a case property holding any other character `validate_property`'s
Unicode `\w` accepts (a letter without case such as `名字` or `محل`, a titlecase
letter, a digit other than a decimal one such as `½` or `⁴`, or a character
outside the Basic Multilingual Plane such as `𐐀`): but the bind HQ writes for the
update does not parse in Core, which Formplayer's `validate_form` runs during the
build, and any expression reading the property breaks (executed). A language keeps its meaning (Nova's ISO 639-3 identity, for the
registry and translation) apart from its wire code (the HQ code, held exactly).
A name form that breaks a consumer is refused, because renaming it would change
data.

### What the reader does with each field

Every field on the surface has exactly one disposition:

- **Held.** Nova's model expresses it; the reader reads it and the emitter
  reproduces it.
- **Target-owned.** It belongs to the project space or HQ's server, not the app
  (`build_spec`, `build_profiles`, `secure_submissions`,
  `practice_mobile_worker_id`, `custom_base_url`, `features.credentials`, the
  media map). Nova writes only the target's own value for it: HQ's overlay merge
  and Nova's profile overlay keep a project-space setting at the target's value,
  and, from step 2, the ledger's identities, below, are written back as recorded. Target-owned also covers the identities each project space gives the
  app: its app id, menu and form ids, each form's `xmlns` there (the document
  holds `Form.xmlns`, the one a new project space takes), and a case search
  endpoint's id. From step 2 the deployment ledger records those per target (today Nova mints
  new ones on every publish, defect 1): at import, at a space's first
  publish (the ids Nova mints, and the endpoint id the person gives), and, for a
  deployment that already exists when this ships, in the step 2 cutover, which
  reads them from HQ (see "Identity"). Nova then writes them back
  from the ledger on every publish. Only top-level application keys and the profile properties HQ derives for
  the target (Settings and profile) are target-owned in the overlay sense:
  `modules` is replaced wholesale on update, so anything inside a module or form
  is held, inert or refused, apart from values HQ writes itself on a build copy
  (a form's `version`) or gives the app as a ledger-recorded identity above. The
  logos are held content whose wire key, `logo_refs`, Nova leaves at HQ's value
  from step 2 (today it overwrites it whenever the Nova app has a logo;
  defect 14), because only HQ's
  session-authenticated logo uploader creates the media object a logo reference
  needs; the reader reads each logo that uploader holds through the media map. `case_sharing` is app content, not
  a project setting: it changes the generated XForm owner and adds a suite
  assertion (`xform.py`,
  `suite_xml/sections/entries.py::EntriesHelper.add_case_sharing_assertion`),
  and `cloudcare_enabled` is the app's own Web Apps switch (see "Platforms").
- **Inert.** Fields HQ's build and every runtime ignore, such as
  `vellum_case_management`, `display_separately`, removed case search labels
  and `search_filter`, `dynamic_search`, `print_template`, referral actions,
  `load_from_form` (HQ's App Summary reads it until the next form builder
  save clears it), `task_list` when not shown, `filter`-format columns, orphan
  XForm attachments of deleted forms and disabled profile settings. Nova does
  not hold them; the proof confirms that nothing a runtime or HQ's servers act on
  changes (pages that only describe the app, such as App Summary, do not count; a disabled setting or a `filter` column can still leave bytes, such as
  a stored profile value or an unread header string). Some still get a
  written value on export, such as the add-ons that make HQ's editors show the
  pages that own Nova's content.
- **Refused.** Everything else, including anything the reader does not
  recognize.

### How the reader works

- It reads the stored source plus form JSON, never built artifacts. Built forms
  interleave HQ-generated case blocks, preloads and meta with authored content,
  and have their `vellum:` hashtags stripped and itext ids merged.
- It treats HQ-generated content as derived: form-action case blocks exist only
  at build (`models/forms.py::FormBase.render_xform`); SaveToCase blocks are
  authored and stored in the source.
- It reads `#case/…` as the module's typed case reference and `#user/…` as the
  usercase, not session user data: HQ interpolates `#user` in filters to the
  usercase (`xpath.py::interpolate_xpath`), and Nova's `session-user` reads a
  different source.
- It gives the imported app a new random UUID, and derives every entity under it
  as UUIDv5 over the app's UUID and a key per entity kind, so two readings of the
  same HQ app (the import, and each later drift check) give every entity the same
  Nova id. One HQ app is managed by one Nova app: importing an HQ app that another
  Nova app already publishes to is refused, and the refusal names that app when
  the person can open it.

  | Nova entity | Key |
  |---|---|
  | module | module `unique_id` |
  | form | real form `unique_id` (shadow forms share their parent's `xmlns`, so `xmlns` cannot key a form) |
  | field | form key + full data path |
  | inline select option | field key + option value |
  | case-list column | module key + source (property, or the calculated expression's canonical text) + format + ordinal among columns with the same source and format |
  | search input | module key + case property name |
  | default filter | module key + property + ordinal |
  | case operation | form key + the transaction's submission placement + action (create, update or close) |
  | form link | form key + target key + ordinal among links to that target |
  | entry point | owner key + kind (menu, case list or form); for a form mirrored by a mirror menu, the mirror menu's key + the mirrored form's key |
  | worker property | worker-data slug |
  | organization level | location type code |
  | location property | location field slug |

  Lookup tables are Project data and are matched through the deployment
  ledger's mapping by tag, never by a derived UUID, because HQ's own table and
  row ids change whenever a workbook upload re-creates a table or a row. An
  imported table whose tag matches a Project table the ledger already maps to
  that HQ table is that table; a tag that matches any other Project table is
  refused, naming both, and the next step is to import into a Project with no
  table of that tag.
- Its output is one construction batch that passes the absolute gate, born
  through the same genesis writer as every other app (absolute gate, export
  readiness, sequence-1 baseline) as a third birth owner beside `explicit-blank`
  and `design-slice` (`lib/db/appGenesis.ts`). Lookup tables and media are
  materialized in Project storage through the governed Project-data path
  atomically with sequence 1. The HQ app itself is recorded in the deployment
  ledger as explicitly adopted; today only lookup tables and locations can be
  adopted (the `adoptResourceIds` input in `lib/deployment/preflight.ts`).
- A feature becomes readable only when it is also editable in the builder, the
  SA and MCP, as the contracts require of every vocabulary.
- Import never changes an app to make it readable. It refuses, with the place and
  the reason, and the person fixes the app in HQ and imports again.

---

## What HQ's API provides

### Reads

| Need | Source | Requires |
|---|---|---|
| App content and authored XForms | `GET /a/<domain>/apps/source/<app_id>/` (`views/apps.py::app_source`; Nova already calls it) | edit-apps permission |
| Real form ids | `api/resources/v0_4.py::ApplicationResource`, aligned to the app source by module `unique_id` and form position and confirmed by `xmlns` (`dehydrate_module`); matched to Nova forms as under "Identity" at the migration | API access |
| Lookup table definitions and rows | `fixtures/resources/v0_1.py::LookupTableResource`, `v0_6.py::LookupTableItemResource` | API access |
| Locations and levels | `locations/resources` (already read by `lib/deployment`) | API access, the locations privilege, and the account's Edit Locations permission (`locations/resources/v0_5.py`, `v0_6.py`) |
| Media bytes | the URL HQ's media map records for each item (`hqmedia/models.py::HQMediaMapItem.url` → `hqmedia_download`), the same URL HQ embeds in apps | the media map entry |
| Toggles | Nova's existing probe (`user_domains?feature_flag=`) | membership of the credential's user in the project space |

A module that fails HQ's own summary (`ApplicationResource.dehydrate_module`
catches the exception and returns an error in place of the module) loses its
forms' real ids, and the import refuses. Worker-field and location-field
definitions and the data dictionary are readable only in a browser session; the
reader does not need them, because property and worker-data types come from how
the app uses them.

### Writes

`POST /a/<domain>/apps/api/import_app/` creates or updates.

- **Create** re-mints every form `unique_id` and report `uuid`
  (`_import_app` → `export_json` → `scrub_source`), keeps module `unique_id` and
  form `xmlns`, drops `build_spec` (so HQ applies its current default), and sets
  `cloudcare_enabled` from the target's plan; from step 4, Nova's in-place update
  that follows every create writes the app's own value (today Nova sends none).
- **Update** (`overwrite_app_from_source` → `_merge_source_into_app`) writes every
  id verbatim, replaces each top-level key present in the upload, keeps absent
  keys, never changes `build_spec`, `multimedia_map`, `build_profiles`,
  `custom_base_url` or `practice_mobile_worker_id` (`ApplicationBase._update_excluded_fields`,
  plus `build_spec` in `_merge_source_into_app`), deletes form-source blobs it
  replaces, and answers 400 for a doc-type mismatch or a deleted app. `name` is
  excluded from the source merge, but the update's `app_name` parameter renames
  the app (`views/app_import_api.py::_handle_import_app` passes it as an extra
  property, which `_merge_source_into_app` applies after the merge), so a rename in Nova reaches HQ and its devices through `app_name` on
  every publish. The update has no compare-and-swap: a save racing it is a 500,
  and an HQ save that lands between Nova's drift read and its upload is
  overwritten without notice. HQ's merge runs in memory with no database, and wrapping an HQ-stored
  app needs only a blob-store seam (its `external_blobs` make `BlobMixin.wrap`
  ask for the database name), which is what lets the proof build exactly what HQ
  builds after an update.

---

## Completing Nova's model

Each part below is a complete feature when it is built: domain, validator,
emitter, Preview, builder, SA and MCP surfaces, public docs, proof, and the
reader once the reader exists (step 6 of "Order of work", which sets the
sequence).

### Identity

- HQ's ids for an app's menus and forms belong to each project space. The
  deployment ledger records, per target, each menu's `unique_id` and each form's
  `unique_id` and `xmlns` against the Nova entity, as it already records remote
  ids for lookup tables, and every publish to that target writes them back. From
  then no target's ids change on a republish, apart from the one-time changes
  the step 2 cutover names below.
- Nova keeps one `xmlns` per form (`Form.xmlns`), minted inside the
  creating mutation, or read from HQ on import. A project space Nova creates the app in
  takes it, because HQ's create keeps `xmlns`. HQ's create re-mints form ids, so
  the create is followed at once, inside the same publish and before any build
  can exist, by an in-place update that writes Nova-minted menu and form ids,
  and the ledger records them; HQ's re-minted ids are never observed.
- A `.ccz` Nova compiles for a project space it publishes to uses that space's
  recorded ids and `xmlns`; one compiled for no project space uses `Form.xmlns`
  and menu and form ids derived from the Nova entities' UUIDs, including the hidden menu the emitter inserts for a
  search-no-matches form (a registration from the case list after defect 30).
  The HQ import file, which the person uploads where they choose, carries the
  same ids as a `.ccz` compiled for no project space. HQ's create sets
  `cloudcare_enabled` from the project space's plan whatever the file says
  (`models/applications.py::_create_app_from_doc`), and no in-place update
  follows a manual import, so the file's instructions tell the person to turn
  Web Apps off in the app's settings after importing an app that does not
  declare it.
- Existing apps get `Form.xmlns` minted locally, with no call to HQ. The step 2
  cutover then reads every existing deployment from HQ, with the stored
  credential of the person who created that deployment or, failing that, of
  another current member of the app's Project whose credential reaches that
  project space, taken in the order members joined the Project, each read
  falling back separately in that order: the space's current menu ids and `xmlns` from its app source (edit
  permission is enough) and its form ids from `ApplicationResource` (which needs
  API access). It matches each HQ form to the Nova form whose question paths, in Nova's
  emission of the pre-step document, share the most with it, requiring more than
  half of the HQ form's paths, one to one: pairs are taken in descending order
  of shared paths, then by equal position, then by HQ form position, and a form
  already taken is skipped. Menus are matched one to one the same way, over the
  menus of that emission (the hidden menu the emitter inserts for a
  search-no-matches form is one, holding that form): each pair of a Nova menu and an HQ menu
  holding at least one of its matched forms counts those forms, pairs are taken in descending order of
  that count, then by equal position, then by HQ menu position, and a menu
  already taken is skipped; a menu with no forms (a case list menu item alone)
  pairs with an untaken HQ menu at its position with the same case type and no
  forms. The cutover records them, so that space keeps its ids; a Nova menu left
  without a pair takes a Nova-minted id, so its id changes once more at its next
  publish, and the notice names it. A form edited in Nova or in HQ since its last publish still matches while
  most of its questions remain. Where the space lacks API
  access, the cutover records Nova-minted form ids, so its form ids change once
  more at its next publish; anything that does not align likewise takes
  Nova-minted ids. The cutover records whose stored key read each
  deployment, since HQ's logs show that person, and the notice also goes to
  that person. A transient failure (no answer, a
  timeout, a 5xx or 429) stops the cutover before its first write, the
  maintenance window ends without it, and it is run again; a deployment that
  fails the same way on that second run is treated as one no credential can
  read; every other failure (a redirect, a 400, a body that does not parse)
  counts as unreadable too. A deployment whose HQ app HQ reports deleted is ended, and the
  ledger keeps its HQ app id as history. A deployment no credential can read
  keeps its HQ app id: the cutover records Nova-minted ids for it and, as its
  drift baseline, the source Nova would now publish, so its next publish stops at
  the drift check, and once the person discards HQ's copy its menu ids, form ids
  and `xmlns` change once more, with defect 1's harms that one time (form exports
  split, UCR form sources and form forwarding detach, SMS surveys stop at the
  next release, and Android cannot reopen incomplete forms), and never again;
  the same HQ app and its devices continue. The migration names
  every deployment in each of these cases.
- The deployment ledger also records, per target, the canonical app source Nova
  last pushed there or, after an import, read. That record is the drift check's
  baseline. An import records the source it read, a create records its creating
  publish, and the step 2 cutover records the source it reads for each existing
  deployment, so every target is checked from its next publish. HQ-side edits
  made before the cutover to what Nova writes today are part of that baseline,
  so the next publish overwrites them, as every publish does today; the
  migration says so for each deployment.
- When a step makes Nova own a setting its publishes left at HQ's value until
  then (`cc-show-saved` and `cc-show-incomplete` in step 2; `auto_gps_capture` (after defect 4, stored as
  `Form.autoCaptureLocation` on every form, the app key then written `false`),
  `case_sharing`, `appSettings` and `menuStyle`'s application keys,
  `use_grid_menus` and `grid_form_menus`, in step 7; a menu's own style sits
  inside `modules`, which Nova already writes whole), apart
  from the platform declaration, which follows "Platforms", that step's cutover
  reads each existing deployment's current value, as above, and stores it in the
  document. Where an app's deployments disagree, it stores HQ's default and
  names each deployment whose next publish changes the value, with what its
  users will see; an app with no deployment the cutover reads keeps what its
  local `.ccz` gives it today, and the notice names each deployment the cutover could
  not read, whose next publish may change these settings for its users. Step
  7's `androidLogos` start empty in existing documents, as Nova holds no Android
  logo today, and publish never writes them.
- Once ids are stable, a form updated in place keeps its HQ validation-cache key,
  so HQ's App Preview can show a verdict up to 7 days old for it. Nova never
  publishes a form Core rejects, so a stale verdict for a Nova-published form is
  "valid" unless an earlier version was rejected: a Nova defect already fixed, or
  an HQ-side edit the person discarded. Publish states that HQ's App Preview may
  lag for up to 7 days after either, and "Make new version" is never affected.

### Expressions

Menu and form display conditions, the case-list filter, calculated columns,
every search expression and every case-operation value are a closed typed
vocabulary today (`lib/domain/predicate/types.ts`) compiling to device XPath,
CSQL and Postgres. Form logic is stored as XPath text with a few identity leaves
(`lib/domain/xpath/ast.ts`), so relative paths and case-database queries are
opaque text that renames do not reach. Neither covers what CommCare evaluates.

What CommCare evaluates is finite:

- **JavaRosa functions:** 76 names in `ASTNodeFunctionCall.buildFuncExpr`
  (`FunctionUtils.funcList` has 75 because `is-selected` is a second name for
  `selected`), plus the form handlers `jr:itext` and `jr:choice-name`, and `here()`, which
  case lists and details evaluate through each runtime's location handler.
  Nova's function table contains all 76.
- **Instance sources:** every runtime dispatches the instance source string in
  one order (`CommCareInstanceInitializer.generateRoot`): contains `ledgerdb`,
  contains `casedb`, contains `fixture` (lookup tables, `user-groups`,
  `locations`, `commtrack:*`, `schedule:*`, `indicators:*`, reports,
  `case-search-fixture:*`), contains `session`, then prefixes
  `jr://instance/remote`, `jr://instance/selected-entities` and
  `jr://instance/search-input`. Formplayer and Android add no sources. HQ
  declares instance ids through 10 factories over 18 scheme keys
  (`suite_xml/post_process/instances.py`).
- **CSQL:** 8 value functions (`date`, `datetime`, `double`, `today`, `now`,
  `date-add`, `datetime-add`, `unwrap-list`) and 14 query-function names with 13
  behaviors (`not`, `match-all`, `match-none`, `selected` as an alias of
  `selected-any`, `selected-all`, `starts-with`, `fuzzy-match`,
  `phonetic-match`, `fuzzy-date`, `within-distance`, `subcase-exists`,
  `subcase-count`, `ancestor-exists`), in `case_search/xpath_functions`. Related
  lookups (`subcase-*`, `ancestor-exists`, ancestor comparisons other than on
  `@case_id`) raise unless the project space has `case_search_related_lookups`.
  Nova emits HQ's names; the constructs Nova cannot express are `unwrap-list`,
  `selected*` with runtime-assembled values, `within-distance` with a runtime
  radius or unit, distance units other than miles and kilometers, `closed_on`, authored `@case_type`
  comparisons, project-timezone day semantics on `date_opened`, `closed_on` and
  `last_modified`, `date(<int>)` and `datetime(<number>)`, runtime choices among
  CSQL clauses beyond input presence, and runtime values read from the case
  database, session datums or the session context. CSQL whose property names, operators or function
  names are computed at runtime is refused (below).

Nova's expression model becomes total over these: a type at every node and a
stable identity for every reference (fields including relative paths, case
properties at any relation depth, lookup tables and fields, location types,
user groups, worker data, session datums, search inputs and results, selected
cases, `jr:itext` strings).
It replaces both today's closed vocabulary and today's text-with-leaves form
logic, so it changes apps Nova builds now as well as imports. Preview runs form
logic in its client-side engine (`lib/preview`) and compiles case queries to
Postgres through `lib/case-store`'s compiler, which stays the only case-query
evaluator; compiling the typed model to both is part of the model. A search filter whose CSQL is assembled as text at
runtime from arbitrary pieces has no typed reading and is refused; the typed
model holds the search semantics those pieces express.

### Reference targets

**Lookup tables.** HQ's model (`corehq/apps/fixtures/models.py`): a table has a
tag (the only wire name: fixture `item-list:<tag>`, elements `<tag>_list` and
`<tag>`), `is_global` (default false: a user receives only rows owned by them,
their groups, or their primary location and its ancestors), ordered fields each
with a list of property names and an indexed flag, row attribute names, and a
description. A row holds, per field, a list of values each carrying its own
property values (the device sees `<name lang="en">…</name><name lang="hin">…</name>`),
plus attribute values and a sort key. Nova's lookup model gains all of it: field
properties and multi-valued fields, row attributes, non-global tables with user,
group and location owners, per-field indexing, HQ's name grammar, the three
absence states (field missing, zero values, empty string), HQ's size, and
app-side references to properties and attributes. Its `text` columns already hold values as strings,
byte-exact, and every imported cell lands in one once the 64 KiB per-cell cap
(`lib/lookup/coercion.ts`) grows with the table caps; its typed columns (int,
decimal, date, time, datetime) would refuse or reformat values such as `007` or `1.50`. HQ caps one workbook upload at 500,000 rows over all
its sheets, the types sheet and header rows included
(`fixtures/upload/const.py::MAX_FIXTURE_ROWS`, `WorkbookJSONReader`), and a
workbook leaves tables it does not name alone (`run_upload.py` processes tables
with `delete_missing=False`), so Nova splits a push into workbooks under the cap;
Nova's per-table caps grow to hold any table HQ holds, and a table too large for
one workbook can be referenced but not adopted. Until step 7 gives the model
field properties, indexed fields, row attributes and owners, import refuses an
app that reads a table carrying them, or a table that is not global, naming the
table.

HQ's workbook upload (`fixtures/upload/run_upload.py::_run_upload`) matches a
table by its tag, globality, fields, attributes and description
(`run_upload.py::table_key`). With `replace`, which Nova passes, any difference deletes the table and
re-creates it with new row UUIDs (without it HQ refuses the change unless the
workbook carries every existing row, `_would_discard_rows`), and a workbook without property or attribute columns deletes
existing properties, attributes and their values (executed). The workbook is the
only write path that carries owners (the row API,
`fixtures/resources/v0_1.py::LookupTableItemResource`, has no owner field), so
Nova pushes every adopted table the one way, as a workbook that writes every
field, property, attribute, owner and row order exactly. The workbook has
no description column (`fixtures/upload/workbook.py`), and no API can set a
description after a table exists, so the first push of a table that has one
clears it and re-mints its row ids, exactly as HQ's own bulk upload does. No
device reads the description or the row ids (`fixturegenerators.py::to_xml`), so
Nova does not hold the description, and adoption says the push will clear it. A
description someone adds in HQ later stops the next push until the person
confirms clearing it again.

A table the app only reads, and the person has not adopted, is held in the
Project for Preview and validation. Import records it in the deployment ledger as
a referenced table, identified by its tag in that project space, which Nova
never writes and does not let anyone edit until it is adopted. Before each
publish of an app that reads it, Nova reads it in the project space that holds
it, with the publisher's credential where it reaches that space, and otherwise
with that of the member who imported the reference, then of other current
members of the Project in the order they joined; each read with another
member's key is recorded and shown to that member, as in the step 2 cutover.
Where none reads it, publish stops, naming the table and the project space. Where the read succeeds, a change to what the app reads (its fields, properties or attributes) stops
the publish, naming the table and each app of the Project that reads a changed
field, and offers to take the new definition into the Project copy, which it
applies only when no app of the Project reads a field or property HQ removed or
renamed, and otherwise names each such read, whose removal is the next step; a change to its rows refreshes the Project copy, still with no write
to HQ. Publishing to another project space creates the table there from
that copy, as a table Nova created. Adoption belongs to
a Project table and a target together, so once a person adopts a table for a
project space, every app of the Project that reads it publishes it there. A
Project table is editable only while no project space holds it as referenced;
adopting it in every project space that references it makes it editable.

**Locations** as the flat location fixture exposes them. Locations are app data
in Nova (`lib/organization`) and otherwise follow the lookup-table rules:
locations an app reads without adoption are referenced, held in the app for
Preview, never written in the project space that holds them, and read in
that project space, with the credentials a referenced table's read uses, before
each publish of the app, wherever it publishes (a change to a level or a location field the app reads stops
the publish, naming it; any other change refreshes the app's copy through the
organization store's transactional reference rules, contracts' "Locations and
restore scope"; and a location removed or archived in HQ that a persona, an
automation or an owner expression names stops the publish, naming each
reference); publishing to another project space creates them from the
app's copy, as locations Nova created; and adoption belongs to the app's
location and a target together.

**Session datum names** as held identity.

**Case search endpoints.** A module's search may name a case search endpoint: a
query a project space keeps outside the app, which Nova can neither read nor
edit (no API exists; the endpoint pages are browser-session admin views). HQ has
two kinds (`case_search/models.py::CaseSearchEndpoint.TargetType`): a ProjectDB
endpoint runs SQL and returns rows, and an Elasticsearch endpoint returns open cases of its configured case type (`get_endpoint_results`), and an id does not say
which kind it names. The app stores the endpoint's integer id
(`models/case_search.py::CaseSearch.case_search_endpoint_id`); HQ always runs
the endpoint's current version, so an HQ-side edit reaches every build, released
ones included, and a deactivated endpoint makes the search fail with a 400. When
the id is set (with a prompt or default filter, and `CASE_SEARCH_ENDPOINTS` on),
the query carries `<data key="x_commcare_endpoint_id">` and the results nodeset loses its case type filter and its related-case exclusion
(and, in inline search, also its open-status filter and the case list's filter;
`suite_xml/sections/entries.py`) (byte oracles
`test_suite_remote_request.py::test_remote_request_endpoint_id`,
`::test_remote_request_endpoint_is_unfiltered`,
`test_suite_inline_search.py::test_inline_search_with_case_search_endpoint`).
Prompts and default filters alike are sent as named parameters: a ProjectDB
endpoint binds each to a same-named `:name` SQL parameter with no check
(`get_project_db_fixture`; an unmatched key is ignored and an unmatched or
empty parameter becomes NULL), and an Elasticsearch endpoint drops the conditions
whose parameters were not supplied. HQ changed the ProjectDB binding after the
pinned commit (`project_db/user_sql.py::UserSQL._clean_parameters` at
`525becc2963`, 2026-09-28): a sent key the query does not name fails the search,
a default filter, `_xpath_query` and the search-only owner exclusion's key
included (`models.py::extract_search_request_config` removes only the
configuration keys), an unsent parameter becomes NULL and an empty one stays
empty. Nova cannot read the query, so on a menu that searches through an
endpoint a default filter is sent as its own named parameter, never as
`_xpath_query`, and the builder, SA and MCP say, wherever an input or default
filter is added there, that the endpoint's query must name it. Sort and
related-case settings do not apply, while claiming still works. The list and detail read each
result's fields by name. Both Web Apps and Android send the search through
`/phone/search/`, online only.

Nova holds an endpoint as a typed reference to project data it does not own,
covering both kinds. The document holds the endpoint under a name, with the
prompts and default filters sent as its parameters and the result fields the
list and detail read, declared by name. The deployment ledger holds its id per
project space, recorded at import for the source, because an id names no endpoint in
another project space on the same server (ids are global and looked up with
the domain, `case_search/utils.py::get_endpoint`) and possibly a different one
on another server. This is the one
reference to project data whose content Nova cannot read, held because apps that use endpoints must be importable; what the endpoint returns is HQ's
responsibility, and publish states that the app depends on an endpoint Nova
cannot see. Publishing to, or exporting a `.ccz` for, a project space with no
recorded id asks the person for that space's endpoint id first, and a `.ccz`
for no project space is not offered for such an app, since no endpoint id would
work there. Preview does not
run such a search: it says the search runs only against HQ's endpoint.

### Data types

When writers of one case property disagree, the property's type is the least
type that holds every writer's wire string losslessly. Only two joins between
different types stay typed: int with decimal is **decimal**, and single-select
with multi-select is **multi-select** (a single-select value is exactly a
one-token multi-select string, because option values contain no whitespace).
Every other mixed pair is **text**, which keeps every value and loses the typed
operations. Date with datetime is text, not datetime, because promoting a date
invents a midnight-UTC instant. `int` is 32-bit and `decimal` is a double; a
Vellum `Long` is refused, because no HQ editor can add one (`numeric.js`). A
date-and-time question that HQ's editors map straight to a case property arrives
as a date, because the untyped update node receives the answer as date data
(`Recalculate.wrapData`), so an imported writer of that shape is a date writer.
Nova writes a datetime property through a hidden sibling,
`nova_datetime_<question id>` (today `__nova_datetime_<id>`, which defect 13
renames), whose calculate is `if(p = '', '',
format-date(coalesce(p, ''), '%Y-%m-%dT%H:%M:%S.%3%Z'))`, which keeps the full
instant (`lib/commcare/xform/datetimeCaseValue.ts`); the reader recognizes exactly that sibling, and the date-and-time join under
"Platforms", as datetime writers. Nova's field rule
(`lib/commcare/validator/rules/fieldKindMatchesPropertyType.ts`) and operation
rule relax to this table, so the mixed-writer error Nova raises today goes away
for every pair the table joins.

When several selects write one property, the property's option catalog is the
union of their values by exact string, in first-appearance order (menu order,
then form order, then field order, then each field's option order). A value with
different labels takes the first writer's label and translations; each field
keeps its own labels in the form. A lookup-backed writer adds no static options.
A non-select writer makes the property text and drops the catalog.

### Questions

- **Question types:** every Vellum type HQ offers, each fully typed and
  validated: text, phone number, password, integer, decimal, date, time,
  date and time, GPS, barcode, single and multiple choice (inline or from a
  lookup table), label (minimal and acknowledge), hidden value, group, question
  list, repeat (user-controlled, fixed count, and model iteration over a query),
  image, audio, video, signature, face capture, document upload, Android app
  callout, save-to-case, and Connect blocks. Print callouts and ledger questions
  are retiring.
- **Query repeats** have a placement. Vellum's model iteration sets the
  repeat's ids and count once, by setvalues that run when the form loads, or
  when the parent row is added. Run in Core at Formplayer's commit on
  Vellum-saved forms, that shape behaves as follows:
  - Its query reads each form answer as it stands then: the value a load-time
    default set before those setvalues, and otherwise blank, since calculates
    are not yet computed and nothing has been entered. Its rows never follow a
    later change.
  - Nested in another repeat of any kind, it breaks once an earlier outer row
    has inner rows:
    Vellum's absolute `@current_index` counts the inner rows of every outer row,
    so form entry throws, or first gives rows the wrong case ids.
  - Under an ancestor whose relevance reads an answer a load-time default sets
    before those setvalues, it stays empty whenever those defaults leave the
    ancestor not relevant at load, even after the ancestor becomes relevant.
    Without such a default, its rows are built.

  Import refuses a model-iteration repeat that is nested in any repeat, sits
  under such an ancestor, or has a query reading a form answer no earlier load-time default
  sets. A count repeat whose count and row ids are calculated from the same
  query nests and follows relevance, and HQ's editor produces and keeps it. A
  new query repeat takes model iteration only when its query reads no form
  answer, it is not nested in another, and no ancestor's relevance reads form
  answers, and the count-repeat shape otherwise. There its rows follow the query
  while the form is filled in: a row keeps its position, so when the result
  changes a row's answers stay with that position and its case operations write
  to the case now there, and lowering the count removes no row. A row past the
  end of the current result holds a blank case id, which would make HQ reject
  the whole submission (`form_processor/casedb_base.py`, `IllegalCaseId`), so
  its case operations run only while its id is not blank. The placement is kept once published, like a case
  operation's. The model-iteration placement is valid only in the shapes import
  admits, so any edit that leaves a model-iteration repeat outside them, wherever
  in the form it is made (nesting it, placing it under an ancestor whose
  relevance reads an answer a load-time default sets before its setvalues,
  adding to its query a read of a form answer no earlier load-time default
  sets, or
  changing an ancestor's relevance or a load-time default its query or an
  ancestor's relevance reads), moves it to the count-repeat placement, as an
  identity edit the builder, SA and MCP state before it commits.
- **Repeat counts** follow CommCare's semantics: Core rereads `jr:count` during
  entry, so the count is live upward. Raising it adds rows; lowering it removes no
  row already created (`FormEntryModel.createModelIfBelowMaxCount` only creates,
  and no runtime offers deleting a counted repeat's row), so those rows and their answers, with the case
  operations in them, are still submitted. `jr:count` must be a path (`XFormParser` builds an
  `XPathReference` from it), so a repeat names its count question directly, or a
  hidden value whose calculate holds the count expression, the shape an HQ
  author builds in Vellum, which writes `jr:count` as entered
  (`mugs/types/group.js`).
- **Appearances:** a typed vocabulary holding exactly the values each runtime
  reads, with their per-platform behavior. Web Apps matches space-separated
  tokens, but takes a combobox's match type only from its second token.
    Android matches `compact` inside a select's appearance (and as the whole
  string, ignoring case, on a group, `FormEntryController.isHostWithAppearance`),
  `combobox` (and within a combobox, `multiword` or
  `fuzzy`), `gregorian`, `legacy`, `overlay-small`, `editable` and, for images
  only, `acquire` inside the string, as it does `quick` inside a compact select
  and `cancel` inside a Gregorian date; `intent:` at the start of an input's
  appearance and `floating-` at the start of a label's; and every other value
  (`minimal`, `quick`, `list`, `label`, `ethiopian`, `nepali`, `numbers` and the
  rest)
  only as the whole string, a few of them ignoring case (`WidgetFactory.java`, `ImageWidget.java`, `BarcodeWidget.java`, `TriggerWidget.java`, `DatePrototypeFactory.java`, `VideoWidget.java`; audio `acquire` has no reader, since Android builds `AudioWidget` only for `legacy`). Both
  runtimes read an appearance's token order and spelling, so Nova holds a
  multi-token appearance as the ordered list of its typed tokens, emitted in the
  order and spelling HQ stores; a string holding a token no runtime reads is
  refused, since dropping that token would change what Android matches in the
  whole string. So `fuzzy combobox` is fuzzy on Android and a plain
  combobox on Web Apps, and `minimal hint-as-placeholder` falls back to the
  default widget on Android.
- **Single-option selects**, refused today by `options.min(2)`.
- **Media**, brought into Nova's validated asset storage, never referenced
  unchecked. Nova holds a file when every platform the app declares plays it and
  HQ types it as the same kind, so an Android-only app keeps AMR, MIDI or raw AAC
  audio and HEVC or MKV video, and a Web-Apps-only app keeps ICO, SVG or AVIF
  images and H.264 High video; Preview shows a stand-in for a file only Android
  plays. Every platform plays PNG, JPEG, GIF, WebP and BMP; MP3, PCM WAV, M4A
  (AAC-LC, brand `M4A ` or `M4B `), FLAC and Ogg Vorbis or Opus; and MP4 (H.264
  Baseline or Main) and WebM (VP8 or VP9). Refused: TIFF, HEIF, AV1, MOV, AVI,
  Ogg Theora and H.263, which neither platform plays on every device or browser it runs on, and audio 3GP or M4A with
  another brand, which HQ types as video. These facts come from the vendors'
  documentation (Google's supported media formats at Android 6.0, CommCare's
  minimum; Chromium's codec list; MDN's format guides; Apple's Safari media
  guide), listed in the inventory's Media section; a planner reads them there
  rather than testing playback. The platform declaration gates media as it gates
  every feature ("Platforms"), and a change of declaration names each file the
  new platform cannot play. Media is per
  language, as HQ holds it. Each media reference holds its `jr://file` path: an imported
  reference keeps HQ's path, and a Nova-born one takes the path derived from its
  asset's bytes when it is made (`lib/commcare/multimedia/assetWirePath.ts`);
  Nova derives every path today and stores none; step 7's migration stores each
  existing reference's derived path, so no published path changes. Choosing
  another asset gives the reference that asset's path, a new file HQ receives
  through its multimedia upload. Logos differ: HQ holds them only through its
  logo uploader (Application), so a logo holds the uploader's slot path
  (`jr://file/commcare/logo/data/<slot><ext>`), which the migration also gives
  existing logos; that path appears only in Nova's local `.ccz`, since publish
  never sends a logo.

### Case writes

Authors and the agent say only what a form saves and where: this answer goes to
that property of that case. Where each write lands on HQ's wire is the
emitter's decision, never theirs, apart from the placement moves publish offers
(defects 12 and 22), and a plan never shapes it.

A form's case writes are one concept, its case operations. A form's own case,
the one it registers or loads, keeps its lifecycle on the form: `Form.type` says
whether the form creates it (registration), updates it (follow-up) or closes it
(close), with an open condition and a close condition beside it (a
registration's open and close conditions are new; today only a close form
carries a close condition), and a registration may also close the case it
creates. The operation on that case holds its writes and links, and its action
follows the form's type. Every other case's create, update and close is an
operation's. An advanced form has no implicit case: every case it loads is one
of its case selections (`Form.caseSelections`), its own case included. Its own
case is its last selection that is not auto-selected and has the module's case
type (the selection HQ's build itself treats as the form's case for a visit
schedule, `xform.py::_create_casexml_advanced`), or, in a form HQ counts as a registration
(`AdvancedForm.is_registration_form` for the module's case type), the case its
one open action outside any repeat creates, which wins where both name a
case (HQ also counts a form whose one open action is unlinked and inside a
repeat as a registration, but only when it loads nothing that is not
auto-selected, so that form has no own case and the action is an ordinary
create); that selection's close, and that open action's open and close
conditions, are the form's. A field's "saves to"
setting (`caseWrite`) is that field's view of a write in the operation on its
case, so the builder, SA and MCP keep offering it on the field, and HQ's three
wire forms for a case write read back into one Nova shape, which keeps a round
trip a fixed point. Two properties new to Nova belong to the write, not the field:
the ancestor path (`via`) and "save only if edited" (`onlyIfChanged`). A preload is
not part of a write; it is a default value that reads the case.

Each operation has a placement: a basic form action slot (HQ's Case Management
tab), an advanced action and its tag, or a Save to Case block. The emitter gives
a new operation the simplest placement that can express it, and never adds a
question to make one fit:

- A basic form action slot, in a basic form, when the operation targets the
  form's own case, one of its ancestors through an index path, the usercase, or
  a new child of the form's case; every value it writes is a question in the
  form; and each condition is one the Case Management tab offers (a select, hidden
  value or label question outside any repeat, where a child case in a repeat may
  also use that repeat's questions; equal to or having selected an answer, or
  true).
- An advanced action, in an advanced form, when the operation writes to or
  closes a case the form selects, or creates a case with indices, on the same
  terms for values and conditions, where HQ builds the result faithfully: a link
  whose relationship is chosen per submission names a selected case, and no link
  before it on that create names a case the form creates (otherwise HQ writes its
  binds on that case's block), and a repeat
  holds one advanced create, or at least two that carry indices (otherwise HQ
  writes their blocks at one path, `xform.py` `get_action_path`); and an advanced open action for a new case
  that no basic slot can hold (an extension, or a child of a case other than the
  form's own) and that after-submit navigation carries into a form of its case
  type, which needs the session datum only a form action provides
  (`entries.py::get_new_case_id_datums_meta`), so its module is an advanced
  module.
- A Save to Case block for everything else, such as a case picked inside the
  form, several related cases created together, a computed value or case type,
  or a condition the Case Management tab cannot state.

So an app needs the `save_to_case` privilege only when it truly uses Save to
Case. The placement decides the submission path of the case block, which is
external identity. The publish that first carries an operation records its
placement in the document through a new `publish-placement` app change, at the
revision it emits and before the upload, which joins the contracts' closed set
of change kinds as a mutation-bearing change that open builder tabs fold like
`autosave`, `mcp` and `chat` changes, keeping their undo history (step 5); the
same change records a query repeat's placement. Publish writes it only while
the document's head is the revision it emitted, and otherwise emits again from
the new head before any upload. An edit composed before that change landed,
which the newly held placement cannot express, is refused as a conflict, as an
edit a peer's earlier change invalidates is, and its tab shows the move for the
author to apply again. From then the placement is kept, apart from a move
publish offers that the person accepts, which a `publish-placement` change
records at once as a held placement, whether or not the operation was
published; an operation that has never been published otherwise takes the
simplest placement at every export. Only a publish
records placements: HQ's import file and Nova's `.ccz` carry the placements the
document holds, or the simplest, and an HQ app made from the import file keeps
no continuity with them. An edit the held placement cannot express, an undo included, moves the
operation to one that can, and, as with every identity edit, the builder, SA and
MCP say so before it commits. An imported operation keeps the placement it arrived with.
A placement holds
operations on one case only: a create or an update and, beside it, at most one
close of that case under its own condition, as a subcase's, an advanced
action's or a Save to Case block's close condition carries. A held placement keeps its
place; when a second create or update, or a second close, would take a
placement, the first unplaced operation in the form's order takes it and the
next takes the next simplest placement. A form's close of its own case takes
the placement of that case's operation unless its condition is one that
placement cannot state, and then takes a Save to Case placement of its own,
held like an operation's (defect 14).

Extension cases are authorable in HQ as a Save to Case link with relationship
`extension` and as an advanced form's opened case with an extension index; both
read into case-operation links. A new one takes an advanced open action in an
advanced form and a Save to Case block in a basic form, whose Case Management tab
offers only `child` for a child case, except that one whose new case after-submit
navigation carries takes an advanced open action, which makes its module
advanced (above). A module is emitted as an advanced module exactly
when one of its forms holds case selections or an operation placed on an
advanced action, or its case list or detail holds a state only an advanced
module builds ("Menus and case lists" names each), and every form in it is then an advanced form: each form in it
that loads a case holds that case as a selection from the module's own list,
tagged as HQ's editor tags a first load (`load_<case type>0`,
`advanced/case_config_ui.js::addFormAction`). HQ's advanced modules
have no parent selection, so a parent selection there becomes each form's
chained case selections (`caseSelections[].childOf`), which renames the session
datums its forms read. An edit that turns a
basic module advanced moves the published placements of every form in it, so it
is an identity edit for each of those forms. An edit that would make a module
advanced where HQ's advanced-module rules forbid it is refused, naming the rule:
registration from the case list unless every form loads the same one or more
cases, the last of the module's case type (`helpers/validators.py::AdvancedModuleValidator`),
or a multi-select case list, which advanced modules do not carry.

A capture reaches a case as a link write: a hidden value, `nova_url_<question
id>` (today `__nova_url_<id>`, which defect 13 renames), whose calculate builds HQ's form-attachment address from the submission's
`meta/instanceID` and the file's name, written to the property like any other
answer. The reader recognizes exactly that calculate, with any server and
project space in it, and the emitter writes the publish target's. HQ serves the
file to a person with the Submission History permission, or to anyone in the
project space when `VIEW_FORM_ATTACHMENT` is on
(`reports/views.py::_can_view_form_attachment`), so publish checks that flag for
an app that shows a link in a case list or detail, where mobile workers open it.

Also held: preload separate from update; conditional open and update; "save
only if edited"; `owner_id` writes; child types under more than one parent;
shadow forms of advanced forms; several selected cases per form, auto-selection
and computed datums. The emitter writes `case_references_data.save` for every
property a Save to Case block writes, exactly as Vellum computes it.

### Navigation and after-submit links

- **Menus and forms reachable only by link.** HQ apps hide menus and forms with a
  `false() and …` condition and reach them through form links, entry points,
  case-list actions or shadow menus. A condition that is `false()`, or a
  conjunction whose first term is `false()`, means "not on the menu", so Nova holds that as a first-class concept, with the rest of the
  conjunction held as the condition that applies once the item is back on the
  menu (it must still be a valid expression), and the emitter writes
  `false() and (<rest>)`, or `false()` when there is no rest. Nova refuses a display condition that simplifies
  to false today (`DISPLAY_CONDITION_ALWAYS_FALSE`); from step 2 any other
  condition false in every context is an ordinary condition, held as written,
  on import and in authoring alike, and that rule retires.
- **After-submit links follow CommCare's semantics.** HQ turns each form link
  into its own conditional stack frame from the raw condition
  (`suite_xml/post_process/workflow.py::_get_link_frame`), and Core pushes every
  frame whose condition is true (`CommCareSession.java::createFrame`), so every
  matching destination runs, last first. Nova's model becomes: after the form,
  every destination whose condition holds runs, in an order the author sets.
  "Otherwise" gives the either/or case its simple form, and it exists only when
  at least one destination has a condition. An otherwise to a menu emits HQ's
  navigation fallback (`post_form_workflow_fallback`), whose frame HQ conditions on the negation of every conditioned link, emitting none when no link has a condition (`workflow.py::_get_fallback_frame`); HQ
  offers no fallback to a form, so an otherwise to a form emits a link whose
  condition is the conjunction of the other links' negated conditions. The
  reader reads exactly these two shapes as otherwise, and nothing else. Nova's
  current guards
  (`lib/commcare/formLinkProjection.ts::planFormLinkGuards`) migrate by writing
  each link's implicit exclusivity into its condition, so existing apps behave the
  same. Self-links ("register another") become a first-class "start this form
  again" destination.
- Shadow menus (version 2), held as mirror menus (`Module.mirrorOf`), with the
  child mirrors HQ creates for a menu's child menus; registration from the case list, a case-list menu
  item beside forms, `root` and `parent_module` after-submit destinations, and
  "display only forms".

### Case lists and search

Of HQ's 24 column formats, Nova holds 18: plain, date, time since or until, phone,
ID mapping, late flag, search only, address, distance, markdown, the four map
formats, clickable icon, icon, conditional ID mapping and translatable text. It
holds 7 today; the rest are added. `address-popup`, `picture`, `audio` and
`graph` are retiring, `image` lost its editor when HQ removed its flag, and
`filter` emits nothing. Also detail tabs and
nodeset tabs, sort blank placement and labels, sort calculations, lists over
several case types, persistent case context, case list callouts, column-level
cache and lazy loading, empty-list text, and the search additions: prompt groups,
server-side sort, geocoder prompts, `search_on_clear`, custom related-case
properties, and additional case types. Search takes one workflow setting: list
first, search first, or skip to default results, where the last two may run
inline. List first is valid only in Android-only apps, because HQ is retiring it
for apps with Web Apps (`CASE_SEARCH_DEPRECATED_NORMAL_CASE_LIST`); Nova's
existing list-first modules in apps that declare Web Apps move to search first,
and the migration names each one. The case list as its own menu entry is likewise
one concept, whether or not the menu also has forms, and so is registration from
the case list, into which Nova's search-no-matches form entry migrates.

### Platforms

CommCare Classic never says which features run where, and many do not run the
same on both: of the 222 held menu, case list and search rows in the inventory
that apply to both platforms, 74 are marked as differing on at least one (1 of them only in a case the cell names), and of
the 164 held question rows that apply to both, 80 are. In Nova,
where an app runs is a first-class fact of every app: Web Apps, Android, or both.
Every feature carries, per platform, one of: runs; ignored without harm (with what
the user sees instead); unavailable (with what happens); or different (with the
difference). An app is valid only if nothing it uses is unavailable on a platform
it declares. The builder, SA and MCP show a feature's platform behavior where the
author works, so a platform-specific choice is always deliberate. Preview plays
each declared platform faithfully, using browser stand-ins for device
capabilities (camera, location, a typed barcode, the values an app callout
returns).

The declaration has a wire form HQ already defines: `cloudcare_enabled`, the
app's own Web Apps switch (`commcare-app-settings.yml`, permission `cloudcare`;
Web Apps lists an app only when the build it serves, the latest released build
or, under `CLOUDCARE_LATEST_BUILD`, the latest build, carries `true`,
`cloudcare/utils.py::get_web_apps_available_to_user`). An app that
declares Web Apps carries `true`, written on every publish with the `cloudcare`
privilege as a precondition, and an Android-only app carries `false`. HQ cannot
stop an Android install, so "Web Apps only" is a declaration Nova's validation
enforces and HQ does not.

The declaration is the author's choice, and authoring never infers it from a
feature. Import proposes one from the app's wire value and content, and the person
confirms it before the app exists; the migration of existing apps stores the
platforms each app's content runs on as its declaration. Publish
asks the person to confirm whenever the app's declared Web Apps value differs
from the target app's current `cloudcare_enabled`, because the next build Web Apps serves after that publish (the next release, or the
next build under `CLOUDCARE_LATEST_BUILD`) adds the app to Web Apps, or removes
it, for every user of that project space. On import, `false` proposes Android only, and `true` proposes Web
Apps, plus Android when everything the app uses is available there; the person
confirms it, or narrows it to Web Apps only. HQ turns Web Apps on whenever the plan allows it
for an app created by import, copy or template (`_create_app_from_doc`), while a
blank app starts with it off, so many apps meant for phones carry `true`. Such an app that uses something Web Apps cannot run (a date-and-time
question, an Android app callout) is invalid as it stands and is refused, with
the next step to turn off Web Apps in the app's settings in HQ, which removes
the app from Web Apps for every user of that project space at the next release; likewise an app
carrying `false` that uses something Android cannot run (inline search, a
multi-select case list) is refused, with the next step to turn Web Apps on.

A new app declares both Web Apps and Android, and its author narrows that
deliberately. The builder, SA and MCP offer a feature only where it is not
unavailable on any platform the
app declares, the same way the version floor keeps the vocabulary to what HQ can
build, so the agent never weighs platforms feature by feature. The date-and-time
question is therefore offered only in an app that does not declare Web Apps. It
is not dropped, because Android-only apps use it where it works, and importing
them would otherwise be refused for no gain. Nova does not emit one question per
platform: a single form serves both runtimes, and telling them apart inside it
would rest on the device id Web Apps happens to report, which is undefined
behavior.

Existing Nova apps predate the declaration. The migration stores for each app
the platforms its current content already runs on, which states what the app is
rather than choosing for it; the author may change the app, such as replacing a
date-and-time question to keep Web Apps. An app it declares Android only has
Web Apps turned off in the app at its next publish, which asks the person first,
as above, and for its users at the next release. An app whose
content runs on neither (a date-and-time question beside anything Android
cannot run, such as inline search or a multi-select case list; the date-and-time
question is the one held feature Web Apps cannot run today) is already broken on both. The migration declares it for Web Apps, which HQ turned on
for every app Nova created where the plan carries `cloudcare`, and splits each date-and-time question: the date question keeps the
original id and label, a new time question `<id>_time` (with a numeric suffix
on a collision) follows it with the same label and copies the original's
relevance, required state and hint, and the datetime sibling now
joins the two as `if(date = '' or time = '', '',
format-date(concat(date, 'T', time), '%Y-%m-%dT%H:%M:%S.%3%Z'))`, which reads the zone-less time as the device's or browser's local time on that
date and writes its offset, so the case property keeps full instants and its type; the reader
recognizes this join as the second datetime-writer shape. An expression that read the original reads the date
and time questions combined into one datetime value, so its type and its meaning
on Android are unchanged; the original's constraint and default value move to
the date question when they compare only its date, and otherwise are removed; a
default value that read a case property into the original becomes one reading
the property's date into the date question and its time of day into the time
question; the migration names each. HQ exports show a
date in the question's column and a new column for the time.

The platform facts that shape the most apps:

| Feature | Web Apps | Android |
|---|---|---|
| Date-and-time question | unavailable: "web entry cannot support this type of question"; a relevant one silently blocks submission | runs |
| Android app callout | unavailable; the placeholder text can be submitted | runs |
| GPS, barcode, audio, video | different: a map-picked point with altitude and accuracy 0, a text box, plain file uploads | runs with device capture |
| Face capture | different: a plain image upload | runs |
| Image upload | different: not resized; 4 MB limit | runs; 15 MB limit |
| Acknowledge label | different: auto-answered, so a required one never blocks | runs |
| Auto-GPS | ignored: the submitted location is empty | runs |
| Calculations using `now()`, `random()`, `uuid()`, `sleep()` | different: every calculation re-runs on every answer | runs: re-evaluated only when a dependency changes |
| `field-list` appearance | ignored | runs |
| Multi-select case lists | runs | unavailable: the menu silently does nothing |
| Search first, skip to default results, `search_on_clear`, prompt groups, hints, required and validation messages | runs | ignored: Android opens its own list or the query screen first, and drops the rest |
| Inline search, and "sync cases on form entry" | runs | unavailable: forms become unreachable ("Session Refresh Required") |
| Entry points (session endpoints) | different: launched by URL, with the flag checked when the link opens | different: claim posts skipped and relevancy ignored, so hidden forms open |
| Hidden search prompts; multi-select (`input_: select`), date and address prompts | runs | different or unavailable: hidden prompts show as editable; those input types vanish |
| `distance` column | unavailable: Web Apps sends no browser location, so `here()` is empty (or Core's São Paulo placeholder while the list is built) and the column is blank or wrong | runs |
| Audio on grid menus | ignored: the grid has no audio control | runs |
| Case list menu item | different: selecting a case leaves an empty list | runs |
| Map column formats, case list callout, barcode search prompt | ignored or unavailable | runs |
| The `icon_text_grid` case tile template | runs | different: icon and clickable-icon slots print raw media paths |
| Session values | device id "Formplayer", drift 0; `selected_cases` present | device values; `search-input` not loaded after a query, so reads throw |

The complete per-feature platform classification is in the surface inventory ([`inventory/`](inventory/README.md)).

### Application settings

Of HQ's 52 CommCare settings, 30 are held (19 profile settings, the 4 logos,
and `case_sharing`, `cloudcare_enabled`, `auto_gps_capture` (held per form), `use_grid_menus`,
`grid_form_menus`, `persistent_menu`, `show_breadcrumbs`), 4 are target-owned, 10
are not app content (disabled settings, two logging settings no runtime reads,
`custom_suite`, which HQ never emits, and RemoteApp fields, which an Application
cannot carry), and 8 depend on their value: `build_spec` is target-owned at or
above Nova's floor and refused below it. `lazy-load-video-files`,
`mobile_ucr_restore_version`, `target_commcare_flavor`, `application_version`,
`use_custom_suite` and `translation_strategy` are refused at non-default values
(`use_custom_suite` only suppresses details).
`location_fixture_restore` chooses which location fixtures a restore carries
(`locations/fixtures.py`). `should_sync_flat_fixture` gives the flat fixture to
an app whose value is `both_fixtures` or `only_flat_fixture` without reading the
project space's stored location-fixture setting; only `project_default` defers
to that setting, which is on unless someone turned it off
(`LocationFixtureConfiguration.sync_flat_fixture`, default true). HQ's settings
page offers the app's value, and the project space's Location Fixture page the
stored setting, only under the retiring `HIERARCHICAL_LOCATION_FIXTURE` flag
(`commcare-app-settings.yml`, `domain/views/fixtures.py::LocationFixtureConfigView`),
so no value but `project_default` is one HQ's editors produce under a
configuration HQ still supports. Wherever the space syncs the flat fixture, the
three values differ only in whether the hierarchical fixture also syncs, which
needs that flag, and no held app reads it, because `commtrack:locations`
references are retiring; so Nova holds the three as one state, derived for
every app, and writes `project_default` on every publish. Nova cannot read the stored setting, so publish of an app
that reads locations asks the person to confirm the flat fixture syncs, once
for each app and project space, recorded on that deployment record beside the
privileges; where it
does not, the app would read no locations (and where the flag is on and the stored flat setting is off, HQ points
every suite location read at the hierarchical fixture whatever the app's value,
`suite_xml/post_process/instances.py::location_fixture_instances`), so publish
stops, with the next step to turn the flat location fixture on for the
project space, which changes what every app there syncs: on its Location
Fixture page, which HQ shows only while the space has the retiring
`HIERARCHICAL_LOCATION_FIXTURE` flag (`domain/views/fixtures.py::LocationFixtureConfigView`),
and otherwise through Dimagi support. `only_hierarchical_fixture` is retiring. HQ emits `cc-show-saved` and
`cc-show-incomplete` in every build, `no` unless the app sets them, while Nova's
`.ccz` omits them and Android treats absence as yes, so the same app shows saved
and incomplete forms from a Nova `.ccz` and hides them when HQ builds it; Nova
writes both explicitly. Settings Nova holds are written as a key-level overlay:
publish reads the target's current value immediately before the upload, merges
the keys Nova owns, and writes the result, as it already does for the derived
keys in `profile.custom_properties`
(`lib/commcare/targetProfile.ts::projectUpdatedAppProfileForTarget`).

---

## Nova's exports stay inside HQ's editable envelope

HQ's editors enforce rules its model and build do not, and some HQ saves rewrite
stored data. Running HQ's vendored Vellum build over Nova's exported forms under
two project configurations, with a second round trip and every result parsed and
serialized by Core, and HQ's app-manager JavaScript and save views over Nova's
exports, gives the envelope Nova's emitter must stay inside.

**Nova emission HQ refuses, or an HQ save breaks, today:**
- `vellum:*` shadows containing `#form/…[predicate]` (any such authored
  expression, and always the constraint-collection lowering): Vellum cannot parse
  them and copies them into the real attribute, which Core rejects.
- `__nova_guard_*` case blocks: Vellum treats them as hand-written case blocks
  and drops their `@case_id` bind, so every submission reaching one has an empty
  case id.
- Every SaveToCase-based construct in a project space without `save_to_case`:
  a Vellum save drops all case attribute binds. Publish's privilege
  confirmation closes this.
- Lookup-backed search prompts without `sort`, and a search input named like
  one of the module's default filters: the Case List page cannot be saved.
- `previous_screen` in a multi-select module or under a multi-select root,
  and `module` under a multi-select root: form settings cannot be saved.
- Endpoint ids that are not `slugify` fixed points: menu and form settings
  cannot be saved.
- `form_filter` using `#case/@status`, `@case_id`, `@case_type` or `@owner_id`:
  HQ does not build it (its XPath check, which is also its build check, rejects
  it).

**Nova emission an HQ save changes:** SaveToCase wrapper conditions, case-leaf
constraints, typed datetime case leaves (the time is lost), SaveToCase
attachments, live create ids outside repeats (they become setvalues run when the form loads),
query-repeat wrapper relevance (dropped) and query-repeat `@count` calculates
(they become setvalues run when the form loads or a parent row is added),
blank per-language itext
(filled from the default language), an empty `case_references_data.save`
(rewritten to Vellum's computation), non-writing followups (a Case Management save
adds a no-op case update to every submission), `search_button_label`, the
classic search workflow (becomes Search First on a Case List save where HQ shows its workflow selector and CASE_SEARCH_DEPRECATED_NORMAL_CASE_LIST is off), single-date prompts without
`CASE_SEARCH_ADVANCED`, custom tiles where `CASE_LIST_TILE` is on without
`CASE_LIST_TILE_CUSTOM`, tile cells
without a font size and unplaced tile columns, extension `OpenSubCaseAction`s
(reset to child), hidden form links beside visible ones, and an unoffered
navigation fallback.

**Nova emission no editor can produce (saves keep it or rewrite it to an equivalent):** `__nova_*` names,
hidden values with children, default values that read form nodes by absolute
path, user repeats inside labelled groups, references to another block's `case/@case_id`, `#case/p` shadows for
properties HQ does not list, `<group ref>` repeat wrappers, an absent Connect
`work_area_id`, `case_preload`, `open_case.external_id`, registration
`update never`, close conditions on a question other than a select, hidden value
or label, or inside a repeat, `no_vellum`, path-only `logo_refs`,
`location_fixture_restore` `both_fixtures` without its flag, a partial
`add_ons`, hint media, label media on groups and repeats,
the `calculate` column format, non-menu `date_format`, sort type `string` and sort blanks, field plus
`sort_calculation` pairs, `custom_variables`, and empty
short case lists.

Each item's fix, with its in-envelope spelling and what it changes for people,
is a defect below: 2 (form display conditions), 3 (case references), 4
(add-ons), 12 (single-date prompts, custom tiles and other gates), 13 and 14 (XForm and settings
spellings), 15 (question and entry-point ids), 16 (hint media and label media
on groups and repeats), 21 (the classic search
workflow), 23 (attachments), 24 (extension subcases), 25 and 26 (counts and
query repeats), 27 (form links and the navigation fallback) and 28 (repeats
inside field lists). The emitter moves to those spellings, and Nova's own
validator encodes the editor rules so the envelope holds by construction. Two
more kinds of condition keep content editable in HQ. Target gates are checked at
publish: the flags and privileges named in the inventory (Save to Case, Connect,
lookup tables, session endpoints, the case-list form display condition,
multi-select and inline search, custom tiles, tile grouping, related-case search,
sort calculations, form links, child cases, case search itself) and the version
floor. Add-ons, which HQ's build ignores (INERT with a written value), are set by
Nova: each add-on its content needs (display conditions, calculated and icon
columns, child menus and child cases, the case list menu item, registration from
the case list, and the others the inventory's Add-ons table names) is set on
every publish.

Every node Nova's emitter adds to a form, hidden values and the groups and
repeats that hold them, is one of these, named `nova_<purpose>`, then, where it
has one, `_<owning id>` from the owning question, repeat or case operation's id
(never a Nova UUID), then any ordinal or kind the entry names, with a numeric
suffix when an author's question already has that name. Step 2 renames the nodes
Nova emits today to these names, apart from the repeat-count snapshots, which
step 5 removes (the others arrive with the steps that add them), with one case-type guard per operation, and names free of Nova UUIDs (today
each expression-targeted link has its own guard, named with the operation's
UUID, `caseOps.ts`):

- `nova_url_<question>`: a capture's link write.
- `nova_datetime_<question>`: a datetime case value, as a single answer or as a
  date-and-time join.
- `nova_count_<repeat>`: a repeat count that is an expression rather than a
  question.
- `nova_query_count_<repeat>` and `nova_query_id_<repeat>`: a query repeat's
  count and each row's case id in the count-repeat placement.
- `nova_constraint_<question>_<n>`: a count a constraint over a repeat's rows
  compares.
- `nova_caseid_<operation>`: a case id that more than one case block reads.
- `nova_guard_<operation>_<kind>`: a guard's Save to Case block, for a
  case-type, retype or text guard, whose case id is `if(<ok>, <id>, '')` with the id read from
  `nova_caseid_<operation>`; an operation has at most one case-type guard, which
  conjoins every link's check.
- `nova_condition_<operation>`: the group whose relevance carries a conditional
  update or close.
- `nova_operations`: the group holding a form's Save to Case blocks, each named
  by the id of its first case operation apart from guard blocks (above), at the root and inside each repeat that has them.
- `nova_selected_cases`, with `nova_update_selected_cases`,
  `nova_close_selected_cases`: the loop over a multi-select form's selected cases
  and the case blocks inside it.
- `nova_subcases` and `nova_subcase_<n>`: the held paths of child-case blocks
  Nova published before step 5 (extension child cases outside a multi-select
  form, in `nova_subcases` at the root or in the owning repeat; and in a
  multi-select form every child case a question's case write created, one per
  selected case, in the loop's `nova_operations`). A child case created after
  step 5 is a case operation named by its id.

Nova reserves no names. The reader recognizes each purpose by its name pattern,
suffix included, together with its exact calculate or structure, recognizes the same
calculate written inline on a Save to Case leaf, and reads anything else, an
author's `nova_` question included, as the author's own. An HQ app that still
carries Nova's former `__nova_` names (from a publish before step 2, or a repeat
count snapshot from a publish before step 5) fails Vellum's id rule and is
refused like any other invalid id; republishing it from Nova replaces them.

---

## Living with HQ after import

### Edits made in HQ

After import, Nova is the editor of record. Before every publish Nova reads HQ's
current app source and compares it with the source Nova last pushed there (or,
after an import, read),
recorded in the deployment ledger. The comparison matches forms by position,
because HQ's export replaces every form id on each read, and ignores target-owned top-level keys, the CommCare version, the defaults an HQ settings save
writes, and every key Nova's overlays leave at HQ's value (add-ons Nova's
content does not need, translation keys outside Nova's set, unowned profile
keys, `logo_refs`, XForm attachments no form owns, which HQ's update never
deletes). A changed menu id or `xmlns` in the app source counts as drift, and so
does a changed form id where the project space has API access, read from
`ApplicationResource` and aligned by module id and position; where it lacks API
access, form ids are not compared, because the app source replaces them on
every read. References the export rewrites along with the form ids (form links, the case
list form, a shadow form's parent; `models/base.py::form_id_references`, which also covers the refused visit scheduler's phases) are
compared as the positions of the forms they name; a clickable icon's endpoint
id, `excluded_form_ids` and `form_session_endpoints`, which keep their real
values, are compared as written. Until the reader exists (step 6 of "Order of work"), a difference stops
the publish, and the person may discard HQ's change, confirmed, but not bring
it in. From step 6, a difference still stops the publish, and Nova offers to
bring HQ's changes in: read HQ's current app, diff it against the reading of what Nova last pushed there (or, after an import, read), and apply the difference as ordinary Nova mutations on the current
document, with conflicts shown to the person. The diff matches entities by
external identity (module and form ids, `xmlns`, data paths, case transaction
placements), never by Nova UUID, because a Nova-born entity's UUID is not derived
from HQ's. Generic diff never synthesizes a case property rename (contracts), so
an HQ-side rename arrives as a remove and an add, and the merge view says so. The
person may instead discard HQ's change, which the next publish overwrites; if
they choose neither, the publish stops. If HQ's current app no longer reads
because someone added something Nova cannot hold, the person chooses between
discarding HQ's change and ending that deployment: the ledger keeps its HQ
app id as history, the Nova app counts as unpublished there, and the
deployment stays ended if HQ later restores a deleted app, which the person may
import, or publish to as a new HQ app. This covers every
app Nova publishes, whether imported or born in Nova. Media bytes are not
compared: publish writes Nova's file at each path Nova holds, so a file someone
replaced in HQ at such a path is overwritten.

### Shared project-space data

Lookup tables and locations are shared by every app in an HQ project space, and
other people maintain them. Nova edits such a resource only after the person
explicitly adopts it, the ownership model the deployment ledger already follows,
and holds the rest as referenced ("Reference targets"). Before every push Nova
reads HQ's copy; if HQ changed it since Nova's last push, the push stops. Until
step 6 the person may discard HQ's change, confirmed; from step 6 Nova also
offers to bring it in, and content the lookup model cannot hold before step 7
is refused, naming the table. The step 2 cutover records each pushed table's
and location's current HQ state as its baseline. Nothing Nova has not created or been handed is
ever written.

### Edits that touch identity

On a published or imported app, an edit that changes a name in the identity
table (a question's id or its place in the data tree, its type class, select
value, case type, case property, a case index identifier, a session datum name,
a case write's placement, including the position of a numbered child case
block that an earlier removal or reorder shifts, an index relationship, a group
turned into a repeat, an entry point id, a worker-data slug,
menu and form order, lookup table tag, field or field-property name, location
type code, language code, or an emitted node's name, which moves to a numeric suffix when an author gives a question that name) breaks HQ data continuity. The builder, SA and MCP say so before the change
commits; the contracts already allow external-contract names to require
confirmation.

### Preview data

An imported app arrives with no case rows in Nova. Nova does not copy case data
from HQ. Preview runs on data Nova generates from the app's typed model.

---

## How Nova knows

### The surface manifest

The manifest is the machine-readable form of the surface inventory ([`inventory/`](inventory/README.md)): every authorable field of every app_manager schema class (introspected
through HQ's own jsonobject classes), every detail format, every Vellum question
type and feature key, every flag and privilege that changes or blocks the build
or that publish checks or asks the person to confirm (such as
`VIEW_FORM_ATTACHMENT` and the project space's case search configuration),
every JavaRosa function, bind type, control and event, every runtime parser's
element and attribute vocabulary, the CSQL function set, each feature's platform
behavior, and each item's disposition and in-envelope emission. CI fails when an
entry has no disposition or when the regenerated surface differs from the
manifest, so a change in HQ becomes a classified diff (step 1 of "Order of
work" sets when it runs). Coverage is a number: "N of
M entries held." It replaces the existing flag audit
(`scripts/audit-commcare-hq-feature-flags.mjs`), which covers 7 of the 70
app-building flags, cannot see privileges or `FrozenPrivilegeToggle` and
`FeatureRelease` declarations, and fails today.

### Proof when a feature is built

Every feature enters Nova with native proof, extending the practice in
`scripts/fixtures/hq` and `scripts/fixtures/javarosa`. The proofs below compare an app A with Nova's
export A′. Until the reader exists (step 6 of "Order of work"), A is HQ's copy
of Nova's previous export, as HQ's own import leaves it; from then on, A is also
any HQ app the reader reads. A migration's decided identity moves, each named by
its defect, are the only identity changes proof 1 accepts:

1. **Identity.** Every identity in the identity table is equal after the round
   trip.
2. **Build equivalence.** `build(A)` against
   `build(_merge_source_into_app(A, A′))`, calling HQ's own merge under A's Σ.
   Both `validate_app` results and the `create_all_files` output are compared
   after a closed set of rules for spelling differences, each with its own proof
   that HQ's output does not depend on the difference it erases.
3. **Behavioral equivalence wherever any artifact differs.** CommCare Core
   produces identical traces for the same scripted sessions on both builds:
   screens, command ids, entity rows, question sequence and prompts, the
   normalized submission, the resulting case database, and the post-submit stack.
   HQ's own reading of both submissions
   (`corehq/ex-submodules/casexml/apps/case/xform.py::extract_case_blocks`) agrees, because HQ is where
   exports read the data.
4. **HQ editability.** HQ's Vellum build opens and saves every form of A′, and
   HQ's app-manager saves run over A′, leaving it unchanged up to the closed set
   of spelling rules (Vellum's added `<alert>` and `requiredCondition`, among
   others, each proven equivalent).
5. **Locality.** After a batch of edits, every entity outside the edits'
   footprint keeps its canonical digest.
6. **Fixed point.** read(export(D)) equals D once entities are matched by
   external identity, over everything HQ's app wire carries. The rest comes from
   the document the export was made from: Nova-born entity UUIDs (the reader
   derives its own), `Form.xmlns` where a project space keeps its own `xmlns` (the
   deployment ledger holds that one), the "Web Apps only" declaration (the wire
   says only whether Web Apps is on), lookup column types (HQ holds every value as a string), and
   the collections that never reach the app wire: user types, personas,
   automations, and case-property metadata beyond what writers imply, and the
   app's logos, which publish never writes, apart from defect 14's one cleanup.
   An import gives the collections empty and reads the logos HQ's uploader
   holds, and the drift check ignores all of them. Worker and location
   properties come from the slugs the app reads, typed from how it reads them,
   and the drift check compares those slugs.

The harness is one container image holding HQ, its virtualenv, node, the JDK,
Core, Formplayer and a headless browser with HQ's vendored Vellum, at the pinned
commits. What it runs has been executed:

- HQ's full `validate_app()` and `create_all_files()` run offline under HQ's test
  settings with six seams: flags off (`settings.DB_ENABLED=False`), no previous
  build (`ApplicationBase._get_version_comparison_build`), Formplayer's form
  validation replaced by Core's own `XFormParser` and `JSONReporter` (the body
  of Formplayer's `UtilController.validateForm`, run as a Java subprocess per
  form in place of HQ's request to Formplayer, never skipped),
  privileges, `get_xform_resource_overrides`, and the default build spec. The
  boot also rebinds HQ's quickcache to local memory after `django.setup()` and
  refuses Django's SQL connections, since a socket block alone does not stop
  `psycopg2`. Under it, 17 of the app JSONs in
  `corehq/apps/app_manager/tests/data` and its `suite` folder build clean,
  including advanced and shadow modules, and Nova's exports build with every form
  accepted by Core.
- HQ's `_merge_source_into_app` runs in memory with no seams, and `wrap_app` of
  an HQ-stored app needs only a blob-store seam: its `external_blobs` make
  `BlobMixin.wrap` ask for the database name.
- HQ's own app_manager tests run under pytest with that boot,
  and apps constructed by `app_factory.py::AppFactory` harvest cleanly. Harvested
  apps carry empty form sources, which HQ refuses to build, so the harness
  generates a source per form with a unique `xmlns`, one question per
  case-configuration path, and itext per language; with those, every harvested
  app generates its files, and 8 of the 11 pass `validate_app` (the other 3 have
  menus with no forms or case list).
- Session endpoints appear in the built suite only with `SESSION_ENDPOINTS` on
  and a CommCare version of 2.51 or later (a public-webform build forces the flag but still needs 2.51),
  so the proof sets each app's flags and version from its required
  configuration.
- Media: an HQ `.ccz` downloaded without media installs and runs in Core and
  Formplayer, because Core's `ArchiveFileReference.doesBinaryExist` returns true
  unconditionally. A remote-only or absolute `jr://file` media location, or a
  missing named file (the media suite, a form, the `default` locale), blocks
  install, while a missing file for another locale installs and fails only when
  that locale loads;
  missing bytes behind a `./` location do not. The harness installs the exact
  archives shipped (the local `.ccz` with its bytes, and HQ's shape without them)
  and checks each media entry separately. Exploded-directory installs do check
  file existence, and reference roots must be cleared between installs.

### The corpus

- Feature-matrix apps, at least one per inventory entry, built through HQ's own
  models so the shapes are authentic, plus generated combinations so features are
  proven together.
- The apps HQ's own tests construct with `AppFactory`, with generated sources.
- HQ's source-format test apps (`corehq/apps/app_manager/tests/data`) and
  template apps (`static/app_manager/template_apps`), for older shapes.
- Nova's own fuzz corpora, exported and read back.
- HQ-built `.ccz` apps from Formplayer, Core and Android tests, which check the
  harness itself: the same build twice must give identical traces.

In production Nova reads HQ to import an app, to check a target before publish
(its flags, the app's version, and HQ's current copy for the drift check), and to
publish. None of it re-verifies that Nova's features are correct.

### Compared with HQ and Vellum

| Concern | HQ and Vellum today | Nova |
|---|---|---|
| Upload accepted means buildable | import validates nothing | an app is imported only if it builds, is HQ-editable, is admitted by Core, and is a valid Nova app |
| Generated artifacts run | never parsed by Core at build | every held feature is proven through Core's parse, initialization and execution |
| Validator unavailable | a form new since the last build is never validated | unproven, so blocked |
| Validation cache | App Preview serves a verdict cached up to 7 days, stale after an update | never relied on |
| Content the editor does not model | Vellum drops it on save; HQ saves drop gated data | never admitted; refused at import with location and reason |
| Where a feature runs | never stated | declared per app, validated per feature, previewed per platform |
| Round-trip identity | HQ's own export scrambles shadow references | held and emitted exactly |
| Upstream change | noticed when something breaks | the manifest diff names it |

---

## Contracts this work changes

Each sentence below, in `docs/architecture/contracts.md`, the root `CLAUDE.md` or
a subtree `CLAUDE.md`, is replaced by the step named ("Order of work"), which
updates the contract when it ships. Every step applies the direct maintenance
cutover contract as it stands.

| Contract today | Replacement | Step |
|---|---|---|
| contracts.md: "Their authoring models and UI are not Nova requirements"; root `CLAUDE.md`: "the only admissible HQ facts are 'the wire accepts / rejects this.'" | Two more HQ facts bind Nova: every app Nova imports or emits is one HQ's current editors can produce and keep ("The bar"), and reading an app changes nothing that HQ's servers or existing data depend on ("The reader"). HQ's authoring models and UI still set nothing about how Nova authors. | 2 |
| root `CLAUDE.md`: "Nova speaks its own clean vocabulary; CommCare's wire vocabulary is quarantined behind `lib/commcare`" | The document also holds the external identities a round trip keeps (`Form.xmlns`, case-write and query-repeat placements, HQ's media path spellings, language wire codes), as identities no author chooses; authoring vocabulary stays Nova's ("Identity", "Case writes"). | 2, 5, 7 |
| contracts.md: "Nova emits one wire flavor: the maximal subset Web Apps supports, faithfully." | Nova emits for the platforms each app declares: Web Apps, Android, or both ("Platforms"). | 4 |
| `lib/commcare/CLAUDE.md`: "Each multiplicity scope gets a reserved `__nova_operations` container" | Nova reserves no names: each node its emitter adds is named `nova_<purpose>…` and recognized by its name pattern with its exact calculate or structure ("Nova's exports stay inside HQ's editable envelope"). Step 2 renames every such node but the repeat-count snapshots, which step 5 removes. | 2, 5 |
| `lib/commcare/CLAUDE.md`: "The expander requests `location_fixture_restore: "both_fixtures"`" | Nova emits `project_default`, and publish asks the person to confirm the flat location fixture still syncs ("Application settings"). | 2 |
| `lib/commcare/CLAUDE.md`: "HQ re-ids forms on import (`update_form_unique_ids` rewrites `form_id`) and not modules, so the expander pre-generates every form unique id before the module map." | HQ changes stored form ids only when it creates an app (its app-source export gives fresh form ids on every read, so drift matches forms by position); every menu and form id comes from the deployment ledger per project space ("Identity", defect 1). | 2 |
| `lib/media/CLAUDE.md`: "**audio is `audio/mpeg` (`.mp3`) and `audio/wav` (`.wav`) ONLY.**" | A file is accepted when every platform the app declares plays it and HQ types it as the same kind, from the vendors' documentation ("Questions", defect 11); until step 4 every app counts as declaring both platforms. | 2, 4 |
| `lib/lookup/CLAUDE.md`: "A tag is capped at 32 characters here, one past what a CommCare HQ data sheet can be named for, so the export boundary refuses the 32-character case by name" | HQ's upload reads a 32-character sheet name, so a 32-character tag pushes (defect 5). | 2 |
| `lib/commcare/CLAUDE.md`: "All itext entries (labels, hints, option labels) emit both `<value>` and `<value form="markdown">`." | Markdown is a property of each display text (defect 29). | 5 |
| `lib/commcare/CLAUDE.md` (Exclusive guards): "Core executes EVERY true `<create>` and lands on the LAST one" | Form links follow CommCare's semantics, with no exclusivity guards ("Navigation and after-submit links"). | 5 |
| `lib/commcare/CLAUDE.md`: "a deeply always-false condition is a soundness finding" | A display condition `false()` or `false() and <rest>` is the "not on the menu" concept, holding its rest; any other condition false in every context is an ordinary condition, and the soundness finding retires ("Navigation and after-submit links"). | 2 |
| `lib/commcare/CLAUDE.md`: "target-owned settings and state — `cloudcare_enabled`, `case_sharing`, `secure_submissions`, the build/release metadata, and the rest of HQ's app Settings page — are never emitted by `hqShells.ts::applicationShell`, and `logo_refs` is emitted only when the app has a Nova-authored logo" | `cc-show-saved` and `cc-show-incomplete` (step 2), `cloudcare_enabled` (step 4), and `case_sharing` and every other held setting (step 7) are app content Nova writes as a key-level overlay ("Application settings"); publish writes no `logo_refs`, apart from defect 14's one cleanup of Nova's own entries. | 2, 4, 7 |
| `lib/commcare/CLAUDE.md` (`count_bound`): "Nova promises an initial fixed count … They do not later track answer changes." | Repeat counts follow CommCare's semantics: raising the count adds rows, and lowering it removes none already created ("Questions"). | 5 |
| `lib/commcare/CLAUDE.md` (`query_bound`): "The membership list is an initial snapshot." | A query repeat has a placement, model iteration or a count repeat, kept once published ("Questions"). | 5 |
| `lib/commcare/CLAUDE.md`: "`subcaseWire.ts::hqCaseActions` therefore marks extension actions `never` while `xform/caseOps.ts` carries their active transactions in the source XForm, under a reserved `__nova_subcases` container" | Step 2 renames the container `nova_subcases` (defect 13); step 5 makes extension child cases case operations with an extension link, with no inert basic subcase beside them (defect 24). | 2, 5 |
| `lib/db/CLAUDE.md`: "Its closed kind set is `autosave`, `mcp`, `chat`, `blueprint-migration`, `fold-baseline`, and `project-move`." | The set gains `publish-placement`, which a publish writes to record the case-operation and query-repeat placements it first carries, and which feeds multiplayer like `autosave`, `mcp` and `chat` ("Case writes"). | 5 |
| contracts.md: "the closed kind set is `autosave \| mcp \| chat \| blueprint-migration \| fold-baseline \| project-move`." | The set gains `publish-placement`, which carries a nonempty admitted mutation batch and null Project-move columns ("Case writes"). | 5 |
| contracts.md: "The browser collaboration frame is intentionally narrower: it accepts only `autosave \| mcp \| chat`." | It also accepts `publish-placement`, which open builder tabs fold without a reload, keeping their undo history ("Case writes"). | 5 |
| root `CLAUDE.md`: "its mutation-bearing `autosave` / `mcp` / `chat` rows also feed multiplayer, while `blueprint-migration` / `fold-baseline` / `project-move` are server-only reload boundaries" | `publish-placement` rows also feed multiplayer ("Case writes"). | 5 |
| contracts.md: "An eligible field writes case data only through `caseWrite: { caseType, property }`" | A form's case writes are its case operations; a field's `caseWrite` is that field's view of a write ("Case writes"). | 5 |
| `lib/domain/CLAUDE.md`: "`registration` creates a case, `followup` updates one, `close` loads + closes (a superset of followup), `survey` touches no case." | A form's type is its own case's lifecycle; a registration may also close the case it creates, and its create and close each take a condition; every other case's create, update and close is a case operation ("Case writes"). | 5, 7 |
| `lib/domain/CLAUDE.md`: "`casePreload.ts` is the ONE statement of which answers a form seeds from the case it opened" | A preload is an explicit default value reading the case (defect 29). | 5 |
| `lib/domain/CLAUDE.md`: "A form's optional `entry` (`{ kind: "search-no-matches", label? }`) says how it is reached" | Registration from the case list is `Module.caseListRegistrationForm` (defect 30). | 5 |
| contracts.md: "Case attachment display is link-first. … The deprecated `MM_CASE_PROPERTIES` attachment mode is an explicit opt-in" | Attachment mode is gone; a capture reaches a case only as a link write ("Case writes"). | 5 |
| contracts.md: "App birth is a CLOSED two-owner vocabulary — `explicit-blank \| design-slice`" | Three owners, adding `hq-import`, all through the one genesis writer ("How the reader works"). | 6 |
| contracts.md: "A durable deployment record is keyed by Nova app, Project, HQ server, and HQ domain." | App records keep that key; a lookup table's adoption belongs to the Project table and the target together, so every app of the Project that reads it publishes it there ("Reference targets"). | 6 |
| `lib/deployment/CLAUDE.md`: "There is deliberately no arm for 'matched by name'" | Still no arm matches by name implicitly; import records each table an app only reads, and the person has not adopted, as referenced in its source project space, by its tag, and never writes it there ("Reference targets"). | 6 |
| `lib/deployment/CLAUDE.md`: "A publish creates afresh only when there is no active mapping, or when a persisted upload failure says the mapped app is gone" | A publish also creates afresh after the person ends a deployment whose HQ app no longer reads, or the step 2 cutover ends one whose HQ app HQ reports deleted ("Identity", "Living with HQ after import"). | 2, 6 |
| root `CLAUDE.md` (`lib/lookup`): "every export mode carries the data" | Every export mode carries every table the app reads, except that the HQ import file, which the person uploads where they choose, leaves out and names each table referenced in a project space. A table referenced in a project space is never written there; a local `.ccz` embeds Nova's copy, and publishing to another project space creates the table there from it ("Reference targets"). | 6 |
| contracts.md: "Long-detail tiles are out of scope." | The case detail tile is held, because HQ apps carry it ([the inventory's case list rows](inventory/menus-and-case-lists.md)). | 7 |
| contracts.md: "Smart-link authoring does not ship before Nova models data-registry search." | Smart links belong to data registries, which are retiring, so they never ship. | 1 |

---

## Order of work

Each step ends with a machine-checked exit criterion and carries the defects
listed for it under "Defects in Nova today". Proof comes first, so every later
fix lands with the proof that it holds. Each step that changes the stored shape
of Nova documents migrates all of that step's changes in one direct maintenance
cutover (`docs/architecture/contracts.md`), with its production scan first, and
leaves every document valid when it finishes. The plan for each step designs its
mechanisms within the decisions and constraints this document states.

1. **The manifest and the harness.** The surface manifest, the proof harness
   (proofs 1 to 5 under "Proof when a feature is built"), and the corpus. The
   manifest is regenerated against the pinned HQ commit on every pull request,
   and against HQ's main branch weekly, where a difference is reported as a
   classified diff. The weekly flag audit (`scripts/audit-commcare-hq-feature-flags.mjs`,
   its workflow `.github/workflows/commcare-hq-feature-flags.yml` and its npm
   script) is deleted, and the runtime flag probe reads the manifest in place of
   `config/commcare-hq-feature-flags.json`. *Exit:* every inventory entry is in
   the manifest with its disposition, and the harness reproduces the symptom of
   every defect visible in HQ's build, HQ's search, HQ's lookup upload, HQ's
   submission processing, Core's runtime or an HQ editor save: defects 1 to 10, 12 to 15, 21 and 23 to 28.
2. **Emission and publish fixes, with the small model additions they need.**
   Defects 1 to 16. The additions are `Form.xmlns` with the deployment ledger's
   per-project-space menu and form ids, explicit settings for saved and incomplete forms, the first-menu and
   parent-menu after-submit destinations, the always-false display condition
   holding its rest, a hidden value with neither a calculate nor a default (every
   `HIDDEN_INERT_VALUE` default of `''` migrates to it and the constant retires;
   one that writes a case property writes it blank on each submission unless the
   form preloads that property into it, as Nova does today for every writer of a
   follow-up form's own case (defect 29), which the builder, SA and MCP say where
   the author sets it), `localization.wireCodes`, UI string overrides and `uiStringCatalogKeys`, a sort
   column for lookup-backed prompts, and the accepted media set. Publish gains
   the version floor, per-privilege confirmation, and the drift check with its
   baseline, for the app and for the lookup tables and locations it pushes,
   beside defect 14's flat-location-fixture confirmation and logo upload offer; the
   step's cutover reads every existing deployment's ids and source from HQ
   ("Identity").
   *Exit:* an app created and then republished twice keeps every `xmlns`, form id
   and module id in HQ, and every `xmlns` in the local `.ccz`; proofs 1 to 5 pass on every Nova
   export for these defects; publish refuses a target below the floor or without
   a confirmed privilege; a second publish stops when HQ's copy changed since the
   first.
3. **Expressions.** The typed expression model, with typed CSQL composition,
   typed instance references and every CSQL construct the concept list names,
   replaces today's closed vocabulary and text-with-leaves form logic in apps
   Nova builds now, with session datums as held identity. Its migration declares,
   on the queried case type, each property an existing expression reads that
   the type does not list, with the least type its reads admit (text unless an
   expression orders it or does arithmetic on it), and names each. Defect 17. *Exit:* no Nova expression slot
   stores a reference as text, and the corpus stays green.
4. **Platforms.** The declaration, its wire form, its default at birth, the
   gating of features by platform (media formats only one platform plays among them), Preview per platform, and the migration of
   existing apps. Defects 18 to 20. *Exit:* every held feature carries its
   platform behavior; no app holds a feature unavailable on a platform it
   declares; and every platform cell that differs has a Preview test exercising
   it on that platform.
5. **Case writes, forms and navigation.** Case writes as one concept with
   derived placement, advanced-module emission for the placements that need it
   (with load actions carrying each form's existing case selection), query
   repeat placement, live repeat counts, the search
   workflow setting, form links with CommCare's semantics and "otherwise",
   `group.fieldList`, explicit preloads and markdown, and the renamed menu
   concepts. Defects 21 to 30. *Exit:* proofs 1 to 5 pass on every Nova export,
   including a republish after each migration.
6. **Import.** The reader, the `hq-import` birth owner, referenced and adopted
   project-space data (the ledger records, adoption, and the checks before each
   push), drift merging, the import entry points in the builder and over MCP, a cutover
   that merges each lookup table's per-app deployment records into one per
   Project table and project space (adopted where any app adopted it, Nova-created
   otherwise),
   and every `widen:` grammar change a HELD row of the inventory names that no
   earlier step builds, since the reader needs them. *Exit:* every feature-matrix app made only of held entries reads,
   re-exports and passes the proof, and every other app is refused with the
   right reason.
7. **The rest of the model.** Every HELD-NEW group in [the inventory's concept list](inventory/README.md) not built in steps 2 to 6, in the list's order (the cross-cutting
   `Field.appearance` and `localizedMedia` first, then application and
   settings, modules and navigation, case list and detail, case search, forms and
   case management, XForm, media and lookup data), including the lookup model's
   new content (field properties, indexed fields, multiple values, row attributes, owners and non-global tables),
   case search endpoints, the writer-type joins, and the remaining
   question types, appearances and column formats. Each group is its own step for
   the cutover rule. *Exit per group:* its
   feature-matrix apps read and pass the proof.

---

## Defects in Nova today

Each defect names where it lives, what goes wrong, the fix this document
decides, and what a person sees when the fix migrates existing apps. A migration
names every app and entity it changes in a notice on each affected app, shown
to its members until they dismiss it, and publish shows each change to HQ data
continuity before it reaches HQ.

### Fixed inside today's model (step 2)

1. **Identity changes on every republish.** `lib/commcare/expander.ts::expandDoc`
   mints fresh module and form `unique_id`s and form `xmlns` (`lib/commcare/ids.ts`)
   on every call, on the publish path (`lib/deployment/service.ts`) and the local
   `.ccz` path alike, and HQ's update writes them verbatim. Each republish splits
   form exports, detaches UCR form data sources and form forwarding filtered by
   form, breaks SMS surveys at the next release, and stops Android from reopening incomplete
   forms. Nova's comments saying "HQ re-ids forms on import" are true only for
   creation. Adding a language whose code collides with an existing one's, or
   removing one of such a pair, renames the other language's code (`lib/commcare/languageWire.ts::planLanguageWire`
   recomputes every code from the whole set), which moves its device locale,
   build profiles and UI strings. *Fix:* per-project-space ids in the deployment ledger and
   `Form.xmlns`, as under "Identity", and `localization.wireCodes`, storing a
   language's code when it is added (the migration stores each existing
   language's current code). *Migration:* the step 2 cutover reads and
   records each project space's current ids and source, as under "Identity". A
   space without API access has its form ids change once more at its next
   publish, as does any menu or form that does not align; a deployment whose HQ
   app HQ reports deleted is ended; one no credential can read keeps its HQ app
   id and takes Nova-minted ids, its next publish stops at the drift check, and
   once the person discards HQ's copy there its ids and `xmlns` change once
   more, with the harms above that one time;
   the first publish after the cutover of each deployment it read overwrites
   HQ-side edits made before it, as publishes do today; and the migration names
   every deployment in each case.
2. **Form display conditions HQ cannot build.**
   `lib/commcare/suite/displayConditions.ts::emitFormDisplayConditionForHq`
   writes `#case/@status` (and `@case_id`, `@case_type`, `@owner_id`), which HQ's
   XPath parser, also its build check, rejects ("Expecting 'QNAME', got 'AT'"),
   so such an app does not build in HQ. *Fix:* emit the expanded
   `instance('casedb')/casedb/case[@case_id=instance('commcaresession')/session/data/<datum>]/@status`.
   No visible change.
3. **HQ does not learn the case properties Nova's case operations write.**
   `case_references_data.save` is always `{}` (`lib/commcare/hqShells.ts`), so
   HQ's case-property inventory, case exports, the data dictionary and Vellum's
   case references miss them. *Fix:* emit Vellum's computation for every Save to
   Case block. HQ's export and data dictionary pages then list those properties,
   and Vellum stops reporting Nova's `#case/<property>` references to them as
   unknown questions.
4. **Republish overwrites HQ-side values.** `lib/commcare/hqShells.ts::applicationShell`
   writes `translations`, `auto_gps_capture` and a 10-key `add_ons` that drops
   `menu_mode`, `submenus` and `empty_case_lists` and forces
   `case_detail_overwrite: true`. *Fix:* for `translations`, Nova owns a closed
   set of keys: every HQ-generated app-string id (whose text Nova holds in the
   owning field, the app's per-language display name included) except
   `homescreen.title`, which no runtime reads and which keeps HQ's value; every
   key in a runtime's UI string catalog; and every language name. Because an update replaces `translations` whole, Nova's upload carries its value
   for each owned key it holds, leaves out each owned key it does not hold, and
   carries HQ's current value for every key outside the set. A stale HQ override
   is therefore removed, and can never outrank Nova's text or attach to a
   reordered menu. Nova writes an empty value only for a key in `uiStringCatalogKeys` that no
   language overrides: under `select-known`, any language's key,
   empty or not, makes HQ emit its own catalog text for that key in every
   language without an override (`SelectKnownAppStrings.get_app_translation_keys`
   takes the union of keys across languages). For `add_ons`, Nova sets each add-on its content
   needs to `true` and keeps every other at HQ's value, read just before the
   upload. For `auto_gps_capture`, which Nova today sets `true` only for a
   Connect app and otherwise `false` (`lib/commcare/expander.ts`), Nova writes
   `true` where a Connect app needs it and otherwise keeps HQ's value, until step
   7 holds it as `Form.autoCaptureLocation`. HQ-side add-ons stop disappearing, and every text Nova holds reaches
   devices.
5. **Nova's lookup push destroys HQ table content.** HQ's workbook upload keys a
   table on its tag, globality, fields (with their properties and indexed flags),
   row-attribute names and description (`fixtures/upload/run_upload.py::table_key`),
   and Nova's workbook always writes the table as global, never writes an
   indexed flag, and carries no property, attribute or owner columns
   (`lib/commcare/lookup/workbook.ts::typesSheetRows`). So `replace=true`
   (`lib/deployment/service.ts`) deletes and re-creates any HQ table whose
   definition differs (field properties, indexed fields, row attributes, a
   non-global or owned table, or a description), re-minting its row ids, and
   drops owners, and any row attributes the table does not declare, even from a
   table that survives. Nova also accepts lookup tags containing `casedb` or
   `ledgerdb` (`lib/lookup/constants.ts::isReservedInstanceTag` compares whole
   names), which every runtime resolves to the case or ledger database, and
   `uploadLookupTableWorkbook` reports HQ's 200 "Upgrade Required" page as "may
   have landed", though nothing ran. Nova also refuses to push a 32-character
   tag (`lib/commcare/lookup/workbook.ts::MAX_HQ_FIXTURE_SHEET_NAME_LENGTH`, whose
   comment says a sheet name holds 31 characters), though HQ's upload reads a
   32-character sheet name (`fixtures/upload/workbook.py`; executed); only Excel
   and HQ's own download stop at 31. *Fix:* adopting or pushing an HQ table that
   carries field properties, indexed fields, row attributes or owners, or is not
   global, is refused until step 7 gives Nova's lookup model that content, and
   from then the workbook carries every field, property, indexed flag, attribute
   and owner column and the table's globality; tags containing either
   substring are refused; "Upgrade Required" is reported as nothing landed; the 31-character cap goes,
   so a 32-character tag pushes (HQ's own download of such a table truncates its
   sheet name, as for any table HQ holds with that tag). An existing deployment
   that adopted such a table stops at publish, naming it, until step 7; before
   then the person may give Nova's table a new tag, so the push creates that
   table and leaves HQ's untouched (the app then reads Nova's copy there). An
   existing Nova table whose tag contains either substring is renamed by
   splitting it (`case_db`, `ledger_db`), shortening the rest of the name so the
   tag, with a numeric suffix on collision, stays within 32 characters. HQ's APIs
   cannot rename a table (`LookupTableResource.obj_update`), so the next push creates the new table in HQ and reports the old one
   as left behind, and the migration names each.
6. **Nova emits CSQL HQ refuses.** `lib/domain/predicate/typeChecker.ts::ORDERED_TYPES`
   admits ordering comparisons on `time` properties, and HQ raises
   `CaseFilterError` on them (`case_search/xpath_functions/comparison.py::_case_property_range_query`),
   so the whole search fails. `ORDERED_TYPES` serves every Predicate slot, and
   Core compares both sides of an ordering as numbers, where a string holding
   `:` is NaN (`FunctionUtils.toNumeric`,
   `checkForInvalidNumericOrDatestringCharacters`; a time answer reaches XPath
   as its string), so every ordering comparison on a time is false on the
   device (executed: `'14:30' < '15:00'` is false), while Nova's Preview orders
   it. *Fix:* the validator refuses an ordering comparison on a time value in
   every slot, since each reaches Core or CSQL. The migration replaces each such
   comparison, not its slot, with the Predicate `match-none` term (false on the
   device, `match-none()` in CSQL), and in form logic with `false()`, which
   changes nothing on the device, where it was already false, and makes Preview
   agree with the device. The searches that failed then run and return what the
   device list already showed: no case where the comparison was required, every
   case where it sat under a negation, and no result whenever a time-range
   search input is used; the migration names each such search input. A menu or form
   display condition this turns into `false()` or `false() and <rest>` takes the
   always-false arm with that rest ("Navigation and after-submit links"), which
   step 2 adds; any other stays an ordinary condition. The migration names each.
7. **Saved and incomplete forms differ by export path.** HQ emits
   `cc-show-saved` and `cc-show-incomplete` in every build, `no` unless the app
   sets them; Nova's `.ccz` omits them and Android treats absence as yes. *Fix:*
   both are app settings Nova writes explicitly. Existing apps take the value
   their deployments' HQ builds show (`no` where the deployment sets none), or
   HQ's default `no` where they disagree, under "Identity", so users of a local
   `.ccz` see what users of the HQ build see; an app with no deployment the
   cutover reads takes `yes`, what users of its local `.ccz` see today. A new app
   takes HQ's default, `no`, for both.
8. **Barcode and secret validation is admitted, then dropped.** The gate admits
   `validate` (`lib/commcare/validator/rules/field.ts::KINDS_SUPPORTING_VALIDATION`),
   but the emitter gates constraints on `lib/commcare/constants.ts::supportsValidation`,
   which excludes both kinds. *Fix:* the emitter writes them. Existing apps start
   enforcing the validations their authors wrote.
9. **Nova's `.ccz` profile identifies nothing stable.**
   `lib/commcare/compiler.ts::generateProfile` writes no `requiredMajor` or
   `requiredMinor`, so Core installs it on a phone of any version, and it writes a
   fresh `uniqueid` on every compile, while Android identifies an installed app
   by that id (`AppUtils.getAppById`), so each installed `.ccz` arrives as a new
   app instead of an update, while its profile, suite resources and
   `cc-app-version` all say version 1, so a newer `.ccz` never looks newer.
   *Fix:* `requiredMajor` 2 and `requiredMinor` 57 (the floor), the Nova app's
   UUID as `uniqueid`, and the document's sequence as the profile, resource and
   app version. A newer `.ccz` then updates the installed app through Android's
   offline update, and installing one over itself is refused as a duplicate
   (`ProfileAndroidInstaller.checkDuplicate`). Phones below CommCare 2.57 can no
   longer install a Nova `.ccz`. HQ writes its own app id there, so a phone that
   installs both the HQ build and a Nova `.ccz` of one app holds two apps, and a
   phone that installed an earlier Nova `.ccz` installs the fixed one as a new
   app once more.
10. **Label columns sort differently by export path.** Nova emits ID mapping,
    and a plain column over a select property (whose labels it shows), as
    `translatable-enum` (`lib/commcare/hqJson/caseList.ts`), which HQ sorts by
    the translated label, while Nova's `.ccz` and Preview sort by the raw
    property; and ID mapping is not HQ's ID Mapping, the `enum` format, which
    HQ's editor writes and sorts by mapping position (`detail_screen.py::Enum`).
    Nova's `.ccz` and Preview also leave a case list with no sort in case-database
    order, where HQ sorts it by its first column
    (`suite_xml/sections/details.py::get_default_sort_elements`). *Fix:* ID
    mapping emits `enum` with the property as its field, sorted by mapping
    position (compared as text, so `10` sorts before `2`) on every runtime, and its values follow HQ's key rule (none
    of `& < > " '`, `ui-element-key-val-mapping.js::hasBadXML`); a plain column
    over a select property keeps `translatable-enum`, and the `.ccz` and Preview
    sort it by label and sort an unsorted list by its first column. Users see ID-mapping lists in the text order of their
    mapping positions everywhere (the eleventh entry sorts between the second
    and third), and
    users of a local `.ccz` see select columns in label order. The migration
    removes each mapping entry whose value holds one of those characters, which
    HQ's ID Mapping cannot hold, so that value then shows nothing, and names
    each.
11. **Media acceptance is wrong both ways.** Nova refuses BMP, M4A, FLAC,
    WebM and Ogg Vorbis or Opus audio, which every runtime plays, with a wrong rationale for M4A
    and Ogg (`lib/domain/multimedia.ts`), and accepts MP4 of any codec and WAV of any
    encoding.
    `lib/commcare/multimedia/mediaSuiteXml.ts` claims an unbundled media file
    fails install, which holds for exploded-directory installs, as Android
    installs a `.ccz`, but not for Core's or Formplayer's archive installs, and
    `MediaRuntimeTest` tests file-system behavior rather than archive installs.
    *Fix:* the set every platform plays under "Questions" (every app counts as declaring both platforms until step 4, which adds per-platform acceptance), and the corrected comment and test.
    The migration removes each reference to an existing asset some platform
    does not play (an MP4 outside the codecs above, and a WAV that is not 8- or
    16-bit PCM; until step 4 every app counts as declaring both platforms), so the app stays export-ready, and names each for its author
    to replace.
12. **Publish checks miss gates Nova's content needs.**
    `lib/commcare/projectSpaceCompatibility.ts::moduleRequiresAdvancedCaseSearch`
    requires `CASE_SEARCH_ADVANCED` only for hidden and default-valued prompts,
    not for inline search, multi-select case lists, single-date prompts or
    `exclude`; related-case filters are never checked against
    `CASE_SEARCH_RELATED_LOOKUPS`; custom tiles are never checked against
    `CASE_LIST_TILE` and `CASE_LIST_TILE_CUSTOM` (`hqJson/caseList.ts` emits
    `case_tile_template: custom`, and a Case List save under `CASE_LIST_TILE`
    alone drops it);
    and link writes shown in a case list or detail need `VIEW_FORM_ATTACHMENT`
    for mobile workers to open them, since HQ otherwise requires the Submission
    History permission (`reports/views.py::_can_view_form_attachment`), while
    Nova's publish check (`lib/commcare/projectSpaceCompatibility.ts`, with the
    flag in `config/commcare-hq-feature-flags.json`) requires that flag for every
    link write. *Fix:* the flag
    probe checks each gate exactly where the inventory names it, and publish
    checks the version floor and asks for the privilege confirmation (under
    "What Nova imports"). Publishes to project spaces that lack a newly checked
    gate then stop with its name, publishes to a target app below CommCare 2.57
    stop until the person raises its version in HQ, and each existing
    deployment's first publish after the step asks for the privilege
    confirmation. Nova's case operations, multi-select writes and extension
    child cases are all Save to Case blocks today, so from step 2 publishing such
    an app to a project space without `save_to_case` stops at that confirmation,
    although HQ builds and runs the app there today; from step 5 a new operation
    takes the simplest placement, while a published one keeps its Save to Case
    block until the person moves it (defect 22). An existing deployment in a
    project space with `DONT_INDEX_SAME_CASETYPE` whose app creates a basic child
    case of its own menu's case type stops at publish, naming it, with the next
    step, which publish offers, to place that child case in a Save to Case
    block, an identity edit that moves its submission path in every project
    space the app publishes to and needs `save_to_case` in each.
13. **HQ's form builder breaks or changes Nova's XForms.** Running HQ's Vellum
    over Nova's exports shows each of these (emitted in `lib/commcare/xform/`):
    - `vellum:` shadows holding a predicate on a form path, including every
      constraint-collection count, are copied into the real attribute, which Core
      rejects. *Fix:* no shadow on such an expression. No visible change.
    - `__nova_guard_*` hand-written case blocks (`caseOps.ts`) lose their case-id
      bind, so every submission reaching one fails. They enforce three contracts:
      a runtime-resolved target matches its declared case type (case-type
      guards), an update never retypes a case whose id comes from an authored
      key (retype guards), and a case's name and owner stay nonblank, with every fixed-column text value
      (name, owner, external id) within 255 characters (text guards). *Fix:* each
      becomes a Save to Case update whose case id is `if(<ok>, <id>, '')`, with the
      id held in a hidden value and an update that rewrites a value to itself, so
      a mismatch still fails the submission. The guard targets the operation's
      own case, which that submission writes anyway, so nothing else changes.
    - Save to Case wrappers inside hidden values with children
      (`__nova_operations`, `__nova_subcases`), and every node named with
      `RESERVED_XFORM_NODE_PREFIX` (`__nova_`, `lib/commcare/constants.ts`),
      which Vellum refuses as a question id. *Fix:* the containers become groups
      and each such node is named as under "Nova's exports stay inside HQ's
      editable envelope" (`nova_<purpose>`, with the owning id where it has one). Every such node's data path
      moves once, so the matching columns in HQ exports move; the count
      snapshots (`__nova_count_*`) are left alone here, because defect 25
      removes them.
    - A conditional operation's wrapper relevance is dropped on save, so the
      operation always runs. *Fix:* a group carries the condition, and a create
      uses Save to Case's own create condition.
    - Non-blank and length guards as constraints on case leaves are dropped.
      *Fix:* the constraint sits on the source question, so its message shows
      there.
    - A typed `xsd:dateTime` case leaf loses its type, and with it the time.
      *Fix:* an untyped leaf `if(p = '', '', format-date(coalesce(p, ''),
      '%Y-%m-%dT%H:%M:%S.%3%Z'))`, which keeps the full instant, because
      `coalesce` hands `format-date` the value rather than a node that Core
      rounds to midnight. No visible change.
    - A create id computed live from an authored key outside a repeat becomes a
      load-time value, computed before the key is answered. There is no spelling
      HQ's editor keeps at the form root. *Fix:* authored-key creates are
      offered only inside a repeat, where Vellum keeps the id live. An existing
      root-level one takes a generated id, so repeated submissions with one key
      stop merging into one case, and updates elsewhere that compute the same key
      no longer find it; the migration names each.
    - A default value that reads another form answer by its absolute path
      (`#form/…`) is a Vellum error unless the
      retiring `VELLUM_DATA_IN_SETVALUE` flag is on (`baseSpecs.js`
      `defaultValue.validationFunc`), and Nova admits it. *Fix:* the validator
      refuses it. The migration moves each one on a hidden value to its
      calculate, which then follows the answer instead of copying it once,
      unless that closes a dependency cycle, where the default is removed and the
      hidden value holds neither, which step 2 admits (the inventory's Hidden
      Value with neither), so a case property it writes is written blank on each
      submission unless the form preloads it (defect 29); it
      removes each one from a visible question; it names each.
    - A reference to another block's `case/@case_id` is an unknown question to
      Vellum. *Fix:* the id is held in a hidden value that both read.
    - An explicitly empty translation of a label, hint, help text, validation
      message or option label is emitted blank (a missing one already emits the
      source text, `lib/domain/translationUnits.ts::localizeTranslationUnit`),
      and Vellum fills it from the default language on save. *Fix:* Nova writes
      the default language's text there, and the
      builder still shows the entry as untranslated. Users of that language see
      the default text where they now see nothing.
    - A `<group ref>` wrapper around a repeat, and a Connect deliver unit without
      `work_area_id`. *Fix:* the ref-less group and the empty element Vellum
      writes. No visible change.
14. **HQ's app manager rejects or rewrites Nova's app, module and form settings.**
    - A follow-up form that writes nothing carries `update_case` `never`
      (`lib/commcare/hqShells.ts`), which HQ's Case Management save turns into
      `always` plus a touch block. *Fix:* `always`, as every follow-up HQ's editor
      makes. Each submission of such a form then updates its case's
      `modified_on`, which case update rules, repeaters and data forwarding see.
    - A close condition on a question other than a select, hidden value or label,
      or inside a repeat (`lib/commcare/formActions.ts`), is not something the
      Case Management tab can set. *Fix:* the close moves to a Save to Case
      block, the placement for a condition that tab cannot state, while the
      case's writes stay in the Case Management slot, so the app needs
      `save_to_case` and the close's block moves in HQ exports; from step 5 that
      close's placement is held like an operation's ("Case writes").
    - `previous_screen` after submit in a multi-select menu, or in a menu under
      one, and `module` in a menu under a multi-select one, cannot be saved,
      and HQ's build refuses it where exactly one of the menu and its parent is
      multi-select (`mismatch multi select form links`,
      `lib/commcare/session.ts`). *Fix:* the validator refuses both, and an
      existing form takes the nearest destination HQ offers there, with step
      2's first-menu and parent-menu destinations: its menu, else its parent
      menu, else the first menu (`views/forms.py` offers the first two only
      outside a multi-select root).
    - The search button label (`searchButtonLabel`, `lib/commcare/hqJson/caseList.ts`)
      is reset by every Case List save. *Fix:* Nova stops offering it, and
      existing labels become HQ's "Search All Cases".
    - Lookup-backed search prompts without an itemset `sort` block the Case List
      save. *Fix:* each sorts by the column the author picks, the display label
      by default, so existing prompts list their options in that column's string
      order (`String.compareTo` of the sort value) instead
      of in row order.
    - A search input named like a default filter blocks every Case List save
      (`case_claim.js::commonProperties`); Nova writes default filters only as
      `_xpath_query` rows today, so only an input named `_xpath_query` does, and
      Core sends no key for it, since Nova sends it with `exclude`. An input that
      reaches HQ as its own key (a simple exact input on a non-date,
      non-attribute property, or a range input, named for the property it
      searches, reached through the case itself; Nova sends every other input with
      `exclude`, `searchPrompts.ts::searchInputSuppressesAutoMatch`, and Core
      then sends no key for it, `RemoteQuerySessionManager.getRawQueryParams`)
      does not search when its name is a `CONFIG_KEYS_MAPPING` key or a
      `CASE_SEARCH_TAGS_MAPPING` key (taken as request configuration,
      `case_search/models.py::extract_search_request_config`), a
      `CONFIG_KEYS_MAPPING` value or `include_closed` (ignored,
      `models.py::UNSEARCHABLE_KEYS`), or `commcare_blacklisted_owner_ids` or
      `commcare_project` (applied as owner and project space filters,
      `case_search/utils.py::_apply_filter`); HQ searches `owner_id` as an owner
      filter and `case_id` as a case id filter. *Fix:* the validator refuses
      an input named like one of the module's default filters, and a name in
      that set on an input that reaches HQ as its own key. The migration
      renames each existing input that blocks the save, with a numeric suffix,
      and removes each named in that set, which Nova cannot type; each
      input-presence clause over a removed input takes its absent branch, each
      read of it becomes the empty string, and the migration names each.
    - A menu whose forms are all surveys and which lists no cases publishes with
      case type `''`, dropping the one it holds
      (`formLinkProjection.ts::moduleCaseTypeForActions`). *Fix:* the emitter
      writes the held case type; each such menu's case type in HQ changes at its
      next publish, and the migration names each.
    - Tile cells without a font size and tile columns without a position are
      rewritten on save. *Fix:* a position for every tile column, with sort
      carriers kept out of the tile, and `medium` (the size HQ's editor writes)
      for every cell without a size. Such cells then show at that size: Web
      Apps stops inheriting the surrounding size, and Android draws medium
      instead of its default normal; the migration names each tile.
    - Logos are written path-only at a content-hash path
      (`lib/commcare/multimedia/logoEntry.ts::buildLogoRefs`), which HQ's
      Settings page cannot preview and which makes a linked-app pull of the app
      fail (`LinkedApplication.reapply_overrides` looks up each logo's `m_id`).
      No API can do better: HQ creates a logo's media object only through its
      session-authenticated logo uploader (`hqmedia/views.py::ProcessLogoFileUploadView`),
      and its multimedia API never matches logo paths (`hqmedia/tasks.py::process_bulk_upload_zip`
      matches `all_media`, which leaves logos out). *Fix:* publish writes no
      `logo_refs`, leaving HQ's, and the HQ import file carries none, and a publish that carries a new or changed
      logo offers the file and the step to upload it in the app's settings in
      HQ, where the project space's plan has `commcare_logo_uploader` (Advanced
      and above; elsewhere HQ's builds carry no logo, and publish says so); the
      local `.ccz` and Preview carry Nova's logo directly. HQ's Settings page
      then shows the uploaded logo, and linked pulls succeed. The first publish
      after step 2 to a deployment whose `logo_refs` still hold Nova's
      path-only entries (`jr://file/commcare/<hash><ext>`) writes `logo_refs` once
      more, without those entries and keeping any HQ's uploader wrote, and
      offers the upload; until the person uploads, HQ's builds of that app
      carry no logo, and Web Apps shows no banner. Web Apps reads the banner
      from `logo_refs` itself, with no privilege check, and resolves its path
      through the app's media map (`cloudcare/views.py::_format_app_doc`), so
      today a path-only reference shows there wherever a form's media uses the
      same file, and that banner goes at this publish.
    - The data node's `name` carries a slug of the form's name
      (`lib/commcare/xform/dataRootAttributes.ts`), which Vellum rewrites to the
      form's name on save and HQ reads as the submission's `@name`. *Fix:* the
      form's name in the default language, as `<h:title>` already carries.
      Submissions then carry the form's name there.
    - An app that reads locations carries `location_fixture_restore:
      both_fixtures` (`lib/commcare/expander.ts`), which HQ's settings page
      offers only under the retiring `HIERARCHICAL_LOCATION_FIXTURE` flag
      (`commcare-app-settings.yml`). *Fix:* `project_default`, with publish's
      confirmation that the flat fixture still syncs ("Application settings");
      where it does, nothing changes, and where it does not, publish stops with
      that section's next step.
    - Spellings no editor produces but saves keep or rewrite equivalently, each
      with the equivalent spelling the inventory gives: `case_preload`, `open_case.external_id`,
      registration `update never`, `no_vellum`, the `calculate` column format
      (as `plain`), a `date_format` outside HQ's five, such as `%Y-%m-%d` and Nova's
      preset `%B %e, %Y` (a new date column takes `%b %d, %Y`, the one of HQ's five
      nearest that preset; an existing one becomes a calculated `format-date`
      column with the same display, plus a sort on the raw property wherever
      the column was a sort key or the first column of a list with no sort, so
      the order is unchanged, since a calculated column sorts on its text,
      `detail_screen.py::FormattedDetailColumn.sort_node`), sort type `string` and blanks `''`, field
      plus `sort_calculation` pairs,
      `custom_variables: null`, and empty short case lists. No visible change.
15. **Question and entry-point ids HQ's editors reject.** Nova admits question
    ids with a leading underscore or a leading `XML`, and `meta` in any case
    (`lib/commcare/constants.ts::XML_ELEMENT_NAME_REGEX`, applied by
    `lib/commcare/validator/rules/field.ts::invalidFieldId`), all of which
    Vellum rejects (`util.js::isValidElementName`, `baseSpecs.js`), and
    entry-point ids that are not `slugify` fixed points (a leading or trailing
    underscore or hyphen, or repeated hyphens), which make every settings save
    of that menu or form fail under `SESSION_ENDPOINTS`
    (`views/utils.py::set_session_endpoint`). *Fix:* the validator narrows both.
    Existing ids are renamed: leading underscores are dropped, `q` is prepended
    when what remains is empty, starts with `XML` or does not start with a
    letter, and `meta` in any case becomes `q_` followed by it; endpoint ids are slugified, and one that
    slugifies to empty becomes `entry`; a numeric suffix settles any collision.
    References through identity leaves follow the rename, and the migration also
    rewrites each relative path in form logic that names a renamed question,
    reading it through Nova's XPath grammar.
    That moves those questions' submission paths and breaks entry-point links
    already shared.
16. **Inaccurate or dead code.** `lib/commcare/constants.ts::RESERVED_CASE_PROPERTIES`
    says HQ rejects `owner_id` updates (HQ's `xform.py::autoset_owner_id_for_open_case`
    supports them); `lib/commcare/hqShells.ts` and `lib/commcare/types.ts` call
    `case_sharing` and `cloudcare_enabled` target-owned, though both are app
    content; `FIXTURE_REFERENCE_NOT_MODELED` is never produced; Nova drops a hidden case
    list column that sorts nothing (`hqJson/caseList.ts::hqShortSourceColumns`,
    and the suite's short detail), saying it has no runtime role, though both
    runtimes' list search matches every field, hidden ones included
    (`EntitySortUtil.sortEntities`), so its values stop matching; the ID-mapping and
    image-map schemas in `lib/domain/modules.ts` say Core splits both sides of
    `selected()` on whitespace, while it trims only the key and matches it as
    one token sequence (`XPathSelectedFunc.multiSelected`), though the schemas
    keep refusing blank and multi-token values until step 7 holds them
    (the inventory's ID-mapping key row); and
    `lib/commcare/xform/captureUpload.ts` says Android's `WidgetFactory` has no
    `face` branch, while `WidgetFactory.java` builds a `FaceCaptureWidget`; `HIDDEN_VALUE_BOTH_SOURCES` (`lib/commcare/validator/rules/field.ts`) says a Hidden Value's default is overwritten before anyone could read it, while a Default Value after it in the form that reads the Hidden Value sees it; `lib/domain/fields/file.ts` says Android has no document-upload handling and tells the SA a file question is Web Apps only (`saDocs`), as the public docs do (`content/docs/attachments.mdx`, "File attachments only work in the web app"), while `WidgetFactory.java` builds a `DocumentWidget`. Nova also offers
    label media on groups and repeats (`containerFieldBase.label_media`) and hint
    media (`hint_media`), which neither runtime shows and Vellum does not offer,
    and validation-message media (`validate_msg_media`), which Vellum offers and
    neither runtime shows (Android shows the message's text,
    `FormEntryActivity`; Formplayer returns only its text,
    `JsonActionUtils`). *Fix:* the comments, types, SA descriptions and public docs say what is true, the emitters keep
    every hidden column, the dead code goes, and those three media slots are removed from the model, the
    migration removing each such reference and naming it.

### Fixed with the typed expressions (step 3)

17. **Form-logic references stored as text.** Relative paths and case-database
    queries in form logic do not follow renames (`lib/commcare/xpath/expressionAst.ts`).
    *Fix:* the typed expression model. No visible change.

### Fixed with platforms (step 4)

18. **Date-and-time questions are broken in Web Apps.** Nova's `datetime` field
    (`lib/domain/fields/datetime.ts`) emits an `xsd:dateTime` input, and HQ's Web
    Apps client has no entry for it (`corehq/apps/cloudcare/static/cloudcare/js/form_entry/entries.js::getEntry`),
    so it shows "Sorry, web entry cannot support this type of question" and a
    relevant one blocks submission with no message, while Nova's Preview shows a
    working picker. *Fix:* the question is offered only in apps that do not
    declare Web Apps (see "Platforms"). *Migration:* the step 4 migration
    declares each existing app for the platforms its content runs on, so an app
    with a date-and-time question and nothing Android cannot run is declared
    Android only, and its next publish, after asking, turns Web Apps off; an app
    whose content runs on neither is declared for Web Apps, and each of its
    date-and-time questions is split into a date question and a time question,
    which adds a time column to its HQ exports and leaves a date in the
    question's column.
19. **Features Nova ships behave differently by platform, silently.** Inline
    search makes forms unreachable on Android for a selected case not already on
    the device, multi-select case lists do nothing on Android, entry points skip
    claims on Android, and selecting a case from a case list menu item leaves
    Web Apps users on an empty list. Nova's Preview shows none of
    this. *Fix:* each is offered only where it is not unavailable on any declared
    platform, carries its stated difference, and Preview plays each platform.
    Existing apps take the declaration their content runs on ("Platforms"), and
    publishing one that declares Web Apps to a project space whose plan lacks
    `cloudcare` (the current Pro plan) stops at the privilege confirmation until
    the person narrows it to Android only, which first needs removing what Android
    cannot run, such as a multi-select case list or a date search input.
20. **Project-space case search configuration is unchecked.** A project space whose
    case search config syncs cases on form entry adds a claim to the
    case-requiring entries of every module that offers search, and those forms
    never open on Android. No API reads that setting; whether case search is on
    Nova already probes (`lib/commcare/client.ts::probeCaseSearchRuntime`). *Fix:*
    publish of an app that declares Android and has a module that offers search
    asks the person to confirm sync on form entry is off, once for each app and
    project space, recorded beside the privileges; without the confirmation
    publish stops, with the next step to change that
    setting in the project space's case search settings, or to narrow the
    declaration to Web Apps.

### Fixed with case writes, forms and navigation (step 5)

21. **List-first search in apps on Web Apps.** Nova emits `auto_launch: false`
    for list-first modules (`lib/commcare/hqJson/caseList.ts`), which HQ is
    retiring (CASE_SEARCH_DEPRECATED_NORMAL_CASE_LIST) and rewrites to Search First
    on any Case List save where its workflow selector shows (`cloudcare_enabled`,
    the `cloudcare` privilege and SYNC_SEARCH_CASE_CLAIM, `views/modules.py`) and
    that flag is off, since the selector offers no list-first option then. *Fix:* the search workflow setting, with list first offered only in
    Android-only apps. In an app whose stored declaration includes Web Apps, the
    step 5 migration moves each list-first module to the non-inline search first,
    which changes what its users see first and adds none of the inline shape's
    restrictions.

22. **Case writes are two stored concepts, and every operation becomes Save to
    Case.** `Field.caseWrite` lowers to basic form actions (except in multi-select forms and
    for extension child cases, which already use Save to Case blocks) and
    `Form.caseOperations`
    always to Save to Case blocks (`lib/commcare/xform/caseOps.ts`), even an
    operation a basic form action expresses, so such an app needs
    `save_to_case` for no reason. *Fix:* one concept, as under "Case writes".
    *Migration:* each field write becomes a write in its form's operation for
    that case, in the placement it is published in today (a basic slot, or the
    Save to Case block a multi-select form uses). In an app the deployment ledger shows as published (a deployment that reached
    `uploaded` and is not ended), the migration records the current placement of each
    operation whose case block the drift baseline the ledger records for one of
    its deployments carries, matched by its block's path, as its published
    placement, except extension child cases, which defect 24 changes, and
    every form of a module defect 24 turns advanced, whose placements move there;
    other operations, and those in any other app, take the simplest placement. An app that keeps a Save to Case
    placement still needs `save_to_case`, so republishing it to a Pro project
    space stops at the privilege confirmation until the person moves those
    operations, which publish offers where a basic slot can express them, as an
    identity edit.
23. **Nova still offers attachment-mode case properties.** A capture field's
    `attachment` mode (`lib/domain/fields/base.ts::CAPTURE_CASE_WRITE_MODES`)
    works only under the retiring `MM_CASE_PROPERTIES` flag; without it HQ drops
    the attachment on submission. *Fix:* the mode is removed. Existing
    attachment-mode writes become link writes: later submissions store a link to
    the submitted file where they stored an attachment, and files already
    attached stay on their cases. The link resolves against the publish target,
    as link writes do today. In a project space with `MM_CASE_PROPERTIES`, the
    only kind attachment mode could publish to, the case attachment then keeps
    its last file and stops updating, and HQ exports gain a column for the
    link's hidden value.
24. **Extension child cases ride on a shape HQ's editor rewrites.** Nova writes
    each extension child case twice: an active Save to Case block
    (`__nova_subcases/__nova_subcase_<n>`, `lib/commcare/xform/caseOps.ts`) and
    beside it an inert basic subcase with `condition: never`
    (`lib/commcare/subcaseWire.ts::hqCaseActions`), kept so that HQ allocates the
    session datum (`case_id_new_<type>_<i>`) the block reads its case id from and
    after-submit navigation matches by case type. HQ's save resets the inert
    subcase's relationship to child, which changes its export columns
    (the index columns' paths move from `case/index/host` to `case/index/parent`
    and the `@relationship` column goes,
    `export/models/new.py::_add_export_items_for_case`), and it leaves
    permanently empty `form.subcase_<i>.case.*` columns in HQ exports. *Fix:*
    extension child cases are case operations with an extension link, placed as
    under "Case writes", and the inert subcase goes. A Save to Case block's case
    id is then `uuid()`. After-submit navigation that carries the new case into a
    form of its case type needs a session datum, which only an advanced open
    action provides, so the placement rule puts such an operation there.
    *Migration:* each existing extension child case keeps its block's path, except as below (held,
    as `nova_subcases/nova_subcase_<n>` after defect 13's rename, in an app the
    ledger shows as published, as defect 22 defines it, and the simplest
    placement in any other); a basic
    child
    case listed after an inert subcase moves up, so its `subcase_<i>` path, its
    session datum and its export columns move; an extension child case whose new
    case after-submit navigation carries moves to an advanced open action, which
    makes its module advanced, an identity edit for every form there (a parent
    selection in that module becomes chained case selections, renaming the
    session datums its forms read), except where HQ's advanced-module rules forbid
    that module becoming advanced ("Case writes"), where it keeps its Save to Case
    block and each form link that carried its new case into a form targets that
    form's menu instead, where the user picks the case; the migration names each. Such apps already need `save_to_case`, from step 2's
    privilege confirmation.
25. **Repeat counts are snapshots no HQ editor accepts.** Nova copies every
    authored count into a reserved `__nova_count_<fieldId>` node set once by a
    default value (`lib/commcare/CLAUDE.md`, `count_bound`). Vellum refuses the
    `__nova_` name, and a default value that reads other form nodes, as it does
    whenever the count does, is an error unless the retiring
    `VELLUM_DATA_IN_SETVALUE` flag is on, and the snapshot fixes the count where
    CommCare's repeats track it. *Fix:* live `jr:count`, as under "Questions". A
    repeat whose count question changes after entry has started now follows it
    upward: raising the count adds rows, and lowering it removes no row already
    created, so those rows and their answers, with the case operations in them,
    are still submitted. The snapshot
    nodes go, and with them their data paths and HQ export columns; a count that
    is an expression rather than a question takes a `nova_count_<repeat>`
    hidden value, which adds its own export column.
26. **Query repeats in shapes HQ's editor breaks.** Nova runs query repeats
    through a live `@count` calculate and wrapper relevance, which a Vellum save
    turns into Vellum's own model-iteration spelling (setvalues for `@count`,
    no wrapper relevance, an absolute `@current_index`); in that shape a nested query repeat
    breaks, and one under a group whose relevance reads answers load-time
    defaults set stays empty whenever they leave the group not relevant at load;
    and in either shape a query that reads a form answer no earlier load-time
    default sets never reads it, since its rows are taken once ("Questions"). *Fix:* a query repeat has a placement, as under
    "Questions". *Migration:* each existing query repeat takes the placement a
    new one would: the count repeat where it is nested, its query reads a form
    answer, or an ancestor's relevance reads form answers, which moves its
    answer paths, and its rows then follow the query while the form is filled
    in instead of the snapshot taken when it loaded; every other takes model
    iteration; the migration names each moved repeat.
27. **Form links are made exclusive, and hidden links vanish in HQ.**
    `lib/commcare/formLinkProjection.ts::planFormLinkGuards` writes each link's
    exclusivity into guards, and HQ drops a hidden link beside a visible one on
    save, and clears a navigation fallback its settings page does not offer.
    *Fix:*
    CommCare's link semantics with "otherwise", as under "Navigation and
    after-submit links", and the validator refuses a link to a menu HQ does not
    offer as a target (a child menu, unless the source menu is also a child menu
    whose parent has the same case type as the target's parent, or a display-only-forms menu at all;
    only the retiring `FORM_LINK_ADVANCED_MODE` offers the child menus,
    `views/forms.py::_get_linkable_forms_context`) and an otherwise to a
    destination HQ does not offer in that menu. Existing guards become each
    link's own condition, so existing apps behave the same; a terminal
    unconditional link becomes "otherwise" to that form, and an after-submit
    destination beside conditional links becomes "otherwise" to that menu. The
    validator also refuses datums on a link to a menu, which only the retiring
    flag writes, and existing links lose the datums their target does not read. An existing link to a
    menu HQ does not offer becomes a link to that menu's parent, from which the
    worker opens it; an existing otherwise, like an after-submit destination (defect
    14), that HQ does not offer in that menu takes the nearest one HQ offers
    there: the form's menu, else its parent menu, else the first menu; the
    migration names each.
28. **Every labelled group is a field list.** Nova emits `appearance="field-list"`
    on every labelled group (`lib/commcare/xform/builder.ts`), so a user repeat
    inside one is an error in Vellum ("Repeat Count is required."). *Fix:*
    `group.fieldList`, and the validator refuses a user repeat inside a field
    list. Existing labelled groups and sections take `true` and unlabelled groups
    `false`, as Nova emits them today, except every group or section that
    contains a user repeat at any depth, which takes `false`: on Android its
    questions then show one per screen instead of together.
29. **Preload and markdown are implicit.** Nova preloads every scalar writer, in a single-case form, of the
    form's own case from the loaded case (`lib/domain/casePreload.ts::writerPreloadsFromLoadedCase`)
    and writes a markdown form for every display text (labels, hints, help,
    validation messages and options), which re-renders plain text containing
    `*`, `#` or `1. `. *Fix:* a preload is an explicit default value
    reading the case, and markdown is a property of each display text. Each
    writer Nova preloads today (`lib/domain/casePreload.ts` names which) gets a
    default value reading its case property, replacing any default it had, since
    the loaded value is what its users already see; a hidden writer with a
    calculate keeps it and gets none, since its preload never took effect; and a
    writer inside a repeat, which HQ's load-time preload fills in no row, since
    it runs on `xforms-ready` before any row exists (`XForm.add_case_preloads`;
    executed in Core), then gets the case value in every row, as a default value
    does there; `lib/domain/casePreload.ts`, which says the running form seeds
    the first row, is corrected. The
    migration names each replaced default. Existing texts keep their markdown
    forms, so nothing changes on the wire.
30. **Three concepts carry HQ's shape under other names.** The search-no-matches
    form entry, the case-list-only menu and the `searchFirst` flag become
    `Module.caseListRegistrationForm`, `Module.caseListMenuItem` and the search
    workflow setting. Nothing changes on the wire.

---
