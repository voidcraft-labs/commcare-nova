# Project data and app settings

Implementation starts at Nova `9a6dc789dd9f`. Source paths below use CommCare HQ `d6c6e16d8ae1`, Core
`8e9ba8d908e9`, Android `7a5584475580`, Formplayer `24383ac71bfb`, Connect `046c7fd78081`, and HQ’s Vellum
`01215f251c57`. HQ paths starting in an app are relative to `corehq/apps/`. The admissions below apply equally
at app birth, refresh, and bringing in a later HQ edit.

## 1. Project data

The 13 entries owned by `project-data-at-hq-size` cover media size, dotted, colliding and Unicode names, the tag
`types`, field properties and multiple values, row attributes, row owners, indexing, missing elements, table
size and the two choice consumers in Questions and Search. Three circumstances cover the number and shape of
places and the cardinality of an owner rule. The separate app-body parsing bound remains.

### 1A. Table definitions, cell values and expressions

Extend Project lookup storage in `lib/lookup`. A column has stable property identities, their wire names and an
index setting. A table has stable row-attribute identities and global or assigned-row distribution. Each row has
attribute values, an ordered list of occurrences per rich column, and typed assignments to workers, groups or
places. Each occurrence holds its exact text plus a map from property UUID to exact text. An absent declared
field in HQ contributes one empty occurrence, an explicitly empty list contributes zero occurrences, and an
empty string contributes one empty occurrence. A missing required row attribute is a source data error. This
follows `fixtures/fixturegenerators.py::ItemListsProvider.to_xml`. It also covers tables with only row
attributes. Keep existing typed scalar columns for Nova authoring. Read HQ columns as text even on refresh and
transfer of management. Preserve `007`, `1.50`, leading spaces, repeated values, empty strings and order. Never
infer dates or numbers.

Use `lib/lookup/managed.ts`, its table lock and separate definition and rows revisions. Reserve UUIDv7
identities for attributes and field properties exactly as for columns. Extend definition snapshots, Project
realtime notices, protected design/app edges, delete/refresh checks, and Project data tools. A schema or owner
edit that affects an existing reader takes its reviewed Project/table revision and complete set of dependent
apps. Offer scalar and repeated cell editing, property and assignment pickers, and revision-bound paginated
inspection. CSV replacement remains lossless only for scalar tables. Offer the rich table editor and typed
workbook/row import for the others. Give tools bounded pages with the same structured values.

Extend choice label/value/sort and lookup expression projections with a row attribute, a field occurrence and an
occurrence filtered by a property/value. Bind table, column, attribute and property by identity. In
`lib/commcare/lookup` and `lib/commcare/xpath` lower to the table’s real fixture and local instance alias. Honor
XPath nodeset ordering and first-node string conversion wherever the consumer requires a scalar. Share
resolution with Search and question choices and with the case-store compiler on admitted SQL slots. Gate a
malformed or ambiguous selector at its actual slot. Changes to assignments or repeated values must invalidate a
worker’s cached choices. Include missing-vs-empty, identical text with different properties and two rows with
different attributes in editor/reader, SQL, both worker engines and saved-answer tests.

Keep three name judgements separate. HQ’s table editor checks XML names and rejects lowercase `xml` at the start
(`fixtures/utils.py::is_identifier_invalid`). Core’s `org/javarosa/xpath/parser/Lexer.java::matchNCName`
consumes UTF-16 units, accepting uppercase/lowercase letters and underscore initially, and decimal digits, dot
and hyphen thereafter. Generate the admitted ranges from the pinned runtime predicates and test each range edge
in the Android and JVM readers. A stored XML name need only satisfy the wire consumer that uses it. The Lezer
name token, printer and identity resolver share the tested readable subset with group 7’s case-write names.
Retain refusal for a tag whose fixture source is routed to the case or ledger database. For collisions with
runtime **instance IDs**, allocate an available form-local alias by source before printing declarations or any
expression. Vellum does so in `src/form.js::addInstanceIfNotExists`. Reserve every real and generated instance,
handle two colliding aliases, and resolve the incoming alias by its declared source.

A period is legal in the table. Test the emitted spelling *in its consuming slot*. In HQ’s
`app_manager/xpath.py::dot_interpolate`, the exact pinned function changed `n.m` to `nCASEm` with replacement
`CASE`, and preserved `n.1`, `1.m` and quoted `'n.m'`. Admit paths that survive print/build/parse at that slot,
and report the specific unprintable reference where HQ interpolates it. Never rewrite the tag or field across
the Project to repair one use.

### 1B. What an HQ key can read

Discover referenced tables by tag and stable remote ID. Read the ordered rows of just that table with
`fixtures/resources/v0_1.py::FixtureResource.obj_get_list`. For a definition with row attributes or rich cells,
fetch each selected row through the **detail** of `LookupTableItemResource`. Join on requested row ID and table
ID, verify fields, sort key and exact ordered row set, then check definition and ordered content again before
accepting. The detail exposes `item_attributes` and field occurrences. Its *list* reads the whole project space
and provides no table filter. Do not collect unrelated rows. Retain fixed origins, authorization, pagination,
duplicate/missing row checks, cancellation and bounded retries in `lib/commcare/hq`. A moving read restarts or
asks for another review. It never yields a partial table.

Row discovery and row decoding have different contracts. A source can supply a valid device fixture even
when the ordered table list cannot enumerate a page containing a zero-occurrence field. Its selected-table
workbook can also be unavailable for a genuinely absent row field. Treat a failed or truncated page as an
incomplete inventory. A person’s list of known row IDs, a historical ledger or a partial workbook cannot
prove that these are all rows. See `fixtures/resources/v0_1.py::FixtureResource.dehydrate_fields`,
`LookupTableRow.fields_without_attributes`, `fixtures/download.py::_prepare_fixture` and
`ItemListsProvider.to_xml`.

For a **verified global** table there is a second, bounded completeness check. Obtain an authenticated full
restore for this exact server/domain and fixture tag and take the complete sequence’s cardinality
independently. Obtain candidate row IDs from the scoped deployment ledger or an editor-supplied HQ export.
Page through authorized details, require distinct IDs all under the same remote table, and require exactly
the independently observed count. Order the verified details by HQ’s sort key and remote ID and compare
their device projection, including multiplicity, with the complete global fixture. This proves coverage by
distinct IDs and count without assigning identities by value. Recheck the definition and repeat the
observations bracketing acceptance or a resumed write. If no authoritative count/fixture or complete ID
set is available, offer the managed reference and explicit refresh or HQ repair. Only a verified worker
projection may execute. Block editable takeover, general export and cross-target duplication until
completeness can be established. For an assigned-row table even a full worker restore samples a subset and
cannot supply a table-wide count. A usable birth must still pass the choice-source checks below. Never widen
the credential’s read to unrelated tables to obtain missing IDs.

