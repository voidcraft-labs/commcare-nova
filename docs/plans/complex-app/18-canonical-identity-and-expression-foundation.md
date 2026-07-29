# Unit 18 — Canonical identity and expression foundation

**PR:** `Make Nova identity and expression authoring canonical`

**Depends on:** nothing outstanding. · **Blocks:** units 2, 3, 8, and 14.

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
state, not leaked as UUID-shaped authored XPath.

`path-ref` stores only `{ kind: "path-ref", uuid }`. It does not persist
depth-dependent separator bytes. Its printer emits the one canonical absolute
`/data/<current path>` spelling, so a depth-changing move changes only the
projection and reparsing that projection reproduces the identical UUID leaf.
The migration scan rejects a noncanonical legacy absolute-path spelling rather
than silently preserve or normalize it.

Predicate and ValueExpression Search-input leaves store
`{ kind: "input", searchInputUuid }`, including both ordinary term positions and
`when-input-present`. Preview, SQL, and CommCare emission resolve that UUID to
the input's current saved wire name. Renaming an input rewrites no predicate;
removal uses the reference index and the same dependency-confirmation policy as
other referenced entities.

The machine-authoring gate is document-aware, not merely structural. It rejects:

- `raw-ref`, references hidden in XPath text or another legacy
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

The timestamped migration freezes the Lezer grammar, generated parser, legacy
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
table/column/filter references and no dormant inline body. The migration moves
each ordinary field's existing options into the inline arm and converts an
existing lookup override into the lookup arm while deleting its receiver-only
inline fallback. A noncanonical mixed or empty state blocks rather than guessing.
Subsequent source switches replace the complete arm atomically.

Inline select-option UUIDs are required. The migration preserves every
already-canonical option UUID. It recognizes exactly the closed historical
position-derived pseudo-identity `${fieldUuid}-opt-${historicalIndex}` and
replaces it through a frozen genuine RFC UUIDv5 mapping: a checked-in namespace
plus that complete legacy string as the name. The mapping is one-shot migration
projection, not an alias, runtime fallback, or general reminting policy. Missing,
stale-index, or any other noncanonical option identity blocks. Before writing,
the migration proves that every source and target is unique and that no target
collides with any authored identity. Every inline creation, conversion, diff,
media attachment, and reconciliation path then produces complete random UUID
identities; every read-time and non-UUID fallback is deleted.

One frozen schema-derived occurrence manifest makes the cutover total and is
shared byte-for-byte by the advisory scanner, topology forensics, locked scan,
rehearsal, and migration. Every occurrence is classified as rewrite-current,
archive-exact, opaque-pre-horizon, delete-operational, preserve-exact, or DDL;
an unclassified occurrence is a blocker. It covers
Blueprint root scalars, `apps.case_types`, `apps.logo`, every entity and nested
identity, every final `mutationSchema` arm, XPath/template and Predicate
leaves, `events.event` mutation envelopes and conversation attachments, thread
attachment metadata, `chat_stream_chunks` mutation frames, presence locations,
lookup edges, every `lookup_rows.values` JSON object key whose semantic identity
is a `LookupColumnId`, form-intent/attachment references, and the exact SQL
columns.
`form_submission_intents.result.operations[].operationUuid` is an authored
identity even though the intent and entry ids are opaque. Scanner, migrator,
runtime reference index, event parser, mutation coverage, and ephemeral-carrier
cleanup are parity-tested against that manifest. The immutable migration owns
frozen legacy schemas, inventory, parser/printer behavior, reducer inputs, and
option-identity algorithm; it imports no mutable steady-state conversion logic.
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
Every post-horizon row uses the single strict mutation schema and must replay
from that snapshot exactly.

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
- every XPath/template/Predicate carrier in current snapshots and the active
  post-horizon suffix, including the named catalog defaults, hidden references,
  unresolved/raw parts, Search-input-name leaves, and reference-looking legacy
  prose strings that require an explicit literal-text or typed-reference
  disposition rather than inference;
- every `events.event` row whose envelope contains a mutation or typed
  attachment; existing mutation payloads are counted for archival rather than
  guessed into current identity, and raw tool-call/result receipts are counted
  by shape and byte volume but never printed;
- all media carriers, library rows, aliases, reverse indexes, thread attachment
  metadata, form intents including result-operation UUIDs, and form attachments;
- every `chat_stream_chunks` row and stream terminal status plus every
  `threads.active_stream_id` and presence row, without reading chunk or location
  content into the report;
- exact row/byte counts, rewrite counts, DDL dependencies, expected WAL growth,
  and the latest fold horizon for each app.

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

Only unambiguous canonical projections explicitly named above are migratable:
typed reference projection, the exact closed legacy option identity through the
frozen UUIDv5 mapping, and parser-proven catalog XPath. A missing/stale/other
option identity, mismatched key, collision, topology failure, noncanonical
current identity, stale/illegal built-in, ambiguous or unresolved reference,
noncanonical legacy absolute path, or post-horizon replay mismatch blocks the
cutover. There is no lowercasing, general remint, alias, slug/path inference, or
best-effort repair.

