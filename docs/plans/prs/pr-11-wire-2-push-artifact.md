# PR-11: Wire II, HQ push framework, setup artifact

*Self-contained implementation plan. Reference rationale: `docs/plans/2026-07-06-f2-users.md`
§3.3, `…f3-locations.md` §4, `…f5-lookup-tables.md` §3.4 (push half), `…f6-domain-automations.md`
§3.2–3.3. Scope rulings in `docs/plans/2026-07-06-pr-execution-plan.md` apply. Depends on:
PR-09 (usercase catalog entry, orgModel, automations); **PR-10 (the implemented locations
store this PR reads for fixture emission and the tree push)**; PR-02 (table registry —
push identity); PR-03 (emitters + instance-accumulation seams).*

**Goal.** Everything that leaves Nova for HQ in wave 2, built once: usercase wire emission,
the locations address-book fixture on both delivery paths, the remaining expression
lowerings, **one HQ push framework** with three drivers (lookup tables, locations, users),
and **one consolidated setup artifact** covering everything HQ has no write API for. After
this PR, "upload to HQ" delivers: the app, its media, its tables, its location tree, its
users — plus a precise setup document for the rest.

## Verified contracts this PR relies on

- **Usercase wire** (all shapes verified at source): FormActions `usercase_update`/
  `usercase_preload` exist inert in `lib/commcare/types.ts`; HQ renders them via
  `commcare-hq/corehq/apps/app_manager/xform.py::XForm._add_usercase` — case block at
  `/data/commcare_usercase/case`, `case/@case_id` bound to
  `instance('commcaresession')/session/data/usercase_id` (`SESSION_USERCASE_ID`), preloads
  via `add_case_preloads(..., case_id_xpath=SESSION_USERCASE_ID)`. The suite gains a
  computed datum — `SessionDatum(id='usercase_id',
  function="instance('casedb')/casedb/case[@case_type='commcare-user'][hq_user_id=instance('commcaresession')/session/context/userid]/@case_id",
  requires_selection=False)` — emitted only when the form's actions use the usercase, plus
  the count-equals-1 assertion with locale `case_autoload.usercase.case_missing`
  (`suite_xml/sections/entries.py::get_extra_case_id_datums` / `::add_usercase_id_assertion`).
  Usercase runs on HQ only with the paid `USERCASE` privilege — an export note, never a gate.
- **Locations flat fixture** (byte contract): `<fixture id="locations" …>` wrapping
  `<locations>` of flat `<location>` elements with attributes `type` (level code), `id`,
  and one `{level_code}_id` **lineage attribute per level** (self + each ancestor's id, `''`
  otherwise); built-in child elements `name, site_code, external_id, latitude, longitude,
  location_type, supply_point_id` (string-coerced, empty when unset); custom fields as
  grandchildren under ONE `<location_data>` child (every defined field, empty text when
  unset); index schema node over `@{code}_id` per level + `@id`/`@type`/`name`
  (`commcare-hq/corehq/apps/locations/fixtures.py::FlatLocationSerializer._get_fixture_node` /
  `::_fill_in_location_element` / `::_get_metadata_node`; `fixtures/utils.py::
  get_index_schema_node`; live shape in `locations/tests/data/related_location_flat_fixture.xml`).
  The hierarchical fixture is deprecated — never emit it.
- **Client fixture routing:** indexed storage keys off the restore's `indexed="true"` +
  a `<schema>` block parsed by the RESTORE transaction factory
  (`commcare-core/.../CommCareTransactionParserFactory.java::getParser`,
  `FixtureIndexSchemaParser`); non-indexed fixtures load as in-memory trees. Suite-embedded
  fixtures go through `SuiteParser` case `"fixture"` → `FixtureXmlParser` into app-fixture
  storage (global when no `user_id` attribute) — `SuiteParser` handles `<fixture>` only.
