# PR-13: Navigation — sections, nesting, reuse, chaining hardening

*Self-contained implementation plan. Reference rationale: `docs/plans/2026-07-06-f7-navigation-workflow.md`
§2–3. Scope rulings in `docs/plans/2026-07-06-pr-execution-plan.md` apply. Depends on PR-01
(display-condition slots + Predicate machinery) **and PR-03** (this PR's nesting/reuse work
builds on PR-03's menu/command relevancy emission machinery — the AND-merge for flattened
modules and linked-form display conditions compose with it); independent of wave 2 — a
second implementer can run this alongside PR-09–12 once PR-03 lands.*

**Goal.** F7 slice A in one PR: first-class **sections/steps** on forms (projection-only),
**menu nesting** (submodules + flatten-into-parent), **Nova-native form reuse** (linked forms
emitting CCHQ's duplicated-entry wire shape without shadow models), and **chaining hardening**
(validator rules + SA guidance derived from verified runtime failure mechanics).

## What the user gets

Long forms present as steps with progress in the preview (optionally on-device); modules nest
one level as submenus or flatten into their parent; one form appears under several modules
without copies; form links that would strand users at runtime are rejected at authoring time.

## Verified contracts this PR relies on (do not re-derive; cite by these names)

- **No wire notion of sections/steps exists** — only the XForms `<group>` (+
  `appearance="field-list"` renders multiple questions on one screen). Verified by negative
  sweeps over `commcare-hq/.../app_manager/xml_models.py`, `models.py::FormBase`, `xform.py`.
  Sections are therefore a Nova-only projection.
- **EOF workflows**: six constants (`const.py::WORKFLOW_*`); `WORKFLOW_DEFAULT` emits **no
  `<stack>` at all**; `root` = empty `<create>` (`allow_empty_frame`); `parent_module`
  recurses the root module's frame children; **`module` is parent-aware** — for a module
  with a parent, `_frame_children_for_module` FIRST recurses into the parent
  (`if module.root_module: frame_children.extend(…root_module…)`) and then appends the
  module's own command, because a one-command frame naming a nested submenu is unreplayable
  (the runtime only offers a submenu where `currentMenuId == menu.root` —
  `MenuLoader.addUnaddedMenu`; an unmatched frame step strands the user at the root menu,
  `MenuSessionFactory::rebuildSessionFromFrame`). For a top-level module it degenerates to
  the one-command frame (`workflow.py::_get_static_stack_frame` /
  `::_frame_children_for_module`). Nova's `postSubmit` maps 1:1 (`app_home`↔`default`); the
  reserved internal arms `root`/`parent_module` activate here.
- **Form links — the true multi-frame semantics (NOT first-true-wins):** HQ guards each
  link frame only by its OWN xpath (`workflow.py::_get_link_frame`); at runtime EVERY true
  `<create if>` pushes a frame (`CommCareSession::executeStackOperations` →
  `pushNewFrame` → `frameStack.push`), the LAST-pushed frame is entered
  (`finishAndPop` → `frameStack.pop()`), and earlier true frames remain PENDING —
  snapshot-captured, firing after later form completions or wiped by `cleanStack`. Only
  the fallback frame carries `and(not(c1), not(c2)…)`. Nova therefore emits
  **mutually-exclusive guards by construction** (§4) so exactly one frame ever pushes.
  Latent HQ bug: `const.py::WORKFLOW_FALLBACK_OPTIONS` is `None` (a `.remove()` return
  value), so HQ never validates the fallback — Nova validates its own.
- **Menu nesting**: `root_module_id` → `<menu id="m<child>" root="m<parent>">`
  (`menus.py::MenuContributor._generate_menu`; `xml_models.py::MenuMixin.root`). `put_in_root`
  collapses the child's menu id to the parent's (`id_strings.py::menu_id`), and same-id
  `<menu>` elements concatenate their commands (menus.py module docstring). The parent's
  `module_filter` is **AND-merged** into a flattened child's relevancy
  (`_generate_menu`: `XPath.and_(child, parent)`). Effectively one nesting tier; training
  modules use reserved root `'training-root'`.
- **Shadow modules are wire-level duplication, not reference**: a shadow emits its own
  `<entry>` per source form — same form `xmlns`, shadow-scoped command ids
  `m<shadowIdx>-f<n>` (`entries.py::EntriesHelper.entry_for_module` iterates
  `module.get_suite_forms()`; `id_strings.py::form_command` uses the shadow's index) — plus
  its own menu/details/filter. v2 current, v1 deprecated (`toggles::V1_SHADOW_MODULES`
  TAG_DEPRECATED); gated `APP_BUILDER_SHADOW_MODULES` (TAG_FROZEN). Nova emits the same wire
  shape from a plain reference — no shadow authoring objects.
- **Chaining fragility is verified mechanics** (the reason sections beat chains):
  web-apps navigation is a stateless client-held selections array replayed from a reset
  session (`formplayer/.../MenuSession.java::resetSession`; back = truncate + full replay in
  `MenuSessionRunnerService`); a pending chained frame is **wiped wholesale** when a
  re-selected datum diverges from its snapshot
  (`CommCareSession.java::finishAndPop/cleanStack`; `SessionFrame.java::isSnapshotIncompatible`
  → `frameStack.removeAllElements()`); there is **no lease/timestamp/rollback primitive**
  anywhere in the frame machinery (greps; only `ScheduledTasks.java::purge`'s 7-day session
  sweep) — a closed tab permanently strands mid-flow case writes.
- **No datum re-prompt during chaining**: a stack-op-launched form's datums must be carried
  by the op and the case must still be in the target entry's nodeset, else a logged
  reconstruction failure (`MenuSessionFactory.java::rebuildSessionFromFrame` →
  `logStepNotInEntityScreenError`); auto-select rescues only opt-in single-match datums
  (`EntityScreen.java::shouldAutoSelect`: `isAutoSelectEnabled() && references.size() == 1`).
- **`cc-auto-advance-menu`**: a single *visible* choice self-selects
  (`MenuScreen.java::handleAutoMenuAdvance`) and the advanced menu is omitted from the
  persistent menu/breadcrumb (`PersistentMenuHelper.kt`) — a documented sharp edge for SA
  guidance, not something this PR changes.

## Build

### 1. Sections/steps (`lib/domain`, `lib/preview`, `lib/commcare`)

- `formSchema.sections?: Array<{ uuid: Uuid, title: string, startFieldUuid: Uuid }>` — a
  contiguous partition of the form's **top-level** field sequence, keyed by each section's
  first field. No nesting; membership is derived from field order, never stored. **The design
  fence: sections carry NO expression slots, ever** — the moment a section wants a condition
  or repetition, it is a `group`/`repeat` and must be one. The fence is structural (the
  schema has no such slots) and stays that way.
- Mutations: `addSection`/`updateSection`/`removeSection` ONLY — **there is no
  `moveSection`**, deliberately: sections carry no stored order (membership and sequence
  derive entirely from field order), so "reordering a section" is moving its FIELDS — the
  existing field-move gestures — never a section mutation. Reference-slot registry entry +
  `extractFormEdges` arm for `startFieldUuid` (uuid edge). Deleting a section's first field
  re-anchors the section to the next field in it; an emptied section dissolves
  (reducer-total, no gate dependency).
- **The head rule (partition totality):** when a form has any sections, the FIRST section
  must anchor the form's first top-level field — gating soundness
  (`SECTION_HEAD_UNANCHORED`, + class row + repair judgment), so the partition is total by
  construction (no undefined pre-anchor head fields in step numbering or on-device
  wrapping). The UI satisfies it automatically: adding a form's first section anchors it at
  the first field.
- Preview: step-wise rendering — one section per screen, progress ("Step 2 of 5 — <title>"),
  per-section validation surfacing (a step blocks advance while its fields hold validation
  errors, mirroring the engine's existing per-field state); edit mode shows section rails on
  the canvas (all fields visible, house rule). State model only — no DOM tests.
- Emission: default is **preview-only chrome** (zero wire change — `sections` never reaches
  the emitters). Opt-in `formSchema.sectionsOnDevice?: boolean`: each section wraps its
  fields in `<group appearance="field-list">` with the section title as the group label —
  the verified single-screen-per-group shape. Since sections partition top-level fields, a
  section boundary can never split a group/repeat subtree by construction.
- Validator: `SECTION_ANCHOR_UNRESOLVED` (startFieldUuid must resolve to a top-level field
  of the form), `SECTION_DUPLICATE_ANCHOR` (two sections may not share a first field), and
  `SECTION_HEAD_UNANCHORED` (the head rule above) — all gating soundness + repair judgments
  (`VALIDITY_CLASS_BY_CODE` rows + `legacyFindingRepairs` entries, the pinned tests
  enforce).

### 2. Menu nesting (`lib/domain`, `lib/commcare`)

- `moduleSchema.parentModuleUuid?: Uuid` (submenu) + `moduleSchema.flattenIntoParent?:
  boolean` (the intent-named `put_in_root`). One tier: a module with a parent cannot itself
  be a parent (gating soundness).
- Suite emission (`compiler.ts` menu construction from PR-03): nested module →
  `root` attribute = parent's menu id; flattened module → child's menu **takes the parent's
  id** (same-id concatenation lands its commands in the parent's menu); flattened child's
  command relevancy = `AND(child.displayCondition, parent.displayCondition)` via
  `effectiveDisplayConditionForEmission`, mirroring HQ's verified `module_filter` merge.
  HQ-JSON projection: `root_module_id` / `put_in_root` on the module shell.
- `postSubmit` internal arms activate: `root` emits the empty-`<create>` frame;
  `parent_module` emits the parent's command(+datum) frame; and the EXISTING `module` arm
  becomes parent-aware — for a form in a nested module, `derivePostSubmitStack` emits the
  parent's frame children FOLLOWED by the child's command (the verified
  `_frame_children_for_module` recursion; a bare child-command frame strands the user at
  the root menu — contract above). Pin a nested-module `module`-arm fixture beside the
  `root`/`parent_module` ones. Auto-resolution: `module` on a FLATTENED module resolves to
  **`parent_module`** — the parent's menu is where the flattened module's commands actually
  live (HQ's own shape: `menu_id` collapses to the parent, so `_frame_children_for_module`
  lands on the parent's menu; the old `lib/commcare/CLAUDE.md` §put_in_root note said
  `module` → `root`, written before "flatten requires a parent" existed — REWRITE that
  note, don't just retire it). `parent_module` as an AUTHORED destination requires the
  module to have a parent (gating rule — the reachable configuration; the old stub's
  "flattened-parent" case is unconstructible under one-tier + flatten-requires-a-parent
  and is dropped, not implemented).
- Suite oracle: menu `root` must resolve to an existing menu id (or `'root'`); same-id menus
  legal; command-id uniqueness still holds per menu after concatenation.
- Validator: one-tier rule; flatten requires a parent; parent/child case-type constraint —
  **implementer reads HQ's child-module case-type rules first** (`models.py` child module
  validation) and enforces the subset Nova's parent-select-less model needs (open choice
  below).

### 3. Form reuse — linked forms (`lib/domain`, `lib/commcare`, `lib/preview`)

- `moduleSchema.linkedForms?: Array<{ uuid: Uuid, formUuid: Uuid, displayCondition?:
  Predicate }>` — a reference to a real form in another module; the source form is the
  single editing surface (a linked form has no fields of its own, ever).
- Emission: per linked form, a **duplicate `<entry>`** — command id `m<hostIdx>-f<k>` (k
  continues the host's form numbering), `<form>` = the source form's `xmlns`, datums derived
  from the source form's case requirements under the host module (same case type — see
  validator); host menu gets the `<command>` with the link's own display condition (F1
  machinery). The verified shadow-module wire shape, minus the shadow AUTHORING objects.
  **HQ-JSON projection (decided — verified against HQ source):** the two naive projections
  both FAIL on HQ — a duplicate real form entry sharing the source's xmlns trips the
  build-blocking `"duplicate xmlns"` error (`helpers/validators.py::ApplicationValidator.
  _check_forms` counts xmlns over all non-ShadowForm forms), and a plain module's menu
  cannot reference another module's form command (plain-module commands derive solely from
  `module.get_suite_forms()`, `menus.py::_get_commands`). The projection that works is HQ's
  own reuse vocabulary: the emitter projects a host module's `linkedForms` as a **v2
  `ShadowModule`** (`source_module_id` = the source module, `excluded_form_ids` = the
  source's non-linked forms, `root_module_id` = the host, `put_in_root = true` — the
  shadow's commands flatten into the host's menu). This is WIRE vocabulary inside
  `lib/commcare`'s HQ-JSON emitter — no shadow objects enter Nova's domain (the shape rule
  holds: authoring is the reference, the projection is emission detail). Consequence,
  stated: HQ regenerates shadow command ids (`m<shadowIdx>-f<n>`), so local-vs-HQ suite
  agreement for linked forms is **shape-level, not command-id-level** (each path is
  internally consistent; nothing Nova emits cross-references those ids across paths).
- Preview: launching a linked form runs the source form under the host module's context
  (host's case list; same case type).
- Doc semantics: source-form deletion **blocks with references** (the house
  `caseTypeRetirement`-style plan: list the linking modules); reference-slot entry + edges
  for `formUuid`; rename-safety free (uuid reference).
- Validator: host module case type must equal the source form's module case type (v1 rule);
  the source must be a real form (no linking to a link); a form may not be linked into its
  own module; form-type coherence (a case-loading linked form keeps the host case-first
  computation honest — `isCaseFirstModule` counts linked forms' types).

### 4. Chaining hardening (`lib/commcare/validator`, SA prompts, docs)

- **Exclusive-guard emission (fixes Nova's existing form-link emitter):** to make
  "first matching link wins" TRUE on the wire, each link's `if` emits as
  `and(cond_i, not(cond_1), …, not(cond_{i-1}))` — exactly one frame can push, matching the
  fallback's existing `and(not(…))` pattern and eliminating the pending-frame pile-up the
  contract above describes. (HQ's own emission has the pile-up; Nova's is strictly better
  and behaviorally identical when conditions are already exclusive.)
- Form-link rules (all gating soundness + repairs):
  `FORM_LINK_DATUM_INCOMPLETE` — the link's `datums` plus the session-carried datums must
  cover every datum the target entry derives (checkable against `deriveSessionDatums` for
  the target; the runtime never re-prompts — verified above);
  `FORM_LINK_TARGET_FILTER_EXCLUDES` — statically decidable exclusions only: carried case
  type ≠ target module case type (value-level filter analysis is out of scope, stated);
  `FORM_LINK_FALLBACK_INVALID` — the fallback destination must be a valid non-form
  destination for the source form's context (Nova validates what HQ's `None`-bug never did).
- SA guidance (prompts.ts): prefer sections within one form over multi-form chains — cite
  the mechanics (frame wipe on changed selection, no cleanup of stranded mid-flow writes,
  no datum re-prompt); never design stage-flag chains; auto-select is opt-in single-match
  only; `cc-auto-advance-menu` collapses hops out of the breadcrumb (use sparingly).
- Docs: a "how navigation actually behaves" page — what survives back-navigation, what a
  closed tab strands, when a chained form silently loses its pending chain — person-readable
  renderings of the verified facts, plus the sections-vs-chains recommendation.

## Tests / acceptance

- Section partition invariants (anchor resolution, dissolve-on-empty, reorder) as pure state
  tests; preview step-flow state tests (advance blocked on invalid section).
- Emission fixtures pinned: nested menu (`root` attr), flattened menu (id collapse +
  condition AND-merge — compare against HQ `menus.py` outputs for the same shapes), linked
  form (duplicate entry, shared xmlns, host command ids), `root`/`parent_module` stack
  frames (empty-create + parent-frame shapes).
- Suite oracle green on: same-id menus, duplicate xmlns entries, menu-root resolution.
- Validator matrices: one-tier nesting, linked-form type rules, the three form-link rules.
- `npm run lint && npm run typecheck && npm test` clean; emitter fuzz (blueprintDoc
  arbitraries grow sections/nesting/links arms) green.

## Non-goals

Endpoints + smart links (PR-14). Multi-tier nesting. Cross-case-type linked forms.
Value-level filter-exclusion analysis. Persona-aware navigation niceties (wave 2 provides
personas; nothing here requires them).

## Open choices (implementer)

- Parent/child module case-type constraint: read HQ's child-module rules
  (`models.py` root_module validation) first; recommend requiring same-or-no case type in v1
  (Nova has no parent-select), stating the rule in the validator message.
- `sectionsOnDevice` granularity: per-form (as specced) — confirm no per-app appetite before
  widening.
- Section re-anchor vs dissolve on first-field deletion: recommend re-anchor-to-next,
  dissolve when empty (as specced); keep the reducer total either way.
- (The HQ-JSON linked-form projection is DECIDED in §3 — the v2 ShadowModule shape; the
  implementer's residual is pinning an `import_app` + "Make New Version" round-trip test
  over it, not choosing a shape.)
