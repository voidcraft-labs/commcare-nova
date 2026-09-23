# Ordinary authoring observations

The starting implementation was Nova `090a493a`. Historical incident evidence is
private; no customer source or transcript belongs in this document. This is the
source-level explanation of the changes, not a claim of autonomous quality.

| Observation boundary or failure | Owning source and consequence |
| --- | --- |
| A single-form check cannot observe entry or submission | `engine/evaluateFormSnapshot.ts` reports question state and proposed values. It cannot discover an unreachable menu or effects that only an actual submission produces. Shared app-test tools add bounded navigation and isolated production transactions. |
| A role is not a Preview identity | `tools/users.ts`, `preview/engine/identity.ts` and `PreviewIdentityMenu` distinguish saved personas from HQ accounts and real-actor authorization. Worker-readiness projections expose missing personas and place context; test-only places do not claim deployment setup. |
| Omitted configuration can still have effective behavior | `domain/casePreload.ts` and `caseWriteInventory.ts` supply automatic starting values and ordinary writes. Effective question reads expose those facts so inspection need not infer them from raw fields or invent redundant defaults. |
| Lifecycle metadata can be mistaken for arbitrary fields | `standardCaseProperties.ts` and the upstream evidence in `record-lifecycle-authoring.md` distinguish operational closure, business state, creation, modification and ownership. Durable business-event history remains a separate requirement. |
| Reviews repeatedly started without their own investigation | `build/modelContextStore.ts` previously carried predecessor messages only for the architect. A peer's new review generation discarded that context. It now carries its own observations, preserves source deduplication and receives the current revision and durable correction focus. |
| The shared plan became a convenient review log | `planning/store.ts` already retains immutable revisions, but the new peer could only see the current plan without its own prior context. Retaining review evidence removes that need. Planning tools and prompts ask for current design, with findings in the retained review conversation. This changes the incentive; trial measurements must establish whether plan growth actually improves. |
| Activity labels drifted from executable tools | `sharedToolRegistry.ts`, `toolPresentation.ts` and `chat/toolSummary.ts` now connect registration to presentation and distinguish checks, changes, failed observations and no-ops. A form check or isolated submission cannot imply a live successful submission. |

These causes do not excuse poor judgment or misread feedback. Ordinary-agent
trials must inspect the actual calls and conclusions, including false findings.
The new observations give the peer a way to discover and reproduce consequential
workflow errors. They do not guarantee that it chooses good journeys or interprets
them well. Follow-up review remains independent and may broaden when a correction
has wider consequences; no finding-disposition ledger or automatic pass verdict
has been added.

## Development trial: premature completion

The first bounded trial requested a small tool-lending app. After eight model
calls, the architect delivered a reviewed plan and paused without building.
The request asked for an app; no consequential question was pending. Its
reasoning explicitly treated the injected `phase: planning` user message as a
restriction, despite the system guidance to continue through construction.
The available tools included `startBuilding`. This was a misread observation,
not an unavailable construction capability.

The turn-start snapshot now reports whether an app has been saved, plus the
actual plan/workspace, rather than supplying a phase label that can be mistaken
for the user's desired scope. The original incomplete attempt remains evidence;
a new attempt with the same request will assess this change. Its plan review
correctly distinguished business status from lifecycle closure, but that did not
make the app request complete.

## Development trial: app review blocked its own observations

After the architect updated the plan to match the saved app, the peer attempted
to start an isolated journey. The shared authoring session treated the test as
an external data mutation and tried to create an edit workspace. That workspace
requires a reviewed plan, so the observation failed while review was in progress.
The peer fell back to form checks and reported that submission/navigation remained
unverified. This was an inaccessible capability caused by the product boundary,
not failure to choose the provided test tool.

Disposable tests now use the authorized saved snapshot without opening an edit
workspace. Pending app edits still refuse a test until saved; real data writes
still use their existing gate. The production-loop regression edits the plan
during app review, starts a journey at the saved app entry and finishes it, all
through the ordinary peer tool dispatch and real Postgres.

## Test input mistaken for a worker interaction

An ordinary repair supplied a two-number location string to a disposable form
run. Storage rejected it, and the agent added a worker-facing four-number format
hint. That finding confused a testing adapter with the worker UI: Preview's
`GeopointPicker` already formats selected coordinates through `formatGeopoint`.
The location question was not a raw string input requiring that instruction.

