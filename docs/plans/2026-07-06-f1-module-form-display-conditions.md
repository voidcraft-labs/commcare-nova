# Plan: F1 — Module & form display conditions ("show when")

> **Execution superseded (2026-07-06):** this plan remains the verified-facts + rationale reference; implementation follows the PR plans in `docs/plans/2026-07-06-pr-execution-plan.md` (+ `docs/plans/prs/`), which also carry the owner's scope rulings — several items this plan lists as deferred/excluded are now IN scope there (project-shared tables, authored+referencable create ids, rename/re-type ops, custom location fields, multi-location personas, answer-dependent choice filters, table reads from field expressions, case tiles, case attachments, session endpoints + smart links). Where this plan and the PR plans disagree on scope, the PR plans win.

*Planning pass, 2026-07-06. Seeded by `docs/research/feature-map.md` §F1; evidence anchors
`docs/research/advanced-case-actions.md` (ACA) and `docs/research/commcare-locations.md` (LOC).
Every platform fact below was re-verified against the local checkouts on 2026-07-06
(`~/code/commcare-hq`, `~/code/formplayer`, `~/code/commcare-core`) — the formplayer runtime's
`libs/commcare` submodule was diffed byte-identical to `~/code/commcare-core` for every cited
file, so commcare-core citations ARE the Web Apps runtime.*

**What ships.** An optional, typed **display condition** on every module and every form: a
`Predicate` AST slot (`displayCondition`) that gates whether the menu item shows, authored in
the builder's structural predicate editor, settable by the SA and MCP, executed live in the
preview against a lightweight preview persona, and emitted as suite.xml menu/command
`relevant` (+ the HQ-JSON `module_filter`/`form_filter` projection). Conditions can reference
custom user data, session context (including screen width), case counts, and — for forms in
case-first modules — the selected case's properties.

---

## 1. Verified platform facts + lifecycle citations

Protocol items 1–2. Each fact re-read from source this pass; the fixture set an implementer
must verify against is in §5.4.

