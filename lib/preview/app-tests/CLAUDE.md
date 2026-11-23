# App test journeys

This is a separate, explicitly labeled disposable-record surface. Ordinary
Preview still uses the user's real records. Shared tools start at app entry as
the authorized actor or an explicitly selected saved Preview identity, then choose only saved Preview identities and available
menus, records and forms. Do not accept a privileged replacement worker context.

`service.ts` pins the saved blueprint and authorized lookup/place snapshots.
External reads finish before the test transaction opens. Admission then locks
the source app and rechecks real-actor membership and the exact app revision.
`lib/db/appTests.ts` serializes actions, fences expected steps and runtime
versions, and commits state, observations and idempotency receipts together.
Only the creating actor can continue a test; current app members can read its
observations. Simulated worker identity never grants Project authority.

A journey may retain one to four worker sessions in the same isolated namespace.
`startAppTest.sessions` supplies unique bounded test-local IDs and optional saved
identity/language choices; omission creates `default`. The first session is
primary. Each ordered action may address `sessionId`; omission uses primary.
An unknown ID refuses before identity materialization, navigation or submission,
and a duplicate ID refuses before namespace admission. Session IDs are opaque
labels, not entity names or invented Preview workers. Identity, language,
navigation, ancestor selections, record catalog and open-form entry/checkpoint
belong to that session. Advancing another session never retires them. The step,
record and combined-state budgets belong to the whole journey. Persist the
supplied session order separately from the JSONB object so every directory keeps
its primary-first order across checkpoints. Finish disposes
all sessions and their shared namespace; omitting a session ID also permits
cleanup of an older runtime's journey.

After app authorization succeeds, an unavailable test identity is an
`AppTestUnavailableError`, including a test belonging to another app or a
continuation belonging to another actor. It reveals no foreign evidence. The
architect and peer receive expected test refusals as tool results and can correct
their call. Lost app membership or run authority remains terminal.
`readAppTest` without an identity returns the same bounded recent-test list as
Builder, so a reviewer can discover evidence created by another authoring role.
List and detail timestamps are ISO strings usable in model JSON results.
Before the app's first save, shared journey tools return an ordinary prerequisite
refusal. Planning peers may discover history reads, and a retained unanswered
read must settle with that refusal on recovery. Reading saved evidence remains
available while private app edits are pending; starting or continuing a journey
still requires those edits to be saved.

`lib/case-store/appTestNamespace.ts` binds the production Postgres store to a
generated namespace inside that transaction. Every table the store can reach
must resolve there, with the current production column contract. No live case
rows are copied. No live lookup-table locks are taken by the isolated store.
Lookup definitions and rows are seeded from the same authorized snapshot.
Case-type schemas and lookup definitions insert in bounded batches, so adding
a type or table does not add a separate catalog-insert round trip. Runtime version 13 refuses
execution of older namespaces that lack the definition table.
Start observations retain supplied record counts by type,
including an empty list when no business records were supplied. This is input
provenance, not a readiness verdict or a count of current worker-visible rows. Supplied records and fictional places exist only in this
namespace; saved lookup rows and actual place context are authorized read inputs.
Test-only persona assignments do not provision workers or establish deployment
readiness. The narrow store cannot alter schemas or dispatch media effects.