The table/row APIs omit index flags and owner lists. Store **source-managed, unobserved** separately from
observed false, empty or an authored setting. In the source space a reviewed reference reads its own fixture and
a publish writes no table. Project data can take a selected-table workbook downloaded by a person through HQ’s
Lookup Tables page. `fixtures/download.py::_prepare_fixture` writes indexed fields and per-row user, group and
location columns. Read only the selected definition and row sheets. Join row UIDs to the live ordered inventory
under the selected server/domain/table and compare the values the workbook can preserve. Reject extra, missing,
duplicate or stale UIDs, mismatched definitions, ambiguous principals and untrusted workbook formulas. Preserve
the independent exact API cell values. Mark supplemental facts with their source and time. A workbook supplied
by an editor attests the missing facts as of the export. Later owner-only or index-only changes can leave the
entire API digest unchanged. Require renewed evidence for materializing a new destination or transferring
management. The app can come in without the file.

A table retained as a source reference has its definition, source-scoped ID, latest revision/digest and the
completeness of its facts. Page available rows from an authorized, revision-bound snapshot. When the row
assignment needed to determine a worker’s choices is unknown, Preview offers the worker-specific fixture from an
authorized restore or asks for the assignment workbook. Until then the dependent worker action explicitly
reports unavailable data. A Project data editor may inspect the authorized source inventory. It must never
become a device fixture for every worker. Use a full authenticated restore for the specified server, domain and worker, or
replay a continuous delta chain onto a verified full base for exactly that identity. Record the base and
continuation tokens, bind the table's fixture tag to the contemporaneous scoped definition, and resolve an
omitted delta fixture from the base. HQ's `ItemListsProvider.__call__` selects modified tables on an
incremental restore. Omission by itself establishes neither an empty fixture nor revocation. The device
fixture identifies its source by tag and worker and carries ordered row elements with values/attributes.
It supplies no remote table or row UUID. Store that exact worker-visible projection, preserving duplicates.
Never infer a row mapping, owner assignment or another worker's visibility by matching equal-looking rows.
Reacquire a full restore on missing continuity, ambiguous binding or a worker change. A source reference with no readable row snapshot offers refresh
and an explicit unavailable state. Expired credentials keep the last verified snapshot labeled as such and stop
any publish that requires freshness.

A previously downloaded fixture or assignment workbook is historical as soon as HQ can change a worker or
row assignment without changing the table API digest. Show its time, scope and provenance only in the
authorized historical inspection. Current worker Preview, a fresh install and target verification must
acquire a fresh authenticated worker restore (or an authoritative current assignment projection for the
complete worker scope) and check access at use. Invalidate cached selections, pages, fixture files and
derived download grants on a known membership or assignment change. If the current projection is unavailable,
stop that worker action and offer refresh/reconnect. Never serve the old rows as current because their
content digest is unchanged.

Use one streaming choice-source validator from `lib/commcare/lookup/selectSourceRows.ts` and
`lib/deployment/reading/projectData/index.ts::readingProjectDataFindingsFor` for both question and Search
itemsets. Distinguish missing fixture (unavailable), a verified complete worker fixture with no source rows
(the required base path cannot resolve), and a valid populated base path whose author filter has no matches
(show zero choices). Check the unfiltered rows the worker *can receive* before applying that filter.
Reject missing or empty value, an XML whitespace character in a value, a missing or whitespace-only label,
or duplicate lexical values visible together. Identical labels are legal. Preserve exact lexical equality.
Count all violations through the last page, retaining bounded example positions. A disk-backed grouping or
SQL index compares keys across pages. Allow duplicate values visible exclusively to disjoint worker
populations only when verified assignments and group/location membership prove that exclusivity across the
delivery scope. Two different owners can grant the same worker a row. Revalidate on membership changes.
For a general publish prove usable sources for each required worker population, or use a sufficient
population-independent proof including source-path availability. When only a single worker’s complete
fixture is known, only that worker’s result can be established. Unknown/unread data, an empty base, or a
bad later page cannot mark a general export ready. Name the failing source and worker scope, offering HQ
row/assignment repair and refresh, or choosing another source. Core’s
`ItemSetUtils.populateDynamicChoices` and `RemoteQuerySessionManager.populateItemSetChoices` own the
positive filtered-empty and negative missing/empty-path witnesses.

Use distinct projections for a worker’s **assigned lookup rows** and **case-sharing groups**.
`fixtures/models.py::LookupTableRowManager.iter_by_user` grants a row through the worker ID, any HQ group
membership, or a location on the primary location’s path. The latter includes ancestors. Union and deduplicate
matching *rows*, then apply HQ’s row order. Additional assigned locations and the case-sharing flag alone do not
grant lookup rows. Bind worker scope to the restore’s principal kind independently of platform. HQ’s
`corehq/ex-submodules/casexml/apps/phone/models.py::OTARestoreCommCareUser.get_fixture_data_items` calls
`iter_by_user`. `OTARestoreWebUser.get_fixture_data_items` returns no assigned rows even for a group or
place that would supply rows to a mobile worker. A mobile worker signed into Web Apps remains a mobile
worker. Positive controls restore a global table for both principals, and a private row only for the
assigned mobile worker. Keep target principals typed and scoped by server/domain, with explicit per-target bindings
to Nova persona, group or place identities. Resolve assignments in authorized server reads before the worker
payload is built. A public or offline archive can embed global fixtures. An assigned-row table in an installable
archive declares the runtime fixture and requires the named space’s authenticated restore. A portable HQ app
package can carry protected table data only for an authorized editor exporting Project data, with the owner
mappings needed at installation. No general archive or another worker’s Preview receives private rows.

### 1C. Data size, wire carriers and deployment

