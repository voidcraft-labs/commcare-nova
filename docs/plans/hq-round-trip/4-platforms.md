# Step 4: Platforms

Step 4 makes where an app runs a fact of the app. Every app declares Web Apps, Android or both
(`appSettings.runsOnlyOn`), and from that one declaration Nova refuses a feature or a media file a
declared platform cannot run, offers each choice only where it runs, states each difference where
the author works, publishes the declaration to CommCare HQ, and plays each declared platform in
Preview. It fixes the second half of defect 11 (media by platform), defect 18 (the date-and-time
question in Web Apps), defect 19 (features that behave differently by platform, silently), defect
20's sync on form entry (its CommTrack half moves to step 5), finding 74 (the walk stops of the Web
Apps client's date-and-time placeholder), and the four reads step 3 left to the declaration. It
ships as one stack of fifteen pull requests, one maintenance cutover and one deploy.

This file is the plan. It holds the baseline the plan was written against, every decision that
departs from the outline it replaces or from the research, the work items with where each is
planned in full, the stack, the cutover, the contracts and the exit. The detail (schemas, files,
manifest text, register moves, tests, copy) is in ten part files beside it,
[`4-platforms/`](4-platforms/). A session implementing one pull request reads this file, that pull
request's row and its file list in part 10, and every part the row names. Nothing here or there is
left to decide during implementation: where a run outstanding decides a fact, both of its outcomes
are written out in full. Every claim about what a CommCare reader does with Nova's export was read
at the pins or observed during planning; "Written and not yet run" below lists every gated
execution and where each outcome is written.

| Part | Holds |
|---|---|
| [01](4-platforms/01-declaration-and-features.md) | The declaration (its stored shape, mutation, readers and writers, why no horizon and no DDL yet a window), the platform table `lib/domain/platforms.ts` and its detectors `lib/domain/platformUses.ts`, the 47 features and 34 ambient entries, both validator channels, the refusal copy in three voices, the binding test, the parity test, CommCare Connect |
| [02](4-platforms/02-manifest.md) | Every manifest, `media-formats.json`, `gates.json` and inventory edit by pull request, the lane's HELD-NEW check, the SVG and window width readers, the instance-read lists |
| [03](4-platforms/03-questions-and-expressions.md) | Defect 18: the date-and-time question's refusal and the split (design E, rules R2 and R3, the planner); `here()` in a case list; step 3's deferred reads: Search fields in a search-first module, the case list's search text, the session context fields and the window width gate, the `current()` print |
| [04](4-platforms/04-media.md) | Defect 11's second half: the variant registry `MEDIA_FORMATS`, the new readers, `media_assets.media_format`, acceptance per reference in five places, SVG refused, Preview's stand-in, H.264 High settled by Android's decode run, the corpus stand-ins, the media runs |
| [05](4-platforms/05-publish.md) | Publish: `cloudcare_enabled`, the `web-apps` plan feature, the Web Apps question, the first-publish stop, the dropped column, the setup artifact and import file, no `.ccz` without Android; defect 20's `form-entry-sync-off` confirmation; CommTrack to step 5 |
| [06](4-platforms/06-preview.md) | Preview per platform: the effective platform, session state, the identity menu's "Runs on" group, the one rule table, the Android home screen and form screens, every differing behavior, session context values, App Tests and `evaluate_form`, the cell table, the three Android renderings |
| [07](4-platforms/07-authoring.md) | The builder (the platform section, its preflight, offering by declaration, the note row, the split gesture, the Connect dialogs) and the SA and MCP (`updateApp.runs_only_on`, the guide, prompts, overview, pre-checks); the `../nova-plugin` sweep |
| [08](4-platforms/08-proof.md) | The lane: reader policy by declaration, register and walk-stop moves, the census, the fuzz mapping, targeted documents, native classes, CI cost, reader runs by hand, the first night |
| [09](4-platforms/09-cutover.md) | The cutover and its notice: the transform, the media backfill, the ledger in the window, the fleet transaction, blockers, the Job, the runbook, the removal |
| [10](4-platforms/10-stack-contracts.md) | The stack in full with files by pull request, house rules, every contract and docs sentence that changes, the nova-plugin check, the exit |

## The baseline this plan was written against

**Nova.** `main` at `e9e6cd93` (#799), which is step 3's fifteen pull requests (#773 to #791)
merged and its cutover run on production, then #798 and #799 (dependency upgrades) and #800 (the
nightly lanes keep running past one reader's failure). What step 3 left that step 4 builds on:

- **The one `Expression` union and its checker** (`lib/domain/expression/typeChecker.ts`), whose
  `arm-unavailable` refusal already carries the reasons `here` and `places-unavailable`. Step 4's
  expression channel is a third reason, `platform-unavailable`, read from the declared platforms
  `lib/domain/expression/context.ts::slotContext` adds to `ExpressionContext` (part 01 §6), and
  `lib/domain/expression/profiles.ts`'s `SlotProfile` gains `caseListSearchText` and `windowWidth`
  (part 03 §5.3, §6.2).
- **Session datums held as what supplies them** (`DatumRef`,
  `lib/domain/entryDatumSupplies.ts::entryDatumSupplies`): the case list's search text is admitted
  only where the entry supplies exactly one `selected-case` (part 03 §5.3).
- **The session context term**, all seven fields stored and parsed, with `drift`, `window_width`
  and `applanguage` shown read-only
  (`components/builder/shared/sessionContextPresentation.ts`); step 4 types and offers them (part
  03 §6).
- **`INVALID_SEARCH_REF` and `search-answer-unavailable`**, which refuse a `#search/` read outside
  the no-matches form; step 4 admits it in a search-first module's own forms and lists (part 03
  §4).