Navigation shares production menu, selection and routing projections.
Form evaluation receives a captured record snapshot before initialization,
with the worker's `locations` fixture beside it when some form of the app
reads places (`engine/expressionCaseReads.ts::appReadsPlaces`, as Preview's
snapshot carries them). A form of a menu whose forms read the search that
reads what it found also receives the search's results
snapshot, read from the isolated store as the browser reads it: the session's
latest search of that module, read again without a page window and capped at
500, each row with its direct indices as `index` children (the namespace
store's `readCaseDatabasePatch`, inside the step's transaction). It is read
once, at the entry's first evaluation, and the form screen holds it
(`searchResults`), so every step and the submission of that entry read the
same set, as the browser's form keeps the snapshot it opened with; Back to a
form, a linked form and another search start a new entry that reads again
(`__tests__/searchResultsEntry.test.ts`). The paged
Results read and this one are one composition (`records.ts::prepareAppTestRecords`
over `engine/serverSearchRead.ts`). A form reached without that search is
refused with the browser's refusal sentence. Submitting hands the after-submit
links the same world the form read, its places and search results included
(`submission.ts::submitAppTest` takes the form's evaluation context).
Each form session mints its own entry key and builds its session map from the
session's menu selections, so its proposed submission names the case ids its
logic read. It
does not execute the browser's asynchronous record-loading hooks or React
lifecycle; those boundaries need browser evidence even when a journey passes.
Observations identify the evaluator clock and its calendar day. Form workers,
SQL record reads and submission calculations use the same process timezone;
ordinary browser Preview uses the browser timezone. Neither asserts a supplied
place has that timezone. `RUNTIME_VERSION` in `lib/db/appTests.ts` fences
execution semantics (section-entry checkpoints and page turns, scoped
initialization order, transient leaf versus persistent parent-menu selection,
Details with Continue/Back, the shared clock, resolved-language presentation,
custom-constraint wording fallback, and the stored expression model with
Preview's Core-matching dates and setvalue casts, two-valued record predicates,
and a search's population and claims); bump it when those semantics change.
Version 16 fences the expression model: a journey started before it pinned a
document whose expressions the current model does not read. Version 17 fences platforms: each session runs on one platform the app declares;
a journey started before it ran Preview's former mix of runtimes.
Version 18 fences repeats and case writes: a journey started before it pinned
a document whose query repeats, counts and case operations the current
runtime reads differently. Runtime version 19 fences four things: it names a
query repeat's wrapper `<id>.query`; it saves a date and time to a case as
the text CommCare HQ stores for its moment, UTC with six fraction digits and
`Z` (`lib/domain/temporalValues.ts::caseDatetimeValue`), where a journey
started before it saved the viewer's offset; it opens the Search screen as
Core's query manager is built (`searchRunState.ts::openSearchRunState`),
reading every choice list and letting go a starting choice the rows do not
offer, refusing a menu that opens on its search or its results as it opens,
and refusing the assigned-case exclusion only where Results are read; and it
walks a menu's parent case as Preview does (`parentCaseSelection.ts`), asking
for it before the menu's screen only where Core does, going on at the
parent's row unless the datum it chooses for names a details screen, and
letting every case chosen after a screen go when Back returns to it. A session's
platform is its own `platform`, else the start's, else the one the saved app
previews on by default (`context.ts::appTestPlatform`, which refuses a platform
the app does not declare with `platformUnavailableSentence`); the session keeps
its platform and its own Android install id, and its device has no window, so
Web Apps reads a 1280-wide one (`serverPreviewDevice`). An Android session
starts on the phone's home screen (`{ kind: "device-home" }`), where `continue`
is Start and opens the module list; `home` and an `app_home` submission return
there, and an expectation of `home` is met by either. On Web Apps the form is
one screen, so no page turn is offered and `section` admits a section of the
form without changing anything; on Android a form without sections turns one
screen of `FormEngine.formScreens()` at a time. Every observation names its
`platform`. Older journeys remain readable but require a fresh test to execute. Search,
FormEngine and after-submit expression evaluation use bounded workers. Form
checkpoints retain answers, defaults, repeat identities and captured entry data
between calls. Form and journey observations share the question participation
projection. A non-relevant question reports its retained
answer separately and has no participating value; an included hidden calculation
has a value despite not being visible. This prevents display visibility from
standing in for expression or submission behavior. Answers share the coordinate
input and location-picker formatter with the real UI. Malformed supplied location values
are test-input refusals, not observations of worker validation; map services and
GPS capture remain outside this surface. Submission uses the production operation planner and atomic
envelope. A form Core would refuse at a setvalue (a preload or starting value
that does not cast to its question's type, or a requested repeat row whose
starting value does not) is `FormRefusedError` (`form-refused`), a test-input
refusal with the sentence Preview shows. Its receipt overlays the entry case database, including just-closed
records, before evaluating the next task. It separately overlays the session's
latest record catalog, preserving unrelated rows learned by Sync while the
submitting form was open. A direct linked form keeps the entry-plus-effects
snapshot; an ordinary new entry uses the updated session catalog.
Sync applies the production restore closure, whose owned seed reaches the
worker's claim rows. A records screen whose module has an effective Search,
once its search has run (`records.ts::recordsReadSearch`), reads HQ's
population: the Project's open cases of the type, with each row marked held or
not by the session's restore, and the Details and selections of cases chosen
there read it too. Choosing a searched record the session's restore does not
hold claims it, where CommCare posts the claim (`run.ts::postAppTestClaims`,
the browser's `lib/preview/searchClaims.ts` rules): a search action's at the
result, and in a menu whose forms read the search when its case-loading form
opens, with the entry's other case datums under a selected parent. A claim
writes a claim row in the journey's namespace (the namespace store's
`claimCases`, inside the step's transaction), owned by the session's worker,
and reads the session's device snapshot again, so the form opens over it; on
Android it reads the device again also after a claim that created nothing,
since Android follows every claim with a sync. Two sessions of one worker in a
journey share that worker's claim rows, as two devices of one worker share
HQ's, and each sees them at its next device read; the rows go with the
namespace when the journey finishes, and a journey never reads the running
Preview's claims. A session retained while claims were session state may still
store `claimedCaseIds`; `retainedState.ts` reads it and drops it. A case list
menu entry's list (`navigation.ts::isCaseListMenuItemList`: the list the
menu's entry opened, or a bare case list's landing) routes a chosen case by
`caseListMenuItemSelection(context.rules)` instead of opening a form, and on
Android its Details answer `continue` with Done, which returns to the list; the
menu observation lists the entry after the forms (`caseListEntry`) only while
it still needs a case the screen has not chosen
(`menuProjection.ts::previewCaseListMenuEntry`), so a case-first menu with its
case chosen does not list its own, and the `records` action chooses it and
opens its list. A home or menu screen also lists, in place, the forms and
case list entries of each menu that shows its forms there
(`navigation.ts::appTestScreenForms`, `appTestScreenCaseLists`, over
`menuProjection.ts::previewScreenEntries`): its observation carries them as `forms` and
`caseLists`, each naming the menu it belongs to (`menuUuid`), the menu's own
entry staying `caseListEntry`. The `form` action opens a listed form from its
own menu, and the `records` action takes an optional `moduleUuid` naming the
menu whose case list to open, needed where the screen lists several and
omitted on a menu for its own. Choosing a menu lands where Preview lands it
(`moduleDestination`): a case-first or bare case list screen on its records,
submenus or not. A menu that needs a parent case the session lacks asks for
it before its screen only where Core does
(`engine/parentCaseSelection.ts::previewParentCaseBeforeMenu`); a menu that
lists a survey or a registration beside a follow-up lists its forms first,
and the `form` or `records` action that needs the parent opens the parent's
records first (`navigation.ts::enterAppTestForm`, `appTestCaseListScreen`),
then the form's own records or the list with its mark (`resumesList`); a
survey there opens with no parent. A case chosen on a parent's records goes
on at once unless the datum it chooses for names a details screen
(`navigation.ts::appTestRecordsHaveDetails` over
`previewParentCaseListHasDetails`), which a basic menu never gives a
parent. Once a case is chosen, `continue` opens a form only where the
worker chose it before the case (or a retained command names it), and then
the menu is not listed and no condition is read; otherwise the observation is
the menu, listing its forms however many there are, and the
`form` action opens one (`menuProjection.ts::previewRequestedForm`), as a
device lists a menu after its case. A next-task failure preserves an
already successful test submission.
An action rejected before submission leaves no partial effects.
A screen Core would fail because a
condition it reads asks for data the device lacks (a worker key the worker has
none of, a table with no rows) is the action's refusal too, in the data
refusal's words (`dataRefusal.ts::appTestDataRefusal` over
`engine/dataRefusal.ts`), never an aborted call. It is worded for the surface
Preview shows it on, the inner read's name winning
(`dataRefusal.ts::readingSurface`, `engine/surfacedDataRefusal.ts`): a case
list's filter, columns, order and Results read and the Search action's
condition the list's, the Search screen's starting and hidden values,
choice lists and checks the search's, a form's the form's, the links after it the links', and
an unnamed read a menu's display condition; and for the worker the session
runs as, by the persona's name. The Search screen opens as Preview opens it
(`engine/searchRunState.ts::openSearchRunState`, through
`engine/searchEvaluation.ts::evaluateSearchSnapshot`): a menu that opens on
its search or its results refuses as it opens, and a list that opens first
keeps its records, holds no search, observes `search.refusal` and refuses
the `search` action, as Preview's Search pane shows the refusal. The list's
assigned-case exclusion refuses only where a Results read is made, as the
list's (`engine/serverSearchRead.ts::serverRecordsRead` over the snapshot's
`exclusionRefusal`), so a menu on its Search screen opens. A refusal
met after a submission saved (the links' conditions, the next screen's menu
or list) keeps the save and is the observation's `nextTaskError`, as Preview
shows it on the next step (`__tests__/dataRefusal.postgres.test.ts`).

