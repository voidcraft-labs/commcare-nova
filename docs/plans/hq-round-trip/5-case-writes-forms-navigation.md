# Step 5: Case writes, forms and navigation (outline)

Planned in full when step 4 exits. The design is the research's "Case writes",
"Questions" (query repeats and repeat counts), "Navigation and after-submit
links", "Case lists and search", and defects 21 to 30.

## What it builds

1. **Case writes as one concept** (defect 22). A form's case writes are its
   case operations; a field's `caseWrite` is that field's view of a write.
   `via` and `onlyIfChanged` belong to the write. A registration may close the
   case it creates, with open and close conditions. A close condition's answer
   (`Form.closeCondition.answer`) is a literal compared with a field, and step
   3 leaves it one, so editing that option's value does not reprint it. This
   step holds it as a `choice` of the field's options when the field is a
   static select, as step 3 holds every other literal opposite a static select
   (`lib/domain/expression`), because a close condition is a case write, which
   this step makes one concept; the option editor's who-reads-this-choice
   refusal then covers it too.
2. **Placement.** Each operation has a placement: a basic form action slot, an
   advanced action and its tag, or a Save to Case block. A new operation takes
   the simplest placement that can express it. The publish that first carries an
   operation records its placement through a new `publish-placement` app change,
   which open builder tabs fold without a reload. Edits the held placement
   cannot express move it, as an identity edit the builder, SA and MCP state
   before it commits.
3. **Advanced modules.** Advanced-module emission for the placements and case
   selections that need it, the held advanced kind, and HQ's advanced-module
   rules enforced by the validator.
4. **Extension child cases** (defect 24) as case operations with an extension
   link; the inert basic subcase goes.
5. **Attachment mode removed** (defect 23); a capture reaches a case only as a
   link write.
6. **Query-repeat placement** (defect 25): model iteration or count repeat, held
   once published.
7. **Repeat counts as integers** (defect 30), with the integer type added to
   Nova's expression types.