- **The instant lowering** (`lib/commcare/xpath/wire/instant.ts::typedInstantValue`,
  `lib/domain/expression/instantOperand.ts::byType`) and the case-write sibling
  (`lib/commcare/xform/datetimeCaseValue.ts`): the split's joined value is a date and time held as
  a Core `Date`, which both already lower and write (part 03 §2.6, §2.7).
- **The wire tree** (`lib/commcare/xpath/wire/`): the count guard joins `emptyRows.ts`, and the
  `current()` print `formReads.ts::formReadToWire` (part 03 §6.3, §7.2).
- **Preview on the device's own XPath** (`lib/preview/xpath/`, `coreDays.ts`), whose per-behavior
  runtime choices step 4 replaces with one rule table (part 06 §1, §5).
- **`appSettings`** (#755): a `z.strictObject` of the two form-list booleans, with
  `NEW_APP_SETTINGS` (`lib/domain/blueprint.ts`); the declaration joins it as an optional key
  (part 01 §1).
- **Step 2's deployment ledger**: three confirmation kinds in `app_deployment_confirmations` and
  the stored read `app_deployments.target_web_apps_enabled` (part 05 §1).
- **The register and the walk stops**: `proof/known-defects.json` 286 entries (defect 20's 15
  among them), `proof/fixed-defects.json` 734, `proof/walk-stops.json` 26 (finding 74's two among
  them), `proof/controls/` 108 directories (part 08 §2.1).
- **Versions**: `MODEL_CONTEXT_VERSION` `"v4-hq-round-trip-expressions.12"` (`lib/models.ts`),
  App Tests' `RUNTIME_VERSION` 16 (`lib/db/appTests.ts`).

**CommCare.** Every fact this plan relies on was read, and where reading left doubt it is planned
as a run, at the commits `proof/pins.json` names, unchanged since step 2: commcare-hq
`d6c6e16d8ae1`, commcare-core `8e9ba8d908e9`, commcare-android `7a5584475580`, commcare-connect
`046c7fd78081`, formplayer `24383ac71bfb`, and Vellum `01215f251c57`, the build HQ vendors at that
pin, with js-xpath at `v0.0.10`, Vellum's dependency. Citations are `file::symbol`.

**Executed during planning.** Each part's "Executed during planning" gives the run and what it
showed; all were content-free and ran on this machine, one of them reading production's database
read-only. The runs that decided the plan:

- **The lane's own manifest extraction** (`proof/checks/manifest_usage.py::app_json_uses`,
  `archive_uses`) over a corpus of 392 documents emitted at `main`, without HQ's or Core's
  readings: 35 surface keys whose only allowing entries are HELD-NEW, each an item Nova already
  emits. A scan of every file inside the same corpus's archives adds a 36th the extraction cannot
  judge without Core's readings: the local archives of 385 of the 392 documents, every one with a
  form, read `session/context/drift` in the meta block
  `lib/commcare/xform/metaBlock.ts::addMetaBlock` writes on every form, which only the HELD-NEW
  `expressions-and-data/session-context-drift` names. Pull request 1 corrects all 36 by 30 entry
  edits (part 02 §1, §3).
- **A census scan of every emitted `document.json` and `edit/document.json`** by the domain shape
  of each platform-scoped feature: 324 documents run on both, 37 on Web Apps only, 30 on Android
  only (12 for a date-and-time question, 18 Connect apps) and one on neither; four edits turn
  Connect on. Joined with the registers, the reader policy moves no register entry (part 08 §3.1,
  §3.2).
- **A box walk over the corpus video** `lib/media/__tests__/fixtures/tiny-video.mp4`: its `avcC`
  is H.264 profile 100, High, and every corpus document that holds a video holds this file, a
  profile Android 6.0 does not guarantee (part 04 §8.1).
- **Android's decode probe**, `proof/android/decode/run.sh`, on the person's Mac at their request,
  on the three emulator images whose fingerprints are exactly the readers of
  `media-formats.json`'s `android-decode` record (Android 6.0, 10 and 15): each decoded
  `tiny-video.mp4` to the end of its stream, so H.264 High plays on both platforms, the corpus video
  is not re-encoded and the cutover removes no High reference. Every other fixture matched step 2's
  records but one Nova refuses at upload (part 04 §8.5).
- **`file-type` 22.1.1 sniffs** of ICO, ADTS AAC, AMR and MIDI, and reads of its MKV detector
  (part 04 §2.2).
- **Pillow 12.3.0**, the version commcare-hq's `uv.lock` pins, opened an ICO and an AVIF file and
  refused an SVG file with `UnidentifiedImageError`, which HQ's `CommCareImage.get_image_object`
  turns into a refused image (parts 02 §7.1, 04 §4). This ran on this machine's build of Pillow;
  HQ's Linux image is a run outstanding (below).
- **Two UUIDv5 computations** giving the split identities of the corpus's one document on neither
  platform (part 03 §2.5), and reads of the installed Google Cloud SDK and of `file-type`,
  `music-metadata` and their dependencies for the cutover's bucket grant and bundle (part 09).

