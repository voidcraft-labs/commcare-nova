# Unit 18 — Canonical identity and expression foundation

**PR:** `Make Nova identity and expression authoring canonical`

**Depends on:** nothing outstanding. · **Blocks:** units 2, 8, and 14.

> Read [the binding contracts](00-contracts.md) first — especially identity,
> valid-by-construction authoring, and direct maintenance cutovers. This unit
> changes persisted Blueprint and mutation shapes, so `lib/domain/CLAUDE.md`,
> `lib/doc/CLAUDE.md`, `lib/db/CLAUDE.md`, `lib/agent/CLAUDE.md`, and the
> expression-specific subsystem docs are part of the implementation contract.

Make immutable authoring identity literal at every Nova boundary. An entity UUID
is a lowercase, hyphenated RFC UUID with version 1–8 and the RFC variant;
uppercase, nil, max, malformed, non-versioned, and non-RFC-variant strings are
rejected rather than normalized. Lookup table, column, and row ids retain their
distinct brands and UUIDv7 restriction. The following authorable identities use
that strict shape: modules, forms, fields, select options, case-list columns,
Search inputs, worker-information properties, user types, personas, case
operations, and uploaded media assets, plus the organization, location, section,
link, and endpoint entities the remaining units add.

App, case, Project/auth, actor/owner, thread, run, batch, capture-attachment,
form-entry, and submission-intent ids remain opaque protocol or storage values.
They are not SA/MCP targets or cross-object authoring references.
`form_submission_intents.form_uuid` and `form_attachments.field_uuid` are strict
because those columns reference authored entities; `attachment_id`, `entry_key`,
and the intent's own identity remain explicitly outside that authoring
vocabulary.

The strict UUID shape applies to embedded entity ids, UUID-keyed Blueprint
records and membership arrays, every stored reference, every mutation, every
SA/MCP address, every route or API parameter that names an authorable Nova
entity, and every database column whose semantic value is one of those
identities. Record keys equal their entity's embedded UUID. UI selection state
uses `null` or a discriminated arm rather than an invalid UUID sentinel. The
narrowing helpers validate and throw; they are not unchecked casts.
The closed production inventory includes conditional-close drafts, inactive
inspector and sticky workspace hooks, `when-input-present`, `id-of`, and generic
term constructors. A constructor with no eligible target is unavailable rather
than initialized with an empty, fabricated, or arbitrary fixture UUID. A source
tripwire rejects `asUuid("")`, `"" as Uuid`, and hard-coded placeholder authored
UUIDs in production editor code; interaction tests prove every draft acquires a
real in-scope identity before commit.

The document topology is closed as well as typed. Every module, form, field,
worker-information property, user type, and persona appears exactly once in its
owning membership sequence. Every membership entry resolves to the expected
record kind and valid parent. A parent is required for each owned/nested kind
and is exactly null for each Blueprint-root or flat kind; an unexpected
null/non-null parent, missing or wrong-kind parent, cycle, duplicate membership,
stray order key, or record/sequence disagreement rejects the document at the
domain/commit boundary. Assembly and decomposition enforce the identical law.
There is no steady-state orphan sentinel or persisted ghost field outside the
runnable form tree.

Uploaded library assets use a distinct strict `MediaAssetId`. Built-in menu
icons use a closed `BuiltinIconRef` generated from the catalog, and `IconRef` is
their union only on `Module.icon`, `Form.icon`, and
`Module.caseListConfig.icon`. The module/case-list catalog and the form catalog
are separately closed; a valid built-in in one family is not automatically
valid in the other. App logos, audio labels, field and option media, image-map
cells, chat attachments, media routes, storage metadata, and reverse indexes
accept uploaded UUIDs only. Menu-icon tools accept the applicable catalog slug,
an uploaded UUID, or `null`; reads project a built-in back to its catalog slug.
Unknown or raw `nova-icon:*` input is never an authoring escape hatch.

Every stored XPath-bearing slot contains only the canonical `XPathExpression`
AST. Every reference-capable field label, hint, help, validation message,
select-option label, or case-property catalog display default contains only
`ProseTemplate`. A template carries typed text, field UUID, case
`(caseType, property)`, custom-worker-property UUID, and external
worker-property parts. Markdown remains text. A literal hashtag is text; a
reference is a typed part. Reference indexing, validation, rename/move, case
retirement, Preview, and CommCare emission walk the typed parts structurally.
External worker-property prose uses the same open, validated CommCare/session
name grammar as Predicate and XPath. Document-aware admission rejects a name
that exactly or case-insensitively collides with a Nova-owned custom worker
property; that property must use its UUID-backed arm instead.

The builder's XPath surface remains a human text projection: CodeMirror prints
current names from identity and parses once at commit. The prose surface is
structural instead of a lossy flat-text round trip. A TipTap inline atom stores
the exact template-reference arm and identity while showing its current friendly
label. Ordinary typing and paste always create text, including text that looks
like `#form/question`; the suggestion menu or an explicit convert action inserts
the atom. Regex may decorate text or offer that action, but never silently turns
characters into a reference. Commit walks TipTap text and atom nodes into the
template, and reopening maps the template back to the same nodes. SA and MCP read
and write the exact stored ASTs and templates directly. They have no XPath
source parser, prose-token parser, field-path resolver, worker-slug resolver,
HTML unescaper, or parallel author AST.

An author therefore continues to type and read friendly expressions such as
`#form/first_name`; the editor resolves that projection once and stores the
field UUID, then prints the current friendly path on every reopen. A person is
never asked to type, read, or repair `#form/<uuid>`. A dangling identity is
prevented by reference-aware removal and otherwise shown as an explicit repair
state, not leaked as UUID-shaped authored XPath. A human-facing printer has the
owning document or returns a structured unresolved result; it never substitutes
the UUID for a missing name. Wire emission fails closed on the same unresolved
identity.

`path-ref` stores only `{ kind: "path-ref", uuid }`. It does not persist
depth-dependent separator bytes. Its printer emits the one canonical absolute
`/data/<current path>` spelling, so a depth-changing move changes only the
projection and reparsing that projection reproduces the identical UUID leaf.
The migration scan rejects a noncanonical pre-cutover absolute-path spelling rather
than silently preserve or normalize it.

Predicate and ValueExpression Search-input leaves store
`{ kind: "input", searchInputUuid }`, including both ordinary term positions and
`when-input-present`. Preview, SQL, and CommCare emission resolve that UUID to
the input's current saved wire name. Renaming an input rewrites no predicate;
removal uses the reference index and the same dependency-confirmation policy as
other referenced entities.

Predicate authoring also carries the exact runtime set that evaluates the
stored rule: on-device, case-search, or both. A search-enabled case-list filter
uses the both-runtimes arm because it emits to the ordinary device nodeset and
the remote CSQL query. Its editor applies the case-search expression oracle and
offers only the on-device match-mode subset, so a server-only choice is never
offered for a carrier that must also run on device. There is no offered-then-
refused exception for the active value.

The machine-authoring gate is document-aware, not merely structural. It rejects:

- `raw-ref`, references hidden in XPath text or another pre-cutover
  machine-reference encoding, noncanonical empty or adjacent text runs, and any
  mutable absolute/form path spelling. Ordinary `ProseTemplate` text that
  happens to look like `#form/question` remains literal text and is never
  rejected or promoted to a reference;
- a missing, wrong-kind, foreign-form/module, or otherwise out-of-scope UUID;
- a custom worker property expressed through the external `user-ref` arm;
- duplicate/colliding predeclared UUIDs and invalid same-call topology.

Canonicality is proved against the owning document plus the complete same-call
overlay. XPath printing and reparsing must reproduce the identical AST; a
template must survive the structural template → TipTap nodes → template mapping
identically. The error names the offending part and the UUID scope it violated.

The exact mutation batch is canonical before any reducer sees it.
`admitMutationBatch(value: unknown)` is the one shared boundary and returns an
opaque `AdmittedMutationBatch` that no caller can construct or forge. Admission
first walks property descriptors without reading through ordinary property
access, invoking a getter, setter, `toJSON`, or iterator, and builds a detached
tree; a descriptor/prototype introspection failure, including a throwing proxy,
rejects safely. It accepts
`null`, booleans, strings, finite stable JSON numbers, dense arrays, and own
enumerable data properties on plain or null-prototype objects. Frozen objects,
different object-key order, null prototypes, repeated equal values, and acyclic
shared input references are semantically harmless; shared references are
de-aliased in the detached tree. It rejects `undefined`, functions, symbols,
`BigInt`, `NaN`, infinities, negative zero, sparse arrays, custom array
properties beyond dense indices and the intrinsic non-enumerable `length`,
symbol or non-enumerable object properties, accessors, cycles, boxed primitives,
`Date`, `Map`, `Set`, `RegExp`, typed arrays, and every other custom prototype
before any serialization hook can run.

Admission serializes that safe detached tree exactly once, parses it back, runs
the array through the one final `mutationSchema`, and compares the schema output
to the parsed JSON tree as an exact JSON value. Object keys are unordered but
their sets and values must match exactly; arrays are dense and ordered; primitive
comparison uses `Object.is`. The schema may validate, but may not default,
coerce, strip, transform, or otherwise change the value. Every mutation envelope
patch default is deleted: an intentionally semantic-only update carries
`patch: {}` explicitly. Schema output is validation evidence only. The admitted
payload is the reparsed JSON tree after admission re-protects, detaches, and
deep-freezes it; it is never Zod's output, whose prototypes or aliases are
outside the JSON-value comparison. That tree is branded inside the admission
module. Serialization is hook-inert even if
`Object.prototype.toJSON` or `Array.prototype.toJSON` has been polluted:
admission uses a module-captured intrinsic serializer and shadows inherited
`toJSON` on every detached container with an internal non-enumerable undefined
data property that is excluded from JSON-value equality. It never consults an
input hook. Every later wire/database encoder consumes this protected admitted
tree or the already-produced JSON text; it does not rebuild a caller-owned
object first. One shared `encodeAdmittedMutationEnvelope` also constructs every
mutation-bearing accepted-row parameter, transient `data-mutations`, durable
stream frame, event, and tool-result wrapper as a detached hook-inert container
before the captured serializer sees it. Protecting only the nested mutation
array while passing an ordinary wrapper to `JSON.stringify` is forbidden.
Neither caller mutation after admission, an authoritative transaction retry,
reducer behavior, prototype pollution, nor delayed event emission can mutate or
change the serialization of the admitted batch or any candidate document
through an alias.

Failure is `MUTATION_WIRE_CANONICALITY_INVALID`, classified as `soundness` in
`VALIDITY_CLASS_BY_CODE`. Its safe structured details contain the first
`mutationIndex` (`null` for any batch-level failure not attributable to one
mutation, including a non-array root or a root-array descriptor/prototype
failure), an RFC 6901 pointer (the empty string for a root failure), and a stable
reason:
`non-json-value`, `sparse-array`, `schema-default`, `schema-strip`,
`schema-coercion`, or `schema-parse`; an implementation may refine a
non-JSON reason without exposing the offending value. First means mutation
index order, then depth-first array order and lexicographically sorted escaped
object keys, so the same input reports the same location. An unknown key reports
the exact known parent-object pointer rather than echoing its arbitrary name;
the internal first-key choice remains deterministic. Error messages and logs
contain no labels, offending values, prose, arbitrary unknown key names, or
other user data. Builder copy says the edit could not be saved and identifies
the safe authored setting where available; SA and MCP results name the safe
mutation kind/pointer and corrective shape. HTTP autosave returns status `400`
with `{ error: "This edit could not be saved because its mutation data was not
canonical.", type: "mutation_wire_canonicality_invalid", retryable: false,
details: { mutationIndex, pointer, reason } }`, where details are the safe values
defined above. It is never a retryable collaborator conflict. The reconciler
maps only that exact type to the canonicality protocol-failure outcome: retain
the offending and every later local edit, retry nothing, drop nothing, advance
no cursor, perform no collaborator-conflict callback or reload, freeze editing,
render the fixed copy plus safe location, and emit one observability report.

The HTTP mutation route parses the request body as untrusted JSON and preserves
`mutations` as `unknown`. Apart from request-size/JSON framing and authentication,
admission is the outermost mutation operation: no route-level
`z.array(mutationSchema)`, default/transform, batch-id deduplication, target
extraction, scope/identity/sequence check, reducer, saga projection, DDL, or
side effect may observe the raw batch first. Internal producers likewise call
admission before local reduction. `prepareMutationCandidate(prevDoc, admitted)`
accepts only the opaque admitted type, computes a fresh document-specific
candidate for each authoritative transaction attempt, and carries that admitted
batch in the candidate. Prepared verdict and writer APIs consume the opaque
candidate/admitted type, never an independently supplied `nextDoc` plus raw
mutations. Transaction retries reuse the admitted immutable batch but recompute
the candidate against the newly locked document.

App creation seeds/templates, builder queues, undo/redo inverses, Connect
compound actions, single and staged SA/MCP planning, diffs, frozen pre-cutover/media/
synthetic repairs, Project-move media remaps, autosave and saga preflight, and
authoritative retries all enter through this proposal-admission boundary.

Staged calls use one `admitMutationStages(value: unknown)` boundary. It safely
descriptor-inspects and detaches the outer stage array, each exact stage
envelope/tag, and each stage's `mutations: unknown` before any caller or helper
may read `length`, an index, an iterator, or call `filter`/`flatMap`. It then
returns one opaque `AdmittedMutationBatch` plus immutable ordered
`{ stage, start, end }` slices into that batch. Empty stages may disappear from
the slice list only after their exact empty arrays have passed admission; a
sparse or custom-property empty stage cannot be normalized away. The optimistic
candidate, authoritative writer, transient tool result, and chat/MCP events
consume the admitted batch and those slices through the admission module's
protected slice encoder, never a raw stage array or a separately flattened
copy. Stage tags and boundaries therefore cannot drift, alias, or retain a
pre-admission object.

Transient chat `data-mutations`, delayed chat/MCP events, tool results, accepted
rows, stream frames, client reconciliation, baseline suffix scans, reloads, and
post-baseline replay consume only detached admitted values or reassert the same
exact contract on durable JSON. Agent/remote frames and every post-horizon
replay parse completely before the first reduction or partial emission. A source
inventory classifies every reducer/writer entrypoint as either “admits a
proposal” or “consumes a durable admitted value”; a new unclassified entrypoint
fails CI. No surface may compensate by re-diffing a candidate document after
the gate. This is one admission law around the final schema, not a normalization
dialect or a read-time repair.

`(app_id, batch_id)` idempotency is content-bound after admission. The stored
fingerprint is the exact semantic JSON value of
`{ mutations, actorUserId, kind, runId: runId ?? null }`; the explicit null
matches the accepted row's nullable attribution and leaves no undefined
envelope value. Object-key order, null prototypes, and de-aliased sharing cannot
create false mismatches. An already stored fingerprint that matches exactly
returns the existing sequence without a second reducer run, event, log record,
notification, or side effect. Any difference is the separately typed terminal
`MUTATION_BATCH_ID_COLLISION`, never an idempotent success or a canonicality
error. The unique-violation race path reloads the winning row and performs this
same equality check. A noncanonical retry is rejected before it can consult or
latch onto an existing batch id.

