# Unified architect: interface and app-quality evidence

One architect now develops a Markdown plan and builds the app through the same
authoring operations used by the editor and MCP. An independent peer edits that
plan and inspects the saved app. The typed design graph, finding dispositions,
compiled execution plan, scope bindings, and separate executor are removed.
Code still owns authorization, valid canonical checkpoints, exact receipts,
concurrency, recovery, cancellation, and accounting.

This replaces the architecture measured in the earlier
[September 13 report](agent-authoring-results-2026-09-13.md). That report is
historical evidence, not the current composition. The enduring contract is
[agent authoring](../architecture/agent-authoring.md).

## Representation

The reduction comes from changing what agents author: ordinary wording,
expressions and names, with identity resolution and canonical preparation in
shared code. One semantic operation handles one or several additions. Reads
show the requested part of the app; results carry outcomes and useful values.
Detailed reference material is available on request. Prompts describe purpose,
judgment and collaboration without duplicating the tool inventory or teaching
the document's storage structures.

The full schemas remain available. Repeated large structures share definitions;
small and single-use shapes stay inline. Hosted tool search defers definitions
for Nova's agents. MCP exposes the same authored schemas, with discovery owned
by its client. Deferral is reported separately from actual schema reduction.

Local estimates below use the production `/agents` compositions and o200k_base.
They include every declared tool, including deferred definitions. App-specific
messages and structured response schemas are separate factors.

| Current role | Prompt tokens | Complete tool catalog |
| --- | ---: | ---: |
| Ordinary editor | 623 | 60,980 |
| Architect, planning | 717 | 3,822 |
| Architect, construction | 717 | 62,222 |
| Independent peer | 406 | 3,447 |
| Document extractor | 1,344 | 0 |
| Translator | 74 | 0 |
| MCP build guidance | 831 | 66,969 |

The original editor was 16,934 prompt tokens and 148,191 tool tokens by the same
local method. MCP was 19,003 and 206,617 respectively. The old design author
carried 8,638 prompt/capability tokens and 27,812 tool tokens; its separate
executor added a 6,277-token prompt and a 176,393-token catalog. The new
architect replaces those two roles, so adding their old totals is not a valid
single-request comparison. All figures are approximate; `/agents` recomposes
from current code on every request.

## Provider counts

The real SDK serialized each current role using a fixed short synthetic request.
OpenAI's [input-token counting endpoint](https://developers.openai.com/api/reference/python/resources/responses/subresources/input_tokens/methods/count)
counted the serialized payload without generating a response. Full-catalog
variants remove hosted search and deferral from those same function definitions.

| Role | Full catalog, instructions and request | With deferral | Without tools |
| --- | ---: | ---: | ---: |
| Editor | 58,239 | 5,870 | 638 |
| Architect, planning | 3,070 | 2,214 | 732 |
| Architect, construction | 58,893 | 6,524 | 732 |
| Peer | 2,579 | 1,723 | 421 |

The original editor's comparable provider count was 200,604. Its complete
request is about 71% smaller before deferral. The largest current function,
`addAutomations`, contributes 4,495 provider tokens beyond instructions and
input. Initial deferred requests still include discovery metadata; merely
counting nondeferred function schemas understates them. A subsequent loaded
definition and the growing conversation still consume context.

These catalogs remain above the suggested 20,000-token aspiration. The retained
schemas describe supported operations and constraints. The measurements do not
establish that further reduction is impossible or that these sizes are optimal.

## Quality method

Five synthetic requests were frozen before their trials: a tool library,
household advice visits, pantry delivery with branches and repeats, equipment
lookup/search, and a bilingual bicycle repair clinic. The final two were held
out until their trials. Failures then informed corrections; these were not all
run against one frozen code revision. Each starts with the request rather than
a previously accepted design.

`scripts/evaluate-architect.ts` runs the production architect, peer, shared tools,
private workspace, canonical store and completion path in a dedicated local
Project. It retains the exact credential-free provider requests, response
messages, reasoning summaries, plans, tool outcomes, failures and app documents.
Opaque encrypted reasoning is retained for recovery but is not presented as
human-readable reasoning. Resumption retains the original request and saved app;
independent feedback, when supplied, is separately recorded.

A fresh independent reviewer assesses actual authored apps and those traces.
Additional probes use the real FormEngine and submission program, authorized
Postgres storage and compiled CommCare archives. They do not replace the app
with a hand-written fixture or silently repair its blueprint.

## Findings retained during evaluation

The housing app was saved and reviewed, then the runtime incorrectly continued
after a response containing hosted tool search and a final answer. Two needless
responses followed, the second empty. The fix recognizes provider-executed calls
as already handled and accounts for empty responses before failing. An actual
SDK/Postgres regression proves completion, durable reopening without another
request, and usage accounting. A fresh reviewer checked the fix.

The pantry architect initially chose a count-bound repeat based on a question
answered later. Nova fixes that count when the enclosing instance opens, so
changing the answer does not create rows. Evaluation exposed the mistake. The
agent then hit an older shared edit bug: switching repeat modes included invalid
fields from other variants. The tool now emits only the destination variant;
the existing reducer removes old mode fields and preserves children and identity.
A real tool/workspace test exercises mode changes. The schema's short description
now states when the count is fixed.

The pantry trial's conservative reservation guard stopped it after a saved
checkpoint. Resuming the same app and conversation completed the work. Further
evaluation caught incorrect parcel numbering and the architect corrected it.
The final app uses an explicit parcel-completion question to enforce at least
one row. This is a visible design tradeoff, not a claim that repeats support a
minimum-count setting.

