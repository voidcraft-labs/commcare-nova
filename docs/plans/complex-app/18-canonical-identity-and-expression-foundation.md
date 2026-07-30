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
and schema-checks the complete prospective field. When `id` changes and the
same nonempty `case_property_on` binding remains before and after the patch, the
gesture is a rename of that name-keyed case property: peer writers, typed
case-property references, form/module wiring, case-list/Search state, and the
catalog entry all move together, while UUID-backed field references remain
byte-identical and merely re-project the current friendly path. When one patch
changes or clears `case_property_on` as well as `id`, it is instead a writer
retarget: the old property, its peers, references, catalog declaration, and
saved values remain intact, and the new pair is registered without an
old-to-new cascade or row migration. This distinction is derived from the
complete before/after pair, never from staged rename-then-retarget events.
The final semantic mutation-kind manifest contains no `renameField`. Those bytes
may occur only inside opaque pre-horizon audit payloads; the frozen dispatcher
does not classify, parse, or replay them as a semantic mutation arm.

Steady state has exactly one representation. Historical input recognition is
confined to this unit's timestamped scanner, digest-pinned repair, and frozen
migration; those modules are not imported by runtime schemas, readers,
reducers, writers, UI, Preview, SA/MCP, or emitters. The cutover deletes every
alias, fallback, permissive read arm, dual writer, repair-on-load branch, and
saved-draft branch. Runtime code and documentation do not call a supported
shape “legacy”: an old byte shape is either consumed once by the frozen
pre-cutover authority or it is rejected. Source tripwires enforce that
separation and reject imports from the frozen directory into steady-state code.

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
`CasePropertyMapping.case_property`; case-operation writes; case-list column
fields; simple Search properties; and every SA/MCP projection use that exact
schema. A field `id` uses it only when the complete prospective field has a
nonempty `case_property_on`; an ordinary survey field may still be named
`name`. The forbidden names survive only as rejected schema values and frozen
migration inputs, never as a runtime lookup table or canonicalizer.

The executable occurrence manifest inventories those property names in:

- case-type catalog declarations and every catalog XPath/template default;
- every Predicate, ValueExpression, XPath, and Prose case-property leaf;
- field writer pairs and case-operation writes;
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

Persisted Blueprints and accepted mutations contain no incomplete editor row.
Local UI drafts and tool-input assembly may be partial only in separate,
non-domain types; one complete discriminated value commits atomically:

- `Form.connect` is absent or a mode-compatible nonempty config. Every present
  learn-module, assessment, deliver-unit, or task id is required, valid, and
  unique app-wide across every mode-compatible Connect sub-block on every form,
  regardless of subkind. Each uses the shared XML-element-name and 50-character
  schema. `null` exists only in `updateForm` as the clear command and lowers to
  absence. `{}`, a stored `null`, missing ids, and wrong-mode sub-blocks are not
  final schema arms. The frozen migration deletes stored `null` or `{}` only
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

The frozen `#case` matrix is contextual and structural. In followup and close
forms, `#case/<property>` maps to the owning module case type; leading
`parent/` segments traverse only the exact declared parent chain. Registration
permits only `#case/case_id`, mapped to the owning case type's typed `case_id`
reference. Survey forms, a missing module case type, broken ancestry, bare
`#case`, extra path segments, every other registration reference, and any
catalog XPath occurrence block. Reference-looking prose, including
`#case/...`, requires a closed digest-pinned literal/reference disposition and
is never regex-promoted. Text already stored inside a canonical
`ProseTemplate` remains literal. HQ/Vellum output-only `#case` projection stays
emitter-private and is never reparsed into storage or Preview.

Every string found in an AST-only pre-cutover slot is `rewrite-current` only
when the frozen Lezer parser consumes the complete source, every reference
resolves uniquely in the owning form/module scope, the resulting final AST
prints and reparses identically, and Preview plus wire projection are proved
equivalent. The contextual `#case` rules above may change only that friendly
source projection; their emitted XPath remains byte-identical. Syntax-invalid
input, a dangling or ambiguous identity, an illegal form scope, an unsupported
`#case` shape, or printer drift is `block-current`. Prose text remains literal
unless the closed digest-pinned repair manifest explicitly identifies a typed
reference; no generic migration promotes reference-looking prose.

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

