# Step 5, part 06: Form links

Part of [step 5's plan](../5-case-writes-forms-navigation.md), which holds the baseline, the
decisions, the stack and the exit. This part fixes defect 26 whole: what a form's after-submit
links mean, how they reach the wire, which targets and which "otherwise" Nova admits, what a link's
carried case may name, how Preview and App Tests play each platform's stack of destinations, the
validator's retired and new codes, the mutation and planners, the migration classes the one
cutover (part 09) runs, the proof that moves defect 26's 18 register entries, and the three gated
runs that settle what reading leaves open. It lands in pull request 11, "Form links", with part
08's proof mechanics for the same pull request.

Citations are `path::symbol`. Nova is read at `main` `2f985ed6` (#825), step 4's stack merged and
its cutover run. CommCare is read at the pins `proof/pins.json` names, each checkout's head
verified at its pin during this read: commcare-hq `d6c6e16d8ae1` (under `corehq/apps/app_manager/`
unless named), commcare-core `8e9ba8d908e9` (under `src/main/java/org/commcare/`), formplayer
`24383ac71bfb` (under `src/main/java/org/commcare/formplayer/`), commcare-android `7a5584475580`
(under `app/src/org/commcare/`), Vellum `01215f251c57`, commcare-connect `046c7fd78081`. Nothing
here was run; §18 lists what was read, and §19 writes out every run this part needs, with each
outcome and where it lands.

Pull request 11 sits on pull request 10 (part 05), which renames the module facts this part's
offered sets read (`caseSearchConfig.formsReadSearch`, `Module.caseListMenuItem`,
`Module.caseListRegistrationForm`), the codes `CASE_LIST_REGISTRATION_HAS_NAVIGATION` and
`FORM_LINK_TARGET_CASE_LIST_REGISTRATION_FORM`, and the post-submit reasons `menu-forms-read-search`
and `menu-is-bare-case-list` (today's `menu-opens-on-search` and `menu-is-case-list-only`); and on
pull request 7 (part 02), which adds
advanced entries to the frame algorithm, `formLinkProjection.ts::linkCarriedCreates` and the code
`FORM_LINK_NEEDS_NEW_CASE_DATUM`. Every name below that those pull requests introduce is theirs.

## Decisions in brief

1. **Destinations run in the author's order, emitted reversed.** `Form.formLinks` keeps its name and
   array; from step 5 each entry is a *destination*, and after the form every destination whose
   emitted condition holds runs. The links are emitted in reverse array order, so the author's
   first destination that holds is the frame on top: Core and Android run it first and the rest
   after it, each when the one above it finishes (§2.2). The stored vocabulary keeps `formLinks`;
   the builder, the tools and the docs say "destination".
2. **Web Apps opens only the first destination that holds.** Formplayer rebuilds its session from
   the popped frame and drops every frame beneath it (§2.4). A new platform feature
   `after-submit-several-destinations` reads `different` on Web Apps and `runs` on Android; it
   refuses nothing. Gated run G1 confirms it before the row, the Preview rule and the copy land
   (§19.1).
3. **"Otherwise" is its own slot, `Form.otherwise`,** a built-in destination (`firstMenu`, `module`,
   `parentMenu`, `previous`) or a link. It runs exactly when HQ's own fallback frame runs: when no
   destination that *may not run* (one with a condition, or one that carries a case, decision 6)
   runs. It is admitted only while some destination may not run. Absent, the app home follows
   (HQ's `default`: no frame). Because HQ pushes the fallback frame last, an otherwise that runs
   opens before any destination that runs every time.
4. **`Form.postSubmit` is the after-submit of a form without destinations only.** Beside
   `formLinks` it is refused, `POST_SUBMIT_BESIDE_FORM_LINKS`.
5. **Start this form again is a target, `{ type: "this-form" }`.** It emits as a form target naming
   the source form and its own menu. A `form` target that names the source form is refused
   (`FORM_LINK_SELF_REFERENCE`, new meaning). Link cycles are admitted; `FORM_LINK_CIRCULAR`
   retires.
6. **A carried case must be on the device.** Each carried value (`datums[].xpath`) that lands on a
   single-case selection adds one conjunct to its link's emitted condition,
   `count(instance('casedb')/casedb/case[@case_id = V and @case_type = 'T']) > 0`, so a destination
   whose carried value names no case of its type on the device does not run, and HQ never receives
   an update to a case nothing created (defect 26 group A). Gated run G2 confirms the guard reads
   the device after the submission lands.
7. **Nova admits the menu targets and the otherwise HQ's form settings page offers.**
   `lib/domain/formLinkTargets.ts::menuTargetOffered` restates
   `views/forms.py::_get_linkable_forms_context`: a root menu always, a submenu only from a submenu
   whose parent has the same case type as the target's parent. A built-in otherwise must be in
   `otherwiseDestinationsOffered`, today's offered set less `app_home`. A link to a menu carries no
   values. New codes `FORM_LINK_TARGET_NOT_OFFERED`, `FORM_LINK_MENU_DATUMS`,
   `FORM_OTHERWISE_NOT_OFFERED`, `FORM_OTHERWISE_UNREACHABLE`, `POST_SUBMIT_BESIDE_FORM_LINKS`;
   `FORM_LINK_UNREACHABLE`, `FORM_LINK_NO_FALLBACK` and `FORM_LINK_CIRCULAR` retire.
8. **One new mutation, `setFormOtherwise`,** and planners that keep every batch valid by
   construction: the first destination turns the form's after-submit into its otherwise, removing
   the last destination turns the otherwise back into the form's after-submit, and an edit that
   leaves nothing that may not run removes the otherwise; each says what it did.
9. **Preview and App Tests play each platform's stack** through one pure module,
   `lib/preview/afterSubmitStack.ts`, and one rule, `PreviewPlatformRules.afterSubmitFrames`
   (`"stack"` on Android, `"top"` on Web Apps), with Core's drop of the remaining frames when the
   worker leaves the path a destination opened.
10. **The cutover writes every link's implicit exclusivity into its stored condition** (class L1),
    so every existing app behaves as it does today; a terminal unconditional link becomes the
    otherwise link (L2), a stored `postSubmit` beside conditional links the built-in otherwise
    (L3), a submenu HQ does not offer its parent (L4; where that parent is off the menu, the link
    goes, §14.4), datums on a menu go (L5), and an otherwise HQ does not offer the nearest it does
    (L6). L7 is the guard, an emission change with no stored change. One pure, total map,
    `lib/doc/formLinkSemanticsMap.ts::mapFormLinkSemantics`, is what the cutover and the corpus
    sources call.
11. **Pull request 11 carries the whole after-submit surface on the new model, in part 07's
    words**, because each piece of it reads something the model change removes: the builder's
    after-submit screen with every control and line it shows, the four link tools' schemas and
    descriptions, `update_form`'s and `get_form`'s link fields, the guide's after-submit sentences,
    and the shared tool `set_form_otherwise`, which carries the capability `update_form`'s
    `post_submit` loses beside links. Part 07 writes the copy (its §3.11 and its form link tools);
    pull request 12 adds no second version of any of it, and pull request 13 adds nothing to it.
12. **Defect 26's 18 entries move to `proof/fixed-defects.json`** in pull request 11, on their
    controls, and `OPEN_DEFECTS` loses `26`.

### Departures

Each is marked where it is decided; collected here.

| From | Departure | Reason | Where |
|---|---|---|---|
| Outline item 9, research | Web Apps runs only the first destination that holds | Formplayer drops the pending frames (§2.4); G1 confirms | decision 2, §10, §19.1 |
| Research ("otherwise exists only when a destination has a condition") | "may not run" includes a carried case | HQ's fallback conjoins every non-blank `xpath`, and a guarded link's is non-blank | decision 3, §5.2 |
| Form-links brief D13 | the otherwise runs when no destination that may not run runs, before every-time destinations | HQ's `_get_fallback_frame` counts only non-blank `xpath`s and is pushed last | decision 3, §2.6 claim 6 |
| Form-links brief D3 | no `FORM_OTHERWISE_SAME_MENU` | HQ builds the link and `module` frames differently; where `module` is withheld the link is the only way | §7.4 |
| Form-links brief D6 | the guard is `rowScope.ts::caseById`'s one predicate, and only on single-case selections | one builder of a case-by-id read; a several-case value names a selection | §5.1, §5.4 |
| Form-links brief D13 | no planner retargets links on a module or form move; the gate refuses | a side-effect rewrite of other forms' links is an edit nobody asked for | §4.1 |
| Form-links brief D5 | `formLinkGraph.ts` is deleted; `formLinkDestination` moves to `formLinkTargets.ts` | its graph readers served only the cycle rule | §3.2 |
| Form-links brief §4.4, §9 | three documents as part 08 names them (`targeted-form-link-chain`, `targeted-form-link-otherwise`, `targeted-form-link-carried-case`); the carried-case walk makes its own cases; G1 runs in pull request 11 | part 08 owns the names; a walk cannot purge a case; the reversed emission first exists in pull request 11 | §13.2, §19 |
| Form-links brief §4.5 | the fixture scenario `else` keeps its id | a rename moves a corpus id for a word only the fixture reads | §13.3 |
| Form-links brief §5 | notice reasons are the cutover's canonical list, with `form-link-removed` for L4's off-the-menu arm; L7 has no notice | the plan's decision 13; nothing at `main` refuses the off-the-menu shape, so the map removes it rather than blocking (§14.4); L7's only effect is defect 26's fix | §14.3, §14.4 |
| The plan's stack (12 and 13 add new surfaces) | pull request 11 carries the after-submit builder surface, the guide's after-submit sentences and `set_form_otherwise`, in part 07's words; pull request 12 adds no second version | each reads an export pull request 11 removes, or carries a capability `post_submit` loses beside links; the plan adopts it | decision 11, §12 |

---

## 1. What Nova does today

### 1.1 Stored shapes

- `lib/domain/forms.ts::formLinkTargetSchema`: `{ type: "form", moduleUuid, formUuid }` or
  `{ type: "module", moduleUuid }`.
- `formLinkObjectSchema` / `formLinkSchema`: `{ uuid, condition?: formLogicSchema, target,
  datums?: { name: FormLinkDatumName, xpath: formLogicSchema }[] (min 1) }`, refined by
  `uniqueFormLinkDatumNames`. `datums` absent means "match automatically"
  (`_get_datums_matched_to_source`); `[]` is no state. `FormLinkDatumName` is
  `{ kind: "selected-case", module }` (`lib/domain/expression/types.ts::formLinkDatumNameSchema`).
- `formSchema.formLinks: z.array(formLinkSchema).min(1).optional()`, whose doc comment reads
  "checked in order: the first link whose condition holds is followed, and `postSubmit` is where it
  goes when none does".
- `formSchema.postSubmit: z.enum(POST_SUBMIT_DESTINATIONS).optional()` over `["app_home",
  "firstMenu", "module", "parentMenu", "previous"]`; with links it is the fallback, without them
  the destination. `defaultPostSubmit(formType, shape)` gives registration and survey `app_home`,
  and a case-loading form the first offered of `previous`, `module`, `firstMenu`.

### 1.2 The offered set (`lib/domain/postSubmit.ts`)

`POST_SUBMIT_NOT_OFFERED_REASONS` and `WITHHELD_BY` (`menu-selects-several` withholds `previous`;
`parent-selects-several` withholds `module`, `parentMenu`, `previous`; `menu-opens-on-search`
withholds `previous`; `menu-is-case-list-only` `module`; `no-parent-menu` `parentMenu`;
`menu-off-the-menu` `module` and `previous`; `parent-off-the-menu` `parentMenu`).
`postSubmitDestinationsOffered` is HQ's settings page narrowed by Nova's off-the-menu reasons;
`postSubmitDestinationsAdmitted` waives the two several-case reasons for a form holding links
(`MULTI_SELECT_REASONS`, `formHoldsLinks`), its doc comment saying "a fallback the settings page
does not offer is a later step's to settle"; `postSubmitDestinationChoices`,
`postSubmitNotOfferedReason`, `defaultPostSubmitOf` and `effectivePostSubmit` complete it. Pull
request 10 renames `menu-opens-on-search` to `menu-forms-read-search` and `menu-is-case-list-only` to
`menu-is-bare-case-list`, same order and same withheld destinations, read from `formsReadSearch` and
`moduleIsBareCaseList` (part 05).

### 1.3 Emission (`lib/commcare/formLinkProjection.ts`)

`planFormLinkGuards(links)` makes "first true wins" true over Core's run-every-true-frame stack: link
*i* emits `c_i and not(c_1) and … and not(c_{i-1})` over the earlier conditional links; a terminal
unconditional link emits `not(c_1) and … and not(c_{n-1})` and suppresses the fallback
(`FallbackPlan.kind = "suppressed-by-else"`); otherwise the fallback is `postSubmit` guarded by
`not(g_1) and … and not(g_n)` over the emitted guards (`"guarded"`), or none (`"none"`).
`projectFormLinks(doc, ctx, formUuid)` returns `{ links: ProjectedFormLink[], fallback }`, each link
with `guard`, `target`, matched `children`, manual `datums` and the validator inputs `unmatched`,
`missing`, `unused`, `unrepresentableQueryDatums`. The frame children follow
`WorkflowHelper.get_frame_children` (`targetFrameChildren`, `matchFrameToSource`,
`matchFrameToManual`, `previousFrameChildren`, `moduleDestinationFrameChildren`,
`parentMenuDestinationFrameChildren`). The printers are `lib/commcare/session.ts::deriveFormLinkStack`
(local `<stack><create if>`) and `lib/commcare/expander.ts::toHqFormLink` (HQ `form_links[]`:
`{xpath, form_id, form_module_id, datums}` or `{xpath, module_unique_id, datums}`, `xpath: ""` when
unconditional); `post_form_workflow` is `"form"` exactly when links exist and
`post_form_workflow_fallback` the workflow word when the fallback is guarded, else `null`
(`expander.ts`, the after-submit block). `lib/commcare/__tests__/formLinkParity.test.ts` holds the
local `if` to HQ's `xpath` byte for byte.

### 1.4 Validator and the checker

`lib/commcare/validator/rules/form.ts::formLinkValidation` reports `FORM_LINK_EMPTY`,
`FORM_LINK_TARGET_NOT_FOUND`, `FORM_LINK_TARGET_NO_MATCHES_FORM` (renamed by pull request 10),
`FORM_LINK_NO_FALLBACK`, `FORM_LINK_SELF_REFERENCE`, `FORM_LINK_UNREACHABLE`,
`FORM_LINK_DATUMS_INCOMPLETE`, `FORM_LINK_DATUM_UNUSED`, `FORM_LINK_DATUM_TARGET_COLLISION`,
`FORM_LINK_SEARCH_CASE_UNREPRESENTABLE`; `rules/multiSelect.ts::formLinkSelectionCardinality`
reports `FORM_LINK_SELECTION_CARDINALITY` and `FORM_LINK_SELECTION_CASE_TYPE_CHANGED`;
`rules/app.ts` reports `FORM_LINK_CIRCULAR` through `lib/domain/formLinkGraph.ts`
(`formLinkAdjacency`, `formLinkPath`); `POST_SUBMIT_NOT_OFFERED` reads
`postSubmitDestinationsAdmitted`; `rules/hiddenFromMenu.ts::hiddenMenuLinkTargets` reports
`HIDDEN_MENU_NOT_A_DESTINATION` (arm `link`). The checker's slots are `form_link_condition` and
`form_link_datum_xpath` (`lib/domain/expression/context.ts`), the latter refused with
`datum-not-supplied` (`typeChecker.ts`) when the destination no longer asks for the name; nothing
reads what case a value names. Nothing checks whether HQ's page offers a menu target
(`targeted-form-links-hidden-and-fallback` holds one it does not), and a literal value naming no
case is admitted (`lib/commcare/__tests__/expander.test.ts`, "forwards literal condition + datum
overrides").

### 1.5 Mutations, planners, tools, builder, Preview

- Kinds `addFormLink`, `updateFormLink`, `removeFormLink`, `moveFormLink` (`lib/doc/types.ts`);
  reducers in `lib/doc/mutations/forms.ts`; admission in `mutationTargetAdmission.ts`,
  `mutationIdentityAdmission.ts`, `mutationSequenceAdmission.ts`; `referenceIndex.ts`,
  `diffDocsToMutations.ts`, `incrementalValidationScope.ts` (each link kind scopes to its form;
  its comment says "Link cycles remain covered because cycle detection is app-wide").
- `lib/doc/formLinkMutations.ts`: `afterSubmitPlan` (the terminal unconditional link, else
  `postSubmit`, with `fallbackMustBeExplicit`), `planFormLinkAdd`, `planFormLinkUpdate`,
  `planFormLinkRemove`, `planFormLinkMove`, `planSetFallback`, refusals `FormLinkRefusal`
  (`form-not-found`, `link-not-found`, `duplicate-uuid`, `target-not-found`, `self-target`,
  `selection-cardinality`, `cycle`, `else-exists`, `after-else`, `else-not-last`, `stale-base`)
  and `pinsFallback`. `lib/doc/formLinkReview.ts`, `formLinkDependents.ts`,
  `formLinkTargetChoices.ts`; `lib/doc/mutations/modules.ts::reconcilePostSubmitWithMenuShape`.
- Tools `add_form_links`, `update_form_link`, `move_form_link`, `remove_form_link`
  (`lib/agent/tools/form-links/`), whose descriptions say "The first matching condition wins; an
  unconditional route must be last" and whose target description says "Never this form itself,
  and never a chain that leads back here"; `update_form`'s `post_submit`, whose description ends
  "With conditional after-submit links and no otherwise link this is where the form goes when none
  match, and it must be explicit."
- Builder `components/builder/form-links/` (`FormLinksCanvas`, `FormLinkRow`, `OtherwiseRow`,
  `FallbackChooser`, `AddLinkControl`, `LinkTargetPicker`, `CarryValuesSection`,
  `FormLinkInspectorBody`, `afterSubmitCopy.ts`, `refusalCopy.ts`, `seeds.ts`, `linkSentence.ts`)
  and `components/builder/detail/formSettings/AfterSubmitSection.tsx`.
- Preview: `lib/preview/engine/formLinkEvaluation.ts::evaluateFormLinks(Async)` (first true wins),
  `lib/preview/afterSubmitRouting.ts::afterSubmitRoute`,
  `components/preview/screens/FormScreen.tsx::dispatchAfterSubmit`, and for App Tests and the
  server evaluator `lib/preview/engine/postSubmissionEvaluation.ts::evaluatePostSubmissionSnapshot`.

---

## 2. What CommCare does at the pins

### 2.1 HQ builds one frame per link, then the fallback

- `suite_xml/post_process/workflow.py::EndOfFormNavigationWorkflow.form_workflow_frames`: under
  `post_form_workflow == "form"` it appends `_get_link_frame(link)` for each of `form.form_links`
  in stored order, then `_get_fallback_frame` when it builds one. Any other workflow builds one
  static frame (`_get_static_stack_frame`).
- `_get_link_frame`: the frame's `if` is `link.xpath` as stored. A form target's children are
  `helper.get_frame_children(target_module, target_form)`, a module target's
  `_frame_children_for_module(target_module, include_user_selections=False)`; with `link.datums`
  they are matched by `_get_datums_matched_to_manual_values`, else by
  `_get_datums_matched_to_source`; a child target gets `prepend_parent_frame_children`.
- `_get_fallback_frame`: only when `post_form_workflow_fallback` is truthy;
  `conditions = [link.xpath for link in form.form_links if link.xpath.strip()]`; with none, no
  frame; else `' and '.join(f'not({condition})' …)` as the `if` of
  `_get_static_stack_frame(fallback, …)`. A link whose `xpath` is blank does not count. So HQ's
  fallback runs whenever no link *with a condition* holds, beside every unconditional link, and it
  is the last frame pushed.
- `_get_static_stack_frame`: `root` an empty frame, `module`
  `_frame_children_for_module(module, include_user_selections=False)`, `parent_module`
  `_frame_children_for_module(module.root_module)`, `previous_screen` the pop loop; `default` and
  any other word build no frame.
- `helpers/validators.py::FormBaseValidator.validate_for_module`: under `form` only `no form
  links` and `bad form link`; the build never checks the fallback, whether a target is offered,
  self links or cycles.

### 2.2 Core pushes every true frame; the last pushed runs first

- `session/CommCareSession.java::executeStackOperations` runs every operation;
  `processStackOp` → `createFrame` pushes a new frame only when `op.isOperationTriggered(ec)`. Every
  condition is evaluated in the one evaluation context of the source's completion, and each
  frame's datum values are fixed when it is pushed (`pushFrameStep` → `StackFrameStep.defineStep`).
- `finishExecuteAndPop` → `finishAndPop` pops the top of `frameStack`, the frame pushed last, and,
  when frames remain, calls `frame.captureSnapshot()`.
- At the next completion, `pushNewFrame` and `finishAndPop` both call `cleanStack()`, which drops
  every remaining frame when `frame.isSnapshotIncompatible()` (`session/SessionFrame.java`: the
  snapshot's steps must be a prefix of the current steps; an empty snapshot is never
  incompatible).
- So on Core's own session every true frame runs, last emitted first, each after the one above it
  finishes; the frames a destination's own form pushes run before the remaining ones; and a worker
  who leaves the path a frame opened drops every remaining frame at the next completion.
- `models/AndroidSessionWrapper.java::terminateSession` calls `session.finishExecuteAndPop(...)` and
  keeps the session when it returns true, `reset()` when it returns false;
  `activities/HomeScreenBaseActivity.java::processCanceledGetCommandOrCase` calls
  `currentState.reset()` when the worker steps back from the root menu and
  `getSession().stepBack(...)` otherwise. Android keeps Core's chain (G1 observes it).

### 2.3 What HQ's form settings page offers and what its save keeps

- `views/forms.py::_get_linkable_forms_context(module, langs)`: a candidate menu is listed when
  not `put_in_root` and `is_top_level or is_child_match`, where `is_child_match` is "the candidate
  is a child, the source module is a child, and `module.root_module.case_type ==
  candidate_module.root_module.case_type`", or under `FORM_LINK_ADVANCED_MODE` (every menu). Every
  form of every menu (`get_suite_forms()`), the current form included, is listed with
  `allow_manual_linking: True`.
- `views/forms.py::get_form_view_context` builds `form_workflows`, the main and fallback choices:
  `default` and `root` always; `module` when the module has no multi-select root and is not
  `put_in_root`; `previous_screen` when the module has no multi-select root (whether or not it is
  `put_in_root`) and is neither multi-select nor
  `util.py::module_uses_inline_search(module)` (offers search, `inline_search` and
  `auto_launch`); `parent_module` when a root exists, is not `put_in_root` and is not
  multi-select; `form` when the domain has `FORM_LINK_WORKFLOW` or the form already holds it.
- `static/app_manager/js/forms/bootstrap5/form_workflow.js::FormWorkflow` (the copy
  `static/app_manager/js/forms/form_view.js` imports): `self.formLinks` keeps
  only the links whose `uniqueId` is among the listed targets, so the save drops a link to an
  unlisted menu; `workflowFallbackOptions` is the labels less `form`. The fallback `<select>`
  (`templates/app_manager/partials/forms/form_workflow.html`) binds `value: workflowfallback`
  with `optionsCaption`, so a stored fallback outside the options posts the caption's empty value.
- `views/forms.py` (the settings POST, `form_links_xpath_expressions`, `datums_json`,
  `post_form_workflow_fallback`) writes each `xpath` verbatim, the datums as posted and the
  fallback as posted.

### 2.4 Formplayer runs only the frame on top

- `application/FormSubmissionHelper.java::doEndOfFormNav` →
  `services/MenuSessionRunnerService.java` (`finishExecuteAndPop(ec, observer)` at the end-of-form
  path, then `menuSessionFactory.rebuildSessionFromFrame(menuSession, caseSearchHelper)`).
- `services/MenuSessionFactory.java::rebuildSessionFromFrame` reads the popped frame's steps and
  calls `menuSession.resetSession()`, which (`session/MenuSession.java::resetSession`) builds a new
  `FormplayerSessionWrapper` with an empty frame stack and replays the steps. Every frame still
  pending beneath is discarded, and nothing later brings it back: each navigation request rebuilds
  a session from its selections.
- So in Web Apps, after a form whose links push several frames, the worker lands on the frame on
  top and the rest never run. G1 observes it.

### 2.5 HQ makes a case out of an update to a case nothing created

The register's two `d26-a-link-names-no-case-*` entries record HQ's soft assertion at
`corehq/form_processor/casedb_base.py::get_case_from_case_update` when a follow-up opened by a
link carrying `'patient-id'` submits an update to a case nothing created (on
`expander-form-links-emission-forwards-literal-condition-47c96355-0`, proof 3 and proof 4,
artifact `android@soft_assert:request:*`). Core's `CommCareSession.getFirstMissingDatum` checks
only that the key is present, so the linked form opens with whatever id the frame carried.

### 2.6 Claims corrected

These go into `docs/research/2026-09-26-hq-round-trip/harness-findings.md`, "Found while planning
step 5", in pull request 11 (each as G1's outcome leaves it, §19.1).

1. **Research, "Navigation and after-submit links"**: "Core pushes every frame whose condition is
   true, so every matching destination runs, last first." True of Core's session and of Android;
   Formplayer discards every pending frame when it rebuilds the session from the popped one, so in
   Web Apps only the frame on top runs.
2. **Manifest** `forms-and-case-writes/two-or-more-form-links-conditions-true-at-once` reads `RUNS /
   RUNS`; at the pins Web Apps reads `different`. Same correction for its inventory row
   (`docs/research/2026-09-26-hq-round-trip/inventory/forms-and-case-writes.md`, line 67).
3. **`lib/commcare/CLAUDE.md`, "Exclusive guards"**: "Core executes EVERY true `<create>` and lands
   on the LAST one". It lands on the last and, on Android, runs the others after it; in Web Apps
   the others are discarded.
4. **Research, defect 26**: "only the retiring `FORM_LINK_ADVANCED_MODE` offers the child menus" is
   incomplete: HQ's page also offers a child menu without the flag from a child menu whose parent's
   case type equals the target's parent's (§2.3). The design follows the page.
5. **`content/docs/form-links.mdx`, "On a device"**: "The installed app behaves the same way: the
   first true link wins" holds today only because Nova emits exclusive guards.
6. **The form-links brief behind this part, D13** (recorded so the next reader of the research
   does not repeat it): "the otherwise runs only when no destination runs" is not HQ's fallback.
   HQ's fallback counts only links with a non-blank `xpath` (§2.1), so it runs beside every
   unconditional link and before it. Decision 3 adopts HQ's meaning.

No Nova defect outside defect 26 was found in this area at the baseline.

---

## 3. The stored shapes

### 3.1 `lib/domain/forms.ts`

```ts
export const formLinkTargetSchema = z.discriminatedUnion("type", [
	z.strictObject({
		type: z.literal("form"),
		moduleUuid: uuidSchema,
		formUuid: uuidSchema,
	}),
	z.strictObject({
		type: z.literal("module"),
		moduleUuid: uuidSchema,
	}),
	/** Start this form again: the source form, in its own menu, wherever the
	 *  form is. A `form` target naming the source form is refused
	 *  (`FORM_LINK_SELF_REFERENCE`), so this is the one spelling. */
	z.strictObject({ type: z.literal("this-form") }),
]);

/** Where a form goes when no destination that may not run runs. `app_home`
 *  is no value: an absent otherwise is the app home. */
export const OTHERWISE_DESTINATIONS = [
	"firstMenu",
	"module",
	"parentMenu",
	"previous",
] as const satisfies readonly PostSubmitDestination[];
export type OtherwiseDestination = (typeof OTHERWISE_DESTINATIONS)[number];

export const formOtherwiseObjectSchema = z.discriminatedUnion("kind", [
	z.strictObject({
		kind: z.literal("destination"),
		destination: z.enum(OTHERWISE_DESTINATIONS),
	}),
	z.strictObject({
		kind: z.literal("link"),
		/** Immutable identity, in the same namespace as the form's links:
		 *  findings and the `form_link_datum_xpath` slot address it by it. */
		uuid: uuidSchema,
		target: formLinkTargetSchema,
		datums: z.array(formLinkDatumSchema).min(1).optional(),
	}),
]);
export const formOtherwiseSchema = formOtherwiseObjectSchema.superRefine(
	(value, ctx) => {
		if (value.kind === "link") uniqueFormLinkDatumNames(value.datums, ctx);
	},
);
export type FormOtherwise = z.infer<typeof formOtherwiseSchema>;
```

`formSchema` gains `otherwise: formOtherwiseSchema.optional()` beside `formLinks`. The doc comments
from step 5:

- `formLinks`: "Where the app goes after this form is submitted. Every destination whose
  condition holds runs, in array order: on Android each after the one before it finishes, in Web
  Apps only the first (`platforms.ts`, `after-submit-several-destinations`). A destination with no
  condition and no carried case runs every time. `otherwise` is where the form goes when no
  destination that may not run runs (`afterSubmit.ts::formLinkMayNotRun`). Array position is the
  order; each link carries its own uuid. `[]` is not a state: the reducers delete the slot when the
  last link goes."
- `otherwise`: "Present only beside `formLinks`, and only while some destination may not run
  (`FORM_OTHERWISE_UNREACHABLE`). A built-in destination or a link; absent, the app home follows."
- `postSubmit`: "Where a form without destinations goes after submit. Refused beside `formLinks`
  (`POST_SUBMIT_BESIDE_FORM_LINKS`); a form with destinations says where it goes when none runs
  with `otherwise`."

`formLinkObjectSchema` keeps its shape; its `condition` comment becomes "An absent condition runs
the destination every time, unless a carried case is not on the device. Blank authored text clears
it."

One helper, beside the schemas, is how every reader walks a form's links, destinations and the
otherwise link alike:

```ts
/** One link of a form as every rule, projection and index reads it: each
 *  destination in order, then the otherwise when it is a link. */
export type FormLinkEntry =
	| { readonly role: "destination"; readonly link: FormLink; readonly index: number }
	| {
			readonly role: "otherwise";
			readonly link: {
				readonly uuid: Uuid;
				readonly target: FormLinkTarget;
				readonly datums?: readonly FormLinkDatum[];
			};
	  };
export function formLinkEntries(
	form: Pick<Form, "formLinks" | "otherwise">,
): readonly FormLinkEntry[];
```

### 3.2 `lib/domain/formLinkTargets.ts` (new)

This module replaces `lib/domain/formLinkGraph.ts`, which is deleted: its adjacency and path
readers served only the cycle rule (decision 5), and its `formLinkDestination` moves here with the
source form it now needs.

```ts
/** A link target as the frame algorithm reads it: `this-form` is the source
 *  form in its own menu. `undefined` when the source form is in no menu. */
export function resolveFormLinkTarget(
	doc: Pick<BlueprintDoc, "formOrder">,
	sourceFormUuid: Uuid,
	target: FormLinkTarget,
):
	| { readonly type: "form"; readonly moduleUuid: Uuid; readonly formUuid: Uuid }
	| { readonly type: "module"; readonly moduleUuid: Uuid }
	| undefined;

/** Where a link goes, named for a person. */
export function formLinkDestination(
	doc: BlueprintDoc,
	sourceFormUuid: Uuid,
	target: FormLinkTarget,
):
	| { readonly kind: "form" | "module" | "this-form"; readonly name: string }
	| undefined;

/** Whether HQ's form settings page lists `targetModuleUuid` as a link target
 *  for a form of `sourceModuleUuid`
 *  (`views/forms.py::_get_linkable_forms_context`): a root menu always; a
 *  submenu only from a submenu whose parent's case type equals the target's
 *  parent's (`caseType ?? ""` on both sides, as HQ compares `case_type`). Nova
 *  has no display-only-forms menu, so HQ's `put_in_root` exclusion has no
 *  input here. */
export function menuTargetOffered(
	doc: Pick<BlueprintDoc, "modules">,
	sourceModuleUuid: Uuid,
	targetModuleUuid: Uuid,
): boolean;

/** The target when offered; else its parent, a root and so always offered,
 *  unless that parent is off the menu (`hiddenFromMenu`), which no link may
 *  target (`HIDDEN_MENU_NOT_A_DESTINATION`): then `undefined`. Nova's menus
 *  nest one tier (`moduleHierarchy.ts`), so one step up always reaches a root. */
export function nearestOfferedMenu(
	doc: Pick<BlueprintDoc, "modules">,
	sourceModuleUuid: Uuid,
	targetModuleUuid: Uuid,
): Uuid | undefined;
```

Every reader that today reads `link.target.moduleUuid` or `link.target.formUuid` reads
`resolveFormLinkTarget` instead; the `this-form` arm has neither field, so TypeScript finds each
one. At `main` they are: `lib/commcare/formLinkProjection.ts` (`targetFrameChildren`,
`formLinkTargetDatumIds`, `formLinkActionsBuildable`), `lib/commcare/validator/rules/form.ts`,
`rules/multiSelect.ts::formLinkSelectionCardinality`, `rules/hiddenFromMenu.ts::hiddenMenuLinkTargets`,
`lib/domain/entryDatumSupplies.ts::formLinkTargetSupplies`, `lib/domain/navigation.ts`,
`lib/doc/formLinkDependents.ts`, `lib/doc/formLinkReview.ts`, `lib/doc/mutations/forms.ts::moveForm`,
`lib/preview/afterSubmitRouting.ts`, `lib/preview/engine/formLinkEvaluation.ts`,
`components/builder/form-links/linkSentence.ts`, `lib/agent/tools/form-links/shared.ts`
(`linkLabel`, `linkSubject`). `moveForm` needs no rewrite for `this-form`: the arm names no menu.

### 3.3 `lib/domain/afterSubmit.ts` (new)

The domain statement of "may not run", read by the validator, the planners, the projection,
Preview, the platform detector and the builder:

```ts
/** The carried values of `link` that land on a single-case selection of its
 *  target: the ones the held-case guard covers (§5). A value that lands on a
 *  several-case selection names a selection, not a case, and is not guarded.
 *  Reads `formLinkTargetSupplies(doc, resolved target).refs[].scalar`. */
export function guardedLinkDatums(
	doc: BlueprintDoc,
	sourceFormUuid: Uuid,
	link: Pick<FormLink, "target" | "datums">,
): readonly FormLinkDatum[];

/** A destination may not run when it has a condition or a guarded carried
 *  value. Exactly the destinations whose emitted `xpath` is not blank. */
export function formLinkMayNotRun(
	doc: BlueprintDoc,
	sourceFormUuid: Uuid,
	link: FormLink,
): boolean;

/** Whether `formUuid` may hold an otherwise: some destination may not run. */
export function formOtherwiseReachable(doc: BlueprintDoc, formUuid: Uuid): boolean;

/** Whether, after `formUuid`, the worker can be left with no frame and so
 *  reach the app home: no destinations and an effective `postSubmit` of
 *  `app_home`, or destinations of which some may not run and no otherwise. */
export function afterSubmitCanGoHome(doc: BlueprintDoc, formUuid: Uuid): boolean;
```

`lib/domain/postSubmit.ts::effectivePostSubmit` from step 5 returns `undefined` for a form that
holds `formLinks` (its doc comment says so); its readers at `main` read it only for a form without
links (`expander.ts`, `compiler.ts`, `useCaseDatabaseSnapshot.tsx`, `navigationProjection.ts`) or
move to the after-submit plan (`postSubmissionEvaluation.ts`, `useFormLinkFacts.ts`,
`reconcilePostSubmitWithMenuShape`).

### 3.4 `lib/domain/navigation.ts`

`formNavigation(doc, formUuid, previousDestination?)` returns `{ recordSelection, afterSubmit }`
where `afterSubmit` becomes:

```ts
{
	/** In author order. */
	readonly destinations: readonly { readonly uuid: Uuid; readonly destination: NavigationDestination }[];
	readonly otherwise: NavigationDestination | undefined;
	/** A form without destinations: its after-submit. */
	readonly postSubmit: NavigationDestination | undefined;
}
```

`NavigationDestination` gains nothing: `this-form` projects to the source form's destination.

---

## 4. Offered targets and the offered otherwise

### 4.1 Menu targets

`FORM_LINK_TARGET_NOT_OFFERED` refuses a `module` target that `menuTargetOffered` rejects, on a
destination and on the otherwise link. Form targets are always offered (HQ lists every suite
form). `this-form` is offered (HQ lists the current form). `HIDDEN_MENU_NOT_A_DESTINATION` keeps
refusing an off-the-menu target, now on the otherwise link too.

The rule reads the source module's parent, the target's parent and both parents' case types. No
reducer retargets a link when one of those changes. A batch that changes them (`updateModule` with
`caseType`, a module moved under another parent, a form moved to another module) and leaves a link
to a submenu HQ no longer offers is refused by the gate with `FORM_LINK_TARGET_NOT_OFFERED`, whose
sentence names the link and the menu to point it at. Departure from the form-links brief (D13,
"callers plan the retarget in the same batch"): a planner that rewrites links on other forms as a
side effect of a move would change what the person did not ask to change; the case needs a
submenu target beside a change of parent or case type, and the refusal says what to do.

### 4.2 Datums on a menu

`FORM_LINK_MENU_DATUMS` refuses `datums` on a `module` target, destination or otherwise link. HQ's
page shows the datum editor for a menu only under the retiring flag (`allow_manual_linking` is
`FORM_LINK_ADVANCED_MODE` for menus, §2.3). The schema keeps `datums` optional on every target; the
rule owns the refusal so a retarget can state what it dropped.

### 4.3 The built-in otherwise

```ts
/** The built-in otherwise destinations `formUuid` is offered: the offered
 *  after-submit set less `app_home`, which an absent otherwise means. */
export function otherwiseDestinationsOffered(
	doc: PostSubmitDoc,
	formUuid: Uuid,
): OtherwiseDestination[];
```

in `lib/domain/postSubmit.ts`. `FORM_OTHERWISE_NOT_OFFERED` refuses another value and names the
first reason through `postSubmitNotOfferedReason`, which from step 5 reads the offered set only.
`postSubmitDestinationsAdmitted`, `MULTI_SELECT_REASONS` and `formHoldsLinks` are deleted;
`POST_SUBMIT_NOT_OFFERED` reads `postSubmitDestinationsOffered`; `postSubmitDestinationChoices`
returns the offered set (a stored value outside it is a finding, which the chooser shows as it
shows any finding). The reason that withholds `previous` for a search is `menu-forms-read-search`
from pull request 10 (part 05), read from `formsReadSearch`, so a menu that searches first without
keeping the search in its forms offers `previous` both as an after-submit destination and as an
otherwise. `menu-forms-read-search` is a fact of the menu, so it withholds `previous` from every form
of that menu, registration forms included. That is deliberately one step stricter than HQ, whose
`workflow previous inline search` refuses only when `form.requires_case()`
(`helpers/validators.py::FormBaseValidator.validate_for_module`), and it matches part 05 §6.2.

`lib/doc/mutations/modules.ts::reconcilePostSubmitWithMenuShape` also reconciles a built-in
otherwise that leaves `otherwiseDestinationsOffered` after an `updateModule`, to the nearest
offered: `previous` → `module` → `parentMenu` → `firstMenu`; `module` → `parentMenu` →
`firstMenu`; `parentMenu` → `firstMenu`. It stops reconciling "the form whose last link left"
(the planners own that, §9).

---

## 5. What may not run, and the held-case guard

### 5.1 The guard

For each carried value of a link that `guardedLinkDatums` returns, the link's emitted condition
gains one conjunct, built as a wire tree in
`lib/commcare/formLinkProjection.ts::formLinkCarriedCaseGuards`:

```ts
w.gt(w.call("count", [caseById(V, "casedb", T)]), w.num(0))
```

`V` is the value's wire tree (the same `projectFormLinkSessionExpression` output that prints into
the datum), `T` the case type of the target selection datum it lands on (the `FrameDatum.caseType`
that `formLinkTargetDatumIds` resolves; part 02 makes advanced datums carry it), and
`lib/commcare/xpath/wire/rowScope.ts::caseById` the existing builder, so it prints
`count(instance('casedb')/casedb/case[@case_id = V and @case_type = 'T']) > 0` in the serializer's
spelling and declares `casedb` through the instance sink like every printed read. A datum with no
case type omits the type test (`caseById`'s third argument absent). Departure from the form-links
brief (two predicates, `[@case_id = V][@case_type = 'T']`): the repo's one builder of a case-by-id
read is `caseById`, and one spelling is what step 6's reader strips (§21).

The emitted condition of a destination is then `C and G_1 and … and G_k`: its own condition `C`
(absent when it has none) and one `G` per guarded value, in `datums` order. When neither exists
the destination is unconditional and its `xpath` is `""`.

### 5.2 Why every carried value is guarded

Every guarded value is guarded, including a session value naming the case the source selected or
created. So "carries a case" is exactly "may not run" (decision 3) and HQ's fallback, which conjoins
every non-blank `xpath`, agrees with Nova's otherwise on both paths. Automatic matching (`datums`
absent) is never guarded: its values are the source entry's own session datums, which name cases
the source selected or created, and HQ derives those frames itself.

### 5.3 When the guard reads the device

Every runtime evaluates a form's post-entry stack operations after processing its submission: Core
through `AndroidSessionWrapper.terminateSession`, which runs `finishExecuteAndPop` once the form
record is processed; Formplayer's `FormSubmissionHelper` processes the form before
`doEndOfFormNav`; Nova's Preview already evaluates links against the post-submit device snapshot
(`FormLinkEvaluationInput.caseDatabase`). So a destination carrying the case its own form just
created runs. G2 observes it on every reader (§19.2).

### 5.4 What a destination whose case is missing does

A destination whose carried value names no case of its type on the device (a blank, a literal, an
id of another type, a case the worker does not hold) does not run, and the otherwise runs if no
other destination that may not run does. The REFUSED manifest class
`forms-and-case-writes/form-links-datums-that-leave-the-target-s-case-id-empty` ("the target form
opens with no case") stays REFUSED and is no longer reachable: such a frame never opens.

A carried value into a several-case selection is admitted as today and unguarded; it names a stored
selection, not a case (`MultipleInstanceDatum`, the `selected_cases` instance), and §18 records
that nothing at the baseline observes such a link.

---

## 6. Emission

### 6.1 The projection

`projectFormLinks(doc, ctx, formUuid)` becomes `projectAfterSubmit` and returns, for a form with
destinations:

```ts
export interface ProjectedFormLink {
	readonly uuid: Uuid;
	readonly role: "destination" | "otherwise";
	/** The emitted `if` / `xpath`; absent = unconditional. */
	readonly xpath?: WireExpr;
	/** The resolved target (`this-form` resolved to the source form). */
	readonly target: ResolvedFormLinkTarget;
	readonly children: MatchedChild[];
	readonly datums: ReadonlyArray<{ readonly name: string; readonly xpath: WireExpr }>;
	readonly unmatched: readonly FrameDatum[];
	readonly missing: readonly FrameDatum[];
	readonly unused: readonly string[];
	readonly unrepresentableQueryDatums?: readonly string[];
}
export interface ProjectedAfterSubmit {
	/** In emitted order: the destinations in REVERSE array order, then the
	 *  otherwise link when the otherwise is one. */
	readonly links: readonly ProjectedFormLink[];
	readonly fallback:
		| { readonly kind: "none" }
		| {
				readonly kind: "built-in";
				readonly destination: OtherwiseDestination;
				/** `not(x_1) and … and not(x_n)` over every emitted destination
				 *  `xpath`, in emitted order (HQ's `_get_fallback_frame`). */
				readonly xpath: WireExpr;
		  };
}
```

`planFormLinkGuards`, `GuardPlan`, `GuardPlanLink` and `FallbackPlan` are deleted; `formLinkGuard`
goes with them.

- **A destination's `xpath`**: `w.and(C, …G)` over its condition and its guards (§5.1), absent when
  both are.
- **An otherwise link's `xpath`**: `w.and(…destinations.flatMap(d => d.xpath ? [w.not(d.xpath)] :
  []), …G_otherwise)`, the negation of every non-blank destination `xpath` in emitted order, then
  the otherwise's own guards. A single conjunct prints `not(x_1)`; the serializer prints a call's
  argument with no grouping, so each `x_i` inside `not(…)` prints exactly as its own `xpath`.
- **A built-in otherwise**: the fallback above, `post_form_workflow_fallback` its workflow word
  (`firstMenu` → `root`, `module` → `module`, `parentMenu` → `parent_module`, `previous` →
  `previous_screen`, `session.ts`'s existing projection), and the local suite writes HQ's fallback
  frame: the static frame of that destination (`moduleDestinationFrameChildren`,
  `parentMenuDestinationFrameChildren`, `previousFrameChildren`, or the empty `root` frame) with
  the fallback `xpath` as its `if`. That is HQ's own derivation, so both paths print the same
  bytes.
- **No otherwise**: `post_form_workflow_fallback` `null`, no fallback frame.
- `post_form_workflow` stays `"form"` exactly when `formLinks` exists; a form without destinations
  emits its effective `postSubmit` word as today. The plan privilege `form_link_workflow`
  (`lib/commcare/planPrivileges.ts`) keeps its rule: an otherwise exists only beside destinations.
- **`this-form`**: `form_id` the source form's derived id and `form_module_id` its menu's; frame
  children, automatic and manual datums follow the form-target rules, so a follow-up starts again
  on the same case and a registration on a new one (its `uuid()` datum).

`lib/commcare/session.ts::deriveFormLinkStack` prints `ProjectedAfterSubmit.links` in order, then
the fallback frame. `lib/commcare/expander.ts::toHqFormLink` prints each link;
`post_form_workflow_fallback` reads `fallback`. `lib/commcare/validator/hqJsonOracle.ts::checkFormLinks`
resolves the source form's ids for a `this-form` link.

### 6.2 An example

A follow-up "Visit" in menu "Patients" (case type `patient`), destinations in author order: A to
form "Refer" when `#case/risk = 'high'`, B to menu "Clinics" every time, C to form "Review" carrying
`case_id` from `#case/reviewer_case` (a property holding a `patient` id); otherwise
`{ kind: "destination", destination: "module" }`.

| Emitted order | `form_links[i]` | `xpath` |
|---|---|---|
| 0 | C | `count(instance('casedb')/casedb/case[@case_id = <reviewer read> and @case_type = 'patient']) > 0` |
| 1 | B | `""` |
| 2 | A | `<risk read> = 'high'` |

`post_form_workflow` `"form"`, `post_form_workflow_fallback` `"module"`, and the fallback frame's
`if` is `not(<C's xpath>) and not(<A's xpath>)`. On Android, with high risk and the reviewer case
held: A runs first, then B, then C. With low risk and the reviewer case held: B, then C. With low
risk and no reviewer case: the otherwise (the menu) first, then B. In Web Apps the first of each.

---

## 7. Validator

### 7.1 Retired

Removed from `lib/commcare/validator/errors.ts`, `lib/doc/userFacingErrors.ts`,
`validator/runner.ts` and `validator/gate.ts`'s classification, `lib/doc/formLinkReview.ts`, and the
manifest cell that names them (`form-links-target-the-current-form-or-a-link-cycle`):

| Code | Why |
|---|---|
| `FORM_LINK_UNREACHABLE` | Every destination that holds runs; one that runs every time blocks none after it. |
| `FORM_LINK_NO_FALLBACK` | An absent otherwise is the app home (HQ's `default`), a real answer. |
| `FORM_LINK_CIRCULAR` | Cycles are admitted (decision 5); a worker leaves a cycle by Back or Home. `rules/app.ts` loses the rule. |

### 7.2 Kept

Meaning unchanged, applied from step 5 to every `formLinkEntries` entry (destinations and the
otherwise link): `FORM_LINK_EMPTY`, `FORM_LINK_TARGET_NOT_FOUND`,
`FORM_LINK_TARGET_CASE_LIST_REGISTRATION_FORM` (pull request 10's name),
`FORM_LINK_DATUMS_INCOMPLETE`, `FORM_LINK_DATUM_UNUSED`, `FORM_LINK_DATUM_TARGET_COLLISION`,
`FORM_LINK_SEARCH_CASE_UNREPRESENTABLE`, `FORM_LINK_SELECTION_CARDINALITY`,
`FORM_LINK_SELECTION_CASE_TYPE_CHANGED`, `FORM_LINK_NEEDS_NEW_CASE_DATUM` (part 02),
`HIDDEN_MENU_NOT_A_DESTINATION` (arm `link`), `POST_SUBMIT_NOT_OFFERED` (a form without
destinations), and `CASE_LIST_REGISTRATION_HAS_NAVIGATION` (pull request 10), which keeps reading
`formLinks`: an otherwise exists only beside destinations, so that finding covers it. Each finding
on the otherwise link carries `details.linkUuid` (the otherwise's uuid) and `details.role:
"otherwise"`; `userFacingErrors.ts::formLinkPhrase` reads the role and says "its Otherwise" for it.

### 7.3 Changed

`FORM_LINK_SELF_REFERENCE`: a `form` target naming the source form.

- Validator message: `"${form}" ${label} names "${form}" itself as a form target. Use the target {"type":"this-form"}, which starts this form again and keeps meaning this form if it moves.`
- Builder sentence: `In ${q(form)}, ${formLinkPhrase(e)} points back at this form by name. You can choose Start this form again, which keeps working if the form moves.`

### 7.4 New

All are soundness codes in `rules/form.ts::formLinkValidation` unless named, join
`ValidationErrorCode`, the user-facing table (whose type requires every non-oracle code) and the
tool refusal sentences, and carry `details.linkUuid` and `details.role` where a link is involved.

| Code | Refuses | Validator message (model and tools) | Builder sentence (`userFacingErrors.ts`) |
|---|---|---|---|
| `FORM_LINK_TARGET_NOT_OFFERED` | a `module` target `menuTargetOffered` rejects | `"${form}" ${label} opens "${menu}", a submenu CommCare HQ doesn't offer as a link target from "${module}": a submenu is a target only from a submenu whose parent has the same case type as its own parent. Point the link at "${parent}", which holds it, or at a form inside "${menu}".` | `In ${q(form)}, ${formLinkPhrase(e)} opens ${q(menu)}, a submenu CommCare HQ can't link to from here. You can point it at ${q(parent)}, which holds it, or at a form inside it.` |
| `FORM_LINK_MENU_DATUMS` | `datums` on a `module` target | `"${form}" ${label} carries values to the module "${menu}", whose form list asks for none. Remove the link's datums, or point it at a form in "${menu}" that reads them.` | `In ${q(form)}, ${formLinkPhrase(e)} carries values to ${q(menu)}, and a module's form list asks for none. You can remove the carried values, or send the link to a form inside it.` |
| `FORM_OTHERWISE_NOT_OFFERED` | a built-in otherwise outside `otherwiseDestinationsOffered` | `notOfferedSentence(reason, …)` with "after submit" read as "when no destination runs", then `Choose one of: ${offered}, or remove the otherwise so the app home follows.` | `postSubmitNotOfferedSentence(e)` with `details.slot: "otherwise"`: each reason's "goes to ${phrase} after submit" reads "goes to ${phrase} when no destination runs", and the offered list omits App home, then `You can also remove the Otherwise, and the app home follows.` |
| `FORM_OTHERWISE_UNREACHABLE` | an otherwise on a form where no destination may not run, or with no destinations | with destinations: `"${form}" sets an otherwise, but every destination runs each time, so the otherwise never runs. Give a destination a condition or a carried case, or remove the otherwise with set_form_otherwise null.`; without: `"${form}" sets an otherwise but has no destinations. Add a destination, or remove the otherwise.` | `${q(form)}'s Otherwise can never run, because every destination runs each time. You can give a destination a condition, or remove the Otherwise.` |
| `POST_SUBMIT_BESIDE_FORM_LINKS` | `postSubmit` on a form with `formLinks` | `"${form}" has after-submit destinations and also sets post_submit, which only a form without destinations uses. Remove post_submit, and set where it goes when no destination runs with set_form_otherwise.` | `${q(form)} has destinations and a separate After submit setting, which only a form without destinations uses. You can remove the setting and choose an Otherwise instead.` |

Departure from the form-links brief: its `FORM_OTHERWISE_SAME_MENU` (an otherwise link to the form's
own menu) is not added. HQ builds the two from different functions (`_get_link_frame` with
`prepend_parent_frame_children` against `_get_static_stack_frame(WORKFLOW_MODULE)`), and where the
built-in `module` is withheld (a parent that selects several cases) the link is the only way to
that menu; the cutover keeps a terminal unconditional link to the own menu as an otherwise link
(L2), and step 6 reads each HQ shape as itself. The builder's otherwise chooser lists "This
module" and leaves the own menu out of "Another form or module" where This module is offered
(§12), an offering choice, not a rule.

### 7.5 The checker

`lib/domain/expression/context.ts`: `form.links.get(linkUuid)` resolves the otherwise link too
(built by `expression/formStructure.ts` from `formLinkEntries`), with `targetSupplies =
formLinkTargetSupplies(doc, resolveFormLinkTarget(…))`. The otherwise link has no condition slot;
its datums take `form_link_datum_xpath` with `member: { linkUuid: otherwise.uuid, datum }`.
`lib/domain/referenceSlots.ts::expressionSlotValues` yields them. No checker reason changes (G2's
outcome B adds one, §19.2).

### 7.6 The incremental footprint

`lib/doc/incrementalValidationScope.ts`: `setFormOtherwise` adds its form, like the four link kinds;
the comment on the link kinds loses its cycle sentence and says "Media and after-submit links
mutate only their owning form; the offered-target rule reads module parents and case types, which
an `updateModule` with `caseType` and a module move already send to the whole-document gate."
(`updateModule` with `caseType` returns `undefined` at `main`; a module move falls to `default`.)

---

## 8. Mutations and the reducer

### 8.1 `setFormOtherwise`

`lib/doc/types.ts`: `finalMutationFamily` gains `formOtherwise: formOtherwiseSchema`, and the
mutation union gains:

```ts
z.strictObject({
	kind: z.literal("setFormOtherwise"),
	formUuid: uuidSchema,
	/** The form's otherwise; `null` clears it. */
	otherwise: mutationFormOtherwiseSchema.nullable(),
}),
```

- Reducer, `lib/doc/mutations/forms.ts::setFormOtherwise`: writes `form.otherwise`, deletes the
  key for `null`; registered in `mutations/index.ts`.
- `mutationTargetAdmission.ts`: the form exists.
- `mutationIdentityAdmission.ts`: a link otherwise's `uuid` is a new identity in the global
  entity-UUID namespace (`lib/domain/authoredIdentities.ts` walks `otherwise.uuid`), or the uuid of
  the destination or otherwise the same batch removed earlier (the planners' conversions keep a
  link's uuid, §9). `mutationSequenceAdmission.ts` admits that order.
- `referenceIndex.ts` extracts the otherwise link's target and datum expressions under
  `form_link_datum_xpath`; the existing incremental-equals-rebuild oracle covers the kind.
- `diffDocsToMutations.ts` emits `setFormOtherwise` for a changed `otherwise`, before any
  `addFormLink` in the same diff only when the old otherwise is removed (so a conversion replays).
- Undo derives the inverse from the prior value (the store's existing inverse capture).
- `store.ts` names the kind where it switches over link kinds.
- `lib/doc/hooks/useBlueprintMutations.ts` exposes `setFormOtherwise(formUuid, otherwise)`.

### 8.2 Kinds that change

- `addFormLink`, `updateFormLink`, `removeFormLink`, `moveFormLink`: shapes unchanged; their
  reducers keep deleting `formLinks` when the last link goes and do not touch `otherwise` (the
  planners pair the batch, §9; the gate refuses an orphaned otherwise, `FORM_OTHERWISE_UNREACHABLE`).
- `updateForm.patch.postSubmit`: shape unchanged; the gate refuses it beside links.
- `moveForm` rewrites a pointing otherwise link's `moduleUuid` as it rewrites a link's;
  `formLinkDependents.ts` counts an otherwise link as a dependent of the form or module it targets,
  so removing one is refused or planned as for a link.

### 8.3 The app change log

`setFormOtherwise` is a mutation-bearing kind like the others: `autosave`, `mcp` and `chat` rows
carry it, and multiplayer folds it. No migration: the log stores mutations as JSON, and the kind
CHECK constrains the change kind, not the mutation kind.

---

## 9. Planners (`lib/doc/formLinkMutations.ts`)

The file's header from step 5: "The batch-building planners for a form's after-submit
destinations and its otherwise. Every planner returns a batch the gate admits: the first
destination turns the form's after-submit into its otherwise, removing the last destination turns
the otherwise back into the form's after-submit, and an edit that leaves no destination that may
not run removes the otherwise. Each says what it did, so a tool's message and the builder's toast
name it."

### 9.1 The plan

```ts
export interface AfterSubmitPlan {
	/** Every destination, in author order. */
	readonly destinations: readonly FormLink[];
	/** The destinations that may not run (`formLinkMayNotRun`). */
	readonly mayNotRun: readonly FormLink[];
	readonly otherwise: FormOtherwise | undefined;
	/** Whether an otherwise may be set now: `mayNotRun.length > 0`. */
	readonly otherwiseOffered: boolean;
	/** A form without destinations: its after-submit, stored or default. */
	readonly postSubmit:
		| { readonly destination: PostSubmitDestination; readonly explicit: boolean }
		| undefined;
}
export function afterSubmitPlan(doc: BlueprintDoc, formUuid: Uuid): AfterSubmitPlan | undefined;
```

`AfterSubmitFallback`, `formLinkIsConditionalIn`'s use as "the otherwise test", `elseLink`,
`conditional` and `fallbackMustBeExplicit` are deleted.

### 9.2 Refusals and reports

```ts
export type FormLinkRefusal =
	| { readonly kind: "form-not-found" }
	| { readonly kind: "link-not-found"; readonly uuid: Uuid }
	| { readonly kind: "duplicate-uuid"; readonly uuid: Uuid }
	| { readonly kind: "target-not-found" }
	/** A `form` target naming the source form. */
	| { readonly kind: "self-target" }
	| { readonly kind: "target-not-offered"; readonly menuUuid: Uuid; readonly parentUuid: Uuid | undefined }
	| { readonly kind: "menu-carries-values" }
	| { readonly kind: "selection-cardinality" }
	| { readonly kind: "otherwise-unreachable" }
	| { readonly kind: "otherwise-not-offered"; readonly destination: OtherwiseDestination; readonly reason: PostSubmitNotOfferedReason }
	| { readonly kind: "otherwise-exists" }
	/** `planMakeDestination` on a form whose otherwise is not a link. */
	| { readonly kind: "no-otherwise-link" }
	| { readonly kind: "stale-base" };

export type FormLinkCommitPlan =
	| {
			readonly ok: true;
			readonly mutations: readonly Mutation[];
			/** The form's after-submit became its otherwise. */
			readonly movedToOtherwise?: OtherwiseDestination;
			/** A stored after-submit that would never run again was removed. */
			readonly droppedPostSubmit?: PostSubmitDestination;
			/** No destination that may not run remained, so the otherwise went. */
			readonly droppedOtherwise?: FormOtherwise;
			/** The last destination left: the otherwise became the form's after-submit. */
			readonly otherwiseToPostSubmit?: OtherwiseDestination;
			/** The last destination left: the otherwise link became the sole destination. */
			readonly otherwiseToDestination?: Uuid;
			/** Carried values a retarget dropped (a menu, or names the new target does not read). */
			readonly droppedDatums?: readonly string[];
	  }
	| { readonly ok: false; readonly reason: FormLinkRefusal };
```

`cycle`, `else-exists`, `after-else`, `else-not-last` and `pinsFallback` are deleted.

### 9.3 Each planner

- **`planFormLinkAdd(doc, formUuid, link, after?)`.** Refuses `form-not-found`, `duplicate-uuid`,
  `target-not-found`, `self-target`, `target-not-offered`, `menu-carries-values`,
  `selection-cardinality`. On a form without destinations: when the new destination may not run
  and the form's effective after-submit is in `otherwiseDestinationsOffered`, the batch adds
  `setFormOtherwise { kind: "destination", destination }` and reports `movedToOtherwise`, so where
  the worker goes when the condition is false does not change; a stored `postSubmit` is cleared in
  the same batch (`updateForm { postSubmit: null }`), reported as `droppedPostSubmit` when it did
  not move. `app_home`, or a destination that may not move, leaves no otherwise. On a form with
  destinations, nothing else changes: adding a destination never strands an otherwise.
- **`planFormLinkUpdate(doc, formUuid, uuid, patch)`.** Refuses as add, and `link-not-found`. A
  retarget to a menu drops carried values (`droppedDatums`), as a retarget to a form drops the
  names its target does not read today. When the result leaves no destination that may not run
  and an otherwise exists, the batch adds `setFormOtherwise null` and reports `droppedOtherwise`.
- **`planFormLinkRemove(doc, formUuid, uuid)`.** Removing the last destination: a built-in
  otherwise becomes the form's `postSubmit` (`setFormOtherwise null`, `updateForm { postSubmit }`,
  `otherwiseToPostSubmit`); an otherwise link becomes the sole destination with its uuid, target and
  datums and no condition (`removeFormLink`, `setFormOtherwise null`, `addFormLink`,
  `otherwiseToDestination`); with no otherwise the form takes its type's default. Removing the
  last destination that may not run while others remain removes the otherwise
  (`droppedOtherwise`).
- **`planFormLinkMove(doc, formUuid, uuid, after)`.** Any order; refuses `link-not-found` and a
  missing anchor.
- **`planSetOtherwise(doc, formUuid, otherwise | null)`** replaces `planSetFallback`. Refuses
  `form-not-found`; `otherwise-unreachable` when no destination may not run; for a built-in,
  `otherwise-not-offered`; for a link, `self-target`, `target-not-found`, `target-not-offered`,
  `menu-carries-values`, `selection-cardinality`, and `duplicate-uuid` for a uuid in use elsewhere.
  The caller mints the link's uuid (the builder and the tool each mint one).
- **`planMakeOtherwise(doc, formUuid, linkUuid)`.** A destination becomes the otherwise link with
  the same uuid, target and datums; its condition goes. Refuses `otherwise-exists` when one is
  stored, and `otherwise-unreachable` when no *other* destination may not run.
- **`planMakeDestination(doc, formUuid)`.** The otherwise link becomes the last destination with
  its uuid, target and datums and no condition; the otherwise slot clears. Refuses
  `no-otherwise-link` when the otherwise is built-in or absent. Only the builder offers the action,
  on a link otherwise; no tool needs it, because `set_form_otherwise null` and `add_form_links`
  say the same thing.

### 9.4 Review and choices

- `lib/doc/formLinkReview.ts`: `formLinkTargetVerdict` drops `self` and `cycle` and adds
  `not-offered` (from `menuTargetOffered`, naming the parent); `formLinkMoveVerdicts` answers every
  index `ok`; `formLinkAddChoices` offers `conditional` ("Go somewhere when a condition is true"),
  `every-time` ("Go somewhere every time", part 07's copy, in pull request 11) and `otherwise`
  (only while `otherwiseOffered` and no otherwise is stored).
- `lib/doc/formLinkTargetChoices.ts`: the target choices begin with `this-form`; menus
  `menuTargetOffered` rejects are listed with `{ offered: false, parentUuid }`; no cycle marking.
- Hooks: `useAfterSubmitPlan` returns the new plan; `useFormLinks` and `useFormLinkFacts` drop
  `postSubmitDestinationChoices` beside links and gain `otherwiseDestinationsOffered`.

---

## 10. The platform feature

This section is written for G1's outcome A; §19.1 gives what outcomes B and C change.

### 10.1 The row

`lib/domain/platforms.ts`: `PLATFORM_FEATURE_IDS` gains `"after-submit-several-destinations"` after
`"after-submit-home"`, and `PLATFORM_FEATURES` its row:

```ts
"after-submit-several-destinations": {
	label: "Several after-submit destinations",
	channel: "structure",
	webApps: {
		reading: "different",
		note: "after submit, only the first destination that applies opens",
	},
	android: { reading: "runs" },
},
```

It reads `different`, never `unavailable`, so it refuses nothing: no
`REFUSABLE_PLATFORM_FEATURE_IDS` entry, no refusal copy, no `platformFeatureFixtures.ts` refusal
fixture, no `PLATFORM_CAUSE_WORDS` entry. Departure from the research and the manifest (claims 1
and 2): they read RUNS / RUNS.

### 10.2 The detector

`lib/domain/platformUses.ts`, in the per-form block beside `after-submit-home`: a form whose
`formLinks` holds two or more destinations uses the feature, `slotUse("after-submit-several-destinations",
formOwner, "formLinks")`. Two destinations are needed for two frames, and an otherwise beside an
every-time destination needs a destination that may not run, so two or more covers every case
where more than one frame can be pushed.

The `after-submit-home` detector changes with the model: a form uses it when
`afterSubmitCanGoHome(doc, formUuid)` (§3.3), with slot `"postSubmit"` for a form without
destinations and `"otherwise"` for a form with them.

### 10.3 The manifest binding

`lib/commcare/surface/platformFeatureEntries.ts` maps the feature to
`forms-and-case-writes/two-or-more-form-links-conditions-true-at-once`, whose readings flip with it
(§13.4); `lib/commcare/surface/__tests__/platformFeatures.test.ts` binds them.

### 10.4 Where the author meets it

The builder's note row (`components/builder/shared/PlatformNoteRow.tsx` over
`lib/doc/hooks/usePlatformNotes.ts`) is mounted under the destination list of the after-submit
screen (`FormLinksCanvas`), stating the feature for the inspected form in an app that declares Web
Apps and in a form with two or more destinations (part 07 §3.11). `components/builder/CLAUDE.md`'s
note-row sentence gains "the after-submit list (`after-submit-several-destinations`)". The guide's
sentence is part 07's, in pull request 11 with the rest of the after-submit paragraph
(`${platformSentence("after-submit-several-destinations")}`), placed by `platformGuide.test.ts`
after the sentence that introduces destinations (§21).

---

## 11. Preview and App Tests

### 11.1 Evaluation

`lib/preview/engine/formLinkEvaluation.ts`: `evaluateFormLinks(Async)` becomes
`evaluateAfterSubmit(Async)`:

```ts
export type AfterSubmitFrameChoice =
	| { readonly kind: "destination"; readonly link: FormLink; readonly index: number }
	| { readonly kind: "otherwise-link"; readonly link: FormOtherwiseLink }
	| { readonly kind: "otherwise"; readonly destination: OtherwiseDestination }
	| { readonly kind: "post-submit"; readonly destination: PostSubmitDestination };

/** The frames the device pushes after this submission, in push order (the
 *  last is on top). For a form with destinations: each projected link whose
 *  emitted `xpath` holds (blank holds), in emitted order, then the built-in
 *  otherwise when its `xpath` holds. For a form without: its after-submit's
 *  frame, none for `app_home`. Every `xpath` is the projection's
 *  (`projectAfterSubmit`) printed by `serializeWire`, and all are evaluated in
 *  the one post-submit world, as Core evaluates them in one context. */
export async function evaluateAfterSubmitAsync(args: {
	readonly input: FormLinkEvaluationInput;
	readonly evaluate: FormLinkAsyncEvaluator;
	readonly world?: FormLinkWorkerWorld;
}): Promise<readonly AfterSubmitFrameChoice[]>;
```

The synchronous twin keeps its signature shape. `formLinksRequireCaseDatabase(doc)` is true also
when any link carries a guarded value. `carriedCaseFor`, `projectTargetCaseSelections(Async)` and
`automaticLinkedCaseCollection` take a `FormLinkEntry` and run per frame.

`lib/preview/afterSubmitRouting.ts::afterSubmitRoute` takes an `AfterSubmitFrameChoice`: a built-in
otherwise routes as a post-submit destination (`previous` through `resolvePreviousTask`), an
otherwise link as a link, `this-form` through `resolveFormLinkTarget`. `AfterSubmitRoute` is
unchanged.

### 11.2 The rule

`lib/preview/platform.ts::PreviewPlatformRules` gains:

```ts
/** What runs when a form pushes several frames. Core's session runs every
 *  frame, the last pushed first, and Android keeps it
 *  (`session/CommCareSession.java::finishAndPop`,
 *  `models/AndroidSessionWrapper.java::terminateSession`); Formplayer
 *  rebuilds its session from the frame on top and drops the rest
 *  (`services/MenuSessionFactory.java::rebuildSessionFromFrame` →
 *  `session/MenuSession.java::resetSession`). */
readonly afterSubmitFrames: "stack" | "top";
```

`"top"` for `web-apps`, `"stack"` for `android`.

### 11.3 The stack, `lib/preview/afterSubmitStack.ts` (new, pure)

```ts
/** One step of a session path, as Core's frame steps name them. */
export type AfterSubmitPathStep =
	| { readonly kind: "menu"; readonly moduleUuid: Uuid }
	| { readonly kind: "case"; readonly moduleUuid: Uuid; readonly caseIds: readonly string[] }
	| { readonly kind: "form"; readonly moduleUuid: Uuid; readonly formUuid: Uuid };

/** A pushed frame: where it goes, computed when it is pushed (Core fixes a
 *  frame's datums then, `StackFrameStep.defineStep`), and the steps it
 *  installs, which become the snapshot when it is popped with frames left. */
export interface PendingAfterSubmitFrame<Route> {
	readonly route: Route;
	readonly landing: readonly AfterSubmitPathStep[];
}

export interface AfterSubmitStackState<Route> {
	readonly pending: readonly PendingAfterSubmitFrame<Route>[];
	/** The landing of the frame popped last while frames remained. */
	readonly snapshot: readonly AfterSubmitPathStep[] | undefined;
}

export const EMPTY_AFTER_SUBMIT_STACK: AfterSubmitStackState<never>;

/** One completion: drop the pending frames when `submittedPath` does not
 *  begin with the snapshot (Core's `cleanStack`), push this submission's
 *  frames in push order, pop the top. `next` is undefined when nothing is
 *  left, which is the app home (`postSubmitAppHome`). Under `"top"` nothing
 *  stays pending. */
export function completeAfterSubmit<Route>(
	state: AfterSubmitStackState<Route>,
	submittedPath: readonly AfterSubmitPathStep[],
	pushed: readonly PendingAfterSubmitFrame<Route>[],
	mode: PreviewPlatformRules["afterSubmitFrames"],
): { readonly next: Route | undefined; readonly state: AfterSubmitStackState<Route> };

/** Whether `path` begins with `snapshot`, step by step (`caseIds` compared
 *  as ordered lists); an empty snapshot is always compatible
 *  (`SessionFrame.isSnapshotIncompatible`). */
export function pathBeginsWith(
	path: readonly AfterSubmitPathStep[],
	snapshot: readonly AfterSubmitPathStep[],
): boolean;
```

The rules, each Core's:

1. At a submission, when `snapshot` is defined and the submitted entry's path does not begin with
   it, `pending` empties and `snapshot` clears.
2. The submission's frames are pushed in emitted order (the last on top).
3. The top frame pops and routes. When frames remain, `snapshot` becomes its `landing`; else it
   clears.
4. Under `"top"`, after the pop `pending` empties and `snapshot` clears.
5. A frame's `landing`: a form route installs its module chain's menu steps, a case step per
   selection its route carries, and the form step; a module route its chain's menu steps and the
   selections it carries; a previous-task route the steps of the task it returns to; a built-in
   `firstMenu` none (the empty `root` frame); `module` and `parentMenu` that menu's chain and the
   selections the static frame keeps.
6. The submitted entry's path is built the same way from the entry the worker submitted (its
   module chain, the menu selections it opened with, its form).

### 11.4 Session state

`lib/session/store.ts` gains `previewAfterSubmitStack: AfterSubmitStackState<AfterSubmitRoute>`,
ephemeral like `previewTaskContinuation`, with one action `setPreviewAfterSubmitStack`. It resets
to `EMPTY_AFTER_SUBMIT_STACK` everywhere `previewTaskContinuation` clears: `clearPreviewNavigation`
(Home), `setPreviewPlatform`, `setPreviewPersonaUuid`, `setPreviewing` both ways, a confirmed
Project change, `reset()`; and in `setPreviewAtDeviceHome(true)` (Android's `reset()` when the
worker steps back from the root menu). `lib/session/CLAUDE.md` gains its lifetime line.

### 11.5 `FormScreen`

`components/preview/screens/FormScreen.tsx::dispatchAfterSubmit` from step 5: evaluate the frames
(`evaluateAfterSubmitAsync`), compute each frame's route and landing at once (the case selections
and carried case per frame), call `completeAfterSubmit` with the submitted entry's path and
`rules.afterSubmitFrames`, store the state, and route `next`, or land on the app home when it is
undefined. Web Apps' hidden-target landing (`afterSubmitHiddenTarget: "landing"`) is read for the
route that pops; under `"top"` that is the only one ever routed. No React Testing Library test of
`FormScreen` is added (the state model and Playwright hold it, §17).

### 11.6 App Tests and the server evaluator

- `lib/preview/engine/postSubmissionEvaluation.ts::evaluatePostSubmissionSnapshot` returns
  `{ frames: readonly { route, selections, collection }[] }` in push order, each frame's case data
  loaded as today for its own selections.
- `lib/preview/app-tests/types.ts::AppTestSessionState` gains `afterSubmitStack:
  AfterSubmitStackState<AppTestAfterSubmitRoute>`; `lib/preview/app-tests/submission.ts` routes
  `next` through `completeAfterSubmit` under the session's platform; `run.ts` and `service.ts`
  initialize it empty; a change of worker and `device-home` empty it.
- `lib/preview/app-tests/retainedState.ts`: a stored session may lack the field ("A session
  retained before after-submit stacks existed has none pending"), restored as
  `EMPTY_AFTER_SUBMIT_STACK`, the pattern `claimedCaseIds` uses.
- `lib/db/appTests.ts::RUNTIME_VERSION` stays where pull request 3 sets it (18): one deploy carries
  the stack (decision 14 of the plan).

### 11.7 The Preview cell

`lib/preview/__tests__/platformCells.ts` gains
`"forms-and-case-writes/two-or-more-form-links-conditions-true-at-once@web-apps":
model("after-submit-top-frame-web-apps")`, and `platformCellModels.ts` the check: under
`previewPlatformRules("web-apps")`, a form with two every-time destinations pushes two frames,
`completeAfterSubmit` routes the first (the author's first) and leaves nothing pending, and after
that destination's own submission with its own destination the route is that destination, never
the second. Android reads `runs`, which needs no cell; `afterSubmitStack.test.ts` holds it.

### 11.8 `lib/preview/CLAUDE.md`

"End-of-form links": "**First true wins, evaluated as the device's XPath after the write.**" →
"**Every destination that holds, evaluated as the device's XPath after the write, then each
platform's stack.** The frames are the projection's (`projectAfterSubmit`): every destination
whose condition and carried-case guards hold, in emitted order, and the otherwise when none that
may not run does. Android runs each after the one above it finishes and drops the rest when the
worker leaves the path a destination opened; Web Apps opens only the top one
(`platform.ts::afterSubmitFrames`, `afterSubmitStack.ts`)."

---

## 12. Authoring surfaces pull request 11 carries

Every piece below reads an export the model change removes or states a rule it retires, so it moves
in pull request 11 (decision 11), whole and final. The copy is part 07's (its §3.11 for the builder,
its "Form link tools (pull request 11)" for the tools, its guide paragraph for pull request 11);
where part 07 gives a sentence, this section quotes it, and the sentences part 07 does not cover
(the toasts, the tool refusals, the otherwise row's subtitle) are this part's. Pull request 12 adds
no second version of anything here.

### 12.1 Builder

- `FormLinksCanvas.tsx`: the list's heading "After this form, these run in order"; every destination
  row draggable anywhere, no cycle disabling; the otherwise row last and fixed; the
  `after-submit-several-destinations` note row under the list (§10.4).
- `FormLinkRow.tsx` and `linkSentence.ts`: each row's condition line "Every time" or "When
  <condition>".
- `FallbackChooser.tsx` → `OtherwiseChooser.tsx`: lists `otherwiseDestinationsOffered` (each with
  `afterSubmitCopy.ts`'s label), "Another form or module" (an otherwise link, through the target
  picker; the form's own menu is left out where "This module" is offered), and "The app home" (no
  otherwise); writes through `planSetOtherwise`. The `after-submit-home` note row stays mounted on
  it.
- `OtherwiseRow.tsx`: shown while `plan.otherwiseOffered` or an otherwise is stored (so a finding
  has a place); a stored otherwise shows its sentence; absent reads "Otherwise, back to the app
  home"; its subtitle reads "When no destination with a condition or a carried case runs. It opens
  before any destination that runs every time." (the last sentence only while such a destination
  exists).
- `AddLinkControl.tsx`: "Go somewhere every time" (a destination with no condition, anywhere in the
  list), "Go somewhere when a condition is true" (seed `false()`, `seeds.ts`), and "Otherwise, go
  somewhere else", which opens the otherwise chooser and, while `otherwiseOffered` is false, is
  disabled with "Give a destination a condition first, so there is a time when none runs."
- `LinkTargetPicker.tsx`: "Start this form again" first; no cycle disabling; menus
  `menuTargetOffered` rejects listed disabled with "CommCare HQ can't link to this submenu from
  here. You can choose <parent> or a form inside it."
- `FormLinkInspectorBody.tsx`: "Make this the otherwise" through `planMakeOtherwise` (offered by its
  refusals), "Make this a destination" on the otherwise link through `planMakeDestination`.
- `CarryValuesSection.tsx`: hidden for a menu target; a carrying destination's row adds "When the
  case it carries is on the worker's device".
- `refusalCopy.ts` and `afterSubmitCopy.ts`: lose the `cycle`, `else-exists`, `after-else` and
  `else-not-last` sentences with the planner reasons §9.2 removes; gain the refusal kinds of §9.2,
  `target-not-offered` among them and `otherwise-unreachable` reading "Give a destination a
  condition first, so there is a time when none runs."; the commit reports of §9.2 as toasts
  ("Where this form went after submit is now its Otherwise.", "This form's Otherwise is gone, because every destination now runs each time.",
  "This form's Otherwise is now where it goes after submit.").
- `components/builder/detail/formSettings/AfterSubmitSection.tsx`: reads the new plan; "Goes to <x>"
  for a form without destinations; "Runs <n> destinations in order", or "Opens <x>" for one, with
  "Otherwise <y>" beside it for a form with them.
- `components/builder/form-links/__tests__/formLinkValidByConstruction.test.ts` replays every
  offered choice through the gate (§17).

### 12.2 Tools (SA and MCP, one schema each)

Part 07's descriptions under G1's outcome A, final, quoted from its "Form link tools (pull request
11)"; their outcome B and C variants are part 07's (§19.1).

- `lib/agent/tools/form-links/shared.ts::formLinkInputSchema`: the target gains
  `z.strictObject({ type: z.literal("this-form") })`. Descriptions:
  - `condition`: `Session-scope XPath; when it holds, this destination runs. Null or omitted runs it every time. It runs after the form has closed, so it reads case-ref, #user and session values, never form answers: save the answer to a case property first.`
  - `target`: `{"type":"form","moduleUuid","formUuid"} opens that form; {"type":"module","moduleUuid"} opens that module's list; {"type":"this-form"} starts this form again. A submenu is a target only from a submenu whose parent has the same case type as its parent.`
  - `datums`: `Explicit session values carried into the target. Only for a form or this-form. Omit or null to let CommCare match the target's case from this form's session. When present, name every selection datum the target needs; a partial list is refused. The destination runs only when the worker's device holds a case of its type with each carried id.`
- Tool descriptions:
  - `add_form_links`: `Add after-submit destinations. Every destination whose condition holds runs, in the order you set: the first opens after the form, and each next one when the worker finishes the one before. In Web Apps only the first that holds opens. Conditions read saved records and worker values after the form closes, so they cannot use unsaved answers. Set where the worker goes when no destination with a condition or a carried case runs with setFormOtherwise/set_form_otherwise. ${HIDDEN_TARGET_NOTE}`; its `links` array: `Destinations in the order they run.`; its `afterLinkUuid`: `UUID of the existing destination the new ones should follow, null to put them first, or omit to add them at the end.`
  - `update_form_link`: `Replace one after-submit destination, keeping its place in the order. ${HIDDEN_TARGET_NOTE}`
  - `move_form_link`: `Reorder an after-submit destination. Destinations run in this order, and any order is admitted.`; its `afterLinkUuid`: `UUID of the destination this one should follow, or null to put it first.`
  - `remove_form_link`: `Remove an after-submit destination. Removing the last one makes the form's otherwise its after-submit destination; removing the last one with a condition or a carried case removes the otherwise.`
- New shared tool `set_form_otherwise` / `setFormOtherwise`
  (`lib/agent/tools/form-links/setFormOtherwise.ts`), registered in
  `lib/agent/sharedToolRegistry.ts` with the scope `updateFormLink` declares (`requires: "edit"`),
  `lib/agent/toolPresentation.ts` (`change("Setting where the form goes otherwise", "Set where the
  form goes otherwise")`), `lib/chat/toolSummary.ts` ("Set where the form goes otherwise"), and
  `scripts/test-schema.ts` (with `moveFormLink` and `removeFormLink`, whose descriptions this pull
  request first changes, and `addFormLinks`'s prompt gaining a `this-form` link, part 07 §4.8; the
  billed run is asked once, at pull request 13's head, and no other pull request runs it). Input,
  part 07's:
  ```ts
  export const setFormOtherwiseInputSchema = formAddressSchema.extend({
  	otherwise: z
  		.discriminatedUnion("kind", [
  			z.strictObject({
  				kind: z.literal("destination"),
  				destination: z
  					.enum(OTHERWISE_DESTINATIONS)
  					.describe('"firstMenu" (the app\'s first menu), "module" (this module\'s first screen), "parentMenu" (the parent module) or "previous" (the preceding selection or task), each only where the module offers it, as post_submit says.'),
  			}),
  			z.strictObject({
  				kind: z.literal("link"),
  				target: formLinkTargetSchema,
  				datums: z.array(formLinkDatumInputSchema).min(1).nullable().optional(),
  				linkUuid: uuidSchema.nullable().optional().describe("Stable UUID for the otherwise link; omit to let Nova mint it."),
  			}),
  		])
  		.nullable()
  		.describe("Where the worker goes when no destination with a condition or a carried case runs: a built-in destination, or a form or module like a destination's target. null goes to the app home."),
  });
  ```
  Description: `Set where the worker goes after this form when none of its destinations with a condition or a carried case runs. It opens before any destination that runs every time. Offered only while some destination might not run, because it has a condition or carries values; null goes to the app home.`
  The tool maps each arm onto `FormOtherwise` of the same `kind` (a `link` takes `linkUuid` as its
  `uuid`, minted when omitted or null), plans through `planSetOtherwise`, and its refusals
  read `linkRefusalMessage`.
- `linkRefusalMessage` (`shared.ts`) for the new kinds:
  - `self-target`: `To open form "${name}" again after it is submitted, use the target {"type":"this-form"} rather than naming the form.`
  - `target-not-offered`: `CommCare HQ doesn't offer "${menu}" as a link target from form "${name}": a submenu is a target only from a submenu whose parent has the same case type as its own parent. Target "${parent}", which holds it, or a form inside "${menu}".`
  - `menu-carries-values`: `A destination that opens a module carries no values, because a module's form list asks for none. Leave datums out, or target a form in that module.`
  - `otherwise-unreachable`: `Form "${name}" has no destination with a condition or a carried case, so an otherwise would never run. Give a destination a condition before setting an otherwise.`
  - `otherwise-not-offered`: `Form "${name}"'s module doesn't offer "${destination}" when no destination runs: ${reason}. Choose one of: ${offered}, or set the otherwise to null so the app home follows.`
  - `otherwise-exists`: `Form "${name}" already has an otherwise. Change it with set_form_otherwise, or remove it first.`
  - `no-otherwise-link` (builder only, `refusalCopy.ts`): `This form's Otherwise isn't a link, so there's no destination to make from it.`
  - each commit report as a sentence the result's message appends (`movedToOtherwise`: `Where the form went after submit, "${x}", is now its otherwise.`; `droppedOtherwise`: `Its otherwise was removed, because every destination now runs each time.`; `otherwiseToPostSubmit`: `Its otherwise, "${x}", is now where it goes after submit.`; `otherwiseToDestination`: `Its otherwise link is now its only destination.`; `droppedPostSubmit`: `Its after-submit setting, "${x}", was removed, because a destination now always runs.`).
- `update_form`'s `post_submit` description loses its last sentence and gains part 07's `A form with after-submit destinations takes no post_submit; set where it goes when none runs with setFormOtherwise/set_form_otherwise.`; a call setting it beside links refuses with the validator's `POST_SUBMIT_BESIDE_FORM_LINKS` message, which ends `…set where it goes when no destination runs with set_form_otherwise.` (§7.4).
- `get_form` returns `otherwise` (`{kind: "destination", destination}` or `{kind: "link", linkUuid, target, datums?}`) and its links listed as `destinations`, "in the order they run".
- `lib/agent/summarizeBlueprint.ts`: a form's link line reads `destinations: <a>, <b>; otherwise: <c>`.
- The guide (`lib/agent/authoring/reference.ts`, `workflows`), after `Save a needed answer before using it in a later route.`, inserts part 07's paragraph: `After a form, every destination whose condition holds runs, in the order you set: the first opens, and each next one opens when the worker finishes the one before. ${platformSentence("after-submit-several-destinations")} A destination that carries a case runs only when the worker's device holds that case, and the this-form target starts the form again. setFormOtherwise says where the worker goes when no destination with a condition or a carried case runs, and it opens before any destination that runs every time; without one, the worker goes to the app home.`
- `lib/models.ts::MODEL_CONTEXT_VERSION` becomes `"v6-hq-round-trip-case-writes.11"`.
- `lib/mcp/__tests__/servedSchemas.test.ts` holds the served schemas.

### 12.3 What pull requests 12 and 13 add (part 07)

Pull request 12 adds nothing to the after-submit surface: "Go somewhere every time", the list's
heading and row lines, the settings row's run states and part 07's copy over §12.1 all land in pull
request 11, and no second version of them follows. Pull request 13 adds nothing to it either. The
`../nova-plugin` claims this part makes false ("the first matching condition wins", "an
unconditional route must be last", "never this form itself") are swept by part 07 §6, which found at
`105836d` that the plugin's skills teach no link behavior, and swept again at pull request 13's head
(part 10's re-sweep); a hit there joins the same plugin pull request.

---

## 13. Proof

### 13.1 Register moves (all 18 of defect 26)

Group A, "a link's case value names no case", document and control
`expander-form-links-emission-forwards-literal-condition-47c96355-0`:
`d26-a-link-names-no-case-soft-assert-casedb-base-get-case-from-case-update` (proof 4) and
`d26-a-link-names-no-case-soft-assert-proof3-casedb-base-get-case-from-case-update` (proof 3).
The test behind the document (`lib/commcare/__tests__/expander.test.ts`, "forwards literal
condition + datum overrides") keeps its name, so the document keeps its id
(`proof/corpus/documents.ts::readExpanderCapture` names it by its first test), and takes the
migrated shape: `postSubmit: "module"` becomes `otherwise: { kind: "destination", destination:
"module" }`, and the literal stays. Its link's `xpath` becomes `true() and count(instance('casedb')/casedb/case[@case_id = 'patient-id' and @case_type = 'patient']) > 0`
in the serializer's spelling and `post_form_workflow_fallback` `"module"`; the follow-up never
opens and the otherwise runs. Both entries move to `proof/fixed-defects.json` on that control.

The defect 21 entry on the same document
(`d21-list-first-turned-search-fir-formplayer-case-list-submit-nextscreen-type`) moves in pull
request 10 (part 05), which lands first; pull request 11's lane keeps it fixed on its control.

Group B, "hidden links and navigation fallbacks", document and control
`targeted-form-links-hidden-and-fallback`: the manifest entries
`d26-form-links-app-not-offered-under-conditional-link`,
`d26-form-links-app-form-links-other-module-target`,
`d26-form-links-app-module-unique-id-other-module-target`; the proof 4 app, suite and trace
entries `d26-form-links-app-form-links`, `d26-form-links-app-post-form-workflow-fallback`,
`d26-form-links-suite-stack-create`, `d26-form-links-trace-stackaftersubmit-nextframeready`,
`d26-form-links-trace-stackaftersubmit-steps`, `d26-form-links-trace-steps-type`; and the proof 4
reader entries `d26-hidden-links-and-navigation--formplayer-form-settings-submit-nextscreen`,
`d26-form-links-webapps-form-settings-breadcrumbs`, `-commands`, `-commands-icon`,
`-commands-text`, `-route-selections`, `-title` (16).
`proof/targeted/documents/formLinksHiddenFallback.ts` is rewritten in its migrated shape: the
Frogs form's link to Ponds (a child of Sites, not offered from top-level Frogs) targets Sites
(L4); its second link's condition becomes `#user/username = 'bea' and not(#user/username =
'alice')` (L1); its `postSubmit: "previous"` (not offered in a several-case menu) becomes
`otherwise: { kind: "destination", destination: "module" }` (L3, then L6). The form settings save
then changes nothing, so the document holds the fix; its header comment says so. Every entry moves
to `proof/fixed-defects.json` on the control of that name, whose retained bytes keep showing each
symptom.

`proof/checks/registers.py::OPEN_DEFECTS` loses `26: 5`. `proof/README.md`'s defect 26 rows read
"fixed; still shown by the controls" (part 08 writes the row).

### 13.2 Targeted documents

Part 08 holds the one list of names; this part's three documents are on it, each declared both
platforms with rows `["26"]`, appended in pull request 11. This part writes their content.

**`targeted-form-link-chain`** (`proof/targeted/documents/formLinkChain.ts`). It holds:

- menu **Start** (no case type) with survey **Begin**, three every-time destinations in order: form
  **First** (menu **A**), form **Second** (menu **A**), menu **B**; **First** has its own every-time
  destination, form **Nested** (menu **A**). Menu **A** holds surveys **First**, **Second**,
  **Nested**; menu **B** a survey **Done**.
- survey **Begin both** in **Start**: `#user/username = 'alice'` to **Second**, then `true()` to
  menu **B**.
- its edit D′: `moveFormLink` making **Begin**'s menu **B** destination first, so proof 5 runs over
  a reorder and the document is the edited one a mechanics dispatch needs.

Intent (`proof/targeted/expected.ts`): Core's session runs **Begin**, **First**, **Nested**,
**Second**, menu **B**; the Android reader the same screens; Formplayer and the Web Apps client
**Begin**, **First**, **Nested**, then the app's first screen (§19.1 outcome A). It is G1's document.

**`targeted-form-link-otherwise`** (`proof/targeted/documents/formLinkOtherwise.ts`). It holds:

- root menu **Households** (case type `household`) with registration **Add household** (a
  `this-form` destination, every time: "register another"); its child menu **Checks** (case type
  `member`, `member` a child of `household`, the cross-type nesting
  `proof/targeted/documents/csqlComposition.ts` already builds) with registration **Add member**,
  follow-up **Review member**, and four follow-ups, each with one destination to **Review member**
  when `#user/username = 'alice'` and a built-in otherwise: `firstMenu`, `module`, `parentMenu`,
  `previous` (each offered: neither menu selects several cases, neither searches, both are on the
  menu); and a fifth follow-up **Check link** whose destination is the same and whose otherwise is
  a link to **Review member** carrying `case_id` from the form's own selected case.
- root menu **Loop** (no case type) with surveys **Ping** and **Pong**, a cycle: **Ping** to
  **Pong** when `#user/username = 'alice'`, **Pong** to **Ping** when `#user/username = 'bea'`.
- root **Rounds** (case type `household`) with registration **Add round household** and child
  **Round checks** (case type `member`) with follow-up **Round review**; **Review member** in
  **Checks** has a destination to menu **Round checks** (offered: both parents have case type
  `household`, HQ's child match).

Intent: as alice each follow-up of **Checks** opens **Review member**, and as anyone else each opens
its otherwise; **Ping** and **Pong** alternate as their conditions say; **Add household** starts
again. The walk's script bound ends a walk at the restarted form's submission for **Add household**;
a walk that reaches `WalkBound` there is a walk defect fixed in pull request 11 (part 08 §3's rule).
It is the document `form-links-target-the-current-form-or-a-link-cycle` flips on, G3's main
document, and the one `proof/views/test_form_link_targets.py` reads (§13.6).

**`targeted-form-link-carried-case`** (`proof/targeted/documents/formLinkCarriedCase.ts`). Case
types `household` and `member` (`member` a child of `household`). Root **Households**
(`household`) with registration **Add household**; its child **Members** (`member`) with
registration **Register member** and follow-up **Check member**. **Register member**'s
destinations, all to **Check member**, each carrying `case_id`: the literal `'no-such-case'`; the
new member's id (the form's own created case, a `new-case` session value); the selected
household's id (a case of the wrong type); otherwise `{ kind: "destination", destination:
"firstMenu" }`. A second registration **Register member quietly** holds only the literal and the
household destinations and the same otherwise. Intent: after **Register member** only the
destination carrying the new member opens, and after **Register member quietly** the otherwise
does. The walk makes every case it reads; no case is seeded. It is G2's document. Departure from the
form-links brief, which seeded a household and purged a member: a walk cannot purge a case, and the
new-case destination tests the brief's harder claim, that the guard reads the device after the
submission lands.

The migration witness `targeted-migration-form-links` is part 08's (§5.2 there), whose pre-step A
(built at `main`, pull request 1) holds two conditional links and a terminal unconditional link, a
stored `postSubmit` beside a conditional link, a link to a submenu HQ does not offer, and datums on
a menu link, so its migrated B (pull request 11) is §14's map of each (L1 to L5). L6 is witnessed by
`targeted-form-links-hidden-and-fallback`'s migrated shape (§13.1), whose `previous` beside links in
a several-case menu L3 then L6 move.

Each targeted document that holds a link shape the gate refuses from step 5 takes its migrated
shape in pull request 11, as written by `mapFormLinkSemantics` and committed as source:
`targeted-instance-reads` (`instanceReads.ts`: two conditional links, L1; `postSubmit: "module"`,
L3), `targeted-inline-search-reads` (`inlineSearchReads.ts`: `postSubmit: "module"` beside a
`true()` link, L3), `targeted-form-links-hidden-and-fallback` (above). Every other targeted
document with links (`formLinkHiddenTarget.ts`, `hiddenFromMenu.ts`, `nativeSessionReads.ts`,
`formShapes.ts`) holds single every-time links or none beside a `postSubmit` and is unchanged; the
gate in `proof/targeted/build.ts::targetedDocument` refuses any it missed.

### 13.3 Corpus and fuzz

- `lib/commcare/__tests__/formLinkWireFixture.ts`: `formLinkWireScenarios` keeps its ids, so the
  producer documents `form-link-<scenario>` keep theirs (`proof/corpus/producers.ts`). `else`
  holds the otherwise link L2 writes; `module`, `previous` hold the built-in otherwise L3 writes;
  `home` holds no otherwise; `overlap` holds L1's conditions and the otherwise link; `manual`
  holds the guarded literal. Three new scenarios, the ones part 08's `FormLinkRuntimeTest` names,
  each a new producer document (`form-link-chain`, `form-link-this-form`, `form-link-carried-held`,
  part 08's corpus count): `chain` (a destination to **Visit** when `#user/username = 'alice'`,
  then an every-time destination to menu **Frog care**, beside the built-in otherwise
  `firstMenu`: as alice both run in author order, and as anyone else the otherwise opens first and
  the every-time destination after it), `this-form` (the registration with a `this-form`
  destination, every time), and `carried-held` (a destination to **Visit** carrying the literal
  `'no-such-frog'`, a case the device never holds, then a destination to **Visit** carrying the new
  case when `#user/username = 'alice'`, beside the built-in otherwise `module`: as alice the first
  pushes no frame and the second opens, and as anyone else neither runs and the otherwise opens).
  The guard's false arm on a literal alone stays `manual`'s. Departure from the brief, which renamed
  `else`: renaming it would move a corpus id the timings and the mechanics dispatch name, for a word
  only the fixture reads.
- `proof/corpus/editKinds.ts`: the link edit kinds call the planners; `planSetFallback` becomes
  `planSetOtherwise`; a kind that made a terminal unconditional link makes an otherwise; the new
  kind `setFormOtherwise` is part 08's (§4.4 there: on a form holding a conditional link,
  `planSetOtherwise` to the first destination `otherwiseDestinationsOffered` gives; on a form with
  none, the batch first adds a conditional link to another form of the menu through
  `planFormLinkAdd`).
- `proof/corpus/footprint.ts` counts `otherwise` with its form.
- The proof sample's three generators (`lib/commcare/__tests__/xformDocArbitrary.ts::blueprintDocArbitrary`,
  `suiteDocArbitrary.ts`, `expressionDocArbitrary.ts`) draw no form link at `main` and gain none
  (part 08 §4.3: the sample keeps its draws, and a shape new in step 5 is witnessed by a targeted
  document), so they need no form-link mapping and `mapFormLinkSemantics` is no step of
  `lowerToDoc`. The new link shapes are drawn by this part's own arbitrary, which the proof sample
  does not use: `lib/commcare/__tests__/formLinkProjection.property.test.ts`'s generator draws
  destinations with and without conditions at any position, carried values whose cases the device
  holds or does not, and both otherwise kinds (§17).
- Documents whose content changes take new evidence keys; part 08 owns the reruns and CI cost.

### 13.4 Manifest and inventory (`lib/commcare/surface/entries/forms-and-case-writes.json`)

| Entry id (prefix `forms-and-case-writes/`) | At `main` | From pull request 11 |
|---|---|---|
| `two-or-more-form-links-conditions-true-at-once` | HELD-NEW, RUNS / RUNS | HELD, `**HELD**: \`formLinks\`: every destination that holds runs, in author order`; platforms `each`, cell `DIFFERENT (only the first destination that applies opens) / RUNS`, webApps `different` "after submit, only the first destination that applies opens", android `runs`; emission "each destination's own condition and held-case conjuncts, in reverse author order"; feature `after-submit-several-destinations` |
| `form-links-target-the-current-form-or-a-link-cycle` | HELD-NEW | HELD, `**HELD**: \`target {type: this-form}\`, and cycles`; emission "the source form's ids" |
| `post-form-workflow-fallback-module-or-previous-screen-offered-in` | HELD, "`postSubmit` after the conditional links" | HELD, "`otherwise {destination: module \| previous}`" |
| `post-form-workflow-fallback-root-or-parent-module-offered-in` | HELD, "`postSubmit: firstMenu` / `parentMenu` after the conditional links" | HELD, "`otherwise {destination: firstMenu \| parentMenu}`" |
| `form-links-datums-on-a-form-target-names-among-the-target-s` | HELD, emission `datums[]` | HELD, emission "`datums[]`; each value on a single-case selection adds a held-case conjunct to `xpath`" |
| `form-links-xpath` | HELD | HELD, emission "the condition, then the held-case conjuncts" |
| `post-form-workflow-fallback-module-parent-module-or-previous` | REFUSED | REFUSED, unchanged (`FORM_OTHERWISE_NOT_OFFERED`; Nova no longer emits it) |
| `form-links-target-any-other-module` | REFUSED | REFUSED, unchanged (`FORM_LINK_TARGET_NOT_OFFERED`) |
| `form-links-datums-with-other-names-or-on-a-module-target` | REFUSED | REFUSED, unchanged (`FORM_LINK_MENU_DATUMS`) |
| `form-links-datums-that-leave-the-target-s-case-id-empty` | REFUSED | REFUSED, unchanged (the guard keeps such a frame from opening) |
| `post-form-workflow-form` | HELD `Form.formLinks` | unchanged |

Each changed cell edits its row in
`docs/research/2026-09-26-hq-round-trip/inventory/forms-and-case-writes.md` (lines 56, 57, 63,
66, 67, 68 at `main`) in the same pull request. No new value class: the otherwise link is a link
(`form-target`, `module-target`), the held-case guard part of `link-condition`. The REFUSED class
`failing-link-checks` is refused by HQ's build alone (`not-hq-buildable`), so the bar holds it and
it needs no reader in `proof/checks/manifest_value_classes.py::VALUE_CLASSES`. The HELD-NEW flips
follow part 08's manifest rules.

### 13.5 Native proofs

- `proof/native/core/FormLinkRuntimeTest.java` (part 08 §6.1 holds the row):
  `completionChoosesFirstTrueLinkAndCarriesTheChosenCase` becomes
  `completionRunsEveryDestinationThatHoldsInTheAuthorsOrder`: over the wire fixture's scenarios
  (`emit-form-link-evidence.ts`), the new `chain`, `this-form` and `carried-held` among them, for
  each username, count the triggered operations, then call `finishExecuteAndPop` repeatedly and
  read each command in order, on the local suite and HQ's regenerated one; the assertion is the
  order G1 observes on Core (expected: the author's first that holds first, and under `chain` as
  anyone but alice the otherwise before the every-time destination). New
  `aSelfLinkStartsTheFormAgain`: the `this-form` scenario's command is the source form's own entry,
  so a self link starts the form again. New `aCarriedCaseNotOnTheDevicePushesNoFrame`: the
  `carried-held` scenario pushes no frame for the destination carrying `'no-such-frog'`, pushes the
  destination carrying the new case as alice, and the otherwise frame instead as anyone else, and
  `manual` pushes no frame for its guarded literal.
  `absentSourceRaisesAndEmptySourceNeverPromptsForTargetCase` keeps its automatic-match half; its
  manual half asserts the guard leaves no frame for a blank value.
- `proof/native/producers/emit-form-link-evidence.ts`: unchanged mechanism, the new scenario list.
- `proof/native/test_navigation_emission.py`: HQ's regenerated `xpath` and fallback bytes equal the
  local `if` bytes for every scenario.

### 13.6 Reader test of the offered targets

`proof/views/test_form_link_targets.py` (part 08 §6.2 adds it to its reader tests): HQ's form
settings page's link targets for each form of `targeted-form-link-otherwise` equal the targets Nova's
validator admits for the same form, read from the JSON fixture
`lib/commcare/__tests__/fixtures/formLinkTargets.json` that
`lib/commcare/__tests__/formLinkTargets.test.ts` (new) writes from the production rule (each
candidate menu and form of the document, kept where the validator raises no
`FORM_LINK_TARGET_NOT_OFFERED`); with and without `FORM_LINK_ADVANCED_MODE`. It holds
`menuTargetOffered` to HQ's own page.

---

## 14. Migration classes (into the one cutover)

### 14.1 The map

`lib/doc/formLinkSemanticsMap.ts` (new, pure; it stays after pull request 16, as part 10 keeps it, with
the test that holds §14.5's behavior claim every migrated app rests on):

```ts
export type FormLinkSemanticsChange =
	| { readonly kind: "conditions-written"; readonly formUuid: Uuid; readonly linkUuids: readonly Uuid[] }
	| {
			readonly kind: "otherwise-set";
			readonly formUuid: Uuid;
			readonly otherwise: FormOtherwise;
			/** L6: the built-in destination it replaced, which the menu does not offer. */
			readonly from?: OtherwiseDestination;
	  }
	| { readonly kind: "after-submit-dropped"; readonly formUuid: Uuid; readonly destination: PostSubmitDestination }
	| { readonly kind: "target-moved"; readonly formUuid: Uuid; readonly linkUuid: Uuid; readonly from: Uuid; readonly to: Uuid }
	| { readonly kind: "datums-dropped"; readonly formUuid: Uuid; readonly linkUuid: Uuid; readonly to: Uuid }
	/** §14.4: a link to a submenu HQ does not offer whose parent is off the
	 *  menu, removed; `to` is the submenu it opened. */
	| { readonly kind: "link-removed"; readonly formUuid: Uuid; readonly linkUuid: Uuid; readonly to: Uuid };

/** Defect 26's map over a document parsed by the head schema: L1 to L6, in
 *  that order, each form's L1 to L3 computed over its original link list.
 *  Total and idempotent: a second application returns no change. */
export function mapFormLinkSemantics(doc: BlueprintDoc): {
	readonly doc: BlueprintDoc;
	readonly changes: readonly FormLinkSemanticsChange[];
};
```

The cutover's step `form-link-semantics` (part 09) calls it in the semantics phase, as pull request
11 lands it; the corpus producers' and targeted documents' migrated sources are its output written
as source. No generator of the proof sample draws a form link (§13.3), so the fuzz mapping does not
call it.

### 14.2 The classes

L1, L2 and L3 read each form's original link list; then L4, L5, L6 run in order; L7 is emission
only.

| Class | Source shape | Target shape | Identified by | Change (notice reason) |
|---|---|---|---|---|
| L1 guards into conditions | links where link *i* ≥ 2 follows a conditional link | link *i*'s `condition` := `{ kind: "and", clauses: [c_i, { kind: "not", clause: c_1 }, …, { kind: "not", clause: c_{i-1} }] }` over the conditions of the earlier conditional links, built directly with no simplification, so each original condition stays one clause and prints as today's guard did; a terminal unconditional link (L2) is left to L2 | `formLinks.length >= 2` and some link with an earlier conditional link | `conditions-written` (`form-links-conditions-written`, `links` the count) |
| L2 terminal else to otherwise | last link unconditional after at least one conditional link | the link leaves `formLinks`; `otherwise = { kind: "link", uuid, target, datums }` with its uuid; a stored `postSubmit` is deleted | last link has no condition and an earlier one has one | `otherwise-set` (`form-link-otherwise-set`, `to` the target's name); `after-submit-dropped` for a deleted `postSubmit` (`after-submit-destination-dropped`) |
| L3 after-submit beside links | `postSubmit` stored beside `formLinks` | every link conditional: `otherwise = { kind: "destination", destination: postSubmit }`, except `app_home` (no otherwise); a sole unconditional link: `postSubmit` deleted, since it never ran (`afterSubmitPlan` at `main`) | `formLinks` and `postSubmit` both present (after L2) | `otherwise-set` (`form-link-otherwise-set`, `toDestination` the word); `after-submit-dropped` (`after-submit-destination-dropped`) |
| L4 unoffered menu target | a `module` target `menuTargetOffered` rejects, on a destination or the otherwise link | `target.moduleUuid` := `nearestOfferedMenu(...)` | `menuTargetOffered(doc, source, target) === false` | `target-moved` (`form-link-target-moved`, `from` and `to` menu names); when `nearestOfferedMenu` is undefined (the parent is off the menu), the link is removed and the form normalized as `planFormLinkRemove` does: `link-removed` (`form-link-removed`, `to` the submenu's name, §14.4) |
| L5 menu datums | `datums` on a `module` target | `datums` deleted | `target.type === "module" && datums !== undefined` | `datums-dropped` (`form-link-datums-dropped`, `to` the menu's name) |
| L6 unoffered otherwise | a built-in otherwise (from L3) outside `otherwiseDestinationsOffered` | the nearest offered: `module`, else `parentMenu`, else `firstMenu` | `!otherwiseDestinationsOffered(doc, form).includes(d)` | `otherwise-set` with `from` (`form-link-otherwise-set`, §14.3) |
| L7 held-case guard | a link or otherwise link with guarded `datums` | no stored change; from the next publish the destination runs only when the device holds each carried case | `guardedLinkDatums(...)` non-empty | none (§14.3) |

No stored self link or cycle exists at `main` (both refused), so `this-form` needs no class.

Every class preserves the invariants the head validator holds: after L1 every destination that
followed a conditional link is conditional, so an L2 or L3 otherwise always has a destination that
may not run; L4 retargets to a menu the source may target, and when the otherwise link's new target
is the form's own menu it stays an otherwise link (§7.4), and its removal normalizes the form as
`planFormLinkRemove` does, so no otherwise is left without a destination that may not run; L5 leaves
no menu target with values. The
cutover's retargets of links that carried a new extension case (part 01 and part 02, step
`extension-children`) apply to the map's output and preserve them: they target menus
`nearestOfferedMenu` gives and drop the carried values, and no such link is the only destination
that may not run beside an otherwise, because only links that follow a conditional link carry an
otherwise beside them and L1 left those conditional. `linkCarriedCreates` (part 02) reads only
targets and datums, which the map changes only for menu targets, which carry no created case, so
it answers the same over the document before and after the map.

### 14.3 Notices

The notice reasons are the cutover's canonical list (the plan's decision 13; part 09 owns the record
in `lib/notices/migrationNoticeCopy.ts`). This part maps each change onto it:

| Change | Reason | Detail |
|---|---|---|
| `conditions-written` | `form-links-conditions-written` | `links` |
| `otherwise-set` (L2) | `form-link-otherwise-set` | `to` (the otherwise link's target, a name) |
| `otherwise-set` (L3) | `form-link-otherwise-set` | `toDestination` (an `OtherwiseDestination` word) |
| `otherwise-set` with `from` (L6) | `form-link-otherwise-set` | `toDestination`, `from` (the word it replaced) |
| `after-submit-dropped` | `after-submit-destination-dropped` | none |
| `target-moved` | `form-link-target-moved` | `from`, `to` |
| `link-removed` (§14.4) | `form-link-removed` | `to` |
| `datums-dropped` | `form-link-datums-dropped` | `to` |

`form-link-otherwise-set`'s canonical copy ends "That is where they went before.", which is false
for L6, where the worker went to a destination HQ's own editor clears. So the reason reads a `from`
detail with its own sentence, which part 09 renders in its one record (its words, read through its
`OTHERWISE_DESTINATION_WORDS`): "{Form}: when no destination applies, workers now go to {to}, set as
the form's Otherwise, because CommCare HQ doesn't offer {from} there." `form-link-removed` is part
09's reason and copy, after `form-link-target-moved` (§14.4). L7 has no notice: it changes what a worker sees only where a link opened a form for a case
the device did not hold, which is defect 26 itself, and the builder's carrying line and the public
docs say it. Departure from the form-links brief's own reason names and its L7 notice.

### 14.4 The off-the-menu arm of L4, and what production holds

One shape has no offered menu to retarget to: a link to a submenu HQ does not offer whose parent is
off the menu (`hiddenFromMenu`), where `nearestOfferedMenu` is undefined and no target keeps the
link. The production scan, run during planning (part 09), found no such link. Nothing at `main`
refuses the shape (§1.4: no rule reads whether HQ's page offers a menu target, and
`HIDDEN_MENU_NOT_A_DESTINATION` reads only the target's own `hiddenFromMenu`), so an author can
create one until the window, and the advisory dry run counts it; production holds none today. So the
map keeps its transform and stays total: it removes each such link, a destination or the otherwise
link, and normalizes the form as `planFormLinkRemove` does (§9.3: no destination left turns a
built-in otherwise into `postSubmit` and an otherwise link into the sole destination; no destination
that may not run left removes the otherwise), with the change `link-removed { formUuid, linkUuid, to
}` and the document reason `form-link-removed`, which part 09 registers after
`form-link-target-moved` with its copy: "{Form}: its destination {to} is gone, because CommCare HQ
can't link to {to} from here and the menu that holds it is hidden. Workers can still open {to} from
its own menu." The cutover has no blocker for form links: the map refuses nothing, and part 09's
`form-link-unmappable` is not registered.

What the scan found for the other classes, in words: production holds form links in a few apps. A
stored `postSubmit` beside conditional links exists, so L3 moves some into the otherwise, and stored
after-submit destinations that never run exist, so L3 also deletes some
(`after-submit-destination-dropped`). No form holds two or more links, no exclusivity guard is
written and no terminal unconditional link follows a conditional one, so L1 and L2 meet no app
today; no link targets a menu HQ does not offer, no menu link carries values, no otherwise is
unoffered and no self link exists, so L4, L5 and L6 meet no app today. Each of those classes still
ships, because an author can create its shape until the window and the dry run counts it. Links
that carry values exist, so L7's guard reaches them at their next publish; none carries a literal,
so no production app holds defect 26's "names no case" shape. With no form holding two links,
`after-submit-several-destinations` changes nothing any production app does today, and the first
publish after the cutover reverses no production form's `form_links`.

### 14.5 The behavior claim

"Every existing app behaves the same" is held by a pure test in pull request 11
(`lib/doc/__tests__/formLinkSemanticsMap.test.ts`, §17) that treats each original condition as a
boolean atom and, for every assignment of the atoms, compares the old outcome (the first link
whose condition holds, else the stored or default `postSubmit`) with the new one (the destinations
whose mapped conditions hold, and the otherwise when none that may not run holds): exactly one
frame, the same one. The old outcome is computed by a frozen copy of `main`'s
`planFormLinkGuards` semantics written into the test as its oracle. The claim is over L1 to L3,
which change no target; L4 to L6 and §14.4's removal change where a frame goes or whether a link
exists, which HQ's own editors would change on their next save, and each is named by its notice.
Part 09's Postgres test holds the same over real rows.

---

## 15. Contract and docs sentences

### 15.1 Subtree contracts, in pull request 11

1. `lib/commcare/CLAUDE.md`, "After-submit links", the bullet **Exclusive guards** ("Core executes
   EVERY true `<create>` and lands on the LAST one … `formLinkParity.test.ts` pins local `<create
   if>` against HQ `form_links[i].xpath` on one document.") becomes **Destinations and the
   otherwise**: "Every destination whose condition holds runs. Core pushes every true `<create>`
   and pops the last pushed (`CommCareSession::createFrame`, `finishAndPop`), running the rest
   after it on Android; Formplayer drops the rest when it rebuilds the session from the popped
   frame (`MenuSessionFactory.rebuildSessionFromFrame`), so Web Apps opens only the top one. So
   destinations are emitted in reverse array order, the author's first on top. Each link's `if` /
   `xpath` is its own condition, then one held-case conjunct per carried value on a single-case
   selection (`formLinkCarriedCaseGuards`, `caseById`). A built-in otherwise is
   `post_form_workflow_fallback`, its frame guarded by `not(x_1) and … and not(x_n)` over the
   non-blank emitted `xpath`s (HQ's `_get_fallback_frame`), so it runs when no destination that
   may not run does and, pushed last, before every destination that runs every time; a link
   otherwise is the last `form_links` entry with that `xpath`; with no otherwise there is no frame
   (`default`). `formLinkParity.test.ts` pins local `<create if>` against HQ `xpath` byte for
   byte."
2. Same file, **HQ shape**: "`post_form_workflow_fallback` is the `postSubmit` workflow word when a
   guarded fallback frame exists, else `null`" → "`post_form_workflow_fallback` is the built-in
   otherwise's workflow word, else `null`".
3. Same file, **Validator**: the list becomes "`FORM_LINK_TARGET_NOT_OFFERED` (a submenu HQ's page
   does not list, `views/forms.py::_get_linkable_forms_context`), `FORM_LINK_MENU_DATUMS`,
   `FORM_LINK_SELF_REFERENCE` (a form target naming its own form; `this-form` is the spelling),
   `FORM_OTHERWISE_NOT_OFFERED`, `FORM_OTHERWISE_UNREACHABLE`, `POST_SUBMIT_BESIDE_FORM_LINKS`,
   `FORM_LINK_DATUMS_INCOMPLETE`, `FORM_LINK_DATUM_UNUSED`, `FORM_LINK_DATUM_TARGET_COLLISION`,
   `FORM_LINK_SEARCH_CASE_UNREPRESENTABLE`, `TARGET_NOT_FOUND`. Cycles are admitted."
4. Same file, "`post_submit` defaults": "… one rule, `POST_SUBMIT_NOT_OFFERED`, refuses a stored
   destination outside `postSubmitDestinationsAdmitted`" → "… outside
   `postSubmitDestinationsOffered`; `FORM_OTHERWISE_NOT_OFFERED` refuses an otherwise outside the
   same set less `app_home`".
5. `lib/domain/CLAUDE.md`, "Forms and modules": "`postSubmitDestinationsAdmitted` waives the two
   several-case conditions for a form with links, whose `postSubmit` is the fallback;" → "a form
   with destinations holds no `postSubmit`; its `otherwise` (`forms.ts::formOtherwiseSchema`) is
   where it goes when no destination that may not run runs (`afterSubmit.ts::formLinkMayNotRun`),
   offered from the same set less `app_home`;". "`Form.formLinks` is the form's ordered list of
   after-submit links, each an ENTITY: `{uuid, condition?: Expression, target, datums?}`" → "…
   after-submit destinations, each an ENTITY: `{uuid, condition?, target, datums?}`, where `target`
   is a form, a menu (`formLinkTargets.ts::menuTargetOffered`) or `this-form`; every destination
   that holds runs, in array order". "`formLinkGraph.ts` is the reachability reader
   (`formLinkAdjacency`, `formLinkPath`, `formLinkDestination`) shared by the cycle rule and every
   surface that must refuse a self-link or a cycle before it is authored" → "`formLinkTargets.ts`
   resolves a target (`this-form` is the source form), names it (`formLinkDestination`) and says
   which menus HQ offers (`menuTargetOffered`, `nearestOfferedMenu`); link cycles are admitted".
6. `lib/domain/forms.ts`'s doc comments (§3.1).
7. `lib/doc/CLAUDE.md`, the `formLinkMutations.ts` paragraph ("`afterSubmitPlan`, the ONE reader
   of what runs when nothing matched … (`pinsFallback`)") → §9's plan and reports; the
   `formLinkReview.ts` paragraph loses "self / cycle"; the `reconcilePostSubmitWithMenuShape`
   paragraph adds the otherwise and drops "and `removeFormLink` the form whose last link left";
   the mutation list adds `setFormOtherwise`; `formLinkSemanticsMap.ts` gets a line.
8. `lib/preview/CLAUDE.md`, "End-of-form links" (§11.8), and the search-first paragraph's
   "Post-submit routing reads `effectivePostSubmit`" → "… reads the after-submit plan".
9. `lib/session/CLAUDE.md`: `previewAfterSubmitStack` and its lifetime.
10. `components/builder/CLAUDE.md`, "After submit": "**One "otherwise" model.** … the terminal
    unconditional link when one exists, else `postSubmit` explicit or defaulted …" and
    "**Conditionality is a kind, not a slot.** … "Make this the otherwise link" (offered only for
    the last link with no otherwise)" → destinations in author order, any row draggable anywhere,
    the otherwise its own slot shown while offered, "Make this the otherwise" / "Make this a
    destination", **Start this form again**, unoffered submenus listed disabled, each in part 07
    §3.11's words; and the note-row sentence (§10.4).

### 15.2 Public docs and architecture (pull request 15, part 10)

- `docs/architecture/complex-apps.md`, "After-submit links": "it emits the exclusive guards that
  make "first true link wins" true …, treats a terminal unconditional link as the exhaustive else
  that suppresses the fallback frame" → "it emits each destination's own condition in reverse
  order, so the author's first that holds runs first (and alone in Web Apps), the otherwise as
  HQ's fallback or a link conditioned on the negation of every other, and a held-case conjunct per
  carried case"; the mutation list adds `setFormOtherwise`, the tool list `set_form_otherwise`.
- `content/docs/form-links.mdx`, in part 07 §3.11's words (and, under an outcome B or C of §19, the
  variants part 07 writes): "## The order matters … Links are checked from the top down, and
  the first one whose condition is true wins. …" → "Every destination whose condition is true
  runs, from the top down: on Android the next one opens when the worker finishes the one before
  it, and in Web Apps only the first one that applies opens." The Otherwise section: "It is where
  the form goes when nothing above it matched" → "It is where the form goes when no destination
  with a condition or a carried case runs, and it shows once a destination has one. It opens
  before a destination that runs every time."; "A form with links always has a real answer for
  the Otherwise row" → "With no Otherwise, the app goes home when no destination runs". "## What
  Nova refuses": remove "A link back to the same form, or a chain of links that leads back to this
  form", "A link after the Otherwise link …", "A second Otherwise"; add "A link to a submenu
  CommCare HQ can't link to from this form's menu: choose the menu above it or a form inside it."
  Carry values: add "A destination that carries a case runs only when the worker's device holds
  that case." A new section "Start this form again". "## On a device": "The installed app behaves
  the same way: the first true link wins" → "On Android every destination that applies runs in
  order; in Web Apps the first does."
- `content/docs/mcp/tools.mdx`: the after-submit paragraph → "every link whose condition holds
  runs, in order (in Web Apps only the first); `set_form_otherwise` says where people go when none
  with a condition runs; `post_submit` is for a form without links"; the three link rows lose
  their otherwise-last clauses; a `set_form_otherwise` row.
- `content/docs/nested-menus.mdx`: "A form can link to a submenu only from a submenu whose parent
  has the same case type."
- `content/docs/case-changes.mdx`, the follow-up paragraph: "If the link's case value is empty,
  Android can't save the form, and if it names no case, CommCare HQ creates one." documents defect
  26 as product behavior; it becomes part 10's sentence: "A form link that carries a case runs only
  when the worker's device holds a case of that type with the value it carries, so a value that
  names no case never opens the form; the next destination, or the form's **Otherwise**, runs
  instead." (G2's outcome B gives part 10's variant.)
- `content/docs/where-workers-use-your-app.mdx`, the differences paragraph, under G1's outcome A:
  "After a form, Android runs every destination that applies, in order, and Web Apps opens only the
  first." (part 10 holds the row).
- `docs/architecture/contracts.md`: no sentence names link semantics; "Every wire unit names its
  fixture" already covers form links.

---

## 16. Edge cases settled

- A form with destinations, none of which runs, and no otherwise: the app home on both paths.
- An every-time destination beside destinations that may not run and an otherwise: the
  every-time destination always runs; the otherwise runs when none of the others does, and opens
  first. `FORM_OTHERWISE_UNREACHABLE` holds only when every destination runs every time.
- Two destinations to the same target: admitted; each pushes its frame.
- A destination whose frame equals the form's would-be after-submit frame: admitted.
- A case list registration form (pull request 10's `caseListRegistrationForm`) refuses
  destinations (`CASE_LIST_REGISTRATION_HAS_NAVIGATION`), and so holds no otherwise.
- `this-form` on a form of a several-case menu: the form-target selection rules apply
  (`FORM_LINK_SELECTION_CARDINALITY`).
- `this-form` on a registration: a new case each time (the `uuid()` datum); on a follow-up: the
  same case (automatic matching) unless datums say otherwise.
- Removing a form an otherwise link targets: refused by `formLinkDependents.ts` like a link, with
  the same planned removal of the pointing link where the dependents planner offers it.
- Moving a form to another module: `this-form` needs no rewrite; a menu target that the move
  leaves unoffered refuses the move (§4.1).
- A carried value into a several-case selection: unguarded (§5.4).
- A link otherwise to the form's own menu: admitted (§7.4); the builder offers "This module"
  instead where it is offered.

---

## 17. Tests, with the boundary each earns

Each starts from the production contract, a plausible failure and the observation that
distinguishes it (`docs/testing.md`).

- **Domain, pure.** `lib/domain/__tests__/formLinkTargets.test.ts`: `menuTargetOffered` over a
  root; a child from a root; a child from a child with equal and unequal parent case types; survey
  parents (`""` on both sides); `nearestOfferedMenu` with an off-the-menu parent;
  `resolveFormLinkTarget` for `this-form` and a form in no menu. The plausible failure is a reading
  of HQ's predicate that drifts; `lib/commcare/__tests__/formLinkTargets.test.ts` (new) writes
  `lib/commcare/__tests__/fixtures/formLinkTargets.json` from the validator's verdict over every
  candidate target of `targeted-form-link-otherwise`, and the lane test holds it to HQ's own page
  (§13.6). `lib/domain/__tests__/afterSubmit.test.ts`: `formLinkMayNotRun` for a condition, a carried
  value on a single and on a several-case selection, automatic matching; `afterSubmitCanGoHome`.
  `lib/domain/__tests__/postSubmit.test.ts`: `otherwiseDestinationsOffered` for each reason, and
  that `postSubmitDestinationsAdmitted` is gone (the export list).
- **Schema.** `lib/domain/__tests__/forms.test.ts`: parses `this-form`, both otherwise arms;
  refuses duplicate otherwise datum names, `app_home` as an otherwise, and an otherwise link
  without a uuid.
- **Emission, against independent consumers.** `lib/commcare/__tests__/formLinkParity.test.ts`:
  local `if` equals HQ `xpath` byte for byte for reversed destinations, both otherwise kinds and
  carried guards. `formLinkProjection.property.test.ts`: the property "exactly one guard or
  fallback is true" becomes "under every assignment of the conditions and every held set of
  carried cases, the frames pushed are exactly the destinations that hold, in reverse author
  order, and the otherwise frame exactly when no destination that may not run holds", over the
  test's own generator (destinations with and without conditions at any position, carried values
  held or not, both otherwise kinds; §13.3), which the proof sample does not use. The claim is
  earned by Core's own session over the local and HQ-regenerated suites (§13.5).
  `lib/commcare/__tests__/expander.test.ts`: "forwards literal condition + datum overrides" holds
  the migrated shape and the guarded `xpath`; "emits the exclusive guard, not the raw condition, on
  every link after the first" becomes "emits each destination's own condition in reverse order".
  `hqJsonOracle` resolves `this-form`.
- **Validator.** `lib/commcare/validator/__tests__/formLinkValidation.test.ts`: each new code fires
  and stops firing, on destinations and on the otherwise link; the changed self code; the retired
  codes are gone from `ValidationErrorCode` (a type-level assertion).
  `lib/doc/__tests__/userFacingErrors.test.ts`: the type-level table covers each code.
- **Planners, through the production gate.** `lib/doc/__tests__/formLinkMutations.test.ts`,
  `mutations-formLinks.test.ts`, `formLinkReview.test.ts` and
  `components/builder/form-links/__tests__/formLinkValidByConstruction.test.ts` replay every `ok`
  plan through the reducers and `mutationCommitVerdict`. Plausible failures: the first destination
  beside an old `postSubmit`, removing the last destination with a link otherwise, an update that
  strands an otherwise, a make-otherwise that leaves nothing that may not run.
- **Reducer and diff.** `setFormOtherwise` applies, clears with `null`, replays to the same
  document; `diffDocsToMutations` emits it and a conversion replays; undo restores it; `moveForm`
  rewrites a pointing otherwise link; identity admission accepts a uuid the batch removed first
  and refuses a fresh duplicate; the reference index's incremental-equals-rebuild oracle covers the
  kind.
- **The map, pure.** `lib/doc/__tests__/formLinkSemanticsMap.test.ts`: each class on a fixture,
  §14.4's removal included (a removed sole destination beside a built-in otherwise, a removed
  otherwise link); the order (L1 to L3 over the original list); totality (no input returns a
  refusal); idempotence; and the behavior claim of §14.5 over every assignment, with the frozen guard
  oracle.
- **Platform table.** `platformFeatures.test.ts` and `platformCells.test.ts` bind the row and the
  cell; `lib/domain/__tests__/platformUses.test.ts` covers the detector and the changed
  `after-submit-home` detector.
- **Preview, state model.** `lib/preview/__tests__/afterSubmitStack.test.ts` (pure): push and pop
  order; `top` against `stack`; the snapshot drop when the submitted path leaves the landing; an
  empty snapshot never dropping; Home clearing. `lib/preview/engine/__tests__/formLinkEvaluation.test.ts`:
  every holding destination and each guard evaluated in one world; the otherwise when none that may
  not run holds. `lib/session/__tests__/store.test.ts`: every reset clears the stack.
  `lib/preview/app-tests/__tests__/journey.postgres.test.ts`: a two-destination journey on each
  platform over real Postgres (Android runs both, Web Apps the first), and a retained checkpoint
  without the field restores empty.
- **Tools.** `lib/agent/tools/form-links/__tests__/formLinkTools.test.ts`: `this-form`,
  `set_form_otherwise` (each arm, `null`, each refusal's sentence), `post_submit` on a form with
  links refused, the commit report sentences. `lib/mcp/__tests__/servedSchemas.test.ts` holds the
  served schemas. `lib/agent/authoring/__tests__/platformGuide.test.ts` places the feature's
  generated sentence after the sentence that introduces destinations.
- **Playwright.** `e2e/lib/formLinksSeed.ts` and `e2e/lib/previousTaskSeed.ts` take the mapped
  shape (each holds a `postSubmit` beside links at `main`), and `e2e/lib/deepLinksSeed.ts` and
  `e2e/lib/smokeSeedFactory.ts`, which build on `formLinksSeed`, follow it. One smoke in pull request 11 over
  `formLinksSeed`: a two-destination form shows both in order, the otherwise row appears once a
  destination has a condition, the target picker offers "Start this form again", and Preview as
  Android opens both destinations in turn. No React Testing Library test is added.

---

## 18. Executed during planning

- **Reads at the pins**, each checkout's head verified at its pin: HQ
  `suite_xml/post_process/workflow.py` (`EndOfFormNavigationWorkflow` whole),
  `helpers/validators.py::FormBaseValidator.validate_for_module`,
  `views/forms.py::_get_linkable_forms_context` and `get_form_view_context`'s `form_workflows`,
  the settings POST, `util.py::module_uses_inline_search`,
  `static/app_manager/js/forms/bootstrap5/form_workflow.js` (the copy `form_view.js` imports: the
  link filter and fallback options), `templates/app_manager/partials/forms/form_workflow.html`; Core
  `session/CommCareSession.java` (`executeStackOperations`, `processStackOp`, `createFrame`,
  `pushNewFrame`, `popOrSync`, `cleanStack`, `finishExecuteAndPop`, `finishAndPop`) and
  `session/SessionFrame.java` (`captureSnapshot`, `isSnapshotIncompatible`); Formplayer
  `services/MenuSessionFactory.java::rebuildSessionFromFrame`,
  `session/MenuSession.java::resetSession`, the end-of-form path of
  `services/MenuSessionRunnerService.java`; Android
  `models/AndroidSessionWrapper.java::terminateSession`,
  `activities/HomeScreenBaseActivity.java::processCanceledGetCommandOrCase`.
- **Nova at `2f985ed6`**: every file §1 and §3.2 name, the manifest entries of §13.4 (read from
  `forms-and-case-writes.json`), the register entries of §13.1, the targeted documents and e2e
  seeds that hold links (§13.2, §17), the corpus id rule for expander documents.
- **Observed in reading, not run:** whether a carried value into a several-case selection from a
  single-case or survey source works on a device. Nova admits it at `main` (the cardinality rule
  reads only several-case sources); no corpus document holds one (the census's three manual-datum
  documents carry single-case values). §5.4 leaves it unguarded; G2's documents hold none.
- **The production scan** (part 09), run during planning with the person's yes, read-only and
  content-free: what it found for form links is stated in words in §14.4, and it decides that
  section's off-the-menu arm.

Nothing was run in HQ, Core, Formplayer, Android, Connect or the lane for this part.

---

## 19. Written and not yet run

All three runs are one dispatch from pull request 11's branch, on GitHub's runners, never on the
person's machine, made as soon as the emission (§6) and the three targeted documents (§13.2) exist
and before the Preview stack (§11), the feature row (§10) and the copy (§12) are written:

```
gh workflow run proof-audit.yml --ref <pull request 11's branch> -f nightly=false \
  -f mechanics=targeted-form-links-hidden-and-fallback,targeted-form-link-chain,targeted-form-link-carried-case,targeted-form-link-otherwise,form-link-else,expander-form-links-emission-forwards-literal-condition-47c96355-0,targeted-migration-form-links,control:targeted-form-links-hidden-and-fallback,control:expander-form-links-emission-forwards-literal-condition-47c96355-0 \
  -f mechanics_shards=auto -f mechanics_readers=true
```

with every reader, the edited document being
`targeted-form-link-chain` (its D′). The list is pull request 11's row of part 08's by-hand reader
runs (§8.4 there), which also shows defect 26's nine served entries on their controls only; G3
reads proof 4's editor saves in the same run. Departure from the form-links brief, which ran G1 in the stack's first
pull request: the reversed emission first exists in pull request 11.

### 19.1 G1: what each runtime does with several destinations that hold (the plan's decision 9; part 08 hosts it)

Observed: Core's session over the local and HQ-regenerated suites (`FormLinkRuntimeTest` and
`proof/core`'s `stackAfterSubmit` through every submission), Formplayer's `submit/nextScreen` of
each submission, the Web Apps client's screens (title and breadcrumbs), the Android reader's
screens, on `targeted-form-link-chain`.

- **Outcome A (expected from §2.2 and §2.4).** Core and Android: **Begin**, **First**, **Nested**,
  **Second**, menu **B**; **Begin both** as alice: **Second**, then menu **B**; as anyone else, menu
  **B**. Formplayer and Web Apps: **Begin**, **First**, **Nested**, then the app's first screen;
  **Begin both** as alice: **Second**, then the app's first screen. The plan stands as written:
  §10's row (`different` / `runs`), §11.2's rule (`top` / `stack`), §13.4's manifest row and
  inventory row, §12's copy with `add_form_links`' "In Web Apps only the first that holds opens."
  and the guide's generated platform sentence, and claims 1 to 3 of §2.6 into `harness-findings.md`.
- **Outcome B (Web Apps also runs the chain).** The feature is not added: no row in
  `platforms.ts`, `platformFeatureEntries.ts` or `platformCells.ts`, no note row, no guide
  sentence; the manifest entry reads RUNS / RUNS; §11.2's rule is `stack` on both (and, having no
  second value left, the field is removed and `afterSubmitStack.ts` always stacks); every sentence
  of §12, §15 and part 07's guide drops its Web Apps clause (part 07's outcome B variants); claim 1
  is withdrawn and §2.4 is
  recorded in `harness-findings.md` as a reading the lane did not confirm, with Formplayer's path
  read again at the pin. The same run then reads the order of **Begin**'s three-frame chain in Web
  Apps. If it is Core's order, the above stands. If the remaining frames open last first (a
  restore that rebuilds the stack in reverse of its serialization,
  `CommCareSession.restoreSessionFromStream`), the feature exists with Web Apps `different`, note
  "after submit, the first destination that applies opens first, and the rest open last first",
  §11.2's rule is `"stack" | "stack-reversed-after-first"` with Web Apps the second (after the
  first pop the pending frames reverse), its cell model asserts that order, and the copy says it.
- **Outcome C (Android also runs only the top one).** The stored model keeps every destination;
  its meaning on both platforms is "the first destination that applies opens", the feature is not
  added, §11.2's field is removed and `completeAfterSubmit` always clears what remains, the
  builder, tools, guide and docs say "the first destination that applies opens" in part 07's
  outcome C variants (and the
  otherwise "opens instead when no destination with a condition or a carried case applies"), L1
  still runs (its conditions are exclusive, so nothing changes for a migrated form), and the
  manifest entry reads RUNS / RUNS with the cell "the first that holds runs (Formplayer and
  Android drop the rest)". Claim 1 becomes "Android and Formplayer both run only the top frame",
  recorded in `harness-findings.md`.

In every outcome `FormLinkRuntimeTest` asserts the order Core showed.

### 19.2 G2: the held-case guard

Observed: every reader on `targeted-form-link-carried-case` and the migrated
`expander-form-links-emission-forwards-literal-condition-47c96355-0`, and proof 4's form settings
save of both.

- **Outcome A (expected from §5.3).** On every runtime only the destination carrying the new
  member opens after **Register member**; the literal and the household's id never open it; after
  **Register member quietly** the otherwise opens; the settings save keeps each `xpath` byte for
  byte; the `get_case_from_case_update` soft assertion appears nowhere. §5 stands; the two group A
  entries move to `proof/fixed-defects.json` (§13.1).
- **Outcome B (some runtime evaluates the guard before the submission lands, or the save rewrites
  it).** §5's guard is replaced by a static rule. A carried value must be a case identity of the
  destination selection's type: its `typeOf(...).caseIdOf` equals the target datum's case type,
  else the checker refuses it with a new reason `datum-not-a-case`, reported as
  `FORM_LINK_DATUM_NOT_A_CASE` (validator: `"${form}" ${label} carries a value that isn't a case of
  type "${type}". Carry the case this form selected or created, or read a property that holds a
  ${type} case's id.`; builder: `In ${q(form)}, ${formLinkPhrase(e)} carries a value that isn't a
  ${type} case. You can carry the case this form opened or created, or read a case's id.`). No
  guard is emitted; `formLinkMayNotRun` is "has a condition" only, and `guardedLinkDatums` is
  deleted. Migration class L8 is added: a link whose carried value fails the rule is retargeted to
  its destination form's menu when offered, else `nearestOfferedMenu`, else removed as §14.4
  removes a link; its datums are dropped with the retarget (a menu reads none). Its change is
  `target-moved` with `cause: "carried-not-a-case"` (`from` the form, `to` the menu), on the reason
  `form-link-target-moved`, whose renderer reads `cause` with its own sentence, since the reason's
  sentence ("because CommCare HQ can't link to {from} from here") is false for it: "{Form}: its
  destination {from} now opens {to}, the menu that holds it, because the value it carried isn't a
  case {from} can open. Workers choose the case there." (part 09 renders it); L7 goes. The group A entries still move: the document's literal fails the rule, so its test takes a
  carried `selected-case` value, and the corpus document holds the fix. A new-case value passes
  the static rule (its type is the created case's), so `targeted-form-link-carried-case` keeps that
  destination and loses the other two, and its intent becomes "the destination opens after
  **Register member**".

### 19.3 G3: HQ's editors keep every new shape

Observed: proof 4's two editor saves (form settings and form builder) on
`targeted-form-link-otherwise`, `targeted-form-link-chain`, `targeted-form-link-carried-case` and the
migrated `targeted-form-links-hidden-and-fallback`.

- **Outcome A (expected from §2.3).** No difference: the reversed links, the otherwise link's
  conjunction, each built-in fallback, `this-form`, the cycle, the offered submenu and the guards
  survive both saves. The plan stands; group B's entries move to `proof/fixed-defects.json`.
- **Outcome B (a save changes a shape).** The changed shape is recorded as a new harness finding
  numbered after the last in `harness-findings.md` (76 if none lands before), the validator refuses
  it with a code named for it, and its manifest entry becomes REFUSED with reason
  `not-hq-editable`, in pull request 11. The shapes and their codes, each written out:
  - the page drops a `this-form` link: `FORM_LINK_THIS_FORM_NOT_OFFERED` refuses `this-form`, the
    arm leaves `formLinkTargetSchema`, the picker and the tools stop offering it, and the
    `form-links-target-the-current-form-or-a-link-cycle` entry is REFUSED for its self half and
    HELD for cycles;
  - the page drops a link to the offered submenu: `menuTargetOffered` loses its child-match arm
    (a submenu is never a target without the flag) and `FORM_LINK_TARGET_NOT_OFFERED`'s sentences
    lose their "from a submenu whose parent" clause; claim 4 of §2.6 is withdrawn;
  - the page clears a built-in fallback word: that word leaves `otherwiseDestinationsOffered` for
    the reason the page withholds it, and L6 moves it;
  - the save rewrites an `xpath` (the otherwise link's conjunction or a guard): the shape becomes
    REFUSED, and the otherwise as a link is replaced by the built-in otherwise only (an otherwise
    link refused, `FORM_OTHERWISE_LINK_NOT_KEPT`), or, for a guard, G2's outcome B applies.

  Under every arm of this outcome no entry joins `proof/known-defects.json`: the gate refuses the
  shape, and where the pre-fix bytes must keep showing the class, part 08 §2.6 retains the document
  as a control from pull request 11's own first run and registers the class in
  `proof/fixed-defects.json` on it with the new finding's number. And `mapFormLinkSemantics` stays
  total, because the cutover calls it as pull request 11 lands it. Where the otherwise link is
  refused, L2 writes no otherwise link: the terminal unconditional link stays a destination and
  takes the condition `not(c_1) and … and not(c_{n-1})` over the earlier conditional links'
  conditions (L1's construction extended to it, built directly with no simplification, which prints
  the bytes Nova emits for that link at `main`, §1.3), a stored `postSubmit` beside it is deleted
  (it never ran), and the form holds no otherwise; its changes are `conditions-written` and
  `after-submit-dropped`. Where a built-in word is withdrawn, L6 moves it as written. Where
  `this-form` is withdrawn, no stored link names it before the cutover (§14.2), so the map is
  unchanged. Where the child-match arm goes, L4 reads the narrower `menuTargetOffered` and
  retargets more links, still total by §14.4's removal.

---

## 20. Files by pull request

**Pull request 11, "Form links"** (this part and part 08's mechanics for it).

- Domain: `lib/domain/forms.ts` (§3.1), `lib/domain/formLinkTargets.ts` (new),
  `lib/domain/afterSubmit.ts` (new), `lib/domain/formLinkGraph.ts` (deleted),
  `lib/domain/postSubmit.ts`, `lib/domain/navigation.ts`, `lib/domain/entryDatumSupplies.ts`,
  `lib/domain/authoredIdentities.ts`, `lib/domain/referenceSlots.ts`,
  `lib/domain/expression/context.ts`, `lib/domain/expression/formStructure.ts`,
  `lib/domain/platforms.ts`, `lib/domain/platformUses.ts`, `lib/domain/index.ts`.
- CommCare: `lib/commcare/formLinkProjection.ts`, `session.ts`, `expander.ts`, `compiler.ts`
  (the no-links path reads `effectivePostSubmit` as defined), `validator/errors.ts`, `runner.ts`,
  `gate.ts`, `rules/form.ts`, `rules/app.ts`, `rules/multiSelect.ts`, `rules/hiddenFromMenu.ts`,
  `validator/hqJsonOracle.ts`, `surface/entries/forms-and-case-writes.json`,
  `surface/platformFeatureEntries.ts`.
- Doc: `lib/doc/types.ts`, `mutations/forms.ts`, `mutations/modules.ts`, `mutations/index.ts`,
  `mutationTargetAdmission.ts`, `mutationIdentityAdmission.ts`, `mutationSequenceAdmission.ts`,
  `referenceIndex.ts`, `diffDocsToMutations.ts`, `incrementalValidationScope.ts`, `store.ts`,
  `formLinkMutations.ts`, `formLinkReview.ts`, `formLinkDependents.ts`, `formLinkTargetChoices.ts`,
  `formLinkSemanticsMap.ts` (new), `userFacingErrors.ts`, `platformNotes.ts`,
  `hooks/useFormLinks.ts`, `hooks/useFormLinkFacts.ts`, `hooks/useBlueprintMutations.ts`.
- Preview: `lib/preview/afterSubmitStack.ts` (new), `engine/formLinkEvaluation.ts`,
  `afterSubmitRouting.ts`, `platform.ts`, `engine/postSubmissionEvaluation.ts`,
  `engine/useCaseDatabaseSnapshot.tsx`, `engine/navigationProjection.ts`, `app-tests/types.ts`,
  `app-tests/submission.ts`, `app-tests/run.ts`, `app-tests/service.ts`,
  `app-tests/retainedState.ts`, `__tests__/platformCells.ts`, `__tests__/platformCellModels.ts`;
  `lib/session/store.ts`, `lib/session/types.ts`; `components/preview/screens/FormScreen.tsx`.
- Builder: `components/builder/form-links/` (`FallbackChooser.tsx` → `OtherwiseChooser.tsx`,
  `OtherwiseRow.tsx`, `AddLinkControl.tsx`, `FormLinksCanvas.tsx`, `LinkTargetPicker.tsx`,
  `FormLinkInspectorBody.tsx`, `CarryValuesSection.tsx`, `FormLinkRow.tsx`, `linkSentence.ts`,
  `afterSubmitCopy.ts`, `refusalCopy.ts`, `seeds.ts`),
  `components/builder/detail/formSettings/AfterSubmitSection.tsx`, every control and line of §12.1
  in part 07's words.
- Agent and MCP: `lib/agent/tools/form-links/{shared,addFormLinks,updateFormLink,moveFormLink,removeFormLink}.ts`,
  `lib/agent/tools/form-links/setFormOtherwise.ts` (new), `lib/agent/tools/updateForm.ts`,
  `getForm.ts`, `removeForm.ts`, `removeModule.ts` (the dependents planner's sentences),
  `lib/agent/sharedToolRegistry.ts`, `lib/agent/toolPresentation.ts`, `lib/chat/toolSummary.ts`,
  `lib/agent/summarizeBlueprint.ts` (the link line), `lib/agent/authoring/reference.ts` (the
  guide's after-submit paragraph), `lib/models.ts` (`MODEL_CONTEXT_VERSION =
  "v6-hq-round-trip-case-writes.11"`), `scripts/test-schema.ts` (`setFormOtherwise`,
  `moveFormLink`, `removeFormLink`, and `addFormLinks`'s prompt), with the rest of part 07's pull
  request 11 files.
- Tests: §17's files, with `lib/commcare/__tests__/formLinkWireFixture.ts`, `expander.test.ts`,
  `formLinkParity.test.ts`, `formLinkProjection.property.test.ts` (its own generator, §13.3),
  `lib/commcare/__tests__/formLinkTargets.test.ts` (new) and its fixture
  `lib/commcare/__tests__/fixtures/formLinkTargets.json`, `lib/doc/__tests__/formLinkSemanticsMap.test.ts`
  (new), `lib/agent/authoring/__tests__/platformGuide.test.ts`, the e2e seeds
  (`e2e/lib/formLinksSeed.ts`, `e2e/lib/previousTaskSeed.ts`, `e2e/lib/deepLinksSeed.ts`,
  `e2e/lib/smokeSeedFactory.ts`) and the smoke spec. The proof sample's generators
  (`xformDocArbitrary.ts`, `suiteDocArbitrary.ts`, `expressionDocArbitrary.ts`) do not change.
- Proof: `proof/targeted/documents/formLinkChain.ts` (new), `formLinkOtherwise.ts` (new),
  `formLinkCarriedCase.ts` (new), `formLinksHiddenFallback.ts`, `instanceReads.ts`,
  `inlineSearchReads.ts`, `migrations.ts` (the form-links witness migrated), `proof/targeted/index.ts`,
  `proof/targeted/expected.ts`, `proof/known-defects.json`, `proof/fixed-defects.json`,
  `proof/checks/registers.py`, `proof/native/core/FormLinkRuntimeTest.java`,
  `proof/native/producers/emit-form-link-evidence.ts`, `proof/native/test_navigation_emission.py`,
  `proof/corpus/editKinds.ts`, `proof/corpus/footprint.ts`, `proof/views/test_form_link_targets.py`
  (new), `proof/README.md` (defect 26's rows and the targeted documents list); part 08 lists the
  rest of its pull request 11 files.
- Research: `docs/research/2026-09-26-hq-round-trip/inventory/forms-and-case-writes.md` (§13.4),
  `docs/research/2026-09-26-hq-round-trip/harness-findings.md` ("Found while planning step 5",
  §2.6 as G1 leaves it).
- Subtree contracts: §15.1.

**Pull request 12, "Builder"** (part 07): nothing of this part's; the after-submit surface is whole
in pull request 11 (§12.3).

**Pull request 13, "Agent"** (part 07): nothing of this part's beyond the billed
`npm run test:schema` asked once at its head, covering `setFormOtherwise` and the link tools
pull request 11 changed, and the `../nova-plugin` re-sweep for this part's claims (§12.3).

**Pull request 14, "Cutover"** (part 09): the step `form-link-semantics` over
`mapFormLinkSemantics`, the notice mapping of §14.3 with `form-link-removed` (§14.4), the Postgres
equivalence test. No form-link blocker.

**Pull request 15, "Contracts and public docs"** (part 10): §15.2.

**Pull request 16**: nothing of this part's; `formLinkSemanticsMap.ts` and its test stay (§14.1).

---

## 21. What other parts read from this one

| Part (pull request) | Reads |
|---|---|
| Part 01, case writes (4, 5) | nothing of this part's model; defect 24's carried extension case is part 02's (`linkCarriedCreates`) |
| Part 02, advanced (7) | `resolveFormLinkTarget` for every frame reader its advanced entries feed; the held-case guard reads `FrameDatum.caseType`, which advanced datums carry; `nearestOfferedMenu` for defect 24's retarget (the cutover brief's `formLinkTargetOffered` is `menuTargetOffered`); `FORM_LINK_NEEDS_NEW_CASE_DATUM` joins §7.2's applied-to-every-entry list |
| Part 03, publish (6, 8) | nothing new: `form_link_workflow` keeps its rule; the first publish after the cutover reverses `form_links` of every multi-destination form (production holds none today, §14.4), Nova's own change, which the drift baseline compares as any `form_links` |
| Part 04, questions (3, 9) | none |
| Part 05, search and menus (10) | §4.3: the reason withholding `previous` is `menu-forms-read-search`, read from `formsReadSearch`, for `postSubmit` and the otherwise alike, and `menu-is-bare-case-list` withholds `module` from both; `reconcilePostSubmitWithMenuShape` reconciles a built-in otherwise; `CASE_LIST_REGISTRATION_HAS_NAVIGATION` keeps covering the otherwise through `formLinks` |
| Part 07, authoring (11, 13) | §12: the whole after-submit surface in pull request 11 in its words, with nothing added in 12 or 13; the copy of §7.4, §9.2 and the tool refusals of §12.2; `set_form_otherwise` in its tool table and its registration (`setFormOtherwise`, `moveFormLink`, `removeFormLink`), covered by the one billed run at pull request 13's head; `MODEL_CONTEXT_VERSION` `.11`; the guide paragraph in pull request 11, its generated sentence placed after the destinations sentence, outcome-dependent (§19.1); the nova-plugin claims its re-sweep reads |
| Part 08, proof (1, 11) | §13: the 18 moves and their controls, `OPEN_DEFECTS`, the content of `targeted-form-link-chain` (with its D′), `targeted-form-link-otherwise` and `targeted-form-link-carried-case`, the witness `targeted-migration-form-links`'s pre-step A, the corpus sources through `mapFormLinkSemantics` and no fuzz mapping (the sample draws no link), the wire fixture's three new scenarios (`chain`, `this-form`, `carried-held`) and their three producer documents in its corpus count, the native test's methods and scenarios, `test_form_link_targets.py` and its fixture, the manifest flips, §19's dispatch as pull request 11's by-hand row, the §2.6 rule under G3's outcome B; the walk-bound rule for `this-form` (its §3) |
| Part 09, cutover (14) | `mapFormLinkSemantics`, total, and its change kinds; §14.3's mapping with `to`, `toDestination` and `from` on `form-link-otherwise-set`; §14.4's removal with `form-link-removed` and no form-link blocker; under G2's outcome B, L8's `cause` sentence on `form-link-target-moved`; the order: the map before the extension retargets |
| Part 10, stack and contracts (15) | §15.2's sentences; §20's files; the contracts table rows "the exclusive-guard sentence" (retired, replaced by §15.1 item 1) |
| **For the step 6 outline** (import) | the reader reads `form_links` in reverse into `formLinks`; reads an otherwise from exactly two shapes (a `post_form_workflow_fallback` word beside some non-blank `xpath`; a last link whose `xpath` is `not(x_1) and … and not(x_n)` over the others, then any held-case conjuncts); strips a trailing held-case conjunct spelled as `caseById` prints it whose `V` equals a carried datum's value and whose `T` equals the target datum's case type, read through the grammar; reads a link to the source form as `this-form`; refuses, naming each, a link to a submenu HQ does not offer and datums on a menu (apps under `FORM_LINK_ADVANCED_MODE`); reads a fallback outside the offered set as INERT where no conditional link exists and refuses it otherwise; reads an HQ fallback beside an unconditional link as the otherwise it is (decision 3). Reason: step 5 builds no reader. |
| **For the step 7 outline** (the rest of the model) | display-only-forms menus (`put_in_root`) as link targets, which HQ never offers, and their `module` and `parent_module` exclusions in `form_workflows`; shadow menus' link frames (`_get_link_frame`'s shadow retarget) and `form_module_id` naming a shadow; a case list registration form's after-submit choice (HQ's `WorkflowHelper._get_stack_frames` prefers a form's own end-of-form frames). Reason: Nova has none of these concepts in step 5. |
