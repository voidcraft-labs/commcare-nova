# The design turn is one agent

## Executable plan for replacing the design pipeline's hardcoded call sequence with a server-gated agent loop

Status: PLANNED. When it ships, this plan supersedes the orchestration
halves of `reviewed-intent-atomic-change-sets-plan.md`: §7.1/§7.3 (the
four-one-shot-call state machine and its package-digest-keyed
convergence), §15.8's question flow (answers supersede the whole design),
and the stage COPY of §15.2/§15.4 (the `DesignBuildStage` union survives;
this plan extends it). Shipping also edits every passage of that plan
that draws the four one-shot calls, so the index plan stays present-tense
and honest: §5's architecture diagram, §6.1's package layout (the author,
reviser, and planner files retire), §7.6's every-pipeline-call prose,
§13.1/§13.2's author/reviser/planner and `designing.sourcePackageDigest`
prose (the executor machinery itself is untouched), §15.4's
`data-design-pulse` phase union (the author phase retires with the author
call), and §11.11's bar on reviewer text in events, which §10 amends for
display-safe reasoning summaries only. Everything else in that plan is
deliberately untouched: the rest of the Design Contract domain (§6), the
review shape (§7.2), proportional depth (§7.4), the build-slice plan
(§8), materialization (§12), the slice executor (§13), and conformance
(§14). The artifacts, their schemas, and their store do not change.

## 1. Decision

A chat design turn mounts ONE design agent: a `ToolLoopAgent` on
`DESIGN_MODEL`, the same machinery the SA runs on, instead of driving four
one-shot structured calls through a hardcoded sequence. The agent drives;
the SERVER gates. Every phase transition that matters is a server-executed
tool whose legality the design session's durable artifact ancestry decides,
so the model still never decides whether a required phase happened. It is
told, in tool results, what is legal next, and an illegal call is a tool
error, not a state change.

The tool surface of the loop:

- `askQuestions`: the existing client-side pause tool
  (`lib/agent/tools/askQuestions.ts`): same schema, same client contract.
  No execute; the loop halts on emission, the chat client renders it,
  answers return as the tool result when the user replies, and the loop
  resumes with its context intact. The design registration re-describes
  the tool to explicitly invite option-less, free-text questions (the
  schema already allows an empty options list; the SA description's
  "2-4 answer options" framing would bend real design questions into
  invented multiple choice).
- `submitContract`: the full `AppDesignContract`, and the tool that OPENS
  a design cycle (a draft lineage that runs to an accepted revision). The
  server parses it through the exact schema and graph proof that gates
  today's author call. A rejection returns the Zod refinement messages AS
  THE TOOL RESULT (the in-loop repair); an acceptance persists the draft
  artifact (envelope, digests, complexity) exactly as today, and the
  result says what is legal next. Legal exactly when no cycle is open: at
  session start, over an unreviewed draft that newer user content (an
  answered question round or a new message) has made stale, or after an
  accepted revision's blocking questions are answered (§5, §7). While the
  head draft's review stands undispositioned it is a tool error naming
  `submitRevision`, because a fresh draft there would orphan the review's
  findings.
- `requestReview`: the server runs the INDEPENDENT reviewer, the same
  fresh-context one-shot structured call as today (`reviewer.ts` plus
  `designReviewSchemaFor`), receiving exactly the source package, the
  persisted contract, and the capability catalog, never the loop's
  reasoning. The reviewer receives the DRAFT'S OWN package: the store
  requires a review to bind the exact package digest the draft bound, and
  the thread may have grown since (a question round, a retry message), so
  the server re-renders that package from the draft's persisted reference
  row, which names exactly the messages, extracts, images, and claims it
  held, and refuses honestly if the re-render no longer reproduces the
  digest (the sources changed under the draft; asking, or the user's next
  message, unlocks a fresh submission). The persisted review's findings
  come back as the tool result. A review with no gated findings is
  accepted by the server itself, exactly today's transition: the draft's
  content re-issues as the accepted revision with empty dispositions and
  the result names `submitPlan` legal, so a deterministic transition
  never waits on a model re-emission.
