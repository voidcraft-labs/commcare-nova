# Step 5, part 05: Search workflow, menu concepts and claims

Part of [step 5's plan](../5-case-writes-forms-navigation.md) ("Case writes, forms and navigation"). This
part holds defect 21 (what a worker sees first when a menu searches, and whether the menu's forms read the
search), defect 29 (the case list menu item and the case list registration form as module concepts, and the
case list menu item admitted beside forms), the durable search claim (a `commcare-case-claim` row the case
store holds, who writes it, how long it lasts and how a person releases it), the platform rows and Preview
cells these move, and the one gated run that reads the case list menu item on every reader. All of it lands
in pull request 10, "Search workflow, menu concepts and claims". The authoring surfaces over these
concepts (the workflow control, the case list in the menu, the registration from the case list, the tool
inputs, the guide's sentences) are part 07's, written in part 07 §3.8 to §3.10 and §4.2 and landing in
this same pull request; the cutover's transform is part 09's in pull request 14; the register files,
targeted documents and corpus mapping are part 08's; the advanced module's case list entry is part 02's,
and it also lands in pull request 10, the first pull request in which a module can hold the case list menu
item beside forms (§19). §20 names what each of them reads from here.

Citations are `path::symbol` for Nova at `main` `2f985ed6` and `file::symbol` for CommCare at the pins
`proof/pins.json` names: commcare-hq `d6c6e16d8ae1`, commcare-core `8e9ba8d908e9` (paths from the
repository root), commcare-android `7a5584475580`, formplayer `24383ac71bfb`, Vellum `01215f251c57`. Every
CommCare fact here was read at its pin during planning; where reading leaves doubt the fact is a gated run
with every outcome written (§18). Versions at `main`: `lib/models.ts::MODEL_CONTEXT_VERSION` is
`"v5-hq-round-trip-platforms.12"`, `lib/db/appTests.ts::RUNTIME_VERSION` is 17 (pull request 3 sets 18),
and `scripts/test-schema.ts` registers 55 entries.

Pull request numbers are the stack's (decisions table): 2 attachment mode removed, 3 repeats, 4 case
writes, 5 held placements, 6 publish placements, 7 advanced modules, 8 CommTrack and same-type child links,
9 groups and labels, 10 this part, 11 form links, 12 builder, 13 agent, 14 cutover, 15 contracts and public
docs, 16 removal of the cutover tooling. Other parts are named by file number: 01 case writes, 02 advanced
and extension, 03 publish and ledger, 04 questions, 06 form links, 07 authoring, 08 proof, 09 cutover, 10
stack and contracts.

## Decisions in brief

1. **The workflow is `caseSearchConfig.workflow?: "listFirst" | "skipToResults"`; absent is search first
   on every declaration** (decisions 1). `lib/domain/modules.ts::searchWorkflow` is its one reader.
   Reason: search first is the one workflow every declaration admits (it runs in Web Apps and Android
   ignores it, opening its list first), so a module whose search becomes effective by gaining its first
   input is valid wherever it runs with no planner writing a setting beside the input, and a default that
   followed the declaration would change the wire whenever the author changed where the app runs with
   nothing stored to say so.
2. **`caseSearchConfig.formsReadSearch?: true` is HQ's inline shape under Nova's own name.** The search
   runs as each case form opens, so the menu's forms read what was searched for and found. The ordinary
   arm refuses it beside `workflow: "listFirst"` (HQ reads inline only with `auto_launch`), and the gate
   refuses that pair with its own code before a write could reach the schema.
3. **`searchWireShape` is a total mapping of the two authored slots** (§4). Nothing is derived from the
   inputs or the filter. Every stored document today maps to the slots that give its wire unchanged,
   except list first in an app that declares Web Apps, which becomes search first: defect 21's fix.
4. **Five platform rows move** (§5): `list-first` is new (Web Apps unavailable, refusable);
   `search-first` keeps its id and becomes the non-inline search first (runs / ignored, refuses nothing);
   `skip-to-results` becomes authored; `forms-read-search` is the new id of today's inline row (runs /
   unavailable, refusable); `search` reads `formsReadSearch`. `HISTORICAL_PLATFORM_CAUSE_WORDS` keeps
   step 4's stored notice rows that name `search-first` rendering as they do at `main`.
5. **Every rule that read "opens on Search" reads the inline shape** (§6): the three `SEARCH_FIRST_*`
   codes become `FORMS_READ_SEARCH_*`, and a non-inline search-first menu offers `previous` after submit,
   as HQ's `workflow previous inline search` refuses only inline.
6. **A planner writes `skipToResults` where an input change leaves a search with no visible field under
   an absent workflow** (§7), so the Search screen with only its Search button is a shape an author
   chooses, never one a batch falls into.
7. **`Module.caseListMenuItem` replaces `caseListOnly` and the case list link media** (§8). Presence is
   the switch; it holds an optional label, icon and spoken label. It is admitted beside forms on every
   module with a case type. On a module emitted advanced the item lists every open case of its type, so
   part 02's kind blocker `case-list-menu-item-narrowed` admits it there only where the module's list is
   not narrowed (part 02 §4.3, §17). `moduleHasCaseListMenuItem` and `moduleIsBareCaseList` are its two
   readers, and every site that reads `caseListOnly` today reads one of them.
8. **`Module.caseListRegistrationForm` replaces `Form.entry`** (§9), with the discriminator
   `kind: "after-empty-search"` stored now so step 7's other arms add values without a migration.
9. **A claim is a case row** (§10): an open `commcare-case-claim` case owned by the worker with one `host`
   extension index to the chosen case, exactly HQ's claim case. `CaseStore.claimCases` and
   `releaseClaims` write it; the restore closure's ordinary extension rules hold it; the session's
   `previewClaims` and every `claimedCaseIds` argument go. A claim lasts until a person releases it from
   the Preview identity menu, its host's sample data is replaced, or its App Test journey's namespace goes.
10. **Preview plays the workflow** (§11): `PreviewPlatformRules.skipToResults` becomes
    `searchActionAutoLaunch`, `caseListStep` reads the workflow, and the case list menu item's selection
    route is `caseListMenuItemSelection`, whose Web Apps value is the gated run's outcome. On Android a
    case list menu item's case detail offers **Done**, which returns to the list.
11. **One gated run reads the case list menu item** (§18 G1, decisions 6), with three written outcomes:
    A, "Redirecting after sync" and the first menu; B, Formplayer steps back to the screen before the
    choice; C, an empty list. Reading at the pins now favors B (§2.4). The item is admitted beside forms
    under every outcome unless a walk errors or stops, and then it is refusable where it fails.
12. **The authoring surfaces land with the model in this pull request** (§12): what no longer exists
    leaves every surface, renamed inputs land in their final shape, the Preview identity menu's
    **Release claimed cases** lands with the claim, and part 07's workflow control, its **Case list in
    the menu** section, `updateModule`'s `case_list_menu_item` and the tools' `searchWorkflow` land here
    too (part 07 §3.8 to §3.10, §4.2, §5), over the shapes §12 fixes. Pull requests 12 and 13 add no surface
    for these concepts; pull request 13 runs the stack's one billed schema check, which covers this pull
    request's tool schemas (G5).
13. **Migration classes go to part 09** (§14), with two departures from the research: a list-first menu
    with no visible field in an app that declares Web Apps moves to skip to results, not search first,
    and retained App Test sessions are not rewritten (they can only be finished or read). The claim
    type's schema row is no transform: the existing drift writer creates it in every app after the
    deploy and before ingress reopens (part 09 §12).
14. **The stack keeps the decisions' order: this pull request sits above pull requests 7 and 8** (§19).
    The case list menu item beside forms first exists here, so the advanced module's case list menu
    item (part 02), its manifest flip `menus-and-case-lists/module-case-list-show-true-on-an-advancedmodule`,
    the lane witness of CommTrack's menu item reason and `targeted-commtrack-advanced` land in this pull
    request. Pull request 7 emits advanced modules with no case list menu item beside their forms, and
    pull request 8's `commtrackReasons` reads a menu item wherever a module holds one (only a formless
    one before this pull request), with a Vitest witness for its advanced menu item arm until this pull
    request brings the lane's.