8. **The search workflow setting** (defect 21): list first, search first, or
   skip to default results, with list first only in Android-only apps. Step 3's
   Preview plays a search's claim without storing it: choosing a result the
   worker's restore does not hold adds it to that worker's claims, which last
   while the worker, the app's Project and the page stay (`lib/session`'s
   `previewClaims`), or while an App Test journey runs
   (`AppTestSessionState.claimedCaseIds`), and seed the restore scope as HQ's
   `commcare-case-claim` extension does. A durable claim, a place in the case
   store for a case type no author declares and a way to release it, belongs to
   this step's search workflow, which decides when a claim is made and how long
   it lasts; until then Preview writes no claim row. Android follows every
   claim with a sync
   (`case-search/the-generated-search-round-trip-remote-request-query-results`),
   which step 4's Preview plays (the rule `claimThenSync` in
   `lib/preview/platform.ts`, and `lib/preview/app-tests/run.ts::postAppTestClaims`
   re-reading an Android session's cases after each claim), so the claim design
   keeps a claim followed by a sync on Android.

   The setting reads step 4's platform declaration
   (`lib/domain/platforms.ts::declaredPlatforms`; an absent
   `appSettings.runsOnlyOn` is Web Apps and Android). From step 4 every app that
   declares Web Apps sends `cloudcare_enabled: true`, so a list-first searching
   module of such an app is HQ's REFUSED class `list-first-with-web-apps`
   (`case-search/workflow-legacy-classic-auto-launch-false-in-an-app-with`,
   `proof/checks/manifest_value_classes.py::list_first_with_web_apps`). Step 4
   registers no `manifest` entry for it: the manifest judge reads a slot that
   holds its default as no use, and `auto_launch` and `default_search` both
   default to false, so the class never shows on a document. Defect 21's
   proof 4 reader entries on `targeted-list-first-web-apps` and
   `targeted-list-first-places` hold the difference instead. Where list first becomes an author's value (an app
   that declares Android alone),
   `case-search/auto-launch-false-in-an-app-with-cloudcare-enabled-false`, an
   ambient entry of step 4's platform table because it is "derived from the
   declaration", becomes an author's choice and moves to a feature. Defect 21's
   `requests` entry (`d21-list-first-turned-search-fir-trace-case-list-trace-requests`)
   leaves step 4 in one of two places, which step 4's pull request 6 lane
   decides (step 4's part 08 §2.4). Outcome A, the lane shows the class on
   `targeted-sync-on-form-entry-web-apps` (declared Web Apps only, published
   with sync cases on form entry on): the entry names that document, its
   control is still `targeted-sync-on-form-entry` (which step 4 publishes with
   the setting off), and it stays live for this step to remove. Outcome B, the
   lane does not show it: the class needed sync on with Android, which Nova's
   publish refuses from step 4, so the entry is in `proof/fixed-defects.json`
   on its control `targeted-sync-on-form-entry` and this step has nothing of
   it to remove.

   Inline search stays refused where Android is declared (step 4's
   `search-first` feature, `PLATFORM_FEATURE_UNAVAILABLE`), and the HELD-NEW
   `case-search/inline-search-true-auto-launch-true-on-a-module-without-visible`
   and `case-search/inline-search-default-search-on-a-module-with-visible-inputs`
   read Android unavailable, so they join that feature when this step holds
   them. The non-inline search first
   (`case-search/workflow-search-first-auto-launch-true-default-search-false`,
   ignored on Android, which opens its own list first) is the first search
   first an app on both platforms can hold, and this step rewrites
   `search-first`'s remedy and refusal alternative in
   `lib/domain/platforms.ts::PLATFORM_FEATURES`, which from step 4 offer only
   the case list first, to offer it. Skip to default results becomes authored
   here: step 4 derives it (`lib/commcare/suite/case-search/searchWireShape.ts::searchWireShape`,
   the feature `skip-to-results`) and writes its widen to an authored
   `caseSearchConfig.workflow: skipToResults` on
   `case-search/workflow-skip-to-default-results-auto-launch-true-default-search`.
   Each workflow value and the inline flag get their rows in the platform
   table and their Preview cells.
9. **Form links with CommCare's semantics** (defect 26): every matching
   destination runs, in the author's order, with "otherwise", self-links as
   "start this form again", and the validator refusing link targets HQ does not
   offer. This step also owns what a link's case value may name. Step 2 leaves
   two register entries for a value that names no case, where HQ makes a case
   out of the linked form's update
   (`d26-a-link-names-no-case-soft-assert-casedb-base-get-case-from-case-update`
   and
   `d26-a-link-names-no-case-soft-assert-proof3-casedb-base-get-case-from-case-update`),
   and this step's exit removes them.
10. **`group.fieldList`** (defect 27).
11. **Explicit preloads and markdown** (defect 28).
12. **Renamed menu concepts** (defect 29): `Module.caseListRegistrationForm`,
    `Module.caseListMenuItem`, and the search workflow setting.

**Platform rows.** From step 4 every HELD manifest entry read per platform
whose readings differ belongs to a feature of the platform table
(`lib/domain/platforms.ts::PLATFORM_FEATURES`, its entries in
`lib/commcare/surface/platformFeatureEntries.ts`) or to its ambient list, held
by `lib/commcare/surface/__tests__/platformFeatures.test.ts`, and each of its
cells that reads neither `runs` nor `not-applicable` has a row in Preview's
cell table (`lib/preview/__tests__/platformCells.ts`, held by
`platformCells.test.ts`). So each flip this step makes to such an entry lands
with its feature row and its Preview cells in the same pull request, or CI
fails: `group.fieldList` (today the `question-pages` feature, ignored on Web
Apps, whose detector restates the XForm builder's `appearance="field-list"`
rule and is held to it by `lib/commcare/__tests__/platformQuestionPages.test.ts`),
the case list menu item on a module with forms or an advanced module
(`menus-and-case-lists/module-case-list-show-true-on-a-basic-module-with-forms`
and `module-case-list-show-true-on-an-advancedmodule`, beside step 4's
`case-list-menu-item`), advanced modules, and the search workflow values of
item 8. A feature that reads `unavailable` on a platform also carries its
refusal copy, a fixture in `lib/domain/__tests__/platformFeatureFixtures.ts`
(typed over every feature, so a missing one fails to compile), its builder
offering disabled with `platformPickerLine`, and a cause word in
`lib/notices/migrationNoticeCopy.ts::PLATFORM_CAUSE_WORDS`, whose test holds the
record to every feature that reads `unavailable`. A new or changed row changes
the guide's generated platform sentences, so it moves `MODEL_CONTEXT_VERSION`.
The two case list menu item entries above still read "selecting a case from
that list leaves an empty list" on Web Apps, the reading step 4 corrects for
the formless module (Formplayer shows "Redirecting after sync" and returns to
the app's first menu, `services/MenuSessionRunnerService.java::advanceSessionWithSelections`),
so this step reads them again at the pins before it flips them; Preview's
`lib/preview/formlessCaseListRoute.ts::formlessCaseListSelection` plays the
formless module only.

Advanced-module emission also makes defect 20's CommTrack `product_id` datum
reachable from a Nova export. This step adds the CommTrack confirmation (a
fifth kind in `app_deployment_confirmations`, beside step 4's
`form-entry-sync-off`) for an app with an advanced module whose case list menu
item is on, or with a form whose source a form-builder save could leave holding
the text `instance('commcaresession')/session/data/supply_point_id`, and this
step's plan proves, under the harness's CommTrack seam, that publish asks for
it before such an app reaches a CommTrack project space. Step 4 builds no
CommTrack confirmation: HQ's triggers
(`suite_xml/sections/entries.py::EntriesHelper.entry_for_module`, the case list
menu item of an `AdvancedModule`, and a substring test of a form's source) are
unreachable from a Nova document before advanced modules exist, and a
form-builder save writes a form's apostrophes plainly (finding 68), after which
that substring test can match text Nova admitted. The kind follows step 4's
`form-entry-sync-off`: an additive migration widens the kind CHECK, as
`20261101010000_hq_round_trip_platforms_form_entry_sync` did, and its copy is
one more `ProjectSpaceSettingConfirmation` in
`lib/publish/planFeatures.ts::PROJECT_SPACE_SETTINGS`, which every surface reads
by kind. This step's plan also decides HQ's third trigger, an advanced form
whose last load or update action shows product stock (`entries.py`,
`show_product_stock`), which only advanced emission can write.

Once a form may create a basic child case of its own menu's case type, this
step's plan also adds defect 12's `DONT_INDEX_SAME_CASETYPE` refusal at
publish, with the offered move to a Save to Case placement. No Nova document
can hold that shape before then, so step 2 has nothing to guard.

## Cutover and migration

One cutover, carrying every migration defects 21 to 30 name: field writes into
operations with their published placements (read from each deployment's drift
baseline), extension child cases, attachment-mode writes to link writes, query
repeat placements, counts, form-link guards to conditions and "otherwise",
field-list flags, explicit preloads, and the renamed concepts. The migration
names every app and entity it changes. Defect 21's migration reads each app's
declaration as step 4's cutover stored it (`appSettings.runsOnlyOn`, through
`declaredPlatforms`): in an app whose declaration includes Web Apps it moves
each list-first module to the non-inline search first, as the research's
defect 21 gives it.

## Contracts

The contracts table's step 5 rows: the `__nova_` count container, `count_bound`,
`query_bound`, `__nova_subcases`, the `publish-placement` change kind (in
`lib/db/CLAUDE.md`, `contracts.md` twice, and the root `CLAUDE.md`), the
`caseWrite` sentence, the form-type sentence, `casePreload.ts`, the form
`entry` sentence, attachment display, markdown itext, and the exclusive-guard
sentence.

## Exit

Proofs 1 to 5 pass on every Nova export, including a republish after each
migration.
