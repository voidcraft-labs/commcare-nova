# Lookup data

`lib/lookup` is Nova's single persistence and validation boundary for
Project-scoped lookup tables. Lookup rows are app-state data in the shared Cloud
SQL/Postgres database. They are not case rows, not part of `BlueprintDoc`, and
not CommCare-shaped storage. The local CCZ compiler resolves stable Nova UUID
references and emits the exact CommCare fixture wire.

## Identity and tenancy

- Tables, columns, and rows use the distinct server-minted UUIDv7 identities
  and runtime schemas from the import-light `lib/domain/lookupIds` leaf. There
  is no public generic lookup id: a table id cannot satisfy a column- or row-id
  slot. Display names, table tags, column wire names, and order keys are mutable
  projections, never identity.
- Row values are keyed by immutable column UUID. Never key or rewrite stored
  values by `wire_name`.
- Every resource query includes both `project_id` and its resource UUID. A
  missing id and a foreign-Project id must have the same not-found result.
- `created_by` and `updated_by` are provenance only. The Project is the tenant;
  the existing `view` / `edit` / `delete` capability map is the authority.
- Browser boundaries receive an explicit Project id from the displayed state,
  authorize that exact id freshly, and construct `LookupScope` server-side.
  Never fall back to the user's mutable active Project.

## Valid writes

Every mutation parses/coerces input before its lookup write, then uses this
lookup lock order:

1. create-if-missing and lock `lookup_project_state` for the Project;
2. lock the target `lookup_tables` row, when there is one;
3. compare `expectedTableRevision` and re-read the current definition;
4. validate and write children/counters;
5. advance the Project revision once, stamp the affected table revision axis,
   and issue the transactional lookup notification;
6. commit.

Browser actions and accepted-design materialization enter that prefix directly:
their exact Project authority is already established and they never need an app
lock. App-bound SA/MCP writes first take the invocation's app row `FOR SHARE`,
prove its unchanged Project, fresh membership, and, for chat, exact run holder,
then enter the same Project-state/table prefix. No code may hold Project state
or a lookup table and later request an app lock. The app-bound bridge is
app-first; the direct Project writer is Project-first with no reverse edge.

The transaction body may be retried. Keep it free of non-database side effects.
Rejected and semantic no-op writes do not advance a revision or notify. The
Project revision is only an invalidation cursor; the optimistic token is
`max(definitionRevision, rowsRevision)`.

Schema/display/column/order changes stamp `definition_revision`. Row
create/update/delete/order/replacement changes stamp `rows_revision`. Revisions
are canonical nonnegative decimal strings within signed-int64 range on every
application wire. Never convert one through `Number`, serialize native `bigint`,
or compare revision strings lexically.

`authoringBatch.ts::applyLookupAuthoringBatchInTransaction` is the one
transactional composition of these writers. It can create complete tables with
typed initial rows; patch table
metadata; batch add, update, move, remove, or retype columns; batch add, replace,
move, or remove rows; replace the complete row set; and remove governed tables.
It parses the whole request and resolves request-local creation keys before the
transaction, then revalidates values and topology after locking. Every existing
target uses stable UUID identity and `expectedTableRevision`; every move names
an immutable predecessor UUID, never a numeric position. A success advances the
Project once, notifies once, and returns every minted UUID plus the resulting
revision axes. Any operation failure rolls back the complete batch.

`agentService.ts` resolves an SA/MCP app only to establish its exact current
Project and capability. Reads require `view`; ordinary writes require `edit`;
tag/wire-name,
retype, remove-column, and remove-table operations retain `delete`. Chat calls
also prove the exact run holder in the writing transaction. These tools are
`mutate-external` with staged execution forbidden, because lookup rows are not
Blueprint state and cannot participate in a change-set workspace.

Table deletion, column removal, and column retype are reachable:
`actions.ts` exports `deleteLookupTableAction`, `removeLookupColumnAction`, and
`retypeLookupColumnAction`, and the Project data workspace's confirmation dialog
calls them after naming the apps a destructive change would block. Established
table-tag and column-wire-name changes plus those destructive schema actions
require the existing `delete` capability; row operations and non-identity edits
require `edit`; reads require `view`.

