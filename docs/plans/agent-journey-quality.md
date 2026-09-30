# Agent journey quality and review continuation

Status: reviewed and approved for implementation by the coordinating agent, 2026-09-29. User authorization covers implementation, independent review, PR preparation and bounded pre-deployment quality trials. Merge and deployment remain pending the final evidence report.

## Outcome and evidence

Make the shared authoring interface let an architect and independent peer observe the real worker journey, investigate consequential failures efficiently, and preserve honest unfinished work when a review reaches its bound. Evaluate the repaired interface with ordinary user requests before proposing any model/default change or deployment.

The frozen original study is `/Users/braxtonperry/work/personal/research/nova-sol61-quality-2026-09-29/`. Preserve its first deliveries and failures. Its candidate meals review spent 74 of 80 requests on single journey actions, while independent reads were already batched. The candidate's broad investigation was interrupted before its final assessment and both ordinary continuations refused before a provider call. The control used more total peer requests but returned findings between three reviews. This does not establish a model quality ceiling. Treat degraded outcomes as presumptive evidence to investigate the prompting/tooling fit, while measuring actual delivered behavior and model choices.

Three established problems remain in scope: excluded retained answers reaching ordinary Preview case writes; no journey worker-language selection; exhausted review continuation stuck on the same durable allowance. Further audited gaps are Results observations without rendered cells, missing route/selection context, a section-alias promise that the resolver cannot honor, unbounded full-history reads, and survey submission evidence whose boundary needs to be explicit. The timestamp parsing behavior matched native Core in executable checks: do not change the date parser in this work.

Implementation worktree: `/Users/braxtonperry/work/personal/code/commcare-nova-agent-quality`, branch `improve/agent-journey-quality`, based on `29294f6a`. The earlier trial checkout is retained and must not be edited. Target one cohesive Nova PR. A separate plugin companion PR is appropriate because it is another repository. No merge or deployment is authorized at this stage.

## Contracts that remain load-bearing

- Shared tools, authoring schemas and execution semantics serve architect, editor and MCP. No model-specific semantic branches and no privileged test-only shortcuts.
- Journey actions exercise saved app behavior with disposable Postgres records, saved identities and production navigation, engine and submission owners. No new report-storage product or substitute simulator.
- App revisions, Project membership, real actor authority, test creator, runtime version and expected step remain fenced. Evidence never silently becomes evidence for a later revision.
- Generated checkpoints are unfinished evidence, never completed review/approval or released app state. User continuation is distinct from automatic reconnect.
- Model calls, unknown charges and durable usage remain accounted once. A resumed allowance never erases earlier spend or provider starts.
- No incident-specific app checklists, required expert repair prompts, tiny artificial limits in quality trials, automatic unlimited review windows, or edits to production model defaults to run the evaluation.

## Unit 1: submission correctness and language semantics

### Participation and writes

Repair `FormEngine.computeSubmissionMutation` so ordinary custom-property writes consume the same participating-answer semantics as ordinary scalar destinations. Excluded retained answers are not saved values. Included hidden calculations remain valid writers. Preserve existing blank-preservation versus explicit-clear behavior and record preloads; do not make all blanks delete saved properties.

Use the captured earlier phone/email fixture as the regression counterexample. Exercise direct case writers, nested relevance and repeat contexts where relevant through production engine/submission code. Exact exported native forms remain an independent oracle. Keep the generated app unchanged during proof; a defensive new hidden field is not the product fix.

Owners: `lib/preview/engine/formEngine.ts`, its focused engine tests, existing Postgres case-submission acceptance, and the native proof fixture/runner when needed. Read `lib/preview/CLAUDE.md`, `lib/case-store/CLAUDE.md` and the relevant wire contract before edits.

### Worker language and runtime messages

Add a supported structured language selection to journey start and a language action. The initial default follows the same app-language selection owner as browser Preview. A later change follows the browser's real form re-entry/reinitialization behavior; do not invent a second answer-retention policy. Validate selection against the pinned app's languages. Return selected/effective language and fallback boundaries in each relevant observation.

