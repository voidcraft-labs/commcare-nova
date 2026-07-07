# Plan: F7 — Navigation & workflow

> **Execution superseded (2026-07-06):** this plan remains the verified-facts + rationale reference; implementation follows the PR plans in `docs/plans/2026-07-06-pr-execution-plan.md` (+ `docs/plans/prs/`), which also carry the owner's scope rulings — several items this plan lists as deferred/excluded are now IN scope there (project-shared tables, authored+referencable create ids, rename/re-type ops, custom location fields, multi-location personas, answer-dependent choice filters, table reads from field expressions, case tiles, case attachments, session endpoints + smart links). Where this plan and the PR plans disagree on scope, the PR plans win.

*Planning pass, 2026-07-06. Seeded by `docs/research/feature-map.md` §F7; anchors: ACA §3.1's
form-granularity note + H8, §2.1/§4.6 (endpoints/smart links), F1's recorded inheritances
(put_in_root AND-merge, `respectRelevancy=false`, `cc-auto-advance-menu`). Platform facts
re-verified 2026-07-06 against `~/code/commcare-hq` and `~/code/commcare-core`/
`~/code/formplayer` (pinned-identical runtime). F7 is deliberately the last plan: it consumes
F1 (display conditions), F4 (ops make event-forms viable), and the F2/F3 persona/preview
work.*

