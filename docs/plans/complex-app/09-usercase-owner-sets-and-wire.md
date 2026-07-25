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
  level code), `id`, and one `{level_code}_id` lineage attribute per level (self
  plus each ancestor's id, empty string otherwise); built-in children `name`,
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
  `last_name`, `hq_user_id`, `commcare_project`, and the location keys — the
  unprefixed spellings, where the registration block writes `commcare_first_name`
  and friends. `ResolvedPreviewIdentity` already carries both projections
  separately (`lib/preview/engine/identity.ts`: `session` and `usercase`), and
  `#user/<prop>` already reads the usercase one, so this unit materializes an
  existing projection rather than deriving a new one.
- A **declared** user property with no value is present-and-empty on the wire,
  not absent: `users/user_data.py::UserData.to_dict` seeds
  `{field: '' for field in self._schema_fields}` before layering authored values.
  An undeclared key is genuinely absent. The materialized usercase must reproduce
  that split — a `= ''` comparison depends on it.

**Persona deletion never deletes case data, and the usercase closes rather than
disappearing.** That decision is already made and its authoring half already
shipped: removing a persona leaves every row it owns in place with `owner_id`
still naming it, exactly as a real worker's cases keep naming them after the
worker leaves a CommCare project, and the confirmation states the row count
instead of offering to reassign or remove them. This unit inherits the
consequence for the materialized usercase: HQ's
`sync_usercase.py::_get_sync_usercase_helper` computes
`close = user.to_be_deleted() or not user.is_active_in_domain(domain) or domain
not in user.get_domains()` and closes the usercase, re-opening it (by archiving
the closing transactions) if the user returns. A persona UUID is never reissued,
so Nova's rule is the simple half of that: **close the usercase, never delete
it**, and a new persona is a new usercase.

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
