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
- **Restore contents = the livequery closure — an AVAILABILITY-grounded fixpoint**
  (`casexml/apps/phone/data_providers/case/livequery.py::get_live_case_ids_and_indices`,
  re-derived line-by-line 2026-07-07 after the review caught the earlier three-rule
  summary being wrong in both directions). The exact rules:
  1. **available** = open AND "not an extension case" (no extension index, OR any child
     index — `is_extension`), ∪ open extensions of available cases (chain grounding —
     `has_live_extension`'s recursion).
  2. **live seed** = owned ∩ available (an owned open EXTENSION is NOT seeded; it becomes
     live only through an available host chain — `enliven` post-loop guards
     `not is_extension`).
  3. **closure**: a live case pulls EVERY direct parent/host (open or closed — `enliven`
     chains `hosts_by_extension` + `parents_by_child` unconditionally); a live case — open
     **or closed** — pulls its OPEN extensions (`classify`'s
     `if ref_id in live_ids: enliven(sub_id)` has no host-openness check). "Nothing
     survives under a closed host" is NOT a rule — closed-host death emerges only from
     rule 2's seed grounding.
  **Correctness contract = HQ's machine-readable corpus**, not the module docstring:
  `casexml/apps/phone/tests/data/case_relationship_tests.json` (45 graphs with
  owned/subcases/extensions/closed/outcome, exercised by `test_extension_indexes.py`).
  The docstring's final example (`a(closed) <--ext-- b <--chi-- c(owned) >> []`) is
  **stale** — the implementation and the corpus fixture `open_child_of_closed_extension`
  both yield `{a,b,c}`. The SQL below was validated **44/44** against every non-skipped
  corpus fixture on 2026-07-07 (the one skip is HQ's own, unrelated to scope semantics).
  The client purge filter is the negative dual
  (`commcare-core/.../cases/util/CasePurgeFilter.java`).
- **Usercase:** type `commcare-user`, identity `hq_user_id = user_id`, owner = the user's
  own id, seeded with username/first_name/last_name/email/phone/commcare_project
  (`callcenter/sync_usercase.py::_get_sync_usercase_helper/_get_user_case_fields`);
  client-side it is an ordinary case (no special-casing, verified).
- **Session keys:** `commcare_location_id` (singular) = the user's primary/selected
  location, `commcare_location_ids` (plural, space-separated) = the assignment set — both
  plain `session/user/data` keys, no dedicated session slot
  (`users/models.py::get_user_session_data`; runtime greps clean).
- **Measured feasibility (re-measured 2026-07-07 on the CORRECTED query, local Postgres):**
  at 240k cases / 200k index edges (Colorado-shaped: 40k clients, 120k referrals, 60k
  messages, 20k claims), the corrected two-phase closure computes a facility-worker
  persona's scope (5,900 cases) in **~610–675 ms** and the worst-case registry persona
  (228,000 cases) in **~1.2 s** — the availability pre-pass makes the worst case FASTER
  than the earlier (semantically wrong) single-phase query's 3.0 s. No architectural risk;
  cache + invalidate.

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
  the persona/type name), `commcare_user_type` (`"commcare"` — the mobile-worker value
  `users/models.py::_get_user_type` actually emits via `COMMCARE_USER`; "CommCareUser" is
  the Couch doc_type, never a session value), `user_type` (`"standard"`),
  `commcare_location_id` (primary location uuid),
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

The two-phase closure, verbatim as validated (44/44 corpus fixtures, 2026-07-07) and
re-measured; `depth = 1` pinned on every `case_indices` hop (the repo's
materialization-agnostic convention, `lib/case-store/sql/compileRelationPath.ts`):

```sql
WITH RECURSIVE
available(case_id) AS (
  -- grounded roots: open AND "not an extension case" (no ext index OR any child index)
  SELECT c.case_id FROM cases c
  WHERE c.app_id = $app AND c.project_id = $proj AND c.closed_on IS NULL
    AND (NOT EXISTS (SELECT 1 FROM case_indices i
                     WHERE i.case_id = c.case_id AND i.relationship = 'extension' AND i.depth = 1)
         OR EXISTS (SELECT 1 FROM case_indices i
                    WHERE i.case_id = c.case_id AND i.relationship = 'child' AND i.depth = 1))
  UNION
  -- open extension of an available case (chain grounding)
  SELECT sub.case_id FROM available a
  JOIN case_indices i ON i.ancestor_id = a.case_id AND i.relationship = 'extension' AND i.depth = 1
  JOIN cases sub ON sub.case_id = i.case_id AND sub.closed_on IS NULL
),
live(case_id) AS (
  -- seed: owned AND available (owned open extensions are NOT seeded directly)
  SELECT a.case_id FROM available a JOIN cases c ON c.case_id = a.case_id
  WHERE c.owner_id = ANY($ownerSet)
  UNION
  SELECT nxt.case_id FROM live l
  JOIN LATERAL (
    -- up-pull: every direct parent/host of a live case, open or closed
    SELECT i.ancestor_id AS case_id FROM case_indices i
    WHERE i.case_id = l.case_id AND i.depth = 1
    UNION ALL
    -- down-pull: OPEN extensions of a live case (the host itself may be closed)
    SELECT sub.case_id FROM case_indices i
    JOIN cases sub ON sub.case_id = i.case_id AND sub.closed_on IS NULL
    WHERE i.ancestor_id = l.case_id AND i.relationship = 'extension' AND i.depth = 1
  ) nxt ON true
)
SELECT DISTINCT case_id FROM live;
```

**The test suite is the corpus, mechanically:** port
`case_relationship_tests.json` (44 non-skipped graphs) as a data-driven test — load each
graph into a scratch schema, run the query, assert the exact scope set. Do NOT hand-encode
the module docstring's examples (its final example is stale — see the contract bullet).
Any future query change must keep the corpus green; that IS the definition of correct.

- **Caching:** compute per persona on first use; hold as a session-scoped set (the
  re-measured ~610–675 ms worker / ~1.2 s worst-case make recompute-on-invalidate
  acceptable); invalidate on any case write in `(app_id, project_id)`. **The invalidation
  hook is NEW work in this PR** — a monotonic stamp bumped inside the store's write
  methods / the submission transaction. (PR-04 deliberately shipped per-render evaluation
  with manual reload and no counter; do not go looking for an existing seam.)
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

- The `case_relationship_tests.json` corpus (44 graphs), data-driven, exact scope-set
  assertions — the correctness contract (validated 44/44 at plan time).
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
