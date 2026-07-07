# PR-10: Preview II — typed personas, owner sets, restore scope

*Self-contained implementation plan. Reference rationale: `docs/plans/2026-07-06-f2-users.md`
§3.2/§3.4, `…f3-locations.md` §3/L5. Scope rulings in
`docs/plans/2026-07-06-pr-execution-plan.md` apply — multi-location personas are IN.
Depends on: PR-04 (the persona substrate + rewrite→fold→SQL-residue evaluator), PR-09
(userTypes, orgModel, the locations table, `usercase-prop` + `LocationRef` arms).
**This PR also implements the locations tree STORE** (ownership per the index): the gated
CRUD/list server actions over PR-09's `locations` table — add/rename/move-within-level/
archive, with PR-09's integrity-rule definitions (level parentage, singleton-bucket,
site_code uniqueness + derivation) enforced as data-write rejections,
Project-membership-gated like every case read — consumed here for owner sets + the address
book, and by PR-11 (fixture emission, tree push) and PR-12 (the tree editor + SA tools).*

**Goal.** Make ownership *demonstrable* in the preview: personas become typed (backed by
`userTypes`, with location assignments), each persona gets a real usercase row, owner sets
derive from the org tree exactly the way HQ derives them, and case lists/menus/forms evaluate
against the persona's **restore scope** — a faithful, measured implementation of CommCare's
sync closure. Create a referral owned by another facility's bucket as persona A, switch to
persona B, watch it appear in B's queue — real Postgres rows, no simulation.

## Verified contracts this PR relies on

- **Owner-set formula (HQ, exact):** a user's owner ids = their `user_id` plus one id per
  case-sharing group, where each case-owning location materializes as a group whose `_id`
  IS the `location_id` (`commcare-hq/corehq/apps/users/models.py::CouchUser.get_owner_ids`
  → `get_case_sharing_groups` → `_get_case_sharing_groups_for_locations`;
  `locations/models.py::SQLLocation.case_sharing_group_object`). Case-owning = assigned
  locations whose type has `shares_cases`, PLUS descendants of assigned locations under
  `view_descendants` types (filtered to `shares_cases`, non-archived)
  (`users/models.py::_get_case_owning_locations`). Web users: location groups only.
- **Delivery proves the formula is complete:** the client's owner set is built exclusively
  from user ids + `/groups/group/@id` entries of the `user-groups` fixture
  (`commcare-core/.../SandboxUtils.java::extractEntityOwners`), and HQ folds owning
  locations into that fixture verbatim (`users/fixturegenerators.py::
  UserGroupsFixtureProvider`). No other owner source exists client-side (greps clean).
- **Restore contents = the livequery positive closure** (`casexml/apps/phone/
  data_providers/case/livequery.py::do_livequery`): seed = open cases owned by the owner
  set; an owned/live case pulls every ancestor (parent or host, even closed); a live OPEN
  host pulls its OPEN extensions, recursively in both directions; nothing survives under a
  closed host. The client purge filter is the negative dual
  (`commcare-core/.../cases/util/CasePurgeFilter.java`). The livequery module docstring's
  worked examples are the correctness contract for this PR's tests.
- **Usercase:** type `commcare-user`, identity `hq_user_id = user_id`, owner = the user's
  own id, seeded with username/first_name/last_name/email/phone/commcare_project
  (`callcenter/sync_usercase.py::_get_sync_usercase_helper/_get_user_case_fields`);
  client-side it is an ordinary case (no special-casing, verified).
- **Session keys:** `commcare_location_id` (singular) = the user's primary/selected
  location, `commcare_location_ids` (plural, space-separated) = the assignment set — both
  plain `session/user/data` keys, no dedicated session slot
  (`users/models.py::get_user_session_data`; runtime greps clean).
- **Measured feasibility (2026-07-06 spike, local dev Postgres):** the closure CTE below,
  at 240k cases / 200k index edges (Colorado-shaped: 40k clients, 120k referrals, 60k
  messages, 20k claims), computes a facility-worker persona's scope (5,900 cases) in
  **~640 ms** and the worst-case registry persona (228,000 cases) in **~3.0 s**, scaling
  linearly. No architectural risk; cache + invalidate.

## Build

### 1. Typed personas (upgrade PR-04's substrate in place)

- `PreviewPersona` gains: `userTypeUuid?` (picks a `userTypes` entry), keeping PR-04's
  ad-hoc `userData` overrides and `windowWidth`. Location assignment comes FROM the user
  type (`userTypes[].locations`, multi-assignment with exactly one `primary` — PR-09).
- **Persona identity:** a stable synthetic userid derived deterministically from
  `(app_id, userType uuid)` — same persona = same id across sessions (usercase rows and
  owner stamps depend on it). Document the derivation in code.
- **`session/user/data` resolution order** (later wins): built-ins synthesized from the
  persona → user type `values` → ad-hoc overrides. Synthesized built-ins:
  `commcare_project` (the app's project name), `commcare_first_name`/`_last_name` (from
  the persona/type name), `commcare_user_type` (`"CommCareUser"`), `user_type`
  (`"standard"`), `commcare_location_id` (primary location uuid),
  `commcare_location_ids` (space-joined assignment uuids), `commcare_primary_case_sharing_id`
  (= primary). Absent keys stay absent (absent-node ⇒ comparisons false — matches the
  runtime).

### 2. Per-persona usercase rows

- Selecting a persona idempotently materializes a `commcare-user` case row in the case
  store, keyed `(app_id, project_id, persona userid)`: `case_type='commcare-user'`,
  `owner_id` = the persona userid, `case_name` = username, properties seeded per the
  verified sync list (username, first_name, last_name, commcare_project; email/phone
  empty), `hq_user_id` = the persona userid.
