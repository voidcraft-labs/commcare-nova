# Step 6, part 01: The bar and the manifest

Part of step 6's plan, "Bringing an app in from CommCare HQ". This part makes the admission bar
mechanical. It plans the surface manifest's new fields and rules (the six standings, `subject`, `owner`,
value classes, and what CI fails on), every manifest row re-cut by value, the kept test applied to every
top-level property of an HQ application with the table `KEPT_AT_HQ`, the projection `TargetFacts` and its
three readers (the `.ccz`, Preview and the Publishing card), and the finding type with its circumstances
and its complete copy. It plans pull requests A2 and A3 in full and writes the manifest lines of B2,
the circumstance lines of B1 and the two overlay rules of B8; it names the manifest edits it hands to
A4 to A9, B3 to B6, B8 and B9 by entry id. It is also the one home of every circumstance, subject and
finding sentence the later parts add: sections 2.2, 8.3, 9.2 and 9.3 and Appendix A hold each with
the pull request that lands it.

**The admission bar.** An HQ app A comes in exactly when a Nova document D and ledger rows L exist
such that (a) D passes the absolute gate and export readiness, with no reader-only leniency: the
reader admits exactly what the gate admits; (b) publishing D with L back to A changes nothing a
runtime, CommCare HQ's servers or existing data read, apart from the declared first-publish changes
(part 09, `09-acceptance-and-the-first-publish.md`, section 11, B7); (c) re-reading Nova's own
emission of D gives D exactly; and (d) every item of A's source has exactly one standing. "The
bar's clause (a)" to "(d)" in any part of this plan names one of these four. Acceptance holds them
on every reading (part 09, sections 3 to 6: complete accounting for (d), the gate for (a), the fixed
point for (c), and identity agreement for (b) as far as a source alone can show it). What a standing
is, and where each comes from, is this part's: the standings of section 2, the kept test of section
4 and the findings of section 8.

In stack A, A2 sits on A1 and A3 on A2: the stack's order is A1 to A11 by number (part 15,
`15-stack-contracts-and-exit.md`). A2 reads nothing A1 lands. A3 needs A2, whose `subject` and `owner`
its flips remove and whose TARGET-OWNED schema arm its entries parse under (2.5, 3.8).

Citations are `path::symbol`. Nova is read at `main` `15a00a97`; the Dimagi checkouts at the pins
`proof/pins.json` names: commcare-hq `d6c6e16d8ae1`, commcare-core `8e9ba8d908e9`, commcare-android
`7a5584475580`, commcare-connect `046c7fd78081`, formplayer `24383ac71bfb`, Vellum `01215f251c57`. Every
CommCare fact below was read at those commits for this part. HQ paths are relative to
`corehq/apps/app_manager/` unless they start with another app's name.

Versions at `15a00a97`: `lib/models.ts::MODEL_CONTEXT_VERSION` is `"v6-hq-round-trip-case-writes.14"` and
`lib/db/appTests.ts::RUNTIME_VERSION` is `18`. Nothing in A2 or A3 moves either: no tool the Solutions
Architect holds changes, so this part adds no `scripts/test-schema.ts` entry and asks for no billed run.
`compile_app`, `refresh_deployment` and `get_deployment` are tools only MCP serves
(`lib/mcp/tools/compileApp.ts`, `lib/mcp/tools/deploymentTools.ts`), so A3, which adds an input and two
description sentences to the last two (6.5, 9.6), moves no `MODEL_CONTEXT_VERSION`: `lib/agent/CLAUDE.md`
exempts a tool only MCP serves, and `lib/mcp/__tests__/servedSchemas.test.ts` holds what a client
receives. The lines this part writes for B1, B2 and B8 move neither version (part 15,
`15-stack-contracts-and-exit.md`, decision 3, holds the chain of literals).

| Section | Owns | Pull request |
|---|---|---|
| 2 | the six standings, `subject`, `owner`, value classes, what CI fails on | A2 |
| 3 | every row re-cut by value, with its evidence and the pull request that flips it | A2, A3; named for A4 to A9, B2 to B6, B8, B9 |
| 4 | the kept test over every `Application` property, profile property and translations key class | A3 |
| 5 | `KEPT_AT_HQ`, the full table | A3 (one row in B8) |
| 6 | `TargetFacts`: type, projection, the view-capable reader, the `.ccz`, Preview, the refresh | A3 |
| 7 | the generated translation key rule, the language display name rule and the seeded settings rule | B2, B8 |
| 8 | the finding type, `HqPlace`, `FixCause`, `READ_CIRCUMSTANCES`, the copy model | A2 (types and copy, twenty circumstances), B1 (seven circumstances), B2 (first use, one circumstance, `circumstanceNext`), B9 (six circumstances), B10 (one) |
| 9 | every string this part adds, and every finding string a later part adds | A2, A3; the strings of A9, B1 to B6, B8, B9 and B10 marked there |
| 10 | tests | A2, A3; the B2 and B8 cases marked there |
| 11 | contracts and docs these changes make false | A2, A3; the lines of B8, B12 and B14 marked there |
| Appendix A | `subject` and `owner` for every HELD-NEW and REFUSED entry (A.1, A.2), with the entries later pull requests add in each list's closing block, and what each pull request adds or re-cuts (A.3) | A2; a joining entry in the pull request its block names |

---

## Decisions in brief

1. **A standing is derived, never authored** (section 2.1). `lib/commcare/surface/standing.ts::standingOf`
   maps an entry to one of six standings from its disposition and, for REFUSED, its reason kinds. An entry
   whose reasons hold a kind of both groups is `never`: what stays true after a fix in HQ decides. A
   `fix-in-hq` entry also has a derived cause (`fixCauseOf`: CommCare HQ refuses it, it breaks when the
   app runs, either by case, or it is below the version floor), because the sentence a person reads
   differs by it.
2. **`subject` is required on every HELD-NEW and REFUSED entry and forbidden elsewhere** (2.2). It is one
   of 75 slugs in `lib/publish/hqFindings.ts::SUBJECTS` in A2 (76 after A9, 77 after B2, 78 after B4, 79
   after B5, 78 after B8), each a noun a person would use. Appendix A assigns the 586 entries the manifest
   holds today, and A2's own new entry (3.7) makes it `subject` on 587 entries and `owner` on 238. 2.2
   gives the slug each new entry of parts 02 and 04 takes, and the closing blocks of Appendix A.1 and
   A.2 list the entries later pull requests add, which A.3 counts by pull request.
3. **`owner` is required on every HELD-NEW entry and forbidden elsewhere** (2.3). It is one of step 7's
   ten group ids. An entry step 6 itself flips carries the group it would fall to; the field leaves with
   the flip. Two groups own no entry, because what they hold is no content of an app.
4. **A HELD-NEW entry that shares a surface key with an allowing entry carries a value class** (2.4).
   Three entries gain one; the other 143 hold one already.
5. **The schema lets a TARGET-OWNED entry keep its per-platform reading** (2.5), so the fifteen settings
   keep the Web Apps and Android cells their rows state. Their Preview answer moves from the platform cell
   table to `KEPT_AT_HQ`.
6. **INERT and kept re-cuts land in stack A; a re-cut that claims HELD for something only a reader does
   lands with that reader** (3). A2 carries the re-cuts no code change makes true; A3 the kept flips.
7. **`case_tile_field` blank, or on a list with no tile template or the custom one, is inert, and so is
   every tile cell key on a list that is no custom tile** (3.1, 3.2). HQ's Case List page writes all of
   them on every save; HQ reads `case_tile_field` only to fill a template's slots, and the cell keys
   only to build a custom tile.
8. **The ten "outside Predicate / ValueExpression" rows are re-worded against the checker's rule set
   for the slot** (3.4), which is `record` for all ten: the HELD class is what `checkExpression` admits
   in the slot today, the HELD-NEW class what HQ's validator accepts and the checker refuses. No
   disposition moves in A2.
9. **Twenty-three entries become kept in A3** (3.6): the fifteen seeded profile settings,
   `cc-log-entity-detail-enabled`, runtime UI text in `translations` (two entries), the Android logo
   slots, `mobile_ucr_restore_version` at `1.0` or `1.5`, `auto_gps_capture` on an app that is no Connect
   app, `persistent_menu` and `show_breadcrumbs`.
10. **`persistent_menu` and `show_breadcrumbs` are kept, not not-yet** (4.3). Only Formplayer and the Web
    Apps client read them; Preview draws neither, since its breadcrumb is the builder's own.
11. **`mobile_ucr_restore_version` is kept at `1.0` and `1.5`; `2.0` stays inert** (4.3). Its readers
    are report menus and mobile report choice lists, which their own entries refuse, Nova's publish never
    writes the key, and HQ's three starter apps hold `1.0`, as does the fourth directory of
    `template_apps/`, `wash_before_cond_case_update`, a second copy of `wash` that part 14 counts as
    no base.
12. **Non-empty `build_profiles` is not-yet; empty is kept** (4.3). `features.dependencies` stays
    not-yet: the plan privilege that decides whether HQ writes it is unreadable, and it gates the whole
    app on a phone.
13. **Android logos are kept, with a stated `.ccz`** (4.3). Nova holds no bytes for them, so the archive
    says it carries none.
14. **`KEPT_AT_HQ` holds one row per TARGET-OWNED entry, 49 after A3** (5), each with a `.ccz` cell, a
    Preview cell, an other-project-space cell and the base that exhibits it (`null` for the one row
    whose value no lane configuration can author). A binding test holds the table to the manifest both
    ways.
15. **`TargetFacts` is a pure projection of a deployment's stored baseline source** (6.1), with no new
    column and no backfill. An absent or unread baseline gives none, and Nova's constants stand. The
    type and the reading of HQ's keys live in `lib/commcare/targetFacts.ts`, which the emitter reads;
    `lib/deployment/targetFacts.ts` applies it to a baseline.
16. **A view-capable reader returns the projection and never the source** (6.2). It sits beside
    `readAppBaseline`, which keeps its `edit` gate.
17. **The `.ccz` mirrors HQ's build of the kept values** (6.3): the fifteen settings and the detail-view
    log at the project space's value, its runtime UI text, `PostURL` on the secure receiver where the app
    submits securely, the three profile URLs on its custom base URL's origin, location capture where the
    app captures it, and the worker activity credential where the project space issues one. Three
    things it cannot follow it states in the download's advisories.
18. **Preview's list filter follows the project space's fuzzy search** (6.4), by Core's own rule, with
    the two things each platform does around it: how it splits the typed text, and whether closeness
    reorders the rows (Android) or the list's own order stands (Web Apps). The same change makes the
    filter fold accents as Core does, which it does not today.
19. **Preview learns the facts through a second stream frame, `preview-target-facts`** (6.4), under the
    rule that names `commcare_project`: one reached project space or none.
20. **"Refresh from CommCare HQ" rewrites the baseline only where nothing Nova writes has changed** (6.5).
    Where something has, it writes nothing and says the next publish will show the changes. It is
    offered on every reached card that has a baseline, a card with nothing to list included. The date
    of the kept list is always the baseline's own, worded the same whatever wrote the baseline.
21. **A generated key in `translations` is never kept** (7.1). It is inert where it names no string of
    the app, is blank or equals the text the app's own fields give; held, folded into the one translation
    unit that feeds the string, where that changes no other string; not-yet otherwise.
22. **On a deployment whose app mapping is `adopted`, a language's display name is CommCare HQ's** (7.2):
    a name the project space holds is carried, and an absent one stays absent. Nova writes its label only
    where it created the HQ app. This lands in B8.
23. **On a deployment whose app mapping is `adopted`, a publish seeds none of the fifteen settings**
    (7.3). A setting the project space holds no value for stays absent, in the publish and in the
    `.ccz`, so no worker's own choice on a phone is reset by bringing an app in. This lands in B8.
24. **A finding is `{ code, standing, place, subject, detail }`, and a `fix-in-hq` one also carries its
    `cause`** (8.1). `code` is a manifest entry id or a circumstance: 20 codes in A2, 27 after B1 adds
    the seven part 05 found, 28 after B2, 34 after B9 and 35 after B10 (8.3). A media file over Nova's
    size limit and a table over Nova's caps are manifest entries, not circumstances. A `stop` is no
    standing of anything the app holds: it says the read ended.
25. **Copy is one sentence per subject and standing for `not-yet` and `never` (74 in A2), one per
    subject and cause for `fix-in-hq` (81 pairs in A2, from 45 stems, three cause clauses and 11 whole
    sentences), and one block per circumstance** (9), held complete both ways by tests. A pull request
    that empties a pair removes its sentence, and one that adds a pair adds its sentence, which 9.2
    gives with its pull request. One function, `circumstanceNext`, words every circumstance's next step
    for the account and MCP alike (8.4).

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
  `suite_xml/features/case_tiles.py::case_tile_template_config`, `CaseTileTemplates`.
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
  `sortEntities`, `groupEntities`).
- **A retained HQ read.** `proof/hq-reads/case-list-inline/app-source.json` holds every key section 6
  projects (`secure_submissions`, `custom_base_url`, `build_profiles`, `practice_mobile_worker_id`,
  `persistent_menu`, `show_breadcrumbs`, `logo_refs`, `mobile_ucr_restore_version`, `auto_gps_capture`,
  `profile`, `translations`), so the source read serves them and the stored baseline keeps them.
- **The other parts, where they meet this one.** Part 02 (`02-menus.md`, its section 14 and its
  needs), part 03 (`03-questions-and-text.md`, its two new entries), part 04 (`04-names.md`, its
  sections 2.4 and 11 and its needs), part 05 (`05-reading-commcare-hq.md`, its sections 4, 8 and 12,
  its "Copy" and its needs) and part 10 (`10-identity-and-the-ledger.md`, the claim and its section
  5.5, the `read` baseline of its 6.3, the drift wording of its 9, its "Contracts" and its needs).
  For the rows of later parts this part holds: part 06 (`06-the-reader-forms.md`, sections 6.3, 8.8,
  12.2 and 16.3), part 07 (`07-the-reader-cases-menus-lists.md`, section 14 and its "Copy"), part 08
  (`08-the-reader-expressions.md`, section 11), part 09 (`09-acceptance-and-the-first-publish.md`,
  sections 9, 11.2 and 14), part 11 (`11-project-data.md`, section 13), part 12
  (`12-the-reading-and-the-birth.md`, sections 2.3, 3.8 and 6.5), part 13 (`13-the-experience.md`,
  sections 7 and 8.7) and part 14 (`14-proof.md`, sections 6.2 and 7.5). Where one of them asked
  something of this part, the answer is under "What this part needs of other parts".

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
  from the start (`views/apps.py::new_app`, `default_new_app`). A3 replaces the comment and the
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
  "José" on a device and not in Preview. A3 fixes it with the fuzzy rule, since both are one function.
- **Found while planning, the two runtimes around Core's filter:** Android splits the typed text on
  runs of whitespace (`EntityListAdapter.java::filterByString`, `split("\\s+")`) and shows the matches
  in the order the filter returns them, closest first under fuzzy search. Formplayer splits on single
  spaces (`EntityScreenHelper.java::filterEntities`, `split(" ")`) and then sorts the matches by the
  list's own order and groups them (`sortEntities`, `groupEntities`), so in Web Apps closeness orders
  only rows the list's order ties. Preview follows each on the platform it plays (6.4).
- **Found while planning, publish:** the fifteen seeded settings are written wherever the project
  space holds no value (`targetOverlay.ts::projectProfileForTarget`, `holdsNoValue`), and each is
  written forced but the map layer. HQ's build writes nothing for an absent one
  (`Application.create_profile`), so a first publish over an app made in HQ would turn fifteen absent
  settings into forced ones, and a forced setting returns a worker's own choice on the phone to that
  value at every update (`appProfileSettings.ts`, its header). On an app Nova created that is Nova's
  own stated behavior. On an app Nova brings in it would be a change to workers' phones, so an adopted
  deployment is not seeded (7.3, B8).
- **Found while planning, Preview:** Preview marks every required question, on either platform. Android
  marks one only where `cc-label-required-questions-with-asterisk` is `yes`, and Nova's own value is
  `no`. No doc states it. A3 states it (5, row 30); changing what Preview draws is not this step's.
- **Found while planning, publish:** a language a Nova author removes stays in each of HQ's build
  profiles, because an update writes `langs` and never `build_profiles`, where HQ's own Languages page
  removes it from both (`views/apps.py::edit_app_langs`, the loop over `app.build_profiles`). This
  predates step 6 and reaches only an app whose HQ copy has build profiles. Its owner is step 7's
  group `settings-nova-comes-to-own`, through the new entry
  `application-and-settings/build-profiles-non-empty`, and A2's implementer files it as an issue
  before A2 opens (3.7).

---

## Written and not yet run

**Run 1: the `.ccz` mirror, on a kept configuration.** Where: the proof lane, in the pinned image, by
hand on hosted runners, with pull request A3. What: the targeted corpus document
`targeted-kept-values` (part 14, `14-proof.md`, section 11.1, A3's row), which declares Android,
published to an HQ app whose source was first given each mirrored value of section 5 (the fifteen
settings at a choice other than Nova's seed, `cc-log-entity-detail-enabled`, one runtime UI text key in
each language, `secure_submissions: true`, `auto_gps_capture: true`, and
`profile.features.credentials: "3MON_ACTIVE"`), then proof 3 between HQ's build and
the local archive, and proof 2 over `profile.ccpr` and each `app_strings.txt`.

| Outcome | What lands |
|---|---|
| No difference | The cells of section 5 stand. The document stays in the corpus as the control of the kept rows and stays beside B13's base `hq-kept-settings`: the two are different deployments, a Nova-born app whose kept values a person saved in HQ and an app made in HQ and brought in (part 14, section 11.2). |
| A profile property differs in value or `force` | The fix is in `lib/commcare/keptProfile.ts::targetProfileProperties`, in A3, before it merges. No register entry: the plan and the build must agree. |
| A property HQ writes is absent from the archive for a key section 4 calls inert | That entry is not inert on Android. Its row moves to kept with `mirrors`, the key joins `KEPT_PROFILE_PROPERTY_KEYS`, in A3. |
| An app string differs for a runtime UI key | The fix is in `compileCcz`'s table merge (6.3), in A3. |
| `PostURL` differs under `secure_submissions` | The fix is in `profileServerProperties`, in A3. |
| The `<credentials>` block differs or is absent on one side | The fix is in `generateProfile`'s features (6.3), in A3. Where HQ's build writes none for a stored level, the row moves to `no-reader` and `credentialLevel` leaves `TargetFacts`, in A3. |
| HQ's build shows a difference no row of section 5 names | The key is put to the kept test of section 4, in A3, before it merges. Where no publish writes it, nothing the document holds does something different under it, and the archive can write HQ's value from the stored source or state the difference in an advisory, its entry becomes TARGET-OWNED with a `KEPT_AT_HQ` row (`mirrors` or `states`). Where clause 2 or clause 3 fails, its entry moves to not-yet with owner `settings-nova-comes-to-own`. |

`custom_base_url` is not in the run: the setting shows only under the flag `CUSTOM_APP_BASE_URL`, which
the lane's project spaces do not hold. Its row rests on reading `ApplicationBase.url_base` and
`absolute_url_property`, and on a Vitest over `profileServerProperties` whose vectors include a base
URL with a path.

**Run 2: Core's fuzzy match, natively.** Where: the proof lane's native family `expression`, with A3.
What: the vectors of `lib/preview/__tests__/listFilterMatch.test.ts` (section 10) run through
`org.commcare.cases.util.StringUtils.fuzzyMatch` and `normalize`.

| Outcome | What lands |
|---|---|
| Every vector agrees | Nothing more. The native test stays as the control. |
| A vector differs | The port in `lib/preview/listFilterMatch.ts` is corrected in A3 and the vector kept. |

The run holds Core's two functions alone. How each runtime splits the typed text and orders the matches
is read at source (6.4) and held by Vitest vectors worked from Java's `String.split`.

**Run 3: an app made in HQ with an empty profile, brought in.** Where: the proof lane, inside part
14's P2 dispatch on B13's branch, on the base `hq-new-app` (whose profile holds none of the fifteen
settings), which lands in B13; B8 lands the code and its Vitest (`keptProfile.test.ts`), and an
outcome that changes code amends B8 on the stack before stack B merges. What: the
first publish over the adopted deployment, then proof 3 between HQ's build and the local archive made
for that deployment, and proof 1 over `profile` against the first-publish register.

| Outcome | What lands |
|---|---|
| The publish leaves `profile.properties` without the fifteen, and the archive writes none of them | Section 7.3 stands. The base stays as its control. |
| The publish writes a seeded key | The fix is in `projectProfileForTarget`'s `seeds` option or in `publishAppToHq`'s choice of it (7.3), in B8. No register entry: an adopted deployment is not seeded. |
| The archive writes a seeded key HQ's build does not | The fix is in `targetProfileProperties` (6.3, 7.3), in B8. |
| HQ's build writes a property for an absent key of the fifteen | That setting has a default HQ writes on its own. For an adopted deployment the archive writes HQ's default at HQ's `force` for it (`targetProfileProperties`), and the publish still writes nothing, in B8. |

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
substring match (`components/preview/shared/listFilter.tsx::rowMatchesFilterText`).

---

## 2. The manifest's new fields and rules (A2)

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

The reader's runtime index of entry id to standing, cause, subject and owner is part 06's
(`06-the-reader-forms.md`, section 3, B2); it calls `standingOf` and `fixCauseOf` and adds no rule of
its own.

### 2.2 `subject`

`lib/publish/hqFindings.ts` holds the subjects: it is read by the manifest schema, by the reader and by
client copy, and holds no manifest JSON.

```ts
export const SUBJECTS = [
	/* the slugs of the table below, in its order; a row marked new joins in its pull request */
] as const;
export type Subject = (typeof SUBJECTS)[number];
// lib/commcare/surface/schema.ts
export const subjectSchema = z.enum(SUBJECTS);
```

`schema.ts::inventoryEntrySchema` gains `subject: subjectSchema` on the HELD-NEW arm and on the REFUSED
arm. The other arms stay strict objects without it, so a HELD, TARGET-OWNED or INERT entry that names a
subject fails to parse.

The closed set is 75 in A2. A9 adds `case-types` with part 04's entry that uses it (the table under
this one), B2 adds `translation-overrides` with the entry that uses it, B4 adds `advanced-menus` and B5
`list-and-search-filters` with part 07's entries that use them (`07-the-reader-cases-menus-lists.md`,
section 14), and B8 removes `language-display-names` with the flip of its one entry. So the set runs
75 (A2), 76 (A9), 77 (B2), 78 (B4), 79 (B5), 78 (B8). Each row gives the count of entries that take
the subject by standing (not-yet / never / fix-in-hq) as the manifest stands today. Appendix A lists
the entries of each.

| Subject | What it names to a person | Entries |
|---|---|---|
| `advanced-forms` | the cases an advanced form loads or opens | 7 / 0 / 23 |
| `advanced-menus` | an advanced menu | 1 / 0 / 0 (new entry, B4) |
| `after-submit` | where a form goes after it is sent | 0 / 2 / 4 |
| `android-app-dependencies` | Android apps the phone must have | 1 / 0 / 1 |
| `app-document` | how CommCare HQ stores the app | 0 / 1 / 7 |
| `app-logos` | app logos | 1 / 0 / 1 |
| `app-settings` | an app setting | 5 / 2 / 3 |
| `auto-select` | choosing a case for the worker | 2 / 0 / 3 |
| `blank-form` | a form with no questions | 0 / 0 / 1 |
| `build-profiles` | build profiles | 1 / 0 / 0 (new entry, 3.7) |
| `call-center-indicators` | call center indicators | 0 / 1 / 0 |
| `case-attachments` | pictures or files saved on a case | 0 / 4 / 0 |
| `case-detail-tabs` | tabs on the case detail screen | 5 / 0 / 1 |
| `case-list-callout` | a lookup from the case list into another Android app | 8 / 0 / 2 |
| `case-list-columns` | a case list or case detail column | 20 / 3 / 18 |
| `case-list-filter` | the case list filter | 1 / 0 / 1 |
| `case-list-optimizations` | a case list speed setting | 2 / 2 / 0 |
| `case-list-registration` | a form offered from the case list | 4 / 0 / 2 |
| `case-list-setup` | how a case list is set up | 0 / 0 / 4 |
| `case-list-sorting` | the order of a case list | 6 / 0 / 2 |
| `case-list-text` | a list's own wording | 2 / 0 / 0 |
| `case-preloads` | a question that loads a case value | 3 / 0 / 5 |
| `case-property-names` | a case property name | 0 / 0 / 5 |
| `case-sharing` | case sharing | 2 / 0 / 1 |
| `case-tiles` | a case tile | 8 / 0 / 7 |
| `child-cases` | a child case | 0 / 1 / 8 |
| `commcare-version` | the CommCare version the app is built for | 0 / 0 / 1 |
| `connect-blocks` | a CommCare Connect block | 1 / 0 / 2 |
| `custom-assertions` | custom assertions | 0 / 3 / 0 |
| `custom-device-properties` | custom device properties | 0 / 1 / 0 |
| `data-registry` | a data registry | 0 / 4 / 0 |
| `data-sources` | data a form or list reads from the device | 1 / 0 / 8 |
| `deep-links` | a deep link | 2 / 0 / 1 |
| `display-conditions` | a menu's or form's display condition | 3 / 0 / 5 |
| `display-only-forms` | forms shown in the menu above their own | 1 / 0 / 4 |
| `expressions` | an expression | 0 / 0 / 9 |
| `form-case-management` | a form's case management | 0 / 0 / 11 |
| `form-settings` | a form setting | 2 / 0 / 2 |
| `form-source` | a form's source | 0 / 0 / 8 |
| `hand-written-content` | hand-written XML or settings no HQ page edits | 0 / 19 / 0 |
| `hierarchical-locations` | the older, nested list of places | 0 / 3 / 0 |
| `language-codes` | a language code | 0 / 0 / 2 |
| `language-display-names` | the app's own name for a language | 1 / 0 / 0 |
| `linked-app` | a linked app | 0 / 0 / 2 |
| `list-and-search-filters` | a case list filter its search doesn't share | 1 / 0 / 0 (new entry, B5) |
| `lookup-selection` | choosing from a lookup table before the case list | 0 / 2 / 0 |
| `lookup-tables` | a lookup table | 7 / 0 / 2 |
| `media-by-language` | a picture or sound that differs by language | 3 / 0 / 0 |
| `media-files` | a media file | 3 / 0 / 8 |
| `menu-badges` | a badge on a menu or form | 2 / 0 / 0 |
| `menu-display` | grid menus | 3 / 0 / 0 |
| `menu-settings` | a menu setting | 0 / 0 / 1 |
| `menu-structure` | how menus are nested | 0 / 1 / 2 |
| `mirror-menus` | a mirror menu | 4 / 2 / 5 |
| `mobile-reports` | mobile reports | 0 / 5 / 0 |
| `parent-selection` | choosing a parent case first | 0 / 2 / 3 |
| `print-templates` | a print template | 0 / 2 / 0 |
| `question-appearance` | how a question looks | 56 / 6 / 2 |
| `question-choices` | a question's choices | 4 / 0 / 8 |
| `question-ids` | a question ID | 0 / 1 / 2 |
| `question-logic` | a question's logic | 0 / 0 / 5 |
| `question-media` | a picture, sound or label form on a question | 4 / 0 / 1 |
| `question-text` | a question's text | 4 / 0 / 7 |
| `question-types` | a kind of question | 9 / 0 / 12 |
| `remote-app` | a remote app | 0 / 1 / 0 |
| `repeats` | a repeat group | 1 / 0 / 14 |
| `save-to-case` | a Save to Case question | 6 / 2 / 5 |
| `search-default-filters` | a search filter | 12 / 1 / 4 |
| `search-expressions` | a search expression | 1 / 2 / 4 |
| `search-fields` | a search field | 8 / 0 / 6 |
| `search-setup` | how the search is set up | 9 / 2 / 4 |
| `shadow-forms` | a shadow form | 4 / 0 / 3 |
| `supply-features` | CommCare Supply features | 0 / 9 / 0 |
| `training-menus` | a training menu or release notes form | 0 / 3 / 0 |
| `translation-overrides` | changed wording for a menu, form or list held in the app's translations | 1 / 0 / 0 (new entry, B2) |
| `visit-scheduler` | a visit schedule | 0 / 5 / 0 |
| `worker-record` | the worker's own record | 4 / 1 / 4 |
| `writer-types` | answers of different kinds saved to one case property | 5 / 0 / 0 |

How Appendix A was cut, so a new entry takes its subject the same way: (1) a `retiring` reason whose
flag is CommCare Supply, mobile reports, the visit scheduler, a data registry, case attachments, training
menus, the nested location list, custom assertions or printing takes that feature's subject, wherever
the row sits; (2) a `freeform` reason with no closer subject takes `hand-written-content`; (3) otherwise
the entry takes the subject of the thing its author would name, which is nearly always its inventory
section's.

**The subjects of entries other parts add.** Each new entry of parts 02 and 04 takes a slug of the
closed set; the words in quotation marks below say what the entry is about. The pull request that
adds the entry adds any sentence its pair lacks, because the completeness test of section 10 fails
without it. No sentence waits for stack B.