The collision has one explicit surface mapping. HTTP PUT returns status `400`
with `{ error: "This save reused a batch id for different content.", type:
"mutation_batch_id_collision", retryable: false }`. The reconciler maps only
that exact type to its permanent protocol-failure outcome: it retains the
offending and later local edits, retries nothing, drops nothing, advances no
cursor, performs no collaborator-conflict callback or reload, and freezes
editing with the recovery message plus one observability report. SA treats a
collision of its server-minted batch id as an internal protocol failure that
aborts the run without reminting, retrying, or emitting a mutation event. MCP
returns its ordinary typed `internal_error`, not `invalid_input` or a reloadable
conflict; neither surface exposes stored payloads. Canonicality rejection
remains the separate author-correctable invalid-input path.

In particular, an `undefined`-valued patch clear is rejected rather than applied
locally and then lost by `JSON.stringify`; builder controls lower a clear to
explicit `null` at their batch-building boundary, and every direct session,
repair, diff, SA, and MCP producer emits the same spelling. Omission means no
intent, `null` means clear only where the owning schema says so, and a stored
semantic `null` remains distinct from either. Form and module renames use their
identity-specific rename mutations; this does not invent a field-rename
mutation where `updateField` intentionally owns the field id.

`updateField.patch.id` is the one final field-id command; there is no
`renameField` alias, deprecated arm, or replay reader. The reducer first builds
and schema-checks the complete prospective field. A field has three independent
facts: immutable `uuid`, local question/path `id`, and, on eligible kinds, an
optional `caseWrite: { caseType, property }`. Changing `id` changes only the
question node and friendly form/XPath projection. Changing or clearing
`caseWrite` retargets only that writer; the old property, its peer writers,
typed references, catalog declaration, and saved values remain intact, while
the new pair is validated and a custom property is declared without an
old-to-new cascade or row migration. Fixed case-row scalars are implicit and
never synthesize catalog metadata. A patch may change both facts atomically, but no before/after
heuristic converts that local edit into global rename intent. `moveField`
likewise preserves `id` and rejects a destination path collision; an author who
wants a different local id sends the explicit `updateField` patch.
An add-field surface may seed `caseWrite.property` from the entered field id as
a one-time convenience, but the committed field always contains the complete
explicit pair and the two values are independent afterward.

`caseWrite` admission is closed over the actual emitted action bucket. A survey
or any form without a case action rejects every binding instead of storing a
writer the wire will ignore. Within the primary bucket and within each child
bucket identified by `(caseType, nearest repeat UUID)`, at most one field
may write each property; duplicate ordinary properties and duplicate
`case_name` writers reject before derivation can overwrite or choose one.
Registration requires exactly one primary `case_name` and emits it in
`<create>`; it admits at most one primary `external_id`, emitted as
`<update><external_id>` in the same case transaction per
`FormPreparationV2Test::test_open_case_external_id` /
`form_preparation_v2/open_case_external_id.xml`. Every derived child-create
bucket likewise requires exactly one `case_name` and at most one
`external_id`, with the latter in the child `<update>`.
Followup and close forms may bind exactly one primary `case_name`: CommCare's
exact
`corehq/ex-submodules/casexml/apps/case/tests/data/v2/basic_update.xml`
fixture proves `<update><case_name>…</case_name>` is an accepted existing-case
name update, so Nova emits and preloads that binding rather than dropping it. A
child bucket is a create bucket, never an existing-child update bucket.
Followup and close `external_id` writers emit and preload through
`<update><external_id>`.
Case-operation writes are stored and resolved
under `(operation.retype ?? operation.caseType, property)`, so a retype never
leaves the write attached to the pre-operation type. All bindings still emit
their source through the UUID-resolved current `FormPath`.
The two standard writable scalars have explicit private wire/storage
projections:
Nova `caseWrite.property: "case_name"` becomes the HQ FormActions update key
`name`, which the XForm lowering emits as `<update><case_name>`; `name` remains
rejected as Nova input. `caseWrite.property: "external_id"` remains
`external_id`; registration, followup/close, and child actions all lower it to
`<update><external_id>`. Both route to dedicated `cases` columns and never the
custom JSONB document. Generic case-operation writes admit `external_id` but
not `case_name`, whose operation-owned name/rename facets remain authoritative.
Every other reserved property rejects. Lowering never
silently filters a reserved or otherwise inadmissible writer: its shared
inventory assertion throws if the complete validator was bypassed.

Every ordinary-field and advanced-operation write to these fixed text scalars
uses one value contract before wire or storage: remove boundary UTF-16 code
units U+0000 through U+0020 exactly like Java `String.trim()`, then enforce the
Core/HQ 255 UTF-16-unit cap. A normalized blank `case_name` rejects. An active
blank `external_id` is a real `""` scalar write; an absent or irrelevant source
means no write and preserves the current value. The same routing holds for
Preview, single and bulk inserts, updates, duplicate-create merges, and
wire-portable retypes.

`lib/domain/caseWriteInventory.ts::deriveCaseWriteInventory` performs the one
and only field walk for case writes. Its Nova-only writers carry field UUID and
current id, the explicit `{ caseType, property }` pair, every ordered path
segment as `{ fieldUuid, fieldId, queryBoundIteration }`, and the nearest
repeat's UUID, current id, and segment path. It groups those writers into the
primary action or a child-create action identified by `(caseType, nearest
repeat UUID)`; the complete validator, builder, SA/MCP admission, FormActions,
and Preview consume those exact writers and buckets rather than walking fields
or classifying actions again.

`lib/commcare/caseWriteAdmission.ts::assertAndProjectCaseWriteInventory` is the
sole semantic-plus-wire bridge. It rejects every inventory issue, then projects
each writer path and repeat path exactly once into CommCare-private `FormPath`
values for FormActions/XForm lowering and Preview. XML-illegal current field or
ancestor ids still produce the one owning `INVALID_FIELD_ID` validator finding;
if validation is bypassed, both lowering and Preview throw the same `FormPath`
projection failure instead of introducing a second user-facing finding.
Preview materializes the admitted bucket directly, trusts the bucket's
`primary`/`child` classification, and asserts that runtime repeat traversal's
nearest repeat UUID matches the bucket UUID before writing.

A writable destination type is exactly the module's own case type or a catalog
type whose `parent_type` is exactly that module type. A declared sibling,
parent, grandchild, unrelated type, unknown type, blank pair, module-less form,
or survey/no-action context rejects and never becomes a child-create bucket;
the blank pair is rejected at the shared schema boundary. Survey/no-action
builder contexts expose no actionable Saves-to choices. Creation/edit SA and
MCP tools pass the same complete candidate through this inventory and gate
rather than maintaining their own type list.

The final semantic mutation-kind manifest contains no `renameField`. Those bytes
may occur only inside opaque pre-horizon audit payloads; the frozen dispatcher
does not classify, parse, or replay them as a semantic mutation arm.

App-wide case-property rename has exactly one explicit semantic command:
`renameCaseProperties { renames: [{ caseType, from, to }, ...] }`. It is the
only mutation in its admitted batch and its nonempty relation is interpreted
simultaneously from the batch-start snapshot. Within each case type, sources
and destinations are unique, `from !== to`, and an occupied destination must
itself move away in the same relation. A source cannot be recreated in the
batch; standard scalar case metadata cannot participate, and terminal merges,
scalar/JSONB storage-boundary crossings, and destination collisions in live or
parked rows reject. Chains into a fresh name, swaps, and cycles are valid;
many-to-one relations are not. No temporary property, winner, drop, or newly
parked value exists. The ordinary complete-document validator separately
rejects any other CommCare-forbidden fresh destination; `lib/doc` does not
import or duplicate wire-only reserved-word tables from `lib/commcare`.
Every source must already be an existing materializable non-scalar property.
Every own destination key in every saved case counts as occupied even when its
JSON value is `null`, an empty string, or otherwise blank; every parked entry
counts regardless of dismissal state. The command never crosses into or out of
dedicated scalar storage.

The command rewrites every occurrence of each named pair: field `caseWrite`,
case-operation writes, typed Predicate/ValueExpression/XPath/Prose references,
catalog declarations and defaults, module case-list and Search configuration,
materialized schema/index intent, `cases.properties`, and
`parked_case_values.property`. The row rewrite changes only the JSON key/value
placement and preserves every non-name case and parked-value column byte,
including `modified_on`; it uses a dedicated no-stamp path rather than the
ordinary case-update writer. Field `id` never changes. The builder presents
Field ID and Saves to as separate controls and provides an app-wide
case-property rename action with the complete impact; SA/MCP field tools accept
`caseWrite`, while the separate shared machine action is SA
`renameCaseProperties` and MCP `rename_case_properties`.
History stores the inverse relation and replay preserves the original command.
Generic `diffDocsToMutations` never synthesizes rename intent from two endpoint
documents: an explicit rename and a set of independent carrier edits can have
byte-identical Blueprint endpoints but deliberately different saved-row effects.
Ordinary field/case-operation writer retargets, catalog adds/removes/edits, and
typed-reference edits still lower to their granular commands and deliberately
do not move rows. An endpoint-only diff refuses only when the complete pair is
exactly the same carrier-wide rename-shaped transformation and its caller did
not supply the exact already-recorded semantic command provenance;
command-aware undo/replay pass that command directly. The collaboration
reconciler uses canonical document equality for equality-only checks and never
asks semantic diff to invent a command.
A rename followed by its inverse before autosave returns the aggregate
optimistic Blueprint to byte-identical starting bytes, but it remains two
explicit semantic commands. The store keeps both admitted segments in order;
autosave persists two accepted events and history entries in that order; the
authoritative writer applies the first row/parked-key move and then reverses it.
Neither document equality nor empty endpoint diff may elide either command.
Autosave therefore observes the admitted-command queue through its own
monotonic notification, not only persisted Blueprint reference changes: the
second command must wake dispatch even though the aggregate optimistic
Blueprint is back at its starting bytes. A separate ordinary swap proves the
single-command path: one accepted `renameCaseProperties` event rewrites the
Blueprint carriers plus saved-row and parked keys simultaneously and persists
that exact command.

The builder has exactly two authoring homes. The selected field's Data section
owns one composite **Saves to** chooser over complete `{ caseType, property }`
pairs, grouped by the module's writable own/direct-child types. It can clear,
choose an effective-catalog property including one with no current writer, or
locally assemble **Save to new property…** and then commit one complete pair;
every proposed value is dry-run through the real candidate gate and refused
choices remain visible with their exact reason. Field ID stays solely in the
identity section.

The builder-level app-wide **Case data** manager owns a **Case properties**
dialog and remains reachable whenever the app has case types, not only when the
current route supplies a module. Its inventory includes catalog-only and
no-writer materializable properties. One review may compose the complete
simultaneous relation, including swaps, cycles, and occupied-destination chains;
it never offers merge, overwrite, drop, or a temporary name. A pure impact model
is parity-tested against the rewrite walker and groups field and operation
writers, every typed read/display/list/Search occurrence, catalog
defaults/declarations, saved rows, and parked values. Review requires the
document planner, full commit verdict, and a read-only server row/park preflight;
that preflight authorizes Project view access, scans held and dismissed values,
and returns the authoritative mutation sequence plus explanatory per-relation
counts/conflicts, never a write token. Any reconciled/base-sequence change
invalidates the report and requires Review again. The authoritative transaction
rechecks everything; drift or a save conflict returns **Case data changed;
review again**, and success waits for acknowledgment of the exact exclusive
batch. Viewers can inspect but cannot mutate. The UI uses the shared accessible
builder controls, preserves focus, exposes checking/saving/refusal status, and
remains usable at handset and short window sizes. App Settings data-source views
remain informational rather than a second rename owner.

Steady state has exactly one representation. Historical input recognition is
confined to this unit's timestamped scanner, digest-pinned repair, and frozen
migration; those modules are not imported by runtime schemas, readers,
reducers, writers, UI, Preview, SA/MCP, or emitters. The cutover deletes every
alias, fallback, permissive read arm, dual writer, repair-on-load branch, and
saved-draft branch. Runtime code and documentation do not call a supported
shape “legacy”: an old byte shape is either consumed once by the frozen
pre-cutover authority or it is rejected. Source tripwires enforce that
separation and reject imports from the frozen directory into steady-state code.

App tenancy likewise has one representation. Every persisted app carries one
nonblank `project_id`; the SQL column is `NOT NULL` and foreign-keyed to the
Better Auth Project, Project membership is the sole app authorization path, and
`apps.owner` remains creation provenance only. No writer, reader, run holder,
thread, media path, lookup edge, repair, scanner, or test has a no-Project or
owner-fallback app arm. A missing app and an impossible missing Project are
different results rather than a shared nullable return. Every case row also has
a nonblank Project, and a `DEFERRABLE INITIALLY DEFERRED` composite foreign key
binds `(cases.project_id, cases.app_id)` to
`(apps.project_id, apps.id)` with `ON UPDATE NO ACTION` and `ON DELETE
RESTRICT`; the deferred update check lets the cross-Project move update the
complete closure inside one transaction, while the restricted delete forbids
an orphaned case tenant. The internal schema-only `PostgresCaseStore`
constructor may remain a discriminated no-Project mode because every
tenant-bound method rejects it and it persists no app or case row.

Final entity schemas require every persisted nested UUID and every list/detail
order and derive placement solely from owning membership arrays. Optional
`uuid`/`order` ghost fields and hydration/backfill branches are deleted.
Hydration may clone, normalize prototypes, and derive only nonpersisted indexes
such as `fieldParent` and `refIndex`; it never mints, backfills, repairs, orders,
or infers authorable UUIDs, columns, Search inputs, options, or order arrays.
Missing or invalid persisted state blocks. The frozen migration is the only
code that converts a pre-cutover missing identity or position.

Standard case metadata has one Nova stored, accepted, and printed vocabulary:
`case_name`, `date_opened`, `external_id`, `last_modified`, `owner_id`,
`status`, `case_id`, and `case_type` where applicable. The alternate
`name`, `date-opened`, and `external-id` spellings are removed from domain
enums, catalogs, scalar maps, SQL/Preview readers, validators, prompts, and
docs. No `canonicalize` or alias-coalescing helper survives. A different
CommCare spelling may exist only as a one-way private `lib/commcare` output
projection; it is never accepted as Nova authoring input or stored state.
One shared authored-case-property-name schema owns that vocabulary and the
forbidden pre-cutover names. Catalog declarations and mutations; Predicate,
ValueExpression, XPath, and Prose case-reference leaves;
field `caseWrite` destinations; case-operation writes; case-list column fields;
simple Search properties; and every SA/MCP projection use that exact schema.
A field's `caseWrite.property` uses it; its local `id` does not, so any survey
question may be named `name`. The forbidden names survive only as rejected
schema values and frozen migration inputs, never as a runtime lookup table or
canonicalizer.

