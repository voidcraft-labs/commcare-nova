# Lookup data

`lib/lookup` is Nova's single persistence and validation boundary for
Project-scoped lookup tables. Lookup rows are app-state data in the shared Cloud
SQL/Postgres database. They are not case rows, not part of `BlueprintDoc`, and
not CommCare-shaped storage. The local CCZ compiler resolves stable Nova UUID
references and emits the exact CommCare fixture wire.

## Identity and tenancy

- Tables, columns, rows and detail members use distinct server-minted UUIDv7 identities
  and runtime schemas from the import-light `lib/domain/lookupIds` leaf. There
  is no public generic lookup id: a table id cannot satisfy a column- or row-id
  slot. Display names, table tags, column wire names, and order keys are mutable
  projections, never identity. A table brought in from CommCare HQ takes table
  and column ids that are UUIDv7 too, derived from the bring-in's reading id
  and CommCare HQ's own names (`lib/deployment/reading/projectData/lookupIds.ts`),
  so its read and its create name the same ones with nothing stored. Its rows
  take server-minted ids, as every row does.
- Row values are keyed by immutable column UUID. Never key or rewrite stored
  values by `wire_name`.
- Every resource query includes both `project_id` and its resource UUID. A
  missing id and a foreign-Project id must have the same not-found result.
- `created_by` and `updated_by` are provenance only. The Project is the tenant;
  the existing `view` / `edit` / `delete` capability map is the authority.
- Browser boundaries receive an explicit Project id from the displayed state,
  authorize that exact id freshly, and construct `LookupScope` server-side.
  Never fall back to the user's mutable active Project. A `LookupScope`'s
  `role` serves reads and a boundary's early answer; it never authorizes a
  write (below).

## Valid writes

Every mutation parses/coerces input before its lookup write, then uses this
lookup lock order:

1. read the member's role on the write's own transaction, under the shared
   membership gate with the member row `FOR SHARE`
   (`writerTransaction.ts::authorizeLookupWriteInTransaction`), with the
   capability the write needs;
2. create-if-missing and lock `lookup_project_state` for the Project;
3. lock the target `lookup_tables` row, when there is one;
4. compare `expectedTableRevision` and re-read the current definition;
5. validate and write children/counters;
6. advance the Project revision once, stamp the affected table revision axis,
   and issue the transactional lookup notification;
7. commit.

**Authority is read in the transaction that writes, by type.** Step 1 answers
a `LookupWriteAuthority` that only `authorizeLookupWriteInTransaction` makes
and that is good only on the transaction it was read on (a module-private
map from each authority to its transaction); `lockLookupProjectState` and
`lockLookupTableForUpdate` take one and nothing else, so no writer reaches
Project state or a table on a role read before its transaction, during a read
of CommCare HQ, or in another transaction. A member removed since the request
began is `LookupAuthorityError` `not-a-member`; one whose role fell below the
write's capability is `below-capability` with that capability. Both carry the
code `not_found`, the shape every ordinary boundary already gives a resource
the caller may not touch; a surface that names who can change something reads
`standing` and `capability`. Each writer states its own capability, never its
caller: the service's writers `edit`, a tag or wire-name change `delete`;
schema governance `delete`; an authoring batch `delete` where it renames a
tag or a wire name, retypes or removes a column, or removes a table, else
`edit`; and `lockLookupTableForUpdate` holds each purpose to its floor
(`author` and `hq-refresh` need `edit`, `remove-table` and `hq-management`
need `delete`), so the adoption arm of a refresh and a takeover need `delete`
inside the writer whoever calls them. A second read on one transaction is
harmless: the gate is held and the row already locked.

`lockLookupTableForUpdate` takes the write's purpose. A table managed in
CommCare HQ (`hq_server` set, no takeover) refuses an `author` write with
`managed_in_hq` before its revision is compared; `remove-table` is allowed in
every state; `hq-refresh` and `hq-management` are `managed.ts`'s alone. No
writer reaches a table row another way.

