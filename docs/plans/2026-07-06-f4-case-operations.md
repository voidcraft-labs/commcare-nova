# Plan: F4 — Case operations (CommCare "Advanced Case Actions" / Save to Case)

> **Execution superseded (2026-07-06):** this plan remains the verified-facts + rationale reference; implementation follows the PR plans in `docs/plans/2026-07-06-pr-execution-plan.md` (+ `docs/plans/prs/`), which also carry the owner's scope rulings — several items this plan lists as deferred/excluded are now IN scope there (project-shared tables, authored+referencable create ids, rename/re-type ops, custom location fields, multi-location personas, answer-dependent choice filters, table reads from field expressions, case tiles, case attachments, session endpoints + smart links). Where this plan and the PR plans disagree on scope, the PR plans win.

*Planning pass, 2026-07-06. Seeded by `docs/research/feature-map.md` §F4; evidence anchor
`docs/research/advanced-case-actions.md` (ACA — H1–H9 are this plan's hypothesis seed, §3's
P1–P8 the pattern ground truth) with `docs/research/commcare-locations.md` (LOC) for the
ownership half. Every platform fact below was re-verified against the local checkouts on
2026-07-06 (`~/code/commcare-hq`, `~/code/formplayer`, `~/code/commcare-core`); formplayer's
`libs/commcare` submodule is pinned to the exact HEAD of `~/code/commcare-core` (verified by
diff on the cited files), so commcare-core citations ARE the Web Apps runtime. EXT items
folded in per the map: case-search extensions, the data-driven-repeat confirmation, app-profile
custom properties, and the explicit case-tile decision.*

**What ships.** A typed, per-form list of **case operations** — create / update / close /
link-unlink *other* cases, identified by typed targets rather than the session selection —
with whole-op and per-write conditions, explicit `forEach` multiplicity, and a wire-complete
`owner` slot from day one. Ops author in the builder as a form-level "what this form does to
cases" surface, execute in the preview inside one Postgres transaction, and emit as
cx2-namespaced `<case>` transaction blocks spliced into the XForm source on **both** export
paths. Tier (a) — session-independent logic — ships now; tier (b) — ownership choreography —
activates with F3, with nothing to re-plumb (H1/L2 honored).

---

## 1. Verified platform facts + lifecycle citations