- **A content-free, read-only scan of production**, which the person approved; no count from it
  enters this plan, and each part states what it found where that decides something. Production
  holds Connect apps of both kinds, so the cutover's Connect arm declares many apps Android only,
  some of them holding date-and-time questions that therefore need no split (part 01 §10.3, part
  09 §5). A few other apps become Android only for a date-and-time question alone, a few Web Apps
  only (for Search first or for a single-date Search field), and a few run on neither, each
  because of a date-and-time question beside a single-date Search field, so the split runs in
  production (part 03 §10, part 09 §5). No app is of a blocker class: no Connect app holds
  something Android cannot run, and there is no `here()` and no `window_width` read (part 09 §11).
  No `drift`, `window_width` or `applanguage` read is stored (the session context reads are of
  `userid` and `username`), so pull request 10's typing meets nothing stored, and no clock-keeping
  date is stored (part 03 §10). Media rows are JPEG and PNG images beside documents, with no audio
  or video row, so the backfill classifies images only, from their MIME with no byte read, and the
  cutover removes no media reference (part 04 §9, part 09 §7). Some deployments store
  `target_web_apps_enabled` `true` and most null (part 09 §2).

The cutover's advisory scan and dry run still count every class the plan meets before the window,
and every class they can find has a planned transform or is a blocker with its remedy (part 09
§11). Nothing was run in HQ, Core, Formplayer, Connect, a browser or the lane.

**Written and not yet run.** Each part states its design as the plan's and says in place where a
run is outstanding; this list is every such place.

- **The window width gate** (pull request 10). Two methods of
  `proof/native/core/SessionContextRuntimeTest.java`, a hand-started dispatch of the `expression`
  family on pull request 10's branch before that pull request's manifest text is written: whether a
  bare form read of the absent `window_width` throws on a form Formplayer deserializes afresh after
  a miss of `FormDefinitionService.getFormDefWithCache`. The run decides by assertion:
  `windowWidthReadOnAFreshForm` asserts outcome A (the bare read throws
  `XPathTypeMismatchException`) and `windowWidthReadOnACachedForm` asserts it reads `''`, so a
  green slice is outcome A, and a red one whose failure message names the value read is outcome
  B, after which the assertion flips (part 03 §6.4, part 08 §6.3). Outcome A (expected: it throws)
  and outcome B (it reads `''`) are written in part 01 §4.1, §4.2, §4.5 and §7, part 02 §5.3 and
  §8.4, part 03 §6.4, part 06 §18.3 and §23.3, part 07 §1 and §2.5, and part 09 §5, §6, §11 and
  §12.
- **Preview's three Android renderings** (pull request 9): Markwon's label rendering, a tile
  cell's top and bottom alignment, and the outcome of submitting a form opened for a case the
  phone lacks, three slices over `targeted-preview-android-renders` on GitHub's runners. Pull
  request 8 lands each rule's value marked "until" with no reader and no copy; pull request 9, once
  its slices have run on its branch, lands the copy each one decides (part 06 §24.1 to §24.3 and
  §8.3 give both outcomes of each).
- **AVIF in HQ's Linux image** (pull request 7): the native `media` scenario `media-web-apps-on`.
  If HQ stores it, the plan stands; if not, AVIF leaves the registry, a REFUSED entry takes it, and
  a fourth scenario, `media-avif-refused`, executes HQ's refusal (part 04 §8.3).
- **Browser playback** (pull request 7's CI): `e2e/tests/browser/media-play.spec.ts` in the
  Chromium headless shell and WebKit. Every file playing records `browser-playback-ci`; a file an
  engine does not play turns its item's Web Apps reading `unavailable` (part 04 §8.4, part 02
  §7.2).
- **HQ's bulk upload of every new variant and of an SVG** (pull request 7's lane): a variant HQ
  types as another kind leaves what Nova accepts (part 04 §8.3, part 08 §5.3).
