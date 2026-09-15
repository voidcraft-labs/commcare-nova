# Production design comparison: garden history

Neither interface produced an accepted design in this bounded comparison. The
revised prompt reached independent review and was revising a missing history
view when the trial's request cap stopped it. The previous prompt stopped at
Nova's submission-nonconvergence gate before independent review.

The useful finding is a mismatch between the decisions a designer makes and the
construction details the interface makes it reconcile. Both authors placed the
plot's history list in the plot module, which cannot host a different record
type. The previous author then hit a construction-owner scheduling condition and
a one-to-one navigation/module declaration rule. These are concrete reasons to
improve the authoring model rather than add instructions about each rejection.

## Method

Both arms ran `runDesignAgentLoop`, the installed OpenAI SDK, production design
actions, canonical admission, and the independent-review lifecycle on an
isolated migrated Postgres database. The source was a complete synthetic request
for a garden coordinator: register plots, preserve weekly soil checks as
history, show latest-check summaries, and correct plot details. The role profile
was the repository's **GPT-5.6 Sol at medium effort** for both author and reviewer.
This differs from the Luna construction profile used in the earlier executor
trial.

The revised arm used `4f1cd2a4`; the previous arm used `0b575ef8`. Each had a
24-request limit and eight-minute deadline. The protocol and task were fixed
before the first paid call. An independent subagent reviewed the harness after a
zero-cost fixture run. Two accounting findings were corrected before spending:
reserve for Sol's possible request cost, and retain the reservation when reviewer
usage is absent or normalized to zero.

The trial pinned Sol and reserved $25 per request, releasing unused amounts after
metered completion. That exceeds its published full context/output capacities
at the repository's higher long-context rates plus a 25% margin. This is a
conservative budget reservation, not an expected request cost. The official
[Sol model card](https://developers.openai.com/api/docs/models/gpt-5.6-sol)
lists those capacities; its current prices are lower than Nova's checked-in
pricing card.

## Observations

| Observation | Revised | Previous |
| --- | --- | --- |
| Model requests | 24 | 8 |
| Conservative estimated cost | $4.24 | $2.21 |
| Immutable draft persisted | Yes | No |
| Independent review reached | Yes | No |
| Accepted design or app | No | No |
| Stop | Trial request cap during revision | Production submission-nonconvergence gate |

The revised author loaded 11 design operations in its first search and one
additional disposition tool during revision. It generally saved one collection
per response despite already having the relevant tools. The previous author
saved 11 authoring operations in its first response and grouped later corrections. That
is useful batching behavior to preserve. The comparison changes both prose and
loading policy, so it does not identify which change caused this difference.

Both designs initially put the Weekly check history list in the Plot module.
The revised author removed that list to satisfy admission. Independent review
then correctly identified the resulting usability gap: checks were stored but
workers could not view earlier checks. The author was adding a history view
when the request limit stopped it. The brief's smaller size did not prevent
that loss of functionality during repair.

The previous author created a separate history menu after its first rejection.
Its second rejection required that menu's construction owner to be scheduled
no later than the parent form that creates its records. It changed workflow
ordering and then hit a third rejection because two modules shared a navigation
entry. Nova stopped the turn after those distinct failed submissions.

The recorded requests, saved workspace operations, immutable draft, and
server-projected review support these observations. The
[comparison data](agent-design-interface-results.json) retains per-request usage,
call grouping, admission feedback, and outcomes.

## Limits and next work

This is one scenario and one sample per interface. Neither arm built an app, so
there is no Preview, case-submission, export, or deployment result. A smaller
prompt and deferred catalog are not sufficient evidence of better app quality.
The revised arm's request cap also prevents comparing completion cost or time.

The first harness snapshot accidentally serialized the canonical review Map as
an empty object. Its exact author-visible server projection was retained in the
next request and is separately labeled in the comparison data. The canonical
draft, operations, identities, context items, and model-step evidence were saved.
The snapshot was corrected and independently reviewed before the previous arm;
no model call was repeated just to recover that metadata.

Next, trace construction ownership and scheduling to their server owners, then
simplify the overlapping navigation/module declarations while preserving the
actual app behavior. Existing derived planning and canonical admission remain
the authority. The author should choose the worker's experience; Nova should
derive the construction sequence. Also preserve the ability to save settled
work together. Further trials should follow a concrete interface improvement.

These two trials added $6.45405625 in conservative estimates. The shared ledger
now records 133 completed requests, no pending reservations, and **$7.31066125**
across this investigation.