**What ships, in two slices.** Slice A — the Nova-experience core: **first-class
sections/steps** on forms (the H8 bet, now evidence-backed: chaining fragility is verified
mechanics, and sections compile to plain groups), **menu nesting** (submodules +
flatten-into-parent, activating Nova's pre-reserved `root`/`parent_module` destinations),
**Nova-native form reuse** (a reference that emits CCHQ's duplicated-entry wire shape without
shadow models), and **chaining hardening** (validator rules + SA guidance derived from the
verified failure mechanics). Slice B — explicitly deferred with its wire verified: session
endpoints + smart links (flag-gated, registry-coupled; specced for when a cross-app need
lands).

---

## 1. Verified platform facts + lifecycle citations

| # | Fact | Citation | Verdict |
|---|---|---|---|
| 1 | Six EOF workflows (`default/root/module/parent_module/previous_screen/form`), all alive. `WORKFLOW_DEFAULT` **emits no `<stack>` at all** (absence = the runtime's built-in return); `root` = empty `<create>`; `module` = one `<command>`; `parent_module` recurses the root module; `previous_screen` = the nav chain minus its last datum (HQ's own docstring: "the most fragile"). | `commcare-hq/.../app_manager/const.py::WORKFLOW_*`; `suite_xml/post_process/workflow.py::EndOfFormNavigationWorkflow._get_static_stack_frame` | Alive. Nova's `postSubmit` maps 1:1 (`app_home`↔`default`). |
| 2 | Form links: `FormLink{xpath, form_id ⊕ module_unique_id, datums[]}` → one `<create if="…">` frame per link, first-true-wins, plus a fallback frame guarded by `and(not(c1), not(c2)…)`. (Latent HQ bug: `WORKFLOW_FALLBACK_OPTIONS` is `None` — Nova validates its own fallback.) | `models.py::FormLink`; `workflow.py::_get_link_frame/_get_fallback_frame`; `const.py::WORKFLOW_FALLBACK_OPTIONS` | Alive. Nova's `formLinks` already model + emit this shape. |
| 3 | Stack vocabulary is closed: ops `{create, push, clear}` (+ per-op `@if`), steps `{datum, instance-datum, command, query, mark, rewind, jump}`; datum values are **evaluated at push time** (concrete strings, not lazy refs); `rewind` truncates to the latest `mark` (silently ignored without one) and halts further ops. | `commcare-core/.../xml/StackOpParser.java::parse`; `StackFrameStepParser.java`; `CommCareSession.java::executeStackOperations`; `SessionFrame.rewindToMarkAndSet` | Alive. The complete authorable surface. |
| 4 | **Chaining fragility is verified mechanics, not lore**: web-apps nav is stateless truncate-and-replay of a client-held selections array; a pending chained frame is **wiped wholesale** when a re-selected datum diverges from its snapshot (`isSnapshotIncompatible` → `removeAllElements`); there is **no lease/timestamp/rollback primitive** anywhere in the frame machinery (greps shown; only a 7-day formSession purge), so mid-flow case writes stranded by a closed tab never revert. | `formplayer/.../MenuSession.java::resetSession`; `MenuSessionRunnerService.java` (back-nav truncation); `CommCareSession.java::finishAndPop/cleanStack`; `SessionFrame.java::isSnapshotIncompatible`; `ScheduledTasks.java::purge` | Alive. The evidence behind H8's "mega-forms encode chaining fragility". |
| 5 | Chained forms get **no interactive re-prompt** for datums: the stack op must name every needed datum, and the carried case must still be in the target entry's nodeset (case-list filter + ownership) — else a logged reconstruction failure. Auto-select rescues only opt-in single-match datums (`isAutoSelectEnabled() && references.size()==1`). | `formplayer/.../MenuSessionFactory.java::rebuildSessionFromFrame`; `commcare-core/.../EntityScreen.java::shouldAutoSelect` | Alive. Bounds Nova's form-link validator (§3.4). |
| 6 | Menu nesting: `root_module_id` → `<menu root="m<parent>">`; `put_in_root` collapses the child's menu id into the parent's (same-id menus concatenate), with the parent's `module_filter` **AND-merged** into relevancy (F1's recorded fact re-confirmed). Effectively one nesting tier; training modules use the reserved `training-root`. v1 shadow-menu duplication is deprecated; `root`/`put_in_root` themselves are current. | `menus.py::MenuContributor._generate_menu`; `id_strings.py::menu_id`; `toggles::V1_SHADOW_MODULES` (TAG_DEPRECATED) | Alive. |
| 7 | Session endpoints: module/case-list/form `session_endpoint_id` (+ per-form `respect_relevancy`, `function_datum_endpoints`) → `<endpoint id>` with `<argument>`s + `<push>` stack (WorkflowHelper machinery), **claim `<push>` frames per case-id argument** (`claim_command.<ep>.<arg>`), and `respect-relevancy="false"` letting deep links traverse hidden menus (runtime: `rebuildSessionFromFrame` walks `getAllChoices`). Web URL `/a/<domain>/app/v1/<app_id>/<endpoint_id>/`. Gated by `SESSION_ENDPOINTS` — **TAG_FROZEN**. | `models.py` (endpoint fields); `suite_xml/post_process/endpoints.py::EndpointsHelper`; `xml_models.py::SessionEndpoint`; `formplayer/.../MenuSessionRunnerService.java::advanceSessionWithEndpoint`; `toggles::SESSION_ENDPOINTS` | Alive but frozen-flag-gated. Slice B. |
| 8 | Smart links: registry-coupled (`data_registry_workflow='smart_link'`) — a `<jump><url>` push frame whose URL is a `concat(...)` over the case's domain resolving to a session-endpoint URL; formplayer surfaces `smartLinkRedirect` and the SPA hard-navigates; `/phone/search/` → `/phone/case_fixture/` rewrite hydrates a single case without a live search. | `remote_requests.py::RemoteRequestFactory.build_stack/get_smart_link_function`; `xml_models.py::StackJump`; `workflow.py::WorkflowQueryMeta.to_stack_datum`; formplayer `menus/api.js` | Alive, niche, registry+endpoint-coupled. Slice B (deferred). |
| 9 | Shadow modules = **wire-level duplication, not reference**: a shadow emits its own `<entry>` per source form (same `xmlns`, shadow-scoped command ids `m<shadow>-f<n>`) + its own menu/details/filter. v2 current (`shadow_module_version=2`), v1 deprecated; gated by `APP_BUILDER_SHADOW_MODULES` (TAG_FROZEN). | `models.py::ShadowModule/ShadowForm`; `entries.py::entry_for_module`; `id_strings.py::form_command`; toggles | Alive. Nova-native reuse can emit this wire shape with **no shadow authoring model**. |
| 10 | **H8 confirmed: no wire notion of form sections/steps/pages** — only XForms `<group>` (+ `appearance="field-list"` for single-screen rendering); question flow is `relevant`-driven (searches enumerated). | `xml_models.py`/`models.py`/`xform.py` negative sweeps; `xform.py` field-list handling | Sections are a Nova-only construct compiling to groups/relevant. |
| 11 | `cc-auto-advance-menu`: single *visible* choice self-selects (relevancy filters first); auto-advanced menus are **omitted from the persistent menu/breadcrumb**; under `respect-relevancy="false"` reconstruction counts all choices, so advance behavior can differ from the live view. | `MenuScreen.java::handleAutoMenuAdvance`; `PersistentMenuHelper.kt`; `FormplayerPropertyManager.java` | Alive (profile property; emission machinery lands with F4 P6). |

