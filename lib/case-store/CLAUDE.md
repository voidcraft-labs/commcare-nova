# lib/case-store — Postgres case store

The runtime storage layer for case data. Cloud SQL Postgres is the
live runtime; the AST→Kysely compiler from `lib/domain/predicate`
is the only evaluator. There is no in-memory variant, no parallel
JS evaluator, no parity tests.

## Public surface — barrel

External consumers import from the `@/lib/case-store` barrel: the `CaseStore` / `SchemaCaseStore` interfaces, row/arg/result types, the two production constructors (`withProjectContext(projectId, actorUserId, ownerId)` — the tenant-bound reads/writes store with both identities explicit; `withSchemaContext()` — the actor-free, app-scoped schema-ops store with a dynamic current-Project fence), the typed error classes, and JSONB value types. The implementation, sample generator, and test harness stay package-private; tests reach them via subpath.

`casePropertyRenamePreflight.ts` is the narrow read-only exception used by the
builder's app-wide rename review. Its in-transaction reader accepts an already
admitted simultaneous relation and returns counts only: distinct live rows,
parked rows including dismissed entries, per-source counts, and exact
destination-occupancy groups. It filters by `app_id` only—never Project,
owner, hold, or dismissal—and JSONB own-key presence makes null and blank
destinations occupied. The caller owns the transaction so authorization,
Blueprint sequence, lookup verdict, and counts share one request; the result
is explanatory and never substitutes for rename Phase A's locked recheck.

`CaseStore.readDeviceCaseDatabase` is the running Preview's complete casedb
read. It applies the bound worker's restore closure across every retained case
type, including types no longer present in the active Blueprint, and returns
the visible rows plus their direct parent/custom index edges under one
repeatable-read transaction. It never accepts a caller-supplied case-id list;
both endpoints of every edge are re-fenced by app and bound Project in SQL.
Each edge persists `target_case_type`, matching Core's
`CaseIndex.mTargetCaseType`: the type is captured when the relationship is
written and never re-derived from the target row on read, so a later target
retype does not alter casedb `@case_type` metadata. The
`20260825000000_case_index_target_type` migration backfills historical edges
from their target rows, refuses dangling edges it cannot backfill, and makes
the column required for every future writer.

