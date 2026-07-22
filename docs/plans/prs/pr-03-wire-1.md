# PR-03: Wire I — relevancy, op blocks, itemsets, embedded fixtures

> [!WARNING]
> **Execution superseded.** This document is retained as historical evidence and rationale,
> not as an implementation checklist. Execute from the living
> [complex-app roadmap](../complex-app-roadmap.md) and its current slice contracts instead.

## 2026-07-21 rebaseline

Execution of this legacy PR is now split across **S03, S04, and S05**. The verified HQ and
CommCare runtime facts below remain emission evidence; the living slices own activation,
integration boundaries, and acceptance criteria.

- Emit only from UUID-backed, authoritatively validated domain references; resolve current
  table tags and column names at the emission boundary.
- Case-operation binds and blocks preserve the living operation contract, including
  pre-submission snapshot evaluation and an explicitly pinned relationship to Nova's
  existing primary-case and subcase actions.
- Boundary validation is generic rather than media-owned and fails closed on missing,
  foreign-Project, inconsistent, or over-budget lookup resources.
- Before hosted lookup-table push exists, the guard matrix is complete across every public
  surface: local CCZ export may embed validated fixtures, while HQ JSON export and HQ upload
  are rejected through both web and MCP entry points. Later activation must update the
  matrix as one contract rather than route by route.
- Definition and row reads used for a compiled artifact form one consistent snapshot, and
  deterministic row order is `(order, stable row UUID)`.

*Self-contained implementation plan. Depends on PR-01 (vocabulary + checker) and PR-02
(table registry). Reference rationale: `docs/plans/2026-07-06-f1-…` §3.4, `…f4-…` §3.6,
`…f5-…` §3.4. All emission is DOM construction via `elementBuilders.ts` — no string
assembly (house rule, `lib/commcare/CLAUDE.md`).*

**Goal.** Everything wave 1 puts on the wire, in one pass over `lib/commcare`: display
conditions become menu/command relevancy a Web Apps user actually experiences (hidden menu
items), case operations become transaction blocks that HQ and the device both execute,
table-backed selects become real `<itemset>`s, and table data ships inside the local `.ccz`.
Export stays total: the checker (PR-01) is the gate; no emit-time errors.

## Verified contracts this PR relies on (each named at its use site in code)

**Relevancy + instances**
- HQ emits `module_filter` → `relevant` on `<menu>` (gated on app ≥2.20,
  `feature_support.py::enable_module_filtering`) and `form_filter` → `relevant` on that
  form's `<command>` (`suite_xml/sections/menus.py::MenuContributor._generate_menu` /
  `::_get_commands`). Form filters interpolate `#case` against the session-selected case
  (`xpath.py::interpolate_xpath`); module filters interpolate with NO case and hard-reject
  `#case`/`#parent`/`#host` (`xpath.py::_ensure_no_case_references`).
- Instances are NEVER auto-injected at menu evaluation: scope = the command's entry's
  declared instances ∪ menus' declared instances, lazily initialized
  (`commcare-core/.../session/CommCareSession.java::getEvaluationContext`,
  `InstanceUtils.getLimitedInstances`); referenced-but-undeclared →
  `XPathMissingInstanceException`. HQ places menu-relevancy instances as `<instance>`
  CHILDREN of `<menu>` on ≥2.54 (`post_process/instances.py::_add_menu_instances`,
  `feature_support.py::supports_menu_instances`) and command-relevancy instances on the
  form's `<entry>` (`::_relevancy_xpaths_by_command` → `_get_all_xpaths_for_entry`).
- The runtime parses `relevant` on `<menu>` and per-`<command>`, and `<instance>` children
  under `<menu>` (`commcare-core/.../xml/MenuParser.java::parse`); malformed expressions
  fail at INSTALL. A throwing relevancy at render takes down the WHOLE menu screen with a
  user-visible error (`MenuLoader.getMenuDisplayables` catch → `MenuScreen.init` throw) —
  why emission is checker-gated and instance declaration is this PR's job, not a runtime
  hope.
