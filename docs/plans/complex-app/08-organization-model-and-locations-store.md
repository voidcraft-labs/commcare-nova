# Unit 8 — Organization model and locations store

**PR:** `Organization levels, the app-scoped locations store, and owner validation`

**Depends on:** unit 7. · **Blocks:** units 9, 10, 11, and 13.

> Read [the binding contracts](00-contracts.md) first — the locations and
> restore-scope architecture contract there governs the lock discipline, the
> custom-field catalog, and the create-once level and site codes.

Land the app-wide custom-field catalog, stable level and site codes, app-scoped
location rows, realtime revisions, cross-store lock discipline, row integrity,
archive and reassignment rules, Project-move handling, and role-aware owner
validation. The model validates whether a fixed destination can belong to each
applicable persona's address-book footprint; unit 9 proves the emitted fixture
actually carries it.

## Binding facts

- `SQLLocation.location_id` is a server-generated `uuid4().hex`, globally unique,
  and is the **ownership** identity; `site_code` is domain-unique, mutable, and
  auto-derived, and is the human/bulk identity. Custom-field values live in a plain
  metadata JSON blob while definitions use the same `custom_data_fields` machinery
  under `field_type='LocationFields'`. There is no `LocationFixtureDataField`
  model.

The flags below are HQ's storage, not Nova's authoring vocabulary. They fall into
two independent axes, and conflating them is the classic authoring error:
`shares_cases`, `view_descendants`, and `expand_view_child_data_to` shape **case
flow** — which cases a worker receives — while `expand_from`, `expand_from_root`,
`expand_to`, `include_without_expanding`, and `include_only` shape **fixture
contents** only — which locations a worker can see and address. A level that owns
cases and a level that is merely referenceable are different authoring choices,
and Nova names them as such rather than exposing eight booleans.

- `LocationType` flags, per column: `code` (SlugField, auto-derived, domain-unique
  — the fixture `@type`), `shares_cases`, `view_descendants`, `has_users`
  (default true; editing it is toggle-gated), `expand_view_child_data_to` (same
  gate), the fixture-scope flags
  (`expand_from`/`expand_from_root`/`expand_to`/`include_without_expanding`/`include_only`),
  and `administrative` — which is forced true on non-CommTrack domains and is
  therefore **not** a usable "owns nothing" inverse. `has_user` is dead.
- Owner-set assembly: owner ids are the user id plus one id per case-sharing
  group, where each case-owning location materializes as an `UnsavableGroup` whose
  `_id` **is** the `location_id`. Case-owning is two filtered sets, and the
  descendant filter is easy to drop and wrong to drop
  (`models.py::CouchUser::_get_case_owning_locations`): the user's assigned
  locations whose *type* carries `shares_cases`, **plus** the descendants of
  assigned locations whose type carries `view_descendants`, themselves filtered to
  `shares_cases` **and** not archived. Omitting either filter puts non-sharing or
  archived locations in the owner set and the persona sees cases a real worker
  never would. Web users get location groups only, never classic groups.
- Unassigning the last worker from a case-owning location merely **orphans** its
  cases — `owner_id` keeps pointing at the location and nothing moves. HQ's
  "Orphan Case Alerts" setting is a UI warning only. This is validator and SA
  guidance material, never mechanics.
- Location-scoped web permissions (`location_safe`, `access_all_locations`) are an
  HQ-console authorization axis with no wire representation — nothing to model or
  emit.

**Observed:** an author builds a district/facility hierarchy, assigns a persona to
a facility, and is warned before archiving a location that owns cases.
