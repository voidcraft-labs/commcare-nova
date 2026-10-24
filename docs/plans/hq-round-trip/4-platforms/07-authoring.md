# Step 4, part 07: Authoring on the three editors

Part of [step 4's plan](../4-platforms.md), which holds the baseline, the decisions, the stack and
the exit. This part plans how the platform declaration reaches the people and models who author an
app: the builder (pull request 11) and the Solutions Architect and MCP (pull request 12), with the
`../nova-plugin` check that pull request 14 records. The declaration itself, the platform table, the
use detector and both validator channels are pull request 4's (part 01); media acceptance is pull
request 7's (part 04); Preview, App Tests and `evaluate_form` per platform are pull requests 8 and
9's (part 06); the expression reads are pull request 10's (part 03). Where this part depends on one
of them it names the exact fact it reads (§1).

Stack references use the fifteen pull requests by number; the step's plan holds the stack in full.

Citations are `path::symbol` for Nova at `main` `e9e6cd93`, and for CommCare at the pins step 4
reads: commcare-hq `d6c6e16d8ae1`, commcare-core `8e9ba8d908e9`, commcare-android `7a5584475580`,
commcare-connect `046c7fd78081`, formplayer `24383ac71bfb`, Vellum `01215f251c57`. This part rests on
two CommCare facts of its own, both read at those pins:

- **Web Apps has no entry for a date and time question.** `getEntry` has a case for
  `constants.DATE` and `constants.TIME` and none for `constants.DATETIME`, so the question falls
  through to `UnsupportedEntry`, whose constructor sets the answer to `'Not Supported by Web Entry'`
  (commcare-hq `corehq/apps/cloudcare/static/cloudcare/js/form_entry/entries.js::getEntry`,
  `::UnsupportedEntry`; `const.js` declares `DATETIME: 'datetime'`). The pre-check copy of §3.7 and
  the guide sentence of §3.4 say this in plain words.
- **Connect workers open their apps only on Android.** Connect hands each worker's phone the app's
  Android install profile (commcare-connect
  `commcare_connect/opportunity/api/serializers/mobile.py::CommCareAppSerializer.get_install_url`),
  makes the worker's CommCare HQ account with no password
  (`commcare_connect/users/helpers.py::create_hq_user_and_link`), and HQ keeps a password from being
  set on an account linked to PersonalID (commcare-hq
  `corehq/apps/users/forms.py::SetUserPasswordForm.user_has_active_personalid_link`). The Connect
  dialog line of §2.7 says this.

Every other platform reading this part shows is a row of part 01's table (pull request 4), held to
the manifest by that part's binding test (part 01 §8); this part never restates a reading, a note
or a remedy of its own.

## Decisions in brief

1. **The schemas the SA and MCP are served stay static.** One schema per tool on MCP
   (`lib/mcp/adapters/sharedToolAdapter.ts::registerSharedTool`) and the architect's and peer's
   `toolsetDigest` (`lib/agent/build/orchestrator.ts`, read by
   `lib/agent/build/modelContextStore.ts::readLatestPredecessorItems`) make a per-declaration schema
   either unrepresentable or a mid-build compaction loss. The model learns the declaration from the
   overview (`platforms`, `notOffered`), the guide, the generated per-feature sentences, gate
   refusals and the tool pre-checks (§3.3, §3.7). The only served schema this part changes is
   `updateApp`'s.
2. **The builder offers every choice by declaration, disabled with a reason, never hidden.** One
   reason line, part 01's `platformPickerLine(platformRefusal(feature, platforms))` (part 01 §2.2,
   §2.3), which names the platform that lacks the choice and offers the way forward: read from the
   table, so a picker and the gate cannot disagree (a parity test holds it, §2.10). In an app that
   runs in Web Apps the insertion menu also offers `Date and time (as two questions)`, which inserts the split shape
   directly (§2.6), so the disabled Date/Time item never leaves a person without a way to ask for
   both. The one exception is the XPath editor's completion: a text editor offers only what its
   checker admits (`lib/codemirror/CLAUDE.md`, "No offer-then-reject"), and the linter explains a
   refused read where it is typed.
3. **The declaration is edited in a new App settings section,** `AppPlatformsSection`, first in the
   panel, as three full-width choices with one line each. A change that only removes a platform
   commits through the client gate; a change that adds a platform runs the platform change preflight
   first (decision 4). No confirmation dialog: the section shows what the choice means before it is
   made.
4. **One server action checks content and media together,** `lib/doc/platformChangePreflight.ts::
   platformChangePreflightAction`, after the reconciler's save barrier, over the committed document
   and the referenced asset rows of one Project, returning the builder line and location of every
   use the new declaration cannot run and the `mutationSeq` it read. It follows
   `lib/preview/engine/casePropertyRenamePreflight.ts::preflightCasePropertyRenamesAction`. Its media
   half calls part 04's `unplayableReferences` on the server, as part 04 §6.5 places it, and reads the asset rows on the preflight's own `repeatable read`
   transaction, so content and media are read from one committed snapshot over one pool
   connection. Only a change that adds a platform can strand anything: a declared platform's absence only drops
   refusals (part 01's rule refuses a use unavailable on a declared platform, and part 04's
   acceptance asks a file to play on every declared platform).
5. **A refused change lists each stranded use beside the control,** each with an Open link that
   selects its owner, and, for a date and time question, the split gesture. The finding-to-link
   mapping is extracted from `components/builder/case-list-config/CaseListConfigWorkspace.tsx::
   commitReviewBlocker` into one shared helper, so both surfaces open a finding the same way.
6. **The split gesture is "Ask for the date and the time separately",** offered on every date and
   time question in the field actions menu (above Convert type) and on the refusal row, whatever the
   declaration: it is an ordinary, valid edit on every declaration, and hiding it would hide a valid
   affordance. It calls pull request 3's planner (part 03 §2.11) through a new mutation method and
   commits one undo step.
7. **A permanent platform note row states every difference where the author works,** in the
   inspectors and settings sections named in §2.8, fed by `platformSentence(feature, declared)` over
   the uses `lib/domain/platformUses.ts::platformFeatureUses(doc)` attributes to the inspected owner.
   It renders only where a declared platform reads `different` or `ignored`, and only the declared
   platforms' clauses; the one addition is `search-first`'s Web Apps note beside a form field that
   reads a Search field (§2.8).
8. **Builder copy that states a table feature's difference moves onto the table;** copy that states
   a configuration's per-platform consequence keeps its words and shows only the declared platforms'
   clauses (§2.9). Model-facing tool descriptions that state both platforms keep their words: both
   clauses stay true on every declaration, and generating them from the table would move served
   schema bytes whenever a note changes.
9. **Turning on Connect sets the app to Android only in the same batch,** in the store action both
   Connect dialogs commit through (`lib/session/store.ts::switchConnectMode`), with the consequence
   stated in the dialog before the person confirms. Turning Connect off never widens the declaration,
   and the manager dialog says so beside its Turn off control. SA and MCP need no tool change: the
   guide's sentence tells them to narrow first, and a `configureConnect` that turns Connect on in an
   app declaring Web Apps meets the gate's Connect finding at that call, among the staged findings
   private work reports (decision 12), and `saveWork` refuses the work until it is resolved.
10. **`updateApp` gains `runs_only_on`,** `"web-apps" | "android" | null`, absent keeping the
    setting, `null` returning the app to both; the description is §3.3's, verbatim. `configureConnect`
    stays a separate tool because Connect is a whole-app target state with participation; the
    declaration is one settings key `updateApp` already owns.
11. **`updateApp` pre-checks content and media when its change adds a platform,** and refuses
    without staging. Content: when `unavailableUses(candidate, declaredPlatforms(candidate))` is not
    empty, it returns the gate's platform findings for the candidate (`PLATFORM_FEATURE_UNAVAILABLE`
    and the checker's `platform-unavailable` leaf findings, each `platformRefusalMessage` text).
    Media: the same `lib/media/attachVerdicts.ts::mediaDeclarationVerdict` the preflight runs, a thin
    loader around part 04's `unplayableReferences`, returning part 04's
    `describeUnplayableReferences` text, the words the kernel's refusal uses. Reason: SA and MCP
    edits stage in private work, which admits a batch with validator findings and reports them as
    diagnostics (`lib/agent/change-set/workspace.ts`, `evaluateOverlayFindings`,
    `lib/agent/workspace/CLAUDE.md` invariant 3), and whose pure gate sees no media rows. Without the
    pre-check a change of declaration would stage, and its refusal would first reach the model at
    `saveWork`, far from the call that caused it, contradicting the served description (§3.3). Part
    04 §6.5 notes the media pre-check.
12. **`addFields` and `editField` pre-check the date and time kind** before staging, and no other
    field-level use: staged findings already reach the model at the call that introduced every other
    refused use (`lib/agent/change-set/workspace.ts`, `computeChangeSetDiagnostics` on each prepared
    batch), and the date and time question is the one a new app meets most. The pre-check's text is
    part 01's `platformRefusalMessage`, the gate finding's own message, so the two cannot drift.
13. **The guide teaches the declaration once,** in `AUTHORING_REFERENCE.workflows` (§3.4,
    verbatim), with the date and time join and the Connect rule in it, and generated platform
    sentences after the sentences that introduce each feature. No new guide topic: a topic would
    change `getAuthoringGuide`'s served `topic` enum for no gain.
14. **The plan opens with where workers use the app, and the peer checks it** (§3.5). There is no
    plan template (`lib/agent/planning/plan.ts` stores free Markdown), so the planning segment
    teaches the line.
