# Plan: F3 — Locations

> **Execution superseded (2026-07-06):** this plan remains the verified-facts + rationale reference; implementation follows the PR plans in `docs/plans/2026-07-06-pr-execution-plan.md` (+ `docs/plans/prs/`), which also carry the owner's scope rulings — several items this plan lists as deferred/excluded are now IN scope there (project-shared tables, authored+referencable create ids, rename/re-type ops, custom location fields, multi-location personas, answer-dependent choice filters, table reads from field expressions, case tiles, case attachments, session endpoints + smart links). Where this plan and the PR plans disagree on scope, the PR plans win.

*Planning pass, 2026-07-06. Seeded by `docs/research/feature-map.md` §F3 (charter = LOC L1–L6
wholesale + five questions); anchors: the locations memo throughout, ACA §2 (ownership →
restore → search-and-claim). Platform facts re-verified 2026-07-06 against
`~/code/commcare-hq` (@4e3052a8) and `~/code/commcare-core`/`~/code/formplayer`
(pinned-identical runtime). Consumes F2 (personas), F5 (the rows-adjacent + dual-delivery
patterns), F4 (the owner slot this feature makes meaningful). Several memo claims are
**corrected by source** below — noted inline.*

**What ships, in three slices.** (A) **The address book**: org levels with intent-bearing
roles, a location tree (rows in Postgres, like lookup tables), the flat locations fixture on
both delivery paths, and **typed owner/location addressing** for F4's owner slot and the
expression families. (B) **Ownership semantics**: roles drive per-persona owner sets and a
faithful restore-scope query in the preview — the thing that makes ownership *demonstrable*
(L5). (C) **The push loop**: location instances via the verified v0.6 API + the org-model
**setup artifact** (levels are not API-writable), with F2's user provisioning (P6) landing
here.

---

## 1. Verified platform facts + lifecycle citations

