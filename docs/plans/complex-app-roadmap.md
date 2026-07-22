# Complex app roadmap

> **Authoritative living plan.** Last rebaselined 2026-07-21 against Nova
> `db954a15`. This file owns execution order, product decisions, slice status, and
> delivery gates for the F1-F7 complex-app program. The dated 2026-07-06 feature
> and PR plans remain evidence and design-rationale archives; they are not
> executable instructions.

## How to use this plan

An implementation agent starts here, not in `docs/plans/prs/`. A legacy plan may
be consulted only for the verified platform evidence or rationale named by the
current slice. If this plan and a legacy document disagree, this plan wins.

The supervisor keeps this document current in the same PR that changes a
contract. A slice may be delegated only when its ledger status is `ready`. Before
changing a slice to `ready`, the supervisor must:

1. re-check its Nova integration seams against current `main`;
2. re-check its wire claims against the current relevant Dimagi source;
3. resolve every product or UX choice that changes persisted state or exported
   behavior;
4. name its migration, rolling-deploy, multiplayer, and authorization behavior;
5. state user-visible acceptance and proportionate verification; and
6. record any dependency or scope change here.

Status vocabulary:

- `blocked` — a dependency or contract is not yet established;
- `planned` — ordered and scoped, but not safe to delegate;
- `ready` — current, self-contained, and safe to implement;
- `in progress` — one named branch/worktree owns it;
- `review` — implementation is frozen except for review fixes;
- `shipped` — merged, deployed, production-verified, and cleaned up.

## Authority and evidence

Nova's domain model and UX are original. CommCare HQ, CommCare Core, Formplayer,
and CommCare Android are consulted only to establish what the target wire and
runtime accept, reject, or execute. Their authoring models and UI are not Nova
requirements.

The source snapshots visible during this rebaseline were:

| Repository | Commit | Use |
|---|---|---|
| CommCare Nova | `db954a15` | integration baseline |
| CommCare HQ | `0fa01e0e8aea95ed9013d564145ad6cffeb91371` | HQ JSON, app build, APIs, fixtures |
| CommCare Core | `130df00962a289381a8e0936c3ea5d3f53d96f73` | suite/runtime parsing |
| Formplayer | `ef9096c6109ce3cca5cc3c5e3ef9f4c6a80b01b7` | Web Apps execution |
| CommCare Android | `3dd87e3838d57230b1452bdfd845a9151b8a6861` | device behavior where relevant |

These pins describe the starting point, not a blanket re-verification. Each wire
slice updates the relevant pin and exact source paths when it becomes `ready`.
Uncommitted files in those external working copies are out of scope and must
never be modified by this program.

## Approved product contracts

These decisions are closed unless the project owner explicitly reopens them.

### Identity and references

- Lookup tables, columns, rows, user types, personas, organization levels,
  locations, operations, sections, links, and endpoints use immutable UUIDs for
  stored identity wherever Nova owns the identity.
- Human names, lookup tags, column wire names, level codes, location site codes,
  and endpoint ids are projections or external contracts, never substitutes for
  internal identity.
- A rename does not rewrite expression text. Printers and emitters resolve the
  current external spelling from immutable identity.
- External-contract names may require confirmation or elevated permission, but a
  rename never silently retargets or deletes a remote resource.

### Users, personas, and workers

- A **user type** is a reusable role/default-data template in the blueprint.
- A **preview persona** is a named design/test actor with stable identity,
  location assignments, and optional user-data overrides. It references a user
  type but is not the type.
- A **deployed worker** is a target-HQ identity associated with one deployment;
  provisioning is the lifecycle action that creates or adopts it.
  It is created from a type or persona, has separate credentials/lifecycle, and
  is not a blueprint identity.
- Preview exposes explicit **Preview as me**, **Preview as persona**, and
  authoring-only hidden-content inspection. These modes must not blend.
- Preview values must be honest. Target-dependent values such as the HQ domain
  slug are absent until a deployment target supplies them; Nova does not invent
  wire values to make a condition pass.

### HQ deployment safety

- Deployment is a dependency graph, not a fixed `app first, warn later` list.
  Required prerequisites are checked before destructive or externally visible
  mutation. Required dependency failure leaves the deployment `incomplete` or
  `blocked`, never ordinary success with a warning.
