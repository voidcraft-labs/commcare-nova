# Step 7: The rest of the model (outline)

Each group below is its own step for the cutover rule, planned in full when the
group before it exits. The groups and their order are the inventory's HELD-NEW
concept list
([`inventory/README.md`](../../research/2026-09-26-hq-round-trip/inventory/README.md)),
less what steps 2 to 6 build.

From step 4 every HELD manifest entry read per platform whose readings differ
belongs to a feature of the platform table
(`lib/domain/platforms.ts::PLATFORM_FEATURES`, its entries in
`lib/commcare/surface/platformFeatureEntries.ts`) or to its ambient list
(`AMBIENT_PLATFORM_ENTRIES`, an entry no author choice reaches, with its
reason), held by `lib/commcare/surface/__tests__/platformFeatures.test.ts`, and
each of its cells that reads neither `runs` nor `not-applicable` has a row in
Preview's cell table (`lib/preview/__tests__/platformCells.ts`, held by
`platformCells.test.ts`). So every group that flips an entry with such a reading
to HELD adds its feature row and its Preview cells in the same pull request, or
CI fails. A feature that reads `unavailable` on a platform also carries its
refusal copy, a fixture in `lib/domain/__tests__/platformFeatureFixtures.ts`,
its builder offering disabled with `platformPickerLine`, and a cause word in
`lib/notices/migrationNoticeCopy.ts::PLATFORM_CAUSE_WORDS`, whose test holds the
record to every feature that reads `unavailable`; and a new or changed row
changes the guide's generated platform sentences, so it moves
`MODEL_CONTEXT_VERSION`. An ambient entry whose concept a group makes an
author's choice leaves the ambient list for a feature, since its reason no
longer holds.

## Groups, in order

1. **Cross-cutting:** `Field.appearance` (the typed appearance vocabulary with
   its per-platform readings) and `localizedMedia` (per-language media on
   labels, options and menus), with held media paths. A reading that holds
   only under a target gate needs an arm step 4's platform table lacks (its
   `PlatformBehavior` gives one reading per platform): `questions/text-address`
   runs on Web Apps only under `CASE_SEARCH_ADVANCED` and the `geocoder`
   privilege, and is unavailable there otherwise. Each per-language media slot
   joins `lib/domain/mediaRefs.ts::walkAuthoredAssetRefs`, so step 4's
   acceptance by declaration (`lib/media/platformPlayback.ts::unplayableReferences`,
   the commit kernel's media admission and the export rule
   `MEDIA_FORMAT_NOT_PLAYED`) judges each file on every platform the app
   declares.
2. **Application and settings:** the rest of `appSettings` (step 2 creates the
   object with `showSavedForms` and `showIncompleteForms`; 21 typed slots in
   all), `androidLogos`, `caseSharing`, `menuStyle`, per-language display
   names, UI string overrides with `uiStringCatalogKeys` (step 2 leaves every
   runtime UI-catalog key at HQ's value until this group holds them), and
   `Form.autoCaptureLocation` in place of the app-level `auto_gps_capture`
   (defect 4's interim keeps HQ's value until then). Each setting Nova starts
   to own is read from each existing deployment in that group's cutover, as the
   research's "Identity" describes. With `caseSharing`, form logic reads the
   worker's case-sharing groups (`instance('groups')` and a group's fields).
   The read means the groups case sharing gives a worker, which HQ fills from
   each assigned location whose type shares cases and from every HQ group with
   case sharing on
   (`users/fixturegenerators.py::UserGroupsFixtureProvider.__call__`,
   `users/models.py::CouchUser._get_case_sharing_groups_for_locations`,
   `CommCareUser.get_case_sharing_groups`): target state Preview cannot show
   truthfully until Nova holds the setting. Step 3 refuses the read at parse
   and keeps `groups-jr-fixture-user-groups` HELD-NEW; this group adds the
   `groups` instance and its `group-field` leaf. The inventory lists the
   platform declaration (wire: `cloudcare_enabled`) first among this group's
   concepts; step 4 holds it (`appSettings.runsOnlyOn`, beside the 21 slots,
   and `application-and-settings/40-hq-cloudcare-enabled` HELD), so it is not
   this group's. Its platform rows: `Form.autoCaptureLocation`
   (`forms-and-case-writes/auto-gps-capture-form`, ignored on Web Apps; step 4
   derives the app-level `application-and-settings/45-hq-auto-gps-capture` from
   `connectType` and names it in the feature `connect-location-capture`),
   `menuStyle` (`application-and-settings/46-hq-use-grid-menus` and
   `47-hq-grid-form-menus-none-all-some`: a grid's audio is ignored on Web
   Apps) and `androidLogos`
   (`application-and-settings/logo-refs-hq-logo-android-home-login-demo`,
   ignored on Web Apps). The thirteen profile seeds step 4's ambient list holds
   because no author chooses them until `appSettings` does
   (`application-and-settings/1-properties-cc-autoup-freq` and the seeds 4, 5,
   17, 18, 19, 22, 25 to 30), and
   `translations-lang-code-language-display-names-equal-to-the-label`, which
   per-language display names make an author's choice, leave the ambient list
   for features.
