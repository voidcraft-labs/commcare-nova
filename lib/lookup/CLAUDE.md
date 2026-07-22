# Lookup data

`lib/lookup` is Nova's single persistence and validation boundary for
Project-scoped lookup tables. Lookup rows are app-state data in the shared Cloud
SQL/Postgres database. They are not case rows, not part of `BlueprintDoc`, and
not CommCare-shaped storage. A later compiler resolves stable Nova UUID
references and emits the CommCare fixture wire.

## Identity and tenancy

- Tables, columns, and rows use server-minted UUIDv7 identity. Display names,
  table tags, column wire names, and order keys are mutable projections, never
  identity.
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

Every public mutation parses/coerces input before entering `withAppTx`, then
uses this lock order:

1. create-if-missing and lock `lookup_project_state` for the Project;
2. lock the target `lookup_tables` row, when there is one;
3. compare `expectedTableRevision` and re-read the current definition;
4. validate and write children/counters;
5. advance the Project revision once, stamp the affected table revision axis,
   and issue the transactional lookup notification;
6. commit.

The transaction body may be retried. Keep it free of non-database side effects.
Rejected and semantic no-op writes do not advance a revision or notify. The
Project revision is only an invalidation cursor; the optimistic token is
`max(definitionRevision, rowsRevision)`.

Schema/display/column/order changes stamp `definition_revision`. Row
create/update/delete/order/replacement changes stamp `rows_revision`. Revisions
are canonical nonnegative decimal strings within signed-int64 range on every
application wire. Never convert one through `Number`, serialize native `bigint`,
or compare revision strings lexically.

S01 permits additive columns but exposes no table delete, column removal, or
column retype. Established table-tag and column-wire-name changes require the
existing `delete` capability; all row operations and non-identity edits require
`edit`; reads require `view`.

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

`nova_lookup_stream` writes and reads are live. The one shared dedicated listener
fans exact decimal revisions only to subscribers for that Project, and the app
stream relays seq-less full-manifest frames over the builder's existing
EventSource. Lookup frames never set SSE `id:`; that cursor belongs exclusively
to accepted app mutations. The relay subscribes before its initial snapshot,
coalesces pokes, and retries failed manifest reads for the stream lifetime with
a capped, unref'ed delay. The collaboration context exposes
`subscribeLookupManifest`; lookup snapshots remain outside blueprint reconciler
state and its mutation `baseSeq`.

## Boundaries

- `service.ts` is server-only and owns SQL. It accepts an authorized
  `LookupScope`; no route or action contains database logic.
- `actions.ts` authenticates, runtime-parses untrusted arguments, authorizes the
  explicit Project, calls the service, and maps typed errors to discriminated
  results.
- CSV replacement has no Server Action. The raw route rejects declared and
  actual oversize bodies, authorizes before parsing, then calls the server-only
  replacement service. Parsing/coercion happens before the transaction and is
  repeated against the locked current definition inside it.
- Do not import `lib/commcare` here. S05 owns expression/export meaning and the
  aggregate compiled-artifact budget; it may reject an unrepresentable use but
  cannot reinterpret S01's persisted values.

Keep pure schema/coercion/CSV/order tests separate from Postgres integration
tests. Bundle Postgres-focused tests into one invocation so local and CI runs do
not create unnecessary containers.