- A durable deployment record is keyed by Nova app, Project, HQ server, and HQ
  domain. Remote-resource mappings additionally key the Nova resource UUID and
  store ownership/adoption, remote id, pushed identity, and revision.
- Nova never auto-adopts a same-named HQ resource, overwrites an unowned resource,
  or deletes a remote resource on rename. First adoption is explicit. Renames
  create/repoint or update only resources Nova demonstrably owns and report any
  old remote resource left behind.
- Phases are idempotent and independently retryable. Retrying a table or location
  push must not require importing a duplicate app.
- `uploaded`, `built`, `released`, and `runnable` are distinct states. Endpoint
  links are shown as durable only after their deployment is released and the URL
  has been probed.
- Endpoint URLs derive from the selected HQ server; no code hard-codes the US
  hostname.

### Target gaps

- Tile controls that cannot survive the primary HQ upload path
  (`entitiesPerRow` / `uniformCells`) are excluded from the initial release. Their
  runtime evidence remains archived for a future explicitly local-export feature.
- Case attachment display is link-first. URL-property mode is the normal path.
  Deprecated `MM_CASE_PROPERTIES` attachment mode is an explicitly
  capability-gated compatibility option, never the default. Inline picture presentation is
  not promised until the Web Apps HTTPS-resource path works.
- Smart-link authoring does not ship before Nova models data-registry search. Do
  not land an unused emission helper as speculative machinery.

## Architecture contracts

### One Postgres system

All new persistent state uses the existing Cloud SQL Postgres pool and Kysely
migration owner. There is no Firestore definition store, listener, blueprint
scan, or identity mapping.

Lookup definitions and rows are Project-scoped. Organization and persona data
are app-scoped unless a later approved contract says otherwise. Every table has
explicit tenancy keys, authorization, project-move behavior, indexes, migration
ownership, and retention/deletion behavior.

Realtime updates use committed rows plus LISTEN/NOTIFY pokes and cursor/revision
catch-up. Notifications are never the data plane.

### Exact external-reference governance

Lookup table/column and location references participate in exact, transactional
reference-edge maintenance. A best-effort scan cannot authorize destructive
schema changes because it races a concurrent app commit.

The authoritative app commit rebuilds the fresh blueprint and validates it with
fresh Project-scoped external context inside the consistency protocol. Optimistic
client validation may use a revisioned snapshot for fast feedback, but the server
result wins. Missing or foreign-Project resources are indistinguishable and fail
closed for newly introduced references.

The design for S02 must document one lock order covering app commits, resource
schema mutation, Project moves, and reference-edge writes, then prove the
introduction-vs-delete race.

### Validity, activation, and rolling deploys

Adding a schema arm does not automatically activate it. Every new term,
operation, mutation discriminator, or carrier remains unconstructible or
commit-gated until all committed-state consumers are total: persistence,
replay, validation, preview, wire, SA, MCP, and rolling-version receivers.

New mutations follow the compatibility rules in `lib/doc/CLAUDE.md`. Persisted
mutation history must remain replayable across the deployment window. Prefer an
old-kind semantic extension or read-time compatibility projection when that
preserves intent; otherwise stage schema acceptance before writers activate.

### Case operations and submissions

- All expressions for one submission evaluate against a single pre-submission
  snapshot. Effects then apply atomically in declared order.
- Repeated creates have iteration-correlated outputs. A singular operation
  reference cannot escape its repeat or ambiguously name multiple created cases.
- Runtime-resolved targets are tenant-bound and must match the declared case
  type. Client-submitted descriptors are parsed as data, never trusted authority.
- Retype is a real schema transition. It succeeds only when the current
  conversion/parking/data-review model can complete atomically; otherwise the
  operation rejects without partial writes.
- The preview store exposes one atomic submission envelope containing ordinary
  form behavior plus advanced operations. It is not a mutually exclusive fifth
  submission variant.

### Locations and restore scope

Organization structure lives partly in the blueprint and partly in app-scoped
rows, so mutations and row writes share the app-row lock discipline. Removing or
retyping a level, archiving a referenced location, moving an app between
Projects, and adding a reverse-hop expression must account for current rows and
references atomically.