| Part | Entries | Subject | What the pull request adds to the copy |
|---|---|---|---|
| 02 (A5) | its six new HELD-NEW `case-list-form-…` entries, and the two it keeps HELD-NEW (the eight ids are in Appendix A.1, two in its `menus-and-case-lists/` block and six in its closing block) | `case-list-registration` | nothing: the `not-yet` sentence exists |
| 02 (A5) | its new REFUSED entry `case-list-form-post-form-workflow-default-on-a-multi-select-host` (`broken-at-runtime`; it names no subject there) | `case-list-registration` | nothing: the subject's stem and the `breaks-when-run` clause compose its sentence (8.4) |
| 04 (A9) | N1, a case type outside the menu page's grammar ("a case type") | `case-types`, new in A9: label "Case types" | `SUBJECTS` gains it; whole sentence for `hq-refuses`: "A case type here holds a character CommCare HQ's menu settings can't save." |
| 04 (A9) | N2, N7 ("a case property") | `case-property-names` | `not-yet`: "A case property name here is one Nova can't hold yet." |
| 04 (A9) | N3, N8 ("a Search field") | `search-fields` | nothing |
| 04 (A9) | N4, N5 ("a lookup table") and N24 (`expressions-and-data/tag-or-field-name-holding-a-period`, owner `project-data-at-hq-size`) | `lookup-tables` | nothing |
| 04 (A9) | N6 ("a choice") | `question-choices` | the `not-yet` sentence is re-worded to hold a choice's own value too: "A question's choices here are set up in a way Nova can't hold yet." |
| 04 (A9) | N9 ("a menu": a child menu of another case type under a parent with no forms) | `menu-structure` | `not-yet`: "How this menu is nested is something Nova can't hold yet." |
| 04 (A9) | N14 ("a menu": a parent menu of another case type) | `parent-selection` | `not-yet`: "This chooses a parent case first in a way Nova can't hold yet." |
| 04 (A9) | N10 ("a case list") | `case-list-setup` | `not-yet`: "This case list is set up in a way Nova can't hold yet." |
| 04 (A9) | N11, N12, N13 ("a case list column") | `case-list-columns` | nothing |
| 04 (A9) | N15, N16 ("a CommCare Connect block") | `connect-blocks` | the `not-yet` sentence is re-worded to hold every block: "A CommCare Connect block here is set up in a way Nova can't hold yet." |
| 04 (A9) | N17, N18, N19 ("a question": required, a validation condition or a default on a kind Nova gives none) | `question-logic` | `not-yet`: "A question's logic here is something Nova can't hold yet." |
| 04 (A9) | N20, N21, N23 ("a question": hint, help or validation text on a kind Nova gives none) | `question-text` | nothing |
| 04 (A9) | N22 ("a question": help media on a kind Nova gives none) | `question-media` | the `not-yet` sentence is re-worded to hold help media too: "A question here carries a kind of media or label form Nova can't hold yet." |

Part 03's two new entries name slugs of the set already:
`questions/a-markdown-form-in-a-form-whose-text-formatting-is-off` takes `question-text` and lands in
B3 (part 06, section 12.2), and `case-search/title-label-blank-in-some-languages` takes `search-setup`
and lands in B5 (part 07, section 14).

**The subjects and sentences stack B's readers add.** A reader part that adds an entry names a subject
of this set, or asks for a new one with its label and what it names. Two were asked for and are in the
table above: `advanced-menus` (B4) and `list-and-search-filters` (B5), both part 07's. Every sentence
such an entry's pair lacks is in 9.2's second table with the pull request that lands it, and every
entry is in the closing block of Appendix A.1 with its subject and owner, or of A.2 with its subject
and standing.

### 2.3 `owner`

`hqFindings.ts` also exports step 7's group ids, the ten groups `7-rest-of-model.md` plans, in its
order (its sections 1 to 10, each headed by its id):

```ts
export const STEP_7_GROUPS = [
	"changes-made-in-hq", "project-data-at-hq-size", "settings-nova-comes-to-own",
	"question-display", "case-list-and-detail", "menus", "case-search",
	"forms-and-case-management", "xform", "second-project-space",
] as const;
export type Step7Group = (typeof STEP_7_GROUPS)[number];
```

`inventoryEntrySchema`'s HELD-NEW arm gains `owner: z.enum(STEP_7_GROUPS)`; no other arm admits it.
Appendix A.1 assigns all 237. Counts after A2: `question-display` 63, `case-list-and-detail` 56,
`case-search` 30, `forms-and-case-management` 23, `xform` 24, `menus` 15,
`settings-nova-comes-to-own` 15 (the 14 of the appendix and the new build-profiles entry),
`project-data-at-hq-size` 12. `changes-made-in-hq` and `second-project-space` own no entry: bringing in
what changed in HQ and updating a copy in a second project space are things Nova does, not content an
app holds. A reading meets neither: it reads one app in one project space once. Step 6 states the
first at the drift stop (part 10, section 9; part 13, 11.3) and the second in the review and the
publish dialog (part 13, V21c and D7). No finding and no circumstance carries either owner.

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

An entry step 6 flips carries the group it would fall to and no marker of the flip, so no value of
`owner` is transitional. Section 3.8 lists those entries with the pull request that removes the field.

### 2.4 Value classes

Rule, from A2: **a HELD-NEW entry that shares a surface key with a HELD, TARGET-OWNED or INERT entry
carries a `valueClass`.** 146 HELD-NEW entries share one; 143 hold a class today. A2 adds three:

| Entry | Shares its key with | `valueClass` added |
|---|---|---|
| `expressions-and-data/groups-jr-fixture-user-groups` | on `instance-source:fixture`, the HELD lookup and locations rows (`item-list-tag-read-through-nova-s-typed-lookup-carriers`, `item-list-tag-read-in-any-other-expression`, `locations-flat-jr-fixture-locations-read-in-an-expression`) and the INERT `declared-unreferenced-fixture-instance-item-list-locations-user`; on the two instance declaration keys, those and the other HELD instance rows (`casedb`, the session, search results, selected cases) | `user-groups-fixture` |
| `forms-and-case-writes/function-datum-endpoints` | `forms-and-case-writes/shadow-own-fields-name-media-custom-icons-form-filter-post-form` (HELD) | `computed-endpoint-argument` |
| `forms-and-case-writes/arbitrary-datums-datum-id-datum-function` | the same HELD entry | `computed-datum` |

A value class stays a slug whose meaning is the entry's `item` and `dispositionCell`. What makes it
mechanical is not the manifest but the two things that read it: the reader's claim (each claim names the
entry id whose class it decided; part 06, `06-the-reader-forms.md`, section 4.2, B2) and the variants'
`expected.json` (part 14, `14-proof.md`, section 7.1, B13). The manifest's
own duty, which CI holds, is that the classes of one key do not overlap and that none is missing where a
key is split.

### 2.5 A kept entry keeps its platform reading

`inventoryEntrySchema`'s third arm takes `TARGET-OWNED` and `INERT` with `notApplicablePlatformsSchema`.
From A2 it splits: `INERT` keeps `notApplicablePlatformsSchema`, and `TARGET-OWNED` takes
`heldPlatformsSchema`, as HELD and HELD-NEW do. The 26 TARGET-OWNED entries of today keep
`kind: "not-applicable"`, which `heldPlatformsSchema` admits. The fifteen settings keep the Web Apps and
Android cells their rows state when A3 flips them, so no inventory row loses a reading.

`surface/__tests__/platformFeatures.test.ts::readingsOf` and
`lib/preview/__tests__/platformCells.test.ts::requiredCells` read HELD entries alone and stay as they
are. So in A3 the flipped entries leave `platformFeatureEntries.ts::AMBIENT_PLATFORM_ENTRIES` (rule 2 of
that test refuses a named entry that is not HELD) and `platformCells.ts::PLATFORM_CELLS` (the cell test
refuses a row that outlives its cell): the thirteen ids of section 3.6's last column. What Preview does
for each is `KEPT_AT_HQ`'s Preview cell from then on.

### 2.6 What CI fails on, from A2

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

`surface/__tests__/manifest.test.ts` gains five rules, each one function over the parsed manifest with
a planted failing case beside it, as its existing rules have.

| Rule | Fails when | Message |
|---|---|---|
| subject used | a member of `SUBJECTS` is the subject of no entry | `The subject <subject> is the subject of no entry. Remove it from SUBJECTS and its sentences from the finding copy, or give it to the entry it was added for.` |
| class on a shared key | a HELD-NEW entry shares a surface key with an allowing entry and has no `valueClass` | `<id> is HELD-NEW and shares <key> with <other id>, which holds the rest of that key's values. Give <id> the value class that says which values it takes.` |
| standing total | `standingOf` throws for an entry, or `fixCauseOf` gives `null` for a `fix-in-hq` entry | `<id> has no standing: <error>.` |
| mixed reasons are listed | a REFUSED entry holds a kind of both groups and is not in the test's list `MIXED_REASON_ENTRIES`, which holds the two ids of 2.1 | `<id> holds a reason a fix in CommCare HQ lifts and one it does not, so it reads as "never": a person is told the app can't come in while it uses this, and is not sent to change it. Where that is true of it, add its id to MIXED_REASON_ENTRIES in this test. Where a change in CommCare HQ would lift it, drop the reason that does not apply.` |
| the version floor stands alone | a REFUSED entry holds `below-commcare-version-floor` beside another kind of `FIX_IN_HQ_REASON_KINDS` | `<id> is refused for the CommCare version floor and for something else. Give the other reason its own entry: a person reads one sentence, and the floor's names the version.` |

**A pull request that empties a pair removes its sentence.** The copy test of section 10 holds the
finding copy to the manifest both ways, so a flip that takes the last entry of a subject and standing
(or a subject and cause) removes that sentence in the same pull request, and one that takes a
subject's last entry removes the subject. In step 6 that is: A3, `app-settings` and `app-logos` at
`not-yet`; A4, `display-only-forms` at `not-yet`; B8, the subject `language-display-names`.

**A pull request that adds a pair adds its sentence.** The same test fails an entry whose subject and
standing have no sentence. In step 6 that is, each with the words 9.2's second table gives: A9, the
sentences of 2.2's table; B2, `translation-overrides` and `language-codes` at `not-yet`; B3,
`form-source` and `question-ids` at `not-yet`; B4, `display-only-forms` at `not-yet`, added back with
a new sentence, `form-case-management` and `menu-settings` at `not-yet`, and the new subject
`advanced-menus`; B5, the new subject `list-and-search-filters`; B6, `expressions` at `not-yet`.

**A pull request that widens a pair re-words its sentence.** No test can hold this one: a sentence
written for the one entry of its pair stays present, and goes false, when a second entry of another
shape joins the pair. So each joining entry of Appendix A was read against the sentence it would
show. A9 re-words three `not-yet` sentences for its entries (2.2's table), and B3 re-words the
`not-yet` sentence of `repeats`, which A2 words for a repeat's button captions alone, for part 06's
model iteration entry (9.2's second table). The `not-yet` sentence of `case-list-columns` is worded
in A2 for every entry the pair holds by B5: a column's format, its expression, its header, and
its property's name where that is outside Nova's grammar (part 07's
`menus-and-case-lists/column-field-outside-nova-s-property-grammar`, B5). "Set up in a way" is true
of each, where "shows its value in a way" would be false of the last, so no later pull request
re-words it.

The coverage line the test prints gains the standings: "472 of 1,253 entries held; 26 kept, 168 inert,
238 not yet, 93 never, 256 to change in CommCare HQ" (the numbers as A2 leaves them: its three new
entries are two inert and one not yet; the test computes them).

The proof lane reads entries by key and ignores a field it does not name
(`proof/checks/manifest_usage.py`, its `Entry`), so `subject` and `owner` change no lane verdict. No
entry A2 or A3 moves has a reader in `manifest_value_classes.py::VALUE_CLASSES`, whose tile readers
already test `case_tile_template` before they call a use refused.

---
## 3. Rows re-cut by value

Each row below names the entry, its cell today, the new wording, the inventory row that moves with it
(a file under `docs/research/2026-09-26-hq-round-trip/inventory/`, in the same pull request), the
evidence at source, and the pull request that makes the edit. The rule for where an edit lands: A2
carries a re-cut that no code change makes true (an inert class, a split that only narrows, a re-wording,
a stale cell); A3 carries the kept flips, which its `.ccz` and Preview readers make true; a re-cut that
calls a value HELD because a reader recognizes it lands in the stack B pull request whose reader first
claims it, and an entry a new concept holds flips in that concept's pull request of stack A. Every edit
keeps the manifest test green in its own pull request.

### 3.1 `case_tile_field` (A2)

| | |
|---|---|
| Entry | `menus-and-case-lists/case-tile-field-template-slot-on-icon-text-grid` |
| Today | HELD-NEW, no value class, on `schema:DetailColumn.case_tile_field`: "`column.tileSlot`". Read mechanically, `""` on any column refuses the app. |
| From A2 | The entry gains `valueClass: "slot-on-a-template-tile"`, `subject: "case-tiles"`, `owner: "case-list-and-detail"`; its `item` becomes "`case_tile_field` holding text, on a detail whose `case_tile_template` is a template with slots: `icon_text_grid`, or `person_simple` or a removed template, where the detail's own REFUSED entry also applies". A new entry beside it: `menus-and-case-lists/case-tile-field-blank-or-off-a-template-tile`, INERT, `valueClass: "blank-or-off-a-template-tile"`, same surface key, `item`: "`case_tile_field` `\"\"` or `null`, or any value on a detail with no `case_tile_template` or with `custom`", `dispositionCell`: "**INERT**: HQ's Case List page writes `\"\"` on every column at every save (`details/bootstrap5/column.js`, `serialize`), and HQ reads the key only to fill a template's slots, which a detail with no template, or with the `custom` one, has none of (`suite_xml/features/case_tiles.py::case_tile_template_config`, `CaseTileHelper._get_matched_detail_column`; `helpers/validators.py`, the tile checks)", platforms `not-applicable` (`n/a`), emission `omit` with the marker `omit`, no gates. The two classes split every value of the key: blank anywhere, and text on a detail with no slots, are inert; text on a detail with slots is the HELD-NEW entry's. |
| Inventory | `menus-and-case-lists.md`, the row "`case_tile_field` (template slot) on `icon_text_grid`": re-worded, and the new row added under it. |
| Evidence | `models/case_list.py::DetailColumn.case_tile_field` is a `StringProperty(exclude_if_none=True)`, default `None`. `column.js` sets `self.original.case_tile_field = … \|\| ""` and `serialize` writes `column.case_tile_field = self.case_tile_field()` for every column. Readers: `CaseTileHelper.__init__` builds `cols_by_tile_field`, read only by `_get_matched_detail_column`, which `build_case_tile_detail` calls for each of `case_tile_template_config(template).fields` in its branch for a template other than `custom`; `suite_xml/sections/details.py` reaches the helper only under `if detail.case_tile_template:`; `case_tile_template_config("custom")` returns no fields, and both members of `CaseTileTemplates` (`person_simple`, `icon_text_grid`) load a file that names them; the validator's slot check runs inside `if detail.case_tile_template:` over the same `fields`. No reader in Core, Android or Formplayer: the key never reaches a suite. A column's slot on `person_simple` is `not-yet` like one on `icon_text_grid`, since it is the same Nova slot (`column.tileSlot`) that would hold it; the `person_simple` template itself keeps its own REFUSED entry (`detail-case-tile-template-person-simple`), so such an app is told both. No key is added to a REFUSED entry, so the lane's readers of those classes (`manifest_value_classes.py::VALUE_CLASSES`) meet no new key. Lifecycle: alive. |

### 3.2 Tile cell keys on a list that is no tile (A2)

| | |
|---|---|
| Entries | `menus-and-case-lists/grid-x-grid-y-width-height-custom-tile` (HELD, `placed-custom-tile-column`), `horizontal-align-vertical-align` (HELD, `explicit-value`), `font-size` (HELD, `explicit-value`), `show-border-show-shading` (HELD, `custom-tile-column`), and the three REFUSED null rows (`custom-tile-column-with-grid-null-unplaced`, `horizontal-align-null-on-a-placed-custom-tile-column`, `custom-tile-font-size-null`) |
| Today | Each HELD class is worded for a custom tile. No entry says what the nine keys mean on a detail with no tile, where HQ's page writes `grid_x: 0`, `grid_y: 0`, a width and a height, `horizontal_align: "left"`, a `vertical_align`, `font_size: "medium"`, `show_border` and `show_shading` on every column. |
| From A2 | A new entry `menus-and-case-lists/tile-cell-keys-on-a-list-that-is-not-a-tile`, INERT, `valueClass: "off-a-custom-tile"`, surface keys `schema:DetailColumn.grid_x`, `.grid_y`, `.width`, `.height`, `.horizontal_align`, `.vertical_align`, `.font_size`, `.show_border`, `.show_shading`, `item`: "`grid_x`, `grid_y`, `width`, `height`, `horizontal_align`, `vertical_align`, `font_size`, `show_border`, `show_shading` at any value, on a detail with no `case_tile_template` or with a template other than `custom`, whose layout is the template's own", `dispositionCell`: "**INERT**: HQ's Case List page writes all nine on every column at every save, and HQ reads them only while it builds a custom tile (`CaseTileHelper.build_case_tile_detail`, under `case_tile_template == CUSTOM`). Read as cells they would stack every column at the top left; Nova reads none and writes none while a list has no tile", platforms `not-applicable`, emission `omit`. The four HELD entries' `item` cells gain "on a detail whose `case_tile_template` is `custom`", which their value classes already say. |
| Inventory | `menus-and-case-lists.md`, "Detail columns": the new row, and the four re-worded. |
| Evidence | `column.js`, `serialize`: `column.grid_x = self.tileColumnStart() - 1` and the eight beside it, unconditionally. `CaseTileHelper.build_case_tile_detail` builds a `Style` from them only in its `CUSTOM` branch. `lib/commcare/hqJson/caseList.ts::applyTileLayoutToShortDetail` writes them only while the list has a tile layout (`lib/domain/modules.ts::tileCellFor`), so Nova's exports hold none off a tile and the lane sees no new use. Lifecycle: alive. |

A Nova document may hold cells while its tile layout is off (`tileCellFor` keeps the drawing). Those cells
reach no wire, so a reading of Nova's own export gives a document without them. That is the
canonicalization `dormant-tile-cells`: a row of `READER_CANONICAL_CHOICES` part 07 adds in B5
(`07-the-reader-cases-menus-lists.md`, section 11.5), proven by part 09's `canon.test.ts`
(`09-acceptance-and-the-first-publish.md`, section 9, B7).

### 3.3 Stale cells (A2)

Each is a re-wording with no disposition change. The inventory row takes the same words.

| Entry | Stale words | New words |
|---|---|---|
| `application-and-settings/multimedia-map` | emission: "(Nova also writes a map with content-hash ids on create today, `bundle.ts::buildMultimediaMap`)" | emission: "media bytes through HQ's multimedia upload; Nova sends no `multimedia_map` in any mode" |
| `application-and-settings/translations-lang-code-any-other-value-or-absent-where-hq-s` | cell: "Nova derives every name today" | cell: "Nova writes its own label for every language on a publish (`targetOverlay.ts::projectTranslationsForTarget`)" |
| `menus-and-case-lists/modulebase-unique-id` | emission: "(today random per expansion)" | emission: "the target's recorded id; derived from the menu's UUID elsewhere (`wireIdentity.ts`)" |
| `forms-and-case-writes/update-through-the-date-and-time-join-of-a-date-and-a-time` | cell: "arriving with step 4" | cell: "a datetime writer Nova emits from step 4 (`nova_datetime_<question>`); no reader recognizes it yet" |
| `case-search/several-xpath-query-rows` | cell: "(today Nova emits one row per top-level conjunct…)" | cell: "Nova emits one row per top-level conjunct of its composed condition (`xpathQuery.ts::composeXPathQueryEmission`), and HQ joins every row with `and` (`case_search/utils.py::_apply_filter`); no reader reads rows back yet" |
| `forms-and-case-writes/xmlns-form-json-and-xform-data-node` | cell: "…; widen: `Form.xmlns`, a stored submission identity an import keeps for a new project space and the local `.ccz`", and that `widen` in `slotChanges` | `slotChanges: []`, and the cell part 10 fixes (`10-identity-and-the-ledger.md`, "Contracts", the surface manifest row; B8 plans the ledger, A2 lands this cell): "**HELD**: derived from the form's UUID (`wireIdentity.ts::derivedFormXmlns`), or the `xmlns` the deployment ledger records for that project space (`app_deployment_identities`, `wireIdentity.ts::targetWireIdentity`): an app brought in from CommCare HQ keeps HQ's `xmlns` for every form on the project space it came from, and takes the derived one everywhere else" |

The `xmlns` row is row 20 of part 04's table of widens (`04-names.md`, section 2.4, A9), which hands
it to A2. What makes the widen false is this plan's decision that a form has no stored `xmlns` slot:
an adopted app's `xmlns` is a ledger row of its one deployment (part 10, sections 2 to 4;
`../6-bring-in.md`, "What changed from the outline, and why", item 17). Nova's exports already hold
an `xmlns` this way.

`case-search/title-label-or-blank-hq-s-default`'s cell ("step 7's migration writes \"Search\"") and
`menus-and-case-lists/blanks-first-last`'s row are re-written by A8, which holds their concepts (part
03, `03-questions-and-text.md`).

### 3.4 The ten "outside" rows (A2: wording; B5: the search text; B6: the reader)

The pairs are cut by two type names that no longer exist. The stored union is one `Expression`
(`lib/domain/expression/types.ts`), judged per slot by `checkExpression` under the slot's profile, whose
rule set is `record` or `form` (`lib/domain/expression/profiles.ts::SlotProfile`). All ten slots take
the `record` rule set (`lib/domain/expression/context.ts::slotContext`: a choice list's filter and
every case operation slot are `record` slots that also read the form's answers, as part 08 found,
`08-the-reader-expressions.md`). From A2 each pair reads:

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
becomes a reader's fact in B6: B5 registers the text of the four search pairs; part 08's binder
claims them (B6). For every pair the reader parses HQ's text, binds it, runs the same checker, and
claims the HELD entry where it passes and the HELD-NEW entry, with the checker's reason in the
finding's `detail`, where it does not (part 08, section 9.2). No row flips there; a row would flip
only if a later step widens a rule set.

### 3.5 Reading re-cuts this part words and another pull request lands

| Entry | Today | New wording | Lands in |
|---|---|---|---|
| `case-search/several-xpath-query-rows` | HELD-NEW: "each row a typed default filter kept as its own row" | HELD, `valueClass` kept: "several `_xpath_query` rows, read as one condition: their conjunction. HQ joins every row with `and`, so one row or several find the same cases, and Nova writes one row per top-level conjunct of what it holds". No `subject`, no `owner`. A row whose own text is an `and` reads as two conjuncts and is written back as two rows, which finds the same cases; the first-publish register declares the changed row count under the id `search-filter-rows-recut` (part 09, `09-acceptance-and-the-first-publish.md`, section 11.2, B7). B5 lands this wording with the narrowing part 07 adds to it (`07-the-reader-cases-menus-lists.md`, section 14, "B5, re-cut": which conjuncts the HELD class takes). | B5 |
| `forms-and-case-writes/update-through-the-date-and-time-join-of-a-date-and-a-time` | HELD-NEW | HELD: "a date question and a time question joined into one date and time for a case property, the shape step 4's split writes (`lib/doc/datetimeSplit.ts`); the reader recognizes the join by re-emitting it" | B4 |
| the media rows of "a reference identical in every language" (`menus-and-case-lists/media-image-media-audio-differing-by-language`, `forms-and-case-writes/media-image-media-audio-differing-by-language`, `questions/label-or-option-media-differing-by-language`) | HELD-NEW, each beside a HELD row for the shared slot | The HELD-NEW rows keep their disposition and gain to their `item`: "a path present in one language and absent in another counts as differing". Their HELD siblings gain: "the same path in every language the app has reads as the one shared slot". | B3 (questions and forms), B4 (menus) |
| `expressions-and-data/media-path-jr-file` | HELD-NEW: a held media path | HELD: "the path CommCare HQ holds the file at, kept for the project space the app came from (`app_deployment_media_paths`); every other project space takes Nova's own path" | B9 |
| `expressions-and-data/a-media-reference-on-a-slot-nova-holds-with-no-multimedia-map` | HELD-NEW, `valueClass: "referenced-path-without-entry"` | Split, as part 11 writes it (`11-project-data.md`, section 13.1). The entry becomes INERT with `valueClass: "path-without-entry-nothing-draws"`: a reference with no `multimedia_map` entry on a slot no runtime the app runs on draws without its file, which the reader leaves out and the review lists. A new entry beside it, `expressions-and-data/a-media-reference-with-no-file-on-a-slot-a-runtime-draws`, REFUSED (`broken-at-runtime`), `valueClass: "path-without-entry-a-runtime-draws"`, `subject: "media-files"`, takes the slots a runtime draws; its standing is `fix-in-hq`. | B9 |
| `application-and-settings/translations-lang-code-any-other-value-or-absent-where-hq-s` | HELD-NEW | TARGET-OWNED, section 7.2 | B8 |

The concept flips of stack A, each in the pull request that builds the concept, with the entry edits
that part writes: `menus-and-case-lists/put-in-root-display-only-forms` (A4);
`menus-and-case-lists/case-list-form-pointing-at-a-registration-form-in-another-module` and
`case-list-form-media-image-media-audio` (A5); `questions/phone-number-xsd-string-appearance-numeric`
(A6); `questions/output-value-any-other-expression` (A7);
`case-search/title-label-or-blank-hq-s-default`, `menus-and-case-lists/blanks-first-last` and
`questions/vellum-ignore-containing-markdown-on-h-html-vellum-s-disable` (A8). Every `widen` on a HELD
row other than the sixteen of 3.6 and the `xmlns` row of 3.3 is part 04's (`04-names.md`), decided row
by row (A9; its row 30 lands with A5).

### 3.6 The kept flips (A3)

Each entry below becomes TARGET-OWNED, loses `slotChanges`, `subject` and `owner` where it holds them,
keeps its surface keys, value class and platform cells, and takes the `dispositionCell` and emission
shown. `KEPT_AT_HQ` (section 5) gains its row in the same pull request.

| Entry | Today | `dispositionCell` from A3 | Leaves `AMBIENT_PLATFORM_ENTRIES` and `PLATFORM_CELLS` |
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
a second copy of `wash` (part 14, `14-proof.md`, section 6.2): all four `app.json` files hold
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
On a deployment Nova brought in, a seed would be a change, so none is written (7.3, B8).

**One kept entry is re-worded in A3 without a flip.**
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

### 3.7 `build_profiles` (A2)

| | |
|---|---|
| Entry | `application-and-settings/build-profiles-each-profile-s-name-langs-practice-mobile-worker` |
| Today | TARGET-OWNED, no value class |
| From A2 | The entry gains `valueClass: "empty"` and its `item` becomes "`build_profiles` `{}`". A new entry `application-and-settings/build-profiles-non-empty`, HELD-NEW, `valueClass: "non-empty"`, same surface keys and gate (`privilege/build_profiles`), `subject: "build-profiles"`, `owner: "settings-nova-comes-to-own"`, `item`: "`build_profiles` holding a profile (its `name`, `langs`, `practice_mobile_worker_id`)", `dispositionCell`: "**HELD-NEW**: build profiles Nova keeps in step with the app's languages. HQ builds each profile with its own `langs` (`app_strings.py::_create_custom_app_strings`, `ApplicationBase.get_build_langs`) and an update never writes the key, so a language Nova adds reaches no profile and one it removes stays in each", platforms `not-applicable`, emission `omit`. |
| Inventory | `application-and-settings.md`, the `build_profiles` row split in two. |
| Evidence | `ApplicationBase._update_excluded_fields` lists `build_profiles`. HQ's own Languages page removes a deleted language from every profile (`views/apps.py::edit_app_langs`, the loop over `app.build_profiles`); Nova's update writes `langs` alone. `views/releases.py` makes a build per profile under the `build_profiles` privilege. Lifecycle: alive, behind a plan privilege. |

**The defect this row names has an owner before A2 opens.** A language a Nova author removes stays
in each of CommCare HQ's build profiles, on an app whose HQ copy has any ("Executed during
planning"). Step 6 does not fix it: A2 only gives the shape its entry. Before A2 opens, its
implementer files the GitHub issue "A language removed in Nova stays in CommCare HQ's build
profiles", assigned to themselves, with the Evidence cell above as its body, and names its number
in A2's description. Step 7's group `settings-nova-comes-to-own`, the entry's owner, is where Nova
comes to keep build profiles in step with an app's languages, and that group's plan closes the
issue. It is the third of the three issues part 15 has filed before their pull requests open (its
section 3, rule 12, and section 10.3), with A3's of 6.4 and A7's of part 03.

### 3.8 Entries that leave HELD-NEW in step 6

Each holds `subject` and `owner` from A2 and loses both in the pull request named.

| Entry | Pull request |
|---|---|
| `application-and-settings/24-properties-cc-log-entity-detail-enabled`, `51-hq-persistent-menu`, `52-hq-show-breadcrumbs`, `translations-key-in-a-runtime-s-ui-string-catalog-core-android`, `translations-catalog-key-hq-fills-with-its-own-text-in-a`, `logo-refs-hq-logo-android-home-login-demo` | A3 |
| `menus-and-case-lists/put-in-root-display-only-forms` | A4 |
| `menus-and-case-lists/case-list-form-pointing-at-a-registration-form-in-another-module`, `case-list-form-media-image-media-audio` | A5 |
| `questions/phone-number-xsd-string-appearance-numeric` | A6 |
| `questions/output-value-any-other-expression` | A7 |
| `case-search/title-label-or-blank-hq-s-default`, `menus-and-case-lists/blanks-first-last`, `questions/vellum-ignore-containing-markdown-on-h-html-vellum-s-disable` | A8 |
| `forms-and-case-writes/update-through-the-date-and-time-join-of-a-date-and-a-time`, `forms-and-case-writes/loadupdateaction-preload-question-property` (HELD-NEW to HELD) | B4 |
| `case-search/several-xpath-query-rows` | B5 |
| `application-and-settings/translations-lang-code-any-other-value-or-absent-where-hq-s` | B8 |
| `expressions-and-data/media-path-jr-file`, `a-media-reference-on-a-slot-nova-holds-with-no-multimedia-map` | B9 |

Three entries join HELD-NEW in stack B and gain both fields there:
`questions/question-id-case-registration-script` (B3, part 06),
`forms-and-case-writes/case-preload-into-a-question-outside-any-repeat-where-the-held` (B4, part
07) and `menus-and-case-lists/6-late-flag-late-flag-1` (B5, part 07). The closing block of Appendix
A.1 gives each its subject and owner, with every entry a later pull request adds as HELD-NEW.

---

## 4. The kept test, key by key (A3)

The kept test is this plan's rule for content outside `modules` that Nova's publish never writes
(`../6-bring-in.md`, "What changed from the outline, and why", item 15, summarizes it; this section
holds it). A top-level item is kept only when (1) Nova's publish never changes
it on that deployment, (2) nothing the document holds does something different under its value, and (3)
every Nova surface that claims to show or run what it changes reads the target's value or states the
difference. Clause 2 names what a question asks or stores, who owns a case Nova's forms create and
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
property, with what Nova's publish does to it and its standing from A3:

