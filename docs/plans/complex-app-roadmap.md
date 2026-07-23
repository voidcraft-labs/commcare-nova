# Complex app roadmap

> **Authoritative living plan.** Last rebaselined 2026-07-23 against deployed
> Nova `85b2fe3b` (PR #303). S01 through S04 are shipped, including all of S02.
> S05's domain/wire decisions are pinned below and S05a, its dormant
> compatibility unit, is implementation-complete and under final review in
> draft PR #311; S05c's production cutover remains decision-blocked. S22
> remains closed on `agent/s22-form-links` pending the
> explicit cutover choice recorded in its slice. This file owns execution order,
> product decisions, slice status, and
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
| CommCare Nova | `85b2fe3b8267e5be866969ebe42b7a1a364ce2b1` | Current deployed integration baseline |
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

S02 installs one lock order covering app commits, resource schema mutation,
Project moves, and reference-edge writes, then proves the seeded
introduction-versus-delete race without activating a carrier. S05 repeats both
winner orders with the first real carriers before their writers activate.

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

S02c1 -> {S03 display conditions, S04 case operations}
{S02, S04} -> S05a dormant carriers/compatibility -> S05b local wire -> S05c carrier cutover
{S03, S04, S05c} -> S06 atomic submission/resolved preview identity -> S07 preview
{S03, S04, S07} -> S08 conditions/operations authoring
{S05c, S07} -> S09 Project data authoring
{S08, S09} -> S10 wave-one SA/MCP/docs

{S02, S04} -> S11 tile contracts/wire -> S12 tile query/preview/authoring
S06 -> S13 capture/storage
{S12, S13} -> S14 attachment target/link UX

S06 -> S15 users/personas -> S16 organization/location store
{S07, S16} -> S17 usercase/restore/wire
{S15, S16} -> S18 automations
{S05c, S17, S18} -> S19 deployment core/artifact -> S20 push/provisioning
{S17, S18, S20} -> S21 App setup UI/SA/docs

{S03, S04} -> S22 form-link correctness/sections -> S23 nesting/reuse
{S19, S23} -> S24 endpoints/deep links
{S04, S07} -> S25 multi-select/related/profile extensions
```

S02 through S04 are shipped. S05's exported-value, select-fallback,
filter-scope, dependency, snapshot, and aggregate-fixture contracts are now
pinned. S05a's dormant carrier-compatibility implementation is under final
review in draft PR #311. S05b remains blocked until S05a ships; S05c remains
blocked on S05b and a fresh owner decision before
any production cutover or nonzero compatibility floor. S11-S14 and S15-S21 may
overlap only when their worktrees do not share subsystem ownership. S22 readiness
is complete but implementation remains blocked on its owner cutover decision.
Compiler verification stays serialized across wire slices.

## Slice ledger

| Slice | Deliverable | Depends on | Status | Legacy evidence |
|---|---|---|---|---|
| S00 | Roadmap rebaseline | — | shipped | execution index + all PR plans |
| S01 | Lookup persistence and realtime | S00 | shipped | PR-02, F5 |
| S02 | External validation context and exact references | S01 | shipped | PR-01/02, F5 |
| S03 | Display conditions: domain and wire | S02c1 | shipped | PR-01/03, F1 |
| S04 | Case operations: domain and wire | S02c1 | shipped | PR-01/03, F4 |
| S05a | Dormant lookup carriers and compatibility | S02/S04 | in review (PR #311) | PR-01/03, F5 |
| S05b | Lookup expression, itemset, and local-fixture wire | S05a | blocked | PR-01/03, F5 |
| S05c | Lookup carrier cutover and edge preparation | S05b + owner cutover decision | blocked | PR-01/03, F5 |
| S06 | Atomic submission envelope and resolved preview identity | S03/S04/S05c | blocked | PR-04, F1/F4 |
| S07 | Preview execution and carrier activation | S06 | blocked | PR-04, F1/F4/F5 |
| S08 | Conditions and operations authoring | S03/S04/S07 | blocked | PR-05 |
| S09 | Project data tables workspace and options authoring | S05c/S07 | blocked | PR-05 |
| S10 | Wave-one SA, MCP, docs, and closure | S08/S09 | blocked | PR-06 |
| S11 | Tile contracts and wire | S02/S04 | blocked | PR-07 |
| S12 | Group-aware tile query, preview, and authoring | S11 | blocked | PR-07 |
| S13 | Capture, storage, and submission lifecycle | S06 | blocked | PR-08 |
| S14 | Attachment target-aware emission and link UX | S12/S13 | blocked | PR-08 |
| S15 | User types and preview personas | S06 | blocked | PR-09/10, F2 |
| S16 | Organization model and locations store | S15 | blocked | PR-09/10, F3 |
| S17 | Usercase, owner sets, restore scope, and location wire | S07/S16 | blocked | PR-10/11, F2/F3 |
| S18 | Representable automations and setup guidance | S15/S16 | blocked | PR-09/12, F6 |
| S19 | Deployment records, preflight, retry model, and artifact | S05c/S17/S18 | blocked | PR-11 |
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

Readiness was frozen 2026-07-21 against Nova `3aa306d7` after independent audits
of the migration owner, `AppDatabase`, Project authorization, Better Auth Project
deletion, the app-move saga, the dedicated listener's exact-fit connection budget,
the builder EventSource cursor, the Server Action body boundary, and fractional
ordering. S01a shipped as PR #295 at `18aa7566`, including production migration
execution `commcare-nova-migrate-lbzk2` and Cloud Run revision
`commcare-nova-00350-xgz`. S01b shipped through PR #296 plus rolling-handoff
hotfix PR #297 at `7422c4c2`; build `4a6ab710` ran migration
`commcare-nova-migrate-clvkd` before healthy 100%-traffic revision
`commcare-nova-00351-dcq`. Production probes and error logs passed, and every S01
branch/worktree was cleaned. The review units below now record the delivered
contract rather than active delegation.

S01 was delivered as two review units so persistence/authorization and long-lived
stream behavior are independently understandable and leak-gated:

1. **S01a — storage and write boundary:** additive migration, `lib/lookup`, typed
   actions, raw CSV import route, authorization, Project lifecycle guards, the
   temporary move UX, the lookup channel constant plus transactional notify
   helper/writes, and pure/integration tests. Shipping writes before readers is
   safe because Postgres notifications are transient and the old revision ignores
   the unknown channel.
2. **S01b — realtime relay:** LISTEN/fan-out for the fourth channel on the one
   existing listener, lookup manifest pokes on the existing builder EventSource,
   reconnect/read-retry hardening, and stream lifecycle tests. The future zero-app
   Project-data route is deferred to S09; the builder never opens a second
   EventSource.

#### Persistence and identity

Migration `20260722053000_lookup_tables` is registered in the static case-store
migration provider and adds these Project-scoped app-state tables. Their Kysely
types live in `AppDatabase` (`lib/db/pg.ts`), never the case-runtime-only
`lib/case-store/sql/database.ts`. Case-store migrations run before Better Auth
creates its schema, so none of these tables foreign-key to `auth_organization`.

- `lookup_project_state`: `project_id text` primary key,
  `revision bigint not null default 0 check (revision >= 0)`, and millisecond
  `updated_at`. The row survives an empty Project and its clock never resets.
- `lookup_tables`: composite primary key `(project_id, id)` with server-defaulted
  UUIDv7 `id`; exact, case-sensitive unique `(project_id, tag)`; nonblank display
  `name`; nonnegative `definition_revision` and `rows_revision`; `row_count`
  constrained to `0..5000`; `column_count` constrained to `1..250`;
  `data_bytes` constrained to `0..8388608`; actor attribution; and millisecond
  timestamps. Table list order is
  `(lower(name), id)`; S01 persists no manual table order.
- `lookup_columns`: composite primary key `(project_id, table_id, id)`, UUIDv7
  identity, `wire_name`, display `label`, scalar `data_type`, and fractional
  `order_key collate "C"`; composite cascading table foreign key, exact
  per-table wire-name uniqueness, and `(project_id, table_id, order_key, id)`
  index. The scalar set is `text | int | decimal | date | time | datetime`.
- `lookup_rows`: composite primary key `(project_id, table_id, id)`, UUIDv7
  identity, `order_key collate "C"`, UUID-keyed `values jsonb`, actor
  attribution, millisecond timestamps, and `value_bytes integer generated always
  as (octet_length(values::text)) stored` constrained to `0..262144`; the same
  composite table foreign key, JSON-object check, and deterministic order index.

Tags are 1–32 ASCII characters matching `[A-Za-z_][A-Za-z0-9_]*` and may not
start with `xml` in any case. Column wire names use the same wire-safe grammar
with a 255-character Nova cap. Table display names and column labels are trimmed
to 1–120 characters. A table has 1–250 columns. Creation is atomic with at least
one initial column; S01 has no empty schema/draft state. Order keys contain only
Nova's base-62 alphabet, are nonempty/canonical (no trailing zero), are minted by
the server, and compare
under Postgres `C` collation exactly as they do in JavaScript. Full replacements
use a reusable balanced midpoint generator rather than the current sequential
5,000-key chain. Reads always order by `(order_key, stable UUID)`.

Row values key by immutable column UUID, never `wire_name`. A missing key means a
missing cell; JSON null, booleans, arrays, objects, and unknown column UUIDs are
invalid. Empty text remains representable through typed row writes. Integer is a
canonical signed base-10 int4; decimal is a canonical finite JSON number; temporal
strings reuse the strict date/time/date-time schemas already used by case data.
Every string cell is at most 65,536 UTF-8 bytes, every stored row is at most
262,144 bytes by its generated canonical JSONB text size, and the sum of
`value_bytes` in one table is at most 8 MiB. `data_bytes` is maintained exactly
under the locked table row on create/update/delete/replacement, so concurrent
writes cannot cross the cap; deleting or shrinking rows returns capacity. These
limits apply identically to typed writes and CSV replacement. S01 permanently
owns storage/import coercion; S05 owns expression and export semantics for
missing versus empty values and cannot reinterpret persisted row values. Writers
derive row deltas and replacement totals from SQL `returning value_bytes`; they
never estimate Postgres JSONB text size with `JSON.stringify` or `TextEncoder`.
Typed writes reject NUL and unpaired UTF-16 surrogates as `invalid_input` before
Postgres sees them.

`column_count` is likewise service-maintained under the locked table row: table
creation writes the validated initial count and its child columns atomically, and
add-column increments it only with the successful insert. S01 has no decrementing
operation. The count is not a trigger-maintained parallel authority; `lib/lookup`
is the only write boundary, matching the existing `row_count`/`data_bytes`
contract.

#### Revisions and transactions

`lookup_project_state.revision` is the sole Project-wide invalidation clock. Every
successful public mutation runs through `withAppTx`, locks or creates that Project
state row first, locks its table row second, validates against the locked current
definition, advances the Project clock exactly once, stamps the affected table
axis, updates `row_count` and `data_bytes`, and issues the S01a-owned `pg_notify`
helper inside the same transaction. Rejected and semantic no-op writes advance
nothing and notify nobody. The Project lock makes revisions commit-ordered;
unrelated Projects remain parallel.

Creation stamps both table axes. Definition/display/column/order mutations stamp
`definition_revision`; row create/update/delete/move/replacement stamps
`rows_revision`. `tableRevision = max(definitionRevision, rowsRevision)` is the
single optimistic token for every S01 table mutator. This deliberately conflicts
simultaneous schema and row edits on one table; the Project revision is not a
write-conflict token. All revision values are canonical nonnegative decimal
strings in the signed-int64 range `0..9223372036854775807` on application wires and
notification payloads, never JavaScript numbers or JSON `bigint`s and never
lexically compared.

Catch-up is level-triggered authoritative snapshot replacement, not event replay.
`getLookupManifest` returns one consistent snapshot containing the Project
revision and the complete current table UUID set with definition/rows revisions
plus column/row/data-byte counts. `getLookupTable` returns the definition, those counts,
and complete ordered row body from the same snapshot. Reads use one SQL-statement snapshot or a read-only
`REPEATABLE READ` transaction; ordinary multi-query `READ COMMITTED` snapshots
are forbidden because they can pair data N with revision N+1 and leave a client
permanently stale. S01 has no `lookup_revisions` log and no incremental
`listChanges` API. A future S02 hard delete advances the Project clock and appears
as absence from the complete manifest; stable UUIDs are never reused.

#### Authorization and service surface

`lib/lookup` is the only lookup persistence boundary. Every resource query is
structurally scoped by `(project_id, id)`; a missing UUID and a foreign-Project
UUID are the same not-found result. Browser calls send the Project ID displayed
by their URL/session state and authorize that exact ID freshly; a write never
re-derives the mutable active Project and silently falls back elsewhere.
`created_by`/`updated_by` are attribution, never access gates.

The existing Project capability map remains the only role authority:

| Operation | Capability | Roles |
|---|---|---|
| Manifest/table/row reads and realtime | `view` | member, viewer, editor, admin, owner |
| Create table/column with initial identity; display/label/order edits; all row operations and CSV replacement | `edit` | editor, admin, owner |
| Change an established table tag or column wire name | `delete` | admin, owner |
| Retype/remove a column or delete a table | unavailable in S01 | nobody |

The server-only service exposes consistent-snapshot reads; create/update table
display/identity; add/update/move columns; create/update/delete/move rows; and
atomic row replacement. It exports no destructive-schema operation. Thin
`"use server"` actions authenticate, runtime-parse all untrusted arguments,
freshly resolve the explicit Project capability, and return discriminated results;
they contain no database logic. S02 adds exact-reference locking before it makes
retype, removal, or table deletion constructible.

The exact S01 service surface is:

```ts
getLookupManifest(scope)
getLookupTable(scope, tableId)
createLookupTable(scope, { name, tag, columns })
updateLookupTableName(scope, { tableId, expectedTableRevision, name })
updateLookupTableTag(scope, { tableId, expectedTableRevision, tag })
addLookupColumn(scope, { tableId, expectedTableRevision, column })
updateLookupColumnLabel(scope, { tableId, columnId, expectedTableRevision, label })
updateLookupColumnWireName(scope, { tableId, columnId, expectedTableRevision, wireName })
moveLookupColumn(scope, { tableId, columnId, expectedTableRevision, toIndex })
createLookupRow(scope, { tableId, expectedTableRevision, toIndex, values })
updateLookupRow(scope, { tableId, rowId, expectedTableRevision, values })
deleteLookupRow(scope, { tableId, rowId, expectedTableRevision })
moveLookupRow(scope, { tableId, rowId, expectedTableRevision, toIndex })
replaceLookupRows(scope, { tableId, expectedTableRevision, rows })
```

`scope` is constructed server-side from fresh Project access and carries the
actor, exact Project, and resolved role. Target indices are integers; clients
never submit order keys. `values` is a full UUID-keyed row, not a patch.
Table creation returns its table snapshot. Add-column and create-row return the
server-minted stable resource UUID alongside the Project revision,
definition/rows revisions, and derived table revision; every other mutation
returns that revision receipt. A caller never waits for a realtime poke to learn
the identity it just created. Expected-revision drift returns the current
revisions without writing. Action results use stable codes
`unauthenticated | invalid_input | not_found | conflict | tag_taken | row_limit |
storage_limit | internal_error`; insufficient roles and nonmembership follow the
existing opaque `not_found` wire posture. The import route additionally returns
`invalid_csv` with structured details.

`replaceLookupRows` is server-only and intentionally has no Server Action
wrapper. The raw CSV route calls it directly after authentication, exact-Project
authorization, byte validation, parsing, and coercion; no browser can submit a
pre-parsed replacement array through the Server Action body path.

#### CSV boundary

CSV replacement is
`POST /api/projects/[projectId]/lookup/tables/[tableId]/import?expectedTableRevision=<decimal>` with raw
`text/csv; charset=utf-8`, not a Server Action, parsed rows, multipart, or a raised
global action-body limit. The route is main-host-only through the `/api/projects`
allowlist. It rejects a declared oversize before buffering, authorizes the exact
Project before parsing, checks actual bytes after buffering, and decodes UTF-8
fatally. Constants are 5,000 rows per table, 8 MiB per CSV, and at most 100
returned validation details while retaining the total count. The raw-file cap is
separate from the 64 KiB cell, 256 KiB stored-row, and 8 MiB stored-table limits;
an import must satisfy all four.

The parser accepts RFC-4180 commas, CRLF/LF, quoted separators/newlines, doubled
quotes, one leading UTF-8 BOM, and one final empty record caused by a trailing
newline. It rejects NUL, invalid UTF-8, unterminated quotes, interior blank rows,
inconsistent widths, and empty/duplicate/unknown/missing headers. Headers match
current column wire names exactly and resolve immediately to immutable UUIDs.
Source row numbers are one-based including the header. Empty CSV cells omit the
UUID key; nonempty text preserves whitespace exactly. Parsing, all coercion, and
error collection finish before the write transaction; the transaction then
requires the submitted `tableRevision`, re-reads the locked definition, and
revalidates before replacing anything. Any error or drift writes nothing and
emits no revision. Full replacement mints fresh row UUIDv7s and balanced keys in
file order; it never guesses identity from content or position.

#### Realtime, Project lifecycle, and rollout

S01a defines and emits `nova_lookup_stream` with payload
`{"projectId":"...","revision":"17"}` to the one process-wide dedicated
listener; S01b adds that channel to the listener's LISTEN set.
`subscribeLookupProject` fans Project pokes out in memory; notifications remain
wake-ups only. Listener reconnect serializes bounded closure of the old client
before opening its replacement, so transient overlap cannot exceed the exact
Cloud SQL connection budget. No second `pg.Client` is introduced.

The existing `/api/apps/[id]/stream` subscribes to the app's resolved Project
before its initial manifest read and emits `event: lookup-revision` with the full
manifest but **no `id:` line**. `Last-Event-ID` remains exclusively the app
mutation sequence. Pokes coalesce; a poke during a read schedules one follow-up;
a failed lookup-manifest read schedules an unref'ed retry whose delay is bounded
but whose attempts continue while the stream is alive, rather than exhausting a
finite budget and waiting forever for another notification. S01b applies the same
contract to the existing mutation pump: a failed accepted-mutation catch-up SELECT
must retry without requiring another commit, poke, or reconnect. A new poke while
a retry waits cancels the timer and runs catch-up immediately. Abort and
stream-cancel teardown clear both retry timers and both subscriptions. Reconnect
pokes every lookup subscriber, which re-reads the current manifest, so revision
jumps are expected and lossless.

`ReconcilerProvider` routes `lookup-revision` frames from that same EventSource
through a `subscribeLookupManifest` context seam parallel to presence. Lookup
manifests stay outside reconciler state: their Project revision is independent of
the app mutation `baseSeq`, and a lookup frame neither advances nor reseeds that
cursor. Between reload boundaries, the app-runtime broker retains the latest
validated manifest for immediate late-subscriber replay, latches one Project,
and ignores lower-revision or foreign-Project frames. Every reconciler reload or
view revocation clears the retained snapshot and Project latch and broadcasts
`null` to mounted consumers. A server reload or view revocation also clears the
last presence roster, and callbacks from superseded EventSource instances are
ignored before a replacement stream may establish a new Project lineage. A PUT
403 removes edit capability but does not clear read state for an actor who
remains an authorized viewer. This settles transport ownership and tenant-safe
handoff for S02/S09 consumers without opening a second stream or coupling lookup
snapshots to blueprint reconciliation.

Every true cross-Project app move is temporarily blocked in both the Server
Action, after source authorization, and the orchestrator, before media copying.
Same-Project calls retain the idempotent case-retenant recovery path. Lookup
resources are never copied or re-tenanted with an app. The existing move
affordance remains keyboard/touch discoverable as an informational popover with a
plain explanation that the app and shared data remain in their current Project;
it does not masquerade as an enabled move or rely on a disabled control's hover
tooltip. The target is at least 48 CSS pixels and uses existing semantic tokens,
visible focus, sentence case, and no new decorative motion. S02 replaces the
global block with the exact-edge rule: zero lookup references allows the move;
any reference blocks with actionable resource information under S02's lock order.
S02 also owns the live transport handoff for an admitted zero-reference move:
the open app stream must re-resolve and bind to the destination Project, replace
its lookup snapshot, and keep blueprint reconciliation live. A Project-scope
change is not an authorization revocation and must never set the reconciler's
permanent `revoked` state.

Project deletion is globally unavailable in the runtime Better Auth organization
plugin through `disableOrganizationDeletion: true`. This rejects both HTTP and
typed API deletion before session state or tenant data changes; it is not
conditional on lookup presence. The installed conditional hook clears the active
Project before it can veto and cannot close creation/deletion races. Deletion may
return only through a separately reviewed whole-tenant lifecycle covering apps
and history, cases and parked values, media metadata and GCS bytes, lookup data,
membership/session state, recovery, audit, and concurrent writes. S02 does not
implicitly re-enable it.

The migration is additive with no backfill. The prior Cloud Run revision ignores
the new tables and channel; the new revision starts only after the blocking
migration Job succeeds. Production rollback redeploys old code and leaves schema,
Project clocks, and Kysely ledger intact. `down` is local/test teardown only, in
child-to-parent order. Shipped migration code is immutable. The S01 move block
must be live before S02 makes lookup references constructible.

#### Files and verification

S01a adds the migration; `lib/lookup/{CLAUDE,types,constants,errors,schema,
coercion,csv,service,actions}.ts`; the raw import route; the lookup channel
constant and transactional notification helper; and focused tests. It
updates the migration registry, `AppDatabase`, the balanced order helper, root
and nearest subsystem guidance, Project-delete configuration/comments, app-move
policy/action/presentation copy, the main-host allowlist/proxy contracts, and this
roadmap. S01b updates the shared listener's LISTEN/fan-out behavior, app stream
relay, collaboration guidance, and their tests. Public authoring docs wait for S09
because S01 exposes no table-authoring UI.

Run all pure and Postgres-focused S01a tests in one Vitest invocation so the
16 GB machine boots one test container; include fresh migration/constraints,
tenant isolation, every role/operation, duplicate-tag concurrency, revision/no-op/
rollback, 4,999/5,000/5,001 plus concurrent row/byte-cap writes, exact cell/row/
table/column boundaries with capacity recovery, deterministic ordering, UUID
preservation/replacement, every coercion/blank rule, atomic CSV errors and
stale-schema conflict, route byte/auth/host gates, move-before-copy plus same-home
recovery, and deletion-without-session-mutation. Run typecheck and scoped lint,
then one affected async-leak pass. Interactively verify the temporary move state
at desktop and compact widths with pointer and keyboard before publication.

S01b's single focused invocation covers Project-filtered fan-out, coalesced
commits, forced listener disconnect plus a commit in the gap, serialized client
replacement, transient manifest-read retry, transient accepted-mutation-read
retry without a new poke, seq-less lookup frames preserving the mutation cursor,
revocation, abort-only/cancel-only cleanup, idempotent unsubscribe, the one-listener/
pool-size budget, and snapshot convergence. Then run typecheck, scoped lint, and
one stream/timer/DB async-leak pass. Each review unit separately receives diff
inspection, independent agent review, green CI, squash merge, blocking migration/
Cloud Run follow-through, production probes/error check, and branch/worktree
cleanup. S05 still owns the aggregate embedded-fixture budget.

### S02 — external validation, exact reference infrastructure, and move safety

S02 is infrastructure-only. It adds no constructible lookup carrier, table
expression, itemset, fixture emission, SA/MCP vocabulary, or public destructive
operation. S05 owns the first carrier schemas and wire foundations; S07 owns
runtime activation after preview and SQL execution are total. Until S07's rollout
gate opens, carrier commits, true cross-Project moves, and destructive
lookup-schema actions remain unavailable.

S02a shipped as PR #298 at squash `07c45ef6`: Cloud Build
`99ae1f72-048b-4515-8652-1f3caa669b99` ran migration execution
`commcare-nova-migrate-cccx4` successfully before deploying healthy 100%-traffic
revision `commcare-nova-00352-gpk`; production probes and the post-deploy error
query passed, and its branches/worktrees were cleaned. S02b then shipped as PR
#299 at squash `dd5fbecf`: all CI gates passed, Cloud Build
`22a9ca50-3dbb-4012-a363-fd5517d4f13c` ran migration execution
`commcare-nova-migrate-rnqqd` successfully before deploying healthy 100%-traffic
revision `commcare-nova-00353-plw`; app/docs/MCP contract probes passed, the new
revision had no error logs, and the read-only production edge audit found all
401 persisted apps clean. Its branches/worktrees were cleaned. S02c1 then
shipped in PR #300 at squash `81e5ad8b`, including authorization serialization,
runtime capability and stream admission, authoritative reload, and dormant
holder-generation safety; healthy 100%-traffic revision
`commcare-nova-00354-dq4` passed app/docs/MCP probes and its production error
check. S02c2 shipped in PR #301 at squash `e9a6377a`: Cloud Build
`030b9622-1aaf-43b2-8137-7ef4a4615f74` completed its blocking migration
execution and deployed healthy 100%-traffic revision
`commcare-nova-00356-q6p`. S02c3 shipped in PR #304 at squash `97591f10`
through Cloud Build `c0b35218-5c0f-4d68-ab7e-0932d000aa13`, successful
migration execution `commcare-nova-migrate-b6whk`, and healthy 100%-traffic
revision `commcare-nova-00358-clk`. Production app/docs/MCP probes and the
revision error-log check passed. S02 is shipped.

#### Identity, context, and extraction

Define runtime UUIDv7 schemas and distinct `LookupTableId`, `LookupColumnId`, and
`LookupRowId` brands in an import-light `lib/domain` leaf. All public lookup
definition/service projections use those identities, and no API accepts table,
column, and row ids interchangeably. `lib/lookup` may import this leaf, but
`lib/domain` never imports `lib/lookup`. `LookupRevision` and definition-snapshot
projections remain in client-safe `lib/lookup/types`; `LookupValidationContext`
lives at the validator/doc boundary. Tags, names, labels, and wire names remain
mutable projections, never identity.

Add a rows-free definition snapshot separate from the strict realtime manifest:

```ts
type LookupValidationContext =
  | {
      kind: "available";
      projectId: string;
      projectRevision: LookupRevision;
      definitions: readonly LookupTableDefinition[];
    }
  | { kind: "unavailable" };
```

Each definition contains stable table and column UUIDs, current display/emission
projections and types, and `definitionRevision`, but no rows. Do not widen the
existing `LookupManifest` frame: caches fetch definitions separately, invalidate
by definition revision, and generation-guard late reads across Project changes.
`getLookupDefinitions(scope, sortedTableIds)` returns exactly the requested
definitions; an absent requested UUID represents missing-or-foreign. Its Project
revision, definition revisions, tables, and columns come from one SQL-statement
snapshot or one read-only `REPEATABLE READ` transaction. Ordinary multi-query
`READ COMMITTED` assembly is forbidden.

The context argument is required at every lookup-aware validation and export
boundary. `unavailable` is never an empty registry or permission to skip rules:

- a pure whole-document validation/export call given an explicitly unavailable
  context produces `LOOKUP_CONTEXT_UNAVAILABLE` for each stable carrier slot;
- optimistic clients hold or reject lookup-changing batches while context is
  unavailable, while unrelated edits still receive the server verdict;
- server commit and export boundaries load fresh context themselves; an
  operational definition-read failure throws and writes/emits nothing rather
  than being recast as a document finding. Only SQL states already classified by
  `withAppTx` as retryable are retried automatically;
- missing and foreign-Project ids produce the same not-available result;
- previous and candidate documents validate against the same fresh snapshot;
- finding identity includes carrier UUID, registry slot, nested subpath, table
  UUID, and column UUID when present, so one old dangling ref cannot mask a new
  one.

The stable S02b codes are `LOOKUP_CONTEXT_UNAVAILABLE`,
`LOOKUP_TABLE_NOT_AVAILABLE`, `LOOKUP_COLUMN_NOT_AVAILABLE`, and
`LOOKUP_COLUMN_TYPE_MISMATCH`. They use introduced-error/soundness delta
semantics: an unrelated edit may leave an existing lookup finding in place, but
may not introduce a new occurrence. Missing and foreign definitions remain the
same not-available shape.

Context and revisions never enter mutations or `accepted_mutations`; replay
remains reducer-only. S02 adds a normalized target-set and edge-materializer seam,
but registers no production `BlueprintDoc` extractor or lookup target arm in the
derived reference index. The seeded race invokes that same package-private
materializer with synthetic table/column target sets after taking the production
locks. S05 registers the first carrier extractors, extends the derived reference
index, and owns incremental-versus-rebuild fuzz parity.

#### Exact edge storage

Persist two normalized app-to-resource sets, not occurrence-level document paths:

```text
apps
  UNIQUE (project_id, id)

lookup_table_references
  project_id text NOT NULL
  table_id uuid NOT NULL
  app_id text NOT NULL
  PRIMARY KEY (project_id, table_id, app_id)
  FK (project_id, table_id)
    -> lookup_tables (project_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
  FK (project_id, app_id)
    -> apps (project_id, id)
    ON UPDATE RESTRICT ON DELETE CASCADE
  INDEX (app_id, project_id)

lookup_column_references
  project_id text NOT NULL
  table_id uuid NOT NULL
  column_id uuid NOT NULL
  app_id text NOT NULL
  PRIMARY KEY (project_id, table_id, column_id, app_id)
  FK (project_id, table_id, column_id)
    -> lookup_columns (project_id, table_id, id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
  FK (project_id, table_id, app_id)
    -> lookup_table_references (project_id, table_id, app_id)
    ON UPDATE RESTRICT ON DELETE CASCADE
  INDEX (app_id, project_id)
```

Every column target emits its exact column edge and implied table edge. Carrier
UUID, registry slot, and nested subpath stay in structural extraction, finding
identity, and the actionable fresh re-walk; SQL does not duplicate
document-layout identity.

Every authoritative app write replaces the app's complete edge sets from the
fresh candidate in the same transaction. Never apply caller-provided edge deltas.
Soft-deleted/restorable apps retain edges until physical deletion.

#### Transaction and lock order

Lock resource UUIDs lexically. The global protocol is:

1. An app writer locks `apps ... FOR UPDATE`, deduplicates and reauthorizes,
   hydrates the fresh document, and applies the mutation batch exactly once.
2. It collects the union of previous and candidate table targets, then locks
   those Project-scoped table rows `FOR KEY SHARE`; definition writers use the
   same table row `FOR UPDATE`, freezing columns and projections.
3. It loads one exact definition context, validates previous and candidate,
   replaces both edge sets, then writes entities, app sequence, permanent
   mutation, and notification atomically.
4. Resource writers lock `lookup_project_state FOR UPDATE`, then the target
   table `FOR UPDATE`, inspect exact edges, mutate children/data/counters,
   advance the Project clock once, and notify.
5. A transaction that begins at a Project/table lock never later takes an app
   lock.

This covers guarded autosave/chat/MCP, synthetic migrations, and Project flips.
Synthetic migrations and recovery writers use the guarded path and advance the
app sequence; a direct entity-table write is additionally covered by the
database compatibility floor below. Split candidate preparation from verdict
evaluation so no reducer that can mint UUIDs is applied twice. S02 proves both
seeded introduction-versus-delete winner orders through the production lock/
edge protocol; S05 repeats them using real carriers.

Authoritative mutation payloads are replay-deterministic: every identity they
create is carried in the payload. `duplicateField` remains a UI-only gesture;
autosave lowers its resulting document diff to deterministic `addField`
mutations, and a server persistence boundary rejects the reducer-minted form.
For ordinary writes, “apply once” means one candidate preparation per retryable
transaction attempt after the app lock; evaluation never invokes the reducer.
A SQL retry may replay only that deterministic payload against its newly locked
basis. Any pre-transaction case-schema projection is advisory and consumes only
deterministic batches.

Atomic creation is the sole app-lock exception. It constructs and applies its
seed exactly once outside the retryable transaction closure. Inside one
transaction it declares the writer version, freshly authorizes the exact Project,
inserts the still-uncommitted app row as its serialization root, locks candidate
lookup tables `FOR KEY SHARE` in UUID order, loads fresh context, validates, and
inserts entities and exact edges. Any failure rolls back the app insertion. S05
uses this same path for carrier-bearing seeds.

A legacy app with `project_id = null` receives an unavailable lookup context and
may commit only an empty structural target set; an authoritative write still
clears any stale stored edges. During S02b the dormant Project-move writer
declares writer v0 and permits a Project flip only when structural and stored
lookup target sets are both empty, clearing source edges before the flip. S02c
replaces that restriction with the complete dual-Project protocol.

#### Schema behavior

Display-name, label, table-tag, and column-wire-name changes remain allowed while
referenced. They serialize on the table lock, advance `definition_revision`, and
rewrite neither UUID references nor edges. Name/label uses `edit`; established
tag/wire-name policy uses `delete`. HQ's immutable-tag PUT constrains later sync,
not Nova identity.

Table deletion, column removal, and column retype require `delete` plus zero
applicable edges and remain runtime-disabled until S07 activation:

- admitted table deletion hard-deletes its rows/columns, retains Project state,
  and advances the Project clock once;
- admitted retype performs no coercion: every present typed value must already
  satisfy the target type or the transaction rejects;
- admitted removal explicitly deletes that UUID key from every row, derives byte
  deltas in Postgres, maintains counters, and reports affected rows/cells and
  freed bytes. It rejects removal of the last remaining column before touching
  rows: a table always retains 1–250 columns, and deleting the table is the only
  path to no schema. S09 owns confirmation UX.

S02b implements those operations only as package-private governance. Its
production wrapper declares shared writer v0, locks the compatibility row
`FOR SHARE`, and fails closed while the activation flag is false; it never
smuggles a local writer-v1 override past the rollout floor. The transaction core
is integration-tested under explicit writer v1 plus enabled compatibility.
Column removal advances both definition and rows revisions because it changes
schema and row JSON. Blocker diagnostics return exact app ids only; the
actionable carrier re-walk belongs to S09 and never reverses the resource-to-app
lock order.

The neutral export boundary has three explicit modes: `ccz`, `hq-json`, and
`hq-upload`. It loads definitions even for an empty target set, validates with
one exact rows-free snapshot, and returns that snapshot with prepared resources
so S05 emission cannot read a different definition generation. Operational
definition-read failures propagate and stop before expansion, compilation, or
HQ import; they are never recast as unavailable-context findings. Local CCZ may
gain embedded fixtures in S05, while HQ JSON/upload remain blocked until their
later rollout contract permits them.

#### Cross-Project moves and transport

S02 builds and tests the final move path but leaves true moves disabled through
S07 activation. Governance is source `delete` plus destination `delete`, repeated
inside the transaction with IDOR-opaque failures. A source owner may relocate to
any destination where they hold `delete`; a non-owner source admin may do so only
when every source owner remains a destination member. The production wrapper
rejects while `project_moves_enabled = false` before resolving/copying media or
performing any other side effect. Only a package-private transaction core may be
exercised in S02c tests, under explicit writer v1, receiver v1, enabled
compatibility, and no active incompatible lease. A true move also requires the
locked app to have `deleted_at IS NULL`.

All Project-membership DML and membership-dependent app transactions share one
fixed transaction-scoped advisory gate. The import-light helper owns one stable
namespace/key: Better Auth membership `INSERT`, `UPDATE`, and `DELETE` take its
**exclusive** transaction lock through a `BEFORE STATEMENT` trigger,
while app transactions take its **shared** transaction lock before any
membership-dependent read. In S02c1, a separate `BEFORE TRUNCATE` statement
trigger raises SQLSTATE `55000` once reached without waiting on the advisory
gate. Ordinary table-lock waiting still applies: Postgres acquires
`ACCESS EXCLUSIVE` before that trigger, so advisory waiting there would permit a
table-lock/advisory-lock deadlock. Because production currently uses one
database-owner principal for migrations and runtime, this trigger is an honest
operational barrier, not a privilege boundary an owner could not disable. S02c2
separates the runtime/auth database identity from the migration owner and
revokes `TRUNCATE` from the runtime identity while retaining the trigger as
defense in depth. Never use a row trigger that first holds a
tuple and then waits on the gate. Install the triggers through Nova's auth-app
migration phase after Better Auth owns the tables, never by editing a shipped
migration or through the earlier case-store migration phase. The shared gate is
required for move and stream registration, actor-scoped case/presence writes, app
creation/commit, run claim/reserve, and soft-delete/restore; authorization
outside the write transaction never decides their admission.

A migration-bearing blueprint write captures the caller's Project with its
source snapshot, then runs `apps FOR UPDATE` -> shared membership gate -> fresh
`edit` authorization -> every sorted `(caseType, property)` schema/data Phase A
on one physical connection and transaction. All Phase As commit or roll back as
one unit. Only after that commit may concurrent-index Phase B run; the later
blueprint transaction must compare the same expected Project and freshly
authorize again. An admission denial, Project mismatch, Phase-A error, or outer
commit failure invokes no compensation because no schema/data work became
durable. A Phase-B or blueprint-commit failure compensates every recorded
durable report. This single-connection split is required: nesting the existing
schema transaction behind an app lock can exhaust the small shared pool while
membership/move waiters occupy the remaining connections, and concurrent index
DDL is illegal inside a transaction.

After `apps FOR UPDATE`, the move takes the shared gate, then uses the same
database transaction to discover and lock the actor's source/destination
membership rows and every source-owner/source-and-destination membership pair
`FOR SHARE`, ordered by `(project_id, user_id)`. It re-evaluates source `delete`,
destination `delete`, caller-is-owner, and owner retention from those locked
rows, and fails closed if the source Project is ownerless. No
`projectRoleFor`/`getAuthDb` read outside that transaction decides admission.
Race source/destination role downgrade, membership removal, owner removal,
concurrent owner insertion, soft-delete, and restore against the move in both
winner orders.

Admission derives only from `runLeaseState(fresh)`: `mode === "none"` proceeds; a
recent live or paused holder returns busy; `reapableStaleBuild` or
`reapableStrandedEdit` is normalized by its canonical reaper outside the
retryable move transaction, after which the move retries and rechecks under the
app lock; a present holder that is neither active nor canonically reapable fails
closed as corrupt. Reapable classification precedes paused/live classification
so a stale paused holder remains reapable. The orchestrator uses a bounded retry
around a result-bearing canonical reaper; swallowed reaper failures never imply
success. A claim winning between reap and retry makes the retry busy.
Fresh structural targets and stored edge targets must match exactly and both be
empty. Lookup resources are never copied, re-tenanted, or implicitly rebound.

Every actor-initiated case mutation, including close, sample-data writes,
restore, and parked-value dismiss/replace, uses one shared-Postgres transaction
with lock order `apps FOR SHARE` -> shared membership gate -> fresh
Project/membership check -> existing relationship advisory lock -> schema lock
-> case rows. Multi-schema writes lock every distinct schema row in sorted order
before the first case write. Patch/update discovers immutable `case_type`, then
locks and re-reads the case `FOR UPDATE` before merging, so concurrent patches
cannot overwrite each other. Parked-value replacement and dismissal share one
transaction-aware update core and either both commit or both roll back.
System-authorized schema materialization, healing, compensation,
and row migration do not invent an actor capability; they still take
`apps FOR SHARE`, bind the current Project inside the same transaction, and
lock all schema rows in sorted order before case and parked-value rows so a move
cannot strand rows. S02c makes each individual store operation tenant-safe; S06,
not S02c, owns the full
form-submission atomic envelope. A move between two submission sub-operations is
allowed only when the first committed rows move and the second freshly binds or
fails safely. Presence upsert/delete uses
`apps FOR SHARE` -> shared membership gate -> fresh scope/membership -> presence
row -> transactional `pg_notify`. The move uses `apps FOR UPDATE`, updates every
case row for the app whose Project is null or differs from the destination,
purges all presence, writes the migration row, and emits app/presence
notifications before that same
commit. Media may copy non-destructively beforehand, but its blueprint remap,
the Project flip, case-row tenancy, presence purge, migration row, and
notifications commit atomically. Pre-copy fails unless every real source asset
is ready, source-Project-owned, and movable; the final transaction locks and
revalidates every destination asset and creates destination reverse references.
Threads are app-owned history and move with the app; the S07 activation UI and
public docs must disclose that both conversation history and chat-attached files
move to the destination Project. The move's media closure is therefore the union
of blueprint references and canonical
`threads.messages[*].metadata.attachments[*].assetId` references, not the
blueprint alone. Pre-copy includes present, ready source-Project chat assets of
every media kind. A document carries only a published `ready` extraction
object/metadata pair — never an `extracting`/`failed` status that has no
destination job — and an equal/newer destination extract state wins over an
older copy. Move-copy verifies the destination's versioned object before
adopting ready sibling metadata; if those bytes are absent, it repairs the pair
from the source and synchronizes all non-newer duplicate rows. A historical
attachment that is already missing, deleted, or foreign
remains an unavailable transcript reference and does not block the move. In the
final app-locked transaction, lock the app's threads in deterministic `thread_id`
order, re-walk their canonical attachment references, revalidate every required
destination copy, and rewrite only each attachment's `assetId` through the same
deterministic source-to-destination map used by the blueprint. Preserve message
IDs, parts, order, filename, MIME type, title, and summary. The thread rewrite
commits atomically with the blueprint remap, Project flip, case tenancy,
presence purge, migration row, and notifications. Thread writers serialize
app-first against the move and treat stored attachment metadata as authoritative
for existing messages, so a stale full-history chat POST or run finalization
cannot restore source asset IDs. Destination reload rehydrates the active thread
and thread list before attachment preview or sending is re-enabled. Cover a
chat-only image and document absent from the blueprint, shared-source retention,
destination deduplication, extraction copy, non-blocking missing/foreign history,
new-turn/finalize versus move in both winner orders, stale-history replay, and a
destination transcript preview plus next SA turn consuming the copied ID/content.
Every authoritative app/document writer computes newly introduced real asset
references, locks those asset rows `FOR SHARE` in sorted order, validates current
Project/readiness, and inserts reverse references in the same app transaction;
the existing post-commit sync may clean removals but is no longer a correctness
boundary. Both browser and SA media deletion paths share one transaction
containing the shared membership gate, fresh Project `edit` authorization,
asset `FOR UPDATE`, a re-walk of every persisted app carrier in that Project,
including soft-deleted app rows whose exact blueprint may be restored,
and metadata deletion, so delete-versus-attach/move is serialized. SA
working-document state never exempts its persisted app from that re-walk. The
deletion path never acquires app locks after taking the asset lock; app writers
serialize against it through their introduced-asset `FOR SHARE` locks. The
reverse index may narrow candidates only after an audited backfill plus durable
completeness marker proves it authoritative; until then deletion never trusts
it as a complete set. GCS byte cleanup remains post-commit but obtains a dedicated
session advisory lock derived from the extension-independent Project/content
hash, rechecks exact base-object and `(Project, hash, extract version)` sibling
metadata separately under that lock, and deletes each only when unshared.
Upload, copy, and ready-finalization hold the same content lock across object
publication and committed ready metadata, preventing a new ready row from
pointing at bytes a concurrent cleanup removes. Document extraction terminal
publication rechecks its exact `(version, model, extractedAt)` claim under the
row lock before writing GCS, and claim admission refuses to overwrite any
higher-version state from a newer server. A committed ready
`(Project, hash, version)` pair is canonical: duplicate/cross-extension rows and
Project-copy adopt its object plus exact metadata instead of overwriting it, and
the first publisher synchronizes all non-newer duplicate-row states before
commit. Thus delete-first cannot recreate an orphan, copied equal/newer state
fences a stale model job, and a rejected metadata transaction removes its
unpublished object unless a committed deduplicated sibling already names that
Project/hash/version. Same-Project repair takes the app lock,
derives and matches the fresh app Project rather than trusting a caller value,
and repairs case tenancy only: it writes no migration row and purges no presence.
Cover case/presence/media writer-wins and move-wins, notification visibility only
after commit, and same-Project-repair versus true-move winner orders.

A migration remains a normal `accepted_mutations` row at app sequence `M`; its
terminal SSE `reload` or `revoked` frame carries no `id:`. Before setting
`deliveredThrough = M`, the stream freshly resolves scope. Authorized same-
Project or destination access emits reload and closes; confirmed `AppAccessError`
emits revoked and closes; a transient failure retains the prior cursor and
retries row `M` with bounded backoff. Reload GET returns authoritative Project,
role, `canEdit`, and a blueprint with its exact current `baseSeq = N >= M` from
one snapshot; exactly one replacement EventSource opens with `?since=N`. Thus an
`M+1` commit before the reload GET is already in the snapshot, while a later
commit is caught by the new stream. Lookup, presence, reload, and revoked frames
never own `Last-Event-ID`. Stream registration captures Project, role, and
`canEdit`; cadence re-resolves all three and emits a terminal seq-less reload on
any authorized Project/role/capability change, while loss of `view` alone emits
revoked. Client reload clears lookup/presence/definition caches before
destination subscription, accepts a lower destination revision, rejects late
source reads, and preserves/surfaces unsaved work. `canEdit` is one mutable
client capability, separate from view revocation: a destination or same-Project
viewer keeps the subscription and displayed pending work but stops PUT retries;
a later editor upgrade automatically resumes eligible pending sends. True view
loss revokes and clears tenant state. A PUT 403 applies that read-only transition
immediately, then enters the same serialized authoritative-reload path: it
closes/disowns the current EventSource, fetches the atomic snapshot, refolds all
pending/human work, and opens exactly one replacement from that snapshot's
`baseSeq`. The snapshot's absolute `canEdit` value either keeps sends paused or
resumes them. This closes the downgrade -> PUT 403 -> upgrade-before-cadence
race, where registration and cadence would otherwise both observe `editor` and
leave the client permanently read-only. A transient reload failure keeps work
read-only and retries without reopening from a stale cursor; confirmed loss of
`view` still revokes. S02c owns one Project-scope reset/generation
seam for the caches that exist now; S05 plugs its definition cache into that seam
before carriers activate. Cover the `M+1`-before-GET race,
destination editor/viewer, source-only, same-Project migration, transient
failure, downgrade/upgrade with retained pending edits, and one-EventSource
ownership.

#### Rolling capability and rollback floor

Receiver capabilities are cumulative and separate from writer/runtime versions:

- v0 is omitted, malformed, or pre-registry;
- v1 is S02 Project reload/reset safe and is the minimum for a move;
- v2 can parse, preserve, and replay dormant S05 lookup carriers, but does not
  admit their commits;
- v3 is the S07 total browser receiver, including every client-side committed-
  state consumer and preview execution, and is the minimum for a carrier commit.

Every browser EventSource URL carries exactly one `receiverVersion` declaration
from that browser bundle's compiled capability manifest. Missing, duplicate,
or malformed declarations are v0. A serving revision supports the minimum of
its compiled receiver and its strictly parsed deployed-environment declaration,
and supports only v0 unless both compiled and deployed stream-registry versions
are at least 1. The lease admits the minimum of browser and serving support, so
a new server cannot attribute v1 to an old open browser bundle.

Add a durable stream-capability lease keyed by app and a database-minted
connection UUID; the server never accepts client-asserted connection identity.
Registration commits before the first frame: lock `apps FOR
SHARE`, take the Project membership serialization lock, freshly resolve
scope/view authorization in that transaction, lock the compatibility-state row
`FOR SHARE`, reject a receiver below its persistent floor, and insert the lease.
Carrier commits and moves hold `apps FOR UPDATE` while reading the same state and
the app's unexpired leases. This serializes registration with admission.
One version-controlled runtime-capability manifest owns the deployed reader,
receiver, stream-registry, and writer versions plus a 3,600-second Cloud Run
request cap, a 300-second `stream_lease_grace`, the distinct 15-minute renewable
edit-run liveness lease, and the 10-minute renewable build-staleness horizon.
Cloud Build pins `--timeout=3600`; server route, leases, deploy labels, and
operations tooling derive from the same manifest rather than duplicating the
values. Only `streamLeaseTtlSeconds` derives as request cap plus stream grace,
exactly 3,900 seconds; neither run-liveness clock derives from it. Teardown
first disowns/closes the transport, then best-effort deletes its own lease, while
expiry covers crashes and cleanup failure without expiring a still-live request.

**S02c1 implementation status (2026-07-22):**
Shipped in PR #300 and deployed by Cloud Build as revision
`commcare-nova-00354-dq4` at 100% traffic. Production verification covered the
main, docs, and MCP host contracts, the blocking migration execution, revision
health, and an empty ERROR-level revision log query. The production
compatibility state remained intentionally dormant: every floor was `0`, every
activation flag was false, there were no runtime epochs or active stream
leases, and seven present legacy holders remained visible as v0 blockers.
`config/runtime-capabilities.json` is now the strict, version-controlled source
for writer `0`, stream receiver `1`, runtime reader `1`, stream registry `1`,
the 3,600-second request cap, the 300-second stream grace, the independently
declared 900-second renewable edit lease, and the independently declared
600-second build-staleness horizon. The browser-safe shared parser produces
canonical bytes and rejects an invalid checked-in manifest; a Node-only leaf
hashes those bytes for the manifest identity. Missing/malformed revision label
or environment version declarations read as v0. Only request cap plus stream
grace derives the 3,900-second stream lease; `lib/db/constants.ts` projects the
two run-liveness fields to its legacy minute-valued API without authoring either
value. Cloud Build validates the manifest and bakes its generated declarations
into the image; Next's two required static route literals and the writer
declaration are guarded against drift. The pure server receiver resolver now
enforces exact-one browser parsing and the browser/compiled/deployed minimum.
The stream route uses it after session authentication and registers a
database-minted lease in the same app, membership, and compatibility lock set;
below-floor requests receive only the terminal seq-less upgrade revocation.
Lease timestamps use PostgreSQL statement time after lock wait, teardown
deletes the exact lease only after disowning the transport, cadence compares the
captured Project/role/canEdit tuple without re-reading the floor, and migration
delivery reauthorizes before advancing its cursor. Registration also performs a
separate best-effort purge of at most 256 expired leases through the
`expires_at` index with `SKIP LOCKED`; purge failure cannot roll back or reject
the already-decided admission. `ReconcilerProvider` now appends the manifest's
compiled receiver version to every EventSource URL, so new browser bundles
declare v1; already-open pre-wiring bundles still declare v0 by omission. This
foundation does **not** change traffic, raise a floor, or enable a flag. S02c2
hardens the ordinary Cloud Build → blocking migration Job → Cloud Run deploy
path, pins the request timeout, and verifies the baked manifest/build identity
at startup. It does not add a Nova-specific traffic control plane.

The runtime-holder callsite slice is now source-complete too: every current
holder-touching transaction declares runtime reader v1 before DML, including
creation, claim/replacement, reservation, paused reacquisition, same-holder
blueprint commits, heartbeats/pause writes, and terminal/failure/reaper/recovery
paths. Each claim mints a private UUID generation stored beside stable `runId`
attribution.
`runHolderWrites.ts` is the shared SQL compare-and-set boundary for terminal,
failure, pause/heartbeat, recovery, and reaper writes. Reaper scans and queues
carry the concrete holder they observed instead of a bare app id, and credit
reapers roll ledger changes back if the admitted app-row write affects zero
rows. A missing run id remains corrupt; a concrete run id with null nonce is a
legacy v0 holder that remains census-visible and reapable during the rollout.
`recover-app` has no direct app writer: a present holder requires explicit
matching mode, run-id, and UUID nonce flags, and the database service re-proves
that exact generation under lock and in SQL.

Nonce storage is intentionally non-activating. The irreversible
`run_holder_nonce_enforced` compatibility switch defaults false, so runtime
admission and CAS still honor legacy `(mode, runId)` and accept an old paused
browser continuation with no nonce. Such a v0 resume upgrades itself with a
server nonce in the same app-locked write. The holder-stamp trigger includes the
pause/lease columns used by the deployed v0 resume (`awaiting_input`,
`lock_expire_at`, and `updated_at`). Deployed v0 sets no runtime GUC, so the
trigger treats an absent declaration as v0 and clears any inherited nonce/stamp
even when stable mode/run identity did not change. After a later total-consumer
activation unit drains the request epoch, v0/null-nonce holders, and old
receiver leases, it may raise the runtime-reader floor and enable the switch;
from then on, missing/mismatched nonces fail closed with an explicit refresh.
S02c2 deliberately exposes no floor-raise or nonce-activation command and has
no database privilege to perform either. Focused
pure/integration tests and the app-DML structural guard ship with the slice;
execution remains part of the integration/CI verification gate. This work
changes no floor, switch, traffic, or production state.

Chat blueprint writes now carry an explicit `ChatRunHolderCapability` in
addition to their durable attribution `runId`; MCP continues to stamp `runId`
without claiming chat-lease authority. The capability includes the private
nonce generation. It is sent live to the authenticated POST caller but is not
stored in the view-scoped durable chunk log: that log carries an inert,
count-preserving thread-id + SHA-256-digest marker, and reconnect rehydrates it
from the retained thread nonce and current app holder only for the owning actor.
The digest prevents an old same-run stream from receiving a successor
generation. Direct commits check the
compatibility-admitted projection under the app lock and repeat it in
`writeCommittedBatch`'s SQL compare-and-set;
once activated, that is the exact `(mode, runId, nonce)`. Migration-bearing
commits check the same capability before
their locked Phase A; if ownership changes after Phase A, the final guarded
commit rejects and the existing compensation restores the current committed
schema/data shape. Thread-marker persistence likewise locks the app, reads the
compatibility switch, and proves the admitted holder before locking the thread.
A loser may merge real transcript content into an existing same-app thread, but
cannot install or clear the successor's run/stream/nonce marker; it terminates
after that merge commits. Every build claim stamps root `run_id` immediately,
so a successor that emits no mutations still invalidates an older zombie after
the successor is reaped. The only absent-holder completion remains the existing
false-reap self-heal: it requires a free error row, a marker that the reaper
itself cleared, and matching root `run_id`. A pre-settled stale build retains
`res_run_id`, deliberately does not satisfy that signature, and is not
self-healable.

The S02c1 client foundation now carries the RSC authorization tuple and cursor
as one snapshot, owns one reactive BuilderSession capability/phase/Project
generation, and bridges that capability into the document mutation gate. Every
reload trigger synchronously pauses writes and fans the new generation through
the Project-scope reset registry before one atomic GET. Its implemented reset or
generation-keyed owners cover lookup and presence; session run, media, and case
payloads; case binding and query promises; media list, transfer, extraction,
deletion, and decoded-element resources; chat attachment preparation and
retained transcript references; destination-authoritative active-thread
hydration; Project toasts; and builder history. Every async completion is
abortable or checks its captured runtime generation before publishing. The S05
definition cache must join this same registry before carriers activate. PUT 403,
404, and `app_changed` preserve pending work and enter that reload; only typed
`commit_rejected` drops one batch. A confirmed GET/view loss is terminal. Every
EventSource URL declares the compiled receiver version; an upgrade rejection
masks and clears Project state before one session-latched hard refresh, then
falls back to a distinct blocking refresh-required screen instead of looping or
misreporting access loss. The public Projects guide now labels Project moves as
staged/unavailable while `project_moves_enabled` remains false; S02c3 replaces
that notice with the final workflow only when activation is real.

SA runs can outlive the browser connection that started them, so request and
stream bounds alone cannot prove a runtime-reader drain. Every app run holder
stores the runtime-reader version declared transaction-locally by its claimant;
missing/unset is v0. The database owns the holder-identity state machine, using
the effective `(mode, runId, nonce)` derived from locked run fields: edit uses
`lock_run_id`; build uses `res_run_id`, falling back to root `run_id` only for
the just-created pre-reservation generating state. A v1 declaration identifies
the current writer, not ownership of an unchanged holder. Below cutoff, an exact
unchanged legacy holder therefore remains v0 and census-visible; a below-floor
old stamp fails after cutoff. Only a new/replaced v1 holder requires a concrete
run id + nonce and stamps the transaction-local version. An undeclared
holder-touching write is deployed v0 and clears any inherited nonce/stamp even
when stable thread attribution leaves mode/run unchanged. Every current
same-generation heartbeat explicitly declares v1 and preserves the admitted
existing stamp; an identity-owned terminal transition declares v1, clears the
stamp, and retains the nonce tombstone. Every terminal/failure/reaper API
includes the expected holder identity in its locked conditional write, so a
stale writer affects zero rows and cannot clear or fail a replacement holder.
Runtime-floor status combines that stamp with fresh `runLeaseState`; every
present holder carrying a
missing/below-floor version blocks activation, including live, paused, reapable,
and corrupt-present states. Old code cannot evade the model:
before a floor raise it leaves the v0 stamp, and after a floor raise its claim
fails closed. Thus an old detached run remains visible even after its initiating
HTTP request ends; `MAX_RUN_MINUTES` remains a renewable edit-liveness lease,
never an absolute deployment-drain bound.

Pre-registry draining starts only after `continuous_registry_traffic_since`
marks uninterrupted 100% registry-capable traffic. For the initial v0 cutoff,
that interval must first reach 3,900 seconds, so no invisible pre-registry stream
can remain. Raising `minimum_stream_receiver_version` is an admission cutoff only;
it never activates vocabulary. The compatibility-state transaction raises the
receiver floor while every feature flag stays disabled. A concurrent lower-
version registration either commits first and becomes part of the bounded drain,
or observes the new floor and receives no state/lease. After the cutoff, wait the
3,900-second cap-plus-grace interval and require no unexpired lower-version lease.
Any reconnect below the floor receives the v0-understood terminal `revoked`
frame with reason `client-upgrade-required`, consumes no blueprint, destination,
or history frame, closes without retry, clears/freezes Project state, and
requires a hard refresh.

v1 is sufficient for moves; receivers below v2 block the S05 preservation floor,
and receivers below v3 block S07 carrier activation. Cover both registration/
admission winner orders, abort cleanup failure, old-server overlap, and the
forced-refresh no-loop path.

The already-landed runtime traffic-epoch and holder-census primitives remain
dormant database safety inputs; S02c performs no runtime-floor prepare or raise.
Nova does not build a reusable traffic controller merely to exercise them. If a
future feature genuinely requires an irreversible nonzero floor, that change
must make a fresh product decision between a maintenance cutover and additional
rollout machinery based on then-current traffic and downtime requirements.

Add persistent lookup-reference compatibility state with monotonic
`minimum_writer_version`, `minimum_stream_receiver_version`, and
`minimum_runtime_reader_version`, plus initially-false carrier-commit,
schema-action, and Project-move activation flags. Build revisions declare their
supported versions, including stream-registry support; a missing or malformed
declaration is zero. The service keeps its default `run.app` URL disabled. Its
strengthened `/warmup` startup probe fails on a malformed baked declaration,
build-identity override, or database unavailability; Cloud Run waits for that
probe before moving traffic through its standard deployment path. S02c ships
with all floors at `0` and all activation flags false and performs no production
floor raise. Deploying code alone never activates vocabulary.

S02c2 also closes the current unknown-Host bypass in the multi-host proxy:
production accepts only the three configured public hosts plus the platform's
exact `/warmup` startup probe; any other host/path pair returns 404 before the
generic API short-circuit. Localhost affordances remain development-only. This
keeps the hostname allowlists a real security boundary even when the external
load balancer receives a forged HTTP `Host` value.

Deployment identities split into build, migration, and runtime roles. Migration
owns fixed schema objects. Runtime receives ordinary application DML but not
ownership of auth/control tables. The one documented exception is `cases`:
runtime schema materialization still creates and drops indexes concurrently, so
that table lives in an isolated runtime-owned schema where the web process may
create indexes without receiving DDL authority beside fixed objects in `public`.

The database writer guard covers app insertion, every `blueprint_entities`
write, `accepted_mutations` insertion, mutation-sequence/Project-id advance, and
destructive lookup-table/column writes. It reads a transaction-local version,
defaulting to `0` when unset; pooled transactions must prove the setting neither
leaks nor survives commit. S02b's reference-aware writers explicitly declare
version `0`; S05 changes the one shared writer constant to `1` before registering
real extractors. A direct synthetic migration declares the deployed writer
version or uses the guarded commit path. After the clean S05 edge migration
raises only the writer and stream-receiver floors, old writers fail closed but
carrier commits stay disabled. With the deployment-cutover lock held, S07 first
raises the total-consumer runtime-reader and v3 stream floors while every feature
flag remains false. After old streams/requests/runs drain and scans remain clean,
a second compatibility-state transaction flips the selected activation flags.
Cover missing/old rollback declarations, cutoff/activation atomicity,
unset/leaked transaction settings, and an old reader never observing a newly
committed carrier.

#### Review units and verification

S02 ships in three sequential review units from merged `main`:

1. **S02a — identities and dormant storage:** runtime ids/brands,
   definition-only service reads, exact edge and stream-lease tables,
   multi-axis compatibility-state row and disabled activation flags, supporting
   app uniqueness/indexes, and the database writer-version trigger active at
   floor `0`. It adds no production extractor or edge writer, and old code with
   no transaction setting continues as version `0`. **Shipped in PR #298.**
2. **S02b — validation and authoritative writes:**
   an empty production target-extractor registry, shared edge materializer plus seeded harness, apply-once
   candidate preparation, consistent context threading, the atomic-creation
   exception, exact-set replacement across every existing app writer, explicit
   writer-version `0` declaration, schema-governance internals, export-boundary
   generalization, and the zero-carrier edge audit. **Shipped in PR #299.**
3. **S02c — move and transport safety (shipped):** exact
   membership serialization, capability manifest, stream leases, and
   runtime-holder versioning,
   authoritative reload and mutable editability, per-operation case/presence
   tenancy, transactional media deletion, dual-Project owner/run governance,
   the fully tested but still-disabled move path, and permanent deployment/
   database-identity hardening. Production floors remain `0` and flags remain
   false.

S02c shipped as three sequential PRs from each newly deployed `main`, with small
independently reviewed commits inside each PR. This keeps the transport,
deployment-security, and tenant-move risk surfaces reviewable:

1. **S02c1 — authorization and transport foundation:** roadmap/concurrency
   matrix; auth-membership serialization; authoritative app transactions and
   reload snapshots; the capability manifest; compatibility, stream-lease, and
   runtime-holder primitives; receiver-v1 admission and migration
   classification; and mutable client writability. **Shipped in PR #300.**
2. **S02c2 — deployment hardening:** immutable build identity and startup health,
   strict production Host routing, build/migration/runtime identity separation,
   migration-owned fixed schema plus the isolated runtime case-index schema,
   the ordinary blocking migration/Cloud Run deploy path, and structural
   verification. Apply the reviewed IAM/Cloud SQL bootstrap before merging the
   pipeline switch. Every floor remains `0` and every activation flag false.
   **Shipped in PR #301.**
3. **S02c3 — tenant-safe dormant move:** per-operation case authorization and
   transactional presence, atomic move and run normalization, exact media
   protocol, and same-Project repair. True moves remain disabled. **Shipped in
   PR #304.** The dormant v1 core
   commits Project flip, case tenancy, blueprint/thread media remaps, presence
   purge, migration history, reverse references, and notifications atomically;
   production still declares writer v0 and the static move policy still rejects
   before media work.

Within those PRs, commit and review in this order:

1. roadmap/concurrency matrix and capability-manifest contract;
2. auth-membership serialization plus authoritative app transaction helpers;
3. compatibility, stream-lease, runtime-holder, and cutover-lock primitives;
4. receiver-v1 admission, migration classification, authoritative reload, and
   mutable client writability;
5. startup/Host hardening, deployment identity separation, fixed-schema
   ownership convergence, and structural CI guards;
6. per-operation case authorization and transactional presence;
7. dormant atomic move, run normalization, exact media protocol, and
   same-Project repair; and
8. integrated verification and independent whole-slice review.

Use one pure invocation and one shared-Postgres invocation per review unit; never
start competing containers or browsers on the 16 GB machine. Across S02 cover
context/finding identity, missing/foreign parity, edge constraints and exact-set
replacement, apply-once UUIDs, every writer, both seeded race orders, projection
renames, zero-edge schema actions, floor behavior, structural/stored mismatch,
role/owner/membership/run-lease matrices, membership/case/presence races,
TRUNCATE rejection without advisory waiting, media-delete/move winner orders,
concurrent case-patch preservation, atomic parked replacement/dismissal,
transactional introduced-media references, complete deletion re-walks, and
object-key cleanup/upload/extraction/move winner orders, transactional
notification visibility,
compatible/incompatible stream leases,
registration/admission winner orders, stream teardown/expiry, runtime-holder
new-identity/same-identity/supersede/heartbeat/finalize/reap behavior,
ownership-safe stale terminal writes, every unstamped present run reading as v0,
per-target runtime epoch behavior, destination reload versus true
revoke, upgrade-required no-loop, PUT-403 downgrade/upgrade-before-cadence,
transient retry, unsaved role transitions, and cursor independence.

Then typecheck, scoped lint, and one affected leak pass. S02c stays at provider,
route, and shared-Postgres integration because production move activation remains
closed; S07 owns the first sequential desktop/compact browser move/reload journey
through an actually enabled path. Each unit gets independent review, green CI,
squash merge, blocking migration/Cloud Run follow-through, production probes/
error check, and cleanup.

S02b also ships a read-only `scan-lookup-reference-edges` inspector, including
soft-deleted apps and `--prod` support, that compares the shared structural
extractor with complete stored sets and fails on structural-only, stored-only, or
unassemblable apps. It is the zero-carrier production audit now and the S05
scan-before-migrate/rescan tool later; it never repairs data.

### S03 — display conditions: domain and wire

**Status:** shipped in PR #302 at squash `b0e3f48e`. Cloud Build
`de11f8c4-e82f-4a34-bbd7-ce8b0515a73c` completed migration execution
`commcare-nova-migrate-mc6jj` and deployed healthy 100%-traffic revision
`commcare-nova-00357-6lr`.

`Module.displayCondition?` and `Form.displayCondition?` are typed `Predicate`
carriers. This slice owns persistence/schema acceptance, reference indexing and
case-property rewrites/retirement descriptions, validation, HQ JSON, local CCZ
suite emission, and post-emit oracle coverage. It does not activate a preview,
builder, SA, or MCP writer: S07 owns execution, S08 owns human authoring, and
S10 owns SA/MCP/public-doc exposure.

Add typed condition carriers only where evaluation context is defined. Preserve
the current expression-admission policy: global/module contexts cannot gain row
property reads merely because a generic type context exists. Reverify exact
absent-node equality, inequality, and numeric-order semantics; never encode the
blanket `absent means false` shortcut.

The evaluation-context matrix is closed:

- module conditions run before case selection and admit literals,
  session/current-user values, and pure expressions over them; case properties,
  relation presence/counts, and Search answers are invalid;
- a form condition may read direct self properties of the module's case type only
  when every form is case-loading (the existing `isCaseFirstModule` contract);
  forms-first modules have no selected-case read; and
- related properties, `exists`/`missing`, relation `count`, Search answers, strict
  `is-null`, CSQL-only fuzzy/phonetic/fuzzy-date matching, `unwrap-list`, and
  unfaithful on-device date arithmetic are rejected on both carriers. Core's
  on-device `distance` lowering remains available when its fixed center is valid.

Deeply always-true predicates fold to an absent wire attribute. Deeply
always-false predicates are a gating `DISPLAY_CONDITION_ALWAYS_FALSE` finding so
the only route to a module/form cannot be authored away accidentally. No new
`case-count` expression arm belongs to S03; the existing relation-count AST is
also unavailable in these navigation contexts.

Wire emission is structural. A module condition becomes `<menu relevant>` and
HQ `module_filter`; a form condition becomes the menu's `<command relevant>` and
HQ `form_filter`. Form self properties lower to `#case/<wire-property>` for HQ
and to the selected `commcaresession/session/data/case_id` casedb anchor in the
local suite, including `@` on reserved case attributes. The fixed HQ build is
2.54 because menu-owned secondary `<instance>` children begin there. Module
condition instances canonically live on that menu. Form-command condition
instances canonically live on the matching entry, with both `casedb` and
`commcaresession` declared when the selected-case anchor needs them. The suite
oracle mirrors Core's exact restricted context: commands from all same-id menus
are expanded before a direct same-id entry, only the first resulting entry is
selected, and declarations from all same-id menus are added. Consequently a
form command does not inherit its containing menu unless that menu's own id
matches the command id; ambient entry/runtime allowances are not reused.

Core's absent-node behavior is preserved by raw comparisons, with no blanket
presence guard: an empty node-set string-unpacks to `""`; therefore string
equality to blank can be true and inequality to a nonempty string can be true.
When numeric coercion is selected, the empty string becomes NaN: numeric
equality/order is false and numeric inequality is true. Tests pin equality,
inequality, and ordered emission without `count`, `boolean`, or string-length
guards.

Screen width stays closed. At Core
`130df00962a289381a8e0936c3ea5d3f53d96f73`, metadata writes `window_width`
only for a non-null supplied value. HQ Web Apps at
`0fa01e0e8aea95ed9013d564145ad6cffeb91371` supplies
`String(window.innerWidth)` on navigation, while Android at
`3dd87e3838d57230b1452bdfd845a9151b8a6861` constructs the session wrapper
without width. A workflow condition would therefore diverge by target; viewport
policy remains responsive-rendering behavior, and `SESSION_CONTEXT_FIELDS`
continues to exclude `window_width`.

This is an additive document change with no data migration and no runtime flag:
older docs omit both optional slots. Rolling compatibility depends only on the
existing document/event preservation contract; no writer activates before S08/
S10. Focused schema, simplifier, validator, reference-index/rewrite/retirement,
session-instance, emitter, expander/compiler, canonical producer-placement and
exact Core relevance-scope oracle, and suite-fuzz coverage form the S03 gate,
followed by typecheck, scoped lint, independent review, CI, and the normal deploy
follow-through.

### S04 — case operations: domain and wire

**Status:** shipped in PR #303 at squash `85b2fe3b`. Cloud Build
`cefd6e18-49ac-4809-a600-fbfbe7c10708` ran migration execution
`commcare-nova-migrate-bp46g` successfully and deployed healthy 100%-traffic
revision `commcare-nova-00359-8d7`. Main/docs probes, the MCP authorization
boundary, and revision error logs all passed.

Define operation UUIDs, authored create ids, typed targets, links, repeat
correlation, remove/retype semantics, ordering, property-writer participation,
and activation gates. Integrate effective property typing, data review,
conversion/parking, case schema materialization, and reserved case types.

Pin wire order and non-create existence/order guards against current HQ/Core
fixtures. Reject
ambiguous singular references, cross-repeat references, target-type mismatch,
foreign-tenant ids, unsafe retypes, and removing/reordering an operation under a
dependent reference.

The shipped implementation began from `b0e3f48e`, was rebased onto production
baseline `97591f10`, and landed at `85b2fe3b`. The domain now carries stable
operation UUIDs, authored create ids, typed new/operation/session/expression
targets, explicit repeat correlation, typed writes and links, and the
round-trip-only `field` / `id-of` identity leaves plus explicit `acting-user` /
`unowned` owner values. Operation writers join
the effective/materializable property derivation and its writer-agreement proof;
the pure retype plan names retained, converted, parked, missing-required, review,
storage-atomic safe, and device-parity wire-portable outcomes. Scalar row metadata
(`case_name` and the other standard columns) never enters the JSON conversion/parking
plan. Reserved case types/properties and every contextual facet are commit-gated with
named findings. Operation/retype/link case types apply Core's identifier grammar and
255-character cap; link identifiers apply XML grammar, per-operation uniqueness, and
HQ's 255-character index-column cap.

The mutation/reference unit uses the rolling-compatible
`updateForm.caseOperationChange` extension for add/update/remove/move, preserves
cleared order through diff/replay, and blocks removal or dependency-inverting
moves. Physical wire order is now an explicit contract: the singular operations
container is first, repeat containers live in their exact templates, and scopes
therefore execute root then repeat post-order; validation and move planning both
reject a fractional order that crosses backward over that sequence. Multiple
operations on the same known target remain legal and execute in declared order;
the superseded archived duplicate-target ban is not part of Nova's model. An
authored deterministic-key create must precede every non-create effect because a retry may
already exist and HQ create-sorts colliding blocks while Core follows document
order; generated UUID creates stay fresh. `idFrom` is not a raw global case id:
the shared frozen derivation is
`nova-case-v1:<UUIDv5(app,form,operation,type)>:<exact-key>`. The JSON namespace
tuple and fixed UUID namespace are test-vector pinned; display-id renames and
reorders do not change identity. Empty keys and keys over 205 Java/JS UTF-16
code units fail on both the XForm and future Preview paths, while whitespace,
case, and Unicode remain exact with no normalization. This app/form/operation/
type namespace prevents an unseen HQ case from being accidentally merged or
retyped; retries and duplicate repeat keys for the same definition intentionally
merge, and two operations may safely use one key field. A later non-create that
may target the merged case is rejected when its scope shares a repeated
execution ancestor with that create: Core's iteration-major order and HQ's
per-case create sort would otherwise disagree. Provably distinct targets and
independent root sibling repeats remain legal. Keyed identities are
type-stable: a known authored-create retype is rejected statically and a
data-dependent `nova-case-v1:` target is rejected by an atomic XForm guard.
The key source is scalar text/single-select/hidden-string only; multi-select is a
Nova array but a CommCare space-token string and has no safe implicit key encoding.
Conditional create and retype facts carry their predicate guards
transitively to later identity/type consumers, and remove/move planning uses the
same analysis.

Source-level XForm emission is shared by HQ upload and local compilation, with
canonical create/update/close/index child order, idempotent same-type updates
that both guard index-only misses and give pure-close/index blocks a real HQ
update sort key (HQ parses an empty update as absent beside another action), final-value
calculate binds for authored create ids, exact repeated `id-of` correlation
(including `current()` anchoring through nested relation predicates), transitive
conditional create/retype guards, and type-filtered runtime targets. Exact
expression identities keep their original snapshot lookup type after a semantic
retype; dynamic-link guard blocks validate by no-op-targeting the operation case,
not by modifying the linked case; absent, wrong-type, and self-link targets all
fail the atomic submission. Deterministic authored-key identity no longer relies
on the incomplete restored casedb to prove global absence. Different expression/
session/op ASTs can still resolve to one concrete id, so the order proof tracks
every type-changing identity and rejects a later differently-typed target/link
unless the pair is statically equal or provably distinct. Repeated retype is
legal only over the exact correlated generated-UUID create; an authored key or
runtime target can repeat one id across iterations. Move/remove planning consumes
the same violations. The proof continues through the ordinary `FormActions`
that execute last: a primary property update and every subcase parent link still
require the loaded session case to have the module type, so an exact or
potentially-aliasing advanced retype away from that type is rejected. A
write-free close action remains type-agnostic. Transition history is retained
for this proof: a later conditional restoration cannot erase the earlier branch
where its condition is false. Pre-submission
session-case reads are anchored in `casedb`. Advanced effects
precede the existing ordinary primary-case `FormActions` block. Wire tests pin
current Vellum/Core fixtures and the XForm oracle. Runtime target
validation accepts only client identity and separately reauthorizes server-owned
Project/type facts. Target and link-target expressions reject `id-of` at any depth;
the typed `op` target is the sole path to a fresh create, which cannot be found in
the pre-submission casedb. Persisted values use directional storage assignment over
every branch: exact types, int-to-decimal, and text/single-select string interchange
are admitted; decimal-to-int, null-as-clear, scalar-to-multi-select, and multi-select
through scalar concat/coercion are rejected. `concat` is the explicit portable
boolean-to-text boundary. Name, rename, and effective owner results use one shared
`caseOperationText.ts` preparation contract: Java-regex XML boundary whitespace is
removed, internal whitespace is preserved, the normalized value must be nonblank,
and the Core/HQ fixed-column limit is 255 UTF-16 code units. The XForm calculates the
normalized value and a trailing atomic no-op guard rejects blank/overlong results;
obvious invalid literals are rejected statically. S06 must call the same helper before
any DML, including default-owner stamping, rather than relying on the looser current
Postgres columns. Authored retypes additionally require `wirePortable`: no
source-only parking and no conversion, because CommCare changes only `case_type` and
would otherwise retain a different lexical/property projection from Nova. The richer
pure plan remains available for a future shared wire representation. The pure storage
seam and wire are complete, but
`CASE_OPERATIONS_NOT_ACTIVE` intentionally keeps operation-bearing candidates
uncommittable: S06 must execute one atomic submission envelope (including the exact-
schema retype subset) and complete the opaque-case-id migration/audit enumerated
in its slice before authored ids can reach storage; S07 must add preview execution before S08 opens builder,
SA, or MCP authoring. No public docs change is due while the feature is dormant.

### S05 — lookup carriers, table expressions, itemsets, and wire foundations

**Status:** S05a in final review (draft PR #311; implementation checkpoint
`9517a221`); S05b blocked on S05a; S05c blocked on S05b and a fresh owner
decision.
Domain/wire readiness closed on 2026-07-23. S05a adds carrier schemas,
rolling-compatible mutations, persistence/replay, reference ownership, and
validation with every carrier commit and export gate still closed. It does not
add UI, SA/MCP vocabulary, preview/SQL activation, HQ JSON, or HQ upload. Local
CCZ may emit dormant carriers only after S05b. HQ JSON and upload reject them
until S20 owns resource push/mapping.

S05 introduces the first production UUID-backed lookup carriers: table-backed
select sources with value/label column ids, table-lookup expressions with a
result-column id, and table-column predicate terms. Column ids always travel with
their table id. Any approved XPath bridge stores UUID identity rather than tag or
wire-name text; table-column terms are legal only inside an explicit table scope.

```ts
type LookupOptionsSource = {
  kind: "lookup-table";
  tableId: LookupTableId;
  valueColumnId: LookupColumnId;
  labelColumnId: LookupColumnId;
  filter?: Predicate;
};

type TableColumnTerm = {
  kind: "table-column";
  tableId: LookupTableId;
  columnId: LookupColumnId;
};

type TableLookupExpression = {
  kind: "table-lookup";
  tableId: LookupTableId;
  resultColumnId: LookupColumnId;
  where: Predicate;
};
```

Both select kinds keep `options` structurally required and gain an optional
`optionsSource`. When a source is present, current consumers use it and retain
the authored inline options only as an origin-compatible fallback. No layer
synthesizes fallback options from table rows or inserts sentinel choices. S09's
source-mode switch preserves the authored inline list. XForm emission produces
either the static `<item>` children or one `<itemset>`, never both.

The current nested field schemas are strict, so inline fallback content alone
does not make a carrier mutation safe for an old receiver. `addField` and
`updateField` carry the source through optional top-level semantic extensions on
those existing discriminators; their nested field/patch stays in the old strict
shape. The exact extension contract is
`addField.optionsSource?: LookupOptionsSource` and
`updateField.optionsSource?: LookupOptionsSource | null`: absence means no
source edit, a source means set or replace, and explicit `null` means clear while
preserving the inline options. A current reducer reconstructs or merges the
source while an old reducer safely applies only the inline fallback. Diffing,
JSON round trips, current replay, old-parser/reducer fallback, and raw SSE
dispatch must cover set, replace, and clear. This is a receiver-floor bridge,
not permission to run an old binary after carrier writers activate.

Before carrier commits activate, every exhaustive consumer must implement the
carrier or deliberately reject it through the commit gate: hydration,
persistence, replay, diffing, AST walks/rewrites/simplification, validation and
type checking, reference extraction, preview evaluation, case-store SQL, schema
materialization, wire/CSQL emission, instance accumulation, summaries, and every
web/MCP compiler guard and rolling receiver. S05 makes schema acceptance and wire
preparation internal-only; the carrier commit gate remains closed because S07
still owns preview and SQL execution.

Builder mutation inputs and controls remain carrier-blind until S09. SA tool
schemas, MCP schemas, and model vocabulary remain carrier-blind until S10.
Existing generic mutation schemas must explicitly omit or reject carrier keys
until the owning surface activates. Use existing mutation discriminators with
optional semantic extensions and origin-compatible fallbacks; do not add a
discriminator in the rolling window.

Table lookup returns the first match by `(order_key, row UUID)` and lowers with an
explicit positional first-row predicate; no match is missing, not empty text.
A matched row with an absent result key and a matched row with stored empty text
both emit blank text at the fixture boundary; S01 still preserves that
distinction in storage. Text and temporal values retain their stored lexical
form, ints emit canonical signed base-10, and decimals emit the canonical finite
JSON-number string. Whitespace is never generally trimmed or normalized.

For a table-column operand, `is-null` is unrepresentable and rejected;
`is-blank` means absent or present-empty. A select source rejects a missing label
or one whose lexicalized value has `String.prototype.trim().length === 0`; this
check does not alter the emitted label. It also rejects a missing or empty value
and any value containing XML whitespace (`U+0009`, `U+000A`, `U+000D`, or
`U+0020`). It rejects duplicate values across the complete source table after
scalar lexicalization, not merely the filtered result. Equality is exact
code-point equality: no trim, case folding, or Unicode normalization. Duplicate
labels remain valid when their values differ. Any scalar column type may provide
the value or label through the same lexicalization contract. Tests include
ASCII whitespace, non-ASCII trim whitespace, and nonblank labels whose
surrounding whitespace remains unchanged.

Select filters admit same-table column terms, literals, the existing
on-device-safe session/user terms, and form-field terms. They reject case
properties, search inputs, other-table columns, nested table lookups, and any
field reference that is not earlier in effective depth-first form order. Outside
a repeat, a repeated answer is invalid. Inside a repeat, the filter may read
root-level singular fields plus earlier fields in the current or an ancestor
repeat; child, sibling, cousin, and otherwise unrelated repeat contexts are
invalid. Root references print absolute paths; repeat-correlated references
print relative to the question through `current()`.

A `table-lookup.where` uses the same scoped predicate machinery but does not
invent one global outer-term whitelist. Same-table columns are row-relative.
Every non-column term must already be legal in the containing expression slot
and retains that slot's case, form, session, and user context while the fixture
row is current. Other-table columns and nested table lookups are always rejected.
Where a containing form slot admits form-field terms, their ordering,
singular/repeated ancestry, absolute-root printing, and `current()` correlation
follow the select-filter rules above. Validation and emitter tests cover table
lookups inside display conditions, calculated expressions, and case-operation
expressions rather than proving only the select-filter case.

Options dependencies join the shared field dependency graph used by relevance,
calculate, and default expressions. The validator rejects cycles spanning any
of those slots. If a dependency change removes the selected value from the
current choices, the answer becomes unselected; required validation then treats
it as unanswered, with no automatic replacement choice.

Compilation resolves definitions plus complete ordered rows for all distinct
referenced tables in one read-only `REPEATABLE READ` transaction. It must not
loop over `getLookupTable`, whose per-call snapshots could mix generations.
Tables are counted and loaded once even when several carriers reference them;
complete ordered rows count even when an authored filter would select fewer.
Local CCZ may embed deterministic global fixtures and every required instance;
HQ JSON and upload remain blocked across all web/MCP paths until S20 pushes and
maps the resources. The shared Project-resource boundary owns this matrix.

S05 also owns the aggregate embedded-fixture budget across every table an app
references:

- at most 10,000 complete rows;
- at most 100,000 cells, computed as the sum of each table's
  `rowCount * columnCount`, including absent stored keys because the wire emits
  every defined field; and
- at most 16 MiB of exact UTF-8 fixture bytes.

The byte measurement covers the deterministic serialized `<fixture>` blocks,
including wrappers, names, attributes, escaping, and blank elements, before
archive compression. A byte-only limit is insufficient because the unindexed
runtime materializes XML elements and attributes as object-heavy `TreeElement`
nodes; the cell cap bounds that cardinality. Reject before emission with actual
and allowed totals, the largest contributing tables, and person-readable
remediation. Tests pin one-below/exactly-at/one-above for all three axes,
missing-cell inflation, escape-byte inflation, distinct-table de-duplication,
and many small tables. S01's per-table storage cap is not a substitute for this
compiled-artifact budget.

Implementation remains split into independently reviewed units:

1. **S05a — dormant carriers and compatibility (in final review):** add every carrier and
   AST schema/identity, top-level mutation extension,
   hydration/persistence/replay/diff behavior, exhaustive walks/rewrites and
   reference extraction, validation/type checking, explicit downstream
   rejection behavior, and receiver-v2 compatibility while commit and export
   gates remain closed. The immutable production extractor and the one shared
   capability manifest's writer-v1 / stream-receiver-v2 declarations land as
   one support checkpoint, with every authoritative writer still using its
   shared declaration helper. Every database floor and feature flag remains
   zero/off.
2. **S05b — local wire (blocked on S05a):** add lowering/emission for the
   already-preservable table expressions, predicates, and itemsets; instance
   accumulation; the one-snapshot multi-table reader; deterministic fixture
   serialization/budgets; local-CCZ emission; and Core/HQ-shape oracles while HQ
   JSON/upload and authoring remain closed.
3. **S05c — carrier cutover and edge preparation (decision-blocked):** only
   after S05b and a fresh owner decision, perform the chosen compatibility or
   maintenance cutover and leave carrier commits runtime-disabled for S07. No
   nonzero floor is authorized by S05a or S05b.

#### S05a execution checkpoint — 2026-07-23

Commits `fe0a7027` through `9517a221` on `agent/s05a-lookup-carriers`
form the implementation-complete S05a review candidate. They own:

- the three dormant domain carriers and their stable table/column identities;
- required inline select fallbacks plus the rolling-compatible top-level
  `addField` / `updateField` extension, exact set/replace/clear diff and replay;
- carrier-aware predicate walks, simplification, relation normalization,
  reference-slot traversal, type resolution, nested-lookup rejection, and the
  `is-null` versus `is-blank` table-column distinction;
- JSON-Schema-representable UUIDv7 normalization for the lookup identities now
  embedded in the recursive Predicate and ValueExpression definitions;
- carrier-blind builder field-add inputs and non-authorable generic expression
  fallbacks, including inline-only duplication of a receiver-preserved select;
- a structural, recursively carrier-blind Predicate / ValueExpression family
  for the rolling mutation envelope and all nine SA/MCP write tools, while a
  separate canonical mutation schema preserves the full vocabulary for reducer
  and durable-log replay;
- carrier-blind `getField`, `getForm`, and `getModule` projections shared by
  chat and MCP, which omit the smallest unsafe slot or entry without mutating
  the canonical document or discarding safe siblings; and
- deliberate rejection or incompatibility results at the existing preview,
  case-store SQL, on-device XPath, CSQL, suite, and instance boundaries,
  including terminal rejection before lookup-row predicates are misread as case
  predicates;
- the immutable 17-slot production extractor over complete normalized entity
  maps, with stable semantic operation anchors and exact nested occurrences;
- writer-v1 and stream-receiver-v2 declarations in the shared capability
  manifest while all database floors and feature flags remain zero/off;
- commit-only fingerprinted dormant-carrier findings that permit unrelated
  repairs to historical documents but reject every new or changed carrier; and
- mode-aware `ccz`, `hq-json`, and `hq-upload` export rejection before media
  resolution or emission, plus real JSONB carrier coverage through hydration,
  production extraction, authoritative edge backfill/removal, both deletion
  race orders, and Project-move closure.

The foundation checkpoint passed its 21-file, 515-test matrix. The boundary
slice passed a 20-file, 382-test matrix covering canonical replay,
rolling envelopes, misplaced-carrier rejection, all nine SA/MCP write schemas,
chat/MCP prompt grammar, raw MCP registration, all three read projections, and
legacy fallbacks. TypeScript and scoped Biome pass, and independent review
closed the replay/schema-generation defects it found before returning no
remaining findings. The extractor/gate checkpoint then passed a fresh 4-file,
41-test focused matrix, TypeScript, scoped Biome, manifest/build-wiring
validation, and diff hygiene; independent integrated review returned no
Critical, Important, or Minor findings after the real-carrier writer matrix
closed its only Important coverage gap.

The final S05a units are now implemented:

- the rows-free lookup type index is threaded through validation; select filters
  and containing expression slots enforce table, field-order, and repeat-ancestry
  policy without duplicate structural diagnostics; options-source and default
  reads join the validation-only dependency graph without changing preview
  topology; and case-workspace verdicts require explicit lookup context without
  fetching or activating runtime behavior;
- raw HTTP SSE set/replace/clear, generation-stream dispatch replay, and the
  Postgres log writer-to-reader path preserve carrier events and explicit
  top-level `null`; and
- the add-field reducer reparses only when the semantic extension is present, so
  accepted legacy history without a carrier retains its existing replay
  semantics.

The validation tranche passed 50 files / 624 tests, TypeScript, scoped Biome,
and independent review with no Critical, Important, or Minor findings. A fresh
supervisor matrix passed 6 files / 177 tests. The transport tranche passed 3
files / 46 tests both normally and under the async-leak detector and received a
clean independent review. The two failures in the earlier draft-checkpoint CI
were reproduced, fixed in `9517a221`, and their four-file / 87-test regression
matrix now passes. Consolidated contract review and fresh PR CI remain the final
merge gates.

The following activation sequence is the previously specified zero-downtime
alternative, not an approved S05c implementation plan. At the S05c checkpoint,
present it against a maintenance cutover with then-current traffic, downtime,
temporary/permanent work, and effort estimates. Do not implement or execute any
step until the owner chooses:

1. require the S05a/S05b writer-v1, receiver-v2 revisions at 100% traffic while
   carrier writers, destructive schema actions, and true moves remain disabled
   and every database floor remains zero;
2. raise the stream
   receiver floor to v2 with every feature flag still disabled, wait the full
   request cap plus grace, and require no unexpired receiver below v2;
3. run the read-only structural-versus-stored scan, then the explicit edge
   migration under each app lock, and require a clean rescan;
4. establish S05 as the edge-maintenance writer floor, not the runtime reader
   floor;
5. atomically raise `minimum_writer_version` to 1 while carrier commits,
   destructive schema actions, and true moves remain runtime-disabled.

S05's closed-gate verification uses real carriers to replace edges
transactionally and repeat both production race orders. It adds carrier schema/
context matrices, reference-index fuzz, history/mixed-version replay, every
carrier's edges, stale optimistic versus fresh server context, foreign opacity,
projection rename safety, snapshot consistency, deterministic fixture bytes,
exact aggregate-budget bounds including many small tables, and the full web/MCP
export matrix. S07 repeats the admission preflight before opening commits and
retains matching-and-empty structural/stored targets, compatible active streams,
fresh dual-Project governance, no run lease, and atomic case/presence handling
for moves.

### S06 — atomic submission envelope and resolved preview identity

Establish one `ResolvedPreviewIdentity` contract across Search, Results, form
XPath, conditions, table filters, operations, and owner stamping. S06 activates
**Preview as me** and leaves a typed provider seam for S15's persisted named
personas; it does not create a session-only pseudo-persona. Extend the CaseStore
contract with one tenant-bound atomic submission envelope combining ordinary
form actions and advanced operations. No real row may be stamped with a named
persona until that persona has stable persisted identity.

S06 also owns the complete opaque-case-id activation migration, not only a SQL
column alteration. Preserve PR #301's production schema boundary:
`nova_case_runtime.cases` is the sole runtime-owned table, while
`public.case_indices`, `public.case_type_schemas`, and
`public.parked_case_values` remain migration-owned. The scan and migration must
schema-qualify every object rather than depending on the connection search path.
Ship a read-only scan, then widen `cases.case_id`, `parent_case_id`,
`case_indices.{case_id,ancestor_id}`, and `parked_case_values.case_id` plus every
FK/index/default to `text`, retaining `uuidv7()::text` only as Nova's
generated-id default. Remove every UUID array/value cast and every UUID-only
runtime parser, including `readCaseData` in `caseDataBindingHelpers.ts`. The
atomic executor must call S04's shared
`deriveAuthoredCaseId` helper and reject its empty/over-205 key outcomes before
writing, with the pinned TypeScript/XPath vectors as parity tests. Every evaluated
create-name, rename, and effective owner must pass through
`prepareCaseOperationTextValue`; store only the returned normalized value and abort
on `blank`/`too-long`, including for an acting-user/persona default owner. After
expanding repeats into physical order it must call
`validateResolvedCaseOperationTypeSequence` over the separately authorized
snapshot descriptors before any write: the fold keys by concrete opaque id,
checks every link's concrete identity and rolling type before each effect,
rejects a runtime-expression self-link, catches runtime aliases/duplicate
repeat values, and enforces keyed-identity type stability. Per-target descriptor checks
alone are not an adequate rolling retype proof. Replace the current UUIDv7 lexical insertion-order
assumption used by default/tie-break case ordering with an explicit durable
ordering fact; authored ids are not time-sortable. Audit every URL and raw path
segment boundary for encode/decode symmetry rather than interpolating opaque ids.
Acceptance must cover non-UUID ids (including URL-significant characters) across
create/read/update/close, relation walks, paging/tie-breaks, parking/review/
restore, retenancy moves, and the atomic operation envelope, followed by a clean
production rescan before the S04 activation gate can open.

The first activation may execute only S04's `wirePortable` retype subset (exact
retained JSON property types, no cast and no parking). Do not interpret the richer
storage `safe` plan as device parity: CommCare's case XML changes `case_type` but
does not remove source-only properties or cast shared values. Conversion/parking
retypes remain dormant until a later slice defines and tests one shared wire
representation across device and Nova. Multi-select form answers bind to the SQL
expression compiler as string arrays and must be serialized/cast explicitly to
JSONB inside the atomic executor.

### S07 — preview execution and carrier activation

Implement the shared rewrite/fold/SQL-residue evaluator, table choices, atomic
case effects, failure parity, and resolved-identity scoping over real case rows.
Test the full absent-value matrix and effect ordering. `Preview as me` is active;
S15 plugs named personas into the same contract without changing evaluator call
sites. Authoring-only reveal behavior remains a visibly separate mode. After
preview evaluation, case-store SQL, schema materialization, and every remaining
committed-state consumer are total and 100% traffic serves the v3 browser/runtime
reader, take the deployment-cutover lock and freshly re-read the complete Cloud
Run traffic split plus every receiving revision's declared capabilities. Abort
unless every target is compatible; keep the lock through that check and the
compatibility-state transaction that raises both the stream receiver floor to v3
and `minimum_runtime_reader_version` with every feature flag still disabled.
Traffic tooling cannot route a lower reader across this cutoff.
Wait the longest enforced stream, request, or run lifetime plus grace, require no
unexpired receiver below v3, and re-run the clean edge/capability/floor preflight.
That bounded drain must cover every request-scoped old server reader; any
background reader without the same enforced lifetime must register a durable
revision/version lease and also drain to zero. Only then does a second
compatibility-state transaction enable carrier commits, zero-reference schema
actions, and zero-reference moves. Builder inputs remain closed until S09 and
SA/MCP inputs until S10.

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
resources and ordering are verified end to end. HQ's lookup-table detail REST PUT
rejects an established tag change even though the storage model and legacy UI can
rename it; therefore a Nova tag rename must use an explicitly preflighted
replacement/adoption workflow, never an in-place REST PUT. Do not route through
the legacy Manage Tables endpoint, whose tag-length check is narrower than HQ's
32-character model/API bound.

### S21 — App setup UI, SA, MCP, and docs

Build URL-owned Users & Personas, Organization, Automations, and Deployment
sections with responsive navigation, permissions, conflict/recovery states,
deployment progress/retry, and honest target prerequisites. Complete tools,
public docs, and the cross-facility owner/restore dogfood scenario.

### S22 — exclusive form links and sections

**Status:** blocked; `agent/s22-form-links` owns readiness rebaselining only.
The 2026-07-23 read-only production census found zero current form links and zero
historical form-link mutations across 404 apps, but the existing strict anonymous
shape still makes durable UUID/order identity a protocol cutover. Implementation
remains closed until the owner chooses between the mixed-version path and a
maintenance cutover; do not infer that choice. Repeat the census after writes
are quiesced before either path commits. The first review unit then stays limited
to durable identity plus exclusive link projection and validation across local
suite and production HQ JSON emission. Sections, preview behavior, and UI remain
a separate unit.

The audited choice is:

- zero downtime adds old-shape projections, writer gating, floor operations,
  and at least two staged releases plus a 65-minute receiver epoch; estimate
  5–8 engineering days and 1–2 reviewer-days beyond the core correction;
- a maintenance cutover uses one release and is recommended for the current
  empty dogfood corpus; estimate 20–30 minutes unavailable with a hard write
  fence and old-stream eviction, or 75–90 minutes if existing leases only expire
  passively.

The maintenance path saves an estimated 2–4 engineering days, about one
reviewer-day, and one review/deploy stage (roughly 35–45% of
compatibility-specific work). If the repeated census is nonzero, stop and add an
idempotent current-entity plus accepted-history converter and forward-fold
oracle before revisiting either estimate.

First fix the existing `first matching link wins` wire bug and reject links after
an unconditional branch. A terminal unconditional link is the exhaustive `else`:
its emitted guard is the negation of every prior condition, it suppresses the
`postSubmit` fallback, and the form is valid without a separate `postSubmit`
target. An expression that prints to empty XPath is unconditional. One shared
projector owns these guards for local suite emission and the HQ JSON expander;
tests cover both paths. Links must gain durable UUID/order identity under the
roadmap's closed identity contract; any legacy-array-order bridge is transitional
compatibility for existing documents, never the resulting identity model. Then
add form sections with fractional order and staged mutation
compatibility. Define relevance skipping, Next/Back validation, earliest-invalid
Submit routing, mutation re-anchoring, preview persistence, and accessibility
before UI implementation.

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

- **2026-07-23 — S05a implementation complete / final review:** Draft PR #311
  now includes the rows-free lookup type and scope policies, validation-only
  dependency-cycle integration, explicit lookup-context case-workspace
  verdicts, and the raw HTTP SSE, generation dispatcher, and Postgres log replay
  matrix through commit `9517a221`. The validation and transport tranches each
  completed independent review with no remaining findings. The prior draft CI's
  two add-field replay regressions were reproduced and fixed without changing
  carrier behavior; focused verification is green. Consolidated contract review
  and fresh PR CI are the remaining merge gates. Every carrier commit and export
  gate remains closed, every database floor and feature flag remains zero/off,
  and no UI, runtime evaluation, SQL execution, wire emission, or authoring
  surface is activated.
- **2026-07-23 — S05a extractor/gate checkpoint reviewed:** Draft PR #311 at
  commit `c27217b6` registers all 17 production carrier extractors, declares
  writer v1 and stream receiver v2 with every database floor and feature flag
  unchanged, and closes commit plus all export boundaries around dormant
  carriers. Canonical
  fingerprints distinguish carrier changes from unrelated historical repairs.
  Real JSONB carriers now exercise authoritative edge backfill/removal, both
  deletion race orders, missing/foreign parity, and Project-move closure without
  mocking the extractor. Independent integrated review is clean. Rows-free type
  policy/dependency validation and the remaining raw-SSE/dispatcher/log
  compatibility cases are the two unfinished S05a units.
- **2026-07-23 — S05a ready / S22 census complete:** S05 domain/wire readiness
  now pins the inline select fallback, mutation compatibility, fixture lexical
  semantics, option validity, answer/repeat/dependency rules, one-snapshot
  reader, and aggregate limits of 10,000 rows, 100,000 cells, and 16 MiB exact
  fixture bytes. S05a is ready with all carrier and export gates closed; S05b
  remains dependency-blocked and S05c remains owner-decision-blocked before any
  production cutover or nonzero floor. S22's production read-only census found
  no current or historical form links across 404 apps; its identity
  implementation remains blocked on the explicit
  mixed-version-versus-maintenance cutover choice.
- **2026-07-23 — S04 shipped / S22 form-link readiness started:** PR #303
  shipped dormant case-operation domain and wire support at squash `85b2fe3b`
  through successful Cloud Build `cefd6e18-49ac-4809-a600-fbfbe7c10708`,
  migration execution `commcare-nova-migrate-bp46g`, and healthy 100%-traffic
  revision `commcare-nova-00359-8d7`. Production probes and revision error logs
  passed. S22's form-link readiness rebaseline now owns
  `agent/s22-form-links`; implementation remains blocked pending the migration
  and rolling contract for durable link UUID/order identity. S05 remains blocked
  on its recorded exported-value, fallback, filter-scope, and aggregate-budget
  decisions and now explicitly depends on S04's shared predicate/expression
  baseline.
- **2026-07-22 — S02c3 shipped / S04 review-ready:** PR #304 shipped the
  tenant-safe dormant move and exact media protocol at squash `97591f10`
  through successful Cloud Build `c0b35218-5c0f-4d68-ab7e-0932d000aa13`,
  migration execution `commcare-nova-migrate-b6whk`, and healthy 100%-traffic
  revision `commcare-nova-00358-clk`. True Project moves remain disabled. S04
  is rebased on that production baseline and remains review-ready.
- **2026-07-22 — S02c2 and S03 shipped:** Deployment hardening shipped in PR
  #301 at `e9a6377a` through successful Cloud Build
  `030b9622-1aaf-43b2-8137-7ef4a4615f74`, migration execution
  `commcare-nova-migrate-6ckw5`, and healthy 100%-traffic revision
  `commcare-nova-00356-q6p`. Display-condition domain and wire support then
  shipped in PR #302 at `b0e3f48e` through successful Cloud Build
  `de11f8c4-e82f-4a34-bbd7-ce8b0515a73c`, migration execution
  `commcare-nova-migrate-mc6jj`, and healthy 100%-traffic revision
  `commcare-nova-00357-6lr`.
- **2026-07-22 — S04 domain/wire implementation reviewed:** A dedicated
  `agent/s04` worktree now owns the dormant case-operation unit: typed identity,
  targets, links, repeat correlation and AST leaves; rolling-compatible
  mutations and exact references; operation-aware property derivation and the
  atomic retype plan; tenant-authoritative runtime target validation; and
  source-level cx2 emission with canonical child/document order, typed dynamic
  targets, conditional transition guards, and current
  Core/Vellum oracle coverage. Review-driven hardening now also pins directional
  storage assignment and multi-select JSONB bindings, nested `id-of` target rejection,
  255-character case-type/index constraints, scalar-metadata-safe retype planning,
  fixed-column name/owner normalization and atomic bounds guards, and the
  exact-schema-only `wirePortable` retype gate. The operation commit gate and all public
  authoring surfaces remain closed pending S06/S07 execution. Independent code review
  approved the corrected unit and the focused 17-file verification lane passed, so the
  slice is review-ready.
- **2026-07-22 — S02b shipped / S02c owned:** Integrated the required lookup
  context/finding identity through every validation boundary; exact edge
  replacement, same-transaction Project reauthorization, apply-once candidate
  preparation, deterministic synthetic history, and dormant empty-only Project
  moves through every authoritative app writer; closed schema-governance
  internals; the three-mode export preparation boundary; and the read-only
  fleet edge scanner. The scanner includes soft-deleted apps, compares
  structural and stored targets from one read-only repeatable-read snapshot,
  and exposes `--prod` without a repair path. Typecheck and scoped Biome passed;
  the leak detector passed 14 pure files / 141 tests and 9 shared-Postgres files
  / 101 tests with one worker; scanner, inspector, and repair-script import/help
  smokes passed. Independent writer, export, and final integrated reviews found
  no actionable issue. PR #299 then passed every CI gate and shipped at squash
  `dd5fbecf` through build `22a9ca50-3dbb-4012-a363-fd5517d4f13c`, successful
  migration `commcare-nova-migrate-rnqqd`, and healthy 100%-traffic revision
  `commcare-nova-00353-plw`. App/docs/MCP probes, revision error logs, and the
  read-only 401-app production edge scan passed; all S02b branches/worktrees
  were cleaned. The S02c re-audit froze shared/exclusive membership
  serialization, per-operation case safety, atomic move/media behavior, mutable
  editability, receiver leases, runtime-holder stamps, and permanent deployment
  identity/startup hardening. Fresh branches own the still-disabled
  implementation.
- **2026-07-22 — S02a shipped / S02b owned:** PR #298 shipped the distinct
  lookup identities, rows-free definition snapshot, dormant exact-reference and
  stream-lease storage, compatibility floors/flags, and database writer guard at
  squash `07c45ef6`. Build `99ae1f72-048b-4515-8652-1f3caa669b99`, migration
  `commcare-nova-migrate-cccx4`, revision `commcare-nova-00352-gpk`, production
  probes, and error logs passed; all S02a branches/worktrees were cleaned. The
  S02b readiness audit then froze deterministic persisted mutations,
  same-snapshot validation, null-Project and dormant-move behavior,
  fail-closed private schema governance, exact app-id blocker diagnostics, and
  the three-mode neutral export boundary. At that point, fresh branch
  `agent/s02b` took ownership from merged `main`.
- **2026-07-22 — S01 shipped / S02 infrastructure contract:** PR #295 shipped
  lookup persistence through healthy revision `commcare-nova-00350-xgz`. PR #296
  then passed review and CI, but its first Cloud Build was deliberately cancelled
  before the migration Job when a rolling-version audit found that an already-open
  tab could retain its source-Project broker latch across a later app move. PR
  #297 closed that handoff on every reload/revocation boundary and rejected stale
  EventSource callbacks; squash `7422c4c2` deployed through successful build
  `4a6ab710`, migration `commcare-nova-migrate-clvkd`, and healthy 100%-traffic
  revision `commcare-nova-00351-dcq`. Production host/auth probes and error logs
  passed, and all S01 branches/worktrees were cleaned. The follow-on S02 audit
  froze an infrastructure-only slice, deferred carrier/wire foundations to S05
  and runtime activation to S07, and split delivery into independently reviewed S02a
  identity/storage, S02b validation/commit, and S02c move/transport units.
- **2026-07-21 — S01 readiness:** Re-audited lookup persistence against the
  Postgres app-state store, Project roles/lifecycle, app-move saga, Server Action
  limit, order-key implementation, shared listener, and builder stream. Froze the
  Project-clock/full-snapshot revision model, UUID-keyed row values, raw CSV
  contract, role matrix, temporary move experience, global Project-deletion guard,
  rolling-deploy behavior, and two review units; S00 is production-verified and
  S01 is now owned in progress.
- **2026-07-21 — S00:** Replaced the stale fifteen-PR execution model after the
  Firestore-to-Postgres migration and subsequent builder, mutation, data-review,
  agent, and deployment changes. Recorded the approved identity, persona,
  deployment, tile, attachment, UX, resource, review, and delivery contracts.
