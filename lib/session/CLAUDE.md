# lib/session — Builder ephemeral session store

Transient UI state scoped to the builder route: preview mode, sidebar visibility, agent run status, active field, connect-mode stash, staged media uploads. None of it is undoable; none of it persists across page loads.

## Boundary rule

Same as `lib/doc`: the store is private. Consumers go through the named hooks in this package — never import the store file directly from outside.

## Why a separate store from `lib/doc`

- **Clean undo/redo.** Zundo can track the entire document store without a `partialize` allow-list, because UI fields don't live in it. Adding transient UI to the doc store would require hand-maintaining a list of fields to exclude from history.
- **Write from outside React.** Stream handlers and route handlers toggle run lifecycle via the store without threading through context.
- **Disjoint responsibilities.** Mutations to the blueprint and mutations to UI state are visibly different call sites, so reviewers can reason about each independently.

## Preview navigation is ephemeral and identity-based

The running menu keeps three distinct case facts, and they must not collapse:

- `previewCaseTarget` means one exact Form is opening with an ordered `cases`
  collection and, after a case list's filter, `caseListSearchText`, which the
  entry's session holds as `stringquery`. Absence is still waiting for Results, an empty collection is an
  explicitly blank link, one is the ordinary scalar workflow, and many is the
  batch workflow.
- `previewSelectedCase` mirrors the one record currently open on Results for the
  breadcrumb/Details step. Opening Details never changes the selected set.
- `previewMenuCaseSelections` is keyed by module UUID and binds a case type plus
  its ordered `cases` collection to that menu. It survives navigation within the
  running task so a parent menu keeps its Forms and child tiles available; a
  compatible same-type child may reuse it without turning the Form target into
  shared state.

`previewSessionId` names the worker's running Preview session. It is new each
time the session starts over: entering or leaving Preview, a change of
worker or platform, an entry point's launch, Android's home screen
(`setPreviewAtDeviceHome(true)`), a confirmed Project change and
`reset()`; a store made on a page load starts with its own. Every
identifier the store mints comes from the `uuid` package (`newPreviewSessionId`,
`previewAndroidDeviceId`), never `crypto.randomUUID`, which a browser offers
only in a secure context: the builder opened over plain http on a LAN
address would throw making the store. `lib/lint/randomUuid.grit` refuses
`crypto.randomUUID()` in every client directory. The worker's own
steps (menu selections, case targets, Home) keep it. A step the browser's
history keeps, a case list's held form menu (`lib/routing/previewHeldMenu.ts`),
records the session that took it and stands only in that session, so Back
onto it after a change of worker shows the list rather than the previous
worker's case.

`previewTaskId` names the running task of that session: every arrival at
Home (`clearPreviewNavigation`) mints a new one, whatever the task held.
Each history entry records the case selections it was shown with (the menu
selections, the selections part of the case target, the selected case) and
the session and task it was shown in (`lib/routing/previewSelectionsHistory.ts`).
Back or Forward onto an entry of the same session and another task (past
Home) puts that entry's selections back on Web Apps, before the screens
render it (`restorePreviewSelections`, from a popstate listener in
`lib/preview/hooks/usePreviewSelectionsArrival.ts`), and the session takes
up that entry's task again; the rest of the ended task (a Register launch,
a task continuation, the after-submit stack, a parent case request) stays
cleared, as Home cleared it. That is Web Apps' popped address: its
`selections` are replayed by `navigate_menu`. Within one task an entry whose
record differs from the session's selections (a crumb let a case go since,
or a later list chose another) puts its selections back the same way
(`replayPreviewSelections`), and the task's other facts stand; a form target
whose form and cases are the entry's keeps what it carries beyond them. On
Android (`rules.poppedEntrySelections: "session"`) nothing is returned.