After the cutover there is no pre-existing-invalid-document allowance. The
ordinary commit gate requires the complete candidate to have zero findings,
not merely zero newly introduced findings. The strict loader, genesis, baseline
fold, suffix replay, and migration final parse all establish that premise. A
timestamped pre-canonical repair may bypass the final commit path only for its
closed digest-pinned rows and must final-parse its result before commit. The
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

`applyMutations` gives simultaneous case-property rename semantics to all
same-binding `updateField.patch.id` commands in one admitted batch. It derives
the complete old-pair → new-pair relation from the batch-start snapshot,
rejects contradictory mappings, and applies the relation once to batch-start
carriers before ordinary scalar patches and same-batch births settle the final
document. Chains, swaps, destination merges, and a new old-name peer are
therefore independent of command order and require no temporary property id or
persisted intermediate dialect. An explicit same-command binding retarget is
excluded from that relation. `diffDocsToMutations`, undo, and replay use this
same batch authority; round-trip fixtures cover single cascades, chains, swaps,
merges, cross-parent moves, retargets, and newly added peers.

A batch admits at most one ID-bearing patch per field UUID. It rejects one
batch-start `(caseType, property)` source mapped to multiple destinations.
Multiple sources may merge only when the destination existed at batch start and
is not itself renamed; that declaration/value wins and the displaced sources
park. An absent destination or onward-renamed many-to-one target is ambiguous
and rejects. Contradiction rejects the admitted proposal before any carrier
rewrite, reducer result, case-store classification, or side effect. Every
producer and durable replay applies the complete batch once through batch-wise
`applyMutations`; no mutation-by-mutation path may bypass it.

The authoritative writer derives exactly one case-property rename plan per case
type from that same batch-start/final pair and applies it inside the case-store
transaction with schema regeneration. Every destination reads the
pre-migration row snapshot. A pre-existing valid destination value wins and the
displaced source is parked under the existing case-store contract; swaps,
chains, name reuse, and destination merges expose no intermediate key or
schema. Before persisting the Blueprint batch, the guarded commit re-proves that
this exact simultaneous plan is the one prepared.

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
`delete-operational`. The exact SQL columns, including the final
`mutation_fold_baselines` DDL and snapshots, are manifest occurrences.
`form_submission_intents.result.operations[].operationUuid` is an authored
identity even though the intent and entry ids are opaque. Scanner, migrator,
runtime reference index, event parser, mutation coverage, and ephemeral-carrier
cleanup are parity-tested against that manifest. The immutable migration owns
frozen pre-cutover schemas, inventory, parser/printer behavior, and the
option-identity algorithm; it imports no mutable steady-state conversion logic.
Applied-state auditing injects the one current `mutationSchema` plus
`applyMutations` fold authority for the strictly post-baseline suffix. That is
the same contract that admitted those rows and the scanner uses it too; a second
timestamp-frozen steady-state reducer would create a competing mutation dialect
and is forbidden.
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

This cutover establishes a new explicit mutation fold horizon for every app.
All accepted-mutation rows before the new marker remain immutable opaque audit
history, including rows already behind the sequence migration's horizon. The
migration does not pretend an unavailable historical baseline can be replayed.
It converts each app's current stored snapshot atomically and appends one empty,
attributed `kind: "migration"` horizon marker at the resulting sequence. Empty
is intentional here: the marker declares the migrated snapshot as the new fold
baseline; it is not a replayable edit from the incompatible old representation.
In the same transaction it inserts exactly one immutable
`mutation_fold_baselines` row keyed by `(app_id, seq)` and foreign-keyed to that
accepted-mutation row. Its final DDL is `app_id text`, `seq bigint`,
`snapshot jsonb`, `snapshot_digest text`, and `created_at timestamptz(3)`, with
primary key `(app_id, seq)`, a cascading composite foreign key to
`accepted_mutations(app_id, seq)`, and a lowercase SHA-256 digest check. The
baseline stores the complete canonical `PersistableDoc`; its digest is over the
frozen canonical JSON projection. Update/delete triggers make the table
append-only outside schema restore/migration. INSERT authority belongs only to
the frozen migration and atomic app genesis described below; every other runtime
path and the audit probe have read-only access. The row is part of
backup/restore, DDL, ACL, storage-capacity, and occurrence-manifest accounting.