- **Publish's three proof runs** (pull request 5; part 05, "Written and not yet run", writes both
  outcomes of each): the 402 a mobile worker meets without the privilege
  (`proof/webapps/test_session.py`, a slice started by hand, part 08 §6.3, pull request 5's row),
  where if `proof.hq.requests` cannot serve a mobile worker the test signs in through the Web Apps
  reader's own session; HQ's update keeping the setting on an app made without the privilege, a
  state Nova's publish stops at (`hq_plan_lacks_web_apps`), which three HQ-side tests reach on
  purpose through `proof/observe/publish.py`'s `plan_without_web_apps`, leaving only
  `cloudcare_enabled` out of the content's hold; and the App Settings save that turns the setting
  off without the privilege (`proof/editors/test_plan_features.py`), which pull request 5's own
  lane decides, since HQ's editors run there without the served readers and the test starts none,
  and where if the save leaves the setting on, the test is renamed and asserts the setting
  unchanged, and every sentence saying a settings save turns it off goes, the `web-apps`
  consequence's second clause among them.
- **The reader runs by hand** at the heads of pull requests 2, 3 (the split on every reader; HQ's
  two editor saves keeping the typed bind run in pull request 3's own lane, part 03 §2.3), 4, 5, 6,
  9 and 10 and once at the top of the stack (part 08 §6.3, with what each must show and how an unforeseen stop is handled; pull request 7 moves no document's key and has none);
  and the control `targeted-list-first-web-apps-declared`, retained from pull request 5's first
  lane run (part 08 §2.5).
- **Defect 21's re-homed `requests` entry** on `targeted-sync-on-form-entry-web-apps`, decided by
  pull request 6's own lane (part 08 §2.4). Outcome A: the new document shows the class and the
  entry stays live there. Outcome B: it does not, so the class needs sync on with Android, which
  Nova's publish now refuses, and the entry moves to `proof/fixed-defects.json` on its retained
  control `targeted-sync-on-form-entry` with that reason. Part 08 §2.4 and §2.6 and part 10's
  pull request 6 row give both outcomes and both sets of counts.
- **The new native classes** run in their pull requests' lanes: `DatetimeSplitRuntimeTest` (pull
  request 3; the instant of a repeated fall-back hour is recorded, part 03 §2.12) and
  `RowPredicateCurrentRuntimeTest` (pull request 10, part 03 §9).
- **Formplayer's `appversion` and `deviceid`**, held by the intent check only on a lane with the
  readers (part 08 §4.4).
- **The billed `npm run test:schema`**, asked of the person once at pull request 12's head (part
  07 §3.10).
- **The cutover's advisory scan and dry run**, the formats of production's media rows (from their
  MIME, and from their bytes only for a row that needs them, with the bucket grant made only then),
  and the fleet transaction's duration; a plan longer than an hour raises the Job's timeout before
  the window (part 09 §7, §13, §14).
- **The first nightly after the merge**, the whole lane with every reader (part 08 §6.4).

## What changed from the outline, and why

The outline fixed the step's scope. Planning it against the code as it stands changed these. Each
is a decision; the part named gives its evidence.

1. **The declaration is an optional key with no horizon.** `appSettings.runsOnlyOn?: "web-apps" |
   "android"`, absent for both, which every new app declares; "neither" is unrepresentable. The
   author chooses the declaration, and nothing infers it from a feature. An optional key needs no
   fold horizon and no DDL (every baseline and stored patch still parses); the window is needed
   because the previous image's strict schema refuses the key (part 01 §1, part 09 §1).
2. **One platform table, its detectors and a binding test.** `lib/domain/platforms.ts` holds 47
   features (48 under outcome B of the window width gate) with their readings and copy, and 34
   ambient entries; `lib/domain/platformUses.ts` finds every use. Both stay in `lib/domain`, because
   the builder offers from them and `components/**` may not import `lib/commcare`. A test over
   `lib/commcare/surface/platformFeatureEntries.ts` holds the table to the manifest in seven rules,
   so a pin update that moves a reading fails until the table moves, and a parity test holds the
   table to the gate (part 01 §2 to §4, §8, §9).
3. **Two validator channels from one source.** A structural use is `PLATFORM_FEATURE_UNAVAILABLE`
   (`soundness`, an `APP_RULES` rule, scope-exempt, so a scoped commit meets it); an expression leaf
   is the checker's `arm-unavailable` with reason `platform-unavailable` and keeps its slot's code,
   so the scoped-run law holds (part 01 §5, §6).
4. **A Connect app runs on Android only.** Connect makes each worker's HQ account with no password
   and signs them in only through the Connect app on Android. Turning Connect on in the builder
   narrows the app in the same batch, which the dialog states first; turning it off never widens
   (part 01 §10, part 07 §2.7).
5. **`here()` in a case list is unavailable on Web Apps everywhere**: rows, sorts and the case
   detail, since Web Apps' client sends Formplayer no location. Pull request 1 corrects the
   reading (part 02 §3.6, part 03 §3).
6. **The split is design E, not the research's.** The original question keeps its UUID, id,
   position, `relevant` and `caseWrite` and becomes a Hidden Value calculated by the clock-keeping
   date over a date question and a time question inserted before it. No reader is rewritten, HQ's
   `question_path` does not move, and Core holds what it held. Typing rule R2 and bind rule R3 make
   that one shape a date and time; conversions become representable both ways so undo replays (part
   03 §2). The cutover splits only an app whose content runs on neither platform; the builder
   offers the split on any date-and-time question (part 07 §2.6).
7. **SVG is refused for every app.** HQ stores an image only once Pillow opens it, Pillow reads no
   SVG, and one SVG stops the whole bulk upload of a publish (part 04 §4, part 02 §7.1).
8. **Media is a variant on the row and acceptance per reference.** Each ready file records its
   variant (`media_assets.media_format`); upload accepts a variant one platform plays and HQ types
   and stores; a reference is accepted only where every declared platform plays it, at the commit
   kernel, the attach verdicts, the export boundary (`MEDIA_FORMAT_NOT_PLAYED`), the builder and the
   declaration change. Bytes no variant admits are kept as `unplayable` (part 04 §2, §5, §6).
9. **H.264 High plays on both platforms, by Android's decode run.** The documentation left it to
   Web Apps, since Android 6.0 guarantees only Baseline and Main; the person ran Android's decode
   probe on their Mac during planning, and all three emulator images decoded the corpus's High
   video to its end. So its item reads `runs` on Android with `executed: "android-decode"` and a
   note keeping the guarantee in view, its inventory entry merges into the Baseline-or-Main one, the
   corpus video is not re-encoded, and the cutover removes no High reference (part 04 §8.5, part 02
   §7.1).
10. **Publish writes `cloudcare_enabled` from the declaration on every generated application
    body**, never through the target overlay (part 05 §2).
11. **`cloudcare` is the plan feature `web-apps`**, asked for an app that declares Web Apps, with no
    new kind and no DDL (part 05 §3).
12. **One Web Apps question, `hq_web_apps_change`.** It is asked on an update of an app holding
    Nova's content when HQ's setting differs from the declaration, whoever moved it, and answered
    for that publish alone; the setting stays out of the drift check, which `contracts.md`'s drift
    bullet then states (part 05 §4, §16).
13. **A first publish stops at `resources`** (`hq_plan_lacks_web_apps`) when HQ's create made the
    app with Web Apps off for an app that declares Web Apps, keeping the mapping and withdrawing the
    `web-apps` confirmation in the same fold (part 05 §5).
14. **`app_deployments.target_web_apps_enabled` is dropped**: from step 4 it repeats the
    declaration. The setup artifact reads the declaration (part 05 §6, §7).
15. **No `.ccz` for an app that does not declare Android** (`not-declared-for-android`), and the
    corpus writes no local archive for such a document (part 05 §8, part 08 §3.3).
16. **Defect 20 is the `form-entry-sync-off` confirmation**, for an app that declares Android and
    holds a form working on a case in a module with Search; its 15 register entries move to the
    fixed register (part 05 §10, part 08 §2.3).
17. **CommTrack's confirmation moves to step 5**: no Nova document reaches either CommTrack trigger
    before advanced modules (part 05 §11).
18. **Preview defaults to Web Apps** where both are declared, which changes the fewest behaviors
    an author relies on and simulates no hardware; Android plays its home screen, pages a form
    without sections one labeled group or question per screen, and plays the device's capture
    (part 06 §2, §6, §12).
19. **`window_width` is admitted only in slots CommCare evaluates while a menu or a list loads**
    (every module slot and a form's display condition), and refused in every slot a form
    evaluates (field, Connect, case-operation, form-link and lookup-filter slots) on every
    declaration. This is outcome A of one native Core run of two arms that model Formplayer's form
    cache; under outcome B the read is admitted wherever a context field is, with its difference
    stated (part 03 §6.2, §6.4).
20. **The case list's search text is a value arm** `{ kind: "case-list-search-text" }`, not a
    `DatumRef` kind, admitted where the entry has one case list and printed `if(count(P) > 0, P[1],
    '')` (part 03 §5).
21. **`fingerprintquery` moves to step 7, group 4**, with case-list callouts, its only supplier
    (part 03 §5.2).
22. **A repeat-crossing form read inside a row predicate prints `current()/…`** in every target,
    since Core gives it the form's context or the row's depending on its predicates; no stored
    change (part 03 §7).
23. **Search fields are read in a search-first module's forms, list and detail.** A child module
    of a search-first parent and an ordinary search's results detail stay refused, for step 7
    (part 03 §4).
24. **The lane refuses an emitted HELD-NEW item**, and pull request 1 corrects the 36 keys the
    extraction and the meta block's read found, with three readings read wrong at the pins (part
    02 §2, §3).
25. **A served reader reads an app only on a platform it declares.** Formplayer reads every app and
    models the client's placeholder only where Web Apps is declared; a control reads as both (part
    08 §1).