Thread the selected language through form evaluation, submission reevaluation, menu/form/section names, choice/help text, Search and Results/Details projections. Use canonical Nova language identities such as `eng` and `spa`; no two-letter authoring aliases. Preserve authored fallback semantics and actual selected direction.

Introduce one small typed runtime-message catalog consumed by the engine/worker and core worker controls. Initial catalog support is English and Spanish, with explicit English fallback for other configured app languages. This is intentionally narrower than Nova's 57 automatic-translation languages and thousands of manually authorable languages. It does not translate the Builder or claim all configured languages have localized platform UI. Do not use live LLM translation for runtime strings.

Cover generic required/type/constraint fallback messages and the core journey controls (Back, Next, Submit, Clear, Continue and applicable Search/Results controls) consistently. Inventory the exact production owners before editing; keep diagnostics and authoring UI out of this worker-language scope. Replace engine comparisons against English error strings with stable message identity/semantics where needed. Preserve authored custom messages. If extending the small catalog would require unrelated UI localization, keep the precise remaining boundary visible rather than claiming full localization.

Owners: `lib/preview/engine/{engineInput,evaluateFormSnapshot,formEngine,formEvaluationTypes}.ts`, engine worker DTOs, app-test `types/context/run/submission`, production Preview projection owners, `components/preview` core controls, and `docs/architecture/multilingual-localization.md`. Read component/design contracts before changing copy or UI; inspect installed Next documentation for touched application APIs.

## Unit 2: worker-visible observations and address fidelity

### Results, routes and effects

Extract or reuse one production Results row/cell projection alongside the existing Details projector. Return ordered visible columns/cells with their actual labels, formats and values. Keep raw stored effects separately for data verification; a row's raw property bag is not what the worker saw. Include only concise current route, current destination identity and selected ancestor context, plus offered actions. Do not expose the whole navigation graph on every action.

Use the recorded meals History path to check that informational Details remain a dead end when the authored app makes them one. The tool must reveal the extra worker navigation, not repair it automatically. A selected parent for a child route and a leaf form's transient selected record must retain their distinct production lifetimes.

Submission observations receive an explicit evidence boundary: whether the production case transaction committed, its affected records/operations, and the separately unobserved native serialized payload/report-retention boundary. Do not fabricate survey report identities or serialized submissions from an empty case patch. Existing retained observations remain readable with their original runtime version.

Owners: `lib/preview/app-tests/{run,details,navigation,records,submission,types}.ts`, `lib/preview/columnDisplay.ts` and production Results projection/component owners, `components/builder/AppTestHistory.tsx` for rendering new evidence without raw implementation prose in the worker UI.

### Scoped aliases

The published `continueAppTest.action.sectionUuid` currently advertises a name/path but the generic resolver has no form scope because the invocation supplies only a test ID. Resolve state-dependent section addresses against the authorized pinned journey's current form at execution. The same mechanism must work after earlier actions in a batch. Do not resolve all future actions against the initial screen or widen names to unrelated forms.

Keep semantic validation at the public authoring boundary. Either defer the specific state-dependent address binding to the authorized journey owner, or introduce a supported scoped binder hook; do not special-case the name `needs` or instruct models to use only UUIDs. Exact receipt replay occurs after reauthorization but before rediscovering mutable execution context; request identity binds original authored input.

Owners: `lib/agent/authoring/{identitySchema,identityBindings,input}.ts`, shared app-test tool definitions and app-test execution. Test the served schema plus actual binder, not only the tool body's canonical UUID input.

## Unit 3: bounded sequential actions and evidence reads

### One list-taking journey operation

Extend the existing `continueAppTest` / `continue_app_test` operation to accept a bounded ordered list, with the singular action retained as a compatibility input to the same executor. New documentation teaches the list form even for one action. Do not add a parallel family of journey tools.

