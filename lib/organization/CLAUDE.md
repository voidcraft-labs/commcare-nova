# Organization data

`lib/organization` is Nova's persistence boundary for the places an app's
workers work in. The organization's **shape** — its levels and its
custom-field catalog — is blueprint vocabulary and lives in
`lib/domain/organization.ts`; its **contents** — the places themselves — are
app-scoped Postgres rows and live here. Location rows are app-state data, not
case data and not `BlueprintDoc`.

The split is the whole design. A location tree runs to thousands of nodes and
is routinely maintained from outside Nova, so decomposing it into blueprint
entities would put it in undo history and the durable mutation log. But a
persona's assignment names a row, and a row names a level, so the two stores
reference each other in both directions and every rule about those references
is settled transactionally rather than by scan.

## Identity and tenancy

- Rows key on `app_id` alone. The Project authorizes — resolved from the
  freshly locked app row, never from a client-asserted id and never from the
  user's mutable active Project — but it is not a column. That is what makes a
  cross-Project app move a genuine no-op here rather than a fourth thing to
  re-tenant, and `__tests__/integration` proves it rather than asserting it.
- `id` is server-minted UUIDv7 and is the ownership identity: it is what a
  case's `owner_id` holds and what the fixture emits as `@id`. `site_code` is
  the create-once human and bulk-upload identity. Display names change freely;
  neither identity does.
- Custom-field values are keyed by location-property **UUID**, never by slug,
  so renaming a slug rewrites nothing. That mirrors HQ, where definitions live
  in `custom_data_fields` and values in a plain metadata blob on
  `SQLLocation`. There is no `LocationFixtureDataField` model to build to.
- A missing app, a soft-deleted app, a missing place, a place in an app whose
  Project the caller cannot see, and an insufficient role all collapse to one
  `not_found`. A distinguishable "exists but not yours" confirms a resource in
  a Project the caller cannot see.

## Valid writes

Every public mutation parses its input before entering `withAppTx`, then uses
this lock order (`writerTransaction.ts` — do not fork it in a new writer):

1. the **app row** — `FOR SHARE`, or `FOR UPDATE` when this transaction will
   also commit a blueprint batch;
2. re-prove the app is live and still in the scope's Project, then
   re-authorize the actor against that freshly locked Project; a
   chat-originated write also re-proves that the exact run-holder generation
   still owns the app, and losing that fence is terminal rather than a normal
   tool result;
3. create-if-missing and lock `app_organization_state` `FOR UPDATE`;
4. compare `expectedRevision`;
5. lock and write the location rows;
6. advance the revision once, update the maintained count, and issue the
   transactional notification;
7. commit.

**This is the existing app-first prefix, not a new one.** Every run, commit,
and thread write already takes the app row first, so a level removal inside a
blueprint commit and a concurrent location insert at that level serialize on
the app row instead of racing. Lookup writers take Project state then their
table and never take an app lock at all, so neither prefix holds a lock the
other takes first and the two cannot deadlock.

Rejected and semantically empty writes do not advance the revision or notify.
An update whose patch changes nothing but provenance is one of those: advancing
the clock would invalidate every client's snapshot to record that someone
pressed Save on an unedited form. The revision is an invalidation cursor and
the optimistic token in one; it is a canonical nonnegative decimal string
within signed-int64 range on every boundary. Never convert one through
`Number`, serialize a native `bigint`, or compare two lexically without
comparing length first.

Row updates have two explicit custom-value dialects. `values` is a complete
replacement bag, while `valuePatch` changes UUID-addressed entries and uses
`null` to remove one value without clearing its siblings. They are mutually
exclusive in one request. Coordinates are canonical decimal strings and the
database stores the HQ-compatible `numeric(20,10)` precision; do not introduce
a floating-point conversion on either boundary.

A create may carry a bounded, structurally nested descendant tree. The nesting
itself declares parentage, so it introduces no request-local handles beside
Nova's UUID identity vocabulary. The root and descendants are inserted under
the same app/state/location locks, then reverse owner-hop totality is checked
once against the completed branch before the revision advances once. The
compact result mirrors the tree with each server-minted UUID and site code.
This is the born-valid growth path when an existing owner rule requires a
destination below every new source place. Never replace it with sequential
creates: the first row would be an invalid intermediate organization and must
correctly roll back.