**The case-type map is the MATERIALIZABLE view.** `buildCaseTypeMap` builds from `lib/domain/effectiveCaseTypes.ts::materializableCaseTypes` — writer-DERIVED property types included, whether the writer is a field or a typed case operation (the compiler's casts stay in lockstep with the type checker), and implicit standard entries excluded. A standard entry explicitly declared in the catalog remains for its authoring metadata and order, but both storage projections filter every `CASE_SCALAR_PROPERTY_NAMES` member: `caseTypeToJsonSchema` never emits it into the closed JSONB schema, and `computeDesiredIndexSet` never emits a JSONB expression index for it. Standard-name references resolve through `sql/dataTypeTokens.ts::RESERVED_SCALAR_COLUMN_BY_PROPERTY` — the exact Nova name→column map (`case_name`→`case_name`, `date_opened`→`opened_on`, `last_modified`→`modified_on`, `external_id`→`external_id`, plus `status`/`owner_id`/`case_id`/`case_type`) — consumed by `compileTerm`, the predicate `is-blank` arm (timestamp columns collapse it to plain `IS NULL`), and the preview display seam (`caseRowDisplayValue`), so a standard name every checker admits also queries, filters, and displays from its first-class column. No live alternate-name projection exists.

**Runtime operation targets are resolved facts, never client descriptors.** `caseOperationTargetRequestSchema` accepts only `{ caseId }`. The envelope executor (`postgres/submissionEnvelope.ts`) loads the row through the tenant-bound pre-submission snapshot and then calls `validateCaseOperationTargetDescriptor(request, resolved, expected)` with server-owned `{ caseId, caseType, projectId }` plus the expected `{ projectId, snapshotCaseType }` from `caseOperationExpressionSnapshotTypes`. That snapshot type is intentionally distinct from the operation's rolling semantic type after an earlier retype. Parse failure, absence, id mismatch, and foreign tenancy intentionally collapse to `not-found-or-out-of-scope`; a type mismatch is reported only after Project authorization succeeds. The seam itself stays pure; its live callers are the executor's expression-target arms.

**Case ids are opaque CommCare wire identities, not intrinsically UUIDs.** The authored-key identity contract deliberately admits deterministic ids such as `nova-case-v1:<namespace-uuid>:external-123`; `idFrom` is an exact authored key inside that Nova-owned app/form/operation/type namespace, never a raw global CommCare id. Storage matches the contract: the whole identity family — `cases.case_id`, `parent_case_id`, `case_indices.{case_id,ancestor_id}`, `parked_case_values.case_id`, plus its PK/indexes and the one FK — is `text` (the `20260724030000_opaque_case_ids` migration, which resolves the `cases` schema explicitly because privilege convergence relocates it), Nova-generated ids default to `uuidv7()::text`, and no UUID cast or UUID-only parser survives in the read/write path. Two consequences are load-bearing: the durable default ordering is `(opened_on, case_id)` ascending — `PostgresCaseStore.query` emits it explicitly when no sort is supplied, and the preview sort-key builder leads its unsorted arms with `date_opened` — because ids carry NO time order; and the builder URL is the one boundary a case id crosses as a path segment, percent-encoded by `lib/routing/location.ts::serializePath` and decoded by `parsePathToLocation`. `scripts/scan-case-id-storage.ts` reports the family's state and the non-UUID-shaped value census (read-only; run it as the pre/post check around the widening and as the production rescan).

## The atomic submission envelope — `applySubmission`

Every `applySubmission` transaction first claims the
`(app, Project, actor, entry_key)` idempotency row under the entry advisory
lock, independently of attachment presence. A new claim checks the committed
app sequence before any case effect; a matching completed claim returns its
stored result before that fresh-claim fence or current topology, while a
different form/digest rejects. The receipt is completed in the same transaction
as the ordinary and advanced effects. A case failure therefore rolls back the
uncompleted claim and every case write; two concurrent first requests serialize,
and only one can allocate generated case identities.

The accepted result records each ordinary child as
`{ authoredChildIndex, parentCaseId, caseId }`, one record for every authored
child and selected/generated parent in child-major then parent-selection order.
No live consumer reconstructs either identity from a flat array position.
Historical receipts with only flat child ids remain replayable for provenance,
but cannot supply authored-child metadata. The result also carries the exact
post-effect device patch: every affected ordinary case, child, executed operation target, and worker usercase,
plus their direct index edges, is read inside that same transaction before the
receipt completes. The JSONB receipt owns that patch, and replay rehydrates its
timestamps to the live `CaseRow` types. The patch also carries the stored
property-type map for every returned row case type, so a Preview casedb can
preserve typed lexical semantics after a type leaves the active blueprint.
The result stores the exact committed-blueprint digest used to derive its
program and routing topology; callers may replay effects across later app
edits, but must not choose a next screen from a different digest. Callers must not reconstruct accepted
state with a later `readCaseDatabasePatch`; that would mix the submission with
a later writer and can drop a just-closed case from a fresh device restore.

When the server also supplies a capture intent, it first runs the DB-first
pre-acceptance durability seam in `submissionAttachments.ts`: under the entry
lock, exact selected `staged` rows become `preparing` before any external copy.
A bounded worker copies each immutable generation to its deterministic
create-only durable key, verifies size/CRC32C/type/generation, and records
`prepared`. The scheduled five-minute worker leases the same recovery rows, so
a request crash after copy but before row update is exhaustively rediscoverable
by deterministic destination verification. The later mandatory receipt
transaction re-proves exact structured attachment references and atomically
moves those `prepared` rows to `submitted` beside the receipt and case effects.
Before acceptance, each row's immutable filename/extension/content type is
re-proved against the capture kind and accepted-format table in the committed
snapshot, so a stable UUID/path cannot carry image bytes after a peer changes
the field to audio. There is no post-commit GCS await: accepted case effects
categorically point at a verified durable generation outside the staging
lifecycle prefix.

`CaseStore.applySubmission` applies one whole form submission — the ordinary form action (registration primary+children, followup update+children, close including final writes) plus the advanced case-operation program — in ONE transaction under the standard lock order (authorize → relationship advisory → schema locks sorted up front; a followup/close bound case's type is discovered inside the update core, the same pattern `update` uses). The executor (`postgres/submissionEnvelope.ts`) mirrors the XForm emission in `lib/commcare/xform/caseOps.ts` phase for phase: expand the authored `(order, uuid)` sequence over the physical multiplicity scopes (root first, then repeats iteration-major — form-level operations once per authored iteration, followed by only the session-targeted operations for each selected case in order; the caller supplies per-iteration form-answer bindings plus the doc-level analysis from `lib/doc/caseOperationOrder.ts`, since the blueprint never crosses this boundary); allocate every create identity in TypeScript before any evaluation (generated ids mint `uuidv7()`; authored keys run the shared `deriveAuthoredCaseId` and abort on blank/over-205 keys BEFORE any DML — the pinned TS↔XPath identity vector runs against this executor); evaluate every condition, value, and runtime target through the AST→Kysely compiler anchored on the selected case for session-targeted operations and anchor-free for form-level operations (the advisory lock plus evaluate-before-effects gives every expression the same pre-submission snapshot the device's calculates see; `TermBindings.actingUserId` is populated from the store's bound actor, never the client); resolve and reauthorize targets (`session` = that selected case, `op` = the transaction's allocation record, `expression` = tenant-bound load + `validateCaseOperationTargetDescriptor` against the immutable snapshot type, with expression targets inheriting the running app's hold exclusion); then run `validateResolvedCaseOperationTypeSequence` over the whole server-resolved sequence — including the ordinary action as a final implicit type consumer when it is type-sensitive — before the first write. Effects apply in physical order (per operation: create → property writes → rename/retype → close → links; the ordinary action last, matching the wire where advanced blocks precede the ordinary `FormActions` block). Every evaluated fixed-text scalar passes through `prepareCaseScalarTextValue`: boundary U+0000..U+0020 code units are removed and the 255 UTF-16-unit cap is enforced; create-name, rename, and owner reject blank, while `external_id` keeps an explicit blank as `""`. Ordinary field writes use the same contract. `case_name` and `external_id` route to dedicated row columns across single/bulk create, update, merge, and retype and never enter JSONB. Retype executes ONLY the wirePortable subset, applied with the operation's writes and rename as ONE unit — the wire emits them in a single `<update>` block, so writes are typed against the DESTINATION declaration and the case ends as the destination type carrying them; a retained document (properties minus source-schema orphans, the same proof the update merge sheds by) the destination schema cannot hold rejects the envelope — never a conversion/parking plan. Link CRUD is identifier-keyed (delete-then-insert; null target removes) and persists the AUTHORED `child`/`extension` relationship; a `parent` identifier also maintains the denormalized `parent_case_id`. A duplicate authored id merges create-of-existing style — onto a prior submission's row or onto a row this same envelope created. Multi-select answers serialize to JSONB arrays explicitly, and a BLANK-evaluated custom-property write (SQL NULL, `''`, an empty selection) projects to key-absent — omitted on create, REMOVED from the stored document on update — because the wire's `''` write has no representable typed-storage form and Nova's two-state collapse reads absent as blank (`storageValueFromEvaluation`). A link-only operation still advances `modified_on`, the wire's per-block `@date_modified` stamp. Any failure rolls the entire submission back with a typed error: `SubmissionRejectedError` (a discriminated `rejection` union: authored-key, text-value, target, sequence, retype-not-portable) for operation-contract rejections, the standard typed errors otherwise — partial success is unobservable. The production supplier is `lib/preview`'s `buildSubmissionOperationProgram` (one authorized committed-doc snapshot, capture authority, durable receipt identity, and the engine's collected per-scope answers); the program is exercised by `postgres/__tests__/submissionEnvelope.test.ts` and end-to-end by the preview acceptance suite.

The committed-doc builder also projects each ordinary child's
`CaseType.relationship` even when there are no advanced operations. The client
cannot assert it, and the envelope persists the canonical `parent` edge as
`child` or `extension` exactly like the XForm.

**The operation program is also the external-data compiler-context boundary.** Its optional `lookupTableSchemas` is the rows-free `tableId → columnId → dataType` projection from one Project-authorized definitions snapshot. Preview derives the exact table ids from canonical lookup-reference occurrences whose carrier UUID belongs to the built form's operations, using the same committed blueprint that produced the program; a carrier-free program performs no definition read. `evaluateBatch` threads this one map into every condition, value, runtime target, write guard, and link target, and the schema-healing wrapper retries `applySubmission` with the same envelope object and map. It also threads the committed organization-level hierarchy: a fixed-place owner evaluates to the same UUID stored in `app_locations` and emitted as the fixture `@id`, while a reverse owner hop walks the selected case owner's live ancestor branch to the admitted unique destination level. Never fetch definitions or organization shape from inside individual expression arms or substitute a fallback type: lookup governance keeps referenced table/column identities and types stable, organization admission makes reverse hops scalar, and `lookup_rows` plus `app_locations` remain current tenant-bound reads inside the submission transaction.

Retype planning lives in `lib/domain/caseRetype.ts::planCaseRetype`. Its richer storage plan describes exact retained JSON properties, casts, parking, and missing requirements; scalar row metadata such as `case_name` is excluded because it survives independently of the JSON schema. Its `safe` verdict means Nova can execute that plan atomically, while `wirePortable` is deliberately stricter: no conversion and no parking. Authored operations are admitted only under `wirePortable`, because CommCare's case XML retype changes `case_type` without casting or removing old property values, and the authoritative submission transaction executes exactly that subset (`postgres/submissionEnvelope.ts::applyRetypeEffect`). Conversion/parking retypes stay dormant until a shared wire representation can make the device and Nova projection agree; if that representation lands, execute the complete plan as one transaction and surface parked values through Data to review. Never implement a richer retype as a bare `case_type` update around the schema store.

**Schema drift after a derivation change is a scan-then-migrate.** Stored `case_type_schemas` rows converge to the CURRENT derivation only when an edit touches their case type — `classifyCaseTypeChanges` diffs prior-vs-prospective views that both already carry the new derivation, so a deploy that changes what schemas derive FROM leaves stored rows stale until `scripts/scan-schema-drift.ts` (read-only sizing) + `scripts/migrate-schema-drift.ts --execute` (per-property `retype` migrations — uncastable values park — then a plain re-sync per case type) run over the old data.

Historical ordinary extension edges follow the same scan-then-migrate rule.
Before automations, ordinary parent writes always persisted `child`; advanced
case-operation links already persisted their authored relationship and may own
the same `parent` identifier, so a catalog-wide rewrite is forbidden.
`scan-case-parent-relationships.ts` classifies each current extension edge from
same-Project topology, durable ordinary-child receipts, any executed operation
touch, and ancestry mutations. The paired writer requires traffic cutover,
takes the app then relationship locks, reclassifies, and compare-and-sets only
`repairable-ordinary` rows. Unknown, operation-touched, catalog-changed, and
noncanonical rows remain loud refusals. Generic `CaseStore.update` likewise
requires an explicit relationship for every non-null parent assignment and can
repair a same-parent stale edge; it never preserves an old value or guesses
from the current catalog.

**One deliberate exception:** the connection layer's `getCaseStorePool()` (subpath `@/lib/case-store/postgres/connection`) is a runtime export the auth layer (`lib/auth.ts`, `lib/auth/db.ts`) imports so Better Auth runs on the SAME `pg.Pool` — one pool per instance is what keeps the connection budget (`enforceConnectionBudget`) intact. Do not route it through the barrel or "tidy" it back to tests-only; the pool-sharing the budget depends on is the reason it's exposed.

## Creation stamps — every insert path sets `opened_on` + `modified_on`

All insert paths (`insert`, the submission envelope's row creates, the
package-private bulk path the sample generator rides) default `opened_on` AND
`modified_on` to the insert's server time (`postgres/store.ts::creationStamps`),
mirroring
CommCare's case lifecycle — a device stamps `date_opened` and `last_modified`
the moment a case is created, no sync involved. An explicit caller value
wins. `update`/`close` re-stamp `modified_on`. Without this, the standard-name
standard scalar projections read blank on freshly created rows in every case list, filter, and
sort.

## Case lifecycle is one storage operation

`CaseStore.close()` owns both halves of the built-in lifecycle transition:
it stamps `closed_on = now()` and `status = "closed"` together. Callers never
choose a close status; CommCare's `@status` vocabulary is the lifecycle value,
not an app-defined workflow stage. A retry over a consistent closed row is
idempotent. Re-closing a row left inconsistent by the former close path repairs
its status while preserving the original `closed_on` and `modified_on` event
times. Historical import and deliberate recovery/reopen flows use `update()`
and explicitly pair their intended values (for example,
`{ status: "open", closed_on: null }`).

The former preview path can have persisted closed rows whose status stayed
`open`. Deploy this invariant with the required one-off data choreography:
`scripts/scan-case-lifecycle-status.ts` (read-only sizing),
`scripts/migrate-case-lifecycle-status.ts` (dry-run, then `--execute` in an
explicit write-capable environment), then the scan again to zero. The repair
changes only `status`; it preserves the already-correct lifecycle timestamps.

## No preview mode — the running-app view shares the editor's rows

The running-app view reads the SAME `cases` rows the editor
inspects — no `InMemoryCaseStore`, no per-session lifecycle;
The builder's centralized **Case data** manager creates or replaces real rows;
replacement includes hand-entered and Preview-entered cases and requires an
explicit destructive confirmation. Replacing a parent case type preserves its
surviving children but atomically detaches them (`parent_case_id = null` and
removes the corresponding `case_indices` edges); it never cascades deletion
into another case type or invents random relationships to the new sample rows.

Automation matching is another read over these same rows, not an execution
runtime. `countCases({ automationCriteria })` composes the automation kind's
ordinary property criteria, case-update closed-parent criterion, and each
organization-backed location owner set into one tenant-bound SQL count and
always limits the outer case to `status = "open"`. Closed-parent relation walks
bind both sides to the store's app and Project. Structurally distinct setup-only
UCR/registered-custom criteria
and HQ server-modified age never enter SQL; `lib/automations/matching.ts` names
those omissions in the result. No case-store method updates a case, sends a
message, or advances a schedule on an automation's behalf.

Three property-comparison families bypass the generic Predicate compiler to retain HQ's
runtime value rules. **Equals / does not equal** compares the criterion only
with a stored JSON string. A JSON number `5` does not equal criterion `5`, and
numbers, booleans, objects, arrays, null, and missing values satisfy does-not-equal.
A parent comparison follows every depth-one `parent` identifier regardless of
child/extension relationship. A valid host comparison has exactly one possible
canonical extension: the app gate refuses host-scoped automation reads when an
advanced case operation can add another extension index to that case type,
because HQ leaves host ordering undefined. Historical rows can retain a second
extension after the operation that authored it is removed, so a count whose
matching criteria read the host returns both its match aggregate and an
ambiguity aggregate in one PostgreSQL statement snapshot. Any otherwise-visible open target row with
more than one distinct depth-one extension host refuses the count; closed rows,
held rows, other case types, other apps, and other Projects cannot trigger it.
The SQL resolver still chooses the canonical `parent` extension first, then
identifier and target order, as a total defensive behavior for documents and
queries outside that authoritative Preview count; no reported count depends on
that ordering. Missing relations do not match either comparison,
while a missing property on an existing related case matches does-not-equal as
HQ does. **Has value / has no value** treats a string containing only Python
`str.strip()` whitespace as blank while non-string JSON scalars have a value,
including through case-update parent/host relations; a missing relation has no
value. The SQL uses that explicit Unicode trim repertoire rather than
PostgreSQL's locale-dependent POSIX whitespace class.
Alert regex uses
HQ's beginning-anchored behavior and evaluates stored strings only; it never
casts a number or boolean to text. PostgreSQL evaluation runs under C collation;
the admitted pattern is lowered to absolute-start ARE syntax, unescaped dots
outside classes exclude LF, and `$` accepts absolute end or exactly one final
LF. PostgreSQL's newline-sensitive modes are not used because they would also
change negated-class behavior that Python leaves alone. Closed-parent is fixed to the standard
depth-one `parent` child index accepted by HQ's setup form. A location clause
is one exact owner-id set derived before the query from the selected place,
its requested descendants, and personas whose primary place is in that set;
the SQL layer combines it under the same ALL/ANY operator and does not read the
organization store independently.
**Day-offset date comparisons** use this same automation-specific relation
resolver rather than the generic identifier path. `parent` follows the
depth-one `parent` identifier regardless of relationship; `host` follows the
same sole-extension contract and defensive resolver used above, so a child
link merely named `host` cannot match. HQ converts every resolved datetime to its own calendar
date before adding the signed day offset. Nova therefore takes an ISO value's
leading `YYYY-MM-DD` component (preserving an explicit offset's authored day),
truncates standard UTC timestamps in UTC, and compares UTC today as a date; it
never preserves the time of day or lets the Postgres session timezone shift it.
An automation criteria group is never dropped merely because every locally
evaluable collection is empty: the SQL lowering preserves Python/HQ's boolean
identity exactly, so `ALL` of zero local criteria is true and `ANY` of zero is
false. Setup-only omissions remain named separately and never turn empty `ANY`
into an all-open count.

## Tenant scoping is structural — `(app_id, project_id)`; `owner_id` is a second axis

Case data is shared at **Project** scope. Every tenant-bound
`CaseStore` carries a Project id resolved (and membership-gated) at
the request boundary; `withProjectContext(projectId, actorUserId, ownerId)`
is the construction path, and every read/write internally adds
`WHERE project_id = <bound>` so a new method inherits the filter
automatically. The compiler stack (`./sql/`) handles the JOIN-side
`project_id` filter on every `cases` row inside relation walks (see
`./sql/compileRelationPath.ts`); `PostgresCaseStore` owns the
outer-scan filter on every method. The two halves combine to make
cross-Project reads structurally impossible.

The request gate is only a read optimization, never a write authority. Every
actor mutation reauthorizes inside its own case transaction in this lock order:
`apps FOR SHARE` → shared membership gate + exact membership row → relationship
advisory lock → all involved `case_type_schemas` rows in sorted order → case
rows. The transaction rejects a store whose bound Project no longer matches
the freshly locked app. `update` first discovers immutable `case_type`, then
takes the schema lock and re-reads the row `FOR UPDATE`; registration locks all
primary/child schemas before its first insert. Restore, dismiss, replace,
close, populate, and reset use the same fence. Parked-value replace updates the
case and archives the review entry in one transaction.

`owner_id` is the **CommCare case-owner** — a SEPARATE axis written
on every insert, reserved for future
location-/group-based access carving. It is never a tenant filter and
never to be repurposed/dropped. The two axes are orthogonal:
`project_id` (tenant / sharing) × `owner_id` (case ownership).

### Restore scope — ownership seeds a fixpoint, it does not filter

`QueryArgs.restoreScope` narrows a read to what one worker's device would
actually hold. It is NOT `owner_id IN (…)` and cannot be written as one:
CommCare's restore takes a FIXPOINT over the case-index graph that ownership
only SEEDS (`casexml/apps/phone/data_providers/case/livequery.py::get_live_case_ids_and_indices`),
so an owned child pulls in its closed parent, that parent pulls in its own open
extensions, and a closed HOST kills its extension chain. `sql/compileRestoreScope.ts`
is the rule, carries the citations, and is pinned against all 45 graphs of HQ's
own `case_relationship_tests.json` — the oracle is that FILE, not `livequery.py`'s
module docstring, whose eighth example the pinned fixtures contradict.

`QueryArgs.parentCases` / the case-type arm of `CountArgs.parentCases` is a
separate running-menu constraint: an ordered, unique set of at most 100 parent
ids plus its declared case type. One id is the ordinary parent-first flow;
several produce the union of direct depth-one non-extension children. The SQL
first proves the COMPLETE parent set belongs to the same app and bound Project
and has the declared type. Any missing, foreign-Project, or wrong-type member
makes the whole constraint false, so a crafted partial set can never widen or
silently reinterpret the child population.

Four things about it that are load-bearing:

- **Absent means the whole tenant, and that is a contract rather than a
  default.** Authoring surfaces — the case workspace, sample data, the rename
  preflight, the automation sweep — read the tenant because none of them is
  standing at a device. Only the RUNNING preview passes a scope. `loadCaseDataAction`
  serves both, which is why it takes an explicit `deviceScoped` argument
  instead of deriving one.
- **Relation walks carry it too.** `whereVisible` applies the hold and the
  restore together at every walked `cases` row, and `relationPathContextFrom`
  is the ONE place the walk's context field list lives. Scoping only the outer
  scan leaves a list faithful at the top level and wrong one hop down, where
  nothing on screen reveals it.
- **The CTEs attach to the OUTERMOST statement only.** A Kysely creator carries
  its `WITH` clause into every query built from it, so handing the CTE-bearing
  creator to the compile context gives each leaf subquery its own copy of the
  closure. The compile context takes the plain handle.
- **The hold is an outer filter, never a graph filter.** A held case stays out
  of the list and still relays liveness, because restore membership is a fact
  about the device and parking one property value must not drop a whole
  extension subtree from view.

**Open means "not closed", never `status = 'open'`.** `cases.status` is
nullable with no database default and optional on insert, so a great many rows
carry NULL and equality silently erases every one of them. Every lifecycle
read is `is distinct from 'closed'`. The direction of the mistake decides how
bad it is: in the automation host-ambiguity probe — which exists to REFUSE a
count it cannot resolve — the miss failed OPEN, letting the count run on an
ambiguous population.

**The bound store carries two identities, and they are not
interchangeable.** `withProjectContext(projectId, actorUserId, ownerId)`
binds `actorUserId` — the Nova member — as the identity EVERY
authorization fence keys on, and `ownerId` as
the CommCare worker whose `owner_id` new rows carry and whom
`acting-user` resolves to. Previewing as a persona is exactly this split:
the worker is a persona UUID, which is authored blueprint content, while
the signed-in member still authorizes; previewing as the member passes the
same id in both slots explicitly. `requireActorUserId()` and
`requireOwnerId()` are separate on purpose — collapsing them would let an
app choose whose data a request reads. The constructor is the trust boundary:
every supplied Project, actor, and owner identifier must be a nonblank string
before a query builder can exist, so `undefined`, blank, and forged selectors
cannot fall through into an ownerless or unauthenticated query. Persona selectors
never cross this boundary directly; the authorized committed-blueprint resolver
turns one into the explicit actor/owner pair first.

`CaseStore.count` also has an owner-wide arm used by persona removal. It counts
every retained row for `(project_id, app_id, owner_id)` across current and retired
case types and includes held rows when requested; it deliberately requires no
materialized case schema because `owner_id` is a reserved scalar. The builder
does not enable persona removal until that exact count succeeds, and a retry
re-runs the same authorized snapshot flow.

**Schema row work is the deliberate app-scoped exception.** `applySchemaChange`
(the `SchemaCaseStore` slice, built by `withSchemaContext()`) and guarded
case-type retirement migrate or fence
EVERY member's rows of an app's case type, so their per-row
migrations filter `(app_id, case_type)` ONLY — no `project_id` /
`owner_id`. The store binds no actor or construction-time Project, but every
standalone schema mutation starts with `apps FOR SHARE`, rejects a missing or
deleted app, and holds the app's current Project placement stable through its
schema/data transaction. Hard schema deletion exists only as the package-private
`PostgresCaseStore.purgeSchemaForMaintenance` escape hatch used by maintenance
tests; neither public store interface nor `withSchemaContext()` exposes it, so
ordinary consumers cannot erase the archived contract or its sequence fence.
Explicit case-property rename instead composes its
Phase A directly into the guarded writer's already app-locked, authorized
transaction.

**Re-tenanting is the second, narrower exception — `retenant.ts`.**
Its transaction-injected primitive rewrites `cases.project_id` only from the
app-locked, Project-authorized move and same-Project recovery transactions in
`lib/db/apps.ts`; it has no standalone connection-owning wrapper or package
barrel export. A cross-Project move updates cases before the app Project flip,
then commits both on the same physical transaction with blueprint and thread
media remap, presence purge, the migration batch, and notifications. The
deferred composite cases→apps FK permits that intermediate order while making a
split committed placement impossible. Exact same-Project recovery takes the app
lock, derives the fresh app Project rather than trusting a caller value, and
uses the same primitive as a case-only repair; it writes no migration row and
purges no presence. Only `cases` carries `project_id`, so that update is the
complete case-store portion of either transaction.

## Typed error contract

User-domain errors (`./errors.ts`) carry `instanceof` discrimination so routes map them to typed result arms. Non-obvious rules: `CaseNotFoundError`'s message deliberately does NOT distinguish "outside the bound Project" from "never existed" — tenant boundaries stay structural, never message-leaked. `CasePropertiesValidationError`'s structured `failures` surface in the response body, but the `(appId, caseType)` pair stays server-log-only. All classes use `readonly name = "<ClassName>"` initializers so the literal name survives bundler transforms. Every other throw in the package is an internal-invariant violation using the formatters at `lib/domain/predicate/errors.ts`.

## TypeScript validates writes — there is no in-database trigger

`PostgresCaseStore.insert` and `PostgresCaseStore.update`
validate the candidate `properties` payload against the case-
type's ACTIVE JSON Schema (the row in `case_type_schemas` with
`is_active = true`) via `ajv`
BEFORE the write reaches Postgres. The schema row is fetched on
demand and the compiled validator is cached per
`(appId, caseType, schemaContent)`.

`update` merges the patch over the row's existing document and,
before validating, SHEDS inherited keys the current schema no
longer declares: any key in a row but not in the stored schema is
provably an orphan (every write validated against the then-stored
schema, so a fresher-than-schema key cannot exist), left behind by
a property removal. Shedding with
the write is what keeps orphan-carrying rows writable instead of
failing `additionalProperties` forever. Only the INHERITED half is
shed — an unknown key in the caller's PATCH is still a validation
error.

The API route is the trust boundary; the database is internal.
There is no in-database trigger and no `pg_jsonschema` dependency
— Cloud SQL doesn't allowlist that extension and the validator
we already have in TypeScript lives at the right layer for our
architecture.

## `applySchemaChange` runs in two phases

Case-type removal uses the sibling lifecycle operation rather than
`applySchemaChange`: `classifyCaseTypeChanges` emits `retire`, and
`applyBlueprintChange` marks the schema row inactive inside the SAME guarded,
app-locked transaction that persists the Blueprint removal. Existing case rows
and parked values remain untouched. The inactive row retains the last active
JSON Schema and the removal's `mutation_seq` in `retired_seq`; the generated
`is_active` column is exactly `retired_seq IS NULL OR synced_seq > retired_seq`.
Normal validation treats an inactive row as absent, while a later
higher-sequence reactivation diffs from that archived contract and runs the
ordinary transition migrations. Because lifecycle is sequence-derived, a
previous application revision that advances `synced_seq` also reactivates
correctly without knowing the new columns. Its durable pending index
state targets the empty set after commit. A delayed sync below the retirement
sequence no-ops, and an equal-sequence sync may retry only an already-active
row—never reactivate an inactive one. Historical orphaned active rows use the
required scan-then-migrate pair:
`scripts/scan-case-type-schema-retirement.ts` (read-only, supports `--prod`) and
`scripts/migrate-case-type-schema-retirement.ts` (dry-run by default,
`--execute --confirm-old-revision-drained` to write). Execute the backfill only
AFTER the new revision has 100% traffic and every old-revision request has
drained: the previous binary can remove a case type without writing
`retired_seq`, so a pre-cutover pass cannot close the compatibility window. The
writer performs its own post-write zero-finding verification; follow it with the
standalone zero-finding rescan. The audit also reports
inactive current types and retired rows with pending or residual indexes, so a
failed Phase B or stale convergence watermark cannot disappear merely because
Phase A made the row inactive.

The production writer is not a human `--prod` connection: those IAM users are
read-only. `Dockerfile` bundles `case-type-schema-retirement.cjs` and
`schema-drift.cjs`; after the service deploy, `cloudbuild.yaml` configures (but
does not execute) the write-capable
`commcare-nova-case-type-schema-retirement` Cloud Run Job from that exact
immutable image under the migration identity. Once the new revision owns 100%
traffic, wait until every old-revision request has drained (the conservative
bound is `cloudRunRequestSeconds` in `config/runtime-capabilities.json`,
currently 3600 seconds), then run:

```bash
python3 scripts/rollout/deploy-cloud-run.py --execute-job \
  --project=commcare-nova --region=us-central1 \
  --job=commcare-nova-case-type-schema-retirement \
  --service=commcare-nova --wait-seconds=3060 \
  --execution-arg=case-type-schema-retirement.cjs \
  --execution-arg=--execute \
  --execution-arg=--confirm-old-revision-drained
npx tsx scripts/scan-case-type-schema-retirement.ts --prod
```

The Job's stored args are dry-run only. Every write invocation must go through
`deploy-cloud-run.py --execute-job --service=commcare-nova`: it proves the
service is Ready at 100% traffic, resolves that revision's immutable image,
requires the Job generation to carry the same digest, submits the Job etag,
and verifies the immutable Execution snapshot plus every task. Explicit
`--execution-arg` values supply the write flag and the operator's per-run drain
acknowledgement; an accidental default execution cannot write.

If the scanner reports an inactive current type, first run the same fenced
executor with `--execution-arg=schema-drift.cjs` and
`--execution-arg=--execute` (append `--execution-arg=--app` plus the app id for
an app-scoped repair), then run the retirement command and the read-only
production scan again. The scanner prints these exact target-preserving
commands; do not substitute a bare local writer or plain `gcloud run jobs
execute` command after a production scan.

### Phase A (one Kysely transaction)

1. **Schema sync** — read the stored schema row (`FOR UPDATE`, so
   concurrent syncs of one type serialize), regenerate the JSON
   Schema via `caseTypeToJsonSchema`, and UPSERT into
   `case_type_schemas`.
2. **Per-property transition detection** — on every WINNING sync,
   `detectPropertyTransitions` diffs the stored schema against the
   derived one and classifies every same-name property whose
   validation semantics changed into two migration families, both
   run in the SAME transaction as the schema write (so the schema
   row and the row population can never disagree, whichever caller
   synced — the guarded post-commit sweep, drain-end materialize,
   point-of-use heal, and drift scripts):

   - **String↔array flips** (the select single↔multi conversion):
     the TOTAL reshape — string scalar → one-element array, array →
     space-joined string (XForms convention) into an UNCONSTRAINED
     string target; a blank scalar's key drops instead of minting a
     one-empty-string selection. No value can fail these.
   - **Retypes** (everything else — a `format` keyword appearing or
     changing, string→integer, array→date, numeric→array): each
     row's value attempts `tryCastValue` into the new type; an
     uncastable value PARKS (`parked_case_values`) with its key
     dropped, and the row STAYS. Identity widenings
     (temporal/geopoint→text OR →single_select, int→decimal,
     text⇄single_select — the select's authored type survives via
     the schema generator's required `x-novaDataType` annotation)
     rewrite no rows — every stored value
     already conforms — but still count as type transitions for the
     closing restore step below. A numeric-SOURCE
     retype first
     drops the property's live `::integer`/`::numeric` expression
     index inside the transaction (`dropStaleNumericIndexes`) —
     writing an array through that stale cast would abort Phase A;
     Phase B rebuilds the new type's index after commit.

   Without this step, a regenerated schema would strand every
   pre-transition row: merged-document write validation rejects
   the old value on the row's next write of ANY property. Row
   writers serialize against the transition via the schema-row
   `FOR SHARE` their in-transaction validation holds (contract on
   `getValidator`; uniform lock order: relationship advisory →
   schema row → `cases` rows), so no write validated against the
   old schema can land after the detection's scan.

   Every park captures its transition (`from_type` / `to_type` — a
   narrow-options park carries its select type on both sides), and
   the winning sync's closing auto-restore (Phase A step 4) runs for
   every property whose declared TYPE changed in the sync —
   detected flips, retypes, AND identity widenings (a date→text
   convert-back rewrites no rows but is exactly the transition its
   parked values wait for) — while skipping DISMISSED entries: the
   review surface's soft archive (`dismissed_at`) means "reviewed,
   chose not to restore", so a later convert-back doesn't resurrect
   them. Same-type syncs stay out of scope so a deliberate
   narrow-options flush isn't undone by the next unrelated edit.
   Every stored-schema consumer first runs the same exact canonical
   decoder: the top-level object must contain only Nova's three schema
   keys, and every property declaration must equal one
   `schemaForDataType` shape byte-for-shape. The decoder owns the
   resulting type tokens, so text↔single_select is an ordinary explicit
   identity widening; malformed or pre-cutover schema shapes throw
   instead of being inferred, skipped, or compiled permissively. The tenant-bound
   review slice on `CaseStore` (`listParkedValues` — standings
   computed against the currently-stored schema: `fits` /
   `blocked` / `undeclared`, no occupancy arm —
   `restoreParkedValues` / `setParkedValuesDismissed` /
   `replaceParkedValue`) reaches tenancy by joining through
   `cases`; the schema store's `unparkValues` is the automatic restore
   operation, and both restores share one conformance-
   gated core split on ONE axis (`restoreEntries.overwriteExisting`):
   the review's explicit put back is a human decision and OVERWRITES
   whatever the slot holds; automatic restore paths are
   automatic and never overwrite. An overwrite never destroys: a
   displaced value that isn't redundant with the original (equal, or
   a multi-select survivors-subset) is archived as a NEW dismissed
   entry — recoverable under Dismissed, holding nothing. And a
   DISMISSED entry can't be put back directly (`restoreParkedValues`
   filters them to `kept`): its case may be live with a peer's
   replacement under the slot, so a stale client's Put back never
   clobbers — move back to review first.

   **The HOLD.** A case with an active (undismissed)
   `parked_case_values` entry is held out of every default read:
   `query` and `count` exclude it unless the caller passes
   `includeHeld` (`QueryArgs` / `CountArgs`), so the running app —
   case lists, search, counts, form loading via `readCaseData` —
   simply doesn't see it until review resolves its waiting values.
   Only the review's View case dialog and the builder's case-data
   population count opt in. Availability is per-CASE; storage stays
   per-value. Dismissal releases (loss accepted, the case runs
   without the value); moving an entry back to review re-holds;
   direct `update()` writes stay possible (the review's own Replace
   path uses them) — the hold is a read-side contract, not a write
   lock. Because the running app can't reach a held case, the NORMAL
   flow can't land a newer value in a parked slot — the reason the
   standing union has no occupancy arm. A dismissal round-trip can
   (dismiss releases → a form writes → move-back re-holds); the put
   back still proceeds and archives what it displaces. The hold also
   applies JOIN-side: every `cases` row a relation walk reaches
   (`compileRelationPath` — relation predicates, count-of-related,
   calculated columns) carries the same active-park exclusion, so a
   count never disagrees with the list beside it. The ancestor
   ENRICHMENT walk (`traverse` for form preloads) deliberately still
   reads held rows — a child's form showing its parent's name is
   reference data, and blanking it would recreate the
   hole-in-a-form trap the hold exists to prevent.
   **`conversionImpact` (on the schema slice) is the consent
   preview**: given `(appId, caseType, property, toType)` it runs
   the migration's OWN cast (`tryCastValue`, same blank-value drop)
   over the migration's OWN population — every row of the app's
   case type carrying the property, held cases included, no tenant
   filter — and reports `totalWithValue` / `uncastable` /
   `alreadyHeld` / value samples, so the consent surfaces (the
   builder's convert dialog, the SA `editField`'s
   needs-confirmation round) show exactly what the migration would
   do. Read-only; the pure edge verdict it pairs with is
   `castCanFail` in `lib/domain/casePropertyTypes.ts`, and the
   contract suite's parity sweep keeps the two in lockstep.
