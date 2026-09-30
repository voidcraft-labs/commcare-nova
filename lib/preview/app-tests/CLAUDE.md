# App test journeys

This is a separate, explicitly labeled disposable-record surface. Ordinary
Preview still uses the user's real records. Shared tools start at app entry as
the authorized actor, then choose only saved Preview identities and available
menus, records and forms. Do not accept a privileged replacement worker context.

`service.ts` pins the saved blueprint and authorized lookup/place snapshots.
External reads finish before the test transaction opens. Admission then locks
the source app and rechecks real-actor membership and the exact app revision.
`lib/db/appTests.ts` serializes actions, fences expected steps and runtime
versions, and commits state, observations and idempotency receipts together.
Only the creating actor can continue a test; current app members can read its
observations. Simulated worker identity never grants Project authority.

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
rows are copied. Start observations retain supplied record counts by type,
including an empty list when no business records were supplied. This is input
provenance, not a readiness verdict or a count of current worker-visible rows. Supplied records and fictional places exist only in this
namespace; saved lookup rows and actual place context are authorized read inputs.
Test-only persona assignments do not provision workers or establish deployment
readiness. The narrow store cannot alter schemas or dispatch media effects.

Navigation shares production menu, selection and routing projections.
Form evaluation receives a captured record snapshot before initialization. It
does not execute the browser's asynchronous record-loading hooks or React
lifecycle; those boundaries need browser evidence even when a journey passes.
Observations identify the evaluator clock and its calendar day. Form workers,
SQL record reads and submission calculations use the same process timezone;
ordinary browser Preview uses the browser timezone. Neither asserts a supplied
place has that timezone. `RUNTIME_VERSION` in `lib/db/appTests.ts` fences
execution semantics (section-entry checkpoints and page turns, scoped
initialization order, transient leaf versus persistent parent-menu selection,
Details with Continue/Back, the shared clock); bump it when those semantics
change. Older journeys remain readable but require a fresh test to execute. Search,
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
envelope. Its receipt overlays the entry case database, including just-closed
records, before evaluating the next task. Sync applies the production restore
closure. A next-task failure preserves an already successful test submission.
An action rejected before submission leaves no partial effects.

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
eligibility. Informational details have no Continue action. A returning Details
screen reads current stored values, even if the record no longer matches its
old Results page. Back retains the visited destinations; returning to a form
starts a fresh entry. These observations describe Preview navigation, not a
native session-stack proof.

A leaf record's inline form chooser carries its selection on that screen and
offers only case-loading forms, matching the browser chooser. It
does not add a persistent menu datum. Parent selectors and explicit link-carried
selections keep the production menu-context lifetime. After a leaf form returns
to its module, ordinary case-first routing reopens Results; Back from the form
returns to the original Results/Details destination, not the transient chooser.

Form observations return only the current page’s questions, available sections,
and whether Submit is offered. A `section` action validates forward pages before
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

Evidence reads have a fixed upper step, ten-step default/twenty-step maximum
and 64 KiB response budget. `evidence.ts` exposes oversized persisted values by
explicit bounded paths and offsets. The start/source/runtime provenance travels
with every page. Builder pages these same rows rather than loading all history.

Runtime version 8 also pins portable case-list metadata reads: Results/Details,
calculated columns and calculated ordering expose built-in dates at native
calendar precision, while custom datetime values keep their clocks. Retained
older observations remain readable, but a fresh journey is needed to execute
these semantics.