A tag change has a consequence outside this package worth knowing here:
CommCare HQ addresses a lookup table BY ITS TAG, so a rename makes a NEW table
on every project space the app was published to and leaves the old one where it
is. Nova never deletes a remote resource, so it reports the old tag instead
(`lib/deployment/CLAUDE.md`). A tag is capped at 32 characters here, one past
what a CommCare HQ data sheet can be named for, so the export boundary refuses
the 32-character case by name rather than the emitter meeting a sheet it cannot
name.

## Reference edges and schema governance

`lookup_table_references` and `lookup_column_references` store only stable
Project/table/column/app UUID identity, never names, wire names, carrier paths,
or caller-provided edge deltas. A column edge is constrained to an existing
table edge. Authoritative app commits replace each app's complete freshly
extracted edge sets in their own transaction; the immutable production
registry covers every lookup carrier. Both are app-state tables, not Project
lookup resources, and must not be exposed through this package's table/row APIs.

`design_lookup_materializations` is the immutable pre-genesis receipt for one
accepted Design Contract revision. It binds the design/session/revision digest,
Project revision, result digest, and DesignId-to-lookup-UUID mapping.
`design_lookup_protections` is its temporary destructive-governance edge set.
Governance checks those edges beside canonical app edges; sequence-one genesis
installs the app edges before releasing protection in the same transaction.
Supersede and pre-app discard release protection only. They never delete the
accepted table data, and an exact retry reuses the receipt rather than issuing a
second authoring batch.

`schemaGovernance.ts` is the server-only transaction authority those three
actions call. It reuses `writerTransaction.ts`, the same
Project-state/table lock and revision helpers as every lookup writer. Its
wrapper and transaction core require the scope's `delete` capability before
taking a lock and collapse an insufficient role to the same not-found shape as
a missing or foreign resource.
Its complete lock prefix is Project state `FOR UPDATE` -> exact table `FOR
UPDATE` -> exact table/column edges. It never takes an app lock. Blocker results
contain the sorted exact app-id set only; a fresh carrier-path re-walk belongs to
confirmation UX.

An unreferenced table deletion uses the existing
row/column cascades, retains Project state, and advances/notifies once. Column
removal rejects the last column before row changes, removes only that immutable
UUID key where present, uses Postgres-generated before/after `value_bytes`,
updates row provenance plus table counters, stamps both revision axes, and
reports affected rows/cells/freed bytes. Column retype inspects only present
cells through typed-input validation, never coercion or stored-value rewriting,
and changes the definition only after every value passes. Projection changes
remain allowed while referenced and do not rewrite edges.

## Values, ordering, and limits

- Missing UUID key means a missing cell. JSON `null`, booleans, arrays, objects,
  unknown column ids, NUL, and unpaired UTF-16 surrogates are invalid. Empty text
  is valid for typed writes; an empty CSV cell omits the key.
- Integer is canonical signed int4, decimal is a finite JSON number, and temporal
  values reuse Nova's strict date/time/date-time schemas.
- Server-minted order keys use the shared base-62 fractional-order primitives and
  Postgres `C` collation. Reads always tie-break on stable UUID. Bulk replacement
  uses the balanced generator, never a 5,000-key sequential chain.
- Limits are 250 columns, 5,000 rows, 64 KiB per string cell, 256 KiB per stored
  row, and 8 MiB of stored row values per table. The raw CSV request separately
  caps at 8 MiB. `lookup_rows.value_bytes` is generated from Postgres
  `octet_length("values"::text)`; use SQL `returning value_bytes` for row deltas
  and replacement totals. Never guess JSONB size in JavaScript.
- `column_count`, `row_count`, and `data_bytes` are maintained under the locked
  table row. A delete/shrink returns capacity. Concurrent writers cannot cross a
  cap.

## Reads and realtime

Manifest and full-table reads are authoritative snapshots, not change logs.
Compose each from one SQL statement or a read-only `REPEATABLE READ`
transaction. Multiple ordinary `READ COMMITTED` reads can pair data N with head
N+1 and leave a client permanently stale.