3. **Per-row migration** — only when `change` is supplied. The
   two arms are `retype(fromType, toType)` and
   `narrow-options(removedOptions)`. NO arm removes a row — a
   value the new declaration cannot hold parks with its key
   dropped, `parked_case_values` preserving the original + a
   person-readable reason, and the row stays present and writable.
   The retype arm shares the detection's cast engine (one property,
   caller-named). Narrow-options parks the FULL original select
   value while a multi-select keeps its surviving elements on the
   row — a deliberate opt-in flush, since stored values outside the
   current options are otherwise legitimate history. Case-property
   renames are not inferred here: the explicit batch-exclusive
   `renameCaseProperties` command uses
   `applyCasePropertyRenamePhaseA`. That dedicated path locks and
   admits every affected live and parked row, moves all keys
   simultaneously, preserves every non-name column, and persists the
   Blueprint plus accepted event in the same transaction. An own
   destination key is occupied even when null or blank; dismissed
   parked values participate. Step 2 reports on its own
   `reshaped` / `retyped` axes so one row rewritten by both steps
   is never double-counted, and every park lands in the report's
   `parkedIds` + `failureReasons`.

Phase A commits when the steps succeed and rolls back atomically
on failure. The schema row + data are always consistent.

### The monotone `synced_seq` gate