| # | Fact | Citation | Verdict |
|---|---|---|---|
| 1 | HQ's render pipeline **preserves hand-authored case blocks**: `render_xform` wraps the stored source in a throwaway `XForm`; `_create_casexml` only APPENDS FormActions-driven blocks; the only strip is meta (`_add_meta_2`). No build/import validation inspects case blocks (import = JSON parse only; build = JavaRosa structural validation). | `commcare-hq/corehq/apps/app_manager/models.py::FormBase.render_xform`; `xform.py::XForm._create_casexml` / `::_add_meta_2`; `views/app_import_api.py::_handle_import_app`; `models.py::FormSource.__set__` | Alive. The Vellum save-to-case survival mechanism, confirmed at source. |
| 2 | The one collision guard checks a **direct `/data/case` child only** (`case_node`), and only when HQ itself generates a non-empty block. Ops at nested paths coexist with FormActions session-case management. | `xform.py::XForm.case_node` + the `case.exists()` raise in `_create_casexml` | Alive. Emitter invariant: never place an op block at bare `/data/case`. |
| 3 | `save_to_case` gating (`VELLUM_SAVE_TO_CASE` privilege, `FrozenPrivilegeToggle`) gates **only the Vellum UI question type** — zero checks in submission processing, build validators, or import. | `commcare-hq/corehq/privileges.py`; `toggles/__init__.py` ("not referenced in code directly but passed through to vellum"); greps of `casexml/`, `form_processor/`, `helpers/validators.py` | Alive, UI-only. Nova-emitted apps with op blocks work on any HQ plan. |
| 4 | `case_references` is **informational only**: consumed by data-dictionary/case-summary surfaces and one vacuous-when-empty validator; never by suite generation. | `models.py::CaseReferences`; `helpers/validators.py::IndexedFormBaseValidator.check_save_to_case_references`; `app_schemas/app_case_metadata.py` | Alive-informational. Nova omits it; loses only data-dictionary hints (record as docs note). |
| 5 | **Server-side action order is FIXED per block** — create → update → close → index → attachment, regardless of XML child order; blocks for one case sort create-first; across case ids, processing groups by case id. | `casexml/apps/case/xml/parser.py::CaseUpdate.__init__`; `casexml/apps/case/xform.py::get_case_updates` / `::order_updates`; `form_processor/backends/sql/update_strategy.py::SqlCaseUpdateStrategy._apply_case_update` | Alive. Client applies **document order** (fact 9) — Nova must emit only shapes where the two agree (§3.6). |
| 6 | Server create semantics: known props = name/external_id/type/owner_id/opened_on/user_id; `owner_id` falls back to `user_id` post-actions; **create-of-existing-id is an update, not an error**; an update-only block for an absent case still creates it (soft-assert only). Every block **requires `@case_id`** (`CaseGenerationException` otherwise). | `update_strategy.py::_apply_create_action` / `::_apply_case_update`; `casedb_base.py::get_case_from_case_update`; `parser.py::from_v2` / `has_case_id` | Alive. |
| 7 | Server update semantics: `RESTRICTED_PROPERTIES` = case_id/@case_id/date_modified/case_type/case_name/date_opened/@xmlns never write as dynamic props; special dynamic keys `location_id` (→ column) and `hq_user_id` (→ mirrors external_id). **No server-reserved `category`/`state`** — but the CLIENT treats them as reserved (fact 8), a divergence Nova must not expose. | `update_strategy.py::_apply_update_action`; `casexml/apps/case/const.py::RESTRICTED_PROPERTIES` | Alive. Drives the reserved-name validator list (§3.3). |
| 8 | Client action semantics (`CaseXmlParser`): create accepts ONLY case_type/case_name/owner_id children (rejects extras); update accepts anything, only `owner_id` fires `onIndexDisrupted` (category/state set client-reserved slots); index: element name = identifier, relationship defaults `child` (value not validated), empty target removes, self-index = clean error; `acceptCreateOverwrites` is **true in every runtime caller** (create-of-existing merges); attachments parse but formplayer's LOCAL hooks are **inert** (no sandbox storage). | `commcare-core/.../xml/CaseXmlParser.java::createCase/updateCase/indexCase/processCaseAttachment`; `formplayer/.../FormplayerCaseXmlParser.java`; `FormplayerTransactionParserFactory.java` | Alive. **Correction (2026-07-06 attachments verification):** the "dead in Web Apps" conclusion this row originally drew was too narrow — the local-sandbox no-op is real, but case attachments work end-to-end server-side (HQ persists + displays them; Android displays them); only Web Apps *in-app display* lacks a path. Case attachments are IN scope via `docs/plans/prs/pr-08-attachments.md`, which carries the full per-surface verdict table. ACA §7.4 closes as "yes, with the visibility trade stated". |
| 9 | **Resolved (ACA §7.1): index-only block against a locally-absent case is an NPE.** `parse()`'s index arm uses `loadCase(…, errorIfMissing=false)` then `indexCase` dereferences unguarded (both arms); the bulk parser is identical; the pull parser runs failfast with no upstream guard; the user gets a generic null-message error (form preserved). Update/close of an absent case, by contrast, throw the clean readable "Unable to update or close case X, it wasn't found". | `CaseXmlParser.java::parse/loadCase/indexCase` (verified independently by the planning session); `BulkProcessingCaseXmlParser`; `DataModelPullParser.java::parseBlock`; `formplayer/.../FormSubmissionHelper.java::executeStep` | Alive-crash-edge. Nova's emitter closes it structurally (§3.6: the empty-`<update/>` guard). |
| 10 | formplayer submission pipeline: validate → **local processXML into sandbox → purge → HQ POST → commit**, all in one `autoCommit=false` transaction; POST failure **rolls back local writes**. Post-submit sync only under `cc-sync-after-form` (default off); auto-purge under `cc-auto-purge` (default off). | `formplayer/.../FormSubmissionHelper.java::processAndSubmitForm/processFormXml/processXmlInner`; `FormplayerPropertyManager.java` | Alive. The preview model: one atomic transaction per submission (§3.5). |
| 11 | Close cascade lives in **purge**, not the parser: relevance flows child→parent (all edges) and host→extension (open destinations only); closed host ⇒ extensions not ALIVE ⇒ purged; closed parent keeps owned/open children. Missing-parent edges cascade-remove subtrees; cycles throw (surfaced as a distinct submit error). Server-side `close_extension_cases` is toggle-gated (`EXTENSION_CASES_SYNC_ENABLED`). | `commcare-core/.../cases/util/CasePurgeFilter.java`; `formplayer/.../FormRecordProcessorHelper.java::purgeCases`; `casexml/apps/case/xform.py::close_extension_cases` | Alive. Preview scope note in §3.5. |
| 12 | `owner_id='-'` has **no client special-casing** — it's just an id in no owner set (unowned ⇒ survives only via live relationships). Owner change on update arms the purge pass. Client owner set = user id + `user-groups` fixture ids. | `CaseXmlParser.java::updateCase`; `SandboxUtils.java::extractEntityOwners`; `CasePurgeFilter.java` | Alive. |
| 13 | Data-driven repeats confirmed (EXT): the Vellum model-iteration shape (Nova's `query_bound`) copies the whole template per instance (case blocks included), fires `<setvalue event="jr-insert">` scoped to the inserted instance, and the submission parser scans deep — **one case transaction per repeat instance**. `jr:count` is resolved **dynamically at navigation**, not once at load — Nova's `count_bound` is behaviorally frozen only because its hoisted `__nova_count_*` node is seeded once at `xforms-ready`; `lib/commcare/CLAUDE.md`'s "evaluated ONCE at form load" misstates the mechanism (doc fix, §6 P7). | `commcare-core/.../FormDef.java::createNewRepeat/canCreateRepeat`; `FormEntryModel.java::createModelForGroup` (verified independently); `SetValueAction.java::processAction`; `DataModelPullParser.java` | Alive. |
| 14 | Multi-select (EXT): short-detail `multi_select` + `max_select_value` (default **100**, model + client parser agree) → `<instance-datum>`; selected ids materialize as a virtual instance (`jr://instance/selected-entities/…`, `<results><value>` shape); claim is **one POST carrying all ids** (HQ loops server-side; 204 = already claimed); client enforces the select cap. | `commcare-hq/.../models.py::case_details.short.multi_select/max_select_value`; `suite_xml/post_process/remote_requests.py::build_remote_request_datums`; `commcare-core/.../VirtualInstances.java`; `SessionDatumParser.java::DEFAULT_MAX_SELECT_VAL`; `formplayer/.../MenuSessionRunnerService.java::doPostAndSync`; `WebClient.java::caseClaimPost` | Alive. |
| 15 | Related-case pulls (EXT): `CaseSearch.include_all_related_cases` / `custom_related_case_property` → `<data key="x_commcare_include_all_related_cases">` / `x_commcare_custom_related_case_property` on the query; server behavior in `get_related_cases_result` / `get_expanded_case_results`. Results-instance case lists: `results` / `results:inline` storage instances, detail nodesets over them append `[not(commcare_is_related_case=true())]`. | `models.py::CaseSearch`; `remote_requests.py`; `case_search/utils.py`; `case_search/const.py::EXCLUDE_RELATED_CASES_FILTER` | Alive. |
| 16 | Claim `<post>` emits on `<remote-request>` (Nova already does) **and** on regular `<entry>` when inline-search or sync-cases-on-form-entry — the guard is `CaseClaimXpath.default_relevant()` (`count(casedb case) = 0`), which Nova's `claim.ts` already mirrors verbatim. | `remote_requests.py::build_remote_request_post`; `entries.py::include_post_in_entry/add_post_to_entry`; `xpath.py::CaseClaimXpath` | Alive; entry-post deferred to tier (b) (claim-on-entry choreography). |
| 17 | App-profile custom properties (EXT): `profile.custom_properties` ride the app JSON un-touched at import, emit as `<property … force="true"/>` — **only if the domain has the `CUSTOM_PROPERTIES` toggle** (TAG_FROZEN, domain-namespaced). All three target keys are alive in formplayer: `cc-sync-after-form` (`isSyncAfterFormEnabled` → post-submit sync), `cc-auto-advance-menu` (menu auto-advance), `cc-index-case-search-results` (search-result local indexing). | `models.py::Application.profile/create_profile`; `toggles/__init__.py::CUSTOM_PROPERTIES`; `formplayer/.../FormplayerPropertyManager.java` | Alive, domain-toggle-gated on the HQ path; ungated on Nova's local `.ccz` (Nova writes profile.ccpr itself). |
| 18 | **Lifecycle warnings — removed CaseSearch fields, do not emulate** (model docstring): `search_label` + `again_label` variants, `dynamic_search`, `additional_relevant`, `search_filter`, `command_label` (removals dated 2021–Apr 2026). | `models.py::CaseSearch` docstring | Removed. The EXT prompt must re-check Nova's current search-label emission against these removals (§6 P6). |

## 2. The shape question (protocol 3)

**CCHQ's authoring shape** — a data-only Vellum question node whose placement is its
multiplicity, configured as name-keyed `{calculate, relevant}` maps of raw XPath, with a
free-string Case ID as the entire targeting model — is precisely the shape ACA §5 indicts and
H2 rejects. **Nova's shape is a first-class list of typed operations on the form:**

```ts
// lib/domain/forms.ts — new optional slot
caseOperations: z.array(caseOperationSchema).optional(),

CaseOperation = {
  uuid: Uuid,                 // stable identity (UI, refs, mutations)
  id: string,                 // semantic slug — becomes the wire container element name
  action: "create" | "update" | "close",
  caseType: string,           // catalog-declared type
  target: CaseTarget,         // typed; see below (create ⇒ implicit "new")
  condition?: Predicate,      // whole-op gate — ACA §1.3's group-wrapping idiom as structure
  forEach?: { repeat: Uuid },  // explicit multiplicity: run once per instance of that repeat
  name?: ValueExpression,     // create only (required): case_name
  owner?: ValueExpression,    // create/update: the wire-complete owner_id slot (H1/L2)
  writes?: Array<{ property: string, value: ValueExpression, condition?: Predicate }>,
  links?: Array<{ identifier: string, targetType: string,
                  target: CaseTarget | null,        // null = unlink (empty-target-removes)
                  relationship: "child" | "extension" }>,
}

CaseTarget =
  | { kind: "new" }                       // this op's fresh case (create only; id = uuid())
  | { kind: "op", opUuid: Uuid }          // another op's new case, same submission
  | { kind: "session" }                   // the loaded session case (case-first contexts)
  | { kind: "expression", expr: ValueExpression }   // runtime-resolved case id
```

Decisions inside the shape (the H2 open points):
- **`index` is a facet (`links`), not an action** — authors think "this referral belongs to
  this client"; the wire's `<index>` is emission detail. `links` is available on create AND
  update ops (P7's re-link/unlink surgery is link-editing on existing cases). Unlink = `target:
  null`, riding the verified empty-target-removes rule (facts 8, and server-side index-update
  semantics).
- **Close-with-final-writes is ONE op**: `action: "close"` carries `writes` and emits
  update-then-close in one block — the order on which client document-order and the server's
  fixed order provably agree (§3.6).
- **`forEach` is an explicit field** referencing a repeat by uuid — placement never implies
  multiplicity (the anti-Vellum decision). "Per selected search result" is NOT a separate
  mechanism: it is a `query_bound` repeat whose `ids_query` reads the selected-entities
  instance, then `forEach` that repeat — one multiplicity concept (fact 13, 14).
- **Ops live on the form** (ordered array; array order = Nova's canonical execution order),
  not attached to repeats — the repeat attachment is the `forEach` edge.
- **v1 excludes**: attachments (inert in Web Apps, fact 8 — closes ACA §7.4 as "no");
  rename/re-type via ops (wire-legal, deferred with a widening note — reserved-name rule
  keeps `case_name`/`case_type` out of `writes`); authored create ids (create is always a
  fresh uuid — collision-free, and the observed apps seed `uuid()` anyway).

Nova's references make the doc self-knowing: `(caseType, property)` writes join the existing
reference index and rename cascade, so there is no ACA §1.5 side-channel — the blueprint
itself knows what every form writes (and `case_references` is verified informational, fact 4).

## 3. Charter closure

### 3.1 H1 — the tier split (Sequenced bet, kept)
Tier (a) ships now: fan-out updates (`forEach` over repeats, incl. case-query-driven
`query_bound` repeats), close-by-id (P6), side-effect records (P8/P2-lite: audit rows,
message-shaped records with default ownership), link/unlink surgery (P7), event-shaped
multi-case forms. **`owner` is a wire-complete expression slot from day one** — the emitter
compiles any expression (including the `'-'` sentinel, which the client treats as plain
not-mine, fact 12); absent `owner` on create defaults to the meta userID bind, matching both
Nova's current subcases and the server fallback (fact 6). Tier (b) — foreign-owner routing,
claim-forcing (`commcare-case-claim` creation, P4), moderated writes (P3), claim-on-entry
posts (fact 16) — activates with F3; nothing in the schema changes then, only the reserved-type
gate (§3.3) and SA guidance widen.

### 3.2 H4 — naming
The feature is **"case operations"** everywhere user-facing (builder section: "Case
operations"; SA vocabulary: create/update/close/link *other* cases). "Save to Case" /
"Advanced Case Actions" appear only in docs as the CommCare name for the exported artifact.

### 3.3 H3 + charter "validator posture" — valid-by-construction at a dynamic boundary
What gates (all `soundness`, all checker-style rules; every code gets its
`VALIDITY_CLASS_BY_CODE` row + `legacyFindingRepairs` judgment):
- `caseType` must be catalog-declared; every `writes[].property` must be declared on that
  type — **the same catalog chokepoint the store's AJV enforces** (`additionalProperties:
  false`), so op mutations run the `declareCaseType`/`ensureCatalogProperty` chokepoints
  exactly like `case_property_on` writers do. This is H3's materialization answer: ACA-written
  properties are catalog properties, indistinguishable to schema materialization.
- Reserved property names in `writes`: the server `RESTRICTED_PROPERTIES` set + `owner_id`
  (the `owner` slot owns it) + `location_id`/`hq_user_id`/`external_id` (server-special) +
  `category`/`state` (client-reserved but server-plain — the divergence of facts 7/8 makes
  them unexposable).
- Reserved case types: v1 rejects ops on `commcare-user` (usercase — F2's), `commcare-case-claim`
  (tier b revisits for P4), `user-owner-mapping-case`.
- Target/type coherence: `target: session` only in case-first modules with `caseType` = the
  module's type (same `isCaseFirstModule` gate F1 uses); `target: op` must name a create op
  earlier in the array with the same `caseType`; expression targets type-check as text/id
  under the op's evaluation context (form context — field refs, case refs, session terms).
- `links[].targetType` catalog-declared; identifier a legal XML element name; self-link of an
  op to itself rejected where decidable (`target: op` = self).
- Cycles/order: `target: op` must reference an EARLIER op (array order), keeping Nova's
  canonical order a topological order by construction.

What does NOT gate — the genuinely dynamic part: **"the expression target will exist / be
locally present" is not a finding.** Nova has no warning class, and gating would ban tier
(a)'s core capability. The posture instead: (1) the crash edge is closed structurally at the
emitter (§3.6), so the worst runtime outcome is the clean "wasn't found" submission error
with the form preserved (facts 9, 10); (2) the builder's op inspector labels expression
targets "runtime-resolved" with the failure semantics spelled out; (3) SA guidance carries
the §3-P3 lesson (write what you own; request patterns) and the claim-on-entry answer arrives
with tier (b). This answers "how loud is the can't-prove-present warning": it is an authoring
affordance and guidance concern, deliberately not a validator finding.

### 3.4 Whole-block conditionality (charter bullet 5)
`condition` on the op and `condition` per write are first-class Predicate slots (F1's
machinery: same AST, same on-device lowering, same `matchModeOnDeviceCompatibility`
extension). Emission: the op's container node gets a `relevant` bind (irrelevant subtree
never serializes — the standard JavaRosa mechanism the production apps use by hand);
per-write conditions become `relevant` binds on the property nodes (an irrelevant write node
is absent ⇒ no empty-overwrite, mirroring `XFormCaseBlock.add_case_updates`' guard
semantics). The preview evaluates the same conditions explicitly (it must NOT rely on
render-visibility: the engine's submission walk currently ignores `state.visible` — a known
divergence the preview prompt must not inherit into ops).

### 3.5 H6 — preview executes, exactly
- **One Postgres transaction per submission** — including the existing followup/close
  non-atomicity, which P3 fixes as part of this feature (the runtime model is
  atomic-with-POST, fact 10; Nova's store already does single-txn `insertWithChildren`).
- Application order = Nova's canonical order (§3.6). Per op: create → `insert` (fresh uuid;
  `case_indices` edges from `links` with **real relationships** — fixing the store's
  hardcoded-`"child"` edge writes); update → JSONB merge + link CRUD (identifier-keyed
  replace; null target removes); close → final writes then `closed_on`.
- Owner: stamp the op's `owner` result (or the acting-user default) — `owner_id` stays the
  non-tenant axis it is today; no preview query starts filtering on it in F4.
- **Purge/restore semantics are out of scope and that is faithful**: extension-death-on-
  closed-host happens at purge/sync (fact 11), which a Web Apps session doesn't run
  per-submission by default (`cc-auto-purge` off, `cc-sync-after-form` off). The preview
  models the sandbox, not the sync. F3's ownership/persona work owns restore semantics;
  recorded as the explicit handoff.
- Create-of-existing tolerance: unreachable in v1 (creates are always fresh uuids) —
  documented so the widening decision (authored create ids) knows what it buys into.

### 3.6 Charter "preview must match the wire" — the ordering contract
Client applies actions in document order; the server normalizes per block to create → update
→ close → index and sorts a case's blocks create-first (facts 5, 8). Nova therefore emits, per
op, **one block whose children are written in the server's fixed order** — making document
order and server order literally identical — and never emits two ops on the same
statically-known target where cross-block order could diverge (validator: at most one op per
(caseType, target) for session/op/new targets; expression targets are runtime-distinct by
design and get the same-id-merge semantics both runtimes share). Two structural emitter
guards, both Fixed:
- **Every block carries `@case_id`** (server hard requirement, fact 6), `@date_modified` ←
  `/data/meta/timeEnd`, `@user_id` ← `/data/meta/userID` (meta exists post-render on both
  paths — Nova injects locally, HQ injects on render; binds may reference it from source,
  the Vellum-verified pattern).
- **A non-create op that carries `links` always also emits `<update/>`** (its writes, or
  empty) **before `<index>`** — converting fact 9's NPE into the clean
  `errorIfMissing=true` error path. An empty `<update/>` is a no-op on both runtimes
  (verified: client loop body never entered; server empty dynamic-properties dict).

### 3.7 H7 — no stub pathologies
Recorded as a design principle: Nova forms are whatever their operations say they are. No
never-true generated-block disablers (Nova controls generation), no icon-holder modules
(media is first-class), no filler forms (formless case-list modules are already legal in
Nova), no shadow-module reuse hacks (F7 owns reuse). The archetype vocabulary
(registration/followup/close/survey) stays, but ops are orthogonal to it: any form type may
carry `caseOperations` (a survey with ops is an "event form" — P8 — without pretending to be
a registration).

### 3.8 H5 — SA guidance (tier-a scope)
Trigger smells (each names its pattern): "when X happens, also update/mark/recalculate Y"
(P5/P8 — but see the tile decision, §5); "delete/archive items from a list the form iterates"
(P6, with the soft-close doctrine: prefer status-property writes for primary entities — hard
close only for finished-as-data records — and note case search excludes closed cases);
"one event, several records" (P8); "merge/re-link/unlink records" (P7); audit-trail records
(P2-lite). Negative guidance: the session case's own lifecycle stays on ordinary form types;
ops never compensate for selection/session design (that's modules — ACA §3.1's rule); no
notifications/routing promises until tier (b) (F3/F6 own delivery). Also the calibration
note: re-derive structure, don't copy the reference apps' shapes (H5's builder quote).

### 3.9 H8, H9 — explicitly someone else's
H8 (sections/steps, form granularity) is F7's decision; F4 only records that event-shaped op
forms make mega-forms *less* necessary, not more. H9 (rules/alerts as designed outputs) is
F6's charter; F4's contribution is that `message`-shaped side-effect records are authorable
in tier (a) while their delivery half stays explicitly F6.

## 4. EXT closures (map §EXT, owned here)

- **Case tiles: explicitly NOT YET.** No tile/tile-grouping vocabulary in v1 (confirmed
  absent end-to-end in Nova today). The consequence is stated as SA guidance, not silence:
  tiles are the display constraint that *causes* P5 denormalization (ACA §3-P5); without
  them, parent-field display belongs in **calculated columns walking the index** (the
  ValueExpression/via machinery), not in copied properties — the SA's default is "project,
  don't copy". P6's prompt verifies the calc-column parent-walk lowering actually covers
  this on-device; if it doesn't, that gap is the tile-decision's first follow-up.
- **Multi-select case lists**: in scope (P6 prompt) — short-detail `multi_select` +
  `max_select_value` (default 100), `<instance-datum>` emission, and the selection-repeat
  mechanism (query_bound over the selected-entities instance) as the forEach source.
- **Related-case pulls + results-instance lists**: in scope (P6) — two advanced
  `caseSearchConfig` slots emitting the verified `<data>` keys; results-instance handling
  already exists via `compileForPlatform` storage instances.
- **Claim-post on `<entry>`**: deferred to tier (b) with fact 16 recorded (Nova's
  remote-request claim post already matches HQ's verbatim).
- **App-profile custom properties**: in scope (P6) — widen `HqApplication.profile.properties`
  (currently `Record<string, never>`) + a data-driven property splice in `generateProfile`;
  authored as app-level advanced settings. The HQ-path caveat is documented wherever the
  setting surfaces: emission on HQ requires the domain's `CUSTOM_PROPERTIES` toggle
  (fact 17); the local `.ccz` path is ungated. `cc-auto-advance-menu` is recorded for F7.
- **Repeats**: data-driven mode confirmed (fact 13); the deliverable is the
  `lib/commcare/CLAUDE.md` `jr:count` correction (P7) — no new repeat machinery.

## 5. Full-stack scope (protocol 4)

- **Domain** (`lib/domain`): `caseOperationSchema` + `CaseTarget` union on `forms.ts`;
  reference-slot registry entries (op writes are `(caseType, property)` identities;
  `forEach.repeat` and `target.opUuid` are uuid edges; `owner`/`name`/`value` expressions are
  predicate-ast slots) + `extractFormEdges` + rename-cascade arms; evaluation-context rule:
  op expressions check in the form's context (field refs legal — values come from the form),
  reusing F1's display-condition context work for the session/user terms.
- **Doc/mutations** (`lib/doc`): granular op mutations (`addCaseOperation` /
  `updateCaseOperation` / `removeCaseOperation` / `moveCaseOperation`), quartet-style like
  columns/searchInputs (ops are an ordered, uuid-keyed list — same multiplayer-merge
  rationale); catalog declaration chokepoint wired into op-creating surfaces.
- **Validator**: §3.3's rule set; oracle extensions (suite oracle untouched; XForm oracle +
  binding-resolution oracle accept the op-block shapes; fuzz arbitraries grow op arms).
- **Emitters** (`lib/commcare`): the op-block renderer into the XForm source, shared by both
  paths (unlike `addCaseBlocks`, which stays compiler-injected and FormActions-driven for
  session-case work); container-per-op under a reserved parent (`__nova_` namespace family),
  never at bare `/data/case` (fact 2); §3.6's ordering + guards; setvalue-vs-bind `@case_id`
  mechanics per forEach (the Vellum split, `saveToCase.js::getBindList/getSetValues`);
  instance accumulation via the existing scan. **Fixture set**: Vellum canonical outputs
  (`~/code/Vellum/tests/static/saveToCase/*.xml`), HQ's `xform.py` generated shapes for the
  meta/attribute conventions, and the production form cited throughout ACA §1.3 (m2-f0) as
  the integration reference.
- **Preview** (`lib/preview` + `lib/case-store`): §3.5 — new `SubmissionMutation` op arms;
  one-transaction submission (fixes existing followup/close split); `case_indices`
  relationship written from links/catalog (closes the hardcoded-`"child"` gap for op edges
  AND the existing subcase writes); link CRUD on the store.
- **Builder UI**: a form-level "Case operations" section — the single view of "what does
  submitting this form do to the case universe" that ACA §5 shows Vellum cannot offer: the
  op list with per-op cards (action, type, target, condition, writes, links), forEach
  binding, and the runtime-resolved-target affordance (§3.3).
- **SA + MCP**: op tools (add/update/remove, typed input mirroring the schema),
  `scripts/test-schema.ts` coverage, prompt guidance per §3.8; MCP propagation automatic.
- **Docs + map**: authoring docs page ("Case operations"); `tools.mdx`; CLAUDE.md updates
  (`lib/domain`, `lib/commcare` — including the jr:count correction, `lib/case-store`,
  `components/builder`); feature-map §F4 charter → pointer.
- **Migration**: none — additive slots; repair judgments still mandatory.

## 6. Execution prompts

Serialized P1 → P2 → P3 → (P4 ∥ P5) → P6 → P7. Every prompt inherits: the §3.6 ordering
contract and emitter guards are Fixed; the §3.3 gating list is decided; nothing relitigates
the tier split.

---

**P1 — Domain vocabulary + mutations + validator.**
> Implement F4's domain layer per `docs/plans/2026-07-06-f4-case-operations.md` §2, §3.3,
> §5. `caseOperationSchema` + `CaseTarget` on `formSchema`; the op mutation quartet with
> uuid+order identity (clone the columns/searchInputs pattern); catalog declaration
> chokepoints on every op-creating surface (multiplayer test per surface, like
> `multiplayerMerge.test.ts`); reference-slot registry + index extraction + rename cascade
> for every expression/identity edge ops carry; the full §3.3 rule set as gating soundness
> findings with repair judgments. Tests: checker matrix over targets × actions × form types;
> reference-index fuzz parity; gate rejection cases.
> **Open for implementer:** exact rule granularity (one code per rule family vs per
> violation); the op `id` slug derivation + uniqueness scope (recommend: unique per form,
> `identifierVerdicts`-style); whether `links[].identifier` defaults to `"parent"` (the
> production convention) or requires explicitness.

**P2 — Wire emission.**
> Implement F4's emission per plan §3.6, §5 (P1 landed). The shared op-block renderer into
> XForm source on both paths; canonical child order create→update→close→index; the
> empty-`<update/>` link guard; `@case_id`/`@date_modified`/`@user_id` conventions;
> setvalue-vs-bind case-id mechanics under `forEach`; op-container placement under a
> reserved parent, never bare `/data/case`; condition/write-condition relevant binds;
> instance accumulation. Extend the XForm + binding-resolution oracles and the fuzz
> arbitraries; verify against the Vellum saveToCase fixtures + ACA §1.3's m2-f0 shape.
> Totality: the checker is the gate; no emit-time errors.
> **Open for implementer:** the container element naming scheme (op `id` vs `__nova_op_<id>`
> — must satisfy the XML-name + reserved-prefix rules and read acceptably in HQ's form
> builder); whether op blocks nest under one shared parent group or one group per op (pick
> what Vellum renders most legibly — check `get_questions`' `/case/` path handling);
> HQ-JSON `case_references` emission (default: omit; document the data-dictionary cost).

**P3 — Preview execution.**
> Implement F4's preview per plan §3.5 (P1–P2 landed; semantics must match P2's ordering
> contract). New `SubmissionMutation` op arms; single-transaction submission for ALL form
> types (including the existing followup/close atomicity fix — this is a behavior fix,
> test it); store link CRUD + relationship-correct `case_indices` writes (also fix the
> existing subcase edge writes to read the catalog relationship); op condition / write
> condition evaluation independent of render visibility; owner stamping. Tests:
> op-application matrix vs the §3.6 contract (including same-target merge, empty-link
> removal, close-with-writes ordering); transaction rollback on mid-submission failure.
> **Open for implementer:** the store API shape for link CRUD (extend `CaseUpdate` vs a
> dedicated method); how `forEach` iterations map to per-instance op applications in
> `computeSubmissionMutation` (follow the existing repeat bucket walk); whether close
> stamps `status` (recommend: only when a write sets it — no implicit status vocabulary).

**P4 — Builder UI.**
> Implement F4's authoring surface per plan §5 (P1 landed; parallel with P5). The form-level
> "Case operations" section: op list + per-op editor cards (action/type/target/condition/
> writes/links/forEach), the runtime-resolved-target affordance with failure semantics
> copy, catalog-property pickers, PredicateCardEditor for conditions. Load the
> frontend-design skill; build from existing primitives.
> **Open for implementer:** where the section lives (form settings panel vs a dedicated
> workspace like the case-list config — recommend dedicated: ops are content, not settings);
> card information density; how link identifiers render ("belongs to <client> as
> <identifier>").

**P5 — SA tools + prompts.**
> Implement F4's agent surface per plan §3.8, §5 (P1 landed; parallel with P4). Op CRUD
> tools with typed inputs; prompt guidance: the tier-a trigger smells, the negative
> guidance, the soft-close doctrine, the project/copy calibration note; scripts/test-schema
> run; MCP automatic.
> **Open for implementer:** how much op vocabulary enters the SA's standing prompt vs
> tool-description docs (the ownership model stays OUT until tier b — H5's calibration);
> guidance wording.

**P6 — EXT case-search + profile pack.**
> Implement plan §4's in-scope EXT items (P1–P3 landed): multi-select case lists
> (short-detail flag + max_select_value + `<instance-datum>` + selection-repeat as forEach
> source), related-case pulls + results-instance advanced slots, app-profile custom
> properties (type widening + data-driven splice + the domain-toggle caveat in docs/SA
> notes). Verify the calc-column parent-walk lowering supports the "project, don't copy"
> guidance; verify Nova's search-label emission against fact 18's removed CaseSearch
> fields and fix any dead emission found. Fixture verification per surface (name HQ suite
> fixtures for instance-datum + query data keys before implementing).
> **Open for implementer:** multi-select authoring shape (module-level flag vs case-list
> config slot — apply the shape question); which profile properties surface as named
> settings vs a generic key-value escape (recommend named: the three verified keys only);
> selection-repeat authoring affordance.

**P7 — Docs, corrections, sweep.**
> Close out F4 (P1–P6 landed): authoring docs page; tools.mdx; CLAUDE.md updates including
> the `lib/commcare/CLAUDE.md` jr:count mechanism correction (cite
> `FormEntryModel::createModelForGroup` + `FormDef::canCreateRepeat`; Nova's count_bound
> behavior note stays, its JavaRosa claim gets fixed); the tile not-yet decision recorded
> where SA guidance lives; feature-map §F4 → pointer; the standing drift/v1-punt sweep.
> **Open for implementer:** docs structure; whether the ACA research memo gets a
> "§7.1 resolved (NPE, guarded structurally)" annotation (recommend yes, one line).

---

## 7. Risks + deliberately-deferred questions

- **Client/server divergences Nova refuses to expose** (facts 5, 7, 8): category/state,
  rename/re-type via update, authored create ids, attachments. Each is wire-legal; each is
  excluded with a named reason; widening any is a schema-level decision, not a bug fix.
- **Purge/restore fidelity** is F3's: the preview's "sandbox without sync" stance (§3.5) is
  faithful today but must be revisited when personas/ownership land (extension-death,
  owner-change eviction).
- **Multi-claim latency** (ACA §7.3): tier (b) concern; recorded, unaddressed.
- **`commcare-case-claim` creation (P4 pattern)**: reserved in v1; tier (b) decides whether
  Nova's claim-forcing goes through hand-built claims or leans on entry-post claims
  (fact 16) — evidence gathered then.
- **Rule cap** (ACA §7.2): F6's question.
- **The op container's Vellum legibility**: P2 verifies HQ form-builder rendering of Nova's
  blocks; if Vellum chokes on the container shape, fall back to the closest Vellum-native
  nesting (the fixtures make this decidable at implementation time).
