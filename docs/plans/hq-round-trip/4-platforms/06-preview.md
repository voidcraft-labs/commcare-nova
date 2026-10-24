# Step 4, part 06: Preview per platform

Part of [step 4's plan](../4-platforms.md), which holds the baseline, the decisions, the stack and
the exit. Part 01 fixes the declaration (`appSettings.runsOnlyOn`), the domain vocabulary
`lib/domain/platforms.ts` (`Platform`, `PLATFORMS`, `declaredPlatforms`, `PLATFORM_LABELS`,
`inPlatform`, `platformDeclarationPhrase`, `PLATFORM_FEATURES`) and both validator channels (pull
request 4); a line below that names a platform chosen at run time as a place is built from
`inPlatform`, and one that names a declaration from `platformDeclarationPhrase` (part 01 §2.1);
part 04 fixes media acceptance by
declaration (pull request 7); part 03 admits the expression reads (the `case-list-search-text` value
arm, the session context fields, the count guard; pull request 10); part 07 renders the platform
table's notes in the builder (pull request 11). This part fixes what Preview plays on each declared platform: which platform it plays, where
the choice lives and how it renders, the one rule table every Preview surface reads, what each
differing behavior does on each platform, the session values each platform supplies, App Tests and
`evaluate_form` per platform, and the cell table that holds Preview to the manifest's readings, with
the tests at each boundary. It lands in pull requests 8 (the model) and 9 (the screens).

Citations are `path::symbol`. Nova is read at `main` `e9e6cd93`. CommCare is read at the pins
`proof/pins.json` names: commcare-hq `d6c6e16d8ae1` (HQ's Web Apps client under
`corehq/apps/cloudcare/static/cloudcare/js/`, its templates under
`corehq/apps/cloudcare/templates/cloudcare/partials/`), formplayer `24383ac71bfb` (under
`src/main/java/org/commcare/formplayer/`), commcare-core `8e9ba8d908e9` (under `src/main/java/`
unless named), commcare-android `7a5584475580` (under `app/src/org/commcare/`, strings in
`app/assets/locales/android_translatable_strings.txt` and `app/res/values/strings.xml`). Every
CommCare fact below was read at the pin. Three renderings cannot be read from source; §24 plans each
as a lane observation with both outcomes, and nothing that depends on one ships before it runs.

## Decisions in brief

1. **Preview plays one platform at a time, and it is always a declared one.**
   `lib/preview/platform.ts::effectivePreviewPlatform(declared, chosen)` returns the chosen platform
   when the app declares it, else Web Apps when the app declares Web Apps, else Android. Preview,
   App Tests and `evaluate_form` all call it, so the three never disagree.
2. **Web Apps is the default for an app that runs on both.** It changes the fewest behaviors an
   author already relies on (about 8 of the 27 per-behavior choices `lib/preview` makes today, against
   about 20 for Android), needs no simulated hardware, and keeps the Search and tile behavior the
   builder already explains as the browser app's. Android is one click away (decision 4).
3. **The choice is session state, never stored and never in the URL.** `lib/session/store.ts` gains
   `previewPlatform` (the explicit choice), `previewAtDeviceHome`, `previewDeviceSyncedAt` and
   `previewAndroidDeviceId`; the effective platform is derived (`usePreviewPlatform()`). Changing it
   clears navigation, keeps claims, and returns to app entry.
4. **The choice renders as a "Runs on" group inside `PreviewIdentityMenu`**, whose trigger icon
   becomes the platform's glyph. A fourth header control does not fit the 320px band.
5. **One rule table.** `previewPlatformRules(platform)` returns a frozen `PreviewPlatformRules`; every
   Preview surface reads its one field and no other Preview code compares a platform string.
6. **Android has its home screen.** Start and Sync with server work; Saved and Incomplete show per
   the app's settings and Log out of CommCare always shows, each disabled with its reason.
7. **Android pages a form as the phone does**: a sectioned form one section per screen (today), and a
   form without sections one screen per labeled group (a field-list, as Nova emits it) and per
   question outside one, with the repeat add prompt and the Finish button. Web Apps shows every form
   on one screen, sections as titled groups.
8. **Web Apps recalculates as Formplayer does**: every calculate and condition in dependency order
   after each answer, repeat change and before submit, never defaults or start-of-form setvalues.
9. **Help plays each runtime's button and dialog in the running app**; edit mode keeps it inline.
   Validation messages are plain text on both platforms; hints are markdown on Web Apps and plain on
   Android.
10. **Android plays the device's capture**: Take picture and Choose image, an in-page sound recorder,
    Record video and Choose video, the GPS dialog, the barcode scanner; and its limits, 15 MiB less
    1 KiB a file with a warning from 3,001 whole KiB. Web Apps keeps today's 4 MB and extension lists. The
    upload route applies the platform's limits, and a migration widens the attachment size check;
    the cutover window applies it with the stack's other ledgered migrations (part 09 §8).
11. **Entry points play each platform**: Web Apps claims the case and keeps display conditions unless
    the entry point ignores them; Android claims nothing, ignores display conditions and opens a case
    the phone lacks with blank preloads. Android's outcome at submit for such a case is a lane
    observation (§24.3) before its copy lands.
12. **Session context per platform**: `deviceid` `Formplayer` or `commcare_<uuid>`, `appversion`
    `Formplayer Version: 2.64` or Android's template, `drift` `0`, `window_width` on Web Apps only and
    only outside form logic under the gate's expected outcome (§18.3), `applanguage` the worker language's wire code. The device is an engine
    input beside the identity, never part of it, and the server binds the same values.
13. **App Tests run each session on one platform** (`platform` per session and at the top level);
    an Android session starts at the device home, where `continue` is Start. `RUNTIME_VERSION`
    16 to 17.
14. **`evaluate_form` takes `platform`**, defaulting by decision 1.
15. **The cell table** `lib/preview/__tests__/platformCells.ts` holds one row for every
    `(entry, platform)` cell of every HELD entry whose reading is neither `runs` nor `not-applicable`,
    each with one evidence kind: `model`, `browser`, `refused`, `stated` or `outside-preview`. Its
    completeness test fails on a missing or stale row.
16. **Three renderings wait for a lane observation**: Markwon's newline, HTML and image handling,
    Android's tile top and bottom alignment, and the outcome of submitting a form opened for a case
    the phone lacks. Until each runs, its rule holds the value written as "until" in §5 and its copy
    does not land; §24 gives both outcomes. The runs are pull request 9's slices, so pull request 8
    lands no copy that depends on one: the not-processed path, its toast and its two runtime messages
    land in pull request 9 only under §24.3's outcome A (§8.3).
17. **`MODEL_CONTEXT_VERSION` becomes `"v5-hq-round-trip-platforms.8"`** in pull request 8, which
    changes the `startAppTest` and `evaluateForm` schemas and descriptions; `startAppTest` is
    registered in `scripts/test-schema.ts` there. The billed run is asked once at pull request 12's
    head (the plan, "The stack").

---

## 1. What Preview plays today

Preview plays no platform. It chooses per behavior, and sometimes plays neither runtime:

- **Web Apps**: every case list, tile, search screen, claim, attachment, markdown hint, the logo, an
  entry point's display-condition rule, `app_home` and `firstMenu` landing on the module list, the
  post-submit row (`lib/preview/caseTileLayout.ts`, `caseListPhase.ts`, `engine/searchInputConstraints.ts`,
  `entryPointLaunch.ts::FORM_OFF_THE_MENU_ENTRY_POINT_REFUSAL`,
  `components/preview/screens/FormScreen.tsx` `dispatchPostSubmit`).
- **Android**: section paging (`components/preview/form/sections/useSectionPaging.ts`, "the running
  form's pager, on Android's rules"), dependency-driven recalculation
  (`lib/preview/engine/formEngine.ts::setValue` → `TriggerDag.getAffectedWork`), the device zone for
  day numbers (`lib/preview/xpath/coreDays.ts::coreDaysSinceEpoch`), after-submit opening a hidden
  target (`lib/preview/afterSubmitRouting.ts::afterSubmitRoute`), `here()`'s refresh rule
  (`lib/preview/engine/viewerLocation.ts`).
- **Neither**: the barcode question has no answer control
  (`components/preview/form/FieldRenderer.tsx` routes `barcode` to `fields/MediaField.tsx`, "(not
  available in preview)"); `deviceid` is `nova-preview` and `appversion` `preview`
  (`lib/preview/engine/identity.ts::projections`, `ANONYMOUS_SESSION_VALUES`); help shows inline
  with help media even without help text (`components/preview/form/FieldHelp.tsx`); validation
  messages render as markdown (`components/preview/form/fields/ValidationError.tsx`); a module with
  no case-loading form shows an informational case list (`components/preview/screens/CaseListScreen.tsx`);
  an entry point refuses a case the worker's restore lacks (`entryPointLaunch.ts::prepareEntryPointLaunch`).

`lib/preview/CLAUDE.md` says so ("Preview plays one runtime per behavior until it plays each
platform"). From step 4 each of these follows the platform Preview plays.

## 2. Which platform Preview plays

### 2.1 The effective platform

`lib/preview/platform.ts` (new, client-safe, imported by the browser, the App Test runtime and the
authoring evaluator):

```ts
export function effectivePreviewPlatform(
	declared: readonly Platform[],
	chosen: Platform | undefined,
): Platform {
	if (chosen !== undefined && declared.includes(chosen)) return chosen;
	return declared.includes("web-apps") ? "web-apps" : "android";
}
```

`declared` is always `declaredPlatforms(doc)` (part 01 §2.1), which is never empty. A chosen platform the
app no longer declares (the author narrowed the app while previewing) derives away with no store
write: the next render reads the other platform.

### 2.2 Why Web Apps is the default

| | Web Apps by default | Android by default |
|---|---|---|
| Today's per-behavior choices that change for an existing app running on both | about 8: sections stop paging, recalculation runs every request, an after-submit hidden target lands as Web Apps does, help moves behind a button, choice media hides, the location question loses "use my location", the barcode question gains a text box, Web Apps' session values | about 20: every search screen loses its title, description and hints, Search field checks stop, hidden Search fields appear, zero results become a notice on the search screen, tiles flatten and lose borders and alignment, the logo goes, a home screen precedes every entry, forms without sections page one labeled group or question per screen, help, hints, group labels, repeats, location, image, audio and video all change |
| Simulated hardware | none: Web Apps is a browser app, so each Web Apps control is a browser control | camera, recorder, GPS dialog, scanner, home screen |
| Authored surfaces kept visible | the Search settings and tiles the case-list workspace explains as the browser app's (`components/builder/CLAUDE.md`, "Checked in the browser app. On a phone the search runs either way") | those surfaces render as if unauthored |

An app that runs on one platform previews on it: after the cutover that is every app holding a
date-and-time question or a `here()` column (Android only) and every app using search first or
several-case selection (Web Apps only). Android was weighed as the default (phones are CommCare's
primary runtime, and Preview already pages sections the phone's way); it loses on every row above.
Flattened sections are the one visible loss, and they are what Web Apps shows.

---

## 3. Session state

### 3.1 Fields, actions and hooks

`lib/session/store.ts` (`BuilderSessionState`, Interaction block):

| Field | Type | Meaning |
|---|---|---|
| `previewPlatform` | `Platform \| undefined` | The platform the author chose in the identity menu; `undefined` is "the default". |
| `previewAtDeviceHome` | `boolean` | Preview on Android is showing the device home screen (§6). A running fact, not a route: `Location` is shared with edit mode and gains no Preview-only kind. |
| `previewDeviceSyncedAt` | `number \| undefined` | Epoch milliseconds of this Preview run's last sync on Android: set when Preview starts on Android and by Sync with server (§6.2). |
| `previewAndroidDeviceId` | `string` | A UUID v4 minted with `crypto.randomUUID()` when the store is created; the Android `deviceid` is `commcare_` and this (§18). One page load is one install. |

Actions: `setPreviewPlatform(platform: Platform)`, `setPreviewAtDeviceHome(atHome: boolean)`,
`markPreviewDeviceSynced(at: number)`. `setPreviewing(on: boolean)` becomes `setPreviewing(on: boolean,
at?: { readonly atHome: boolean })`, because the session store does not know the location (the URL
owns it, `lib/session/CLAUDE.md`): `components/builder/usePreviewModeTransition.ts` passes `{ atHome:
(change?.location ?? loc).kind === "home" }`, the location Preview opens on after its own
`previewModeNavigation`, to the setter it wraps, whose type gains the same `at`. The setters it wraps
forward it: `useSetPreviewing()`'s store action (`PreviewIdentityMenu.tsx`, `PreviewSetupNotice.tsx`)
takes it as is, and `components/builder/BuilderLayout.tsx::handleSetPreviewing`, the setter
`BuilderHeader`'s `onSetPreviewing` carries to `PreviewToggle` and `useBuilderShortcuts`, passes it to
the store. An absent `at` reads `atHome: false`, which is the one caller outside the transition's
case (`components/preview/PreviewShell.tsx` turns Preview on for a case-record deep link). The store reads
the effective platform where §3.2 needs it as `effectivePreviewPlatform(declaredPlatforms(doc),
previewPlatform)` over the document it already reaches through `docStoreRef` (`lib/session/store.ts`),
in `setPreviewing`, `setPreviewPersonaUuid` and `installEntryPointLaunch` alike.
`installEntryPointLaunch(launch, claimCaseIds)` gains the launch's claims (§8.1) and, in its one
`set`, writes them under the launch's worker (`addClaims(base, appId,
previewClaimsWorker(launch.personaUuid), claimCaseIds)`, `base` being today's claims when the worker is
unchanged and none when the launch changes worker), so a Web Apps launch as another worker keeps its
claim. Hooks in `lib/session/hooks.tsx`:
`usePreviewPlatform(): Platform` (returns `effectivePreviewPlatform(declaredPlatforms(doc),
previewPlatform)`, reading the document through the doc hooks), `usePreviewPlatformRules():
PreviewPlatformRules`, `usePreviewAtDeviceHome()`, `useSetPreviewPlatform()`,
`useSetPreviewAtDeviceHome()`, `usePreviewDeviceSyncedAt()`, `usePreviewDevice(): PreviewDevice`
(§18.1). Nothing stores the effective platform (`lib/session/CLAUDE.md`, "Don't add a field to the
store for anything derivable").

### 3.2 Lifetimes

| Event | `previewPlatform` | `previewAtDeviceHome` | `previewDeviceSyncedAt` | `previewAndroidDeviceId` |
|---|---|---|---|---|
| `setPreviewing(true, at)` | kept | `true` when the effective platform is Android and `at.atHome`, else `false` | now, when the effective platform is Android | kept |
| `setPreviewing(false)` | kept (a flip back in keeps the runtime the author is checking) | `false` | `undefined` | kept |
| `setPreviewPersonaUuid` (a change of worker) | kept | `true` on Android (the identity menu also navigates home) | now, on Android | kept |
| `installEntryPointLaunch` | kept | `false` | now, on Android | kept |
| confirmed Project change (`applyAccessSnapshot`, `confirmedProjectChanged`) | `undefined` | `false` | `undefined` | kept |
| `reset()` | `undefined` | `false` | `undefined` | kept (a fact of the page load, like `buildUnfinished`'s reasoning in `reset`) |

### 3.3 Changing the platform

`setPreviewPlatform(platform)` is one `set`, the same shape as `setPreviewPersonaUuid`: it writes
`previewPlatform`, clears `previewCaseTarget`, `previewTaskContinuation`, `previewEntryPointLaunch`,
`previewSelectedCase`, `previewMenuCaseSelections`, `previewParentCaseRequest` and
`previewSearchStates`, keeps `previewClaims` (a claim on HQ outlives the task), sets
`previewAtDeviceHome` to `platform === "android"` and `previewDeviceSyncedAt` to now on Android or
`undefined` on Web Apps. The identity menu then calls `navigate.replace({ kind: "home" })`, as it does
for a persona change ("A prior worker's open form is not the new worker's entry"). An open entry is
not carried across: restoring a Web Apps entry under Android's paging, session values and
recalculation would show a state no worker can reach.

---

## 4. The identity menu

`components/builder/PreviewIdentityMenu.tsx` changes. It still renders only while previewing.

**Trigger.** The leading icon is the platform's glyph instead of `tabler/user-circle`:
`@iconify-icons/tabler/browser` for Web Apps, `@iconify-icons/tabler/device-mobile` for Android
(through `@iconify/react/offline`, 17px, as today). The label stays the worker
(`currentLabel`), so the trigger's width is unchanged. `aria-label`:
`` `Running as ${currentLabel} ${inPlatform(platform)}. Change who Preview runs as or where.` ``
(`Running as Asha in Web Apps. Change who Preview runs as or where.`).

**Content**, top to bottom:

1. `DropdownMenuGroup` with `DropdownMenuLabel` **Runs on** (the `LanguageSelector` pattern: a
   `GroupLabel` inside a group), then a `DropdownMenuRadioGroup` whose value is the effective
   platform, with two `DropdownMenuRadioItem`s (`closeOnClick`), each a two-line item like the
   persona items:
   - **Web Apps**, second line `The browser app on CommCare HQ`
   - **Android**, second line `The CommCare app on a phone or tablet`

   An item for a platform the app does not declare is `disabled` and its second line is the reason
   instead, `` `This app runs ${platformDeclarationPhrase(declared)}` ``: `This app runs only on
   Android` (on the Web Apps item) or `This app runs only in Web Apps` (on the Android item). It is
   shown, never hidden. Choosing the other platform calls
   `setPreviewPlatform` and `navigate.replace({ kind: "home" })`; choosing the current one does
   nothing.
2. `DropdownMenuSeparator`, then a `DropdownMenuGroup` with `DropdownMenuLabel` **Running as** over
   today's persona radio group, Test journeys and Add a persona, unchanged.

**320px.** The header band at 320px holds the mark (44), the Preview toggle (44), the language
control (44, icon only under 640px, `max-sm:w-11`), the identity trigger (at most 112,
`max-sm:max-w-28`) and the account control (44), with `px-2` and its gaps. A fourth 44px control
would need about 364px and push the center cluster to its own row on every phone. The platform
choice adds nothing to the band. `components/builder/CLAUDE.md`'s 320px paragraph gains: "The
platform choice is a group in the identity menu, so the band still fits at 320px."

---

## 5. The rule table

### 5.1 The module

`lib/preview/platform.ts` exports `type PreviewPlatformRules`, `previewPlatformRules(platform:
Platform): PreviewPlatformRules` (returns `PREVIEW_PLATFORM_RULES[platform]`), the constants of §18,
`effectivePreviewPlatform` and `platformUnavailableSentence`. The table is one constant,
`PREVIEW_PLATFORM_RULES = { "web-apps": {…}, android: {…} } as const satisfies
Readonly<Record<Platform, PreviewPlatformRules>>`, whose two members are `Object.freeze`d, so a field
missing on either platform fails `tsc`.
No other module in `lib/preview`, `components/preview`, `lib/preview/app-tests` or
`lib/agent/authoring/evaluationContext.ts` compares a `Platform` value; each reads a field or calls one
of two helpers that hold the per-platform choice:
- `platform.ts::platformUnavailableSentence(platform: Platform, subject: "a session" | "the form"):
  string`, the refusal for a platform the app does not declare, naming the platform it does run on:
  `` `This app runs ${platformDeclarationPhrase([other])}, so ${subject} can't run
  ${inPlatform(platform)}. Leave platform out to use ${PLATFORM_LABELS[other]}.` ``, `other` the
  platform that is not `platform` (`This app runs only on Android, so a session can't run in Web
  Apps. Leave platform out to use Android.` and its mirror, §21.2 and §22);
- `lib/preview/engine/previewDevice.ts::serverPreviewDevice(input: { platform: Platform; appLanguage:
  string; androidDeviceId?: string }): PreviewDevice`, the device of a journey or a check with no
  browser window: the given `androidDeviceId` (a fresh one when absent) and, on Web Apps only, `windowWidth: APP_TEST_WINDOW_WIDTH` (1280, exported from
  the same file), used by `lib/preview/app-tests/context.ts` and
  `lib/agent/authoring/evaluationContext.ts`.
`lib/preview/__tests__/platformRuleReaders.test.ts` holds that: it reads every `.ts` and `.tsx` file
under those paths through the TypeScript compiler API (`ts.createSourceFile`, never a regular
expression) and fails on a string literal `"web-apps"` or `"android"` outside `lib/preview/platform.ts`,
`lib/preview/engine/previewDevice.ts` (whose input parse, `serverPreviewDevice` and
`withNavigationWidth` are per platform) and `lib/preview/__tests__/`,
naming the file and line.

The two comments that say "until Preview plays each platform" (the `FormScreen.tsx` comment on
`app_home` / `firstMenu`; the comment on the `post-submit` switch in
`lib/preview/app-tests/submission.ts`) are rewritten to read `rules.postSubmitAppHome` (§7), and the
constant `entryPointLaunch.ts::FORM_OFF_THE_MENU_ENTRY_POINT_REFUSAL`, whose text names both
platforms today, is rewritten for the one platform that reaches it (§8.1).

### 5.2 The fields

"Until" marks a value held until its lane observation (§24) decides it.

| Field | Type | `web-apps` | `android` | Source |
|---|---|---|---|---|
| `appHome` | `"root-menu" \| "device-home"` | `"root-menu"` | `"device-home"` | Web Apps has no home inside an app (`formplayer/app.js` `apps:currentApp` → `selectApp`); Android `activities/HomeButtons.java::buildButtonData`, `StandardHomeActivity::enterRootModule` |
| `postSubmitAppHome` | `"root-menu" \| "device-home"` | `"root-menu"` | `"device-home"` | Formplayer `application/FormSubmissionHelper.java::doEndOfFormNav` → `CommCareSession.java::finishExecuteAndPop` false → client `apps:currentApp`; Android `HomeScreenBaseActivity.java` form result → `AndroidSessionWrapper::terminateSession` false → `reset()` |
| `afterSubmitHiddenTarget` | `"landing" \| "opens"` | `"landing"` | `"opens"` | Formplayer `services/MenuSessionFactory.java::rebuildSessionFromFrame` walks the frame through the menus it would show; Core reads the frame's commands as they stand (`proof/targeted/documents/formLinkHiddenTarget.ts`); Nova's statement `components/builder/form-links/afterSubmitCopy.ts::hiddenTargetLine` |
| `entryPointDisplayConditions` | `"kept-unless-ignored" \| "ignored"` | `"kept-unless-ignored"` | `"ignored"` | Formplayer `MenuSessionRunnerService` alone reads `respect-relevancy`; commcare-android holds no reader of `Endpoint.isRespectRelevancy` (`proof/targeted/documents/hiddenFromMenu.ts`, `proof/android/test_navigation.py::test_a_form_off_the_menu_opens_from_a_link_and_from_an_entry_point`) |
| `entryPointClaims` | `"posted" \| "none"` | `"posted"` | `"none"` | HQ `app_manager/suite_xml/post_process/endpoints.py::EndpointsHelper._add_claim_frame`; Nova `lib/commcare/entryPointSuite.ts::buildEntryPointSuite`; Core `session/CommCareSession.java::syncState` keeps only the last command, so Android never reaches the claim's `<post>` |
| `entryPointCaseNotHeld` | `"claimed" \| "opens-blank"` | `"claimed"` | `"opens-blank"` | Web Apps' claim frame; Core `CommCareSession.java::getFirstMissingDatum` checks only the key, `SessionNavigator.java::readyToProceed`; `fragments/BreadcrumbBarHelper.java::buildContextTile` returns no tile |
| `entryPointUnheldCaseSubmit` | `"submits" \| "not-processed"` | `"submits"` | until §24.3: `"not-processed"` | Core `xml/CaseXmlParser.java::loadCase` (`errorIfMissing` for update and close); `sync/FormSubmissionHelper.java::handleExceptionFromFormProcessing` |
| `formlessCaseListSelection` | `"back-to-root-menu" \| "device-home"` | `"back-to-root-menu"` | `"device-home"` | Formplayer `services/MenuSessionRunnerService.java::advanceSessionWithSelections` → `resolveFormGetNext` null → `NotificationMessage("Redirecting after sync")`, `clearSession`; client `formplayer/menus/controller.js::selectMenu` → `apps:currentApp`. Android `HomeScreenBaseActivity.java::handleNoFormFromSessionNav` → `terminateSession` false → `refreshUI` |
| `claimThenSync` | `boolean` | `false` | `true` | manifest `case-search/the-generated-search-round-trip-remote-request-query-results` (Android: every claim is followed by a sync) |
| `tileGrouping` | `"grouped" \| "flat"` | `"grouped"` | `"flat"` | commcare-android holds no reader of `Detail.getGroup`, `DetailGroup` or `header-rows` |
| `tileBorderShading` | `boolean` | `true` | `false` | no reader of `Style.getShowBorder` or `getShowShading` in commcare-android |
| `tileVerticalAlign` | `"as-authored" \| "middle-only"` | `"as-authored"` | `"middle-only"` | `views/EntityViewTile.java::computeGravity` matches `center`, `top`, `bottom`; Nova writes `start`, `center`, `end` (`lib/commcare/suite/case-list/tileStyle.ts::TILE_VERTICAL_ALIGN_WIRE`). What `top` and `bottom` draw is §24.2 |
| `linkColumnInList` | `"link" \| "raw-text"` | `"link"` | `"raw-text"` | Android's markdown arm is on the case detail only (`views/EntityDetailView.java`, `FORM_MARKDOWN`); manifest `menus-and-case-lists/10-markdown-any-property-or-expression` |
| `searchScreenText` | `boolean` | `true` | `false` | manifest `case-search/title-label-lang-non-empty`, `description-lang-markdown`, `hint-lang` (Android ignores them; the breadcrumb shows the search command's label) |
| `searchFieldChecks` | `boolean` | `true` | `false` | manifest `case-search/required-test-text`, `validations-0-test-text` |
| `hiddenSearchFieldWithDefault` | `"hidden" \| "editable"` | `"hidden"` | `"editable"` | manifest `case-search/hidden-exclude-with-a-default-value-on-a-prompt-with-no-itemset` |
| `barcodeSearchField` | `"text" \| "scan-or-text"` | `"text"` | `"scan-or-text"` | manifest `case-search/appearance-barcode-scan` (Web Apps: a plain text box) |
| `zeroSearchResults` | `"results" \| "stay-on-search"` | `"results"` | `"stay-on-search"` | Android `activities/QueryRequestActivity.java::processSuccess` (`isResponseEmpty` → `Toast`, the activity does not finish) |
| `skipToResults` | `boolean` | `true` | `false` | manifest `case-search/workflow-skip-to-default-results-auto-launch-true-default-search` (Android never reads `auto_launch`: the list first, the search action opens the query) |
| `hereValue` | `"lat-lon" \| "lat-lon-alt-acc"` | `"lat-lon"` | `"lat-lon-alt-acc"` | Formplayer `util/FormplayerHereFunctionHandler.java::eval` (two values); Android `utils/AndroidHereFunctionHandler.java::toGeoPointData` (four), Core `GeoPointData.java::fillArray` floors altitude and accuracy to two decimals. Web Apps' value is never read (§11) |
| `formScreens` | `"one-screen" \| "field-list-or-question"` | `"one-screen"` | `"field-list-or-question"` | Web Apps draws every question of the form (`form_entry/form_ui.js`; manifest `questions/question-list-*` ignored); Core `form/api/FormEntryController.java::getQuestionPrompts` collects every question of a field-list group as one screen and returns one prompt otherwise (`FormController.java::indexIsInFieldList`), and Nova writes `appearance="field-list"` on every section and every labeled group (`lib/commcare/xform/builder.ts::buildContainer`) |
| `recalculation` | `"every-request" \| "on-change"` | `"every-request"` | `"on-change"` | Formplayer `application/FormController.java` and `FormSubmissionHelper.java` rebuild the session per request → `session/FormSession.java` → Core `model/FormDef.java::initialize(false, …)` → `initAllTriggerables`; `EVENT_XFORMS_READY` only when `newInstance` |
| `dayNumberEpoch` | `"utc" \| "device-zone"` | `"utc"` | `"device-zone"` | Core `model/utils/DateUtils.java::EPOCH_TIME` is a static computed at class load with the default provider, so in the JVM's zone; manifest `expressions-and-data/int` records Formplayer's JVM as `Etc/UTC`; Formplayer sets the browser zone per request after that (`services/BrowserValuesProvider.java`, `aspects/SetBrowserValuesAspect.java`) |
| `help` | `"label-icon" \| "info-button"` | `"label-icon"` | `"info-button"` | Web Apps `form_entry/question.html` (`help-text-trigger`, `fa-question-circle`, "Show help dialog", a modal); Android `views/widgets/QuestionWidget.java::addHelpPlaceholder`, `::showHelpWithDialog` |
| `helpMediaWithoutText` | `"hidden" \| "shown"` | `"hidden"` | `"shown"` | Web Apps renders help media inside the same `ko if: help()` block; Core `form/api/FormEntryPrompt.java::hasHelp` is true for help media alone |
| `hint` | `"markdown" \| "plain"` | `"markdown"` | `"plain"` | Web Apps `question.html` (`hint-text webapp-markdown-output`, `html:` through `markdown.render`); Android `QuestionWidget::addHintText` |
| `labelMarkdown` | `{ singleNewline: "break" \| "space"; html: "literal" \| "dropped"; images: "shown" \| "alt-text" }` | `{ "break", "literal", "shown" }` | until §24.1: `{ "space", "literal", "alt-text" }` | Web Apps `cloudcare/js/markdown.js::render` (`breaks: true`, markdown-it `html: false`); Android `CommCareApplication.java::getMarkwonInstance` (no HTML plugin). The Android until-value holds the manifest's reading of `questions/markdown-form-equal-to-the-default-text` ("Markwon: single newlines join, images alt-only") for newlines and images, and today's rendering for HTML, which the manifest does not state |
| `groupLabel` | `"card" \| "screen-header"` | `"card"` | `"screen-header"` | Android `views/QuestionsView.java::deriveGroupText` over `FormController.getGroupsForCurrentIndex`, joined `Outer > Inner`, a repeat's `(n)` |
| `repeatAdd` | `"buttons" \| "prompt"` | `"buttons"` | `"prompt"` | Android `activities/FormEntryActivityUIController.java::createRepeatDialog`, Core `form/api/FormEntryCaption.java::getRepeatText` |
| `choiceMedia` | `boolean` | `false` | `true` | manifest `questions/choice-image`, `choice-audio-video`; Android `views/media/MediaLayout.java::buildAudioImageVisualLayout` |
| `locationQuestion` | `"map" \| "record-location"` | `"map"` | `"record-location"` | Web Apps `form_entry/entries.js::GeoPointEntry`, `entry_geo.html`; Android `views/widgets/GeoPointWidget.java`, `activities/GeoPointActivity.java` |
| `barcodeQuestion` | `"text" \| "scan-or-text"` | `"text"` | `"scan-or-text"` | Web Apps `entries.js::getEntry` (`case constants.BARCODE` falls through to `FreeTextEntry`); manifest `questions/barcode-barcode` |
| `capture` | `"attach" \| "device"` | `"attach"` | `"device"` | Web Apps `entries.js::FileEntry` and `entry_file.html`; Android `views/widgets/ImageWidget.java`, `CommCareAudioWidget.java`, `VideoWidget.java` |
| `submitLabel` | `"submit" \| "finish"` | `"submit"` | `"finish"` | Android `form.entry.finish.button` |
| `logo` | `boolean` | `true` | `false` | manifest `application-and-settings/logo-refs-hq-logo-web-apps` (Android ignores it) |

The capture limits are not a rule field: the upload route needs them on the server, so they live in
`lib/domain/captureFormats.ts::CAPTURE_LIMITS` (§16.3) and Preview reads them through the platform.

---

## 6. Navigation and the Android home screen

### 6.1 Where it renders

`components/preview/screens/DeviceHomeScreen.tsx` (new) renders when the effective platform's
`appHome` is `"device-home"`, the location is `home`, and `previewAtDeviceHome` is true;
`components/preview/screens/HomeScreen.tsx` returns it in place of the module list in that case (edit
mode never shows it). `previewAtDeviceHome` becomes true per §3.2, on an Android
`postSubmitAppHome` landing (§7), on an Android formless case list selection (§9), and when the
breadcrumb's or the back button's home is chosen from the module list on Android (§6.3). Start sets
it false.

### 6.2 The screen

The app's name (the `EditableTitle` read-only, as `HomeScreen` shows it) over full-width buttons, 44px
each, in Android's order (`HomeButtons.java::buildButtonData`). Labels are runtime messages
(`lib/preview/runtimeMessages.ts`, English and Spanish, in the worker's language); reason lines are
Nova's chrome, in English, under the button, and a reason of two sentences keeps its final period
(`design/readme.md`, "Keep them on multi-sentence copy"); a one-sentence reason has none.

| Button (key) | English / Spanish | Shown | In Preview |
|---|---|---|---|
| `deviceHomeStart` | Start / Iniciar | always | Opens the module list: `setPreviewAtDeviceHome(false)` on location `home`, which is what `StandardHomeActivity::enterRootModule` opens (`MenuActivity` with the root menu). |
| `deviceHomeSaved` | Saved / Guardados | iff `appSettings.showSavedForms` (Nova always writes `<checkoff active="true"/>`, so Android's gate reduces to the setting: `StandardHomeActivityUIController.java::getHiddenButtons`) | Disabled. Reason: `Preview doesn't keep sent forms. On a phone, this lists them.` |
| `deviceHomeIncomplete` | Incomplete / Incompletos | iff `appSettings.showIncompleteForms` | Disabled. Reason: `Preview doesn't keep unfinished forms. On a phone, this lists them.` |
| `deviceHomeSync` | Sync with server / Sincronizar con el servidor | always | Works: calls `invalidateCaseData(appId, caseType)` (`lib/preview/hooks/caseDataInvalidation.ts`) for every effective case type, which re-reads the worker's restore exactly as a submission's announcement does, then `markPreviewDeviceSynced(Date.now())`. Sub-line `deviceHomeLastSync`: `You last synced with the server: {time}` / `Última sincronización con el servidor: {time}`, `{time}` from `previewDeviceSyncedAt` through `Intl.DateTimeFormat(workerLanguage, { dateStyle: "medium", timeStyle: "short" })`. |
| `deviceHomeLogOut` | Log out of CommCare / Cerrar sesión en CommCare | always | Disabled. Reason: `In Preview, you can choose the worker from Running as at the top` |

Training, View Job Status and Report an Issue never show for a Nova app: Nova writes no training
module, no Connect job, and no `cc-home-report` (`HomeButtons.java`, `getHiddenButtons`). Saved,
Incomplete and Log out are shown disabled because the worker sees them on a phone; they cannot work
honestly in Preview, which keeps no form archive or resume (`lib/preview/CLAUDE.md`, "There is no form
resume"). A disabled button is a `Button` with `disabled` and `aria-describedby` naming its reason
line.

### 6.3 Breadcrumb and back on Android

`lib/routing/previewBreadcrumbs.ts::previewBreadcrumbTrail` gains `appHome: "root-menu" |
"device-home"` and `atDeviceHome: boolean` in `PreviewTrailInput`. On `"device-home"`:
- at the device home the trail is one crumb, the runtime message `home` ("Home");
- on the module list the trail is the `home` crumb then the app's root, and the `home` crumb's
  handler (`components/builder/BreadcrumbStrip.tsx::breadcrumbHandlers`) calls
  `setPreviewAtDeviceHome(true)`;
- below the module list nothing changes.

`BreadcrumbStrip`'s `canGoBack` becomes `loc.kind !== "home" || (previewing && appHome ===
"device-home" && !atDeviceHome)`, and its back handler on the module list while previewing sets
`previewAtDeviceHome` true. The strip renders in edit mode too, where an Android-only app's
`previewAtDeviceHome` is false, so the `previewing` term keeps Back disabled on the edit home screen.
Web Apps is today's trail.

---

## 7. After submit

`components/preview/screens/FormScreen.tsx::dispatchPostSubmit` and
`lib/preview/app-tests/submission.ts` (the `post-submit` switch):

| Destination | Web Apps | Android |
|---|---|---|
| `app_home` (HQ's default) | the module list (`navigate.goHome()`, today) | the device home: `navigate.goHome()` and `setPreviewAtDeviceHome(true)` |
| `firstMenu` (HQ's `root`) | the module list (today) | the module list (`finishAndPop` pops the empty `<create/>` frame → `MenuActivity(root)`) |
| `module`, `parentMenu`, `previous` | today | today (Formplayer and Android both land on the module's first screen, `workflow.py::_frame_children_for_module`) |

Both `FormScreen` and `submission.ts` read `rules.postSubmitAppHome`.

**A link to a target the worker's menu hides.** `afterSubmitRoute` (`lib/preview/afterSubmitRouting.ts`)
gains two arguments, `rules: PreviewPlatformRules` and `targetVisibility: (link: FormLink) =>
"shown" | "form-hidden" | "form-in-hidden-module" | "module-hidden"`, which the caller computes with
`formDisplayVisibility` and `moduleDisplayVisibility` (`lib/preview/engine/displayConditionEvaluation.ts`)
and `hiddenFromMenu` up the module chain, over the submitted entry's session: a form target is
`form-in-hidden-module` when its module, or any module above it, is off the menu or has a display
condition that is false, else `form-hidden` when the form itself is off the menu or its display
condition is false; a module target is `module-hidden` when its display condition is false. On
`afterSubmitHiddenTarget: "opens"` (Android) the route is today's. On `"landing"` (Web Apps):

| Target | Route |
|---|---|
| a form whose display condition is false, or a form off the menu | `{ kind: "module", moduleUuid: <the form's module>, landing, caseSelections }`: the module that holds it |
| a form inside a module off the menu, a form inside a module whose display condition is false, or a module whose display condition is false | `{ kind: "post-submit", destination: "firstMenu" }`: the app's first screen |

These are the four landings `hiddenTargetLine` states, plus the form whose module's display condition
is false, which lands as a form in a module off the menu does: Formplayer's
`services/MenuSessionFactory.java::rebuildSessionFromFrame` matches the frame's steps only against
`MenuScreen.getMenuDisplayables()`, which leaves out a module whose display condition is false, so
the walk stops on the app's first screen. A `pending` visibility (case data still
loading) waits, as the screen's other visibility reads do.

---

## 8. Entry points

### 8.1 What each platform does

`prepareEntryPointLaunch` (`lib/preview/entryPointLaunch.ts`) gains `rules: PreviewPlatformRules`
and a `notHeld: CaseDatabaseSnapshot` argument (§8.2), and returns, in its `launched` result,
`claimCaseIds: readonly string[]` and `blankCaseIds: readonly string[]`:

| | Web Apps | Android |
|---|---|---|
| Display conditions | Today: a form off the menu, or in or under a module off the menu, opens only when the entry point ignores display conditions; a hidden module refuses. | Ignored: every check of `!bypass` is skipped (`entryPointDisplayConditions: "ignored"`). |
| Claims | Every chosen case of a non-search-first module is claimed: the launch hook passes `claimCaseIds` to `installEntryPointLaunch(launch, claimCaseIds)`, which writes them under the launch's worker in the same `set` that installs the launch (§3.1), as HQ's claim frame posts before navigation. A launch as another worker therefore keeps its claim; `addPreviewClaims` keys on the current worker, and a separate call before the install would lose it to the install's change of worker. | None (`claimCaseIds` is empty). |
| A case this worker's phone does not hold | Claimed: it joins the claims, so the device snapshot the form reads holds it, and the form opens with its saved values. | Opens with blank preloads and no persistent case tile: `blankCaseIds` names it, the menu selection carries the id with empty `caseProperties`, and the form's case reads walk a casedb that lacks it, as on the phone. |

`FORM_OFF_THE_MENU_ENTRY_POINT_REFUSAL` becomes `"This form is off the menu, and in Web Apps an entry
point opens it only when the entry point ignores display conditions. You can set it to ignore them."`;
it is reached only on Web Apps. `lib/preview/CLAUDE.md` "Entry-point launch" loses "A case absent
from that worker's restore refuses the launch" and gains §8.1's table.

### 8.2 Choosing a case the phone lacks

`components/preview/EntryPointPreviewLaunch.tsx::EntryPointCasePicker` lists, under the worker's
cases (today's `loadCasesAction` read), a second group headed `Cases this worker doesn't have`,
loaded by `loadEntryPointOtherCasesAction` (new, `lib/preview/entryPointLaunchAction.ts`): the
Project's open cases of the requirement's case type that the worker's restore scope does not hold,
50 a page like the first group, behind the same authorization. The case store gains the read:
`lib/case-store/store.ts::SearchPopulation` gains `onlyOutsideRestore?: true`, and
`lib/case-store/postgres/store.ts`'s query and count, which already build the searching worker's
closure for a search population (`searchPopulationHeldBy`, `compileRestoreScope.ts::RestoreScopeQuery.holds`),
add `not holds(cases)` to the outer scan when it is set. The read is therefore HQ's search population
(every open case of the type in the bound Project, `case_search/utils.py`'s `is_closed(False)`) less
the worker's restore closure, paged and counted in one statement each, and it keeps a search
population's rules: never together with `restoreScope` (today's `searchPopulationWithRestoreMessage`
refusal), held cases excluded as every read excludes them. The action reads it through the
authorized Preview context's store with `searchPopulation: { heldBy: <the worker's restore scope>,
onlyOutsideRestore: true }`. Under the group, one line for the effective platform:
- Web Apps: `Choosing one claims it for this worker, as Web Apps does`
- Android: `The phone doesn't have these, so the form opens without their saved values`

`entryPointLaunchAction.ts` passes both snapshots to `prepareEntryPointLaunch`, which admits a
selection from either; a selection from neither still refuses ("One or more cases are unavailable to
this Preview worker…", today's text).

### 8.3 Submitting a form opened for a case the phone lacks

On Android the form opens; what its completion does is not settled by reading
(`CaseXmlParser.java::loadCase` throws for an update or close of a missing case, and
`FormSubmissionHelper.java::handleExceptionFromFormProcessing` quarantines the form and posts
"Problem with your App"; whether the quarantined form ever reaches HQ, and where the notice shows,
is §24.3). §24.3 runs as a pull request 9 slice, so pull request 8 lands only the rule field
`entryPointUnheldCaseSubmit` with its until-value and no reader: a form opened for a `blankCaseIds`
case submits as any submission does at pull request 8's head. Pull request 9, once §24.3 has run on
its branch, lands one of the two outcomes below with its copy; the stack deploys as one, so the
interim behavior never reaches a person.

**Which forms change the case.** `lib/preview/unheldCaseSubmit.ts::formChangesSessionCase(doc:
BlueprintDoc, formUuid: Uuid, closeHolds: boolean): boolean` (new, pure, pull request 9 under outcome
A) is true when the form's own case block or one of its operations would update or close the
module's case, which is what makes Core's `loadCase` throw (`CaseXmlParser.java`, update and close
call it with `errorIfMissing`):
- a close form (`form.type === "close"`) when `closeHolds`, which `FormScreen` passes from the
  submitted entry: whether its answer to `closeCondition.field` matches `closeCondition.answer` under
  the condition's `operator` (`=` when absent, `selected` for a multiple choice), and true when the
  form has no `closeCondition`;
- a follow-up whose case-write inventory has a primary update (`lib/domain/caseWriteInventory.ts::deriveCaseWriteInventory`
  holds a bucket `{ kind: "primary", action: "update" }`), which is the primary `<update>` that
  `lib/commcare/xform/caseBlocks.ts` writes when the update map has entries;
- an authored case operation (`lib/domain/forms.ts::orderedCaseOperations`) whose `action` is
  `update` or `close` and whose `target` is `{ kind: "session" }`.

An operation whose target is an earlier create (`op`) changes a case the form itself makes; one whose
target is an `expression` names a case through the worker's data, which the phone resolves against
its own restore, and is not counted. A form that only reads the case, or only indexes to it
(`errorIfMissing` is false for index and attachment), is not counted either.

**Outcome A (the form never reaches HQ).** `FormScreen`'s submit, on Android with a `blankCaseIds`
case for which `formChangesSessionCase` is true, writes nothing and lands where the form's
after-submit destination lands, with a toast (`lib/ui` toast singleton, kind `error`) holding the
runtime messages:
- `formNotProcessedTitle`: `CommCare couldn't save this form` / `CommCare no pudo guardar este formulario`
- `formNotProcessedDetail`: `The phone doesn't have the case this form changes, so the phone couldn't save the form. A worker sees “Problem with your App”.` / `El teléfono no tiene el caso que cambia este formulario, así que no pudo guardarlo. Quien trabaja ve “Problem with your App”.`

Pull request 9 then adds `unheldCaseSubmit.ts`, its test, the reader in `FormScreen.tsx` and
`lib/preview/app-tests/submission.ts`, and the two runtime messages.

**Outcome B (the form reaches HQ and HQ applies it).** Pull request 9 sets the rule to `"submits"`
on Android too; the submission writes as any submission does (the case exists in the Project's case
store, so its row takes the update), and nothing else is added.

---

## 9. The case list menu item

A module with a case list and no forms (`caseListOnly`): the runtime reached the case list through
the module's one menu item, Nova's label the module's name (`lib/commcare/expander.ts`). Both
platforms show the case's detail with **Continue** when the module's Details has columns, because
HQ gives the datum `detail_confirm` only then (`app_manager/suite_xml/sections/details.py::DetailsHelper.get_detail_id_safe`);
with no Details columns a row selects at once (Web Apps `formplayer/menus/views.js` row click with
no `hasDetails`; Android `EntitySelectActivity`). Continue is the existing runtime message
`continue` (Android `select.detail.confirm=Continue`, `EntityDetailActivity.java`; Web Apps
`case_detail.html` `#select-case`).

`lib/preview/formlessCaseListRoute.ts` (new, pure): `formlessCaseListSelection(rules)` returns
`{ kind: "root-menu", notice: "formlessReturned" }` on Web Apps and `{ kind: "device-home" }` on
Android. `CaseListScreen.tsx` stops treating such a list as informational: its Details offers
Continue (or the row selects), and the selection performs the route:
- Web Apps: `navigate.goHome()` and a success toast with the runtime message `formlessReturned`:
  `Synced and back at the app's first screen` / `Sincronizado y de vuelta en la primera pantalla`
  (Web Apps shows "Redirecting after sync" for 10 seconds, `formplayer/app.js::handleNotification`,
  `CloudcareUtils.showSuccess`);
- Android: `navigate.goHome()` and `setPreviewAtDeviceHome(true)`.

`components/builder/CLAUDE.md`'s sentence "A module with no case-loading Form is informational"
becomes: "A module with no forms plays the runtime: Details offers Continue when it has columns, and
choosing a case returns to the app's first screen in Web Apps, with its sync notice, or to the
phone's home screen on Android."

---

## 10. Search

Every change reads one rule; Web Apps is today's behavior in each row.

- **Screen text** (`searchScreenText: false`): `components/preview/shared/SearchInputForm.tsx`
  renders no search title, no description and no Search field hints on Android; each field keeps its
  label. The screen's heading is the search action's label, which the breadcrumb already shows.
- **Field checks** (`searchFieldChecks: false`):
  `lib/preview/engine/searchInputConstraints.ts::searchInputConstraintErrors` and
  `::searchInputRequiredMarks` take `rules` and return no errors and no marks on Android, so Search
  runs whatever the answers.
- **A hidden Search field with a starting value** (`hiddenSearchFieldWithDefault: "editable"`): the
  field list `SearchInputForm` draws (`hooks/useSearchInputRunState.ts`) includes it on Android as an
  ordinary field holding its starting value, which the worker may change.
- **A barcode Search field** (`barcodeSearchField: "text"`): on Web Apps the field is a plain text
  box; `SearchInputForm` draws no scan button (`barcodeDetectorConstructor` is not consulted). Android
  keeps today's scan and typed entry.
- **Zero results** (`zeroSearchResults: "stay-on-search"`): `lib/preview/caseListPhase.ts::caseListStep`
  gains `rules`; on Android a submitted search whose read returns no rows keeps the search step with
  the answers as typed, and `CaseListScreen` shows a toast with the existing runtime message
  `noSearchMatches` ("No cases match your search"). No no-matches registration is offered there: it
  needs a search-first host, which Android refuses (part 01 §4.1, `search-first`).
- **Skip to results** (`skipToResults: false`): `caseListPhase.ts::automaticallyLaunchesSearch`
  returns false on Android, so a module whose search has a filter and no visible Search field shows
  the worker's list first, with the search action.
- **A claim is followed by a sync** (`claimThenSync: true`): after `addPreviewClaims` on Android,
  `CaseListScreen` calls `invalidateCaseData` for every effective case type, as Sync with server
  does. App Tests' `postAppTestClaims` (`lib/preview/app-tests/run.ts`) re-reads `deviceCases` on an
  Android session after each claim.

---

## 11. Case lists

- **Tile grouping** (`tileGrouping: "flat"`): Android draws an ordinary tile list in sort order,
  paged by cases. Grouping lives in the server read as well as on the client:
  `lib/preview/engine/caseDataBindingHelpers.ts::readCases` takes the early exit to
  `readGroupedCases` (clusters by group key, pages by groups) whenever the list is paged and the tile
  has `grouping`. `readCases` gains a required `tileGrouping: "grouped" | "flat"` and takes that exit
  only on `"grouped"`, so on Android the flat path reads, counts and pages by cases. Its callers
  pass the rule: `caseDataBinding.ts` from `previewPlatformRules(context.device.platform)` (the
  authorized context's device, §18.5), `lib/preview/app-tests/records.ts` from the session's
  platform, and `searchResultsSnapshot.ts::readSearchResultsSnapshot` through the `SearchRead` that
  `caseDataBinding.ts` and `serverSearchRead.ts` build (an unpaged read, so it is flat on both). On the client, `lib/preview/caseTileGrouping.ts::splitTileGridByGroupHeader` gains `rules`
  and returns one group per case on Android, and the grouped page's "choosing a group selects its
  first case" note (`groupSelection`) does not show.
- **Border and shading** (`tileBorderShading: false`): `lib/preview/caseTileRendering.ts::planTileCell`
  gains `rules` and returns `bordered: false, shaded: false` on Android whatever the cell says.
- **Vertical alignment** (`tileVerticalAlign: "middle-only"`): on Android `planTileCell` keeps
  `alignSelf: "center"` for a `middle` cell and, until §24.2, `alignSelf: "start"` for `top` and
  `bottom` (the framework's default gravity; outcome B in §24.2 changes only `bottom`). Horizontal
  alignment and font size are honored on both (`computeGravity`, `EntityViewTile.java` font sizes).
- **A link column** (`linkColumnInList: "raw-text"`): `lib/preview/columnDisplay.ts` shows a `link`
  column's text as the literal `[text](value)` it holds in Results rows and tiles on Android; the
  case detail shows the link on both.
- **A column hidden from Results** stays searchable by the quick filter on both platforms
  (`components/preview/shared/listFilter.tsx::rowMatchesFilterText`, today), which is Web Apps'
  reading; Android runs it the same.
- **`here()`** (`hereValue`): `lib/preview/engine/runtimeBindings.ts::viewerLocationText` takes
  `rules` and, on Android, spells `lat lon alt acc`: `openJdk17DoubleToString`
  (`lib/domain/expression/openJdk17DoubleString.ts`) of the latitude, the longitude, the altitude
  floored to two decimals (`0` when the browser gives none, as `Location.getAltitude` does) and the
  accuracy floored to two decimals. `ViewerLocation` (`lib/preview/engine/viewerLocation.ts`) gains
  `altitude: number | null` and `accuracy: number`, filled from the position
  `lib/session/viewerPosition.ts` already watches. The refresh rule (30 meters, stop at 1,600 meters)
  is Android's and stays. Preview on Web Apps never reaches `here()` in a case list: part 01's
  `case-list-here` (part 01 §4.1) refuses it in every app that declares Web Apps, so an app holding
  it runs only on Android and Preview plays Android there. The two-value spelling stays the Web Apps
  arm only so the rule table is total; nothing reads it.

---

## 12. Forms: screens, recalculation and day numbers

### 12.1 Screens

`FormEngine.sectionPages()` becomes `FormEngine.formScreens(): ReadonlyArray<FormScreenPage>`, the
one page model the pager, App Tests' `pageNext` / `pagePrevious` / `section`, `evaluate_form`'s
`sectionUuid` and Submit routing read. `FormScreenPage` is today's `SectionPage` (`formEngine.ts`)
with `kind: "form" | "section" | "field-list" | "question"` added; its `uuid` is the form's, the
section's, the group's or the question's, and its `path` is the screen's concrete instance path with
repeat indexes (`/data` for a whole-form screen, `/data/visits[2]/note` for a question in an entry),
which is the screen's identity: two entries of one repeat share a `uuid` and never a `path`.
`currentSectionUuid()`, `enterSectionAsync(uuid)` and `validateSectionAsync(uuid)` become
`currentScreenPath()`, `enterScreenAsync(path)` and `validateScreenAsync(path)`;
`lib/preview/hooks/useSectionPages.ts` becomes `useFormScreens.ts`.
`FormEngineRuntimeOptions.device` (§20) decides the screens:

- **`"one-screen"` (Web Apps)**: one screen holding the whole form, `{ kind: "form", path: "/data" }`.
  A sectioned form shows each section as a titled group on that screen: `FormScreen` renders
  `FormRenderer` with the shared `SectionHeading` (not focusable as a page) above each section's
  questions, no `SectionStepper`, and Submit validates the whole form and reveals the first invalid
  question (the ordinary two-frame reveal, with no page to turn). `activeSectionByForm` is still
  written as the author scrolls, so a flip to edit mode opens on the section in view.
- **`"field-list-or-question"` (Android)**: Core's `FormEntryController.getQuestionPrompts` makes a
  field-list group one screen of all its questions and any other index one screen of one question,
  and Nova writes `appearance="field-list"` on every section and every labeled group (text or media
  label) and never on an unlabeled one or a repeat's wrapper (`lib/commcare/xform/builder.ts::buildContainer`,
  `::buildRepeatBody`). So:
  - a sectioned form is one screen per section (today's pager, unchanged);
  - in a form with no sections, a labeled group is one screen of every visible question inside it,
    nested groups included, and a labeled group inside a repeat entry is one screen per live entry;
  - an unlabeled group is transparent: each of its questions is placed as if the group were absent;
  - every other visible, non-hidden question, a label included, is its own screen in document
    order, inside every live repeat entry.

  Next validates the current screen and Back never does (today's `goNext` / `goBack` in
  `useSectionPaging.ts`, renamed `useFormPaging.ts`); a screen with nothing relevant is skipped. The
  bottom bar shows Back and Next, and on the last screen the runtime message `finish` (`Finish` /
  `Terminar`) in Submit's place (`submitLabel`). An unsectioned form has no stepper: Android shows
  none.
- **The repeat add prompt** (`repeatAdd: "prompt"`, Android, unsectioned forms only:
  `FORM_SECTION_USER_REPEAT` keeps a user-added repeat out of a section). A user-added repeat inside a
  labeled group has no prompt: its group is a field-list, and Core's `getQuestionPrompts` steps over
  `EVENT_PROMPT_NEW_REPEAT` while it collects a field-list screen, so the phone offers no way to add
  an entry there. Preview shows that screen with the entries the repeat already holds (none, for an
  instance started empty) and draws neither the prompt nor an add button. Stepping Next past the last
  entry of a repeat the worker adds to (or past the repeat when it has none) opens an `AlertDialog`
  (`@/components/shadcn`) with three actions: `repeatGoBack` (`Go back` / `Volver`), the add choice,
  and `repeatDoNotAdd` (`Do not add` / `No agregar`), or `repeatDoNotAddFinish` (`Do not add, I'm
  finished` / `No agregar, terminé`) when nothing follows the repeat. The add choice is the runtime
  message `repeatAddNew` (`Add a new {label}?` / `¿Agregar un nuevo {label}?`) when the repeat has no
  entry and `repeatAddAnother` (`Add another {label}?` / `¿Agregar otro {label}?`) after
  (`FormEntryCaption.getRepeatText`), `{label}` the repeat's label in the worker's language. Add
  appends an entry (`FormEngine.addRepeat`) and opens its first screen; Do not add moves on; Go back
  returns to the previous screen. Android offers no delete, so the entry's Remove control does not
  show on Android. Count-driven and record-driven repeats have no prompt on either platform.

`lib/preview/engine/sectionPaging.ts::resolveCurrentPage` keeps its rule over screens.
`lib/preview/CLAUDE.md` § "Sections page the preview on Android's rules" is renamed "Form screens per
platform" and states this section.

### 12.2 Recalculation

`TriggerDag` (`lib/preview/engine/triggerDag.ts`) gains `getAllWork(repeatCount):
ExpressionEvaluationPaths`: every node in topological order (`sortedPaths`, each materialized over
live entries) as `values`, and every node with a `required` expression as `required`.
`FormEngine` gains a private `requestWork(changedPaths)` that returns `getAllWork` under
`recalculation: "every-request"` and `getAffectedWork(changedPaths)` under `"on-change"`, used by
`setValue`, `settleValueChangesAsync`, `evaluateRepeatCascade` (repeat insert and removal) and a new
`FormEngine.prepareSubmit()` that runs `requestWork([])` once before submit validation on Web Apps
(`FormSubmissionHelper` rebuilds the session before it validates). Document edits
(`evaluateChangedPathsInto`) and default re-evaluation (`reevaluateDefault`) keep affected work:
they are authoring, not a worker's request.

The full pass re-evaluates every `calculate`, `relevant`, `required`, `output` and `choices`
expression. It never re-runs defaults or start-of-form setvalues (`FormDef.initialize` fires
`EVENT_XFORMS_READY` only for a new instance), and a repeat entry's starting values run only on its
insert (Core `initTriggerablesRootedBy`). So on Web Apps a calculate reading `now()`, `random()` or
`uuid()` changes after an unrelated answer, a `sleep()` calculate runs on every answer, and a
condition over one of them re-evaluates too.

### 12.3 Day numbers

The epoch travels with the evaluation, never in module state: an evaluation that awaits (the async
path) would otherwise read whatever epoch a concurrent evaluation left behind.
`lib/preview/xpath/coreDays.ts` exports `type DayNumberEpoch = "utc" | "device-zone"`, and:

- `coreDaysSinceEpoch(calendarDays, epoch: DayNumberEpoch)` subtracts `0` under `"utc"` and
  `localMidnight(0)` (today's `coreEpochTime()`) under `"device-zone"`;
- `coreFractionalDays(instantMs, epoch: DayNumberEpoch)` under `"utc"` is `instantMs / DAY`, with no
  drift term: Formplayer's `DateUtils.EPOCH_DATE` is `getDate(1970, 1, 1)` built when the class loads,
  in the JVM's zone (`Etc/UTC`, manifest `expressions-and-data/int`), so it is UTC midnight, and both
  `Date.getTimezoneOffset` calls of `fractionalDaysSinceEpoch` read that same JVM zone, which is `0`
  at every instant. Under `"device-zone"` it is today's;
- `coreDateAdd(days)` is unchanged and takes no epoch: Formplayer's `date(n)` calls
  `getDate(1970, 1, 1)` per call (`FunctionUtils.java`, `dateAdd(getDate(1970, 1, 1), n)`), after
  `SetBrowserValuesAspect` has set the browser's zone, so it stays on the browser's local midnight on
  both platforms.

`XPathDate.coreDays` (`lib/preview/xpath/types.ts`) becomes the method `coreDaysUnder(epoch)`, and the
coercions that read a day number take the epoch as a required argument: `coerce.ts::toNumber(input,
epoch)`, `::toDouble(input, epoch)`, `::compareEqual` and `::compareRelational`, so `tsc` names every
caller. `EvalContext` (`lib/preview/xpath/types.ts`) gains `dayNumberEpoch?: DayNumberEpoch`, read once
per call site through `types.ts::dayNumberEpochOf(context)` (`context.dayNumberEpoch ??
"device-zone"`, today's behavior for every context that does not set it), and
`functions.ts::XPathFunctionContext` gains a required `dayNumberEpoch`, so `invokeFunction`'s two
callers (`evaluator.ts` and `asyncEvaluator.ts`) pass it and the function bodies in `functions.ts`,
`scalarJavaRosaFunctions.ts` and `nodeSetJavaRosaFunctions.ts` hand it to the coercions. The
synchronous evaluator (`evaluator.ts`, `operatorSemantics.ts`) and the async one
(`asyncEvaluator.ts::evaluateRuntimeAsync` and `::evaluateAsyncNode`, which call `toNumber` and
`evaluateSyntaxNode` directly for any expression holding `regex()`, `replace()`, `sleep()` or the
crypto functions) both read it from the `EvalContext` they already carry. `FormEngine.createEvalContext`
and every Preview evaluation context set it from the rule. So on Web Apps a day number is the
browser-zone midnight counted from UTC's 1970 midnight in fixed days with half-day rounding: the
calendar day in zones from twelve hours behind UTC (exclusive) to twelve hours ahead (inclusive), one
less in zones more than twelve hours ahead (`Pacific/Kiritimati`, `Pacific/Apia`), and one more at
exactly twelve hours behind (`Etc/GMT+12`). The XPath worker request
(`lib/preview/xpath/workerProtocol.ts::XPathRuntimeRequest`) gains `dayNumberEpoch`, and
`XPATH_WORKER_PROTOCOL_VERSION` becomes `9`.

`today()` is the browser's day on both (Formplayer's clock is the server's with the browser's zone,
`BrowserValuesProvider`; Preview's clock is the browser's).

---

## 13. Question text

- **Help** (`help`, `helpMediaWithoutText`). `components/preview/form/FieldHelp.tsx` branches on
  mode. Edit mode keeps today's inline rendering (the author sees the help they write). The running
  form draws a help button and a `Dialog` (`@/components/shadcn/dialog`):
  - Web Apps: an icon button at the end of the label line (`@iconify-icons/tabler/help-circle`,
    44px target), `aria-label` the runtime message `showHelp` (`Show help` / `Mostrar ayuda`), shown
    only when the question has help text; the dialog holds the help as markdown and the help media,
    and a close button (`aria-label` the runtime message `close`, `Close` / `Cerrar`), as
    `form_entry/question.html`'s modal holds a `btn-close` in its body.
  - Android: an icon button right-aligned under the question (`@iconify-icons/tabler/info-circle`,
    44px), same label, shown when the question has help text or help media; the dialog holds the
    help as markdown (Android forces the markdown form for help, `QuestionWidget::createHelpLayout`)
    and the media, and an `OK` button (runtime message `ok`, `OK` / `Aceptar`).

  Neither runtime's dialog shows a title: Web Apps' modal has only a body (`question.html`) and
  Android's `AlertDialog` sets a view and an OK button and no title
  (`QuestionWidget.java::fireHelpText`). So the `Dialog`'s `DialogTitle` holds the question's label
  text with `sr-only`, which gives the dialog its accessible name and draws nothing. A row with help is shorter in the running form
  than in edit mode by the help's height; the flipbook keeps the anchor field through scroll sync
  (`components/builder/CLAUDE.md`, "Flipbook"), and that paragraph gains: "A row the running
  platform draws differently (help behind its button, Android's group header, choice media on Web
  Apps) keeps the anchor field; rows after it may move."
- **Hint** (`hint`): `InteractiveFormRenderer.tsx` renders the hint through `PreviewMarkdown` on Web
  Apps (today) and as plain text on Android (`whitespace-pre-wrap`, italic, `text-xs`), the hint's
  text with no markdown processing.
- **Validation message**: plain text on both platforms (`ValidationError.tsx` renders `{message}` in
  its div, not `PreviewMarkdown`). Web Apps binds it with `text:` (`question.html`, `serverError`),
  Android reads `getConstraintText()` with no text form.
- **Label markdown** (`labelMarkdown`): Web Apps is today's rendering. `lib/markdown.tsx::PreviewMarkdown`
  gains the three options: `breaks` off for `singleNewline: "space"`; raw HTML removed, its text kept,
  for `html: "dropped"`; and an image drawn as its alt text, with no image element, for
  `images: "alt-text"`. Android holds the manifest's reading until §24.1 (single newlines join, images
  show their alt text, `questions/markdown-form-equal-to-the-default-text`) and today's literal HTML,
  which the manifest does not state; §24.1's outcome sets all three.
- **Group and repeat labels** (`groupLabel`): Web Apps keeps the card header. On Android a group
  draws no card; each screen shows one header line above its questions, the labels of the screen's
  enclosing groups joined with ` > `, a repeat entry's label followed by ` (n)` with `n` its 1-based
  position, unlabeled groups skipped (`QuestionsView.java::deriveGroupText`). A section's screen
  shows the section's title as that line, and a labeled group's screen its own chain. Nested groups
  inside a section's or a labeled group's screen draw no label on Android.
- **Choice media** (`choiceMedia`): `SelectOneField.tsx` and `SelectMultiField.tsx` draw no choice
  image, audio or video on Web Apps; Android keeps today's (image inline, audio and video buttons).
  Choice labels render markdown on both (Nova emits no select appearance, so Android uses
  `SelectOneWidget` / `SelectMultiWidget`, which read the markdown form).

---

## 14. The location question

### 14.1 Web Apps

`components/preview/form/fields/geopoint/GeopointPicker.tsx` keeps the map, the center marker, the
address search and Clear, and loses "use my location" on Web Apps (the only `getCurrentPosition` in
HQ's client is the address question's geocoder, `form_entry/utils.js::renderMapboxInput`). The answer
is the map's center with altitude and accuracy `0`, spelled as Formplayer stores it. One spelling
serves both platforms: `lib/preview/engine/geopointValue.ts::formatGeopoint` replaces today's `tidy`
rounding (six decimals for latitude and longitude, two for altitude and accuracy) with Core's: the
latitude and longitude as given, the altitude and accuracy floored to two decimals
(`GeoPointData.java::fillArray`, `roundDecimalUp` is `Math.floor(x * 100) / 100`), and each of the
four printed with `openJdk17DoubleToString`, so `12.345678 -1.5 0.0 0.0` and `1.0E-4` (Formplayer
`JsonActionUtils.java::convertTouchFormsGeoPointString`, Core `GeoPointData.java::getDisplayText`).
`formatGeopoint` has no other mode. Its other reader, `lib/preview/engine/formAnswerValue.ts`
(`evaluate_form` and App Tests answers), takes the same spelling, so a geopoint answer Preview stores
in a case changes spelling from step 4 (`40 -74 0 0` becomes `40.0 -74.0 0.0 0.0`), which the stored
shape admits: `lib/domain/expression/jsonSchema.ts::GEOPOINT_PATTERN`'s `DECIMAL` takes a decimal
point and an exponent.

### 14.2 Android

`components/preview/form/fields/geopoint/RecordLocationField.tsx` (new), drawn when
`locationQuestion` is `"record-location"`. No map (Nova emits no `appearance="maps"`).

- One button, runtime message `recordLocation` (`Record location` / `Registrar ubicación`), which
  reads `replaceLocation` (`Replace location` / `Reemplazar ubicación`) once answered
  (`R.string.get_location`, `replace_location`).
- Pressing it opens a `Dialog` titled `findingLocation` (`Finding location` / `Buscando ubicación`)
  with a live line `locationAccuracy` (`Location accuracy: {meters} m` / `Precisión de la ubicación:
  {meters} m`) from `navigator.geolocation.watchPosition`, and a `Cancel` button
  (`cancelLocation`, `Cancel` / `Cancelar`). A fix at 5 meters or better is accepted at once
  (`GeoUtils.DEFAULT_GOOD_ACCURACY`). Once a fix is better than 1,600 meters, or 60 seconds have
  passed with any fix, the dialog shows a `Record location` button that accepts the latest fix
  (Android's acceptable accuracy and timeout defaults, which Nova's profile leaves in force,
  `lib/commcare/appProfileSettings.ts`). Cancel closes the dialog and shows the toast
  `locationCaptureCancelled` (`Location capture cancelled` / `Captura de ubicación cancelada`).
- A browser that refuses location keeps the dialog open with the line `Your browser isn't sharing
  its location` (Nova chrome, no period) and Cancel, which is what a phone without a fix shows until
  its timeout.
- The answer is `lat lon alt acc` in §14.1's spelling, altitude and accuracy floored to two
  decimals (`GeoPointData.java::fillArray`), altitude `0` when the fix has none.
- The answered question shows four lines: `Latitude: {dms}`, `Longitude: {dms}`, `Altitude: {m}m`,
  `Accuracy: {m}m` (runtime messages `latitudeLine`, `longitudeLine`, `altitudeLine`,
  `accuracyLine`; Spanish `Latitud`, `Longitud`, `Altitud`, `Precisión`), the coordinates in degrees,
  minutes and seconds with the hemisphere letter (`N 1°17'0"`), the meters with up to two decimals
  (`GeoUtils.formatGps`, `GeoPointWidget::setBinaryData`).

---

## 15. The barcode question

`FieldRenderer.tsx` routes `barcode` to a new `components/preview/form/fields/BarcodeField.tsx` in
both modes, so a form with a required barcode question can be submitted in Preview:
- Web Apps (`barcodeQuestion: "text"`): a text input; the answer is the typed text.
- Android (`"scan-or-text"`): the same text input and a `Scan` button (runtime message `scanBarcode`,
  `Scan` / `Escanear`) that opens the camera scanner `SearchInputForm.tsx` uses for barcode Search
  fields, moved to `components/preview/shared/BarcodeScanner.tsx` so both read one component.

`MediaField.tsx` no longer handles `barcode`; its comment drops the barcode sentence.

---

## 16. Image, audio and video capture, and uploads

### 16.1 Web Apps

Today's `components/preview/form/fields/attachment/AttachmentField.tsx`: a file picker, the
extension lists and 4,000,000 bytes (`entries.js::FileEntry.prototype.onAnswerChange`). No change.

### 16.2 Android

`AttachmentField.tsx` reads `capture` and draws, for `"device"`:
- **Image**: `Take picture` (`takePicture`, `Tomar foto`), an `<input type="file" accept="image/*"
  capture="environment">`, and `Choose image` (`chooseImage`, `Elegir imagen`), an `<input
  type="file" accept="image/*">`; the chosen photo shows inline with `Remove image` (`removeImage`,
  `Quitar imagen`) (`ImageWidget.java`, `R.string.capture_image`, `choose_image`, `discard_image`).
- **Audio**: `Record sound` (`recordSound`, `Grabar sonido`) opens
  `components/preview/form/fields/attachment/AudioRecorder.tsx` (new): a `MediaRecorder` over
  `getUserMedia({ audio: true })` with `Start recording` / `Stop recording` (`startRecording`,
  `stopRecording`; `Empezar a grabar`, `Detener la grabación`) and playback. No picker: Android shows
  "Choose sound" only for `appearance="acquire-or-upload"`, which Nova never writes
  (`CommCareAudioWidget.java`). A browser with no microphone, or a refused permission, shows the line
  `Your browser can't record here` under the question (Nova chrome, no period).
- **Video**: `Record video` (`recordVideo`, `Grabar video`) with `capture="environment"` and
  `Choose video` (`chooseVideo`, `Elegir video`) (`VideoWidget.java`).
- **Limits** (`CAPTURE_LIMITS.android`): a file over 15,727,616 bytes (15 MiB less 1 KiB,
  `utils/FormUploadUtil.java::MAX_BYTES`) is refused with the line `This file is bigger than 15 MB.
  You can choose a smaller one.`; a file of 3,073,024 bytes or more attaches with the line `This
  file is large and may be slow to send`: Android warns when `utils/FileUtil.java::isFileOversized`
  finds `getFileSize(mf) > WARNING_SIZE`, where `getFileSize` is `mf.length() / 1024` in `long`
  division and `WARNING_SIZE` is `3000`, so the first warned size is 3,001 whole KiB. Acceptance is the
  MIME family (`image/*`, `audio/*`, `video/*`): HQ's receiver takes any image, audio or video
  attachment (`corehq/ex-submodules/couchforms/getters.py::_valid_attachment_file`). Fifty
  attachments a form on both (`FormEntryActivity.MAX_FORM_ATTACHMENTS`, Nova's
  `MAX_SUBMITTED_CAPTURE_COUNT`). No resize on either: Nova writes no `jr:imageDimensionScaledMax`
  (`activities/components/ImageCaptureProcessing.java::moveAndScaleImage` scales only with it).
  Signature and document questions are the same on both platforms (today's pad and picker).

### 16.3 The upload route

`lib/domain/captureFormats.ts` gains:

```ts
export interface CaptureLimits {
	readonly maxBytes: number;
	readonly warnAboveBytes?: number;
	readonly acceptance: "extension-list" | "mime-family";
}
export const CAPTURE_LIMITS: Readonly<Record<Platform, CaptureLimits>> = {
	"web-apps": { maxBytes: 4_000_000, acceptance: "extension-list" },
	android: { maxBytes: 15 * 1_048_576 - 1024, warnAboveBytes: 3001 * 1024 - 1, acceptance: "mime-family" },
};
export const MAX_CAPTURE_BYTES_ON_ANY_PLATFORM = 15 * 1_048_576 - 1024;
```

A file warns when its size is greater than `warnAboveBytes` (3,073,023, so from 3,073,024 bytes, §16.2).
`MAX_CAPTURE_BYTES` is removed in pull request 8, and every reader moves in the same pull request
(`rg -l MAX_CAPTURE_BYTES` at `main`: the two attachment routes below and
`components/preview/form/fields/attachment/AttachmentField.tsx`, which imports it and renders
`Math.floor(MAX_CAPTURE_BYTES / 1_000_000)` in its limit line). The routes take the platform's
`maxBytes`; `AttachmentField.tsx` reads `CAPTURE_LIMITS[platform].maxBytes` for the effective platform
(`usePreviewPlatform()`) in its limit line and sends the upload body below, both in pull request 8, and
pull request 9 adds only its per-platform controls (§16.2).
`MAX_SUBMITTED_CAPTURE_BYTES` becomes `MAX_SUBMITTED_CAPTURE_COUNT * MAX_CAPTURE_BYTES_ON_ANY_PLATFORM`.
A family's default extension (`captureFamilyExtension(kind)`: `.jpg`, `.m4a`, `.mp4`) and the
mime-family check (`captureMimeFamilyFor(kind, contentType)`) join it.

`app/api/apps/[id]/attachments/route.ts`: `requestBodySchema` gains `platform: z.enum(PLATFORMS)` and
`contentType`, the browser's `File.type`, admitted only as a MIME type and subtype or as `""`, which
is what a browser reports for a file it cannot type (`z.union([z.literal(""),
z.string().max(255).regex(/^[a-z]+\/[a-z0-9.+-]+$/i)])`), so nothing else reaches the stored row or the
signed PUT. The route refuses a platform the committed blueprint does not declare
(`declaredPlatforms(snapshot.app.blueprint)`), with 400 `This app doesn't run on that platform. You can
reload the form and try again.`; applies that platform's `maxBytes` (400 `That file is larger than the
{n} MB limit CommCare accepts for one attachment {where}. You can attach a smaller file.`, `{n}` `4` or
`15`, `{where}` `inPlatform(platform)`, so `in Web Apps` or `on Android`, part 01 §2.1); and checks
the file by question kind and platform:
- an image, audio or video question on Android accepts the file when `contentType` is in the kind's
  family (400 otherwise: `A {kind} question accepts {family} files, so you can attach one of those
  instead.`, `{family}` `image`, `audio` or `video`), taking the extension from the filename when it
  is `.` and one to ten lowercase letters or digits, else the family's default, and the content type
  from `contentType` (a `""` is in no family, so it refuses with the same sentence);
- an image, audio or video question on Web Apps, and a signature or file question on both platforms,
  keep today's extension check (`captureExtensionFor`, `CAPTURE_EXTENSIONS_BY_KIND`) and today's
  content type from the extension (`captureContentType`), ignoring `contentType`, the sentence
  becoming `A {kind} question accepts {extensions}, so you can attach one of those instead.`: Android
  draws a signature with today's pad and picks a document with today's picker (§16.2), so neither has
  a capture family to admit.

`app/api/apps/[id]/attachments/[attachmentId]/route.ts`'s backstop compares with
`MAX_CAPTURE_BYTES_ON_ANY_PLATFORM` (the size is already pinned to the admitted one by `stored.size !==
existing.sizeBytes`). The `AttachmentField` upload sends the effective platform and `File.type`.

**Migration.** `lib/case-store/migrations/20261101025000_hq_round_trip_platforms_android_capture_size.ts`
(registered in `migrations/index.ts` as
`"20261101025000_hq_round_trip_platforms_android_capture_size": hqRoundTripPlatformsAndroidCaptureSize`):
`ALTER TABLE form_attachments DROP CONSTRAINT form_attachments_size_check`, then `ADD CONSTRAINT
form_attachments_size_check CHECK (size_bytes > 0 AND size_bytes <= 15727616)`; `down` restores
`<= 4000000`. It is the fourth of the stack's five ledgered migrations, which part 09 §8 registers:
the window applies it inside the fleet transaction with the others, never while the previous
revision serves. Its stamp sorts after pull request 7's `20261101020000_hq_round_trip_platforms_media_format`
and before pull request 13's `20261101030000_hq_round_trip_platforms_media_format_validated`, so the
stack's stamps sort in pull-request order and the window's `migrateTo` targets reach it. It only
widens and depends on no other step 4 migration, so it would be safe under the previous image too;
it rides the window so the ledger moves once.

---

## 17. The logo

`HomeScreen.tsx` draws the logo banner in the running module list only when `rules.logo` is true:
Web Apps keeps today's banner, which stands in for the places Web Apps shows the logo (its app list
tile and its persistent menu header, `cloudcare/utils.py::format_app_doc`, `grid_view/row.html`,
`menu/persistent_menu.html`), since Preview opens inside the app; Android draws none. Edit mode
always draws it. The banner's comment becomes that sentence.
`components/builder/detail/appSettings/AppAppearanceSection.tsx`'s line becomes `Your logo shows in
Preview when it runs as Web Apps. Web Apps shows it once you add it in this app's settings in CommCare
HQ, and Android doesn't show it.` Pull request 11 builds on this sentence (part 07 §2.9): where Web
Apps is declared it keeps the sentence without its Android clause, and the `app-logo` note row
carries the Android difference.

---

## 18. Session context

### 18.1 The device

`lib/preview/engine/previewDevice.ts` (new, client-safe):

```ts
export interface PreviewDevice {
	readonly platform: Platform;
	/** The UUID part of Android's `deviceid`; ignored on Web Apps. */
	readonly androidDeviceId: string;
	/** `window.innerWidth` when the caller built the navigation read, Web Apps only; the session
	 *  context holds it as `String(windowWidth)`. */
	readonly windowWidth?: number;
	/** The worker language's CommCare wire code (`localization.wireCodes`). */
	readonly appLanguage: string;
}
export function previewDeviceInput(value: unknown): PreviewDevice; // zod parse, plain JSON
export function previewDeviceContext(device: PreviewDevice): Partial<Record<SessionContextField, string>>;
/** `window.innerWidth`, or `undefined` where there is no window (the server, a test). */
export function currentWindowWidth(): number | undefined;
/** The device with `windowWidth: currentWindowWidth()` on Web Apps, unchanged on Android. */
export function withNavigationWidth(device: PreviewDevice): PreviewDevice;
```

`previewDeviceInput` refuses, with `Preview sent the device it runs on in a shape it cannot read. It
expects a platform, a device id, a language code and, in Web Apps, a window width. Check the caller
that builds the device from the session store.`, any value other than a plain object with `platform`
one of `PLATFORMS`, `androidDeviceId` a UUID, `appLanguage` a string of 1 to 32 characters, and
`windowWidth` absent or an integer from 1 to 100,000 that is present only on Web Apps.

`usePreviewDevice()` builds it from the effective platform, `previewAndroidDeviceId` and the worker
language's wire code (`effectiveAppLocalization(doc.localization).wireCodes`), with no `windowWidth`:
a width read at render would be the width of the last render, not of the navigation. Each caller that
builds a navigation read (every Server Action call site, and each screen's evaluation when it opens)
passes `withNavigationWidth(device)`, so the width is read at that moment and never stored. Only
`previewDevice.ts` chooses by platform here, as §5.1 allows.

### 18.2 The values

`lib/preview/engine/identity.ts`: `projections` and `ANONYMOUS_SESSION_VALUES` stop writing
`deviceid` and `appversion`; `previewSessionValues(identity, device)` returns the identity's session
values with `previewDeviceContext(device)` merged into `context`. `samePreviewIdentity` is
unchanged: the device is not part of the identity, and a platform change rebuilds through §3.3's
navigation reset.

| Field | Web Apps | Android | Source |
|---|---|---|---|
| `deviceid` | `Formplayer` (`WEB_APPS_DEVICE_ID`) | `commcare_` + `androidDeviceId` | Formplayer `session/FormplayerInstanceInitializer.java::getDeviceId`; Android `utils/DeviceIdentifier.java::getDeviceIdentifier` (`"commcare_" + UUID.randomUUID()`, kept until reinstall) |
| `appversion` | `Formplayer Version: 2.64` (`WEB_APPS_APPVERSION`) | `CommCare Android, version "2.65.0"(). App v. CommCare Version 2.65.0. Build , built on: ` (`androidAppVersion()`) | Formplayer `FormplayerInstanceInitializer.java::getVersionString` over the platform `session/FormSession.java` builds from Core `src/cli/java/org/commcare/util/engine/CommCareConfigEngine.java::MAJOR_VERSION` 2, `MINOR_VERSION` 64. Android `AppUtils.java::getCurrentVersionString`, template `version.id.long` (`CommCare Android, version "${0}"(${1}). App v${5}. CommCare Version ${2}. Build ${3}, built on: ${4}`), `${0}` and `${2}` the pin's `versionName` `2.65` (`app/AndroidManifest.xml`) split into three numbers, `${1}`, `${3}`, `${4}`, `${5}` empty: Preview has no build and no published profile |
| `drift` | `0` | `0` | Formplayer keeps Core's `CommCareInstanceInitializer.java::getCurrentDrift` (`0`); Android's `activities/DriftHelper.java::getCurrentDrift` is whole hours of clock skew at the last response, and Preview's requests carry the browser's clock to Nova's server, so Preview supplies `0` |
| `window_width` | `windowWidth` at the navigation, in record slots (menus, case lists, details, display conditions, search values); in a form, present for the opening pass only (§18.3) | absent | HQ `formplayer/menus/api.js::queryFormplayer` is the only sender (`String(window.innerWidth)`); `form_entry/web_form_session.js::_serverRequest` sends none; Core `session/SessionInstanceBuilder.java::addData` skips a null |
| `applanguage` | `appLanguage` | `appLanguage` | Core `CommCareInstanceInitializer.java::getLocale` (`Localization.getCurrentLocale()`); Web Apps sets it on navigation (`MenuSession` → `SessionUtils.setLocale`). Formplayer's later form requests read the request thread's leftover locale (`LocalizerManager`'s thread-local localizer), which no author can rely on; Preview supplies the worker's language throughout, and the stated difference says it is reliable when a form opens (part 01 §4.2's `app-language` note) |

`WEB_APPS_DEVICE_ID`, `WEB_APPS_APPVERSION`, `ANDROID_DEVICE_ID_PREFIX = "commcare_"`,
`ANDROID_VERSION_NAME = "2.65.0"` and `androidAppVersion()` live in `lib/preview/platform.ts`, each
with its citation. A pin move that changes Core's minor version or Android's `versionName` changes
them; the Formplayer value is held by the lane (§23.4).

### 18.3 `window_width` in form logic

Part 03 §6.2 admits `window_width` only where `SlotProfile.windowWidth` holds (every module slot
and a form's `form_display_condition`) and refuses it in every slot a form evaluates (field slots,
Connect slots, case-operation, form-link and lookup-filter slots) on every declaration, gated on
one native Core run that part 03 §6.4 designs: `proof/native/core/SessionContextRuntimeTest.java`
(part 08 §5.2), whose methods `windowWidthReadOnACachedForm` (arm a, Formplayer's
`services/FormDefinitionService.java::getFormDefWithCache` hit) and `windowWidthReadOnAFreshForm`
(arm b, a fresh parse) run as a hand-started dispatch on pull request 10's branch. Preview follows
both outcomes:

- **Outcome A (arm b throws; expected).** The refusal and the REFUSED entry
  `expressions-and-data/session-context-window-width-in-form-logic` ship. Preview never meets the
  read in a form, and the form engine's session instance holds `window_width` as the device gives it
  at open (a `form_display_condition` reads it before the form opens).
- **Outcome B (arm b reads `''`).** Form-logic reads are admitted with a stated difference, and
  `FormEngine` keeps two session contexts: `openingSession` for its opening pass (defaults,
  start-of-form setvalues, the first full pass) with `window_width`, and `requestSession` without it
  for every later `requestWork`, so a calculate reading it is the width when the form opened and
  blank after the first answer.

Android is absent throughout under both, and the count guard (part 03 §6.3) reads it as `''`.
§23.3 gives the cell rows of each outcome.

### 18.4 `case-list-search-text` (pull request 10)

Part 03 adds the value arm `{ kind: "case-list-search-text" }` (part 03 §5.2), Android only,
admitted where the entry has exactly one case-list step (part 03 §5.3). Its Preview value rides
pull request 10 through the carriers part 03 §5.4 names, which are Preview's session fields:
`lib/session/types.ts::PreviewCaseTarget.caseListSearchText`, which
`components/preview/screens/CaseListScreen.tsx` sets from the quick filter's text
(`components/preview/shared/listFilter.tsx`) when the worker selects a case, and
`lib/preview/engine/entrySessionData.ts::EntrySessionInput.caseListSearchText`, from which
`entrySessionData` writes `data.stringquery` when the text is non-empty and no `stringquery` when the
filter was empty, as Android does (`activities/CommCareActivity.java::saveLastQueryString`). The
arm's guarded print, `if(count(P) > 0, P[1], '')` (part 03 §5.3), reads an absent node as `''`.
`setPreviewPlatform` clears `previewCaseTarget` with the rest of the navigation (§3.3), so no text
crosses a platform change. App Tests and `evaluate_form` type nothing into a list's filter, so they
read it blank (part 03 §5.4). Web Apps never reaches it: part 01's `case-list-search-text` refuses
the arm in every app that declares Web Apps.

### 18.5 The server binds the same values

`resolveAuthorizedPreviewContext` (`lib/preview/engine/previewAuthorization.ts`) gains `device?:
unknown`, parsed by `previewDeviceInput`. A supplied device makes `needsBlueprint` true (most callers
already load it; the device is checked against the same locked snapshot as the persona), and the
context refuses a platform the committed blueprint does not declare with a new arm `{ kind:
"platform-unavailable"; message: PLATFORM_UNAVAILABLE_MESSAGE }`, `PLATFORM_UNAVAILABLE_MESSAGE =
"This app no longer runs on the platform Preview is playing. Choose another in the Runs on menu and
try again."`, and refuses an `appLanguage` that is not one of the blueprint's wire codes with a second
new arm `{ kind: "language-unavailable"; message: PREVIEW_LANGUAGE_UNAVAILABLE_MESSAGE }`,
`PREVIEW_LANGUAGE_UNAVAILABLE_MESSAGE = "This app no longer has the language Preview is showing.
Choose another language and try again."`. Each caller handles the two arms where it handles
`persona-unavailable` today, showing the message.
The `ready` arm gains `device: PreviewDevice`, and every server-side session read calls
`previewSessionValues(identity, device)`. Once §18.2 stops writing `deviceid` and `appversion` into
the identity, a read of `identity.session` itself loses both, so the reads that take it directly move
too. At `main` they are (`rg "identity\.session"` over `lib/preview`):
- `lib/preview/engine/caseDataBindingHelpers.ts::buildCaseOperationProgramFromDoc`, which copies
  `identity.session.context` into the submission program's `sessionContext`, and
  `::buildSubmissionOperationProgram`, which calls it: both gain `device: PreviewDevice` and read
  `previewSessionValues(identity, device)`, so a case operation writing a session-context value writes
  the platform's value;
- their two callers, `caseDataBinding.ts`'s submission (the context's device) and
  `lib/preview/app-tests/submission.ts` (the session's device, §21.4);
- `caseDataBinding.ts`'s three `searchSession` builds that spread `identity.session`
  (`prepareRunningCaseRead`, `loadCaseDataAction` and `loadFilterPreviewAction`);
- `lib/preview/entryPointLaunchAction.ts` (`session: context.identity.session`).

The reads already through `previewSessionValues` (`serverSearchRead.ts`, `postSubmissionEvaluation.ts`,
`searchEvaluation.ts`, and App Tests' `navigation.ts` and `details.ts`) pass the device. The two
`identity.session.context.username` reads (`previewAuthorization.ts`, `lib/preview/app-tests/context.ts`)
read a value the device does not supply and stay. Each client caller of those Server Actions passes `usePreviewDevice()`'s value as plain
JSON (the edge-WAF rule in `lib/preview/CLAUDE.md`, "Case-data Server Action wire shape"). So the SQL
session bindings, the Search session and the form's `commcaresession` cannot answer two ways.

---

## 19. Differences Preview states rather than plays

Preview evaluates these on both platforms with one evaluator, Formplayer's OpenJDK 17 behavior
(`lib/preview/xpath/vendor/`, `generatedJavaRosaFunctions.ts`):
- `regex()` and `replace()`: Web Apps' ASCII classes are played; Android's ICU-backed `java.util.regex`
  (Unicode classes, named groups from API 26) has no executable reader in the lane, so Android's
  cell is stated through `text-pattern`'s note.
- `lower-case()` and `upper-case()`: the server JVM's locale against the device's; stated through
  `case-conversion`'s notes.
- `json-property()`: non-string values read `""` on Web Apps and stringified on Android; stated
  through `json-property`'s notes.

The builder renders those notes where the author works (part 07 §2.8, pull request 11).
`content/docs/building-with-nova.mdx` "Try the app in Preview" gains a subsection `### Preview on Web
Apps and Android` in pull request 9 (§26), which also
states the renderer-only difference of label media (each runtime draws the same image, audio and
video with its own player; Preview draws Nova's player on both).

---

## 20. The engine, the worker and App Tests' runtime

`lib/preview/engine/formEngine.ts::FormEngineRuntimeOptions` gains `readonly device?:
PreviewDevice`; absent means a Web Apps device with a fresh id (`effectivePreviewPlatform([...PLATFORMS],
undefined)`), never "no platform". The engine reads `previewPlatformRules(device.platform)` for
`formScreens`, `recalculation` and `dayNumberEpoch`, and `previewSessionValues(identity, device)`
wherever it reads `previewSessionValues(this.previewIdentity)` today (`formEngine.ts` at its two
reads). `lib/preview/engine/engineController.ts` forwards `device` from `PreviewShell`'s
`usePreviewDevice()`, and a device change (platform, language) rebuilds the entry the way an identity
change does. `lib/preview/hooks/usePreviewScreenForLocation.ts`, `ModuleScreen.tsx`,
`CaseListScreen.tsx`, `HomeScreen.tsx`, `FormScreen.tsx`, `lib/preview/hooks/useSearchCsqlRuntime.ts`
and `lib/preview/engine/xpathInstances.ts` pass the device to `previewSessionValues`.

---

## 21. App Tests

### 21.1 Input

`lib/preview/app-tests/types.ts::appTestStartSchema`: each `sessions[]` item and the top level gain

```ts
platform: z
	.enum(PLATFORMS)
	.optional()
	.describe(
		"Where this session runs: web-apps or android, a platform the saved app runs on. Omit to use Web Apps when the app runs on both, or its only platform.",
	),
```

(top level: `"Where sessions that leave out platform run: web-apps or android, a platform the saved
app runs on. Omit to use Web Apps when the app runs on both, or its only platform."`). A session's
platform is its own, else the top level's, else `effectivePreviewPlatform(declared, undefined)`.

`lib/agent/tools/appTests.ts` `startAppTest`'s description gains, after "…so one worker can keep a form
open while another submits.": `Each session runs on one platform the app runs on, so two sessions can
compare Web Apps and Android.`

### 21.2 State and refusal

`AppTestSessionState` gains `platform: Platform` and `androidDeviceId: string` (minted with
`crypto.randomUUID()` when the session starts). `lib/preview/app-tests/context.ts` gains
`appTestPlatform(snapshot, requested?: Platform): Platform`, beside `appTestLanguage` and called where
`lib/preview/app-tests/service.ts` calls it for each starting session: it resolves the session's
platform (§21.1) and refuses one the saved app does not declare with an `AppTestActionError`, the
class `appTestLanguage`'s refusal throws, whose message is
`platformUnavailableSentence(requested, "a session")` (§5.1): `This app runs only on Android, so a
session can't run in Web Apps. Leave platform out to use Android.` and `This app runs only in Web Apps,
so a session can't run on Android. Leave platform out to use Web Apps.` Server-side journeys have no
window: a session's device is `serverPreviewDevice({ platform, appLanguage, androidDeviceId })` over
the session's own state (§5.1), so a Web Apps
session's `windowWidth` is `APP_TEST_WINDOW_WIDTH` (1280), and every observation's `platform` record
states it.

### 21.3 The device home in a journey

`AppTestScreen` gains `{ kind: "device-home" }`. An Android session starts there; the `home` action
returns there; a submission whose destination is `app_home` lands there (`submission.ts` reads
`previewPlatformRules(state.platform).postSubmitAppHome`), and so does a formless case list's
selection (`formlessCaseListSelection`). Its observation (`run.ts::observeScreen`) is `screen:
"device-home"` with `buttons`: `{ label, available, reason? }` for each button §6.2 shows, with the
same labels and reasons. Offered actions there: `observe`, `identity`, `language`, `sync`, `finish`,
and `continue`, whose control label is `deviceHomeStart` ("Start"); `continue` opens `{ kind: "home"
}` (the module list). No action kind is added, so `continueAppTest`'s schema is unchanged. An
expectation `screen: "home"` is met by both `home` and `device-home`, so the expectation enum is
unchanged too; the observation names which one the session is on.

### 21.4 Everything else per session

`navigation.ts`, `details.ts`, the entry-point launch, `run.ts::postAppTestClaims` (with §10's sync on
Android), `records.ts` (§11) and the form evaluation context read `previewPlatformRules(session.platform)`
and pass the session's `PreviewDevice` (its `appLanguage` from the session's language). Every
observation's header names `platform` beside `language` (`run.ts`): `platform: { selected, label }`.
`components/builder/AppTestHistory.tsx` shows `inPlatform(platform)` with its first letter
capitalized, `In Web Apps` or `On Android`, under the worker line, as part 01 §2.3's sentence frame
capitalizes it.

**Pages.** The form's pages are `formScreens()` (§12.1), each identified by its `path`.
`lib/preview/engine/evaluateForm.ts`'s input (the engine's, not the tool schema of §22) gains
`screenPath?: string`, entered as `sectionUuid` is today: every earlier screen is validated in order
and the walk stops on the first that fails (`evaluateFormSnapshot.ts`, over `enterScreenAsync` and
`validateScreenAsync`). `pageNext` and `pagePrevious` (`run.ts`) find the current screen by
`currentScreenPath()` and evaluate with `screenPath` of the next or previous available screen,
instead of re-entering through a `section` action, and the observation's `pageNavigation` reads the
same list. Per platform:
- **Web Apps** (`formScreens: "one-screen"`): the form is one screen, so `pageNavigation` never offers
  `pageNext` or `pagePrevious`. `section` with a section of the form admits it and changes nothing,
  since the section is already on the one screen, and reports `completed: true`; a uuid that is no
  section of the form refuses as today (`That section is unavailable.`). The observation's `sections`
  lists the form's sections, each `current`.
- **Android**, a sectioned form: today's pages, one per section; `section` and both turns as today.
- **Android**, a form without sections: one page per screen of §12.1. `pageNext` and `pagePrevious`
  turn one screen; `section` has no section to name and refuses as today; `answer` enters each
  answered question's screen, validating earlier screens as a forward turn does.

`continueAppTest`'s schema is unchanged: the page turns carry no address, and `section` keeps its
`sectionUuid`.

### 21.5 The runtime version

`lib/db/appTests.ts::RUNTIME_VERSION` 16 to **17**. `lib/preview/app-tests/CLAUDE.md` gains, after the
version 16 sentence: "Version 17 fences platforms: each session runs on one platform the app declares;
a journey started before it ran Preview's former mix of runtimes."

---

## 22. `evaluate_form`

`lib/agent/tools/evaluateForm.ts::evaluateFormInputSchema` gains

```ts
platform: z
	.enum(PLATFORMS)
	.optional()
	.describe(
		"Where to run the form: web-apps or android, a platform the app runs on. Omit to use Web Apps when the app runs on both, or its only platform.",
	),
```

and the tool description gains, after "Returns validation, question participation and proposed case
values.": `Session values and when calculations re-run follow the platform.`
`lib/agent/authoring/evaluationContext.ts::loadFormEvaluationContext` gains `platform?: Platform`,
resolves the effective platform over the workspace document (`ctx.snapshot.doc`), builds the device
with `serverPreviewDevice({ platform, appLanguage })` (§5.1: a fresh Android id per call,
`APP_TEST_WINDOW_WIDTH` on Web Apps, the requested language's wire code) and refuses an undeclared
platform with a `FormEvaluationInputError` whose message is `platformUnavailableSentence(platform, "the
form")`: `This app runs only on Android, so the form can't run in Web Apps. Leave platform out to use
Android.` (and the mirror sentence). `lib/preview/engine/evaluateForm.ts` passes `device` to the engine
(recalculation, day numbers and screens; it visits the supplied answers, as today). Its `sectionUuid`
follows §21.4's pages: on Android it enters the section, validating earlier sections, as today; on
Web Apps a section of the form is admitted and changes nothing (the whole form is one screen, so no
section is entered and none validated), and an unknown uuid refuses as today. The result's `data`
gains `platform`.

`lib/models.ts::MODEL_CONTEXT_VERSION` becomes `"v5-hq-round-trip-platforms.8"` in pull request 8
(§17 of the decisions). `scripts/test-schema.ts` registers `startAppTest` (its first schema change):
prompt `Use startAppTest with two sessions, "web" on web-apps and "phone" on android, whose purpose
is checking that a registered patient appears in the follow-up list.`; the `evaluateForm` entry's
prompt becomes `Use evaluateForm on the form "Follow-up visit" in the module "Patients" on android
with a scenario holding one patient record whose properties are case_name "Asha" and status
"active".` `lib/mcp/__tests__/servedSchemas.test.ts` runs unchanged (part 10, pull request 8): it pins
no tool's schema, only that every served schema compiles in its dialect and that its patterns are
portable, and the added `platform` enum brings no pattern. The field is proven where it is read:
`platformSessions.test.ts` (the `startAppTest` schema admitting it per session and at the top level)
and `evaluationContext.postgres.test.ts` (each platform and the refusal), §27. In pull
request 14, the stack's docs pull request (§26),
`content/docs/mcp/tools.mdx`'s `start_app_test` and `evaluate_form` rows gain `Each session (or the
check) runs on one platform the app runs on.`

---

## 23. The cell table and its completeness test

### 23.1 What it requires

The required set is every `(entry id, platform)` where the entry's `disposition` is `HELD`, its
`platforms.kind` is `each`, and that platform's reading is neither `runs` nor `not-applicable`, over
the manifest as it stands at the commit. Pull request 1's audit makes HELD everything Nova already
emits (part 02), so the set covers the export's real uses; a later HELD flip forces its row in the
pull request that flips it. A validator refusal discharges an `unavailable` cell: an app that
declares the platform cannot hold the feature, so Preview never plays it.

### 23.2 Files

- `lib/preview/__tests__/platformCells.ts` (data):

  ```ts
  export type PlatformCell =
  	| { readonly kind: "model"; readonly check: PlatformModelCheckId }
  	| { readonly kind: "browser"; readonly scenario: PreviewPlatformScenarioId }
  	| { readonly kind: "refused"; readonly channel: "structural" | "expression"; readonly feature: PlatformFeatureId }
  	| { readonly kind: "refused"; readonly channel: "media" }
  	| { readonly kind: "stated"; readonly feature: PlatformFeatureId }
  	| { readonly kind: "stated"; readonly docs: "content/docs/building-with-nova.mdx#preview-on-web-apps-and-android" }
  	| { readonly kind: "outside-preview"; readonly reason: string };
  export const PLATFORM_CELLS: Readonly<Record<`${string}@${Platform}`, PlatformCell>>;
  ```

- `lib/preview/__tests__/platformCellModels.ts`: `PLATFORM_MODEL_CHECKS: Record<PlatformModelCheckId,
  (platform: Platform) => void | Promise<void>>`, each driving the production model for that platform
  and asserting the observable §23.3 names.
- `e2e/lib/previewPlatformScenarios.ts` (plain TypeScript, importable by Vitest and Playwright,
  `e2e/CLAUDE.md`): `PREVIEW_PLATFORM_SCENARIOS: Record<PreviewPlatformScenarioId, { platform:
  Platform; fixture: string; describe: string }>`, the ids the component-peer spec implements.
- `lib/preview/__tests__/platformCells.test.ts`: loads the manifest through
  `lib/commcare/surface/__tests__/loadManifest.ts`, which pull request 4 extracts from
  `manifest.test.ts::loadManifest` (part 01 §8.1) and this part only imports; asserts the table's
  keys equal the required set exactly, failing on a missing row (`"{entry} reads {reading} on {platform} and the
  cell table has no row for it. Add one to lib/preview/__tests__/platformCells.ts with the evidence
  that shows Preview plays it, or the refusal that keeps it out of an app on that platform."`) and on
  a stale row (`"lib/preview/__tests__/platformCells.ts has a row for {entry} on {platform}, which no
  longer reads differently there or isn't HELD. Remove the row."`); for a structural or expression
  `refused` row, that `PLATFORM_FEATURES[feature]` reads `unavailable` on that platform; for a media
  `refused` row, that the entry names a `media-format:` key; for a `stated` feature row, that the
  feature has a `note` on that platform; for a `stated` docs row, that the MDX file holds the heading
  `### Preview on Web Apps and Android`; for a `browser` row, that the scenario exists and its
  `platform` is the row's; and runs every `model` row's check for its platform.
- `e2e/tests/browser/preview-platforms.spec.ts`: one test per scenario of
  `PREVIEW_PLATFORM_SCENARIOS`, each running its entry of `PREVIEW_PLATFORM_SCENARIO_CHECKS:
  Record<PreviewPlatformScenarioId, (page: Page) => Promise<void>>` (declared in the spec), so `tsc`
  fails on a scenario id with no implementation, and each implementation asserts the observable §23.3
  names for its rows (§25).

### 23.3 The rows

Pull request 9 writes every row whose entry is HELD at pull request 9; the rows marked (10) are
written by pull request 10 with the flips that make their entries HELD. Entry ids below are the
manifest's.

**Refused, structural.**

| Entry | Platform | Feature |
|---|---|---|
| `questions/date-and-time-xsd-datetime` | web-apps | `datetime-question` |
| `case-search/inline-search-true-auto-launch-true-on-a-module-with-visible` | android | `search-first` |
| `case-search/inline-search-default-search-on-a-module-without-visible-inputs` | android | `search-first` |
| `menus-and-case-lists/inline-search-in-a-parent-select-module-hq-adds-xpath-query` | android | `search-first` |
| `menus-and-case-lists/case-list-form-on-a-search-first-host-pointing-at-a-registration` | android | `search-first` |
| `expressions-and-data/search-input-read-in-form-expressions-of-an-inline-search-module` (10) | android | `search-first` (the read is admitted only in a search-first module, which Android refuses) |
| `expressions-and-data/search-input-results-read-in-the-case-list-of-an-inline-search` (10) | android | `search-first` |
| `menus-and-case-lists/detail-multi-select` | android | `several-cases` |
| `menus-and-case-lists/detail-max-select-value-on-a-multi-select-basic-list` | android | `several-cases` |
| `expressions-and-data/selected-cases-search-selected-cases-parent-selected-cases-jr` | android | `several-cases` |
| `case-search/input-date` | android | `search-field-single-date` |
| `case-search/input-select-multi-lookup-itemset` | android | `search-field-multiple-choice` |
| `application-and-settings/connect-app-opened-in-the-connect-app` | web-apps | `connect-app` |
| `application-and-settings/45-hq-auto-gps-capture` | web-apps | `connect-app` (its only use is a Connect app's, which Web Apps refuses) |

**Refused, expression.**

| Entry | Platform | Feature |
|---|---|---|
| `expressions-and-data/here-in-a-case-list-calculated-column-or-sort` | web-apps | `case-list-here` |
| `expressions-and-data/session-data-stringquery` (10) | web-apps | `case-list-search-text` |
| `expressions-and-data/session-context-window-width` (10, outcome A) | android | `window-width` |
| `case-search/runtime-values-read-from-the-session-context-window-width` (10, outcome A) | android | `window-width` |

**The window width under each outcome of the gate** (§18.3; part 03 §6.4 defines the outcomes,
part 01 §4.1 the features). Pull request 10 writes the rows of the outcome the run gives, and only
those.

- **Outcome A** (arm b throws; expected): `window-width` reads runs / unavailable, and both its
  entries read `runs` on Web Apps, so they need no Web Apps row. The two `window-width` rows of the
  table above stand as written. `expressions-and-data/session-context-window-width-in-form-logic` is
  REFUSED, so it is outside the required set.
- **Outcome B** (arm b reads `''`): `window-width` reads different / different and keeps
  `expressions-and-data/session-context-window-width`; part 01 moves
  `case-search/runtime-values-read-from-the-session-context-window-width` into its own feature
  `window-width-in-search`, which reads runs / different; the REFUSED form-logic entry is dropped.
  The two `window-width` rows above are not written, and three `model` rows are:

  | Entry | Platform | Check | Observable |
  |---|---|---|---|
  | `expressions-and-data/session-context-window-width` (10) | web-apps | `window-width-web-apps-form-open` | `FormEngine` with a Web Apps device of width 1024: a calculate reading `window_width` is `1024` after the opening pass and `''` after an answer to an unrelated question (§18.3's `openingSession` and `requestSession`) |
  | `expressions-and-data/session-context-window-width` (10) | android | `window-width-android-blank` | `previewSessionValues(identity, androidDevice).context` holds no `window_width`, and the guarded read `if(count(P) > 0, P, '')` evaluates to `''` in a calculate and in a case list column |
  | `case-search/runtime-values-read-from-the-session-context-window-width` (10) | android | `window-width-android-blank` | as the row above, for a Search field's starting value |

**Refused, media** (part 04's export boundary rule `MEDIA_FORMAT_NOT_PLAYED`, part 04 §6.7, and the
commit kernel's `platform-unplayable`, part 04 §6.2). Two of the entries depend on runs part 04 makes
in pull request 7, which lands before these rows, so pull request 9 writes the set the manifest holds
at its head:
- `expressions-and-data/audio-raw-aac-adts-aac-amr-midi@web-apps` and
  `expressions-and-data/video-hevc-mp4-mpeg-4-part-2-mp4-and-mkv-holding-a-codec-android@web-apps`,
  under every outcome;
- the AVIF gate (part 04 §8.3): when HQ stores the AVIF, `expressions-and-data/image-ico-avif@android`;
  when HQ refuses it, `expressions-and-data/image-ico@android` instead, and the new AVIF entry is
  REFUSED, so it is outside the required set;
- H.264 High (part 04 §8.5, whose question the person answers before pull request 7 is cut, so
  its reading is settled at pull request 9's head): when the person declines the decode run, or
  their run leaves the reading `unavailable`, `expressions-and-data/video-mp4-h-264-high@android`;
  when their run decodes it on all three images, the entry merges into the Baseline-or-Main one,
  which reads `runs` on both, and no High row is written.

**Model.**

| Entry | Platform | Check | Observable |
|---|---|---|---|
| `expressions-and-data/now`, `random`, `uuid`, `sleep`, `today` | web-apps | `recalculation-every-request` | `FormEngine` with a Web Apps device: a calculate over the function and a condition over that calculate re-evaluate after an answer to an unrelated question, and a default reading `now()` does not; on Android neither re-evaluates |
| `expressions-and-data/int`, `double`, `number` | web-apps | `day-number-utc-epoch` | `coreDaysSinceEpoch(days, "utc")` in `Pacific/Kiritimati` is the calendar day less one, in `Asia/Kolkata` the calendar day and in `Etc/GMT+12` one more; `coreFractionalDays(instant, "utc")` is `instant / 86,400,000` in each of those zones; `coreDateAdd` is the same under both epochs; through the evaluator with a Web Apps context, `int(today())` gives the `"utc"` count on the synchronous path, and `if(regex('a', 'a'), int(today()), -1)` gives it on the async path (`evaluateRuntimeAsync`); under `"device-zone"` today's values |
| `expressions-and-data/regex`, `replace` | web-apps | `java-pattern-ascii-classes` | `regex('é', '^\w$')` is false and `replace('a1é', '\w', 'x')` is `xxé` through the evaluator |
| `expressions-and-data/session-context-deviceid`, `session-context-appversion`, `session-context-drift` (10), `session-context-applanguage` (10), `case-search/runtime-values-read-from-the-session-context-drift` (10), `expressions-and-data/commcaresession-jr-instance-session` | web-apps | `session-context-web-apps` | `previewSessionValues(identity, webAppsDevice).context` holds `Formplayer`, `Formplayer Version: 2.64`, `0`, the wire code and the window width; an Android device holds `commcare_<id>`, `androidAppVersion()`, `0`, the wire code and no `window_width` |
| `menus-and-case-lists/session-endpoint-id`, `case-list-session-endpoint-id`, `forms-and-case-writes/session-endpoint-id` | web-apps | `entry-point-web-apps` | `prepareEntryPointLaunch`: a form off the menu refuses unless the entry point ignores display conditions; `claimCaseIds` names each chosen case; a case from the other group is claimed |
| the same three | android | `entry-point-android` | the same launch opens the form off the menu; `claimCaseIds` is empty; a case from the other group is in `blankCaseIds` with empty properties |
| `menus-and-case-lists/module-case-list-on-a-formless-basic-module-show-true` | web-apps | `case-list-menu-item-web-apps` | `formlessCaseListSelection(webApps)` is `{ kind: "root-menu", notice: "formlessReturned" }`; Android's is `device-home` |
| `menus-and-case-lists/detail-case-tile-group-index-identifier-header-rows` | android | `tiles-flat-android` | `splitTileGridByGroupHeader` returns one group per case |
| `menus-and-case-lists/show-border-show-shading` | android | `tile-border-shading-android` | `planTileCell` returns `bordered: false, shaded: false` for a cell that sets both |
| `menus-and-case-lists/horizontal-align-vertical-align` | android | `tile-vertical-align-android` | `planTileCell` gives `middle` `alignSelf: "center"` and `top` and `bottom` the §24.2 value |
| `menus-and-case-lists/7-invisible-search-only-on-the-case-list-outside-a-custom-tile` | web-apps | `hidden-column-searchable` | `rowMatchesFilterText` matches a row by a hidden column's value |
| `menus-and-case-lists/10-markdown-any-property-or-expression` | android | `link-column-raw-android` | `columnDisplay.ts` shows `[text](value)` in a row and a tile cell, and the link in the detail |
| `case-search/required-test-text`, `validations-0-test-text` | android | `search-field-checks-android` | `searchInputConstraintErrors` and `searchInputRequiredMarks` return none for an empty required field with a failing check |
| `case-search/hidden-exclude-with-a-default-value-on-a-prompt-with-no-itemset` | android | `hidden-search-field-android` | the run state's drawn fields include the hidden field holding its default |
| `case-search/the-generated-search-round-trip-remote-request-query-results` | android | `search-android` | `caseListStep` keeps the search step after zero rows; `claimThenSync` is true |
| `case-search/workflow-skip-to-default-results-auto-launch-true-default-search` | android | `skip-to-results-android` | `automaticallyLaunchesSearch` is false for a filter-only search |
| `forms-and-case-writes/post-form-workflow-default` | web-apps | `after-submit-home-web-apps` | the after-submit dispatch for `app_home` lands on the module list |
| `forms-and-case-writes/post-form-workflow-default` | android | `after-submit-home-android` | the same lands on the device home (`previewAtDeviceHome` true) |
| `questions/question-list-unlabelled-when-every-root-field-is-a-section-and` | web-apps | `form-one-screen-web-apps` | `formScreens()` of a sectioned form is one screen |

**Browser** (scenario ids are `PREVIEW_PLATFORM_SCENARIOS` keys).

| Entry | Platform | Scenario |
|---|---|---|
| `questions/gps-geopoint` | web-apps | `location-map-web-apps`: map and address search, no "use my location", answer `40.0 -74.0 0.0 0.0` |
| `questions/barcode-barcode` | web-apps | `barcode-text-web-apps`: a text box, no scan button, submittable |
| `questions/image-capture-upload-image` | web-apps | `image-attach-web-apps` |
| `questions/audio-capture-audio` | web-apps | `audio-attach-web-apps` |
| `questions/video-capture-video` | web-apps | `video-attach-web-apps` |
| `questions/question-list-group-appearance-field-list-labelled` | web-apps | `sections-one-screen-web-apps`: two sections as titled groups on one screen, Submit reveals the first invalid question |
| `questions/groups-nested-in-a-question-list` | web-apps | `sections-one-screen-web-apps` |
| `questions/choice-image`, `questions/choice-audio-video` | web-apps | `choice-media-web-apps`: no choice image, audio or video drawn |
| `questions/help-media` | web-apps | `help-web-apps`: help media only in the dialog, and no help button for media without text |
| `questions/help-text-markdown-form` | web-apps | `help-web-apps` |
| `questions/help-text-markdown-form` | android | `help-android`: the info button, the dialog with OK, a button for media without text |
| `questions/hint-text` | web-apps | `hint-markdown-web-apps` |
| `questions/hint-text` | android | `hint-plain-android`: `**a**` shows its asterisks |
| `questions/validation-message-markdown-form` | web-apps | `validation-plain-web-apps` |
| `questions/validation-message-markdown-form` | android | `validation-plain-android` |
| `questions/choice-label-text-markdown` | web-apps | `choice-label-markdown-web-apps` |
| `questions/choice-label-text-markdown` | android | `choice-label-markdown-android` |
| `questions/group-repeat-label-text-markdown` | web-apps | `group-label-web-apps` |
| `questions/group-repeat-label-text-markdown` | android | `group-label-android`: the `Outer > Inner (2)` line, the add prompt |
| `questions/markdown-form-equal-to-the-default-text` | android | `label-markdown-android`: the §24.1 outcome |
| `case-search/title-label-lang-non-empty`, `description-lang-markdown`, `hint-lang` | android | `search-screen-text-android` |
| `case-search/appearance-barcode-scan` | web-apps | `barcode-search-field-web-apps` |
| `application-and-settings/logo-refs-hq-logo-web-apps` | android | `logo-android`: no banner on the running module list |

**Stated.** `expressions-and-data/json-property@web-apps` and `@android` (`json-property`);
`expressions-and-data/lower-case` and `upper-case`, each `@web-apps` and `@android`
(`case-conversion`); `expressions-and-data/regex@android` and `replace@android` (`text-pattern`);
`questions/label-image-audio-video-same-asset-every-language@web-apps` and `@android` (docs).

**Outside Preview**, each with its reason string:

| Entry | Platform | Reason |
|---|---|---|
| `application-and-settings/translations-lang-code-language-display-names-equal-to-the-label` | web-apps | The language menu is Nova's own control, not the running app's; Web Apps names languages itself. |
| `application-and-settings/profile-feature-checkoff` | web-apps | A profile feature only Android reads; Preview keeps no saved forms on either platform. |
| `application-and-settings/profile-custom-properties-cc-index-case-search-results-equal-to` | android | A profile property Android doesn't read; Preview reads no profile. |
| `application-and-settings/20-properties-cc-show-saved` | web-apps | Web Apps has no saved-forms list; Preview's Android home shows the setting's button. |
| `application-and-settings/21-properties-cc-show-incomplete` | web-apps | Web Apps lists unfinished form sessions from its own store; Preview keeps no unfinished forms. |
| `application-and-settings/1-properties-cc-autoup-freq` and the seeds `4`, `5`, `17`, `18`, `19`, `22`, `25`, `26`, `27`, `28`, `29`, `30` (13 rows) | web-apps | A profile property only Android reads; Preview reads no profile property. |
| `forms-and-case-writes/usercase-datum-usercase-id-assertion-case-autoload-usercase-case` | web-apps, android | Preview always holds the worker's own record, so the assertion never fails in Preview. |
| `menus-and-case-lists/19p-enum-image-whose-keys-are-conditions-contain-any-of-each-a` | android | It differs only in an icon-text-grid tile, which Nova never writes. |
| `menus-and-case-lists/enum-mappingitem-alt-text-lang` | android | Nova writes blank alt text, which no runtime shows. |
| `questions/hq-generated-pollsensor` | web-apps | The location poll fills the submission's meta location, which Preview does not write; a Connect app's use of it is refused in Web Apps. |
| `questions/hq-generated-meta-deviceid-timestart-timeend-username-userid` | web-apps | The runtime writes the submission's meta block, which Preview does not write; authored reads of these values go through the session context. |
| `questions/h-title-and-data-name-whatever-their-text` | web-apps | A saved form's name on Android's saved list; Preview keeps no saved forms. |
| `questions/plain-label-containing-html-text` | web-apps, android | Nova writes a markdown form for every label, so a label without one never reaches a runtime. |

**Ambient entries with no row.** Three of part 01's ambient entries (part 01 §4.3) differ by
platform yet need no row, read in `lib/commcare/surface/entries/*.json` at `e9e6cd93` and untouched
by part 02's audit: `application-and-settings/hq-default-app-strings`,
`case-search/auto-launch-false-in-an-app-with-cloudcare-enabled-false` and
`expressions-and-data/lookup-table-rows-in-the-local-archive-suite` each read `not-applicable` on
Web Apps and `runs` on Android, so neither cell is in §23.1's required set, and a row for either
would fail the completeness test as stale. A later reading change that makes one of these cells
differ forces its row in the pull request that changes it.

### 23.4 The Formplayer value of `appversion` in the lane

`WEB_APPS_APPVERSION` is a pin fact no Vitest test can read. Pull request 10's
`targeted-session-context-reads` (part 08 §4.4, the owner of the document) holds hidden values
reading `session/context/appversion` and `session/context/deviceid` in a form of the document, which
is declared Web Apps only. Its spec writes the file `formplayer-session.json` holding
`WEB_APPS_APPVERSION` and `WEB_APPS_DEVICE_ID` (imported from `lib/preview/platform.ts`), and
`proof/checks/intent.py::formplayer_session_values` holds each Formplayer submission of that form to
them wherever a record holds Formplayer's walk, so a pin move that changes Formplayer's value fails
the nightly's intent check until the constant moves. This part owns the two constants and their
citations (§18.2); part 08 owns the document and its intent.

---

## 24. Lane observations before copy lands

Each runs on GitHub's runners, never on the person's machine: the PR 9 branch dispatches
`.github/workflows/proof-audit.yml` with `nightly` unticked, `slice` naming the test and
`slice_readers` `android`; part 08 §6.3's by-hand run table holds these runs as its pull request 9
row. All three read `targeted-preview-android-renders` (new in pull request 9,
`proof/targeted/documents/previewAndroidRenders.ts`, declared Android only). Part 08 §4 registers it
beside the other targeted documents and counts it as step 4's sixth new targeted document, so the
corpus census at step 4's exit is 398: 326 on both platforms, 40 Web Apps only and 32 Android only
(part 08 §3.1). Its header comment states what each form shows, which is what the three tests read:
- a survey **Text** with a label question labeled `a` newline `b ![x](y) <b>c</b>`;
- a module **Visits** over case type `visit` with a custom tile of three cells, vertical alignment
  `top`, `middle` and `bottom` (`tileCell(…, { verticalAlign })`);
- a follow-up form **Update visit** in **Visits** that updates `visit`'s property `status` from a
  text question (a primary update, so §8.3's `formChangesSessionCase` is true for it), with an entry
  point `update_visit`.

### 24.1 Markwon's label rendering

Test `proof/android/test_form_reads.py::test_a_markdown_label_renders_as_markwon_renders_it`: opens
**Text** and reads the label's `TextView` text (`proof/android/src/nova/proof/android/Views.java`
records `text`).
- **Outcome A** (the text is `a b x c`: the newline read as a space, the image as its alt text, the
  tag removed and its content kept): `labelMarkdown` on Android is `{ singleNewline: "space", html:
  "dropped", images: "alt-text" }`; the `label-markdown-android` scenario asserts that text.
- **Outcome B** (any other text: a line break between `a` and `b`, `<b>c</b>` shown as written, or
  something other than `x` where the image stands): each field takes the value the text shows
  (`"break"` for a line break, `"literal"` for the written tag, `"shown"` when the image is drawn and
  its alt text absent), and the scenario asserts the observed text.
The test lands with the reader's observed text as its assertion, so it holds at every pin move.

### 24.2 Android tile alignment

Test `proof/android/test_case_lists.py::test_a_tile_cell_takes_only_middle_vertical_alignment`: opens
**Visits** with one case and reads each tile cell's `gravity` (`Views.java` records it).
- **Outcome A** (`top` and `bottom` cells both read `TOP`): `tileVerticalAlign` Android stays
  `"middle-only"` with `top` and `bottom` drawn at the top (`alignSelf: "start"`).
- **Outcome B** (`bottom` reads `BOTTOM`): `computeGravity`'s reading in §5.2 is wrong; `bottom` draws
  at the bottom (`alignSelf: "end"`), and the manifest entry's Android note is corrected in the same
  pull request.

### 24.3 Submitting a form opened for a case the phone lacks

Test `proof/android/test_navigation.py::test_an_entry_point_to_a_case_the_phone_lacks_opens_blank_and_its_completion_is_read`:
launches `update_visit` with `arguments` naming a case id no case in the project space holds and
`"complete": true`, then reads the opened form's preloaded `status` (blank), the notification
Android posted, and whether the device sent a submission (`Posts.java`).
- **Outcome A** (no submission sent, the "Problem with your App" notification): pull request 9 lands
  §8.3's outcome A as written.
- **Outcome B** (a submission sent): pull request 9 lands §8.3's outcome B.
In both, the test asserts the observed outcome, so a change in Android's behavior fails the lane.

---

## 25. Playwright

All browser behavior is proven in Playwright; no React Testing Library test is added (`e2e/CLAUDE.md`).

**Browser lane** (component peers in Chromium, no Nova server, no Postgres; each spec beside a
`e2e/lib/*-client.tsx` peer, as `preview-geopoint-audit.spec.ts` is):
- `e2e/tests/browser/preview-platforms.spec.ts` with `e2e/lib/preview-platforms-client.tsx`: one test
  per `PREVIEW_PLATFORM_SCENARIOS` entry, iterated from the registry and running that id's function in
  the spec's `PREVIEW_PLATFORM_SCENARIO_CHECKS` record (§23.2), each mounting the production
  component over an admitted fixture document (`admittedControllerDoc`) with a `PreviewDevice` for the
  scenario's platform, and the Android stand-ins beyond the cell table: `location-record-android`
  (geolocation granted through `context.grantPermissions` and `context.setGeolocation` with accuracy
  4: the answer `40.0 -74.0 0.0 4.0`; with accuracy 40, the accept button only after the line shows;
  Cancel's toast), `capture-android` (Take picture and Choose image inputs carry
  `capture="environment"` and `accept="image/*"`; a 16 MB file refused with its line; a file of
  3,073,024 bytes attached with the large-file line and one of 3,073,023 bytes without it),
  `barcode-scan-android`, `form-screens-android` (one question per screen outside groups, a labeled
  group one screen of all its questions, an unlabeled group's questions one screen each, a labeled
  group inside a repeat one screen per entry, Next validates, Finish on the last, the repeat prompt's
  three actions and its two add wordings, and no prompt or add control for a user repeat inside a
  labeled group).
- `e2e/tests/browser/preview-device-home.spec.ts` with `e2e/lib/preview-device-home-client.tsx`: the
  buttons per `showSavedForms` / `showIncompleteForms`, each disabled reason readable through
  `aria-describedby`, Start opens the module list, Sync with server's sub-line changes.
- `e2e/tests/browser/preview-identity-menu.spec.ts` with `e2e/lib/preview-identity-menu-client.tsx`:
  the Runs on group's two items and lines, an Android-only app's disabled Web Apps item with its
  reason, choosing Android returns to app entry, the trigger's accessible name.

**App lane** (the production standalone server and a fresh database per job):
- `e2e/tests/app/preview-platform-switch.spec.ts`, `@seed:sections` (a fixture running on both with a
  sectioned form, `e2e/lib/formSectionsSeed.ts`): the default is Web Apps and the sectioned form is
  one screen; switching to Android in the identity menu returns to the device home, Start, and the
  form pages per section; switching back keeps the worker's claims.
- `e2e/tests/app/builder-layout-audit.spec.ts` (extend its `@seed:open` test): at 320px while
  previewing, the header's center cluster fits between the mark and the account control on one row,
  and the identity trigger's icon is the platform glyph.
- `e2e/tests/app/preview-here-column.spec.ts` (`@seed:here-column`; the fixture declares Android only
  from pull request 4): each expected column text gains Android's altitude and accuracy (`40.0 -74.0
  0.0 4.0` with `setGeolocation({ latitude: 40, longitude: -74, accuracy: 4 })`).
- `e2e/tests/app/app-tests.spec.ts` (extend): the history shows each session's platform.

**Existing specs under the platform Preview now plays.** Two changes reach specs written against
today's mix of runtimes: a document that runs on both now previews as Web Apps (one screen per form,
no "use my location", §14.1's spelling), and from pull request 4 `buildDoc` declares Android only for
a seed holding a date-and-time question (part 01 §11.3), which Preview then plays as Android. Each
spec takes one of two outcomes. Where its subject is not the date-and-time question, the seed's
date-and-time question becomes a date question in pull request 4, in the same change as part 01
§11.3's seed edits, so the seed stays on both platforms and the spec keeps Web Apps. Where its subject
is the date-and-time question, the seed declares Android only and the spec is rewritten to Android's
screens. A spec whose subject is Android's paging or Android's location runs as Android: its peer
mounts with an Android `PreviewDevice`, or the test chooses Android under Runs on.
- `e2e/tests/browser/preview-repeats-audit.spec.ts` (seed `e2e/lib/preview-repeats-client.tsx`'s
  `languageDoc`, the date-and-time `recorded_at` starting at `'2024-01-15T14:30:00.000-05:00'`): the
  question is its first test's subject. That test reads the stored value's clock (`2:30 PM` in
  `America/New_York`, a zone designator shown rather than blanked) and types partial clocks into the
  time half (`2:3`, `2:4`) across language switches. `languageDoc` therefore keeps the question and
  is declared Android only by `buildDoc` from pull request 4, with no edit there. Pull request 8
  moves the test's values: the expected `/data/visit/location` becomes `40.0 -74.0 0.0 0.0` (§14.1),
  while the location question still draws the manual coordinates the test fills, since Record
  location is pull request 9's. Pull request 9 rewrites it to Android's screens: the peer mounts the
  `?language` journey with an Android
  `PreviewDevice`; the labeled group `Visit details` is one screen (§12.1); the location is answered
  through Record location under `context.grantPermissions(["geolocation"])` and
  `context.setGeolocation`, in place of the manual coordinates and the map's notice; and the clock
  checks stand on that screen. The client's other documents hold no date-and-time question, and the
  spec's other tests keep Web Apps unchanged.
- `e2e/tests/browser/preview-language-screen.spec.ts` (seed `e2e/lib/preview-language-screen-doc.ts`):
  the date-and-time question is part of its subject (its tests hold a half-typed clock, `2:4` in
  `Visit time`, across a language change and a section unwrap). The seed already declares Android only
  through `buildDoc`. Pull request 8 moves its values: each expected `location` becomes `40.0 -74.0
  0.0 0.0` (§14.1), while the location question still draws the manual coordinates the test fills,
  since Record location is pull request 9's. Pull request 9 rewrites the spec to Android's screens,
  its peer mounting an Android `PreviewDevice`: the section is one screen (today's pager) and the
  last button reads Finish; the location is answered through Record
  location under `context.grantPermissions(["geolocation"])` and `context.setGeolocation`, and the
  retained node it checks is that button in place of the manual latitude field; the image is chosen
  through Choose image; after the section unwrap the form pages per screen of §12.1, and the
  retained-control checks read the screen they are on. Web Apps' manual coordinates stay proven by
  `preview-form-lifecycle-audit.spec.ts`'s "Submit commits the coordinate and clock currently being
  edited", which keeps Web Apps (below).
- `e2e/lib/caseWorkspaceSeed.ts` (the tile form's `visit_started`), read by
  `e2e/tests/app/preload-arrival.spec.ts`, `inspector-resize.spec.ts`, `builder-layout-audit.spec.ts`
  and `authed.spec.ts`: only one test's subject is the date-and-time question, and moving the shared
  seed to Android would put every case list, tile and search screen of those specs on Android's
  rules, which none of them is about. Pull request 4 makes `visit_started` a date question, and the
  seeded rows write `row.lastVisit` for it in place of `${row.lastVisit}T${SEEDED_VISIT_START}`, so
  the seed stays on both and the specs keep Web Apps. `authed.spec.ts`'s "temporal questions show
  their stored answers, hold their row geometry, and refuse a half-typed clock" keeps its geometry,
  preload and half-typed clock checks over the date question and the time question `next_dose` (its
  clock steps then read `next_dose`'s); its date-and-time clock reading
  (`SEEDED_TEMPORAL_DISPLAY.visitStartedTime`) leaves, and `SEEDED_TEMPORAL_DISPLAY` keeps `nextDose`
  only. The case it held, a stored date-and-time answer whose zone designator is shown rather than
  blanked, is held by the Android-only `preview-repeats-audit.spec.ts` above, whose question starts
  from such a value.
- `e2e/tests/app/authed.spec.ts` "a sectioned form pages in Preview on the device's rules"
  (`@seed:sections`, a seed running on both): pull request 9 has it choose Android under Runs on
  after entering Preview; its stepper, Next and Back checks stand, and the last page's button reads
  Finish where it read Submit. The Web Apps default over the same seed is
  `preview-platform-switch.spec.ts`'s.
- `e2e/tests/browser/preview-section-paging-lifecycle.spec.ts` and the paging tests of
  `preview-form-lifecycle-audit.spec.ts` ("page entry initializes dependent repeat rows and Back
  preserves their answers", "an earlier-page count grows repeats and lowering it retains answers",
  and the sectioned half of "worker language localizes Next validation refusal"): pull request 8
  gives their peers an Android `PreviewDevice`; their checks stand, with Finish where they read the
  last page's Submit. The unsectioned half and the other tests keep Web Apps, and one of them changes
  a value in pull request 8: "Submit commits the coordinate and clock currently being edited" enters
  manual coordinates, so its submitted `place` takes §14.1's spelling, `40.0 -74.0 0.0 0.0` where it
  read `40 -74 0 0`.
- `e2e/tests/browser/preview-geopoint-audit.spec.ts` ("native location ignores an old delivery after
  refresh and accepts a fresh browser location") and `preview-geopoint-language.spec.ts` (both its
  tests): their subject is the browser's own location, which only Android's Record location reads from
  step 4. Pull request 9 rewrites them to Android with an Android `PreviewDevice`: the stale-delivery
  test reads the Record location dialog's accepted fix (`watchPosition`) where it read "use my
  location", and the language tests read the `recordLocation`, `findingLocation` and
  `locationAccuracy` messages in Spanish where they read `My location` / `Tu ubicación` and the map's
  wait. The audit's two Places tests (the address search) keep Web Apps unchanged.

`config/smoke-execution.json` keeps its job and worker counts; `scripts/ci/smoke-matrix.mjs` places
the new tests by `e2e/smoke-timings.json`, where new tests take the conservative estimate.

---

## 26. Docs that move

Subtree docs and comments move in the pull request that changes the behavior they describe.

- `CLAUDE.md` (8): mental model 5 keeps its sentence and adds "It plays one platform the app runs on
  at a time, Web Apps or Android." (part 10, "CLAUDE.md (root)").
- `lib/preview/CLAUDE.md` (8): a new section **Platforms** after the intro: `platform.ts` is the
  one rule table, `effectivePreviewPlatform`, the device as an engine input, the session values of
  §18; the paragraph "Preview plays one runtime per behavior until it plays each platform" is replaced
  by §7 and §8's rules; "First-class date type" gains the day-number epoch (§12.3); the `here()`
  paragraph gains Android's spelling; "Case tiles in the running app" gains Android's flat list,
  borders and alignment; "Resolved preview identity" gains "the device is a separate input, merged by
  `previewSessionValues(identity, device)`"; "Entry-point launch" per §8; the formless case list.
- `lib/preview/CLAUDE.md` (9): "Sections page the preview on Android's rules" becomes "Form screens
  per platform" (§12.1), and its paragraph's closing sentences, "Default Web Apps shows the same form
  as titled groups on one page; the preview follows the device and the docs say so. A form with no
  sections is untouched.", become "Running as Web Apps, Preview shows the same form as titled groups
  on one page, as Web Apps does. Running as Android, a form with no sections pages one screen per
  labeled group and per question outside one."
- `lib/session/CLAUDE.md` (8): the four fields of §3.1 and their lifetimes (§3.2).
- `lib/preview/app-tests/CLAUDE.md` (8): §21, and the version 17 sentence.
- `components/builder/CLAUDE.md` (9): the identity menu's Runs on group and the 320px sentence (§4);
  the formless case list sentence (§9); the flipbook sentence (§13).
- `lib/domain/CLAUDE.md` (8): `captureFormats.ts`'s limits per platform, in the pull request that
  adds `CAPTURE_LIMITS`.
- Comments: `AttachmentField.tsx` ("it is what CommCare Web Apps shows" becomes the per-platform
  sentence), `MediaField.tsx` (barcode), `FieldHelp.tsx` (the mode branch), `DateField.tsx` (no
  change of behavior; the "both" stamping sentence stays), `useSectionPaging.ts` (renamed),
  `HomeScreen.tsx` (logo).
Public docs ride pull request 14, the stack's docs pull request, with one recorded exception: the
`### Preview on Web Apps and Android` subsection lands in pull request 9, because the cell table's
`stated` docs rows and their completeness check read that heading at pull request 9's head (§23.2).
Each paragraph has one owner: the edits below are this part's, and the two paragraphs other parts
also change are written once, in part 07 §5's pull request 14 list.

- Public docs (9): `content/docs/building-with-nova.mdx` "Try the app in Preview" gains `### Preview on
  Web Apps and Android`: "Preview runs your app the way Web Apps does, or the way the CommCare app on
  Android does. For an app that runs on both, Preview starts as Web Apps; you can switch in the
  Running as menu at the top, under Runs on. Switching starts the app again from its first screen and
  keeps the cases the worker claimed. On Android, Preview shows the phone's home screen, pages a form
  one section at a time, or one labeled group or question at a time when it has no sections, and uses your
  browser's camera, microphone and
  location in place of the phone's. A few differences Preview can't play: regular expressions and
  upper and lower case follow Web Apps' rules on both, and each runtime draws images, sound and video
  with its own player. The builder notes each one where you set it up."
- Public docs (14): `content/docs/form-sections.mdx` "## In Preview": "Preview runs the form the way a phone does"
  becomes "In Web Apps, every section shows on one page as a titled group. When Preview runs as
  Android, it runs the form the way a phone does:" followed by today's list.
  `content/docs/form-links.mdx`: "Preview follows Android here and opens the destination" becomes
  "Preview does what the platform it runs as does: Android opens the destination, and Web Apps opens
  what the destination's menu shows."
  `content/docs/deep-links.mdx` "Try it in Preview": "Preview does not claim or sync cases from
  CommCare HQ" becomes "In Web Apps, opening an entry point claims the cases it names, as Web Apps
  does. On Android it claims nothing, and you can choose a case the worker's phone doesn't have to
  see the form open without its saved values."
  `content/docs/case-workspace.mdx`: "In Preview, barcode search fields accept typed codes and camera
  scans" becomes "In Preview, barcode search fields accept camera scans when it runs as Android, and
  typed codes on both"; "Required fields and checks are enforced in the browser app" gains "Preview
  checks them when it runs as Web Apps."
  `content/docs/users-and-personas.mdx` "Preview as a persona": "The same menu's Runs on group
  chooses whether Preview runs as Web Apps or Android."
  `content/docs/mcp/tools.mdx`: the `start_app_test` and `evaluate_form` rows (§22).
- Merged into part 07 §5's pull request 14 edits, not written separately here: the `here()`
  paragraph of `content/docs/case-workspace.mdx` (part 03 §3.2 also changes it), whose Preview
  sentence must carry Android's four-part value (`lat lon alt acc`, §11); and the Preview sentences
  of `content/docs/attachments.mdx` (part 07 rewrites its opening), which must carry Android's take,
  record and choose controls (§16.2) and the 15 MB limit (`CAPTURE_LIMITS.android`, §16.3).

---

## 27. Files by pull request

**Pull request 4** carries §25's seed edits with part 01 §11.3's (part 10's pull request 4 list):
`e2e/lib/caseWorkspaceSeed.ts` turns `visit_started` into a date question, with
`e2e/tests/app/authed.spec.ts`'s temporal test and `SEEDED_TEMPORAL_DISPLAY` following;
`e2e/lib/preview-repeats-client.tsx`'s `languageDoc` and `e2e/lib/preview-language-screen-doc.ts`
keep their date-and-time question and are declared Android only by `buildDoc`, with no edit, and
their specs move in pull requests 8 and 9.

**Pull request 8, Preview, the model.**
- New: `lib/preview/platform.ts`, `lib/preview/engine/previewDevice.ts`,
  `lib/preview/formlessCaseListRoute.ts`,
  `lib/case-store/migrations/20261101025000_hq_round_trip_platforms_android_capture_size.ts`.
- Changed: `lib/session/store.ts`, `hooks.tsx`; `lib/preview/engine/identity.ts`, `formEngine.ts`,
  `triggerDag.ts`, `previewAuthorization.ts`, `geopointValue.ts`, `runtimeBindings.ts`,
  `viewerLocation.ts`, `searchInputConstraints.ts`, `evaluateForm.ts`, `evaluateFormSnapshot.ts`,
  `engineController.ts`, `serverSearchRead.ts`, `postSubmissionEvaluation.ts`, `searchEvaluation.ts`,
  `caseDataBinding.ts`, `caseDataBindingHelpers.ts` (`readCases`'s `tileGrouping`, the device in the
  submission program), `xpathInstances.ts`, `sectionPaging.ts`; `lib/preview/xpath/coreDays.ts`,
  `coerce.ts`, `evaluator.ts`, `asyncEvaluator.ts`, `operatorSemantics.ts`, `functions.ts`,
  `scalarJavaRosaFunctions.ts`, `nodeSetJavaRosaFunctions.ts`, `types.ts`, `workerProtocol.ts`
  (protocol 9) and the worker runtime that builds its `EvalContext`;
  `lib/preview/afterSubmitRouting.ts`, `entryPointLaunch.ts`, `entryPointLaunchAction.ts`,
  `caseListPhase.ts`, `caseTileRendering.ts`, `caseTileGrouping.ts`, `columnDisplay.ts`,
  `runtimeMessages.ts` (every key of §6 to §16, English and Spanish, except §8.3's two, which pull
  request 9 adds under outcome A), `hooks/useSearchCsqlRuntime.ts`,
  `hooks/usePreviewScreenForLocation.ts`, `hooks/useSearchInputRunState.ts`, `hooks/useSectionPages.ts`
  (renamed `useFormScreens.ts`);
  `lib/session/viewerPosition.ts`; `lib/routing/previewBreadcrumbs.ts`; `lib/domain/captureFormats.ts`;
  `app/api/apps/[id]/attachments/route.ts`, `[attachmentId]/route.ts`;
  `lib/case-store/store.ts`, `lib/case-store/postgres/store.ts` (`SearchPopulation.onlyOutsideRestore`,
  §8.2), `lib/case-store/postgres/submissionAttachments.ts`, `lib/case-store/migrations/index.ts`;
  `lib/preview/app-tests/types.ts`, `context.ts`, `run.ts`, `submission.ts`, `navigation.ts`,
  `details.ts`, `records.ts`, `service.ts`; `lib/db/appTests.ts`; `lib/agent/tools/appTests.ts`,
  `evaluateForm.ts`; `lib/agent/authoring/evaluationContext.ts`; `lib/models.ts`;
  `scripts/test-schema.ts`; `components/preview/screens/FormScreen.tsx`, `CaseListScreen.tsx`,
  `ModuleScreen.tsx` (routing and session reads only), `components/preview/PreviewShell.tsx`,
  `components/preview/form/fields/attachment/AttachmentField.tsx` (the limit line's
  `CAPTURE_LIMITS` read and the upload body, §16.3), `components/builder/BreadcrumbStrip.tsx`,
  `usePreviewModeTransition.ts`, `BuilderLayout.tsx`, `BuilderHeader.tsx`, `PreviewToggle.tsx`,
  `useBuilderShortcuts.ts` (§3.1's `atHome` through the setter's type),
  `components/preview/EntryPointPreviewLaunch.tsx` (the second group); `CLAUDE.md`,
  `lib/preview/CLAUDE.md`, `lib/session/CLAUDE.md`, `lib/preview/app-tests/CLAUDE.md`,
  `lib/domain/CLAUDE.md`.
- Specs and peers (§25): `e2e/tests/browser/preview-repeats-audit.spec.ts` (its first test's expected
  location spelling), `preview-language-screen.spec.ts` (its expected location spelling),
  `preview-section-paging-lifecycle.spec.ts` with
  `e2e/lib/preview-section-paging-client.tsx`, and `preview-form-lifecycle-audit.spec.ts` with
  `e2e/lib/preview-form-lifecycle-client.tsx` (an Android device for the paging tests, and the
  coordinate test's submitted `place`).

**Pull request 9, Preview, the screens.**
- New: `components/preview/screens/DeviceHomeScreen.tsx`,
  `components/preview/form/fields/geopoint/RecordLocationField.tsx`,
  `components/preview/form/fields/attachment/AudioRecorder.tsx`,
  `components/preview/form/fields/BarcodeField.tsx`, `components/preview/shared/BarcodeScanner.tsx`,
  `components/preview/form/RepeatAddPrompt.tsx`, `lib/preview/__tests__/platformCells.ts`,
  `platformCellModels.ts`, `platformCells.test.ts`, `platformRuleReaders.test.ts`,
  `e2e/lib/previewPlatformScenarios.ts`,
  `e2e/lib/preview-platforms-client.tsx`, `preview-device-home-client.tsx`,
  `preview-identity-menu-client.tsx`, `e2e/tests/browser/preview-platforms.spec.ts`,
  `preview-device-home.spec.ts`, `preview-identity-menu.spec.ts`,
  `e2e/tests/app/preview-platform-switch.spec.ts`,
  `proof/targeted/documents/previewAndroidRenders.ts` and its three Android reader tests (§24).
- Changed: `components/builder/PreviewIdentityMenu.tsx`, `AppTestHistory.tsx`,
  `detail/appSettings/AppAppearanceSection.tsx`; `components/preview/screens/HomeScreen.tsx`;
  `components/preview/shared/SearchInputForm.tsx`, `CaseTile.tsx`, `CaseTileGroup.tsx`;
  `components/preview/form/FieldRenderer.tsx`, `FieldHelp.tsx`, `InteractiveFormRenderer.tsx`,
  `fields/SelectOneField.tsx`, `fields/SelectMultiField.tsx`, `fields/RepeatField.tsx`,
  `fields/GroupField.tsx`, `fields/ValidationError.tsx`, `fields/MediaField.tsx`,
  `fields/geopoint/GeopointPicker.tsx`, `fields/attachment/AttachmentField.tsx` (the per-platform
  controls of §16.2 only), `sections/useSectionPaging.ts` (renamed `useFormPaging.ts`);
  `lib/markdown.tsx`; `e2e/tests/app/builder-layout-audit.spec.ts`, `preview-here-column.spec.ts`,
  `app-tests.spec.ts`, `authed.spec.ts` (the sectioned-form test chooses Android);
  `e2e/tests/browser/preview-language-screen.spec.ts` with `e2e/lib/preview-language-screen-client.tsx`
  and `preview-repeats-audit.spec.ts`'s first test with `e2e/lib/preview-repeats-client.tsx` (each
  rewritten to Android's screens, its peer mounting an Android `PreviewDevice`),
  `preview-geopoint-audit.spec.ts`, `preview-geopoint-language.spec.ts` with
  `e2e/lib/preview-geopoint-client.tsx` (Record location, §25);
  `components/builder/CLAUDE.md`, `lib/preview/CLAUDE.md`;
  `content/docs/building-with-nova.mdx` (the `### Preview on Web Apps and Android` subsection only,
  §26).
- Under §24.3's outcome A only: new `lib/preview/unheldCaseSubmit.ts` and
  `lib/preview/__tests__/unheldCaseSubmit.test.ts`; changed `components/preview/screens/FormScreen.tsx`,
  `lib/preview/app-tests/submission.ts` (the reader) and `lib/preview/runtimeMessages.ts`
  (`formNotProcessedTitle`, `formNotProcessedDetail`). Under outcome B: `lib/preview/platform.ts`
  (`entryPointUnheldCaseSubmit` `"submits"` on Android).
- Read from pull request 4: `lib/commcare/surface/__tests__/loadManifest.ts` (part 01 §8.1), which
  the cell table's test imports.

**Pull request 10** writes the rows marked (10) in §23.3 and, under the gate's outcome B, §23.3's
three window-width `model` rows with their checks in `platformCellModels.ts` and §18.3's two session
contexts in `formEngine.ts`. §18.4's carriers are part 03 §5.4's, and the two reads of §23.4 are in
part 08 §4.4's `targeted-session-context-reads`.

**Pull request 14**, the stack's docs pull request: §26's public docs other than the pull request 9
subsection: `content/docs/form-sections.mdx`, `form-links.mdx`, `deep-links.mdx`, `case-workspace.mdx`
(its barcode and required-field sentences), `users-and-personas.mdx`, `content/docs/mcp/tools.mdx`
(the two rows of §22); and this part's sentences in the merged `case-workspace.mdx` `here()` and
`attachments.mdx` edits that part 07 §5 writes.

### Tests by pull request

Pull request 8 (Vitest; Postgres only where named):
- `lib/preview/__tests__/platform.test.ts`: `effectivePreviewPlatform` over the three declarations and
  the three choices (nine cases); a platform no longer declared derives to the other.
- `lib/session/__tests__/previewPlatform.test.ts`: §3.2's table through the store's own actions,
  `setPreviewing(true, { atHome: true })` and `{ atHome: false }` and an absent `at` on an Android-only
  and a both-platform document (the store reading the declaration through `docStoreRef`);
  `setPreviewPlatform` clears the navigation fields, keeps `previewClaims`, sets the device-home
  flag on Android; `installEntryPointLaunch(launch, claimCaseIds)` with a launch persona other than
  the current one keeps the claims under the launch's worker, and with the same persona adds them to
  that worker's existing claims.
- `lib/preview/engine/__tests__/identity.test.ts` (extend): `previewSessionValues(identity, device)`
  for both platforms; `samePreviewIdentity` ignores the device.
- `lib/preview/engine/__tests__/previewDevice.test.ts`: `previewDeviceInput` admits each platform's
  shape and refuses a width on Android, a non-UUID id, a non-object, each with the sentence.
- `lib/preview/engine/__tests__/previewAuthorizationPlatform.postgres.test.ts`: a committed
  Android-only app refuses a Web Apps device with `platform-unavailable` and admits an Android one;
  the ready context carries the device.
- `lib/preview/engine/__tests__/formEnginePlatformRecalculation.test.ts`: §23.3's
  `recalculation-every-request` observable, sync and worker-backed paths, plus a repeat insert's
  starting value firing only on its insert.
- `lib/preview/engine/__tests__/formEngineSections.test.ts` (extend): `formScreens()` on Web Apps is
  one screen; on Android a sectioned form is one per section, and in an unsectioned form a labeled
  group is one screen of all its questions (nested groups included), a labeled group inside a repeat
  one screen per entry, an unlabeled group's questions one screen each, and every other question one
  screen, skipping irrelevant ones and expanding repeat entries; a user repeat inside a labeled group
  offers no add prompt; each screen's `path` is distinct across repeat entries.
- `formEngine.test.ts`, `engineControllerSections.test.ts`, `engineControllerPublication.test.ts`,
  `engineControllerAsync.test.ts` and `formPresentation.test.ts` (all in
  `lib/preview/engine/__tests__/`): `sectionPages()` becomes `formScreens()`, and each engine they
  build to prove section paging, today's on-change recalculation or the device zone's day numbers
  takes an Android `PreviewDevice`, since an engine with no device plays Web Apps (§20); their
  assertions stand. A suite over a `buildDoc` document holding a date-and-time question
  (`formEngine.test.ts`, `runtimeBindings.test.ts`) passes the device the same way, since the engine
  reads its rules from the device it is given, never from the document's declaration.
- `lib/preview/xpath/__tests__/coreDateParity.test.ts` (extend): the `utc` epoch rows of
  `day-number-utc-epoch` (`coreDaysSinceEpoch`, `coreFractionalDays`, `coreDateAdd`) in the four zones
  it already runs and `Etc/GMT+12`; `lib/preview/xpath/__tests__/asyncEvaluator.test.ts` (extend): the
  async path's `if(regex('a', 'a'), int(today()), -1)` under a `"utc"` and a `"device-zone"` context.
- `components/preview/form/fields/geopoint/__tests__/geopointValue.test.ts` (extend): §14.1's
  spelling of `40`, `-1.5`, `0.0001` (`1.0E-4`), the two-decimal floor of altitude and accuracy, and
  its existing expectations moving to that spelling (`12.34 56.78 0 0` becomes `12.34 56.78 0.0
  0.0`), each still admitted by the stored-geopoint schema it already compiles.
- `lib/preview/engine/__tests__/runtimeBindings.test.ts` (extend): Android's four-part `here()`.
- `lib/preview/__tests__/entryPointLaunch.test.ts` (extend): §23.3's two entry-point observables.
- `components/preview/__tests__/formScreenAfterSubmit.test.ts` (extend): `app_home` per platform; the
  five hidden-target landings of §7 on Web Apps (a form in a module whose display condition is false
  included) and the open on Android.
- `lib/preview/__tests__/caseTile.test.ts` (extend): flat, borderless and alignment on Android.
- `lib/preview/engine/__tests__/caseTileGroupingRead.postgres.test.ts`: a grouped tile list read with
  `tileGrouping: "grouped"` pages by groups and with `"flat"` returns the same cases in sort order,
  paged and counted by cases (§11).
- `lib/case-store/postgres/__tests__/restoreScope.postgres.test.ts` (extend): a search population read
  with `onlyOutsideRestore` over 120 open cases of which the worker's restore holds 30 pages 50 at a
  time through exactly the 90 it does not hold, in order and with none repeated, counts 90, leaves out
  closed and held cases, and refuses alongside a `restoreScope` (§8.2).
- `lib/preview/engine/__tests__/submissionSessionContext.postgres.test.ts`: a case operation writing
  `session-context(deviceid)` stores `Formplayer` through a Web Apps device and `commcare_<id>` through
  an Android one, through the submission Server Action's program (§18.5).
- `lib/preview/engine/__tests__/searchInputConstraints.test.ts` (extend): no errors or marks on Android.
- `lib/preview/app-tests/__tests__/platformSessions.test.ts`: the schema admits per-session and
  top-level platform; an undeclared platform refuses with an `AppTestActionError` holding the
  sentence; an Android session starts at `device-home` and `continue` opens the module list; `home`
  returns there; §21.4's pages: on Web Apps no `pageNext` or `pagePrevious` is offered and `section`
  admits a section and changes nothing, on Android an unsectioned form turns one screen of §12.1 per
  `pageNext` and refuses `section`.
- `lib/preview/app-tests/__tests__/journey.postgres.test.ts` (extend): two sessions, Web Apps and
  Android, through one submission with `app_home`, landing on the module list and the device home;
  each observation names its platform; a version 16 journey refuses to continue.
- `lib/agent/authoring/__tests__/evaluationContext.postgres.test.ts` (extend): the session values per
  platform and the refusal; a `sectionUuid` on Web Apps changes nothing and on Android enters the
  section.
- `lib/case-store/__tests__/formAttachmentSize.postgres.test.ts`: after the migration a 15,727,616
  byte row inserts and a 15,727,617 byte row is refused by the check; `down` restores 4,000,000.
- `app/api/apps/[id]/attachments/__tests__/route.test.ts` (extend; it mocks the snapshot and the
  pending-row writer at the route's boundary): an Android upload of a 10 MB `video/webm` reaches
  `createPendingFormAttachment` with extension `.webm` and content type `video/webm`; the same upload
  on Web Apps refuses with the size sentence; an upload naming a platform the snapshot's blueprint
  does not declare refuses before any write; an Android `image/png` upload to an audio question
  refuses with the family sentence; a `contentType` that is not a type and subtype refuses before
  any write; an Android signature and file upload take today's extension check.

Pull request 9: the cell table's three files, `platformRuleReaders.test.ts`, the Playwright specs of
§25, the three Android reader tests of §24, and under §24.3's outcome A
`lib/preview/__tests__/unheldCaseSubmit.test.ts` (`formChangesSessionCase`: a follow-up with a
primary writer, a close form with and without a holding condition, an `update` operation on the
`session` target, against a follow-up writing only a child case and an `update` operation on an
earlier create).

---

## Read during planning

Nothing was executed for this part beyond reading the checkouts and Nova's tree with `rg`, `sed`
and small `python3 -I` reads of `lib/commcare/surface/entries/*.json`; no test, build, image, lane
or paid call ran. Read at Nova `e9e6cd93`: `components/builder/PreviewIdentityMenu.tsx`,
`BreadcrumbStrip.tsx`, `BuilderPageNavigation.tsx`, `AppTestHistory.tsx`,
`components/builder/localization/LanguageSelector.tsx` (the label-in-group pattern),
`components/shadcn/dropdown-menu.tsx`, `components/preview/screens/HomeScreen.tsx`,
`FormScreen.tsx` (`dispatchPostSubmit`), `CaseListScreen.tsx` (the informational list, the empty
notices, Search again), `components/preview/EntryPointPreviewLaunch.tsx`,
`components/preview/form/FieldHelp.tsx`, `fields/ValidationError.tsx`,
`components/preview/form/sections/useSectionPaging.ts`, `lib/session/store.ts`
(`setPreviewing`, `setPreviewPersonaUuid`, `applyAccessSnapshot`, `reset`,
`clearPreviewNavigation`, `installEntryPointLaunch`), `lib/preview/engine/identity.ts`,
`previewAuthorization.ts`, `formEngine.ts` (`setValue`, `setValueAsync`, `evaluateRepeatCascade`,
`sectionPages`, `FormEngineRuntimeOptions`), `triggerDag.ts` (`getAffectedWork`, `getAllPaths`,
the expression types), `runtimeBindings.ts::viewerLocationText`, `geopointValue.ts`,
`viewerLocation.ts`, `lib/preview/xpath/coreDays.ts`, `types.ts` (`EvalContext`,
`XPathDate.coreDays`), `coerce.ts`, `evaluator.ts`, `workerProtocol.ts`,
`lib/preview/entryPointLaunch.ts`, `afterSubmitRouting.ts`, `caseTileRendering.ts`,
`runtimeMessages.ts`, `lib/preview/hooks/caseDataInvalidation.ts`, `lib/preview/app-tests/types.ts`,
`run.ts`, `submission.ts`, `lib/db/appTests.ts`, `lib/agent/tools/evaluateForm.ts`, `appTests.ts`,
`lib/agent/authoring/evaluationContext.ts`, `lib/domain/captureFormats.ts`,
`app/api/apps/[id]/attachments/route.ts` and `[attachmentId]/route.ts`,
`lib/case-store/postgres/submissionAttachments.ts`,
`lib/case-store/migrations/20260726000000_form_attachments.ts` (`form_attachments_size_check`),
`lib/domain/modules.ts` (`TILE_VERTICAL_ALIGNS`), `lib/commcare/suite/case-list/tileStyle.ts`,
`lib/commcare/entryPointSuite.ts`, `components/builder/form-links/afterSubmitCopy.ts`,
`proof/targeted/documents/hiddenFromMenu.ts`, `formLinkHiddenTarget.ts`,
`proof/android/README.md` (endpoints, `complete`), `proof/android/test_navigation.py`,
`proof/android/src/nova/proof/android/Views.java`, `.github/workflows/proof-audit.yml` (the `slice`
inputs), `e2e/CLAUDE.md`, `e2e/lib/smokeProfiles.ts`, `config/smoke-execution.json`,
`lib/preview/CLAUDE.md`, `lib/session/CLAUDE.md`, `lib/preview/app-tests/CLAUDE.md`,
`components/builder/CLAUDE.md`, `components/CLAUDE.md` (Voice), `design/readme.md` (Content
fundamentals), the public docs named in §26; and, read to settle §3, §7, §8, §11, §12,
§16, §18, §21 and §22: `lib/commcare/xform/builder.ts` (`buildContainer`, `buildRepeatBody`),
`lib/commcare/xform/caseBlocks.ts`, `lib/domain/caseWriteInventory.ts`, `lib/domain/forms.ts`
(`orderedCaseOperations`, `caseOperationSchema`, `closeConditionSchema`), `lib/domain/fields/index.ts`
(`captureFieldKinds`), `lib/domain/expression/jsonSchema.ts` (`GEOPOINT_PATTERN`),
`lib/case-store/store.ts` (`QueryArgs`, `SearchPopulation`), `lib/case-store/postgres/store.ts`
(`searchPopulationHeldBy`), `lib/case-store/sql/compileRestoreScope.ts`,
`lib/preview/engine/caseDataBindingHelpers.ts` (`readCases`, `buildCaseOperationProgramFromDoc`,
`buildSubmissionOperationProgram`), `caseDataBinding.ts`, `evaluateFormSnapshot.ts`,
`searchResultsSnapshot.ts`, `formAnswerValue.ts`, `lib/preview/xpath/asyncEvaluator.ts`,
`functions.ts`, `lib/preview/app-tests/errors.ts`, `context.ts`, `records.ts`, `service.ts`,
`lib/preview/hooks/useSectionPages.ts`, `components/builder/usePreviewModeTransition.ts`,
`BuilderLayout.tsx`, `components/preview/form/fields/attachment/AttachmentField.tsx`,
`lib/mcp/__tests__/servedSchemas.test.ts`, and the e2e specs and seeds §25 names.

Read at the pins: Formplayer `session/FormplayerInstanceInitializer.java` (`getVersionString`,
`getDeviceId`), `session/FormSession.java` (the platform), `services/MenuSessionRunnerService.java`
("Redirecting after sync"); Core `src/cli/java/org/commcare/util/engine/CommCareConfigEngine.java`
(`MAJOR_VERSION`, `MINOR_VERSION`), `org/javarosa/core/model/utils/DateUtils.java` (`EPOCH_TIME`,
`tzProvider`, `getFields`, `getDate`, `roundDate`, `daysSinceEpoch`),
`org/javarosa/core/model/data/GeoPointData.java` (`fillArray`, `roundDecimalUp`, `getDisplayText`),
`org/javarosa/form/api/FormController.java` (`getQuestionPrompts`, `indexIsInFieldList`,
`getGroupsForCurrentIndex`), `org/commcare/xml/CaseXmlParser.java::loadCase`; Android
`activities/HomeButtons.java::buildButtonData`, `StandardHomeActivityUIController.java::getHiddenButtons`,
`HomeScreenBaseActivity.java::handleNoFormFromSessionNav`, `QueryRequestActivity.java::processSuccess`,
`FormEntryActivityUIController.java` (the end of form, `createRepeatDialog`), `GeoPointActivity.java`,
`views/widgets/GeoPointWidget.java`, `ImageWidget.java`, `VideoWidget.java`, `AudioWidget.java`,
`CommCareAudioWidget.java`, `views/EntityViewTile.java::computeGravity`, `views/EntityDetailView.java`,
`utils/AndroidHereFunctionHandler.java`, `utils/GeoUtils.java::locationToString`,
`utils/FormUploadUtil.java::MAX_BYTES`, `utils/FileUtil.java::WARNING_SIZE`,
`FormEntryActivity.java::MAX_FORM_ATTACHMENTS`, `app/AndroidManifest.xml` (`versionName`), the
strings `home.*`, `query.response.empty`, `version.id.long`, `select.detail.confirm`,
`repeat.dialog.*`, `location.capture.cancelled`, `notification.processing.badstructure.*`,
`file.oversize.error.*`, `form.entry.finish.button`, and `R.string` `get_location`,
`replace_location`, `finding_location`, `location_provider_accuracy`, `accept_location`,
`cancel_location`, `capture_image`, `choose_image`, `discard_image`, `capture_video`, `choose_video`,
`capture_audio`, `choose_sound`, `attachment_oversized`; HQ `form_entry/question.html` (help
trigger, hint, `serverError`, the required text), `form_entry/entries.js` (`getEntry`'s barcode
case, the 4,000,000-byte check), `form_entry/form_ui.js` (the required and range messages),
`app_manager/suite_xml/post_process/endpoints.py` (`_make_session_endpoint`, `_add_claim_frame`).
Read to settle the same sections: Core `org/javarosa/form/api/FormEntryController.java::getQuestionPrompts`,
`DateUtils.java::fractionalDaysSinceEpoch` and `EPOCH_DATE`,
`org/javarosa/xpath/expr/FunctionUtils.java` (`date(n)`); Formplayer
`services/MenuSessionFactory.java::rebuildSessionFromFrame`, `aspects/SetBrowserValuesAspect.java`;
Android `views/widgets/QuestionWidget.java::fireHelpText`, `utils/FileUtil.java::isFileOversized` and
`getFileSize`; HQ `form_entry/question.html` (the help modal) and `case_search/utils.py`
(`is_closed(False)`).
