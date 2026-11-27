# Export boundary

`lib/export/boundaryValidation.ts` is the one server-only preparation seam for
every artifact and direct-HQ export. It speaks Nova intent through the explicit
`ccz`, `hq-json`, and `hq-upload` modes; wire generation stays in
`lib/commcare`. Its row and mode findings (the lookup carrier's, the
fixed-place owner's and the two nested selections') are computed by the pure
`boundaryFindings.ts::exportCarrierFindings`, which the seam calls and which
acceptance of an app brought in from CommCare HQ calls for the first publish it
will make.

Callers must authorize and hydrate the app first, then pass the resulting exact
Project access, document, and mutation sequence to `prepareExportBoundary`.
Nothing may expand, compile, import, or upload before the result is `ok: true`.

Project-space compatibility metadata is not another artifact-validity verdict.
After the boundary passes, JSON/CCZ callers derive a `not_checked` report from
the same exact document and attach it without changing artifact bytes: a
download checks no project space, also where a `.ccz` is made for one. Direct HQ publishing checks the concrete target before any remote write;
missing or unverified required support is a deployment refusal, while the
large-Search performance advisory only controls a derived optimization. Private
probe mechanics live in `lib/commcare/projectSpaceCompatibility.ts` and the
public semantic report lives in `lib/publish/projectSpaceCompatibility.ts`, not
in this boundary.

Every local `.ccz` (the compile route, MCP `compile_app`, the proof harness's
capture of a download) is assembled by
`lib/export/localArchive.ts::compileLocalArchive` from a `ccz`-mode prepared
export and the one published project space the archive is made for
(`compileLocalArchive(prepared, runtimeTarget, identity, deployment)`, the
target, that deployment's ids and the word each case list column's field keeps
there, which the archive's app string ids for the column follow, the reached
target's `emptyCaseListText`,
`earlierHqApps` and `adopted` (its live app mapping is one Nova brought in, so
the archive seeds no profile setting there, read or not), and the deployment's `targetFacts`, what its project space
keeps of the values Nova leaves to CommCare HQ or null where no baseline was
read, and its `keyedCaseIdPrefixes`, the id prefix each keyed create's cases
stand under in an app Nova brought in from there, empty everywhere else, all
required), so no archive is compiled without one; the two compile surfaces
also hand the export boundary that deployment's held media paths
(`DownloadTarget.mediaPaths`), so each file sits where CommCare HQ keeps it; change what an
archive holds there. What a `.ccz` cannot follow of those kept values it says in
its advisories (`lib/publish/exportAdvisories.ts`, the `kept_` ids, from
`lib/deployment/downloadTarget.ts::downloadKeptAdvisoryFacts`), wording and
settings a file cannot carry as they are stored among them. A project space
whose app holds a custom base URL elsewhere gets no `.ccz` at all: the
resolver refuses it (`workers-sent-elsewhere`), because a `.ccz` names only
the server the app is published on, and the publish dialog lists that space
as one that cannot be chosen, from the same standing
(`lib/deployment/downloadTarget.ts::readCczStanding`).

A menu that sends its questions to a project-supplied search gives both
downloads a destination. The contributor chooses the server, project space
and the service there. Nova checks the capability with the acting user's
connection and rereads the revision and bindings before generating bytes.
The manual HQ file installs a new copy with its ordinary derived identities
and media paths. Only the external search ID comes from that destination.
An Android package still uses the physical identities of the published app.

A download records nothing: the HQ import file and the `.ccz` emit each case
change's effective placement, held or else the simplest, and write no
`publish-placement` change. Only `publishAppToHq` records placements
(`lib/deployment/CLAUDE.md` § Placements).

The boundary structurally extracts the complete lookup target set and reads
one snapshot even when that set is empty, on every mode:
`getLookupFixtureData` — definitions plus every referenced table's complete
ordered rows in one REPEATABLE READ transaction. Read failures are operational
errors: let them throw and emit nothing. Missing and foreign identities are
both omitted by the Project-scoped reader and therefore produce the same
validator finding.

