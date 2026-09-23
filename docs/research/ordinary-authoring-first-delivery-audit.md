# First-delivery authoring audit

Baseline: Nova `c3ae84b6`, September 22, 2026. The active work is in
[ordinary-authoring-quality.md](../plans/ordinary-authoring-quality.md).
Earlier results belong to their measured revisions, recorded in
[ordinary-authoring-evaluation.md](ordinary-authoring-evaluation.md).
Private source material and transcripts are not part of this document.

## What the traces establish

Four requests entered the initial architect/peer process. The development lending
and workshop requests completed, the latter after same-input recovery. Both
role-gated requests failed; the later request never produced a saved app. The
long delivered-app repair was ordinary editor work with repeated external
direction. It cannot establish first-delivery quality.

The architect and peer have the request, a shared current-design plan, scoped
app reads and focused authoring guides. After the first save they can exercise
isolated journeys through production navigation, identity, FormEngine and
submission transactions. The peer retains its own history across corrections;
it does not inherit the architect's private reasoning. Ordinary editing has no
independent peer. These facts come from `lib/agent/build/authoringTools.ts`,
`build/orchestrator.ts`, `prompts.ts` and `solutionsArchitect.ts`.

| Observation | Evidence and cause | Consequence for the change |
| --- | --- | --- |
| A parent update became duplicated latest-event fields. | In the later role trial, the architect called an operation with `via(ancestor('parent'), #case/case_id)`. Authoring refused the identity property. It tried a relationship as a scalar, looked up an invented identity function, read workflow guidance, tried a raw session path and searched the app. The reasoning then explicitly redesigned the workflow around latest-event summaries. `authoring/bindings.ts::reference` admits only the effective property catalog, which excluded `case_id`, although the form-reference, SQL and wire readers already support it. | This is an inaccessible capability, not just model judgment. Admit the existing read-only identity consistently and document relationship targeting. Prove the authored call through a real transaction and exported native execution. |
| Ownership assignment targeted a registration's nonexistent selected record. | Both role trials used an operation's session target on registration. The later trial's staged diagnostics carried a fingerprint until `saveWork` exposed `CASE_OPERATION_SESSION_UNAVAILABLE`. The workflow guide already explains a survey plus explicit creation for independent ownership; the target schema had only the discriminator, without its selection requirement. | State the target's actual precondition at the argument. Encourage consulting domain guidance before building around uncertain behavior; do not add a new ownership mechanism or accept a meaningless target. |
| Form and record expressions were confused. | Calls tried `session()` in form calculations and relational `exists()` in form validation. Other calls guessed unsupported datetime and identity functions. The current guides already distinguish worker identity scopes, but relationship-function prose did not explicitly say it was record-only. | Make that scope explicit where those functions are documented. Retain runtime rejection; accepting a guessed expression would conceal the error. |
| Review found real related-record defects but did not establish completion. | The earlier role peer exercised journeys and found wrong links, sharing and selection problems. The run stopped before final review; independent execution still found an excluded initial business status. The later role peer improved history decisions during design, but no saved-app review could run. | Retain these failures. No observation justifies claiming that a successful review or the repaired app proves first-build quality. |
| A current summary was mistaken for sufficient history. | External delivered-app requests had to require separately retained receipts and then usable grower/contract selection. The editor made changes but the user supplied the missing design judgment. The later role architect's redesign similarly weakened retained review history after reference failures. | Have review derive required outcomes from the request independently and inspect subsequent occurrences when history matters. Fix the capability gap that induced the workaround, rather than prescribing one app's record layout. |
| Repair accumulated internal recovery and mistaken references. | The final repair conversation included misspelled field/form identities, exhausted active-test capacity, stale test steps and tool discovery failures after compaction. Schemas already accept entity names. Some failures were legitimate concurrency/admission boundaries; others were model input errors. The eight-call synthetic probe did not reproduce the production discovery problem. | Classify the actual error and observation available before changing prompts. Preserve native model-context evidence and do not claim the SDK update or a successful small probe fixed compaction. |
| Earlier false-positive review findings concerned absent explicit defaults and operations. | The original handoff records these findings. Current scoped reads expose effective preloads and ordinary writes, and the peer prompt tells it to inspect them. This was already addressed in the shipped foundation. | Verify use in new trials; do not duplicate the correction as another checklist. |
| Private edit history made first save impossible. | The later role run retried first save after identity recreation, then asked the user to resolve an internal workspace problem. Current private admission checks the pending batch against its base; the correction is documented in `ordinary-authoring-observations.md`. | Keep the trial failed while checking the current contract locally. Do not demand operator rescue during acceptance. |

