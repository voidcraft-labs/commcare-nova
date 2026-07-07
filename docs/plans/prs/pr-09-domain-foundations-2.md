# PR-09: Domain foundations II (users, org model, automations)

*Self-contained implementation plan. Reference rationale: `docs/plans/2026-07-06-f2-users.md`,
`…f3-locations.md`, `…f6-domain-automations.md` §2–3. Scope rulings apply — notably: custom
location fields and multi-location personas are IN.*

**Goal.** Wave 2's blueprint vocabulary in one pass, with the collection pattern warm from
PR-01: user-data schema + user types, the org model (levels, roles, custom fields) with the
location tree's storage contract, automations (sweeps + alerts) under a rule-representability
context, and the new expression arms (`usercase-prop`, the `LocationRef` family). The arms
land in EVERY exhaustive-switch consumer (the compiler forces the emitter/preview switch
files to gain arms, exactly as PR-01's did) — but **no doc state carrying them can reach
emission or preview until PR-10/PR-11 activate them**: two temporary gating findings
(§1/§2) keep usercase-writing and location-referencing docs uncommittable, lifted by PR-11
in the same PR that makes their wire real (the PR-01→PR-03 `TABLE_EMISSION_NOT_ACTIVE`
pattern; the total-emitter invariant holds at every merge on the auto-deployed main).
No preview behavior (PR-10), no emission/push/artifact (PR-11), no UI (PR-12).

## Verified contracts this PR relies on

- Custom user data: one `UserFields` definition per domain, shared web+mobile; slug rule =
  Django slug charset + ≥1 non-digit + NOT in `SYSTEM_FIELDS`
  (`name,type,owner_id,external_id,hq_user_id,user_type,commtrack-supply-point`) + no
  `commcare`/`xml` prefix (`custom_data_fields/edit_model.py::XmlSlugField`,
  `models.py::validate_reserved_words`). Injected built-ins (auto-win over authored
  collisions): `commcare_project`, `commcare_first_name/_last_name/_phone_number`,
  `commcare_user_type`, `commcare_profile`, `commcare_location_id`/`_ids`/
  `commcare_primary_case_sharing_id`, `user_type` (`'demo'` for practice users)
  (`users/models.py::get_user_session_data`).
- Usercase: type `commcare-user`, identity `hq_user_id = user_id`, owner = the user, seeded
  fields incl. username/first_name/last_name/email/phone/language/commcare_project
  (`callcenter/sync_usercase.py::_get_user_case_fields`); update-only (authoring rule);
  wire = FormActions `usercase_update`/`usercase_preload` (slots exist inert in
  `lib/commcare/types.ts`) + the computed `usercase_id` datum + count-equals-1 assertion
  (`entries.py::get_extra_case_id_datums/add_usercase_id_assertion`) — PR-11 emits.
- Org levels: `LocationType.code` is a slug auto-derived from name; `shares_cases`/
  `view_descendants`/`has_users` are the live ownership flags (`has_users` editability is
  USH-toggle-gated on HQ; `administrative` is commtrack-forced — not a usable knob); the
  expand/include family is fixture scope. Levels are NOT API-writable
  (`LocationTypeResource` read-only) — PR-11's setup artifact carries them.
- Locations: `location_id` server-generated globally-unique; `site_code` domain-unique,
  the bulk/push identity; custom field VALUES = `SQLLocation.metadata` JSON; custom field
  DEFINITIONS = the same custom-data machinery (`field_type='LocationFields'`), not
  API-pushable. Flat fixture: `@type`, `@id`, one `{level_code}_id` lineage attribute per
  level (self + ancestors); custom fields as `<location_data>` CHILD ELEMENTS (never
  attributes); index schema over the lineage attrs + `@id`/`@type`/`name`
  (`locations/fixtures.py::FlatLocationSerializer`, `_get_metadata_node`).
- Owner sets: user id + each case-owning location's `location_id` (assigned with
  `shares_cases`, + descendants under `view_descendants`), delivered to clients via the
  `user-groups` fixture (`users/models.py::get_case_sharing_groups`,
  `SQLLocation.case_sharing_group_object`); `owner_id` on the wire is an unvalidated
  string ≤255; `'-'` = unowned-extension sentinel (alive).