26. **The SA and MCP schemas stay static.** A per-declaration schema would move the architect's
    toolset digest mid-build and MCP serves one schema a tool; the model learns the declaration from
    the overview, the guide's generated sentences, refusals and the pre-checks (`updateApp`'s, of
    content and media, when a change adds a platform; `addFields`' and `editField`'s, of the date
    and time kind), and changes it with `updateApp.runs_only_on` (part 07 §3).
27. **The census counts Connect**: 324 / 37 / 30 / 1 where the planning scan first left Connect to
    emission, and 398 documents at the exit (part 08 §3.1).
28. **List-first search in an app that declares Web Apps is sent knowingly, and stays step 5's.**
    From pull request 5 every app that declares Web Apps, the default, sends `cloudcare_enabled:
    true`, so a list-first searching module is HQ's REFUSED `list-first-with-web-apps` class,
    which a Case List save rewrites to search first (defect 21). HQ already stores `true` for every
    app it created under the `cloudcare` privilege, so the harm predates step 4; step 4 makes it hold
    wherever Web Apps is declared, and closing it needs the search workflow setting step 5 builds.
    Step 4 registers its two `manifest` entries and leaves the fix to step 5 rather than writing
    `false` for an app that declares Web Apps, which would take the app out of Web Apps (part 08
    §2.5, part 02 §5).
