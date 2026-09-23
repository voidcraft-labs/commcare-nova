# Agent authoring

The authoring boundary accepts the content an author wants to write. The canonical
document still stores typed expressions, protected prose, and stable identities.
Do not expose those storage structures merely because the reducer accepts them.

The SA editor, build architect, and shared MCP tools use this boundary. They
validate authored shapes and prepare input inside the authorized, serialized
workspace invocation. Private builds look up durable request receipts before
preparing new work, so recovery returns the original result and identities.
Canonical schemas and the existing commit gate remain authoritative.

`readableSchema.ts` simplifies the root-local definitions emitted by the Zod
projection: small values stay beside their arguments, while substantial reused
structures remain shared. It visits schema positions only, preserving literal
data and admission constraints. The same projection serves MCP and both editors.
The editor and architect mount hosted OpenAI tool search and defer shared definitions. MCP
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
`toModelOutput` omits it on live steps and resumed history; MCP and the architect
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

`lib/domain/expressionFunctions.ts` owns form and record-expression signatures.
Both parsers validate arity from that catalog; `getAuthoringGuide` reads it for
function lookup. Shared operations keep their semantics across contexts. The
expressions guide explains reference scope once; form guidance covers wording
and question behavior separately.

`queryExpressions.ts` uses the existing Lezer grammar to produce canonical
Predicate and ValueExpression nodes. It never evaluates code. Ordinary `div`
uses real division, consistent with field XPath: an inferred integer result is
promoted through the existing `double` node. `quotient()` preserves canonical
integer division when reading existing expressions and rejects decimal operands.
Explicit numeric types and literal punctuation survive printing and editing.

`AuthoringScope` holds one call's names and types. Fields and Search answers are
local to their form or module; lookup columns are local to their table. Data
definitions and location names must come from the authorized invocation.
`fieldNames.ts` applies the same field lookup to expressions, wording, tool
targets and anchors: exact identity, then exact path, then a unique short name.
Rename aliases for one UUID are one candidate. An existing root path keeps its
meaning when another group contains a field with that name. Qualified paths
never fall back to their last segment, and ambiguous short names reject.
XPath `/data/...` paths use exact resolution only. The parser's separate
`#form` resolver supplies authoring shorthand without reinterpreting XPath paths.
Related-record names bind in the destination scope, while a canonical property
with `via` stores the originating case type. Nested `where` clauses change both
parse and print scope. The existing type checker owns relation traversal and
numeric inference; do not duplicate those rules here.
The effective catalog includes read-only `case_id`: a relationship identity read
can target an existing parent directly without adding an authored ID property.
Form reads expose the selected and reachable ancestor types with their typed
form-reference spellings through `formRecordContext.ts`, using the domain load
and reachability rules. Read sources are distinct from write destinations.
Its wire attribute and Postgres scalar projection already belong to the shared
property readers; ordinary field and operation writes remain forbidden.

Print a name only when it resolves back to the same identity; an ambiguous label
falls back to its scoped stable address. Existing identities take precedence
over a coincidentally identical display label. External worker values print as
`external-user(...)`, keeping them distinct from authored worker properties even
when a predicate may legally contain both names. Canonical prose admission
already rejects that collision for prose references.
In record expressions, `user(...)` and `#user/...` require a declared worker property. Built-in identity
uses `session(...)`; undeclared custom metadata requires `external-user(...)`.
Forms instead read built-in identity from the worker record through
`#user/hq_user_id`, `#user/username` and `#user/case_name`. `workerIdentity.ts`
projects these supported readings through the expressions guide and `getUsers`;
its runtime check executes the returned expressions in both scopes.
The same worker-information read exposes primary place, all assigned places and
the primary case-sharing group in form and record scopes. Preview projects them
from actual or disposable persona assignments; HQ supplies the corresponding
worker case and session facts. Missing assignments remain empty. Location IDs
are not new authored worker properties or a substitute for case-flow settings.
An unknown property must never silently become an external metadata dependency.

`messages.ts` gives automation messages the same literal escaping as form text.
The record catalog binds case, parent, and host references. The canonical
automation validator still owns allowed properties, shadowing, and message limits.
Literal opening braces are escaped individually, including a single brace next
to a reference; otherwise text and an insertion can merge into a new delimiter.

