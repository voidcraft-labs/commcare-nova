# Reviewed executable app design

## Current architecture and the two remaining units

Nova turns one conversation into one high-quality app in the current Project.
The design is the executable private `BlueprintDoc` itself. The Solutions
Architect builds that candidate with Nova's ordinary semantic tools, an
independent reviewer checks the exact candidate, and the accepted digest
materializes as the app's complete canonical sequence 1.

There is no parallel requirements graph, Design Contract, traceability matrix,
BuildPlan, workflow-slice translation, or model-authored mutation/commit
protocol in this path. A small `DesignBriefV1` records only the user-facing
objective, consequential decisions, external requirements, unsupported work,
and genuinely open questions. It does not duplicate the app.

The foundation is complete through the reviewed initial build. Two units
remain, in order:

1. **Unit F: completion truth and Design history.** Bind a compact completion
   report to the exact accepted candidate and canonical app revision, and show
   a safe read-only history of what Nova designed, reviewed, built, and left as
   external setup.
2. **Unit G: reviewed edits and high-level MCP.** Reuse the same private
   Blueprint candidate, exact review, and atomic commit method for substantial
   edits and for clients that want Nova to run the reviewed workflow on their
   behalf.

This file is the present-tense architecture and the implementation contract
for those two units.

## 1. Product boundaries

### 1.1 One app state

An app is one canonical `BlueprintDoc`. Preview, export, deployment, case
schema, collaboration, the visual builder, the ordinary chat editor, and MCP
all consume canonical revisions.

A reviewed build has one additional private state space: an open Atomic Change
Set whose replayed mutations derive a private Blueprint candidate. It cannot
render, export, stream to peers, write case data, or become visible in the
builder. The existing validator and canonical transaction kernel remain the
only way a visible app revision can exist.

The accepted checkpoint is not a second app document. It records the private
workspace revision, exact Blueprint digest, source-package digest, brief, and
review lineage. Materialization replays the durable mutations and proves that
the resulting digest is the accepted digest.

### 1.2 One app and the current Project

One design session creates exactly one app in the current Project. Nova cannot
create, select, or switch Projects or CommCare HQ project spaces. When a
request asks for multiple apps, the initial author phase asks which single app
to build.

External resources stay explicit:

- Nova may attach media already authorized in the current Project.
- Nova cannot record, synthesize, upload, or claim to have created image,
  audio, video, document, or other media bytes.
- Places, lookup rows, workers, HQ configuration, build/release work, and
  deployment remain separately authorized resources or human prerequisites.
- Private candidate tools may read those resources through exact Project
  gates but may not perform unrelated external writes.

### 1.3 Direct editors stay direct

The visual builder, ordinary app edit agent, and existing shared MCP tools
continue to commit valid canonical changes immediately. They do not require a
reviewed design session or completion report.

The explicit blank-app action and MCP `create_app` continue to create the
minimal valid starter app immediately. They do not enter this reviewed build.

## 2. Reviewed initial build

```text
user request and authorized attachments
                |
                v
      owner-private design session
  thread, holder, credits, stream recovery
                |
                v
      durable private Blueprint candidate
 ordinary high-level tools + private handles
                |
                v
       exact candidate checkpoint
                |
                v
      independent exact-Blueprint review
                |
        +-------+-------+
        |               |
      clean         material findings
        |               |
        |               v
        |      targeted candidate correction
        |               |
        |               v
        |        focused verification
        |               |
        +-------+-------+
                |
                v
       exact accepted checkpoint
                |
                v
  atomic canonical sequence-1 materialization
```

The server advances this method from durable state. Transcript prose never
decides whether the candidate exists, whether review happened, which digest is
accepted, or whether the app materialized.

### 2.1 Source package

The source package is the bounded, authorized projection of user messages,
answered question rounds, attachments, images, and platform constraints. It is
digest-sealed and insert-only. The private candidate checkpoint records the
exact package digest it implements.

Attachments are extracted once and reused. The original user-visible thread
remains intact; model compaction changes only model context, not stored source
or chat history.

### 2.2 Candidate authoring

The author is the build Solutions Architect at Sol xhigh. It receives:

- the source package;
- the exact current private Blueprint summary;
- current validation findings;
- durable private handles;
- an independent review only during a correction phase.

It calls the same high-level Nova tools used by normal authoring:
`updateApp`, `generateSchema`, `createModule`, `createForm`, complete field and
case-operation tools, list/search tools, users, organization, automations,
lookup reads, and authorized media attachment tools. Granular staging,
mutation envelopes, revision numbers, commit calls, provenance bookkeeping,
and artifact protocols are not model vocabulary.

