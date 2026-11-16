# Step 6, part 01: The bar and the manifest

Part of step 6's plan, "Bringing an app in from CommCare HQ". This part makes the admission bar
mechanical. It plans the surface manifest's new fields and rules (the six standings, `subject`, `owner`,
value classes, and what CI fails on), every manifest row re-cut by value, the kept test applied to every
top-level property of an HQ application with the table `KEPT_AT_HQ`, the projection `TargetFacts` and its
three readers (the `.ccz`, Preview and the Publishing card), four rules that sit beside the kept test,
and the finding type with its circumstances and its complete copy. It is the one home of every
circumstance, subject and finding sentence of the step: sections 2.2, 8.3, 9.2 and 9.3 and Appendix A
hold each once, and a part that raises a finding cites them.

**The admission bar.** An HQ app A comes in exactly when a Nova document D and ledger rows L exist
such that (a) D passes the absolute gate and export readiness, with no reader-only leniency: the
reader admits exactly what the gate admits; (b) publishing D with L back to A changes nothing a
runtime, CommCare HQ's servers or existing data read, apart from the declared first-publish changes
(part 09, `09-acceptance-and-the-first-publish.md`, section 11); (c) re-reading Nova's own
emission of D gives D exactly; and (d) every item of A's source has exactly one standing. "The
bar's clause (a)" to "(d)" in any part of this plan names one of these four. Acceptance holds them
on every reading (part 09, sections 3 to 6: complete accounting for (d), the gate for (a), the fixed
point for (c), and identity agreement for (b) as far as a source alone can show it). What a standing
is, and where each comes from, is this part's: the standings of section 2, the kept test of section
4 and the findings of section 8.

Citations are `path::symbol`. Nova is read at `main` `1f103305`; the Dimagi checkouts at the pins
`proof/pins.json` names: commcare-hq `d6c6e16d8ae1`, commcare-core `8e9ba8d908e9`, commcare-android
`7a5584475580`, commcare-connect `046c7fd78081`, formplayer `24383ac71bfb`, Vellum `01215f251c57`. Every
CommCare fact below was read at those commits for this part. HQ paths are relative to
`corehq/apps/app_manager/` unless they start with another app's name.

**Versions.** Nothing this part plans changes a tool the Solutions Architect holds, a description it
reads or the guide, so nothing here reaches `lib/models.ts::MODEL_CONTEXT_VERSION`, and this part adds
no `scripts/test-schema.ts` entry. The tools it changes are ones only MCP serves: `refresh_deployment`
gains an input and a description sentence and `get_deployment` a description sentence and a result
field (6.5, 9.6), `upload_app_to_hq` gains a refusal and a description sentence (7.4), and
`compile_app` answers the kept advisories (6.3, 7.2). `lib/agent/CLAUDE.md` exempts a tool only MCP
serves, and `lib/mcp/__tests__/servedSchemas.test.ts` holds what a client receives. Nothing here
changes how an App Test reads the document its journey pinned: the list filter has no App Test step,
and a grouped observation only gains one field (6.4). So nothing here moves
`lib/db/appTests.ts::RUNTIME_VERSION`.

| Section | Owns |
|---|---|
| 2 | the six standings, `subject`, `owner`, value classes, what CI fails on |
| 3 | every row re-cut by value, with its evidence and what makes each new wording true |
| 4 | the kept test over every `Application` property, profile property and translations key class |
| 5 | `KEPT_AT_HQ`, the full table |
| 6 | `TargetFacts`: type, projection, the view-capable reader, the `.ccz`, Preview, the refresh |
| 7 | four rules beside the kept test: a generated translation key, a language's display name and the seeded settings on an app Nova brought in, and a build profile that names a language the app no longer has |
| 8 | the finding type, `HqPlace`, `FixCause`, `READ_CIRCUMSTANCES`, the copy model |
| 9 | every string this part adds, and every finding string of the step |
| 10 | tests |
| 11 | contracts and docs these changes make false |
| Appendix A | `subject` and `owner` for every HELD-NEW and REFUSED entry the manifest holds today (A.1, A.2), and for every entry the step adds |

---

## Decisions in brief

1. **A standing is derived, never authored** (section 2.1). `lib/commcare/surface/standing.ts::standingOf`
   maps an entry to one of six standings from its disposition and, for REFUSED, its reason kinds. An entry
   whose reasons hold a kind of both groups is `never`: what stays true after a fix in HQ decides. A
   `fix-in-hq` entry also has a derived cause (`fixCauseOf`: CommCare HQ refuses it, it breaks when the
   app runs, either by case, or it is below the version floor), because the sentence a person reads
   differs by it.
2. **`subject` is required on every HELD-NEW and REFUSED entry and forbidden elsewhere** (2.2). It is one
   of 78 slugs in `lib/publish/hqFindings.ts::SUBJECTS`, each a noun a person would use. Appendix A
   assigns the 586 entries the manifest holds today and every entry the step adds. Where every run
   gives the outcome its part plans for, 645 entries hold one when the step is done: 285 HELD-NEW and
   360 REFUSED.
3. **`owner` is required on every HELD-NEW entry and forbidden elsewhere** (2.3). It is one of the
   eight step 7 group ids, the groups of `7-rest-of-model.md`. An entry step 6 itself flips carries
   the group it would fall to until it flips.
4. **A HELD-NEW entry that shares a surface key with an allowing entry carries a value class** (2.4).
   Three entries gain one; the other 143 hold one already.
5. **The schema lets a TARGET-OWNED entry keep its per-platform reading** (2.5), so the fifteen settings
   keep the Web Apps and Android cells their rows state. Their Preview answer moves from the platform cell
   table to `KEPT_AT_HQ`.
6. **An entry flips together with the code that makes its new wording true** (3). A re-cut no code
   change makes true (an inert class, a split that only narrows, a re-wording, a stale cell) needs
   nothing else. A kept flip needs the `.ccz` and Preview to read the kept value. A re-cut that claims
   HELD for something only a reader does needs that reader.
7. **`case_tile_field` blank, or on a list with no tile template or the custom one, is inert, and so is
   every tile cell key on a list that is no custom tile** (3.1, 3.2). HQ's Case List page writes all of
   them on every save; HQ reads `case_tile_field` only to fill a template's slots, and the cell keys
   only to build a custom tile.
8. **The ten "outside Predicate / ValueExpression" rows are re-worded against the checker's rule set
   for the slot** (3.4), which is `record` for all ten: the HELD class is what `checkExpression` admits
   in the slot today, the HELD-NEW class what HQ's validator accepts and the checker refuses. No
   disposition moves.
9. **Twenty-three entries become kept** (3.6): the fifteen seeded profile settings,
   `cc-log-entity-detail-enabled`, runtime UI text in `translations` (two entries), the Android logo
   slots, `mobile_ucr_restore_version` at `1.0` or `1.5`, `auto_gps_capture` on an app that is no Connect
   app, `persistent_menu` and `show_breadcrumbs`.
10. **`persistent_menu` and `show_breadcrumbs` are kept, not not-yet** (4.3). Only Formplayer and the Web
    Apps client read them; Preview draws neither, since its breadcrumb is the builder's own.
11. **`mobile_ucr_restore_version` is kept at `1.0` and `1.5`; `2.0` stays inert** (4.3). Its readers
    are report menus and mobile report choice lists, which their own entries refuse, Nova's publish never
    writes the key, and HQ's three starter apps hold `1.0`, as does the fourth directory of
    `template_apps/`, `wash_before_cond_case_update`, which is `wash`'s content from before case updates
    stored `update_mode` and which part 14 counts as no base (`14-proof.md`, section 6.2).
12. **Non-empty `build_profiles` is not-yet; empty is kept** (3.7). `features.dependencies` stays
    not-yet (4.2): the plan privilege that decides whether HQ writes it is unreadable, and it gates the
    whole app on a phone.
13. **Android logos are kept, with a stated `.ccz`** (4.3). Nova holds no bytes for them, so the archive
    says it carries none.
14. **`KEPT_AT_HQ` holds one row per TARGET-OWNED entry, 50 when the step is done** (5), each with a
    `.ccz` cell, a Preview cell, an other-project-space cell and the base that exhibits it. A binding
    test holds the table to the manifest both ways.
15. **`TargetFacts` is a pure projection of a deployment's stored baseline source** (6.1), with no new
    column and no backfill. An absent or unread baseline gives none, and Nova's constants stand. The
    type and the reading of HQ's keys live in `lib/commcare/targetFacts.ts`, which the emitter reads;
    `lib/deployment/targetFacts.ts` applies it to a baseline.
16. **A view-capable reader returns the projection and never the source** (6.2). It sits beside
    `readAppBaseline`, which keeps its `edit` gate.
17. **The `.ccz` mirrors HQ's build of the kept values** (6.3): the fifteen settings and the detail-view
    log at the project space's value, its runtime UI text, `PostURL` on the secure receiver where the app
    submits securely, the three profile URLs on its custom base URL's scheme and netloc, location capture where the
    app captures it, and the worker activity credential where the project space issues one. Four
    things it cannot follow it states in the download's advisories: runtime UI text a language has
    none of, the Android logos, the practice mobile worker, and a language name CommCare HQ fills in
    itself (7.2).
18. **Preview's list filter follows the project space's fuzzy search** (6.4), by Core's own rule, with
    the three things each platform does around it: how it splits the typed text, whether closeness
    reorders the rows (Android) or the list's own order stands (Web Apps), and what an emptied box does
    (on a phone it drops a row whose every field is blank). The same change makes the filter fold
    accents as Core does, which it does not today. A grouped tile list under the filter is drawn from
    the rows that remain, as Web Apps draws it: the groups in the order of each one's first match, and
    each card's heading and its one choice taken from that first match. Today Preview keeps the
    unfiltered order and takes both from the group's first case, which the filter may have removed.
    Nothing in the document, the wire or the gate changes.
19. **Preview marks a required question as the platform it plays does** (6.4): every one in Web Apps,
    and on Android only where the project space's setting says so, which a new app's does not. Today
    Preview marks every required question on both.
20. **Preview learns the facts through a second stream frame, `preview-target-facts`** (6.4), under the
    rule that names `commcare_project`: one reached project space or none.
21. **"Refresh from CommCare HQ" rewrites the baseline only where nothing Nova writes has changed** (6.5).
    Where something has, it writes nothing, says so, and offers to show what changed (part 15,
    `15-changes-made-in-commcare-hq.md`, section 9.6). It is offered on every reached card that has
    a baseline, a card with nothing to list included. The date of the kept list is always the
    baseline's own, worded the same whatever wrote the baseline.
22. **A generated key in `translations` is never kept** (7.1). It is inert where it names no string of
    the app, is blank or equals the text the app's own fields give; held, folded into the one translation
    unit that feeds the string, where that changes no other string; not-yet otherwise.
23. **On a deployment whose app mapping is `adopted`, a language's display name is CommCare HQ's** (7.2):
    a name the project space holds is carried, and an absent one stays absent. Nova writes its label only
    where it created the HQ app.
24. **On a deployment whose app mapping is `adopted`, a publish seeds none of the fifteen settings**
    (7.3). A setting the project space holds no value for stays absent, in the publish and in the
    `.ccz`, so no worker's own choice on a phone is reset by bringing an app in.
25. **A publish stops where a build profile on the target's app names a language the app no longer
    has** (7.4). No API key can change a build profile, so Nova never leaves one stale: the stop is a
    blocking edge of preflight, it names the profile and the language, and it says where the person
    changes it. Removing a language stays always allowed in Nova.
26. **A finding is `{ code, standing, place, subject, detail }`, and a `fix-in-hq` one also carries its
    `cause`** (8.1). `code` is a manifest entry id or one of 34 circumstances (8.3). Nothing parses a
    finding at run time, so there is no schema: one typed constructor makes a circumstance finding and
    the reader's index makes a manifest one. A media file over Nova's size limit and a table over Nova's
    caps are manifest entries, not circumstances. A `stop` is no standing of anything the app holds: it
    says the read ended.
27. **Copy is one sentence per subject and standing for `not-yet` and `never` (54 and 29), one per
    subject and cause for `fix-in-hq` (87 pairs, from 45 stems, three cause clauses and 13 whole
    sentences), and one block per circumstance** (9), held complete both ways by tests. One function,
    `circumstanceBlock`, words every circumstance for the stop block, the account, the copied text and
    MCP alike, with every placeholder filled (8.4).

---

## Executed during planning

Read, by `file::symbol` group. Nothing was run but `rg`, `python3` over the manifest JSON, and file reads.

- **The manifest.** `lib/commcare/surface/schema.ts` (whole); every entry of `entries/*.json` by script
  (1,250 entries: 472 HELD, 237 HELD-NEW, 26 TARGET-OWNED, 166 INERT, 349 REFUSED);
  `surface.json`'s `schema:Application.*`, `ui-string:*` and `app-string-id:*` items;
  `__tests__/manifest.test.ts`, `platformFeatures.test.ts`, `loadManifest.ts`;
  `platformFeatureEntries.ts::AMBIENT_PLATFORM_ENTRIES`; `lib/preview/__tests__/platformCells.ts` and
  `platformCells.test.ts`; `proof/checks/manifest_usage.py` (how entries are read) and
  `manifest_value_classes.py::VALUE_CLASSES` (its tile readers).
- **What a publish sends.** `lib/commcare/hqShells.ts::applicationShell`;
  `targetOverlay.ts::projectApplicationForTarget`, `projectProfileForTarget`,
  `projectTranslationsForTarget`, `ownedProfilePart`; `appProfileSettings.ts`; `appStringKeys.ts`;
  `targetLogoRefs.ts::withoutPathOnlyLogoRefs`; `lib/deployment/hqSourceBaseline.ts::normalizeHqAppSource`,
  `project`, `diffHqAppSource`.
- **The `.ccz` path.** `lib/deployment/downloadTarget.ts::resolveDownloadTarget`;
  `runtimeTarget.ts::ReachedDeploymentTarget`; `store.ts::readReachedDeploymentTargets`,
  `readAppBaseline`, `writeAppBaseline`; `lib/export/localArchive.ts::compileLocalArchive`;
  `lib/commcare/compiler.ts::compileCcz`, `CompileOptions`, `generateProfile`;
  `lib/commcare/runtimeTarget.ts::profileServerProperties`; `xform/metaBlock.ts::addMetaBlock`;
  `lib/publish/exportAdvisories.ts`.
- **Preview.** `lib/deployment/previewSpace.ts`, `previewTarget.ts`;
  `lib/collab/previewProjectSpaceFrame.ts`; `app/api/apps/[id]/stream/route.ts` (the deployment lane);
  `components/builder/DeploymentTargetProvider.tsx`; `components/preview/shared/listFilter.tsx`;
  `components/builder/BreadcrumbStrip.tsx`; `components/preview/PreviewShell.tsx`.
- **HQ.** `models/applications.py::ApplicationBase` and `Application` (every declared property),
  `_merge_source_into_app`, `overwrite_app_from_source`, `export_json`, `scrub_source`, `create_profile`,
  `url_base`, `post_url`, `get_practice_user_id`; `views/app_import_api.py::_handle_import_app`;
  `app_strings.py::_create_custom_app_strings`, `SelectKnownAppStrings`, `non_empty_only`;
  `templates/app_manager/profile.xml`; `static/app_manager/json/commcare-profile-settings.yml` and
  `commcare-app-settings.yml` (every setting); `fixtures/mobile_ucr.py::_parse_apps`;
  `views/releases.py::_check_app_for_mobile_ucr_v1_refs`; `suite_xml/features/case_tiles.py::CaseTileHelper`;
  `suite_xml/sections/details.py` (the tile branch), `menus.py`, `generator.py`, `entries.py`,
  `remote_requests.py`; `helpers/validators.py` (the tile checks, the mobile report check);
  `static/app_manager/js/details/bootstrap5/column.js` (`serialize`);
  `views/settings.py::edit_commcare_profile`; `views/apps.py::new_app`, `default_new_app`,
  `edit_app_langs` (the loop that removes a deleted language from each build profile) and
  `edit_app_attr`; `domain/forms.py::PrivacySecurityForm.save` (the security page's rewrite of every
  app); `domain/views/settings.py::CredentialsApplicationSettingsView.add_credential_to_app_features`;
  the four `static/app_manager/template_apps/*/app.json` (each kept key's value);
  `receiverwrapper/urls.py` (the routes `receiver_secure_post_with_app_id` and
  `receiver_post_with_app_id`); `xform.py` (`has_case_sharing`, `get_auto_gps_capture`'s callers);
  `static/app_manager/js/settings/bootstrap3/commcare_settings.js` (`disabledButHasValue`, `hasError`);
  `hqmedia/models.py::ApplicationMediaMixin.logo_paths`, `remove_unused_mappings`;
  `suite_xml/features/case_tiles.py::case_tile_template_config`, `CaseTileTemplates`. For the build
  profile rule (7.4): `models/applications.py::BuildProfile`, `ApplicationBase.get_build_langs`,
  `Application.create_all_files`, `_create_app_from_doc`; `views/releases.py::LanguageProfilesView`,
  `release_build`; `tasks.py::create_build_files_for_all_app_profiles`;
  `views/download.py::download_file`, `_get_build_profile_id`; `xform.py::XForm.exclude_languages`,
  `set_default_language`; `suite_xml/sections/resources.py::LocaleResourceContributor`;
  `decorators.py::require_can_edit_apps`; `templates/app_manager/partials/releases/build_profiles.html`;
  `static/app_manager/js/releases/bootstrap5/language_profiles.js`;
  `accounting/bootstrap/features.py::advanced_v0`. For Preview (6.4):
  `cloudcare/static/cloudcare/js/formplayer/menus/views.js::CaseTileGroupedListView.initialize`,
  `CaseTileGroupedView.templateContext`, `getIndexedRowDataList`, `CaseView.rowClick`,
  `CaseListView.caseListSearch`, `menus/api.js` (the request's `search_text`, `offset` and
  `cases_per_page`), `utils/utils.js` (`setSearch`),
  `cloudcare/templates/cloudcare/partials/case_list/tile_grouped_item.html` and
  `cloudcare/templates/cloudcare/partials/form_entry/question.html` (the `required` class). For three
  circumstance codes (8.3):
  `api/resources/v0_4.py::BaseApplicationResource.obj_get`, `ApplicationResource.dehydrate_module`,
  `_design/views/applications_brief/map.js`, `views/cli.py::list_apps`,
  `fixtures/resources/v0_1.py::FixtureResource.dehydrate_fields`,
  `fixtures/models.py::LookupTableRow.fields_without_attributes`. For two blank labels (Appendix
  A.1): `app_strings.py::_create_case_list_app_strings`, `_create_case_list_form_app_strings`.
- **Runtimes.** commcare-core `util/EntitySortUtil.java::sortEntities`,
  `cases/util/StringUtils.java::fuzzyMatch`, `normalize`, `cases/entity/Entity.java::getSortFieldPieces`,
  `cases/entity/EntityStringFilterer.java`; commcare-android
  `preferences/MainConfigurablePreferences.java::isFuzzySearchEnabled`,
  `HiddenPreferences.java::shouldLabelRequiredQuestionsWithAsterisk`, `getGpsAutoCaptureAccuracy`,
  `android/javarosa/PollSensorController.java`, `adapters/EntityListAdapter.java::filterByString`,
  `adapters/EntityStringFilterer.java`,
  `activities/connect/viewmodel/PersonalIdWorkHistoryViewModel.kt::getWorkHistoryForAppRecord`;
  formplayer `util/FormplayerPropertyManager.java`, `session/MenuSession.java`,
  `libs/commcare/src/cli/java/org/commcare/util/screen/EntityScreenHelper.java` (`filterEntities`,
  `sortEntities`, `groupEntities`). For a grouped tile list under the filter (6.4): commcare-core
  `util/screen/EntityScreenHelper.java::initEntities`, `util/screen/EntityListSubscreen.java` (its
  constructor), `cases/entity/NodeEntityFactory.java::getEntity` (the group key); formplayer
  `beans/menus/EntityListResponse.java::paginateEntities`, `getEntitiesForCurrentPage`,
  `toEntityBean`, `beans/SessionNavigationBean.java` (`search_text`). commcare-android holds no
  reader of `Detail.getGroup`, `DetailGroup`, `getGroupKey` or `header-rows` (searched under
  `app/src`). For the asterisk (6.4): commcare-android
  `views/widgets/QuestionWidget.java::setTextFromPrompt`; no reader of the setting in formplayer,
  commcare-core or the Web Apps client. For the build profile rule (7.4): commcare-core
  `resources/model/installers/LocaleFileInstaller.java`, `xform/parse/XFormParser.java` (the
  default locale); commcare-android `utils/ChangeLocaleUtil.java`.
- **A retained HQ read.** `proof/hq-reads/case-list-inline/app-source.json` holds every key section 6
  projects (`secure_submissions`, `custom_base_url`, `build_profiles`, `practice_mobile_worker_id`,
  `persistent_menu`, `show_breadcrumbs`, `logo_refs`, `mobile_ucr_restore_version`, `auto_gps_capture`,
  `profile`, `translations`), so the source read serves them and the stored baseline keeps them.
- **Languages, preflight and the grouped read.** `lib/doc/mutations/app.ts` (the language arms);
  `lib/commcare/languageWire.ts`, `localization.ts`, `expander.ts::appLevelValues`,
  `classicLanguages.ts`; `lib/deployment/preflight.ts` (the `target-app` edge),
  `service.ts::publishAppToHq` (the second read), `hqSourceBaseline.ts::ownedProjection`;
  `proof/corpus/targetPeer.ts`, `proof/targeted/documents/hqSideState.ts`, `proof/fixed-defects.json`;
  `lib/case-store/postgres/store.ts::queryGrouped`;
  `lib/preview/engine/caseDataBindingHelpers.ts::readGroupedCases`; `lib/preview/caseTileGrouping.ts`;
  `components/preview/screens/CaseListScreen.tsx`, `components/preview/shared/CaseTileGroup.tsx`;
  `components/preview/form/InteractiveFormRenderer.tsx`, `virtual/rows/FieldRow.tsx`;
  `lib/preview/platform.ts`; `lib/db/settings.ts` (`not_authorized`, `refreshApprovedDomains`).

Claims of a manifest cell or a code comment found false, facts verified at source that a decision
here rests on, and defects of today's Nova found while reading:

- **Verified at source, `mobile_ucr_restore_version`:** `1.0` or `1.5` is not inert on an app with
  no report menu. On a restore made for the whole project space
  `fixtures/mobile_ucr.py::_parse_apps` reads every app's value into `needed_versions`, so the value picks
  the fixture version other apps' reports get. It is kept: Nova's publish never writes the key (4.3).
- **Verified at source, `persistent_menu` and `show_breadcrumbs`:** `lib/preview` draws neither a
  persistent menu nor Web Apps' breadcrumbs: the one trail is
  `components/builder/BreadcrumbStrip.tsx`, the builder's own. So clause 3 of the kept test has
  nothing to answer at any value, and both are kept (4.3).
- **Verified at source, `multimedia_map`:** a binding of a path to a file is identity, recorded per
  target, so its `KEPT_AT_HQ` row takes the identity cells and not a setting's (5).
- **Claim corrected (`lib/commcare/runtimeTarget.ts::profileServerProperties`, its comment):** "every app
  Nova imports has `secure_submissions` off". The import that makes Nova's app copies nothing from the
  project space, so that app starts at the model's `False`
  (`models/applications.py::ApplicationBase.secure_submissions`); but a project space's security page
  rewrites every app when its setting changes (`domain/forms.py::PrivacySecurityForm.save`), so a
  Nova-created app can come to hold `true`, and an app made in HQ holds the project space's setting
  from the start (`views/apps.py::new_app`, `default_new_app`). Section 6.3 replaces the comment and the
  assumption.
- **Claim corrected (manifest entry `application-and-settings/32-features-credentials`):** that
  nothing on a phone reads the profile's `<credentials>`. Android's work
  history reads it from each installed app's profile
  (`PersonalIdWorkHistoryViewModel.kt::getWorkHistoryForAppRecord`, `profile.credentials`, which is
  Core's `Profile.getCredentials`), so the row's `.ccz` cell is `mirrors`, not "no reader" (4.2, 5).
- **Verified at source, HQ's settings page:** `mobile_ucr_restore_version` can be changed there,
  under the flag `MOBILE_UCR` and only to its default `2.0`. The setting is `disabled: true`, and
  `commcare_settings.js` still shows a disabled setting whose value is not its default, marks it an
  error and offers the default (`disabledButHasValue`, `hasError`), under the flag `MOBILE_UCR`. The
  key is kept on clause 1 and on its refused readers, not on being fixed in place.
- **Claim corrected (manifest entry `application-and-settings/multimedia-map`, emission cell):** it cites
  `bundle.ts::buildMultimediaMap`, which no longer exists. Nova sends no `multimedia_map` in any mode.
- **Found while planning, Preview:** `components/preview/shared/listFilter.tsx::rowMatchesFilterText`
  lower-cases and compares, where Core's filter first removes accents from both sides
  (`StringUtils.normalize`: NFD, combining marks removed, lower case). A worker who types "jose" finds
  "José" on a device and not in Preview. Section 6.4 fixes it with the fuzzy rule, since both are one
  function.
- **Found while planning, Preview:** under the list filter, a grouped tile list is drawn wrong in
  three ways that have one cause. Formplayer filters the whole list, then sorts it, then gathers
  groups in order of first appearance (`EntityScreenHelper.java::initEntities`), so the client
  receives only the matches: its groups are in the order of each one's first match, and the one
  model it keeps per group, which draws the heading and takes the tap, is that first match
  (`views.js::CaseTileGroupedListView.initialize`, `CaseTileGroupedView.templateContext`,
  `CaseView.rowClick`). Preview filters inside each group it already drew
  (`components/preview/screens/CaseListScreen.tsx::CaseListScreen`, the memo `filteredGroups`), so
  the groups keep their unfiltered order, the heading is drawn from the group's own first case, and
  a tap opens that case even where the filter removed it (`ResultsTiles`, `actionRow`). With visits
  ordered by name, Ada and Cal in one household and Ben and Dot in another, a filter that matches
  Ben, Cal and Dot gives, in Web Apps, Ben's household first (heading from Ben, a tap opens Ben)
  and then Cal's (heading from Cal, a tap opens Cal). Preview gives Cal's household first, with
  its heading from Ada, and a tap there opens Ada. Section 6.4 fixes all three.
- **Found while planning, the two runtimes around Core's filter:** Android splits the typed text on
  runs of whitespace (`EntityListAdapter.java::filterByString`, `split("\\s+")`) and shows the matches
  in the order the filter returns them, closest first under fuzzy search. Formplayer splits on single
  spaces (`EntityScreenHelper.java::filterEntities`, `split(" ")`) and then sorts the matches by the
  list's own order and groups them (`sortEntities`, `groupEntities`), so in Web Apps closeness orders
  only rows the list's order ties. A phone whose filter box was typed in and then cleared runs one
  empty term, which drops a row whose every field is blank (`filterByString`;
  `EntityStringFilterer.java`, `isFilterEmpty`), where Web Apps skips an empty text. Preview follows
  each on the platform it plays (6.4).
- **Found while planning, publish:** the fifteen seeded settings are written wherever the project
  space holds no value (`targetOverlay.ts::projectProfileForTarget`, `holdsNoValue`), and each is
  written forced but the map layer. HQ's build writes nothing for an absent one
  (`Application.create_profile`), so a first publish over an app made in HQ would turn fifteen absent
  settings into forced ones, and a forced setting returns a worker's own choice on the phone to that
  value at every update (`appProfileSettings.ts`, its header). On an app Nova created that is Nova's
  own stated behavior. On an app Nova brings in it would be a change to workers' phones, so an adopted
  deployment is not seeded (7.3).
- **Found while planning, Preview:** Preview marks every required question, on either platform.
  Android marks one only where `cc-label-required-questions-with-asterisk` is `yes`
  (`views/widgets/QuestionWidget.java::setTextFromPrompt`,
  `HiddenPreferences.java::shouldLabelRequiredQuestionsWithAsterisk`, whose default is `no`), and
  Nova's own value is `no`, so a phone running an app Nova made marks none. Web Apps marks every
  one (`cloudcare/templates/cloudcare/partials/form_entry/question.html`). No doc states it.
  Section 6.4 fixes it: Preview marks a required question as the platform it plays does.
- **Found while planning, publish:** a language a Nova author removes stays in each of HQ's build
  profiles, because an update writes `langs` and never `build_profiles`, where HQ's own Languages page
  removes it from both (`views/apps.py::edit_app_langs`, the loop over `app.build_profiles`). It
  reaches only an app whose HQ copy has build profiles. Step 6 fixes it: a publish stops before it
  would leave such a profile (section 7.4).
- **Read, the finding copy against the manifest:** every sentence of 9.2 was read against every
  entry Appendix A gives its pair, the entries this step adds among them. Thirteen entries a
  sentence was untrue of are filed under the subject whose sentence is true of them (2.2), and no
  test can hold this (2.6).
- **Decided by reading, three circumstance codes** (8.3). A remote app is in the app list and
  answers 404 at the application resource; CommCare HQ's summary of an app is an error entry per
  menu and never an error for the app whole; and a table row holding a field with no value raises
  an error the fixture resource does not catch. So `remote-app`, `app-unreadable-in-hq` and
  `table-rows-unreadable` stand with no condition.

---

## Written and not yet run

Four checks wait on execution. Each names where it runs and what the session does for every outcome.
A fix lands in the function the outcome names before the merge, with no register entry: the plan and
the build must agree. Before any outcome that narrows what Nova holds, the session reads which side
is wrong, and corrects Nova's emitter, port or Preview where it is Nova's.

**Run 1: the `.ccz` mirror, on a kept configuration.** Where: the proof lane, in the dispatch the
session starts itself over the step's targeted documents, with every reader. What: the targeted
corpus document `targeted-kept-values` (part 14, `14-proof.md`, section 12.1, counts it), which
declares Android, published to an HQ app whose source was first given each mirrored value of section 5
(the fifteen settings at a choice other than Nova's seed, `cc-log-entity-detail-enabled`, one runtime
UI text key in each language, `secure_submissions: true`, `auto_gps_capture: true`, and
`profile.features.credentials: "3MON_ACTIVE"`), then proof 3 between HQ's build and the local
archive, and proof 2 over `profile.ccpr` and each `app_strings.txt`.

| Outcome | What the session does |
|---|---|
| No difference | Nothing. The cells of section 5 stand. The document stays in the corpus as the control of the kept rows and stays beside the base `hq-kept-settings`: the two are different deployments, a Nova-born app whose kept values a person saved in HQ and an app made in HQ and brought in (part 14, section 6.2). |
| A profile property differs in value or `force` | It corrects `lib/commcare/keptProfile.ts::targetProfileProperties`. |
| A property HQ writes is absent from the archive for a key section 4 calls inert | That entry is not inert on Android. It moves the entry's row to kept with `mirrors`, and the key joins `KEPT_PROFILE_PROPERTY_KEYS`. |
| An app string differs for a runtime UI key | It corrects `compileCcz`'s table merge (6.3). |
| `PostURL` differs under `secure_submissions` | It corrects `profileServerProperties`, or, where the archive's URL still names the capture's placeholder app id (`proof/corpus/publish.ts::PLACEHOLDER_APP_ID`), the harness's rewrite that writes A's id into each runtime URL naming the app (`proof/hq/operations.py::with_runtime_app_id`), which must know both receivers `ApplicationBase.post_url` picks between (`receiver_post_with_app_id`, `receiver_secure_post_with_app_id`). |
| The `<credentials>` block differs or is absent on one side | It corrects `generateProfile`'s features (6.3). Where HQ's build writes none for a stored level, the row moves to `no-reader` and `credentialLevel` leaves `TargetFacts`. |
| HQ's build shows a difference no row of section 5 names | Where the archive misses something a row of section 5 already promises, it corrects the archive. Otherwise it puts the key to the kept test of section 4. Where no publish writes the key, nothing the document holds does something different under it, and the archive can write HQ's value from the stored source or state the difference in an advisory, its entry becomes TARGET-OWNED with a `KEPT_AT_HQ` row (`mirrors` or `states`). Where clause 2 or clause 3 fails, the value is content Nova has no place for: its entry moves to not-yet with owner `settings-nova-comes-to-own`, and the list of kept settings in `content/docs/publishing.mdx` (9.7) loses the setting where it names it. |

`custom_base_url` is not in this document. It is shown on the base `hq-kept-settings` (part 14, section
6.2), which posts it through the app settings page's save (`views/settings.py::edit_commcare_settings`,
which stores it through `views/apps.py::edit_app_attr` with `all`; the attribute's own URL answers 400), and a Vitest over
`profileServerProperties` holds the vectors, one of them a base URL with a path (section 10).

**Run 2: Core's fuzzy match, natively.** Where: the work's own CI, in the proof lane every pull
request runs, native family `expression`. What: the vectors of
`lib/preview/__tests__/listFilterMatch.test.ts` (section 10) run through
`org.commcare.cases.util.StringUtils.fuzzyMatch` and `normalize`.

| Outcome | What the session does |
|---|---|
| Every vector agrees | Nothing. The native test stays as the control. |
| A vector differs | It corrects the port in `lib/preview/listFilterMatch.ts` and keeps the vector. |

The run holds Core's two functions alone. How each runtime splits the typed text and orders the matches
is read at source (6.4) and held by Vitest vectors worked from Java's `String.split`.

**Run 3: an app made in HQ with an empty profile, brought in.** Where: the proof lane, in the dispatch
the session starts itself over the bases (part 14's run P2), on the base `hq-new-app`, whose profile
holds none of the fifteen settings. What: the first publish over the adopted deployment, then proof 3
between HQ's build and the local archive made for that deployment, and proof 1 over `profile` against
the first-publish register.

| Outcome | What the session does |
|---|---|
| The publish leaves `profile.properties` without the fifteen, and the archive writes none of them | Nothing. Section 7.3 stands, and the base stays as its control. |
| The publish writes a seeded key | It corrects `projectProfileForTarget`'s `seeds` option or `publishAppToHq`'s choice of it (7.3). An adopted deployment is not seeded. |
| The archive writes a seeded key HQ's build does not | It corrects `targetProfileProperties` (6.3, 7.3). |
| HQ's build writes a property for an absent key of the fifteen | That setting has a default HQ writes on its own. For an adopted deployment the archive then writes HQ's default at HQ's `force` for it (`targetProfileProperties`), and the publish still writes nothing. |

**Run 4: the Web Apps client's cards for a grouped tile list under a filter.** Where: the proof lane,
in the one slice the session starts itself for the step's three tests that take the Web Apps reader
(part 14, `14-proof.md`, section 12.4, holds the command, which names this test by its node id).
Core's half of the same rule needs no dispatch: the intent check runs the two expectations of
`targeted-tile-group-filter` on every pull request (6.4, "Proof"). What:
`test_web_apps_makes_a_grouped_tiles_cards_from_the_rows_a_search_leaves`.

| Outcome | What the session does |
|---|---|
| The cards are the ones 6.4 states: three before the search, then Ben's and Cal's, each with its first match's id and heading | Nothing. The test stays as the control of the rule. |
| CommCare gives a value differently, here or in the intent check | Section 6.4 misread CommCare. It corrects `tileGroupCards`, its vectors, the two expectations and the smoke step to what CommCare gave. |

No other fact of this part waits on a run. No production read is needed: nothing here migrates or scans.

---

## 1. What Nova does today

**The manifest.** `lib/commcare/surface/entries/<area>.json` holds 1,250 inventory entries, each with one
of five dispositions (`schema.ts::DISPOSITIONS`). A REFUSED entry carries one or more reasons of nine
kinds (`REFUSAL_REASON_KINDS`); `unavailable-on-declared-platform` is used by none. No entry carries
anything a person could read: `item` and `dispositionCell` are wire vocabulary. No TypeScript outside
tests reads the inventory entries; runtime code reads `gates.ts` and `schemaDefaults.ts` alone.
`__tests__/manifest.test.ts` holds that no two entries claim one key at one value class. The proof lane
treats any HELD, TARGET-OWNED or INERT entry on a key as allowing the rest of that key's values
(`proof/checks/manifest_usage.py`), so for 146 HELD-NEW entries the line between held and not held is the
value class's prose.

**What a publish writes and leaves.** HQ's update replaces every top-level key the body carries and keeps
every key it leaves out, except the excluded ones, which it never writes
(`models/applications.py::_merge_source_into_app`, `ApplicationBase._update_excluded_fields`: `_id`,
`_rev`, `domain`, `copy_of`, `version`, the two short URLs, `date_created`, `name`, `comment`,
`doc_type`, `multimedia_map`, `family_id`, `copy_history`, `build_profiles`, `custom_base_url`,
`practice_mobile_worker_id`, with `build_spec` and `_attachments` added by the merge). The import view
then sets `created_from_template` and, where the request names one, `name`
(`views/app_import_api.py::_handle_import_app`). Nova's body holds `doc_type`, `application_version`,
`name`, `langs`, `translations`, `location_fixture_restore`, `cloudcare_enabled`, `modules`,
`_attachments`, and where they apply `auto_gps_capture` (written `true` for a Connect app only),
`profile`, `add_ons` and `logo_refs` (`hqShells.ts::applicationShell`, `targetLogoRefs.ts`).
`targetOverlay.ts::projectApplicationForTarget` projects `translations`, `add_ons` and `profile` on the
publish's last read: the target's own keys are carried, Nova's are written, and each of the fifteen
seeded settings is written only where the target holds no value.

**The drift baseline.** `app_deployment_baselines.source_gzip` holds HQ's whole source read, normalized
only in what each read mints (`hqSourceBaseline.ts::normalizeHqAppSource`), so every kept value is in it.
`store.ts::readAppBaseline` requires the `edit` capability, because the row holds app source. The drift
comparison reads only what Nova writes (`hqSourceBaseline.ts::project`): `modules`, the form attachments,
`name`, `langs`, `application_version`, `location_fixture_restore`, the add-ons and profile keys Nova
owns, `auto_gps_capture` where Nova owns it, and the `translations` keys the target does not own.

**The `.ccz`.** `lib/deployment/downloadTarget.ts::resolveDownloadTarget` chooses the one reached
deployment an archive is made for and reads its identity overrides.
`store.ts::readReachedDeploymentTargets`, which authorizes `view`, carries the two target facts an
archive reads today: `emptyCaseListText`, from the typed column
`app_deployments.target_empty_case_list_text` a publish writes, and `earlierHqApps`.
`lib/export/localArchive.ts::compileLocalArchive(prepared, runtimeTarget, identity, deployment)` hands
both to `compileCcz`. Everything else in the archive is Nova's own: `generateProfile` writes the
seventeen settings of `appProfileSettings.ts::appProfileProperties` at Nova's values, whatever the project
space holds; `profileServerProperties` writes the plain receiver on the server's own base URL; the app
strings hold no key Nova did not make; and `addMetaBlock` captures location only for a Connect app.

**Preview's project-space facts.** Preview knows one fact of the project space, its name.
`lib/deployment/previewSpace.ts::previewProjectSpaceFor` resolves it under
`previewTarget.ts::resolvePreviewDeploymentTarget` (one reached deployment gives its domain; none or
several give `null`); the builder page seeds `DeploymentTargetProvider`, a publish and a Check status
return it, and `/api/apps/{id}/stream` announces it in a `preview-project-space` frame
(`lib/collab/previewProjectSpaceFrame.ts`). Preview reads no profile setting: its list filter is an exact
substring match (`components/preview/shared/listFilter.tsx::rowMatchesFilterText`), and it marks every
required question on both platforms (`components/preview/form/InteractiveFormRenderer.tsx`).

**A grouped tile list under the filter.** The case store clusters a grouped list in the statement
that pages it: each row's position under the list's order, each group's first position, the groups
ranked by it, a page of whole groups (`lib/case-store/postgres/store.ts::queryGrouped`, which
reproduces `EntityScreenHelper.java::groupEntities` and
`EntityListResponse.java::getEntitiesForCurrentPage`). It computes each row's position
(`ROW_ORDINAL_ALIAS`) and drops it from the row it returns (`GROUPED_ROW_ALIASES`, in
`shapeCaseRow`). `lib/preview/engine/caseDataBindingHelpers.ts::readGroupedCases` hands the groups
on, and `rows` as the page in clustered order. The screen then filters inside each group and keeps
the group's first case as its heading and its choice
(`components/preview/screens/CaseListScreen.tsx::CaseListScreen`, the memo `filteredGroups`; the
type `ResultsTileGroup`, whose `header` is "the group's own first case even when the list filter
has narrowed `rows`"; `ResultsTiles`, whose `actionRow` is that header; `chooseVisibleCases`, which
adds each group's header). So no filtered group can move, since the browser holds no order between
two rows of different groups, and a card's heading and choice can name a case the filter removed.

**Languages and build profiles.** Removing a language, or relabelling the one language of a
single-language app, changes the document alone (`lib/doc/mutations/app.ts`), and the next publish
writes `langs` from it and never `build_profiles`. Nothing reads the profiles an HQ app holds (7.4).

---

## 2. The manifest's new fields and rules

### 2.1 Standings

The vocabulary a person or a client reads lives outside `lib/commcare`, because Biome's
`noRestrictedImports` keeps `components/**` and `lib/publish/**` from importing it, and `lib/commcare`
already imports its public words from `lib/publish` (`lib/commcare/projectSpaceCompatibility.ts`
re-exports `lib/publish/projectSpaceCompatibility.ts`). So one new client-safe file,
`lib/publish/hqFindings.ts`, holds the standings, the subjects, the group ids and the finding type
(2.2, 2.3, 8.1), with no CommCare wire word in it, and `lib/commcare/surface` imports from it.

```ts
// lib/publish/hqFindings.ts
export const READ_STANDINGS = [
	"held", "kept", "inert", "not-yet", "never", "fix-in-hq",
] as const;
export type ReadStanding = (typeof READ_STANDINGS)[number];
/** The standings an account shows. */
export type FindingStanding = Extract<ReadStanding, "not-yet" | "never" | "fix-in-hq">;

/** Why a `fix-in-hq` thing needs a change in CommCare HQ. It chooses the sentence (8.4). */
export const FIX_CAUSES = ["hq-refuses", "breaks-when-run", "either", "below-floor"] as const;
export type FixCause = (typeof FIX_CAUSES)[number];
```

New file `lib/commcare/surface/standing.ts`, pure, importing `schema.ts` and that file:

```ts
/** The reason kinds a fix in CommCare HQ does not lift. */
export const NEVER_REASON_KINDS = [
	"retiring", "freeform", "untypeable", "unrepresentable-identity",
] as const satisfies readonly RefusalReasonKind[];

/** The reason kinds a change in CommCare HQ lifts. */
export const FIX_IN_HQ_REASON_KINDS = [
	"not-hq-editable", "not-hq-buildable", "broken-at-runtime",
	"below-commcare-version-floor", "unavailable-on-declared-platform",
] as const satisfies readonly RefusalReasonKind[];

export function standingOf(entry: InventoryEntry): ReadStanding;

/** The cause of an entry whose standing is `fix-in-hq`, and `null` for every other entry. */
export function fixCauseOf(entry: InventoryEntry): FixCause | null;
```

| Disposition | Reasons | Standing |
|---|---|---|
| HELD | | `held` |
| TARGET-OWNED | | `kept` |
| INERT | | `inert` |
| HELD-NEW | | `not-yet` |
| REFUSED | any reason of `NEVER_REASON_KINDS` | `never` |
| REFUSED | every reason of `FIX_IN_HQ_REASON_KINDS` | `fix-in-hq` |

A compile-time check holds the two lists to a partition of `REFUSAL_REASON_KINDS`
(`Exclude<RefusalReasonKind, Never | Fix>` is `never`). Today 91 REFUSED entries are `never`, 256
`fix-in-hq`, and 2 hold a kind of each and are `never`
(`forms-and-case-writes/form-links-target-any-other-module`,
`menus-and-case-lists/any-module-under-a-training-menu`): changing either in HQ leaves it on a retiring
flag, so "change it in CommCare HQ" would send a person to do work that changes no answer.

**The cause of a `fix-in-hq` entry.** The five kinds of `FIX_IN_HQ_REASON_KINDS` say different things
to a person: CommCare HQ will not save or build the thing, or it builds and then does not work when the
app runs. One sentence cannot be true of both, so `fixCauseOf` derives which, from the entry's reasons
and nothing else:

| The entry's `fix-in-hq` reason kinds | Cause | Entries today |
|---|---|---|
| only `not-hq-editable` or `not-hq-buildable` | `hq-refuses` | 179 |
| only `broken-at-runtime` or `unavailable-on-declared-platform` | `breaks-when-run` | 63 |
| at least one of each group above | `either` | 13 |
| `below-commcare-version-floor` | `below-floor` | 1 |

The thirteen `either` entries each hold reasons of both groups, ten of them limited by a
`condition` ("in a bind" beside "in an output or setvalue", "in a basic or shadow module" beside "in
an advanced one"). A finding names its entry and not the condition that applied, so the sentence for
`either` says both and is true whichever applied. `unavailable-on-declared-platform` is used by no
entry; it sits with `broken-at-runtime` because what it would say to a person is the same: HQ builds
it and it does not run. A `below-commcare-version-floor` reason stands alone on its entry (one entry
today), and the manifest test holds that (2.6), so `below-floor` never mixes.

The reader's runtime index of entry id to standing, cause and subject is part 06's
(`06-the-reader-forms.md`, section 3); it calls `standingOf` and `fixCauseOf` and adds no rule of
its own.

### 2.2 `subject`

`lib/publish/hqFindings.ts` holds the subjects: it is read by the manifest schema, by the reader and by
client copy, and holds no manifest JSON.

```ts
export const SUBJECTS = [
	/* the slugs of the table below, in its order */
] as const;
export type Subject = (typeof SUBJECTS)[number];
// lib/commcare/surface/schema.ts
export const subjectSchema = z.enum(SUBJECTS);
```

`schema.ts::inventoryEntrySchema` gains `subject: subjectSchema` on the HELD-NEW arm and on the REFUSED
arm. The other arms stay strict objects without it, so a HELD, TARGET-OWNED or INERT entry that names a
subject fails to parse.

The closed set is 78. Each row gives the subject's label (`SUBJECT_LABELS`, 8.4), what it names, and the
count of entries that take it by standing (not-yet / never / fix-in-hq) when the step is done.
Appendix A lists the entries of each.

| Subject | Label | What it names to a person | Entries |
|---|---|---|---|
| `advanced-forms` | Advanced forms | the cases an advanced form loads or opens | 11 / 0 / 23 |
| `advanced-menus` | Advanced menus | an advanced menu | 1 / 0 / 0 |
| `after-submit` | After a form is sent | where a form goes after it is sent | 0 / 2 / 4 |
| `android-app-dependencies` | Android app dependencies | Android apps the phone must have | 1 / 0 / 1 |
| `app-document` | The app as stored | how CommCare HQ stores the app | 0 / 1 / 9 |
| `app-logos` | App logos | app logos | 0 / 0 / 1 |
| `app-settings` | App settings | an app setting | 0 / 2 / 3 |
| `auto-select` | Choosing a case automatically | choosing a case for the worker | 2 / 0 / 3 |
| `blank-form` | Forms with no questions | a form with no questions | 0 / 0 / 1 |
| `build-profiles` | Build profiles | build profiles | 1 / 0 / 0 |
| `call-center-indicators` | Call center indicators | call center indicators | 0 / 2 / 0 |
| `case-attachments` | Files saved on a case | pictures or files saved on a case | 0 / 4 / 0 |
| `case-detail-tabs` | Case detail tabs | tabs on the case detail screen | 5 / 0 / 1 |
| `case-list-callout` | Case list lookups | a lookup from the case list into another Android app | 8 / 0 / 2 |
| `case-list-columns` | Case list and detail columns | a case list or case detail column | 25 / 2 / 18 |
| `case-list-filter` | Case list filters | the case list filter | 1 / 0 / 1 |
| `case-list-optimizations` | Case list speed settings | a case list speed setting | 2 / 2 / 0 |
| `case-list-registration` | Registration from the case list | a form offered from the case list | 7 / 0 / 3 |
| `case-list-setup` | Case list setup | how a case list is set up | 1 / 0 / 4 |
| `case-list-sorting` | Case list order | the order of a case list | 5 / 0 / 2 |
| `case-list-text` | Case list wording | a list's own wording | 2 / 0 / 0 |
| `case-preloads` | Loading case values into questions | a question that loads a case value | 4 / 0 / 4 |
| `case-property-names` | Case property names | a case property name | 2 / 0 / 5 |
| `case-sharing` | Case sharing | case sharing | 2 / 0 / 1 |
| `case-tiles` | Case tiles | a case tile | 9 / 0 / 7 |
| `case-types` | Case types | a case type | 0 / 0 / 1 |
| `child-cases` | Child cases | a child case | 0 / 1 / 8 |
| `commcare-version` | CommCare version | the CommCare version the app is built for | 0 / 0 / 1 |
| `connect-blocks` | CommCare Connect | a CommCare Connect block | 4 / 0 / 3 |
| `custom-assertions` | Custom assertions | custom assertions | 0 / 3 / 0 |
| `custom-device-properties` | Custom device properties | custom device properties | 0 / 1 / 0 |
| `data-registry` | Data registries | a data registry | 0 / 4 / 0 |
| `data-sources` | Data a form or list reads | data a form or list reads from the device | 2 / 0 / 8 |
| `deep-links` | Deep links | a deep link | 1 / 1 / 4 |
| `display-conditions` | Display conditions | a menu's or form's display condition | 3 / 0 / 6 |
| `display-only-forms` | Forms shown in the menu above | forms shown in the menu above their own | 2 / 0 / 4 |
| `expressions` | Expressions | an expression | 1 / 0 / 11 |
| `form-case-management` | Case management | a form's case management | 3 / 0 / 11 |
| `form-settings` | Form settings | a form setting | 2 / 0 / 2 |
| `form-source` | A form's source | a form's source | 1 / 0 / 8 |
| `hand-written-content` | Hand-written XML | hand-written XML or settings no HQ page edits | 0 / 22 / 0 |
| `hierarchical-locations` | The older organization list | the older, nested list of places | 0 / 3 / 0 |
| `instance-text` | Text read as a data source | a name or description CommCare HQ reads as a data source | 0 / 0 / 2 |
| `language-codes` | Language codes | a language code | 1 / 0 / 2 |
| `list-and-search-filters` | Case list and search filters | a case list filter its search doesn't share | 1 / 0 / 0 |
| `lookup-selection` | Choosing from a lookup table first | choosing from a lookup table before the case list | 0 / 2 / 0 |
| `lookup-tables` | Lookup tables | a lookup table | 10 / 0 / 2 |
| `media-by-language` | Media by language | a picture or sound that differs by language | 3 / 0 / 0 |
| `media-files` | Media files | a media file | 1 / 0 / 7 |
| `menu-badges` | Menu badges | a badge on a menu or form | 2 / 0 / 0 |
| `menu-display` | Grid menus | grid menus | 3 / 0 / 0 |
| `menu-settings` | Menu settings | a menu setting | 0 / 0 / 1 |
| `menu-structure` | How menus are nested | how menus are nested | 1 / 1 / 2 |
| `mirror-menus` | Mirror menus | a mirror menu | 4 / 1 / 3 |
| `missing-media-files` | Missing media files | a media file the app points at that CommCare HQ doesn't have | 0 / 0 / 2 |
| `mobile-reports` | Mobile reports | mobile reports | 0 / 4 / 0 |
| `parent-selection` | Choosing a parent case first | choosing a parent case first | 1 / 2 / 3 |
| `print-templates` | Print templates | a print template | 0 / 2 / 0 |
| `question-appearance` | How a question looks | how a question looks | 56 / 6 / 2 |
| `question-choices` | Choices | a question's choices | 5 / 0 / 8 |
| `question-ids` | Question IDs | a question ID | 1 / 1 / 2 |
| `question-logic` | Question logic | a question's logic | 3 / 0 / 6 |
| `question-media` | Media on questions | a picture, sound or label form on a question | 5 / 0 / 1 |
| `question-text` | Question text | a question's text | 6 / 0 / 8 |
| `question-types` | Kinds of question | a kind of question | 9 / 0 / 12 |
| `repeats` | Repeat groups | a repeat group | 2 / 0 / 14 |
| `save-to-case` | Save to Case questions | a Save to Case question | 8 / 0 / 5 |
| `search-default-filters` | Search filters | a search filter | 13 / 2 / 4 |
| `search-expressions` | Search expressions | a search expression | 4 / 2 / 5 |
| `search-fields` | Search fields | a search field | 13 / 0 / 6 |
| `search-setup` | Search setup | how the search is set up | 12 / 1 / 4 |
| `shadow-forms` | Shadow forms | a shadow form | 4 / 0 / 3 |
| `supply-features` | CommCare Supply | CommCare Supply features | 0 / 9 / 0 |
| `training-menus` | Training menus | a training menu or release notes form | 0 / 3 / 0 |
| `translation-overrides` | Changed wording in translations | changed wording for a menu, form or list held in the app's translations | 1 / 0 / 0 |
| `visit-scheduler` | Visit schedules | a visit schedule | 0 / 5 / 0 |
| `worker-record` | The worker's own record | the worker's own record | 4 / 1 / 4 |
| `writer-types` | Answers of different kinds | answers of different kinds saved to one case property | 4 / 0 / 0 |

How Appendix A was cut, so a new entry takes its subject the same way: (1) a `retiring` reason whose
flag is CommCare Supply, mobile reports, the visit scheduler, a data registry, case attachments, training
menus, the nested location list, custom assertions or printing takes that feature's subject, wherever
the row sits; (2) a `freeform` reason with no closer subject takes `hand-written-content`; (3) otherwise
the entry takes the subject of the thing its author would name, which is nearly always its inventory
section's. An entry whose pair's sentence would be untrue of it takes the subject whose sentence is
true: a call center indicator column is `call-center-indicators` and no column format, an endpoint
id is `deep-links` whatever menu holds it, and a media file CommCare HQ does not have is
`missing-media-files`, where a file in a format that does not play is `media-files`.

**The subjects of entries other parts add.** Each new entry of parts 02 and 04 takes a slug of the
closed set; the words in quotation marks below say what the entry is about.

| Part | Entries | Subject |
|---|---|---|
| 02 | its new HELD-NEW `case-list-form-…` entries, and the two it keeps HELD-NEW (the ids are in Appendix A.1) | `case-list-registration` |
| 02 | its new REFUSED entry `case-list-form-post-form-workflow-default-on-a-multi-select-host` (`broken-at-runtime`; it names no subject there) | `case-list-registration` |
| 04 | N1, a case type outside the menu page's grammar ("a case type") | `case-types`, a subject this step adds for it |
| 04 | N2, N7 ("a case property") | `case-property-names` |
| 04 | N3, N8 ("a Search field") | `search-fields` |
| 04 | N4, N5 ("a lookup table") and N24 (`expressions-and-data/tag-or-field-name-holding-a-period`, owner `project-data-at-hq-size`) | `lookup-tables` |
| 04 | N6 ("a choice") | `question-choices` |
| 04 | N9 ("a menu": a child menu of another case type under a parent with no forms) | `menu-structure` |
| 04 | N14 ("a menu": a parent menu of another case type) | `parent-selection` |
| 04 | N10 ("a case list") | `case-list-setup` |
| 04 | N11, N12, N13 ("a case list column") | `case-list-columns` |
| 04 | N15, N16 ("a CommCare Connect block") | `connect-blocks` |
| 04 | N17, N18, N19 ("a question": required, a validation condition or a default on a kind Nova gives none) | `question-logic` |
| 04 | N20, N21, N23 ("a question": hint, help or validation text on a kind Nova gives none) | `question-text` |
| 04 | N22 ("a question": help media on a kind Nova gives none) | `question-media` |

Part 03's entries name slugs of the set too.
`questions/a-markdown-form-in-a-form-whose-text-formatting-is-off` takes `question-text` (part 06,
`06-the-reader-forms.md`, section 12.2), and `case-search/title-label-blank-in-some-languages` takes
`search-setup` (part 07, `07-the-reader-cases-menus-lists.md`, section 14). Its two REFUSED entries for
text CommCare HQ's build reads as a data source, `questions/connect-block-text-read-as-an-instance`
and `forms-and-case-writes/form-name-read-as-an-instance` (part 03, `03-questions-and-text.md`,
section 5.1), take `instance-text`, a subject this step adds for them.

A part that adds an entry names a subject of this set. Every sentence is in 9.2, and every entry is
in Appendix A with its subject and its owner or standing.

### 2.3 `owner`

`hqFindings.ts` also exports the ids of the eight groups of `7-rest-of-model.md`, in its order:

```ts
export const STEP_7_GROUPS = [
	"project-data-at-hq-size", "settings-nova-comes-to-own", "question-display",
	"case-list-and-detail", "menus", "case-search", "forms-and-case-management", "xform",
] as const;
export type Step7Group = (typeof STEP_7_GROUPS)[number];
```

`inventoryEntrySchema`'s HELD-NEW arm gains `owner: z.enum(STEP_7_GROUPS)`; no other arm admits it.
Appendix A.1 assigns every one. Where every run gives the outcome its part plans for, the counts when
the step is done are `question-display` 63, `case-list-and-detail` 62, `case-search` 42, `xform` 40,
`forms-and-case-management` 33, `menus` 22, `project-data-at-hq-size` 13 and
`settings-nova-comes-to-own` 10 (the manifest test computes them). Updating a copy in a second
project space is a thing Nova does, not content an app holds, so no entry can name it and the list
does not hold it. A reading does not meet it: it reads one app in one project space once. Step 6
states it in the review and the publish dialog (part 13, `13-the-experience.md`, V21c and D7).

The eighteen entries that neither the outline nor step 7's outline at `main` (`7-rest-of-model.md`)
named now have owners:

| Entries | Owner | Why |
|---|---|---|
| the eight record-slot "outside" rows (`case-search/search-button-display-condition-outside-predicate`, `blacklisted-owner-ids-expression-outside-valueexpression`, `itemset-nodeset-filter-predicate-outside-predicate`, `default-value-outside-valueexpression`; `forms-and-case-writes/form-filter-outside-predicate-parent-host-user-usercase-reads`; `menus-and-case-lists/module-filter-value-outside-predicate-any-xpath-hq-s-validator`, `detail-filter-value-outside-predicate`, `usexpathexpression-field-xpath-outside-valueexpression`) | `case-search` for the four search rows, `menus` for the two display conditions, `case-list-and-detail` for the filter and the calculated column | each slot's own page in HQ |
| `questions/itemset-filter-outside-predicate`, `questions/savetocase-expressions-outside-nova-s-typed-vocabularies-case-id` | `xform` | form logic |
| `forms-and-case-writes/user-prop-in-module-filter-form-filter-case-list-slots-the` | `menus` | a display condition's term |
| the five Save to Case shapes (`questions/savetocase-case-type-given-as-an-xpath`, `savetocase-create-with-an-authored-non-uuid-case-id-xpath-inside`, `a-close-only-savetocase-block-with-a-close-condition`, `a-savetocase-block-that-creates-or-updates-and-also-closes-under`, `savetocase-owner-id-condition`) | `xform` | the form builder writes them |
| `questions/connect-work-area-update` | `xform` | a form builder block |
| `questions/data-node-xmlns-on-a-hidden-value` | `xform` | form source |

One entry's owner is not its subject's usual group.
`questions/intent-id-on-any-input-other-than-an-intent-typed-one-where-id` is a `question-appearance`
entry owned by `xform`, because a reference to a callout from another input cannot be built without the
callout question kind, which is `xform`'s.

An entry step 6 flips carries the group it would fall to and no marker of the flip, so no value of
`owner` is transitional. Section 3.8 lists those entries.

### 2.4 Value classes

Rule: **a HELD-NEW entry that shares a surface key with a HELD, TARGET-OWNED or INERT entry
carries a `valueClass`.** 146 HELD-NEW entries share one; 143 hold a class today. Three gain one:

| Entry | Shares its key with | `valueClass` added |
|---|---|---|
| `expressions-and-data/groups-jr-fixture-user-groups` | on `instance-source:fixture`, the HELD lookup and locations rows (`item-list-tag-read-through-nova-s-typed-lookup-carriers`, `item-list-tag-read-in-any-other-expression`, `locations-flat-jr-fixture-locations-read-in-an-expression`) and the INERT `declared-unreferenced-fixture-instance-item-list-locations-user`; on the two instance declaration keys, those and the other HELD instance rows (`casedb`, the session, search results, selected cases) | `user-groups-fixture` |
| `forms-and-case-writes/function-datum-endpoints` | `forms-and-case-writes/shadow-own-fields-name-media-custom-icons-form-filter-post-form` (HELD) | `computed-endpoint-argument` |
| `forms-and-case-writes/arbitrary-datums-datum-id-datum-function` | the same HELD entry | `computed-datum` |

A value class stays a slug whose meaning is the entry's `item` and `dispositionCell`. What makes it
mechanical is not the manifest but the two things that read it: the reader's claim (each claim names the
entry id whose class it decided; part 06, `06-the-reader-forms.md`, section 4.2) and the lane's
variants, each a row that names the entry it exhibits (part 14, `14-proof.md`, section 7). The
manifest's own duty, which CI holds, is that the classes of one key do not overlap and that none is
missing where a key is split.

### 2.5 A kept entry keeps its platform reading

`inventoryEntrySchema`'s third arm takes `TARGET-OWNED` and `INERT` with `notApplicablePlatformsSchema`.
It splits: `INERT` keeps `notApplicablePlatformsSchema`, and `TARGET-OWNED` takes
`heldPlatformsSchema`, as HELD and HELD-NEW do. The 26 TARGET-OWNED entries of today keep
`kind: "not-applicable"`, which `heldPlatformsSchema` admits. The fifteen settings keep the Web Apps and
Android cells their rows state when they flip (3.6), so no inventory row loses a reading. The split
comes before those flips: their entries parse only under the new arm.

`surface/__tests__/platformFeatures.test.ts::readingsOf` and
`lib/preview/__tests__/platformCells.test.ts::requiredCells` read HELD entries alone and stay as they
are. So the flipped entries leave `platformFeatureEntries.ts::AMBIENT_PLATFORM_ENTRIES` (rule 2 of
that test refuses a named entry that is not HELD) and `platformCells.ts::PLATFORM_CELLS` (the cell test
refuses a row that outlives its cell) with the flip: the thirteen ids of section 3.6's last column.
What Preview does for each is `KEPT_AT_HQ`'s Preview cell from then on.

### 2.6 What CI fails on

**The schema holds the two required fields.** `subject` and `owner` are required by
`inventoryEntrySchema`'s arms (2.2, 2.3), so an entry without one never reaches a rule: `loadManifest`
parses each file and throws. The fix is named where the failure is, in the schema's own messages, set
through each field's `error`:

| Field | Arm | Message |
|---|---|---|
| `subject` | HELD-NEW, REFUSED | `A HELD-NEW or REFUSED entry names its subject: the noun a person would call this by, from SUBJECTS in lib/publish/hqFindings.ts. Where none fits, add one there with its copy.` |
| `owner` | HELD-NEW | `A HELD-NEW entry names its owner: the step 7 group that will hold it, from STEP_7_GROUPS in lib/publish/hqFindings.ts.` |

The existing test "parses no entries file that breaks the schema" gains a planted entry for each and
holds the message. Zod's issue path names the file's entry, as it does for every schema failure today.

`surface/__tests__/manifest.test.ts` gains four rules, each one function over the parsed manifest with
a planted failing case beside it, as its existing rules have.

| Rule | Fails when | Message |
|---|---|---|
| subject used | a member of `SUBJECTS` is the subject of no entry | `The subject <subject> is the subject of no entry. Remove it from SUBJECTS and its sentences from the finding copy, or give it to the entry it was added for.` |
| class on a shared key | a HELD-NEW entry shares a surface key with an allowing entry and has no `valueClass` | `<id> is HELD-NEW and shares <key> with <other id>, which holds the rest of that key's values. Give <id> the value class that says which values it takes.` |
| mixed reasons are listed | a REFUSED entry holds a kind of both groups and is not in the test's list `MIXED_REASON_ENTRIES`, which holds the two ids of 2.1 | `<id> holds a reason a fix in CommCare HQ lifts and one it does not, so it reads as "never": a person is told the app can't come in while it uses this, and is not sent to change it. Where that is true of it, add its id to MIXED_REASON_ENTRIES in this test. Where a change in CommCare HQ would lift it, drop the reason that does not apply.` |
| the version floor stands alone | a REFUSED entry holds `below-commcare-version-floor` beside another kind of `FIX_IN_HQ_REASON_KINDS` | `<id> is refused for the CommCare version floor and for something else. Give the other reason its own entry: a person reads one sentence, and the floor's names the version.` |

No rule holds that `standingOf` answers for every entry: it cannot fail. The schema asks at least one
reason of a closed kind on every REFUSED entry, the two reason lists are a partition at compile time
(2.1), and the floor rule above keeps `below-floor` alone.

**The copy follows the manifest.** The copy test of section 10 holds the finding copy to the manifest
both ways: an entry whose subject and standing, or subject and cause, has no sentence fails it, and
so does a sentence, a stem or a subject that no entry gives. No test can hold that a sentence is true
of every entry of its pair. So whoever adds an entry to a pair, or moves one, reads the pair's
sentence against it and re-words the sentence where it is not true of it.

**The tables of this part are the step's end state, and the rules hold at every commit CI runs.** So
where the schema's rule lands before an entry of 3.8 has flipped, that entry carries the subject and
owner Appendix A.1 names for it, and its pair keeps a sentence, until the flip removes all three
(3.8 gives the two sentences that exist only for that time).

The coverage line the test prints gains the standings, in the form "N of M entries held; N kept, N
inert, N not yet, N never, N to change in CommCare HQ". The test computes each number.

The proof lane reads entries by key and ignores a field it does not name
(`proof/checks/manifest_usage.py`, its `Entry`), so `subject` and `owner` change no lane verdict. One
entry this part moves has a reader in `manifest_value_classes.py::VALUE_CLASSES`: the logo entry of
3.5, whose reader gains the `m_id` test. The tile readers already test `case_tile_template` before
they call a use refused, so 3.1 and 3.2 change none.

---

## 3. Rows re-cut by value

Each row below names the entry, its cell today, the new wording, the inventory row that moves with it
(a file under `docs/research/2026-09-26-hq-round-trip/inventory/`, changed together with the entry) and
the evidence at source.

One rule decides when an entry's wording may change: **an entry flips together with the code that
makes its new wording true.** A re-cut that no code change makes true (an inert class, a split that
only narrows, a re-wording, a stale cell: 3.1 to 3.4 and 3.7) needs nothing else. The kept flips (3.6)
are true once the `.ccz` and Preview read the kept values (section 6). A re-cut that calls a value
HELD because a reader recognizes it (3.5) is true once that reader claims it, and an entry a new
concept holds flips with that concept (3.5, its last paragraph). The manifest test stays green at
every commit CI runs.

### 3.1 `case_tile_field`

| | |
|---|---|
| Entry | `menus-and-case-lists/case-tile-field-template-slot-on-icon-text-grid` |
| Today | HELD-NEW, no value class, on `schema:DetailColumn.case_tile_field`: "`column.tileSlot`". Read mechanically, `""` on any column refuses the app. |
| New | The entry gains `valueClass: "slot-on-a-template-tile"`, `subject: "case-tiles"`, `owner: "case-list-and-detail"`; its `item` becomes "`case_tile_field` holding text, on a detail whose `case_tile_template` is a template with slots: `icon_text_grid`, or `person_simple` or a removed template, where the detail's own REFUSED entry also applies". A new entry beside it: `menus-and-case-lists/case-tile-field-blank-or-off-a-template-tile`, INERT, `valueClass: "blank-or-off-a-template-tile"`, same surface key, `item`: "`case_tile_field` `\"\"` or `null`, or any value on a detail with no `case_tile_template` or with `custom`", `dispositionCell`: "**INERT**: HQ's Case List page writes `\"\"` on every column at every save (`details/bootstrap5/column.js`, `serialize`), and HQ reads the key only to fill a template's slots, which a detail with no template, or with the `custom` one, has none of (`suite_xml/features/case_tiles.py::case_tile_template_config`, `CaseTileHelper._get_matched_detail_column`; `helpers/validators.py`, the tile checks)", platforms `not-applicable` (`n/a`), emission `omit` with the marker `omit`, no gates. The two classes split every value of the key: blank anywhere, and text on a detail with no slots, are inert; text on a detail with slots is the HELD-NEW entry's. |
| Inventory | `menus-and-case-lists.md`, the row "`case_tile_field` (template slot) on `icon_text_grid`": re-worded, and the new row added under it. |
| Evidence | `models/case_list.py::DetailColumn.case_tile_field` is a `StringProperty(exclude_if_none=True)`, default `None`. `column.js` sets `self.original.case_tile_field = … \|\| ""` and `serialize` writes `column.case_tile_field = self.case_tile_field()` for every column. Readers: `CaseTileHelper.__init__` builds `cols_by_tile_field`, read only by `_get_matched_detail_column`, which `build_case_tile_detail` calls for each of `case_tile_template_config(template).fields` in its branch for a template other than `custom`; `suite_xml/sections/details.py` reaches the helper only under `if detail.case_tile_template:`; `case_tile_template_config("custom")` returns no fields, and both members of `CaseTileTemplates` (`person_simple`, `icon_text_grid`) load a file that names them; the validator's slot check runs inside `if detail.case_tile_template:` over the same `fields`. No reader in Core, Android or Formplayer: the key never reaches a suite. A column's slot on `person_simple` is `not-yet` like one on `icon_text_grid`, since it is the same Nova slot (`column.tileSlot`) that would hold it; the `person_simple` template itself keeps its own REFUSED entry (`detail-case-tile-template-person-simple`), so such an app is told both. No key is added to a REFUSED entry, so the lane's readers of those classes (`manifest_value_classes.py::VALUE_CLASSES`) meet no new key. Lifecycle: alive. |

### 3.2 Tile cell keys on a list that is no tile

| | |
|---|---|
| Entries | `menus-and-case-lists/grid-x-grid-y-width-height-custom-tile` (HELD, `placed-custom-tile-column`), `horizontal-align-vertical-align` (HELD, `explicit-value`), `font-size` (HELD, `explicit-value`), `show-border-show-shading` (HELD, `custom-tile-column`), and the three REFUSED null rows (`custom-tile-column-with-grid-null-unplaced`, `horizontal-align-null-on-a-placed-custom-tile-column`, `custom-tile-font-size-null`) |
| Today | Each HELD class is worded for a custom tile. No entry says what the nine keys mean on a detail with no tile, where HQ's page writes `grid_x: 0`, `grid_y: 0`, a width and a height, `horizontal_align: "left"`, a `vertical_align`, `font_size: "medium"`, `show_border` and `show_shading` on every column. |
| New | A new entry `menus-and-case-lists/tile-cell-keys-on-a-list-that-is-not-a-tile`, INERT, `valueClass: "off-a-custom-tile"`, surface keys `schema:DetailColumn.grid_x`, `.grid_y`, `.width`, `.height`, `.horizontal_align`, `.vertical_align`, `.font_size`, `.show_border`, `.show_shading`, `item`: "`grid_x`, `grid_y`, `width`, `height`, `horizontal_align`, `vertical_align`, `font_size`, `show_border`, `show_shading` at any value, on a detail with no `case_tile_template` or with a template other than `custom`, whose layout is the template's own", `dispositionCell`: "**INERT**: HQ's Case List page writes all nine on every column at every save, and HQ reads them only while it builds a custom tile (`CaseTileHelper.build_case_tile_detail`, under `case_tile_template == CUSTOM`). Read as cells they would stack every column at the top left; Nova reads none and writes none while a list has no tile", platforms `not-applicable`, emission `omit`. The four HELD entries' `item` cells gain "on a detail whose `case_tile_template` is `custom`", which their value classes already say. |
| Inventory | `menus-and-case-lists.md`, "Detail columns": the new row, and the four re-worded. |
| Evidence | `column.js`, `serialize`: `column.grid_x = self.tileColumnStart() - 1` and the eight beside it, unconditionally. `CaseTileHelper.build_case_tile_detail` builds a `Style` from them only in its `CUSTOM` branch. `lib/commcare/hqJson/caseList.ts::applyTileLayoutToShortDetail` writes them only while the list has a tile layout (`lib/domain/modules.ts::tileCellFor`), so Nova's exports hold none off a tile and the lane sees no new use. Lifecycle: alive. |

A Nova document may hold cells that `lib/domain/modules.ts::tileCellFor` gives no square for: the
list's layout is no tile, or the column is not shown in Results (`tileCellFor` keeps the drawing).
Those cells reach no wire, so a reading of Nova's own export gives a document without them. That is
the canonicalization `dormant-tile-cells`: a row of `READER_CANONICAL_CHOICES` part 07 adds
(`07-the-reader-cases-menus-lists.md`, section 11.5), proven by part 09's `canon.test.ts`
(`09-acceptance-and-the-first-publish.md`, section 9).

### 3.3 Stale cells

Each is a re-wording with no disposition change. The inventory row takes the same words. Three of
these entries also flip in this step (the language display name, 7.2; the date and time join and the
query rows, 3.5): the words below hold until the flip gives each its new cell.

| Entry | Stale words | New words |
|---|---|---|
| `application-and-settings/multimedia-map` | emission: "(Nova also writes a map with content-hash ids on create today, `bundle.ts::buildMultimediaMap`)" | emission: "media bytes through HQ's multimedia upload; Nova sends no `multimedia_map` in any mode" |
| `application-and-settings/translations-lang-code-any-other-value-or-absent-where-hq-s` | cell: "Nova derives every name today" | cell: "Nova writes its own label for every language on a publish (`targetOverlay.ts::projectTranslationsForTarget`)" |
| `menus-and-case-lists/modulebase-unique-id` | emission: "(today random per expansion)" | emission: "the target's recorded id; derived from the menu's UUID elsewhere (`wireIdentity.ts`)" |
| `forms-and-case-writes/update-through-the-date-and-time-join-of-a-date-and-a-time` | cell: "arriving with step 4" | cell: "a datetime writer Nova emits from step 4 (`nova_datetime_<question>`); no reader recognizes it yet" |
| `case-search/several-xpath-query-rows` | cell: "(today Nova emits one row per top-level conjunct…)" | cell: "Nova emits one row per top-level conjunct of its composed condition (`xpathQuery.ts::composeXPathQueryEmission`), and HQ joins every row with `and` (`case_search/utils.py::_apply_filter`); no reader reads rows back yet" |
| `forms-and-case-writes/xmlns-form-json-and-xform-data-node` | cell: "…; widen: `Form.xmlns`, a stored submission identity an import keeps for a new project space and the local `.ccz`", and that `widen` in `slotChanges` | `slotChanges: []`, and the cell part 10 fixes (`10-identity-and-the-ledger.md`, "Contracts", the surface manifest row): "**HELD**: derived from the form's UUID (`wireIdentity.ts::derivedFormXmlns`), or the `xmlns` the deployment ledger records for that project space (`app_deployment_identities`, `wireIdentity.ts::targetWireIdentity`): an app brought in from CommCare HQ keeps HQ's `xmlns` for every form on the project space it came from, and takes the derived one everywhere else" |
| `project-space-setting/Domain.commtrack_enabled` (`lib/commcare/surface/entries/gates.json`) | `content` ends: "…(HQ's substring test, `entries.py::entry_for_module`); import asks the same from step 6" | `content` ends: "…(HQ's substring test, `entries.py::entry_for_module`)" |

The `xmlns` row is row 20 of part 04's table of widens (`04-names.md`, section 2.4), settled here.
What makes the widen false is this plan's decision that a form has no stored `xmlns` slot: an adopted
app's `xmlns` is a ledger row of its one deployment (part 10, sections 2 to 4; `../6-bring-in.md`,
"What changed from the outline, and why"). Nova's exports already hold an `xmlns` this way.

The CommTrack cell loses its last clause because bringing an app in asks no confirmation: the app
already runs in its source project space, so the plan features it uses are recorded and the rest is
asked at the first publish, as today (part 07, Departure 11; part 10, section 6.5). The inventory
says the same thing in prose and changes with the cell:
`docs/research/2026-09-26-hq-round-trip/inventory/gates.md`, the paragraph that begins "Publish
also checks gates outside the app-building flags above", loses the clause ", with import asking
the same from step 6".

`case-search/title-label-or-blank-hq-s-default`'s cell ("step 7's migration writes \"Search\"") and
`menus-and-case-lists/blanks-first-last`'s row are re-written by part 03
(`03-questions-and-text.md`), which holds their concepts.

### 3.4 The ten "outside" rows

The pairs are cut by two type names that no longer exist. The stored union is one `Expression`
(`lib/domain/expression/types.ts`), judged per slot by `checkExpression` under the slot's profile, whose
rule set is `record` or `form` (`lib/domain/expression/profiles.ts::SlotProfile`). All ten slots take
the `record` rule set (`lib/domain/expression/context.ts::slotContext`: a choice list's filter and
every case operation slot are `record` slots that also read the form's answers, as part 08 found,
`08-the-reader-expressions.md`). Each pair reads:

- the HELD class: "an expression Nova's checker admits in this slot (`checkExpression` under the slot's
  profile, the `record` rule set)";
- the HELD-NEW class: "any other expression HQ's validator accepts here, which the checker refuses in
  this slot, by its reason".

Value class slugs do not change, so no other file moves. The pairs, HELD then HELD-NEW:

| Slot | HELD entry | HELD-NEW entry | Rule set |
|---|---|---|---|
| Search button display condition | `case-search/search-button-display-condition-lifting-into-predicate` | `case-search/search-button-display-condition-outside-predicate` | record |
| Owners left out of a search | `case-search/blacklisted-owner-ids-expression-lifting-into-valueexpression` | `case-search/blacklisted-owner-ids-expression-outside-valueexpression` | record |
| A search field's lookup filter | `case-search/itemset-nodeset-filter-predicate-lifting-into-predicate` | `case-search/itemset-nodeset-filter-predicate-outside-predicate` | record |
| A search field's starting value | `case-search/default-value-lifting-into-valueexpression` | `case-search/default-value-outside-valueexpression` | record |
| A form's display condition | `forms-and-case-writes/form-filter-lifting-into-predicate-a-direct-own-case-property-in` | `forms-and-case-writes/form-filter-outside-predicate-parent-host-user-usercase-reads` | record |
| A menu's display condition | `menus-and-case-lists/module-filter-value-lifts-into-predicate` | `menus-and-case-lists/module-filter-value-outside-predicate-any-xpath-hq-s-validator` | record |
| The case list filter | `menus-and-case-lists/detail-filter-value-lifts-into-predicate` | `menus-and-case-lists/detail-filter-value-outside-predicate` | record |
| A calculated column | `menus-and-case-lists/usexpathexpression-field-xpath-lifting-into-valueexpression` | `menus-and-case-lists/usexpathexpression-field-xpath-outside-valueexpression` | record |
| A choice list's filter | `questions/itemset-filter-lifting-into-predicate` | `questions/itemset-filter-outside-predicate` | record |
| A Save to Case question's expressions | the five HELD Save to Case rows (`questions/savetocase-create-case-type-literal-case-name-owner-id-uuid-case`, `savetocase-update-case-id-xpath`, `savetocase-property-rows-calculation-condition-lifting-into`, `savetocase-open-case-condition`, `savetocase-property-names-with-hyphens-a-z-w-case-insensitive`) | `questions/savetocase-expressions-outside-nova-s-typed-vocabularies-case-id` | record |

Evidence that the wording is true of Nova's exports today: every expression Nova stores passed
`checkExpression` at commit, so every use an export holds is in the HELD class. The line itself
becomes a reader's fact with part 08's binder (`08-the-reader-expressions.md`, section 9.2): part 07
registers the text of the four search pairs (its section 14), and for every pair the reader parses
HQ's text, binds it, runs the same checker, and claims the HELD entry where it passes and the
HELD-NEW entry, with the checker's reason in the finding's `detail`, where it does not. No row flips
there; a row would flip only if a later step widens a rule set.

### 3.5 Re-cuts a reader makes true

This part words each; the reader named in the last column makes it true and flips it.

| Entry | Today | New wording | True with |
|---|---|---|---|
| `case-search/several-xpath-query-rows` | HELD-NEW: "each row a typed default filter kept as its own row" | HELD, `valueClass` kept: "several `_xpath_query` rows, read as one condition: their conjunction. HQ joins every row with `and`, so one row or several find the same cases, and Nova writes one row per top-level conjunct of what it holds". No `subject`, no `owner`. A row whose own text is an `and` reads as two conjuncts and is written back as two rows, which finds the same cases; the first-publish register holds the changed row count under the id `search-filter-rows-recut` (part 09, `09-acceptance-and-the-first-publish.md`, section 11.2). Part 07 adds the narrowing to this wording (`07-the-reader-cases-menus-lists.md`, section 14: which conjuncts the HELD class takes). | part 07's search reader |
| `forms-and-case-writes/update-through-the-date-and-time-join-of-a-date-and-a-time` | HELD-NEW | HELD: "a date question and a time question joined into one date and time for a case property, the shape step 4's split writes (`lib/doc/datetimeSplit.ts`); the reader recognizes the join by re-emitting it" | part 07's case reader |
| the media rows of "a reference identical in every language" (`menus-and-case-lists/media-image-media-audio-differing-by-language`, `forms-and-case-writes/media-image-media-audio-differing-by-language`, `questions/label-or-option-media-differing-by-language`) | HELD-NEW, each beside a HELD row for the shared slot | The HELD-NEW rows keep their disposition and gain to their `item`: "a path present in one language and absent in another counts as differing". Their HELD siblings gain: "the same path in every language the app has reads as the one shared slot". | part 06's reader (questions and forms), part 07's (menus) |
| `expressions-and-data/media-path-jr-file` | HELD-NEW: a held media path | HELD: "the path CommCare HQ holds the file at, kept for the project space the app came from (`app_deployment_media_paths`); every other project space takes Nova's own path" | part 11's media reading |
| `expressions-and-data/a-media-reference-on-a-slot-nova-holds-with-no-multimedia-map` | HELD-NEW, `valueClass: "referenced-path-without-entry"` | Split, as part 11 writes it (`11-project-data.md`, section 13.1). The entry becomes INERT with `valueClass: "path-without-entry-nothing-draws"`: a reference with no `multimedia_map` entry on a slot no runtime the app runs on draws without its file, which the reader leaves out and the review lists. A new entry beside it, `expressions-and-data/a-media-reference-with-no-file-on-a-slot-a-runtime-draws`, REFUSED (`broken-at-runtime`), `valueClass: "path-without-entry-a-runtime-draws"`, `subject: "missing-media-files"`, takes the slots a runtime draws; its standing is `fix-in-hq`. | part 11's media reading |
| `application-and-settings/logo-refs-slot-path-other-than-the-uploader-s-jr-file-commcare` | REFUSED: a `path` other than the uploader's | Its `item` becomes "`logo_refs[slot]` the uploader did not write: a `path` other than `jr://file/commcare/logo/data/<slot><ext>`, or an entry with no `m_id`", and its first reason's `named` gains "and always stores `m_id` (`hqmedia/models.py::CommCareMultimedia.get_media_info`)". The `valueClass` stays `path-not-from-uploader`. `proof/checks/manifest_value_classes.py::path_not_from_uploader` gains the `m_id` test (an entry that is no object, or whose `m_id` is no non-empty string), with its case in `proof/checks/test_manifest_value_classes.py`. The inventory row in `application-and-settings.md` takes the same words. | part 06's application walker, which refuses it (4.3 gives the evidence) |
| `application-and-settings/translations-lang-code-any-other-value-or-absent-where-hq-s` | HELD-NEW | TARGET-OWNED, section 7.2 | the overlay's `languageNames` option (7.2) |

**The concept flips**, each with the concept that holds it and with the entry edits its part writes:
`menus-and-case-lists/put-in-root-display-only-forms`,
`case-list-form-pointing-at-a-registration-form-in-another-module` and
`case-list-form-media-image-media-audio` (part 02, `02-menus.md`);
`questions/phone-number-xsd-string-appearance-numeric`, `questions/output-value-any-other-expression`,
`case-search/title-label-or-blank-hq-s-default`, `menus-and-case-lists/blanks-first-last` and
`questions/vellum-ignore-containing-markdown-on-h-html-vellum-s-disable` (part 03,
`03-questions-and-text.md`). Every `widen` on a HELD row other than the sixteen of 3.6 and the `xmlns`
row of 3.3 is part 04's (`04-names.md`), decided row by row.

### 3.6 The kept flips

Each entry below becomes TARGET-OWNED, loses `slotChanges`, `subject` and `owner` where it holds them,
keeps its surface keys, value class and platform cells, and takes the `dispositionCell` and emission
shown. `KEPT_AT_HQ` (section 5) gains its row with the flip.

| Entry | Today | New `dispositionCell` | Leaves `AMBIENT_PLATFORM_ENTRIES` and `PLATFORM_CELLS` |
|---|---|---|---|
| `application-and-settings/1-properties-cc-autoup-freq`, `4-properties-cc-days-form-retain`, `5-properties-logenabled`, `13-properties-cc-autosync-freq`, `17-properties-cc-content-valid`, `18-properties-unsent-number-limit`, `19-properties-unsent-time-limit`, `22-properties-cc-resize-images`, `23-properties-cc-fuzzy-search-enabled`, `25-properties-cc-login-duration-seconds`, `26-properties-cc-inflation-target-density`, `27-properties-cc-gps-auto-capture-accuracy`, `28-properties-cc-maps-default-layer`, `29-properties-cc-enable-tts`, `30-properties-cc-label-required-questions-with-asterisk` | HELD, "Nova's seed `<value>` … widen: `appSettings.<slot>`, any of the setting's choices" | "**TARGET-OWNED**: kept at the project space's value, any of the setting's choices. A publish writes Nova's value `<value>` only where the project space holds none (`targetOverlay.ts::projectProfileForTarget`); a `.ccz` made for the project space writes its value (`keptProfile.ts::targetProfileProperties`)". Emission: "the project space's value where it holds one; Nova's `<value>` where it holds none, on both paths". | yes, the thirteen that hold a row (all but 13 and 23, which read `runs` on both platforms) |
| `application-and-settings/24-properties-cc-log-entity-detail-enabled` | HELD-NEW, "`appSettings.logCaseDetailViews`" | "**TARGET-OWNED**: kept at the project space's value. Nova writes none; a publish carries it (`projectProfileForTarget` keeps every key it does not name) and a `.ccz` made for the project space writes it where it is set". Emission: "the project space's value where it is set; nothing otherwise". | no row |
| `application-and-settings/translations-key-in-a-runtime-s-ui-string-catalog-core-android` | HELD-NEW, "`uiStringOverrides[lang][key]`" | "**TARGET-OWNED**: kept as the project space holds it. A publish carries every key Nova does not own (`appStringKeys.ts::translationKeyOwner` gives `target`) and a `.ccz` made for the project space writes each into that language's app strings". Emission: "the project space's `translations[lang][key]`". | no row |
| `application-and-settings/translations-catalog-key-hq-fills-with-its-own-text-in-a` | HELD-NEW, "`uiStringCatalogKeys`" | "**TARGET-OWNED**: follows from the keys above: HQ's build writes its own catalog text for a key some language holds, in every language that holds none (`app_strings.py::SelectKnownAppStrings.app_strings_parts`). A publish changes none of it; a `.ccz` cannot write HQ's catalog and says so". Emission: "n/a". | no row |
| `application-and-settings/logo-refs-hq-logo-android-home-login-demo` | HELD-NEW, "`androidLogos.{home, login, demo}`" | "**TARGET-OWNED**: kept as the project space holds them. A publish writes no `logo_refs` but to remove a path-only entry (`targetLogoRefs.ts`); a `.ccz` carries no Android logo and says so". Emission: "omit", marker `omit`. | no row |
| `application-and-settings/49p-hq-mobile-ucr-restore-version-1-0-1-5` | REFUSED, retiring (`MOBILE_UCR`) | "**TARGET-OWNED**: kept at the project space's value. Its readers are report menus and mobile report choice lists (`suite_xml/features/mobile_ucr.py`, `helpers/validators.py`), which their own entries refuse, and the restore's choice of report fixture version (`fixtures/mobile_ucr.py::_parse_apps`), which Nova never changes because it never writes the key. HQ's settings page offers `2.0` alone and marks any other value an error (`commcare-app-settings.yml`, `commcare_settings.js`)". Platforms `not-applicable`; emission `omit`; `reasons` and `subject` removed. | no row |
| `application-and-settings/45-hq-auto-gps-capture` | HELD, derived, widen `Form.autoCaptureLocation` | Split. The entry keeps HELD with `valueClass: "connect-app"`, `slotChanges: []`, cell "**HELD**: derived: `true` on a Connect app (`expander.ts::expandDoc` from `connectType`)". A new entry `application-and-settings/45p-hq-auto-gps-capture-on-an-app-that-is-not-a-connect-app`, TARGET-OWNED, `valueClass: "not-a-connect-app"`, same keys and platform cells: "**TARGET-OWNED**: kept at the project space's value. A publish leaves the key out; a `.ccz` made for the project space captures location where it is on (`xform/metaBlock.ts::addMetaBlock`)". The widen leaves the manifest as a `slotChanges` item: the HELD-NEW arm holds none, and `forms-and-case-writes/auto-gps-capture-form`, the per-form setting, already states the slot in its cell ("`Form.autoCaptureLocation` (effective = form OR app, `FormBase.get_auto_gps_capture`)"). That entry stays HELD-NEW with its cell unchanged, `subject: "form-settings"` and `owner: "settings-nova-comes-to-own"` (Appendix A.1), which is the standing part 04 asks this part to give a form's own `auto_gps_capture`. | no: the HELD entry keeps its cells, its ambient row and its `@web-apps` cell; the new entry is not HELD and takes none |
| `application-and-settings/51-hq-persistent-menu`, `52-hq-show-breadcrumbs` | HELD-NEW, "`appSettings.persistentMenu`", "`appSettings.breadcrumbs`" | "**TARGET-OWNED**: kept at the project space's value. Only Formplayer and the Web Apps client read it, from HQ's own build (`FormplayerPropertyManager`, `templates/app_manager/profile.xml`); a publish leaves the key out". Emission `omit`. | no row |

Evidence for the fifteen, read at the pins: `Application.create_profile` writes each yaml property
setting at the app's stored value with the setting's own `force`, and nothing where the app holds
none: it writes a default for an absent key only where the setting carries a `commcare_default` that
differs from its `default`, and none of the fifteen carries one (`commcare-profile-settings.yml`,
where only `cc-show-saved`, `cc-show-incomplete` and `log_prop_weekly` do);
`views/settings.py::edit_commcare_profile` stores each setting the Settings page posts. The yaml's
own defaults for `cc-fuzzy-search-enabled` and `cc-content-valid` are `yes`, where Nova's value is
`no`, and HQ's starter apps hold them so. `static/app_manager/template_apps/` holds four
directories, the three starter apps (agriculture, health, wash) and `wash_before_cond_case_update`,
which is `wash`'s content from before case updates stored `update_mode` and which part 14 counts as
no base (`14-proof.md`, section 6.2): all four `app.json` files hold
`cc-fuzzy-search-enabled: yes`, three hold
`cc-content-valid: yes`, and the health app `cc-resize-images: full`. None of the fifteen changes
what a form asks or stores: each is read by commcare-android's preferences
(`MainConfigurablePreferences`, `HiddenPreferences`) for sync, update, logging, capture and display
behavior, and `cc-fuzzy-search-enabled` also by Formplayer's entity filter. Lifecycle: all alive.

Clause 2 also names "which cases a list shows", and fuzzy search changes which rows stay while a worker
types in the list's filter box. That is no content of the document: which cases the list holds is the
list's own filter, its search and the worker's restore, none of which the setting reaches, and the box
narrows them on the screen for one worker at one moment. What the setting changes is how a runtime
matches typed text, and Preview claims to run that, so clause 3 answers it: Preview reads the value
(6.4).

Clause 1 holds for the fifteen on a deployment Nova created by Nova's own stated behavior: the seed is
written once, where the project space holds no value, and a later publish finds a value and leaves it.
On a deployment Nova brought in, a seed would be a change, so none is written (7.3).

**One kept entry is re-worded without a flip.**
`application-and-settings/32-features-credentials` stays TARGET-OWNED. Its cell becomes
"**TARGET-OWNED**: written by the project space's credential settings from its `CredentialApplication`
row (`domain/views/settings.py::CredentialsApplicationSettingsView`); HQ's build writes it as the
profile's `<credentials>` (`templates/app_manager/profile.xml`), which Android's work history reads
from each installed app (`PersonalIdWorkHistoryViewModel.kt::getWorkHistoryForAppRecord`). A publish
carries it (`projectProfileForTarget` keeps every section it does not name), and a `.ccz` made for the
project space writes the same block (`compiler.ts::generateProfile`)". Its emission cell becomes
"nothing in the HQ JSON; the local `.ccz` writes `<credentials active=\"true\"><credential level=\"…\"
type=\"APP_ACTIVITY\"/></credentials>` where the project space holds a level", and the marker `omit`
leaves it, since `omit` says Nova writes nothing (`schema.ts::EMISSION_MARKERS`). The entry already
names the profile parser's `credentials` keys, so the archive's use of them is held by it.

**The kept UI text in a `.ccz` is the project space's, not a use.**
`translations-key-in-a-runtime-s-ui-string-catalog-core-android` keeps its one surface key,
`schema:Application.translations`, and names no `ui-string:` key: the ids a project space may reword
are every id a runtime reads, and an entry naming them would hold Nova's own text under any of them. The
lane reads the archive's mirror as it reads the upload's carry. An upload holds each UI translation at
the value the document's `hq-side.json` saved, and that value is the target's carried back
(`proof/checks/manifest_usage.py::without_carried`). A `.ccz` made for the project space writes each saved
text into that language's `app_strings.txt` and HQ's merge of them into `default`, and an id there at a
saved text (in `default`, one saved in any language), as HQ's reader reads back what HQ's build writes of
it, is the target's text written back (`manifest_usage.py::carried_app_strings`). The same id at any other
text is the export's use, which no entry names, so a runtime UI key Nova writes of its own is refused.

### 3.7 `build_profiles`

| | |
|---|---|
| Entry | `application-and-settings/build-profiles-each-profile-s-name-langs-practice-mobile-worker` |
| Today | TARGET-OWNED, no value class |
| New | The entry gains `valueClass: "empty"` and its `item` becomes "`build_profiles` `{}`". A new entry `application-and-settings/build-profiles-non-empty`, HELD-NEW, `valueClass: "non-empty"`, same surface keys and gate (`privilege/build_profiles`), `subject: "build-profiles"`, `owner: "settings-nova-comes-to-own"`, `item`: "`build_profiles` holding a profile (its `name`, `langs`, `practice_mobile_worker_id`)", `dispositionCell`: "**HELD-NEW**: build profiles as part of the app Nova holds. HQ builds each profile with its own `langs` (`app_strings.py::_create_custom_app_strings`, `ApplicationBase.get_build_langs`) and an update never writes the key, so a language Nova adds joins no profile, and a publish stops where a profile names a language the app no longer has (`hq_build_profile_language_missing`)", platforms `not-applicable`, emission `omit`. |
| Inventory | `application-and-settings.md`, the `build_profiles` row split in two. The empty row's disposition cell gains "; a publish reads the profiles and stops where one names a language the app no longer has"; the non-empty row takes the entry's cell above, which already ends with the same stop. |
| Evidence | `ApplicationBase._update_excluded_fields` lists `build_profiles`. HQ's own Languages page removes a deleted language from every profile (`views/apps.py::edit_app_langs`, the loop over `app.build_profiles`); Nova's update writes `langs` alone. `views/releases.py` makes a build per profile under the `build_profiles` privilege. No request an API key can send writes the key: `LanguageProfilesView` and `edit_app_langs` are `require_can_edit_apps`, a browser session. Lifecycle: alive, behind a plan privilege. |

A publish holds every build profile on the target's app to the languages it writes, and stops
where one names a language the app no longer has (section 7.4). That closes the defect this
key had: before it, a language removed in Nova stayed in each of HQ's profiles.

### 3.8 Entries that leave HELD-NEW or REFUSED in step 6

Each entry below is HELD-NEW today and ends the step with neither `subject` nor `owner`: the flip
removes both.

| Entry | Becomes | With |
|---|---|---|
| `application-and-settings/24-properties-cc-log-entity-detail-enabled`, `51-hq-persistent-menu`, `52-hq-show-breadcrumbs`, `translations-key-in-a-runtime-s-ui-string-catalog-core-android`, `translations-catalog-key-hq-fills-with-its-own-text-in-a`, `logo-refs-hq-logo-android-home-login-demo` | TARGET-OWNED | 3.6 |
| `application-and-settings/translations-lang-code-any-other-value-or-absent-where-hq-s` | TARGET-OWNED | 7.2 |
| `menus-and-case-lists/put-in-root-display-only-forms`, `case-list-form-pointing-at-a-registration-form-in-another-module`, `case-list-form-media-image-media-audio` | HELD | part 02's concepts (3.5) |
| `questions/phone-number-xsd-string-appearance-numeric`, `questions/output-value-any-other-expression`, `questions/vellum-ignore-containing-markdown-on-h-html-vellum-s-disable`, `case-search/title-label-or-blank-hq-s-default`, `menus-and-case-lists/blanks-first-last` | HELD | part 03's concepts (3.5) |
| `forms-and-case-writes/update-through-the-date-and-time-join-of-a-date-and-a-time`, `forms-and-case-writes/loadupdateaction-preload-question-property`, `case-search/several-xpath-query-rows` | HELD | part 07's readers (3.5; part 07, section 14) |
| `expressions-and-data/media-path-jr-file` (HELD), `a-media-reference-on-a-slot-nova-holds-with-no-multimedia-map` (INERT) | | part 11's media reading (3.5) |

Where the schema's rule lands before one of these flips (2.6), the entry carries the subject and owner
Appendix A.1 gives it until then, and its pair needs a sentence for that time. Two pairs exist only
that way and are no rows of 9.2: `app-settings` at `not-yet`, "This uses an app setting, which Nova
can't hold yet.", and `app-logos` at `not-yet`, "This uses logos for the Android home, sign-in and
practice screens, which Nova can't hold yet." The language display name entry takes `app-settings` for
that time. Every other pair these entries give is one a row of 9.2 holds.

Three entries leave REFUSED. `application-and-settings/49p-hq-mobile-ucr-restore-version-1-0-1-5` becomes
TARGET-OWNED (3.6).
`forms-and-case-writes/case-preload-into-a-question-outside-any-repeat-where-the-held` becomes HELD-NEW
(part 07, section 14). `questions/an-explicitly-blank-value-in-a-non-default-language-where-the` becomes
HELD: a blank in a language other than the first, where the first holds text, is read as no translation
(part 09, Departure 17), and the blank in the first language gets its own REFUSED entry
(`questions/an-explicitly-blank-value-in-the-first-language-where-another-holds-text`, part 06's;
Appendix A.2).

Three entries join HELD-NEW as re-cuts of entries the manifest holds today under another disposition,
and gain both fields with the re-cut: `questions/question-id-case-registration-script` (HELD today;
part 06), `forms-and-case-writes/case-preload-into-a-question-outside-any-repeat-where-the-held`
(REFUSED today; part 07) and `menus-and-case-lists/6-late-flag-late-flag-1` (HELD today; part 07).
The last block of Appendix A.1 gives each its subject and owner, with every entry the step adds as
HELD-NEW.

---

## 4. The kept test, key by key

The kept test is this plan's rule for content outside `modules` that Nova's publish never writes
(`../6-bring-in.md`, "Executed during planning", says why it exists; this section holds it). A
top-level item is kept only when (1) Nova's publish never changes it on that deployment, (2) nothing
the document holds does something different under its value, and (3) every Nova surface that claims
to show or run what it changes reads the target's value or states the difference. Clause 2 names what a question asks or stores, who owns a case Nova's forms create and
which cases a list shows; behavior HQ's build adds beside Nova's content passes it only where Nova's
`.ccz` mirrors that behavior. Everything inside `modules` and every form attachment is held, inert or
refused, never kept. Clause 1 is decided here by two readings: the key is in
`_update_excluded_fields` or is never in a body `applicationShell` builds, or
`projectApplicationForTarget` carries the target's part. Clause 3 is section 5's table.

### 4.1 Every declared property of `Application` and `ApplicationBase`

`surface.json` holds 146 `schema:Application.*` items: 70 declared properties (the two classes and
their mixins), 75 undeclared ones, which are Python properties and methods, and the sentinel
`schema:Application.<undeclared>`. A stored key naming one of the 75 is refused by
`application-and-settings/an-unknown-top-level-key-naming-an-application-read-only`. Each declared
property, with what Nova's publish does to it and its standing:

| Property | HQ's update | Nova's body | Standing | Entry |
|---|---|---|---|---|
| `_id` | excluded | absent | kept (identity) | `id` |
| `_rev`, `domain`, `copy_of`, `version` | excluded | absent | kept (server record) | `rev-domain-copy-of-version` |
| `short_odk_url`, `short_odk_media_url` | excluded | absent | kept (server record) | `short-odk-url-short-odk-media-url` |
| `built_with`, `build_signed`, `built_on`, `build_comment`, `comment_from`, `last_released`, `build_broken`, `build_broken_reason`, `is_auto_generated`, `is_released` | written if sent | absent | kept (server record) | `built-with-build-signed-built-on-build-comment-comment-from-last` |
| `date_created` | excluded | absent | kept (server record) | `date-created-created-from-template-last-modified-has-submissions` |
| `created_from_template` | set to `import_app_api` by the import view on every import | absent | kept (server record); the first publish over an adopted app changes it, which no page and no runtime reads; the pointer is one the first-publish register allows under `forms-and-settings-rewritten` (part 09, section 11.2) | `date-created-created-from-template-last-modified-has-submissions` |
| `last_modified`, `has_submissions` | written by HQ's own saves | absent | kept (server record) | `date-created-created-from-template-last-modified-has-submissions` |
| `copy_history`, `family_id` | excluded | absent | kept (server record) | `copy-history-family-id` |
| `external_blobs` | popped by `export_json` | absent | kept (server record) | `external-blobs` |
| `_attachments` | merged by `save_attachments` | every form's source | held; an orphan is inert | `attachments-form-unique-id-xml`; the orphan `attachments-entry-for-a-form-no-longer-in-the-app` |
| `doc_type` | excluded; a mismatch refuses | `Application` | held; other values refused | `doc-type-application`; the four refused `doc_type` entries of 8.3 |
| `name` | excluded; the import's `app_name` sets it | sent | held | `name` |
| `langs` | written | sent | held | `langs-order-langs-0-default`, `langs-code-spelling-matching-hq-s-grammar-a-z-2-3-a-z-e-g-en-hin`; a code outside the grammar, repeated or empty is refused by the two `language-codes` entries of Appendix A.2 |
| `modules` | written whole | sent | held | `modules` |
| `translations` | written whole | projected | by key class, 4.4 | the seven `translations-` entries 4.4 names |
| `profile` | written whole | projected | by key, 4.2 | the settings rows |
| `add_ons` | written whole | projected | inert | `add-ons` |
| `application_version` | written | `2.0` | inert at `2.0`, refused at `1.0` | `33-hq-application-version-2-0`, `33p-hq-application-version-1-0` |
| `location_fixture_restore` | written | `project_default` | held; `only_hierarchical_fixture` refused | `50-hq-location-fixture-restore-project-default`, `50p-hq-location-fixture-restore-both-fixtures-only-flat-fixture`, `50pp-hq-location-fixture-restore-only-hierarchical-fixture` |
| `cloudcare_enabled` | written | the declaration | held | `40-hq-cloudcare-enabled` |
| `auto_gps_capture` | written if sent | `true` for a Connect app only | held on a Connect app; kept otherwise | `45-hq-auto-gps-capture`, `45p-hq-auto-gps-capture-on-an-app-that-is-not-a-connect-app` (new, 3.6) |
| `logo_refs` | written if sent | sent only to remove a path-only entry | Web Apps slot held; Android slots kept; another path, or an entry with no `m_id`, refused | `logo-refs-hq-logo-web-apps`, `logo-refs-hq-logo-android-home-login-demo`, `logo-refs-slot-path-other-than-the-uploader-s-jr-file-commcare` |
| `multimedia_map` | excluded; the import prunes unused paths | absent | kept (identity) | `multimedia-map` |
| `archived_media` | written if sent | absent | kept (server record) | `archived-media` |
| `build_spec` | excluded | absent | kept at or above 2.57; refused below | `34-hq-build-spec-at-or-above-nova-s-floor-2-57`, `34p-hq-build-spec-below-nova-s-floor` |
| `build_profiles` | excluded | absent | kept when empty; not-yet otherwise | 3.7 |
| `practice_mobile_worker_id` | excluded | absent | kept | `35-hq-practice-mobile-worker-id` |
| `custom_base_url` | excluded | absent | kept | `36-hq-custom-base-url` |
| `secure_submissions` | written if sent | absent | kept | `43-hq-secure-submissions` |
| `case_sharing` | written if sent | absent | not-yet at `true` | `39-hq-case-sharing` |
| `use_grid_menus`, `grid_form_menus` | written if sent | absent | not-yet at `true` and at `all` or `some` | `46-hq-use-grid-menus`, `47-hq-grid-form-menus-none-all-some` |
| `persistent_menu`, `show_breadcrumbs` | written if sent | absent | kept | `51-hq-persistent-menu`, `52-hq-show-breadcrumbs` |
| `mobile_ucr_restore_version` | written if sent | absent | inert at `2.0`; kept at `1.0` and `1.5` | `49-hq-mobile-ucr-restore-version-2-0`, `49p-hq-mobile-ucr-restore-version-1-0-1-5` |
| `use_custom_suite` | written if sent | absent | inert at `false`; refused at `true` | `41-hq-use-custom-suite-false`, `41p-hq-use-custom-suite-true` |
| `translation_strategy` | written if sent | absent | inert at `select-known`; refused otherwise | `44-hq-translation-strategy-select-known`, `44p-hq-translation-strategy-select-known` |
| `target_commcare_flavor` | written if sent | absent | inert at `none`; refused otherwise | `48-hq-target-commcare-flavor-none`, `48p-hq-target-commcare-flavor-commcare-commcare-lts` |
| `custom_assertions` | written if sent | absent | refused when non-empty | `non-empty-custom-assertions-app` |
| `amplifies_workers`, `amplifies_project`, `minimum_use_threshold`, `experienced_threshold` | written if sent | absent | kept (server record) | `amplifies-workers-amplifies-project-minimum-use-threshold` |
| `recipients`, `admin_password`, `admin_password_charset`, `cached_properties`, `description`, `deployment_date`, `phone_model`, `user_type`, `attribution_notes`, `vellum_case_management`, `comment`, `smart_lang_display` | written if sent (`comment` excluded) | absent | inert | `recipients`, `admin-password-admin-password-charset`, `cached-properties-description-deployment-date-phone-model-user`, `vellum-case-management`, `comment-app`, `smart-lang-display` |

No declared property is left without an entry: the script that produced this table found none, and the
manifest test's rule "every key an entry names exists" holds the other direction.

### 4.2 Every profile property and feature

`commcare-profile-settings.yml` holds 32 settings. `create_profile` writes a `properties` or `features`
setting from `app.profile`, and four keys from elsewhere.

| Setting | Standing | Why |
|---|---|---|
| the fifteen of 3.6 | kept | 3.6 |
| `cc-show-saved`, `cc-show-incomplete` | held (`appSettings`) | Nova owns both and writes them on every publish |
| `cc-log-entity-detail-enabled` | kept | 3.6 |
| `lazy-load-video-files` | inert at `false`; never at `true` | retiring flag `LAZY_LOAD_MULTIMEDIA` |
| `purge-freq`, `user_reg_server`, `restore-tolerance`, `loose_media`, `log_prop_weekly`, `log_prop_daily` | inert | no reader in Core, Android or Formplayer; a publish carries them. For an absent `log_prop_weekly` HQ's build writes its own default (the setting's `commcare_default` differs from its `default`) and the archive writes none, which no runtime can tell apart |
| `features.users` | inert | the profile parser stores it and nothing queries it |
| `features.dependencies` | not-yet, owner `settings-nova-comes-to-own` | it stops the app opening on a phone that lacks a named Android app, and HQ writes it only while the project space holds the `app_dependencies` privilege (`create_profile`), which no API key reads; a `.ccz` could neither mirror it nor honestly leave it out |
| `features.credentials` | kept | written by the project space's credential settings from their own table (`domain/views/settings.py::CredentialsApplicationSettingsView.add_credential_to_app_features`), never by an app's Settings page; HQ's build writes it as `<credentials>`, and Android's work history reads that from each installed app's profile (`PersonalIdWorkHistoryViewModel.kt::getWorkHistoryForAppRecord`). Clause 2: it changes no form, case or list. Clause 3: the `.ccz` writes the same block (6.3) |
| `logo_android_home`, `logo_android_login`, `logo_android_demo` | kept | 4.3; written from `logo_refs` under the logo privilege |
| `logo_web_apps` | held | `BlueprintDoc.logo` |
| a value outside a shown setting's choices | fix-in-hq | the Settings page marks it an error |
| `features.sense: 'true'`, `properties.cc-entry-mode: 'cc-entry-review'` | fix-in-hq | no page writes either, and HQ's build then prefixes every menu and form name |
| any other `properties` or `features` key | inert | `create_profile` loops the yaml alone |
| `custom_properties['cc-index-case-search-results']` | held | derived by Nova |
| any other `custom_properties` entry | never | freeform |
| the target-derived properties (`PostURL`, `ota-restore-url`, `key_server`, `cc_user_domain`, `heartbeat-url`, `cur_locale` and the template constants) | kept | written by `templates/app_manager/profile.xml` from the target |
| `cc-persistent-menu`, `cc-breadcrumbs-enabled` | kept | written by the template from the two app properties |

### 4.3 The top-level keys the test decides, each with its evidence

**`secure_submissions`.** Reader: `ApplicationBase.post_url` alone picks the route
`receiver_secure_post_with_app_id` (`receiverwrapper/urls.py`: `secure/<app_id>/`) over
`receiver_post_with_app_id`. Writers: HQ's new-app views copy the project space's setting
(`views/apps.py::new_app`, `default_new_app`), its security page rewrites every app when the setting
changes (`domain/forms.py::PrivacySecurityForm.save`), and its app settings page's save takes the key
(`views/settings.py::edit_commcare_settings`, through `views/apps.py::edit_app_attr` with `all`; the page shows it
to a previewer only, `preview: true`, and `edit_app_attr` answers the attribute's own URL with 400). The import that makes Nova's app copies nothing, so that app starts
at `False`. Nova never sends the key. Clause 2: a URL, nothing a form asks or stores. Clause 3: the
`.ccz` writes `PostURL` (6.3). Lifecycle: alive. Kept.

**`custom_base_url`.** Reader: `ApplicationBase.url_base`, through `absolute_url_property`, moves the
profile's `ota-restore-url`, `PostURL`, `key_server` and heartbeat URL, and the media suite's remote
location (`suite_xml/generator.py`). `absolute_url_property` is `urljoin(self.url_base, <path>)` over
a path that starts at the root, so only the base's scheme, lower-cased, and its netloc exactly as
stored (credentials, the host's own letters, an explicit default port) reach a URL; a path, a query
and a fragment on the base are dropped. The suite's own request URLs do not follow it: the claim, search and case fixture
URLs are `absolute_reverse` (`remote_requests.py`, `entries.py`). Excluded from an update. Lifecycle:
flag-gated (`CUSTOM_APP_BASE_URL`) on the Settings page; `views/apps.py::edit_app_attr` takes the key
whatever the flag, under `all` (the page's save, `views/settings.py::edit_commcare_settings`), never at the
attribute's own URL, which answers 400. Kept; the `.ccz` mirrors the three profile URLs on the base's scheme and netloc.

**`build_spec`.** Excluded from an update and deleted on a create, so the server's default build stands
and a person sets it in HQ. Nova reads its version at publish and stops below 2.57
(`lib/commcare/versionFloor.ts::compareToVersionFloor`); a reading does the same through the existing
REFUSED entry. Kept at or above the floor. The `.ccz` states Nova's own floor in `requiredMajor` and
`requiredMinor`, by its contract.

**`practice_mobile_worker_id`.** Reader: `get_practice_user_id`, which adds the practice worker's
restore to HQ's build under the `practice_mobile_workers` privilege
(`suite_xml/sections/resources.py`, `practice_user_restore.xml`). Excluded from an update. It changes
only what Android's practice mode loads. Lifecycle: flag-gated (`MOBILE_USER_DEMO_MODE`) and behind a
privilege. Kept; the `.ccz` cannot hold another worker's restore and says so.

**`logo_refs`, Android slots.** `create_profile` writes each as a profile property naming the logo's
path, under the logo privilege; the file is in HQ's media map, which the import's prune keeps
(`hqmedia/models.py::ApplicationMediaMixin.remove_unused_mappings` permits `logo_paths`). On an app
Nova published, Nova writes `logo_refs` only to drop an entry whose only key is `path`, which an
earlier Nova wrote. On an app made in CommCare HQ such an entry is refused: HQ's own uploader always
stores `m_id` (`hqmedia/views.py::ProcessLogoFileUploadView.process_upload` stores what
`hqmedia/models.py::CommCareMultimedia.get_media_info` returns), so the existing REFUSED row holds it
(3.5). Clause 2: device chrome. Kept; the `.ccz` holds no bytes for them and says so.

**`auto_gps_capture`.** `FormBase.get_auto_gps_capture` is true where the form or the app says so, and
`xform.py::XForm._add_meta_2` then adds `meta/location` and its sensor to every form HQ builds. Nova
writes the key `true` for a Connect app (`applicationShell`), so clause 1 fails there: on a Connect app
it is held and derived, and where HQ held `false` the first publish changes it (the register's
`connect-app-captures-location`; part 09, section 11.2). On any other app the key is never sent and is
kept; the `.ccz` mirrors HQ's build through `addMetaBlock`. Web Apps submits `meta/location` empty
either way. Lifecycle: alive.

**`mobile_ucr_restore_version`.** Readers, all of them: `suite_xml/features/mobile_ucr.py` (report
menus), `helpers/validators.py` (a search field whose choices come from a mobile report),
`views/modules.py` (the report menu's page), `views/releases.py::_check_app_for_mobile_ucr_v1_refs` (a
warning on HQ's releases page under `MOBILE_UCR`), and `fixtures/mobile_ucr.py::_parse_apps`. A restore
made for one app returns early where that app has no report menu; one made for the project space reads
every app's value. Nova never sends the key, and an app that holds a report menu or a mobile report
choice list is refused by those entries. The setting is `disabled: true` in
`commcare-app-settings.yml` with `2.0` its one choice, and it shows only under the flag `MOBILE_UCR`,
where the page marks any other value an error and offers `2.0`
(`commcare_settings.js`, `disabledButHasValue`, `hasError`). A person on a project space without the
flag sees no setting at all, and HQ's three starter apps hold `1.0`, as does the fourth directory
beside them, `wash`'s content from before case updates stored `update_mode`
(`static/app_manager/template_apps/*/app.json`, four files), so
refusing the value, as the entry does today, would
turn away every app made from one over a value none of its content reads. Kept at `1.0` and `1.5`;
`2.0` is the default and stays inert (`49-hq-mobile-ucr-restore-version-2-0`).

**`persistent_menu`, `show_breadcrumbs`.** `templates/app_manager/profile.xml` writes both as
`cc-persistent-menu` and `cc-breadcrumbs-enabled`. Readers: formplayer
`FormplayerPropertyManager.isPersistentMenuEnabled` and `isBreadcrumbsEnabled`, and the Web Apps client
(`cloudcare/static/cloudcare/js/formplayer/menus/utils.js::showBreadcrumbs`, and the persistent menu's
views in `menus/views.js` beside it). No reader in commcare-core or
commcare-android. Web Apps runs HQ's build, never Nova's archive. Preview draws neither: its one trail
is `components/builder/BreadcrumbStrip.tsx`, the builder's own wayfinding, mounted above the canvas in
edit and Preview alike and on an Android run too (`components/preview/PreviewShell.tsx`, "No header
here"). Kept.

**`case_sharing: true`.** `xform.py::XFormCaseBlock.add_create_block` sets every new case's owner from
the worker's case sharing group and adds the `groups` instance; `suite_xml/sections/fixtures.py` adds
the fixture and `entries.py::add_case_sharing_assertion` an assertion. That changes who owns a case
Nova's forms create, so clause 2 fails. Not-yet, owner `settings-nova-comes-to-own`.

**`use_grid_menus: true`, `grid_form_menus` `all` or `some`.** `suite_xml/sections/menus.py` gives menus
the grid style and `generator.py` runs `GridMenuHelper`; `some` reads each menu's `display_style`, which
sits inside `modules`. Preview draws menus, as lists, so clause 3 would need Preview to draw a grid or
say it does not, and `some` needs a slot. Not-yet, owner `settings-nova-comes-to-own`.

### 4.4 Every key class of `translations`

HQ's default strategy builds a language's app strings from three parts in order, each over the last:
the strings it generates from the app, its own catalog text for every key any language of
`translations` names, and the language's non-empty `translations` values
(`app_strings.py::SelectKnownAppStrings.app_strings_parts`, `non_empty_only`). So a stored value wins
over everything.

| Key class | Decided by | Standing | Entry |
|---|---|---|---|
| `app.display.name`, `homescreen.title` | the key | held (the app's name); `homescreen.title` inert | existing |
| a language's code, equal to Nova's label, or absent where HQ's default name is that label | the key and value | held | existing |
| a language's code, any other value, or absent where HQ's default differs | the key and value | kept | 7.2 |
| a key a runtime reads as its own UI text (the surface's `ui-string:` family) | `translationKeyOwner` gives `target` and `appStringKeys.ts::isRuntimeUiStringKey` holds (6.1) | kept | 3.6 |
| HQ's catalog fill for such a key | follows from the row above | kept | 3.6 |
| a key matching one of HQ's generated patterns (the surface's `app-string-id:` family, less `android.package.name.*`) | `translationKeyOwner` gives `generated` | inert, held or not-yet by value | 7.1 |
| any other key | `target`, and `isRuntimeUiStringKey` does not hold | inert | `translations-key-no-runtime-reads` |

---

## 5. `KEPT_AT_HQ`

New file `lib/commcare/surface/keptAtHq.ts`, pure, holding entry ids as strings and nothing of the
manifest JSON. It imports two types from `lib/publish`, `KeptLabelId` (`keptValues.ts`, 9.4) and
`KeptExportAdvisoryId` (`exportAdvisories.ts`, 6.3): the words a person reads live there, with the
other copy, and a row names its label by id. Server code and tests read the table; the kept list
reaches the browser as label ids (`DeploymentView.kept`, 6.5), which a component words through
`lib/publish/keptValues.ts::KEPT_LABELS`, since no component may import `lib/commcare`:

```ts
export type KeptKind = "setting" | "identity" | "server-record" | "project-state";

export type KeptCczCell =
	/**
	 * The archive writes what HQ's build writes from the value, read from `TargetFacts`.
	 * `advisory` names what the download says where the value is absent and the archive
	 * cannot write what HQ's build fills in.
	 */
	| { readonly does: "mirrors"; readonly by: string; readonly advisory?: KeptExportAdvisoryId }
	/** The archive cannot follow; the download says so through this advisory. */
	| { readonly does: "states"; readonly advisory: KeptExportAdvisoryId }
	/** Nothing an archive holds derives from the value. */
	| { readonly does: "no-reader"; readonly why: string }
	/** The archive carries Nova's own value by a stated contract. */
	| { readonly does: "own"; readonly why: string };

export type KeptPreviewCell =
	| { readonly does: "reads"; readonly by: string }
	| { readonly does: "no-claim"; readonly why: string };

export type KeptElsewhereCell =
	/** A first publish to another project space writes Nova's own value. */
	| { readonly does: "seeds"; readonly value: string }
	/** Nothing is written, so CommCare HQ's default stands there. */
	| { readonly does: "default"; readonly value: string }
	/** That project space has its own record or its own state. */
	| { readonly does: "its-own" };

export interface KeptRow {
	readonly kind: KeptKind;
	/** The label a person reads in the kept list; absent for a row no list shows. */
	readonly label?: KeptLabelId;
	readonly ccz: KeptCczCell;
	readonly preview: KeptPreviewCell;
	readonly elsewhere: KeptElsewhereCell;
	/** The HQ-authored base that holds it at a value other than the default. */
	readonly base: string;
}

export const KEPT_AT_HQ: Readonly<Record<string, KeptRow>>;
```

Preview has two answers and no third: it reads the value, or it claims nothing the value changes. A
difference Preview would only state is a Preview that plays something no platform does, so the one
setting that was stated, the asterisk on required questions, is read (6.4).

Bases are part 14's (`14-proof.md`, section 6.2). This part names three of them: `hq-new-app` (a
just-created app), `hq-kept-settings` (an app authored through HQ's pages and models that declares
both platforms and holds every labelled `setting` row at a value other than its default, the custom
base URL among them as a second origin with a path), and `starter-health` (HQ's health starter app).

The table. "n-i-a" abbreviates `no-reader`. The Label column shows the words; the row holds the
label's id, which 9.4 lists beside each. A cell's text after its colon is its `why`, `value` or `by`
as the file holds it. A cell written with no such text takes these: `mirrors` alone is
`by: "lib/commcare/keptProfile.ts::targetProfileProperties"`, as the first row; a `mirrors` with a
symbol in parentheses takes that symbol's `path::symbol` (`compiler.ts::compileCcz`,
`xform/metaBlock.ts::addMetaBlock`, `runtimeTarget.ts::profileServerProperties`, each under
`lib/commcare/`); a `reads` with a symbol in parentheses takes that symbol's
(`components/preview/shared/listFilter.tsx::rowsMatchingFilterText`,
`lib/preview/platform.ts::requiredMarkShown`,
`lib/preview/engine/useLookupPreviewData.tsx::PreviewLookupDataProvider`,
`components/builder/media/ProjectMediaResource.tsx::useProjectMediaUrl`). Every `by` is a
`path::symbol` its module exports, which the binding test holds, so a `reads` never holds prose and
the `<credentials>` row names `compileCcz`, which writes the profile, rather than the private
`generateProfile` it calls; "the same" repeats the `why` of the row above; `n-i-a`
alone is `why: "Nothing an archive holds derives from this value."`; `no-claim` alone is
`why: "Preview claims nothing this value changes."`; and `default` alone is
`value: "CommCare HQ's own default"`.

| Entry (`application-and-settings/` unless another area is named) | Kind | Label | `.ccz` | Preview | Another project space | Base |
|---|---|---|---|---|---|---|
| `1-properties-cc-autoup-freq` | setting | Automatic app updates | mirrors (`targetProfileProperties`) | no-claim: Preview installs no update | seeds `freq-never` | `hq-kept-settings` |
| `4-properties-cc-days-form-retain` | setting | How long sent forms are kept | mirrors | no-claim: Preview keeps no sent forms | seeds `-1` | `hq-kept-settings` |
| `5-properties-logenabled` | setting | Device logging | mirrors | no-claim: Preview sends no device log | seeds `Enabled` | `hq-kept-settings` |
| `13-properties-cc-autosync-freq` | setting | Automatic sync | mirrors | no-claim: Preview reads the case store directly | seeds `freq-never` | `hq-kept-settings` |
| `17-properties-cc-content-valid` | setting | Media check at install | mirrors | no-claim: Preview installs nothing | seeds `no` | `hq-kept-settings` |
| `18-properties-unsent-number-limit` | setting | Unsent form warning, by count | mirrors | no-claim: Preview sends each form at once | seeds `5` | `hq-kept-settings` |
| `19-properties-unsent-time-limit` | setting | Unsent form warning, by days | mirrors | no-claim: the same | seeds `5` | `hq-kept-settings` |
| `22-properties-cc-resize-images` | setting | Image resizing | mirrors | no-claim: Preview stores a picture as chosen | seeds `none` | `hq-kept-settings` |
| `23-properties-cc-fuzzy-search-enabled` | setting | Fuzzy search in case lists | mirrors | reads (`rowsMatchingFilterText`, 6.4) | seeds `no` | `starter-health` |
| `25-properties-cc-login-duration-seconds` | setting | How long a sign-in lasts | mirrors | no-claim: Preview has no worker sign-in | seeds `86400` | `hq-kept-settings` |
| `26-properties-cc-inflation-target-density` | setting | Image scaling | mirrors | no-claim: the browser scales images | seeds `none` | `hq-kept-settings` |
| `27-properties-cc-gps-auto-capture-accuracy` | setting | Accuracy for automatic location capture | mirrors | no-claim: Preview captures no location on its own | seeds `10` | `hq-kept-settings` |
| `28-properties-cc-maps-default-layer` | setting | Default map layer | mirrors | no-claim: the map is Google's own in Preview | seeds `normal` | `hq-kept-settings` |
| `29-properties-cc-enable-tts` | setting | Text to speech | mirrors | no-claim: Preview speaks no label | seeds `no` | `hq-kept-settings` |
| `30-properties-cc-label-required-questions-with-asterisk` | setting | Asterisk on required questions | mirrors | reads (`requiredMarkShown`, 6.4) | seeds `no` | `hq-kept-settings` |
| `24-properties-cc-log-entity-detail-enabled` | setting | Logging of case detail views | mirrors | no-claim: Preview sends no device log | default: not written | `hq-kept-settings` |
| `translations-key-in-a-runtime-s-ui-string-catalog-core-android` | setting | CommCare's own screens, reworded | mirrors (`compileCcz`, the table merge) | no-claim: Preview's chrome is Nova's own | default: CommCare's wording | `hq-kept-settings` |
| `translations-catalog-key-hq-fills-with-its-own-text-in-a` | setting | (none: shown with the row above) | states (`kept_ui_text_falls_back`) | no-claim: the same | default: CommCare's wording | `hq-kept-settings` |
| `translations-lang-code-any-other-value-or-absent-where-hq-s` | setting | Language names | mirrors (`compileCcz`), with the advisory `kept_language_names_differ` where HQ holds no name (7.2) | no-claim: the language menu is Nova's own control | seeds Nova's label | `hq-kept-settings` |
| `logo-refs-hq-logo-android-home-login-demo` | setting | Android logos | states (`kept_android_logos_absent`) | no-claim: Preview draws no Android home or sign-in screen logo | default: none | `hq-kept-settings` |
| `49p-hq-mobile-ucr-restore-version-1-0-1-5` | setting | Mobile report version | n-i-a: an archive holds no report | no-claim: Preview runs no report | default: `2.0` | `starter-health` |
| `45p-hq-auto-gps-capture-on-an-app-that-is-not-a-connect-app` | setting | Location captured with every form | mirrors (`addMetaBlock`) | no-claim: Preview submits no `meta/location` | default: off | `hq-kept-settings` |
| `51-hq-persistent-menu` | setting | Persistent menu in Web Apps | n-i-a: only Web Apps reads it, from HQ's build | no-claim: Preview draws no persistent menu | default: off | `hq-kept-settings` |
| `52-hq-show-breadcrumbs` | setting | Breadcrumbs in Web Apps | n-i-a: the same | no-claim: the trail above Preview is the builder's | default: on | `hq-kept-settings` |
| `43-hq-secure-submissions` | setting | Secure submissions | mirrors (`profileServerProperties`) | no-claim: Preview posts to no receiver | default: off (the import that makes Nova's app copies no project space setting) | `starter-health` |
| `36-hq-custom-base-url` | setting | Custom base URL | mirrors (`profileServerProperties`) | no-claim: the same | default: none | `hq-kept-settings`, which holds a second origin with a path |
| `35-hq-practice-mobile-worker-id` | setting | Practice mobile worker | states (`kept_practice_worker_absent`) | no-claim: Preview has no practice mode | default: none | `hq-kept-settings` |
| `34-hq-build-spec-at-or-above-nova-s-floor-2-57` | setting | (none: a version at or above the floor is no difference a person set against Nova) | own: the profile requires Nova's floor, 2.57 | no-claim: Preview runs Nova's own engine | default: the server's default build | `hq-new-app` |
| `build-profiles-each-profile-s-name-langs-practice-mobile-worker` | setting | (none: empty) | n-i-a: an archive is one build | no-claim | default: none | `hq-new-app` |
| `32-features-credentials` | setting | Worker activity credential | mirrors (`compileCcz`, the profile's `<credentials>` block) | no-claim: Preview shows no work history | its-own | `hq-kept-settings` |
| `target-derived-profile-properties-posturl-posttesturl-ota` | setting | (none) | own: the four server properties and `cur_locale`, for the archive's project space | no-claim | its-own | `hq-new-app` |
| `amplifies-workers-amplifies-project-minimum-use-threshold` | server-record | | n-i-a | no-claim | default | `hq-new-app` |
| `rev-domain-copy-of-version` | server-record | | own: the archive's version is the app's sequence | no-claim | its-own | `hq-new-app` |
| `short-odk-url-short-odk-media-url`, `built-with-build-signed-built-on-build-comment-comment-from-last`, `date-created-created-from-template-last-modified-has-submissions`, `copy-history-family-id`, `external-blobs`, `archived-media` | server-record | | n-i-a | no-claim | its-own | `hq-new-app` |
| `id` | identity | | own: `profileUniqueId`, Nova's id for the app on the project space | no-claim | its-own | `hq-new-app` |
| `multimedia-map` | identity | | own: the archive bundles each file at the path its references name | reads (`useProjectMediaUrl`): Preview plays the Project's own copy | its-own | `starter-health` |
| `menus-and-case-lists/modulebase-unique-id`, `forms-and-case-writes/unique-id` | identity | | own: the deployment's recorded ids (`targetWireIdentity`) | no-claim: Preview keys by Nova's UUIDs | its-own | `hq-new-app` |
| `forms-and-case-writes/version` | server-record | | own: each form takes the app's sequence | no-claim | its-own | `hq-new-app` |
| `expressions-and-data/hq-table-and-row-ids-uuid4-a-workbook-upload-re-mints-a-table` | identity | | own: the archive embeds the Project's table | reads (`PreviewLookupDataProvider`): Preview reads the Project's table | its-own | `hq-new-app` |
| `expressions-and-data/is-synced-last-modified` | server-record | | own: the archive embeds the Project's table | reads (`PreviewLookupDataProvider`): Preview reads the Project's table | its-own | `hq-new-app` |
| `case-search/domain-casesearchconfig-sync-cases-on-form-entry`, `forms-and-case-writes/supply-point-id-datum-hq-injects-under-commtrack-enabled-into`, `forms-and-case-writes/data-dictionary-caseproperty-data-type`, `forms-and-case-writes/usercase-creation-and-sync-hq-user-id` | project-state | | n-i-a: the app's source holds none of it; publish asks a person where it matters | no-claim | its-own | `hq-new-app` |

The table has 50 rows: one for each of the 26 entries that are TARGET-OWNED today, the 23 of 3.6 and
the language display name's (7.2). Rows written here on one line for several ids are one row each in
the file.

`label` names what the kept list shows; a row without one is never listed (a person has no use for
"the app's revision stays in CommCare HQ"). The kept list of one deployment is the labelled `setting`
rows whose value in its `TargetFacts` differs from what a first publish elsewhere would give
(`lib/deployment/targetFacts.ts::keptListFor`, 6.1). An app whose project space holds every default
has an empty list, and its card says so and still offers the refresh (6.5).

---

## 6. `TargetFacts`

### 6.1 The type and the projection

Two new files, because two packages read the facts and the import between them runs one way.
`lib/deployment` imports `lib/commcare` throughout, and no production file of `lib/commcare` imports
`lib/deployment` (its two such imports are tests). The emitter reads the facts (`compiler.ts`,
`keptProfile.ts`, `runtimeTarget.ts`, 6.3), so the type lives with it, and so does the reading of HQ's
own keys, which is wire vocabulary.

`lib/commcare/targetFacts.ts` (new, pure, outside the barrel; it imports `appStringKeys.ts` alone):

```ts
/** The profile settings a project space holds that a `.ccz` writes at its value. */
export const KEPT_PROFILE_PROPERTY_KEYS = [
	"cc-fuzzy-search-enabled", "cc-gps-auto-capture-accuracy", "cc-content-valid", "cc-autoup-freq",
	"cc-enable-tts", "cc-autosync-freq", "cc-days-form-retain", "cc-inflation-target-density",
	"cc-label-required-questions-with-asterisk", "cc-login-duration-seconds", "cc-maps-default-layer",
	"cc-resize-images", "logenabled", "unsent-number-limit", "unsent-time-limit",
	"cc-log-entity-detail-enabled",
] as const;
export type KeptProfilePropertyKey = (typeof KEPT_PROFILE_PROPERTY_KEYS)[number];

export type AndroidLogoSlot = "home" | "login" | "demo";

/** What one project space holds of the values Nova leaves to CommCare HQ. */
export interface TargetFacts {
	/** When CommCare HQ was read: the baseline's `observed_at`. */
	readonly observedAt: string;
	/** Each kept setting the project space holds a value for, as HQ's build writes it. */
	readonly profileProperties: Readonly<Partial<Record<KeptProfilePropertyKey, string>>>;
	/** Per HQ language code, each key the project space owns that holds text. */
	readonly uiText: Readonly<Record<string, Readonly<Record<string, string>>>>;
	/** Every runtime UI text key the project space owns in any language, blank ones included, sorted. */
	readonly uiTextKeys: readonly string[];
	readonly secureSubmissions: boolean;
	/** The scheme and netloc HQ's build keeps of the project space's custom base URL, or null. */
	readonly customBaseUrl: string | null;
	/** Location captured with every form, on an app Nova does not set it on. */
	readonly autoGpsCapture: boolean;
	readonly androidLogos: readonly AndroidLogoSlot[];
	readonly practiceWorker: boolean;
	readonly persistentMenu: boolean;
	readonly breadcrumbs: boolean;
	readonly mobileReportVersion: string;
	/** The worker activity level the project space issues a credential for, or null. */
	readonly credentialLevel: string | null;
	/**
	 * On a deployment Nova brought the app in from: per language of the source, each language code
	 * that language's `translations` entry holds a non-empty name for. Null where Nova created
	 * the HQ app (7.2).
	 */
	readonly languageNames: Readonly<Record<string, Readonly<Record<string, string>>>> | null;
	/** Who fills a seeded setting the project space holds no value for (7.3). */
	readonly seeds: "nova" | "target";
}

/** The facts one normalized source read holds. A source that is no object gives null. */
export function targetFactsFromSource(
	source: unknown,
	input: {
		readonly observedAt: string;
		/** True where Nova's own body set `auto_gps_capture` (the baseline's ownership). */
		readonly novaOwnsAutoGpsCapture: boolean;
		/** True where Nova brought the app in: the live app mapping is `adopted` (part 10, section 6.3). */
		readonly adopted: boolean;
	},
): TargetFacts | null;

/** The text HQ's profile template writes for a stored setting value, or null where it writes none. */
export function hqProfileValueText(raw: unknown): string | null;
```

The sixteen keys are literals so that `KeptProfilePropertyKey` is a union of them:
`SEEDED_PROFILE_PROPERTIES` is typed `readonly AppProfileProperty[]` with `key: string`, and a tuple
spread from it would type every key `string`. `keptProfile.test.ts` holds the first fifteen equal to
`SEEDED_PROFILE_PROPERTIES`' keys, in its order.

`lib/commcare/appStringKeys.ts` gains, beside `translationKeyOwner`:

```ts
/** Whether a runtime reads `key` as one of its own UI strings. */
export function isRuntimeUiStringKey(key: string): boolean;
```

It holds where the surface has an item `ui-string:<key>` with a `readBy`, or an item
`ui-string:<prefix>.*` with a `readBy` whose prefix `key` starts with, which is the rule the lane reads
the same family by (`proof/checks/manifest_usage.py::ui_string_key`); the file already reads the
surface's `app-string-id:` items this way.

`lib/deployment/targetFacts.ts` (new, pure: it imports the file above, `./types`,
`lib/commcare/surface/keptAtHq.ts`, `lib/commcare/appProfileSettings.ts` (Nova's seeds, which
`keptListFor` compares with) and, for types, `lib/publish/keptValues.ts` and
`exportAdvisories.ts`; no store and no `server-only`, so tests and the proof capture call it):

```ts
export function targetFactsFromBaseline(
	baseline: Extract<AppBaseline, { source: unknown }>,
	/** The live app mapping's ownership. */
	adopted: boolean,
): TargetFacts | null;

/** The label ids of the kept settings this project space holds at another value than a new one would. */
export function keptListFor(facts: TargetFacts): readonly KeptLabelId[];

/** What a `.ccz` made from these facts cannot follow. */
export function keptAdvisoryFacts(
	facts: TargetFacts,
	languageCodes: readonly string[],
): KeptAdvisoryFacts;
```

`TargetFacts` carries no origin. Every origin that gives facts words its date the same way (6.5), so
nothing would read one. `targetFactsFromSource` takes a source and not a baseline, so a reading can
project the app it has just read before any baseline exists: part 12's review fills its kept list
that way (`12-the-reading-and-the-birth.md`, section 5.1).

`targetFactsFromBaseline` returns `null` for a baseline whose origin is `create`, and otherwise
`targetFactsFromSource(baseline.source, { observedAt: baseline.observedAt, novaOwnsAutoGpsCapture:
baseline.ownership.autoGpsCapture, adopted })`. A `create` baseline describes a shell, and a shell is
never a project space a `.ccz`, Preview or a card reads facts for: its mapping carries no pushed revision
(`store.ts::recordCreatedRemoteApp`), and `readReachedDeploymentTargets` never lists a mapping to the
empty shell, whatever the record displays. The fill that follows writes a `push` baseline, which is
what gives the first facts. For `push`, `cutover` and `read` (the origin part 10 gives an app brought
in, `10-identity-and-the-ledger.md`, section 6.3) `targetFactsFromSource` reads, from the source as
an object:

| Field | Read from | Rule |
|---|---|---|
| `profileProperties[key]` | `profile.properties[key]` for each of `KEPT_PROFILE_PROPERTY_KEYS` | `hqProfileValueText(value)`; the key is left out where that is `null` |
| `uiText[lang][key]` | `translations[lang][key]` | kept where `translationKeyOwner(key, langs)` is `"target"` and the value is a non-empty string, with `langs` the source's own |
| `uiTextKeys` | the same walk | every `target` key of every language for which `isRuntimeUiStringKey` holds, whatever its value |
| `secureSubmissions` | `secure_submissions` | `=== true` |
| `customBaseUrl` | `custom_base_url` | `hqUrlBase(value)`: the value read as `urllib.parse.urlsplit` reads it, `${scheme}://${netloc}` with the scheme lower-cased and the netloc exactly as stored, where the scheme is `http` or `https` and the netloc is non-empty and one `urlsplit` accepts, else `null` |
| `autoGpsCapture` | `auto_gps_capture` | `=== true`, and `false` where `novaOwnsAutoGpsCapture` is true (Nova's own value on a Connect app is no kept fact) |
| `credentialLevel` | `profile.features.credentials` | `hqProfileValueText(value)` |
| `androidLogos` | `logo_refs` | each of `home`, `login`, `demo` whose `hq_logo_android_<slot>` entry holds a string `path` |
| `practiceWorker` | `practice_mobile_worker_id` | a non-empty string |
| `persistentMenu` | `persistent_menu` | `=== true` |
| `breadcrumbs` | `show_breadcrumbs` | `!== false` |
| `mobileReportVersion` | `mobile_ucr_restore_version` | the string, or `"2.0"` |
| `languageNames[lang][code]` | `translations[lang][code]`, for each language code of the source | `null` for the whole field where `adopted` is false; else each value that is a non-empty string |
| `seeds` | the input | `"target"` where `adopted` is true, else `"nova"` |

`hqProfileValueText` restates `Application.create_profile`'s `if setting_value:` and the template's
print of the value: `null`, `undefined`, `""`, `false` and `0` give `null`; `true` gives `"True"`; a
number gives its decimal text; a string gives itself; anything else gives `null`. The numeric `10` HQ's
own Settings save stores for `cc-gps-auto-capture-accuracy` therefore reads `"10"`.

A generated key never enters `uiText`: `translationKeyOwner` gives it `generated`, and a publish drops
it, so it is no fact of the target (7.1). A language's own code is `language-name` and never enters
`uiText`: `languageNames` holds it on a deployment Nova brought in (7.2).

`uiText` and `uiTextKeys` differ on purpose. `uiText` holds every `target` key with text, a key no
runtime reads included, because the archive mirrors HQ's build and HQ's build writes every stored
value (4.4). `uiTextKeys` holds only the keys a runtime reads, because it decides what a person is
told: the kept list's "CommCare's own screens, reworded" and the advisory `kept_ui_text_falls_back`
(6.3). A key no runtime reads rewords no screen, and HQ's catalog fill never covers one
(`SelectKnownAppStrings.app_strings_parts` fills a key only where its own catalog holds it).

A `custom_base_url` that is no `http:` or `https:` URL with a netloc gives `null`, and the archive
writes the server's own base URL: `urljoin` over a base with no scheme and netloc gives a path alone
or `https:///a/…` (`absolute_url_property`), and one `urlsplit` refuses makes HQ's build raise, so HQ's
build holds no address there for the archive to mirror. The netloc is not the WHATWG origin: a
stored `https://relay:secret@Proxy.Example.org:443/hq/` gives HQ's build
`https://relay:secret@Proxy.Example.org:443/a/…`, credentials, letters and port as stored.

`keptListFor` returns, in `KEPT_AT_HQ`'s order, the `label` of each labelled `setting` row for which:
a seeded setting's `profileProperties` value is present and differs from Nova's seed;
`cc-log-entity-detail-enabled` is present; `uiTextKeys` is non-empty; `androidLogos` is non-empty;
`mobileReportVersion` is not `"2.0"`; `autoGpsCapture`, `persistentMenu`, `secureSubmissions` or
`practiceWorker` is true; `breadcrumbs` is false; `customBaseUrl` is not `null`; `credentialLevel` is
not `null`; `languageNames` is not `null` (on an app Nova brought in every language's name is
CommCare HQ's, where a first publish elsewhere writes Nova's label, 7.2). The CommCare version row
has no label: a version at or above the floor is no difference from what Nova would write.

### 6.2 The view-capable reader

`lib/deployment/store.ts` gains:

```ts
export async function readTargetFacts(
	scope: DeploymentScope,
	target: DeploymentTargetKey,
): Promise<TargetFacts | null>;
```

It authorizes `view` (`roleAllowsApp(scope.role, "view")`, else `deploymentNotFound()`), where
`readAppBaseline` keeps `edit`: the reader returns the typed projection and never the source, and every
value of the projection is one a viewer's own `.ccz` already carries (6.3). The two readers share the
row's verification, extracted as a function private to the store:

```ts
/** Gunzip, check the digest, parse the JSON and read the ownership of one stored baseline row. */
function verifiedBaselineSource(row: {
	readonly deployment_id: string;
	readonly source_gzip: Buffer | null;
	readonly source_digest: string | null;
	readonly ownership: unknown;
}): { readonly source: unknown; readonly ownership: AppOwnership } | null;
```

A row that does not verify answers `null`, which gives `null` here and `unread` there, with the one
`log.error` the existing reader writes, now written inside this function.

It reads in two steps, so a builder page load does not unzip an app's source each time. First it selects
`deployment_id`, `origin`, `source_digest`, `ownership` and `observed_at`, with no bytes, and with
the row the live app mapping's ownership (`adopted` or not); `unread`, `create` or no row answers
`null`. A module-level map of at most 64 entries, keyed by `deployment_id`, `source_digest`, the
row's ownership of `auto_gps_capture` and `adopted` (everything the projection reads but the date,
which each read applies from the row's `observed_at`, since a refresh rewrites the date over
unchanged bytes), then answers a source it has projected before; only a miss selects `source_gzip`.
The digest names the bytes, so an entry is never stale, and the cap bounds an instance's memory.

### 6.3 The `.ccz`

Today's path, and each change:

| Where | Today | New |
|---|---|---|
| `lib/deployment/runtimeTarget.ts::ReachedDeploymentTarget` | `emptyCaseListText`, `earlierHqApps` | unchanged; the facts are not a column and do not ride the reached list |
| `lib/deployment/downloadTarget.ts::resolveDownloadTarget`, the `ccz` arm | reads `readDeploymentIdentityOverrides` for the chosen target | also awaits `readTargetFacts(scope, target)`; `DownloadTarget`'s `ccz` arm gains `readonly targetFacts: TargetFacts \| null`. A fault throws, as the identity read's does. |
| `lib/export/localArchive.ts::compileLocalArchive` | `deployment: { emptyCaseListText, earlierHqApps }` | `deployment` gains `readonly targetFacts: TargetFacts \| null`, required, passed to `compileCcz` |
| `lib/commcare/compiler.ts::CompileOptions` | no such option | `targetFacts?: TargetFacts \| null` (the type of `lib/commcare/targetFacts.ts`); absent or `null` reads Nova's constants, as today |
| `compiler.ts::generateProfile` | `appProfileProperties(input.doc)` | `targetProfileProperties(input.doc, facts)` |
| `compiler.ts::generateProfile`, `<features>` | `<checkoff active="true"/>` and `<users active="true"/>` | where `facts?.credentialLevel` is not `null`, a last child `<credentials active="true"><credential level="<the level>" type="APP_ACTIVITY"/></credentials>`, the block `templates/app_manager/profile.xml` writes, in its place after `<users>` (HQ's `<dependencies>` sits between the two, and Nova writes none) |
| `lib/commcare/runtimeTarget.ts::profileServerProperties(target)` | plain receiver, the server's base URL | `profileServerProperties(target, facts)` |
| `compiler.ts::compileCcz`, the `addMetaBlock` call | `captureLocation: authoredDoc.connectType !== null` | `captureLocation: authoredDoc.connectType !== null \|\| facts?.autoGpsCapture === true` |
| `compiler.ts::compileCcz`, the app string tables | Nova's own keys | each language's table then takes `facts.uiText[language]`, and the `default` table HQ's merge of every language (below) |
| the three callers of `compileLocalArchive` (`app/api/compile/route.ts`, `lib/mcp/tools/compileApp.ts`, `proof/corpus/publish.ts`) | pass the reached target's two facts | pass `download.targetFacts` too, which reaches the two routes on `app/api/compile/prepareCompileRequest.ts::PreparedCompileRequest.download` (the resolved `ccz` arm, whose type now holds it); the proof capture passes the facts `targetFactsFromBaseline` gives over the baseline it captured, or `null` |
| the three callers of `exportAdvisories` (`app/api/compile/route.ts`, `app/api/compile/json/route.ts`, `lib/mcp/tools/compileApp.ts`) | `exportAdvisories(doc, attachmentTargetState)` | the `.ccz` arms pass `keptAdvisoryFacts(download.targetFacts, codes)` where the facts are not `null`, else `null`, with `codes` the archive's language codes (`planLanguageWire(...).languages`), through one helper beside the resolver, `lib/deployment/downloadTarget.ts::downloadKeptAdvisoryFacts(download, doc)`, which answers `null` for the import file's arm and for facts that are `null`; `app/api/compile/json/route.ts` passes `null`, and `compileApp.ts` passes the helper's answer, which is `null` for its HQ import file arm |

**`lib/commcare/keptProfile.ts`** (new, pure) exports
`targetProfileProperties(doc, facts): readonly AppProfileProperty[]`: for each of
`appProfileProperties(doc)` in its order, the two owned settings as they are, and each seeded setting at
`facts.profileProperties[key]` where present, else its seed, with the table's own `force`; then, where
`facts.profileProperties["cc-log-entity-detail-enabled"]` is present, that property with `force: true`.
With `facts` `null` it returns `appProfileProperties(doc)`. This is `projectProfileForTarget`'s rule
read from the other side: after any Nova publish the target holds exactly these values, so the archive
and HQ's build of the same project space state one profile. Both sides take the same second rule
for a deployment Nova brought in (7.3).

**`profileServerProperties(target, facts)`.** `base` is `facts.customBaseUrl` where it is set, else the
server's base URL, for `ota-restore-url`, `PostURL` and `key_server`, as `ApplicationBase.url_base`
moves all three. `customBaseUrl` is already what HQ's `urljoin` of the base with a root path keeps
of it (6.1), its scheme and its netloc as stored: `https://example.org/hq/` and `https://example.org` both give
`https://example.org/a/<domain>/…`. `PostURL` is
`${base}/a/${domain}/receiver/secure/${appId}/` where `facts.secureSubmissions` is true, else the plain
`${base}/a/${domain}/receiver/${appId}/`. `cc_user_domain` is unchanged. Its comment's sentence "with
the receiver URL in its plain form because every app Nova imports has `secure_submissions` off" becomes
"with the receiver URL HQ's own `post_url` picks: the secure receiver where the project space's app
submits securely, read from the deployment's `TargetFacts`, and the plain one otherwise".
`runtimeUrls` (claim, search, case fixture) does not take the custom base URL, as HQ's own suite does
not (4.3).

**The app strings.** In `compileCcz`'s loop over `langDirs`, after Nova's own entries and the language
names and before `lang.current`, `Object.assign(table, facts.uiText[language] ?? {})`. Most of
Nova's own app-string ids match a generated pattern and so never enter `uiText`. A `target` key can
still be one Nova writes: `case_autoload.usercase.case_missing`
(`usercaseWire.ts::USERCASE_MISSING_LOCALE_ID`) matches no generated pattern. Where a project space
holds text for such a key, that text replaces Nova's in the archive. That is the mirror working: HQ's
build puts a stored translation over every string (4.4), and a publish carries the key. The `default`
directory takes the default language's names, and under every other key the text
`appStringKeys.ts::defaultAppStringsHeldText(facts.uiText, languages)` gives: HQ's build merges every
language's strings into its default table, the last language first
(`app_strings.py::AppStringsBase.create_default_app_strings`), so a key takes the first language's
text that is not blank, a language's catalog text included (`SelectKnownAppStrings.app_strings_parts`).
Each language's strings are read back from the text `dumps` writes (`commcare_translations.py::loads`,
whose `line.strip()` turns a blank text's non-breaking space into `""` and drops the spaces at a
text's end), and the merge never puts a blank over a text already merged, so a language holding a
blank gives none, its catalog's included, and a blank stands only where no language holds more.
Nova writes no catalog text, so where a language's catalog may hold the key
(`appStringKeys.ts::hqCatalogMayHold`, over the surface's `ui-string:` catalogs) before any language
that holds text for it, the key takes nothing, and a phone shows its own wording, which
`kept_ui_text_falls_back` states. A language of
`uiText` the app does not have writes nothing, as HQ builds no table for it.

**What the archive states.** `lib/publish/exportAdvisories.ts` gains four advisory ids and one
parameter:

```ts
export type ExportAdvisoryId =
	| "attachment_links_without_target"
	| "kept_ui_text_falls_back"
	| "kept_android_logos_absent"
	| "kept_practice_worker_absent"
	| "kept_language_names_differ";

/** The advisories that say what a `.ccz` cannot follow of a kept value. */
export type KeptExportAdvisoryId = Extract<ExportAdvisoryId, `kept_${string}`>;

/** What a `.ccz` cannot follow of what its project space holds. Plain booleans: no wire vocabulary. */
export interface KeptAdvisoryFacts {
	readonly uiTextFallsBack: boolean;
	readonly androidLogos: boolean;
	readonly practiceWorker: boolean;
	/** Some language name in the archive is Nova's where CommCare HQ holds none (7.2). */
	readonly languageNames: boolean;
}

export function exportAdvisories(
	doc: BlueprintDoc,
	attachmentTarget: AttachmentTargetState,
	kept: KeptAdvisoryFacts | null,
): readonly ExportAdvisory[];
```

`keptAdvisoryFacts(facts, languageCodes)` gives `uiTextFallsBack` true where some key of `uiTextKeys`
has no entry in `uiText[code]` for some `code` of the app's languages; `androidLogos` and
`practiceWorker` from their fields; and `languageNames` true where `facts.languageNames` is not `null`
and some app language's table lacks a held name for some app language's code (7.2).
`uiTextKeys` holds runtime UI text keys alone (6.1), so a stored key no runtime reads raises no
advisory. The HQ import file passes `null`: it is made for no project space. The attachment advisory
keeps its place first. Copy is in section 9.

`application-and-settings/target-derived-profile-properties-posturl-posttesturl-ota`'s emission cell
gains "the local `.ccz` writes `ota-restore-url`, `PostURL`, `key_server` and `cc_user_domain` for its
project space, on the custom base URL and the secure receiver where the project space holds them".

### 6.4 Preview

Preview reads two kept values. Fuzzy search in a case list it reads on both platforms: Android's
list and Formplayer's both filter through Core's `EntitySortUtil.sortEntities` with the profile's
`cc-fuzzy-search-enabled` (`MainConfigurablePreferences.isFuzzySearchEnabled`,
`FormplayerPropertyManager.isFuzzySearchEnabled`). The asterisk on required questions it reads where
it plays Android, the one platform that reads the setting.

**The rule, ported.** New file `lib/preview/listFilterMatch.ts`, pure:

```ts
/** Core's `StringUtils.normalize`: NFD, combining marks U+0300 to U+036F removed, lower case. */
export function normalizeForFilter(text: string): string;
/** Core's `StringUtils.fuzzyMatch(source, target)` at its threshold of 2. */
export function fuzzyMatch(source: string, target: string): { matches: boolean; distance: number };
/** The terms a runtime makes of what a worker typed, each normalized. */
export function filterTerms(
	text: string,
	split: "whitespace-runs" | "single-spaces",
): readonly string[];
/** One row's verdict: whether every term matched, and the summed distance of its fuzzy matches. */
export function rowFilterScore(
	terms: readonly string[],
	fields: readonly { readonly text: string; readonly sortText: string | null }[],
	fuzzy: boolean,
): { readonly matches: boolean; readonly score: number };
```

`fuzzyMatch`, as Core writes it: where `source.length > 3`, `target` is cut to
`source.length + 2` characters when longer, and the two match when their Levenshtein distance is at
most 2; a shorter `source` never matches. `rowFilterScore`, as `sortEntities` writes it: for each term in
order, for each field in order, the field matches where its normalized text is not empty and contains
the term; otherwise, with `fuzzy` on, where `fuzzyMatch(term, piece)` holds for a whitespace-separated
piece of the field's normalized `sortText`, which adds that distance to the score; a term no field
matches fails the row. An empty term is contained in every field that shows text, so it passes a row
with any text and fails a row whose every field is blank. No terms at all pass every row.

**What each runtime does around Core's rule.** The two differ in three places, and Preview plays one
platform at a time, so `lib/preview/platform.ts::PreviewPlatformRules` gains one rule:

```ts
/**
 * How the list's filter box splits what a worker types, what closeness does to the order,
 * and what an emptied box does.
 */
readonly listFilter: {
	readonly terms: "single-spaces" | "whitespace-runs";
	readonly fuzzyOrder: "closest-among-ties" | "closest-first";
	readonly emptyText: "skipped" | "runs-once-edited";
};
```

| | Web Apps | Android |
|---|---|---|
| The split | `single-spaces`: `searchText.split(" ")` (`EntityScreenHelper.java::filterEntities`). Two spaces in a row give an empty term between them, and a tab is no separator. | `whitespace-runs`: `filterRaw.split("\\s+")` (`EntityListAdapter.java::filterByString`). Text that starts with whitespace gives an empty first term. |
| The order with fuzzy search on | `closest-among-ties`: the filter returns the matches closest first (`EntitySortUtil.sortEntities` sorts them by score), then Formplayer sorts them by the list's own order (`EntityScreenHelper.java::sortEntities`, a stable sort, `EntitySorter.compare` answering 0 on a tie) and gathers groups in order of first appearance (`groupEntities`). Closeness decides only between rows the list's order ties. | `closest-first`: the adapter shows the matches as the filter returns them (`EntityStringFilterer.java::buildMatchList`), stably re-sorted by ascending score over the list's order. |
| An empty box | `skipped`: `filterEntities` skips an empty text, so every row shows. | `runs-once-edited`: before anything is typed every row shows. Once the worker has typed, the adapter runs the filter on every change, an empty text included: `"".split("\\s+")` is one empty term, and the filter counts as empty only where there are no terms (`EntityStringFilterer.java`, `isFilterEmpty`). So a box typed in and cleared drops a row whose every field is blank. |

`filterTerms` gives what Java's `String.split` gives for each: trailing empty strings dropped, an
empty string between two separators kept, for `whitespace-runs` an empty first term where the text
begins with a separator, one empty term for an empty text, and no terms for a text of separators
alone. Today Preview shows every row while the box is empty or holds only whitespace, on both
platforms. That stays true of Web Apps, and of a text of whitespace alone on a phone. What changes is
the one case a phone treats differently: on Android, once the worker has edited the box, Preview runs
an empty text as its one empty term.

`components/preview/shared/listFilter.tsx::rowMatchesFilterText` becomes
`rowsMatchingFilterText(columns, rows, filterText, context, plan, options: { fuzzy: boolean; rules:
PreviewPlatformRules["listFilter"]; edited: boolean; imageReference: ImageReference })`, which
returns the matching rows: in their given order with `fuzzy` off; with `fuzzy` on stably re-sorted
by ascending score over the whole list under `closest-first`, and under `closest-among-ties` within
each run of matches the list's order ties on every rule, each rule's key text compared as the case
store compares it (`lib/preview/engine/caseListFilterFields.ts::caseListOrderTerms`,
`orderTermsTie`). `edited` is whether the worker has changed the box since the list opened; with
`emptyText` `skipped`, or with `edited` false, an empty text returns every row. Among rows the
list's order ties, Preview's order before closeness is the case store's tie-break by case id on
every list, filtered or not (`caseDataBindingHelpers.ts::buildCaseStoreSortKeys`,
`stablePageTieBreaker`), where a runtime's is the order its case database returns, which is the
order of a restore and of local saves and which no read gives Nova. So that order is no claim
Preview makes; closeness among those rows is. Its fields are what a device's entity holds, the
string each field's template evaluates to (`caseListFilterFields.ts::caseListFilterFields`; Core's
`NodeEntityFactory.getEntity` over `Text`'s `string(...)`): each shown column's text, except a link
column's `[text](value)` on both platforms, an image map's `jr://file/commcare/<hash><ext>` path of
the first entry its value holds (from the image's media row, `imageReference`), and a calculated
column's XPath string (`true`, `false`, a date's ISO day); each hidden field's raw value or
calculated string; each carrier's raw value; a multi select's raw value its tokens joined by one
space. `sortText` is the value the field's `CaseListShortField.key` orders by, or `null` where the
field keeps no key: for `property`, the raw value; for `option-label` and `interval-text`, the
column's shown text; for `calculated`, the column's XPath string; for `link-text`, the markdown the link writes
(`[text](value)`, blank for a blank value), which is what the key orders by in the case store
(`buildCaseStoreSortKeys`) and on a device (the column's display expression, the sort's
`calculated` directive), where Web Apps shows a link's wording; for `mapping-position`, the
position text the plan orders by; a carrier's raw value is its own sort text. `components/preview/screens/CaseListScreen.tsx` calls it at
its one filter site with `fuzzy: useDeploymentTargetFacts()?.fuzzyListSearch ?? false`,
`rules: platformRules.listFilter`, `edited` from the one piece of state it holds for the box and
`imageReference` from `components/preview/shared/useImageReference.ts`. The
accent fold applies at every value of the setting: it is Core's rule for the exact match too.

**Grouped tiles.** Groups are drawn only where Preview plays Web Apps
(`lib/preview/platform.ts`, `tileGrouping: "grouped"`). On Android the list is flat
(`"flat"`): commcare-android reads no group, the read takes no grouped path
(`caseDataBindingHelpers.ts::readCases`), and `closest-first` reorders the one list. Nothing below
runs there.

**What Web Apps does, in order.** The client sends the typed text with the request
(`menus/api.js`, `search_text`) and Formplayer builds the list from it in four steps
(`EntityListSubscreen.java`'s constructor calls `EntityScreenHelper.java::initEntities`):

1. `filterEntities` keeps the rows that match, over the whole list.
2. `sortEntities` puts them in the list's own order, a stable sort.
3. `groupEntities` gives each group key the ordinal of its first appearance among those rows and
   sorts by it, also stable. So the groups stand in the order of each one's first match, and a
   group's members keep the list's order. A case with no such connection has the key `""`, a key
   like any other (`NodeEntityFactory.java::getEntity`).
4. `EntityListResponse.java::getEntitiesForCurrentPage` cuts a page that counts group boundaries.

The client then keeps one model per group key, the first, and removes the rest from what it
renders (`views.js::CaseTileGroupedListView.initialize`). That one model draws the heading
(`CaseTileGroupedView.templateContext` reads `this.options.model.get('data')` at the header
indices), every model of the group draws a body row (`getIndexedRowDataList`), and a tap or a
checkbox on the card names that one model's id (`CaseView.rowClick`). Under a filter the first
model of a group is its first match, because no other row reached the client.

So three things follow the filter in Web Apps, and one rule gives all three: **the cards are made
from the rows that remain.** The groups are in the order of each one's first match. A card's
heading is drawn from its first match. Choosing a card, in one-case and several-case lists alike,
chooses its first match.

**Why that is right for the worker and the author.** A worker who types a name to find one visit
sees its group with that visit under the heading, and a tap opens it. Opening the group's first
case in its place, a case the worker filtered away and cannot see on the card, is the worst of
the three differences: Preview then shows an author a journey no worker can take. The filter is
also the only way a worker reaches a case that is not first in its group, so an author checking
that journey in Preview must see it work.

**The rule, ported.** `lib/preview/caseTileGrouping.ts` gains, pure:

```ts
/**
 * One card of a grouped tile list: a group key and the cases the card holds, in the list's
 * order. `rows[0]` is the case the heading is drawn from and the one case choosing the card
 * chooses.
 */
export interface TileGroupCard<Row> {
	readonly key: string;
	readonly rows: readonly [Row, ...Row[]];
}

/** A grouped page as the list's own run of rows: each row in the list's order, and its group. */
export interface GroupedPageRows<Row> {
	readonly rows: readonly Row[];
	readonly keyOf: (row: Row) => string;
}

/** The page's rows put back in the list's own order, each still knowing its group. */
export function groupedPageRows<Row extends { readonly case_id: string }>(page: {
	readonly groups: readonly { readonly key: string; readonly rows: readonly Row[] }[];
	readonly listOrder: readonly string[];
}): GroupedPageRows<Row>;

/**
 * The cards for the rows that remain, given in the list's order: Core's
 * `EntityScreenHelper.groupEntities` (a group's place is its first appearance, its members keep
 * their order) and the client's one model a group (`CaseTileGroupedListView.initialize`).
 */
export function tileGroupCards<Row>(
	rowsInListOrder: readonly Row[],
	keyOf: (row: Row) => string,
): readonly TileGroupCard<Row>[];
```

`tileGroupCards` walks the rows once, in order, and appends each to its key's card, a new key
making a new card at the end. An empty input gives no cards. `groupedPageRows` orders the page's
rows by their place in `listOrder`; it is total: a row `listOrder` does not name sorts after
those it names, in its clustered order, and the store's test holds that there is none.

**The read carries the list's order.** Reordering groups needs the order between two rows of
different groups, which the browser does not hold today. The case store already computes it and
throws it away. `lib/case-store/store.ts::GroupedQueryResult` gains

```ts
/**
 * The page's case ids in the list's own order, the order the rows held before they were
 * clustered. With it a reader can re-cluster whatever a filter leaves of the page.
 */
readonly listOrder: readonly string[];
```

and `lib/case-store/postgres/store.ts::queryGrouped` fills it from the position it already
selects: the page's rows sorted by `ROW_ORDINAL_ALIAS`, each mapped to its `case_id`. The
statement does not change. An empty page gives `[]`. That order is total, since every list read
ends with the case id tie-break (`caseDataBindingHelpers.ts::buildCaseStoreSortKeys`,
`stablePageTieBreaker`). `lib/preview/engine/caseDataBindingTypes.ts::LoadCasesResult`'s `grouped`
slot gains `listOrder: ReadonlyArray<string>`, and `caseDataBindingHelpers.ts::readGroupedCases`
hands it on. `rows` stays the page in clustered order and `groups` stays as it is, so App Tests,
which read `grouped.groups` and have no filter step (`lib/preview/app-tests/run.ts`,
`appTestActionSchema`), see only one more field in a grouped observation's raw result.

**The screen.** `components/preview/screens/CaseListScreen.tsx::CaseListScreen` filters once.
Where the read is grouped it takes `groupedPageRows(groupedResult)`, filters those rows with
`rowsMatchingFilterText` (which, under Web Apps' `closest-among-ties`, returns the matches in the order
given, closest first only among rows the list's order ties), and makes the cards with `tileGroupCards(matches, keyOf)`. With no text the cards are the
store's groups, by the same function. `filteredRows`, which the counts read, is that one list of
matches; the second filter site and the type `ResultsTileGroup` leave. `ResultsTiles` takes
`groups: readonly TileGroupCard<CaseRowWithCalculated>[] | undefined` and reads `card.rows[0]` as
the card's `actionRow`; `chooseVisibleCases` adds each card's `rows[0]`.
`components/preview/shared/CaseTileGroup.tsx::CaseTileGroup` loses its `headerRow` prop and draws
the heading from `rows[0]`, so a heading and a choice cannot name two cases.

| | Web Apps | Android |
|---|---|---|
| A grouped tile list with text in the filter | cards made from the matches: groups in the order of each one's first match, the heading and the choice from that match, a group with no match gone | no groups: one tile a case, filtered and ordered as every list is (`listFilter`) |

Two groups whose first matches the list's order ties stand closest first, as Formplayer's stable
sort leaves them, and in the tie order this section already describes where those matches are
equally close, which is no claim Preview makes with or without a filter.

**What the filter reaches stays as it is.** The filter narrows the page Preview has read, on
every list, grouped or not, and says so on screen where there are more pages ("Filter this page",
"on this page", `runtimeMessages.ts::pageFilterScope`) and in
`content/docs/case-workspace.mdx`. Formplayer filters the whole list before it pages. Within the
page the fix is whole: Preview draws what Web Apps draws for a list of those cases. A list of 50
groups or fewer is one page (`CASE_LIST_PAGE_SIZE`), so it is filtered whole. Preview's page is
its own window and no runtime's: Web Apps' page size is the worker's own setting (`menus/api.js`,
the `cases-per-page-limit` cookie, else 10, or 5 on a small screen). The filter matches the text a
cell shows (a formatted date, a choice's label, a calculated answer), which exists only once the
browser has projected a row, and which rows a page holds is the case store's compiler's decision
alone (the root `CLAUDE.md`, the map entry for `lib/case-store`). A filter that reached other
pages would need every case of the list read and projected on each change of the text. Departure
16 weighs it.

**The worker's sentence stays.** A grouped list says "Choosing a group selects its first case.
The rows beneath are there to read." (`runtimeMessages.ts`, `groupSelection`). Under a filter the
card holds only matches, so its first case is the first case it shows, and the sentence is true
of what is on screen.

**What does not change.** The document, the validator, the emitter and a publish: Nova writes
the same `<group function="string(./index/<identifier>)" header-rows="<n>"/>`
(`lib/commcare/suite/case-list/tileGroup.ts`), and nothing is refused, so no saved app and no app
brought in from CommCare HQ needs a migration. The manifest entry
`menus-and-case-lists/detail-case-tile-group-index-identifier-header-rows` keeps its cells (HELD;
Web Apps runs it, Android ignores it): this fix is what makes Preview's play of the first true
under a filter. The builder's grouping section
(`components/builder/case-list-config/tile/TileGroupingSection.tsx`) and the tool descriptions
(`lib/agent/tools/case-list-config/shared.ts`, `lib/agent/summarizeBlueprint.ts`,
`content/docs/mcp/tools.mdx`) say a group's choice is its first case, which stays true of a card,
so no served schema moves and nothing is sent to the provider. What a person sees change: in
Preview as Web Apps, a filtered grouped list reorders, a card's heading can change with the text
where its heading reads a member's own value, and a tap or a checkbox takes the first match.

**Proof.** The rule is CommCare's, so CommCare's own code holds it, in two places.

A targeted document, `proof/targeted/documents/tileGroupFilter.ts` (`tileGroupFilter`, id
`targeted-tile-group-filter`, `rows: ["a grouped tile list's cards under a filter"]`), listed in
`proof/targeted/index.ts::TARGETED_DOCUMENTS`: case types `household` and `visit` (`parent_type`
`household`); one menu, "Visits", over `visit` with a follow-up form and a tile grouped by `parent`
with one header row; three plain columns of the visit, `seen_by` in the header row, `case_name`
(ordered ascending, priority 0) and `outcome` in the row below. The heading reads a value of the
visit's own on purpose, so the case a heading is drawn from can be told apart. Its restore holds
two households and five visits, each with an id named from the document's (`targeted-ada-visit`
and so on), each visit but Eve with a `parent` index:

| Visit | Household | `seen_by` | `outcome` |
|---|---|---|---|
| Ada | Kijiji | Nurse Amani | Seen |
| Ben | Riverside | Nurse Chiku | Referred |
| Cal | Kijiji | Nurse Baraka | Referred |
| Dot | Riverside | Nurse Dalila | Referred |
| Eve | none | Nurse Imani | Seen |

No name and no `seen_by` holds the letters of "referred", so that text matches on `outcome` alone.

*Core, on every pull request.* Two intent expectations on the local export, each
`session: { command: "m0-f0" }`, as `targeted-tile-hidden-order` writes its own:

| Id | `caseList` | `/caseList/rows/<n>/caseId`, in order |
|---|---|---|
| `grouped-unfiltered` | `{}` | Ada, Cal, Ben, Dot, Eve |
| `grouped-filtered` | `{ searchText: "Referred" }` | Ben, Dot, Cal |

The second order is neither the list's own order of the matches (Ben, Cal, Dot) nor the
unfiltered group order (Cal, Ben, Dot), so it holds the sequence filter, sort, group and nothing
else. The intent check runs it on Core's own `EntityScreen`
(`proof/core/src/nova/proof/core/Evaluate.java::caseList`, which builds the screen with the
search text, and `SessionOp.java::describeList`, which reports `EntityListSubscreen.getEntities`
in Core's order), in the lane every pull request runs.

*The Web Apps client, with the readers.* `proof/webapps/test_tiles.py` gains
`test_web_apps_makes_a_grouped_tiles_cards_from_the_rows_a_search_leaves`, written as
`test_web_apps_lays_out_a_tiles_placed_cells_alone_and_orders_and_searches_by_a_hidden_order_rule`
beside it is: the document released under `maximum`, its restore's cases served
(`casedata.database_of_restore`, which keeps their indices), the list read (`steps.SCREEN`), then
`steps.search_list("Referred")` and the list read again. Contract: before the search the list
holds three cards, `row-targeted-ada-visit`, `row-targeted-ben-visit` and
`row-targeted-eve-visit`, whose first cells read Nurse Amani, Nurse Chiku and Nurse Imani; after
it, two cards, `row-targeted-ben-visit` and then `row-targeted-cal-visit`, whose first cells read
Nurse Chiku and Nurse Baraka, the second holding Cal's row alone. A card's id is the id of the
one model it keeps (`views.js::CaseView.attributes`), which is the model a tap names. Plausible
failures: a client that kept each group's own first case (the second card would be
`row-targeted-ada-visit` under Nurse Amani), groups left in their unfiltered order, and a search
that never reached Formplayer (three cards after it). It is a reader's own test, so it runs in
the lane's scheduled runs with the readers and, before the merge, in Run 4's slice.

The values of both are fixed from the source read above, and one thing of them is unverified: that
`proof/editors/driver/steps/webapps/screen.js` reads a grouped card's cells heading first (it reads
every `.box` of a row in document order, and `tile_grouped_item.html` writes the heading's boxes
before the body rows'). A value CommCare gives differently means this section misread CommCare:
`tileGroupCards`, its vectors and the smoke step then follow what CommCare gave, in this step
(Run 4).

**The asterisk on required questions.** Web Apps marks every required question, whatever the
setting: its question template binds the class `required` on every question
(`cloudcare/templates/cloudcare/partials/form_entry/question.html`), and neither Formplayer nor the
client reads `cc-label-required-questions-with-asterisk`. Android appends the mark only where the
app's profile holds the setting as `yes` (`views/widgets/QuestionWidget.java::setTextFromPrompt`,
`preferences/HiddenPreferences.java::shouldLabelRequiredQuestionsWithAsterisk`, whose default is
`no`). Nova's own value is `no` (`lib/commcare/appProfileSettings.ts`), so on a phone running an app
Nova made, no required question carries a mark until the worker tries to move past it. Preview
marks every required question on both platforms today, so on Android it draws something a phone
does not. `PreviewPlatformRules` gains a second rule, and `lib/preview/platform.ts` one pure
function:

```ts
/**
 * Whether a required question carries the asterisk. Web Apps marks every one
 * (`form_entry/question.html`, the `required` class); Android only where the profile's
 * `cc-label-required-questions-with-asterisk` is `yes`
 * (`QuestionWidget.java::setTextFromPrompt`).
 */
readonly requiredMark: "always" | "by-setting";

/** Whether Preview draws the mark on a required question. */
export function requiredMarkShown(
	rule: PreviewPlatformRules["requiredMark"],
	/** The reached project space's setting, or null where Preview holds no facts. */
	settingOn: boolean | null,
): boolean;
```

`always` for Web Apps and `by-setting` for Android. `requiredMarkShown` is true under `always`, and
under `by-setting` exactly where `settingOn` is true. With no facts it answers by Nova's own value,
`no`: Preview on Android shows no mark, as a phone running a Nova-made app does. An app brought in
whose project space holds no value shows none either, which is the phone's own default.

`components/preview/form/InteractiveFormRenderer.tsx` draws the asterisk and the word a screen reader
reads for it (`runtimeMessages.ts`, `requiredLabel`) together, at both of its sites, where
`state.required && requiredMarkShown(rules.requiredMark,
useDeploymentTargetFacts()?.markRequiredQuestions ?? null)`. What required means does not change: a
worker who moves past an unanswered required question is stopped and told, on both platforms. Two marks
stay as they are, because neither is a platform's drawing of a form question: the builder's canvas marks
a required question in edit mode (`components/preview/form/virtual/rows/FieldRow.tsx`), which is the
builder's own sign of the setting, and a required Search field keeps its mark
(`components/preview/shared/SearchInputForm.tsx`), which the setting's one reader, the question widget,
never draws.

**How the facts reach Preview.** They travel the way `commcare_project` does, as the server's
resolution, never a client's claim. The page load seeds them, and a stream frame keeps them current.
The frame is there for an open tab: a publish or a refresh, the tab's own or another member's,
changes what the project space holds while the builder is open, and without the frame Preview would
go on playing the settings as of the page load until someone reloaded.

- `lib/deployment/previewTarget.ts` gains
  `resolvePreviewFactsTarget(deployments: readonly Pick<DeploymentRecord, "state" | "resumePhase" |
  "server" | "domain">[]): DeploymentTargetKey | null`: the one `(server, domain)` among the
  deployments that display as uploaded, or `null` for none or several. It de-dupes on both, where the
  project-space name de-dupes on the domain alone, because the facts are one deployment's.
- `lib/deployment/types.ts` gains `PreviewDeploymentAnswer = { projectSpace: string | null;
  targetFacts: PreviewTargetFacts | null }`, and `lib/deployment/previewSpace.ts` gains
  `readPreviewDeploymentAnswer(scope): Promise<PreviewDeploymentAnswer>`, which reads the records once
  (`readDeploymentPreviewRecords`), names the project space from them as `previewProjectSpaceFor` does,
  resolves the facts target, calls `readTargetFacts`, and gives `targetFacts` as `{ fuzzyListSearch:
  facts.profileProperties["cc-fuzzy-search-enabled"] === "yes", markRequiredQuestions:
  facts.profileProperties["cc-label-required-questions-with-asterisk"] === "yes" }`. A fault throws:
  `null` is an answer (Preview names nothing and plays Nova's own values), so a failed read must never
  be sent as one. `previewDeploymentAnswerFor(scope): Promise<PreviewDeploymentAnswer | null>` gives
  `null` for a fault with one `log.warn`, for the callers that must not fail with it: the page's seed
  and the answer to a publish or a refresh whose write has landed.
- `lib/collab/previewTargetFactsFrame.ts` (new) holds the wire contract of a second frame:

  ```ts
  export const previewTargetFactsSchema = z.strictObject({
  	fuzzyListSearch: z.boolean(),
  	markRequiredQuestions: z.boolean(),
  });
  export type PreviewTargetFacts = z.infer<typeof previewTargetFactsSchema>;
  export const previewTargetFactsFrameSchema = z.strictObject({
  	facts: previewTargetFactsSchema.nullable(),
  });
  export type PreviewTargetFactsFrame = z.infer<typeof previewTargetFactsFrameSchema>;
  /** One SSE data payload; a malformed frame gives null and the held value stays. */
  export function parsePreviewTargetFactsFrame(data: string): PreviewTargetFactsFrame | null;
  ```

  A new frame name, not a new key on `preview-project-space`: that frame's schema is strict, so a tab
  still running the build from before the deploy would drop a widened frame whole and lose
  `commcare_project` with it, where it simply does not listen for a name it does not know.
- `app/api/apps/[id]/stream/route.ts`'s deployment lane resolves both in one run through
  `readPreviewDeploymentAnswer` and sends `preview-target-facts` when the canonical JSON of the facts
  differs from what it last announced, the connect-time emit included. A read that faults throws out of
  the run, so the pump retries it with its backoff and neither frame is sent. No new route, so no
  hostname allowlist entry.
- `lib/collab/ReconcilerProvider.tsx` gains `subscribePreviewTargetFacts`, beside
  `subscribePreviewProjectSpace` and with its shape, and `lib/collab/context.ts` declares it on the
  collaboration context: `subscribePreviewTargetFacts: (cb: (facts: PreviewTargetFacts | null) => void)
  => () => void`, the held latest value replayed at once to a late subscriber.
  `components/builder/DeploymentTargetProvider.tsx` takes the prop
  `initialTargetFacts: PreviewTargetFacts | null`, holds the value, subscribes, and exports
  `useDeploymentTargetFacts(): PreviewTargetFacts | null` and
  `useSetDeploymentTargetFacts(): (facts: PreviewTargetFacts | null) => void`, as it does for the
  project space. `components/builder/BuilderProvider.tsx` takes
  `initialTargetFacts?: PreviewTargetFacts | null` beside `initialProjectSpace` and hands it on.
- `app/(app)/build/[id]/[[...path]]/page.tsx` starts `previewDeploymentAnswerFor` and seeds the
  provider through `BuilderProvider`; a `null` answer seeds Nova's own values, which the stream's
  connect-time read then replaces.
- A publish and a Check status hand the own tab the answer without waiting for the stream:
  `lib/deployment/actions.ts::RefreshedDeploymentView` carries `readonly preview:
  PreviewDeploymentAnswer | null` in place of a project space of its own, and
  `app/api/commcare/upload/route.ts`'s response gains `preview_target_facts` (the same object, or
  `null`) beside `preview_project_space`, both left out where `previewDeploymentAnswerFor` gave `null`.
  `components/builder/publishOutcome.ts` parses them as `preview`, `null` where both are absent and one
  half alone reading the other as `null`. `PublishDialogBody.tsx` and `app-setup/PublishingSection.tsx`
  apply it through `DeploymentTargetProvider::useApplyPreviewDeploymentAnswer`, which leaves the held
  values as they are for `null`: the write that answered poked the stream's lane, which brings the
  answer.

With no facts (no reached project space, several, or an unread baseline) Preview plays what a new
project space would give: an exact filter and, on Android, no mark, which are Nova's own values `no`.

### 6.5 The Publishing card: the list, its date, and the refresh

`lib/deployment/actions.ts::DeploymentView` (what `readDeploymentsAction` and the refresh actions
return for each record) gains
`readonly kept: DeploymentKept | null`, `DeploymentKept` being `{ readonly labels: readonly
KeptLabelId[]; readonly valuesDigest: string; readonly observedAt: string }` (9.4 says what the digest
is for), filled from `readTargetFacts` for each reached deployment and `null` elsewhere (no baseline,
an unread one, a shell). One function fills it, `service.ts::deploymentKept`, which every surface that
answers with a record calls: the actions, `app/api/commcare/upload/route.ts` (the publish response's
`kept`, which `components/builder/publishOutcome.ts` parses, absent reading `null`, so the landed card
and the section's upserted record carry it), and MCP's `describeDeployment`, which takes it as its third
argument for every deployment-bearing tool result. The two answers to a publish read it through
`service.ts::landedDeploymentKept`, which logs a fault and answers `unread`, and the answer then leaves
`kept` out: a store fault after the import must not turn a publish that landed into "Upload failed",
which sends the person to publish again, and the Publishing section reads the records again after
every publish. `components/builder/DeploymentStatus.tsx` draws the block under the record's rungs
wherever `kept` is not `null`: with labels, the lead sentence with its date and the labels as a list;
with none, the one sentence that says so with its date (9.4); and in both, where `canRefresh` is true,
the button **Refresh from CommCare HQ**. An empty list still draws, because it is where a person asks
Nova to look again after changing a setting in CommCare HQ: a project space that held every default at
the last publish would otherwise have no way to tell Preview that fuzzy search is now on. The compact
rows of the publish dialog do not draw it. The refresh's in-flight state and its outcome sentence are
held where Check status holds its own, in `DeploymentStatus.tsx` (its `useTransition` and one
`useState` of the sentence). `app-setup/publishingSectionModel.ts` does not change:
`applyRecordUpsert` carries a refreshed view whole, `kept` with it.

The date is always the baseline's own `observed_at`, and one sentence words it whatever wrote the
baseline: "as it held them on {date}". A baseline's origin does not say when it was read (a refresh
keeps the origin and moves the date), so no sentence here names a publish or a bringing in. The date
is the viewer's locale date, with the year where it is not the current year.

**The refresh.** Nova reads a project space's kept values only when it reads the app's source, which
today is at a publish. A person who turns fuzzy search or the asterisk on in CommCare HQ, rewords a
screen or sets a custom base URL would otherwise wait for the next publish before Preview and a
downloaded `.ccz` follow it, and publishing an app is the wrong way to read a setting. The refresh is
that read without a publish. `lib/deployment/service.ts` gains:

```ts
export type KeptRefreshOutcome =
	| { readonly kind: "refreshed"; readonly deployment: DeploymentWithResources }
	/** Something Nova publishes differs from the baseline. Nothing is written. */
	| { readonly kind: "changed-in-hq" }
	/** A publish, or another refresh that read something else, replaced the baseline while CommCare HQ was being read. Nothing is written. */
	| { readonly kind: "superseded"; readonly deployment: DeploymentWithResources }
	| { readonly kind: "no-baseline" }
	| { readonly kind: "app-gone" }
	/** CommCare HQ answered with something that is no app Nova can read. */
	| { readonly kind: "unreadable" }
	/** The app's source is larger than Nova reads, on every attempt. */
	| { readonly kind: "too-large" }
	/** CommCare HQ answered with a page meant for a person: a sign-in another way, or an inactive project space. */
	| { readonly kind: "browser-only" }
	/** CommCare HQ did not accept the stored key for this read. */
	| { readonly kind: "key-not-accepted" }
	/** CommCare HQ turned the account away for this read. */
	| { readonly kind: "no-permission" }
	| { readonly kind: "unavailable" };

export async function refreshKeptValues(
	scope: DeploymentScope,
	target: DeploymentTargetKey,
): Promise<KeptRefreshOutcome>;
```

It authorizes `edit`, as Check status does: it writes the ledger and reads CommCare HQ with the acting
member's own key. Every outcome but `refreshed` writes nothing. In order:

1. Read the deployment (`readDeployment`) and the stored baseline (`readAppBaseline`). No live `app`
   mapping, an absent, `unread` or `create` baseline, or a baseline whose `remoteAppId` is not the
   live mapping's remote id answers `no-baseline`.
2. The caller's own connection, checked exactly as `refreshDeployment` checks it and raised the same
   way, as a `DeploymentError` that reaches no stored record: no key (`hq_not_connected`), a key that
   does not reach the project space (`domain_not_authorized`), a key on another server
   (`assertCredentialsMatchServer`, `invalid`). The three sentences are in 9.4.
3. Take `observedAt = new Date().toISOString()`, before the request is sent.
4. Read the app's source (`hq/appSource.ts::readHqAppSource`) for the mapping's remote id. `gone`
   answers `app-gone`. `unsupported`, and a failure whose `cause` is `malformed`, answer `unreadable`.
   Any other failure is chosen by `classifyHqFailure(error, "app-source").kind`, by the rule part
   05 gives its source read ladder (`05-reading-commcare-hq.md`, section 12): `key-not-accepted`
   answers `key-not-accepted`; `not-a-member` and `permission` answer `no-permission`, as do
   `plan-lacks-api-access` and `api-cut-off`, which the source read cannot give
   (`views/apps.py::app_source` runs `api_auth` and `require_can_edit_apps`, with no plan check and
   no cut-off check, so its 401 is the key alone); `answer-unreadable` answers `unreadable`;
   `too-large` answers `too-large` and `browser-only` answers `browser-only`, since each gives the same
   answer on every attempt and must not be worded as a read that may work in a moment; every other kind
   answers `unavailable`.
5. Normalize it (`normalizeHqAppSource` over the read's `raw`); `{ malformed }` answers `unreadable`.
6. Compare it with the baseline by the publish's own comparison, `diffHqAppSource({ baseline, current,
   ownership, shell: false, schemaDefault, mediaChanged })`, with `mediaChanged` part 15's
   `movedRecordedPaths(baseline.mediaFiles, source.multimediaMap ?? [])` over the read of step 4
   (`15-changes-made-in-commcare-hq.md`, section 7.5): the count of recorded files whose id moved,
   read from the map with no file fetched. Any part answers `changed-in-hq`.
7. No part: write through the new store writer below. `current` answers `refreshed`, and `superseded`
   answers `superseded`, each with the deployment as it now stands.

`lib/deployment/store.ts` gains the writer, because `withDeploymentRow` and `writeAppBaseline` are
private to the store and every store write notifies in its own transaction:

```ts
/** Replace a deployment's app baseline with a fresh read that compared equal to it. */
export async function recordRefreshedAppBaseline(
	scope: DeploymentScope,
	target: DeploymentTargetKey,
	input: {
		readonly remoteAppId: string;
		/** The `sourceDigest` of the baseline the read was compared with. */
		readonly comparedDigest: string;
		/** The fresh read: gzip, bytes, digest and `observedAt`. */
		readonly read: Pick<
			AppBaselineWrite,
			"sourceGzip" | "sourceBytes" | "sourceDigest" | "observedAt"
		>;
		/** Part 15's: the list the next publish shows (its section 4.4). Absent: the stored one stays. */
		readonly firstPublish?: StoredFirstPublish;
		/** Part 15's: the media record with an id a review learned (its section 7.8). Absent: it stays. */
		readonly mediaFiles?: HqMediaRecord;
	},
): Promise<{
	readonly outcome: "current" | "superseded";
	readonly deployment: DeploymentWithResources;
}>;
```

Inside `withDeploymentRow(scope, target, { ensure: false }, …)`, which locks the app row and takes the
deployment row `FOR UPDATE`, it selects the stored baseline's `remote_app_id`, `origin`,
`source_digest`, `ownership`, `nova_revision` and `observed_at`. Where the row is gone, its
`remote_app_id` is not `input.remoteAppId`, its origin is `unread` or `create`, or the live `app`
mapping no longer names that remote id, it writes nothing and answers `superseded`. Where its digest is
the read's own `sourceDigest`, the row already holds what the read saw (another refresh that read the
same landed first, or a publish whose read-back is this read): it answers `current`, and writes only
where the read's `observedAt` is the later, which moves the date and nothing else. So two refreshes of
an unchanged project space both answer `refreshed`, whichever lands first. Otherwise, where its digest
is not `comparedDigest` or its `observed_at` is later than the read's `observedAt`, it writes nothing
and answers `superseded`: a newer read that differs, a publish's or another refresh's. Otherwise it
calls
`writeAppBaseline` with the stored origin, ownership and `nova_revision`, the read, `discard: null`
(which keeps a stored discard record), and `keep` for the media record and the first-publish list
unless the input carries one (part 15, sections 3, 4.4 and 7.8), calls
`notifyAppDeployments(tx, scope.appId)` so every open tab's Preview follows, and answers `current`.
The stored origin is kept because it says how the app came to be there, which a refresh does not
change; `types.ts::AppBaselineWrite.origin` is `"create" | "push" | "unread"` today, so this writer
widens it with `"cutover"`, and part 10 with `"read"` and `"changes"` (its section 6.3). The writer
takes `expectedEndings` as the other baseline writers do (part 10, `10-identity-and-the-ledger.md`,
section 8.5).

**Why no stale read can land.** A publish writes its read-back baseline under the same row lock
(`recordRemoteResource`), so the digest test and the write are one step against it: where a publish
landed while HQ was answering the refresh, the stored digest is that publish's, the test fails, and
the refresh's read, which may predate the publish's import, is dropped. `observedAt` is taken before
the request for the second guard, the date test, which is also `writeAppBaseline`'s own
(`existing.observed_at <= EXCLUDED.observed_at`): a publish stamps its read-back after its import has
answered (`service.ts::appBaselineFor`), so a read stamped before it was asked for never carries a
later date than a publish that imported after that stamp, whichever answer arrived first. That covers
the one case the digest cannot, a publish whose read-back equals the old baseline byte for byte.
Stamping the read when its answer arrives would let a slow answer outdate a publish that finished
meanwhile, and the next publish would then stop with `hq_changed` over Nova's own push.

Part 15's `peekHqAppChanged` is steps 1 to 6 of `refreshKeptValues` with no step 7, for its check
when the builder opens (its section 8.1), and its bring-in is the second caller of this writer, for
a review that answered `nothing` with the reason `reads-the-same` (its section 4.4).

Why the whole baseline and not a splice of the kept keys: a baseline must stay one read of HQ, with one
date. Replacing it only where nothing Nova writes has moved changes no later drift verdict (the
comparison that would run at the next publish has just run and found nothing). Where something Nova
writes has changed in HQ, the kept list keeps its date and the card says why, with a button that
shows what changed (part 15, section 9.6).

`lib/deployment/actions.ts` gains the action, which returns the outcome with the refreshed view
where the outcome carries a deployment:

```ts
/** A kept refresh's outcome as the card reads it. */
export type KeptRefreshView =
	| {
			readonly kind: "refreshed" | "superseded";
			/** With `previewProjectSpace` and `previewTargetFacts`, as Check status returns them. */
			readonly deployment: RefreshedDeploymentView;
	  }
	| {
			readonly kind:
				| "changed-in-hq" | "no-baseline" | "app-gone" | "unreadable" | "too-large"
				| "browser-only" | "key-not-accepted" | "no-permission" | "unavailable";
	  };

export async function refreshKeptValuesAction(input: {
	readonly appId: string;
	readonly server: CommCareServer;
	readonly domain: string;
}): Promise<DeploymentActionResult<KeptRefreshView>>;
```

A `DeploymentError` of step 2 is the action's `success: false` arm, as Check status's is. MCP's
`refresh_deployment` (`lib/mcp/tools/deploymentTools.ts`) gains the boolean input `kept_values`
(description in section 9); with it true the tool calls `refreshKeptValues` and returns the outcome's
sentence (9.4) and, when the outcome carries a deployment, the deployment projection. That projection
(`lib/mcp/tools/deploymentProjection.ts`) gains
`kept: { labels: string[]; observed_at: string } | null`: each label an id worded through
`lib/publish/keptValues.ts::KEPT_LABELS`, in `keptListFor`'s order, `observed_at` the baseline's
`observedAt` as stored (an ISO 8601 instant), and `null` where `DeploymentView.kept` is `null`.
`get_deployment` returns the same field.
A `DeploymentError` of step 2 reaches a client as the tool's error with its sentence, as Check
status's does. Scope: `nova.hq.write`, which `refresh_deployment` declares today through
`lib/mcp/scopes.ts::oauthScopeChallenge` (`SCOPES.hqWrite`), since both arms write the ledger.

---

## 7. Four rules beside the kept test

### 7.1 A generated key in `translations`

HQ writes a string for each id its patterns name (`id_strings.py::REGEXES`; the surface's
`app-string-id:` family) from the app's own fields, and a non-empty value stored under that id in
`translations` replaces it at runtime (4.4). Nova never carries such a key
(`appStringKeys.ts::translationKeyOwner`, `generated`), so it can never be kept: a publish removes it,
and the worker would see the field's text again. Three entries join
`schema:Application.translations`, and one is re-worded:

| Entry | Disposition | Value class | `item` |
|---|---|---|---|
| `application-and-settings/translations-generated-key-with-no-effect` | INERT | `generated-key-no-effect` | a key matching a generated pattern, in a language, whose value is blank, or names no string of this app, or equals the text the app's own fields give that string in that language |
| `application-and-settings/translations-generated-key-over-one-text` | HELD | `generated-key-folded` | any other such key whose string comes from one authored text, where every string that text feeds in that language holds the same override: read as that text's wording in that language |
| `application-and-settings/translations-generated-key-anything-else` | HELD-NEW, `subject: "translation-overrides"`, `owner: "settings-nova-comes-to-own"` | `generated-key-other` | any other such key: an override of a string Nova writes from a constant or derives, or of one string of a text that feeds several |
| `application-and-settings/translations-key-no-runtime-reads` (existing, INERT) | unchanged | unchanged | gains "a key no generated pattern and no runtime catalog names" |

The classifier part 06 implements (`06-the-reader-forms.md`, section 16.5), stated here so no other
part decides it. Every reading drafts a provisional document, and a generated key is classified in the
same reading against the app strings that draft gives. Let `D0` be that draft read without any
generated key, and `T0` its local app strings by language with each string's source (`compileCcz`
builds exactly this map: `appStrings` and `appStringUnits`, id to constant or to translation unit).
For each language `L`, key `K` matching a generated pattern, and value `V`:

1. `V` is blank: inert (`non_empty_only` drops it).
2. `K` is no id of `T0`: inert (HQ generates no such string for this app, so no suite names it).
3. `V` equals `T0[L][K]`: inert.
4. `K`'s source in `T0` is a translation unit `U`, and for every id `K'` that `U` feeds, the stored
   value of `K'` in `L` is `V` too (or `K'` is `K`): held. The reader sets `U`'s text in `L` to `V`,
   once.
5. Otherwise: not-yet, with `detail.name` the key.

Two limits stand, and part 06 says which finding a key stands under in each
(`06-the-reader-forms.md`, section 16.5, steps 1 and 3). A key is not classified where what it names
did not read whole: its language could not be named, its menu or form got no draft, or a finding
stands at its menu, its case list, its case detail, its search or its form. And no key is classified
where Nova's own build cannot write the provisional document, because that document leans on
something a finding withheld. They are the two limits the account's last line names (9.1).

Rules 2 to 4 read Nova's local app strings for `D0` as if they were HQ's. That holds only where the
two builds name the same strings: among ids that match a generated pattern, the set HQ's build writes
for the app equals the set the local archive writes for `D0`. Where HQ's build held such an id Nova
spells another way or does not write, rule 2 would call an override of it inert while HQ's build
applied it. So the equality is a stated precondition of the classifier, held by proof 2 on every
HQ-authored base (the generated ids of each `app_strings.txt` of HQ's build against the local
archive's, per language), which part 14 carries (`14-proof.md`, section 4). An id on one side alone
is a failure of that proof, fixed in the emitter or by a new entry, never classified around.

Languages of `translations` the app does not have are skipped: HQ builds no strings for them. Rule 4's
"once" is what makes the fixed point hold: Nova's emission of the folded document gives `V` for every
id `U` feeds, a re-reading meets no generated key, and the document is unchanged. In HQ the menu's or
form's own name field then shows the override's wording, where before it showed the field's, and the
`translations` key is gone; no runtime shows a different word. That is one first-publish change
(`translation-overrides-folded`, no worker impact), an entry of part 09's register
(`09-acceptance-and-the-first-publish.md`, section 11.2).

`homescreen.title` and `app.display.name` keep their own entries: they are generated patterns Nova does
write.

### 7.2 A language's display name

HQ's build names an app's languages in one table only, the `default` one: for each language of the
build it writes its registry's name for the code (`langcodes.get_name`, or the code itself), put into
that language's own tongue (`localize(letter_code)` with `gettext`, or `CUSTOM_LANGUAGE_NAMES`)
(`app_strings.py::_create_custom_app_strings`, the `for_default` branch). A language's own table
holds a name only where `translations[lang]` stores a non-empty one under a language's code, which
then also wins in `default` for the default language (4.4). Android's language picker shows the
names; Web Apps names languages itself. Nova differs in two ways. A publish writes Nova's own label
for every language (`projectTranslationsForTarget`, which classes a language's code as
`language-name` and writes Nova's value over it), and the local archive writes a name for every
language into every table, not `default` alone (`compiler.ts::compileCcz`, `table[code] =
localization.languageName(code)`). On an app Nova brought in, the first would replace HQ's name, or
the name a person typed, wherever the two differ.

So on a deployment whose app mapping is `adopted` (part 10, `10-identity-and-the-ledger.md`, section
6.3), a language's display name is CommCare HQ's:

- `targetOverlay.ts::projectTranslationsForTarget(application, current, options)` gains
  `options: { readonly languageNames: "nova" | "target" }`. With `"target"` a key that is a language's
  code is carried as the target holds it and Nova's value for it is not written; an absent one stays
  absent. `projectApplicationForTarget` takes the same option, and
  `lib/deployment/importApplication.ts::hqImportApplication` passes
  `HqImportApplicationInput.languageNames`, which `publishAppToHq` sets to `"target"` exactly where
  the mapping it updates in place is `adopted`, and to `"nova"` otherwise (part 10, section 6.3).
- `hqSourceBaseline.ts::ownedTranslations` takes the same option, so the drift comparison stops
  reading language names on an adopted deployment: they are the project space's there.
- `TargetFacts.languageNames` (6.1) carries the names: `null` on a deployment Nova created, and on an
  adopted one, per language of the source, each language code that language's `translations` entry
  holds a non-empty name for. `adopted` reaches `targetFactsFromSource` as its input, which
  `targetFactsFromBaseline` takes as its second argument from the live app mapping's ownership.
- `compileCcz` writes `table[code] = facts.languageNames[language]?.[code] ??
  localization.languageName(code)` where `facts.languageNames` is not `null`. Where HQ holds no name,
  the archive writes Nova's label, in every table, and HQ's build writes its registry's name in the
  language's own tongue, in `default` alone. Nova cannot compute HQ's registry name, so the row states
  the difference where it cannot mirror: the advisory says what a person would see, that the language
  picker may name a language differently (9.5), which is true of both differences.
- The entry `application-and-settings/translations-lang-code-any-other-value-or-absent-where-hq-s`
  becomes TARGET-OWNED: "**TARGET-OWNED**: on a project space Nova brought the app in from, a
  language's display name is CommCare HQ's: a name it holds is carried and an absent one stays absent
  (`projectTranslationsForTarget`, `languageNames: \"target\"`). Where Nova created the HQ app it writes
  its own label, which is the HELD row above". Its `KEPT_AT_HQ` row is in section 5's table: kind
  `setting`, label "Language names", `.ccz` `mirrors` (`compileCcz`) with the advisory
  `kept_language_names_differ` for a name HQ holds none of, Preview `no-claim` ("the language menu is
  Nova's own control"), another project space `seeds` Nova's label, base `hq-kept-settings`. The entry
  ends the step with no subject (3.8), so no subject names a language's display name. A reading
  claims a name under it as kept: the claim is part 06's application walker's
  (`06-the-reader-forms.md`, section 6.5).
- The advisory `kept_language_names_differ` (6.3) is shown where `KeptAdvisoryFacts.languageNames`
  is true: `facts.languageNames` is not `null` and some app language's table lacks a held name for
  some app language's code. Its copy is in 9.5.

### 7.3 The fifteen settings on an app Nova brought in

`projectProfileForTarget` writes each of the fifteen seeded settings where the project space holds no
value (`holdsNoValue`: absent, or a value `hqProfileValueText` reads as none, which is `null`, `""`,
`false`, `0` or no value a setting holds, as `create_profile`'s `if setting_value:` writes nothing for
it), and all but the map layer are written forced. The overlay and `targetFactsFromSource` read a
value by the one function, so a stored `false` is seeded over, and the archive's seed is then what
the project space holds. For an
absent key HQ's build writes nothing (`Application.create_profile`; none of the fifteen carries a
`commcare_default`), so a phone reads its own default and keeps whatever the worker chose. After a
seed, the profile forces the value at every update. The value is the same one a device reads for an
absent key; what changes is that a worker's own choice of fuzzy search, automatic updates or text to
speech returns to it (`appProfileSettings.ts`, its header). On an app Nova created that has been
Nova's stated behavior from its first publish. On an app made in HQ it would be a change the first
publish makes to workers' phones, and the bar's clause (b) admits such a change only declared. This
plan reads the original's behavior exactly wherever it can and declares a change only where it
cannot: of the three answers part 09 gives each candidate change (read exactly, refuse, declare;
`09-acceptance-and-the-first-publish.md`, section 11.4), it takes the first wherever it is open, and
here that costs nothing: Nova leaves the key absent.

So on a deployment whose app mapping is `adopted`:

- `targetOverlay.ts::projectProfileForTarget(application, current, targetState, options)` gains
  `options: { readonly seeds: "nova" | "target" }`. With `"target"` a seeded key is written only where
  the target holds a value, which is to say never by Nova: the target's own value is carried and a
  key it holds no value for is left as it is, absent or a value `hqProfileValueText` reads as none. The two owned settings are
  written either way. `projectApplicationForTarget` takes the option beside `languageNames` (7.2), and
  `hqImportApplication` passes `HqImportApplicationInput.seeds`, which `publishAppToHq` sets to
  `"target"` exactly where the mapping it updates in place is `adopted` (part 10, section 6.3).
- The ownership descriptor does not change: it names the two owned settings alone
  (`OWNED_PROFILE_PROPERTY_KEYS`), so the drift comparison already reads none of the fifteen.
- `TargetFacts.seeds` (6.1) is `"target"` on an adopted deployment and `"nova"` otherwise.
  `keptProfile.ts::targetProfileProperties` writes a seeded setting the facts hold no value for at
  Nova's seed where `seeds` is `"nova"`, and leaves it out where it is `"target"`, so the archive and
  HQ's build of an adopted deployment state one profile. With `facts` `null` it returns
  `appProfileProperties(doc)`: no facts means no reached deployment was read.
- The fifteen entries' cells (3.6) gain: "On a project space Nova brought the app in from, a publish
  writes none of them: a setting it holds no value for stays absent (`projectProfileForTarget`,
  `seeds: \"target\"`)". Their `KEPT_AT_HQ` rows are unchanged: another project space is a deployment
  Nova creates, which is seeded.
- `keptListFor` is unchanged: an absent setting is no value that differs from a new app's.
- Run 3 ("Written and not yet run") holds this on HQ's real build. `keptProfile.test.ts`'s property
  (section 10) runs under both values of the option.

An adopted deployment stays `adopted` across publishes (part 10, section 7.1), so the rule does
not lapse after the first one. A person who wants one of the fifteen set on such an app sets it on
the app's Settings page in CommCare HQ, where it is kept.

### 7.4 A build profile that names a language the app no longer has

A build profile is CommCare HQ's name for a set of an app's languages that one group of phones
installs (`models/applications.py::BuildProfile`: `name`, `langs`, `practice_mobile_worker_id`). HQ's
own page calls it an application profile (the Application Profiles tab of the app's Releases page,
`templates/app_manager/partials/releases/releases.html`), so every sentence a person reads here says
"application profile". Profiles need the `build_profiles` plan privilege, first in the Advanced plan
(`accounting/bootstrap/features.py::advanced_v0`).

**What happens today.** A person with that privilege adds a profile to an app Nova published, on
that tab (`views/releases.py::LanguageProfilesView.post`, which replaces `app.build_profiles` whole
with what the page posts). Later an author removes one of the profile's languages in Nova, or relabels
the one language of a single-language app:

- `lib/doc/mutations/app.ts`, the `removeLanguage` arm, takes the tag out of
  `localization.languageOrder`, `translations` and `wireCodes`. The `relabelSourceLanguage` arm
  replaces the one language and its wire code. Neither knows a project space exists, and neither
  should: the document belongs to no target.
- The next publish writes `langs` from the document
  (`lib/commcare/expander.ts::appLevelValues`, `langs: [...localization.languages]`, the codes
  `lib/commcare/languageWire.ts::planLanguageWire` reads from `wireCodes`), and never writes
  `build_profiles`: the body does not carry the key, and HQ's update would drop it if it did
  (`models/applications.py::_merge_source_into_app` leaves out every key of
  `ApplicationBase._update_excluded_fields`, which lists `build_profiles`).
  `lib/commcare/targetOverlay.ts::projectApplicationForTarget` projects only `translations`,
  `add_ons` and `profile`, and `projectTranslationsForTarget` already drops the name of a language
  the app no longer has. Nothing reads the profiles.
- So after the publish HQ's app holds `langs` without the language and a profile that still names
  it. HQ's own Languages page never leaves that state: it takes a deleted language out of every
  profile in the same save (`views/apps.py::edit_app_langs`, the loop over `app.build_profiles`).
- The drift check does not see it either. `lib/deployment/hqSourceBaseline.ts::ownedProjection`
  compares only what Nova writes, and `build_profiles` is not among it.

**What HQ then does with that profile.** Every file of a profile's build is made from the profile's
own `langs` (`models/applications.py::ApplicationBase.get_build_langs`), by
`Application.create_all_files(build_profile_id)`, which HQ runs for each profile when a build is
released (`views/releases.py::release_build`, `tasks.py::create_build_files_for_all_app_profiles`)
and again when a phone asks for a file the build does not hold yet
(`views/download.py::download_file`).

- *The profile still names a language the app has.* Each form keeps its other translations
  (`xform.py::XForm.exclude_languages` removes only what the profile does not name), and the build
  succeeds. But the suite carries a locale resource for the removed code
  (`suite_xml/sections/resources.py::LocaleResourceContributor`), the default strings carry its
  name (`app_strings.py::_create_custom_app_strings`, the loop over `ccz_langs`), and its
  `app_strings.txt` is filled from the app's other languages (`clean_trans` over
  `[lang] + app.langs`). A phone lists every locale its suite installs
  (commcare-core `resources/model/installers/LocaleFileInstaller.java`,
  commcare-android `utils/ChangeLocaleUtil.java::getLocaleCodes`), so a worker on that profile is
  offered a language the author removed, and choosing it shows the app in another language. Where
  the removed language is the profile's first, the profile's `cur_locale` is that code
  (`Application.create_profile`, `locale = self.get_build_langs(build_profile_id)[0]`) and no
  translation of any form is marked default (`XForm.set_default_language`); Core then takes the
  form's first translation as its default (commcare-core
  `xform/parse/XFormParser.java`, `l.setDefaultLocale(l.getAvailableLocales()[0])`).
- *The profile names no language the app has.* `exclude_languages` removes every translation of
  every form and raises `XFormException` ("Form does not contain any translations for any of the
  build languages"), so HQ cannot make that profile's files at all. The lane shows this every run:
  the fixed entry `d1-language-codes-build-profile-raised` on the control `targeted-hq-side-state`
  holds exactly this raise, from the time a code Nova renamed left a profile naming none of the
  app's languages. What a phone installed from that profile shows when its update finds no files is
  unverified: no reader in the lane installs a profile's build.

**Why the fix is a stop, and where.** The right end state is the one HQ's Languages page makes: the
removed language gone from every profile. Nova cannot make it. No request an API key can send
writes `build_profiles`: the import's update leaves the key out (above), and the two views that do
write it, `LanguageProfilesView.post` and `edit_app_langs`, take a signed-in browser session
(`app_manager/decorators.py::require_can_edit_apps` is `require_permission` with its default
`login_and_domain_required`, where the import is `login_decorator=api_auth()`). What Nova can do is
never produce the state. A publish reads the app's source before it writes anything, and that read
carries the profiles (`views/apps.py::app_source` serves `export_json`, which holds every declared
property; all forty retained reads under `proof/hq-reads/` hold `build_profiles`). So a publish
that would leave a profile naming a language the published app does not have stops before it sends
anything, names the profile and the language, and says where the person changes it. The stop is a
blocking edge, not a line in the setup artifact: the profile is easiest to change before the
publish, while HQ's page still offers the language, and an instruction read after the fact would
leave the bad build in place until someone followed it.

It is not a rule of the commit gate, and no validator code is added. Removing a language stays
always allowed in Nova: the document holds no profile and belongs to no project space, and one app
can be published to several. For the same reason the builder's and the tools' language removal say
nothing about profiles: the only profiles Nova could name there would be a stored reading of a
past publish, which may no longer be true, and the publish reads the real ones.

**The rule.** Every language code a build profile on the target's app names is one of the codes
this publish writes as `langs`. It is a property of two things read fresh, HQ's source and the
document being sent, so it needs no history: it holds a removed language, a relabelled single
language, and a profile left stale by a publish made before this rule existed, alike.

- A profile with no languages names none, so it passes. HQ's own Languages page can leave one (it
  removes a deleted language and keeps the profile), and it is HQ's state on an app Nova did not
  change; a publish neither makes nor worsens it.
- A language Nova adds joins no profile. That is a profile's meaning (a chosen set), and HQ's own
  page adds none either.
- Reordering languages (`setDefaultLanguage`) changes no code, and each profile keeps its own
  order, so it never stops a publish.

**The code.**

- *The reader.* `lib/commcare/hq/appSource.ts::HqAppSource` gains `buildProfiles` (part 05,
  `05-reading-commcare-hq.md`, section 7, states the member and its shape check; the reader has to
  give it before this rule can run).
  A source whose `build_profiles` cannot be read is `malformed`, which a publish already answers
  with `hq_app_state_unknown`: reading it as "no profiles" would pass the very state this rule
  exists to stop.
- *The comparison.* New file `lib/commcare/targetBuildProfiles.ts`, pure, beside `targetOverlay.ts`
  and `targetLogoRefs.ts`:

  ```ts
  /** The codes one publish of `doc` writes as `langs`, in order. */
  export function publishedLanguageCodes(doc: BlueprintDoc): readonly string[];

  export interface BuildProfileLanguageGap {
  	readonly id: string;
  	/** The profile's name as HQ holds it; `""` where it has none. */
  	readonly name: string;
  	/** The codes the profile names that the app does not have, in the profile's order. */
  	readonly missing: readonly string[];
  	/** True where the profile names no language the app has. */
  	readonly emptied: boolean;
  }

  /** One gap per profile that names a code outside `langs`, in HQ's profile order. */
  export function buildProfileLanguageGaps(
  	langs: readonly string[],
  	profiles: readonly HqBuildProfile[],
  ): readonly BuildProfileLanguageGap[];
  ```

  `publishedLanguageCodes` returns
  `planLanguageWire(effectiveAppLocalization(doc.localization)).languages`, the list
  `localization.ts::commCareLocalization` hands `expander.ts::appLevelValues`. A test holds it
  equal to the `langs` of `expandDoc` and of `expandAppShell` (below), so the check and the body
  cannot read different codes.
- *Preflight.* `lib/deployment/preflight.ts`, a `build-profiles` edge titled "Application
  profiles", over the read of the `target-app` edge, which runs whenever `plannedInPlaceUpdate`
  names an app, so on every update and on the retry that fills an empty app an earlier try made.
  It comes after the `hq-changes` verdict and before `web-apps`, and calls
  `buildProfileLanguageGaps(publishedLanguageCodes(input.doc), source.buildProfiles)`. After the
  verdict, not before the comparison with the baseline: a language a profile names may have been
  added in CommCare HQ since Nova's last push (the Languages tab, then a profile of it), and that
  is a change to `langs`, which the comparison holds. Checked first, it would be refused as a
  language "this app no longer has" though the app never had it, and send the person to change a
  profile before they were shown the change they decide on. After the verdict the person has
  either been asked about that change or said to publish over it, which takes the language out of
  `langs`, so the profile is then held to what the publish writes. A gap blocks: the edge's check
  row is `blocked` with the message as its detail and one item per profile, and the outcome is
  `blockedOutcome(now, "hq_build_profile_language_missing", message, details)` from the new
  `preflight.ts::buildProfileLanguageFailure(domain, gaps, { duringPush, hqLangs })`, where
  `hqLangs` is the `langs` of the read the gaps came from. With no gap the row is `passed`, with
  the detail "No application profile of the app on “`<domain>`” includes a language this app
  doesn't have." The edge appears only where `target-app` read an app.
  The stop holds whatever the project space's plan. HQ builds and serves a profile only under the
  `build_profiles` privilege (`views/releases.py::release_build` and
  `views/download.py::download_file` both test `domain_has_privilege(domain,
  privileges.BUILD_PROFILES)`, and `hqmedia/views.py`'s `.ccz` download takes a profile only with
  it), so on a plan without it the stale profile builds nothing today. But no API key reads the
  plan, and HQ keeps a profile when a plan loses the privilege (nothing under
  `accounting/` clears `build_profiles`), so the profile builds again, stale, the day the plan
  includes it. What the plan changes is the way out, which the copy says (below).
  Nothing was written, so on a target that is already reached the record does not change
  (`stateMachine.ts::applyAttemptOutcome`), as with every refused attempt. Preflight always runs
  over the document that is sent: where recording placements moves the head, the publish reads the
  head and runs preflight again.
- *The second read.* A publish that pushed a lookup table or a place reads the source again before
  the import (`lib/deployment/service.ts::publishAppToHq`, where `diffHqAppSource` compares that
  read with the one before it). The same call runs over that read, after the drift comparison
  passes, and a gap stops the publish at `upload` with the same code and the during-push message.
  A profile saved in HQ while the tables and places went would otherwise be written past, in a
  window as long as the push; with the check the window is one round trip, the same as for every
  key the body carries. It costs one pure call over a read the publish already holds.
- *The read after a first publish's create is not checked.* The app was made a moment earlier from
  Nova's own shell, which carries no `build_profiles` (`expander.ts::APP_SHELL_KEYS`), and HQ's
  create makes the app from the body it is given and nothing else
  (`models/applications.py::_create_app_from_doc`). A stop there could never fire.
- *The code and its place in the types.* `lib/deployment/types.ts::DEPLOYMENT_FAILURE_CODES` gains
  `"hq_build_profile_language_missing"`, with the comment "A build profile of the app on CommCare
  HQ names a language this app no longer has, and no API key can change a build profile. Nothing
  of this publish's content was sent." `blockedOutcome`'s code union gains it. The refusal carries
  no new structured field: the message and `details` say everything, and `PublishOutcome.hqAppUrl`
  already carries the app's address on a refused update.
- *What does not change.* The body: `hqImportApplication` still sends no `build_profiles`. The
  drift check: a person's change to a profile is no change to anything Nova writes, so the publish
  after it meets no `hq_changed`. The local `.ccz`: an archive is one build with every language and
  holds no profile. The HQ import file: a manual import makes a new app, which has no profile.
  Preview: it plays the document's languages, and which of them one phone installs is not something
  the document holds, so neither platform's Preview changes.

**Copy.** `buildProfileLanguageFailure` builds the message and one `details` line per profile. A
language is written as its English name and its code, `French (fra)`, from
`lib/commcare/classicLanguages.ts::classicLanguageRow(code)`, or as the code alone where the catalog
has no row for it (`cmn-hant`): HQ's tab lists codes, so the code is what the person looks for.

| Case | Message |
|---|---|
| One profile, one language, at preflight | An application profile of the app on “`<domain>`” includes a language this app no longer has, so Nova stopped before sending anything. Nova can't change application profiles in CommCare HQ. You can take that language out of the profile, or remove the profile, on the Application Profiles tab of the app's Releases page there, then publish again. Left as it is, CommCare HQ would build the profile with a language that has no text of its own, or couldn't build it at all. |
| Several profiles or languages, at preflight | Application profiles of the app on “`<domain>`” include languages this app no longer has, so Nova stopped before sending anything. Nova can't change application profiles in CommCare HQ. You can take those languages out of each profile listed below, or remove the profile, on the Application Profiles tab of the app's Releases page there, then publish again. Left as they are, CommCare HQ would build those profiles with languages that have no text of their own, or couldn't build them at all. |
| Either, found on the second read | The same sentences, with "so Nova stopped before sending anything" replaced by "which Nova found after it published this app's lookup tables and places, so it stopped before sending the app's content". |
| Every case | After the sentence that ends "then publish again": "That tab shows only where the project space's plan includes application profiles." |
| One language, where the app on HQ still lists it | After that sentence: "On any plan, you can instead remove the language on the Languages tab of the app's settings there, which takes it out of every profile. Nova may then show you that change before it publishes." |
| Several, where the app on HQ still lists every one | After that sentence: "On any plan, you can instead remove those languages on the Languages tab of the app's settings there, which takes them out of every profile. Nova may then show you that change before it publishes." |

| Profile | `details` line |
|---|---|
| Named, keeps another language | “`<name>`”: French (fra) |
| Named, several missing | “`<name>`”: French (fra), Hausa (hau) |
| Names no language the app has | “`<name>`”: French (fra), the only language it has (or "the only languages it has") |
| No name | A profile with no name: French (fra) |

"Remove the profile" is offered every time because it always works where the tab is there: the
page posts the profiles it shows, and HQ replaces the app's with them. The tab is there only under
the `build_profiles` privilege (`releases.html` draws it under `{% if build_profile_access %}`, and
`LanguageProfilesView.dispatch` is `requires_privilege(privileges.BUILD_PROFILES)`), so the copy
says so. HQ's Languages tab takes a language it removes out of every profile on any plan
(`views/apps.py::edit_app_langs`, `require_can_edit_apps` alone, the loop over
`app.build_profiles`), but it can remove only a language the app there lists (`deleted` is read
from `app.langs`), so the copy offers it exactly where the read's `langs` hold every missing
code: a language removed in Nova since the last push, a relabelled single language, or one added
in HQ that a person said to publish over. A profile left stale by a publish made before this rule
names a code HQ's `langs` no longer hold, and is changed on the Application Profiles tab alone.
Saving the Languages tab changes `langs`, which the next publish's comparison may list, hence its
second sentence. Adding the language back in Nova is not offered: the wire code a new language
takes is minted against the document (`addLanguage` stores the producer's code), so it need not
be the code the profile names. A phone installed from a removed profile is then
served the app's own build, with every language (`views/download.py::_get_build_profile_id`
answers no profile for an id the app no longer holds, and `download_file` then serves the default
files). How the tab draws a profile whose language the app already lacks, the state a publish made
before this rule leaves, is unverified in a browser: the template binds the choices to the app's
languages (`partials/releases/build_profiles.html`, `options: $root.app_langs, selectedOptions:
langs`), so the copy does not promise that the stale language shows there.

**Surfaces.**

- *The publish dialog* (`components/builder/PublishDialogBody.tsx`) draws the refusal as it draws
  every other: the message, then each `details` line. The link "Open the app in CommCare HQ", which
  it shows today for `hq_app_version_below_floor`, shows for this code too. `hqAppUrl` is the app's
  page, which is its Releases page (`app_manager/urls.py` gives `view_app` and `release_manager`
  one view). No new control: the way forward is in CommCare HQ, then "Publish again".
- *MCP.* `lib/mcp/errors.ts::UploadErrorType` and `lib/mcp/tools/uploadAppToHq.ts::UPLOAD_ERROR_TAGS`
  gain `hq_build_profile_language_missing`. The tool answers `{ error_type, message, app_id, url }`
  with the placement answer, as for the version floor, the message followed by the `details` lines
  on their own lines. The tool's description gains one sentence after the `hq_app_state_unknown`
  one: "If an application profile of the app on CommCare HQ includes a language the app no longer
  has, the call returns `hq_build_profile_language_missing` before sending the app's content: relay
  the `message` and its `url`, and upload again once the user has changed the profile there." The
  doc comments of both files gain the matching item. The tool is served by MCP alone, so
  `lib/mcp/__tests__/servedSchemas.test.ts` holds the new description and `scripts/test-schema.ts`
  gains nothing.
- *The Solutions Architect* has no deployment surface and gains none. `remove_language` and
  `update_language` keep their descriptions and results, so this fix changes nothing the chat
  model reads.
- *The plugin.* `../nova-plugin/skills/upload_to_hq/SKILL.md` lists each refusal the tool answers.
  It gains: "`hq_build_profile_language_missing`: an application profile of the app on CommCare HQ
  includes a language the app no longer has. Its content was not sent. Relay the `message` and its
  `url`, the app's page in CommCare HQ, where the user takes the language out of the profile or
  removes the profile on the Application Profiles tab. Then upload again." It rides the step's one
  plugin pull request, which moves the version once and merges once Nova's deploy is live (part 13,
  section 16).

**Public docs.**

- `content/docs/publishing.mdx`, under "Checked", a new subsection after "The CommCare version":

  > #### Application profiles
  >
  > In CommCare HQ, an app can have application profiles, each a set of the app's languages for one
  > group of phones. Nova keeps them as they are and can't change them. If you remove a language in
  > Nova that a profile there still includes, the next publish to that project space stops before
  > it sends anything and names the profile and the language. You can take the language out of the
  > profile, or remove the profile, on the Application Profiles tab of the app's Releases page in
  > CommCare HQ, then publish again. That tab shows only where the project space's plan includes
  > application profiles. On any plan, removing the language on the Languages tab of the app's
  > settings in CommCare HQ takes it out of every profile too, and the next publish may show you
  > that change before it sends anything. A language you add in Nova joins no profile until you add
  > it there.
  >
  > If someone added the language in CommCare HQ since Nova's last publish, the publish first shows
  > you that as a [change made in CommCare HQ](#changes-made-in-commcare-hq). Publishing over it
  > takes the language out of the app there, so the profile is then held to the app's languages
  > too.

  The list of what "Checked" covers, in that section's first paragraph, gains "that no application
  profile there includes a language the app no longer has" after the clause on changes made in
  CommCare HQ, the order preflight checks them in.
- `content/docs/languages.mdx`, after the sentence that says adding or removing a language leaves
  the others' codes as they are: "If the app in CommCare HQ has an application profile that
  includes a language you remove, the next publish there stops and names it
  ([Publishing](/docs/publishing#application-profiles))."
- `content/docs/mcp/tools.mdx`, the `upload_app_to_hq` row, gains the description's new sentence.
- `content/docs/claude-code/commands.mdx`, the list of what Claude checks in about before an
  upload, gains: "**Application profiles.** If an application profile of the app in CommCare HQ
  includes a language you removed, Nova sends none of the app's content, and Claude gives you the
  link to the app in CommCare HQ, where you can change the profile before uploading again."

**What existing apps see.**

- *Saved apps.* None changes. No rule of the gate is added, no document is rewritten, and no
  migration runs. Every language removal that is allowed today stays allowed.
- *HQ apps with no build profile.* Nothing changes. This is every app Nova created that nobody gave
  a profile, and every app in a project space below the Advanced plan.
- *HQ apps whose profiles name only languages the app has.* Nothing changes; the publish goes
  through and the profiles stay as HQ holds them.
- *HQ apps that already hold a profile naming a language the app lacks.* The only route to one is a
  Nova publish, made before this rule, that removed or relabelled a language after a person saved
  the profile. Its next publish stops with this refusal instead of going through. Nothing on HQ
  changes because of the stop, and the app there is exactly as it was the day before: its profile
  was already offering a language with no text, or already failing to build. The stop is the first
  notice anyone gets, and it says what to do. Nova has no migration to offer, because no API key
  can change a profile, and it writes no notice ahead of time, because nothing in an app changed
  and the stop explains itself at the moment it matters.
- *An app brought in.* Bringing in an app whose `build_profiles` holds a profile stays `not-yet`
  (section 3.7), so an adopted app starts with none. One a person adds later is held to the same
  rule as on an app Nova created.

**Tests.** None renders a component in jsdom.

| Test | Boundary | Catches |
|---|---|---|
| `lib/commcare/__tests__/appSource.test.ts`, new cases | the reader over HQ's own retained answers | `proof/hq-reads/targeted-hq-side-state/app-source-after-buildProfiles.json`, a real read holding a profile, reads `[{ id: "mandarin-only", name: "Mandarin", langs: ["zho"] }]`, and a read with `{}` reads `[]`. The same body with `build_profiles` deleted, set to a list, or holding a profile whose `langs` has a number each read `malformed`. Catches a reader that takes an unreadable `build_profiles` for none, which would let the stale profile through unseen |
| `lib/commcare/__tests__/targetBuildProfiles.test.ts`, new | pure | `buildProfileLanguageGaps`: a profile inside `langs` gives no gap; one outside gives its codes in the profile's order and `emptied: false`; a profile wholly outside gives `emptied: true`; a profile with no languages gives none. `publishedLanguageCodes(doc)` equals `expandDoc(doc).langs` and `expandAppShell(doc).langs` on a document with a suffixed code (`cmn-hant`). Catches the check reading other codes than the body writes |
| `lib/deployment/__tests__/publishGates.postgres.test.ts`, a new `describe` | `publishAppToHq` over real Postgres and controlled HQ answers | (1) An update over a source whose profile names a held code lands, and its body holds no `build_profiles`. (2) After `removeLanguage`, the publish refuses at `preflight` with the code, the exact message and `details`, `hqAppUrl` set, the only request since the mark `GET` of the source, the deployment record unchanged, and the `build-profiles` row `blocked` with the message and the line; the app on HQ lists the removed language, so the message offers the Languages tab. (3) A single-language app relabelled, over a profile naming the old code, refuses the same way. (4) With the profile then served without the language, the publish lands and meets no `hq_changed`. (5) With a lookup table, a clean source at `target-app` and a stale profile on the second read: the workbook is posted, no import is, and the refusal is at `upload` with the during-push message. (6) The retry of a first publish over an empty app that holds such a profile refuses at `preflight`. (7) A source with `build_profiles` absent refuses `hq_app_state_unknown` and sends nothing. (8) French added on HQ's Languages tab since the last push, with a profile of it alone: the publish refuses `hq_changed` with no `build-profiles` row; sent again over that change, it refuses `hq_build_profile_language_missing` offering the Languages tab. Catches a stop that fires after a write, a stop that reads as drift, a change in HQ refused as a profile, and a fix in HQ that the next publish does not accept |
| `lib/mcp/__tests__/uploadAppToHq.postgres.test.ts`, one case | the tool over the same fixtures | the answer's `error_type`, its `url`, and the `details` lines in `message`. Catches a refusal that falls to the generic upload error |
| `lib/mcp/__tests__/servedSchemas.test.ts` | what a client receives | the description's new sentence |
| `components/builder/__tests__/publishOutcome.test.ts`, one case | the dialog's state model | a refused answer with this code keeps its `details` and `hqAppUrl`. Catches the link's condition missing the code |
| `e2e/tests/browser/publishing.spec.ts`, one case beside the version floor's | Playwright | the dialog shows the message, a line per profile and the link to the app. Catches the lines not drawn |

Every fixture that answers the source read with a body written by hand gains `build_profiles: {}`,
since the reader now requires the key (the publish and MCP Postgres suites' HQ stand-ins). A
fixture built from a retained read under `proof/hq-reads/` already holds it.

The lane's part is in part 14 (`14-proof.md`): the capture peer serves the profiles a person saves,
and `targeted-hq-side-state` still publishes over its profile with no stop.

**Contracts this makes false, with their words.**

- `lib/deployment/CLAUDE.md`, "Preflight is a graph with two kinds of edge": the list of blocking
  edges gains "a build profile on HQ's app that names a language the app no longer has
  (`build-profiles`, after `hq-changes`)"; the `target-app` paragraph gains "The `build-profiles`
  edge holds that read's build profiles to the languages this publish writes
  (`lib/commcare/targetBuildProfiles.ts::buildProfileLanguageGaps`, the refusal
  `hq_build_profile_language_missing`): no API key can change a profile, so a publish that would
  leave one naming a language the app lacks stops before any write, and the same check runs on
  the second read, where it stops at `upload`.", followed by why it comes after the `hq-changes`
  verdict and why it stops whatever the plan, naming the Languages tab where the app there still
  lists every missing language.
- `lib/deployment/CLAUDE.md`, "What the check cannot close": gains "A profile saved in HQ between
  the publish's last read and its import is not seen until the next publish, which stops."
- `lib/commcare/CLAUDE.md`, "CommCare HQ upload", after "An update never writes `multimedia_map`,
  `build_profiles`, `custom_base_url` or `practice_mobile_worker_id`": "`readHqAppSource` reads
  `build_profiles` so that a publish can refuse to leave a profile naming a language the app no
  longer has (`targetBuildProfiles.ts`)."
- Root `CLAUDE.md`, the `lib/deployment` paragraph, after "a publish stops below CommCare 2.57 and
  without a confirmed plan feature": ", and where a build profile on HQ's app names a language the
  app no longer has".
- `docs/research/2026-09-26-hq-round-trip/inventory/application-and-settings.md`, the
  `build_profiles` rows (split in two by section 3.7): the empty row's disposition cell gains "; a
  publish reads the profiles and stops where one names a language the app no longer has", and the
  non-empty row takes its manifest entry's cell, which already ends with the same stop
  (`hq_build_profile_language_missing`).

---

## 8. Findings

### 8.1 The type

`lib/publish/hqFindings.ts` also holds the finding type. The reader produces findings; the account
renders them; nothing in the file reads an app or names a wire key.

```ts
/** Where in the HQ app, by the names its author sees. Indexes are 0-based positions in HQ's lists. */
export type HqPlace =
	| { readonly kind: "app" }
	| { readonly kind: "app-settings" }
	| { readonly kind: "languages" }
	| { readonly kind: "menu"; readonly menu: number; readonly name: string }
	| {
			readonly kind: "case-list" | "case-detail" | "search";
			readonly menu: number;
			readonly name: string;
	  }
	| {
			readonly kind: "form";
			readonly menu: number;
			readonly form: number;
			readonly menuName: string;
			readonly name: string;
	  }
	| {
			readonly kind: "question";
			readonly menu: number;
			readonly form: number;
			readonly menuName: string;
			readonly formName: string;
			/** The question's path under the form's data node, as its author reads it. */
			readonly path: string;
	  }
	| { readonly kind: "lookup-table"; readonly tag: string }
	| { readonly kind: "media"; readonly path: string }
	| { readonly kind: "organization" };

/** Who holds an HQ app that is already in Nova, as the viewer may know it. */
export type HqAppClaimDetail =
	/** The viewer is a member of the holding Project. */
	| { readonly kind: "open"; readonly appId: string; readonly appName: string }
	| {
			readonly kind: "elsewhere";
			/** When the Nova app began to manage the HQ app. */
			readonly at: string;
			readonly contact: {
				readonly role: "person" | "owners";
				readonly names: readonly string[];
			};
	  };

/** What the finding is about, in the app's own words where it has some. */
export interface FindingDetail {
	/**
	 * The thing's own name: an appearance, a setting, a property, a key, a file. At most 200
	 * characters. On a circumstance it is present exactly where the code's row of
	 * `CIRCUMSTANCE_STANDINGS` holds `name`, which also says where it is shown (8.3).
	 */
	readonly name?: string;
	/**
	 * Nova's checker reason, for an expression the checker refuses; `split-refused` on
	 * `no-platform-runs-everything` at a date and time question whose split is refused.
	 */
	readonly reason?: string;
	/** Present only on `already-in-nova`, where the holder is known. */
	readonly claim?: HqAppClaimDetail;
}

export type ManifestFinding = {
	readonly code: string; // an inventory entry id
	readonly standing: FindingStanding;
	/** Present exactly when standing is "fix-in-hq": `fixCauseOf(entry)`. */
	readonly cause?: FixCause;
	readonly place: HqPlace;
	readonly subject: Subject;
	readonly detail: FindingDetail;
};

export type CircumstanceFinding = {
	readonly code: ReadCircumstance;
	readonly standing: FindingStanding | "stop";
	readonly place: HqPlace;
	readonly subject: null;
	readonly detail: FindingDetail;
};

export type Finding = ManifestFinding | CircumstanceFinding;

/** The most characters a finding's name holds. */
export const FINDING_NAME_MAX_LENGTH = 200;
/** `name` cut to the bound, its last character `…` where it was cut. */
export function cutFindingName(name: string): string;

/** What `detail` holds for one code, read off its row of `CIRCUMSTANCE_STANDINGS`. */
export type CircumstanceDetail<C extends ReadCircumstance> =
	((typeof CIRCUMSTANCE_STANDINGS)[C] extends { readonly name: string }
		? { readonly name: string }
		: { readonly name?: never })
	& (C extends "no-platform-runs-everything"
		? { readonly reason?: "split-refused" }
		: { readonly reason?: never })
	& (C extends "already-in-nova"
		? { readonly claim?: HqAppClaimDetail }
		: { readonly claim?: never });

/** The one way a circumstance finding is made. `standing` is the row's, and the name is cut. */
export function circumstanceFinding<C extends ReadCircumstance>(
	code: C, place: HqPlace, detail: CircumstanceDetail<C>,
): CircumstanceFinding;
```

`place.name` is the menu's or form's name in the app's first language, or the same fallback
`diffHqAppSource` uses where it has none. A menu's and a form's index is HQ's position, so two findings
of one form group together and sort in the app's own order.

Nothing parses a finding at run time: a request answers its findings on the response it computed them
in, and nothing stores one. So there is no schema. A circumstance finding is made only by
`circumstanceFinding`. Its types refuse a name where the code's row holds none, a missing name where it
holds one, a `claim` on any code but `already-in-nova` and a `reason` on any code but
`no-platform-runs-everything`, and it fills `standing` from the row. A manifest finding is made only by
part 06's `Accounting` (`06-the-reader-forms.md`, section 5.1) and, for the findings part 11 raises
outside the reader, by its `findings.ts::manifestFinding` (`11-project-data.md`, section 13). Each
makes it from the index, which derives `standing`, `cause` and `subject` through `standingOf` and
`fixCauseOf` and cuts the name with `cutFindingName`. A finding with `subject: null` is a
circumstance, and a manifest code is never a member of `READ_CIRCUMSTANCES` (an entry id holds a
`/`). A finding carries no `owner`: no screen draws one and MCP returns none, so the owner stays data
of the manifest and of `CIRCUMSTANCE_STANDINGS`, where step 7 reads it.

`HqAppClaimDetail` is part 10's `HqAppClaimView` (`lib/deployment/store.ts::readHqAppClaims`;
`10-identity-and-the-ledger.md`, section 5.5) without `remoteAppId`, declared here because a
finding is client-safe and the store is not; the store's type is this one with that key added. It
never holds the holding Project's name or, for `elsewhere`, the Nova app's. It does not say whether
the holder brought the app in or published it: the person's step is the same under both, word for
word, and `at` is when the mapping began under either (part 10: `adopted_at`, or the mapping's
`created_at`). A circumstance carries nothing else of what failed: three permission needs are three
codes (8.3), and a read that timed out shares `hq-unavailable`, whose body says so.

### 8.2 Where a finding's fields come from

| Field | Manifest finding | Circumstance |
|---|---|---|
| `code` | the entry the cursor's claim named | the member of `READ_CIRCUMSTANCES` |
| `standing` | `standingOf(entry)` | the table of 8.3 |
| `cause` | `fixCauseOf(entry)`, present where it is not `null` | absent: a circumstance has its own copy |
| `subject` | the entry's `subject` | `null`: a circumstance has its own copy |
| `place` | the reader's position | the reader's position, or `{ kind: "app" }` |
| `detail` | set by the claim | set where the table of 8.3 says |

### 8.3 `READ_CIRCUMSTANCES`

`hqFindings.ts` exports the closed list, the codes of the table below in its order, and
`CIRCUMSTANCE_STANDINGS`, this table's Standing, Owner and Name columns as data.

```ts
export const READ_CIRCUMSTANCES = [ /* the Code column below, in its order */ ] as const;
export type ReadCircumstance = (typeof READ_CIRCUMSTANCES)[number];

/** One row per code: its standing, its step 7 owner where it has one, and where its name goes. */
export const CIRCUMSTANCE_STANDINGS = {
	"not-connected": { standing: "stop" },
	// ... one member per code, as the table below gives it ...
	"too-large": { standing: "not-yet" },
	"places-over-nova-limit": { standing: "not-yet", owner: "project-data-at-hq-size", name: "body" },
	"unrecognized": { standing: "not-yet", name: "line" },
	"read-back-differs": { standing: "not-yet", name: "internal" },
} as const satisfies Record<
	ReadCircumstance,
	{
		readonly standing: FindingStanding | "stop";
		readonly owner?: Step7Group;
		/** Where `detail.name` goes: in the block's body, on its own line, or to the log alone. */
		readonly name?: "body" | "line" | "internal";
	}
>;

/** The `not-yet` circumstances that are Nova's own fault: reported, and cleared by a Nova update. */
export const NOVA_FAULT_CIRCUMSTANCES = ["unrecognized", "read-back-differs"] as const;

/** The codes that end a reading. A table keyed by this type is total over them. */
export type StopCircumstance = {
	[K in ReadCircumstance]: (typeof CIRCUMSTANCE_STANDINGS)[K]["standing"] extends "stop" ? K : never;
}[ReadCircumstance];
```

A type-level check holds that each member of `NOVA_FAULT_CIRCUMSTANCES` is `not-yet` in
`CIRCUMSTANCE_STANDINGS` and holds no owner. Part 13's `accountHeading` reads the list
(`13-the-experience.md`, section 7.1): a missing owner alone does not say a fault is Nova's, since
`too-large` has none either.

The record keeps each member's literal type (`as const satisfies`), which is what lets part 13 hold
its table of a stop's actions total over the `stop` codes at compile time (section 6.2). A `stop` is
no finding about the app and no standing of anything in it: it says the read ended. It is shown where
the person stands and is never mixed into an account.

The table holds 34 codes: the 19 stops, then the 15 an account can hold.

| Code | Standing | Owner | Name | When | `detail` |
|---|---|---|---|---|---|
| `not-connected` | stop | | | the person has no CommCare HQ connection on that server | |
| `key-not-accepted` | stop | | | CommCare HQ refuses the stored key | |
| `key-cannot-reach-space` | stop | | | the project spaces Nova holds for the stored key do not hold this one (`getHqCredentials` answers `not_authorized`); no request is sent | |
| `plan-lacks-api-access` | stop | | | the project space's plan has no API access | |
| `api-cut-off` | stop | | | CommCare HQ's 401 says API access is paused for the account or the project space | |
| `not-a-member` | stop | | | CommCare HQ says the account is no member of the project space | |
| `cannot-edit-apps` | stop | | | the account lacks Edit Apps there, on a read that names it | |
| `cannot-access-apis` | stop | | | the account lacks Access APIs there, on a read that names it alone | |
| `cannot-read-organization` | stop | | | a 403 on the level or the place read | |
| `app-gone` | stop | | | CommCare HQ holds no app by that id | |
| `app-deleted` | stop | | | CommCare HQ holds it as deleted | |
| `linked-app` | stop | | | the source's `doc_type` is `LinkedApplication` | |
| `remote-app` | stop | | | the app list holds the app and the application resource has none | |
| `rate-limited` | stop | | | CommCare HQ answered that it is too busy, after the read's resends | |
| `hq-unavailable` | stop | | | CommCare HQ did not answer in time, or answered with nothing Nova can read | |
| `hq-gateway-refused` | stop | | | a gateway in front of CommCare HQ refused the request | |
| `browser-only` | stop | | | CommCare HQ answered a redirect or a page where data was asked | |
| `changed-while-reading` | stop | | | the app's save counter moved during the read, and again when the request read the app once more | |
| `already-in-nova` | stop | | | another Nova app manages this HQ app | `claim`, where the holder is known |
| `too-large` | not-yet | | | a body of the app's read, the application resource's or the source's, is over the bring-in's byte bound (`HQ_BRING_IN_APP_MAX_BYTES`, 16 MiB) | none |
| `menu-unreadable-in-hq` | fix-in-hq | | | CommCare HQ's own summary of a menu is an error | none: the place names the menu |
| `app-unreadable-in-hq` | fix-in-hq | | | CommCare HQ's summary is an error for every menu it would summarize, and there are at least two | none |
| `shadow-disagrees` | fix-in-hq | | line | an attribute and its `vellum:` shadow differ in meaning | `name`: the attribute |
| `media-file-unreadable` | fix-in-hq | | body | CommCare HQ's media map holds an entry for the path and CommCare HQ serves no file for it, on a slot some platform the app runs on draws | `name`: the path |
| `media-not-played-where-app-runs` | fix-in-hq | | body | a referenced file's format plays on no platform the rest of the app runs on | `name`: the path |
| `table-rows-unreadable` | fix-in-hq | | body | a read of one table's rows answers a status of 500 or more that is not the edge's and is not 502, 503 or 504, and answers one again when it is sent once more, where the table list answered | `name`: the tag |
| `table-cell-unrepresentable` | fix-in-hq | | body | a lookup table the app reads holds, in a field its definition names, a character XML 1.0 cannot carry | `name`: `"<tag> (the field <field name>)"` |
| `table-choices-unusable` | fix-in-hq | | body | a question or a search field of the app takes its choices from a lookup table, and that table has no rows, or a row whose value is blank, has white space at an end or repeats another's, or whose label is blank | `name`: `"<tag> (the field <field name>)"` |
| `no-platform-runs-everything` | fix-in-hq | | body | no declaration runs all of the app's content: some use runs only in Web Apps and some only on Android | `name`: the feature's label in curly quotes and the platform that cannot run it, `“Date and time questions”, which Web Apps can't run`; `reason`: `split-refused` at a date and time question whose split is refused (8.4) |
| `places-over-nova-limit` | not-yet | `project-data-at-hq-size` | body | the project space has more active places than Nova holds for an app | `name`: the count CommCare HQ reports, `"12,400 places"`, or `"more than 10,000 places"` where it reports none |
| `place-not-holdable` | not-yet | `project-data-at-hq-size` | body | a level's code, a place's site code, name, coordinates, parent or a value the app reads is outside what Nova's organization holds | `name`: the level's or the place's name |
| `owner-rule-needs-one-place` | not-yet | `project-data-at-hq-size` | body | an owner rule of the app gives a case to the place at a level below the case's current owner, and in the project space that is not exactly one place below every place that owns cases | `name`: the level's name |
| `unrecognized` | not-yet | | line | the reader met something no manifest entry names | `name`: the surface key, or the app's own value where what was unclaimed is a value (an appearance, as written) |
| `read-back-differs` | not-yet | | internal | one of Nova's own checks on what it read did not pass: acceptance failed after a clean read (a failing check, or a reader defect beside a clean read; part 09, section 14), or the birth's own checks refused what acceptance had passed (part 12, section 6.5) | `name`: the check. From acceptance: `accounting`, `gate`, `fixed-point`, `identity`, `summary` or `reader`. From the birth: `birth-gate`, `birth-export`, `birth-integrity`, `birth-identity` or `birth-bindings` |

`name` says where `detail.name` goes. `body`: the block's body fills `{name}`, and no line repeats it.
`line`: the account, the copied text and MCP draw it after the block's body as "In CommCare HQ:
{name}", as they do for a manifest finding. `internal`: it is Nova's own word, for the log and for
telling two findings apart, and no surface shows it. A code with no `name` carries none.

**Who raises each.** Part 05's `hqReadCircumstance` gives thirteen from a failed read
(`05-reading-commcare-hq.md`, section 4.3). The bring-in's own reads give the rest of the stops:
`not-connected` and `key-cannot-reach-space` from part 05's `getHqCredentials` (its section 11),
`already-in-nova` from the claim (part 10, section 5.5), and `app-deleted`, `linked-app`, `remote-app`
and `changed-while-reading` from the bracketed read (part 05, section 8.2). `notSummarizedMenus` gives
`menu-unreadable-in-hq` and `app-unreadable-in-hq` (part 05, section 8.3). The reader gives
`shadow-disagrees`, `unrecognized` and `no-platform-runs-everything` (part 06, sections 14.2, 4.4 and
16.3). Part 11 gives the two media codes, the three table codes and the three place codes
(`11-project-data.md`, section 13.2). Acceptance and the birth give `read-back-differs` (part 09, section
14; part 12, `12-the-reading-and-the-birth.md`, section 6.5). What a read and a create answer for each is
part 12's table (its section 3.8).

`shadow-disagrees` words the reader's rule for a real attribute and its `vellum:` shadow that
disagree, which no manifest entry can name because it is a relation between two attributes.
`unrecognized` and `read-back-differs` are Nova's own shortfalls, so their standing is `not-yet`,
their copy takes the blame, and each is logged at error (`log.error`, which mirrors to Sentry).
`read-back-differs` is one code for acceptance's failure and for the birth's own refusal of what
acceptance passed: one situation for the person and one step. A developer tells the two apart by
`detail.name`, where the birth's names take the prefix `birth-`, and by the two log lines.
`too-large` has one cause, a body over the byte bound, and no owner: the bound is a plain limit
(`lib/commcare/hq/appReading.ts::HQ_BRING_IN_APP_MAX_BYTES`, 16 MiB; part 05, section 3.3, holds it
and why), never a size step 7 is asked to design for, and its block promises no update. A media
file over Nova's size limit and a table over Nova's caps are no circumstances: they are content the
manifest names (`expressions-and-data/an-imported-asset-larger-than-nova-s-per-kind-cap-or-an-app`,
`table-or-row-count-beyond-nova-s-caps-5-000-rows-250-columns-64`), so their findings carry those
entry ids and the subject. `menu-unreadable-in-hq` carries no `detail.name`: CommCare HQ's message
there is the text of an exception that quotes the app, which goes to no log and to no person; the
log line holds the menu's position and the text's shape (part 05, section 8.3).
The three place codes are kept apart though a person does nothing for any of them: each is a separate
piece of step 7's work, and its exit rule reads their owner off `CIRCUMSTANCE_STANDINGS`.

**Three codes are decided by the source, with no condition.** Each was read at the pin.
`remote-app`: the app list holds a remote app and the application resource answers 404 for it
(`app_manager/_design/views/applications_brief/map.js` emits `RemoteApp`, `views/cli.py::list_apps`
reads that view through `Domain.applications`, and
`api/resources/v0_4.py::BaseApplicationResource.obj_get` admits `Application` and `LinkedApplication`
alone). `app-unreadable-in-hq`: every step of a menu's summary runs inside
`ApplicationResource.dehydrate_module`'s `try`, which catches `Exception`, so the resource answers 200
with an error entry for each menu and never an error for the app whole; the code is every menu an
error, where there are at least two. `table-rows-unreadable`:
`fixtures/models.py::LookupTableRow.fields_without_attributes` raises `IndexError` for a field with no
value, and `fixtures/resources/v0_1.py::FixtureResource.dehydrate_fields` catches `FixtureVersionError`
alone. The status CommCare HQ answers for that uncaught error is unverified (the API library is not
among the checkouts), so the code is raised for a status of 500 or more that is not 502, 503 or 504,
answered again when the read is sent once more: one 503 does not tell a person to change a row that
may be fine.

**The codes and the names other parts use for them.** The binding names are this table's. Part
05's answers of a read are its own words and no codes: its `deleted` is the code `app-deleted`, its
`gone` is `app-gone`, its `linked` is `linked-app`, its `remote` is `remote-app`, its media read's
`missing` is `media-file-unreadable` where a platform the app runs on draws the slot, and a media
file over Nova's limit is no circumstance (the manifest entry above carries it). Its section 4.3
maps every failure kind to this table's names, and its
`lib/commcare/hq/failure.ts::hqReadCircumstance(failure: HqFailure): ReadCircumstance` holds those.

**Which code a key or a permission becomes.** A stored key whose project spaces do not list this one
is `key-cannot-reach-space`, decided before any request: CommCare HQ said nothing, the key may be
limited to another project space (`settings/forms.py::HQApiKeyForm`;
`domain/auth.py::HQApiKeyAuthentication.is_authenticated` filters by it) or the person joined after
it was saved, and the step is in Settings, whose Refresh reads the project spaces again
(`lib/db/settings.ts::refreshApprovedDomains`). `not-a-member` is CommCare HQ's own 403 alone. HQ does
not always say which permission is missing, so a 403's code follows the read, by part 05's
`HqPermissionNeed` (its sections 4.2 and 4.3):

| The read | What its 403 can mean | Code |
|---|---|---|
| the app's source, an import | Edit Apps | `cannot-edit-apps` |
| the API access probe, the application resource, the table list | Access APIs | `cannot-access-apis` |
| a table's rows | Edit Apps or Access APIs, which HQ checks together; the reading reached the rows only after the application resource answered with Access APIs, so Edit Apps is the one that can be missing | `cannot-edit-apps` |
| the levels, the places | Locations on the plan, or Edit Locations on the account. A plan without API access answers 401, which is another code, and the reading proved Access APIs at the application resource | `cannot-read-organization` |

A 403 from an account that is no member is `not-a-member` on every read. `cannot-edit-apps`'s block
(9.3) is worded for the app and for a table's rows alike.

**A circumstance and a manifest entry never give one thing two standings.** Two pairs look as if they
might, and neither does:

- **A linked or a remote app.** The manifest holds REFUSED entries for the same documents
  (`application-and-settings/doc-type-linkedapplication-downstream-app` and
  `upstream-app-id-upstream-version-linked-app-translations-linked`, `fix-in-hq`;
  `doc-type-remoteapp-profile-url-manage-urls-questions-map`, `never`; and `unknown-doc-type`,
  `fix-in-hq`), and they stay, because the manifest is the record of the whole surface and the lane's
  manifest check reads it. No reading claims any of the four. The reader takes an `HqAppSource`, which
  `readHqAppSource` gives only for `doc_type` `Application`; the HQ read answers `linked` or `remote`
  before any reader runs (part 05, its section 8.2), any other `doc_type` is an answer Nova could not
  read (`hq-unavailable`), the reading ends at the `stop`, and the person reads the circumstance's
  block alone. So one thing never shows two standings: the entry's standing is the manifest's record
  of the document, and the `stop` is what a reading says. The four sit on part 14's exemption list
  (`proof/matrix/exemptions.json`, reason `stated-by-its-part`; `14-proof.md`, section 7.5) with
  the note "no reading claims it: the HQ read stops first", and they take the subjects `app-document`
  and `hand-written-content`. No account shows their sentences, so `app-document`'s sentence is not
  read against the two linked app entries.
- **A media reference with no file.** `media-file-unreadable` is about HQ's server, not the app's
  source: `multimedia_map` holds an entry for the path, and HQ has no file to serve for it. The
  manifest's entries are about the source: a reference with no `multimedia_map` entry at all
  (`expressions-and-data/a-media-reference-on-a-slot-nova-holds-with-no-multimedia-map`,
  `a-media-reference-with-no-file-on-a-slot-android-s-install` for the slots Android's install
  checks, and `a-media-reference-with-no-file-on-a-slot-a-runtime-draws`, 3.5). The two REFUSED ones
  take the subject `missing-media-files`. A path is in the map or it is not, and part 11's
  first-match order (`11-project-data.md`, section 3.2) gives a reference with no entry exactly one
  of the source entries, so one reference meets one standing and never two.

### 8.4 The copy model

New file `lib/publish/hqFindingCopy.ts`, client-safe, importing `hqFindings.ts`. It sits in
`lib/publish` beside the other copy the builder and MCP share (`placementMoves.ts`, `planFeatures.ts`),
and not beside the account's components, because both surfaces read the table (Departure 6).

```ts
export const FINDING_LABELS: Readonly<Record<FindingStanding, string>>;
export const FINDING_NEXT_STEPS: Readonly<Record<FindingStanding, string>>;
export const SUBJECT_LABELS: Readonly<Record<Subject, string>>;
/** One sentence per subject for each of the two standings a cause does not split. */
export const FINDING_COPY: Readonly<
	Record<Subject, Partial<Record<Exclude<FindingStanding, "fix-in-hq">, string>>>
>;
/** What is set up, ending in its verb: "Case sharing is", "A question's choices are". */
export const FIX_IN_HQ_STEMS: Readonly<Partial<Record<Subject, string>>>;
/** How it is set up, by cause. `below-floor` has no clause: its one sentence is whole. */
export const FIX_CAUSE_CLAUSES: Readonly<Record<Exclude<FixCause, "below-floor">, string>>;
/** A whole sentence for one subject and cause, which is read in place of stem and clause. */
export const FIX_IN_HQ_SENTENCES: Readonly<
	Partial<Record<Subject, Partial<Record<FixCause, string>>>>
>;
export const CIRCUMSTANCE_COPY: Readonly<Record<ReadCircumstance, CircumstanceCopy>>;

export interface CircumstanceCopy {
	readonly title: string;
	readonly body: string;
	/** What the person can do next, as an invitation. */
	readonly next: string;
}

/** The sentence a `fix-in-hq` finding of this subject and cause reads. */
export function fixInHqSentence(subject: Subject, cause: FixCause): string;

/** What a surface knows when it draws a circumstance. */
export interface CircumstanceContext {
	/** The server's label. */
	readonly server: string;
	/** The project space. */
	readonly space: string;
	/** The HQ app's name, or null where none is known. */
	readonly app: string | null;
	/** How this surface writes a date: the viewer's locale date on screen, the UTC day over MCP. */
	readonly formatDate: (iso: string) => string;
}
/** A circumstance as every surface shows it, with every placeholder filled. */
export function circumstanceBlock(
	finding: CircumstanceFinding, context: CircumstanceContext,
): { readonly title: string; readonly body: string; readonly next: string };
/** `already-in-nova`'s next step, which depends on who holds the app. */
export function alreadyInNovaNext(
	claim: HqAppClaimDetail | undefined, formatDate: (iso: string) => string,
): string;
/** The line under every account's groups (9.1). */
export const ACCOUNT_CHECK_AGAIN_LINE: string;

/** A place, as one line: "Registration, in the menu Households". */
export function placeLine(place: HqPlace): string;
/** One finding as the account shows it. */
export function findingLine(finding: Finding): {
	readonly sentence: string;
	/**
	 * `detail.name`, shown after the sentence as "In CommCare HQ: <name>", for a manifest finding
	 * and for a circumstance whose row holds `name: "line"`; null otherwise.
	 */
	readonly named: string | null;
};
```

A `not-yet` or `never` finding's sentence is `FINDING_COPY[subject][standing]`. A `fix-in-hq`
finding's is `fixInHqSentence(subject, cause)`: `FIX_IN_HQ_SENTENCES[subject]?.[cause]` where there is
one, else `FIX_IN_HQ_STEMS[subject]`, a space, and `FIX_CAUSE_CLAUSES[cause]`. One stem serves every
cause a subject's entries give, so an entry that brings a new cause to a subject needs no new string.

A circumstance is worded by `circumstanceBlock(finding, context)`, the one function every surface
calls: the stop block, the account, the copied text and MCP. `CIRCUMSTANCE_COPY` holds templates, and
one function fills them so that no two surfaces can fill them differently. It fills `{server}`,
`{space}` and `{name}`. It fills `{app}` with the app's name, or with "this app" where the context
holds none ("This app" at the start of a sentence): MCP is sent an id, and a read from the address
knows no name until the app answers. Its `next` is `alreadyInNovaNext(finding.detail.claim,
context.formatDate)` for `already-in-nova` (9.3); for `no-platform-runs-everything` with
`detail.reason === "split-refused"`, "You can change how the date and time question {question} reads
its own answer in CommCare HQ, then check again.", `{question}` the last segment of `place.path`;
otherwise the template's `next`. `CIRCUMSTANCE_COPY` holds `alreadyInNovaNext`'s answer for an unknown
holder as that code's `next`, so the record stays total.

`findingLine` and `fixInHqSentence` throw for a pair with no sentence, which the completeness test
makes unreachable. For a circumstance an account holds, `findingLine`'s `sentence` is the block's
title, which holds no placeholder for any code an account can hold; the account takes the body and
next step from `circumstanceBlock`. `findingLine` throws for a `stop`, which no account holds. The account's grouping, its headings and its buttons are part 13's
(`13-the-experience.md`, section 7); this file holds the words.

---

## 9. Copy

Every string this part adds, as it ships. All of it follows `design/readme.md`, "Content fundamentals".

### 9.1 The three labels and their next steps (`hqFindingCopy.ts`)

| Standing | `FINDING_LABELS` | `FINDING_NEXT_STEPS` |
|---|---|---|
| `not-yet` | Nova can't hold this yet | There is nothing for you to change. You can check again whenever you like. |
| `never` | Nova doesn't bring this in | The app can come in once it no longer uses this. If your team relies on it, the app is best kept in CommCare HQ. |
| `fix-in-hq` | Something to change in CommCare HQ | Once this is changed in CommCare HQ, you can check again and Nova will read the app afresh. |

The `not-yet` step promises no update and keeps no list: Nova stores nothing of a reading, the line
is drawn above `too-large`, whose block promises none on purpose, and a `not-yet` finding also clears
when the app stops using the thing.

`placeLine`, by place kind: `app` "The app"; `app-settings` "App settings"; `languages` "Languages";
`menu` "The menu {name}"; `case-list` "The case list of {name}"; `case-detail` "The case details of
{name}"; `search` "The search of {name}"; `form` "{name}, in the menu {menuName}"; `question` "The
question {path}, in {formName}"; `lookup-table` "The lookup table {tag}"; `media` "The file {path}";
`organization` "The organization". `findingLine`'s `named` renders as "In CommCare HQ: {name}".

One more export:
`ACCOUNT_CHECK_AGAIN_LINE = "When you check again, Nova may find more to name."`
One pass reports everything the reader can decide, with two limits (part 06,
`06-the-reader-forms.md`, Departure 11): what sits beneath a thing Nova could not read is not judged,
and a check whose inputs another finding withheld does not run. So an account says a later check may
find more. The line claims no more than that, because it sits under every account, one that holds
only things the person cannot change included, and Nova checks nothing by itself: the person chooses
Check again. Part 13 draws the line under the groups of every account and MCP returns it as
`check_again` (`13-the-experience.md`, sections 7.1 and 14.3).

### 9.2 The sentences of manifest findings

"Here" in a sentence is the place the account prints above it. `SUBJECT_LABELS` is the Label column of
2.2's table. `findingLine` gives the sentence and `named` (8.4).

A `not-yet` or `never` finding reads its pair's sentence (`FINDING_COPY`), 54 and 29 of them:

| Subject | Standing | Sentence |
|---|---|---|
| `advanced-forms` | `not-yet` | This uses a way of loading or opening cases in an advanced form, which Nova can't hold yet. |
| `advanced-menus` | `not-yet` | This advanced menu is set up in a way Nova would change when it publishes, so Nova can't hold it yet. |
| `after-submit` | `never` | This uses a destination after the form is sent, which Nova doesn't bring in. |
| `android-app-dependencies` | `not-yet` | This uses a list of Android apps the phone must have, which Nova can't hold yet. |
| `app-document` | `never` | A menu here has no ID in CommCare HQ, so Nova has nothing to keep it by. |
| `app-settings` | `never` | This uses an app setting, which Nova doesn't bring in. |
| `auto-select` | `not-yet` | This uses a setting that chooses a case for the worker, which Nova can't hold yet. |
| `build-profiles` | `not-yet` | This uses build profiles, which Nova can't hold yet. |
| `call-center-indicators` | `never` | This uses call center indicators, which Nova doesn't bring in. |
| `case-attachments` | `never` | This uses pictures or files saved on a case itself, which Nova doesn't bring in. |
| `case-detail-tabs` | `not-yet` | This uses tabs on the case detail screen, which Nova can't hold yet. |
| `case-list-callout` | `not-yet` | This uses a lookup from the case list into another Android app, which Nova can't hold yet. |
| `case-list-columns` | `never` | This uses a column format, which Nova doesn't bring in. |
| `case-list-columns` | `not-yet` | A column here is set up in a way Nova can't hold yet. |
| `case-list-filter` | `not-yet` | The case list filter here is more than Nova can read as a condition yet. |
| `case-list-optimizations` | `never` | This uses a case list speed setting, which Nova doesn't bring in. |
| `case-list-optimizations` | `not-yet` | This uses a case list speed setting, which Nova can't hold yet. |
| `case-list-registration` | `not-yet` | This uses a way of offering a form from the case list, which Nova can't hold yet. |
| `case-list-setup` | `not-yet` | This case list is set up in a way Nova can't hold yet. |
| `case-list-sorting` | `not-yet` | This uses a way of ordering the case list, which Nova can't hold yet. |
| `case-list-text` | `not-yet` | This uses its own wording for an empty list or the Continue button, which Nova can't hold yet. |
| `case-preloads` | `not-yet` | This uses a way of loading a case value into a question, which Nova can't hold yet. |
| `case-property-names` | `not-yet` | A case property name here is one Nova can't hold yet. |
| `case-sharing` | `not-yet` | This uses case sharing, which Nova can't hold yet. |
| `case-tiles` | `not-yet` | This uses a case tile layout, which Nova can't hold yet. |
| `child-cases` | `never` | This form opens a case of its menu's own type, and this project space leaves out the link between the two. |
| `connect-blocks` | `not-yet` | A CommCare Connect block here is set up in a way Nova can't hold yet. |
| `custom-assertions` | `never` | This uses custom assertions, which Nova doesn't bring in. |
| `custom-device-properties` | `never` | This uses custom device properties, which Nova doesn't bring in. |
| `data-registry` | `never` | This uses a data registry, which Nova doesn't bring in. |
| `data-sources` | `not-yet` | A results screen or a form here reads a search answer in a way Nova can't hold yet. |
| `deep-links` | `never` | A deep link ID on a mirror menu here has a space at its start or end, which Nova can't keep exactly. |
| `deep-links` | `not-yet` | This uses a deep link with its own arguments, which Nova can't hold yet. |
| `display-conditions` | `not-yet` | A display condition here is more than Nova can read as a condition yet. |
| `display-only-forms` | `not-yet` | A form here goes back to, or opens through, the menu above in a way Nova can't hold yet. |
| `expressions` | `not-yet` | An expression here is more than Nova can read yet. |
| `form-case-management` | `not-yet` | This form's case management is set up in a way Nova can't hold yet. |
| `form-settings` | `not-yet` | This uses a form setting, which Nova can't hold yet. |
| `form-source` | `not-yet` | A form's source here is built in a way Nova can't hold yet. |
| `hand-written-content` | `never` | This uses hand-written XML or settings that no CommCare HQ page edits, which Nova doesn't bring in. |
| `hierarchical-locations` | `never` | This uses the older, nested list of places, which Nova doesn't bring in. |
| `language-codes` | `not-yet` | A language code here is one Nova can't hold yet. |
| `list-and-search-filters` | `not-yet` | The case list here filters cases its search doesn't, which Nova can't hold yet. |
| `lookup-selection` | `never` | This uses choosing from a lookup table before the case list, which Nova doesn't bring in. |
| `lookup-tables` | `not-yet` | A lookup table here uses something Nova can't hold yet, or is larger than Nova takes. |
| `media-by-language` | `not-yet` | This uses a picture or sound that differs by language, which Nova can't hold yet. |
| `media-files` | `not-yet` | A media file here is larger than Nova takes, or this app has more media than Nova takes. |
| `menu-badges` | `not-yet` | This uses a badge on a menu or form, which Nova can't hold yet. |
| `menu-display` | `not-yet` | This uses grid menus, which Nova can't hold yet. |
| `menu-structure` | `never` | The menus here are in an order that separates a menu from the one above it. |
| `menu-structure` | `not-yet` | How this menu is nested is something Nova can't hold yet. |
| `mirror-menus` | `never` | This uses the older kind of mirror menu, which Nova doesn't bring in. |
| `mirror-menus` | `not-yet` | This uses a mirror menu, which Nova can't hold yet. |
| `mobile-reports` | `never` | This uses mobile reports, which Nova doesn't bring in. |
| `parent-selection` | `never` | This uses a first case that is no parent of the second, which Nova doesn't bring in. |
| `parent-selection` | `not-yet` | This chooses a parent case first in a way Nova can't hold yet. |
| `print-templates` | `never` | This uses a print template, which Nova doesn't bring in. |
| `question-appearance` | `never` | This uses a display style, which Nova doesn't bring in. |
| `question-appearance` | `not-yet` | A question here has a display style Nova can't hold yet. |
| `question-choices` | `not-yet` | A question's choices here are set up in a way Nova can't hold yet. |
| `question-ids` | `never` | Two questions here share one place in the form's data, so Nova can't tell them apart. |
| `question-ids` | `not-yet` | A question ID here is one Nova can't hold yet. |
| `question-logic` | `not-yet` | A question's logic here is something Nova can't hold yet. |
| `question-media` | `not-yet` | A question here carries a kind of media or label form Nova can't hold yet. |
| `question-text` | `not-yet` | This uses a kind of question text, which Nova can't hold yet. |
| `question-types` | `not-yet` | A question here is of a kind, or is set up in a way, that Nova can't hold yet. |
| `repeats` | `not-yet` | A repeat group here is set up in a way Nova can't hold yet. |
| `save-to-case` | `not-yet` | This uses a Save to Case question, which Nova can't hold yet. |
| `search-default-filters` | `never` | A search filter here sets how the search itself runs from a value worked out on the device. |
| `search-default-filters` | `not-yet` | This uses a search filter, which Nova can't hold yet. |
| `search-expressions` | `never` | This uses a search expression, which Nova doesn't bring in. |
| `search-expressions` | `not-yet` | This uses a search expression, which Nova can't hold yet. |
| `search-fields` | `not-yet` | A search field here is set up in a way Nova can't hold yet. |
| `search-setup` | `never` | This uses a search setting, which Nova doesn't bring in. |
| `search-setup` | `not-yet` | This uses a search setting, which Nova can't hold yet. |
| `shadow-forms` | `not-yet` | This uses a shadow form, which Nova can't hold yet. |
| `supply-features` | `never` | This uses CommCare Supply features, which Nova doesn't bring in. |
| `training-menus` | `never` | This uses a training menu or release notes form, which Nova doesn't bring in. |
| `translation-overrides` | `not-yet` | This uses its own wording for a menu, form or list, kept in the app's translations, which Nova can't hold yet. |
| `visit-scheduler` | `never` | This uses a visit schedule, which Nova doesn't bring in. |
| `worker-record` | `never` | A question here is named commcare_usercase, the name CommCare HQ gives the worker's own record. |
| `worker-record` | `not-yet` | This reads or writes the worker's own record in a way Nova can't hold yet. |
| `writer-types` | `not-yet` | A case property here takes answers of kinds that don't match, which Nova can't hold yet. |

A `fix-in-hq` finding reads its subject's stem (`FIX_IN_HQ_STEMS`), which ends in "is" or "are" and
which the clause of the finding's cause completes:

| Cause | `FIX_CAUSE_CLAUSES` | A whole sentence it makes |
|---|---|---|
| `hq-refuses` | set up in a way CommCare HQ can't save or build. | A menu setting is set up in a way CommCare HQ can't save or build. |
| `breaks-when-run` | set up in a way that doesn't work when the app runs, though CommCare HQ builds it. | A lookup table is set up in a way that doesn't work when the app runs, though CommCare HQ builds it. |
| `either` | set up in a way CommCare HQ can't save or build, or that doesn't work when the app runs. | A deep link is set up in a way CommCare HQ can't save or build, or that doesn't work when the app runs. |

The 45 stems:

| Subject | Stem |
|---|---|
| `advanced-forms` | The cases this advanced form loads or opens are |
| `after-submit` | Where this form goes after it is sent is |
| `android-app-dependencies` | The Android apps this app depends on are |
| `app-logos` | An app logo is |
| `app-settings` | An app setting is |
| `auto-select` | Choosing a case automatically is |
| `case-detail-tabs` | A tab on the case detail screen is |
| `case-list-callout` | A lookup from the case list is |
| `case-list-columns` | A column is |
| `case-list-filter` | The case list filter is |
| `case-list-registration` | The form offered from the case list is |
| `case-list-setup` | The case list is |
| `case-list-sorting` | A sort rule is |
| `case-preloads` | A question that loads a case value is |
| `case-property-names` | A case property name is |
| `case-sharing` | Case sharing is |
| `case-tiles` | A case tile is |
| `child-cases` | A child case is |
| `connect-blocks` | A CommCare Connect block is |
| `data-sources` | Something this app reads from the device is |
| `deep-links` | A deep link is |
| `display-conditions` | A display condition is |
| `display-only-forms` | A menu whose forms show in the menu above is |
| `form-case-management` | This form's case management is |
| `form-settings` | A form setting is |
| `form-source` | Part of this form's source is |
| `lookup-tables` | A lookup table is |
| `menu-settings` | A menu setting is |
| `menu-structure` | How this menu is nested is |
| `mirror-menus` | A mirror menu is |
| `parent-selection` | Choosing a parent case first is |
| `question-appearance` | A question's display style is |
| `question-choices` | A question's choices are |
| `question-logic` | A question's logic is |
| `question-media` | Media on a question is |
| `question-text` | A question's text is |
| `question-types` | A question is |
| `repeats` | A repeat group is |
| `save-to-case` | A Save to Case question is |
| `search-default-filters` | A search filter is |
| `search-expressions` | A search expression is |
| `search-fields` | A search field is |
| `search-setup` | The search is |
| `shadow-forms` | A shadow form is |
| `worker-record` | A use of the worker's own record is |

Where a plainer thing can be said of a subject and cause than the clause says, the pair has a whole
sentence (`FIX_IN_HQ_SENTENCES`) and the subject has no stem. Ten subjects are worded that way, in
thirteen sentences:

| Subject | Cause | Sentence |
|---|---|---|
| `app-document` | `hq-refuses` | Part of how this app is stored is something CommCare HQ can't save or build. |
| `blank-form` | `hq-refuses` | A form here has no questions, which CommCare HQ won't build. |
| `case-types` | `hq-refuses` | A case type here holds a character CommCare HQ's menu settings can't save. |
| `commcare-version` | `below-floor` | This app is built for a CommCare version below 2.57, the earliest Nova publishes to. |
| `expressions` | `breaks-when-run` | An expression here is one CommCare can't run, though CommCare HQ builds it. |
| `expressions` | `either` | An expression here is one CommCare can't run or CommCare HQ can't build. |
| `expressions` | `hq-refuses` | An expression here is one CommCare HQ can't build. |
| `instance-text` | `either` | A name or description here holds text that CommCare HQ reads as a data source. A space before its bracket keeps it as text. |
| `language-codes` | `hq-refuses` | A language code here is one CommCare HQ's Languages page can't save. |
| `media-files` | `breaks-when-run` | A media file here is in a format CommCare can't show or play. |
| `media-files` | `hq-refuses` | A media file here is kept at a path CommCare HQ can't build into the app. |
| `missing-media-files` | `breaks-when-run` | The app points at a media file here that CommCare HQ doesn't have. Workers meet a missing file there, and Android may not start the app at all. |
| `question-ids` | `hq-refuses` | A question ID here is one CommCare HQ's form builder can't keep. |

The stems and whole sentences compose 87 pairs of subject and cause. Under the `instance-text`
sentence the account shows the text that was found, as "In CommCare HQ: instance('casedb')"
(`findingLine`'s `named`, from the finding's `detail.name`). A missing file has its own subject and
sentence, apart from a file in a format that does not play, because the person's step differs: upload
the file again, or replace it with another format.

### 9.3 One block per circumstance (`CIRCUMSTANCE_COPY`)

`{server}` is the server's label, `{space}` the project space, `{app}` the HQ app's name, or "this
app" where none is known ("This app" at the start of a sentence), and `{name}` `detail.name`.
`circumstanceBlock` fills them (8.4). No block a stop of the picker can draw names `{app}`: the picker
meets a stop with no app chosen. This section holds each block once, and the parts that raise a
code cite it.

| Code | Title | Body | Next |
|---|---|---|---|
| `not-connected` | Nova isn't connected to CommCare HQ on {server} yet | Nova has no CommCare HQ account of yours on {server} to read with. | You can connect one in Settings, then come back here. |
| `key-not-accepted` | CommCare HQ didn't accept your API key | Nova tried to read {space} with your saved key and CommCare HQ turned it down. The key may have been removed or replaced. | You can save a new key in Settings, then check again. |
| `key-cannot-reach-space` | Your saved key doesn't reach this project space | The CommCare HQ key Nova has for you on {server} doesn't list {space}. It may be limited to another project space, or you may have joined {space} after it was saved. | You can refresh your project spaces or save a new key in Settings, then check again. |
| `plan-lacks-api-access` | This project space's plan has no API access | Nova reads an app through CommCare HQ's API, and {space}'s plan doesn't include it. | Once the plan includes API access, you can check again. Someone who manages the project space's subscription can say when. |
| `api-cut-off` | CommCare HQ has paused API access | CommCare HQ has paused API access for your account or for {space} after too many requests. Your key and the plan are fine. | Dimagi support (support@dimagi.com) can turn it back on. Then you can check again. |
| `not-a-member` | Your account isn't part of this project space | CommCare HQ says your account is no member of {space}, so Nova can't read its apps. | You can ask an admin of {space} to add you, or choose another project space. |
| `cannot-edit-apps` | Your account can't edit apps here | Reading an app and the lookup tables it uses needs the Edit Apps permission on {space}, and your account doesn't have it. | You can ask an admin of {space} for Edit Apps, then check again. |
| `cannot-access-apis` | Your account can't use the API here | Reading an app's forms and its list of lookup tables needs the Access APIs permission on {space}, and your account doesn't have it. | You can ask an admin of {space} for Access APIs, then check again. |
| `cannot-read-organization` | Nova couldn't read this project space's organization | {app} reads places, and reading them from {space} needs Locations on its plan and the Edit Locations permission on your account. CommCare HQ doesn't say which of the two is missing. | An admin of {space} can check both. Then you can check again. |
| `app-gone` | CommCare HQ no longer has this app | Nova asked {space} for {app}, and CommCare HQ holds no app by that ID. It may have been deleted. | You can go back and choose from the apps {space} has now. |
| `app-deleted` | This app was deleted in CommCare HQ | {app} is in {space}'s deleted apps, so there is nothing current for Nova to read. | If it was deleted by mistake, you can restore it in CommCare HQ and check again. |
| `linked-app` | Nova can't bring in a linked app | {app} is a linked app. CommCare HQ rewrites it from another app each time that one is pulled, so nothing Nova published to it would stay. | You can bring in the app it is linked from instead. |
| `remote-app` | This app isn't kept in CommCare HQ | {app} is hosted outside CommCare HQ, which only links to it, so there's nothing here for Nova to bring in. | You can go back and choose another app from {space}. |
| `rate-limited` | CommCare HQ is busy | CommCare HQ asked Nova to slow down, and it was still busy after Nova waited. | You can check again in a few minutes. Nothing was changed. |
| `hq-unavailable` | CommCare HQ didn't answer | Nova couldn't finish reading from CommCare HQ. It didn't answer in time, or it sent something Nova couldn't read. | You can check again. If it keeps happening, CommCare HQ's status page may say why. |
| `hq-gateway-refused` | A security gateway turned Nova away | A security gateway in front of CommCare HQ turned Nova's request away before CommCare HQ saw it, so it says nothing about your key or your permissions. | You can check again in a few minutes. If it keeps happening, Dimagi support (support@dimagi.com) can help. |
| `browser-only` | CommCare HQ sent a page meant for a browser | Nova asked {space} for an app and CommCare HQ answered with a page meant for a person, as it does when a project space asks you to sign in another way or isn't active. | Opening {space} in CommCare HQ shows what it's asking for. Once that's settled, you can check again. |
| `changed-while-reading` | The app changed while Nova was reading it | Someone saved {app} in CommCare HQ while Nova read it, twice in a row, so Nova stopped short of mixing two versions. | You can check again once the edits there have settled. |
| `already-in-nova` | This app is already in Nova | {app} is managed by a Nova app already, and one CommCare HQ app is managed by one Nova app so two can't publish over each other. | `alreadyInNovaNext(detail.claim, formatDate)`, the table under this one. Stored as `next`: its sentence for an unknown holder. |
| `too-large` | This app is larger than Nova brings in | {app} is larger than the apps Nova brings in. That limit is Nova's, not the app's. | There is nothing for you to change in the app. If you'd like Nova to bring in an app this size, you can tell the team through Give feedback in Nova's account menu. |
| `menu-unreadable-in-hq` | CommCare HQ can't summarize this menu | CommCare HQ returned an error where its own summary of this menu's forms should be, so Nova has nothing sure to check its reading against. | Opening each of the menu's forms in CommCare HQ's form builder usually shows which one is broken. Once it saves cleanly, you can check again. |
| `app-unreadable-in-hq` | CommCare HQ can't summarize this app | CommCare HQ returned an error where its own summary of this app's forms should be, so Nova has nothing sure to check its reading against. | Opening the app's forms in CommCare HQ's form builder usually shows which one is broken. If they all open, Dimagi support (support@dimagi.com) can help. Then you can check again. |
| `shadow-disagrees` | A question's logic says two things | This question's logic and the copy the form builder keeps of it don't match, so Nova can't tell which one the author meant. | Opening the form in CommCare HQ's form builder and saving it makes them match. Then you can check again. |
| `media-file-unreadable` | CommCare HQ doesn't have this file | The app points at {name}, and CommCare HQ has no file there, so the app can't show or play it either. | You can upload the file again in CommCare HQ, or remove it from the app there, then check again. |
| `media-not-played-where-app-runs` | A media file doesn't play where this app runs | The app points at {name}, and no platform that can run the rest of this app plays that file's format. | You can replace it in CommCare HQ with a PNG or JPEG picture, an MP3 sound or an H.264 MP4 video, then check again. |
| `table-rows-unreadable` | CommCare HQ couldn't send this table's rows | CommCare HQ listed the lookup table {name} and then couldn't send its rows. A row that holds a field with no value is one cause Nova knows of. | You can open the table in CommCare HQ and fill in or remove that row, then check again. |
| `table-cell-unrepresentable` | A lookup table holds a character CommCare can't carry | The lookup table {name} in {space} holds a character CommCare can't carry in a value. | You can take that character out in CommCare HQ, then check again. |
| `table-choices-unusable` | A lookup table's rows can't be a question's choices | A question takes its choices from the lookup table {name} in {space}, and that table has no rows there, or has a row whose value is blank, starts or ends with a space or appears twice, or whose label is blank. | You can change those rows in CommCare HQ, then check again. |
| `no-platform-runs-everything` | No one platform runs this whole app | This uses {name}. Part of this app runs only in Web Apps and part only on Android, so workers on either would meet something that doesn't work. | You can change one of these in CommCare HQ so one platform runs everything, then check again. Under `detail.reason: "split-refused"`: You can change how the date and time question {question} reads its own answer in CommCare HQ, then check again. |
| `places-over-nova-limit` | This project space has more places than Nova takes | {app} reads places, and {space} has {name}. Nova holds up to 10,000 for an app. | There is nothing for you to change. You can check again after a Nova update. |
| `place-not-holdable` | A place or level is one Nova can't hold yet | {name} in {space} has a code, a name or a value Nova can't hold yet. | There is nothing for you to change. You can check again after a Nova update. |
| `owner-rule-needs-one-place` | An owner rule needs exactly one place | {app} gives a case to the place at the level {name} below its current owner. In {space} that isn't exactly one place everywhere, and Nova holds the rule only where it is. | There is nothing for you to change. You can check again after a Nova update. |
| `unrecognized` | Nova met something it doesn't know | Nova found something in this app it has no reading for yet. That gap is Nova's, and it has been reported to the team with what it was. | There is nothing for you to change. You can check again after a Nova update. |
| `read-back-differs` | Nova couldn't confirm what it read | Nova read {app}, and one of Nova's own checks on what it read didn't pass. That's Nova's mistake, not the app's, and it has been reported to the team. | You can check again after a Nova update. |

For `table-cell-unrepresentable` and `table-choices-unusable`, `{name}` is the whole `detail.name`,
so a body reads "The lookup table regions (the field district_name) in ...". For
`no-platform-runs-everything`, `{name}` is the feature's label in curly quotes and the platform that
cannot run it, so a body opens "This uses “Date and time questions”, which Web Apps can't run."; the
labels are headings (`lib/domain/platforms.ts`), which a bare label mid-sentence would read wrong.
`too-large`'s next step names a thing the person can do today: Give feedback is the account menu's
own link (`components/ui/AccountMenu.tsx`). Where a wait is on Nova, every block says "after a Nova
update", which promises no particular one.

**`already-in-nova`'s next step** (`alreadyInNovaNext`). `{name}` is the one contact's name,
`{names}` the contacts' names in words, and `{date}` is `formatDate(claim.at)`. The two `elsewhere`
sentences are also the lines the picker shows under its mark for the same view (part 10,
`10-identity-and-the-ledger.md`, "Copy", "The picker's marks"; part 13 places them), so the picker
and a reading say one thing: they live here, part 10's `lib/publish/hqAppClaims.ts` exports the row
labels and no line, and the picker calls `alreadyInNovaNext(claim, formatDate)`.

| `detail.claim` | Next |
|---|---|
| absent (the holder could not be read) | You can check again in a moment to see where it is. |
| `open` | It's {appName}, in a Project you're part of. You can open it from your apps. |
| `elsewhere`, contact `person` | {name} has had it in Nova since {date}. You can ask {name} to invite you, or to stop publishing to it from Nova so you can bring it in yourself. |
| `elsewhere`, contact `owners` | It has been in Nova since {date}. {names} can invite you, or stop publishing to it from Nova so you can bring it in yourself. |

`no-platform-runs-everything` has a second next step, which `circumstanceBlock` gives where the
finding carries `detail.reason: "split-refused"` (8.4): "You can change how the date and time
question {question} reads its own answer in CommCare HQ, then check again." It is a string of
`hqFindingCopy.ts` beside the block.

### 9.4 The kept list

`lib/publish/keptValues.ts` (new, client-safe, importing nothing of `lib/deployment` or
`lib/commcare`) holds the lead sentence, the row sentences, the labels and the refresh's sentences,
which the card, the review and MCP all read:

```ts
/** The label ids, in the order of the labels table below. */
export const KEPT_LABEL_IDS = [ /* the first column of the labels table, in its order */ ] as const;
export type KeptLabelId = (typeof KEPT_LABEL_IDS)[number];
export const KEPT_LABELS: Readonly<Record<KeptLabelId, string>>;

/** The sentence above the list ("Lead, with labels"), or the one that says there is none. */
export function keptLead(date: string, hasLabels: boolean): string;
/** "Under either". */
export const KEPT_FOLLOWS_LINE: string;
/** "No answer": the request never reached Nova's server, or its answer never came back. */
export const KEPT_REFRESH_NOT_REACHED: string;

/** The kinds of `lib/deployment/service.ts::KeptRefreshOutcome`, restated so this file stays client-safe. */
export type KeptRefreshKind =
	| "refreshed" | "changed-in-hq" | "superseded" | "no-baseline" | "app-gone" | "unreadable"
	| "too-large" | "browser-only" | "key-not-accepted" | "no-permission" | "unavailable";

/** A kept list's labels and a digest of every value behind them (`DeploymentKept` carries both). */
export interface KeptListValues {
	readonly labels: readonly KeptLabelId[];
	readonly valuesDigest: string;
}
/**
 * Whether anything kept differs: the labels, their order, or a value under a label listed on both
 * sides. No list on either side is no change; a list on one side only is one.
 */
export function keptChanged(before: KeptListValues | null, after: KeptListValues | null): boolean;

export function keptRefreshSentence(
	outcome: {
		readonly kind: KeptRefreshKind;
		/** For `refreshed`: `keptChanged` of the list shown before the refresh and the one after. */
		readonly changed: boolean;
	},
	context: {
		/** The baseline's date, formatted for the reader as below. */
		readonly date: string;
		/** The project space's name. */
		readonly space: string;
	},
): string;
```

`service.ts` holds a type-level check that `KeptRefreshOutcome["kind"]` is exactly `KeptRefreshKind`.
`DeploymentKept` (6.5) carries `valuesDigest` beside its labels and date:
`lib/deployment/targetFacts.ts::deploymentKeptOf(facts)` takes it as the canonical JSON digest of the
facts with `observedAt` left out, so a sign-in that now lasts an hour where it lasted a day, a second
screen reworded or a base URL moved reads as a change under the labels it was already listed by. The
Publishing card compares the list it drew with the refreshed one, and MCP the list of the facts it read
before the refresh with the one after, both through `keptChanged`; MCP's projection does not carry the
digest.
The three raised sentences are `DeploymentError` messages, written where `refreshKeptValues` raises
them. The date is the viewer's locale date of `observedAt`, as "10 November", with the year where it
is not the current one ("10 November 2025"); MCP gives the ISO date.

| Where | String |
|---|---|
| Lead, with labels | These stay as they are in CommCare HQ, as it held them on {date}: |
| With no label | Every setting CommCare HQ keeps for this app matches a new app's, as it held them on {date}. |
| Under either | Nova doesn't change these when it publishes. A CCZ made for this project space follows them. |
| Button | Refresh from CommCare HQ |
| Button, while reading | Reading from CommCare HQ |
| Outcome `refreshed`, something kept changed (`keptChanged`) | Updated. This is what CommCare HQ holds now. |
| Outcome `refreshed`, nothing kept changed | Nothing has changed. This is still what CommCare HQ holds. |
| Outcome `changed-in-hq` | part 15's C1, `lib/publish/hqChangesCopy.ts::KEPT_CHANGED_IN_HQ` (`15-changes-made-in-commcare-hq.md`, section 9.6, which holds its words). The card draws part 15's button C2 beside it. |
| Outcome `superseded` | A publish or another read of CommCare HQ landed here while Nova was reading, so this is the latest Nova has. |
| Outcome `no-baseline` | Nova hasn't read this app from CommCare HQ since its last publish here, so it has nothing to refresh. Publishing again reads it. |
| Outcome `app-gone` | CommCare HQ no longer has this app in {space}. Check status shows where things stand. |
| Outcome `unreadable` | CommCare HQ answered with something Nova couldn't read as this app, so these stay as of {date}. Opening the app in CommCare HQ shows whether it still opens there. |
| Outcome `too-large` | This app is larger than Nova reads from CommCare HQ, so these stay as of {date}. That limit is Nova's, not the app's. You can tell the team through Give feedback in Nova's account menu. |
| Outcome `browser-only` | CommCare HQ answered with a page meant for a browser, as it does when {space} asks you to sign in another way or isn't active, so these stay as of {date}. Opening {space} in CommCare HQ shows what it's asking for. Then you can refresh again. |
| Outcome `key-not-accepted` | CommCare HQ didn't accept your saved API key, so these stay as of {date}. You can save a new key in Settings, then refresh again. |
| Outcome `no-permission` | CommCare HQ didn't let your account read this app, so these stay as of {date}. Reading it needs permission to edit apps in {space}. You can check the connected account, then refresh again. |
| Outcome `unavailable` | Nova couldn't reach CommCare HQ just now. You can try again in a moment. Nothing was changed. |
| Raised, `hq_not_connected` | CommCare HQ isn't connected on your account, so Nova can't read these again. You can add your API key in Settings, then refresh. |
| Raised, `domain_not_authorized` | Your CommCare HQ API key can't reach “{space}”, so Nova can't read these again. What you see is the last thing Nova saw. |
| Raised, a key on another server | `assertCredentialsMatchServer`'s sentence, as Check status prints it |
| No answer (the card's request never reached Nova's server, or its answer never came back) | Nova couldn't reach the server to read these again. You can try again in a moment. |

The labels. `KEPT_AT_HQ`'s rows name them by id (section 5), and `KEPT_LABELS` words them:

| `KeptLabelId` | `KEPT_LABELS` | Row |
|---|---|---|
| `automatic-app-updates` | Automatic app updates | `1-properties-cc-autoup-freq` |
| `sent-form-retention` | How long sent forms are kept | `4-properties-cc-days-form-retain` |
| `device-logging` | Device logging | `5-properties-logenabled` |
| `automatic-sync` | Automatic sync | `13-properties-cc-autosync-freq` |
| `media-check-at-install` | Media check at install | `17-properties-cc-content-valid` |
| `unsent-form-warning-count` | Unsent form warning, by count | `18-properties-unsent-number-limit` |
| `unsent-form-warning-days` | Unsent form warning, by days | `19-properties-unsent-time-limit` |
| `image-resizing` | Image resizing | `22-properties-cc-resize-images` |
| `fuzzy-search` | Fuzzy search in case lists | `23-properties-cc-fuzzy-search-enabled` |
| `sign-in-duration` | How long a sign-in lasts | `25-properties-cc-login-duration-seconds` |
| `image-scaling` | Image scaling | `26-properties-cc-inflation-target-density` |
| `location-capture-accuracy` | Accuracy for automatic location capture | `27-properties-cc-gps-auto-capture-accuracy` |
| `default-map-layer` | Default map layer | `28-properties-cc-maps-default-layer` |
| `text-to-speech` | Text to speech | `29-properties-cc-enable-tts` |
| `required-question-asterisk` | Asterisk on required questions | `30-properties-cc-label-required-questions-with-asterisk` |
| `case-detail-view-logging` | Logging of case detail views | `24-properties-cc-log-entity-detail-enabled` |
| `reworded-commcare-screens` | CommCare's own screens, reworded | `translations-key-in-a-runtime-s-ui-string-catalog-core-android` |
| `android-logos` | Android logos | `logo-refs-hq-logo-android-home-login-demo` |
| `mobile-report-version` | Mobile report version | `49p-hq-mobile-ucr-restore-version-1-0-1-5` |
| `location-with-every-form` | Location captured with every form | `45p-hq-auto-gps-capture-on-an-app-that-is-not-a-connect-app` |
| `persistent-menu` | Persistent menu in Web Apps | `51-hq-persistent-menu` |
| `web-apps-breadcrumbs` | Breadcrumbs in Web Apps | `52-hq-show-breadcrumbs` |
| `secure-submissions` | Secure submissions | `43-hq-secure-submissions` |
| `custom-base-url` | Custom base URL | `36-hq-custom-base-url` |
| `practice-mobile-worker` | Practice mobile worker | `35-hq-practice-mobile-worker-id` |
| `worker-activity-credential` | Worker activity credential | `32-features-credentials` |
| `language-names` | Language names | `translations-lang-code-any-other-value-or-absent-where-hq-s` |

### 9.5 The `.ccz`'s advisories (`exportAdvisories.ts`)

| Id | Title | Message |
|---|---|---|
| `kept_ui_text_falls_back` | Some of CommCare's own wording differs in this file | This project space rewords some of CommCare's own screens. This CCZ carries each rewording it holds. Where a language has none, an app installed from CommCare HQ shows CommCare HQ's translation and this file shows the phone's built-in wording. |
| `kept_android_logos_absent` | This file has no Android logos | This project space's app has its own logos for the Android home, sign-in or practice screen. They live in CommCare HQ, so this CCZ shows CommCare's own. An app installed from CommCare HQ shows yours. |
| `kept_practice_worker_absent` | Practice mode uses CommCare's sample worker in this file | This project space's app has a practice mobile worker. That worker's data lives in CommCare HQ, so practice mode in this CCZ opens CommCare's own sample worker. |
| `kept_language_names_differ` | Some language names may differ in this file | CommCare HQ names a language itself where this app gives none, and this CCZ uses Nova's name for it. The language picker may show a different spelling than an app installed from CommCare HQ. |

### 9.6 MCP

`refresh_deployment`'s description gains, after its last sentence: "Pass `kept_values: true` to read
again the settings this project space keeps in CommCare HQ (the `kept` list of `get_deployment`)
without asking about builds. It updates them only where nothing Nova publishes has changed in CommCare
HQ since the last publish, and says so otherwise." The input: `kept_values`, optional boolean,
described "Read the project space's kept settings again, in place of the build and release check."
`get_deployment`'s description gains: "`deployment.kept` lists the settings that stay as CommCare HQ
holds them on that project space, with the date Nova read them." `upload_app_to_hq`'s new refusal and
the sentence its description gains are in 7.4.

### 9.7 Public docs

`content/docs/building-with-nova.mdx`, the section "Preview on Web Apps and Android", gains one
paragraph: "Preview marks a required question the way the platform it is playing does. Web Apps marks
every required question with an asterisk. An Android phone marks them only where the app's CommCare HQ
setting for it is on, which a new app's is not, so on Android a required question looks unmarked until
the worker tries to move past it. Once the app is published to one project space, Preview follows
that project space's setting. Preview's case list search follows its fuzzy search setting the same
way: with it on, a near miss of four letters or more still finds its case, as it does for a worker.
On Android the closest matches come first, and in Web Apps the list keeps its own order."

`content/docs/publishing.mdx` gains a section "What stays as it is in CommCare HQ": "Some of an app's
settings are CommCare HQ's to keep: how often phones update, fuzzy search in case lists, your rewording
of CommCare's own screens, your Android logos and a few more. Nova doesn't change them when it
publishes, so you can keep setting them on the app's Settings page in CommCare HQ. The Publishing
section lists the ones your project space holds differently from a new app, with the date Nova last
read them, and Refresh from CommCare HQ reads them again. A CCZ you download for that project space
follows them. Two things it can't carry, your Android logos and a practice mobile worker, it tells you
about when you download it. An app you brought in from CommCare HQ keeps these settings exactly as it
had them, including the ones it never set. Nova fills in its own defaults only on an app it created
there." The last two sentences are the rule of 7.3.

`content/docs/case-workspace.mdx`, "Group cases under a connected case", the first of the four
things to know becomes: "**Choosing a group uses its first case.** With Several cases, each group
has one checkbox and adds its first case. The other rows are there to read, not to choose. When
someone filters the list, a group shows only the cases that match, so its first case is the first
match: the heading is drawn from it, choosing the group uses it, and the groups are ordered by
it. If people need to choose every case separately, keep the ungrouped tile."

The pages a build profile's stop changes (`publishing.mdx`, `languages.mdx`, `mcp/tools.mdx` and
`claude-code/commands.mdx`) are in 7.4, with their words.

---

## 10. Tests

Each test names its boundary and the failure it would catch. None renders a component in jsdom. The
tests of a build profile's stop are in 7.4, with the rest of that rule.

**The manifest and the findings**

| Test | Boundary | Catches |
|---|---|---|
| `lib/commcare/surface/__tests__/standing.test.ts` | pure | `standingOf` over one planted entry per disposition and per reason kind, and the two mixed entries by id: a kind moved between the lists, or a new kind in `REFUSAL_REASON_KINDS` with no group (also a compile error). `fixCauseOf` over one planted entry per row of 2.1's cause table, a planted entry holding both groups under conditions (`either`), and `null` for every entry that is not `fix-in-hq` |
| `surface/__tests__/manifest.test.ts`, the four rules of 2.6 | pure, over the real manifest | each rule with its planted failing entry: a HELD-NEW entry without a class on a shared key; an unused subject; a new mixed-reason entry; a version-floor reason beside another fix kind |
| `surface/__tests__/manifest.test.ts`, "parses no entries file that breaks the schema" (extended) | pure | a planted HELD-NEW entry without `subject`, a planted REFUSED one without it, a planted HELD-NEW one without `owner`, and a planted HELD entry that names a subject: each fails to parse, and the first three with the message of 2.6 |
| `surface/__tests__/manifest.test.ts`, the re-cut entries | pure | the two new inert entries and the build-profiles split parse, name existing keys, and overlap no class of their key; the `xmlns` entry holds no `slotChanges` |
| `lib/publish/__tests__/hqFindingCopy.test.ts` | pure, over the real manifest (`loadManifest`) | both directions of completeness. For `not-yet` and `never`: every `(subject, standing)` an entry gives has a sentence in `FINDING_COPY`, and every sentence's pair is given by some entry. For `fix-in-hq`: `fixInHqSentence` answers for every `(subject, fixCauseOf(entry))` an entry gives; every stem's subject and every whole sentence's pair is given by some entry; no subject holds both a stem and a whole sentence for every cause its entries give. Every stem ends in " is" or " are"; every clause begins "set up in a way" and ends with a full stop; `fixInHqSentence` returns a stem, one space and a clause, or a whole sentence. No two labels of `SUBJECT_LABELS` are equal. `alreadyInNovaNext` answers for an absent claim and for each of the three other rows of 9.3's table, and no answer holds a `{`. `circumstanceBlock` answers for every member of `READ_CIRCUMSTANCES`, with `app` a name and with `app` null, and with `detail.name` set where the code's row holds `name`: three strings with no `{` in them; it gives `alreadyInNovaNext`'s answer for `already-in-nova`, and the second sentence of `no-platform-runs-everything` under `detail.reason: "split-refused"` with the question's name in place of `{question}`. A template of `CIRCUMSTANCE_COPY` holds `{name}` exactly where the code's row holds `name: "body"`. `findingLine` answers `named` as `detail.name` for a manifest finding and for each code whose row holds `name: "line"`, and null for each code whose row holds `body` or `internal`. And the voice rules a machine can hold, each over the strings it fits, `ACCOUNT_CHECK_AGAIN_LINE` among them: no em dash, no ellipsis and no "import" as a word, in every string; sentence case at the start, in every string; a full stop at the end, in every sentence, body and next step (a stem joined to each clause it takes counts as a sentence), and none at the end of a label, a title or a stem |
| `lib/publish/__tests__/hqFindings.test.ts` | type-level and pure | `circumstanceFinding("too-large", place, { name: "x" })`, `circumstanceFinding("unrecognized", place, {})`, a `claim` on `key-not-accepted` and a `reason` on `unrecognized` each fail to compile (`// @ts-expect-error`). The finding `circumstanceFinding` returns holds the standing of its code's row, for every code. `cutFindingName` returns a name of 200 characters or fewer unchanged and a longer one at 200 characters, the last `…`. Each member of `NOVA_FAULT_CIRCUMSTANCES` is `not-yet` and holds no owner. A type-level check holds part 10's `HqAppClaimView` to `HqAppClaimDetail` with `remoteAppId` added |

That a block exists for every code and a label for every subject is the compiler's: `CIRCUMSTANCE_COPY`
and `SUBJECT_LABELS` are records over the closed lists. Two tests of part 05's hold the other half of
the codes (`05-reading-commcare-hq.md`, its tests): the set `hqReadCircumstance` returns over every
kind, request and permission is exactly thirteen codes, and no template of a code a picker stop can
be holds `{app}`.

**Kept at CommCare HQ's value**

| Test | Boundary | Catches |
|---|---|---|
| `lib/commcare/surface/__tests__/keptAtHq.test.ts` | pure, over the real manifest | the binding, both ways: every TARGET-OWNED entry has a `KEPT_AT_HQ` row and every row names a TARGET-OWNED entry; every `setting` row with a `label` is reached by `keptListFor` for some planted `TargetFacts`; every cell that names an advisory names an id `exportAdvisories` can return; every `mirrors` cell's `by` and every `reads` cell's `by` names an exported symbol; a planted TARGET-OWNED entry with no row fails. The base rule: every row names a base of part 14's 6.2, and part 14's `lib/commcare/surface/__tests__/entryCoverage.test.ts` (its section 7.5, rule 2) holds each `base` to a base whose `claimed` holds the entry |
| `lib/commcare/__tests__/targetFacts.test.ts` | pure, over the retained read `proof/hq-reads/case-list-inline/app-source.json` and edits of it. The file is an HTTP envelope (`status`, `headers`, `body`), so the test takes `body` and normalizes it with `normalizeHqAppSource`, as a stored baseline is | `targetFactsFromSource`, each row of 6.1's table: a setting at another choice, the numeric `10`, a boolean `true` and `false`; a runtime UI text key, a `target` key no runtime reads (in `uiText`, not in `uiTextKeys`) and a generated key in `translations`; each logo slot; `auto_gps_capture` under each ownership; a custom base URL with a path, with a trailing slash, with no scheme, with credentials, an upper-case host and an explicit `:443` kept as stored, with an upper-case scheme lower-cased, and with no netloc; a credential level; `languageNames` null and `seeds` `"nova"` with `adopted` false, and a held language name and `seeds` `"target"` with it true; a source that is no object gives `null`. `isRuntimeUiStringKey`: a key the surface holds with a reader, a key under a `.*` item, a key of HQ's catalog no runtime reads, an unknown key |
| `lib/deployment/__tests__/targetFacts.test.ts` | pure | `targetFactsFromBaseline`: `create` gives `null`; `push`, `cutover` and `read` give the source's facts with the baseline's `observedAt`, its ownership of `auto_gps_capture` and the mapping's `adopted`. `keptListFor` over planted facts: each label id under its predicate, none for facts at every default |
| `lib/deployment/__tests__/targetFacts.postgres.test.ts` | real Postgres | `readTargetFacts` answers a viewer and refuses a non-member; returns `null` for no row, an `unread` row and a row whose digest does not verify; a second read of an unchanged row selects no `source_gzip` (the query log shows one statement); a rewritten baseline is read afresh |
| `lib/deployment/__tests__/refreshKeptValues.postgres.test.ts` | real Postgres, HQ answered by the controlled client the publish tests use | `refreshed` rewrites source, digest and `observed_at` (the instant taken before the request) and keeps origin, a `cutover` one included, ownership and a stored discard, and notifies the deployment lane; `changed-in-hq` (a form edited in the answer) writes nothing; a recorded file whose id moved answers `changed-in-hq` with no file read, and a path with no record does not; `no-baseline` for no live mapping, for an `unread` and a `create` baseline and for a baseline of another remote app; `app-gone`; `unreadable` for a linked app's answer and for a malformed one; `key-not-accepted` for a 401; `no-permission` for a 403; `browser-only` for a page meant for a person; `unavailable` for a 500 and a timeout; each writes nothing. `superseded`: a publish's baseline written between the refresh's comparison and its write is kept, and the answer carries the deployment as that publish left it, and so is another refresh's that read something else. A refresh whose answer arrives after a publish's read-back, having been asked before it, does not replace it, and answers `refreshed` where that read-back is its own read. Two refreshes whose later-asked one lands first both answer `refreshed`, over an unchanged project space and over a kept setting turned on, and the later read's date stands. The three raised `DeploymentError`s (no key, a key that cannot reach the project space, a key on another server) write nothing. A viewer is refused |
| `lib/commcare/__tests__/keptProfile.test.ts` | pure | `targetProfileProperties` with no facts equals `appProfileProperties`; with facts, each seeded key takes the target's value and keeps its `force`; the two owned settings never move; the log setting appears only when held; the first fifteen of `KEPT_PROFILE_PROPERTY_KEYS` equal `SEEDED_PROFILE_PROPERTIES`' keys in order; with `seeds: "target"` a seeded key the facts hold no value for is left out |
| `lib/commcare/__tests__/runtimeTarget.test.ts` (extended) | pure | `PostURL` on the secure receiver; all three URLs on a custom base's scheme and netloc; `cc_user_domain` unmoved. The vectors are worked from `urljoin`: a base of `https://example.org`, of `https://example.org/`, of `https://example.org/hq/` and of `https://example.org:8443/x` give `https://example.org/a/<domain>/…` for the first three and `https://example.org:8443/a/<domain>/…` for the last; `https://relay:secret@proxy.example.org/hq/`, `https://Proxy.Example.org:443/` and `HTTPS://example.org` keep the credentials, the letters and the port, and give the scheme `https` |
| `lib/commcare/__tests__/keptArchive.test.ts` | wire through an independent consumer: the archive is unzipped and its `profile.ccpr`, each `app_strings.txt` and one form are parsed with `xmlParse.ts` and the locale reader | a `.ccz` compiled with facts holds the target's settings, the UI text in each language and in `default` (a stored text for `case_autoload.usercase.case_missing` in place of Nova's message), a held language name in every table, `cc:location` with its sensor, the secure `PostURL`, and the `<credentials>` block as the last child of `<features>` with the level and `type="APP_ACTIVITY"`; compiled with `null` it is byte for byte today's archive (the existing fixture) |
| the same file, a property | pure | for any source profile whose kept settings hold values of their own choices or values HQ's build writes nothing for (`null`, `""`, `false`, `0`, a list), the seventeen keys of `projectProfileForTarget(appJson, sourceProfile, "not-needed")` equal what `targetProfileProperties` writes from that source's facts: the publish and the archive cannot state different settings for one project space. The property runs under `seeds: "nova"` and `seeds: "target"`, with the facts' `seeds` to match |
| `lib/publish/__tests__/exportAdvisories.test.ts` (extended) | pure | each kept advisory appears exactly under its predicate; the attachment advisory stays first; `null` facts add none |
| `lib/publish/__tests__/keptValues.test.ts` | pure | every member of `KEPT_LABEL_IDS` has a label and no two labels are equal; `keptRefreshSentence` answers for every one of the eleven `KeptRefreshKind`s under both values of `changed`, `too-large` and `browser-only` are never worded as a passing fault, `superseded` names no publish, `keptChanged` finds a value moved under the same labels and a label added, taken away or moved, and `keptLead` under both of `hasLabels`, with no `{` placeholder left in an answer; and the voice rules of `hqFindingCopy.test.ts` over every string of the file and over the title and message of each `kept_` advisory: no em dash, no ellipsis, no "import" as a word, sentence case at the start, a full stop at the end of a sentence (the lead with labels ends in its colon) and none at the end of a label or a title. The two button labels of 9.4 are the card's own strings |
| `lib/mcp/__tests__/servedSchemas.test.ts` (updated snapshot) | pure | `refresh_deployment`'s `kept_values` and the two descriptions are what a client receives |
| `surface/__tests__/platformFeatures.test.ts`, `lib/preview/__tests__/platformCells.test.ts` | unchanged code | pass once the thirteen rows leave both tables; fail if one is left |

**Preview**

| Test | Boundary | Catches |
|---|---|---|
| `lib/preview/__tests__/listFilterMatch.test.ts` | pure, vectors worked from Core's source | `normalizeForFilter("José")` is `"jose"`; `fuzzyMatch("smith", "smyth")` matches at 1; `("smit", "smith")` at 1; `("smi", "smith")` does not (length 3); `("john", "johnathan")` matches at 2 after the cut to six characters; `("maria", "mark")` matches at 2; `("maria", "peter")` does not; a row matched exactly scores 0; with `fuzzy` off no near miss matches; an empty term passes a row with any text and fails a row whose every field is blank; no terms pass every row. `filterTerms`, vectors worked from Java's `String.split`: `"ann  lee "` is `["ann", "lee"]` under `whitespace-runs` and `["ann", "", "lee"]` under `single-spaces`; `" ann"` is `["", "ann"]` under both; `"ann\tlee"` is two terms under `whitespace-runs` and one under `single-spaces`; `"José"` is `["jose"]`; `""` is `[""]` under both, and `"  "` is `[]` under both |
| `components/preview/shared/__tests__/listFilter.test.ts` | state model: the function over production `Column`s and a `CaseListOrderPlan` from `caseListOrderPlan` | a field with no sort key is never matched fuzzily; a carrier's raw value is; order with `fuzzy` off is the input's; with `fuzzy` on, `closest-first` puts an exact match before a near miss that came first in the list, and `closest-among-ties` leaves the list's order between rows its order tells apart and puts the closer of two rows it ties first; all-space text keeps every row under both rules; an empty text keeps every row under `skipped`, and under `runs-once-edited` with `edited` false, and drops the row whose every field is blank under `runs-once-edited` with `edited` true |
| `lib/preview/__tests__/platform.test.ts` (extended) | pure | `listFilter` is `single-spaces`, `closest-among-ties` and `skipped` for Web Apps, and `whitespace-runs`, `closest-first` and `runs-once-edited` for Android; `requiredMark` is `always` for Web Apps and `by-setting` for Android. `requiredMarkShown`: true under `always` whatever the setting; under `by-setting`, false with `null`, false with `false`, true with `true` |
| `lib/preview/__tests__/caseTileGrouping.test.ts` (new) | pure, vectors worked from `EntityScreenHelper.java::groupEntities` and `views.js::CaseTileGroupedListView.initialize` | `tileGroupCards` over rows in list order Ada (K), Ben (R), Cal (K), Dot (R), Eve (`""`): all five give K [Ada, Cal], R [Ben, Dot], `""` [Eve]; the matches Ben, Cal, Dot give R [Ben, Dot] then K [Cal], so a card order kept from the unfiltered list fails, and K's `rows[0]` is Cal, so a heading or a choice kept from the group's first case fails; the matches Eve, Ada give `""` [Eve] then K [Ada], so the empty key is a key like any other; no rows give no cards. `groupedPageRows` over groups K [Ada, Cal], R [Ben, Dot] with `listOrder` Ada, Ben, Cal, Dot gives the rows in that order and each row's own key; a row `listOrder` does not name comes last |
| the same file, a property (`fast-check`) | pure | for any rows in list order with any keys, and any subset kept: every kept row is in exactly one card, all rows of a key share a card, each card's rows are in list order, and the cards are in the order of their `rows[0]`. With every row kept, the cards equal the groups a first-appearance clustering of the input gives, which is what `queryGrouped` returns, so the filtered and the unfiltered list cannot be drawn by two rules |
| `lib/case-store/postgres/__tests__/queryGrouped.postgres.test.ts` (extended) | real Postgres | `listOrder` on the seeded page is the flat order under the user's sort (Ada, Ben, Cal, Dot, Eve), equal to `query` under the same sort, where the groups read Ada, Cal, Ben, Dot, Eve: a `listOrder` built in clustered order fails. On a page of one group it names that group's rows alone (Ada, Cal): an order that reached other pages fails. On a page past the end it is empty. Under a descending sort it reverses, and it is a permutation of the page's case ids in every case above |
| `lib/collab/__tests__/previewTargetFactsFrame.test.ts` | pure | a malformed frame parses to `null`; `{ facts: null }` parses; a frame missing either fact parses to `null` |
| `app/api/apps/[id]/stream/__tests__/stream.postgres.test.ts` (extended) | real Postgres | the lane sends `preview-target-facts` on connect and after a baseline write that changes the fuzzy setting or the asterisk setting, and not after one that leaves both; a lane read that faults sends neither frame, and its retry announces nothing new |
| `lib/deployment/__tests__/previewTarget.test.ts` (new; `resolvePreviewDeploymentTarget`'s own cases stay in `setupArtifact.test.ts`, where they are today) | pure | `resolvePreviewFactsTarget`: one deployment; none; two domains; one domain on two servers gives `null` |
| `e2e/tests/app/preview-kept.spec.ts`, with its seed `e2e/lib/keptBaselineSeed.ts` beside the other app seeds | Playwright against the production server and the job's own Postgres: `e2e/tests/browser/` starts no server and no database (`e2e/CLAUDE.md`), and this journey needs `app_deployment_baselines` rows, the builder page's `previewDeploymentAnswerFor` and the Publishing section. The seed writes a reached deployment with a `push` baseline holding `cc-fuzzy-search-enabled: yes` and `cc-label-required-questions-with-asterisk: yes`, and a twin holding `no` for both | typing a near miss in Preview's list filter finds the case, and does not on the twin; with Preview on Android a required question carries the asterisk, and carries none on the twin, where Preview on Web Apps marks it on both; the Publishing card lists "Fuzzy search in case lists" and "Asterisk on required questions" with its date and the Refresh button; the twin's card reads the no-label sentence and still offers the button |
| `e2e/tests/app/authed.spec.ts`, "a grouped case list draws one card per group and opens the group's first case" (one step added, last; the seed is unchanged) | Playwright against the production server | typing `Referred` in "Filter results" leaves two cards: the first holds Ben and the second holds Cal, neither holds Ada or Dot; there are two card actions, and the second names Cal (its label matches `/View details for .*Cal/`) and opens Cal's Details. Today the cards stand in the other order and the second action names and opens Ada. This is the one place the wiring is held: the screen feeding the cards from rows in clustered order, `CaseTileGroup` drawing a heading from another row, or the action bound to another case each fail here and in no pure test |
| `proof/targeted/__tests__/targeted.test.ts` | unchanged code | holds `targeted-tile-group-filter` to admission with every other targeted document |
| the proof lane's intent check over `targeted-tile-group-filter` | Core's own `EntityScreen` over Nova's local archive, on every pull request | Core's rows under the filter are Ben, Dot, Cal: a pin move that changes the order of filter, sort and group, or a group key Nova's suite stops writing, fails by name |
| `proof/webapps/test_tiles.py::test_web_apps_makes_a_grouped_tiles_cards_from_the_rows_a_search_leaves` | HQ's own Web Apps client against Formplayer, in the lane's scheduled runs with the readers and in Run 4 | the client's half of the rule: after the search the cards are Ben's and then Cal's, each with its first match's id and its first match's heading. A client change that keeps another model for a group, or draws the heading from another, fails by name |

Fixtures that write a `GroupedQueryResult` by hand gain `listOrder`, which the compiler names:
`lib/preview/engine/__tests__/withSchemaHeal.test.ts` and
`lib/preview/app-tests/__tests__/searchResultsEntry.test.ts`. No test is added for
`readGroupedCases` handing `listOrder` on: the field is required, so dropping it does not compile.

What these tests do not hold, and what does: that a `mirrors` cell is true of HQ's real build is Run 1
and then proof 3 on the base `hq-kept-settings`; that each kept entry's clause 1 is true is proof 1 on
the HQ-authored bases against the first-publish register; that Core's fuzzy rule is ported right is
Run 2; that an adopted deployment is seeded nowhere is Run 3. How Android and Formplayer split the
typed text and order the matches is read at source and held by the vectors above, with no native run:
the two functions sit in each runtime's own screen code, outside what the native families load. That
the vectors of `caseTileGrouping.test.ts` are CommCare's rule is the lane's
`targeted-tile-group-filter`: Core's rows in the order the vectors assume, on every pull request,
and the client's cards, each one its group's first match, in the runs with the readers (Run 4).
What an Android phone draws for a required question is read at source (6.4) and has no device run
here: the mark is one branch on one preference in `QuestionWidget.java::setTextFromPrompt`.

---

## 11. Contracts and docs these changes make false

| Where | Sentence today | Replacement |
|---|---|---|
| `lib/commcare/CLAUDE.md`, "The surface manifest" | "its disposition (HELD, HELD-NEW, TARGET-OWNED, INERT or REFUSED), the slot change or the refusal's reason, the Web Apps and Android behavior, the gates it needs, and its emission." | adds: "A HELD-NEW or REFUSED entry names its `subject`, the noun a person reads (`lib/publish/hqFindings.ts::SUBJECTS`), and a HELD-NEW entry its `owner`, the step 7 group that will hold it. An entry's standing for a reading (`held`, `kept`, `inert`, `not-yet`, `never`, `fix-in-hq`) is derived by `surface/standing.ts::standingOf`, never written, and so is the cause of a `fix-in-hq` entry (`fixCauseOf`), which chooses the sentence a person reads." |
| same section | "`surface/__tests__/manifest.test.ts`, in ordinary CI, holds the entries to the schema and to the surface (…)" | the parenthesis gains: "every HELD-NEW and REFUSED entry names a subject, every subject is used, every HELD-NEW entry names an owner and carries a value class where it shares a key with an allowing entry" |
| same section | "A change to an entry edits its row in the inventory under `docs/research/2026-09-26-hq-round-trip/inventory/` in the same pull request" | adds: "`subject` and `owner` are fields of the manifest alone: the inventory has no column for either, and an edit to them alone moves no inventory row." |
| same section, new paragraph | (none) | "A TARGET-OWNED entry is content Nova leaves at CommCare HQ's value under the kept test: a publish never changes it, nothing the document holds does something different under it, and every Nova surface that shows or runs what it changes reads the target's value or says so. `surface/keptAtHq.ts::KEPT_AT_HQ` holds one row per such entry (what a `.ccz` does, what Preview does, what a first publish to another project space does, and the base that exhibits it), bound to the manifest by `surface/__tests__/keptAtHq.test.ts`." |
| `lib/commcare/CLAUDE.md`, "Runtime request destinations" | "The seventeen settings of `appProfileSettings.ts::appProfileProperties` follow in its order, each with the `force` its table gives." | "The seventeen settings follow in `appProfileProperties`' order, each with the `force` its table gives: the two the app owns at the app's value, and each of the fifteen others at the value the archive's project space holds, or Nova's where it holds none (`keptProfile.ts::targetProfileProperties`, over the deployment's `TargetFacts`), then `cc-log-entity-detail-enabled` where the project space sets it." |
| same paragraph | "its profile names that space's four server properties (`ota-restore-url`, `PostURL`, `key_server` and `cc_user_domain`, from `runtimeTarget.ts::profileServerProperties`)" | adds: ", on the scheme and netloc of the project space's custom base URL as HQ's `urljoin` keeps them and on its secure receiver where its app holds them" |
| same paragraph | "`<features>` opens with `<checkoff active=\"true\"/>`, without which a device hides its saved forms whatever the setting says." | adds: "It ends with the `<credentials>` block HQ's build writes where the project space issues a worker activity credential (`TargetFacts.credentialLevel`), which Android's work history reads." |
| `lib/commcare/CLAUDE.md`, "CommCare HQ project-space compatibility" | "(`cc-show-saved` and `cc-show-incomplete` always; a constant setting only where the target holds no value for it)" | "(`cc-show-saved` and `cc-show-incomplete` always; a constant setting only where the target holds no value for it, and never on a deployment whose app Nova brought in, where an absent setting stays absent)" |
| `lib/commcare/appProfileSettings.ts`, header | "the overlay (`targetOverlay.ts::projectProfileForTarget`) keeps a value the target already holds for any of the fifteen, and always writes Nova's two." | adds: "On a deployment whose app Nova brought in from CommCare HQ it writes none of the fifteen (`seeds: \"target\"`)." |
| `lib/deployment/CLAUDE.md`, "One publish lifecycle" | "`hqImportApplication` projects `profile`, `translations` and `add_ons` on the publish's last read of the app's source before the import" | adds: "On a deployment whose live app mapping is `adopted` it asks the overlay to leave the target's language names and its absent profile settings as they are (`languageNames: \"target\"`, `seeds: \"target\"`), so the first publish over an app Nova brought in changes neither." |
| `lib/commcare/CLAUDE.md`, "CommCare HQ project-space compatibility" | "Seventeen ordinary profile properties are stated by `appProfileSettings.ts::appProfileProperties`: `cc-show-saved` and `cc-show-incomplete` are app content (`appSettings`), and the other fifteen are constants, each the value a device reads when the key is absent." | "…and the other fifteen are CommCare HQ's to keep: Nova states its own value, the one a device reads when the key is absent, only where a project space holds none." |
| `lib/commcare/CLAUDE.md`, "Form `<meta>` block" | "For a Connect app the local block also captures location, as HQ's build does" | "For a Connect app, and for an app whose project space captures location with every form (`TargetFacts.autoGpsCapture`), the local block also captures location, as HQ's build does" |
| `lib/export/CLAUDE.md` | "(`compileLocalArchive(prepared, runtimeTarget, identity, deployment)`, the target, that deployment's ids and the reached target's `emptyCaseListText` and `earlierHqApps` required)" | "…and the reached target's `emptyCaseListText`, `earlierHqApps` and `targetFacts` required; `targetFacts` is what the project space holds of the values Nova leaves to CommCare HQ, or `null` where Nova has not read them" |
| `lib/deployment/CLAUDE.md`, "Baselines" | (after "It holds no form ids…") | adds: "`targetFacts.ts::targetFactsFromBaseline` projects the stored source to `TargetFacts`, what the project space holds of the values Nova leaves to CommCare HQ. `store.ts::readTargetFacts` returns that projection to a viewer and never the source. A `.ccz`, Preview and the Publishing card read it; an absent, unread or shell baseline gives none, and Nova's own values stand. `service.ts::refreshKeptValues` replaces the baseline with a fresh read only where the publish's own comparison finds no change, so it moves no later drift verdict. Its write (`store.ts::recordRefreshedAppBaseline`) lands only while the stored baseline is still the one compared, and its date is taken before CommCare HQ is asked, so a read that predates a publish never replaces that publish's. The type and the reading of CommCare HQ's own keys are `lib/commcare/targetFacts.ts`'s." |
| `lib/deployment/CLAUDE.md`, "Two things the record answers besides publishing" | the three bullets | a fourth: "`previewSpace.ts::readPreviewDeploymentAnswer` names, from one read of the records, the project space and what Preview may read of its kept values, for the one reached `(server, domain)` or not at all. It throws on a fault, so the stream's lane retries rather than announcing a failed read as `null`." |
| `lib/preview/CLAUDE.md`, "`commcare_project` comes from the deployment record" | "Preview names the project space a worker signed into exactly when one deployment of this app has reached `uploaded`" | adds a paragraph: "The same rule carries two kept settings. Fuzzy search in case lists: the list filter is Core's entity filter (`lib/preview/listFilterMatch.ts`), with accents folded, every term required, and with the project space's `cc-fuzzy-search-enabled` on, a near miss matched against each sorted field's words. The platform rule `listFilter` holds what each runtime does around it: Web Apps splits the typed text on single spaces, keeps the list's own order and skips an empty text; Android splits on runs of whitespace, puts the closest matches first and, once the worker has typed, runs an emptied box as one empty term. The asterisk on required questions: the platform rule `requiredMark` marks every required question in Web Apps and, on Android, only where the project space's `cc-label-required-questions-with-asterisk` is `yes` (`requiredMarkShown`). The facts arrive as the `preview-target-facts` frame and through `DeploymentTargetProvider`; with none, the filter is exact and Android shows no mark." |
| `lib/preview/__tests__/platformCells.ts`, the constant `PROFILE_PROPERTY_ONLY_ANDROID_READS` | "A profile property only Android reads; Preview reads no profile property." | removed with its thirteen rows; the two remaining profile rows (`20`, `21`) keep their own reasons |
| `lib/commcare/runtimeTarget.ts::profileServerProperties`, comment | "with the receiver URL in its plain form because every app Nova imports has `secure_submissions` off" | section 6.3's sentence |
| `lib/commcare/appProfileSettings.ts`, header | "On a publish they are seeded, not owned" | adds: "and a `.ccz` made for a project space writes that space's value (`keptProfile.ts`)" |
| `lib/deployment/CLAUDE.md`, "The Builder splits the work", and the same card sentence in `components/builder/CLAUDE.md`'s Publishing section paragraph ("renders one full `DeploymentStatus` card per project space the app has reached") | "one full `DeploymentStatus` card per project space the app has reached, with Check status, the Workers panel, and a \"Publish again\"" | adds: ", and the list of what stays as it is in CommCare HQ with its date and Refresh from CommCare HQ" |
| `docs/architecture/contracts.md`, "Nova is not CommCare HQ." | (the two HQ facts) | a new paragraph after it, in these words: "**Some of an app stays CommCare HQ's.** Content outside an app's menus that Nova's publish never writes is kept at CommCare HQ's value only when three things hold: no publish changes it on that project space; nothing the document holds does something different under its value; and every Nova surface that shows or runs what it changes reads the project space's value or says how it differs. `lib/commcare/surface/keptAtHq.ts::KEPT_AT_HQ` holds one row per kept entry with what a `.ccz` does, what Preview does and what a first publish to another project space does, and a test binds it to the manifest both ways." |
| `docs/research/2026-09-26-hq-round-trip/inventory/*.md` | the rows of section 3 | as section 3 words them; the Counts table stays the research's |
| `content/docs/publishing.mdx`, `content/docs/building-with-nova.mdx`, `content/docs/case-workspace.mdx`, `content/docs/mcp/tools.mdx` (`refresh_deployment`, `get_deployment` rows) |  | sections 9.6 and 9.7 |
| `../nova-plugin/skills/upload_to_hq/SKILL.md` (the sibling repo's skill that names `refresh_deployment` and `get_deployment`) | it says `refresh_deployment` "returns the same shape; report `state`", that it "can also answer with an ERROR instead of a state", and that `get_deployment` "reports every project space an app has been published to without contacting CommCare HQ" | none of the three is made false: a call without `kept_values` answers as before, a raised `DeploymentError` is still an error and no verdict on the app, and `get_deployment` still reads nothing of HQ. The skill gains, after its paragraph on `hq_app_empty` and `hq_app_gone`: "Each deployment can also carry `kept`: the settings that stay as CommCare HQ holds them on that project space, with the date Nova read them. Say them when the user asks what Nova leaves alone. `refresh_deployment` with `kept_values: true` reads them again and answers with a sentence instead of a state; relay it as it is." It also gains 7.4's item for `hq_build_profile_language_missing`. Both ride the step's one sweep of that skill, with its `plugin.json` bump (part 13, `13-the-experience.md`, section 16.2), and that pull request merges only after the Nova deploy that serves `kept_values` is live |
| `lib/commcare/surface/entries/gates.json`, `project-space-setting/Domain.commtrack_enabled`, `content` | "…(HQ's substring test, `entries.py::entry_for_module`); import asks the same from step 6" | "…(HQ's substring test, `entries.py::entry_for_module`)" (3.3) |
| `docs/research/2026-09-26-hq-round-trip/inventory/gates.md`, the paragraph "Publish also checks gates outside the app-building flags above" | "…(HQ's substring test, `entries.py::entry_for_module`), with import asking the same from step 6, by asking the person to confirm, that CommTrack is off in the project space (defect 20)." | "…(HQ's substring test, `entries.py::entry_for_module`), by asking the person to confirm, that CommTrack is off in the project space (defect 20)." |
| `lib/preview/CLAUDE.md`, "Case tiles in the running app", the bullet "A grouped tile draws one card per GROUP, and that card is one choice" | "`rows` stays the flat page in clustered order so every row-reading consumer keeps working, and the extra `grouped` slot carries the clustering plus a window whose unit is GROUPS while `totalCount` still counts cases." | adds: "The slot also carries `listOrder`, the page's case ids in the list's own order. Under the list filter the cards are made from the rows that remain, as Formplayer makes them (`EntityScreenHelper.java::initEntities` filters, sorts, then gathers groups): `caseTileGrouping.ts::groupedPageRows` puts the page back in list order and `tileGroupCards` clusters the matches, so the groups stand in the order of each one's first match and a card's first case, which draws its heading and is its one choice, is its first match." |
| `lib/preview/CLAUDE.md`, the paragraph on several-case Results | "A grouped tile is still one runtime choice whose id is the group's first case; its body rows remain display-only even in multiple-selection mode." | "A grouped tile is still one runtime choice whose id is the first case its card holds, the group's first match while the list is filtered; its body rows remain display-only even in multiple-selection mode." |
| `lib/case-store/CLAUDE.md`, "`queryGrouped`" | "It returns the groups plus `totalGroups` (the pager's denominator) and `totalRows`, all from one statement" | "It returns the groups, `listOrder` (the page's case ids in the user's sort, before clustering, which lets a reader re-cluster what a filter leaves of the page), `totalGroups` (the pager's denominator) and `totalRows`, all from one statement" |
| `docs/architecture/complex-apps.md`, the bullet "A group is ONE choice, and it opens the group's first case." | (ends) "rather than inventing a per-row selection the device does not have." | adds: "Formplayer filters before it groups (`EntityScreenHelper.java::initEntities`), so under the list's filter a group's first case is its first match, and the groups stand in the order of those matches. Preview makes its cards from the rows that remain by the same rule (`lib/preview/caseTileGrouping.ts::tileGroupCards`)." |
| `docs/architecture/complex-apps.md`, the paragraph on several-case selection | "A grouped tile remains one selectable group whose selection is its first case; its other body rows are display only." | "A grouped tile remains one selectable group whose selection is its first case, its first match while the list is filtered; its other body rows are display only." |
| `components/preview/screens/CaseListScreen.tsx`, the comments on `filteredGroups` and on `ResultsTileGroup` | "the ones that survive keep drawing their header from the group's OWN first case, because the header names the group rather than one of the matches" | removed with the code they describe |
| `components/preview/shared/CaseTileGroup.tsx`, header comment | "the tile's header rows once, from the group's first case" | "the tile's header rows once, from the first case the card holds, which under the list filter is the group's first match" |
| `lib/preview/engine/caseDataBindingTypes.ts::LoadCasesResult`, the comment on `grouped` | "this adds the clustering the tile renderer draws from" | adds: "and `listOrder`, the page's case ids in the list's own order, from which the renderer re-clusters what the list filter leaves" |
| `content/docs/case-workspace.mdx` | the bullet "Choosing a group uses its first case." | section 9.7 |
| `proof/README.md`, "Targeted documents" | (the paragraph that describes the documents the harness keeps) | adds: "`targeted-tile-group-filter` holds a grouped tile list with and without text in its filter: Core's rows, the groups in the order of each one's first match, and in `proof/webapps/test_tiles.py` the client's cards, each one its group's first match. It is the rule Preview's cards follow (`lib/preview/caseTileGrouping.ts::tileGroupCards`)." |

The contracts a build profile's stop makes false are in 7.4, with their words: `lib/deployment/CLAUDE.md`
("Preflight is a graph with two kinds of edge", "What the check cannot close"), `lib/commcare/CLAUDE.md`
("CommCare HQ upload"), the root `CLAUDE.md` and the inventory's `build_profiles` rows.

---

## Departures

Where this part departs from the outline, the research, a manifest cell or the code as it stands,
and the alternatives it weighed and did not take. Each item is a decision with its evidence. The
numbers are cited from other files, so none moves.

1. **`persistent_menu` and `show_breadcrumbs` are kept at every value.** Not done: holding either
   not-yet at a non-default value. That would be right only if `lib/preview` drew a persistent menu
   or Web Apps' breadcrumbs, since clause 3 of the kept test would then need Preview to read the
   value or say it does not. Preview draws neither, so both are kept. Evidence: 4.3.
2. **The Android logo slots are kept, though the `.ccz` cannot carry them.** The archive states it
   (`kept_android_logos_absent`, 9.5). Not done: holding them not-yet because the archive holds no
   bytes for them.
   Evidence: the kept test's clause 3 admits a stated difference; Nova writes nothing of a logo
   (`applicationShell`, `targetLogoRefs.ts`); the slots need a plan privilege, so they sit on exactly
   the apps of teams most likely to bring one in. Refusing those apps over a file no publish touches
   would be the opposite of the bar's purpose. `logo_refs` is one key, so this also gives it one
   reading: its Web Apps slot is held and its Android slots are kept (4.1).
3. **A media file over Nova's size limit is a manifest entry, not a circumstance.** The manifest
   names it
   (`expressions-and-data/an-imported-asset-larger-than-nova-s-per-kind-cap-or-an-app`), and bar clause
   (d) gives each item one standing from one source. The same holds for a table over Nova's caps. Both
   keep `not-yet` with owner `project-data-at-hq-size`. Not done: one circumstance for a media file
   that is unreadable or over the limit. The rule this states is about a circumstance
   that carries a standing (`not-yet`, `never`, `fix-in-hq`): it never names what a manifest entry
   names. A `stop` carries none, so the `stop`s for a linked and a remote app stand beside those
   documents' entries without giving anything two standings, and `media-file-unreadable` names a file
   HQ's map holds and cannot serve, which no entry names (8.3).
4. **An item no entry names is `not-yet`, under the circumstance `unrecognized`.** Nothing in
   CommCare HQ needs changing, and telling a person otherwise would be false. Not done: the standing
   `fix-in-hq`, which would send a person to change something no change in CommCare HQ lifts. It is
   Nova's to classify: its copy takes the blame and the reader logs it at error (8.3).
5. **"Refresh from CommCare HQ" updates the kept values only where nothing Nova writes has changed in
   HQ, and says so otherwise** (6.5). Not done: a refresh that always re-reads the source and updates
   `TargetFacts` without publishing. Evidence: a baseline is one read with one `observed_at`,
   `TargetFacts` is a projection of that row and adds no column (6.1), and a refresh that rewrote
   the baseline over an HQ-side change would silently erase the next publish's drift stop,
   which the drift contract of `docs/architecture/contracts.md` exists to keep. A refresh that spliced
   only the kept keys would need a second date the row has no place for.
6. **The finding copy and the vocabulary a person reads live in `lib/publish`.** The
   copy lives in `lib/publish/hqFindingCopy.ts` and the standings, subjects and finding type in
   `lib/publish/hqFindings.ts`. Not done: the copy in a file beside the account's components, or the
   subjects and the standings' words under `lib/commcare` (a `lib/commcare/surface/subjects.ts`, a
   `lib/commcare/reader/standing.ts`). Evidence: `biome.json`'s `noRestrictedImports` refuses any
   import of `@/lib/commcare/**` from `components/**` and `lib/publish/**`, MCP's `read_hq_app`
   returns the same sentences as the account, and `lib/commcare` already takes its public words from
   `lib/publish`. What derives a standing from an entry, `standingOf`, reads the manifest and stays
   in `lib/commcare/surface/standing.ts` (2.1).
7. **From the outline, item 1 ("refuses an app that carries a translation for a runtime UI-catalog
   key").** Such an app comes in: the keys are kept (3.6). The outline's reason, that Nova holds none,
   is the reason they are kept, not refused.
8. **From the outline, item 6 ("every `widen:` change a HELD row names").** Seventeen of the 45 are
   settled here by removing the widen: fifteen settings become kept (3.6), `Form.autoCaptureLocation`
   is left to the per-form entry that already names it and stays not-yet (3.6), and the `xmlns` row's
   widen goes because this plan gives a form no stored `xmlns` slot (3.3; part 10, sections 2 to
   4). The other 28 are part 04's (`04-names.md`).
9. **From the outline, item 9, "Defect 20's confirmations", item 10, "Confirmations", and items 2 to 5,
   7 and the cutover.** None is this part's: confirmations at adoption are recorded by part 10
   (`10-identity-and-the-ledger.md`, section 6.5) at the birth part 12 plans
   (`12-the-reading-and-the-birth.md`), the birth owner and the ledger are parts 10 and 12's, project
   data is part 11's (`11-project-data.md`), bringing in what changed in CommCare HQ is part 15's
   (`15-changes-made-in-commcare-hq.md`), entry points are part 13's (`13-the-experience.md`), the
   bases are part 14's (`14-proof.md`), and the cutover is replaced by derived ownership (part 11,
   Departure 5).
   That cutover is the outline's one-time move of existing deployments; the baseline origin
   `"cutover"` of 6.5 is a value `app_deployment_baselines.origin` holds today and is no part of it.
   Items 8 to 10's reading rules are the reader parts' (parts 06, 07 and 08); this part words the
   manifest rows they flip (3.5).
10. **This part adds no Python reader for the HELD-NEW value classes on shared keys** (2.4). Not
    done: one lane reader in `manifest_value_classes.py::VALUE_CLASSES` for each such class. Parity
    between the reader and the lane is part 14's (`14-proof.md`, section 8), on the uses Python
    decides, and the rest rests on variants (part 14, section 7).
11. **A `fix-in-hq` manifest finding carries its `cause`, and `fix-in-hq` copy is one sentence per
    subject and cause** (2.1, 8.4). Not done: a finding of `{ code, standing, place, subject, detail }`
    alone, with one sentence per subject and standing for all three standings. Evidence: the
    `fix-in-hq` standing joins `not-hq-editable` and `not-hq-buildable` with
    `broken-at-runtime`. By script over the manifest, 63 `fix-in-hq` entries are refused only because
    they break when run, 13 more for either reason by case, and five subjects hold nothing else
    (`case-sharing`, `connect-blocks`, `lookup-tables`, `search-expressions`, `question-media`), so
    "set up in a way CommCare HQ can't save or build" would be false of an app HQ builds. `not-yet` and
    `never` keep one sentence per subject.
12. **Permissions are three codes, and `READ_CIRCUMSTANCES` closes at thirty-four.** Permissions are
    three codes, chosen by the read (8.3): HQ says which permission only through which read it
    refused, and one sentence naming every permission would send a person to ask for ones they hold.
    Not done: one `permissions` code, or a list closed at the plain failures of a read. The parts
    that classify what they read each found facts no other code words truthfully and no manifest
    entry can name: part 05 seven answers of a read (an edge's refusal, a paused API, a browser page,
    a remote app, the organization's gates, an app HQ cannot summarize, a table whose rows HQ cannot
    send), part 06 one (no platform runs the whole app) and part 11 six facts of a project space's
    data. One more tells a stored key that does not list the project space from an account that is
    no member of it (`key-cannot-reach-space`): CommCare HQ said nothing in the first case, so
    `not-a-member`'s block, "CommCare HQ says your account is no member", would be false of it, and
    the person's step is in Settings and not with an admin. Not done either: a code for the birth's
    own refusal, or for a table choice left unanswered. The first is `read-back-differs` with a
    `birth-` name, one situation and one step for the person. The second is a refusal of the create
    (`choice_missing`, part 12), since no read raises it and no stop action serves it.
13. **From `targetOverlay.ts::projectProfileForTarget` as it stands, which seeds each of the fifteen
    settings wherever the target holds no value.** On a deployment
    whose app Nova brought in, a publish seeds none of the fifteen (7.3). Evidence: the seed turns an
    absent setting into a forced one, which resets a worker's own choice on the phone at every update
    (`appProfileSettings.ts`), and `Application.create_profile` writes nothing for an absent key. That
    is a change to what a runtime reads, which the bar's clause (b) admits only declared, and this
    plan reads the original's behavior exactly wherever it can before it declares a change (part 09,
    section 11.4, gives the three answers). Leaving the key absent is exact and needs no register
    entry. The same reasoning gives a language's display name its rule on an adopted deployment (7.2).
14. **Every sentence part 04's entries need is in 9.2, under a subject of the closed set.** Part
    04's subjects are slugs of the closed set (2.2's table). Not done: a new subject for each noun
    part 04's entries are about. Evidence: nine of its ten nouns are subjects that already exist, so
    one new subject (`case-types`) is added, not ten.
15. **`TargetFacts` holds no origin, and the kept list has one lead** (6.1, 6.5, 9.4). Not done: a
    `TargetFacts.origin` with a lead sentence per origin, one of them for an app brought in.
    Evidence: a refresh keeps a baseline's origin and moves
    its date, so "when Nova last published here on {date}" and "when Nova brought the app in on
    {date}" would each name a day that may be a refresh's. The one lead words the date without an
    origin ("as it held them on {date}", 9.4). `targetFactsFromBaseline` projects a `read` baseline
    as it does a `push` one, and part 10's drift wording dates "brought it in" from the mapping's
    `adoptedAt` and never from the baseline's `observedAt` (its section 9), which is what a refresh
    needs of it.
16. **A filtered grouped list is re-clustered from its matches, on the page Preview has read**
    (6.4). Three things not done.
    Not done: moving the groups and leaving each card's heading and choice on the group's own first
    case. That is the difference as it was first noted, and it is the smaller half. Web Apps' client
    never sees a row the filter removed, so its card is its first match in every respect; a Preview
    that moved the card and still opened a filtered-away case would show a journey no worker has.
    Evidence: `views.js::CaseTileGroupedListView.initialize`, `CaseView.rowClick`.
    Not done: a filter that reaches every page, as Formplayer's does. The filter matches the text a
    cell shows, which the browser makes from a row, so reaching every page means reading and
    projecting every case of the list on each change of the text, in a second place that chooses a
    page's rows beside the case store's compiler. Preview's page is its own window on every list and
    is said on screen and in the docs; a list of 50 groups or fewer is filtered whole. Evidence:
    `runtimeMessages.ts` (`filterPage`, `pageFilterScope`), `content/docs/case-workspace.mdx`,
    `lib/preview/CLAUDE.md` ("Quick Filter is explicitly page-local whenever more matching cases
    exist").
    Not done: the position on each row, or `rows` handed back in list order. A row travels to
    Details, to a form's case data and to an App Test's observation, where a position in one page
    read means nothing, and `rows` in clustered order is what those readers and App Tests'
    observations hold today. One list of ids on the grouped slot is the whole of what the screen
    lacked.
17. **Preview draws the asterisk a platform draws, and states no difference** (6.4). Not done: keeping
    the mark on every required question in Preview on Android and saying in the docs that a phone
    may show none. Evidence: the kept test's clause 3 admits a stated difference only where a surface
    cannot follow the value, and Preview can: the setting is one preference with one reader
    (`QuestionWidget.java::setTextFromPrompt`), and the frame that carries fuzzy search carries it.
    A Preview that marks what a phone leaves unmarked shows an author a form no worker sees. So
    `KeptPreviewCell` has no `states` arm (section 5).
18. **Nothing parses a finding, so no schema holds one** (8.1). Not done: a `findingSchema` with
    refinements for the standing, the cause and the claim. Evidence: a request answers its findings
    on the response it computed them in and nothing stores one, so every refinement would assert only
    over values a test built by hand, and a producer that set a wrong standing would ship unrefused.
    The constructor's types hold the same rules where a finding is made. For the same reason a
    finding carries no `owner`: its readers were a stored count by owner, which this plan does not
    keep.
19. **`STEP_7_GROUPS` holds the eight groups an entry can name** (2.3). Not done: a ninth id for
    updating a copy of an app in a second project space, which the step 7 outline names among what
    is not planned (`../7-rest-of-model.md`, "Not planned"). Evidence: it owns no entry and no
    circumstance, so the schema would admit an owner no entry may truthfully take, and nothing in
    code reads it.

---

## Files

A test file stands with its source and is named only where it is new or where section 10 or 7.4
changes it. No file is moved or removed.

**New**

| File | Holds |
|---|---|
| `lib/publish/hqFindings.ts` | `READ_STANDINGS`, `ReadStanding`, `FindingStanding`, `FIX_CAUSES`, `FixCause`, `SUBJECTS`, `Subject`, `STEP_7_GROUPS`, `Step7Group`, `HqPlace`, `HqAppClaimDetail`, `FindingDetail`, `Finding`, `ManifestFinding`, `CircumstanceFinding`, `FINDING_NAME_MAX_LENGTH`, `cutFindingName`, `CircumstanceDetail`, `circumstanceFinding`, `READ_CIRCUMSTANCES`, `ReadCircumstance`, `CIRCUMSTANCE_STANDINGS`, `NOVA_FAULT_CIRCUMSTANCES`, `StopCircumstance` (2.1 to 2.3, 8.1, 8.3) |
| `lib/publish/hqFindingCopy.ts` | 9.1 to 9.3: `FINDING_LABELS`, `FINDING_NEXT_STEPS`, `SUBJECT_LABELS`, `FINDING_COPY`, `FIX_IN_HQ_STEMS`, `FIX_CAUSE_CLAUSES`, `FIX_IN_HQ_SENTENCES`, `fixInHqSentence`, `CIRCUMSTANCE_COPY`, `CircumstanceContext`, `circumstanceBlock`, `alreadyInNovaNext`, `ACCOUNT_CHECK_AGAIN_LINE`, `placeLine`, `findingLine` (8.4) |
| `lib/publish/keptValues.ts` | the kept list's labels, lead and refresh sentences (9.4) |
| `lib/commcare/surface/standing.ts` | `NEVER_REASON_KINDS`, `FIX_IN_HQ_REASON_KINDS`, `standingOf`, `fixCauseOf` (2.1) |
| `lib/commcare/surface/keptAtHq.ts` | `KEPT_AT_HQ` and its row and cell types (5) |
| `lib/commcare/targetFacts.ts` | `TargetFacts`, `KEPT_PROFILE_PROPERTY_KEYS`, `targetFactsFromSource`, `hqProfileValueText` (6.1) |
| `lib/commcare/keptProfile.ts` | `targetProfileProperties` (6.3, 7.3) |
| `lib/commcare/targetBuildProfiles.ts` | `publishedLanguageCodes`, `buildProfileLanguageGaps` (7.4) |
| `lib/deployment/targetFacts.ts` | `targetFactsFromBaseline`, `keptListFor`, `keptAdvisoryFacts` (6.1) |
| `lib/preview/listFilterMatch.ts` | Core's filter, ported: `normalizeForFilter`, `fuzzyMatch`, `filterTerms`, `rowFilterScore` (6.4) |
| `lib/collab/previewTargetFactsFrame.ts` | the frame `preview-target-facts` and `PreviewTargetFacts` (6.4) |
| `proof/targeted/documents/tileGroupFilter.ts` | the targeted document `targeted-tile-group-filter` (6.4, "Proof") |
| `lib/commcare/surface/__tests__/standing.test.ts`, `keptAtHq.test.ts`; `lib/publish/__tests__/hqFindings.test.ts`, `hqFindingCopy.test.ts`, `keptValues.test.ts`; `lib/commcare/__tests__/targetFacts.test.ts`, `keptProfile.test.ts`, `keptArchive.test.ts`, `targetBuildProfiles.test.ts`; `lib/deployment/__tests__/targetFacts.test.ts`, `targetFacts.postgres.test.ts`, `refreshKeptValues.postgres.test.ts`, `previewTarget.test.ts`; `lib/preview/__tests__/listFilterMatch.test.ts`, `caseTileGrouping.test.ts`; `components/preview/shared/__tests__/listFilter.test.ts`; `lib/collab/__tests__/previewTargetFactsFrame.test.ts`; `e2e/tests/app/preview-kept.spec.ts`, `e2e/lib/keptBaselineSeed.ts` | section 10 and 7.4 |

**Changed**

| File | Change |
|---|---|
| `lib/commcare/surface/schema.ts` | `subjectSchema`; `subject` on the HELD-NEW and REFUSED arms and `owner` on the HELD-NEW arm, each required with the message of 2.6; the TARGET-OWNED arm split from INERT and given `heldPlatformsSchema` (2.5) |
| `lib/commcare/surface/entries/*.json` | `subject` and `owner` on every entry Appendix A lists; three value classes (2.4); the entries of 3.1, 3.2 and 3.7; the re-wordings of 3.3 (`entries/gates.json` among them) and 3.4; the flips of 3.6 and the re-wording of `32-features-credentials`; the logo entry of 3.5; the three entries and the re-wording of 7.1; the language display name's flip (7.2) and the sentence the fifteen cells gain (7.3) |
| `docs/research/2026-09-26-hq-round-trip/inventory/menus-and-case-lists.md`, `application-and-settings.md`, `case-search.md`, `forms-and-case-writes.md`, `questions.md`, `expressions-and-data.md`, `gates.md` | the rows of section 3 and 7.1 to 7.4, and the three rows that gain a value class in 2.4 (`groups` in `expressions-and-data.md`, the two datum rows in `forms-and-case-writes.md`), each re-worded to say which values the class takes; the CommTrack clause of `gates.md` (3.3). `subject` and `owner` move no row: the inventory has no column for either (section 11) |
| `lib/commcare/surface/platformFeatureEntries.ts`, `lib/preview/__tests__/platformCells.ts` | thirteen rows leave each (2.5, 3.6) |
| `proof/checks/manifest_value_classes.py`, `proof/checks/test_manifest_value_classes.py` | `path_not_from_uploader` gains the `m_id` test and its case (3.5) |
| `lib/commcare/appStringKeys.ts` | `isRuntimeUiStringKey` (6.1) |
| `lib/deployment/store.ts` | `readTargetFacts`, `verifiedBaselineSource`, `recordRefreshedAppBaseline` (6.2, 6.5) |
| `lib/deployment/types.ts` | `AppBaselineWrite.origin` admits `"cutover"` (6.5); `DEPLOYMENT_FAILURE_CODES` gains `hq_build_profile_language_missing` (7.4) |
| `lib/deployment/downloadTarget.ts`, `lib/export/localArchive.ts` | `targetFacts` carried to the compiler (6.3) |
| `lib/commcare/compiler.ts`, `lib/commcare/runtimeTarget.ts` | the profile's settings, features and server properties, the app string tables, location capture and language names from `TargetFacts` (6.3, 7.2) |
| `app/api/compile/route.ts`, `app/api/compile/json/route.ts`, `app/api/compile/prepareCompileRequest.ts`, `lib/mcp/tools/compileApp.ts`, `proof/corpus/publish.ts` | pass the facts and the kept advisories; the JSON route passes `null` for `exportAdvisories`' new parameter (6.3) |
| `lib/publish/exportAdvisories.ts` | the four kept advisories and `KeptAdvisoryFacts` (6.3, 7.2, 9.5) |
| `lib/commcare/targetOverlay.ts`, `lib/deployment/importApplication.ts`, `lib/deployment/hqSourceBaseline.ts` | the options `languageNames` and `seeds`, handed on from `publishAppToHq` (7.2, 7.3; part 10, section 6.3, computes them) |
| `lib/preview/platform.ts` | the rules `listFilter` and `requiredMark`, and `requiredMarkShown` (6.4) |
| `components/preview/shared/listFilter.tsx`, `components/preview/screens/CaseListScreen.tsx` | `rowsMatchingFilterText`; one filter site; the cards of a grouped list made from the matches (6.4) |
| `lib/preview/caseTileGrouping.ts`, `components/preview/shared/CaseTileGroup.tsx` | `TileGroupCard`, `groupedPageRows`, `tileGroupCards`; the heading drawn from `rows[0]` (6.4) |
| `lib/case-store/store.ts`, `lib/case-store/postgres/store.ts`, `lib/preview/engine/caseDataBindingTypes.ts`, `lib/preview/engine/caseDataBindingHelpers.ts` | `listOrder` on a grouped read (6.4) |
| `components/preview/form/InteractiveFormRenderer.tsx` | the asterisk drawn by `requiredMarkShown` (6.4) |
| `lib/deployment/previewTarget.ts`, `previewSpace.ts`, `lib/collab/ReconcilerProvider.tsx`, `lib/collab/context.ts`, `components/builder/DeploymentTargetProvider.tsx`, `components/builder/BuilderProvider.tsx`, `app/(app)/build/[id]/[[...path]]/page.tsx`, `app/api/apps/[id]/stream/route.ts` | the channel that carries the facts to Preview (6.4) |
| `lib/deployment/service.ts`, `actions.ts`, `app/api/commcare/upload/route.ts`, `components/builder/publishOutcome.ts`, `PublishDialogBody.tsx`, `DeploymentStatus.tsx`, `app-setup/PublishingSection.tsx` | the kept list and the refresh (6.5; `app-setup/publishingSectionModel.ts` does not change); the second read's build profile check and the dialog's link for the new refusal (7.4) |
| `lib/commcare/hq/appSource.ts`, `lib/deployment/preflight.ts` | `HqAppSource.buildProfiles`, which part 05 states (`05-reading-commcare-hq.md`, section 7); the `target-app` edge's check and `buildProfileLanguageFailure` (7.4) |
| `lib/mcp/tools/deploymentTools.ts`, `deploymentProjection.ts`, `lib/mcp/errors.ts`, `lib/mcp/tools/uploadAppToHq.ts` | `kept_values` and `kept` (6.5, 9.6); the refusal `hq_build_profile_language_missing` and its description sentence (7.4) |
| `proof/targeted/index.ts`, `proof/webapps/test_tiles.py`, `proof/corpus/targetPeer.ts` | the targeted document and the Web Apps test (6.4); the capture peer's build profiles, which part 14 states (7.4) |
| the tests section 10 marks extended or updated, and those of 7.4 | sections 10 and 7.4 |
| `lib/commcare/CLAUDE.md`, `lib/deployment/CLAUDE.md`, `lib/preview/CLAUDE.md`, `lib/case-store/CLAUDE.md`, `lib/export/CLAUDE.md`, `components/builder/CLAUDE.md`, the root `CLAUDE.md`, `docs/architecture/contracts.md`, `docs/architecture/complex-apps.md`, `proof/README.md`, `content/docs/*.mdx`, and the source comments section 11 names | sections 9.7, 11 and 7.4 |
| `../nova-plugin/skills/upload_to_hq/SKILL.md` | the sentences of section 11 and 7.4, in the step's one plugin pull request (part 13, section 16), merged after the Nova deploy is live |

---

## Appendix A: `subject` and `owner`, entry by entry

Slugs are entry ids without their area, which each block's heading gives. The area blocks of A.1 and
A.2 hold the entries the manifest holds today: they were produced by one script over the manifest and
cover every HELD-NEW entry (237) and every REFUSED entry (349). Four `questions/` entries about Hidden
Values that the script had filed under a search subject are filed by the manifest's own section
(Question types) and 2.3, and thirteen entries are filed under the subject whose sentence is true
of them (2.2). An entry marked † leaves its list in this step (3.8): it holds the fields shown only
until it flips. The manifest test's rules of 2.6 fail on any entry the lists miss.

Each list ends with a block, "Entries this step adds": the entries that become HELD-NEW or REFUSED
in this step, each written with its area, under the subject and the owner or standing the part that
plans it gives it. Those entries are not among the 237 and the 349, and the counts by owner under
A.1's area blocks leave them out.

### A.1 Every HELD-NEW entry: subject and owner

**`application-and-settings/`** (11)

- `android-app-dependencies` → `settings-nova-comes-to-own`: `31-features-dependencies`
- `app-logos` → `settings-nova-comes-to-own`: `logo-refs-hq-logo-android-home-login-demo` †
- `app-settings` → `settings-nova-comes-to-own`:
  `translations-key-in-a-runtime-s-ui-string-catalog-core-android` †,
  `translations-catalog-key-hq-fills-with-its-own-text-in-a` †,
  `24-properties-cc-log-entity-detail-enabled` †, `51-hq-persistent-menu` †,
  `52-hq-show-breadcrumbs` †, `translations-lang-code-any-other-value-or-absent-where-hq-s` † (it
  takes `app-settings` only until it flips, 3.8)
- `case-sharing` → `settings-nova-comes-to-own`: `39-hq-case-sharing`
- `menu-display` → `settings-nova-comes-to-own`: `46-hq-use-grid-menus`,
  `47-hq-grid-form-menus-none-all-some`

**`menus-and-case-lists/`** (69)

- `auto-select` → `case-list-and-detail`: `detail-auto-select-multi-select`
- `auto-select` → `forms-and-case-management`: `auto-select-case-on-an-advanced-module`
- `case-detail-tabs` → `case-list-and-detail`: `7pp-invisible-inside-a-data-tab-over-a-nodeset`,
  `plain-tab-header-starting-index`, `tab-relevant-lifts-into-predicate-not`,
  `data-tab-over-child-cases-has-nodeset-nodeset-case-type-nodeset`,
  `data-tab-over-a-custom-nodeset-xpath`
- `case-list-callout` → `case-list-and-detail`: `lookup-enabled-lookup-action`, `lookup-name`,
  `lookup-image-jr`, `lookup-autolaunch`, `lookup-extras-key-value`, `lookup-responses-key`,
  `lookup-display-results-lookup-field-header-lookup-field-template`
- `case-list-columns` → `case-list-and-detail`: `usexpathexpression-field-xpath-outside-valueexpression`,
  `1p-plain-over-a-property-select-questions-write`,
  `3-time-ago-time-ago-interval-the-7-menu-values-years-months`,
  `5pp-enum-key-that-is-empty-or-holds-whitespace`,
  `translatable-enum-on-a-column-that-is-not-a-calculated-property-over-a-property`,
  `translatable-enum-on-a-column-that-is-not-a-calculated-property-relation-does`,
  `6p-late-flag-late-flag-0`, `8-address`, `9-distance`, `11-geo-boundary`,
  `12-geo-boundary-color-on-the-case-list-only-needs-an-address`, `13-geo-points-on-the-case-list-only`,
  `14-geo-points-colors-on-the-case-list-only-needs-an-address`,
  `16-clickable-icon-endpoint-action-id-on-the-case-list`, `19-enum-image-whose-keys-are-plain-values`,
  `19pp-enum-image-whose-keys-are-conditions-of-any-other-form-dot`, `20-conditional-enum`,
  `more-than-one-address-column-in-a-detail-of-an-advanced-module`,
  `idx-prop-parent-host-any-index-names-other-than-a-first-step`, `owner-name`
- `case-list-filter` → `case-list-and-detail`: `detail-filter-value-outside-predicate`
- `case-list-optimizations` → `case-list-and-detail`: `module-show-case-list-optimization-options`,
  `optimization-cache-lazy-load-cache-and-lazy-load`
- `case-list-registration` → `menus`: `case-list-form-pointing-at-a-registration-form-in-another-module`
  †, `case-list-form-pointing-at-a-follow-up-form-of-the-parent-case`,
  `case-list-form-relevancy-expression-with-followup-forms-as-case`,
  `case-list-form-media-image-media-audio` †
- `case-list-sorting` → `case-list-and-detail`:
  `type-int-or-double-differing-from-the-derived-type-on-a-column`, `type-distance`, `blanks-first-last`
  †, `display-lang-sort-by-label-on-a-sort-only-element`,
  `display-lang-on-a-sort-joined-to-an-invisible-column`,
  `sort-calculation-authored-calculation-row-field`
- `case-list-text` → `case-list-and-detail`:
  `detail-no-items-text-other-than-hq-s-default-en-list-is-empty`, `detail-select-text-non-default`
- `case-tiles` → `case-list-and-detail`: `detail-case-tile-template-icon-text-grid`,
  `long-detail-custom-tile-case-detail-laid-out-as-a-tile`, `detail-persistent-case-tile-from-module`,
  `detail-pull-down-tile`, `detail-persist-case-context-persistent-case-context-xml`,
  `case-tile-field-template-slot-on-icon-text-grid`, `invisible-or-address-column-in-a-custom-tile`,
  `a-custom-long-tile-row-mixing-fields-of-two-tabs-in-an-advanced`
- `display-conditions` → `menus`: `module-filter-value-outside-predicate-any-xpath-hq-s-validator`
- `display-only-forms` → `menus`: `put-in-root-display-only-forms` †
- `media-by-language` → `question-display`: `media-image-media-audio-differing-by-language`
- `menu-badges` → `menus`: `custom-icons-0-badge-localized-text-or-xpath`
- `menu-display` → `settings-nova-comes-to-own`:
  `module-display-style-list-grid-read-when-grid-form-menus-some-on`
- `mirror-menus` → `menus`: `shadowmodule-shadow-module-version-2`,
  `shadowmodule-v2-under-a-v2-shadow-menu-mirroring-a-non-shadow`,
  `shadowmodule-excluded-form-ids-non-empty`, `shadowmodule-form-session-endpoints-non-empty`
- `worker-record` → `case-list-and-detail`: `user-prop-usercase`, `user-steps-prop`
- `worker-record` → `forms-and-case-management`: `case-type-commcare-user-on-an-advancedmodule`

**`case-search/`** (31)

- `search-default-filters` → `case-search`:
  `default-properties-entry-keyed-by-a-plain-property-property-p`,
  `default-properties-entry-keyed-by-an-ancestor-path-parent-p`,
  `default-properties-entry-keyed-owner-id-case-id-commcare-project`,
  `default-properties-entry-keyed-commcare-sort-x-commcare-custom`,
  `default-properties-entry-keyed-case-type`,
  `default-properties-entry-keyed-commcare-blacklisted-owner-ids`,
  `blacklisted-owner-ids-expression-without-that-clause`,
  `blacklisted-owner-ids-expression-outside-valueexpression`,
  `hidden-exclude-without-a-default-value-on-a-prompt-with-no`,
  `hidden-without-exclude-on-a-prompt-with-no-itemset-input-type-or`,
  `hidden-on-a-prompt-that-carries-an-itemset-input-type-or`, `several-xpath-query-rows` †
- `search-expressions` → `case-search`: `date-only-comparison-on-date-opened-closed-on-last-modified`
- `search-fields` → `case-search`: `appearance-address-geocoder-broadcast-emitted-input-address`,
  `input-checkbox-itemset`, `itemset-nodeset-filter-predicate-outside-predicate`,
  `default-value-outside-valueexpression`, `allow-blank-value`, `receiver-expression`,
  `is-group-group-key`
- `search-fields` → `project-data-at-hq-size`:
  `itemset-refs-to-item-attributes-attr-or-property-qualified`
- `search-setup` → `case-search`: `custom-sort-properties-property-name-sort-type-exact-date`,
  `search-button-display-condition-outside-predicate`, `title-label-or-blank-hq-s-default` †,
  `instance-name-without-casedb-ledgerdb-fixture-or-session-in-it`, `additional-case-types`,
  `custom-related-case-property`, `include-all-related-cases-false-where-nova-s-relation-reads`,
  `include-all-related-cases-authored-without-relation-reads`, `search-on-clear`,
  `case-search-endpoint-id`

**`forms-and-case-writes/`** (26)

- `advanced-forms` → `forms-and-case-management`: `auto-select-mode-raw-value-key`,
  `auto-select-mode-user`, `auto-select-mode-fixture`, `auto-select-mode-case-index-of-an-earlier-load`,
  `caseindex-relationship-question-relationship-question-the-index-naming-a`,
  `arbitrary-datums-datum-id-datum-function`
- `case-preloads` → `forms-and-case-management`:
  `case-preload-from-any-other-index-path-host-user-a-mixed-path`,
  `loadupdateaction-preload-question-property` †
- `deep-links` → `menus`: `function-datum-endpoints`
- `form-case-management` → `forms-and-case-management`:
  `an-advanced-load-s-update-or-preload-or-an-open-action-s-name-or`
- `display-conditions` → `menus`: `form-filter-outside-predicate-parent-host-user-usercase-reads`,
  `user-prop-in-module-filter-form-filter-case-list-slots-the`
- `form-settings` → `forms-and-case-management`: `submit-label-non-default`
- `form-settings` → `settings-nova-comes-to-own`: `auto-gps-capture-form`
- `media-by-language` → `question-display`: `media-image-media-audio-differing-by-language`
- `menu-badges` → `menus`: `custom-icons-0`
- `shadow-forms` → `forms-and-case-management`: `shadowform`,
  `shadow-parent-form-id-naming-an-advancedform-that-is-not-a`,
  `extra-actions-load-update-cases-repeating-a-parent-tag-overrides`,
  `extra-actions-load-update-cases-with-a-tag-absent-from-the`
- `worker-record` → `forms-and-case-management`:
  `update-key-whose-index-segments-include-user-each-parent-host-or`
- `writer-types` → `forms-and-case-management`:
  `update-through-the-date-and-time-join-of-a-date-and-a-time` †, `writers-int-decimal`,
  `writers-single-select-multi-select`, `any-other-mixed-writer-pair`,
  `a-datetime-question-saved-straight-to-a-case`

**`questions/`** (86)

- `connect-blocks` → `xform`: `connect-work-area-update`
- `media-by-language` → `question-display`: `label-or-option-media-differing-by-language`
- `question-appearance` → `question-display`: `select1-minimal`, `select1-compact-compact-n`,
  `select1-quick`, `select1-quick-compact-n`, `select1-combobox`, `select1-combobox-multiword`,
  `select1-combobox-fuzzy`, `select1-list`, `select1-list-nolabel`, `select1-label`,
  `select1-button-select`, `select1-receive-topic-field`, `select-minimal`, `select-compact-compact-n`,
  `select-list`, `select-list-nolabel`, `select-label`, `secret-numeric`, `text-secret-numbers`, `short`,
  `medium`, `text-address`, `broadcast-topic-an-address-entry-under-the-gates-above-and`,
  `text-receive-topic-field`, `barcode-numeric-address-or-receive-topic-field`,
  `hint-as-placeholder-on-text-other-than-a-secret-without-numeric`,
  `hint-as-placeholder-on-any-other-entry`,
  `barcode-quick`, `date-ethiopian`,
  `date-nepali`, `date-gregorian-gregorian-cancel`, `time-12-hour`, `geopoint-maps`, `barcode-editable`,
  `image-acquire`, `image-overlay-small`, `audio-legacy`, `audio-acquire-or-upload`, `audio-long`,
  `video-acquire`, `trigger-selectable`, `floating-good-floating-caution-floating-bad`,
  `a-label-whose-appearance-string-starts-with-floating-other-than`, `group-compact`,
  `group-group-collapse`, `group-collapse-open`, `group-group-border`,
  `n-per-row-any-question-or-group-other-than-a-vellum-repeat-n-one`,
  `n-per-row-repeat-group-with-a-repeat-as-a-direct-child-n-one-or`,
  `any-other-per-row-token-the-first-token-web-apps-per-row-pattern`,
  `text-align-center-text-align-right`,
  `multi-token-strings-e-g-minimal-hint-as-placeholder-signature-2`,
  `a-multi-token-string-holding-tokens-no-runtime-reads-on-that`,
  `a-single-string-no-row-names-that-holds-values-android-matches`,
  `a-case-variant-of-numbers-nepali-or-maps-of-video-acquire-or-of`
- `question-appearance` → `xform`: `intent-id-on-any-input-other-than-an-intent-typed-one-where-id`
- `question-choices` → `project-data-at-hq-size`: `itemset-refs-to-attr-or-property-qualified-fields`
- `question-choices` → `xform`: `itemset-sort-ref`, `itemset-filter-outside-predicate`,
  `itemset-over-casedb-or-another-instance-advanced-data-source`
- `question-media` → `question-display`: `long-form`, `label-video-inline`, `label-qrcode`, `label-tts`
- `question-text` → `xform`: `vellum-ignore-containing-markdown-on-h-html-vellum-s-disable` †,
  `output-value-any-other-expression` †,
  `a-question-text-label-hint-help-validation-message-repeat-add`,
  `a-question-text-whose-itext-id-is-pragma-form-descriptor-where`
- `question-types` → `xform`: `phone-number-xsd-string-appearance-numeric` †,
  `acknowledge-label-a-trigger-whose-appearance-is-neither-exactly`,
  `jr-imagedimensionscaledmax-250-500-1000px-or-another-positive`, `face-capture-image-face`,
  `android-app-callout-input-appearance-intent-id-bind-type-intent`,
  `data-parent-data-node-under-another-group-than-its-control`, `vellum-lock-all-locked-question`,
  `hidden-value-with-both-calculate-and-a-default-by-any-expression`,
  `data-node-xmlns-on-a-hidden-value`
- `repeats` → `xform`: `repeat-add-captions-jr-addcaption-jr-addemptycaption`
- `save-to-case` → `xform`: `savetocase-case-type-given-as-an-xpath`,
  `savetocase-create-with-an-authored-non-uuid-case-id-xpath-inside`,
  `savetocase-expressions-outside-nova-s-typed-vocabularies-case-id`,
  `a-close-only-savetocase-block-with-a-close-condition`,
  `a-savetocase-block-that-creates-or-updates-and-also-closes-under`, `savetocase-owner-id-condition`

**`expressions-and-data/`** (14)

- `advanced-forms` → `forms-and-case-management`:
  `session-data-supply-point-id-in-an-advanced-form-whose-computed`
- `case-list-callout` → `case-list-and-detail`: `session-data-fingerprintquery`
- `case-sharing` → `settings-nova-comes-to-own`: `groups-jr-fixture-user-groups`
- `data-sources` → `case-list-and-detail`: `search-input-results-read-in-the-search-results-detail`
- `lookup-tables` → `project-data-at-hq-size`: `tag-types`,
  `fields-properties-and-multi-valued-cells-name-lang-en-name-name`,
  `item-attributes-and-per-row-attribute-values`, `is-global-false-row-owners-user-group-location`,
  `fields-is-indexed`, `absent-field-vs-zero-values-vs-empty-string`,
  `table-or-row-count-beyond-nova-s-caps-5-000-rows-250-columns-64`
- `media-files` → `project-data-at-hq-size`:
  `an-imported-asset-larger-than-nova-s-per-kind-cap-or-an-app`, `media-path-jr-file` †,
  `a-media-reference-on-a-slot-nova-holds-with-no-multimedia-map` †

Counts by owner over these 237: `case-list-and-detail` 56, `case-search` 30,
`forms-and-case-management` 23, `menus` 15, `project-data-at-hq-size` 12, `question-display` 62,
`settings-nova-comes-to-own` 14, `xform` 25.

**Entries this step adds**

Each entry below becomes HELD-NEW in this step and holds both fields from then on. The part and
section beside it write the entry's other fields. An entry marked "re-cut" exists today under another
disposition. There are 68.

- `advanced-forms` → `forms-and-case-management` (part 07, `07-the-reader-cases-menus-lists.md`,
  section 14): `forms-and-case-writes/advanced-form-loads-other-than-its-menu-s-one-chain`,
  `forms-and-case-writes/load-changing-no-case-with-a-tag-nova-does-not-derive`,
  `forms-and-case-writes/case-tag-holding-a-hyphen`,
  `forms-and-case-writes/index-identifier-outside-an-xml-element-name`
- `advanced-menus` → `forms-and-case-management` (part 07, section 14):
  `menus-and-case-lists/advanced-module-nova-would-write-as-a-basic-one`
- `build-profiles` → `settings-nova-comes-to-own` (3.7):
  `application-and-settings/build-profiles-non-empty`
- `case-list-columns` → `case-list-and-detail` (part 04, `04-names.md`, section 11.2):
  `menus-and-case-lists/enum-mappingitem-alt-text-non-blank`,
  `menus-and-case-lists/10-markdown-outside-the-link-shape`,
  `menus-and-case-lists/21-translatable-enum-outside-nova-s-two-projections`
- `case-list-columns` → `case-list-and-detail` (part 07, section 14):
  `menus-and-case-lists/column-field-outside-nova-s-property-grammar`,
  `menus-and-case-lists/6-late-flag-late-flag-1` (re-cut from HELD)
- `case-list-registration` → `menus` (part 02, `02-menus.md`, section 14):
  `menus-and-case-lists/case-list-form-post-form-workflow-default-on-the-hidden-module-shape`,
  `menus-and-case-lists/case-list-form-on-an-advanced-module-or-naming-an-advanced-form`,
  `menus-and-case-lists/case-list-form-pointing-at-a-form-whose-one-registration-of-the-type-is-a-child-case`,
  `menus-and-case-lists/case-list-form-naming-a-form-another-list-offers-after-an-empty-search`,
  `menus-and-case-lists/case-list-form-on-a-host-under-a-menu-that-shares-the-first-menu-s-case`
- `case-list-setup` → `case-list-and-detail` (part 04, section 11.2):
  `menus-and-case-lists/detail-max-select-value-above-100`
- `case-preloads` → `forms-and-case-management` (part 07, section 14):
  `forms-and-case-writes/loadupdateaction-preload-read-later-in-the-load`,
  `forms-and-case-writes/case-preload-into-a-question-that-holds-no-default`,
  `forms-and-case-writes/case-preload-into-a-question-outside-any-repeat-where-the-held` (re-cut from
  REFUSED)
- `case-property-names` → `forms-and-case-management` (part 04, section 11.2):
  `forms-and-case-writes/update-keys-location-id-hq-user-id`,
  `forms-and-case-writes/update-key-holding-a-non-ascii-core-name-character`
- `case-tiles` → `case-list-and-detail` (part 07, section 14):
  `menus-and-case-lists/case-tile-group-identifier-outside-an-xml-element-name`
- `connect-blocks` → `xform` (part 04, section 11.2): `questions/connect-blocks-beyond-one-of-each-kind`,
  `questions/connect-deliver-unit-work-area-id-expression`
- `connect-blocks` → `xform` (part 06, `06-the-reader-forms.md`, section 15):
  `questions/connect-learn-and-deliver-blocks-in-one-app`
- `data-sources` → `menus` (part 08, `08-the-reader-expressions.md`, section 11):
  `expressions-and-data/search-input-read-in-the-forms-of-a-child-menu-of-an-inline-search-menu`
- `display-only-forms` → `menus` (part 07, section 14):
  `forms-and-case-writes/post-form-workflow-previous-screen-on-a-form-listed-on-the-first-menu`,
  `forms-and-case-writes/form-link-or-endpoint-through-a-first-menu-that-shares-one-case`
- `expressions` → `xform` (part 08, section 11):
  `expressions-and-data/a-form-expression-outside-what-nova-types`
- `form-case-management` → `forms-and-case-management` (part 07, section 14):
  `forms-and-case-writes/update-mode-edit-off-a-follow-up-form-s-own-update`,
  `forms-and-case-writes/index-path-through-a-case-type-the-app-does-not-fix`
- `form-source` → `xform` (part 06, section 8.8): `questions/data-root-element-named-other-than-data`
- `language-codes` → `settings-nova-comes-to-own` (part 06, section 6.3):
  `application-and-settings/langs-code-nova-s-language-registry-cannot-name`
- `list-and-search-filters` → `case-search` (part 07, section 14):
  `case-search/case-list-filter-clause-the-search-does-not-restate`
- `lookup-tables` → `project-data-at-hq-size` (part 04, section 11.2):
  `expressions-and-data/tag-or-field-name-with-non-ascii-letters`,
  `expressions-and-data/tag-equal-to-an-instance-name-commcare-owns`,
  `expressions-and-data/tag-or-field-name-holding-a-period`
- `menu-structure` → `menus` (part 04, section 11.2):
  `menus-and-case-lists/child-menu-of-another-case-type-under-a-parent-with-no-forms`
- `parent-selection` → `menus` (part 04, section 11.2):
  `menus-and-case-lists/parent-select-naming-a-module-outside-the-declared-parent-type`
- `question-choices` → `xform` (part 04, section 11.2):
  `questions/choice-value-holding-both-an-apostrophe-and-a-double-quote`
- `question-ids` → `xform` (part 06, section 8.8): `questions/question-id-case-registration-script`
  (re-cut from HELD)
- `question-logic` → `xform` (part 04, section 11.2): `questions/bind-required-on-a-label`,
  `questions/bind-constraint-on-a-capture-question-or-a-label`,
  `questions/default-on-a-capture-question-or-a-label`
- `question-media` → `xform` (part 04, section 11.2):
  `questions/help-media-on-a-capture-question-or-a-label`
- `question-text` → `xform` (part 04, section 11.2): `questions/hint-text-on-a-label`,
  `questions/help-text-on-a-capture-question-or-a-label`,
  `questions/validation-message-on-a-capture-question-or-a-label`
- `question-text` → `question-display` (part 06, section 12.5):
  `questions/a-text-whose-languages-show-different-values`
- `question-types` → `xform` (part 06, section 11.4):
  `questions/hidden-value-bound-a-type-nova-would-not-write`
- `repeats` → `xform` (part 06, section 10.4):
  `questions/model-iteration-repeat-outside-nova-s-model-iteration-rule`
- `save-to-case` → `xform` (part 07, section 14):
  `questions/savetocase-block-outside-nova-s-own-block-shape`,
  `questions/savetocase-link-name-outside-nova-s-identifier-grammar`
- `search-default-filters` → `case-search` (part 07, section 14):
  `case-search/xpath-query-row-reading-a-field-hq-also-matches`,
  `case-search/xpath-query-row-that-is-neither-a-list-filter-clause-nor-a-search-field-s`
- `search-expressions` → `case-search` (part 08, section 11):
  `case-search/a-search-value-that-queries-cases-a-table-or-places`,
  `case-search/required-or-validation-test-outside-what-nova-types`,
  `case-search/xpath-query-condition-outside-what-nova-types`
- `search-fields` → `case-search` (part 04, section 11.2):
  `case-search/prompt-key-outside-nova-s-name-grammar`,
  `case-search/default-value-on-a-date-range-input`
- `search-fields` → `case-search` (part 07, section 14):
  `case-search/date-prompt-matched-by-hq-s-own-rule`,
  `case-search/prompt-named-for-a-case-attribute-hq-matches-itself`,
  `case-search/search-field-over-a-property-of-another-type`
- `search-setup` → `case-search` (part 07, section 14):
  `case-search/list-first-with-a-search-that-skips-to-results`,
  `case-search/search-on-a-put-in-root-module`, `case-search/title-label-blank-in-some-languages`
- `translation-overrides` → `settings-nova-comes-to-own` (7.1):
  `application-and-settings/translations-generated-key-anything-else`

Two labels with no text in any language are no rows here, because each is read as the text CommCare
HQ writes for it and so is held. A registration label:
`app_strings.py::_create_case_list_form_app_strings` writes "Create a new Case" for a blank one, and
part 02's entry `menus-and-case-lists/case-list-form-label-empty` is HELD (`02-menus.md`, section
14). A case list menu item's label: `_create_case_list_app_strings` writes "Case List", and part 07
reads it so and adds no entry for it (`07-the-reader-cases-menus-lists.md`, section 8.6).

An entry a run's outcome adds is no row here either: a fallback row of part 04's run R2, or part 02's
run G3 under its outcome C. It takes its subject by 2.2's rule and the owner its part names.

### A.2 Every REFUSED entry: subject and standing

**`application-and-settings/`** (21)

- `android-app-dependencies`, `fix-in-hq`:
  `profile-properties-or-features-dependencies-value-outside-its`
- `app-document`, `fix-in-hq`: `unknown-doc-type`,
  `an-unknown-top-level-key-naming-an-application-read-only`, `33p-hq-application-version-1-0`,
  `37-hq-profile-url-on-an-application`, `doc-type-linkedapplication-downstream-app`,
  `upstream-app-id-upstream-version-linked-app-translations-linked`
- `app-logos`, `fix-in-hq`: `logo-refs-slot-path-other-than-the-uploader-s-jr-file-commcare`
- `app-settings`, `fix-in-hq`: `41p-hq-use-custom-suite-true`,
  `44p-hq-translation-strategy-select-known`,
  `profile-features-sense-true-or-profile-properties-cc-entry-mode`
- `app-settings`, `never`: `2-properties-lazy-load-video-files-true`,
  `48p-hq-target-commcare-flavor-commcare-commcare-lts`
- `commcare-version`, `fix-in-hq`: `34p-hq-build-spec-below-nova-s-floor`
- `custom-assertions`, `never`: `non-empty-custom-assertions-app`
- `custom-device-properties`, `never`: `profile-custom-properties-any-other-entry-incl-formplayer-keys`
- `hand-written-content`, `never`: `doc-type-remoteapp-profile-url-manage-urls-questions-map`
- `hierarchical-locations`, `never`: `50pp-hq-location-fixture-restore-only-hierarchical-fixture`
- `language-codes`, `fix-in-hq`: `a-non-empty-langs-code-outside-that-grammar-or-repeated`,
  `langs-containing-an-empty-code`
- `mobile-reports`, `never`: `49p-hq-mobile-ucr-restore-version-1-0-1-5` †

**`menus-and-case-lists/`** (85)

- `app-document`, `fix-in-hq`: `unknown-module-doc-type`
- `app-document`, `never`: `module-unique-id-missing`
- `auto-select`, `fix-in-hq`: `auto-select-case-true-on-a-basic-module-an-advanced-form-s-load`,
  `detail-auto-select-true-on-a-single-select-basic-list`
- `call-center-indicators`, `never`: `indicator-call-center-name`
- `case-attachments`, `never`: `17-picture`, `18-audio`, `attachment-name-with-any-other-format`
- `case-detail-tabs`, `fix-in-hq`: `columns-above-the-first-tab-when-tabs-exist`
- `case-list-callout`, `fix-in-hq`: `callout-with-no-extras-or-no-responses`,
  `lookup-on-the-long-detail-tabbed-or-not`
- `case-list-columns`, `fix-in-hq`: `field-failing-details-utils-js-isvalidpropertyname-non`,
  `calculated-column-reading-results-search-input-instances-in-a`, `2p-date-any-other-date-format`,
  `3p-time-ago-other-interval`,
  `translatable-enum-on-a-column-that-is-not-a-calculated-property-relation-offers`,
  `5p-enum-key-containing`, `a-geo-column-without-the-column-it-depends-on`,
  `16p-clickable-icon-with-an-empty-endpoint-action-id-on-the-case`,
  `16pp-clickable-icon-on-the-case-detail-whatever-its-endpoint`,
  `a-case-list-column-of-any-format-carrying-an-endpoint-action-id`,
  `21p-translatable-enum-key-outside-a-za-z0-9`,
  `an-enum-enum-image-conditional-enum-or-translatable-enum-column`, `23-image-cc-case-image`,
  `24p-filter-otherwise`, `more-than-one-address-column-or-more-than-one-image-or-geo`,
  `more-than-one-image-or-geo-column-of-the-same-format-in-a-detail`,
  `property-x-or-prefix-x-with-a-prefix-hq-registers-no-generator`, `indicator-any-other-set-name`
- `case-list-columns`, `never`: `15-address-popup`, `22-graph`
- `case-list-filter`, `fix-in-hq`: `detail-filter-failing-etree-xpath-dummy-filter`
- `case-list-optimizations`, `never`: `module-lazy-load-case-list-fields-true`,
  `type-index-cache-and-index-order-2`
- `case-list-registration`, `fix-in-hq`:
  `case-list-form-on-a-module-whose-forms-do-not-all-require-a-case`,
  `case-list-form-missing-not-a-registration-form-toggle-off-or`
- `case-list-setup`, `fix-in-hq`: `short-columns-empty-on-a-module-that-needs-case-details`,
  `short-columns-empty-on-a-module-another-module-s-active-parent`,
  `detail-instance-name-any-other-stored-value`,
  `detail-max-select-value-of-0-or-below-1-on-a-multi-select-basic`
- `case-list-sorting`, `fix-in-hq`: `field-cc-calculated-n-naming-a-missing-or-non-calculated-column`,
  `field-and-a-differing-sort-calculation-on-any-other-column`
- `case-tiles`, `fix-in-hq`: `detail-case-tile-template-person-simple`,
  `detail-case-tile-template-other-than-custom-person-simple-or`, `long-detail-non-custom-tile`,
  `custom-tile-column-with-grid-null-unplaced`, `horizontal-align-null-on-a-placed-custom-tile-column`,
  `custom-tile-font-size-null`, `a-custom-long-tile-row-mixing-fields-of-two-tabs-in-a-basic-or`
- `custom-assertions`, `never`: `custom-assertions-module-non-empty`
- `deep-links`, `fix-in-hq`: `module-or-mirror-form-endpoint-id-that-is-not-a-slugify-fixed`,
  `two-endpoints-sharing-an-id-module-case-list-form-or-mirror-form`
- `deep-links`, `never`: `a-shadow-menu-s-own-or-mirror-form-endpoint-id-with-surrounding`
- `display-conditions`, `fix-in-hq`: `module-filter-referencing-case-parent-host-or-a-bare`,
  `module-filter-failing-hq-s-validate-xpath`
- `display-only-forms`, `fix-in-hq`: `put-in-root-session-endpoint-id-or-inline-search-or-an-end-of`,
  `case-list-form-on-a-child-put-in-root-module-whose-parent-s-case`,
  `case-list-form-on-a-put-in-root-module-whose-case-list-is-a-tile`
- `hand-written-content`, `never`: `detail-custom-xml-non-empty`,
  `detail-custom-variables-dict-non-empty`, `any-other-undeclared-key`
- `hierarchical-locations`, `never`: `location-type`
- `lookup-selection`, `never`: `fixture-select-active-true`
- `menu-settings`, `fix-in-hq`: `module-task-list-show-true`
- `menu-structure`, `fix-in-hq`: `child-menu-deeper-than-one-tier-grandchild`,
  `root-module-id-naming-a-missing-module-or-a-cycle`
- `menu-structure`, `never`: `menu-order-that-separates-a-child-from-its-parent`
- `mirror-menus`, `fix-in-hq`: `shadowmodule-with-no-source-module-id-or-one-naming-no-module`,
  `any-other-module-under-a-shadow-menu`, `shadowmodule-case-list-show-true`
- `mirror-menus`, `never`: `shadowmodule-version-1-or-key-absent-model-default-1`
- `mobile-reports`, `never`: `reportmodule-mobile-ucr-and-all-of-report-configs`,
  `report-context-tile-true`
- `parent-selection`, `fix-in-hq`: `parent-select-naming-a-module-that-searches-inline-under-the`,
  `parent-select-naming-a-survey-module-on-a-child-that-shows-its`,
  `parent-select-module-id-naming-a-multi-select-module-or-an`
- `parent-selection`, `never`: `parent-select-relationship-null-other`
- `supply-features`, `never`: `advancedmodule-product-details-differing-from-the-default`,
  `model-product`, `ledger-section`
- `training-menus`, `never`: `module-with-is-training-module-true-training-menu-root-training`,
  `any-module-under-a-training-menu`
- `visit-scheduler`, `never`: `advancedmodule-has-schedule-true-or-schedule-phases-non-empty`,
  `schedule-var`
- `worker-record`, `fix-in-hq`: `case-type-commcare-user-or-user-owner-mapping-case-on-a-basic`

**`case-search/`** (26)

- `auto-select`, `fix-in-hq`: `search-on-clear-with-the-case-list-s-auto-select-checked-whether`
- `data-registry`, `never`: `default-properties-entry-keyed-x-commcare-data-registry`,
  `data-registry-data-registry-workflow-additional-registry-cases`
- `mobile-reports`, `never`: `input-select1-select-commcare-reports-itemset-mobile-ucr`
- `search-default-filters`, `fix-in-hq`: `that-entry-together-with-blacklisted-owner-ids-expression`,
  `default-properties-entry-with-no-defaultvalue-hq-stores-an-empty`,
  `a-default-filter-and-a-search-property-sharing-one-name`,
  `hidden-together-with-required-or-validations`
- `search-default-filters`, `never`: `default-properties-entry-keyed-x-commcare-endpoint-id`,
  `a-commcare-sort-x-commcare-custom-related-case-property-or-case`
- `search-expressions`, `fix-in-hq`: `p-whose-right-side-is-not-a-number-date-or-datetime-a-time-of`,
  `date-opened-closed-on-or-last-modified-compared-with-any`,
  `a-function-call-written-unparenthesized-as-the-2nd-or-later`,
  `a-function-on-the-left-side-a-property-on-the-right-side`
- `search-expressions`, `never`: `property-names-operators-or-function-names-computed-at-runtime`
- `search-fields`, `fix-in-hq`: `a-prompt-that-reaches-hq-as-its-own-key-named-as-a-config-keys`,
  `appearance-address-with-required-or-validations`,
  `itemset-scheme-other-than-item-list-commcare-reports`, `validations-1`,
  `receiver-expression-on-a-prompt-whose-editor-appearance-is`,
  `groups-present-and-an-input-without-group-key`
- `search-setup`, `fix-in-hq`: `an-x-commcare-custom-related-case-property-entry-together-with`,
  `search-button-label-any-other-value`, `instance-name-containing-casedb-ledgerdb-fixture-or-session`,
  `a-module-whose-effective-results-instance-results-instance-name`
- `search-setup`, `never`: `workflow-legacy-classic-auto-launch-false-in-an-app-with`

**`forms-and-case-writes/`** (85)

- `advanced-forms`, `fix-in-hq`: `a-load-or-open-action-s-case-tag-containing-which-the-advanced`,
  `case-tag-blank-on-a-non-auto-select-action`,
  `case-tag-of-a-non-auto-select-action-failing-actions-js`,
  `details-module-naming-another-module-of-a-different-case-type-or`,
  `loadupdateaction-case-index-on-an-auto-selected-load-or-on-the`, `case-index-tag-naming-no-action`,
  `loadupdateaction-case-index-tag-naming-a-load-other-than-the-one`,
  `auto-select-mode-case-naming-itself-a-later-load-or-an-open`,
  `auto-select-missing-its-key-in-case-fixture-user-or-raw-mode`,
  `an-auto-select-load-with-a-blank-mode-or-a-blank-case-type`,
  `load-case-from-fixture-loadcasefromfixture-all-fields`,
  `two-or-more-open-actions-whose-repeat-context-is-one-repeat`,
  `advancedopencaseaction-repeat-context-other-than-the-name`,
  `advancedopencaseaction-case-indices-naming-its-own-or-a-later`,
  `an-advanced-open-action-s-index-to-a-load-whose-datum-hq-renames`,
  `caseindex-relationship-question-inside-a-repeat`,
  `caseindex-relationship-question-relationship-question-the-index-naming-an`,
  `caseindex-relationship-question-on-an-index-to-a-load-that`,
  `relationship-question-without-relationship-question`,
  `an-advanced-open-action-indexed-to-an-open-action-that-has-a-neither`,
  `open-case-type-not-any-module-s-case-type-and-not-commcare-user`,
  `advancedform-schedule-with-enabled-false-on-an-advanced-form`,
  `advanced-forms-in-a-module-whose-case-list-offers-a-registration`
- `after-submit`, `fix-in-hq`: `any-other-post-form-workflow-outside-the-offered-set-previous`,
  `post-form-workflow-fallback-module-parent-module-or-previous`,
  `form-links-datums-that-leave-the-target-s-case-id-empty`,
  `form-links-failing-hq-s-link-checks-no-form-links-and-bad-form`
- `after-submit`, `never`: `form-links-target-any-other-module`,
  `form-links-datums-with-other-names-or-on-a-module-target`
- `app-document`, `fix-in-hq`: `unknown-form-doc-type`, `two-non-shadow-forms-sharing-an-xmlns`
- `blank-form`, `fix-in-hq`: `blank-source-or-no-non-group-question`
- `case-attachments`, `never`: `update-from-an-upload-question-attachment-mode`
- `case-preloads`, `fix-in-hq`:
  `case-preload-into-a-question-outside-any-repeat-in-a-multi-select-module`,
  `case-preload-into-a-question-outside-any-repeat-where-the-held` †,
  `load-from-form-naming-a-path-the-form-no-longer-has-on-a-form`,
  `case-preload-on-a-requires-none-form-naming-a-reserved-or`,
  `loadupdateaction-preload-or-case-properties-property-with-on-a`
- `case-property-names`, `fix-in-hq`: `an-update-key-with-an-index-segment-on-a-form-that-opens-its`,
  `update-key-with-any-other-index-segment-or-user-where-the`,
  `update-key-failing-hq-s-grammar-or-in-case-reserved-words-json`,
  `update-key-holding-a-character-validate-property-accepts-that-is`,
  `advancedopencaseaction-case-properties-key-with-parent-p`
- `case-sharing`, `fix-in-hq`: `subcases-on-such-a-form-in-an-app-that-shares-cases-where-a`
- `child-cases`, `fix-in-hq`: `form-requires-none-with-child-cases-but-no-open`,
  `a-subcase-or-advanced-action-condition-on-a-question-the-picker`,
  `an-open-close-child-case-or-advanced-action-condition-with`, `subcases-relationship-extension`,
  `subcases-condition-never`, `subcases-reference-id-any-other-value`,
  `subcases-repeat-context-other-than-the-name-question-s-innermost`,
  `subcase-type-not-any-module-s-case-type-and-not-commcare-user`
- `child-cases`, `never`: `subcase-of-the-module-s-own-case-type-in-a-project-space-with`
- `custom-assertions`, `never`: `custom-assertions-form-non-empty`
- `deep-links`, `fix-in-hq`: `session-endpoint-id-not-a-slug-fixed-point-or-duplicated`
- `display-conditions`, `fix-in-hq`: `form-filter-reading-case-status-case-id-case-type-owner-id`,
  `form-filter-referencing-the-case-database-other-than-through`,
  `a-display-condition-reading-case-user-casedb-with-no-non-auto`
- `display-only-forms`, `fix-in-hq`: `post-form-workflow-hq-s-build-refuses-module-in-a-put-in-root`
- `form-case-management`, `fix-in-hq`: `form-requires-none-with-update-case-active-and-no-open`,
  `form-requires-none-with-close-case-active-and-no-open-in-a-module-with-no`, `form-requires-referral`,
  `a-non-empty-open-case-conflicts-list-or-an-update-case-conflicts`,
  `update-case-update-value-as-a-bare-string-legacy-pre`,
  `update-case-condition-if-whose-question-is-gone`,
  `update-case-condition-never-on-a-follow-up-with-no-other-active`,
  `a-case-write-name-or-preload-on-a-question-the-picker-does-not`,
  `update-path-naming-no-question-in-the-form-in-an-active-action`,
  `a-basic-form-s-own-case-s-close-or-open-condition-on-another`,
  `open-referral-update-referral-or-close-referral-active-in-a-module-with-no`
- `form-settings`, `fix-in-hq`: `show-count-true`,
  `case-references-data-save-differing-from-that-computation`
- `hand-written-content`, `never`: `custom-instances-non-empty`, `any-other-undeclared-key`
- `lookup-selection`, `never`: `form-filter-using-fixture-value`
- `shadow-forms`, `fix-in-hq`: `shadow-parent-form-id-naming-a-basic-form-or-another-shadowform`,
  `shadow-parent-form-id-missing-or-dangling`,
  `a-parent-load-tag-not-repeated-in-extra-actions-where-the-parent`
- `supply-features`, `never`: `show-product-stock-true-or-a-non-empty-product-program`,
  `extra-actions-load-update-cases-show-product-stock-true-or-a-non`
- `training-menus`, `never`: `is-release-notes-form-true-with-or-without-enable-release-notes`
- `visit-scheduler`, `never`: `schedule-form-id-set`,
  `advancedform-schedule-with-enabled-true-visits-transition`
- `worker-record`, `fix-in-hq`: `usercase-update-with-condition-always-or-if-a-key-containing`,
  `any-other-usercase-preload`

**`questions/`** (91)

- `connect-blocks`, `fix-in-hq`: `several-connect-assessment-blocks-in-one-form-or-one-inside-a`,
  `a-connect-learn-module-or-task-id-longer-than-50-characters-or`
- `form-source`, `fix-in-hq`: `any-other-bind-id-named-by-a-control-s-bind`,
  `a-control-whose-ref-names-no-node`, `a-submission-core-s-parser-refuses-missing-any-of-id-resource`,
  `unknown-xforms-namespace-model-children-text-in-model`, `authored-data-meta-block`,
  `data-root-uiversion-other-than-1-or-absent`,
  `data-root-attributes-other-than-uiversion-version-and-name-and`,
  `dtd-declared-entity-references-predefined-ones-such-as-amp-are`
- `hand-written-content`, `never`: `bare-repeat-with-no-group-wrapper`, `itemset-copy`,
  `unknown-body-control-vellum-readonly-e-g-range`, `content-marked-vellum-ignore-retain-vellum-ignored`,
  `input-readonly-true-control-attribute`, `bind-readonly`,
  `setvalue-event-xforms-value-changed-authored-xforms-revalidate`, `actions-nested-inside-controls`,
  `send-submission`, `authored-orx-pollsensor`,
  `unknown-namespace-model-children-named-itext-instance-bind`,
  `other-h-head-children-whose-local-name-or-a-descendant-s-core-or`,
  `xhtml-namespace-child-elements-inside-a-value`,
  `hand-written-case-block-without-vellum-role-incl-a-root-data`,
  `bind-on-an-attribute-path-not-owned-by-a-plugin-savetocase-model`
- `print-templates`, `never`: `print-callout-class-org-commcare-dalvik-action-print-extra-cc`
- `question-appearance`, `fix-in-hq`: `intent-id-naming-an-odkx-intent-that-no-callout-question-writes`,
  `intent-id-on-any-input-naming-no-odkx-intent-in-the-form`
- `question-appearance`, `never`:
  `a-per-row-token-the-first-token-web-apps-per-row-pattern-matches-does`,
  `a-per-row-token-the-first-token-web-apps-per-row-pattern-matches-starts`,
  `an-appearance-holding-such-whitespace-that-some-runtime-reads`,
  `any-other-multi-token-string-holding-a-token-no-runtime-reads-on`,
  `any-other-single-string-no-row-names-that-holds-a-value-android`,
  `a-case-variant-of-numeric-short-or-ethiopian-as-the-whole`
- `question-choices`, `fix-in-hq`: `a-select-whose-bind-type-is-neither-a-choice-type-nor-a-string`,
  `choice-value-with-whitespace-empty-or-duplicated`,
  `a-choice-bind-type-contradicting-the-control-listitem-select1-on`,
  `item-without-value-or-an-itemset-without-label-or-without-both`,
  `select-with-both-items-and-an-itemset-or-no-choices`, `itemset-label-jr-itext-field`,
  `choice-big-image`
- `question-ids`, `fix-in-hq`: `a-root-question-case-in-a-form-where-hq-writes-the-primary-case`,
  `question-id-failing-the-grammar-or-meta-in-any-case`
- `question-ids`, `never`: `two-sibling-data-nodes-with-one-name`
- `question-logic`, `fix-in-hq`: `requiredcondition-differing-from-a-present-non-false-required`,
  `validation-message-without-a-validation-condition`, `literal-jr-constraintmsg-text-no-itext`,
  `bind-calculate-on-a-visible-question`, `a-second-default-setvalue-on-one-question`
- `question-media`, `fix-in-hq`: `label-big-image`
- `question-text`, `fix-in-hq`: `markdown-form-differing-from-the-default-text`,
  `a-label-with-a-markdown-form-in-some-languages-only-as-hq-s-bulk`,
  `a-label-whose-itext-in-the-first-translation-has-no-default-form`,
  `an-explicitly-blank-value-in-a-non-default-language-where-the` †,
  `itext-entry-referenced-only-from-jr-itext-in-an-expression`,
  `itext-pragma-entries-pragma-form-descriptor-pragma-skip-full`,
  `duplicate-text-id-in-one-translation-jr-itext-with-double-quotes`
- `question-types`, `fix-in-hq`: `secret-with-a-numeric-bind-type`,
  `a-secret-whose-bind-has-no-type-with-numeric-or-numbers-ignoring`, `long-xsd-long`,
  `an-input-whose-bind-has-no-type-with-numeric-or-numbers-ignoring`, `ref-less-trigger`,
  `jr-imagedimensionscaledmax-that-is-not-an-integer-or-is-greater`,
  `upload-with-any-other-mediatype-or-none`, `odkx-intent-appearance-quick`,
  `input-whose-bind-type-vellum-does-not-write-xsd-decimal-xsd`,
  `default-data-value-datavalue-instance-text`,
  `a-default-value-s-setvalue-whose-event-does-not-match-where-the`, `hidden-value-with-children`
- `repeats`, `fix-in-hq`: `jr-count-naming-a-decimal-question`,
  `jr-count-naming-a-hidden-value-whose-calculate-is-not-an-integer`,
  `jr-count-naming-any-other-question-kind-text-barcode-multi`,
  `a-count-that-depends-on-the-rows-it-creates-through-calculations`,
  `jr-count-that-is-not-a-path-such-as-data-n-1`,
  `jr-count-naming-a-node-in-a-secondary-instance-or-no-node`, `jr-noaddremove-without-jr-count`,
  `model-iteration-repeat-under-an-ancestor-that-core-s-load-can`,
  `model-iteration-repeat-whose-query-reads-a-form-answer-that-is`,
  `model-iteration-repeat-nested-in-another-repeat-of-any-kind`,
  `user-controlled-repeat-inside-a-question-list-a-group-whose`, `those-captions-referencing-itext`,
  `create-case-id-live-calculate-outside-a-repeat`, `data-parent-crossing-a-repeat`
- `save-to-case`, `fix-in-hq`: `savetocase-create-at-the-form-root-whose-authored-case-id-xpath`,
  `relevance-bound-on-the-savetocase-node-itself`, `constraint-on-savetocase-case-leaves`,
  `type-on-a-savetocase-property-leaf-a-create-update-or-index`, `attachment-inside-a-savetocase-block`
- `supply-features`, `never`: `balance-transfer-dispense-receive-ledger-blocks`
- `worker-record`, `fix-in-hq`: `savetocase-create-close-or-link-of-commcare-user-or-type-user`
- `worker-record`, `never`: `a-root-question-commcare-usercase-in-a-form-with-usercase`

**`expressions-and-data/`** (41)

- `call-center-indicators`, `never`: `indicators-call-center-indicators`
- `data-registry`, `never`: `registry-jr-instance-remote-registry`, `registry-case`
- `data-sources`, `fix-in-hq`: `session-context-window-width-in-form-logic`,
  `results-read-in-form-expressions-reached-through-a-search-that`,
  `legacy-search-input-read-after-the-query-in-the-results-detail`,
  `search-input-read-in-form-expressions-reached-through-a-search`,
  `declared-and-referenced-instance-with-an-unrecognized-src`,
  `referenced-undeclared-instance-id-with-no-known-scheme-or-one`,
  `declared-unreferenced-fixture-instance-the-project-space-does`, `more-than-one-instance-without-an-id`
- `expressions`, `fix-in-hq`: `here-in-a-form`, `any-other-function-name`, `union-a-b`,
  `filter-expression-expr-root-other-than-instance-current`,
  `and-axes-other-than-child-name-or-attribute-name-self-node`, `after-a-named-step-data-a-b`,
  `var-in-a-form-expression`, `or-with-a-time-on-either-side-a-time-answer-property-or-string`,
  `an-invalid-xpath-in-a-bind-attribute`
- `hand-written-content`, `never`: `inline-instance-content-inside-instance-no-src`
- `hierarchical-locations`, `never`: `commtrack-locations-hierarchical`
- `lookup-tables`, `fix-in-hq`: `tag-or-field-name-core-s-xpath-lexer-does-not-read-as-a-name-any`,
  `tag-containing-casedb-or-ledgerdb`
- `media-files`, `fix-in-hq`: `image-svg`, `image-tiff-heif`, `audio-wav-that-is-not-8-or-16-bit-pcm`,
  `audio-m4a-with-another-brand-isom-mp41-mp42-dash`, `audio-3gp`,
  `video-av1-mov-avi-ogg-theora-h-263-3gp`, `multimedia-map-key-not-under-jr-file-that-the-build-keeps`
- `missing-media-files`, `fix-in-hq`: `a-media-reference-with-no-file-on-a-slot-android-s-install`
- `mobile-reports`, `never`: `reports-commcare-reports-commcare-reports-commcare-reports`
- `parent-selection`, `never`: `case-module-slug-unrelated-parent-select-case`
- `print-templates`, `never`: `print-template-jr-file-commcare-text-id-html`
- `question-choices`, `fix-in-hq`: `jr-choice-name-on-a-lookup-itemset-select`
- `search-expressions`, `never`: `case-search-fixture`
- `supply-features`, `never`: `session-data-supply-point-id-anywhere-except-in-an-advanced-form`,
  `ledgerdb-vellum-id-ledger`, `commtrack-products-commtrack-programs`
- `visit-scheduler`, `never`: `schedule-m-p-f`

**Entries this step adds**

Each entry below becomes REFUSED in this step and holds `subject` from then on. Every one is
`fix-in-hq`; the cause beside it is what `fixCauseOf` gives its reasons, which chooses its sentence
(8.4). There are 14.

- `case-list-registration`, `fix-in-hq` (`breaks-when-run`; part 02, `02-menus.md`, section 14):
  `menus-and-case-lists/case-list-form-post-form-workflow-default-on-a-multi-select-host` (not added
  under part 02's run G3, outcome B)
- `case-types`, `fix-in-hq` (`hq-refuses`; part 04, `04-names.md`, section 11.2):
  `menus-and-case-lists/case-type-outside-the-menu-page-s-grammar`
- `connect-blocks`, `fix-in-hq` (`breaks-when-run`; part 06, `06-the-reader-forms.md`, section 15):
  `questions/connect-deliver-unit-and-task-in-one-form`
- `deep-links`, `fix-in-hq` (`breaks-when-run`; part 07, `07-the-reader-cases-menus-lists.md`,
  section 14): `menus-and-case-lists/case-list-session-endpoint-id-on-a-put-in-root-module`
- `display-conditions`, `fix-in-hq` (`breaks-when-run`; part 07, section 14):
  `menus-and-case-lists/form-filter-reading-the-case-on-a-screen-that-chooses-no-case-first`
- `expressions`, `fix-in-hq` (`breaks-when-run`; part 08, `08-the-reader-expressions.md`, section
  11): `expressions-and-data/session-data-datum-the-entry-does-not-supply`,
  `expressions-and-data/an-expression-core-cannot-evaluate-as-its-author-meant`
- `instance-text`, `fix-in-hq` (`either`; part 03, `03-questions-and-text.md`, section 5.1):
  `questions/connect-block-text-read-as-an-instance`,
  `forms-and-case-writes/form-name-read-as-an-instance`
- `missing-media-files`, `fix-in-hq` (`breaks-when-run`; part 11, `11-project-data.md`, section
  13.1): `expressions-and-data/a-media-reference-with-no-file-on-a-slot-a-runtime-draws`
- `question-logic`, `fix-in-hq` (`hq-refuses`; part 06, section 11.3):
  `questions/default-setvalues-in-an-order-a-save-in-the-form-builder-changes`
- `question-text`, `fix-in-hq` (`hq-refuses`; part 06, section 12.2):
  `questions/a-markdown-form-in-a-form-whose-text-formatting-is-off`,
  `questions/an-explicitly-blank-value-in-the-first-language-where-another-holds-text`
- `search-expressions`, `fix-in-hq` (`hq-refuses`; part 08, section 11):
  `case-search/required-or-validation-test-reading-the-case`