`getLookupTableRowsPage` is the bounded agent read. Its opaque cursor binds the
table UUID, table revision, a digest of the normalized query and projected
column UUIDs, and the next page offset; every page still executes under the
caller's authorized Project scope. Callers repeat that query and projection on
continuation. A changed definition or row revision returns a restart result
instead of mixing generations. Search is case-insensitive text matching over
the projected cells; output remains ordered by fractional key and stable row
UUID. Never expose an order key or accept it as a cursor/address. Model-facing
callers provide their complete serialized result envelope to the paginator so
the byte gate includes `complete`, `nextCursor`, and any bounded inspection
attestation rather than estimating wrapper overhead.

`getLookupDefinitions(scope, tableIds)` is the rows-free validation/compiler
read. It returns only existing requested tables in deterministic table-UUID
order; missing and foreign-Project ids are omitted identically. Project clock,
table definitions, and ordered columns come from one read-only `REPEATABLE
READ` snapshot. Its transaction-taking reader is the only composition seam for
an already-open app transaction after it has acquired the production table
locks; callers must not open a nested definition snapshot.
`definitionSnapshot.ts` owns that transaction reader and intentionally carries
no `server-only` runtime marker: authoritative `apps.ts` writers are also in
plain `tsx` inspector dependency graphs. `service.ts` re-exports the same
function for lookup-package callers; the transaction type remains the server
boundary.

`getLookupFixtureData(scope, tableIds)` is the one-generation
definitions-plus-rows read: the same definitions projection plus every present
table's complete rows in authored `(order_key, id)` order, from one read-only
`REPEATABLE READ` transaction (`fixtureSnapshot.ts`). Its consumers must not
loop `getLookupTable`, whose per-call snapshots could mix generations: EVERY
export mode validates and emits one generation (the `.ccz` embeds it as
fixtures, the two CommCare HQ modes turn it into the fixapi workbook — so the
generation Nova pushes is provably the generation it validated), and the
preview's builder-session cache
(`lib/preview/engine/lookupDataBinding.ts`) evaluates carriers over one.
Missing and foreign ids are absent from both the definitions and the rows map.

`nova_lookup_stream` writes and reads are live. The one shared dedicated listener
fans exact decimal revisions only to subscribers for that Project, and the app
stream relays seq-less full-manifest frames over the builder's existing
EventSource. Lookup frames never set SSE `id:`; that cursor belongs exclusively
to app changes. The relay subscribes before its initial snapshot,
coalesces pokes, and retries failed manifest reads for the stream lifetime with
a capped, unref'ed delay. The collaboration context exposes
`subscribeLookupManifest`; lookup snapshots remain outside blueprint reconciler
state and its mutation `baseSeq`. The relay validates the complete manifest
before emitting it. The client treats malformed, regressing, cross-Project, or
same-revision/different-content pages as failures: it clears the manifest plus
dependent definition/fixture caches and refetches the exact authorized Project
snapshot before lookup authoring or Preview can resume. It never retains a
stale manifest or installs a partial table page.

## Boundaries

- `service.ts` is server-only and owns SQL. It accepts an authorized
  `LookupScope`; no route or action contains database logic.
- `writerTransaction.ts` is the one private lookup-writer lock/revision/notify
  protocol shared by `service.ts` and schema governance. Do not fork its
  lock order in a new writer.
- `actions.ts` authenticates, runtime-parses untrusted arguments, authorizes the
  explicit Project, calls the service, and maps typed errors to discriminated
  results.
- CSV replacement has no Server Action. The raw route rejects declared and
  actual oversize bodies, authorizes before parsing, then calls the server-only
  replacement service. Parsing/coercion happens before the transaction and is
  repeated against the locked current definition inside it.
- Do not import `lib/commcare` here. The compile boundary owns
  expression/export meaning and the aggregate compiled-artifact budget; it may
  reject an unrepresentable use but cannot reinterpret persisted Project data
  values.

Keep pure schema/coercion/CSV/order tests separate from Postgres integration
tests. Bundle Postgres-focused tests into one invocation so local and CI runs do
not create unnecessary containers.
