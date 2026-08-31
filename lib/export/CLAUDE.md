# Export boundary

`lib/export/boundaryValidation.ts` is the one server-only preparation seam for
every artifact and direct-HQ export. It speaks Nova intent through the explicit
`ccz`, `hq-json`, and `hq-upload` modes; wire generation stays in
`lib/commcare`.

Callers must authorize and hydrate the app first, then pass the resulting exact
Project access, document, and mutation sequence to `prepareExportBoundary`.
Nothing may expand, compile, import, or upload before the result is `ok: true`.

Project-space compatibility metadata is not another artifact-validity verdict.
After the boundary passes, JSON/CCZ callers derive a targetless `not_checked`
report from the same exact document and attach it without changing artifact
bytes. Direct HQ publishing checks the concrete target before any remote write;
missing or unverified required support is a deployment refusal, while the
large-Search performance advisory only controls a derived optimization. Private
probe mechanics live in `lib/commcare/projectSpaceCompatibility.ts` and the
public semantic report lives in `lib/publish/projectSpaceCompatibility.ts`, not
in this boundary.

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
whole-workbook row ceiling (`LOOKUP_HQ_PUSH_TOO_LARGE`) plus
`LOOKUP_TAG_TOO_LONG_FOR_HQ`, which refuses a tag no data sheet could be named
for BEFORE the workbook is built, so the builder stays a total function.
Select-source option validity over complete tables (`LOOKUP_SELECT_SOURCE_*`)
is common to all three: a choice list whose saved values are blank or
duplicated is equally broken however the table reached the device. All are
`environment`-class: rows change outside the document, so they never gate a
commit. Export therefore needs its own selected-target verdict over those
current external rows in addition to the absolute document commit gate.
