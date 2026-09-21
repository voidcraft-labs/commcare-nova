# Agent authoring

Nova gives one architect the user's request, relevant source material, and a
shared Markdown plan. The architect carries the work through design,
construction, inspection, and correction. An independent peer reviews the plan
before construction and the saved app before completion. Both reason about the
same content; there is no translation into a second design graph or compiler
brief for a separate builder.

## Plan and judgment

`lib/agent/planning` stores a revisioned Markdown document. Writes and exact
passage edits have durable request receipts. A peer review acquires exclusive
plan ownership while the architect is paused. The peer can improve the plan and
returns a concise assessment; the architect receives both the updated document
and the assessment. There is no finding-ID or disposition protocol.

Review identity binds the plan revision, source digest, and, for an app review,
the actual canonical revision. Editing the plan or app makes the relevant old
review stale. The architect remains responsible for resolving feedback and
judging completion. Review is not a formal proof that the app meets every human
requirement. Mechanical correctness belongs to the document gate; functional
quality needs inspection and representative journeys through the running behavior.
`startAppTest`, `continueAppTest` and `readAppTest` expose app entry, saved worker
identities, menu eligibility, record selection, answers, submission effects and
the next task. They use disposable Postgres records and the production Preview
projections, FormEngine and submission transaction. They do not change live cases
or assert native-device correctness. Builder's Test journeys shows the same
retained observations, including the source revision and boundaries.

For a narrower question, `evaluateForm` evaluates one form without a transaction.
Its optional scenario supplies test records and parent relationships without
storing them, allowing follow-up forms and record-dependent rules to be exercised
before an app has real data. Stored records and supplied records never mix;
Project lookup data remains authorized and real. The result identifies its source
and does not claim a successful submission or additional case-operation execution.

Planning exposes reads and plan edits. It does not expose app or Project data
writes. The peer can inspect the saved app, evaluate forms and exercise disposable
test journeys without submitting real cases. Questions are reserved for decisions the agent cannot reasonably
make. A planning-only request can finish with a reviewed plan and no app.

## One authoring vocabulary

The architect, ordinary chat editor, and MCP clients share the registry's
semantic operations. Tools accept names, Markdown, and expressions; the
`authoring` boundary resolves identities and typed content inside an authorized
workspace invocation. The document and mutation kernel retain their canonical
contracts. Tool schemas describe inputs and effects, while a focused reference
guide is available on request. Scoped reads expose effective initial values,
ordinary answer destinations and
built-in lifecycle metadata. Worker readiness distinguishes a role definition
from an available Preview identity and reports missing information or place
assignments. Those are configuration observations, not proof of entry or workflow
completion.

Lifecycle guidance describes operational effects, including closure's effect on
sync and dependent records, and distinguishes business stage, ownership and actor
history. [The primary-source audit](../research/record-lifecycle-authoring.md)
records Nova, Core and HQ read semantics and the limits of that evidence.

Prompts do not duplicate either the inventory or
the underlying storage grammar.

Hosted tool search defers shared definitions for Nova's model calls. This lowers
the initial context but does not remove their eventual cost. Schema factoring,
plain authored content, scoped reads, and concise semantic results reduce the
actual representation. `/agents` keeps the total catalog visible alongside the
initial surface, prompt, changing context, and recorded usage.

## Private construction and canonical checkpoints

A Project-scoped session exists before an app does. Construction begins from a
reviewed plan in a private workspace. Shared mutations can leave incomplete
intermediate work there; only a complete, valid candidate can be saved. The
first save atomically creates a meaningful app, including its runtime schema,
ordered history, lookup edges, session mapping, and exact receipt. Later saves
commit valid checkpoints through the same canonical kernel used by Builder and
MCP. Preview and export consume only canonical revisions.

The current holder and Project edit membership authorize every write. An active
peer review pauses construction. A checkpoint re-resolves current resources and
replays admitted mutations against locked canonical state, preserving compatible
concurrent changes and rejecting conflicts. The initial build stays locked for
ordinary editing until completion. If later work stops, its earlier canonical
revision remains available and the same session can resume.

External writes are separate effects. During construction, a Project data tool
may create or change a table through the normal service. Its exact request
receipt and expected revision commit with the Project change. A retry first
reauthorizes the current holder and membership. Planning and review cannot make
those changes, and private workspace rollback cannot undo them. Existing shared
data changes need the user's request or informed confirmation; a similar name
is not permission to adopt or overwrite a resource. Organization writes retain
their independent role and revision checks as well.

## Conversation and recovery

The architect has one durable conversation per compatible context. A new peer
review starts independently, with the source, current plan, and app when
relevant. Completed model response items and their usage commit before any tool
executes. Tool results preserve created identities, saved values, confirmations,
and actionable failures without a repeated instruction to continue.

A restarted process replays unanswered tool calls using their original request
IDs. The owning transaction returns the exact prior result. New input and a
fresh current-state message follow those effects, then model work can continue.
A successful no-op is still a completed effect with a durable receipt.

Model, prompt, schema, and context compatibility govern provider checkpoint
reuse. A contract change retains the useful conversation but does not replay an
incompatible encrypted checkpoint. Human-readable reasoning summaries and the
full stored message history remain inspectable. Each logical turn has a durable
step allowance; reconnection does not reset it. Completed usage is accounted
once, including a response completed by a holder that has since lost authority.
Losing authority permits accounting, not another mutation.

Final completion verifies the live holder, exact app revision, and current
orchestration event, then records the terminal event with app completion and
usage settlement. Cancellation and failure join owned streams and heartbeat
work. A saved checkpoint is not, by itself, a completed build.

## Translation

Requested translation reads the current app rather than a frozen plan. It sends
bounded groups of source units to the translator, validates protected references,
and stages accepted batches together. Current translations remain intact;
missing, outdated, or unreviewed copied text is eligible. Retry uses durable
responses and the exact tool receipt, including when nothing needed translation.
See [multilingual localization](multilingual-localization.md).

## Evidence and cutover

Tests use the real SDK with controlled provider responses and migrated Postgres
to exercise interrupted responses, outstanding effects, private and canonical
checkpoints, review ownership, stale holders, revision races, cancellation, and
usage settlement. Those tests establish runtime behavior, not design quality.
Live trials must also inspect the generated app against its original request,
plan, messages, reasoning summaries, failed calls, and corrections. A fresh
reviewer assesses that evidence independently.

Old private formats are converted once by the operator workflow in
[design format cutover](design-format-cutover.md). Serving code never interprets
the retired workflow graph. Canonical apps, collected data, conversations,
billing, and original historical artifacts remain intact.
