# Provisioning drivers

**PR:** `Provision mobile workers`

**Depends on:** nothing outstanding. · **Blocks:** [App setup UI](app-setup-ui-sa-mcp-and-docs.md),
[session endpoints](session-endpoints-and-deep-links.md), and
[multi-select](multi-select-related-cases-and-profile.md).

> Read [the binding contracts](00-contracts.md) first — the HQ deployment safety
> contract there governs ownership, adoption, retry, and rename behavior for
> every driver here.

Implement explicit mobile-worker provisioning against the shipped deployment
record's ownership mappings (`lib/deployment`), following the shape the
lookup-table and location pushes established: preflight everything the target
needs before any external mutation, and refuse rather than write over a resource
Nova cannot account for. Provisioning is an explicit action rather than a
publish rung, because creating a person's account is not something a publish
should do on the way past. Never store plaintext credentials. Specify username
conflict, temporary secret, update/adoption, and deletion behavior.

Lift `LOCATION_OWNER_EXPORT_NOT_ACTIVE`'s `hq-upload` arm only once the
persona-scoped `locations` fixture exists; the location identity map already
does. Whichever of this unit and the usercase unit lands second lifts it.

## Binding facts

- **The API path is resource-first now.** `corehq/apps/api/urls.py` (module
  docstring): since 2024 each resource versions independently and the old
  `v0.N` paths are duplicated under a resource-first form; both are live and
  resolve to the same class. Use `/a/<domain>/api/user/v1/`
  (`v0_5.CommCareUserResource`).
- **DELETE soft-deletes the worker's CASES, so Nova never issues it.**
  `api/resources/v0_5.py::CommCareUserResource` allows detail DELETE, which is
  `users/models.py::CommCareUser.retire` → `::delete_user_data` →
  `tag_cases_as_deleted_and_remove_indices`. Removing a persona therefore
  reports the worker as left behind rather than retiring them.
- **The username is create-only.** `::obj_create` normalizes through
  `users/util.py::generate_mobile_username` (`'name'` →
  `'name@<domain>.commcarehq.org'`) and a taken name raises `ValidationError` →
  `BadRequest`. It is popped before `_update` and absent from the editable map,
  so it can never be changed afterwards.
- **A password is always required.** The two-stage branch fires only when
  `require_account_confirmation` or `send_confirmation_email_now` is set. Nova
  sets neither, so the `else` branch applies and no privilege probe is needed.
- **The update field map is closed.** `api/user_updates.py::CommcareUserUpdates.update`
  accepts exactly `default_phone_number, email, first_name, groups, language,
  last_name, password, phone_numbers, user_data, role, location`; anything else
  raises `"Attempted to update unknown or non-editable field"`.
- **Locations go together or not at all.** `::_update_location` /
  `::_validate_locations`: `primary_location` and `locations` must be supplied
  together, the primary must appear in the list, and each id resolves through
  `SQLLocation.active_objects`.
- **Identity is the server-assigned `user_id`** — the durable key the usercase
  and session keys ride on.
- **Web users are out of reach.** They come in via `InvitationResource` POST,
  which resolves `role` by **name** against the domain's roles and fails without
  one, so a Nova user type cannot supply it. That gap is why the shipped
  user-property catalog does not author `required_for`: Nova provisions mobile
  workers only, so the pushed value is always `["commcare_user"]`.
- **No REST resource exists for the user-data field schema**, so it stays a
  setup-artifact instruction.

## Scope

- Migration: `app_deployment_resources.kind` gains `worker`.
- `lib/commcare/hq/workers.ts`: `findHqMobileWorker` (read
  `v0_1.py::CommCareUserResource.obj_get_list` for the supported filter; fall
  back to list-and-match if username is not filterable), `createHqMobileWorker`,
  `updateHqMobileWorker` — sending only the eleven keys the update map accepts.
- **Explicit, not a publish rung.** A new server action plus MCP tool
  `provision_workers({ app_id, server, domain, workers: [{ persona_uuid,
  username }], adopt_usernames? })`.
- **The username is deployment state, not blueprint state.** A persona is a
  design actor and may be provisioned on several domains, so the username lives
  in the ledger's `pushed_identity`, supplied per call, with a slug derived from
  the persona name offered as the default. No blueprint schema change, so no new
  SA vocabulary.
- **Credentials are never stored.** A strong password is generated per worker,
  returned once in the action result for the operator to copy, never written to
  Postgres, never passed to `LogWriter` or `log.*`. A redaction test pins that.
- `user_data` is `personaUserData(persona, doc)` re-keyed from property UUID to
  current slug; `primary_location` / `locations` come from
  `assignedLocationUuids(persona.locations)` mapped through the location
  ledger's `location` mappings, sent together with the primary in the list.
- A taken username is a named conflict resolvable only by explicit
  `adopt_usernames`, which records `ownership: "adopted"` and switches to `PUT`.
- `preflight.ts`: `required-worker-data` becomes **blocking on the provisioning
  action**, not on publish — Nova still creates no workers during a publish, so
  refusing one there would refuse a publish that works.
- Surfaces: a **Workers** area on each target's record in the Publish dialog,
  plus the MCP tool. So it does not get lost when the App setup UI unit builds
  the Deployment section, [that file](app-setup-ui-sa-mcp-and-docs.md) gains one
  line naming the Publish-dialog Workers area as something that section
  **inherits and relocates, not rebuilds**.
- Docs: `content/docs/users-and-personas.mdx` § What travels to CommCare,
  `content/docs/publishing.mdx`, `content/docs/mcp/tools.mdx`.
- Shed `WORKER_PROVISIONING_NOT_SHIPPED` and `GAP_PUSH_PROVISIONING_DRIVERS`
  from `lib/agent/design/platformConstraints.ts` and
  `lib/agent/build/executionBrief.ts` (a source test fails while a `gapUnitFile`
  names a file that no longer exists).

**Observed:** a worker provisioned for a persona can sign in, standing in the
places their persona names, with the password shown once and present in no log.