- `usercase-prop` Terms and `#user/<prop>` refs compile (Postgres path) against that row;
  usercase writes (`case_property_on: 'commcare-user'` fields, PR-11's derivation) update
  it through the normal submission transaction. Type-changes/close of the row are
  unreachable (PR-01/PR-09's reserved rules).

### 3. Owner-set derivation (Nova mirror of the HQ formula)

Over Nova's `locations` table + `orgModel` levels:

```
ownerSet(persona) =
  { persona.userid }
  ∪ { loc.uuid | loc ∈ assigned, role(level(loc)) ∈ {territory, bucket, registry} }
  ∪ { d.uuid   | a ∈ assigned, level(a).seesDescendantCaseloads,
                 d ∈ descendants(a), role(level(d)) owns cases, ¬d.archived }
```

Identity note: preview owner ids are Nova location **uuids** (there is no HQ `location_id`
locally); owner-expression residues (PR-04's evaluator + the `LocationRef` arms) resolve to
the same uuids, so written `owner_id` values and owner sets share one identity axis. The
wire is unaffected — emission compiles owner expressions to runtime fixture lookups
(PR-11), never baked ids.

### 4. The restore-scope query

One recursive CTE, verbatim from the measured spike (adapted to bound parameters):

```sql
WITH RECURSIVE live(case_id, is_open) AS (
  SELECT c.case_id, true
  FROM cases c
  WHERE c.app_id = $app AND c.project_id = $proj AND c.closed_on IS NULL
    AND c.owner_id = ANY($ownerSet)
  UNION
  SELECT e.next_id, e.next_open
  FROM live l
  JOIN LATERAL (
    -- up: a live case pulls every ancestor (parent or host), open or closed
    SELECT c2.case_id AS next_id, (c2.closed_on IS NULL) AS next_open
    FROM case_indices i JOIN cases c2 ON c2.case_id = i.ancestor_id
    WHERE i.case_id = l.case_id
    UNION ALL
    -- down: a live OPEN host pulls its OPEN extensions (extension edges only)
    SELECT c2.case_id, true
    FROM case_indices i JOIN cases c2 ON c2.case_id = i.case_id
    WHERE i.ancestor_id = l.case_id AND i.relationship = 'extension'
      AND c2.closed_on IS NULL AND l.is_open
  ) e ON true
)
SELECT case_id FROM live;
```

The three rules it encodes (and nothing else): seed on open+owned; unconditional up-pull;
down-pull only `extension` edges from an open live host to an open extension. Closed-host
death, child→parent-keeps-closed-parent, and extension⇆host chains all emerge from those —
verified against livequery's own worked examples, which become the test suite (encode each
docstring example as a fixture graph and assert the scope set exactly; add the purge-filter
asymmetry case: closed parent with owned open child stays; closed host's extension dies).

- **Caching:** compute per persona on first use; hold as a session-scoped set (the
  measured 640 ms worker / 3.0 s worst-case make recompute-on-invalidate acceptable);
  invalidate on any case write in `(app_id, project_id)` — hook the existing case-store
  write path (the same seam PR-04 uses for count-query freshness).
- **Application:** `readCases` / `readCaseListPreview` and the menu/display-condition
  residues gain a scope filter (`case_id ∈ scope`) when a persona is active. **Case search
  stays global** (search crosses ownership by design — ACA §2.4). No persona selected ⇒
  author-omniscient mode: today's unscoped behavior, explicitly labeled (PR-12 renders the
  label; this PR exposes the mode on the query interface).

### 5. Location address-book queries

`LocationRef` residues resolve against the `locations` table: `location` → the row;
`user-location` → the persona's primary; `level-of` ancestor hop → walk `parent_uuid` to
the level; descendant hop → the singleton child at the level (PR-09's singleton-bucket
rule makes it deterministic); `location-field` → `values` JSONB. When a persona is active,
expression evaluation scopes the address book to the persona's footprint per the levels'
`addressBook` settings (`everyone` levels always visible; otherwise assigned + ancestors +
descendants — the verified HQ default scope); authoring-time pickers (PR-12) always see the
full tree.

## Tests / acceptance

- Livequery docstring examples, verbatim, as scope fixtures (the correctness contract).
- Owner-set matrix: role × assignment × seesDescendantCaseloads × archived.
- Persona determinism (same type ⇒ same userid ⇒ same usercase row; idempotent re-select).
- Scope filtering on case lists + display-condition residues; search unaffected; omniscient
  mode unaffected.
- Invalidation: a submission that creates an extension of an in-scope case grows the scope
  on next read.
- A seeded-graph performance smoke documented in the test (generous bound, e.g. scope of
  ~5k under 3 s locally — not a tight CI gate).
- `lint/typecheck/test` clean.

## Non-goals

Persona picker/indicator UI and the "N cases in restore" affordances (PR-12); usercase and
locations wire emission (PR-11); provisioning; restore-size *advice* (docs, PR-12);
footprint-scoped WIRE fixtures (that is HQ's restore behavior — Nova only mirrors scoping
in preview evaluation).

## Open choices (implementer)

- Scope-cache home: recommend session-scoped in-memory keyed `(app, persona)` with a
  monotonic invalidation stamp from the case-store write path; a Postgres scope table only
  if cross-session reuse proves necessary.
- Whether the scope query LIMITs + warns above a ceiling (recommend: no limit; surface
  scope size to PR-12's indicator).
- The persona-userid derivation function (uuid5-style over app+type uuid; document it).