| # | Fact | Citation | Lifecycle verdict |
|---|---|---|---|
| 1 | `module_filter` lives on `ModuleBase` (`StringProperty(exclude_if_none=True)`); `form_filter` on `Form` (+ `AdvancedForm`). | `commcare-hq/corehq/apps/app_manager/models.py::ModuleBase` / `::Form` | **Alive.** No toggle, no feature preview (searched `feature_previews.py`, `toggles/`). |
| 2 | Module-filter emission + UI editing gate ONLY on app min-version 2.20. Form filter has no version gate at emission; its UI gate is `not form_has_schedule`, label "Display Condition". | `feature_support.py::CommCareFeatureSupportMixin.enable_module_filtering`; `suite_xml/sections/menus.py::MenuContributor._generate_menu`; `views/modules.py::edit_module_attr`; `views/forms.py` (`allow_form_filtering`); `templates/app_manager/partials/forms/form_filter.html` | **Alive, build-version-gated (≥2.20 / none).** Nova's fixed wire target (max web-apps subset) is far past both gates. |
| 3 | `module_filter` → `relevant` attr on `<menu>`; `form_filter` → `relevant` attr on that form's `<command>` inside the menu. | `menus.py::MenuContributor._generate_menu` / `::_get_commands` | Alive; the two wire slots F1 targets. |
| 4 | Form filters interpolate `#case` → `instance('casedb')/casedb/case[@case_id=instance('commcaresession')/session/data/<case_datum>]`; `#session/` → `instance('commcaresession')/session/`; `#user` → the **usercase** (NOT user data). Module filters interpolate with no case: `#case`/`#parent`/`#host` raise `CaseXPathValidationError`. | `xpath.py::interpolate_xpath`, `::_ensure_no_case_references`, `::UsercaseXPath.case`; `tests/test_suite_filters.py::test_form_filter` | Alive. Custom user data is `session/user/data/<key>` — never `#user`. |
| 5 | A form filter that references a case in a module that doesn't guarantee a selected case is rejected — twice: authoring validator ("filtering without case") and again at suite emission (`CaseXPathValidationError`). | `helpers/validators.py::FormBaseValidator`; `menus.py::_get_commands` | Alive. Nova makes this state unconstructible instead (§3.3). |
| 6 | Instances referenced by a menu relevancy are declared as `<instance>` **children of `<menu>`** on CommCare ≥2.54; command-relevancy instances are routed onto that command's **`<entry>`**. Below 2.54, menu instances fold onto entries. | `suite_xml/post_process/instances.py::InstancesHelper._add_menu_instances` / `::_get_all_xpaths_for_entry` (`_relevancy_xpaths_by_command`); `feature_support.py::supports_menu_instances` | Alive (≥2.54 for menu instances). **Gap:** no HQ suite fixture pins the menu-child-`<instance>` shape (all instance tests run at 2.20); the parser authority is fact 7. |
| 7 | The runtime parses `relevant` on `<menu>` and per-`<command>`, and `<instance>` children under `<menu>`; malformed expressions fail at install/parse. Menus and commands are relevancy-filtered by `MenuLoader`; formplayer serves only the relevant subset. | `commcare-core/src/main/java/org/commcare/xml/MenuParser.java::parse`; `suite/model/Menu.java`; `suite/model/MenuLoader.java::menuIsRelevant` / `::addRelevantCommandEntries`; `formplayer/.../services/MenuSessionRunnerService.java::getNextMenu` → `CommandListResponseBean` | Alive. |
| 8 | Instances are **never auto-injected** at menu evaluation: scope = instances declared on the command's entry ∪ instances declared on menus, lazily populated. Referenced-but-undeclared → `XPathMissingInstanceException`. | `commcare-core/.../session/CommCareSession.java::getEvaluationContext`; `javarosa/.../InstanceUtils.java::getLimitedInstances`; `EvaluationContext.java::resolveReference` | Alive. Drives Nova's instance-placement rule (§5.1). |
| 9 | A throwing relevancy (missing instance, type mismatch, non-boolean result) takes down the **entire menu screen** with a user-visible error — not a silent hide. | `MenuLoader.getMenuDisplayables` catch → `setLoadException`; `MenuScreen.init` → `CommCareSessionException`; formplayer `GlobalDefaultExceptionHandler.handleApplicationError` | Alive. Makes checker-gated, total emission mandatory. |
| 10 | An all-irrelevant menu still displays (empty); no auto-hide, and 0 choices defeats auto-advance. Relevancy is recomputed on every menu render; no re-check at form launch. | `MenuLoader.addUnaddedMenu`; `MenuScreen.handleAutoMenuAdvance`; `MenuSession.getNextScreen`; `CommCareSession.getStillValidEntriesFromMenu` | Alive. Feeds the always-valid verdict (§3.2). |
| 11 | Screen width is real and web-apps-fed: the frontend sends `windowWidth` on every nav request; it lands at `session/context/window_width`. The node is **absent** (not empty) when unsupplied. | `formplayer/.../beans/AuthenticatedRequestBean.java`; `.../services/MenuSessionFactory.java`; `commcare-core/.../session/SessionInstanceBuilder.java::addMetadata` (`addData` drops null) | Alive. `SessionWrapper.windowWidth`'s Javadoc names display conditions as the intended use. |
| 12 | `session/user/data/<key>` is populated from the restore user's properties (open namespace); an absent key is an absent node (comparisons quietly false). | `SessionInstanceBuilder.java::addUserProperties`; `CommCareInstanceInitializer.setupSessionData` | Alive. Nova's `session-user` Term already cites these sites. |
| 13 | `put_in_root` AND-merges the root module's filter into the child menu's relevancy. | `menus.py::_generate_menu` | Alive but **out of F1 scope** — Nova doesn't model `put_in_root` (F7); recorded so the F7 pass inherits it. |

## 2. The shape question (protocol 3)

**CCHQ's authoring shape** is a raw XPath string (`module_filter` / `form_filter`) with
hashtag conventions and no referential knowledge — exactly the stringly surface Nova rejects.