`previewParentCaseRequest` is a separate selector plus ordered return chain, so
multi-level case ancestry can visit each required selector before the original
module. A direct running leaf also records its exact `resumeLocation` (including
the Form UUID, selected field, or Results case UUID) and a safe
`cancelLocation` (the module's own menu where it listed its forms before the
parent was asked for, as a device's Back steps over the form's command);
every intermediate selector preserves both. Its selecting
module is derived from case-type `parent_type`, not from structural
`parentModuleUuid`; this keeps menu ancestry and case ancestry independent when
a nested child belongs under one menu but its case parent is selected through
another module. Explicit cancel, browser Back, and navigation away clear the
request so an abandoned selector cannot redirect a later visit. A selector
reached after a case chosen on an earlier selector of the same request
holds that earlier request as `previous`
(`moduleScreenNavigation.ts::previewParentCaseRequestAfterChoice`), and the
list's own Back there returns to the earlier selector's list with its case
let go, in place, as `CommCareSession.stepBack` pops the last datum it
collected (`previewParentCaseStepBack`). On a selector with nothing before it
the list's own Back reaches `cancelLocation` by a step back where that screen
is the entry behind the list (`navigate.stepBackTo`), so history never holds
it twice and the browser's next Back goes on past it. All navigation
facts clear on Preview mode or persona changes and on a confirmed Project
boundary.
They are session-only and never enter the document, undo history, or persisted
app state; the locations are navigation return intents, not durable routing
state.

`previewSearchStates` is the fourth running fact, keyed by module UUID: the
completed-search context of a module's search (`previewSearchState.ts`,
reducers only; `setPreviewSearchState(moduleUuid, state | undefined)` stores
it and clears the entry on `undefined` or `not-searched`). It also holds a
Search action's search (`action`, on a menu whose forms do not read the
search) and a Search screen asked for again (`manual`), which only the case
list reads, so every list's search and Web Apps' forced manual search stand
and let go by one rule. It is written by
the case-list screen as its query settles and read by the form screen to admit
the case list registration form, and to load the completed attempt's results
snapshot for a form of a menu whose forms read the search. `previewCaseTarget.searchLaunch
{ moduleUuid, attempt }` is the launch that opened that form from Results;
the attempt pins the form to the search it was offered on. Both clear with the
case facts: entering or leaving Preview, a persona change, `reset()`, and a
confirmed Project boundary. A search stands only on the history entries that
record it (`lib/routing/previewSearchHistory.ts`): the screens read it through
`lib/preview/hooks/usePreviewStandingSearch.ts`, which records a search on
the current entry, with its context, before the store holds it, and a crumb,
a step to a screen above the list, a submission (on the screen it lands on
alone), Home and Android's home screen let it go
(`lib/preview/searchStanding.ts`, `lib/preview/CLAUDE.md`). The store keeps
the module's current search only: where history returns to an entry whose
search the store has since replaced, the arrival puts the entry's context
back (`lib/preview/hooks/usePreviewSearchArrival.ts`).
`previewSearchInputs` is the answers the worker last gave each module's
query, kept with the `previewSessionId` that gave them
(`previewSearchState.ts::PreviewSearchInputsGiven`): a Search press and a
field changed on the Search screen, each with every hidden field's value
beside the worker's answers, and the Search screen shown with no search
standing, which gives none, hidden values included. Home and a submission
keep them, as Web Apps' page keeps `Utils.queryInputs`, and a new session
reads none without a write. On Web Apps an arrival on a list runs that
list's standing search with them, every prompt answered by them alone
(`previewSearchState.ts::searchWithLatestInputs`), and an arrival on a menu
or a form past the list holds a completed search with them, marked
`rerunPastList` until its list counts it again (`searchRunPastItsList`); the menu's default search
is marked `automatic` on its state, since it gave no answers and runs as the
default search again.

`previewCaseListRegistrationEntry` is the launch a case list's Register action
made of a form the list always offers: the host, and the form and menu it
opened. It is its own fact, never part of `previewCaseTarget`, because the
target is rewritten by every screen on the way (a parent case selection clears
it), while the launch belongs to the one form entry it opened. `PreviewShell`
ends it at any location off the launch's path
(`lib/preview/caseListRegistrationEntry.ts::caseListRegistrationEntryContinues`),
`FormScreen` when its submission lands, and it clears with the case facts and
on Home.