3. **Modules and navigation:** mirror menus, "display only forms", badges, and
   computed datum arguments on entry points. Search field reads in the forms of
   a child module of a search-first parent: from step 4 a form reads its
   module's Search fields only in a search-first module's own forms and its
   no-matches form (`lib/domain/expression/context.ts::FormExpressionFacts.searchFirstModule`),
   and a child module of a search-first parent keeps
   `search-answer-unavailable` (`INVALID_SEARCH_REF`), the narrow step 4 writes
   on `expressions-and-data/search-input-read-in-form-expressions-of-an-inline-search-module`;
   this group decides whether the parent's inputs reach the child's forms on
   Web Apps, and lifts the narrow where they do.
4. **Case list and detail:** detail tabs, the case detail tile, persistent
   context, empty-list text, callouts, optimizations, tile templates and slots,
   the remaining column kinds, sort settings, and the other case-list rows. Two
   of its rows carry what step 3 found and left byte-stable, because each is
   the HQ spelling of a sort setting or column kind this group owns. *Sorting
   by a date and time:* case list sort keys over a date-and-time property sort
   the text (`lib/commcare/suite/case-list/sortKeys.ts`); HQ stores every such
   value as `…Z` (`form_processor/utils/xform.py::adjust_datetimes`), so synced
   cases sort right, while a case a device wrote before it synced carries its
   offset and can misorder. Step 3's instant lowering
   (`lib/commcare/xpath/wire/instant.ts`) can be the sort's `double` key; a
   Core run during step 3's planning evaluated it as a detail sort key. *The
   `date()` guard in generated columns:* the interval and late-flag columns
   (`lib/commcare/suite/case-list/columns.ts`) write `today() - date(x)` with
   only a blank guard, and Core's `date()` throws on text that is no date
   (`FunctionUtils.java::toDate`), which a detail shows as an invalid cell;
   this group's column kinds decide the guard. Its platform rows: the
   `distance` column and sort (`menus-and-case-lists/9-distance`, `type-distance`:
   unavailable on Web Apps, which never answers `here()` in a case list, as step
   4's feature `case-list-here` states), the clickable icon
   (`menus-and-case-lists/16-clickable-icon-endpoint-action-id-on-the-case-list`:
   unavailable on Android, which prints its raw path), the callouts
   (`menus-and-case-lists/lookup-*`: ignored on Web Apps) with the
   `fingerprintquery` read
   (`expressions-and-data/session-data-fingerprintquery`, unavailable on Web
   Apps, whose only supplier is a callout; step 4 holds the case list's typed
   search text as the value arm `{ kind: "case-list-search-text" }`, printed
   under the count guard, which is the model for it), the `icon_text_grid`
   template (`menus-and-case-lists/detail-case-tile-template-icon-text-grid` and
   `case-tile-field-template-slot-on-icon-text-grid`: different on Android,
   with `19p-enum-image-whose-keys-are-conditions-contain-any-of-each-a` leaving
   step 4's ambient list), the image map's alt text
   (`enum-mappingitem-alt-text-lang`, ambient in step 4 because no author sets
   it), and the ordinary search's results-detail Search field read
   (`expressions-and-data/search-input-results-read-in-the-search-results-detail`,
   unavailable on Android, HELD-NEW because Nova writes one case list for the
   module's list and the search results detail, `lib/commcare/compiler.ts`,
   where a read of the inputs would throw in the local list).
5. **Case search:** result sort, additional case types, typed default filters,
   related-case properties, search-on-clear, prompt groups, geocoder inputs,
   and case search endpoints (the one reference to project data Nova cannot
   read). Its results instance name (`caseSearchConfig.resultsInstanceName`,
   `case-search/instance-name-without-casedb-ledgerdb-fixture-or-session-in-it`)
   is a setting Nova does not hold yet: until this group, form logic reads an
   inline search's results as `instance('results:inline')`, and from it the
   print reads the module's effective name. Its platform rows: the geocoder
   input (`case-search/appearance-address-geocoder-broadcast-emitted-input-address`,
   unavailable on Android), `search_on_clear` (`case-search/search-on-clear`,
   ignored on Android) and prompt groups (`case-search/is-group-group-key`,
   ignored on Android).
6. **Forms and case management:** the rows not built in step 5, including
   computed datums, shadow forms of advanced forms, a label as a write source,
   and the writer-type joins (decimal, multi-select, text). Computed datums
   (`Form.computedDatums`) give `DatumRef` a `computed` kind (`{ kind:
   "computed"; form; datum }`) with its row in the entry's datum supplies
   (`lib/domain/entryDatumSupplies.ts`) and its id in
   `lib/commcare/formLinkProjection.ts::entryDatumIds`, so form logic reads one
   by identity, a navigation slot can read one as it reads a chosen case, and
   the advanced form's read of `supply_point_id`
   (`session-data-supply-point-id-in-an-advanced-form-whose-computed`) is held
   then.
7. **XForm:** acknowledge labels, pragma itext ids, face capture as its own
   kind, Android app callouts, image max dimension, repeat add labels,
   `Field.dataParent`, `Field.lockedInHq`, query-backed options, lookup sort
   columns beyond search prompts, a Hidden Value's default beside its calculate,
   and the remaining label forms. Its platform rows: acknowledge labels
   (`questions/acknowledge-label-a-trigger-whose-appearance-is-neither-exactly`,
   different on Web Apps, which answers one itself, so a required one never
   blocks), face capture (`questions/face-capture-image-face`, a plain image
   upload on Web Apps) and Android app callouts
   (`questions/android-app-callout-input-appearance-intent-id-bind-type-intent`,
   unavailable on Web Apps as the date-and-time question is: the client's
   `UnsupportedEntry` holds "Not Supported by Web Entry" as the answer, so the
   question is refused where Web Apps is declared).
8. **Media and lookup data:** field properties and multi-valued cells, row
   attributes, ownership and non-global tables, indexed fields, cell absence
   states, a referenced-only `types` table, and import-sized tables and media.
   Until this group holds the indexed-field flag, a push removes it from a
   table Nova adopts, and step 2's adoption and discard confirmations say so.
   A table's description stays outside every step: no lookup upload can carry
   one.
   Its cutover clears the baseline of each adopted table defect 5 left blocked,
   so its first push stops at the drift check and offers to bring HQ's content
   in.

## Contracts

The contracts table's step 7 rows: the hidden value's two sources (in
`lib/domain/CLAUDE.md`, `components/builder/CLAUDE.md` and
`lib/commcare/CLAUDE.md`), long-detail tiles, the form-type sentence's step 7
half, `case_sharing` and every other held setting as a key-level overlay, and
the document's external identities (language wire codes held since step 2,
media paths from group 1).

## Exit per group

Its feature-matrix apps read and pass the proof.