The checked-in deployment path is permanent infrastructure, not a
cutover-only branch or flag. At the start of every deploy it records the
service's exact revision set and scaling mode and accepts only one of two
prestates: ordinary automatic scaling, or maintenance-owned manual scaling with
exactly zero instances. `gcloud run deploy` never passes `--scaling=auto`, so it
preserves that prestate while moving 100% traffic to the candidate. The script
then proves that the scaling mode did not change, the expected immutable digest
is Ready and owns 100% traffic, and every old revision owns 0% with no tag.
Finally it always performs the same separate service-level
`--scaling=auto` update and proves that the revision set did not change. On an
ordinary later build the service began automatic, remained automatic, and that
last update is an idempotent no-op; on this maintenance cutover it began
manual-zero and only this step resumes instances, after the exact candidate is
the sole traffic owner. A deployment may not silently translate any other
scaling state.

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
   images/configurations; scheduler and main-trigger state; and migration
   ledger. Neither PITR nor this backup is the authoritative cutover restore
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
   that admits only this exact PR merge and its named main build. Prove no other
   relevant Cloud Build or migration, media-policy, cleanup deployment, or
   cleanup execution is active at quiescence and again before ingress. The
   watcher aborts on any competing merge, trigger, build, or Job execution. The
   quiescence proof also requires no live app holder and no
   `threads.active_stream_id`; terminal-less orphan chunk rows are allowed only
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
   operator-local one-shot watcher keyed to the foundation PR number, frozen
   head SHA, reviewed base SHA, and named main trigger. After exact-head squash
   merge, it resolves the PR's resulting merge commit, verifies its parent/base
   and tree against the frozen merge result, then requires the named main
   build's source commit to equal that merge commit. Only then does it bind the
   build id and immutable Artifact Registry digest from Cloud Build metadata; it
   refuses any revision whose reported digest differs. It may reattach the
   existing NEG only after the later strict runtime proof and exact new-revision
   conditions succeed, then exits after that single action.
4. Only after quiescence, exact-head squash-merge the frozen commit. Its normal
   main trigger builds that exact image, then the migration Job takes
   deterministic all-app locks and one migration-owned transaction and reruns
   the blocking scanner. This scan is authoritative: it records a fresh
   quiescent digest and aborts on any topology/unresolved-reference finding,
   current unmigratable finding, live
   writer, inventory/schema-version mismatch, or capacity bound violation — not
   on ordinary drift from the earlier advisory snapshot. The transaction
   transforms all current snapshots, archives every existing mutation event
   while changing both `events.event.kind` and the projected `events.kind`
   column atomically, migrates typed event attachments, appends all horizon
   markers, deletes every presence and `chat_stream_chunks` row, strictly parses
   and rewrites every `lookup_rows.values` object while preserving its exact
   canonical column-UUID keys, converts the SQL columns, rebuilds constraints
   and indexes, and commits only when every invariant and post-horizon baseline
   proof passes. A noncanonical lookup-row key is a locked-scan blocker rather
   than an input to runtime lowercasing.
5. Still inside the exact new image's migration entrypoint and before service
   deployment, converge to the final explicit database ACL: only the migration,
   runtime, and cleanup identities regain their intended `CONNECT` and
   least-privilege grants; `PUBLIC` and incidental operator logins do not.
   Keep the service at manual zero with no traffic tags, terminate any direct
   runtime-login session again, and prove none exists after the grant. From the
   migration connection, `SET ROLE` to the runtime database role and run the
   zero-finding steady-state parser plus an authorization-aware app read and
   rollback-only synthetic write through the real membership/commit primitives,
   using an existing Project member without emitting their data. This proves the
   final runtime privileges while no old runtime process can reconnect. Record
   the authoritative digest.
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
   `--scaling=auto` update, prove that it created no revision, and verify the
   expected automatic minimum/maximum scaling. Because only the exact new
   revision owns traffic, it is the only revision that can start. Prove its
   fresh runtime-login connection and authorization-aware read before the build
   may continue. If any post-migration Cloud Build phase fails, ingress and
   cleanup stay paused; return the service to manual zero and terminate runtime
   sessions. Before ingress resumes, the authoritative in-place backup restore
   remains available.
7. Only after steps 5–6 succeed does the armed one-shot reattach `nova-neg`; that
   timestamp is the recorded rollback cutoff because public writes may begin
   immediately. Cloud Build's retrying public-host probes then verify routing,
   and the operator runs the post-cutover zero scan and inspects error logs.
   Any failure in those probes, scan, or log gate immediately detaches the NEG,
   returns the service to manual zero, terminates runtime sessions, and leaves
   cleanup paused before fix-forward begins. Resume the cleanup scheduler only
   after every check passes. The watcher is disposable operator orchestration,
   never checked-in runtime or deployment machinery.