| Property | HQ's update | Nova's body | Standing | Entry |
|---|---|---|---|---|
| `_id` | excluded | absent | kept (identity) | `id` |
| `_rev`, `domain`, `copy_of`, `version` | excluded | absent | kept (server record) | `rev-domain-copy-of-version` |
| `short_odk_url`, `short_odk_media_url` | excluded | absent | kept (server record) | `short-odk-url-short-odk-media-url` |
| `built_with`, `build_signed`, `built_on`, `build_comment`, `comment_from`, `last_released`, `build_broken`, `build_broken_reason`, `is_auto_generated`, `is_released` | written if sent | absent | kept (server record) | `built-with-build-signed-built-on-build-comment-comment-from-last` |
| `date_created` | excluded | absent | kept (server record) | `date-created-created-from-template-last-modified-has-submissions` |
| `created_from_template` | set to `import_app_api` by the import view on every import | absent | kept (server record); the first publish over an adopted app changes it, which the first-publish register declares under the id `marked-as-updated-from-a-file` (part 09, section 11.2, B7) | `date-created-created-from-template-last-modified-has-submissions` |
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
| `logo_refs` | written if sent | sent only to remove a path-only entry | Web Apps slot held; Android slots kept; another path refused | `logo-refs-hq-logo-web-apps`, `logo-refs-hq-logo-android-home-login-demo`, `logo-refs-slot-path-other-than-the-uploader-s-jr-file-commcare` |
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

| Setting | Standing from A3 | Why |
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
changes (`domain/forms.py::PrivacySecurityForm.save`), and its app settings save takes the key
(`views/apps.py::edit_app_attr`). The import that makes Nova's app copies nothing, so that app starts
at `False`. Nova never sends the key. Clause 2: a URL, nothing a form asks or stores. Clause 3: the
`.ccz` writes `PostURL` (6.3). Lifecycle: alive. Kept.

**`custom_base_url`.** Reader: `ApplicationBase.url_base`, through `absolute_url_property`, moves the
profile's `ota-restore-url`, `PostURL`, `key_server` and heartbeat URL, and the media suite's remote
location (`suite_xml/generator.py`). `absolute_url_property` is `urljoin(self.url_base, <path>)` over
a path that starts at the root, so only the base's scheme, host and port reach a URL; a path on the
base is dropped. The suite's own request URLs do not follow it: the claim, search and case fixture
URLs are `absolute_reverse` (`remote_requests.py`, `entries.py`). Excluded from an update. Lifecycle:
flag-gated (`CUSTOM_APP_BASE_URL`). Kept; the `.ccz` mirrors the three profile URLs on the base's
origin.

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
(`hqmedia/models.py::ApplicationMediaMixin.remove_unused_mappings` permits `logo_paths`). Nova writes
`logo_refs` only to drop an entry whose only key is `path`, which HQ's own uploader never stores; such
an entry on an app Nova did not make is the existing REFUSED row's neighbor and is declared by the
first-publish register (`logo-path-only-entry-removed`; part 09, section 11.2, B7). Clause 2: device
chrome. Kept; the `.ccz` holds no bytes for them and says so.

**`auto_gps_capture`.** `FormBase.get_auto_gps_capture` is true where the form or the app says so, and
`xform.py::XForm._add_meta_2` then adds `meta/location` and its sensor to every form HQ builds. Nova
writes the key `true` for a Connect app (`applicationShell`), so clause 1 fails there: on a Connect app
it is held and derived, and where HQ held `false` the first publish changes it (the register's
`connect-app-captures-location`; part 09, section 11.2, B7). On any other app the key is never sent and is
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
beside them, a second copy of `wash` (`static/app_manager/template_apps/*/app.json`, four files), so
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
| a language's code, any other value, or absent where HQ's default differs | the key and value | not-yet until B8, kept from B8 | 7.2 |
| a key a runtime reads as its own UI text (the surface's `ui-string:` family) | `translationKeyOwner` gives `target` and `appStringKeys.ts::isRuntimeUiStringKey` holds (6.1) | kept | 3.6 |
| HQ's catalog fill for such a key | follows from the row above | kept | 3.6 |
| a key matching one of HQ's generated patterns (the surface's `app-string-id:` family, less `android.package.name.*`) | `translationKeyOwner` gives `generated` | inert, held or not-yet by value | 7.1 |
| any other key | `target`, and `isRuntimeUiStringKey` does not hold | inert | `translations-key-no-runtime-reads` |

---

## 5. `KEPT_AT_HQ` (A3)

New file `lib/commcare/surface/keptAtHq.ts`, pure, holding entry ids as strings and nothing of the
manifest JSON. It imports two types from `lib/publish`, `KeptLabelId` (`keptValues.ts`, 9.4) and
`KeptExportAdvisoryId` (`exportAdvisories.ts`, 6.3): the words a person reads live there, with the
other copy, and a row names its label by id. Server code and tests read the table; the kept list
reaches the browser as label ids (`DeploymentView.kept`, 6.5), which a component words through
`lib/publish/keptValues.ts::KEPT_LABELS`, since no component may import `lib/commcare`:

```ts
export type KeptKind = "setting" | "identity" | "server-record" | "project-state";

export type KeptCczCell =
	/** The archive writes what HQ's build writes from the value, read from `TargetFacts`. */
	| { readonly does: "mirrors"; readonly by: string }
	/** The archive cannot follow; the download says so through this advisory. */
	| { readonly does: "states"; readonly advisory: KeptExportAdvisoryId }
	/** Nothing an archive holds derives from the value. */
	| { readonly does: "no-reader"; readonly why: string }
	/** The archive carries Nova's own value by a stated contract. */
	| { readonly does: "own"; readonly why: string };

export type KeptPreviewCell =
	| { readonly does: "reads"; readonly by: string }
	| { readonly does: "states"; readonly docs: typeof PREVIEW_DOCS_SECTION }
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
	/**
	 * The HQ-authored base that holds it at a value other than the default;
	 * null exactly for an entry `proof/matrix/exemptions.json` names.
	 */
	readonly base: string | null;
}

export const KEPT_AT_HQ: Readonly<Record<string, KeptRow>>;
```

`PREVIEW_DOCS_SECTION` is the literal
`"content/docs/building-with-nova.mdx#preview-on-web-apps-and-android"`, declared in `keptAtHq.ts` and
held equal to `lib/preview/__tests__/platformCells.ts::PREVIEW_DOCS_SECTION` by the binding test.
Bases are part 14's (`14-proof.md`, section 6.2; they land in B13). This part names three of them:
`hq-new-app` (a just-created app), `hq-kept-settings` (an app authored through HQ's pages and models
that declares both platforms and holds every labelled `setting` row but the custom base URL at a
value other than its default), and `starter-health` (HQ's health starter app). One row has no base:
`36-hq-custom-base-url` takes `null`, because the value exists only under a flag no lane configuration
grants, and part 14's `proof/matrix/exemptions.json` names its entry (its section 7.5).

The table. "n-i-a" abbreviates `no-reader`. The Label column shows the words; the row holds the
label's id, which 9.4 lists beside each. A cell's text after its colon is its `why`, `value` or `by`
as the file holds it. A cell written with no such text takes these: `mirrors` alone is
`by: "lib/commcare/keptProfile.ts::targetProfileProperties"`, as the first row; a `mirrors` with a
symbol in parentheses takes that symbol's `path::symbol` (`compiler.ts::compileCcz`,
`compiler.ts::generateProfile`, `xform/metaBlock.ts::addMetaBlock`,
`runtimeTarget.ts::profileServerProperties`, each under `lib/commcare/`); "the same" repeats the `why`
of the row above; `n-i-a` alone is `why: "Nothing an archive holds derives from this value."`;
`no-claim` alone is `why: "Preview claims nothing this value changes."`; and `default` alone is
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
| `30-properties-cc-label-required-questions-with-asterisk` | setting | Asterisk on required questions | mirrors | states (the docs section) | seeds `no` | `hq-kept-settings` |
| `24-properties-cc-log-entity-detail-enabled` | setting | Logging of case detail views | mirrors | no-claim: Preview sends no device log | default: not written | `hq-kept-settings` |
| `translations-key-in-a-runtime-s-ui-string-catalog-core-android` | setting | CommCare's own screens, reworded | mirrors (`compileCcz`, the table merge) | no-claim: Preview's chrome is Nova's own | default: CommCare's wording | `hq-kept-settings` |
| `translations-catalog-key-hq-fills-with-its-own-text-in-a` | setting | (none: shown with the row above) | states (`kept_ui_text_falls_back`) | no-claim: the same | default: CommCare's wording | `hq-kept-settings` |
| `logo-refs-hq-logo-android-home-login-demo` | setting | Android logos | states (`kept_android_logos_absent`) | no-claim: Preview draws no Android home or sign-in screen logo | default: none | `hq-kept-settings` |
| `49p-hq-mobile-ucr-restore-version-1-0-1-5` | setting | Mobile report version | n-i-a: an archive holds no report | no-claim: Preview runs no report | default: `2.0` | `starter-health` |
| `45p-hq-auto-gps-capture-on-an-app-that-is-not-a-connect-app` | setting | Location captured with every form | mirrors (`addMetaBlock`) | no-claim: Preview submits no `meta/location` | default: off | `hq-kept-settings` |
| `51-hq-persistent-menu` | setting | Persistent menu in Web Apps | n-i-a: only Web Apps reads it, from HQ's build | no-claim: Preview draws no persistent menu | default: off | `hq-kept-settings` |
| `52-hq-show-breadcrumbs` | setting | Breadcrumbs in Web Apps | n-i-a: the same | no-claim: the trail above Preview is the builder's | default: on | `hq-kept-settings` |
| `43-hq-secure-submissions` | setting | Secure submissions | mirrors (`profileServerProperties`) | no-claim: Preview posts to no receiver | default: off (the import that makes Nova's app copies no project space setting) | `starter-health` |
| `36-hq-custom-base-url` | setting | Custom base URL | mirrors (`profileServerProperties`) | no-claim: the same | default: none | `null`: the value exists only under the flag `CUSTOM_APP_BASE_URL`, which no lane configuration grants, so `proof/matrix/exemptions.json` names the entry |
| `35-hq-practice-mobile-worker-id` | setting | Practice mobile worker | states (`kept_practice_worker_absent`) | no-claim: Preview has no practice mode | default: none | `hq-kept-settings` |
| `34-hq-build-spec-at-or-above-nova-s-floor-2-57` | setting | (none: a version at or above the floor is no difference a person set against Nova) | own: the profile requires Nova's floor, 2.57 | no-claim: Preview runs Nova's own engine | default: the server's default build | `hq-new-app` |
| `build-profiles-each-profile-s-name-langs-practice-mobile-worker` | setting | (none: empty) | n-i-a: an archive is one build | no-claim | default: none | `hq-new-app` |
| `32-features-credentials` | setting | Worker activity credential | mirrors (`generateProfile`, the `<credentials>` block) | no-claim: Preview shows no work history | its-own | `hq-kept-settings` |
| `target-derived-profile-properties-posturl-posttesturl-ota` | setting | (none) | own: the four server properties and `cur_locale`, for the archive's project space | no-claim | its-own | `hq-new-app` |
| `amplifies-workers-amplifies-project-minimum-use-threshold` | server-record | | n-i-a | no-claim | default | `hq-new-app` |
| `rev-domain-copy-of-version` | server-record | | own: the archive's version is the app's sequence | no-claim | its-own | `hq-new-app` |
| `short-odk-url-short-odk-media-url`, `built-with-build-signed-built-on-build-comment-comment-from-last`, `date-created-created-from-template-last-modified-has-submissions`, `copy-history-family-id`, `external-blobs`, `archived-media` | server-record | | n-i-a | no-claim | its-own | `hq-new-app` |
| `id` | identity | | own: `profileUniqueId`, Nova's id for the app on the project space | no-claim | its-own | `hq-new-app` |
| `multimedia-map` | identity | | own: the archive bundles each file at the path its references name | reads: Preview plays the Project's own copy | its-own | `starter-health` |
| `menus-and-case-lists/modulebase-unique-id`, `forms-and-case-writes/unique-id` | identity | | own: the deployment's recorded ids (`targetWireIdentity`) | no-claim: Preview keys by Nova's UUIDs | its-own | `hq-new-app` |
| `forms-and-case-writes/version` | server-record | | own: each form takes the app's sequence | no-claim | its-own | `hq-new-app` |
| `expressions-and-data/hq-table-and-row-ids-uuid4-a-workbook-upload-re-mints-a-table` | identity | | own: the archive embeds the Project's table | reads: Preview reads the Project's table | its-own | `hq-new-app` |
| `expressions-and-data/is-synced-last-modified` | server-record | | own: the archive embeds the Project's table | reads: Preview reads the Project's table | its-own | `hq-new-app` |
| `case-search/domain-casesearchconfig-sync-cases-on-form-entry`, `forms-and-case-writes/supply-point-id-datum-hq-injects-under-commtrack-enabled-into`, `forms-and-case-writes/data-dictionary-caseproperty-data-type`, `forms-and-case-writes/usercase-creation-and-sync-hq-user-id` | project-state | | n-i-a: the app's source holds none of it; publish asks a person where it matters | no-claim | its-own | `hq-new-app` |

The table has 49 rows: one for each of the 26 entries that are TARGET-OWNED today and the 23 of 3.6.
Rows written here on one line for several ids are one row each in the file. B8 adds the fiftieth,
`translations-lang-code-any-other-value-or-absent-where-hq-s` (7.2).

`label` names what the kept list shows; a row without one is never listed (a person has no use for
"the app's revision stays in CommCare HQ"). The kept list of one deployment is the labelled `setting`
rows whose value in its `TargetFacts` differs from what a first publish elsewhere would give
(`lib/deployment/targetFacts.ts::keptListFor`, 6.1). An app whose project space holds every default
has an empty list, and its card says so and still offers the refresh (6.5).

---
## 6. `TargetFacts` (A3)

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
	/** The origin (scheme, host, port) of the project space's custom base URL, or null. */
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
}

/** The facts one normalized source read holds. A source that is no object gives null. */
export function targetFactsFromSource(
	source: unknown,
	input: {
		readonly observedAt: string;
		/** True where Nova's own body set `auto_gps_capture` (the baseline's ownership). */
		readonly novaOwnsAutoGpsCapture: boolean;
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
`lib/commcare/surface/keptAtHq.ts` and, for types, `lib/publish/keptValues.ts` and
`exportAdvisories.ts`; no store and no `server-only`, so tests and the proof capture call it):

```ts
export function targetFactsFromBaseline(
	baseline: Extract<AppBaseline, { source: unknown }>,
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
nothing would read one.

`targetFactsFromBaseline` returns `null` for a baseline whose origin is `create`, and otherwise
`targetFactsFromSource(baseline.source, { observedAt: baseline.observedAt, novaOwnsAutoGpsCapture:
baseline.ownership.autoGpsCapture })`. A `create` baseline describes a shell, and a shell is never a
project space a `.ccz`, Preview or a card reads facts for: its mapping carries no pushed revision
(`store.ts::recordCreatedRemoteApp`), and `readReachedDeploymentTargets` never lists a mapping to the
empty shell, whatever the record displays. The fill that follows writes a `push` baseline, which is
what gives the first facts. For `push` and `cutover` (and `read`, from B8)
`targetFactsFromSource` reads, from the source as an object:

| Field | Read from | Rule |
|---|---|---|
| `profileProperties[key]` | `profile.properties[key]` for each of `KEPT_PROFILE_PROPERTY_KEYS` | `hqProfileValueText(value)`; the key is left out where that is `null` |
| `uiText[lang][key]` | `translations[lang][key]` | kept where `translationKeyOwner(key, langs)` is `"target"` and the value is a non-empty string, with `langs` the source's own |
| `uiTextKeys` | the same walk | every `target` key of every language for which `isRuntimeUiStringKey` holds, whatever its value |
| `secureSubmissions` | `secure_submissions` | `=== true` |
| `customBaseUrl` | `custom_base_url` | `new URL(value).origin` where the string parses as an absolute `http:` or `https:` URL, else `null` |
| `autoGpsCapture` | `auto_gps_capture` | `=== true`, and `false` where `novaOwnsAutoGpsCapture` is true (Nova's own value on a Connect app is no kept fact) |
| `credentialLevel` | `profile.features.credentials` | `hqProfileValueText(value)` |
| `androidLogos` | `logo_refs` | each of `home`, `login`, `demo` whose `hq_logo_android_<slot>` entry holds a string `path` |
| `practiceWorker` | `practice_mobile_worker_id` | a non-empty string |
| `persistentMenu` | `persistent_menu` | `=== true` |
| `breadcrumbs` | `show_breadcrumbs` | `!== false` |
| `mobileReportVersion` | `mobile_ucr_restore_version` | the string, or `"2.0"` |

`hqProfileValueText` restates `Application.create_profile`'s `if setting_value:` and the template's
print of the value: `null`, `undefined`, `""`, `false` and `0` give `null`; `true` gives `"True"`; a
number gives its decimal text; a string gives itself; anything else gives `null`. The numeric `10` HQ's
own Settings save stores for `cc-gps-auto-capture-accuracy` therefore reads `"10"`.

A generated key never enters `uiText`: `translationKeyOwner` gives it `generated`, and a publish drops
it, so it is no fact of the target (7.1). A language's own code is `language-name` and stays out until
B8 (7.2).

`uiText` and `uiTextKeys` differ on purpose. `uiText` holds every `target` key with text, a key no
runtime reads included, because the archive mirrors HQ's build and HQ's build writes every stored
value (4.4). `uiTextKeys` holds only the keys a runtime reads, because it decides what a person is
told: the kept list's "CommCare's own screens, reworded" and the advisory `kept_ui_text_falls_back`
(6.3). A key no runtime reads rewords no screen, and HQ's catalog fill never covers one
(`SelectKnownAppStrings.app_strings_parts` fills a key only where its own catalog holds it).

A `custom_base_url` that is no absolute `http:` or `https:` URL gives `null`, and the archive writes
the server's own base URL: `urljoin` over a base with no scheme and host gives a path alone
(`absolute_url_property`), so HQ's build holds no address there for the archive to mirror.

`keptListFor` returns, in `KEPT_AT_HQ`'s order, the `label` of each labelled `setting` row for which:
a seeded setting's `profileProperties` value is present and differs from Nova's seed;
`cc-log-entity-detail-enabled` is present; `uiTextKeys` is non-empty; `androidLogos` is non-empty;
`mobileReportVersion` is not `"2.0"`; `autoGpsCapture`, `persistentMenu`, `secureSubmissions` or
`practiceWorker` is true; `breadcrumbs` is false; `customBaseUrl` is not `null`; `credentialLevel` is
not `null`. The CommCare version row has no label: a version at or above the floor is no difference
from what Nova would write.

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
value of the projection is one a viewer's own `.ccz` already carries from A3. The two readers share the
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
`deployment_id`, `origin`, `source_digest`, `ownership` and `observed_at`, with no bytes; `unread`,
`create` or no row answers `null`. A module-level map of at most 64 entries, keyed by
`deployment_id` and `source_digest`, then answers a source it has projected before; only a miss selects
`source_gzip`. The digest names the bytes, so an entry is never stale, and the cap bounds an instance's
memory.

### 6.3 The `.ccz`

Today's path, and each change:

| Where | Today | From A3 |
|---|---|---|
| `lib/deployment/runtimeTarget.ts::ReachedDeploymentTarget` | `emptyCaseListText`, `earlierHqApps` | unchanged; the facts are not a column and do not ride the reached list |
| `lib/deployment/downloadTarget.ts::resolveDownloadTarget`, the `ccz` arm | reads `readDeploymentIdentityOverrides` for the chosen target | also awaits `readTargetFacts(scope, target)`; `DownloadTarget`'s `ccz` arm gains `readonly targetFacts: TargetFacts \| null`. A fault throws, as the identity read's does. |
| `lib/export/localArchive.ts::compileLocalArchive` | `deployment: { emptyCaseListText, earlierHqApps }` | `deployment` gains `readonly targetFacts: TargetFacts \| null`, required, passed to `compileCcz` |
| `lib/commcare/compiler.ts::CompileOptions` | no such option | `targetFacts?: TargetFacts \| null` (the type of `lib/commcare/targetFacts.ts`); absent or `null` reads Nova's constants, as today |
| `compiler.ts::generateProfile` | `appProfileProperties(input.doc)` | `targetProfileProperties(input.doc, facts)` |
| `compiler.ts::generateProfile`, `<features>` | `<checkoff active="true"/>` and `<users active="true"/>` | where `facts?.credentialLevel` is not `null`, a last child `<credentials active="true"><credential level="<the level>" type="APP_ACTIVITY"/></credentials>`, the block `templates/app_manager/profile.xml` writes, in its place after `<users>` (HQ's `<dependencies>` sits between the two, and Nova writes none) |
| `lib/commcare/runtimeTarget.ts::profileServerProperties(target)` | plain receiver, the server's base URL | `profileServerProperties(target, facts)` |
| `compiler.ts::compileCcz`, the `addMetaBlock` call | `captureLocation: authoredDoc.connectType !== null` | `captureLocation: authoredDoc.connectType !== null \|\| facts?.autoGpsCapture === true` |
| `compiler.ts::compileCcz`, the app string tables | Nova's own keys | each language's table then takes `facts.uiText[language]` |
| the three callers of `compileLocalArchive` (`app/api/compile/route.ts`, `lib/mcp/tools/compileApp.ts`, `proof/corpus/publish.ts`) | pass the reached target's two facts | pass `download.targetFacts` too, which reaches the two routes on `app/api/compile/prepareCompileRequest.ts::PreparedCompileRequest.download` (the resolved `ccz` arm, whose type now holds it); the proof capture passes the facts `targetFactsFromBaseline` gives over the baseline it captured, or `null` |
| the three callers of `exportAdvisories` (`app/api/compile/route.ts`, `app/api/compile/json/route.ts`, `lib/mcp/tools/compileApp.ts`) | `exportAdvisories(doc, attachmentTargetState)` | the `.ccz` arms pass `keptAdvisoryFacts(download.targetFacts, codes)` where the facts are not `null`, else `null`; `app/api/compile/json/route.ts` and `compileApp.ts`'s HQ import file arm pass `null` |

**`lib/commcare/keptProfile.ts`** (new, pure) exports
`targetProfileProperties(doc, facts): readonly AppProfileProperty[]`: for each of
`appProfileProperties(doc)` in its order, the two owned settings as they are, and each seeded setting at
`facts.profileProperties[key]` where present, else its seed, with the table's own `force`; then, where
`facts.profileProperties["cc-log-entity-detail-enabled"]` is present, that property with `force: true`.
With `facts` `null` it returns `appProfileProperties(doc)`. This is `projectProfileForTarget`'s rule
read from the other side: after any Nova publish the target holds exactly these values, so the archive
and HQ's build of the same project space state one profile. B8 gives both sides the same second rule
for a deployment Nova brought in (7.3).

**`profileServerProperties(target, facts)`.** `base` is `facts.customBaseUrl` where it is set, else the
server's base URL, for `ota-restore-url`, `PostURL` and `key_server`, as `ApplicationBase.url_base`
moves all three. `customBaseUrl` is already an origin (6.1), which is what HQ's `urljoin` of the base
with a root path keeps of it: `https://example.org/hq/` and `https://example.org` both give
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
directory takes the default language's, as it takes that language's whole table. A language of
`uiText` the app does not have writes nothing, as HQ builds no table for it.

**What the archive states.** `lib/publish/exportAdvisories.ts` gains three advisory ids and one
parameter:

```ts
export type ExportAdvisoryId =
	| "attachment_links_without_target"
	| "kept_ui_text_falls_back"
	| "kept_android_logos_absent"
	| "kept_practice_worker_absent";

/** The advisories that say what a `.ccz` cannot follow of a kept value. */
export type KeptExportAdvisoryId = Extract<ExportAdvisoryId, `kept_${string}`>;

/** What a `.ccz` cannot follow of what its project space holds. Plain booleans: no wire vocabulary. */
export interface KeptAdvisoryFacts {
	readonly uiTextFallsBack: boolean;
	readonly androidLogos: boolean;
	readonly practiceWorker: boolean;
}

export function exportAdvisories(
	doc: BlueprintDoc,
	attachmentTarget: AttachmentTargetState,
	kept: KeptAdvisoryFacts | null,
): readonly ExportAdvisory[];
```

`keptAdvisoryFacts(facts, languageCodes)` gives `uiTextFallsBack` true where some key of `uiTextKeys`
has no entry in `uiText[code]` for some `code` of the app's languages; the other two from their fields.
`uiTextKeys` holds runtime UI text keys alone (6.1), so a stored key no runtime reads raises no
advisory. The HQ import file passes `null`: it is made for no project space. The attachment advisory
keeps its place first. Copy is in section 9.

`application-and-settings/target-derived-profile-properties-posturl-posttesturl-ota`'s emission cell
gains "the local `.ccz` writes `ota-restore-url`, `PostURL`, `key_server` and `cc_user_domain` for its
project space, on the custom base URL and the secure receiver where the project space holds them".

### 6.4 Preview

Preview reads one kept value, fuzzy search in a case list, and reads it on both platforms: Android's
list and Formplayer's both filter through Core's `EntitySortUtil.sortEntities` with the profile's
`cc-fuzzy-search-enabled` (`MainConfigurablePreferences.isFuzzySearchEnabled`,
`FormplayerPropertyManager.isFuzzySearchEnabled`).

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
with any text and fails a row whose every field is blank.

**What each runtime does around Core's rule.** The two differ in two places, and Preview plays one
platform at a time, so `lib/preview/platform.ts::PreviewPlatformRules` gains one rule:

```ts
/** How the list's filter box splits what a worker types, and what closeness does to the order. */
readonly listFilter: {
	readonly terms: "single-spaces" | "whitespace-runs";
	readonly fuzzyOrder: "list-order" | "closest-first";
};
```

| | Web Apps | Android |
|---|---|---|
| The split | `single-spaces`: `searchText.split(" ")` (`EntityScreenHelper.java::filterEntities`). Two spaces in a row give an empty term between them, and a tab is no separator. | `whitespace-runs`: `filterRaw.split("\\s+")` (`EntityListAdapter.java::filterByString`). Text that starts with whitespace gives an empty first term. |
| The order with fuzzy search on | `list-order`: after the filter, Formplayer sorts the matches by the list's own order (`EntityScreenHelper.java::sortEntities`, a stable sort) and then gathers groups in order of first appearance (`groupEntities`). Closeness decides only between rows the list's order ties. | `closest-first`: the adapter shows the matches as the filter returns them (`EntityStringFilterer.java::buildMatchList`), stably re-sorted by ascending score over the list's order. |

`filterTerms` gives what Java's `String.split` gives for each: trailing empty strings dropped, an
empty string between two separators kept, and for `whitespace-runs` an empty first term where the
text begins with a separator. Preview keeps one rule of its own on both platforms, today's: while the
box is empty or holds only whitespace, every row shows. That is Web Apps' own rule
(`filterEntities` skips an empty text) and a phone's before anything is typed; a phone that has had
text typed and cleared runs one empty term, which drops a row whose every field is blank, and Preview
does not follow that one case.

`components/preview/shared/listFilter.tsx::rowMatchesFilterText` becomes
`rowsMatchingFilterText(columns, rows, filterText, context, plan, options: { fuzzy: boolean; rules:
PreviewPlatformRules["listFilter"] })`, which returns the matching rows: in their given order with
`fuzzy` off or `fuzzyOrder` `list-order`, and stably re-sorted by ascending score with `fuzzy` on and
`closest-first`. Under `list-order` Preview does not reorder rows the list's order ties: its order
among such rows is the case store's tie-break by case id on every list, filtered or not
(`caseDataBindingHelpers.ts::buildCaseStoreSortKeys`, `stablePageTieBreaker`), where a runtime's is
the order its case database returns, so that tie order is no claim Preview makes with or without
fuzzy search. Its fields are today's (each shown column's text, each hidden
field's, each carrier's raw value); `sortText` is the value the field's `CaseListShortField.key` orders
by, or `null` where the field keeps no key: for `property`, the raw value; for `option-label`,
`interval-text`, `link-text` and `calculated`, the column's shown text; for `mapping-position`, the
position text the plan orders by; a carrier's raw value is its own sort text.
`components/preview/screens/CaseListScreen.tsx` calls it at its two filter sites with
`fuzzy: useDeploymentTargetFacts()?.fuzzyListSearch ?? false` and `rules: platformRules.listFilter`.
The accent fold applies at every value of the setting: it is Core's rule for the exact match too.

**Grouped tiles.** The second site filters inside each group (`filteredGroups`). Groups are drawn only
where Preview plays Web Apps (`tileGrouping: "grouped"`; Android draws tiles flat), which is
`list-order`: the members of a group keep their order and a group with no match leaves, with fuzzy
search on as with it off. On Android the list is flat, so `closest-first` reorders the one list.

One difference at that site predates this part and does not turn on fuzzy search: Formplayer orders
the groups that remain by each one's first matching member (`groupEntities` runs after the filter),
and Preview keeps the groups' unfiltered order, because its groups arrive paged from the case store
with no flat position to reorder by. The two differ only where a group's earlier members fail the
filter and a later group's first member passes. A3 changes nothing there. Before A3 opens, its
implementer files the GitHub issue "Preview keeps a filtered tile list's groups in their unfiltered
order, where Web Apps orders them by each group's first match", assigned to themselves, with this
paragraph as its body, and names its number in A3's description, so the difference has an owner.

**How the fact reaches Preview.** It travels the way `commcare_project` does, as the server's
resolution, never a client's claim.

- `lib/deployment/previewTarget.ts` gains
  `resolvePreviewFactsTarget(deployments: readonly Pick<DeploymentRecord, "state" | "resumePhase" |
  "server" | "domain">[]): DeploymentTargetKey | null`: the one `(server, domain)` among the
  deployments that display as uploaded, or `null` for none or several. It de-dupes on both, where the
  project-space name de-dupes on the domain alone, because the facts are one deployment's.
- `lib/deployment/previewSpace.ts` gains
  `previewTargetFactsFor(scope): Promise<PreviewTargetFacts | null>`, which resolves that target, calls
  `readTargetFacts`, and returns `{ fuzzyListSearch: facts.profileProperties["cc-fuzzy-search-enabled"]
  === "yes" }`. It degrades to `null` on a fault with one `log.warn`, as `previewProjectSpaceFor` does.