Remove the 5,000-row, 250-column, 64 KiB cell, 256 KiB row and 8 MiB table limits as **total imported-data**
limits. Keep the existing 8 MiB CSV request and ordinary interactive write limits. Replace one-shot per-table
JSONB snapshots with ordered row/occurrence pages, bigint totals and streaming digests. Stage ordered chunks of
large content under a Project-scoped generation and expose exactly one completed generation by atomically
changing its table pointer. Keep large content outside a single JSONB field or route body. Extend
`lib/lookup/fixtureSnapshot.ts`, `lib/commcare/lookup/{fixtures,textWorkbook,workbook}.ts`,
`lib/export/localArchive.ts` and the readers, including the caller in Preview that currently needs a whole
table. Build a complete per-worker snapshot in a paged local store before running a form, or stop that entry if
the device lacks capacity. Never run expressions over the first page. Stream service-side archive members so
10,000 rows, 100,000 cells and 16 MiB become regression boundaries for the old in-memory implementation.
Preserve per-response and per-process budgets in `lib/commcare/hq/bounds.ts`. Use bounded concurrency,
incremental row hashing, byte-bounded buffers, backpressure, cancellation and cleaned-up scratch files. For a
source too large for one interactive read, admit its confirmed live reference first. An editor can then request
a persistent Project data refresh with ordered restart checkpoints, an unpublished staged generation and
terminal counts/digest. Revalidate the source before promoting that generation. This leaves Step 6’s two-request
app reading read-only and never retains an unaccepted app review. A body, device, storage or deadline failure
names the failed operation. It cannot turn a missing page into a completed snapshot.

**Authoring an admitted large table.** Treat the old row, column and byte thresholds as limits on one inline
change or batch only. Remove the post-update `data_bytes > LOOKUP_MAX_TABLE_BYTES` checks in
`lib/lookup/service.ts` and `authoringBatch.ts`, the DB total/row checks, and any limit on the number of
pre-existing rows that a small edit loads. Use a table/row/occurrence ID and expected revision to patch only
the changed values, counting exact stored deltas in the transaction. A one-character reduction of a >8 MiB
table must succeed in Project data and shared tool authoring, as must a small add within the Project budget.
A large-cell replacement can stage bounded ordered chunks, including UTF-8 sequences split at a boundary,
verify final length/digest and lexical type, and swap its value reference once. To edit a small part of a
large cell, accept a revision/digest-bound byte span at valid character boundaries, stream-reuse untouched
chunks and assemble the validated replacement. Neither API needs the whole row in one request. Retry with
the same operation ID returns its prior result. Prove a cancelled, stale or over-budget edit leaves the old
value, references and table/Project revisions intact.

**Physical work and storage.** Add a Project budget row and an idempotent reservation per import, upload,
refresh, export and retained download. Start with a configurable 32 GiB of physically stored payloads and
two simultaneous bulk jobs per Project, within a separate process-wide job/buffer and temporary-disk budget.
These are service capacity choices. A Project needing more capacity can retain a source reference. Count
actual bytes of immutable stored chunks and retained artifacts once per physical Project object, including
partly staged, current, replaced-but-still-pinned and pending-delete objects. Track SQL metadata/row bytes
with database-returned measurements, plus conservative reservation for indexes and temporary work.
Reserve projected growth under the Project lock before accepting each bounded chunk, settle actual measured
bytes there, and never reserve the same chunk twice on retry. Release a reservation on promotion only after
transferring its charge to live/retained storage. Reserve limited compaction/rewrite headroom for shrink
edits, and stream cleanup if a large input exhausts headroom. Never spend an old generation’s apparent
savings while a reader or recovery still pins it. A canceled, expired or failed job releases unused work slots,
and a recovery sweep deletes only verified unreferenced objects after outstanding writes/readers settle.
Refund charged bytes on confirmed deletion. Reconcile orphaned uploads, incomplete commits and lost deletion
acknowledgements against the same object IDs. Test two concurrent jobs competing for the final reservation,
a process exit at each transition, a live reader of the old generation and repeated GC with exact totals.

Plan the **carrier per table and destination** before writes.

| Preconditions | Delivery and verification |
|---|---|
| Complete global or assigned table representable in HQ’s workbook | Build text-only sheets in HQ’s header conventions for properties, repeated fields, indexing, row attributes and owners. Resolve target user names, group names and site codes before writing. Pack whole tables into independent workbooks of at most 500,000 physical rows including the definition and all headers. One definition and one item sheet leave 499,997 data rows for one table. Keep each table whole when using replacement. HQ leaves unmentioned tables alone. Journal per-workbook content digest, affected tables and result. Re-read after uncertain writes before resuming. An unresolved owner can leave a written row with a warning. Treat that result as incomplete. |
| Proven global, unindexed table whose complete contents cannot travel in a workbook | Use the JSON resource lifecycle below for a new vacant tag or an existing table and rows held in its destination ledger. It carries `types`, rows beyond the workbook limit, and exact whitespace or repeated empty values. Both direct publish and the manual package’s authenticated, resumable installer use this contract. The package contains no credentials. |
| The source owns facts a carrier cannot represent or Nova cannot verify | Offer a source-managed reference. The project-space admin prepares the equivalent target table and resolves every target principal, and supplies the target’s selected-table export or a worker’s authorized restore for the facts it demonstrates. The review compares table tag, definition, order and values from the API plus supplied indexes/assignments or that particular worker’s fixture. A worker sample proves only that worker. If table-wide assignments cannot be attested, the destination stays incomplete, with the source app usable. Project data also offers an explicit new target design with authored index/assignment choices, a reviewed change with a named effect. Neither action silently replaces source behavior. |

HQ’s `fixtures/upload/{const,workbook,validation,run_upload}.py` and
`corehq/util/workbook_json/excel.py::IteratorJSONReader` define the first carrier. In a direct execution of the
pinned reader a flat cell `" 007 "` became `"007"`, a numbered blank value with property `hin` produced zero
occurrences, and a nonblank numbered value with a blank property could not be reconstructed. Check **every
row**, including missing/empty state and property position, against the representable subset. A table named
`types` aliases the definition sheet in `_FixtureWorkbook.get_data_sheet`. A second sheet of a different name
cannot fix it. The JSON table API has no index setter and its row API has no assignment writer. The JSON
fallback is consequently conditional. Do not send a private table as global or drop an index to make a
destination succeed. A description remains HQ metadata outside the workbook and the device. Name its loss on a
reviewed transfer that replaces the definition.

**Repeated JSON publishes.** Keep a destination ledger keyed by Project, HQ server/domain and Nova table
UUID. Record the exact remote table ID, stable tag, Nova-row UUID to remote-row ID mappings, canonical
definition, ordered row hashes and acknowledged per-operation before/after states. Share the mapping across
publishing apps in that Project. A second publish with the same definition, contents and order sends zero
writes. Source-managed rows at their own origin are always read-only.