| # | Fact | Citation | Verdict |
|---|---|---|---|
| 1 | `LocationType` flags: `code` (SlugField, auto-derived from name, domain-unique — the fixture `@type`), `shares_cases`, `view_descendants`, `has_users` (default true; **editing it is gated by `ush_restore_file_location_case_sync_restriction`**, TAG_GA_PATH), `expand_view_child_data_to` (same gate), `expand_from`/`expand_from_root`/`expand_to`/`include_without_expanding`/`include_only` (fixture scope), `administrative` (**forced true on non-CommTrack domains** — commtrack-coupled, NOT the ownership inverse), stock fields (commtrack-only), `has_user` (**dead** — zero usages). | `commcare-hq/corehq/apps/locations/models.py::LocationType` (+ `save()`); `toggles/__init__.py::USH_RESTORE_FILE_LOCATION_CASE_SYNC_RESTRICTION` | Alive per column as noted. Memo correction: `administrative` is not a usable "owns nothing" knob for Nova-style domains. |
| 2 | `SQLLocation`: `location_id` server-generated (`uuid4().hex`), **globally unique**, the ownership identity; `site_code` **domain-unique, mutable, auto-derived** — the human/bulk identity; custom field VALUES in a plain `metadata` JSON blob; custom field DEFINITIONS use the same `custom_data_fields` machinery as users (`field_type='LocationFields'`) — `LocationFixtureDataField` **does not exist** (memo guess corrected). | `locations/models.py::SQLLocation`; `locations/views.py::LocationFieldsView`; greps | Alive. |
| 3 | **Flat fixture shape** (verified against code + live test XML): `<fixture id="locations" user_id indexed="true"><locations><location type="{code}" id="{location_id}" {code}_id="…" per EVERY level (self + each ancestor's id; '' otherwise)>` + built-in child elements (`name, site_code, external_id, latitude, longitude, location_type, supply_point_id`) + ONE `<location_data>` child holding custom fields as **grandchild elements** (every defined field emitted, empty when unset). Index schema covers `@{code}_id` for all levels + `@id`, `@type`, `name` — custom fields are NOT indexed. | `locations/fixtures.py::FlatLocationSerializer._get_fixture_node/_fill_in_location_element/_get_metadata_node/get_xml_nodes`; `locations/tests/data/related_location_flat_fixture.xml` (verified independently by the planning session) | Alive. **Memo corrections:** the production `@facility_id` join key is the BUILT-IN `{code}_id` lineage attribute, not a custom field; custom fields are `location_data` children, never attributes; the indexed `data_<slug>` shape in two orphaned test files is a **removed** feature (`index_in_fixture`) — do not build to it. |
| 4 | The hierarchical fixture (`commtrack:locations`) is gated by `HIERARCHICAL_LOCATION_FIXTURE` — **TAG_DEPRECATED** ("Do not turn this feature flag on"). The flat fixture is default-on for locations-enabled domains. **No "Sync All Locations" toggle exists** (memo's Confluence-era claim overturned; `INCLUDE_ALL_LOCATIONS` is conditional-alert targeting, unrelated). | `fixtures.py::should_sync_hierarchical_fixture/should_sync_flat_fixture`; `toggles/__init__.py::HIERARCHICAL_LOCATION_FIXTURE`; greps | Nova emits ONLY the flat shape. |
| 5 | Fixture **scope** is a footprint: a recursive SQL CTE (`get_location_fixture_ids`) over assigned locations + ancestors, with the expand/include flags encoded as depth rules (`include_without_expanding` = all of a level + ancestors; `include_only` = type filter; ancestors always included un-expanded). | `locations/sql_templates/get_location_fixture_ids.sql`; `fixtures.py::_location_queryset_helper/UserLocations.queryset` | Alive. |
| 6 | Ownership assembly: owner ids = `user_id` + one id per case-sharing group, where **each case-owning location materializes as an `UnsavableGroup` whose `_id` IS the `location_id`**; case-owning = assigned locations with `shares_cases` + descendants under `view_descendants` types (the USH toggle swaps in a SQL path honoring `expand_view_child_data_to`). Web users: **location groups only** (no classic groups). | `users/models.py::CouchUser.get_owner_ids/CommCareUser.get_case_sharing_groups/WebUser.get_case_sharing_groups/_get_case_owning_locations`; `locations/models.py::SQLLocation.case_sharing_group_object` | Alive. |
| 7 | The restore's `user-groups` fixture carries those location groups verbatim (`<group id="{location_id}">`), and the client's owner set is built **exclusively** from user ids + that fixture (`extractEntityOwners`) — no other client-side source (greps clean). | `users/fixturegenerators.py::UserGroupsFixtureProvider`; `commcare-core/.../SandboxUtils.java::extractEntityOwners` | Alive. The preview's owner-set formula. |
| 8 | Restores are the **livequery positive closure**: open cases owned by the owner set, then index-graph expansion (owned child pulls parents even closed; extension⇆host bidirectional liveness; nothing survives under a closed host) — the positive dual of the client purge filter. | `casexml/apps/phone/data_providers/case/livequery.py::do_livequery` (module doc examples); `commcare-core/.../CasePurgeFilter.java` (prior pass) | Alive. The preview restore-scope recipe. |
| 9 | The flat `locations` fixture is delivered **indexed** and the client routes fixtures generically on `indexed="true"` + id-agnostic storage — no `locations` special-casing anywhere client-side (greps clean); `commcare_location_id` (selected) / `commcare_location_ids` (assignment set) are plain user-data keys, no dedicated session slot. | `CommCareTransactionParserFactory.java::getParser`; `UserSqlSandbox.java`; `SessionInstanceBuilder.java`; greps | Alive. |
| 10 | Owner expressions evaluate as ordinary fixture lookups in the form context (instance declared ⇒ resolves; nothing owner-specific) and the produced string lands **verbatim and unvalidated** in the case block; server-side the only owner_id check is length ≤255. `UNOWNED_EXTENSION_OWNER_ID = '-'` is alive (extension-ownership sentinel, skips ownership-change accounting). | `CommCareInstanceInitializer.java::generateRoot`; `CaseXmlParser.java`; `form_processor/.../update_strategy.py` (length map); `casexml/apps/case/const.py`; `casexml/apps/case/xform.py::_is_change_of_ownership` | Alive. Typed addressing is therefore entirely Nova's guarantee (L4). |
| 11 | **APIs**: v0.5 `LocationResource` read-only; **v0.6 `LocationResource` writable** — list GET/POST/PATCH (atomic `patch_list`, ≤100/req, upsert-by-`location_id`), detail GET/PUT; create requires `name` + `location_type_code`; parent by `parent_location_id`; `site_code` settable/auto-derived/domain-unique-validated; `location_data` validated against the domain's LocationFields definition. **`LocationTypeResource` is effectively read-only** (no authorization override ⇒ tastypie `ReadOnlyAuthorization`; expand/`has_users` flags not even exposed) — **level definitions are UI-only**. All location APIs sit behind the **paid `LOCATIONS` privilege**. Excel bulk upload authors whole trees keyed by `site_code`. | `locations/resources/v0_5.py::LocationTypeResource/LocationResource` + `v0_6.py::LocationResource` (methods verified independently by the planning session); `resources/v0_5.py::BaseLocationsResource.dispatch` (privilege); `locations/bulk_management.py` | LOC §8 confirmed; **LOC §10.2 resolved: the org MODEL is not pushable — instances are.** |
| 12 | Unassigning the last worker from a case-owning location merely **orphans** its cases (owner_id keeps pointing at the location); the "Orphan Case Alerts" domain setting is a UI warning, nothing moves. | `domain/forms.py::orphan_case_alerts_warning`; `locations/views.py::_suggest_orphan_case_alerts_setting` | Alive; feeds validator/SA guidance, not mechanics. |
| 13 | Location-scoped web permissions (`location_safe`, `access_all_locations`) are an HQ-console authorization axis with **no wire representation** — scoped out. | `locations/permissions.py::location_safe`; `users/models.py::access_all_locations` | Out of scope, with citation. |
| 14 | User↔location assignment: `location_id` (primary) + `assigned_location_ids` (on the user doc for mobile; per-`DomainMembership` for web); API-writable on both user resources (`primary_location`(+`_id`) / `locations`/`assigned_location_ids`, must-provide-together, ids verified against active locations). | `users/models.py`; `api/resources/v0_5.py`; `api/user_updates.py::_update_location` | Alive — F2 P6's assignment surface. |

## 2. The shape question (protocol 3)

**CCHQ's authoring shape** — five-plus interacting booleans per level, a globally-unique
server id + a mutable human code, custom-data JSON, and stringly owner expressions — is the
flag soup L3 names. **Nova's shape** speaks roles and typed references:

```ts
// blueprintDocSchema — the org MODEL (schema-like, small, in-doc)
orgModel: z.object({
  levels: z.array(orgLevelSchema),   // ordered root → leaf
}).nullable(),

orgLevelSchema = {
  uuid: Uuid,
  name: string,               // "Facility", "Facility data"
  code: string,               // the wire @type slug — derived, slug-legal, unique per app
  role: "territory" | "bucket" | "registry" | "area",
  seesDescendantCaseloads?: boolean,   // view_descendants, intent-named (territory/area only)
  addressBook?: "everyone" | "footprint",  // reference-visibility (default footprint)
}
```

- **Roles, not flags (L3 — the leaning holds, with the synthesis table verified):**
  `territory` = workers live here and own their working set (`has_users` + `shares_cases`);
  `bucket` = owns without users — a routable destination (`shares_cases`, `has_users=false`);
  `registry` = a bucket whose *intended* reach is search-only (same flags; the distinction is
  SA guidance + docs framing, kept as a first-class role because the guidance differs —
  PHI-vault patterns, never restore-resident); `area` = grouping/supervision (`shares_cases=
  false`, users allowed, typically `seesDescendantCaseloads`). Flag synthesis happens at the
  **setup artifact + preview semantics** (fact 11 means HQ levels can't be pushed), and
  Nova's docs record the two HQ-side prerequisites: the paid `LOCATIONS` privilege and the
  USH toggle for `has_users=false` levels (fact 1).
- **The tree is data, not doc content** (the F5 pattern): a `locations` Postgres table
  (`app_id`, `project_id`, `uuid`, `level_uuid`, `parent_uuid`, `name`, `site_code`,
  `archived`), edited in a tree UI / by SA tools as data writes. `site_code` is Nova-derived
  (slug rules), the stable push identity (fact 2, 11); HQ's `location_id` is never stored in
  the blueprint — the wire addresses locations through the fixture (below), which is what
  makes emission independent of HQ-assigned ids.
- **Custom location fields: dropped from v1.** Their memo-era rationale (join keys) is
  overturned — the lineage `{code}_id` attributes are built-in (fact 3) — and their
  definitions aren't API-pushable anyway (fact 2). Recorded as a deferral with the
  `location_data` contract verified for when a real display/reference use appears.

**Typed addressing (L4)** — one `OwnerExpression`/location-reference family, consumed by
F4's `owner` slot, F1's display conditions (via the value families), and future routing:

```ts
LocationRef =
  | { kind: "location", locationUuid }            // a specific tree row
  | { kind: "user-location" }                      // the acting user's assigned location
  | { kind: "level-of", base: LocationRef | { kind: "case-owner", target: CaseTarget },
      levelUuid }                                  // the base's location at ANOTHER level
```

Compilation rides the verified fixture structure exclusively: a `location` ref →
`instance('locations')/locations/location[site_code='<code>']/@id`; `user-location` →
`session/user/data/commcare_location_id`; `level-of` with an ANCESTOR target level → the
lineage attribute on the base's row (`…location[@id = <base>]/@{code}_id`); `level-of` with a
DESCENDANT target level (the facility→bucket hop) → the reverse lineage filter
(`…location[@type='<code>'][@{base-level-code}_id = <base>]/@id`), guarded by a Nova validator
rule that the target level is a **singleton child per parent** in the authored tree (making
the reverse hop deterministic — the L4 guarantee made structural). The checker enforces the
headline invariant: **an owner expression's resolved level must have a case-owning role**
(bucket/registry/territory) — the "yields a case-owning location" guarantee, plus
`{ kind: "user" }` / `{ kind: "unowned" }` from F4's vocabulary (fact 10's `'-'`). The
`locations` instance joins the two accumulation seams (F5's arms extend).

## 3. Charter closure

- **L1 (need)** — affirmed; this plan is the answer.
- **L2 (ACA first, owner slot wire-complete)** — honored: F4 shipped the slot; F3 fills its
  vocabulary with `LocationRef` arms. Nothing re-plumbs.
- **L3 (roles not flags)** — §2's four roles + two intent-named options; synthesis at the
  setup artifact; buckets/registries get the deployment-prerequisite notes.
- **L4 (typed addressing)** — §2's `LocationRef` family; both hop directions compile from
  built-in lineage attributes; the case-owning-level guarantee is checker-enforced; the
  singleton-bucket rule makes reverse hops deterministic.
- **L5 (preview personas — the majority cost, decided jointly with F2)** — personas are F2's
  `userTypes` extended with `location: locationUuid` (+ optional multi-assignment later).
  Two independently-derived inputs per persona (the runtime report's explicit warning not to
  conflate them): **(a) owner set** = persona id + case-owning locations per the fact-6
  formula over Nova's tree (SQL over the `locations` table); **(b) address book** = the
  persona's footprint (or per-level `everyone`). The preview's case lists/menus/forms then
  evaluate against the persona's **restore scope** — a recursive-CTE implementation of the
  livequery closure (fact 8) over `case_indices` (open-owned seed; child→parent pulls;
  extension⇆host chains; closed-host death) — while case SEARCH deliberately keeps querying
  everything (search crosses ownership; ACA §2.4). Ownership finally *demonstrates*: create
  a referral owned by another facility's bucket as persona A, switch to persona B, watch it
  appear in B's queue — real rows, no simulation. This closes F4's deferred restore-fidelity
  note. Writes stamp `owner_id` from the op's owner slot / persona default (replacing the
  Nova-user stamping when a persona is active; `owner_id` remains a non-tenant axis).
- **§10.1 (fixture contract)** — resolved with corrections (facts 3–4): lineage attributes
  are the join keys; custom fields are `location_data` children; hierarchical deprecated.
- **§10.2 (LocationTypeResource writability)** — resolved: read-only; levels are UI-only ⇒
  the org model ships as a **setup artifact** (same output family as F2's schema artifact and
  F6's rules/alerts), while the TREE pushes via v0.6 (fact 11).
- **§10.3 (fixture-only cross-facility addressing)** — answered structurally: the lineage
  attributes + per-level `addressBook: "everyone"` (compiling to `include_without_expanding`
  in the artifact) make cross-facility addressing fixture-only viable without report pipes;
  the preview honors the same visibility so the answer is testable in Nova.
- **Sequencing inside the feature (charter Q5)** — YES to the reference-only first slice;
  the three slices in §5's prompt groups. Slice A alone unlocks F4 tier (b)'s addressing and
  is independently shippable.

## 4. Delivery + push

- **Local `.ccz`**: embed the address book as a suite-embedded global `<fixture
  id="locations">` in the verified flat shape (the F5 dual-delivery pattern; client routes
  fixtures generically — fact 9 — and Nova pins body parity against
  `FlatLocationSerializer`'s emission, lineage attributes included). Full tree (no
  footprint) — correct for a standalone artifact.
- **HQ path**: restore delivers the footprint-scoped fixture; Nova pushes the TREE after
  `importApp` (the third-phase pattern): v0.6 `patch_list` upserts in parent-before-child
  order, identity by `site_code` (stateless resolve per push), archived handling explicit.
  The org-model **setup artifact** carries: levels + role→flag table + the USH-toggle and
  `LOCATIONS`-privilege prerequisites + user-assignment notes; F2's P6 (user provisioning +
  `primary_location`/`locations` assignment — fact 14) lands here as planned.
- **Instance declarations**: the `locations` instance id + `jr://fixture/locations` src join
  `instanceSourceFor`/`addTermInstance`; XForm models declare on use (fact 10).

## 5. Execution prompts

Grouped by slice: A = P1–P3 (address book), B = P4–P6 (ownership + preview), C = P7–P8
(push + artifact). Serialized within a slice; B starts after A; C after A (B∥C possible).

---

**P1 — Org model + tree store.**
> Implement F3's foundation per `docs/plans/2026-07-06-f3-locations.md` §2. The `orgModel`
> doc slot (levels, roles, options; code slug rules; level mutations cloning the collection
> pattern; reference edges for level references) + the `locations` Postgres table (Kysely
> migration + store API + tree integrity: parent level must be the level's parent, singleton-
> bucket rule where a level is a reverse-hop target, site_code derivation + uniqueness) +
> validator codes/classes/repair judgments.
> **Open for implementer:** archived-location semantics in v1 (recommend: exclude from
> fixture + owner sets, keep rows); whether level reorder is supported post-creation
> (recommend: insert-only between existing levels, no re-parenting with data).

**P2 — Typed addressing.**
> Implement the `LocationRef`/owner vocabulary per plan §2/L4 (P1 landed): the arms, the
> checker rules (case-owning-level guarantee; ancestor vs descendant hop resolution against
> the level graph; singleton-bucket requirement for reverse hops), compilation to the
> verified fixture shapes on-device + to tree queries on Postgres, instance accumulation
> arms, card-editor constraints, F4 owner-slot integration.
> **Open for implementer:** how `case-owner` bases type-check against F4's target vocabulary;
> whether `user-location` needs a level qualifier when users may be multi-assigned
> (recommend v1: single-assignment personas, multi-assignment deferred).

**P3 — Address-book emission.**
> Implement fixture emission per plan §4 (P1–P2 landed): the flat `<location>` shape with
> lineage attributes byte-parity against `FlatLocationSerializer` (pin fixtures; note that
> HQ never emits suite-embedded locations — parser authority per the F5 precedent), suite
> embedding on the local path, instance declarations, and the index-schema node emission
> matching fact 3.
> **Open for implementer:** whether Nova emits the index `<schema>` node in the embedded
> fixture (recommend yes — byte-parity with restore delivery); `location_data` emission
> (empty node per fact 3's shape even with no custom fields — parity).

**P4 — Persona assignment + owner sets.**
> Implement plan §3/L5(a) (P1 landed): persona location assignment on F2's userTypes;
> owner-set derivation over Nova's tree (fact 6's formula: territory/bucket/registry roles
> + seesDescendantCaseloads expansion); `session/user/data` built-ins gain the location keys
> (`commcare_location_id`/`_ids` — fact 9's naming nuance: singular=selected,
> plural=assignment).
> **Open for implementer:** persona multi-assignment (recommend defer); how the owner set
> surfaces for debugging (a persona inspector affordance).

**P5 — Restore-scope preview.**
> Implement plan §3/L5's restore-scope query (P4 landed): the livequery positive closure as
> a recursive CTE over `case_indices` (fact 8's rules exactly — open-owned seed, child→parent
> pull incl. closed parents, extension⇆host bidirectional liveness, closed-host death);
> case lists/menus/form case-loading evaluate within the persona's scope; case search stays
> global; owner stamping on writes honors op owner slots / persona defaults. Test against
> the livequery doc's worked examples verbatim.
> **Open for implementer:** CTE performance shape (depth caps, materialization) — correctness
> first, the doc examples are the contract; how "no persona selected" behaves (recommend:
> author-omniscient mode, clearly labeled, matching today's behavior).

**P6 — Builder UI.**
> Implement F3's authoring surfaces (P1–P5 landed): the org workspace (levels editor with
> role vocabulary + the tree editor over Postgres rows), persona location assignment in the
> persona picker, owner-expression affordances in the F4 op editor and expression cards
> (address-book pickers), and the persona-scope indicators in the preview shell ("viewing as
> facility-A worker — 12 cases in restore"). Load the frontend-design skill.
> **Open for implementer:** tree-editor interaction model; how role choice explains itself
> (the territory/bucket/registry/area framing copy).

**P7 — Push loop + setup artifact.**
> Implement plan §4's HQ push (slice A landed): v0.6 client functions (patch_list upserts,
> parent-before-child, site_code identity, archived handling), the third-phase wiring with
> the degrade-to-warning contract, and the org-model setup artifact (levels + role→flag
> synthesis table + USH-toggle and LOCATIONS-privilege prerequisites + assignment notes),
> generated at export and kept in sync with `orgModel`. F2's P6 (user provisioning +
> location assignment) lands beside this.
> **Open for implementer:** artifact format/surface (align with F2's schema artifact —
> one "HQ setup" document per export); push-failure partial-state reporting.