The executable occurrence manifest inventories those property names in:

- case-type catalog declarations and every catalog XPath/template default;
- every Predicate, ValueExpression, XPath, and Prose case-property leaf;
- field `caseWrite` pairs and case-operation writes;
- case-list columns, Search inputs, filters, defaults, and case-search config;
- `cases.properties` JSON keys, parked case values, materialized case-type
  schemas, indexes, and generated SQL state;
- current entity/root rows, the new baseline, and the strict post-horizon
  suffix. Pre-horizon mutation bodies remain opaque audit bytes.

The frozen decision matrix is closed. An alternate catalog spelling may rename
to the canonical spelling only when the canonical entry is absent; if both are
present they coalesce only when every semantic byte is equal after replacing
the name, otherwise the cutover blocks. Typed read references rewrite
structurally and must preserve Preview, SQL, XForm, suite, and HQ projections.
A field/case-operation writer, case-row JSON key, or parked value using an
alternate spelling blocks because it may be real authored data and cannot be
guessed into a rename. After zero row/park ambiguity, schema and indexes rebuild
from the canonical Blueprint. The locked scan requires zero remaining alternate
tokens before live alias readers are deleted.
The final scalar SQL projection is explicit and one-way:
`case_name → cases.case_name`, `date_opened → cases.opened_on`,
`external_id → cases.external_id`, and
`last_modified → cases.modified_on`. `cases.properties`,
`parked_case_values.property`, and `case_type_schemas.schema` are executable
dispatcher occurrences with this admission/refusal behavior, not prose-only
inventory.
An explicitly declared standard entry may remain in the effective/materializable
catalog for authoring metadata and order, but every JSONB-producing storage
projection uses the complete scalar set: JSON Schema, expression-index intent,
and sample properties all omit it, while SQL and Preview read the first-class
column. The exact stored-schema decoder rejects any scalar key in
`case_type_schemas.schema`; steady-state producers cannot create one.

Persisted Blueprints and mutation-bearing app changes contain no incomplete
editor row.
Local UI drafts and tool-input assembly may be partial only in separate,
non-domain types; one complete discriminated value commits atomically:

- `Form.connect` is absent or a mode-compatible nonempty config. Every present
  learn-module, assessment, deliver-unit, or task id is required, valid, and
  unique app-wide across every mode-compatible Connect sub-block on every form,
  regardless of subkind. Each uses the shared XML-element-name and 50-character
  schema. The one app-wide authoring owner is the shared SA
  `configureConnect` / MCP `configure_connect` command. A `mode: null` target
  clears the app mode and every form block atomically. A `learn` or `deliver`
  target requires the complete nonempty UUID-addressed participant set, sets
  those exact mode-compatible blocks, and clears every unlisted or incompatible
  block in the same batch. Duplicate, foreign, wrong-mode, incomplete, or empty
  targets reject before mutation construction; omitted Connect ids derive
  exactly once, while explicit invalid or duplicate ids reject rather than
  being rewritten. `updateApp` / `update_app` is name-only. `updateForm` may
  refine one participant only after a mode exists and cannot change
  participation; a null sub-config is allowed only while another sub-config
  remains. `createForm` / `createModule` carry no Connect slot, so newly created
  forms are auxiliary until `configureConnect` replaces the complete set.
  `{}`, a stored `null`, missing ids, mode-only state, dormant or wrong-mode
  sub-blocks are not final schema arms. The frozen migration deletes stored
  `null` or `{}` only
  when it has no subconfig, default, or expression participation and absence
  produces identical Connect participation, reference-index, Preview, XForm,
  suite, HQ, summary, and machine-read projections. A wrong-mode member,
  missing/invalid id, duplicate under that app-wide scope, or projection
  difference is `block-current`.
- Search inputs form one exact discriminated union. A simple input has a
  nonempty canonical property. Date-range inputs own range mode and never a
  scalar default; scalar widgets cannot carry range state. Unit 18's shipped
  schema excludes simple `multi-select-contains` and the saved Search `select`
  arm. The locked scan requires zero current occurrences. Blank property,
  scalar date-range default, incoherent mode/widget, either excluded arm, wrong
  scope, or wrong type blocks migration; no reader or emitter drops the
  offending facet.
- ID/image mapping rows have nonempty whitespace-free values unique within the
  mapping. A blank new-row control is local component state and commits only a
  complete row. Empty, whitespace, or duplicate stored values block; none are
  inferred or silently deleted.
- Case-list column UUIDs and Search-input UUIDs join case-operation and inline
  option UUIDs in the global authored-identity namespace. Each list/detail
  order is an exact duplicate-free permutation of the column set.
  `orderedColumns` asserts an impossible mismatch instead of dropping or
  appending entries. Duplicate nested identities, foreign/duplicate order
  members, and missing members block migration.
- Every saved case-list column is valid unconditionally, including one hidden
  from both layouts and absent from sort. Admission, the gate, migration, and
  all three authoring surfaces retain and validate its complete definition.
  Only Preview, CommCare emission, and emitted-reference walks consult
  `caseListColumnIsEmitted`; revealing a hidden definition is an ordinary
  presentation edit and never a repair operation.
- Case operations use only the strict action-discriminated schema. `create`
  targets `new`, requires `name`, and forbids rename/retype; `update` targets
  an existing case, forbids `name`, and may own owner/rename/retype/writes/links;
  `close` targets an existing case and owns only allowed writes/conditions.
  `updateForm.caseOperationPatch.operation: "update"` carries the required
  `targetAction` and an exact patch for that arm; the reducer constructs and
  parses the whole prospective operation before install. The migration
  inventories every facet and final-parses the assembled document; an illegal
  combination blocks rather than losing facets.
- The private owner-only Search provenance value
  `searchActionEnabled: false` is legal only with `excludedOwnerIds`, no inputs,
  and no ordinary Search button/screen settings. Writers switch the complete
  config atomically. The malformed/imported-state fallback in
  `effectiveCaseSearchConfig` is deleted; a mixed stored config blocks.

All live expression APIs are final-AST-only. `expressionSource`,
`projectSlotValue`, Connect defaults, form links, and expanders do not accept or
pass through strings. A dangling typed identity produces a structured repair
state on a human surface and a hard failure at wire emission; it is never
omitted. Human XPath still prints and accepts friendly names such as
`#form/first_name`. The CommCare-private `#case` token may exist only inside a
generated wire/shadow projection where the wire requires it; Nova's parser,
stored AST, and Preview input do not accept it as an authored alias.

The frozen migration's `#case` matrix is contextual and structural; it is not
a live parser or authoring compatibility path. For an old stored followup or
close-form expression, `#case/<property>` rewrites once to the owning module
case type and leading `parent/` segments traverse only the exact declared
parent chain. An old stored registration expression permits only
`#case/case_id`, rewritten to the owning case type's typed `case_id` reference.
Survey forms, a missing module case type, broken ancestry, bare `#case`, extra
path segments, every other registration reference, and any catalog XPath
occurrence block migration. Reference-looking prose, including `#case/...`,
requires a closed digest-pinned literal/reference disposition and is never
regex-promoted. Text already stored inside a canonical `ProseTemplate` remains
literal. After migration, Nova's live parser, editor, validator, Preview, and
storage reject authored `#case/...`; HQ/Vellum output-only `#case` projection
stays emitter-private and is never reparsed into storage or Preview.

Every string found in an AST-only pre-cutover slot is `rewrite-current` only
when the frozen Lezer parser consumes the complete source, every reference
resolves uniquely in the owning form/module scope, the resulting final AST
prints and reparses identically, and Preview plus wire projection are proved
equivalent. The frozen migration-only `#case` rules above may change only the
old stored source projection; their emitted XPath remains byte-identical.
Syntax-invalid input, a dangling or ambiguous identity, an illegal form scope,
an unsupported `#case` shape, or printer drift is `block-current`. Prose text
remains literal unless the closed digest-pinned repair manifest explicitly
identifies a typed reference; no generic migration promotes reference-looking
prose.

Every user-visible prose projection has its owning document/provider. Builder,
Preview, SA summaries, TipTap, pickers, and case-list displays use the
document-aware projector or structural chips. A context-free diagnostic
projector, if retained, is confined to non-user logging/search indexing and
cannot substitute a UUID, path guess, or repair text for a resolvable
reference. The structured unresolved repair state is ephemeral UI state only
for unsaved local input or a stale projection following a peer edit; a persisted
Blueprint, baseline, or suffix may never contain one and fails strict
load/replay before exposure. Preview, SQL, summaries, and wire never omit or
substitute the reference. Wire uses the strict document-aware printer.

A case-list date column stores its concrete CommCare pattern, not a short/long/
ISO preset id interpreted at read time. The frozen column migration maps exactly
`short → "%m/%d/%Y"`, `long → "%B %e, %Y"`, and
`iso → "%Y-%m-%d"`. It imports neither the live preset table nor the runtime
resolver. Any other non-pattern preset-like value blocks. Semantic `format-date`
ValueExpression preset ids remain unchanged because they are their own final
expression vocabulary.

Current protocol frames also fail closed. A malformed current presence,
revocation, mutation-stream, or lookup-manifest frame never leaves stale state
presented as current. A presence failure clears and refetches only presence. A
revocation failure disowns the Blueprint and editor authorization state, then
reauthorizes and reloads before display or editing. A mutation-frame failure
disowns the stream and enters the serialized authoritative Blueprint reload
without advancing its cursor. A lookup-manifest failure clears the manifest,
lookup definitions/cache, and clock, then refetches the exact Project snapshot
before lookup-backed authoring or Preview. Every failure is observable and
installs no partial item.
Historical archived-mutation events remain opaque audit, but every current event
envelope and payload is strict and an ordered page parses all-or-nothing.

Reducer no-op/warn defenses for missing targets, anchors, or impossible
prospective shapes are unreachable internal assertions only. Canonical live
proposals and durable suffixes prove those conditions unreachable before the
reducer runs; target, kind, scope, action, and anchor checks all happen before
reduction. A missing or wrong-kind target can never turn an invalid proposal
into successful unchanged state. Source and behavior tests pin that every such
invalid proposal rejects at identity/sequence/full-document admission.

After the cutover every current document is canonical and fully valid. The
ordinary commit gate requires the complete candidate to have zero findings,
with no exception based on its prior state. The strict loader, genesis,
baseline fold, suffix replay, and migration final parse all establish that
premise. A timestamped pre-canonical repair may bypass the final commit path
only for its closed digest-pinned rows. Its repaired snapshot remains
pre-canonical input: the repair must derive the canonical migration candidate
and final-parse that derived candidate before commit, never apply the final gate
directly to the repaired pre-canonical snapshot. The
general `legacyFindingRepairs` writer and its write-capable script are deleted.
Any retained current-state diagnostic is renamed as an ordinary read-only
scanner and imports no repair mutation helper. Each historically malformed
off-kind field shape is either proved absent by the locked inventory or owned by
an exact digest-pinned frozen repair. Admission is never widened to keep that
script working.

`evaluateCommit` accepts the complete candidate plus the exact external lookup
snapshot; it takes no previous document and computes no error-identity diff.
Empty batches do not bypass validation.
`caseSearchPredicateEditVerdict` judges the complete candidate predicate.
Genesis and each fold baseline are full-validated before trust. A suffix page is
completely schema-parsed before any reduction, then every intermediate
candidate is full-validated under the same lookup snapshot; a middle-invalid,
final-valid sequence rejects. Hydration and reload validate before exposing the
document. Undo and redo are fresh proposals against current peer state and pass
the same absolute gate. Types, copy, and logs say `findings` or `errors`, never
`introduced`; source tripwires reject `diffIntroduced` and bypass
documentation.

`applyMutations` gives simultaneous case-property rename semantics only to the
explicit, batch-exclusive `renameCaseProperties` command. It validates the
complete lossless partial bijection against the batch-start Blueprint and
applies the relation once to every typed carrier. Ordinary `updateField`
patches never enter that path: `patch.id` is local form-path intent and
`patch.caseWrite` is local writer-retarget intent. History, undo, and replay
retain the admitted command and inverse directly. Generic
`diffDocsToMutations` never derives a rename from endpoint documents, a field
id, or a binding delta. It continues to emit granular local writer, operation,
catalog, and typed-reference edits with no row effect, but refuses a complete
carrier-wide rename-shaped endpoint pair without the exact command provenance.
Equality-only reconciliation compares canonical documents without asking
semantic diff to construct mutations.

The authoritative writer prepares exactly that admitted relation, re-proves it
against the locked Blueprint, every live case row, and every parked row
including dismissed entries. One physical Phase A transaction rewrites the
rows without stamping `modified_on`, regenerates `case_type_schemas`, and
persists the Blueprint plus its admitted app change/event. Every destination reads
the pre-migration row snapshot. Chains, swaps, and cycles expose no intermediate
document, row, or schema intent; any merge, storage-boundary crossing,
destination collision (including a present null/blank key), or need to
park/drop data aborts before either document or row changes. Physical
index creation and every remaining safe drop use the load-bearing post-commit
`CREATE/DROP INDEX CONCURRENTLY` Phase B; only the narrowly necessary unsafe
cast-bearing drops below occur transactionally before row movement. Phase B is
observable, retryable, and correctness-neutral, and is never falsely promised
as part of the database transaction or rolled back with the semantic rename.
The inverse relation is itself a valid partial bijection and is the sole undo
command. The inferred `provenRenamePairs`, cross-transaction
`renameExpectations`, Postgres-first rename compensation, and every
destination-wins/merge/park branch are deleted rather than retained beside this
authority.

Rename schema work has a dedicated Phase A path; it never calls the generic
same-name schema-transition engine. Each declaration's complete metadata
follows its source identity through the simultaneous relation, so heterogeneous
chains, swaps, and cycles do not look like retypes, reshapes, widenings,
restores, or new parks. Existing parked rows move with every reason/type/value/
dismissal/timestamp byte intact. Before rewriting live rows, Phase A
transactionally drops only affected cast-bearing expression indexes whose old
expression cannot evaluate the values moving into that name (for example an
old integer cast receiving text); this narrow correctness-bearing drop is the
only physical-index work allowed in Phase A. Phase B uses concurrent DDL to
converge every desired create and remaining safe drop from the final schema.

Phase A also records durable pending index convergence keyed by
`(appId, caseType)` and the committed schema sequence. The immediate
post-commit completion, an idempotent same-batch dedup retry, every case-store
point of use, the run-end materializer, and the deployment drain all call the
same convergence owner; a newer sequence cannot be marked complete by an older
attempt. Phase A's transactional schema write and Phase B's out-of-transaction
DDL share one sorted per-`(appId, caseType)` lock authority; Phase B holds its
session lock on one dedicated connection, then reads the latest committed
schema/sequence and derives the desired indexes at execution time. It never
uses a captured rename-candidate index set: a delayed sequence N completion
therefore converges sequence N+1's current state instead of dropping N+1's
index. Successful concurrent-DDL completion clears/advances the marker only
for that latest observed sequence. A Phase B failure is logged and leaves the
marker pending but does not turn the already-committed semantic mutation into a
failed response; the next mandatory drain retries until the actual catalog
matches. Thus idempotency does not short-circuit recovery and missing/invalid
physical indexes cannot become permanent hidden drift.