`stageModule` and `stageForm` are not mounted. Complete `createModule` and
`createForm` calls are preferred because a coherent workflow is admitted as
one valid semantic operation.

### 2.3 Identity

The model names new app objects with short candidate-local handles such as
`@registration` and `@client_name`. The server binds each handle once to a
canonical UUID and persists the binding with the staged request. Every
Blueprint entity family the candidate can create is handle-capable, including
worker properties, roles, personas, organization levels, place properties,
automations, and their nested items.

Canonical tool schemas accept an optional predeclared identity and retain
server-minted defaults on direct surfaces. Candidate-facing schemas require
the identity slot and widen it to `{ "handle": "@name" }`. The candidate
never invents or manages UUIDs. Model-visible tool results and recovered state
project durable handles back over authored UUIDs.

Locations, media assets, lookup tables/columns/rows, and other resources that
already exist outside the private candidate keep their real authorized
identity. A handle cannot pretend that an external resource exists.

### 2.4 Validity while authoring

Every semantic tool runs through the shared implementation and validator. A
step may leave findings only when later steps in the same private candidate
can resolve them; no intermediate candidate is canonical. `finishCandidate`
can checkpoint only when the exact current workspace is non-empty, all
external reads are current, and the ordinary whole-document and export gates
pass.

Rejected and wire-invalid tool calls are diagnostics, not a recovery strategy.
The production benchmark requires zero such calls. Tool schemas, descriptions,
handles, and complete operations must make the intended call valid the first
time.

Case-type retirement is batch-exclusive for canonical app edits because it can
migrate saved rows. The private genesis candidate has no app or case rows, so
review corrections may retire an unused case type and continue authoring in the
same candidate.

### 2.5 Design brief

`DesignBriefV1` stores only:

```text
schemaVersion: 1
appName
objective
decisions[]
externalRequirements[]
unsupportedRequests[]
openQuestions[]
```

The Blueprint holds modules, forms, fields, records, writes, lists, search,
access/navigation, users, organization, and automations. The brief never
restates those structures and contains no source citations or requirement
attribution matrix.

### 2.6 Independent review and correction

The reviewer is a fresh Sol xhigh structured call over:

- the exact source package;
- the exact private Blueprint JSON and digest;
- the brief;
- platform constraints;
- for focused verification, the findings that required the correction.

It evaluates workflow coherence, requirement coverage, data modeling,
frontline usability, access/privacy, capability boundaries, avoidable
complexity, and external readiness. Findings name human-readable Blueprint
objects or stable paths. Missing traceability paperwork is never a finding.

Critical and important findings block acceptance. Advisory findings do not.
The author changes the same private Blueprint and preserves correct work;
there is no whole-design resubmission. A corrected digest receives focused
verification rather than another open-ended review.

If focused verification still blocks, the candidate freezes and nothing is
published. The explicit **Continue build** control may reopen that exact
blocked checkpoint for one more targeted correction and verification. An
ordinary chat message cannot redirect the build. Correction phases cannot ask
new user questions; only the initial author phase may pause on a genuinely
blocking question.

### 2.7 Exact transactional state

`design_sessions` carries the active candidate change set, checkpoint, review,
and one durable phase:

- `authoring`
- `reviewing`
- `revising`
- `blocked`
- `accepted`

Candidate steps may append only in `authoring` or `revising`. A draft
checkpoint freezes the exact workspace in `reviewing`. A blocking review
moves to `revising` or `blocked`. Acceptance requires the exact active digest
and its required non-blocking review.

Every write reauthorizes the exact live `(runId, holderNonce)`, actor, and
current Project membership while holding the session authority carrier. A
stale process cannot append, review, select, accept, or materialize state.

### 2.8 Compaction and recovery

OpenAI server-side compaction is enabled before the long-context price tier.
Nova keeps the complete visible transcript while replaying the provider's
opaque compaction checkpoint and later suffix to the model.

After compaction, the server removes stale private-state messages and injects
a fresh summary derived from the durable workspace, including current
structures, handles, findings, and active review. Tool transcripts are not
authority and do not need to survive verbatim.

A process restart reopens the same change set, replays admitted steps and
handle bindings, reads the active checkpoint/review/phase, and continues from
that state. Request IDs make a lost tool response idempotent. Materialization
is also idempotent: a lost response reconstructs the sequence-1 receipt from
the canonical fold.

### 2.9 Atomic materialization

The accepted private candidate materializes in one transaction:

- exact session holder and Project membership are reauthorized;
- the change set and accepted checkpoint are locked and digest-matched;
- all admitted mutations replay from the canonical empty base;
- whole-document validity and export readiness run again;
- organization, media, lookup, and case-schema integrity run;
- the app row, entity rows, references, case schema, fold baseline, and
  sequence-1 change are written;
- the candidate changes from open to committed;
- the session holder and reservation transfer to the new app.

All writes commit together or none do. The first visible app is complete and
valid; no partial workflow is exposed for editing.

### 2.10 User experience and observability

While a reviewed build is active, the transcript remains readable and the
builder remains read-only. New chat, arbitrary sends, and direct app edits are
disabled. Initial questions temporarily enable the answer UI. A stopped
pre-app build shows one **Continue build** action, not repeated generic retry
cards.

The status line stays next to the composer and names only user-meaningful
phases: designing, reviewing, improving, building, waiting for an answer,
ready, or stopped. Private tools, schemas, validation internals, review counts,
severity language, model instructions, UUIDs, and reasoning are not rendered
as chat content.

Structured diagnostics record model usage, cache reads/writes, compaction,
phase duration, tool name, input size, duration, and accepted/rejected outcome.
They do not log customer-authored display names or private model content.

The representative complex-app browser benchmark is quality-first and must:

- finish from one user run without manual tool retries;
- produce zero wire-invalid or rejected candidate calls;
- preserve the full requested app, not merely materialize a subset;
- exercise review and any correction on exact saved state;
- remain under the $15 estimated model-cost target;
- leave enough diagnostics to explain every failure before another paid run.

## 3. Unit F: completion truth and Design history

### 3.1 Goal

Unit F makes Nova's final claim durable and inspectable without adding another
translation or model loop. The independently reviewed candidate is already the
exact executable app; materialization proves the canonical sequence-1 digest
matches it. Completion therefore attests that chain instead of reconstructing
requirements from names or asking another model to review the same document.

### 3.2 Deterministic completion projection

Add a compact deterministic projection over:

- source-package identity and safe source labels;
- accepted candidate checkpoint and brief;
- full review and any focused verifications;
- canonical app ID, sequence, and snapshot digest;
- ordinary validator and export-readiness verdicts;
- current external-resource readiness;
- external requirements, unsupported requests, and open questions.

The projection reads repository state only. It performs no model inference,
does not invent historical intent, and does not require intent attribution,
construction groups, slice receipts, or implementation coordinates. Exact
candidate-to-canonical digest equality is the implementation proof for an
initial build.

### 3.3 Completion report

Persist one immutable `design_completion_reports` row bound to the projection
version and digest. Its status is one of:

- `complete`
- `complete-with-external-setup`
- `incomplete`

Nova may say complete only when:

- the session has an accepted candidate;
- its required review chain has no blocking finding;
- the canonical app at the reported sequence has the accepted digest;
- the ordinary absolute gate and export readiness pass;
- no candidate change set remains open;
- no open question remains;
- every external requirement is either satisfied or named in the
  `complete-with-external-setup` result;
- unsupported requests are never described as built.

A newer canonical sequence makes the report stale by exact comparison. Stale
or incomplete reports never block use, preview, export, or direct editing of a
valid app.

### 3.4 Read-only Design history

Add a read-only Design surface showing safe projections of:

- the objective and consequential decisions;
- what app revision was independently reviewed;
- user-relevant review resolutions without counts or severity theater;
- external setup, unsupported requests, and open questions;
- completion status and whether it is current for the app.

Do not show raw source bodies, private tool calls, mutation payloads, internal
IDs, model prompts, model reasoning, or technical validator messages. Source
attachments remain separately authorized.

### 3.5 Persistence and authority

Unit F adds only `design_completion_reports`. Rows are insert-only,
exact-parsed, digest-bound, and Project-authorized through their design session
and app. Include privileges, probes, Project movement, deletion/retention,
inspection, and migration tests in the same unit.

### 3.6 Unit F acceptance

- The report proves accepted-candidate digest equals canonical snapshot digest.
- Sequence N reports are stale at N+1.
- No model call is required to attest an unchanged accepted candidate.
- External setup and unsupported work are stated honestly.
- Design history is useful to a user and reveals no private machinery.
- Direct builder, chat-edit, and MCP mutations ignore completion reports.

## 4. Unit G: reviewed edits and high-level MCP

### 4.1 Goal

Unit G gives substantial app changes the same quality, review, recovery, and
atomicity as the initial build while preserving immediate direct editors.

### 4.2 Reviewed edit candidate