The native and JavaScript prototypes have been retired. Their comparison and
limitations remain in `docs/research/agent-authoring-pilot-2026-09-12.md`; Git
history preserves the implementations. The local evaluator now uses production
prompts and tools, with effects restricted to its disposable app.

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

Preparation runs inside the authorized workspace invocation. The canonical
workspace validates immediate edits; a private workspace can retain incomplete
work until publication passes the same kernel. Authorization, reference
validation, atomic writes, and concurrency remain with those owners. Do not catch a commit conflict as a preparation error or rebind an already
prepared operation after a peer edit. The pilot's call deduplication lasts only
for its process; production must use the durable call ledger.

Tool bodies return canonical values. `output.ts` is the only place a read
becomes authored content, through one projector per registered read tool: the
table is exhaustive over the registry's read tools, so a new read must state its
projection, and each walked value is typed against its canonical schema, so a
slot that was already authored fails `tsc`. Never print a value inside a tool
body or a snapshot helper; two owners of one projection is how a valid form
became unreadable. Menu icons are content families like prose and expressions:
the document stores `nova-icon:<slug>` or an asset id, authors read and write
the slug, and the slot's module or form catalog still decides admission.

`sharedToolCall.ts` is the one call body (bind input, execute, project a read)
that the editor, the architect and MCP all run. Its halves fail differently.
`AuthoringInputError` means the caller can correct the input. Stored content is
already admitted, so anything thrown while printing it is Nova's defect:
`projectAuthoringReadInContext` records it once at `error` and throws
`ReadProjectionError`, which MCP reports as `internal` and the model-facing
surfaces report truthfully without inviting a retry. On the canonical side a
tagged union is read by its discriminator, never by re-running every variant's
refinements.

Read results use the same authored content shapes accepted by edits.
`getCaseProperty` reads one exact catalog definition. `updateCaseProperty`
merges an explicit patch into that definition under the workspace gate; null
clears optional settings and omission preserves them. Type conversion remains
with `editField`, and identity changes remain with `renameCaseProperties`.
Catalog edits do not rewrite existing form content. `setCaseTypeParent` edits ancestry through `setCaseTypeMeta`; saved case links remain unchanged. Module `parentCaseModuleUuid` independently chooses the parent-selection route. Form and operation reads expose ordinary answer-derived writes and preloaded field identities, so an empty advanced-operation list cannot be mistaken for a form with no record effects.

Preserve existing child identities when replacing content. A read/edit cycle must not
silently drop media, validation messages, navigation, or option identities.
Production option edits preserve identity and attached media by retained identity
or unique value. Field reads expose the editable validation, repeat, and choice
shapes; option media remains a separate read-only fact. Translation source proofs
are opaque SHA-256 transport tokens, resolved against the current canonical proof
before the original concurrency checks. Translation review takes one revision
over the exact language, unit, current source and stored entry. Preparation
recovers the canonical review arguments within the same invocation; the model
does not echo the translated value. No second proof is persisted.

The local evaluator captures credential-free request bodies in a private folder,
limits model steps and requests, records conservative spend, and soft-deletes its
owned disposable app in `finally`. Scenario rows belong only to those apps.
The evaluator exclusively locks the shared ledger before reading it and writes
reservations atomically before requests. Missing or invalid usage retains the
reservation. A crashed process leaves its lock for inspection; do not remove it
until confirming the owner stopped and accounting for pending requests.
The shared form evaluator uses the production Preview engine. It reads authorized
worker records by default; an explicit scenario replaces that population with
supplied test records, admitted through the same derived property schemas. It
does not combine test records with stored rows or save them. Lookup data stays
authorized and real. Results identify scenario evaluation and project ordinary
case values; they do not prove storage, additional case operations or device behavior.

The fields guide explains bound-repeat timing and row identity. Top-level
counts and queries initialize at form load; a nested repeat initializes when
its enclosing repeat row is created. Opening a page or changing relevance does
not defer this initialization. A direct child hidden field can read its
query-bound row identity with `current()/../@id` and expose a named form
reference for operations. A property lookup inside a predicate uses
`current()` to retain the originating row context; `#case` retains its selected-record
meaning. The authoring-to-evaluator check exercises that expression through the
shared tool grammar and production form worker.