Preview plays one platform the app runs on at a time, and four running facts
carry it. `previewPlatform` is the platform the author chose under **Runs on**,
`undefined` for the default; it survives a flip out of Preview and back (a flip
keeps the runtime the author is checking) and is cleared by a confirmed Project
change and `reset()`. `setPreviewPlatform` clears the running navigation in one
`set` and opens Android on its home screen.
`previewAtDeviceHome` says Preview on Android is showing the phone's home
screen: true when Preview opens on the app's home on Android (`setPreviewing(on,
{ atHome })`, whose `atHome` the preview-mode transition passes because the URL,
not this store, owns the location), on a change of worker on Android and after
an Android landing that returns there; false on leaving Preview, on an
entry-point launch and on Start. `setPreviewAtDeviceHome(true)` starts the
session over as Android's reset does
(`HomeScreenBaseActivity.processCanceledGetCommandOrCase` →
`AndroidSessionWrapper.reset` → `CommCareSession.clearAllState`: a new
frame and an empty frame stack): it clears every navigation fact (the case
target, the Register launch, the task continuation, the after-submit stack,
an entry point's launch, the selected case, the menu selections, a parent
case request, the searches) and mints a new `previewSessionId`, so a held
form menu the browser's history kept no longer stands. The worker, the
platform, the last sync and the device id are the device's and stay; Start
opens the app on that new session. `previewDeviceSyncedAt` is this Preview run's
last sync on Android, set when Preview starts on Android, by a change of worker
or an entry-point launch there, and by Sync with server; it clears on leaving
Preview. `previewAndroidDeviceId` is the UUID of Android's `deviceid`, minted
when the store is created and kept by `reset()`: one page load is one install.
The platform Preview plays is derived, never stored:
`usePreviewPlatform()` is `effectivePreviewPlatform(declaredPlatforms(doc),
previewPlatform)`, so a choice the app no longer declares derives away with no
write, and `usePreviewDevice()` builds the device the engine and every Server
Action read from it (`lib/preview/CLAUDE.md`, "Platforms").

`viewerPosition.ts` is a separate module store, `viewerPositionStore`, for the
browser's position behind a case list's `here()` column, one per tab as
CommCare Android keeps one location handler for every list. It holds the
sharing status (`unasked`, `waiting`, `sharing`, `refused`, `unavailable`,
`unsupported`), the latest fix, the position a list last showed, and `moves`,
a counter of the moves that re-read a list (the first position, a move of more
than 30 metres from the shown one, a refusal that takes a shown position away).
A list read keys on `moves` and sends the latest fix, recording it as shown;
Details and the tile send the latest without recording it. The browser is
asked once while Preview runs, and a refusal is never asked again unprompted;
each list that mounts starts its own watch, an unanswered ask included
(`lib/preview/hooks/useViewerPosition.ts`), which stops on a fix of 1,600
metres accuracy or better or when the list goes away. Nothing in it is stored
or sent anywhere but the read that uses it.

Every collection is ordered and duplicate-free. Continue copies the exact set
into the Form target; same-type inheritance may reuse it only when the
destination has the same scalar/collection cardinality and its authored maximum
is large enough. A scalar/set transition or a different case type starts a fresh
target selection. Search, paging, Details, Back, and compatible menu navigation
retain the set. Home clears the current task's case facts and search context,
without changing worker identity or authorization. Preview reset, persona change, Project boundary, or module
removal clears it. A maximum change does not trim it: the running screen holds
the over-limit set until the worker removes enough cases.

## Connect UI state is not Connect document ownership

The store owns only the form-settings convenience state: mode-specific draft
stashes and `lastConnectType` as the next-dialog default. `switchConnectMode`
never infers a target mode from that hint. Its caller supplies an explicit mode
and, for learn/deliver, the complete desired participant blocks; the store
delegates document planning to `lib/doc/connectTargetState.ts` and gates the
returned batch once, under the Project lookup context the one
`ConnectSwitchRequest` carries beside the target and blocks.
`useSwitchConnectMode` first runs the shared `builderWriteAdmission` (a viewer,
a lookup catalog still loading or failed) and then binds the builder's live
context from `useLookupCommitState`, so a doc that carries a lookup-backed
select can still switch modes; the store deliberately has no default for the
context, because the gate is absolute and an unavailable one refuses every
switch on such a doc. A null target clears the app mode and every form block;
an enabled target clears every unlisted block. The stash is updated only after
the document batch commits and can never make a dormant Connect configuration
part of the blueprint.

## Lifecycle = events buffer + runCompletedAt + the run-start capture

Four session fields describe "what phase is the builder in":

- `events: Event[]` — the current active run's events. **Cleared at both `beginRun()` and `endRun()`**, so `events.length > 0` is itself the "a run is in progress" signal — no `agentActive` shadow flag, no mirror to drift. The stream dispatcher appends as `data-mutations` + `data-conversation-event` envelopes arrive.
- `runStartedWithData: boolean` — captured once in `beginRun()` (did the doc already have data when the run opened?). The build-vs-edit discriminator: builds and edits emit the SAME stage tags (`app`, `module:create`, `form:M-F`), so the buffer alone can't tell them apart, and a build's own mutations populating the doc mid-run must not flip the derivation. False outside runs. `beginRun({startedWithData})` overrides the capture for ONE case: reconnecting to an in-flight BUILD run after a page refresh, where the build's committed modules are already in the loaded doc and the default capture would misread the resumed build as an edit.
- `runCompletedAt: number | undefined` — stamped by the dispatcher's `data-done` handler (the chat route's drain-end build-finished signal). Cleared by `acknowledgeCompletion()` after the celebration timer. askQuestions / clarifying-text / edit-tool runs never stamp — they close silently.
- `loading: boolean` — initial hydration flag (existing app load or replay).
- `buildUnfinished: boolean` — the APP-level "this app's build never
  completed" latch, deliberately not derivable from the buffer (which clears
  on every stream close, an askQuestions pause included, while canonical
  genesis makes the doc read Ready). Seeded by the page
  (`BuilderProvider.initialBuildUnfinished`: a `generating` app or an
  interrupted build admitted for re-drive), latched by `markBuildUnfinished()`
  when a `/build/new` tab's creation handoff lands or an `app-status` frame
  reports `generating`/`error`, released by
  `markBuildFinished()` from two channels: `ChatContainer`'s stream `onData`
  on `data-done` (or the doc-less `data-build-complete` a purely
  conversational build turn emits instead), and the reconciler's `app-status`
  SSE frame when the server observes `complete` — the release for tabs never
  attached to the run's stream (a second tab, a co-member watching a
  teammate's build). The release also latches the sibling `buildCompleted`
  flag, which makes the pair one-way per build: `complete` is terminal in the
  app lifecycle, so after an observed completion `markBuildUnfinished()`
  no-ops — a stale seq-less `generating` frame delivered after this tab's own
  `data-done` release cannot re-price a finished app's sends as builds.
  `reset()` deliberately leaves it alone: it is app truth, and the frozen
  constructor init would resurrect a released latch. `deriveChatAppReady`
  (hooks) composes it with the phase for the chat surface's build-vs-edit
  read: the advisory `appReady` request field and the cost chip both ride it,
  mirroring the server's authoritative app-row-status rule.
  It is also the initial-build authoring lock: the store retains the raw
  Project capability in `projectCanEdit`, while effective `canEdit` remains
  false from materialization through authoritative whole-build completion.
  A stopped partial plan stays locked. Chat and Project resource operations
  (files and Project data) read `useProjectCanEdit`; direct blueprint editors,
  their stale imperative handlers, doc gates, and the reconciler read effective
  `canEdit`. Uploading, deleting an unreferenced file, and starting extraction
  do not edit the blueprint. Selecting media into a blueprint still requires
  its authoring capability, independently of library management authority.
  `derivePhase` keeps a materialized unfinished app in
  `Generating`, so its real tree surrounds the central progress card instead
  of opening the edit canvas after the first slice.

Run-boundary actions are orthogonal and atomic:

- `beginRun(opts?)` — pause doc undo, clear events buffer, clear runCompletedAt, capture runStartedWithData (or take the caller's override).
- `endRun()` — resume doc undo, clear events buffer. Does NOT touch runCompletedAt.
- `markRunCompleted()` — stamp runCompletedAt. Does NOT touch events or doc undo.
- `acknowledgeCompletion()` — clear runCompletedAt.

**Every other lifecycle signal is derived from these fields** via pure functions (`lifecycle.ts`, plus `derivePhase` in `hooks.tsx`): phase, stage, classified error, validation attempt, status message, postBuildEdit. None of them is stored; deriving from the buffer keeps the layout a pure function of the events.

## Mutable app access

BuilderSession is the one client owner of `{projectId, role, projectCanEdit,
canEdit, accessPhase, scopeEpoch}`. Existing apps seed Project identity and
capability from the RSC's atomic app snapshot; `/build/new` seeds them from the
active Project's role with `baseSeq: 0` while its in-memory doc and reconciler stay dormant.
Creation's one-shot receipt carries the exact sequence-1 canonical starter
blueprint plus its module/form/field UUIDs; the client installs that blueprint
before activating the reconciler, so session identity and confirmed doc state
cross the birth boundary together. `baseSeq` otherwise
stays with the reconciler. A new app is promoted only through
`activateCreatedApp`, which installs its server-returned app id and complete
Project capability tuple in one store update before the reconciler opens.
`beginAccessRefresh`
atomically clears `projectCanEdit` and `canEdit`, enters `refreshing`, and advances
the monotonic scope epoch once; repeated triggers coalesce. A failed GET moves to
`reconnecting` without reopening edits. Only an atomic authorized snapshot can
restore `authorized`/`canEdit`; confirmed view loss and a repeated receiver
upgrade rejection have distinct terminal phases. Components consume named
hooks only, and `BlueprintEditableBridge` projects the live `canEdit` into the
doc mutation choke point.

`resetProjectScope()` is the synchronous session-owned half of that boundary.
It aborts every staged media upload, clears staged/observed asset metadata, and
retires the full run-event payload plus its lifecycle timestamps before the
destination GET starts. It does **not** discard the active Preview case,
persona, form answers, or form entry while the Project outcome is unknown. An
authorized snapshot for the same Project preserves them; a snapshot confirming
a different Project clears the case/persona binding atomically, and the preview
controller retires the old form entry. Chat owns the matching transport stop
and closes any open document run bracket. Authoring state and the unsent
composer draft are deliberately retained.

**Generation stages are cumulative milestones, not the latest tool label.** The live model is `Foundation → Build`: `updateApp` and the optional `generateSchema` establish the foundation; atomic module/form tools establish Build. A later schema enrichment cannot undo already-committed content, so `deriveAgentStage` folds the whole event prefix into those facts instead of reading the last recognized tag. Strict materialization is the one additional proof: its private genesis mutations do not enter the client event buffer, so an unfinished build with an app identity establishes Build for the central progress card. Historical `schema` / `scaffold` / `fix:*` tags are projected into the current model at read time; stage values themselves are ephemeral and are not stored beside the event log, so this model needs no data migration.

**Disambiguation: initial build vs post-build edit.** Both emit the same stage tags (`module:create` during construction, `form:M-F` for field work). `derivePhase` and `derivePostBuildEdit` key on `runStartedWithData` as a run-mode fact captured before canonical genesis is activated — an initial build uses the Generating layout even though its persisted app is already the born-valid survey starter; an edit keeps the builder Ready/interactive while the agent works.

When adding a new lifecycle signal: add a derivation in `lifecycle.ts`, expose a named hook in `hooks.tsx`. Don't add a field to the store for anything derivable from the existing base facts. A store field is only for a genuinely NEW base fact the derivations cannot reach — `buildUnfinished` is the example (the buffer it would derive from clears on every stream close), and it carries the burden that earned it: explicit seed, latch, and release channels documented on the field.

## Design-build progress is its own store

`designProgressStore.ts` is a SECOND, deliberately separate store: a chat build
has no app until its first workflow commits, so everything BuilderSession
describes (preview mode, sidebars, the run event buffer, `buildUnfinished`)
is about a document that does not exist yet. It holds only the durable
projections the build orchestrator streams — the reviewed-design outline, the
build plan's slice names, which slices committed — plus the two facts only the
client can see: an explicit input terminal (an unanswered question card or a
completed internal wait tool, read off the transcript) and a run-stopping
stream error. BOTH error kinds stop the stage line: a
recoverable error reads `incomplete` ("Stopped before it finished") and a fatal
one `failed`; neither creates a user retry action. A recoverable error still
ends the run, so the line must not keep spinning. An automatic
provider-retry warning is explicitly marked `runContinues` on the conversation
event and does not become a terminal progress failure; later pulses and commits
continue to drive the same run.

**Stage is derived, never stored.** `deriveDesignStage` folds "which frames
have arrived" into the design-stage vocabulary, so the line on screen cannot
disagree with the durable events that produced it; there is no client-only
stage state machine. The live refinement inside the design span is the
`data-design-pulse` frame — the SERVER naming which pipeline call is streaming
right now (author/review/revise/plan) — which is the only source that can say
`reviewing-design`/`revising-design` while those calls run; the store keeps
just the latest phase (`pulsePhase`), outranked by any real progress frame and
cleared on the closed-to-open edge of a new turn because a pulse describes
only the stream it rode on. Ordinary message updates inside that open stream
do not clear it between the throttled pulse frames. A slice-start frame also
clears it immediately, so the last planning
sub-step can never appear beneath live build work. Two details are
load-bearing: the FIRST slice emits an ordinary `slice-committed` progress
projection immediately before its strict `data-app-materialized` receipt
(with a narrow `markMaterialized` compatibility fold for older reconnect
logs); and `seededStage` carries the SERVER's
load-time derivation for a resumed design (`/build/new?design=<id>`) so a cold
load says where the design stopped, retired by `noteTurnOpened` the moment a
new turn is in flight.

One instance per mounted conversation, created and owned by `ChatContainer`
(the frames arrive on its `onData`) and reset on every thread swap. Every frame
is admitted through `lib/generation/designProgressWire`, which fails closed on
an unknown `eventVersion` or a foreign design session. Consumers read it
through `useDesignProgressView`, never an inline selector.

The thread's `designSessionId` is durable routing lineage, not proof that design
work is active. After a materialized app's accepted build reaches terminal
completion, ordinary edit turns keep that id in the chat request but do not
reopen this store. A pre-app scope or the Builder session's unfinished-build
latch activates progress; a load-seeded materialized `ready` stage retires when
the next edit opens. This keeps edit and compaction activity on the ordinary
chat status line instead of falling back to `understanding`.

## Staged media uploads

`stagedUploads` is why a slot upload is session state and not doc state: the doc must never reference an asset that isn't `ready`, so a picked file lives here — keyed by carrier slot, with progress and an error state — until its upload confirms and the slot dispatches the normal gated attach (`components/builder/media/useStagedUpload.ts` is the driver). Abort handles are functions, so they live in a factory-closure registry beside the store (the `docStoreRef` pattern), never in serializable state; `cancelStagedUpload` aborts through it and `reset()` aborts everything (a torn-down session must not let an orphaned upload attach into a dead store). Keying by slot identity (not component instance) is what lets a slot that unmounts mid-upload re-render its chip from the store on remount.

`assetMeta` is the sibling registry: asset rows observed this session (library pages the pickers load, upload confirms, the budget check's own fetches), keyed by id. Each row carries its `mediaFormat`, which the attach guard, the pickers and Preview's stand-in read, and its `contentHash` and `extension`, from which Preview's list filter reads the `jr://file/` path a device holds for an image map's image. The browser's pre-dispatch export-ceiling check (`components/builder/media/useAttachBudget.ts`) resolves the doc's referenced ids against it and fetches only the gaps. Advisory by design — the export boundary re-loads fresh rows server-side, so staleness here can only mis-tune the courtesy check, never the enforcement.

