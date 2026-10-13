# Repeated authoring response recovery

This procedure repairs the presentation damage caused by a completed question
card repeatedly triggering a continuation that replays the same final response.
It does not resume a model, alter requirements, or certify an app as complete.
Use it after the continuation fix is live, so a stale browser cannot restart the
incident. Production writes remain an operator action following release approval.

## Scan and preserve evidence

Run `npx tsx --conditions=react-server scripts/scan-authoring-amplification.ts --prod`.
The scan covers all design-targeted threads, including materialized sessions, in
pages of 100. It reports repeated trailing final-text parts after an answered
question card, whether there is exactly one durable architect origin, and whether
the narrow repair can proceed. Conversation contents and holder nonces are not
printed. Histories outside this signature require investigation; an empty scan is
not proof that all possible continuation failures are absent.

For each finding, inspect the session with
`npx tsx --conditions=react-server scripts/inspect-design-session.ts <session-id> --prod --json`
and preserve that output in a private incident directory. Preserve source
availability, plan/review, model-context, usage and lease evidence before deciding
whether to repair or discard. Model-context items and historical usage must remain
unchanged.

Verify the exact scan with:

```sh
npx tsx --conditions=react-server scripts/repair-authoring-amplification.ts <thread-id> --prod --guard-digest <guardDigest> --transcript-digest <transcriptDigest>
```

The default verifies without writes. To apply, add `--apply --evidence-file
<new-private-json-path>`. The file is created exclusively with mode 0600; an
existing file is never overwritten. The transaction compares the complete session
and thread authority, transcript digest, and durable context evidence against the
scan. Any intervening activity requires a fresh scan. Active streams, live holders,
and sessions bound to an app refuse repair. The script never clears a lease to
make a repair possible.

## What the repair changes

Only a contiguous suffix of identical completed text parts is reduced to one copy,
and only when exactly one matching architect response proves its origin. Earlier
message and part positions are unchanged, preserving legacy answer identities.
The repaired assistant message receives the existing cap-zero history tombstone,
so an older browser cannot restore its larger copy on a later send. No input round
is fabricated; existing round state, plans, attachments, model contexts, credits,
usage and session state are untouched. A legacy text pause continues only with a
genuine new user message through normal admission.

## Verify recovery and disposition

For the two October 9 incidents, the frozen snapshots show:

- `9f3af244-1bea-4d6a-b9f0-c31e4e6d3423`: 1,918 copies of the final text; a reviewed
  plan and two source documents survive. The user chose to supply missing
  reference data and retained full owner phone reports as a requirement. Keep the
  honest pause pending that data and consequential operational decisions. Do not
  replace the missing data with invented records or label an unverified reporting
  or transfer path complete.
- `602c66cd-22b6-45eb-83c5-aabc74c97308`: 6,539 copies; no plan or saved app. The
  filename, destination and user answers survive. Keep it only if ordinary library
  discovery can resolve the authorized sources and a genuine new user turn can
  continue planning. Missing attachments alone do not establish corrupt state.

The October 9 read-only production census covered 15 design-targeted threads and
found exactly these two affected histories. Both have one verified canonical
model origin and meet the inactive pre-app repair guards. Their transcript digests
still match the frozen incident snapshots. The initial scan incorrectly examined
the encoded persistence envelope as a model message; the corrected scan verifies
each stored item digest and uses Nova's production model-message decoder. Preserve
both scan receipts as investigation evidence; no production repair was executed.

An isolated replay of both actual frozen histories through the production repair
planner, source loader and client continuation controller also passed. Normalizing
the transcript preserved every source request and its legacy durable answer
identity, both captured source documents (52,621 characters), and the original
snapshot/context digests. For each history, 42 automatic-continuation checks
across original, normalized and reloaded state allowed zero submissions and
reported an explicit typed-input wait. A genuine new user message added exactly
one source request. This supports retaining both honest pauses; it is not a model
resume or a completed-app test. The offline source adapter reconstructed captured
tool-read bytes, so it does not establish current library access.
To repeat this isolated check, load the captured session JSON without modifying
it, apply `planAuthoringAmplificationRepair`, and compare `loadSourceMaterial`
before and after using the complete captured `readSource` chunks as the offline
asset adapter. Match every answer's legacy key and content to its captured
architect source item. Run `createInputRoundContinuation(null, true)` against both
histories and again after controller recreation; assert that automatic claims
are refused and typed input is awaited. Keep the new report beside the original
evidence, and do not convert this pure replay into a production resume.

Both snapshots contain bounded durable model contexts rather than thousands of
model responses. This supports repair, not a guarantee of the eventual app's
quality. Verify source identity and availability, retained answers and plan,
ordinary fresh-message continuation, one consumed input round, stable idle state
after completion/reload, and absence of duplicate model work. Controlled-provider
browser and database evidence can prove those mechanics without paid model calls;
it cannot prove an actual completed app satisfies unresolved requirements.

If a session cannot pass these recovery checks, discard it through
`discardDesignSession` with the exact owner and current Project. This canonical
operation retires mutable recovery carriers and refunds an unsettled reservation,
while retaining transcripts and artifacts as evidence. Do not hard-delete rows,
manually clear authority, or manufacture an empty resumable session. After repair
or discard, rescan and verify the user's list and original deep link reflect the
chosen disposition. Report remaining user input separately from a technical
failure.