Location custom fields use one app-wide catalog with optional applicable-level
UUIDs. Level codes and site codes are create-once external identities; display
names may change independently.

Restore scope has an authoritative Postgres revision. Client invalidation can
reuse the existing case-data invalidation channel, but session-local Cloud Run
memory is not the source of truth. Start with the measured CTE inline; materialize
only after current measurements justify the storage and invalidation cost.

## UX and information architecture

### Design-system authority

Nova generally follows **Google Material 3** for foundations, design tokens,
adaptive layout, interaction states, accessibility, content hierarchy, and
motion. **Apple HIG** supplies platform polish where it improves focus,
keyboard/pointer behavior, touch ergonomics, and motion without contradicting
Material 3, web semantics, or Nova's established visual language.

The project owner's current Material 3 distillation is available to Codex on the
owner's development environment at
`/Users/braxtonperry/work/personal/docs/material3_design_system.md`. It is an
execution reference, not a portable build dependency. Before a UI slice becomes
`ready`, a supervisor or reviewer with access uses the relevant sections as
preparation input and records the concrete choices in that slice and the nearest
repo `CLAUDE.md`. The repo-recorded choices are the delegable authority, so a
non-owner clone never needs access to an undocumented personal path.

The precedence for implementation is:

1. accessibility, semantic HTML, and valid interaction behavior;
2. the explicit product and UX contract in this roadmap and the active slice;
3. Nova's existing semantic tokens, components, and `components/CLAUDE.md`
   conventions;
4. Material 3 guidance;
5. Apple HIG polish.

This does not mean copying Google's component catalog or Android UI. It means
using the underlying system deliberately: token-driven color/type/shape/spacing;
clear hierarchy and containment; consistent enabled/hover/focus/pressed/dragged
states; adaptive rather than merely scaled layouts; and motion that explains
state or spatial relationship.

The baseline UI review includes:

- semantic landmarks and sequential headings, logical DOM/focus order, visible
  keyboard focus, focus entry/return for dialogs and route changes, and labels
  that describe purpose rather than icon appearance;
- at least 48 x 48 CSS-pixel touch targets where the mobile layout permits and
  never below a 44 x 44 pointer target, normally separated by at least 8 px;
- text and graphic contrast, text resizing without clipping, RTL-safe ordering,
  and no state conveyed by color alone;
- explicit compact, medium, expanded, large, and extra-large behavior. Material's
  600/840/1200/1600 width boundaries are the review grid; a slice may retain
  Nova's existing breakpoint tokens when it documents equivalent behavior;
- one pane at compact widths, deliberate list-detail or supporting-pane reflow
  where added space improves the task, and more information rather than merely
  larger controls at wide widths;
- complete loading, empty, disabled, stale, conflict, selection, hover, focus,
  pressed, and dragged states using existing semantic tokens; and
- restrained, coherent motion with reduced-motion behavior. Utility transitions
  stay quick; exits are faster than entrances; large expressive transitions are
  exceptional rather than builder-wide decoration.

The structure tree represents the runnable app: modules, case-list surfaces,
forms, and eventually their nested structure. Project/app administration does
not masquerade as a child of that tree.

- **Project data** is a URL-owned workspace for Project-shared lookup tables. It
  is reachable from expanded and collapsed desktop navigation and the mobile path
  menu, and it always states that changes affect every referencing app.
- **App setup** is a URL-owned workspace with Users & Personas, Organization,
  Automations, and Deployment sections.
- Configuration workspaces own breadcrumbs, deep links, route recovery, viewer
  mode, focus restoration, mobile layout, and global Preview behavior.
- Destructive or dependency-affecting edits explain consequences before commit.
  Recoverable data edits use inverse-action undo or archive where practical;
  implementation boundaries do not become permanent `No undo` boilerplate.
- Drag/resize/reorder interactions have keyboard and numeric alternatives, stable
  focus, meaningful disabled-drop explanations, and adequate touch targets.
- Empty, loading, stale, conflict, and permission states are acceptance criteria,
  not polish deferred beyond the feature PR.
- Automations do not pretend to execute inside Preview. The UI explains cadence
  and may show a safe read-only `currently matches N cases` evaluation.