- `lib/collab/previewTargetFactsFrame.ts` (new) holds the wire contract of a second frame:

  ```ts
  export const previewTargetFactsSchema = z.strictObject({ fuzzyListSearch: z.boolean() });
  export type PreviewTargetFacts = z.infer<typeof previewTargetFactsSchema>;
  export const previewTargetFactsFrameSchema = z.strictObject({
  	facts: previewTargetFactsSchema.nullable(),
  });
  export type PreviewTargetFactsFrame = z.infer<typeof previewTargetFactsFrameSchema>;
  /** One SSE data payload; a malformed frame gives null and the held value stays. */
  export function parsePreviewTargetFactsFrame(data: string): PreviewTargetFactsFrame | null;
  ```

  A new frame name, not a new key on `preview-project-space`: that frame's schema is strict, so a tab
  still running the earlier build would drop a widened frame whole and lose `commcare_project` with
  it, where it simply does not listen for a name it does not know.
- `app/api/apps/[id]/stream/route.ts`'s deployment lane resolves both in one run and sends
  `preview-target-facts` when the canonical JSON of the facts differs from what it last announced,
  the connect-time emit included. No new route, so no hostname allowlist entry.
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
- `app/(app)/build/[id]/[[...path]]/page.tsx` starts `previewTargetFactsFor` beside
  `previewProjectSpaceFor` and seeds the provider through `BuilderProvider`.
- A publish and a Check status hand the own tab the answer without waiting for the stream:
  `lib/deployment/actions.ts::RefreshedDeploymentView` gains
  `readonly previewTargetFacts: PreviewTargetFacts | null`, and
  `app/api/commcare/upload/route.ts`'s response gains `preview_target_facts` (the same object, or
  `null`)
  (`components/builder/publishOutcome.ts` parses it, absent reading `null`);
  `PublishDialogBody.tsx` and `app-setup/PublishingSection.tsx` apply it where they apply the project
  space.

With no facts (no reached project space, several, or an unread baseline) Preview filters as a new
project space would: exactly, which is Nova's own value `no`.

### 6.5 The Publishing card: the list, its date, and the refresh

`lib/deployment/actions.ts::DeploymentView` (what `readDeploymentsAction` and the refresh actions
return for each record) gains
`readonly kept: { readonly labels: readonly KeptLabelId[]; readonly observedAt: string } | null`,
filled from `readTargetFacts` for each reached deployment and `null` elsewhere (no baseline, an unread
one, a shell). `components/builder/DeploymentStatus.tsx` draws the block under the record's rungs
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

**The refresh.** `lib/deployment/service.ts` gains:

```ts
export type KeptRefreshOutcome =
	| { readonly kind: "refreshed"; readonly deployment: DeploymentWithResources }
	/** Something Nova publishes differs from the baseline. Nothing is written. */
	| { readonly kind: "changed-in-hq" }
	/** A publish replaced the baseline while CommCare HQ was being read. Nothing is written. */
	| { readonly kind: "superseded"; readonly deployment: DeploymentWithResources }
	| { readonly kind: "no-baseline" }
	| { readonly kind: "app-gone" }
	/** CommCare HQ answered with something that is no app Nova can read. */
	| { readonly kind: "unreadable" }
	/** CommCare HQ turned the key or the account away for this read. */
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
   A failure of status 401 or 403 that is not an edge's answers `no-permission`. Any other failure
   answers `unavailable`. From B1 the last three are chosen by `classifyHqFailure(error,
   "app-source").kind`, by the rule part 05 gives its source read ladder
   (`05-reading-commcare-hq.md`, section 12):
   `key-not-accepted`, `plan-lacks-api-access`, `api-cut-off`, `not-a-member` and `permission` are
   `no-permission`, `answer-unreadable` is `unreadable`, and every other kind is `unavailable`.
5. Normalize it (`normalizeHqAppSource` over the read's `raw`); `{ malformed }` answers `unreadable`.
6. Compare it with the baseline by the publish's own comparison, `diffHqAppSource({ baseline, current,
   ownership, shell: false, schemaDefault })`. Any part answers `changed-in-hq`.
7. No part: write through the new store writer below. `written` answers `refreshed`, and `superseded`
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
	},
): Promise<{
	readonly outcome: "written" | "superseded";
	readonly deployment: DeploymentWithResources;
}>;
```

Inside `withDeploymentRow(scope, target, { ensure: false }, …)`, which locks the app row and takes the
deployment row `FOR UPDATE`, it selects the stored baseline's `remote_app_id`, `origin`,
`source_digest`, `ownership` and `observed_at`. Where the row is gone, its `remote_app_id` is not
`input.remoteAppId`, its origin is `unread` or `create`, its digest is not `comparedDigest`, its
`observed_at` is later than the read's `observedAt`, or the live `app` mapping no longer names that
remote id, it writes nothing and answers `superseded`. Otherwise it calls
`writeAppBaseline` with the stored origin and ownership, the read, and `discard: null` (which keeps a
stored discard record), calls `notifyAppDeployments(tx, scope.appId)` so every open tab's Preview
follows, and answers `written`. The stored origin is kept because it says how the app came to be
there, which a refresh does not change; `types.ts::AppBaselineWrite.origin` is `"create" | "push" |
"unread"` today, so A3 widens it with `"cutover"` for this one writer, and B8 with `"read"`. From B8
the writer takes `expectedEndings` as the other baseline writers do (part 10,
`10-identity-and-the-ledger.md`, section 8.5).

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

Why the whole baseline and not a splice of the kept keys: a baseline must stay one read of HQ, with one
date. Replacing it only where nothing Nova writes has moved changes no later drift verdict (the
comparison that would run at the next publish has just run and found nothing). Where something Nova
writes has changed in HQ, the kept list keeps its date and the person is told why; the drift stop of
the next publish names the changes.

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
				| "changed-in-hq" | "no-baseline" | "app-gone"
				| "unreadable" | "no-permission" | "unavailable";
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

## 7. Three rules that land in stack B

### 7.1 A generated key (the manifest lines of B2)

HQ writes a string for each id its patterns name (`id_strings.py::REGEXES`; the surface's
`app-string-id:` family) from the app's own fields, and a non-empty value stored under that id in
`translations` replaces it at runtime (4.4). Nova never carries such a key
(`appStringKeys.ts::translationKeyOwner`, `generated`), so it can never be kept: a publish removes it,
and the worker would see the field's text again. B2 adds three entries on
`schema:Application.translations`, and re-words one:

| Entry | Disposition | Value class | `item` |
|---|---|---|---|
| `application-and-settings/translations-generated-key-with-no-effect` | INERT | `generated-key-no-effect` | a key matching a generated pattern, in a language, whose value is blank, or names no string of this app, or equals the text the app's own fields give that string in that language |
| `application-and-settings/translations-generated-key-over-one-text` | HELD | `generated-key-folded` | any other such key whose string comes from one authored text, where every string that text feeds in that language holds the same override: read as that text's wording in that language |
| `application-and-settings/translations-generated-key-anything-else` | HELD-NEW, `subject: "translation-overrides"`, `owner: "settings-nova-comes-to-own"` | `generated-key-other` | any other such key: an override of a string Nova writes from a constant or derives, or of one string of a text that feeds several |
| `application-and-settings/translations-key-no-runtime-reads` (existing, INERT) | unchanged | unchanged | gains "a key no generated pattern and no runtime catalog names" |

`SUBJECTS` gains `translation-overrides` and the copy table its `not-yet` sentence in B2, with the
entry that uses it.

The classifier part 06 implements (`06-the-reader-forms.md`, section 16.5, B2), stated so no part
decides it. Let `D0` be the document read
without any generated key, and `T0` its local app strings by language with each string's source
(`compileCcz` builds exactly this map: `appStrings` and `appStringUnits`, id to constant or to
translation unit). For each language `L`, key `K` matching a generated pattern, and value `V`:

1. `V` is blank: inert (`non_empty_only` drops it).
2. `K` is no id of `T0`: inert (HQ generates no such string for this app, so no suite names it).
3. `V` equals `T0[L][K]`: inert.
4. `K`'s source in `T0` is a translation unit `U`, and for every id `K'` that `U` feeds, the stored
   value of `K'` in `L` is `V` too (or `K'` is `K`): held. The reader sets `U`'s text in `L` to `V`,
   once.
5. Otherwise: not-yet, with `detail.name` the key.

Rules 2 to 4 read Nova's local app strings for `D0` as if they were HQ's. That holds only where the
two builds name the same strings: among ids that match a generated pattern, the set HQ's build writes
for the app equals the set the local archive writes for `D0`. Where HQ's build held such an id Nova
spells another way or does not write, rule 2 would call an override of it inert while HQ's build
applied it. So the equality is a stated precondition of the classifier, held by proof 2 on every
HQ-authored base (the generated ids of each `app_strings.txt` of HQ's build against the local
archive's, per language), which part 14 carries (`14-proof.md`, section 4; named under "What this
part needs of other parts"). An id on one side alone is a failure of that proof, fixed in the
emitter or by a new entry, never classified around.

Languages of `translations` the app does not have are skipped: HQ builds no strings for them. Rule 4's
"once" is what makes the fixed point hold: Nova's emission of the folded document gives `V` for every
id `U` feeds, a re-reading meets no generated key, and the document is unchanged. In HQ the menu's or
form's own name field then shows the override's wording, where before it showed the field's, and the
`translations` key is gone; no runtime shows a different word. That is one first-publish change
(`translation-overrides-folded`, no worker impact), an entry of part 09's register
(`09-acceptance-and-the-first-publish.md`, section 11.2, B7).

`homescreen.title` and `app.display.name` keep their own entries: they are generated patterns Nova does
write.

### 7.2 A language's display name (B8)

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

From B8, the pull request that first writes an `adopted` app mapping:

- `targetOverlay.ts::projectTranslationsForTarget(application, current, options)` gains
  `options: { readonly languageNames: "nova" | "target" }`. With `"target"` a key that is a language's
  code is carried as the target holds it and Nova's value for it is not written; an absent one stays
  absent. `projectApplicationForTarget` takes the same option, and
  `lib/deployment/importApplication.ts::hqImportApplication` passes
  `HqImportApplicationInput.languageNames`, which `publishAppToHq` sets to `"target"` exactly where
  the mapping it updates in place is `adopted`, and to `"nova"` otherwise (part 10,
  `10-identity-and-the-ledger.md`, section 6.3).
- `hqSourceBaseline.ts::ownedTranslations` takes the same option, so the drift comparison stops
  reading language names on an adopted deployment: they are the project space's there.
- `TargetFacts` gains `readonly languageNames: Readonly<Record<string, Readonly<Record<string,
  string>>>> | null`: `null` on a deployment Nova created, and on an adopted one, per language of the
  source, each language code that language's `translations` entry holds a non-empty name for.
  `targetFactsFromSource`'s input gains `readonly adopted: boolean`, which `targetFactsFromBaseline`
  takes as a second argument from the live app mapping's ownership, so its B8 signature is
  `targetFactsFromBaseline(baseline: Extract<AppBaseline, { source: unknown }>, adopted: boolean):
  TargetFacts | null` (`readTargetFacts` reads the ownership with the row, and the key of its
  projection cache gains it beside the digest). `targetFactsFromBaseline`
  projects a `read` baseline as it does a `push` one; there is no origin on the facts for B8 to widen.
- `compileCcz` writes `table[code] = facts.languageNames[language]?.[code] ??
  localization.languageName(code)` where `facts.languageNames` is not `null`. Where HQ holds no name,
  the archive writes Nova's label, in every table, and HQ's build writes its registry's name in the
  language's own tongue, in `default` alone. Nova cannot compute HQ's registry name, so the row states
  the difference rather than mirror it: the advisory says what a person would see, that the language
  picker may name a language differently (9.5), which is true of both differences.
- The entry `application-and-settings/translations-lang-code-any-other-value-or-absent-where-hq-s`
  becomes TARGET-OWNED: "**TARGET-OWNED**: on a project space Nova brought the app in from, a
  language's display name is CommCare HQ's: a name it holds is carried and an absent one stays absent
  (`projectTranslationsForTarget`, `languageNames: \"target\"`). Where Nova created the HQ app it writes
  its own label, which is the HELD row above". Its `KEPT_AT_HQ` row: kind `setting`, label "Language
  names", `.ccz` `mirrors` for a name HQ holds and `states` (`kept_language_names_differ`) for an
  absent one, Preview `no-claim` ("the language menu is Nova's own control"), another project space
  `seeds` Nova's label, base `hq-kept-settings`. The subject `language-display-names` and its sentence
  leave `SUBJECTS` and the copy table with the flip.
- A fourth kept advisory id, `kept_language_names_differ`, shown where `facts.languageNames` is not
  `null` and some app language's table lacks a held name for some app language's code (copy in
  section 9). `KeptAdvisoryFacts` gains `readonly languageNames: boolean` for it.

### 7.3 The fifteen settings on an app Nova brought in (B8)

`projectProfileForTarget` writes each of the fifteen seeded settings where the project space holds no
value (`holdsNoValue`: absent, `null` or `""`), and all but the map layer are written forced. For an
absent key HQ's build writes nothing (`Application.create_profile`; none of the fifteen carries a
`commcare_default`), so a phone reads its own default and keeps whatever the worker chose. After a
seed, the profile forces the value at every update. The value is the same one a device reads for an
absent key; what changes is that a worker's own choice of fuzzy search, automatic updates or text to
speech returns to it (`appProfileSettings.ts`, its header). On an app Nova created that has been
Nova's stated behavior from its first publish. On an app made in HQ it would be a change the first
publish makes to workers' phones, and the bar's clause (b) admits such a change only declared. This
plan reads the original's behavior exactly wherever it can and declares a change only where it
cannot: of the three answers part 09 gives each candidate change (read exactly, refuse, declare;
`09-acceptance-and-the-first-publish.md`, section 11.4), it takes the first wherever it is open, as
part 07 does (`07-the-reader-cases-menus-lists.md`, Departure 7), and here that costs nothing: Nova
leaves the key absent.

From B8, the pull request that first writes an `adopted` app mapping:

- `targetOverlay.ts::projectProfileForTarget(application, current, targetState, options)` gains
  `options: { readonly seeds: "nova" | "target" }`. With `"target"` a seeded key is written only where
  the target holds a value, which is to say never by Nova: the target's own value is carried and a
  key it holds no value for is left as it is, absent, `null` or `""`. The two owned settings are
  written either way. `projectApplicationForTarget` takes the option beside `languageNames` (7.2), and
  `hqImportApplication` passes `HqImportApplicationInput.seeds`, which `publishAppToHq` sets to
  `"target"` exactly where the mapping it updates in place is `adopted` (part 10, 6.3).
- The ownership descriptor does not change: it names the two owned settings alone
  (`OWNED_PROFILE_PROPERTY_KEYS`), so the drift comparison already reads none of the fifteen.
- `TargetFacts` gains `readonly seeds: "nova" | "target"`, from the same `adopted` input 7.2 adds.
  `keptProfile.ts::targetProfileProperties` writes a seeded setting the facts hold no value for at
  Nova's seed where `seeds` is `"nova"`, and leaves it out where it is `"target"`, so the archive and
  HQ's build of an adopted deployment state one profile. With `facts` `null` it returns
  `appProfileProperties(doc)` as before: no facts means no reached deployment was read.
- The fifteen entries' cells (3.6) gain: "On a project space Nova brought the app in from, a publish
  writes none of them: a setting it holds no value for stays absent (`projectProfileForTarget`,
  `seeds: \"target\"`)". Their `KEPT_AT_HQ` rows are unchanged: another project space is a deployment
  Nova creates, which is seeded.
- `keptListFor` is unchanged: an absent setting is no value that differs from a new app's.
- Run 3 ("Written and not yet run") holds this on HQ's real build. `keptProfile.test.ts`'s property
  (section 10) runs under both values of the option.

An adopted deployment stays `adopted` across publishes (part 10, section 7.1, B8), so the rule does
not lapse after the first one. A person who wants one of the fifteen set on such an app sets it on
the app's Settings page in CommCare HQ, where it is kept.

---

## 8. Findings

### 8.1 The type (A2)

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
			readonly how: "brought-in" | "published";
			readonly at: string;
			readonly contact: {
				readonly role: "person" | "owners";
				readonly names: readonly string[];
			};
	  };

/** What the finding is about, in the app's own words where it has some. */
export interface FindingDetail {
	/** The thing's own name: an appearance, a setting, a property, a key, a file. At most 200 characters. */
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
	readonly owner?: Step7Group; // present exactly when standing is "not-yet"
	readonly detail: FindingDetail;
};

export type CircumstanceFinding = {
	readonly code: ReadCircumstance;
	readonly standing: FindingStanding | "stop";
	readonly place: HqPlace;
	readonly subject: null;
	readonly owner?: Step7Group;
	readonly detail: FindingDetail;
};

export type Finding = ManifestFinding | CircumstanceFinding;
export const findingSchema: z.ZodType<Finding>;
```

`place.name` is the menu's or form's name in the app's first language, or the same fallback
`diffHqAppSource` uses where it has none. A menu's and a form's index is HQ's position, so two findings
of one form group together and sort in the app's own order. `findingSchema` is what the reading's row
stores (part 12, `12-the-reading-and-the-birth.md`, section 2.3, B10) and what `read_hq_app` returns
(part 13, `13-the-experience.md`, section 14.3, B12); `standing` and `cause` on a manifest finding
are checked against `standingOf` and `fixCauseOf` by the reader's index, not re-derived by a consumer.

`findingSchema` is `z.union([manifestFindingSchema, circumstanceFindingSchema])`, two
`z.strictObject`s private to the file. The manifest arm holds `code: z.string().min(1)`, `standing:
z.enum(["not-yet", "never", "fix-in-hq"])`, `cause: z.enum(FIX_CAUSES).optional()`, `place`,
`subject: z.enum(SUBJECTS)`, `owner: z.enum(STEP_7_GROUPS).optional()` and `detail`, and refines:
`owner` present exactly under `not-yet`, `cause` present exactly under `fix-in-hq`, no `detail.claim`.
The circumstance arm holds `code: z.enum(READ_CIRCUMSTANCES)`, `standing` the manifest arm's three or
`"stop"`, `subject: z.null()`, `owner` optional and `detail`, and refines: `standing` and `owner`
equal `CIRCUMSTANCE_STANDINGS[code]`'s, and `detail.claim` only on `already-in-nova`. `place` is a
`z.discriminatedUnion("kind", …)` over the ten arms above with non-negative integer indexes;
`detail` is a strict object of `name` (`z.string().max(200)`), `reason` and `claim`, each optional.
A manifest code is never a member of `READ_CIRCUMSTANCES` (an entry id holds a `/`), so the union
has one reading of every value.

`HqAppClaimDetail` is part 10's `HqAppClaimView` (`lib/deployment/store.ts::readHqAppClaims`;
`10-identity-and-the-ledger.md`, section 5.5, B8) without `remoteAppId`, declared here because a
finding is client-safe and the store is not; the store's type is this one with that key added. It
never holds the holding Project's name or,
for `elsewhere`, the Nova app's. A circumstance carries nothing else of what failed: three permission
needs are three codes (8.3), and a read that timed out shares `hq-unavailable`, whose body says so.

### 8.2 Where a finding's fields come from

| Field | Manifest finding | Circumstance |
|---|---|---|
| `code` | the entry the cursor's claim named | the member of `READ_CIRCUMSTANCES` |
| `standing` | `standingOf(entry)` | the table of 8.3 |
| `cause` | `fixCauseOf(entry)`, present where it is not `null` | absent: a circumstance has its own copy |
| `subject` | the entry's `subject` | `null`: a circumstance has its own copy |
| `owner` | the entry's `owner` | the table of 8.3, where it has one |
| `place` | the reader's position | the reader's position, or `{ kind: "app" }` |
| `detail` | set by the claim | set where the table of 8.3 says |

### 8.3 `READ_CIRCUMSTANCES` (20 codes in A2; 27 after B1, 28 after B2, 34 after B9, 35 after B10)

`hqFindings.ts` exports the closed list, the codes of the table below in its order, and
`CIRCUMSTANCE_STANDINGS`, this table's Standing and Owner columns as data. Each pull request of the
"Lands in" column adds its rows to both and its blocks to `CIRCUMSTANCE_COPY` (9.3).

```ts
export const READ_CIRCUMSTANCES = [ /* the Code column below, in its order */ ] as const;
export type ReadCircumstance = (typeof READ_CIRCUMSTANCES)[number];

/** One row per code: its standing, and its step 7 owner where the table gives one. */
export const CIRCUMSTANCE_STANDINGS = {
	"not-connected": { standing: "stop" },
	// ... one member per code ...
	"too-large": { standing: "not-yet", owner: "project-data-at-hq-size" },
} as const satisfies Record<
	ReadCircumstance,
	{ readonly standing: FindingStanding | "stop"; readonly owner?: Step7Group }
>;

/** The codes that end or hold a reading. A table keyed by this type is total over them. */
export type StopCircumstance = {
	[K in ReadCircumstance]: (typeof CIRCUMSTANCE_STANDINGS)[K]["standing"] extends "stop" ? K : never;
}[ReadCircumstance];
```

The record keeps each member's literal type (`as const satisfies`), which is what lets part 13 hold
its table of a stop's actions total over the `stop` codes at compile time (`13-the-experience.md`,
section 6.2, B11). A `stop` is no finding about the app and no standing of anything in it: it says the
read ended, or holds the creation until a person acts. It is shown where the person stands and is
never mixed into an account.

| Code | Standing | Owner | When | `detail` | Lands in |
|---|---|---|---|---|---|
| `not-connected` | stop | | the person has no CommCare HQ connection on that server | | A2 |
| `key-not-accepted` | stop | | HQ refuses the stored key | | A2 |
| `plan-lacks-api-access` | stop | | the project space's plan has no API access | | A2 |
| `not-a-member` | stop | | the account is no member of the project space | | A2 |
| `cannot-edit-apps` | stop | | the account lacks Edit Apps there, on a read that names it | | A2 |
| `cannot-access-apis` | stop | | the account lacks Access APIs there, on a read that names it alone | | A2 |
| `app-gone` | stop | | HQ holds no app by that id | | A2 |
| `app-deleted` | stop | | HQ holds it as deleted | | A2 |
| `linked-app` | stop | | the source's `doc_type` is `LinkedApplication` | | A2 |
| `rate-limited` | stop | | HQ answered that it is too busy, after the read's retries | | A2 |
| `hq-unavailable` | stop | | HQ did not answer in time, or answered with nothing Nova can read | | A2 |
| `changed-while-reading` | stop | | the app's version moved during the read, after the restart | | A2 |
| `already-in-nova` | stop | | another Nova app manages this HQ app | `claim`, where the holder is known | A2 |
| `too-large` | not-yet | `project-data-at-hq-size` | the app's source is over the read's byte bound, or reading and checking it takes more time or more memory than one of Nova's steps allows, or saving it takes longer than one allows | `name`: `checking` where the check ran out of time or memory, `saving` where the birth ran out of time; absent where a body was over its byte bound | A2; B10 for the check's time and memory causes and the birth's time cause, their `detail.name` and the block's new body |
| `menu-unreadable-in-hq` | fix-in-hq | | HQ's own summary of a menu is an error | none: the place names the menu | A2 |
| `shadow-disagrees` | fix-in-hq | | an attribute and its `vellum:` shadow differ in meaning | `name`: the attribute | A2 |
| `table-differs-in-project` | stop | | a table the app reads meets a table of that tag in the Project that asks the person's choice (part 11, 7.1), and creation was asked for with that choice unanswered | `name`: the tag | A2 |
| `media-file-unreadable` | fix-in-hq | | HQ's media map holds an entry for the path and HQ serves no file for it, on a slot a runtime reads | `name`: the path | A2 |
| `unrecognized` | not-yet | | the reader met something no manifest entry names | `name`: the surface key, or the key's path | A2 |
| `read-back-differs` | not-yet | | acceptance failed after a clean read: a failing check 2 to 5, or a reader defect beside a clean read (part 09, `09-acceptance-and-the-first-publish.md`, section 14, B7) | `name`: one of `accounting`, `gate`, `fixed-point`, `identity`, `summary`, `reader` | A2 |
| `hq-gateway-refused` | stop | | a gateway in front of HQ refused the request | | B1 |
| `api-cut-off` | stop | | HQ's 401 says API access is paused for the account or the project space | | B1 |
| `browser-only` | stop | | HQ answered a redirect or a page where data was asked | | B1 |
| `remote-app` | stop | | the app list holds the app and the application resource has none | | B1 |
| `cannot-read-organization` | stop | | a 403 on the level or the place read | | B1 |
| `app-unreadable-in-hq` | fix-in-hq | | HQ's summary is an error for every menu it would summarize, or for the app whole | | B1 |
| `table-rows-unreadable` | fix-in-hq | | the rows of one table answer an error where the table list answered | `name`: the tag | B1 |
| `no-platform-runs-everything` | fix-in-hq | | no declaration runs all of the app's content: some use runs only in Web Apps and some only on Android | `name`: the feature's label and the platform that cannot run it; `reason`: `split-refused` at a date and time question whose split is refused (8.4) | B2 |
| `places-over-nova-limit` | not-yet | `project-data-at-hq-size` | the project space has more active places than Nova holds for an app | `name`: the count, `"12,400 places"` | B9 |
| `place-not-holdable` | not-yet | `project-data-at-hq-size` | a level's code, a place's site code, name, coordinates, parent or a value the app reads is outside what Nova's organization holds | `name`: the level's or the place's name | B9 |
| `media-not-played-where-app-runs` | fix-in-hq | | a referenced file's format plays on no platform the rest of the app runs on | `name`: the path | B9 |
| `table-cell-unrepresentable` | fix-in-hq | | a lookup table the app reads holds, in a field its definition names, a character XML 1.0 cannot carry | `name`: `"<tag> (the field <field name>)"` | B9 |
| `owner-rule-needs-one-place` | not-yet | `project-data-at-hq-size` | an owner rule of the app gives a case to the place at a level below the case's current owner, and in the project space that is not exactly one place below every place that owns cases | `name`: the level's name | B9 |
| `table-choices-unusable` | fix-in-hq | | a question or a search field of the app takes its choices from a lookup table, and that table has no rows, or a row whose value is blank, has white space at an end or repeats another's, or whose label is blank | `name`: `"<tag> (the field <field name>)"` | B9 |
| `could-not-create` | not-yet | | the birth's own checks refused a reading that acceptance had passed | `name`: `gate`, `export`, `integrity`, `identity` or `bindings` | B10 |

**Twenty codes in A2.** Permissions are two of them, `cannot-edit-apps` and `cannot-access-apis`,
chosen by the read ("Which permission code a 403 becomes", below; B1 adds the third,
`cannot-read-organization`). `shadow-disagrees` words the reader's rule
for a real attribute and its `vellum:` shadow that disagree (part 06, `06-the-reader-forms.md`,
section 14.2, B3), which no manifest entry can name because it is a relation between two attributes.
`unrecognized` and `read-back-differs` are Nova's own shortfalls, so their standing is
`not-yet`, their copy takes the blame, and the reader logs each at error (`log.error`, which mirrors to
Sentry) with the reading's id. A media file over Nova's size limit and a table over Nova's caps are no
circumstances: they are content the manifest names
(`expressions-and-data/an-imported-asset-larger-than-nova-s-per-kind-cap-or-an-app`,
`table-or-row-count-beyond-nova-s-caps-5-000-rows-250-columns-64`), so their findings carry those entry
ids, the subject and the owner.

**Seven more in B1.** Part 05 (`05-reading-commcare-hq.md`, the HQ reads) classifies every failed
answer and found seven that none of the twenty words truthfully (its section 4.3). This part takes all
seven, with the standings it proposes and the blocks it wrote, which 9.3 holds as the binding copy. B1
adds each to `READ_CIRCUMSTANCES`, `CIRCUMSTANCE_STANDINGS` and `CIRCUMSTANCE_COPY`, and the
completeness test of section 10 holds each to its block from then on. Two of the seven rest on a run
of part 05 ("Written and not yet run"): under its run G2's outcome C `remote-app` does not land, and
under its run G7's outcome B `table-rows-unreadable` does not land, each with its row, its block and
its member of `READ_CIRCUMSTANCES`; every count of this section then falls by one for each.
`menu-unreadable-in-hq` carries no `detail.name`, as part 05 asks: HQ's message there is the text of
an exception, which goes to the log with the menu's position and to no person.

**Eight more in stack B.** The later parts each found facts no code above words and no manifest entry
can name. Each is taken as its part words it, and this table and 9.3 are their one home.
`no-platform-runs-everything` is part 06's (`06-the-reader-forms.md`, section 16.3, B2): the
app's content leaves no declaration that runs all of it. The six of B9 are part 11's
(`11-project-data.md`, section 13.2): facts about a project space's data, not the app's source.
`could-not-create` is part 12's (`12-the-reading-and-the-birth.md`, section 6.5, B10): the birth's
own last checks turned down a reading acceptance had passed, which `read-back-differs`' block would
word falsely. B10 also widens `too-large` to the check's time and memory limits and the birth's
time (part 12, section 3.6). What each
circumstance does to a reading (a `stopped` row, an account, a creation held) is part 12's table
(its section 3.8).

**The codes and the names other parts use for them.** The binding names are this table's. Part
05's answers of a read are its own words and no codes: its `deleted` is the code `app-deleted`, its
`gone` is `app-gone`, its `linked` is `linked-app`, its `remote` is `remote-app`, its media read's
`missing` is `media-file-unreadable` where a platform the app runs on draws the slot, and a media
file over Nova's limit is no circumstance (the manifest entry above carries it). Its section 4.3
maps every failure kind to this table's names, and B1's
`lib/commcare/hq/failure.ts::hqReadCircumstance(failure: HqFailure): ReadCircumstance` holds those.

**Which permission code a 403 becomes.** HQ does not always say which permission is missing, so the
code follows the read, by part 05's `HqPermissionNeed` (its sections 4.2 and 4.3):

| The read | What its 403 can mean | Code |
|---|---|---|
| the app's source, an import | Edit Apps | `cannot-edit-apps` |
| the API access probe, the application resource, the table list | Access APIs | `cannot-access-apis` |
| a table's rows | Edit Apps or Access APIs, which HQ checks together; the reading reached the rows only after the application resource answered with Access APIs, so Edit Apps is the one that can be missing | `cannot-edit-apps` |
| the levels, the places | two plan features and two permissions, which HQ does not tell apart | `cannot-read-organization` (B1) |

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
  (`proof/matrix/exemptions.json`, reason `stated-by-its-part`; `14-proof.md`, section 7.5, B13) with
  the note "no reading claims it: the HQ read stops first", and their
  subjects and sentences exist because the schema asks a subject of every REFUSED entry and the
  completeness test a sentence of every pair; no account shows them.
- **A media reference with no file.** `media-file-unreadable` is about HQ's server, not the app's
  source: `multimedia_map` holds an entry for the path, and HQ has no file to serve for it. The
  manifest's two entries are about the source: a reference with no `multimedia_map` entry at all
  (`expressions-and-data/a-media-reference-on-a-slot-nova-holds-with-no-multimedia-map`, and
  `a-media-reference-with-no-file-on-a-slot-android-s-install` for the slots Android's install
  checks; from B9 a third, `a-media-reference-with-no-file-on-a-slot-a-runtime-draws`, 3.5). A path is
  in the map or it is not, and part 11's first-match order (`11-project-data.md`, section 3.2) gives a
  reference with no entry exactly one of the source entries, so one reference meets one standing and
  never two.

### 8.4 The copy model (A2)

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
/** `already-in-nova`'s next step, which depends on who holds the app. */
export function alreadyInNovaNext(claim: HqAppClaimDetail | undefined): string;
/** A circumstance's next step, for the account, a stop and MCP alike. Lands in B2. */
export function circumstanceNext(finding: CircumstanceFinding): string;
/** The line under every account's groups (9.1). Lands in B2. */
export const ACCOUNT_CHECK_AGAIN_LINE: string;

/** A place, as one line: "Registration, in the menu Households". */
export function placeLine(place: HqPlace): string;
/** One finding as the account shows it. */
export function findingLine(finding: Finding): {
	readonly sentence: string;
	/**
	 * `detail.name`, shown after the sentence as "In CommCare HQ: <name>"; null where the finding
	 * holds none, and for `read-back-differs`, `could-not-create` and `too-large`, whose
	 * `detail.name` is Nova's own word and no name in the app.
	 */
	readonly named: string | null;
};
```

