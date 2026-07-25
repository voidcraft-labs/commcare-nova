# Unit 9 — Usercase, owner sets, restore scope, and wire

**PR:** `Usercase materialization, owner sets, restore closure, and the location fixture`

**Depends on:** unit 8. · **Blocks:** unit 13.

> Read [the binding contracts](00-contracts.md) first — the restore-scope
> contract there (authoritative Postgres revision, measured CTE before
> materialization) governs this unit's storage decisions.

Materialize persona usercases without clobbering app-authored fields; derive owner
sets; run tenant-complete restore closure; lower user and location terms; and emit
the flat location fixture and usercase actions. Start with the measured CTE inline
and Postgres revision invalidation, and re-run current-scale measurements before
choosing materialization.

**The restore closure is a fixpoint, not a filter**, and it is the hardest part of
this unit. Ownership alone does not decide what a device holds; extension chains
pull cases in that nobody owns. The rules, verified in
`casexml/apps/phone/data_providers/case/livequery.py::do_livequery`:

- A case is **available** if it is open and not an extension case, or open and the
  extension of an available case. A case that is both a child and an extension
  counts as *not* an extension, so it is available on the first arm.
- A case is **live** if it is owned and available. An owned open extension is
  never seeded directly — it becomes live only once its host chain is available.
- Liveness then **propagates transitively** through three edge kinds at once
  (`enliven`): a live case makes its extensions, its hosts, and its parents live.
  So an unowned parent arrives because its child is owned, and an unowned host
  arrives because its extension is.

Preview must reproduce this fixpoint rather than approximate it with a join —
this is the mechanism behind the soft-close doctrine in
`docs/research/advanced-case-actions.md`, where hard-closing a root silently drops
its whole extension tree from every device. Acceptance runs the closure against
seeded chains that are unowned-but-reachable and owned-but-unreachable in both
directions.

## Binding facts

- **Emit only the flat location fixture.** The hierarchical `commtrack:locations`
  fixture is gated by `HIERARCHICAL_LOCATION_FIXTURE`, which is deprecated; the
  flat fixture is default-on for locations-enabled domains; and no "Sync All
  Locations" toggle exists (`INCLUDE_ALL_LOCATIONS` is unrelated conditional-alert
  targeting).
- Flat fixture byte contract: `<fixture id="locations" user_id indexed="true">`
  wrapping `<locations>` of flat `<location>` elements with attributes `type` (the
  level code), `id`, and one `{level_code}_id` lineage attribute **per level the
  app defines** — not one per level on that place's own chain.
  `locations/fixtures.py::_get_fixture_node` blank-fills every level's attribute
  first (`attrs.update({attr: '' for attr in location_type_attrs})`), then writes
  self, then walks upward writing each ancestor, so a place carries the whole
  set with empty strings where it has no ancestor at that level. The index
  schema is built from the same full list. Emitting only the occupied
  attributes produces a fixture that does not match.
  Those writes are also unconditional and go **self first, then upward**, so an
  ancestor sharing a place's own level code overwrites the place's id in its own
  lineage attribute — which is why a level may never repeat inside one chain;
  built-in children `name`,
  `site_code`, `external_id`, `latitude`, `longitude`, `location_type`, and
  `supply_point_id` (string-coerced, empty when unset); custom fields as
  grandchildren under exactly **one** `<location_data>` child (every defined field,
  empty text when unset); and an index-schema node over `@{code}_id` per level plus
  `@id`, `@type`, and `name`. Custom fields are not indexed.
- **Cross-level addressing joins on HQ's built-in `{code}_id` lineage attributes,
  not on custom fields.** Custom location data is always `<location_data>`
  children, never attributes. The indexed `data_<slug>` shape appearing in two
  orphaned HQ test files is a removed feature (`index_in_fixture`) — do not build
  to it.
- Location-fixture **scope is a footprint, not the whole tree**: a recursive SQL
  CTE over assigned locations plus ancestors, with the expand/include flags encoded
  as depth rules (`include_without_expanding` = all of a level plus ancestors;
  `include_only` = a type filter; ancestors always included un-expanded).