1. Under the Project/table write fence, bind the intended batch to the reviewed local revisions, reader apps,
   target mapping and complete remote baseline. Read and compare the definition and all ordered row IDs and
   values. A moved/recreated table, unexpected row ID, unknown index state before a field-definition write,
   changed owner policy or changed row goes back to resource review. Serialize cooperating Nova publishers
   across all apps using this target table, and recheck authority and the remote precondition per operation.
   HQ exposes separate commits for each REST request. A multi-row rewrite affecting existing workers needs
   a coordinated interval without editing or syncing that shared table, or the separate-table path below.
   A local lock alone cannot establish that interval.
2. Create only at a reviewed vacant tag. HQ’s `fixtures/resources/v0_1.py::LookupTableResource.obj_create`
   makes the definition. `LookupTableItemResource.obj_create` appends to the largest integer sort key.
   Use the v0.6 row resource which returns the minted ID. Record each ID before the next operation.
   An ambiguous create without an acknowledged remote ID needs explicit review and adoption of that precise
   resource, even when a row looks identical. Never retry an ambiguous POST by counting equal values.
3. Reconcile by Nova row UUID and its recorded remote ID. Append new rows, PUT changed retained rows to their
   exact detail IDs with the same `data_type_id`, complete fields, item attributes and intended integer
   `sort_key`, and DELETE only reviewed removed IDs owned by this table. A move uses the same
   full row PUT, including unchanged values. The row resource hydrates `sort_key` and saves when fields or
   attributes were supplied. The list orders by sort key then row ID (`fixtures/models.py::_iter_sorted`).
   Assign distinct target ranks in order, verify every retained ID and the resulting sequence, and never use
   a rank or value hash as row identity. If there is no integer append headroom, compact owned ranks in the
   coordinated interval first. Keep a table when the last app drops its reference, as the deployment
   ownership contract requires. Removing a row from a table the Project still manages is a separate operation.
4. For same-tag compatible schema changes, PUT the held table ID and tag, explicitly including the intended
   definition fields and row attributes. HQ refuses a tag change, and writing fields rebuilds its field
   definitions. Verify fresh evidence for the index/assignment facts that operation could discard, then keep
   the old/new shapes usable through the change. Backfill a newly required row attribute before declaring it.
   Remove an old attribute declaration before removing the stored row keys. Stage new field occurrences
   before exposing a new field and retire an old field after its readers have moved. Confirm the result
   through definitions, row details and the target fixture. A schema whose intermediate states cannot be
   served safely uses the coordinated interval or **Create a separate table**. The editor chooses a vacant
   tag, creates a separate Project table with the desired schema, installs and verifies it, then reviews the
   app mutations that rebind selected readers by UUID. The old table, rows, assignments and other apps
   remain usable. A required stable external tag or assigned/indexed table that cannot take these writes
   uses HQ-managed target setup and observed/supplemented evidence from section 1B. The exact outstanding
   mismatch blocks publishing that app until resolved. Never replace a whole same-tag table as a repair.
5. Journal one admitted request at a time with its exact target ID and intended state. On a partial failure
   retain the last verified operations. After an uncertain PUT or DELETE let the pending request settle,
   re-read its exact ID and enclosing inventory, and compare against both the pre- and post-operation state.
   Advance for the intended result, retry only a known unapplied request at its unchanged precondition, and
   return to review on any other outcome. A rejected/missing permission or pending earlier write cannot
   advance the ledger. Compare the full definition, ordered rows and assignment/index evidence before app
   upload. A downloaded installer signs in to Nova and submits operations to the same Project service as
   direct publish. Its receipt identifies the operation to resume. Before each HQ write the service checks
   current Project and target authority under the shared table fence and consults its durable journal.
   If another publisher completed that operation, use its verified result. If the table changed hands or
   the service cannot establish authority, stop before writing. The package contains no transferable write
   grant. HQ’s `api/tests/lookup_table_resources.py` exercises keyed table/row create and update, row
   field hydration and missing rows. Add native checks for persistent sort changes, same-ID schema update,
   exact-ID deletion and shared-table drift through these real methods.

A plain Nova table adopted by matching a target tag has no HQ origin today. Offer **Use the table from CommCare
HQ** on that table’s Project data page. Enumerate its live mappings, let the editor select the source, show
column/row/distribution changes and every app reading it, then re-read that remote and compare the table
revisions, dependent apps and target mapping under lock. Install the complete copy or source-managed reference
with the chosen origin atomically. Reuse `lib/lookup/managed.ts` and `lib/deployment/managedData.ts` for
hand-back and takeover. A drift stop on publish links here and otherwise retains the existing reviewed discard
action. Discard is available only for a representable authored replacement. It cannot imply preservation of
unreadable metadata. During the historic baseline migration invalidate affected or unclassifiable adopted
baselines so the next publish compares current facts and stops for review. Count every affected mapping and
verify a second scan finds none still treating the old digest as complete.

### 1D. Places and media

Replace the 10,000-place whole-tree boundary in `lib/organization/schema.ts`, persistence,
`lib/deployment/reading/projectData/places.ts` and callers. Use cursor-paged roots/children and indexed
recursive queries for ancestor paths, worker footprints and reverse-owner cardinality. Bind pages to the read
revision. Compare ordered source records by remote ID, use that ID to preserve the Nova place UUID through a
site-code or parent change, and publish parents before children. Store exact external site and level codes and
display names, including case and Unicode where HQ can read them. Distinguish duplicate display labels by their
code/path. Keep the normalized destination lookup index separate. Record both the HQ numeric coordinate value at
decimal(20,10) precision and the exact fixture text required for a string read, including trailing zeroes. Read
metadata as the text `locations/fixtures.py::_get_metadata_node` writes (`str(value)`, absent becomes empty).
Preserve the source observation separately for the API write if conversion loses type. Honor the API fields for
external ID, parent, level, `administrative`, `shares_cases` and `view_descendants`. Unobservable worker and
expansion settings remain explicit setup/defaults. Verify a level or metadata key actually read as an XML name
at its consumer. Model unknown/empty source fields explicitly where HQ admits them.

For external site IDs join the authorized v0.5 `LocationResource` (published as v1) and the v0.6
inventory (v2) by exact server/domain and durable `location_id`. The v1 resource lists `external_id`.
The v2 resource’s field set and `_update` exclude it, though the worker fixture emits it. Compare the
overlapping identity and revision fields and require complete matching inventories on a stable read.
An unknown, mismatched or inaccessible v1 value cannot become empty. Before a target write, preflight
each required value against the mapped destination location’s v1 detail. For a vacant or unequal value
use HQ’s authorized bulk organization workflow. Generate the target’s location workbook with its own
location ID/update identifiers and intended external ID, preserve other target values and show the exact
affected places. `locations/bulk_management.py` parses and saves `external_id` in the location stub’s
`meta_data_attrs` and strips workbook input. Use the workbook only when it can reproduce the intended
string. The administrator applies it in HQ. Re-read v1 by target location ID and compare the exact result
and fixture text before advancing. A destination already holding the right value needs no write. Where
the supported writer cannot produce the required spelling, keep the origin usable and report that
destination mismatch until an explicitly reviewed alternative mapping is available.