Form checks and journeys now accept typed coordinates and share that exact
production formatter. Their question projection identifies a location picker;
malformed supplied locations are classified as test-input errors before engine
mutation. Existing complete string values remain accepted. Authored validation
and requiredness remain observable; GPS and map-service behavior remain outside
the evaluator. This corrects the observation boundary instead of teaching the
agent another incident-specific exception. The original false finding is retained.

### Recorded history must cross the model boundary

A normal repair reopened a saved journey, then stopped before its next model
call with an invalid-message error. The shared history reader returned Postgres
`Date` instances for expiry, disposal and step creation. Builder could display
them, and JSON logging disguised them as strings, but the SDK's model-message
JSON schema rejected the original objects. A real Postgres journey followed by
the ordinary shared read and SDK validation reproduced the failure. The shared
read now emits ISO timestamps explicitly. Browser readability and storage
correctness had not established agent readability.

## Operation relevance and user handoff

The ordinary delivered-app repair independently found and corrected a child
ownership defect. Its disposable journey then showed creation, cross-role review
and saved status changes. Independent execution of that saved export in Core
confirmed owner and parent, but found the business status blank: the operation
read a defaulted question whose relevance was false. All forms parsed. The
Preview result therefore overstated native behavior.

The production FormEngine's normal expression reader already projected effective
relevance, but `computeOperationAnswers` copied raw instance values and expanded
all retained repeats. The storage executor correctly consumed that incorrect
projection. The correction applies the existing effective-relevance view to
operation bindings, preserves blank bindings for scalar references, and supplies
empty scopes for excluded repeats and their descendants. Retained answers remain
available if a worker makes the controls relevant again. The public shared
fixture is consumed by real Postgres and Core; it contains no customer material.

The repair's completion response also told the user to select a disposable record
in ordinary Preview after ending its test. The test output stated the isolation
boundary, but the focused guide did not identify the user's recorded-journey
entry or explain that it cannot replay submissions. The guide now exposes that
product fact. This observation does not turn the earlier response into a pass.
The delivered app still needs correction and renewed evidence through ordinary
intent after the runtime fix is live.


## Private edit admission and checkpoint history

A fresh bounded role trial exposed a disagreement between successful private
edits and the first-save gate. Construction created a module, removed it, then
created a replacement with the same supplied identity. Each operation admitted
against the current overlay, where the removed identity no longer appeared.
Saving concatenated the complete pending mutation history and rejected the reuse.
Removing the later replacement could not remove the earlier conflicting mutations.
The architect recognized the integrity failure, but ordinary tools could not
repair that accepted history. A clean candidate inspection was misleading here.

`ChangeSetMutationWorkspace` now prepares the complete pending batch against its
original base before accepting another stage, using the canonical admission path.
Removed identities remain reserved until the checkpoint commits. A failed
replacement leaves the private revision unchanged, retains a retryable rejection,
and permits a replacement with a fresh identity. No accepted history is rewritten.
The real Postgres regression fails on the prior code, then proves rejection after
workspace reopening, identical retry, successful correction and canonical commit.
Existing genesis, authority, rebase and effective-edit checks also pass. This
prevents the demonstrated dead end; it does not rescue or pass the failed trial.


Fresh code review found a related reduction mismatch: clearing and restoring an
optional translated hint kept its translation in the cumulative candidate, but
reopening reduced each old step separately and pruned that translation between
steps. Rehydration now reduces the combined batch once, matching staging and
canonical save. A second real Postgres regression fails on the reviewed revision
and compares the complete staged, reopened and committed content. The correction
rechecks pending history on each stage; its cost grows with unsaved work and must
be measured alongside agent calls, rather than claimed to be free.

A local comparison used the retained trial's last admissible prefix: 21 pending
steps and 120 mutations. Across ten measured iterations after warm-up, median
admission/reduction time was 1.42 ms for the prior overlay-only operation and
6.62 ms for cumulative preparation (ranges 1.30–2.94 ms and 6.27–8.04 ms).
These measurements include cumulative envelope preparation but exclude resource
reads, validation, persistence, tools and model latency. They quantify this
bounded candidate only; long unsaved histories still need proportionate checkpoints.

## Authentication recovery during database failures

