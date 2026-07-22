# Export boundary

`lib/export/boundaryValidation.ts` is the one server-only preparation seam for
every artifact and direct-HQ export. It speaks Nova intent through the explicit
`ccz`, `hq-json`, and `hq-upload` modes; wire generation stays in
`lib/commcare`.

Callers must authorize and hydrate the app first, then pass the resulting exact
Project access, document, and mutation sequence to `prepareExportBoundary`.
Nothing may expand, compile, import, or upload before the result is `ok: true`.

The boundary structurally extracts the complete lookup target set, calls the
rows-free lookup definition reader even when that set is empty, and validates
with the resulting available context. Definition-read failures are operational
errors: let them throw and emit nothing. Missing and foreign identities are
both omitted by the Project-scoped reader and therefore produce the same
validator finding.

On success, emitters consume the returned `lookupSnapshot` / `lookupContext`
and media `assets`. Never perform a second definition read: the returned
definitions are the exact generation that passed validation. The synthetic
registry entry point exists only for seeded S02 tests; production callers use
the immutable shared registry.
