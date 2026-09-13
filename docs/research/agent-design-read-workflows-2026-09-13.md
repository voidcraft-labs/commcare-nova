# A history view does not need a submission

The third garden design trial reached independent review on its first
submission. It still produced no accepted design or app within its 24-request
budget. Its useful finding was a product-model error: Nova required a form for
a task whose purpose was to read saved history.

The trial used the same synthetic garden request and production author/reviewer
profiles as the [earlier comparison](agent-design-trial-2026-09-13.md), with
source commit `3994e079`. The changes since that comparison removed duplicate
navigation declarations, derived construction ownership, bound source labels,
and permitted settled updates in one response. The production loop, tools,
artifact store, and reviewer ran against an isolated migrated Postgres database.
The cap remained 24 requests and eight minutes. This one trial cost a
conservative $4.653625; recorded investigation spend reached $11.96428625 over
157 completed generation requests, with no pending reservations.

The author initially designed three forms: register a plot, record a weekly
check, and correct plot details. It preserved each check as a child record but
offered no view of past checks. Independent review identified that gap. The
author added a read-only history workflow with a child list showing date and
condition, plus the note in its detail view. Nova rejected that design solely
because the new workflow lacked a form. The author began changing the list into
a form-bearing menu when the cap stopped it.

The existing interface had two linked assumptions: every workflow needed a
form, and every workflow needed a separate executor slice. Removing only the
first would leave a read task asking the executor for a mutation even when the
earlier writer already built its list. The replacement admits a task with no
inputs or record effects when placed lists and details show every requested
property to every actor. Where those surfaces belong to earlier construction,
the read workflow joins that construction's existing group. Its identity,
requirements, record context, and external setup remain explicit in the plan
and brief. There is no invented form, empty receipt, or model acknowledgment
step. A read task that owns construction still has a slice.

A local replay of the exact saved candidate from revision-workspace step 9,
before the rejection, now passes design admission. It produces three build
slices covering all four workflows, with history in the weekly-check slice,
and retains the original three forms. This is a deterministic reproduction of
the interface defect and its repair. The candidate has not received a clean
independent design review or been built into an app by this replay.

Behavioral tests also exercise the real mutation gate: the child history menu
can be created before its writer and remain a list with no form. Negative cases
retain the form requirement for data entry and record effects, and reject
missing read properties or actors. These observations do not establish full
semantic conformance or runtime quality.

The [recorded trial data](agent-design-read-workflows-results.json) includes
the task, source commit, model settings, every request's digest and usage, and
the incomplete outcome. It is one scenario and one attempt, with several prior
interface changes, so it cannot attribute improvement to any one change. The
garden scenario has no lookup data and does not test source-label authoring for
tables. End-to-end app construction and runtime observations remain next.