A `not-yet` or `never` finding's sentence is `FINDING_COPY[subject][standing]`. A `fix-in-hq`
finding's is `fixInHqSentence(subject, cause)`: `FIX_IN_HQ_SENTENCES[subject]?.[cause]` where there is
one, else `FIX_IN_HQ_STEMS[subject]`, a space, and `FIX_CAUSE_CLAUSES[cause]`. One stem serves every
cause a subject's entries give, so an entry that brings a new cause to a subject needs no new string.
A circumstance finding's sentence is its `body`, and its next step is `circumstanceNext(finding)`,
the one function every surface calls (the account screen, a stop and MCP's `read_hq_app`). It
answers `alreadyInNovaNext(finding.detail.claim)` for `already-in-nova` (9.3); for
`no-platform-runs-everything` with `detail.reason === "split-refused"`, "You can change how the date
and time question {question} reads its own answer in CommCare HQ, then check again.", `{question}`
the last segment of `place.path`; otherwise `CIRCUMSTANCE_COPY[code].next`. `CIRCUMSTANCE_COPY`
holds `alreadyInNovaNext`'s answer for an unknown holder as that code's `next`, so the record stays
total. A2 lands `CIRCUMSTANCE_COPY` and `alreadyInNovaNext`; `circumstanceNext` lands in B2, with the
circumstance whose second next step it chooses and the reader that first makes a finding.
`findingLine` and `fixInHqSentence` throw for a pair with no sentence, which the completeness test
makes unreachable. The account's grouping, its headings and its buttons are part 13's
(`13-the-experience.md`, section 7, B11); this file holds the words.

---
## 9. Copy

Every string this part adds, as it ships. All of it follows `design/readme.md`, "Content fundamentals".

### 9.1 The three labels and their next steps (A2, `hqFindingCopy.ts`)

| Standing | `FINDING_LABELS` | `FINDING_NEXT_STEPS` |
|---|---|---|
| `not-yet` | Nova can't hold this yet | There is nothing for you to change. Nova keeps this list, and you can check again whenever you like. |
| `never` | Nova doesn't bring this in | The app can come in once it no longer uses this. If your team relies on it, the app is best kept in CommCare HQ. |
| `fix-in-hq` | Something to change in CommCare HQ | Once this is changed in CommCare HQ, you can check again and Nova will read the app afresh. |

`placeLine`, by place kind: `app` "The app"; `app-settings` "App settings"; `languages` "Languages";
`menu` "The menu {name}"; `case-list` "The case list of {name}"; `case-detail` "The case details of
{name}"; `search` "The search of {name}"; `form` "{name}, in the menu {menuName}"; `question` "The
question {path}, in {formName}"; `lookup-table` "The lookup table {tag}"; `media` "The file {path}";
`organization` "The organization". `findingLine`'s `named` renders as "In CommCare HQ: {name}".

One more export lands in B2, with the reader:
`ACCOUNT_CHECK_AGAIN_LINE = "When these are changed, Nova will check the app again and may find more to name."`
One pass reports everything the reader can decide, and three things are postponed out of a reading
that holds another finding (part 06, `06-the-reader-forms.md`, Departure 11), so an account says a
later read may find more. Part 13 draws the line under the groups of every account and MCP returns it
as `check_again` (`13-the-experience.md`, sections 7.1 and 14.3).

### 9.2 The sentences of manifest findings (A2; `SUBJECT_LABELS` is the Label column)

"Here" in a sentence is the place the account prints above it. The first table is A2's. After it: A3
and A4 remove three `not-yet` rows (2.6), A9 adds and re-words the rows of 2.2's table, the row for
`translation-overrides` lands in B2, the rows of the second table land in the stack B pull requests it
names, and the row for `language-display-names` leaves in B8. `findingLine` gives the sentence and
`named`; it answers `named: null` for `read-back-differs`, `could-not-create` and `too-large`, whose
`detail.name` is Nova's own word (8.4).

A `not-yet` or `never` row's last cell is the whole sentence (`FINDING_COPY`). A `fix-in-hq` row is
one of two things. Where its last cell ends in "is" or "are" it is the subject's stem
(`FIX_IN_HQ_STEMS`), which a cause clause completes:

| Cause | `FIX_CAUSE_CLAUSES` | A whole sentence it makes |
|---|---|---|
| `hq-refuses` | set up in a way CommCare HQ can't save or build. | A menu setting is set up in a way CommCare HQ can't save or build. |
| `breaks-when-run` | set up in a way that doesn't work when the app runs, though CommCare HQ builds it. | A lookup table is set up in a way that doesn't work when the app runs, though CommCare HQ builds it. |
| `either` | set up in a way CommCare HQ can't save or build, or that doesn't work when the app runs. | A deep link is set up in a way CommCare HQ can't save or build, or that doesn't work when the app runs. |

Where a `fix-in-hq` row names a cause beside its standing, its last cell is a whole sentence for that
subject and cause (`FIX_IN_HQ_SENTENCES`), and the subject has no stem. Eight subjects are worded
that way, in eleven sentences, because a plainer thing can be said of them than the clause says.

| Subject | Label | Standing | Sentence |
|---|---|---|---|
| `advanced-forms` | Advanced forms | `not-yet` | This uses a way of loading or opening cases in an advanced form, which Nova can't hold yet. |
| `advanced-forms` | Advanced forms | `fix-in-hq` | The cases this advanced form loads or opens are |
| `after-submit` | After a form is sent | `never` | This uses a destination after the form is sent, which Nova doesn't bring in. |
| `after-submit` | After a form is sent | `fix-in-hq` | Where this form goes after it is sent is |
| `android-app-dependencies` | Android app dependencies | `not-yet` | This uses a list of Android apps the phone must have, which Nova can't hold yet. |
| `android-app-dependencies` | Android app dependencies | `fix-in-hq` | The Android apps this app depends on are |
| `app-document` | The app as stored | `never` | A menu here has no ID in CommCare HQ, so Nova has nothing to keep it by. |
| `app-document` | The app as stored | `fix-in-hq`, `hq-refuses` | Part of how this app is stored is something CommCare HQ can't save or build. |
| `app-logos` | App logos | `not-yet` | This uses logos for the Android home, sign-in and practice screens, which Nova can't hold yet. |
| `app-logos` | App logos | `fix-in-hq` | An app logo is |
| `app-settings` | App settings | `not-yet` | This uses an app setting, which Nova can't hold yet. |
| `app-settings` | App settings | `never` | This uses an app setting, which Nova doesn't bring in. |
| `app-settings` | App settings | `fix-in-hq` | An app setting is |
| `auto-select` | Choosing a case automatically | `not-yet` | This uses a setting that chooses a case for the worker, which Nova can't hold yet. |
| `auto-select` | Choosing a case automatically | `fix-in-hq` | Choosing a case automatically is |
| `blank-form` | Forms with no questions | `fix-in-hq`, `hq-refuses` | A form here has no questions, which CommCare HQ won't build. |
| `build-profiles` | Build profiles | `not-yet` | This uses build profiles, which Nova can't hold yet. |
| `call-center-indicators` | Call center indicators | `never` | This uses call center indicators, which Nova doesn't bring in. |
| `case-attachments` | Files saved on a case | `never` | This uses pictures or files saved on a case itself, which Nova doesn't bring in. |
| `case-detail-tabs` | Case detail tabs | `not-yet` | This uses tabs on the case detail screen, which Nova can't hold yet. |
| `case-detail-tabs` | Case detail tabs | `fix-in-hq` | A tab on the case detail screen is |
| `case-list-callout` | Case list lookups | `not-yet` | This uses a lookup from the case list into another Android app, which Nova can't hold yet. |
| `case-list-callout` | Case list lookups | `fix-in-hq` | A lookup from the case list is |
| `case-list-columns` | Case list and detail columns | `not-yet` | A column here is set up in a way Nova can't hold yet. |
| `case-list-columns` | Case list and detail columns | `never` | This uses a column format, which Nova doesn't bring in. |
| `case-list-columns` | Case list and detail columns | `fix-in-hq` | A column is |
| `case-list-filter` | Case list filters | `not-yet` | The case list filter here is more than Nova can read as a condition yet. |
| `case-list-filter` | Case list filters | `fix-in-hq` | The case list filter is |
| `case-list-optimizations` | Case list speed settings | `not-yet` | This uses a case list speed setting, which Nova can't hold yet. |
| `case-list-optimizations` | Case list speed settings | `never` | This uses a case list speed setting, which Nova doesn't bring in. |
| `case-list-registration` | Registration from the case list | `not-yet` | This uses a way of offering a form from the case list, which Nova can't hold yet. |
| `case-list-registration` | Registration from the case list | `fix-in-hq` | The form offered from the case list is |
| `case-list-setup` | Case list setup | `fix-in-hq` | The case list is |
| `case-list-sorting` | Case list order | `not-yet` | This uses a way of ordering the case list, which Nova can't hold yet. |
| `case-list-sorting` | Case list order | `fix-in-hq` | A sort rule is |
| `case-list-text` | Case list wording | `not-yet` | This uses its own wording for an empty list or the Continue button, which Nova can't hold yet. |
| `case-preloads` | Loading case values into questions | `not-yet` | This uses a way of loading a case value into a question, which Nova can't hold yet. |
| `case-preloads` | Loading case values into questions | `fix-in-hq` | A question that loads a case value is |
| `case-property-names` | Case property names | `fix-in-hq` | A case property name is |
| `case-sharing` | Case sharing | `not-yet` | This uses case sharing, which Nova can't hold yet. |
| `case-sharing` | Case sharing | `fix-in-hq` | Case sharing is |
| `case-tiles` | Case tiles | `not-yet` | This uses a case tile layout, which Nova can't hold yet. |
| `case-tiles` | Case tiles | `fix-in-hq` | A case tile is |
| `child-cases` | Child cases | `never` | This form opens a case of its menu's own type, and this project space leaves out the link between the two. |
| `child-cases` | Child cases | `fix-in-hq` | A child case is |
| `commcare-version` | CommCare version | `fix-in-hq`, `below-floor` | This app is built for a CommCare version below 2.57, the earliest Nova publishes to. |
| `connect-blocks` | CommCare Connect | `not-yet` | This uses a CommCare Connect work area update, which Nova can't hold yet. |
| `connect-blocks` | CommCare Connect | `fix-in-hq` | A CommCare Connect block is |
| `custom-assertions` | Custom assertions | `never` | This uses custom assertions, which Nova doesn't bring in. |
| `custom-device-properties` | Custom device properties | `never` | This uses custom device properties, which Nova doesn't bring in. |
| `data-registry` | Data registries | `never` | This uses a data registry, which Nova doesn't bring in. |
| `data-sources` | Data a form or list reads | `not-yet` | The results' detail screen reads a search answer, which Nova can't hold yet. |
| `data-sources` | Data a form or list reads | `fix-in-hq` | Something this app reads from the device is |
| `deep-links` | Deep links | `not-yet` | This uses a deep link with its own arguments, which Nova can't hold yet. |
| `deep-links` | Deep links | `fix-in-hq` | A deep link is |
| `display-conditions` | Display conditions | `not-yet` | A display condition here is more than Nova can read as a condition yet. |
| `display-conditions` | Display conditions | `fix-in-hq` | A display condition is |
| `display-only-forms` | Forms shown in the menu above | `not-yet` | This uses forms shown in the menu above their own, which Nova can't hold yet. |
| `display-only-forms` | Forms shown in the menu above | `fix-in-hq` | A menu whose forms show in the menu above is |
| `expressions` | Expressions | `fix-in-hq`, `hq-refuses` | An expression here is one CommCare HQ can't build. |
| `expressions` | Expressions | `fix-in-hq`, `breaks-when-run` | An expression here is one CommCare can't run, though CommCare HQ builds it. |
| `expressions` | Expressions | `fix-in-hq`, `either` | An expression here is one CommCare can't run or CommCare HQ can't build. |
| `form-case-management` | Case management | `fix-in-hq` | This form's case management is |
| `form-settings` | Form settings | `not-yet` | This uses a form setting, which Nova can't hold yet. |
| `form-settings` | Form settings | `fix-in-hq` | A form setting is |
| `form-source` | A form's source | `fix-in-hq` | Part of this form's source is |
| `hand-written-content` | Hand-written XML | `never` | This uses hand-written XML or settings that no CommCare HQ page edits, which Nova doesn't bring in. |
| `hierarchical-locations` | The older organization list | `never` | This uses the older, nested list of places, which Nova doesn't bring in. |
| `language-codes` | Language codes | `fix-in-hq`, `hq-refuses` | A language code here is one CommCare HQ's Languages page can't save. |
| `language-display-names` | Language names | `not-yet` | This uses its own name for a language, which Nova can't hold yet. |
| `linked-app` | Linked apps | `fix-in-hq`, `hq-refuses` | This is a linked app, which CommCare HQ updates from another app. |
| `lookup-selection` | Choosing from a lookup table first | `never` | This uses choosing from a lookup table before the case list, which Nova doesn't bring in. |
| `lookup-tables` | Lookup tables | `not-yet` | A lookup table here uses something Nova can't hold yet, or is larger than Nova takes. |
| `lookup-tables` | Lookup tables | `fix-in-hq` | A lookup table is |
| `media-by-language` | Media by language | `not-yet` | This uses a picture or sound that differs by language, which Nova can't hold yet. |
| `media-files` | Media files | `not-yet` | A media file here is larger than Nova takes, or sits somewhere Nova can't hold yet. |
| `media-files` | Media files | `fix-in-hq`, `hq-refuses` | A media file here is kept at a path CommCare HQ can't build into the app. |
| `media-files` | Media files | `fix-in-hq`, `breaks-when-run` | A media file here is in a format CommCare can't play, or is missing from CommCare HQ. |
| `menu-badges` | Menu badges | `not-yet` | This uses a badge on a menu or form, which Nova can't hold yet. |
| `menu-display` | Grid menus | `not-yet` | This uses grid menus, which Nova can't hold yet. |
| `menu-settings` | Menu settings | `fix-in-hq` | A menu setting is |
| `menu-structure` | How menus are nested | `never` | The menus here are in an order that separates a menu from the one above it. |
| `menu-structure` | How menus are nested | `fix-in-hq` | How this menu is nested is |
| `mirror-menus` | Mirror menus | `not-yet` | This uses a mirror menu, which Nova can't hold yet. |
| `mirror-menus` | Mirror menus | `never` | This uses a mirror menu, which Nova doesn't bring in. |
| `mirror-menus` | Mirror menus | `fix-in-hq` | A mirror menu is |
| `mobile-reports` | Mobile reports | `never` | This uses mobile reports, which Nova doesn't bring in. |
| `parent-selection` | Choosing a parent case first | `never` | This uses a first case that is no parent of the second, which Nova doesn't bring in. |
| `parent-selection` | Choosing a parent case first | `fix-in-hq` | Choosing a parent case first is |
| `print-templates` | Print templates | `never` | This uses a print template, which Nova doesn't bring in. |
| `question-appearance` | How a question looks | `not-yet` | A question here has a display style Nova can't hold yet. |
| `question-appearance` | How a question looks | `never` | This uses a display style, which Nova doesn't bring in. |
| `question-appearance` | How a question looks | `fix-in-hq` | A question's display style is |
| `question-choices` | Choices | `not-yet` | This uses a way of supplying choices, which Nova can't hold yet. |
| `question-choices` | Choices | `fix-in-hq` | A question's choices are |
| `question-ids` | Question IDs | `never` | Two questions here share one place in the form's data, so Nova can't tell them apart. |
| `question-ids` | Question IDs | `fix-in-hq`, `hq-refuses` | A question ID here is one CommCare HQ's form builder can't keep. |
| `question-logic` | Question logic | `fix-in-hq` | A question's logic is |
| `question-media` | Media on questions | `not-yet` | This uses a label form, which Nova can't hold yet. |
| `question-media` | Media on questions | `fix-in-hq` | Media on a question is |
| `question-text` | Question text | `not-yet` | This uses a kind of question text, which Nova can't hold yet. |
| `question-text` | Question text | `fix-in-hq` | A question's text is |
| `question-types` | Kinds of question | `not-yet` | This uses a kind of question, which Nova can't hold yet. |
| `question-types` | Kinds of question | `fix-in-hq` | A question is |
| `remote-app` | Remote apps | `never` | This is a remote app, which holds no menus or forms for Nova to read. |
| `repeats` | Repeat groups | `not-yet` | A repeat group here has its own wording on its buttons, which Nova can't hold yet. |
| `repeats` | Repeat groups | `fix-in-hq` | A repeat group is |
| `save-to-case` | Save to Case questions | `not-yet` | This uses a Save to Case question, which Nova can't hold yet. |
| `save-to-case` | Save to Case questions | `never` | This uses a Save to Case question, which Nova doesn't bring in. |
| `save-to-case` | Save to Case questions | `fix-in-hq` | A Save to Case question is |
| `search-default-filters` | Search filters | `not-yet` | This uses a search filter, which Nova can't hold yet. |
| `search-default-filters` | Search filters | `never` | A search filter here sets how the search itself runs from a value worked out on the device. |
| `search-default-filters` | Search filters | `fix-in-hq` | A search filter is |
| `search-expressions` | Search expressions | `not-yet` | This uses a search expression, which Nova can't hold yet. |
| `search-expressions` | Search expressions | `never` | This uses a search expression, which Nova doesn't bring in. |
| `search-expressions` | Search expressions | `fix-in-hq` | A search expression is |
| `search-fields` | Search fields | `not-yet` | This uses a kind of search field, which Nova can't hold yet. |
| `search-fields` | Search fields | `fix-in-hq` | A search field is |
| `search-setup` | Search setup | `not-yet` | This uses a search setting, which Nova can't hold yet. |
| `search-setup` | Search setup | `never` | This uses a search setting, which Nova doesn't bring in. |
| `search-setup` | Search setup | `fix-in-hq` | The search is |
| `shadow-forms` | Shadow forms | `not-yet` | This uses a shadow form, which Nova can't hold yet. |
| `shadow-forms` | Shadow forms | `fix-in-hq` | A shadow form is |
| `supply-features` | CommCare Supply | `never` | This uses CommCare Supply features, which Nova doesn't bring in. |
| `training-menus` | Training menus | `never` | This uses a training menu or release notes form, which Nova doesn't bring in. |
| `translation-overrides` | Changed wording in translations | `not-yet` | This uses its own wording for a menu, form or list, kept in the app's translations, which Nova can't hold yet. |
| `visit-scheduler` | Visit schedules | `never` | This uses a visit schedule, which Nova doesn't bring in. |
| `worker-record` | The worker's own record | `not-yet` | This reads or writes the worker's own record in a way Nova can't hold yet. |
| `worker-record` | The worker's own record | `never` | A question here is named commcare_usercase, the name CommCare HQ gives the worker's own record. |
| `worker-record` | The worker's own record | `fix-in-hq` | A use of the worker's own record is |
| `writer-types` | Answers of different kinds | `not-yet` | Answers of different kinds are saved to one case property here, which Nova can't hold yet. |

**The rows stack B's readers add.** Each is a `not-yet` sentence of `FINDING_COPY`, with the next
step `FINDING_NEXT_STEPS["not-yet"]`, and lands with the first entry that gives its pair (Appendix
A.1's closing block). The part that asked for each words it; these are the binding words. The row
for `repeats` replaces A2's sentence, as 2.6 says.

| Subject | Label | Standing | Sentence | Lands in | Asked by |
|---|---|---|---|---|---|
| `language-codes` | (unchanged) | `not-yet` | A language code here is one Nova can't hold yet. | B2 | part 06 |
| `form-source` | (unchanged) | `not-yet` | A form's source here is built in a way Nova can't hold yet. | B3 | part 06 |
| `question-ids` | (unchanged) | `not-yet` | A question ID here is one Nova can't hold yet. | B3 (A9, with the same words, where part 04's run R2 falls back and adds a `not-yet` entry of the subject first) | part 06 |
| `repeats` | (unchanged) | `not-yet` | A repeat group here is set up in a way Nova can't hold yet. | B3, in place of A2's sentence | this part: A2's sentence names a repeat's button captions, and part 06's `questions/model-iteration-repeat-outside-nova-s-model-iteration-rule` joins the pair |
| `display-only-forms` | (unchanged) | `not-yet` | A form here goes back to, or opens through, the menu above in a way Nova can't hold yet. | B4 (A4 removed A2's sentence) | part 07 |
| `form-case-management` | (unchanged) | `not-yet` | This form's case management is set up in a way Nova can't hold yet. | B4 | part 07 |
| `menu-settings` | (unchanged) | `not-yet` | This uses a menu setting, which Nova can't hold yet. | B4 | part 07 |
| `advanced-menus` (new) | Advanced menus | `not-yet` | This advanced menu is set up in a way Nova would change when it publishes, so Nova can't hold it yet. | B4 | part 07 |
| `list-and-search-filters` (new) | Case list and search filters | `not-yet` | The case list here filters cases its search doesn't, which Nova can't hold yet. | B5 | part 07 |
| `expressions` | (unchanged) | `not-yet` | An expression here is more than Nova can read yet. | B6 | part 08 |

No other entry a later part adds needs a new string: each takes a subject whose sentence for its
standing, or whose stem or whole sentence for its cause, the first table or 2.2's table already
holds. Two pairs
are worth saying, since a reviewer would look: part 11's new `media-files` entry is `breaks-when-run`
and reads the whole sentence of that pair, and part 08's M1, M2 and M5 read the `expressions` and
`search-expressions` rows for their causes.

### 9.3 One block per circumstance (A2, `CIRCUMSTANCE_COPY`)

`{server}` is the server's label, `{space}` the project space, `{app}` the HQ app's name, `{name}`
`detail.name`.

| Code | Title | Body | Next |
|---|---|---|---|
| `not-connected` | Nova isn't connected to CommCare HQ on {server} yet | Nova has no CommCare HQ account of yours on {server} to read with. | You can connect one in Settings, then come back here. |
| `key-not-accepted` | CommCare HQ didn't accept your API key | Nova tried to read {space} with your saved key and CommCare HQ turned it down. The key may have been removed or replaced. | You can save a new key in Settings, then check again. |
| `plan-lacks-api-access` | This project space's plan has no API access | Nova reads an app through CommCare HQ's API, and {space}'s plan doesn't include it. | Once the plan includes API access, you can check again. Someone who manages the project space's subscription can say when. |
| `not-a-member` | Your account isn't part of this project space | CommCare HQ says your account is no member of {space}, so Nova can't read its apps. | You can ask an admin of {space} to add you, or choose another project space. |
| `cannot-edit-apps` | Your account can't edit apps here | Reading an app and the lookup tables it uses needs the Edit Apps permission on {space}, and your account doesn't have it. | You can ask an admin of {space} for Edit Apps, then check again. |
| `cannot-access-apis` | Your account can't use the API here | Reading an app's forms and its list of lookup tables needs the Access APIs permission on {space}, and your account doesn't have it. | You can ask an admin of {space} for Access APIs, then check again. |
| `app-gone` | CommCare HQ no longer has this app | Nova asked {space} for {app} and CommCare HQ holds no app by that ID. It may have been deleted since the list loaded. | You can go back and choose from the apps {space} has now. |
| `app-deleted` | This app was deleted in CommCare HQ | {app} is in {space}'s deleted apps, so there is nothing current for Nova to read. | If it was deleted by mistake, you can restore it in CommCare HQ and check again. |
| `linked-app` | Nova can't bring in a linked app | {app} is a linked app. CommCare HQ rewrites it from another app each time that one is pulled, so nothing Nova published to it would stay. | You can bring in the app it is linked from instead. |
| `rate-limited` | CommCare HQ is busy | CommCare HQ asked Nova to slow down while it read {app}, and it was still busy after Nova waited. | You can check again in a few minutes. Nothing was changed. |
| `hq-unavailable` | CommCare HQ didn't answer | Nova couldn't finish reading {app} because CommCare HQ didn't answer in time or sent something Nova couldn't read. | You can check again. If it keeps happening, CommCare HQ's status page may say why. |
| `changed-while-reading` | The app changed while Nova was reading it | Someone saved {app} in CommCare HQ while Nova read it, twice in a row, so Nova stopped short of mixing two versions. | You can check again once the edits there have settled. |
| `already-in-nova` | This app is already in Nova | {app} is managed by a Nova app already, and one CommCare HQ app is managed by one Nova app so two can't publish over each other. | `alreadyInNovaNext(detail.claim)`, the table under this one. Stored as `next`: its sentence for an unknown holder. |
| `too-large` | This app is larger than Nova can read yet | A2: {app}'s source is bigger than Nova reads in one go. That limit is Nova's, not the app's. From B10, which adds the check's time and memory causes and the birth's time cause: {app} is bigger than Nova can bring in in one go. That limit is Nova's, not the app's. | There is nothing for you to change. Nova keeps this list, and you can check again whenever you like. |
| `menu-unreadable-in-hq` | CommCare HQ can't summarize this menu | CommCare HQ returned an error where its own summary of this menu's forms should be, so Nova has nothing sure to check its reading against. | Opening each of the menu's forms in CommCare HQ's form builder usually shows which one is broken. Once it saves cleanly, you can check again. |
| `shadow-disagrees` | A question's logic says two things | This question's logic and the copy the form builder keeps of it don't match, so Nova can't tell which one the author meant. | Opening the form in CommCare HQ's form builder and saving it makes them match. Then you can check again. |
| `table-differs-in-project` | A lookup table needs your choice | This app reads the lookup table {name}, and your Project already has a table by that name. | You can choose what to do with it in the review. |
| `media-file-unreadable` | CommCare HQ doesn't have this file | The app points at {name}, and CommCare HQ has no file there, so phones can't show it either. | You can upload the file again in CommCare HQ, or remove it from the app there, then check again. |
| `unrecognized` | Nova met something it doesn't know | Nova found something in this app it has no reading for yet. That gap is Nova's, and it has been reported to the team with what it was. | There is nothing for you to change. You can check again after Nova's next update. |
| `read-back-differs` | Nova couldn't confirm its own reading | Nova read this app and then checked its own reading, and the check didn't pass. That's Nova's mistake, not the app's, and Nova has told the team. | Nova keeps this reading so you can check again, and nothing was created or changed. |

**`already-in-nova`'s next step** (`alreadyInNovaNext`, A2). `{name}` is the one contact's name,
`{names}` the contacts' names in words, `{date}` the claim's `at` as the viewer's locale date. The
four `elsewhere` sentences are also the lines the picker shows under its mark for the same view
(part 10, `10-identity-and-the-ledger.md`, "Copy", "The picker's marks"; part 13 places them in B11),
so the picker and a reading say one thing: they live here, part 10's `lib/publish/hqAppClaims.ts`
exports the row labels and no line, and the picker calls `alreadyInNovaNext(claim)`. The facts are
part 10's claim view, which tells `brought-in` from `published`: "It was brought in" would be false
of an app made in Nova and published.

| `detail.claim` | Next |
|---|---|
| absent (the holder could not be read) | You can check again in a moment to see where it is. |
| `open` | It's {appName}, in a Project you're part of. You can open it from your apps. |
| `elsewhere`, `brought-in`, contact `person` | {name} brought it in on {date}. You can ask {name} to invite you, or to stop publishing to it from Nova so you can bring it in yourself. |
| `elsewhere`, `published`, contact `person` | {name} published it from Nova on {date}. You can ask {name} to invite you, or to stop publishing to it from Nova so you can bring it in yourself. |
| `elsewhere`, `brought-in`, contact `owners` | It was brought in to Nova on {date}. {names} can invite you, or stop publishing to it from Nova so you can bring it in yourself. |
| `elsewhere`, `published`, contact `owners` | It was published from Nova on {date}. {names} can invite you, or stop publishing to it from Nova so you can bring it in yourself. |

**The seven blocks B1 adds** (8.3), as part 05 wrote them (its "Copy") and as they ship; a change to
one is made in both places:

| Code | Title | Body | Next |
|---|---|---|---|
| `hq-gateway-refused` | A security gateway turned Nova away | A security gateway in front of CommCare HQ turned Nova's request away before CommCare HQ saw it, so it says nothing about your key or your permissions. | You can check again in a few minutes. If it keeps happening, Dimagi support (support@dimagi.com) can help. |
| `api-cut-off` | CommCare HQ has paused API access | CommCare HQ has paused API access for your account or for {space} after too many requests. Your key and the plan are fine. | Dimagi support (support@dimagi.com) can turn it back on. Then you can check again. |
| `browser-only` | CommCare HQ sent a page meant for a browser | Nova asked {space} for an app and CommCare HQ answered with a page meant for a person, as it does when a project space asks you to sign in another way or isn't active. | Opening {space} in CommCare HQ shows what it's asking for. Once that's settled, you can check again. |
| `remote-app` | This app isn't kept in CommCare HQ | {app} is hosted outside CommCare HQ, which only links to it, so there's nothing here for Nova to bring in. | You can go back and choose another app from {space}. |
| `cannot-read-organization` | Nova couldn't read this project space's organization | {app} reads places, and reading them from {space} needs Locations and API access on its plan, and the Edit Locations and Access APIs permissions on your account. CommCare HQ doesn't say which one is missing. | An admin of {space} can check these four. Then you can check again. |
| `app-unreadable-in-hq` | CommCare HQ can't summarize this app | CommCare HQ returned an error where its own summary of this app's forms should be, so Nova has nothing sure to check its reading against. | Opening the app's forms in CommCare HQ's form builder usually shows which one is broken. If they all open, Dimagi support (support@dimagi.com) can help. Then you can check again. |
| `table-rows-unreadable` | CommCare HQ couldn't send this table's rows | CommCare HQ listed the lookup table {name} and then couldn't send its rows. A row that holds a field with no value is one cause Nova knows of. | You can open the table in CommCare HQ and fill in or remove that row, then check again. |

**The eight blocks stack B adds** (8.3), each worded by the part that raises it and binding here; a
change to one is made in both places. For `table-cell-unrepresentable` and `table-choices-unusable`,
`{name}` is the whole `detail.name`, so a body reads "The lookup table regions (the field
district_name) in ...".

| Code | Title | Body | Next | Lands in |
|---|---|---|---|---|
| `no-platform-runs-everything` | No one platform runs this whole app | Part of this app runs only in Web Apps and part only on Android, so workers on either would meet something that doesn't work. | You can change one of these in CommCare HQ so one platform runs everything, then check again. | B2 |
| `places-over-nova-limit` | This project space has more places than Nova takes | {app} reads places, and {space} has {name}. Nova holds up to 10,000 for an app. | Nothing to change on your side. This will come in once Nova takes larger organizations. | B9 |
| `place-not-holdable` | A place or level is one Nova can't hold yet | {name} in {space} has a code, a name or a value Nova can't hold yet. | Nothing to change on your side. You can check again after Nova's next update. | B9 |
| `media-not-played-where-app-runs` | A media file doesn't play where this app runs | The app points at {name}, and no platform that can run the rest of this app plays that file's format. | You can replace it in CommCare HQ with a PNG or JPEG picture, an MP3 sound or an H.264 MP4 video, then check again. | B9 |
| `table-cell-unrepresentable` | A lookup table holds a character CommCare can't carry | The lookup table {name} in {space} holds a character CommCare can't carry in a value. | You can take that character out in CommCare HQ, then check again. | B9 |
| `owner-rule-needs-one-place` | An owner rule needs exactly one place | {app} gives a case to the place at the level {name} below its current owner. In {space} that isn't exactly one place everywhere, and Nova holds the rule only where it is. | Nothing to change on your side. You can check again after Nova's next update. | B9 |
| `table-choices-unusable` | A lookup table's rows can't be a question's choices | A question takes its choices from the lookup table {name} in {space}, and that table has no rows there, or has a row whose value is blank, starts or ends with a space or appears twice, or whose label is blank. | You can change those rows in CommCare HQ, then check again. | B9 |
| `could-not-create` | Nova couldn't create this app | Nova read {app} and every check passed, and then Nova's own last check before saving turned the app down. That is Nova's mistake, not the app's, and it has been reported to the team. Nothing was created. | Nova keeps what it read, and you can check again after Nova's next update. | B10 |

`no-platform-runs-everything` has a second next step, which `circumstanceNext` gives where the
finding carries `detail.reason: "split-refused"` (8.4): "You can change how the date and time
question {question} reads its own answer in CommCare HQ, then check again." It is a string of
`hqFindingCopy.ts` beside the block and lands in B2 with it.

### 9.4 The kept list (A3)

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

/** The kinds of `lib/deployment/service.ts::KeptRefreshOutcome`, restated so this file stays client-safe. */
export type KeptRefreshKind =
	| "refreshed" | "changed-in-hq" | "superseded" | "no-baseline"
	| "app-gone" | "unreadable" | "no-permission" | "unavailable";