Remove `places-over-nova-limit`. Split `place-not-holdable` by cause. Additional valid HQ data now comes in. An
inconsistent read (missing parent, cycle or missing level) rereads once and then reports inconsistent source
data. A stored spelling the destination’s own create API would fold, refuse or conflate is usable at its origin.
Show the required destination mapping or setup and verify the mapping before sending app content. Keep scalar
case ownership valid by construction. A rule needing a reverse location hop requires exactly one reachable owner
candidate on each relevant path. Reclassify `owner-rule-needs-one-place` as a named data/configuration conflict
with the affected level and zero/multiple candidates. The user selects an explicit owner rule or fixes the
places in HQ and refreshes. Never choose the first candidate. Check the same invariant on future topology edits.
New-space publish verifies levels first and uses the existing atomic PATCH batches of up to 100 for places the
API can create. Levels require target setup, and an organization managed in HQ remains managed there. Use
`locations/{models,fixtures,util}.py`, `locations/resources/v0_{5,6}.py` and Nova’s `locationResourcePlan.ts`.

For HQ media lift the present 5/10/50 MiB file and 500-file/200 MiB aggregate admission ceilings. Keep Nova’s
direct uploader’s per-kind limits and its format/playability checks. Stream only referenced source media through
authenticated fixed-host reads, count actual bytes, inspect signatures and compare content digests, then stage
completed objects under the receiving Project. Include source revision and path in the review. Stream archive
members and multipart bodies with bounded memory rather than calling `readFile` on the complete set. Split HQ
media batches on path boundaries and check every matched, skipped and unmatched path against
`hqmedia/tasks.py::process_bulk_upload_zip`. One oversized file is an indivisible member. If the target cannot
accept it, name that file, offer the target’s own media upload, re-read the mapped content and require its
digest before marking complete. An origin publish reuses already matched media. No cross-Project digest match
authorizes a read. No signed URL, workbook or restore credential goes in app history, a chat transcript or proof
artifacts.

**Protected exports.** Introduce the explicit MCP bearer/API-key scope `nova.projects.data.export`, with
consent explaining that the client can download private Project lookup assignments and worker-scoped
installation data for targets the person can access. Require it in addition to current Project editor
authority and the relevant target/worker evidence. The current app-read, app-write, Project membership and
HQ read, import or deploy grants do not include that new export authority, even in combination. Do not
backfill standing consents, refresh grants or API keys. Changing the actor or Project invalidates the
download. Register the new scope with consent, client/API-key selection, discovery and the shared MCP
scope enforcement. Check the required scope before the protected operation can return a manifest, inline
data, signed reference, refusal detail, resource bytes or a range. For a browser session, check the current
editor and the same target/worker authority at preparation and redemption. Existing ordinary packages and
direct publishes continue under their existing grants. Test a new opted-in grant, an old bearer with every
previous scope, a viewer, an expired or revoked grant, and an authorized editor who loses membership before
the next range. Check both response content and absence of a downloadable object on denied preparation.

**Delivering artifacts.** The two HTTP paths `app/api/compile/route.ts` and `app/api/compile/json/route.ts`
and `lib/mcp/tools/compileApp.ts` use the same revision-bound
plan. Preserve the existing small generic JSON and small ordinary target-bound CCZ responses for previously
authorized global data, including the base64 wrapper and the applicable manual-import guide. Above a 1 MiB
binary inline limit, or for an installer or package containing newly protected data at any size, return a bounded
manifest plus a private authenticated download resource. Record Project, app/document and data revisions,
scope, target, actor/grant, expiry, length and digest. Stream the completed artifact from object storage
with backpressure. Browser downloads, MCP resource retrieval and resumed range reads reauthorize current
membership, app permission, export grant and target/worker scope. Use an authenticated gateway with
revocable access rather than a long-lived public object URL. A changed generation or revoked grant
requires a new authorized build and returns no further ranges. Revoke known in-flight grants and expire
retained bytes through the Project budget. The reusable HQ install package carries global data and
instructions for binding private target resources. An editor-authorized package for a named destination
contains only its reviewed mappings/data. Neither packages a named worker’s restore. Serve any authorized
worker fixture only through that worker-scoped current projection.

## 2. Settings Nova owns

The ten `settings-nova-comes-to-own` entries are nonempty build profiles, codes outside Nova’s language
registry, generated-string overrides, required Android packages, case sharing, root grid, the app’s form-menu
grid rule, a menu’s effective grid style, form location capture and the worker-groups fixture. Language
reordering is an additional Step 6 refusal in `lib/deployment/hqChanges/plan.ts`.

### 2A. Case sharing and worker groups

Add a case-sharing switch to app settings and a Project catalog of worker groups with UUID, display name,
whether it shares cases and metadata. A persona can belong to multiple groups independently of its primary and
additional place assignments. A target group selection reads authorized scoped records through HQ’s registered
`api/resources/v0_5.py::GroupResource`, which inherits the name, member IDs, case-sharing flag and metadata from
v0.4. Resolve only the reviewed worker/group bindings. If the key lacks the account-management read, use a
supplied worker-specific restore or ask the target administrator for the binding. Never infer membership from a
group name. Keep group reads separate from configuration of automatic case ownership. An expression can read a
worker’s groups when an app asks for the fixture even with the switch off. Give the expression tree a
worker-groups source with typed access to group ID, name and metadata key/value. Bind incoming declarations by
`jr://fixture/user-groups`, including noncanonical aliases. Quarantine XML and metadata spellings in
`lib/commcare`. Unread declarations remain subject to the existing declaration rules.

Confirm `case_sharing_groups` by the existing deployment privilege path before enabling the switch on a target.
Generate the same conditional entry assertion and owner bind in HQ and local exports. HQ’s
`app_manager/suite_xml/sections/entries.py::configure_entry_module_form` tests the active basic open/subcase
actions. Its advanced branch uses `autoset_owner_id_for_advanced_action`. The corresponding
`app_manager/xform.py::XFormCaseBlock.add_create_block` selects unowned extension, group or individual owner.
Explicit owner updates keep their own action order and exceptions. Assert exactly one group **only** for an
entry for which HQ emits that assertion. With zero or several groups, Preview stops at entry and performs no
submission. For exactly one it persists that group’s ID through the real submission and includes its cases in
the worker restore scope. Keep `(app_id, project_id)` as the tenancy filter for every read/write.

