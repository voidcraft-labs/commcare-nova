# PR-03: Wire I — relevancy, op blocks, itemsets, embedded fixtures

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
  `test_suite_filters.py::test_form_filter`'s inline `#case` expectation. **No HQ fixture
  pins the menu-child-`<instance>` shape** (HQ's instance tests run at 2.20) — the parser
  is the authority; pin Nova's own fixtures.

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
- Every block requires `@case_id` (server `CaseGenerationException` via
  `parser.py::has_case_id`); `@date_modified` ← `/data/meta/timeEnd`, `@user_id` ←
  `/data/meta/userID` (meta exists post-render on both paths; source-level binds referencing
  it are the Vellum-verified pattern).
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
  `KNOWN_PROPERTIES` to name/type (verified agreement; `category`/`state` DIVERGE and stay
  unconstructible per PR-01).
- Id mechanics (the Vellum split, `Vellum/src/saveToCase.js::getBindList/getSetValues`):
  creates OUTSIDE repeats seed `@case_id` via `<setvalue event="xforms-ready">`; creates
  under `forEach` use a bind-calculate over the per-instance path. `target.idFrom` points
  the setvalue/bind at the authored field's path instead of a `uuid()` literal; `id-of(op)`
  expressions compile to the op's `…/case/@case_id` path (readable on both runtimes).
- Fixtures to pin: `~/code/Vellum/tests/static/saveToCase/*.xml` (canonical block+bind
  shapes) and the ACA memo's m2-f0 production form as the integration reference.

**Itemsets + embedded fixtures**
- The itemset contract (`commcare-core/.../XFormParser.java::parseItemset`,
  `ItemSetParsingUtils`): `nodeset` required and must parse as a PATH (predicates allowed
  in the nodeset ONLY); `<label ref>` required (fixture-relative path or `jr:itext`);
  `<value ref>` required, predicate-free; literal `<item>`s + `<itemset>` together is a
  parse error; choices re-evaluate when the prompt rebuilds
  (`ItemSetUtils.populateDynamicChoices`) — which is what makes PR-01's `field`-Term
  answer-dependent filters wire-viable.
- Suite-embedded fixture data installs into the SAME storage instance resolution reads:
  `SuiteParser` (case `"fixture"`) → `FixtureXmlParser` into platform fixture storage,
  overwritten on app upgrade; a fixture element with NO `user_id` attribute stores GLOBAL
  (`FixtureXmlParser::setupInstance`, `SandboxUtils.loadFixture/loadAppFixture`). HQ never
  emits this shape for item-lists (`Application.create_all_files` ships no fixture data;
  the only suite fixture is the demo `user-groups` stub) — the parser is the authority;
  pin Nova fixtures.
- Body parity rule (FIXED): Nova's emitted fixture body must byte-match what HQ's
  `ItemListsProvider.to_xml` will serve for the same table after a PR-11 push —
  `<fixture id="item-list:{tag}"><{tag}_list><{tag}><col>value</col>…` with rows in order —
  so compiled XPaths work identically whichever path delivered the data.
- Instance/storage ids are independent exact-match keys: `instance('X')` binds a declared
  `<instance id="X" src="jr://fixture/Y">`; `Y` (substring after the last `/`) must equal
  the delivered fixture's id (`CommCareInstanceInitializer::loadFixtureRoot`,
  `VirtualInstances.getReferenceId`). Nova convention: both = `item-list:<tag>`.

**HQ JSON**
- HQ regenerates its own suite from the app JSON: display conditions must ALSO project into
  `module_filter`/`form_filter` on the module/form shells. Selected-case refs emit as
  `#case/<prop>` hashtags (HQ interpolates against ITS datum naming); everything else emits
  fully-expanded instance paths (no `#case` literal → `_ensure_no_case_references` passes).

## Build