**Nova's shape** is one new optional slot on both entities, in the **Predicate family**:

```ts
// lib/domain/modules.ts::moduleSchema — sibling of caseListConfig
displayCondition: predicateSchema.optional(),
// lib/domain/forms.ts::formSchema — sibling of closeCondition
displayCondition: predicateSchema.optional(),
```

Why Predicate and not the parts-based XPath AST (`lib/domain/xpath`) — this is the fork the
whole implementation hangs on:

1. The charter's own requirement ("enumerate and type the referents; **no raw-XPath escape
   hatches**") indicts the parts model: it is verbatim text with reference leaves — a typed
   carrier for raw XPath, not a typed expression.
2. Every existing module-level condition is already Predicate-typed (`caseListConfig.filter`,
   `caseSearchConfig.searchButtonDisplayCondition`) — and the search-button condition is
   literally a display condition lowering to on-device XPath today.
3. The family already carries F1's whole reference vocabulary: `session-user` (custom user
   data — the #1 gating predicate in the reference apps, ACA memo), `session-context`,
   literals, date arithmetic, and a type checker (`checkPredicate`) that the commit gate and
   every emitter trust.
4. It compiles to all three targets Nova needs — on-device XPath (wire), Postgres SQL (the
   preview's real-data execution), and the card editor renders it valid-by-construction
   (`PredicateCardEditor`).
5. Fact 9: a bad expression detonates the whole menu screen at runtime. A checked, closed AST
   makes that state unrepresentable; a raw-XPath slot merely makes it lintable.

The slot is top-level on both entities (not nested in a config object), so it rides the
existing `updateModule`/`updateForm` clearable patches — key-by-key reducers merge a
concurrent `displayCondition` edit with a concurrent rename, and `null` clears survive the
SSE + Firestore hops (`lib/doc/CLAUDE.md` null-as-delete rule). No new mutation kind.

## 3. Charter closure

### 3.1 What can a condition reference, at each level?

All referents are typed AST nodes; there is no raw-XPath arm anywhere.

| Referent (AST node) | Module condition | Form condition, case-first module | Form condition, forms-first module |
|---|---|---|---|
| Custom user data — `session-user` (open namespace, existing arm) | ✓ | ✓ | ✓ |
| Session context — `session-context`: `userid`, `username`, `deviceid`, `appversion` + **`window_width` (new entry)** | ✓ | ✓ | ✓ |
| Case counts — **`case-count` (new ValueExpression arm)**: open cases of a declared catalog type, optional `where` checked in that type's scope | ✓ | ✓ | ✓ |
| Selected case's properties — `prop` on the module's case type, own properties (no `via` walk in v1) | ✗ (checker error) | ✓ | ✗ (checker error) |
| Literals, `today`/`now`/`date-add` etc. | ✓ | ✓ | ✓ |
| Search-input refs, `when-input-present` | ✗ — no search inputs in menu scope | ✗ | ✗ |
| Usercase (`#user`) | ✗ — F2's usercase modeling; the Predicate family has no usercase term and F1 does not add one | | |
| Lookup tables / fixtures / locations | ✗ — F5 / F3 add the address books and their terms | | |

The two new AST pieces:

- **`case-count`** — `{ kind: "case-count", caseType, where?: Predicate }`. The existing
  `count` arm is a *relational* aggregate anchored at a case row (`count(via, where)`,
  `count(self)` rejected); menu scope has no anchor, so an **anchorless, type-scoped** count
  is a genuine vocabulary gap. Resolves to `number`; booleans compose the normal way
  (`gt(case-count(...), 0)`), with an `anyCases(caseType, where?)` sugar builder. Counts
  **open** cases (matching the case-list nodeset's `[@status='open']` and the soft-close
  doctrine, ACA §3-P6). v1 admits it only in display-condition contexts (the CSQL grammar
  has no absolute count — `filter_dsl.py` recognizes `subcase-count` only in comparisons —
  and widening the case-list-filter context is a later, separate decision).
- **`window_width`** added to `SESSION_CONTEXT_FIELDS`. The enum's own comment documents the
  exclusion rationale as case-search-shaped ("not a stable case-data signal") — correct
  there, wrong for menus: gating menus on width is an observed reference-app pattern and the
  runtime Javadoc's stated purpose (fact 11). Admission is context-gated: display-condition
  contexts accept it; case-search contexts continue to reject. Semantics to preserve
  everywhere: unsupplied width ⇒ node absent ⇒ numeric comparisons false.

### 3.2 Always-valid: can an item become unreachable, and is that a finding?

Three regimes, split by decidability:

- **Statically always-false** (deep simplification of the condition yields `match-none`, via
  the `simplifyForEmission` machinery): **gating soundness finding**,
  `DISPLAY_CONDITION_ALWAYS_FALSE`. "Never show this to anyone" is spelled *delete the item*;
  a provably-false condition is a mistake with zero expressive gain, and Nova can catch what
  HQ cannot. (Statically always-true folds to no-emission via the single-home
  `effectiveDisplayConditionForEmission` helper — a meaningful mid-edit state, never a
  finding, same contract as `effectiveFilterForEmission`.)
- **Dynamically false-for-everyone** (a user-data flag no provisioned user has): undecidable
  from the doc — **permitted, not a finding**. The runtime tolerates it (fact 10: an
  all-hidden menu renders empty, the app keeps working), and the preview persona (§3.3) is
  the surface that makes it visible to the author. Validator findings stay decidable and
  actionable.
- **Malformed/ill-typed conditions** (the class that detonates menus at runtime, fact 9):
  unrepresentable/uncommittable — checker-backed gating findings
  (`MODULE_DISPLAY_CONDITION_TYPE_ERROR` / `FORM_DISPLAY_CONDITION_TYPE_ERROR`), plus the
  structural guarantees (boolean-rooted Predicate; instances always declared by the emitter).

### 3.3 Preview: presenting "hidden for this persona"

A **simple persona, not F2/F3's persona concept** — but built as its substrate:

- `PreviewPersona { username?, userData: Record<string, string>, windowWidth?: number }` in
  the `lib/session` builder-session store (ephemeral, sibling of `PreviewCaseTarget`). A
  small persona editor in the preview shell sets user-data key/values + width presets
  (desktop/tablet/phone). F2 later replaces free-form `userData` with typed user-type
  personas; F3 adds location. Nothing here persists or leaks into the doc.
- **Preview is runtime-faithful by default**: hidden items are hidden (it's the real app).
  A "hidden items (N)" affordance reveals them ghosted, each with a person-readable condition
  summary ("shows when `can_admin` = 'yes'"). Edit mode (builder canvas) is unaffected —
  all modules/forms stay visible with a small condition badge, matching how field-level
  `relevant` behaves (edit shows all; preview evaluates).
- Evaluation (single-semantics rule): (1) rewrite `session-user`/`session-context` terms to
  literals from the persona; (2) constant-fold in TS — fully decides data-independent
  conditions (the common case: user-data flags); (3) any residue (`case-count`, selected-case
  `prop`) evaluates in **one batched server action** through the existing AST→Kysely compiler
  (`lib/case-store/sql`) — data-dependent comparisons only ever run in Postgres, so preview
  and case-store semantics cannot fork. Mirrors runtime nulls: absent user-data key / absent
  width behave as absent nodes (comparisons false).

### 3.4 Wire mapping (verified this pass)

Two emission targets, per `lib/commcare`'s standing split:

- **Local `.ccz` suite**: `relevant` attribute on the module's `<menu>`; per-form `relevant`
  on the `<command>` inside the menu. Instance placement mirrors HQ + the runtime scope rule
  (facts 6, 8): the menu condition's instances (`casedb`, `commcaresession`) emit as
  `<instance>` children of the `<menu>`; a form condition's instances accumulate onto that
  form's `<entry>` (the existing `accumulateCaseLoadingInstances` seam). Selected-case `prop`
  terms lower to the absolute session-case anchor
  `instance('casedb')/casedb/case[@case_id = instance('commcaresession')/session/data/<datum>]/<prop>`
  with Nova's own datum id (Nova owns both sides of the local artifact). `case-count` lowers
  to `count(instance('casedb')/casedb/case[@case_type='T'][@status='open'][<where>])`, the
  same shape as the case-list nodeset (`session.ts::caseLoadingNodeset`).
- **HQ JSON**: project the same conditions into `module_filter` / `form_filter` on the
  module/form shells — HQ regenerates its own suite from these on upload. Selected-case refs
  emit as `#case/<prop>` hashtags (HQ interpolates against its own datum naming — fact 4 —
  which makes Nova independent of HQ's datum ids); everything else emits fully-expanded
  instance paths, which pass interpolation untouched and contain no `#case` literal (fact 4's
  `_ensure_no_case_references` checks the literal string).
- A `caseListOnly` module's browse command is gated by the menu-level condition alone; the
  case-list command gets no separate condition (nothing to author it against).

Nova-side constraints carried by construction rather than HQ's emit-time errors: no case refs
in module conditions (no term admits them, §3.1); form conditions reference the selected case
only when `isCaseFirstModule` holds — the same predicate `commcare-core`'s
`getDataNeededByAllEntries` uses to hoist case selection, i.e. exactly when the runtime
guarantees a case in the session at command-render time (facts 5, 7).

## 4. Sequencing revision (map bet overturned, with reasons)

The map calls F1 "effectively inseparable from F2's app-facing half." **Evidence says
otherwise**: Nova's Predicate family already carries `session-user` — an open-namespace,
XML-name-validated custom-user-data reference, live today in case-list filters, compiling to
`instance('commcaresession')/session/user/data/<field>` on-device and to Postgres for
preview. F1 therefore ships **first and standalone**: conditions on user data are authorable,
emittable, and previewable (the persona supplies ad-hoc values) with zero F2 machinery. What
F2 adds later is the *schema* over that namespace — typed user-data fields, vocabulary
validation + autocomplete, typed personas, provisioning — tightening an open reference the
way the case-type catalog tightened case refs. The map's F2→F1 arrow reverses; F1's persona
+ open-namespace refs become F2's substrate. (Both memos' Fixed constraints are untouched by
this: wire compat verified above; no CCHQ authoring shape inherited; UX not downgraded —
the persona reveal-toggle is additive.)

## 5. Full-stack scope (protocol 4)

### 5.1 Domain (`lib/domain`)
- `displayCondition: predicateSchema.optional()` on `moduleSchema` + `formSchema` (§2).
- `case-count` ValueExpression arm + builders + reduction/simplify coverage (`simplify.ts`
  recursion must descend `case-count.where` like `count.where`).
- `window_width` in `SESSION_CONTEXT_FIELDS` (+ its checker type and the context gating).
- **Display-condition check context**: a `TypeContext` construction
  (`displayConditionContext(doc, module, level)`) enforcing §3.1's table — bare `prop` only
  at form level in case-first modules and only on the module's case type (no `via` in v1);
  no `input`/`when-input-present`; `case-count` admitted; on-device-only match modes;
  `within-distance`/`unwrap-list` rejected. Slot-constraint descriptors flow from the same
  rules so the card editor offers only what the checker accepts (the standing
  `slotConstraints.ts` contract: no second table).
- Reference registry: `ModuleReferenceSlot` + `FormReferenceSlot` entries
  (`kind: "predicate-ast"`, slot ids `module_display_condition` / `form_display_condition`)
  — the `referenceSlots` audit test forces this; exhaustive-switch arms in
  `lib/doc/referenceIndex.ts::extractModuleEdges`/`extractFormEdges` and the rename cascade
  `lib/doc/mutations/referenceRewrites.ts` (compile errors until added).

### 5.2 Doc store + mutations (`lib/doc`)
- No new mutation kind: rides `updateModule`/`updateForm` clearable patches (top-level slot;
  key-by-key merge; `null` clears). Commit gating comes free via `mutationCommitVerdict`.

### 5.3 Validator (`lib/commcare/validator`) + repairs
- New codes (all `soundness`, all `owner(...)` repair judgments — conditions are content):
  `MODULE_DISPLAY_CONDITION_TYPE_ERROR`, `FORM_DISPLAY_CONDITION_TYPE_ERROR` (one per
  checker error, path in `details`, cloning `rules/case-list/filterTypeCheck.ts`), and
  `DISPLAY_CONDITION_ALWAYS_FALSE` (§3.2). Lockstep registration: `errors.ts` union →
  `gate.ts::VALIDITY_CLASS_BY_CODE` row → `scripts/lib/legacyFindingRepairs.ts` judgment
  (the pinned-total test enforces all three).
- Extend `matchModeOnDeviceCompatibility`'s slot list with both new slots (they lower
  on-device; `fuzzy`/`phonetic`/`fuzzy-date` would crash the menu — fact 9).

### 5.4 Emitters + oracle + fixtures (`lib/commcare`)
- Suite: `relevant` attrs on `el("menu", …)` / `el("command", …)` in `compiler.ts`, lowered
  through a display-condition variant of `predicate/caseListFilterEmitter.ts` (new anchor
  model: absolute session-case anchor for form-level `prop`; absolute casedb scan for
  `case-count`); instances via the existing `collectPredicateInstances` +
  `instanceSourceFor`, placed per §3.4; `effectiveDisplayConditionForEmission` as the single
  emit/no-emit home.
- HQ JSON: `module_filter`/`form_filter` on the shells (`hqShells.ts` family), `#case/<prop>`
  hashtags for selected-case refs, expanded paths otherwise. Confirm Nova's stamped HQ app
  build version ≥ 2.20 (fact 2's emission gate).
- `suiteOracle.ts`: accept the new attributes; Category-2 resolution of `instance()` refs in
  menu relevancy against menu-declared instances, and in command relevancy against that
  command's entry instances ∪ menu instances (mirror `CommCareSession.getEvaluationContext`).
- **Fixture verification set** (the CCHQ-fixture rule): `tests/data/suite/module-filter.xml`,
  `module-filter-user.xml` + `module-filter-user-entry.xml`,
  `fixture-to-case-selection-with-form-filtering.xml`, and `test_suite_filters.py::
  test_form_filter`'s inline `#case` expectation. The menu-child-`<instance>` shape has **no
  HQ fixture** (fact 6 gap) — its authorities are `MenuParser.java::parse` and HQ's
  `xml_models` `MenuMixin.instances`; pin Nova's own emitted shape in Nova fixtures.

### 5.5 Preview + case store (`lib/preview`, `lib/case-store`)
- Persona state in `lib/session`; persona editor in the preview shell.
- Display-condition evaluator per §3.3 (rewrite → fold → batched SQL residue). New
  case-store method: type-scoped open-case count reusing `compilePredicate` (the existing
  `compileCount` is anchor-correlated only); selected-case `prop` residue evaluates as a
  predicate over the selected row.
- Gate the `HomeScreen` module list and `ModuleScreen` form list renders; hidden-items reveal
  + condition summaries; feed `windowWidth` from the persona (absent ⇒ absent-node
  semantics).

### 5.6 Builder UI (`components/builder`)
- "Display condition" sections in `ModuleSettingsPanel` (third section) and
  `FormSettingsPanel` (sections compose; new section beside `CloseConditionSection`),
  mounting `PredicateCardEditor` under the display-condition context/constraints.
  Form editor offers selected-case props only in case-first modules, with a
  disable-with-reason otherwise. Condition badges on module/form tiles in edit mode.

### 5.7 SA + MCP (`lib/agent`, `lib/mcp`)
- `display_condition` param (typed `Predicate`, `.nullable()` to clear) on
  `updateModuleInputSchema` + `updateFormInputSchema`, parsed/checked at the tool boundary,
  folded into the existing patches through `guardedMutate`. MCP propagation is automatic
  (`sharedToolAdapter` builds wire schemas from the same Zod). Re-run
  `scripts/test-schema.ts` (add `updateForm` if absent).
- Prompt guidance: new `### Display conditions` under `## Architecture Principles` in
  `prompts.ts::SHARED_TAIL` — trigger smells (role-gated menus "only supervisors…",
  stage-gated forms, screen-width layouts, date windows), negative guidance (field branching
  is field `relevant`, not a display condition; never hide the only path to required data;
  user-data conditions assume the project provisions those fields — an export note until F2).

### 5.8 Docs + migration
- New authoring docs page (display conditions concept, persona preview, the provisioning
  caveat) + `content/docs/mcp/tools.mdx` rows + subtree `CLAUDE.md` updates (`lib/domain`,
  `lib/commcare`, `components/builder`).
- **No data migration**: purely additive optional slots; no existing doc can carry a finding
  from the new codes (the repair-judgment entries are still mandatory via the pinned test).
- Feature-map maintenance edit: §F1 charter → pointer to this plan; sequencing note per §4.

## 6. Execution prompts

Serialized P1 → P2 → P3/P4 (parallelizable) → P5. Each prompt states its own open degrees of
freedom; everything not listed as open is decided above and not the implementer's to relitigate.

---

**P1 — Domain vocabulary + validator.**
> Implement F1's domain layer per `docs/plans/2026-07-06-f1-module-form-display-conditions.md`
> §2, §3.1, §3.2, §5.1–§5.3. Add `displayCondition: predicateSchema.optional()` to
> `moduleSchema` + `formSchema`; the `case-count` ValueExpression arm (+ builders, reduction,
> `simplifyForEmission` recursion, type checker verdict `number`, Postgres-compiler rejection
> arm until P3 wires it); `window_width` into `SESSION_CONTEXT_FIELDS`; the
> display-condition `TypeContext` (module/form variants per the §3.1 table, form variant
> keyed on `isCaseFirstModule`); slot-constraint descriptors from the same rules; reference
> registry entries + `extractModuleEdges`/`extractFormEdges` + rename-cascade arms; validator
> codes `MODULE_DISPLAY_CONDITION_TYPE_ERROR` / `FORM_DISPLAY_CONDITION_TYPE_ERROR` /
> `DISPLAY_CONDITION_ALWAYS_FALSE` with `VALIDITY_CLASS_BY_CODE` rows (`soundness`) +
> `legacyFindingRepairs` judgments (`owner`), rules cloning `filterTypeCheck`; extend
> `matchModeOnDeviceCompatibility` to both new slots. Tests: checker context matrix
> (every §3.1 row), referenceSlots audit green, gate rejection of ill-typed / always-false
> commits, fuzz parity for the reference index.
> **Open for implementer:** the checker's resolved type for `window_width` (number vs text
> +coercion — pick what makes `gt` ergonomic AND matches XPath/Postgres coercion; document
> it); whether `case-count.where` admits `via` walks in v1 (reuse whatever the nodeset-filter
> emitter already supports — do not build new lowering); exact `CheckError` wording (Elm-like,
> person-to-person).

**P2 — Wire emission + oracle.**
> Implement F1's emission per plan §3.4, §5.4 (P1 landed). Local suite: `relevant` on
> `<menu>`/`<command>` in `compiler.ts` through `effectiveDisplayConditionForEmission` (new,
> mirroring `effectiveFilterForEmission`'s single-home contract) and a display-condition
> anchor variant of the on-device predicate emitter; `<instance>` children on `<menu>` for
> module conditions; entry accumulation for form conditions
> (`accumulateCaseLoadingInstances` seam). HQ JSON: `module_filter`/`form_filter` projection
> (`#case/<prop>` for selected-case refs; expanded paths otherwise); verify Nova's stamped HQ
> build version ≥ 2.20 and cite where it's set. Extend `suiteOracle` (attrs + the two
> instance-resolution scopes mirroring `CommCareSession.getEvaluationContext`). Verify
> against the CCHQ fixtures named in §5.4 and note the menu-instance fixture gap by pinning
> Nova fixtures against `MenuParser.java::parse`. Emitter fuzz must stay green (totality:
> the checker is the gate; no emit-time errors).
> **Open for implementer:** the exact seam for the anchor model in
> `caseListFilterEmitter.ts` (parameterize vs sibling emitter — pick the one that keeps the
> case-list path byte-identical); whether the command `relevant` also mirrors onto the
> `<entry>`'s command element (read `commcare-core` `EntryParser` first — HQ does not, so
> default no); Nova fixture organization.