- CCHQ fixtures to verify against: `tests/data/suite/module-filter.xml`,
  `module-filter-user.xml` + `module-filter-user-entry.xml`,
  `fixture-to-case-selection-with-form-filtering.xml`, and
  `test_suite_filters.py::test_form_filter` — which sets `form.form_filter = "./edd =
  '123'"` and pins DOT-interpolation to the session-case path (no `#case` literal appears
  in that test; it proves the same interpolation seam Nova's `#case` projection rides).
  **No HQ fixture pins the menu-child-`<instance>` shape** (HQ's instance tests run at
  2.20) — the parser is the authority; pin Nova's own fixtures.

**Case-op blocks**
- HQ's render pipeline PRESERVES hand-authored case blocks: `FormBase.render_xform` wraps
  the stored source; `xform.py::XForm._create_casexml` only APPENDS FormActions-driven
  blocks; the sole collision guard reads the DIRECT `/data/case` child
  (`xform.py::XForm.case_node`) and fires only when HQ itself generates a non-empty block.
  Ops therefore ride the XForm SOURCE on BOTH export paths, at nested container paths,
  never at bare `/data/case`.
- The server applies per-block actions in FIXED order create→update→close→index regardless
  of XML child order (`casexml/.../parser.py::CaseUpdate.__init__`,
  `update_strategy.py::_apply_case_update`); the client applies DOCUMENT order
  (`CaseXmlParser.parse`). Emitting children in the server's order makes both runtimes
  provably agree — the canonical child order is a FIXED rule.
- Every block MUST carry `@case_id` — and the failure mode is worse than an error: a case
  block WITHOUT a case id is **silently skipped server-side** (never extracted —
  `casexml/apps/case/xform.py::has_case_id` gates `_extract_case_blocks`; the write
  vanishes with no signal). The parser-side raise exists only for malformed ids
  (`parser.py::CaseUpdate.v2_case_id_from` → `CaseGenerationException`). The emitter
  therefore guarantees `@case_id` on every block structurally. `@date_modified` ←
  `/data/meta/timeEnd`, `@user_id` ← `/data/meta/userID` (meta exists post-render on both
  paths; source-level binds referencing it are the Vellum-verified pattern).
- **The NPE guard (FIXED emitter rule):** an index-only block whose own `@case_id` is
  locally absent NPEs the client (`CaseXmlParser.parse` index arm →
  `loadCase(errorIfMissing=false)` → `indexCase` unguarded deref; no upstream guard —
  failfast `DataModelPullParser`). Any non-create op carrying `links` therefore ALWAYS also
  emits `<update/>` (its writes, or empty) BEFORE `<index>` — the update arm runs
  `loadCase(errorIfMissing=true)` and fails with the clean readable error instead. An empty
  `<update/>` is a no-op on both runtimes (verified both directions).
- Create accepts ONLY `case_type`/`case_name`/`owner_id` children (client rejects extras);
  extra create-time writes emit as the sibling `<update>`. Empty `<index>` target removes
  the index (both runtimes). Rename/re-type emit as `case_name`/`case_type` children of
  `<update>` — client `updateCase` maps them to setName/setTypeId, server
  `casexml/.../parser.py::CaseActionBase.V2_PROPERTY_MAPPING` to name/type (verified
  agreement; `category`/`state` DIVERGE and stay unconstructible per PR-01).
- Id mechanics (the Vellum split, `Vellum/src/saveToCase.js::getBindList/getSetValues`):
  creates OUTSIDE repeats seed `@case_id` via `<setvalue event="xforms-ready">`; creates
  under `forEach` use a bind-calculate over the per-instance path. `target.idFrom` points
  the setvalue/bind at the authored field's path instead of a `uuid()` literal; `id-of(op)`
  expressions compile to the op's `…/case/@case_id` path (readable on both runtimes).
- Fixtures to pin: `~/code/Vellum/tests/static/saveToCase/*.xml` (canonical block+bind
  shapes) and the ACA memo's m2-f0 production form as the integration reference.

**Itemsets + embedded fixtures**
- The itemset contract (`commcare-core/.../XFormParser.java::parseItemset`,
  `ItemSetParsingUtils`): `nodeset` required and must parse as a PATH (predicates allowed);
  `<label ref>` required (fixture-relative path or `jr:itext`); `<copy>` OR `<value>`
  required (`<value ref>` must be a path — the parser does NOT reject predicates on
  label/value refs, but Nova emits the canonical predicate-free relative refs); literal
  `<item>`s + `<itemset>` together is a parse error; choices re-evaluate when the prompt
  rebuilds (`ItemSetUtils.populateDynamicChoices`) — which is what makes PR-01's
  `field`-Term answer-dependent filters wire-viable.
- Suite-embedded fixture data installs into the SAME storage instance resolution reads:
  `SuiteParser` (case `"fixture"`) → `FixtureXmlParser` into platform fixture storage,
  overwritten on app upgrade; a fixture element with NO `user_id` attribute stores GLOBAL
  (`FixtureXmlParser::setupInstance`, `SandboxUtils.loadFixture/loadAppFixture`). HQ never
  emits this shape for item-lists (`Application.create_all_files` ships no fixture data;
  the only suite fixture is the demo `user-groups` stub) — the parser is the authority;
  pin Nova fixtures.
- Body parity rule (FIXED — scope precise): parity covers the INNER content —
  `<{tag}_list><{tag}><col>value</col>…` with rows in order — which is what compiled XPaths
  navigate; HQ builds the row element in `ItemListsProvider.to_xml` and the
  `<fixture>`/`<{tag}_list>` wrappers in `::_get_fixture_element`. The WRAPPERS deliberately
  differ: HQ's restore-served `<fixture>` always carries `user_id` (and `indexed="true"` for
  indexed tables); Nova's suite-embedded `<fixture>` carries NEITHER — no `user_id` (it must
  store GLOBAL, `FixtureXmlParser::setupInstance` keys global on the absent attribute) and
  no `indexed` attr (`SuiteParser` has no `<schema>` handling, so embedded fixtures are
  non-indexed by design). Same inner bytes, path-identical XPaths, whichever delivery.
