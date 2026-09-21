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
