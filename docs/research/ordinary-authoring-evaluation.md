# Ordinary authoring evaluation

These requests are frozen before the first paid trial of the ordinary-authoring
changes. They are fictional user requests, not customer material. They did not
supply implementation fixtures. Run each through the normal architect/build/peer
path; answer genuine user questions at the same level of intent. Do not provide
expressions, hidden identities, form IDs, debugging diagnoses or repair scripts.
An expert rescue is a failed autonomous attempt even if it repairs the app.

## Held-out request A

> We run a small seed distribution program. Field workers register growers and
> their plots. A grower can have several plots. Each season a field worker records
> a seed request for a particular plot, including crop, area and quantity of seed
> requested. They should be able to return and correct a request until it has been
> approved. Supervisors review pending requests and approve or reject them with a
> reason. Approved requests can then be recorded as delivered by field workers,
> with the quantity actually delivered and the date. Keep earlier seasons and
> decisions available; a later edit must not erase who approved a request or when.
> Field workers should see their own branch's growers, and supervisors should see
> all branches they oversee. We have not supplied real workers or branch names
> yet, but we want to try both jobs in Preview. Please choose sensible wording
> and organization and tell us what setup is still needed before deployment.

Independently observe available identities and honest place setup; branch record
availability; grower/plot selection; editable pending requests; supervisor review;
delivery of the intended approved request; retention of prior decisions and
seasons; understandable lists and forms. Investigate plausible wrong-parent,
wrong-role and repeated-action paths. Judge the user's requirements rather than
requiring one particular data design. Device and deployment claims need separate
consumer evidence.

## Held-out request B

> Our community center offers evening workshops. We need an app at the welcome
> desk to register participants with their name, age group, preferred contact
> method and the workshop they want to attend. The choices are bicycle repair,
> cooking and basic computing. Phone and email should only be requested when
> someone chooses that contact method; people may choose no contact. Staff need
> to find a participant later, correct their details and mark whether they
> attended. We also want a separate anonymous feedback form after a workshop,
> with a one-to-five rating, whether the participant would recommend it, and an
> optional comment. Feedback must not ask for a name or link back to a person's
> registration. Keep the forms short and friendly. We only need English.

Independently observe ordinary entry, conditional requiredness, useful validation,
search and correction, attendance persistence, anonymous feedback scope, question
wording and order, and absence of invented permissions or deployment requirements.
Check exported behavior for the material form and case semantics.

## Method and limits

Budget: $20 for one development task, $30 for each held-out request, and $20 for
ordinary-intent repair of the delivered app. Preserve every attempt and unknown
charge. Do not use a successful retry to erase its original failure. Stop a task
at its budget boundary with the incomplete result recorded.

Retain revision and runtime identity, request/answer inputs, plan revisions,
reasoning summaries, model messages, tool calls/results/errors, corrections,
input/output/cache usage, cost and elapsed time. Compare repeated reads, calls,
plan growth and retained context alongside requirement fidelity and usability.
Full definitions, initially loaded definitions and subsequently loaded definitions
are separate observations; deferred tokens are not removed tokens.

Inspect the saved app independently through visible Builder/Preview entry and
role switching, then exercise state transitions and persistent effects. Isolated
journey results show the recorded Preview/Postgres behavior only. Use independent
CommCare consumers for relevant wire claims and record remaining device/offline,
media and external-service uncertainties. A green review or clean CI is not an
acceptance verdict. The initial development attempt stopped after planning. The same-request retry
entered construction and exercised its lending journey, but the legacy harness
stopped before peer review because it priced all cached input as uncached. Its
46 calls reported $1.975 on the production rate card, while the old conservative
ledger consumed $12.134 before a further reservation could fit. That interrupted
attempt is retained. Known cache usage is now settled using the production rate
card with a 25% margin; missing/inconsistent cache details keep the conservative
price, and unknown calls retain their full reservation. The per-call worst-case
reservation and total approved budgets remain unchanged. The resumed development run completed in 77 additional calls for $2.855 on the
production rate card. It retained the original request and received no expert
repair feedback. The peer found a real initial-value defect; the architect
corrected it. Peer journey calls encountered the review-lock defect documented
in `ordinary-authoring-observations.md`, so that run does not prove the corrected
peer observation path. Independent browser entry found an ordinary Preview
empty-population branch hiding the registration action. Its agent-tested journey
therefore did not establish user-visible reachability. At that earlier checkpoint, held-out outcomes and
usable-app acceptance remained unestablished; the bounded results below supersede
that progress status.

## Role-gated trial observation