A reviewed edit creates `design_sessions(mode = 'edit', app_id = ...)` bound to
the app's exact edit holder, Project, base sequence, and snapshot digest. Its
private Atomic Change Set starts from that canonical Blueprint rather than the
empty base.

The user request and current app projection form the source package. The
Solutions Architect edits the private Blueprint with the same ordinary tools
and handles, records a small amendment brief, checkpoints, receives exact
independent review, corrects if needed, and atomically commits the accepted
digest as one canonical revision.

An edit design session never owns a second holder or credit reservation. Every
stage, checkpoint, review, and commit proves the exact app holder and current
Project membership.

### 4.3 Amendment brief and reconciliation

The amendment brief records only:

- the requested outcome;
- consequential decisions;
- affected user workflows in plain language;
- external or destructive consequences;
- unsupported work and open questions.

Before authoring, compare the exact current Blueprint with the reviewed edit's
base. Human, builder, direct MCP, migration, or another agent may have changed
the app. Unmapped implementation is valid current state, not corruption.

If the base changed before the first private mutation, restart from the new
base. Once mutations exist, missing targets, changed kinds, removed anchors,
Project movement, or semantic conflicts stop with a structured conflict. The
model never retargets by name or similarity.

Apps without prior reviewed history begin from the deterministic current
Blueprint plus the new source-grounded request. Nova may describe what exists
but never fabricates original rationale or discarded alternatives.

### 4.4 Destructive and external work

A destructive edit names the affected app structures, case/data consequences,
external consequences, and any confirmation or exclusive-schema requirement.
External destructive actions remain separate confirmed workflows and never
stage inside the private Blueprint candidate.

### 4.5 High-level MCP

Keep every existing shared MCP tool immediate and canonical. Add a separate
reviewed workflow that operates in product terms, for example:

- `start_reviewed_app_change`
- `get_reviewed_app_change`
- `submit_reviewed_app_answers`
- `execute_reviewed_app_change`
- `get_app_design_history`
- `abandon_reviewed_app_change`

Names are finalized with the MCP implementation, but the contract is fixed:
clients receive closed states such as awaiting input, designing, reviewing,
ready to commit, complete, incomplete, or conflicted. They receive safe
projections and durable session IDs, never private steps, holder nonces,
source bodies, UUID-minting duties, model prompts, or reasoning.

Every mutating call has a request ID and exact input digest. Identical replay
returns the original result; reuse with different input rejects. The server
owns session, app, run, holder, checkpoint, review, and commit identities.

Do not expose public begin/stage/commit change-set primitives. That protocol is
private implementation machinery, not a user or MCP product surface.

### 4.6 Unit G acceptance

- Reviewed edits reuse the direct Blueprint candidate rather than a parallel
  contract or slice plan.
- The app row remains the sole edit holder and reservation authority.
- Existing app meaning is never inferred beyond observable Blueprint state.
- Concurrent semantic conflicts stop without name guessing.
- The accepted edit commits atomically as one valid canonical revision.
- Direct builder, ordinary chat edits, and direct MCP tools remain immediate.
- High-level MCP replay cannot duplicate sessions, runs, checkpoints, or
  canonical commits.
- Questions and blocked review continuations are durable and stale-answer safe.

## 5. Verification and delivery discipline

The maintained foundation tests cover:

- exact holder and Project reauthorization on every durable write;
- idempotent staging and handle binding;
- checkpoint/review phase transitions and digest lineage;
- review-blocked correction and explicit continuation;
- atomic sequence-1 materialization and replay;
- whole-document, export, organization, media, lookup, and case-schema gates;
- compaction state reinjection;
- UI locking, question pauses, status placement, and continuation;
- prompt/model/cache/usage configuration;
- absence of model-authored UUID and commit protocols.

Unit F adds completion-report, staleness, authorization, deletion, and Design
history tests. Unit G adds edit-base conflicts, atomic commit, destructive
confirmation, MCP idempotency, and multi-process recovery tests.

Each unit includes migrations, runtime types, privilege convergence, scripts,
docs, focused tests, changed tests, scoped leak checks, typecheck, frozen-SHA
`codex review`, review fixes, and PR delivery. Paid schema or browser/model
benchmarks require explicit approval.

## 6. Final product principle

Nova spends model work where it improves the app: understanding the user's
workflow, authoring the real executable Blueprint, and independently reviewing
that exact result. Durable state makes those calls recoverable; deterministic
code owns identity, authority, validation, publication, and completion truth.
The user receives one complete app, honest setup guidance, and no obligation
to understand Nova's internal machinery.