- `submitRevision`: revised contract plus dispositions, validated by
  `designRevisionResultSchemaFor` over every persisted review of the
  parent draft PLUS the sensitivity-pair rule
  (`validateSensitivityNotSilentlyLowered`, which today runs inside the
  retiring reviser call and must not be dropped with it); violations of
  either are tool-result rejections. Persisted atomically as today. The
  SERVER decides acceptance or a required second round (§7.3 rules,
  unchanged) and says so in the result.
- `submitPlan`: the planner's draft, validated by
  `buildPlanSchemaFor(contract)`, persisted as today. Legal only when the
  newest revision is accepted and carries no blocking open questions. An
  accepted revision is immutable, so one that carries blocking questions
  never becomes plannable after the fact: the answers reopen design work
  instead (§7), and the reopened cycle's review sees the final content.

After `submitPlan` persists, the loop ends and `runBuildOrchestration`
continues exactly as today: materialization root first, slice execution,
completion. This plan covers the design phase only.

## 2. Why: the first live contact, measured

The pipeline shape's costs are not hypothetical; the first real runs paid
them.

- **Questions arrive after the money is spent.** The author emits
  `openQuestions` as structured-output fields, its prompt discourages
  raising them, they surface only after author, review, and revision all
  complete, and answering triggers a full re-design (a second author call)
  because answers change the source-package digest that resume converges
  on. A one-sentence prompt, the case that NEEDS questions most, bought a
  ~$3.50 design of guesses before the user was consulted.
- **Zero cache reuse.** Four fresh contexts share no prompt prefix. A live
  failed run wrote 90,336 cache tokens and read 0: every call re-billed the
  same sources and catalog, and the provider's 30-minute cache was written
  three times and never read.
- **The reviser has amnesia.** It revises a contract it didn't author,
  under rules stated only in the author's prompt, without the author's
  reasoning. Live consequence: a revision that broke two authored
  invariants (explicit-claim evidence, scenario coverage) and killed the
  run.