## A pending identity move

`pendingIdentityMove` holds the one batch `IdentityMoveDialog` states, until the person makes the change or cancels; it is never stored. The doc package reaches it only through `pendingIdentityMoveSlot` (the `PendingIdentityMoveSlot` of `lib/doc/pendingIdentityMove.ts`), so its commands and history step stay free of this store's shape, and a confirmed Project change clears it, since the batch names the source Project's document.

## Project spaces changed in CommCare HQ

`hqChangedTargets` holds the project spaces the check when the builder opens
(`components/builder/HqChangesCheck.tsx`) found changed in CommCare HQ, which
the header's See what changed in CommCare HQ offers. It starts empty and has no
"checking" value, so nothing can wait on the check. `clearHqChangedTarget`
settles one (its panel answered, a publish landed there, publishing there
stopped) and `clearHqChangedTargets` empties it on a reload whose reason is
`hq-changes`. `publishDialogRequest` may carry the `discard` the Publishing
card's panel chose, which the Publish dialog opens with.

`hqChangesBroughtIn` holds this tab's own bring-in of changes made in CommCare
HQ that landed, for the surface that asked (the Publish dialog or the card's
dialog) to open on once the reload its commit forced has landed: that reload
closes every dialog, and this store outlives it. It is held only under the
Project the session holds now, kept by `resetProjectScope` and a same-Project
snapshot, dropped by a confirmed Project change and `reset()`. The Publish
dialog clears it as it opens on it; the card's dialog is drawn from it and
clears it when the person closes it, so a close the reload's access gate
makes keeps it for the dialog to open again.