The optimistic store preserves admitted dispatch boundaries as an ordered queue
of batches. It never combines batches across an exclusive command. On one
autosave pass, predecessors, the rename, and successors may all be prepared,
but each becomes a distinct sent batch and PUT with its own batch id; the
single-flight sender preserves order and retry/ack addresses the original
segment. A peer rebase folds queued segments sequentially over the fresh
confirmed base. A now-refused rename/inverse is never partially reduced or
merged with a neighbor: its exact segment reaches the authoritative conflict
path. Because every later local segment was authored against the optimistic
state produced by its predecessors, any authoritative segment rejection
invalidates that segment and the entire later unacknowledged human suffix; no
successor is replayed or reinterpreted as an independent retarget. The
serialized reload atomically
discards that causal suffix, clears its undo/redo entries and command queue,
loads the authoritative document, and tells the author that those edits must be
redone. It never stores the suffix as a draft or silently sends part of it.
Rename followed by an edit, edit followed by rename, rename followed by undo
before save, peer rebase, retry, ack, and conflict all preserve these
boundaries and suffix semantics.

The current app-read transport has one exact response:
`{ projectId, role, canEdit, blueprint, baseSeq }`. The old row-shaped
`app_name`, `status`, `error_type`, and `mutation_seq` response aliases are
deleted, and the client parser rejects unknown keys. The maintenance cutover
disowns and reloads open clients, so an old browser revision does not justify a
second server response dialect.

Builder route parsing likewise accepts one authoring vocabulary:
`results`, `search`, and `details`. The retired two-segment `cases`,
`search-config`, and `detail-config` tokens neither parse nor redirect.
`cases/<caseId>` remains the distinct canonical record deep link. Old bookmarks
may stop resolving under this direct cutover; runtime normalization is not
retained for them.

Post-submit navigation stores and machine-authors only `app_home`, `module`, or
`previous`. The frozen migration rewrites `root` to `app_home` only after exact
Preview/suite/HQ equivalence. It requires zero `parent_module` occurrences
because nested modules do not exist; a finding blocks. `lib/commcare` owns any
different workflow spelling as one-way output vocabulary. A future nested-module
unit introduces its final semantic then, not as a dormant value now.

Unit 18 does not remove the shipped lookup source or table-expression
vocabulary. Unit 18 and Unit 2 reach production in one final cutover image in
which `optionsSource.lookup`, `table-column`, and `table-lookup` have their
complete builder, SA/MCP, Preview, SQL, and wire behavior. Existing occurrences
are migrated through the frozen dispatcher rather than required to be zero.
Review may remain split across branches, but no lookup-removing, read-only, or
dormant intermediate revision is merged or deployed. `unwrap-list` is excluded
from Unit 18's final stored schema and the locked scan requires zero current
occurrences; a later unit may add it only with its complete authoring and
consumer behavior.

The generated expression-authorability matrix enumerates every Predicate and
ValueExpression leaf with:
`{ stored, builderCreate, builderEdit, saMcpWrite, previewConsumer, wireConsumer }`.
A stored leaf must have at least one complete final edit surface and every
required consumer; there is no `roundTripOnly` registry state.
`id-of` is contextually authorable only from a case-operation value surface
where its create precedes the consumer. `acting-user` and `unowned` are
contextually authorable only on their owner-target surfaces. `is-null` is
removed from Unit 18's stored schema and the locked scan requires zero current
occurrences because no complete portable authoring surface owns it. The joint
Unit 2 cutover owns the table leaves; `unwrap-list` is absent.
An “imported,” disallowed-but-preserved, missing-target-preserved, or dormant
compatibility arm is forbidden.

Creation has no construction-local handle dialect. Any newly created object that
another item in the same call references predeclares its stable UUID through the
applicable `moduleUuid`, `formUuid`, `fieldUuid`, `optionUuid`, `columnUuid`,
`searchInputUuid`, or `operationUuid` slot. Topology parents use `parentUuid` and
must have been declared earlier in the call. XPath, prose, Predicate,
ValueExpression, Connect, close-condition, operation, and Search-input
references resolve against the complete final overlay, so expression forward
references are legal once their target UUID is predeclared **only when the
reference does not depend on a later runtime effect**. Identity overlay
resolution never relaxes execution order: `id-of`, and any later expression
whose value depends on another operation's result, must target an earlier
create in the canonical operation sequence. A later producer rejects the whole
call even though its UUID is known. There is no `parentId`, bare close-condition
field id, operation id address, second string-to-AST pass, or mutable semantic
id used as a target. Wrong-kind, duplicate, colliding, cross-form/module,
undeclared, non-container parent, and effect-order-invalid UUIDs reject the
entire call. Unreferenced objects may omit their UUID and let Nova mint it.
Creation results return every created identity structurally.

Case-property catalog `required` and `validation` defaults are canonical XPath
ASTs. Catalog `label`, `hint`, `validation_msg`, and `options[].label` are
templates. Their context forbids form-field and Search-input references; a
field-specific override owns those. Omission keeps an existing slot,
update-time `null` clears it, create-time `null` becomes absence, and an empty
AST/template is an authored empty value rather than a clear.

The timestamped migration freezes the Lezer grammar, generated parser, pre-cutover
reference classifier, and canonical printer that convert a catalog's existing
XPath string exactly once. The enclosing catalog case type is its only case
context. An allowed case reference must resolve unambiguously and the resulting
AST must print to the same source bytes and reparse identically. Form-field,
absolute-form, Search-input, syntax-invalid, ambiguous, or printer-drifting
catalog input blocks the cutover and requires a reviewed clear or canonical
replacement; the migration never coerces an illegal reference into literal
text. Regex may not parse or classify a migration XPath.

Select source mode is one required discriminated `optionsSource`, never parallel
state. `inline` owns at least two `SelectOption` records; `lookup` owns its
complete table/column/filter references and no dormant inline body. The frozen
migration moves ordinary options into `inline` and existing lookup overrides
into `lookup`. Unit 18 and Unit 2 ship those final arms together, so every read
projection, builder, SA/MCP schema, Preview evaluator, and wire emitter follows
the same discriminator and never reads the removed parallel `field.options`
shape.

Inline select-option UUIDs are required. The migration preserves every
already-canonical option UUID. It recognizes exactly the closed historical
position-derived pseudo-identity `${fieldUuid}-opt-${historicalIndex}` and
replaces it through a frozen genuine RFC UUIDv5 mapping: a checked-in namespace
plus that complete pre-cutover string as the name. The mapping is one-shot migration
projection, not an alias, runtime fallback, or general reminting policy. Missing,
stale-index, or any other noncanonical option identity blocks. Before writing,
the migration proves that every source and target is unique and that no target
collides with any authored identity. Every inline creation, conversion, diff,
media attachment, and reconciliation path then produces complete random UUID
identities; every read-time and non-UUID fallback is deleted.

One frozen pre-cutover/final-schema occurrence manifest makes the cutover total
and is shared byte-for-byte by the advisory scanner, topology forensics, locked
scan, rehearsal, and migration. Every recognized occurrence has exactly one
disposition: `rewrite-current`, `block-current`, `archive-exact`,
`opaque-pre-horizon`, `delete-operational`, `preserve-exact`, or `DDL`.
`block-current` is a first-class finding with a stable carrier id, structural
path, count, and content digest; the advisory scan and rehearsal may report it,
while the locked scan requires its count to be zero. An occurrence missing from
the manifest is a separate manifest-totality failure, never the mechanism for a
known invalid shape.

The manifest is executable rather than descriptive: one frozen dispatcher
selected by each disposition produces the same findings, rewrite plan,
source/result digests, and capacity evidence for advisory scan, repair
rehearsal, locked scan, and migration. No path may hand-code a carrier outside
that dispatcher. The Blueprint portion enumerates root scalars,
`apps.case_types`, `apps.logo`, every entity and nested identity, every Connect
arm and id, Search-input arm and facet, ID/image mapping row, case-list column
and both exact order permutations, case-operation facet, owner-only Search
provenance field, post-submit destination, case-list date pattern, and every
Predicate, ValueExpression, XPath, Prose, form-link, Connect-default, and
expander carrier. It also enumerates every final `mutationSchema` arm; lookup
edges and every `lookup_rows.values` key; form-intent/attachment references;
thread attachment metadata; and the standard-property carriers in
`cases.properties`, `parked_case_values`, `case_type_schemas`, generated
indexes, and SQL scalar projections.

Every `events.event` row is classified: existing mutation events are
`archive-exact`; every non-mutation envelope and payload must final-parse
exactly or is `block-current`. Presence and `chat_stream_chunks` are
`delete-operational`. The exact SQL columns, including final `app_changes` and
`app_change_fold_baselines` DDL and snapshots, are manifest occurrences.
Every frozen whole-row capture reads PostgreSQL's canonical JSON text through
the one lossless parser: integer and decimal lexemes never pass through a
JavaScript `number`, and prototype-shaped JSON keys remain ordinary own keys.
The dispatcher, Project-orphan closure, and complete-table scanner digests all
use that same projection, so values beyond `2^53` cannot alias during
classification or preservation proofs.
One timestamp-owned `CutoverPlan` is the evidence authority above that
dispatcher. Advisory scan, locked scan, repair rehearsal/apply, and migration
materialize the same content-free shape from their one transaction: every app's
source/canonical digest and disposition; PostgreSQL-owned raw carrier rows,
bytes, and length-framed digest; the complete app lease/reservation projection
and every thread/chunk/presence holder; exact Project lookup contexts;
per-app and complete reverse-index/schema evidence; baseline, dependency,
relation/index ACL, and function catalogs; findings; and reviewed
app/entity/source/rewrite/WAL capacity. Raw evidence is
`to_jsonb(row)::text`, byte-ordered with `convert_to(..., 'UTF8')`; it is never
locale-sorted or regenerated from parsed JavaScript. Exact decimal strings and
`BigInt` own all counts and byte arithmetic. The locked scan, repair, and
migration use the same `SHARE ROW EXCLUSIVE` relation inventory and the same
15-second lock, 960-second statement, and 990-second idle-transaction
timeouts. The plan classifies only exact `pristine`, `applied`, `mixed`, or
`drift` states; mixed/drift and any reviewed-capacity overflow stop before a
write.
`form_submission_intents.result.operations[].operationUuid` is an authored
identity even though the intent and entry ids are opaque. Scanner, migrator,
runtime reference index, event parser, mutation coverage, and ephemeral-carrier
cleanup are parity-tested against that manifest. The immutable migration owns
frozen pre-cutover schemas, inventory, parser/printer behavior, and the
option-identity algorithm. One deterministic off-repository builder captures
the settled final persisted schema/hydrator, absolute commit gate, production
lookup-reference extractors, canonical mutation schema/reducer, and strict
suffix replayer into a digest-pinned, self-contained generated artifact. The
timestamp tree imports no mutable live semantic module. Scanner, repair, and
migration obtain the exact Project lookup definitions in their already-owned
transaction and pass that required context to the artifact; transformed
candidates, fold baselines, and every suffix intermediate run through the full
frozen gate under that one context. Applied-state auditing calls the bundled
suffix replayer directly: production exposes no optional or injected replay
authority. Fixed unsafe-integer, admitted decimal/subnormal, lookup
table/column/type, and middle-invalid/final-valid vectors plus a recursive
timestamp-tree import-graph tripwire pin the artifact and its authority.
The final lookup-row schema validates each `values` key as an already-canonical
`LookupColumnId` belonging to that table; writers obtain keys from stored column
identities, and the current lowercase-transform parser is deleted.

The cutover deletes the dual mutation dialect. `mutationSchema` becomes the one
canonical schema used by builder/SA/MCP inputs, commits, accepted rows, events,
streams, diffs, undo, and replay; `canonicalMutationSchema`, the carrier-blind
family, and their rolling-compatibility matrix disappear rather than survive as
aliases. Origin/pre-deploy whole-object fallbacks and top-level rehydration
extensions are removed from every builder and reducer. Legitimate fine-grained
merge units — operation scalar/write/link patches, Search-setting patches,
user-data value patches, column sort/visibility/tile placement, and similar
semantic edits — remain only as their single final payload, never beside a
duplicate body for an older reducer. The new horizon and strict reload make
that old-client dialect both unnecessary and forbidden. `lib/doc/CLAUDE.md` and
the built-behavior index are rewritten to describe only the final shape.
`setCaseTypes` and every other whole-catalog seeding/replay mutation are absent
from the post-horizon schema, reducer, commit guard, hooks, and mutation-family
inventory; catalog creation and edits use only the granular final mutations.
Case-operation write/link additions carry a logical predecessor
property/identifier (`null` for first, omitted for append), not a captured array
index. Applying a batch after a peer insertion preserves that logical relation
or rejects a missing predecessor.

The canonical schema is also the live mutation-wire oracle. Exactness means the
parsed JSON value defined above, semantic JSONB equality in storage, and, where
a frozen persistence proof needs a deterministic textual oracle, identical
canonical `jsonb::text`. It never means unavailable request whitespace or
object-key order. TypeScript assignability, an in-memory reducer result, a
stringified source-byte comparison, or a schema parse that silently strips an
`undefined`/unknown key is not admission.

One generated inventory covers every mutation arm that inserts or moves a
member in any Blueprint sequence, including nested, flat, case-list,
Search-input, case-operation, write, and link collections. Each arm either
declares append intentionally or carries a logical UUID/semantic-key neighbor.
The authoritative commit guard simulates same-batch membership and rejects a
missing or wrong-collection neighbor before reduction; reducers never turn a
declared missing anchor into append. Replay fixtures prove every accepted suffix
is independent of stale snapshot indices and fallback append behavior.

Historical conversation text and the opaque input/output receipts inside thread
tool parts and conversation events are audit bytes, not authoring references:
runtime never dereferences them or passes a schema-invalid historical tool part
back through a current tool boundary. Current attachments remain typed and are
migrated. Existing mutation events cannot be soundly resolved against later
document state because the supplemental fire-and-forget log has no exact
reconstruction baseline. The migration therefore converts each to a permanent
`archived-mutation` event arm that preserves the original nested JSONB value as
non-dereferenced audit data. PostgreSQL has already discarded original input
whitespace and key order, so preservation means semantic JSONB equality plus an
identical canonical `jsonb::text` projection of that nested value before and
after archival, never a claim about unavailable source bytes. Admin inspect
renders it explicitly as historical audit and no reducer, validator, model
message, or tool boundary may consume it. Only post-cutover `mutation` events
carry the strict final `Mutation`. `eventSchema` must read both final arms
without silently dropping either; this is a final audit type, not a
compatibility parser.

