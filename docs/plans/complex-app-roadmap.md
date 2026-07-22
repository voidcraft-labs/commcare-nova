# Complex app roadmap

> **Authoritative living plan.** Last rebaselined 2026-07-21 against Nova
> `db954a15`; S01 was re-audited 2026-07-21 against `3aa306d7`. This file
> owns execution order, product decisions, slice status, and
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
| S00 | Roadmap rebaseline | — | shipped | execution index + all PR plans |
| S01 | Lookup persistence and realtime | S00 | in progress | PR-02, F5 |
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

Readiness was frozen 2026-07-21 against Nova `3aa306d7` after independent audits
of the migration owner, `AppDatabase`, Project authorization, Better Auth Project
deletion, the app-move saga, the dedicated listener's exact-fit connection budget,
the builder EventSource cursor, the Server Action body boundary, and fractional
ordering. Worktree `agent/s01-lookup-persistence` owns S01a. The frozen contract
passed `ready` and moved immediately to `in progress` when that branch claimed
it; delegation remains bounded by the review units below. S01a ships and its
branch/worktree is cleaned before S01b is cut fresh from the merged `main`, so
the two review units never form a stacked-branch dependency.

S01 is delivered as two review units so persistence/authorization and long-lived
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
a failed lookup-manifest read schedules a bounded unref'ed retry rather than
waiting forever for another notification. S01b applies the same retry contract to
the existing mutation pump: a failed accepted-mutation catch-up SELECT must retry
without requiring another commit, poke, or reconnect. Abort and stream-cancel
teardown clear both retry timers and both subscriptions. Reconnect pokes every
lookup subscriber, which re-reads the current manifest, so revision jumps are
expected and lossless.

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

Define wire/expression behavior for S01's already-frozen stored blank/missing/null
cells and scalar types, plus duplicate or blank option values, no-match reads,
answer-dependent filters, repeat scope, dependency cycles, and definition-plus-row
snapshot consistency. S05 may reject an unrepresentable use at validation/export,
but cannot change S01 import coercion or reinterpret stored rows.

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
