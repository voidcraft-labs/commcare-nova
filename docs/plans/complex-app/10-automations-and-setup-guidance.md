# Unit 10 — Representable automations and setup guidance

**PR:** `Automations as blueprint objects with a regenerated HQ setup artifact`

**Depends on:** unit 8 (location criteria). · **Blocks:** units 11 and 13.

> Read [the binding contracts](00-contracts.md) first — the workspace-structure
> rule there states that automations never pretend to execute inside Preview.

Define exact automation schemas. Keep only HQ-representable criteria, actions, and
schedules, and render setup guidance with current plan-tier, cadence, and cap
facts. Preview may calculate current matches but must never imply the scheduled
automation executes locally.

## Binding facts

- Rules and conditional alerts are **one** HQ model: `AutomaticUpdateRule` with
  workflow in `{CASE_UPDATE, SCHEDULING, DEDUPLICATE}`. An alert is the
  `SCHEDULING` arm carrying a `CreateScheduleInstanceActionDefinition`, and the
  criteria engine is shared across both.
- The criteria vocabulary is closed: `MatchPropertyDefinition` with nine match
  types (`EQUAL`, `NOT_EQUAL`, `HAS_VALUE`, `HAS_NO_VALUE`, `REGEX`, and four
  date-offset comparisons against `case_date + N`), plus `ClosedParentDefinition`,
  `LocationFilterDefinition`, `UCRFilterDefinition`, and code-registered customs;
  `criteria_operator` is `ALL` or `ANY`; `filter_on_server_modified` with
  `server_modified_boundary` adds an implicit server-modified-age criterion; closed
  cases are skipped. The `CASE_UPDATE` action vocabulary is equally closed:
  `UpdateCaseDefinition` sets properties to a literal or another case property's
  value (including `parent/` and `host/` ancestor writes) and/or closes the case.
- Cadence and cap: an hourly task processes each domain **once daily** at its
  `auto_case_update_hour` (default midnight UTC), with an on-save path behind a
  toggle. `MAX_RULE_UPDATES_IN_ONE_RUN` is **10,000** per
  `(domain, case_type, db-partition)` run, per-domain overridable via
  `Domain.auto_case_update_limit`; hitting it halts the run with a notification and
  re-sweeps the next day. **The widely cited "50,000/day" figure is the unrelated
  outbound-SMS daily limit** — do not repeat it in guidance.
- Alert recipients are a closed vocabulary: generic (Location, Group, users, case
  group) plus case-relative (Self, Owner, LastSubmittingUser, ParentCase,
  AllChildCases, CasePropertyUsername/UserId/Email) plus code-registered customs
  listed in `AVAILABLE_CUSTOM_SCHEDULING_RECIPIENTS`. Customs are instance
  configuration — a domain picks from what its HQ ships and can never author new
  ones, so a self-hosted HQ may lack them.
- Content types are SMS, Email (subject/message/html), SMS survey, IVR/callback,
  Connect, and custom. **There is no push-notification type.** Message templating
  exposes every case property as `{case.<prop>}` plus `{case.owner.*}`,
  `{case.parent.*}`, `{case.host.*}`, and `{recipient.*}`.
  `Schedule.user_data_filter` evaluates against custom user data, or the usercase
  via `use_user_case_for_filter` — in both cases the slugs it addresses are the
  app's user-property catalog (`lib/domain/users.ts`), which already ships.
- Plan tiers differ per arm: case-update rules require `DATA_CLEANUP` (Pro+),
  conditional alerts require `REMINDERS_FRAMEWORK` (Standard+), and SMS delivery
  additionally requires `OUTBOUND_SMS` at send time — so an email-only alert needs
  neither SMS privilege nor Pro. A per-domain kill switch also exists.
- **The API gap is real and re-verified:** there is zero REST surface for rules,
  alerts, or schedules — no resources in any API version, HTML views only, the one
  messaging API is read-only history, and there is no in-flight scaffolding. The
  only bulk path is the UI-gated conditional-alert Excel upload. Automations
  therefore ship as a human-applied setup artifact behind a push port, which is why
  they are a **third** artifact family alongside the user-data schema and the org
  model.
- The canonical claim-cleanup sweep needs **zero** criteria rows:
  `case_type='commcare-case-claim'` with `filter_on_server_modified=True`,
  `server_modified_boundary=N`, and `UpdateCaseDefinition(close_case=True)`. The
  caveat travels with it: the boundary measures server-modified age, not claimed-at
  age; a claimed-at variant needs an explicit date-offset criterion.

Not every criterion in that closed vocabulary can back the "currently matches N
cases" count, because the count runs through the AST→Kysely compiler over Nova's
own case rows. Nova makes constructible exactly the criteria it can evaluate
locally: the nine `MatchPropertyDefinition` match types, `ClosedParentDefinition`,
and — once unit 8 lands its rows — `LocationFilterDefinition`. `UCRFilterDefinition`
references a report config Nova does not model, code-registered customs vary per
HQ instance, and `filter_on_server_modified` measures HQ server-modified age,
which has no local counterpart. Those three stay setup-artifact-only: authorable
as artifact text, excluded from the constructible schema. A rule mixing both kinds
shows its count over the evaluable criteria and states plainly which criterion the
count could not include — a silent under- or over-count is worse than no count.

**Observed:** an author declares a cleanup rule, sees how many cases it currently
matches, and receives copy-pasteable HQ setup steps rather than a false promise of
execution.