This cutover establishes the final permanent app-change model. `app_changes`
has exactly six kinds: `autosave`, `mcp`, `chat`, `blueprint-migration`,
`fold-baseline`, and `project-move`. The first four require a nonempty canonical
mutation batch and null Project-move columns. `fold-baseline` requires exactly
`[]`, null Project-move columns, and one matching immutable
`app_change_fold_baselines` row. `project-move` requires distinct nonblank
`from_project_id` and `to_project_id` and carries either `[]` or the nonempty
media-remap batch. Runtime may insert and select but never update or delete
either append-only table.

Every baseline stores the complete canonical `PersistableDoc`, lowercase
SHA-256 digest of PostgreSQL's canonical `snapshot::text`, and the app's Project
at that sequence. The baseline and exact app-change rows are part of
backup/restore, DDL, ACL, storage-capacity, and occurrence-manifest accounting.

Canonical folding starts from the greatest baseline and its Project, strictly
parses and applies every subsequent mutation-bearing row, applies each Project
move only when its source matches the rolling Project, and must finish at the
exact current scalar/entity state and `apps.project_id`. Historical
intermediate documents are reduced strictly, but lookup admission runs once on
the final folded document against the final Project's current definition
snapshot. Direct or delayed baselines, cross-app snapshots, digest mismatches,
discontinuous moves, and change-only commits reject. The final catalog audit
covers each logged heap relation, RLS/replica state,
columns/defaults/nullability, PK/FK/check/index, triggers, and every routine's
exact signature and privilege state.

The browser change frame is deliberately closed to `autosave | mcp | chat`.
The server validates a complete durable suffix before emitting any frame. If it
contains `blueprint-migration`, `fold-baseline`, or `project-move`, it emits no
ordinary mutation from that suffix, freshly reauthorizes, and sends one
sequence-less reload. The client parses that narrower frame again and never
learns a server-only kind.

Every app birth establishes genesis atomically with its app/entity rows. There
is one mandatory canonical birth shape: a real nonblank name (`Untitled` for an
omitted or whitespace-only input), one caseless survey module, one survey form,
and one text question. `createApp` builds and admits that construction batch
once, evaluates the absolute verdict and export readiness under the locked
Project lookup-definition snapshot, then writes the root, entities, exact
lookup/media projections, `apps.mutation_seq = 1`, one Project-bearing
sequence-one baseline, and one empty attributed `fold-baseline` app change in
the same transaction. Construction mutations never become a second replay
dialect. The typed receipt is
`{ appId, projectId, role, canEdit, baseSeq: 1, blueprint, starter: { moduleUuid, formUuid, fieldUuid } }`;
chat, MCP, and the from-scratch builder consume it directly and never persist or
reconstruct an empty app.

Scanner, backup, restore, direct-run migration idempotence, fresh-database,
receipt/identity, late-failure rollback, multi-baseline, Project-continuity,
final-lookup-context, and reload-boundary tests cover both migrated and newly
created apps.

A committed read-only scanner runs against one repeatable-read production
snapshot before migration. This advisory result is capacity and finding
evidence, not a frozen-data precondition: ordinary writes may continue until
the later maintenance drain. It emits counts, digests, structural
app/entity/sequence paths, byte volume, and estimated WAL/lock work only — never
app names, labels, prose, values, attachment names, extracts, tool inputs,
outputs, or chat text. It inventories:

- raw `apps` scalars and entity rows: keys, parents, embedded UUIDs, exact
  reachability/membership closure, cycles, wrong-kind or missing parents,
  stray/duplicate sequence entries, key equality, collisions, all nested
  references, option identities, `apps.project_id`, `apps.case_types`,
  `apps.logo`, lookup UUIDv7 values and edges, and every
  `lookup_rows.values` JSON object key checked against its table's exact
  canonical column UUID;
- every Connect arm and id, Search-input arm and facet, ID/image mapping row,
  case-list column and both exact order permutations, case-operation facet,
  owner-only Search provenance field, post-submit destination, case-list date
  pattern, and every Predicate, ValueExpression, XPath, Prose, form-link,
  Connect-default, and expander carrier; plus every standard-property carrier
  in `cases.properties`, `parked_case_values`, `case_type_schemas`, generated
  indexes, and SQL scalar projections;
- every XPath/template/Predicate carrier in current snapshots and the active
  post-horizon suffix, including the named catalog defaults, hidden references,
  unresolved/raw parts, Search-input-name leaves, and reference-looking pre-cutover
  prose strings that require an explicit literal-text or typed-reference
  disposition rather than inference;
- every `events.event` row: existing mutation payloads are counted for exact
  archival rather than guessed into current identity; every non-mutation
  envelope and payload is final-parsed and reported as `block-current` if it is
  not exact; raw tool-call/result receipts are counted by shape and byte volume
  but never printed;
- all authored Blueprint media carriers, including dormant case-list/icon/audio/
  image-map definitions, library rows, aliases, exact composite
  `media_asset_refs(project_id, app_id, asset_id)`, strict canonical
  `threads.messages[*].metadata.attachments[*]`, form intents including
  result-operation UUIDs, and form attachments. Event attachment UUIDs are
  immutable audit receipts: they are never dereferenced, remapped, copied,
  indexed, or deletion blockers;
- every `chat_stream_chunks` row and stream terminal status plus every
  `threads.active_stream_id`, `threads.active_holder_nonce`, and complete app
  lease/reservation state — `status`, `awaiting_input`, `run_id`, every `res_*`
  and `lock_*` column, `run_holder_nonce`, and relevant timestamps — plus every
  presence row, without reading chunk or location content into the report;
- exact row/byte counts, rewrite counts, complete named `pg_catalog`
  definitions for every dependent constraint/index/trigger, planned before and
  after byte volume, the larger transactional/WAL capacity bound, and the latest
  fold horizon for each app. The tenancy inventory separately requires
  nonblank, non-null app and case Projects; every app Project must resolve to an
  `auth_organization`, and every case `(project_id, app_id)` must match its app.

The frozen plan resolves every typed reference against an app-scoped,
kind-aware ownership index rather than accepting UUID syntax as identity proof.
Uploaded-media carriers additionally resolve to a ready asset in the app's
Project and the allowed slot; lookup carriers resolve to the exact Project table
and column. The migration recomputes the lookup edge projections and the exact
whole-app media projection from all authored Blueprint references plus canonical
thread attachments and requires exact equality. The final media catalog has no
completion marker, fallback scan, post-commit synchronization path, or
historical event edge. Its DDL drops `media_reference_index_state`, gives
`media_asset_refs` the composite primary key
`(project_id, app_id, asset_id)`, enforces Project/app and Project/asset
foreign keys, and indexes `(project_id, asset_id, app_id)` for deletion
candidates. Existing canonical AST/template arms receive the
same contextual checks as migrated text. A locked zero-finding scan is therefore
the same admissibility result as the migration, including quiescence, schema,
capacity, event envelope/family, attachment, intent, and holder gates.
Quiescence uses a frozen equivalent of `runLeaseState` over that complete row,
requires zero `present` holders including paused, expired, corrupt, or
nonce-incomplete holders, and gives every settled/reaped reservation remnant an
explicit allowed or blocking disposition. It never substitutes a narrower
“currently live” test.

The frozen repair manifest owns the 42 null-parent field-row deletions, two
exact property projections, the fixed label repair recipe, two catalog clears,
and exactly thirteen thread attachment metadata-object removals: eleven name a
missing asset and two name an asset in another Project. Every source/result
thread digest and object coordinate is pinned. After repair those affected
threads carry zero live attachment references; the one valid authored
Blueprint media edge remains in the exact whole-app projection. The
inaccessible Project orphan is a separate exact deletion closure with its own
full dependent inventory. This is not a reusable repair language or an
alternate runtime branch. All 42 field rows are independent roots. They contain
27 case-property
writers for 13 `(caseType, property)` pairs, 21 raw references and ten option
identities, with zero inbound typed UUID references from reachable rows and no
lookup or media carrier. The complete consumer audit proves that none is
reachable by XForm, suite, Preview, or summary. Two of the 13 properties are
undeclared, orphan-only properties on already-declared case types; before
deletion the manifest appends exactly those two current effective property
projections to their catalogs with their current property name and generated
plain-text label, no manufactured `data_type`, and no other default. It then
deletes all 42 roots and their nested content in the same transaction. The
other 11 writer pairs need no catalog edit. The source rows, two projections,
and result are pinned by full digests, and any locked-scan drift blocks rather
than replanning or inferring an owner.

That closed repair preserves the complete effective property set and each
property's metadata, makes `materializableCaseTypes` byte-for-byte identical,
and preserves the case-store schema/index projection, XForm, suite, Preview,
summary, case rows, and case values. Full `effectiveCaseTypes` array JSON is
expected to differ only in the two repaired apps: those two properties move
from the writer-derived segment after injected standard properties into the
declared-property segment before them. This one catalog/picker ordering
normalization is asserted exactly; retaining the ghost-derived position would
require permanent provenance or compatibility state and is forbidden. The
reviewed repair writer appends attributed `blueprint-migration` and
`fold-baseline` app changes and proves the
resulting document and reverse indexes; it creates no quarantine table, alias,
second reader, orphan sentinel, or compatibility shape. Orphan option and raw
reference counts remain separate from reachable occurrences that the canonical
transform will rewrite. The authoritative locked scan must report zero
topology, illegal catalog-expression, and unresolved-reference findings before
the canonical transform may start.
The timestamp-owned
`frozenDatabaseRepair.ts::applyCanonicalIdentityFoundationRepairInTransaction`
is the only repair SQL authority. It accepts an externally owned transaction
after the caller has locked every app in canonical order and accepts only the
frozen,
digest-pinned row repair plan. This pre-canonical authority deliberately does
not route the pre-cutover snapshot through the final `PersistableDoc` commit
path. It owns only the exact `apps.case_types`, named entity-row update/delete,
app-change/sequence, notification, and exact projection proof operations;
compares the exact app sequence, source rows, and replacement digests; and
returns proof output without committing. It is not a reusable raw-update API.
The operator script contains no direct `apps` or history DML. Dry-run and apply
invoke this identical authority: rehearsal executes the real writer and every
behavior oracle against PostgreSQL, then rolls the transaction back; apply
commits only after those same proofs pass for all apps. A late injected proof
failure must roll back the exact 42 deletions, two projections, five typed label
references plus one cleared token, two catalog clears, repair app changes,
exact projections, and every artifact/byte digest. The authority requires the same
complete app-lease/thread/session quiescence proof as the migration.
Its dedicated raw delta comparator permits only those named rows and proves
every other complete PostgreSQL row text equal, including every byte of every
`lookup_rows` row. Candidate snapshots are derived first and pass the complete
frozen decoder/gate under their exact Project lookup contexts; the writer never
validates or persists a merely repaired intermediate. Rerunning against the
applied state is a no-write audit: the Project orphan must be physically absent,
every exact attributed repair baseline must equal its affected app head, each
pre-horizon sequence reconstruction must match the manifest result digest, and
the current app set must pass the same complete decoder and behavior oracles.
Anything partial is `mixed` or `drift`, not an idempotent success.

The expression-repair manifest is closed to the three reachable live defects
identified by the advisory scan; it is not a reusable repair language. In one
252-byte field label, five distinct form tokens each have one exact same-form
full-path target and become typed field-reference parts. A sixth token has no
exact target or durable lineage evidence; the one same-leaf nested candidate is
not identity proof. The manifest clears that one token occurrence while
preserving every other byte and part. The dangling lookup currently evaluates
to the empty string, so this keeps Preview/device rendering identical for every
form state while removing the invalid output from wire. The source label,
occurrence, and replacement AST are pinned by full digests. Its replacement
recipe is six exact zero-based UTF-8 byte spans, each with its own source digest:
five spans name their already-proven field UUID atom and one names `null`.
Literal gaps are copied byte-for-byte. There is no regex token search, path
resolution, leaf-name lookup, or runtime target inference. Separately, two
case-catalog `validation` slots hold the same 36-byte expression containing a
single form token. It has no exact target in any owning form, and each reachable
writer already owns a different field-specific validation. The manifest clears
exactly those two digest-pinned catalog slots: existing Preview, emitted forms,
case properties, inferred types, schemas/indexes, rows, and operations remain
unchanged, while future fields no longer inherit an invalid contextless
default. It never literalizes an XPath, invents a replacement, or retargets the
one same-leaf candidate.

The Project-tenancy repair manifest is closed to the one production test orphan
approved for deletion on 2026-07-29. The advisory scan found 428 apps: 427 have
nonblank Projects that resolve to existing Better Auth Projects, and exactly
one live `project_id IS NULL` row has an empty owner with no auth principal,
membership, or deterministic Project candidate. That orphan has no
module/form/field entity, case or parked value, thread/run/event/presence/chunk,
media or lookup reference, form attachment, or capture intent; it has exactly
one empty pre-cutover change row plus its case catalog and one materialized case-type
schema. There is no honest tenant assignment. Under the maintenance lock and
post-quiescence backup, the repair matches a full digest of the app scalar,
catalog, exact empty horizon, schema row, and the complete zero/one dependent
inventory before physically deleting only that app and its exact dependent
rows. Any changed byte, holder, added dependency, second null/blank app, or
alternate null row blocks and rolls back the all-app repair. It never mints an
orphan Project, infers from owner, exposes a reusable delete script, or leaves a
quarantine/runtime reader. Zero matching rows is the idempotent already-repaired
state; any nonzero unmatched set is `block-current`.

For identity/reference conversion, the only `rewrite-current` cases are typed
reference projection, parser-proven AST-only strings under the contextual
`#case` matrix, parser-proven catalog XPath, and the exact pre-cutover option
UUIDv5 mapping. The separately specified standard-property, final-shape
Blueprint, date, post-submit, event, and operational dispositions remain
governed by their own frozen dispatcher entries. Every other current occurrence
is `block-current`. A missing/stale/other option identity, mismatched key,
collision, topology failure, noncanonical current identity, stale/illegal
built-in, ambiguous or unresolved reference, noncanonical pre-cutover absolute
path, or post-horizon replay mismatch blocks the cutover. There is no
lowercasing, general remint, alias, slug/path inference, or best-effort repair.

The checked-in deployment path is permanent infrastructure, not a
cutover-only branch or flag. At the start of every deploy it records the
service's exact revision set and scaling mode and accepts only one of two
prestates: ordinary automatic scaling, or maintenance-owned manual scaling with
exactly zero instances. `gcloud run deploy` never passes `--scaling=auto`, so it
preserves that prestate while moving 100% traffic to the candidate. The script
then proves that the scaling mode did not change, the expected immutable digest
is Ready and owns 100% traffic, and every old revision owns 0% with no tag.
Finally it always performs the same separate service-level
`--scaling=auto` update and proves that it added no revision. At both the deploy
and scaling checks the candidate must be added and retained, no unexpected
revision may appear, and the only permitted removals are pre-existing untagged
zero-traffic revisions garbage-collected by Cloud Run. On an
ordinary later build the service began automatic, remained automatic, and that
last update is an idempotent no-op; on this maintenance cutover it began
manual-zero and only this step resumes instances, after the exact candidate is
the sole traffic owner. A deployment may not silently translate any other
scaling state.