## Resource and delivery discipline

This program runs on a 16 GB development machine. Parallelism is useful for
bounded source research, disjoint low-footprint edits, and independent review;
resource-heavy verification is serialized.

- Normally one implementation worktree; at most two when ownership is truly
  disjoint. Worktree dependency installation runs sequentially under the pinned
  Node version.
- One local database/dev server, one browser session, one Playwright run, and one
  async-leak run at a time.
- Implementers run focused tests for their change. The supervisor owns the
  consolidated lint/typecheck/changed-test/leak/smoke gate appropriate to risk.
- UI work is interactively verified at responsive widths in the real browser.
  Pure transformations get pure tests; interaction, focus, and ARIA behavior get
  targeted RTL tests under the current `act(...)` discipline; a representative
  user journey gets Playwright coverage.
- Before publication: inspect the diff, obtain an independent agent review, fix
  findings, and rerun affected checks.
- Publication: intentional commit, push, PR, green CI, squash merge with a
  head-commit guard.
- Delivery completion: follow Cloud Build, the blocking migration job, and Cloud
  Run; verify the new revision is healthy and serves live traffic; probe the
  production URL and check revision errors; fast-forward local `main`; remove the
  remote/local branch and worktree; prune.

Plans and public docs move with behavior. Each slice updates this ledger, the
legacy reference pointers it supersedes, the nearest `CLAUDE.md`, and user docs
when it changes what authors see or do.

## Dependency graph

```text
S00 -> S01 -> S02

S02 -> {S03 display conditions, S04 case operations, S05 table expressions}
{S03, S04, S05} -> S06 atomic submission/resolved preview identity -> S07 preview
{S03, S04, S07} -> S08 conditions/operations authoring
{S05, S07} -> S09 Project data authoring
{S08, S09} -> S10 wave-one SA/MCP/docs

{S02, S04} -> S11 tile contracts/wire -> S12 tile query/preview/authoring
S06 -> S13 capture/storage
{S12, S13} -> S14 attachment target/link UX

S06 -> S15 users/personas -> S16 organization/location store
{S07, S16} -> S17 usercase/restore/wire
{S15, S16} -> S18 automations
{S05, S17, S18} -> S19 deployment core/artifact -> S20 push/provisioning
{S17, S18, S20} -> S21 App setup UI/SA/docs

{S03, S04} -> S22 form-link correctness/sections -> S23 nesting/reuse
{S19, S23} -> S24 endpoints/deep links
{S04, S07} -> S25 multi-select/related/profile extensions
```

S11-S14 and S15-S21 may overlap only after S02 is shipped and only when their
worktrees do not share subsystem ownership. S22 may begin after S03 and S04, but
compiler verification remains serialized with other wire slices.

## Slice ledger

| Slice | Deliverable | Depends on | Status | Legacy evidence |
|---|---|---|---|---|
| S00 | Roadmap rebaseline | — | review | execution index + all PR plans |
| S01 | Lookup persistence and realtime | S00 | planned | PR-02, F5 |
| S02 | External validation context and exact references | S01 | blocked | PR-01/02, F5 |
| S03 | Display conditions: domain and wire | S02 | blocked | PR-01/03, F1 |
| S04 | Case operations: domain and wire | S02 | blocked | PR-01/03, F4 |
| S05 | Table expressions, itemsets, and export guards | S02 | blocked | PR-01/03, F5 |
| S06 | Atomic submission envelope and resolved preview identity | S03-S05 | blocked | PR-04, F1/F4 |
| S07 | Preview execution for conditions, operations, and choices | S06 | blocked | PR-04, F1/F4/F5 |
| S08 | Conditions and operations authoring | S03/S04/S07 | blocked | PR-05 |
| S09 | Project data tables workspace and options authoring | S05/S07 | blocked | PR-05 |
| S10 | Wave-one SA, MCP, docs, and closure | S08/S09 | blocked | PR-06 |
| S11 | Tile contracts and wire | S02/S04 | blocked | PR-07 |
| S12 | Group-aware tile query, preview, and authoring | S11 | blocked | PR-07 |
| S13 | Capture, storage, and submission lifecycle | S06 | blocked | PR-08 |
| S14 | Attachment target-aware emission and link UX | S12/S13 | blocked | PR-08 |
| S15 | User types and preview personas | S06 | blocked | PR-09/10, F2 |
| S16 | Organization model and locations store | S15 | blocked | PR-09/10, F3 |
| S17 | Usercase, owner sets, restore scope, and location wire | S07/S16 | blocked | PR-10/11, F2/F3 |
| S18 | Representable automations and setup guidance | S15/S16 | blocked | PR-09/12, F6 |
| S19 | Deployment records, preflight, retry model, and artifact | S05/S17/S18 | blocked | PR-11 |
| S20 | Table/location/user push and provisioning drivers | S19 | blocked | PR-11 |
| S21 | App setup UI, SA, MCP, and docs | S17/S18/S20 | blocked | PR-12 |
| S22 | Exclusive form links and form sections | S03/S04 | blocked | PR-13, F7 |
| S23 | Nested menus and linked-form reuse | S22 | blocked | PR-13, F7 |
| S24 | Session endpoints and deep links | S19/S23 | blocked | PR-14, F7 |
| S25 | Multi-select, related-case pulls, and profile extensions | S04/S07 | blocked | PR-15, F4 |

