# Step 4, part 10: The pull-request stack, contracts and docs

Part of [step 4's plan](../4-platforms.md) ("Platforms"), which holds the baseline, the decisions
and the exit. Citations are `path::symbol` for Nova at `main` `e9e6cd93`. This part makes no
CommCare claim of its own: every CommCare fact it relies on is a fact of another part, cited there
at the pins `proof/pins.json` names (commcare-hq `d6c6e16d8ae1`, commcare-core `8e9ba8d908e9`,
commcare-android `7a5584475580`, formplayer `24383ac71bfb`, commcare-connect `046c7fd78081`,
Vellum `01215f251c57`).

This part owns no defect, so it carries no Today / Fix block of its own. It orders the work parts
01 to 09 plan into one stack, lists every file each pull request touches, gives the checklist each
model addition follows, and lists every contract sentence, public docs page and lane document step
4 rewrites. Where a pull request is named by number anywhere in this plan, the number is the one in
the table below. Every cutover step id, blocker code, notice reason, migration name and Job name
here is the one part 09 registers (§5, §8, §11, §12, §13); that registry is the one list.

The stack is cut from the latest `origin/main` after this plan's own pull request merges. Counts
are of `main` at `e9e6cd93`, read for this part: `proof/known-defects.json` 286 entries,
`proof/fixed-defects.json` 734, `proof/walk-stops.json` 26, `proof/controls/` 108 directories,
`proof/checks/registers.py::OPEN_DEFECTS` `{20: 4, 21: 5, 23: 5, 24: 5, 25: 5, 26: 5, 27: 5, 28: 5,
30: 5}`, `lib/models.ts::MODEL_CONTEXT_VERSION` `"v4-hq-round-trip-expressions.12"`,
`lib/db/appTests.ts::RUNTIME_VERSION` 16, and `scripts/test-schema.ts` 54 entries, every one named
in its header's "Known names". The corpus holds 392 documents (seed 20260930, sample 24 + 8).

## The stack

One `gh stack` chain of fifteen pull requests, merged together for one deploy. Each row's checks
are in addition to the repository's ordinary checks at that pull request's own head: typecheck,
lint, Vitest with Postgres, the production build, the pull request lane in CI, the Playwright smoke
and the Python infra tests. No row runs a served reader on the person's machine. "Register" counts
entries by id: "adds" are entries the pull request registers live, "moves" are entries that leave
`proof/known-defects.json` for `proof/fixed-defects.json`. "Lane" is the row of part 08 §6.1 the
pull request's lane runs: a stacked pull request never reads its base's records
(`proof/ci/store-keys.mjs`), so from pull request 2, which changes observation code, every pull
request runs the 12.7-minute row of 15 shards on every push (part 08 §6.2).

The cutover is one pull request (13), written against the head gate, the head reducer and the head
planners. The "Cutover" column names the step ids, blockers and notice reasons whose behavior the
row brings; every one of them is written in pull request 13 (part 09).

| # | Title | Contains | Register, controls, walk stops, corpus | Cutover | Lane | Checks |
|---|---|---|---|---|---|---|
| 1 | Manifest audit | The HELD-NEW lane check (`manifest_usage.py::HELD_NEW`, the register's refusal of a `/<key>/held-new` path); the 30 entry edits that resolve the 36 keys Nova emits under HELD-NEW entries alone (27 flips, a key added to each of two HELD entries, the label entry's `appearance:web-apps/minimal` and `questions/hq-generated-meta-deviceid-timestart-timeend-username-userid`'s `session-path:session/context/drift`, which every form's meta block reads, and the new INERT `subcases-close-condition-never`), the skip-to-results flip and `questions/hidden-value-bound-xsd-datetime` (part 02 §2, §3); the three readings corrected where no code moves (`here()`, the case list menu item, the hidden sibling, part 02 §3.6); their inventory rows; the `lib/commcare/CLAUDE.md` inventory and manifest-check sentences. No file under `lib` or `app` changes but `lib/commcare/surface/entries/*.json` and `lib/commcare/CLAUDE.md` | none; corpus 392 | none | 10.7 min, 5 shards (judge files only; no document's key moves) | `test_manifest.py::test_a_use_only_held_new_entries_name_is_held_new`, `test_registers.py::test_a_manifest_entry_never_holds_a_held_new_use`; the lane's `manifest` check over every document shows no held-new difference (part 02 §2.5); `manifest.test.ts` |
| 2 | Lane mechanics | Reader policy by declaration (`readers.py::PLATFORM_OF`, `reads_app`), `Document.platforms` with absent read as both and a control without `platforms` read as both, Formplayer's walk modelling the client only where Web Apps is declared, the served observation's guards, the local-archive checks ready for an absent archive, `sensitivity.flip_entries` holding a control's fixed entries, `accepts` and `corpus.lacking` reading `syncCasesOnFormEntry`, with `proof5._edit_lacks` reading D′'s verdict through `corpus.lacking`, `_needs_cloudcare` from the app body (absent is today's `true`), the `proof/CLAUDE.md` rule (part 08 §1) | none; corpus 392 (every document reads as both) | none | 12.7 min | part 08 §1.9's nine tests and §1.7's `test_proof5_locality.py::test_d_prime_is_unpublished_under_sync_on_where_its_verdict_requires_it_off`; by-hand reader run of part 08 §6.3's row 2 shows nothing moves |
| 3 | The split's groundwork | Typing rule R2 (`datePattern.ts::isClockKeepingDate`, the `typeChecker.ts` case), bind rule R3 (`fieldValueType.ts`), `datetime.convertTargets` gaining `hidden`, `isRepresentableConversion` and `convertNeedsLabelSeed`, the `convertField` `label` seed, the converted-field media diff fix, Preview's time read, `lib/domain/datetimeSplitIdentity.ts`, `lib/doc/datetimeSplit.ts` (part 03 §2.5 to §2.11); the joined value's entry completed (part 02 §4); `DatetimeSplitRuntimeTest` and `targeted-datetime-split` (part 08 §4.1, §5.1) | corpus 393 (`targeted-datetime-split`, both) | brings the split planner step 1 calls; blocker `datetime-split-refused` | 12.7 min | part 03 §9's pull request 3 tests; `DatetimeSplitRuntimeTest` once per device zone; the corpus emission at base and head (R2 and R3 retype) shows only `targeted-datetime-split` new; by-hand row 3 |
| 4 | The declaration and the platform table | `appSettings.runsOnlyOn` with its patch, reducer, diff and gate-scope arms (part 01 §1); `lib/domain/platforms.ts` and `platformUses.ts` with 43 features naming 62 entries and 34 ambient entries (part 01 §2 to §4); `PLATFORM_FEATURE_UNAVAILABLE` and the checker's `platform-unavailable` (part 01 §5, §6) with their copy (§7); the binding and parity tests (§8, §9); Connect's two rows and its manifest entry (§10, part 02 §5.1); the flip of `40-hq-cloudcare-enabled` with `gates.json`'s `privilege/cloudcare` (part 02 §5.2); `compileForPlatform` renamed `searchWireShape`, platform-free (part 01 §4.2, part 02 §5.4); `lib/doc/platformDeclaration.ts` (`planContentDeclaration`, `declaredForContent`, part 09 §5 step 1, part 08 §3.4); every corpus source's declaration and the fuzz mapping (part 08 §3.1, §3.4); `setConnectType` narrowing (part 08 §3.5); finding 74's stop moves (part 08 §2.2); `targeted-platform-declaration` (§4.2) | walk stops 26 to 25 (`targeted-datetime-ordering`'s stop moves to its control, `fuzz-xform-20260930-0`'s is removed); corpus 394: 326 both, 38 Web Apps only, 30 Android only | brings step `declare-platforms` with blockers `runs-on-neither` and `transform-admission`, reasons `platforms-declared` and `datetime-question-split` | 12.7 min (about 72 documents' keys move) | part 01 §11's tests and fixtures; `lib/commcare/validator/rules/__tests__/platforms.test.ts` (part 03 §9); `platformDeclaration.test.ts`; the corpus emission at base and head: every document admitted, the census of part 08 §3.1, no finding but those the declarations remove; `test_corpus.py::test_the_corpus_holds_each_declaration_and_a_narrowing_edit`; by-hand row 4 |
| 5 | Publish, Web Apps | `cloudcare_enabled: declaresWebApps(doc)` on every generated application body (part 05 §2); the `web-apps` plan feature (§3); the Web Apps question `hq_web_apps_change` with `confirmWebApps` and `confirm_web_apps` (§4); the first-publish stop `hq_plan_lacks_web_apps` with its withdrawal (§5); `app_deployments.target_web_apps_enabled` dropped with every reader (§6), migration `20261101000000_hq_round_trip_platforms_web_apps_read`; the setup artifact and the import file per declaration (§7); no `.ccz` without Android (§8); `whereMissing` (§9); the capture (§12); the intent clause and the Web Apps listing test (part 08 §7); the corpus's local archives only for Android, with the three lane readers of a Web Apps-only document's archive re-pointed (part 08 §3.3); defect 21's two `manifest` entries with their control (part 08 §2.5); the emission cells (part 02 §6) | known 286 to 288 (adds `d21-list-first-with-web-apps-manifest-auto-launch`, `-default-search`); controls 108 to 109 (`targeted-list-first-web-apps-declared`, retained from this head's `proof-corpus-<attempt>.tar.zst` artifact by the commands of "Pull request 5" below) | brings step `deployment-lines` with reasons `next-publish-asks-web-apps` and `next-publish-asks-more` (`web-apps`), read through `lib/deployment/webApps.ts::baselineWebApps` | 12.7 min (every document's key moves) | part 05 §15's pull request 5 tests; `test_intent.py::test_hq_stores_the_web_apps_setting_the_document_declares`; `webAppsRead.postgres.test.ts`; the settings-save test of `proof/editors/test_plan_features.py` in this pull request's own lane, which runs HQ's editors and decides part 05's outcome pair ("Written and not yet run"); by-hand row 5 and the `test_session.py` slice |
| 6 | Publish, defect 20 | The `form-entry-sync-off` confirmation (part 05 §10) with migration `20261101010000_hq_round_trip_platforms_form_entry_sync`; `minimumConfiguration.syncCasesOnFormEntry` and the corpus's one sync-on refusal (part 05 §12); `targeted-sync-on-form-entry` without `projectSettings`; `targeted-sync-on-form-entry-web-apps` (part 08 §4.3); the sync gate's `gates.json` content cell and its inventory phrase (part 02 §6.2) | moves defect 20's 15 entries (part 08 §2.3); defect 21's `requests` entry by the lane's outcome (part 08 §2.4): A, `targeted-sync-on-form-entry-web-apps` shows its class and the entry is re-homed there, still live, so known 288 to 273 and fixed 734 to 749; B, it does not, because the class needs sync on with Android, which Nova's publish now refuses, so the entry moves to `proof/fixed-defects.json` on its retained control `targeted-sync-on-form-entry` with that reason, and known 288 to 272, fixed 734 to 750; `OPEN_DEFECTS` drops `20` either way; corpus 395 | extends `next-publish-asks-more` with `form-entry-sync-off` (read through `formEntrySyncReasons`) | 12.7 min | part 05 §15's pull request 6 tests; `formEntrySyncConfirmation.postgres.test.ts`; `test_registers.py` (`test_every_live_defect_is_a_later_steps` asserts every step above 4); the lane holds each moved entry on its control and on no document; by-hand row 6 |
| 7 | Media by platform | `MEDIA_FORMATS` and the six new `ACCEPTED_FORMATS` entries, the readers, SVG refused (part 04 §2 to §4); `media_assets.media_format` with migration `20261101020000_hq_round_trip_platforms_media_format` (§5); acceptance per reference at the kernel, attach verdicts, `MEDIA_FORMAT_NOT_PLAYED`, the builder's attach guard and Preview's stand-in (§6); the media entries, `media-formats.json` and the SVG reader (part 02 §7); the corpus video re-encoded H.264 Main with its three hash literals; the native `media` scenarios and the browser playback spec (part 04 §8); the H.264 High answer, given before this pull request is cut, and under a yes the decode probe's outcome (part 04 §8.5) | none; 46 documents' bytes move | brings the classifier the backfill runs (`classifyStoredMediaBytes`), step `remove-unplayed-media` with blocker `media-row-missing` and reason `media-not-played-removed`, and `REEXPORT_AS` | 12.7 min | part 04 §10's tests; `mediaFormat.postgres.test.ts` (this head's cases); `test_media_emission.py` with the three scenarios (four, with `media-avif-refused`, where `media-web-apps-on` shows HQ refusing the AVIF, part 04 §8.3); `media-play.spec.ts` in both engines (its outcome per part 04 §8.4); `preview-android-media.spec.ts`; by-hand row 7 |
| 8 | Preview, the model | `lib/preview/platform.ts` (the rule table, `effectivePreviewPlatform`, the pin constants), session state `previewPlatform` and its siblings, the device (`previewDevice.ts`), recalculation, form screens, day numbers, navigation and the Android home model, entry points, the formless case list, search and tiles per platform, `here()` per platform, the upload route's limits with migration `20261101025000_hq_round_trip_platforms_android_capture_size`, the server binding the device, App Tests per session and `evaluate_form` per call (part 06 §2, §3, §5, §6 to §16 model halves, §18, §20 to §22); worker protocol 9; `RUNTIME_VERSION` 16 to 17; `MODEL_CONTEXT_VERSION` `"v5-hq-round-trip-platforms.8"`; `startAppTest` registered in `scripts/test-schema.ts` | none | none | 12.7 min | part 06 §27's pull request 8 tests; the hash run shows `startAppTest` and `evaluateForm` moved and no other tool |
| 9 | Preview, the screens | The identity menu's Runs on group, the device home screen, the Android stand-ins (location, capture, recorder, scanner), form paging and the repeat prompt, help, hints and labels per platform, the logo, the cell table and its completeness test, the Playwright specs, `targeted-preview-android-renders` and part 06 §24's three Android observations (part 06 §4, §6, §12 to §17, §23 to §25); the `### Preview on Web Apps and Android` subsection of `building-with-nova.mdx` (one of the two public-docs exceptions) | corpus 396 (`targeted-preview-android-renders`, Android only) | none | 12.7 min | `platformCells.test.ts`, `platformRuleReaders.test.ts`; the browser-lane and app-lane specs of part 06 §25; by-hand row 9 with its three Android slices, whose observed outcomes decide the copy part 06 §24 holds back |
| 10 | Expression reads | Search fields read in a search-first module's forms, list and detail; the `case-list-search-text` value arm; `drift`, `applanguage` and `window_width` typed and authorable; the count guard; the `current()` print (part 03 §4 to §7); their manifest flips, the search-value split and `manifest.test.ts` lists (part 02 §8); part 01's rows for `case-list-search-text`, `window-width`, `clock-drift`, `app-language` (and `window-width-in-search` under outcome B), `search-first`'s two entries and Web Apps note (part 01 §4.5, §13); Preview's carriers and the rows marked (10) (part 03 §5.4, part 06 §23.3); `SessionContextRuntimeTest` (its gate run by hand first), `RowPredicateCurrentRuntimeTest`, `targeted-session-context-reads`, `targeted-case-list-search-text`, the two extended targeted documents (part 08 §4.4 to §4.7, §5.2); `MODEL_CONTEXT_VERSION` `"v5-hq-round-trip-platforms.10"` | corpus 398: 326 both, 40 Web Apps only, 32 Android only | the scan's `session-context` line and its `target-gate` blockers by rule (part 09 §6, §11) | 12.7 min | part 03 §9's pull request 10 tests; `formplayer_session_values`'s test (part 08 §4.4); the corpus emission at base and head; the gate run (part 08 §6.3, row "10, the gate") before the manifest text is written; by-hand row 10 |
| 11 | Builder | `AppPlatformsSection` and `platformChangePreflightAction` (part 07 §2.2, §2.3), the refusal block with `findingOpenAction` (§2.4), offering by declaration at every site including the media pickers (§2.5), the split gesture and the insertion menu's `Date and time (as two questions)` (§2.5, §2.6), the Connect dialogs through `switchConnectMode` (§2.7), the platform note row (§2.8), the moved copy (§2.9) | none | none | 12.7 min | part 07 §2.10's Vitest and Playwright; the hash run shows no tool moved |
| 12 | Agent | `updateApp.runs_only_on` with its content and media pre-check, the guide's declaration paragraph and generated platform sentences, platform-neutral capture `saDocs`, prompts, the plan line and the peer check, `platforms` and `notOffered` in the overview, the summary line, the date-and-time pre-check, the autonomous instruction (part 07 §3); `MODEL_CONTEXT_VERSION` `"v5-hq-round-trip-platforms.12"`, the value the stack deploys. The billed `npm run test:schema` is asked once at this head | none | none | 12.7 min | part 07 §3.11's tests; the hash run at base shows `updateApp` alone moved, and against `main` exactly `updateApp`, `evaluateForm` and `startAppTest` (part 07 §3.10) |
| 13 | Cutover | Part 09 whole: the scan and migrate scripts, `scripts/lib/hqRoundTripPlatforms/`, the transform's four steps, the media backfill, the two-phase ledger, the fleet transaction, the postconditions, the notice (`hq-round-trip-platforms`, its lead, three document reasons and one deployment reason), the validation migration `20261101030000_hq_round_trip_platforms_media_format_validated`, the scan's case-schema drift line and the runbook's post-deploy drift writer step (part 09 §6, §14), the Job contract, its allowlist arm, the bundle line, `reapStaleDesignSessionRun` exported, the runbook `4-cutover-runbook.md`; the notice's public docs (the second public-docs exception) | none | every step of part 09 §5 in its order, every blocker of §11, every reason of §12 | 12.7 min | part 09 §15's tests (the pure suites, `writer`, `scan` and `holders` Postgres suites, the media-format migration cases, the infra tests) |
| 14 | Contracts and public docs | Every contract row below that names 14, the architecture docs, every public docs row but the two exceptions, the `proof/README.md` count tables, `proof/timings.json`'s `no-readers` profile from this head's fresh dispatch; the `../nova-plugin` record (its pull request's link and the sweep repeated). The maintenance image is built from this head | none | none | 12.7 min | the docs build; the docs' links; `OPEN_DEFECTS` names no defect at or below step 4 |
| 15 | Removal of the cutover tooling and of this plan | Both scripts and `scripts/lib/hqRoundTripPlatforms/`, the bundle line, the three sharp `COPY` lines and the three `.dockerignore` lines, the Job contract, the allowlist arm with `PLAN_DIGEST_RE` and their test rows, the `scripts/README.md` entry, the `docs/architecture/deployment.md` paragraph, the runbook, this plan and its part directory; `reapStaleDesignSessionRun` module-private again; the plans `README.md`'s four links to this plan re-pointed and "Step 4 is done" (part 09 §16) | none | none | 12.7 min | infra tests without the tool; no file names `4-platforms.md` or its parts; `git diff --stat <14>..<15> -- lib app` names only `lib/db/designSessions.ts`; the whole lane with every reader runs as the first nightly after the merge |

Totals the stack reaches (part 08 §2.6): pull request 5 registers defect 21's 2 entries and pull
request 6 moves defect 20's 15, so `proof/known-defects.json` goes from 286 to 288 to 273 and
`proof/fixed-defects.json` from 734 to 749 under outcome A of defect 21's `requests` entry; under
outcome B pull request 6 moves that entry too, and the two go to 272 and 750 (part 08 §2.4).
`proof/controls/` goes from 108 to 109 (pull request 5).
`proof/walk-stops.json` goes from 26 to 25 (pull request 4). `OPEN_DEFECTS` goes from nine defects
to eight (pull request 6), every one a later step's. The corpus gains six targeted documents (3, 4,
6, 9 and two in 10) and keeps its fuzz draws, mapped after the draw (part 08 §3.4).
`MODEL_CONTEXT_VERSION` moves three times, in pull requests 8, 10 and 12. `RUNTIME_VERSION` moves
once, in 8. The stack's five ledgered migrations are pull requests 5, 6, 7, 8 and 13's, applied in
the window (part 09 §8).

## Files, by pull request

This is the list an implementer holds a pull request's diff against. Under each pull request it
names every file the parts' Files sections and text give it. Paths are written from the
repository root. Where two parts list the same file for one pull request, its entry carries both
changes. A file is marked "new", "moved" or "deleted" where the pull request makes it so.

Five kinds of file are given once, here. A source file stands for its tests in the `__tests__`
directory beside it unless a test is named. A pull request that moves or adds a register entry
edits `proof/known-defects.json` and, for a move, `proof/fixed-defects.json`. A pull request that
adds a corpus document or a control edits `proof/timings.json` (both profiles where the group is in
both) and `proof/README.md`'s "Targeted documents". A `CLAUDE.md` file or a public docs page is
listed under the pull request "Contract sentences step 4 rewrites" and "Public docs that change"
assign it. A manifest edit edits its inventory row in the same pull request (part 02, decision 5).

And **every importer of a module a pull request deletes, moves or re-signs is re-pointed in that
pull request**, tests, fixtures, scripts, lane producers and comments included, because each pull
request is green at its own head. Their list is a command run at the pull request's base:

```
rg -l -e '<dir>/<name>\b' -e '"\./<name>"' -e '"(\.\./)+<last>(/<name>)?"' \
  lib app components proof scripts e2e __tests__
rg -l -w -e '<export 1>' -e '<export 2>' … lib app components proof scripts e2e __tests__
```

Each hit is read, since a relative hit can name another directory of the same last segment and a
symbol hit can be a same-named local. Where this list names importers it names the ones found at
`main` and the non-mechanical ones.

### Pull request 1: Manifest audit

**The lane**

- `proof/checks/manifest_usage.py` (`HELD_NEW`, `_Plan.new`, `_standing_plan`, `_evaluate`'s tail, the docstrings; part 02 §2.1)
- `proof/checks/registers.py` (`HELD_NEW_STEP`, `_held_new`, the refusal in `_field_problems`; §2.2)
- `proof/checks/test_manifest.py`, `proof/checks/test_registers.py` (the two tests of §2.5)

**The surface**

- `lib/commcare/surface/entries/application-and-settings.json`, `menus-and-case-lists.json`, `case-search.json`, `forms-and-case-writes.json` (the new INERT `subcases-close-condition-never`), `questions.json` (the label entry's added key; `questions/hq-generated-meta-deviceid-timestart-timeend-username-userid`'s added `session-path:session/context/drift`; `questions/hidden-value-bound-xsd-datetime`, new, `export-use`), `expressions-and-data.json` (part 02 §3)

**The research**

- `docs/research/2026-09-26-hq-round-trip/inventory/application-and-settings.md`, `menus-and-case-lists.md`, `case-search.md`, `forms-and-case-writes.md`, `expressions-and-data.md` (part 02 §3.7)

**Docs**

- `lib/commcare/CLAUDE.md` (the inventory sentence and the manifest-check sentence)
- `proof/README.md` ("Manifest checks", the register's bullet, the loader's rule 1; part 02 §2.3)

### Pull request 2: Lane mechanics

- `proof/lane/readers.py` (`PLATFORM_OF`, `reads_app`), `proof/lane/test_readers.py`
- `proof/checks/corpus.py` (`WEB_APPS`, `ANDROID`, `PLATFORMS`, `BOTH`, `"platforms"` in `OPTIONAL_DERIVED_KEYS`, `Document.platforms`, `lacking` reading `syncCasesOnFormEntry`), `proof/checks/test_corpus.py` (the declaration, sync and Web Apps tests of part 08 §1.9)
- `proof/checks/controls.py` (`derived` writes `platforms`), `proof/checks/test_controls.py`
- `proof/formplayer/hq.py` (`Served.platforms`, `Served.reads`), `proof/formplayer/walk.py` (`answerable`, `drawn_with`, `Walk.web_apps`), `proof/formplayer/test_walk.py`
- `proof/observe/served.py` (`observes_state` and its four readers), `proof/observe/proof4.py`, `proof/observe/sessions.py`
- `proof/webapps/hq.py` (the declaration check before the privilege)
- `proof/checks/configurations.py` (`_needs_cloudcare` from the body), `proof/checks/sensitivity.py` (`accepts`, `flip_entries`), `proof/checks/test_sensitivity.py`
- `proof/checks/proof1.py`, `proof/checks/proof3.py`, `proof/checks/test_proof3_behavior.py`, `proof/checks/proof5.py` (the local-archive guards, part 08 §1.6; `_edit_lacks` calls `corpus.lacking`, §1.7), `proof/checks/test_proof5_locality.py` (D′ unpublished under sync on where its verdict needs it off)
- `proof/CLAUDE.md` (the reader-policy bullet; the Web Apps bullet's parenthesis)
- `proof/README.md` ("Walk stops"' count sentence, "Configurations", "The Web Apps driver", "Served states", "Fixed defects"; part 08 §8)

### Pull request 3: The split's groundwork

**Nova source**

- `lib/domain/expression/datePattern.ts` (`INSTANT_TEXT_PATTERN`, `isInstantText`, `isClockKeepingDate`, `clockKeepingJoin`), `lib/domain/expression/typeChecker.ts` (R2)
- `lib/domain/fieldValueType.ts` (R3), `lib/commcare/xform/bindType.ts` (its docblock), `lib/commcare/xpath/wire/instant.ts` (imports `INSTANT_TEXT_PATTERN`)
- `lib/domain/fields/datetime.ts` (`convertTargets`), `lib/domain/fields/index.ts` (`isRepresentableConversion`, `convertNeedsLabelSeed`, `reconcileFieldForKind`'s `label` option)
- `lib/doc/types.ts` (`convertField.label`), `lib/doc/mutations/fields.ts`, `lib/doc/mutationTargetAdmission.ts`, `lib/doc/diffDocsToMutations.ts` (the label seed; `diffFieldMedia`'s destination kind)
- `lib/preview/engine/dataInstance.ts` (`answerXPathValue`'s `time` case)
- `lib/domain/datetimeSplitIdentity.ts` (new), `lib/doc/datetimeSplit.ts` (new)

**Nova tests named outright**

- `lib/domain/expression/__tests__/typeChecker.test.ts`, `inference.test.ts`; `lib/domain/__tests__/fieldValueType.test.ts` (new), `datetimeSplitIdentity.test.ts` (new)
- `lib/commcare/xpath/wire/__tests__/instantAgreement.test.ts`; `lib/commcare/__tests__/datetimeSplitXform.test.ts` (new)
- `lib/doc/__tests__/mutations-fields-convertField.test.ts`, `store.test.ts`, `diffDocsToMutations.fuzz.test.ts`, `datetimeSplit.test.ts` (new), `datetimeSplitFixture.ts` (new, shared with the targeted document and the native family)
- `lib/preview/xpath/__tests__/fixtures/coreDateParity.ts` (the time node and the join row)

**The lane and the surface**

- `proof/targeted/documents/datetimeSplit.ts` (new), `proof/targeted/index.ts`
- `proof/native/producers/emit-expression-evidence.ts` (`datetime-split/`, `datetime-split.json`), `proof/native/core/DatetimeSplitRuntimeTest.java` (new), `proof/native/families.py` (`CORE_CLASSES`, `ZONED_CLASSES`)
- `lib/commcare/surface/entries/questions.json` (part 02 §4)

**Docs**

- `lib/domain/CLAUDE.md`, `lib/domain/expression/CLAUDE.md`, `lib/commcare/CLAUDE.md`, `lib/preview/CLAUDE.md`, `lib/doc/CLAUDE.md` (the rows marked 3 below)
- `proof/README.md` ("Native proofs", "Targeted documents")

### Pull request 4: The declaration and the platform table

**Nova source**

- `lib/domain/blueprint.ts` (`appSettingsSchema.runsOnlyOn`, `appSettingsPatchSchema`, `AppSettingsPatch`)
- `lib/domain/platforms.ts` (new), `lib/domain/platformUses.ts` (new), `lib/domain/index.ts` (two exports)
- `lib/domain/expression/profiles.ts` (`serverOnlySearchSlot` exported), `lib/domain/expression/context.ts` (`ExpressionContext.platforms`), `lib/domain/expression/typeChecker.ts` (`CheckError.platform`, the `admission` branch; `serverOnlySearchSlot` moved out)
- `lib/doc/types.ts` (the `setAppSettings` arm), `lib/doc/mutations/app.ts`, `lib/doc/diffDocsToMutations.ts` (`appSettingsPatch`), `lib/doc/incrementalValidationScope.ts`, `lib/doc/hooks/useBlueprintMutations.ts`, `lib/doc/userFacingErrors.ts` (`PLATFORM_FEATURE_UNAVAILABLE`, `PLATFORM_BUILDER_COPY` keyed by `RefusablePlatformFeatureId`, `platformBuilderSentence`, `recordFindingCopy`)
- `lib/doc/platformDeclaration.ts` (new: `planContentDeclaration`, `declaredForContent`, `PlatformDeclarationBlocked`)
- `lib/agent/tools/updateApp.ts` (`changedSettings`' return type only)
- `lib/commcare/validator/errors.ts`, `gate.ts`, `runner.ts` (`SCOPE_EXEMPT_CODES`), `rules/app.ts` (`APP_RULES`), `rules/platforms.ts` (new), `lookupTypeContext.ts` (`checkErrorDetails`), `recordFindings.ts` (`sharedRecordFinding`)
- `components/builder/shared/checkErrorPresentation.ts` (the `platform-unavailable` branch)
- `lib/commcare/suite/case-search/compileForPlatform.ts` moved to `searchWireShape.ts` (`searchWireShape`, platform-free); `lib/commcare/suite/case-search/types.ts` (`PlatformContext` and its `Platform` leave), `remoteRequest.ts` (`DEFAULT_PLATFORM_CONTEXT` and `platformContext` leave); their importers at `main`: `lib/commcare/compiler.ts`, `lib/commcare/suite/case-list/shortDetail.ts`, `lib/commcare/suite/case-search/searchSession.ts`, `inlineSearch.ts`, `lib/commcare/types.ts`, `lib/commcare/hqJson/caseList.ts`, `lib/commcare/hqShells.ts`, `lib/domain/modules.ts` (a comment), `components/preview/screens/CaseListScreen.tsx` and `proof/corpus/footprint.ts`
- `lib/commcare/surface/platformFeatureEntries.ts` (new); `lib/commcare/surface/entries/application-and-settings.json` (the Connect entry, the `40-hq-cloudcare-enabled` flip), `case-search.json` (skip-to-results' citation), `entries/gates.json` (`toggle/COMMCARE_CONNECT`, `privilege/cloudcare`)

**Nova tests and fixtures named outright**

- `lib/domain/__tests__/platforms.test.ts`, `platformUses.test.ts`, `platformFeatureFixtures.ts` (all new)
- `lib/doc/__tests__/mutations-app.test.ts`, `mutationAdmission.test.ts`, `diffDocsToMutations.fuzz.test.ts`, `incrementalValidationScope.test.ts`; `platformDeclarationCommit.test.ts`, `platformDeclaration.test.ts` (part 09 §5's planner cases, part 08 §3.4's wrapper cases, and part 03 §9's case of the split clearing `PLATFORM_FEATURE_UNAVAILABLE` under a Web Apps declaration), `userFacingErrorsPlatforms.test.ts` (all three new)
- `lib/commcare/validator/__tests__/platformAvailability.test.ts`, `recordPlatformFinding.test.ts`, `lib/commcare/validator/rules/__tests__/platforms.test.ts` (part 01's and part 03 §9's cases) (all new)
- `lib/commcare/surface/__tests__/platformFeatures.test.ts` (new), `loadManifest.ts` (new, moved out of `manifest.test.ts`), `manifest.test.ts`
- `lib/commcare/suite/case-search/__tests__/searchWireShape.test.ts` (moved from `compileForPlatform.test.ts`, extended); `lib/commcare/__tests__/platformQuestionPages.test.ts` (new)
- `lib/agent/tools/__tests__/configureConnect.test.ts`; `lib/db/__tests__/commitGuardedBatch.postgres.test.ts`
- `lib/__tests__/docHelpers.ts` (`buildDoc` derives the declaration from its content, part 01 §11.3). A document `buildDoc` builds already holding its refusable feature needs no edit: the Connect fixtures `lib/commcare/__tests__/connectWireFixtures.ts`, `instanceReadFixture.ts`, `constraintMessageEmission.test.ts`, `lib/doc/__tests__/hooks-useAppConnectIds.test.tsx`, `lib/agent/tools/shared/__tests__/connectIds.test.ts`, `lib/domain/__tests__/expressionSource.test.ts` and `lib/commcare/validator/__tests__/formContent.test.ts` are read and left as they are.
- **The rule for every other test** (part 01 §11.3): a test whose document reaches a gate holding a refusable feature, or gains one by a gated write in the test (a mutation, a store action, an SA or MCP tool, a builder gesture in a spec), gives that document `appSettings: { ...NEW_APP_SETTINGS, runsOnlyOn }` up front, `"android"` for Connect, a date-and-time question, `here()` in a calculated column or (from pull request 10) the case list search text, `"web-apps"` for Search first, several-case selection, a single-date or multiple-choice Search field or (from pull request 10, under outcome A of the window width gate) the window width; a test whose contract is the platform refusal keeps a both app and asserts the refusal. No test can narrow first, since `updateApp`'s `runs_only_on` arrives in pull request 12 and the builder's platform section in pull request 11. Pull request 4 runs part 01 §11.3's `rg` command at its base (239 files at `main`), reads every hit, and edits each test the rule reaches; at `main` these are:
  - built without `buildDoc` or spread past its derivation: `lib/doc/__tests__/blueprintMutationCommands.test.ts` (`connectBp`), `identifierVerdicts.test.ts` (`connectDoc`), `lib/agent/__tests__/tools/sharedToolsSmoke.test.ts`, `lib/agent/__tests__/blueprintHelpers.updateForm.test.ts`, `lib/domain/__tests__/blueprintTopology.test.ts`, `lib/commcare/__tests__/projectSpaceCompatibility.test.ts` and `lib/db/__tests__/blueprintClearNestedField.postgres.test.ts`, each `"android"`; `e2e/lib/builder-workflows-fixtures.tsx` (`collection`), `"web-apps"`;
  - given a refusable feature by a gated write, `"android"`: `lib/session/__tests__/store.test.ts` (`createConnectTestStores`), `lib/doc/__tests__/connectTargetState.test.ts`, `lib/agent/tools/__tests__/configureConnect.test.ts` (every existing case that turns Connect on), `constructionFuzz.test.ts`, `editFieldConversionConsent.test.ts` ("a total flip never consults the impact lookup"), `lib/agent/authoring/__tests__/input.test.ts`, `readContract.test.ts`;
  - given a refusable feature by a gated write, `"web-apps"`: `lib/agent/tools/case-list-config/__tests__/configureCaseSelection.test.ts`, `lib/doc/__tests__/caseSelectionMutations.test.ts`, `lib/agent/tools/case-search-config/__tests__/setCaseSearchAdvanced.test.ts`, `e2e/lib/case-workspace-surface-client.tsx` (its `selection` and `results` scenarios, which `e2e/tests/browser/case-workspace-surface.spec.ts` drives);
  - read and left as they are: `lib/doc/__tests__/commitCrossScopeRules.test.ts` (its Connect case asserts its code with `toContain`) and `lib/mcp/__tests__/sharedToolAdapter.postgres.test.ts` (its `configure_connect` call is refused as input before any gate).
- **The e2e seeds that hold a date-and-time question**, which `buildDoc` derives Android only, so that from pull requests 8 and 9 Preview plays them as Android. Rule: where a spec's subject is not the date-and-time question, the question becomes a date question in this pull request and the seed stays on both platforms with the spec unchanged; where it is, the seed declares Android only and the spec is rewritten to Android's screens, its values in pull request 8 and its screens in pull request 9 (part 06 §25). Read at `main`, each seed and spec:
  - `e2e/lib/preview-repeats-client.tsx` (`languageDoc`, the datetime `recorded_at`), read by `e2e/tests/browser/preview-repeats-audit.spec.ts`'s first test, which types partial clocks into the question's time half across language switches: its subject, so `languageDoc` declares Android only and the test is rewritten. The client's other documents hold no date-and-time question, and the spec's other tests are unchanged.
  - `e2e/lib/preview-language-screen-doc.ts` (the datetime `when`), read by `e2e/tests/browser/preview-language-screen.spec.ts`, whose tests hold the question's partial clock drafts through held language and path replacements: its subject, so the document declares Android only and the spec is rewritten.
  - `e2e/lib/caseWorkspaceSeed.ts` (`@seed:workspace`, the tile form's datetime `visit_started`): `e2e/tests/app/preload-arrival.spec.ts` (the preload's arrival, read through the date half), `builder-layout-audit.spec.ts`, `inspector-resize.spec.ts` and `authed.spec.ts`'s form-settings and edit-canvas tests do not take it as their subject, so `visit_started` becomes a date question, the seeded rows write `row.lastVisit` for it, and those specs are unchanged. `authed.spec.ts`'s "temporal questions show their stored answers, hold their row geometry, and refuse a half-typed clock" keeps its date and time questions on this seed: its clock steps read the time question `next_dose`, `SEEDED_TEMPORAL_DISPLAY.visitStartedTime` leaves, and its date-and-time case (a stored answer with a zone designator shown, not blanked) is held by the rewritten Android-only `preview-repeats-audit.spec.ts`, whose question starts from such a value.
  - `e2e/lib/smokeSeedFactory.ts`'s `datetime` is a lookup column, not a question, and `searchFirstSeed.ts`, `previewRuntimeSeeds.ts`, `preview-cases-client.tsx` and `builder-controls-client.tsx` hold none.
- The corpus producer fixtures of part 08 §3.1 in `lib/commcare/__tests__/` (`caseCaptureFixture.ts`, `extensionCaseFixture.ts`, `caseListEmissionFixture.ts`, `endpointWireFixture.ts`, `csqlFunctionFixture.ts` (`csqlArgumentFixture`), `compilerNavigationFixture.ts` (`temporalSearchFixture`), `nestedMenuWireFixture.ts`, `noMatchesWireFixture.ts`, `searchPromptFixture.ts`, `searchEmissionFixture.ts`, `caseOperationFixture.ts`), `expander.test.ts`, `xformDocArbitrary.ts` and `suiteDocArbitrary.ts` (`lowerToDoc` ends in `declaredForContent`)

**The lane**

- `proof/corpus/editKinds.ts` (`setConnectType` narrows), `proof/corpus/__tests__/fuzzSample.test.ts`, `editBatches.test.ts`
- `proof/targeted/documents/formLinksHiddenFallback.ts`, `inlineSearchReads.ts`, `multiSelectDestinations.ts`, `noMatchesReturnIdentity.ts`, `sessionReads.ts`, `datetimeOrdering.ts` (Android only; its header), `connectApps.ts` (D and D′), `formShapes.ts::invalidConnectIds`
- `proof/targeted/documents/platformDeclaration.ts` (new), `proof/targeted/index.ts`
- `proof/walk-stops.json` (26 to 25), `proof/webapps/conftest.py`, `proof/webapps/test_generated_groups.py` (`DOCUMENTS` drops `case-operation-sequence`, and its module docstring), `proof/formplayer/test_case_blocks.py` (its docstring: it keeps `case-operation-sequence`, part 08 §7.3)
- `proof/checks/test_corpus.py` (the census test)

**The research**

- `docs/research/2026-09-26-hq-round-trip/inventory/application-and-settings.md`, `case-search.md`, `gates.md` (part 02 §5)
- `docs/research/2026-09-26-hq-round-trip/harness-findings.md` (finding 74 closed)

**Docs**

- `CLAUDE.md`, `lib/domain/CLAUDE.md`, `lib/doc/CLAUDE.md`, `lib/domain/expression/CLAUDE.md`, `lib/commcare/CLAUDE.md` (the rows marked 4)
- `proof/CLAUDE.md` (the Connect bullet), `proof/README.md` ("Walk stops", "Connect in the unit", "The corpus" gains "Platforms", "Targeted documents")

### Pull request 5: Publish, Web Apps

**Nova source**

- `lib/commcare/hqShells.ts` (`applicationShell`'s required `cloudcareEnabled`), `lib/commcare/types.ts` (`HqApplication.cloudcare_enabled`), `lib/commcare/expander.ts`
- `lib/commcare/planPrivileges.ts` (`cloudcare` first), `lib/commcare/planPrivilegePlans.json`
- `lib/commcare/surface/entries/application-and-settings.json` (the two emission cells only, part 02 §6)
- `lib/commcare/multimedia/hqJsonExportArchive.ts` (`runsInWebApps`)
- `lib/publish/planFeatures.ts` (`web-apps`, `namesInWords`, `webAppsWhereMissing`, `PlatformNarrowing`, `where_missing` on the checks; `webAppsOffText` removed), `lib/publish/webApps.ts` (new), `lib/publish/manualImportGuide.ts` (the `web-apps` step)
- `lib/deployment/webApps.ts` (new: `webAppsChange`, `baselineWebApps`, `createdWithoutWebApps`, `webAppsMovedDuringPush`), `lib/deployment/platformNarrowing.ts` (new)
- `lib/deployment/types.ts`, `confirmations.ts`, `preflight.ts` (the `web-apps` edge, `planLacksWebAppsFailure`), `service.ts`, `store.ts` (`withdraw` on the resources fold; `targetWebAppsEnabled` removed), `setupArtifact.ts`, `runtimeTarget.ts` (`not-declared-for-android`, `WEB_APPS_ONLY_HAS_NO_CCZ`), `downloadTarget.ts`, `actions.ts` (`webAppsOnly`)
- `lib/db/pg.ts` (`AppDeploymentsTable` loses the column)
- `lib/case-store/migrations/20261101000000_hq_round_trip_platforms_web_apps_read.ts` (new), `lib/case-store/migrations/index.ts`
- `app/api/commcare/upload/route.ts` (`confirmWebApps`; `web_apps_enabled` removed)
- `lib/mcp/tools/uploadAppToHq.ts`, `compileApp.ts`, `checkProjectSpaceCompatibility.ts` (`where_missing`), `lib/mcp/errors.ts`
- `components/builder/publishOutcome.ts`, `components/builder/PublishDialog.tsx`, `components/builder/app-setup/publishingSectionModel.ts`

**Nova tests named outright**

- `lib/commcare/__tests__/hqJsonOracle.test.ts`, `addOns.test.ts`, `targetOverlay.test.ts`, `planPrivileges.test.ts`; `app/api/compile/__tests__/route.test.ts`
- `lib/deployment/__tests__/importApplication.test.ts`, `webApps.test.ts` (new), `hqSourceBaseline.test.ts`, `setupArtifact.test.ts`, `runtimeTarget.test.ts`, `leftBehindResources.test.ts`, `resources.test.ts`, `stateMachine.test.ts`
- `lib/deployment/__tests__/publishGates.postgres.test.ts`, `confirmations.postgres.test.ts`, `store.postgres.test.ts`, `downloadTargetsAction.postgres.test.ts`, `publishSequence.postgres.test.ts`
- `lib/mcp/__tests__/compileApp.postgres.test.ts`, `uploadAppToHq.postgres.test.ts`, `deploymentTools.postgres.test.ts`, `entryPointLink.postgres.test.ts`, `provisionWorkers.postgres.test.ts`, `compatibility.postgres.test.ts`
- `app/api/apps/[id]/stream/__tests__/stream.postgres.test.ts`, `app/api/commcare/upload/__tests__/route.test.ts`
- `components/builder/__tests__/publishOutcome.test.ts`, `components/builder/app-setup/__tests__/publishingSectionModel.test.ts`, `lib/publish/__tests__/manualImportGuide.test.ts`
- `lib/case-store/migrations/__tests__/webAppsRead.postgres.test.ts` (new)
- `e2e/tests/browser/publishing.spec.ts`, `e2e/lib/publishing-client.tsx`

**The capture and the lane**

- `proof/corpus/publish.ts` (`cloudcareGranted`, `AssumedSource.cloudcare_enabled`, the first-publish throw, `updateStep`'s Web Apps question, `sendContent`'s second-read throw, the stop loop, `localCcz` returning `null`), `proof/corpus/targetPeer.ts` (`TargetState.cloudcareGranted`, `shellSource`)
- `proof/corpus/entryWriter.ts` (no local archive without Android), `writePublishCaptures.ts`, `emitCorpus.ts` (`refusal`'s `ccz` mode), `proof/corpus/__tests__/publish.postgres.test.ts`, `publishReadiness.test.ts`, `writePublishCaptures.test.ts`
- `proof/observe/publish.py` (`create` and `update` gain `plan_without_web_apps`, which drops only `cloudcare_enabled` from the content's hold), `proof/webapps/hq.py::project` and `proof/editors/test_plan_features.py`'s `_published` (each passes it; part 05 §12)
- `proof/targeted/build.ts` (the `"local"` expectation refused without Android), `proof/targeted/__tests__/targeted.test.ts`, and the expectations of `formLinksHiddenFallback.ts`, `inlineSearchReads.ts`, `multiSelectDestinations.ts`, `noMatchesReturnIdentity.ts` moved to `"A"`, `sessionReads.ts`' loop without `"local"`
- `proof/checks/intent.py` (`web_apps_setting`), `proof/checks/test_intent.py`, `proof/checks/test_corpus.py` (`PLAN_PRIVILEGES` gains `CLOUDCARE`; the local-archive presence assertion)
- `proof/hq/test_plan_features.py` (`NOVA_LABELS`), `proof/hq/test_publish.py` (the update test's body carries `cloudcare_enabled`; the new create test; `ARCHIVE_DOCUMENT` becomes `case-list-local`), `proof/hq/conftest.py` (`DOCUMENTS` gains `case-list-local`, and its comment names the publish tests' documents again), `proof/editors/test_plan_features.py` (the settings-save test, new)
- The lane's three readers of a local archive that a document declaring Web Apps only no longer has, each in the pull-request lane: `proof/hq/test_publish.py::test_a_working_app_serves_what_a_ccz_names` reads `case-list-local`'s archive (it runs on both, its module's Search gives the suite the `query` URLs the test resolves, and its follow-up form serves the related-case test that reads the same document), where `case-list-inline` declares Web Apps only from pull request 4; `proof/rules/test_xpath_reading.py::_texts` reads the archive of each `DOCUMENTS` id that has one, and `proof/rules/conftest.py::DOCUMENTS` gains `case-list-local`, the same case list fixture's form, while keeping `case-list-inline`, whose HQ build `test_stored_position_keys.py` reads; `proof/native/steps/session_reads.py::session_reads` copies a local archive only where the document has one, and `proof/native/core/SearchRuntimeTest.java::formReadsTheResultsItsSearchReturned` reads `targeted-inline-search-reads` (Web Apps only) through HQ's regenerated form and hand-assembled suite alone, which is what Web Apps runs
- `proof/webapps/test_session.py` (the listing-and-402 test rewritten by part 05 §15; the declaration listing test, new, by part 08 §7.2), `proof/webapps/conftest.py` (`targeted-platform-declaration`)
- `proof/controls/targeted-list-first-web-apps-declared/` (new, part 08 §2.5), retained from this head's lane: `gh run download <run id> -n proof-corpus-<attempt>.tar.zst -D <dir>`, then `mkdir <dir>/corpus && zstd -dc <dir>/proof-corpus-<attempt>.tar.zst | tar -x -C <dir>/corpus`, then `python3 -m proof.checks.controls <dir>/corpus targeted-list-first-web-apps manifest --as targeted-list-first-web-apps-declared`

**The research and docs**

- `docs/research/2026-09-26-hq-round-trip/inventory/application-and-settings.md` (the `40 hq.cloudcare_enabled` Emission cell)
- `docs/research/2026-09-26-hq-round-trip/harness-findings.md` (finding 64's step 4 sentence)
- `CLAUDE.md`, `lib/commcare/CLAUDE.md`, `lib/deployment/CLAUDE.md`, `lib/export/CLAUDE.md` (the rows marked 5)
- `proof/README.md` ("The defect rows", row 21's checks column)

### Pull request 6: Publish, defect 20

**Nova source**

- `lib/commcare/planPrivileges.ts` (`formEntrySyncReasons`)
- `lib/commcare/surface/entries/gates.json` (`project-space-setting/CaseSearchConfig.sync_cases_on_form_entry`'s `content` cell, part 02 §6.2)
- `lib/publish/planFeatures.ts` (`FORM_ENTRY_SYNC_OFF`, `PROJECT_SPACE_SETTING_KINDS`, `PROJECT_SPACE_SETTINGS`, `formEntrySyncWhereMissing`), `lib/publish/manualImportGuide.ts` (the `form-entry-sync-off` step)
- `lib/commcare/multimedia/hqJsonExportArchive.ts` (`formEntrySync`)
- `lib/deployment/types.ts` (`DEPLOYMENT_CONFIRMATION_KINDS`, the key and its schema), `lib/deployment/confirmations.ts`
- `lib/db/pg.ts` (the kind comment)
- `lib/case-store/migrations/20261101010000_hq_round_trip_platforms_form_entry_sync.ts` (new), `lib/case-store/migrations/index.ts`
- `app/api/commcare/project-space-compatibility/route.ts` (its header comment)
- `lib/mcp/tools/uploadAppToHq.ts` (`confirm_form_entry_sync_off`), `withdrawDeploymentConfirmation.ts`, `checkProjectSpaceCompatibility.ts`
- `components/builder/PublishDialog.tsx`, `components/builder/PublishPanel.tsx`, `components/builder/app-setup/publishingSectionModel.ts`, `components/docs/ProjectSpaceCapabilityCatalog.tsx`

**Nova tests named outright**

- `lib/commcare/__tests__/planPrivileges.test.ts`; `lib/case-store/migrations/__tests__/formEntrySyncConfirmation.postgres.test.ts` (new)
- `lib/deployment/__tests__/confirmations.postgres.test.ts`, `publishGates.postgres.test.ts`, `publishSequence.postgres.test.ts`
- `components/builder/app-setup/__tests__/publishingSectionModel.test.ts`, `lib/publish/__tests__/manualImportGuide.test.ts`
- `lib/mcp/__tests__/uploadAppToHq.postgres.test.ts`, `deploymentTools.postgres.test.ts`, `compatibility.postgres.test.ts`
- `e2e/tests/browser/publishing.spec.ts`

**The capture and the lane**

- `proof/corpus/publish.ts` (`minimumConfiguration.syncCasesOnFormEntry`), `proof/corpus/entryWriter.ts` (the sync-on refusal), `proof/corpus/__tests__/publish.test.ts`, `emitCorpus.test.ts`, `publish.postgres.test.ts`
- `proof/targeted/documents/searchApps.ts` (`syncOnFormEntry()` without `projectSettings`; `syncOnFormEntryWebApps()`, new), `proof/targeted/index.ts`
- `proof/checks/registers.py` (`OPEN_DEFECTS` drops `20`, its comment), `proof/checks/test_registers.py` (`test_every_live_defect_is_a_later_steps`: its docstring, and its assertion `step > 3` becomes `step > 4`, so no live defect is step 4's)
- Defect 21's `requests` entry, `d21-list-first-turned-search-fir-trace-case-list-trace-requests`, by the lane's outcome (part 08 §2.4): A, its `document` becomes `targeted-sync-on-form-entry-web-apps` in `proof/known-defects.json`; B, it moves to `proof/fixed-defects.json` on the retained control `targeted-sync-on-form-entry`

**The research and docs**

- `docs/research/2026-09-26-hq-round-trip/inventory/gates.md` (the publish-checks paragraph's sync phrase, part 02 §6.2)
- `lib/commcare/CLAUDE.md`, `lib/deployment/CLAUDE.md`, `lib/db/CLAUDE.md` (the rows marked 6)
- `proof/README.md` ("The defect rows", row 20)

### Pull request 7: Media by platform

**Nova source**

- `lib/domain/multimedia.ts` (`MEDIA_FORMAT_KEYS`, `MEDIA_FORMATS`, `MediaFormatValue`, `mediaFormatValueSchema`, `mediaFormatOf`, `mediaFormatPlaysOn`, `mediaFormatLabel`; the six entries; `surfaceKeys` removed; `imageFormatNoun`)
- `lib/media/mp4.ts`, `wav.ts`, `ico.ts`, `amr.ts`, `midi.ts`, `platformPlayback.ts` (all new); `lib/media/validate.ts` (the dispatch, `mediaFormat`, `classifyStoredMediaBytes`, `SVG_REFUSAL_MESSAGE`, the MKV rules), `lib/media/webm.ts` (MKV through its rules), `lib/media/attachVerdicts.ts` (the platform line), `lib/media/moveMedia.ts`, `lib/media/builtinIconAssets.ts`
- `lib/db/pg.ts`, `lib/db/types.ts`, `lib/db/mediaAssets.ts` (the row, the writers, `WireMediaAsset`, `MediaReferenceRequirement.platforms`, `MediaReferenceProjectionError`'s `platform-unplayable`, `lockAndValidateMediaReferences`' second pass), `lib/db/canonicalCommitKernel.ts` (`blueprintMediaRequirements`, `admitExactMediaReferences`), `lib/db/runtimeDatabaseProbe.ts`
- `lib/case-store/migrations/20261101020000_hq_round_trip_platforms_media_format.ts` (new), `lib/case-store/migrations/index.ts`
- `app/api/media/upload/route.ts` (the SVG sentence), `app/api/media/upload/[assetId]/confirm/route.ts` (`mediaFormat`)
- `lib/mcp/tools/uploadMediaAsset.ts` (`mediaFormat`; the description of part 04 §5.4)
- `lib/commcare/validator/rules/media/mediaFormatPlays.ts` (new), `rules/media/index.ts`, `lib/commcare/validator/errors.ts`, `gate.ts`, `runner.ts`; `lib/doc/userFacingErrors.ts` (`MEDIA_FORMAT_NOT_PLAYED`)
- `lib/session/store.ts` (`AssetMetaRow`)
- `components/builder/media/useAttachBudget.ts` (the platform arm), `useReferencedAssetRows.ts` (new), `MediaStandIn.tsx` (new), `MediaDisplay.tsx`, `AssetPreviewDialog.tsx`, `MediaPickerDialog.tsx` (the SVG sentence)
- `lib/commcare/surface/media-formats.json`, `entries/expressions-and-data.json` (part 02 §7)
- `scripts/rollout/verify-runtime-packages.mjs` (the ADTS and AVIF probes)

**Nova tests and fixtures named outright**

- `lib/media/__tests__/mp4.test.ts`, `wav.test.ts`, `ico.test.ts`, `amrMidi.test.ts`, `platformPlayback.test.ts` (all new), `validate.test.ts`, `attachVerdicts.test.ts`, `boundaryValidation.test.ts`, `moveMedia.test.ts`
- `lib/media/__tests__/builtFixtures.ts` (new) and the committed files of part 04 §8.2 under `lib/media/__tests__/fixtures/`; `lib/media/__tests__/fixtures/tiny-video.mp4` (re-encoded H.264 Main)
- `lib/commcare/validator/rules/media/__tests__/mediaFormatPlays.test.ts` (new)
- `lib/db/__tests__/addReferencingApp.postgres.test.ts`, `mediaAssetDoc.postgres.test.ts`, `runtimeDatabaseProbe.test.ts`, and every Postgres suite that inserts a ready media row, which writes its format (part 04 §5.3: `lib/db/__tests__/*.postgres.test.ts`, `lib/deployment/__tests__/publishGates.postgres.test.ts`, `publishSequence.postgres.test.ts`, `lib/mcp/__tests__/compileApp.postgres.test.ts`, `uploadAppToHq.postgres.test.ts`, `lib/agent/__tests__/sourceDocuments.postgres.test.ts`, `documentExtractionStore.postgres.test.ts`, `proof/corpus/__tests__/publish.postgres.test.ts`)
- `lib/case-store/migrations/__tests__/mediaFormat.postgres.test.ts` (new; the one file for both media-format migrations)
- `lib/mcp/__tests__/uploadMediaAsset.postgres.test.ts` (`lib/mcp/__tests__/servedSchemas.test.ts` runs unchanged: it compiles every served input schema and reads no description)
- `app/api/media/upload/[assetId]/confirm/__tests__/route.test.ts`, `app/api/media/upload/__tests__/route.test.ts`
- `lib/commcare/__tests__/mediaWireFixtures.ts` (`mediaManifest` with formats; `mediaWireFixture(mediaOnly, formats)`), `mediaWireFixtures.test.ts` (new); `lib/commcare/surface/__tests__/manifest.test.ts` (the accepted formats block); `lib/domain/__tests__/multimedia.test.ts`; `lib/case-store/migrations/__tests__/mediaUploadAliases.postgres.test.ts`
- The tests whose ready media rows meet a judgment, each writing the format its bytes are or its MIME's stand-in key (part 04 §10, found by `rg -l 'status: "ready"'` over test files and `e2e` and narrowed to rows the kernel, the export boundary, the attach verdict or the builder judges): `app/api/compile/__tests__/route.test.ts` (`ROW` gains `mediaFormat: "png"`, the audio variant of "runs the real media gate before downloading a mismatched asset" `mp3`), `__tests__/integration/media-validation.test.ts`, `proof/corpus/__tests__/publishReadiness.test.ts`, `lib/commcare/validator/rules/media/__tests__/fixtures.ts`, `lib/agent/tools/media/__tests__/fixtures.ts`, and the Playwright specs `e2e/tests/app/media-library.spec.ts`, `e2e/tests/browser/builder-controls.spec.ts`, `media-authority.spec.ts`, `chat-controls-audit.spec.ts`, `case-workspace-audit.spec.ts`
- `e2e/tests/browser/media-play.spec.ts`, `e2e/tests/app/preview-android-media.spec.ts` (new) with its seed profile `preview-android-media` (an Android-only app with a real ready AMR row on a label audio, read through the real resolve route) in `e2e/lib/smokeProfiles.ts`, `smokeSeedFactory.ts`, `previewRuntimeSeeds.ts` and `previewRuntimeSeeds.test.ts`
- `proof/android/decode/DecodeProbe.java` (images by extension, part 04 §8.5)

**The lane**

- `proof/corpus/editBatches.ts` (`readyRow`'s stand-in key), `proof/corpus/__tests__/editBatches.test.ts`
- `proof/webapps/test_media_slots.py`, `proof/formplayer/media_slots/targeted-media-slots.form.xml`, `media-rich.form.xml` (the three hash literals)
- `proof/checks/manifest_value_classes.py` (`svg_image`), `proof/checks/test_manifest_value_classes.py`
- `proof/native/producers/emit-media-evidence.ts` (`svgRefusedScenario`, the one deliberately inadmissible emission, built without `runValidation`, part 04 §8.3; `refusedImageScenario(file)`, emitting `media-svg-refused` and `media-avif-refused`, where the AVIF gate shows HQ refusing the AVIF), `proof/native/steps/media_emission.py` (`FORMAT_SCENARIOS`), `proof/native/test_media_emission.py`, `proof/native/core/MediaRuntimeTest.java`
- `proof/android/decode/probe.py` (`ACCEPTED`), `proof/android/decode/run.sh`

**The research and docs**

- `docs/research/2026-09-26-hq-round-trip/inventory/expressions-and-data.md` (part 02 §7.1)
- `CLAUDE.md`, `lib/media/CLAUDE.md`, `lib/domain/CLAUDE.md`, `lib/session/CLAUDE.md` (the rows marked 7); `proof/README.md` (the native `media` family's three scenarios)

### Pull request 8: Preview, the model

**Nova source**

- `lib/preview/platform.ts` (new), `lib/preview/engine/previewDevice.ts` (new), `lib/preview/formlessCaseListRoute.ts` (new)
- `lib/session/store.ts` (`previewPlatform`, `previewAtDeviceHome`, `previewDeviceSyncedAt`, `previewAndroidDeviceId` and their actions; `setPreviewing(on, at?: { atHome })`, part 06 §3.1), `lib/session/hooks.tsx`, `lib/session/viewerPosition.ts`; `components/builder/usePreviewModeTransition.ts` (passes `atHome`), `components/builder/BuilderLayout.tsx`, `BuilderHeader.tsx`, `PreviewToggle.tsx`, `useBuilderShortcuts.ts` (the setter's type carries it)
- `lib/preview/engine/identity.ts`, `formEngine.ts`, `triggerDag.ts`, `previewAuthorization.ts`, `geopointValue.ts`, `runtimeBindings.ts`, `viewerLocation.ts`, `searchInputConstraints.ts`, `evaluateForm.ts`, `evaluateFormSnapshot.ts`, `engineController.ts`, `serverSearchRead.ts`, `postSubmissionEvaluation.ts`, `searchEvaluation.ts`, `caseDataBinding.ts`, `caseDataBindingHelpers.ts` (`readCases`' `tileGrouping`, the device in the submission program), `xpathInstances.ts`, `sectionPaging.ts`
- `lib/preview/xpath/coreDays.ts`, `coerce.ts`, `evaluator.ts`, `asyncEvaluator.ts`, `operatorSemantics.ts`, `functions.ts`, `scalarJavaRosaFunctions.ts`, `nodeSetJavaRosaFunctions.ts` (the day-number epoch in `EvalContext`), `types.ts`, `workerProtocol.ts` (protocol 9) and the worker runtime that builds its `EvalContext`
- `lib/preview/afterSubmitRouting.ts`, `entryPointLaunch.ts`, `entryPointLaunchAction.ts`, `caseListPhase.ts`, `caseTileRendering.ts`, `caseTileGrouping.ts`, `columnDisplay.ts`, `runtimeMessages.ts` (every key of part 06 §6 to §16 but §8.3's two, which pull request 9 adds under outcome A), `hooks/useSearchCsqlRuntime.ts`, `hooks/usePreviewScreenForLocation.ts`, `hooks/useSearchInputRunState.ts`, `hooks/useSectionPages.ts` moved to `useFormScreens.ts` with its importers
- `lib/routing/previewBreadcrumbs.ts`; `lib/domain/captureFormats.ts` (`CAPTURE_LIMITS`, `MAX_CAPTURE_BYTES_ON_ANY_PLATFORM`; `MAX_CAPTURE_BYTES` removed)
- `app/api/apps/[id]/attachments/route.ts`, `app/api/apps/[id]/attachments/[attachmentId]/route.ts` (existing routes; no new `/api` route); `components/preview/form/fields/attachment/AttachmentField.tsx` (its limit line reads `CAPTURE_LIMITS[platform].maxBytes` for the effective platform, and its upload body sends the platform and `File.type` the route now requires; pull request 9 adds only its per-platform controls)
- `lib/case-store/store.ts`, `lib/case-store/postgres/store.ts` (`SearchPopulation.onlyOutsideRestore`, part 06 §8.2), `lib/case-store/postgres/submissionAttachments.ts`; `lib/case-store/migrations/20261101025000_hq_round_trip_platforms_android_capture_size.ts` (new), `lib/case-store/migrations/index.ts`
- `lib/preview/app-tests/types.ts`, `context.ts`, `run.ts`, `submission.ts`, `navigation.ts`, `details.ts`, `records.ts`, `service.ts`; `lib/db/appTests.ts` (`RUNTIME_VERSION` 17)
- `lib/agent/tools/appTests.ts`, `lib/agent/tools/evaluateForm.ts`, `lib/agent/authoring/evaluationContext.ts`
- `lib/models.ts` (`"v5-hq-round-trip-platforms.8"`); `scripts/test-schema.ts` (`startAppTest` registered with its import and its name in "Known names"; `evaluateForm`'s prompt)
- `components/preview/screens/FormScreen.tsx`, `CaseListScreen.tsx`, `ModuleScreen.tsx` (routing and session reads), `components/preview/PreviewShell.tsx`, `components/builder/BreadcrumbStrip.tsx`, `components/preview/EntryPointPreviewLaunch.tsx`

**Nova tests named outright**: part 06 §27's pull request 8 list, among them the existing suites whose engine now runs as Web Apps where no device is given (the `sectionPages()` callers, renamed `formScreens()`, and `components/preview/form/fields/geopoint/__tests__/geopointValue.test.ts`, extended), each resolved there. The specs and their peers (part 06 §25): `e2e/tests/browser/preview-repeats-audit.spec.ts` (the expected location's spelling, and the values of the first test pull request 4's list rewrites), `preview-section-paging-lifecycle.spec.ts` with `e2e/lib/preview-section-paging-client.tsx`, and `preview-form-lifecycle-audit.spec.ts` with `e2e/lib/preview-form-lifecycle-client.tsx` (an Android device for the paging tests). `lib/mcp/__tests__/servedSchemas.test.ts` runs unchanged: the added `platform` enum brings no pattern and the file reads no description.

**Docs**: `CLAUDE.md`, `lib/preview/CLAUDE.md`, `lib/session/CLAUDE.md`, `lib/preview/app-tests/CLAUDE.md`, `lib/domain/CLAUDE.md` (the rows marked 8).

### Pull request 9: Preview, the screens

**Nova source**

- `components/preview/screens/DeviceHomeScreen.tsx`, `components/preview/form/fields/geopoint/RecordLocationField.tsx`, `components/preview/form/fields/attachment/AudioRecorder.tsx`, `components/preview/form/fields/BarcodeField.tsx`, `components/preview/shared/BarcodeScanner.tsx`, `components/preview/form/RepeatAddPrompt.tsx` (all new)
- `components/builder/PreviewIdentityMenu.tsx`, `AppTestHistory.tsx`, `detail/appSettings/AppAppearanceSection.tsx` (the logo line); `components/preview/screens/HomeScreen.tsx`
- `components/preview/shared/SearchInputForm.tsx`, `CaseTile.tsx`, `CaseTileGroup.tsx`
- `components/preview/form/FieldRenderer.tsx`, `FieldHelp.tsx`, `InteractiveFormRenderer.tsx`, `fields/SelectOneField.tsx`, `SelectMultiField.tsx`, `RepeatField.tsx`, `GroupField.tsx`, `ValidationError.tsx`, `MediaField.tsx`, `fields/geopoint/GeopointPicker.tsx`, `fields/attachment/AttachmentField.tsx` (its per-platform controls only; its limit and upload body are pull request 8's); `components/preview/form/sections/useSectionPaging.ts` moved to `useFormPaging.ts` with its importers; `lib/markdown.tsx`

**Tests and the lane**

- `lib/preview/__tests__/platformCells.ts`, `platformCellModels.ts`, `platformCells.test.ts`, `platformRuleReaders.test.ts` (all new; the cell test imports pull request 4's `loadManifest.ts`)
- `e2e/lib/previewPlatformScenarios.ts`, `preview-platforms-client.tsx`, `preview-device-home-client.tsx`, `preview-identity-menu-client.tsx`; `e2e/tests/browser/preview-platforms.spec.ts`, `preview-device-home.spec.ts`, `preview-identity-menu.spec.ts`; `e2e/tests/app/preview-platform-switch.spec.ts` (all new); `e2e/tests/app/builder-layout-audit.spec.ts`, `preview-here-column.spec.ts`, `app-tests.spec.ts`; the existing specs part 06 §25 resolves for Preview's Web Apps default (`e2e/tests/app/authed.spec.ts`'s "a sectioned form pages in Preview on the device's rules", which chooses Android; `e2e/tests/browser/preview-geopoint-audit.spec.ts` and `preview-geopoint-language.spec.ts` with `e2e/lib/preview-geopoint-client.tsx`, rewritten to Record location); and the screens of the two Android-only seeds' specs of pull request 4's list (`preview-repeats-audit.spec.ts`, `preview-language-screen.spec.ts`)
- `proof/targeted/documents/previewAndroidRenders.ts` (new), `proof/targeted/index.ts`; `proof/android/test_form_reads.py`, `test_case_lists.py`, `test_navigation.py` (part 06 §24's three tests), `proof/android/src/nova/proof/android/Views.java` (`gravity`)
- By part 06 §24.3's observed outcome: A, `lib/preview/unheldCaseSubmit.ts` (new, `formChangesSessionCase`) and its test, `components/preview/screens/FormScreen.tsx`, `lib/preview/app-tests/submission.ts` and `lib/preview/runtimeMessages.ts` (`formNotProcessedTitle`, `formNotProcessedDetail`); B, `lib/preview/platform.ts` (`entryPointUnheldCaseSubmit` `"submits"` on Android)

**Docs**: `components/builder/CLAUDE.md`, `lib/preview/CLAUDE.md` (the rows marked 9); `content/docs/building-with-nova.mdx` (the `### Preview on Web Apps and Android` subsection only).

### Pull request 10: Expression reads

**Nova source**

- `lib/domain/expression/types.ts` (the `case-list-search-text` value arm in `ValueArm`, the value-kind set, `valueSchemas`), `children.ts`, `print.ts`, `profiles.ts` (`SlotProfile.caseListSearchText`, `windowWidth`), `context.ts` (`FormExpressionFacts.searchFirstModule`; the facts set in `slotContext` and `buildFormFacts`), `typeChecker.ts` (the search-input admission, the arm's admission and type, the context types)
- `lib/domain/platforms.ts`, `lib/domain/platformUses.ts` (part 01 §4.5's rows for the gate's outcome; `REFUSABLE_PLATFORM_FEATURE_IDS` gains `case-list-search-text` and, under outcome A, `window-width`; `expressionLeafFeature` for the arm and, under outcome A, `window_width`)
- `lib/commcare/xpath/formPathBinding.ts` (`stringquery` binds to the arm), `lib/commcare/xpath/wire/fromExpression.ts` (the arm, the guarded context reads), `emptyRows.ts` (`guardAbsentNode`), `formReads.ts` (the `current()` print), `lib/commcare/sessionContext.ts` (`ABSENT_CAPABLE_SESSION_CONTEXT_FIELDS`)
- `lib/commcare/csql/representability.ts`; `lib/case-store/sql/compileExpression.ts`
- `lib/commcare/validator/formLogicFindings.ts` (the three mappings and the `platform-unavailable` arm), `rules/case-list/searchInputRefUsesWhenInputPresent.ts`, `bindingResolutionOracle.ts` (`SESSION_QUERY_DATA_NAMES`), `recordFindings.ts` (outcome A's window-width subjects)
- `lib/commcare/expander.ts` (`searchAnswers` for a search-first module's forms), `lib/commcare/suite/case-list/columns.ts` (`lookupTermContext`), `orderPlanOptions.ts` (`hqExpressionField`)
- `lib/doc/userFacingErrors.ts` (`PLATFORM_BUILDER_COPY` gains the same features' builder words; `INVALID_SEARCH_REF`, `SESSION_DATUM_NOT_SUPPLIED` reason `case-list-search-text`, `XPATH_FUNCTION_CONTEXT_UNAVAILABLE` reasons `window-width` and `platform-unavailable`), `lib/doc/searchNoMatchesForm.ts` (its header comment)
- `components/builder/shared/checkErrorPresentation.ts` (the reason lines of checklist place 2)
- `lib/session/types.ts` (`PreviewCaseTarget.caseListSearchText`), `lib/preview/engine/entrySessionData.ts`, `lib/preview/noMatchesForm.ts` (`formSearchAnswers`), `lib/preview/engine/caseDataBinding.ts` (`searchAnswers`), `lib/preview/engine/formEngine.ts` (outcome B only: two session contexts), `components/preview/screens/CaseListScreen.tsx`, `FormScreen.tsx`
- `lib/agent/authoring/evaluationContext.ts` (`searchAnswers` for a search-first module's form), `lib/agent/authoring/reference.ts` (the context row and the `#search/name` sentence, part 03 §11), `lib/models.ts` (`"v5-hq-round-trip-platforms.10"`)
- `components/builder/shared/expressionEditorSchemas.ts`, `RuleFocusContext.tsx`, `ruleNavigation.ts`, `sessionContextPresentation.ts`, `cards/expression/GeneralValueCards.tsx` (`CaseListSearchTextCard`), `cards/expression/TermCard.tsx`; `lib/codemirror/expressionEditorContext.ts` (`SESSION_CONTEXT_OFFERED`, the stringquery completion)
- `lib/commcare/surface/entries/expressions-and-data.json`, `case-search.json`, `gates.json`; `lib/commcare/surface/__tests__/manifest.test.ts` (part 02 §8)
- `lib/preview/__tests__/platformCells.ts` (the rows marked (10)), `platformCellModels.ts` (outcome B's window-width checks)

**Nova tests named outright**: part 03 §9's pull request 10 list, `lib/doc/__tests__/userFacingErrors.test.ts` among them; `lib/domain/__tests__/platformFeatureFixtures.ts`, `platformUses.test.ts`, `lib/commcare/validator/__tests__/platformAvailability.test.ts` (the new rows).

**The lane**

- `proof/targeted/documents/sessionContextReads.ts`, `caseListSearchText.ts` (both new), `inlineSearchReads.ts`, `instanceReads.ts`, `proof/targeted/index.ts`
- `proof/checks/intent.py` (`formplayer_session_values`), `proof/checks/test_intent.py`
- `lib/commcare/__tests__/sessionContextFixture.ts`, `rowPredicateFixture.ts` (both new)
- `proof/native/producers/emit-expression-evidence.ts`, `proof/native/core/SessionContextRuntimeTest.java`, `RowPredicateCurrentRuntimeTest.java` (both new), `proof/native/families.py`
- Outcome A only: `proof/checks/manifest_value_classes.py` (`window_width_in_form_logic`), `proof/checks/test_manifest_value_classes.py`

**The research and docs**

- `docs/research/2026-09-26-hq-round-trip/inventory/expressions-and-data.md`, `case-search.md` (part 02 §8)
- `lib/commcare/xpath/wire/CLAUDE.md`, `lib/domain/expression/CLAUDE.md`, `lib/domain/CLAUDE.md`, `lib/commcare/CLAUDE.md`, `lib/preview/CLAUDE.md`, `lib/session/CLAUDE.md`, `components/builder/CLAUDE.md` (the rows marked 10); `proof/README.md` ("Native proofs", "Targeted documents")

### Pull request 11: Builder

- New: `components/builder/detail/appSettings/AppPlatformsSection.tsx`, `components/builder/shared/PlatformNoteRow.tsx`, `components/builder/shared/platformNotes.ts`, `components/builder/shared/findingDestination.ts`, `components/builder/shared/cards/AppLanguageValuePicker.tsx`, `lib/doc/hooks/useDeclaredPlatforms.ts`, `lib/doc/platformChangePreflight.ts` (a Server Action, no `/api` route), `lib/doc/platformChangePreflightRead.ts`, `lib/doc/platformChangePreflightTypes.ts`
- Changed: `lib/media/attachVerdicts.ts` (`mediaDeclarationVerdict`, taking the optional executor), `lib/db/mediaAssets.ts` (`loadAssetsByIds`' optional executor `db`, which the preflight's transaction passes), `lib/doc/commitVerdicts.ts` (`expressionEditVerdict`'s `platform`), `lib/doc/hooks/useBlueprintMutations.ts` (`splitDatetimeQuestion`, `addDatetimeAsTwoQuestions`), `lib/session/store.ts` (`switchConnectMode`), `lib/codemirror/expressionEditorContext.ts` (the declaration filter)
- Changed: `components/builder/detail/appSettings/AppSettingsPanel.tsx`, `AppSavedFormsSection.tsx`, `AppAppearanceSection.tsx`, `ConnectManagerDialog.tsx`, `ConnectEnableDialog.tsx`; `components/preview/form/FieldTypePicker.tsx`; `components/builder/editor/FieldIdentitySection.tsx`, `FieldInspectorBody.tsx`, `SectionInspectorBody.tsx`; `components/builder/inspector/inspectorChrome.tsx` (`ToggleRow`)
- Changed: `components/builder/case-list-config/CaseListConfigWorkspace.tsx`, `canvas/CaseSelectionSetting.tsx`, `canvas/NoMatchesFormSetting.tsx`, `noMatchesFormReview.tsx`, `inspector/SearchPanelInspectorBody.tsx`, `inspector/SearchInputEditor.tsx`, `ColumnEditor.tsx`, `cards/column/LinkColumnCard.tsx`, `tile/TileGroupingSection.tsx`, `tile/TileCellInspector.tsx`, `tile/tileModel.ts`
- Changed: `components/builder/detail/formSettings/FormEntrySection.tsx`, `components/builder/detail/moduleSettings/ModuleSettingsPanel.tsx`, `components/builder/app-setup/DeepLinksSection.tsx`, `components/builder/form-links/afterSubmitCopy.ts`, `FallbackChooser.tsx`, `components/builder/conditions/displayConditionCopy.ts` and every caller of the functions they become, `components/builder/shared/primitives/ExpressionPicker.tsx`, `shared/cards/expression/TermCard.tsx`, `shared/cards/ComparisonCard.tsx`, `shared/editorContext.tsx` (`ExpressionChangeAdmission`'s refused arm gains `platform`), `shared/ExpressionCardEditor.tsx` (`admitRuntimeExpression` copies it), `shared/workbenchAdmission.ts` (`workbenchExpressionAdmission` copies it), `components/builder/media/MediaPickerDialog.tsx`, `MediaSlot.tsx`
- Tests: `lib/doc/__tests__/platformOfferParity.test.ts`, `splitDatetimeQuestion.test.ts`, `platformChangePreflight.postgres.test.ts`, `lib/session/__tests__/switchConnectModePlatforms.test.ts`, `components/builder/shared/__tests__/findingDestination.test.ts` (all new); `lib/doc/__tests__/commitVerdicts.test.ts`, `components/builder/conditions/__tests__/displayConditionCopy.test.ts`, `components/builder/form-links/__tests__/linkSentence.test.ts`, `components/builder/shared/__tests__/workbenchAdmission.test.ts`, `lib/codemirror/__tests__/xpath-autocomplete.test.ts`; `e2e/tests/app/app-settings.spec.ts`, `e2e/tests/app/platform-offering.spec.ts` (new), and the `connect-learn` seed profile in `e2e/lib/smokeProfiles.ts` and `smokeSeedFactory.ts`
- Docs: `components/builder/CLAUDE.md`, `lib/codemirror/CLAUDE.md`, `lib/doc/CLAUDE.md`, `lib/commcare/CLAUDE.md` (the rows marked 11)

### Pull request 12: Agent

- New: `lib/agent/tools/shared/platformPrecheck.ts` (`fieldKindPlatformRefusal`, `declarationPlatformRefusal`)
- Changed: `lib/domain/platforms.ts` (`featuresNotOffered`, `platformSentenceForFieldKind`); `lib/domain/fields/datetime.ts`, `image.ts`, `audio.ts`, `video.ts`, `barcode.ts` (`saDocs`)
- Changed: `lib/agent/authoring/reference.ts` (the workflows paragraph, the generated sentences, the case-list search text sentence), `lib/agent/prompts.ts`, `lib/agent/appOverview.ts`, `lib/agent/summarizeBlueprint.ts`, `lib/agent/tools/updateApp.ts` (`runs_only_on`, its description, the empty-input message, the content and media pre-check), `addFields.ts`, `editField.ts`, `lib/agent/tools/shared/toolCallSummary.ts`, `lib/chat/toolSummary.ts`, `lib/mcp/prompts.ts` (the autonomous instruction)
- Changed: `lib/models.ts` (`"v5-hq-round-trip-platforms.12"`), `scripts/test-schema.ts` (`updateApp`'s prompt)
- Tests: `lib/agent/tools/__tests__/updateApp.test.ts`, `lib/agent/__tests__/appOverview.test.ts`, `summarizeBlueprint-settings.test.ts`, `lib/chat/__tests__/toolSummary.test.ts`, `lib/agent/authoring/__tests__/guideExamples.test.ts`; `lib/agent/tools/__tests__/updateAppMedia.postgres.test.ts`, `platformPrecheck.test.ts`, `lib/agent/authoring/__tests__/platformGuide.test.ts` (all three new)
- Docs: `lib/agent/authoring/CLAUDE.md`, `lib/agent/CLAUDE.md`, `lib/domain/CLAUDE.md` (the rows marked 12)

### Pull request 13: Cutover

- Storage: `lib/case-store/migrations/20261101030000_hq_round_trip_platforms_media_format_validated.ts` (new), `lib/case-store/migrations/index.ts`, `lib/case-store/migrations/__tests__/mediaFormat.postgres.test.ts` (the validation cases), `lib/db/designSessions.ts` (`reapStaleDesignSessionRun` exported)
- Notice: `lib/notices/migrationNotice.ts`, `lib/notices/migrationNoticeCopy.ts` (`PLATFORM_CAUSE_WORDS`, the lead, the four renderers, `next-publish-asks-more`'s settings id), `lib/notices/__tests__/migrationNotice.test.ts`, `migrationNoticeCopy.test.ts`, `components/builder/notices/__tests__/appNoticeModel.test.ts`
- Scripts and infrastructure (pull request 15 deletes the new files and removes this pull request's additions from the others): `scripts/scan-hq-round-trip-platforms.ts`, `scripts/migrate-hq-round-trip-platforms.ts`, `scripts/lib/hqRoundTripPlatforms/**` with its `__tests__/` (`mediaReader.test.ts` and the seeding helper `postgresSeed.ts` among them, part 09 §15), `config/deployment-jobs.json` (the Job contract), `Dockerfile` (the `maintenance-build` line and the `maintenance` stage's three sharp `COPY` lines, part 09 §13), `.dockerignore` (three lines), `scripts/rollout/deploy-cloud-run.py` (the allowlist arm, `PLAN_DIGEST_RE`), `scripts/infra/tests/test_deployment_policy.py`, `scripts/infra/__tests__/containerArtifacts.test.ts`, `scripts/README.md`, `docs/architecture/deployment.md` (part 09 §17's paragraph), `docs/plans/hq-round-trip/4-cutover-runbook.md` (new)
- Public docs kept: `content/docs/publishing.mdx` ("Updates to review"), `content/docs/mcp/tools.mdx` (the `get_app` row)

### Pull request 14: Contracts and public docs

- `docs/architecture/contracts.md`, `docs/architecture/complex-apps.md`, and every subtree row below marked 14 (the root `CLAUDE.md`'s rows move with their behavior, in pull requests 4, 5, 7 and 8)
- Every `content/docs` row below marked 14, `content/docs/where-workers-use-your-app.mdx` (new), `content/docs/meta.json`
- `docs/plans/hq-round-trip/README.md` (the sentence naming defect 20 among the live register's defects drops it)
- `proof/README.md` (the tables that count documents, controls and groups), `proof/timings.json` (`no-readers` from this head's fresh dispatch; `readers` follows the first nightly in an ordinary pull request)

### Pull request 15: Removal

- Deleted: `scripts/scan-hq-round-trip-platforms.ts`, `scripts/migrate-hq-round-trip-platforms.ts`, `scripts/lib/hqRoundTripPlatforms/**` with its `__tests__/`, `docs/plans/hq-round-trip/4-cutover-runbook.md`, `docs/plans/hq-round-trip/4-platforms.md` and `docs/plans/hq-round-trip/4-platforms/`
- Edited, pull request 13's additions removed and the files kept: `config/deployment-jobs.json` (the Job contract), `Dockerfile` (the `maintenance-build` line and the three sharp `COPY` lines), `.dockerignore` (the three lines), `scripts/rollout/deploy-cloud-run.py` (the allowlist arm and `PLAN_DIGEST_RE`), `scripts/infra/tests/test_deployment_policy.py` and `scripts/infra/__tests__/containerArtifacts.test.ts` (their rows), `scripts/README.md` (the entry), `docs/architecture/deployment.md` (part 09 §17's paragraph)
- Changed: `lib/db/designSessions.ts` (`reapStaleDesignSessionRun` module-private, `Promise<void>`); `docs/plans/hq-round-trip/README.md`, at its four links to this plan (part 09 §16): the steps table's step 4 row reads done and links a new "Step 4 is done" section, which names where what endures lives (the subtree contracts and `docs/architecture/`), the baseline step 4's plan read (`main` at `e9e6cd93`) and the cutover's trace; "What step 3 left to later steps" drops `4-platforms.md` from its list and names "Step 4 is done" for the deferrals step 4 took; the finding 74 paragraph says step 4 closed it, its stop held on `targeted-datetime-ordering`'s control in `proof/walk-stops.json`, and its link ("Proof") points at "Step 4 is done"; and the "Step 4's plan reads `main` at `e9e6cd93`" bullet's link ("The baseline this plan was written against") points at "Step 4 is done", which records that baseline, as the step 3 bullet beside it points at "Step 3 is done"; `docs/plans/hq-round-trip/5-case-writes-forms-navigation.md`, `6-import.md`, `7-rest-of-model.md` (their citations of this plan point at where what endures lives)

## What every pull request of the stack does

- **It is green at its own head.** Moving one fix's entries can leave another entry holding nothing
  on its document, which `proof/checks/registers.py::reconcile` refuses, so each pull request's
  lane passes at its head, not only the stack's.
- **A stored-shape change lands only where stated.** `appSettings.runsOnlyOn` (with the
  `setAppSettings` patch's `runsOnlyOn: null`) lands in pull request 4, the `convertField` `label`
  seed in pull request 3, and the `{ kind: "case-list-search-text" }` value arm in pull request 10.
  Each is optional or additive, so no fold horizon and no baseline identity moves (part 09 §1), and
  no other pull request changes what a document or a change row may hold. Database shapes move
  only through the five ledgered migrations (pull requests 5, 6, 7, 8, 13), and the App Test
  journey state gains `platform` behind `RUNTIME_VERSION` 17 (pull request 8).
- **A served-schema change is found by hash.** Every pull request runs `npx tsx
  --conditions=react-server scripts/inspect-tool-schema-hashes.ts` at its base and head (free, no
  network) and records in its description the tools whose hash moved. Expected: `startAppTest` and
  `evaluateForm` in pull request 8, `updateApp` in pull request 12, none elsewhere. A tool whose
  hash moves is registered in `scripts/test-schema.ts` by the pull request that first moves it.
- **`MODEL_CONTEXT_VERSION` moves in each pull request that changes model-facing schema or prose**:
  `"v5-hq-round-trip-platforms.8"` in 8 (`startAppTest`, `evaluateForm`),
  `"v5-hq-round-trip-platforms.10"` in 10 (what authored text accepts: the case list search text
  and the context fields, and the guide's context row), `"v5-hq-round-trip-platforms.12"` in 12
  (`updateApp`, the guide, prompts). Each is a distinct literal; the stack deploys `.12`.
- **A validator narrowing runs the corpus emission first** (no Docker, `--jobs 2`) at base and
  head, and compares the stop, the census, `index.json`'s document ids and the `(document, code,
  location)` finding multiset: pull requests 3 (R2 and R3), 4 (the platform rule and the corpus
  declarations), 7 (`MEDIA_FORMAT_NOT_PLAYED` in the corpus's publish findings) and 10 (the reads'
  admissions and refusals). A document the narrowing refuses is declared or rewritten in its
  producer, or, for a fuzz draw, mapped after the draw (part 08 §3.4); a fuzz sample is never
  drawn again.
- **A manifest flip edits its entry and its inventory row together**, in the pull request that
  makes the construct emittable (part 02, decision 5): pull requests 1, 4, 5, 7 and 10; pull
  request 3's entry is `export-use` and has no row. Pull request 6 rewrites the sync gate's content
  cell and its inventory phrase together the same way (part 02 §6.2).
- **No pull request adds an `/api` route.** Pull request 8 changes the two existing attachment
  routes and pull request 7 the two existing media upload routes; pull request 11's preflight is a
  Server Action. One added while implementing takes its `lib/hostnames.ts` allowlist entry in the
  same pull request, or the proxy answers 404 in production while localhost serves it.
- **No pull request runs a served reader on the person's machine.** A reader run is a dispatch on
  GitHub's runners, started by the person (part 08 §6.3).

## Ordering constraints

| Constraint | Reason |
|---|---|
| This plan's own pull request beneath the stack | It writes the deferral notes into the outlines that receive them before any of step 4's code lands: `6-import.md` (part 03, "Notes for later steps", and §2.14's read-back sentence), `7-rest-of-model.md` groups 3 and 4 (part 03), and `5-case-writes-forms-navigation.md`'s CommTrack paragraph (part 05 §11) |
| The manifest audit (1) is first | The HELD-NEW check fails any head whose corpus emits an item only HELD-NEW entries name, so the flips land with it; and the binding test (4) refuses a feature or ambient entry naming a non-HELD entry, so pull request 1's flips, readings and the hidden sibling's reading are beneath it (part 01 §4.4) |
| Lane mechanics (2) beneath the declaration (4) | From pull request 4, 68 documents declare one platform: without the reader policy the client would replay Android-only states and a device Web-Apps-only ones, and Formplayer would submit the client's placeholder for a declared Android app (part 08 §1). The local-archive guards must exist before pull request 5 stops writing archives, and `flip_entries` before pull request 6 moves the first fixed `sensitivity` entries. Pull request 2 changes nothing any reader records about today's corpus, which its by-hand run shows |
| The split's groundwork (3) beneath the declaration (4) | `planContentDeclaration` (4) calls `planDatetimeSplits` (3), and the fuzz mapping splits `fuzz-suite-20260930-8` in 4; the split's joined value needs R2 and R3 to keep its clock, its `convertField` needs the representable conversion and the media diff fix to replay through `appendSyntheticBatchInTransaction` and the fuzz admission (part 03 §2.8, §2.9) |
| The declaration (4) beneath publish (5, 6) | `cloudcare_enabled` writes `declaresWebApps`, the `.ccz` refusal reads `declaresAndroid`, and `narrowingTo` reads `contentRunsOn`; the `40-hq-cloudcare-enabled` flip and `privilege/cloudcare` land in 4 because the binding test lists the entry (part 02 §5.2) |
| The intent clause in 5, not 2 | Pull request 4 declares 30 documents Android only before pull request 5 writes the value, so the clause in 2 would fail 4's lane (part 08, decision 7) |
| Publish, Web Apps (5) beneath defect 20 (6) | `form-entry-sync-off`'s `whereMissing` reads 5's `narrowingTo` and `PlatformNarrowing`, the dialog's setting rows and `where_missing` are 5's, and the two migrations' stamps sort in that order |
| The H.264 High question before pull request 7 is cut | Pull request 7 decides that H.264 High plays only in Web Apps, so the cutover removes every High reference from every app that runs on Android; that removal takes authored content out on a documented reading alone, so it is the person's decision. Before 7 is cut they answer whether to run Android's decode probe on H.264 High on their Mac, with that cost in the question: on a yes the probe's outcome lands in 7; on a no the window does not open until they confirm the advisory dry run's count of `mp4-h264-high` references to remove (part 04 §8.5, part 09 §14 step 1(f)) |
| Media (7) above the declaration (4) and beneath 11, 12, 13 | Acceptance per reference reads `declaredPlatforms`; the builder's pickers and preflight (11), `updateApp`'s media pre-check (12) and the cutover's backfill and removal step (13) call 7's `unplayableReferences`, `describeUnplayableReferences`, `classifyStoredMediaBytes` and `REEXPORT_AS` |
| Preview's model (8) beneath its screens (9) | Every screen reads `previewPlatformRules` and the device 8 lands; `loadManifest.ts` (4) is beneath the cell table (9) |
| The cell table (9) beneath the reads (10) | Pull request 10 writes the rows marked (10) into 9's table in the pull request whose flips make their entries HELD, since the completeness test fails on a HELD cell with no row (part 06 §23.3) |
| The window width gate before 10's manifest text | Its outcome decides part 02 §8.4's entries, part 01's rows (and `window-width-in-search` under outcome B), part 03's profile fact and part 06's cells; the gate class lands first on 10's branch and is dispatched by hand (part 08 §6.3) |
| Expression reads (10) beneath the builder (11) | 11 offers by declaration the cards and completions 10 makes authorable, and adds only the disabled reasons, the Search field note and the language-code picks (part 07 §1) |
| The builder (11) beneath the agent (12) | `updateApp`'s media pre-check calls `lib/media/attachVerdicts.ts::mediaDeclarationVerdict`, which 11 adds for the platform section's preflight (part 07 §2.3, §3.3) |
| The agent (12) above every tool and prose change | It is the last tool change, so the billed check asked at its head is the stack's one ask, and the guide teaches only what the gate admits |
| The cutover (13) above the agent (12) | The transform runs the head gate, reducer and planners; it reads 5's `baselineWebApps`, 6's `formEntrySyncReasons`, 7's classifier and 10's types for its blockers; nothing above 13 changes a schema, a gate or a planner |
| Contracts and public docs (14) beneath the removal (15) | The maintenance image is built from 14's head and the Job is managed from a checkout of it, because the tool and its allowlist arm exist only there; `git diff --stat <14>..<15> -- lib app` names only `lib/db/designSessions.ts`, so the gate that migrated is the gate the deploy's runtime probe runs |
| The five ledgered migrations sort in pull request order | The window's two `migrateTo` targets reach exactly the first four and then the fifth (part 09 §8); none is applied while the previous revision serves, and `writer.postgres.test.ts` holds the pending set to the stack's |

## House rules for the stack

1. **One chain on the latest `main`.** The stack is one `gh stack` chain cut from the latest
   `origin/main` after this plan's pull request merges, and rebased on it before the first pull
   request opens. Every pull request is undrafted.
2. **`/code-review medium` runs on each pull request**, and its findings are fixed there. Where the
   review's agents sit idle for about a minute with no notification, their findings are collected
   by hand.
3. **The stack merges together** with `gh stack merge <top> --squash`: one push, one deploy. Never
   pull request by pull request, and never through the merge API.
4. **Fix-ups go to the pull request they belong in, and a session's pushes are batched into one.**
   A push to pull request k restacks every pull request above it, each a fresh lane: a push to 1
   starts 15 lanes and 215 shard-jobs, and a push to 2 starts 14 lanes and 210, about eighty
   minutes of the account's twenty runners, and over four hours while a scheduled lane with the
   readers holds fourteen of them (part 08 §6.2). No
   restack is pushed while a scheduled lane with the readers runs.
5. **Pull requests 2, 3, 4 and 5 are settled on their own branches before the stack is cut**: each
   one's lane, its tests, its base-and-head corpus emission where it narrows (3, 4), and its by-hand
   reader run (part 08 §6.3's rows 2 to 5). Before the cut, 1 to 5 are the chain's first five
   branches, each on the one beneath it, and pull requests 6 to 15 are cut onto 5 once 5 holds. Each
   runs the 12.7-minute lane of 15 shards, as every stacked branch does, so a fix to 3 then restacks
   3, 4 and 5, three lanes and 45 shard-jobs, where after the cut it restacks thirteen. Reason: 2
   changes the observation every later lane runs; 3 lands a stored mutation shape and the split's
   derived identities; 4 lands the declaration, the corpus declarations and the fuzz mapping, which
   move about 72 documents' keys; 5 moves every document's key and retains
   `targeted-list-first-web-apps-declared` from its own emission, which a later change to 5's
   emission would make stale. A change to any of them after the cut restacks ten or more fresh lanes.
6. **No heavy run on the person's machine.** The no-Docker corpus emission with `--jobs 2` and pure
   Vitest files are the only runs that belong there without asking. Every lane slice, native family,
   fresh lane and reader run goes to GitHub's runners. The Android decode probe on H.264 High runs
   only on the person's own yes, since it needs their Mac; the question is asked before pull
   request 7 is cut ("Ordering constraints", part 04 §8.5).
7. **The billed schema check is asked once, at pull request 12's head**, naming each tool whose
   hash moved between `main` and that head, as checklist place 14 gives it. On a yes the implementer
   runs `npm run test:schema -- <name>` once per name, never the bare command. A schema the provider
   refuses is fixed in the pull request that owns it, and the question is asked again for that
   schema alone.
8. **Reader runs by hand.** Each pull request of part 08 §6.3's table starts its row on GitHub's
   runners once its lane holds, and one run over the union of the rows runs at the top of the stack
   before the merge. The window width gate's run is pull request 10's first.
9. **The cutover runs before the merge** (part 09 §14). The maintenance image is built by hand
   (`docker build --platform=linux/amd64 --target=maintenance`) from pull request 14's head, and the
   Job `commcare-nova-hq-round-trip-platforms` is made from that image and managed from a checkout of
   that commit. `main` is frozen from the image build to the merge; a rebase after the image is built
   rebuilds it and repeats the dry run. The runbook records pull request 14's head and the image
   digest; the window's order, its checks and its rollback are part 09 §14's. Where H.264 High
   reads `unavailable` on Android, the runbook reads the dry run's count of `mp4-h264-high`
   references to remove out to the person, and the window opens only on their confirmation (part
   09 §14, step 1(f)).
10. **After the merge, the deploy is watched on the merge commit with `gh`**: the commit's
    check-runs are listed first (`gh api repos/voidcraft-labs/commcare-nova/commits/<sha>/check-runs
    --jq '.check_runs[] | {name, app: .app.name, status, conclusion}'`) and the watch is built from
    the name and app observed there; an empty list is an error to look into. Pull request CI being
    green is not a deploy, and this deploy runs the runtime probe. The build's `verify` step fails
    while the NEG is detached: wait for `deploy` to report the revision ready, then follow part 09
    §14's steps 10 and 11.
11. **The first nightly after the merge is the whole lane with every reader.** The merge moves every
    key, so the next scheduled night (Tuesday to Saturday, 03:23 UTC) runs about 13.5 hours on up to
    fourteen of the twenty runners; the merge is made Monday to Friday so that night follows it. A
    night that fails opens an issue naming each failing group with the command that reruns it alone
    (`python3 -m proof.lane.report`); the implementer fixes from that list and reruns only the
    documents on it. The `readers` timings follow that night in an ordinary pull request.
12. **The `../nova-plugin` change rides its own pull request**, cut after pull request 12 and merged
    only after the Nova deploy is live (house rule 10 confirms it); "The nova-plugin check" below.

Removing the tooling at the top of the same stack, not in a follow-up pull request, keeps step 2's
and step 3's choice: a later removal would be a second deploy that exists only because of the
split, and the run and its postconditions precede the merge. The one planned step after the
deploy, before ingress reopens, writes the case-schema drift the dry run counted with the existing
drift writer (`schema-drift`) from merged `main` through `commcare-nova-case-type-schema-retirement`,
step 3's precedent, which the removal does not touch (part 09 §14).

## The model-addition checklist

Each addition is complete when its pull request lands, and its author ticks every place below or
writes "none" with the reason. Step 4's additions:

- **Stored keys and arms**: `appSettings.runsOnlyOn` and the patch's `runsOnlyOn: null` (4);
  `convertField.label` (3); the value arm `{ kind: "case-list-search-text" }` (10). Database:
  `media_assets.media_format` with `media_assets_media_format_known` and
  `media_assets_ready_media_format` (7, validated in 13); the confirmation kind
  `form-entry-sync-off` (6); `app_deployments.target_web_apps_enabled` dropped (5);
  `form_attachments_size_check` widened (8). App Test journey state: `platform` and
  `androidDeviceId` per session (8). Session state, never stored: `previewPlatform` and its
  siblings (8), `PreviewCaseTarget.caseListSearchText` (10).
- **Platform features**: 43 features naming 62 entries and 34 ambient entries (4); four more, and
  `search-first`'s two entries, for 47 naming 70 (10; 48 with `window-width-in-search` under outcome
  B) (part 01 §4.5).
- **Validation codes and reasons**, each with its rows in the typed-total tables of place 2:

| Code or reason | PR | `errors.ts` | `gate.ts::VALIDITY_CLASS_BY_CODE` | `lib/doc/userFacingErrors.ts` | `checkErrorPresentation.ts::PRESENT_BY_CODE` |
|---|---|---|---|---|---|
| `PLATFORM_FEATURE_UNAVAILABLE` (`details.feature`, `details.platform`; in `SCOPE_EXEMPT_CODES`) | 4 | new code | `soundness` | `platformBuilderSentence(e)`; an unknown feature gives "This isn't available where this app runs. You can change where it runs in App settings." | none: a validator code, no checker code |
| checker `arm-unavailable`, reason `platform-unavailable` (`CheckError.platform`; the slot keeps its code) | 4 | none (the slot's code) | the slot code's | `recordFindingCopy`'s branch to `platformBuilderSentence` | `"arm-unavailable"` gains `reason === "platform-unavailable"`: `` `Not available ${inPlatform(error.platform.platform)}, where this app runs` `` |
| `MEDIA_FORMAT_NOT_PLAYED` (`assetId`, `mediaFormat`, `missingPlatforms`; in `MEDIA_VALIDATION_CODES` and `SCOPE_EXEMPT_CODES`) | 7 | new code | `environment` | part 04 §6.7's two sentences | none |
| `XPATH_FUNCTION_CONTEXT_UNAVAILABLE`, `details.reason` `platform-unavailable` (form logic, from `formLogicFindings.ts`) | 10 | existing | `soundness` (existing) | `platformBuilderSentence` | `"arm-unavailable"` as above |
| checker `arm-unavailable`, reason `window-width-in-form`, mapped to `XPATH_FUNCTION_CONTEXT_UNAVAILABLE` `details.reason` `window-width` (outcome A only) | 10 | existing | existing | part 03 §6.2's sentence | `"arm-unavailable"` gains `reason === "window-width-in-form"`: `A form can't rely on the window width. You can read it in a display condition or a case list` |
| checker `arm-unavailable`, reason `case-list-search-text-slot` | 10 | the slot's code | the slot code's | the checker's message (part 03 §5.3) | `"arm-unavailable"` gains `reason === "case-list-search-text-slot"`: `What the worker typed into a case list's search box is available only in a form's questions and Connect settings` |
| checker `datum-not-supplied`, reason `case-list-search-text`, mapped to `SESSION_DATUM_NOT_SUPPLIED` `details: { reason, caseLists }` | 10 | existing | existing | part 03 §5.3's two sentences, picked by `caseLists` | `"datum-not-supplied"` gains `case "case-list-search-text"`: `This form doesn't open after exactly one case list, so there's no search text to read` |
| `INVALID_SEARCH_REF` and `search-answer-unavailable` | 10 | existing | existing | part 03 §4.2's new sentence | `"search-answer-unavailable"` keeps its line |

  Outside the validator, each with one sentence in the part that owns it: the deployment failure
  codes `hq_web_apps_change` and `hq_plan_lacks_web_apps` and the download refusal
  `not-declared-for-android` (5, part 05 §14); `MediaReferenceProjectionError` reason
  `platform-unplayable` and `ValidationFailureReason` `svg-not-accepted` and
  `ico-variant-not-accepted` (7, part 04 §3.8, §6.2); Preview authorization's
  `platform-unavailable` and `language-unavailable` arms (8, part 06 §18.5).

The places:

1. **Schema.** `lib/domain/blueprint.ts` for the declaration, `lib/doc/types.ts` for the patches,
   `lib/domain/expression/types.ts` for the value arm with its hand-declared TypeScript arm and the
   drift guard. A stored shape lands only in the pull request named above.
2. **Validator tables.** A new `ValidationErrorCode` takes its row in `errors.ts`,
   `gate.ts::VALIDITY_CLASS_BY_CODE` and `lib/doc/userFacingErrors.ts` in its own pull request, or
   that pull request does not compile; a checker reason takes its presentation line in
   `PRESENT_BY_CODE` beside its code, as the table above writes each. The agent and MCP voice of
   every platform refusal is `platformRefusalMessage` (part 01 §2.3), never a second sentence.
3. **The platform table and the manifest.** A feature that behaves differently by platform is a row
   of `PLATFORM_FEATURES` with its entries in `lib/commcare/surface/platformFeatureEntries.ts`, held
   by `platformFeatures.test.ts`'s seven rules; its manifest entry is HELD in the same pull request
   with its inventory row (part 02). A media variant is a `MEDIA_FORMATS` row held to its
   `media-formats.json` item by `manifest.test.ts` (part 04 §7.3).
4. **Wire.** `fromExpression.ts` for the arm and the guarded reads, `formReads.ts` for the
   `current()` print, `hqShells.ts` for `cloudcare_enabled`; the oracles; `lib/commcare/CLAUDE.md`.
5. **Preview.** The rule field in `lib/preview/platform.ts` for a behavior that differs; the session
   value through `previewDeviceContext`; the carrier for the arm (part 03 §5.4); a cell-table row for
   every differing HELD cell (part 06 §23), or the refusal that discharges it.
6. **Postgres.** `lib/case-store/sql/compileExpression.ts` lists the arm with `here`'s neighbours
   that throw; the context fields' `int` type compiles through `readsAsDeviceText` with no change.
7. **Index.** None: the declaration and the arm name no identity, so `lib/doc/referenceIndex.ts`
   records nothing (part 01 §1.2, part 03 §5.4).
8. **Builder cards and offering.** The arm's card and completion (10, part 03 §5.4); the context
   fields made editable (10); every offering site disabled with `platformPickerLine` (11, part 07
   §2.5); the note row's mounts (11, part 07 §2.8).
9. **SA and MCP.** Static schemas (part 07 §3.2); the overview's `platforms` and `notOffered`; the
   guide's generated sentences; `updateApp.runs_only_on`; the date-and-time pre-check (12).
   `lib/mcp/__tests__/servedSchemas.test.ts` checks, unchanged, that every input schema a client
   receives compiles and its patterns read outside JavaScript.
10. **Public docs.** The page for the task a reader does, `content/docs/mcp/tools.mdx` for the
    callable reference, and `where-workers-use-your-app.mdx` for every feature one platform cannot
    run (14).
11. **Proof.** The native family that holds a runtime fact (`DatetimeSplitRuntimeTest`,
    `SessionContextRuntimeTest`, `RowPredicateCurrentRuntimeTest`, the media scenarios); a targeted
    document where no corpus source draws the shape (part 08 §4); a reader where a REFUSED class
    names it (`svg_image`, `window_width_in_form_logic`).
12. **Existing documents.** A cutover step (part 09 §5), its notice reason where a person or worker
    sees a change (§12), its blocker where the transform can refuse (§11), its count in the scan
    (§6); or "none: production holds no stored value of it" (the arm, the Search field reads, the
    `current()` print, part 03 §10).
13. **`MODEL_CONTEXT_VERSION`** (`lib/models.ts`), moved where the name, description or input
    schema of a tool the Solutions Architect is offered, the guide, a prompt, or what an authored
    text input accepts changes:

    | PR | Change | Value |
    |---|---|---|
    | 8 | `startAppTest` and `evaluateForm` gain `platform` and a description sentence | `"v5-hq-round-trip-platforms.8"` |
    | 10 | authored text accepts the case list search text and the three context fields; the guide's context row | `"v5-hq-round-trip-platforms.10"` |
    | 12 | `updateApp`'s schema and description, the guide's workflows paragraph and generated sentences, the capture `saDocs`, the prompts | `"v5-hq-round-trip-platforms.12"` |

    Pull requests 1 to 7, 9, 11, 13, 14 and 15 leave it: a gate refusal is a finding, not an input
    schema, so pull request 4 moves nothing, and a field added to a read result (`list_media_assets`'
    `playsOn`, the overview's `platforms`) is no input (`lib/agent/CLAUDE.md`). MCP-only descriptions
    (`upload_media_asset`, `upload_app_to_hq`, `compile_app`, `withdraw_deployment_confirmation`,
    `check_project_space_compatibility`, the autonomous instruction) are in no stored model context.
14. **The billed schema check.** `scripts/test-schema.ts` proves the provider accepts a tool
    definition the Solutions Architect is given, one live OpenAI request per entry sent.
    - **Registrations and prompts.** `startAppTest` is registered by pull request 8 (its entry, its
      import and its name in the header's "Known names"), prompt: `Use startAppTest with two
      sessions, "web" on web-apps and "phone" on android, whose purpose is checking that a
      registered patient appears in the follow-up list.` Pull request 8 changes `evaluateForm`'s
      prompt to `Use evaluateForm on the form "Follow-up visit" in the module "Patients" on android
      with a scenario holding one patient record whose properties are case_name "Asha" and status
      "active".` Pull request 12 changes `updateApp`'s prompt to `Use updateApp to name the app
      'Village Health', set it to run only on Android, and turn its incomplete forms list on.`
    - **A tool only MCP serves is checked by `lib/mcp/__tests__/servedSchemas.test.ts`**, which
      runs unchanged: it compiles every served input schema and reads no description, so
      `upload_media_asset`'s new description (pull request 7) is held by no test. The script's one
      MCP-only entry, `uploadMediaAsset`, keeps its entry, its own fixed description and
      `uploadMediaAssetInputSchema`, which pull request 7 does not change (part 04 §5.4), so it is
      not in the question.
    - **The question, asked once at pull request 12's head**: "Step 4 changes 3 of the tool
      definitions the Solutions Architect is given, and `npm run test:schema` checks that OpenAI
      accepts each one. Running it for these 3 sends 3 live OpenAI requests on your key, one per
      schema: `updateApp`, `evaluateForm` and `startAppTest`. May I run it?" The names are every
      registered tool whose hash differs between `main` and pull request 12's head; if the run shows
      another, it joins the list and the count. On a yes the implementer runs `npm run test:schema --
      <name>` once per name.
15. **Docs**: the nearest subtree `CLAUDE.md`, `docs/architecture/complex-apps.md` where the
    addition records a binding CommCare fact, and the public docs of place 10.
16. **`../nova-plugin`**: sweep its prose for the claim the change makes false; the change rides the
    plugin's one pull request (below).

The checklist leaves with this plan (pull request 15): every place it lists is in the code, and a
later step's plan lists them again as the code then stands.

## Contract sentences step 4 rewrites

Each "Today" was read in today's file at `main` `e9e6cd93` and is quoted whole; where the source
wraps a sentence over lines, the quote joins them with one space. A section is named by its heading
or its opening words. "Kept; adds" means the quoted sentence stays and the new text follows it. A
replacement in quotation marks is the text as written; it names no plan step, pull request, part,
defect or finding, because the plan leaves the repository in pull request 15 and a contract file
says what is so. The proof lane's documents and the research's findings are the exception: they
name steps, defects and findings today and keep doing so.

"PR" is the pull request whose change makes the sentence false, and the sentence moves with that
behavior, so every `CLAUDE.md` is true at every head. `docs/architecture/contracts.md` and
`complex-apps.md` ride pull request 14, and their "PR" cells read "14 (behavior n)". Where a part
already holds a row's replacement text word for word, the row cites it rather than restating it.

### CLAUDE.md (root)

| Section | Today | From step 4 | PR |
|---|---|---|---|
| "The map", `lib/domain` | "the case-type catalog, the one `Expression` union with its slot profiles and its checker (`lib/domain/expression`), the media primitives." | "the case-type catalog, the one `Expression` union with its slot profiles and its checker (`lib/domain/expression`), the media primitives, and where an app runs: `appSettings.runsOnlyOn` and the table of what each feature does in Web Apps and on Android (`platforms.ts`, `platformUses.ts`)." | 4 |
| "The map", `lib/media` | "asset validation, the attach- and export-time verdicts, the export budget, the wire manifest, and the deletion guard." | kept; adds "Upload accepts a file some CommCare platform plays, and an app references it only where every platform the app runs on plays it." | 7 |
| "The map", `lib/deployment` | "and a publish stops below CommCare 2.57 and without a confirmed plan feature." | kept; adds "Every publish writes where the app runs as its Web App setting, and asks before changing the setting HQ holds." | 5 |
| "The mental models", item 5 | "There is no mock preview mode: the builder's running-app view executes the blueprint in a client-side engine (`lib/preview`) over the user's actual Postgres case rows (`lib/case-store`)." | kept; adds "It plays one platform the app runs on at a time, Web Apps or Android." | 8 |

### docs/architecture/contracts.md

| Section | Today | From step 4 | PR |
|---|---|---|---|
| "Nova is not CommCare HQ." | "Nova emits one wire flavor: the maximal subset Web Apps supports, faithfully." | "Each app says where it runs, in Web Apps, on Android or both, and a new app runs on both. Nova emits for the platforms an app declares and holds only what each of them runs; where a feature behaves differently on the two, the difference is a row of one table held to the surface manifest (`lib/domain/platforms.ts`, `lib/commcare/surface/__tests__/platformFeatures.test.ts`), and the builder states it where the author works." | 14 (behavior 4) |
| "Deployment", the drift bullet | "One `hq_changed` refusal lists every change of every kind, and a person publishes over a change only by naming it back with the digest of the state they were shown, so a state HQ has since left is asked about again." | part 05 §16's replacement: every kind "but the app's Web App setting", and the two sentences on `hq_web_apps_change` | 14 (behavior 5) |
| same bullet, last sentence | "The one later stop is a change that reaches the app in HQ while the Project data is pushed: it stops that publish at `upload`, before the app's content is sent, and the next publish's preflight asks about it." | kept; adds "A change of the Web App setting during the push stops that publish the same way." | 14 (behavior 5) |
| "Deliberate target gaps", after "Smart links belong to data registries" (new bullet) | (none) | adds "- **SVG images never ship.** HQ types an SVG as an image and cannot store it (Pillow reads none), and one SVG stops a whole bulk upload, so Nova refuses SVG at upload for every app (`lib/media/validate.ts::SVG_REFUSAL_MESSAGE`)." | 14 (behavior 7) |

### docs/architecture/complex-apps.md

| Section | Today | From step 4 | PR |
|---|---|---|---|
| new subsection before "### Media" | (none) | adds "### Where an app runs" with: "An app declares Web Apps, Android or both (`appSettings.runsOnlyOn`, absent for both, which a new app declares); nothing infers it from a feature. `lib/domain/platforms.ts::PLATFORM_FEATURES` states, per feature, whether each platform runs it, ignores it, cannot run it or runs it differently, held to the surface manifest's readings by `platformFeatures.test.ts`. A feature one declared platform cannot run is refused at the commit gate: a structural use as `PLATFORM_FEATURE_UNAVAILABLE`, an expression leaf by the checker's `platform-unavailable`. A date-and-time question is unavailable in Web Apps, whose client has no entry for it (`entries.js::getEntry`); the builder splits it into a date question and a time question joined by a Hidden Value calculated by the clock-keeping date, which Core holds as the same `DateTimeData` (`lib/doc/datetimeSplit.ts`). A CommCare Connect app runs on Android only, because no Connect worker can sign in to Web Apps." | 14 (behavior 4) |
| "Search first" | "The wire shape is HQ's inline search, byte for byte (`lib/commcare/suite/case-search/compileForPlatform.ts`)" | "The wire shape is HQ's inline search, byte for byte (`lib/commcare/suite/case-search/searchWireShape.ts`)" | 14 (behavior 4) |
| "Search first", the no-matches paragraph | "Web Apps is the enforcing runtime: Android never shows a case list on an empty search response and passes no search-input extra (`commcare-android …/activities/QueryRequestActivity.java::processSuccess`), so the action and the carried answers are browser-app behaviour and every surface says so." | "Web Apps is the enforcing runtime: Android never shows a case list on an empty search response and passes no search-input extra (`commcare-android …/activities/QueryRequestActivity.java::processSuccess`). Search first is itself unavailable on Android, so a module that opens on Search, and its no-matches form, exist only in an app that runs in Web Apps only." | 14 (behavior 4) |
| the Search prompt paragraph | "Enforcement is Web Apps only; every surface says so." | "Enforcement is Web Apps only; where an app also runs on Android, the Search field's platform note says Android searches without checking the answer." | 14 (behavior 11) |
| "Preview execution" | "A search's Results read the Project's open cases of the searched type, as HQ's search does, not the worker's restore, and choosing a case the worker does not hold plays the claim." | kept; adds "Preview plays one platform the app declares at a time (`lib/preview/platform.ts::effectivePreviewPlatform`, Web Apps by default where both are declared), through one rule table every Preview surface reads, and App Tests and `evaluate_form` run each session or check on one platform the same way." | 14 (behavior 8) |
| "### Media" (part 04 §11) | "This is authoring media (menu icons, field images); a worker's own captures are the attachment questions below and never enter this library." | kept; adds part 04 §11's paragraph ("Each media asset stores the variant its bytes are …") | 14 (behavior 7) |
| "Attachment questions", the attach paragraph | "**Every author- and worker-facing string says "attach", never "take" or "record".** Web Apps has no camera, microphone, or recorder anywhere in cloudcare — `entry_file.html` binds only `accept` on its file input, and `getUserMedia` / `MediaRecorder` / `capture=` occur nowhere in it. Every kind but signature is the OS file picker. CommCare Android is the contrast, and that contrast is a docs fact rather than a Nova behavior." | "**Capture wording names what is captured, never how.** Web Apps has no camera, microphone, or recorder anywhere in cloudcare: `entry_file.html` binds only `accept` on its file input, and `getUserMedia`, `MediaRecorder` and `capture=` occur nowhere in it, so every kind but signature is the OS file picker there, while CommCare Android takes a picture, records sound and records video. The capture kinds' `saDocs` name what to capture, the platform table's notes say how each platform captures it, and Preview plays each platform's controls (`lib/preview/platform.ts`, the `capture` rule)." | 14 (behavior 9 and 12) |
| "Attachments a worker captures" | "The preview control is device-faithful: a filename and one visible removal action (Nova says **Remove**, where `entry_file.html` says **Clear**), no thumbnail, no playback, no way to reopen the file — and Formplayer declares no route serving a staged capture back." | "Preview's Web Apps control is device-faithful: a filename and one visible removal action (Nova says **Remove**, where `entry_file.html` says **Clear**), no thumbnail, no playback, no way to reopen the file, and Formplayer declares no route serving a staged capture back. Running as Android, an image question shows the chosen photo with **Remove image**, as Android's `ImageWidget` does." | 14 (behavior 9) |
| "Publishing", the shell paragraph | "App content Nova does not author yet (`cloudcare_enabled`, `case_sharing`) and target-owned settings and state (`secure_submissions`, the build/release metadata, and the rest of HQ's app Settings page) are absent, so the overlay merge retains a project's HQ-side configuration across republishes." | "App content Nova does not author yet (`case_sharing`) and target-owned settings and state (`secure_submissions`, the build/release metadata, and the rest of HQ's app Settings page) are absent, so the overlay merge retains a project's HQ-side configuration across republishes. `cloudcare_enabled` is where the app runs, written on every update from the declaration." | 14 (behavior 5) |
| "Publishing", the setup artifact paragraph | "It also states that `models/applications.py::_create_app_from_doc` initializes `cloudcare_enabled` from the domain's Web Apps privilege at create, so an app published before the feature was on starts with it off. The remedy is the ordinary **Web App** setting (`commcare-app-settings.yml` id `cloudcare_enabled`, editable through `views/apps.py::edit_app_attr`). Nova deliberately never emits `cloudcare_enabled` (`lib/commcare/hqShells.ts`), so the in-place update's overlay merge retains that HQ-side toggle across republishes." | "Its Web Apps section is there exactly for an app that declares Web Apps. `models/applications.py::_create_app_from_doc` sets a new app's `cloudcare_enabled` from the domain's Web Apps privilege, so a first publish of an app that declares Web Apps to a plan without it stops at `resources` (`hq_plan_lacks_web_apps`) and withdraws the person's `web-apps` answer. Every update writes `cloudcare_enabled` from the declaration (`lib/commcare/hqShells.ts`), and preflight asks before an update changes the value HQ holds (`hq_web_apps_change`), so a change made on HQ's **Web App** setting (`views/apps.py::edit_app_attr`) is a question, never a silent overwrite." | 14 (behavior 5) |
| "Form sections" | "Preview pages the form on Android's rules, one section per screen, Next validating and Back not, an empty or all-irrelevant page skipped, Submit routing to the earliest invalid page, the open page a session slot shared across the flip (`lib/preview/CLAUDE.md` § Sections page the preview). Default Web Apps shows the same form as titled groups on one screen, and the docs say so (`content/docs/form-sections.mdx`)." | "Preview running as Android pages the form on Android's rules, one section per screen, Next validating and Back not, an empty or all-irrelevant page skipped, Submit routing to the earliest invalid page, the open page a session slot shared across the flip (`lib/preview/CLAUDE.md` § Form screens per platform). Running as Web Apps, it shows the same form as titled groups on one screen, as Web Apps does (`content/docs/form-sections.mdx`)." | 14 (behavior 9) |

### lib/commcare/CLAUDE.md

| Section | Today | From step 4 | PR |
|---|---|---|---|
| "The surface manifest" | "The manifest is the living record of every disposition; the inventory under `docs/research/2026-09-26-hq-round-trip/` stays the research's evidence and is not kept in step with it." | part 02 §3.9's replacement | 1 |
| same, the manifest-check sentence | "The proof lane's manifest check holds Nova's own exports to the entries: every item an export uses must be held by the entry whose value class takes it, and every flag HQ reads while building it must have a gate entry (`proof/README.md`, "Manifest checks")." | part 02 §2.4's replacement | 1 |
| same, after the entries list (new) | (none) | adds part 01 §13's sentence ("The platform table in `lib/domain/platforms.ts` stands for the manifest's per-platform readings …"); the validator's rule list gains `rules/platforms.ts` | 4 |
| the datetime case-write paragraph "Ordinary datetime case writes" | "The bind follows the property the Hidden Value writes, not the type inferred from its calculation, because an `xsd:dateTime` bind makes Core cast the case's text at form open, and malformed text stops the form." | kept; adds "A Hidden Value that writes nothing binds `xsd:dateTime` only where its calculation is the clock-keeping date (`lib/domain/expression/datePattern.ts::isClockKeepingDate`), as the date-and-time split's joined value is, so Core keeps its clock." | 3 |
| the search shape paragraph | "`compileForPlatform.ts` is the pure decision tree from authored content + `PlatformContext` to a three-flag `WireShape`. Author intent is unambiguous on every input — Android always emits list-first / inline-results; web with an effective Search action, an effective filter, and zero search inputs emits skip-to-results; an explicit zero-input action without that filter remains manual; web fallback is list-first." | "`searchWireShape.ts` is the pure decision tree from authored content to a three-flag `WireShape`, one shape for every platform an app declares: an effective Search action with an effective filter and zero search inputs emits skip-to-results; an explicit zero-input action without that filter remains manual; otherwise list-first. Android reads no `auto_launch` and opens the list first, which the platform table states (`skip-to-results`)." | 4 |
| "Search-first inline shape" | "lowers to HQ's inline search — `inline_search && auto_launch` (`app_manager/util.py::module_uses_inline_search`), with `default_search` when the module has no visible prompt — on both wire paths, whatever the platform." | "lowers to HQ's inline search, `inline_search && auto_launch` (`app_manager/util.py::module_uses_inline_search`), with `default_search` when the module has no visible prompt, on both wire paths. Search first is unavailable on Android (`search-first`), so only an app that runs in Web Apps only holds it." | 4 |
| the no-matches form's bullet | "- **Web Apps only at runtime.** Android never shows the case list on an empty search response and passes no search-input extra (`QueryRequestActivity::processSuccess`), so author-facing copy says the action and the carried answers work in the browser app." | "- **Web Apps only at runtime.** Android never shows the case list on an empty search response and passes no search-input extra (`QueryRequestActivity::processSuccess`); the form exists only in a search-first module, which only an app that runs in Web Apps only holds, so its copy names no phone." | 11 |
| the export targets paragraph | "Every `.ccz` is made for one published project space, and its profile names that space's four server properties (`ota-restore-url`, `PostURL`, `key_server` and `cc_user_domain`, from `runtimeTarget.ts::profileServerProperties`); an app that is published nowhere is offered no `.ccz`." | kept; adds "An app that does not declare Android has no `.ccz` at all (`runtimeTarget.ts::chooseDownloadTarget`, `not-declared-for-android`): a `.ccz` installs an app on Android." | 5 |
| the plan privileges paragraph | "the plan features the content needs (`user_case`, `lookup_tables`, `child_cases`, `form_link_workflow`, `save_to_case`, `locations`, `data_forwarding`), each with the sentences that say why this app needs it." | "the plan features the content needs (`cloudcare` for an app that declares Web Apps, `user_case`, `lookup_tables`, `child_cases`, `form_link_workflow`, `save_to_case`, `locations`, `data_forwarding`), each with the sentences that say why this app needs it." | 5 |
| same paragraph, after it (new) | (none) | adds "`planPrivileges.ts::formEntrySyncReasons` names each form that works on a case in a module whose case list offers Search, for an app that declares Android: HQ's build gives such a form's entry a claim that always posts while the project space syncs cases on form entry, and Android can't open a form whose entry asks for a sync, so publish asks a person to confirm the setting is off (`form-entry-sync-off`)." | 6 |
| the shell paragraph | "So app content Nova does not author yet (`cloudcare_enabled`, `case_sharing`) and target-owned settings and state (`secure_submissions`, the build/release metadata, and the rest of HQ's app Settings page) are never emitted by `hqShells.ts::applicationShell`." | "So app content Nova does not author yet (`case_sharing`) and target-owned settings and state (`secure_submissions`, the build/release metadata, and the rest of HQ's app Settings page) are never emitted by `hqShells.ts::applicationShell`. `cloudcare_enabled` is where the app runs, written on every update from `declaresWebApps`; a create takes the plan's answer (`_create_app_from_doc`), which a first publish reads." | 5 |
| "Secondary instances", the session context sentence | "The authoring choices offer four (`deviceid`, `appversion`, `username`, `userid`); the other three differ by platform." | "The authoring choices offer all seven. `drift` and `window_width` type as whole numbers; `window_width` is admitted only in a slot CommCare evaluates while a menu or a list loads; and `window_width` and `applanguage`, which can be absent, print under the count guard (`xpath/wire/emptyRows.ts::guardAbsentNode`). The case list's search text, `session/data/stringquery`, is a value arm admitted in a form that opens after exactly one case list, printed `if(count(P) > 0, P[1], '')`." Under outcome B of the window width gate, the clause "`window_width` is admitted only in a slot …" is left out | 10 |

### lib/commcare/xpath/wire/CLAUDE.md

| Section | Today | From step 4 | PR |
|---|---|---|---|
| "Reads of rows that may be empty" | (the section) | kept; adds part 03 §6.3's sentence (the count guard), and a paragraph stating part 03 §7.2's `current()` rule and its reason | 10 |

### lib/domain/CLAUDE.md

| Section | Today | From step 4 | PR |
|---|---|---|---|
| the `appSettings` paragraph | "`appSettings` is a required root object, `{ showSavedForms, showIncompleteForms }`, both off in a new app: whether workers see their saved forms, on the Android home screen, and their incomplete forms, on Android and in Web Apps. `setAppSettings` patches it." | part 01 §13's replacement, and its paragraph on `platforms.ts` and `platformUses.ts` after it | 4 |
| the Hidden Value paragraph | "Its BIND follows `fieldValueType`: the type of the property it writes, from the effective catalog, so a Hidden Value that writes nothing keeps `xsd:string` whatever its calculation works out to; visible questions keep their field-kind type." | the clause "so a Hidden Value that writes nothing keeps `xsd:string` whatever its calculation works out to" becomes part 03 §2.7's | 3 |
| the field kinds paragraph | "`saDocs` on those five is load-bearing prose, not a summary: Web Apps has no camera, microphone, or recorder, so every one says "attach" and none says "take" or "record"." | part 07 §5's replacement ("Capture saDocs name what is captured; …") | 12 |
| "Accepted asset formats are one registry." | "`multimedia.ts::ACCEPTED_FORMATS` holds one entry per canonical MIME, documents included: its kind, canonical extension, declared extensions (`.jpeg`, `.opus`), the MIME aliases a browser or a sniff may use, its label, and the `lib/commcare/surface/media-formats.json` items it admits (none for a document)." | "`multimedia.ts::ACCEPTED_FORMATS` holds one entry per canonical MIME, documents included: its kind, canonical extension, declared extensions (`.jpeg`, `.opus`), the MIME aliases a browser or a sniff may use, and its label. `MEDIA_FORMATS` names each media variant beneath a MIME (`mp4-hevc`, `wav-pcm`) with its `lib/commcare/surface/media-formats.json` item and the platforms that play it; a stored asset row holds one variant key, or `unplayable`." | 7 |
| after the registry paragraph (new) | (none) | adds "`captureFormats.ts::CAPTURE_LIMITS` holds each platform's limit on a worker's capture: 4 MB and the extension lists in Web Apps, 15 MB less 1 KB by MIME family on Android." | 8 |
| the forms and modules paragraph | "`searchInputNameResolver`, the name resolver for the expression leaf `input { searchInputUuid }` (`#search/<name>`), which resolves inside a no-matches form alone." | part 03 §11's replacement ("resolves inside a no-matches form and the forms of a module that opens on its search") | 10 |

### lib/domain/expression/CLAUDE.md

| Section | Today | From step 4 | PR |
|---|---|---|---|
| the admission paragraph | "`here()` is admitted only where the profile's `here` fact holds, a case-list calculated column; elsewhere it is `arm-unavailable` reason `here`." | kept; adds "Where the slot admits it, a leaf a declared platform lacks is `arm-unavailable` reason `platform-unavailable`, read from `ExpressionContext.platforms` (`declaredPlatforms`, filled by `slotContext`)." | 4 |
| new paragraph "The clock-keeping date" | (none) | adds R2 and why (part 03 §2.6) | 3 |
| the arms and leaves (new) | (none) | adds the value arm `case-list-search-text` with its slot and supply rules, and the context fields' types and the `windowWidth` profile fact (part 03 §5, §6.2) | 10 |

### lib/doc/CLAUDE.md

| Section | Today | From step 4 | PR |
|---|---|---|---|
| the mutation list | "`setAppSettings { settings }` patches the app's settings; `settings` is a strict partial with at least one key." | part 01 §13's replacement | 4 |
| the births and moves paragraph | "Converting a non-select field to a select requires an authored option source at target admission; the reducer's schema fallback cannot acknowledge a successful no-op." | kept; adds "A conversion is representable when either kind lists the other (`isRepresentableConversion`), so every offered conversion's undo replays, and one whose destination declares a label the source lacks carries a `label` seed." | 3 |
| the planner list (new bullets) | (none) | adds "- `datetimeSplit.ts`: the one planner that splits a date-and-time question into a date question and a time question joined by a Hidden Value, with derived identities (`planDatetimeSplit`, `planDatetimeSplits`)." (3); "- `platformDeclaration.ts`: the declaration a document's content allows, with the split where only the date-and-time question keeps it from running anywhere (`planContentDeclaration`, and `declaredForContent` for fixtures and the fuzz mapping)." (4); `splitDatetimeQuestion` and `addDatetimeAsTwoQuestions` beside the other mutation methods and `platformChangePreflight.ts` beside the rename preflight (11) | 3, 4, 11 |

### lib/media/CLAUDE.md

| Section | Today | From step 4 | PR |
|---|---|---|---|
| heading | "## Accepted formats are the ones every platform plays" | "## Accepted formats and where they play" | 7 |
| its first paragraph, the registry sentence | "The accepted set is one registry, `lib/domain/multimedia.ts::ACCEPTED_FORMATS` (one entry per canonical MIME: its kind, extension, declared extensions, aliases, label and the `media-format:` surface items it admits); every MIME list, the extension lookups and the aliases derive from it." | "The accepted set is one registry, `lib/domain/multimedia.ts::ACCEPTED_FORMATS` (one entry per canonical MIME: its kind, extension, declared extensions, aliases and label), with `MEDIA_FORMATS` naming each media variant beneath a MIME, its `media-format:` surface item and the platforms that play it; every MIME list, the extension lookups and the aliases derive from them." | 7 |
| its first paragraph, last sentence | "SVG is excluded as an XSS script container." | "SVG is refused for every app: HQ types it as an image and cannot store it, since Pillow reads no SVG and the error stops the whole bulk upload; it is also a script container." | 7 |
| its second paragraph | "A media format is accepted when every reader played it and HQ types its bytes as the same kind: …" | "A file is stored when its variant plays on at least one CommCare platform, HQ types its bytes as its kind, and HQ can store it. The variant is a fact of the bytes, written once on the row (`media_assets.media_format`, one key of `lib/domain/multimedia.ts::MEDIA_FORMATS`, or `unplayable` for legacy bytes no variant admits); acceptance is a fact of each reference, because two apps of one Project may run on different platforms. A reference is admitted only where its file plays on every platform its app declares, at the commit kernel on every editor (`lockAndValidateMediaReferences`, reason `platform-unplayable`), at the attach verdicts, at the export boundary (`MEDIA_FORMAT_NOT_PLAYED`) and in the builder's pickers, all reading `platformPlayback.ts`." Its run record sentences are kept | 7 |
| "So several formats are accepted only in the variant that ran …", the FLAC, Ogg and WebM bullet | "AV1, Matroska, an audio-only WebM and one holding any track that is neither video nor audio (subtitles, for one: no reader decoded that during planning) are refused (`codec-not-accepted`)." | "**MKV** takes WebM's rules through `webm.ts` (`matroskaRefusal`, by the `EBML` document type): one VP8 or VP9 profile 0 video track and Vorbis or Opus audio or none, the codecs Android pairs with Matroska. AV1, H.264 in MKV, an audio-only WebM or MKV and one holding any track that is neither video nor audio (subtitles, for one: no reader decoded that during planning) are refused (`codec-not-accepted`)." | 7 |
| "So several formats are accepted only in the variant that ran …", its last paragraph | "MP3, PNG, JPEG, GIF and WebP are unchanged; MP4 and WAV carry no codec or encoding check (step 4 narrows both)." | "MP3, PNG, JPEG, GIF and WebP are read by sharp and music-metadata; `mp4.ts` reads an MP4's one video track (H.264 Baseline, Main or High, HEVC Main, MPEG-4 Part 2 Simple) and AAC audio or none, and `wav.ts` holds WAV to 8- or 16-bit PCM. ICO, AVIF and H.264 High play only in Web Apps; AAC, AMR, MIDI, HEVC, MPEG-4 Part 2 and MKV only on Android." | 7 |

### lib/deployment/CLAUDE.md

| Section | Today | From step 4 | PR |
|---|---|---|---|
| the Web Apps line paragraph | "The Web Apps line reads the read after the import, or the last read before it when that read failed. That value is stored as `app_deployments.target_web_apps_enabled` with the `uploaded` fold and nowhere else, and the setup artifact reads it from the row: it says Web Apps is off where the last publish read it off, says nothing where it read it on, and keeps the general check where no publish has read it." | part 05 §16's replacement | 5 |
| "Preflight is a graph", the blocking edge | "and a plan feature or project-space setting the app needs that the person has not confirmed (`plan-features`, which asks HQ nothing)." | kept; adds "and, on an update of an app that holds Nova's content, a Web App setting on HQ that differs from where the app runs (`web-apps`, after `hq-changes`)." | 5 |
| `plan-features` | "Confirmations live in `app_deployment_confirmations`, three kinds (`plan-feature`, `flat-location-fixture`, `connect-forwarder`), written only by the fold of a passed preflight (`foldDeploymentAttempt`'s `confirmations`), so a refused publish stores none and the caller resends them." | kept; "so a refused publish stores none and the caller resends them." gains "; the one exception is the resources fold of `hq_plan_lacks_web_apps`, which withdraws the `web-apps` answer HQ's create contradicted." | 5 |
| same sentence | "three kinds (`plan-feature`, `flat-location-fixture`, `connect-forwarder`)" | "four kinds (`plan-feature`, `flat-location-fixture`, `connect-forwarder`, `form-entry-sync-off`)" | 6 |

### lib/db/CLAUDE.md

| Section | Today | From step 4 | PR |
|---|---|---|---|
| the deployment ledger | "`app_deployment_confirmations` (what a person confirmed about one project space for one app: a plan feature, the flat location fixture, a Connect forwarder) is inserted on confirm and updated on withdrawal, never deleted." | "`app_deployment_confirmations` (what a person confirmed about one project space for one app: a plan feature, the flat location fixture, a Connect forwarder, sync on form entry turned off) is inserted on confirm and updated on withdrawal, never deleted." | 6 |

### lib/export/CLAUDE.md

| Section | Today | From step 4 | PR |
|---|---|---|---|
| the download paragraph | "Published nowhere it has no export of any kind: `resolveDownloadTarget` refuses its `.ccz` with `selection-held-from-hq`, carrying the findings' lines, and it runs in Preview until an edit clears the finding." | kept; adds part 05 §16's sentence | 5 |

### lib/preview/CLAUDE.md

| Section | Today | From step 4 | PR |
|---|---|---|---|
| new section **Platforms** after the intro | (none) | adds part 06 §26's section: `platform.ts` is the one rule table, `effectivePreviewPlatform`, the device as an engine input, the session values of part 06 §18 | 8 |
| the display conditions paragraph | "Preview plays one runtime per behavior until it plays each platform: after-submit routing opens a link's target whatever its visibility (Android), and an entry point opens a form off the menu only when it ignores display conditions (Web Apps), with `entryPointLaunch.ts::FORM_OFF_THE_MENU_ENTRY_POINT_REFUSAL` saying what each platform does otherwise. `firstMenu` resolves to the same home screen as `app_home` (Web Apps shows the app's first screen for both), and `parentMenu` to the parent module's screen with its selection kept." | "Preview plays the platform it runs as (`lib/preview/platform.ts`): after submit, a link's target hidden by its condition opens on Android and lands where Web Apps lands it on Web Apps (`afterSubmitHiddenTarget`), and an entry point keeps display conditions on Web Apps unless it ignores them and ignores them on Android (`entryPointDisplayConditions`). `firstMenu` opens the app's first screen on both; `app_home` opens it on Web Apps and the device home screen on Android (`postSubmitAppHome`); and `parentMenu` opens the parent module's screen with its selection kept." | 8 |
| the `here()` paragraph | "That is CommCare Android's rule (`AndroidHereFunctionHandler.java::REFRESH_METER_DELTA`, `::shouldRefreshEntityList`, `GeoUtils.java::DEFAULT_ACCEPTABLE_ACCURACY`): Web Apps' list rows never read the worker's location, so Android's handler is the one CommCare rule for a moving position." | kept; adds "Android's value holds four numbers, latitude, longitude, altitude and accuracy, the last two floored to two decimals (`hereValue`); an app that runs in Web Apps cannot hold `here()`." | 8 |
| the answer reads (new sentence) | (none) | adds part 03 §2.10's sentence ("A time answer reads as its wall clock with no zone …") | 3 |
| after the no-matches registration paragraphs (new sentence) | (none) | adds part 03 §11's sentence ("A form of a search-first module receives its completed search's answers, …") | 10 |
| heading | "## Sections page the preview on Android's rules" | "## Form screens per platform" | 9 |
| its first paragraph, the closing sentences | "Default Web Apps shows the same form as titled groups on one page; the preview follows the device and the docs say so. A form with no sections is untouched." | "Running as Web Apps, Preview shows the same form as titled groups on one page, as Web Apps does. Running as Android, a form with no sections pages one screen per labeled group and per question outside one." (part 06 §26) | 9 |
| "First-class date type in the XPath evaluator" | (the section) | gains the day-number epoch (part 06 §12.3) | 8 |
| "Case tiles in the running app", "Resolved preview identity", "Entry-point launch" | (their paragraphs) | each gains its platform rule as part 06 §26 lists it, and the formless case list its sentence | 8 |

### lib/session/CLAUDE.md

| Section | Today | From step 4 | PR |
|---|---|---|---|
| the running facts | "`previewClaims` holds the running worker's claims" (opening of its paragraph) | kept; adds a paragraph naming `previewPlatform`, `previewAtDeviceHome`, `previewDeviceSyncedAt` and `previewAndroidDeviceId` with part 06 §3.2's lifetimes, and that the effective platform is derived, never stored | 8 |
| `assetMeta` | "`assetMeta` is the sibling registry: asset rows observed this session (library pages the pickers load, upload confirms, the budget check's own fetches), keyed by id." | kept; adds "Each row carries its `mediaFormat`, which the attach guard, the pickers and Preview's stand-in read." | 7 |
| `previewCaseTarget` | "`previewCaseTarget` means one exact Form is opening with an ordered `cases`" (opening of its bullet) | kept; the bullet adds "and, after a case list's filter, `caseListSearchText`, which the entry's session holds as `stringquery`" | 10 |

### lib/preview/app-tests/CLAUDE.md

| Section | Today | From step 4 | PR |
|---|---|---|---|
| the runtime version | "Version 16 fences the expression model: a journey started before it pinned a document whose expressions the current model does not read." | kept; adds part 06 §21.5's sentence ("Version 17 fences platforms: …") and §21's per-session platform and device home | 8 |

### components/builder/CLAUDE.md

| Section | Today | From step 4 | PR |
|---|---|---|---|
| the Preview header | "This fits the shared header between its home and account controls at 320px." | kept; adds "The platform choice is a group in the identity menu, so the band still fits at 320px." and the Runs on group | 9 |
| "Case-list workspace", the Details paragraph | "A module with no case-loading Form is informational." | "A module with no forms plays the runtime: Details offers Continue when it has columns, and choosing a case returns to the app's first screen in Web Apps, with its sync notice, or to the phone's home screen on Android." (part 06 §9) | 9 |
| "Flipbook (edit ↔ live) invariants", the scroll sync bullet | (its bullet) | kept; adds "A row the running platform draws differently (help behind its button, Android's group header, choice media on Web Apps) keeps the anchor field; rows after it may move." (part 06 §13) | 9 |
| "Settings popovers" (new paragraph) | (none) | adds part 07 §5's `AppPlatformsSection` paragraph, and the Connect paragraph's store behavior (§2.7) | 11 |
| the Search field editor | "Both say "Checked in the browser app. On a phone the search runs either way" because Android never enforces prompt validation." | "Neither carries a platform hint: where the app also runs on Android, the `search-field-checks` note row says Android searches without checking the answer." | 11 |
| "Show on the menu" | "With the switch off the section says, per platform, how the item is still reached (`displayConditionCopy.ts`: on Android from an after-submit link or an entry point, in Web Apps only from an entry point that ignores display conditions)." | "With the switch off the section says how the item is still reached on each platform the app runs on (`displayConditionCopy.ts::formOffTheMenuNote(platforms)`: on Android from an after-submit link or an entry point, in Web Apps only from an entry point that ignores display conditions)." | 11 |
| the link editor | "Under a link whose target some worker may not see on the menu, the link editor says what each platform does (`afterSubmitCopy.ts::hiddenTargetLine`, from `formLinkTargetVisibility`): a target form hidden by its condition opens on Android and lands on the module that holds it in Web Apps; a target module hidden by its condition opens with nothing in it on Android and lands on the app's first screen in Web Apps." | the same sentence with "says what each platform the app runs on does (`afterSubmitCopy.ts::hiddenTargetLine(…, platforms)`, …)" | 11 |
| the case-list workspace, Convert Type, insertion menu, media, case-type picker and session-context paragraphs | (their paragraphs) | each gains part 07 §5's sentence: the disabled-with-reason sites and the note row mounts; the split item, and `Date and time (as two questions)` in the insertion menu where Web Apps is declared; the pickers' per-asset and per-format reasons and the file manager's "Plays on" line; the comparison card's language-code picks beside the case-type picker; "Each choice asks the slot's rule admission, so one the app's platforms refuse is disabled with the platform's picker line." | 11 |
| the session-context bullet | "New choices offer `userid`, `username`, `deviceid`, and `appversion`. Stored `drift` (Device clock offset), `window_width` (Window width), and `applanguage` (App language) appear as named read-only values" | part 03 §11's replacement ("New choices offer all seven session fields, `drift` as Device clock offset, `window_width` as Window width (only where its slot profile admits it) and `applanguage` as App language") | 10 |
| "Cards dispatch on syntax within the one `Expression` AST." | "`NegateCard` ("Negative of") and `HereCard` ("Where you are now") are offered where the profile admits them" | kept; the bullet adds `CaseListSearchTextCard` ("Case list search text"), offered only where `SlotProfile.caseListSearchText` holds (part 03 §5.4) | 10 |

### components/CLAUDE.md

None. No convention changes: every platform stand-in is built from `components/shadcn`, the
disabled-with-reason rule and the voice already hold, and no sentence about Web Apps or Android
there becomes false.

### lib/codemirror/CLAUDE.md, lib/agent/CLAUDE.md, lib/agent/authoring/CLAUDE.md

| File, section | Today | From step 4 | PR |
|---|---|---|---|
| `lib/codemirror/CLAUDE.md`, "No offer-then-reject" | "Keep completion and validation reading one source." | kept; adds part 07 §5's sentence (a session read one platform lacks, `stringquery` and, under outcome A of the window width gate, `window_width`, is offered only where the slot's declared platforms admit it) | 11 |
| `lib/agent/CLAUDE.md`, the shared tool results paragraph | "A success does not imply publication: the architect, ordinary editor and MCP all stage app changes until `saveWork`." | kept; adds part 07 §5's sentence: "`addFields` and `editField` refuse a field kind the app's platforms can't run before staging, and `updateApp` checks content and media before a change that adds a platform, each with the gate's own words (`tools/shared/platformPrecheck.ts`), because private work stages a batch whatever its findings." | 12 |
| `lib/agent/authoring/CLAUDE.md` (new paragraph) | (none) | adds part 07 §5's two sentences (generated platform sentences move `MODEL_CONTEXT_VERSION`; the overview's `platforms` and `notOffered` read the same table) | 12 |

## Public docs that change

Every sentence follows `design/readme.md`, "Content fundamentals": it invites, takes
responsibility, offers the next step, and uses no em dash. Each paragraph has one owner, and the
text a part writes word for word is cited rather than restated. Public docs land in pull request 14
but for two recorded exceptions: the `### Preview on Web Apps and Android` subsection (9, because
the cell table's `stated` docs rows read its heading) and the notice's two passages (13, because a
notice row names what changed from the moment the cutover commits).

| Page | What changes | Text | PR |
|---|---|---|---|
| `building-with-nova.mdx`, "Try the app in Preview" | gains `### Preview on Web Apps and Android` | part 06 §26 | 9 |
| `building-with-nova.mdx`, the `here()` paragraph | "On Web Apps it shows it in the case's details, once the browser shares its location, while the list's rows and sorts don't know where the worker is." is false at the pins | the paragraph of part 03 §3.2 | 14 |
| `building-with-nova.mdx`, the media paragraph ("The images, audio and video you upload to an app can be PNG, JPEG, GIF, WebP or …") | the formats and where each plays; SVG refused | part 04 §11 | 14 |
| `building-with-nova.mdx`, new section "Asking for a date and a time separately" | what the split does, why Web Apps needs it, what workers see | "Web Apps has no way to answer a date-and-time question, so in an app that runs in Web Apps, Nova asks for the date and the time as two questions. Choose **Ask for the date and the time separately** on a date-and-time question, and Nova adds a date question and a time question just before it and turns the original into a hidden value that joins them. Your rules, labels and saved cases keep reading the original, so they read the same date and time as before. Workers see two questions with the original's label, and you can give each one its own, such as Visit date and Visit time. A date with no time, or a time with no date, gives a blank value, so both are required where the original was. CommCare HQ's exports gain a column for each new question. [Where workers use your app](/docs/where-workers-use-your-app) lists everything else one platform can't run." | 14 |
| `case-workspace.mdx`, the `here()` paragraph | one merged edit of parts 03 and 06 | part 07 §5 | 14 |
| `case-workspace.mdx`, the barcode and required-field sentences | per platform | part 06 §26 | 14 |
| `commcare-connect.mdx`, new section "Where workers open a Connect app" | Connect apps run on Android only | part 01 §10.3 | 14 |
| `publishing.mdx`, "What the project space's plan includes" | the list gains Web-Based Apps (CloudCare) for an app that runs in Web Apps | "Some of what an app uses comes with some CommCare HQ plans and not others: Web Apps for an app that runs there, worker records, lookup tables, child cases, links to other forms, Save to Case, locations, and Data Forwarding for a CommCare Connect app." (the sentence that opens "Some of what an app uses comes with some CommCare HQ plans and not others: worker records, …") | 14 |
| `publishing.mdx`, the project-space settings list | gains a third item | "- **Sync Cases On Form Entry turned off**, for an app that runs on Android and has a menu with Search whose form works on a case. While it's on, Android phones can't open those forms. A project space admin can turn it off on the project space's Case Search page, and an app that runs in Web Apps only doesn't need it." (and "Two project-space settings" becomes "Three project-space settings") | 14 |
| `publishing.mdx`, "A note on Web Apps" | rewritten | "Nova sets the app's **Web App** setting on CommCare HQ from where the app runs, at every publish: on for an app that runs in Web Apps, off for one that runs only on Android. If the setting there differs, because you changed where the app runs or someone changed it in CommCare HQ, the publish asks you before changing it, and says which it was. CommCare HQ makes a new app with Web Apps on only where the project space's plan includes it, so a first publish of an app that runs in Web Apps to a plan without it stops after making the empty app. You can then set the app to run on Android only, if its content allows it, or confirm the plan again once it includes Web Apps, and the next publish fills in the same app." | 14 |
| `publishing.mdx`, "Downloads" | an app that runs in Web Apps only has no CCZ | kept; adds after "…so publish it to a project space first.": "An app that runs in Web Apps only has no CCZ either, because a CCZ installs an app on Android phones. If its workers use phones too, you can set it to run on Android as well, in App settings." | 14 |
| `publishing.mdx`, the form-lists paragraph | the platform clauses leave | part 07 §5 | 14 |
| `publishing.mdx`, "Updates to review" | "or where they run" | part 09 §12 | 13 |
| `project-space-compatibility.mdx`, "Plan features" | the catalog renders both from the records; the prose names the third setting | "Three project-space settings are asked about the same way: the flat location list, a Connect forwarder, and Sync Cases On Form Entry turned off." | 14 |
| `attachments.mdx` | one edit of parts 06 and 07 | part 07 §5 | 14 |
| `form-sections.mdx`, `form-links.mdx`, `deep-links.mdx`, `users-and-personas.mdx` | Preview per platform | part 06 §26 | 14 |
| `mcp/tools.mdx`, the `upload_app_to_hq` row | loses "A success also returns `web_apps_enabled`, whether CommCare HQ offers the app in Web Apps there, and" in favor of "A success also returns"; gains the two refusals and `confirm_web_apps`, `confirm_form_entry_sync_off` | part 05 §14's descriptions, in the page's voice | 14 |
| `mcp/tools.mdx`, the `compile_app` and `withdraw_deployment_confirmation` rows | per part 05 §14 | part 05 §14 | 14 |
| `mcp/tools.mdx`, the `upload_media_asset` row | formats and where they play | part 04 §11 | 14 |
| `mcp/tools.mdx`, the `update_app` row | `runs_only_on` | part 07 §5 | 14 |
| `mcp/tools.mdx`, the `start_app_test` and `evaluate_form` rows | `platform` | part 06 §22 | 14 |
| `mcp/tools.mdx`, the expressions paragraph | "In a calculated case-list column, `here()` reads where the worker is now" gains "in an app that runs only on Android" (part 03 §3.2) | part 03 §3.2 | 14 |
| `mcp/tools.mdx`, the `get_app` row | "or where they run" | part 09 §12 | 13 |
| `where-workers-use-your-app.mdx` (new), listed in `meta.json` after `building-with-nova` | "The three choices", "What each choice offers", "Asking for a date and a time in Web Apps" | part 07 §5; its third section names the insertion menu's `Date and time (as two questions)` and the split gesture in part 07 §2.6's toast words, and links to `building-with-nova.mdx`'s "Asking for a date and a time separately" for what the split does | 14 |

No `design/` change: step 4 adds no visual primitive; every new control is a `components/shadcn`
composition in Nova's tokens. Pages read that need no change: `index.mdx`, `projects.mdx`,
`nested-menus.mdx`, `languages.mdx`, `case-changes.mdx`, `case-choices.mdx`, `project-data.mdx`,
`organization.mdx`, `automations.mdx`, `display-conditions.mdx`, `cross-facility-referrals.mdx`, and
every page under `claude-code/` and `mcp/` but `tools.mdx`.

## The proof lane's documents and the research

**`proof/README.md`**, each change in the pull request that makes the old text false:

| Section | Change | PR |
|---|---|---|
| "Manifest checks", the register's bullet, the loader's rule 1 | part 02 §2.3 | 1 |
| "Walk stops" (its count sentence), "Configurations", "The Web Apps driver", "Served states", "Fixed defects" | part 08 §8 | 2 |
| "Native proofs", "Targeted documents" | each document and scenario of part 08 §4 and §5 in its pull request | 3, 4, 6, 9, 10 |
| "Walk stops" (finding 74's paragraph), "Connect in the unit", "The corpus" ("Platforms") | part 08 §8 | 4 |
| "The defect rows", row 21's checks column | "manifest (`list-first-with-web-apps`, from step 4's `cloudcare_enabled`)" (part 08 §2.5) | 5 |
| "The defect rows", row 20 | part 08 §8 | 6 |
| the native `media` family | its three scenarios, four under the AVIF gate's refused outcome (part 04 §8.3) | 7 |
| the tables that count documents, controls and groups | the counts at 14's head | 14 |

**`proof/CLAUDE.md`**: the reader-policy bullet and the Web Apps bullet's parenthesis (2), and the
Connect bullet's sentence (4), each as part 08 §1.8 writes it.

**`docs/research/2026-09-26-hq-round-trip/harness-findings.md`**: finding 74 gains "*Closed in step
4:* …" (4) and finding 64 gains "*Step 4:* …" (5), each as part 08 §8 and §7.3 write it.

**The inventory** (`docs/research/2026-09-26-hq-round-trip/inventory/*.md`): every row an entry
edit moves, in the entry's pull request, as part 02 writes each (1, 4, 5, 6, 7, 10); the Counts table
stays the research's.

**`docs/plans/hq-round-trip/README.md`**: the sentence naming defect 20 among the live register's
defects drops it (14); its four links to this plan, "Step 4 is done" and the cutover's trace, as
pull request 15's list gives them (15).

## The nova-plugin check

`../nova-plugin`, read-only for planning at `14af38e` (`version` `2.2.0`), was swept by part 07 §4
by claim, for every claim step 4 changes: where an app runs, Web Apps and Android, `cloudcare`,
date and time, capture, search first, several cases, and the publish confirmations. No skill
teaches field kinds, capture, search first or several-case forms; `build`, `autobuild`, `edit` and
the autonomous agent send the model to `get_agent_prompt` and `get_authoring_guide`, which Nova
serves and which change with the deploy. Every sentence step 4 makes false is in
`skills/upload_to_hq/SKILL.md`, and part 07 §4 lists the six edits: the `web_apps_enabled` bullet
and response key go; the check and `hq_confirmation_needed` name the sync confirmation with part 05
§10's predicate (an app that runs on Android and has a menu with Search whose form works on a
case), and the entry shape and the check's rows gain `where_missing`, which the agent relays where
it is present, since it is the one field that says what the user can do next (part 05 §9); the
retry lists gain `confirm_form_entry_sync_off` and `confirm_web_apps`; the refusal list
gains `hq_web_apps_change` and `hq_plan_lacks_web_apps`; and the destination-check paragraph gains
that narrowing to Android only is the user's decision, never made unasked.

The rule for the stack:

1. Pull request 12, which ships the last model-facing text, runs the sweep again at the plugin's
   head then, by claim and never by this list of files, against the guide and tool text it ships.
2. The fix is one pull request in `../nova-plugin`, cut after pull request 12, with
   `.claude-plugin/plugin.json` going from whatever it holds then to the next minor version (`2.2.0`
   makes `2.3.0`: it teaches two new arguments and two refusals). It merges only after the Nova
   deploy carrying pull requests 5, 6 and 12 is live (house rule 10 confirms it).
3. Pull request 14 records that pull request's link and the repeated sweep's result.

## The exit

Step 4 is done when every row below holds, each checked after the merge from `main` and the first
nightly; none needs a third run of anything.

1. **Every held feature carries its platform behavior.**
   `lib/commcare/surface/__tests__/platformFeatures.test.ts` passes on `main`: every HELD entry read
   per platform whose readings differ is a feature's or ambient (rule 4), every feature reads as
   each entry it names (rule 3), each entry is named once (rule 5), and every HELD media entry reads
   as its formats (rule 7). The table holds 47 features naming 70 entries and 34 ambient entries
   (48 features under outcome B of the window width gate).
2. **No app holds a feature unavailable on a platform it declares**, held three ways. The gate:
   `PLATFORM_FEATURE_UNAVAILABLE` and the checker's `platform-unavailable` refuse every use, and
   `lib/commcare/validator/__tests__/platformAvailability.test.ts` holds the gate to
   `platformRefusal` for every refusable feature and declaration; the kernel refuses a file a
   declared platform cannot play (`platform-unplayable`) and the boundary holds
   `MEDIA_FORMAT_NOT_PLAYED`. The cutover's postconditions: every app loads under the absolute gate
   and its media projection passes the platform-aware lock (part 09 §10). The runtime probe: the
   deploy's `runCanonicalRuntimeDatabaseProbe` reruns the absolute gate and the platform-aware media
   audit over every app and finds nothing.
3. **Every platform cell that differs has a Preview test.** `lib/preview/__tests__/platformCells.test.ts`
   passes: its table's keys equal every `(entry, platform)` cell of every HELD entry whose reading
   is neither `runs` nor `not-applicable`, and each `model` row's check, `browser` row's scenario,
   `refused` row's feature and `stated` row's note or heading holds.
4. **The registers at exit** (part 08 §2.6): `proof/known-defects.json` 273, none of defect 20;
   `proof/fixed-defects.json` 749, defect 20's 15 among them, each showing on its control and on no
   document (272 and 750 under outcome B of defect 21's `requests` entry, which then shows on
   `targeted-sync-on-form-entry`'s control among the fixed entries); `proof/controls/` 109, every one named; `proof/walk-stops.json` 25, finding 74's held on
   the control `targeted-datetime-ordering` alone and none on `fuzz-xform-20260930-0`;
   `OPEN_DEFECTS` names eight defects (21, 23 to 28, 30), every one a later step's, which
   `test_every_live_defect_is_a_later_steps` asserts (`step > 4`, from pull request 6); the corpus holds 398 documents, 326 on both,
   40 Web Apps only and 32 Android only.
5. **Every existing app is declared and has its notice.** The cutover committed (its execute report
   archived to `gs://commcare-nova-cutover-evidence/hq-round-trip-platforms/`); every ready image,
   audio and video row holds a format and `media_assets_ready_media_format` is validated; every
   app with planned entries has exactly one notice row for `hq-round-trip-platforms`; the bucket
   grant is revoked and read back; runbook step 10's drift writer wrote exactly the case-schema
   drift the dry run counted, and `scripts/scan-schema-drift.ts --prod` then reports no drift (part
   09 §10, §14).
6. **The first nightly with every reader holds**, or each group it names failing is fixed and
   rerun alone by name until it does (house rule 11).
7. **The served contract is checked**: `MODEL_CONTEXT_VERSION` is `"v5-hq-round-trip-platforms.12"`
   and `RUNTIME_VERSION` 17; the billed schema check passed for every tool it named, or each refused
   schema was fixed and checked again; `lib/mcp/__tests__/servedSchemas.test.ts` passes.
8. **The plan has left.** This plan, its part directory, the runbook and the tooling are removed
   (pull request 15); the plans `README.md` reads step 4 done; each deferral is written into the
   step that receives it; and the `../nova-plugin` pull request is merged after the deploy.

## Executed during planning

Read-only; no file of the repository or of `../nova-plugin` was changed but this one, and no
Docker, lane, test suite, build or billed call ran.

1. **The counts at `main` `e9e6cd93`**, by a `python3 -I` read of the JSON registers
   (`proof/known-defects.json` 286, `proof/fixed-defects.json` 734, `proof/walk-stops.json` 26),
   `ls proof/controls | wc -l` (108), `proof/checks/registers.py::OPEN_DEFECTS`,
   `lib/models.ts::MODEL_CONTEXT_VERSION`, `lib/db/appTests.ts::RUNTIME_VERSION` (16) and
   `scripts/test-schema.ts`' entries and header.
2. **Every "Today" quote** was read in its file at `main` with `rg` and `sed`, and the terms the
   rewrite could make false were searched across every `CLAUDE.md`, `docs/architecture/` and
   `content/docs/`: "one wire flavor", `cloudcare_enabled`, `target_web_apps_enabled`,
   `web_apps_enabled`, "no rule reads the app settings" (a code comment in
   `lib/doc/incrementalValidationScope.ts`, which part 01 §1.2 rewrites, and in no contract file),
   Web Apps, Android, date and time, `datetime`, camera, SVG, `compileForPlatform` and
   `PlatformContext`.
3. **The importers of `compileForPlatform.ts` and `PlatformContext`**, by `rg -l` at `main`: the
   files pull request 4's list names.
4. **The e2e seeds that hold a date-and-time question**, by `rg -n '"datetime"' e2e/lib` at `main`
   (`caseWorkspaceSeed.ts`, `preview-repeats-client.tsx`, `preview-language-screen-doc.ts`; the
   fourth hit, in `smokeSeedFactory.ts`, is a lookup column), and every spec that reads them, read
   whole for its subject: the outcomes pull request 4's list gives.
5. **The lane's readers of a local archive**, by `rg -n 'local_ccz|local\.ccz' proof -g '*.py'` and
   `rg -n 'local.ccz' proof/native` at `main`, each read for the documents it names against part 08
   §3.1's Web Apps-only list: `proof/hq/test_publish.py`'s `ARCHIVE_DOCUMENT`,
   `proof/rules/test_xpath_reading.py::_texts` and `proof/native/steps/session_reads.py` read one;
   every other reader names documents that run on both, a control, or skips an absent archive.
