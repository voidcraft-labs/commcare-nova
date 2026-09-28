# Application and settings

Part of the surface inventory of the HQ round-trip research. Section names in quotes and defect numbers refer to the main document, [`../README.md`](../README.md). Rows that point elsewhere with `→` name the section that owns the item; the inventory [`README.md`](README.md) says which file holds each section.

## Application

`AM/` = `commcare-hq/corehq/apps/app_manager/`. Settings-page fields (`hq.*` yaml settings) are rowed once, under Settings and profile; this table holds the rest of the Application document.

| HQ item | Disposition | Web Apps / Android | Emission |
|---|---|---|---|
| `doc_type: Application` | **HELD**: `BlueprintDoc` | n/a | `Application` |
| `doc_type: LinkedApplication` (downstream app) | **REFUSED**: not HQ-editable: the form builder redirects away from linked apps (`AM/views/formdesigner.py`) and every upstream pull overwrites content (`views/utils.py::update_linked_app`) | — | — |
| `upstream_app_id`, `upstream_version`, `linked_app_translations`, `linked_app_logo_refs`, `linked_app_attrs` | **REFUSED**: not HQ-editable, as for `LinkedApplication` (row above), the only doc type that carries them | — | — |
| `doc_type: RemoteApp` (+ `profile_url`, `manage_urls`, `questions_map`) | **REFUSED**: freeform: a hand-written profile and suite at a URL; no structured editor (`commcare_settings.py::_load_commcare_settings_layout` RemoteApp branch) | — | — |
| unknown `doc_type` | **REFUSED**: not HQ-buildable: `util.py::get_correct_app_class` raises | — | — |
| `_id` | **TARGET-OWNED**: the HQ app id; deployment ledger (`app_deployment_resources` kind `app`) | n/a | `app_id` of the import call |
| `_rev`, `domain`, `copy_of`, `version` | **TARGET-OWNED**: server-managed | n/a | omit |
| `short_odk_url`, `short_odk_media_url` | **TARGET-OWNED**: server-managed | n/a | omit |
| `built_with`, `build_signed`, `built_on`, `build_comment`, `comment_from`, `last_released`, `build_broken`, `build_broken_reason`, `is_auto_generated`, `is_released` | **TARGET-OWNED**: build and release records | n/a | omit |
| `date_created`, `created_from_template`, `last_modified`, `has_submissions` | **TARGET-OWNED**: server metadata | n/a | omit |
| `copy_history`, `family_id` | **TARGET-OWNED**: copy lineage; excluded on overwrite (`ApplicationBase._update_excluded_fields`) | n/a | omit |
| `external_blobs` | **TARGET-OWNED**: blob bookkeeping, which `export_json` pops | n/a | omit |
| `build_profiles` (each profile's `name`, `langs`, `practice_mobile_worker_id`) | **TARGET-OWNED**: project-space build configuration, excluded on overwrite (`ApplicationBase._update_excluded_fields`), gated by privilege `build_profiles`; an import-create keeps the source's profiles in the new app, and Nova writes none | n/a | omit |
| `archived_media` | **TARGET-OWNED**: the logos HQ archived on a plan downgrade (`hqmedia/models.py::ApplicationMediaMixin.archive_logos`), which `restore_logos` writes back over `logo_refs` on an upgrade; an app imported from a downgraded project space therefore arrives with no logo | n/a | omit |
| `_attachments` (`<form unique_id>.xml`) | **HELD**: form sources: fields, binds, itext of each `Form` | RUNS / RUNS (each construct's reading is in the question rows) | one XForm per form, keyed by the target form `unique_id` |
| `_attachments['custom_suite.xml']` | → Settings and profile, 42 `hq.custom_suite` (the setting stores its text there, `Application.custom_suite`) | — | — |
| `_attachments` entry for a form no longer in the app | **INERT**: no build reads it | n/a | omit |
| `name` | **HELD**: `BlueprintDoc.appName` | RUNS / RUNS | `app_name` on create and update (excluded from the source merge; `_handle_import_app` passes it as an extra property, which `_merge_source_into_app` applies after the merge) |
| `langs` (order; `langs[0]` default) | **HELD**: `localization.languageOrder`, `defaultLanguage` | RUNS / RUNS | `planLanguageWire` codes |
| `langs` code spelling matching HQ's grammar `^[a-z]{2,3}(-[a-z]*)?$` (e.g. `en`, `hin`, `pt-br`, codes outside HQ's registry, which it only warns about), each once | **HELD-NEW**: `localization.wireCodes`: the exact HQ code per language (codes are external identity: device locale, build profiles, UI strings) | RUNS / RUNS | the imported code verbatim; Nova-born languages keep `planLanguageWire`; a language's code is stored when the language is added (the migration stores each existing language's current code), since `planLanguageWire` recomputes every code from the whole set and would otherwise rename an existing language when a colliding one is added; only the new language takes a suffixed code |
| a non-empty `langs` code outside that grammar, or repeated | **REFUSED**: not HQ-editable: the Languages page marks it an error and blocks the save (`supported_languages.js::validateLanguage`; `validate_lang` enforces the grammar on rename) | — | — |
| `langs` containing an empty code | **REFUSED**: not HQ-buildable: `empty lang` (`ApplicationValidator.validate_app`) | — | — |
| `modules` | **HELD**: `moduleOrder` + `modules` | RUNS / RUNS | ordered `modules` (positional ids `m{i}`) |
| `translations` key = an HQ-generated app-string id other than `app.display.name` and `homescreen.title` (below) (`modules.m{i}`, `forms.m{i}f{j}`, `m{i}.case_short.*`, `case_search.m{i}`, …) | → the owning field's row: folded into the owning Nova text for that language (a non-empty override is the effective string, merged last by `app_strings.py::*AppStrings.app_strings_parts`; an empty one is read as absent, since `non_empty_only` drops it) | RUNS / RUNS | no key; the folded text emits through the owning field |
| `translations['app.display.name']` | **HELD**: `appName` (+ its localization) | RUNS / RUNS (Web Apps: the root menu heading, the first breadcrumb and the tab title, through Core's `ScreenUtils.getAppTitle`, which Formplayer uses; Android: the app name) | per language, the localized name where it differs from `appName` (which `app_name` sets on create and update, and from which HQ generates the key), and no key otherwise (today `lib/commcare/expander.ts` writes it in every language) |
| `translations['homescreen.title']` | **INERT**: HQ writes it (`app_strings.py`), and no runtime reads it (no reader in commcare-core, commcare-android or formplayer) | n/a | HQ's current value; outside Nova's owned keys (Nova writes it in every language today, `lib/commcare/expander.ts`: defect 4) |
| `translations[<lang code>]` (language display names) equal to the label Nova derives (`lib/commcare/languageWire.ts::planLanguageWire`), or absent where HQ's default name for the code is that label | **HELD**: language display name from `localization` identity | IGNORED (Web Apps names languages itself, `cloudcare/views.py` `lang_code_name_mapping`) / RUNS (`ChangeLocaleUtil.translateLocales`) | the name where it differs from HQ's default, and no key otherwise |
| `translations[<lang code>]` any other value, or absent where HQ's default name differs from Nova's label | **HELD-NEW**: a per-language display name, which may be HQ's default (HQ writes `langcodes.get_name` of the code, translated, when the key is absent or empty: `app_strings.py::_create_custom_app_strings`; Nova derives every name today, `lib/domain/languageRegistry/names.ts::resolvedLanguageDisplayLabel` through `lib/commcare/languageWire.ts::planLanguageWire`) | IGNORED / RUNS | that name, or no key for HQ's default |
| `translations` key in a runtime's UI string catalog (Core, Android, Formplayer) | **HELD-NEW**: `uiStringOverrides[lang][key]`, keyed by the typed set of strings the runtimes read (editor: CommCare Translations; `${N}` checked) | RUNS / RUNS | `translations[lang][key]` |
| `translations` catalog key HQ fills with its own text, in a language with no override | **HELD-NEW**: `uiStringCatalogKeys`, the per-key set of catalog keys for which HQ emits its own catalog text in every language that has no override (English from its catalog at the app's version; other languages from HQ's default file or its unversioned catalogs): `SelectKnownAppStrings.get_app_translation_keys` takes the union of keys across languages, so any language's key, empty or not, puts it in the set; an empty value adds nothing else | RUNS / RUNS | for a key in the set that no language overrides, `''` in the default language; otherwise the overrides alone. HQ's CommCare Translations upload drops a key with no text of its own, and a value equal to the English catalog text in the `en` column, or in the first language's where the app has no `en` (`ui_translations.py::process_ui_translation_upload`), so no spelling survives a download and upload there, for a language whose column keeps a value (a language with no surviving cell keeps its old values, `translations/utils.py::update_app_translations_from_trans_dict`); that round trip is an HQ-side edit the drift check reports |
| `translations` key no runtime reads | **INERT**: no reader | n/a | HQ's current value (the upload carries every key outside Nova's set) |
| `recipients` | **INERT**: no reader; in `NON_BUILD_APP_KEYS` | n/a | omit |
| `admin_password`, `admin_password_charset` | **INERT**: no reader outside the setter | n/a | omit |
| `amplifies_workers`, `amplifies_project`, `minimum_use_threshold`, `experienced_threshold` | **TARGET-OWNED**: analytics metadata HQ's MALT report copies from the app (`data_analytics/malt_generator.py`); no editor, build or runtime reader, and the overlay keeps the target's values | n/a | omit |
| `cached_properties`, `description`, `deployment_date`, `phone_model`, `user_type`, `attribution_notes` | **INERT**: legacy Exchange metadata, no app-manager reader | n/a | omit |
| `vellum_case_management` | **INERT**: only a warning banner on every app-manager page and in the releases table (`partials/vellum_case_management_warning.html`) | n/a | omit (model default `true`) |
| `comment` (app) | **INERT**: builder note; excluded on overwrite | n/a | omit |
| `smart_lang_display` | **INERT**: form-builder display preference (`views/formdesigner.py`) | n/a | omit |
| `add_ons` | **INERT**: UI visibility only; no build, suite or validator reader (`AM/add_ons.py`) | n/a | a key-level overlay: `true` for each add-on Nova's content uses, every other key at HQ's current value (today Nova writes 10 keys and drops the rest: defect 4) |
| non-empty `custom_assertions` (app) | **REFUSED**: freeform + retiring (CUSTOM_ASSERTIONS) | — | — |
| `multimedia_map` | **TARGET-OWNED**: binding of paths to HQ media objects; excluded on overwrite, kept as sent on create (`from_source`); the multimedia API fills form and menu media paths and never logo paths (`process_bulk_upload_zip` matches `all_media`, which leaves logos out) | n/a | media bytes via `POST …/apps/api/{app_id}/multimedia/` (Nova also writes a map with content-hash ids on create today, `bundle.ts::buildMultimediaMap`) |
| `logo_refs.hq_logo_web_apps` | **HELD**: `BlueprintDoc.logo`; import reads the logo HQ's uploader holds through the media map | RUNS / IGNORED | none: HQ creates a logo's media object only through its session-authenticated uploader (`hqmedia/views.py::ProcessLogoFileUploadView`, privilege `commcare_logo_uploader`), which writes the slot path `jr://file/commcare/logo/data/<slot><ext>` in the full media-info shape (`CommCareMultimedia.get_media_info`) that HQ's Settings preview and a linked app's pull read (`LinkedApplication.reapply_overrides` looks up `m_id`); publish leaves HQ's `logo_refs` and offers the file to upload there (defect 14; Nova writes a path-only content-hash reference today: unproducible); the local `.ccz` carries the logo directly |
| `logo_refs.hq_logo_android_home` / `_login` / `_demo` | **HELD-NEW**: `androidLogos.{home, login, demo}` | IGNORED / RUNS | as for the Web Apps slot: uploaded in HQ, carried by the local `.ccz` |
| `logo_refs[slot].path` other than the uploader's `jr://file/commcare/logo/data/<slot><ext>` | **REFUSED**: not HQ-editable: the logo uploader writes only that path (`hqmedia/views.py::ProcessLogoFileUploadView.form_path`); not HQ-buildable (`MediaResourceError`) when the path is also a `multimedia_map` key outside `jr://file/` | — | — |
| dynamic keys `anonymous_cloudcare_enabled`, `anonymous_cloudcare_hash`, `linked_whitelist`, `media_language_map`, `mobile_ucr_sync_interval`, `media_form_errors`, `user_registration`, `split_screen_dynamic_search` | **INERT**: no reader at the pin (an in-place update keeps `user_registration`; an import that creates the app drops it, because `_import_app` runs `export_json`, whose `scrub_source` calls `update_form_unique_ids`) | n/a | omit |
| any other unknown top-level key that names no `Application` property or method | **INERT**: jsonobject dynamic property with no reader | n/a | omit |
| an unknown top-level key naming an `Application` read-only property or method (such as `post_url`, `build_version`, `commtrack_enabled`, `suite_loc`, `custom_suite`, `get_modules`, `create_all_files`, `is_remote_app`) | **REFUSED**: not HQ-buildable: `dbaccessors.py::wrap_app` raises for a read-only property (`WrappingAttributeError`) and for some methods (`get_modules`: `TypeError`), `validate_app` raises for others (`create_all_files`: `TypeError`), and any other shadows a method HQ's servers call (`is_remote_app`, which the data dictionary refresh calls) (executed) | — | — |