## Slice contracts

The sections below define the minimum stable boundary. A slice may be split
further for reviewability; it may not silently absorb a later slice.

### S00 — roadmap rebaseline

Deliver this living plan; mark every legacy execution PR as superseded; repoint
F1-F7 references; record the approved contracts and delivery discipline. Review
is documentation-focused. Completion still follows the normal PR, CI, deploy,
and cleanup path.

### S01 — lookup persistence and realtime

Create Project-scoped Postgres definitions, stable table/column/row UUIDs, rows,
revisions, indexes, authorization, transactional writes, and LISTEN/NOTIFY
catch-up through one `lib/lookup` service boundary. Viewers read; editors manage
rows and additive schema/display labels; admin or owner authority is required for
wire-identity changes and destructive schema operations. Destructive operations
remain disabled until S02 exact references exist.

Acceptance includes tenant isolation, Project-member role matrix, concurrent tag
uniqueness, atomic CSV coercion/errors, deterministic `(order, stable row UUID)` order,
revision catch-up, the 5,000-row per-table cap, and app-Project move behavior
explicitly blocked until S02. S05 owns the aggregate embedded-fixture budget,
because only that slice can calculate the complete referenced artifact.

Before changing S01 to `ready`, re-audit the current migration registry, Project
role helpers, LISTEN connection budget, app-move path, and server-action boundary;
then replace this readiness note with exact files, DDL, API signatures, migration
and rollback behavior, and focused test commands.

### S02 — external validation context and exact references

Thread revisioned lookup context through optimistic builder, SA/MCP, fresh server
commit, replay-safe persistence, and export boundaries. Maintain exact table and
column reference edges with the blueprint transaction. Add the resource-schema
mutation path and lock order; reject delete/rename/retype races and cross-Project
app moves with actionable referencing-app information.

Acceptance must include simultaneous reference introduction versus delete,
stale client snapshot versus fresh server result, foreign-Project
indistinguishability, mutation replay, mixed-version compatibility, and zero-reference schema
changes.

### S03 — display conditions: domain and wire

Add typed condition carriers only where evaluation context is defined. Preserve
the current expression-admission policy: global/module contexts cannot gain row
property reads merely because a generic type context exists. Reverify exact
absent-node equality, inequality, and numeric-order semantics; never encode the
blanket `absent means false` shortcut.

Screen-width authoring remains closed until this slice re-evaluates whether the
signal is stable enough for Nova's authoring model. If excluded, retain the wire
evidence and do not expose the term.

### S04 — case operations: domain and wire

Define operation UUIDs, authored create ids, typed targets, links, repeat
correlation, remove/retype semantics, ordering, property-writer participation,
and activation gates. Integrate effective property typing, data review,
conversion/parking, case schema materialization, and reserved case types.

Pin wire order and empty-update guards against current HQ/Core fixtures. Reject
ambiguous singular references, cross-repeat references, target-type mismatch,
foreign-tenant ids, unsafe retypes, and removing/reordering an operation under a
dependent reference.