The first attempt stopped at the evaluation harness's 80-call bound. Ordinary
recovery then reached the production peer's 40-call allowance during its first
app review: 18 scoped reads and 22 journey-tool calls. A second recovery with the
same input correctly refused further calls because that allowance is durable.
Neither interruption is a completed review or a passing app. The peer had
independently derived and begun exercising related-record and role journeys.

The peer allowance is increased to 80 calls per review so those observations can
finish within a bounded investigation. Architect and translation limits are
unchanged. The trial remains development evidence for this adjustment; a later
continuation is not a fresh held-out pass. The second frozen request remained
independent of the implementation. The original traces, cost, repeated reads and
remaining usability checks stay in the evidence.

Local browser-test startup restarted the shared Postgres container during the
first recovery. The evaluation logged terminated idle connections and continued;
its eventual stop was the durable review allowance. This environmental interference
is retained separately and must not be attributed to agent judgment. Future local
browser stack starts are serialized with paid runs.

The byte-based reservation subsequently stopped the architect after the peer
returned findings, although measured spending remained below the trial allocation.
A non-generating provider count for a retained 980,415-byte request was 149,067
input tokens, exactly matching its reported generation usage. The harness now
requests that count only when the byte reservation would refuse a call, retains
all input-bearing fields (including deferred tools), and reserves long-context
cache-write prices plus 25% input headroom and the full output ceiling. Invalid
counts fail closed. The approved spend limits and unknown-charge retention are
unchanged. [Provider token-counting contract](https://developers.openai.com/api/docs/guides/token-counting).

## Bounded results after deployment

Nova's authoring/context/journey changes shipped in #646, #647, #649 and #650;
plugin 1.34.0 followed compatible Nova deployment. The following are measured
attempts, not forecasts or model-quality generalizations. Costs use each call's
production rate card and reported cache usage; budget reservations include an
additional margin and possible next-call cost.

| Task | Model calls | Tool calls | Input tokens | Output tokens | Cache read / write tokens | Measured cost |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Development, all attempts | 131 | 129 | 5,552,181 | 34,266 | 5,281,092 / 173,662 | $5.241 |
| Related-record roles, all attempts | 260 | 296 | 28,342,208 | 70,804 | 27,506,572 / 583,186 | $20.785 |
| Workshop, initial and recovery | 102 | 99 | 3,394,648 | 18,560 | 3,191,953 / 137,926 | $3.339 |

The development plan grew from 4,405 to 8,174 characters; the role-gated plan
from 15,473 to 21,635; the workshop plan from 5,929 to 7,354. Maximum serialized
provider requests were approximately 404k, 1,331k and 552k characters respectively.
These count retained messages and definitions; they are not token estimates or
claims that deferred definitions disappeared. Exact same-role/read/arguments
repeated mostly two or three times in development, two or three times in the
first role-gated attempt, and twice for one workshop plan read. That narrow
measure cannot identify semantically redundant reads with different arguments,
or decide whether a repeated read was justified by a revision.

### Development

The completed lending app passed independent ordinary Preview entry, first-record
registration, loan creation, return, empty active queue and retained history after
reload. Its final export parsed in Core and created a borrower with two related
loans, returned one, preserved the other, and retained open historical records.
The initial-value correction was autonomous. The empty-population UI correction
was a product change discovered independently; the original trial did not prove
that corrected entry path. Hidden fields still leave gaps in screen-reader question
numbers, and a search answer did not prefill registration in this authored app.

### Related-record roles: failed acceptance

The bounded trial stopped during architect corrections, before a final peer
verdict, when the next conservative reservation would exceed its $30 allocation.
Its measured spending was $20.785, not $30. Earlier call-limit, durable review-limit
and accounting interruptions remain part of this result. This request influenced
worker-context and review-budget changes and is no longer fresh held-out evidence.

The peer used the new observations to discover wrong parent links, ownership
that hid child records from supervisors, disconnected selection, missing place
context, and inappropriate initial values. The architect made consequential
corrections through ordinary tools. Nevertheless, the final saved export still
created a request with blank business status: a defaulted question was made
non-relevant. Core parsed all nine forms and executed the preceding related-record
creation successfully; the blank status prevented proving approval and delivery.
The architect also persisted invented deployment places rather than keeping
examples exclusively in disposable tests. Ordinary Builder showed the unfinished
build recovery state; this was not bypassed to claim Preview success.

The initial architect read people/place and expression guidance but did not read
the workflow guide before choosing its child-creation pattern. Available facts,
focused discovery, interpretation and final judgment all matter: a larger prompt
containing every incident is not the correction. Focused guidance now explains
child ownership and the data consequences of relevance using audited runtime
semantics. No expert repair was supplied to turn this app into a passing trial.

### Workshop: completed review, independent checks

This materially different request did not shape the implementation. It reached
the harness's 80-call invocation bound, then completed through same-input recovery
in 22 more calls without expert feedback. Its peer independently exercised
conditional contact requirements, search, corrections, attendance and anonymous
feedback. It found that attendance displayed an internal workshop code, then
verified the architect's correction against the saved revision while retaining
unaffected earlier evidence. The final response described Preview entry and
explicitly withheld physical-device and deployment claims.

Independent ordinary Preview confirmed registration, conditional email validation,
partial-name search, correction with obsolete email removal, friendly attendance
confirmation, and attendance persistence after reload. Core parsed the four
forms and suite and executed email-to-phone-to-no-contact corrections, attendance,
and feedback without a registration identifier or case effects. This is native
form/submission evidence, not native menu interaction, physical-device or offline
sync acceptance. Standard staff/device submission metadata remains, as the agent
explained; participant anonymity does not remove platform audit metadata.

### Delivered-app repair: incomplete

The current app was refreshed after intervening user edits. A new ordinary request
preserved its current scope and asked for useful naming, role Preview identities,
honest deployment setup, disposable workflow checks and removal of redundant
audit collection. Two editor invocations reached their 80-call bounds without a
completion response; user-level continuation preserved the request. Their measured
cumulative cost was $0.39325. A third continuation made 38 calls and stopped after a history read failed the
SDK message contract; cumulative measured cost reached $0.54949. This is a
product failure, retained separately from the app judgments below.

The editor saved role personas and corrected registration effects. It discovered
that the reviewing role could not receive records owned by the collecting role
without a shared place assignment. It then incorrectly claimed isolated place
assignments were unavailable and fell back to supplied-record single-form checks.
The journey schema already exposes fictional places and per-test assignments,
and the workflow guide explains their deployment boundary. This is a failure to
use an available observation, not proof of an unavailable capability. Single-form
checks cannot establish that handoff or additional-operation persistence.

Independent browser checks observed the three role-specific menus, registration
entry and recorded journey steps. A page reload also failed during production
database connection timeouts; a later reload recovered. The incident is retained
with unresolved cause, rather than counted as passing or blamed on the blueprint.
The saved revision's 26 exported forms and suite parsed in Core, with the
production lookup-aware export boundary. That is parsing evidence only, not a
native journey or physical-device result.


### Fresh repair after observation-contract fixes

A fresh ordinary editor conversation retained the same user-level scope and
asked for wording appropriate to visible worker controls. It completed after
142 model calls and 285 tool calls, including a user-level continuation after
the initial 80-call bound. The durable summary reports 25,448,262 input tokens,
71,096 output tokens, 24,707,582 cache-read tokens, 430,401 cache-write tokens
and $0.749123. Detailed step events cover 140 calls; the two missing detailed
observations are retained as an evidence limitation. The earlier interrupted
198-call repair remains a separate failed attempt ($0.549490).

This editor used the available disposable place/assignment capability and
corrected a child-owner handoff through ordinary tools. It also saved business
confirmation/history values, corrected worker-facing location guidance, and
retained the user's current scope. Its test showed a newly registered record
reaching another role's approval task. However, independent native execution
of that saved export found that its initial business status was blank. All
forms parsing successfully had not established correct submission effects.

The source cause was shared Preview behavior: additional case operations read
retained answers from non-relevant questions. Core treated those answers as
empty. PR #654 corrects the production projection and pairs real Postgres
persistence with native Core execution over the same public fixture. The
original Preview verdict remains a failed result; corrected infrastructure
does not retroactively validate it.

The final agent response also directed the user to a disposable test record
that had already been removed and was never part of ordinary Preview. The
browser listed that fresh handoff as an 18-step journey and opened its entry
observation through the identity menu, with explicit disposable-state limits.
That check did not inspect all 18 steps. Ordinary case results contained no
business records. The focused guide now distinguishes these two
surfaces. User-facing completion remains part of acceptance, independently of
whether an agent can exercise its own test.

### Deployment interruption during acceptance

A later migration failed with a PostgreSQL deadlock between privilege
convergence and a live case-restore reader. Convergence unconditionally changed
already-correct owners, acquiring exclusive locks across fixed relationship
and runtime case tables. PR #655 reads catalog ownership before changing it
and bounds genuine repair lock waits within the existing audited transaction.
Real Postgres proves convergence alongside an open reader, rollback of prior
grants after a blocked repair, and successful repair after release. The new
production migration passed privilege convergence and the runtime probe.

This establishes the cause of that deployment failure and its conflicting
reads. It does not establish that every earlier connection timeout had the
same cause. Browser reads recovered after the failed migration stopped; the
original unavailable observations remain in the record.

### Follow-up with corrected relevance observations

A further ordinary request asked for a usable Preview handoff, registration and
approval state transitions, the contract handoff, and unused audit cleanup.
It made 77 more model calls and 99 tool calls. The same durable run now totals
219 calls, 384 tools, 30,832,022 input tokens, 94,321 output tokens,
29,938,321 cache-read tokens, 545,686 cache-write tokens and $0.917976.
Detailed events cover 217 calls; the existing two-call observation gap remains.
These totals include the preceding 142-call repair and must not be added to it.

The agent corrected contract ownership and made the final instructions distinguish
ordinary Preview from the recorded test-journey viewer. It accurately reported
unused catalog definitions as an unavailable cleanup operation. Independent Core
execution still found blank initial business status. The corrected Preview trace
now also omitted that property after registration and Senior approval; a later
Head status-edit form supplied it. The agent nevertheless judged the handoff
successful. This is a missed conclusion despite available state evidence, rather
than the earlier runtime masking defect. The run remains a failed autonomous
repair outcome.

### Empty-start repair and remaining observation gaps

After safe catalog cleanup became available, an ordinary request removed eight
unused definitions and exercised first-record creation with no supplied business
records. The editor discovered that its app-created parent remained worker-owned,
so another role could not select it. It guessed an undeclared worker location key,
removed an unsuccessful ownership change and reported that boundary. This is
better evidence than the earlier supplied parent, but still an incomplete repair.
The invocation stopped at its 80-call bound during a separate approval checkpoint.
The durable run totals 299 model calls, 478 tool calls and $1.252716; these include
the preceding 219 calls. Input/output tokens total 43,562,272 / 114,250, with
42,416,960 cache-read and 764,287 cache-write tokens. Detailed events cover
297 calls, retaining the same
two-call gap. The earlier interrupted repair remains separate.

Source inspection found that the existing worker tool omitted built-in place
readings already supported by HQ and Preview. The updated projection makes those
readings discoverable and explains their form/record scopes; an empty-entry
Postgres journey proves creation with the advertised sharing expression. The
recorded form observations also exposed retained defaults on excluded questions
as ordinary values. That ambiguity could encourage a mistaken conclusion about
saved state, though it does not establish the agent's cause. Observations now
separate participation from visibility and retained answers from usable values.
The recorded submission still omitted the required initial business status;
these product corrections do not make the earlier app or judgment pass.

### Anatomy browser audit

The local browser showed current prompt/catalog composition separately from
recorded architect and peer messages, the actual plan payloads, and per-call
provider usage. In the inspected saved-app composition, 1,257 estimated tool
tokens were available initially and 65,481 were in the full current catalog;
the page explicitly says resumed threads may have loaded more and that today's
catalog does not reconstruct an older request. Planning has a different catalog.
Deferred definitions have not been removed from later context. This inspection
also removed an obsolete fixed role count and renamed the static token label to
state that it describes initial context. Opaque compaction counting remains
covered at its production projection boundary; the inspected workshop record
contained no compaction checkpoint, so it supplies no live compaction example.

Ordinary production Preview also exposed a worker-switching problem: changing
from a worker inside a registration form left that form open for the next
worker, although the next worker's menu hid it. The identity action cleared
record bindings but retained the form URL. The menu and missing-persona recovery
now replace that URL with app entry. A production-build Playwright journey
switches away from a gated form, verifies the new worker's menu, and reopens
with cleared answers; the two neighboring recovery/navigation checks also pass.
This changes the simulated worker's entry, not the actor's Project authorization.
Hosted CI also caught an intermittent ResizeObserver notification in the existing
case-workspace filter interaction. That test passed its automatic retry, but the
strict browser-error gate correctly kept the job red. The original failure is
retained separately from the worker-switch checks; its precise layout source is
not established, and no error assertion was weakened.

The delivered app's ordinary entry reaches first-record cluster registration
and displays its deployment-place guidance. Its recorded handoff instead began
with a supplied place-owned cluster. The authored registration uses ordinary
creation, whose ownership defaults to the current worker. That supplied starting
record therefore did not establish the handoff beginning with the app's first
task. An empty-business-record journey remains required before claiming success.
