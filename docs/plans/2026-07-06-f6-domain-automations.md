# Plan: F6 — Domain automations: case rules & conditional alerts

*Planning pass, 2026-07-06. Seeded by `docs/research/feature-map.md` §F6; anchors: ACA H9
(the vacuous-success argument), §2.4 (the nightly claim sweep), §3-P2 (message delivery),
LOC L6 (the API gap). Platform facts re-verified 2026-07-06 against `~/code/commcare-hq`
(@4e3052a8). Consumes F2 (user-data filter vocabulary), F3 (location recipients + the
setup-artifact family), F4 (the patterns that imply automations).*

**What ships.** **Automations as blueprint objects** — case sweeps (update/close rules) and
alerts (scheduled messages) modeled in Nova's vocabulary, validated against the catalog, and
constrained by a *representability* checker to exactly what HQ's rule engine can express —
emitted today as the third family of the **HQ setup artifact** (joining F2's user schema and
F3's org model), behind a push port that swaps in an API client the day one exists. The SA
designs them whenever a pattern implies them, so Nova stops shipping architectures whose
critical halves nobody provisions (H9's whole point).

---

## 1. Verified platform facts + lifecycle citations

| # | Fact | Citation | Verdict |
|---|---|---|---|
| 1 | Rules and conditional alerts are **one model**: `AutomaticUpdateRule` with `workflow ∈ {CASE_UPDATE, SCHEDULING, DEDUPLICATE}` — an alert is the SCHEDULING arm with a `CreateScheduleInstanceActionDefinition` action; the criteria engine is shared. | `commcare-hq/corehq/apps/data_interfaces/models.py::AutomaticUpdateRule` | Alive. |
| 2 | Criteria vocabulary (closed): `MatchPropertyDefinition` with nine match types — `EQUAL`, `NOT_EQUAL`, `HAS_VALUE`, `HAS_NO_VALUE`, `REGEX`, and four date-offset comparisons (`DAYS_BEFORE`/`DAYS_LTE`/`DAYS_GT`/`DAYS` vs `case_date + N`) — plus `ClosedParentDefinition`, `LocationFilterDefinition` (owner's location ± children), `UCRFilterDefinition`, and code-registered customs. `criteria_operator ∈ {ALL, ANY}`; `filter_on_server_modified` + `server_modified_boundary` add an implicit server-modified-age criterion; closed cases skipped. | `models.py::MatchPropertyDefinition/ClosedParentDefinition/LocationFilterDefinition`; `::AutomaticUpdateRule.criteria_match` | Alive. The representability target (§2). |
| 3 | Action vocabulary (closed, for CASE_UPDATE): `UpdateCaseDefinition` — set properties to a **literal or another case property's value** (incl. `parent/`/`host/`-prefixed ancestor writes) and/or `close_case` — plus code-registered customs. | `models.py::UpdateCaseDefinition/BaseUpdateCaseDefinition._add_update_property` | Alive. |
| 4 | Execution: hourly task, each domain processed **once daily** at its `auto_case_update_hour` (default midnight UTC); an on-save path exists behind the `RUN_AUTO_CASE_UPDATES_ON_SAVE` toggle. **Cap resolved (closes ACA §7.2): `MAX_RULE_UPDATES_IN_ONE_RUN = 10000` per (domain, case_type, db-partition) run**, per-domain overridable (`Domain.auto_case_update_limit`); on hitting it the run **halts with a notification** and re-sweeps next day. The public "50,000/day" figure is the unrelated **outbound-SMS daily limit** (`Domain.get_daily_outbound_sms_limit`). | `data_interfaces/tasks.py::run_case_update_rules`; `utils.py::iter_cases_and_run_rules`; `settings.py::MAX_RULE_UPDATES_IN_ONE_RUN/RULE_UPDATE_HOUR`; `domain/models.py` | Alive. Docs carry the corrected numbers. |
| 5 | Alert schedules: `AlertSchedule` (relative offsets, fires once per match) vs `TimedSchedule` (`repeat_every`, `total_iterations` incl. indefinite, daily/weekly/monthly/custom, specific/random/case-property times); triggers support `reset_case_property_name`, `start_date_case_property`, `stop_date_case_property_name`. | `messaging/scheduling/models/alert_schedule.py`/`timed_schedule.py`/`abstract.py` | Alive. |
| 6 | Recipient vocabulary (closed): generic (`Location`, `Group`, users, case group) + case-relative (`Self`, **`Owner`**, `LastSubmittingUser`, `ParentCase`, `AllChildCases`, `CasePropertyUsername`/`UserId`/**`Email`**) + **code-registered customs** including the four parent-location recipients the reference apps use (`HOST_CASE_OWNER_LOCATION[_PARENT]`, the two "case owner location's parent" variants). Customs are settings-registered — a domain picks from what its HQ instance ships, never authors new ones. | `messaging/scheduling/scheduling_partitioned/models.py::ScheduleInstance/CaseScheduleInstanceMixin`; `settings.py::AVAILABLE_CUSTOM_SCHEDULING_RECIPIENTS` | Alive. |
| 7 | Content types: SMS, Email (subject/message/html), SMS survey, IVR/callback (legacy telephony), Connect, custom — **no push-notification type**. Message templating exposes every case property (`{case.<prop>}`) plus `{case.owner.*}`/`{case.parent.*}`/`{case.host.*}`/`{recipient.*}`. | `scheduling/models/content.py`; `messaging/templating.py::CaseMessagingTemplateParam` | Alive. |
| 8 | Recipient user-data filtering: `Schedule.user_data_filter` (`{field: [values]}`) evaluated against **custom user data or the usercase** (`use_user_case_for_filter`) — the exact mechanism behind ACA §3-P2's per-user alert preferences. | `abstract.py::Schedule.user_data_filter/use_user_case_for_filter`; `scheduling_partitioned/models.py::_passes_user_data_filter` | Alive. F2's vocabulary plugs in directly. |
| 9 | **THE API GAP, re-checked and confirmed** (charter requirement): zero REST/API surface for rules, alerts, or schedules — no resources in any API version, HTML views only, the one messaging API is read-only history, and **no in-flight scaffolding** (toggle/privilege greps clean). The only bulk path is the UI-gated conditional-alert Excel upload. | greps over `corehq/apps/api/` + `data_interfaces/urls.py` + `scheduling/views.py::UploadConditionalAlertView` (independently anchored by the planning session's own grep) | **Absent.** Setup is HQ-UI-only today. |
| 10 | Gating: rules require `DATA_CLEANUP` (**Pro+**); conditional alerts require `REMINDERS_FRAMEWORK` (**Standard+**) and SMS delivery additionally `OUTBOUND_SMS` at send time (email-only alerts need neither SMS privilege nor Pro). Per-domain kill switch `DISABLE_CASE_UPDATE_RULE_SCHEDULED_TASK` exists. | `data_interfaces/views.py` decorators; `scheduling/views.py` decorators; `sms/api.py`; `accounting/bootstrap/features.py` | Alive. Plan-tier notes for the artifact. |
| 11 | The canonical claim sweep is expressible with **zero criteria rows**: `case_type='commcare-case-claim'` + `filter_on_server_modified=True` + `server_modified_boundary=N` + `UpdateCaseDefinition(close_case=True)`. Caveat: the boundary is server-modified age, not claimed-at age (an explicit date-offset criterion covers that variant). | `models.py::criteria_match`; `case_search/models.py::CLAIM_CASE_TYPE` | Alive. |

## 2. The shape question (protocol 3)

**CCHQ's authoring shape** — one Django model with definition rows, a workflow discriminator,
and settings-registered escape hatches — is not inherited. **Nova's shape** is an
`automations` collection speaking intent, with the platform's expressiveness enforced by a
*representability context* rather than by copying HQ's vocabulary:

```ts
blueprintDocSchema.automations: z.array(automationSchema).nullable(),

automationSchema = {
  uuid: Uuid, name: string, description?: string,
  caseType: string,                       // catalog-declared
  when: Predicate,                        // checked under the RULE-REPRESENTABLE context
  minimumQuietDays?: number,             // fact 4's server-modified boundary, intent-named
  action:
    | { kind: "sweep", writes?: Array<{property, value: Literal | { fromProperty } }>,
        close?: boolean }                                   // fact 3's exact expressiveness
    | { kind: "alert",
        schedule: { kind: "immediate" } | { kind: "recurring", every: …, at: …, until? … },
        recipients: Array<RecipientRef>,   // typed enum over fact 6's verified vocabulary
        recipientFilter?: { source: "user-data" | "usercase", field, values: string[] },
        content: { kind: "sms" | "email", subject?, message /* {case.<prop>} templating,
                   properties validated against the catalog */ } },
}
```

- **The `when` Predicate reuses Nova's one AST** under a new checker context that admits
  exactly what HQ's engine expresses (fact 2): property-vs-literal equality/inequality,
  blank/has-value, regex, and today-vs-`date property + N` comparisons, combined by all/any
  at one level. This is the same move as CSQL representability — one AST, per-target
  admissibility — so automations share the card editor, the reference index, and the rename
  cascade with everything else. No UCR/custom-criteria arms (settings-registered, not
  authorable).
- **Recipients are a typed enum** over the verified vocabulary, including the four custom
  parent-location recipients as named options carrying a "custom recipient — present on
  standard HQ deployments, listed in the setup artifact" note (fact 6: they live in HQ's
  settings, not per-domain config).
- Content is SMS/email only in v1 (fact 7's live, non-telephony set); templating properties
  validate against the destination case type (+ owner/parent/host prefixes against the
  catalog's relationships).

## 3. Charter closure

### 3.1 Are rules/alerts blueprint objects while unexportable? — YES
§2's collection, fully validated against the catalog (case types, properties — rename
cascades cover criteria/writes/templates), F2's user-data fields (`recipientFilter`), and
F3's locations (Location recipients). The reasons the leaning holds, now evidence-backed:
the SA must *design* them for the patterns to be complete (H9); validation is the only
defense against silent drift between the app and its hand-applied configuration; and the
setup artifact derives from the model, so there is exactly one source of truth. What stays
out: anything HQ can't express (the representability context makes over-expressive
automations unconstructible, so the artifact is always applicable as written).

### 3.2 Output form today — the third artifact family
The **HQ setup artifact** becomes one consolidated, per-app deliverable spanning F2 (user
schema), F3 (org model + prerequisites), and F6 (automations): generated at export/upload
from the blueprint, versioned with the app, surfaced in the builder (a Deployment panel) and
in the upload flow, with per-item HQ navigation paths (Data → Automatically Update Cases;
Messaging → Conditional Alerts — verified view names), the exact field-by-field
configuration, and the plan-tier prerequisites (fact 10: **Pro+ for sweeps, Standard+ for
alerts, OUTBOUND_SMS for SMS**; the corrected cap numbers from fact 4 in the operational
notes). Kept in sync by construction — regenerated from the doc on every export; a stale
artifact is impossible because it is never hand-edited.

### 3.3 The API gap — tracked, and designed around
Fact 9 confirms nothing to push and nothing in flight. The push lands behind a small port:
the artifact renderer is today's only driver; an API client slots in when the surface exists
(the builders may PR CCHQ — LOC L6). The plan records what a minimal upstream API would need
to be Nova-consumable (rule + schedule CRUD keyed by `(domain, name)`, criteria/action
payloads mirroring fact 2/3's vocabulary) — evidence for that upstream conversation, not a
commitment.

### 3.4 When the SA designs automations (H9's guidance half)
Trigger rules (guidance, not schema inference): a design that creates `message`-shaped
side-effect records (F4 P2-lite) **implies** its alert — the SA proposes one and the
validator's completeness stays out of it (undecidable); a claim-heavy design (search+claim
is on every Nova remote-request today) **implies** the claim sweep (fact 11's canonical
config, with the server-modified-vs-claimed-age caveat surfaced); recurring "overdue" logic
implies a sweep or a date-offset alert. Negative guidance: automations run at-most-daily by
default (fact 4) — never design flows that assume same-session automation; the 10k cap and
halt semantics go in the operational docs.

## 4. Full-stack scope (protocol 4)

Domain (`automations` collection + representability context + recipient/content schemas +
reference edges & rename cascades over criteria/writes/templates/filters); doc/mutations
(keyed CRUD, removal-blocked-by-nothing — automations are leaves); validator (codes +
classes + repair judgments: representability, catalog/type checks, template property checks,
filter vocabulary vs F2, schedule coherence); **no wire emitters** (nothing reaches
`.ccz`/HQ JSON) — instead the artifact renderer + the consolidated Deployment surface;
preview: none in v1 (running sweeps/alerts against the case store is recorded as a future
idea — a "simulate sweep" affordance — not scope); builder UI (automations workspace with
per-arm editors); SA + MCP (tools + §3.4 guidance); docs (authoring page + operational notes
+ the artifact explainer); migration: none.

## 5. Execution prompts

Serialized P1 → P2 → P3. The alert arm's recipient/filter vocabulary depends on F2 (fields)
and F3 (locations); the sweep arm has no dependencies beyond F4's claim posts already
shipping — if F6 runs early, land the sweep arm first and gate the alert arm's
location/user-data pieces on their features.

---

**P1 — Domain: the automations collection.**
> Implement F6's domain layer per `docs/plans/2026-07-06-f6-domain-automations.md` §2.
> The collection + both action arms; the RULE-REPRESENTABLE checker context (fact 2's exact
> expressiveness — build the admissibility table from the plan's citations, not from
> memory); recipient enum + content schemas + template-property validation; reference
> edges + rename cascades; validator codes/classes/repair judgments. Tests: representability
> matrix (each of the nine match shapes constructible; anything else rejected with an
> Elm-like message), rename-cascade coverage over every automation slot.
> **Open for implementer:** how `minimumQuietDays` and an explicit date-offset criterion
> interact in the editor (fact 11's caveat — recommend both expressible, clearly labeled);
> whether ANY-combination (criteria_operator) is exposed in v1 or ALL-only (recommend both —
> it's one enum).

**P2 — The setup artifact + Deployment surface.**
> Implement §3.2 (P1 landed): the consolidated HQ-setup artifact renderer (F6 automations +
> hooks for F2's schema and F3's org-model sections as those land), generated at
> export/upload, downloadable + shown in a builder Deployment panel; per-item HQ paths,
> field-level instructions, plan-tier prerequisites, operational notes (daily cadence, the
> 10k halt semantics, SMS limits). The push port interface with the renderer as sole driver.
> **Open for implementer:** artifact format (recommend one markdown document with stable
> anchors; PDF later if asked); how the panel indicates "applied vs pending" (recommend: no
> tracking in v1 — the artifact is instructions, not state; note the idea).

**P3 — SA tools + guidance + docs + closure.**
> Close out F6 (P1–P2 landed): SA tools for automations; the §3.4 trigger guidance (message
> patterns imply alerts; claim designs imply the sweep — offer fact 11's canonical config;
> the negative guidance); tools.mdx + authoring docs + operational docs with the corrected
> cap numbers; CLAUDE.md updates; feature-map §F6 → pointer (+ ACA §7.2 resolution note on
> the memo); drift sweep.
> **Open for implementer:** guidance wording; whether the SA proposes the claim sweep
> automatically whenever an app uses case search (recommend yes, as a suggestion the user
> confirms).

---

## 6. Risks + notes

- **The artifact is a human contract**: HQ-side drift (someone edits the rule in HQ) is
  invisible to Nova. v1 accepts this loudly (docs + the artifact's own header say the app
  is the source of truth); read-API reconciliation is a future idea contingent on fact 9
  changing.
- **Custom recipients are instance-configuration** (fact 6): present in Dimagi's settings
  today, but a self-hosted HQ may lack them — the artifact names them explicitly so the
  applier notices.
- **Plan-tier prerequisites** differ per arm (fact 10) — the SA should not design a sweep
  for a customer known to be on Standard without flagging the Pro requirement; guidance +
  artifact both carry it.