## Settings and profile (the 52 yaml settings, `commcare-profile-settings.yml` + `commcare-app-settings.yml`)

`appSettings` is one HELD-NEW concept: a typed slot per runtime-read setting. Emission of every `appSettings` slot is explicit (a stored value), so HQ's first settings-page save (`commcare_settings.js::valueToSave`) changes nothing any runtime reads (it also stores defaults for disabled settings, which the built profile then carries).

| HQ item | Disposition | Web Apps / Android | Emission |
|---|---|---|---|
| 1 `properties.cc-autoup-freq` | **HELD-NEW**: `appSettings.autoUpdateFrequency` | IGNORED / RUNS | `profile.properties['cc-autoup-freq']` |
| 2 `properties.lazy-load-video-files` = `true` | **REFUSED**: retiring (LAZY_LOAD_MULTIMEDIA) | — | — |
| 2′ `properties.lazy-load-video-files` = `false` | **INERT**: the default | n/a | omit |
| 3 `properties.purge-freq` | **INERT**: disabled; no runtime reader | n/a | omit |
| 4 `properties.cc-days-form-retain` | **HELD-NEW**: `appSettings.daysFormRetain` | IGNORED / RUNS | profile property |
| 5 `properties.logenabled` | **HELD-NEW**: `appSettings.loggingEnabled` | IGNORED / RUNS | profile property |
| 6 `properties.log_prop_weekly` within its choices | **INERT**: no runtime reader; HQ emits the stored value, or `log_short` when unset | n/a | omit |
| 7 `properties.log_prop_daily` within its choices | **INERT**: no runtime reader | n/a | omit |
| 8 `properties.logo_android_home` | → Application `logo_refs.hq_logo_android_home` | — | — |
| 9 `properties.logo_android_login` | → Application `logo_refs.hq_logo_android_login` | — | — |
| 10 `properties.logo_android_demo` | → Application `logo_refs.hq_logo_android_demo` | — | — |
| 11 `properties.logo_web_apps` | → Application `logo_refs.hq_logo_web_apps` | — | — |
| 12 `properties.user_reg_server` | **INERT**: disabled; no reader | n/a | omit |
| 13 `properties.cc-autosync-freq` | **HELD-NEW**: `appSettings.autoSyncFrequency` | RUNS / RUNS | profile property |
| 14 `properties.restore-tolerance` | **INERT**: disabled; no reader | n/a | omit |
| 15 `features.users` | **INERT**: disabled; `ProfileParser` stores it, nothing queries it | n/a | omit (.ccz keeps `<users active="true"/>`) |
| 16 `properties.loose_media` | **INERT**: disabled; no reader | n/a | omit |
| 17 `properties.cc-content-valid` | **HELD-NEW**: `appSettings.multimediaValidation` | IGNORED / RUNS | profile property |
| 18 `properties.unsent-number-limit` | **HELD-NEW**: `appSettings.unsentFormLimit` | IGNORED / RUNS | profile property |
| 19 `properties.unsent-time-limit` | **HELD-NEW**: `appSettings.unsyncedTimeLimit` | IGNORED / RUNS | profile property |
| 20 `properties.cc-show-saved` | **HELD-NEW**: `appSettings.showSavedForms` | IGNORED / RUNS | profile property; HQ always emits `no` when unset, so Nova's `.ccz` must emit it too (today absent ⇒ Android `yes`) |
| 21 `properties.cc-show-incomplete` | **HELD-NEW**: `appSettings.showIncompleteForms` | DIFFERENT (tile visibility only; sessions always persist) / RUNS | profile property; same `.ccz` parity fix |
| 22 `properties.cc-resize-images` | **HELD-NEW**: `appSettings.resizeImages` | IGNORED / RUNS | profile property |
| 23 `properties.cc-fuzzy-search-enabled` | **HELD-NEW**: `appSettings.fuzzyListSearch` | RUNS / RUNS | always explicit (Formplayer's and Android's absent default `no` differs from the yaml default `yes`) |
| 24 `properties.cc-log-entity-detail-enabled` | **HELD-NEW**: `appSettings.logCaseDetailViews` | IGNORED / RUNS | profile property |
| 25 `properties.cc-login-duration-seconds` | **HELD-NEW**: `appSettings.loginDuration` | IGNORED / RUNS | profile property |
| 26 `properties.cc-inflation-target-density` | **HELD-NEW**: `appSettings.imageTargetDensity` | IGNORED / RUNS | profile property |
| 27 `properties.cc-gps-auto-capture-accuracy` | **HELD-NEW**: `appSettings.autoCaptureAccuracy` (the number `10` that HQ's own settings save stores when none was chosen, from the yaml's numeric default against string choices, is the same state as `'10'`) | IGNORED / RUNS | profile property |
| 28 `properties.cc-maps-default-layer` | **HELD-NEW**: `appSettings.defaultMapLayer` | IGNORED / RUNS | profile property |
| 29 `properties.cc-enable-tts` | **HELD-NEW**: `appSettings.textToSpeech` | IGNORED / RUNS | profile property |
| 30 `properties.cc-label-required-questions-with-asterisk` | **HELD-NEW**: `appSettings.requiredAsterisk` | IGNORED / RUNS | profile property |
| 31 `features.dependencies` | **HELD-NEW**: `appSettings.androidAppDependencies` | IGNORED / RUNS | `profile.features.dependencies`; privilege `app_dependencies` precondition (HQ strips it without) |
| 32 `features.credentials` | **TARGET-OWNED**: written by the project page from the domain's `CredentialApplication` row | n/a | omit |
| 33 `hq.application_version` = `2.0` | **INERT**: fixed | n/a | `2.0` |
| 33′ `hq.application_version` = `1.0` | **REFUSED**: not HQ-buildable: `Application.assert_app_v2` | — | — |
| 34 `hq.build_spec` at or above Nova's floor (2.57) | **TARGET-OWNED**: deleted on import-create, excluded on overwrite, so HQ's server-wide default build (`builds/utils.py::get_default_build_spec`) applies to a new app and a person sets it in the app's settings in HQ | n/a | omit; import and publish read it and require the floor |
| 34′ `hq.build_spec` below Nova's floor | **REFUSED**: below the CommCare version floor (HQ silently leaves out features that need a newer version; raising it in HQ fixes it) | — | — |
| 35 `hq.practice_mobile_worker_id` | **TARGET-OWNED**: a target user id; excluded on overwrite | n/a | omit |
| 36 `hq.custom_base_url` | **TARGET-OWNED**: target server URL; excluded on overwrite | n/a | omit |
| 37 `hq.profile_url` on an Application | **REFUSED**: not HQ-buildable (`Application.profile_url` is a read-only property, so `wrap_app` raises `WrappingAttributeError`) | — | — |
| 38 `hq.manage_urls` | **INERT**: RemoteApp only | n/a | omit |
| 39 `hq.case_sharing` | **HELD-NEW**: `caseSharing`: owner from the user's case-sharing group plus the entry assertion (`xform.py::XFormCaseBlock.add_create_block`, `entries.py::add_case_sharing_assertion`) | RUNS / RUNS | `case_sharing: true`; privilege `case_sharing_groups` precondition |
| 40 `hq.cloudcare_enabled` | **HELD-NEW**: the platform declaration's wire form: `true` exactly when the app declares Web Apps (Web Apps lists an app by the value on the build it serves, `cloudcare/utils.py::get_web_apps_available_to_user`) | RUNS / n/a | explicit on every publish (create sets it from the plan, `_create_app_from_doc`); privilege `cloudcare` precondition when `true` |
| 41 `hq.use_custom_suite` = `false` | **INERT**: default | n/a | omit |
| 41′ `hq.use_custom_suite` = `true` | **REFUSED**: not HQ-editable: a disabled setting holding a non-default value, which the settings page marks an error (`commcare_settings.js`: `disabledButHasValue` → `hasError`); HQ's build then emits no `<detail>` (`suite_xml/sections/details.py::DetailContributor.get_section_elements`) | — | — |
| 42 `hq.custom_suite` | **INERT**: never emitted, even with 41′ (only echoed to the settings page) | n/a | omit |
| 43 `hq.secure_submissions` | **TARGET-OWNED**: seeded by HQ's new-app views and rewritten on every app when the project's security setting changes (`domain/forms.py`); an import-API create takes the source's value (`false` when absent); selects the receiver URL (`ApplicationBase.post_url`) | n/a | omit |
| 44 `hq.translation_strategy` = `select-known` | **INERT**: default | n/a | omit |
| 44′ `hq.translation_strategy` ≠ `select-known` | **REFUSED**: not HQ-editable (disabled: "discontinued") | — | — |
| 45 `hq.auto_gps_capture` | **HELD-NEW**: read as `Form.autoCaptureLocation` on every form, since HQ captures location for a form when the form or the app says so (`FormBase.get_auto_gps_capture`; today Nova derives the app value only from `connectType`) | IGNORED (`meta/location` submitted empty) / RUNS | `false`, with each form's own value |
| 46 `hq.use_grid_menus` | **HELD-NEW**: `menuStyle.rootGrid` | RUNS (grid audio IGNORED: no audio control) / RUNS | `use_grid_menus` |
| 47 `hq.grid_form_menus` (`none`/`all`/`some`) | **HELD-NEW**: `menuStyle.formMenus` | RUNS (grid audio IGNORED) / RUNS | `grid_form_menus` (+ per-module `display_style`, Module fields) |
| 48 `hq.target_commcare_flavor` = `none` | **INERT**: default | n/a | omit |
| 48′ `hq.target_commcare_flavor` ∈ {`commcare`, `commcare_lts`} | **REFUSED**: retiring (TARGET_COMMCARE_FLAVOR; the settings file spells its gate `toggles:`, so HQ shows the setting everywhere) | — | — |
| 49 `hq.mobile_ucr_restore_version` = `2.0` | **INERT**: default | n/a | omit |
| 49′ `hq.mobile_ucr_restore_version` ∈ {`1.0`,`1.5`} | **REFUSED**: retiring (MOBILE_UCR) | — | — |
| 50 `hq.location_fixture_restore` = `project_default` | **HELD**: derived by Nova: the one location-fixture state every Nova app holds (Application settings) | n/a | `project_default` on every publish; publish of an app that reads locations asks the person to confirm the flat fixture syncs |
| 50′ `hq.location_fixture_restore` ∈ {`both_fixtures`,`only_flat_fixture`} | **HELD**: derived by Nova: the same state as `project_default` for everything a held app reads, in any project space that syncs the flat fixture, which publish confirms: they differ only in whether the hierarchical fixture also syncs, which needs the retiring HIERARCHICAL_LOCATION_FIXTURE flag and which no held app reads. These two values force the flat fixture on regardless of the project space's stored setting, where `project_default` follows that setting, which is on unless someone turned it off (`locations/fixtures.py::should_sync_flat_fixture`); HQ offers both the app value and the stored setting only under that flag | n/a | `project_default`; publish of an app that reads locations asks the person to confirm the flat fixture still syncs, since Nova cannot read that setting, and stops where it does not (today Nova writes `both_fixtures` for apps that read `instance('locations')`: unproducible) |
| 50″ `hq.location_fixture_restore` = `only_hierarchical_fixture` | **REFUSED**: retiring (HIERARCHICAL_LOCATION_FIXTURE) | — | — |
| 51 `hq.persistent_menu` | **HELD-NEW**: `appSettings.persistentMenu` | RUNS / IGNORED | `persistent_menu` (profile `cc-persistent-menu` always emitted) |
| 52 `hq.show_breadcrumbs` | **HELD-NEW**: `appSettings.breadcrumbs` (absent key = model default `true`) | RUNS / IGNORED | `show_breadcrumbs` explicit |
| target-derived profile properties (`PostURL`, `PostTestURL`, `ota-restore-url[-testing]`, `backup-url`, `restore-url`, `BackupMode`, `key_server`, `cc_user_domain`, `jr_openrosa_api`, `heartbeat-url`, `target-package-id`, `support-email-address`, `recovery-measures-url`, `cur_locale`) | **TARGET-OWNED**: injected by `templates/app_manager/profile.xml` from the target (`BackupMode`, `backup-url`, `restore-url` and `jr_openrosa_api` are template constants, `target-package-id` exists only in flavor profiles, which are refused, and `cur_locale` is the app's first build language) (`recovery-measures-url` by `Application.create_profile` under `MOBILE_RECOVERY_MEASURES`) | n/a | omit |
| `profile.features.sense` = `'true'` or `profile.properties.cc-entry-mode` = `'cc-entry-review'` | **REFUSED**: not HQ-editable: no settings control produces either (settings saves keep them, `views/settings.py::edit_commcare_profile`), and HQ's build then prefixes every menu and form name that does not start with a digit with `${0} ` (from CommCare 2.8) (`app_strings.py::_maybe_add_index`), which Android strips and Web Apps shows literally | — | — |
| any other `profile.properties` / `.features` key not in the yaml | **INERT**: never emitted (`Application.create_profile` loops yaml settings only), and no build reader apart from `_maybe_add_index`, whose effect exists only at the values the row above refuses | n/a | omit |
| `profile.properties` or `features.dependencies` value outside its choices, in a setting the settings page shows (other than the numeric `10` above) | **REFUSED**: not HQ-editable: the settings page marks it an error (`commcare_settings.js`, `widgets.select.valueIsLegal`, and `widgets.multiSelect.valueIsLegal` for `features.dependencies`) | — | — |
| `profile.custom_properties['cc-index-case-search-results']` equal to Nova's derivation | **HELD**: derived by Nova from its search configuration (`lib/commcare/derivedProfile.ts`) | RUNS / IGNORED | as today: only when the target has CUSTOM_PROPERTIES, since HQ's build omits custom properties elsewhere (`Application.create_profile`) |
| `profile.custom_properties` any other entry (incl. formplayer keys `cc-enable-bulk-performance`, `cc-auto-purge`, `cc-sync-after-form`, `cc-auto-advance-menu`, Android `cc-grid-menus`) | **REFUSED**: freeform: arbitrary device-profile properties with no typed editor | — | — |

## Add-ons (`AM/add_ons.py::_ADD_ONS`, 13)

Every add-on is UI visibility only: no build, suite or validator reads `app.add_ons`. Each is **INERT**; the emission column is the value Nova writes so HQ's editors show the page that owns Nova's content.

| HQ item | Disposition | Web Apps / Android | Emission |
|---|---|---|---|
| `advanced_itemsets` | **INERT**: unlocks Vellum's advanced itemset editor | n/a | `true` when any field reads a lookup table or a non-lookup itemset (Question types); hidden without `lookup_tables` |
| `calc_xpaths` | **INERT**: unlocks calculated and translatable-text columns | n/a | `true` when any calculated/translatable column exists |
| `case_detail_overwrite` | **INERT**: copy-config tool, no persisted field | n/a | HQ's current value (the add-on overlay) |
| `case_list_menu_item` | **INERT**: unlocks `case_list` | n/a | `true` when any module shows a case list menu item |
| `conditional_enum` | **INERT**: unlocks the conditional-enum format | n/a | `true` when any conditional-enum column exists |
| `conditional_form_actions` | **INERT**: unlocks open/close conditions | n/a | `true` when any open/close condition exists |
| `display_conditions` | **INERT**: unlocks `module_filter`/`form_filter` | n/a | `true` when any display condition exists |
| `enum_image` | **INERT**: unlocks the icon format | n/a | `true` when any icon column exists |
| `menu_mode` | **INERT**: unlocks `put_in_root` | n/a | `true` when any module shows forms in its parent |
| `register_from_case_list` | **INERT**: unlocks `case_list_form` | n/a | `true` when any case list form exists |
| `subcases` | **INERT**: unlocks child cases (privilege `child_cases` is the editing gate) | n/a | `true` when any child case exists |
| `submenus` | **INERT**: unlocks `root_module_id` | n/a | `true` when any child module exists |
| `empty_case_lists` | **INERT**: new-module default only | n/a | HQ's current value (the add-on overlay) |