## Active page of a sectioned form

`activeSectionByForm` (`setActiveSection` / `useActiveSection` /
`useGetActiveSection`) remembers which page (section uuid) each sectioned form
is open on, the way `editScrollByForm` remembers the edit canvas's scroll.
Running as Android, the preview pager writes it on every page change and
renders from the reactive hook; on Web Apps' one screen,
`components/preview/form/sections/useScrolledSection.ts` writes the section in
view as the author scrolls; the edit canvas writes the page its first
visible row belonged to on unmount and reads it imperatively, once, to seed the
virtualizer's `initialOffset` (`components/preview/form/virtual/sectionScroll.ts`).
A form that was never paged has no entry, and an entry outlives a visit the way
the scroll memory does (coming back to a form lands on the page you left; Clear
form returns the running form to its first page). A successful post-submit
navigation forgets the completed form's page and any concrete linked form's
page, so a new entry resolves its first visible section from its own answers.
Failed or stale submissions and edit/Preview flips preserve that memory. It is not a shadow of the
doc: a page the form no longer has, or one with nothing to show right now, is
simply re-anchored by both readers rather than trusted.

## Endpoint launch lifetime

`previewTaskContinuation` records only a command that the after-submit task
projection retained, plus its exact patched device case database. It scopes
menu-visibility continuation to that task's module, exact form and pending
selectors. Ordinary navigation offering conditions and Project authorization
keep their normal gates. A retained form command completes its selector
without asking the menu to offer the form again; a module command evaluates
form offerings normally. Leaving the task, Home, Preview mode changes, worker
changes, resets and confirmed Project changes clear the marker. The URL still
owns location; this marker neither records nor replaces navigation history.
Choosing a form on a retained menu keeps that device world while the owner's
actual entry datums decide its missing selectors. `returnModuleUuid` retains
the world when ordinary Back returns to that menu, without admitting another
command. A successful submission with a different routing outcome retires the
completed task before installing its new destination.

