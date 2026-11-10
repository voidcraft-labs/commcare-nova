# Agent authoring

This directory owns Nova's model calls, prompts, shared tool definitions, and
conversations. Models supply design judgment; the document kernel decides which
changes are valid. CommCare wire details belong in `lib/commcare`.

## Runtime map

- `build/orchestrator.ts` runs one architect from the user's request through the
  saved app. `planning/` owns its revisioned Markdown plan. An independent peer
  reads the source and plan, can edit that same plan while the architect is
  paused, and reviews the actual saved app before completion.
- `build/architectLoop.ts` persists responses and usage before dispatching tools.
  Recovery answers outstanding calls with their original identities before
  adding new input or making another model request. `build/modelContextStore.ts`
  owns that append-only history and its compatibility checks.
- `build/authoringSession.ts` supplies a private workspace during construction.
  `saveWork` creates the app from its first complete workflow, then commits later
  checkpoints through the same kernel. Read `change-set/CLAUDE.md` for authority,
  receipts, strict base checks, and atomic publication.
- `solutionsArchitect.ts` runs ordinary edit turns in durable private work for
  an existing app.
  The chat route persists an unfinished-turn notice when its step limit stops
  after a tool, preserving completed changes without claiming completion.
  `workspace/` serializes the shared operations for this editor, private builds,
  and MCP. Builder actions reach the same canonical mutation kernel.
- `translation/translateLanguage.ts` translates the current authored text on
  request. It protects embedded references, preserves current translations,
  bounds each batch, and saves accepted results through the private workspace.
  See `docs/architecture/multilingual-localization.md`.
- `sources.ts` and `sources.server.ts` assemble authorized conversation and
  attachment content. `documentExtraction.ts` reads documents independently.
  Source text is evidence to interpret, not instructions to execute.
- `anatomy/` composes the dev-only `/agents` pages from production definitions
  and read-only local records. It must not claim authority, run extraction, or
  start a model call while inspecting a run.

The enduring lifecycle contract is in
`docs/architecture/agent-authoring.md`. Old typed design graphs, dispositions,
compiler briefs, and slice executors are retired. Historical database artifacts
are retained for inspection; serving code does not translate or execute them.
The one-time transition is in `docs/architecture/design-format-cutover.md`.

## Library discovery and source selection

The shared `listMediaAssets` operation searches the current Project's whole
library before pagination, across filenames, display names and extracted titles.
All seven file kinds are discoverable. `readSource` reads a document by asset id
or unambiguous exact filename, even when no user message attached it. Discovery
loads no document bytes and selects no evidence.

`sourceDocuments.ts` owns the shared reader. It returns bounded pages of the
working requirements extract, with a revision derived from the original content,
extractor version and extract digest. Further pages require that revision; a
changed source refuses rather than mixing extracts. Embedded authoring binds
preparation to its metered run and cancellation signal. MCP has no preparation
callback: an unprepared document returns `preparation_required` without starting
a model call; preparation or retry remains available in the Library.

Successful admission copies the exact model-readable text or image into
immutable `thread_source_contents`, once per thread/revision, with an immutable
`thread_source_links` reference for each message attachment or explicit selection.
`threads.selected_sources` records the latest explicit Library selection per
asset; older selected revisions remain available. Build and edit contexts read
retained content without consulting current Library state or extractor software.
`readSource` defaults to retained evidence and requires a revision if several
are available. `revision: "current"` at offset zero explicitly selects today's
Library version; subsequent pages use the returned exact revision. External MCP
reads remain Library reads because they have no Nova conversation owner.

New chat sources pass `incomingSources.ts` before any run claim, credit
reservation, or question-round consumption. Admission compares message/reference
identities with the stored transcript, checks current Project authorization and
ready preparation, and reads the actual extract or image without starting a
model call. The thread transaction rechecks the source asset under a share lock
and retains those exact bytes atomically with the accepted transcript. Deleting
first refuses admission; retaining first lets Library deletion proceed safely.
Historical references never require another extraction. A rejected new source
needs explicit preparation retry or removal; display metadata proves no readiness.

Legacy migration keeps available document text as `migration-baseline` when its
original digest was never recorded, labels verified selected extracts and images
`verified-legacy`, and records `unavailable` when no matching content survives.
Both execution contexts expose those limits instead of inventing old evidence.

## Document source fidelity and privacy