Rollback before the all-app repair transaction commits, including an earlier
build/media-policy failure, is transaction rollback plus restoring and
verifying the recorded pre-fence database ACL, old media-policy and
capture-cleanup Job images/configuration, and scheduler state. Route 100% to the
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
then explicitly reapply and verify the recorded pre-fence ACL because the
authoritative backup contains the fenced ACL. Restore the recorded old service
and cleanup images, 100%-old-revision traffic, traffic tags, automatic scaling,
every Job configuration, and scheduler state; prove both old workload schemas
while ingress remains closed.

The merge/build freeze remains in force through either rollback path. Returning
to old production is not complete while Unit 18 still sits on `main`: revert the
exact merge, require the named main trigger's source commit to equal that revert
commit, and verify its old service image, migration ledger behavior, all three
Job configurations, and restored database together before restoring ingress
and releasing the freeze. Before triggering that revert build, arm a fresh
one-shot rollback watcher keyed to the exact revert commit, named build, and
recorded old image digest. The NEG remains detached through the restore, old
schema/ledger/Job proofs, and the revert build's deploy. Reverting Unit 18 also
restores the prior `cloudbuild.yaml`, whose public-host verification begins
immediately after deploy and retries for a bounded window. Once the watcher
observes that exact revert build's deploy step complete, the recorded old digest
Ready at 100%, the restored database and all three Jobs proven together, and no
competing source/build/job activity, it reattaches the existing NEG exactly once
while those public retries are still active. Those probes must then pass inside
the build; the revert build cannot turn green on internal evidence alone. A
missed retry window or any failed/mismatched proof fails the build, detaches the
NEG again if necessary, returns the service to manual zero, terminates runtime
sessions, and keeps cleanup paused. This is the rollback path's only ingress
reattachment point. The alternative is to keep ingress closed and fix forward
from the merged source. Old production never reopens with the strict new source
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
report zero current or post-horizon findings.

The SQL UUID conversion covers semantic authored identity columns only:
`apps.logo`, `blueprint_entities.uuid`, `blueprint_entities.parent_uuid`,
`media_assets.id`, both media-upload-alias asset ids, media reverse-index asset
ids, `form_submission_intents.form_uuid`, and
`form_attachments.field_uuid`. It rebuilds every dependent FK, index, trigger,
and Kysely type and does not infer semantics from an `*_id` suffix. The nested
`form_submission_intents.result.operations[].operationUuid` conversion is part
of the same transaction but remains JSON, not a pretend SQL identity column.

Verification freezes the complete contract:

- UUID version/variant/case matrices, strict lookup UUIDv7, record-key equality,
  exact topology closure (orphans, cycles, missing/wrong-kind parents,
  duplicate/stray memberships), context-aware nested refs, strict routes/tools,
  and throwing narrowers;
- XPath/template parser-printer fuzz, canonical depth-changing `path-ref` moves,
  adversarial hidden references, cross-form and wrong-kind refs, same-call UUID
  construction, legal reference-only forward refs, rejected later-producer
  `id-of`/effect dependencies, Search-input UUID projection, frozen Lezer
  catalog-string conversion/refusal, friendly human XPath projection, and
  structural rename/move;
- horizon migration fixtures for every root/entity/carrier and mutation family,
  catalog defaults, the exact five-reference/one-token-clear prose repair, the
  exact two-slot catalog-validation clear, canonical-option preservation, exact
  legacy-option UUIDv5 replacement, missing/stale/other refusal, source/target
  injectivity and global collision checks, forensic-manifest
  before-digest/ref/consumer proofs,
  semantic JSONB plus exact canonical
  `jsonb::text` preservation of each nested archived event payload, strict
  post-cutover mutation events, typed event attachment migration, form-intent
  result operations, canonical `lookup_rows.values` key coverage and
  noncanonical-key refusal, idempotence, rollback, all-app atomicity, exact
  post-horizon replay, stream marker ordering, presence reset, operational
  chunk-log deletion, and frozen migration logic;
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
  than count-only coverage;
- offline schema generation and size budgets, with the paid provider acceptance
  sweep run only after explicit approval; targeted, changed, leak, type, lint,
  build, browser, full-CI, production-probe, and error-log evidence.

Documentation moves only where reader-visible behavior or a callable contract
changes. The public MCP reference, including `content/docs/mcp/tools.mdx`, must
show the exact UUID parameters and typed AST/template payloads an API client
actually sends. Existing builder/user pages such as `case-changes.mdx` and
`display-conditions.mdx` change only if an instruction or example becomes stale;
they continue to teach friendly names and human XPath, never the internal
storage architecture. Public media documentation changes only for real
authoring choices such as catalog icon slugs versus uploaded assets. Internal
contracts and subtree engineering docs own the UUID-backed projection
explanation. Unit 3 later documents only the new condition and lookup vocabulary
it adds.

**Observed:** the builder can show friendly current names while every persisted
and machine-authored reference remains an immutable UUID-backed value; renaming,
moving, or reordering an object changes only projections, never retargets stored
logic, and no Nova authoring boundary admits a slug, path, tag, wire name,
position, or arbitrary string in place of owned identity.
