# Agent authoring

The authoring boundary accepts the content an author wants to write. The canonical
document still stores typed expressions, protected prose, and stable identities.
Do not expose those storage structures merely because the reducer accepts them.

The shared codecs and name scopes are implemented here but are not yet mounted
on production SA, build, or MCP tools. Those still use their current canonical
inputs. `text.ts` is also used by the isolated comparison. Mounting the complete
interface, its read projections, and its current guidance is the next delivery
step in `docs/plans/agent-authoring-quality.md`.

`schema.ts` projects explicit canonical content families to authored values. It
follows Zod's preserved refinement lineage; it never identifies content by a
property named `parts` or `label`. The schema walker binds values before the full
canonical schema runs its refinements. Null and omission keep their existing
meaning. Localized values need the current translation unit's `valueKind` to
choose plain text or reference-bearing prose; do not guess from the string.

`queryExpressions.ts` uses the existing Lezer grammar to produce canonical
Predicate and ValueExpression nodes. It never evaluates code. Ordinary `div`
uses real division, consistent with field XPath: an inferred integer result is
promoted through the existing `double` node. `quotient()` preserves canonical
integer division when reading existing expressions and rejects decimal operands.
Explicit numeric types and literal punctuation survive printing and editing.

`AuthoringScope` holds one call's names and types. Fields and Search answers are
local to their form or module; lookup columns are local to their table. Data
definitions and location names must come from the authorized invocation.
Related-record names bind in the destination scope, while a canonical property
with `via` stores the originating case type. Nested `where` clauses change both
parse and print scope. The existing type checker owns relation traversal and
numeric inference; do not duplicate those rules here.

`messages.ts` gives automation messages the same literal escaping as form text.
The record catalog binds case, parent, and host references. The canonical
automation validator still owns allowed properties, shadowing, and message limits.

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
The evaluator exclusively locks the shared ledger before reading it and writes
reservations atomically before requests. Missing or invalid usage retains the
reservation. A crashed process leaves its lock for inspection; do not remove it
until confirming the owner stopped and accounting for pending requests.
Scenario observations use the production Preview and real case database snapshot;
they project submissions without submitting them. These are local diagnostics,
not a production agent testing tool or device-runtime proof.
