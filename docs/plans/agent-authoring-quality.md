# Improve agent authoring

Implementation is authorized. Delivery means independently reviewed PRs in the
native GitHub stack, with all required CI green. Merge is not authorized.

Help Nova's agents make the best apps they can through clear context, useful
tools, good judgment, and feedback from the app. Make the work easier to
understand and express. Reduce unnecessary decisions, duplicated information,
storage vocabulary, and procedural instructions. A smaller interface that
causes guessing or difficult repair is a regression.

The user's 5,000-token prompt and 20,000-token tool figures express ambition,
not ceilings. Keep information when its contribution justifies it. CommCare
belongs in the orientation: Nova has its own authoring model and produces
CommCare apps. Hiding that relationship would make the task less clear.

## Scope correction

The unfinished [reviewed-build proposal](reviewed-intent-atomic-change-sets-plan.md)
is context, not a requirement to implement Units F and G. The user clarified
that those proposed processes were deliberately left unfinished because their
complexity and effect on app quality were unsettled. This optimization must
not become an effort to complete that plan.

The user subsequently confirmed that completed work should remain in the
stack and the remaining optimization should land on top. PR #614's canonical
structural reports are reviewed and CI-green. They ship as implemented; they
do not require a new implementation-review lifecycle, Design history, or a
substantial-edit protocol. Those unfinished proposals are outside this delivery
unless a substantially simpler design demonstrates a necessary benefit for
the original objective. Existing private feedback and canonical reports remain
structural checks, not proof of the app's overall quality.

The canonical Blueprint, identity-based references, shared authorization and
mutation gates, durable recovery, and valid app construction remain the
foundation. Prompts, tools, role boundaries, context composition, and the
number of model turns are design choices. Reconsider them when they make the
agent's work harder. Direct Builder and MCP edits remain usable independently
of design history.

## Remaining work

**Finish the interface.** Review every role's actual prompts and schemas and
follow representative requests through `/agents` and captured provider input.
Assess what the model learns, what choices it must make, and what each result
adds. The selected native authoring boundary already accepts readable text,
expressions, and names; finish simplifying the remaining large definitions
and remove obsolete prototype paths. Do not substitute an enormous required
guide for an enormous system prompt.

A workflow should discover only tools it can use. Its existing server policy
now selects that catalog as well as enforcing calls, and its brief no longer
repeats the tool list. Definitions remain stable within the attempt. This does
not prove that each fetched definition is clear or compact enough; inspect
and improve those definitions separately.

**Finish working context and prose.** Rewrite the document extractor's
repetitive instructions while preserving exact requirements, source uncertainty,
figure content, and privacy. Assess design, review, editor, executor, helper,
and MCP guidance as complete reading experiences. Remove duplicate state,
internal bookkeeping, irrelevant capability rules, and repeated encouragement
from prompts, retrieved material, and results. Preserve source access and
facts needed for correct dependent edits. Verify live requests, including
loaded schemas and accumulated context, rather than measuring only an opening
prompt.

**Prove useful apps and revisions.** Use the [task cases](agent-authoring-quality-cases.md)
with observed worker behavior and saved-data effects. Include fresh design,
construction, dependent edits, recovery, source fidelity, and an external
client using the shared MCP surface and sibling plugin. Inspect failures and
fix their cause; use smaller controlled checks where they can establish a
contract. Runtime observations use the existing Preview and persistence
boundaries with isolated test data. A new production testing or review
protocol is not a prerequisite.

Compare model and effort choices only when the interface is interpretable.
GPT-6 Astra is a candidate, not a substitute for good tools and context. Keep
model-specific guidance small and supported by official sources.

**Finish delivery.** Remove obsolete guidance and prototypes, update the
implemented architecture and public docs, and verify the integrated stack.
Every slice needs independent subagent review and all required CI. Report
actual reductions, app outcomes, and remaining limitations with comparable
measurements. No single successful demonstration establishes general quality.

## Evidence and budget

The [initial research](../research/agent-authoring-2026-09-12.md) and
[native-versus-programmatic comparison](../research/agent-authoring-pilot-2026-09-12.md)
record the baseline and interface decision. Native tools won the selected
comparison; the early pilot proves feasibility on that task, not general
feature coverage.

The same local tokenizer used by `/agents` measured the original editor at
16,934 system tokens and 148,191 tool tokens, the executor at 6,277 and 176,393,
and MCP at 19,003 and 206,617. The September 13 catalog audit measured editor
623 and 76,133, executor 377 and 69,026, and MCP 831 and 82,031. The document
extractor was still 5,672 tokens. These are local estimates of the complete
catalog, not provider counts or the amount loaded on a particular turn.
Current deferred opening counts do not establish the cost of using the tools.

The latest garden construction replay completed three workflows; a separate
runtime check exercised registration, correction, and dated child history
with isolated Postgres data. This reused an accepted design. It does not prove
fresh design reliability; the latest fresh design trial reached its request
cap before construction.

Conservative generation spend is $31.9102 across 347 completed requests, with
no pending reservations at this update. The user authorizes intentional API
trials below $200, aiming below $50, and input-token counting with Nova prompts,
schemas, and synthetic tasks. Root owns paid calls and the private spend ledger.
Record all attempts and bounded stops so a retry cannot hide a failure.
