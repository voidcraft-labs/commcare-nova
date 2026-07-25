# Unit 8 — Typed location addressing and owner validation

**PR:** `Location terms, exact reference edges, and role-aware owner validation`

**Depends on:** nothing outstanding. · **Blocks:** units 9, 10, 11, and 13.

> Read [the binding contracts](00-contracts.md) first, and
> [what is built](../complex-app-plan.md#organization-levels-places-and-assignment)
> for the levels, the places, the archive cascade, and the cross-store
> reference machinery this unit extends.

The organization model, the app-scoped locations store, the archive and
reassignment rules, and persona assignment are shipped. What remains is
**addressing**: making a location a typed, resolvable reference rather than a
string, and validating that an owner target is one a real worker could reach.

Both extend machinery that already exists. `app_location_references` and
`commitIntegrity.ts::extractLocationReferenceTargets` already carry exact
document→row edges for persona assignments; an authored location term is the
same kind of edge and extends that one extractor rather than adding a second
table.

## What to build

**Typed location terms.** Two shapes, both resolving to a location id:

- a **fixed** destination — a specific place, stored by row UUID so a rename
  never rewrites an expression;
- a **reverse hop** — "the place at level L that this case's owner belongs to",
  the two-hop join the Colorado apps spell as
  `instance('locations')/locations/location[@type='facility_data'][@facility_id = <owner>]/@id`.

Today that join is a project convention copy-pasted across dozens of binds, and
nothing checks that an owner expression yields a location that can own cases — a
typo produces an orphan case no restore will ever contain. Making it structural
is the same references-are-identity move Nova already made for XPath.

**Role-aware owner validation.** An owner target naming a location must name one
whose level owns cases, and a fixed destination must be reachable in the
applicable persona's address-book footprint. The model proves the destination
*can* belong to that footprint; unit 9 proves the emitted fixture carries it.

Adding a reverse-hop expression must account for current rows and references
atomically, under the same app-first lock prefix everything else here uses.

## Binding facts

- **Owner-set assembly, with two filters that are easy to drop and wrong to
  drop.** Owner ids are the user id plus one per case-sharing group, where each
  case-owning location materializes as an `UnsavableGroup` whose `_id` **is** the
  `location_id` (`locations/models.py::SQLLocation.case_sharing_group_object`).
  Case-owning is two filtered sets
  (`users/models.py::CouchUser._get_case_owning_locations`): the user's assigned
  locations whose *type* carries `shares_cases`, **plus** the descendants of
  assigned locations whose type carries `view_descendants`, themselves filtered
  to `shares_cases` **and** not archived. Omit either and a persona sees cases a
  real worker never would. Web users get location groups only, never classic
  groups.
  That function has **two implementations**, and the default is the ORM one just
  described; the SQL arm (`locations/sql_templates/get_case_owning_locations.sql`)
  is gated by `toggles.USH_RESTORE_FILE_LOCATION_CASE_SYNC_RESTRICTION` and is
  the only path that honours a descendant depth cap.
- **Unassigning the last worker from a case-owning location merely orphans its
  cases** — `owner_id` keeps pointing at the location and nothing moves. HQ's
  "Orphan Case Alerts" is a UI warning only. This is validator and SA *guidance*
  material, never mechanics: do not build a reassignment cascade CommCare does
  not perform.
- **Cross-level addressing joins on HQ's built-in `{code}_id` lineage
  attributes, not on custom fields.** Custom location data is always
  `<location_data>` children, never attributes, so it can never be a join key.
  The indexed `data_<slug>` shape in two orphaned HQ test files is a removed
  feature (`index_in_fixture`) — do not build to it.
- Location-scoped web permissions (`location_safe`, `access_all_locations`) are
  an HQ-console authorization axis with **no wire representation** — nothing to
  model or emit.

**Observed:** an author points a referral at "the receiving site's queue" and is
told, before saving, when that destination is one the worker could never reach.