Retained sessions expose held-open interleavings: open a form in A, submit in B,
then observe or submit A. Explicit sync refreshes only the addressed session's
record catalog and preserves its open form's entry snapshot, defaults, answers
and repeat identities. Every active observation labels its session and compact
session directory. `recordSources` distinguishes current isolated-store
Results/Details and submission evaluation from retained open-form data. A
current-store condition can protect Preview's serialized Postgres submission;
these receipts do not prove offline native conflict resolution or fresh native
case reads.

Limits are eight active tests per app, 200 steps, 2,000 accumulated records and
16 MiB of state per test. Continuation expires after 24 hours. Explicit finish
drops the namespace; another start reclaims expired namespaces for that app;
app deletion also drops its namespaces. Observations remain readable after
finish or expiry. There is no background claim of physical deletion at 24 hours.

Builder renders retained observations, not a second simulator. The result proves
only the observed Preview/Postgres behavior of its recorded revision. It does
not execute native devices, HQ synchronization, attachment upload, deployment,
or automations. Keep unavailable observations explicit. Normal-agent discovery
and independent browser/native acceptance are separate quality evidence.

Recorded evidence returns ISO timestamp strings at the shared read boundary. Server Actions can carry `Date` instances, but model JSON tool results cannot; the real Postgres journey test passes history through the SDK message schema before counting it as readable evidence.