Baseline presence, not `kind: "migration"`, distinguishes a fold-establishing
horizon from a reload-only migration row such as a Project move or the forensic
repair. The scanner selects the greatest baseline sequence for the app, strictly
parses its snapshot, verifies its digest and matching empty attributed marker,
then folds every later batch. Every post-horizon row uses the single strict
mutation schema and must replay from that immutable snapshot to the exact
current scalar/entity state. Future incompatible document migrations establish
their next baseline through this same final table; they never infer one from the
mutable current rows.

A post-baseline accepted row with `kind: "migration"` but no baseline at that
row's sequence is a reload-only edit, not a fold boundary. It may be nonempty —
the Project-move media remap is the named case — and the suffix fold strictly
admits and applies it like any other canonical batch so the folded document
equals current storage. The live stream still treats its migration kind as one
sequence-less terminal reload. Only the exact accepted row referenced by a
`mutation_fold_baselines` entry must have an empty mutation array and supply the
new fold start; a fold must not reject every nonempty migration-kind suffix.

Every app created after the cutover establishes its fold genesis atomically with
the app and entity rows. `createApp` admits and evaluates its optional seed batch
against the empty document, then inserts one empty attributed
`kind: "migration"` accepted marker at sequence `1`, inserts the complete
candidate `PersistableDoc` and digest into `mutation_fold_baselines` at that
sequence, and stores `apps.mutation_seq = 1` in the same transaction. Its
deterministic batch id is `genesis:<app_id>`, its actor is the creating user, and
its run attribution is the creation run. Seed mutations are construction input,
not a second replay dialect; the immutable genesis snapshot is the only fold
start. Empty chat/MCP apps and nonempty builder templates follow the same rule.
The app-creation receipt starts clients at sequence `1`, so the genesis marker
is never replayed as an edit. A baseline INSERT trigger accepts only this exact
same-transaction genesis shape or the frozen migration's horizon shape; update
and delete remain forbidden. Scanner, backup, restore, direct-run migration
idempotence, fresh-database, and app-creation tests cover both migrated horizons
and post-cutover genesis baselines.

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
  references, option identities, `apps.case_types`, `apps.logo`, lookup UUIDv7
  values and edges, and every
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
- all media carriers, library rows, aliases, reverse indexes, thread attachment
  metadata, form intents including result-operation UUIDs, and form attachments;
- every `chat_stream_chunks` row and stream terminal status plus every
  `threads.active_stream_id`, `threads.active_holder_nonce`, and complete app
  lease/reservation state — `status`, `awaiting_input`, `run_id`, every `res_*`
  and `lock_*` column, `run_holder_nonce`, and relevant timestamps — plus every
  presence row, without reading chunk or location content into the report;
- exact row/byte counts, rewrite counts, complete named `pg_catalog`
  definitions for every dependent constraint/index/trigger, planned before and
  after byte volume, the larger transactional/WAL capacity bound, and the latest
  fold horizon for each app.

The frozen plan resolves every typed reference against an app-scoped,
kind-aware ownership index rather than accepting UUID syntax as identity proof.
Uploaded-media carriers additionally resolve to a ready asset in the app's
Project and the allowed slot; lookup carriers resolve to the exact Project table
and column. The migration recomputes both reverse indexes from current carriers
and requires exact equality. Existing canonical AST/template arms receive the
same contextual checks as migrated text. A locked zero-finding scan is therefore
the same admissibility result as the migration, including quiescence, schema,
capacity, event envelope/family, attachment, intent, and holder gates.
Quiescence uses a frozen equivalent of `runLeaseState` over that complete row,
requires zero `present` holders including paused, expired, corrupt, or
nonce-incomplete holders, and gives every settled/reaped reservation remnant an
explicit allowed or blocking disposition. It never substitutes a narrower
“currently live” test.