The deploy verifier consumes production-shaped Cloud Run v2 responses. A
`LATEST` traffic target resolves through `latestReadyRevision`; explicit
revision names are normalized; desired and observed traffic are checked
separately; tags are forbidden; and the result is exactly candidate 100% with
every other live target at 0%. Revision retention may remove an old zero-traffic
revision under that same subset rule, but exactly one candidate is new and no
unexpected live target may appear. Image identity is the complete immutable
`repository@sha256:<digest>` value, never a comparison between a bare digest and
a full reference. Cloud Build resolves that immutable reference immediately
after push and uses it for the policy, migration, cleanup, and service
deployments; no destructive Job executes a mutable build tag. Before each
shared Job execution, the permanent helper proves one reconciled
generation/observed-generation and sole exact image, submits `jobs:run` with
that Job's `etag`, then proves the immutable Execution snapshot and every task
succeeded. An overlapping build therefore produces a generation conflict
instead of executing another build's image.

The permanent deployment path has a success latch and a guaranteed maintenance
recovery arm. Any failure after the canonical migration or after automatic
scaling resumes detaches the NEG if attached, restores and verifies manual-zero,
terminates runtime sessions, keeps cleanup paused, and preserves the original
failure. Every recovery action is attempted and its error retained even if an
earlier action fails. Scheduler state is recorded, restored by a trap on failure, and
rechecked after the cleanup probe; the maintenance execution requires the
pre-existing scheduler to remain `PAUSED`; Cloud Build proves that posture
before the first storage/database Job and again before updating cleanup.

Cloud Build's sequential steps are not the recovery owner. One operator-local
cutover orchestrator with its content-free action/evidence ledger stored as a
generation-matched object in a versioned operator bucket remains armed from the
pre-merge fence through public probes, the digest-bound audit scan and log gate,
final scheduler/configuration verification, and one successful cleanup
execution. A separately supervised watchdog reads that ledger, treats
orchestrator loss or stale heartbeat as failure, and applies
the same NEG-detach/manual-zero/session-termination/cleanup-paused arm. The
orchestrator disarms only after one explicit terminal-success latch; reattaching
the NEG is not success. The destructive migration Job has zero automatic task
retries. Any retry is a new orchestrator-controlled execution that first
reproves manual-zero, detached ingress, paused cleanup, exact ACL, complete
holder/session quiescence, and exact target image/configuration.

Production uses the binding maintenance-cutover procedure, not an ordinary
unattended merge:

1. Freeze the reviewed commit and complete the advisory scan plus a migration
   rehearsal against a restored production snapshot. Prove the rewrite, locks,
   UUID DDL, WAL growth, and full migration fit the Cloud Run migration job's
   1,020-second timeout; otherwise change and review that bound before cutover.
   On a production-shaped scratch service, also rehearse the exact serving
   control-plane sequence that the checked-in deploy implements: no traffic
   tags, manual-zero service scaling, candidate deployment with its default
   health check and database-backed startup probe while automatic scaling stays
   off, exact-digest Ready/100% assertions with every old revision stopped, then
   a separate scaling-only update to automatic that creates no revision.
2. Verify Cloud SQL PITR as secondary disaster-recovery evidence and a completed
   pre-drain on-demand backup for rehearsal. Record the exact serving
   revision/image; migration, media-policy, and capture-cleanup Job
   images, complete configurations, generations, and IAM policies; the
   scheduler's state, schedule, URI, auth, headers, and IAM policy; main-trigger
   state/IAM; and migration ledger. Neither PITR nor this backup is the
   authoritative cutover restore
   point: PITR creates a new instance and can lag the database clock, while
   legitimate requests may still commit after the pre-drain backup. An existing
   scratch target must have rehearsed restoring a production backup over itself,
   strict startup, and the complete old-workload rollback procedure. Freeze the
   resulting backup id, exported service manifest and hash, service IAM policy
   and hash, scaling/traffic/revision/image state, NEG target, and ACL evidence
   as cutover inputs.
3. Pause `commcare-nova-capture-cleanup`, detach the `nova-neg` serverless NEG
   from `nova-backend`, remove every Cloud Run revision traffic tag, and keep
   the three public hosts closed. Wait the full 3,600-second request bound, wait
   every cleanup execution through its 1,260-second bound, and prove no
   application request or runtime/cleanup write transaction remains. Only then
   set the service to manual scaling with exactly zero instances; this disables
   the service without creating a revision and prevents the old min-instance
   and its persistent LISTEN reconnect loop from starting again. Prove the
   control plane reports manual-zero scaling, no instance remains, and no
   tag-only revision exists. This drains chat, MCP, autosave, project moves,
   operator scripts, and capture cleanup without adding an application flag or
   traffic controller. Record the database ACL and effective-login inventory,
   ensure the migration owner has an explicit `CONNECT`, revoke `CONNECT` from
   `PUBLIC` and every non-migration login with effective application write
   authority, and terminate every non-migration session. A catalog query must
   then prove that no such session or inherited write path remains. Hold the
   service at manual zero and the database ACL fence through a stabilization
   interval, then prove again that no runtime session or reconnect appears.
   Repeat that proof after the role grants in step 5 while every old revision
   remains stopped. Operator use of the migration identity is frozen by the
   runbook. Before entering maintenance, impose an operator merge/build freeze
   that admits only the joint Unit 18/Unit 2 PR #349 exact-head merge and its
   named main build. Prove no other
   relevant Cloud Build or migration, media-policy, cleanup deployment, or
   cleanup execution is active at quiescence and again before ingress. The
   watcher aborts on any competing merge, trigger, build, or Job execution. The
   quiescence proof also requires the frozen complete holder derivation to find
   zero present app holders, zero thread stream/holder nonce, and no unexplained
   reservation remnant; terminal-less orphan chunk rows are allowed only
   because the transaction deletes the entire operational chunk log. With that
   fence held, create a fresh on-demand backup and wait until Cloud SQL reports
   it complete; record its backup id and the database clock. This
   post-quiescence backup is the authoritative restore point, and the fence
   proves no legitimate write can land after it. If the advisory scan found a
   topology defect, run the reviewed row-digest-pinned forensic repair manifest
   now, while the old schema is still the serving contract but every writer is
   fenced. One all-app repair transaction must prove every exact before digest,
   apply the approved Project-tenancy manifest and delete its one exact
   inaccessible test orphan, append the two topology-orphan-only property
   projections, delete the 42 exact topology roots, reconcile every affected
   lookup/media projection, apply the separately reviewed expression manifest,
   and append the attributed `blueprint-migration` plus `fold-baseline` changes
   for each surviving repaired app. The tenancy
   deletion first proves its full zero/one dependent inventory and has no
   reusable or inferred target. That
   expression manifest types the five proven references in the one affected
   label, clears its one unresolved token occurrence, and clears the two illegal
   catalog `validation` slots. Before commit, prove the exact
   effective-property metadata plus expected picker-order normalization,
   byte-identical `materializableCaseTypes`, case-store schema/index, XForm,
   suite, Preview, and summary for the topology repair; prove that the catalog
   clears change no current emitted form, that Preview and evaluated device
   label text remain equal for every form assignment, and that the only XForm
   byte difference is the digest-pinned deletion of the one invalid output
   node. The transaction rolls back as a whole if any proof fails. Neither
   repair may infer from a path string, and every source/replacement digest must
   match. Rerun the locked
   scanner and require zero topology, illegal catalog-expression, or
   unresolved-reference findings, zero null/blank app or case Projects, zero
   missing Project targets, and zero mismatched case/app tenants. A failure
   rolls that repair transaction back; an ambiguous row stops the cutover. The
   pre-repair backup remains the authoritative rollback point. Before merge, arm an
   operator-local one-shot watcher keyed to joint PR #349, its frozen combined
   Unit 18/Unit 2 head SHA, reviewed base SHA, and named main trigger. After
   exact-head squash
   merge, it resolves the PR's resulting merge commit, verifies its parent/base
   and tree against the frozen merge result, then requires the named main
   build's source commit to equal that merge commit. Only then does it bind the
   build id and immutable Artifact Registry digest from Cloud Build metadata; it
   refuses any revision whose reported digest differs. Once that target build is
   bound, the orchestrator disables further trigger admission, verifies no
   competing build is queued or running, and temporarily narrows control-plane
   update/execute IAM so only the target Cloud Build identity and cutover
   orchestrator can touch the named service, Jobs, scheduler, or NEG. Immediately
   before every Job update and execution it rechecks target build id, Job
   generation, complete configuration, immutable image, and IAM, rejecting any
   manual execution. The recorded trigger and control-plane IAM state is restored
   only at terminal success or completed rollback. It may reattach the existing
   NEG only after the later strict runtime proof and exact new-revision
   conditions succeed, but remains armed through the terminal-success latch.
4. Only after quiescence, exact-head squash-merge joint PR #349 at its frozen
   combined Unit 18/Unit 2 head. Its normal main trigger builds that exact image,
   then the migration Job takes
   deterministic all-app locks and one migration-owned transaction and reruns
   the blocking scanner. This scan is authoritative: it records a fresh
   quiescent digest and aborts on any topology/unresolved-reference finding,
   current unmigratable finding, live
   writer, inventory/schema-version mismatch, or capacity bound violation — not
   on ordinary drift from the earlier advisory snapshot. The transaction
   executes the dispatcher's exact `rewrite-current` plan and proves zero
   `block-current` findings. Inside that transaction it constructs every
   rewritten candidate, final-parses each complete assembled Blueprint and
   remaining current event, and only then persists those candidates. After all
   candidate and index proofs pass, it archives every existing mutation event
   while changing both `events.event.kind` and the projected `events.kind`
   column atomically, migrates typed event attachments, writes all exact
   `app_changes` rows and immutable Project-bearing
   `app_change_fold_baselines`, deletes every presence and
   `chat_stream_chunks` row, strictly parses every `lookup_rows.values` object
   and validates every key against its exact table/column context while
   preserving the complete `lookup_rows` table byte-for-byte, converts the SQL
   columns, makes
   `apps.project_id` and `cases.project_id` nonblank and `NOT NULL`, adds the
   named deferred composite case/app tenant foreign key, rebuilds constraints
   and indexes, and commits only when every invariant and post-horizon baseline
   proof passes. The four Better-Auth-Project foreign keys belong to the
   Nova-owned auth-app migration that runs later in this same migration Job:
   `apps.project_id`, `app_changes.from_project_id`,
   `app_changes.to_project_id`, and
   `app_change_fold_baselines.project_id`. It runs after Better Auth creates
   `auth_organization`; a fresh database must not
   depend on that table existing during the earlier case-store migration. A
   noncanonical lookup-row key is a locked-scan blocker rather than an input to
   runtime lowercasing. The migration's `down` entrypoint throws
   an explicit forward-only error so Kysely can never remove its ledger row while
   leaving the UUID schema in place. The Job configuration pins
   `maxRetries: 0`; the orchestrator alone may start a later fully refenced
   execution.
   The following case-schema index-convergence DDL cutover first locks and
   classifies its complete catalog and data. Only the exact source shape runs
   plain DDL and seeds `index_pending_seq = synced_seq`; the exact final shape is
   a no-write audit that preserves a legitimate newer pending sequence. Any
   partial, wrong-type/default/index/constraint, extra, or duplicate shape
   blocks, and its `down` is forward-only.
5. Still inside the exact new image's migration entrypoint and before service
   deployment, run Better Auth's own migrations and then the Nova auth-app
   migration. The latter verifies every surviving referenced Project exists and
   adds the four exact named, validated foreign keys above with restricted
   update/delete actions; unknown Project rows or any
   alternate definition fail the Job. It locks the app and Project relations
   and inventories the complete `project_id` column/index plus local and
   referencing constraint set before its first write; alternate-name duplicate
   FKs, alternate actions or deferrability, `NOT VALID`, and partial/extra
   objects block. An exact applied rerun is read-only and its `down` is
   forward-only. Then converge to the final explicit
   database ACL: only the migration,
   runtime, cleanup, and dedicated audit identities regain their intended
   `CONNECT` and least-privilege grants; the audit identity has only the exact
   `SELECT` privileges required by the scanner and no DML or role inheritance.
   `PUBLIC` and incidental operator logins do not regain access.
   Keep the service at manual zero with no traffic tags, terminate any direct
   runtime-login session again, and prove none exists after the grant. From the
   migration connection, `SET ROLE` to the runtime database role and run the
   zero-finding steady-state parser plus an authorization-aware app read and
   rollback-only synthetic write through the real membership/commit primitives,
   using an existing Project member without emitting their data. This proves the
   final runtime privileges while no old runtime process can reconnect. Record
   the authoritative digest. The runtime probe runs the complete steady-state
   domain validator plus local and Project-scoped reference-index checks; it
   never hardcodes a zero parser result or hides an eligible editor behind an
   arbitrary row limit.
   Separately execute the new cleanup image's strict schema probe under the
   cleanup identity while its scheduler remains paused, and prove the Cloud
   Build update did not unpause it. Either failure stops Cloud Build with
   ingress closed; this is the required proof that the new runtime and
   independent writer can use the migrated shape, not an external probe after
   public writes have resumed.
6. The service stays at manual zero while the trigger deploys the same exact
   image without disabling Cloud Run's deployment health check and without
   passing `--scaling=auto`. The permanent deploy script records and requires
   the maintenance prestate to be manual-zero; the external watcher fails the
   build if the script instead reports the ordinary automatic prestate. Manual
   scaling ignores revision minimum/maximum settings, so every old revision
   stays stopped while the deployment health check starts only the candidate
   and its database-backed `/warmup` probe passes under the real runtime login.
   After `gcloud run deploy` returns and before scaling changes, assert that the
   service is still manual zero, the exact new immutable digest is Ready and
   owns 100% traffic, and every old revision is at 0% with no tag. Prove zero
   old runtime session or log activity after the post-grant fence. Then let the
   same permanent path issue its unconditional service-level
   `--scaling=auto` update, prove the same candidate/allowed-removal revision
   subset rule with no addition, and verify the expected automatic
   minimum/maximum scaling. Because only the exact new
   revision owns traffic, it is the only revision that can start. Prove its
   fresh runtime-login connection and authorization-aware read before the build
   may continue; `/warmup` plus `SELECT 1` alone is not that proof. If any
   post-migration Cloud Build phase fails, ingress and
   cleanup stay paused; return the service to manual zero and terminate runtime
   sessions. Before ingress resumes, the authoritative in-place backup restore
   remains available.