`case_type_schemas.synced_seq` records the `mutation_seq` a row was
last synced OR retired from. When a caller passes `syncedSeq`,
`applySchemaChange` gates on it in two halves so concurrent additive
edits converge instead of clobbering each other:

- **Coarse (a SELECT before Phase A):** read the row's recorded
  `synced_seq` (`Number(...)` — pg returns `int8` as a string; an
  absent row means "proceed"). If the incoming seq is LOWER, or is EQUAL
  while the stored row is inactive, the ENTIRE call no-ops — schema UPSERT + Phase-B index DDL skipped. A
  stale sync never rewinds a fresher row.
- **Fine (the UPSERT SET):** the conflict `doUpdateSet` guards
  `synced_seq = excluded.synced_seq` with
  `WHERE excluded.synced_seq > case_type_schemas.synced_seq OR
  (case_type_schemas.is_active AND excluded.synced_seq =
  case_type_schemas.synced_seq)`, so
  the UPSERT itself can't regress the row even if a fresher writer
  landed between the coarse SELECT and here. The UPSERT `RETURNING`s
  its row, which Postgres emits only when it actually inserted or
  updated — so a fine-gate LOSER (the WHERE was false) returns no
  row, and Phase B is SKIPPED for it. Without that skip, the loser
  would diff its OLDER desired index set against the winner's live
  set and `DROP` the winner's new-property index. A lost SELECT→UPSERT
  race then re-converges on the next sync (perf-only, not a
  correctness gate).

