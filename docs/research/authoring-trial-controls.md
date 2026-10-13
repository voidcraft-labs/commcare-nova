# Local authoring trial controls

`scripts/evaluate-architect.ts` and `scripts/evaluate-editor.ts` run bounded,
synthetic trials through the production authoring owners. They require a loopback
database and a shared version-2 spend ledger. `--confirm-paid` authorizes provider
requests; `--dry-run` makes none. The editor dry run creates its isolated fixture.

Freeze and commit the implementation before a paid comparison. Both conditions
use that commit. If different models are needed, use a separate evaluation
worktree and capture an explicit `lib/models.ts` role-configuration patch there.
Production defaults do not change. Paid runs refuse other uncommitted changes or
untracked files; ignored private evidence is kept outside the product diff.

`--trial-config <file>` reads this configuration:

```json
{
  "expectedModels": {
    "architect": { "modelId": "gpt-6-sol", "reasoningEffort": "medium" },
    "peer": { "modelId": "gpt-6-sol", "reasoningEffort": "medium" },
    "followUpEditor": { "modelId": "gpt-6-luna", "reasoningEffort": "xhigh" },
    "documentExtractor": { "modelId": "gpt-6-sol", "reasoningEffort": "medium" },
    "translator": { "modelId": "gpt-6-sol", "reasoningEffort": "medium" }
  },
  "timeoutMinutes": 90,
  "maxRequests": 400,
  "reviewPolicy": { "kind": "production" }
}
```

The role declaration verifies the installed configuration; it does not override
it. The captured outbound request must match its semantic role's model and
reasoning effort, use Standard processing, and keep `store: false`. Every role
must have a known rate card before a run starts. Actual role coverage is measured
from captured requests; merely declaring an extractor or translator does not
prove the trial exercised it.

Without a configuration file, the existing defaults apply: 30 minutes and 400
requests for an architect trial, 15 minutes and 80 requests for an edit. The
maximum configurable wall time is 90 minutes. The editor retains its production
80-step limit even if a larger external request bound is declared. Cancellation
joins the transport and releases local resources.

Architect diagnostics may use `{"kind":"diagnostic","maxPeerRequests":320,"maxArchitectRequests":400}`
to omit review reminders under a larger finite review allowance. Record those
runs separately from production-policy confirmation. Reduced limits in scripted
tests establish lifecycle mechanics and are not model-quality evidence. The
external request, time and spend bounds still apply to either policy.

The shared ledger holds conservative pre-dispatch reservations, including calls
whose charge is unknown. A new process or continuation cannot erase earlier
spend. Architect trials have a cumulative $30 ceiling; editor trials have $5.
Neither allowance expands the shared authorization. Keep every failed first run.

`trial-config.json` records the code commit, complete tracked patch, five roles,
policy, bounds and ledger path. Resume requires the same identity and original
request. The editor's `--resume` and `--answers` continue a saved ordinary
question using its original thread and server-issued tool-call identity; changed
app revisions refuse. Architect continuations may add ordinary user feedback or
answer the pending question. There is no expert repair hidden in the evaluator.
Architect resume requires the original durable pending input round and exact
holder; admission checks and consumption commit with the new claim and accepted
transcript. Pause publication uses the same atomic pause writer as the chat route,
including the orchestration checkpoint and server-owned invitation.

Repeatable `--library-document <file>` arguments install unprepared text assets
in the isolated Project library without adding message attachments. Discovery and
preparation run through the production source tools and the trial's captured,
budgeted extractor. `library-fixtures.json` retains the source bytes and hashes;
`library-assets.json` maps them to asset identities, and `result.json` includes
the final selected-source collection. A resume reuses that library and refuses
new library fixture arguments.

The harness persists real user messages and folds actual SDK output through the
ordinary thread writer, retiring the terminal stream marker so a completed
fixture can be opened in the Builder. A paused architect response retains its
holder nonce so a reloaded thread can answer a question or continue its review.
This establishes the saved transcript and
fixture entry and shared continuation transaction only. It does not exercise
`/api/chat`, network reconnect, browser streaming, or the SDK's automatic send
loop. Those need separate production-boundary
acceptance, followed by ordinary browser, Postgres and exact native-export checks
of the delivered app.