Single-record selection follows the browser's shared row-action decision. A
configured Details screen exposes ordered, formatted values through the same
cell projector as the browser. Continue reloads the selected identity using the
production device-scoped detail reader and then applies ordinary form/menu
eligibility. Informational details have no Continue action. Details opened
through ordinary Back read current stored values, even if the record no longer
matches its old Results page. Back retains the visited destinations; returning to a form
starts a fresh entry (`navigation.ts::appTestBackScreen`), which carries no case list
Register launch, since a launch belongs to the one entry it opened. Each visited
destination keeps the case selections the session held while it was shown
(`types.ts::AppTestHistoryEntry`, written by `navigation.ts::appTestHistoryEntry`
at every push), and Back returns to them (`appTestStepBack`), so a case chosen
after that screen, a parent case asked for after a form's command included, is
let go and the next walk past it asks for it again. One rule on both platforms:
Android's Back is `CommCareSession.stepBack`, which pops each datum collected
since, and Web Apps' is the previous address, whose `selections` Formplayer
replays. Sync refreshes those kept selections with the session's own. These
observations describe Preview navigation, not a native session-stack proof.

A leaf record's inline form chooser carries its selection on that screen and
offers only case-loading forms, matching the browser chooser. It
does not add a persistent menu datum. Parent selectors and explicit link-carried
selections keep the production menu-context lifetime. An explicit module
destination reopens ordinary Results in a leaf case-first module. The `previous`
destination instead uses the same native task projection as Preview: forms-first
reopens that exact form's picker; case-first retains the ordered selection and
returns to its module menu. It does not return to visited Details. The receipt
world continues into the next form, including a just-closed retained record.
An already chosen form command completes selection without rechecking its menu
offering condition; a returned module menu evaluates its offerings normally.
Back from the form
returns to the original Results/Details destination, not the transient chooser.

Form observations return only the current page’s questions, available sections,
the canonical presentation hierarchy and whether Submit is offered. Presentation
nodes preserve containers and repeat-instance boundaries in worker order.
`pageNext`/`pagePrevious` follow the production available-page projection;
`routeBack`/`routeContinue` navigate screens and Details. Existing `back` and
`continue` remain route aliases. A `section` action validates forward pages before
entering the target; Back retains existing rows and answers. Future-page answers
and early submissions cannot bypass this progression. These use the browser’s
FormEngine insertion and paging projections, not a separate simulation.

