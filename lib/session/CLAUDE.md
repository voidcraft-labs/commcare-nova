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
  collection. Absence is still waiting for Results, an empty collection is an
  explicitly blank link, one is the ordinary scalar workflow, and many is the
  batch workflow.
- `previewSelectedCase` mirrors the one record currently open on Results for the
  breadcrumb/Details step. Opening Details never changes the selected set.
- `previewMenuCaseSelections` is keyed by module UUID and binds a case type plus
  its ordered `cases` collection to that menu. It survives ordinary in-Preview
  navigation so a parent menu can keep its Forms and child tiles available; a
  compatible same-type child may reuse it without turning the Form target into
  shared state.

`previewParentCaseRequest` is a separate selector plus ordered return chain, so
multi-level case ancestry can visit each required selector before the original
module. A direct running leaf also records its exact `resumeLocation` (including
the Form UUID, selected field, or Results case UUID) and a safe
`cancelLocation`; every intermediate selector preserves both. Its selecting
module is derived from case-type `parent_type`, not from structural
`parentModuleUuid`; this keeps menu ancestry and case ancestry independent when
a nested child belongs under one menu but its case parent is selected through
another module. Explicit cancel, browser Back, and navigation away clear the
request so an abandoned selector cannot redirect a later visit. All navigation
facts clear on Preview mode or persona changes and on a confirmed Project
boundary.
They are session-only and never enter the document, undo history, or persisted
app state; the locations are navigation return intents, not durable routing
state.

Every collection is ordered and duplicate-free. Continue copies the exact set
into the Form target; same-type inheritance may reuse it only when the
destination has the same scalar/collection cardinality and its authored maximum
is large enough. A scalar/set transition or a different case type starts a fresh
target selection. Search, paging, Details, Back, and compatible menu navigation
retain the set. Preview reset, persona change, Project boundary, or module
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
- `runStartedWithData: boolean` — captured once in `beginRun()` (did the doc already have data when the run opened?). The build-vs-edit discriminator: builds and edits emit the SAME stage tags now (`app`, `module:create`, `form:M-F`), so the buffer alone can't tell them apart, and a build's own mutations populating the doc mid-run must not flip the derivation. False outside runs. `beginRun({startedWithData})` overrides the capture for ONE case: reconnecting to an in-flight BUILD run after a page refresh, where the build's committed modules are already in the loaded doc and the default capture would misread the resumed build as an edit.
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
  A stopped partial plan stays locked. Chat reads `useProjectCanEdit`; every
  builder editor, stale imperative handler, doc gate, and reconciler reads
  effective `canEdit`. `derivePhase` keeps a materialized unfinished app in
  `Generating`, so its real tree surrounds the central progress card instead
  of opening the edit canvas after the first slice.

Run-boundary actions are orthogonal and atomic:

- `beginRun(opts?)` — pause doc undo, clear events buffer, clear runCompletedAt, capture runStartedWithData (or take the caller's override).
- `endRun()` — resume doc undo, clear events buffer. Does NOT touch runCompletedAt.
- `markRunCompleted()` — stamp runCompletedAt. Does NOT touch events or doc undo.
- `acknowledgeCompletion()` — clear runCompletedAt.

**Every other lifecycle signal is derived from these fields** via pure functions (`lifecycle.ts`, plus `derivePhase` in `hooks.tsx`): phase, stage, classified error, validation attempt, status message, postBuildEdit. No `agentActive` / `agentStage` / `agentError` / `statusMessage` / `postBuildEdit` / `justCompleted` flags exist — those were shadow state populated only by the live SSE path; deriving from the buffer instead keeps the layout a pure function of the events.

## Mutable app access

BuilderSession is the one client owner of `{projectId, role, canEdit,
accessPhase, scopeEpoch}`. Existing apps seed the first four values from the
RSC's atomic app snapshot; `/build/new` seeds them from the active Project's
role with `baseSeq: 0` while its in-memory doc and reconciler stay dormant.
Creation's one-shot receipt carries the exact sequence-1 canonical starter
blueprint plus its module/form/field UUIDs; the client installs that blueprint
before activating the reconciler, so session identity and confirmed doc state
cross the birth boundary together. `baseSeq` otherwise
stays with the reconciler. A new app is promoted only through
`activateCreatedApp`, which installs its server-returned app id and complete
Project capability tuple in one store update before the reconciler opens.
`beginAccessRefresh`
atomically sets `canEdit=false`, enters `refreshing`, and advances the monotonic
scope epoch once; repeated triggers coalesce. A failed GET moves to
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
one `failed`; neither creates a user retry action. Marking only fatal
errors left the line spinning over a dead run, observed live. An automatic
provider-retry warning is explicitly marked `runContinues` on the conversation
event and does not become a terminal progress failure; later pulses and commits
continue to drive the same run.

**Stage is derived, never stored.** `deriveDesignStage` folds "which frames
have arrived" into the §15.2 vocabulary, so the line on screen cannot disagree
with the durable events that produced it, and the plan's ban on a client-only
state machine holds. The live refinement inside the design span is the
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

`assetMeta` is the sibling registry: asset rows observed this session (library pages the pickers load, upload confirms, the budget check's own fetches), keyed by id. The browser's pre-dispatch export-ceiling check (`components/builder/media/useAttachBudget.ts`) resolves the doc's referenced ids against it and fetches only the gaps. Advisory by design — the export boundary re-loads fresh rows server-side, so staleness here can only mis-tune the courtesy check, never the enforcement.

## Active page of a sectioned form

`activeSectionByForm` (`setActiveSection` / `useActiveSection` /
`useGetActiveSection`) remembers which page (section uuid) each sectioned form
is open on, the way `editScrollByForm` remembers the edit canvas's scroll. Two
writers, two readers: the preview pager writes it on every page change and
renders from the reactive hook; the edit canvas writes the page its first
visible row belonged to on unmount and reads it imperatively, once, to seed the
virtualizer's `initialOffset` (`components/preview/form/virtual/sectionScroll.ts`).
A form that was never paged has no entry, and an entry outlives a visit the way
the scroll memory does (coming back to a form lands on the page you left; Clear
form returns the running form to its first page). It is not a shadow of the
doc: a page the form no longer has, or one with nothing to show right now, is
simply re-anchored by both readers rather than trusted.
