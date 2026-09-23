# First-delivery model comparison

Status: preparation and controlled checks; model trials and acceptance remain unfinished.

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

The runner allows 400 transport requests and 30 minutes per invocation, with a
$30 trial ceiling carried across clarification resumes. A shared locked ledger
enforces the separately authorized combined ceiling before dispatch, including
retries and uncertain charges. Explicit production output ceilings pass through;
otherwise the runner allows 128,000 output tokens, including reasoning. The
reservation uses the serialized output ceiling, conservative input allowances,
and a rate above the current compared models. Known usage settles with a 25%
margin; unknown usage retains its reservation. Report model cost separately
from this conservative budget ledger.

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