- Automations: rules & alerts are ONE HQ model (`AutomaticUpdateRule`, workflow arm).
  Criteria = the nine `MatchPropertyDefinition` match types (EQUAL/NOT_EQUAL/HAS_VALUE/
  HAS_NO_VALUE/REGEX/4 date-offsets) + closed-parent + location + ALL/ANY +
  `filter_on_server_modified`+`server_modified_boundary`; actions = set property
  (literal | other property, incl. parent/host-prefixed) and/or close. Alerts add
  schedules (AlertSchedule one-shot / TimedSchedule recurring), the verified recipient
  enum (+ four settings-registered parent-location customs), SMS/email content with
  `{case.<prop>}` templating, and a user-data/usercase recipient filter. Cap: 10,000 per
  (domain, case_type, partition) run, halt+notify. No API (re-verified; UI-only) —
  PR-11's artifact carries them.

## Build

### 1. Users (`lib/domain` + `lib/doc`)

- `blueprintDocSchema.userDataFields: Array<{name, label, data_type?, options?, required?}>
  .nullable()` — name under the verified slug rule (unconstructible otherwise) + not
  colliding with the built-ins catalog.
- `blueprintDocSchema.userTypes: Array<{uuid, name, description?, values: Record<string,
  string>, locations?: Array<{ locationUuid, primary?: boolean }>}>.nullable()` —
  multi-location IS in scope (owner ruling): `locations` lists assignments with exactly one
  `primary` (validator); PR-10 derives owner sets over the full set.
- Built-ins catalog (static module, not stored): the injected keys above, typed; exposed to
  pickers/autocomplete; reserved against authoring.
- `session-user` vocabulary check: field ∈ `userDataFields ∪ builtins` — introduce-gated
  soundness (legacy open-namespace refs keep validating) + repair judgment.
- Usercase: `commcare-user` enters the case-type catalog as a non-removable built-in entry
  (seeded builtin properties per the sync list; app-extendable). `case_property_on:
  'commcare-user'` becomes schema-legal on fields, **but stays commit-gated until PR-11**:
  a temporary gating finding (`USERCASE_EMISSION_NOT_ACTIVE`, soundness + repair judgment)
  rejects any batch introducing a usercase-writing field, lifted by PR-11 in the same PR
  that lands the usercase derivation. This gate is load-bearing, not hygiene: TODAY's
  cross-type pipeline (`lib/commcare/deriveCaseConfig.ts`) buckets every
  `case_property_on !== moduleCaseType` field into a derived child-case **CREATE**
  (`OpenSubCaseAction`), so an ungated usercase field would export a wire that CREATES a
  `commcare-user` case — the exact state this PR declares unconstructible — during the
  auto-deployed PR-09→PR-11 window. PR-11 additionally excludes `commcare-user` from the
  child-case bucketing when it lands the real `usercase_update`/`usercase_preload`
  derivation. `#user/<prop>` XPath refs validate against the entry; new `usercase-prop`
  Term (full switch-site sweep — the compiler forces the emitter/preview arms, which stay
  unreachable behind the gate; on-device: the verified casedb lookup; Postgres: the persona
  usercase row — PR-10 wires the actual row). Create/close of the type: unconstructible
  (extends PR-01's reserved list message).

### 2. Org model (`lib/domain` + `lib/doc` + `lib/case-store` types only)

- `blueprintDocSchema.orgModel: { levels: Array<{uuid, name, code, role:
  "territory"|"bucket"|"registry"|"area", seesDescendantCaseloads?, addressBook?:
  "everyone"|"footprint", fields?: Array<{name, label}>}> }.nullable()` — `fields` = custom
  location data fields per level (scope-in): name under the same slug rule; serialized as
  `<location_data>` children (PR-11); readable in `LocationRef`-adjacent expressions via a
  `location-field` accessor on the `level-of`/`location` results (see arm below).
- Level mutations (keyed, collection pattern), one-tier parent graph (levels are an ordered
  root→leaf chain in v1; validator).
- The `locations` tree TABLE CONTRACT (PR-09 lands the schema/types/migration + the
  integrity-rule DEFINITIONS below; **PR-10 implements the store** — gated CRUD/list server
  actions with these rules enforced as data-write rejections — and PR-11/PR-12 consume
  PR-10's store, never this PR's stubs): columns
  `(app_id, project_id, uuid, level_uuid, parent_uuid, name, site_code, values jsonb,
  archived)`; site_code slug-derived + unique per app; singleton-bucket rule where a level
  is a reverse-hop target. This PR lands the Kysely types + migration + store API stubs so
  the domain tests can exercise integrity rules; PR-10 wires preview usage.
- `LocationRef` expression family (ValueExpression arms, full sweep — the compiler forces
  the on-device/Postgres/instance-accumulation arms here; PR-11 owns the orchestration and
  **lifts the activation gate**): `{kind:"location", locationUuid}`,
  `{kind:"user-location"}` (persona's primary), `{kind:"level-of", base, levelUuid}`
  (ancestor hop → lineage attribute; descendant hop → reverse lineage filter, requires
  singleton-bucket), plus a column accessor `{kind:"location-field", of: LocationRef,
  field}` reading a custom level field (`location_data/<name>` on-device; JSONB on
  Postgres). A second temporary gating finding (`LOCATION_EMISSION_NOT_ACTIVE`, soundness +
  repair judgment) keeps any doc carrying these arms uncommittable until PR-11 emits the
  locations fixture they resolve against — same rationale as the usercase gate: op emission
  (PR-03) is live, and an ungated owner expression would put `instance('locations')/…` on
  the wire with no fixture behind it.
  **Checker semantics per arm (static where static truth exists):** `{kind:"location"}`
  resolves role via a **locations snapshot** in the validation context —
  `LocationSnapshot = { uuid, name, levelUuid, archived }`, the exact plumbing pattern of
  PR-01/PR-02's table-registry snapshot (hydrated at the same load boundaries; live source
  is PR-10's store — until PR-10 lands the snapshot is empty, which is consistent: no tree
  rows exist to reference). A locationUuid absent from the snapshot →
  `LOCATION_REFERENCE_UNKNOWN` (introduce-gated soundness + repair judgment). Role check =
  snapshot `levelUuid` → the in-doc level's role (must be case-owning:
  territory/bucket/registry). `{kind:"level-of"}`'s role check is fully static (the target
  level is in-doc). `{kind:"user-location"}` has NO statically knowable level — it is
  admitted in owner position without a static role proof, and the docs + persona inspector
  own that residual (documented, not silently passed). PR-01's `acting-user` / `unowned`
  arms (those exact kinds) complete the owner vocabulary.