**P3 — Preview execution + persona.**
> Implement F1's preview per plan §3.3, §5.5 (P1 landed; can run parallel to P2 but must
> match its wire semantics — same fold rules, same absent-node behavior). Persona state in
> `lib/session` + persona editor in the preview shell; the rewrite→fold→SQL-residue
> evaluator; a type-scoped open-case count on the case store (Project/app-scoped, reusing
> `compilePredicate`); gate `HomeScreen`/`ModuleScreen` renders; hidden-items reveal with
> condition summaries; edit-mode badges untouched-visible. No Vitest UI-state tests for DOM —
> test the evaluator + store as pure state (house rule); the reveal UX rides the Playwright
> smoke if touched.
> **Open for implementer:** count-query caching/invalidations (case writes during preview
> must refresh — find the existing case-data invalidation seam); the condition-summary
> printer (reuse the card editor's sentence rendering if extractable); persona editor
> placement + width presets; the synthetic `userid` value (document; do not touch the
> `owner_id` axis).

**P4 — Builder UI.**
> Implement F1's authoring UI per plan §5.6 (P1 landed; parallel to P2/P3). Display-condition
> sections in `ModuleSettingsPanel` + `FormSettingsPanel` mounting `PredicateCardEditor`
> under the display context; case-first-aware form editor (disable-with-reason for
> selected-case props otherwise); tile badges. Load the frontend-design skill; build from
> existing shadcn/Nova primitives.
> **Open for implementer:** section copy + affordance details; how the always-false finding
> surfaces inline in the editor (the gate already rejects — surface `CommitOutcome`
> contextually like the XPath editor's bounce); badge visual.

**P5 — SA tools, MCP, docs, sweep.**
> Implement F1's agent + docs surface per plan §5.7–§5.8 (P1–P4 landed). Tool params
> (`display_condition`, nullable Predicate) on `update_module`/`update_form` with boundary
> checking through the display context; prompt guidance section; `scripts/test-schema.ts`
> run; `tools.mdx` + new authoring docs page; subtree `CLAUDE.md` updates; feature-map §F1
> charter → pointer + §4's sequencing note. End with the standing drift/v1-punt sweep.
> **Open for implementer:** guidance wording (trigger smells from plan §5.7; calibrate
> against the SA's existing tone); docs page structure; whether `create_module`/`create_form`
> also accept the param now (default: no — update tools suffice; note it for a fast follow).

---

## 7. Risks + deliberately-deferred questions

- **Menu-instance fixture gap** (fact 6): Nova pins its own fixtures against the runtime
  parser; if a real device/web-apps regression appears, the fallback is the pre-2.54
  entry-placement shape, which HQ still emits for old apps.
- **`via` walks in form-level conditions** (selected-case ancestors): deferred, not rejected
  — the checker context can widen without schema change once the anchor-variant emitter
  proves out.
- **Widening `case-count` into case-list filters**: plausible and cheap later; kept out of
  v1 to avoid touching CSQL representability rules.
- **F2 handoff**: typed user-data vocabulary, autocomplete over `session-user` fields, typed
  personas, usercase terms, provisioning. F1's open-namespace refs and ad-hoc persona are
  the designed substrate, not debt.
- **F7 inheritances recorded here**: `put_in_root` filter AND-merge (fact 13); menu nesting;
  endpoint `respectRelevancy=false` deep-link semantics (runtime fact — endpoints can
  navigate into hidden menus; matters when F7 models session endpoints).