## The two directions of cross-store reference

`commitIntegrity.ts` holds both, and both run **inside the blueprint commit's
transaction** (`lib/db/apps.ts::commitGuardedBatchInTransaction`), after the
verdict and before the entity write.

- **Document → rows.** A persona's assignment and every fixed case-owner term
  name location rows, which
  become exact edges in `app_location_references`. The complete set is
  replaced on every authoritative commit, so the edges are derived state any
  unrelated commit reconverges — the same contract lookup edges have. The
  composite `ON DELETE RESTRICT` foreign key is what makes a place a persona
  stands on undeletable; the explicit existence check beside it is what turns
  a broken reference into a sentence an author can act on.
- **Rows → document.** A location row names a level, and its value bag names
  location properties. Removing a level while places still stand at it is
  refused here, counting **archived places too** — HQ's own guard uses
  `SQLLocation.objects` rather than `active_objects`, and unarchiving a place
  whose level had been deleted underneath it would resurrect a row pointing at
  nothing. It is not a foreign key because the commit rewrites
  `blueprint_entities` from its own diff and a `RESTRICT` edge would fire on
  ordinary unrelated edits. Removing a location property instead **sheds** the
  values that named it, because a property uuid is never reissued and an
  orphaned value is unreachable forever — the same choice `lib/lookup`'s column
  removal makes, at the one moment the orphaned key set is exactly known.
  A level-hierarchy edit also revalidates every persisted row's complete
  placement against the candidate hierarchy, including archived rows: roots
  must remain at root levels, and every child place's level must remain a strict
  descendant of its parent place's level. Checking only removed levels misses
  an occupied level whose parent level changed. The document-side removal
  planner also refuses while an automation uses the level to filter descendant
  location recipients, naming the automation to repair before proposing the
  destructive batch.

## Archive is the reversible gesture, and it spans both stores

There is no hard delete, matching the platform: HQ exposes archive/unarchive
only, and its v0.6 location API has no `delete` method at all. Deleting a row
whose id is a live `owner_id` would strand cases irreversibly.

Archiving is also where a published place parts company with Nova. The push
sends live places only, so archiving stops Nova naming that place and the
deployment ledger supersedes its mapping — but v0.6 exposes no archive method
either, so Nova cannot take the remote one down and reports it as left behind
instead. Its site code stays reserved over there, because
`util.py::validate_site_code` queries `SQLLocation.objects` rather than
`active_objects`, which is the same fact this store already honours when it
refuses to remove a level that archived places still stand at.

`setLocationArchived` is the one write that changes both stores in one
transaction, and either half alone is a state the model promises is
unreachable — archived places with a persona still standing on them, or a
persona unassigned from places that are still live. It therefore takes the app
row `FOR UPDATE` and performs a guarded blueprint commit on its own
transaction.

When archive unassigns personas, the nested blueprint commit keeps the calling
surface's provenance (`chat` with the exact holder, `mcp`, or browser
`autosave`) and returns the exact committed document and mutations. The shared
SA/MCP tool adopts that fresh document as a mutating result; it must not keep
reasoning from its pre-archive working copy. That document is an internal
service/tool result only. The browser Server Action returns the bounded public
projection — revision plus archive and unassignment counts — and must not
serialize the complete Blueprint or mutation batch back to the client.

Archive is a two-step public operation. `describeArchiveImpact` returns the
locked revision and the exact subtree, displaced personas, owned-case count,
and blocking owner forms. The committing call supplies that complete payload;
the transaction recomputes it after taking its locks and refuses any mismatch.
Neither the SA/MCP tool nor the browser action may turn a stale impact summary
into consent for a different archive.

Three behaviours are HQ parity, each verified rather than assumed:

- Archiving walks **descendants** (`SQLLocation.archive` takes
  `get_descendants(include_self=True)`); unarchiving walks descendants **and
  ancestors**, because a place is unreachable while any ancestor is archived.
- Archiving **unassigns** every persona standing on an archived place, and the
  next remaining place becomes primary — `tasks.py::update_users_at_locations`
  calling `unset_location_by_id(..., fall_back_to_next=True)`. The in-line
  `_remove_user` on the model is dead code; it acts only on the retired
  `user_id` field.
