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
  receipts, rebase, and atomic publication.
- `solutionsArchitect.ts` runs ordinary edit turns against an existing app.
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

## The authoring boundary

Read `authoring/CLAUDE.md` before changing model input or read projections.
All three tool clients use the same author-facing vocabulary: names, Markdown,
and expressions. The boundary allocates identities and binds references within
one authorized workspace invocation. The document stores typed expressions and
stable identities. Never expose storage structures just because a reducer
accepts them, cast text into an AST, or regex-parse XPath.

`sharedToolRegistry.ts` declares every operation's effect, required context,
staging eligibility, and external capabilities. Availability comes from those
declarations and the current role and phase, not a prompt prohibition. Planning
and peer review cannot mutate app or Project data. External operations recheck
membership and their own revision at the transaction boundary.

The architect and editor use hosted tool search with deferred shared definitions.
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

Structural creation is atomic. A module may include its forms, questions, and
case-list columns; a form includes its questions. The whole call is prepared
before validation. An invalid child rejects the call rather than silently
skipping it or returning an identity that did not land. Names resolve within the
complete call scope; unresolved or ambiguous references refuse before mutation.

One list-taking operation handles both one and several additions. Do not add a
singular twin. Preserve nested identities and attached media during read/edit
cycles. Type conversions, property renames, and retirement use their dedicated
planners because they may affect existing data.

Shared tool results report `ok`, created identities, relevant changed values,
and actionable failures or confirmations. A success does not imply publication:
private builds stage changes until `saveWork`. The UI-only `summary` is stripped
from both live and resumed model context and from MCP results. Do not append
instructions to continue after every success. Saved values set aside by a
migration travel as `dataReview`; automation writes report remaining setup,
while `getAutomations` supplies a full guide on request.

Domain behavior remains with its owning planners and shared tools: case-list
selection and search, no-matches registration, form links, automations, media,
lookup data, and localization. Consult `docs/architecture/complex-apps.md` and the
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
mode. All calls stream; do not restore a blocking response path.

Stable instructions and definitions precede changing app state. Ordinary edit
turns place a request-local cache boundary before the volatile app snapshot;
durable architect and peer histories preserve their growing prefix. A compatible
provider compaction checkpoint replaces only the replay prefix, never the
human-readable stored history. Prompt, model, toolset, and context versions
control checkpoint compatibility. Keep completed tool results and reasoning
items intact on resume; encrypted reasoning is not human-readable reasoning.

## Inspection and evidence

`/agents` separates composition from code, current local app state, and recorded
runs. Definitions and role facts come from their production owners. Token counts
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