The topology-repair manifest is closed to the 42 null-parent field rows found
by the advisory scan, across 11 apps; it is not a reusable repair language or a
lineage branch. All 42 are independent roots. They contain 27 case-property
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
reviewed repair writer appends an attributed repair horizon and proves the
resulting document and reverse indexes; it creates no quarantine table, alias,
second reader, orphan sentinel, or compatibility shape. Orphan option and raw
reference counts remain separate from reachable occurrences that the canonical
transform will rewrite. The authoritative locked scan must report zero
topology, illegal catalog-expression, and unresolved-reference findings before
the canonical transform may start.
`lib/db/apps.ts::applyCanonicalIdentityFoundationRepairInTransaction` is the
only repair SQL authority. It accepts an externally owned transaction after the
caller has locked every app in canonical order and accepts only the frozen,
digest-pinned row repair plan. This pre-canonical authority deliberately does
not route the pre-cutover snapshot through the final `PersistableDoc` commit
path. It owns only the exact `apps.case_types`, named entity-row update/delete,
accepted-history/sequence, notification, and reverse-index proof operations;
compares the exact app sequence, source rows, and replacement digests; and
returns proof output without committing. It is not a reusable raw-update API.
The operator script contains no direct `apps` or history DML. Dry-run and apply
invoke this identical authority: rehearsal executes the real writer and every
behavior oracle against PostgreSQL, then rolls the transaction back; apply
commits only after those same proofs pass for all apps. A late injected proof
failure must roll back the exact 42 deletions, two projections, five typed label
references plus one cleared token, two catalog clears, repair horizons, reverse
indexes, and every artifact/byte digest. The authority requires the same
complete app-lease/thread/session quiescence proof as the migration.

The expression-repair manifest is closed to the three reachable live defects
identified by the advisory scan; it is not a reusable repair language. In one
252-byte field label, five distinct form tokens each have one exact same-form
full-path target and become typed field-reference parts. A sixth token has no
exact target or durable lineage evidence; the one same-leaf nested candidate is
not identity proof. The manifest clears that one token occurrence while
preserving every other byte and part. The dangling lookup currently evaluates
to the empty string, so this keeps Preview/device rendering identical for every
form state while removing the invalid output from wire. The source label,
occurrence, and replacement AST are pinned by full digests. Separately, two
case-catalog `validation` slots hold the same 36-byte expression containing a
single form token. It has no exact target in any owning form, and each reachable
writer already owns a different field-specific validation. The manifest clears
exactly those two digest-pinned catalog slots: existing Preview, emitted forms,
case properties, inferred types, schemas/indexes, rows, and operations remain
unchanged, while future fields no longer inherit an invalid contextless
default. It never literalizes an XPath, invents a replacement, or retargets the
one same-leaf candidate.

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
deployments; no destructive Job executes a mutable build tag.

The permanent deployment path has a success latch and a guaranteed maintenance
recovery arm. Any failure after the canonical migration or after automatic
scaling resumes detaches the NEG if attached, restores and verifies manual-zero,
terminates runtime sessions, keeps cleanup paused, and preserves the original
failure. Scheduler state is recorded, restored by a trap on failure, and
rechecked after the cleanup probe; the maintenance execution requires the
pre-existing scheduler to remain `PAUSED`.

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
   append the two orphan-only property projections, delete the 42 exact orphan
   roots, reconcile every affected reverse index, apply the separately reviewed
   expression manifest, and append the attributed repair horizon. That
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
   unresolved-reference findings. A failure rolls that repair transaction back;
   an ambiguous row stops the cutover. The pre-repair backup remains the
   authoritative rollback point. Before merge, arm an
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
   column atomically, migrates typed event attachments, appends all horizon
   markers and immutable fold-baseline rows, deletes every presence and
   `chat_stream_chunks` row, strictly parses
   and rewrites every `lookup_rows.values` object while preserving its exact
   canonical column-UUID keys, converts the SQL columns, rebuilds constraints
   and indexes, and commits only when every invariant and post-horizon baseline
   proof passes. A noncanonical lookup-row key is a locked-scan blocker rather
   than an input to runtime lowercasing. The migration's `down` entrypoint throws
   an explicit forward-only error so Kysely can never remove its ledger row while
   leaving the UUID schema in place. The Job configuration pins
   `maxRetries: 0`; the orchestrator alone may start a later fully refenced
   execution.