**P8 — SA + docs + closure.**
> Close out F3 (all landed): SA tools (org model CRUD, tree rows, persona assignment, owner
> expressions) + prompt guidance (the ownership mental model scoped to what shipped — L3's
> role vocabulary, ownership-as-address for F4 tier (b) patterns now unlockable, the
> orphan-cases warning as a design smell, restore-size doctrine); tools.mdx + authoring docs
> (the three-population boundary from F2 extended with locations; the HQ prerequisites);
> CLAUDE.md updates; feature-map §F3 → pointer + F4 tier (b) activation note; drift sweep;
> and a memo-corrections annotation on `commcare-locations.md` (§10.1/§10.2 resolved, the
> lineage-attribute correction, the Sync-All-Locations removal).
> **Open for implementer:** guidance wording; how much of ACA §2's narrative enters the SA
> prompt now vs stays docs-side (recommend: the address/mailbox metaphor, one paragraph).

---

## 6. Risks + notes

- **The setup-artifact dependency is real**: an HQ domain whose levels/flags don't match the
  org model breaks ownership semantics silently (cases owned by never-restored buckets with
  the wrong flags). The artifact + docs carry this loudly; F6's planning should fold all
  three artifact families (user schema, org model, rules/alerts) into one "HQ setup" story.
- **`has_users=false` requires the USH toggle** on the target domain (fact 1) — bucket-based
  designs name this prerequisite in the artifact and the SA's guidance.
- **Restore-scope preview performance** over large trees/caseloads is the one open technical
  risk (P5's CTE); correctness is pinned by livequery's own examples, and the preview can
  cap depth with a visible notice long before it lies.
- **Multi-assignment personas** and **custom location fields** are recorded deferrals with
  their contracts verified (facts 14, 2–3).
