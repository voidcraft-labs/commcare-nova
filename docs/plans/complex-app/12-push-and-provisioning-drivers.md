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

**Observed:** an author pushes an app whose selects are backed by a Project lookup
table, and the table exists on HQ before the app that references it.
