# CommCare locations: ownership, fixtures, and the org model behind serious apps

*Research memo, July 2026 — companion to `advanced-case-actions.md` (ACA), which covers the case-mutation side of the same architecture. Sources: `commcare-hq` at `~/code/` (primary; cited `path::symbol`), the Confluence dump (`.data/confluence-cache/pages`, snapshot ≈ Feb 2026; cited by page title + space), the two production Colorado apps read for the ACA memo, and builder context from that project (July 2026). The ACA memo's §2 develops ownership → restore → search-and-claim as a narrative; this memo is the locations reference underneath it.*

**TL;DR.** A CommCare location is a node in a per-project organization tree, and it does three unrelated-looking jobs at once: it is an **owner** (cases owned by a location sync to the users assigned there — locations are how caseloads are shaped), an **address book entry** (locations ship to every device as a fixture that expressions can query), and an **administrative unit** (assignment, web permissions, reporting). Complex apps exploit the gap between the first two jobs: a location with owners-but-no-users is a *bucket* — data lives there without landing in anyone's restore — and a location with users-but-thin-ownership keeps workers' devices fast. Nova will eventually need a locations model to express any of this, and CommCare exposes a writable locations API, so Nova could own the whole loop.

---

## 1. What a location is

- **The tree.** Each project defines *organization levels* (`corehq/apps/locations/models.py::LocationType`) — e.g. State → Registry → Organization → Facility → Facility Data — and then *locations* (`::SQLLocation`) instantiating them as a tree. Levels carry the behavior flags (§3); locations carry identity and data.
- **Identity.** A location has a server-generated `location_id` (the value that appears in `owner_id`), a human `site_code`, a name, and its type's `code` (the **Type Code**, surfaced in fixtures as `@type` — the thing expressions filter on: `location[@type = 'facility_data']`). ("Advanced Organization Level Configuration", commcarepublic.)
- **Custom data.** Projects can define custom location fields (`corehq/apps/locations/views.py::LocationFieldsView`, the same custom-data machinery users get). These matter more than they look: in the flat fixture they surface as *attributes* on each `<location>` element, which makes them **join keys** for expressions — the Colorado project puts `facility_id` (= the parent facility's location id) on every facility-data location, enabling the two-hop owner lookup described in §5. ("Referencing the Location/Organization Hierarchy in Applications", commcarepublic, shows the same pattern as `@block_id`/`@city_id` templates.)
- **Assignment.** Mobile workers (and web users) are assigned to one or more locations, with one primary. The session exposes the assignment to forms as `instance('commcaresession')/session/user/data/commcare_location_id` (primary) and `commcare_location_ids` (all).

## 2. The three jobs

1. **Ownership** — a location id is a legal `owner_id` for cases; owning-location membership is what turns assignment into a caseload (§3–4).
2. **Reference data** — the tree ships to devices as a fixture; forms and case lists query it for names, ids, types, and custom attributes (§5).
3. **Administration** — org-scoped web permissions (`corehq/apps/locations/permissions.py::location_safe` and the restrict-access-by-location framework), user management, report filters. This memo touches this job only where it leaks into app behavior.

The design space of serious CommCare apps lives in the fact that jobs 1 and 2 are **independently scoped**: what you can *reference* (fixture) is configured separately from what you *receive* (ownership). The Colorado apps push them maximally apart — tiny ownership, wide fixture — and route everything else through search, claim, and ACA writes.

## 3. Ownership mechanics

**How a user's owner ids assemble.** At restore time a user's owner ids are: their user id, plus their case-sharing groups, plus — via a group-shaped adapter — every location they're assigned to whose type owns cases (`corehq/apps/users/models.py::CouchUser.get_owner_ids` → `get_case_sharing_groups`; locations become sharing groups through `corehq/apps/locations/models.py::SQLLocation.case_sharing_group_object`). A location that "owns cases" behaves exactly like a case-sharing group whose membership is "users assigned here, plus ancestor locations granted View Child Data" ("Managing Case Sharing & Data Access in Organizations", commcarepublic: case-sharing groups are auto-created per owning location and include qualifying parents).

**Case sharing must be on, and the defaults are a minefield.** With app-level Case Sharing off, every case a user creates is owned by that user, period. With it on, an ordinary registration form assigns the *user's* sharing group — and errors unless the user resolves to **exactly one** group ("user should be in exactly one case sharing group"). The internal truth table of what owner a created case gets under every combination of location assignment, Owns Cases, and group membership — including all the error rows — is "Case Sharing: Locations vs Case Sharing Groups" (GS); the debugging guide for the resulting support tickets is "Debugging Case Sharing errors" (commcarepublic). Any user assigned to multiple locations (the norm in multi-level projects) hits the error unless the app takes over.

**Professional practice: always set `owner_id` explicitly.** The public guidance for multi-location or view-child-data users is to compute the owner in the form — role-based (`if(user's location type is X, use commcare_location_id, …)`) or user-selected from a location-driven choice list ("Managing Case Sharing & Data Access in Organizations" walks both; "Assigning Cases to One of Multiple Locations", commcarepublic, is the recipe page). The Colorado apps never rely on defaults anywhere: every create carries an explicit owner expression (see the ACA memo's census). Two related conventions: `owner_id = '-'` is the official "unowned" sentinel, used for extension cases that should only ride their host's sync (`casexml/apps/case/const.py::UNOWNED_EXTENSION_OWNER_ID`); and reassignment is just an `owner_id` property write — with a sync-relevance recalculation on the receiving end (`commcare-core …/CaseXmlParser.java::updateCase` fires `onIndexDisrupted` on owner change).

**What ownership buys, exactly.** Restores contain open cases owned by the user's owner ids plus the index-closure over them (child cases pull parents; hosts and extensions pull each other; extensions die with closed hosts — `casexml/apps/phone/data_providers/case/livequery.py::do_livequery`, and the ACA memo §2.2 for the worked rules). Ownership is therefore simultaneously *access*, *sync cost*, and — because messaging can target "the case's owner" (§6) — *delivery*.

**Web users are (now) full participants.** The platform's history runs offline-first mobile → web users creeping in for HQ access → parity work → today's Web Apps-first projects, and some public docs still carry stale mid-journey caveats ("case sharing as a web user is not supported" in the parity page — out of date per the builders, who run this entire architecture on web users, and flagged the doc upstream). The code agrees on the axis that matters here: `WebUser.get_case_sharing_groups` (`corehq/apps/users/models.py`) mirrors the mobile-worker path, locations-become-owner-ids included.

**Groups, in practice.** Classic case-sharing groups predate locations and still exist (§3's truth-table error rows involve them), but the field practice on serious projects is locations-only (builder-confirmed: "we just use locations") — the layering is accretion, not design.

**A guard worth knowing:** the "Show Orphan Case Alerts" project setting warns before unassigning the last mobile worker from a case-owning location, which would orphan its cases ("Managing Case Sharing & Data Access in Organizations").

## 4. The level flags, authoritatively

UI column → model field (`corehq/apps/locations/models.py::LocationType`), verified July 2026:

| UI | Field | What it actually controls |
|---|---|---|
| Owns Cases | `shares_cases` | Whether locations of this level can be case owners at all — i.e. whether assignment here contributes owner ids (§3). |
| View Child Data | `view_descendants` | Users assigned at this level also receive cases owned by descendant locations (their restore grows accordingly). |
| View Child Data to Level | `expand_view_child_data_to` | Bounds the above: only descendants down to the named level count. Feature-flagged (`ush_restore_file_location_case_sync_restriction`) and explicitly a restore-size lever; multi-location web users get the most permissive convergence of their levels' settings ("Prevent (Case) Syncing from Lower Level Locations", USH). |
| Has Users | `has_users` | Whether users may be assigned at this level. `has_users = false` + `shares_cases = true` is the **bucket** configuration (§6). |
| Level to Expand From / To, Include Without Expanding, Include Only | `expand_from`, `expand_to`, `include_without_expanding`, `include_only` | Fixture scope only — what locations a user can *see and reference*, not what cases they receive (§5). |
| — | `administrative` | The inverse framing of Owns Cases used internally (an administrative level doesn't own). |

The two independent axes deserve restating: `view_descendants`/`shares_cases` shape **case flow**; the expand/include family shapes **fixture contents**. "The 'View Child Data to Level' setting, combined with … 'Level to Expand To' and 'Level to Expand From', ensures that the user gets the list of *locations* in their restore, but none of the cases assigned to those locations" (same USH page — which, tellingly, works its example on a Registry/Provider/Organization hierarchy shaped exactly like this project's).

## 5. The location fixture

**Two formats, one current.** The modern **flat fixture** has id `locations` (`instance('locations')` in forms); the legacy **hierarchical fixture** is `commtrack:locations`, kept behind the `HIERARCHICAL_LOCATION_FIXTURE` toggle for old projects (`corehq/apps/locations/fixtures.py` — `flat_location_fixture_generator` / `location_fixture_generator`; migration guidance in "Migrating your project from the hierarchical location fixture to the flat location fixture.", commcarepublic). All new projects get flat. The flat serializer also emits an index schema so key attributes are device-indexed for query speed (`fixtures.py::get_index_schema_node`).

**Shape.** One `<location>` element per visible location, with identity and custom data fields as attributes — which is what makes expressions like the Colorado two-hop possible:

```
instance('locations')/locations/location
    [@type = 'facility_data']
    [@facility_id = <a clinic case's @owner_id>]/@id
```

(`@type` = the level's Type Code; `@facility_id` = a project-defined custom field; `@id` = the location id that goes into `owner_id`.)

**Default scope, and the dials.** By default a user's fixture holds their assigned location(s), all ancestors, and all descendants ("Advanced Organization Level Configuration", commcarepublic). The dials:

- `expand_from` — widen sideways: expand from an ancestor level instead (e.g. a clinic worker who needs *all clinics in the district* so cases can be owned by a sibling clinic).
- `expand_to` — cut depth for performance: stop including levels below N (e.g. drop thousands of CHW leaf locations nobody references).
- `include_without_expanding` — graft in *all* locations of a level (plus their ancestors) regardless of the user's position: how every Colorado worker's fixture contains the registry-level locations they will never own at ("include all levels of this type and their ancestors", `LocationType.include_without_expanding` field comment).
- `include_only` — allowlist specific levels outright.
- The **Sync All Locations** feature flag bypasses all scoping and ships the entire tree — documented as largely superseded by the advanced settings above ("Sync All Locations Feature Flag", saas).

**Getting the fixture into a form.** A form only carries the `locations` instance if something references it — the standard trick is a location-choices select question, or a dummy one with display condition `false()` when no visible question wants it ("Referencing the Location/Organization Hierarchy in Applications" documents the dummy-question idiom — the same family of hidden-scaffolding hacks as the ACA memo's §4.6).

## 6. Locations as an addressing system (the Colorado worked example)

The full narrative lives in the ACA memo (§2.1); here is the locations-specific distillation.

**Two level roles emerge that HQ has no names for:**

- **User-holders** — levels where people live (`has_users`), owning only what workers need *ambiently*. Colorado's Facility level holds the workers and exactly one standing record: the facility's own `clinic` directory case, so every worker's restore always contains their site.
- **Buckets** — levels that exist purely to own (`shares_cases` without `has_users`). Client Registry (the PHI vault: client cases, reachable only by search), each facility's `facility_data` child (workflow records — referrals, units, capacities, edit requests — kept out of every worker's restore *by construction*, since restore membership comes from assignment and nobody is assigned there), and BHASO region locations (region-addressed message queues). The builders are explicit that restore-slimming, not privacy, is the primary driver of the facility/facility-data split — privacy is handled orthogonally by keeping PHI on exactly one case type.

**Addressing.** To write *into* a bucket you must compute its id, and the fixture is one of three address books the apps use (locations fixture with custom-attribute join keys; mobile-report fixtures that map cases you don't own to their facilities; lookup tables mapping business names like BHASO regions to location ids — ACA memo §2.1 for the verified expressions). Ownership level is chosen **per workflow**, not per type: ordinary referrals go to buckets (search-driven work), while pending-admissions-list referrals are owned at the Facility itself because that list is worked daily from the restore.

**Delivery.** Ownership doubles as a messaging address: the domain's Conditional Alerts can send to "The Case's Owner" — and, for bucket-owned cases whose owner has no users, to a custom "the case owner location's *parent* location" recipient, with per-user filtering against usercase properties (project alert configuration reviewed July 2026; ACA memo §3-P2). A location, in other words, can be a mailbox in the email sense as well as the sync sense.

**The costs.** All of this is stringly and conventional: `@facility_id` is a project convention, not a schema; the two-hop is copy-pasted across dozens of binds; nothing validates that an owner expression yields a location that owns cases (a typo produces an orphan case that no restore will ever contain — only "Orphan Case Alerts" and reports would notice). The sophistication is real and completely un-reified.

## 7. Performance doctrine

Locations appear on both sides of the restore-size ledger ("USS Designing and Building Performant Apps", USH — the internal playbook; "Managing Application Size as it Relates to Performance", commcarepublic):

- **As owners** they *are* the caseload dial: what a level owns and who is assigned there decides restore size; buckets exist to hold data off restores; auto-update rules (50k updates/day cap — "Automatically Update Cases", commcarepublic) shepherd cases between owners as workflows age out.
- **As fixture content** they are payload: big trees need `expand_to`/`include_only` pruning; the playbook lists location fixtures alongside lookup tables as restore-size line items.
- **Web Apps multiplies everything** via `cc-sync-after-form` (sync per submission — ACA memo §2.3), and smart links force a *full* restore on every click (playbook), so both ownership scope and fixture scope are per-interaction costs there, not login costs.

## 8. Managing locations from outside the app

- **UI**: Users → Organization Structure (tree CRUD) and Organization Levels (the flags; "Advanced Mode" reveals the expand/include and view-child-to-level columns). Bulk upload via Excel exists for trees at scale.
- **API — and it writes.** Tastypie resources under `corehq/apps/locations/resources/`, wired in `corehq/apps/api/urls.py`: v0.5 `LocationResource` (read-only: `allowed_methods = ['get']`) and `LocationTypeResource`; **v0.6 `LocationResource` supports `get/post/patch` on the list and `get/put` on detail** — programmatic creation and update of locations is a supported surface. This is the mechanism behind the builder's note that Nova-authored location structures could be pushed to CCHQ, the same way Nova already pushes apps.
- **Data pipes**: the Colorado project's facility tree and directory cases are fed from the state's LADDERS system via Snowflake → CommCare APIs — locations and their mirror cases maintained from outside both the app and HQ's UI.
- **Web permissions**: the restrict-access-by-location framework (`corehq/apps/locations/permissions.py::location_safe` et al.) scopes HQ web UI/report access by location assignment — adjacent to app behavior but a separate axis; noted here so it isn't confused with ownership.

## 9. Implications for Nova (hypotheses for discussion)

**L1 — Nova cannot express "serious CommCare" without *some* locations model.** Every load-bearing pattern in the companion memo — buckets, registries, claim-forcing, owner-routed messages — is downstream of the org tree and its flags. Today Nova's blueprint has no organizational axis at all; exporting apps like these is not currently reachable no matter how good the ACA support is.

**L2 — But sequencing ACA first is right (agreeing with the builders, with one condition).** ACA's session-independent tier (fan-out updates, close-by-id, side-effect records, link/unlink — ACA memo H1) needs no ownership model and is previewable against Nova's real case store today. The condition: `owner_id` must ship as a first-class, wire-complete expression slot from day one — even if Nova can't yet *explain* owners, it must not be unable to *emit* them, or the export boundary breaks for exactly the apps that need ACA most.

**L3 — When locations do land, model the roles, not the flag soup.** HQ's five-plus interacting booleans (owns/has-users/view-descendants/expand-from/to/include-…) are the classic CCHQ shape Nova rejects. The observed *uses* suggest a smaller vocabulary: levels; **territories** (users live here, own their working set), **buckets/queues** (own without users — routable destinations), **registries** (searchable vaults), **reference-visibility** (what the address book shows, today's expand/include family). Whether Nova names these or synthesizes them from flags at the emitter is a real design decision — but the authoring layer should speak intent ("referrals land in the receiving site's queue"), never `include_without_expanding`.

**L4 — Addressing should be typed, not stringly.** The two-hop `@facility_id` join is a convention Nova can make structural: if locations are catalog objects with typed references (like case types and properties are today), then "owner = this facility's data bucket" is a resolvable reference — rename-safe, validatable ("this expression yields a location that owns cases"), and the orphan-case failure mode of §6 becomes a construction-time error instead of a silent data loss. This is the same references-are-identity move Nova already made for XPath.

**L5 — The preview question is the hard one.** Nova's preview is the real app on real data; ownership's meaning is *inter-user* (what lands in whose restore). A locations model without a way to preview "as facility A worker" vs "as registry staff" demonstrates nothing — which argues the locations feature is really a *multi-perspective preview* feature wearing a data-model hat. Project members already exist as a Nova concept (Projects/roles); whether preview-as-persona reuses that or invents app-level personas is a decision to surface.

**L6 — The write path exists end-to-end (for locations; not yet for their siblings).** With the v0.6 API, Nova could own the loop: author levels/tree in Nova, push locations alongside the app at upload time (parallel to `upload_to_hq`), and emit apps whose owner expressions reference the pushed ids. Open design question: identity mapping across pushes (site_code as the stable key?), and whether Nova-authored trees ever need to *merge into* pre-existing HQ trees (the Colorado case: LADDERS owns the tree; Nova would need to reference, not create). The domain-side siblings lag behind: **automatic case update rules and conditional alerts have no public write API today** (the builders are pushing for one and may PR CCHQ themselves), yet designs built on this architecture depend on both — see the companion ACA memo's H9 for how Nova should handle the gap in the meantime.

## 10. Open questions

1. **Fixture attribute contract.** Custom location fields as fixture attributes is observed behavior and documented-by-example ("Referencing the Location Hierarchy…"); confirm the exact serialization rules (`fixtures.py::FlatLocationSerializer`) — name collisions with built-in attributes, type coercion — before Nova relies on them as join keys.
2. **`LocationTypeResource` writability.** v0.6 writes locations; whether level definitions (the flags) are API-writable or UI/bulk-upload-only needs a check before assuming Nova can push a whole org *model* rather than just a tree.
3. **Can fixture scoping alone serve cross-facility addressing?** In principle the expand/include dials could put sibling facilities' buckets in a worker's fixture (locations only — never their cases) for direct addressing; the Colorado apps never needed to try, because their report pipes carry the cross-facility data anyway. A platform question to test empirically if a Nova design ever wants fixture-only addressing — with the standing caveat that backend dials and their UI surfaces don't always match (fields can be flag-gated, hidden, or differently named in the interface), so any answer should be traced through both.