### 3. Automations (`lib/domain` + `lib/doc`)

- `blueprintDocSchema.automations: Array<{uuid, name, description?, caseType,
  when: Predicate, minimumQuietDays?, action: SweepAction | AlertAction}>.nullable()` with
  the shapes from the F6 plan §2 (recipients enum incl. the four named custom
  parent-location recipients; content sms/email; recipientFilter over
  userDataFields/usercase).
- `ruleRepresentableContext`: the checker context admitting exactly the nine match shapes +
  all/any at one level; anything else rejected with an Elm-like message naming what HQ's
  rule engine can't express.
- Template-property validation for `{case.<prop>}` content against the catalog (+
  owner/parent/host prefixes per relationships).
- Reference edges + rename cascades over every automation slot.

### 4. Validator codes

Users: `USER_DATA_FIELD_UNKNOWN` (introduce-gated), slug/reserved-name rules (shape),
usercase property checks, `USERCASE_EMISSION_NOT_ACTIVE` (temporary, lifted by PR-11),
userType value/type coherence, multi-location primary rule.
Org: level code rules, tree integrity (level parentage, singleton-bucket, site_code
uniqueness — surfaced as data-write rejections, not doc findings, where they guard the
tree table), `LOCATION_REFERENCE_UNKNOWN` (introduce-gated, vs the locations snapshot),
`LOCATION_EMISSION_NOT_ACTIVE` (temporary, lifted by PR-11), owner-expression role
guarantee (per-arm semantics in §2). Automations: representability, catalog/type,
template, filter vocabulary, schedule coherence. All with class rows + repair judgments.

## Tests / acceptance

Slug matrices (user + location fields vs the verified HQ rules); usercase catalog-entry
immutability; LocationRef checker matrix (both hop directions, role guarantee,
location-field types); representability matrix; multi-location primary; reference-index
fuzz parity; gate rejections; `lint/typecheck/test` clean.

## Non-goals

Preview personas/owner sets/restore scope (PR-10); usercase/locations emission, pushes,
setup artifact (PR-11); UI + SA (PR-12); provisioning UX (PR-11 owns the push, PR-12 the
surface).

## Open choices (implementer)

- Whether `userTypes.values` accepts built-in tokens or literals only (recommend literals).
- Level `fields` place: per-level (as specced) vs one app-wide location-field set —
  per-level matches HQ's single definition poorly; if implementation friction appears,
  collapse to one `orgModel.fields` list applied to all levels and note it (HQ's definition
  is domain-wide anyway).
- Archived-location semantics default (recommend: excluded from fixture + owner sets).
