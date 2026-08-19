# Push and provisioning drivers

**PR:** `Push locations and provision workers`

**Depends on:** nothing outstanding. · **Blocks:** [App setup UI](app-setup-ui-sa-mcp-and-docs.md),
[session endpoints](session-endpoints-and-deep-links.md), and
[multi-select](multi-select-related-cases-and-profile.md).

> Read [the binding contracts](00-contracts.md) first — the HQ deployment safety
> contract there governs ownership, adoption, retry, and rename behavior for
> every driver here.

Implement location push and explicit worker provisioning against the shipped
deployment record's ownership mappings (`lib/deployment`), following the shape
the lookup-table push established: preflight everything the target needs before
any external mutation, push and verify before app import where the target APIs
permit, and refuse rather than write over a resource Nova cannot account for. If
an unavoidable required step can occur only after import, its failure leaves the
deployment explicitly `incomplete` and withholds `released` and `runnable`. Never
store plaintext credentials. Specify username conflict, temporary secret,
update/adoption, archive, and partial-failure behavior.

Lift `LOCATION_OWNER_EXPORT_NOT_ACTIVE`'s `hq-upload` arm only once the location
identity map and the persona-scoped `locations` fixture both exist; whichever of
this unit and the usercase unit lands second lifts it.

## Binding facts

- **The API paths are resource-first now.** `corehq/apps/api/urls.py` (module
  docstring): since 2024 each resource versions independently and the old
  `v0.N` paths are duplicated under a resource-first form; both are live and
  resolve to the same class. Use `/a/<domain>/api/location/v2/`
  (`locations.v0_6.LocationResource`),
  `/a/<domain>/api/location_type/v1/` (`locations.v0_5.LocationTypeResource`),
  and `/a/<domain>/api/user/v1/` (`v0_5.CommCareUserResource`).
- **HQ requires the IMMEDIATE parent level, and Nova does not.**
  `locations/util.py::get_location_type` calls
  `forms.py::LocationForm.get_allowed_types`, which filters
  `LocationType.objects.filter(parent_type=parent.location_type)`. Nova
  deliberately lets a place skip a rung
  (`lib/domain/organization.ts::levelMayNestUnder` is strict-ancestry), so a
  skipped rung is unpushable and must be a NAMED blocking preflight edge rather
  than a mid-push failure that leaves half a tree there.
- **An archived HQ location still holds its site code.**
  `locations/util.py::validate_site_code` queries `SQLLocation.objects`, not
  `active_objects`. Combined with the resource exposing no archive or delete
  method, an archived Nova place can never be archived remotely by Nova and its
  code stays taken. Both belong in the left-behind report.
- **Locations.** v0.6 `LocationResource` is writable: list GET/POST/PATCH, where
  `patch_list` is atomic and capped at `patch_limit = 100` per request, upserting
  (an item with `location_id` updates, otherwise creates), plus detail GET/PUT.
  Create requires `name` and `location_type_code`; the parent is given as
  `parent_location_id` (an HQ `location_id`, hence strict parent-before-child
  ordering); `site_code` is settable, domain-unique-validated, and auto-derived when
  omitted; `location_data` is validated against the domain's `LocationFields`
  definition and unknown keys raise `LocationAPIError`. All location APIs require
  the paid `LOCATIONS` privilege, and v0.6 exposes active locations but no archive
  or delete method.
- **The org model itself is not pushable.** `LocationTypeResource` has no
  authorization override and falls back to tastypie `ReadOnlyAuthorization`, so
  level definitions are UI-only and ship in the setup artifact while the tree
  pushes via v0.6.
- **Users.** `CommCareUserResource` list GET/POST (username is create-only,
  normalized through `generate_mobile_username` and immutable afterwards; a
  password is required at create unless the domain has
  `TWO_STAGE_MOBILE_WORKER_ACCOUNT_CREATION`), detail GET/PUT (`user_data` flows
  through the system-key-guarded `UserData.update`), DELETE = soft retire.
  `primary_location` and `locations` must be supplied **together**, the primary
  must be in the list, and every id is verified against active locations. Identity
  is the server-assigned `user_id` — the durable key the usercase and session keys
  ride on. Web users come in via `InvitationResource` POST, which resolves `role`
  by **name** against the domain's roles and fails without one, so a Nova user type
  cannot supply it. No REST resource exists for the user-data field schema.
  That web-user gap is why the shipped user-property catalog does not author
  `required_for`: Nova provisions mobile workers only, so the pushed value is
  always `["commcare_user"]`.

**Observed:** an author pushes an app whose places address a two-level
organization, and the tree exists on HQ, parents before children, before the app
that addresses it. A worker provisioned for a persona can sign in, with the
password shown once and present in no log.