- Cases owned by an archived place **do not move**. No cascade exists anywhere
  in HQ; its "Orphan Case Alerts" setting is a console warning. So
  `describeArchiveImpact` reports the count and the archive proceeds. Inventing
  a reassignment would be Nova performing a migration the platform does not.

A fixed case-owner rule is different from a persona assignment: it is form
behavior, not a worker standing somewhere. Archiving its target is therefore
blocked and `describeArchiveImpact` names the forms holding it; silently
clearing or retargeting that rule would change where future cases go.

Persona assignments are admitted transactionally against the same locked rows:
every target must be live and its current level must hold workers. Fixed owner
targets must be live, stand at a case-owning level, and fall inside every
assigned persona's address-book footprint. Those are cross-store facts and
must never be approximated by a document-only validator.

Retyping or moving a place changes those same facts, so both operations write a
tentative row and then revalidate every persona assignment and fixed-owner rule
inside the transaction. A move also changes ancestry for otherwise untouched
rows. Create, retype, move, archive, unarchive, and blueprint commits
additionally prove that each authored reverse owner hop remains scalar and
total: below every applicable live case-owning ancestor there is exactly one
live destination at the requested level. The same check proves the destination
is present in every applicable persona's exact address-book footprint. Any
failure rolls back the row and revision together.

Unarchiving deliberately does **not** restore assignments. The archive removed
them and they are ordinary authored data now; silently re-adding a persona to a
place someone may have deliberately moved them off would overwrite an edit with
a memory of an older one.

## What Nova enforces that HQ does not

- **A place's parent must stand at a level STRICTLY ABOVE its own** —
  `lib/domain/organization.ts::levelMayNestUnder`, shared with the authoring
  surface's parent picker so an author is never offered a placement the store
  will refuse. Skipping an intermediate rung is allowed and is a real
  capability: health hierarchies have optional levels, and the fixture carries
  one faithfully by blank-filling the missing level's `{code}_id`, so an
  expression joining on it truthfully finds nothing. What the rule forbids is a
  level repeating inside one chain, which breaks the wire: the attribute writes
  in `fixtures.py::_get_fixture_node` go self-first then upward and are
  unconditional, so an ancestor sharing the child's code overwrites the child's
  own id in its own lineage attribute and every two-hop join through it
  resolves to the wrong element. Since two levels can never share a code,
  strict ancestry is exactly the condition that keeps a chain's codes distinct.

  **A skipped rung is a deployment constraint, not a wire one.** HQ refuses to
  CREATE one: both its web form and its v0.6 API route through
  `util.py::get_location_type`, which admits only the types
  `forms.py::LocationForm.get_allowed_types` returns for the chosen parent, and
  that query filters `parent_type=parent.location_type` — immediate children
  alone. Preview and local `.ccz` are correct; a push refuses at preflight and
  names each offending place (`lib/deployment/locationResourcePlan.ts`), before
  any batch is sent. Nova models the real hierarchy anyway, because the
  alternative is an invented placeholder whose id every `district_id` join
  would then wrongly resolve — a confidently wrong answer in place of a
  truthful empty one.
- **Sibling place names may repeat here, and HQ refuses them.**
  `util.py::has_siblings_with_name` matches `(domain, name, parent)` and
  `v0_6.py::LocationResource._update` calls it on every push, while Nova's only
  name-uniqueness rule is for LEVELS. Two clinics called "North" under one
  district are therefore authorable and unpushable, and the same preflight edge
  names both halves. Deliberately not enforced here: the constraint belongs to
  one deployment target rather than to the model, and refusing the write would
  make a legitimate local naming scheme unauthorable for the sake of a
  destination the app may never have.
- **Site codes are create-once.** HQ's are mutable, and its v0.6
  `_update` REGENERATES the code on any request carrying a new `name` without
  one — so a rename that let the code drift would silently repoint the
  bulk-upload key on the next push. The push must always send the stored code.
- A level may change only while the place is a **leaf**, which is HQ's rule
  (`util.py::get_location_type`) enforced in the store rather than the form.

## Owner sets and the footprint are the SAME rules, enumerated