Ordered calls accept up to eight actions. `addresses.ts` resolves each authored
name/section path against the authorized pinned snapshot and current screen,
after receipt replay and immediately before execution. `service.ts` owns each
action savepoint; explicit worker/input refusals stop with the persisted prefix,
while unexpected failures roll back the call. `app_test_requests` owns the
complete response receipt; individual action rows share its request identity.
`finish` may follow submission in that same call: namespace disposal checks its
deferred foreign keys before dropping the records, and the final evidence and
whole-call receipt commit atomically with that disposal.
Pre-batch singular receipts retain their original UUID-normalized digest. On
a digest mismatch only, the shared boundary retries that original preparation
against the authorized pinned document, so a later rename cannot break replay.
A 60-second transaction deadline covers the whole call, including lock waits.
Every form, search and after-submit worker shares one monotonic execution
deadline, reserving five seconds for termination and persistence or rollback
(ten percent when a caller shortens the overall deadline). Workers join their
termination before an execution deadline failure aborts the whole call; this is
not an input refusal and cannot commit the earlier action prefix. A rollback
failure cannot replace the original transaction exception.
Caller disconnection is not propagated as a separate cancellation signal here.
The 200-step bound still counts individual worker actions.

Selected language belongs to test state, defaults to the app default and can
change only to a configured structured language identity. Form checkpoints
reinitialize with retained answers/defaults/repeats exactly as browser language
changes do. `runtimeMessages.ts` owns English/Spanish platform copy; every
observation identifies catalog fallback. Authored translations remain separate.
Results and Details share formatted cell projection, including the browser's
localized record-choice labels. Route context exposes
retained ancestor/record selections. Submission evidence proves isolated case
commit only; serialized submissions and retained reports stay `not-observed`.
`savedInTest` means the isolated submission transaction and idempotency receipt
committed. `evidence.collectionScope` is `disposable-case-store`; `casePatch`
distinguishes a persisted case patch from `none`. A plain survey can therefore
be accepted with no case effects. This path creates no submitted-answer document
archive. Earlier journey observations retain inspected answers as test evidence,
not as an independently retrievable collection report.

Evidence reads have a fixed upper step, ten-step default/twenty-step maximum
and 64 KiB response budget. `evidence.ts` exposes oversized persisted values by
explicit bounded paths and offsets. The start/source/runtime provenance travels
with every page. Builder pages these same rows rather than loading all history.

Runtime version 12 also applies Preview's custom-constraint wording policy
through the actual observation worker: empty wording or a typed reference to
several live answers leaves the form invalid with its localized warning and
retained answers, without a proposed submission. Rules, ordinary prose and other
XPath failures remain bounded test-input refusals. User-controlled row removal
can restore exact custom wording on the next observation.

The runtime preserves the synced session catalog across submission while
direct form links retain the submitting entry plus its committed effects.
It also pins retained worker sessions, the shared presentation
hierarchy and distinct page/route controls, alongside case-list metadata reads:
Results/Details expose built-in dates at native calendar precision, and
calculated columns and calculated ordering read them under the list's reading
(a browse list's casedb day; over a search's results, `date_opened` the UTC day
and `last_modified` its instant), while custom datetime values keep their
clocks. Retained
older observations remain readable, but a fresh journey is needed to execute
these semantics.

A Previous-retained menu or selector carries its saved device world into every next form, including surveys and registration. The next form's actual owner entry datums supply its missing selectors. Normal Back preserves a retained menu's world; explicit Sync refreshes every pre-entry retained world and its selected-row values, including retained menus and Details' pending source selectors in history, while an already-open form keeps its captured entry. Persisted retained task snapshots rehydrate timestamps just like form entries and the device catalog.
An explicit module destination retires the destination's own leaf selection
when the owner's target frame has no such slot. Parent selections and explicit
form-link target selections retain their existing identities.

Shared tools translate expected setup and evidence refusals into authoring input
errors with their causes retained. Submission expression refusals identify the
operation, slot and source field identities. The action savepoint retains earlier
actions while rolling back the whole failed submission. Database connection,
permission and compiler failures still abort the call as infrastructure faults.

Answer, section and page-turn observations reuse the evaluation that produced
their exact next form screen. The normal language, route and action decoration
still applies. A standalone observe, navigation, identity change or submission
performs a fresh evaluation; no result is cached across actions or sessions.


The records screen's `clearSearch` action clears every visible search answer and retires the previous result. A desktop Web Apps journey with `caseSearchConfig.searchOnClear` submits the cleared values through prompt validation. Android has no Clear action.

A date range on a visible Web Apps Search screen displays the dates its client can read. Pressing Search submits the encoded field text, while an automatic search uses Core’s opening answers. On Android the worker sees the native raw fallback. A journey supplies the two editable date ends by name. A continued journey holds its system-generated open answer privately.
