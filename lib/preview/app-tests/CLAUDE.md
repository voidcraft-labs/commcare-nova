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

`lib/case-store/appTestNamespace.ts` binds the production Postgres store to a
generated namespace inside that transaction. Every table the store can reach
must resolve there, with the current production column contract. No live case
rows are copied. Supplied records and fictional places exist only in this
namespace; saved lookup rows and actual place context are authorized read inputs.
Test-only persona assignments do not provision workers or establish deployment
readiness. The narrow store cannot alter schemas or dispatch media effects.

Navigation shares production menu, selection and routing projections. Search,
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