## 2. The shape question (protocol 3)

CCHQ's authoring shapes here are: a six-way enum + a parallel link list (Nova already
reshaped that — condition-bearing links + a default, which the wire proves is the faithful
model); a shadow-module object graph (rejected — reuse becomes a reference, duplication is
emission detail); and nothing at all for sections (there is no CCHQ shape to reject). Nova's
new shapes:

```ts
// Sections/steps — presentation structure ON the form, not a new container kind
formSchema.sections?: Array<{
  uuid: Uuid, title: string,
  // section membership = a contiguous range of top-level fields, keyed by the
  // first field's uuid; ranges derived, order = field order (no parallel tree)
  startFieldUuid: Uuid,
}>

// Submodules — one nesting tier, matching the platform's effective constraint
moduleSchema.parentModuleUuid?: Uuid          // submenu of that module
moduleSchema.flattenIntoParent?: boolean      // put_in_root, intent-named

// Reuse — a reference, not a copy
moduleSchema.linkedForms?: Array<{ uuid: Uuid, formUuid: Uuid /* source form */ }>
```

- **Sections are deliberately NOT a container field kind**: groups already exist and carry
  wire meaning (relevance subtrees, repeats). Sections are orthogonal presentation — a
  partition of the form's top-level sequence — so they cannot change submission semantics,
  cannot nest, and compile away (fact 10): the preview renders step-wise (one section per
  screen, progress, per-section review); the wire emits either nothing (sections as pure
  preview chrome) or `<group appearance="field-list">` wrappers per section when the author
  opts into screen-per-section on device. The H8 decision, closed: **yes to sections, as
  projection — never as wire structure.**
- **Submodules** activate Nova's pre-reserved vocabulary: `POST_SUBMIT_DESTINATIONS`'
  internal `root`/`parent_module` arms resolve (the `forms.ts` comments planned for exactly
  this), F1's AND-merge fact governs `flattenIntoParent` display conditions, and the
  validator stubs listed in `lib/commcare/CLAUDE.md` (`parent_module` + `put_in_root`
  interactions) activate. One nesting tier, validator-enforced (fact 6).
- **Reuse**: a linked form renders once in the doc (single source of truth — edits are
  edits to the source) and emits the fact-9 wire shape: a duplicate `<entry>` +
  `<command id="m<host>-f<k>">` sharing the source's `xmlns`, host-scoped display/condition.
  No shadow objects, no excluded-form lists (link exactly the forms you want), no v1/v2
  split. H7's no-stub-pathologies principle applied to reuse.

## 3. Charter closure

### 3.1 Wire-constrained vs Nova-experience (charter Q1)
- **Already-shipped wire** (verified 1:1): EOF nav (`postSubmit` ↔ the six workflows;
  `app_home` emitting no stack is confirmed correct) and conditional form links (fact 2's
  frame shapes). F7 adds no schema here — only §3.4's hardening.