- Instance/storage ids are independent exact-match keys: `instance('X')` binds a declared
  `<instance id="X" src="jr://fixture/Y">`; `Y` (substring after the last `/`) must equal
  the delivered fixture's id (`CommCareInstanceInitializer::loadFixtureRoot`,
  `VirtualInstances.getReferenceId`). Nova convention: both = `item-list:<tag>`.

**HQ JSON**
- HQ regenerates its own suite from the app JSON: display conditions must ALSO project into
  `module_filter`/`form_filter` on the module/form shells. Selected-case refs emit as
  `#case/<prop>` hashtags (HQ interpolates against ITS datum naming); everything else emits
  fully-expanded instance paths. The projected `module_filter` must contain no `#case`/
  `#parent`/`#host` literal AND no bare-dot case shorthand —
  `_ensure_no_case_references` rejects `DOT_INTERPOLATE_PATTERN` matches too; the emitter
  guarantees dot-free module filters and the tests pin it. Form-level `case-count` in
  forms-first modules never reaches this projection — PR-01's admissibility matrix rejects
  it at construction (HQ's `xpath_references_case` post-interpolation check would otherwise
  hard-fail suite generation there).

## Build

1. **Relevancy emission** (`compiler.ts` + a new `suite/displayConditions.ts`):
   `relevant` attrs on `el("menu", …)` / `el("command", …)` via
   `effectiveDisplayConditionForEmission` (PR-01) and a display-condition anchor variant of
   `predicate/caseListFilterEmitter.ts` — form-level `prop` terms anchor at the absolute
   session-case path (`instance('casedb')/casedb/case[@case_id=instance('commcaresession')/
   session/data/<datum>]/<prop>` with Nova's own datum id); `case-count` lowers to the
   casedb scan; `table-lookup` to the item-list path. Menu instances as `<instance>`
   children (via `collectPredicateInstances`/`collectExpressionInstances` +
   `instanceSourceFor` — the ValueExpression arms `case-count`/`table-lookup` surface
   through the EXPRESSION collector, not the Term-only `addTermInstance`); form-condition
   instances onto that form's entry (`session.ts::accumulateCaseLoadingInstances` seam).
   The caseListOnly browse command inherits the menu condition (no separate slot).
2. **Op-block renderer** (`xform/caseOps.ts`, called from `buildXForm` so blocks live in
   the SOURCE on both paths — deliberately NOT the compiler-injected `addCaseBlocks` path,
   which stays FormActions/session-case-only): container element per op under a reserved
   parent; cx2-namespaced `<case>` with the canonical child order; the NPE guard; id
   setvalue/bind mechanics incl. `idFrom` + `id-of`; `condition` → container `relevant`
   bind; per-write `condition` → property-node `relevant` bind (absent node ⇒ no
   overwrite — mirrors `XFormCaseBlock.add_case_updates`); `forEach` splice under the
   repeat template (reuse the `repeat_context` walk of `caseBlocks.ts`); owner default =
   meta userID bind when a CREATE op's `owner` is absent — update ops emit `owner_id` ONLY
   when `owner` is explicitly set (it means ownership transfer; an absent owner on update
   emits nothing, or every edit would silently reassign the case to the submitter);
   instance accumulation for op expressions.
3. **Itemset emission** (`xform/builder.ts::buildLeafControl` select branch):
   `options_source` → `<itemset>` per the contract (filter predicate compiled into the
   nodeset; label/value as fixture-relative column refs; model `<instance>` declaration);
   inline `<item>`s unchanged when no source.
4. **Embedded fixtures** (`compiler.ts`): one global `<fixture id="item-list:<tag>">` per
   REFERENCED table, body per the parity rule, placed where `SuiteParser` accepts it.
   **Table data reaches the compiler as a CALLER-RESOLVED input** — `compileCcz` stays
   synchronous, client-safe, and total, and `lib/commcare` imports nothing from
   `lib/db`/`lib/case-store`: a new `opts.tables` (snapshot + rows per referenced tableId,
   the exact `opts.assets` media pattern) is resolved by the compile route's prepare step
   (`app/api/compile/prepareCompileRequest.ts`) via PR-02's gated read surface, and the
   fuzz suites construct it directly. (Ownership boundary with PR-01: the switch ARMS —
   `instanceSourceFor`'s `item-list:`/`jr://fixture/` entry, the expression-collector
   entries for `table-lookup`/`column`, the `#table/` expansion-table entry — land in
   PR-01; THIS PR adds the orchestration/placement call sites and **lifts PR-01's
   activation gates** (`FIXTURE_REFERENCE_NOT_MODELED` narrowing for known tags +
   `TABLE_EMISSION_NOT_ACTIVE`) in the same PR that makes the wire emittable, preserving
   the total-emitter invariant across merges.)
5. **HQ JSON projection** (`hqShells.ts` family): `module_filter`/`form_filter` per the
   contract above. **Build-spec bump (decided now):** Nova stamps `2.53.0` today
   (`hqShells.ts::applicationShell`) — this PR bumps it to `2.54.0`, satisfying both the
   2.20 `enable_module_filtering` gate AND the 2.54 `supports_menu_instances` gate this
   doc's own contracts cite (below 2.54, HQ would route menu-relevancy instances onto
   entries instead — a shape divergence Nova avoids by moving both paths to the same
   floor). One-line comment at the stamp naming both gates.