7. Only after steps 5–6 succeed does the armed one-shot reattach `nova-neg`; that
   timestamp is the recorded rollback cutoff because public writes may begin
   immediately. Cloud Build's retrying public-host probes then verify routing,
   and the orchestrator starts a scanner/probe Job from the exact target
   `repository@sha256` image under the dedicated audit identity. Its immutable
   entrypoint opens a read-only transaction, emits only the content-free report
   plus its digest, and must match the expected zero/post-horizon result. It then
   inspects the error-log gate. Any failure in those probes, scan, or log gate
   immediately detaches the NEG, returns the service to manual zero, terminates
   runtime sessions, and leaves cleanup paused before fix-forward begins.
   Resume cleanup only after every check passes, then verify the scheduler is
   `ENABLED` with the exact recorded/new schedule, URI, auth, headers, Job
   generation/configuration/IAM, and immutable target image; wait for and verify
   one successful cleanup execution. Scheduler resume or execution failure uses
   the same recovery arm. Only then restore trigger/control-plane IAM, set the
   terminal-success latch, and disarm the orchestrator and watchdog. They are
   disposable operator orchestration, never checked-in runtime or deployment
   machinery.

The orchestrator records and enforces this rollback/fix-forward state matrix;
each transition stores its evidence before the next begins:

| State | Required evidence | Failure and retry |
| --- | --- | --- |
| Source unmerged; forensic repair uncommitted | Original source/build/Jobs/ACL/scheduler inventory | Roll back the open transaction and restore recorded configuration; a retry restarts the full drain. |
| Forensic repair committed; canonical migration uncommitted | Repair horizon/digests and authoritative pre-repair backup | Backup restore is mandatory before old workloads; if source was merged, the exact revert-build path is also mandatory. |
| Canonical migration committed; automatic scaling not resumed | Migration ledger/baselines/DDL/ACL digests; manual-zero and NEG detached | Restore the authoritative backup and follow the exact revert-build path; a forward retry first repeats every fence and probe. |
| Automatic scaling resumed; NEG detached | Candidate digest/traffic/revision subset and runtime proof | Return to manual-zero, terminate sessions, then either restore-and-revert or repeat the fully fenced forward deployment. |
| NEG attached; cleanup scheduler still paused | Public-ingress timestamp plus passing target revision/runtime proof | Detach NEG, return to manual-zero, terminate sessions, keep cleanup paused, and fix forward; backup restore is forbidden because public writes may have landed. |
| Cleanup scheduler enabled; terminal latch unset | Exact scheduler/Job config and target image | The same detach/manual-zero/session-termination/fix-forward arm remains active until one cleanup execution and every terminal proof pass. |
| Terminal success latched | Public probes, audit scan digest, log gate, cleanup execution, trigger/IAM restoration | Disarm; later incidents use ordinary production recovery, not this cutover rollback. |

Rollback before the all-app repair transaction commits, including an earlier
build/media-policy failure, is transaction rollback plus restoring and
verifying the recorded pre-fence database ACL, old media-policy and
capture-cleanup Job images/configuration/IAM, complete scheduler
configuration/IAM, trigger/control-plane IAM, and scheduler state. Route 100% to the
exact recorded old revision, restore and verify its recorded traffic/tag and
automatic-scaling configuration, and prove the old runtime and cleanup schemas,
but keep the NEG detached until the source-control closure below. Once the
repair transaction commits, rollback restores the authoritative backup even if
the later canonical migration has not started or committed; transaction
rollback/config restoration alone cannot undo that committed repair. After the
canonical migration commits, no down migration and no old revision is allowed
against the migrated database. In either post-repair case and until the explicit
NEG reattachment cutoff, rollback means returning the service to manual zero,
terminating runtime sessions, and restoring the completed authoritative backup
**in place** over the existing `nova-cases` instance, preserving its connection
name. Verify the restored settings, IAM database users, and migration ledger;
then explicitly reconverge and verify database flags, backup/PITR
configuration, networking, connection identity, IAM database users, migration
ledger, and the recorded pre-fence ACL because an in-place restore may preserve
target settings while resetting backup defaults and the authoritative backup
contains the fenced ACL. Restore the recorded old service
and cleanup images, 100%-old-revision traffic, traffic tags, automatic scaling,
every Job configuration/IAM, and complete scheduler configuration/state; prove
both old workload schemas while ingress remains closed.

The merge/build freeze remains in force through either rollback path. Returning
to old production is not complete while the joint Unit 18/Unit 2 merge still
sits on `main`: revert that exact PR #349 merge, require the named main trigger's
source commit to equal the revert commit, and verify its old service image,
migration ledger behavior, all three Job configurations, and restored database
together before restoring ingress and releasing the freeze. Before triggering
that revert build, arm a fresh
one-shot rollback watcher keyed to the exact revert commit, named build, and
fresh revert-build image it will resolve. The recorded old digest remains
pre-cutover evidence, not the expected output of a new build: the revert build
has a new deployment id and therefore a new immutable digest. The watcher binds
that fresh `repository@sha256` from the exact revert build and uses it for the
service and every restored Job, so rollback does not depend on the recorded old
revision surviving Cloud Run garbage collection. The NEG remains detached
through the restore, old schema/ledger/Job proofs, and the revert build's deploy.
Reverting Unit 18 also restores the prior `cloudbuild.yaml`, whose public-host
verification begins immediately after deploy and retries for a bounded window.
Once the watcher observes that exact revert build's deploy step complete, the
fresh revert digest Ready at 100%, the restored database and all three Jobs
proven together, and no competing source/build/job activity, it reattaches the
existing NEG exactly once while those public retries are still active. Those
probes must then pass inside the build; the revert build cannot turn green on
internal evidence alone. A missed retry window or any failed/mismatched proof
fails the build, detaches the NEG again if necessary, returns the service to
manual zero, terminates runtime sessions, and keeps cleanup paused. If the
revert build cannot produce and prove its image, ingress stays closed and the
only alternative is fix-forward. This is the rollback path's only ingress
reattachment point. Old production never reopens with the strict new source
silently pending on `main`. PITR is not the restore path because PostgreSQL PITR
always creates a new Cloud SQL instance. Once the NEG is reattached after the
forward cutover, the only path is fix-forward with the NEG detached, service at
manual zero, runtime sessions terminated, and cleanup paused; a partial table
restore or replay across the horizon is forbidden.

The stream checks the complete app-change suffix after a client cursor before
emitting anything. If any row is `blueprint-migration`, `fold-baseline`, or
`project-move`, it emits zero mutation frames from that suffix, freshly
reauthorizes, and sends exactly one terminal, sequence-less reload. Revocation
closes as revoked; transient
reauthorization failure advances no cursor and retries. A post-cutover scan must
report zero current or post-horizon findings. The server strictly parses the
complete post-cursor suffix before emitting any frame and the client parses each
received canonical frame again before reconciliation. An invalid server suffix
emits zero partial frames and one observable sequence-less protocol-failure
terminal, without advancing its cursor. An invalid client frame closes and
disowns the stream and enters the serialized authoritative Blueprint reload
path without advancing the reconciler cursor or invalidating case data; only a
successfully parsed fresh snapshot installs its head sequence. The post-cutover
scanner locates the greatest row in `app_change_fold_baselines`, strictly parses
it, recomputes the database-owned `snapshot::text` digest, accepts either the
immutable frozen-baseline attribution or a sequence-one genesis attribution
without consulting mutable current run state, parses every suffix batch, folds
that suffix, and requires exact scalar/entity equality with the stored
snapshot.

The SQL UUID conversion covers semantic authored identity columns only:
`apps.logo`, `blueprint_entities.uuid`, `blueprint_entities.parent_uuid`,
`media_assets.id`, both media-upload-alias asset ids, media reverse-index asset
ids, `form_submission_intents.form_uuid`, and
`form_attachments.field_uuid`. It rebuilds every dependent FK, index, trigger,
and Kysely type and does not infer semantics from an `*_id` suffix. The nested
`form_submission_intents.result.operations[].operationUuid` conversion is part
of the same transaction but remains JSON, not a pretend SQL identity column.
Before conversion, a `pg_depend` closure freezes the ordered source and expected
result object maps and their hashes. The postcondition requires exact
`pg_get_constraintdef`, `pg_get_indexdef`, and `pg_get_triggerdef` output plus
names, affected columns, predicates/expressions, deferrability, validation,
nullability/defaults, ownership, and relevant grants for every dependent
object. Count equality or a hand-listed subset cannot authorize commit.
That closure starts at `public.apps`, follows incoming foreign keys and
`pg_depend` recursively, rejects an unowned dependent heap relation, and
separately freezes every owned relation/index owner and ACL. The fold catalog
pins every function body from `pg_get_functiondef`, owner, complete ACL/grants,
and fixed `proconfig`/`search_path`; a same-name or count-only function match is
insufficient.

Verification freezes the complete contract:

- a generated one-representation inventory covers standard case-property names,
  Connect, Search inputs, mapping rows, nested UUID/order topology, case-operation
  facets, owner-only Search provenance, post-submit destinations, date-column
  formats, required Project tenancy, app-read response keys, builder route
  tokens, expression/prose/XPath projections, and every current protocol-frame
  family. Persisted carriers are
  parity-tested through scanner, dispatcher, migration, final schema, and
  consumers. App-read responses, route tokens, and ephemeral protocol frames
  are covered by the generated source registry plus strict producer/consumer
  fixtures; no synthetic database migration disposition is invented for them.
  For every authorable carrier, final domain schema, builder/SA/MCP admission,
  Preview/runtime consumer, and wire projection are parity-tested. Any live
  alias, saved draft, context-free user projection,
  permissive reader, stale-state fallback, or frozen-module runtime import fails
  CI. Migration fixtures cover each allowed exact rewrite and every blocking
  ambiguity, final-parse the complete assembled Blueprint, and prove that no
  current row, baseline, or post-horizon suffix retains a pre-cutover shape;
- explicit case-property rename fixtures prove chains-to-fresh, swaps, and
  cycles across peer `caseWrite` bindings, case-operation writers, typed
  references, catalogs, case-list/Search carriers, schemas/indexes, live rows,
  every parked row including dismissed entries, undo, command-aware durable
  replay, and a dedicated no-stamp row rewrite that preserves `modified_on` and
  every unrelated case/park column. Generic `diffDocsToMutations` and
  whole-document synthetic repair refuse a complete carrier-wide
  rename-shaped endpoint pair without command provenance and never manufacture
  rename intent from endpoint snapshots; ordinary writer retarget, writer
  add/remove, case-operation write edit, catalog add/remove/edit, and
  typed-reference edit fixtures prove those granular diffs remain available
  and leave rows untouched. The collaboration equality path needs no semantic
  diff. A rename followed by its inverse proves byte-identical aggregate
  Blueprint state does not erase either admitted command: both are sent,
  persisted, replayed, and inverted in order, and its UI/store regression proves
  the command-queue notification wakes autosave despite an unchanged
  persisted-state slice. A separate symmetric swap fixture proves one explicit
  command changes the Blueprint carriers and live/parked row keys together,
  with exactly one matching accepted event. A rejected rename followed by
  dependent edits proves the entire unacknowledged causal suffix and its
  history are discarded on authoritative reload, no successor PUT occurs, and
  the user is told to redo those edits rather than having one reinterpreted
  against the old property identity.
  Negative
  fixtures reject duplicate sources/destinations, terminal merges, occupied
  destinations that do not move, same-source rebirth, scalar/JSONB crossings,
  standard scalar metadata participation, missing/nonmaterializable sources,
  row/park collisions including present null, empty-string, and blank
  destination values,
  mixed-mutation batches, and any temporary property. A separate matrix proves
  `updateField.patch.id`, `patch.caseWrite`, and `moveField` never trigger an
  app-wide rename. Transaction fixtures prove Blueprint reproof, row/park
  rewrite, schema-intent regeneration, and Blueprint/event persistence commit
  or roll back together in Phase A; Phase B concurrent index convergence is
  independently observable and retryable without changing correctness.
  Heterogeneous typed chain/swap/cycle fixtures prove declaration metadata
  follows the source, generic retype/reshape/restore/park logic never runs,
  parked metadata remains byte-identical apart from the property name, and
  affected cast-bearing indexes are transactionally dropped before a row value
  they cannot evaluate moves under them. A Phase-B failure leaves a durable
  pending marker; immediate, same-batch-dedup, point-of-use, materializer, and
  deployment drains converge it. An out-of-order sequence N/N+1 fixture proves
  the shared per-type lock and latest-schema derivation make delayed N converge
  N+1 rather than drop its index. Queue
  fixtures prove rename→edit, edit→rename, rename→undo-before-save, peer rebase,
  retry, and ack remain ordered distinct batches and PUTs;
- Project-tenancy fixtures cover the default null/blank/missing/mismatched
  blocker; the one approved full-digest orphan deletion; changed bytes, an
  added dependency, or any alternate null app rolling back the entire repair;
  zero-null `attnotnull` postconditions; exact named app→Project and deferred
  case→app tenant foreign-key definitions; negative null/blank/orphan/mismatch
  inserts; fresh-database Better-Auth/auth-app ordering; and Project moves
  committing only a complete tenant closure. The shared rollback-isolated SQL
  harness sets every constraint immediate before each test body and seeds exact
  parent app/Project rows, so an initially deferred violation cannot remain
  unchecked until teardown rollback; tests of deferred multi-statement behavior
  use a real commit boundary. Source tripwires reject nullable
  persisted app Project types, owner-fallback app authorization, no-Project
  runtime copy, or an alternate app branch. The schema-only case store's
  discriminated no-Project mode remains covered separately and cannot invoke a
  tenant-bound method;
- absolute-gate regressions cover valid→invalid rejection, a corrupt
  baseline/read, a corrupt empty proposal, an invalid intermediate suffix
  followed by a valid final state, and undo after a peer change. Each fails
  before exposure or partial reduction. Source tripwires prove there is no
  `diffIntroduced`, empty-batch bypass, or introduced-error copy;
- malformed-current-frame regressions prove: a presence failure clears and
  refetches only presence; a revocation failure disowns the affected
  authorization state; a mutation-frame failure disowns the stream and enters
  the serialized authoritative Blueprint reload; and a lookup-manifest failure
  clears and refetches the manifest without advancing its clock. Each is
  observable and installs no partial item. One malformed event in an ordered
  page returns no event from that page;
- exact transport and authorability matrices prove the app-read response has
  only its five current keys; retired routes and post-submit values reject; and
  every stored Predicate/ValueExpression leaf has a complete final builder or
  machine edit surface plus Preview and wire consumers. A read-only,
  `roundTripOnly`, imported, dormant, or “preserve malformed saved value” arm
  fails the matrix;