Initial hard bound: eight actions per call. Each item has an action and optional small expected-observation guard, limited to offered screen/destination and meaningful transition facts such as submission success. This is not an expression/assertion DSL, a selector language or a benchmark-specific coverage schema. Unknown newly created record identities still require observing a result before the model chooses the next action.

Run the list under the existing authorized app/test lock in one bounded transaction. Each action uses the production executor and its own savepoint. Persist every action, result and step. On an expected refusal, failed forward validation/submission, unavailable destination or unmet supplied observation guard, stop and commit the successful prefix plus the failed/unexpected observation. A completed submit followed by an unexpected next screen remains completed. Unexpected infrastructure failure/cancellation rolls back the enclosing transaction and is reported honestly; there are no external effects in the isolated namespace.

Introduce one durable request receipt for the entire list, binding authored input, expected starting step and ordered results. Retrying a completed request returns the exact result without replaying submissions, even after later steps or source changes, provided current authorization still permits reading the original receipt. Reusing a request identity with changed input refuses. The receipt and all prefix effects/step rows commit atomically. Keep session steps as individual worker actions so budgets cannot be bypassed through batching; the existing 200-action limit still applies. At the action limit, finish/release remains available.

A small `app_test_requests` receipt table is preferable to hiding a batch receipt inside one step or inventing request-ID suffix parsing. Existing single-action receipts remain readable/replayable; new writes use the shared receipt owner. Bump app-test runtime version once for the changed execution semantics, with old evidence readable and old active sessions requiring a fresh test as already documented.

### Bounded reads

Add a step window/cursor and bounded count to `readAppTest` / `read_app_test`. Return source/runtime identity, current test step, the initial supplied-state provenance and an explicit next cursor. Use a stable step upper bound for a paged read so concurrent appended observations do not change the evidence window halfway through reading. Existing omission still lists recent tests. Default detail reads are bounded; the Builder's history UI fetches the required page as its user moves through steps instead of loading the whole journey.

Bound response bytes as well as row count. Do not silently truncate a step observation: a large single step returns a precise readable refusal or narrower supported projection, not fake completeness. Preserve full persisted evidence; this is an access/projection bound. Decide the smallest practical byte bound using the existing recorded meals/park observations before freezing constants.

Owners: `lib/db/appTests.ts`, `lib/db/pg.ts`, additive migration, app-test service/types, shared tool schema, MCP adapter integration, `AppTestHistory` and public tool docs. No new API route is expected; if one becomes necessary, update hostname allowlists explicitly.

## Unit 4: honest bounded reviews and ordinary continuation

### One late notice and a closing reserve

Keep production peer's durable 80-provider-request allowance initially; test interface improvements before changing that default. Use one late notice at approximately 20% remaining (after 64 started requests for the current production allowance), and reserve the final two requests for closing an unfinished investigation. No initial countdown and no repeated 20/10/5/3/2/1 reminders.

Append a system/developer message after completed tool results at the conversation tail. Persist it with an idempotent key tied to the review allowance, so reconnect and compaction cannot duplicate it. Do not rewrite the initial prompt or existing prefix. The notice states the actual remaining allowance and preserves the quality standard; it must not urge approval or turn untested assumptions into passing evidence.

