# Unit 12 — Push and provisioning drivers

**PR:** `Push referenced lookup tables and locations, and provision workers`

**Depends on:** unit 11. · **Blocks:** units 13, 16, and 17.

> Read [the binding contracts](00-contracts.md) first — the HQ deployment safety
> contract there governs ownership, adoption, retry, and rename behavior for
> every driver here.

Implement referenced-table push, location push, and explicit worker provisioning
against the ownership mappings from unit 11. Preflight organization levels,
fields, and toggles before external mutation. Push and verify required tables and
locations before app import or release where the target APIs permit. If an
unavoidable required step can occur only after import, its failure leaves the
deployment explicitly `incomplete` and withholds `released` and `runnable`. Never
store plaintext credentials. Specify username conflict, temporary secret,
update/adoption, archive, and partial-failure behavior.

Lift the HQ export guards — including `LOOKUP_CARRIER_EXPORT_NOT_ACTIVE` — only
when required resources and ordering are verified end to end.

## Binding facts

- **Lookup tables.** JSON REST `lookup_table` (list GET/POST, detail
  GET/PUT/DELETE; **tag is immutable on PUT**, duplicate-tag POST → 400) plus
  `lookup_table_item` (row identity is UUID-only with no natural key; `sort_key`
  auto-increments on POST). Because rows have no content key, a JSON-REST row sync
  would force Nova to keep per-row remote-UUID bookkeeping — so the Excel bulk POST
  `/a/<domain>/fixtures/fixapi/` is the row path: API-key auth,
  `replace=true|false` (full replace vs merge), sync or async with a `download_id`
  and pollable `status_url`, hard-capped at `MAX_FIXTURE_ROWS` = 500,000 rows
  per workbook (`fixtures/upload/const.py`) — far above Nova's own 5,000-row
  table cap, so a legal Nova table never needs chunking across workbooks.
- **The fixapi workbook format is not "one sheet with field-name headers".** It is
  a mandatory `types` definition sheet (one row per table: `Delete(Y/N)`, the table
  tag, the global flag, and the field-name columns) **plus one data sheet per table
  named by its tag**, whose headers are `UID`, `Delete(Y/N)`, and `field: <name>`
  (colon syntax) per column. `UID` is left empty on insert and is what merges key
  on. A workbook missing the types sheet is rejected outright (`no_types_sheet`).
  SheetJS `xlsx` is already a dependency; no second spreadsheet writer is needed.
- **A tag rename must use an explicitly preflighted replacement/adoption workflow,
  never an in-place REST PUT**, because the detail PUT rejects an established tag
  change even though the storage model and legacy UI can rename it. Do not route
  through the legacy Manage Tables endpoint, whose tag-length check is narrower
  than HQ's 32-character model/API bound.
- **Locations.** v0.6 `LocationResource` — the file is
  `corehq/apps/locations/resources/v0_6.py`, **not** `corehq/apps/api/resources/`
  — is writable: list GET/POST/PATCH, where `patch_list` is atomic and capped at
  `patch_limit = 100` per request, upserting (an item with `location_id` updates,
  otherwise creates), plus detail GET/PUT.
  Create requires `name` and `location_type_code`; the parent is given as
  `parent_location_id` (an HQ `location_id`, hence strict parent-before-child
  ordering); `site_code` is settable and domain-unique-validated. All location
  APIs require the paid `LOCATIONS` privilege, and v0.6 exposes active locations
  but no archive or delete method.
- **Three traps in that resource, each of which silently corrupts rather than
  failing.** `_update` **regenerates** `site_code` on any request carrying a new
  `name` without one, so a push that omits the stored code repoints the
  bulk-upload key on every rename — always send it. Unknown `location_data` keys
  are **not** rejected, and the path is worth tracing because it looks like they
  are: `_update` really does call
  `LocationFieldsView.get_validator(domain)` and raise `LocationAPIError` on its
  result, but
  `custom_data_fields/models.py::CustomDataFieldsDefinition.get_validator`'s
  inner `validate_custom_fields` iterates the **declared** fields
  (`for field in fields: value = custom_fields.get(field.slug, None)`, then
  required / choices / regex) and never looks at a submitted key the definition
  does not declare. `_update` then does
  `setattr(bundle.obj, 'metadata', data.pop('location_data'))` — the **raw
  dict**, unknown keys included. `get_model_and_uncategorized` exists on that
  same class to split known from unknown, and the v0.6 resource does not call
  it.

  **So a typo'd slug does not fail the push; it succeeds wrongly.** The junk
  lands in the location's `metadata` and is invisible on the wire, because the
  fixture emits every *defined* field under `<location_data>` and an undefined
  key never appears there — nobody sees it until someone reads the database.
  Slug legality is therefore **Nova's** guarantee, the same shape unit 7 already
  holds for user-data slugs and for a sharper reason: there, construction-time
  enforcement prevents a failed push; here it prevents a silently corrupt one.

  And `_update` calls
  `corehq/apps/locations/util.py::get_location_type` on **every** create and on
  any update carrying `location_type_code`, which admits only the types
  `corehq/apps/locations/forms.py::LocationForm.get_allowed_types` returns for
  the chosen parent (`parent_type=parent.location_type`, immediate children
  alone) — so a Nova place that skips an intermediate level is refused with
  "Location type not valid for the selected parent." That refusal is a
  [deliberate target gap](00-contracts.md#deliberate-target-gaps) rather than a
  Nova bug; preflight it and leave the deployment `incomplete`.
- **The org model itself is not pushable.** `LocationTypeResource` has no
  authorization override and falls back to tastypie `ReadOnlyAuthorization`, so
  level definitions are UI-only and ship in the setup artifact while the tree
  pushes via v0.6. One consequence the artifact must account for: HQ does not
  store the address-book allowlist a person types.
  `corehq/apps/locations/views.py::LocationTypesView._get_include_only` closes
  the set over ancestors before saving — its `insert_with_parents` walks
  `parent_type_id` upward, and the docstring says so outright ("we need to
  insert any parent location types"). So the artifact lists the
  ancestor-closed set rather than Nova's authored one, or the author types a
  smaller list, HQ stores a larger one, and the two models disagree from then
  on. This costs nothing semantically — ancestors are always in the footprint
  un-expanded anyway — but a setup artifact that cannot be followed literally
  is a setup artifact nobody trusts.
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

**Observed:** an author pushes an app whose selects are backed by a Project lookup
table, and the table exists on HQ before the app that references it.