1. **Relevancy emission** (`compiler.ts` + a new `suite/displayConditions.ts`):
   `relevant` attrs on `el("menu", …)` / `el("command", …)` via
   `effectiveDisplayConditionForEmission` (PR-01) and a display-condition anchor variant of
   `predicate/caseListFilterEmitter.ts` — form-level `prop` terms anchor at the absolute
   session-case path (`instance('casedb')/casedb/case[@case_id=instance('commcaresession')/
   session/data/<datum>]/<prop>` with Nova's own datum id); `case-count` lowers to the
   casedb scan; `table-lookup` to the item-list path. Menu instances as `<instance>`
   children (via `collectPredicateInstances` + `instanceSourceFor`); form-condition
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
   meta userID bind when the op's `owner` is absent; instance accumulation for op
   expressions.
3. **Itemset emission** (`xform/builder.ts::buildLeafControl` select branch):
   `options_source` → `<itemset>` per the contract (filter predicate compiled into the
   nodeset; label/value as fixture-relative column refs; model `<instance>` declaration);
   inline `<item>`s unchanged when no source.
4. **Embedded fixtures** (`compiler.ts`): one global `<fixture id="item-list:<tag>">` per
   REFERENCED table (registry + rows read at compile), body per the parity rule, placed
   where `SuiteParser` accepts it. (Ownership boundary with PR-01: the switch ARMS —
   `instanceSourceFor`'s `item-list:`/`jr://fixture/` entry, `addTermInstance`'s
   `table-lookup`/`column` entries, the `#table/` expansion-table entry — land in PR-01;
   THIS PR adds the orchestration/placement call sites and **lifts PR-01's activation
   gates** (`FIXTURE_REFERENCE_NOT_MODELED` narrowing for known tags +
   `TABLE_EMISSION_NOT_ACTIVE`) in the same PR that makes the wire emittable, preserving
   the total-emitter invariant across merges.)
5. **HQ JSON projection** (`hqShells.ts` family): `module_filter`/`form_filter` per the
   contract above; verify and cite where Nova stamps the app `build_spec` ≥ 2.20 (the
   `enable_module_filtering` gate) — if absent, set it here with a comment naming the gate.
6. **Oracles + fuzz**: suite oracle accepts menu/command `relevant` and resolves their
   `instance()` refs against the correct scopes (menu → menu-declared; command → its
   entry's ∪ menus') and accepts `<fixture>` data blocks; XForm oracle accepts well-formed
   itemsets (still rejects items+itemset); binding-resolution oracle resolves
   `instance('item-list:*')` against declared model instances; `blueprintDocArbitrary`
   grows display conditions, ops, and options_source so all fuzz suites exercise the new
   emission.

## Tests / acceptance

- Nova fixture set pinned per surface: menu relevancy + menu instances (parser-authority
  note in the fixture header), command relevancy + entry instances, an op form matching the
  Vellum saveToCase bind/setvalue shapes, an itemset select, an embedded fixture body
  byte-compared against a hand-built `ItemListsProvider`-shape sample.
- The CCHQ fixture comparisons named above run as assertions (shape, not bytes, where HQ
  formats differ).
- Emitter fuzz (XForm + suite + binding-resolution) green over the grown arbitraries —
  totality proof that no valid doc hits an emit-time error.
- A compiled `.ccz` with all wave-1 features installs and runs in a local formplayer smoke
  (manual acceptance note in the PR description; automated if the harness allows).
- `lint/typecheck/test` + `test:leaks` on touched tests.

## Non-goals

Preview execution (PR-04), UI (PR-05), SA/MCP/docs (PR-06), tiles (PR-07 — detail
emission untouched here beyond existing columns), case attachments (PR-08), usercase/
locations/automations emission and the HQ push of table data (PR-11).

## Open choices (implementer)

- Op container naming: op `id` under one reserved parent group vs `__nova_op_<id>` flat —
  pick what HQ's form builder renders most legibly (check `XForm.get_questions`' `/case/`
  path handling with a real upload) and satisfy the reserved-prefix + XML-name rules.
- Fixture-block position inside suite.xml (anywhere `SuiteParser` accepts; pick one, pin it).
- Itemset label: fixture-path label (recommended — single-language today, matches the
  Vellum canonical) vs itext indirection.