6. **Oracles + fuzz**: suite oracle accepts menu/command `relevant` and resolves their
   `instance()` refs against the runtime's EXACT scopes — menu relevancy → that menu's
   declared instances; command relevancy → the command's entry's instances ∪ instances of
   menus whose OWN id equals the command id (the runtime unions BY MENU ID — submenus —
   not the containing menu; mirror `CommCareSession.getEvaluationContext`, or the oracle
   passes emissions that crash on device) — and accepts `<fixture>` data blocks; XForm
   oracle accepts well-formed itemsets (still rejects items+itemset); binding-resolution
   oracle resolves `instance('item-list:*')` against declared model instances. Fuzz: grow
   BOTH generators — `blueprintDocArbitrary` (XForm + binding-resolution suites) AND
   `suiteDocArbitrary` (the suite-oracle fuzz, which is the one exercising menu/command
   relevancy + embedded fixtures) — with display conditions, ops, and options_source.
7. **Wave-1 upload guard** (interim, removed by PR-11): the HQ-upload route's OWN boundary
   gate — `app/api/commcare/upload/route.ts`'s `collectBoundaryViolations` call (the route
   never touches `prepareCompileRequest.ts`, which serves only the two compile/export
   routes and must NOT gain this rejection — the `.ccz` path embeds the data and stays
   unaffected) — REJECTS an app referencing lookup tables with a person-readable message
   ("this app uses lookup tables; pushing table data to CommCare HQ ships in a later
   release — until then the uploaded app would crash in Web Apps with a missing-fixture
   error"). Implement it as a named exported check —
   `rejectTableReferencingUploads` (`HQ_UPLOAD_TABLES_NOT_PUSHED` message constant) — so
   PR-11's tables-push driver has a single greppable symbol to delete when it makes the
   push real.

## Tests / acceptance

- Nova fixture set pinned per surface: menu relevancy + menu instances (parser-authority
  note in the fixture header), command relevancy + entry instances, an op form matching the
  Vellum saveToCase bind/setvalue shapes, an itemset select, an embedded fixture body
  byte-compared against a hand-built `ItemListsProvider`-shape sample.
- The CCHQ fixture comparisons named above run as SHAPE assertions with this recipe: for
  each pinned CCHQ fixture, a Nova blueprint fixture reproduces the equivalent config, and
  the test asserts (1) `relevant` attribute presence + expression shape on the same
  elements, (2) `instance()` ids referenced and their declaration PLACEMENT (menu child vs
  entry), (3) group/command/menu structure. Datum NAMING is excluded (Nova's session datum
  ids legitimately differ from HQ's). Byte-exact comparison is used only for
  Nova-vs-Nova snapshot fixtures, never against HQ files.
- Emitter fuzz (XForm + suite + binding-resolution) green over the grown arbitraries —
  totality proof that no valid doc hits an emit-time error.
- A compiled `.ccz` with all wave-1 features installs and runs in a local formplayer smoke
  (manual acceptance note in the PR description; automated if the harness allows).
- `lint/typecheck/test` + `test:leaks` on touched tests.

## Non-goals

Preview execution (PR-04), UI (PR-05), SA/MCP/docs (PR-06), tiles (PR-07 — detail
emission untouched here beyond existing columns), case attachments (PR-08), usercase/
locations/automations emission and the HQ push of table data (PR-11 — which also REMOVES
this PR's wave-1 upload guard, Build §7, in the same PR that makes the push real).

## Open choices (implementer)

- Op container naming: op `id` under one reserved parent group vs `__nova_op_<id>` flat —
  pick what HQ's form builder renders most legibly (check `XForm.get_questions`' `/case/`
  path handling with a real upload) and satisfy the reserved-prefix + XML-name rules.
- Fixture-block position inside suite.xml (anywhere `SuiteParser` accepts; pick one, pin it).
- Itemset label: fixture-path label (recommended — single-language today, matches the
  Vellum canonical) vs itext indirection.