- **New wire, slice A**: menu `root` attribute + flatten semantics (fact 6); duplicated-entry
  reuse emission (fact 9); optional per-section `<group appearance="field-list">` (fact 10).
- **New wire, slice B (deferred)**: `<endpoint>`/`<argument>`/claim-push frames and
  `<jump>` smart links (facts 7–8) — both behind frozen HQ flags and coupled to
  registry/cross-app needs Nova doesn't have yet. Deferred with their wire fully verified;
  the F3 interaction (endpoints carrying case ids across ownership boundaries — the claim
  frames) is recorded for that future pass.
- **Pure Nova-experience**: sections/steps (no wire), the persona-aware preview of nav flows.

### 3.2 H8: sections/steps (charter Q2) — decided
Yes, as §2's projection-only shape. The evidence upgrade since the memo: fragility is now
mechanics (fact 4 — snapshot-incompatible frame wipes, no cleanup primitives, fact 5 — no
datum re-prompt), so "prefer one form presented as steps over chained forms" is not taste,
it's the platform's own failure-mode analysis. The SA's default for multi-step workflows
becomes: sections within one form (+ F4 ops for the multi-case effects) unless the steps are
genuinely separate events; form links remain for the real cases (different case contexts,
different actors).

### 3.3 Workflow as a noun (charter Q3) — no
"Workflow" stays a property of forms/modules/navigation. Reasons: the wire has no workflow
object to anchor one (stack ops are per-form emissions; fact 3); Nova's composition —
display conditions (F1) + sections (here) + form links + ops (F4) — already expresses the
observed patterns without a new noun; and a workflow object would be speculative abstraction
with no consumer surface. Revisit trigger recorded: if slice B's endpoints land AND cross-app
flows need orchestration above the form level, that pass may re-open this with evidence.

### 3.4 Chaining hardening (from facts 4–5)
- Validator (gating soundness, with repair judgments): a form link's target entry must have
  every needed datum named by the link's datums or carried by the session (checkable against
  the target module's datum derivation); a link that carries a case into a module whose
  case-list filter provably excludes it (statically decidable subset: type mismatch) is
  rejected; fallback destination validated (fact 2's HQ bug is Nova's warning).
- SA guidance: the §3.2 default; never design stage-flag chains ("no guaranteed cleanup" is
  now citable mechanics); auto-select opt-in explained; `cc-auto-advance-menu`'s
  breadcrumb-collapse caveat (fact 11) noted where the SA might reach for it.
- Docs: the chaining semantics page (what survives back-nav, what a closed tab strands).

## 4. Full-stack scope (protocol 4)