`previewAfterSubmitStack` holds the after-submit frames still to run in the
running app (`types.ts::PreviewAfterSubmitStack`, an
`AfterSubmitStackState<PreviewAfterSubmitFrame>` from
`lib/preview/afterSubmitStack.ts`): on Android the destinations beneath the one
that opened, each with the several-case selection its link carried fixed when
the frame was pushed; on Web Apps nothing, since Formplayer opens the frame on
top alone. `FormScreen` writes it through `setPreviewAfterSubmitStack` after
each submission's `completeAfterSubmit`. It is ephemeral and never stored. It
empties wherever `previewTaskContinuation` clears (Preview mode changes both
ways, a worker change, a platform change, an entry point launch, a confirmed
Project change, `reset()`), and on `setPreviewAtDeviceHome(true)`, Android's
session reset when the worker steps back from the root menu. Home
(`clearPreviewNavigation`) empties it unless its snapshot is the empty landing
of a frame that opened the app's first screen, since `PreviewShell` calls it on
every arrival at Home and Core never drops frames beneath an empty snapshot
(`SessionFrame.java::isSnapshotIncompatible`).

`previewEntryPointLaunch` is a verified local launch intent, never authored data.
`installEntryPointLaunch` atomically installs Preview mode, selected persona, the
ordered menu selections and exact form target, and clears unrelated search/parent
requests. `clearEntryPointLaunch` expires the launch-specific display-condition
bypass when navigation proceeds; ordinary case selections remain available to
the next form. Preview exit, reset, persona changes, and a confirmed Project
change clear the entire launch with the other running facts. The Preview shell
retires a launch on a document change and prevents a stale launch from turning
into an ordinary form's first-case convenience fallback.


Worker credentials live together in `provisioningOutcomes`, keyed by server and
project space. The per-target fold retains every distinct unconfirmed password
for a persona/username; repeated uncertain creates cannot disprove earlier ones.
Only a confirmed create for that exact account clears its old candidates, and
explicit dismissal removes one candidate on one target. Hooks select that target
before rendering. Account adoption proves existence, not a candidate password;
`workerCredentialRows` shares the complete rows and uncertainty labels with the
clipboard. Nothing persists these values; reset/page teardown clears them.

A same-named replacement account cannot inherit a confirmed password: the held
fold checks the remote account ID and retains the displaced password as an
unconfirmed candidate. A lost browser response may follow a completed create;
the panel invites checking HQ and explains that undelivered passwords need reset.

Preview's identity menu and missing-persona recovery return the URL to app entry
when choosing a different worker. The session action clears prior record and
Search bindings; the UI navigation replaces the prior form route. Choosing a
worker never changes the member who authorizes access to Project data.