29. **The departures each part records and accepted**: part 02 §3.2 (the no-matches form's label
    takes no widen); part 03, "Departures" (the search text's `P[1]`, `window_width` refused in
    every form slot, two context documents, a Search field read refused in a form link, split
    identities with an attempt number, App Tests reading the search text blank); part 05,
    "Departures" (no question over an empty shell, the import file's Web Apps step); part 07
    decision 4 (one server-side preflight for content and media); part 08, "Departures" (no
    per-state Web Apps record for an app without Web Apps, the intent clause in pull request 5,
    no local archive without Android); part 09, "Departures" (the `next-publish-asks-more`
    extension, two bucket grants where a row needs bytes, the Connect notice line, no orphan-key scan, the drift writer run
    in the window).

The plan's own pull request writes into the later outlines what moves there: CommTrack into
`5-case-writes-forms-navigation.md` (part 05 §11); the split's read-back, the guarded reads and the
`current()` read into `6-import.md` (part 03, "Notes for later steps"); group 3's child modules and
group 4's `fingerprintquery` and results-detail read into `7-rest-of-model.md`.

## Work items

| Item | What it settles | Part |
|---|---|---|
| A. The declaration and the table | The key, the mutation, the features, both channels, the binding and parity tests, Connect | 01 |
| B. The manifest | The HELD-NEW check, the 36 keys' corrections, the readings, every later entry edit | 02 |
| C. The date-and-time question | Defect 18, finding 74's authoring half, the split and its planner | 03 |
| D. Expression reads | `here()`, Search fields, the search text, the context fields and the gate, `current()` | 03 |
| E. Media by platform | Defect 11's second half, the registry, the readers, acceptance per reference | 04 |
| F. Publish | `cloudcare_enabled`, the Web Apps question and stop, the `.ccz` rule, defect 20 | 05 |
| G. Preview | Defect 19 played: one platform at a time, the rule table, the cell table | 06 |
| H. Authoring | The builder, the SA and MCP, the nova-plugin sweep | 07 |
| I. Proof | Reader policy, registers, walk stops, corpus, targeted documents, reader runs | 08 |
| J. The cutover and notice | The transform, the backfill, the ledger, the notice, the runbook | 09 |

## Proof

Part 08 holds this in full.

- **Finding 74's two stops leave their documents** in pull request 4: `targeted-datetime-ordering`
  declares Android only and keeps finding 56's operands, so Formplayer's walk answers its questions
  and its stop moves to its control; `fuzz-xform-20260930-0` is declared Android only by the fuzz
  mapping and its entry is removed. `proof/walk-stops.json` goes from 26 to 25.
- **Defect 20's 15 entries move to `proof/fixed-defects.json`** in pull request 6, each still
  showing on its control: configuration sensitivity holds a control's fixed entries before the
  gate's effects (`sensitivity.flip_entries`), and a verdict states the sync requirement
  (`minimumConfiguration.syncCasesOnFormEntry`, absent for none). `OPEN_DEFECTS` drops 20.
- **Defect 21 stays step 5's**: two `manifest` entries in pull request 5 (the REFUSED
  `list-first-with-web-apps` class `cloudcare_enabled: true` makes HQ's own) on a control retained
  after it, and its `requests` entry re-homed onto `targeted-sync-on-form-entry-web-apps` where
  pull request 6's lane shows the class there (outcome A), or moved to `proof/fixed-defects.json`
  on its retained control `targeted-sync-on-form-entry` where it does not (outcome B: the class
  needs sync on with Android, which Nova's publish now refuses).
- **The reader policy moves no register entry**: no `android@` entry is on a document that
  declares Web Apps only, and no entry is on a document that declares Android only.
- **The HELD-NEW check lands with the flips that empty it** in pull request 1.
- **Six new targeted documents** (`targeted-datetime-split`, `targeted-platform-declaration`,
  `targeted-sync-on-form-entry-web-apps`, `targeted-preview-android-renders`,
  `targeted-session-context-reads`, `targeted-case-list-search-text`), none with a control, and two
  extended. The native families gain three Core classes and three `media` scenarios (four under
  the AVIF gate's refused outcome).
- **At the exit** `proof/known-defects.json` holds 273 entries (286, plus defect 21's two, less
  defect 20's 15) and `proof/fixed-defects.json` 749 under defect 21's outcome A, or 272 and 750
  under outcome B; `proof/walk-stops.json` 25 and `proof/controls/` 109 under either; the corpus
  holds 398 documents, 326 on both, 40 on Web Apps only, 32 on Android only.
- **Where the lane runs.** Every pull request passes the pull request lane in CI without the served
  readers, and the reader runs started by hand (part 08 §6.3) run before the merge. The first
  nightly after the merge is the whole lane with every reader over the merged stack, about 13.5
  hours, so the merge is made Monday to Friday; its issue lists every failing group with its rerun
  line.

## The stack

One `gh stack` chain on the latest `origin/main`, each pull request reviewed and undrafted, merged
together for one deploy. Part 10 gives each pull request's contents, files, register moves, lane
cost and checks.

| # | Pull request | Parts |
|---|---|---|
| 1 | Manifest audit: the HELD-NEW lane check and the flips of everything Nova already emits, with the meta entry's `drift` key; readings corrected where no code moves (`here()`, the case list menu item, the hidden sibling); `questions/hidden-value-bound-xsd-datetime`; the inventory sentence | 02 |
| 2 | Lane mechanics: reader policy by declaration (absent is both), Formplayer's walk modelling the client only for Web Apps, fixed entries held on controls, the verdict's sync requirement, `_needs_cloudcare` from the body, local-archive readers ready for absence, `proof/CLAUDE.md` rules | 08 |
| 3 | The split's groundwork: R2, R3, conversions, the media diff fix, Preview's time read, split identities, `lib/doc/datetimeSplit.ts`, `DatetimeSplitRuntimeTest`, `targeted-datetime-split` | 03, 08, 02 |
| 4 | The declaration and the platform table: model, mutation, table and detectors, both channels, the binding and parity tests, Connect, `searchWireShape`, `planContentDeclaration`, corpus declarations and the fuzz mapping, finding 74's stops, `targeted-platform-declaration` | 01, 02, 03, 08, 09 |
| 5 | Publish, Web Apps: `cloudcare_enabled`, the `web-apps` plan feature, the Web Apps question, the first-publish stop, the column drop, the setup artifact and import file, the `.ccz` refusal, the capture, the intent clause, defect 21's manifest entries | 05, 08, 02 |
| 6 | Publish, defect 20: the `form-entry-sync-off` confirmation, its migration, its 15 register moves, defect 21's `requests` entry re-homed or fixed by the lane's outcome | 05, 08 |
| 7 | Media by platform: registry, readers, the format column, acceptance at the kernel, attach, boundary and builder guard, Preview's stand-in, the SVG reader, H.264 High's Android reading from the planning decode run, the native scenarios, the browser spec | 04, 02, 08 |
| 8 | Preview, the model: rule table, session state and context, recalculation, form screens, the Android home, entry points, the case list menu item, search, tiles, `here()`, capture limits and their migration, App Tests (`RUNTIME_VERSION` 17) and `evaluate_form` platforms, `MODEL_CONTEXT_VERSION` `.8`, worker protocol 9 | 06 |
| 9 | Preview, the screens: the platform choice, the widgets and stand-ins, help, text rendering, logo, the home screen, the cell table and its completeness test, Playwright, `targeted-preview-android-renders` and its three Android slices | 06, 08 |
| 10 | Expression reads: the window width gate's run first; Search fields in search-first forms and lists, `case-list-search-text`, the context fields, the count guard, the `current()` print, their manifest flips, table rows and cell rows, targeted documents and native classes; `MODEL_CONTEXT_VERSION` `.10` | 03, 01, 02, 06, 08 |
| 11 | Builder: the platform section and its preflight, offering by declaration, the note row, moved copy, the split gesture, the Connect dialogs, the media pickers | 07, 04 |
| 12 | Agent: `updateApp.runs_only_on`, the guide and its generated sentences, prompts, the plan line and peer check, the overview, the pre-checks, the autonomous instruction; `MODEL_CONTEXT_VERSION` `.12`; the billed schema check asked once at this head | 07 |
| 13 | Cutover: scan, migrate, the validation migration, notices, Job, allowlist, bundle, runbook with its post-deploy drift step | 09, 04 |
| 14 | Contracts and public docs; the nova-plugin check; the maintenance image is built from this head | 10, 01, 03, 04, 05, 06, 07 |
| 15 | Removal of the cutover tooling and of this plan | 09, 10 |

**CI.** A stacked pull request never reads its base's records (`proof/ci/store-keys.mjs`), and a
push to one restacks every pull request above it. Pull request 1 runs the lane's 10.7-minute row;
pull request 2 changes observation code, so it and every pull request above it run the 12.7-minute
row. A push to pull request k starts 16 − k lane runs, and a push to pull request 1, or cutting the
stack, is 215 shard-jobs against about twenty concurrent runners: a push to pull request 2 holds the
whole account about eighty minutes, and over four hours while a scheduled lane with the readers
runs. So pull requests 2, 3, 4 and 5 are settled on their own branches before the stack is cut
(part 10, house rule 5): 2 changes the observation every later lane runs, 3 lands a stored
mutation shape and the split's derived identities, 4 moves about 72 documents' keys, and 5 moves
every document's key and retains a control from its own emission. A fix-up goes to the pull
request it belongs in, a session's pushes are batched into one, no restack is pushed while a
scheduled reader lane runs, and the reader runs by hand restack nothing (part 08 §6).

## The cutover

One direct maintenance cutover (`docs/architecture/contracts.md`), planned in full in part 09. It
is lean: no fold horizon, no frozen old-shape reader and no emission census, because every source
parses under step 4's schema and every target is made by production code. It reads Nova's database
and media bucket and no CommCare HQ state.

- **The window** is still needed: the previous image's strict `appSettingsSchema` refuses the key
  the cutover writes, and the column drop is not additive.
- **One Job of its own**, `commcare-nova-hq-round-trip-platforms`, because a backfill that reads bytes needs
  `NOVA_MEDIA_BUCKET`, and it stays its own where none does (part 09 §13); its stored arguments are the dry run, and `--execute --expect-plan-digest`
  refuses any other plan. One fleet transaction, one `blueprint-migration` batch per changed app
  through `lib/db/apps.ts::appendSyntheticBatchInTransaction` (actor
  `system:hq-round-trip-platforms`, batch id `hq-round-trip-platforms:<appId>`), every identity
  derived.
- **The transform, in four steps**: `declare-platforms` (`planContentDeclaration`, the one planner
  the fuzz mapping also uses: what the content other than media allows, splitting date-and-time
  questions only where that is the only way an app runs anywhere); `remove-unplayed-media`;
  `judge-target` (schema, absolute gate, export readiness, replayability, an unchanged case store,
  idempotence); `deployment-lines`.
- **The media backfill** gives every ready image, audio and video row its format. A row whose
  stored MIME has one variant whose check its upload already ran takes that variant without a byte
  read; every other row (WAV, Ogg, MP4, WebM) is classified from its stored bytes with the
  production classifier, keeping bytes no variant admits as `unplayable`, under a time-conditioned
  bucket read grant revoked and read back after each use: one advisory grant for the dry run before
  the window and one for the window, each made only where the `media` line's `needsBytes` counts a
  row. Production holds JPEG and PNG rows alone, so as it stands no byte is read and no grant is
  made; the Job stays its own either way (part 09 §7, §14).
- **The ledger**: five migrations of the stack apply inside the fleet transaction in two phases,
  four before the backfill (the column drop, the confirmation kind, the format column, the capture
  size) and the format check's validation after it, so the DDL commits or rolls back with the
  fleet.
- **A blocker** is any app whose content runs on neither platform for a reason other than
  date-and-time questions, a split the planner refuses, a reference with no media row, a target
  that fails a judgment, and the stored session context reads pull request 10 refuses (under
  outcome B of the window width gate, no `window_width` read in a form's slots among them); the
  dry run lists each, and the author resolves it before the window.
- **Case schema drift** is counted, not blocked: the dry run compares each app's head derivation
  with its stored `case_type_schemas` projection and reports every drift as a line. After the
  deploy and before ingress reopens, the existing drift writer (`schema-drift`) runs on the
  maintenance image, whose `lib` and `app` are the merged `main`'s but for
  `lib/db/designSessions.ts` (part 09 §14, check 1), through the Job
  `commcare-nova-case-type-schema-retirement`, the route `lib/case-store/CLAUDE.md` gives it, and
  the runbook expects exactly the counted drift and rescans to zero (part 09 §14, step 10).
- **A notice on every affected app**, cutover `hq-round-trip-platforms`, with three document
  reasons (`platforms-declared`, `datetime-question-split`, `media-not-played-removed`) and one per
  deployment (`next-publish-asks-web-apps`), beside `next-publish-asks-more` and
  `deep-links-need-republish`.
- **Private work is left alone**: staged steps parse, and a stale base meets the existing refusal.
  There is no announcement: Nova is dogfooded by its author, and the runbook has no announcement
  step. The window takes about two hours thirty minutes, ten of them the drift writer and its two
  scans, plus twice the advisory dry run (part 09 §14).
- **Pull request 15** removes the tooling, the runbook and this plan; the five migrations,
  `lib/doc/platformDeclaration.ts`, the notice's copy and each app's `blueprint-migration` row stay.

## Contracts

Part 10 gives each sentence as it reads today and its replacement. In brief:

- `docs/architecture/contracts.md`: under "Nova is not CommCare HQ.", "Nova emits one wire
  flavor: the maximal subset Web Apps supports, faithfully." becomes emission for the platforms
  the app declares, each difference a row of one table held to the manifest; the drift bullet
  gains the Web App setting's own question (part 05 §16); "Deliberate target gaps" gains a bullet
  that SVG images never ship (part 04 §11).
- The root `CLAUDE.md`: the map rows for `lib/domain` (where an app runs), `lib/media` (a
  reference accepted only where every declared platform plays it) and `lib/deployment` (the
  declaration written as the Web App setting), and mental model 5 (Preview plays one declared
  platform at a time).
- `docs/architecture/complex-apps.md`: a new "Where an app runs" subsection, and "Media" gains the
  variant on the row and acceptance per reference (part 04 §11).
- `lib/commcare/CLAUDE.md`: `cloudcare_enabled` becomes app content Nova writes; the platform
  table stands for the manifest's per-platform readings; the inventory is kept in step; a use only
  HELD-NEW entries name is a difference. `lib/media/CLAUDE.md`: acceptance by declared platform.
  `lib/deployment/CLAUDE.md`: the Web Apps question, the first-publish stop, four confirmation
  kinds. `lib/domain/CLAUDE.md`, `lib/domain/expression/CLAUDE.md`, `lib/doc/CLAUDE.md`,
  `lib/commcare/xpath/wire/CLAUDE.md`, `lib/preview/CLAUDE.md`, `lib/session/CLAUDE.md`,
  `lib/preview/app-tests/CLAUDE.md`, `lib/db/CLAUDE.md`, `lib/export/CLAUDE.md`,
  `components/builder/CLAUDE.md`, `lib/codemirror/CLAUDE.md`, `lib/agent/CLAUDE.md`,
  `lib/agent/authoring/CLAUDE.md`, `proof/CLAUDE.md` and `proof/README.md`: each sentence is
  rewritten in the pull request whose behavior makes it false.
- The public docs, in Nova's voice, in pull request 14 with two recorded exceptions (the Preview
  heading the cell table reads, in pull request 9, and the notice's two passages, in pull request
  13): a new page, "Where workers use your app" (`where-workers-use-your-app.mdx`), and
  `publishing.mdx`, `attachments.mdx`, `building-with-nova.mdx` (Preview, `here()`, media, the
  split), `case-workspace.mdx`, `form-sections.mdx`, `form-links.mdx`, `deep-links.mdx`,
  `commcare-connect.mdx`, `users-and-personas.mdx`, `project-space-compatibility.mdx` and
  `mcp/tools.mdx`.
- `harness-findings.md`: finding 74 closed, finding 64's derivation follows the declaration.
- `../nova-plugin` (read for this plan at `14af38e`): `skills/upload_to_hq/SKILL.md` holds the
  sentences pull requests 5 and 6 make false; its pull request bumps `plugin.json` to 2.3.0 and
  merges after the deploy is live, and pull request 14 records its link (part 07 §4).

## Exit

- Every app declares where it runs, and no app holds a feature or a media reference a platform it
  declares cannot run: the commit gate, the kernel's media admission and the export boundary refuse
  one on every editor.
- Every HELD manifest entry that differs by platform is a platform feature's or ambient, held by
  the binding test, and no Nova export uses an item only HELD-NEW entries name.
- Every platform cell that differs has its row in Preview's cell table, with evidence that Preview
  plays it, refuses it, states it, or leaves it outside Preview, and the completeness test passes.
- Publish writes the declaration as `cloudcare_enabled`, asks the `web-apps` plan feature and the
  `form-entry-sync-off` confirmation where they apply, and offers no `.ccz` without Android.
- The register holds no entry of defect 20, and every fixed entry shows on its control; every walk
  reaches its end or one of the 25 stops `proof/walk-stops.json` holds by name, and finding 74's is
  held on its control alone.
- Proofs 1 to 5 pass on every Nova export, and every control directory is named by a register.
- Every existing app is valid under the new schema and validator, carries its declaration and its
  notice, and every ready media row records its format; the post-deploy drift writer converged
  exactly the case schema drift the dry run counted, and the drift scan then reports none.
- The first nightly over `main` after the deploy, the whole lane with every reader over the merged
  stack, holds.