On success, emitters consume the returned `lookupSnapshot` / `lookupContext`,
the mode's lookup carrier, and media `assets`. Never perform a second lookup
read: the returned definitions, fixture blocks, and workbook bytes are the
exact generation that passed validation, which is also what makes the pushed
generation provably the validated one. The synthetic registry entry point
exists only for seeded boundary-race tests
(`__tests__/boundaryValidation.test.ts`); production callers use the immutable
shared registry.

Every mode carries lookup data, so every mode reads rows; what is mode-split is
the CARRIER and therefore the size verdict. `ccz` builds the embedded fixture
blocks up front for the tables its snapshot holds inline (`lookupWire` carries
the naming and the exact serialized elements the budget measured) and walks
every other complete global table a page at a time into `suite.xml`
(`streamedTables`, Nova's own and a complete copy of a table CommCare HQ
manages alike: `lib/lookup/fixtureSnapshot.ts`'s `download-archive`). The
aggregate 10,000-row / 100,000-cell / 16 MiB budget
(`LOOKUP_FIXTURE_EXPORT_TOO_LARGE`) covers inline and paged fixtures together.
Preparation measures the paged XML and stops as soon as it crosses the wire
budget. The HQ modes stream only Nova's own tables: a
copy of a table CommCare HQ manages is written by its own rule below. `hq-json` and
`hq-upload` build the fixapi workbook (`lookupWorkbook`) and take CommCare HQ's
whole-workbook row ceiling (`LOOKUP_HQ_PUSH_TOO_LARGE`), their one size
verdict. A 32-character tag pushes, so the workbook builder is total over every
tag the schema admits.

A table CommCare HQ manages (its definition's `hq.managedBy` is
`"commcare-hq"`) is a copy Nova never writes in the project space that manages
it. `hq-upload` takes the project space it writes to as `lookupTarget` and
leaves out of its workbook every table managed in exactly that server and
domain; CommCare HQ's upload leaves a table it is not sent alone, and a managed
table of another project space goes in and is made there from Nova's copy.
`hq-json` names tables whose source-managed index settings or audience Nova
cannot reproduce. Its guide identifies the original server and project space and
how to prepare the same table or choose different data for another destination.
Portable managed tables go in one workbook per source project space
(`lookup-tables-managed-in-<domain>.xlsx`). The guide lists each table in its
actual file. A device can install verified global rows even when source index
settings are unavailable. Assigned rows need that worker's authorized restore.
`managedLookupTables` lists every table the mode left out
of `lookupWorkbook`, in the definitions' order, and `lookupWorkbook` is absent
where no table goes. The HQ cell-text check, the reserved tag and the workbook
row ceiling judge only the tables a workbook carries, each workbook over its
own, since a table no workbook carries is never trimmed or refused there; the
XML text check judges every table the app reads in every mode. Both cell-text
findings end with the managed remedy for a table CommCare HQ manages (change
it there, then refresh Nova's copy), never with Project data, which refuses
every edit to it, and carry that project space as `managedInDomain`.
Select-source option validity over complete tables (`LOOKUP_SELECT_SOURCE_*`)
is common to all three: a choice list whose saved values are blank or
duplicated is equally broken however the table reached the device, and one
over a table with no rows (`LOOKUP_SELECT_SOURCE_EMPTY`) never opens there,
since Core refuses an itemset whose path reaches no row
(`ItemSetUtils.populateDynamicChoices`; a Search prompt's
`RemoteQuerySessionManager.populateItemSetChoices`). A row filter that leaves
no choice over rows that exist still opens. Over a table CommCare HQ manages
these too end with the managed remedy (add or change its rows there, then
refresh Nova's copy, or choose another table or column) and carry
`managedInDomain`: a publish's re-read refreshes the copy whatever its rows
are, so a table emptied or a cell blanked in CommCare HQ reaches this check.
All are
`environment`-class: rows change outside the document, so they never gate a
commit. Export therefore needs its own selected-target verdict over those
current external rows in addition to the absolute document commit gate.

All referenced lookup cells must be representable as XML 1.0 text, because both
carriers ultimately supply XML fixtures to CommCare. Preparation scans the exact
snapshot before serialization; `LOOKUP_CELL_TEXT_UNREPRESENTABLE` aggregates by
column with bounded row examples. A refusal builds neither carrier and does not
change stored rows. Legal XML whitespace and Unicode remain unchanged.

After whole-document validation, the two HQ modes also run
`lib/commcare/hqNestedSelection.ts` over the actual entry projection. Native HQ
cannot preserve a related-case selection from several parent cases, or a root
selection reused by a same-case child whose maximum is smaller. Both receive
`HQ_NESTED_SELECTION_UNREPRESENTABLE` before media bytes resolve. The check
follows actual selection datums, including case list menu item entries,
advanced loads, and catalog ancestor chains; registration or survey forms without those selections are
unaffected. These are target limitations, never document admission rules. Local
CCZ emits the set-membership parent filter and distinct child selection and is
covered by native Core runtime proof. A `.ccz` is made for a reached deployment
alone (`lib/deployment/downloadTarget.ts::resolveDownloadTarget`), so an app
that holds one of the two selections has that archive only for a project space
it reached without the selection. Published nowhere it has no export of any
kind: `resolveDownloadTarget` refuses its `.ccz` with `selection-held-from-hq`,
carrying the findings' lines, and it runs in Preview until an edit clears the
finding. An app that does not declare Android has no `.ccz` at all:
`chooseDownloadTarget` refuses it with `not-declared-for-android` before any
project space.


## Private files and large exports

The HTTP compile routes and MCP `compile_app` use the same streaming archive and
`lib/export/artifacts` gateway. Ordinary files up to 1 MiB may travel inline.
Larger files and named private assignment files have an immutable SHA-256
manifest with one-hour retention. The gateway reserves Project storage before
each create-only object write, records its generation and returns only
authenticated ranges. Preparation can resume an interrupted write from the
same actor, grant, input revisions and deployed revision. Browser downloads
support a single HTTP byte range. MCP resources carry bounded 192 KiB chunks.
A role change, expired session or key, changed app or Project data, target
mapping or protected destination witness ends access to the old file. Credentials
and signed object URLs never travel in a manifest. The reclaim operation
deletes the specific stored generation before returning its physical charge.

Worker assignment exports need an editor, the selected HQ destination and
verified principals there. A bearer also needs `nova.projects.data.export`.
Generic import files omit worker rows and explain the destination setup.
Media streams from ready assets scoped to the Project. Its stored length and
SHA-256 must match before delivery. Native ZIPs and their multipart upload
stream one member at a time. Complete local global tables exceeding the inline
workspace are walked in stable order under their pinned app and Project
revisions. Streaming XLSX files pack only whole tables within HQ’s physical
row limit and retain each table’s data and header sheets together.


A device install with private fixtures requires the current deployment’s app
and table mappings. The destination must return the expected ID, tag,
distribution, fields, occurrence properties and row attributes. A managed
table may supply its ID at its own origin. The install references the native
fixture, and each worker receives authorized rows from HQ’s own restore.
The gateway repeats this check on each range. API-key authority changes rotate
a durable epoch, including removal and restoration of the same scope.

The direct workbook read-back compares the complete intended definition and
ordered row digest before the app's content is sent. Both the small workbook
and streamed workbook derive that digest from the same occurrence and
attribute projection. An ambiguous or incomplete read retains a recovery
point for the destination.

The streaming archive writer uses the exact reviewed yazl version. Its postinstall correction keeps the ZIP64 central-directory offset independent of a small member’s data-descriptor width. The Android installer’s Java stream reader chooses that width from the member’s actual compressed and uncompressed lengths. Normal installation, production image assembly and the Linux proof dependency volume each apply the same exact-input correction. Archive tests retain sequential and directory reads beyond the 4 GiB offset.