Independent housing checks found an abandoned follow-up date still stored after
Yes changed to No, and wording that falsely promised blank phone input would
remove the saved number. The architect corrected the conditional writer and
wording. New saved visits omit the abandoned date, preserve the selected parent,
and leave historical visits unchanged. Blank phone input now truthfully preserves
the number. Hiding a question alone does not erase its old value.

That refinement also exposed a poor interface choice: changing a form's purpose
required the agent to recreate it. The peer understated that identity change as
metadata only. The shared update operation now accepts purpose text, with a
behavioral test proving set, omission and clear preserve the remaining document.
The observed app worked, but that unnecessary recreation remains in the evidence.

The equipment app initially accepted an unsafe inspection with empty action
notes because its constraint did not make the answer required. An ordinary
editor refinement corrected conditional requiredness. Empty and whitespace-only
notes then refuse for unsafe inspections; safe inspections allow blank notes.
The existing equipment and inspection history stay unchanged. This bounded
refinement used the production editor/tool workspace in a private harness; it
did not exercise the production chat route or run lifecycle.

The bilingual trial found a storage projection defect: SQL fold snapshots
omitted section containers' child order. The canonical app was intact, but its
initial immutable baseline could not reconstruct the workspace. The corrected
snapshot projection and a one-time scan/migrate append a complete fold baseline
without rewriting the app or old history. Real Postgres tests cover old-format
repair, current nested containers, holder refusal, trigger admission and late
rollback. The same saved app resumed and finished translation after repair.

The bilingual agent corrected its conditional phone writer, then reviewed all
26 authored translations. Independent execution confirms that changing Yes to
No stores no phone, Spanish greeting references resolve to the selected rider,
and completion closes only that repair while preserving its original details.
Spanish Preview still shows the built-in English required-field message. Thus
its workflow and authored translations pass, but the request for all validation
messages in Spanish is not fully met.

Two transport refinements followed trace review. Translation review now supplies
one exact-state revision; shared preparation recovers the canonical source and
value checks instead of asking the model to echo them. Form evaluation reports
question state and proposed case values without submission entry identifiers.
The peer had mistaken one such identifier for a saved record even though the
operation saves nothing. Conditional close and additional case operations are
explicitly unevaluated. Behavioral tests and a fresh code review cover these
changes; the five paid trials preceded them, so they do not establish a measured
reduction in live steps.

The form evaluator now reports effective visibility and relevance through the same
engine rules used for validation. A child of a hidden group or repeat no longer
appears visible, and irrelevant questions no longer carry stale required/error
flags. Computed hidden values remain inspectable. This removes contradictory
observations without changing validation or submission semantics.

Workspace conflict messages now describe saving pending changes separately. They
no longer ask an architect to open a change set through a tool it does not have.
The exclusive transaction boundary is unchanged.

## App outcomes and spend

A fresh reviewer inspected all five app documents, their source requests and
plans, 358 recorded provider responses/editor steps, reasoning summaries, tool
outcomes and corrections. The reviewer also independently parsed all five CCZ
archives and their XML. Passing observations are about the final apps after the
retained refinements, not flawless first attempts or superiority to a baseline.

| App | Final evidence | Remaining qualification |
| --- | --- | --- |
| Tool library | Two distinct loans, conditional return explanation, selected-record closure, preserved original details, exact submission retry | No generated-app visual or device run |
| Housing advice | Linked household visits, isolated parent updates, preserved history, corrected abandoned-date and phone behavior | Unnecessary form recreation in the refinement trace |
| Pantry delivery | Three branches, repeated parcels, positive whole-number quantity validation, correct numbered summary | Explicit parcel-completion question enforces a nonempty parcel list |
| Equipment inspection | Shared category lookup, required tag search, no-match registration, related inspection history, corrected action-note requiredness | Correction required independent feedback |
| Bicycle repair clinic | Sectioned forms, 26 current Spanish translations, conditional phone storage, resolved greeting and selected closure | Built-in required-field message remains English |

Production build and four scripted browser checks passed locally. Focused tests
cover the new orchestration, context replay, accounting, ownership, migration,
translation and authoring boundaries. Final typecheck, lint and the PR's complete
CI are delivery checks; the live trials supply separate model-quality evidence.

The ten architect trial/resumption runs report about $13.85 in generation costs;
the five-step editor refinement adds less than one cent. These are estimates
from reported usage and configured rates, not an invoice, and exclude one empty
response missed by the early meter. The cumulative conservative ledger, including
earlier research, unknown usage and deliberately pessimistic rates, stands at
$109.44 against the authorized $200 ceiling. No further generation is needed for
this delivery. Provider input-token counts generate no model response.

Exact private requests, responses, plans, app documents, archives, observations
and the independent review are retained in the local quality artifact folder
`/private/tmp/nova-unified-quality-20260914`. These synthetic fixtures do not
establish a population-wide success rate. During initial construction, evaluation
cannot test selected-record behavior before such records exist; structural peer
review missed defects that later real-record probes found. The interface makes
that limit explicit and does not silently populate users' case data.

## Verification limits

Local browser tests exercised the build journey and chat controls with scripted
provider responses. They prove UI/lifecycle integration, not generated-app
quality. Manual browser inspection of these generated apps was blocked by the
browser's admin policy check. No alternate browser was used to bypass it.
Generated-app quality evidence therefore consists of document/trace inspection,
engine execution, saved records and archive compilation. It does not establish
visual polish, Android/offline operation, or an HQ deployment. Visit notes also
retain Nova's existing single-line text control; multiline note UX was not added
as part of agent simplification.