15. **Autonomous builds narrow only when the request names a feature that runs on one platform,**
    to that platform, and report it; otherwise they keep both (`lib/mcp/prompts.ts::
    INTERACTIVITY_INSTRUCTIONS.autonomous`, and the guide's sentence every client reads).
16. **`MODEL_CONTEXT_VERSION` moves once in this part,** to `"v5-hq-round-trip-platforms.12"` in pull
    request 12; pull request 11 changes nothing the model reads. Pull requests 8 and 10 move it for
    their own reasons (`.8`, `.10`).
17. **The billed schema check is asked once, at pull request 12's head,** naming `updateApp`,
    `evaluateForm` and `startAppTest` and any other tool whose served-schema hash moved between
    `main` and that head; each runs as `npm run test:schema -- <name>` only on the person's yes.

## 1. What this part reads from earlier pull requests

The names below are the contract this part builds on. Each is planned by the part named, which owns
it; this part cites that part's section and follows its names.

**Pull request 3 (the split's groundwork, part 03 §2.11):** `lib/doc/datetimeSplit.ts::
planDatetimeSplit(doc, fieldUuid): DatetimeSplitPlan` (`{ ok: true; mutations } & DatetimeSplit`,
whose `DatetimeSplit` carries `dateUuid`, `timeUuid`, `dateId`, `timeId` and `moved`, or `{ ok:
false; reason; message }`, with the two refusal messages part 03 §2.11 writes);
`datetime.convertTargets` becoming `["date", "time", "hidden"]` (part 03 §2.8).

**Pull request 4 (the declaration and the platform table, part 01):**

- `appSettings.runsOnlyOn?: "web-apps" | "android"`; the `setAppSettings` patch
  `lib/domain/blueprint.ts::appSettingsPatchSchema`, admitting `runsOnlyOn: Platform | null`, with
  its type `AppSettingsPatch` exported from `lib/domain/blueprint.ts`; a patch carrying
  `runsOnlyOn` takes the whole-document gate (part 01 §1.1, §1.2).
- `lib/domain/platforms.ts` (part 01 §2): `PLATFORMS`, `type Platform`, `declaredPlatforms(doc)`,
  `declaresWebApps(doc)`, `declaresAndroid(doc)`, `PLATFORM_LABELS` ("Web Apps", "Android"),
  `PLATFORM_DECLARATION_LABELS` and `platformDeclarationLabel(platforms)` ("Web Apps and Android",
  "Web Apps only", "Android only"), `PLATFORM_FEATURES` (each a `PlatformFeature`: `label`,
  `channel`, `webApps` and `android` as `PlatformBehavior`, whose `unavailable` arm carries the
  `note` and the optional `remedy`, `refusal`, `fieldKind`), `unavailablePlatform(feature,
  platforms)`, `platformRefusal(feature, platforms)`, `featureForFieldKind(kind)`,
  `platformSentence(feature, platforms)`, `platformPickerLine(refusal)` (taking `platformRefusal`'s
  `{ feature, platform }`, also the shape of `CheckError.platform`) and
  `platformRefusalMessage({ feature, platform, platforms, subject })`.
- `lib/domain/platformUses.ts` (part 01 §3): `platformFeatureUses(doc)` returning
  `PlatformFeatureUse` (`feature`, `owner` as a `PlatformFeatureOwner`, `site`) in document order,
  and `unavailableUses(doc, platforms)`.
- `PLATFORM_FEATURE_UNAVAILABLE` with `details: { feature, platform }`, located at the owner, with
  its builder line `lib/doc/userFacingErrors.ts::platformBuilderSentence` (part 01 §5, §7); the
  checker's `arm-unavailable` finding with reason `platform-unavailable` and `CheckError.platform`
  (`{ feature, platform }`), read from the declared platforms `ExpressionContext.platforms` carries
  (part 01 §6).
- The e2e seeds that hold a use unavailable on one platform of a both app (`search-first`,
  `search-claim`, `search-results`, `here-column` among them) declare the platform their content
  runs on (part 01 §11.3); §2.10's specs read those seeds as pull request 4 leaves them.

**The frame of `platformSentence`** is part 01 §2.3's: for each platform of its argument, Web Apps
first, a reading of `unavailable` gives `Not available in Web Apps: <note>.` or `Not available on
Android: <note>.`, followed by the row's `remedy` when it has one; any other reading with a note
gives `In Web Apps, <note>.` or `On Android, <note>.`; a reading with no note gives nothing. The
picker line of decision 2 is `platformPickerLine`, two sentences: the same `Not available in Web
Apps` or `Not available on Android` lead with no note, then the way forward, which is changing where
the app runs in App settings unless the row carries its own line (`datetime-question` adds asking
for a date and a time as two questions; `connect-app` names Connect instead of a platform), so the
guide, the disabled choices and the refusals name a missing platform in one phrase and no disabled
choice dead-ends; its words are part 01 §2.3's.

**The notes this part's copy relies on.** Part 01 §4.1 and §4.2 carry them, in its frame (lower
case, no final period); part 01 took this part's wording for each note below, because each replaces
builder copy that states the same difference today (§2.9) or a capture `saDocs` sentence (§3.4).
This part quotes them from part 01 and keeps no copy of its own:

| Feature | What its note or remedy replaces |
|---|---|
| `datetime-question` | its remedy, the split as the workflows guide teaches it (§3.4) |
| `image-question`, `audio-question`, `video-question` | the capture `saDocs` sentences (§3.4); the Web Apps notes name `lib/domain/captureFormats.ts`'s extension lists and the 4 MB limit, the Android notes the 15 MB limit, both held to part 06 §16.3's `CAPTURE_LIMITS` (pull request 8) |
| `location-question`, `barcode-question` | the capture `saDocs` sentences (§3.4) |
| `question-pages` | the section inspector's stated difference (§2.8) |
| `saved-forms`, `incomplete-forms` | `AppSavedFormsSection`'s platform clauses (§2.9) |
| `after-submit-home` | `FIRST_MENU_HELP`'s Android sentence (§2.9) |
| `link-column` | `LinkColumnCard`'s Android clause (§2.9) |
| `search-field-checks` | `SearchInputEditor`'s two hints (§2.9) |
| `tile-grouping` | the grouping section's stated difference (§2.8) |
| `app-logo` | `AppAppearanceSection`'s Android clause (§2.9) |

**Pull request 7 (media by platform, part 04):** `media_assets.media_format`, a `MediaFormatValue`
of `MEDIA_FORMATS`, and `WireMediaAsset`'s `mediaFormat`, `formatLabel` and `playsOn` (part 04
§2.1, §5.4); `lib/media/platformPlayback.ts` (part 04 §6.1): `unplayableReferences(doc, formats,
platforms): UnplayableReference[]` (`{ ref, mediaFormat, label, missing }`) for every authored
reference whose file a platform of `platforms` cannot play, `describeUnplayableReferences(
references)`, the refusal text the kernel uses, and the picker helpers `assetUnavailableReason(row,
platforms)`, `formatUnavailableReason(mimeType, platforms)` and `playsOnLine(playsOn)`; and the
kernel's platform-aware admission, the authority on every editor (part 04 §6.2).

**Pull request 8 (Preview, the model, part 06):** `startAppTest` and `evaluateForm` take a
`platform`; `startAppTest` is registered in `scripts/test-schema.ts` there.

**Pull request 10 (expression reads, part 03):**

- `drift`, `applanguage` and `window_width` authorable in the card editor and the XPath editor,
  labelled "Device clock offset", "App language" and "Window width" (part 03 §6.5). `window_width`
  is admitted where `SlotProfile.windowWidth` holds: every module slot and a form's
  `form_display_condition`, and no slot a form evaluates (field, Connect, case-operation and
  form-link slots, and `lookup_options_source`), on every declaration (part 03 §6.2), under outcome
  A of the gate below. `applanguage` compares with the app's language codes,
  `localization.wireCodes` (part 03 §6.2).
- The `case-list-search-text` value arm `{ kind: "case-list-search-text" }` (part 03 §5.2), spelled
  `instance('commcaresession')/session/data/stringquery` in form text, admitted in field and
  Connect slots where the evaluating entry has exactly one case list (part 03 §5.3), with its
  builder card and its completion, both labelled "Case list search text", offered where the slot
  profile admits it (part 03 §5.4).
- Part 01's rows for `case-list-search-text`, `window-width`, `clock-drift` and `app-language`, and
  `search-first`'s Web Apps note for a form opened from a link or an entry point (part 01 §4.1,
  §4.5; part 03 §4.2).
- The `window_width` gate (part 03 §6.4). Under its outcome A, `window-width` reads `unavailable`
  on Android, and the sites below that name it disable it there. Under outcome B, part 03 drops
  `SlotProfile.windowWidth`, so `window_width` is admitted wherever a context field is, and part
  01's `window-width` reads `different / different` and refuses nothing, so those sites offer it in
  every slot on every declaration, and no list below names it.

Pull request 10 makes these reads authorable; this part's pull request 11 adds only their offering
by declaration (§2.5) and the two sites part 03 leaves to the builder: the `search-first` note beside
a Search field read (§2.8) and the language-code picks (§2.5).

## 2. The builder (pull request 11)

### 2.1 Today

- The App settings panel (`components/builder/detail/appSettings/AppSettingsPanel.tsx`) stacks
  `AppAppearanceSection`, `AppSavedFormsSection`, `AppConnectSection` and `AppDataSourcesSection`.
  `AppSavedFormsSection` commits `setAppSettings` with one key per switch through the announcing
  flavor of `useBlueprintMutations`.
- `useBlueprintMutations` (`lib/doc/hooks/useBlueprintMutations.ts`) has an announcing flavor and an
  `inline` one; `reviewMany` evaluates a batch without committing and returns structured findings
  (`StructuredCommitOutcome`), and `commitMany` commits one batch as one undo step.
- The field insertion menu (`components/preview/form/FieldTypePicker.tsx`) offers every kind from the
  static registry; only its page gestures carry a disabled reason (`GestureMenuItem`). The field
  actions menu (`components/builder/editor/FieldIdentitySection.tsx`) converts to every
  `getConvertibleTypes` target.
- Disabled-with-reason is the builder's rule for withholding a choice (`components/builder/CLAUDE.md`,
  the add-form menu and the case-list pickers), in one voice (`lib/doc/userFacingErrors.ts::
  offeredChoiceRefusal`).
- Builder copy states several platform differences in its own words (§2.9).

### 2.2 The platform section

New `components/builder/detail/appSettings/AppPlatformsSection.tsx`, mounted first in
`AppSettingsPanel`, above `AppAppearanceSection`. Reason: the declaration decides what every other
section and every picker offers, so it is the first thing a person setting the app up reads.

It reads the declaration through a new hook, `lib/doc/hooks/useDeclaredPlatforms.ts::
useDeclaredPlatforms(): readonly Platform[]`, which selects `s.appSettings.runsOnlyOn` (a primitive,
so unrelated edits do not re-render) and returns `declaredPlatforms` of it, memoized on that value.
Every component this part changes reads the declaration through this hook.

Layout: the section label as `AppSavedFormsSection` draws its own, then a `fieldset` of three
full-width rows, each a `label` wrapping a visually hidden `input type="radio"` (the pattern of
`components/builder/case-list-config/canvas/CaseSelectionSetting.tsx`), styled with
`lib/styles.ts::selectableSegmentCls`, with the label on the first line and its meaning on the
second. Copy:

| Element | Text |
|---|---|
| Section label and `legend` | `Where workers use this app` |
| Row 1 label / line | `Web Apps and Android` / `In a browser on CommCare HQ, and in the CommCare app on phones and tablets` |
| Row 2 label / line | `Web Apps only` / `In a browser on CommCare HQ` |
| Row 3 label / line | `Android only` / `In the CommCare app on phones and tablets` |
| Muted line under the rows | `Each choice decides which features Nova offers.` |
| Line replacing rows 1 and 2's meaning in a Connect app (both rows disabled) | `platformPickerLine(platformRefusal("connect-app", <the row's platforms>))`, which returns the `connect-app` row's own picker line (part 01 §2.3, §7) |
| Status while the preflight runs (row 1 or 2 or 3 shows a `Spinner`) | `Checking this app…` (standalone status text, the one place `design/readme.md` gives an ellipsis; no button or menu item carries it) |
| Screen-reader announcement after a change (`role="status"`, visually hidden) | `This app now runs in Web Apps and on Android` / `This app now runs only in Web Apps` / `This app now runs only on Android` |

Viewers never open App settings (`AppSettingsButton` renders nothing for them); the section reads
`useCanEdit()` only as the write backstop.

### 2.3 Changing the declaration

The section's `choose(next: "both" | Platform)` maps `"both"` to `runsOnlyOn: null` and builds the
one mutation `{ kind: "setAppSettings", settings: { runsOnlyOn } }`. If `next` is the current
declaration it does nothing.

**A change that only removes a platform** (both to one) runs `inline.reviewMany([mutation])`; on
`ok` it runs `inline.commitMany([mutation])`; a refusal from either fills the refusal block (§2.4)
from the structured findings. No refusal is expected (decision 4), but the gate decides, not the
section.

**A change that adds a platform** (one to both, or one to the other):

1. Marks the chosen row pending and announces `Checking this app…`.
2. `await reconciler.waitForHumanSaveBarrier()` (`lib/collab/reconciler.ts`), so the committed
   document is the one on screen. Anything but `saved` stops with the barrier line below.
3. `await platformChangePreflightAction({ appId, runsOnlyOn })`.
4. `refused` fills the refusal block; an error kind shows its line.
5. `ok`: if `reconciler.getSnapshot().baseSeq !== result.mutationSeq`, stops with the moved line;
   else `inline.commitMany([mutation])`, whose own client verdict re-proves content, and a refusal
   there fills the refusal block. The kernel's platform-aware media admission (part 04 §6.2)
   remains the authority on the server.

Each step checks a generation counter, as `components/builder/app-setup/DeploymentEntryPointLinks.tsx`
does, so a choice made while an earlier one is checking wins.

Lines (in the block's alert style, one line each):

| Case | Text |
|---|---|
| The save barrier did not reach `saved` | `Nova couldn't check this change while your edits were saving. You can try again in a moment.` |
| `baseSeq` moved | `This app changed while Nova was checking. You can choose again.` |
| `not-found`, `forbidden` or `unauthenticated` | `Nova couldn't reach this app. You can reload the page and try again.` |
| A thrown action error | `Nova couldn't check this change. You can try again in a moment.` |

**The preflight action.** New `lib/doc/platformChangePreflight.ts` (`"use server"`), types in
`lib/doc/platformChangePreflightTypes.ts` (client-safe):

```ts
export interface PlatformChangePreflightInput {
	readonly appId: string;
	readonly runsOnlyOn: Platform | null;
}
export interface PlatformChangeFindingRow {
	readonly line: string; // the finding's builder line, userFacingError(finding)
	readonly finding: StructuredCommitFinding; // code, scope, location, details
}
export interface PlatformChangeMediaRow {
	readonly line: string; // describeUnplayableReferences([reference]), part 04 §6.1
	readonly location: MediaRefLocation; // the reference's, lib/domain/mediaRefs.ts
}
export type PlatformChangePreflightResult =
	| { readonly kind: "ok"; readonly mutationSeq: number }
	| {
			readonly kind: "refused";
			readonly mutationSeq: number;
			readonly findings: readonly PlatformChangeFindingRow[];
			readonly media: readonly PlatformChangeMediaRow[];
	  }
	| { readonly kind: "not-found" | "unauthenticated" | "forbidden" };
```

The action is a thin wrapper: `getSession()`, then
`lib/doc/platformChangePreflightRead.ts::readPlatformChangePreflight(input, userId)` (`import
"server-only"`, not a `"use server"` module, because every export of a `"use server"` module is a
Server Action a client can call). Its body runs in one `withAppTx(body, { isolationLevel:
"repeatable read" })` transaction, the rename preflight's shape with the isolation
`lib/lookup/agentService.ts` uses, so every read below sees one snapshot on one pool connection:
validate `appId` and `runsOnlyOn` (anything else is `not-found`); `resolveAppScopeInTransaction(tx,
appId, userId, "edit")` (edit, because only an editor can act on the answer);
`loadAppInTransaction`; refuse the snapshot crossing a commit as that action does;
`hydratePersistedBlueprint`; `admitMutationBatch` of the one `setAppSettings`;
`prepareMutationCandidate`; the lookup snapshot of the candidate's references
(`readLookupDefinitionsInTransaction`); `evaluatePreparedMutationCandidate`. Its findings become
rows. Then, still inside the transaction, `mediaDeclarationVerdict({ projectId: scope.projectId,
doc: prepared.nextDoc, db: tx })` (below) for the media rows. `AppAccessError` maps to
`not-found` and `forbidden`; anything else is
logged with `log.error("[platform-change/preflight] unhandled", …)` and thrown, as the precedent
does. The action is a Server Action on the builder page, not an `/api/*` route, so it needs no
`lib/hostnames.ts` entry. Its arguments are plain JSON (no `Map`, `Set` or `File`). Neither new file
imports `@/lib/commcare`: they read findings through `lib/doc/commitVerdicts.ts` and
`lib/doc/userFacingErrors.ts` (both on `biome.json`'s allowlist), and `StructuredCommitFinding` by a
type-only import, so `biome.json` gains no entry.

**The media verdict.** New `lib/media/attachVerdicts.ts::mediaDeclarationVerdict({ projectId, doc,
db }): Promise<{ ok: true } | { ok: false; references: readonly UnplayableReference[] }>`, a
thin loader around part 04's rule (part 04 §6.5 names it): the authored references
(`lib/domain/mediaRefs.ts::walkAuthoredAssetRefs`), their real ids (`partitionAssetRefs`),
`loadAssetsByIds(ids, projectId, db)` mapped to the `{ mediaFormat, mimeType }` of each id, then
`lib/media/platformPlayback.ts::unplayableReferences(doc, formats, declaredPlatforms(doc))` (part 04
§6.1). `db` is an optional executor, `Kysely<AppDatabase>` as `lib/db/mediaAssets.ts`'s `lockedDb`
arguments are (a `Transaction<AppDatabase>` is one), and `lib/db/mediaAssets.ts::loadAssetsByIds`
gains the same optional last parameter, reading through `db ?? await getAppDb()`, so the
preflight's reads stay on its transaction and `updateApp` (§3.3), which has none, reads as today.
Each reference becomes one media row whose line is
`describeUnplayableReferences([reference])`, so a row reads as the kernel's refusal does, for
example "Android can't play a file this app uses: the image on option "yes" of field "consent"
(form "Visit") in ICO. You can replace it or remove it, then try again." The copy is part 04's,
written once; this part adds none. It is a courtesy check: the kernel's admission is the authority.
Running it here, on the server and over the snapshot the content check read, replaces the
client-side check over `useReferencedAssetRows` that part 04 §6.5 first described, so a row the
browser has not loaded cannot let a stranded file through to the kernel.

### 2.4 The refusal block

Rendered under the rows, in the rose alert style `NoMatchesFormSetting` uses (`role="alert"`,
`tablerAlertCircle`), until the person chooses another row or closes the panel.

- Title (`font-medium`): `<Added> can't run one thing this app uses` or `<Added> can't run <n>
  things this app uses`, where `<Added>` is `PLATFORM_LABELS` of the platform the change adds and
  `<n>` counts finding rows and media rows together.
- Line: `You can change it here, then choose “<Target>” again.` or `You can change each one here,
  then choose “<Target>” again.`, where `<Target>` is the declaration label of the choice.
- One row per finding and per media file: its line, then an `Open <target>` ghost button, where
  `<target>` is `location.fieldId ?? location.formName ?? location.moduleName ?? "this item"`, as
  today's review blockers say it. A finding located at the app (the Connect refusal) has no button.
- Open keeps App settings open: it only runs the navigation action, which writes the location and
  moves no focus (`lib/routing/navigation.ts`), so the popover, which closes on an outside press or
  on focus leaving it, stays open, and the block stays beside the canvas the person is now looking
  at. Reason: with several stranded uses, the list is the person's checklist; closing it on the
  first Open, as `commitReviewBlocker` closes the selection review that covers the workspace, would
  send them back to choose the row again for each one.
- A `PLATFORM_FEATURE_UNAVAILABLE` row whose `details.feature` is `datetime-question` and that
  carries `location.fieldUuid` also has the split button (§2.6). A successful split removes that
  row; a block left with no row closes.

**Opening a finding.** New `components/builder/shared/findingDestination.ts::findingOpenAction(
finding: StructuredCommitFinding, navigate: NavigateActions): (() => void) | undefined`, the body of
`CaseListConfigWorkspace.tsx::commitReviewBlocker`'s `onOpen` choice moved verbatim (operations,
form links, form display condition, then `openForm`, then `openModule`), with two arms added before
the module fallback, both keyed on `details.feature`, which only platform findings carry: a finding
whose `details.feature` is `search-first`, `search-field-single-date` or
`search-field-multiple-choice` opens `navigate.openSearchConfig(moduleUuid)`; one whose
`details.feature` is `several-cases` or `case-list-here` opens `navigate.openCaseList(moduleUuid)`.
No arm reads `details.carrier`, which only a chosen-case finding sets
(`lib/commcare/validator/lookupTypeContext.ts::checkErrorDetails`), so a finding
`commitReviewBlocker` opens today keeps its destination, and `commitReviewBlocker` calls the helper
with its behavior unchanged. A media row opens by its
location: a field or option reference `openForm(moduleUuid, formUuid, fieldUuid)`, a form icon or
audio label `openForm(moduleUuid, formUuid)`, a module icon or audio label `openModule`, a case-list
icon, audio label or image-map row `openCaseList`, and the app logo nothing (it is in this panel).

### 2.5 Offering by declaration

Each site below asks part 01's `platformRefusal(feature, useDeclaredPlatforms())` and, when it is
defined, shows `platformPickerLine(refusal)`, the picker line part 01 §2.3 writes (this part quotes
none of its words), whose second sentence offers the way forward; a question kind's feature is
`featureForFieldKind(kind)`. This part adds no wrapper of its own: the two calls are the one phrase
part 01 §2.3 calls the picker line. A site whose choice is already stored shows the stored choice as it is (the gate guarantees no
stored use is unavailable on a declared platform).

| Site | Choice | Change |
|---|---|---|
| `components/preview/form/FieldTypePicker.tsx::TypeMenuItem` | every kind `featureForFieldKind` names with a refusable feature (today `datetime`, "Date/Time") | `TypeMenuItem` takes `disabledReason`; disabled, the item uses `MENU_ITEM_DISABLED_CLS` and shows the reason on a second line, as `GestureMenuItem` does. Where Web Apps is declared, a new item follows the disabled Date/Time item: `Date and time (as two questions)`, with the second line `A date question and a time question, joined in a hidden value`, which calls `addDatetimeAsTwoQuestions` (§2.6) and selects the date question |
| `components/builder/editor/FieldIdentitySection.tsx`, Convert type submenu | each target kind whose feature the declaration refuses | the local `MenuItem` gains `description` and `disabledReason`; the target is disabled with the reason |
| `components/builder/case-list-config/canvas/CaseSelectionSetting.tsx` | Several cases | new prop `severalRefusal?: string`; the radio input is `disabled`, and the segment shows the reason on a muted second line under its label; `CaseListConfigWorkspace` passes the picker line of `platformRefusal("several-cases", platforms)` |
| `components/builder/case-list-config/inspector/SearchPanelInspectorBody.tsx` | Search first | `components/builder/inspector/inspectorChrome.tsx::ToggleRow` gains `disabledReason?: string` (the `Switch` disabled, the reason on a line under the description, as `RemoveRow` shows its reason); feature `search-first` |
| `components/builder/case-list-config/inspector/SearchInputEditor.tsx::TypePicker` | `date` ("Date picker"), `multi-select` ("Multiple choice") | new prop `platformRefusals: Partial<Record<SearchInputType, string>>`; the item's refusal is the platform reason first, then `multiSelectRefusal`; features `search-field-single-date`, `search-field-multiple-choice` |
| `components/builder/case-list-config/canvas/NoMatchesFormSetting.tsx` | Offer a registration form | the radio input is `disabled`, and the segment shows the reason on a muted second line under its label; feature `search-first` |
| `components/builder/detail/formSettings/FormEntrySection.tsx` | Open after a search finds no matches | the `Button` is `disabled`, with the picker line on a muted line under it; feature `search-first` |
| The card editor's value menu (`components/builder/shared/primitives/ExpressionPicker.tsx`) | "Where you are now" (`here`) in a calculated column; "Case list search text" (`case-list-search-text`, pull request 10's card, part 03 §5.4) in a form | the item's rule admission (`admitExpressionChange` → `lib/doc/commitVerdicts.ts::expressionEditVerdict`) runs the checker, which refuses `here` where Web Apps is declared (part 01 §6) and the search text where Web Apps is declared (pull request 10). `expressionEditVerdict`'s refusal (`PredicateEditVerdict`'s refused arm) gains `platform?: { feature, platform }`, copied from the first error's `CheckError.platform`. The menu never sees the verdict itself: it sees `components/builder/shared/editorContext.tsx::ExpressionChangeAdmission`, whose refused arm today carries only `reason` (the agent-voice `platformRefusalMessage`, which names `updateApp/update_app` and is no builder line). So that refused arm gains the same `platform?`, and both builders of the admission copy it from the verdict: `components/builder/shared/ExpressionCardEditor.tsx::admitRuntimeExpression` and `components/builder/shared/workbenchAdmission.ts::workbenchExpressionAdmission`. The item shows `platformPickerLine(admission.platform)` when `platform` is present, the picker line part 01 §7 gives the value menu; any other refusal keeps the line it shows today. A test holds it (§2.10) |
| The card editor's session values (`components/builder/shared/cards/expression/TermCard.tsx`) | `window_width` ("Window width") | pull request 10 makes `drift`, `applanguage` and `window_width` editable and offers `window_width` only where `profile.windowWidth` holds (part 03 §6.5; under outcome B of part 03 §6.4 wherever a context field is). This pull request adds the declaration: each item builds its candidate `session-context` term and asks `ctx.admitExpressionChange?.(path, candidate)`, exactly as `ExpressionPicker` asks, and an item whose admission carries `platform` is disabled with `platformPickerLine(admission.platform)`. Under part 03 §6.4's outcome A, `window_width` is so disabled, with Android's picker line, wherever Android is declared; `drift` and `applanguage` refuse nothing on either platform |
| The XPath editor (`lib/codemirror/expressionEditorContext.ts`) | the `session/context/window_width` and `session/data/stringquery` completions | pull request 10 offers each where the slot profile admits it, labelled "Window width" and "Case list search text" (part 03 §5.4, §6.5). This pull request also filters each by the declaration, from the slot's `ExpressionContext.platforms`: `stringquery` is offered only where Web Apps is not declared, and `window_width`, under outcome A, only where Android is not. Decision 2: a text editor's completion offers only what its checker admits, and part 01 §6's inline line explains a read typed by hand |
| The card editor's comparison (`components/builder/shared/cards/ComparisonCard.tsx`) | the value an `applanguage` read is compared with | the language-code picks part 03 §6.2 leaves to the builder: where the subject is the `session-context` term `applanguage` and the other side is a literal, the right operand is a new `components/builder/shared/cards/AppLanguageValuePicker.tsx`, as `CaseTypeValuePicker` serves a case-type comparison. It reads `lib/domain/localization.ts::effectiveAppLocalization(doc.localization)`, so a legacy English-only app (no stored `localization`) offers its one language with wire code `en`: one item per tag of `languageOrder`, labelled with the language's name and storing `wireCodes[tag]` as the text literal. Reason: the value the session holds is the wire code, which no author chooses and few know |
| The Connect dialogs | turning on Connect | §2.7 |

**Media pickers** (the sites part 04 §6.4 assigns to this pull request, from part 04's functions):

| Site | Change |
|---|---|
| `components/builder/media/MediaPickerDialog.tsx`, the Library | new prop `assetUnavailableReason?: (asset: MediaAssetView) => string \| undefined`; an asset it names shows as unavailable with that line, as an asset `unavailableReason` names does today, and `commit` refuses it. `components/builder/media/MediaSlot.tsx` passes `(asset) => assetUnavailableReason({ kind, mimeType, mediaFormat }, platforms)` from the asset's own fields, so a file the declared platforms cannot all play reads `Web Apps can't play MP4 (HEVC)` or `No CommCare app can play this file` beside it |
| `MediaPickerDialog.tsx`, the Upload tab | `MediaSlot.tsx` passes the existing `unavailableReason` prop as `(mimeType) => formatUnavailableReason(mimeType, platforms)`, which leaves a format none of whose variants plays on every declared platform out of `accept` and refuses a dropped one with part 04 §6.4's sentence |
| `MediaPickerDialog.tsx` as the file manager (no `onPick`, opened from `components/ui/AccountMenu.tsx`) | each media asset of the Library shows `playsOnLine(asset.playsOn)` on a muted line when `playsOn` is present: the file manager belongs to no app, so it states where the file plays rather than whether this app can use it |

### 2.6 The split gesture

New method on `BlueprintMutations` (`lib/doc/hooks/useBlueprintMutations.ts`):

```ts
splitDatetimeQuestion: (
	uuid: Uuid,
) =>
	| { ok: true; dateUuid: Uuid; timeUuid: Uuid }
	| { ok: false; messages: string[] };
```

It runs `builderWriteAdmission`, then `planDatetimeSplit(get(), uuid)`; a planner refusal returns
`{ ok: false, messages: [plan.message] }` (announced on the announcing flavor). Then `guardedApply(
plan.mutations)` commits one batch as one undo step. Two people splitting the same question at once
mint the same derived UUIDs (pull request 3's identities), and the second save meets the server's
conflict rather than four questions.

A second new method inserts the split shape where a date and time question cannot be added:

```ts
addDatetimeAsTwoQuestions: (
	parentUuid: Uuid,
	field: { id: string; label: string },
	opts?: { atIndex?: number },
) =>
	| { ok: true; uuid: Uuid; dateUuid: Uuid; timeUuid: Uuid }
	| { ok: false; messages: string[] };
```

It runs `builderWriteAdmission`, builds the `addField` mutation of a `datetime` question as `addField`
builds it (the picker passes the id and label it mints for `datetime`, `NEW_FIELD_BUILDERS.datetime`),
applies it to a working copy, and runs `planDatetimeSplit` over that copy and the new question's
UUID. A planner refusal returns its message; otherwise `guardedApply([addField, ...plan.mutations])`
commits one batch as one undo step. The gate evaluates only the batch's result, which holds the
date question, the time question and the hidden value that joins them (the inserted question
converted, part 03 §2.11), and no date and time question, so it commits in an app that runs in Web
Apps. A fresh question has no reads, so the planner's `self-read-through-a-filter` refusal cannot
arise; the refusal arm stays for the planner's contract.

Placement:

- `FieldIdentitySection.tsx`, the field actions menu of a date and time question, above Convert
  type: `MenuItem` with icon `tablerArrowsSplit`, label `Ask for the date and the time separately`,
  description `Two questions that work in Web Apps, joined in a hidden value`. It calls the
  announcing flavor.
- The refusal row (§2.4): a ghost button labelled `Ask for the date and the time separately`. It
  calls the `inline` flavor and shows a refusal in the row.
- The insertion menu (§2.5), where Web Apps is declared: `Date and time (as two questions)`, which
  calls `addDatetimeAsTwoQuestions` on the announcing flavor.

On success the caller selects `dateUuid` (`useSelect`) and shows `showToast("info", "Now asking for
the date and the time separately", "A hidden value joins the two answers, so everything that read
this question reads the same date and time. Both new questions use its label, and you can give
each its own.")`; the insertion shows `showToast("info", "Added a date question and a time
question", "A hidden value joins the two answers into one date and time. Both questions use the
same label, and you can give each its own.")`. A refusal reads `Nova couldn't split this question.
<first message>`, with nothing appended: every planner and gate message already names its next
step (part 03 §2.11's refusal messages, `guardedApply`'s builder lines).

### 2.7 The Connect dialogs

Both the app-wide manager (`components/builder/detail/appSettings/ConnectManagerDialog.tsx`) and the
per-form enable dialog (`ConnectEnableDialog.tsx`, opened from `formSettings/ConnectSection.tsx`,
`LearnConfig.tsx` and `DeliverConfig.tsx`) commit through `lib/session/store.ts::switchConnectMode`.

**The store.** `switchConnectMode`, when `type !== null`, `currentType === undefined` and
`declaresWebApps(docState)`, prepends `{ kind: "setAppSettings", settings: { runsOnlyOn: "android"
} }` to `plan.mutations` before its verdict, so Connect and the declaration commit as one batch and
one undo step. A mode switch between Learn and Deliver adds nothing (a Connect app already declares
Android only), and turning Connect off adds nothing: the declaration stays Android only.

**The line.** While Connect is off and the app declares Web Apps, each dialog shows, under its
opening paragraph, `Connect workers open this app in the Connect app on Android, so turning on
Connect sets it to run on Android only.`

**The turn-off line.** `ConnectManagerDialog.tsx::turnOff` commits and closes the dialog at once,
so the consequence is stated before, not after: while Connect is on and the app declares Android
only, the manager dialog shows, on a muted line above its footer, `Turning off Connect keeps this
app running on Android only. You can change where it runs in App settings.` Reason: the person
should know, where they act, that the app stays on Android after Connect goes, and where to change
that.

**The check.** An app declaring Web Apps only gains Android by this change, so on opening while
Connect is off each dialog runs §2.3's barrier and preflight with `runsOnlyOn: "android"`. While it
runs, Enable is disabled and the hint reads `Checking this app…`. A refusal puts each row's line into
the dialog's `RejectionNoticeBlock` (no Open links: the dialog is modal and a link would leave it),
keeps Enable disabled, and the hint reads `Once these change, you can turn on Connect.` An app
declaring both needs no check (the change only removes Web Apps).

### 2.8 The platform note row

New `components/builder/shared/PlatformNoteRow.tsx::PlatformNoteRow({ features, stated }: {
features: readonly PlatformFeatureId[]; stated?: readonly PlatformFeatureId[] })`. For each
distinct feature of `features`, in `PLATFORM_FEATURES` order, whose reading on some declared
platform is `different` or `ignored`, and for each feature of `stated` whatever its reading, it
renders one muted paragraph, `platformSentence(feature, declared)` (part 01 §2.3), when that
sentence is not empty, styled `text-[13px] leading-relaxed text-nova-text-muted`, with no icon and
no dismiss. It renders nothing when no feature qualifies. It is permanent: the difference is a
property of the app on that platform, not a notice to acknowledge.

A new helper, `components/builder/shared/platformNotes.ts::platformFeaturesOf(doc, owner)`, filters
`lib/domain/platformUses.ts::platformFeatureUses(doc)` by owner identity, matching part 01 §3's
`PlatformFeatureOwner` (`app`, `module`, `form`, `field`, `option`, `column`, `search-input`,
`entry-point`); a field owner also collects the uses of its options. Each mount then keeps the
features its row below names. A second helper, `platformNotes.ts::readsSearchFieldInSearchFirstForm(
doc, fieldUuid)`, is true when the field's own expression slots hold an `input` term
(`lib/domain/referenceSlots.ts::expressionSlotValues`, `walkExpressionTerms`) and its module opens
on Search (`lib/domain/modules.ts::moduleOpensOnSearch`); the field inspector then passes
`stated: ["search-first"]`. That is the one `stated` mount: `search-first`'s Web Apps reading is
`runs`, so the general rule would never show its note, and the note (a form opened from a link or an
entry point reads each Search field's starting value, part 01 §4.1, part 03 §4.2) matters exactly
beside the read it changes. Mounts:

| Mount | Owner | Features it can show |
|---|---|---|
| `components/builder/editor/FieldInspectorBody.tsx`, between `FieldIdentitySection` and `FieldEditorPanel` | the field and its options | every feature of the field's uses (the capture, location and barcode kinds, choice and help media, and the expression-leaf features in its slots), and `search-first` as `stated` where `readsSearchFieldInSearchFirstForm` holds |
| `components/builder/editor/SectionInspectorBody.tsx` | the section | `question-pages` |
| `components/builder/form-links/FallbackChooser.tsx`, under its items when App home or First menu is offered | the form | `after-submit-home` |
| `components/builder/detail/moduleSettings/ModuleSettingsPanel.tsx` | the module | `case-list-menu-item` |
| `components/builder/app-setup/DeepLinksSection.tsx`, per entry point | the entry point (`entry-point` owner) | `entry-points` |
| `components/builder/detail/appSettings/AppSavedFormsSection.tsx`, under each switch | the app | `saved-forms`, `incomplete-forms` |
| `components/builder/detail/appSettings/AppAppearanceSection.tsx` | the app | `app-logo` |
| `components/builder/case-list-config/inspector/SearchPanelInspectorBody.tsx` | the module, its Search screen | `search`, `search-screen-text`, `skip-to-results` |
| `components/builder/case-list-config/inspector/SearchInputEditor.tsx` | that Search field (`search-input` owner) | `search-screen-text` (its hint), `search-field-checks`, `barcode-search-field`, `hidden-search-field`, and the expression-leaf features of its values |
| `components/builder/case-list-config/ColumnEditor.tsx` | that column (`column` owner) | `link-column`, `column-hidden-from-results`, and the expression-leaf features of its value |
| `components/builder/case-list-config/tile/TileGroupingSection.tsx` | the module | `tile-grouping` |
| `components/builder/case-list-config/tile/TileCellInspector.tsx` | that cell's column (`column` owner) | `tile-alignment`, `tile-border-and-shading` |

`connect-location-capture` has no mount: while a Connect app declares Android only its Web Apps cell
cannot be reached (part 01 §10.3).

### 2.9 Builder copy that moves onto the table

Copy that states a table feature's difference is replaced by the note row of §2.8 and loses its
platform clause:

| File | Today | From step 4 |
|---|---|---|
| `detail/appSettings/AppSavedFormsSection.tsx`, Show saved forms | `Workers can look back at forms they have sent, from the Android home screen.` | `Workers can look back at forms they have sent.` and the `saved-forms` note row |
| same, Show incomplete forms | `Workers can pick up a form they started and left unfinished, on Android and in Web Apps.` | `Workers can pick up a form they started and left unfinished.` and the `incomplete-forms` note row |
| `form-links/afterSubmitCopy.ts::FIRST_MENU_HELP` | `Opens the app's first menu, which lists its modules. On Android, App home opens the app's home screen, and First menu opens that list.` | `Opens the app's first menu, which lists its modules` and the `after-submit-home` note row in `FallbackChooser` |
| `case-list-config/cards/column/LinkColumnCard.tsx` | `Every row shows this same wording. It stays in one language, and CommCare Android shows the address as plain text rather than a link.` | `Every row shows this same wording, in one language.` and the `link-column` note row in `ColumnEditor` |
| `case-list-config/inspector/SearchInputEditor.tsx`, Required hint | `Checked in the browser app. On a phone the search runs either way` | no hint; the `search-field-checks` note row |
| same, Check on the answer hint (with a rule) | `Checked in the browser app once an answer is given. On a phone the search runs either way` | `Checked once an answer is given`; the `search-field-checks` note row |
| `case-list-config/canvas/NoMatchesFormSetting.tsx`, the opens-on-Search arm | `The action and the carried answers work in the browser app. A phone never shows Results for an empty search.` | removed: from step 4 a module opens on Search only in an app that does not declare Android, where the sentence's phone clause cannot apply and its first clause says nothing a Web Apps author needs |
| `case-list-config/noMatchesFormReview.tsx` | `This works in the browser app. A phone never shows Results for an empty search.` | removed, for the same reason |
| `detail/appSettings/AppAppearanceSection.tsx` | pull request 9's line (part 06 §17): `Your logo shows in Preview when it runs as Web Apps. Web Apps shows it once you add it in this app's settings in CommCare HQ, and Android doesn't show it.` | where Web Apps is declared, `Your logo shows in Preview when it runs as Web Apps. Web Apps shows it once you add it in this app's settings in CommCare HQ.`, with the Android clause carried by the `app-logo` note row when the app also declares Android; absent in an Android-only app, where the note row alone states it |

Copy that states a configuration's consequence on each platform keeps its words and shows only the
declared platforms' clauses. Each constant becomes a function of `platforms: readonly Platform[]`;
for both platforms it returns today's sentence unchanged:

| Constant | Android only | Web Apps only |
|---|---|---|
| `conditions/displayConditionCopy.ts::FORM_OFF_THE_MENU_NOTE` | `Off the menu. On Android this form opens from an after-submit link or an entry point.` | `Off the menu. In Web Apps this form opens only from an entry point that ignores display conditions.` |
| `conditions/displayConditionCopy.ts::MODULE_OFF_THE_MENU_NOTE` | `Off the menu, with every form in it. On Android its forms open from an after-submit link or an entry point.` | `Off the menu, with every form in it. In Web Apps its forms open only from an entry point that ignores display conditions.` |
| `form-links/afterSubmitCopy.ts::hiddenTargetLine`, form by condition | `When this form's display condition is false for a worker, Android still opens it after submit.` | `When this form's display condition is false for a worker, Web Apps opens the module that holds it instead.` |
| same, module by condition | `When this module's display condition is false for a worker, Android opens it with nothing in it.` | `When this module's display condition is false for a worker, Web Apps opens the app's first screen instead.` |
| same, inside a module off the menu | `This form's module is off the menu. Android still opens the form after submit.` | `This form's module is off the menu. Web Apps opens the app's first screen instead.` |
| same, form off the menu | `This form is off the menu. Android still opens it after submit.` | `This form is off the menu. Web Apps opens the module that holds it instead.` |
| `case-list-config/tile/tileModel.ts::groupingReopenNotice(grouping)`, the unfinished-form sentence | unchanged | absent |
| `case-list-config/inspector/SearchInputEditor.tsx::FREE_TEXT_QUOTE_MARKS_HINT` | unchanged | absent |

The constants are renamed to functions (`formOffTheMenuNote(platforms)`,
`moduleOffTheMenuNote(platforms)`; `freeTextQuoteMarksHint(platforms)`), the two functions gain the
parameter (`hiddenTargetLine(visibility, insideHiddenModule, platforms)`;
`groupingReopenNotice(grouping, platforms)`, which keeps its name and returns `null` when Android
is not declared, as it does today without a grouping), and every caller passes
`useDeclaredPlatforms()`. Model-facing copy keeps its words (decision 8):
`lib/agent/tools/updateForm.ts`, `createForm.ts`, `updateModule.ts`, `entry-points.ts`,
`form-links/shared.ts`, `case-list-config/shared.ts`, `media/setAppLogo.ts` and `updateApp.ts`'s two
existing settings descriptions.

### 2.10 Tests

Vitest (no Postgres unless named; each pairs its refusal with the admitted case, `docs/testing.md`):

- `lib/doc/__tests__/platformOfferParity.test.ts`: the offer and the gate agree at the offering
  sites' own batches (part 01 §9 holds `platformRefusal` to the gate per feature over its fixtures;
  this test holds the batches the builder actually dispatches). For each offering site's feature (a
  `datetime` field added by `addField`, `selection: { kind: "multiple" }`, `searchFirst: true`, a
  `date` and a `multi-select` Search field, a no-matches registration entry) and each declaration,
  over a minimal admitted document built with `lib/__tests__/docHelpers.ts::buildDoc`:
  `platformRefusal(feature, declaredPlatforms(doc)) !== undefined` if and only if
  `mutationCommitVerdict` refuses the minimal batch that adds it. The platform section's Connect
  line is held the same way: in a Connect app, for each of the three choices,
  `platformRefusal("connect-app", <the choice's platforms>) !== undefined` if and only if the gate
  refuses the `setAppSettings` that makes it. Where a refusal is defined, the test also asserts
  that `platformPickerLine` of it is the two-sentence line part 01 §2.3 gives that feature, so a
  site that passes a bare platform, or drops the row's own line, fails. A site wired to the wrong
  feature, or a gate change that the table does not carry, fails here.
- `lib/doc/__tests__/commitVerdicts.test.ts` (extend): `expressionEditVerdict` of a `here` candidate
  in a both app's calculated column refuses with `platform: { feature: "case-list-here", platform:
  "web-apps" }`, and admits it in an Android-only app; a `here` candidate in a form slot refuses
  with no `platform` (its profile reason). Catches a value menu that shows the profile reason as a
  platform line, or the reverse.
- `components/builder/shared/__tests__/workbenchAdmission.test.ts` (extend): the admission
  `workbenchExpressionAdmission` builds for the same `here` candidate in a both app's calculated
  column is refused with `platform: { feature: "case-list-here", platform: "web-apps" }`, and the
  form-slot candidate's refusal has no `platform`. Catches an admission that drops `platform` on its
  way from the verdict to the menu, which would show the agent-voice reason in a builder menu.
- `lib/doc/__tests__/splitDatetimeQuestion.test.ts`, through `createBlueprintMutations` as
  `blueprintMutationCommands.test.ts` drives it: the split commits one batch that one undo reverts to
  the original document; a planner refusal commits nothing and returns its message; the `inline`
  flavor raises no toast. `addDatetimeAsTwoQuestions` in a both app commits one batch holding a date
  question, a time question and the hidden value that joins them, and no date and time question,
  that one undo removes whole; the plain `addField` of a `datetime` question in the same app is
  refused.
- `lib/session/__tests__/switchConnectModePlatforms.test.ts`, over the store
  (`lib/session/__tests__/store.test.ts`'s harness): enabling Learn on a both app commits Connect and
  `runsOnlyOn: "android"` as one undo step; turning Connect off leaves `runsOnlyOn: "android"`; a
  Learn to Deliver switch adds no settings mutation; enabling on a Web-Apps-only app whose module is
  search first returns the gate's findings and commits nothing.
- `components/builder/shared/__tests__/findingDestination.test.ts`: each finding shape opens its
  destination (operation, form link, display condition, field, the two `details.feature` arms for
  Search and case list, module), against a recording `NavigateActions`; `commitReviewBlocker`'s
  cases keep their destinations, a chosen-case finding (`SESSION_DATUM_NOT_SUPPLIED`, with
  `details.carrier`) among them, which keeps the destination it has today.
- `components/builder/conditions/__tests__/displayConditionCopy.test.ts` and
  `components/builder/form-links/__tests__/linkSentence.test.ts` (extend): each per-platform function
  returns today's sentence for both platforms and the table's sentence for each one.
- `lib/codemirror/__tests__/xpath-autocomplete.test.ts` (extend): in a slot whose profile admits
  each (pull request 10's offering, part 03 §6.5), `session/data/stringquery` is offered in an
  Android-only app on a one-list entry and not in a both app; under outcome A,
  `session/context/window_width` is offered in a Web-Apps-only app's module filter and not in a both
  app's. Catches a completion the declaration's checker would refuse.
- `lib/doc/__tests__/platformChangePreflight.postgres.test.ts`, real Postgres, through
  `readPlatformChangePreflight(input, userId)`, the action's body under its session wrapper: an
  Android-only app holding a date and time question, asked for `null`, returns `refused` with one row whose `finding.location.fieldUuid` is the question and whose line is
  its builder line; an Android-only app whose field label media is a file only Android plays (a
  part 04 variant whose `playsOn` is `["android"]`), asked for `null`, returns that media row with
  its location and the line `describeUnplayableReferences` gives for it; an app with
  neither returns `ok` with the app's `mutation_seq`; a non-member gets `not-found` and a viewer
  `forbidden`. Each test closes its pool in `finally`.

Playwright (`e2e/tests/app/`), each with one `@seed:` profile:

- `app-settings.spec.ts` gains "where workers use the app can be changed, and a question it can't
  run is named and split" (`@seed:open`, a both app): the insertion menu's Date/Time item is
  disabled with the text of `platformPickerLine({ feature: "datetime-question", platform:
  "web-apps" })`, the row's own line, and `Date and time (as two questions)` follows it; choosing
  `Android only` saves a `setAppSettings` with `"runsOnlyOn":"android"`; Date/Time is then offered and inserted; choosing `Web Apps and Android`
  shows `Web Apps can't run one thing this app uses` with the question's row; its Open selects the
  question and the block is still shown; its `Ask for the date and the time separately` adds the
  two questions and closes the block; choosing `Web Apps and Android` again saves
  `"runsOnlyOn":null`; after a reload the choice holds and the form shows the date question, the
  time question and the hidden value.
- `app-settings.spec.ts` gains "a date and a time can be asked for in an app that runs in Web Apps"
  (`@seed:open`): `Date and time (as two questions)` adds a date question, a time question and a
  hidden value in one step, selects the date question, and one undo removes all three.
- `app-settings.spec.ts` gains "a stated difference shows where the author works" (`@seed:open`):
  an Image question added from the insertion menu shows the `image-question` note row with both
  clauses; after choosing `Android only` the row is gone.
- `app-settings.spec.ts` gains "turning on Connect says it sets the app to Android only"
  (`@seed:open`): Connect's Set up dialog shows the line of §2.7 (the spec does not enable Connect).
- `app-settings.spec.ts` gains "turning off Connect keeps the app on Android only"
  (`@seed:connect-learn`, a new typed seed profile in `e2e/lib/smokeProfiles.ts` and
  `e2e/lib/smokeSeedFactory.ts`: one form taking part in Connect Learn, the app declaring Android
  only): the manager dialog shows §2.7's turn-off line; after `Turn off Connect`, App settings shows
  `Android only` chosen.
- New `platform-offering.spec.ts` (`@seed:workspace`, whose app declares Android as pull request 4
  leaves the seed, part 01 §11.3, and has a searchable case list): the Search settings' Search
  first switch, the Last visit Search field's Date picker type and Results' Several cases are each
  disabled with the text of `platformPickerLine({ feature, platform: "android" })` for its feature
  (`search-first`, `search-field-single-date`, `several-cases`). The three features read
  `unavailable` on Android, so the spec holds whether the seed declares both or Android only.
- `platform-offering.spec.ts` gains "a change that strands search first lists it" (`@seed:search-first`,
  a Web-Apps-only app as pull request 4 leaves the seed): choosing `Web Apps and Android` shows
  `Android can't run` with the Search first row; its Open opens the module's Search settings.

`config/smoke-execution.json` stays as it is (jobs and workers only); the new spec joins the suite by
discovery.

## 3. The SA and MCP (pull request 12)

### 3.1 Today

- Field kinds reach the model through one static `z.enum` on `addFields` and `editField`
  (`lib/agent/toolSchemaGenerator.ts::makeKindEnum`) and through the guide's field list
  (`lib/agent/authoring/reference.ts::fields`, from `fieldRegistry[kind].saDocs`).
- The prompts are static (`lib/agent/prompts.ts`); their only platform sentence is `PURPOSE`'s "Make
  choices that serve the user's actual setting, including language, connectivity, and the device they
  use."
- The app state travels after the cache boundary as `appOverview(doc)`
  (`lib/agent/appOverview.ts`), which MCP `get_app` also returns (`lib/mcp/tools/getApp.ts`).
- The guide teaches several-case forms and search first unconditionally
  (`AUTHORING_REFERENCE.workflows`), and `datetime`'s `saDocs` is "Combined date + time picker."; the
  capture kinds' `saDocs` say Web Apps has no camera.
- `updateApp` sets the name and the two form-list settings (`lib/agent/tools/updateApp.ts`).
- The architect holds `askQuestions` in every phase and `updateApp` once building
  (`lib/agent/build/authoringTools.ts::architectToolDefinitions`).

### 3.2 Static schemas, and why

Decision 1. A per-declaration schema would change, mid-build, the architect's `toolsetDigest` the
moment it narrows the app, so `readLatestPredecessorItems` would strip the compaction checkpoint and
replay the whole history uncompacted; it would break `lib/agent/CLAUDE.md`'s "its shared catalog
remains stable across first save"; MCP serves one schema per tool and an app is an argument of the
call; and `scripts/inspect-tool-schema-hashes.ts` and `scripts/test-schema.ts` assume one schema per
tool. The model instead reads the declaration from the overview (§3.6) and the guide (§3.4), meets a
refused use at the call that introduced it (staged findings, `updateApp`'s pre-checks of §3.3, the
field-kind pre-check of §3.7), and changes
the declaration with `updateApp` (§3.3).

### 3.3 `updateApp`'s `runs_only_on`

`lib/agent/tools/updateApp.ts`:

```ts
runs_only_on: z
	.enum(["web-apps", "android"])
	.nullable()
	.optional()
	.describe(
		"Where workers use this app when it runs on only one platform: web-apps for Web Apps in a browser, android for the CommCare app on Android. null returns the app to both, which is how a new app starts. A change is refused while the app holds something the result can't run, and the refusal names each. Change it only when the person has said where their workers use the app, or the request needs a feature that runs on only one platform. Leave it out to keep the current setting.",
	),
```

- The tool `description` becomes `Set the app's display name, whether workers see their saved forms
  and their incomplete forms, and whether it runs only in Web Apps or only on Android. Anything left
  out keeps its value.`
- `UPDATE_APP_EMPTY_INPUT_MESSAGE` becomes `This call named nothing to change, so the app is as it
  was. update_app sets the display name (name), whether workers see saved forms (show_saved_forms),
  whether they see incomplete forms (show_incomplete_forms) and where the app runs (runs_only_on); a
  call needs at least one of them.`
- `changedSettings(input, current)` returns `AppSettingsPatch` (`lib/domain/blueprint.ts`, its
  type from pull request 4, part 01 §1.2). For `runs_only_on`: absent changes nothing; `null` sets `runsOnlyOn: null` when `current.runsOnlyOn !== undefined`; a value sets it
  when it differs from `current.runsOnlyOn`.
- When the patch adds a platform (the declared platforms of the candidate,
  `applyToDoc(doc, mutations)`, hold one the document's lack), `execute` pre-checks the candidate
  before `guardedMutate`, content first, and returns the first refusal as `{ error }` without
  staging (decision 11). Reason: private work stages a batch whatever its findings and reports them
  as diagnostics, so `guardedMutate` alone would stage a change the description says is refused.
  - Content: `lib/agent/tools/shared/platformPrecheck.ts::declarationPlatformRefusal(doc, mutations,
    lookupContext)`. When `unavailableUses(candidate, declaredPlatforms(candidate))` (part 01 §3,
    structural and expression-leaf uses alike) is empty it returns `undefined`. Otherwise it runs
    `lib/doc/commitVerdicts.ts::mutationCommitVerdict(doc, mutations, lookupContext)` and keeps the
    findings that carry `details.feature`: the `PLATFORM_FEATURE_UNAVAILABLE` findings of the
    structural rule (part 01 §5) and the checker's `platform-unavailable` findings at each
    expression leaf (part 01 §6), whose messages are `platformRefusalMessage` text with each
    owner's or slot's own subject. It returns `describeCommitFindings` of those findings, the frame
    a refusal at `saveWork` uses, so the two read the same. `lookupContext` is built as
    `lib/agent/change-set/workspace.ts::ChangeSetMutationWorkspace.lookupContextFor` builds it:
    `ctx.lookupDefinitions` over `unionLookupReferenceTargetSets` of `extractLookupReferenceTargets`
    of the document and the candidate (`lib/doc/lookupReferences.ts`), and
    `LOOKUP_CONTEXT_UNAVAILABLE` when there are none or the host gives no `lookupDefinitions`.
  - Media: `execute` resolves the Project as `lib/agent/tools/media/shared.ts` does
    (`ctx.projectId`, or `loadAppProjectId(ctx.appId)`), runs `mediaDeclarationVerdict({
    projectId, doc: candidate })` (no `db`), and on a refusal returns `{ error:
    describeUnplayableReferences(references) }`: the kernel's own refusal text (part 04 §6.1,
    §6.2), which names every carrier with its format and ends "You can replace it or remove it,
    then try again." for one reference and "You can replace or remove them, then try again." for
    several, so the pre-check and a refusal at `saveWork` read the same. Part 04 §6.5 notes
    this pre-check.
- A patch that adds no platform skips both pre-checks: it can strand nothing (decision 4). Every
  patch that passes them, or skips them, stages through `guardedMutate` as today.
- `lib/agent/tools/shared/toolCallSummary.ts::ToolCallSummary` gains `platforms?: "both" |
  Platform`, the resulting declaration, set when the call changed it; `lib/chat/toolSummary.ts::
  updateAppLocation` appends `Runs in Web Apps and on Android`, `Runs only in Web Apps` or `Runs only
  on Android` to its parts, after the form-list phrases; `updateAppAction`'s comment names the new
  setting.

Scopes: `update_app` stays `requires: "edit"` under the route's `nova.write`; it touches no HQ state,
so `lib/mcp/scopes.ts::oauthScopeChallenge` does not apply.

### 3.4 The guide

`lib/agent/authoring/reference.ts`, `AUTHORING_REFERENCE.workflows`, a new second paragraph after
"Design forms around the worker's tasks…", verbatim:

> Where workers use the app decides what it can hold. A CommCare app can run in Web Apps, the browser
> app on CommCare HQ, and in the CommCare app on Android phones and tablets. A new app runs on both;
> the overview's platforms names where the current app runs, and its notOffered lists the features
> refused there. The guides say where a feature behaves differently on each platform. Running on only
> one platform is the person's decision, never a side effect of a feature you chose. When a requested
> workflow needs a feature only one platform runs, offer a design that runs on both when one serves
> the request, and otherwise ask where their workers use the app before narrowing it. When you cannot
> ask and the request itself names such a feature, narrow to the platform it needs and state that
> choice in the plan and your summary. Never narrow an app to clear a refusal the request did not
> cause. updateApp's runs_only_on narrows the app to web-apps or android, and null returns it to
> both; each change is refused while the app holds something the result can't run, and the refusal
> names each. Web Apps has no entry for a date and time question, so in an app that runs in Web Apps,
> ask for a date and a time as a date question and a time question, and join them in a hidden value
> calculated as date(format-date(if(#form/visit_date = '' or #form/visit_time = '', '',
> concat(#form/visit_date, 'T', #form/visit_time)), '%Y-%m-%dT%H:%M:%S.%3%Z')). That hidden value is
> a date and time: rules compare it as one, and it can save to a date-and-time case property. A
> CommCare Connect app runs on Android only, because Connect workers open it in the Connect app: set
> the app to Android only before you turn on Connect. Preview, app tests and form checks run on one
> of the app's platforms at a time, Web Apps unless you choose Android; check a difference on each
> platform the app runs on.

(The paragraph is one line in the source; it is wrapped here for reading.) It joins three designs
into one paragraph: the declaration's teaching, the split's guide sentence, and the Connect rule. The
calculate is the one shape pull request 3's rules R2 and R3 recognize (`lib/domain/expression/
datePattern.ts::isClockKeepingDate`).

Generated sentences, each `platformSentence(feature, PLATFORMS)` in part 01 §2.3's frame, placed
right after the sentence that introduces the feature, so its referent is the sentence before it.
The last column shows what part 01's rows (§4.1, §4.2) generate at pull request 12's head, for
reading only: the words are part 01's, and a change to a row changes the guide.

| Topic | After | Feature | Generated at pull request 12's head |
|---|---|---|---|
| `workflows` | "A several-case form applies one shared answer to each selected record." | `several-cases` | `Not available on Android: the menu stops at the home screen, so a worker can't reach the form. You can let workers choose one case at a time.` |
| `workflows` | "Search-first workflows begin with Search." | `search-first` | `In Web Apps, a form opened from a link or an entry point reads each Search field's starting value, not what the worker searched for. Not available on Android: a worker can open only a case the phone already holds. You can show the case list first and let workers search from it.` |
| `expressions` | "here() is the worker's current GPS position, a geopoint, available only in a calculated Results or Details column." | `case-list-here` | `Not available in Web Apps: the worker's location isn't known there, so here() reads blank, or a fixed place while the list is built.` |
| `expressions` | the context paragraph's `drift` sentence (pull request 10's, §3.9) | `clock-drift` | `In Web Apps, it's always 0. On Android, the whole hours the phone's clock was ahead of the server's when it last reached the server.` |
| `expressions` | the context paragraph's `applanguage` sentence (§3.9) | `app-language` | `In Web Apps, it's the worker's language in menus and case lists and when a form opens, and may differ on later answers in a form.` |
| `expressions` | the context paragraph's `window_width` sentence (§3.9) | `window-width` (and, under outcome B of part 03 §6.4, `window-width-in-search` after it) | outcome A: `In Web Apps, the width of the worker's browser window, sent each time a menu or a list loads. Not available on Android: there's no window width, so a screen that reads it can't open.`; outcome B: `In Web Apps, the width when a menu, a list or a form opens, blank on later answers in a form. On Android, there's no window width, so it reads blank. In Web Apps, the width of the worker's browser window, sent with the menu request that builds the search. On Android, there's no window width, so the search value is blank.` |
| `expressions` | the new sentence below, after the context paragraph and its generated sentences | `case-list-search-text` | `Not available in Web Apps: the case list keeps no search text, so the read is always blank. On Android, the text the worker typed in the case list's search box, blank when there's none.` |
| `fields` (each kind's line) | the kind's `saDocs` | `featureForFieldKind(kind)` | e.g. `datetime: Combined date and time picker. Not available in Web Apps: there's no entry for a date and time, so a worker can't answer one. Ask for a date question and a time question instead, joined in a hidden value as the workflows guide shows.` |

The `here()` sentence keeps its words, and the platform is the generated sentence's to state, so the
guide holds no second here() sentence of its own (part 03 §3.2 cites this one). The three context
sentences are pull request 10's (§3.9); pull request 12 adds only the generated sentence after each. The case list
search text gets one new introducing sentence in `expressions`, part 03 §5.4's row with its platform
clause left to the generated sentence:

> In a form that opens after one case list, `instance('commcaresession')/session/data/stringquery`
> reads what the worker typed into that list's search box, blank when nothing.

The Search fields' two features are taught where Search inputs are taught, `lib/agent/tools/
case-list-config/shared.ts`'s input `type` description, which stays as it is (decision 8): the
overview's `notOffered` names both in an app that runs on Android, and the gate's refusal names the
field. `fields()` in `reference.ts` appends `platformSentenceForFieldKind(kind)`, a new export of
`lib/domain/platforms.ts` built on part 01's functions, that returns
`platformSentence(featureForFieldKind(kind), PLATFORMS)` when `featureForFieldKind(kind)` is
defined and the empty string otherwise, after each kind's `saDocs`, joined with a space.

`saDocs` that state one platform become platform-neutral (`lib/domain/fields/*.ts`):

| Kind | From step 4 |
|---|---|
| `datetime` | `Combined date and time picker.` |
| `image` | `Photo attachment. Name what to capture, such as "Photo of the meter", rather than how, because how the worker adds it depends on where the app runs.` |
| `audio` | `Audio attachment. Name what to capture, such as "Recording of the interview", rather than how.` |
| `video` | `Video attachment. Name what to capture, such as "Video of the demonstration", rather than how.` |
| `barcode` | `Barcode or QR code.` |
| `geopoint`, `file`, `signature` | unchanged (true on both) |

So `image: Photo attachment. …` followed by `image-question`'s generated sentence, `In Web Apps,
<note>. On Android, <note>.` over part 01 §4.2's notes (the Web Apps file types and 4 MB, the
camera or a chosen picture and 15 MB, as part 06 §16.3's `CAPTURE_LIMITS` holds them), is what the
model reads.

### 3.5 Prompts

`lib/agent/prompts.ts`:

- `PURPOSE`, its last sentence, from "Make choices that serve the user's actual setting, including
  language, connectivity, and the device they use." to `Make choices that serve the user's actual
  setting, including language, connectivity, and where workers use the app: Web Apps in a browser,
  the CommCare app on Android, or both, which decides the features it can use.` `PURPOSE` reaches
  the chat editor, the architect, the peer and MCP's prompts (`lib/mcp/prompts.ts::agentPromptSegments`).
- `ARCHITECT_BUILD_SEGMENTS`, segment `planning-and-building`, after its first paragraph's second
  sentence ("Explain the records, the work people do, and the choices that make the app useful."):
  `Open the plan with one line saying where workers use the app, in the form "Where workers use it:
  Web Apps and Android", "Web Apps only" or "Android only", followed by why: the user's words, their
  answer to your question, or the default when nothing requested needs one platform. Plan a feature
  that runs on only one platform only once this line names that platform.`
- Same segment, third paragraph, after "Read getWork for pending changes, findings, and the exact
  revision to save.": `Set runs_only_on with updateApp before adding a feature that runs on only
  one platform, as soon as the plan names that platform.` Reason: a new build declares both, so
  `addFields` refuses a date and time question (§3.7), and Search first or several cases stage with
  findings, until the app is narrowed; narrowing first means no one-platform build starts with a
  refusal.
- `ARCHITECT_PEER_SEGMENTS`, segment `peer-review`, after "Consult focused guidance for uncertain
  platform behavior.": `Check that the plan says where workers use the app and that every planned
  feature runs there. Question a narrowing to one platform that the user did not ask for or agree
  to, and a design that needs one platform when a design running on both would serve the request.`

Reason for the peer's sentence: without it the peer passes a plan naming search first in a new app,
which declares both, and the build fails at its first save, where the genesis gate refuses it.

### 3.6 The overview and the summary

`lib/agent/appOverview.ts::appOverview` gains, after `settings`:

```ts
platforms: declaredPlatforms(doc), // ["web-apps", "android"] | ["web-apps"] | ["android"]
notOffered: featuresNotOffered(doc), // string[]
```

`lib/domain/platforms.ts::featuresNotOffered(doc)` (new in this pull request, built on part 01's
functions) returns, for each `PLATFORM_FEATURES` row in table order whose
`unavailablePlatform(id, declaredPlatforms(doc))` is defined, `<label>, not in Web Apps` or
`<label>, not on Android` for that platform. `get_app` returns
both through `appOverview`. `lib/agent/summarizeBlueprint.ts::summarizeBlueprint` adds, after its
`Form lists:` line, `Runs on: Web Apps and Android`, `Runs on: Web Apps only` or `Runs on: Android
only` (`platformDeclarationLabel`). Both are read results, so they move no `MODEL_CONTEXT_VERSION`
(`lib/agent/CLAUDE.md`, "Provider contract": a field added to a read result is no input).

### 3.7 The pre-checks

New `lib/agent/tools/shared/platformPrecheck.ts::fieldKindPlatformRefusal(doc, formUuid, items:
readonly { kind: FieldKind; id: string }[]): string | undefined`: for each item whose
`featureForFieldKind(kind)` is defined and whose `platformRefusal(feature, declaredPlatforms(doc))`
is defined, part 01's `platformRefusalMessage({ feature, platform, platforms:
declaredPlatforms(doc), subject })` with the subject the platform rule gives a field, `Question
"<id>" in form "<formName>"` (part 01 §5); all joined with a newline. The pre-check writes no
sentence of its own: it returns the message the gate's `PLATFORM_FEATURE_UNAVAILABLE` finding would
carry for the same question, so the two cannot drift. For a `datetime` item in a both app it is
part 01 §7's agent message: `Question "visit_time" in form "Register visit" is a date-and-time
question, and the app runs in Web Apps and on Android. Web Apps has no entry for a date and time, so
a worker there can't answer it, and a form that holds it may not submit. You can ask for a date
question and a time question instead, or, if workers use only the CommCare app on Android, set the
app to run only on Android (updateApp/update_app, runs_only_on "android").`

- `lib/agent/tools/addFields.ts`: after `assembleFieldMutations` succeeds and before
  `sectionPlacementRefusal`, `fieldKindPlatformRefusal(doc, formUuid, addedItems)`; a result
  returns `{ error }` with no mutation, naming every refused item, as the placement pre-check does.
- `lib/agent/tools/editField.ts`: in the kind-change branch, after the `getConvertibleTypes` check,
  `fieldKindPlatformRefusal(doc, formUuid, [{ kind: newKind, id: currentId }])`.

The same module holds `updateApp`'s content pre-check, `declarationPlatformRefusal` (§3.3).

These change execution only: no schema, no description, no version move. The commit gate stays the
authority; a pre-check is what the model reads instead of a finding list.

### 3.8 The autonomous instruction

`lib/mcp/prompts.ts::INTERACTIVITY_INSTRUCTIONS.autonomous` appends ` When the request names a
feature that runs on only one platform, set the app to that platform and report it with your
assumptions; otherwise keep it running on both.` MCP-only prompt text is in no stored model context,
so it moves no version. The in-Nova architect always holds `askQuestions`, so it asks.

### 3.9 `MODEL_CONTEXT_VERSION`

`lib/models.ts::MODEL_CONTEXT_VERSION`, today `"v4-hq-round-trip-expressions.12"`, moves in each pull
request that changes a SA-offered tool's name, description or input schema, or the authoring guide
(`lib/agent/CLAUDE.md`, "Provider contract"). A prompt change alone does not move it: the separate
`promptVersion` digest of the system prompt (`lib/agent/build/orchestrator.ts`) already tells
checkpoints apart.

| Pull request | Why | Value |
|---|---|---|
| 8 | `startAppTest` and `evaluateForm` gain `platform` | `"v5-hq-round-trip-platforms.8"` |
| 10 | what an authored text accepts: `case-list-search-text` and the context fields; the guide's context paragraph and `#search/name` sentence (below) | `"v5-hq-round-trip-platforms.10"` |
| 12 | `updateApp`'s schema and description, the guide (§3.4, with its generated sentences and the `saDocs` it serves); the prompts of §3.5 ride the same pull request and `promptVersion` carries them | `"v5-hq-round-trip-platforms.12"`, the value the stack deploys |

**Pull request 10's guide text.** Part 03 lands two edits of `lib/agent/authoring/reference.ts`'s
`AUTHORING_REFERENCE.expressions` in pull request 10, under `"v5-hq-round-trip-platforms.10"` (part
03 §6.5, §11); their words are this part's, as the guide's other model-facing text is:

- **The context paragraph**, new, right after `${workerIdentityGuidance()}`, verbatim (one line in
  the source, wrapped here for reading). It gives each field its own sentence, so each generated
  sentence of §3.4 follows the sentence that introduces its field:

  > The device session supplies three more values. A form reads each by its path, and a record
  > expression as session('drift'), session('applanguage') or session('window_width').
  > instance('commcaresession')/session/context/drift is the device clock's offset from the
  > server's in whole hours, a whole number. instance('commcaresession')/session/context/applanguage
  > is the code of the language the worker is using; compare it with a language's commcareCode,
  > which getLanguages lists. instance('commcaresession')/session/context/window_width is the width
  > of the window the app is shown in, a whole number; a module's display condition, case list and
  > Search settings and a form's display condition can read it, and no rule a form evaluates can.

  Under outcome B of part 03 §6.4's gate, `window_width` is admitted wherever a context field is,
  so its sentence ends at "a whole number." Reason for the field-by-field shape: the model reads a
  field's platform difference right after the field, and the admission sentence is the one fact
  that keeps it from writing a `window_width` read that the checker refuses in a form.
- **The `#search/name` sentence**, part 03 §11's: "#search/name reads a Search answer in Search
  rules or that module's no-matches registration." becomes "#search/name reads a Search answer in
  Search rules, in the forms of a menu that opens on its search, and in that module's no-matches
  registration." The platform difference of those forms' reads is `search-first`'s generated
  sentence in `workflows` (§3.4), which names the starting value a link or an entry point reads.

Pull request 11 moves nothing. The overview, the summary line, the pre-checks and the autonomous
instruction move nothing. Because the guide's platform sentences are generated, a later change to a
platform note or remedy changes the guide's text and moves the version too; `lib/agent/authoring/
CLAUDE.md` says so (§5).

### 3.10 Served schemas and the billed check

Each of pull requests 11 and 12 runs `npx tsx --conditions=react-server
scripts/inspect-tool-schema-hashes.ts` (free, no network) at its base and head and records the rows
in its description: pull request 11 shows no tool moved; pull request 12 shows `updateApp` alone
moved. At pull request 12's head the same script is run against `main` `e9e6cd93`, and its moved set
is expected to be exactly `updateApp`, `evaluateForm` and `startAppTest` (the script hashes schemas,
not descriptions; `getAuthoringGuide` does not move, since the guide adds no topic).
`lib/mcp/__tests__/servedSchemas.test.ts` needs no edit: an enum adds no pattern.

`scripts/test-schema.ts`, the `updateApp` entry's prompt becomes `Use updateApp to name the app
'Village Health', set it to run only on Android, and turn its incomplete forms list on.`
`evaluateForm`'s prompt and `startAppTest`'s registration are pull request 8's.

The billed run: `npm run test:schema` sends one live request per schema and spends the person's
money, so pull request 12's head asks the person once, naming `updateApp`, `evaluateForm`,
`startAppTest` and any other tool the `main`-to-head hash run shows moved, with the cost (one live
request each). Each entry runs as `npm run test:schema -- <name>` only after that yes; nothing in the
stack runs it otherwise.

### 3.11 Tests

Vitest (no Postgres unless named):

- `lib/agent/tools/__tests__/updateApp.test.ts` (extend): `runs_only_on: "android"` stages
  `setAppSettings { runsOnlyOn: "android" }`; `null` on an Android-only app stages `runsOnlyOn:
  null`; the current value stages nothing and reports the no-op; `null` on an Android-only app holding
  a date and time question returns the content pre-check's refusal, whose text equals
  `describeCommitFindings` of the gate's own finding for that question, and records no mutation;
  the summary carries `platforms`.
- `lib/agent/tools/__tests__/updateAppMedia.postgres.test.ts`: real Postgres, driving `updateApp`
  through the production path, the private change set
  (`lib/agent/change-set/workspace.ts::ChangeSetMutationWorkspace.stageDispatch`, opened as
  `lib/agent/change-set/__tests__/changeSetRuntime.postgres.test.ts` opens it), where a batch with
  findings would otherwise stage. An Android-only app holding a date and time question,
  `runs_only_on: null`, returns the content refusal naming the question, and the change set gains
  no step; an Android-only app whose question label holds a file only Android plays, `runs_only_on:
  null`, returns exactly `describeUnplayableReferences` of that reference (§3.3), naming its carrier
  and format, and gains no step; the same app with a file both platforms play stages the change.
  Catches a pre-check that the harness's canonical host would mask, since that host refuses a gated
  batch on its own. Pools close in `finally`.
- `lib/agent/tools/__tests__/platformPrecheck.test.ts`: `addFields` with a `datetime` item in a both
  app returns the pre-check message and no mutation; in an Android-only app it stages; `editField`
  to `datetime` likewise; and parity: for each declaration, the pre-check refuses if and only if the
  gate refuses the same batch with the pre-check bypassed (called through `guardedMutate` directly),
  and its text equals the `message` of the gate's `PLATFORM_FEATURE_UNAVAILABLE` finding for that
  question. Catches a pre-check whose words drift from the gate's.
- `lib/agent/__tests__/appOverview.test.ts` (extend): `platforms` per declaration; `notOffered` holds
  every unavailable row's label with its suffix, computed from `PLATFORM_FEATURES`, and for a both app
  includes `${PLATFORM_FEATURES["datetime-question"].label}, not in Web Apps`.
- `lib/agent/__tests__/summarizeBlueprint-settings.test.ts` (extend): the `Runs on:` line per
  declaration.
- `lib/chat/__tests__/toolSummary.test.ts` (extend): the three phrases on `updateApp`'s location line,
  after the form-list phrases.
- `lib/agent/authoring/__tests__/platformGuide.test.ts`: every kind whose `featureForFieldKind` is
  defined has its line in `fields()` end with its generated sentence; each feature §3.4 interpolates,
  `case-list-search-text`, `clock-drift`, `app-language` and `window-width` included, appears, with
  its sentence, right after its introducing sentence.
  It pins the placement, not the prose.
- `lib/agent/authoring/__tests__/guideExamples.test.ts` (extend): the guide's join, written by
  `addFields` as a hidden value in a both app whose form asks `visit_date` and `visit_time`, commits
  and saves to a `datetime` case property, through the published grammar, the shared tool body and
  the commit gate, as the file's other examples do.

The prompts and the autonomous instruction get no test of their prose: a test pinning prompt text
proves only that the text was typed, and `docs/testing.md` asks for a distinguishing observation.

## 4. `../nova-plugin`

Swept at `14af38e` (v2.2.0, clean) with `rg -i "web apps|web_apps|android|cloudcare|datetime|date and
time|camera|platform|confirm_"` over `skills`, `agents` and `README.md`. No skill teaches field kinds,
capture, search first or several-case forms; `skills/build/SKILL.md`, `skills/edit/SKILL.md` and
`agents/nova-architect-autonomous.md` bootstrap the server's guidance, and their "observations report
platform fallback" is about languages, so they stay true. A second sweep, `rg -i "#search|search/|
no-matches|stringquery|window_width|session/context"` over the same paths, finds nothing, so the
guide sentences pull request 10 changes (part 03), among them where `#search/name` reads, make no
plugin text false. The sentences that become false from step 4 are all in
`skills/upload_to_hq/SKILL.md`, from pull requests 5 and 6's publish changes:

1. §6 "Report": the response shape lists `web_apps_enabled`, and its bullet says "`web_apps_enabled`:
   when it is `false`, the app is not in Web Apps on that project space. Say so, and relay the setup
   artifact's Web Apps note: once the project space's plan includes Web Apps, a person turns it on in
   the app's settings in CommCare HQ. Nova never changes that setting." From step 4 the response has
   no `web_apps_enabled`, and every publish writes the setting from where the app runs. The bullet
   goes; the shape loses the key.
2. "the check says what the upload will ask the user to confirm … `plan_features` …,
   `flat_location_fixture` … and `connect_forwarder`": from step 4 the check also reports the
   sync-on-form-entry confirmation for an app that runs on Android and has a menu with Search whose
   form works on a case (pull request 6's key, with part 05 §10's predicate; search first cannot
   trigger it, since it is unavailable on Android). The `web-apps` plan feature is a plan feature, so the
   `plan_features` clause already covers it.
3. `hq_confirmation_needed`: "a plan feature, the flat location list, or, for a Connect app, the
   Connect forwarder" gains the form-entry sync confirmation; the retry list "`confirm_plan_features`
   …, `confirm_flat_location_fixture: true` or `confirm_connect_forwarder: true`" gains
   `confirm_form_entry_sync_off: true`. The entry shape "`{kind, subject, label, plans,
   consequence, reasons}`" gains `where_missing` (part 05 §9, pull request 5; a string or null), and
   the sentence that asks about each one gains: `When the user says the project space lacks what
   was asked and where_missing is not null, relay it: it says what they can do there.` Every check
   row's fields in item 2 gain `where_missing` beside `consequence` the same way (part 05 §15: from
   pull request 5 every check row carries it). The plugin teaches the field because it is the one
   place the response offers the person a way forward, such as setting the app to Android only
   where the plan lacks Web Apps, and a skill that lists the shape without it describes a response
   the tool no longer gives (part 05 §16).
4. The retry paragraph's list "`confirm_plan_features`, `confirm_flat_location_fixture`,
   `confirm_connect_forwarder`, `adopt_resources` and `discard_hq_changes`" gains
   `confirm_form_entry_sync_off` and `confirm_web_apps`.
5. The refusal list has no entry for `hq_web_apps_change` (the target's Web Apps setting differs from
   where the app runs; ask the user, then retry with `confirm_web_apps`) or `hq_plan_lacks_web_apps`
   (a first publish of an app that runs in Web Apps to a project space whose plan lacks it: relay the
   message, which offers Android only where the content allows; changing where the app runs is the
   user's decision, made with `update_app`'s `runs_only_on`).
6. "This is a destination check, never a Nova authoring constraint. Do not remove, undo, avoid, or
   revise requested app functionality because of it." stays true, and gains: `When the project space's
   plan lacks Web Apps, the user may choose to set the app to Android only; never make that change
   unless they ask for it.`

The plugin pull request makes those edits, bumps `.claude-plugin/plugin.json` from `2.2.0` to
`2.3.0`, and merges only after the Nova deploy carrying pull requests 5, 6 and 12 is live. Pull
request 14 records the plugin pull request's link and repeats the sweep against the guide and tool
text the stack ships.

## 5. Subtree docs and public docs

Subtree `CLAUDE.md` sentences move with the code that makes them true (pull request in brackets):

- `components/builder/CLAUDE.md`, "Settings popovers" (11): a paragraph for `AppPlatformsSection`
  (first in the panel; removal-only changes commit through the client gate; a change adding a platform
  runs the save barrier and `platformChangePreflightAction`, compares `mutationSeq` and lists every
  stranded use with Open links from `findingOpenAction`, which keep the panel open); "Case-list workspace" (11): the
  disabled-with-reason sites of §2.5 and the note row mounts of §2.8; the session-context sentence,
  as pull request 10 leaves it (part 03 §6.5), gains "Each choice asks the slot's rule admission, so
  one the app's platforms refuse is disabled with the platform's picker line."; the paragraph on
  Convert type gains the split item, and the insertion menu's sentence gains `Date and time (as two
  questions)` where Web Apps is declared; the Connect paragraph gains §2.7's store behavior; the media
  paragraph gains the pickers' per-asset and per-format reasons and the file manager's "Plays on"
  line (§2.5); the comparison card's language-code picks join the case-type picker's sentence; and
  the three sentences §2.9's copy changes make false, as part 10's rows word them: the Search field
  editor's "Both say "Checked in the browser app. On a phone the search runs either way"…" (no
  platform hint; the `search-field-checks` note row), "Show on the menu" (`formOffTheMenuNote(
  platforms)`, each platform the app runs on) and the link editor's `hiddenTargetLine` sentence
  (`hiddenTargetLine(…, platforms)`).
- `lib/commcare/CLAUDE.md` (11): the no-matches form's "Web Apps only at runtime" bullet, whose
  closing clause "so author-facing copy says the action and the carried answers work in the browser
  app" is what §2.9 removes, takes part 10's replacement: the form exists only in a search-first
  module, which only an app that runs in Web Apps only holds, so its copy names no phone.
- `lib/codemirror/CLAUDE.md` (11): "No offer-then-reject" gains that a session read one platform
  lacks (`stringquery`, and `window_width` under part 03 §6.4's outcome A) is offered only where the
  slot's declared platforms admit it, beside the slot filter pull request 10 states.
- `lib/doc/CLAUDE.md` (11): `splitDatetimeQuestion` and `addDatetimeAsTwoQuestions` beside the
  other mutation methods, and
  `platformChangePreflight.ts` beside the rename preflight.
- `lib/agent/authoring/CLAUDE.md` (12): `Platform sentences in the guide are generated from
  lib/domain/platforms.ts, so a change to a platform note or remedy changes the guide and moves
  MODEL_CONTEXT_VERSION. The overview's platforms and notOffered come from the same table.`
- `lib/agent/CLAUDE.md` (12): the pre-check sentence, beside its staged-findings rule: `addFields`
  and `editField` refuse a field kind the app's platforms can't run before staging, and `updateApp`
  checks content and media before a change that adds a platform, each with the gate's own words
  (`tools/shared/platformPrecheck.ts`), because private work stages a batch whatever its findings.
- `lib/domain/CLAUDE.md` (12): the capture `saDocs` sentence ("Web Apps has no camera, microphone, or
  recorder, so every one says "attach" and none says "take" or "record".") becomes `Capture saDocs
  name what is captured; how the worker captures it is the platform table's note, appended by the
  guide.`

Public docs ride pull request 14 (the stack's docs pull request), each sentence below as written:

- `content/docs/mcp/tools.mdx`, the `update_app` row: `Set the app's name, whether workers see their
  saved forms and their incomplete forms, and whether it runs only in Web Apps or only on Android.`
- `content/docs/attachments.mdx`, one edit holding this part's and part 06's (part 06 §26 cites
  it):
  - "People attach files; they do not capture them": its first three paragraphs are replaced by
    `How a worker adds a file depends on where your app runs. In Web Apps, the browser app on
    CommCare HQ, every one of these questions except Signature opens the device's ordinary file
    picker. In the CommCare app on Android, the photo question opens the camera and the audio
    question records. So name what to capture, such as "Photo of the meter", and let each place ask
    for it its own way. In an app that runs only on Android, "Take a photo of the meter" is right.`
    The heading becomes `How workers add a file`.
  - "Limits": `**4 MB per file.**` becomes `**4 MB per file in Web Apps, 15 MB on Android.**`, the
    two limits part 06 §16.3's `CAPTURE_LIMITS` holds, and its paragraph's "the file the worker
    picks is the file that gets sent" stays true on both.
  - "In the builder": after "Run the preview and it becomes a working control: attach a real file,
    replace it, or use the visible **Remove** action, and it rides the submission with the rest of
    the form." comes `When Preview runs as Android, the Image question offers Take picture and Choose
    image, the Audio question offers Record sound, and the Video question offers Record video and
    Choose video, using your browser's camera and microphone, and a file can be up to 15 MB.` (part
    06 §16.2's controls).
- `content/docs/case-workspace.mdx`, the `here()` paragraph, one edit holding part 03's and part
  06's (part 03 §3.2 and part 06 §26 cite it), as written: `A calculated value can use here(), the
  worker's current location (**Where you are now** in its value menu), for example to show where
  the worker is, or to mark the cases within a set distance of them with within-distance. It works
  in an app that runs only on Android, because Web Apps never shares where the worker is with a case
  list. In Preview playing Android, your browser asks to share your location the first time a list
  on screen needs it. Until it does, those values stay blank, as they do on a device that has no
  location yet. As on an Android phone, the value holds four numbers, the latitude, the longitude,
  the altitude and the accuracy, and the list updates after you move more than 30 metres. Nova uses
  your location only to run the list and the case's details, and doesn't save or log it.` (with
  `here()` and `within-distance` in code spans as today).
- `content/docs/publishing.mdx`, the form-lists paragraph: `In your app's settings you can show
  workers their saved forms and their incomplete forms. A publish writes both to CommCare HQ.`, the
  platform differences now shown in App settings.
- A new page, `content/docs/where-workers-use-your-app.mdx`, listed in `content/docs/meta.json` after
  `building-with-nova`, with three sections: "The three choices" (§2.2's rows and lines); "What each
  choice offers" (the features one platform cannot run, from part 01 §4.1's rows: search first,
  several cases, the date picker and multiple choice Search fields and, while part 03 §6.4's gate
  keeps it unavailable there, the window width cannot run on Android; the date and time question,
  Where you are now in a Results or Details column, the case list search text and CommCare Connect
  cannot run in Web Apps; the builder shows each one disabled with the reason); "Asking for a date and a time in Web Apps"
  (the insertion menu's `Date and time (as two questions)`, the split gesture on an existing
  question, and what each does, in §2.6's toast words).

## 6. Files by pull request

**Pull request 11, the builder.**

New: `components/builder/detail/appSettings/AppPlatformsSection.tsx`,
`components/builder/shared/PlatformNoteRow.tsx`, `components/builder/shared/platformNotes.ts`,
`components/builder/shared/findingDestination.ts`, `lib/doc/hooks/useDeclaredPlatforms.ts`,
`lib/doc/platformChangePreflight.ts`, `lib/doc/platformChangePreflightRead.ts`,
`lib/doc/platformChangePreflightTypes.ts`, `components/builder/shared/cards/AppLanguageValuePicker.tsx`,
and the tests of §2.10.

Changed: `lib/media/attachVerdicts.ts` (`mediaDeclarationVerdict`), `lib/db/mediaAssets.ts`
(`loadAssetsByIds`'s optional `db`), `lib/doc/commitVerdicts.ts` (`expressionEditVerdict`'s
`platform`), `lib/doc/hooks/useBlueprintMutations.ts` (`splitDatetimeQuestion`,
`addDatetimeAsTwoQuestions`), `lib/session/store.ts` (`switchConnectMode`),
`lib/codemirror/expressionEditorContext.ts` (the declaration filter);
`components/builder/detail/appSettings/AppSettingsPanel.tsx`, `AppSavedFormsSection.tsx`,
`AppAppearanceSection.tsx`, `ConnectManagerDialog.tsx`, `ConnectEnableDialog.tsx`;
`components/preview/form/FieldTypePicker.tsx`; `components/builder/editor/FieldIdentitySection.tsx`,
`FieldInspectorBody.tsx`, `SectionInspectorBody.tsx`; `components/builder/inspector/inspectorChrome.tsx`
(`ToggleRow`); `components/builder/case-list-config/CaseListConfigWorkspace.tsx`,
`canvas/CaseSelectionSetting.tsx`, `canvas/NoMatchesFormSetting.tsx`, `noMatchesFormReview.tsx`,
`inspector/SearchPanelInspectorBody.tsx`, `inspector/SearchInputEditor.tsx`, `ColumnEditor.tsx`,
`cards/column/LinkColumnCard.tsx`, `tile/TileGroupingSection.tsx`, `tile/TileCellInspector.tsx`,
`tile/tileModel.ts`; `components/builder/detail/formSettings/FormEntrySection.tsx`;
`components/builder/detail/moduleSettings/ModuleSettingsPanel.tsx`;
`components/builder/app-setup/DeepLinksSection.tsx`; `components/builder/form-links/afterSubmitCopy.ts`,
`FallbackChooser.tsx`, and their callers; `components/builder/conditions/displayConditionCopy.ts` and
its callers; `components/builder/shared/primitives/ExpressionPicker.tsx`,
`shared/cards/expression/TermCard.tsx`, `shared/cards/ComparisonCard.tsx`,
`shared/editorContext.tsx` (`ExpressionChangeAdmission`'s `platform`),
`shared/ExpressionCardEditor.tsx` (`admitRuntimeExpression`), `shared/workbenchAdmission.ts`;
`components/builder/media/MediaPickerDialog.tsx`, `MediaSlot.tsx`;
`e2e/tests/app/app-settings.spec.ts`, `e2e/lib/smokeProfiles.ts` and `e2e/lib/smokeSeedFactory.ts`
(the `connect-learn` profile); new `e2e/tests/app/platform-offering.spec.ts`; the `CLAUDE.md` rows of §5 marked 11.

**Pull request 12, the agent.**

New: `lib/agent/tools/shared/platformPrecheck.ts` (`fieldKindPlatformRefusal`,
`declarationPlatformRefusal`), and the tests of §3.11.

Changed: `lib/domain/platforms.ts` (`featuresNotOffered`, `platformSentenceForFieldKind`, both
built on part 01's functions);
`lib/domain/fields/datetime.ts`, `image.ts`, `audio.ts`, `video.ts`, `barcode.ts` (`saDocs`);
`lib/agent/authoring/reference.ts`; `lib/agent/prompts.ts`; `lib/agent/appOverview.ts`;
`lib/agent/summarizeBlueprint.ts`; `lib/agent/tools/updateApp.ts`, `addFields.ts`, `editField.ts`;
`lib/agent/tools/shared/toolCallSummary.ts`; `lib/chat/toolSummary.ts`; `lib/mcp/prompts.ts`;
`lib/models.ts`; `scripts/test-schema.ts`; the `CLAUDE.md` rows of §5 marked 12.

## 7. How this part lands in the stack

The stack is fifteen pull requests in one `gh stack` chain, merged together in one deploy.

- **Pull request 11, the builder:** §2 whole: the section and its preflight, the refusal block, every
  offering site, the split gesture, the Connect dialogs, the note rows, the moved copy, the
  `CLAUDE.md` rows marked 11, and §2.10's tests. Its description records that no served-schema hash
  moved. It reads pull requests 3, 4, 7 and 10's names (parts 03, 01, 04 and 03, §1).
- **Pull request 12, the agent:** §3 whole and the `CLAUDE.md` rows marked 12; its description
  records the hash runs of §3.10. The billed question is asked at its head, the last change to a
  tool or the guide in the stack.
- **Rides pull request 14:** the public docs of §5 and the `../nova-plugin` record of §4.

## What changes for authors

- **A new app runs on both platforms, so the builder disables, with a reason, every feature one of
  them can't run:** the date and time question, search first and its registration offer, several
  cases, the date picker and multiple choice Search fields, Where you are now in a column, the case
  list search text and, while part 03 §6.4's gate keeps it unavailable on Android, the window width.
  Choosing one platform in App settings offers them. Where the app runs in Web Apps, the insertion
  menu offers a date and a time as two questions, joined in a hidden value, in one step. Media
  pickers say which files this app's platforms can't play, and the file manager says where each
  file plays.
- **Changing where the app runs can be refused,** with every question, setting and file that stands
  in the way listed and a way to open each one. A date and time question can be split in one step.
- **Turning on Connect sets the app to Android only,** and the dialog says so before it happens.
  Turning it off keeps the app on Android only, and the dialog says that too, with where to change
  it.
- **Platform differences show where the author works,** as a permanent line, and only for the
  platforms the app runs on. A few existing sentences lose a clause that no longer applies.
- **The SA asks where workers use the app** when a request needs a one-platform feature, opens its
  plan with that line, and never narrows an app to clear a refusal it caused; an autonomous build
  narrows only for a feature the request named, and says so.
- **The capture guidance stops saying Web Apps has no camera:** the model names what to capture and
  reads each platform's way of capturing it.

## Executed during planning

Planning ran no test, build, Docker or lane. It read Nova at `main` `e9e6cd93` and `../nova-plugin` at
`14af38e` with `rg` and file reads, and searched the Dimagi checkouts at the pins named above with
`rg` (none switched). One read-only `python3 -I` read of `lib/commcare/surface/entries/*.json`
printed the platform cells of the entries behind §1's notes, to keep each note faithful to its
entry's reading; nothing was written.

Read for this part: `components/builder/detail/appSettings/*.tsx`, `lib/doc/hooks/
useBlueprintMutations.ts` (`guardedApply`, `reviewMany`, `commitMany`, the two flavors),
`lib/doc/hooks/useAppSettings.ts`, `lib/doc/commitVerdicts.ts` (`expressionEditVerdict`,
`caseListOrderChoiceRefusal`), `lib/doc/userFacingErrors.ts::offeredChoiceRefusal`,
`lib/preview/engine/casePropertyRenamePreflight.ts` and `components/builder/CasePropertyRenameDialog.tsx`
(the preflight and `mutationSeq` precedent), `lib/collab/reconciler.ts` (`waitForHumanSaveBarrier`,
`getSnapshot`, `watchNextHumanBatch`), `components/builder/app-setup/DeploymentEntryPointLinks.tsx`
(the barrier precedent), `lib/media/attachVerdicts.ts`, `lib/db/mediaAssets.ts`
(`loadAssetsByIds`, `lockAndValidateMediaReferences`), `lib/db/canonicalCommitKernel.ts`
(`admitExactMediaReferences`), `lib/domain/mediaRefs.ts` (`describeCarrier`, `MediaRefLocation`),
`components/preview/form/FieldTypePicker.tsx`, `components/builder/editor/FieldIdentitySection.tsx`,
`FieldInspectorBody.tsx`, `FieldEditorPanel.tsx`, `components/builder/inspector/inspectorChrome.tsx`,
`components/builder/case-list-config/` (the selection setting, the Search panel, the Search field
editor, the no-matches setting and review, the tile and column files,
`CaseListConfigWorkspace.tsx::commitReviewBlocker`), `components/builder/shared/primitives/
ExpressionPicker.tsx`, `expressionEditorSchemas.ts`, `sessionContextPresentation.ts`,
`cards/expression/TermCard.tsx`, `lib/codemirror/expressionEditorContext.ts` and
`xpath-autocomplete.ts`, `lib/routing/navigation.ts`, `lib/session/store.ts::switchConnectMode` and
`lib/session/hooks.tsx::useSwitchConnectMode`, `components/builder/form-links/afterSubmitCopy.ts`,
`components/builder/conditions/displayConditionCopy.ts`, `lib/agent/tools/updateApp.ts`,
`addFields.ts`, `editField.ts`, `media/shared.ts`, `shared/toolCallSummary.ts`,
`lib/chat/toolSummary.ts`, `lib/agent/authoring/reference.ts`, `lib/agent/prompts.ts`,
`lib/agent/appOverview.ts`, `lib/agent/summarizeBlueprint.ts`, `lib/mcp/prompts.ts`,
`lib/models.ts`, `lib/agent/CLAUDE.md` ("Provider contract"), `scripts/test-schema.ts`,
`scripts/inspect-tool-schema-hashes.ts`, `lib/domain/fields/*.ts` (`saDocs`, labels,
`convertTargets`), `e2e/CLAUDE.md`, `e2e/lib/smokeProfiles.ts`, `e2e/lib/caseWorkspaceSeed.ts`,
`e2e/tests/app/app-settings.spec.ts`, `content/docs/attachments.mdx`, `publishing.mdx`,
`mcp/tools.mdx`, and `../nova-plugin/skills/upload_to_hq/SKILL.md`.