Persistent production database timeouts affected authoring, Preview and release
verification. Read-only investigation found slow fresh connections and failures
in Cloud SQL's own local health queries and transaction-log archiving. A lock
snapshot showed no waiting locks; observed connections were below their limits.
Active swapping was present, but conflicting memory metrics did not establish
RAM exhaustion by themselves. No active project-specific service incident was
reported. One approved database restart restored archiving. The first fresh
connection remained slow, but after initialization settled, connection setup
fell from 19.8 seconds before restart to 0.36 seconds and the same small queries
fell from 0.31–2.49 seconds to 54–75 ms. Cloud SQL's health metric returned to up.
MCP continued returning unavailable responses. This establishes observed database
recovery, not the underlying cause or lasting resolution of resource pressure.

That investigation exposed a separate, reproducible application recovery defect.
`lib/auth.ts::getAuth` cached the object returned by `betterAuth` immediately.
In the installed Better Auth implementation, `createBetterAuth` starts an async
context initializer, and the OAuth provider's initializer awaits `seedResources`,
which reads the database. The object's handler and API methods retain that
context promise. A transient connection failure therefore permanently rejected
the cached object's context, even though Nova's own loader promise had succeeded.
Production MCP logs continued reporting that connection error on requests that
returned much faster than the configured connection deadline.

The loader now awaits the object's context before caching it. Concurrent callers
share initialization; a failure clears the in-flight promise, allowing a later
request to create a new object. A controlled first connection failure against
the real library and migrated Postgres schema reproduces the former persistent
failure. Recovery then proves normal OAuth resource initialization, a shared
successful instance and an actual auth endpoint response. The existing native
OAuth and organization contracts still pass. This repairs failure recovery;
it does not explain or establish resolution of the database timeouts.


## Native selection validation and initially excluded queries

Independent execution of an ordinary repair's saved form exposed two failures
that isolated Preview journeys had not observed. No technical app-repair prompt
was supplied for these findings; the correction belongs to production export.

At Core `8e9ba8d908e95f4dc71c9ade0467c6ebfbfbd305`,
`FormDef.evaluateConstraint` sets `isConstraint` and `candidateValue`;
`EvaluationContext` copies them when changing context; and
`XPathPathExpr.getRefValue` returns that candidate when the reference equals the
current context. Inside a filtered collection, `.` can therefore read the
confirmation candidate instead of the stored selected-row answer. A count outside
validation returned one while the native controller rejected the confirmation.
A reserved sibling calculation removes only an independent filtered count from
that candidate context. Current-answer references, context-dependent paths or
functions, and nested predicate contexts are deliberately left unchanged.

A separate initially excluded query repeat captured its membership IDs but set
its count to zero at initialization. Reading those IDs while excluded yielded an
empty value; changing relevance did not rerun the one-time count. Deriving count
from the retained IDs through a relative calculate bind restores rows when shown
without rerunning the membership query. Relative paths also preserve each parent
iteration's cardinality.

The public `ContainerRuntimeTest` uses actual Nova CCZ and native HQ-regenerated
forms. It enters both direct and ancestor-gated query lists, changes relevance,
checks row identities, submits zero/one/multiple-selection confirmations through
`FormEntryController.answerQuestion`, and checks retained answers after hide/show.
It also proves candidate-dependent self-validation still sees the proposed answer.
The existing nested-query corpus runs alongside these cases. Pure planner checks
cover the transformation's conservative scope. Private saved-app checks cover
separate receipt effects and retained grower/contract associations. These do not
establish Android layout, remote submission, offline sync, or ordinary-agent
quality; the failed role trials remain failed.

## Matched model trial: observed defects and abandoned requirements

The later matched role trial separated three causes. The peer reproduced a
local-day error caused by SQL using the database timezone while forms used the
worker runtime timezone; PR #674 corrects that production contract. The peer
also demonstrated duplicate creation, but the architect stopped with a manual
search instruction instead of the available local-record validation. Existing
`evaluationContext.postgres.test.ts` exercises form queries through the ordinary
authoring boundary, and the matched control used one successfully. The focused
expression guide had explained selected and ancestor records but omitted queries
over other available records. It now explains that capability and its worker-
visibility/concurrency boundary. This is missing context alongside a judgment
failure, not evidence that more prompt admonitions alone will improve quality.

Independent browser inspection also found a gap in the journey observation:
record selection skipped configured Details and continued directly to a form.
Browser history could return to Details after submission, allowing another
attempt whose guarded operations changed no records. The test instead returned
to Results, hiding that experience. Journey selection now uses the browser's row
action and cell-value projection, with explicit Continue/Back and current,
device-scoped record reads. Native previous-screen semantics still need a
separate navigation check; mirroring observed Preview behavior is not proof of
a native session stack. Neither correction changes the failed trial's verdict.
