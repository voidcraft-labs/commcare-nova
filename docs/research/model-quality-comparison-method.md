# First-delivery model comparison

Status: multiple paired trials and independent checks are recorded in
[the comparison results](model-quality-comparison-results.md). The bounded evaluation
and decision to retain GPT-5.6 are recorded; broader quality acceptance remains
unfinished and failed runs stay in the evidence.

Compare the complete GPT-5.6 and GPT-6 role sets on matching production code,
role efforts, prompts, tools, and frozen ordinary user requests. Include a
role-gated related-record workflow and a materially different document-led,
multilingual workflow. Extract the same original document with each family and
use that family's extract as its build input. Inspect both extracts against the
original, rather than assuming either is faithful. Test follow-up editing
separately from first-delivery acceptance.

The trial operator can answer genuine design questions as a regular user.
Record the question and answer; retain the original tool-call identity and
resume the same conversation. Corrective operator prompts cannot make an
initial delivery pass. Preserve failed attempts, unavailable observations, and
which tasks informed later implementation.

`scripts/evaluate-architect.ts` uses the production orchestrator, shared tools,
real Postgres, and the production source/extraction store. Its optional text
attachment is published to the trial's dedicated Project and read through the
normal authorized source interface. This exercises extraction and source
reading, not the browser upload interaction. Artifacts retain the original,
extract, requests, responses, reasoning summaries, plan revisions, final app,
question answers, and usage. They are private and must not be committed.

`scripts/evaluate-editor.ts` separately exercises the production ordinary editor
factory and its history projection against a fresh app prepared by shared tools.
It retains the production step bound, run lease, usage settlement and model
callbacks. A dry run verifies fixture setup without spending. Paid edits share
the same ledger, with a $5 per-edit ceiling and model-specific reservations. This is an edit-role comparison, not evidence of initial delivery or
browser chat transport behavior.

The build runner allows 400 transport requests and 30 minutes per invocation, with a
$30 trial ceiling carried across clarification resumes. A shared locked ledger
enforces the separately authorized combined ceiling before dispatch, including
retries and uncertain charges. Explicit production output ceilings pass through;
otherwise the runner allows 128,000 output tokens, including reasoning. The final
matched pair froze a 32,000-token ceiling on both sides to bound remaining cost;
its private runner differs only in that ceiling and local import resolution. The
reservation uses the serialized output ceiling and each model's highest
published input, cache-write and output rates across context tiers. Requests
explicitly select Standard processing before capture and dispatch. Input uses a
serialized-byte bound, or the official token count plus a 25% input allowance
when the byte bound would stop a build. Known reported usage settles at the
published rate without a blanket surcharge; unknown usage retains its full
reservation. Missing cache details use the highest applicable input rate.

The original ledger added 25% to every settled call. That inflated accumulated
spend and stopped the last comparison unnecessarily. Version 2 requires an
explicit one-time conversion: run `scripts/scan-authoring-ledger.ts` with the
source and authorized total ceiling, review its totals and retained unknown
charges, then run `scripts/migrate-authoring-ledger.ts` with that exact source
hash and a new destination. The original file remains intact. Runtime runners
refuse legacy or internally inconsistent ledgers. New reservations carry the stable design-session identity. Per-trial limits
include every continuation with that identity, plus legacy runs recovered from
artifacts, persisted usage summaries and current authority. Choosing an older
resume directory or changing the global balance cannot reset that allowance. A ceiling in a file is an accounting guard, not authorization to
spend beyond the user's allocation.

Prices were verified against [OpenAI's published rate card](https://developers.openai.com/api/docs/pricing)
on September 22, 2026. GPT-5.6 Sol's currently published promotion is distinct
from GPT-6's standard rates. Persisted historical usage costs are unchanged;
comparisons should also reprice recorded token counts under one stated card.

Acceptance inspects first handoffs and independently exercises visible entry,
available identities, navigation, form usability, persistent state changes,
later visits, and relevant native export behavior. A peer verdict, successful
simulation, or passing CI alone does not establish a usable app. Report counts,
tool errors and recovery, redundant reads, context growth, cache/input/output
usage, cost, and concrete better/worse examples together. Keep untested native
device, deployment, and language-review boundaries explicit.