export function keptRefreshSentence(
	outcome: {
		readonly kind: KeptRefreshKind;
		/** For `refreshed`: whether the label list differs from the one shown before the refresh. */
		readonly listChanged: boolean;
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
| Outcome `refreshed`, list changed | Updated. This is what CommCare HQ holds now. |
| Outcome `refreshed`, list unchanged | Nothing has changed. This is still what CommCare HQ holds. |
| Outcome `changed-in-hq` | CommCare HQ's copy of this app has changes Nova hasn't seen, so these stay as of {date}. The next publish here will show you what changed. |
| Outcome `superseded` | Someone published here while Nova was reading, so this is as that publish left it. |
| Outcome `no-baseline` | Nova hasn't read this app from CommCare HQ since its last publish here, so it has nothing to refresh. Publishing again reads it. |
| Outcome `app-gone` | CommCare HQ no longer has this app in {space}. Check status shows where things stand. |
| Outcome `unreadable` | CommCare HQ answered with something Nova couldn't read as this app, so these stay as of {date}. Opening the app in CommCare HQ shows whether it still opens there. |
| Outcome `no-permission` | CommCare HQ didn't let your account read this app, so these stay as of {date}. Reading it needs permission to edit apps in {space}. You can check the connected account, then refresh again. |
| Outcome `unavailable` | Nova couldn't reach CommCare HQ just now. You can try again in a moment. Nothing was changed. |
| Raised, `hq_not_connected` | CommCare HQ isn't connected on your account, so Nova can't read these again. You can add your API key in Settings, then refresh. |
| Raised, `domain_not_authorized` | Your CommCare HQ API key can't reach “{space}”, so Nova can't read these again. What you see is the last thing Nova saw. |
| Raised, a key on another server | `assertCredentialsMatchServer`'s sentence, as Check status prints it |

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
| `language-names` (B8) | Language names | `translations-lang-code-any-other-value-or-absent-where-hq-s` |

### 9.5 The `.ccz`'s advisories (A3, `exportAdvisories.ts`)

| Id | Title | Message |
|---|---|---|
| `kept_ui_text_falls_back` | Some of CommCare's own wording differs in this file | This project space rewords some of CommCare's own screens. This CCZ carries each rewording it holds. Where a language has none, an app installed from CommCare HQ shows CommCare HQ's translation and this file shows the phone's built-in wording. |
| `kept_android_logos_absent` | This file has no Android logos | This project space's app has its own logos for the Android home, sign-in or practice screen. They live in CommCare HQ, so this CCZ shows CommCare's own. An app installed from CommCare HQ shows yours. |
| `kept_practice_worker_absent` | Practice mode uses CommCare's sample worker in this file | This project space's app has a practice mobile worker. That worker's data lives in CommCare HQ, so practice mode in this CCZ opens CommCare's own sample worker. |
| `kept_language_names_differ` (B8) | Some language names may differ in this file | CommCare HQ names a language itself where this app gives none, and this CCZ uses Nova's name for it. The language picker may show a different spelling than an app installed from CommCare HQ. |

### 9.6 MCP (A3)

`refresh_deployment`'s description gains, after its last sentence: "Pass `kept_values: true` to read
again the settings this project space keeps in CommCare HQ (the `kept` list of `get_deployment`)
without asking about builds. It updates them only where nothing Nova publishes has changed in CommCare
HQ since the last publish, and says so otherwise." The input: `kept_values`, optional boolean,
described "Read the project space's kept settings again, in place of the build and release check."
`get_deployment`'s description gains: "`deployment.kept` lists the settings that stay as CommCare HQ
holds them on that project space, with the date Nova read them."

### 9.7 Public docs (A3)

`content/docs/building-with-nova.mdx`, the section "Preview on Web Apps and Android", gains one
paragraph: "Preview marks every required question with an asterisk. Web Apps does the same. An Android
phone marks them only where the app's CommCare HQ setting for it is on, which a new app's is not, so a
required question can look unmarked on a phone until the worker tries to move past it. Preview's case
list search follows your project space's fuzzy search setting once the app is published to one project
space: with it on, a near miss of four letters or more still finds its case, as it does for a worker.
On Android the closest matches come first, and in Web Apps the list keeps its own order."

`content/docs/publishing.mdx` gains a section "What stays as it is in CommCare HQ": "Some of an app's
settings are CommCare HQ's to keep: how often phones update, fuzzy search in case lists, your rewording
of CommCare's own screens, your Android logos and a few more. Nova doesn't change them when it
publishes, so you can keep setting them on the app's Settings page in CommCare HQ. The Publishing
section lists the ones your project space holds differently from a new app, with the date Nova last
read them, and Refresh from CommCare HQ reads them again. A CCZ you download for that project space
follows them. Two things it can't carry, your Android logos and a practice mobile worker, it tells you
about when you download it."

B14 adds to that section, for the behavior of 7.3 that B8 lands (stack B's public docs land in B14
with their text fixed in the part that words them; part 15, `15-stack-contracts-and-exit.md`,
section 7): "An app you brought in from
CommCare HQ keeps these settings exactly as it had them, including the ones it never set. Nova fills
in its own defaults only on an app it created there."

---

## 10. Tests

Each test names its boundary and the failure it would catch. None renders a component in jsdom.

**A2**

| Test | Boundary | Catches |
|---|---|---|
| `lib/commcare/surface/__tests__/standing.test.ts` | pure | `standingOf` over one planted entry per disposition and per reason kind, and the two mixed entries by id: a kind moved between the lists, or a new kind in `REFUSAL_REASON_KINDS` with no group (also a compile error). `fixCauseOf` over one planted entry per row of 2.1's cause table, a planted entry holding both groups under conditions (`either`), `null` for every entry that is not `fix-in-hq`, and the real manifest's counts by cause (179, 63, 13, 1 today, computed and printed, not pinned) |
| `surface/__tests__/manifest.test.ts`, the five rules of 2.6 | pure, over the real manifest | each rule with its planted failing entry: a HELD-NEW entry without a class on a shared key; an unused subject; a new mixed-reason entry; a version-floor reason beside another fix kind |
| `surface/__tests__/manifest.test.ts`, "parses no entries file that breaks the schema" (extended) | pure | a planted HELD-NEW entry without `subject`, a planted REFUSED one without it, a planted HELD-NEW one without `owner`, and a planted HELD entry that names a subject: each fails to parse, and the first three with the message of 2.6 |
| `surface/__tests__/manifest.test.ts`, the re-cut entries | pure | the two new inert entries and the build-profiles split parse, name existing keys, and overlap no class of their key; the `xmlns` entry holds no `slotChanges` |
| `lib/publish/__tests__/hqFindingCopy.test.ts` | pure, over the real manifest (`loadManifest`) | both directions of completeness. For `not-yet` and `never`: every `(subject, standing)` an entry gives has a sentence in `FINDING_COPY`, and every sentence's pair is given by some entry. For `fix-in-hq`: `fixInHqSentence` answers for every `(subject, fixCauseOf(entry))` an entry gives; every stem's subject and every whole sentence's pair is given by some entry; no subject holds both a stem and a whole sentence for every cause its entries give; the composed sentence of every such pair is printed once in the test's output so a reviewer reads all 81. Every member of `READ_CIRCUMSTANCES` has a block and no block names another code (20 members in A2, 27 after B1, 28 after B2, 34 after B9, 35 after B10; the test reads the list and pins no count); `alreadyInNovaNext` answers for an absent claim and for each of the six rows of 9.3's table, and no answer holds a `{` placeholder; every subject has a label. `findingLine` answers `named: null` for `read-back-differs` and `too-large` whatever `detail.name` holds (and for `could-not-create` from B10). From B2: `circumstanceNext` answers for every member of `READ_CIRCUMSTANCES`, gives `alreadyInNovaNext`'s answer for `already-in-nova`, the second sentence of `no-platform-runs-everything` under `detail.reason: "split-refused"` with the question's name in place of `{question}`, and the block's `next` otherwise; that second sentence and `ACCOUNT_CHECK_AGAIN_LINE` are held to the voice rules with the rest. And the voice rules a machine can hold, each over the strings it fits: no em dash, no ellipsis and no "import" as a word, in every string; sentence case at the start, in every string; a full stop at the end, in every sentence, body and next step (a stem joined to each clause it takes counts as a sentence), and none at the end of a label, a title or a stem |
| `lib/publish/__tests__/hqFindings.test.ts` | pure | `findingSchema` refuses a manifest finding with `owner` under a standing other than `not-yet`, one with `cause` under a standing other than `fix-in-hq` or a `fix-in-hq` one without it, a circumstance finding with a subject, a `stop` on a manifest code, and a `claim` on any code but `already-in-nova`. A type-level check holds part 10's `HqAppClaimView` to `HqAppClaimDetail` with `remoteAppId` added, from B8 |

**A3**

| Test | Boundary | Catches |
|---|---|---|
| `lib/commcare/surface/__tests__/keptAtHq.test.ts` | pure, over the real manifest | the binding, both ways: every TARGET-OWNED entry has a `KEPT_AT_HQ` row and every row names a TARGET-OWNED entry; every `setting` row with a `label` is reached by `keptListFor` for some planted `TargetFacts`; every `states` cell names an advisory id that `exportAdvisories` can return; every `mirrors` cell's `by` names an exported symbol; a planted TARGET-OWNED entry with no row fails. The base rule: every row names a base of part 14's 6.2, or is null and its entry is exempt. In A3, where no base exists yet, the test holds each `base` to one of the three ids section 5 names and `null` to `36-hq-custom-base-url` alone; from B13 part 14's `lib/commcare/surface/__tests__/entryCoverage.test.ts` (its section 7.5, rule 2) holds each `base` to a base whose `claimed` holds the entry and `null` to an entry `proof/matrix/exemptions.json` names |
| `lib/commcare/__tests__/targetFacts.test.ts` | pure, over the retained read `proof/hq-reads/case-list-inline/app-source.json` and edits of it. The file is an HTTP envelope (`status`, `headers`, `body`), so the test takes `body` and normalizes it with `normalizeHqAppSource`, as a stored baseline is | `targetFactsFromSource`, each row of 6.1's table: a setting at another choice, the numeric `10`, a boolean `true` and `false`; a runtime UI text key, a `target` key no runtime reads (in `uiText`, not in `uiTextKeys`) and a generated key in `translations`; each logo slot; `auto_gps_capture` under each ownership; a custom base URL with a path, with a trailing slash and with no scheme; a credential level; a source that is no object gives `null`. `isRuntimeUiStringKey`: a key the surface holds with a reader, a key under a `.*` item, a key of HQ's catalog no runtime reads, an unknown key |
| `lib/deployment/__tests__/targetFacts.test.ts` | pure | `targetFactsFromBaseline`: `create` gives `null`; `push` and `cutover` give the source's facts with the baseline's `observedAt` and its ownership of `auto_gps_capture`. `keptListFor` over planted facts: each label id under its predicate, none for facts at every default |
| `lib/deployment/__tests__/targetFacts.postgres.test.ts` | real Postgres | `readTargetFacts` answers a viewer and refuses a non-member; returns `null` for no row, an `unread` row and a row whose digest does not verify; a second read of an unchanged row selects no `source_gzip` (the query log shows one statement); a rewritten baseline is read afresh |
| `lib/deployment/__tests__/refreshKeptValues.postgres.test.ts` | real Postgres, HQ answered by the controlled client the publish tests use | `refreshed` rewrites source, digest and `observed_at` (the instant taken before the request) and keeps origin, a `cutover` one included, ownership and a stored discard, and notifies the deployment lane; `changed-in-hq` (a form edited in the answer) writes nothing; `no-baseline` for no live mapping, for an `unread` and a `create` baseline and for a baseline of another remote app; `app-gone`; `unreadable` for a linked app's answer and for a malformed one; `no-permission` for a 401 and a 403; `unavailable` for a 500 and a timeout; each writes nothing. `superseded`: a publish's baseline written between the refresh's comparison and its write is kept, and the answer carries the deployment as that publish left it. A refresh whose answer arrives after a publish's read-back, having been asked before it, does not replace it. The three raised `DeploymentError`s (no key, a key that cannot reach the project space, a key on another server) write nothing. A viewer is refused |
| `lib/commcare/__tests__/keptProfile.test.ts` | pure | `targetProfileProperties` with no facts equals `appProfileProperties`; with facts, each seeded key takes the target's value and keeps its `force`; the two owned settings never move; the log setting appears only when held; the first fifteen of `KEPT_PROFILE_PROPERTY_KEYS` equal `SEEDED_PROFILE_PROPERTIES`' keys in order. From B8: with `seeds: "target"` a seeded key the facts hold no value for is left out |
| `lib/commcare/__tests__/runtimeTarget.test.ts` (extended) | pure | `PostURL` on the secure receiver; all three URLs on a custom base's origin; `cc_user_domain` unmoved. The vectors are worked from `urljoin`: a base of `https://example.org`, of `https://example.org/`, of `https://example.org/hq/` and of `https://example.org:8443/x` give `https://example.org/a/<domain>/…` for the first three and `https://example.org:8443/a/<domain>/…` for the last |
| `lib/commcare/__tests__/keptArchive.test.ts` | wire through an independent consumer: the archive is unzipped and its `profile.ccpr`, each `app_strings.txt` and one form are parsed with `xmlParse.ts` and the locale reader | a `.ccz` compiled with facts holds the target's settings, the UI text in each language and in `default` (a stored text for `case_autoload.usercase.case_missing` in place of Nova's message), `cc:location` with its sensor, the secure `PostURL`, and the `<credentials>` block as the last child of `<features>` with the level and `type="APP_ACTIVITY"`; compiled with `null` it is byte for byte today's archive (the existing fixture) |
| the same file, a property | pure | for any source profile whose kept settings hold values of their own choices, the seventeen keys of `projectProfileForTarget(appJson, sourceProfile, "not-needed")` equal what `targetProfileProperties` writes from that source's facts: the publish and the archive cannot state different settings for one project space. From B8 the property runs under `seeds: "nova"` and `seeds: "target"`, with the facts' `seeds` to match |
| `lib/publish/__tests__/exportAdvisories.test.ts` (extended) | pure | each kept advisory appears exactly under its predicate; the attachment advisory stays first; `null` facts add none |
| `lib/publish/__tests__/keptValues.test.ts` | pure | every member of `KEPT_LABEL_IDS` has a label and no two labels are equal; `keptRefreshSentence` answers for every `KeptRefreshKind` under both values of `listChanged`, and `keptLead` under both of `hasLabels`, with no `{` placeholder left in an answer; and the voice rules of `hqFindingCopy.test.ts` over every string of the file and over the title and message of each `kept_` advisory: no em dash, no ellipsis, no "import" as a word, sentence case at the start, a full stop at the end of a sentence (the lead with labels ends in its colon) and none at the end of a label or a title. The two button labels of 9.4 are the card's own strings |
| `lib/preview/__tests__/listFilterMatch.test.ts` | pure, vectors worked from Core's source | `normalizeForFilter("José")` is `"jose"`; `fuzzyMatch("smith", "smyth")` matches at 1; `("smit", "smith")` at 1; `("smi", "smith")` does not (length 3); `("john", "johnathan")` matches at 2 after the cut to six characters; `("maria", "mark")` matches at 2; `("maria", "peter")` does not; a row matched exactly scores 0; with `fuzzy` off no near miss matches; an empty term passes a row with any text and fails a row whose every field is blank. `filterTerms`, vectors worked from Java's `String.split`: `"ann  lee "` is `["ann", "lee"]` under `whitespace-runs` and `["ann", "", "lee"]` under `single-spaces`; `" ann"` is `["", "ann"]` under both; `"ann\tlee"` is two terms under `whitespace-runs` and one under `single-spaces`; `"José"` is `["jose"]` |
| `components/preview/shared/__tests__/listFilter.test.ts` | state model: the function over production `Column`s and a `CaseListOrderPlan` from `caseListOrderPlan` | a field with no sort key is never matched fuzzily; a carrier's raw value is; order with `fuzzy` off is the input's; with `fuzzy` on, `closest-first` puts an exact match before a near miss that came first in the list, and `list-order` leaves the list's order; empty and all-space text keeps every row under both rules |
| `lib/preview/__tests__/platform.test.ts` (extended) | pure | `listFilter` is `single-spaces` and `list-order` for Web Apps, `whitespace-runs` and `closest-first` for Android |
| `lib/collab/__tests__/previewTargetFactsFrame.test.ts` | pure | a malformed frame parses to `null`; `{ facts: null }` parses |
| `app/api/apps/[id]/stream/__tests__/stream.postgres.test.ts` (extended) | real Postgres | the lane sends `preview-target-facts` on connect and after a baseline write that changes the fuzzy setting, and not after one that leaves it |
| `lib/deployment/__tests__/previewTarget.test.ts` (new; `resolvePreviewDeploymentTarget`'s own cases stay in `setupArtifact.test.ts`, where they are today) | pure | `resolvePreviewFactsTarget`: one deployment; none; two domains; one domain on two servers gives `null` |
| `e2e/tests/app/preview-kept.spec.ts`, with its seed `e2e/lib/keptBaselineSeed.ts` beside the other app seeds | Playwright against the production server and the job's own Postgres: `e2e/tests/browser/` starts no server and no database (`e2e/CLAUDE.md`), and this journey needs `app_deployment_baselines` rows, the builder page's `previewTargetFactsFor` and the Publishing section. The seed writes a reached deployment with a `push` baseline holding `cc-fuzzy-search-enabled: yes`, and a twin holding `no` | typing a near miss in Preview's list filter finds the case, and does not on the twin; the Publishing card lists "Fuzzy search in case lists" with its date and the Refresh button; the twin's card reads the no-label sentence and still offers the button |
| `lib/mcp/__tests__/servedSchemas.test.ts` (updated snapshot) | pure | `refresh_deployment`'s `kept_values` and the two descriptions are what a client receives |
| `surface/__tests__/platformFeatures.test.ts`, `lib/preview/__tests__/platformCells.test.ts` | unchanged code | pass once the thirteen rows leave both tables; fail in A3 if one is left |

**B2** adds to `hqFindingCopy.test.ts` the `circumstanceNext` and `ACCOUNT_CHECK_AGAIN_LINE` cases
its row above marks "From B2", and **B10** the `named: null` case for `could-not-create`. No other
case is added by a later pull request: the completeness rules already force each new subject's
label, each new pair's sentence (9.2's second table) and each new circumstance's block (9.3) in the
pull request that adds the entry or the code. A re-worded sentence (2.6) is held by no test; the
pull request that lands it shows the old and the new sentence in its description.

What these tests do not hold, and what does: that a `mirrors` cell is true of HQ's real build is Run 1
and then proof 3 on the base `hq-kept-settings`; that each kept entry's clause 1 is true is proof 1 on
the HQ-authored bases against the first-publish register; that Core's fuzzy rule is ported right is
Run 2; that an adopted deployment is seeded nowhere is Run 3. How Android and Formplayer split the
typed text and order the matches is read at source and held by the vectors above, with no native run:
the two functions sit in each runtime's own screen code, outside what the native families load.

---

## 11. Contracts and docs these changes make false

| Where | Sentence today | Replacement | PR |
|---|---|---|---|
| `lib/commcare/CLAUDE.md`, "The surface manifest" | "its disposition (HELD, HELD-NEW, TARGET-OWNED, INERT or REFUSED), the slot change or the refusal's reason, the Web Apps and Android behavior, the gates it needs, and its emission." | adds: "A HELD-NEW or REFUSED entry names its `subject`, the noun a person reads (`lib/publish/hqFindings.ts::SUBJECTS`), and a HELD-NEW entry its `owner`, the step 7 group that will hold it. An entry's standing for a reading (`held`, `kept`, `inert`, `not-yet`, `never`, `fix-in-hq`) is derived by `surface/standing.ts::standingOf`, never written, and so is the cause of a `fix-in-hq` entry (`fixCauseOf`), which chooses the sentence a person reads." | A2 |
| same section | "`surface/__tests__/manifest.test.ts`, in ordinary CI, holds the entries to the schema and to the surface (…)" | the parenthesis gains: "every HELD-NEW and REFUSED entry names a subject, every subject is used, every HELD-NEW entry names an owner and carries a value class where it shares a key with an allowing entry" | A2 |
| same section | "A change to an entry edits its row in the inventory under `docs/research/2026-09-26-hq-round-trip/inventory/` in the same pull request" | adds: "`subject` and `owner` are fields of the manifest alone: the inventory has no column for either, and an edit to them alone moves no inventory row." | A2 |
| same section, new paragraph | (none) | "A TARGET-OWNED entry is content Nova leaves at CommCare HQ's value under the kept test: a publish never changes it, nothing the document holds does something different under it, and every Nova surface that shows or runs what it changes reads the target's value or says so. `surface/keptAtHq.ts::KEPT_AT_HQ` holds one row per such entry (what a `.ccz` does, what Preview does, what a first publish to another project space does, and the base that exhibits it), bound to the manifest by `surface/__tests__/keptAtHq.test.ts`." | A3 |
| `lib/commcare/CLAUDE.md`, "Runtime request destinations" | "The seventeen settings of `appProfileSettings.ts::appProfileProperties` follow in its order, each with the `force` its table gives." | "The seventeen settings follow in `appProfileProperties`' order, each with the `force` its table gives: the two the app owns at the app's value, and each of the fifteen others at the value the archive's project space holds, or Nova's where it holds none (`keptProfile.ts::targetProfileProperties`, over the deployment's `TargetFacts`), then `cc-log-entity-detail-enabled` where the project space sets it." | A3 |
| same paragraph | "its profile names that space's four server properties (`ota-restore-url`, `PostURL`, `key_server` and `cc_user_domain`, from `runtimeTarget.ts::profileServerProperties`)" | adds: ", on the origin of the project space's custom base URL and on its secure receiver where its app holds them" | A3 |
| same paragraph | "`<features>` opens with `<checkoff active=\"true\"/>`, without which a device hides its saved forms whatever the setting says." | adds: "It ends with the `<credentials>` block HQ's build writes where the project space issues a worker activity credential (`TargetFacts.credentialLevel`), which Android's work history reads." | A3 |
| `lib/commcare/CLAUDE.md`, "CommCare HQ project-space compatibility" | "(`cc-show-saved` and `cc-show-incomplete` always; a constant setting only where the target holds no value for it)" | "(`cc-show-saved` and `cc-show-incomplete` always; a constant setting only where the target holds no value for it, and never on a deployment whose app Nova brought in, where an absent setting stays absent)" | B8 |
| `lib/commcare/appProfileSettings.ts`, header | "the overlay (`targetOverlay.ts::projectProfileForTarget`) keeps a value the target already holds for any of the fifteen, and always writes Nova's two." | adds: "On a deployment whose app Nova brought in from CommCare HQ it writes none of the fifteen (`seeds: \"target\"`)." | B8 |
| `lib/deployment/CLAUDE.md`, "One publish lifecycle" | "`hqImportApplication` projects `profile`, `translations` and `add_ons` on the publish's last read of the app's source before the import" | adds: "On a deployment whose live app mapping is `adopted` it asks the overlay to leave the target's language names and its absent profile settings as they are (`languageNames: \"target\"`, `seeds: \"target\"`), so the first publish over an app Nova brought in changes neither." | B8 |
| `lib/commcare/CLAUDE.md`, "CommCare HQ project-space compatibility" | "Seventeen ordinary profile properties are stated by `appProfileSettings.ts::appProfileProperties`: `cc-show-saved` and `cc-show-incomplete` are app content (`appSettings`), and the other fifteen are constants, each the value a device reads when the key is absent." | "…and the other fifteen are CommCare HQ's to keep: Nova states its own value, the one a device reads when the key is absent, only where a project space holds none." | A3 |
| `lib/commcare/CLAUDE.md`, "Form `<meta>` block" | "For a Connect app the local block also captures location, as HQ's build does" | "For a Connect app, and for an app whose project space captures location with every form (`TargetFacts.autoGpsCapture`), the local block also captures location, as HQ's build does" | A3 |
| `lib/export/CLAUDE.md` | "(`compileLocalArchive(prepared, runtimeTarget, identity, deployment)`, the target, that deployment's ids and the reached target's `emptyCaseListText` and `earlierHqApps` required)" | "…and the reached target's `emptyCaseListText`, `earlierHqApps` and `targetFacts` required; `targetFacts` is what the project space holds of the values Nova leaves to CommCare HQ, or `null` where Nova has not read them" | A3 |
| `lib/deployment/CLAUDE.md`, "Baselines" | (after "It holds no form ids…") | adds: "`targetFacts.ts::targetFactsFromBaseline` projects the stored source to `TargetFacts`, what the project space holds of the values Nova leaves to CommCare HQ. `store.ts::readTargetFacts` returns that projection to a viewer and never the source. A `.ccz`, Preview and the Publishing card read it; an absent, unread or shell baseline gives none, and Nova's own values stand. `service.ts::refreshKeptValues` replaces the baseline with a fresh read only where the publish's own comparison finds no change, so it moves no later drift verdict. Its write (`store.ts::recordRefreshedAppBaseline`) lands only while the stored baseline is still the one compared, and its date is taken before CommCare HQ is asked, so a read that predates a publish never replaces that publish's. The type and the reading of CommCare HQ's own keys are `lib/commcare/targetFacts.ts`'s." | A3 |
| `lib/deployment/CLAUDE.md`, "Two things the record answers besides publishing" | the three bullets | a fourth: "`previewSpace.ts::previewTargetFactsFor` names what Preview may read of the kept values, for the one reached `(server, domain)` or not at all." | A3 |
| `lib/preview/CLAUDE.md`, "`commcare_project` comes from the deployment record" | "Preview names the project space a worker signed into exactly when one deployment of this app has reached `uploaded`" | adds a paragraph: "The same rule carries one kept setting, fuzzy search in case lists. The list filter is Core's entity filter (`lib/preview/listFilterMatch.ts`): accents folded, every term required, and with the project space's `cc-fuzzy-search-enabled` on, a near miss matched against each sorted field's words. The platform rule `listFilter` holds what each runtime does around it: Web Apps splits the typed text on single spaces and keeps the list's own order, Android splits on runs of whitespace and puts the closest matches first. The fact arrives as the `preview-target-facts` frame and through `DeploymentTargetProvider`; with none, the filter is exact." | A3 |
| `lib/preview/__tests__/platformCells.ts`, the constant `PROFILE_PROPERTY_ONLY_ANDROID_READS` | "A profile property only Android reads; Preview reads no profile property." | removed with its thirteen rows; the two remaining profile rows (`20`, `21`) keep their own reasons | A3 |
| `lib/commcare/runtimeTarget.ts::profileServerProperties`, comment | "with the receiver URL in its plain form because every app Nova imports has `secure_submissions` off" | section 6.3's sentence | A3 |
| `lib/commcare/appProfileSettings.ts`, header | "On a publish they are seeded, not owned" | adds: "and a `.ccz` made for a project space writes that space's value (`keptProfile.ts`)" | A3 |
| `components/builder/CLAUDE.md`, the Publishing section's paragraph | "one full `DeploymentStatus` card per project space the app has reached, with Check status, the Workers panel, and a \"Publish again\"" | adds: ", and the list of what stays as it is in CommCare HQ with its date and Refresh from CommCare HQ" | A3 |
| `docs/architecture/contracts.md`, "Nova is not CommCare HQ." | (the two HQ facts) | a new paragraph after it, in these words: "**Some of an app stays CommCare HQ's.** Content outside an app's menus that Nova's publish never writes is kept at CommCare HQ's value only when three things hold: no publish changes it on that project space; nothing the document holds does something different under its value; and every Nova surface that shows or runs what it changes reads the project space's value or says how it differs. `lib/commcare/surface/keptAtHq.ts::KEPT_AT_HQ` holds one row per kept entry with what a `.ccz` does, what Preview does and what a first publish to another project space does, and a test binds it to the manifest both ways." | A3, which lands the behavior. A11 does not re-word it; it adds the contracts of the stack's other pull requests |
| `docs/research/2026-09-26-hq-round-trip/inventory/*.md` | the rows of section 3 | as section 3 words them; the Counts table stays the research's | A2, A3 |
| `content/docs/publishing.mdx`, `content/docs/building-with-nova.mdx`, `content/docs/mcp/tools.mdx` (`refresh_deployment`, `get_deployment` rows) | | section 9.6 and 9.7 | A3; B14 for 9.7's last paragraph |
| `../nova-plugin/skills/upload_to_hq/SKILL.md` (the sibling repo's skill that names `refresh_deployment` and `get_deployment`) | swept for A3: it says `refresh_deployment` "returns the same shape; report `state`", that it "can also answer with an ERROR instead of a state", and that `get_deployment` "reports every project space an app has been published to without contacting CommCare HQ" | none of the three is made false: a call without `kept_values` answers as before, a raised `DeploymentError` is still an error and no verdict on the app, and `get_deployment` still reads nothing of HQ. The skill gains, after its paragraph on `hq_app_empty` and `hq_app_gone`: "Each deployment can also carry `kept`: the settings that stay as CommCare HQ holds them on that project space, with the date Nova read them. Say them when the user asks what Nova leaves alone. `refresh_deployment` with `kept_values: true` reads them again and answers with a sentence instead of a state; relay it as it is." | B12, with the stack B sweep of that skill and its `plugin.json` bump, merged after the Nova deploy that serves `kept_values` is live |

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
   settled here by removing the widen: fifteen settings become kept (A3), `Form.autoCaptureLocation`
   is left to the per-form entry that already names it and stays not-yet (A3), and the `xmlns` row's
   widen goes because this plan gives a form no stored `xmlns` slot (A2, 3.3; part 10, sections 2 to
   4). The other 28 are part 04's (`04-names.md`).
9. **From the outline, item 9, "Defect 20's confirmations", item 10, "Confirmations", and items 2 to 5,
   7 and the cutover.** None is this part's: confirmations at adoption are recorded by part 10
   (`10-identity-and-the-ledger.md`, section 6.5, B8) at the birth part 12 plans
   (`12-the-reading-and-the-birth.md`, B10), the birth owner and the ledger
   are B8's and B10's (parts 10 and 12), project data is B9's (part 11, `11-project-data.md`), drift
   merging is step 7's first group (`changes-made-in-hq`), entry points are B11's and B12's (part 13,
   `13-the-experience.md`), the bases are B13's (part 14, `14-proof.md`), and the cutover is replaced
   by derived ownership (part 11, Departure 5). That cutover is the outline's one-time move of
   existing deployments; the baseline origin `"cutover"` of 6.5 is a value
   `app_deployment_baselines.origin` holds today and is no part of it. Items 8 to 10's reading rules
   are the reader parts' (parts 06, 07 and 08; B2 to B6); this part words the manifest rows they flip
   (3.5).
10. **This part adds no Python reader for the HELD-NEW value classes on shared keys** (2.4). Not
    done: one lane reader in `manifest_value_classes.py::VALUE_CLASSES` for each such class. Parity
    between the reader and the lane is part 14's (`14-proof.md`, section 8, B13), on the uses Python
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
12. **Permissions are three codes, and `READ_CIRCUMSTANCES` closes at thirty-five.** Permissions are
    three codes, chosen by the read (8.3): HQ says which permission only through which read it
    refused, and one sentence naming every permission would send a person to ask for ones they hold.
    Not done: one `permissions` code, or a list closed at the codes A2 lands. B1 adds seven
    circumstances part 05 found by classifying
    every failed answer (an edge's refusal, a paused API, a browser page, a remote app, the
    organization's four gates, an app HQ cannot summarize, a table whose rows HQ cannot send), each an
    answer none of the listed codes words truthfully. Stack B's later pull requests add eight more,
    each a fact the part that found it could give no existing code and no manifest entry (8.3): one
    in B2, six in B9 and one in B10. The list stays closed; it is longer: 20 codes in
    A2, 27 after B1, 28 after B2, 34 after B9, 35 after B10.
13. **From `targetOverlay.ts::projectProfileForTarget` as it stands, which seeds each of the fifteen
    settings wherever the target holds no value.** On a deployment
    whose app Nova brought in, a publish seeds none of the fifteen (7.3). Evidence: the seed turns an
    absent setting into a forced one, which resets a worker's own choice on the phone at every update
    (`appProfileSettings.ts`), and `Application.create_profile` writes nothing for an absent key. That
    is a change to what a runtime reads, which the bar's clause (b) admits only declared, and this
    plan reads the original's behavior exactly wherever it can before it declares a change (part 09,
    section 11.4, gives the three answers; part 07, Departure 7, takes the first wherever it is
    open). Leaving the key absent is exact and needs no register entry. The same reasoning gives a
    language's display name its rule on an adopted deployment (7.2).
14. **Every sentence part 04's entries need lands in A9, with the entry.** Part 04's subjects are slugs
    of the closed set (2.2's table), and each sentence a new pair needs lands in A9 with the entry.
    Not done: a new subject for each noun part 04's entries are about, or a sentence left for stack
    B's copy to add.
    Evidence: the completeness test A2 lands (section 10) fails a pull request that adds an entry
    whose pair has no sentence, so the copy cannot wait for stack B; and nine of its ten nouns are
    subjects that already exist, so one new subject (`case-types`) is added, not ten.
15. **`TargetFacts` holds no origin, and the kept list has one lead** (6.1, 6.5, 9.4). Not done: a
    `TargetFacts.origin` that gains `read` in B8, with a lead sentence per origin.
    Evidence: a refresh keeps a baseline's origin and moves
    its date, so "when Nova last published here on {date}" and "when Nova brought the app in on
    {date}" would each name a day that may be a refresh's. The one lead words the date without an
    origin ("as it held them on {date}", 9.4). What B8 does instead is in "What this part needs of
    other parts".

---

## Files by pull request

**A2: manifest schema and the emission-side re-cuts**

| File | Change |
|---|---|
| `lib/publish/hqFindings.ts` | new: `READ_STANDINGS`, `ReadStanding`, `FindingStanding`, `FIX_CAUSES`, `FixCause`, `SUBJECTS`, `Subject`, `STEP_7_GROUPS`, `Step7Group`, `HqPlace`, `HqAppClaimDetail`, `FindingDetail`, `Finding`, `ManifestFinding`, `CircumstanceFinding`, `findingSchema`, `READ_CIRCUMSTANCES`, `ReadCircumstance`, `CIRCUMSTANCE_STANDINGS` (8.3's table as data, its twenty A2 rows), `StopCircumstance` |
| `lib/commcare/surface/standing.ts` | new: `NEVER_REASON_KINDS`, `FIX_IN_HQ_REASON_KINDS`, `standingOf`, `fixCauseOf` |
| `lib/commcare/surface/schema.ts` | `subjectSchema`; `subject` on the HELD-NEW and REFUSED arms and `owner` on the HELD-NEW arm, each required with the message of 2.6; the TARGET-OWNED arm split from INERT and given `heldPlatformsSchema` |
| `lib/commcare/surface/entries/*.json` | `subject` on 587 entries and `owner` on 238 (Appendix A.1 and A.2, and A2's own `application-and-settings/build-profiles-non-empty`); three value classes (2.4); the entries of 3.1, 3.2, 3.7; the re-wordings of 3.3 (the `xmlns` entry's among them) and 3.4 |
| `docs/research/2026-09-26-hq-round-trip/inventory/menus-and-case-lists.md`, `application-and-settings.md`, `case-search.md`, `forms-and-case-writes.md`, `questions.md`, `expressions-and-data.md` | the rows of 3.1 to 3.4 and 3.7, and the three rows that gain a value class in 2.4 (`groups` in `expressions-and-data.md`, the two datum rows in `forms-and-case-writes.md`), each re-worded to say which values the class takes. `subject` and `owner` move no row: the inventory has no column for either (section 11) |
| `lib/publish/hqFindingCopy.ts` | new: 9.1 to 9.3 (`FINDING_LABELS`, `FINDING_NEXT_STEPS`, `SUBJECT_LABELS`, `FINDING_COPY`, `FIX_IN_HQ_STEMS`, `FIX_CAUSE_CLAUSES`, `FIX_IN_HQ_SENTENCES`, `fixInHqSentence`, `CIRCUMSTANCE_COPY`, `alreadyInNovaNext`, `placeLine`, `findingLine`) |
| `lib/commcare/surface/__tests__/manifest.test.ts` (changed), `standing.test.ts` (new); `lib/publish/__tests__/hqFindings.test.ts`, `hqFindingCopy.test.ts` (both new) | section 10 |
| `lib/commcare/CLAUDE.md` | section 11 |

**A3: kept at CommCare HQ's value**

| File | Change |
|---|---|
| `lib/commcare/surface/keptAtHq.ts` | new: section 5 |
| `lib/commcare/surface/entries/application-and-settings.json`, `forms-and-case-writes.json` | the flips of 3.6, and the re-wording of `32-features-credentials` |
| `lib/publish/hqFindingCopy.ts` | `app-settings` and `app-logos` lose their `not-yet` sentences, whose last entries flip here (2.6) |
| `lib/commcare/surface/platformFeatureEntries.ts`, `lib/preview/__tests__/platformCells.ts` | thirteen rows leave each |
| `lib/commcare/targetFacts.ts` | new: `TargetFacts`, `KEPT_PROFILE_PROPERTY_KEYS`, `targetFactsFromSource`, `hqProfileValueText` (6.1) |
| `lib/commcare/appStringKeys.ts` | `isRuntimeUiStringKey` |
| `lib/deployment/targetFacts.ts` | new: `targetFactsFromBaseline`, `keptListFor`, `keptAdvisoryFacts` (6.1) |
| `lib/deployment/store.ts` | `readTargetFacts`, `verifiedBaselineSource`, `recordRefreshedAppBaseline` |
| `lib/deployment/types.ts` | `AppBaselineWrite.origin` admits `"cutover"` (6.5) |
| `lib/deployment/downloadTarget.ts`, `lib/export/localArchive.ts` | `targetFacts` carried to the compiler |
| `lib/commcare/keptProfile.ts` | new: `targetProfileProperties` |
| `lib/commcare/compiler.ts`, `lib/commcare/runtimeTarget.ts` | 6.3 |
| `app/api/compile/route.ts`, `app/api/compile/json/route.ts`, `app/api/compile/prepareCompileRequest.ts`, `lib/mcp/tools/compileApp.ts`, `proof/corpus/publish.ts` | pass the facts and the kept advisories; the JSON route passes `null` for `exportAdvisories`' new parameter |
| `lib/publish/exportAdvisories.ts`, `lib/publish/keptValues.ts` (new) | 9.4, 9.5 |
| `lib/preview/listFilterMatch.ts` (new), `lib/preview/platform.ts` (the rule `listFilter`), `components/preview/shared/listFilter.tsx`, `components/preview/screens/CaseListScreen.tsx` | 6.4 |
| `lib/deployment/previewTarget.ts`, `previewSpace.ts`, `lib/collab/previewTargetFactsFrame.ts` (new), `lib/collab/ReconcilerProvider.tsx`, `lib/collab/context.ts`, `components/builder/DeploymentTargetProvider.tsx`, `components/builder/BuilderProvider.tsx`, `app/(app)/build/[id]/[[...path]]/page.tsx`, `app/api/apps/[id]/stream/route.ts` | the Preview channel |
| `lib/deployment/service.ts`, `actions.ts`, `app/api/commcare/upload/route.ts`, `components/builder/publishOutcome.ts`, `PublishDialogBody.tsx`, `DeploymentStatus.tsx`, `app-setup/PublishingSection.tsx` | the kept list and the refresh (6.5; `app-setup/publishingSectionModel.ts` does not change) |
| `lib/mcp/tools/deploymentTools.ts`, `deploymentProjection.ts` | 9.6 |
| the tests of section 10, `lib/publish/__tests__/keptValues.test.ts` among the new ones; `e2e/tests/app/preview-kept.spec.ts`; `e2e/lib/keptBaselineSeed.ts` | section 10 |
| the docs of section 11, `docs/architecture/contracts.md` among them; `content/docs/*.mdx` | sections 9.7 and 11 |
| the inventory rows of 3.6 | `application-and-settings.md` |

**B1 (the circumstance lines only):** the seven codes of 8.3 in `READ_CIRCUMSTANCES` and
`CIRCUMSTANCE_STANDINGS`, and their blocks (9.3) in `CIRCUMSTANCE_COPY`. Part 05 lists the files.

**B2 (the manifest and copy lines only; part 06 lists the files):** the three entries and the
re-wording of 7.1 in `entries/application-and-settings.json` with their inventory rows;
`translation-overrides` in `SUBJECTS`, `SUBJECT_LABELS` and `FINDING_COPY`; in
`lib/publish/hqFindings.ts`, `no-platform-runs-everything` in `READ_CIRCUMSTANCES` and
`CIRCUMSTANCE_STANDINGS` (8.3); in `lib/publish/hqFindingCopy.ts`, its block and its second next
step (9.3), `circumstanceNext` (8.4), `ACCOUNT_CHECK_AGAIN_LINE` (9.1) and the `not-yet` sentence of
`language-codes` (9.2); the "From B2" cases of `lib/publish/__tests__/hqFindingCopy.test.ts`.

**B3, B4, B5, B6 (the copy lines only; parts 06, 07 and 08 list the files):** in
`lib/publish/hqFindingCopy.ts`, the `not-yet` sentences of 9.2's second table, each in the pull
request it names, the re-worded `repeats` sentence in B3 among them; in `lib/publish/hqFindings.ts`,
`advanced-menus` (B4) and `list-and-search-filters` (B5) in `SUBJECTS`, with their labels in
`SUBJECT_LABELS`. Each lands with the manifest entry that first gives its pair (Appendix A.1's
closing block).

**B9 (the circumstance lines only; part 11 lists the files):** the six codes of 8.3 marked B9 in
`READ_CIRCUMSTANCES` and `CIRCUMSTANCE_STANDINGS`, and their blocks (9.3) in `CIRCUMSTANCE_COPY`.

**B10 (the circumstance lines only; part 12 lists the files):** `could-not-create` in
`READ_CIRCUMSTANCES`, `CIRCUMSTANCE_STANDINGS` and `CIRCUMSTANCE_COPY`; `too-large`'s new body (9.3);
`findingLine`'s `named: null` for `could-not-create` (8.4), with its case in `hqFindingCopy.test.ts`.

**B8 (written here, listed by part 10):** 7.2 and 7.3: `lib/commcare/targetOverlay.ts` (the two
options), `lib/deployment/importApplication.ts`, `hqSourceBaseline.ts::ownedTranslations`,
`lib/commcare/targetFacts.ts` (`languageNames`, `seeds`, the `adopted` input),
`lib/deployment/targetFacts.ts` and `store.ts::readTargetFacts` (the mapping's ownership),
`lib/commcare/keptProfile.ts`, `compiler.ts`, `lib/publish/exportAdvisories.ts` and `keptValues.ts`
(the fourth advisory, the label `language-names`), the fiftieth `KEPT_AT_HQ` row, the sixteen entry
cells of 7.2 and 7.3, `lib/publish/hqFindings.ts` and `hqFindingCopy.ts` (`language-display-names`
leaves `SUBJECTS`, `SUBJECT_LABELS` and `FINDING_COPY`), `lib/commcare/reader/appShell.ts`, the
application walker that makes the claims of part 06's section 6.5 (the language display name's second
claim becomes `account`), with its case in `reader/__tests__/appShell.test.ts`, and the contract
lines of section 11 marked B8. `publishAppToHq` computes `seeds` beside `languageNames` and hands both
to `hqImportApplication` on `HqImportApplicationInput`, as part 10 writes it (its section 6.3).

**B14:** the last paragraph of 9.7 in `content/docs/publishing.mdx` (section 11).

**B12:** the sentence the `upload_to_hq` skill gains in `../nova-plugin` (section 11).

**Named for other pull requests, written here:** the entry edits of 3.5 (B3, B4, B5, B9); the
subjects and sentences of 2.2's table (A5, A9); the sentence removals of 2.6 (A4); the subject and
the owner or standing of every entry a later pull request adds (the closing blocks of Appendix A.1
and A.2: A5, A9, B2 to B6, B9).

---

## What this part needs of other parts

Each need says what that part does, as it states it; part 15's is what this part hands the stack
and the step 7 rewrite.

- **Part 06 (`06-the-reader-forms.md`, B2, B3).** Each claim names one entry id (its section 4.2), and
  the reader's index gives a finding its `standing`, `cause`, `subject` and `owner` through
  `standingOf`, `fixCauseOf` and the entry's own fields (its sections 3 and 5.1). The classifier of
  7.1 lands in B2 as written (its section 16.5) and takes `D0`'s app strings as a reader input,
  `ReaderInput.appStrings`; the production function, `lib/commcare/appStrings.ts::localAppStringTable`,
  is part 09's and lands in B7 (its section 15.1), since the strings are locals of `compileCcz` whose
  inputs a reading first has at acceptance. `detail.name` is set as 8.3's table and 9.2's sentences
  assume (the appearance string, the setting's name, the key, the path), at most 200 characters. B2
  raises `no-platform-runs-everything` with `detail.reason: "split-refused"` where the split is
  refused (its section 16.3) and lands that code, its block, `circumstanceNext`,
  `ACCOUNT_CHECK_AGAIN_LINE` and the `not-yet` sentence of `language-codes`; B3 lands the `not-yet`
  sentences of `form-source` and `question-ids` (9.2). B3 also lands the re-worded `not-yet` sentence
  of `repeats` (9.2's second table), a fourth copy line, its C2c: its section 10.4 gives its model
  iteration entry that subject, and A2's sentence is true of button captions alone.
  Its application walker's claim for a language's display name is changed by B8 (Files, B8).
- **Part 05 (`05-reading-commcare-hq.md`, B1).** It adds its seven circumstances with the standings of
  8.3 and the blocks of 9.3, and B1's
  `lib/commcare/hq/failure.ts::hqReadCircumstance(failure: HqFailure): ReadCircumstance` holds 8.3's
  names, which its section 4.3 uses. Its section 4.3 is what answers which permission code each
  read reports, and its section 3 the retry after which `rate-limited` is raised. Its two requests of
  this part are met: `linked-app` is the source's `doc_type` `LinkedApplication` alone, and
  `menu-unreadable-in-hq` carries no `detail.name`. Its runs G2 and G7 decide whether `remote-app` and
  `table-rows-unreadable` land (8.3). From B1, `refreshKeptValues` chooses its three failure outcomes
  by `classifyHqFailure` (6.5).
- **Part 02 (`02-menus.md`, A4, A5).** A4 removes `display-only-forms`' `not-yet` sentence from
  `FINDING_COPY` with the flip that empties the pair (2.6). A5's eight HELD-NEW entries and its new
  REFUSED one take the subject `case-list-registration` (2.2), as its section 14 writes. The rows
  it names for B4 and B5 are landed by part 07 (Appendix A.1 and A.2, the closing blocks).
- **Part 03 (`03-questions-and-text.md`, A6 to A8).** The entry edits 3.5 lists for A6, A7 and A8,
  and the removal of `subject` and `owner` with each flip. Its two new entries land in B3 and B5
  (2.2).
- **Part 04 (`04-names.md`, A9).** Every `widen` on a HELD row but the sixteen of 3.6 and the `xmlns`
  row A2 takes (3.3), each built or split. Its new entries N1 to N24 take the subjects of 2.2's table,
  and A9 adds `case-types` to `SUBJECTS` with its label and lands every sentence that table names,
  re-wordings included, in the pull request that adds the entries. No sentence of its entries waits
  for stack B (Departure 14).
- **Part 07 (`07-the-reader-cases-menus-lists.md`, B4, B5).** The entry edits of 3.5 for B4 and B5
  and the entries of its section 14 (Appendix A). B4 adds `advanced-menus` to `SUBJECTS` with its
  label and lands the four `not-yet` sentences 9.2 marks B4; B5 adds `list-and-search-filters` and
  its sentence. It adds the row `dormant-tile-cells` to part 06's `READER_CANONICAL_CHOICES` in B5
  (its section 11.5), which is what 3.2 names.
- **Part 08 (`08-the-reader-expressions.md`, B6).** Its binder claims the ten pairs of 3.4, the four
  search pairs among them, and sets `detail.reason` to the checker's reason. B6 lands the `not-yet`
  sentence of `expressions` with its entry M3 (9.2).
- **Part 10 (`10-identity-and-the-ledger.md`, B8).** The `adopted` mapping, from which
  `publishAppToHq` computes `languageNames` and `seeds` once and hands both to its three
  `hqImportApplication` calls on `HqImportApplicationInput` (its section 6.3; 7.2 and 7.3 here); the
  `read` origin in the baseline's CHECK, in `readAppBaseline` and in `AppBaselineWrite.origin`.
  `TargetFacts` holds no origin (Departure 15): `targetFactsFromBaseline` projects a `read` baseline
  as it does a `push` one, and the one lead of 9.4 serves it, so B8 adds no origin to `TargetFacts`.
  Its drift wording dates "brought it in" from the mapping's `adoptedAt` and never from the
  baseline's `observedAt` (its section 9), which is what a refresh needs of it.
  `recordRefreshedAppBaseline` is the baseline write its `expectedEndings` rule names (its section
  8.5), and `refreshKeptValues` answers `no-baseline` for a deployment with no live `app` mapping,
  as it asks (its section 8.6). Its `HqAppClaimView` is `HqAppClaimDetail` (8.1) with `remoteAppId`,
  and the four lines under its picker's `elsewhere` marks are `alreadyInNovaNext`'s (9.3): its
  `lib/publish/hqAppClaims.ts` exports the row labels and no line.
- **Part 11 (`11-project-data.md`, B9).** The split of
  `expressions-and-data/a-media-reference-on-a-slot-nova-holds-with-no-multimedia-map` and the flip of
  `media-path-jr-file`, as 3.5 gives them from its section 13.1; that `media-file-unreadable` is
  raised only for a path HQ's media map holds an entry for (8.3); and the six circumstances of its
  section 13.2, which B9 adds to `READ_CIRCUMSTANCES`, `CIRCUMSTANCE_STANDINGS` and
  `CIRCUMSTANCE_COPY` with the rows of 8.3 and the blocks of 9.3. When a table asks a person's
  choice is its section 7.1.
- **Part 09 (`09-acceptance-and-the-first-publish.md`, B7).** Five register entries of its
  `FIRST_PUBLISH_CHANGES` (its section 11.2) that this part found: `connect-app-captures-location`
  (4.3), `logo-path-only-entry-removed` (4.3), `translation-overrides-folded` (7.1),
  `search-filter-rows-recut` (3.5) and `marked-as-updated-from-a-file`, the change of
  `created_from_template` (4.1). The fifteen settings need none: an adopted deployment is not seeded
  (7.3), and proof 1 on the base `hq-new-app` holds that no difference of `profile` appears (Run 3).
  It raises `read-back-differs` with the `detail.name` values 8.3 lists (its section 14).
- **Part 12 (`12-the-reading-and-the-birth.md`, B10).** Its row stores findings parsed by
  `findingSchema` (its section 2.3). It raises `table-differs-in-project` at a creation that leaves a
  choice unanswered, answered `held`, and `could-not-create` at the birth, and widens `too-large`
  (its sections 3.6, 3.8 and 6.5); B10 lands those lines here (Files, B10). Its read step fills the
  review's kept list from `keptListFor(targetFactsFromSource(source))` on the reading's own source,
  before any baseline exists (its section 5.1).
- **Part 14 (`14-proof.md`, A1, B13).** The bases `hq-new-app`, `hq-kept-settings` and
  `starter-health` under those ids (its section 6.2), with `hq-kept-settings` declaring both platforms
  and holding every labelled `setting` row of section 5 but the custom base URL at a value other than
  its default, the credential level among them, and `hq-new-app` holding none of the fifteen settings;
  the exemption of `36-hq-custom-base-url`, whose row holds `base: null` (its section 7.5); Run 1's
  targeted document `targeted-kept-values` in A3, which stays beside the base; Run 2's native vectors;
  Run 3 inside P2 (B13), judging B8's code. Proof 2 on every HQ-authored base holds the precondition
  of 7.1's classifier: per language, the app-string ids matching a generated pattern that HQ's build
  writes equal the ones the local archive writes. Its `proof/matrix/exemptions.json` names the four
  `doc_type` entries of 8.3 with the note given there.
- **Part 13 (`13-the-experience.md`, B11, B12).** The account's and the review's layout, which render
  `FINDING_LABELS`, `FINDING_NEXT_STEPS`, `placeLine`, `findingLine`, `circumstanceNext` and
  `ACCOUNT_CHECK_AGAIN_LINE`, and the kept list of 9.4 in the review (its section 8.7), worded through
  `keptLead`, `KEPT_LABELS` and `KEPT_FOLLOWS_LINE`. Its `STOP_ACTIONS` is total over
  `StopCircumstance` (its section 6.2). The picker's lines and `already-in-nova`'s next step are
  written here (9.3); B11 places them. B12's `read_hq_app` returns `findingSchema` findings, the
  account's sentences and `check_again`, and B12 adds the skill's sentence of section 11 with its
  sweep of `upload_to_hq`.
- **Part 15 (`15-stack-contracts-and-exit.md`; A10, A11, B14, B15).** B14 lands 9.7's last paragraph in
  `content/docs/publishing.mdx`. The step 7 rewrite takes the owners of Appendix A.1, its closing
  block included. A2's issue of 3.7 and A3's issue of 6.4 are on the stack's checklist (its section
  3, rule 12).

## What other parts read from this one

| Name | Where | Who reads it |
|---|---|---|
| `standingOf`, `fixCauseOf`, `NEVER_REASON_KINDS`, `FIX_IN_HQ_REASON_KINDS` | `lib/commcare/surface/standing.ts` | part 06 (the reader's index, B2), part 14 (the parity judge, B13) |
| `READ_STANDINGS`, `ReadStanding`, `FindingStanding`, `FIX_CAUSES`, `FixCause`, `SUBJECTS`, `Subject`, `STEP_7_GROUPS`, `Step7Group` | `lib/publish/hqFindings.ts` | every part that adds an entry (parts 02, 04, 06, 07, 08 and 11); part 12's census (counts by owner, its section 8, B10) |
| `Finding`, `ManifestFinding` (with `cause`), `CircumstanceFinding`, `HqPlace`, `FindingDetail` (`name`, `reason`, `claim`), `HqAppClaimDetail`, `findingSchema`, `READ_CIRCUMSTANCES`, `ReadCircumstance`, `CIRCUMSTANCE_STANDINGS`, `StopCircumstance` | `lib/publish/hqFindings.ts` | part 06 (the reader, B2), part 12 (the reading's row, B10), part 13 (the account and its stop actions in B11, `read_hq_app` in B12); part 05 (`ReadCircumstance`, to which B1 adds seven members); part 10 (`HqAppClaimDetail`, which its `HqAppClaimView` extends) |
| the circumstance codes: 20 codes in A2, 27 after B1, 28 after B2, 34 after B9, 35 after B10. Twenty in A2 (`not-connected`, `key-not-accepted`, `plan-lacks-api-access`, `not-a-member`, `cannot-edit-apps`, `cannot-access-apis`, `app-gone`, `app-deleted`, `linked-app`, `rate-limited`, `hq-unavailable`, `changed-while-reading`, `already-in-nova`, `too-large`, `menu-unreadable-in-hq`, `shadow-disagrees`, `table-differs-in-project`, `media-file-unreadable`, `unrecognized`, `read-back-differs`), seven in B1 (`hq-gateway-refused`, `api-cut-off`, `browser-only`, `remote-app`, `cannot-read-organization`, `app-unreadable-in-hq`, `table-rows-unreadable`), one in B2 (`no-platform-runs-everything`), six in B9 (`places-over-nova-limit`, `place-not-holdable`, `media-not-played-where-app-runs`, `table-cell-unrepresentable`, `owner-rule-needs-one-place`, `table-choices-unusable`) and one in B10 (`could-not-create`) | `READ_CIRCUMSTANCES` | parts 05, 09, 11, 12 and 13 |
| `FINDING_LABELS`, `FINDING_NEXT_STEPS`, `SUBJECT_LABELS`, `FINDING_COPY` (`not-yet` and `never`), `FIX_IN_HQ_STEMS`, `FIX_CAUSE_CLAUSES`, `FIX_IN_HQ_SENTENCES`, `fixInHqSentence`, `CIRCUMSTANCE_COPY`, `alreadyInNovaNext`, `placeLine`, `findingLine`; from B2 `circumstanceNext` and `ACCOUNT_CHECK_AGAIN_LINE` | `lib/publish/hqFindingCopy.ts` | part 13 (the account UI in B11, MCP in B12); every part that adds an entry (a `not-yet` or `never` pair needs a sentence, a `fix-in-hq` subject a stem or a whole sentence); the picker's marks of part 10, placed by part 13 (`alreadyInNovaNext`) |
| the subjects other parts' entries take: `case-list-registration` (part 02), and for part 04 `case-types` (new in A9), `case-property-names`, `search-fields`, `lookup-tables`, `question-choices`, `menu-structure`, `parent-selection`, `case-list-setup`, `case-list-columns`, `connect-blocks`, `question-logic`, `question-text`, `question-media`; for part 07 the two new subjects `advanced-menus` (B4) and `list-and-search-filters` (B5); and the subject of every entry of the closing blocks of Appendix A.1 and A.2 | 2.2's table, Appendix A | parts 02, 04, 06, 07, 08 and 11 |
| `KEPT_AT_HQ`, `KeptRow` (its `label` a `KeptLabelId`) and its cell types | `lib/commcare/surface/keptAtHq.ts` | part 12's review (the kept list, through `keptListFor`), part 14 (each row's `base`, `string \| null`, held by its `entryCoverage.test.ts`) |
| `TargetFacts` (no `origin`; `credentialLevel`; from B8 `languageNames` and `seeds`), `targetFactsFromSource`, `KEPT_PROFILE_PROPERTY_KEYS`, `KeptProfilePropertyKey`, `hqProfileValueText` | `lib/commcare/targetFacts.ts` | the emitter; part 12's read step, which calls `targetFactsFromSource` on the reading's own source before any baseline exists (its section 5.1); B8 |
| `isRuntimeUiStringKey` | `lib/commcare/appStringKeys.ts` | part 06 (4.4's kept and inert key classes, its section 6.5, B2) |
| `targetFactsFromBaseline`, `keptListFor`, `keptAdvisoryFacts` | `lib/deployment/targetFacts.ts` | part 12's review (`keptListFor`), B8, the lane's capture (part 14) |
| `KEPT_LABEL_IDS`, `KeptLabelId`, `KEPT_LABELS`, `keptLead`, `KEPT_FOLLOWS_LINE`, `KeptRefreshKind`, `keptRefreshSentence` | `lib/publish/keptValues.ts` | the Publishing card, part 13's review (its section 8.7), MCP |
| `readTargetFacts`, `recordRefreshedAppBaseline`, `refreshKeptValues`, `KeptRefreshOutcome`, `previewTargetFactsFor`, `resolvePreviewFactsTarget` | `lib/deployment/store.ts`, `service.ts`, `previewSpace.ts`, `previewTarget.ts` | part 13 (B11); part 10 (the ended-deployment rule over the refresh's write, its sections 8.5 and 8.6, B8) |
| `targetProfileProperties`; `profileServerProperties(target, facts)` | `lib/commcare/keptProfile.ts`, `runtimeTarget.ts` | the lane's capture (`proof/corpus/publish.ts`; part 14) |
| the overlay options `languageNames` and `seeds`, each `"nova" \| "target"` | `lib/commcare/targetOverlay.ts::projectApplicationForTarget`, from B8 | part 10 (`publishAppToHq` computes `HqImportApplicationInput.languageNames` and `.seeds`, `"target"` for an adopted mapping, and `hqImportApplication` passes both on; its section 6.3) |
| `rowsMatchingFilterText`, `rowFilterScore`, `filterTerms`, `normalizeForFilter`, `fuzzyMatch`; the platform rule `listFilter` | `components/preview/shared/listFilter.tsx`, `lib/preview/listFilterMatch.ts`, `lib/preview/platform.ts` | none outside this part |
| the frame `preview-target-facts`, `PreviewTargetFacts`, `useDeploymentTargetFacts` | `lib/collab/previewTargetFactsFrame.ts`, `components/builder/DeploymentTargetProvider.tsx` | part 13, where a landed adoption seeds the builder (B11) |
| the advisory ids `kept_ui_text_falls_back`, `kept_android_logos_absent`, `kept_practice_worker_absent`, `kept_language_names_differ`; `KeptExportAdvisoryId` | `lib/publish/exportAdvisories.ts` | B8 (the fourth) |
| entry ids added: `menus-and-case-lists/case-tile-field-blank-or-off-a-template-tile`, `menus-and-case-lists/tile-cell-keys-on-a-list-that-is-not-a-tile`, `application-and-settings/build-profiles-non-empty`, `application-and-settings/45p-hq-auto-gps-capture-on-an-app-that-is-not-a-connect-app`, `application-and-settings/translations-generated-key-with-no-effect`, `application-and-settings/translations-generated-key-over-one-text`, `application-and-settings/translations-generated-key-anything-else` | the manifest | the reader's claims (part 06), the variants' `expected.json` (part 14) |
| the base ids `hq-new-app`, `hq-kept-settings`, `starter-health`; the canonicalization `dormant-tile-cells`; the register entries `connect-app-captures-location`, `logo-path-only-entry-removed`, `translation-overrides-folded`, `search-filter-rows-recut`, `marked-as-updated-from-a-file` | named here. The bases are part 14's (B13). `dormant-tile-cells` is a row of `READER_CANONICAL_CHOICES` part 07 adds in B5, proven by part 09's `canon.test.ts`. The register entries are part 09's (B7) | parts 14, 07 and 09 |

---

## Appendix A: `subject` and `owner`, entry by entry (A2)

Slugs are entry ids without their area, which each block's heading gives. An entry of A.1 marked with
a pull request in parentheses leaves HELD-NEW there (3.8), and an entry of A.2 so marked leaves REFUSED
there (3.6, and the re-cuts A.3 lists). The area blocks of A.1 and A.2 were produced by one script
over the manifest at `15a00a97` and cover every HELD-NEW entry (237) and every REFUSED entry (349); A2
corrects four `questions/` entries about Hidden Values the script had filed under a search subject,
which now follow the manifest's own section (Question types) and 2.3. The manifest test's rules of 2.6
fail on any entry the lists miss.

Each list ends with a closing block, "Joining, by pull request": the entries that become HELD-NEW or
REFUSED after the script ran, each written with its area, under the subject and the owner or
standing the part that plans it gives it. Those entries are not among the 237 and the 349, and the
counts by owner under A.1's area blocks leave them out. A.3 counts, by pull request, what joins and
what leaves, and names the new entries that carry neither field.

### A.1 Every HELD-NEW entry: subject and owner

**`application-and-settings/`** (11)

- `android-app-dependencies` → `settings-nova-comes-to-own`: `31-features-dependencies`
- `app-logos` → `settings-nova-comes-to-own`: `logo-refs-hq-logo-android-home-login-demo` (A3)
- `app-settings` → `settings-nova-comes-to-own`:
  `translations-key-in-a-runtime-s-ui-string-catalog-core-android` (A3),
  `translations-catalog-key-hq-fills-with-its-own-text-in-a` (A3),
  `24-properties-cc-log-entity-detail-enabled` (A3), `51-hq-persistent-menu` (A3),
  `52-hq-show-breadcrumbs` (A3)
- `case-sharing` → `settings-nova-comes-to-own`: `39-hq-case-sharing`
- `language-display-names` → `settings-nova-comes-to-own`:
  `translations-lang-code-any-other-value-or-absent-where-hq-s` (B8)
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
  (A5), `case-list-form-pointing-at-a-follow-up-form-of-the-parent-case`,
  `case-list-form-relevancy-expression-with-followup-forms-as-case`,
  `case-list-form-media-image-media-audio` (A5)
- `case-list-sorting` → `case-list-and-detail`:
  `type-int-or-double-differing-from-the-derived-type-on-a-column`, `type-distance`, `blanks-first-last`
  (A8), `display-lang-sort-by-label-on-a-sort-only-element`,
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
- `display-only-forms` → `menus`: `put-in-root-display-only-forms` (A4)
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

- `deep-links` → `case-search`: `case-search-endpoint-id`
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
  `hidden-on-a-prompt-that-carries-an-itemset-input-type-or`, `several-xpath-query-rows` (B5)
- `search-expressions` → `case-search`: `date-only-comparison-on-date-opened-closed-on-last-modified`
- `search-fields` → `case-search`: `appearance-address-geocoder-broadcast-emitted-input-address`,
  `input-checkbox-itemset`, `itemset-nodeset-filter-predicate-outside-predicate`,
  `default-value-outside-valueexpression`, `allow-blank-value`, `receiver-expression`,
  `is-group-group-key`
- `search-fields` → `project-data-at-hq-size`:
  `itemset-refs-to-item-attributes-attr-or-property-qualified`
- `search-setup` → `case-search`: `custom-sort-properties-property-name-sort-type-exact-date`,
  `search-button-display-condition-outside-predicate`, `title-label-or-blank-hq-s-default` (A8),
  `instance-name-without-casedb-ledgerdb-fixture-or-session-in-it`, `additional-case-types`,
  `custom-related-case-property`, `include-all-related-cases-false-where-nova-s-relation-reads`,
  `include-all-related-cases-authored-without-relation-reads`, `search-on-clear`

**`forms-and-case-writes/`** (26)

- `advanced-forms` → `forms-and-case-management`: `auto-select-mode-raw-value-key`,
  `auto-select-mode-user`, `auto-select-mode-fixture`, `auto-select-mode-case-index-of-an-earlier-load`,
  `caseindex-relationship-question-relationship-question-the-index-naming-a`,
  `arbitrary-datums-datum-id-datum-function`
- `case-preloads` → `forms-and-case-management`:
  `case-preload-from-any-other-index-path-host-user-a-mixed-path`,
  `loadupdateaction-preload-question-property` (B4),
  `an-advanced-load-s-update-or-preload-or-an-open-action-s-name-or`
- `deep-links` → `menus`: `function-datum-endpoints`
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
  `update-through-the-date-and-time-join-of-a-date-and-a-time` (B4), `writers-int-decimal`,
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
  `intent-id-on-any-input-other-than-an-intent-typed-one-where-id`, `barcode-quick`, `date-ethiopian`,
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
- `question-choices` → `project-data-at-hq-size`: `itemset-refs-to-attr-or-property-qualified-fields`
- `question-choices` → `xform`: `itemset-sort-ref`, `itemset-filter-outside-predicate`,
  `itemset-over-casedb-or-another-instance-advanced-data-source`
- `question-media` → `question-display`: `long-form`, `label-video-inline`, `label-qrcode`, `label-tts`
- `question-text` → `xform`: `vellum-ignore-containing-markdown-on-h-html-vellum-s-disable` (A8),
  `output-value-any-other-expression` (A7),
  `a-question-text-label-hint-help-validation-message-repeat-add`,
  `a-question-text-whose-itext-id-is-pragma-form-descriptor-where`
- `question-types` → `xform`: `phone-number-xsd-string-appearance-numeric` (A6),
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
  `an-imported-asset-larger-than-nova-s-per-kind-cap-or-an-app`, `media-path-jr-file` (B9),
  `a-media-reference-on-a-slot-nova-holds-with-no-multimedia-map` (B9)

Counts by owner: `case-list-and-detail` 56, `case-search` 30, `forms-and-case-management` 23,
`menus` 15, `project-data-at-hq-size` 12, `question-display` 63, `settings-nova-comes-to-own` 14,
`xform` 24.

**Joining, by pull request**

Each entry below becomes HELD-NEW in the pull request named and gains both fields there. The part
and section in each heading write the entry's other fields. An entry marked "re-cut" exists today
under another disposition.

A2 (this part, 3.7; one entry):

- `build-profiles` → `settings-nova-comes-to-own`: `application-and-settings/build-profiles-non-empty`

A5 (part 02, `02-menus.md`, section 14; six entries):

- `case-list-registration` → `menus`:
  `menus-and-case-lists/case-list-form-post-form-workflow-default-on-the-hidden-module-shape`,
  `menus-and-case-lists/case-list-form-label-empty`,
  `menus-and-case-lists/case-list-form-on-an-advanced-module-or-naming-an-advanced-form`,
  `menus-and-case-lists/case-list-form-pointing-at-a-form-whose-one-registration-of-the-type-is-a-child-case`,
  `menus-and-case-lists/case-list-form-naming-a-form-another-list-offers-after-an-empty-search`,
  `menus-and-case-lists/case-list-form-on-a-host-under-a-menu-that-shares-the-first-menu-s-case`
  (not added under part 02's run G6, outcome B)

A9 (part 04, `04-names.md`, section 11.2, N2 to N24; twenty-three entries):

- `case-property-names` → `forms-and-case-management`:
  `forms-and-case-writes/update-keys-location-id-hq-user-id`,
  `forms-and-case-writes/update-key-holding-a-non-ascii-core-name-character`
- `search-fields` → `case-search`: `case-search/prompt-key-outside-nova-s-name-grammar`,
  `case-search/default-value-on-a-date-range-input`
- `lookup-tables` → `project-data-at-hq-size`:
  `expressions-and-data/tag-or-field-name-with-non-ascii-letters`,
  `expressions-and-data/tag-equal-to-an-instance-name-commcare-owns`,
  `expressions-and-data/tag-or-field-name-holding-a-period`
- `question-choices` → `xform`:
  `questions/choice-value-holding-both-an-apostrophe-and-a-double-quote`
- `menu-structure` → `menus`:
  `menus-and-case-lists/child-menu-of-another-case-type-under-a-parent-with-no-forms`
- `case-list-setup` → `case-list-and-detail`: `menus-and-case-lists/detail-max-select-value-above-100`
- `case-list-columns` → `case-list-and-detail`:
  `menus-and-case-lists/enum-mappingitem-alt-text-non-blank`,
  `menus-and-case-lists/10-markdown-outside-the-link-shape`,
  `menus-and-case-lists/21-translatable-enum-outside-nova-s-two-projections`
- `parent-selection` → `menus`:
  `menus-and-case-lists/parent-select-naming-a-module-outside-the-declared-parent-type`
- `connect-blocks` → `xform`: `questions/connect-blocks-beyond-one-of-each-kind`,
  `questions/connect-deliver-unit-work-area-id-expression`
- `question-logic` → `xform`: `questions/bind-required-on-a-label`,
  `questions/bind-constraint-on-a-capture-question-or-a-label`,
  `questions/default-on-a-capture-question-or-a-label`
- `question-text` → `xform`: `questions/hint-text-on-a-label`,
  `questions/help-text-on-a-capture-question-or-a-label`,
  `questions/validation-message-on-a-capture-question-or-a-label`
- `question-media` → `xform`: `questions/help-media-on-a-capture-question-or-a-label`

A HELD-NEW entry a fallback row of part 04's run R2 adds is no row here: it takes its subject by
2.2's rule and the owner that row names, in A9.

B2 (this part, 7.1; part 06, `06-the-reader-forms.md`, section 6.3; two entries):

- `translation-overrides` → `settings-nova-comes-to-own`:
  `application-and-settings/translations-generated-key-anything-else`
- `language-codes` → `settings-nova-comes-to-own`:
  `application-and-settings/langs-code-nova-s-language-registry-cannot-name`

B3 (part 06, sections 8.8, 10.4, 11.4, 12.5 and 15; six entries, one a re-cut):

- `form-source` → `xform`: `questions/data-root-element-named-other-than-data`
- `question-ids` → `xform`: `questions/question-id-case-registration-script` (re-cut from HELD)
- `repeats` → `xform`: `questions/model-iteration-repeat-outside-nova-s-model-iteration-rule`
- `question-types` → `xform`: `questions/hidden-value-bound-a-type-nova-would-not-write`
- `question-text` → `question-display`: `questions/a-text-whose-languages-show-different-values`
- `connect-blocks` → `xform`: `questions/connect-learn-and-deliver-blocks-in-one-app`

B4 (part 07, `07-the-reader-cases-menus-lists.md`, section 14; fifteen entries, two of them the rows
part 02 names for B4, one a re-cut):

- `save-to-case` → `xform`: `questions/savetocase-block-outside-nova-s-own-block-shape`,
  `questions/savetocase-link-name-outside-nova-s-identifier-grammar`
- `advanced-forms` → `forms-and-case-management`:
  `forms-and-case-writes/advanced-form-loads-other-than-its-menu-s-one-chain`,
  `forms-and-case-writes/load-changing-no-case-with-a-tag-nova-does-not-derive`,
  `forms-and-case-writes/case-tag-holding-a-hyphen`,
  `forms-and-case-writes/index-identifier-outside-an-xml-element-name`
- `case-preloads` → `forms-and-case-management`:
  `forms-and-case-writes/loadupdateaction-preload-read-later-in-the-load`,
  `forms-and-case-writes/case-preload-into-a-question-that-holds-no-default`,
  `forms-and-case-writes/case-preload-into-a-question-outside-any-repeat-where-the-held` (re-cut from
  REFUSED)
- `form-case-management` → `forms-and-case-management`:
  `forms-and-case-writes/update-mode-edit-off-a-follow-up-form-s-own-update`,
  `forms-and-case-writes/index-path-through-a-case-type-the-app-does-not-fix`
- `advanced-menus` → `forms-and-case-management`:
  `menus-and-case-lists/advanced-module-nova-would-write-as-a-basic-one`
- `menu-settings` → `menus`: `menus-and-case-lists/module-case-list-label-empty`
- `display-only-forms` → `menus`:
  `forms-and-case-writes/post-form-workflow-previous-screen-on-a-form-listed-on-the-first-menu`,
  `forms-and-case-writes/form-link-or-endpoint-through-a-first-menu-that-shares-one-case` (not added
  under part 02's run G6, outcome B)

B5 (part 07, section 14; twelve entries, one the row part 02 names for B5, one the row part 03
names, one a re-cut):

- `search-fields` → `case-search`: `case-search/date-prompt-matched-by-hq-s-own-rule`,
  `case-search/prompt-named-for-a-case-attribute-hq-matches-itself`,
  `case-search/search-field-over-a-property-of-another-type`
- `search-setup` → `case-search`: `case-search/list-first-with-a-search-that-skips-to-results`,
  `case-search/search-on-a-put-in-root-module`, `case-search/title-label-blank-in-some-languages`
- `search-default-filters` → `case-search`:
  `case-search/xpath-query-row-reading-a-field-hq-also-matches`,
  `case-search/xpath-query-row-that-is-neither-a-list-filter-clause-nor-a-search-field-s`
- `list-and-search-filters` → `case-search`:
  `case-search/case-list-filter-clause-the-search-does-not-restate`
- `case-list-columns` → `case-list-and-detail`:
  `menus-and-case-lists/column-field-outside-nova-s-property-grammar`,
  `menus-and-case-lists/6-late-flag-late-flag-1` (re-cut from HELD)
- `case-tiles` → `case-list-and-detail`:
  `menus-and-case-lists/case-tile-group-identifier-outside-an-xml-element-name`

Under part 07's run G2, outcome B, B5 adds a thirteenth:
`case-search/excluded-prompt-no-filter-reads`, `search-fields` → `case-search`.

B6 (part 08, `08-the-reader-expressions.md`, section 11, M3, M4, M6 and M7; four entries):

- `expressions` → `xform`: `expressions-and-data/a-form-expression-outside-what-nova-types`
- `search-expressions` → `case-search`:
  `case-search/a-search-value-that-queries-cases-a-table-or-places`,
  `case-search/required-or-validation-test-outside-what-nova-types`,
  `case-search/xpath-query-condition-outside-what-nova-types`

### A.2 Every REFUSED entry: subject and standing

**`application-and-settings/`** (21)

- `android-app-dependencies`, `fix-in-hq`:
  `profile-properties-or-features-dependencies-value-outside-its`
- `app-document`, `fix-in-hq`: `unknown-doc-type`,
  `an-unknown-top-level-key-naming-an-application-read-only`, `33p-hq-application-version-1-0`,
  `37-hq-profile-url-on-an-application`
- `app-logos`, `fix-in-hq`: `logo-refs-slot-path-other-than-the-uploader-s-jr-file-commcare`
- `app-settings`, `fix-in-hq`: `41p-hq-use-custom-suite-true`,
  `44p-hq-translation-strategy-select-known`,
  `profile-features-sense-true-or-profile-properties-cc-entry-mode`
- `app-settings`, `never`: `2-properties-lazy-load-video-files-true`,
  `48p-hq-target-commcare-flavor-commcare-commcare-lts`
- `commcare-version`, `fix-in-hq`: `34p-hq-build-spec-below-nova-s-floor`
- `custom-assertions`, `never`: `non-empty-custom-assertions-app`
- `custom-device-properties`, `never`: `profile-custom-properties-any-other-entry-incl-formplayer-keys`
- `hierarchical-locations`, `never`: `50pp-hq-location-fixture-restore-only-hierarchical-fixture`
- `language-codes`, `fix-in-hq`: `a-non-empty-langs-code-outside-that-grammar-or-repeated`,
  `langs-containing-an-empty-code`
- `linked-app`, `fix-in-hq`: `doc-type-linkedapplication-downstream-app`,
  `upstream-app-id-upstream-version-linked-app-translations-linked`
- `mobile-reports`, `never`: `49p-hq-mobile-ucr-restore-version-1-0-1-5` (A3)
- `remote-app`, `never`: `doc-type-remoteapp-profile-url-manage-urls-questions-map`

**`menus-and-case-lists/`** (85)

- `app-document`, `fix-in-hq`: `unknown-module-doc-type`
- `app-document`, `never`: `module-unique-id-missing`
- `auto-select`, `fix-in-hq`: `auto-select-case-true-on-a-basic-module-an-advanced-form-s-load`,
  `detail-auto-select-true-on-a-single-select-basic-list`
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
- `case-list-columns`, `never`: `15-address-popup`, `22-graph`, `indicator-call-center-name`
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
  `any-other-module-under-a-shadow-menu`,
  `module-or-mirror-form-endpoint-id-that-is-not-a-slugify-fixed`,
  `two-endpoints-sharing-an-id-module-case-list-form-or-mirror-form`, `shadowmodule-case-list-show-true`
- `mirror-menus`, `never`: `shadowmodule-version-1-or-key-absent-model-default-1`,
  `a-shadow-menu-s-own-or-mirror-form-endpoint-id-with-surrounding`
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
- `search-default-filters`, `never`: `default-properties-entry-keyed-x-commcare-endpoint-id`
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
- `search-setup`, `never`: `a-commcare-sort-x-commcare-custom-related-case-property-or-case`,
  `workflow-legacy-classic-auto-launch-false-in-an-app-with`

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
  `case-preload-into-a-question-outside-any-repeat-where-the-held` (B4),
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
  `xhtml-namespace-child-elements-inside-a-value`
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
  `an-explicitly-blank-value-in-a-non-default-language-where-the` (B3),
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
- `save-to-case`, `never`: `hand-written-case-block-without-vellum-role-incl-a-root-data`,
  `bind-on-an-attribute-path-not-owned-by-a-plugin-savetocase-model`
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
  `video-av1-mov-avi-ogg-theora-h-263-3gp`, `multimedia-map-key-not-under-jr-file-that-the-build-keeps`,
  `a-media-reference-with-no-file-on-a-slot-android-s-install`
- `mobile-reports`, `never`: `reports-commcare-reports-commcare-reports-commcare-reports`
- `parent-selection`, `never`: `case-module-slug-unrelated-parent-select-case`
- `print-templates`, `never`: `print-template-jr-file-commcare-text-id-html`
- `question-choices`, `fix-in-hq`: `jr-choice-name-on-a-lookup-itemset-select`
- `search-expressions`, `never`: `case-search-fixture`
- `supply-features`, `never`: `session-data-supply-point-id-anywhere-except-in-an-advanced-form`,
  `ledgerdb-vellum-id-ledger`, `commtrack-products-commtrack-programs`
- `visit-scheduler`, `never`: `schedule-m-p-f`

**Joining, by pull request**

Each entry below becomes REFUSED in the pull request named and gains `subject` there. Every one is
`fix-in-hq`; the cause beside it is what `fixCauseOf` gives its reason, which chooses its sentence
(8.4).

A5 (part 02, `02-menus.md`, section 14; one entry):

- `case-list-registration`, `fix-in-hq` (`breaks-when-run`):
  `menus-and-case-lists/case-list-form-post-form-workflow-default-on-a-multi-select-host` (not added
  under part 02's run G3, outcome B)

A9 (part 04, `04-names.md`, section 11.2, N1; one entry):

- `case-types`, `fix-in-hq` (`hq-refuses`):
  `menus-and-case-lists/case-type-outside-the-menu-page-s-grammar`

B3 (part 06, `06-the-reader-forms.md`, sections 11.3, 12.2 and 15; four entries):

- `question-logic`, `fix-in-hq` (`hq-refuses`):
  `questions/default-setvalues-in-an-order-a-save-in-the-form-builder-changes`
- `question-text`, `fix-in-hq` (`hq-refuses`):
  `questions/a-markdown-form-in-a-form-whose-text-formatting-is-off`,
  `questions/an-explicitly-blank-value-in-the-first-language-where-another-holds-text`
- `connect-blocks`, `fix-in-hq` (`breaks-when-run`):
  `questions/connect-deliver-unit-and-task-in-one-form`

B4 (part 07, `07-the-reader-cases-menus-lists.md`, section 14, the two REFUSED rows part 02 names;
two entries):

- `deep-links`, `fix-in-hq` (`breaks-when-run`):
  `menus-and-case-lists/case-list-session-endpoint-id-on-a-put-in-root-module`
- `display-conditions`, `fix-in-hq` (`breaks-when-run`):
  `menus-and-case-lists/form-filter-reading-the-case-on-a-screen-that-chooses-no-case-first`

B6 (part 08, `08-the-reader-expressions.md`, section 11, M1, M2 and M5; three entries):

- `expressions`, `fix-in-hq` (`breaks-when-run`):
  `expressions-and-data/session-data-datum-the-entry-does-not-supply`,
  `expressions-and-data/an-expression-core-cannot-evaluate-as-its-author-meant`
- `search-expressions`, `fix-in-hq` (`hq-refuses`):
  `case-search/required-or-validation-test-reading-the-case`

B9 (part 11, `11-project-data.md`, section 13.1; one entry):

- `media-files`, `fix-in-hq` (`breaks-when-run`):
  `expressions-and-data/a-media-reference-with-no-file-on-a-slot-a-runtime-draws`

### A.3 What each pull request adds or re-cuts

The count of entries that join each list (the closing blocks above), the entries that leave one
(marked in A.1 and A.2 with the pull request), and the new entries that carry neither field. Counts
are for every gated run giving the outcome its part plans for. The closing blocks name the four
entries a run of part 02 or part 07 can leave out or add, and a fallback row of part 04's run R2
adds its own entry in A9.

| Pull request | Joins A.1 | Joins A.2 | Leaves A.1 | Leaves A.2 | New, with neither field | Written in |
|---|---|---|---|---|---|---|
| A2 | 1 | 0 | 0 | 0 | INERT: `menus-and-case-lists/case-tile-field-blank-or-off-a-template-tile`, `menus-and-case-lists/tile-cell-keys-on-a-list-that-is-not-a-tile` | this part, 3.1, 3.2, 3.7 |
| A3 | 0 | 0 | 6, to TARGET-OWNED | 1, to TARGET-OWNED | TARGET-OWNED: `application-and-settings/45p-hq-auto-gps-capture-on-an-app-that-is-not-a-connect-app` | this part, 3.6 |
| A4 | 0 | 0 | 1, to HELD | 0 | none | part 02 (`02-menus.md`), section 14 |
| A5 | 6 | 1 | 2, to HELD | 0 | INERT: `menus-and-case-lists/case-list-form-fields-beside-a-blank-form-id` | part 02, section 14 |
| A6 | 0 | 0 | 1, to HELD | 0 | none | part 03 (`03-questions-and-text.md`), section 10 |
| A7 | 0 | 0 | 1, to HELD | 0 | none | part 03, section 10 |
| A8 | 0 | 0 | 3, to HELD | 0 | HELD: `questions/help-text-with-no-markdown-form`. INERT: `questions/hint-markdown-form` | part 03, section 10 |
| A9 | 23 | 1 | 0 | 0 | none | part 04 (`04-names.md`), section 11.2 |
| B2 | 2 | 0 | 0 | 0 | INERT: `application-and-settings/translations-generated-key-with-no-effect`. HELD: `application-and-settings/translations-generated-key-over-one-text` | this part, 7.1; part 06 (`06-the-reader-forms.md`), section 6.3 |
| B3 | 6 | 4 | 0 | 1, to HELD | HELD: `questions/itemset-over-casedb-in-nova-s-case-choices-shape` | part 06, sections 8.8, 10.1, 10.4, 11.3, 11.4, 12.2, 12.5 and 15 |
| B4 | 15 | 2 | 2, to HELD | 1, to HELD-NEW | INERT: `menus-and-case-lists/module-case-list-label-or-media-beside-show-false`, `questions/bind-required-on-the-question-that-names-a-created-case` | part 07 (`07-the-reader-cases-menus-lists.md`), section 14 |
| B5 | 12 | 0 | 1, to HELD | 0 | INERT: `menus-and-case-lists/sort-elements-sharing-a-join-text` | part 07, section 14 |
| B6 | 4 | 3 | 0 | 0 | none | part 08 (`08-the-reader-expressions.md`), section 11 |
| B8 | 0 | 0 | 1, to TARGET-OWNED | 0 | none | this part, 7.2 |
| B9 | 0 | 1 | 2, one to HELD and one to INERT | 0 | none | part 11 (`11-project-data.md`), section 13.1 |

Three of the entries that join A.1 are re-cuts of entries the manifest holds today, so the manifest
gains no entry with them. `questions/question-id-case-registration-script` (B3) and
`menus-and-case-lists/6-late-flag-late-flag-1` (B5) are HELD today.
`forms-and-case-writes/case-preload-into-a-question-outside-any-repeat-where-the-held` leaves A.2
and joins A.1 in B4, and is counted in both columns. One entry leaves A.2 for HELD, in B3:
`questions/an-explicitly-blank-value-in-a-non-default-language-where-the`:
a blank in a language other than the first, where the first holds text, is read as no translation
(part 09, `09-acceptance-and-the-first-publish.md`, Departure 21). The blank in the first language
gets its own REFUSED entry in the same pull request, which is one of B3's four that join A.2.