Populate Preview from the same typed group, worker and organization data. HQ’s
`users/fixturegenerators.py::UserGroupsFixtureProvider` emits the group ID, name and metadata.
`users/models.py::CommCareUser.get_case_sharing_groups` includes only case-sharing HQ groups plus case-owning
locations. `CouchUser._get_case_owning_locations` also includes eligible descendants even when the worker was
never directly assigned there. One target setting changes the descendant bound through
`locations/sql_templates/get_case_owning_locations.sql`. Model the two verified delivery rules in the
target/persona projection, using a supplied worker fixture or target-confirmed rule where the API cannot
distinguish them. Use the location group name and metadata projection from
`SQLLocation.case_sharing_group_object`. Preserve the actual fixture ordering/multiplicity for ordered reads and
the exactly-one assertion. Validate both restore variants and a classic non-sharing group that can grant a
lookup row but cannot supply a case owner. Adding/editing personas changes Preview. Publishing never provisions
or changes a real worker or group implicitly.

### 2B. Menus, required Android apps and GPS

| Setting | Authoring, wire, runtime |
|---|---|
| Menu layout | Store root layout, form-menu policy (all lists, all grids or individually chosen) and an optional menu layout. Write `use_grid_menus` and `grid_form_menus` at the app, `display_style` only where the individual choice applies. Keep inactive editor defaults inert. Generate style on the same root and nonroot menu contributions as `app_manager/suite_xml/sections/menus.py::get_module_contributions`, including menus with a parent, forms in the menu above and later group 5 mirrors. Use Core’s `CommCarePlatform.getMenuDisplayStyle` rule for conflicting contributions. Draw both layouts in Preview with working selection and focus. Grid audio plays on Android, while the Web Apps grid omits the audio control. Verify served `cloudcare/.../formplayer/menus/views.js`, Formplayer’s `CommandListResponseBean` and Android’s `MenuActivity`. |
| Android requirements | Store an ordered unique selection from the seven entries in `app_manager/static/app_manager/json/commcare-profile-settings.yml` at this pin. Expose their product names. Map to package IDs only at the CommCare boundary. Write `profile.features.dependencies`, local profile dependencies and corresponding package labels. Retain catalog translations with their existing ownership. HQ’s `Application.create_profile`/profile template and `app_strings.py` apply `APP_DEPENDENCIES`. Confirm the target privilege through existing deployment confirmations before writing, and distinguish losing a privilege from deliberately emptying the setting. Android Preview accepts an installed-package selection and shows the same missing dependency stop as `ApkDependenciesUtils.performDependencyCheckFlow` before opening the app. Web Apps ignores this requirement. |
| Location capture | Own the app-wide switch on ordinary apps and the per-form switch for basic and advanced forms. Each can be edited in its owning settings. Keep Connect’s existing requirement that all forms capture location, with its published change disclosed when a source Connect app has the setting off. Read and preserve a form’s independent setting where HQ’s editor retains it. Effective capture on supported builds is the app switch OR the form switch (`app_manager/models/forms.py::get_auto_gps_capture`, `feature_support.py::enable_auto_gps`, floor 2.14, below Nova’s 2.57 minimum). Generate the metadata location node, geopoint bind and `orx:pollsensor` exactly where HQ’s `xform.py` generates them. Android’s `PollSensorAction` and `PollSensorController` own capture and failure. Keep the ordinary geopoint-question branch separate. Android Preview uses an explicit simulated device location or an unavailable sensor outcome, including the resulting submission metadata. Web Apps ignores automatic collection. Verify the resulting Connect visit evidence separately from a worker’s point answer. |

Show the app and form switches’ effective result beside their controls, use existing platform notices and keep
the `connect-location-capture` feature accurate. Remove the ordinary app’s kept GPS row and write explicit false
when clearing an owned setting. A missing top-level key on update can keep the previous HQ value. Retain
`connect-app-captures-location` for the exact remaining normalization. Keep Android logos, app-level practice
worker, runtime catalog wording and customized language display names in `KEPT_AT_HQ` with their current
archive/Preview explanations. They already pass the kept-setting contract. The new generated-string overrides
below name individual app-owned output. The ambient language-display-name row retains its present scope.

### 2C. Languages and generated wording

Widen the domain language identity with a tagged **project language** carrying an immutable local identity and a
unique external spelling. Keep existing registered language tags and their translation keys readable without
conversion. Use a distinct namespace for the new map/URL key, independent of a display label. For HQ codes
within `languageWireCodeSchema` that do not name a living individual language, or that would give two codes the
same registered identity, retain each wire code exactly once. Reuse a previously bound identity before
consulting order. On first read without bindings map a uniquely recognized registry identity once, preferring
its existing canonical wire spelling in collisions, with a deterministic code-spelling tie-breaker. Remaining
codes become distinct project languages, so a reorder cannot change identities. Duplicate exact codes and codes
HQ’s Languages editor will not save retain their existing refusal. In Nova’s language picker a project language
is identified by its verbatim code. Show a derived display name only where one is known. Allow manual
translation and a local direction choice where its registry cannot supply one. Keep an HQ language-selector
wording override in the existing target overlay. Automated translation needs a reviewed language
identity/descriptor before sending content to a model. No invented registry match.

Add an anchored move-language mutation and matching Builder, SA and MCP actions. Moving a language first makes
it the runtime default. Making a different language first must preserve canonical source strings, stored
translations, status, fingerprints, wire codes and profile references. A birth chooses
`lib/commcare/reader/languages.ts::readingSourceCode` using its current evidence (the app name and system text).
The first language is the default and only the fallback source. On re-read, preserve an equally admissible
incumbent source through the resolver/canonical rule. If the actual source changes, rebase from per-language
effective texts atomically and prove the resulting emission, including an old-source-only string. Extend
`diffDocsToMutations.ts` and remove the `languages-reordered` hold only when reorder plus edit, add, drop and
default changes reproduce the endpoint. Reject removal of a profile’s last language until the same mutation
batch repairs the profile.

