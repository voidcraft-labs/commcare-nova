# Export boundary

`lib/export/boundaryValidation.ts` is the one server-only preparation seam for
every artifact and direct-HQ export. It speaks Nova intent through the explicit
`ccz`, `hq-json`, and `hq-upload` modes; wire generation stays in
`lib/commcare`.

Callers must authorize and hydrate the app first, then pass the resulting exact
Project access, document, and mutation sequence to `prepareExportBoundary`.
Nothing may expand, compile, import, or upload before the result is `ok: true`.

The boundary structurally extracts the complete lookup target set and reads
one snapshot even when that set is empty: the rows-free definition reader on
the HQ modes, and `getLookupFixtureData` — definitions plus every referenced
table's complete ordered rows in one REPEATABLE READ transaction — on `ccz`.
Read failures are operational errors: let them throw and emit nothing. Missing
and foreign identities are both omitted by the Project-scoped reader and
therefore produce the same validator finding.

On success, emitters consume the returned `lookupSnapshot` / `lookupContext`,
the ccz-only `lookupWire`, and media `assets`. Never perform a second lookup
read: the returned definitions and fixture blocks are the exact generation
that passed validation. The synthetic registry entry point exists only for
seeded S02 tests; production callers use the immutable shared registry.

The lookup verdict is mode-split. `hq-json` and `hq-upload` reject every
authored carrier with the mode-bearing `LOOKUP_CARRIER_EXPORT_NOT_ACTIVE`
finding until S20 pushes and maps the resources. `ccz` instead builds the
fixture blocks up front (`lookupWire` carries the naming and the exact
serialized elements the budget measured) and adds the row-dependent findings a
definitions snapshot cannot prove: select-source option validity over complete
tables (`LOOKUP_SELECT_SOURCE_*`) and the aggregate 10,000-row / 100,000-cell
/ 16 MiB embedded-fixture budget (`LOOKUP_FIXTURE_EXPORT_TOO_LARGE`). All are
`environment`-class: rows change outside the document, so they never gate a
commit. Do not rely on the delta-based commit finding here: an export is
zero-tolerance and needs its own selected-target verdict.