5. Still inside the exact new image's migration entrypoint and before service
   deployment, converge to the final explicit database ACL: only the migration,
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

The stream checks the complete row set after a client cursor for a migration
marker before emitting anything. For `cursor C → ordinary C+1 → migration M`,
it emits zero mutation frames, freshly reauthorizes, and sends exactly one
terminal, sequence-less reload. Revocation closes as revoked; transient
reauthorization failure advances no cursor and retries. A post-cutover scan must
report zero current or post-horizon findings. The server strictly parses the
complete post-cursor suffix before emitting any frame and the client parses each
received canonical frame again before reconciliation. An invalid server suffix
emits zero partial frames and one observable sequence-less protocol-failure
terminal, without advancing its cursor. An invalid client frame closes and
disowns the stream and enters the serialized authoritative Blueprint reload
path without advancing the reconciler cursor or invalidating case data; only a
successfully parsed fresh snapshot installs its head sequence. The post-cutover
scanner locates the greatest row in `mutation_fold_baselines`, strictly parses
and digest-checks it and every suffix batch, folds that suffix, and requires
exact scalar/entity equality with the stored snapshot.

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

Verification freezes the complete contract:

- a generated one-representation inventory covers standard case-property names,
  Connect, Search inputs, mapping rows, nested UUID/order topology, case-operation
  facets, owner-only Search provenance, post-submit destinations, date-column
  formats, app-read response keys, builder route tokens, expression/prose/XPath
  projections, and every current protocol-frame family. Persisted carriers are
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
- simultaneous field-property rename fixtures apply admitted batches in every
  command order and prove identical results for chains, swaps, destination
  merges, peer writers, new same-batch old-name births, moves, explicit binding
  retargets, typed references, catalogs, case-list/Search carriers, undo,
  `diffDocsToMutations`, durable replay, and row-migration classification. No
  fixture or emitted batch contains a temporary property name;
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
  form/module rename mutations from the intentional `updateField` id path. A
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
  default; Connect disable and same-mode teardown; `validate_msg`, `validate`,
  `required`, and `case_property_on`; every pre-cutover repair clear; pre-cutover media
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
  post-horizon replay, including a nonempty reload-only Project-move
  `kind: "migration"` suffix that folds normally while the stream reloads and
  only a baseline-referenced marker must be empty; stream marker ordering,
  presence reset, operational
  chunk-log deletion, and frozen migration logic. Direct-run tests invoke
  `runFrozenCanonicalIdentityMigration` twice outside the Kysely-ledger shortcut:
  the second invocation proves the exact already-applied state — one baseline
  marker and `mutation_fold_baselines` row per app, exact sequence/head,
  actor/kind/empty payload, strict suffix replay, carrier digests, and DDL
  definitions — while every partial or mixed applied state rejects. A
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

Documentation moves only where reader-visible behavior or a callable contract
changes. The public MCP reference, including `content/docs/mcp/tools.mdx`, must
show the exact UUID parameters and typed AST/template payloads an API client
actually sends. In this unit, rewrite the conflicting lookup/case-operation
sections of `content/docs/mcp/tools.mdx`: remove the claim that returned lookup
ASTs are withheld, remove mutable operation-id and field-path addresses, and
show the one callable UUID/AST contract. The combined final PR also documents
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