15. **Versions.** This pull request sets `MODEL_CONTEXT_VERSION` to `"v6-hq-round-trip-case-writes.10"`
    (served tool schemas and the guide's generated platform sentences change); `RUNTIME_VERSION` stays at
    pull request 3's 18 (decisions 14).
16. **Defect 21's 37 register entries move to `proof/fixed-defects.json`** on their retained controls,
    and `OPEN_DEFECTS` loses `21` (§13.1); under part 08's G3 outcome B the one entry on the expander
    document moves in pull request 11 instead, and `21` leaves `OPEN_DEFECTS` there.

**Departures**, each with its reason where it lands:

- From the research: the workflow stores two values with absence as the third, and the inline flag is
  `formsReadSearch` (§3.3); a list-first menu with no visible field in an app with Web Apps migrates to
  skip to results (§14, M1); the research's `Module.caseListLabel` widen lands as
  `caseListMenuItem.label` (§13.2).
- From the outline: `case-search/auto-launch-false-in-an-app-with-cloudcare-enabled-false` stays ambient
  and list first is a feature through a new export-use entry (C1); the remedy the outline rewrites lands on
  a new row, `forms-read-search`, because "Search first" is the workflow value's name (§5.2); the
  registration slot carries a `kind` (§9.1).
- From this part's brief: no App Test session rewrite (§10.8); the label unit of the registration form is
  inventoried only when a label is set, as at `main` (§9.5); `searchWorkflow` is required and not
  nullable in `setCaseSearchAdvanced`, with `searchFirst` its one spelling of search first (part 07's
  departure from this part's brief, adopted, §12.2); the claim count reads a store method rather than a
  client list (§10.3); the claim type's schema row converges through the drift writer after the deploy,
  not inside the cutover's fleet transaction (part 09's departure from this part's brief, adopted, §14).
- From step 4: the Android detail of a case list menu entry shows Done (C5); the case list menu item's Web
  Apps reading is re-read by G1 rather than assumed (C2).
- From implementation (pull request 10, the case store): the claim's `host` index is written by the
  envelope's identifier-keyed writer `submissionEnvelope.ts::applyLinkEffect` (now exported), because the
  store's insert core writes only a `parent` edge; `releaseClaims` returns `{ released: 0 }` where the
  claim type's schema row is missing rather than refusing, since only `claimCases`, which needs that row,
  writes a claim; the store's write fence (`authorizeCaseMutationInTransaction`) requires `edit`, so a
  viewer's claim through a `view` Server Action (§10.4) is refused by the store as every other Preview
  write of a viewer is; and G6's "plus the claim row" is exact only where the host is held: the claim row
  is in the closure exactly when its host is (a live host makes its open extensions live), so a claim of a
  closed host nothing holds is itself not held, which the old seed had no row to show. Every graph's
  other cases match the old seeded closure (outcome A), which `restoreScopeClaims.postgres.test.ts`
  computes as the graph's closure with the chosen case owned.
- From implementation (pull request 10, the emission): `hqNestedSelection.ts` inspects the case list
  entry of every module holding `caseListMenuItem` (`moduleHasCaseListMenuItem`), not only a bare case
  list (§8.2's table says bare): the entry exists beside forms on both paths (`entries.py::
  EntriesHelper.entry_for_module`), and where every form of the module is a registration its datums are
  the only selection HQ's nested alignment could miss, so inspecting it is what "follows actual selection
  datums" means (`lib/export/CLAUDE.md`). `formLinkProjection.ts` held one `caseListOnly` read, the
  advanced arm of `caseListSessionDatums`, which takes the item reader with part 02 §17 (the advanced
  entry beside forms); the formless-root alignment §8.2 names lives in `lib/domain`'s
  `rootSelectionAlignment`. `hqJson/caseList.ts` writes `auto_launch` / `default_search` /
  `inline_search` wherever the effective search config exists, its `caseListConfig` absent included, as
  the local suite spells the same workflow over an empty case list (`remoteRequest.ts`), so the two paths
  agree on a search stored without a case list. `emissionPlan.ts::EmissionPlan.noMatchesFormOf` is
  renamed `caseListRegistrationOf`, `caseListFormLabelUnit` takes the host module, and
  `caseListMenuItemLabelUnit` is the item's label unit shared by `expander.ts` and `compiler.ts`.
  `noMatchesEmission.test.ts` is renamed `caseListRegistrationEmission.test.ts`; the fixture options
  `caseListOnly` of `noMatchesWireFixture.ts`, `nestedMenuWireFixture.ts::followupNestedDoc` and
  `searchEmissionFixture.ts::inlineDoc` are renamed `bareCaseList`. The fixtures built without a workflow
  (`expander.test.ts::buildHqProjectionDoc`, `csqlCompositionFixture.ts`) take M1's output through one
  test helper, `lib/commcare/__tests__/authoredSearchWorkflowFixture.ts::withAuthoredSearchWorkflows`,
  rather than an edit per module. `menu-is-bare-case-list` is reached by no validator finding: a bare
  case list's one form is its registration form, whose `CASE_LIST_REGISTRATION_HAS_NAVIGATION` holds its
  after-submit destination, so `validationRules.test.ts` holds the reason through
  `postSubmitNotOfferedReason` and that finding.
- From implementation (pull request 10, Preview navigation): G1 is written as outcome B before its
  reader run reads, as the pins favor (formplayer `session/MenuSession.java::getNextScreen`,
  `isViewCommand` → `stepBack`): `caseListMenuItemSelection` is `"step-back" | "device-home"`,
  `CaseListMenuItemRoute` holds only those two arms, and `formlessReturned` leaves `runtimeMessages.ts`;
  the reader run can still move it to outcome A or C. `caseListMenuItemRoute.ts` also holds
  `caseListMenuItemDetailAction(rules)`, the detail's Continue or Android's `detailDone`, so the screen
  and App Tests read the detail from one place. `caseListStep` takes one optional argument §11.2 does not
  name, `searchReopened`: Search again on a skip-to-results menu must open the Search screen, which rule 4
  alone would skip again (the step stays `results` and the default search runs again); the Web Apps
  client asks for the query screen with a forced manual search
  (`MenuSessionRunnerService.java::handleQueryScreen`, `autoSearch` is `doDefaultSearch() &&
  !forceManualSearch`). "Opened from the entry" is derived, not a stored navigation fact: a list is
  opened from the case list menu entry where the module holds the item, no form or parent request seeded
  it and it is a bare case list or a forms-first menu, the one way such a menu reaches its list with no
  form chosen; a case-first menu's no-form list is the menu's own case selection. The claim at a form's
  entry posts where the form is chosen (`CaseListScreen.openFormWithCases`, and `ModuleScreen` for a
  case-first menu with child menus whose case was chosen first), awaited before the form opens, rather
  than in `FormScreen`, so the form opens on a device that already holds the case instead of reading it as
  missing while the claim lands; `FormScreen` reads `moduleFormsReadSearch` for its search reads. With
  the entry listed in a case-first menu the case list's form menu never skips to a lone form, since Core's
  menu then holds two commands. `lib/routing/topologyRecovery.ts::formerParentRecovery` takes the current
  document's `modules`, `forms` and `formOrder` (`moduleIsBareCaseListDestination` reads the module's menu
  forms now), so `lib/doc/hooks/useDocEntityMaps.ts` also returns `formOrder` and
  `components/builder/LocationRecoveryEffect.tsx` passes it.
- From implementation (pull request 10, Preview claims): the three claim actions answer every refusal
  `resolveAuthorizedPreviewContext` gives (`PreviewUnavailableResult`, so `platform-unavailable` and
  `language-unavailable` beside §10.4's `persona-unavailable`), since a claim takes the device and the
  context checks it. The store's write fence (`authorizeCaseMutationInTransaction`, `edit`) refuses a
  viewer's claim and release with `AppAccessError("insufficient_role")`, which the actions answer as
  `refused` with a sentence saying a viewer can't write the app's case data rather than §10.4's retry
  sentence or the IDOR-safe "App not found." (any other access refusal), and `launchEntryPointAction`
  answers a viewer's Web Apps launch that claims the same way; a `CaseNotFoundError` from the launch's
  claim (a chosen case deleted between its read and the claim) refuses the launch with a sentence asking
  to choose the cases again. `useClaimSearchedCases()` takes no arguments: the app, the running worker,
  the device and the document's case types come from the session and doc stores, as every other
  running-app hook reads them; `ClaimOutcome` is the action's result plus `superseded`, where the app,
  the Project scope or the worker changed while the claim posted. `inFlightCaseIds` holds a claim's ids
  from its start until a device snapshot read after it lands (or at once for a claim that changed
  nothing on the device), never longer, so a released or closed claim cannot leave a menu condition
  waiting. `searchClaims.ts` gains the shared posting rules both runtimes read
  (`claimPostsAtResult`, the inverse of `moduleFormsReadSearch`, and `formEntryClaimChoices`, the form
  entry's claim for a case-loading form of a menu whose forms read the search with
  `parentSelectClaimChoices`), and `claimableCaseIds` posts each id once. An entry point launch that
  claimed invalidates every effective case type in `useEntryPointLaunch`, as a claim at the result does.
  `searchEvaluation.ts` returns `workflow` and `formsReadSearch` in place of `searchFirst` and
  `hasVisibleInputs`, and `serverSearchRead.ts` hides Results where `caseListStep` with nothing
  submitted is `search`. App Tests: the records screen carries `openedFrom: "case-list-menu-item"` where
  the menu's entry opened it, the menu observation lists the entry as `caseListEntry` after the forms
  (its own label when set, else the module's localized name), and the `records` action chooses it; a
  Details screen of an entry's list adds `continueLabel` (`detailDone` on Android). The Android re-read
  after a claim that created nothing is implemented in `postAppTestClaims` but has no journey test: a
  journey's claimable ids come from a search read in the same step against the live restore, so a claim
  whose ids are all already claimed is not reachable through journey actions. The journey test "opens
  the results of a search with no visible field" (renamed from "opens browse-first Results") reads
  `results`, since §7.2's planner writes `skipToResults` there; the mixed-module inline chooser test
  removes the module's `caseListMenuItem`, whose list is now a view command, to keep its subject.
- From implementation (pull request 10, the doc layer): `workflowAfterInputChangeMutations` is not
  appended inside `caseSearchConfigPatchMutations`, which reads two configs and no document, and is the
  per-setting planner `diffDocsToMutations` reproduces a stored target with: appending there would make
  an autosave or a replay write a `skipToResults` its target does not hold. The same file exports the
  composer `withWorkflowAfterInputChange(doc, mutations)`, which applies the batch and appends the
  planner for each module whose Search fields or settings the batch edits; the builder's workspace and
  the agent's Search helpers call it (`searchInputMutations.ts::searchInputUpdateMutation` and the
  operations in `caseSearchConfigMutations.ts` are single-mutation builders the diff uses too, so they
  append nothing). Setting a case type on a formless module gives it `caseListMenuItem: {}`, and
  clearing the type takes it off, through the planners `scaffolds.ts::caseTypeSetPatch` /
  `caseTypeClearPatch` and `modulePatchMutations`, which commits an authored `caseListMenuItem` as one
  `setCaseListMenuItem`, not as an `updateModule` reducer side effect (`lib/doc/CLAUDE.md`: a cascade
  is an explicit granular mutation, never a reducer's); `updateModule.patch` omits `caseListMenuItem`,
  so the item has one writing kind. `setCaseListMenuItem`'s footprint is the module and its child
  modules with their forms and every form holding links, since the entry through the list supplies a
  session (`entryDatumSupplies.ts`, the browse supply) a link into the module reads. A case list
  registration finding names its form in `details.formName` beside `formUuid` (a one-line edit of
  `rules/case-search/caseListRegistration.ts`), so the builder's sentence can name it.
  `caseListRegistrationMutations` plans nothing to clear a form the slot does not name. `moduleFormHostMutations`
  seeds the `Name` column of any module with a case type and no column, since it no longer has a flag
  to gate on. The wire-identity half of `searchWorkflowPlan.test.ts` reads the raw old fields from the
  fixture JSON and lifts the retired shapes itself (a field's `caseWrite` through
  `fieldWriteOperations.ts::operationsFromFieldWrites`, `searchFirst` through `authoredSearchWorkflow`,
  `caseListOnly`, a form's `entry`), because part 09's raw reader is pull request 14's; it compares
  each module's `search_config` with `main`'s recorded arm and, for the witness, with the retained A
  capture's `app_file`. Part 10 §7.7's `searchWorkflowPlan.ts` bullet says `authoredSearchWorkflow`
  writes `skipToResults` after an input change; that is `workflowAfterInputChangeMutations`, so
  `lib/doc/CLAUDE.md` gives each its own sentence.
- From implementation (pull request 10, the gated runs): the pull request is written with each reading the
  by-hand reader run (part 08 §8.4, row 10) settles, each kept in one place so the run's verdict moves it
  once. G1 is outcome B, the step-back, as formplayer's `session/MenuSession.java::getNextScreen` reads
  (`isViewCommand` → `stepBack`, line 270), held in `lib/preview/caseListMenuItemRoute.ts::
  caseListMenuItemSelection` over `PreviewPlatformRules.caseListMenuItemSelection`. Android's detail of the
  entry's list shows Done (`EntityDetailActivity.java`, `select.detail.bypass`; `EntitySelectActivity.java`
  `mViewMode`), held in `caseListMenuItemRoute.ts::caseListMenuItemDetailAction` over
  `PreviewPlatformRules.caseListMenuItemDetail`. G2 is outcome A: no walk stop is added and no stop changes
  cause, so `proof/walk-stops.json` is unchanged, and `search-first` and `skip-to-results` keep their Android
  reading (`lib/domain/platforms.ts`). G3 is outcome A: `targeted-search-workflow*` hold every workflow with
  no `SEARCH_WORKFLOW_NOT_KEPT_*` code. G4 is outcome A: `caseListStep` shows the Search screen with only its
  button for search first with no visible field (§11.2). Each stands until the run reads.
- From implementation (pull request 10, the corpus): beside the list-first menus of documents that declare
  Web Apps, two fuzz documents that declare Android only, `fuzz-expression-20260930-3` and
  `fuzz-suite-20260930-3`, turn `auto_launch` on in their first menu (app JSON and suite), because §13.4 has
  each `lowerToDoc` map its draw with `declaresWebApps: true` before `declaredForContent` narrows the
  declaration, so §13.4's "every source's bytes are unchanged except the list-first menus of documents that
  declare Web Apps" holds for every source but these two. A device never reads `auto_launch` (G2's outcome A
  reading), so their Android records are expected to stay `main`'s; the reader run holds that. The six
  expander documents named for `caseListOnly`'s tests take the renamed tests' ids
  (`expander-case-list-menu-item-*`), with the same documents under them.
- From implementation (pull request 10, schema drift): `scripts/lib/schemaDrift.ts::computeSchemaDrift`
  reports the claim type's missing row (`missingRow: true`, no properties) on an app saved before this pull
  request, as M6 plans, since `buildCaseTypeMap` now lists `commcare-case-claim` and the loop skips only the
  worker's own case. The drift and index-convergence tests seed the claim row an app saved after this pull
  request holds, and `scripts/lib/__tests__/schemaDrift.postgres.test.ts` holds the missing row and its
  convergence on its own.
- From implementation (pull request 10, a comment at the base): `lib/commcare/compiler.ts::registerActionFor`
  said the validator refuses a registration form offered on a host without menu forms whose case type
  selects a parent first, naming `SEARCH_NO_MATCHES_ENTRY_PARENT_NEEDS_MENU_FORM`, a code no validator at the
  base or the head defines. The clause is dropped, so the comment says only what HQ's build does with such a
  host; whether that shape needs a refusal is left open for pull request 11's review of the Register action.
- None from the stack: the decisions' order holds, and the advanced module's case list menu item lands
  in this pull request with part 02's readers (§19).

---

## 1. What Nova does today

### 1.1 Stored shapes

| Concept | Slot at `main` | Reader |
|---|---|---|
| Inline search ("Search first") | `lib/domain/modules.ts::ordinaryCaseSearchConfigSchema.searchFirst: z.literal(true).optional()` | `modules.ts::moduleOpensOnSearch` over `effectiveCaseSearchConfig` |
| Skip to results | not stored: `lib/commcare/suite/case-search/searchWireShape.ts::searchWireShape` derives it from an effective filter (`lib/domain/expression::effectiveFilterForEmission`) and no visible input (`modules.ts::visibleSearchInputs`) | the emitters; `lib/domain/platformUses.ts` restates it for `skip-to-results` |
| List first | everything else | `searchWireShape`'s last arm |
| Case list menu item | `moduleSchema.caseListOnly: z.boolean().optional()`, formless by `rules/module.ts::caseListOnlyHasForms` | `lib/commcare/expander.ts`, `compiler.ts`, `session.ts`, a dozen domain and validator sites (§8.2) |
| Case list menu item media | `caseListConfigSchema.icon` (`moduleIconRefSchema`), `.audioLabel` (`mediaAssetIdSchema`), emitted only under `caseListOnly` | `expander.ts`, `lib/domain/mediaRefs.ts` |
| No-matches registration form | `lib/domain/forms.ts::formEntrySchema` on `Form.entry`: `{ kind: "search-no-matches", label?: string }` | `forms.ts::isNoMatchesForm`, `formEntersFromMenu`; `lib/domain/menuForms.ts::noMatchesFormOf`, `menuFormUuidsOf` |
| Claims | session only: `lib/session/previewClaims.ts` (`PreviewClaims { appId, worker, caseIds }`, `PREVIEW_CLAIMS_LIMIT = 1000`) | every device-scoped Server Action's `claimedCaseIds`; `lib/case-store/sql/compileRestoreScope.ts` seeds the fixpoint with each id |

`caseSearchConfigHasAuthoredSettings` and `caseSearchConfigAfterFinalInputRemoval` treat `searchFirst` as
an action setting that survives the last visible input. The no-matches form's label unit is
`lib/domain/translationUnits.ts`'s role `form-entry-label`, id `makeTranslationUnitId("form", formUuid,
"entry-label")`, inventoried only when `entry.label` is set (the wire falls back to the form-name unit).

### 1.2 Emission

- `searchWireShape(caseListConfig, caseSearchConfig)`: `searchFirst` gives `{ autoLaunch: true,
  inlineSearch: true, defaultSearch: <no visible input> }`; an effective filter with no visible input gives
  `{ autoLaunch: true, defaultSearch: true, inlineSearch: false }`; anything else `{ autoLaunch: false,
  defaultSearch: false, inlineSearch: false }`. Its callers are `suite/case-search/remoteRequest.ts`,
  `suite/case-search/inlineSearch.ts` and `hqJson/caseList.ts`.
- `suite/case-search/inlineSearch.ts::moduleIsSearchFirst` (= `moduleOpensOnSearch`) gates the inline
  emission in `compiler.ts`, `entryPointSuite.ts`, `formLinkProjection.ts` and
  `projectSpaceCompatibility.ts`, whose `advancedCaseSearchReasons` says "The menu opens on Search." and
  whose third related-case reason says "A menu that opens on Search follows a parent case chosen first."
- Every app that declares Web Apps sends `cloudcare_enabled: true` (step 4), so every list-first searching
  module of such an app is the REFUSED class
  `case-search/workflow-legacy-classic-auto-launch-false-in-an-app-with`.
- `expander.ts` writes `case_list.show`, `case_list.label` (the module name's unit) and the media dicts
  only for `caseListOnly`; `compiler.ts` writes the local browse command for `caseListOnly && caseType`;
  `session.ts::deriveCaseListEntryDefinition` builds that entry; `addOns.ts` adds `case_list_menu_item`
  and `register_from_case_list`.
- `emissionPlan.ts` places the no-matches form in a synthetic hidden module (`module_filter: false()`),
  the host carries `case_list_form` with `noMatches.ts::NO_MATCHES_RELEVANCY`, the Register `<action>`
  sits on the short detail (`shortDetail.ts::RegisterActionContext`), and `post_form_workflow` is
  `case_list`.

### 1.3 Validator codes

`rules/case-search/searchFirst.ts`: `SEARCH_FIRST_REQUIRES_CASE_FIRST_MODULE`,
`SEARCH_FIRST_NO_BUTTON_DISPLAY_CONDITION`, `SEARCH_FIRST_UNIQUE_INSTANCE` (three arms).
`rules/case-search/searchNoMatches.ts`: `SEARCH_NO_MATCHES_ENTRY_REQUIRES_SEARCH_FIRST`,
`SEARCH_NO_MATCHES_ENTRY_NOT_REGISTRATION`, `SEARCH_NO_MATCHES_ENTRY_MULTIPLE_RETURN`,
`SEARCH_NO_MATCHES_ENTRY_HAS_NAVIGATION`, `SEARCH_NO_MATCHES_DUPLICATE`. `rules/form.ts`:
`FORM_LINK_TARGET_NO_MATCHES_FORM`. `rules/module.ts`: `CASE_LIST_ONLY_HAS_FORMS`,
`CASE_LIST_ONLY_NO_CASE_TYPE`, `NO_FORMS_OR_CASE_LIST`, `NESTED_MENU_CROSS_TYPE_ROOT_REQUIRES_FORM`.
`lib/domain/postSubmit.ts::POST_SUBMIT_NOT_OFFERED_REASONS` holds `menu-opens-on-search` (withholds
`previous`) and `menu-is-case-list-only` (withholds `module`). The checker's `search-answer-unavailable`
reads `lib/domain/expression/context.ts::FormExpressionFacts.searchFirstModule` and `noMatchesForm`.
`PLATFORM_FEATURE_UNAVAILABLE` refuses `search-first` where Android is declared.

### 1.4 Preview, App Tests and claims

`lib/preview/platform.ts::PreviewPlatformRules` holds `skipToResults` (Web Apps true, Android false),
`formlessCaseListSelection` (`"back-to-root-menu"` / `"device-home"`), `claimThenSync` and
`zeroSearchResults`. `lib/preview/caseListPhase.ts::caseListStep` reads `searchFirst` and visible inputs;
`automaticallyLaunchesSearch` reads the derived skip. `lib/preview/formlessCaseListRoute.ts` plays the
formless module only. A claim is added to the session store (`lib/session/store.ts::addPreviewClaims`),
sent with every device-scoped read, checked by
`lib/preview/engine/previewAuthorization.ts::previewClaimedCaseIds`, and seeded by
`compileRestoreScope.ts`; `lib/preview/app-tests/run.ts::postAppTestClaims` appends to
`AppTestSessionState.claimedCaseIds` and re-reads the session's device. Nova writes no claim row
(`lib/case-store/CLAUDE.md`, "A claim seeds it too").

### 1.5 Platform table

`lib/domain/platforms.ts::PLATFORM_FEATURES`: `search-first` (runs / unavailable, refusable, the inline
shape), `skip-to-results` (runs / ignored, derived detector), `search` (runs / different, not inline),
`case-list-menu-item` (different / runs, `caseListOnly`). `lib/commcare/surface/platformFeatureEntries.ts`
gives `search-first` six entries and keeps
`case-search/auto-launch-false-in-an-app-with-cloudcare-enabled-false` ambient. `lib/notices/
migrationNoticeCopy.ts::PLATFORM_CAUSE_WORDS["search-first"]` is `"menus that use Search first"`, and its
test holds the key set equal to the features that read `unavailable`. `lib/preview/__tests__/
platformCells.ts` holds six `structural("search-first")` cells, `model("skip-to-results-android")`,
`model("search-android")` and `model("case-list-menu-item-web-apps")`.

---

## 2. What CommCare does at the pins

### 2.1 The workflow selector and the list-first rewrite

| Fact | Citation |
|---|---|
| HQ's Case List page shows the workflow selector only where the app has `cloudcare_enabled`, the project has the CLOUDCARE privilege and SYNC_SEARCH_CASE_CLAIM | commcare-hq `corehq/apps/app_manager/views/modules.py::get_module_view_context` (`show_search_workflow`) |
| The selector offers `auto_launch` ("Search First") and `es_only` ("Skip to Default Case Search Results"), and `classic` only under CASE_SEARCH_DEPRECATED_NORMAL_CASE_LIST | `templates/app_manager/partials/modules/bootstrap5/case_search_properties.html` |
| The model reads `workflow` from `auto_launch` / `default_search` and writes `auto_launch = workflow in [es_only, auto_launch]`, `default_search = workflow === es_only`; with no `classic` option the select binds its first option, so a save of a list-first menu writes `auto_launch: true` | `static/app_manager/js/details/case_claim.js::searchConfigModel` |
| CASE_SEARCH_DEPRECATED_NORMAL_CASE_LIST is tagged deprecated, parent SYNC_SEARCH_CASE_CLAIM | `corehq/toggles/__init__.py::CASE_SEARCH_DEPRECATED_NORMAL_CASE_LIST` |
| The save writes `auto_launch`, `default_search` and `inline_search` from the posted properties | `views/modules.py::_gather_and_update_search_properties` |
| Where the selector is not rendered (no `cloudcare_enabled`), the model keeps the stored `auto_launch` / `default_search`, so an Android-only app keeps list first, search first and skip to results across a save | `case_claim.js::searchConfigModel` (`searchConfigKeys`) |
| The inline checkbox ("Make search input available after search") renders only under CASE_SEARCH_ADVANCED and only for `es_only` / `auto_launch`; the model keeps a stored `inline_search` whether or not it renders | `case_search_properties.html`; `case_claim.js::searchConfigModel` (`inlineSearchVisible`) |

### 2.2 Runtime readers of the three flags

| Fact | Citation |
|---|---|
| `auto_launch` is read only by Core's cli entity screen, which Formplayer runs; commcare-android `app/src` holds no reader (its only auto-launch hits are callouts) | commcare-core `src/cli/java/org/commcare/util/screen/EntityScreen.java::evaluateAutoLaunch`; commcare-android `app/src/org/commcare/activities/EntitySelectActivity.java::isCalloutAutoLaunching` |
| `default_search` runs the search as the query screen opens; with no prompts and `default_search` false, Formplayer shows the query screen and waits for Search | commcare-core `RemoteQueryDatum.doDefaultSearch`; formplayer `services/MenuSessionRunnerService.java::handleQueryScreen` (`autoSearch = replay \|\| (queryScreen.doDefaultSearch() && !forceManualSearch)`) |
| The search action and its auto-launch XPath are built only for a module that offers search and does not use inline search; its `relevant` is the Search button's display condition, and an irrelevant action is not among the custom actions, so it cannot auto-launch | `suite_xml/sections/details.py::DetailContributor._get_auto_launch_expression`, `build_detail` |
| Inline needs both `inline_search` and `auto_launch` | `app_manager/util.py::module_uses_inline_search` |
| The claim `<post>` sits in each case-requiring form's entry when the module uses inline search | `suite_xml/sections/entries.py::EntriesHelper.include_post_in_entry`, `add_post_to_entry` |
| Among search shapes, HQ refuses `previous` after submit only for a case-loading form (`form.requires_case()`) of a module using inline search (`workflow previous inline search`); the same arm also refuses it where exactly one of the module and its root selects several cases (`mismatch multi select form links`). The unique-instance checks compare inline only | `helpers/validators.py` (`workflow previous inline search`, `non-unique instance name with parent module`, `... parent select module`) |

### 2.3 Claims

| Fact | Citation |
|---|---|
| A claim is an open case of type `commcare-case-claim`, named after the host, owned by the restore user, with one index `host`, relationship `extension`, to the chosen case and its type | `corehq/ex-submodules/casexml/apps/case/cleanup.py::claim_case`; `corehq/apps/case_search/models.py::CLAIM_CASE_TYPE`; `casexml/apps/case/const.py::DEFAULT_CASE_INDEX_IDENTIFIERS` |
| An existing claim is an open claim-type case reverse-indexed to the host and owned by the user; a missing host raises | `cleanup.py::get_first_claims` |
| The claim endpoint answers 400 with no ids, 410 when an id names no case, creates one claim per unclaimed id | `corehq/apps/ota/views.py::claim` |
| Nothing at the pins closes a claim case; it lasts until another writer closes it | `CLAIM_CASE_TYPE` is read only by `claim_case` and `get_first_claims` |
| An owned open extension is live when its host is available, and its liveness makes the host live | `casexml/apps/phone/data_providers/case/livequery.py`, held by Nova's `compileRestoreScope.ts` to HQ's `case_relationship_tests.json` |

### 2.4 The case list menu item

| Fact | Citation |
|---|---|
| For `case_list.show`, HQ builds an entry with the case list command and, for a `Module`, the datums a case-loading form of the module gets; it holds no form, whatever else the module holds | `suite_xml/sections/entries.py::EntriesHelper.entry_for_module`, `configure_entry_module_form` |
| The module's menu lists the case list command after its form commands | `suite_xml/sections/menus.py` (the `case_list.show` arm after the form loop) |
| Core reads an entry with no xmlns and no stack operations as a view entry, and a command whose one entry is a view is a view command | commcare-core `src/main/java/org/commcare/xml/EntryParser.java` (`isViewEntry`); `session/CommCareSession.java::isViewCommand` |
| When every entry of a menu needs the same first datum, Core asks it before the command, so a menu whose forms all load a case shows its case list first, and the view entry joins that | `CommCareSession.java::getNeededData`, `getDataNeededByAllEntries` |
| Formplayer, on a view command whose data is complete, steps the session back and asks for the next screen again | formplayer `session/MenuSession.java::getNextScreen` (`isViewCommand` → `stepBack`) |
| "Redirecting after sync" is answered only where the next screen is null and no form is set | `services/MenuSessionRunnerService.java::advanceSessionWithSelections` |
| Android, with no case detail, returns the selection and ends the session with no form at its home screen | commcare-android `EntitySelectActivity.java::onEntitySelected` (`mNoDetailMode` → `returnWithResult`); `HomeScreenBaseActivity.java::handleNoFormFromSessionNav` |
| Android, with a case detail, shows the detail in view mode with the button **Done** (`select.detail.bypass`), whose result leaves the list showing | `EntityDetailActivity.java` (`viewMode`, `select.detail.bypass`); `EntitySelectActivity.java::onActivityResult` (`CONFIRM_SELECT` with `mViewMode`); `app/assets/locales/android_translatable_strings.txt` (`select.detail.bypass=Done`) |
| Nothing refuses `case_list.show` beside forms on a basic module; the build error is a module with neither | `helpers/validators.py` (`not module.forms and not module.case_list.show`) |

Reading the last four rows together predicts that choosing a case from the entry in Web Apps shows the
case list again (the session steps back over the datum), not "Redirecting after sync": the next screen is
the entity screen, never null. That contradicts step 4's correction of the formless reading, which was
read, not walked (the lane holds no walk of it; `rg "Redirecting after sync" proof` finds nothing). G1
(§18) settles it with three outcomes.

### 2.5 Register from the case list

`suite_xml/sections/details.py::DetailContributor.build_detail` adds the Register action to every short
detail of a module whose `case_list_form.form_id` is set; `get_case_list_form_action` writes a
`relevancy_expression` only under FOLLOWUP_FORMS_AS_CASE_LIST_FORM. So "after an empty search" is the
relevancy Nova writes (`NO_MATCHES_RELEVANCY`) and the reason Nova asks for the
`registration-after-empty-search` capability.

### 2.6 Claims corrected

- **C1.** The outline says `case-search/auto-launch-false-in-an-app-with-cloudcare-enabled-false` "becomes
  an author's choice and moves to a feature". The entry reads `not-applicable` on Web Apps, and
  `lib/commcare/surface/__tests__/platformFeatures.test.ts` holds a feature's entries to one reading pair
  drawn from `PLATFORM_FEATURE_READINGS`, which has no `not-applicable`. The entry stays ambient with a
  new reason; list first becomes a feature through a new export-use entry (§5.1). Part 08's proof brief
  line saying the entry "leaves the ambient list" is corrected the same way.
- **C2.** The manifest's Web Apps reading of
  `menus-and-case-lists/module-case-list-show-true-on-a-basic-module-with-forms` and
  `module-case-list-show-true-on-an-advancedmodule`, "selecting a case from that list leaves an empty
  list", has no source at the pins, and step 4's correction of the formless entry ("Redirecting after
  sync") is contradicted by `MenuSession.getNextScreen` (§2.4). G1.
- **C3.** `case-search/inline-search-default-search-on-a-module-without-visible-inputs` and
  `...-with-visible-inputs` name no gate, while their two inline siblings name `toggle/CASE_SEARCH_ADVANCED`
  and `gates.json`'s `toggle/CASE_SEARCH_ADVANCED` already lists all four in `contentEntries`. HQ offers
  `inline_search` only under CASE_SEARCH_ADVANCED (§2.1). Both entries' `gates` gain it.
- **C4.** `docs/architecture/complex-apps.md` ("Search first") and `content/docs/case-workspace.mdx` say
  Search first is unavailable on Android. That is true of the inline shape only; HQ's own Search First is
  ignored on Android.
- **C5.** Step 4's Preview (step 4 part 06 §9) shows **Continue** on a case list menu item's detail on
  both platforms and sends Android to its home screen. On Android the detail of a view command shows
  **Done** and returns to the list (§2.4). A Nova defect no lane check observes (Preview is not a lane
  reader); fixed here (§11.4).

### 2.7 A Nova defect found here

- **N1.** `setCaseListMeta` admits `icon` / `audioLabel` on any module, and
  `lib/doc/scaffolds.ts::moduleFormHostMutations` turns `caseListOnly` off when a form is added without
  clearing them, so a module that held a case list link icon and then gained a form stores media with no
  wire effect. No lane check observes a stored slot with no effect. The slots leave `caseListConfig`
  (§8.1) and the cutover drops each dead reference and names it in its report (§14, M4).

---

## 3. The search workflow: stored shape

### 3.1 The schema

From pull request 10, `lib/domain/modules.ts`:

```ts
export const ordinaryCaseSearchConfigSchema = z
	.strictObject({
		excludedOwnerIds: valueSchema.optional(),
		searchScreenTitle: z.string().min(1).optional(),
		searchScreenSubtitle: z.string().min(1).optional(),
		searchButtonDisplayCondition: conditionSchema.optional(),
		/**
		 * What a worker sees first when this menu searches. Absent is search
		 * first: the Search screen in Web Apps, which Android ignores and opens
		 * the case list. `skipToResults` runs the search as the menu opens and
		 * shows its matches; `listFirst` shows the worker's case list with a
		 * Search action, admitted only where Web Apps is not declared
		 * (`platforms.ts`, `list-first`). `searchWorkflow` is the one reader.
		 */
		workflow: z.enum(["listFirst", "skipToResults"]).optional(),
		/**
		 * The search runs as each case form of the menu opens, so the forms read
		 * what the worker searched for (`#search/`) and what it found
		 * (`results:inline`). CommCare's inline search. Presence is the switch.
		 * Only with search first or skip to results; unavailable on Android
		 * (`forms-read-search`). `moduleFormsReadSearch` is the one reader.
		 */
		formsReadSearch: z.literal(true).optional(),
	})
	.refine(
		(config) =>
			!(config.workflow === "listFirst" && config.formsReadSearch === true),
		{
			path: ["formsReadSearch"],
			error:
				"A menu that opens on its case list can't have its forms read the search. Choose Search first or Results first, or turn off Forms read the search.",
		},
	);
```

Zod 4 keeps `.shape` on a refined object, which `lib/doc/types.ts::caseSearchConfigPatchSchemaFor` reads.
`ownerOnlyCaseSearchConfigSchema` is unchanged. The refine makes the pair unrepresentable in a stored
document (`lib/db/blueprintRows.ts` parses every write); the gate refuses it first with
`FORMS_READ_SEARCH_WITH_LIST_FIRST` (§6.1), because a per-key patch cannot see the stored key it would
pair with.

### 3.2 The readers

```ts
export const SEARCH_WORKFLOWS = ["listFirst", "searchFirst", "skipToResults"] as const;
export type SearchWorkflow = (typeof SEARCH_WORKFLOWS)[number];

/** What a worker sees first when this search runs; absent is search first. */
export function searchWorkflow(config: OrdinaryCaseSearchConfig): SearchWorkflow {
	return config.workflow ?? "searchFirst";
}

/** The module's workflow, or undefined where it has no effective ordinary search. */
export function moduleSearchWorkflow(
	module: Pick<Module, "caseListConfig" | "caseSearchConfig">,
): SearchWorkflow | undefined {
	const config = effectiveCaseSearchConfig(module);
	return config === undefined ? undefined : searchWorkflow(config);
}

/** The menu's forms read the search: CommCare's inline search. */
export function moduleFormsReadSearch(
	module: Pick<Module, "caseListConfig" | "caseSearchConfig">,
): boolean {
	return effectiveCaseSearchConfig(module)?.formsReadSearch === true;
}
```

`moduleOpensOnSearch` is removed. Each caller reads `moduleFormsReadSearch` where it means the inline
shape (the wire, the `#search/` scope, `previous`, the registration form, the claim at the form's entry)
or `moduleSearchWorkflow` where it means what the worker sees first (Preview's first screen, the platform
detectors, the builder's control). §19 lists every caller by file.

`caseSearchConfigHasAuthoredSettings` reads `workflow !== undefined || formsReadSearch !== undefined` in
place of `searchFirst !== undefined`. `caseSearchConfigAfterFinalInputRemoval` counts both as action
settings that survive the last input (its comment: "The workflow and Forms read the search survive the last
input: the menu keeps opening as the author chose.").

### 3.3 Rejected

- `workflow` required whenever search is effective: every input-adding planner on three editors would have
  to write it, and a missed one is a refusal.
- Absent is list first: every app that declares Web Apps would need a stored value on every searching
  module, and adding Web Apps would strand every module.
- A third stored value `"searchFirst"`: two spellings of one intent.
- The research's `inline` and authoring's `open-on-search` ids (decisions 1): `inline` is HQ's wire word;
  the author-facing meaning is HQ's own help text for the checkbox, "Make search input available after
  search", which "Forms read the search" names.

---

## 4. Emission

### 4.1 `searchWireShape`

`lib/commcare/suite/case-search/searchWireShape.ts` becomes:

```ts
// The authored workflow's wire spelling. One shape for every platform an app
// declares; Android reads no `auto_launch` and opens its list first, which the
// platform table states (`search-first`, `skip-to-results`).
export function searchWireShape(caseSearchConfig: OrdinaryCaseSearchConfig): WireShape {
	const workflow = searchWorkflow(caseSearchConfig);
	return {
		autoLaunch: workflow !== "listFirst",
		defaultSearch: workflow === "skipToResults",
		inlineSearch: caseSearchConfig.formsReadSearch === true,
	};
}
```

| `searchWorkflow` | `formsReadSearch` | `auto_launch` | `default_search` | `inline_search` |
|---|---|---|---|---|
| `listFirst` | absent (the pair is unrepresentable) | false | false | false |
| `searchFirst` | absent | true | false | false |
| `searchFirst` | true | true | false | true |
| `skipToResults` | absent | true | true | false |
| `skipToResults` | true | true | true | true |

The `caseListConfig` argument goes; the three callers (`remoteRequest.ts`, `inlineSearch.ts`,
`hqJson/caseList.ts`) pass the effective config only, and `hqJson/caseList.ts` keeps its
`caseSearchConfig === undefined` guard. `types.ts`'s header ("the flags fall out of pure inference")
becomes "the flags are the authored workflow's spelling". The non-inline search first is the existing
remote-request path with `autoLaunch: true, defaultSearch: false`, which `shortDetail.ts` and
`hqJson/caseList.ts` already write (skip to results uses it today with `defaultSearch: true`).

### 4.2 The inline consumers

`inlineSearch.ts::moduleIsSearchFirst` is renamed `moduleUsesInlineSearch` and reads
`moduleFormsReadSearch`. Its consumers (`compiler.ts`, `entryPointSuite.ts`, `formLinkProjection.ts`,
`projectSpaceCompatibility.ts`) keep their behavior behind the new name; `inlineSearchPlan` reads
`caseSearchConfig.formsReadSearch !== true` where it reads `searchFirst !== true`.

### 4.3 Wire identity for today's documents

Mapped as §14's M1 maps them, every stored module keeps its wire except one class:

| Today | From step 5 | Wire |
|---|---|---|
| `searchFirst: true`, a visible input | `formsReadSearch: true` | unchanged |
| `searchFirst: true`, no visible input | `workflow: "skipToResults"`, `formsReadSearch: true` | unchanged |
| no `searchFirst`, effective filter, no visible input (derived skip) | `workflow: "skipToResults"` | unchanged |
| list first, app declares Android only | `workflow: "listFirst"` | unchanged |
| list first, app declares Web Apps, a visible input | absent (search first) | `auto_launch` false → true |
| list first, app declares Web Apps, no visible input | `workflow: "skipToResults"` (departure, §14) | `auto_launch`, `default_search` false → true |

### 4.4 Project-space compatibility

`projectSpaceCompatibility.ts::advancedCaseSearchReasons`: "The menu opens on Search." becomes "The menu's
forms read the search." for `moduleUsesInlineSearch`. Search first and skip to results without it ask for
nothing (HQ's selector offers both without CASE_SEARCH_ADVANCED, §2.1). The related-case reason "A menu
that opens on Search follows a parent case chosen first." becomes "A menu whose forms read the search
follows a parent case chosen first." `moduleRequiresNoMatchesRegistration` is renamed
`moduleRequiresCaseListRegistration` and reads `caseListRegistrationFormOf` (§9); its capability
(`registration-after-empty-search`) is unchanged.

---

## 5. Platform rows

### 5.1 `list-first` (new)

`lib/domain/platforms.ts`:

```ts
"list-first": {
	label: "Case list first",
	channel: "structure",
	webApps: {
		reading: "unavailable",
		note: "a menu that searches can't open on its case list first, and CommCare HQ turns such a menu to Search first when its case list is saved there",
		remedy: "You can open the menu on Search first, which Android still opens on its case list.",
	},
	android: { reading: "runs" },
	refusal: {
		what: "opens on its case list before Search",
		why: "CommCare HQ no longer offers the case list first for a menu that searches in Web Apps, and turns such a menu to Search first when its case list is saved there.",
		alternative: "open the menu on Search first, which Android still opens on its case list",
		pickerLine:
			"Not available in Web Apps. You can open this menu on Search first, which Android still opens on its case list, or change where this app runs in App settings.",
	},
},
```

- **Detector** (`lib/domain/platformUses.ts::moduleUses`): a module whose `moduleSearchWorkflow` is
  `"listFirst"`; owner the module; site `caseSearchConfig.workflow`.
- **Entry** (`lib/commcare/surface/entries/case-search.json`, inserted after
  `auto-launch-false-in-an-app-with-cloudcare-enabled-false`):
  `case-search/list-first-where-web-apps-is-declared`, `origin: "export-use"`, `surfaceKeys: []`,
  `noSurfaceKey`: "The declaration and `auto_launch` together: an app that declares Web Apps sends
  `cloudcare_enabled`, where HQ's Case List page shows its workflow selector, which offers no list first
  without CASE_SEARCH_DEPRECATED_NORMAL_CASE_LIST (views/modules.py::get_module_view_context,
  case_claim.js::searchConfigModel); the wire class is the REFUSED
  `workflow-legacy-classic-auto-launch-false-in-an-app-with`.", `disposition: "HELD"`,
  `dispositionCell`: "**HELD**: `caseSearchConfig.workflow: listFirst`, refused where Web Apps is
  declared", platforms `each`, Web Apps `unavailable` with the note above, Android `runs`. This is step 4's
  `application-and-settings/connect-app-opened-in-the-connect-app` precedent: an export-use entry with no
  surface key standing for a platform reading no surface item holds.
- **Ambient** (C1): `AMBIENT_PLATFORM_ENTRIES["case-search/auto-launch-false-in-an-app-with-cloudcare-enabled-false"]`
  becomes "The wire form of list first in an app that declares Android only, which no Web App reads;
  `list-first` states list first's readings." Its manifest `dispositionCell` becomes "**HELD**:
  `caseSearchConfig.workflow: listFirst`, admitted only in an app that declares Android only".
- **Cause word**: `PLATFORM_CAUSE_WORDS["list-first"] = "menus that open on their case list first"`.
- **Fixture pair** (`lib/domain/__tests__/platformFeatureFixtures.ts`): an Android-only app whose `Visits`
  module searches with `workflow: "listFirst"`; the same document with the workflow absent.
- **Copy, three voices** (step 4 part 01 §7's frame; app declares both):
  - Agent and MCP (`platformRefusalMessage`): `Module "Visits" opens on its case list before Search, and
    the app runs in Web Apps and on Android. CommCare HQ no longer offers the case list first for a menu
    that searches in Web Apps, and turns such a menu to Search first when its case list is saved there.
    You can open the menu on Search first, which Android still opens on its case list, or, if workers use
    only the CommCare app on Android, set the app to run only on Android (updateApp/update_app,
    runs_only_on "android").`
  - Builder (`lib/doc/userFacingErrors.ts::PLATFORM_BUILDER_COPY["list-first"]`): lead
    `` `${subject} opens on its case list first, which CommCare HQ no longer offers in Web Apps.` ``,
    alternative `"open it on Search first"`, which `platformBuilderSentence` frames as `"Visits" opens on
    its case list first, which CommCare HQ no longer offers in Web Apps. You can open it on Search first,
    or set the app to run only on Android in App settings.`
  - Picker line: the row's `pickerLine` above.

Rejected: a validator rule outside the platform table. It would bypass the declaration change preflight
(`lib/doc/platformChangePreflight*`), the picker line and the notice cause words, so adding Web Apps to an
app holding list first would be refused with nothing listing why.

### 5.2 `forms-read-search` (new id for today's inline row)

```ts
"forms-read-search": {
	label: "Forms that read the search",
	channel: "structure",
	webApps: {
		reading: "runs",
		note: "a form opened from a link or an entry point reads each Search field's starting value, not what the worker searched for",
	},
	android: {
		reading: "unavailable",
		note: "a worker can open only a case the phone already holds",
		remedy: "You can let the menu search first without its forms reading the search.",
	},
	refusal: {
		what: "has its forms read the search",
		why: 'On Android a worker can open only a case the phone already holds, and choosing any other case stops with "Session Refresh Required".',
		alternative: "turn off Forms read the search, so the menu searches first and each form reads the case it opens",
	},
},
```

- **Detector**: `moduleFormsReadSearch(module)`; owner the module; site `caseSearchConfig.formsReadSearch`.
  The reads today's `search-first` detector lets ride on it (a `#search/` or `results:inline` read in a
  form, the case list registration form) stay covered: step 4 decision 7's one-finding-per-module rule.
- **Entries**: the six `search-first` names at `main`, plus the two that flip HELD-NEW → HELD here:
  `case-search/inline-search-true-auto-launch-true-on-a-module-without-visible` and
  `case-search/inline-search-default-search-on-a-module-with-visible-inputs`. All read `runs / unavailable`.
- **Cause word**: `PLATFORM_CAUSE_WORDS["forms-read-search"] = "menus whose forms read the search"`.
- **Fixture pair**: a Web-Apps-only case-first module with a visible input and `formsReadSearch: true`;
  the same module without it.
- **Copy**:
  - Agent and MCP: `Module "Patients" has its forms read the search, and the app runs in Web Apps and on
    Android. On Android a worker can open only a case the phone already holds, and choosing any other case
    stops with "Session Refresh Required". You can turn off Forms read the search, so the menu searches
    first and each form reads the case it opens, or, if workers use only Web Apps, set the app to run
    only in Web Apps (updateApp/update_app, runs_only_on "web-apps").`
  - Builder: lead `` `${subject} has its forms read the search, which on Android can't open a case the
    phone doesn't hold.` ``, alternative `"turn off Forms read the search"`.
  - Picker line: the generic `Not available on Android. You can change where this app runs in App
    settings.`

### 5.3 `search-first` (redefined), `skip-to-results`, `search`

```ts
"search-first": {
	label: "Search first",
	channel: "structure",
	webApps: { reading: "runs" },
	android: {
		reading: "ignored",
		note: "the case list opens first, and Search opens the Search screen",
	},
},
```

No `refusal`; it leaves `REFUSABLE_PLATFORM_FEATURE_IDS`. Detector: `moduleSearchWorkflow(module) ===
"searchFirst" && !moduleFormsReadSearch(module)`; site `caseSearchConfig.workflow` (the absent slot is
named by its key). Entry: `case-search/workflow-search-first-auto-launch-true-default-search-false`, which
flips HELD-NEW → HELD here with readings unchanged (`runs / ignored`) and disposition cell "**HELD**:
`caseSearchConfig.workflow` absent (search first)".

`skip-to-results`: the label "Skip to results" becomes "Results first" (part 07 §3.8's word for the
value); readings and notes unchanged. Detector `moduleSearchWorkflow(module) ===
"skipToResults" && !moduleFormsReadSearch(module)`; site `caseSearchConfig.workflow`. Its entry's
disposition cell drops "derived ... widen:" for "**HELD**: `caseSearchConfig.workflow: skipToResults`,
authored", and its `slotChanges` empties.

`search`: detector `search !== undefined && !moduleFormsReadSearch(module)` (list first, search first and
skip to results, all on the remote request). Readings unchanged.

### 5.4 `case-list-menu-item`

Label "Case list menus" becomes "Case list menu entries". Detector: `moduleHasCaseListMenuItem(module)`
(§8.2), every module with the item, formless or beside forms; site `caseListMenuItem`. Its notes and its
second entry are G1's (§18): under each outcome `menus-and-case-lists/module-case-list-show-true-on-a-basic-module-with-forms`
flips HELD-NEW → HELD and joins this feature, unless that outcome makes it refusable, where it takes its own
feature. The Android note becomes "with no case details, choosing a case returns to the home screen, and
with them, Done returns to the list" (§2.4), unless G1's device half reads otherwise (§18 G1, the Android
outcomes).

### 5.5 Order and the binding tests

`PLATFORM_FEATURE_IDS` from pull request 10: `"datetime-question"`, `"case-list-here"`,
`"forms-read-search"`, `"list-first"`, `"several-cases"`, `"search-field-single-date"`,
`"search-field-multiple-choice"`, `"connect-app"`, `"case-list-search-text"`, `"window-width"`, then the
features that refuse nothing in their `main` order with `"search-first"` inserted before `"search"`.
`REFUSABLE_PLATFORM_FEATURE_IDS` follows that order: `datetime-question`, `case-list-here`,
`forms-read-search`, `list-first`, `several-cases`, `search-field-single-date`,
`search-field-multiple-choice`, `connect-app`, `case-list-search-text`, `window-width` (plus any refusable
row pull requests 2 to 9 add, in table order; part 10 reconciles). `PLATFORM_FEATURE_ENTRIES` renames its
`search-first` key to `forms-read-search` (eight entries), adds `list-first` (one) and `search-first`
(one), and `case-list-menu-item` gains its G1 entry.

`platformFeatures.test.ts` rules 1 to 7 pass over these tables (each feature's entries HELD and of its
reading pair; every HELD entry that differs by platform a feature's or ambient; no entry named twice).

### 5.6 Cause words, current and historical

`lib/notices/migrationNoticeCopy.ts`:

```ts
export const PLATFORM_CAUSE_WORDS: Readonly<Record<string, string>> = {
	"datetime-question": "date-and-time questions",
	"case-list-here": "case-list columns that read the worker's location",
	"case-list-search-text": "reads of the case list's search text",
	"forms-read-search": "menus whose forms read the search",
	"list-first": "menus that open on their case list first",
	"several-cases": "menus that choose several cases",
	"search-field-single-date": "date search fields",
	"search-field-multiple-choice": "multiple-choice search fields",
	"window-width": "reads of the window's width",
	"connect-app": "CommCare Connect",
};

/** Cause ids a stored notice row may carry that no current feature reads
 *  `unavailable` with: step 4's cutover wrote `search-first` for the inline
 *  shape, which step 5 renamed `forms-read-search`. Read after
 *  `PLATFORM_CAUSE_WORDS`, so a stored row renders as it did. */
export const HISTORICAL_PLATFORM_CAUSE_WORDS: Readonly<Record<string, string>> = {
	"search-first": "menus that use Search first",
};
```

`causePhrase` looks an id up in `PLATFORM_CAUSE_WORDS`, then in `HISTORICAL_PLATFORM_CAUSE_WORDS`.
Step 4's stored rows (cutover `hq-round-trip-platforms`, reason `platforms-declared`, `detail.causes`
holding `search-first`) keep rendering "menus that use Search first".

---

## 6. Validator

### 6.1 Codes and their messages

Every code keeps its class and location; each message is given in the agent and MCP voice (the finding's
`message`) and the builder voice (`lib/doc/userFacingErrors.ts`), in Nova's voice (`design/readme.md`,
"Content fundamentals"). Placeholders are `X` the module's name, `P` another module's, `F` a form's, `S` a
source form's.

`lib/commcare/validator/rules/case-search/searchFirst.ts` is renamed `formsReadSearch.ts`:

| Code (was) | Fires when | Agent and MCP | Builder |
|---|---|---|---|
| `FORMS_READ_SEARCH_REQUIRES_CASE_FIRST_MODULE` (`SEARCH_FIRST_REQUIRES_CASE_FIRST_MODULE`) | `moduleFormsReadSearch(mod)`, and the module is neither a bare case list with a case type nor `moduleIsCaseFirst` | `Module "X" has its forms read the search, which runs the search as each case form opens, so the menu's first screen has to choose a case, and it doesn't: the menu needs a case type and only forms that work on an existing case, or no forms at all. You can move its registration or survey forms to another menu, or turn off Forms read the search (formsReadSearch null), so the menu searches first and each form reads the case it opens.` | `"X" has its forms read the search, so its first screen needs to choose a case. You can move its registration or survey forms to another menu, or turn off Forms read the search.` |
| `FORMS_READ_SEARCH_NO_BUTTON_DISPLAY_CONDITION` (`SEARCH_FIRST_NO_BUTTON_DISPLAY_CONDITION`) | `formsReadSearch` and a stored `searchButtonDisplayCondition` | `Module "X" has its forms read the search, so it has no Search button for its button condition to show or hide. You can clear the condition, or turn off Forms read the search (formsReadSearch null) to bring the Search button back.` | `"X" has its forms read the search, so there's no Search button for its condition to control. You can clear the condition, or turn off Forms read the search.` |
| `FORMS_READ_SEARCH_UNIQUE_INSTANCE` (`SEARCH_FIRST_UNIQUE_INSTANCE`), submenu arm | the parent's forms read the search | `Module "X" is a submenu under "P", whose forms read the search. CommCare gives both menus the same search results and can't tell them apart. You can move "X" to the top level, or turn off Forms read the search on "P".` | (one builder sentence for the three arms) `"X" shares its search results with a menu whose forms read the search, and CommCare can't tell the two apart. You can keep that menu without submenus and choose parent cases from another menu, or turn off Forms read the search there.` |
| same, root arm | the module's forms read the search and it has submenus | `Module "X" has its forms read the search and has submenus. CommCare gives a submenu the same search results as its parent and can't tell them apart. You can move the submenus to the top level, or turn off Forms read the search.` | as above |
| same, parent-select arm | the module chooses a parent case from a menu whose forms read the search | `Module "X" chooses a parent case from "P" first, and "P"'s forms read the search. CommCare gives both choices the same search results and can't tell them apart. You can turn off Forms read the search on "P", or choose the parent case from another menu or a flat list.` | as above |
| `FORMS_READ_SEARCH_WITH_LIST_FIRST` (new) | `workflow: "listFirst"` beside `formsReadSearch: true` (a batch that sets one while the other is stored) | `Module "X" opens on its case list first, so its forms can't read the search, which runs only when the menu opens on Search first or on its results. You can choose Search first or Results first (searchWorkflow), or turn off Forms read the search (formsReadSearch null).` | `"X" opens on its case list first, so its forms can't read the search. You can open it on Search first or on its results, or turn off Forms read the search.` |

The header comment of `formsReadSearch.ts` reads "The refusals behind a menu whose forms read the search
(`caseSearchConfig.formsReadSearch`), which lowers to CommCare's inline search ...", with the rest of
today's text renamed. `FORMS_READ_SEARCH_WITH_LIST_FIRST` is a module rule in the same file, in
`MODULE_RULES` beside the other three.

`lib/commcare/validator/rules/case-search/searchNoMatches.ts` is renamed `caseListRegistration.ts`, and
its rules read `Module.caseListRegistrationForm` (§9). The form-scoped rule becomes a module rule over the
slot, located at the module with `details: { formUuid }` so the builder can name the form:

| Code (was) | Fires when | Agent and MCP | Builder |
|---|---|---|---|
| `CASE_LIST_REGISTRATION_REQUIRES_FORMS_READ_SEARCH` (`SEARCH_NO_MATCHES_ENTRY_REQUIRES_SEARCH_FIRST`) | the slot is set and `!moduleFormsReadSearch(mod)` | `Module "X" offers "F" when a search finds nothing, but its forms don't read the search, so no search runs before its list. You can turn on Forms read the search for the menu (formsReadSearch true), or stop offering the form (case_list_registration null on update_form).` | `"X" offers "F" when a search finds nothing, but its forms don't read the search. You can turn on Forms read the search, or stop offering the form there.` |
| `CASE_LIST_REGISTRATION_NOT_REGISTRATION` (`SEARCH_NO_MATCHES_ENTRY_NOT_REGISTRATION`) | the named form's `type !== "registration"` | `Module "X" offers "F" when a search finds nothing, so "F" needs to register a new "<caseType>" case, and it is a <type> form. You can make it a registration form, or stop offering it there.` | `"F" is offered when a search finds nothing, so it needs to register a new case. You can make it a registration form, or stop offering it there.` |
| `CASE_LIST_REGISTRATION_MULTIPLE_RETURN` (`SEARCH_NO_MATCHES_ENTRY_MULTIPLE_RETURN`) | several-case selection and the form's `postSubmit !== "firstMenu"` | `"F" registers one case, but "X" selects several cases, and CommCare can't carry that new case back into the search. You can set the form's after-submit destination to First menu, or let "X" select one case.` | `"F" registers one case, but "X" selects several. You can choose First menu after submit, or let the menu select one case.` |
| `CASE_LIST_REGISTRATION_HAS_NAVIGATION` (`SEARCH_NO_MATCHES_ENTRY_HAS_NAVIGATION`) | the form holds links, a `postSubmit` other than `firstMenu`, a display condition or `hiddenFromMenu` | `"F" is offered when a search finds nothing in "X", so after submit it returns to the search or to First menu, and it's on no menu; it can't carry <list>. You can remove them, or stop offering the form there.` | `"F" is offered when a search finds nothing. It returns to Results or First menu, and can't have after-submit links, a display condition, or be taken off the menu. You can clear those settings, or stop offering it there.` |
| `CASE_LIST_REGISTRATION_FORM_NOT_IN_MODULE` (new) | `formUuid` is not in `doc.formOrder[moduleUuid]` | `Module "X" offers a registration form when a search finds nothing, but that form isn't one of "X"'s forms. You can choose one of its own registration forms, or stop offering one (caseListRegistrationForm null).` | `"X" offers a form from another menu when a search finds nothing. You can choose one of its own forms instead.` |

`SEARCH_NO_MATCHES_DUPLICATE` retires: one slot per module makes two unrepresentable.
`CASE_LIST_REGISTRATION_FORM_NOT_IN_MODULE` is the backstop for a reducer path that misses the slot (§9.3);
it is scope-exempt like `SEARCH_NO_MATCHES_DUPLICATE` was, because a `moveForm` in another module's scope
can strand it.

`rules/form.ts`: `FORM_LINK_TARGET_NO_MATCHES_FORM` becomes `FORM_LINK_TARGET_CASE_LIST_REGISTRATION_FORM`
(target a form some module's `caseListRegistrationForm` names). Agent: `"S" <label> targets "F" in "X",
which opens only when a search finds nothing and is on no menu. You can target the menu instead, so the
worker searches, or another form.` Builder: `An after-submit link in "S" points to a form that only opens
when a search finds nothing. You can point it at the menu instead, or remove it.` Part 06 owns the rest of
that file from pull request 11. `FORM_LINK_SEARCH_CASE_UNREPRESENTABLE`'s builder copy "a destination that
opens on Search" becomes "a destination whose forms read the search", and its alternative "a destination
that opens on its case list" becomes "a destination whose forms read their own case".

`rules/module.ts`:

| Code (was) | Fires when | Agent and MCP | Builder |
|---|---|---|---|
| `CASE_LIST_MENU_ITEM_NO_CASE_TYPE` (`CASE_LIST_ONLY_NO_CASE_TYPE`) | `moduleHasCaseListMenuItem(mod)` and no case type | `Module "X" lists its case list as a menu entry but has no case type, so the list has no cases to show. You can set the case type it lists, or take the entry off (case_list_menu_item null).` | `"X" shows a case list entry, but you haven't picked which case type to list. You can pick one, or turn the entry off.` |
| `NO_FORMS_OR_CASE_LIST` (copy only) | neither menu forms nor the item | typed branch: `Module "X" has a case type ("t") but no forms. CommCare needs forms that work with its cases or a case list entry, so you can add a form, give it a case list menu entry, or, if you're removing its last form, delete the whole menu.`; untyped branch unchanged | unchanged |

`CASE_LIST_ONLY_HAS_FORMS` retires with its builder copy: the item is admitted beside forms (§2.4).
`NESTED_MENU_CROSS_TYPE_ROOT_REQUIRES_FORM` reads `moduleIsBareCaseList(doc, parentUuid)` where it reads
`parent.caseListOnly === true && menuFormUuidsOf(...).length === 0`; its copy is unchanged.

`lib/commcare/validator/errors.ts`: the code union drops `CASE_LIST_ONLY_HAS_FORMS`,
`CASE_LIST_ONLY_NO_CASE_TYPE`, `SEARCH_FIRST_*` (3), `SEARCH_NO_MATCHES_*` (5),
`FORM_LINK_TARGET_NO_MATCHES_FORM`, and gains the eleven codes above. `SCOPE_EXEMPT_CODES` replaces
`SEARCH_NO_MATCHES_DUPLICATE` with `CASE_LIST_REGISTRATION_FORM_NOT_IN_MODULE`.

### 6.2 After submit

`lib/domain/forms.ts::PostSubmitMenuShape.searchFirst` becomes `formsReadSearch` ("The menu's forms read
the search (`moduleFormsReadSearch`)."), read by `defaultPostSubmit` exactly where `searchFirst` is read.
`lib/domain/postSubmit.ts`:

- `POST_SUBMIT_NOT_OFFERED_REASONS`: `"menu-opens-on-search"` becomes `"menu-forms-read-search"` and
  `"menu-is-case-list-only"` becomes `"menu-is-bare-case-list"`, same order, same withheld destinations.
- `PostSubmitModuleFacts.caseListOnly` becomes `bareCaseList`, filled by `moduleIsBareCaseList(doc,
  moduleUuid)`; `searchFirst` is filled by `moduleFormsReadSearch(mod)`.
- The two reason sentences (`rules/form.ts::postSubmitNotOfferedMessage` and
  `userFacingErrors.ts::postSubmitNotOfferedSentence`): `"F" goes to the previous screen after submit,
  but "X" has its forms read the search, and CommCare can't go back to the previous screen there.` and
  (unchanged words) `"F" goes to its module after submit, but "X" is a case list with no forms, so there
  is no form list to land on.`

So a non-inline search-first menu offers `previous`, as HQ does (§2.2). Nova is deliberately stricter than
HQ for a registration form of a menu whose forms read the search, which HQ lets go back (its refusal
covers case-loading forms only): `menu-forms-read-search` is a fact of the menu, so every form of that
menu is offered the same destinations, and the registration form keeps `module`. The reason ids are validator
`details` only; no stored row carries them. Part 06 reads the renamed reasons for the otherwise from
pull request 11.

### 6.3 The `#search/` scope

`lib/domain/expression/context.ts::FormExpressionFacts.searchFirstModule` becomes
`formsReadSearchModule` (`moduleFormsReadSearch(module)`), and `noMatchesForm` becomes
`caseListRegistrationForm` (the form is named by its module's slot). In
`lib/domain/expression/typeChecker.ts` the refusal reason `"not-search-first"` becomes
`"not-forms-read-search"` with the message "Search answers are available only in the forms of a menu whose
forms read the search." (the form-link arm's message is unchanged). `lib/domain/menuForms.ts::
searchInputNameResolver` reads the renamed facts. `components/builder/shared/checkErrorPresentation.ts`
keeps "Choose a Search answer available in this setting". `rules/case-list/searchInputRefUsesWhenInputPresent.ts`,
`lib/codemirror/expressionEditorContext.ts` and `suite/case-list/orderPlanOptions.ts` read
`moduleFormsReadSearch` where they read `searchFirst`.

### 6.4 The platform channel

`PLATFORM_FEATURE_UNAVAILABLE` (`rules/platforms.ts`) gains `list-first` (module owner, Web Apps) and
`forms-read-search` (module owner, Android) and loses `search-first`, because the rule iterates
`REFUSABLE_PLATFORM_FEATURE_IDS`. `userFacingErrors.ts::PLATFORM_BUILDER_COPY` renames its
`search-first` key to `forms-read-search` with §5.2's lead and gains §5.1's `list-first`.

---

## 7. Mutations and planners for the search

### 7.1 The patch

`lib/doc/types.ts::caseSearchConfigPatchSchemaFor`:

```ts
return z
	.strictObject({
		excludedOwnerIds: configSchema.shape.excludedOwnerIds.nullable(),
		searchScreenTitle: configSchema.shape.searchScreenTitle.nullable(),
		searchScreenSubtitle: configSchema.shape.searchScreenSubtitle.nullable(),
		searchButtonDisplayCondition: configSchema.shape.searchButtonDisplayCondition.nullable(),
		/** `null` is search first. */
		workflow: configSchema.shape.workflow.nullable(),
		formsReadSearch: configSchema.shape.formsReadSearch.nullable(),
	})
	.partial();
```

`lib/doc/mutations/modules.ts` applies each key as today's per-key patch: `null` deletes, a value sets. A
patch that names `workflow: "listFirst"` while `formsReadSearch` stays stored produces the refused pair,
which the gate's `FORMS_READ_SEARCH_WITH_LIST_FIRST` refuses; every planner below that writes `listFirst`
writes `formsReadSearch: null` in the same patch. `lib/doc/incrementalValidationScope.ts` keeps the module
footprint for a search patch (the patch names the module); a patch naming `formsReadSearch` takes the
whole-document gate (`return undefined`), because `FORMS_READ_SEARCH_UNIQUE_INSTANCE` and the platform
rule read other modules, as a `searchFirst` patch does at `main`.

`lib/doc/diffDocsToMutations.ts`'s Search arm diffs `workflow` and `formsReadSearch` like the other
per-key settings, so autosave and `appendSyntheticBatch` reproduce a target that changes them.

### 7.2 A search with no visible field

`lib/doc/caseSearchConfigPatchMutations.ts` gains:

```ts
/**
 * Where a batch leaves a module with an effective ordinary search, no visible
 * Search field and an absent workflow, after it had a visible field or no
 * search, the module opens on its results: one `skipToResults` patch, after
 * the batch's own Search mutations. A module whose author chose search first
 * with no visible field keeps it; this reads the transition, not the state.
 */
export function workflowAfterInputChangeMutations(
	before: BlueprintDoc,
	after: BlueprintDoc,
	moduleUuid: Uuid,
): Mutation[];
```

It returns `[{ kind: "updateModule", uuid, patch: {}, caseSearchConfigPatch: { workflow: "skipToResults" } }]`
when, in `after`, `effectiveCaseSearchConfig` is ordinary, `visibleSearchInputs` is empty and
`workflow` is absent, and in `before` the module had no effective ordinary search or had a visible input;
`[]` otherwise. The three batch composers append it: `components/builder/case-list-config/
CaseListConfigWorkspace.tsx` (enable Search, remove or hide a Search field), `lib/agent/blueprintHelpers.ts`
(the SA and MCP Search input helpers behind `addSearchInputs`, `updateSearchInput`, `removeSearchInput`,
`configureCaseList`), and `caseSearchConfigPatchMutations` itself. Today those transitions derive skip to
results; from step 5 the planner writes it, and the builder's workflow control shows the written value as
**Results first** (part 07 §3.8).

### 7.3 Turning Forms read the search on and off

`lib/doc/searchNoMatchesForm.ts` is renamed `lib/doc/caseListRegistrationForm.ts` (§9.4).
`searchFirstOnMutations` becomes `formsReadSearchOnMutations(doc, moduleUuid)`: one `caseSearchConfigPatch`
`{ formsReadSearch: true }`, plus `workflow: null` when the stored workflow is `listFirst`.
`lib/doc/searchNoMatchesDependents.ts` is renamed `searchReadDependents.ts`; `SearchTakeaway` becomes
`"forms-read-search" | "search"` and `planSearchTakeawayDependents` keeps its plan: turning Forms read the
search off removes the search-answer starting values of the module's forms and clears the case list
registration form, as turning Search first off does at `main`.

`lib/doc/mutations/modules.ts::reconcilePostSubmitWithMenuShape` reacts to a patch naming
`formsReadSearch` (it changes the `previous` offer) where it reacts to `searchFirst`. From pull request 11,
part 06 extends the same reconcile to a built-in otherwise.

---

## 8. `Module.caseListMenuItem`

### 8.1 Stored shape

`lib/domain/modules.ts`, replacing `moduleSchema.caseListOnly` and `caseListConfigSchema.icon` /
`.audioLabel`:

```ts
export const caseListMenuItemSchema = z.strictObject({
	/** The entry's label. Absent is the module's name, with its translations. */
	label: z.string().min(1).optional(),
	/** The entry's image in the menu. */
	icon: moduleIconRefSchema.optional(),
	/** The entry's spoken label, played in audio-prompt mode. */
	audioLabel: mediaAssetIdSchema.optional(),
});
export type CaseListMenuItem = z.infer<typeof caseListMenuItemSchema>;

// moduleSchema
/**
 * The module's case list as its own menu entry, after its forms (HQ's order),
 * opening the case list without a form. Presence is the switch. A module with
 * a case type and no forms holds it; beside forms it is the author's choice.
 */
caseListMenuItem: caseListMenuItemSchema.optional(),
```

`caseListConfigSchema` loses `icon` and `audioLabel` and their comments.

### 8.2 Readers

```ts
/** The menu lists the case list as its own entry. */
export function moduleHasCaseListMenuItem(module: Pick<Module, "caseListMenuItem">): boolean {
	return module.caseListMenuItem !== undefined;
}

/** A case list menu entry and no menu forms: the menu is its case list. */
export function moduleIsBareCaseList(
	doc: Pick<BlueprintDoc, "modules" | "formOrder" | "forms">,
	moduleUuid: Uuid,
): boolean; // moduleHasCaseListMenuItem && menuFormUuidsOf(doc, moduleUuid).length === 0
```

`moduleIsBareCaseList` lives in `lib/domain/menuForms.ts` (it reads `menuFormUuidsOf`). Every
`caseListOnly` read at `main` takes one of the two. Today `caseListOnly` implies formless, so a site that
means "the menu is its list" takes the bare reader and a site that means "there is a case list entry" takes
the item reader:

| Site | Reader | Why |
|---|---|---|
| `lib/commcare/expander.ts` (`case_list.show`, label, media) | item | the entry exists |
| `lib/commcare/compiler.ts` (the local case list command and its `<display>`) | item | the entry exists |
| `lib/commcare/session.ts::deriveCaseListEntryDefinition` | item | the entry exists |
| `lib/commcare/validator/rules/parentSelection.ts` (`caseListSessionDatums`) | item | the entry's datums exist |
| `lib/domain/caseParentSelection.ts::selectsCases` | item | the entry selects cases |
| `lib/domain/entryDatumSupplies.ts` (the browse supply when no case-loading form) | item | the entry supplies the datum |
| `lib/domain/platformUses.ts` (`case-list-menu-item`) | item | the platform row is the entry's |
| `lib/preview/menuProjection.ts` (the menu row) | item | the entry is listed |
| `rules/module.ts::noFormsOrCaseList`, `CASE_LIST_MENU_ITEM_NO_CASE_TYPE` | item | the rule's own subject |
| `rules/module.ts::nestedMenuCrossTypeRootRequiresForm` | bare | a formless root |
| `rules/multiSelect.ts` (the compatible child consumer) | bare | a formless list |
| `rules/case-search/formsReadSearch.ts` (the case-first pass) | bare | a list with no forms |
| `lib/commcare/formLinkProjection.ts` (formless root) | bare | the root has no form entry |
| `lib/commcare/hqNestedSelection.ts` | bare | same |
| `lib/domain/postSubmit.ts` (`menu-is-bare-case-list`) | bare | no form list to land on |
| `lib/domain/moduleHierarchy.ts` (a bare list leaf) | bare | the tree collapses it |
| `lib/domain/navigation.ts` (`isBareCaseList`) | bare | the landing |
| `lib/routing/location.ts`, `lib/routing/hooks.tsx` (a bare list opens its workspace) | bare | the landing |
| `lib/doc/caseSelectionMutations.ts` (relevant parents) | bare | a formless parent |
| `lib/preview/afterSubmitRouting.ts`, `lib/preview/app-tests/navigation.ts` | bare | the landing |
| `lib/doc/hooks/useModuleIds.ts` (the bare-list id set) | bare | the tree |

### 8.3 Validator

`CASE_LIST_ONLY_HAS_FORMS` retires, `CASE_LIST_MENU_ITEM_NO_CASE_TYPE` and `NO_FORMS_OR_CASE_LIST` read the
item (§6.1). Admission beside forms is decided now (decisions 6): on every module with a case type, in every G1
outcome except one where a walk errors or stops, which makes it refusable where it fails (§18). On a
module emitted advanced the item lists every open case of its type, so part 02's kind blocker
`case-list-menu-item-narrowed` admits it there only where the module's list is not narrowed (part 02
§4.3, §17).

### 8.4 Emission

Wire unchanged for every module that holds `caseListOnly: true` at `main`:

- `expander.ts`: `case_list.show = true` for the item; `case_list.label` is the item's own unit
  (`makeTranslationUnitId("module", moduleUuid, "case-list-menu-item-label")`) when `label` is set, else
  the module name's unit (today's bytes); `case_list.media_image` / `media_audio` from the item's `icon` /
  `audioLabel`.
- `compiler.ts`: the local case list command for `moduleHasCaseListMenuItem(mod) && caseType`, its
  `<display>` from the same label and media; in the module's `<menu>` the command follows the form commands
  (HQ's order, §2.4).
- `session.ts`: the case list entry's datums are those `formLinkProjection.ts::entrySessionDatums` gives a
  case-loading form of the module (HQ's `configure_entry_module_form`), which the browse entry uses at
  `main` for a formless module and for case-list-only child entries; for a menu whose forms read the
  search, the entry carries the inline query datum as HQ's `add_remote_query_datums` adds it.
- `addOns.ts`: unchanged (`case_list.show`).
- The advanced module's entry (the case type alone, the `product_id` datum under CommTrack) is part 02's
  (part 02 §17), reading `moduleHasCaseListMenuItem`, and lands in this pull request: before it no
  advanced module can hold the item, since a module holding `caseListOnly` has no forms and an advanced
  module has the form holding its carried create.

### 8.5 Translation and media

- `lib/domain/translationUnits.ts` gains role `case-list-menu-item-label`, owner the module, inventoried
  only when `label` is set, source `caseListMenuItem.label`, breadcrumb `[module, "case list entry"]`, and
  joins `NONBLANK_TRANSLATION_ROLES`. `lib/commcare/localeFile.ts`, `lib/agent/translation/translator.ts`
  and `components/builder/app-setup/LanguagesSection.tsx` (`"Case list entry label"`) list it.
- `lib/domain/mediaRefs.ts` walks `caseListMenuItem.icon` / `.audioLabel` with the existing carriers
  `case-list-icon` / `case-list-audio`, and its remap follows. `lib/domain/referenceSlots.ts` registers
  `caseListMenuItem.icon` and `caseListMenuItem.audioLabel` as `media` and drops the two
  `caseListConfig` slots; `caseListMenuItem.label` is `prose`.

### 8.6 The mutation

`setCaseListMeta`'s patch loses `icon` and `audioLabel`. A new kind sets the whole item, as `setModuleMedia`
sets both media slots at once:

```ts
z.object({
	kind: z.literal("setCaseListMenuItem"),
	uuid: uuidSchema,
	/** The whole entry, or `null` to take it off the menu. */
	item: caseListMenuItemSchema.nullable(),
}),
```

The reducer (`lib/doc/mutations/modules.ts`) sets or deletes `caseListMenuItem`. It joins every kind-level
switch: `lib/doc/incrementalValidationScope.ts::mutationFootprint` (the module; the item's presence is read
by `NO_FORMS_OR_CASE_LIST` and the parent rules of its children, so the footprint names the module and its
child modules), `lib/doc/mutationTargetAdmission.ts` (module-scoped), `lib/doc/referenceIndex.ts` (the
media references), `lib/doc/diffDocsToMutations.ts` (one `setCaseListMenuItem` where the item differs),
`lib/doc/store.ts::affectsCaseWriteProjection` (no), and `proof/corpus/editKinds.ts::EDIT_KIND_GENERATORS`
(a generator that adds or removes the item on a module with a case type, typed by `satisfies
Record<Mutation["kind"], KindGenerator>`). `updateModule.patch.caseListOnly` leaves the patch schema.

### 8.7 Planners

- `lib/doc/scaffolds.ts::caseListModuleMutations` births `caseListMenuItem: {}` with the `Name` column.
- `moduleFormHostMutations` no longer touches the item: a form added to a bare case list keeps the menu's
  entry beside it (an authored entry is never removed in passing). It still seeds a `Name` column.
- Setting a case type on a formless module gives it `caseListMenuItem: {}`; clearing the type deletes the
  item with the case list and search config, as today's patch drops `caseListOnly`.
- Removing the last menu form of a module with a case type gives it `caseListMenuItem: {}` when absent
  (`lib/doc/hooks/useBlueprintMutations.ts`, where `main` sets `caseListOnly: true`).
- `noMatchesFormEntryMutations`' toggle of `caseListOnly` on a host whose last menu form leaves becomes the
  same `caseListMenuItem: {}` (§9.4).

---

## 9. `Module.caseListRegistrationForm`

### 9.1 Stored shape

`lib/domain/modules.ts`, replacing `Form.entry`:

```ts
export const caseListRegistrationFormSchema = z.strictObject({
	/** When the case list offers it. Step 5's one arm: after a search finds nothing. */
	kind: z.literal("after-empty-search"),
	/** A registration form of this module, on no menu. */
	formUuid: uuidSchema,
	/** The Register action's label. Absent is the form's name. */
	label: z.string().min(1).optional(),
});

// moduleSchema
caseListRegistrationForm: caseListRegistrationFormSchema.optional(),
```

The form stays in the host's `formOrder` and is on no menu. `lib/domain/forms.ts` loses `formEntrySchema`,
`Form.entry`, `formEntersFromMenu` and `isNoMatchesForm`. `lib/domain/menuForms.ts::noMatchesFormOf`
becomes `caseListRegistrationFormOf(doc, moduleUuid): Uuid | undefined`, and `menuFormUuidsOf` excludes the
form the slot names. The discriminator is stored now so step 7's arms add values without a migration
(§20, "for the outlines").

### 9.2 Validator

§6.1's `CASE_LIST_REGISTRATION_*` codes. `CASE_LIST_REGISTRATION_REQUIRES_FORMS_READ_SEARCH` admits the
host's search first and skip to results alike, as `main` admits search first with and without visible
inputs.

### 9.3 Reducers

- `removeForm` deletes the host's `caseListRegistrationForm` when it names the removed form, in the same
  reducer step.
- `moveForm` of the named form out of its module deletes the slot (the form becomes a menu form of its
  destination); a same-module reorder keeps it. The builder's and tools' move planners state it (part 07).
- `updateModule.patch.caseListRegistrationForm: caseListRegistrationFormSchema.nullable()` sets or clears
  the whole slot; `updateForm.patch.entry` leaves the schema.

### 9.4 Planners

`lib/doc/caseListRegistrationForm.ts` (renamed from `searchNoMatchesForm.ts`):
`noMatchesFormEntryMutations` → `caseListRegistrationMutations(doc, moduleUuid, formUuid, entry: { label?:
string } | null)` (sets or clears the module's slot; turning it on also turns Forms read the search on with
`formsReadSearchOnMutations`; clearing turns Forms read the search off and removes the search-answer
starting values, exactly as `main`'s clear turns Search first off, and the review names both);
`noMatchesRegistrationFormMutations` → `caseListRegistrationFormMutations` (creates the registration form
and names it); `carrySearchAnswersMutations`, `searchAnswerFields`, `searchAnswerDefaultsOf`,
`searchAnswerReadersOf` keep their names and read the slot.

### 9.5 Translation

The label unit moves from the form to the module: role `form-entry-label` becomes
`case-list-registration-label`, id `makeTranslationUnitId("module", moduleUuid,
"case-list-registration-label")`, owner the module, inventoried only when `label` is set, source the label
(today's source). The unit id changes, so the cutover moves each target language's overlay entry (value,
provenance, review state, fingerprint) from the old id to the new one (§14, M5). `LanguagesSection.tsx`'s
`"Register action label"` keys the new role.

### 9.6 Emission

Unchanged bytes: `emissionPlan.ts` reads `caseListRegistrationFormOf` where it reads `Form.entry`
(`hostLowersNoMatchesForm` becomes `hostLowersCaseListRegistration`); the synthetic hidden module,
`case_list_form`, `NO_MATCHES_RELEVANCY`, the return frame and the label keep their bytes (the label unit's
id is no wire byte; its text is the same source). `lib/preview/noMatchesForm.ts` is renamed
`caseListRegistration.ts` and reads the slot.

---

## 10. Durable search claims

### 10.1 The decision

A claim is a case row the case store holds, exactly HQ's claim case (§2.3): open, of type
`commcare-case-claim`, `case_name` the chosen case's name, `owner_id` the worker (the persona's UUID, or
the member's user id when previewing as the member), and one index: identifier `host`, relationship
`extension`, target the chosen case, `target_case_type` the chosen case's type captured at write as on every
edge. The restore closure already makes an owned open extension live and its host live
(`compileRestoreScope.ts`'s extension rules, held to HQ's 45 graphs), and `readDeviceCaseDatabase` returns
the claim rows in `casedb` as a device holds them, so Preview, App Tests and every device-scoped read need
no list of claims at all.

Rejected: a separate `case_claims` table (a second restore input every closure, count and search would
join, where HQ's claim is a case CommCare reads in `casedb`); keeping session-only claims (the outline gives
the durable claim to this step, and session claims disagree with HQ across a reload and across two members
previewing as one persona).

### 10.2 The domain leaf

`lib/domain/caseClaim.ts` (new, a client-safe leaf exported from the barrel):

```ts
/** HQ's claim case type (`case_search/models.py::CLAIM_CASE_TYPE`), already
 *  reserved for authors (`forms.ts::RESERVED_CASE_OPERATION_TYPES`). */
export const CASE_CLAIM_CASE_TYPE = "commcare-case-claim";
/** The claim's one index (`casexml/apps/case/const.py`, the extension default). */
export const CASE_CLAIM_HOST_INDEX = "host";
/** Storable, not authorable, as the worker's own case is: no properties. */
export function caseClaimCaseType(): CaseType {
	return { name: CASE_CLAIM_CASE_TYPE, properties: [] };
}
```

The type stays out of `effectiveCaseTypes` and `materializableCaseTypes` (no module lists it, no picker
offers it) and enters at the storage boundary beside the usercase:
`lib/case-store/store.ts::buildCaseTypeMap` sets `CASE_CLAIM_CASE_TYPE` after `USERCASE_CASE_TYPE`, and
`lib/db/materializeCaseStoreSchemas.ts` adds `{ name: CASE_CLAIM_CASE_TYPE }` to the loop that adds the
usercase, so every app born from pull request 10 holds the schema row from genesis.
`lib/db/classifyCaseTypeChanges.ts` gains no arm: the type never changes, so there is nothing to sync after
genesis. Every existing app gains the row through the existing drift writer after the deploy and before
ingress reopens (§14, M6; part 09 §12): `scripts/lib/schemaDrift.ts::computeSchemaDrift` reads
`buildCaseTypeMap`, which now holds the claim type, and skips only the missing worker's-record row, so it
creates the claim row in every app it reads. This pull request adds no skip for the claim type to that
function's loop. Wherever a row is still missing,
`lib/preview/engine/caseDataBindingHelpers.ts::schemaHealingCaseStore` heals it at the first claim, as it
heals any missing row. An App Test namespace takes its schema rows from `buildCaseTypeMap`
(`lib/preview/app-tests/seed.ts`), so it holds the claim type from its start.

### 10.3 The store

`lib/case-store/store.ts::CaseStore` gains three methods, implemented in
`lib/case-store/postgres/store.ts` and wrapped by `schemaHealingCaseStore` (`claimCases` on the healing
side, since it writes a row of a type whose schema row may be missing; the other two delegate as reads and
closes do):

```ts
/**
 * Claim searched cases for the bound worker, as HQ's claim endpoint does
 * (`ota/views.py::claim`). One transaction under the store's lock order:
 * every id must name a case of this app in the bound Project, open or closed
 * (`cleanup.py::get_first_claims` checks existence only); one that names none
 * refuses the whole call with `CaseNotFoundError`, nothing written. Each host
 * row is locked `FOR UPDATE` in case id order, so two claims of one host by
 * one worker never both insert. For each id with no open claim row owned by
 * the bound owner whose `host` index targets it, one claim row is inserted
 * with its index through the submission envelope's row and index writer.
 */
claimCases(args: {
	readonly appId: string;
	readonly caseIds: readonly string[];
}): Promise<{
	readonly created: readonly string[];
	readonly alreadyClaimed: readonly string[];
}>;

/** Close every open claim row the bound owner holds in this app (`close`'s
 *  lifecycle: `status` closed, `closed_on` now). A closed claim seeds nothing,
 *  so its host leaves the worker's restore unless something else holds it. */
releaseClaims(args: { readonly appId: string }): Promise<{ readonly released: number }>;

/** The open claim rows the bound owner holds in this app. */
countClaims(args: { readonly appId: string }): Promise<number>;
```

`caseIds` is 1 to 1,000 distinct ids of 1 to 255 characters (the bounds `previewClaimedCaseIds` checks at
`main`), else `claimCases` throws a new `ClaimCasesInputError` (`lib/case-store/errors.ts`) naming the bound
it broke ("A claim names 1 to 1,000 distinct case ids, each 1 to 255 characters. Check the caller that
collects the chosen cases."). The claim
row's `case_name` is the host's `case_name`, `properties` `{}`, `opened_on` now.

`resetSampleData` (the Case data manager's replace and `resetSampleCasesAction`) deletes, in its
transaction and before it detaches surviving children, every claim row whose `host` index targets a row it
deletes: an edge to a deleted case would dangle, and a claim without its host means nothing.

### 10.4 Server Actions

`lib/preview/engine/caseDataBinding.ts` gains three actions, each through
`resolveAuthorizedPreviewContext({ required: "view", personaUuid, device })` with plain JSON arguments (the
WAF rule) parsed by a Zod schema at the boundary:

```ts
export async function claimSearchedCasesAction(args: {
	appId: string;
	caseIds: readonly string[];
	personaUuid?: string;
	device?: PreviewDevice;
}): Promise<
	| { kind: "claimed"; created: readonly string[]; alreadyClaimed: readonly string[] }
	| { kind: "case-gone"; message: string }
	| { kind: "refused"; message: string }
	| { kind: "unauthenticated" }
	| { kind: "persona-unavailable"; message: string }
>;
export async function releaseClaimedCasesAction(args: {
	appId: string;
	personaUuid?: string;
}): Promise<{ kind: "released"; released: number } | { kind: "refused"; message: string } | { kind: "unauthenticated" } | { kind: "persona-unavailable"; message: string }>;
export async function countClaimedCasesAction(args: {
	appId: string;
	personaUuid?: string;
}): Promise<{ kind: "count"; count: number } | { kind: "refused"; message: string } | { kind: "unauthenticated" } | { kind: "persona-unavailable"; message: string }>;
```

`view` is right: a claim is what the running app's navigation does, as the usercase row's ensure is
(`previewAuthorization.ts::withMaterializedUsercase`), and a viewer runs Preview; requiring `edit` would
stop a viewer's Preview at every unheld search result. `CaseNotFoundError` from `claimCases` answers
`case-gone` with "This case was removed from the app's case data, so it can't be opened. You can search
again to see what's there now."; any other failure is reported (`reportUnexpectedActionError`) and answers
`refused` with "Couldn't open this case. Try again in a moment.".

### 10.5 When a claim posts

The rules are `main`'s; the writer is new.

- **At the chosen result**: a list-first, search-first or skip-to-results menu whose forms do not read the
  search, when a chosen row is `claimable` (a search found it and the worker's device does not hold it,
  `lib/preview/searchClaims.ts::previewCaseChoiceOf`). This is the remote request's own `<post>`.
- **At the form's entry**: a menu whose forms read the search, when a case-loading form opens, claiming the
  chosen cases and `parentSelectClaimChoices` (`entries.py::add_post_to_entry`).
  `lib/preview/searchClaims.ts` reads `moduleFormsReadSearch` where it reads `moduleOpensOnSearch`.
- **An entry point launch on Web Apps** (`rules.entryPointClaims === "posted"`):
  `lib/preview/entryPointLaunchAction.ts::launchEntryPointAction` writes the launch's `claimCaseIds` with
  `context.store.claimCases` after its last authorization check and before it returns `ready`, so the
  launch is the claim frame HQ posts (`endpoints.py::EndpointsHelper._add_claim_frame`).
  `readNotHeldCases` reads `store.readCaseDatabasePatch({ appId, caseIds: outside })` (the exact rows and
  their direct indices, which is all it keeps today). `prepareEntryPointLaunch` keeps computing
  `claimCaseIds` (it reads `moduleFormsReadSearch` for its exclusion), and `installEntryPointLaunch` loses
  its claim argument.

`CaseListScreen` and the form screen call `claimSearchedCasesAction` through a new hook,
`lib/preview/hooks/useClaimSearchedCases.ts`, which returns `claim(caseIds): Promise<ClaimOutcome>` and the
ids of the claim in flight. Until the device snapshot holds every id of that claim, the screen passes those
ids to `searchClaims.ts::deviceCasesHoldingClaims`, so a menu condition that reads the device's cases waits
rather than reading a claimed case as missing, as it does at `main` with the session's ids.

### 10.6 After a claim

The client calls `invalidateCaseData(appId, caseType)` for every effective case type of the app (the
device snapshot's revision spans them, `lib/preview/hooks/caseDataInvalidation.ts::useCaseDatabaseRevision`)
when `created` is not empty, on both platforms, so the device is read again as a restore after a new claim
would be. On Android (`rules.claimThenSync`) the same happens after every claim, including one that created
nothing, and `previewDeviceSyncedAt` advances as Sync with server advances it (`lib/session/store.ts`):
Android follows every claim with a sync
(`case-search/the-generated-search-round-trip-remote-request-query-results`).

### 10.7 Lifetimes and release

A claim lasts as HQ's does, until its row is closed. Nova closes or removes claim rows in three places and
no other:

1. **Release claimed cases**, in `components/builder/PreviewIdentityMenu.tsx`, under **Running as**, shown
   while the running worker holds claims (`countClaimedCasesAction` when the menu opens). Its label is
   `Release 3 claimed cases` (`Release 1 claimed case` for one). Choosing it calls
   `releaseClaimedCasesAction`, invalidates every effective case type, and shows a success toast: `Released
   3 cases this worker claimed from a search. Their device no longer holds them, unless the worker holds
   them another way.` On failure the toast reads `Couldn't release the claimed cases. Try again in a
   moment.` It is builder chrome, never simulated-app UI.
2. **Replacing a case type's data** deletes the claim rows of the hosts it deletes (§10.3).
3. **An App Test journey's claim rows** live in its namespace and go with it.

A page reload, a change of worker, a change of platform, Home and Clear form keep claims (each was a
session-only claim's end at `main`). A persona's removal keeps its claim rows as it keeps every row it owns;
`countCasesOwnedByAction` counts them, and the removal confirmation already says rows remain. Claim rows are
case rows of the app, so an app's move between Projects carries them, and same-Project case-data recovery
restores them, with no claim-specific code. An automation over `commcare-case-claim` (an author may write a
"Close abandoned claims" rule, `lib/automations/__tests__/automations.test.ts::claimCleanup`) now counts
Preview's real claim rows in its match projection, which is what HQ's rule would count.

### 10.8 App Tests

`lib/preview/app-tests/run.ts::postAppTestClaims` calls the namespace store's `claimCases` inside the step's
transaction with the ids it computes today, then re-reads the session's device with
`readDeviceCaseDatabase`; on Android it re-reads also when nothing was created. `AppTestSessionState.
claimedCaseIds` is removed from `lib/preview/app-tests/types.ts`; `context.ts` builds `restoreScope` from
owner ids alone; `service.ts` stops seeding `claimedCaseIds: []`. Two sessions of one persona in one journey
share that persona's claim rows, as two devices of one worker share HQ's; each sees them at its next device
read.

`lib/preview/app-tests/retainedState.ts` keeps reading a stored optional `claimedCaseIds` and drops it.
No stored session is rewritten: a session retained at runtime version 17 can only be finished or read,
because `lib/db/appTests.ts` refuses a step of an older runtime with "Nova's test runtime changed. Start a
new test." (pull request 3 sets 18), and finishing reads no claims.

### 10.9 What goes

`lib/session/previewClaims.ts`; the store's `previewClaims` and `addPreviewClaims`;
`lib/session/hooks.tsx::usePreviewClaimedCaseIds` and `useAddPreviewClaims`; `installEntryPointLaunch`'s
claim argument; the `claimedCaseIds` argument of every Server Action (`loadCasesAction`,
`loadSearchResultsSnapshotAction`, `loadCaseDataAction`, `loadCaseDatabaseSnapshotAction`,
`launchEntryPointAction`, `loadEntryPointOtherCasesAction`) and of `resolveAuthorizedPreviewContext`;
`previewClaimedCaseIds`; `PREVIEW_CLAIMS_LIMIT`; `RestoreScope.claimedCaseIds` and
`RestoreScopeArgs.claimedCaseIds`; the claim seed in `compileRestoreScope.ts` (its seed is the owned open
rows again, `is_open` the literal `true`); and the fourth input of `lib/preview/hooks/useRestoreScopeKey.ts`
(the case data revision covers claims).

---

## 11. Preview

### 11.1 The rule table

`lib/preview/platform.ts::PreviewPlatformRules`:

```ts
/** Whether the case list's Search action launches on its own: search first
 *  and skip to results. Core's cli `EntityScreen.evaluateAutoLaunch`, which
 *  Formplayer runs; commcare-android holds no reader of `auto_launch`, so it
 *  opens the worker's list first, with the Search action. */
readonly searchActionAutoLaunch: boolean;
/** Where choosing a case from a case list menu entry lands. Web Apps: G1's
 *  outcome (§18); Android: `HomeScreenBaseActivity.java::handleNoFormFromSessionNav`
 *  → `terminateSession`. */
readonly caseListMenuItemSelection: "back-to-root-menu" | "step-back" | "empty-list" | "device-home";
/** The button on a case list menu entry's case detail. Android shows Done in
 *  view mode (`EntityDetailActivity.java`, `select.detail.bypass`), whose
 *  result leaves the list showing; Web Apps shows Continue. */
readonly caseListMenuItemDetail: "continue" | "done";
```

`skipToResults` and `formlessCaseListSelection` are removed. Web Apps: `searchActionAutoLaunch: true`,
`caseListMenuItemSelection` per G1 (A `"back-to-root-menu"`, B `"step-back"`, C `"empty-list"`),
`caseListMenuItemDetail: "continue"`. Android: `false`, `"device-home"`, `"done"`. The union of
`caseListMenuItemSelection` holds only the Web Apps value G1 gives and `"device-home"`; the other two
values are not written.

### 11.2 `caseListStep`

`lib/preview/caseListPhase.ts`:

```ts
export function caseListStep(args: {
	/** The module's workflow; undefined where it has no effective ordinary search. */
	readonly workflow: SearchWorkflow | undefined;
	readonly formsReadSearch: boolean;
	/** The Search button's display condition holds (or there is none). */
	readonly searchRelevant: boolean;
	readonly hasSubmitted: boolean;
	readonly submittedFoundNothing?: boolean;
	readonly rules: Pick<PreviewPlatformRules, "zeroSearchResults" | "searchActionAutoLaunch">;
}): CaseListStep;
```

In order:

1. Android keeps the Search screen after a submitted search found nothing (`zeroSearchResults`), as today.
2. No effective search: `browse`.
3. Forms read the search (an app that holds it declares Web Apps only): `skipToResults` is `results` from
   the start; `searchFirst` is `search` until a search is submitted, then `results`. A search first with no
   visible field is `search` with only its Search button (G4 decides, §18).
4. `rules.searchActionAutoLaunch`, the Search action relevant, and a workflow other than `listFirst`:
   `skipToResults` is `results` (the default search runs as the menu opens, and Search again opens the
   Search screen); `searchFirst` is `search`, then `results`.
5. Otherwise `browse`: list first, search first and skip to results on Android, and a false Search button
   condition on Web Apps.

`automaticallyLaunchesSearch` is removed; `lib/preview/engine/searchEvaluation.ts` reads `caseListStep`
(the default search runs where the step is `results` with nothing submitted). The `results` of a menu whose
forms do not read the search is the Search action's Results at `main` (the search population,
`heldOnDevice`, the claim at the chosen result, Search again). `lib/preview/app-tests/run.ts` and
`components/preview/screens/CaseListScreen.tsx` pass the new arguments from `moduleSearchWorkflow`,
`moduleFormsReadSearch` and the evaluated Search button condition.

### 11.3 The case list menu item

`lib/preview/formlessCaseListRoute.ts` is renamed `caseListMenuItemRoute.ts`:

```ts
export type CaseListMenuItemRoute =
	/** The app's first menu, with Web Apps' sync notice (G1 outcome A). */
	| { readonly kind: "root-menu"; readonly notice: "caseListMenuItemReturned" }
	/** The screen before the choice, as Back would show it (G1 outcome B). */
	| { readonly kind: "step-back" }
	/** The case list with no rows (G1 outcome C). */
	| { readonly kind: "empty-list" }
	/** The phone's home screen. */
	| { readonly kind: "device-home" };
export function caseListMenuItemSelection(
	rules: Pick<PreviewPlatformRules, "caseListMenuItemSelection">,
): CaseListMenuItemRoute;
```

Only the arm G1's outcome writes and `device-home` are in the union.

- **The menu.** `lib/preview/menuProjection.ts` lists a module's case list entry after its forms: its label
  is the item's label unit when set, else the module's name, with the item's icon. A bare case list keeps
  its landing (the menu is its list). In a forms-first menu the entry opens the case list; in a case-first
  menu (`moduleIsCaseFirst`) the case is chosen first, as Core asks a datum every entry shares before the
  command (§2.4), and the menu then lists the forms and the entry.
- **The selection.** `CaseListScreen` opened from the entry (`openedFrom: "case-list-menu-item"`) routes a
  chosen case by `caseListMenuItemSelection` instead of opening a form. In a case-first menu, choosing the
  entry with the case already chosen is the selection. `step-back` pops the last screen of the running
  history (the list with nothing chosen in a forms-first menu; the menu in a case-first one); `empty-list`
  keeps the list screen with no rows and its breadcrumb; `root-menu` goes home with a success toast of the
  runtime message `caseListMenuItemReturned` (`formlessReturned` renamed, same strings); `device-home` goes
  home and sets `previewAtDeviceHome`.
- **The detail.** With Details columns, a chosen row shows its detail first, as at `main`. On Android the
  detail's button is the runtime message `detailDone` (new: `"Done"`, `"Listo"`), which returns to the list
  with nothing chosen; on Web Apps it is `continue` and then the route. Without Details columns a chosen row
  takes the route at once.
- **App Tests.** `lib/preview/app-tests/navigation.ts` routes the same choice by
  `caseListMenuItemSelection(context.rules)` and, on Android with Details, answers the detail's `Done`
  action by returning to the list; the menu screen lists the entry as the projection does.

`components/builder/CLAUDE.md`'s sentence from step 4 ("A module with no forms plays the runtime: ...")
becomes "A case list menu entry plays the runtime, formless or beside forms: choosing a case <G1's landing
on Web Apps>, and on Android returns to the phone's home screen, or, where the case shows its details, Done
returns to the list." with G1's landing words (A: "returns to the app's first screen with its sync notice";
B: "returns to the screen before it"; C: "leaves an empty list").

### 11.4 Cells

`lib/preview/__tests__/platformCells.ts` from pull request 10:

| Cell | Row |
|---|---|
| the six `...@android` rows of `search-first` at `main` | `structural("forms-read-search")` |
| `case-search/inline-search-true-auto-launch-true-on-a-module-without-visible@android` (new) | `structural("forms-read-search")` |
| `case-search/inline-search-default-search-on-a-module-with-visible-inputs@android` (new) | `structural("forms-read-search")` |
| `case-search/workflow-search-first-auto-launch-true-default-search-false@android` (new) | `model("search-first-android")` |
| `case-search/workflow-skip-to-default-results-auto-launch-true-default-search@android` | `model("skip-to-results-android")`, its check rewritten |
| `case-search/list-first-where-web-apps-is-declared@web-apps` (new) | `structural("list-first")` |
| `case-search/the-generated-search-round-trip-remote-request-query-results@android` | `model("search-android")`, its check passing the new arguments |
| `menus-and-case-lists/module-case-list-on-a-formless-basic-module-show-true@web-apps` | `model("case-list-menu-item-web-apps")`, its check per G1 |
| `menus-and-case-lists/module-case-list-show-true-on-a-basic-module-with-forms@web-apps` (new, under G1 A, B or C) | `model("case-list-menu-item-web-apps")`; under G1's refusable outcome, `structural("case-list-entry-beside-forms")` |

`lib/preview/__tests__/platformCellModels.ts`:

- `"search-first-android"` (new): over a module with a visible input and the workflow absent, `caseListStep`
  is `browse` with `ANDROID` and `search` with `WEB_APPS`, nothing submitted.
- `"skip-to-results-android"`: over `workflow: "skipToResults"`, `caseListStep` is `browse` with `ANDROID`
  and `results` with `WEB_APPS`.
- `"search-android"`: `caseListStep` with `workflow: "searchFirst"`, a submitted search that found nothing,
  is `search` with `ANDROID` and not with `WEB_APPS`; `ANDROID.claimThenSync` is true.
- `"case-list-menu-item-web-apps"`: `caseListMenuItemSelection(WEB_APPS)` is G1's arm and
  `caseListMenuItemSelection(ANDROID)` is `{ kind: "device-home" }`.

The advanced entry's cell (`module-case-list-show-true-on-an-advancedmodule@web-apps`) is part 02's, with
the same model check, and joins the table in this pull request with the entry's flip.

---

## 12. Authoring in this pull request, and what part 07 builds

Pull request 10 carries every authoring change over these concepts: what no longer exists leaves every
surface, a renamed input lands in its final shape, and part 07's new surfaces for the workflow, the case
list in the menu and the registration from the case list land beside them (part 07 §5's table, row 10).
Part 07 writes the words of every control and tool description (part 07 §3.8 to §3.10, §4.2); this part
fixes the stored shapes they commit and the planners they call. Pull requests 12 and 13 add no surface
here; pull request 13's billed schema check covers §12.2's schemas (G5).

### 12.1 The builder in pull request 10

- `case-list-config/inspector/SearchPanelInspectorBody.tsx`: part 07's
  `case-list-config/inspector/SearchWorkflowSetting.tsx` (new, with its pure model
  `searchWorkflowModel.ts`) replaces the **Search first** `ToggleRow` (part 07 §3.8): a fieldset under the
  legend **When this menu opens** with the three choices **Search first** (`workflow: null`), **Results
  first** (`workflow: "skipToResults"`) and **Case list first** (`workflow: "listFirst", formsReadSearch:
  null`), and the switch **Forms read the search** under the first two only, which commits
  `formsReadSearch` through `formsReadSearchOnMutations` and its clear (§7.3). **Case list first** is
  disabled with `platformPickerLine(platformRefusal("list-first", declared))` where Web Apps is declared,
  and the switch with the `forms-read-search` picker line where Android is declared, or with the gate's
  sentence (`offeredChoiceRefusal`) when the gate refuses it for another reason. Under **Search first** and
  **Results first** the `search-first` and `skip-to-results` Android notes show where Android is declared.
  `data-search-first` on the Search canvas header becomes `data-search-workflow` (its value the workflow),
  and the switch's wrapper carries `data-forms-read-search`.
- `case-list-config/canvas/SearchCanvas.tsx`: part 07's canvas sentences for search first with no visible
  field, for results first with none, and for a saved Search button condition (part 07 §3.8; G4's outcome
  B rewords the first).
- `canvas/NoMatchesFormSetting.tsx` becomes `CaseListRegistrationSetting.tsx`, `noMatchesFormReview.tsx`
  becomes `caseListRegistrationReview.tsx` (its hook `useCaseListRegistration`), and with
  `detail/formSettings/FormEntrySection.tsx` and `NoMatchesAfterSubmitSection.tsx` they drive §9.4's
  planners, in both of today's editing places (part 07 §3.9); `FormCard.tsx` reads
  `caseListRegistrationFormOf` for its badge, and `data-no-matches-form` becomes
  `data-case-list-registration`.
- `detail/moduleSettings/CaseListMenuItemSection.tsx` (new, part 07 §3.10) replaces the **Case list link**
  block of `ModuleAppearanceSection.tsx` and mounts in `ModuleSettingsPanel.tsx` for a module with a case
  type: the heading **Case list in the menu**, the switch **Show the case list in this menu** (disabled
  while on for a menu with no forms and no submenus, with part 07's reason), the label with the module's
  name as placeholder, the icon and spoken label slots, and the `case-list-menu-item` note row. The switch
  and the slots commit `setCaseListMenuItem` (`item: {}` on, `null` off, the whole item with its slots
  when one changes); `ModuleCaseTypeSection.tsx` reads the item.
- `appTree/insertion/AddModulePopover.tsx` and `ModuleCard.tsx` birth and read the item;
  `components/preview/screens/HomeScreen.tsx`, `ModuleScreen.tsx`, `CaseListScreen.tsx`, `FormScreen.tsx`,
  `EntryPointPreviewLaunch.tsx` take §10 and §11.
- `components/builder/PreviewIdentityMenu.tsx`: **Release claimed cases** (§10.7).
- `CaseListConfigWorkspace.tsx` appends `workflowAfterInputChangeMutations` (§7.2).

### 12.2 The tools in pull request 10

Each description is part 07 §4.2's, word for word; the shapes are these.

| Tool | At `main` | From pull request 10 |
|---|---|---|
| `setCaseSearchAdvanced` (`case-search-config/shared.ts::setCaseSearchAdvancedBodySchema`) | `searchFirst: true \| null`, required | `searchWorkflow: z.enum(["listFirst", "searchFirst", "skipToResults"])`, required and not nullable like every slot of this wholesale tool, where `searchFirst` writes `workflow: null` and `listFirst` writes `formsReadSearch: null` with it; `formsReadSearch: z.literal(true).nullable()`; `ADVANCED_SLOT_NAMES` becomes `["excludedOwnerIds", "searchWorkflow", "formsReadSearch"]` |
| `configureCaseList` (`lib/agent/tools/case-list-config/configureCaseList.ts`) | `searchFirst: true \| null`, optional | `searchWorkflow: <the same enum>.optional()` and `formsReadSearch: z.literal(true).nullable().optional()`; omission keeps each |
| `createModule` | `case_list_only: boolean \| null` | `case_list_menu_item: caseListMenuItemInputSchema.optional()`, where `caseListMenuItemInputSchema` is `z.strictObject({ label: z.string().min(1).nullable().optional() })` (null or omitted is the module's name). The refusal without a case type keeps today's words with the new name. |
| `updateModule` | no case list key | `case_list_menu_item: caseListMenuItemInputSchema.nullable().optional()`; `null` removes the item, which a menu with no forms refuses; execution commits `setCaseListMenuItem` |
| `createForm`, `updateForm` (`tools/shared/formEntry.ts` becomes `tools/shared/caseListRegistration.ts`) | `entry: { kind: "search-no-matches", label? } \| null` | `case_list_registration: caseListRegistrationInputSchema` (`z.strictObject({ label: z.string().min(1).nullable().optional() })`), `.optional()` on `createForm` and `.nullable().optional()` on `updateForm`; turning it on turns Forms read the search on, and `null` makes the form a menu form again, turns Forms read the search off and removes Search-based starting values, through §9.4's planners |
| `getModule` (output only) | per form `entry` | module `searchWorkflow` (`"listFirst" \| "searchFirst" \| "skipToResults" \| null`), `formsReadSearch` (boolean), `caseListMenuItem` (`{ label } \| null`), `caseListRegistrationForm` (`{ formUuid, label } \| null`) replace `caseListOnly` and `searchFirst`; per form `opensFromCaseList` (boolean) replaces `entry` (part 07 §4.3) |

`createForm`'s and `updateForm`'s `post_submit` descriptions read "it opens on Search" as "its forms read
the search". `lib/agent/summarizeBlueprint.ts` (part 07 §4.3's snapshot lines: `[case list in menu]`, the
menu's `case list registration:` line, `workflow=<...>` then `forms read it`), `blueprintHelpers.ts`,
`authoring/evaluationContext.ts`, `authoring/reference.ts` (which lists the workflow values),
`scripts/inspect-app.ts` and `scripts/lib/blueprint-stats.ts` read the renamed concepts. The guide's
search sentences name the workflow values (part 07 §4.5, pull request 10). MCP serves the same tools;
`lib/mcp/__tests__/servedSchemas.test.ts` moves with them.

`MODEL_CONTEXT_VERSION` becomes `"v6-hq-round-trip-case-writes.10"` (the served schemas above, the guide's
search sentences and the guide's generated platform sentences change). The `scripts/test-schema.ts`
entries whose projected schema changes here are `setCaseSearchAdvanced`, `configureCaseList`,
`createModule`, `updateModule`, `createForm` and `updateForm`; part 07 §4.8 writes their prompts in this
pull request. No pull request but 13 runs the billed check: part 07's G-A1 asks for it once, at pull
request 13's head, over every entry the stack moved, these included (G5, §18).

### 12.3 What part 07 builds over these shapes

- **Builder**: the surfaces of §12.1 in part 07's words (part 07 §3.8 to §3.10), its offering parity
  (§3.15), and beside the case list menu item of a menu `moduleIsAdvanced` reads true, part 02's line
  (part 07 §3.7, pull request 10). Copy stays within decision 1's values.
- **Tools**: §12.2's inputs with part 07 §4.2's descriptions, and the variants its "Written and not yet
  run" gives for G1, G3 and G4 of this part.
- **nova-plugin**: the sweep for `searchFirst`, `case_list_only` and `entry: search-no-matches` claims, with
  the `plugin.json` bump (part 07 §6).

---

## 13. Proof

### 13.1 Register moves

From pull request 10 no document that declares Web Apps emits list first, so HQ's Case List save changes
nothing on any document, and every defect 21 entry (`part: "list-first turned search-first"`, `check:
"proof4"`) moves to `proof/fixed-defects.json`, each still showing on its retained control:

| Document | Control | Entries |
|---|---|---|
| `targeted-list-first-web-apps` | same | `d21-search-first-app-search-config-auto-launch`, `d21-search-first-blocks-c660`, `-blocks-d0d9`, `-blocks-fb79`, `-blocks-refusal`, `d21-search-first-suite-action-auto-launch`, `d21-search-first-trace-7431`, `-trace-a9f0`, `-trace-autolaunched`, `-trace-badges`, `-trace-casedetail`, `-trace-choices`, `-trace-chosen`, `-trace-defaultsearch`, `-trace-events`, `-trace-hidden`, `-trace-prompts`, `-trace-root`, `-trace-screen`, `-trace-script`, `-trace-stackaftersubmit`, `-trace-title`, `-trace-unreplayable-638a`, `-trace-unreplayable-ec6d`, `-trace-xmlns`, `d21-list-first-turned-search-fir-formplayer-case-list-response-type`, `d21-list-first-turned-search-fir-webapps-case-list-screens-kind` (27) |
| `targeted-list-first-places` | same | `d21-list-first-turned-search-fir-webapps-case-list-runs`, `-runs-viewport`, `-runs-viewport-removed` (3) |
| `tile-grouped-search` | same | `d21-list-first-turned-search-fir-trace-case-list-trace-datum`, `-trace-case-list-trace-step` (2) |
| `expander-form-links-emission-forwards-literal-condition-47c96355-0` | same | `d21-list-first-turned-search-fir-formplayer-case-list-submit-nextscreen-type` (1) |
| `case-list-no-details` | `case-operation-query` | `d21-list-first-turned-search-fir-trace-case-list-end-empty-menu-unreplayable` (1) |
| `case-list-match-none` | same | `d21-list-first-turned-search-fir-trace-case-list-end-no-cases-script-ended` (1) |
| `targeted-search-related-lookups` | `case-operation-query` | `d21-list-first-turned-search-fir-trace-case-list-trace` (1) |
| `targeted-sync-on-form-entry-web-apps` | `targeted-sync-on-form-entry` | `d21-list-first-turned-search-fir-trace-case-list-trace-requests` (1) |

37 moves; `proof/checks/registers.py::OPEN_DEFECTS` loses `21: 5`. The served-reader entries among them are
seen to move only by a run with the readers: part 08's run by hand at this pull request's head (G2, §18)
and the first nightly. The expander document's entry moves here under part 08's G3 outcome A; under its
outcome B (the class still shows on that document) it stays live in this pull request, `OPEN_DEFECTS` keeps
`21` until pull request 11, and pull request 11, which rewrites that document's test, moves it with
defect 26's entries (part 08 §2.5, G3). Part 08 holds the register files.

### 13.2 Manifest edits (`lib/commcare/surface/entries`)

| Entry | Edit |
|---|---|
| `case-search/workflow-search-first-auto-launch-true-default-search-false` | HELD-NEW → HELD; cell "**HELD**: `caseSearchConfig.workflow` absent (search first)"; feature `search-first` |
| `case-search/workflow-skip-to-default-results-auto-launch-true-default-search` | cell "**HELD**: `caseSearchConfig.workflow: skipToResults`, authored"; `slotChanges` `[]` |
| `case-search/workflow-legacy-classic-auto-launch-false-in-an-app-with` | stays REFUSED; its emission cell keeps the manifest's placeholder dash and replaces the parenthesis "Nova emits this for list-first modules in apps that declare Web Apps today ..." with "(the gate refuses `list-first` where Web Apps is declared)" |
| `case-search/auto-launch-false-in-an-app-with-cloudcare-enabled-false` | cell §5.1; stays ambient (C1) |
| `case-search/list-first-where-web-apps-is-declared` | new, §5.1 |
| `case-search/inline-search-true-auto-launch-true-on-a-module-with-visible` | cell "**HELD**: `formsReadSearch` with `caseSearchConfig.workflow` absent (search first)" |
| `case-search/inline-search-true-auto-launch-true-on-a-module-without-visible` | HELD-NEW → HELD; same cell; feature `forms-read-search` |
| `case-search/inline-search-default-search-on-a-module-without-visible-inputs` | cell "**HELD**: `formsReadSearch` with `caseSearchConfig.workflow: skipToResults`"; `gates` gains `toggle/CASE_SEARCH_ADVANCED` (C3) |
| `case-search/inline-search-default-search-on-a-module-with-visible-inputs` | HELD-NEW → HELD; same cell; `gates` gains `toggle/CASE_SEARCH_ADVANCED`; feature `forms-read-search` |
| `menus-and-case-lists/module-case-list-on-a-formless-basic-module-show-true` | cell "**HELD**: `Module.caseListMenuItem` on a menu with no forms"; Web Apps note per G1 |
| `menus-and-case-lists/module-case-list-show-true-on-a-basic-module-with-forms` | HELD-NEW → HELD (`Module.caseListMenuItem` beside forms); readings per G1 |
| `menus-and-case-lists/module-case-list-label-lang` | cell "**HELD**: `caseListMenuItem.label`, the module's name when absent"; `slotChanges` `[]` (the research's `Module.caseListLabel` widen lands inside the item) |
| `menus-and-case-lists/module-case-list-media-image-media-audio` | cell "**HELD**: `caseListMenuItem.icon`, `audioLabel`" |
| `menus-and-case-lists/case-list-form-on-a-search-first-host-pointing-at-a-registration` | cell "**HELD**: `Module.caseListRegistrationForm { kind: "after-empty-search" }` on a host whose forms read the search" |
| `menus-and-case-lists/inline-search-in-a-parent-select-module-hq-adds-xpath-query` | cell "**HELD**: derived by HQ from `formsReadSearch` and a parent selection" |
| `menus-and-case-lists/case-list-form-post-form-workflow-default-case-list` | cell's "the no-matches form" reads "the case list registration form" |
| `menus-and-case-lists/module-case-list-show-true-on-an-advancedmodule` | HELD-NEW → HELD in this pull request (part 02's row), with G1's Web Apps reading, emitted by `targeted-commtrack-advanced` |

Each edit changes its row in `docs/research/2026-09-26-hq-round-trip/inventory/case-search.md` and
`menus-and-case-lists.md` in the same pull request (`lib/commcare/surface/__tests__/manifest.test.ts` holds
the JSON to the inventory). No value-class reader changes: `proof/checks/manifest_value_classes.py::
list_first_with_web_apps` keeps reading, and from pull request 10 finds the class on no document.

### 13.3 Targeted documents

Part 08 owns the list (decisions 15) and holds these four, by these names, with the content this part
needs; each lands in pull request 10:

| Document | Declared | What this part needs in it |
|---|---|---|
| `targeted-search-workflow` | both | one case type, three searching menus with no forms reading the search: search first with a visible field and a Search button condition, search first with only a hidden field, skip to results with a visible field. G3 and G4 read it; `workflow-search-first-auto-launch-true-default-search-false` flips on it |
| `targeted-search-workflow-inline` | Web Apps | search first with forms reading the search and only a hidden field; skip to results with forms reading the search and a visible field, and its case list registration form with a label. The two inline HELD-NEW entries flip on it; G3 and G4 read it |
| `targeted-search-workflow-android` | Android | `workflow: "listFirst"` on a module with a visible field. G3 (no selector, list first kept) and a device read it |
| `targeted-case-list-menu-item` | both | a forms-first menu (a registration and a follow-up form) with a labelled case list entry, an image and Details columns; a case-first menu (a follow-up and a close form) with its entry and no Details columns. G1 reads it |

Two more documents of part 08's list read this part's concepts. `targeted-commtrack-advanced` (part 02's,
pull request 10): an advanced module, made advanced by a carried create, with its case list menu item
beside its forms and no filter, on which `module-case-list-show-true-on-an-advancedmodule` flips with G1's
reading and part 03's CommTrack menu item reason gets its lane witness. `targeted-migration-search-workflow`
(part 08 §5.2, its pre-step spec from pull request 1, migrated from pull request 10): a list-first search
with a visible field, a `searchFirst` search with one, today's derived skip to results, a `searchFirst`
host of a no-matches registration form and a `caseListOnly` module, the witness of M1 to M5 (§14) and part
09's pre-step fixture of the same name. Part 08's `proof/views/test_search_workflow_offers.py` (pull request
10) reads HQ's Case List page for `targeted-search-workflow` (the selector offers search first and skip to
default results and shows the stored value) and for `targeted-search-workflow-android` (no selector).

`targeted-list-first-web-apps` and `targeted-list-first-places` keep their ids, stored records and
controls; their source comment says the document is the witness that a searching menu of an app with Web
Apps now opens on Search first, which the Case List save keeps (rows `["21"]`).
`targeted-sync-on-form-entry-web-apps`' comment loses "it carries defect 21's `requests` class".
`proof/targeted/documents/inlineSearchReads.ts` and `noMatchesReturnIdentity.ts` write `formsReadSearch`
and `caseListRegistrationForm`; their emitted bytes are unchanged.

### 13.4 Corpus sources and the fuzz mapping

Every corpus source adopts §14's M1 to M5 in the module that builds it (part 08's rule): a module with
today's `searchFirst` writes `formsReadSearch` (and `workflow: "skipToResults"` with no visible field); a
module whose emission derives skip to results writes `workflow: "skipToResults"`; a list-first module in a
document that declares Web Apps writes nothing (absent is search first) unless it has no visible field,
where it writes `skipToResults`; `caseListOnly` becomes the item; `Form.entry` becomes the module's slot.
So every source's bytes are unchanged except the list-first menus of documents that declare Web Apps.

The fuzz generators keep their draws (`proof/CLAUDE.md`, "An existing fuzz sample keeps its draws"): each
`lowerToDoc` (`lib/commcare/__tests__/xformDocArbitrary.ts`, `suiteDocArbitrary.ts`) maps a drawn
`searchFirst` boolean and the drawn inputs and filter through `lib/doc/searchWorkflowPlan.ts::
authoredSearchWorkflow` (§14) before `lib/doc/platformDeclaration.ts::declaredForContent`, with
`declaresWebApps: true` (a draw declares nothing, which is both). `proof/corpus/footprint.ts`'s comment
naming `searchWireShape`'s count of visible inputs reads "the workflow".

### 13.5 Walk stops

`tile-grouped-search` (webapps and preview `case-not-listed`) and `prompt-widgets` (formplayer
`search-refused`) move from list first to search first; G2 (§18) decides whether each keeps its cause.
`fuzz-suite-20260930-8` (formplayer `search-refused`, inline) moves no byte. Each new stop G2 shows is added
to `proof/walk-stops.json` with its reason in pull request 10.

### 13.6 Native and reader tests

No native family changes: the inline and remote-request wires exist and their native tests keep their
documents' bytes. No reader test changes beyond the G1 documents' walks (part 08's `proof/formplayer`,
`proof/webapps` and `proof/android` walks read `targeted-case-list-menu-item` and
`targeted-commtrack-advanced` as any targeted document); the one new lane test is part 08's
`proof/views/test_search_workflow_offers.py` over HQ's Case List page (§13.3).

### 13.7 `harness-findings.md`, "Found while planning step 5"

This part's lines: C1 (the ambient list-first entry), C2 (the case list menu item readings, with G1's
outcome), C3 (the two inline gates), C4 (Search first is unavailable on Android only inline), C5 (Preview's
Android detail of a case list menu entry), N1 (dead case list link media). Part 08 writes the section.

---

## 14. Migration classes for the cutover

Part 09 applies these in its transform (its structure step `renamed-concepts`, part 09 §7.1, and its
semantics step `search-workflow`, part 09 §7.8); this part fixes what each maps to. Identification uses `visibleSearchInputs` and `effectiveFilterForEmission`,
the predicates `main`'s `searchWireShape` reads, so each class maps to the wire it had.

The one pure planner, kept in `lib/doc` past pull request 16 for the fuzz mapping as step 4 kept
`platformDeclaration.ts`, and named the same in part 08's mapping and part 09's transform:

```ts
// lib/doc/searchWorkflowPlan.ts
export interface StoredSearchFacts {
	/** `caseSearchConfig.searchFirst === true` in the stored shape. */
	readonly searchFirst: boolean;
	readonly hasVisibleInput: boolean;
	readonly hasEffectiveFilter: boolean;
	/** `declaredPlatforms` includes Web Apps (absent `runsOnlyOn` is both). */
	readonly declaresWebApps: boolean;
}
export interface AuthoredSearchWorkflow {
	readonly workflow?: "listFirst" | "skipToResults";
	readonly formsReadSearch?: true;
	/** The menu moved off list first in Web Apps: the notice's line. */
	readonly webAppsOpensOn?: "search" | "results";
}
export function authoredSearchWorkflow(facts: StoredSearchFacts): AuthoredSearchWorkflow;
```

**M1. The search workflow** (each module with an effective ordinary search; owner-only configs are
untouched):

| `searchFirst` | visible field | effective filter | Web Apps declared | Stored from step 5 | Wire | Notice |
|---|---|---|---|---|---|---|
| true | yes | any | any | `formsReadSearch: true` | unchanged | none |
| true | no | any | any | `workflow: "skipToResults"`, `formsReadSearch: true` | unchanged | none |
| false | no | yes | any | `workflow: "skipToResults"` | unchanged | none |
| false | yes | any | no | `workflow: "listFirst"` | unchanged | none |
| false | no | no | no | `workflow: "listFirst"` | unchanged | none |
| false | yes | any | yes | nothing (absent is search first) | `auto_launch` true | `menu-opens-on-search`, `webAppsOpensOn: "search"` |
| false | no | no | yes | `workflow: "skipToResults"` | `auto_launch`, `default_search` true | `menu-opens-on-search`, `webAppsOpensOn: "results"` |

The last row departs from the research, which moves every list-first menu of an app with Web Apps to
search first: a menu with no visible field would open on a Search screen holding only its Search button,
one press from the results skip to results shows at once, and §7.2's planner gives a new menu of that shape
skip to results; HQ's editor keeps both (§2.1). The notice reason is decisions 13's `menu-opens-on-search`
with `detail.opensOn` (`"search" | "results"`), whose two sentences part 09 renders:

- `search`: "{Module} now opens on its Search screen in Web Apps, and workers see the case list after they
  search. CommCare HQ no longer offers the case list first for a menu that searches in Web Apps. On Android
  it still opens on the case list."
- `results`: "{Module} now opens on the cases its search finds in Web Apps, and workers can search again
  from there. CommCare HQ no longer offers the case list first for a menu that searches in Web Apps. On
  Android it still opens on the case list."

What production holds, from the planning scan (read-only, counts only, none of them in the repo): modules
of the first row exist (a stored `searchFirst` with a visible field, in apps that declare Web Apps
only); list-first searching modules exist in apps that declare Android only, which keep list first as
`workflow: "listFirst"`; and list-first searching modules exist in apps that declare both platforms and in
apps that declare Web Apps only, so `menu-opens-on-search` meets apps at the window. The derived skip to
results of the third row exists only in soft-deleted apps, which the cutover migrates as it migrates every
app.

The scan did not count the last row (a list-first menu with no visible field and no effective filter in an
app that declares Web Apps), so both of its outcomes stand, and the cutover's advisory dry run decides
between them before the window: where it finds none, the row and its sentence still ship (the fuzz mapping,
new documents and part 09's pre-step fixture `pre-step-search-results` reach the planner) and no app gets
the `results` line; where it finds some, each such module gets it. Either way no app needs a manual step.

**M2.** `caseListOnly: true` → `caseListMenuItem: { icon?, audioLabel? }`, carrying
`caseListConfig.icon` / `.audioLabel` into the item and deleting them from `caseListConfig`. Wire unchanged
(no label: the module name's unit). No notice. Production holds such modules.

**M3.** `caseListOnly: false` → the key deleted. No change. Production holds a stored `caseListOnly: false`.

**M4.** `caseListConfig.icon` / `.audioLabel` on a module without `caseListOnly` (N1) → deleted. No wire
change (never emitted). The report names each module and asset; no notice; the media reverse index follows
through the ordinary mutation path.

Production holds no such module today (the planning scan). An author can still make one before the
window (N1's path is open at `main`), so the dry run counts it and M4's transform ships: each module it
finds is a report line, and an asset referenced only there loses its last reference, which the media
deletion guard then admits for deletion like any unreferenced asset. Where it finds none, M4 changes
nothing in production.

**M5.** A form with `entry: { kind: "search-no-matches", label? }` → its module's `caseListRegistrationForm:
{ kind: "after-empty-search", formUuid, label? }`, `entry` deleted. Each target language's overlay entry of
unit `form:<formUuid>:entry-label` moves to the module's `case-list-registration-label` unit with value,
provenance, review state and source fingerprint unchanged (the source text is unchanged). Wire unchanged.
No notice. Blocker `renamed-concept-conflict` (part 09): a module holding two `search-no-matches` forms,
which `SEARCH_NO_MATCHES_DUPLICATE` refuses at every commit at `main`.

Production holds no-matches forms, so M5 meets apps at the window, and no module holding two of them (the
planning scan); since the gate refuses that shape at every commit, no author can make one before the
window, and the blocker is a guard no app meets. The scan did not count overlay entries of role
`form-entry-label`, so both outcomes stand and the advisory dry run decides between them: where it finds
none, M5's overlay move is a no-op; where it finds some, each moves as written and the postcondition counts
them equal before and after.

**M6.** Case store, every app: the `commcare-case-claim` schema row, which the fleet transaction does not
write (part 09's departure from this part's brief, adopted). The cutover's judge counts the missing row as
the planned difference `claim-type-row` (part 09 §12), and the existing drift writer creates it in every
app after the deploy and before ingress reopens (part 09's runbook), through
`scripts/lib/schemaDrift.ts::computeSchemaDrift`, whose loop this part leaves as it is (it skips only the
worker's-record row). The row has no properties, so the writer has nothing to add after it. Every catalog
read in the cutover's checks names its schema and table (`public.case_type_schemas`), never a column or
constraint name alone (part 09's `catalog.ts`).

**No M7.** Retained App Test sessions holding `claimedCaseIds` are not rewritten (a departure from this
part's brief): a session retained at runtime version 17 can only be finished or read (§10.8), and
`retainedState.ts` drops the stored key. Production holds such sessions (the planning scan found retained
sessions past their expiry holding claimed case ids); each is read through `retainedState.ts` as written.

The cutover's transform runs over the raw old shape (decisions 12), so part 09 reads `searchFirst`,
`caseListOnly`, `caseListConfig.icon`/`audioLabel` and `entry` from raw JSON and writes the head shape;
`authoredSearchWorkflow` takes plain facts so the raw reader and the fuzz mapping share it.

---

## 15. Contracts and docs sentences

Subtree `CLAUDE.md` sentences land in pull request 10 (each is injected into sessions working there);
architecture references and public docs land in pull request 15 with part 10.

**Pull request 10:**

- `lib/domain/CLAUDE.md`: "`searchFirst: true` on the ordinary arm (`moduleOpensOnSearch`) opens the module
  on its Search screen with no browse list; the validator admits it only on a case-first or forms-free case
  list, and it is the one module fact `defaultPostSubmit` reads." → "`caseSearchConfig.workflow` is what a
  worker sees first: absent is search first, `skipToResults` shows the search's matches as the menu opens,
  `listFirst` the case list, admitted only where Web Apps is not declared (`list-first`); `searchWorkflow` is
  its one reader. `formsReadSearch: true` runs the search as each case form opens, so the module's forms read
  what was searched for and found (`moduleFormsReadSearch`, CommCare's inline search); the validator admits it
  only on a case-first module or a bare case list, never beside list first, and it is the one module fact
  `defaultPostSubmit` reads."
- `lib/domain/CLAUDE.md`: "A form's optional `entry` ... (`isNoMatchesForm`), on no menu at all." → "A
  module's `caseListRegistrationForm` (`{ kind: "after-empty-search", formUuid, label? }`) names a
  registration form of the module offered on Results only after a search found nothing, on no menu at all
  (`caseListRegistrationFormOf`). A module's `caseListMenuItem` lists its case list as a menu entry after its
  forms; `moduleHasCaseListMenuItem` reads the entry, `moduleIsBareCaseList` a menu that is only its list."
  The `menuForms.ts` sentence takes `caseListRegistrationFormOf`; the translation-role list takes
  `case-list-registration-label` and `case-list-menu-item-label`; the `postSubmit.ts` sentence's "Search
  first" reads "forms that read the search".
- `lib/commcare/CLAUDE.md`: "`defaultPostSubmit` takes the menu facts `searchFirst`, ..." → "`formsReadSearch`,
  ..."; "`previous` in a menu that opens on Search" → "`previous` in a menu whose forms read the search"; "A
  form-less `caseListOnly` root therefore admits only same-case-type children" → "A bare case list root (a
  case list menu entry and no forms) therefore admits only same-case-type children"; "Case-list-only child
  entries use the same projection." → "Case list menu entries use the same projection."; the search shape
  paragraph → "`searchWireShape` is the authored workflow's spelling: `auto_launch` unless list first,
  `default_search` for skip to results, `inline_search` for forms that read the search"; the compatibility
  paragraph's "a search-first menu" → "a menu whose forms read the search".
- `lib/case-store/CLAUDE.md`: "**A claim seeds it too.** ... The store writes no claim row.
  `sql/__tests__/restoreScopeClaims.postgres.test.ts` holds the rule over HQ's graphs with a claim added." →
  "**A claim is a row.** A search's claim is a `commcare-case-claim` case the store holds
  (`CaseStore.claimCases`): open, owned by the worker, with a `host` extension index to the chosen case, so
  the fixpoint's ordinary rules make it and its host live. `releaseClaims` closes a worker's claims, and a
  sample-data replace deletes the claims of the hosts it deletes. `sql/__tests__/restoreScopeClaims.postgres.test.ts`
  holds it over HQ's graphs with a real claim row." The `readDeviceCaseDatabase` sentence "Its only
  caller-supplied ids are the worker's claims ..." is removed.
- `lib/preview/CLAUDE.md`: "Preview writes no claim row." and the claims paragraph of "Resolved preview
  identity" → "A claim is a case row (`claimSearchedCasesAction`), posted where CommCare posts it: at the
  chosen result, or as a case form opens in a menu whose forms read the search, or by a Web Apps entry
  point's launch. A reload keeps it; **Release claimed cases** in the identity menu closes the running
  worker's claims." The search-first composition paragraph reads §11.2, and the case list menu item paragraph
  reads §11.3.
- `lib/session/CLAUDE.md`: the `previewClaims` paragraph and the "keeps the claims" sentences (platform
  change, Home) are removed.
- `lib/preview/app-tests/CLAUDE.md`: "A claim appends to the session's `AppTestSessionState.claimedCaseIds`"
  → "A claim writes a claim row in the journey's namespace"; "A form of a search-first module that reads
  what the search found" → "A form of a menu whose forms read the search that reads what it found".
- `components/builder/CLAUDE.md`: "A case-list module is born as a VIEWER, a `caseListOnly` module ..." →
  "born with a case list menu entry and no form"; "adding a form later flips the viewer to form-bearing" →
  "adding a form keeps its case list entry beside the form"; the formless Preview sentence → §11.3's.
  Where part 07 §7.1's row names the same sentence (the viewer scaffold), part 07's text is the
  replacement and this part's second clause is appended to it (part 10 §7.10).

**Pull request 15 (part 10 writes them):**

- `docs/architecture/complex-apps.md`: "#### Search first" becomes "#### The search workflow" (§4.1's
  table; list first only where Web Apps is not declared; search first and skip to results ignored on
  Android; forms reading the search is HQ's inline shape, unavailable on Android); "#### Register when
  nothing matches": `Form.entry` → `Module.caseListRegistrationForm`; "Search first is itself unavailable on
  Android" → "Forms reading the search is itself unavailable on Android"; the reserved types paragraph adds
  that Preview writes `commcare-case-claim` rows.
- `content/docs/case-workspace.mdx`: "### Search first" → "### When this menu opens" (**Search first**,
  **Results first** and **Case list first**, the Android sentence, **Forms read the search**, in part 07
  §3.8's words); "### Register when nothing matches": the `entry` sentence → `case_list_registration` on
  the form, and "Search first" → **Forms read the search** where the section names the setting; a new
  "### The case list in the menu" (**Show the case list in this menu**, with G1's outcome sentence). Part
  10 §8 holds the texts.
- `content/docs/where-workers-use-your-app.mdx`: the bullet "**Search first**, a menu that opens on its
  Search screen, and the registration form ..." → "**Forms read the search**, ..."; a new bullet under
  what runs on Android and not in Web Apps: "**Case list first**, for a menu that searches. In Web Apps a
  menu that searches opens on its Search screen or on its results."; the differences paragraph gains "A
  menu set to **Search first** or **Results first** opens on its case list on Android."
- `content/docs/building-with-nova.mdx`: after "keeps the cases the worker claimed", "Claims last until you
  release them from the Running as menu, as they do on a real device until someone closes them."
- `content/docs/mcp/tools.mdx`: the rows of the tools in §12.2 and §12.3.
- `docs/architecture/contracts.md`: no sentence names these concepts at `main` (only "Endpoint, search,
  claim, and known-case hydration URLs").


---

## 16. Tests

Each test names the failure it catches at the smallest boundary that shows it (`docs/testing.md`). None is
a React state test; the builder's controls are held by their batches against the gate and by Playwright.

### 16.1 Pure (no Postgres)

| File | What it proves, and the failure it catches |
|---|---|
| `lib/commcare/suite/case-search/__tests__/searchWireShape.test.ts` (rewritten) | Each row of §4.1's table from a config holding exactly those slots, and the `listFirst` plus `formsReadSearch` config refused by `ordinaryCaseSearchConfigSchema`. Pure: the mapping is the contract. Catches a flag derived from inputs or the filter again, and the INERT shape becoming representable. |
| `lib/domain/__tests__/modules.test.ts` (extend) | `searchWorkflow` reads absent as `searchFirst`; `moduleSearchWorkflow` is undefined for an owner-only config and for no search; `moduleFormsReadSearch`; `caseSearchConfigHasAuthoredSettings` true for each new key; `caseSearchConfigAfterFinalInputRemoval` keeps both; `moduleIsBareCaseList` false for the item beside a menu form and true beside only a case list registration form. Catches a reader that treats absence as list first, and a bare-list reader that counts the registration form as a menu form. |
| `lib/doc/__tests__/searchWorkflowPlan.test.ts` (new) | Each M1 row (§14) maps to its stored slots and notice, and, over real fixtures, `expandDoc` before (the stored shape as the old schema reads it, through part 09's raw reader) and after emits byte-equal `search_config` and suite `<action auto_launch>` except the two Web Apps list-first rows, whose emission is the row's. The migration's identity is a wire property, so it is checked at the emitters. Catches a class that moves bytes it should not. |
| `lib/doc/__tests__/searchWorkflowMutations.test.ts` (new) | Through `applyMany` and the gate (`commitVerdicts.ts::mutationCommitVerdict`): enabling Search with no field writes `skipToResults`; removing or hiding the last visible field under an absent workflow writes it; the same edit under a stored `searchFirst` chosen with no field writes nothing; a `listFirst` patch without `formsReadSearch: null` on a module that reads the search is refused with `FORMS_READ_SEARCH_WITH_LIST_FIRST`; `formsReadSearchOnMutations` clears `listFirst`; `removeForm` and a cross-module `moveForm` clear the case list registration slot, a same-module reorder keeps it. Catches a batch that falls into the bare Search screen, and a slot left naming a form elsewhere. |
| `lib/doc/__tests__/caseListMenuItem.test.ts` (new) | `setCaseListMenuItem` sets and deletes the item; adding a form to a bare case list keeps the item; removing the last form of a typed module adds it; clearing the case type deletes it; `diffDocsToMutations` reproduces an item change with one `setCaseListMenuItem` and the replay equals the target; `incrementalValidationScope` names the module and its children. Catches the old flip that removed an authored entry, and an autosave that drops the item. |
| `lib/doc/__tests__/platformOfferParity.test.ts` (extend) | For `list-first` and `forms-read-search`, on each declaration, the batch the builder's choice commits is refused by the gate exactly when `platformRefusal` says so. Catches a picker that offers what the gate refuses. |
| `lib/commcare/validator/rules/__tests__/formsReadSearch.test.ts` (renamed from `searchFirst.test.ts`) | Each `FORMS_READ_SEARCH_*` code refuses its shape with §6.1's message and its accepted twin passes; a non-inline search-first module with a button condition and submenus passes every rule. Catches a rule still reading the workflow instead of the inline flag. |
| `lib/commcare/validator/rules/__tests__/caseListRegistration.test.ts` (renamed from `searchNoMatches.test.ts`) | Each `CASE_LIST_REGISTRATION_*` code with its message, located at the module with `details.formUuid`; `CASE_LIST_REGISTRATION_FORM_NOT_IN_MODULE` for a slot naming another module's form. Catches a rule still reading `Form.entry`. |
| `lib/commcare/validator/__tests__/platformAvailability.test.ts` (extend) | §5's two refusable rows in the parity loop; `search-first` refuses nothing on any declaration. Catches the table and the gate disagreeing. |
| `lib/domain/__tests__/platformUses.test.ts` (extend) | The fixture pairs for `list-first`, `forms-read-search`, `search-first`, `skip-to-results` and `case-list-menu-item` (formless and beside forms); `search` absent for a module whose forms read the search. Catches a detector reading the wrong slot. |
| `lib/commcare/surface/__tests__/platformFeatures.test.ts` (unchanged code) | Rules 1 to 7 over §5's tables and §13.2's manifest. Catches a flip without its row. |
| `lib/doc/__tests__/userFacingErrorsPlatforms.test.ts` (extend) | The builder sentence of `list-first` and `forms-read-search`. Catches copy keyed to a retired id. |
| `lib/notices/__tests__/migrationNoticeCopy.test.ts` (extend) | `PLATFORM_CAUSE_WORDS`' keys equal the features that read `unavailable` (`list-first` and `forms-read-search` in, `search-first` out); `HISTORICAL_PLATFORM_CAUSE_WORDS`' keys are ids no feature reads `unavailable` with; a stored `causes: "search-first"` row renders "menus that use Search first". Catches a step 4 notice row rendering "part of it". |
| `lib/commcare/__tests__/caseListMenuItem.test.ts` (new) | A basic module with forms and the item emits `case_list.show`, the label (the item's unit when set, the module name's otherwise), the media, and in the local suite the case list command after the form commands with the case-loading datums (parsed, syntax checked first); a formless module's bytes equal `main`'s fixture. Catches the command before the forms and a label unit that changes formless bytes. |
| `lib/commcare/__tests__/searchEmission.test.ts` (extend) | The non-inline search-first module's remote request and short detail: `auto_launch` the HQ expression, `default_search` false, no inline instance. Catches the non-inline path taking the inline emission. |
| `lib/preview/__tests__/caseListPhase.test.ts` (new) | `caseListStep` for each workflow × `formsReadSearch` × relevance × platform, and Android's zero-results stay. Catches Preview opening a list Web Apps never shows. |
| `lib/preview/__tests__/caseListMenuItemRoute.test.ts` (new) | The route per rules, and the Android detail's `Done`. Catches Preview sending Android home from a detail. |
| `lib/preview/__tests__/menuProjection.test.ts` (extend) | The entry after the forms, its label and icon; a bare case list's landing; a case-first menu's entry listed after the case is chosen. |
| `lib/preview/__tests__/searchClaims.test.ts` (extend) | `deviceCasesHoldingClaims` with a claim in flight; the form-entry claim reads `moduleFormsReadSearch`. |
| `lib/preview/__tests__/platformCells.test.ts` (unchanged code) | §11.4's rows and models. |
| `lib/preview/app-tests/__tests__/retainedState.test.ts` (extend) | A stored session holding `claimedCaseIds` rehydrates without it. |
| `lib/mcp/__tests__/servedSchemas.test.ts` (snapshots) | The served input schemas of §12.2's tools. |

### 16.2 Postgres

| File | What it proves, and the failure it catches |
|---|---|
| `lib/case-store/sql/__tests__/restoreScopeClaims.postgres.test.ts` (rewritten) | Over HQ's 45 graphs (`case_relationship_tests.json`), a real claim row (owned, open, `host` extension) yields the closure the seeded id yielded at `main` plus the claim row; a closed claim row contributes nothing; a claim row of another Project's case seeds nothing. Real Postgres: the closure is SQL. G6 (§18). |
| `lib/case-store/postgres/__tests__/claims.postgres.test.ts` (new) | `claimCases` inserts one row per unclaimed id with HQ's shape (type, name, owner, index), none for an id the owner already claims, refuses wholesale on an unknown id with nothing written, and two concurrent claims of one host by one owner insert one row; `releaseClaims` closes only the bound owner's open claims in the app; `countClaims`; `resetSampleData` deletes the claim rows of the hosts it deletes; the claim type's schema row exists after genesis. Every catalog read names its schema and table, and the schema test runs once after `VACUUM FULL pg_constraint` with `enable_indexscan = off`, the heap-order lookup step 4's cutover met. |
| `lib/preview/app-tests/__tests__/journey.postgres.test.ts` (extend) | A journey's claim writes a row in its namespace and the next form reads the case; an Android session re-reads its device after a claim that created nothing; a second session of the persona sees the claim after its next device read. |
| `lib/preview/engine/__tests__/searchPopulation.postgres.test.ts` (extend) | `heldOnDevice` is true for a host after its claim row exists. |
| `lib/preview/__tests__/entryPointLaunchAction.test.ts` (extend; Postgres-backed parts move to an `entryPointClaims.postgres.test.ts`) | A Web Apps launch writes its claims and returns a device that holds them; an Android launch writes none. |

### 16.3 Playwright

- `e2e/tests/browser/preview-identity-menu.spec.ts`: a worker claims a searched case; after a reload the
  case is still on the device; **Release claimed cases** shows the count, releases it, and the case leaves
  the device.
- `e2e/tests/browser/preview-platforms.spec.ts`: a both-declared app's search-first menu opens on Search in
  Web Apps and on the list on Android; a case list menu entry beside forms routes per G1.
- `e2e/lib/searchFirstSeed.ts` (renamed `formsReadSearchSeed.ts`), `caseWorkspaceSeed.ts`,
  `smokeSeedFactory.ts`, `previewRuntimeSeeds.ts`, `caseChangesSeed.ts`, `builder-workflows-fixtures.tsx`,
  `builder-tree-client.tsx`, `builder-controls-client.tsx`, `case-workspace-client.tsx` and the specs that
  read `data-search-first` (`builder-tree.spec.ts`, `platform-offering.spec.ts`, `authed.spec.ts`) move to
  the new slots; their assertions are unchanged except where §11 changes what Preview shows.
- Part 07's `e2e/tests/app/search-workflow.spec.ts` and `e2e/tests/app/case-list-menu-item.spec.ts`
  (new, part 07's tests) hold §12.1's controls in this pull request, with part 07's
  `lib/agent/tools/__tests__/caseListRegistrationTools.test.ts` for the tool inputs.

The smoke runs once at the pull request's head, one run at a time (the house rule on the person's machine).

---

## 17. Executed during planning

Read only:

- Nova at `2f985ed6`: every reader and writer this part renames (§19's list is the `rg` of `searchFirst`,
  `moduleOpensOnSearch`, `caseListOnly`, `isNoMatchesForm`, `noMatchesFormOf`, `formEntersFromMenu`,
  `claimedCaseIds`, `addPreviewClaims` and `formlessCaseListSelection` outside tests: 121 files), the
  manifest entries of §13.2 by a Python read of `lib/commcare/surface/entries/*.json`, and defect 21's 37
  register entries with their documents and controls by a Python read of `proof/known-defects.json`.
- Every CommCare fact of §2 at its pin, by `rg` and reading the enclosing function, including formplayer
  `MenuSession.getNextScreen`'s view-command step back, Core's `getDataNeededByAllEntries`, Android's view
  mode detail (`select.detail.bypass=Done`) and the absence of any `auto_launch` reader in commcare-android.
- The lane's own record for the formless case list menu item: `rg "Redirecting after sync" proof` finds no
  walk evidence, so step 4's correction was read, not walked.

- The planning scan of production (read-only, run with the person's yes, printing counts only): its
  findings for this part are stated in words in §14 (the M1 rows it found, M2 to M5, the retained App Test
  sessions), and no count, client data or app identity enters the repo.

Nothing was run in HQ, Core, Formplayer, Android, the lane, Vitest, Playwright or the provider.

---

## 18. Written and not yet run

### G1. The case list menu item on every reader

**Where.** Part 08's reader run by hand at pull request 10's head (part 08 §8.4, row 10), on GitHub's
runners with the person's yes, whose documents include `targeted-case-list-menu-item` and
`targeted-commtrack-advanced`: `gh workflow run proof-audit.yml --ref <branch> -f nightly=false -f
mechanics=<row 10's documents> -f mechanics_shards=auto -f mechanics_readers=true` (Formplayer's walk, the
Web Apps client, a device). G2 and G4 read the same run; none of the three is a second dispatch.

**What.** Each reader walks both menus of `targeted-case-list-menu-item` (§13.3): in the forms-first menu,
the case list entry, then a case (its detail, then its button); in the case-first menu, a case, then the
case list entry from the menu that follows. Each walk's last screen is the observation. The advanced
module's entry is walked the same way on `targeted-commtrack-advanced`. The formless
reading is checked on the existing formless documents of the same run (the controls carry `caseListOnly`
menus at `main`, which pull request 10 emits byte-identically).

**Outcome A: Formplayer answers "Redirecting after sync" and the client opens the app's first menu** (step
4's reading).
- Manifest: `module-case-list-show-true-on-a-basic-module-with-forms` reads `different` on Web Apps with the
  formless entry's note, word for word ("selecting a case shows "Redirecting after sync" and returns to the
  app's first screen"), and `runs` on Android.
- Feature: it joins `case-list-menu-item`; the Web Apps note is unchanged.
- Preview: `caseListMenuItemSelection: "back-to-root-menu"` on Web Apps; the route's `root-menu` arm with
  `caseListMenuItemReturned`; the cell `model("case-list-menu-item-web-apps")` asserts it.
- Advanced: part 02's `module-case-list-show-true-on-an-advancedmodule` flips in this pull request with
  this reading and the same cell, since HQ builds the same form-less entry for both module kinds
  (`entries.py::entry_for_module`) and Formplayer's branch reads the session, not the module kind.
- `harness-findings.md`: "The case list menu item beside forms reads as the formless one in Web Apps:
  Formplayer answers "Redirecting after sync" and the client opens the first menu (`targeted-case-list-menu-item`).
  The manifest's "leaves an empty list" is corrected, and the reading the pins favor
  (`MenuSession.getNextScreen`'s step back) did not hold, because <the run's evidence names the branch>."

**Outcome B: Formplayer steps back to the screen before the choice** (§2.4's prediction: the case list
again in the forms-first menu, the menu again in the case-first one).
- Manifest: all three entries (formless, beside forms, advanced) read `different` on Web Apps with the note
  "choosing a case shows the screen before it again, since nothing opens from the case list".
- Feature: `case-list-menu-item`'s Web Apps note becomes "choosing a case shows the case list again, or the
  menu again where the menu chose the case first".
- Preview: `caseListMenuItemSelection: "step-back"`; the route's `step-back` arm; `formlessReturned` and its
  rename are removed from `runtimeMessages.ts`; the cell's check asserts `step-back`.
- Walk: the run ends at the repeated screen (the walk's script has nothing left to choose), which part 08's
  walk records as the run's end, not a stop.
- Advanced: as outcome A, with this reading.
- `harness-findings.md`: "Step 4's correction of the case list menu item's Web Apps reading did not hold:
  Formplayer steps a view command back (`session/MenuSession.java::getNextScreen`), so choosing a case shows
  the case list again (`targeted-case-list-menu-item`). The formless reading, the beside-forms and advanced
  readings and Preview are corrected."

**Outcome C: the client leaves an empty list** (the manifest's reading).
- Manifest: the beside-forms entry flips with its reading as written; the formless entry reads as its own
  walk shows (A or B wording, or this one).
- Feature: the Web Apps note becomes "choosing a case leaves an empty list"; if the formless walk reads A or
  B, the note names both ("choosing a case from a menu with forms leaves an empty list, and from a menu with
  no forms <its landing>"), and the one feature keeps one reading pair (`different / runs`).
- Preview: `caseListMenuItemSelection: "empty-list"`, or, where the formless walk reads otherwise, the rule
  becomes `{ formless: <its value>; besideForms: "empty-list" }` and `caseListMenuItemSelection(rules,
  bareCaseList)` takes `moduleIsBareCaseList`; the cell's check asserts each.
- `harness-findings.md`: "The case list menu item beside forms leaves an empty list in Web Apps
  (`targeted-case-list-menu-item`), as the manifest read; <the formless walk's landing>."

**Mixed walks.** Where the forms-first and case-first walks land differently from the way their outcome
defines for each, the beside-forms entry's note names each landing, and the rule is keyed by
`moduleIsCaseFirst` the way outcome C keys it by `moduleIsBareCaseList`.

**A walk that errors or stops.** On the platform where it does, the beside-forms shape is refusable there
(decisions 6): a feature `case-list-entry-beside-forms`, label "Case list entries beside forms", reading
`unavailable` on that platform with the observed failure as its note, `refusal: { what: "lists its case
list as a menu entry beside its forms", why: <the observed failure, one sentence>, alternative: "give the
case list a menu of its own, with no forms" }`, a cause word ("menus that list their case list beside
their forms"), a fixture pair, `structural("case-list-entry-beside-forms")` as its cell, the builder's switch
disabled beside forms with its picker line, `PLATFORM_FEATURE_UNAVAILABLE` refusing it, and a walk stop in
`proof/walk-stops.json` with its reason on the document. The beside-forms entry names that feature instead
of `case-list-menu-item`. A formless walk that errors is a defect of pull request 10 fixed before it merges,
since its bytes are `main`'s.

**The device half.** Predicted (§2.4): with no Details columns choosing a case returns to the home screen;
with them the detail shows **Done**, which returns to the list.
- Prediction holds: `case-list-menu-item`'s Android note is §5.4's; `caseListMenuItemDetail: "done"` on
  Android; `harness-findings.md` records C5 as fixed.
- The device shows **Continue** and goes home: the Android note stays step 4's ("with no case details,
  choosing a case returns to the home screen"), `caseListMenuItemDetail` is removed (both platforms
  continue), the `detailDone` message is not added, and C5 is withdrawn in `harness-findings.md`.
- The case-first walk on the device lands elsewhere than home: the Android note names it and the rule
  keys Android's value by `moduleIsCaseFirst` as above.

### G2. Every document whose searching menu turns search first

**Where.** The same run, part 08's row 10 of §8.4, which is planned once: its documents are every document
whose emitted `auto_launch` flips, which the pull request lane lists by comparing the emitted app JSON at
the base and the head (its store misses give the set), plus `targeted-list-first-web-apps,targeted-list-first-places,tile-grouped-search,case-list-match-none,prompt-widgets,case-list-local`
and the documents of §13.3, with the controls of the same names. Part 08's G2 (outcome C) and G3 are its
readings of this run; this part's outcomes below are the same readings, stated for the rows they move here.
**What.** The served readers on those documents and their controls.
- **Outcome A:** every §13.1 entry's class shows on its control and not on its document; Android's records
  of the both-declared documents equal `main`'s (a device never reads `auto_launch`); `tile-grouped-search`
  and `prompt-widgets` keep their stops with the same causes. Pull request 10 merges with the registers as
  §13.1 writes them, the expander document's entry as part 08's G3 reads it (§13.1).
- **Outcome B:** a new walk stop (a required prompt the walk leaves blank, the `search-refused` shape) is
  added to `proof/walk-stops.json` with its reason in pull request 10; a stop whose cause changes is
  rewritten from `checks/stops/<kind>-<document>.json` (same reader, new cause and reason); a new difference
  is a Nova defect fixed in pull request 10 before it merges, never registered; an Android record that
  differs means the manifest's `ignored` reading of search first is wrong, which is corrected at the pins
  with the difference as evidence and moves `search-first`'s and `skip-to-results`' Android readings (G4's
  second B; part 08's G3 outcome C, where this part writes the row).

### G3. HQ's Case List page keeps each workflow

**Where.** Pull request 10's own lane (proof 4 runs HQ's editor saves without the served readers) on
`targeted-search-workflow`, `targeted-search-workflow-inline` and `targeted-search-workflow-android`.
- **Outcome A (§2.1 predicts it):** no proof 4 difference: the selector keeps `auto_launch` and `es_only`,
  a stored `inline_search` survives, an Android-only app keeps list first.
- **Outcome B:** a value a save changes is HQ's editor not keeping that shape: its manifest entry becomes
  REFUSED (`not-hq-editable`, naming the save), a validator code named for the shape refuses it
  (`SEARCH_WORKFLOW_NOT_KEPT_<SHAPE>`, with a message naming what HQ's save turns it into and offering the
  shape it keeps), the builder and tools stop offering it, and §14's M1 maps any stored module of that shape
  to the shape the save writes, with a notice line; each such change lands in pull request 10.

### G4. A Search screen with no visible field

**Where.** The G1 run (part 08 §8.4, row 10), whose documents include `targeted-search-workflow` and
`targeted-search-workflow-inline`.
- **Outcome A (§2.2 predicts it):** Formplayer and the client show the query screen with only its Search
  button for search first with no visible field (inline and non-inline), and run the default search for skip
  to results; a device opens the case list first for the both-declared menus. §11.2 stands.
- **Outcome B, a reader runs the search on its own for search first with no visible field:** Preview's step
  for that shape is `results` (rule 3 and 4 of §11.2 read "a search first with no visible field is
  `results`"), part 07's canvas line for it becomes "The search runs as the menu opens, since there's
  nothing to fill in.", `searchWorkflow`'s last sentence reads "Under searchFirst, a search with nothing
  to fill in runs as the menu opens." (part 07's variants), and the manifest notes say so. §7.2's
  planner stays (it writes the explicit value).
- **Outcome B, a device reads `auto_launch`:** `search-first` and `skip-to-results` read `runs` on Android,
  their Android notes, cells and models go, `searchActionAutoLaunch` is true on both platforms, the
  `list-first` remedy loses "which Android still opens on its case list", and `searchWorkflow`'s
  description drops "Android opens the case list first" for both values (part 07's variant).

### G5. Tool schemas the provider accepts (paid)

Not a run of this pull request. The schemas this pull request changes (`setCaseSearchAdvanced`,
`configureCaseList`, `createModule`, `updateModule`, `createForm`, `updateForm`) are sent to the provider
once, by part 07's G-A1 at pull request 13's head: `npm run test:schema -- <name>` for each tool the free
hash comparison between `main` and that head shows moved (part 07 §4.8), one live call per schema, asked
for once with its cost and run only on the person's yes. No other pull request of the stack runs it, so no
entry is billed twice.
- **Outcome A:** each of this pull request's schemas is accepted.
- **Outcome B:** a refused schema is replaced within the authored surface by a shape the same tool served
  and the provider accepted at `main` (part 07's G-A1 rule): for this pull request's inputs, the nullable
  object becomes a flatter shape, `case_list_menu_item: boolean` with `case_list_menu_item_label: string |
  null` (as `case_list_only: boolean | null` was), and the same for `case_list_registration`; that entry
  alone is sent again, with the person's yes, and nothing merges with a schema the provider has not
  accepted.

### G6. Claim rows against HQ's restore fixtures

Not a CommCare execution: the rewritten `restoreScopeClaims.postgres.test.ts` in pull request 10's CI.
- **Outcome A:** every graph's closure with a real claim row equals `main`'s seeded closure plus the claim
  row.
- **Outcome B:** a graph differs. The real row is HQ's shape, so the test's expectation is the closure with
  the row, the difference is named in the test as where `main`'s seed departed from HQ (for example a claim
  of a closed host), and `harness-findings.md` records the old seed's error.

---

## 19. Files by pull request

**Ordering.** The stack keeps the decisions' order, so pull request 10 sits above pull requests 7 and 8
and below 11 (part 10 §4). In pull request 7 part 02's readers of the menu item and of inline search read
today's `caseListOnly` and `moduleOpensOnSearch`, and its kind blocker `case-list-menu-item-narrowed` meets
no module, since a `caseListOnly` module has no forms and an advanced module has the form holding its
carried create; pull request 8's `commtrackReasons` reads a menu item wherever a module holds one, through
part 02's `lib/commcare/moduleKind.ts::advancedModulesWithCaseListMenuItem(doc)`, which pull request 8 adds
reading today's `caseListOnly`, so before this pull request it answers only a formless module, and holds its
advanced menu item arm with a Vitest witness. This pull request admits the item beside forms, so it points
those readers at
`moduleHasCaseListMenuItem` and `moduleFormsReadSearch`, emits the advanced module's case list menu item,
flips `module-case-list-show-true-on-an-advancedmodule` and brings `targeted-commtrack-advanced`, the lane
witness of the CommTrack menu item reason. It moves no operation path. Pull request 11 sits on it:
part 06's `previous` offer and otherwise read the renamed `formsReadSearch` reason, and
`FORM_LINK_TARGET_CASE_LIST_REGISTRATION_FORM` is this pull request's name.

**Pull request 10.**

- Domain: `lib/domain/modules.ts` (§3, §8, §9 schemas and readers), `menuForms.ts`
  (`caseListRegistrationFormOf`, `moduleIsBareCaseList`, `menuFormUuidsOf`, `searchInputNameResolver`),
  `forms.ts` (`Form.entry` out, `PostSubmitMenuShape.formsReadSearch`), `postSubmit.ts`,
  `platforms.ts`, `platformUses.ts`, `translationUnits.ts`, `mediaRefs.ts`, `referenceSlots.ts`,
  `caseClaim.ts` (new), `index.ts`, `expression/context.ts`, `expression/typeChecker.ts`,
  `entryDatumSupplies.ts`, `caseParentSelection.ts`, `moduleHierarchy.ts`, `navigation.ts`,
  `__tests__/platformFeatureFixtures.ts`.
- Doc: `lib/doc/types.ts` (the patch, `setCaseListMenuItem`, `caseListRegistrationForm`, the removed keys),
  `mutations/modules.ts`, `mutations/forms.ts`, `mutations/index.ts`, `scaffolds.ts`,
  `caseListRegistrationForm.ts` (renamed), `searchReadDependents.ts` (renamed), `searchWorkflowPlan.ts`
  (new), `caseSearchConfigPatchMutations.ts`, `caseSearchConfigMutations.ts`, `caseSelectionMutations.ts`,
  `incrementalValidationScope.ts`, `mutationTargetAdmission.ts`, `referenceIndex.ts`,
  `diffDocsToMutations.ts`, `userFacingErrors.ts`, `platformNotes.ts`, `entryPointReview.ts`,
  `hooks/useModuleIds.ts`, `hooks/useBlueprintMutations.ts`.
- CommCare: `suite/case-search/searchWireShape.ts`, `types.ts`, `inlineSearch.ts`, `remoteRequest.ts`,
  `noMatches.ts`, `suite/case-list/orderPlanOptions.ts`, `hqJson/caseList.ts`, `expander.ts`, `compiler.ts`,
  `session.ts`, `emissionPlan.ts`, `entryPointProjection.ts`, `formLinkProjection.ts`,
  `hqNestedSelection.ts`, `projectSpaceCompatibility.ts`, `localeFile.ts`; validator `errors.ts`,
  `rules/case-search/formsReadSearch.ts` (renamed), `rules/case-search/caseListRegistration.ts` (renamed),
  `rules/case-list/searchInputRefUsesWhenInputPresent.ts`, `rules/module.ts`, `rules/form.ts`,
  `rules/multiSelect.ts`, `rules/parentSelection.ts`, the rule registries that list them; surface
  `entries/case-search.json`, `entries/menus-and-case-lists.json`, `platformFeatureEntries.ts`.
- With part 02 and part 03 (the advanced module's case list menu item): `lib/commcare/moduleKind.ts` (the
  kind blocker `case-list-menu-item-narrowed`, `advancedModulesWithCaseListMenuItem` and the
  `forms-read-search` blocker read `moduleHasCaseListMenuItem` and `moduleFormsReadSearch`), `session.ts`
  (the advanced module's case list entry, part 02 §17), `planPrivileges.ts` (`commtrackReasons`' menu item
  arm), `lib/commcare/surface/entries/gates.json` (the menu item's CommCare Supply effect), the copy rows part 02
  marks "from pull request 10", the advanced entry's manifest flip and cell, and part 07's line beside the
  case list menu item of an advanced menu (part 07 §3.7).
- Case store and db: `lib/case-store/store.ts`, `errors.ts` (`ClaimCasesInputError`), `postgres/store.ts`,
  `sql/compileRestoreScope.ts`, `lib/db/materializeCaseStoreSchemas.ts`.
- Preview and session: `lib/preview/platform.ts`, `caseListPhase.ts`, `searchClaims.ts`,
  `caseListMenuItemRoute.ts` (renamed), `caseListRegistration.ts` (renamed from `noMatchesForm.ts`),
  `menuProjection.ts`, `afterSubmitRouting.ts`, `entryPointLaunch.ts`, `entryPointLaunchAction.ts`,
  `runtimeMessages.ts`, `engine/caseDataBinding.ts`, `engine/caseDataBindingHelpers.ts`,
  `engine/previewAuthorization.ts`, `engine/searchEvaluation.ts`, `engine/serverSearchRead.ts`,
  `engine/evaluateFormSnapshot.ts`, `engine/useCaseDatabaseSnapshot.tsx`, `hooks/useCaseDataBinding.ts`,
  `hooks/useSearchResultsSnapshot.ts`, `hooks/useEntryPointLaunch.ts`, `hooks/useRestoreScopeKey.ts`,
  `hooks/useClaimSearchedCases.ts` (new), `app-tests/run.ts`, `types.ts`, `retainedState.ts`, `context.ts`,
  `service.ts`, `records.ts`, `navigation.ts`, `__tests__/platformCells.ts`, `platformCellModels.ts`;
  `lib/session/previewClaims.ts` (removed), `store.ts`, `hooks.tsx`, `types.ts`; `lib/routing/location.ts`,
  `hooks.tsx`; `lib/codemirror/expressionEditorContext.ts`.
- Components: §12.1's files, part 07's among them (`inspector/SearchWorkflowSetting.tsx` and
  `searchWorkflowModel.ts` new, `canvas/SearchCanvas.tsx`, `CaseListRegistrationSetting.tsx` and
  `caseListRegistrationReview.tsx` renamed, `detail/moduleSettings/CaseListMenuItemSection.tsx` new,
  `ModuleSettingsPanel.tsx`), `components/builder/shared/checkErrorPresentation.ts` and
  `components/builder/app-setup/LanguagesSection.tsx`.
- Agent and MCP: `tools/case-list-config/configureCaseList.ts`, `case-search-config/shared.ts`,
  `setCaseSearchAdvanced.ts`, `createModule.ts`, `updateModule.ts`, `createForm.ts`, `updateForm.ts`,
  `getModule.ts`, `shared/caseListRegistration.ts` (renamed from `shared/formEntry.ts`),
  `lib/agent/summarizeBlueprint.ts`, `blueprintHelpers.ts`, `authoring/reference.ts`,
  `authoring/evaluationContext.ts`, the guide's search sentences (part 07 §4.5), `translation/translator.ts`,
  `lib/models.ts` (`"v6-hq-round-trip-case-writes.10"`); `scripts/test-schema.ts` (part 07 §4.8's prompts of
  pull request 10); `scripts/inspect-app.ts`, `scripts/lib/blueprint-stats.ts`.
- Notices: `lib/notices/migrationNoticeCopy.ts`.
- Proof (part 08 holds the lists): `proof/known-defects.json`, `fixed-defects.json`, `checks/registers.py`,
  `targeted/documents/searchApps.ts`, the new `targeted-search-workflow*`, `targeted-case-list-menu-item`
  and `targeted-commtrack-advanced` sources, `targeted-migration-search-workflow`'s migrated spec,
  `inlineSearchReads.ts`, `noMatchesReturnIdentity.ts`, `targeted/index.ts`, the corpus sources of §13.4,
  `corpus/footprint.ts`, `corpus/editKinds.ts`, `walk-stops.json` (per G2), `proof/README.md`'s defect 21
  row, `proof/views/test_search_workflow_offers.py`; the fuzz `lowerToDoc` mappings.
- Research inventory: `docs/research/2026-09-26-hq-round-trip/inventory/case-search.md`,
  `menus-and-case-lists.md` (§13.2's rows).
- Docs: §15's pull request 10 sentences.
- Tests: §16.

**Pull requests 7 and 8 (parts 02 and 03)** emit advanced modules with no case list menu item beside their
forms and hold `commtrackReasons`' menu item arm with a Vitest witness; this pull request brings the rest
(above).
**Pull request 11 (part 06)** reads the renamed post-submit reasons for the otherwise and owns
`FORM_LINK_TARGET_CASE_LIST_REGISTRATION_FORM` from then on.
**Pull request 13 (part 07)**: G-A1, the one billed schema run, covering this pull request's schemas (G5).
Pull request 12 changes nothing of this part.
**Pull request 14 (part 09)**: §14's classes M1 to M5, the notice's `menu-opens-on-search` sentences, and
M6's planned difference `claim-type-row`, which the drift writer converges after the deploy.
**Pull request 15 (part 10)**: §15's pull request 15 sentences.

---

## 20. What other parts read from this one

| Part (pull request) | Reads |
|---|---|
| 01, case writes (4, 5) | nothing of this part; the reserved `commcare-case-claim` type stays reserved for authors |
| 02, advanced and extension (7, 8, 10) | `moduleHasCaseListMenuItem` and `caseListMenuItemSchema` for the advanced entry, from pull request 10; G1's outcome for `module-case-list-show-true-on-an-advancedmodule` and its cell `model("case-list-menu-item-web-apps")`, in pull request 10 on `targeted-commtrack-advanced`; that an advanced form's entry cannot carry inline search, read as `moduleFormsReadSearch` from pull request 10; that the one arm of `caseListRegistrationForm` needs forms that read the search, so HQ's six advanced case-list-registration rules are unreachable in step 5; the ordering of §19 |
| 03, publish and ledger (6, 8, 10) | `moduleHasCaseListMenuItem`, which part 02's `advancedModulesWithCaseListMenuItem(doc)` reads from pull request 10 for CommTrack's "an advanced module whose case list menu item is on" (one sentence per module it returns); pull request 8 writes that arm over the same reader reading today's `caseListOnly`, which answers only a formless module until pull request 10 admits the item beside forms; `advancedCaseSearchReasons`' new reason; `formEntrySyncReasons` unchanged ("a module whose case list offers Search"); a deployment whose HQ Case List save already turned a list-first menu to search first now matches what Nova pushes, and its `hq_changed` discard (`lib/deployment/CLAUDE.md`, "Baselines") is then harmless |
| 04, questions (3, 9) | `FormExpressionFacts.formsReadSearchModule` and `caseListRegistrationForm` for the `#search/` scope |
| 06, form links (11) | `FORM_LINK_TARGET_CASE_LIST_REGISTRATION_FORM`; `POST_SUBMIT_NOT_OFFERED_REASONS`' `menu-forms-read-search` and `menu-is-bare-case-list`; `previous` offered except where the forms read the search; a link into a menu whose forms read the search carries the query (`moduleUsesInlineSearch`); a bare case list is a link target HQ offers (`post_process/workflow.py::_add_stack_children_for_target`, `target_module.forms or case_list.show`); `reconcilePostSubmitWithMenuShape` reacting to `formsReadSearch` |
| 07, authoring (10, 13) | §12's stored shapes, planners and tool inputs for its surfaces in pull request 10; §5's notes, refusals and picker lines; `MODEL_CONTEXT_VERSION` `.10`; G5 as part of its G-A1 in pull request 13; G1, G3 and G4's outcomes for its copy |
| 08, proof (1, 10) | §13 whole; G1, G2 and G4 as readings of its one run by hand at pull request 10's head (§8.4, row 10), and G3 in the pull request's lane; the four documents and the content needs of §13.3; `lib/doc/searchWorkflowPlan.ts::authoredSearchWorkflow` for the fuzz mapping; §13.7's findings |
| 09, cutover (14) | §14's classes M1 to M5, the planner, the notice reason's two sentences and `detail.opensOn`, the overlay move, M6's claim schema row as a planned drift difference the drift writer converges after the deploy (no skip in `computeSchemaDrift`), the catalog rule, no App Test rewrite, and the M1 last row and the overlay entries as the dry run's to count |
| 10, stack and contracts (15) | §15; the ordering of §19 |

**For the outlines.**

- *Step 6 (import), for the outline:* the reader reads `auto_launch` / `default_search` / `inline_search`
  into `workflow` and `formsReadSearch` (absent for `auto_launch` without `default_search`), `auto_launch:
  false` in an app with `cloudcare_enabled: false` into `listFirst`, and refuses `auto_launch: false` where
  Web Apps is declared with the `list-first` reason; it reads `case_list.show` into `caseListMenuItem` (its
  label and media), and `case_list_form` on an inline host whose form sits in a `module_filter: false()`
  module into `caseListRegistrationForm { kind: "after-empty-search" }`; it reads `commcare-case-claim` cases
  nowhere, since they are case data, not app content. Reason: step 6 builds the reader.
- *Step 7 (rest of the model), group 3 (modules and navigation), for the outline:* the other arms of
  `Module.caseListRegistrationForm` (a registration form in another module, always offered; the follow-up
  arm under FOLLOWUP_FORMS_AS_CASE_LIST_FORM; its display condition, icon and audio label; its after-submit
  choice), each a new `kind` the discriminator admits without a migration;
  `menus-and-case-lists/case-list-form-pointing-at-a-registration-form-in-another-module`,
  `...-follow-up-form-of-the-parent-case`, `...-relevancy-expression-with-followup-forms-as-case`,
  `case-list-form-media-image-media-audio` and the `case-list-form-post-form-workflow-default-case-list`
  widen stay HELD-NEW or derived until then; a media slot for the case list entry in `setMenuMedia`
  (`target: "case-list"`), which the SA lacks at `main` as it lacks the case list link's media. Reason: step
  5 renames the concepts and admits the item beside forms; these are new authored shapes the research
  places in step 7.