At the closing reserve, retain the fixed catalog/schema and disallow further tool selection for the closing request (the real provider adapter's tool-choice control), then request a concise unfinished checkpoint: what was observed, material concerns, and what remains. Do not churn the catalog or prompt prefix to force completion. Any output from this forced closing phase is classified by the orchestrator as unfinished, regardless of optimistic model wording; no parsing of words such as approved or incomplete. If no usable closing response arrives within the reserve, persist a deterministic checkpoint pointing to the actual retained evidence/context and mark the summary unavailable. A reviewer ignoring the notice still stops safely and can later continue. Never purchase an unbounded extra summary call beyond the durable allowance.

Normal peer completion before the forced closing phase retains the existing judgment contract: a review is an assessment, not proof or automatic approval. Do not introduce a per-finding disposition protocol or a model-owned exhaustive coverage counter. The forced checkpoint is a runtime outcome, not a new app domain state.

Make a small prose refinement to the architect/peer purpose where needed: distinguish the user's required outcomes from chosen implementation details and optional improvements; assess the worker's cost of extra screens and confirmations. Do not require new plan headings, hard plan-length limits, or an incident checklist. The plan remains an editable design document, not an exhaustive test program.

### Resume using a successor review, not a reset counter

Source digests include all user requests (`sources.ts`), so even ordinary “Please continue” changes source identity. Preserve the paused review and its allowance. A subsequent durable user turn creates one deterministic successor review, bound to the current source/app/plan revisions, with a predecessor link and the prior peer investigation. It can continue the still-current journey where the app/runtime permit, or inspect changed requirements and dependencies. Never inherit an old completed-review verdict for the new source.

Successor identity is derived from the paused review and the new durable user-turn identity, not HTTP request/run/holder IDs. Reconnect, duplicate POST, holder recovery or automatic retry cannot create another allowance. A new successor is admitted only when its predecessor is durably unfinished and a new authorized user turn exists. This is not an automatic chain of 80-request windows.

The original architect `reviewApp`/`reviewPlan` call can remain pending while review is paused. Upon successor completion, its exact tool-result receipt truthfully names the completed successor and its source/evidence; recovery must return those same bytes without a conflicting digest or duplicate result. The architect then processes the new user input normally. Planning ownership transfers transactionally from paused predecessor to successor; unrelated writes cannot acquire the plan in the gap.

Persist minimal additive review lineage/checkpoint fields, or a narrowly owned continuation table if required for immutable receipt identity. Fields must distinguish paused, superseded and completed evidence without setting `completed_revision` on an unfinished review. `latestPlanReview` must only accept actual completed reviews at the required current source/app revision. The existing review ID remains the budget provenance for each review, including its preserved predecessor starts.

Handle existing exhausted active reviews without rewriting counters or past events: under current authority, detect exhausted legacy allowance and durably classify the old review as unfinished with its retained context. An ordinary new user turn may then admit the deterministic successor. Identify the original issuing user-turn provenance from the durable architect call/model-step evidence; do not infer it from wall time or current run ID. If legacy provenance cannot be established, fail explicitly and preserve evidence; provide a read-only scan and separately authorized repair path rather than silently minting allowance. No blanket repair of production history runs during this work.

### Product and transport behavior

Surface this as an unfinished build/review with a clear ordinary Continue path and retained work, not `error/internal` or a successful app delivery. Keep the initial-build editing/release gate intact until the required review actually completes. Use the existing awaiting-input/continuation mechanisms where their semantics fit, with an explicit bounded-work reason/checkpoint projection; amend orchestration state and progress/UI contracts if a distinct state is required. Chat streaming, reconnect, replay, run settlement and credit release must all agree on this outcome. No extra permission flow for a user who already asked to continue.

Owners: `lib/agent/build/{architectLoop,modelContextStore,orchestrator,orchestratorState,orchestrationKinds,progress}.ts`, `lib/agent/planning/store.ts`, database types/migration, chat build-route/run finalization owners, progress/continuation UI, recorded-run anatomy, and the nearest contracts. Keep translator structured-output behavior unchanged unless a shared loop return type requires a mechanical adaptation. Ordinary editor limits are not a new tuning target in this unit.

## Unit 5: clean evaluation controls

Extend `scripts/evaluate-architect.ts` and the existing editor evaluator with explicit local-only configuration for all five semantic roles (architect, peer, editor, extractor, translator), model IDs/efforts, and review policy. Read standard role defaults unless a trial config is supplied. Pass overrides through existing dependency injection/local evaluator owners rather than editing `lib/models.ts` or shipping environment-driven production model switching.

Prefer the smallest honest boundary. If covering every role would require an invasive production override facility, use a separate evaluation worktree with an explicit captured model-config patch over the exact frozen runtime SHA, restore it between configurations and never include candidate defaults in the product PR. Verify all five actual wire model/effort selections; a declared config alone is not evidence. Do not add ambient/AsyncLocalStorage production configurability for this experiment.

Support two recorded policies: production (one late notice and reserve) and diagnostic (no reminders, generous role allowances under the same hard external spend/time/request ceilings). Artificially tiny allowances are for scripted mechanical tests only. Diagnostic allowances must be finite and recorded; no hidden retries or discounted pricing assumptions. Capture model, effort, policy, source hashes, code SHA, original task/criteria, per-request usage, complete credential-free requests/results and available reasoning summaries. Preserve `store:false`, standard pricing, cumulative/unknown-charge reservations and the local loopback DB guard.

Make evaluator time limit an explicit bounded option sufficient for this study (up to the previously used 90 minutes), retaining active cancellation/cleanup. Port only the necessary validated editor-resume support from the old trial patch. Dry runs must prove overrides/configuration and evidence setup without a model call. Resume binds the prior trial/code/config ledger and never silently substitutes a different model or policy.

The previous harness did not establish the complete browser chat-thread lifecycle: evaluator-created editor fixtures showed stale-marker/undefined-message regenerate errors even when Preview worked. Where small, initialize/persist the real thread/transcript through existing owners so fixtures represent ordinary entry. Otherwise label that trial boundary explicitly. Production `/api/chat`, stream reconnect and the actual continuation UI need independent controlled-provider browser acceptance. Do not manually force app status or infer hosted loading-screen behavior from an incomplete evaluator transcript.

The root agent owns paid execution and independent browser/native acceptance. Production role defaults remain unchanged pending separate evidence and approval.

## Tests and acceptance gates

Read `docs/testing.md`; test production boundaries, not a copied result schema or helper output. Keep pure projection checks out of Postgres fixtures, and own every worker/stream/client lifetime.

1. **Write participation:** admitted phone/email fixture through FormEngine and real Postgres; switch both directions, nested exclusion, included hidden calculations and explicit blank/preload behavior. Execute the exact export in native Core for independent final omission effects. No expert app repair.
2. **Language/observations:** production engine worker and browser Preview for `eng`/`spa`, generic required/integer errors, authored custom errors, section/control labels, changing language and answer retention, unsupported runtime-catalog fallback. Compare Results/Details cells and route selections with ordinary browser observations on the same saved fixture.
3. **Public alias contract:** real authoring harness/served schema using current section name, full path, stable ID, ambiguous names and wrong-form reference. Repeat with earlier batch navigation changing the current form. MCP transport uses the real SDK client/server path.
4. **Sequential actions:** same admitted journey through singular and list forms, asserting identical intermediate transitions and final stored effects. Real Postgres proves successful prefix on failed validation, unexpected guard after submission, wrong expected step, competing clients, replay after later steps/source changes, changed receipt input, rollback on infrastructure failure, finish and membership revocation. Use controlled blockers rather than sleeps.
5. **Evidence pagination:** reconstructed bounded pages equal the retained ordered evidence, with stable upper bounds during concurrent continuation, Unicode/byte limits, earlier runtime observations and stale/revoked scope. Browser history navigation fetches pages and distinguishes earlier revisions.
6. **Review lifecycle:** actual SDK against controlled local Responses peer plus migrated Postgres. Low scripted limits exercise exactly one notice, tail placement after tool results, forced reserve, ignored notice, no summary fallback, usage accounting, reconnect/duplicate POST, lost holder, successor admission only on new user turn, changed source/app, legacy exhausted review, pending original tool receipt, and no premature app completion. Test notice behavior rather than pinning prose or tool counts.
7. **Evaluator:** dry run and controlled transport verify every role/config override, diagnostic versus production policy, standard charge calculation, cumulative resume and unknown-charge refusal, no accidental default changes.
8. **Repository checks:** relevant focused unit/Postgres/native/browser acceptance, typecheck/lint/format, then required CI on frozen SHA. A fresh independent `$review-agent` reviews the full implementation; fix findings and rerun affected checks before paid quality claims. Never run the live schema acceptance command merely as a substitute for controlled schema/transport tests.

## Paid trial budget and sequence

Total user authorization: $75 inclusive of prior spend $11.481512075. Remaining ceiling: $63.518487925. The existing shared ledger, conservative dispatch reservations and unknown-charge accounting are the authority. No run is started unless its reserved ceiling fits the remaining budget.

Proposed allocation, subject to live ledger review before each run:

| Stage | Maximum allocation | Purpose |
| --- | ---: | --- |
| Repaired-code paired meals, park and small edit | $20 | Same frozen code, original immutable requests and criteria; compare current roles with all-role Sol 6.1 xhigh using diagnostic policy |
| Fresh held-out workflow pair | $14 | Check transfer beyond the known incidents with ordinary intent and frozen independent acceptance |
| Production-policy confirmation | $10 | Exercise the actual late-notice policy on the most demanding useful workflow(s), including ordinary continuation if naturally reached |
| Iteration/retest reserve | $19.518487925 | Only discriminating follow-ups after a concrete finding; retain every first failure |

The first stage is six new trials, with the editor using the same authorized setup and ordinary request. Run demanding meals early so a lifecycle/tool defect is caught before spending on broader comparison. Diagnostic trials use generous role allowance and hard external bounds to isolate capability/interface fit from policy pressure. Production-policy runs are separately labeled. If costs exceed estimates, preserve the required matched core pair and actual production-policy validation; explicitly reduce optional held-out breadth rather than exceeding the total or concealing a missing test.

The root has frozen the held-out request and independent acceptance before implementation. The implementer will not receive or search for its content before code freeze. Known park/meals/editor requests are regression benchmarks, not held-out quality evidence.

Independent acceptance checks ordinary browser entry/navigation, saved worker identity and language, actual Postgres effects and retained history, and native export boundaries where relevant. A clean peer review, `evaluateForm`, successful save or native-only result does not establish a delivered Nova app. Report code/model/policy separately, actual coverage and uncertainty, round trips, time and standard cost. Do not rank a censored failed run as more efficient.

Track worker-action count separately from provider requests. Batching must not hide a displaced bottleneck at the existing 200-action journey limit. Exercise the complete useful journey without skipped screens or actions; if a logically independent new test is needed, state why and preserve the earlier evidence. Do not silently raise that bound as part of batching.

After all implementation/review/test iteration and the next complete quality runs, perform another full-context audit: original requests, plans, prompt/schema discovery, actual tool inputs/results, all available reasoning summaries, corrections, final artifacts and failures. A fresh external audit should challenge our tooling explanation and model interpretation. Report any further limitations before proposing defaults or deployment.

## Docs, migration and PR delivery

Update public docs (`content/docs/mcp/tools.mdx`, building/testing and language/identity docs), `lib/preview/app-tests/CLAUDE.md`, `lib/agent/CLAUDE.md`, authoring/planning contracts, architecture agent-authoring/multilingual contracts and testing evidence descriptions. Update design documentation only for visible continuation/history/language behavior that changes. Keep original research evidence private and link it with full paths in handoff.

Use additive Kysely migration(s) for whole-request journey receipts and minimal review lineage/checkpoint persistence. Test from the previous migration prefix. Existing evidence remains immutable/readable. Any exceptional historical-data repair requires scan-then-migrate scripts and is not run on production in this task. Remove this completed plan in the shipping PR, preserving enduring contracts in architecture/subtree docs.

Plugin companion updates should teach the same ordered action contract, language selection, bounded evidence reads and evidence boundaries in `skills/build`, `skills/edit`, and autonomous architect guidance; update source-contract tests if present. No duplicated implementation or separate plugin-only tool semantics.

Prepare one Nova PR with concrete behavior, exact validation, honest paid results and remaining boundaries. If an inseparable migration/size concern makes stacking materially safer, use the smallest logical GitHub-native stack after coordinating review. Keep all PRs unmerged and do not deploy. The root agent will review this plan before implementation and coordinate independent code review, paid evaluation and final user report.

## Coordinating review and amendments

The overall design is approved. Keep this as one coherent Nova change, with a narrowly linked plugin documentation release in its separate repository. The implementer owns product and harness edits; the coordinator owns paid calls and independent acceptance. The following amendments are binding:

1. **Continuation is a product contract, not a counter escape.** A checkpoint must never satisfy completed-review admission. A genuine new durable user message is the authority for a successor; reconnect and holder replacement are not. The new source and current app/plan bind that successor. Replay the original pending call truthfully and exactly once. Prove these invariants through the production orchestrator and chat boundary before live trials.
2. **Keep history repair separate.** Derive well-formed historical issuing-turn provenance from immutable recorded evidence. Unresolvable malformed history may refuse with a precise diagnostic; do not build a speculative repair framework or mutate historical records merely to make this PR comprehensive. Add scan/migrate tooling only for a demonstrated affected persisted state, and do not run production repair in this task.
3. **Preserve first-delivery quality as the objective.** The late notice is one experimental production policy, not a reason to remove expected checks or claim success. Keep original no-reminder failed trials unchanged. Diagnostic runs retain finite external safeguards, and forced small-limit tests establish lifecycle mechanics only.
4. **Batch expectations stay small and optional.** They guard ordinary observed transitions; they must not become a second validation system. Success-prefix effects and exact response-loss replay are mandatory. Retain individual worker action accounting, and stop before an unchosen branch. Eight actions is the initial maximum. The existing singular input may remain on this same operation for callers; there is no second singular tool or temporary multi-PR protocol.
5. **Bound evidence without destroying access.** Measure retained observations before choosing limits. Paging must preserve source/start provenance and make it possible to inspect the action that caused a failure. Avoid introducing an arbitrary byte refusal that makes a valid saved journey impossible to review; if a single step exceeds the normal page budget, design and prove an explicit bounded way to inspect that evidence rather than silently dropping it.
6. **Localize the worker surface honestly.** Use the existing structured language identity and authored localization owners. The initial platform catalog is explicitly eng/spa with English fallback elsewhere; that limitation is visible in observations and documentation. Generic validation and essential worker controls are in scope, the entire Builder is not. No wire vocabulary crosses into authoring, no live runtime translation, and no universal-localization claim.
7. **Do not repair native date semantics opportunistically.** Keep the independently confirmed Core-compatible parser unchanged. Any expression guidance states the actual distinction; no timestamp-specific workaround is injected into ordinary prompts.
8. **Keep evaluation configuration narrow.** Prefer existing injection. If five-role overrides require invasive production plumbing, use a separately captured evaluator worktree/config patch. Production model defaults must remain unchanged. No paid provider schema test is necessary; root will authorize and execute only the frozen quality matrix within the cumulative ledger.

Before implementation is declared complete, provide exact changed-file scope, migration implications, all validation outcomes and limitations, a frozen review target, and any unresolved acceptance item. The root will spawn the requested independent review-agent, address its findings with the implementer, and then run the paid comparison. Do not merge or deploy.

## Recorded design choices

- Approve eight-action initial batch bound and small transition-expectation schema; tune only from measured response/transaction size, not arbitrary tool-count goals.
- Approve explicit `eng`/`spa` runtime catalog with honest fallback, while all existing authored-language support remains available.
- Approve successor-review lineage on a new durable user turn, with no counter resets and unchanged production 80-request peer allowance initially.
- Approve one 20%-remaining notice plus two reserved closing requests, and separate diagnostic no-reminder policy for model-quality investigation.
- Review the additive persistence shape during implementation design: keep original pending-call receipts and source binding exact; do not trade correctness for avoiding a small migration.
- Confirm the proposed paid allocation/ordering against the live ledger before execution; root owns all paid calls and can amend optional breadth within the cumulative ceiling.