- UUID version/variant/case matrices, strict lookup UUIDv7, record-key equality,
  exact topology closure (orphans, cycles, missing/wrong-kind parents,
  duplicate/stray memberships), context-aware nested refs, strict routes/tools,
  and throwing narrowers. A generated registry/parity test inventories every
  `{ tool, JSON pointer, identity family }` for every authorable-identity path
  in the complete shared-tool registry and fails on an unclassified path. Each
  uses the shared `uuidSchema` or domain-specific identity schema, never generic
  `z.uuid()`, `z.string()`, or a later cast. The exact local Zod input, SA
  `wireToolSchema(...).jsonSchema`, and MCP `tools/list` JSON Schema all reject
  the complete malformed/case/version/variant/nil/max matrix at every pointer,
  including nested same-call operation UUIDs and media parameters. Compact
  provider Predicate, ValueExpression, XPath, and Prose projections retain
  their discriminators and exact UUID constraints; an
  `additionalProperties: true` identity-bearing AST stub is forbidden;
- a generated leaf-exhaustive mutation-wire registry over every final
  `mutationSchema` arm and nested payload owner: each `updateField` target kind;
  every case-operation add/remove/update/write/link/move arm; every
  `updateModule` Search/ensure arm; every `updateColumn` payload; inline and
  lookup select sources; every nullable clear; and every genuinely nullable
  semantic value. A generated clear-slot manifest records
  `{ mutation leaf, JSON pointer, null meaning }`, distinguishing clear from a
  stored null, omission/no intent, and invalid own `undefined`. It pins all five
  former patch-default owners to required explicit patches and distinguishes
  form/module rename mutations, the local `updateField` id and `caseWrite`
  paths, and the batch-exclusive `renameCaseProperties` arm. A
  new unclassified mutation leaf fails CI;
- exact JSON-tree admission matrices over primitives, descriptors, arrays,
  prototypes, cycles, aliases, frozen inputs, reordered keys, and throwing
  proxies. Accepted canonical batches survive safe detachment, JSON, and schema
  unchanged. Nested/top-level `undefined`, functions, symbols, `BigInt`,
  non-finite numbers, negative zero, sparse arrays, custom/symbol/
  non-enumerable/accessor properties, custom prototypes, cycles, unknown keys,
  and schema default/strip/coercion drift reject before reduction with the
  deterministic first mutation index, RFC 6901 pointer, and reason. Tests prove
  object-key order, plain versus null prototype, frozen input, and acyclic
  sharing are semantic non-differences; shared objects are independently cloned.
  Mutation of caller input after preparation, during a forced SQL retry, and
  before delayed event/tool-result flush cannot change the candidate, accepted
  JSONB, transient stream, event, tool result, or replay. The reducer cannot
  mutate the admitted command, candidate and admitted batch do not alias, and
  staged admission retains exact ordered stage partitions and tags. Sparse,
  custom-property, accessor, and aliased outer/stage mutation arrays reject
  before any `filter`/`flatMap`/length/index read; an invalid empty stage cannot
  disappear before admission, and delayed stage events contain only protected
  admitted slices. With
  inherited `Object.prototype.toJSON` and `Array.prototype.toJSON` poisoned,
  exact regressions prove the accepted-row parameter, transient
  `data-mutations` wrapper, event wrapper, and tool-result wrapper still encode
  the admitted JSON value and invoke neither hook;
- a generated producer/consumer and source-tripwire inventory covers app
  creation seeds/templates, builder queue, undo/redo inverses, Connect,
  single/staged SA and MCP, diff, frozen pre-cutover/media/synthetic repair, Project-move
  media remap, autosave route and saga preflight, authoritative retry, transient
  chat `data-mutations`, chat/MCP events and delayed flush, accepted rows,
  stream route, client parse/reconciliation, baseline/suffix scanner, reload,
  and later replay. Every reducer/writer entrypoint is classified as “admits a
  proposal” or “consumes a durable admitted value.” Accepting client and server
  writers can receive only the opaque admitted/prepared type and persist,
  stream, and return the same detached value. Tests prove route admission
  precedes schema transformation, dedup, target/scope/identity/sequence checks,
  saga projection, reducer, DDL, and every side effect; invalid complete
  suffixes emit/apply nothing. HTTP regressions pin the exact canonicality body
  and prove its reconciler outcome retains all local edits while freezing with
  no retry, drop, reload, conflict callback, or cursor movement;
- content-bound batch-id integration tests reverse the prior permissive case:
  the same `(app_id, batch_id)` with the same admitted mutations and
  actor/kind/run attribution is idempotent success with its original sequence
  and no duplicate event/log/notification; any mutation or immutable-envelope
  difference returns terminal `MUTATION_BATCH_ID_COLLISION`. The
  unique-violation race path performs the same comparison, a noncanonical retry
  cannot latch onto a prior batch id, and key order/prototype/acyclic sharing
  create no false collision;
- every patch/dedicated clear command carries explicit `null`. A whole-value
  replacement may clear an omitted nested slot only when replacement semantics
  already make that omission the canonical command. Focused producer and
  end-to-end regressions cover conditional-close → Always; post-submit →
  default; app-wide Connect enable, mode switch, complete participant
  replacement, disable, and same-mode teardown through the shared SA/MCP
  command and builder planner, including no dormant blocks and rejected
  empty/foreign/duplicate/wrong-mode targets; `validate_msg`, `validate`,
  `required`, and `caseWrite`; every pre-cutover repair clear; pre-cutover media
  clears for app/module/form/case-list/field and inline-option media through its
  whole-value `updateOption` omission; and form/module renames. The actual PUT
  path proves the exact admitted command through accepted JSONB, transient and
  durable stream, applicable event, full reload, and post-baseline replay
  without resurrecting a removed value. Injected durable corruption containing
  a missing formerly-defaulted patch or nested unknown key makes stream/fold
  reject before partial emission/application;
- XPath/template parser-printer fuzz, canonical depth-changing `path-ref` moves,
  adversarial hidden references, cross-form and wrong-kind refs, same-call UUID
  construction, legal reference-only forward refs, rejected later-producer
  `id-of`/effect dependencies, Search-input UUID projection, frozen Lezer
  catalog-string conversion/refusal, friendly human XPath projection, and
  structural rename/move;
- frozen field-binding migration fixtures rewrite exactly
  `case_property_on: <caseType>` plus the field's existing `id: <property>` to
  `caseWrite: { caseType: <caseType>, property: <property> }`, preserve `id`,
  final-parse the new field, and prove that the old slot is rejected by every
  live schema/reader. A named CommCare XForm oracle proves a question whose
  local field id differs from `caseWrite.property` writes the declared case
  property while friendly XPath remains `#form/<field-id>`. An emitted-action
  admission matrix rejects every survey/no-action writer, duplicate ordinary,
  `case_name`, or `external_id` writers in the primary bucket and each
  `(child type, nearest repeat UUID)` bucket, and missing or multiple
  `case_name` writers in registration/child-create buckets. It admits only
  `case_name` and `external_id` from the standard scalar set for ordinary field
  writes, and only `external_id` for generic operation writes. Named CommCare
  `corehq/ex-submodules/casexml/apps/case/tests/data/v2/basic_update.xml`
  bytes plus an emitted Nova fixture prove a unique followup/close primary
  `case_name` binding preloads and emits as `<update><case_name>` rather than
  disappearing. Exact
  `FormPreparationV2Test::test_open_case_external_id` /
  `form_preparation_v2/open_case_external_id.xml` bytes plus an emitted Nova
  fixture prove registration external ID lives in `<update><external_id>`,
  never `<create>`. Field, operation, and storage fixtures prove U+0000..U+0020
  boundary normalization, the 255 UTF-16-unit cap, active blank external ID as
  `""`, inactive/absent preservation, ordinary-last contention, and scalar
  exclusion from JSONB across primary/child create, followup/close, direct and
  bulk store paths, duplicate-create merge, and retype. Operation fixtures
  prove writes resolve under
  `(retype ?? caseType, property)`. One shared inventory fixture asserts exact
  field UUID/current id, ordered UUID/current-id/query-bound path segments,
  nearest repeat UUID/id/path, and one-time `FormPath` projection parity across
  validator, FormActions/XForm, Preview, and builder projection. Its membership
  matrix accepts only the module's own or exact direct-child type and rejects a
  sibling, parent, grandchild, unrelated, unknown, blank, module-less, and
  survey/no-action destination identically through builder, SA, MCP, gate,
  emitter, and Preview. A nested XML-illegal ancestor-id regression produces
  exactly one `INVALID_FIELD_ID` finding, while direct lowering and Preview
  both throw the same projection error when that validator is bypassed;
- horizon migration fixtures for every root/entity/carrier and mutation family,
  catalog defaults, the exact five-reference/one-token-clear prose repair, the
  exact two-slot catalog-validation clear, canonical-option preservation, exact
  pre-cutover option UUIDv5 replacement, missing/stale/other refusal, source/target
  injectivity and global collision checks, forensic-manifest
  before-digest/ref/consumer proofs,
  semantic JSONB plus exact canonical
  `jsonb::text` preservation of each nested archived event payload, strict
  post-cutover mutation events, typed event attachment migration, form-intent
  result operations, canonical `lookup_rows.values` key coverage and
  noncanonical-key refusal, idempotence, rollback, all-app atomicity, exact
  post-horizon replay, including a nonempty `project-move` suffix that folds
  normally while the stream reloads and a `fold-baseline` row that is exactly
  empty; stream boundary ordering,
  presence reset, operational
  chunk-log deletion, and frozen migration logic. Direct-run tests invoke
  `runFrozenCanonicalIdentityMigration` twice outside the Kysely-ledger shortcut:
  the second invocation proves the exact already-applied state — at least one
  complete baseline per app, exact `fold-baseline`
  attribution/digest/snapshot for every
  baseline, greatest-baseline selection with a strictly later suffix, exact
  sequence/head, strict suffix replay, carrier digests, and DDL definitions —
  while every partial or mixed applied state rejects. The multi-baseline
  fixture proves earlier baselines remain immutable fold history and are
  neither replayed twice nor mistaken for the current starting snapshot. A
  valid-app-plus-blocking-app fixture and injected failures after each
  `rewrite-current` family — canonical-property rewrites, AST/template
  conversion, final-shape Blueprint rewrites, date/post-submit conversion,
  event conversion, and operational deletion — plus horizon/baseline and DDL
  stages prove every app, entity, case row, parked value, schema/index object,
  event, operational row, baseline, and migration-ledger row remains
  byte-identical;
- media carrier matrices, slot-specific built-in catalogs, tool projections,
  manifests, budgets, deletion, Project moves, and database FK/index migration;
- pre/post effective-property-set/metadata equality, the exact two-property
  picker-order normalization, byte-identical `materializableCaseTypes`,
  case-store schema/index, XForm, suite, Preview, and summary equivalence for
  the exact two-property materialization and 42-root deletion; for the separate
  expression repair, equal Preview/evaluated-device text for every assignment,
  zero current-form change from the catalog clears, and exactly one
  digest-pinned XForm output-node deletion with no other byte drift; plus the
  existing exact external fixture-byte oracles;
- occurrence-manifest totality and scanner/forensics/locked-scan/rehearsal/
  migrator plan-and-digest parity, including complete content digests rather
  than count-only coverage; production-shaped Cloud Run fixtures for `LATEST`
  and explicit traffic, full image references, revision garbage collection,
  manual-zero and automatic prestates, zero-retry migration execution,
  trigger/control-plane exclusion, audit-identity scan, complete scheduler/Job
  configuration preservation, orchestrator/watchdog loss, every state-matrix
  transition, and failures before/after migration, scaling, NEG attachment,
  scheduler resume, cleanup execution, and rollback restore with verified
  recovery;
- the normal `npm run db:migrate`, `db:dev`, and smoke entrypoints load every
  server-only module under the required React Server condition; the frozen
  repair's application-row authority remains inside the structural write guard;
  the forward-only migration refuses `down`. The final frozen-SHA CodeQL
  evidence records the exact `js/weak-cryptographic-algorithm` result for
  `preCutoverOptionUuidV5`: SHA-1 is required solely by RFC UUIDv5 deterministic
  identity mapping and protects no secret, signature, password, or security
  decision. If GitHub still opens that exact alert, after fresh user approval
  dismiss it as `false positive` with that justification, record the alert
  number/path/fingerprint and API-confirmed dismissed state, and require the
  aggregate CodeQL check to be green; a source comment and frozen vectors keep
  the non-security use reviewable;
- offline schema generation and size budgets, with the paid provider acceptance
  sweep run only after explicit approval; targeted, changed, leak, type, lint,
  build, full-CI, production-probe, and error-log evidence. The named Playwright
  identity-projection journey changes a close form from Always to Conditional
  without committing a placeholder, selects a real field and answer, commits,
  renames and moves that field, reopens the form, and proves the close picker
  and human XPath surfaces show the current friendly projections while the
  stored identity and Preview behavior remain unchanged and no UUID text
  appears; switching back to Always leaves no sentinel or dangling reference;
  the same browser suite shows Field ID and Saves to as independent controls,
  retargets Saves to onto an effective-catalog property with no writer while
  friendly `#form/<field-id>` stays unchanged, and then changes the field id
  without changing its case destination. It opens app-wide Case data, finds a
  catalog-only property, composes a multi-entry relation, reviews grouped
  document/row/park impact, and proves an occupied-destination refusal sends no
  mutation. After exact save acknowledgment and reload it proves the field
  binding, case-operation/condition/list/Search projections, seeded case row,
  and Preview value all follow the property relation while Field ID stays fixed;
  undo proves the inverse restores document and row state. The global trigger,
  dialog focus/return, and full flow repeat at handset width;

Documentation moves only where reader-visible behavior or a callable contract
changes. The public MCP reference, including `content/docs/mcp/tools.mdx`, must
show the exact UUID parameters and typed AST/template payloads an API client
actually sends. In this unit, rewrite the conflicting lookup/case-operation
sections of `content/docs/mcp/tools.mdx`: remove the claim that returned lookup
ASTs are withheld, remove mutable operation-id and field-path addresses, and
show the one callable UUID/AST contract. It also documents the exact field
`caseWrite: { caseType, property } | null` payload and the complete simultaneous
`rename_case_properties` relation; ordinary guides explain only the visible
Saves-to/property-rename workflow, not internal UUID storage. The combined
final PR also documents
Unit 2's complete row-filter and lookup tool contract; no final documentation
state withholds behavior deployed in the same image.

This foundation does not add UUID material to ordinary public guides.
`content/docs/case-changes.mdx` changes only because its existing SA/MCP passage
would otherwise become false: replace the instruction to address changes by
operation id and field path with a short, friendly description of asking Nova
or an MCP agent to manage the same changes. It does not explain UUID storage or
typed payloads. Other builder/user pages such as
`display-conditions.mdx` change only if an instruction or example becomes stale
and continue to teach friendly names and human XPath. Public media
documentation changes only for real authoring choices such as catalog icon
slugs versus uploaded assets. Internal contracts and subtree engineering docs
own the UUID-backed projection explanation. Unit 2 documents only the new
condition and lookup vocabulary it adds.

**Observed:** the builder can show friendly current names while every persisted
and machine-authored reference remains an immutable UUID-backed value; renaming,
moving, or reordering an object changes only projections, never retargets stored
logic, and no Nova authoring boundary admits a slug, path, tag, wire name,
position, or arbitrary string in place of owned identity.