Browser actions, the CSV route and schema governance enter the prefix
directly: they take no app lock, so their order is the membership gate, then
Project state, then tables. App-bound SA/MCP writes first take the
invocation's app row, prove its unchanged Project, fresh membership, and, for
chat, exact run holder, then read the lookup authority and enter the same
Project-state/table prefix. No code may hold Project state or a lookup table
and later request an app lock or the membership gate. A birth that brings
tables in from CommCare HQ is app-first like every app-bound writer: it inserts
its own app row, which no other session can name, then takes Project state and
writes the tables (`lib/deployment/reading/projectData/lookupTableStore.ts::writeBroughtInLookupTablesInTransaction`,
which takes the birth's transaction after its app row is inserted), and
requests no other app row after. A bring-in of changes made in CommCare HQ
runs the same writer inside its commit (`lib/db/applyBlueprintChange.ts`'s
`projectDataWrite`): the app row `FOR UPDATE`, the membership gate and member
row, Project state, the tables in id order, then the deployment row the
commit's record takes. A publish's workbook admission takes the app row, the
deployment row, then the lookup authority, Project state and the tables; it
holds the app row against that commit, so the two never cross. The
app-bound bridge is app-first; the direct Project writer is Project-first with
no reverse edge.

Case submissions also hold their app authority before locking the program's
referenced lookup tables `FOR SHARE` in UUID order. These locks remain through
commit, so separate condition and value evaluations read one table generation.
They do not acquire Project state or change lookup data. Every lookup writer's
table `FOR UPDATE` prefix is the corresponding fence.

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

`agentService.ts` resolves an app, reviewed build session, or ordinary authoring
session to establish its exact current Project and capability. Ordinary work
retains its own actor, origin, and chat-thread authority before and after app
birth; it never borrows a design-session identity. Its lookup receipts are keyed
by the stable work ID, and receipt replay rechecks that authority and membership
inside the lookup transaction. Project data writes can precede the first app
checkpoint and remain immediate effects when app work is discarded. Reads require `view`; ordinary writes require `edit`;
tag/wire-name,
retype, remove-column, and remove-table operations retain `delete`. Chat calls
also prove the exact run holder in the writing transaction. These tools are
`mutate-external` with staged execution forbidden, because lookup rows are not
Blueprint state and cannot participate in a change-set workspace.

`actions.ts` exports `deleteLookupTableAction`, `removeLookupColumnAction`, and
`retypeLookupColumnAction`, and the Project data workspace's confirmation dialog
calls them after naming the apps a destructive change would block. Established
table-tag and column-wire-name changes plus those destructive schema actions
require the existing `delete` capability; row operations and non-identity edits
require `edit`; reads require `view`.

CommCare HQ identifies a lookup table by tag. Publishing after a tag change
creates a table under the new tag and reports the old table so its owner can
decide what to do with it. Rows and app references in Nova keep their UUIDs.
See `lib/deployment/CLAUDE.md` for the target ownership rules.

HQ accepts up to 32 characters for a tag. A tag and a column export name must
be namespace-free XML names and must avoid HQ’s reserved lowercase `xml`
prefix. Project data measures length in Unicode code points. These constraints
apply to storage and to the PostgreSQL checks. Core routes a fixture whose
source contains lowercase `ledgerdb` or `casedb` to another store, so Nova
also rejects those substrings in a tag. A table named `locations` can coexist
with the worker’s places. Its qualified form instance ID reads the table while
the places instance continues to read the worker’s assigned places.

A Project can keep an export name that some formulas cannot address. The app
gate checks the actual table and column names at the expression that uses them.
Core reads a narrower alphabet than XML, and HQ rewrites periods between
nondigits in certain list and display conditions. A refused formula names the
affected source and use so the author can choose a compatible name or change
the formula.

## Reference edges and schema governance

`lookup_table_references`, `lookup_column_references` and `lookup_member_references` store stable
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
transaction core reads the member's `delete` on its own transaction before
taking a lock and collapses an insufficient role, or a membership removed since
the request began, to the same not-found shape as a missing or foreign resource.
Its complete lock prefix is the membership gate and member row -> Project state
`FOR UPDATE` -> exact table `FOR UPDATE` -> exact table/column edges. It never takes an app lock. Blocker results
contain the sorted exact app-id set only; a fresh carrier-path re-walk belongs to
confirmation UX.

A lookup-backed search input's `options.sortColumnId` is one more occurrence a
table or column deletion sees, beside its value and label columns. Form logic
that reads a table or column (a question's logic, a Connect slot, or a form
link's condition or datum value) is one more carrier, so its deletion is
refused while that read stands, as it is for a record expression. Those reads
hold the table and column UUIDs and print the current tag and export names, so
a rename keeps them reading.

An unreferenced table deletion uses the existing
row/column cascades, retains Project state, and advances/notifies once. Column
removal rejects the last column before row changes, removes only that immutable
UUID key where present, uses Postgres-generated before/after `value_bytes`,
updates row provenance plus table counters, stamps both revision axes, and
reports affected rows/cells/freed bytes. Column retype inspects only present
cells through typed-input validation, never coercion or stored-value rewriting,
and changes the definition only after every value passes. Projection changes
preserve UUIDs and never rewrite edges. Before a tag or column rename commits,
the Project data actions and the shared authoring batch check its final names
under the table lock. `nameGovernance.ts` follows exact app edges and reads each
app root and its entities in a single statement, including apps in the trash.
The app's production occurrence registry and the commit gate share the same
per-use name verdict. A period may work in one use and change meaning or hide
a table from another. A refusal names a dependent app, the affected place and
a spelling that works there. A temporary pre-genesis protection can establish only
the identity, so it allows a rename used everywhere and holds a use-dependent
name until the design finishes or is superseded. A managed refresh matches
columns by exact spelling. If HQ replaces a field, the new field gets its own
identity and the old, still-referenced field keeps its identity and spelling.

## Values, ordering, and limits

Tags that share a runtime or editor name retain their tag and table identity.
The form writer assigns them a qualified local instance ID, including the
`selected_cases` family and Vellum’s own dictionary keys. A formula reads
the table by its UUID; the writer derives the source and the local alias at
export. The same spellings can name a column. A historical tag containing
lowercase `ledgerdb` or `casedb` still needs an authorized rename because
Core dispatches the fixture source itself to that store.

- Table row details and each repeated column's value details have separate, ordered
  definitions with UUIDs, display labels and export names. A row detail is required on
  every row, including when its value is empty. A missing rich column, an explicitly
  empty list, and one occurrence with empty text are three different stored states.
  Each occurrence preserves exact text, its optional UUID-keyed details and order.
  Index status distinguishes indexed, unindexed, and source-managed unobserved.
- A Project row may contain only attributes. A reader's column or member reference
  identifies its exact owner. The reference writer verifies it under the table lock.
  A member deletion checks every dependent app, including archived apps, and the
  enclosing legacy design protection. Rich schema edits that affect readers compare
  the reviewed Project and table revisions and complete reader app IDs.
- Missing UUID key means a missing cell. JSON `null`, booleans, arrays, objects,
  unknown column ids, NUL, and unpaired UTF-16 surrogates are invalid. Empty text
  is valid for typed writes; an empty CSV cell omits the key.
- Integer is canonical signed int4, decimal is a finite JSON number, and temporal
  values reuse Nova's strict date/time/date-time schemas.
- Server-minted order keys use the shared base-62 fractional-order primitives and
  Postgres `C` collation. Reads always tie-break on stable UUID. Bulk replacement
  uses the balanced generator, never a 5,000-key sequential chain.
- Inline changes admit up to 250 columns or details and 5,000 rows. A string in
  an inline request is at most 64 KiB, a full inline row 256 KiB, and an inline
  replacement 8 MiB. Adding an individual row or reducing a cell uses the actual
  transaction delta and the Project's physical storage budget. Tables can grow
  beyond one request. The exact row measure is PostgreSQL's byte length of the
  scalar JSONB text, the structured JSONB text for a nonempty structured body,
  and the exact UTF-8 bytes of its reference-backed text.
- A partial row edit addresses the row and column or detail by UUID. A repeated value
  is addressed by ordinal within that column at the expected table revision. Patches
  update only those JSONB paths in PostgreSQL. A browser operation ID is scoped to
  its Project and actor. Its digest, committed receipt and recorded minimum
  capability make exact retries safe after a role change.
  A repeated CSV import binds the raw bytes as well as the table and revision.
- A staged text value keeps its lexical bytes in immutable segments. Its empty
  inline string preserves the shape of that slot. Row projections read the
  actual bytes, include the full value digest and both character and byte
  offsets, and find matches across segment boundaries. Ordinary edits preserve
  other slots and shift surviving references with their occurrence on insertion
  or removal. The Project row grid and model-facing row reads hold assigned
  inventory behind the current source connection.
- `column_count`, `row_count`, and `data_bytes` are maintained under the locked
  table row. A delete/shrink returns capacity. Concurrent writers cannot cross a
  cap.

## Staged source inventories and large values

An editor can refresh an accepted source reference in Project data. A reading
of an unaccepted application never creates a job. The remote reader brackets
two complete ordered visits with the selected table definition. The resumable
checkpoint binds the ordered prefix to the authenticated server, domain,
principal and definition. The local job also binds the exact table revision,
actor, Project membership revision, connection and browser or MCP grant.
Each staged page records its inclusive start, exclusive end, ordered payload
digest and through-digest. A remote row identity is unique throughout the
generation. A page that moves, disappears, repeats an identity or reuses an
offset with different bytes cannot become visible. An interrupted run resumes
only after an independent re-read of its prefix. The runner lease fences a
process that resumes after its replacement.

Only a completed verification moves the table's active pointer. Historical
source inspection checks the current Nova grant and Project role together
with live permission on the HQ fixture resource using the editor's own
connection. A cursor names the active generation, row ordinal and UTF-8 byte
boundary. Each response is at most one 32 KiB source chunk. The source
inventory has its own permission boundary. Worker and installation
projections use their verified distribution facts and carry their own scope.

An authored value can replace a reviewed byte range at a stable row and
cell, row detail, occurrence or value detail. The request binds the original
table revision and SHA-256, interval and replacement length and digest. A
retry uses the same operation UUID, authority and reviewed request. Ordered
32 KiB write chunks may split a UTF-8 character. Completion independently
validates the old prefix, replacement and suffix. Text keeps its exact lexical
value, including an initial byte-order mark. An over-budget, invalid, stale
or cancelled replacement leaves the visible value and revisions intact.
The author receives at most 8 KiB of validated UTF-8 per value range.

Large text lives in immutable, Project-local blobs and ordered value
segments. The row's value reference names the active content and digest.
Its empty inline string marks the occupied slot and preserves occurrence
shape. A reader resolving a value must follow that reference. Small and
empty values are stored inline. Foreign Projects cannot use equality of
content as authority. A small splice reuses physically identical existing
blobs. Retyping, occurrence edits, schema deletion and row replacement update
or remove the matching references in their own transaction.

The default storage budget is 32 GiB and two concurrent bulk jobs per Project.
The budget row controls both. A job holds a work slot only while it runs: a generation
while its runner holds its lease, an export while its artifact holds its build
lease, and a large-value edit for ten minutes after its last step, so a
failed, cancelled or abandoned job frees its slot while its bytes wait for
recovery. SQL triggers settle payload and metadata with
a conservative per-row allowance for indexes and tuple overhead. Bulk objects
reserve before writes, transfer their charge to retained storage after
confirmation, and refund on confirmed physical deletion. Replaced generations
and unreferenced blobs keep their charge through cleanup. A shrinking value
edit can use reserved rewrite space. PostgreSQL commits a deletion together
with its refund. New schema migrations adding measured columns must reconcile
the existing measurement in the same migration. Operators can audit totals
before and after migration with `scripts/scan-lookup-storage.ts`. A bounded
`scripts/reclaim-lookup-storage.ts --max-batches N` invocation resumes SQL
cleanup after an interruption. The migration that widens `lookup_tables.data_bytes` to
bigint runs while the previous revision serves, and that revision adds a row
by concatenating the string the driver now returns; once it stops serving,
`scripts/scan-lookup-table-bytes.ts` sizes the damage and
`scripts/migrate-lookup-table-bytes.ts --execute` sets each inline table's
total back to its rows' stored bytes. External object owners confirm physical
deletion before requesting their refund.

## Tables from CommCare HQ

A table is in one of three states, read from its origin columns and nothing
else: plain (every `hq_*` column null, a table made in Nova); managed in
CommCare HQ (`hq_server` set, `hq_taken_over_at` null: Nova holds a copy and
refuses every author's edit); and managed in Nova, from CommCare HQ
(`hq_taken_over_at` set: a person chose Manage in Nova, and the origin stays so
the table can be handed back). Two CHECKs hold the origin whole or absent and a
takeover attributed and only on a table with an origin. `LookupHqOrigin` is
the state as the snapshot and the definition return it, and
`LookupManifestHqOrigin` as the manifest entry carries it, each under `hq`,
present exactly when `hq_server` is set. The manifest's leaves out the day of
the last refresh and `goneColumnIds`: a refresh that found CommCare HQ's
table as it was stamps that day and advances no revision, and the bytes of
one manifest revision never change, so a page reads the day from the table.
`goneColumnIds` is every column whose wire name is in no field of the stored
copy of CommCare HQ's table, and only while CommCare HQ manages the table:
only a refresh keeps such a column, and a table Nova manages is not refreshed,
so a column added or renamed in Nova is never reported gone.

`managed.ts` holds the writers of a copy, each taking a `LookupWriteAuthority`. The create arm makes tables
under the ids it is given, every column `text`, its label the field name's
first 120 characters (`managedRules.ts::columnLabelFor`), its origin in the
table's insert, with one revision and one notice. The refresh arm matches
columns to CommCare HQ's fields by wire name: a new field adds a text column, a
column with no field is removed unless an app's column edge or an accepted
design names it, and then stays, empty, after CommCare HQ's columns; a row with an authenticated identity retains its Nova UUID only for the same source
table and remote row ID. Refresh preserves exact ordered values. An unavailable
source marks the retained data historical and advances both revision clocks. Every column
of a managed table is text. Taking CommCare HQ's table over a Project table
(`adopt`) sets every column to text with no stored value coerced, since the
rows that follow are CommCare HQ's strings, clears a takeover, and stamps
`definition_revision`. Both arms fix every column id first (the refresh arm
takes a new field's id from `newColumnIds` under its own key, or mints one with
Postgres's `uuidv7()`), then judge the bounds of one inline copy before their
first write and before the cells' own check
(`managedRules.ts::lookupInlineCopyExcess`, over Postgres's own measure of the
rows, `measureLookupRows`), so a copy one transaction cannot carry is refused
with `storage_limit`, its phrase and the paged refresh as its next step. None
of those bounds limits a table: a refresh from a table's page that meets one
reads the same table again in pages into a staged generation
(`lib/deployment/managedInventory.ts`), and a publish compares a table past one
inline read with the copy's digest page by page rather than stopping on its
size. A measured size in a phrase is rounded up
(`format.ts::formatLookupBytesOverCap`), so it never reads as the bound it is
past.

`hq_canonical` is `lib/deployment`'s value for CommCare HQ's table at the last
refresh; `lib/lookup` reads its `digest` and `fields[].name`
(`managedCanonicalSchema`) and passes the rest through. A refresh whose source facts, schema, ordered row identities and values are unchanged stamps only `hq_refreshed_at` and
`hq_refreshed_by` and advances no revision; one whose digest moved but whose
columns, rows and gone columns are as they were also writes `hq_canonical`.
Neither changes a byte of the manifest. Only a refresh that changes neither
the copy nor its gone columns is `nothing`: one that changes only which
columns read as gone (a field an app's column reads dropped in CommCare HQ, or
come back) stamps `definition_revision`, advances the Project and notifies, as
an added or removed column does, because every open page holds `goneColumnIds`
in the definition it keyed on that revision. Its `at` is when the read of
CommCare HQ began, and no lock spans that read, so a refresh, Refresh or
hand-back passes `olderReadYields`: under the table lock, one whose `at` is
earlier than the stored `hq_refreshed_at` writes nothing and answers
`superseded`, and a hand-back whose `at` is earlier than a takeover recorded
since is `conflict`. A bring-in passes false, since its app binds the column ids
its reading gave; it passes its reading's own read date as `at`, and the
refresh arm refuses, under the table's lock, a table whose stored
`hq_refreshed_at` is later (`LookupReviewMovedError`), so it never writes an
older read over a newer one either. The CSV replacement route refuses a table CommCare HQ
manages with `managed_in_hq` before it compares the revision or reads the CSV,
as the lock does for every other writer. A change of who manages a table
stamps `definition_revision`, because every client reads editability from it.
A hand-back (`adopt`) of a table a publish's workbook carries waits while that
workbook's write to CommCare HQ is open (`hq_remote_writes`, refused
`conflict` with `handBackWhilePublishing`): the publish admits its workbook
under the Project state and each table's row
(`lockLookupTablesForPublishInTransaction`, which changes nothing and reads
the publisher's `edit` on its own transaction), so a hand-back committed
first stops the workbook, and one after waits for it.

The `adopt` arm also takes a plain table: **Use the table from CommCare HQ**
(`lib/deployment/managedData.ts::takeHqTableForLookupTable`) makes a table made
in Nova, which a publish of the Project's apps put in a project space, Nova's
copy of the table there, with that origin, held to the same reviewed revisions
and readers (`readLookupTableReviewSnapshot` reads them for any table, plain or
not). The table keeps its id, so no app changes. **Create a separate table**
(`lib/deployment/separateTable.ts`) makes a new plain table from a table's
inline definition and rows through `applyLookupAuthoringBatchInTransaction`, and
leaves the old table, its origin and its revisions as they were; an index
CommCare HQ never showed is not authored on the new table.

**A change of who manages a table is held to what was reviewed.** An adoption
(`adopt`) and a takeover take `ManagedTableReviewed`, the table's
`definitionRevision`, `rowsRevision` and `readerAppIds` (the Project's apps
whose reference edges name it, sorted) as the person or the reading saw them;
the types make an unreviewed change of who manages a table impossible. Both
compare it after the table's `FOR UPDATE` lock, reading the edges on that
transaction: adding an app's reference moves no revision, and an app commit
takes the table `FOR KEY SHARE`, which waits behind that lock, so no reader can
appear between the compare and the commit. A mismatch is
`LookupReviewMovedError` (code `conflict`), and nothing is written. A refresh
may carry the revisions a reading saw (a bring-in's `same-managed` table), and
is held to them the same way; Refresh and a publish's re-read carry none, since
they confirm nothing and a copy CommCare HQ manages takes no author's edit. A
read that began before the table's last refresh is refused the same way where
`olderReadYields` is false. `readManagedTableReview` reads the review a
confirmation shows (who manages the table, the triple, the definition and the
named readers) from one read-only `REPEATABLE READ` snapshot, and
`managedTableReviewDigest` is the digest a confirmation carries back
(`lib/deployment/managedData.ts`). An accepted design that protects a column is
not one of the readers: it is a member's private, pre-app work, and the columns
it protects are kept by every refresh and adoption as an app's are, so it
loses nothing the confirmation would have to name. The dates
`hq_refreshed_at` and `hq_taken_over_at` order reads of CommCare HQ; they never
stand in for the member's authority or the table's revisions.

## Reads and realtime

Manifest and row-window reads use one read-only snapshot. The table workspace
loads 25 rows at a time with previous and next revision-bound cursors. Search
matches projected attributes, occurrence text and value details. Row movement
uses absolute positions in the full table. Oversize rows show their identity,
position and size. An inspector can continue through their values. Export
and worker delivery have separate source and access checks.

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
fixtures, the two CommCare HQ modes turn it into the fixapi workbook, leaving
out a table CommCare HQ manages in the project space the upload is for, and
putting such tables in the HQ app file in one workbook per project space
that manages a table (`lookup-tables-managed-in-<domain>.xlsx`) — so the
generation Nova pushes is provably the generation it validated), and the
preview's builder-session cache
(`lib/preview/engine/lookupDataBinding.ts`) evaluates carriers over one.
Missing and foreign ids are absent from both the definitions and the rows map.

`nova_lookup_stream` carries lookup invalidation. The one shared dedicated listener
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
- `writerTransaction.ts` is the one private lookup-writer
  authority/lock/revision/notify protocol shared by `service.ts`, schema
  governance, the authoring batch and `managed.ts`. Do not fork its lock order
  in a new writer, and never construct a `LookupWriteAuthority` by hand.
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

Snapshot tests should hold a real writer between definition and row reads and
assert that the complete result stays in one generation. A sequential read of
matching revisions cannot prove snapshot isolation. Own the pending reader from
start to finish, release database gates in `finally`, and join it before teardown.

Prove rollback after writes have occurred; preflight rejection alone cannot
establish batch atomicity. Pagination assertions should join all pages and check
ordered identities and cells. Blocker-name filtering belongs in a real database
test with foreign and unrelated apps, because a mocked query chain cannot prove
Project isolation.

## Worker assignments

The Project owns worker groups and each table's row assignments. A worker or place reference carries both its app and UUID. Group references carry their Project. A restore grants the ordered union of direct worker, group membership and primary place ancestry. Additional places and the group case-sharing setting do not grant lookup rows. The audience of a complete worker restore and the audience of an editor inventory are distinct.

Assignments are replaced in the row transaction, guarded by table revision and operation identity. Removing an assignment, changing group membership and changing where a worker is assigned invalidate worker evidence. Moving an app to a different Project requires removing its Project-bound assignments first.

Taking over an assigned source table takes a new selected workbook with the confirmation. Each source UID must match the entire ordered source inventory. Each principal must resolve to exactly one current source-space ledger binding in this Project. Compare the modeled projections, including empty and duplicate rows, to fresh authenticated worker restores before materializing any assignments. A historical workbook never authorizes that action. Hand-back discards the local assignment set.