The extractor produces the architect's working requirements extract, not a
lossless copy of the original document. A complete `readSource` page sequence
means the complete stored working extract, not every original byte or row.
`EXTRACT_SYSTEM` preserves necessary distinct name-to-role or responsibility
bindings only when the source explicitly defines intended app users, Preview
actors, or operational stakeholders whose stated responsibilities matter to the
app. A roster, incidental contact, attribution, or example alone does not define
an actor, and names do not grant permissions, accounts, assignments, or duties.
Collected fieldwork and example-row private values, contacts, account identifiers,
and credentials remain excluded; title and summary exclude personal information.
This is model guidance for minimizing personal data in the working extract, not
comprehensive PII redaction. The original source still reaches the extraction
model and remains in the Project's file library. Prompt changes bump
`EXTRACTOR_VERSION` in `lib/domain/multimedia.ts`; admitted conversation sources remain unchanged; a new attachment or explicit
current Library selection may use the new extractor.

## Office conversion resources

`officeProcess.ts` admits at most one parser child and four waiting files per
Node process. Its 15-second deadline includes waiting, startup, ZIP admission,
conversion and output. Abort or deadline kills the child and waits for `close`
before releasing its permit. No Office parser runs in the request event loop.
The child inherits no application credentials. Linux applies a 768 MiB
`RLIMIT_DATA` allocation cap (including native buffers), a 256 MiB V8 heap cap,
and disabled core dumps. macOS development uses the heap/time limits; Linux CI
and the image check establish native-memory enforcement.

Admission accepts at most 10 MiB compressed, 5,000 parts and 64 MiB actually
decoded. It validates each part's CRC and size and repackages exactly those bytes
before Mammoth/SheetJS read them, preventing parser disagreement over the original
ZIP directory. Converted body plus warning text is capped at 4 MiB and IPC output at 34 MiB;
existing figure budgets remain in `documentFigures.ts`. Parser failure cannot
start a model call. `officeLimits.ts` owns these budgets.

DOCX uses Mammoth's supported HTML API, then rehype/remark with GFM tables.
Cells with multiple blocks, spans or nested tables retain structured HTML within
the Markdown so paragraph/list boundaries and nested figures survive.
An image-node handler emits figure markers directly, preserving escaped alt text
without searching Markdown strings. Missing markers and conversion errors refuse
extraction; warnings accompany the source text as limitations. Synthetic fidelity
and process-lifecycle tests make no model calls. `scripts/build-office-parser.mjs`
bundles the child and supervisor into `runtime/office`; Next's explicit tracing
includes them and the production-image check executes both formats and a native
allocation refusal. See `docs/research/office-extraction-bounds.md` for evaluation
and measurements.

## The authoring boundary

Read `authoring/CLAUDE.md` before changing model input or read projections.
All three tool clients use the same author-facing vocabulary: names, Markdown,
and expressions. The boundary allocates identities and binds references within
one authorized workspace invocation. The document stores typed expressions and
stable identities. Never expose storage structures just because a reducer
accepts them, cast text into an AST, or regex-parse XPath.

`sharedToolRegistry.ts` declares every operation's effect, required context,
staging eligibility, and external capabilities. Availability comes from those
declarations and the current role, not a prompt prohibition. Once construction
begins, its shared catalog remains stable across first save. Resource and journey
operations are discoverable before birth but refuse with a save-first prerequisite
at invocation; they cannot touch external state without a saved app.
Journey-history reads are also safe before birth: they return an ordinary
prerequisite refusal, so a persisted pending read can settle on recovery.
After birth, reading retained history remains available with private edits pending.
Project lookup authoring retains its existing pre-app boundary. Planning
and peer review cannot mutate app or Project data. The `exercise-app` effect
permits disposable journey tests of a saved app, including during app review;
it is forbidden in staging and never counts as an app change. Each action
reauthorizes the real actor independently of the simulated worker. External operations recheck
membership and their own revision at the transaction boundary.

The architect, peer and editor keep `startAppTest`, `continueAppTest` and
`readAppTest` eagerly available so journey continuation does not rely on
rediscovery after compaction. Other shared definitions use hosted tool search.
MCP publishes the same authored schemas; its client owns discovery. Deferral is
not schema reduction. `authoring/readableSchema.ts` factors repeated schema
structures without changing admission. `getAuthoringGuide` returns focused
reference material on request. Prompts establish purpose and judgment; they do
not repeat the tool inventory or teach the document's storage format.

