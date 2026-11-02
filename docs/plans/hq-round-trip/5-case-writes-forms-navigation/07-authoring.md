# Step 5, part 07: Authoring on the three editors

Part of [step 5's plan](../5-case-writes-forms-navigation.md), which holds the baseline, the decisions,
the stack and the exit. This part plans how step 5's model reaches the people and models who author an
app: the one statement of an identity move (pull request 5, with its conflict lead in pull request 6),
the builder's new surfaces (pull request 12), the Solutions Architect and MCP tool surface, the
authoring guide and `MODEL_CONTEXT_VERSION` (pull request 13), and the smaller surface changes each
feature pull request carries because its model change makes an old control, tool input or guide
sentence false (pull requests 2, 3, 4, 5, 7, 10 and 11). It also plans the `../nova-plugin` pull
request that merges after the deploy. The stored shapes, planners, validator codes and emission this
part authors belong to the other parts: part 01's case writes and placements, part 02's advanced
modules, part 03's publish placements, ledger and conflict, part 04's repeats, groups and labels, part
05's search workflow and menu concepts, part 06's form links. Where this part depends on one of them it
names the exact fact it reads (§1), and every name it gives another part to adopt is listed at the end.

Stack references use the sixteen pull requests by number, as step 5's plan holds them.

Citations are `path::symbol` for Nova at `main` `2f985ed6`, and `file::symbol` for CommCare at the pins
`proof/pins.json` names: commcare-hq `d6c6e16d8ae1`, commcare-core `8e9ba8d908e9`, commcare-android
`7a5584475580`, commcare-connect `046c7fd78081`, formplayer `24383ac71bfb`, Vellum `01215f251c57`.
`../nova-plugin` is read at `105836d` (its `.claude-plugin/plugin.json` version `2.3.0`). At `main`,
`lib/models.ts::MODEL_CONTEXT_VERSION` is `"v5-hq-round-trip-platforms.12"`,
`lib/db/appTests.ts::RUNTIME_VERSION` is `17` (part 04 moves it to `18` in pull request 3, decision 14),
and `scripts/test-schema.ts::SCHEMA_TESTS` registers 55 entries.

This part rests on three CommCare facts of its own, each read at the pins:

- **The form builder holds formatting per display text, for every language at once.** Parsing an itext
  entry sets `item.hasMarkdown` when a `markdown` form is present, and writing one writes the markdown
  form from the default form exactly when `item.hasMarkdown && !this.data.core.form.noMarkdown`
  (Vellum `src/javaRosa/plugin.js`, the itext parser and writer). The per-text control is the
  `.turn-markdown-off` / `.turn-markdown-on` pair of the markdown widget, which sets `hasMarkdown` on
  the item (`src/javaRosa/itextWidget.js::markdown`). That widget is offered on choices, groups,
  question lists and repeats only under the `markdown_in_groups` feature (`src/javaRosa/itextBlock.js::itextLabelBlock`,
  `NO_MARKDOWN_MUGS`), which HQ turns on above CommCare 2.23
  (`corehq/apps/app_manager/feature_support.py::CommCareFeatureSupportMixin.enable_markdown_in_groups`).
  So the setting is one per text, shared by its languages, and it is what **Format text** authors
  (§3.13).
- **A repeat inside a question list needs a count, at any depth.** The form builder refuses an empty
  count on a repeat with any Question List ancestor: `src/mugs/types/group.js`, the `repeat_count`
  validation, whose `insideFieldList` walks every parent and returns "Repeat Count is required.". **Show
  on one screen** refuses the same state (§3.12).
- **HQ's Case List page offers three workflows, and the inline search only beside the two that open on
  Search.** `corehq/apps/app_manager/static/app_manager/js/details/case_claim.js`: `self.workflow` reads
  `classic` (`auto_launch` false), `auto_launch`, or `es_only` (`auto_launch` and `default_search`), and
  `self.inlineSearchVisible` is true only for `auto_launch` and `es_only`. HQ reads the inline flag only
  beside `auto_launch` (`corehq/apps/app_manager/util.py::module_uses_inline_search`). So **When this
  menu opens** offers three choices, and **Forms read the search** shows only under the two that open on
  Search (§3.8).

Every platform reading this part shows is a row of `lib/domain/platforms.ts::PLATFORM_FEATURES` that
part 05 or part 06 owns; this part writes the builder's words for the search workflow (decision 1 of
step 5's plan) and never restates a reading.

No choice in this part depends on the production scan: the builder, the tools and the guide are the
same whatever the scan counts, and the cutover's own scan-dependent choices are part 09's.

## Decisions in brief

1. **One planner states every identity move.** `lib/doc/identityMoves.ts::withIdentityMoves(doc,
   batch)` composes the per-subject planners (part 02's `lib/doc/moduleKindMoves.ts` for a menu's kind
   and its chain's names, first; part 01's `lib/doc/placementMoves.ts` for case changes and the own
   close; part 04's `lib/doc/queryRepeatPlacement.ts` for query repeats) and returns the batch with the
   `holdPlacements` entries each move needs, plus the moves (§2.2). It returns at once for a document
   that holds nothing.
2. **One dialog states them in the builder.** `components/builder/shared/IdentityMoveDialog.tsx` opens
   before any dispatch, review, undo or redo whose batch moves a held identity, and commits only on
   **Make the change**. The case-list registration review and the platform section's review show the
   same list inside their own dialog instead of opening a second one (§2.4).
3. **An undo or a redo carries exactly the hold changes the kernel admits.** The kernel's rule
   (`lib/db/placementAuthority.ts::placementChangeRefusal`, decision R3 of step 5's plan) admits an
   editor's hold change that moves a hold its own batch makes inexpressible, or that restores the
   hold the target's latest recording wrote. `BlueprintDocState.applyHistoryStep` derives each
   inverse so it carries only those: the undo of an identity move puts the change and its hold back
   where the published app has them; a hold change neither arm admits (a publish recorded the new
   place after the edit) is dropped, the content change is kept, and the toast says so (§2.5).
4. **A publish that lands under an edit reopens the dialog with its own lead.** When the server
   refuses a builder batch with `reason: "placement-recorded"` (part 03), the tab reloads as today,
   then offers the rejected edits again, re-planned over the new head, in the dialog with the lead `A
   publish just recorded where CommCare HQ keeps these answers, so your change now moves them.`
   (§2.6).
5. **The SA and MCP state every move and ask no confirmation.** Every staging result and every
   canonical tool result carries `identityMoves: { subject, sentence }[]`, `saveWork` / `save_work`
   repeats every move of the work it saves, and the guide tells the model to tell the person before it
   saves (§2.7). A departure from the research's "say so before it commits", decision 3 of step 5's
   plan.
6. **Placements are shown, never chosen.** No builder control and no tool input carries a placement,
   a held menu kind or a held query repeat placement. The read surfaces show them; publish's offered
   moves are part 03's dialog and parameters.
7. **Each surface changes in the pull request whose model change makes it false; new authoring lands
   in pull requests 12 and 13.** What leaves the document leaves every surface in its own pull request
   (attachment mode in 2, the structured close condition and the preloaded value row in 4, `searchFirst`,
   `caseListOnly` and `entry` in 10, the first-true link semantics in 11), and where a feature pull
   request replaces a stored concept, the replacement's control and input land with it (the own case
   arm in 4, the search workflow, the case list menu item and registration from the case list in 10,
   the whole after-submit surface with the otherwise in 11, decision R12 of step 5's plan). New
   controls and new tool inputs that no replacement needs wait for 12 and 13. §5 holds the whole
   table.
8. **"Saves to" is the field's view of the writes.** `CaseWriteEditor` lists one row per write in
   `fieldCaseWriteViews` and edits each through `planFieldCaseWrite` (pull request 4); a case above
   this form's case and **Save only if changed** join it in pull request 12 (§3.2).
9. **A preload is a default the author sees.** The read-only preloaded value row goes; the Saves to
   row says `Opens with the case's current value.` and offers **Start blank instead**, or the reverse
   (§3.3, pull request 4).
10. **This form's case is one settings section,** `OwnCaseSection`, replacing `CloseConditionSection`:
    the close form's **Close the case** in pull request 4, a registration's **Create the case** and
    **Close the case it creates** in pull request 12, each condition the ordinary card editor (§3.4).
11. **The case changes screen lists this form's case first,** fixed in place, and from pull request 12
    each change's rail ends with **Where CommCare HQ keeps it**. "Advanced" leaves every author-facing
    word for a case change (§3.5).
12. **What a menu opens on is one choice, "When this menu opens",** with **Search first**, **Results
    first** and **Case list first**, and under the first two the switch **Forms read the search**, over
    the stored values of decision 1 of step 5's plan, each offered by declaration and disabled with a
    reason (§3.8, pull request 10).
13. **Registration from the case list keeps its two editing places,** renamed to the menu concept, and
    **the case list in the menu** is a module settings section, **Show the case list in this menu**,
    admitted beside forms (§3.9, §3.10, pull request 10).
14. **After submit follows part 06,** with this part's copy (§3.11, pull request 11).
15. **A group says whether it shows on one screen,** **Show on one screen**; **Format text** is a
    toggle on question, group, repeat and section labels and on choices only, per decision 2 of step
    5's plan; a repeat gains its **Rows** editor (§3.12 to §3.14, pull request 12).
16. **The tools change tool by tool as §4.2 gives,** with every description final in the pull request
    that lands it. `MODEL_CONTEXT_VERSION` becomes `"v6-hq-round-trip-case-writes.<n>"` in each pull
    request `<n>` that changes a served tool's name, description or input schema or the guide (2, 3, 4,
    5, 7, 10, 11, 13); pull request 13 sets the deployed value (§4.7).
17. **The billed schema check is asked once, at pull request 13's head,** naming every
    `scripts/test-schema.ts` entry any pull request of the stack added or changed (decision R11 of step
    5's plan), with the served-schema hash run between `main` and that head as its check; each runs as
    `npm run test:schema -- <name>` only on the person's yes, and no other pull request runs it (§4.8).
18. **`../nova-plugin` changes `skills/upload_to_hq/SKILL.md`, its README and its version to `2.4.0`,**
    in one pull request that merges only after Nova's deploy of the stack is live (§6).

## 1. What this part reads from the other parts

The names below are the contract this part builds on. Each is planned by the part named; this part
follows its names. Where this part needs a name another brief did not give, it proposes one here and
lists it at the end for that part and part 10 to adopt.

**Part 01, the case writes (pull requests 2, 4, 5).**

- Pull request 2: attachment mode leaves the document. `CAPTURE_CASE_WRITE_MODES`, `CaptureCaseWriteMode`
  and `captureCaseWriteSchema` are deleted (`lib/domain/fields/base.ts`); a capture's write is the link
  to its file.
- Pull request 4: `Field.caseWrite` leaves the document.
  `lib/domain/caseWriteViews.ts::fieldCaseWriteViews(doc, fieldUuid): readonly FieldCaseWriteView[]`,
  each `{ formUuid, operationUuid, slot: "name" | "write" | "owner", caseType, property, via?,
  onlyIfChanged: boolean, link: boolean, destination: "own" | "ancestor" | "child" | "worker-record" |
  "other" }`;
  `lib/doc/fieldCaseWriteMutations.ts::planFieldCaseWrite(doc, fieldUuid, destination | null,
  options?)`, its destination `{ caseType, property, via?, onlyIfChanged? }`;
  `lib/doc/caseWriteChoices.ts::caseWriteChoiceVerdict` (its dry run); the own-case arm `action: "own"`
  of `caseOperationSchema`; `Form.openCondition` and `Form.closeCondition` as `Expression`s on slots
  `form_open_condition` and `form_close_condition`, written through `updateForm.patch.openCondition` /
  `closeCondition` (`null` clears); writes with `via` (`CaseWriteVia`, a tuple of `{ identifier,
  throughCaseType? }`) and `onlyIfChanged: true`, keyed by `(via, property)`; the target `{ kind:
  "worker-record" }`; the term `capture-link`; `lib/domain/casePreload.ts::fieldPreload(field)` and
  `writerOffersPreload(doc, fieldUuid)` and the rewritten `hiddenWriterBlankNote`;
  `lib/commcare/placement.ts::planPlacements`; the codes `CASE_OWN_OPERATION`,
  `OPEN_CONDITION_WRONG_TYPE`, `CASE_WRITE_VIA_INVALID`, `CASE_WRITE_ONLY_IF_CHANGED_INVALID` with
  their builder sentences in `lib/doc/userFacingErrors.ts`; `via` and `onlyIfChanged` admitted only on
  the own arm's writes of a follow-up or close form whose own arm takes Case Management (part 01 §7,
  §8; decision R9 of step 5's plan), so every offer below sits on the own arm alone. The stored held
  slots land here too, written by nothing until pull request 5: `placement` on every operation arm
  (`lib/domain/placements.ts::casePlacementSchema`) and `Form.ownClosePlacement`
  (`ownClosePlacementSchema`). The builder's placement lines read
  `lib/doc/casePlacements.ts::formCasePlacementView(doc, formUuid)`, and every ineligibility reason's
  sentence is `lib/domain/placementCopy.ts::placementIneligibilitySentence(reason)`.
- Pull request 5: `HELD_PLACEMENT_INEXPRESSIBLE` and its siblings (`CASE_PLACEMENT_SHARED`,
  `HELD_BLOCK_PATH_TAKEN`); `lib/doc/placementMoves.ts::planOperationPlacementMoves(candidate)`,
  returning `{ holds, moves }` whose reasons are the first `PlacementIneligibility` of each move;
  `lib/commcare/placement.ts::placementExpresses(doc, formUuid, subject, placement)` and
  `placementIneligibility`.

**Part 02, advanced modules (pull requests 7, 8, 10).** No stored `Form.caseSelections`, no `selection`
target and no validator code per advanced rule in step 5 (part 02's decision 3, decision R4 of step 5's
plan): a module is advanced exactly when its kind is held (`Module.heldKind: "advanced"`, from pull
request 7, written only through `holdPlacements`) or one of its forms holds a create an after-submit
link carries; its forms' selections are derived from the parent-selection chain. This part reads
`lib/commcare/moduleKind.ts::emittedModuleKind` and `advancedKindReasons` (why a menu is advanced,
`held` or `carried-create`, for the settings row of §3.7), `lib/domain/advancedModule.ts::advancedKindBlockers`
and `heldKindExpresses`; the one move source `lib/doc/moduleKindMoves.ts::planModuleKindMoves(prev,
candidate)` with the one subject `module-kind`, its `PlacementLabel`s `ordinary-menu` and
`advanced-menu`, and its `ModuleKindMoveReason = AdvancedKindBlocker["kind"] | "advanced-change"`
(`several-cases`, `forms-read-search`, `case-list-menu-item-narrowed`, `chain-index`,
`advanced-change`), which the gate arm reads and this part words (part 02 §21), the sentence also
stating, from part 02's facts, that a menu selecting a parent case has its forms read the chosen cases
under new names (the session's `case_id` and `parent_id` become `case_id_load_<type><n>`, or back); the one new code
`FORM_LINK_NEEDS_NEW_CASE_DATUM` with its builder sentence, which is also the disabled reason of the
case list menu item's switch (part 02 §17); the case list menu item of an advanced module, first beside
forms in pull request 10 (decision R1); gated run G6 (written and not yet run).

**Part 03, publish and the ledger (pull requests 5, 6, 8).** The `holdPlacements` mutation, entries
`{ target, placement | null }` over the targets case operation, own close and query repeat from pull
request 5, and module kind from pull request 7 (decision 4, decision R2); `placementChangeRefusal(prev,
next, kind)`, whose editor half lands in pull request 5 and whose `publish-placement` arm in 6, with
the two editor arms of decision R3: an editor batch may change a hold only where (a) the same batch
makes the earlier hold inexpressible, or (b) it restores, for a target, exactly the hold the latest
recording for that target wrote (the latest `publish-placement` or `blueprint-migration` row, else
the greatest fold baseline's snapshot); the kernel's reader of those recorded holds per target, which
the builder's load carries as `recordedHolds` (part 03 §6.3); the reconciler's record of them,
handed to the store through `lib/doc/store.ts::setRecordedPlacementHolds`, and the client half of the
two arms, `lib/doc/placementHolds.ts::admittedHoldChanges(doc, batch, recorded)` (pull request 5, §2.5); the
`publish-placement` frame, which an open tab folds as a remote change; the 409 `commit_rejected` body's
`reason: "placement-recorded"`, `BlueprintCommitRejectedError.findingCodes`, `PLACEMENT_CONFLICT_CODES`
and the reconciler's `onPlacementConflict(replay)`, which this part's
`components/builder/placementConflictReplay.ts::replayAfterPlacementConflict` supplies (§2.6); the publish dialog's offered
moves and MCP's `accept_placement_moves`, the refusal's `placement_moves`, every answer's `placements:
{ recorded, moved }`, `app_changed_while_publishing` and `hq_placement_moves_changed`; the `commtrack-off` confirmation with `confirm_commtrack_off` and its
`COMMTRACK_OFF` copy; the `same-type-child-links` capability.

**Part 04, questions (pull requests 3, 5, 9).** A query repeat's `placement?: "model-iteration" |
"count"`, a stored slot from pull request 3 written by nothing until pull request 5's
`holdPlacements` (decision R2); `lib/domain/queryRepeatPlacement.ts::queryRepeatPlacementNeeds` (needs
`nested`, `query-reads-answers`, `ancestor-condition-changes`), `effectiveQueryRepeatPlacement` and
`queryRepeatPlacementExpresses`; `QUERY_REPEAT_MODEL_ITERATION_SHAPE` (pull request 5);
`lib/doc/queryRepeatPlacement.ts::planQueryRepeatPlacementMoves(candidate)` (pull request 5), whose
move reasons are those needs and whose facts part 04 §1.7 gives; a count placement's rows keep their
answers by position (part 04's departure, decision R10); pull request 3's guide and tool text (part 04
§8.4), which §4.2 and §4.5 quote; the checker's `expected-value` reason
`whole-number-count` on slot `repeat_count`, reported as `REPEAT_COUNT_TYPE` with part 04's message;
`group.fieldList?: true`, `lib/domain/fields/group.ts::groupBornFieldList`, the code
`FIELD_LIST_USER_REPEAT`, and the field-list arm of `lib/doc/formSectionVerdicts.ts::fieldPlacementVerdict`;
`plainLabel?: true` on question, container and section labels and on inline choices, and the
`updateField` patch keys `fieldList: true | null` and `plainLabel: true | null` (decision 2); gated runs
G2 and G3 (written and not yet run).

**Part 05, search and menus (pull request 10).** `caseSearchConfig.workflow?: "listFirst" |
"skipToResults"` and `formsReadSearch?: true` (decision 1), read by
`lib/domain/modules.ts::searchWorkflow` and `moduleFormsReadSearch`; the `caseSearchConfigPatch` keys
`workflow` (`null` is search first) and `formsReadSearch`; the platform rows `list-first`,
`search-first` (redefined), `skip-to-results` and `forms-read-search`; `Module.caseListMenuItem` (`{
label?, icon?, audioLabel? }`, presence the switch), `moduleHasCaseListMenuItem`,
`moduleIsBareCaseList`, the mutation `setCaseListMenuItem { uuid, item | null }`;
`Module.caseListRegistrationForm` (`{ kind: "after-empty-search", formUuid, label? }`) and
`caseListRegistrationFormOf`; the renamed planners `lib/doc/caseListRegistrationForm.ts`,
`formsReadSearchOnMutations` and `lib/doc/searchReadDependents.ts`; the planner
`lib/doc/searchWorkflowPlan.ts::authoredSearchWorkflow`; the renamed codes (`FORMS_READ_SEARCH_*`,
`CASE_LIST_REGISTRATION_*`, `CASE_LIST_MENU_ITEM_NO_CASE_TYPE`); the gated run of decision 6 (part
05's G1) and the runs G3 and G4 (written and not yet run). The builder's words for these values are
this part's (decision R9 of step 5's plan): `Search first`, `Results first`, `Case list first` and
`Forms read the search`.

**Part 06, form links (pull request 11).** `Form.otherwise`, the mutation `setFormOtherwise {
formUuid, otherwise | null }`, `lib/doc/formLinkMutations.ts::afterSubmitPlan` with `mayNotRun` and
`otherwiseOffered`, `planSetOtherwise`, `planMakeOtherwise`, `planMakeDestination`;
`lib/doc/formLinkReview.ts::formLinkAddChoices`; `lib/domain/formLinkTargets.ts::menuTargetOffered`;
the target `{ type: "this-form" }`; the codes of part 06's D8; the platform row
`after-submit-several-destinations`; the gated runs G1 to G3 (written and not yet run). The whole
after-submit surface, the builder's screen and the tool `setFormOtherwise` / `set_form_otherwise`
included, lands in pull request 11 as surfaces the model change forces, with part 06's structure and
input shapes and this part's copy (decision R12 of step 5's plan); pull request 12 adds no second
version of any of it.

**Part 09, the cutover (pull request 14).** Private agent work open at the window is discarded with
`unsaved-assistant-work-discarded` (decision 12), so no staged batch in the old shapes reaches a tool
after the deploy, and no tool carries a sentence for one. The notice reasons name this part's controls
in their words (what other parts read from this one).

## 2. The identity-move statement (pull request 5)

### 2.1 Today

- No document holds a placement, so no edit moves one. Today's placement is derived on every read
  (`lib/domain/closeCondition.ts::closeConditionPlacement` for the close, `deriveCaseWriteInventory` for
  field writes), and the builder states only the close's: the line under `CloseConditionSection`
  (`lib/doc/hooks/useCloseConditionPlacement.ts`).
- Every builder write runs `lib/doc/hooks/useBlueprintMutations.ts::createBlueprintMutations`'s
  `guardedApply`: admission, the commit verdict, then a direct commit of the validated candidate as one
  undo step. `reviewMany` evaluates a batch without committing; `commitMany` commits one batch.
- Undo and redo run `lib/routing/historyStep.ts::runHistoryStep`, which gates the recorded batch with
  `undoRedoGateVerdict` and applies it with the store's `undo()` / `redo()`.
- A 409 `commit_rejected` (`app/api/apps/[id]/route.ts`, from `BlueprintCommitRejectedError`, body `{
  error, type }`) makes `lib/collab/reconciler.ts` drop the rejected human batch and its causal
  successors, discard uncommitted command state and local history, and reload; `useAutoSave` shows its
  conflict toast.
- SA and MCP edits stage through `ToolInvocationContext.applyBatch` / `applyStages`: in private work
  through `lib/agent/change-set/workspace.ts` (its durable `StageRequestReceipt`, spread into the staging
  result by `lib/agent/authoring/session.ts` beside `diagnostics`), and on the canonical surfaces
  through `lib/agent/workspace/canonicalWorkspace.ts`. `saveWork` (`lib/agent/authoring/session.ts::saveWork`)
  commits private work and records its response in the request's `result_json`.

### 2.2 One planner

`lib/doc/identityMoves.ts` (new):

```ts
/** What an identity move is about. Every UUID is the entity's own. */
export type IdentityMoveSubject =
	| { readonly kind: "case-operation"; readonly formUuid: Uuid; readonly operationUuid: Uuid }
	| { readonly kind: "own-close"; readonly formUuid: Uuid }
	| { readonly kind: "query-repeat"; readonly formUuid: Uuid; readonly fieldUuid: Uuid }
	| { readonly kind: "module-kind"; readonly moduleUuid: Uuid };

export interface IdentityMove {
	readonly subject: IdentityMoveSubject;
	readonly from: PlacementLabel; // lib/domain/placementCopy.ts, a closed union
	readonly to: PlacementLabel;
	readonly reason: IdentityMoveReason; // each source's own reasons, below
}

/** Each source's reason ids, as its owner names them. */
export type IdentityMoveReason =
	| { readonly source: "case-placement"; readonly reason: PlacementIneligibility } // part 01
	| { readonly source: "query-repeat"; readonly reason: QueryRepeatNeed } // part 04
	| { readonly source: "module-kind"; readonly reason: ModuleKindMoveReason }; // part 02

export interface IdentityMovePlan {
	readonly batch: readonly Mutation[];
	readonly moves: readonly IdentityMove[];
}

/** The batch with every hold change its edit needs appended as one
 *  `holdPlacements` mutation, and every identity the result moves. */
export function withIdentityMoves(doc: BlueprintDoc, batch: readonly Mutation[]): IdentityMovePlan;

/** Every held identity `after` keeps in another place than `before` does, with
 *  the reason the earlier place no longer expresses it. */
export function identityMovesBetween(before: BlueprintDoc, after: BlueprintDoc): readonly IdentityMove[];

/** Whether the document holds any placement, menu kind or query repeat
 *  placement; memoized per document object in a WeakMap. */
export function documentHoldsIdentity(doc: BlueprintDoc): boolean;
```

- **Composition.** `withIdentityMoves` returns `{ batch, moves: [] }` unchanged when
  `documentHoldsIdentity(doc)` is false, which is every app no publish, cutover or import has recorded
  a hold for. Otherwise it prepares the candidate once (`lib/doc/commitVerdicts.ts::prepareMutationCandidate`)
  and hands it to each source in this order: part 02's `planModuleKindMoves(doc, candidate)`
  (from pull request 7; first, because a menu's kind decides which placements part 01 then moves),
  part 01's `planOperationPlacementMoves(candidate)` (case operations, the own close), part 04's
  `planQueryRepeatPlacementMoves(candidate)`. Each source returns its `holdPlacements` entries and its
  moves over the candidate the earlier sources left (part 02's entries applied before part 01 plans);
  the function appends one `holdPlacements { holds }` mutation carrying every entry to the batch, so
  the commit gate and the kernel see one batch. The builder and the tools never
  prepare the candidate twice: `guardedApply` and the workspace hosts pass the prepared candidate on to
  the verdict.
- **`moves` lists every move the result makes,** not only the appended ones: after appending, the
  function compares the doc's holds with the candidate's (`identityMovesBetween(doc, candidate)`), so a
  redo that re-applies a recorded move states it too.
- **A move is a hold change whose earlier hold can no longer express its target.** A hold change that
  restores the hold the target's latest recording wrote (decision R3's arm (b), §2.5) puts the answers
  back where the published app keeps them, so it is no move and states nothing.
- **Registration by pull request.** Pull request 5 lands the module with part 01's and part 04's
  sources, together with part 03's `holdPlacements` mutation the sources return (decision R2: the
  held slots land with their stored concepts, the query repeat's in pull request 3 and the
  operation's and own close's in pull request 4, but nothing writes a hold before pull request 5's
  mutation, the cutover's write in 14, or pull request 6's publish, so pull requests 3 and 4 have no
  move to state). Pull request 7 adds part 02's one source with `Module.heldKind` and the `module-kind`
  target. The subject union and the copy (§2.3) land whole in pull request 5, so pull request 7 adds a
  planner and no copy.
- **`identityMovesBetween`** reads each held value in `before` and its counterpart in `after`; where
  they differ and the target still exists, it asks the owner's predicate whether the earlier hold
  still expresses the target in `after` (part 01's `placementExpresses` for operations and the own
  close, part 04's `queryRepeatPlacementExpresses` for query repeats, part 02's `heldKindExpresses` for
  a menu) and, where it does not, states a move with the owner's first reason (part 01's first
  `placementIneligibility`, part 04's first need, part 02's first blocker or `advanced-change`). A
  target that no longer exists is no move (its data left with it, part 01). `lib/doc/identityMoves.ts`
  reaches `lib/commcare/placement.ts` and `lib/commcare/moduleKind.ts`, so `biome.json`'s import
  allowlist for `lib/commcare` gains it beside part 01's `lib/doc/placementMoves.ts` and
  `lib/doc/casePlacements.ts`.

### 2.3 Copy

`lib/domain/placementCopy.ts` (new in pull request 4, §3.6) holds `PlacementLabel` and its words:

| `PlacementLabel` | Words |
|---|---|
| `case-management` | `Case Management` |
| `case-actions` | `case actions` |
| `save-to-case` | `Save to Case` |
| `rows-set-when-opened` | `rows set when the form opens` |
| `rows-follow-query` | `rows that follow the cases found` |
| `ordinary-menu` | `an ordinary menu` |
| `advanced-menu` | `an advanced menu` |

`placementCopy.ts` also holds part 01's `placementIneligibilitySentence(reason)` over its
`PLACEMENT_INELIGIBILITY_REASONS`; this part adds no second sentence for any of them.

`lib/doc/identityMoveCopy.ts` (new) words each reason by its owner's sentence, so a reason without copy
fails to compile (`identityMoveReasonSentence(move)`, a switch over `IdentityMoveReason["source"]`):

| Source | Reason ids | Sentence |
|---|---|---|
| `case-placement` (part 01) | the `PLACEMENT_INELIGIBILITY_REASONS` (`module-advanced`, `module-basic`, `several-cases`, `value-computed`, `write-condition`, `links`, `condition-apostrophe`, `subcase-index` and the rest of part 01 §12.8) | `placementIneligibilitySentence(reason)`, part 01 §12.8's table, for example `One of its values is now a calculation, which Case Management can't save.` |
| `query-repeat` (part 04) | `nested` | `It now sits inside “<outer repeat>”.` |
| | `query-reads-answers` | `Its query now reads an answer.` |
| | `ancestor-condition-changes` | `“<group>” around it now shows on a condition that can change while the form is filled in.` |
| `module-kind` (part 02) | `several-cases` | `It now lets workers choose several cases, which an advanced menu can't do.` |
| | `forms-read-search` | `Its forms now read the search, which an advanced menu can't do.` (pull request 7, where the blocker reads today's inline Search first: `It now opens on its Search screen with its forms reading the search, which an advanced menu can't do.`) |
| | `case-list-menu-item-narrowed` | `Its case list in the menu now has a filter or a parent case, which an advanced menu would leave out.` |
| | `chain-index` | `Its cases now link to their parent case under more than one name.` |
| | `advanced-change` | `A form in it now saves a case change only an advanced menu can.` |

The query repeat's three sentences are part 04 §1.7's facts in these words, and the menu's five reasons
are part 02 §21's `ModuleKindMoveReason` (its four blocker kinds and `advanced-change`), worded here and
quoted by part 02 §21. In step 5 the
only case change only an advanced menu can hold is a carried create's open action, so
`advanced-change` names the carried link's effect.

Subject names (`lib/doc/identityMoveCopy.ts::identitySubjectName(doc, subject)`):

| Subject | Name |
|---|---|
| `case-operation` | `“<form name>”: <operation description>` (part 01's describer, asked for under what other parts read from this one) |
| `own-close` | `“<form name>”: closing its case` |
| `query-repeat` | `“<form name>”, “<repeat label, or its id when unlabelled>”` |
| `module-kind` | `“<menu name>”` |

The tool sentence (`lib/doc/identityMoveCopy.ts::identityMoveSentence(doc, move)`):
`<Subject name> moves from <from> to <to>. <Reason sentence> From your next publish, CommCare HQ's
exports show these answers under new columns.` For example: `“Follow-up visit”: Update the patient case
moves from Case Management to Save to Case. One of its values is now a calculation, which Case
Management can't save. From your next publish, CommCare HQ's exports show these answers under new
columns.`

A menu's kind gets its own two sentences in the dialog (§2.4); in a tool result its sentence is the same
template with `<from>` and `<to>` the menu words. When the menu selects a parent case, its forms read
the chosen cases under new names once its kind changes (part 02 §21's fact: the session's `case_id` and
`parent_id` become `case_id_load_<type><n>` when the menu becomes advanced, and back when it becomes
ordinary), and the module-kind move's sentence says so itself, with no move of its own: after the
reason sentence it adds `Its forms also read the cases chosen through its parent case under new
names.` For example: `“Household visits” moves from an ordinary menu to an advanced menu. A form in it
now saves a case change only an advanced menu can. Its forms also read the cases chosen through its
parent case under new names. From your next publish, CommCare HQ's exports show these answers under
new columns.`

### 2.4 The builder's dialog

`components/builder/shared/IdentityMoveDialog.tsx` (new) and its list `IdentityMoveList.tsx` (new,
shared with the review dialogs):

| Element | Text |
|---|---|
| Title | `This changes where CommCare HQ keeps some answers` |
| Lead | `Your published app keeps these answers in one place. After this change it keeps them in another, so from your next publish CommCare HQ's exports show them under new columns.` |
| Row, case change or own close | `<subject name>: from <from> to <to>` |
| Row, query repeat | `<subject name>: its rows now follow the cases found, so each row's case id moves to a new place in the submission` (part 04 keeps every authored answer's path in both placements; only the generated nodes move) |
| Row, menu kind to advanced | `<menu>: becomes an advanced menu in CommCare HQ, so every form in it keeps its case changes in a new place` |
| Row, menu kind to ordinary | `<menu>: becomes an ordinary menu in CommCare HQ, so every form in it keeps its case changes in a new place` |
| Row, menu kind, where the menu selects a parent case | the menu-kind row above followed by `, and its forms read the cases chosen through its parent case under new names` |
| Second line of each row | the reason's sentence (§2.3) |
| Primary | `Make the change` |
| Secondary | `Cancel` |
| Lead on undo or redo | `Your published app keeps these answers in one place. Undoing this keeps them in another, so from your next publish CommCare HQ's exports show them under new columns.` (redo: `Redoing this`) |

The dialog is the shadcn `Dialog` (`components/CLAUDE.md`), one per builder (mounted in the builder
layout beside the toast host), reading a session store slice.

**How a dispatch reaches it.** `createBlueprintMutations`' `guardedApply` runs `withIdentityMoves(doc,
projected.mutations)` after language projection and before the verdict. With no moves it goes on as
today. With moves it runs the verdict on the planned batch; a refusal is announced as today; an admitted
batch is not committed but set as `lib/session/store.ts`'s `pendingIdentityMove: { batch, moves,
origin: "edit" | "undo" | "redo" | "conflict" }`, and `guardedApply` returns `{ ok: false, messages: [],
deferred: true }`, which every caller already treats as a no-op (the inline flavor shows no finding,
because there is none). **Make the change** calls the new `commitStated(batch)` on the announcing
flavor: the gate runs again over the freshest doc, and the batch commits as one undo step. **Cancel**
clears the slice; nothing reaches the store or the reconciler. A second dispatch while a move is pending
is refused by `builderWriteAdmission` with `A change is waiting in the open dialog. You can make it or
cancel it, then go on.`, so two pending batches never race.

**Reviews.** `reviewMany` returns `identityMoves` on its outcome. The three reviewing surfaces
(`components/builder/case-list-config/noMatchesFormReview.tsx`, renamed in pull request 10 to
`caseListRegistrationReview.tsx`; `components/builder/case-list-config/CaseListConfigWorkspace.tsx`'s
review; `components/builder/detail/appSettings/AppPlatformsSection.tsx`) render `IdentityMoveList`
inside their own dialog when the list is not empty, and confirm through `commitStated`, so a person
answers one dialog, not two.

**Undo and redo.** §2.5.

**Cost.** `documentHoldsIdentity` is one memoized walk per document object, so a session on an app that
holds nothing pays one walk; on an app with holds, `withIdentityMoves` reuses the candidate the verdict
needs, so a keystroke-rate edit (a label, a hint) costs the planners' walk of the forms the batch
touches. The planners read only the forms and modules the batch names (part 01's footprint rule), so an
unrelated edit stays cheap.

### 2.5 Undo and redo

An undo or a redo is an ordinary edit (`lib/collab/CLAUDE.md`), so it meets the same planner and the
kernel's rule (`placementChangeRefusal`, decision R3 of step 5's plan, which part 03 writes): an
editor's batch may change a hold only where (a) the same batch makes the earlier hold inexpressible,
or (b) it restores, for a target, exactly the hold the latest recording for that target wrote (the
latest `publish-placement` or `blueprint-migration` row, else the greatest fold baseline's snapshot).
Every other hold change is refused. So a history step carries only hold changes of those two arms,
and this part derives them.

- **The recorded holds reach the tab.** The builder's load carries, beside the document, the holds
  the latest recordings wrote as `recordedHolds`, read by part 03's kernel reader over the same
  rows arm (b) reads (part 03 §6.3). The reconciler keeps that record beside `confirmedDoc`, replaced
  whole on every reload and entry by entry by every folded `publish-placement` frame, and hands it to
  the store through part 03's `lib/doc/store.ts::setRecordedPlacementHolds`; the store keeps it as
  `BlueprintDocState.recordedHolds` (a map keyed by part 03's `placementTargetKey`,
  `case-operation:<form>:<operation>` and so on). A `blueprint-migration` row reloads the
  tab, which reads them again.
- **`BlueprintDocState.applyHistoryStep(action)`** (`lib/doc/store.ts`, new) takes the recorded
  forward or inverse batch, as `undo()` / `redo()` read it, and keeps each `holdPlacements` entry only
  where it passes part 03's `lib/doc/placementHolds.ts::admittedHoldChanges(doc, batch, recordedHolds)`
  (the client half of the kernel's two arms, over the same `holdExpresses`): the entry restores the target's recorded hold exactly (arm (b)), or the step's content change
  leaves the current hold unable to express the target (arm (a), through the owners' predicates of
  §2.2). The other entries are dropped and the content change is kept. It applies the result, moves
  the cursor as `undo()` / `redo()` do, and records the exact inverse of what it applied, so the next
  redo or undo replays what happened.
- **What that gives.**
  - The undo of an identity move restores the change and puts its hold back where the published app
    keeps it (arm (b)). Nothing moves against the published app, so no dialog opens.
  - The undo of removing a held case change or query repeat re-creates it with its hold (arm (b)).
  - Where a publish recorded the new place after the edit, the hold the undo would restore is no
    longer the recorded one, and the earlier content can sit in the new place, so the hold change is
    dropped: the content is undone and the answers stay where the publish recorded them.
  - A redo of a move makes the earlier hold inexpressible again (arm (a)) and states the move.
- **`runHistoryStep`** then runs `withIdentityMoves(doc, <the kept batch>)`. With moves (a redo, or an
  undo whose restored content strands a hold a publish recorded after the edit), it sets
  `pendingIdentityMove` with origin `undo` or `redo` and returns `{ kind: "deferred" }`; **Make the
  change** applies the planned batch as that history step, **Cancel** leaves the cursor where it was.
- **Toasts** (`projectToast`, `info`): where the step restored a recorded hold, `Undone. These answers
  are back where your published app keeps them.`; where it dropped a hold change, `Undone. CommCare HQ
  keeps these answers where your last publish put them, since only a publish records a new place.`
  (redo: `Redone.` and the same sentence). The person learns which export column the answers use.

### 2.6 The conflict lead (pull request 6)

Part 03 owns the `publish-placement` frame, its fold, the classification of a refusal and the replay's
collection (part 03 §6.2); this part owns the handler the reconciler calls. This part reads what part
03's pull request 6 adds:

- `BlueprintCommitRejectedError.findingCodes`, and the PUT route's 409 `{ error, type:
  "commit_rejected", reason: "placement-recorded" }` when every finding code is in
  `lib/doc/placementHolds.ts::PLACEMENT_CONFLICT_CODES` (`HELD_PLACEMENT_INEXPRESSIBLE`, its part 01
  siblings and part 04's `QUERY_REPEAT_MODEL_ITERATION_SHAPE`);
- the reconciler's `commitRejected` branch, which for that reason collects the replay (the rejected
  human batch, its successors and the queued commands), runs today's branch, and once the reload
  completes with the person still an editor calls `onPlacementConflict(replay)`; `useAutoSave` shows
  no toast for that cause.

This part's `components/builder/placementConflictReplay.ts::replayAfterPlacementConflict` (new, pull
request 6) is the `onPlacementConflict` the builder layout supplies through `ReconcilerProvider`. It
calls the pure step `lib/doc/identityMoves.ts::planConflictReplay(doc, replay, recordedHolds)` (pull
request 6), which joins the replay into one
batch, drops every hold change `admittedHoldChanges` does not admit over the reloaded document and its
recorded holds (the derivation `applyHistoryStep` uses), and plans the rest with `withIdentityMoves(doc,
batch)` over the reloaded document. `replayAfterPlacementConflict` runs `useBlueprintMutations`' gate on
the planned batch. Where it is admitted and states a move, it sets `pendingIdentityMove` with origin `conflict`;
otherwise nothing is dispatched and part 03's placement toast (title `App reloaded`, part 03 §16) says
the change can be made again. Under origin `conflict` the dialog reads:

| Element | Text |
|---|---|
| Lead | `A publish just recorded where CommCare HQ keeps these answers, so your change now moves them.` (part 03's `placement-recorded` lead) |
| Primary | `Make the change` |
| Secondary | `Leave it` |

**Make the change** commits the planned batch as a new edit (one undo step; the local history the
reload discarded stays discarded). This is a departure from the reconciler's "no fallback draft or
partial rebase" (`lib/collab/reconciler.ts`, its 409 branch): the rejected edits are offered again,
never applied without the person, and only when the refusal names nothing but a moved identity. A
refusal that names anything else keeps today's behavior exactly.

### 2.7 The SA and MCP

- **The hosts plan.** `lib/agent/workspace/canonicalWorkspace.ts` and
  `lib/agent/change-set/workspace.ts` run `withIdentityMoves(snapshot.doc, admitted)` in `applyBatch`
  before the verdict, and over the concatenated candidate in `applyStages` (the hold entries join the
  last stage). Tool bodies and `guardedMutate` (`lib/agent/tools/common.ts`) change nothing.
- **The outcome carries the report.** `WorkspaceMutationOutcome`'s ok arm gains `identityMoves: readonly
  IdentityMoveReport[]`, where:

  ```ts
  // lib/doc/identityMoves.ts
  export interface IdentityMoveReport {
  	readonly subject: IdentityMoveSubject;
  	readonly sentence: string; // identityMoveSentence
  }
  export const identityMoveReportSchema = z.strictObject({
  	subject: identityMoveSubjectSchema, // the union above, UUIDs as uuidSchema
  	sentence: z.string().min(1),
  });
  ```

- **Private work persists it.** `lib/agent/change-set/schemas.ts`'s `StageRequestReceipt` gains
  `identityMoves: z.array(identityMoveReportSchema).optional()` (absent when empty), so a recovered
  request returns the moves its first answer gave. `lib/agent/authoring/session.ts` spreads
  `identityMoves` into the staging result beside `diagnostics`.
- **Canonical surfaces add it.** `canonicalWorkspace.ts::invoke` merges the invocation's moves into an
  object result as `identityMoves` when not empty, the same field name, so the chat SA and MCP read one
  field everywhere.
- **`saveWork` repeats them.** For an app-edit commit, `saveWork`'s response gains `identityMoves:
  identityMovesBetween(base, committed).map(report)` (absent when empty), where `base` is the saved
  document the work began from and `committed` the checkpoint it writes; the response is recorded in
  `result_json` as today, so a retried save returns the same list. A genesis save holds nothing and
  carries none. Computing from the two documents, not from the receipts, keeps a move that a later
  staged step undid out of the list.
- **No confirmation.** No tool asks a confirmation round for a move, and `needsConfirmation` is not
  used. The work stages privately and `saveWork` is the commit; the result and the guide sentence (§4.5)
  make the model tell the person first. A departure from the research ("the builder, SA and MCP say so
  before it commits"), decision 3 of step 5's plan.
- **Version.** A result field moves no `MODEL_CONTEXT_VERSION` (`lib/agent/CLAUDE.md`, "Provider
  contract"); the guide paragraph of §4.5 moves it in pull request 5.

## 3. The builder

### 3.1 Today

- **The field's binding.** `components/builder/editor/fields/CaseWriteEditor.tsx` chooses or clears one
  complete `Field.caseWrite` through `updateField`, from a combobox grouped by case type ("Writable case
  types", "The worker's own record", "Don't save to case data", "Save to new property"). A capture's row
  adds the **What reaches the case** chooser (`A link to the file` / `The file itself`). The guidance
  under it is `editor/fields/caseWritePresentation.ts::caseWriteGuidance`.
- **The preload.** On a writer `lib/domain/casePreload.ts::writerPreloadsFromLoadedCase` admits,
  `DefaultValueEditor` renders `editor/fields/PreloadedValueRow.tsx`, read-only.
- **Form settings.** `detail/formSettings/FormSettingsPanel.tsx` stacks `RecordNameSection`,
  `CloseConditionSection` (close forms: **Always** / **When condition is met**, a question, an
  operator and an answer, stored as `{ field, answer, operator }`, with the placement line of
  `useCloseConditionPlacement`), `FormEntrySection` (a registration form's **How this form opens**),
  the after-submit sections, `ConnectSection`, `FormAppearanceSection`, `DisplayConditionSection`,
  `CaseChangesSection`.
- **Case changes.** `components/builder/case-operations/` lists `Form.caseOperations` with sentences
  (`operationSentence.ts`), reorders through `lib/doc/caseOperationReview.ts::caseOperationMoveVerdicts`
  with refusals in `refusalCopy.ts`, seeds additions in `seeds.ts`, and edits in
  `CaseOperationDetailCanvas.tsx` and `CaseOperationInspectorBody.tsx`. Field writes never appear there.
- **Search.** `case-list-config/inspector/SearchPanelInspectorBody.tsx` shows a **Search first**
  `ToggleRow` (`components/builder/inspector/inspectorChrome.tsx`) only while the Search action is
  active and the menu may open on Search, disabled with `platformPickerLine(platformRefusal("search-first",
  …))` where Android is declared. Registration after an empty search is edited on the Search canvas
  (`case-list-config/canvas/NoMatchesFormSetting.tsx`) and in form settings (`FormEntrySection.tsx`),
  both through `case-list-config/noMatchesFormReview.tsx::useNoMatchesFormEntry`.
- **Case list menus.** A case-list module is born `caseListOnly` with no forms
  (`lib/doc/scaffolds.ts::caseListModuleMutations`, `appTree/insertion/AddModulePopover.tsx`); a childless
  one is its Results screen in the tree, the home tile and the breadcrumb (`appTree/ModuleCard.tsx`).
  Module settings show its **Case list link** icon and spoken label only when `caseListOnly`
  (`detail/moduleSettings/ModuleAppearanceSection.tsx`).
- **Groups, repeats and text.** A group's and a repeat's inspector hold only **Show when**
  (`editor/fieldEditorSchemas.ts`); a repeat's rows are set only through the tools. Labels are edited in
  `components/preview/form/InlineTextEditor.tsx`, a Tiptap editor whose label toolbar mounts the
  `components/tiptap-ui/` buttons, and choices in `editor/fields/OptionsEditor.tsx`.
- **Offering by declaration.** Each offering site asks `platformRefusal(feature, useDeclaredPlatforms())`
  and shows `platformPickerLine`; `components/builder/shared/PlatformNoteRow.tsx` states a difference;
  `lib/doc/__tests__/platformOfferParity.test.ts` holds each site's batch to the gate.

### 3.2 "Saves to" (pull requests 2, 4 and 12)

**Pull request 2.** The **What reaches the case** chooser, its `mode` patch and the attachment branch
of `caseWritePresentation.ts` are deleted. A capture's row reads `Saves a link to the file in
<property>`, and its guidance keeps today's link sentences (`Nova fills this link in once the app
reaches a CommCare project space…`). Rejected: a disabled `The file itself` item with a reason; a
choice that can never be enabled again offers no way forward.

**Pull request 4.** `CaseWriteEditor` renders one row per view of
`fieldCaseWriteViews(doc, fieldUuid)`, through `lib/doc/hooks/useFieldCaseWrites.ts::useFieldCaseWrites(fieldUuid)`
(new: a primitive-keyed selector over the reference index, so an unrelated edit does not re-render the
rail). Each row edits its own write through `planFieldCaseWrite`; a change that retargets one row of a
several-write view is refused by the planner with its sentence, and the row offers **Edit in case
changes**, which opens that operation's row on the case changes screen. With no view the row reads
`Doesn't save to a case` and offers the destination menu.

| Element | Text |
|---|---|
| Row label | `Saves to` |
| This form's case (registration) | `The new <case type> · <property>` |
| This form's case (follow-up, close) | `This form's case · <property>` |
| A new child | `A new <case type> · <property>` |
| The worker's record | `The worker's record · <property>` |
| Another case (an operation `planFieldCaseWrite` did not write) | `<operation description> · <property>`, read-only, with **Edit in case changes** |
| Capture | `Saves a link to the file in <property>` |
| Child guidance | `Creates a new <case type> on each submission.` (today's, kept) |
| Several-case guidance | today's several-case sentences, kept |
| Remove | ghost button `Stop saving this answer` |

The destination menu keeps today's combobox and regroups it: **This form's case** (the menu's case
type's properties), **New cases** (each declared direct child type), **The worker's record** (where
the app declares worker properties), then `Don't save to a case` and `Save to new property`. Each choice
is offered by `caseWriteChoiceVerdict` and disabled with its `offeredChoiceRefusal` line when the
planner refuses, never hidden.

**Pull request 12.** Two gestures the model gained in pull request 4:

- **Cases above it.** On a follow-up or close form, the menu adds the group **Cases above it**: each
  ancestor type the catalog reaches from the menu's case type through `parent` or `host` links,
  labelled `<case type> (<link identifier>)`, and, where two link chains reach one type, one item per
  chain labelled with the chain (`household (parent, then host)`). Choosing one writes the destination
  with `via` through `planFieldCaseWrite` (the destination shape this part asks part 01 for is under what other parts read from this one).
  A row with `via` reads `<case type> it belongs to · <property>` for one step and `<case type> above it
  · <property>` for more.
- **Save only if changed** (under part 01's G5 outcome A; outcome B builds no switch, as written and
  not yet run says). A row on this form's case on a follow-up or close form, and a row on a case
  above it, gains a switch:

  | Element | Text |
  |---|---|
  | Label | `Save only if changed` |
  | Line | `Saves this answer only when the worker changes it.` |
  | Disabled, registration | `A new case has no earlier value to compare with.` |
  | Disabled, the change is kept in Save to Case | `CommCare HQ saves only changed answers through Case Management or case actions, and this form keeps this change in Save to Case.` |

  Turning it on is one `planFieldCaseWrite` with `onlyIfChanged: true`; publish then asks for the
  capability `Save only answers that changed` (part 01 decision 12 and §8; the probe and publish stop as for every capability).

The pure state behind each row is `components/builder/editor/fields/caseWriteRowModel.ts` (new in
pull request 4, extended in 12): from a view, the field, the form and the planner's verdicts, it returns
the row's destination text, its guidance, its preload line (§3.3), its switch state and reasons.

### 3.3 The preload as a default (pull request 4)

`PreloadedValueRow.tsx` and the forced-visible path in `defaultValueEntry()` are deleted. The default
value row is the ordinary `DefaultValueEditor`; a `form-case` term shows as its card,
`<case type>'s <property>`.

On a row of the field's view that writes this form's case on a one-case follow-up or close form
(`writerOffersPreload`), the **Saves to** row adds one line:

| State (`fieldPreload(field)` against the row's property) | Line | Action |
|---|---|---|
| The default is exactly the case read of the written property | `Opens with the case's current value.` | ghost `Start blank instead`: one `updateField` clearing `default_value` |
| No default and no calculation | `Starts blank, and saving it blank clears the case's value.` | ghost `Open with the case's current value`: one `updateField` setting `default_value` to the `form-case` term |
| Another default, or a calculation | none | none |

A hidden writer's note is part 01's rewritten `hiddenWriterBlankNote`. Rejected: an implicit preload
with a "starts blank" switch (two spellings of one default, the defect 28 shape the research removes).

### 3.4 This form's case (pull requests 4 and 12)

`components/builder/detail/formSettings/OwnCaseSection.tsx` (new) replaces `CloseConditionSection.tsx`
where it was mounted. Its state is the pure model `ownCaseModel.ts` beside it:

| Form type | Rows | Pull request |
|---|---|---|
| close | **Close the case**: `Every time` / `When a condition is true` | 4 |
| registration | **Create the case**: `Every time` / `When a condition is true`; **Close the case it creates**: `Never` / `Every time` / `When a condition is true` | 12 |
| follow-up, survey | none | |

| Row | Choice | Stored |
|---|---|---|
| Close the case (close form) | `Every time` | `closeCondition` absent |
| Close the case (close form) | `When a condition is true` | `closeCondition` = the author's tree |
| Create the case | `Every time` | `openCondition` absent |
| Create the case | `When a condition is true` | `openCondition` = the author's tree |
| Close the case it creates | `Never` | `closeCondition` absent |
| Close the case it creates | `Every time` | `closeCondition` = `true()` |
| Close the case it creates | `When a condition is true` | `closeCondition` = the author's tree |

The asymmetry is part 01's M2: a close form always closes, so an absent condition is every time; a
registration closes its case only when `closeCondition` is present. The section shows a stored `true()`
on a registration as `Every time`, never as a card.

- **Choosing `When a condition is true` stores nothing.** It opens the card editor in the local state
  `awaiting-condition` (the `editor/fields/hiddenValueModel.ts` precedent: a local state, not a write);
  only a condition the author completes commits, through `inline.updateForm` with `openCondition` or
  `closeCondition`, one undo step. Leaving the editor empty returns the row to its stored choice.
  Rejected: committing `true()` or `false()` as a seed (a second spelling of a stored choice, or a
  change workers meet before the author wrote anything).
- **The condition** is `components/builder/shared/ExpressionCardEditor.tsx` over its registered slot,
  with the context `shared/editorAxes.ts::editorAxesForSlot(doc, slot)` builds: a static select's
  answer is a `choice` card by its label, and the options editor's who-reads-this-choice refusal covers
  it. Rejected: keeping today's question, operator and answer picker (a second condition grammar beside
  the one `Expression`).
- **The placement line** under each condition is `placementLine` of the own arm's placement, or of
  the own close's when it has its own block (§3.6). Pull request 4 lands it (it replaces today's line);
  pull request 5 adds the held suffix.
- The case operation `removalPlan` and the form-type change planner (part 01's `planFormTypeChange`)
  clear `openCondition` and `closeCondition` where the new type admits neither, and their reviews say
  so.

### 3.5 The case changes screen (pull requests 4 and 12)

**Pull request 4: this form's case is the first row.**

- `CaseOperationsCanvas.tsx` lists the own arm first. Its sentence (`operationSentence.ts`):
  registration `Create this form's <case type> case`, follow-up `Update this form's <case type> case`,
  close `Update and close this form's <case type> case`, each followed by today's write count phrase.
- The row has no drag handle. A keyboard move of it, or of another row above it, is refused with
  `This form's case is always the first change.`, a fourth refusal in `refusalCopy.ts`, announced on
  `role="alert"` as the other three. Its reason is part 01's `caseOperationMoveVerdicts` reason
  `own-first` (asked for under what other parts read from this one).
- Its rail has no action menu and no remove. Its writes are edited in the canvas like any change's, and
  each is the same write the field's **Saves to** row shows; an expression value there (any value that
  is not one question's answer) is admitted and moves the change to Save to Case, which the rail's
  placement row says from pull request 12 and the dialog states when the change was held.
- Every word "advanced" leaves the screen, its sentences, its rail and its seeds; "case change" is the
  noun, as today.

**Pull request 12: new gestures.**

- **Update the worker's record** joins the add chooser (`seeds.ts`) where the app declares worker
  properties: born an update with target `worker-record`, one write of the first declared worker
  property from the first question whose kind fits it, or disabled with the planner's reason.
- Each write row of the own arm on a follow-up or close form gains in its overflow **Save to a case
  above it** (the ancestor menu of §3.2, writing `via`) and **Save only if changed** (§3.2's switch and
  reasons, as a menu item with its disabled reason). Part 01 admits `via` and `onlyIfChanged` on the
  own arm's writes only (decision R9 of step 5's plan), so no other change's write rows offer them; a
  write to a case above the selected case is its own update of that case, as today.
- Each change's rail, the own arm's included, ends with a read-only row `Where CommCare HQ keeps it`
  whose value is the change's `placementLine` (§3.6), with the held suffix where a publish recorded it.
  No control: a placement is never authored.
- Under part 02's gated run G6 outcome B, a create placed on a case action whose links are all
  extensions shows, under that row, `CommCare HQ gives this case no owner, so it syncs to whoever holds
  the case it extends.` (written and not yet run).

### 3.6 Placement lines (pull requests 4, 5 and 12)

`lib/domain/placementCopy.ts::placementLine(placement)`, total over part 01's `CasePlacement` union, so an
arm without copy fails to compile:

| Placement | Line |
|---|---|
| a basic own, usercase or child slot | `CommCare HQ keeps this in the form's Case Management settings.` |
| an advanced action (lands with the arm, pull request 7) | `CommCare HQ keeps this in the form's case actions.` |
| Save to Case | `CommCare HQ keeps this in a Save to Case block in the form, which needs Save to Case in the project space's plan.` |
| any of them, held (pull request 5) | the line, then ` · Kept where your published app has it` |

The builder reads placements through part 01's `lib/doc/casePlacements.ts::formCasePlacementView(doc,
formUuid)` (pull request 4, cached per document object), which calls `planPlacements` from `lib/doc`
and holds part 01's `biome.json` allowlist entry, as `lib/doc/formLinkReview.ts` holds one.
`lib/doc/hooks/useCasePlacements.ts` (new in pull request 4, replacing
`useCloseConditionPlacement.ts`) selects one form's view by primitive keys; the own case section (pull
request 4) and each change's rail row (pull request 12) read their answer from it.

### 3.7 Advanced menus in the builder (pull requests 7, 10 and 12)

The builder never offers "make this menu advanced". It says when CommCare HQ shows a menu as one.

- **Pull request 7.** Part 02's one source, `planModuleKindMoves`, registers into
  `withIdentityMoves`; the dialog's menu rows (§2.4) state each move. A module is advanced only through
  its held kind or a create an after-submit link carries (decision R4 of step 5's plan), so the one
  refusal an author meets is `FORM_LINK_NEEDS_NEW_CASE_DATUM`, which names the link and what keeps the
  menu ordinary; its builder sentence shows where the edit was made (the link editor, or the setting
  whose change adds a blocker), through the existing announcing and inline flavors.
- **Pull request 10.** The case list menu item of an advanced menu lists exactly what its ordinary list
  would, because part 02's blocker `case-list-menu-item-narrowed` admits it only where the list has no
  filter, no hidden owners and no case chosen before it (part 02 §17), so the item means one thing on
  both kinds and nothing is said beside it. The switch **Show the case list in this menu** is disabled
  where the commit verdict of turning it on refuses it, a menu a carried create keeps advanced and
  whose list is narrowed, and its disabled reason is that verdict's sentence:
  `FORM_LINK_NEEDS_NEW_CASE_DATUM`'s builder sentence for the cause `case-list-menu-item-narrowed`
  (part 02 §15, §17), which names the link and what keeps the menu ordinary. On a menu advanced only by
  its hold, turning it on is offered, and the held kind moves back to ordinary through the dialog (part
  02 §21).
- **Pull request 12.** Module settings gain a read-only row, `In CommCare HQ`, shown only for a menu
  `emittedModuleKind` reads `"advanced"`, worded from part 02's
  `lib/commcare/moduleKind.ts::advancedKindReasons(doc, moduleUuid)` (its first reason), read through a
  `lib/doc/hooks` hook on the allowlisted `lib/doc` reader:

  | Reason | Line |
  |---|---|
  | `held` | `CommCare HQ keeps this as an advanced menu, as your published app has it.` |
  | `carried-create` | `CommCare HQ shows this as an advanced menu, because “<form>” has a link after submit that opens the new <case type> case it creates, which only an advanced menu can hand on.` |

### 3.8 When this menu opens (pull request 10)

`SearchPanelInspectorBody` replaces the **Search first** `ToggleRow` with
`case-list-config/inspector/SearchWorkflowSetting.tsx` (new), a `fieldset` of three full-width choices
(the `detail/appSettings/AppPlatformsSection.tsx` pattern: `selectableSegmentCls`, a visually hidden
radio per row) and one switch, over the stored values of decision 1 of step 5's plan. Its pure model is
`case-list-config/inspector/searchWorkflowModel.ts` (new).

| Element | Text | Writes (`caseSearchConfigPatch`) |
|---|---|---|
| Legend | `When this menu opens` | |
| Choice 1 | `Search first` / `Workers search before they see any cases, and Results shows what the search finds` | `workflow: null` |
| Choice 2 | `Results first` / `Workers see the cases the search finds with its starting values, and can search again to narrow them` | `workflow: "skipToResults"` |
| Choice 3 | `Case list first` / `Workers see their cases and can search from the list` | `workflow: "listFirst", formsReadSearch: null` |
| Switch, under choices 1 and 2 only | `Forms read the search` / `Each form runs the search as it opens, so it can read what was searched for and what was found` | `formsReadSearch: true` / `null` |

- **By declaration.** `Case list first` is disabled with `platformPickerLine(platformRefusal("list-first",
  platforms))` where Web Apps is declared; the switch is disabled with
  `platformPickerLine(platformRefusal("forms-read-search", platforms))` where Android is declared. A
  stored choice shows as it is. Under `Search first` and `Results first` the existing
  `PlatformNoteRow` shows `search-first`'s or `skip-to-results`'s Android note where Android is
  declared.
- **By the gate.** The switch is disabled, not withheld, when the gate would refuse it for another
  reason, with `offeredChoiceRefusal` of the finding the batch meets (part 05's
  `FORMS_READ_SEARCH_REQUIRES_CASE_FIRST_MODULE` and `FORMS_READ_SEARCH_NO_BUTTON_DISPLAY_CONDITION`
  sentences, and part 02's `FORM_LINK_NEEDS_NEW_CASE_DATUM` where forms that read the search would
  keep ordinary a menu a carried create needs advanced). Today's
  toggle is withheld instead; the builder's rule is disabled with a reason, so this is a deliberate
  change.
- **Canvas sentences** (`case-list-config/canvas/SearchCanvas.tsx`, replacing today's nothing-to-fill-in
  sentences): under `Search first` with no visible Search field, `Workers see a Search screen with only
  its Search button. Choose Results first to show the cases as the menu opens.`; under `Results first`
  with none, `There's nothing to fill in. The menu opens on the cases the search finds, and Cases
  available decides what workers see.`; under `Search first` or `Results first`, with a saved Search
  button condition and the switch off, `While this condition is false, the menu opens on its case
  list.` Under part 05's gated run G4 outcome B, the first sentence is `The search runs as the menu
  opens, since there's nothing to fill in.` (written and not yet run).
- **More settings.** With the switch on and no button condition saved, today's sentence becomes `This
  menu's forms read the search, so there is no Search button to show or hide.`
- `data-search-first` on the Search canvas header becomes `data-search-workflow` (its value the
  workflow), and the switch's wrapper carries `data-forms-read-search`.
- The default for a new search is absent (search first) on every declaration (decision 1); enabling
  the Search action with no visible field writes `skipToResults` in the same batch (part 05's planner),
  and the choice shows it.

Rejected: a "What workers see first" segmented row with `Search` / `Results` / `Case list` (part 05's
brief): the legend names the moment the choice governs, and each choice names a first screen in the
words HQ's page and the docs use. The platform labels follow these words: part 05's `skip-to-results`
row takes the label `Results first`, `list-first` `Case list first`, `search-first` `Search first`, and
`forms-read-search` `Forms read the search` (decision R9 of step 5's plan; what other parts read from
this one).

### 3.9 Registration from the case list (pull request 10)

The stored slot moves to the menu (`Module.caseListRegistrationForm`, part 05), and its one arm is the
registration offered after a search finds nothing in a menu whose forms read the search. The two places
that edit it today keep editing it, renamed:

- `case-list-config/canvas/NoMatchesFormSetting.tsx` becomes `CaseListRegistrationSetting.tsx`;
  `case-list-config/noMatchesFormReview.tsx` becomes `caseListRegistrationReview.tsx`, its hook
  `useCaseListRegistration` and its dialog `CaseListRegistrationReviewDialog`, planning through part
  05's `lib/doc/caseListRegistrationForm.ts`. `detail/formSettings/FormEntrySection.tsx` keeps its
  **How this form opens** row and drives the same hook.
- Copy that names Search first now names the switch:

  | Today | From step 5 |
  |---|---|
  | `Offering a form turns Search first on: people search before they …` | `Offering a form turns on Forms read the search: each form in this menu runs the search as it opens.` |
  | review `Search first turns on. People search before they see any …` | `Forms read the search turns on. Each form in this menu runs the search as it opens.` |
  | review `Search first turns off. A menu registration form cannot open …` | `Forms read the search turns off, because a form on the menu can't open from the search.` |
  | `“<form>” was added. Results offers it after a search finds nothing, and the module opens on Search.` | `“<form>” was added. Results offers it after a search finds nothing, and this menu's forms read the search.` |
  | `Results offers “<form>” after a search finds nothing, and the module opens on Search.` | `Results offers “<form>” after a search finds nothing, and this menu's forms read the search.` |

- The setting is disabled with `platformPickerLine(platformRefusal("forms-read-search", platforms))`
  where Android is declared (today `search-first`), and, where the commit verdict refuses it for
  another reason, with `offeredChoiceRefusal` of that finding: forms that read the search keep a menu
  ordinary (part 02's blocker `forms-read-search`), so in a menu a carried create needs advanced the
  finding is part 02's `FORM_LINK_NEEDS_NEW_CASE_DATUM`, naming the link.
- `appTree/FormCard.tsx` keeps marking the form (`data-no-matches-form` becomes
  `data-case-list-registration`).

Rejected: one editing place in module settings (the authoring brief's A9). Both places exist today and
both lead to the same decision with the same review; removing one would remove a valid affordance.

### 3.10 The case list in the menu (pull request 10)

`detail/moduleSettings/CaseListMenuItemSection.tsx` (new) replaces the **Case list link** block of
`ModuleAppearanceSection.tsx`, mounted in `ModuleSettingsPanel` for a module with a case type:

| Element | Text |
|---|---|
| Heading | `Case list in the menu` |
| Switch | `Show the case list in this menu` / `Workers can open the case list on its own, to look up a case without opening a form` |
| Disabled while on, a menu with no forms and no submenus | `This menu has no forms, so the case list is what it opens. Once it has a form, you can turn this off.` |
| Label field (switch on) | label `Menu item label`, placeholder the module's name; an empty field stores no `label` |
| Icon slot (switch on) | `Icon` (`SingleAssetSlot` with `iconLibrary="module"`, as today's case list icon) |
| Spoken label slot (switch on) | `Spoken label` |
| Platform note | `PlatformNoteRow` for `case-list-menu-item` |
| Disabled, a menu a carried create keeps advanced whose list is narrowed | §3.7's line |

The switch and the slots commit through part 05's `setCaseListMenuItem` (`item: {}` on, `null` off, the
whole item with its slots when one changes). `AddModulePopover`'s **Case list** item keeps its birth: a
module with the case list in its menu and no forms (`caseListModuleMutations`, renamed flag). The tree,
the home tile and the breadcrumb collapse a module into its Results screen exactly when
`moduleIsBareCaseList` holds; a module with the item and forms shows its module screen, with the case
list as the separate Results entry a module with children shows today. The module screen in edit mode
(`components/preview/screens/ModuleScreen.tsx`) lists the item after the forms, HQ's order, opening the
case list workspace.

Under the decision 6 run's error outcome, the switch on a module with forms is disabled with that
feature's picker line (written and not yet run).

### 3.11 After submit (pull request 11)

Part 06's D12 is adopted, and the whole surface lands here (decision R12 of step 5's plan): part 06
§12.1 holds its structure (`FallbackChooser.tsx` becoming `OtherwiseChooser.tsx`, `OtherwiseRow.tsx`,
`FormLinkInspectorBody.tsx`'s **Make this the otherwise** and **Make this a destination**, the planners
it reads), and this part holds its words. Pull request 12 adds nothing to it. This part's copy,
applied to `components/builder/form-links/`:

| Element | Outcome A of part 06's G1 (expected) |
|---|---|
| List heading | `After this form, these run in order` |
| Row condition | `Every time` / `When <condition>` |
| Row carrying a case | adds `When the case it carries is on the worker's device` |
| Absent otherwise (`OtherwiseRow`, shown while `otherwiseOffered` or one is stored) | `Otherwise, back to the app home` |
| `OtherwiseRow` subtitle | `When no destination with a condition or a carried case runs. It opens before any destination that runs every time.` (the last sentence only while such a destination exists) |
| `AddLinkControl` choices | `Go somewhere every time`, `Go somewhere when a condition is true`, `Otherwise, go somewhere else` (the last disabled, while nothing might not run, with `Give a destination a condition first, so there is a time when none runs.`) |
| `LinkTargetPicker` | `Start this form again` first; a submenu `menuTargetOffered` rejects is disabled with `CommCare HQ can't link to this submenu from here. You can choose <parent> or a form inside it.` |
| `FormSettingsPanel`'s `AfterSubmitSection` | `Goes to <x>` with no destinations; `Runs <n> destinations in order` or `Opens <x>` for one; `Otherwise <y>` beside it |
| Note row | `PlatformNoteRow` for `after-submit-several-destinations` under the list, in an app that declares Web Apps with two or more destinations |

Any row is draggable anywhere; no cycle disabling; `CarryValuesSection` hides for a menu target. The
copy under outcomes B and C is under written and not yet run. `components/builder/form-links/afterSubmitCopy.ts`,
`linkSentence.ts` and `refusalCopy.ts` lose the `cycle`, `else-exists`, `after-else` and `else-not-last`
sentences with the planner reasons part 06 removes, and gain `target-not-offered` and
`otherwise-unreachable` (`Give a destination a condition first, so there is a time when none runs.`).
Part 06 §12.1's commit reports read, as toasts: `Where this form went after submit is now its
Otherwise.`, `This form's Otherwise is gone, because every destination now runs each time.` and
`This form's Otherwise is now where it goes after submit.`

### 3.12 Show on one screen (pull request 12)

`editor/fieldEditorSchemas.ts`'s group schema gains a UI entry, the `RequiredEditor` switch pattern,
over `fieldList`:

| Element | Text |
|---|---|
| Label | `Show on one screen` |
| Line | `On Android, these questions show together on one screen.` |
| Platform note | `PlatformNoteRow` for `question-pages` (Web Apps shows the whole form on one page) |
| Disabled, the group holds a repeat whose rows workers add at any depth | `This group holds a repeat whose rows workers add, which can't share a screen with other questions.` |

On is one `updateField` with `fieldList: true`; off, `fieldList: null`. The canvas's drag and the
insertion menu already ask `fieldPlacementVerdict`, which part 04 gives the field-list arm and its
sentence in pull request 9, so a worker-added repeat dragged or inserted into such a group is refused
there from pull request 9; the switch is the new gesture. The disabled reason and the gate's
`FIELD_LIST_USER_REPEAT` describe one state, so the switch never invites a refusal. Under part 04's
gated run G3 outcome C2 the switch gains a second disabled reason for an unlabelled group (written and
not yet run).

### 3.13 Format text (pull request 12)

Per decision 2 of step 5's plan, the toggle exists on question, group, repeat and section labels and on
inline choices only; hints, help and validation messages carry no flag and keep their formatting.

- **Labels.** `components/preview/form/InlineTextEditor.tsx`'s label toolbar gains a toggle button
  (`aria-pressed`, tooltip `Format text`), first in the toolbar. Off, the editor holds the same stored
  characters with no Markdown parsing or serializing: a label that holds `**bold**` shows `**bold**`;
  the formatting buttons are disabled with the tooltip `Available with Format text on`; the reference
  picker still works, since a plain label still shows answers.
- **Choices.** `editor/fields/OptionsEditor.tsx`'s row overflow gains `Format text` with a check.
- **Turning it off on a text that holds formatting** asks inline, under the editor: `This text uses
  formatting. With Format text off, workers see its symbols as you typed them.` with `Turn it off` and
  `Keep formatting`. A text that holds none turns off at once.
- **The off line,** under the editor, from the declared platforms (the builder shows only the declared
  platforms' clauses, step 4's rule):

  | Text | Line |
  |---|---|
  | a label, any declaration | `Workers see this text as you typed it, without formatting.` |
  | a choice, Web Apps and Android | `On Android, workers see this choice as you typed it. Web Apps formats every choice.` |
  | a choice, Android only | `Workers see this choice as you typed it, without formatting.` |
  | a choice, Web Apps only | `Web Apps formats every choice, so workers see its formatting either way.` |

  Under part 08's gated run G5 outcome B (part 04's G3 outcome B) the label line changes, and under
  part 04's G3 outcome C1 the toggle leaves the kind the save breaks (written and not yet run).
- **Writes.** One `updateField` with `plainLabel: true` / `null` for a label; for a choice, the options
  replacement today's option edits commit, with the choice's `plainLabel`. One undo step each. The
  translation editor shows the source text's state read-only (`Formatting follows the source text`),
  since one flag serves every language.
- **Default.** On for every existing and every new text, as Nova's wording is Markdown today and the
  cutover keeps every existing text formatted.

Rejected: deciding the state from the text (the form builder's `src/javaRosa/util.js::looksLikeMarkdown`
decides only whether its editor shows a preview); a flag per language (one per text is what HQ's form
builder keeps).

### 3.14 The repeat's Rows editor (pull request 12)

`editor/fieldEditorSchemas.ts`'s repeat schema gains a data entry `{ key: "repeat_mode", component:
RepeatRowsEditor, label: "Rows" }` (`editor/fields/RepeatRowsEditor.tsx`, new, the custom-component
pattern `HiddenValueEditor` uses). Its pure model `editor/fields/repeatRowsModel.ts` builds every write
as one `updateField(uuid, { repeat_mode, … })` with only the new mode's slot (`repeat_count` or
`data_source`); the reducer drops the previous mode's slot, as it does for the tools today.

| Element | Text |
|---|---|
| Mode segments | `Workers add rows` / `A set number of rows` / `One row per case found` |
| `Workers add rows` disabled, inside a section or a group shown on one screen | the `fieldPlacementVerdict` sentence for that place |
| Seed on choosing `A set number of rows` | `repeat_count` = `1` |
| Seed on choosing `One row per case found` | `ids_query` = the open cases of the menu's case type, `instance('casedb')/casedb/case[@case_type = '<type>'][@status = 'open']/@case_id`, built as a tree; disabled with `This menu has no case type, so there are no cases to find. You can give it one in module settings.` when it has none |
| Count editor | label `How many rows`, the form-logic XPath editor over slot `repeat_count` |
| Count refusal | the checker's `whole-number-count` finding, part 04's message, as the editor's lint |
| Count fix | lint action `Use a whole number`: replaces the count with `int(<count>)` built as a call node around the stored tree and printed, never a text edit |
| Count line | `Raising the number adds rows; lowering it keeps the rows already made, with their answers.` |
| Query editor | label `Cases to show`, over slot `ids_query` |
| Placement line, rows set when the form opens | `Rows are set when the form opens and don't change while it's filled in.` |
| Placement line, rows that follow the query | `Rows follow the cases found as answers change. Each row keeps its place, so its answers stay with that place when the cases found change.` |
| Why they follow (second line, the first need) | `Because its query reads an answer.` / `Because it sits inside another repeat.` / `Because a group around it shows on a condition that can change while the form is filled in.` |
| Held | the line, then ` · Kept where your published app has it` |
| Rows past the end (part 04's G2 outcome A) | `A row past the end of the cases found is hidden and saves nothing, and its answers come back if the cases found grow back to it.` |

The placement line reads `effectiveQueryRepeatPlacement` and `queryRepeatPlacementNeeds` (part 04). An
edit of the query or of an ancestor's condition that moves a held placement is an identity move (§2).
A mode change is an ordinary undoable edit; the authoring brief's inline confirm about Preview's
answers is dropped, because Preview's open form is session state the edit does not reach.

### 3.15 Offering parity

`lib/doc/__tests__/platformOfferParity.test.ts` gains, in pull request 10, the sites whose batch a
declaration can refuse: each of the three workflow choices and the switch (features `list-first`,
`search-first`, `skip-to-results`, `forms-read-search`), the case list registration offer
(`forms-read-search`), and the case list menu item switch on a module with forms (`case-list-menu-item`,
or the decision 6 run's beside-forms feature). For each declaration and each site, over a minimal
document from `lib/__tests__/docHelpers.ts::buildDoc`: `platformRefusal(feature, declaredPlatforms(doc))
!== undefined` if and only if `mutationCommitVerdict` refuses the site's batch, and where a refusal is
defined its `platformPickerLine` is the row's two sentences. In pull request 11 it gains the after-submit
note row's feature only if a later run makes it refusable; part 06's row reads `different`, so it is
not a site.

## 4. The Solutions Architect and MCP

### 4.1 Today

- Every shared tool keeps one input schema for the SA and MCP (`lib/agent/sharedToolRegistry.ts`,
  `lib/mcp/adapters/sharedToolAdapter.ts::registerSharedTool`). Field tools speak the domain's key names
  where one exists (`lib/agent/toolSchemaGenerator.ts`, "Vocabulary"), and translate only the `repeat`
  config into `repeat_mode` / `repeat_count` / `data_source`.
- `addFields` / `editField` carry `caseWrite: { caseType, property, mode? }` with `gateCaseWriteMode`,
  and `FIELD_DOCS.caseWrite` says `Capture fields save URLs with mode url; other fields omit mode.`
- The case operation tools say "advanced": `Add one or more complete advanced case operations to a
  form. …`, `Replace one advanced record operation, …`, `Read a form's advanced record operations in
  execution order and the writes derived from its answers.`, `Remove an advanced record operation. …`,
  `Reorder an advanced record operation. …`.
- `updateForm.close_condition` is the structured `{ fieldUuid, answer, operator }`; `createForm` and
  `updateForm` carry `entry: { kind: "search-no-matches", label? }`
  (`lib/agent/tools/shared/formEntry.ts`); `createModule` carries `case_list_only`;
  `configureCaseList` and `setCaseSearchAdvanced` carry `searchFirst: true | null`
  (`lib/agent/tools/case-search-config/shared.ts::ADVANCED_SLOT_NAMES` is `["excludedOwnerIds",
  "searchFirst"]`).
- The form link tools say the first matching condition wins and an unconditional route must be last.
- `lib/agent/summarizeBlueprint.ts` prints `close_condition: <field> <op> "<answer>"`, `[case list
  only]`, and the no-matches entry.

### 4.2 Tool by tool

Each description below is final for the pull request named; a later pull request that changes it again
says so. Tool-level descriptions are quoted exactly; `FIELD_DOCS` entries are in
`lib/agent/toolSchemaGenerator.ts`. Messages a refinement or a planner returns are execution, not
schema, and move no version.

#### Field tools: `addFields`, `editField`, `setFieldOptionsSource`

**Pull request 2.**

- `caseWriteToolSchema` loses `mode`: it is the domain `caseWriteSchema` as pull request 2 leaves it,
  `{ caseType, property }`. `gateCaseWriteMode` and its two calls are deleted; the capture exemption in
  the label floor stays (a capture inherits no label from its destination).
- `FIELD_DOCS.caseWrite`: `Save this answer to a record property. The module's type writes its primary
  record; another type creates a child. Child creation needs a name writer. A capture saves a link to
  its file. Use recordName for the primary record's name.`

**Pull request 3.** Part 04 §8.4 owns this text (its repeats); quoted here so pull request 13 does not
rewrite it.

- `FIELD_DOCS.repeat_mode`: `Worker-added rows, a number of rows from a whole-number question or
  expression, or one row per case a query finds. Counts grow live during entry; lowering a count keeps
  created rows, answers and case operations. A query's rows are set when the form opens where it reads
  no answer, sits in no other repeat and no group around it shows on a condition that can change
  during entry; otherwise its rows follow the query as answers change, each row keeping its place.`
- `FIELD_DOCS.repeat_count`: `Row count for a count-bound repeat: a whole number, from an integer
  question, a single choice whose values are whole numbers, a hidden value calculated as a whole
  number, or a formula such as int(#form/size div 2).`
- The `count_bound` arm: `The count must be a whole number: an integer question, a single choice whose
  values are whole numbers, a hidden value whose calculation is a whole number, or an expression
  wrapped in int(...). The count is live: raising it adds rows; lowering it keeps the rows already
  made, with their answers and case operations. Use user_controlled for rows the worker adds freely.`
- The `query_bound` arm: `One row per case the query finds; provide ids_query.`
- A refused count returns the gate's `REPEAT_COUNT_TYPE` finding with part 04's message, which names
  the `int(…)` fix; no tool sentence of its own.

**Pull request 5.** `FIELD_DOCS.repeat_mode` appends ` Once published, a query repeat keeps that
choice, and an edit that would change it says so in identityMoves.` (part 04 §8.4 leaves this sentence
to this part).

**Pull request 4.**

- `caseWrite` becomes a tool-owned `fieldCaseWriteInputSchema = z.strictObject({ caseType:
  caseTypeInputSchema, property: propertyInputSchema })` in `lib/agent/toolSchemaGenerator.ts` (the
  domain schema leaves with `Field.caseWrite`). Its JSON is the same as pull request 2's, so this alone
  moves no hash.
- `FIELD_DOCS.caseWrite`: `Save this answer to a case property. The module's case type saves it to this
  form's case; a declared child type saves it to a new child case, which needs a question saving its
  case_name; commcare-user saves it to the worker's own record. A capture saves a link to its file. A
  value replaces every place this question saves to, and null stops it saving anywhere; when it saves to
  several places, change them with updateCaseOperation instead. On a follow-up or close form that opens
  one case, a question saving to this form's case is given a default_value reading that case's value,
  which you can replace or remove. Use recordName for the case's name.`
- Execution: `addFields` and `editField` call `planFieldCaseWrite` for each item's `caseWrite`. A
  `caseWrite` on a question whose view holds more than one write returns, without staging:
  `Question “<id>” saves its answer to <n> places, and caseWrite would replace them all with one. You
  can change each with updateCaseOperation/update_case_operation, or set caseWrite to null first to stop
  every one.` A planner refusal returns the planner's sentence.

**Pull request 13.**

- `caseWrite` gains two optional keys, `via` and, under part 01's G5 outcome A, `onlyIfChanged`, over one via schema shared with the case change tools
  (`lib/agent/tools/case-operations/shared.ts::caseWriteViaInputSchema`, exported):

  ```ts
  export const caseWriteViaInputSchema = z
  	.array(z.strictObject({ identifier: linkIdInputSchema, throughCaseType: caseTypeInputSchema.optional() }))
  	.min(1);
  const fieldCaseWriteInputSchema = z.strictObject({
  	caseType: caseTypeInputSchema,
  	property: propertyInputSchema,
  	via: caseWriteViaInputSchema
  		.optional()
  		.describe(
  			'Save to a case above this form\'s case instead, one link identifier per step, such as [{"identifier":"parent"}]; caseType is then the type it reaches. Only on a follow-up or close form.',
  		),
  	onlyIfChanged: z
  		.literal(true)
  		.optional()
  		.describe(
  			"Save only when the worker changed the answer from the case's value. Only on a follow-up or close form, and refused where CommCare HQ keeps the change in Save to Case.",
  		),
  });
  ```

- `FIELD_DOCS.caseWrite` (final): `Save this answer to a case property. The module's case type saves it
  to this form's case, and with via to a case above it; a declared child type saves it to a new child
  case, which needs a question saving its case_name; commcare-user saves it to the worker's own record.
  A capture saves a link to its file. A value replaces every place this question saves to, and null
  stops it saving anywhere; when it saves to several places, change them with updateCaseOperation
  instead. On a follow-up or close form that opens one case, a question saving to this form's case is
  given a default_value reading that case's value, which you can replace or remove. Use recordName for
  the case's name.`
- `field_list` on the add item and the edit patch, `z.boolean().nullable().optional()`, gated to
  `kind === "group"` (a value on another kind: `kind "<kind>" carries no field_list, so leave it
  out.`). `FIELD_DOCS.field_list`: `Groups only. true shows the group's questions together on one
  screen on Android; false shows one per screen. Web Apps shows the whole form on one page either way.
  A new group with a label starts at true unless it holds a repeat whose rows the worker adds, which
  can't share a screen; leave it out to take that. On an edit, null is false.` The flat pipeline
  (`lib/agent/contentProcessing.ts`) maps `field_list: true` to `fieldList: true` and `false` / `null`
  to absence, and part 04's `groupBornFieldList` fills an omitted value on add.
- `plain_label` on the add item and the edit patch, `z.boolean().nullable().optional()`, gated to kinds
  that declare `label` (`kind "hidden" carries no label, so leave plain_label out.`).
  `FIELD_DOCS.plain_label`: `true shows the label exactly as typed, so *, #, numbered lines and links
  stay as written instead of formatting. Labels are formatted as Markdown by default; false or null
  returns the label to Markdown. Hints, help and validation messages are always Markdown.` The pipeline
  maps `true` to `plainLabel: true` and `false` / `null` to absence.
- `projectedSelectOptionSchema` gains `plain_label: z.boolean().optional().describe("true shows this
  choice exactly as typed on Android, without Markdown formatting. Web Apps formats every choice either
  way.")`. It is shared by `addFields`, `editField` and `setFieldOptionsSource`, so all three schemas
  move.
- Both new keys are domain-named in snake case because decision 2 of step 5's plan fixes `plain_label`,
  and `field_list` follows it; the authoring brief's `fieldList` and `plainText` object are not used.

#### Case change tools

**Pull request 4.**

- `addCaseOperations` description: `Add one or more complete case changes to a form, in the order they
  run after its own case's change. This form's own case is always its first change and comes with the
  form's type: save answers to it with a question's caseWrite, or edit it with updateCaseOperation.
  Never add a create for this form's own case.`
- `updateCaseOperation` description: `Replace one case change, keeping its identity, including this
  form's own case. Read it with getCaseOperations before editing.` Its `operation` becomes a union over
  `action` of today's three arms and the own arm:

  ```ts
  const ownOperationInputSchema = z
  	.strictObject({
  		action: z.literal("own"),
  		name: valueSchema.optional(),
  		owner: valueSchema.optional(),
  		writes: z.array(writeInputSchema).optional(),
  		links: z.array(linkInputSchema).optional(),
  	})
  	.describe(
  		"This form's own case: what the form's type creates, updates or closes. Its case type is the menu's, and its open and close conditions are updateForm's. name is required on a registration.",
  	);
  ```

  `addCaseOperations` keeps the three arms; an `own` arm there is refused by the strict union.
- `getCaseOperations` description: `Read a form's case changes in the order they run, this form's own
  case first, each with where CommCare HQ keeps it.` Its result lists the own arm first and gives each
  change `placement: "case management" | "save to case"` (the read words of `PlacementLabel`; `"case
  actions"` joins in pull request 7), and, from pull request 5, `placementKept: true` when held; an own close with its
  own block adds `ownClose: { placement, placementKept? }`.
- `removeCaseOperation` description: `Remove a case change. Refuses this form's own case and any change
  another depends on.` Refusal for the own arm: `This form's own case is always its first change, and
  it goes only with the form's type.`
- `moveCaseOperation` description: `Reorder a case change. This form's own case stays first, and a
  change stays after every change it depends on.` Refusal: the same sentence.

**Pull request 7.** No input changes: step 5 stores no case selection, so no target arm names one
(decision R4 of step 5's plan). `getCaseOperations`' `placement` gains `"case actions"`. Under part
02's gated run G6 outcome B, `addCaseOperations`' description appends a sentence (written and not yet
run).

**Pull request 13.**

- The existing-target union gains `z.strictObject({ kind: z.literal("worker-record") }).describe("The
  worker's own record, for an update of commcare-user only. It takes no condition, links, owner,
  rename, retype or forEach.")`.
- The own arm's writes (`ownOperationInputSchema.writes`, `updateCaseOperation` only) take
  `ownWriteInputSchema = writeInputSchema.extend({ … })`, gaining `via` (`caseWriteViaInputSchema.optional()`,
  described `Save to a case above this form's case instead, one link identifier per step, parent or
  host, such as [{"identifier":"parent"}]. Only on a follow-up or close form.`) and, under part 01's G5
  outcome A, `onlyIfChanged: z.literal(true).optional()` (`true saves only when the worker changed the answer from the case's
  value. Only on a follow-up or close form, and refused where CommCare HQ keeps this form's case
  change in Save to Case.`). The duplicate refinement keys a write by `(via, property)`:
  `"<property>" is saved twice to the same case in this change.` The other arms' writes keep
  `writeInputSchema`, so a `via` or `onlyIfChanged` there is refused by the strict schema: part 01
  admits both on the own arm only (decision R9), and saving to a case above another case is its own
  update of that case.
- Descriptions unchanged.

#### Form tools: `createForm`, `updateForm`

**Pull request 4.** `updateForm.close_condition` becomes `formLogicSchema.nullable().optional()`,
described `Close forms: the case closes only when this holds, and null closes it on every submission.
Read form answers as any form expression does, such as #form/outcome = 'complete'. Leave it out to keep
the current condition.` The structured `closeConditionInputSchema` is deleted; the execution's field
lookup goes with it, since the checker reports an unknown question.

**Pull request 10.**

- `entry` leaves both tools; `lib/agent/tools/shared/formEntry.ts` becomes
  `lib/agent/tools/shared/caseListRegistration.ts`:

  ```ts
  export const caseListRegistrationInputSchema = z.strictObject({
  	label: z
  		.string()
  		.min(1)
  		.nullable()
  		.optional()
  		.describe('The button\'s text on the results, such as "Register a new patient"; null or omitted uses the form name.'),
  });
  export const CASE_LIST_REGISTRATION_DESCRIPTION =
  	"Makes this registration form its menu's registration from the case list: the results offer it after a search finds nothing, and it is on no menu. This turns on formsReadSearch for the menu, so the form's fields can read #search/<name>. After submit it returns to the results, or to the first menu when post_submit is firstMenu, which a menu choosing several cases requires. It takes no links, otherwise, display condition or hiddenFromMenu.";
  ```

  `createForm.case_list_registration`: `caseListRegistrationInputSchema.optional()`, described by the
  constant. `updateForm.case_list_registration`: `.nullable().optional()`, described by the constant
  followed by `null makes it a menu form again, turns formsReadSearch off and removes Search-based
  starting values; leave it out to keep it.` Execution calls part 05's renamed planners.
- `updateForm` description: `Edit a form's name, purpose, record naming rule, close condition, Connect
  settings, after-submit navigation, or whether it is its menu's registration from the case list.`
- `post_submit` (both tools) replaces the sentences that name today's concepts: "it opens on Search"
  becomes "its forms read the search", and the `entry` sentence becomes `A form that is its menu's
  registration from the case list returns to the results after submit, or goes to "firstMenu" when that
  is set, which a menu choosing several cases requires.`

**Pull request 11.** `post_submit` loses its last sentence (`With conditional after-submit links and
no otherwise link this is where the form goes when none match, and it must be explicit.`) and gains `A
form with after-submit destinations takes no post_submit; set where it goes when none runs with
setFormOtherwise/set_form_otherwise.` A `post_submit` on a form with links is refused with part 06's
validator message `POST_SUBMIT_BESIDE_FORM_LINKS`.

**Pull request 13.**

- `updateForm.open_condition`: `formLogicSchema.nullable().optional()`, described `Registration forms
  only. The case is created only when this holds; null creates it on every submission. Read form answers
  as any form expression does. Leave it out to keep the current condition.`
- `updateForm.close_condition` (final): `Registration and close forms. On a registration, the case it
  creates also closes when this holds, and true() closes it on every submission; null keeps it open. On
  a close form, the case closes only when this holds, and null closes it on every submission. Read form
  answers as any form expression does. Leave it out to keep the current condition.`
- `updateForm` description: `Edit a form's name, purpose, record naming rule, open and close conditions,
  Connect settings, after-submit navigation, or whether it is its menu's registration from the case
  list.`
- `createForm` description: `Create a form. Add its questions separately, then set its naming rule and
  its open and close conditions.`

#### Module tools: `createModule`, `updateModule`

**Pull request 10.**

```ts
export const caseListMenuItemInputSchema = z.strictObject({
	label: z
		.string()
		.min(1)
		.nullable()
		.optional()
		.describe("The menu item's text; null or omitted uses the module's name."),
});
```

- `createModule.case_list_menu_item` replaces `case_list_only`: `caseListMenuItemInputSchema.optional()`,
  described `Shows the case list as its own item in this menu, so workers can look up a case without
  opening a form. Needs case_type. A module created without forms needs it.` The refusal without a case
  type keeps today's words with the new name.
- `createModule` description: `Create a module. Add its forms separately; record modules start with a
  Name column, and one created without forms shows its case list as its menu item.`
- `updateModule.case_list_menu_item`: `.nullable().optional()`, described `Shows the case list as its
  own item in this menu, beside its forms or alone. Needs a case type. null removes it, which a menu with
  no forms refuses. Leave it out to keep it.` Execution commits part 05's `setCaseListMenuItem`.
- `updateModule` description: `Update a module's name, case type, parent-record selection, visibility,
  or whether its menu shows the case list as its own item.`
- No tool sets the menu item's icon or spoken label, as no tool sets today's case list link media;
  `setMenuMedia` keeps its two targets.

#### Search tools: `configureCaseList`, `setCaseSearchAdvanced`

**Pull request 10.** `ADVANCED_SLOT_NAMES` becomes `["excludedOwnerIds", "searchWorkflow",
"formsReadSearch"]`. In `setCaseSearchAdvancedBodySchema`, `searchFirst` is replaced by:

```ts
searchWorkflow: z
	.enum(["listFirst", "searchFirst", "skipToResults"])
	.describe(
		"What the menu opens on. searchFirst opens on Search in Web Apps, and Results then show what the search finds; Android opens the case list first, with Search from it. skipToResults opens on the cases the search finds with the Search fields' starting values, which workers can search again to narrow, in Web Apps; Android opens the case list first. listFirst opens on the case list with Search from it, and only an app that runs only on Android can use it. Under searchFirst, a search with nothing to fill in shows a Search screen holding only its button.",
	),
formsReadSearch: z
	.literal(true)
	.nullable()
	.describe(
		"true runs the search as each form in the menu opens, so the forms can read #search/<name> and what the search found, and a case the worker found is claimed when a form is chosen. Only with searchFirst or skipToResults, in a menu whose forms all work on an existing case, or a case list with no forms; it refuses a Search button display condition and previous after submit, and runs only in Web Apps. null turns it off.",
	),
```

`searchWorkflow` is required and not nullable, like every slot of this wholesale tool, and `searchFirst`
is its one spelling of search first; execution writes `workflow: null` for it. A departure from part
05's brief, which makes it nullable: a null there would be a second spelling of `searchFirst`.

`configureCaseList` replaces `searchFirst` with `searchWorkflow: <the enum>.optional()` (`Same as
setCaseSearchAdvanced.searchWorkflow; omission keeps it.`) and `formsReadSearch: z.literal(true).nullable().optional()`
(`Same as setCaseSearchAdvanced.formsReadSearch; omission keeps it.`).

`setCaseSearchAdvanced` description: `Set the excluded-owner rule, what the menu opens on, and whether
its forms read the search. The owner rule can use fixed owners, worker values and Search answers before
record selection.` `configureCaseList`'s description is unchanged.

Under part 05's gated run G4 outcome B, the last sentence of `searchWorkflow`'s description becomes
`Under searchFirst, a search with nothing to fill in runs as the menu opens.` (written and not yet run).

#### Form link tools (pull request 11)

Part 06's D12 is adopted, and these land in pull request 11 as surfaces the model change forces, with
part 06 §12.2's input shapes and this part's words (decision R12 of step 5's plan); the descriptions
under its gated run G1's outcome A, final:

- `addFormLinks`: `` `Add after-submit destinations. Every destination whose condition holds runs, in
  the order you set: the first opens after the form, and each next one when the worker finishes the one
  before. In Web Apps only the first that holds opens. Conditions read saved records and worker values
  after the form closes, so they cannot use unsaved answers. Set where the worker goes when no
  destination with a condition or a carried case runs with setFormOtherwise/set_form_otherwise.
  ${HIDDEN_TARGET_NOTE}` ``; its `links` array: `Destinations
  in the order they run.`; its `afterLinkUuid`: `UUID of the existing destination the new ones should
  follow, null to put them first, or omit to add them at the end.`
- `updateFormLink`: `` `Replace one after-submit destination, keeping its place in the order.
  ${HIDDEN_TARGET_NOTE}` ``.
- `moveFormLink`: `Reorder an after-submit destination. Destinations run in this order, and any order is
  admitted.`; its `afterLinkUuid`: `UUID of the destination this one should follow, or null to put it
  first.`
- `removeFormLink`: `Remove an after-submit destination. Removing the last one makes the form's
  otherwise its after-submit destination; removing the last one with a condition or a carried case
  removes the otherwise.`
- The shared link input (`lib/agent/tools/form-links/shared.ts`): `condition`: `Session-scope XPath;
  when it holds, this destination runs. Null or omitted runs it every time. It runs after the form has
  closed, so it reads case-ref, #user and session values, never form answers: save the answer to a case
  property first.`; `target` gains `z.strictObject({ type: z.literal("this-form") })` and reads
  `{"type":"form","moduleUuid","formUuid"} opens that form; {"type":"module","moduleUuid"} opens that
  module's list; {"type":"this-form"} starts this form again. A submenu is a target only from a submenu
  whose parent has the same case type as its parent.`; `datums`: `Explicit session values carried into
  the target. Only for a form or this-form. Omit or null to let CommCare match the target's case from
  this form's session. When present, name every selection datum the target needs; a partial list is
  refused. The destination runs only when the worker's device holds a case of its type with each carried
  id.`
- New shared tool `setFormOtherwise` / `set_form_otherwise` (`lib/agent/tools/form-links/setFormOtherwise.ts`),
  registered in `lib/agent/sharedToolRegistry.ts` with the scope `updateFormLink` declares, presented in
  `lib/agent/toolPresentation.ts` as a change labelled `Set where the form goes otherwise` and in
  `lib/chat/toolSummary.ts` with the same words; its input is part 06 §12.2's shape:

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

  Description: `Set where the worker goes after this form when none of its destinations with a
  condition or a carried case runs. It opens before any destination that runs every time. Offered only
  while some destination might not run, because it has a condition or carries values; null goes to the
  app home.` Execution plans through part 06's `planSetOtherwise` and returns its refusals, worded by
  part 06's `linkRefusalMessage`.

The outcome B and C variants of each sentence are under written and not yet run.

#### Every mutating tool (pull request 5)

The result gains `identityMoves` (§2.7). No description changes.

### 4.3 Reads and the snapshot

Read results move no version (`lib/agent/CLAUDE.md`, "Provider contract"); each lands with the model it
reads.

| Read | Change | Pull request |
|---|---|---|
| `getField` | `caseWrites: [{ caseType, property, via?, onlyIfChanged?, link?, operationUuid }]` replaces `caseWrite` | 4 |
| `getField` | on a query repeat, `rows: "set-when-opened" \| "follow-query"` and `rowsKept: true` when held | 3, `rowsKept` 5 |
| `getField` | `fieldList: true` on a group, `plainLabel: true` on a label and on each choice that has it | 9 |
| `getForm` | `closeCondition` as authored text; `openCondition` | 4 |
| `getForm` | `otherwise`; links listed as `destinations`, "in the order they run" | 11 |
| `getModule` | per form `opensFromCaseList: boolean` replaces `entry`; `searchWorkflow`, `formsReadSearch`, `caseListMenuItem: { label } \| null`, `caseListRegistrationForm: { formUuid, label } \| null` replace `caseListOnly` and `searchFirst` | 10 |
| `getModule` | `advanced: { kept: boolean } \| null`, from part 02's `emittedModuleKind` and `heldKind`; no case selection is stored, so no read lists one | 7 |
| `getCaseOperations` | §4.2 | 4, 5, 7 |

`lib/agent/summarizeBlueprint.ts` (the volatile snapshot):

| Today | From step 5 | Pull request |
|---|---|---|
| `close_condition: <field> <op> "<answer>"` | `close when: <printed condition>` and, on a registration, `open when: <printed condition>` | 4 |
| none | each form whose own case is held: `own case kept in <placement words>` | 5 |
| none | an advanced menu: `[advanced]`, or `[advanced, kept]` when held | 7 |
| `[case list only]` | `[case list in menu]` | 10 |
| the no-matches entry line | on the menu: `case list registration: <form> ("<label>")` | 10 |
| `searchFirst` in the case search line | `workflow=<searchFirst \| skipToResults \| listFirst>`, then `forms read it` when on | 10 |
| link lines | `destinations: <a>, <b>; otherwise: <c>` | 11 |
| none | a group `[one screen]`; a plain label `[plain]` | 9 |
| none | a query repeat `[rows set when opened]` or `[rows follow query]`, with `, kept` when held | 3, 5 |

### 4.4 MCP-only tools

Part 03 owns their shapes and copy; this part records what changes so the plugin sweep (§6) and the
served-schema check (§4.9) see it. None moves `MODEL_CONTEXT_VERSION`.

| Tool | Change | Pull request |
|---|---|---|
| `check_project_space_compatibility` | the `Attachments saved to cases` capability goes | 2 |
| `check_project_space_compatibility` | the capability `Save only answers that changed` | 4 |
| `upload_app_to_hq` | `accept_placement_moves`; the refusal's `placement_moves` and every answer's `placements: { recorded, moved }`; the error types `app_changed_while_publishing` and `hq_placement_moves_changed`; part 03's description sentences | 6 |
| `check_project_space_compatibility` | `placement_moves` beside the Save to Case check | 6 |
| `upload_app_to_hq` | `confirm_commtrack_off` | 8 |
| `withdraw_deployment_confirmation` | `kind` gains `commtrack-off` | 8 |
| `check_project_space_compatibility` | `commtrack_off`, and the `same-type-child-links` capability | 8 |

### 4.5 The guide, verbatim

Each change below replaces the exact text it names in `lib/agent/authoring/reference.ts`'s
`AUTHORING_REFERENCE`; every other sentence is unchanged. Source text is one line; it is wrapped here.

**Pull request 3.** Part 04 §8.4 owns the repeat description's text; quoted here.

- `fields()`, the `repeat` description: `"count_bound" with count for an integer question or numeric
  expression` becomes `"count_bound" with count for a whole number`; and `A direct count needs an
  integer question; convert other sources explicitly. Query record IDs outside another repeat are
  captured when the form opens; nested query repeats capture theirs when the enclosing row is created.`
  becomes:

  > A count must be a whole number: an integer question, a single choice whose values are whole
  > numbers, a hidden value whose calculation is a whole number, or an expression wrapped in int(...).
  > A query repeat's rows are set when the form opens where its query reads no answer, it sits in no
  > other repeat and no group around it shows on a condition that can change during entry; otherwise
  > its rows follow the query as answers change, and a row keeps its place, so its answers stay with
  > that place when the result changes. A row past the end of the current result is hidden and writes
  > no case.

  (The variants of part 04's gated run G2 are under written and not yet run.)
- `expressions`: `Query-bound repeats use a query's /@case_id nodes as ids_query. The fields guide
  explains their retained row identity and initialization timing.` becomes `Query-bound repeats use a
  query's /@case_id nodes as ids_query; the fields guide explains when their rows are set and how each
  row keeps its place.`

**Pull request 4.**

- `workflows`, first paragraph: from `Registration creates a record;` to `on other records.` becomes:

  > A form's type is its own case's lifecycle: registration creates it, follow-up changes a selected
  > record, and close updates and closes it. A survey collects information without selecting a record.
  > Set recordName to an answer or expression for the case's name; a close form closes its case only
  > when its close_condition holds. New record modules declare their type and default to a Name column.
  > A question's caseWrite saves its answer to this form's case, a new child case or the worker's
  > record. Case operations describe every other case a form creates, updates or closes, in the order
  > they run; getCaseOperations lists this form's own case first, and updateCaseOperation edits it.

- `workflows`, the child paragraph: `use a parent follow-up form with caseWrite destinations on the
  direct child type` becomes `use a parent follow-up form whose questions save to the child type with
  caseWrite`, and `use explicit operations targeting` becomes `use explicit case operations targeting`.
- `forms`, the creation paragraph: `Set recordName and answer-dependent closing conditions after the
  referenced questions exist.` becomes `Set recordName and close_condition after the questions they read
  exist.`
- `forms`, the writers paragraph: `Writers for a single selected record start with its saved value, even
  when that value is blank; this overrides an explicit starting value. Scoped question reads report that
  effective source. Capture questions start with a new capture, not the old attachment.` becomes:

  > On a follow-up or close form that opens one case, a question that saves to that case starts with the
  > case's saved value, because caseWrite gives it a default_value reading #case/<property>; replace or
  > remove that default to start it elsewhere or blank. A later starting value that reads such a question
  > reads the case's value. Scoped question reads report each starting value. Capture questions start
  > with a new capture and save a link to the file.

- `expressions`: `Search rules and advanced operation values also support` becomes `Search rules and case
  operation values also support`.

**Pull request 5.**

- `workflows`, a new last paragraph:

  > Some edits change where CommCare HQ keeps a published app's answers: a case change kept in a new
  > place, or a query repeat whose rows start following its query. A result lists each such move in
  > identityMoves with a sentence; tell the person before you save the work, because CommCare HQ's
  > exports show those answers under new columns after the next publish. saveWork lists them again.

- `fields()`, the `repeat` description: after `A row past the end of the current result is hidden and
  writes no case.` insert ` Once published, a query repeat keeps that choice, and an edit that would
  change it says so in identityMoves.` (the sentence part 04 §8.4 leaves to this pull request).

**Pull request 7.** The identity paragraph's `or a query repeat whose rows start following its query`
becomes `a query repeat whose rows start following its query, or a menu becoming advanced or ordinary`.

**Pull request 10.**

- `workflows`, the search paragraph: from `Search-first workflows begin with Search.` to `…
  [not(commcare_is_related_case = true())]).` becomes (each `${…}` a generated sentence placed right after
  the sentence that introduces its feature, step 4's rule):

  > A menu with Search opens on its workflow: searchFirst opens on Search, and Results then show what the
  > search finds; skipToResults opens on the cases the search finds with the Search fields' starting
  > values, which workers can search again to narrow; listFirst opens on the case list, with Search from
  > it. ${platformSentence("search-first")} ${platformSentence("skip-to-results")}
  > ${platformSentence("list-first")} formsReadSearch runs the search as each form in the menu opens, so
  > its forms read what was searched for and what was found. ${platformSentence("forms-read-search")} A
  > menu whose forms read the search can offer a registration form after a search finds nothing, made
  > with case_list_registration, and that form can use the Search answers as starting values. Use that
  > only when a match truly rules out a new record. Names are not unique identities; keep ordinary
  > registration reachable when different people or items can match the same search. A form opened on an
  > existing record does not inherit Search answers. A form in a menu whose forms read the search can
  > count what it found with count(instance('results:inline')/results/case[not(commcare_is_related_case
  > = true())]).

- The same paragraph, after `…and supporting context in Details.`, appends: `case_list_menu_item shows a
  menu's case list as its own item, beside its forms or alone. ${platformSentence("case-list-menu-item")}`
  (and, under the decision 6 run's outcome B or C with its own feature,
  `${platformSentence("case-list-entry-beside-forms")}` after it).
- `forms`, the creation paragraph: `For a registration offered when Search finds no matches, set entry
  to search-no-matches, then add fields whose default_value reads #search/<prompt name>.` becomes `For a
  registration offered when Search finds nothing, create it with case_list_registration, then add fields
  whose default_value reads #search/<prompt name>.`
- `expressions`: `#search/name reads a Search answer in Search rules, in the forms of a menu that opens
  on its search, and in that module's no-matches registration.` becomes `#search/name reads a Search
  answer in Search rules, in the forms of a menu whose forms read the search, and in that menu's
  registration from the case list.`; and `which in a menu that opens on Search happens when a form is
  chosen` becomes `which in a menu whose forms read the search happens when a form is chosen`.

**Pull request 11.** `workflows`, the after-submit paragraph: after `Save a needed answer before using
it in a later route.` insert:

> After a form, every destination whose condition holds runs, in the order you set: the first opens,
> and each next one opens when the worker finishes the one before.
> ${platformSentence("after-submit-several-destinations")} A destination that carries a case runs only
> when the worker's device holds that case, and the this-form target starts the form again.
> setFormOtherwise says where the worker goes when no destination with a condition or a carried case
> runs, and it opens before any destination that runs every time; without one, the worker goes to the
> app home.

**Pull request 13.**

- `workflows`, first paragraph: `; a close form closes its case only when its close_condition holds.`
  becomes `. A registration creates its case only when open_condition holds and closes the case it
  creates when close_condition holds; a close form closes its case only when its close_condition
  holds.`; and `saves its answer to this form's case, a new child case or the worker's record.` becomes
  `saves its answer to this form's case, with via to a case above it, a new child case or the worker's
  record.`
- `workflows`, the child paragraph: `use explicit case operations targeting their retained record IDs.`
  becomes `use explicit case operations targeting their retained record IDs; to save to a parent of the
  selected case, give the write a via.`
- `forms`, the creation paragraph: `Set recordName and close_condition after the questions they read
  exist.` becomes `Set recordName, open_condition and close_condition after the questions they read
  exist.`
- `forms`, first paragraph: after `Form wording is Markdown.` insert ` A label or a choice with
  plain_label shows exactly as typed instead.`

`lib/agent/authoring/__tests__/platformGuide.test.ts` holds each generated sentence right after its
introducing sentence (§9).

### 4.6 `saDocs`

| Kind | Change | Pull request |
|---|---|---|
| `repeat` (`lib/domain/fields/repeat.ts`) | `"count_bound" for a live count from an integer question or expression` becomes `"count_bound" for a live count from a whole-number question or expression`; `query_bound snapshots its query when the enclosing instance initializes; changing dependencies does not rebuild those rows. A new enclosing repeat instance initializes its own query snapshot.` becomes `query_bound rows are set when the form opens or follow the query as answers change; the fields guide says which.` (part 04 §8.4's text) | 3 |
| `group` (`lib/domain/fields/group.ts`) | appends `field_list shows its questions together on one screen on Android; a new group with a label starts with it on, unless it holds a repeat whose rows the worker adds, which can't share a screen.` | 13 |
| the capture kinds | no change: they name no write mode | |

### 4.7 `MODEL_CONTEXT_VERSION`

`lib/models.ts::MODEL_CONTEXT_VERSION` moves in each pull request that changes the name, description or
input schema of a tool the Solutions Architect is offered, or the guide, to
`"v6-hq-round-trip-case-writes.<n>"` (decision 14 of step 5's plan). A prompt change alone moves the
separate `promptVersion` digest, not this; a read result field moves neither.

| Pull request | Why | Value |
|---|---|---|
| 2 | `caseWrite` loses `mode`; `FIELD_DOCS.caseWrite` | `"v6-hq-round-trip-case-writes.2"` |
| 3 | the repeat descriptions, the guide's repeat and query sentences, `repeat` `saDocs` | `"v6-hq-round-trip-case-writes.3"` |
| 4 | `caseWrite`'s description; the case change tools' descriptions and the own arm; `close_condition` as an expression; the guide's case-write sentences | `"v6-hq-round-trip-case-writes.4"` |
| 5 | the guide's identity paragraph and repeat sentence; `FIELD_DOCS.repeat_mode`'s published sentence | `"v6-hq-round-trip-case-writes.5"` |
| 7 | the identity paragraph's menus (and, under part 02's G6 outcome B, `addCaseOperations`' description) | `"v6-hq-round-trip-case-writes.7"` |
| 10 | the search, module and form tools; the guide's search sentences and the generated platform sentences of the changed rows | `"v6-hq-round-trip-case-writes.10"` |
| 11 | the form link tools and `setFormOtherwise`; the guide's after-submit sentences and the new generated sentence | `"v6-hq-round-trip-case-writes.11"` |
| 13 | every new authoring input; the final guide | `"v6-hq-round-trip-case-writes.13"`, the value the stack deploys |

Pull requests 6, 8, 9, 12 and the rest move nothing: 6 and 8 change MCP-only tools, 9 changes only what
a tool does with an input it already takes, and 12 is the builder.

### 4.8 `scripts/test-schema.ts` and the billed run

Every SA tool whose description or projected JSON Schema a pull request first changes is registered by
that pull request (root `CLAUDE.md`). At `main` 55 entries are registered; step 5 adds six.

| Pull request | Entries |
|---|---|
| 4 | new `getCaseOperations`, `removeCaseOperation`, `moveCaseOperation` (descriptions change); `updateCaseOperation`'s prompt becomes `Use updateCaseOperation on the form "Follow-up visit" in the module "Patients" to replace this form's own case change 33333333-3333-4333-8333-333333333333, keeping its writes and adding a write of visits as the authored expression "#case/visits + 1".`; `updateForm`'s becomes `Use updateForm with moduleUuid 11111111-1111-4111-8111-111111111111 and formUuid 22222222-2222-4222-8222-222222222222 to close the case only when #form/outcome = 'done'.` |
| 10 | `configureCaseList`'s prompt adds `, and set searchWorkflow to skipToResults`; `setCaseSearchAdvanced`'s becomes `Use setCaseSearchAdvanced with moduleUuid 11111111-1111-4111-8111-111111111111 to clear the excluded owner ids (null), open the menu on searchFirst, and turn formsReadSearch on.`; `createModule`'s adds `, showing its case list as its menu item labelled "All households"`; `updateModule`'s adds `, and remove its case list menu item (null)`; `createForm`'s becomes `Use createForm with moduleUuid 11111111-1111-4111-8111-111111111111 to add a registration form named "Register patient" as the menu's registration from the case list, with the button text "Register a new patient".` |
| 11 | new `setFormOtherwise` (`Use setFormOtherwise with moduleUuid 11111111-1111-4111-8111-111111111111 and formUuid 22222222-2222-4222-8222-222222222222 so that when no destination runs the worker goes to the module's first screen.`), new `moveFormLink` and `removeFormLink` (descriptions change); `addFormLinks`'s prompt adds `, and a second link with the condition #case/needs_review = 'yes' that starts this form again` |
| 13 | `addFields`'s prompt becomes `Use addFields with moduleUuid 11111111-1111-4111-8111-111111111111 and formUuid 22222222-2222-4222-8222-222222222222 to add a group household with field_list true; inside it a text field head_name saving with caseWrite to the household case property head_name through via [{"identifier":"parent"}] only if changed; a single_select consent whose label has plain_label true, with two choices; and a repeat visits counting int(#form/visit_count) rows.`; `editField`'s adds `, and set plain_label to true`; `addCaseOperations`'s becomes `Use addCaseOperations on the form "Follow-up visit" in the module "Patients" to add an update of the worker's own record (commcare-user) writing last_visit as the authored expression "today()".`; `updateCaseOperation`'s adds `, and a write of visit_date to the parent household case through via [{"identifier":"parent"}] only if changed` (the own arm's writes are where `via` and `onlyIfChanged` live); `updateForm`'s adds `, and create the case only when #form/consent = 'yes'`; `setFieldOptionsSource`'s adds `, with an inline choice whose label shows exactly as typed` (its inline arm's item moved) |

Count at the stack's head: 61.

**The billed run.** `npm run test:schema` sends one live request per schema and spends the person's
money, so it is asked for once, at pull request 13's head, the last change to a tool or the guide in the
stack, and no other pull request runs it (decision R11 of step 5's plan). The ask names every entry any
pull request of the stack added or changed, with its cost, one live request each: from the table above
and §4.2, `addFields`, `editField`, `setFieldOptionsSource`, `addCaseOperations`, `updateCaseOperation`,
`getCaseOperations`, `removeCaseOperation`, `moveCaseOperation`, `createForm`, `updateForm`,
`createModule`, `updateModule`, `configureCaseList`, `setCaseSearchAdvanced`, `addFormLinks`,
`updateFormLink`, `moveFormLink`, `removeFormLink` and the new `setFormOtherwise`. At that head,
`npx tsx --conditions=react-server scripts/inspect-tool-schema-hashes.ts` (free, no network) runs at
`main` `2f985ed6` and at the head; a tool whose hash moved and that the list misses is added to the ask
and named as the difference, so nothing the stack changed reaches the deploy unsent. Each runs as `npm
run test:schema -- <name>` only after the person's yes. Each of pull requests 2, 3, 4, 5, 7, 10, 11 and
13 records the hash rows at its base and head in its description, and runs no billed entry.

### 4.9 Served schemas

`lib/mcp/__tests__/servedSchemas.test.ts` reads every tool `tools/list` serves, compiles each schema with
a validator for its dialect, and compiles every `pattern` with the Rust regex engine, so the new and
changed schemas meet both checks in the pull request that serves them: `set_form_otherwise` (11),
`upload_app_to_hq`'s `accept_placement_moves.digest` pattern `^[0-9a-f]{64}$` (6), and every changed
shared tool. It needs no new assertion.

### 4.10 The MCP prompt

`lib/mcp/prompts.ts::INTERACTIVITY_INSTRUCTIONS.autonomous` appends, in pull request 5, ` When a result
lists identityMoves, include each sentence in your report.` MCP-only prompt text is in no stored model
context, so it moves no version. The in-Nova architect always holds `askQuestions` and follows the
guide's sentence.

## 5. What each pull request changes on the surfaces

| Pull request | Builder | SA and MCP | Guide and version |
|---|---|---|---|
| 2 | §3.2's chooser removed | `caseWrite.mode` and `gateCaseWriteMode` removed; `FIELD_DOCS.caseWrite`; `check_project_space_compatibility` loses a capability | `.2` |
| 3 | nothing (no count editor exists until 12) | repeat descriptions; `getField` `rows` | §4.5 PR 3, `repeat` `saDocs`, `.3` |
| 4 | §3.2 views, §3.3 preload, §3.4 close form, §3.5 own row, §3.6 lines | `caseWrite` description and planner; case change tools; `close_condition` expression; reads; snapshot | §4.5 PR 4, `.4` |
| 5 | §2 dialog, deferral, reviews, history step with the recorded holds; held suffix | workspace hosts, receipts, `saveWork`, autonomous prompt; `repeat_mode`'s published sentence | identity paragraph and repeat sentence, `.5` |
| 6 | §2.6 conflict lead, through this part's `replayAfterPlacementConflict` over part 03's replay | `upload_app_to_hq` and the check (part 03) | none |
| 7 | part 02's planner in the dialog; `FORM_LINK_NEEDS_NEW_CASE_DATUM`'s sentence | `getModule` and `getCaseOperations` reads; snapshot | identity paragraph's menus, `.7` |
| 8 | publish dialog's CommCare Supply row (part 03) | `confirm_commtrack_off`, withdraw kind (part 03) | none |
| 9 | nothing new (the verdict refuses in drag and insertion) | `getField` reads; snapshot | none |
| 10 | §3.8, §3.9, §3.10, §3.7's menu item note, §3.15 | search, module and form tools; `getModule`; snapshot | §4.5 PR 10, `.10` |
| 11 | §3.11, the whole after-submit surface (decision R12) | form link tools, `setFormOtherwise`; `getForm`; snapshot | §4.5 PR 11, `.11` |
| 12 | §3.2 ancestors and Save only if changed, §3.4 registration rows, §3.5 new gestures and rail row, §3.7 settings row, §3.12, §3.13, §3.14 | none | none |
| 13 | none | §4.2 PR 13 | §4.5 PR 13, `group` `saDocs`, `.13` |

## 6. `../nova-plugin`

Swept at `105836d` (v2.3.0, clean) with `rg -i` over `skills`, `agents` and `README.md` for `search
first`, `searchFirst`, `no.matches`, `case list only`, `case_list_only`, `caseWrite`, `saves to`,
`attachment`, `preload`, `first true`, `otherwise`, `form link`, `field.list`, `markdown`, `count`,
`query`, `save to case`, `close.condition`, `recordName`, `registration`, `entry`, `advanced`,
`commtrack`, `supply`, `placement`, `confirm_`, `save_work`, `begin_work` and `project_space_incompatible`.
The build, edit and autobuild skills and `agents/nova-architect-autonomous.md` bootstrap the server's
guidance (`get_agent_prompt`) and teach no field, case-write, search, link or repeat behavior; their
sentences on saving work (`skills/edit/SKILL.md`, "If the saved app changed during your work, inspect
both versions and discuss the conflict"; `skills/build/SKILL.md` and the agent's equivalents) stay true
when a publish's placement record changes the saved app, since that is a saved change like any other.
The `identityMoves` sentence reaches them through the guide. Every sentence step 5 makes false or
incomplete is in `skills/upload_to_hq/SKILL.md` and the README:

1. **The pre-upload check** (the paragraph beginning "Beside `project_space_compatibility`"): the list
   of what the upload will ask gains `commtrack_off` (whether CommCare Supply is turned off, for an app
   with an advanced menu that shows its case list as its own menu item, or a form whose text names the
   session's supply point), and the sentence `When the Save to Case plan feature reads
   needs_confirmation, placement_moves may carry the case changes Nova can keep elsewhere so the app no
   longer needs it; relay them with that plan feature.`
2. **The confirmations on record** ("a plan feature, the flat location list, a Connect forwarder, Sync
   Cases On Form Entry turned off"): gains `CommCare Supply turned off`.
3. **`project_space_incompatible`**: after "Never work around it by changing the app unless the user
   separately asks to change the app itself." add `When the response carries placement_moves, the
   project space drops the link between a new case and the case of the same type it came from, and
   Nova offers to keep those case changes in Save to Case blocks instead. Show each move with its
   change, from and to, and ask whether to move them; only on a yes, retry with
   accept_placement_moves carrying its reason and digest. Moving them changes where CommCare HQ keeps
   those answers in every project space the app is published to, and the plan then needs Save to Case,
   which the next attempt may ask about.`
4. **`hq_confirmation_needed`**: the item list gains `or, for an app with an advanced menu that shows
   its case list as its own menu item or a form whose text names the session's supply point, CommCare
   Supply turned off`; the retry keys gain `confirm_commtrack_off: true`; and a new sentence: `When
   placement_moves comes with the Save to Case plan feature, ask one question with two answers: the
   plan includes Save to Case (confirm it), or move those case changes (accept_placement_moves with its
   reason and digest). Never send both.`
5. **New refusal entries**: `hq_placement_moves_changed` (`the case changes Nova offered to move
   changed since the user agreed. Nothing was sent. Show the new placement_moves and ask again; send
   only the new digest.`) and `app_changed_while_publishing` (`the app kept changing while Nova got it
   ready to publish. Nothing was sent. Upload again once the edits settle.`).
6. **What an upload changes**: after the step 5 paragraph, `The first upload of a case change records
   where CommCare HQ keeps it, which changes the saved app. Work begun with begin_work before the
   upload must be begun again.`
7. **The retry paragraph** ("On every retry, resend every answer …"): the list gains
   `confirm_commtrack_off` and `accept_placement_moves`.
8. **`README.md`**, after the 2.3 paragraph: `Version 2.4's publishing guidance (the CommCare Supply
   confirmation, the case changes an upload offers to move, and an upload recording where CommCare HQ
   keeps case changes) requires the paired Nova server release. Publish this plugin after that server
   is live and verified.`
9. **`.claude-plugin/plugin.json`**: `"version": "2.4.0"`.

Part 03's gated runs reach items 1, 3 and 4: under its supply-text run's outcome B the form clause reads
"a form whose source names the session's supply point in an attribute"; under outcome C it is dropped
(only the advanced menu clause remains). Under its probe run's outcome B (a sixth confirmation kind
instead of a capability), item 3's sentence moves into item 4 and names that confirmation's key. Under
its flag-effect run's outcome B, item 3's sentence is not added.

The plugin pull request is opened when pull request 13 is opened, so it is written against the final
tool text; pull request 15 records its link and repeats this sweep against the guide and tool text the
stack ships. It merges only after the deploy of the stack's merge commit is live (written and not yet
run, G-A2).

## 7. Subtree `CLAUDE.md` sentences and public docs

### 7.1 Subtree `CLAUDE.md` sentences, with the code that makes them true

| File | Sentence | From step 5 | Pull request |
|---|---|---|---|
| `components/builder/CLAUDE.md` | "**What a case-bound field does at form open is ONE predicate, and the rail reads it from where the field lives.** …" | `**A preload is the field's default, and the Saves to row offers it.** On a writer of a one-case loading form's own case, the row says Opens with the case's current value. with Start blank instead, or Starts blank… with Open with the case's current value, each one updateField of default_value (casePreload.ts::fieldPreload, writerOffersPreload).` (the paragraph's context threading stays) | 4 |
| `components/builder/CLAUDE.md` | "**The default-value row on a preloaded writer is read-only, and it offers to clear a dead expression rather than hide it.** …" | removed | 4 |
| `components/builder/CLAUDE.md` | "The field inspector's `CaseWriteEditor` is the field's one binding editor. It chooses or clears one complete `{caseType, property}` destination, …" | `The field inspector's CaseWriteEditor shows the field's view of the form's case writes, one row per write whose value is its answer (fieldCaseWriteViews), and edits each through planFieldCaseWrite: this form's case, a new child case or the worker's record, each offered by caseWriteChoiceVerdict.` (12 adds `a case above it (via)` and Save only if changed) | 4, 12 |
| `components/builder/CLAUDE.md` | the What reaches the case sentences of the same paragraph | removed | 2 |
| `components/builder/CLAUDE.md`, Case changes | "**The list is the screen the platform never had.** …" | adds `**This form's case is the first change.** The own arm is the first row, without a handle; a keyboard move of it or above it is refused with its own sentence.` (12 adds `Each change's rail ends with Where CommCare HQ keeps it, read-only.`) | 4, 12 |
| `components/builder/CLAUDE.md`, Field editor | none | `**Identity moves are stated before they commit.** useBlueprintMutations, its reviews and the history step run withIdentityMoves; a batch that moves where CommCare HQ keeps published answers opens IdentityMoveDialog and commits only on Make the change; an undo or a redo carries only the hold changes the kernel admits, restoring a recorded hold or moving one its content strands (applyHistoryStep over recordedHolds); a publish-placement conflict reopens the dialog with its own lead.` | 5, 6 |
| `components/builder/CLAUDE.md` | "**Search first is a switch in the Search panel's rail, withheld until the gate would admit it.** …" | `**What the menu opens on is one choice in the Search panel's rail.** SearchWorkflowSetting offers Search first, Results first and Case list first, and under the first two Forms read the search, each offered by declaration with platformPickerLine and disabled with the gate's reason, writing caseSearchConfig.workflow and formsReadSearch.` | 10 |
| `components/builder/CLAUDE.md` | "**When no cases match is one decision reachable from two places.** …" | the same paragraph with `CaseListRegistrationSetting`, `caseListRegistrationReview.tsx::useCaseListRegistration`, `lib/doc/caseListRegistrationForm.ts`, and "Forms read the search" for "Search first" | 10 |
| `components/builder/CLAUDE.md` | "The one register-from-case-list shortcut is the no-matches registration form (`Form.entry`, …" | `The one register-from-case-list shortcut is the menu's caseListRegistrationForm, offered on Results after a search finds nothing in a menu whose forms read the search.` | 10 |
| `components/builder/CLAUDE.md` | the `caseListOnly` sentences (the scaffold paragraph, the case-list workspace paragraph, the settings paragraph's **Case list link**) | `caseListMenuItem`; "a module with the case list in its menu and neither forms nor children IS its Results screen; with forms, the module screen holds them and the case list is a separate Results entry"; **Case list in the menu** | 10 |
| `components/builder/CLAUDE.md`, After submit | "**One "otherwise" model.** …" and "**Conditionality is a kind, not a slot.** …" and the cycle refusal | rewritten to part 06's D12 with §3.11's copy | 11 |
| `components/builder/CLAUDE.md`, Field editor | none | `A group's Show on one screen switch writes fieldList; a repeat's Rows editor (RepeatRowsEditor) chooses how rows come, refuses a count that isn't a whole number with Use a whole number, and states a query repeat's placement; Format text on a label or a choice writes plainLabel.` | 12 |
| `components/builder/editor/fieldEditorSchemas.ts` comment | "… reachable only via the SA tool surface" | the repeat's modes are the Rows editor's | 12 |
| `lib/doc/CLAUDE.md` | none | `identityMoves.ts: withIdentityMoves composes the per-subject move planners into one batch and one list of moves; identityMovesBetween compares two documents' holds; documentHoldsIdentity is its memoized guard.` | 5 |
| `lib/doc/CLAUDE.md` | "A case-list module is born as a VIEWER — a `caseListOnly` module …" | `A case-list module is born as a viewer, with the case list in its menu (caseListMenuItem), a Name column …` | 10 |
| `lib/doc/CLAUDE.md` | "`searchNoMatchesDependents.ts` / `searchNoMatchesForm.ts` — the no-matches registration form's planners. …" | `searchReadDependents.ts / caseListRegistrationForm.ts: the planners of the menu's registration from the case list and of what reads its Search answers.` | 10 |
| `lib/routing/CLAUDE.md` | "For a `caseListOnly` module that has neither forms nor child menus, …" | `For a module with the case list in its menu (caseListMenuItem) that has neither forms nor child menus, …` | 10 |
| `lib/collab/CLAUDE.md` | the 409 `commit_rejected` bullet | adds, beside part 03's sentence, `When the 409's reason is placement-recorded, the rejected edits are handed to the builder after the reload, which offers them again, re-planned, in IdentityMoveDialog.` | 6 |
| `lib/agent/CLAUDE.md` | "… case-list selection and search, no-matches registration, form links, …" | `… case-list selection and search, registration from the case list, form links, …` | 10 |
| `lib/agent/CLAUDE.md` | "Scoped question reads include their effective initial-value source. The case preload rule remains in `lib/domain/casePreload.ts`; selected-record values can supersede explicit defaults, including with blank." | `Scoped question reads include each question's starting value. A preload is a default that reads the case (lib/domain/casePreload.ts::fieldPreload), which the field planners write at a writer's birth and an author can replace or remove.` | 4 |
| `lib/agent/CLAUDE.md`, write semantics | none | `Every mutating result carries identityMoves when its staged batch moves where CommCare HQ keeps published answers, and saveWork repeats every move of the work it saves. No tool asks a confirmation for a move.` | 5 |
| `lib/agent/authoring/CLAUDE.md` | "Form and operation reads expose ordinary answer-derived writes and preloaded field identities, so an empty advanced-operation list cannot be mistaken for a form with no record effects." | `Form and operation reads list this form's own case as its first case operation, with each operation's placement, so no read can be mistaken for a form with no record effects.` | 4 |
| `lib/agent/authoring/CLAUDE.md` | "The fields guide describes live counts: increases add rows; decreases retain created rows, answers, and case operations. Query ID snapshots remain captured at form start or nested row insertion." | `The fields guide describes live counts: increases add rows; decreases retain created rows, answers, and case operations; a count is a whole number. A query repeat's rows are set when the form opens or follow the query, by its placement, which a publish keeps.` | 3 |
| `lib/agent/workspace/CLAUDE.md`, `lib/agent/change-set/CLAUDE.md` | the `applyBatch` invariant | adds `applyBatch and applyStages run withIdentityMoves before the verdict and report the moves; the change set persists them in the stage receipt.` | 5 |

Other areas' directories carry their own owners' sentences (part 10 holds the list).

### 7.2 Public docs (pull request 15)

Part 10 carries every public docs sentence; these are the ones that name this part's surfaces, as
written:

- `content/docs/case-changes.mdx`, "Forms that open an existing case": `When a question saves to the
  case the form opened, Nova gives it a starting value that reads that case's value, so the worker edits
  the value in place. The Saves to row says so: Start blank instead removes it, and you can replace it
  with any starting value. A later starting value that reads such a question reads the case's value.`
- `content/docs/case-changes.mdx`, a new section "This form's case": `A form's type decides what happens
  to its own case. A registration can create its case only when a condition is true, and can close the
  case it creates, every time or when a condition is true. A close form closes its case every time or
  only when a condition is true. Any condition you can build in the condition editor works, and the line
  under it says where CommCare HQ keeps it: Case Management, or a Save to Case block, which needs Save to
  Case in the project space's plan.`
- `content/docs/case-changes.mdx`, "Add a change": adds **Update the worker's record**, and `This form's
  case is always the first change and goes with the form's type.`
- `content/docs/case-changes.mdx`, a new section "Where CommCare HQ keeps each change": `CommCare HQ
  keeps a case change in one of three places: the form's Case Management settings, an advanced menu's
  case actions, or a Save to Case block in the form. Nova chooses the simplest place that can hold it,
  and once you publish, a change stays where your published app has it. An edit that needs a new place
  says so before it saves, because CommCare HQ's exports then show those answers under new columns. Save
  only if changed and saving to a case above work only in Case Management or case actions.`
- `content/docs/case-changes.mdx`, "Ask Nova or an MCP agent": adds `When an edit moves where CommCare HQ
  keeps a change, Nova and an MCP agent report each move before the work is saved.`
- `content/docs/attachments.mdx`, "Saving the file itself": removed; `A capture reaches a case as a link
  to its file.`
- `content/docs/case-workspace.mdx`, "Search first" becomes "When this menu opens": the three choices and
  the switch with §3.8's lines and their platform sentences; "Register when nothing matches": the MCP
  sentence names `case_list_registration`; a new "The case list in the menu": **Show the case list in
  this menu**, beside forms or alone.
- `content/docs/building-with-nova.mdx`, the repeat paragraph: part 04 §8.3's text, which states the
  count placement's rows as part 04 builds them (a row keeps its place, decision R10), with this part's
  addition `A count is a whole number, and Nova offers to wrap any other in int().`; and `A group with
  Show on one screen shows its questions together on Android; it can't hold a
  repeat whose rows workers add.` and `Format text decides whether a label or a choice shows its
  formatting or exactly what you typed.`
- `content/docs/form-sections.mdx`, after the section repeat rule: `The same holds inside a group shown on
  one screen.`
- `content/docs/form-links.mdx`: rewritten to part 06's D1 to D7 in §3.11's words.
- `content/docs/where-workers-use-your-app.mdx`: the search bullet names **Case list first** (Android
  only), **Search first** and **Results first** (Android shows the case list first), and **Forms read the
  search** (Web Apps only).
- `content/docs/mcp/tools.mdx`: each row of §4.2 and §4.4, a new `set_form_otherwise` row, and the
  `caseWrite` section without the `mode` example, with the view, `via`, `onlyIfChanged` and
  `identityMoves`.

## 8. Departures

| From | This part | Reason |
|---|---|---|
| The research: the builder, SA and MCP "say so before it commits" | the SA and MCP state each move in the result and `saveWork`, and ask no confirmation | decision 3 of step 5's plan: the work stages privately and `saveWork` is the commit |
| The authoring brief's A5: an undo opens the dialog for every move | an undo restores a recorded hold without a dialog, drops a hold change the kernel would refuse and says so, and opens the dialog only for a move its content forces | decision R3's kernel rule: an editor may restore the latest recorded hold or move one its batch strands, and nothing else |
| `lib/collab/reconciler.ts`'s "no fallback draft or partial rebase" | the rejected edits are offered again in the dialog, only when the 409's reason is `placement-recorded` (part 03) | decision 3's conflict lead; nothing applies without the person |
| The authoring brief's A8 ids and stored shape (`open-on-search`, `inline`) | decision 1's `workflow` and `formsReadSearch`; tool keys `searchWorkflow` and `formsReadSearch`; builder words §3.8 | decision 1 |
| Part 05's brief: "What workers see first", `Search` / `Results` / `Case list`, required-nullable `searchWorkflow` | "When this menu opens", `Search first` / `Results first` / `Case list first`; `searchWorkflow` required, not nullable | decision 1 gives the builder copy to this part; one spelling of search first |
| Today's withheld **Search first** toggle | **Forms read the search** is disabled with the gate's reason, never hidden | the builder's disabled-with-reason rule |
| The authoring brief's A9 (one editing place in module settings; `update_module.case_list_registration_form`) | both of today's places, renamed; `case_list_registration` on `createForm` / `updateForm` | part 05's stored slot has one arm; removing a working place removes a valid affordance |
| The authoring brief's A12 (formatting on hints, help and validation messages; a `plainText` object) | labels and choices only; `plain_label` | decision 2 |
| The authoring brief's `fieldList` tool key | `field_list` | decision 2's snake case for the sibling key |
| The authoring brief's A13 inline confirm on a mode change | none | Preview's open form is session state the edit doesn't reach |
| The authoring brief's §5.1 sentence for work begun before the cutover | none | decision 12: the cutover discards that work with its notice reason |
| Part 01's brief: `caseWrite` on fields carries only `{caseType, property}` | it gains `via` and `onlyIfChanged` in pull request 13 | the builder's Saves to row offers both on this form's case; the field tool matches it |
| Part 01 §16.5: `via`, `onlyIfChanged`, the `worker-record` target and `open_condition` on the tools in pull request 4 | in pull request 13, `via` and `onlyIfChanged` on the own arm's writes only | decision 7: they are new inputs no replaced concept needs, and decision R9 admits them on the own arm alone |
| §7.1 row 2: pull request 2 removes "the What reaches the case sentences" from `components/builder/CLAUDE.md` | pull request 2 changes nothing there | at the base (1ae8f74e) `components/builder/CLAUDE.md` holds no sentence naming the chooser: `rg -n 'reaches the case\|file itself' components/builder/CLAUDE.md` finds nothing; its CaseWriteEditor paragraph already describes the one `{caseType, property}` destination |
| "Files by pull request", pull request 2, names the builder's two editor files only | pull request 2 also drops `mode` from `CaseSelectionReviewDialog.tsx` and `CaseListConfigWorkspace.tsx` (`CaseSelectionAttachmentAnswer`), whose several-case review sentence keeps only its link wording | both import `CaptureCaseWriteMode`, which pull request 2 deletes |
| §3.2 pull request 2 names the row and the guidance only | the destination menu's header line drops ", not the file itself" and reads `Saves a link to the attached file`; the capture row's text is the trigger's first line, with the `#<case-type>/<property>` reference kept beneath it | "not the file itself" contrasted a choice that no longer exists |
| §9 names `editField.test.ts` for the strict-schema refusal | `fixDissolution.test.ts`'s "attachment destination without a mode" block, which asserted that a capture with no `mode` is refused, now asserts the reverse on the add arm, the edit arm and the domain field schema: the plain destination is admitted and a `mode` refused on a capture and on a text field | that block's premise is what pull request 2 removes; keeping the three surfaces in one place is what catches one of them drifting from the others |
| §4.3 places `rows` on `getField` (`lib/agent/tools/getField.ts`) | pull request 3 computes `rows` in the one field read projection, `lib/agent/authoring/fieldBehavior.ts::queryRepeatRows` beside `effectiveFieldBehavior`, which `output.ts`'s field projector spreads onto every field it reads, so `getField` (the field and a container's children) and `getForm`'s field list both carry it; `summarizeBlueprint.ts` reads the same helper. `getField.ts` is unchanged | `lib/agent/authoring/CLAUDE.md`: tool bodies return canonical values and `output.ts` is the only place a read becomes authored content, so a read fact added in the tool body would be a second owner, and a query repeat inside a group would read without it |
| §4.3 adds `rows` and (pull request 5) `rowsKept` to the read, and names no change for the stored `placement` | pull request 3's field projector removes `placement` from every field read (`output.ts`, the repeat branch) | the projector passes every schema key through, so a held placement would reach the model as a key no edit accepts (`HELD_FIELD_KEYS`); reads use the shapes edits accept, and `rows` states the placement |

## 9. Tests

Each test names the failure it catches and earns its boundary (`docs/testing.md`). No test pins copy or
the guide's prose (`lib/agent/CLAUDE.md`, "Do not pin prose"); the guide's effect on a model is judged
by live quality trials, which are paid and asked for separately.

**Production models and planners (Vitest, no Postgres).**

- `lib/doc/__tests__/identityMoves.test.ts` (pull request 5; pull request 7 adds the `module-kind`
  subject, with a menu that selects a parent case among its documents): for each held subject, a document with a hold, a
  batch that strands it, and
  `withIdentityMoves` returning the move and a batch `mutationCommitVerdict` admits; the same batch
  without the appended `holdPlacements` refused with `HELD_PLACEMENT_INEXPRESSIBLE`; a batch whose hold
  can still express its target returns no move and no appended entry; a document holding nothing returns
  the batch unchanged; `identityMovesBetween` over a redo of a recorded move states it; a later staged
  step that restores the earlier content leaves `identityMovesBetween(base, final)` empty; a hold change
  back to the recorded hold states no move; part 03's `admittedHoldChanges`, as `applyHistoryStep` and
  `planConflictReplay` call it, keeps exactly the entries of arms (a) and (b) and drops a restore whose
  recorded hold a later publish replaced. Pull request 6 adds `planConflictReplay`: edits composed
  before a `publish-placement` frame, replayed over the folded head and its recorded holds, return one
  planned batch with its moves; a replay whose hold change the kernel would refuse loses that entry and
  keeps its content; a replay that states no move returns no move. Catches a move the dialog
  never states, a stated move the gate still refuses, and a hold change the kernel would refuse.
- `lib/routing/__tests__/historyStep.test.ts` (extend, pull request 5): the undo of a move restores the
  content and the recorded hold, with no dialog and the restored-hold toast, and its redo states the
  move again; after a folded `publish-placement` frame records the new place, the same undo keeps the
  hold, applies the content, records an inverse whose redo replays exactly what was applied, and
  returns the dropped-hold toast; the undo of removing a held case change re-creates it with its hold;
  an undo that strands a hold a later publish recorded returns `deferred` with the moves; a refusal
  stays a refusal; each batch applied passes `placementChangeRefusal` under `autosave`. Boundary: the
  store's history, its `recordedHolds` and the pure step, against the kernel's own rule.
- `lib/doc/__tests__/blueprintMutationCommands.test.ts` (extend, pull request 5), through
  `createBlueprintMutations`: a dispatch with moves commits nothing and sets `pendingIdentityMove`;
  `commitStated` commits it as one undo step; a second dispatch while pending is refused; a dispatch
  with no moves commits as today. Catches a deferral that leaks a partial commit.
- The handing back itself (a refusal with `reason: "placement-recorded"` hands the replay to
  `onPlacementConflict` after the reload, any other reason hands nothing back) is part 03's reconciler
  test. `placementConflictReplay.ts` adds no test of its own: it calls `planConflictReplay`, which this
  file's pure cases cover, the gate `blueprintMutationCommands.test.ts` covers and the session slice the
  dialog reads, so a test of that wiring would prove no contract those tests leave open.
- `components/builder/detail/formSettings/__tests__/ownCaseModel.test.ts` (pull request 4; 12 adds the
  registration rows): each choice maps to the stored value of §3.4's table and back; `awaiting-condition`
  writes nothing; a completed condition is one `updateForm` the gate admits on each form type; a stored
  `true()` on a registration reads `Every time`.
- `components/builder/editor/fields/__tests__/caseWriteRowModel.test.ts` (pull request 4; 12 adds via
  and the switch): each view's destination and guidance; each `fieldPreload` state's line and action,
  whose `updateField` the gate admits; the switch's reasons from the planner's verdicts over a real
  document.
- `components/builder/editor/fields/__tests__/repeatRowsModel.test.ts` (pull request 12): each mode
  switch is one patch with only that mode's slot; the query seed parses and checks as an `ids_query`;
  the **Use a whole number** fix builds `int(…)` around the stored tree, and the printer and parser
  give back the same tree.
- `components/builder/case-list-config/inspector/__tests__/searchWorkflowModel.test.ts` (pull request
  10): each choice and the switch give the patch of §3.8's table; `Case list first` clears
  `formsReadSearch` in the same patch; each disabled reason comes from `platformRefusal` or the gate's
  finding.
- `components/builder/case-operations/__tests__/keyboardMove.test.ts` (extend, pull request 4): a move of
  the own row, and of another row above it, is refused with reason `own-first`.
- `lib/doc/__tests__/platformOfferParity.test.ts` (extend, pull request 10): §3.15's sites.

**The SA and MCP.**

- `lib/agent/tools/__tests__/identityMoves.postgres.test.ts` (pull request 5), real Postgres through
  `lib/agent/change-set/workspace.ts::ChangeSetMutationWorkspace.stageDispatch`: an `editField` that
  strands a held placement stages with `identityMoves` in its result and in its durable receipt; a
  recovered request returns the same moves; `saveWork` returns the moves `identityMovesBetween` gives and
  commits a batch the kernel admits under `mcp`; a work whose later step restores the earlier content
  saves with none. Pools close in `finally`.
- `lib/agent/workspace/__tests__/canonicalWorkspace.test.ts` (extend, pull request 5): a canonical
  `applyBatch` returns the moves and the tool result carries them.
- `lib/agent/tools/__tests__/editField.test.ts` (extend, pull requests 2, 4 and 13): a `mode` is refused
  by the strict schema (2); a `caseWrite` on a question saving to two places is refused with the
  sentence of §4.2 and stages nothing (4); `via` and `onlyIfChanged` reach `planFieldCaseWrite` and a
  `via` on a registration is refused with part 01's sentence (13); `plain_label` on a hidden field and
  `field_list` on a text field are refused by the refinement (13).
- `lib/agent/tools/case-operations/__tests__/caseOperationTools.test.ts` (extend, pull requests 4, 7 and
  13): the own arm updates in place and is refused on add, remove and move; `getCaseOperations` lists it
  first with each placement, `"case actions"` included (7); a `worker-record` target on a create is
  refused by the gate; `via` and `onlyIfChanged` on the own arm's writes reach the gate, and on any other
  arm's writes are refused by the strict schema (13).
- `lib/agent/tools/case-search-config/__tests__/setCaseSearchAdvanced.test.ts` and
  `case-list-config/__tests__/configureCaseList.test.ts` (extend, pull request 10): each workflow writes
  its stored value; `searchFirst` writes `workflow: null`; `listFirst` with `formsReadSearch: true` is
  refused; a `searchFirst` key is refused by the strict schema.
- `lib/agent/tools/form-links/__tests__/formLinkTools.test.ts` (extend, pull request 11): `this-form`,
  `setFormOtherwise` over each arm and `null`, the refusals of part 06's planners, `post_submit` on a
  form with links refused.
- `lib/agent/tools/__tests__/caseListRegistrationTools.test.ts` (new, pull request 10): `entry` is
  refused by the strict schema on both form tools; `case_list_registration` writes the menu slot, turns
  `formsReadSearch` on, and `null` restores a menu form and removes the Search-based starting values;
  `case_list_menu_item` on `updateModule` adds the item beside forms and `null` on a bare case list is
  refused.
- `lib/agent/__tests__/summarizeBlueprint-caseWrites.test.ts` (new, pull request 4, extended in 5, 7, 9,
  10 and 11): each line of §4.3 from a real document.
- `lib/agent/authoring/__tests__/platformGuide.test.ts` (extend, pull requests 10 and 11): each feature
  §4.5 interpolates appears with its generated sentence right after its introducing sentence. It pins
  the placement, not the prose.
- `lib/agent/authoring/__tests__/guideExamples.test.ts` (extend): the guide's `int(...)` count commits
  through the shared tool body and the gate (3); a `case_list_registration` form with a `#search/` default
  commits (10); an `open_condition` commits on a registration and is refused on a follow-up (13).
- `lib/mcp/__tests__/servedSchemas.test.ts`: unchanged; it covers every served schema (§4.9).

**Playwright** (each spec run locally, one at a time, before each push, never a repeated suite on the
laptop):

- `e2e/tests/app/identity-moves.spec.ts` (new, pull request 5), `@seed:identity-moves`, a new typed
  profile in `e2e/lib/smokeProfiles.ts` and `e2e/lib/smokeSeedFactory.ts`: an app whose document holds a
  Case Management placement on a follow-up form's own case, seeded as its saved document and its fold
  baseline, so the latest recording holds that placement. Turning a write's value into a calculation
  opens the dialog; **Cancel** commits nothing (no PUT leaves the tab); **Make the change** commits once
  and, from pull request 12, the rail reads Save to Case with the held suffix; undo restores the value
  and the Case Management placement with no dialog, the save is admitted, and the restored-hold toast
  shows.
- `e2e/tests/app/search-workflow.spec.ts` (new, pull request 10), `@seed:workspace` (Android declared)
  and `@seed:search-first` (Web Apps only): the three choices and the switch with their disabled lines
  per declaration; choosing `Results first` writes `"workflow":"skipToResults"`.
- `e2e/tests/app/case-list-menu-item.spec.ts` (new, pull request 10), `@seed:workspace`: turning on
  **Show the case list in this menu** on a menu with forms shows the module screen with the case list
  after its forms; on a bare case list the switch is disabled with its line.
- `e2e/tests/app/case-writes.spec.ts` (new, pull request 12), `@seed:case-changes`: the own row is first
  and has no handle; **Saves to** offers a case above it on a follow-up form and writes `via`; **Save only
  if changed** is disabled on a registration with its line.
- `e2e/tests/browser/builder-controls.spec.ts` (extend, pull request 12): **Show on one screen** disabled
  over a worker-added repeat; the Rows editor's count refusal and its fix; **Format text** off on a label
  shows `**bold**` as typed and on a choice writes its `plainLabel`.

`config/smoke-execution.json` stays as it is; the new specs join by discovery.

## Executed during planning

Planning ran no test, build, Docker or lane, and made no network or billed call. It read Nova at `main`
`2f985ed6` and `../nova-plugin` at `105836d` with `rg` and file reads, and searched the Dimagi checkouts
at the pins with `rg` (none switched).

Read for this part: `lib/models.ts`, `lib/db/appTests.ts`, `scripts/test-schema.ts` (its 55 entries and
its runner), `scripts/inspect-tool-schema-hashes.ts`, `lib/agent/CLAUDE.md` ("Provider contract"),
`lib/agent/toolSchemaGenerator.ts` (`FIELD_DOCS`, `caseWriteToolSchema`, `gateCaseWriteMode`,
`repeatConfigDiscriminated`, the add and edit schemas, `projectedSelectOptionSchema`),
`lib/agent/tools/case-operations/shared.ts` and its five tools, `lib/agent/tools/{createForm,updateForm,createModule,updateModule,getModule,getForm,getField}.ts`,
`lib/agent/tools/shared/formEntry.ts`, `lib/agent/tools/case-search-config/shared.ts`,
`setCaseSearchAdvanced.ts`, `lib/agent/tools/case-list-config/configureCaseList.ts`,
`configureCaseSelection.ts`, `lib/agent/tools/form-links/*.ts`, `lib/agent/tools/media/setMenuMedia.ts`,
`lib/agent/tools/common.ts`, `lib/agent/workspace/types.ts`, `canonicalWorkspace.ts`,
`lib/agent/change-set/types.ts`, `lib/agent/authoring/session.ts` (`saveWork`, the staging result),
`lib/agent/authoring/lifecycleTools.ts`, `lib/agent/authoring/reference.ts`, `lib/domain/fields/{group,repeat,section}.ts`,
`lib/agent/summarizeBlueprint.ts`, `lib/agent/prompts.ts`, `lib/mcp/prompts.ts`,
`lib/mcp/__tests__/servedSchemas.test.ts`, `lib/domain/platforms.ts` (the search, question-pages and
case-list-menu-item rows), `lib/doc/hooks/useBlueprintMutations.ts` (`guardedApply`, `reviewMany`,
`commitMany`), `lib/routing/builderActions.ts`, `lib/routing/historyStep.ts`, `lib/collab/reconciler.ts`
(the `commitRejected` branch), `app/api/apps/[id]/route.ts` (the 409), `lib/db/commitGuard.ts`,
`components/builder/editor/fields/CaseWriteEditor.tsx`, `caseWritePresentation.ts`,
`components/builder/case-list-config/inspector/SearchPanelInspectorBody.tsx`,
`canvas/NoMatchesFormSetting.tsx`, `noMatchesFormReview.tsx`,
`components/builder/detail/formSettings/FormEntrySection.tsx`, `ModuleAppearanceSection.tsx`,
`components/builder/case-operations/refusalCopy.ts`, `components/preview/form/InlineTextEditor.tsx`,
`components/builder/CLAUDE.md`, `components/CLAUDE.md` (Voice), `lib/doc/CLAUDE.md`,
`lib/routing/CLAUDE.md`, `lib/collab/CLAUDE.md`, `lib/agent/authoring/CLAUDE.md`, `docs/testing.md`,
`e2e/lib/smokeProfiles.ts`, `docs/plans/hq-round-trip/README.md`, and in `../nova-plugin`
`skills/upload_to_hq/SKILL.md`, `skills/build/SKILL.md`, `skills/edit/SKILL.md`,
`agents/nova-architect-autonomous.md`, `README.md` and `.claude-plugin/plugin.json`. At the pins:
Vellum `src/javaRosa/plugin.js`, `itextWidget.js`, `itextBlock.js`, `util.js`, `src/mugs/types/group.js`;
commcare-hq `corehq/apps/app_manager/static/app_manager/js/details/case_claim.js`,
`corehq/apps/app_manager/util.py`, `corehq/apps/app_manager/feature_support.py`.

## Written and not yet run

Two runs are this part's own. The rest are other parts' runs whose outcomes change this part's copy or
surfaces; each is written here with every outcome and where it lands, so the implementing pull request
applies the outcome its owner's run gives without deciding anything.

**G-A1. The billed schema check.** Where: the laptop, one live OpenAI request per entry, at pull request
13's head, asked once, naming every `scripts/test-schema.ts` entry the stack added or changed, checked
against the `main`-to-head hash run (§4.8), with its cost; each runs as `npm run test:schema -- <name>`
only on the person's yes. No other pull request runs it (decision R11).

- *Outcome A, every named tool accepted:* pull request 13 proceeds; its description records the names
  run and the results.
- *Outcome B, the provider refuses a tool's schema:* the refusal names the keyword, and the construct is
  replaced within the authored surface by one the same tool already serves and the provider accepted at
  `main`. The two likeliest: the `addFields` item, which gains `field_list` and `plain_label` beside its
  optionals, loses `field_list` first (a new group takes `groupBornFieldList`, and `editField` sets
  it), then `plain_label` (set through `editField`), with `FIELD_DOCS` saying so; the new target arm
  `worker-record`, refused in the union, becomes a value of the session arm, `{ kind: "session", case?:
  "worker-record" }`, described the same way. `scripts/test-schema.ts` keeps its entry, the person is asked again for that one tool only, and
  nothing merges with a schema the provider has not accepted.

**G-A2. The plugin merge waits for the deploy.** Where: the deploy check-run on the stack's merge
commit, read through `gh` after listing the commit's check-runs and building the filter from the
observed app name.

- *Outcome A, the deploy succeeds:* the `../nova-plugin` pull request merges.
- *Outcome B, the deploy fails or rolls back:* the plugin pull request stays open and unmerged, since
  its skill would name parameters the live server refuses; it merges after the repaired deploy is live.

**Part 06's G1, what each runtime does with several destinations that hold** (in pull request 11's
lane):

- *Outcome A (expected):* §3.11, §4.2 and §4.5 as written.
- *Outcome B, Web Apps runs the chain as Core does:* no `after-submit-several-destinations` row, so no
  note row under the list, no `${platformSentence("after-submit-several-destinations")}` in the guide,
  and `addFormLinks` drops `In Web Apps only the first that holds opens.` Everything else stands. Where
  part 06's sub-case finds Web Apps running them in another order, the row returns with that clause, and
  the note row and the generated sentence return in the same places.
- *Outcome C, Android also runs only the first:* the list heading is `After this form, the first of these
  that applies opens`; the settings row `Opens the first of <n> destinations that applies`;
  `addFormLinks` reads `Add after-submit destinations, in the order they are checked: after the form, the
  first whose condition holds opens. Conditions read saved records and worker values after the form
  closes, so they cannot use unsaved answers. Set where the worker goes when none opens with
  setFormOtherwise/set_form_otherwise. ${HIDDEN_TARGET_NOTE}`; its `links`: `Destinations in the order
  they are checked.`; `moveFormLink`: `Reorder an after-submit destination. Destinations are checked in
  this order, and any order is admitted.`; `condition`: `Session-scope XPath; when it holds and no
  earlier destination holds, this destination opens. Null or omitted opens it whenever no earlier one
  does. …` (the rest unchanged); the guide's inserted sentence reads `After a form, the first destination
  whose condition holds opens.` with no platform sentence.

**Part 06's G2, the held-case guard:**

- *Outcome A (expected):* as written.
- *Outcome B, the static rule:* `datums`' last sentence becomes `Each carried value must be a case of the
  type the target reads, such as the case this form opened or created, or a property that holds a case's
  id.`; the builder's carrying-row line `When the case it carries is on the worker's device` is removed;
  `setFormOtherwise` reads `Offered only while some destination might not run, because it has a
  condition; null goes to the app home.`; the guide drops `A destination that carries a case runs only
  when the worker's device holds that case, and`, keeping `The this-form target starts the form again.`

**Part 06's G3, HQ's editors keep every new shape:**

- *Outcome A (expected):* as written.
- *Outcome B:* a shape the save changes is withdrawn from every surface in the same pull request. For
  `this-form`: the target union, the target description's clause, the picker's `Start this form again`
  and the guide's sentence go. For a built-in otherwise word: it leaves `setFormOtherwise`'s enum and
  the chooser. A withdrawn input moves the schema hash, which G-A1 then covers.

**Decision 6's run, the case list menu item's readings** (part 05, pull request 10):

- *Outcome A, "Redirecting after sync" and the first menu:* the beside-forms entry joins
  `case-list-menu-item`; the note row of §3.10 and the guide's generated sentence read as the row reads.
- *Outcome B, the case list again; outcome C, an empty list:* the row's notes change (part 05's words)
  and the note row and the generated sentence follow. Where part 05 gives the beside-forms entry its own
  feature, `CaseListMenuItemSection` shows that feature's note row for a module with forms, and the guide
  appends its generated sentence after `case-list-menu-item`'s (§4.5).
- *A reader shows an error or a stopped walk on a platform, under any outcome:* the feature is refusable
  there. The switch on a module with forms is disabled with its `platformPickerLine`; the gate refuses
  `updateModule.case_list_menu_item` on such a module with `PLATFORM_FEATURE_UNAVAILABLE`'s message; the
  parity test gains the site (§3.15).

**Part 05's G3, HQ's Case List page keeps each workflow:**

- *Outcome A (expected):* as written.
- *Outcome B, a value the save changes:* that value is withdrawn: its choice leaves §3.8's fieldset, its
  value leaves the `searchWorkflow` enum and its sentence leaves the description, and part 05's cutover
  moves stored modules off it. A choice that can never be offered again offers no way forward, so it is
  removed rather than disabled.

**Part 05's G4, a Search screen with no visible field:**

- *Outcome A (expected):* as written.
- *Outcome B, the search runs on its own:* the canvas sentence under `Search first` reads `The search
  runs as the menu opens, since there's nothing to fill in.`, and `searchWorkflow`'s last sentence reads
  `Under searchFirst, a search with nothing to fill in runs as the menu opens.` Where a device reads
  `auto_launch` after all, the Android notes of `search-first` and `skip-to-results` go, and the
  descriptions drop `Android opens the case list first` for both.

**Part 04's G2, Core's reading of the count placement and of direct counts** (pull request 3's lane):

- *Outcome A (expected):* rows past the end are hidden and a row keeps its place; the Rows editor, the
  tool text and the guide as written.
- *Outcome B1, `position(..)` misreads on a new row:* an emission change only; nothing here changes.
- *Outcome B2, the guard neither hides nor drops rows:* the Rows editor's last line reads `A row past
  the end of the cases found stays, with no case behind it, and saves no case.`, and the guide's
  sentence `A row past the end of the current result is hidden and writes no case.` becomes `A row past
  the end of the current result stays, with no case behind it, and writes no case.`
- *Outcome C, a row's id is not recomputed:* the rows-that-follow line reads `Rows follow the cases
  found as answers change. Each row keeps the case it was made for, and hides when that case leaves
  the cases found.`; `FIELD_DOCS.repeat_mode` ends `each row keeping the record it was made for`; the
  guide's `and a row keeps its place, so its answers stay with that place when the result changes`
  becomes `and a row keeps the record it was made for, and hides when that record leaves the result`;
  `expressions` ends `how each row keeps its record`.
- *Outcome D, a direct Hidden Value count misbehaves:* an emission change only; the checker still
  admits such a count, so nothing here changes.

**Part 04's G3, field lists and plain labels on every reader** (pull request 9; its Android half is
part 08's G5):

- *Outcome A (expected):* §3.12 and §3.13 as written.
- *Outcome B:* as part 08's G5 outcome B below.
- *Outcome C1, a form-builder save adds a markdown form back to a plain item of some kind:* that kind
  carries no `plainLabel`, so **Format text** leaves its toolbar or overflow, `plain_label` is refused
  on it (`kind "<kind>" carries no plain_label, so leave it out.`, or the choice item loses the key
  where the kind is a choice), and `FIELD_DOCS.plain_label` names the kinds that keep it.
- *Outcome C2, a save drops the appearance from an unlabelled field-list group:* **Show on one screen**
  is disabled on a group whose label is empty in every language, with `This group has no label, and
  CommCare HQ's form builder would stop showing its questions on one screen. You can give it a label
  first.`, the switch's sentence matching part 04's `FIELD_LIST_UNLABELLED` finding; `FIELD_DOCS.field_list`
  appends `A group needs a label for true.`

**Part 08's G5, Android shows a label with no markdown form as typed** (pull request 9):

- *Outcome A (expected):* §3.13 as written.
- *Outcome B, Android formats it anyway:* the label's off line reads, Web Apps and Android: `In Web Apps,
  workers see this text as you typed it. On Android, it still shows formatting.`; Android only: `On
  Android, this text shows its formatting either way.`; Web Apps only: unchanged. `FIELD_DOCS.plain_label`
  appends `On Android a label shows its formatting either way.`

**Part 02's G6, an advanced extension open action's owner:**

- *Outcome A (expected):* nothing changes here.
- *Outcome B, the case is unowned:* pull request 7 gives such a change `unowned: true` in
  `getCaseOperations` and appends to `addCaseOperations`' description `A new case linked only as an
  extension, in an advanced menu's case actions, has no owner.` (which `.7` covers); pull request 12
  adds, under the rail's `Where CommCare HQ keeps it` row of a create placed on a case action whose
  links are all extensions, `CommCare HQ gives this case no owner, so it syncs to whoever holds the case
  it extends.` (§3.5).

**Part 01's G5, the Case Management save keeps `update_mode: edit`** (pull request 4's lane):

- *Outcome A (expected):* §3.2's switch, §3.5's overflow item, §4.2's `onlyIfChanged` inputs and §4.8's
  prompts as written.
- *Outcome B, the save clears it:* pull request 12 adds no **Save only if changed** switch (§3.2) and no
  such item in §3.5's overflow. Pull request 13 adds no `onlyIfChanged` to the field tool's `caseWrite`
  or to `ownWriteInputSchema` (§4.2), and its `addFields` and `updateCaseOperation` schema-test prompts
  drop `only if changed` (§4.8). Pull request 4 builds no capability, so `check_project_space_compatibility`
  names no `Save only answers that changed` (§4.4), and `getField`'s `caseWrites` carry no
  `onlyIfChanged` (§4.3). The public docs' sentence reads `Saving to a case above works only in Case
  Management or case actions.`, `mcp/tools.mdx` names no `onlyIfChanged` (§7.2), and the sentences of
  §7.1 and the tests of §9 that name it drop it. `via` stands as written.

**Part 03's supply-text, probe and flag-effect runs** reach only the plugin text (§6), as written there.

## Files by pull request

**Pull request 2.** Changed: `components/builder/editor/fields/CaseWriteEditor.tsx`,
`caseWritePresentation.ts`; `lib/agent/toolSchemaGenerator.ts`; `lib/models.ts`;
`lib/agent/tools/__tests__/editField.test.ts`; `components/builder/CLAUDE.md` (§7.1).

**Pull request 3.** Changed: `lib/agent/tools/getField.ts` (`rows`), `lib/agent/summarizeBlueprint.ts`
(the rows marker), `lib/agent/authoring/__tests__/guideExamples.test.ts`; the guide, `FIELD_DOCS`,
`repeat` `saDocs`, `lib/models.ts` and `lib/agent/authoring/CLAUDE.md` move with part 04 §8.4's text in
this pull request (part 04 lists them).

**Pull request 4.** New: `lib/doc/hooks/useFieldCaseWrites.ts`, `lib/doc/hooks/useCasePlacements.ts`,
`lib/domain/placementCopy.ts` (with part 01's `placementIneligibilitySentence`),
`components/builder/editor/fields/caseWriteRowModel.ts`,
`components/builder/detail/formSettings/OwnCaseSection.tsx`, `ownCaseModel.ts`, and their tests,
`lib/agent/__tests__/summarizeBlueprint-caseWrites.test.ts`. Changed: `CaseWriteEditor.tsx`,
`caseWritePresentation.ts`, `editor/fieldEditorSchemas.ts` (`defaultValueEntry`),
`editor/fields/HiddenValueEditor.tsx`, `hiddenValueModel.ts`, `detail/formSettings/FormSettingsPanel.tsx`,
`components/builder/case-operations/{CaseOperationsCanvas,CaseOperationRow,CaseOperationInspectorBody,operationSentence,refusalCopy,keyboardMove,seeds}.ts(x)`
and `__tests__/keyboardMove.test.ts`, `lib/agent/toolSchemaGenerator.ts`,
`lib/agent/tools/{addFields,editField,getField,getForm,updateForm}.ts`,
`lib/agent/tools/case-operations/{shared,addCaseOperations,updateCaseOperation,getCaseOperations,removeCaseOperation,moveCaseOperation}.ts`
and `__tests__/caseOperationTools.test.ts`, `lib/agent/summarizeBlueprint.ts`,
`lib/agent/authoring/reference.ts`, `lib/models.ts`, `scripts/test-schema.ts`, the `CLAUDE.md` rows of
§7.1 marked 4. Deleted: `components/builder/editor/fields/PreloadedValueRow.tsx`,
`components/builder/detail/formSettings/CloseConditionSection.tsx`,
`lib/doc/hooks/useCloseConditionPlacement.ts`.

**Pull request 5.** New: `lib/doc/identityMoves.ts`, `lib/doc/identityMoveCopy.ts`,
`components/builder/shared/IdentityMoveDialog.tsx`, `IdentityMoveList.tsx`,
`lib/doc/__tests__/identityMoves.test.ts`, `lib/agent/tools/__tests__/identityMoves.postgres.test.ts`,
`e2e/tests/app/identity-moves.spec.ts`. Changed: `lib/doc/hooks/useBlueprintMutations.ts`
(`guardedApply`, `reviewMany`, `commitStated`), `lib/doc/builderWriteAdmission.ts` (the pending
refusal), `lib/doc/store.ts` (`applyHistoryStep`, `recordedHolds`, read through part 03's
`admittedHoldChanges` in `lib/doc/placementHolds.ts`), the builder's app load (the recorded holds
beside the document, through part 03's reader), `lib/session/store.ts`
(`pendingIdentityMove`), `biome.json` (the allowlist entry for `lib/doc/identityMoves.ts`),
`lib/routing/historyStep.ts`, `lib/routing/builderActions.ts` (the toast),
`components/builder/BuilderLayout.tsx` (the mount), `components/builder/case-list-config/noMatchesFormReview.tsx`,
`CaseListConfigWorkspace.tsx`, `components/builder/detail/appSettings/AppPlatformsSection.tsx`,
`OwnCaseSection.tsx` and `lib/domain/placementCopy.ts` (the held suffix),
`lib/agent/workspace/{types,canonicalWorkspace}.ts`, `lib/agent/change-set/{workspace,schemas}.ts`,
`lib/agent/authoring/session.ts`, `lib/agent/tools/getField.ts` and `getCaseOperations.ts` (`rowsKept`,
`placementKept`), `lib/agent/toolSchemaGenerator.ts` (`repeat_mode`'s published sentence),
`lib/agent/summarizeBlueprint.ts`, `lib/mcp/prompts.ts`,
`lib/agent/authoring/reference.ts`, `lib/models.ts`, `e2e/lib/smokeProfiles.ts`,
`e2e/lib/smokeSeedFactory.ts`, the tests of §9 marked 5, the `CLAUDE.md` rows of §7.1 marked 5.

**Pull request 6.** New: `components/builder/placementConflictReplay.ts`
(`replayAfterPlacementConflict`, the `onPlacementConflict` handler). Changed: `lib/doc/identityMoves.ts` (`planConflictReplay`),
`lib/doc/__tests__/identityMoves.test.ts` (its cases), `IdentityMoveDialog.tsx` (the
`placement-recorded` lead and **Leave it**), `components/builder/BuilderLayout.tsx` (supplying the
handler to `ReconcilerProvider`), `lib/doc/store.ts` (`recordedHolds` advanced through `setRecordedPlacementHolds` by a folded
`publish-placement` frame), `lib/collab/CLAUDE.md` (this part's sentence). The replay's collection,
`admittedHoldChanges`, the reconciler, the provider, the route and `commitGuard.ts` are part 03's.

**Pull request 7.** Changed: `lib/doc/identityMoves.ts` (part 02's source and the `module-kind`
target), `lib/agent/tools/getModule.ts` (`advanced`), `lib/agent/tools/case-operations/getCaseOperations.ts`
(`"case actions"`), `components/builder/form-links/` (`FORM_LINK_NEEDS_NEW_CASE_DATUM`'s sentence at the
link editor), `lib/agent/summarizeBlueprint.ts`, `lib/agent/authoring/reference.ts`, `lib/models.ts`, and
the tests of §9 marked 7.

**Pull request 10.** New: `components/builder/case-list-config/inspector/SearchWorkflowSetting.tsx`,
`searchWorkflowModel.ts`, `components/builder/detail/moduleSettings/CaseListMenuItemSection.tsx`,
`lib/agent/tools/__tests__/caseListRegistrationTools.test.ts`, `e2e/tests/app/search-workflow.spec.ts`,
`e2e/tests/app/case-list-menu-item.spec.ts`, and the model test. Renamed:
`case-list-config/canvas/NoMatchesFormSetting.tsx` to `CaseListRegistrationSetting.tsx`,
`case-list-config/noMatchesFormReview.tsx` to `caseListRegistrationReview.tsx`,
`lib/agent/tools/shared/formEntry.ts` to `caseListRegistration.ts`. Changed: `SearchPanelInspectorBody.tsx`,
`canvas/SearchCanvas.tsx`, `detail/formSettings/FormEntrySection.tsx`, `detail/moduleSettings/ModuleAppearanceSection.tsx`,
`ModuleSettingsPanel.tsx`, `appTree/ModuleCard.tsx`, `appTree/FormCard.tsx`,
`appTree/insertion/AddModulePopover.tsx`, `components/preview/screens/ModuleScreen.tsx`,
`lib/doc/__tests__/platformOfferParity.test.ts`, `lib/doc/identityMoveCopy.ts` (the `forms-read-search`
reason's sentence becomes `Its forms now read the search, which an advanced menu can't do.`, part 02
§21), `lib/agent/tools/case-list-config/configureCaseList.ts`,
`lib/agent/tools/case-search-config/{shared,setCaseSearchAdvanced}.ts`,
`lib/agent/tools/{createModule,updateModule,createForm,updateForm,getModule}.ts`,
`lib/agent/summarizeBlueprint.ts`, `lib/agent/authoring/reference.ts`, `lib/models.ts`,
`scripts/test-schema.ts`, the tests of §9 marked 10, the `CLAUDE.md` rows of §7.1 marked 10.

**Pull request 11.** New: `lib/agent/tools/form-links/setFormOtherwise.ts`. Changed:
`components/builder/form-links/{FormLinksCanvas,FormLinkRow,OtherwiseRow,AddLinkControl,LinkTargetPicker,OtherwiseChooser,CarryValuesSection,afterSubmitCopy,linkSentence,refusalCopy}.ts(x)`
(their words; part 06 lists the structural change, `FallbackChooser.tsx` renamed `OtherwiseChooser.tsx`),
`components/builder/detail/formSettings/AfterSubmitSection.tsx`,
`lib/agent/tools/form-links/{shared,addFormLinks,updateFormLink,moveFormLink,removeFormLink}.ts`,
`lib/agent/tools/{createForm,updateForm,getForm}.ts`, `lib/agent/sharedToolRegistry.ts`,
`lib/agent/toolPresentation.ts`, `lib/chat/toolSummary.ts`, `lib/agent/summarizeBlueprint.ts`,
`lib/agent/authoring/reference.ts`, `lib/models.ts`, `scripts/test-schema.ts`,
`lib/agent/tools/form-links/__tests__/formLinkTools.test.ts`,
`lib/agent/authoring/__tests__/platformGuide.test.ts`, `components/builder/CLAUDE.md`.

**Pull request 12.** New: `components/builder/editor/fields/RepeatRowsEditor.tsx`, `repeatRowsModel.ts`,
`components/builder/editor/fields/__tests__/repeatRowsModel.test.ts`,
`e2e/tests/app/case-writes.spec.ts`. Changed: `CaseWriteEditor.tsx`, `caseWriteRowModel.ts`,
`OwnCaseSection.tsx`, `ownCaseModel.ts`, `components/builder/case-operations/{seeds,CaseOperationDetailCanvas,CaseOperationInspectorBody}.ts(x)`,
`editor/fieldEditorSchemas.ts` (the group switch and the repeat entry, the comment),
`components/preview/form/InlineTextEditor.tsx`, `editor/fields/OptionsEditor.tsx`,
`components/builder/localization/` (the source row's formatting state),
`detail/moduleSettings/ModuleSettingsPanel.tsx` (the `In CommCare HQ` row, through a `lib/doc/hooks`
reader of `advancedKindReasons`),
`e2e/tests/browser/builder-controls.spec.ts` and `e2e/lib/builder-controls-client.tsx`, the `CLAUDE.md`
rows of §7.1 marked 12.

**Pull request 13.** Changed: `lib/agent/toolSchemaGenerator.ts`, `lib/agent/contentProcessing.ts`,
`lib/agent/tools/case-operations/shared.ts` (`ownWriteInputSchema`, the `worker-record` target),
`updateCaseOperation.ts`, `lib/agent/tools/updateForm.ts`, `createForm.ts`,
`lib/domain/fields/group.ts` (`saDocs`), `lib/agent/authoring/reference.ts`, `lib/models.ts`,
`scripts/test-schema.ts`, the tests of §9 marked 13.

**`../nova-plugin`, one pull request beside 13.** `skills/upload_to_hq/SKILL.md`, `README.md`,
`.claude-plugin/plugin.json`.

## What other parts read from this one

**Every part.** The author-facing names (§3), the identity-move types and report (§2.2, §2.7), the
guide sentences (§4.5), the version format and table (§4.7), the billed-check procedure (§4.8).

**Part 01.**

- `planFieldCaseWrite`'s destination `{ caseType, property, via?, onlyIfChanged? } | null` (part 01
  §16.3), `via` and `onlyIfChanged` admitted only on the own arm of a follow-up or close form, which the
  field tool (pull request 13) and the Saves to row (pull request 12) reach.
- A describer, `lib/domain/caseOperationDescription.ts::describeCaseOperation(doc, formUuid,
  operationUuid): string`, the operation sentence the dialog, the tool sentences and part 03's offered
  moves share.
- `caseOperationMoveVerdicts` reason `own-first` for a move of the own arm or above it.
- `planOperationPlacementMoves(candidate)` returns `holdPlacements` entries and moves whose reason is the
  first `PlacementIneligibility`, worded by `placementIneligibilitySentence` (§2.3), never `updateForm`
  patches (decision 4).
- `placementExpresses` serves `identityMovesBetween` and part 03's `admittedHoldChanges`.
- The builder owns the surfaces of part 01 §16.5: `OwnCaseSection` replaces `CloseConditionSection` in
  pull request 4 (§3.4), and the tool inputs `via`, `onlyIfChanged`, the `worker-record` target and
  `open_condition` land in pull request 13 (§4.2), with `via` and `onlyIfChanged` on the own arm's
  writes only.
- An undo of an identity move restores the recorded hold under decision R3's arm (b) and states no
  move (§2.5).

**Part 02.** Its one source `planModuleKindMoves` registers into `withIdentityMoves` first (pull request
7), with the one subject `module-kind` and its five reasons, worded in `identityMoveCopy.ts` by
§2.3's sentences, which part 02 §21 quotes; `PlacementLabel` holds `ordinary-menu` and `advanced-menu`
for its moves, and the module-kind move's sentence states, from part 02's facts, that a menu selecting
a parent case has its forms read the chosen cases under new names; the settings row of §3.7 reads `lib/commcare/moduleKind.ts::advancedKindReasons` (`held`,
`carried-create`); the case list menu item's disabled reason of §3.7 is
`FORM_LINK_NEEDS_NEW_CASE_DATUM`'s builder sentence (part 02 §17), with no line of this part's own; `getModule`'s `advanced: { kept: boolean } | null` reads
`emittedModuleKind` and `heldKind`; no surface reads or writes a stored case selection, since step 5
holds none; G6's outcome B surfaces as written above.

**Part 03.** This part reads the 409's `reason: "placement-recorded"`, `findingCodes`,
`PLACEMENT_CONFLICT_CODES` and `onPlacementConflict(replay)`; this part's handler
`components/builder/placementConflictReplay.ts::replayAfterPlacementConflict` supplies `onPlacementConflict`, drops the hold
changes `admittedHoldChanges` does not admit, plans the rest and opens `IdentityMoveDialog` with origin
`conflict` and part 03's lead (§2.6); the dialog's buttons are **Make the change** and **Leave it**. The
undo policy is decision R3's two arms, which `applyHistoryStep` applies through part 03's
`lib/doc/placementHolds.ts::admittedHoldChanges` over the record `setRecordedPlacementHolds` gives the
store (`recordedHolds` from part 03's kernel reader, §2.5), so a history step does carry hold changes, only those the
kernel admits, and the undo of an identity move restores the recorded place. The held suffix `Kept
where your published app has it` sits beside part 03's copy; the plugin's sentences for its parameters
(§6).

**Part 04.** `planQueryRepeatPlacementMoves` returns its needs (`nested`, `query-reads-answers`,
`ancestor-condition-changes`) as the `query-repeat` source's reasons, worded by §2.3 from part 04
§1.7's facts; the dialog row of §2.4 replaces Q-QR-5's builder copy; part 04 §8.4's pull request 3
text stands, and this part adds in pull request 5 only `Once published, a query repeat keeps that
choice, and an edit that would change it says so in identityMoves.`; the Rows editor states a row's
place as part 04 builds it (decision R10).

**Part 05.** The builder words of §3.8, which its platform rows' labels and refusal alternatives use
(`Search first`, `Results first`, `Case list first` and `Forms read the search`, decision R9);
`skip-to-results` relabelled `Results first`; the tool keys `searchWorkflow` (required, not nullable,
in `setCaseSearchAdvanced`) and `formsReadSearch`; `case_list_registration` on the form tools and
`case_list_menu_item` on the module tools, each with `label` optional and nullable; the section `Case
list in the menu`; the workflow control, that section, `searchWorkflow` and
`updateModule.case_list_menu_item` all land in pull request 10 with the stored concepts they replace
(decision 7 of this part); the registration surfaces follow part 05 §9's two editing places.

**Part 06.** §3.11's copy and §4.2's descriptions, with the G1 to G3 variants above, applied to part
06's structure and input shapes in pull request 11 (decision R12); pull request 12 adds nothing to the
after-submit surface.

**Part 08.** The new Playwright specs and the `identity-moves` seed profile join the smoke by discovery;
no register entry moves for this part. Its G5 (Android plain label) reaches §3.13's off line; no
row-identity run exists (decision R10).

**Part 09.** The control names the notice copy uses: `Saves to`, `Opens with the case's current value`,
`Close the case it creates`, `When this menu opens`, `Search first`, `Forms read the search`, `Show the
case list in this menu`, `Show on one screen`, `Format text`; and that no tool carries a sentence for
work begun before the cutover, since the cutover discards it.

**Part 10.** §7's sentences, §5's table, the files above, the `../nova-plugin` pull request's link in
pull request 15.

**For the outlines.**

- *Step 7, group 6 (case selection):* stored case selections (several selected cases per form,
  auto-selection, computed datums) with their builder controls and tool inputs: a form's second case
  chosen from another menu's list, a `selection` target on the case change tools, and its reads. Step 5
  stores no `Form.caseSelections` (part 02 derives an advanced form's selections from its module's
  parent-selection chain), so no surface reads or writes one. Reason: no Nova document needs them before
  an imported advanced form (decision R4 of step 5's plan).
- *Step 7, group 3 (modules and navigation):* the builder and the tools offer the one
  `caseListRegistrationForm` arm, `after-empty-search`; the other arms part 05 writes into the outline
  each gain their control and tool value there.
