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
   re-authorize the actor against that freshly locked Project;
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

## The two directions of cross-store reference

`commitIntegrity.ts` holds both, and both run **inside the blueprint commit's
transaction** (`lib/db/apps.ts::commitGuardedBatchInTransaction`), after the
verdict and before the entity write.

- **Document → rows.** A persona's assignment names location rows, which
  become exact edges in `app_location_references`. The complete set is
  replaced on every authoritative commit, so the edges are derived state any
  unrelated commit reconverges — the same contract lookup edges have. The
  composite `ON DELETE RESTRICT` foreign key is what makes a place a persona
  stands on undeletable; the explicit existence check beside it is what turns
  a broken reference into a sentence an author can act on.
- **Rows → document.** A location row names a level. Removing a level while
  places still stand at it is refused here, counting **archived places too**
  — HQ's own guard uses `SQLLocation.objects` rather than `active_objects`, and
  unarchiving a place whose level had been deleted underneath it would
  resurrect a row pointing at nothing. It is not a foreign key because the
  commit rewrites `blueprint_entities` from its own diff and a `RESTRICT` edge
  would fire on ordinary unrelated edits.

## Archive is the reversible gesture, and it spans both stores

There is no hard delete, matching the platform: HQ exposes archive/unarchive
only, and its v0.6 location API has no `delete` method at all. Deleting a row
whose id is a live `owner_id` would strand cases irreversibly.

`setLocationArchived` is the one write that changes both stores in one
transaction, and either half alone is a state the model promises is
unreachable — archived places with a persona still standing on them, or a
persona unassigned from places that are still live. It therefore takes the app
row `FOR UPDATE` and performs a guarded blueprint commit on its own
transaction.

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

Unarchiving deliberately does **not** restore assignments. The archive removed
them and they are ordinary authored data now; silently re-adding a persona to a
place someone may have deliberately moved them off would overwrite an edit with
a memory of an older one.

## What Nova enforces that HQ does not

- **A place's parent must stand at its level's parent level.** HQ lets any
  location parent any other and only its authoring form restricts the choice
  (`forms.py::LocationForm.get_allowed_types`). Nova enforces it in the store,
  because a place whose parent skips a level has no coherent `{code}_id`
  lineage attribute and every expression joining on that attribute silently
  misses.
- **Site codes are create-once.** HQ's are mutable, and its v0.6
  `_update` REGENERATES the code on any request carrying a new `name` without
  one — so a rename that let the code drift would silently repoint the
  bulk-upload key on the next push. The push must always send the stored code.
- A level may change only while the place is a **leaf**, which is HQ's rule
  (`util.py::get_location_type`) enforced in the store rather than the form.

## Boundaries

- `service.ts` is server-only and owns SQL. It takes an authorized
  `OrganizationScope`; no route or action contains database logic.
- `actions.ts` authenticates, runtime-parses untrusted arguments, authorizes
  the explicit app id the displayed state named, and maps typed errors to
  discriminated results.
- `countCasesOwnedBy` in `service.ts` is the one place this package reads case
  rows, and it is raw SQL because `cases` belongs to the case store's schema
  rather than `AppDatabase`. It is advisory only — never a gate.
- Do not import `lib/commcare` here. Unit 9 owns the fixture's meaning and its
  budget; it may refuse to emit a footprint but cannot reinterpret these rows.

Keep pure schema/derivation/plan tests separate from Postgres integration
tests, and bundle the Postgres-focused ones into one invocation so local and
CI runs do not create unnecessary containers.