- **Compute that depth over the LOCATION hierarchy, not the level hierarchy —
  and this is a real semantic choice, not an approximation of HQ.**
  `locations/sql_templates/get_location_fixture_ids.sql` computes the depth cap
  by walking `locations_locationtype.parent_type_id` while its traversal counts
  depth over `locations_sqllocation.parent_id`, then compares the two directly
  (`"fixture_ids"."depth" < xf."depth"`). Its own comment admits the assumption:
  *"This traverses the location type hierarchy, which is **assumed** to mirror
  the location hierarchy."* On a tree where every rung is filled the two
  arithmetics are identical — walking up N locations walks up N types — so the
  distinction is unobservable. They diverge only on a **ragged** tree, and HQ
  cannot hold one: its location API refuses to create a place that skips a rung
  (see [the deliberate target gaps](00-contracts.md#deliberate-target-gaps)). So
  there is no upstream behaviour to be faithful to, and the location hierarchy
  is the only defined semantics for a tree only Nova can hold. Keep this
  reasoning attached to the code: without it, a later reader sees Nova diverging
  from `get_location_fixture_ids.sql` and "fixes" it toward the type hierarchy
  for parity, reintroducing an over-inclusion no device will ever exhibit.
- The restore's user-groups fixture carries location groups verbatim as
  `<group id="{location_id}">`, and the client builds its owner set **exclusively**
  from user ids plus that fixture (`UserGroupsFixtureProvider`,
  `SandboxUtils::extractEntityOwners`). That pair is the exact formula a faithful
  preview owner set reproduces.
- The usercase is HQ-gated by the paid `USERCASE` privilege. Rows sync on user save
  with case type `commcare-user`, `hq_user_id` = the user id, `external_id` = the
  user id, and owner = the user's own id. Nova cannot see a target domain's plan,
  so authoring stays ungated and the plan requirement travels as an export note.
- Usercase wire shape: `usercase_update`/`usercase_preload` emit a case block at
  `/data/commcare_usercase/case` whose `case/@case_id` binds to
  `instance('commcaresession')/session/data/usercase_id`, and the suite adds a
  computed `SessionDatum(id='usercase_id', function=UsercaseXPath().case()/@case_id,
  requires_selection=False)` plus a count-equals-1 assertion keyed
  `case_autoload.usercase.case_missing`.
- Client-side the usercase is an ordinary case — there is zero `commcare-user`
  special-casing in commcare-core or Formplayer and nothing blocks create or close.
  Any create/close prohibition is Nova's own authoring guard matching HQ's
  authoring-side rule, not a runtime constraint.
- The usercase's **built-in fields are not the session block's**.
  `callcenter/sync_usercase.py::_get_user_case_fields` copies the authored user
  data (filtered to valid XML element names) and adds `name`, `username`,
  `email`, `language`, `phone_number`, `last_device_id_used`, `first_name`,
  `last_name`, `hq_user_id`, and `commcare_project` — the unprefixed spellings,
  where the registration block writes `commcare_first_name` and friends. It also
  writes all three location keys **unconditionally**, taking an explicit `else`
  branch to `''` when the worker has no location, where
  `get_user_session_data` omits them entirely — an asymmetry that is easy to
  state backwards. `ResolvedPreviewIdentity` already carries both projections
  separately and reproduces that difference
  (`lib/preview/engine/identity.ts`: `session` and `usercase`), and
  `#user/<prop>` already reads the usercase one, so this unit materializes an
  existing projection rather than deriving a new one.
- A **declared** user property with no value is present-and-empty on the wire,
  not absent: `users/user_data.py::UserData.to_dict` seeds
  `{field: '' for field in self._schema_fields}` before layering authored values.
  An undeclared key is genuinely absent. The materialized usercase must reproduce
  that split — a `= ''` comparison depends on it.

**Persona deletion never deletes case data.** That half is decided and shipped:
removing a persona leaves every row it owns in place with `owner_id` still
naming it, and the confirmation states the row count instead of offering to
reassign or remove them.

**Do not read that as HQ parity — HQ has two answers and neither transfers.**
Deactivating a worker, or removing them from the domain, closes their usercase
and leaves their cases alone:
`sync_usercase.py::_get_sync_usercase_helper` computes
`close = user.to_be_deleted() or not user.is_active_in_domain(domain) or domain
not in user.get_domains()` and calls `update_user_case(..., close_case)`,
re-opening a closed one (by archiving the closing transactions) if the user
returns. DELETING a worker is destructive: `users/models.py::CommCareUser.retire`
→ `::delete_user_data` walks every case the worker owns
(`get_case_ids_in_domain_by_owners`) and dispatches
`tag_cases_as_deleted_and_remove_indices`, soft-deleting them and stripping
indices — the usercase among them, since the worker owns it.

So this unit owns a real decision rather than inheriting one, and it is now
made: **deleting a persona CLOSES its materialized usercase. It never deletes
it.** Four reasons, in the order they decide it:

- Nova already preserves the persona's ordinary case rows, because a persona is
  a design and test actor rather than a person who left an organization, and its
  cases are the author's own test data. Deleting the usercase would contradict
  that inside the same gesture.
- The usercase is **not purely derived**. `usercase_update` means a form can
  write to it during preview, so it can carry real properties an author produced
  by exercising their app. Deleting it destroys test data nothing else holds;
  closing preserves it and leaves it visible with a closed status, which is what
  an author wants to see after a preview run.
- It is the option HQ's own **deactivation** path takes, and the one ambiguity
  that path carries does not exist here: a persona UUID is never reissued, so a
  closed usercase can never be resurrected meaning something else.
- It needs no new mechanism. `CaseStore.close()` is already one storage
  operation that stamps `closed_on` and `status` together.

Closing is what HQ's deactivation does, but do not record this as parity: the
two anchored paths above disagree with each other, so there is no single
upstream answer to match. Nova takes neither wholesale, because neither was
written about an actor whose cases are somebody's test fixtures.

One delivery precondition is easy to miss and silently breaks the whole fixture:
a form only carries the `locations` instance if something in it **references**
that instance. HQ authors work around this with a dummy always-false question —
exactly the hidden scaffolding Nova must never make an author think about — so
Nova's emitter adds the declaration whenever a location term appears anywhere in
the form. The general rule governing any fixture family: `instance('X')` binds a
declared `<instance id="X" src="jr://fixture/Y">`, and `Y` — the substring after
the last `/` — must equal the delivered fixture's id
(`CommCareInstanceInitializer::loadFixtureRoot`). A mismatched pair resolves to
nothing at runtime with no build-time error.

Acceptance includes proving that every valid fixed or reverse-hop destination is
present in the applicable persona's emitted fixture, that an out-of-footprint
destination is rejected before commit, and that a form carrying a location term
emits its instance declaration without any authored placeholder.

**Observed:** previewing as a persona shows exactly the cases that persona's
worker would see on a device.