- **Lookup-table push APIs** (methods verified at source, independently anchored):
  JSON REST `lookup_table` (list GET/POST, detail GET/PUT/DELETE; `tag` immutable on PUT,
  duplicate-tag POST → 400) + `lookup_table_item` (list GET/POST, detail GET/PUT/DELETE; row
  identity UUID-only, `sort_key` auto-increments on POST) — `commcare-hq/corehq/apps/
  fixtures/resources/v0_1.py` (+ `v0_6.py`); Excel bulk `POST /a/<domain>/fixtures/fixapi/`
  (`fixtures/views.py::upload_fixture_api`) — API-key auth, `replace=true|false`
  (full-replace vs merge), sync or **async with `download_id` + pollable `status_url`**;
  hard cap `MAX_FIXTURE_ROWS = 500_000` per workbook.
- **Locations push API:** v0.6 `LocationResource` — list GET/POST/**PATCH** (`patch_list`
  atomic, ≤ `patch_limit=100` per request, upsert: item with `location_id` updates, else
  creates), detail GET/PUT; create requires `name` + `location_type_code`; parent by
  `parent_location_id` (an HQ location_id — hence parent-before-child ordering);
  `site_code` settable, domain-unique-validated, auto-derived when omitted;
  `location_data` validated against the domain's LocationFields definition — unknown keys
  → `LocationAPIError` (`locations/resources/v0_6.py::LocationResource`). **Level
  definitions are NOT API-writable** (`LocationTypeResource` effectively read-only —
  tastypie `ReadOnlyAuthorization` default) and the location-fields definition is UI-only:
  both live in the setup artifact. All location APIs need the paid `LOCATIONS` privilege
  (`resources/v0_5.py::BaseLocationsResource.dispatch`).
- **Users push API:** `CommCareUserResource` — list GET/POST (username create-only,
  normalized via `generate_mobile_username`, immutable after; password required at create
  unless the domain has `TWO_STAGE_MOBILE_WORKER_ACCOUNT_CREATION`), detail GET/PUT
  (`user_data` through the system-key-guarded `UserData.update`), DELETE = soft retire;
  `primary_location` + `locations` must be provided together, primary ∈ list, every id
  verified against active locations (`api/user_updates.py::_update_location`).
  `InvitationResource` POST invites web users (email, role, user_data, locations).
  Identity: server-assigned `user_id` (the durable key usercase/session key on);
  `username` unique + stable (`api/resources/v0_5.py`, `v1_0.py`).
- **Automations have NO API** (re-verified, greps clean) — HQ-UI-only; plan-tier gates:
  sweeps `DATA_CLEANUP` (Pro+), alerts `REMINDERS_FRAMEWORK` (Standard+), SMS delivery
  `OUTBOUND_SMS` at send; cap 10,000 updates per (domain, case_type, partition) run,
  halt + notify on hit (`settings.py::MAX_RULE_UPDATES_IN_ONE_RUN`;
  `data_interfaces/utils.py::iter_cases_and_run_rules`).
- **Existing push machinery to reuse:** `lib/commcare/client.ts` — `authHeader` (ApiKey),
  `fetchCsrfToken` (login-GET token for endpoints missing `@csrf_exempt`), the 16KB WAF
  padding trick, hardcoded base URL (anti-SSRF), `discoverAccessibleDomains`'s
  bounded-concurrency pattern; the upload route's phase ordering + degrade-to-warning
  contract (`app/api/commcare/upload/route.ts`: boundary gate → importApp → media bundle).

## Build

### 1. Usercase emission

- `deriveCaseConfig` gains the usercase bucket: fields with
  `case_property_on: 'commcare-user'` → `buildFormActions` populates `usercase_update`
  (and `usercase_preload` mirroring the module-case preload derivation for case-loading
  reads — see open choices); the three inert slots stop being constants.
- `xform/caseBlocks.ts` gains the usercase branch mirroring `_add_usercase` exactly
  (block path, `@case_id` bind, per-property update binds with the count-guard rule,
  preload setvalues). The HQ-upload path needs only the FormActions (HQ regenerates —
  the lockstep contract); the local `.ccz` renders the block itself.
- `session.ts` emits the computed `usercase_id` datum + assertion for usercase-using
  forms (an `actionsUseUsercase` mirror decides). Pin Nova fixtures against the HQ
  emission shapes quoted above.

### 2. Locations fixture + remaining lowerings

- A `FlatLocationsFixtureEmitter` producing the verified byte shape from Nova's
  `locations` table + `orgModel` levels — lineage attributes computed by walking
  `parent_uuid`; `<location_data>` children from the levels' custom fields; ordered by
  `site_code`. **Local `.ccz`**: suite-embedded, full tree, global (no `user_id`
  attribute), **non-indexed** (no `indexed` attr, no schema node — `SuiteParser` has no
  `<schema>` handling; the in-memory tree is correct at Nova scale; re-verify that
  reading of `SuiteParser` at implementation). **HQ path**: no emission — HQ's own
  serializer delivers footprint-scoped fixtures after the tree push. Body parity between
  the two is the test (same element shape modulo the fixture attributes + scoping).
- Instance seams: `locations` → `jr://fixture/locations` in `instanceSourceFor`;
  `addTermInstance` arms for `LocationRef`/`location-field` (→ `locations` +
  `commcaresession` where user-location is involved); `#user`/`usercase-prop` → `casedb`
  + `commcaresession`.
- Lowerings (on-device): `#user/<prop>` + `usercase-prop` → the verified UsercaseXPath
  shape; `LocationRef` per the F3 plan §2 table — `location` →
  `instance('locations')/locations/location[site_code='<code>']/@id`; `user-location` →
  `instance('commcaresession')/session/user/data/commcare_location_id`; ancestor
  `level-of` → `…location[@id = <base>]/@{code}_id`; descendant `level-of` →
  `…location[@type='<code>'][@{base_code}_id = <base>]/@id`; `location-field` →
  `…/location_data/<name>`.

### 3. The push framework (built once)

A small `HqPushPhase` abstraction on the upload route: ordered phases after `importApp`
(app → media → **tables → locations → users**), each returning ok/warning with a
person-readable message (the media contract — a failed phase never fails the upload; it
reports precisely what to do). Shared client helpers (auth, CSRF, WAF padding, bounded
concurrency, async-poll) extracted from `importApp`'s machinery, then three drivers:

- **Tables** (identity = `tag`): resolve existing by listing + tag match; structure via
  JSON REST (POST new / PUT by UUID — tag immutable; a Nova tag rename = delete old +
  create new, surfaced in the phase report); rows via the **Excel `fixapi` bulk path,
  `replace=true`, async + status polling** (content-keyed, stateless — no row-UUID
  bookkeeping). Generate the workbook in the documented upload format (one sheet per
  table; header row = field names). xlsx generation: check the repo's existing deps
  before adding one (open choice).
- **Locations** (identity = `site_code`): fetch existing (list, paged) → diff → upsert
  via `patch_list` in parent-before-child batches of ≤100 (atomic per batch); level codes
  must already exist on the domain (the setup artifact's org section is a prerequisite —
  the phase checks `location_type_code` resolution and degrades with "apply the setup
  document's Organization Levels section first" when missing); `location_data` included
  only for fields the domain defines (probe once; else warn with the artifact pointer).
- **Users** (identity = mapped `user_id`) — **client functions + identity mapping ONLY;
  users are NOT an automatic upload phase.** Worker provisioning is interactive: PR-12's
  surface invokes these functions on demand, one worker at a time or from a picked set
  (there is no stored "provisioning list" anywhere). Functions: create a mobile worker from
  a Nova user type (username, password or two-stage, `user_data` from the type's values,
  `primary_location` + `locations` mapped via the pushed tree's site_code→location_id
  resolution); update existing by mapped id; persist the `(app, domain) → username →
  user_id` mapping (Firestore, beside the app doc). Web users via `InvitationResource`
  (minimal: email + role + user_data + locations).

### 4. The setup artifact (built once, consolidated)

One generated markdown document per export/upload — "HQ setup for <app>" — rendered from
the blueprint (never hand-edited; regenerated every time), behind a `SetupPort` interface
whose only driver today is the renderer (an API client slots in per section if/when HQ
grows one). Sections:

- **User data schema** (no API): Users → User Fields; the field list (slug, label,
  choices, required) from `userDataFields`; note that regex enforcement is paid
  (`REGEX_FIELD_VALIDATION`).
- **Organization levels** (no API): Users → Organization Structure → Organization Levels;
  the role→flag synthesis table — territory = Owns Cases ✓ / Has Users ✓; bucket =
  Owns Cases ✓ / Has Users ✗; registry = same flags as bucket (reached by search — note);
  area = Owns Cases ✗; `seesDescendantCaseloads` → View Child Data;
  `addressBook: "everyone"` → Include Without Expanding = that level. Prerequisites
  stated loudly: the paid `LOCATIONS` privilege; the
  `ush_restore_file_location_case_sync_restriction` toggle for editing Has Users
  (bucket/registry levels). Location custom fields → the Location Fields page (same
  no-API machinery as user fields).
- **Automations** (no API): per sweep — Data → Automatically Update Cases; case type,
  criteria (from the representable predicate, spelled as the nine HQ match rows),
  `filter_on_server_modified`/`server_modified_boundary` from `minimumQuietDays`, action
  (close and/or property updates). Per alert — Messaging → Conditional Alerts; schedule,
  recipients (naming the four custom parent-location recipients explicitly, with the
  "settings-registered — standard on Dimagi-hosted HQ, may be absent on self-hosted"
  note), content, user-data filter. Plan-tier notes: sweeps Pro+ (`DATA_CLEANUP`), alerts
  Standard+ (`REMINDERS_FRAMEWORK`), SMS needs `OUTBOUND_SMS`. Operational notes: rules
  run once daily at the domain's configured hour; the 10k per (domain, case-type,
  partition) run cap **halts with a notification** and re-sweeps next day.
- Surfacing: a builder **Deployment panel** (renders the current artifact; download
  button) + the artifact included in the upload flow's response summary. PR-12 owns the
  panel's visual design; this PR ships the renderer + a minimal panel mount + download.

## Tests / acceptance

- Usercase: fixture-pinned block/datum/assertion emission; FormActions population matrix
  (writer fields, preload cases); `.ccz` XForm oracle + suite oracle green.
- Locations fixture: body-parity test between Nova's embedded emission and the
  HQ-serializer shape (element-by-element over a fixture tree, lineage attributes
  included); lowering tests for every `LocationRef` arm against expected XPath strings.
- Push drivers: mocked-HQ integration tests per driver (create/update/rename table;
  tree upsert ordering + batch atomicity + missing-level degrade; user create/update +
  location mapping + two-stage branch); phase-report messages person-readable
  (Elm-style); a full-upload test asserting phase ordering and that any phase's failure
  degrades without failing the upload.
- Artifact: snapshot tests per section from a seeded blueprint; regeneration determinism.
- `lint/typecheck/test` clean; `scripts/test-schema.ts` untouched (no SA schema changes
  in this PR).

## Non-goals

Preview behavior (PR-10); the Deployment panel's full UX + provisioning UI (PR-12); SA
tools/guidance (PR-12); any rules/alerts API client (the port exists; no driver until HQ
grows an API); footprint-scoped fixture emission (HQ-side behavior).

## Open choices (implementer)

- Usercase preload scope: mirror HQ (`add_case_preloads` usercase path) for fields whose
  defaults read `#user/<prop>` on case-loading forms, or writes-only in v1 — read the HQ
  path first; recommend mirroring (it is one derivation branch).
- xlsx generation: a minimal in-repo writer vs a small dependency — inventory existing
  deps first; the workbook is simple (strings, one sheet per table).
- Push-phase ordering nuance: users depend on locations (assignment mapping); tables are
  independent — parallelize tables with locations if the throttle budget allows, else
  keep strictly serial (recommend serial first; measure).
- Where the `(app, domain)` user-id mapping lives in Firestore (beside `apps/{appId}` —
  follow the mediaAssets pattern).