### S05 — table expressions, itemsets, and export guards

Add typed table/column UUID references, table-scope expressions, table-backed
select sources, deterministic embedded fixtures, and the complete web/MCP export
matrix. Local CCZ may embed supported fixtures; HQ-target JSON/upload remains
blocked until S20 can push the referenced resources.

Define blank/missing/null cells, duplicate or blank option values, CSV types,
no-match reads, answer-dependent filters, repeat scope, dependency cycles, and
definition-plus-row snapshot consistency.

S05 also owns the aggregate embedded-fixture budget across every table an app
references. Before the slice becomes `ready`, pin a row-and-byte limit against
current compile/request/runtime constraints, reject over-budget artifacts before
emission with person-readable remediation, and test the exact boundary plus a
many-small-tables case. The per-table storage cap from S01 is not a substitute
for this compiled-artifact budget.

### S06 — atomic submission envelope and resolved preview identity

Establish one `ResolvedPreviewIdentity` contract across Search, Results, form
XPath, conditions, table filters, operations, and owner stamping. S06 activates
**Preview as me** and leaves a typed provider seam for S15's persisted named
personas; it does not create a session-only pseudo-persona. Extend the CaseStore
contract with one tenant-bound atomic submission envelope combining ordinary
form actions and advanced operations. No real row may be stamped with a named
persona until that persona has stable persisted identity.

### S07 — preview execution

Implement the shared rewrite/fold/SQL-residue evaluator, table choices, atomic
case effects, failure parity, and resolved-identity scoping over real case rows.
Test the full absent-value matrix and effect ordering. `Preview as me` is active;
S15 plugs named personas into the same contract without changing evaluator call
sites. Authoring-only reveal behavior remains a visibly separate mode.

### S08 — conditions and operations authoring

Build URL-owned, responsive authoring surfaces using the current editor policy
and inspector ownership. The operations stress case is 20 items; default to a
list-plus-editor/master-detail model with keyboard reorder and dependency-aware
review states. A configuration URL's global Preview action runs its owning form.

### S09 — Project data tables workspace

Build the Project data workspace, schema/row grid, atomic CSV import, revisions,
conflict handling, permissions, Project switching, and select options-source
editor. It is accessible in expanded/collapsed desktop and mobile navigation and
does not appear as an app-content tree child.

### S10 — wave-one SA, MCP, docs, and closure

Expose the shipped vocabulary through both camelCase chat tools and snake_case
MCP projection, preserving OpenAI Responses strict-schema normalization, cache
stability, schema size, and API acceptance. Update public authoring docs and all
nearest subsystem guidance. Run one integrated dogfood flow.

### S11 — tile contracts and wire

Land stable tile/grouping identities, validation, reference edges, HQ JSON, suite
emission, and oracle fixtures. Use Nova relationship vocabulary, not
`parentIndex`, in author-facing surfaces. Exclude `entitiesPerRow` and
`uniformCells` from constructible state.

### S12 — tile query, preview, and authoring

Add group-aware ordering and pagination at the data layer before rendering;
groups cannot be formed after a 50-row page is fetched. Define pager semantics,
persistent-tile locations, presets, responsive rendering, keyboard/numeric layout
alternatives, and one visual parity journey.

### S13 — capture, storage, and submission lifecycle

Implement real image/audio/video/signature capture and decide generic-file scope
explicitly before marking ready. Specify staged upload, cancellation, retry,
required/relevant behavior, repeat support, compensation/orphan cleanup,
authorization, case-reference deletion guards, and why case captures do not
pollute the authoring media library.

### S14 — attachment target-aware emission and link UX

Add target-aware URL-property emission only when deployment server/domain are
known, explicit link presentation, preview replacement/removal, SA/docs, and the
capability-gated deprecated attachment compatibility path. Do not default to a
broken HTTPS picture column.

### S15 — user types and preview personas

Persist separate user-type and persona collections through normalized blueprint
rows and durable mutation history. Define exact built-ins from current HQ source;
ordinary workers must not receive demo-only `user_type`, and `commcare_project`
must remain absent without a target domain. Define persona deletion and usercase
lifecycle before activation.

### S16 — organization model and locations store