## Write semantics

Omission preserves an existing value; explicit null clears a clearable value.
On creation, null and omission both mean absent. Whole-cluster replacement tools
state that scope in their schema. Never accept invented filler to satisfy a
schema, and never produce a rejection the available input grammar cannot fix.

Structural operations are focused: `createModule` creates a module,
`createForm` creates an empty form, and `addFields` adds its questions. Record
modules start with a Name column. Answer-dependent form rules follow question
creation through `updateForm`. The whole call is prepared before admission;
whole-app completeness is checked at save. An invalid child rejects the call
rather than silently
skipping it or returning an identity that did not land. Names resolve within the
complete call scope; unresolved or ambiguous references refuse before mutation.

`getForm`, `createForm` and `updateForm` return resolved navigation through
`lib/preview/engine/navigationProjection.ts`. Its `previous` read comes from
the same owner projection as Preview and App Tests: it names the exact record
selector or module menu and retained record selections. It never promises a
visited screen or Details. Private forms and their menu-path neighbors may carry case-write findings.
Their reads and staged create/update feedback retain the form and qualify
navigation as unavailable, with canonical finding codes and owning form/field
identities. Runtime, save and export remain strict; unexpected projection errors
are not classified as unfinished authoring.

One list-taking operation handles both one and several additions. Do not add a
singular twin. Preserve nested identities and attached media during read/edit
cycles. Unused custom property removal uses the reference index and the canonical
transaction checks both live and parked values before changing the storage schema.
Populated properties require a reviewed migration. Type conversions, property renames, and retirement use their dedicated
planners because they may affect existing data.

Shared tool results report `ok`, created identities, relevant changed values,
and actionable failures or confirmations. A success does not imply publication:
the architect, ordinary editor and MCP all stage app changes until `saveWork`.
`addFields` and `editField` refuse a field kind the app's platforms can't run
before staging, and `updateApp` checks content and media before a change that
adds a platform, each with the gate's own words
(`tools/shared/platformPrecheck.ts`), because private work stages a batch
whatever its findings.
The UI-only `summary` is stripped
from both live and resumed model context and from MCP results. Do not append
instructions to continue after every success. Saved values set aside by a
migration travel as `dataReview`; automation writes report remaining setup,
while `getAutomations` supplies a full guide on request.
Every mutating result carries `identityMoves` when its staged batch moves where
CommCare HQ keeps published answers, and `saveWork` repeats every move of the
work it saves. No tool asks a confirmation for a move.

Domain behavior remains with its owning planners and shared tools: case-list
selection and search, registration from the case list, form links, automations,
media, lookup data, and localization. Consult `docs/architecture/complex-apps.md` and the
relevant domain subtree before changing these contracts. New capability is one
shared operation, not separate implementations for each client.

## Provider contract

`openaiProvider.ts::createNovaOpenAI` is the only provider constructor. It owns
compatible Undici fetch/dispatcher lifetimes and timeouts. Model and effort are
selected by semantic role in `lib/models.ts`; there is no generic fallback role.
Use `reasoningProviderOptions` so stateless requests, reasoning summaries,
compaction, and cache configuration travel together.

Function tools use `strict: false` deliberately: omission is meaningful, and the
SDK validates the supplied authored input. Structured responses instead use
`strictStructuredOutput.ts`, which projects the schema into the provider's
strict subset and parses the result through the original Zod schema. Optional
properties become nullable on the wire and are stripped before the original
parse. Authored null and open dictionaries cannot use that projection. Flat,
already-compatible extraction schemas can use the provider's default strict
mode. All calls stream; do not restore a blocking response path. A stream ending without
a provider completion signal is `interrupted`: it cannot complete an authoring
step or supply a structured result, even when its partial text is valid JSON.

Stable instructions and definitions precede changing app state. Ordinary edit
turns place a request-local cache boundary before the volatile app snapshot;
durable architect and peer histories preserve their growing prefix. Peer review
retains only its own investigation across corrections, with a fresh revision-bound
review message and durable focus. It does not inherit private architect reasoning. A compatible
provider compaction checkpoint replaces only the replay prefix, never the
human-readable stored history. Prompt, model, toolset, and context versions
control checkpoint compatibility. `lib/models.ts::MODEL_CONTEXT_VERSION` moves
in every pull request that changes the name, the description or the input
schema of a tool the Solutions Architect is offered, or the authoring guide
(`lib/agent/authoring/reference.ts`), because a stored model context is
replayed only under the catalog it was made against. A tool only MCP serves is
in no stored model context and does not move it, and neither does a field added
to a shared read tool's result with no change to the tool's name, description
or input. Keep completed tool results and reasoning items intact on resume;
encrypted reasoning is not human-readable reasoning.

