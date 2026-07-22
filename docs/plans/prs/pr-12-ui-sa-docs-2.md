# PR-12: Builder UI, SA, docs II

> [!IMPORTANT]
> **Execution superseded (2026-07-21).** Do not implement this PR document
> directly. The live sequence and acceptance contract are in
> [`../complex-app-roadmap.md`](../complex-app-roadmap.md), stage **S21**. This
> file remains the evidence and design-rationale record; where it disagrees
> with the roadmap, the roadmap wins.

*Self-contained implementation plan. Reference rationale: `docs/plans/2026-07-06-f2-users.md`
§3/§5, `…f3-locations.md` §3/§5 (P6, P8), `…f6-domain-automations.md` §3.4/§5. Scope rulings
in `docs/plans/2026-07-06-pr-execution-plan.md` apply — multi-location personas and custom
level fields are IN. Depends on PR-09 (vocabulary), PR-10 (personas/owner sets/restore
scope), PR-11 (push framework + setup artifact + wire).*

**Goal.** Wave 2 becomes *usable*: workspaces for user types, the org model, and
automations; the persona picker that makes ownership visible ("viewing as facility-A worker —
12 cases in restore"); the usercase authoring affordance; SA tools + guidance for the whole
wave-2 vocabulary; and the docs that explain the three-population model and the HQ setup
story. After this PR a user can design a multi-site app end-to-end in the builder or by
chat, preview it as any persona, and read exactly what to configure on HQ.

## 2026-07-21 rebaseline (S21 execution contract)

S21 presents one URL-owned **App setup** workspace, with stable deep-linkable
sections for user data/types/personas, organization/locations, automations, and
deployment. It extends `lib/routing` and the existing builder workspace chrome;
these app-global editors do not live in settings popovers and do not crowd the
module/form structure tree. The three-workspace-versus-hub choice below is
therefore resolved in favor of the hub.

The UI, SA tools, and docs preserve three identities throughout:

- user types are reusable role/default bundles and carry no assignments;
- preview personas are named design artifacts with their own locations,
  primary assignment, identity, usercase, and overrides; and
- deployed workers are target-HQ records with provisioning/deployment status.

The persona editor, provisioning flow, SA summaries, and tool schemas must not
collapse those records back into `userTypes[].locations`. Tree edits remain
data writes, but the interface provides reversible rename/move/archive actions
or an inverse-action undo toast; it does not make a permanent "no undo" warning
the user's burden.

Deployment is a target-aware state machine over S19-S20's durable mappings. The
panel shows preflight, planned diffs, explicit adoption decisions, blocking
prerequisites, per-phase results, and an **incomplete** state with retry. It
never hides a failed required phase inside a success message and never offers
automatic remote deletion. Worker provisioning resolves confirmation/password
requirements before the external write and never stores or re-displays a
plaintext secret.

Automations do not execute in Nova Preview. State that boundary directly and,
where the representable predicate can be evaluated safely, show a read-only
current match count rather than simulating the HQ daily job. Preserve the
at-most-daily/10k operational guidance.

Current-main corrections: the worst-case restore measurement in the governing
plan is approximately **1.2 s**, not the stale ~3 s below; public MDX sources
live under `content/docs/**` with navigation in `content/docs/meta.json`; and
implementation follows the currently available design skills plus
`components/CLAUDE.md`/`components/builder/CLAUDE.md`, not a hard dependency on
the historical `frontend-design` skill name. The legacy no-new-RTL rule is
superseded: keep pure state tests where they fit, add targeted RTL coverage for
interaction/focus/ARIA under the current `act(...)` discipline, and retain one
representative Playwright wave-2 journey.

## Verified contracts this PR relies on

- **Recipients** for alerts are a closed enum + settings-registered customs: generic
  (`Location`, `Group`, users, case group), case-relative (`Self`, `Owner`,
  `LastSubmittingUser`, `ParentCase`, `AllChildCases`, `CasePropertyUsername`/`UserId`/
  `Email`), and the four custom parent-location recipients the reference apps use
  (`HOST_CASE_OWNER_LOCATION`, `HOST_CASE_OWNER_LOCATION_PARENT`, and the two "case owner
  location's parent" variants) — customs live in HQ's `settings.py::
  AVAILABLE_CUSTOM_SCHEDULING_RECIPIENTS`, i.e. **instance configuration**: present on
  Dimagi-hosted HQ, possibly absent on self-hosted instances
  (`messaging/scheduling/scheduling_partitioned/models.py::CaseScheduleInstanceMixin`).
- **Message templating** exposes `{case.<prop>}` + `{case.owner.*}`/`{case.parent.*}`/
  `{case.host.*}`/`{recipient.*}` (`messaging/templating.py::CaseMessagingTemplateParam`) —
  the editor validates properties against the catalog and prefixes against declared
  relationships (PR-09's rule).
- **Plan tiers** (docs + SA export notes, never gates): usercase = paid `USERCASE`;
  locations APIs = paid `LOCATIONS`; sweeps = `DATA_CLEANUP` (Pro+); alerts =
  `REMINDERS_FRAMEWORK` (Standard+) + `OUTBOUND_SMS` for SMS at send; bucket levels
  (`has_users=false`) need the `ush_restore_file_location_case_sync_restriction` toggle.
- **Persona indicators' data** comes from PR-10: the owner-set derivation (persona id +
  case-owning locations per `shares_cases`/`seesDescendantCaseloads` over Nova's tree) and
  the measured restore-scope CTE (~640 ms realistic persona / ~3 s worst case, cached,
  invalidated on case writes) — the UI treats scope size as an async, cached value.
- **Builder conventions**: three-sources-of-truth (URL via `lib/routing`; blueprint via
  `lib/doc/hooks::useBlueprintMutations` — gated, undoable; ephemeral state in
  `lib/session`); tree/table ROWS are data writes via Project-membership-gated server
  actions, not doc mutations; structural predicate editing uses
  `components/builder/shared/PredicateCardEditor.tsx` under checker-derived slot
  constraints; **no RTL/jsdom UI tests** — test state models; real-UI verification rides
  the Playwright smoke. Load the `frontend-design` skill; build from `@/components/shadcn`;
  icons from `@iconify/react/offline`.
- **SA tool mechanics** as in PR-06 (its corrected contract): hand-written Zod inputs,
  `guardedMutate` for doc mutations, server actions for data writes, and — for every
  brand-new tool — **TWO registrations**: the chat SA's own tool manifest in `lib/agent`
  (the tool directory the `ToolLoopAgent` is constructed from) AND a `SHARED_TOOLS` entry
  in `lib/mcp/server.ts`. Schema changes on EXISTING tools propagate to MCP automatically
  (`lib/mcp/adapters/sharedToolAdapter.ts::registerSharedTool`); missing the chat-side
  registration ships a tool on MCP only and silently breaks this PR's headline goal.
  `scripts/test-schema.ts` coverage; guidance as `###` subsections in
  `lib/agent/prompts.ts::SHARED_TAIL`.

## Build

### 1. Users workspace

A builder workspace (sibling of the case-list workspace pattern): the **user-data schema
editor** (fields with name-under-slug-rule, label, type, options, required; built-ins from
PR-09's catalog rendered read-only and visually distinct) and the **user-types editor**
(named types; typed value inputs driven by each field's `data_type`/`options`;
multi-location assignment as a location multi-picker with exactly one primary — PR-09's
validator rule surfaced inline). Edits dispatch the PR-09 keyed mutations through
`useBlueprintMutations`; rejected commits surface findings contextually.

### 2. Org workspace

Two panes. **Levels**: the role vocabulary as the primary control (territory / bucket /
registry / area, each with one-line intent copy from F3 §2), `seesDescendantCaseloads` and
`addressBook` as explicit options, custom level fields (name/label under the slug rule).
**Tree**: an editor over the Postgres `locations` rows (**PR-10's implemented store** —
PR-09 lands only schema/types/stubs; the gated CRUD server actions this pane invokes are
PR-10 deliverables per the index's ownership note) — add/rename/move-within-level/archive,
`site_code` displayed read-only (derived),
custom-field value cells per the level's fields. Tree integrity rejections (level parentage,
singleton-bucket, site_code uniqueness) render as inline person-readable errors. No undo on
tree edits (data, not doc) — say so in the UI copy.

### 3. Automations workspace

Sweep and alert editors over PR-09's `automations` collection. The `when` editor is
`PredicateCardEditor` under the **rule-representability context** — pickers offer only the
nine expressible match shapes; the disable-reason names what HQ's rule engine can't express.
Sweep arm: writes (literal / other-property incl. parent/host prefix) + close toggle +
`minimumQuietDays`. Alert arm: schedule editor (immediate / recurring per PR-09's shapes),
**recipient picker** over the verified enum with the four custom recipients grouped under
"Custom (Dimagi-hosted HQ)" carrying the instance-configuration caveat inline, recipient
filter (user-data field + allowed values, vocabulary from `userDataFields`), and the
**content editor** with `{case.<prop>}` chips validated against the catalog (+ prefix
support). Every automation card links to its rendered section in the PR-11 Deployment
panel.

### 4. Persona picker upgrade

The preview persona picker (PR-04's substrate, PR-10's data) becomes: choose a user type →
optional ad-hoc value overrides → location assignment display (from the type) → indicators:
**"Viewing as {type} @ {primary location} — {N} cases in restore"** (async scope size from
PR-10's cached CTE; show a spinner state, never block the preview render) and an expandable
owner-set inspector (the persona's owner ids with the location names — the debugging
affordance F3 P4 called for). "No persona" remains the author-omniscient mode, labeled.

### 5. Usercase affordance on fields

`case_property_on` pickers gain the `commcare-user` built-in entry, framed as "Save to the
worker's own record (per-user)" with one line of when-to-use copy; the field inspector shows
the usercase's built-in properties read-only. The HQ `USERCASE` plan requirement appears as
an info note, not a gate.

### 6. Provisioning surface (atop PR-11's push functions)

In the Deployment panel: "Create workers on HQ from user types" — pick a type + count or
usernames, invoke PR-11's `CommCareUserResource` client functions (user_data values from the
type, location assignment via `primary_location`/`locations`), show per-worker results and
the identity mappings; failures degrade to warnings per the push contract. Web-user
invitations ride the same surface minimally — inputs: email, Nova user type, and a
**required HQ web-user role name** (`InvitationResource` resolves `role` by name against
the domain's roles and fails without one; a Nova user type cannot supply it — the surface
takes it as an explicit text input documented as "an existing role on the target domain").

### 7. SA tools + prompt guidance II

Tools: user-data field + user-type CRUD (doc mutations), org level CRUD (doc), tree row
CRUD (server-action tools, Project-gated), automation CRUD, persona-independent — all with
`SHARED_TOOLS` entries, `test-schema.ts` coverage. Guidance (`SHARED_TAIL` additions):
- **User types**: propose types whenever a workflow description implies roles (approval,
  supervision, site-vs-registry staff); pair every F1 display condition on user data with a
  declared field + type values.
- **Ownership as address** — the one paragraph of ACA §2 now unlocked: who owns a case
  decides whose device carries it; creating a case owned by a bucket IS delivering it
  there; buckets/registries hold what workers shouldn't sync; route with the typed owner
  expressions, never raw ids. Includes the orphan-cases smell (unassigned owning locations)
  and the restore-size doctrine.
- **Automations**: a design that creates message-shaped records MUST propose its alert; a
  search-and-claim design MUST propose the claim sweep (offer the canonical config:
  `commcare-case-claim`, quiet-days boundary, close) — with the at-most-daily cadence and
  the 10k-per-run halt semantics stated so the SA never promises same-session automation.

### 8. Docs II + closure

Authoring pages: users & personas (the **three-population boundary**: Project members =
authors; user types/personas = design artifacts; provisioned workers = HQ runtime users),
locations & ownership (roles, the address book, what the persona preview demonstrates),
automations (+ the corrected cap numbers), and the **setup-artifact explainer** (what it is,
why it exists — no HQ API — and the app-is-source-of-truth rule). HQ plan-tier notes on each
page. `tools.mdx` rows for every new tool. CLAUDE.md updates (`lib/domain`, `lib/agent`,
`components/builder`, `lib/case-store`). Feature-map/plan pointer sync. Standing drift
sweep.

## Tests / acceptance

- State-model tests: persona picker derivation (type + overrides + location → session-user
  resolution inputs), workspace editors' mutation emission, representability picker
  constraints (offered-set === checker accept-set), tree-edit rejection surfacing.
- Tool tests: each new tool's happy path + gate/auth rejection; `test-schema.ts` green.
- Playwright smoke: one wave-2 flow — define a type, assign a location, pick the persona,
  see the restore-scope indicator change.
- Acceptance: the F3 §3/L5 demonstration works end-to-end in dev — create a referral owned
  by another facility's bucket as persona A; switch to persona B; it appears in B's queue.

## Non-goals

The Deployment panel + artifact renderer + push client functions themselves (PR-11 — this
PR consumes them); any wire/emitter changes; wave-1 surfaces (PR-05/06); endpoint/deep-link
UI (PR-14).

## Open choices (implementer)

- Workspace navigation placement (three new workspaces vs one "App setup" hub — pick what
  the existing builder nav pattern supports; recommend the hub if nav crowds).
- Whether the SA proposes user types proactively during app design (recommend yes, as a
  confirm-first suggestion — roles fall out of workflow descriptions naturally).
- Persona state persistence across sessions (recommend: per-user UI state if a cheap slot
  exists; else session-ephemeral, matching PR-04's substrate).