Land the app-wide custom-field catalog, stable level/site codes, app-scoped
location rows, realtime revisions, cross-store lock discipline, row integrity,
archive/reassignment rules, Project move handling, and role-aware owner validation.
The model validates whether a fixed destination can belong to each applicable
persona's address-book footprint; S17 owns proving that the emitted fixture
actually carries it.

### S17 — usercase, owner sets, restore scope, and wire

Materialize persona usercases without clobbering app-authored fields; derive owner
sets; run tenant-complete restore closure; lower user/location terms; and emit the
flat location fixture and usercase actions. Start with the measured CTE inline and
Postgres revision invalidation. Re-run the HQ 44-case relationship corpus and
current-scale measurements before choosing materialization. Acceptance includes
proving that every S16-valid fixed/reverse-hop destination is present in the
applicable persona's emitted fixture and that an out-of-footprint destination is
rejected before commit.

### S18 — representable automations and setup guidance

Define exact automation schemas rather than referring to ellipses in F6. Keep
only HQ-representable criteria/actions/schedules; render setup guidance with
current plan-tier/cadence/cap facts. Preview may calculate current matches but
must not imply the scheduled automation executes locally.

### S19 — deployment core and artifact

Create durable deployment/resource mappings, state transitions, preflight,
ownership/adoption, independently retryable phases, target-aware setup artifact,
and release/probe state. Establish the current upload lifecycle before endpoint
URLs or dependent drivers consume it. S19 records and plans the new deployment
state but does not activate uploads for apps carrying the new resource
dependencies; the existing export guards remain until S20 can satisfy them.

### S20 — push and provisioning drivers

Implement referenced-table push, location push, and explicit worker provisioning
against S19 ownership mappings. Preflight organization levels/fields/toggles
before external mutation. Push and verify required tables/locations before app
import or release where the target APIs permit. If an unavoidable required step
can occur only after import, its failure leaves the deployment explicitly
`incomplete` and withholds `released`/`runnable` status. Never store plaintext
credentials. Specify username conflict, temporary-secret, update/adoption,
archive, and partial-failure behavior. Lift HQ export guards only when required
resources and ordering are verified end to end.

### S21 — App setup UI, SA, MCP, and docs

Build URL-owned Users & Personas, Organization, Automations, and Deployment
sections with responsive navigation, permissions, conflict/recovery states,
deployment progress/retry, and honest target prerequisites. Complete tools,
public docs, and the cross-facility owner/restore dogfood scenario.

### S22 — exclusive form links and sections

First fix the existing `first matching link wins` wire bug and reject links after
an unconditional branch. Then add form sections with fractional order and staged
mutation compatibility. Define relevance skipping, Next/Back validation,
earliest-invalid Submit routing, mutation re-anchoring, preview persistence, and
accessibility before UI implementation.

### S23 — nested menus and linked-form reuse

Add one-tier nesting, ancestor-aware session context, tree/breadcrumb behavior,
display-condition inheritance, delete/cycle rules, and linked-form identity.
Before freezing projection, pin an HQ import plus Make New Version round trip for
the ShadowModule shape. A host module must remain valid native content; a
linked-only empty ordinary module is not allowed.

### S24 — session endpoints and deep links

Verify claim-command resolution against current HQ fixtures first. Endpoints
depend on durable released deployments, use the selected server, reject flattened
modules, preserve tenant authorization even when relevancy is bypassed, and
distinguish internal preview routes from shareable HQ links. Registry-search smart
links remain out of scope.

### S25 — multi-select, related cases, and profile extensions

Define selected-case runtime semantics before suite flags: ordinary primary-case
preloads/writes must either reject or lower through per-selected-case operations.
Add preview repeat materialization, integer limits 1-100, empty-selection behavior,
cross-page/search/back persistence, and related-case visibility. Treat profile
properties and related-case pulls as separately accepted sub-slices if the diff
grows; keep every HQ JSON/compiler projection identical.

## Change log

- **2026-07-21 — S00:** Replaced the stale fifteen-PR execution model after the
  Firestore-to-Postgres migration and subsequent builder, mutation, data-review,
  agent, and deployment changes. Recorded the approved identity, persona,
  deployment, tile, attachment, UX, resource, review, and delivery contracts.
