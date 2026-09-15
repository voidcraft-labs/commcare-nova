# Garden build: selection and accumulated state

The fourth garden trial produced three design drafts and three independent
reviews, then stopped at its 36-request design cap. No design was accepted and
no app was built. Its final review requested a change that Nova's own admission
rules prohibited. This is evidence of an interface defect, not evidence that
the agent needed a longer prompt or a larger budget.

The [request and result record](agent-design-selection-results.json) retains
the synthetic task, source commit, model settings, limits, every request digest,
reported usage and all three review outcomes. The source was `e4ea6aa7` from
PR #602. The reviewed harness used the production design and build orchestrator
with real local Postgres; it captured requests at the provider transport seam.
The design author and reviewer used GPT-5.6 Sol at medium effort. Construction
was configured for GPT-5.6 Luna at xhigh effort but was never reached.

The trial cost $9.19324 under the conservative ledger: reported usage priced
without cache discounts, with a 25% margin. Total investigation spend is
$21.15752 across 193 completed requests, with no pending reservations. No
production app or user data was involved.

## What happened

The first review caught a real behavior issue: a backdated weekly check should
remain in history without replacing a newer check in the plot's summary. It
also asked for explicit Dry, Damp and Wet labels. The design vocabulary only
offered saved `choiceValues`, while its guidance assigned wording to the
executor. The author could only place those labels in prose. The choice
interface needs to represent the wording the reviewer expects to assess.

The second review correctly challenged a global history list searched by copied
plot name. Names can collide. The author changed the design to open history
through the selected plot and its actual parent relationship.

The third review asked the author to add the read-only history workflow to the
parent's `selection.workflowIds`. That field admitted exactly the workflows
with selected-record or close forms. A history viewer has neither. Replaying
the final workspace through the unchanged production parser reproduced the
rejection: the selection list contained an unrelated workflow. The author
could not satisfy both the review and the graph contract.

The same review treated `prerequisiteWorkflowIds` as a restriction on when a
worker may open history. That field drives construction order; worker
preconditions are described separately. The distinction needs an interface
decision, not another paragraph telling the model which meaning to remember.

The last author request was 474,141 bytes. It contained four server state
messages with 207,372 characters between them, including older states and both
the source and current contract. Positional finding labels also recur across
review rounds. The durable record should preserve that history; the working
context needs an unambiguous current state and focused access to earlier work.
These are request-body measurements, not tokenizer or billing estimates.

## The selection change

The author now states whether workers select several records and the maximum.
Nova derives the affected workflows from form placement. One record is the
default, as it already is in the canonical app. Same-record child forms inherit
a queue-only parent's selection; registration forms and passive viewers do not
become consumers. Existing graph checks still reject incompatible cardinality
or limits. Planning still waits for every consuming form before configuring a
shared several-record selection.

Contract version 3 removes the redundant workflow list. Workspace storage
version 4 carries that shape. The existing scan-and-retire cutover recognizes
both current constants and retires obsolete private designs without rewriting
sealed history or changing canonical apps. There is no read-time conversion.

Tests exercise actual contract admission, build ordering and execution briefs,
including multiple consuming siblings and registration under one parent.
Postgres coverage uses a version-2 contract captured before the change and
checks that scanning is read-only and retirement preserves its sealed bytes.
This establishes the selection contract and cutover behavior. It does not
establish successful app construction; choice wording, current context and a
complete runtime trial remain necessary.