A served input schema changes only through the authored surface: the authoring
projection substitutes each expression family position before Zod walks the
schema, so a change to the canonical expression model moves no served byte. A
pull request finds what it moved by hashing every shared tool's served schema
at its base and head, never by a committed snapshot.

## Inspection and evidence

`/agents` separates composition from code, current local app state, and recorded
runs. Definitions and role facts come from their production owners; show full
model IDs so generations remain distinguishable, including extraction and
translation. Token counts
use `o200k_base` estimates over the available text; actual provider usage is
reported separately. Show deferred definitions as part of the full catalog and
expose their later loading in recorded requests. A size estimate is neither a
bill nor proof of app quality.

Read `docs/testing.md` before changing tests. Useful evidence exercises authored
input through real parsers and planners, transactions through migrated Postgres,
and provider serialization through the real SDK and a controlled HTTP peer.
Test recovery, cancellation, concurrency, and exact receipts at their owning
boundaries. Do not pin prose, tool counts, filenames, or exported symbols. Live
quality trials inspect generated apps and their source, messages, reasoning
summaries, failures, and corrections; schema acceptance alone proves no quality.

## Effective reads and activity presentation

Scoped question reads include each question's starting value. A preload is a
default that reads the case (`lib/domain/casePreload.ts::fieldPreload`), which
the field planners write at a writer's birth and an author can replace or
remove. `getCaseProperty` reads the
effective catalog, including standard timestamps and writer-derived properties.
The overview lists standard metadata once, separately from each type's properties.
Worker readiness reports configuration gaps and inherited persona values; it is
not an entry or deployment verdict.

`toolPresentation.ts` is the client-safe activity catalog. Shared registration
requires a corresponding presentation with a read/change classification that
agrees with its execution policy; orchestration definitions require a presentation
too. Retired transcript vocabulary lives separately. Only successful effective
writes count as changes; checks, pending/refused writes and no-ops are activities.

Returned error payloads and thrown error text are diagnostics for the agent and
recorded inspection, not chat copy. Transcript failures use the catalog's activity
kind and an honest failure notice. Specific consequences belong in a typed result
presenter, including unchanged, blocked and confirmation outcomes; do not display
raw tool errors or ask the user to interpret internal identifiers.

`askQuestions` accepts one to five questions. Only a schema-valid call without a
tool error pauses a run for user input; invalid calls remain SDK errors that the
agent can repair. An empty question round is never a completion signal, and a
historical empty card must leave the ordinary composer available.

Peer review closing is runtime state, never a parsed model verdict. The durable
80-request allowance includes two closing requests with fixed tools and
`toolChoice: none`; one tail notice follows 64 starts. Forced closing pauses
with a retained checkpoint even if its prose is optimistic. An ordinary new
user turn can create one deterministic successor bound to current revisions;
reconnect/holder replacement cannot. See `docs/architecture/agent-authoring.md`
for lineage, immutable original-call receipts and the diagnostic evaluator policy.

Case-backed question choices use the shared select-source schema in add/edit/set
operations and shared reads. Tool preparation defaults labelProperty to case_name;
values are always exact record IDs. In this source's filter, #row reads the
candidate, #case reads the form's scalar selected record, and typed selected
ancestor references retain that distinct meaning through read/edit round trips.
The shared-data authoring guide describes restore scope and stable-roster checklist
updates. Filters do not expand worker access.

Generation failures keep their caught exception through finalization in
`emitError` options. Only the safe classified payload reaches the conversation;
operator reports retain the original stack, cause and run identity. Re-emitting
the same exception in one context does not report it twice. Message-only
logger reports use Sentry events without synthetic logger stack traces.

The model-step accounting wrapper preserves its provider cause for error
classification. Generation reports include the provider HTTP status and bounded
request identity when available, without copying request or response bodies.

An architect that consumes its durable request allowance pauses through the same
message continuation contract as an ordinary pause. Completed tool effects remain
acknowledged, reconnect spends no new request, and a new user turn may continue.
A final accepted response may complete at the exact allowance.