Tool-result counting must distinguish rejected calls from successful private
staging (`ok: true, saved: false`) and no-op saves (`changes: 0`). A raw search
for `saved: false` materially overstates errors. Error counts alone also miss
valid calls that produce a poor workflow.

## Domain boundary of the identity correction

`case_id` is already a stable scalar in Nova's case store and a supported form
reference. `lib/commcare/casePropertyWire.ts` emits it as the case attribute, and
`predicate/termEmitter.ts` composes that leaf through relationships. Core's
`CaseInstanceTreeElement::CASE_ID_EXPR` and `Case::INDEX_CASE_ID` provide the
native identity read. HQ's `CaseDBXMLGenerator.get_root_element` and case-search
metadata use the same attribute; Nova's HQ detail emission uses that mapping.
The correction makes this existing reading available in the effective catalog,
not a new persisted field. Existing write guards continue to prohibit changing
record identity as an ordinary answer or operation property.

Controlled evidence: the shared authoring journey selects a child from app entry,
submits its form through production Preview and Postgres, and verifies the parent
receives that child's identity. Removing only the catalog admission makes this
test fail with the original unknown-property error. The native nested-selection
fixture updates a parent through that relationship and retains unrelated values;
Core executes both local and HQ-regenerated exports successfully. HQ regeneration
uses the real local HQ classes with network access refused. Typechecking and the
focused read/schema, effective-catalog and wire suites pass. These are contract
checks, not a fresh agent-quality result or physical-device acceptance.

Closure, ownership, event history and modifier semantics remain as established
in [record-lifecycle-authoring.md](record-lifecycle-authoring.md). In particular,
business completion does not automatically mean closing the CommCare case and
removing it from ordinary future sync.

## Evaluation decision

Improve the demonstrated interface gap and review judgment before fresh trials.
Answer ordinary design questions from a frozen domain brief; do not supply
expressions, debug procedures or corrective post-delivery edit prompts. Inspect
the first output independently from app entry and retain failures with causes.
Use a shared $100 ceiling for all new calls, including extraction, translation,
development retries and GPT-6 comparison. Compare each role, retaining extracted
documents and the resulting app outputs so changes in interpretation are visible.

## September 22 first-delivery trial

A newly frozen role-gated request ran at `a7d95b64` without operator feedback.
It failed at the production architect allowance: 120 architect calls and 37
peer calls, 161 tool calls, $6.5519418 measured model cost. No completed first
handoff exists. The saved intermediate app is diagnostic evidence only.

The peer independently reproduced a registration failure on an unanswered date
and a submission that made a related record's balance negative, and identified
an ownership default inconsistent with cross-role sharing. The architect began
corrections without external directions. This is evidence that the peer can find
consequential issues through ordinary tools, but the run did not converge.

Form ancestor reads were an avoidable source of failed guesses and retesting.
The guide explained `via(ancestor(...), ...)` for record expressions without
explaining the form's existing `#<record-type>/<property>` reference. A rejected
parent reference suggested a form field, after which the architect tried raw
instance paths. `reachableCaseTypes`, `formOpensWithOneCase`, typed reference
emission and Preview already supported the intended reading. Scoped form reads
now expose that available context; the shared schema and guide explain it, and
the unresolved-reference diagnostic includes the correct alternative.

A controlled test takes the reference returned by the ordinary shared tool,
authors it into a validation and identity calculation, then runs production
FormEngine against linked records. It distinguishes the actual parent from an
unrelated record and checks accepted/rejected answers. Registration, survey and
multiple-selection reads expose no scalar record context. Existing native typed
ancestor emission is unchanged. The architect allowance increases to 180 calls
so focused corrections and verification have room to finish; a larger allowance
is capacity, not evidence of better judgment or first-delivery success.

## Completed build with unusable saved location context

A subsequent role-based build completed but failed first-delivery acceptance.
The peer identified missing saved place assignments twice. The architect tested
with disposable places, then incorrectly concluded ordinary place creation was
unavailable and revised the plan around that limitation. Captured provider
requests show the creation tool was absent before birth and present afterward;
the architect never searched for it after saving. This was a discovery/phase
boundary plus a judgment failure, not an unavailable production capability.

The construction catalog now retains those definitions from the start of building.
Invocations requiring a saved app refuse before side effects and explain the
prerequisite. A real Postgres check exercises early refusal, creation after birth,
and saved persona assignment through the same authoring session. A new first
delivery trial remains necessary; correcting the interface does not repair or
retroactively pass the failed run.
