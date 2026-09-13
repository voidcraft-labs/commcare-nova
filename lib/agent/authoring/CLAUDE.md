# Agent authoring

The authoring boundary accepts the content an author wants to write. The canonical
document still stores typed expressions, protected prose, and stable identities.
Do not expose those storage structures merely because the reducer accepts them.

The SA editor and shared MCP tools use this boundary in production. The build
executor still uses its durable handle interface; its integration is a separate
step in `docs/plans/agent-authoring-quality.md`. Both surfaces validate authored
shapes, then prepare input inside the authorized, serialized workspace invocation.
Canonical schemas and the existing commit gate remain authoritative.

The editor mounts hosted OpenAI tool search and defers shared definitions. MCP
publishes the same authored schemas; its client owns discovery. Detailed reference
material lives in `reference.ts`, available through `getAuthoringGuide`. The prompt
sets purpose, collaboration, and app-quality judgment without describing storage.
MCP fetches that stable guidance by mode. `appOverview.ts` supplies current app
orientation separately, shared by editor turns, retries, and MCP `get_app`.
Detailed questions and configuration belong to scoped reads. The plugin only
bootstraps current server guidance; it does not keep another authoring manual.

Write results report completed operations with `ok: true`, created identities,
and any consequential side effects. Confirmation and rejection remain explicit.
`ok` does not distinguish a canonical save from private staging, or a change from
an already satisfied request. `summary` belongs to transcript presentation: SDK
`toModelOutput` omits it on live steps and resumed history; MCP and the executor
project it out as well. Read payloads retain their data keys. Saved values set
aside by a committed migration travel separately as `dataReview`, including when
a later reporting step fails. Automation writes return setup requirements;
`getAutomations` supplies one full guide on request.

`schema.ts` projects explicit canonical content families to authored values. It
follows Zod's preserved refinement lineage, emits reusable definitions once, and it never identifies content by a
property named `parts` or `label`. The schema walker binds values before the full
canonical schema runs its refinements. Null and omission keep their existing
meaning. Localized values need the current translation unit's `valueKind` to
choose plain text or reference-bearing prose; do not guess from the string.

`identitySchema.ts` uses the shared identity-family classification to project
scalar references and walk their finite request values, including recursive
location trees and property-keyed records. Creation slots retain optional IDs;
anonymous items, media, and data rows retain exact IDs. `identityBindings.ts`
resolves named resources in the invocation's document and authorized catalogs.
Owners bind before their children, and complete additions bind before content
decoding. Unknown or ambiguous names refuse before mutation. Explicit IDs retain
the owning tool's missing-item and no-op behavior. A name is never a stored alias.

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

Print a name only when it resolves back to the same identity; an ambiguous label
falls back to its scoped stable address. Existing identities take precedence
over a coincidentally identical display label. External worker values print as
`external-user(...)`, keeping them distinct from authored worker properties even
when a predicate may legally contain both names. Canonical prose admission
already rejects that collision for prose references.

`messages.ts` gives automation messages the same literal escaping as form text.
The record catalog binds case, parent, and host references. The canonical
automation validator still owns allowed properties, shadowing, and message limits.
Literal opening braces are escaped individually, including a single brace next
to a reference; otherwise text and an insertion can merge into a new delimiter.

`experimental` is reachable only from the local comparison script. Its native
tools cover one client workflow. The JavaScript adapter preserves the comparison
for inspection; it is not a second production authoring path. The selected
direction and limitations live in
`docs/research/agent-authoring-pilot-2026-09-12.md`.

Resolve all names for one operation against its complete scope before preparing
mutations. Creation allocates identities before binding expressions. A field or
Search-answer rename resolves both its original and proposed paths during that
operation; ambiguous paths reject. Other resources resolve against the current
catalog, including before a batch renames a data column. No name becomes a
stored alias. `#case/property` requires a
known selected case type and stores the actual type. Unbound bare names reject
rather than becoming opaque text that renames cannot maintain.

Wording is Markdown. Answer interpolation is parsed at this boundary and printed
back to the same authoring representation. Literal braces and backslashes must
round-trip. Conditions use Nova's existing XPath grammar. Instance and current()-rooted paths retain their existing XPath semantics.
Connect wrapper paths are admitted by the canonical Connect validator.

Preparation and canonical admission run inside `CanonicalMutationWorkspace`.
Authorization, reference validation, valid atomic writes, and concurrency remain
there. Do not catch a commit conflict as a preparation error or rebind an already
prepared operation after a peer edit. The pilot's call deduplication lasts only
for its process; production must use the durable call ledger.

Read results use the same authored content shapes accepted by edits. Preserve
existing child identities when replacing content. A read/edit cycle must not
silently drop media, validation messages, navigation, or option identities.
Production option edits preserve identity and attached media by retained identity
or unique value. Field reads expose the editable validation, repeat, and choice
shapes; option media remains a separate read-only fact. Translation source proofs
are opaque SHA-256 transport tokens, resolved against the current canonical proof
before the original concurrency checks. No second proof is persisted.

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