Two derivations turn the authored organization into things other packages
consume. Both deliberately walk a predicate that already exists rather than
restating its arms, because two encodings of one rule drift and the one that
drifts is the one nobody reads.

- `ownerSets.ts::personaOwnerIds` is `CouchUser.get_owner_ids`: the worker's
  own id plus one id per case-sharing group. Nova has no classic groups, so
  every other member is a place — HQ turns each case-owning location a user
  reaches into a group whose `_id` IS the `location_id`
  (`SQLLocation.case_sharing_group_object`), which is why place ids drop
  straight into the list rather than being mapped through anything. WHICH
  places is `assignmentReceivesCasesFrom`, the same predicate the commit gate
  asks one target at a time.
- `footprint.ts::personaFootprint` is the enumerating twin of
  `assignmentFootprintIncludes`, pinned to it by a `fast-check` differential
  over generated level forests and place trees. That property test is the
  cheapest strong guard in this package: it fails the moment an arm is added
  to one side and not the other.

`memberOwnerIds` is the honest answer for previewing as the signed-in member:
a worker assigned nowhere has no case-sharing group, so the set is exactly
their own id.

`readOrganizationTopology` is the read those two consume — narrow columns
under `repeatable read`, returning the revision it read at. The Blueprint and
the place rows are still read at different instants; the REVISION is what
closes that, not a longer lock.

These predicates declare `OrganizationCollections`, not `BlueprintDoc`,
because the organization slice is all they read. The preview resolves a
worker's owner set from an authorized `PersistableDoc` snapshot, which carries
no `fieldParent` index and has no reason to build one to answer a question
about places.

## Boundaries

- `service.ts` is server-only and owns SQL. It takes an authorized
  `OrganizationScope`; no route or action contains database logic.
- `actions.ts` authenticates, runtime-parses untrusted arguments, authorizes
  the explicit app id the displayed state named, and maps typed errors to
  discriminated results.
- Shared SA/MCP reads are bounded projections. `getOrganization` returns at
  most 50 total entities across levels, place-information fields, and places,
  with one opaque cursor bound to the exact Blueprint sequence, organization
  revision, query, and projection. It returns per-collection counts and a
  completeness bit; a changed snapshot makes a later page say to restart.
  Custom values are omitted unless explicitly requested. Every SA/MCP row
  write, including an atomic branch create, requires the exact revision it
  read, and callers chain the revision each write returns.
- `countCasesOwnedBy` in `service.ts` is the one place this package reads case
  rows, and it is raw SQL because `cases` belongs to the case store's schema
  rather than `AppDatabase`. It is advisory only — never a gate.
- Do not import `lib/commcare` here. Unit 9 owns the fixture's meaning and its
  budget; it may refuse to emit a footprint but cannot reinterpret these rows.
- A persona's assignment now reaches CommCare HQ, but only through the
  provisioning call: `lib/deployment/workers.ts` maps each assigned place
  through the deployment ledger's `location` mappings and sends
  `primary_location` + `locations` together. That is a WORKER's assignment,
  not a case-owner rule, and the two stay separate — a place the ledger has no
  live mapping for refuses the call rather than being created on the way past.
- The compiler lowers fixed-place and reverse-hop owner terms, and every export
  mode is still closed — but for neither of the two reasons this file used to
  give. The HQ identity map exists: publishing creates the places on the target
  project space and the deployment ledger holds each one's `location_id`. The
  device fixture is not Nova's to ship either — HQ builds it on RESTORE from
  those same rows (`locations/fixtures.py::FlatLocationSerializer`), so nothing
  Nova exports could carry one. What remains is the translation: `emitTerm`
  writes Nova's own place UUID, and no compile path resolves it through the
  deployment's `location` mappings — and a local `.ccz` has no deployment to
  resolve against at all. Do not describe an authored owner term as deployable
  until a compile path reads those mappings, and do not re-add the fixture or
  the identity map to the refusal's reasons.
  `lib/commcare/locations/__tests__/flatLocationsFixture.ts` emits Nova's own
  copy of that fixture purely so the lowering can be proved against the real
  bytes; it is a test asset on no delivery path.

Keep pure schema/derivation/plan tests separate from Postgres integration
tests, and bundle the Postgres-focused ones into one invocation so local and
CI runs do not create unnecessary containers.