For an effective override of a generated string, store language identity, the generating slot’s stable owner
identity and a closed output role (for a split output, the particular generated string). Register those roles
beside the generator and use them for both reverse lookup and forward projection. Extend
`lib/commcare/reader/generatedTranslationKeys.ts`, `appStringKeys.ts`, `appStrings.ts`, the translation
inventory and Preview. Emit the override last under the key that the *current* owner positions generate.
Deleting an owner deletes its overrides, moving it recomputes the outgoing key, and editing an unrelated sibling
text never retargets the override. No override folds into the text its output is based on: every key a
generated wording unit writes is that unit's own wording, an equal one included, and the app name's two
strings have units of their own. A missing or blank entry, or one naming no string, stays inert and the first
publish removes it (`unused-translation-keys-removed`). Distinguish override
of a constant, one-of-many outputs, catalog text, non-existent generated key, prefix lookalike and the
dependency-name/catalog overlap. Offer generated wording under its owning control and Languages, with “Use
default wording” removing the override. Verify secondary locale fallback and the locale-file grammar.

### 2D. Installation profiles and target ownership

Hold named profiles by UUID with a nonempty ordered subset of app-language identities and an optional
practice-worker *role/binding*. Preserve the source profile’s key in the deployment identity map. A profile on
another space must bind its own practice worker. Newly added app languages stay outside a profile until the
author includes them. The default installation remains the app’s language order. Offer a profile picker for
Preview, downloads and the build guidance, and apply the selected subset to the default locale, app strings,
XForm/itext and profile resources. `app_manager/models/applications.py::get_build_langs/get_practice_user_id`,
`app_manager/app_strings.py::_create_custom_app_strings` and `suite_xml/sections/resources.py` consume the
selected profile. A local device build that requires a practice restore directs the user to the named profile’s
build at HQ, which owns that worker’s restore. A normal all-language device archive stays available. No generic
archive contains a private worker restore.

Use the app source’s full profile definition including name, key, sequence and practice worker, extending
`lib/commcare/hq/appSource.ts::readBuildProfiles` which presently projects only the needed subset. Distinguish
an empty profile collection from an individual profile with no languages, which HQ cannot build when it selects
`langs[0]`. The create import carries the target-bound desired profiles, including on Nova’s resource-first app
shell. Preserve desired profile IDs for later install/update and verify them from the new app. In-place import
excludes `build_profiles` in `ApplicationBase._update_excluded_fields`. HQ’s own
`app_manager/views/releases.py::LanguageProfilesView` replaces the profile map in an authorized browser edit and
checks the plan and practice user. A file sent as an update cannot do that edit.

A nonempty profile-specific practice-worker binding has two independent prerequisites. The target must
support profiles, and `Application.enable_practice_users` requires both `supports_practice_users` (CommCare
2.26 in `app_manager/feature_support.py`, below Nova’s 2.57 floor) and the target’s
`PRACTICE_MOBILE_WORKERS` privilege. Confirm the privilege before creating or editing profiles that bind a
worker. Resolve the named target ID to an active, undeleted practice worker in the same domain as
`app_manager/util.py::get_and_assert_practice_user_in_domain` requires. A profile with no practice binding
does not need that extra privilege. On create the raw JSON may carry a worker string even when the target
build would omit its restore. On browser edit `LanguageProfilesView.post` saves an empty practice-worker
string when the effective gate is off. `Application.create_practice_user_restore` also returns no restore
when it is off. In both paths stop before claiming the desired binding, explain which target condition
must change, and permit an explicitly reviewed removal of that binding. Do not drop it during a name or
language edit. Verify the actual selected profile and its restore on HQ’s build, without retaining its data.
Add the nonempty-profile entry to the existing `privilege/practice_mobile_workers`,
`build-version/supports_practice_users` and frozen `toggle/MOBILE_USER_DEMO_MODE` evidence where applicable.

On a mismatch give the person the exact desired names, language orders and practice-worker bindings, plus the
target app’s Language Profiles page. Record the reviewed target state. On retry read the full profiles,
correlate new target-generated keys only via a unique reviewed binding, and advance when the complete observed
profile set agrees. For adding a language not yet present at HQ, send a content update containing that language
only after checking existing profiles remain valid and recording this incomplete operation. For removing a
language still named at HQ, first have the person remove it from the target profiles, then verify and send
content. For a replacement with both dependencies, publish an intermediate **safe language superset** with all
required text and stable IDs, then complete the target profile edit and publish the final app. Persist and check
the intermediate source digest with ordinary drift safeguards and show the exact phase on retry. Mark the
deployment uploaded only after final read-back. Enforce `build_profiles` privilege and the existing preflight on
every transition. This protocol replaces the obsolete claim that an ordinary overwrite publishes a profile edit.
The formerly empty-profile kept row joins the owned collection. Do not compare profiles using HQ’s
`BuildProfile.__eq__`, which skips the name.

## Authorization, adoption and cutover inputs

- Use the existing browser Project/app edit authority and `lib/mcp/scopes.ts` HQ Import/HQ Write grants. An
  operation changing management needs both HQ grants and Project edit. A read never authorizes a target
  mutation, creating an account or changing membership. Recheck scope inside the authoritative write
  transaction. Bind every confirmation and supplementary input to the actor, Project, source/target tuple,
  source digest and the reviewed revisions. Permission loss or different target before commit returns a fresh
  review.
- Reuse current immutable fold baselines and external identity agreements. Extend `hqCanonical`/deployment
  baseline projection with observed-vs-unobserved facts and stable IDs. Bind a page cursor to the authorized
  revision. Join remote reads outside database locks, validate versions and source digests on accept, and commit
  the new app/copy/edges atomically. Discard temporary objects and private staged files on cancellation, failure
  and expiry. Extend SQL integrity for shared lookup definitions, edges, bigint accounting and renamed place
  identities. Existing scalar cells keep their exact fixture emission, including the old projection of a missing
  value. Compare every migrated table with the old emitter before removing the old representation.
- Scan each active deployment of an existing app for settings that become Nova-owned, including profile
  subsets/IDs and the ordinary app’s GPS value. Record per-target facts and digests before writes. With no
  active deployment use current Nova/HQ defaults. Where all verified targets agree, adopt that setting. Where
  they disagree, use HQ’s default and name each affected target’s old and intended value on review, including an
  explicit empty profile collection and any dependent practice binding. An unreachable target is unknown.
  Complete the scan with working credentials or keep that target fenced from writes until it has an observed
  baseline. A fresh read verifies the reviewed target again before first publish. Never default an unreadable
  target silently. Existing languages/wire spellings and identities survive. Old personas have no additional
  group memberships, old app test expectations use their recorded runtime version. Include these transforms and
  their rehearsal in the roadmap’s single applicable cutover.