- **A validation failure has nowhere to go.** The reviser's rejected parse
  carried our own refinement messages naming the fix, and the only consumer
  was a log line. The run died; the advertised retry ("send your message
  again") re-billed the author and reviewer because the new message broke
  digest convergence.
- **Progress is dead air.** One-shot calls have no natural boundaries; the
  pulse (chars streamed) was bolted on because nothing else moved for
  fifteen minutes.

The determinism the pipeline was built for never lived in the call shape.
It lives in the artifact store (immutable, digest-bound, insert-only,
predecessor-proved) and in the route owning transitions. Those survive
unchanged; only the driver changes.

## 3. What survives unchanged

1. **Every design artifact and its store.** `contract.ts`, `review.ts`,
   `buildPlan.ts`, `evidence.ts`, `graph.ts`, `envelope.ts`,
   `artifactStore.ts`, the five insert-only tables, digest bindings,
   predecessor proofs, complexity persistence. An artifact produced by the
   loop is byte-indistinguishable in kind from one the pipeline produced.
2. **Reviewer independence.** The reviewer stays a fresh-context one-shot
   structured call with exactly the package, the contract, and the catalog.
   It is the one place fresh context is the point, so it is the one call
   that does not join the loop.
3. **The bounded-rounds policy** (§7.3), per design cycle: one review; one
   revision on gated findings; a second review only when the first revision
   leaves a critical finding or changes architecture (extended depth always
   re-reviews); no third loop. The gates enforce it; the model cannot vote.
4. **Depth (§7.4), the planner's validation (§8), materialization (§12),
   the slice executor (§13), run and credit lifecycle (§11.4), the design
   session table and its claim, lease, and settle machinery.** A design
   turn is still one run; a pause still settles actual usage and holds no
   reservation.
5. **`strictStructuredOutput.ts` and `runStructuredWith`.** The reviewer
   and document extraction still ride them; the loop's submit tools reuse
   the same projection (§6).

## 4. End-state architecture

```
POST /api/chat (design-session target)
  └─ runBuildOrchestration
       ├─ resolve thread + design session state (artifact ancestry)
       ├─ runDesignAgentLoop            ← replaces runDesignPipeline
       │    ToolLoopAgent(DESIGN_MODEL, xhigh)
       │    system prompt: design-agent (domain preamble + vocabulary +
       │      evidence/coherence rules + question policy + tool protocol)
       │    sources: package-rendered, append-only across turns
       │    tools: askQuestions | submitContract | requestReview |
       │           submitRevision | submitPlan
       │    gates: lib/agent/design/loop/gates.ts over artifactStore
       └─ (plan persisted) → slice execution, unchanged
```

New package `lib/agent/design/loop/`:

- `designAgent.ts`: the agent factory. Prompt composition, tool
  registration, provider options (per-session `promptCacheKey`, breakpoint
  discipline per `markStablePrefixBoundary`).
- `tools.ts`: the four server tools plus the client `askQuestions`
  registration. Submit tools parse with the existing schema factories and
  persist through `artifactStore`; results are compact acknowledgments
  (ids plus what is legal next), never artifact echoes, because the
  model's own tool call already holds the content in context.
- `gates.ts`: pure legality over durable state. Which tool calls are legal
  given the session's artifact ancestry, plus the budgets and the
  digest-independent round derivation (§7). Every refusal is a
  person-to-person tool error naming the legal next action.
- `lib/agent/build/progress.ts` additions: stage frames at tool
  boundaries plus streaming step labels (§9).

Placement honors `lib/agent/design/CLAUDE.md` invariant 6: nothing under
`lib/agent/design/` writes a stream or reaches a canonical store. The
loop package is pure (prompt, tools, gates, parsers); `lib/agent/build/`
keeps every writer, feeds the loop's progress callbacks, and owns the
orchestration events. The design branch of the chat route also gains the
resume seams the SA branch already has, each a named deliverable:
`metadata.model` stamped on the loop's assistant messages,
`sanitizeHistoricalReasoningParts` keyed to `DESIGN_MODEL`,
`sanitizeHistoricalToolParts` and `validateUIMessages` keyed to the
design tool set, and `markStablePrefixBoundary` applied to the design
branch's prompt.

`pipeline.ts`, `author.ts`, `reviser.ts`, and `planner.ts` retire (the
reviser and planner become loop turns; the author becomes the loop's first
submission). `reviewer.ts` stays. The four prompts collapse to two, the
design-agent prompt and the reviewer prompt. Both keep `DOMAIN_PREAMBLE`,
and the agent prompt absorbs the author's Evidence discipline and Coherence
sections verbatim so every invariant the schemas enforce is stated to the
context that must maintain it, once, in one place.

## 5. Questions: clarify early, clarify fully, clarify whenever

The policy the prompt states and the shape now supports:

- Ambiguity never passes unclarified. If the sources leave a real question,
  ask it. The tool is always available, there is no phase where asking is
  illegal, and the server never manufactures or suppresses a question.
- Ask EARLY. On thin sources, the correct first move is `askQuestions`,
  before any contract-sized generation, not ten minutes of reasoning that
  ends in questions. The prompt states this ordering explicitly.
- Ask until done. Multiple rounds are legal; each round is a cheap step
  (cache-read prefix plus a small emission). A 50-page design document that
  still leaves three real questions gets three real questions.
- Asking is not deferring. Recorded assumptions remain for what a
  reasonable default genuinely covers. The current prompt's active
  discouragement ("prefer a recorded assumption", blocking only if
  architectural) is replaced by: assume only what the user would not want
  to be asked.
- Later questions stay legal: a review that surfaces ambiguity, a revision
  that needs a user decision. Same tool, same pause, and the loop resumes
  with its full context instead of re-designing from scratch. Blocking
  `openQuestions` on an accepted revision still gate `submitPlan` (the
  §7.3 outcome), but they should be rare: the agent had every chance to ask
  directly. When they do happen, the answers reopen design work rather
  than mutating the artifact: an accepted revision is immutable, so it
  never becomes question-free after the fact. The answers make
  `submitContract` legal again (§7), the reopened cycle's draft carries
  them, and that cycle ends in its own reviewed acceptance, so a plan can
  never lower a contract whose final content no reviewer saw.

Mechanics: the pause is the existing one. The loop halts on the
execute-less tool, the run finishes honestly (actual usage settled,
`awaiting_input` set), the client renders the existing UI. The answer
arrives as the tool result on the next POST; the loop resumes with the
thread history. Answer seeding is respecified, not kept verbatim: today's
`seedClaimsFromAnsweredQuestions` reads only the trailing assistant
message and mints random claim ids, which would drop earlier rounds from
a rebuilt package and change its bytes on every rebuild. The loop's
version is cumulative over EVERY answered round in the thread, and
deterministic means the WHOLE claim is a function of the thread, not just
its id: claim ids are name-based UUIDs under one fixed loop namespace
with the answering round's message id and question index as the name,
claims order by thread position, and statement text renders from the
stored question and answer parts by a pure function. Rebuilding the
package over unchanged content is therefore byte-identical, earlier
answers stay citable in later turns, and the digest story in §8 holds.
The answers also simply exist in the agent's context, which is what kills
the full re-design.

## 6. Submissions: strict tools, in-loop repair

The three submit tools ship `strict: true`, projecting their Zod schemas
through the existing `strictStructuredSchema` (oneOf to anyOf,
all-required with null-unions, the stripNullProperties validation bridge).
This is the opposite of the SA's `strict: false` stance and deliberately
so: SA tools want omission semantics on sparse patches; a design
submission is a complete artifact where the grammar enforcement is pure
win. The projection and bridge already exist and are already pinned by
`strictStructuredOutput.test.ts`.

Registration and validation split deliberately. The tool's REGISTERED
input schema is the strict wire projection alone, the structural grammar
constrained decoding needs; the exact schemas run INSIDE the tool's
execute, and their verdicts return as tool results. They could not be
registration-time schemas anyway: the graph proof runs inside
`appDesignContractSchema`'s parse, and the factories are session-state
bound (`designRevisionResultSchemaFor` closes over the parent draft's
persisted reviews, `buildPlanSchemaFor` over the accepted contract),
neither of which exists when the agent mounts. The split is what makes a
refinement failure a repairable tool RESULT instead of an SDK
invalid-input failure the loop never sees.

Validation failures are the repair loop:

1. The tool result carries the ZodError's refinement messages with their
   paths, the same person-to-person prose the schemas already write (the
   explicit-claim rule names the exact reference kinds that qualify and
   why).
2. The model corrects and resubmits. Its prior emission is in its own
   context; the diff is usually small.
3. Bounded: two consecutive rejections of the same submission kind fail the
   run honestly with the diagnostics (`schemaIssues` now carrying messages,
   not bare codes; that diagnostics fix ships with this plan). No infinite
   refinement.

## 7. Bounds and budgets

The loop is bounded the way the executor already is (`budgets.ts`
precedent), enforced by `gates.ts`, never by prompt hope:

- **Step budget per turn**: a hard per-POST cap on loop steps, sized so a
  legitimate extended-depth design (a questions round, author, review,
  revise, second review, revise, plan, with one repair each) fits with
  headroom, and a pathological loop cannot run away.
- **Repair budget**: two rejections per submission kind (§6).
- **Round policy**: exactly §7.3's counts per design cycle, with one
  deliberate change to the derivation. Today `pipeline.ts` scopes round
  counting to one source-package digest, and this plan makes the digest
  move on every answered question round, so digest-scoped counting would
  reset the rounds after every pause and mint free reviews. Rounds are
  therefore derived digest-INDEPENDENTLY: count the persisted reviews
  along the open cycle's parent chain, the segment above the session's
  newest accepted revision, whatever package digest each artifact bound.
  A revision may parent a draft produced under an older package digest
  (the chain is by artifact id; each artifact binds the digest of its own
  producing turn), and a cycle reopened by answered blocking questions
  starts a fresh budget: the budget is per reviewed design, never a
  session-lifetime meter, and every cycle ends in its own reviewed
  acceptance. The second-round decision re-derives from persisted rows
  alone, so a crash-resumed gate reaches the same verdict the live path
  did: depth from the reviewed draft's envelope, dispositions by their
  resulting revision, the architecture diff from the parent and revision
  payloads. A crash and resume can never mint an extra round, and neither
  can a question round between a review and its revision; both are pinned
  gate tests (§13).
- **Sequence legality**: `submitContract` is legal exactly when it opens
  or reopens a cycle (§1); over a draft whose review stands
  undispositioned it is a tool error naming `submitRevision`, and over a
  fresh draft or an accepted head with no newer user content it is a tool
  error naming `requestReview` or `submitPlan`. `submitRevision` without
  a persisted review of the current draft is a tool error; `submitPlan`
  without an accepted, question-free revision is a tool error;
  `requestReview` with no unreviewed draft is a tool error. A superseding
  draft parents the draft it replaces, so the chain stays linear, and the
  replaced draft carries no reviews, so supersession never moves the
  budget. Every error names the legal action.

Budget exhaustion and persistent illegality end the run as a retriable
design-session error with committed artifacts intact; resume picks up from
ancestry (§11).

## 8. Prompt, sources, and cache

- **One growing context.** System prompt, rendered source package, and
  catalog are the stable prefix, cache-written once per session and
  cache-read by every subsequent step (the SA's within-POST steps measure
  99%+ read). Across a question pause, the same-thread resume replays the
  identical prefix: a cache-read within the provider's TTL, a re-write
  after it, never a re-design.
- **Per-session cache key.** `promptCacheKey` keyed on the design session
  (the SA's per-app discipline, `reasoningProviderOptions`), breakpoint at
  the stable-prefix boundary via the existing `markStablePrefixBoundary`
  placement rules.
- **Sources stay package-bound.** `buildDesignSourcePackage` survives as
  the authorization and citability boundary: bounded labeled blocks with
  message, attachment, and image coordinates, persisted rows, digest
  bindings on artifacts, all unchanged. The rendering rides the
  conversation as append-only blocks (the initial package as the first
  user content; each later turn's new sources as that turn's addendum), so
  coordinates stay citable and the prefix stays stable. A later round's
  claims and sources render inside that round's addendum, never
  retroactively into the initial block, or the first user message would
  change and re-bill the whole prefix. Artifacts bind to the digest of
  the package as of their producing turn, exactly as today, and
  `requestReview` re-renders the reviewed draft's own package from its
  persisted reference row (§1): the same determinism, pointed backward.
  Rebuilding the package over an unchanged thread is byte-identical
  (deterministic claim seeding, §5), which is what makes the digest
  binding, the re-render, and the stable cached prefix all real across
  pauses.
- **Digest convergence retires as the resume mechanism** (§11 replaces
  it); the digest survives as evidence binding.
- **Reasoning persists.** Within a POST the loop replays its own reasoning
  items step to step (the SDK's stateless Responses handling, as the SA
  does); the revising turn genuinely knows why the contract says what it
  says.
- **Effort:** the loop runs xhigh (where the author thinks today), and
  the reviewer call runs xhigh too. The reviewer is the one fresh set of
  eyes and the last gate before slice execution spends real money;
  supervisor-shaped review earns the drafting ceiling, never a tier
  below it.

## 9. Progress, narration, and the design system's voice

Every piece of user-facing text this plan introduces follows the CommCare
Nova design system (binding: the readme's Content fundamentals, the Voice
specimen pair, and the templates' canonical activity strings). The rules
that bind here: Nova speaks first person, plain, and warm; sentence case
everywhere; no em dashes anywhere; no ellipsis except on standalone
action-in-progress status text; skip periods on single-line text;
contractions; no exclamation; no emoji; the middle dot separates metadata;
waits get patient reassurance, never silence or percent counters; errors
are Nova's to own, plain and honest, with the chat offering the next step.

The delivery surface is the existing calm activity status row
(`ChatActivityStatus.tsx` in the product; `ActivityStatus` in the design
system's templates): one spinner plus plain language, with its four states
(progress violet, complete emerald, recovering amber, error rose). Design
stages extend the canonical activity vocabulary ("Sending message",
"Planning your app", "Setting up your app", "Building your app", "Your app
is ready"), not a new vocabulary beside it.

Two progress layers, both real:

1. **Tool boundaries are stages.** Every tool call and result is a
   natural, truthful progress event, mapped onto the existing
   `DesignBuildStage` union and `DesignProgressEnvelope`. The status row
   copy, extending canon: "Asking you a few questions", "Designing your
   app", "Reviewing the design", "Improving the design", "Planning your
   app". Long design stretches get the canon reassurance pattern ("Still
   designing. Big designs take a few minutes."). Recovery stays "Trying
   again" (amber); a dead run stays plain and honest ("Couldn't design
   your app") with the chat offering the retry. The server-side
   synthesized `emitQuestions` tool part retires for design-phase
   questions because the agent emits real `askQuestions` calls; the slice
   executor's missing-information escalation still pauses through the
   synthesized part and stays out of scope here.
2. **Streaming step labels inside a submission.** A strict tool call's
   arguments stream as input deltas, and strict-mode constrained decoding
   pins property order to schema order, so watching the accumulated text
   for the contract's top-level keys yields honest sub-steps: "Working out
   the records", "Shaping the tasks", "Writing acceptance scenarios".
   Contract schema field order becomes a narration lever (the repo already
   treats schema field order as load-bearing in `documentExtraction.ts`).
   The parser is advisory-only: a missed key mislabels a step, never
   corrupts state, and it degrades to the existing chars-streamed pulse.

The agent also simply TALKS, in Nova's voice. Brief text parts between
tool calls land in the transcript as a normal chat reply: what she
understood, what she's about to do, a calibrated expectation. For example:
"I have a couple of questions before I design anything." Or: "Thanks,
that's everything I need. This one's bigger, so the design will take me a
few minutes. I'll check in as I go." Expectations are spoken in TIME,
which the design can roughly calibrate; the agent never talks about cost,
credits, or tokens, because spend is the UI's to communicate and the
agent could not speak its language anyway. The templated opener retires,
and
the surviving orchestrator narration is swept to conform (its current
strings carry em dashes, and its templated design summary is superseded
by the agent's own talk). The prompt bounds narration to short and
purposeful; the transcript is not a reasoning dump.

## 10. Reasoning summaries are saved

Nothing the design method thinks is thrown away, and no new table is
needed. The builder already keeps its reasoning: the thread transcript
persists reasoning parts on every assistant message (that is why
`lib/chat/sanitizeReasoningParts.ts` exists: it strips them from replayed
MODEL INPUT; the stored transcript keeps them). Today's design pipeline
keeps NONE of its reasoning: its calls are one-shot structured calls
whose summaries stream as pulse characters and vanish, and the WHY behind
every design outcome (why it asked or assumed, why a shape was chosen,
why a finding was rejected) is exactly the record needed to tune the
design agents later.

Under the loop, the design agent is a chat agent, so its reasoning
summaries (the author, revise, and plan thinking, the bulk of the record)
persist in the thread exactly as the builder's do; a test pins that. The
calls that never touch a thread persist their summaries through the run
event log (`lib/log`'s `events` table, which admin inspect already
reads): the independent reviewer's summary, written beside its review,
and each slice-executor step's. An artifact joins its reasoning through
`created_by_run_id`, so an offline quality review reads the outcome and
the why together (`scripts/inspect-design-artifacts.ts` learns to print
both).

What is stored is the provider's reasoning SUMMARIES, the display-safe
text already streamed to the user in the live-thinking feed. Raw
reasoning stays encrypted and unstored (`store: false` everywhere).
Summaries are never citable as evidence, they never enter a prompt from
the event log, and no design table gains a reasoning column, so
`lib/agent/design/CLAUDE.md` invariant 4 stands unamended. This amends
the program plan's §11.11, which bars reviewer text from events, for
display-safe summaries alone; raw contracts, prompts, and source
extracts stay barred. The event log already carries run diagnostics
under the same elevated read surface and the thread already belongs to
its Project, so both destinations keep the retention and privacy
policies they have. A session that never materializes an app keeps its
rows reachable the way its artifacts already are, through the session's
run ids: the session inspector reads both, and a discarded session's
event rows follow the design session's retention and discard policy
(the program plan's §11.12), never an app's.

## 11. Failure, retry, resume

- **Provider and network faults mid-loop** follow the `turnRetry` POLICY,
  but the code is new: today's retry loop and continuation builder are
  SA-shaped and live on the SA branch only, while the design branch fails
  and refunds. The design branch gains its own bounded redrive, with a
  design continuation builder as a named deliverable. Artifacts already
  persisted are never re-produced; the gates make re-submission of a
  persisted phase illegal, which is what makes the redrive safe.
- **The resume context is explicit, never assumed.** A redrive or a
  fresh-POST resume cannot rely on the model's earlier in-POST steps
  being visible (a redrive drops them; a crash loses them). The per-turn
  state message therefore carries CONTENT, not just status: the current
  persisted contract payload and every finding still awaiting a
  disposition, whenever the thread itself does not already hold them.
  Without this the loop would re-create the reviser-amnesia defect §2
  exists to kill.
- **Run death** (crash, timeout, user cancel): committed artifacts and the
  session's ancestry are the durable state. The next POST re-mounts the
  loop on the thread with that state message. This REPLACES digest
  convergence: resume is by ancestry plus thread, so a retry message no
  longer invalidates completed work, the exact failure mode the live run
  paid for.
- **A turn must end in a recognized terminal.** A loop that simply stops
  emitting (no pause, no accepted plan, no error) is a retriable
  design-session error, enforced by the orchestrator at drain end; a
  silent stop can never present as success or hang as forever-designing.
- **Pauses and events.** A question pause before any contract exists
  rides the session's `awaiting_input` flag and the thread; the durable
  `awaiting-user` orchestration event arm, which today requires a
  revision id and blocking-question artifact ids, gains a pre-contract
  question arm so the fold behind `deriveDesignBuildStage` can name the
  state honestly.
- **Validation failures** are §6 tool results, not run deaths.
- **Honesty invariants hold:** a failed review leaves the draft unreviewed
  and says so; a terminal fault never manufactures a user question; stage
  derivation (`deriveDesignBuildStage`, `last_error_type` overrides) is
  unchanged.

## 12. What this deliberately does not change

- No new artifact kinds, no artifact schema changes, and no new tables.
  The additions are refinement messages in `schemaIssues` diagnostics and
  reasoning-summary event rows (§10).
- No model diversity for the reviewer (still a producer-configuration
  experiment for later).
- No MCP surface change: §17's high-level workflow tools, when they ship,
  drive the same gates.
- No change to slice execution, materialization, conformance, or edit mode
  (§12 to §16 of the program plan).
- The design-agent prompt is a NEW version key (`design-agent-v1`), never
  a reuse of the author's: dogfooding artifacts stamped `design-author-v1`
  and `design-reviewer-v1` already exist, and reusing a key across
  different prompt text is exactly the misattribution the version
  discipline exists to prevent. The author, reviser, and planner keys
  retire with their prompts; the reviewer keeps `design-reviewer-v1`
  until its text changes.

## 13. Testing

- **Gates:** unit tests over `gates.ts`. Every illegal call refused with
  the legal-next-action message, including `submitContract` over a draft
  whose review stands undispositioned; the cycle arms (answered blocking
  questions reopen exactly one new cycle with a fresh budget; an
  unreviewed draft is supersedable only once newer user content exists);
  digest-independent round derivation along the open cycle's chain
  (neither a crash and resume nor a question round between a review and
  its revision mints an extra round); budgets.
- **Loop integration:** the pipeline's scripted-context integration test
  becomes a scripted-agent test: a fake model script driving question,
  submit, reject, repair, review, revise, and plan against the real
  artifact store, proving persistence order, repair bounds (including a
  sensitivity-pair rejection), resume with the content-bearing state
  message, and the reasoning-summary persistence (thread parts for the
  loop, event rows for the reviewer).
- **Package stability:** rebuilding the source package over an unchanged
  thread is byte-identical across question rounds (deterministic claim
  ids), earlier rounds' answers stay citable in later packages, and
  `requestReview` after an intervening question round re-renders the
  draft's persisted reference set to its exact digest (the store refuses
  a reviewer fed anything else).
- **Pause wire shape:** a thread holding two consecutive question pauses
  replays through the sanitizers and is provider-accepted, pinned like
  the existing trailing-round contract.
- **Wire pins:** submit tools carry `strict: true` with the projected
  schemas (extend `designGenerationContextWire.test.ts`'s discipline);
  per-session cache key and breakpoint present (the
  `wireCacheConfig.test.ts` discipline); the reviewer call receives
  exactly the package, contract, and catalog.
- **Progress:** the key-order parser over recorded input-delta fixtures;
  graceful degradation on out-of-order keys.
- **Quality preview:** `scripts/preview-app-design.ts` becomes a
  scripted-loop preview (live calls, ask first) so artifact quality and
  question behavior are checkable without the chat surface.
- The async-leak and act() disciplines apply throughout.

## 14. Acceptance

1. A one-sentence prompt produces questions as the loop's FIRST model
   action, before any contract-sized generation, and the turn's paid usage
   up to the pause is a small fraction of a full design.
2. Answering questions resumes the same loop: no author re-run, no
   digest-invalidated artifacts. Total cost of a design with one question
   round is measurably below two full pipelines (the current price).
3. A submission that fails our own schemas is repaired in-loop; a run
   never dies on first rejection, and a second-rejection death carries the
   refinement messages in its diagnostics.
4. Steps after the first show nonzero `cacheReadTokens` on the same POST;
   a prompt-cache wire pin holds the key and breakpoint config.
5. Every phase transition appears in the chat as a truthful stage within
   two seconds of occurring; submissions narrate sub-steps while
   streaming; all design-turn copy follows the design system's voice and
   mechanics, including the surviving orchestrator narration this plan
   sweeps.
6. The reviewer demonstrably receives no loop reasoning (call-args pin),
   and a plan cannot persist without a persisted review and an accepted
   revision (gate test), including when acceptance carried blocking
   questions: the post-answer cycle is itself reviewed before any plan.
7. Every design-method model call's reasoning summary is durably
   readable: loop steps in the thread like the builder's, the reviewer's
   and each executor step's in the run event log, joined to artifacts by
   run id.
8. All §3 survivals hold: artifact store tests unchanged and green.