Domain (sections + submodule fields + linkedForms + validator rules incl. one-tier nesting,
flatten/display-condition interplay per F1's AND-merge, link-datum checks); doc/mutations
(section CRUD; module parent/flatten patches; linkedForm add/remove — all keyed/granular);
emitters (menu `root`/flatten; duplicated-entry reuse; optional section field-list groups;
`postSubmit` internal arms activate; suite oracle: menu-root resolution, duplicate-xmlns
entries legal, command-id uniqueness across hosts); preview (step-wise section rendering +
progress; submodule navigation; linked forms run their source; persona-aware nav);
builder UI (section rails on the form canvas; module nesting controls; linked-form pickers;
"runs as steps" preview affordance); SA + MCP (section/nesting/reuse tools + the §3.2/§3.4
guidance); docs (+ the chaining semantics page); migration: none (additive).

## 5. Execution prompts

Slice A: P1 → P2 → P3 → P4 (P2∥P3 after P1). Slice B: P5 (spec-level, deliberately last).
P6 closes.

---

**P1 — Sections/steps.**
> Implement F7's sections per `docs/plans/2026-07-06-f7-navigation-workflow.md` §2, §3.2.
> The `sections` slot (contiguous top-level partition; no nesting; reorder/insert semantics
> against field order), preview step rendering (one section per screen + progress +
> per-section validation surfacing), and the opt-in per-section `<group
> appearance="field-list">` emission (default: preview-only chrome). SA tools + the
> multi-step-workflow guidance rewrite (§3.2's default).
> **Open for implementer:** section boundary mechanics when fields move/delete (recommend:
> sections reference their first field; an emptied section dissolves); whether the device
> opt-in is per-form or per-app; step-navigation UX details (load frontend-design).

**P2 — Menu nesting.**
> Implement submodules per plan §2, §3.1 (P1 landed): `parentModuleUuid` (one tier,
> validator-enforced) + `flattenIntoParent` with F1's display-condition AND-merge; menu
> `root` emission + same-id concatenation semantics; activate the reserved
> `root`/`parent_module` post-submit arms + the listed validator stubs; `parent_module`
> workflow emission per fact 1's shapes. Fixture-verify against HQ's menus.py outputs.
> **Open for implementer:** builder UX for nesting (drag vs picker); how flattened modules
> render on the canvas; case-type constraints between parent/child modules (read HQ's
> child-module case-type rules first and decide what Nova enforces).

**P3 — Form reuse.**
> Implement linked forms per plan §2/fact 9 (P1 landed; parallel with P2): the
> `linkedForms` reference (source-of-truth editing; host-scoped display condition riding
> F1's slot), duplicated-`<entry>`/`<command>` emission with shared `xmlns` and host command
> ids, suite-oracle updates (duplicate xmlns legal; command-id uniqueness), preview running
> the source form under the host module's context.
> **Open for implementer:** case-context compatibility rules (a case-loading form linked
> into a module of a different case type — recommend: same-case-type-only in v1); how
> deletion of a source form treats its links (block-with-references, the house pattern).

**P4 — Chaining hardening.**
> Implement §3.4 (P1–P3 landed): the form-link validator rules (datum completeness against
> the target's derived datums; statically-decidable filter exclusions; fallback validation),
> the SA guidance updates, and the chaining-semantics docs page (facts 4–5 in
> person-readable form).
> **Open for implementer:** exactly which filter exclusions are statically decidable in v1
> (type mismatch certainly; leave value-level analysis out); rule granularity.

**P5 — Endpoints + smart links (deferred spec).**
> DO NOT BUILD YET. Produce the slice-B spec as a short design doc when a concrete cross-app
> or deep-link need lands: `<endpoint>` modeling (ids, arguments from datum derivation,
> claim frames, respect-relevancy default TRUE with the hidden-menu caveat), the web URL
> contract, smart-link preconditions (registry workflow — likely never Nova's), and the F3
> ownership interplay. Facts 7–8 hold the verified wire; the HQ flags (`SESSION_ENDPOINTS`
> frozen) are the deployment prerequisite to record.
> **Open for its author:** everything except the wire facts.

**P6 — Docs, map, closure.**
> Close out F7 (slice A landed): docs (+ chaining page from P4), tools.mdx, CLAUDE.md
> updates (including retiring the `put_in_root`/`parent_module` not-yet-modeled notes that
> P2 activates), feature-map §F7 → pointer, `cc-auto-advance-menu` guidance note (fact 11's
> caveat) wherever F4-P6's profile settings surfaced, drift sweep.
> **Open for implementer:** docs structure.

---

## 6. Risks + notes

- **Sections must never grow wire semantics** — the moment a section carries a condition or
  a repeat, it's a group and should be one. The validator keeps sections presentation-pure
  (no expression slots on sections, ever; that's the design fence).
- **Reuse + future features**: linked forms inherit their source's F4 ops and F2 usercase
  writes by construction (single source). A host-module case-type mismatch is the one sharp
  edge — P3's compatibility rule guards it.
- **Slice B's flags**: `SESSION_ENDPOINTS` is TAG_FROZEN — fine for existing users, but a
  Nova design leaning on endpoints needs that flag on the target domain; recorded in P5's
  spec skeleton.
- The **breadcrumb-collapse** behavior of auto-advance (fact 11) and the
  `respect-relevancy=false` divergence are documented sharp edges, not Nova problems to fix.