## Inventory ownership

Each full entry ID is the manifest area followed by a slash and the exact slug below. The three place
circumstances and language ordering have no inventory slug.

| Implementation | Manifest area | Owned slugs |
|---|---|---|
| 1A | `case-search` | `itemset-refs-to-item-attributes-attr-or-property-qualified` |
| 1A | `questions` | `itemset-refs-to-attr-or-property-qualified-fields` |
| 1A–1B | `expressions-and-data` | `tag-or-field-name-holding-a-period`, `tag-equal-to-an-instance-name-commcare-owns`, `tag-or-field-name-with-non-ascii-letters`, `fields-properties-and-multi-valued-cells-name-lang-en-name-name`, `item-attributes-and-per-row-attribute-values`, `absent-field-vs-zero-values-vs-empty-string` |
| 1B–1C | `expressions-and-data` | `tag-types`, `is-global-false-row-owners-user-group-location`, `fields-is-indexed`, `table-or-row-count-beyond-nova-s-caps-5-000-rows-250-columns-64` |
| 1D | `expressions-and-data` | `an-imported-asset-larger-than-nova-s-per-kind-cap-or-an-app` |
| 2A | `application-and-settings` | `39-hq-case-sharing` |
| 2A | `expressions-and-data` | `groups-jr-fixture-user-groups` |
| 2B | `application-and-settings` | `31-features-dependencies`, `46-hq-use-grid-menus`, `47-hq-grid-form-menus-none-all-some` |
| 2B | `forms-and-case-writes` | `auto-gps-capture-form` |
| 2B | `menus-and-case-lists` | `module-display-style-list-grid-read-when-grid-form-menus-some-on` |
| 2C | `application-and-settings` | `langs-code-nova-s-language-registry-cannot-name`, `translations-generated-key-anything-else` |
| 2D | `application-and-settings` | `build-profiles-non-empty` |

## Exit evidence

1. Expand `proof/hq-apps/hq-{lookups,media,places,languages,kept-settings}` and add HQ-authored settings forms.
   Record exact entry IDs, updates to standing/claim and independent Python value classifier for each of the 13
   + 10 inventory rows. Relocate every owned variant to an admitted base with proofs 1–6 or split its exact
   source-only/portability class with an explicit observed outcome. Withhold HELD for any operation claimed to
   preserve a fact no reader established. Record observed resource IDs/digests, worker-scoped visible rows,
   indexes, cells, menu style/audio, selected languages, emitted strings and actual case owner. Include an HQ
   editor edit of each new slot or resource, reviewed bring-in of that change, next publish and fresh read-back.
   A resource edit belongs to its own manager and revisions, not a fabricated blueprint mutation.
2. Show own-space publish makes zero writes to HQ-managed resources. Exercise a portable table in a vacant
   second space, JSON-created `types`, a prepared rich target with independently compared data, an unavailable
   source-only target, a partial workbook upload, an unknown row-create acknowledgement, and the absence of a
   source-table write after a concurrent hand-back. Publish the same JSON-managed table twice, then append,
   change, reorder and remove rows and change its schema. Assert preserved row IDs, exact order, retained
   unrelated table, and no writes on unchanged retry. Interrupt each verb, introduce a target edit or a
   same-tag replacement between reads, and prove the affected request stops or resumes exactly once. Interrupt
   a manual installation after an acknowledged row, resume by direct publish, then retry the downloaded
   package. Verify a single journal, stable row IDs and zero duplicate writes. After hand-back, retry the
   old package and observe zero HQ writes. Test
   a separate-table migration with a second live app still reading the original. Test two worker fixtures
   with disjoint assignments, duplicate-looking source rows assigned to different workers, and an incremental
   restore that omits the unchanged table with and without the correct base, through
   endpoints, cache, exports and search. Use actual HQ fixture provider, upload validator/reader and native
   Core. Test sizes on both sides of every old cap, the exact 500,000/500,001 physical-row boundary and a table
   with one row too many for one workbook. Check peak memory stays bounded as total members/rows rise. Keep very
   large generated rows and media temporary. Test 10,001 places with a small worker footprint,
   renamed/reparented source place, mixed case codes, unsupported target parentage, and zero/one/two possible
   owners. Include two targets with different external IDs, a v2-only read, a v1/v2 race, an already
   matching location and a bulk-workbook repair verified by v1 and a rebuilt restore. For both question
   and Search choices exercise a missing fixture, empty worker base, filtered-empty populated base, blank
   label/value, XML whitespace and a duplicate found on the last page, including disjoint and overlapping
   owner grants. Exercise a table with a single zero-list row and a mixed table with an absent field.
   Require identical visible element counts/order to Core, prove full ID coverage independently or report
   the source-only stop, and introduce a row change during supplementary verification. Revoke an assignment
   without moving the table API digest and demonstrate that neither Preview nor download serves the old worker’s rows. Drive small and oversized real HTTP and MCP exports,
   two named targets, interrupted range retrieval, expired artifact and revoked Project membership.
3. Exercise zero/one/multiple case-sharing groups with explicit owner, unowned extension and auto-owner paths.
   Compare served HQ/Web Apps and Android grid behavior, missing/installed Android dependencies, app/form GPS
   combinations and both platform outcomes, plus profiles with different first languages. Observe a profile-only
   rename, a missing target practice worker, inaccessible target, changed source mid-review, and a language
   replacement across an interrupted profile edit. Demonstrate new-source, local archive and live HQ decisions
   separately. Cross profile create and editor update with practice support on/off, its privilege on/off
   and a profile with/without a worker. Observe the effective build restore and HQ’s saved worker field.
   Include a stale, ordinary or foreign worker and a revoked privilege on a profile rename.
4. Update platform rows and Preview cells, `KEPT_AT_HQ`, inventory, public guides, nearest contracts, tool
   catalogue, plugin guidance and versioned model/runtime context with their respective changes. Regenerate gate
   relationships for `lookup_tables`, `locations`, `case_sharing_groups`, `app_dependencies`, `build_profiles`,
   `practice_mobile_workers`, `supports_practice_users` and `enable_auto_gps`. Search’s existing project-space and sync gates still apply to a lookup-backed search
   prompt. The proof lane checks the exact review/first-publish changes, including the retained Connect GPS,
   generated-text fold and flat-location-setting entries. Independently deny a missing privilege or a worker’s
   missing assignment to demonstrate sensitivity. General app-body or malformed-source stops remain specific.
   Large paginable lookup data must no longer hit the ownerless `lookup-data-too-large` just because an
   aggregate list was materialized.
