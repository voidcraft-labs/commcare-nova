# Agent authoring

The experiment accepts the content an author wants to write. The canonical
document still stores typed expressions, protected prose, and stable identities.
Do not expose those storage structures merely because the reducer accepts them.

`experimental` is reachable only from the local comparison script. Its native
tools cover one client workflow. The JavaScript adapter preserves the comparison
for inspection; it is not a second production authoring path. The selected
direction and limitations live in
`docs/research/agent-authoring-pilot-2026-09-12.md`.

Resolve all names for one operation against its complete scope before preparing
mutations. Creation allocates identities before binding expressions. A rename
resolves both the original and proposed paths during that operation; ambiguous
paths reject. Neither path becomes a stored alias. `#case/property` requires a
known selected case type and stores the actual type. Unbound bare names reject
rather than becoming opaque text that renames cannot maintain.

Wording is Markdown. Answer interpolation is parsed at this boundary and printed
back to the same authoring representation. Literal braces and backslashes must
round-trip. Conditions use Nova's existing XPath grammar. The pilot's strict
parser does not yet cover all advanced instance and attribute paths; do not
promote that subset as a complete replacement.

Preparation and canonical admission run inside `CanonicalMutationWorkspace`.
Authorization, reference validation, valid atomic writes, and concurrency remain
there. Do not catch a commit conflict as a preparation error or rebind an already
prepared operation after a peer edit. The pilot's call deduplication lasts only
for its process; production must use the durable call ledger.

Read results use the same authored content shapes accepted by edits. Preserve
existing child identities when replacing content. A read/edit cycle must not
silently drop media, validation messages, navigation, or option identities.
The pilot refuses option replacement with media until it can preserve it.

The local evaluator captures credential-free request bodies in a private folder,
limits model steps and requests, records conservative spend, and soft-deletes its
owned disposable app in `finally`. Scenario rows belong only to those apps.
Scenario observations use the production Preview and real case database snapshot;
they project submissions without submitting them. These are local diagnostics,
not a production agent testing tool or device-runtime proof.