`syncedSeq` is mutually exclusive with `change` — the additive gate
carries a seq and no caller-intent migration; a migration runs
pre-commit un-versioned. The implementation throws when both are set
(so the whole-call no-op can never silently skip a migration's
per-row work). The Phase-A shape reshape is exempt from that
tension: it derives from the stored row itself, so a stale-seq
no-op is safe — the fresher writer that advanced the row ran the
same detection against the same stored state in its own
transaction, and a fine-gate loser skips the reshape along with
Phase B.

Absent `syncedSeq` (an explicit maintenance caller with no committed Blueprint
sequence): a plain unversioned UPSERT that always wins its own ACTIVE conflict;
it rejects an inactive row because maintenance code cannot bypass the
reactivation sequence fence.

### Phase B (no transaction; runs after Phase A commits)

4. **Per-property expression-index DDL** — always runs. Computes
   the desired index set from the blueprint's property
   declarations, reads the live index set from `pg_index` +
   `pg_class` (joined to capture `indisvalid`), and emits the
   matching `DROP INDEX CONCURRENTLY` / `CREATE INDEX CONCURRENTLY`
   statements for the diff. An INVALID artifact left by a prior
   failed CONCURRENTLY build flows through both `drops` and
   `creates` so a retry rebuilds it from scratch.

   That catalog read pins the table with `to_regclass('cases')` —
   SEARCH-PATH resolution, the same resolution the unqualified
   `ON cases` in the DDL performs. Keying it on `current_schema()`
   instead is wrong under privilege convergence, which moves `cases`
   into `nova_case_runtime` while the path stays
   `public,nova_case_runtime`: the read then matches nothing, the
   diff re-`CREATE`s every desired index (`already exists` on a case
   type's second sync, with every create queued behind it skipped)
   and emits no drops at all. Local databases keep `cases` in
   `public`, so only production shows it — the regression test in
   `postgres/__tests__/store.test.ts` moves the table to reproduce
   the converged shape.

### Why two phases, not one transaction

PostgreSQL's `CREATE INDEX` (non-`CONCURRENTLY`) heap-scans with
`SnapshotAny` semantics, which includes dead but not-yet-vacuumed
tuples. Inside the same transaction as Phase A's per-row
migration, every row UPDATE (a cast rewrite, a park's key drop)
leaves the row's PRE-migration version as a dead tuple in
`cases`'s heap. A subsequent in-transaction `CREATE INDEX` over
the new typed expression scans that dead tuple and fails the cast
on its pre-migration value — the `text → int` retype's parked
`"abc"` still exists as a dead tuple and trips
`((properties->>'X')::integer)`, rolling back the transaction and
defeating the migration.

`CREATE INDEX CONCURRENTLY` uses MVCC snapshot semantics strict
enough to ignore dead tuples and cannot run inside an outer
transaction — both align with Phase B's non-transactional shape.
As a side benefit, CONCURRENTLY does not hold `ACCESS EXCLUSIVE`
on `cases`, so reads + writes keep working while the index
builds.

### Phase B failure semantics

A failure mid-Phase-B throws, the schema row + per-row migration
are already committed, and the next `applySchemaChange` call
diffs against the catalog and re-emits whatever drops + creates
remain outstanding. The diff captures `pg_index.indisvalid` — a
`CREATE INDEX CONCURRENTLY` failure leaves the partially-built
index marked invalid, and the diff treats an INVALID entry as
"drop and recreate" so the next retry converges. Recovery is
idempotent: any number of retries lands the same final index
set. Missing or invalid indexes degrade query performance but
never correctness — the term compiler's emitted SQL falls back
to a sequential scan over the case-type partition.

The chat-completion boundary calls `applySchemaChange` once per
case type via the sibling helper at
`lib/db/materializeCaseStoreSchemas.ts` to close the gap the SA's
inline chat-side commits leave open (the freshly-generated case
types have no `case_type_schemas` row until that helper lands).
Its failure contract splits on fault class (`lib/db/schemaSyncRetry.ts`
`isTransientDbError`): each per-type sync retries a TRANSIENT blip,
then **swallows** a still-transient terminal (`warn`; the
point-of-use `withSchemaHeal` re-syncs on recovery) but **RETHROWS**
a DETERMINISTIC fault (an identifier collision, a
`CaseTypeNotInBlueprintError`) — a real bug that would fail
identically on every heal, so the chat BUILD arm routes it through
`failRun` (refund + classified error) rather than complete-and-charge
a permanently-unusable app; the EDIT arm error-logs it (the edit
already committed + charged). Both the materialize and the heal pass
`syncedSeq` (the `mutation_seq` of the EXACT blueprint they
materialize — `ctx.latestCommittedSeq()` for the drain-end,
`app.mutation_seq` off the same `loadApp` snapshot for the heal) so
the monotone `synced_seq` gate converges them with a concurrent
additive sync.

The auto-save and MCP write boundaries route through
`lib/db/applyBlueprintChange.ts`; chat batches containing `retireCaseType` do
the same. Explicit case-property rename and case-type retirement Phase A share
the guarded Blueprint transaction; ordinary additive changes ride a post-commit sweep of
the committed doc at the committed seq (`syncedSeq`), which
converges concurrent edits via the same monotone gate.

### Pre-flight identifier validation runs BEFORE Phase A

`computeDesiredIndexSet` runs synchronously at the top of
`applySchemaChange`, before the transaction opens. Property names
and case-type names compose into the index name through
`indexName`, which throws on identifier-shape violations
(characters outside `[A-Za-z0-9_-]`). A throw at this point leaves
`case_type_schemas` untouched.

Property and case-type names admit hyphens at the blueprint layer
(for example, `client-code`). The index NAME
carries neither name verbatim — the `(app, case_type)` scope and
the property each fold into a fixed-width SHA-256 tag
(`indexScopeTag` / `propertyIndexTag`), so a hyphen needs no
transform and the composed name can't overflow the 63-byte cap no
matter how long the names are. The JSONB key inside the indexed
expression preserves the hyphen verbatim via `sql.lit`.

### Expression indexes are app-scoped

`case_type_schemas` is keyed `(app_id, case_type)`, so a case type's *desired* index set is per-app — but a case-type NAME (`patient`, `person`) is not globally unique. Every per-property expression index is therefore scoped on BOTH halves: the name carries a leading `indexScopeTag(appId, caseType)` segment (`cases_<scopeTag>_<propertyTag>_<mode>` — the fixed-width tags above; only `<mode>` stays readable) and the partial predicate is `WHERE app_id = '<app>' AND case_type = '<type>'`. Without that, one global index spans every app's rows of a shared case-type name, and two apps that declare the same case-type + property with different `data_type`s collide on a single index whose cast rejects the other app's values at INSERT (the `::integer`-vs-`"17.01"` failure, cross-app variant). The fixed-width tag is also what makes the catalog diff's name prefix (`cases_<scopeTag>_%`, in `readLiveIndexSet`) an EXACT scope match — distinct scopes hash to distinct tags, so the diff never bleeds across apps NOR across case types whose names are prefixes of each other (`patient` vs `patient_visit`) without ever parsing the partial predicate. The tag is deterministic, so the runtime composes the same name for a given scope on every write.

### Per-data-type index coverage

| Property `data_type` | Postgres index | Reasoning |
|---|---|---|
| `text` | `GIN ((properties->>'<key>')) gin_trgm_ops` partial on `(app_id, case_type)` | The text-property index slot. No `match` mode routes through it — `fuzzy` / `phonetic` evaluate token-wise (`levenshtein` / `soundex` over `unnest`ed tokens) and `starts-with` uses `starts_with(...)`, all sequential scans at preview scale. Retained as the established text slot; dropping it is a separate schema decision |
| `int` / `decimal` | `BTREE (((properties->>'<key>')::<cast>))` partial on `(app_id, case_type)` | Covers `compare` / `between` against typed numerics. The two share the btree access method but compile to different casts (`::integer` vs `::numeric`), so their index NAMES split by cast (suffix `int` / `num`, not a shared `btree`) — the name-keyed catalog diff would otherwise treat an `int↔decimal` retype as a no-op and leave the stale-cast index in place, failing the next fractional insert at write time |
| `multi_select` | `GIN ((properties->'<key>')) jsonb_ops` partial on `(app_id, case_type)` | Covers `multi-select-contains` (`?` / `?\|` / `?&` / `@>`); `jsonb_path_ops` only covers `@>` and would force a sequential scan for `?` / `?\|` / `?&` |
| `single_select` | None | Equality on a small option set is fast without an expression index |
| `date` / `datetime` / `time` | None | The text-to-typed casts and the canonical `to_date(...)` / `to_timestamp(...)` builtins are STABLE in Postgres (DateStyle / TimeZone session dependency); expression indexes require IMMUTABLE expressions |
| `geopoint` | None | The `within-distance` arm builds a WKT string via `concat(...)` over `split_part(...)` reads to bridge the wire shape `"lat lon alt acc"` to PostGIS's WKT input; `concat(...)` over text args is STABLE so the full expression cannot be indexed |

## Sample-data

The generator is stateless and deterministic per `(appId, caseType.name, seed)`, and does NOT write to Postgres — `generateSampleData` routes rows through the package-private bulk-insert path so generated rows get the same JSON Schema validation + `case_indices` derivation as real inserts. Row `case_id`s are minted up-front in TS (`uuidv7()` — same RFC 9562 shape as the column default, so B-tree clustering is unchanged) so derived edges can reference them pre-INSERT. The bulk path stays package-private; the public interface keeps per-call `insert`, and a validation failure on any batched row rolls back the whole batch. `resetSampleData` runs drop-regenerate-validate-insert under ONE transaction so a mid-operation failure preserves the pre-call population. Per-row migrations bulk their writes the same way (constant round-trips regardless of row count).

## Running-app view binding

The flipbook's running-app screens read case data through the
binding helpers at `lib/preview/engine/caseDataBindingHelpers.ts`
(pure helpers accepting a `CaseStore`) plus the Server Actions
at `lib/preview/engine/caseDataBinding.ts` (resolve session
server-side, then either `resolveAuthorizedPreviewContext` for persona-aware
reads/writes or `gatedCaseStore` for member-only operations; both
membership-gate the app's Project and construct an explicit
`withProjectContext(projectId, actorUserId, ownerId)` store). The
`pickBlueprintDoc` projection in the helpers package strips
function values off the doc-store state before the wire crosses
into a Server Action so React's RSC serializer accepts it.

### `queryGrouped` — clustering, in SQL, because there is nowhere else

A grouped case list clusters rows by a case connection between the
user's sort and the page window, so the clustering has to run inside
the same statement. `queryGrouped` is a SEPARATE method rather than a
flag on `query` because its WINDOW COUNTS GROUPS: `groupOffset` /
`groupLimit` name that in the shape instead of leaving `limit` /
`offset` meaning two things. It returns the groups plus `totalGroups`
(the pager's denominator) and `totalRows`, all from one statement, so
the page and the pager can never disagree and the ungrouped path's
stale-final-page reclamp has no counterpart here.

The statement reuses `buildCaseSelect` — the same tenant, hold,
predicate, sort, and calculated-column compilation `query` runs — and
wraps it in four window levels: the group key, `row_number()` over the
user's sort, `min(row ordinal) over (partition by key)` for each
group's first appearance, and `dense_rank()` over that. The window on
the dense rank with `order by first-appearance, row-ordinal`
reproduces `commcare-core .../util/screen/EntityScreenHelper::groupEntities`
(first-appearance ordinal, members in post-sort order) and
`formplayer/.../beans/menus/EntityListResponse::getEntitiesForCurrentPage`
(boundaries on adjacent keys) exactly.

Two contracts inside it:

- **The empty key is the contract, not a null guard.**
  `coalesce(<ancestor lookup>, '')` is what `string(./index/<id>)`
  evaluates to on a case carrying no such index
  (`commcare-core .../cases/entity/NodeEntityFactory::getEntity`), and
  the clustering map takes it as an ordinary key — so every such case
  lands in ONE group, rendered as the device renders it. Never invent a
  synthetic "ungrouped" bucket; the runtime has no such concept.
- **The ancestor pick is ordered.** Nova's writers keep one ancestor per
  `(case_id, identifier)`, so `order by ancestor_id limit 1` is
  determinism insurance rather than a real fan-out — the same discipline
  `automationRelationIndexFilter` documents. A storage-order-dependent
  answer is one that changes under VACUUM.

`count` carries the matching measurement arm, `missingIndexIdentifier`:
how many cases of one type carry NO index with that name. It is a
MEASUREMENT, not an authored predicate, so it does not reach for the
Predicate AST, and it counts held rows because it answers a question
about the stored data an author governs rather than about what the
running app can currently reach.

The CommCare boundary keeps `lib/case-store/**` and
`lib/commcare/**` independent — a Biome `noRestrictedImports`
rule enforces the boundary.

## Local development

`npm run db:dev` boots the local Postgres (`compose.yaml`, the same
pinned postgis image the test harness uses) and applies the migrations
(`npm run db:migrate`, Kysely's `Migrator` via `scripts/migrate.ts`);
`npm run dev` runs it, then starts Next.js. When `NOVA_DB_LOCAL_URL`
(set in `.env`) is present, `postgres/connection.ts` uses a plain
`pg.Pool` against it instead of the Cloud SQL connector — an EXPLICIT
opt-in, not a `NODE_ENV` fallback, so a production misconfig still
hits the connector's loud `NOVA_DB_*` validation instead of silently
falling back to localhost. Local app processes may omit
`NOVA_DB_WORKLOAD` and default to `service`; `npm run db:migrate`
declares `migration` explicitly.

The read-only inspect scripts (`scripts/inspect-*.ts`) take `--prod`,
which points this same connection layer at the production instance
over its PUBLIC IP (`NOVA_DB_IP_TYPE=PUBLIC`) authenticating as YOUR
gcloud identity via IAM — per-developer prerequisites in
`scripts/lib/prodDb.ts`. The instance has no authorized networks, so
the connector's IAM-authenticated path is the only way in; Cloud Run
keeps riding the private IP (it never sets `NOVA_DB_IP_TYPE`). That
central `--prod` helper authoritatively declares the `operator`
workload, whose pool max is the residual ordinary-login connection.

Every non-local process must declare its pool workload exactly:
`service` = 3 pooled connections, `migration` = 1,
`capture-cleanup` = 2, `audit` = 1, and `operator` = 1 ordinary connection. The
serving process also owns one dedicated LISTEN connection outside its
pool. PostgreSQL's direct-login `CONNECTION LIMIT` is the hard,
cluster-wide boundary: runtime = 16, migration = 1, cleanup = 3, and audit = 1.
Role attributes are not inherited, so migration, cleanup, and audit sessions
count against their own login roles. Migration inherits runtime's table
privileges; cleanup has no application-role parent and receives only
public-schema `USAGE` plus `SELECT`/`UPDATE`/`DELETE` on `form_attachments`.
Audit also has no parent and receives only the canonical scanner's exact read
surface. Those caps total 21 against `max_connections=25`; one slot remains for
an ordinary/operator login, while the final three are protected by
`superuser_reserved_connections=3` for true superusers
(`reserved_connections=0`).

Cloud Run's service/revision maximum of four is a soft outer control; it keeps
ordinary demand aligned at `4 * (pool 3 + listener 1) = 16`, but PostgreSQL
admission is what prevents a transient platform overrun from consuming the
maintenance/headroom allocations. Those final role limits and the `pgaudit`
extension are established by the separately invoked privileged bootstrap, not
by runtime or deploy-time compatibility machinery.
Cloud SQL flag provisioning is also exact because its patch API replaces the
whole set: `cloudsql.enable_pgaudit=on`, `cloudsql.iam_authentication=on`,
`max_connections=25`, and `pgaudit.log=all`. Audit flags are part of the same
durable contract as authentication/capacity, not unrelated settings a
convergence patch may drop.
Unknown or absent production workloads fail before connecting.

Data lives in the persistent `nova-cases-data` Docker volume
(`npm run db:dev:down` stops the container; `docker compose down -v`
wipes it). The three compiler extensions (`pg_trgm` / `fuzzystrmatch` /
`postgis`) install once on first boot via `dev/init-extensions.sql`, mirroring
the prod / harness privilege split (the migrate runner connects as a
non-superuser and cannot `CREATE EXTENSION`). Production additionally requires
the operational `pgaudit` extension. The pinned local/test image has no pgAudit
package, so local configs deliberately omit that production-only extension
while exercising the same compiler dependencies.

## Migrations

Kysely's `Migrator` owns migration application — `runCaseStoreMigrations`
in `lib/case-store/migrate.ts` is the single code path every environment
uses (the prod migrate Job, `npm run dev`, the testcontainers harness),
so tests apply the exact migrations production runs. Migrations are
forward-only TypeScript modules in `lib/case-store/migrations/`, each
exporting `up(db)` (and a teardown-only `down(db)`); `migrations/index.ts`
is a static import-based `MigrationProvider` (no `FileMigrationProvider`,
so it works the same inside the esbuild-bundled prod entrypoint, the
harness, and dev). Kysely records applied migration names in its
`kysely_migration` ledger and serializes concurrent runs with a Postgres
advisory lock.

`runCaseStoreMigrationsWithReport` is the production form of that entrypoint:
it returns the exact migration names applied by this invocation.
`runCaseStoreMigrations` remains the no-result wrapper for ordinary local/test
callers. The canonical-identity cutover uses the report to distinguish the one
deployment that must re-fence direct runtime sessions after convergence; no
schema guess or ledger reread substitutes for the migrator's result.

The case-store ledger makes `apps.project_id` `NOT NULL`; after Better Auth
creates `auth_organization`, the Nova auth-app ledger installs the exact
validated Project FK. This persisted invariant is separate from
`withSchemaContext()` constructing a schema-only `PostgresCaseStore` with no
bound Project. That constructor mode remains intentionally nullable and its
narrow interface plus `requireProjectId()` prevent tenant-bound case methods
from using it.

### Authoring workflow

1. Add a timestamp-prefixed module to `lib/case-store/migrations/`
   (`<YYYYMMDDHHMMSS>_<slug>.ts`) exporting `up`/`down`. Raw DDL goes
   through `` sql`...`.execute(db) `` (one statement per call).
2. Register it in `migrations/index.ts`'s `caseStoreMigrations` record
   (keys sort lexicographically → apply order).
3. Update the owning Kysely type contract in the same commit:
   `lib/case-store/sql/database.ts` for runtime case tables, or
   `lib/db/pg.ts::AppDatabase` for app-state/auth-adjacent tables such as lookup
   data. The compile-only database tests and harness smoke tests catch drift
   between DDL and types.

`20260815010000_design_localization` owns the initial-build translation attempt,
batch, receipt, and exact-once batch-usage tables. Attempts/batches are mutable
only for durable recovery; receipts and usage accounts receive append-only
runtime privileges. Their foreign keys deliberately bind automatic translation
to one accepted design revision/build plan rather than masquerading as a general
existing-app edit lifecycle.

There is no declarative `schema.sql` and no autogenerated diff — the
migration modules ARE the source of truth.

Migrations are intentionally replay-idempotent because the migration adoption
tests erase Kysely's ledger and replay the complete chain over an existing
schema. Keep guarded constraint additions, `IF NOT EXISTS` tables and indexes,
`ON CONFLICT` singleton seeds, replaceable functions, and drop-before-create
triggers replay-safe. The `down` path is test/local teardown only; a deployed
schema change always fixes forward in a new migration.

`20260728010000_case_schema_index_convergence` is an exact cutover, not an
`IF NOT EXISTS` adoption migration. On one transaction/connection it takes an
advisory lock and `ACCESS EXCLUSIVE` table locks, then classifies the complete
relation/column/type/default/constraint/index/trigger catalog, relation and
index owners, full effective ACLs, and every convergence row before its first
write. Only the exact pre-cutover catalog may run the plain
`ALTER`/`CREATE`/initial pending-sequence `UPDATE`; the exact final catalog is a
read-only rerun. Partial objects, wrong names or definitions, ownership or ACL
drift, extra/duplicate constraints or indexes, invalid sequence relations, and
a schema/deletion-tombstone overlap block. In particular, a legitimate
`index_pending_seq > index_synced_seq` final row is preserved byte-for-byte on
rerun rather than reset from `synced_seq`. Its `down` is forward-only.

The holder identity migrations add server-minted `apps.run_holder_nonce` and
actor-bound `threads.active_holder_nonce`. Every holder-touching writer uses
`(mode, runId, nonce)` identity unconditionally.

### Destructive changes — expand-contract

There is no automated destructive-change lint. An ordinary schema change that
removes a column / table must go through expand-contract across
deploys — **enforce it by review**, not a tool:

1. **Expand:** add the new column / table in a migration; deploy.
2. **Migrate:** application code stops reading/writing the old surface;
   deploy.
3. **Contract:** a later migration drops the old surface, once no live
   reader remains.

The testcontainers harness replays every migration against a real
Postgres on each run, so an authoring-time SQL error fails CI loudly.

The canonical-identity migration is the deliberate non-rolling exception: its
old and new document/mutation schemas cannot coexist without preserving the
dual dialect the change exists to delete. It therefore runs only inside Unit
18's reviewed maintenance fence, after all old writers are drained and the
authoritative backup is complete. It converts snapshots and authored-identity
SQL columns in one transaction, establishes a new per-app fold horizon, and
admits no compatibility reader, alias, or transitive rollout state.

Review must also cover two hazards no tool gates:
(1) a `DROP TABLE`/`DROP COLUMN` in a migration runs against live
Cloud SQL on the next deploy with no automated gate — so destructive DDL
needs deliberate review; and (2) Kysely wraps the whole migration batch in
ONE transaction (Postgres `supportsTransactionalDdl`), which means a
migration CANNOT use `CREATE INDEX CONCURRENTLY` and a plain `CREATE INDEX`
on a large `cases` holds `ACCESS EXCLUSIVE` for the build's duration — and
the migrate Job runs while the OLD revision is still serving, so live reads
stall. Build per-property/large-table indexes through the runtime
`applySchemaChange` Phase-B path (`CREATE INDEX CONCURRENTLY`, no outer
transaction), NOT a migration. Migrations are for the fixed base schema.

Production privilege convergence moves `cases` (and its indexes) into the
isolated `nova_case_runtime` schema. Every Nova connection uses search path
`public,nova_case_runtime`, so existing unqualified queries remain valid while
fixed/auth/control objects continue to resolve and be created in `public`.
Runtime owns `cases` and has `CREATE` only on the isolated schema—the minimum
PostgreSQL requires for Phase-B concurrent indexes. It never receives `CREATE`
on `public`; migration owns that schema and every fixed object. Because
PostgreSQL cannot grant index-only `CREATE`, convergence audits the schema's
generic dependency inventory and rejects every persistent object except
`cases`, its attached indexes and constraints, and its implicit row/array
types. Local development skips role convergence, keeps `cases` in `public`, and
the same search path still resolves it.

### Migration modules are immutable once applied

Kysely's ledger records migration NAMES, not content hashes. So **never
edit the body of a migration that has shipped** — every database that
already ran it carries its name in `kysely_migration` and silently skips
the edit, so the change lands on fresh databases (CI) but not on
production. Fix forward: add a new migration. (The two baseline
migrations are written idempotently — `CREATE TABLE IF NOT EXISTS`, a
`pg_constraint`-guarded CHECK — so they no-op cleanly against a database
that already carries the schema; they are just as immutable as the rest.)

### Production: the migrate Cloud Run Job

Migrations run once per deploy as the `commcare-nova-migrate` Cloud Run
Job, NOT on container boot. `cloudbuild.yaml` runs the Job
(`node migrate.cjs`) between pushing the image and deploying the new
revision; a non-zero exit fails the build before the deploy step, so
code never ships ahead of a failed schema change. The container `CMD` is
node-only.

`migrate.cjs` is `scripts/migrate.ts` bundled by esbuild during the
Docker build (the Next standalone runner has no full node_modules, so
kysely + pg + the Cloud SQL connector are inlined into one file). The
Job reuses the app image with a `--command=node --args=migrate.cjs`
override under a dedicated migration identity on the service's network. It calls
`getCaseStoreDatabase()`, so it connects through the SAME
`@google-cloud/cloud-sql-connector` + IAM path the runtime uses. Its connector
env wires `NOVA_DB_USER` / `NOVA_DB_INSTANCE_CONNECTION_NAME` /
`NOVA_DB_NAME` plus `NOVA_DB_WORKLOAD=migration`. Privilege convergence
requires the migration, runtime, cleanup, and audit role identities after
migrations.

Between the schema migrations and the privilege pass, the entrypoint runs the
**data repairs** in `scripts/lib/*Repair.ts`. Each exists because an absolute
gate was strengthened with no compatibility reader, so historical documents the
new revision would refuse are converged HERE, before that revision serves —
and a repair whose gate judges the whole document while every editor commits
one field per batch is the *only* way its apps can be fixed at all. A repair
plans purely, proposes a whole target document through `appendSyntheticBatch`,
and is idempotent: it re-plans the live fleet on every deploy and no-ops once
converged, so none of them pins a scan's app-id list (that census would be
stale by the deploy shipping it).

**A repair must not be able to fail the deploy over one app.** The worst it
can do to an app it cannot converge is leave it exactly where it already was,
so a per-app failure is named in the Job's log and skipped; the fleet-wide
reads around it still throw, because a database that has gone away is not a
fleet of blocked apps. Grep the Job's log for a repair's `blockedApps` to find
the ones it could not fix. A repair that renames a value carried in a
TRANSLATION UNIT ID — a catalog option's, an id-mapping column's mapping label
— must move the overlay entry to the new id in the same target: the commit
kernel prunes an entry whose unit no longer exists, so an unfollowed rename
both deletes the translated wording and yields a target whose localization the
writer's diff cannot express (`LocalizationEndpointNotRepresentableError`).

Every production migration invocation finishes with the rollback-only runtime
database probe in `lib/db/runtimeDatabaseProbe.ts`: it assumes the runtime role
inside the migration transaction, assembles every app's exact text carriers
through the production persisted decoder without a sample cap, reruns the
complete empty-batch absolute gate, and compares incremental and rebuilt local
reference indexes plus stored and structural Project lookup edges even for a
gate-failed parsed document. It strictly loads a gate-clean candidate,
reauthorizes an existing editable Project member, and exercises the real
guarded writer before rolling the synthetic batch back. Its report carries
actual parser, gate, and reference-index finding counts. When the migration report includes
`20260728000000_canonical_identity_foundation`, the entrypoint first terminates
every direct runtime-login session and proves none reconnects through the
stabilization interval. This is an in-image serving-schema proof before
deployment, not an external health check after traffic resumes.

The one-time bootstrap happens outside Nova: create runtime, migration,
capture-cleanup, and audit as non-superuser direct LOGIN roles; make only
migration a member of runtime (never the reverse); leave cleanup and audit
without an application parent; apply their exact CONNECTION LIMIT 16/1/3/1;
install all required
extensions in `public`; and make migration the database owner before running
this entrypoint. Required extensions may be owned only by migration or Cloud
SQL's managed `postgres` role. Existing provider-installed extensions remain
`postgres`-owned because PostgreSQL exposes no extension-owner transfer and a
blanket `REASSIGN OWNED BY postgres` would seize unrelated managed objects.
`public` remains owned by PostgreSQL's `pg_database_owner`, whose current
member is the database owner, so migration is its effective owner without
replacing that built-in role. The one-way runtime membership lets migration
maintain runtime-owned tables.
Convergence directly grants cleanup only public-schema `USAGE` plus
`SELECT`/`UPDATE`/`DELETE` on `form_attachments`, and audits that it cannot
insert/administer attachment rows or access other managed tables or the case
schema. It grants audit only schema `USAGE` plus `SELECT` on the immutable
canonical scanner's exact relation inventory, and proves no extra table, DML,
sequence, routine, or `CREATE` privilege survives. Convergence deliberately
does not create roles, alter role limits, or
transfer the database ownership it needs to authorize its own `REVOKE`,
`GRANT`, and ownership changes.

Cloud Build separately runs the same image's
`capture-cleanup.cjs --probe-schema` under the cleanup identity — the bundle
`scripts/cleanup-form-attachments.ts` is built into. The scheduler is ENABLED
while that probe runs on an ordinary deploy; the paused state belongs to the
maintenance cutover, not to this step. That probe asserts the exact final ordered
column/type/nullability contract and zero-row read/update/delete authority in
an intentional rollback; the build also proves updating the Job did not change
the scheduler's recorded enabled/paused state.

The first schema split is a maintenance cutover, not a rolling migration: its
transaction may make the old revision unable to serve before the new one
starts.

The canonical-identity conversion is NOT one. It runs its forensic repair
inside the same migration transaction as its transform, holding
`SHARE ROW EXCLUSIVE` over every occurrence table plus `SELECT ... FOR UPDATE`
over `apps`. Those locks are the protection; a concurrent writer blocks on them
or fails against them, and a request already in flight against the old shape
may error. It records lease, stream-chunk, and presence counts but requires
none of them to be zero — that requirement would only be satisfiable by taking
the service down, and `unterminatedChunks` alone counts every non-final chat
chunk inside its 24-hour retention. `block-current` rows remain a hard stop.

For a cutover that does need the posture, `scripts/rollout/deploy-cloud-run.py`
deploys the exact immutable
`repository@sha256` image without a scaling override, proves the candidate
Ready at 100% desired and observed traffic with no tag while manual zero is
preserved, and only afterward performs a separate scaling-only return to
automatic that must add no revision (irrelevant untagged zero-traffic revision
GC is allowed). A maintenance failure runs its always-armed `finally` recovery:
detach ingress, restore manual zero, execute the exact-image runtime-session
fence, pause cleanup, and verify the posture. Ordinary later deploys use the
same permanent path from automatic prestate. There is no
bridge, compatibility view, or database cutover journal; later migrations
rerun the idempotent convergence normally.

The canonical-identity cutover's frozen capture is lossless: dispatcher,
Project-orphan closure, and full-table scan all consume PostgreSQL's canonical
whole-row JSON text through one parser that preserves numeric lexemes and
prototype-shaped keys. Its fold baseline is database-owned, not caller-authored:
PostgreSQL reconstructs the complete current `PersistableDoc`, hashes the exact
UTF-8 `jsonb::text`, and admits it only with the same-transaction app, marker,
and complete entity set. The final audit pins the baseline table, index,
constraints, triggers, routine signatures/security, and PUBLIC/runtime ACLs
exactly. It also pins the complete structural dependency closure around every
authored-identity SQL column — columns, constraints in either direction,
indexes, triggers, and catalog dependency edges — independently of dynamic
role names, while privilege convergence owns the corresponding exact
owner/ACL profile. App genesis can create a baseline only through the
app-id-only `SECURITY DEFINER` routine.

The same entrypoint also owns the **auth** schema: after the case-store
migrations it runs Better Auth's own migrator (`getMigrations(...)
.runMigrations()`, which creates/updates the `auth_*` tables) via the
MCP-free `lib/auth-migrate-options.ts`, then the Nova-owned auth-app
migrations (`lib/auth/migrate.ts`, the `auth_oauth_grant_revocation`
watermark plus cross-schema invariants such as the apps→Project FK). Both are
idempotent and run on every deploy, local and prod alike.

### Checking prod migration state

The migrate Job's apply log surfaces in its Cloud Run Job execution
logs:

```bash
gcloud logging read 'resource.labels.job_name=commcare-nova-migrate' \
  --limit=20 --freshness=1h --format='value(textPayload)' --project=commcare-nova
```

The source of truth for "what migrations are applied" is the
`kysely_migration` ledger. Open Cloud SQL Studio at
`https://console.cloud.google.com/sql/instances/nova-cases/studio?project=commcare-nova`
and run:

```sql
SELECT name, timestamp FROM kysely_migration ORDER BY name;
```

### Required Postgres extensions

The case-store's compiler stack depends on three extensions:

- `pg_trgm` — required by the `text` GIN index's `gin_trgm_ops`
  opclass (no `match` mode emits Postgres `%` similarity; the
  index is the established text-property slot).
- `fuzzystrmatch` — `match(mode: fuzzy)` (`levenshtein` for the
  term-level AUTO-fuzziness clause) and `match(mode: phonetic)`
  (`soundex`, the encoder CommCare HQ's phonetic analyzer uses).
- `postgis` — `match(mode: within-distance)` (`ST_GeogFromText`
  + `ST_DWithin`).

Production also requires `pgaudit`, because the Cloud SQL flags enable full
audit logging only when the extension is installed in the database. The
privileged owner bootstrap creates any missing extension, transfers
non-permanent ownership, and inventories each required extension's owner,
version, `public` schema, configuration relations, and dependency catalogs.
Its permanent audit accepts only Cloud SQL's managed `postgres` or migration
as owner.

The testcontainers harness installs the three compiler extensions via its
container superuser before migrations run. Its pinned PostGIS image does not
package pgAudit, so harness bootstrap configs intentionally omit that
production operational extension.

`CREATE EXTENSION` requires `cloudsqlsuperuser` on production, and the
IAM-authenticated migration identity is intentionally non-administrative. The
temporary built-in bootstrap administrator therefore installs the extensions
in the same transaction that transfers all temporary-owned objects to
migration; pre-existing Cloud SQL-managed extensions stay `postgres`-owned,
and schema migrations then apply per deploy under the migration identity.

## Testcontainers harness

A real Postgres engine boots once per `vitest run` and every test
in this package executes against it. The harness lives entirely
under `sql/__tests__/`; consumers import the fixture from
`setup.ts`.

### Container-per-run, transaction-per-test

The harness pins to two non-negotiable rules:

1. **One container per `vitest run`, NOT one per test file.**
   Vitest's `globalSetup` runs in the orchestrator process exactly
   once per run; the harness boots a `PostgreSqlContainer` there
   and publishes the connection URI via `project.provide()`. Per-
   file boots cost 5-15 s each on `pg_ctl init` + extension install
   and make the watch loop unusable.

2. **Per-test isolation comes from BEGIN/ROLLBACK, NOT separate
   schemas / databases.** The `db` fixture in `setup.ts` opens a
   transaction in `beforeEach`-equivalent setup, immediately runs
   `SET CONSTRAINTS ALL IMMEDIATE`, seeds the exact parent app/Project
   rows used by the compiler fixtures, and rolls the transaction back
   in the `try/finally` cleanup wrapper. Immediate checking is
   load-bearing: the production cases→apps tenant FK is initially
   deferred so an atomic Project move can update the whole closure, but
   a rollback-only test would otherwise never reach its COMMIT check and
   could report an orphan case insert as successful. A dedicated
   constraint/transaction test that needs deferred behavior uses a
   per-test database and forces a real COMMIT. Don't bypass this with
   raw `pg.Client.connect()` — your writes will leak across tests
   and the harness's contract breaks silently.

   Tests that legitimately need a fresh-empty-database path (the
   per-test database helper at `sql/__tests__/perTestDatabase.ts`)
   are the documented exception: they create their own database
   via `CREATE DATABASE` against the testcontainer's superuser URI
   and drop it on cleanup. The motivating use case is
   `PostgresCaseStore`'s transaction-using methods (`insert` /
   `update` / `applySchemaChange`) — each method calls
   `db.transaction()` which Kysely lowers to a literal `BEGIN`.
   Postgres rejects nested BEGIN inside the harness's outer
   transaction. Per-test databases give every test its own engine
   state without any outer-transaction wrapping.

The `harness-isolation.test.ts` sibling file exists specifically
to catch a regression that splits one of these two rules: it
inserts sentinel UUIDs in `harness.test.ts`, rolls them back, then
asserts in the sibling file that those same UUIDs return zero
rows. A regression to per-file containers OR per-test commits
surfaces as a failing sibling test, not a silent leak.

### Image and extensions

`imresamu/postgis:18-3.6.1-alpine3.23` is the harness's pinned
image (referenced by SHA-256 digest, not by floating tag),
matching Cloud SQL's Postgres 18 major and its PostGIS 3.6 within
one patch. The full rationale (multi-arch parity, why-not the
official `postgis/postgis` image) lives in `globalSetup.ts`'s
`## Image choice` block.

`compose.yaml` names the same reference so `npm run dev` and the suite that
gates the merge run one engine, and `scripts/ci/print-test-image.mjs --check`
(the `quality` job) fails the build if the two drift — a half-finished bump is
otherwise invisible until a version-dependent behavior differs.

Fourteen CI jobs boot the pinned image — four test shards, eight leak shards,
the auth session-cookie contract, and the Compose-backed smoke suite — each on
its own runner, so each would pull from Docker Hub independently. Docker Hub
answers some of those with a 500 or a timeout, which surfaces as a vitest
unhandled error carrying no test output at all (or as a failed Compose boot)
and reads like a broken build. So CI pre-pulls the image through
`.github/actions/pull-test-image` (temporary mirror plus bounded retry, followed
by exact daemon-config restoration before later images can pull), and
`startContainer` in `globalSetup.ts` keeps its own three-attempt retry for the
paths that never run that action — a first local run, or a job added without
it. Neither classifies the error by matching on its message; the last one is
reported verbatim.

### `case_type_schemas` seeding lives at the per-test layer

`globalSetup.ts` applies the schema migrations (via `applyMigrations`)
but does NOT seed any `case_type_schemas` rows. Test bodies that need a
typed JSON Schema row insert it themselves via the `db` fixture —
the row is wrapped in the test's transaction and rolls back along
with everything else. That keeps the harness's global state
minimal: tests that don't care about the schema row don't pay for
it; tests that do care construct exactly the schema they need.

### Fixtures

The `db` fixture is the transactional Kysely handle; `pgClient` is the escape hatch for queries Kysely can't compile (`EXPLAIN ANALYZE`, extension probes, `SET`). Both share one connection, so they see each other's writes within the test transaction.
