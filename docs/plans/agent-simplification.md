# Agent simplification

Approved implementation scope: preserve thoughtful design and creative peer review,
replace the structured design protocol with a durable Markdown plan, and give one
lead architect a coherent authoring interface and useful runtime feedback.
The target is better apps through fewer unnecessary decisions and translations.
Token size is evidence of the result, not a substitute for quality.

## Shared authoring and feedback

- Make record creation names ordinary authored values or expressions. Shared code
  owns standard destinations, declarations, and writers, including advanced create
  operations. Read/edit round trips preserve existing canonical semantics.
- Consolidate expression signatures, scope availability, reference binding and
  documentation. Shared operations have consistent meanings; missing/empty is
  blank, zero/false/whitespace is not. Reuse existing grammars and runtime owners.
- Derive visible navigation outcomes through the same domain rules as Preview and
  export. Preserve context-dependent outcomes and refuse unsupported routes.
- Audit the complete shared tool surface, guides, results and resumed context.
  Remove duplicate configuration/protocol obligations and repeated prose without
  dropping advanced capabilities. Carry changes through editor, MCP and plugin.
- Supply non-writing workflow evaluation using production FormEngine/submission
  projection and authorized record context. Report observations and proposed
  effects distinctly; never silently create sample rows.
- Keep /agents honest about current vs recorded composition, estimates vs usage,
  complete catalog vs loaded definitions, and each role's actual messages.

## Markdown planning and unified execution

- One lead architect owns planning and construction with phase-appropriate tools.
  New apps receive substantive planning and an independent peer review first.
  Small edits remain direct; substantial redesign may use planning.
- One revisioned Markdown document holds the design. Read, write and exact-text
  edits use server-owned revisions, attribution, authorization and idempotency.
  Do not parse document headings/checklists into a replacement design schema.
- Peer review edits the same plan while the lead is paused and explains material
  choices or unresolved concerns in prose. Review improves the app; code checks
  mechanical facts. Further review follows consequential uncertainty, not edits.
- Preserve requests and attachments independently of the plan. Resolve delegated
  choices without routine user approval gates. Honor explicit planning-only intent.
- Reuse the private workspace and canonical commit kernel. Session ownership,
  plan revision, workspace identity and canonical base replace plan/slice lineage.
  Preserve atomic publication, concurrency, cancellation, exact receipts and usage.
- The first valid meaningful workflow creates the app; later coherent checkpoints
  extend it. Recovery loads source, current plan/app and outstanding private work.
- Project-table transactions remain separate, authorized construction operations.
  Preserve lookup revisions, quotas and dependency protection without a design
  graph. Planning is read-only; translation/setup use current app state.
- Completion combines code-owned validity with fresh source/plan/actual-app review
  and observations. Feedback stays concise; model claims are not mechanical proof.
- Remove the structured design contract/graph, finding dispositions, compiled
  workflow plan, slice permissions, executor handoff and conformance bindings,
  including tests/docs that serve only those removed contracts.

## Evidence and migration

Use behavioral tests for authoring round trips, expression/runtime semantics,
navigation, real Postgres lifecycle/recovery/authorization/accounting, and browser
flows. Never pin prompt text, symbol existence, or obsolete implementation shape.

Evaluate fresh tool-library, related-record follow-up, branching/repeated-form,
lookup/search and multilingual-refinement tasks; at least two requests must not
shape implementation. Inspect actual app/browser/storage results independently
against source, including recorded reasoning, messages, failures and corrections.
Keep failures; make only claims supported by the evidence, including the limits
of browser/export evidence for native offline devices. Paid calls remain bounded
within the existing cumulative $200 authorization; start with controlled local
checks and do not rerun baselines without a concrete need.

Ship a read-only scan and separate one-time migration. Drain old writers and settle
usage; preserve apps, case data, Project resources, threads and billing. Convert
useful old designs to historical Markdown once, retire obsolete private execution,
and resume incomplete work from source plus the actual app. No runtime compatibility
readers or obsolete active protocols. Update architecture/subtree/public docs and
plugin; remove this completed plan from the final shipping change.

## Delivery

Two substantial PRs: shared authoring/feedback, then Markdown planning/unified
execution and migration. Each receives a fresh code-review subagent and green CI;
use the existing native GitHub stack for dependencies. No merge is authorized.
Preserve current model selections initially. Do not revive the old implementation
review units or introduce a second app model, workflow framework, proof protocol,
or compulsory microtask schedule while replacing them.

Implementation base: 171b8dc5675980e73a53e32f008152056b73b0c7 (PR #615).
