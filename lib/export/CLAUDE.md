# Export boundary

`lib/export/boundaryValidation.ts` is the one server-only preparation seam for
every artifact and direct-HQ export. It speaks Nova intent through the explicit
`ccz`, `hq-json`, and `hq-upload` modes; wire generation stays in
`lib/commcare`.

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
target, that deployment's ids and the reached target's `emptyCaseListText` and
`earlierHqApps` required), so no archive is compiled without one; change what
an archive holds there.

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
blocks up front (`lookupWire` carries the naming and the exact serialized
elements the budget measured) and takes the aggregate 10,000-row /
100,000-cell / 16 MiB budget (`LOOKUP_FIXTURE_EXPORT_TOO_LARGE`). `hq-json` and
`hq-upload` build the fixapi workbook (`lookupWorkbook`) and take CommCare HQ's
whole-workbook row ceiling (`LOOKUP_HQ_PUSH_TOO_LARGE`), their one size
verdict. A 32-character tag pushes, so the workbook builder is total over every
tag the schema admits.
Select-source option validity over complete tables (`LOOKUP_SELECT_SOURCE_*`)
is common to all three: a choice list whose saved values are blank or
duplicated is equally broken however the table reached the device, and one
over a table with no rows (`LOOKUP_SELECT_SOURCE_EMPTY`) never opens there,
since Core refuses an itemset whose path reaches no row
(`ItemSetUtils.populateDynamicChoices`; a Search prompt's
`RemoteQuerySessionManager.populateItemSetChoices`). A row filter that leaves
no choice over rows that exist still opens. All are
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
follows actual selection datums, including case-list-only entries and catalog
ancestor chains; registration or survey forms without those selections are
unaffected. These are target limitations, never document admission rules. Local
CCZ emits the set-membership parent filter and distinct child selection and is
covered by native Core runtime proof. A `.ccz` is made for a reached deployment
alone (`lib/deployment/downloadTarget.ts::resolveDownloadTarget`), so an app
that holds one of the two selections has that archive only for a project space
it reached without the selection. Published nowhere it has no export of any
kind: `resolveDownloadTarget` refuses its `.ccz` with `selection-held-from-hq`,
carrying the findings' lines, and it runs in Preview until an edit clears the
finding.
