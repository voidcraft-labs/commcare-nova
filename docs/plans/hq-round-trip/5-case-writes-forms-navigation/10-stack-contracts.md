# Step 5, part 10: The pull-request stack, contracts and docs

Part of [step 5's plan](../5-case-writes-forms-navigation.md) ("Case writes, forms and navigation"),
which holds the baseline, the decisions and the exit. Citations are `path::symbol` for Nova at `main`
`2f985ed6` (#825, step 4's fifteen pull requests merged and its cutover run). This part makes no
CommCare claim of its own: every CommCare fact it relies on is a fact of another part, cited there at
the pins `proof/pins.json` names (commcare-hq `d6c6e16d8ae1`, commcare-core `8e9ba8d908e9`,
commcare-android `7a5584475580`, formplayer `24383ac71bfb`, commcare-connect `046c7fd78081`, Vellum
`01215f251c57`, the build HQ vendors at that pin).

This part owns no defect, so it carries no Today / From step 5 block of its own beside the contract
rows. It orders the work parts 01 to 09 plan into one stack of sixteen pull requests, lists every
file each pull request touches, gives the checklist each model addition follows, lists every contract
sentence, public docs page and lane document step 5 rewrites, and states the exit as checks a machine
runs. Where a pull request is named by number anywhere in this plan, the number is the one in §1.
Every cutover step id, blocker code, notice reason, migration name and Job name here is the one part
09 registers, from the decisions' resolutions 11 to 13; that registry is the one list. Every targeted
document is named as part 08 §5.1 names it (resolution 15), and every shared function as its owner
names it (R7). The second decisions (R1 to R20) settle the points where the parts first disagreed;
where this part follows one, it names it. The production scan's findings are written here as what
it decided (R20), in words and with no count.

The stack is cut from the latest `origin/main` after this plan's own pull request merges. Counts are of `main` at `2f985ed6`, read for this part:
`proof/known-defects.json` 271 entries (d21 37, d23 79, d24 26, d25 101, d26 18, d27 3, d28 3, d30 4),
`proof/fixed-defects.json` 746, `proof/walk-stops.json` 25, `proof/controls/` 108 directories,
`proof/identity-moves.json` `[]`, `proof/checks/registers.py::OPEN_DEFECTS` `{21: 5, 23: 5, 24: 5,
25: 5, 26: 5, 27: 5, 28: 5, 30: 5}`, `lib/models.ts::MODEL_CONTEXT_VERSION`
`"v5-hq-round-trip-platforms.12"`, `lib/db/appTests.ts::RUNTIME_VERSION` 17, and
`scripts/test-schema.ts::SCHEMA_TESTS` 55 entries, every one named in its header's "Known names".
The corpus holds 398 documents (part 08 §4.1). `../nova-plugin` is read at `105836d`, whose
`.claude-plugin/plugin.json` holds `"version": "2.3.0"`.

## Decisions in brief

1. **Sixteen pull requests, one `gh stack` chain, merged together for one deploy**, numbered and
   ordered as the decisions' stack table gives them (§1, R1). Pull request 10 stays above 7 and 8:
   pull request 7 emits advanced modules with no case list menu item beside their forms, pull request
   8's `commtrackReasons` reads a menu item wherever a module holds one (only a formless one before
   10) and holds its advanced menu item arm with a Vitest witness, and pull request 10, where
   `Module.caseListMenuItem` is first admitted beside forms, brings the advanced module's case list
   menu item, its manifest flip `module-case-list-show-true-on-an-advancedmodule`, the CommCare Supply
   effect and `targeted-commtrack-advanced` (§3, §4). Part 05 withdrew its request to sit beneath 7.
2. **A held slot lands with the stored concept it holds, and the writer of holds lands in pull request
   5** (R2). A query repeat's `placement` lands in pull request 3 with the query placement; a case
   operation's `placement` and `Form.ownClosePlacement` in 4 with the operation model, with
   `planPlacements` reading a hold first and the allocator reserving held paths; a module's `heldKind`
   in 7 with its `module-kind` target, where part 02 places them (part 02 decision 5). In 3 and 4 only
   test fixtures and specs write a hold. `holdPlacements` with the case operation, own close and query
   repeat targets, the held-placement validator rules and the moves land in 5 (§3).
3. **The kernel rule `lib/db/placementAuthority.ts::placementChangeRefusal` lands its editor half in
   pull request 5**, beside `holdPlacements`, with its two arms (R3: a move of a hold the same batch
   makes inexpressible, and the restore of exactly the hold the target's latest recording wrote) and
   its reader `lib/db/placementRecords.ts::readRecordedPlacementHolds`, as part 03 §3 writes it; pull
   request 6 admits `publish-placement` beside `blueprint-migration` and reads its rows as recordings
   (part 01 §29 left the call to this part).
4. **Subtree `CLAUDE.md` sentences move with the behavior that makes them false**, in the feature pull
   request, so every subtree contract is true at every head; the root `CLAUDE.md`'s rows do the same.
   `docs/architecture/contracts.md`, `docs/architecture/complex-apps.md` and every public docs page
   land in pull request 15, with one recorded exception: the notice's two public passages land in
   pull request 14, because a notice row names what changed from the moment the cutover commits (§8).
   Part 01 §28 places its public pages and the contracts attachment row there too.
5. **`MODEL_CONTEXT_VERSION` moves eight times** (2, 3, 4, 5, 7, 10, 11, 13), each to
   `"v6-hq-round-trip-case-writes.<n>"`; the stack deploys `.13`. **`RUNTIME_VERSION` moves once**, 17
   to 18, in pull request 3. **Three ledgered migrations** land in pull requests 6, 8 and 14 and sort
   in that order (resolution 11).
6. **The billed schema check is asked once, at pull request 13's head** (R11), naming every
   `scripts/test-schema.ts` entry any pull request of the stack added or changed, nineteen by part 07
   §4.8, with the served-schema hash run between `main` and that head adding any tool the list misses;
   no other pull request runs it. `scripts/test-schema.ts` goes from 55 entries to 61.
7. **Every pull request runs the lane's 13.5-minute row of 12 shards** (part 08 §8.2), and the served
   readers run by hand on GitHub's runners at the heads of pull requests 1, 2, 3, 4, 7, 9, 10 and 11
   and once at the top before the merge (part 08 §8.4). Pull request 1 is settled on its own branch
   before the stack is cut.
8. **The cutover (14) runs before the merge** from a maintenance image built by hand from pull request
   15's head, with its own Job `commcare-nova-hq-round-trip-case-writes`, no media bucket and no KMS
   key (part 09); `git diff --stat <15>..<16> -- lib app ':(exclude,glob)**/__tests__/**'` names only `lib/db/designSessions.ts`.
9. **The exit is checked by machine after the merge and the first nightly** (§11): the registers at
   known 0 and fixed 1,017 with `OPEN_DEFECTS` `{}`, the lane and the first nightly green, the cutover's
   postconditions, the served contract, and the plan gone.
10. **The research's contracts table rows for step 5 are each rewritten where `main` still says them**,
    and the three rows `main` already makes false (the `__nova_` count container, the
    `__nova_subcases` spelling, the `__nova_operations` sentence) are recorded as claims corrected
    with no step 5 change (§7.1).
11. **The `../nova-plugin` change is one pull request, opened beside pull request 13**, version
    `2.3.0` to `2.4.0`, merged only after the deploy of the stack's merge commit is live (§10).
12. **The production scan's findings are folded in as decisions** (R20): production holds a follow-up
    form whose case operation closes its own case, so the cutover's C9 has work at the window (§1);
    it holds a published deployment with an unread baseline, so `placements-kept-unread` applies; and
    it holds no capture write, no carried extension create, no same-type basic child and no link to an
    unoffered submenu, so those classes ship and the advisory dry run counts what an author adds before
    the window. The classes the scan did not count keep both outcomes, decided by the dry run.

## 1. The stack

One `gh stack` chain of sixteen pull requests on the latest `origin/main`, merged together for one
deploy. Each row's checks are in addition to the repository's ordinary checks at that pull request's
own head: typecheck, lint, Vitest with Postgres, the production build, the pull request lane in CI, the
Playwright smoke and the Python infra tests. No row runs a served reader on the person's machine.
"Register" counts entries by id: "moves" are entries that leave `proof/known-defects.json` for
`proof/fixed-defects.json`, each on its retained control (part 08 §2.3). No step 5 pull request adds a
live entry (part 08 §2.6). "Lane" is part 08 §8.2's row: pull request 1 changes the observation's
partition (`proof/store/queue.py`) and a stacked pull request never reads its base's records
(`proof/ci/store-keys.mjs`), so every pull request runs the 13.5-minute row of 12 shards on every push,
plus the targeted documents it adds.

The cutover is one pull request (14), written against the head gate, the head reducer and the head
planners. The "Cutover" column names the classes, blockers and notice reasons whose behavior the row
brings; every one of them is written in pull request 14 (part 09). "Parts" names every part that writes
into the pull request; the decisions' table named the owners, and this column adds the parts whose
forced or reading changes ride along.

| # | Title | Parts | Contains | Register, corpus | Cutover | Lane | Checks |
|---|---|---|---|---|---|---|---|
| 1 | Lane mechanics | 08, 09 | `_cheapest_edited` falls back to a control (part 08 §1.1); identity moves scoped to migration witnesses (`documents` key) and the eight witnesses with their pre-step A retained under `proof/migrations/<id>/` and HQ's reads under `proof/hq-reads/targeted-migration-*`, the second commit of G1 (§1.2); the capture's placement record hook, recording nothing and applied by nothing until 6 (§1.3); the verdict key `minimumConfiguration.commtrackEnabled`, read only (§1.4; `flagsOff` is 8's, R8); a run by hand may name a control, `mechanics=control:<id>` (§1.5); the cutover's pre-step fixtures under `scripts/lib/hqRoundTripCaseWrites/__tests__/fixtures/pre-step/` (the eight witnesses' documents and part 09's seven planner fixtures), with `facts.json` and `digests.json`, `fixtures.capture.test.ts` holding each to `main`'s schema and absolute gate and recording the facts `main`'s code derives, and `fixtures.digest.test.ts` (part 09 §5, R17). `git diff --stat main..<1> -- lib app ':(exclude,glob)**/__tests__/**'` is empty | none; corpus 398 to 406 (the eight witnesses) | brings the pre-step fixtures every class's planner test reads | 13.5 min, 12 shards, plus the eight witnesses | part 08 §1.7's tests; G1 of part 08 (the retained A, outcome A, B or C); by-hand row 1 (part 08 §8.4) |
| 2 | Attachment mode removed | 01, 03, 07, 08 | `CAPTURE_CASE_WRITE_MODES`, `CaptureCaseWriteMode` and `captureCaseWriteSchema` deleted, the attachment branches of emission, `case-attachments` and its `MM_CASE_PROPERTIES` probe question leave (part 01 §10.1); `lib/domain/attachmentSlots.ts` and the rule `CASE_LIST_COLUMN_OVER_ATTACHMENT_SLOT` leave (part 01 §28); `linkWriteIsShown` loses its mode test (part 03); the builder's What reaches the case chooser and `caseWrite.mode` on the tools leave (part 07 §3.2, §4.2); the fixture mapping for the eleven attachment-mode documents (part 08 §4.2); `CaseCaptureRuntimeTest` as link writes; the attachment witness migrated; its identity move (G6); `fixtures.capture.test.ts` deleted, the fixtures staying under `fixtures.digest.test.ts` until 16 (R17); `MODEL_CONTEXT_VERSION` `.2` | moves d23 79: known 271 to 192, fixed 746 to 825; `OPEN_DEFECTS` drops 23; corpus 406 | brings classes C4 and C5 (a capture write loses its mode; an attachment write becomes a link write), reason `capture-saves-link`, deployment reason `case-attachments-stop`; production holds no capture write today, and the dry run counts any an author adds before the window | 13.5 min | part 01 §24's pull request 2 tests; `CaseCaptureRuntimeTest`; by-hand row 2 (defect 23's ten `formplayer` entries on their controls only, G2) |
| 3 | Repeats: query placement and whole-number counts | 04, 07, 08 | the query-repeat placement rule and both emissions, model iteration in Vellum's spelling and the count placement (part 04 §1.3 to §1.6, §1.8); the query repeat's held `placement` slot, kept out of `addField`, `updateField` and a duplicate, emitted held or else effective, and written only by specs until 5 (R2, part 04 §12); a count is a whole number, `REPEAT_COUNT_TYPE` from the checker's `whole-number-count`, a direct count read where it is one (§2); Preview plays both placements and the direct count; `RUNTIME_VERSION` 18; the guide, `FIELD_DOCS` and `repeat` `saDocs` (part 04 §8.4, part 07); `MODEL_CONTEXT_VERSION` `.3`; the fuzz mapping's defect 30 item and its test; `ContainerRuntimeTest`, `RepeatCountRuntimeTest`; `targeted-query-repeat-placements`, `targeted-repeat-count-whole`; the census test; the two witnesses migrated and their moves (G6) | moves d25 101 and d30 4: known 192 to 87, fixed 825 to 930; `OPEN_DEFECTS` drops 25 and 30; corpus 408 | brings Q1 (a published query repeat held through this pull request's slot), Q2 and Q3, reasons `repeat-rows-follow-query`, `repeat-count-whole-number`, `repeat-count-node-removed`; the scan found query repeats in the count placement, some published, and a count read directly from a Hidden Value, and no count needing a wrap, which Q2 keeps for the dry run; a query repeat reading its own rows or whose condition stops type-checking at the row meets `target-gate` as a blocker by rule (part 09 §16) | 13.5 min | part 04 §9's first group; the corpus emission at base and head (the count rule narrows); by-hand row 3 (defect 25's 61 served entries on their controls only) |
| 4 | Case writes as one concept | 01, 02, 03, 07, 08 | `Field.caseWrite` leaves; the own arm, the write with `via` and `onlyIfChanged`, the `worker-record` target, `capture-link`, open and close conditions as `Expression`s, the field's view `fieldCaseWriteViews` and its planner `planFieldCaseWrite`, the explicit preload (part 01 §3 to §11); the placement shapes' basic and Save to Case arms (`casePlacementSchema`, `ownClosePlacementSchema`), `placement` on operation arms and `Form.ownClosePlacement` as stored slots excluded from every mutation payload, `planPlacements` reading a hold first and the allocator reserving held paths, with `placementExpresses`, `placementCandidates` and `placementIneligibility` (part 01 §12, this part's decision 2, R2, R7); a field-written extension create placed at `{save-to-case, [nova_subcases, nova_subcase_<n>]}` through pull request 6 (R5, part 02 §14.4); `casePlacementPlan.ts::planFormCaseWire` with its basic and Save to Case arms (part 02 §3); the operation identity module `lib/domain/caseWriteOperationIdentity.ts` (part 09 §10.1); the new and retired codes (part 01 §17); `VIEW_FORM_ATTACHMENT` over link writes, asked where a case list or detail column shows one through any relation or a form prints one, with the `attachment-links` reason "The app shows a link to a captured file in a case list, its details or a form." (part 03 §10); the submission program carrying the own case's change (part 01 §19); the forced builder and tool changes (part 01 §16.5, part 07 §5); `getCaseOperations`, `removeCaseOperation`, `moveCaseOperation` registered in `scripts/test-schema.ts`; `MODEL_CONTEXT_VERSION` `.4`; the fixture mapping through `lib/doc/fieldWriteOperations.ts::operationsFromFieldWrites` and `lib/doc/explicitPreloads.ts::planExplicitPreloads`; `targeted-case-writes-one-concept`; `targeted-load-time-values` and the two close-condition documents rewritten; the case-writes and groups-preloads witnesses' operation holds stored and their moves (G6) | moves d28 3: known 87 to 84, fixed 930 to 933; `OPEN_DEFECTS` drops 28; corpus 409 | brings C1 to C3 and C6 to C8 (the own arm, child writers into creates, the worker-record update, the close condition as an expression, explicit preloads, placements from each published deployment's baseline with `placements-kept-unread` for an unread one), reasons `starting-value-reads-case` and `load-time-value-reads-case` (the scan found both); C9, which the scan found work for, with its cause `own-close-moved` and blocker `own-close-in-repeat`, and C10 and C11 as the dry run counts them (below); blockers `placement-path-mismatch` and `baseline-unreadable` (R14) | 13.5 min | part 01 §24's pull request 4 tests; `CaseOperationRuntimeTest` (part 01's G1); the corpus emission at base and head (no wire byte moves on a migrated document but `targeted-load-time-values`, part 01 §18); by-hand row 4 (part 01's G3, `case-operation-link`'s stop) |
| 5 | Held placements and identity moves | 01, 03, 04, 07, 08 | `holdPlacements` with the targets case operation, own close and query repeat (part 03 §2, R2); the editor half of `placementChangeRefusal` with its arms (a) and (b), `readRecordedPlacementHolds`, and its call in the canonical kernel (part 03 §3, R3); `HELD_PLACEMENT_INEXPRESSIBLE`, `CASE_PLACEMENT_SHARED`, `HELD_BLOCK_PATH_TAKEN`, `QUERY_REPEAT_MODEL_ITERATION_SHAPE`'s held arm (part 01 §13, part 04 §1.7); `describeCaseOperation` (part 01 §14); `lib/doc/placementMoves.ts`, `lib/doc/queryRepeatPlacement.ts`, `lib/doc/identityMoves.ts::withIdentityMoves` and `IdentityMoveDialog` on every dispatch, review, undo and redo; a history step carrying exactly the hold changes the kernel admits, over the recorded holds the builder's load carries (part 03 decision 2, part 07 §2.5); `identityMoves` on every SA and MCP staging result and `saveWork` (part 07 §2); the edit kind `holdPlacements`, and the corpus judging a candidate batch by the kernel rule (part 08 §4.4); `targeted-held-placement`; `MODEL_CONTEXT_VERSION` `.5` | none; corpus 410 | none (the cutover writes holds through the slots of 3, 4 and 7) | 13.5 min | part 01 §24, part 03 §20, part 04 §9 and part 07 §9 rows marked 5; `heldPlacements.postgres.test.ts`; `identity-moves.spec.ts`; the hash run names `addFields` and `editField` alone (`repeat_mode`'s published sentence, part 07 §4.7) |
| 6 | Publish placements | 03, 07, 08 | migration `20261110000000_hq_round_trip_case_writes_publish_placement`; the `publish-placement` kind, `EDITOR_APP_CHANGE_KINDS` and `COLLABORATION_FRAME_KINDS` (part 03 §4); `placementsToHold` and `recordPublishPlacements` before anything is sent, the head fence, `reloadHead` (§5); the kernel rule's `publish-placement` arm (§3); the frame fold and the placement conflict through the builder's `onPlacementConflict` handler, `components/builder/placementConflictReplay.ts::replayAfterPlacementConflict` over the pure `lib/doc/identityMoves.ts::planConflictReplay`, with part 07's conflict lead (§6, part 07 §2.6); the `save-to-case` offer and MCP's `accept_placement_moves` (§7); `lib/commcare/hq/publishedCaseBlocks.ts` (§11); downloads record nothing (§13); the capture records the first publish's holds, the first publish's capture moved ahead of edit planning in `proof/corpus/emitCorpus.ts` and `entryWriter.ts`, and D′ is planned over them (part 08 §4.5) | none; corpus 410 (the capture's record moves the key of every document with a case operation, an own close or a query repeat) | brings the definition of a published deployment (one whose live mapping is marked remote-missing counts, R14) and `publishedCaseBlocks`, which C8 and Q1 read; production holds published deployments, an unread baseline among them, so `placements-kept-unread` applies (decision 5, R13), and no published baseline names `nova_subcases` | 13.5 min | part 03 §20's pull request 6 tests; `heldPlacementEmission.test.ts` (emission equal with derived holds applied); `publishPlacementKind.postgres.test.ts` over a decoy schema and production's heap order; the multiplayer spec |
| 7 | Advanced modules and extension child cases | 02, 03, 07, 08 | the advanced arm of `planFormCaseWire`, `moduleKind.ts::emittedModuleKind` with its two triggers (a held kind, a carried create no basic placement gives a datum) and four kind blockers, `Module.heldKind` and the `module-kind` arm of `holdPlacements` (part 02 decision 5), `AdvancedModule` and `AdvancedForm` in HQ's own key sets, tags, eligibility in `advancedPlacement.ts`, the loads derived from the parent selection (`advancedSelections.ts`, no stored `Form.caseSelections`, R4), datums on both paths, `nova_owner_<op>`, `FORM_LINK_NEEDS_NEW_CASE_DATUM` (part 02 §3 to §16); `planPlacements` taking `moduleKind`, calling `loadIneligibility` and `openActionIneligibility`, with the carried-create clause, the interim extension branch removed (R5); no case list menu item beside an advanced module's forms until 10 (R1); defect 24: an extension child is a create with an `extension` link, the inert subcase goes, basic subcases renumber (§14); `subcaseWire.ts` deleted; `lib/doc/moduleKindMoves.ts` into `withIdentityMoves`; the advanced platform rows (§20); the add-ons (§18); the module-kind target's reading surfaces (part 07 §5); `MODEL_CONTEXT_VERSION` `.7`; the manifest flips and value-class readers (part 08 §7.1, §7.2); `AdvancedFormRuntimeTest`, `test_advanced_emission.py`, `proof/hq/test_advanced_rules.py` over part 02's shared fixture; six targeted documents (`targeted-advanced-module`, `targeted-extension-carried`, `targeted-advanced-child-module`, `targeted-advanced-held-kind`, `targeted-root-case-block-names`, `targeted-worker-underscore-write`); the gate effects of G4 (part 08) | moves d24 26: known 84 to 58, fixed 933 to 959; `OPEN_DEFECTS` drops 24; corpus 416 (415 under part 02's G4 outcome B) | brings M1 to M3 (extension children, a carried create made advanced or, where a kind blocker holds, its link retargeted), reasons `module-made-advanced` and `form-link-goes-to-menu`; production holds extension children in unpublished apps only and no carried create, so no module becomes advanced there today, and the dry run counts any an author adds | 13.5 min | part 02's tests; the corpus emission at base and head; part 02's G2 (HQ keeps the advanced JSON) in this lane's proof 4; part 08's G4; by-hand row 7 |
| 8 | CommTrack and same-type child links at publish | 02, 03, 08 | migration `20261110010000_hq_round_trip_case_writes_commtrack_confirmation`; `commtrack-off` with `commtrackReasons`, `COMMTRACK_OFF` and `confirm_commtrack_off` (part 03 §9), the menu item arm reading a menu item wherever a module holds one (only a formless one until 10) through part 02's `advancedModulesWithCaseListMenuItem`, its advanced arm held by a Vitest witness until 10 (R1); the capability `same-type-child-links` read through `featureFlagsOff`, the `same-type-child-links` offer, reading `sameTypeBasicChildCases` (§7.3, §8); the same-type exclusion lifted from basic subcase eligibility; the corpus verdict writes `commtrackEnabled: false`, and the key `flagsOff` is read and written from here (R8); `targeted-same-type-child`, `targeted-supply-point-text`; `publishChecks.test.ts`; `test_flag_probe.py` with the flag | none; corpus 418 | extends `next-publish-asks-more` with `commtrack-off` and `same-type-child-links`; production holds no same-type basic child today, and the planning scan did not count a published form holding the supply-point text, so the dry run decides both lines | 13.5 min | part 03 §20's pull request 8 tests; part 03's G2 to G4 in this pull request's lane (no served reader); part 03's G1 (part 08's G4) runs in pull request 7's lane and pull request 10's (rows 7 and 10) |
| 9 | Groups and labels: field lists and plain labels | 04, 08 | `group.fieldList`, its birth rule, `FIELD_LIST_USER_REPEAT` and the field-list arm of `fieldPlacementVerdict`; `question-pages` read from `fieldList`; `plainLabel` on question, container and section labels and on inline choices, the `markdown` itext form written by it; the feature `plain-text` with its rows and cells (part 04 §3, §4); the fuzz mapping's defect 27 item; `targeted-field-list-flags`, `targeted-plain-labels`; `test_form_reads.py`'s plain-label test (part 08 G5) | moves d27 3: known 58 to 55, fixed 959 to 962; `OPEN_DEFECTS` drops 27; corpus 420 | brings Q4 and reason `group-shows-one-per-screen`, which the scan found applies (labelled groups holding a user repeat); a section holding a user repeat is refused by the gate at `main` and at the head alike and meets `target-gate` (part 09 §7.11), and production holds none | 13.5 min | part 04 §9's third group; the corpus emission at base and head (the field-list rule narrows); `platformFeatures.test.ts`, `platformCells.test.ts`; by-hand row 9 with G5 |
| 10 | Search workflow, menu concepts and claims | 05, 02, 07, 08 | `caseSearchConfig.workflow?: "listFirst" \| "skipToResults"` and `formsReadSearch?: true`, `searchWireShape` as a total mapping, the five platform rows and `HISTORICAL_PLATFORM_CAUSE_WORDS`, the renamed codes, `Module.caseListMenuItem` admitted beside forms, `Module.caseListRegistrationForm`, a claim as a `commcare-case-claim` row with **Release claimed cases** (part 05 §3 to §11); part 02's readers moved from `caseListOnly` to `moduleHasCaseListMenuItem` and `moduleFormsReadSearch`, the advanced module's case list menu item emitted beside its forms, `commtrackReasons`' menu item arm reading `moduleHasCaseListMenuItem`, and `module-case-list-show-true-on-an-advancedmodule` flipped with decision 6's reading (R1); `lib/doc/searchWorkflowPlan.ts::authoredSearchWorkflow` (R7); the forced surfaces (part 05 §12, part 07 §5) in part 07's words (R9); `MODEL_CONTEXT_VERSION` `.10`; the fixture mapping and the fuzz item; five targeted documents (`targeted-search-workflow`, `targeted-search-workflow-inline`, `targeted-search-workflow-android`, `targeted-case-list-menu-item`, `targeted-commtrack-advanced`); `test_search_workflow_offers.py`; G4's menu item effect (part 08) | moves d21 37: known 55 to 18, fixed 962 to 999, or 55 to 19 and 962 to 998 under part 08's G3 outcome B; `OPEN_DEFECTS` drops 21 (or keeps it until 11); walk stops 25, or as part 08's G2 adds; corpus 425 | brings M1 to M5 and reason `menu-opens-on-search` with its `detail.opensOn` (R18), which the scan found applies (list-first searching menus in apps declaring Web Apps); the claim type's case-schema row (M6) is written by the drift writer after the deploy (R16); the scan found no module holding two no-matches forms and no dead case list media, and did not count M1's last row or the no-matches label's overlay entries, so the dry run decides those | 13.5 min | part 05 §16; the corpus emission at base and head; decision 6's run (part 05's G1); part 08's G4 over `targeted-commtrack-advanced` (part 03's G1, its menu item half); by-hand row 10 with part 08's G2 and G3 |
| 11 | Form links | 06, 07, 08 | destinations in the author's order emitted reversed, `Form.otherwise` and `setFormOtherwise`, `this-form`, the held-case guard, offered targets, the retired and new codes, Preview's after-submit stack per platform (part 06 §3 to §12); the whole after-submit builder surface with the otherwise and the tool `set_form_otherwise`, in part 07's copy (R12); the form link tools and `setFormOtherwise` registered with `moveFormLink` and `removeFormLink`; `MODEL_CONTEXT_VERSION` `.11`; the edit kind `setFormOtherwise`; `FormLinkRuntimeTest`; `test_form_link_targets.py`; three targeted documents (`targeted-form-link-chain`, `targeted-form-link-carried-case`, `targeted-form-link-otherwise`) and three producer documents (the wire fixture's `this-form`, `chain` and `carried-held` scenarios); `mapFormLinkSemantics`, total under every outcome of part 06's G3 (R19); the form-links witness migrated | moves d26 18: known 18 to 0, fixed 999 to 1,017; `OPEN_DEFECTS` becomes `{}`; corpus 431 | brings L1 to L7, reasons `form-links-conditions-written`, `form-link-otherwise-set` (with its `from` detail, R18), `after-submit-destination-dropped`, `form-link-target-moved`, `form-link-datums-dropped`, and `form-link-removed` for L4's off-the-menu arm (below); the scan found L3's two arms, and L1, L2, L4, L5 and L6 meet no production app today | 13.5 min | part 06 §17; `formLinkSemanticsMap.test.ts` (every existing app behaves the same); part 06's G1 to G3; `test_every_live_defect_is_a_later_steps` with `step > 5`; by-hand row 11 |
| 12 | Builder | 07, 04 | the case changes, Saves to, This form's case, Show on one screen, Format text, the Rows editor and the other new controls (part 07 §3.2 to §3.14, its pull request 12 row) | none | none | 13.5 min | part 07 §9's rows marked 12; `case-writes.spec.ts`, `builder-controls.spec.ts`; the hash run shows no tool moved |
| 13 | Agent | 07 | the new authoring inputs and descriptions, the final guide, `group` `saDocs` (part 07 §4.2, §4.5, §4.6); `MODEL_CONTEXT_VERSION` `.13`, the value the stack deploys; the billed `npm run test:schema` asked once, over every entry any pull request of the stack added or changed (§5, rule 7, R11); the `../nova-plugin` pull request opened beside it | none | none | 13.5 min | part 07 §9's rows marked 13; the hash run at `main` and at this head names the moved tools of part 07 §4.8 |
| 14 | Cutover | 09, 03 | part 09 whole: the scan and migrate scripts, `scripts/lib/hqRoundTripCaseWrites/`, the transform in step order with part 03's frozen classifier for unread baselines, the query repeat exception (R13), the reason `placements-kept-unread` and the blocker `baseline-unreadable` (R14) in part 09's files, the fold horizon migration `20261110020000_hq_round_trip_case_writes_fold_horizon`, the three migrations in one ledger phase inside the fleet transaction, `catalog.ts`, the postconditions, the notice (`hq-round-trip-case-writes`, its lead, its document and deployment reasons), the Job contract and its allowlist arm, the bundle line, `abandonPreAppDesignSessionInTransaction` and `reapStaleDesignSessionRun` exported, the runbook `docs/plans/hq-round-trip/5-cutover-runbook.md`; the notice's two public passages (§8) | none | every class, blocker and reason part 09 registers, in its order | 13.5 min | part 09's tests (`catalog.postgres.test.ts`, `writer.postgres.test.ts`, `scan.postgres.test.ts`, `holders.postgres.test.ts`, `caseWritesLedger.postgres.test.ts`, the pure suites, the infra tests); `/code-review medium` names `catalog.ts`, the postconditions and `catalog.postgres.test.ts` first |
| 15 | Contracts and public docs | 10 | every contract row of §7 marked 15, the public docs of §8, the README's count tables, `proof/timings.json`'s `no-readers` profile from this head's fresh dispatch (part 08's G7), the `../nova-plugin` pull request's link and the repeated sweep (§10). The maintenance image is built from this head | none | none | 13.5 min | the docs build; §G1 to G3 below; `projectSpaceCompatibilityBoundary.test.ts`; `OPEN_DEFECTS` names no defect |
| 16 | Removal of the cutover tooling and of this plan | 09, 10 | both scripts and `scripts/lib/hqRoundTripCaseWrites/`, the bundle line and `.dockerignore` lines, the Job contract, the allowlist arm with `PLAN_DIGEST_RE` and their infra test rows, `runHolderWriteGuard.test.ts`'s allowlist entry for the cutover's writer, the `scripts/README.md` entry, the `docs/architecture/deployment.md` paragraph, the runbook, this plan and its part directory; the two `designSessions.ts` exports private again; the plans `README.md`'s "Step 5 is done" (§9) | none | none | 13.5 min | infra tests without the tool; no file names `5-case-writes-forms-navigation` or `5-cutover-runbook`; `git diff --stat <15>..<16> -- lib app ':(exclude,glob)**/__tests__/**'` names only `lib/db/designSessions.ts`; the first nightly after the merge is the whole lane with every reader |

Two rows above carry what the production scan decided (R20), as part 01 §26, part 06 §14.4 and part 09
§7.4, §7.5 and §19 write it:

- **Pull requests 4 and 14, a case operation that closes or overwrites the form's own case** (part 01's
  scan classes (a), (f) and (g)). The scan found class (a): production holds follow-up forms whose
  case operation closes the form's own case. So the rules of part 01 §5.3 and §12.2 land in pull
  request 4, and pull request 14's transform runs C9 as part 09 §7.4 writes it (R15): each such
  follow-up becomes a close form whose close condition is the `or` of the close it had and each such
  operation's condition; an operation with no writes is removed and one holding writes stays as an
  `update` on the own case with its condition and its Save to Case path; in a published app the own
  close is held through `ownClosePlacement` at the path the first removed operation had, so no wire
  byte moves, and where every such operation held writes the own close takes its simplest placement
  and the deployment line names the cause `own-close-moved`; an operation under `forEach` is the
  blocker `own-close-in-repeat`, the author's to repair in today's builder before the window. Update
  operations on the own case stay operations (part 01's class (e)); only C10 removes a duplicate write.
  The scan did not count classes (f) and (g), or session close operations under `forEach` or holding
  writes, so C10, C11 and C9's two other arms keep both outcomes, decided by the advisory dry run:
  where it finds none, that class writes nothing and stays in the transform as a guard; where it finds
  some, the class runs over those apps as part 09 writes it (under (g), the cause
  `case-changed-before-create` joins `form-data-paths-move`). The rules land in pull request 4 either
  way, because the cutover runs the head gate.
- **Pull requests 11 and 14, a link to an unoffered submenu whose parent is off the menu** (part 06
  §14.4). Production holds no such link today, and nothing at `main` refuses the shape, so an author
  can still make one before the window and the dry run counts it. The map keeps its transform and
  stays total: it removes each such link (the change `link-removed`) and normalizes the form as
  `planFormLinkRemove` does, and part 09 registers the document reason `form-link-removed` after
  `form-link-target-moved` with part 06's copy. No form-link blocker is registered.

Totals the stack reaches (part 08 §2.5): `proof/known-defects.json` goes 271, 192 (2), 87 (3), 84 (4),
58 (7), 55 (9), 18 (10), 0 (11); `proof/fixed-defects.json` goes 746, 825, 930, 933, 959, 962, 999,
1,017. Under part 08's G3 outcome B, pull request 10 leaves one defect 21 entry live (19 and 998) and
pull request 11 moves it with defect 26's, so both registers reach the same exit. `OPEN_DEFECTS` loses
23 (2), 25 and 30 (3), 28 (4), 24 (7), 27 (9), 21 (10, or 11 under G3 outcome B) and 26 (11), and is
`{}` from pull request 11. `proof/controls/` stays 108 and `proof/walk-stops.json` 25, unless part 08's
G2 adds a stop in pull request 10 (its outcome C). `proof/migrations/` holds eight witnesses from pull
request 1. The corpus gains thirty targeted documents (1: 8, 3: 2, 4: 1, 5: 1, 7: 6, 8: 2, 9: 2,
10: 5, 11: 3) and, in 11, three form-link producer documents (part 06's `this-form`, `chain` and
`carried-held` scenarios), thirty-three in all, from 398 to 431 (part 08 §5.1); under part 02's G4
outcome B, `targeted-worker-underscore-write` leaves in 7 and every count from 7 is one fewer. It keeps
its fuzz draws, mapped after the draw (part 08 §4.3).
`MODEL_CONTEXT_VERSION` moves in 2, 3, 4, 5, 7, 10, 11 and 13; `RUNTIME_VERSION` once, in 3.
`scripts/test-schema.ts` gains three entries in 4 and three in 11, 55 to 61. The stack's three ledgered
migrations are 6's, 8's and 14's, applied in the window in one phase (part 09).

## 2. Files, by pull request

This is the list an implementer holds a pull request's diff against. Under each pull request it names
every file the parts' "Files by pull request" sections and text give it, merged; where two parts list
one file for one pull request, its entry carries both changes. Paths are written from the repository
root. A file is marked "new", "renamed" or "deleted" where the pull request makes it so.

Six kinds of file are given once, here. A source file stands for its tests in the `__tests__`
directory beside it unless a test is named. A pull request that moves a register entry edits
`proof/known-defects.json`, `proof/fixed-defects.json` and, where a defect's last entry leaves,
`proof/checks/registers.py::OPEN_DEFECTS`, and rewrites that defect's row in `proof/README.md`, "The
defect rows" (part 08 §9.1). A pull request that adds a targeted document edits
`proof/targeted/index.ts`, `proof/timings.json` (the `no-readers` profile's estimate for the new
group) and `proof/README.md`, "Targeted documents". A manifest flip edits its inventory row under
`docs/research/2026-09-26-hq-round-trip/inventory/` in the same pull request. A pull request that holds a
gated run completes that run's bullet in `harness-findings.md`, "Found while planning step 5", with its
outcome (§9). A `CLAUDE.md` file or a public docs page is listed under the pull request that §7 and §8
assign it.

And **every importer of a module a pull request deletes, moves, renames or re-signs is re-pointed in
that pull request**, tests, fixtures, scripts, lane producers and comments included, because each pull
request is green at its own head. Their list is a command run at the pull request's base:

```
rg -l -e '<dir>/<name>\b' -e '"\./<name>"' -e '"(\.\./)+<last>(/<name>)?"' \
  lib app components proof scripts e2e __tests__
rg -l -w -e '<export 1>' -e '<export 2>' … lib app components proof scripts e2e __tests__
```

Each hit is read, since a relative hit can name another directory of the same last segment and a
symbol hit can be a same-named local. The modules step 5 deletes or renames, each re-pointed this way
in its pull request: `lib/domain/caseWriteInventory.ts`, `lib/domain/closeCondition.ts`,
`lib/commcare/caseWriteFindings.ts`, `caseWriteAdmission.ts`, `deriveCaseConfig.ts`,
`lib/doc/hooks/useCloseConditionPlacement.ts`, `components/builder/editor/fields/PreloadedValueRow.tsx`,
`components/builder/detail/formSettings/CloseConditionSection.tsx` (4); `lib/commcare/subcaseWire.ts`
(7); `lib/doc/searchNoMatchesForm.ts`, `searchNoMatchesDependents.ts`,
`lib/commcare/validator/rules/case-search/searchFirst.ts`, `searchNoMatches.ts`,
`lib/preview/formlessCaseListRoute.ts`, `noMatchesForm.ts`, `lib/session/previewClaims.ts`,
`lib/agent/tools/shared/formEntry.ts`, `components/builder/case-list-config/canvas/NoMatchesFormSetting.tsx`,
`noMatchesFormReview.tsx` (10); `lib/domain/formLinkGraph.ts`,
`components/builder/form-links/FallbackChooser.tsx` (11).

### Pull request 1: Lane mechanics

**The lane** (part 08 §1)

- `proof/checks/test_judge_purity.py` (`_cheapest_edited`), `proof/checks/registers.py` (`MOVE_KEYS`, `IdentityMove`, `load_identity_moves`, `accepted_moves`), `proof/checks/test_registers.py`, `proof/checks/test_proof1_identity.py`
- `proof/checks/corpus.py` (`Document.migration_witness`, `verdict_lacks`), `proof/checks/cases.py` (`document_params`), `proof/checks/bar.py`, `intent.py`, `manifest_usage.py`, `proof/checks/controls.py` (`--migration-a`), `proof/checks/sensitivity.py`, `proof/checks/proof5.py` (docstrings), `proof/checks/test_corpus.py`, `test_sensitivity.py`, `test_proof5_locality.py`
- `proof/store/queue.py`, `proof/store/test_queue.py`, `.github/workflows/proof-audit.yml` (the `mechanics` input's description)
- `proof/corpus/publish.ts` (`retainedA`, the `commtrackEnabled` verdict key, the placement record hook), `proof/corpus/targetPeer.ts`, `proof/corpus/entryWriter.ts`, `proof/corpus/inputs.ts`, `proof/corpus/emitCorpus.ts`, `proof/corpus/__tests__/publish.test.ts`, `emitCorpus.test.ts`
- `proof/targeted/build.ts` (`migrationWitness`), `proof/targeted/documents/migrations.ts` (new: the eight pre-step specs), `proof/targeted/index.ts`, `proof/targeted/__tests__/targeted.test.ts`, `proof/hq/test_retained_reads.py`
- Second commit, from G1 of part 08: `proof/migrations/<the eight>/` (new) and `proof/hq-reads/targeted-migration-*/` (new)

**The cutover's fixtures** (part 09)

- `scripts/lib/hqRoundTripCaseWrites/__tests__/fixtures/pre-step/*.json` (new: the eight witnesses' documents, written from the emitted `document.json`, and `pre-step-own-close-operation`, `pre-step-duplicate-own-write`, `pre-step-registration-updates-own`, `pre-step-renamed-concepts`, `pre-step-search-results`, `pre-step-otherwise-unoffered`, `pre-step-preload-readers`), `fixtures/pre-step/facts.json` and `digests.json` (new), `scripts/lib/hqRoundTripCaseWrites/__tests__/fixtures.capture.test.ts` (new, deleted by 2), `fixtures.digest.test.ts` (new, kept to 16). No `lib` or `app` file (part 09 §5)

**Docs**

- `proof/README.md` ("Identity moves", "A, B and B-edit", "Configurations", "The run started by hand", "Targeted documents"; part 08 §9.1), `proof/CLAUDE.md` (the witness bullet; part 08 §9.2)

### Pull request 2: Attachment mode removed

**Nova source**

- `lib/domain/fields/base.ts`, `image.ts`, `audio.ts`, `video.ts`, `signature.ts`, `file.ts`, `index.ts` (`CAPTURE_CASE_WRITE_MODES`, `CaptureCaseWriteMode`, `captureCaseWriteSchema` deleted); `lib/domain/attachmentSlots.ts` deleted, with `lib/domain/index.ts`'s export and the rule `CASE_LIST_COLUMN_OVER_ATTACHMENT_SLOT` (`lib/commcare/validator/rules/case-list/columnKindPropertyType.ts`, `lib/commcare/validator/errors.ts`, `gate.ts`, `lib/doc/userFacingErrors.ts`) and its tests (part 01 §28)
- `lib/commcare/formActions.ts`, `lib/commcare/xform/caseOps.ts`, `lib/commcare/xform/caseBlocks.ts` (the attachment branches), `lib/commcare/projectSpaceCompatibility.ts` (`case-attachments` leaves; `linkWriteIsShown` loses its mode test), `lib/publish/projectSpaceCompatibility.ts`
- `lib/preview/engine/formEngine.ts` (`dropCaptureWriters` keeps link writes only)
- `lib/agent/toolSchemaGenerator.ts` (`mode`, `gateCaseWriteMode`, `FIELD_DOCS.caseWrite`), `lib/models.ts` (`"v6-hq-round-trip-case-writes.2"`); the moved `addFields` and `editField` schemas are sent in the one billed run at 13's head (R11), and `scripts/test-schema.ts` does not change here (part 07 §4.8)
- `components/builder/editor/fields/CaseWriteEditor.tsx`, `caseWritePresentation.ts` (the chooser)

**Nova tests named outright**

- `lib/commcare/__tests__/caseBlocks.test.ts`, `formActions.test.ts`, `projectSpaceCompatibility.test.ts`; `lib/agent/tools/__tests__/editField.test.ts`

**The lane**

- the capture sources of part 08 §4.2: `lib/commcare/__tests__/caseCaptureFixture.ts`, `extensionCaseFixture.ts`
- `proof/native/core/CaseCaptureRuntimeTest.java`, `proof/native/producers/*` (the capture evidence)
- `proof/targeted/__tests__/unproducedInputs.test.ts` (the "defect 23 without `MM_CASE_PROPERTIES`" bullet leaves), `proof/targeted/documents/migrations.ts` (the attachment witness migrated), `proof/identity-moves.json` (part 08's G6), `scripts/lib/hqRoundTripCaseWrites/__tests__/fixtures.capture.test.ts` (deleted: attachment mode, the first shape it parses, leaves here; the fixtures stay under `fixtures.digest.test.ts`, R17)
- `lib/commcare/surface/entries/gates.json` (`toggle/MM_CASE_PROPERTIES` keeps its refusal; the probe stops asking it)

**Docs**

- `lib/domain/CLAUDE.md`, `lib/commcare/CLAUDE.md`, `components/builder/CLAUDE.md` (the rows of §7 marked 2)

### Pull request 3: Repeats: query placement and whole-number counts

**Nova source** (part 04 §12)

- New: `lib/domain/queryRepeatPlacement.ts`, `lib/commcare/xform/queryRepeatNames.ts`, `lib/doc/repeatCountWraps.ts` (`planRepeatCountWraps`, kept past pull request 16 for the fuzz mapping, R7)
- Changed: `lib/domain/expression/walk.ts` (`expressionReadsFormAnswers`), `profiles.ts` (`repeat-count`), `context.ts`, `typeChecker.ts`, `formStructure.ts` (`hiddenValueSource`, `heldQueryPlacement`), `lib/domain/repeatCount.ts`, `lib/domain/fields/repeat.ts` (header, `saDocs`, the held `placement` slot), `lib/domain/fields/index.ts` (`HELD_FIELD_KEYS`), `lib/doc/duplicateFieldMutations.ts` (a duplicate starts unheld), `lib/commcare/xpath/formNodeProjection.ts` and every caller part 04 §1.6 names, `lib/commcare/xform/builder.ts`, `generatedNodes.ts`, `lib/commcare/validator/formLogicFindings.ts`, `rules/field.ts`
- Preview: `lib/preview/engine/formEngine.ts`, `triggerDag.ts`, `formExpressionRuntime.ts`; `lib/db/appTests.ts` (`RUNTIME_VERSION` 18)
- Agent: `lib/agent/toolSchemaGenerator.ts` (`repeat_mode`, `repeat_count`), `lib/agent/authoring/reference.ts`, `lib/agent/tools/getField.ts` (`rows`), `lib/agent/summarizeBlueprint.ts`, `lib/models.ts` (`"v6-hq-round-trip-case-writes.3"`)
- `lib/commcare/surface/entries/questions.json` (part 04 §5's pull request 3 rows), `docs/research/2026-09-26-hq-round-trip/inventory/questions.md`

**Nova tests named outright**

- `lib/commcare/__tests__/validationRules.test.ts`, `deepValidation.test.ts`; `lib/preview/engine/__tests__/fixtures/sectionEntry.ts` (the `int(...)` wrap); `lib/mcp/__tests__/servedSchemas.test.ts`; `lib/agent/authoring/__tests__/guideExamples.test.ts`; part 04 §9's first group

**The lane**

- `lib/commcare/__tests__/xformDocArbitrary.ts`, `expressionDocArbitrary.ts` (the defect 30 item), `proof/corpus/__tests__/fuzzSample.test.ts` (the mapping test), the count sources of part 08 §4.2
- `proof/targeted/documents/repeats.ts` (gains `targeted-query-repeat-placements` and `targeted-repeat-count-whole`), `proof/targeted/documents/migrations.ts` (the two witnesses migrated, the query-repeats witness's holds written in its spec), `proof/identity-moves.json`
- `proof/native/core/ContainerRuntimeTest.java`, `RepeatCountRuntimeTest.java` (new), `proof/native/families.py`, `proof/checks/test_corpus.py` (the census test)

**Docs**

- `lib/commcare/CLAUDE.md`, `lib/domain/expression/CLAUDE.md`, `lib/preview/CLAUDE.md`, `lib/agent/authoring/CLAUDE.md` (the rows of §7 marked 3); `proof/README.md` ("The corpus", "Native proofs")

### Pull request 4: Case writes as one concept

**Nova source, the domain and the doc** (part 01 §28)

- `lib/domain/forms.ts` (the own arm, the write and its key, the targets, the conditions, `operationCaseType`, `operationTarget`, `placement?` on every operation arm, `ownClosePlacement?`), `lib/domain/fields/base.ts`, `hidden.ts`, `image.ts`, `audio.ts`, `video.ts`, `signature.ts`, `file.ts`, `index.ts` (`caseWrite` leaves), `lib/domain/caseTypes.ts` (`fieldCaseWrite` deleted), `lib/domain/caseWriteViews.ts` (new), `lib/domain/casePreload.ts` (rewritten), `lib/domain/placements.ts` (new: `casePlacementSchema` with its basic and Save to Case arms, `ownClosePlacementSchema` and the reason tuple), `lib/domain/placementCopy.ts` (new, with part 07), `lib/domain/caseWriteOperationIdentity.ts` (new, part 09 §10.1: the UUIDv5 namespace `operationsFromFieldWrites` calls), `lib/domain/referenceSlots.ts`, `lib/domain/expression/types.ts`, `typeChecker.ts`, `inference.ts`, `profiles.ts`, `children.ts`, `walk.ts` (`capture-link`), `lib/domain/formRecordScope.ts`, `lib/domain/index.ts`
- Deleted: `lib/domain/caseWriteInventory.ts`, `lib/domain/closeCondition.ts`, `lib/commcare/caseWriteFindings.ts`, `lib/commcare/caseWriteAdmission.ts`, `lib/commcare/deriveCaseConfig.ts`, `lib/doc/hooks/useCloseConditionPlacement.ts`
- `lib/doc/types.ts`, `referenceIndex.ts`, `caseOperationMutations.ts`, `caseOperationOrder.ts`, `caseWriteChoices.ts`, `kindConversionCascade.ts`, `casePropertyRenames.ts`, `caseTypeRetirement.ts`, `unwrittenProperties.ts`, `datetimeSplit.ts`, `scaffolds.ts`, `formSectionMutations.ts`, `formSectionVerdicts.ts`, `userFacingErrors.ts`, `diffDocsToMutations.ts`, `expressionText.ts`, `optionRemoval.ts`, `lib/doc/mutations/fields.ts`, `forms.ts`, `modules.ts` (every payload schema omits the held slots), `lib/doc/fieldCaseWriteMutations.ts` (new), `lib/doc/formTypeMutations.ts` (new), `lib/doc/casePlacements.ts` (new), `lib/doc/fieldWriteOperations.ts` (new: `operationsFromFieldWrites` and `FieldWriteFact`, UUIDv5 under the cutover's namespace), `lib/doc/explicitPreloads.ts` (new: `planExplicitPreloads`), `lib/doc/hooks/useCaseOperations.ts`, `useCaseWriteChoices.ts`, `useFieldCaseWrites.ts` (new, part 07), `useCasePlacements.ts` (new, part 07); `biome.json` (the allow-list entry `lib/doc/casePlacements.ts`)

**Nova source, the wire, Preview and the store**

- `lib/commcare/placement.ts` (new: `planPlacements` with its options, held first, the interim extension branch and the same-type exclusion; `placementExpresses`, `placementCandidates`, `placementIneligibility`, R7), `lib/commcare/casePlacementPlan.ts` (new: `planFormCaseWire`, its basic and Save to Case arms, held paths written verbatim, part 02 §3), `lib/commcare/sameTypeChildCases.ts` (new: `sameTypeBasicChildCases`), `lib/commcare/formActions.ts` (rewritten), `lib/commcare/xform/caseOps.ts`, `caseBlocks.ts`, `captureUrlNode.ts`, `generatedNodes.ts` (held paths reserved), `builder.ts`, `sourceCaseWrites.ts`, `lib/commcare/planPrivileges.ts`, `addOns.ts`, `projectSpaceCompatibility.ts` (`linkWriteDestinations`, `linkWriteIsShown` over link writes, relations and form prose, the probe plan's `attachment-links` reason, part 03 §10), `expander.ts`, `compiler.ts`, `session.ts`, `formLinkProjection.ts` (reading the plan; `entryDatumIdResolver` first-wins, part 02 §30), `lib/commcare/xpath` (the grammar, `expressionAst.ts`, the printer: `capture-link`)
- `lib/commcare/validator/errors.ts`, `gate.ts`, `rules/form.ts`, `field.ts`, `caseOperations.ts`, `selectPreloadWriterOptions.ts`, `hiddenValueWriterAgreement.ts`, `sourceCaseWrites.ts`
- `lib/commcare/surface/entries/forms-and-case-writes.json`, `gates.json` (`toggle/SAVE_ONLY_EDITED_FORM_FIELDS` as a capability; `toggle/VIEW_FORM_ATTACHMENT`'s clause, which gains "or prints it in a form")
- `lib/publish/projectSpaceCompatibility.ts` (`save-only-edited-answers`), `lib/publish/exportAdvisories.ts`
- `lib/preview/engine/formEngine.ts`, `caseDataBindingHelpers.ts`, `caseDataBindingTypes.ts`, `lib/preview/app-tests/submission.ts`, `lib/case-store/postgres/submissionEnvelope.ts`, `lib/case-store/submission.ts`

**Nova source, the forced surfaces** (part 01 §16.5, part 07 §5)

- `lib/agent/toolSchemaGenerator.ts`, `formAnswerWrites.ts`, `lib/agent/authoring/fieldBehavior.ts`, `operationSemantics.ts`, `formRecordContext.ts`, `reference.ts`, `lib/agent/tools/addFields.ts`, `editField.ts`, `getField.ts`, `getForm.ts`, `updateForm.ts`, `lib/agent/tools/case-operations/shared.ts`, `addCaseOperations.ts`, `updateCaseOperation.ts`, `getCaseOperations.ts`, `removeCaseOperation.ts`, `moveCaseOperation.ts`, `lib/agent/summarizeBlueprint.ts`, `lib/models.ts` (`"v6-hq-round-trip-case-writes.4"`), `scripts/test-schema.ts` (three entries registered; `updateCaseOperation`'s and `updateForm`'s prompts)
- `components/builder/editor/fields/CaseWriteEditor.tsx`, `caseWritePresentation.ts`, `CaseOptionsEditor.tsx`, `HiddenValueEditor.tsx`, `hiddenValueModel.ts`, `caseWriteRowModel.ts` (new), `components/builder/editor/fieldEditorSchemas.ts` (`defaultValueEntry`), `components/builder/detail/formSettings/FormSettingsPanel.tsx`, `OwnCaseSection.tsx` (new), `ownCaseModel.ts` (new), `components/builder/case-operations/CaseOperationsCanvas.tsx`, `CaseOperationRow.tsx`, `CaseOperationInspectorBody.tsx`, `operationSentence.ts`, `refusalCopy.ts`, `keyboardMove.ts`, `seeds.ts`
- Deleted: `components/builder/editor/fields/PreloadedValueRow.tsx`, `components/builder/detail/formSettings/CloseConditionSection.tsx`

**Nova tests named outright**

- `lib/domain/__tests__/caseWriteViews.test.ts`, `casePreload.test.ts`, `placements.test.ts` (new), `caseWriteOperationIdentity.test.ts` (new, part 09), `lib/domain/expression/__tests__/captureLink.test.ts` (new); `lib/domain/__tests__/caseWriteInventory.test.ts` and `closeCondition.test.ts` (deleted)
- `lib/commcare/__tests__/placement.test.ts`, `sameTypeChildCases.test.ts`, `caseWriteBoundary.test.ts`, `casePlacementPlan.test.ts`, `entryDatumResolver.test.ts` (new), `formActions.test.ts`, `caseBlocks.test.ts`, `planPrivileges.test.ts`, `projectSpaceCompatibility.test.ts`; `lib/commcare/validator/rules/__tests__/caseOwnOperation.test.ts`, `caseWriteFacets.test.ts` (new)
- `lib/doc/__tests__/fieldCaseWriteMutations.test.ts`, `formTypeMutations.test.ts` (new), `mutations-forms.test.ts`, `incrementalValidationScope.test.ts`, `diffDocsToMutations.fuzz.test.ts`
- `lib/case-store/postgres/__tests__/submissionEnvelope.postgres.test.ts`, `lib/preview/engine/__tests__/submissionProgramAcceptance.postgres.test.ts`
- `lib/agent/tools/__tests__/caseWriteTools.test.ts` (new), `lib/agent/tools/case-operations/__tests__/caseOperationTools.test.ts`, `lib/agent/__tests__/summarizeBlueprint-caseWrites.test.ts` (new), `components/builder/case-operations/__tests__/keyboardMove.test.ts`
- `lib/__tests__/docHelpers.ts` (its `f({caseWrite})` sugar lowers through `planFieldCaseWrite`), and every targeted document and `e2e/lib` seed that writes `caseWrite` through it

**The lane**

- the field-write sources of part 08 §4.2, `lib/commcare/__tests__/xformDocArbitrary.ts`, `suiteDocArbitrary.ts` (the defect 22 and 28 items), `proof/corpus/__tests__/fuzzSample.test.ts`; `unproducedInputs.test.ts`'s same-type bullet and `compilerEvidence.ts`'s same-type subcase assertion stay until 8, because the same-type exclusion keeps the shape unproduced until then (part 01 §28, part 08 §6.2)
- `proof/targeted/documents/caseWritesOneConcept.ts` (new), `loadTimeValues.ts`, `closeConditions.ts` (rewritten), `migrations.ts` (the case-writes and groups-preloads witnesses' operation holds and migrated shapes), `proof/identity-moves.json`
- `proof/checks/configurations.py` (the `SAVE_ONLY_EDITED_FORM_FIELDS` grant), `proof/native/core/CaseOperationRuntimeTest.java`
- `docs/research/2026-09-26-hq-round-trip/inventory/forms-and-case-writes.md`, `gates.md`

**Docs**

- The root `CLAUDE.md` has no row here: its identity sentence moves in pull request 6 with the publish record (§7.2). `lib/domain/CLAUDE.md`, `lib/commcare/CLAUDE.md`, `lib/doc/CLAUDE.md`, `lib/preview/CLAUDE.md`, `lib/case-store/CLAUDE.md`, `lib/agent/CLAUDE.md`, `lib/agent/authoring/CLAUDE.md`, `components/builder/CLAUDE.md` (the rows of §7 marked 4); `proof/README.md` (row 28)

### Pull request 5: Held placements and identity moves

**Nova source**

- `lib/domain/caseOperationDescription.ts` (new: `describeCaseOperation`, part 01 §14), `lib/domain/placementCopy.ts` (`placementLabel`, the held suffix)
- `lib/doc/types.ts` (`placementHoldSchema`, `holdPlacementsMutationSchema` with the targets case operation, own close and query repeat, R2), `lib/doc/mutations/placements.ts` (new), `lib/doc/mutations/index.ts`, `lib/doc/placementHolds.ts` (new: `admittedHoldChanges`), `lib/doc/placementMoves.ts` (new: `planOperationPlacementMoves`), `lib/doc/queryRepeatPlacement.ts` (new: `planQueryRepeatPlacementMoves`), `lib/doc/identityMoves.ts` (new: `withIdentityMoves`, `identityMovesBetween`, `documentHoldsIdentity`), `lib/doc/identityMoveCopy.ts` (new), `lib/doc/heldIdentity.ts` (new), `lib/doc/mutationTargetAdmission.ts`, `incrementalValidationScope.ts`, `diffDocsToMutations.ts` (`holdPlacements` emitted last), `userFacingErrors.ts`, `lib/doc/store.ts` (`recordHistoryStep`, `applyHistoryStep`, `recordedHolds`, `setRecordedPlacementHolds`), `lib/doc/builderWriteAdmission.ts`, `lib/doc/hooks/useBlueprintMutations.ts` (`guardedApply`, `reviewMany`, `commitStated`); `biome.json` (the `lib/commcare` allow-list gains `lib/doc/placementMoves.ts`, `lib/doc/identityMoves.ts` and `lib/doc/placementHolds.ts`, each a reader of `lib/commcare/placement.ts`; `lib/db/placementAuthority.ts` reads only `lib/doc/placementHolds` and needs no entry; part 01 §13.1, part 03 §2.2, part 07 §2.2)
- The recorded holds beside the document on the builder's load (part 03, its pull request 5): `lib/db/appAccess.ts` (`recordedHolds` in `resolveAuthorizedAppSnapshot`), `lib/collab/appReadSnapshot.ts`, `app/api/apps/[id]/route.ts` (the GET's `recordedHolds`), `app/(app)/build/[id]/[[...path]]/page.tsx` (`initialAccess`), `lib/collab/reconciler.ts` (the record beside `confirmedDoc`)
- `lib/commcare/placement.ts` (`inexpressible`), `lib/commcare/validator/rules/casePlacement.ts` (new), `lib/commcare/validator/errors.ts`, `gate.ts`, `rules/field.ts` (`QUERY_REPEAT_MODEL_ITERATION_SHAPE`)
- `lib/db/placementAuthority.ts` (new: `placementChangeRefusal`, `placementChangesToJustify`), `lib/db/placementRecords.ts` (new: `readRecordedPlacementHolds`), `lib/db/canonicalCommitKernel.ts` (its call), `lib/collab/ReconcilerProvider.tsx` (`frameMayTouchCaseData`)
- `lib/routing/historyStep.ts`, `lib/routing/builderActions.ts` (the toast), `lib/session/store.ts` (`pendingIdentityMove`)
- `components/builder/shared/IdentityMoveDialog.tsx` (new), `IdentityMoveList.tsx` (new), `components/builder/BuilderLayout.tsx` (the mount), `components/builder/case-list-config/noMatchesFormReview.tsx`, `CaseListConfigWorkspace.tsx`, `components/builder/detail/appSettings/AppPlatformsSection.tsx`, `OwnCaseSection.tsx` (the held suffix)
- `lib/agent/tools/common.ts` (`guardedMutate`), `lib/agent/workspace/types.ts`, `canonicalWorkspace.ts`, `lib/agent/change-set/workspace.ts`, `schemas.ts`, `lib/agent/authoring/session.ts`, `lib/agent/tools/getField.ts` (`rowsKept`), `getCaseOperations.ts` (`placementKept`), `lib/agent/toolSchemaGenerator.ts` (`repeat_mode`'s published sentence), `lib/agent/summarizeBlueprint.ts`, `lib/agent/authoring/reference.ts` (the identity paragraph and repeat sentence), `lib/mcp/prompts.ts` (the autonomous instruction's sentence), `lib/models.ts` (`"v6-hq-round-trip-case-writes.5"`)

**Nova tests named outright**

- `lib/doc/__tests__/holdPlacements.test.ts`, `placementSlotsWrittenOnlyByHolds.test.ts`, `diffDocsToMutations.placementHolds.test.ts`, `placementHolds.test.ts`, `placementMoves.test.ts`, `identityMoves.test.ts` (new), `store.test.ts`; `lib/routing/__tests__/historyStep.test.ts`; `lib/db/__tests__/placementAuthority.test.ts` (new), `placementRecords.postgres.test.ts` (new), `heldPlacements.postgres.test.ts` (new), `commitGuardedBatch.postgres.test.ts`, `projectMembership.postgres.test.ts`; `lib/collab/__tests__/appReadSnapshot.test.ts`; `lib/commcare/validator/rules/__tests__/casePlacement.test.ts` (new); `lib/agent/tools/__tests__/identityMoves.postgres.test.ts` (new); part 04 §9's second group
- `e2e/tests/app/identity-moves.spec.ts` (new), `e2e/lib/smokeProfiles.ts`, `e2e/lib/smokeSeedFactory.ts` (the `identity-moves` seed profile)

**The lane**

- `proof/corpus/editKinds.ts` (`holdPlacements`), `proof/corpus/editBatches.ts` (the kernel rule's editor half), `proof/corpus/__tests__/editBatches.test.ts`, `proof/targeted/documents/heldPlacement.ts` (new: `targeted-held-placement`), `proof/targeted/index.ts`

**Docs**

- `lib/doc/CLAUDE.md`, `lib/db/CLAUDE.md`, `lib/collab/CLAUDE.md`, `lib/domain/CLAUDE.md`, `lib/session/CLAUDE.md`, `lib/agent/CLAUDE.md`, `lib/agent/workspace/CLAUDE.md`, `lib/agent/change-set/CLAUDE.md`, `components/builder/CLAUDE.md` (the rows of §7 marked 5)

### Pull request 6: Publish placements

**Nova source** (part 03, Files by pull request)

- New: `lib/case-store/migrations/20261110000000_hq_round_trip_case_writes_publish_placement.ts`, `lib/commcare/placementHolds.ts`, `lib/commcare/hq/publishedCaseBlocks.ts`, `lib/deployment/placements.ts`, `lib/deployment/placementMoves.ts`, `lib/publish/placementMoves.ts`, `components/builder/placementConflictReplay.ts` (`replayAfterPlacementConflict`, the `onPlacementConflict` handler `ReconcilerProvider` registers, which calls the pure `lib/doc/identityMoves.ts::planConflictReplay`, part 03 §6 and decision 9, part 07 §2.6)
- Changed: `lib/case-store/migrations/index.ts`; `lib/db/types.ts`, `persistedJson.ts`, `canonicalCommitKernel.ts`, `commitGuard.ts`, `apps.ts`, `applyBlueprintChange.ts`, `lib/db/placementAuthority.ts` (the `publish-placement` arm), `lib/db/placementRecords.ts` (`publish-placement` rows read as recordings), `lib/agent/change-set/commit.ts`; `lib/doc/placementHolds.ts` (`PLACEMENT_CONFLICT_CODES`), `lib/doc/identityMoves.ts` (`planConflictReplay(doc, replay, recordedHolds)`, part 07), `lib/doc/store.ts` (`queuedCommandMutations`, and `recordedHolds` advanced by a folded `publish-placement` frame, part 07); `lib/collab/mutationFrame.ts`, `reconciler.ts`, `ReconcilerProvider.tsx`, `lib/doc/hooks/useAutoSave.ts`; `app/api/apps/[id]/route.ts`, `app/api/apps/[id]/stream/route.ts`; `lib/deployment/service.ts`, `types.ts`, `confirmations.ts`; `app/api/commcare/upload/route.ts`, `app/api/commcare/project-space-compatibility/route.ts`; `lib/mcp/tools/uploadAppToHq.ts`, `checkProjectSpaceCompatibility.ts`, `lib/mcp/errors.ts`; `components/builder/PublishDialog.tsx`, `publishOutcome.ts`, `components/builder/shared/IdentityMoveDialog.tsx` (the `placement-recorded` lead), `components/builder/BuilderLayout.tsx`

**Nova tests named outright**

- `lib/case-store/migrations/__tests__/publishPlacementKind.postgres.test.ts`, `lib/db/__tests__/publishPlacementCommit.postgres.test.ts`, `lib/commcare/__tests__/heldPlacementEmission.test.ts`, `lib/deployment/__tests__/placementMoves.test.ts`, `lib/commcare/hq/__tests__/publishedCaseBlocks.test.ts` (all new); `lib/doc/__tests__/identityMoves.test.ts` (part 07's `planConflictReplay`, the pure step the replay calls)
- `lib/db/__tests__/persistedJson.test.ts`, `lib/collab/__tests__/mutationFrame.test.ts`, `reconciler.test.ts`, `ReconcilerProvider.test.ts`, `app/api/apps/[id]/__tests__/route.test.ts`, `app/api/apps/[id]/stream/__tests__/stream.postgres.test.ts`, `lib/deployment/__tests__/publishSequence.postgres.test.ts`, `publishFixtures.ts` (`reloadHeadFor`), `lib/mcp/__tests__/uploadAppToHq.postgres.test.ts`, `servedSchemas.test.ts`, `components/builder/__tests__/publishOutcome.test.ts`
- `e2e/tests/multiplayer/multiplayer.spec.ts`, `e2e/tests/browser/publishing.spec.ts`

**The lane**

- `proof/corpus/publish.ts`, `emitCorpus.ts` and `entryWriter.ts` (the first publish's capture moved ahead of edit planning, and the record applied to D before D′ is planned), `proof/corpus/__tests__/publish.test.ts`, `proof/targeted/documents/heldPlacement.ts` (its holds from the record), `migrations.ts` (holds from the record)

**Docs**

- `CLAUDE.md`, `lib/db/CLAUDE.md`, `lib/collab/CLAUDE.md`, `lib/deployment/CLAUDE.md`, `components/builder/CLAUDE.md` (the rows of §7 marked 6); `lib/db/types.ts`'s comment on the kinds

### Pull request 7: Advanced modules and extension child cases

**Nova source** (part 02; its files are read from its sections and the wire brief's list as part 02 decides them)

- New: `lib/commcare/moduleKind.ts` (`emittedModuleKind`, `advancedKindReasons`), `lib/commcare/advancedSelections.ts` (the loads derived from the parent selection; no stored selection, R4), `lib/commcare/advancedPlacement.ts` (`loadIneligibility`, `openActionIneligibility`), `lib/commcare/advancedTags.ts` (`allocateAdvancedTags`), `lib/commcare/xform/advancedCaseBlocks.ts`, `lib/commcare/validator/rules/advancedModule.ts`, `lib/domain/advancedModule.ts` (`advancedKindBlockers`, `heldKindExpresses`, `advancedChainIndex`; whether a menu is emitted advanced is `moduleKind.ts::emittedModuleKind`, why `advancedKindReasons`, part 02 §4), `lib/doc/moduleKindMoves.ts` (`planModuleKindMoves`), `lib/commcare/__tests__/advancedDocArbitrary.ts` (part 02's own generator, which the proof sample does not draw)
- Deleted: `lib/commcare/subcaseWire.ts` (its `subcaseSessionDatumId` moves into `lib/commcare/session.ts`)
- Changed: `lib/commcare/casePlacementPlan.ts` (the advanced arm; the interim extension branch removed), `lib/commcare/placement.ts` (the `moduleKind` option, the advanced arm of the procedure, the carried-create clause, R5), `lib/domain/placements.ts` (`advancedPlacementSchema` in the union, `CASE_PLACEMENT_KIND`), `lib/domain/forms.ts` (the extension create), `lib/domain/modules.ts` (`Module.heldKind`), `lib/doc/types.ts` (the `module-kind` arm of `holdPlacements`), `lib/doc/placementHolds.ts` (its dispatch), `lib/commcare/placementHolds.ts` (module kinds held), `lib/doc/identityMoves.ts` (part 02's source and the `module-kind` target, with part 07), `lib/doc/commitVerdicts.ts`, `lib/doc/incrementalValidationScope.ts`, `lib/doc/userFacingErrors.ts`
- Changed: `lib/commcare/hqShells.ts` (`advancedModuleShell`, `advancedFormShell`), `types.ts`, `expander.ts`, `formActions.ts`, `xform/caseOps.ts`, `xform/caseBlocks.ts`, `xform/sourceCaseWrites.ts`, `xform/generatedNodes.ts` (the `owner` purpose, `nova_owner_<op>`), `xform/builder.ts`, `compiler.ts`, `session.ts`, `formLinkProjection.ts` (`linkCarriedCreates`, the advanced branch, the `moduleKinds` context option), `planPrivileges.ts`, `addOns.ts`, `hqJson/xpath.ts`, `validator/errors.ts`, `gate.ts`, `rules/form.ts` (`FORM_LINK_NEEDS_NEW_CASE_DATUM`), the rule registries, `validator/hqJsonOracle.ts`
- Changed: `lib/domain/platforms.ts`, `platformUses.ts`, `lib/commcare/surface/platformFeatureEntries.ts`, `lib/commcare/surface/entries/menus-and-case-lists.json`, `forms-and-case-writes.json`, `gates.json` (part 08's G4)
- Preview and the store: `lib/preview/menuProjection.ts`, `engine/entrySessionData.ts`, `caseSelectionNavigation.ts`, `app-tests/navigation.ts`, `lib/case-store/postgres/submissionEnvelope.ts`, `lib/case-store/store.ts` and `lib/case-store/sql` (`SelectedParentCases.index`), `lib/preview/__tests__/platformCells.ts`
- Agent and builder: `lib/agent/tools/case-operations/shared.ts`, `lib/agent/tools/case-operations/getCaseOperations.ts` (`"case actions"`), `lib/agent/tools/getForm.ts`, `getModule.ts` (`advanced`), `lib/agent/summarizeBlueprint.ts`, `lib/agent/authoring/reference.ts`, `lib/models.ts` (`"v6-hq-round-trip-case-writes.7"`); `components/builder/form-links/` (`FORM_LINK_NEEDS_NEW_CASE_DATUM`'s sentence at the link editor, part 07)

**Nova tests named outright**

- `lib/commcare/__tests__/advancedEmission.test.ts`, `advancedTags.test.ts`, `advancedSuite.test.ts`, `advancedPlacement.test.ts` (new; it writes `proof/hq/fixtures/advanced-rule-shapes.json`, which `proof/hq/test_advanced_rules.py` reads), `addOns.test.ts`, `lib/commcare/__tests__/hqJsonOracle.*`, `lib/commcare/__tests__/extensionCaseFixture.ts`, `lib/commcare/surface/__tests__/platformFeatures.test.ts`, `lib/doc/__tests__/moduleKindMoves.test.ts` (new); part 02 §26's rows marked 7

**The lane**

- `proof/targeted/documents/advancedModules.ts` (new: the six documents of §1's row 7, as part 08 §5.1 names them), `proof/targeted/index.ts`, `migrations.ts` (the extension-children witness), `proof/identity-moves.json`
- `proof/native/core/CaseOperationRuntimeTest.java`, `AdvancedFormRuntimeTest.java` (new), `proof/native/test_advanced_emission.py` (new), `proof/native/families.py`, `proof/native/producers/*`
- `proof/hq/test_advanced_rules.py` (new) with `proof/hq/fixtures/advanced-rule-shapes.json`, `proof/checks/manifest_value_classes.py`, `test_manifest_value_classes.py`, `proof/checks/configurations.py`

**Docs**

- `lib/commcare/CLAUDE.md`, `lib/domain/CLAUDE.md`, `lib/doc/CLAUDE.md`, `lib/case-store/CLAUDE.md`, `lib/preview/CLAUDE.md` (the rows of §7 marked 7); `proof/README.md` (row 24, "Native proofs")

### Pull request 8: CommTrack and same-type child links at publish

**Nova source** (part 03)

- New: `lib/case-store/migrations/20261110010000_hq_round_trip_case_writes_commtrack_confirmation.ts`, `lib/commcare/xform/supplyPointText.ts` (`formSourceHoldsSupplyPointText`)
- Changed: `lib/case-store/migrations/index.ts`; `lib/commcare/moduleKind.ts` (part 02's `advancedModulesWithCaseListMenuItem`), `lib/commcare/planPrivileges.ts` (`commtrackReasons`, reading it; its advanced menu item arm held by a Vitest witness in `planPrivileges.test.ts` until 10, R1), `lib/commcare/projectSpaceCompatibility.ts` (the capability, `featureFlagsOff`), `lib/commcare/client.ts`, `lib/commcare/multimedia/hqJsonExportArchive.ts`, `lib/commcare/placement.ts` (the same-type exclusion lifted); `lib/publish/planFeatures.ts` (`COMMTRACK_OFF`), `lib/publish/projectSpaceCompatibility.ts`, `lib/publish/manualImportGuide.ts`, `lib/publish/placementMoves.ts`; `lib/deployment/types.ts`, `confirmations.ts`, `placementMoves.ts`, `service.ts`; `lib/db/pg.ts`; `lib/notices/migrationNoticeCopy.ts` (`next-publish-asks-more`'s two settings ids); `app/api/commcare/project-space-compatibility/route.ts`; `lib/mcp/tools/uploadAppToHq.ts`, `withdrawDeploymentConfirmation.ts`, `checkProjectSpaceCompatibility.ts`; `components/builder/PublishPanel.tsx`, `PublishDialog.tsx`, `components/builder/app-setup/publishingSectionModel.ts`; `components/docs/ProjectSpaceCapabilityCatalog.tsx` (the new capability's entry renders from the records)
- `lib/commcare/surface/entries/gates.json` (`toggle/DONT_INDEX_SAME_CASETYPE`, `project-space-setting/Domain.commtrack_enabled`'s `content`), `forms-and-case-writes.json`, `docs/research/2026-09-26-hq-round-trip/inventory/gates.md`

**Nova tests named outright**

- `lib/case-store/migrations/__tests__/commtrackConfirmation.postgres.test.ts` (new), `lib/commcare/xform/__tests__/supplyPointText.test.ts` (new), `lib/commcare/__tests__/planPrivileges.test.ts`, `moduleKind.test.ts` (`advancedModulesWithCaseListMenuItem`'s cases, part 02), `sameTypeChildCases.test.ts` and `placement.test.ts` (their pull request 8 cases, part 01 §28), `compilerEvidence.ts` (its same-type subcase assertion dropped, part 01 §28), `projectSpaceCompatibilityProbe.test.ts`, `lib/deployment/__tests__/publishGates.postgres.test.ts`, `lib/mcp/__tests__/servedSchemas.test.ts`, `components/builder/app-setup/__tests__/publishingSectionModel.test.ts`, `lib/publish/__tests__/manualImportGuide.test.ts`, `e2e/tests/browser/publishing.spec.ts` (the CommCare Supply row)

**The lane**

- `proof/corpus/publish.ts` (the predicates behind both verdict keys, and the `flagsOff` key, R8), `proof/corpus/__tests__/publish.test.ts`, `proof/corpus/entryWriter.ts`, `proof/checks/corpus.py` (`verdict_lacks` reads `flagsOff`), `proof/checks/sensitivity.py` and `proof5.py` (docstrings naming `flagsOff`), `test_sensitivity.py`, `test_proof5_locality.py`, `proof/checks/manifest_value_classes.py` (`own_case_type_where_same_type_unindexed`), `test_manifest_value_classes.py`, `proof/hq/test_flag_probe.py`, `proof/editors/test_commtrack_supply_point_text.py` (new, the Vellum save and the builds with CommCare Supply on and off), `proof/targeted/__tests__/publishChecks.test.ts` (new), `proof/targeted/__tests__/unproducedInputs.test.ts` (two bullets move to `publishChecks.test.ts`), `proof/targeted/documents/sameTypeChild.ts`, `supplyPointText.ts` (new)

**Docs**

- `lib/commcare/CLAUDE.md`, `lib/deployment/CLAUDE.md`, `lib/db/CLAUDE.md` (the rows of §7 marked 8); `proof/README.md` (row 12 becomes a reproduced row; "Configurations" names `flagsOff`)

### Pull request 9: Groups and labels: field lists and plain labels

**Nova source** (part 04 §12)

- New: `lib/doc/groupFieldLists.ts` (`planGroupFieldLists`, kept past pull request 16)
- Changed: `lib/domain/fields/group.ts` (`fieldList`, `groupBornFieldList`, `defaultGroupFieldList`), `lib/domain/fields/base.ts` (`plainLabel` on `fieldBaseSchema`, `containerFieldBase`, `selectOptionSchema`, `SelectOption`), `lib/domain/fields/section.ts`, `lib/domain/platforms.ts` (`plain-text`), `lib/domain/platformUses.ts`, `lib/commcare/xform/builder.ts` (the field-list gate, `addItext`'s `markdown`), `lib/commcare/validator/errors.ts`, `rules/form.ts` (`FIELD_LIST_USER_REPEAT`), `lib/doc/formSectionVerdicts.ts`, `lib/doc/mutations/fields.ts` (`convertField`), `lib/agent/contentProcessing.ts` (the birth rule), `components/preview/form/newFieldDefaults.ts`, `components/preview/form/FieldTypePicker.tsx`, `lib/preview/engine/formEngine.ts` (`groupDrawsAsFieldList`, the prompt points), `lib/preview/platform.ts` (`plainChoice`), `lib/references/LabelContent.tsx`, `components/preview/form/fields/SelectOneField.tsx`, `SelectMultiField.tsx`, `lib/commcare/surface/platformFeatureEntries.ts`, `lib/commcare/surface/entries/questions.json`
- `lib/preview/__tests__/platformCells.ts`, `lib/domain/__tests__/platformFeatureFixtures.ts`, `lib/commcare/__tests__/platformQuestionPages.test.ts`, `e2e/lib/previewPlatformScenarios.ts` (the scenario `choice-label-plain-web-apps`), `e2e/tests/browser/preview-platforms.spec.ts`; part 04 §9's third group

**The lane**

- the labelled-group sources of part 08 §4.2, `xformDocArbitrary.ts` (the defect 27 item), `fuzzSample.test.ts`, `proof/targeted/documents/formShapes.ts` (`targeted-field-list-flags`, `targeted-labelled-group-repeat`), `textReads.ts` (`targeted-plain-labels`), `migrations.ts` (the groups-preloads witness's `fieldList`), `proof/android/test_form_reads.py`

**Docs**

- `lib/commcare/CLAUDE.md`, `lib/domain/CLAUDE.md`, `lib/doc/CLAUDE.md`, `lib/preview/CLAUDE.md` (the rows of §7 marked 9); `proof/README.md` (row 27)

### Pull request 10: Search workflow, menu concepts and claims

**Nova source** (part 05 §19)

- Domain: `lib/domain/modules.ts`, `menuForms.ts`, `forms.ts` (`Form.entry` out, `PostSubmitMenuShape.formsReadSearch`), `postSubmit.ts`, `platforms.ts`, `platformUses.ts`, `translationUnits.ts`, `mediaRefs.ts`, `referenceSlots.ts`, `caseClaim.ts` (new), `index.ts`, `expression/context.ts` (`formsReadSearchModule`, `caseListRegistrationForm`), `expression/typeChecker.ts` (`not-forms-read-search`), `entryDatumSupplies.ts`, `caseParentSelection.ts`, `moduleHierarchy.ts`, `navigation.ts`, `__tests__/platformFeatureFixtures.ts`
- Doc: `lib/doc/types.ts`, `mutations/modules.ts`, `mutations/forms.ts`, `mutations/index.ts`, `scaffolds.ts`, `caseListRegistrationForm.ts` (renamed from `searchNoMatchesForm.ts`), `searchReadDependents.ts` (renamed from `searchNoMatchesDependents.ts`), `searchWorkflowPlan.ts` (new, `authoredSearchWorkflow`, kept past pull request 16), `identityMoveCopy.ts` (the `forms-read-search` reason's sentence becomes `Its forms now read the search, which an advanced menu can't do.`, part 02 §21), `caseSearchConfigPatchMutations.ts`, `caseSearchConfigMutations.ts`, `caseSelectionMutations.ts`, `incrementalValidationScope.ts`, `mutationTargetAdmission.ts`, `referenceIndex.ts`, `diffDocsToMutations.ts`, `userFacingErrors.ts`, `platformNotes.ts`, `entryPointReview.ts`, `hooks/useModuleIds.ts`, `hooks/useBlueprintMutations.ts`
- CommCare: `suite/case-search/searchWireShape.ts`, `types.ts`, `inlineSearch.ts`, `remoteRequest.ts`, `noMatches.ts`, `suite/case-list/orderPlanOptions.ts`, `hqJson/caseList.ts`, `expander.ts`, `compiler.ts`, `session.ts` (with the advanced module's case list entry, part 02 §17), `emissionPlan.ts`, `entryPointProjection.ts`, `formLinkProjection.ts`, `hqNestedSelection.ts`, `projectSpaceCompatibility.ts`, `localeFile.ts`, `planPrivileges.ts` (`commtrackReasons`' menu item arm reads `moduleHasCaseListMenuItem`; its Vitest witness gives way to `targeted-commtrack-advanced`); validator `errors.ts`, `rules/case-search/formsReadSearch.ts` (renamed), `rules/case-search/caseListRegistration.ts` (renamed), `rules/case-list/searchInputRefUsesWhenInputPresent.ts`, `rules/module.ts`, `rules/form.ts`, `rules/multiSelect.ts`, `rules/parentSelection.ts`, the rule registries; `lib/commcare/moduleKind.ts` (blocker `case-list-menu-item-narrowed`, `advancedModulesWithCaseListMenuItem` and `forms-read-search` read part 05's readers); the copy rows part 02 marks "from pull request 10" and part 07's line beside an advanced menu's case list menu item (part 07 §3.7); surface `entries/case-search.json`, `entries/menus-and-case-lists.json`, `gates.json` (the menu item's CommCare Supply effect), `platformFeatureEntries.ts`
- Case store and db: `lib/case-store/store.ts`, `errors.ts` (`ClaimCasesInputError`), `postgres/store.ts`, `sql/compileRestoreScope.ts`, `lib/db/materializeCaseStoreSchemas.ts`
- Preview and session: `lib/preview/platform.ts`, `caseListPhase.ts`, `searchClaims.ts`, `caseListMenuItemRoute.ts` (renamed from `formlessCaseListRoute.ts`), `caseListRegistration.ts` (renamed from `noMatchesForm.ts`), `menuProjection.ts`, `afterSubmitRouting.ts`, `entryPointLaunch.ts`, `entryPointLaunchAction.ts`, `runtimeMessages.ts`, `engine/caseDataBinding.ts`, `engine/caseDataBindingHelpers.ts`, `engine/previewAuthorization.ts`, `engine/searchEvaluation.ts`, `engine/serverSearchRead.ts`, `engine/evaluateFormSnapshot.ts`, `engine/useCaseDatabaseSnapshot.tsx`, `hooks/useCaseDataBinding.ts`, `hooks/useSearchResultsSnapshot.ts`, `hooks/useEntryPointLaunch.ts`, `hooks/useRestoreScopeKey.ts`, `hooks/useClaimSearchedCases.ts` (new), `app-tests/run.ts`, `types.ts`, `retainedState.ts`, `context.ts`, `service.ts`, `records.ts`, `navigation.ts`, `__tests__/platformCells.ts`, `platformCellModels.ts`; `lib/session/previewClaims.ts` (deleted), `lib/session/store.ts`, `hooks.tsx`, `types.ts`; `lib/routing/location.ts`, `hooks.tsx`; `lib/codemirror/expressionEditorContext.ts`
- Components (forced, part 05 §12.1 and part 07 §5): `components/builder/PreviewIdentityMenu.tsx` (**Release claimed cases**), `components/builder/case-list-config/inspector/SearchPanelInspectorBody.tsx`, `canvas/SearchCanvas.tsx`, `canvas/CaseListRegistrationSetting.tsx` (renamed from `NoMatchesFormSetting.tsx`), `caseListRegistrationReview.tsx` (renamed from `noMatchesFormReview.tsx`), `inspector/SearchWorkflowSetting.tsx` (new), `searchWorkflowModel.ts` (new), `components/builder/detail/moduleSettings/CaseListMenuItemSection.tsx` (new), `ModuleAppearanceSection.tsx`, `ModuleSettingsPanel.tsx`, `components/builder/detail/formSettings/FormEntrySection.tsx`, `components/builder/appTree/ModuleCard.tsx`, `FormCard.tsx`, `appTree/insertion/AddModulePopover.tsx`, `components/builder/shared/checkErrorPresentation.ts`, `components/builder/app-setup/LanguagesSection.tsx`, `components/preview/screens/HomeScreen.tsx`, `CaseListScreen.tsx`, `ModuleScreen.tsx`, `EntryPointPreviewLaunch.tsx`
- Agent and MCP: `lib/agent/tools/case-list-config/configureCaseList.ts`, `case-search-config/shared.ts`, `setCaseSearchAdvanced.ts`, `createModule.ts`, `updateModule.ts`, `createForm.ts`, `updateForm.ts`, `getModule.ts`, `lib/agent/tools/shared/caseListRegistration.ts` (renamed from `formEntry.ts`), `lib/agent/summarizeBlueprint.ts`, `blueprintHelpers.ts`, `authoring/reference.ts`, `authoring/evaluationContext.ts`, `translation/translator.ts`, `lib/models.ts` (`"v6-hq-round-trip-case-writes.10"`), `scripts/test-schema.ts` (the prompts of part 07 §4.8's pull request 10 row); `scripts/inspect-app.ts`, `scripts/lib/blueprint-stats.ts`
- Notices: `lib/notices/migrationNoticeCopy.ts` (`HISTORICAL_PLATFORM_CAUSE_WORDS`)

**Nova tests named outright**

- `lib/commcare/suite/case-search/__tests__/searchWireShape.test.ts`, `lib/commcare/__tests__/searchEmission.test.ts`, `caseListMenuItem.test.ts`, `planPrivileges.test.ts` (the advanced menu item beside forms, its Vitest witness giving way, part 03), `lib/commcare/validator/rules/__tests__/formsReadSearch.test.ts`, `caseListRegistration.test.ts`, `lib/commcare/validator/__tests__/platformAvailability.test.ts`, `lib/commcare/surface/__tests__/manifest.test.ts`, `platformFeatures.test.ts`
- `lib/domain/__tests__/modules.test.ts`, `platformUses.test.ts`; `lib/doc/__tests__/searchWorkflowPlan.test.ts`, `searchWorkflowMutations.test.ts`, `caseListMenuItem.test.ts`, `platformOfferParity.test.ts`, `userFacingErrorsPlatforms.test.ts`
- `lib/case-store/postgres/__tests__/claims.postgres.test.ts` (new), `lib/case-store/sql/__tests__/restoreScopeClaims.postgres.test.ts` (rewritten), `lib/preview/engine/__tests__/searchPopulation.postgres.test.ts`, `lib/preview/__tests__/searchClaims.test.ts`, `caseListPhase.test.ts`, `caseListMenuItemRoute.test.ts`, `menuProjection.test.ts`, `entryPointLaunchAction.test.ts`, `platformCells.test.ts`, `lib/preview/app-tests/__tests__/retainedState.test.ts`, `journey.postgres.test.ts`, `lib/notices/__tests__/migrationNoticeCopy.test.ts`
- `lib/agent/tools/__tests__/caseListRegistrationTools.test.ts` (new); `e2e/tests/app/search-workflow.spec.ts` (new), `e2e/tests/app/case-list-menu-item.spec.ts` (new), `e2e/tests/browser/preview-platforms.spec.ts`, `preview-identity-menu.spec.ts`, `publishing.spec.ts` (the CommCare Supply row for an advanced menu's case list menu item beside its forms, part 03), `e2e/lib/searchFirstSeed.ts`

**The lane**

- the search sources of part 08 §4.2, `suiteDocArbitrary.ts` (the defects 21 and 29 item), `fuzzSample.test.ts`, `proof/targeted/documents/searchApps.ts`, `inlineSearchReads.ts`, `noMatchesReturnIdentity.ts`, `searchWorkflows.ts` (new: `targeted-search-workflow`, `targeted-search-workflow-inline`, `targeted-search-workflow-android`), `caseListMenuItems.ts` (new: `targeted-case-list-menu-item`), `advancedModules.ts` (`targeted-commtrack-advanced`, the lane witness of the CommCare Supply menu item reason, R1), `proof/targeted/index.ts`, `migrations.ts` (the search-workflow witness), `proof/views/test_search_workflow_offers.py` (new), `proof/walk-stops.json` (part 08's G2), `proof/corpus/footprint.ts`, `proof/corpus/editKinds.ts`

**Docs**

- `lib/domain/CLAUDE.md`, `lib/domain/expression/CLAUDE.md`, `lib/commcare/CLAUDE.md`, `lib/case-store/CLAUDE.md`, `lib/preview/CLAUDE.md`, `lib/session/CLAUDE.md`, `lib/preview/app-tests/CLAUDE.md`, `lib/doc/CLAUDE.md`, `lib/routing/CLAUDE.md`, `lib/agent/CLAUDE.md`, `lib/export/CLAUDE.md`, `components/builder/CLAUDE.md` (the rows of §7 marked 10); `proof/README.md` (row 21, "Walk stops")

### Pull request 11: Form links

**Nova source** (part 06 §20)

- Domain: `lib/domain/forms.ts`, `formLinkTargets.ts` (new), `afterSubmit.ts` (new), `formLinkGraph.ts` (deleted), `postSubmit.ts`, `navigation.ts`, `entryDatumSupplies.ts`, `authoredIdentities.ts`, `referenceSlots.ts`, `expression/context.ts`, `expression/formStructure.ts`, `platforms.ts`, `platformUses.ts`, `index.ts`
- CommCare: `lib/commcare/formLinkProjection.ts`, `session.ts`, `expander.ts`, `compiler.ts`, `validator/errors.ts`, `runner.ts`, `gate.ts`, `rules/form.ts`, `rules/app.ts` (the circular rule leaves), `rules/multiSelect.ts`, `rules/hiddenFromMenu.ts`, `validator/hqJsonOracle.ts`, `surface/entries/forms-and-case-writes.json`, `surface/platformFeatureEntries.ts`
- Doc: `lib/doc/types.ts`, `mutations/forms.ts`, `mutations/modules.ts`, `mutations/index.ts`, `mutationTargetAdmission.ts`, `mutationIdentityAdmission.ts`, `mutationSequenceAdmission.ts`, `referenceIndex.ts`, `diffDocsToMutations.ts`, `incrementalValidationScope.ts`, `store.ts`, `formLinkMutations.ts`, `formLinkReview.ts`, `formLinkDependents.ts`, `formLinkTargetChoices.ts`, `formLinkSemanticsMap.ts` (new, `mapFormLinkSemantics`, kept past pull request 16), `userFacingErrors.ts`, `platformNotes.ts`, `hooks/useFormLinks.ts`, `hooks/useFormLinkFacts.ts`, `hooks/useBlueprintMutations.ts`
- Preview: `lib/preview/afterSubmitStack.ts` (new), `engine/formLinkEvaluation.ts`, `afterSubmitRouting.ts`, `platform.ts`, `engine/postSubmissionEvaluation.ts`, `engine/useCaseDatabaseSnapshot.tsx`, `engine/navigationProjection.ts`, `app-tests/types.ts`, `submission.ts`, `run.ts`, `service.ts`, `retainedState.ts`, `__tests__/platformCells.ts`, `platformCellModels.ts`; `lib/session/store.ts`, `types.ts` (`previewAfterSubmitStack`); `components/preview/screens/FormScreen.tsx`
- Builder: `components/builder/form-links/OtherwiseChooser.tsx` (renamed from `FallbackChooser.tsx`), `OtherwiseRow.tsx`, `AddLinkControl.tsx`, `FormLinksCanvas.tsx`, `LinkTargetPicker.tsx`, `FormLinkInspectorBody.tsx`, `CarryValuesSection.tsx`, `FormLinkRow.tsx`, `linkSentence.ts`, `afterSubmitCopy.ts`, `refusalCopy.ts`, `seeds.ts`, `components/builder/detail/formSettings/AfterSubmitSection.tsx`
- Agent and MCP: `lib/agent/tools/form-links/shared.ts`, `addFormLinks.ts`, `updateFormLink.ts`, `moveFormLink.ts`, `removeFormLink.ts`, `setFormOtherwise.ts` (new), `lib/agent/tools/createForm.ts`, `updateForm.ts`, `getForm.ts`, `removeForm.ts`, `removeModule.ts`, `lib/agent/sharedToolRegistry.ts`, `toolPresentation.ts`, `summarizeBlueprint.ts`, `authoring/reference.ts`, `lib/chat/toolSummary.ts`, `lib/models.ts` (`"v6-hq-round-trip-case-writes.11"`), `scripts/test-schema.ts` (`setFormOtherwise`, `moveFormLink`, `removeFormLink` registered; `addFormLinks`' prompt)

**Nova tests named outright**

- part 06 §17's files, with `lib/commcare/__tests__/formLinkWireFixture.ts`, `expander.test.ts`, `formLinkParity.test.ts`, `lib/commcare/__tests__/formLinkTargets.test.ts` (new, writing `lib/commcare/__tests__/fixtures/formLinkTargets.json`), `lib/doc/__tests__/formLinkSemanticsMap.test.ts` (new), `lib/agent/tools/form-links/__tests__/formLinkTools.test.ts`, `lib/agent/authoring/__tests__/platformGuide.test.ts`, `formLinkProjection.property.test.ts` with its own generator (the proof sample's generators `xformDocArbitrary.ts`, `suiteDocArbitrary.ts` and `expressionDocArbitrary.ts` do not change, part 06 §13.3), `e2e/lib/formLinksSeed.ts`, `e2e/lib/previousTaskSeed.ts`, `e2e/lib/deepLinksSeed.ts`, `e2e/lib/smokeSeedFactory.ts`

**The lane**

- the form-link sources of part 08 §4.2, `proof/targeted/documents/formLinksHiddenFallback.ts` (migrated shape), `formLinkChain.ts`, `formLinkCarriedCase.ts`, `formLinkOtherwise.ts` (new), `instanceReads.ts`, `inlineSearchReads.ts`, `migrations.ts` (the form-links witness), `proof/targeted/expected.ts`, `proof/corpus/editKinds.ts` (`setFormOtherwise`), `proof/corpus/footprint.ts`, `editBatches.test.ts`, `proof/native/core/FormLinkRuntimeTest.java`, `proof/native/producers/emit-form-link-evidence.ts`, `proof/native/test_navigation_emission.py`, `proof/views/test_form_link_targets.py` (new), `proof/checks/manifest_value_classes.py` (`failing-link-checks`), `proof/checks/test_registers.py` (docstring, `step > 5`)

**The research**

- `docs/research/2026-09-26-hq-round-trip/inventory/forms-and-case-writes.md`

**Docs**

- `lib/commcare/CLAUDE.md`, `lib/domain/CLAUDE.md`, `lib/doc/CLAUDE.md`, `lib/preview/CLAUDE.md`, `lib/session/CLAUDE.md`, `components/builder/CLAUDE.md` (the rows of §7 marked 11); `proof/README.md` (row 26, "Known defects"), `proof/CLAUDE.md` ("The register is strict")

### Pull request 12: Builder

- New: `components/builder/editor/fields/RepeatRowsEditor.tsx`, `repeatRowsModel.ts`, `components/builder/editor/fields/__tests__/repeatRowsModel.test.ts`, `e2e/tests/app/case-writes.spec.ts`
- Changed: `components/builder/editor/fields/CaseWriteEditor.tsx`, `caseWriteRowModel.ts`, `components/builder/detail/formSettings/OwnCaseSection.tsx`, `ownCaseModel.ts`, `components/builder/case-operations/seeds.ts`, `CaseOperationDetailCanvas.tsx`, `CaseOperationInspectorBody.tsx`, `components/builder/editor/fieldEditorSchemas.ts` (the group switch, the repeat entry, the comment), `components/preview/form/InlineTextEditor.tsx`, `components/builder/editor/fields/OptionsEditor.tsx`, `components/builder/localization/` (the source row's formatting state), `components/builder/detail/moduleSettings/ModuleSettingsPanel.tsx` (the `In CommCare HQ` row, through a `lib/doc/hooks` reader of part 02's `advancedKindReasons`), `e2e/tests/browser/builder-controls.spec.ts`, `e2e/lib/builder-controls-client.tsx`
- Docs: `components/builder/CLAUDE.md` (the rows of §7 marked 12)

### Pull request 13: Agent

- Changed: `lib/agent/toolSchemaGenerator.ts` (`field_list`, `plain_label`, `via`, `onlyIfChanged`, the `worker-record` target, the remaining descriptions), `lib/agent/contentProcessing.ts`, `lib/agent/tools/case-operations/shared.ts` (`ownWriteInputSchema`, the `worker-record` target), `updateCaseOperation.ts`, `lib/agent/tools/updateForm.ts`, `createForm.ts`, `lib/domain/fields/group.ts` (`saDocs`), `lib/agent/authoring/reference.ts` (the final guide), `lib/models.ts` (`"v6-hq-round-trip-case-writes.13"`), `scripts/test-schema.ts` (the prompts of part 07 §4.8's pull request 13 row), part 07 §9's tests marked 13
- `../nova-plugin` (its own repository, its own pull request): `skills/upload_to_hq/SKILL.md`, `README.md`, `.claude-plugin/plugin.json`

### Pull request 14: Cutover

- Storage: `lib/case-store/migrations/20261110020000_hq_round_trip_case_writes_fold_horizon.ts` (new), `lib/case-store/migrations/index.ts`, `lib/case-store/migrations/__tests__/caseWritesLedger.postgres.test.ts` (new, kept after the removal), `lib/agent/change-set/__tests__/preHorizonReads.postgres.test.ts`, `lib/db/__tests__/runHolderWriteGuard.test.ts` (its additions removed by 16), `lib/db/designSessions.ts` (`abandonPreAppDesignSessionInTransaction` and `reapStaleDesignSessionRun` exported, the latter returning `Promise<StaleRunReapOutcome | "failed">`)
- Notice: `lib/notices/migrationNotice.ts`, `lib/notices/migrationNoticeCopy.ts` (the cutover id, the lead, every document and deployment reason of resolution 13 with part 06's `form-link-removed` after `form-link-target-moved`, `form-link-otherwise-set`'s `from` and `menu-opens-on-search`'s `opensOn` details (R18), `next-publish-asks-more`'s ids), `lib/notices/__tests__/migrationNotice.test.ts`, `migrationNoticeCopy.test.ts`, `components/builder/notices/__tests__/appNoticeModel.test.ts`
- Scripts and infrastructure (pull request 16 deletes the new files and removes this pull request's additions from the others): `scripts/scan-hq-round-trip-case-writes.ts`, `scripts/migrate-hq-round-trip-case-writes.ts`, `scripts/lib/hqRoundTripCaseWrites/**` with its `__tests__/` (`catalog.postgres.test.ts`, `writer.postgres.test.ts`, `scan.postgres.test.ts`, `holders.postgres.test.ts`, `postgresSeed.ts`, the pure suites), `config/deployment-jobs.json` (the Job contract `commcare-nova-hq-round-trip-case-writes`), `Dockerfile` (the `maintenance-build` line, and the three sharp `COPY` lines only under part 09's bundle run outcome B), `.dockerignore` (three lines), `scripts/rollout/deploy-cloud-run.py` (the allowlist arm, `PLAN_DIGEST_RE`), `scripts/infra/tests/test_deployment_policy.py`, `scripts/infra/__tests__/containerArtifacts.test.ts`, `scripts/README.md`, `docs/architecture/deployment.md` (the "Historical repairs" paragraph), `docs/plans/hq-round-trip/5-cutover-runbook.md` (new)
- Docs: `lib/db/CLAUDE.md` (the sixth identity, §7); public docs kept after the removal: `content/docs/publishing.mdx` ("Updates to review"), `content/docs/mcp/tools.mdx` (the `get_app` row)

### Pull request 15: Contracts and public docs

- `docs/architecture/contracts.md`, `docs/architecture/complex-apps.md` (§7.2, §7.3)
- Every `content/docs` row of §8 marked 15: `case-changes.mdx`, `form-links.mdx`, `attachments.mdx`, `case-workspace.mdx`, `building-with-nova.mdx`, `form-sections.mdx`, `publishing.mdx`, `project-space-compatibility.mdx`, `where-workers-use-your-app.mdx`, `nested-menus.mdx`, `mcp/tools.mdx`
- `proof/README.md` (the tables that count documents, controls and groups), `proof/timings.json` (`no-readers` from this head's fresh dispatch, part 08's G7; `readers` from the first night's run in the one pull request part 08's G8 outcome A names, the next working day, holding only that profile and `proof/README.md`'s timing numbers with every reader)
- `docs/plans/hq-round-trip/README.md` (the sentence that names the register's live defects as step 5's says step 5 fixed them, §9)

### Pull request 16: Removal of the cutover tooling and of this plan

- Deleted: `scripts/scan-hq-round-trip-case-writes.ts`, `scripts/migrate-hq-round-trip-case-writes.ts`, `scripts/lib/hqRoundTripCaseWrites/**` with its `__tests__/`, the pre-step fixtures, `facts.json`, `digests.json` and `fixtures.digest.test.ts`, `docs/plans/hq-round-trip/5-cutover-runbook.md`, `docs/plans/hq-round-trip/5-case-writes-forms-navigation.md` and `docs/plans/hq-round-trip/5-case-writes-forms-navigation/`
- Edited, pull request 14's additions removed and the files kept: `config/deployment-jobs.json`, `Dockerfile`, `.dockerignore`, `scripts/rollout/deploy-cloud-run.py`, `scripts/infra/tests/test_deployment_policy.py`, `scripts/infra/__tests__/containerArtifacts.test.ts`, `scripts/README.md`, `docs/architecture/deployment.md`, `lib/db/__tests__/runHolderWriteGuard.test.ts`
- Changed: `lib/db/designSessions.ts` (both exports module-private again, with `main`'s bodies); `docs/plans/hq-round-trip/README.md` ("Step 5 is done" and the link edits of §9); `docs/plans/hq-round-trip/6-import.md`, `7-rest-of-model.md` (their citations of this plan point at where what endures lives)
- Kept, because the fuzz mapping and step 6 read them (R7): `lib/doc/fieldWriteOperations.ts`, `explicitPreloads.ts`, `repeatCountWraps.ts`, `groupFieldLists.ts`, `searchWorkflowPlan.ts`. Kept with its test, because that test holds the behavior claim every migrated app's links rest on (part 06 §14.1): `lib/doc/formLinkSemanticsMap.ts` and `lib/doc/__tests__/formLinkSemanticsMap.test.ts`; no fuzz mapping calls it. Kept too: the eight witnesses, `proof/migrations/` and `proof/hq-reads/targeted-migration-*`; `caseWritesLedger.postgres.test.ts`

## 3. What every pull request of the stack does

- **It is green at its own head.** Moving one fix's entries can leave another entry holding nothing
  on its document, which `proof/checks/registers.py::reconcile` refuses as `unseen`, so each pull
  request's lane passes at its head, not only the stack's. Each pull request moves the live entries
  its change fixes, in that pull request (part 08 §2.2), and adds none (part 08 §2.6).
- **A stored-shape change lands only where stated.** `Field.caseWrite.mode` leaves in 2; the
  operation model, the own arm, the write, the conditions, the explicit preload, `capture-link`, and
  the held slots of an operation and of a form's own close in 4; a query repeat's held `placement` in
  3; `holdPlacements` in 5; `Module.heldKind` and the `module-kind` target in 7 (R2); `group.fieldList` and
  `plainLabel` in 9; `caseSearchConfig.workflow`, `formsReadSearch`, `Module.caseListMenuItem` and
  `Module.caseListRegistrationForm` (with `caseListOnly`, `searchFirst` and `Form.entry` gone) in 10;
  `Form.otherwise`, the `this-form` target and `setFormOtherwise` in 11. Each is the shape the head
  holds; the one cutover (14) migrates every stored app into it with a fold horizon (resolution 12),
  so no feature pull request writes a migration of documents. Database shapes move only through the
  three ledgered migrations (6, 8, 14), and the App Test runtime moves only behind `RUNTIME_VERSION`
  18 (3).
- **A held slot is written by nothing but `holdPlacements` from pull request 5.** In pull request 3
  the query repeat's slot exists, and in 4 the operation's and the own close's, and no mutation
  payload carries them (every payload schema omits them, and a duplicate starts unheld), so only a
  document built with them (a targeted spec, the cutover) holds one; from 5, `holdPlacements` is the
  one writer and `placementSlotsWrittenOnlyByHolds.test.ts` holds it, and the kernel admits an
  editor's hold change only as a move its own batch makes necessary or the restore of the hold the
  target's latest recording wrote (R3); from 6, a publish records holds as `publish-placement`, and
  only a publish or a migration may record a hold that can still express its target
  (`placementChangeRefusal`). The `module-kind` slot and target follow the same rule from 7.
- **A served-schema change is found by hash.** Every pull request runs `npx tsx
  --conditions=react-server scripts/inspect-tool-schema-hashes.ts` at its base and head (free, no
  network) and records in its description the tools whose hash moved. Expected, from part 07 §4.2 and
  §4.7: the case-write tools in 2 and 4, the repeat descriptions in 3, `repeat_mode`'s published
  sentence (`addFields`, `editField`) in 5, `addCaseOperations` in 7 only under part 02's G6 outcome
  B, the search, module and form tools in 10, the form link tools and `setFormOtherwise` in 11, the new
  authoring inputs in 13, and none in 1, 6, 8, 9, 12, 14, 15 and 16 (a result field such as
  `identityMoves`, `caseWrites` or `placement` is no input schema; 6 and 8 change MCP-only tools). A
  tool whose description or projected schema moves is registered in `scripts/test-schema.ts` by the
  pull request that first moves it, and no pull request runs the billed check but 13 (R11).
- **`MODEL_CONTEXT_VERSION` moves in each pull request that changes a served tool's name,
  description or input schema, or the guide** (resolution 14, part 07 §4.7): `.2`, `.3`, `.4`, `.5`,
  `.7`, `.10`, `.11`, `.13`, each `"v6-hq-round-trip-case-writes.<n>"` and a distinct literal. A prompt
  change alone moves the separate `promptVersion` digest; an MCP-only description moves nothing.
- **A validator narrowing runs the corpus emission first** (no Docker, `--jobs 2`) at base and head,
  and compares the stop, the census, `index.json`'s document ids and the `(document, code, location)`
  finding multiset: pull requests 3 (the whole-number count), 4 (the own arm and the condition rules),
  7 (`FORM_LINK_NEEDS_NEW_CASE_DATUM`), 9 (`FIELD_LIST_USER_REPEAT`), 10 (`list-first` where Web Apps
  is declared, the `FORMS_READ_SEARCH_*` pair rule) and 11 (offered targets and the otherwise rules). A
  document the narrowing refuses takes the migration's own output in its producer (part 08 §4.2), or,
  for a fuzz draw, is mapped after the draw (part 08 §4.3); a fuzz sample is never drawn again.
- **A manifest flip edits its entry, its inventory row, and where its readings differ by platform its
  platform row and Preview cells, together**, in the pull request that first emits the construct
  (part 08 §7): 3, 4, 7, 9, 10 and 11. A REFUSED value class on a key Nova newly emits takes its
  reader in `proof/checks/manifest_value_classes.py::VALUE_CLASSES` in the same pull request (7, 11).
- **No pull request adds an `/api` route.** Pull requests 6 and 8 change existing routes
  (`app/api/apps/[id]/route.ts`, `app/api/apps/[id]/stream/route.ts`, `app/api/commcare/upload/route.ts`,
  `app/api/commcare/project-space-compatibility/route.ts`); pull request 10's claim writes and
  **Release claimed cases** reach the store through Server Actions (part 05 §10.4). One added while
  implementing takes its `lib/hostnames.ts` allowlist entry in the same pull request, or the proxy
  answers 404 in production while localhost serves it.
- **No public surface names a private HQ flag.** `lib/commcare/__tests__/projectSpaceCompatibilityBoundary.test.ts`
  reads `components`, `content/docs`, `lib/deployment`, `lib/mcp`, `lib/publish` and the two routes, and
  refuses every symbol of `HQ_PRIVATE_FEATURE_FLAG_SYMBOLS`; pull requests 4 and 8 add
  `SAVE_ONLY_EDITED_FORM_FIELDS` and `DONT_INDEX_SAME_CASETYPE` to the probe's symbols, so every
  sentence of §8 names the capability (**Save only answers that changed**, **links between cases of the
  same type**) and never the flag.
- **No pull request runs a served reader on the person's machine.** A reader run is a dispatch on
  GitHub's runners, started by the person (part 08 §8.4).

## 4. Ordering constraints

| Constraint | Reason |
|---|---|
| This plan's own pull request beneath the stack | It replaces the outline with this plan and writes the deferral notes of "What other parts read from this one", "For the outlines", into `6-import.md` and `7-rest-of-model.md` before any of step 5's code lands, sets the plans `README.md`'s step 5 row to "planned in full" with a "Nova since the research" list naming step 5's baseline (`main` at `2f985ed6`: #803, #805, #802 and step 4's stack #809 to #825, after `e9e6cd93`), and writes `harness-findings.md`'s "Found while planning step 5" |
| Lane mechanics (1) first, and settled on its own branch before the cut | The witnesses' pre-step A must be retained from `main`'s own emission, before any shape change, and the pre-step fixtures captured while `main`'s schema and gate admit them; `_cheapest_edited`'s fallback must exist before pull request 2 empties the first defect from the register; the `commtrackEnabled` reading before 8 writes it (R8); the capture hook before 6 records. A fix to 1 after the cut restacks fifteen lanes (part 08 §8.3) |
| Attachment mode removed (2) beneath case writes (4) and extension children (7) | Defect 23's entries on the `case-extension-*` documents sit under `nova_subcases/nova_subcase_*`; 7 moves those blocks and 4 moves every field write, which would re-path every still-live defect 23 entry from fresh evidence (part 08 §2.2) |
| Repeats (3) beneath any change to `case-operation-query`'s operation paths (4) | Its seven defect 25 entries move in 3 with the paths they have (part 08 §2.2); `RUNTIME_VERSION` 18 lands with the first change of what an App Test evaluates; the query repeat's held slot lands with the query placement it holds (R2), so the query-repeats witness's spec holds its placements from 3 |
| Case writes (4) beneath held placements (5) | `holdPlacements`' targets, `placementExpresses` and the moves read the operation model, the own arm and `planPlacements`; the operation's held slot is 4's because the case-writes witness's B must keep A's placements (part 08 §5.2) |
| Held placements (5) beneath publish placements (6) | `publish-placement` carries only `holdPlacements`, and the conflict lead reopens 5's `IdentityMoveDialog`; a hold recorded through publish needs the kind (decisions' stack constraint) |
| Publish placements (6) beneath advanced modules (7) and CommTrack (8) | 7's `module-kind` target joins 6's record and the kernel rule; 8's `same-type-child-links` offer has 6's offer shape and is recorded as a `publish-placement` change before preflight |
| Advanced modules (7) beneath CommTrack (8) | `commtrackReasons`' first arm reads 7's emitted kind through part 02's `advancedModulesWithCaseListMenuItem`, which 8 adds, and the same-type offer moves a basic subcase whose placement procedure 7 extends |
| Advanced modules (7) and CommTrack (8) beneath search and menus (10) | The decisions' order (R1; part 05 withdrew its request to sit beneath 7). Pull request 7 emits advanced modules with no case list menu item beside their forms: its readers read today's `caseListOnly` and `moduleOpensOnSearch`, and no advanced module holds a case list in its menu (a case-list-only module has no forms; an advanced module has the form holding its carried create), so kind blocker `case-list-menu-item-narrowed` meets no module. Pull request 8's `commtrackReasons` reads a menu item wherever a module holds one, before 10 only a formless one, and holds its advanced menu item arm with a Vitest witness. Pull request 10 makes `caseListMenuItem` admissible beside forms, points those readers at `moduleHasCaseListMenuItem` and `moduleFormsReadSearch`, emits the advanced module's case list menu item, flips `module-case-list-show-true-on-an-advancedmodule`, adds `targeted-commtrack-advanced` and writes its CommCare Supply effect (part 02 §17, part 05 §19, part 08 §2.2, §5.1 and G4) |
| Search and menus (10) beneath form links (11) | Defect 21's entry on `expander-form-links-emission-forwards-literal-condition-47c96355-0` moves in 10 (part 08's G3), and 11 rewrites that document's test keeping its title, so the document keeps its id; part 06's offered `previous` and otherwise read 10's `formsReadSearch` reason; `FORM_LINK_TARGET_CASE_LIST_REGISTRATION_FORM` is 10's name |
| Every model pull request (2 to 11) beneath the builder (12) and the agent (13) | 12 and 13 add the new authoring surfaces over shapes that already exist; each feature pull request carries only what its model change forces (decisions' stack constraint) |
| The builder (12) beneath the agent (13) | 13 is the last change to a tool or the guide, so the billed check asked at its head is the stack's one ask, and the `../nova-plugin` pull request is written against the final tool text |
| The agent (13) beneath the cutover (14) | The transform runs the head gate, reducer and planners, and the private work it discards would otherwise be staged against a guide that still moves; nothing above 14 changes a schema, a gate or a planner |
| The cutover (14) beneath contracts and public docs (15) | The notice's two public passages land with the notice; 15's sentences describe what the cutover leaves |
| Contracts and public docs (15) beneath the removal (16) | The maintenance image is built from 15's head and the Job is managed from a checkout of it, because the tool and its allowlist arm exist only there; `git diff --stat <15>..<16> -- lib app ':(exclude,glob)**/__tests__/**'` names only `lib/db/designSessions.ts`, so the gate that migrated is the gate the deploy's runtime probe runs |
| The three ledgered migrations sort in pull request order | `20261110000000` (6), `20261110010000` (8), `20261110020000` (14); the window applies all three in one phase inside the fleet transaction (part 09), none is applied while the previous revision serves, and `writer.postgres.test.ts` holds the pending set to exactly these three |
| Each HELD-NEW entry flips in the pull request that first emits it | The HELD-NEW lane check fails any head whose corpus emits an item only HELD-NEW entries name (part 08 §7.1) |

## 5. House rules for the stack

1. **One chain on the latest `main`.** The stack is one `gh stack` chain cut from the latest
   `origin/main` after this plan's pull request merges, and rebased on it before the first pull
   request opens. Every pull request is undrafted.
2. **`/code-review medium` runs on each pull request**, and its findings are fixed there. Where the
   review's agents sit idle for about a minute with no notification, their findings are collected by
   hand. Pull request 14's description names `scripts/lib/hqRoundTripCaseWrites/catalog.ts`, the
   postconditions and `catalog.postgres.test.ts` as the review's first files, because step 4's
   postcondition fix showed a name-only catalog read in removed tooling (part 09).
3. **The stack merges together** with `gh stack merge <top> --squash`: one push, one deploy. Never
   pull request by pull request, and never through the merge API.
4. **Fix-ups go to the pull request they belong in, and a session's pushes are batched into one.** A
   push to pull request k restacks every pull request above it, each a fresh lane of 12 shard-jobs: a
   push to 1, or cutting the stack, starts 16 lanes and 192 shard-jobs, about ninety minutes of the
   account's twenty runners and over four hours while a scheduled lane with the readers holds fourteen
   of them (part 08 §8.3); a push to 2 starts 15 lanes and 180 shard-jobs. No restack is pushed while a scheduled lane with the readers runs.
5. **Pull request 1 is settled on its own branch before the stack is cut**: its lane, its tests, part
   08's G1 retention (its second commit) and its run by hand. Pull requests 2 to 16 are cut onto it once
   it holds. Reason: 1 moves what every later lane reads (the queue, the witnesses, the retained A),
   and a fix to it after the cut restacks fifteen lanes.
6. **No heavy run on the person's machine.** The no-Docker corpus emission with `--jobs 2` and pure
   Vitest files are the only runs that belong there without asking, with the Playwright specs a pull
   request adds or changes run locally one at a time before its push. Every lane slice, native family,
   fresh lane and reader run goes to GitHub's runners.
7. **The billed schema check is asked once, at pull request 13's head** (R11; part 07 §4.8, its
   G-A1), naming every `scripts/test-schema.ts` entry any pull request of the stack added or changed,
   and no other pull request runs it. The hash run at `main` `2f985ed6` and at that head is its check:
   a tool whose hash moved and that the list misses joins the list and the count, named as the
   difference. On the person's yes the implementer runs `npm run test:schema -- <name>` once per name,
   never the bare command. The question, with part 07's names: "Step 5 adds or changes 19 of the tool
   definitions the Solutions Architect is given, and `npm run test:schema` checks that OpenAI accepts
   each one. Running it for these 19 sends 19 live OpenAI requests on your key, one per schema:
   `addFields`, `editField`, `setFieldOptionsSource`, `addCaseOperations`, `updateCaseOperation`,
   `getCaseOperations`, `removeCaseOperation`, `moveCaseOperation`, `createForm`, `updateForm`,
   `createModule`, `updateModule`, `configureCaseList`, `setCaseSearchAdvanced`, `addFormLinks`,
   `updateFormLink`, `moveFormLink`, `removeFormLink` and `setFormOtherwise`. May I run it?" The
   entries whose description alone changed (`getCaseOperations`, `removeCaseOperation`,
   `moveCaseOperation`, `moveFormLink`, `removeFormLink`) are among them, since the provider receives each tool's
   description with its schema. A schema the provider refuses is fixed in the pull request that owns
   it, and the question is asked again for that schema alone.
8. **Reader runs by hand.** Each pull request of part 08 §8.4's table (1, 2, 3, 4, 7, 9, 10, 11) starts
   its row on GitHub's runners once its lane holds, with `gh workflow run proof-audit.yml --ref
   <branch> -f nightly=false -f mechanics=<list> -f mechanics_shards=auto -f mechanics_readers=true`,
   and one run over the union
   of the rows runs at the top of the stack before the merge. Decision 6's case list menu item run
   (part 05's G1) is pull request 10's, and part 06's G1 to G3 are pull request 11's.
9. **The cutover runs before the merge** (part 09's runbook). The maintenance image is built by hand
   (`docker build --platform=linux/amd64 --target=maintenance`) from pull request 15's head, and the
   Job `commcare-nova-hq-round-trip-case-writes` is made from that image and managed from a checkout of
   that commit. `main` is frozen from the image build to the merge; a rebase after the image is built
   rebuilds it and repeats the dry run. The runbook records pull request 15's head and the image
   digest; the window's order, its checks and its rollback are part 09's. The Job reads no media
   bucket and no KMS key, so the window makes no grant. A fix made after pull request 14's review,
   during the advisory runs or the window, lands as its own commit on pull request 14 with its own
   `/code-review medium` over that commit's range, findings fixed, before `gh stack merge`; the window
   does not reopen ingress on an unreviewed fix.
   The production scan found neither shape the transform treats as a guard: no module holds two
   registration forms from its case list (the blocker `renamed-concept-conflict`) and no section holds
   a user repeat (which `main`'s gate and the head's refuse alike, met as `target-gate`). `main`'s gate
   admits neither, so no app can come to hold one before the window, the runbook schedules no repair
   for them, and each stays a guard the window's dry run never expects to meet; where it meets one, the
   remedy is part 09 §16's, a data repair the app's author makes in today's builder before the window.
10. **After the merge, the deploy is watched on the merge commit with `gh`**: the commit's check-runs
    are listed first (`gh api repos/voidcraft-labs/commcare-nova/commits/<sha>/check-runs --jq
    '.check_runs[] | {name, app: .app.name, status, conclusion}'`) and the watch is built from the name
    and app observed there; an empty list is an error to look into. Pull request CI being green is not
    a deploy, and this deploy runs the runtime probe. The build's `verify` step fails while the NEG is
    detached: wait for `deploy` to report the revision ready, then follow the runbook's last steps.
11. **The first nightly after the merge is the whole lane with every reader.** The merge moves every
    key, so the next scheduled night (Tuesday to Saturday, 03:23 UTC) runs about 13.5 hours on up to
    fourteen of the twenty runners, about half an hour more for the thirty-three new documents; the
    merge is made Monday to Friday so that night follows it. A night that fails opens an issue naming
    each failing group with the command that reruns it alone (`python3 -m proof.lane.report`); the
    implementer fixes from that list and reruns only the documents on it (part 08's G8). When the night
    passes (part 08's G8 outcome A), one pull request the next working day, with its own `/code-review
    medium`, holds only `proof/timings.json`'s `readers` profile and `proof/README.md`'s timing numbers
    with every reader, written from that night's run.
12. **The `../nova-plugin` change rides its own pull request**, opened beside pull request 13 and
    merged only after the Nova deploy is live (rule 10 confirms it); §10.

Removing the tooling at the top of the same stack, not in a follow-up pull request, keeps steps 2, 3
and 4's choice: a later removal would be a second deploy that exists only because of the split, and
the run and its postconditions precede the merge. The one planned step after the deploy, before
ingress reopens, writes the case-schema drift the dry run counted with the existing drift writer from
merged `main` through `commcare-nova-case-type-schema-retirement`, step 3's and step 4's precedent,
which the removal does not touch (part 09). The `commcare-case-claim` type's case-schema row is one of
those planned differences: the drift writer materializes it after the deploy, not the fleet
transaction, and `computeSchemaDrift` gains no skip for it (R16).

## 6. The model-addition checklist

Each addition is complete when its pull request lands, and its author ticks every place below or
writes "none" with the reason. Step 5's additions:

- **Stored keys and arms**: the operation union's `action: "own"` arm, the write's `via` and
  `onlyIfChanged`, the target `{ kind: "worker-record" }`, the term `capture-link`,
  `Form.openCondition` and `Form.closeCondition` as `Expression`s, `placement?` on every operation arm
  and `Form.ownClosePlacement?` (4, the basic and Save to Case arms of `casePlacementSchema` and
  `ownClosePlacementSchema`); `Field.caseWrite` removed (4, its `mode` in 2); a query repeat's
  `placement?` (3, R2); `holdPlacements` with the case operation, own close and query repeat targets
  (5); `Module.heldKind?: "advanced"`, the `advanced` arm of `casePlacementSchema` and the
  `module-kind` target (7). No stored `Form.caseSelections`, `selection` operation target or
  `form-case.selection` read exists in step 5 (R4): an advanced form's loads are derived from its
  menu's parent selection; `group.fieldList?: true` and `plainLabel?: true` on question, container and
  section labels and inline choices (9); `caseSearchConfig.workflow?`, `formsReadSearch?`,
  `Module.caseListMenuItem?`, `Module.caseListRegistrationForm?` (10, with `caseListOnly`,
  `searchFirst` and `Form.entry` removed); `Form.otherwise?`, the target `{ type: "this-form" }` and the
  mutation `setFormOtherwise` (11). Database: the `publish-placement` kind in
  `public.nova_admit_app_change_insert()` (6); the confirmation kind `commtrack-off` (8); the sixth fold
  identity `fold-baseline:hq-round-trip-case-writes` / `system:hq-round-trip-case-writes` (14). App Test
  journey state: claims as rows in the journey's namespace (10), under `RUNTIME_VERSION` 18 (3).
  Session state, never stored: `pendingIdentityMove` (5), `previewAfterSubmitStack` (11).
- **Platform features**: `plain-text` (9); `list-first` (new), `search-first` (redefined),
  `skip-to-results` (authored), `forms-read-search` (new id) and `search` reading `formsReadSearch`
  (10); `case-list-menu-item` with the beside-forms entry by decision 6's outcome (10); the advanced
  rows part 02 §20 gives (7); `after-submit-several-destinations` under part 06's G1 outcome A (11).
- **Validation codes and reasons**, each with its rows in the typed-total tables of place 2. The
  messages are the owning part's, word for word; this table holds where each lands.

| Code or reason | PR | `errors.ts` | `gate.ts::VALIDITY_CLASS_BY_CODE` | `lib/doc/userFacingErrors.ts` | Owner of the message |
|---|---|---|---|---|---|
| `CASE_LIST_COLUMN_OVER_ATTACHMENT_SLOT` | 2 | retired | row removed | row removed | part 01 §17 |
| `CASE_OWN_OPERATION` (reasons `missing`, `duplicate`, `position`, `form-type`) | 4 | new | `soundness` | the finding's message with the form named | part 01 §17 |
| `OPEN_CONDITION_WRONG_TYPE` | 4 | new | `soundness` | as above | part 01 §17 |
| `CASE_OPERATION_CLOSES_OWN_CASE` | 4 | new | `soundness` | as above | part 01 §17 |
| `CASE_WRITE_VIA_INVALID` (`new-case`, `target`, `step`, `unresolved`, `placement`) | 4 | new | `soundness` | as above | part 01 §17 |
| `CASE_WRITE_ONLY_IF_CHANGED_INVALID` (`new-case`, `target`, `placement`) | 4 | new | `soundness` | as above | part 01 §17 |
| `CASE_WRITE_NO_CASE_ACTION`, `CASE_WRITE_UNKNOWN_TYPE`, `CASE_WRITE_NOT_DIRECT_CHILD`, `PRIMARY_CASE_FIELD_IN_REPEAT`, `USERCASE_FIELD_IN_REPEAT`, `CASE_CREATE_NAME_DUPLICATE`, `RESERVED_CASE_PROPERTY`, `CLOSE_CONDITION_INCOMPLETE`, `CLOSE_CONDITION_FIELD_NOT_FOUND` | 4 | retired | rows removed | rows removed | part 01 §17 |
| checker `expected-value` reason `capture-answer`; `arm-unavailable` reasons `capture-link-slot`, `capture-link-field` | 4 | the slot's code | the slot code's | the checker's message | part 01 §17 |
| `HELD_PLACEMENT_INEXPRESSIBLE`, `CASE_PLACEMENT_SHARED`, `HELD_BLOCK_PATH_TAKEN` | 5 | new | `soundness` | as above | part 01 §13.2 |
| `QUERY_REPEAT_MODEL_ITERATION_SHAPE` (its held arm) | 5 | new | `soundness` | as above | part 04 §1.7 |
| checker `expected-value` reason `whole-number-count` on slot `repeat_count`, reported as `REPEAT_COUNT_TYPE` | 3 | the slot's code | the slot code's | part 04 §2.5's sentence | part 04 §2.5 |
| `FORM_LINK_NEEDS_NEW_CASE_DATUM` | 7 | new | `soundness` | as above | part 02 §15 |
| `FIELD_LIST_USER_REPEAT` | 9 | new | `soundness` | as above | part 04 §3.5 |
| `FORMS_READ_SEARCH_*` (renamed from `SEARCH_FIRST_*`), `CASE_LIST_REGISTRATION_*` (renamed from the no-matches codes), `CASE_LIST_MENU_ITEM_NO_CASE_TYPE`, the list-first and forms-read-search pair; checker reason `not-forms-read-search` (renamed from `not-search-first`) | 10 | renamed and new | existing classes kept | renamed rows | part 05 §6.1, §6.3 |
| `FORM_LINK_TARGET_NOT_OFFERED`, `FORM_LINK_MENU_DATUMS`, `FORM_LINK_SELF_REFERENCE`, `FORM_OTHERWISE_NOT_OFFERED`, `FORM_OTHERWISE_UNREACHABLE`, `POST_SUBMIT_BESIDE_FORM_LINKS`, `FORM_LINK_SEARCH_CASE_UNREPRESENTABLE`; `FORM_LINK_UNREACHABLE`, `FORM_LINK_NO_FALLBACK` and the circular rule retired; `FORM_LINK_TARGET_CASE_LIST_REGISTRATION_FORM` | 11 | new and retired | `soundness` | new and removed rows | part 06 §8 |
| `PLATFORM_FEATURE_UNAVAILABLE` for `list-first`, `forms-read-search` and any refusable row part 02 §20 or part 05's decision 6 run adds | 7, 10 | existing | existing | `platformBuilderSentence` | parts 02 and 05, with each row's refusal copy and fixture |

  Outside the validator, each with its sentence in the part that owns it: the kernel's refusal
  `PLACEMENT_CHANGE_REFUSAL` (5, part 03 §3); the deployment refusals
  `app_changed_while_publishing` and `hq_placement_moves_changed` and the 409 `reason:
  "placement-recorded"` (6, part 03 §5, §6, §16); the confirmation `commtrack-off` and the capability
  `same-type-child-links` with its `project_space_incompatible` offer (8, part 03 §8, §9, §16);
  `ClaimCasesInputError` (10, part 05 §10); the cutover's blockers (14, part 09).

The places:

1. **Schema.** `lib/domain/forms.ts`, `modules.ts`, `fields/*.ts` and `placements.ts` for the
   document; `lib/doc/types.ts` for the patches and `holdPlacements`; `lib/domain/expression/types.ts`
   for `capture-link` with its hand-declared TypeScript arm and the drift guard. A stored shape lands
   only in the pull request named above, and a held slot is omitted from every other mutation payload.
2. **Validator tables.** A new `ValidationErrorCode` takes its row in `errors.ts`,
   `gate.ts::VALIDITY_CLASS_BY_CODE` and `lib/doc/userFacingErrors.ts` in its own pull request, or that
   pull request does not compile; a checker reason takes its presentation line in
   `components/builder/shared/checkErrorPresentation.ts::PRESENT_BY_CODE` beside its code. The agent
   and MCP voice of a refusal is the finding's message, never a second sentence.
3. **The platform table and the manifest.** A feature that behaves differently by platform is a row
   of `PLATFORM_FEATURES` with its entries in `lib/commcare/surface/platformFeatureEntries.ts`, held by
   `platformFeatures.test.ts`; a refusable row carries its refusal copy, its fixture in
   `lib/domain/__tests__/platformFeatureFixtures.ts`, its builder offering disabled with
   `platformPickerLine`, and a cause word in `lib/notices/migrationNoticeCopy.ts::PLATFORM_CAUSE_WORDS`
   (with `HISTORICAL_PLATFORM_CAUSE_WORDS` keeping `search-first`'s stored rows, 10). Its manifest entry
   flips in the same pull request with its inventory row (part 08 §7).
4. **Wire.** `lib/commcare/placement.ts` and `casePlacementPlan.ts` for where an operation is kept and
   what the wire needs from it; `formActions.ts`, `xform/caseOps.ts`, `xform/caseBlocks.ts` for the
   basic and Save to Case blocks; `xform/advancedCaseBlocks.ts` and `session.ts` for the advanced arm;
   `formLinkProjection.ts` for links; `xform/builder.ts` for repeats, field lists and markdown;
   `suite/case-search/searchWireShape.ts` for the workflow; the oracles; `lib/commcare/CLAUDE.md`.
5. **Preview.** A rule field in `lib/preview/platform.ts` for a behavior that differs by platform; a
   cell-table row in `lib/preview/__tests__/platformCells.ts` for every differing HELD cell (held by
   `platformCells.test.ts`); the submission program for every case change (4); the after-submit stack
   (11).
6. **Postgres.** The submission program in `lib/case-store/postgres/submissionEnvelope.ts` runs the own
   arm first and every operation in array order (4); a claim is a `commcare-case-claim` row (10); the
   `Expression`→Kysely compiler takes `capture-link` as an unwritten value, as a link write is today (4).
7. **Index.** `lib/doc/referenceIndex.ts` records the own arm's reads, each write's `via` identifiers,
   a choice leaf in a condition (4), `caseListRegistrationForm`'s form (10), and `Form.otherwise`'s
   target (11). A held placement names no identity and records nothing.
8. **Builder cards and offering.** The case changes screen and Saves to (4, 12), This form's case (4,
   12), `IdentityMoveDialog` (5, 6), When this menu opens and the case list in the menu (10), After
   submit (11), Show on one screen, Format text and the Rows editor (12); every offering site by
   declaration with `platformPickerLine` and held to the gate by
   `lib/doc/__tests__/platformOfferParity.test.ts` (part 07 §3.15).
9. **SA and MCP.** Static schemas (part 07 §4.2); `identityMoves` on every staging result and
   `saveWork` (5); the overview's and reads' new fields; the guide's sentences (part 07 §4.5); MCP-only
   `accept_placement_moves` and `confirm_commtrack_off` (6, 8). `lib/mcp/__tests__/servedSchemas.test.ts`
   compiles every served schema and its patterns, unchanged.
10. **Public docs.** The page for the task a reader does (§8), `content/docs/mcp/tools.mdx` for the
    callable reference, and `where-workers-use-your-app.mdx` for each feature one platform cannot run.
11. **Proof.** The native family that holds a runtime fact (part 08 §6.1); a targeted document where no
    corpus source draws the shape (part 08 §5.1); a migration witness for each migration that changes
    the wire or an identity (part 08 §5.2); a lane test over HQ's own pages, views or models where a
    rule is HQ's (part 08 §6.2).
12. **Existing documents.** A class of the one cutover (part 09), its notice reason where a person or
    worker sees a change (resolution 13), its blocker where the transform can refuse, its count in the
    scan; and, for the fuzz mapping, a pure planner kept in `lib/doc` past pull request 16 (part 08
    §4.3).
13. **`MODEL_CONTEXT_VERSION`** (`lib/models.ts`), moved where the name, description or input schema of
    a tool the Solutions Architect is offered, or the guide, changes:

    | PR | Change | Value |
    |---|---|---|
    | 2 | `caseWrite` loses `mode`; `FIELD_DOCS.caseWrite` | `"v6-hq-round-trip-case-writes.2"` |
    | 3 | the repeat descriptions, the guide's repeat and query sentences, `repeat` `saDocs` | `"v6-hq-round-trip-case-writes.3"` |
    | 4 | `caseWrite`'s description; the case change tools and the own arm; `close_condition` as an expression; the guide's case-write sentences | `"v6-hq-round-trip-case-writes.4"` |
    | 5 | the guide's identity paragraph and repeat sentence; `FIELD_DOCS.repeat_mode`'s published sentence | `"v6-hq-round-trip-case-writes.5"` |
    | 7 | the identity paragraph's menus and the advanced reads part 07 §4.2 gives (and, under part 02's G6 outcome B, `addCaseOperations`' description) | `"v6-hq-round-trip-case-writes.7"` |
    | 10 | the search, module and form tools; the guide's search sentences and the generated platform sentences of the changed rows | `"v6-hq-round-trip-case-writes.10"` |
    | 11 | the form link tools and `setFormOtherwise`; the guide's after-submit sentences and the new generated sentence | `"v6-hq-round-trip-case-writes.11"` |
    | 13 | every new authoring input; the final guide; `group` `saDocs` | `"v6-hq-round-trip-case-writes.13"`, the value the stack deploys |

    Pull requests 1, 6, 8, 9, 12, 14, 15 and 16 leave it: 6 and 8 change MCP-only tools, 9 changes
    only what a tool does with input it already takes, 12 is the builder, and a field added to a read
    result is no input (`lib/agent/CLAUDE.md`).
14. **The billed schema check.** `scripts/test-schema.ts` proves the provider accepts a tool
    definition the Solutions Architect is given, one live OpenAI request per entry sent. Registrations:
    `getCaseOperations`, `removeCaseOperation`, `moveCaseOperation` in 4; `setFormOtherwise`,
    `moveFormLink`, `removeFormLink` in 11; each with its import and its name in the header's "Known
    names"; the prompts part 07 §4.8 writes, changed in 4, 10, 11 and 13. 55 entries become 61. The
    question is house rule 7's, asked once at 13's head over every entry added or changed (R11). A tool only MCP serves is checked by
    `lib/mcp/__tests__/servedSchemas.test.ts` without billing.
15. **Docs**: the nearest subtree `CLAUDE.md` in the pull request whose behavior makes it false (§7);
    `docs/architecture/complex-apps.md` where the addition records a binding CommCare fact, and
    `contracts.md` where it is a contract (15); the public docs of place 10 (15).
16. **`../nova-plugin`**: sweep its prose for the claim the change makes false; the change rides the
    plugin's one pull request (§10).

The checklist leaves with this plan (pull request 16): every place it lists is in the code, and a
later step's plan lists them again as the code then stands.

## 7. Contract sentences step 5 rewrites

Each "Today" was read in today's file at `main` `2f985ed6` and is quoted whole or by its opening
words where the row's replacement takes the sentence whole; where the source wraps a sentence over
lines, the quote joins them with one space. A section is named by its heading or its opening words.
"Kept; adds" means the quoted sentence stays and the new text follows it. A replacement in quotation
marks is the text as written; it names no plan step, pull request, part, defect or finding, because the
plan leaves the repository in pull request 16 and a contract file says what is so. The proof lane's
documents and the research's findings are the exception: they name steps, defects and findings today
and keep doing so (§9).

"PR" is the pull request whose change makes the sentence false, and the sentence moves with that
behavior, so every `CLAUDE.md` is true at every head. `docs/architecture/contracts.md` and
`complex-apps.md` ride pull request 15, and their "PR" cells read "15 (behavior n)". Where a part
already holds a row's replacement text word for word, the row cites it rather than restating it; that
part's text is the replacement, written as the part gives it.

### 7.1 The research's contracts table, step 5 rows

The research's "Contracts this work changes" table gives fourteen rows to step 5. Each row's place
below, or the reason it needs none:

| Research row (contract today) | At `main` | Where step 5 rewrites it |
|---|---|---|
| root `CLAUDE.md`, model 3: "Nova speaks its own clean vocabulary; CommCare's wire vocabulary is quarantined behind `lib/commcare`" (steps 2, 5, 7) | true; it names `localization.wireCodes` as the one held identity and says `xmlns` and HQ ids are derived | §7.2, root row 1 (6) |
| `lib/commcare/CLAUDE.md`: "Each multiplicity scope gets a reserved `__nova_operations` container" (steps 2, 5) | already false and gone: step 2 replaced it with "Nova reserves no question names. Each generated node is named `nova_`, …", and `count_bound` says "No count setvalues or count snapshots remain" | claim corrected, no step 5 change to that sentence; step 5's half of the row is defect 30's direct `jr:count` (`count_bound` row, 3) |
| `lib/commcare/CLAUDE.md`: "All itext entries (labels, hints, option labels) emit both `<value>` and `<value form="markdown">`." | true | `lib/commcare/CLAUDE.md` row "Markdown itext" (9) |
| `lib/commcare/CLAUDE.md` (Exclusive guards): "Core executes EVERY true `<create>` and lands on the LAST one" | true | `lib/commcare/CLAUDE.md` row "Exclusive guards" (11) |
| `lib/commcare/CLAUDE.md` (`count_bound`) | true | `lib/commcare/CLAUDE.md` row `count_bound` (3) |
| `lib/commcare/CLAUDE.md` (`query_bound`): "The membership list is an initial snapshot." | true in substance; the sentence reads "Setvalues initialize ids at form load or parent-row insertion" | `lib/commcare/CLAUDE.md` row `query_bound` (3) |
| `lib/commcare/CLAUDE.md`: "… under a reserved `__nova_subcases` container" (steps 2, 5) | the research quotes `__nova_subcases`; `main` says "under a `nova_subcases` group at the exact parent/repeat scope" (claim corrected) | `lib/commcare/CLAUDE.md` row "Case-management scaffolding emission" (7) |
| `lib/db/CLAUDE.md`: "Its closed kind set is `autosave`, `mcp`, `chat`, `blueprint-migration`, `fold-baseline`, and `project-move`." | true | `lib/db/CLAUDE.md` row 1 (6) |
| `contracts.md`: "the closed kind set is `autosave \| mcp \| chat \| blueprint-migration \| fold-baseline \| project-move`." | true | `contracts.md` row 1 (15, behavior 6) |
| `contracts.md`: "The browser collaboration frame is intentionally narrower: it accepts only `autosave \| mcp \| chat`." | true | `contracts.md` row 2 (15, behavior 6) |
| root `CLAUDE.md`: "its mutation-bearing `autosave` / `mcp` / `chat` rows also feed multiplayer, …" | true | root row 2 (6) |
| `contracts.md`: "An eligible field writes case data only through `caseWrite: { caseType, property }`" | true | `contracts.md` row 3 (15, behavior 4) |
| `lib/domain/CLAUDE.md`: "`registration` creates a case, `followup` updates one, `close` loads + closes (a superset of followup), `survey` touches no case." (steps 5, 7) | the research's quote is older; `main` says "`survey` opens no primary case; it may still update declared worker properties" | `lib/domain/CLAUDE.md` row "Four form types" (4); step 7's half (its open and close conditions on more types) stays in the step 7 outline |
| `lib/domain/CLAUDE.md`: "`casePreload.ts` is the ONE statement of which answers a form seeds from the case it opened" | true | `lib/domain/CLAUDE.md` row "casePreload" (4) |
| `lib/domain/CLAUDE.md`: "A form's optional `entry` (`{ kind: "search-no-matches", label? }`) says how it is reached" | true | `lib/domain/CLAUDE.md` row "entry" (10) |
| `contracts.md`: "Case attachment display is link-first. … The deprecated `MM_CASE_PROPERTIES` attachment mode is an explicit opt-in" | true | `contracts.md` row 4 (15, behavior 2) |

The research's table names the `publish-placement` fact in four files; `main` states it in two more,
which step 5 rewrites with the others: `lib/collab/CLAUDE.md` ("The client frame admits exactly
`autosave | mcp | chat`;") and the comment on the kinds in `lib/db/types.ts` ("Browser reconciliation
accepts only the first three kinds"). The authoring brief's pointer to `lib/lookup/CLAUDE.md`'s
"initial snapshot" names the lookup manifest stream's first read, not a query repeat's rows; it stays
true and step 5 leaves it.

### 7.2 CLAUDE.md (root)

| Section | Today | From step 5 | PR |
|---|---|---|---|
| "The mental models", item 3 | "The document does hold each language's CommCare wire code (`localization.wireCodes`), an identity no author chooses." | "The document does hold identities no author chooses: each language's CommCare wire code (`localization.wireCodes`), and where CommCare HQ keeps each published case change and query repeat and which menus it holds as advanced, which a publish records." | 6 |
| "The map", `lib/db` | "its mutation-bearing `autosave` / `mcp` / `chat` rows also feed multiplayer, while `blueprint-migration` / `fold-baseline` / `project-move` are server-only reload boundaries" | "its mutation-bearing `autosave` / `mcp` / `chat` / `publish-placement` rows also feed multiplayer, while `blueprint-migration` / `fold-baseline` / `project-move` are server-only reload boundaries" | 6 |
| "The map", `lib/deployment` | "Every publish writes where the app runs as its Web App setting, and asks before changing the setting HQ holds." | kept; adds "Before anything is sent, a publish records where CommCare HQ keeps each case change, query repeat and advanced menu it carries for the first time, so every later publish keeps them there." | 6 |

### 7.3 docs/architecture/contracts.md

| Section | Today | From step 5 | PR |
|---|---|---|---|
| "Delivery discipline", the `app_changes` admission | "`app_changes` has its own exact envelope admission: the closed kind set is `autosave \| mcp \| chat \| blueprint-migration \| fold-baseline \| project-move`. The first four carry a nonempty admitted mutation batch and null Project-move columns;" | part 03 §19's pull request 15 text: "… the closed kind set is `autosave \| mcp \| chat \| publish-placement \| blueprint-migration \| fold-baseline \| project-move`. The first five carry a nonempty admitted mutation batch and null Project-move columns; `publish-placement` is written only by a publish, at the head it emitted and before anything reaches CommCare HQ, and holds only placement holds;" | 15 (behavior 6) |
| same, the collaboration frame | "The browser collaboration frame is intentionally narrower: it accepts only `autosave \| mcp \| chat`." | "The browser collaboration frame is intentionally narrower: it accepts only `autosave \| mcp \| chat \| publish-placement`, which open tabs fold without a reload, keeping their undo history." | 15 (behavior 6) |
| "Identity and references", the field bullet | "A field's immutable `uuid`, local question/path `id`, and optional case-data binding are three different facts. An eligible field writes case data only through `caseWrite: { caseType, property }`; changing `id` changes the friendly form path only, and changing `caseWrite` retargets only that writer. Neither gesture implies an app-wide case-property rename." | "A field's immutable `uuid` and local question/path `id` are two different facts, and what it saves to a case is held outside it. A form writes case data only through its case operations, and the form's own case is one of them; a field's "Saves to" is the view of the writes that read its answer. Changing a field's `id` changes the friendly form path only, and changing "Saves to" retargets only those writes. Neither gesture implies an app-wide case-property rename." (part 01 §23 item 1 with the first sentence restated) | 15 (behavior 4) |
| "Deliberate target gaps", the attachment bullet | "**Case attachment display is link-first.** URL-property mode is the default and the normal path; …" through "Inline picture presentation is not promised until the Web Apps HTTPS-resource path works." | "**A captured file reaches a case only as a link.** A write's `capture-link` value is the CommCare HQ address of the submitted file, and a `link` column makes it openable. Nova writes no case attachment, so no case property is an attachment slot. Inline picture presentation is not promised until the Web Apps HTTPS-resource path works." (part 01 §23 item 2, with the last sentence kept) | 15 (behavior 2) |
| "HQ deployment safety", a new bullet after the drift bullet | (none) | adds "- A case change's placement (a Case Management action, an advanced menu's case action and its tag, or a Save to Case block path), a query repeat's placement and a menu's advanced kind are held from the publish that first carries them, because they are where CommCare HQ keeps published answers. Only a publish or a migration records or replaces a hold that can still express what it holds; an edit the hold cannot express moves it, as an identity edit every editor states before it saves, and undoing that edit puts it back where the publish recorded it. A menu CommCare HQ holds as advanced stays advanced while it can be one." (parts 01 §23 item 3, 02 §25 and 03 §19, joined; the undo clause is R3's arm (b)) | 15 (behavior 5, 6, 7) |
| "Case operations and submissions", the last bullet | "The preview store exposes one atomic submission envelope containing ordinary form behavior plus advanced operations. It is not a mutually exclusive fifth submission variant." | "The preview store exposes one atomic submission envelope holding the form's case operations in their array order, its own case's change first. It is not a mutually exclusive fifth submission variant." | 15 (behavior 4) |

`contracts.md` names no search workflow, menu concept or link semantic at `main` (parts 05 §15 and 06
§15.2 read it: only "Endpoint, search, claim, and known-case hydration URLs", and "Every wire unit
names its fixture", which already covers form links), so pull requests 10 and 11 add nothing there.
Part 02 §25 names a `contracts.md` row on `__nova_subcases`; `contracts.md` holds no such sentence at
`main` (the extension sentence is `lib/commcare/CLAUDE.md`'s and `complex-apps.md`'s, rewritten in §7.4
and §7.5), so its other row, that a menu CommCare HQ holds as advanced stays advanced while it can be
one, joins the "HQ deployment safety" bullet above.

### 7.4 docs/architecture/complex-apps.md

| Section | Today | From step 5 | PR |
|---|---|---|---|
| "Field id, case writes, and app-wide property rename", first two paragraphs | "A field carries three independent facts: its immutable `uuid`, its local question/path `id`, and — on eligible kinds — an optional `caseWrite: { caseType, property }` …" and "`lib/domain/caseWriteInventory.ts::deriveCaseWriteInventory` is the one form-tree walk that assigns writers to case actions, …" with its admission bullets | "A field carries two independent facts, its immutable `uuid` and its local question/path `id`; what it saves to a case is a write in its form's case operations. Changing `id` changes the question node and the friendly projection and nothing else; `moveField` preserves `id` and rejects a destination sibling collision instead of auto-renaming. There is no `renameField` mutation arm and no before/after heuristic that reads a local edit as global rename intent." and "A form's case writes are its case operations. The form's own case is the `own` arm, first on every registration, follow-up and close form, its lifecycle the form's type with `Form.openCondition` and `Form.closeCondition`; every other case's create, update and close is an operation of its own. A field's "Saves to" is `lib/domain/caseWriteViews.ts::fieldCaseWriteViews`, the writes whose value is a bare read of the field or a link to its file, and `lib/doc/fieldCaseWriteMutations.ts::planFieldCaseWrite` is its one planner. Where CommCare HQ keeps each operation is `lib/commcare/placement.ts::planPlacements`: a hold first, then the simplest placement that can express it (a basic form action, an advanced menu's case action, or a Save to Case block), under a closed list of eligibility conditions that HQ's Case Management tab, its advanced case actions and its build each impose." The scalar-text paragraph stays | 15 (behavior 4) |
| "### User properties, user types, and preview personas", the save paragraph | "**A form can save an answer into it.** `commcare-user` is a third `deriveCaseWriteInventory` bucket beside primary and child, …" | "**A form can save an answer into it.** The worker's record is a case operation's target, `{ kind: "worker-record" }`, of at most one update of `commcare-user` per form, on any form including a survey with no case type of its own; one form writes one worker record, so its writes take no repeat." with the paragraph's remaining sentences kept | 15 (behavior 4) |
| "#### Search first" | the section, opening "A module may open on its Search screen instead of a browse list (`caseSearchConfig.searchFirst: true`, `lib/domain/modules.ts::moduleOpensOnSearch`)." | "#### The search workflow" with part 05 §15's text: the table of `searchWireShape` (search first `auto_launch`, skip to results `auto_launch` with `default_search`, list first neither, forms reading the search `inline_search` beside the first two); list first only where Web Apps is not declared; search first and skip to results ignored on Android; forms reading the search is HQ's inline shape, unavailable on Android | 15 (behavior 10) |
| "#### Register when nothing matches" | "A search-first module may offer one registration form only after a search completes with nothing found (`Form.entry = { kind: "search-no-matches", label? }`, `lib/domain/forms.ts::formEntersFromMenu`)." | "A menu whose forms read the search may offer one registration form from its case list, shown only after a search completes with nothing found (`Module.caseListRegistrationForm = { kind: "after-empty-search", formUuid, label? }`, `lib/domain/menuForms.ts::caseListRegistrationFormOf`)." and in the same section "Search first is itself unavailable on Android, so a module that opens on Search, and its no-matches form, exist only in an app that runs in Web Apps only." becomes "Forms reading the search is itself unavailable on Android, so a menu whose forms read the search, and its registration from the case list, exist only in an app that runs in Web Apps only." `lib/doc/searchNoMatchesForm.ts` becomes `lib/doc/caseListRegistrationForm.ts` | 15 (behavior 10) |
| "### Case operations", the reserved types paragraph | "Reserved case types are `commcare-user`, `commcare-case-claim`, and `user-owner-mapping-case`." | kept; adds "Preview writes `commcare-case-claim` rows, one open claim owned by the worker with a `host` extension index to each chosen case, as HQ's claim does, and a person releases them from the identity menu." | 15 (behavior 10) |
| "### Attachment questions", the capture paragraph | "**A capture's `caseWrite` carries a required `mode`, and the case update names a node the capture question is not.** … `mode` says what is written instead. `"url"` writes a link to the file, …" | "**A capture reaches a case as a `capture-link` write, and the case update names a node the capture question is not.** A capture's answer is the submitted file's name, so the answer can never BE the case value; the write's value is `capture-link(#form/<question>)`, a link to the file, built as" with the rest of the paragraph (the sibling node, its relevance) kept | 15 (behavior 2, 4) |
| "### After-submit links" | "it emits the exclusive guards that make "first true link wins" true (Core executes every true `<create>` and lands on the last; HQ emits authored conditions raw), treats a terminal unconditional link as the exhaustive else that suppresses the fallback frame" | part 06 §15.2's text; the mutation list adds `setFormOtherwise {formUuid, otherwise \| null}` and the tool list `set_form_otherwise` | 15 (behavior 11) |
| "### Form sections" | "Three soundness rules make a sectioned form a closed state (`FORM_SECTION_NOT_TOP_LEVEL`, …" | kept; adds "A repeat workers add entries to cannot sit inside a group shown on one screen either (`FIELD_LIST_USER_REPEAT`), since the form builder refuses it a count" (part 04 §8.2) | 15 (behavior 9) |
| "### Live counted repeats" | "A direct reference requires an integer question; other sources use an explicit numeric expression. … Query-bound membership remains a separate initialization snapshot." | part 04 §8.2's text | 15 (behavior 3) |
| "Ordinary extension-case creation also rides the source XForm." (its paragraph, through "`proof/native/` records the reproducible native import/build and navigation evidence.") | "Ordinary extension-case creation also rides the source XForm. HQ's basic `_create_casexml` ignores the relationship in an `OpenSubCaseAction`, … Nova retains the extension action with condition `never` …" | the paragraph rewritten as `lib/commcare/CLAUDE.md`'s "Case-management scaffolding emission" sentences (part 02 §25, §7.5 below), with the `proof/native/` sentence kept | 15 (behavior 7) |
| "### Advanced modules" (new, before "### After-submit links") | (none) | adds, with the binding facts of part 02 §2 cited (part 02 §25), "A menu is emitted as CommCare HQ's advanced module exactly when its kind is held or one of its forms holds a create that an after-submit link carries and that no basic placement gives a session datum, and no kind blocker holds (`lib/commcare/moduleKind.ts::emittedModuleKind`: a several-case list, forms that read the search, a case list in the menu whose list is narrowed, children linking to their parent under more than one name). Its forms' selections are the menu's parent chain, each load tagged `load_<case type><n>`, and an operation an advanced case action cannot express takes a Save to Case block. An extension child case is a create with an `extension` link: a Save to Case block in a basic form, or an advanced open action where a link carries it, whose owner Nova writes because HQ's build leaves it unowned. HQ's advanced rules are eligibility clauses (`lib/commcare/advancedPlacement.ts`), and the one rule with no fallback is `FORM_LINK_NEEDS_NEW_CASE_DATUM`." | 15 (behavior 7) |

### 7.5 lib/commcare/CLAUDE.md

| Section | Today | From step 5 | PR |
|---|---|---|---|
| the capability list | "Public surfaces speak only semantic capabilities from `lib/publish/projectSpaceCompatibility.ts`: Case search, CommCare Connect, attachments saved to cases, links to captured files, …" | "attachments saved to cases, " leaves (2); "Save only answers that changed" joins after "links to captured files" (4); "links between cases of the same type" joins (8). "a search-first menu that follows a parent case chosen first" becomes "a menu whose forms read the search and that follows a parent case chosen first" (10) | 2, 4, 8, 10 |
| "Ordinary datetime case writes" paragraph's neighbour, the Hidden Value ordering | "The same ordering is why the case preload below beats a `default_value` but never a `calculate` on a hidden writer." | "The same ordering is why a `calculate` on a hidden writer beats its default." (part 01 §23 item 6) | 4 |
| after `formEntrySyncReasons`' paragraph (new) | (none) | adds part 03 §19's `commtrackReasons` paragraph: "`planPrivileges.ts::commtrackReasons` names each advanced menu whose case list is its own menu item and each form whose source, decoded, holds the text `instance('commcaresession')/session/data/supply_point_id`: CommCare HQ adds a product step after a case is chosen from such a list and gates such a form to workers assigned a supply point while CommCare Supply is on, so publish asks a person to confirm it is off (`commtrack-off`)." and the probe paragraph's "A flag the app needs off (`DONT_INDEX_SAME_CASETYPE`) is read the same way, inverted." | 8 |
| `formEntrySyncReasons` paragraph | "`planPrivileges.ts::formEntrySyncReasons` names each form that works on a case in a module whose case list offers Search, …" | "names each form that requires a chosen case in a module whose case list offers Search, an advanced menu's follow-up and close forms included, …" (part 02 decision 15) | 7 |
| "`post_submit` defaults" | "(`lib/domain/forms.ts::defaultPostSubmit` takes the menu facts `searchFirst`, `multiSelect`, `parentMultiSelect` and `offTheMenu`;" and "`previous` in a menu that opens on Search" | "`formsReadSearch`, `multiSelect`, …" and "`previous` in a menu whose forms read the search" (part 05 §15) | 10 |
| same paragraph | "and one rule, `POST_SUBMIT_NOT_OFFERED`, refuses a stored destination outside `postSubmitDestinationsAdmitted`." | part 06 §15.1 item 4 | 11 |
| "Ordinary nested menus" | "A form-less `caseListOnly` root therefore admits only same-case-type children" | "A bare case list root (a case list menu item and no forms) therefore admits only same-case-type children" (part 05 §15) | 10 |
| "### After-submit links (`form_links`)", **Exclusive guards** | "Core executes EVERY true `<create>` and lands on the LAST one …" through "`formLinkParity.test.ts` pins local `<create if>` against HQ `form_links[i].xpath` on one document." | part 06 §15.1 item 1 (**Destinations and the otherwise**) | 11 |
| same, **HQ shape** and **Validator** | "`post_form_workflow_fallback` is the `postSubmit` workflow word when a guarded fallback frame exists, else `null`" and "`FORM_LINK_UNREACHABLE` (a link after an unconditional one), `FORM_LINK_NO_FALLBACK` …" | part 06 §15.1 items 2 and 3 | 11 |
| "Repeat modes", `count_bound` | "`jr:count` points directly at a bare integer question reference. A hidden-value reference or any other expression uses a sibling `nova_count_<repeatId>` hidden value with an `xsd:int` calculate." and "Direct decimal and text question counts are refused; use an integer question or explicit numeric conversion." | part 04 §8.1's pull request 3 text | 3 |
| same, `query_bound`; "Vellum dual-attribute pattern"; "Typed form expression emission" | "Vellum's model-iteration pattern. Data nests `<item>` below …"; "Query-repeat shadow behavior is unchanged."; "Query-repeat insertion bookkeeping counts `../item` from its wrapper attribute. …" | part 04 §8.1's pull request 3 texts | 3 |
| "### Markdown itext" | "All itext entries (labels, hints, option labels) emit both `<value>` and `<value form="markdown">`. Safe for plain text: identical rendering when no markdown syntax is present." | part 04 §8.1's pull request 9 text | 9 |
| "### Sections are data groups that are always field-lists" | "a LABELLED group carries the attribute as Nova's default and a transparent (no-label) group never does" | part 04 §8.1's pull request 9 text | 9 |
| "Case-management scaffolding emission", opening paragraph | "`subcaseWire.ts::hqCaseActions` therefore marks extension actions `never` while `xform/caseOps.ts` carries their active transactions in the source XForm, under a `nova_subcases` group at the exact parent/repeat scope. The retained action positions and types are necessary navigation metadata: …" | part 02 §25's text, word for word: "HQ's basic case builder ignores `OpenSubCaseAction.relationship`, so a basic child case is always `child`. An extension case is a case operation: a Save to Case block whose case id is `uuid()`, or an advanced open action where an after-submit link carries the new case, which makes its module advanced. A `nova_subcases` group is written only where a published Save to Case placement names it." | 7 |
| same, the **case-preload** bullet | "- **case-preload**: capture writers are excluded because …" | "- **case-preload**: Nova writes no `case_preload`; a preload is the question's default, `default_value` holding the read of the case's property, and it runs at the question's place (`lib/domain/casePreload.ts::fieldPreload`)." | 4 |
| same, the **subcases** bullet | "per-subcase session datum `case_id_new_<subcasetype>_<idx>` …" | kept; adds part 02 §25's sentence: "An advanced form's datums are `case_id_<tag>` per load and `case_id_new_<type>_<i>` per open action outside a repeat (`session.ts`)." | 7 |
| same, the **capture URL node** bullet | "a capture field's `caseWrite` carries `mode`, and `"url"` emits a SIBLING node …" | "a write whose value is `capture-link(#form/<question>)` emits a SIBLING node …" with the rest kept | 4 |
| same, the **capture attachment block** bullet | "- **capture attachment block**: `caseWrite.mode === "attachment"` names the original upload node in FormActions, …" | removed | 2 |
| "Authored case-operation emission" (its section) | the section | gains the paragraph "`placement.ts::planPlacements(doc, formUuid)` gives every operation and a form's own close its placement: a hold first, then the simplest placement that can express it, by the closed eligibility conditions of `placement.ts`. `casePlacementPlan.ts::planFormCaseWire` turns those placements into everything the wire needs (the basic or advanced form actions, the Save to Case blocks, their generated nodes, the entry's datums, the local blocks), so the action list, the datum list and the block paths cannot disagree. The own case's change is independent of every other operation's: no other operation writes, retypes or closes what the own arm writes, so the own arm means the same wherever its block runs." and loses its `closeConditionPlacement` sentences (part 01 §23 item 6); this row holds part 02 §25's change to the same section, that operations take the placement `planPlacements` gives them, emitted by `casePlacementPlan.ts` | 4 |
| "Advanced modules" (new section) | (none) | adds part 02 §25's section, the wire's facts of part 02 §3 to §18: `casePlacementPlan.ts` (one plan per form), `moduleKind.ts::emittedModuleKind` (held, or a carried create, and no blocker), the loads derived from the parent selection (`advancedSelections.ts`), HQ's key sets for `AdvancedModule` and `AdvancedForm` with the default product details, the tags `load_<case type><n>`, `open_<case type>_<n>`, `autoload_commcare_user<n>` (`advancedTags.ts`), the eligibility module, `nova_owner_<op>`, preloads as defaults, `advancedCaseBlocks.ts` and the source's local injection, the datums on both paths, the case list menu item (its sentence from 10) and the add-ons | 7 |
| "### Authored case-operation emission", the worker's record paragraph | "A form can save an answer into the worker's own record, and the emission is gated exactly as HQ gates it. `deriveCaseWriteInventory`'s `usercase` bucket populates `usercase_update` …" | "… `usercase_update` holds the writes of the form's one `worker-record` update; an advanced form loads the worker's record with an `autoload_commcare_user<n>` action, `mode: "usercase"`." | 4 (advanced half 7) |
| "### Search-first inline shape" and the search shape paragraph | "`caseSearchConfig.searchFirst: true` (`lib/domain/modules.ts::moduleOpensOnSearch`) lowers to HQ's inline search, …" | "### Forms that read the search": "`caseSearchConfig.formsReadSearch: true` (`lib/domain/modules.ts::moduleFormsReadSearch`) lowers to HQ's inline search, …"; the search shape paragraph becomes part 05 §15's ("`searchWireShape` is the authored workflow's spelling: `auto_launch` unless list first, `default_search` for skip to results, `inline_search` for forms that read the search") | 10 |
| the companion datum, the case list browse entry and every `caseListOnly` sentence (the `case_list.show` block, "Case-list-only child entries use the same projection.", the completeness rule) | "a `caseListOnly` …" | "a menu with its case list as a menu item (`caseListMenuItem`) …"; "Case list menu item entries use the same projection." (part 05 §15) | 10 |
| the no-matches sentences (`Form.entry = { kind: "search-no-matches" }`, "no-matches form") | "`Form.entry = { kind: "search-no-matches" }` (`lib/domain/forms.ts::isNoMatchesForm`)" | "`Module.caseListRegistrationForm` (`lib/domain/menuForms.ts::caseListRegistrationFormOf`)"; "no-matches form" becomes "registration from the case list" | 10 |

### 7.6 lib/domain/CLAUDE.md and lib/domain/expression/CLAUDE.md

| File, section | Today | From step 5 | PR |
|---|---|---|---|
| `lib/domain/CLAUDE.md`, "Question identity and case storage are separate." | "An eligible field saves case data only when it carries the complete explicit `caseWrite: { caseType, property }` pair; neither member is inferred from `id`. Editing `id` changes the question path only. Editing or clearing `caseWrite` retargets that one writer only." | "What a field saves is a write in its form's case operations whose value is its answer; `caseWriteViews.ts::fieldCaseWriteViews` is that field's view, and `lib/doc/fieldCaseWriteMutations.ts::planFieldCaseWrite` the one planner of it. Editing `id` changes the question path only. Retargeting a field's write changes that write only." with "App-wide property renames …" kept, and "naming a different type auto-derives child-case creation" becoming "a write to another type is a create or update operation of its own" | 4 |
| same, the inventory paragraph | "`caseWriteInventory.ts::deriveCaseWriteInventory` is the one form-tree walk that assigns those writers to case actions. …" | removed; replaced by "`lib/commcare/placement.ts::planPlacements` decides where each operation is kept on the wire; `placements.ts` holds the placement shapes, which a publish records as holds." | 4 |
| same, "Fields are a registry", the capture sentences | "Those five extend the ordinary destination with `captureCaseWriteSchema`, whose required `mode` names what reaches the case: …" through "… would point back at the capture question." | "A capture reaches a case only as the `capture-link` term, its file's address, never as an attachment; neither `case_name` nor `external_id` takes one." | 2 (the mode), 4 (the term) |
| same paragraph | "One that writes a case property writes it blank on each submission unless the form preloads that property into it, and every authoring surface says so where the author sets it, in the one sentence `casePreload.ts::hiddenWriterBlankNote` gives." | "One that writes a case property with no value writes it blank on each submission unless its default reads the case, and every authoring surface says so where the author sets it, in the one sentence `casePreload.ts::hiddenWriterBlankNote` gives." | 4 |
| same paragraph, after "is always `appearance="field-list"` on the wire" | (none) | part 04 §8.1's pull request 9 sentence ("A group shows on one screen on Android only when it holds `fieldList`; …") and its pull request 5 sentence on a query repeat's `placement` | 5, 9 |
| "Four form types" | "`registration` creates a case, `followup` updates one, `close` loads + closes (a superset of followup), `survey` opens no primary case; it may still update declared worker properties." | "**Four form types** (`forms.ts`), each its own case's lifecycle: `registration` creates it, under an open condition, and may close the case it creates, under a close condition; `followup` updates one; `close` loads, updates and closes one, under a close condition; `survey` has no own case. The own case's writes are the form's `own` case operation, first in `caseOperations`; every other case's create, update and close is a case operation, and the worker's record is an update's target." | 4 |
| same paragraph, `casePreload.ts` | "`casePreload.ts` is the ONE statement of which answers a form seeds from the case it opened: `formOpensWithOneCase(formType, cardinality)` and `writerPreloadsFromLoadedCase(field, module, form)` (…). The builder's inspector, … through the case-write inventory (`lib/commcare/deriveCaseConfig.ts`)." | "A preload is a default value: a field opens with a case's value when its `default_value` is exactly a read of that case's property (`casePreload.ts::fieldPreload`), which the planners write when a writer of the form's own case is born on a one-case loading form (`writerOffersPreload`) and which an author edits or removes like any default. It runs at the question's place in the form's load, like every default." | 4 |
| same paragraph, the menu shape and `entry` | "read from its module's shape (Search first, several-case selection, …)"; "A form's optional `entry` (`{ kind: "search-no-matches", label? }`) says how it is reached: …"; "`menuForms.ts` holds the readers … (`menuFormUuidsOf`, `noMatchesFormOf`, …)"; "`translationUnits.ts` carries the `form-entry-label` role (source `entry.label ?? form.name`)." | part 05 §15's pull request 10 texts (forms that read the search; `caseListRegistrationForm` and `caseListMenuItem`; `caseListRegistrationFormOf`; `case-list-registration-label` and `case-list-menu-item-label`) | 10 |
| same paragraph | "`postSubmitDestinationsAdmitted` waives the two several-case conditions for a form with links, whose `postSubmit` is the fallback;" | part 06 §15.1 item 5 | 11 |
| same paragraph, `closeCondition.ts` | "`closeCondition.ts::closeConditionPlacement` derives where a close is written, `form-action` or `save-to-case`, and stores nothing: placement is derived on every read and is not yet a property an author holds." | "Where the own case's close is written is the own close's placement (`lib/commcare/placement.ts::planPlacements`), held once published in `Form.ownClosePlacement` where it cannot share the own arm's place." | 4 |
| "Forms and modules", `Form.formLinks` and `formLinkGraph.ts` | "`Form.formLinks` is the form's ordered list of after-submit links, each an ENTITY: …" and "`formLinkGraph.ts` is the reachability reader (…) shared by the cycle rule and every surface that must refuse a self-link or a cycle before it is authored;" | part 06 §15.1 item 5 | 11 |
| same section, `searchFirst` on the module | "`searchFirst: true` on the ordinary arm (`moduleOpensOnSearch`) opens the module on its Search screen with no browse list; the validator admits it only on a case-first or forms-free case list, and it is the one module fact `defaultPostSubmit` reads." | part 05 §15's pull request 10 text | 10 |
| same section (new sentence) | (none) | adds, as part 02 §25 lists it, "Whether a menu is emitted advanced is `lib/commcare/moduleKind.ts::emittedModuleKind(doc, moduleUuid)`, and `Module.heldKind` holds the kind a publish carried; `advancedKindBlockers` names what keeps a menu basic, `heldKindExpresses` whether a held kind can still express its menu, and `advancedChainIndex` the index name of each load in the menu's parent chain." | 7 |
| `lib/domain/expression/CLAUDE.md`, "Non-obvious arm facts" | (none) | adds part 04 §8.1's sentence (a repeat count's expectation is a whole number) | 3 |
| same file (new) | (none) | adds "`capture-link {field}` is the HQ address of the file a capture question submitted, admitted only as the whole value of a case write (`arm-unavailable` reasons `capture-link-slot` and `capture-link-field`); a bare read of a capture as a write value is `expected-value` reason `capture-answer`." | 4 |
| same file, the search reads | "A form of a module that opens on its search reads that module's Search fields (`FormExpressionFacts.searchFirstModule`) …, and any other form, a child module's of a search-first parent included, as reason `not-search-first`." | "A form of a menu whose forms read the search reads that menu's Search fields (`FormExpressionFacts.formsReadSearchModule`) in its questions and Connect settings; a form link's slots refuse the read as `search-answer-unavailable` reason `form-link` (it runs after the form closes), and any other form, a child menu's of such a parent included, as reason `not-forms-read-search`." (part 05 §6.3) | 10 |

### 7.7 lib/doc/CLAUDE.md, lib/db/CLAUDE.md, lib/collab/CLAUDE.md

| File, section | Today | From step 5 | PR |
|---|---|---|---|
| `lib/doc/CLAUDE.md`, the case-operation bullets | (the bullets on `caseOperationMutations.ts`, `caseWriteChoices.ts`) | gain the own arm, write keys with `via`, `planFieldCaseWrite`, `planFormTypeChange` (part 01 §23 item 7) | 4 |
| same, `kindConversionCascade.ts` | "converts every peer FIELD writer DERIVING the explicit `caseWrite` property's current type" | "converts every peer FIELD writer DERIVING the written property's current type (each write in the field's view)" | 4 |
| same, the mutations paragraph | (none) | adds part 03 §19's `holdPlacements` sentence, and the bullets `placementMoves.ts` (`HELD_PLACEMENT_INEXPRESSIBLE`'s moves), `queryRepeatPlacement.ts` (part 04 §8.1) and `identityMoves.ts` (part 07 §7.1) | 5 |
| same, the planner list (new bullet) | (none) | adds "- `moduleKindMoves.ts`: the moves of a menu's held advanced kind and of its chain's load names, composed by `withIdentityMoves` first." (part 02 §25, part 07 decision 1) | 7 |
| same, `formSectionVerdicts.ts` | "Four section refusals" | "Five refusals", adding "an add-entries repeat under a group shown on one screen" (part 04 §8.1) | 9 |
| same, `scaffolds.ts` | "A case-list module is born as a VIEWER — a `caseListOnly` module …" | "A case-list module is born as a viewer, with the case list in its menu (`caseListMenuItem`), a `Name` column …" (part 07 §7.1) | 10 |
| same, `platformNotes.ts` | "(`platformFeaturesOf`, over one use-detector run per document snapshot, and `readsSearchFieldInSearchFirstForm`)" | "… and `readsSearchFieldInFormsReadSearchForm`)" | 10 |
| same, `searchNoMatchesDependents.ts` / `searchNoMatchesForm.ts` | "`searchNoMatchesDependents.ts` / `searchNoMatchesForm.ts` — the no-matches registration form's planners. …" | "`searchReadDependents.ts` / `caseListRegistrationForm.ts`: the planners of the menu's registration from the case list and of what reads its Search answers. …", and a bullet for `searchWorkflowPlan.ts` (`authoredSearchWorkflow`, the planner that writes `skipToResults` where an input change leaves a search with nothing visible) | 10 |
| same, `reconcilePostSubmitWithMenuShape` | "`updateModule` (Search first, the module's `hiddenFromMenu`, a whole `caseListConfig`)" | "`updateModule` (forms that read the search, …)" (10); the paragraph adds the otherwise and drops "and `removeFormLink` the form whose last link left" (11) | 10, 11 |
| same, `formLinkMutations.ts` and `formLinkReview.ts` | "`afterSubmitPlan`, the ONE reader of what runs when nothing matched …" | part 06 §15.1 item 7 | 11 |
| `lib/db/CLAUDE.md`, the kind set | "Its closed kind set is `autosave`, `mcp`, `chat`, `blueprint-migration`, `fold-baseline`, and `project-move`. The first four carry …" and "The browser collaboration wire accepts only `autosave \| mcp \| chat`;" | part 03 §19's pull request 6 texts | 6 |
| same, the kernel rule (new sentence) | (none) | part 03 §19's pull request 5 text (`placementChangeRefusal`, its two editor arms and `placementRecords.ts::readRecordedPlacementHolds`) | 5 |
| same, the deployment ledger | "`app_deployment_confirmations` (what a person confirmed about one project space for one app: a plan feature, the flat location fixture, a Connect forwarder, sync on form entry turned off)" | "… sync on form entry turned off, CommCare Supply turned off)" | 8 |
| same, the fold identities | "accepts exactly five identities — … and the paired `fold-baseline:hq-round-trip-expressions` / `system:hq-round-trip-expressions` operator cutover, each of the last two starting each app from the document its transform yields." | "accepts exactly six identities: … the paired `fold-baseline:hq-round-trip-expressions` / `system:hq-round-trip-expressions` operator cutover, and the paired `fold-baseline:hq-round-trip-case-writes` / `system:hq-round-trip-case-writes` operator cutover, each of the last three starting each app from the document its transform yields."; and after the `hq-round-trip-platforms` paragraph: "The `hq-round-trip-case-writes` horizon takes the `hq-round-trip-expressions` horizon's route: a field's case write (with a capture's attachment mode), a form's no-matches entry, a module's case-list flag and Search first are keys the head schema no longer holds, and a form's structured close condition is a shape it no longer parses, so no earlier document parses and no earlier mutation that carries one replays; each app starts from its `fold-baseline:hq-round-trip-case-writes` row." | 14 |
| `lib/db/types.ts`, the comment on the kinds | "The final durable app-change vocabulary. Browser reconciliation accepts only the first three kinds; the remaining kinds are server-only state" | "The final durable app-change vocabulary. Browser tabs fold the first four kinds as frames; the remaining kinds are server-only state" | 6 |
| `lib/collab/CLAUDE.md`, the read snapshot | (its paragraph) | gains part 03 §19's pull request 5 sentence (`recordedHolds`, kept beside `confirmedDoc` and handed to the store for undo and redo) | 5 |
| `lib/collab/CLAUDE.md`, the frame | "The client frame admits exactly `autosave \| mcp \| chat`;" | part 03 §19's pull request 6 text | 6 |
| same, the 409 bullet | (the 409 `commit_rejected` bullet) | adds part 03 §19's sentence and part 07 §7.1's (the one rejected batch offered again in `IdentityMoveDialog` when every refused code is an identity code) | 6 |

### 7.8 lib/deployment/CLAUDE.md, lib/export/CLAUDE.md, lib/case-store/CLAUDE.md

| File, section | Today | From step 5 | PR |
|---|---|---|---|
| `lib/deployment/CLAUDE.md`, "One publish lifecycle" | (its paragraph) | gains part 03 §19's pull request 6 sentence and a new section "Placements" stating part 03 §5, §7 and §11 in present tense | 6 |
| same, the confirmations | "Confirmations live in `app_deployment_confirmations`, four kinds (`plan-feature`, `flat-location-fixture`, `connect-forwarder`, `form-entry-sync-off`)" | part 03 §19's pull request 8 text (five kinds, `commtrack-off`), and the `plan-features` paragraph's list gains CommCare Supply turned off | 8 |
| same, "Baselines" | (the baseline paragraph) | adds "A published deployment whose baseline Nova could not read keeps the placement Nova's emission gave each case change and query repeat when step 5's cutover ran, held, so a later publish moves no published path (`placements-kept-unread`); a query repeat whose rule gives the count placement is the one exception, and takes it. A deployment whose live app mapping is marked remote-missing counts as published, since CommCare HQ's submissions keep their `xmlns`." (decision 5, R13, R14) | 14 |
| `lib/export/CLAUDE.md`, the nested selection check | "The check follows actual selection datums, including case-list-only entries and catalog ancestor chains;" | "The check follows actual selection datums, including case list menu item entries, advanced loads, and catalog ancestor chains;" | 10 |
| same, the downloads (new sentence) | (none) | adds "A download records nothing: the HQ import file and the `.ccz` emit each case change's effective placement, held or else the simplest, and write no `publish-placement` change." (part 03 §13) | 6 |
| `lib/case-store/CLAUDE.md`, the advanced parent selection (new sentences) | (none) | adds part 02 §25's sentences: `SelectedParentCases.index`, the named index an advanced chain's list step reads, and the entry-minted id sentence (part 02 §20) | 7 |
| `lib/case-store/CLAUDE.md`, the submission | "`CaseStore.applySubmission` applies one whole form submission — the ordinary form action (registration primary+children, followup update+children, close including final writes) plus the advanced case-operation program — in ONE transaction …" | "`CaseStore.applySubmission` applies one whole form submission, its case operations in array order with the own case's change first, in ONE transaction …" (part 01 §19) | 4 |
| same, the claim | "**A claim seeds it too.** `RestoreScope.claimedCaseIds` carries the worker's claims, …" through "… holds the rule over HQ's graphs with a claim added." | part 05 §15's pull request 10 text ("**A claim is a row.** …") and the `readDeviceCaseDatabase` sentence removed | 10 |
| same, extension edges (new sentence) | (none) | adds "An extension child case is an operation's create with an `extension` link, persisted as `extension` like every authored relationship; Preview's restore scope gives it to its host's owner where the open action leaves it unowned." | 7 |

### 7.9 lib/preview/CLAUDE.md, lib/preview/app-tests/CLAUDE.md, lib/session/CLAUDE.md, lib/routing/CLAUDE.md

| File, section | Today | From step 5 | PR |
|---|---|---|---|
| `lib/preview/CLAUDE.md`, the case list step (new sentence) | (none) | adds part 02 §25's sentence: an advanced chain's list step is constrained through its named index | 7 |
| `lib/preview/CLAUDE.md`, the datetime paragraph | "Ordinary followup preloads still override defaults, including when the stored property is blank." | removed (part 01 §23 item 8) | 4 |
| same, "Initialization actions run in authored scope and order." | "Defaults and query snapshots run in document order; primary case preloads are appended last." | "Defaults and query snapshots run in document order; a preload is a default and runs in its place." (4), and part 04 §8.1's pull request 3 sentences (3) | 3, 4 |
| same, the ordinary writer and operation sentence | "When an ordinary field writer and a case operation both target `external_id`, the ordinary form action runs last and wins, matching the emitted CommCare transaction." | "Two operations never both write `external_id` of one case: the own case's change and every other operation of the form are independent, so the order they run in does not decide a value." | 4 |
| same, "End-of-form links" | "**First true wins, evaluated as the device's XPath after the write.** …" and "**A blank carried value binds nothing, visibly.** …" | part 06 §15.1 item 8 (its §11.8) | 11 |
| same, the claims sentences | "Preview writes no claim row." and the claims paragraph of "Resolved preview identity" | part 05 §15's pull request 10 text | 10 |
| same, the group screens and markdown | "screen per labeled group (a field-list, as Nova emits it)", "pages one screen per labeled group", "outside a labeled group", the label rendering section | part 04 §8.1's pull request 9 texts | 9 |
| `lib/preview/app-tests/CLAUDE.md`, the claims | "A claim appends to the session's `AppTestSessionState.claimedCaseIds`" and "A form of a search-first module that reads what the search found" | part 05 §15's pull request 10 texts | 10 |
| same, the runtime version | "Version 16 fences the expression model: …" and step 4's version 17 sentence | kept; adds "Version 18 fences repeats and case writes: a journey started before it pinned a document whose query repeats, counts and case operations the current runtime reads differently." | 3 |
| `lib/session/CLAUDE.md`, claims | "`previewClaims` holds the running worker's claims (`previewClaims.ts`, pure reducers): …" and the "keeps the claims" sentences | removed (part 05 §15) | 10 |
| same, the after-submit stack (new) | (none) | adds part 06 §15.1 item 9 (`previewAfterSubmitStack` and its lifetime) | 11 |
| same, the identity move (new) | (none) | adds "`pendingIdentityMove` holds the one batch `IdentityMoveDialog` states, until the person makes the change or cancels; it is never stored." | 5 |
| `lib/routing/CLAUDE.md`, the trail | "For a `caseListOnly` module that has neither forms nor child menus, …" | part 07 §7.1's text | 10 |

### 7.10 components/builder/CLAUDE.md and the agent's directories

`components/builder/CLAUDE.md`, `lib/agent/CLAUDE.md`, `lib/agent/authoring/CLAUDE.md`,
`lib/agent/workspace/CLAUDE.md`, `lib/agent/change-set/CLAUDE.md` and
`components/builder/editor/fieldEditorSchemas.ts`'s comment: part 07 §7.1's table, each row in the pull
request its column gives (2, 3, 4, 5, 6, 10, 11, 12), word for word. Two rows of other parts join it in
`components/builder/CLAUDE.md`: part 05 §15's pull request 10 sentences ("born with a case list menu
entry and no form"; "adding a form keeps its case list entry beside the form"; the formless Preview
sentence) and part 06 §15.1 item 10 (After submit, with part 07 §3.11's copy) in 11. Where part 07's row
and part 05's name one sentence (the viewer scaffold), part 07's text is the replacement and part 05's
second clause ("adding a form keeps its case list entry beside the form") is appended to it. The
bullet heading "**Case data owns app-wide property identity; “Saves to” owns one field binding.**"
becomes "**Case data owns app-wide property identity; “Saves to” shows a field's writes.**" in 4.

### 7.11 Files with no step 5 change

- `components/CLAUDE.md`: no convention changes. Every new control is a `components/shadcn`
  composition, the disabled-with-reason rule and the voice already hold, and no sentence there names a
  case write, a search workflow or a link.
- `lib/codemirror/CLAUDE.md`: "No offer-then-reject" holds as written; `expressionEditorContext.ts`
  reads `moduleFormsReadSearch` (10) with no contract sentence changing.
- `lib/lookup/CLAUDE.md`: unchanged (§7.1).
- `lib/media/CLAUDE.md`, `lib/case-store/sql/CLAUDE.md`, `lib/commcare/xpath/wire/CLAUDE.md`: read; no
  sentence step 5 makes false.
- `design/`: no change. Step 5 adds no visual primitive and no token; `IdentityMoveDialog`, the menu
  settings sections and the Rows editor are compositions of existing primitives in Nova's voice.

## 8. Public docs that change

Every sentence follows `design/readme.md`, "Content fundamentals": it invites, takes responsibility,
offers the next step, and uses no em dash; a control's name is bold and in the builder's words (part 07
§3). Each paragraph has one owner, and the text a part writes word for word is cited rather than
restated. Public docs land in pull request 15 but for one recorded exception: the notice's two
passages land in pull request 14, because a notice row names what changed from the moment the cutover
commits. Step 5's `stated` rows of `lib/preview/__tests__/platformCells.ts` name a feature's note
(`stated("plain-text")`, part 04 §4.7), and the one row kind that reads a docs heading, `statedInDocs`,
reads `building-with-nova.mdx#preview-on-web-apps-and-android`, which step 5 keeps; so no other page has
to land early, and a part that adds a row reading a heading the stack adds moves that page's section
into its own pull request. No sentence names a private HQ flag (§3).

| Page | What changes | Text | PR |
|---|---|---|---|
| `case-changes.mdx`, "Forms that open an existing case" | "every question that saves to that case starts out showing the value the case already holds … Because the case supplies the opening value, Nova does not offer a starting value on those questions; the properties pane says so on the question instead." | part 07 §7.2's text ("When a question saves to the case the form opened, Nova gives it a starting value that reads that case's value, …") | 15 |
| `case-changes.mdx`, the follow-up paragraph | "If the link's case value is empty, Android can't save the form, and if it names no case, CommCare HQ creates one." | "A form link that carries a case runs only when the worker's device holds a case of that type with the value it carries, so a value that names no case never opens the form; the next destination, or the form's **Otherwise**, runs instead." Under part 06's G2 outcome B: "A form link carries a case of the type its destination opens, such as the case this form opened or created." | 15 |
| `case-changes.mdx`, the close paragraph | "A close form can close its case only when one answer matches. …" through "… which needs Save to Case in the project space's plan on CommCare HQ." | part 07 §7.2's new section "This form's case", in its place | 15 |
| `case-changes.mdx`, "Add a change" | "The last two are only offered when the module picks a case before opening its forms." | kept; the list gains **Update the worker's record** and the section adds "This form's case is always the first change and goes with the form's type." (part 07 §7.2) | 15 |
| `case-changes.mdx`, new section "Where CommCare HQ keeps each change" | (none) | part 07 §7.2's text; under part 01's G5 outcome B (the Case Management save clears `update_mode: edit`), its last sentence reads "Saving to a case above works only in Case Management or case actions." and **Save only if changed** is not offered | 15 |
| `case-changes.mdx`, new section "When a form's link opens the case it creates" | (none) | part 02 §25's paragraph: "When a form's link opens the case the form creates, CommCare HQ needs that menu to be an advanced menu, and Nova publishes it as one. Once published, it stays advanced while it can be. A menu that lists several cases at once, whose forms read the search, whose case list in the menu is narrowed, or whose cases link to their parent under more than one name can't be advanced, and Nova says so where you set the link." | 15 |
| `case-changes.mdx`, "Ask Nova or an MCP agent" | "Case changes are also part of Nova's shared authoring tools." | kept; adds part 07 §7.2's sentence on reported moves | 15 |
| `attachments.mdx`, "## Saving the file itself" | "**The file itself** is the other answer under **What reaches the case**, and …" (the section) | removed; the page's case-write paragraph says "A capture reaches a case as a link to its file." and the "Links to captured files" paragraph stays | 15 |
| `attachments.mdx`, "## Saving a link to the file", the access bullet | "Nova checks that capability before a direct publish of an app whose case list or case details show the link, since that is where a worker opens it; a link no list shows asks for nothing." | "Nova checks that capability before a direct publish of an app that shows the link in a case list, its details or a form, since that is where a worker opens it; a link nothing shows asks for nothing." (part 03 §10) | 15 |
| `publishing.mdx`, the data dictionary paragraph | "A property that receives **The file itself** can be missing there." | removed | 15 |
| `publishing.mdx`, "What the project space's plan includes" | "Three project-space settings are asked about the same way, …" with its three bullets | part 03 §19's text: "Four project-space settings …" and the bullet **CommCare Supply turned off**. Under part 03's supply-text run, outcome B: "or a form whose source names the session's supply point in an attribute"; outcome C: the form clause is dropped | 15 |
| `publishing.mdx`, new subsection "Where CommCare HQ keeps your case changes" | (none) | part 03 §19's text | 15 |
| `publishing.mdx`, "Updates to review" | "When Nova changes how it stores, checks or writes apps, or where they run, an app it changed shows an update to review in the builder's header." | "When Nova changes how it stores, checks or writes apps, where they run, or where workers go after a form, an app it changed shows an update to review in the builder's header." | 14 |
| `project-space-compatibility.mdx`, "Plan features" | "Three project-space settings are asked about the same way: the flat location list, a Connect forwarder, and Sync Cases On Form Entry turned off." | "Four project-space settings are asked about the same way: the flat location list, a Connect forwarder, Sync Cases On Form Entry turned off, and CommCare Supply turned off." | 15 |
| `project-space-compatibility.mdx`, the close sentence | "A close condition that CommCare HQ's Case Management tab can't show is saved as a Save to Case close, so that app needs Save to Case." | "A case change that CommCare HQ's Case Management tab can't hold, such as a close condition it can't show, is kept in a Save to Case block, so that app needs Save to Case. Once published, Nova offers to move the changes that don't need it if a project space's plan lacks Save to Case." | 15 |
| `project-space-compatibility.mdx`, the capability catalog | rendered by `components/docs/ProjectSpaceCapabilityCatalog.tsx` from the records | no prose edit: the records lose "Attachments saved to cases" (2) and gain "Save only answers that changed" (4) and "Links between cases of the same type" (8), each with the copy its part writes; under part 08's G4 outcome C they also gain the `APP_BUILDER_ADVANCED` capability's record (7) | 2, 4, 8; 7 under G4's C |
| `building-with-nova.mdx`, the repeat paragraph | "A repeating section can let workers add entries, follow a count from an integer question or formula, …" through "… or when the enclosing entry is created for a nested section." | part 04 §8.3's first text, which states the count placement's rows as part 04 builds them (a row keeps its answers at its position, R10), with part 07 §7.2's addition "A count is a whole number, and Nova offers to wrap any other in int()."; part 07's Rows editor and guide use part 04's sentence for a row, so the page and the builder say one thing | 15 |
| `building-with-nova.mdx`, "Edit wording and formatting" | (none) | part 04 §8.3's **Format text** sentence | 15 |
| `building-with-nova.mdx`, the groups text | (none) | part 07 §7.2's **Show on one screen** sentence | 15 |
| `building-with-nova.mdx`, the Preview paragraph | "or one labeled group or question at a time when it has no sections" | part 04 §8.3's texts ("one group shown on one screen, or one question, at a time"; the plain-label difference). Under part 08's G5 outcome B, the difference reads "a label without formatting still shows its formatting on Android" | 15 |
| `building-with-nova.mdx`, the claims sentence | "app again from its first screen and keeps the cases the worker claimed." | kept; adds part 05 §15's sentence ("Claims last until you release them from the Running as menu, …") | 15 |
| `building-with-nova.mdx`, the hidden value paragraph | "A hidden value with no expression that saves to a case property says under it what happens: it carries the case's current value through unchanged where the form opens that case, and saves the property blank otherwise." | "A hidden value with no expression that saves to the case the form opened starts with that case's value, a starting value Nova gives it and you can remove, so it carries the value through unchanged; anywhere else it saves the property blank, and the line under it says so." | 15 |
| `form-sections.mdx`, the device rules | "Two more rules come from the device. …" | kept; adds part 07 §7.2's "The same holds inside a group shown on one screen." | 15 |
| `form-sections.mdx`, the record-query paragraph | "A record-query repeat outside another repeat captures its record selection when the form opens. … Nested record-query repeats select their records when their enclosing row is created, so they can use answers from an earlier page." | part 04 §8.3's `form-sections.mdx` text | 15 |
| `form-links.mdx` | "## The order matters", the Otherwise section, "## What Nova refuses", the carry values section, "## On a device" | part 06 §15.2's texts, in part 07 §3.11's words; under part 06's G1 outcome B or C and G2 or G3 outcome B, the variants part 07's "Written and not yet run" gives | 15 |
| `case-workspace.mdx`, "### Search first" | "Turn on **Search first** in the Search panel and the module opens on its Search screen instead of Results. …" | "### When this menu opens": "A menu that searches can open on **Search first**, the Search screen; **Results first**, the matches of its search as it opens; or **Case list first**, its case list, offered only in an app that runs on Android only, because CommCare HQ no longer offers it for a menu that searches in Web Apps. Android opens a menu that searches on its case list whichever you choose. Under **Search first** or **Results first**, **Forms read the search** runs the search again as each of the menu's forms opens, so the form reads what was searched for and found; Web Apps runs it, and an app that also runs on Android can't use it." with each choice's disabled line as the builder words it (part 07 §3.8) | 15 |
| `case-workspace.mdx`, "### Register when nothing matches" | "Give a registration form in that module the entry **After a search finds no matches** (in Nova's tools, `entry: search-no-matches`), …" and "**Open after a search finds no matches** in the same place." | the same section with the menu setting's words (part 07 §3.9) and "in Nova's tools, `case_list_registration` on the form"; "Search first" becomes **Forms read the search** where the section names the setting | 15 |
| `case-workspace.mdx`, new section "### The case list in the menu" | (none) | "**Show the case list in this menu** lists the menu's case list as an entry of its own, beside its forms or as the menu's only entry. Choosing a case there shows its details." followed by decision 6's outcome sentence: A, "In Web Apps the app then returns to its first screen."; B, "In Web Apps the case list shows again."; C, "In Web Apps the list then shows no cases." (part 05's G1) | 15 |
| `where-workers-use-your-app.mdx`, "What each choice offers", the Web Apps list | "- **Search first**, a menu that opens on its Search screen, and the registration form it offers when a search finds nothing. On Android a worker can open only a case the phone already holds." | "- **Forms read the search**, where each form of a menu runs the search again as it opens, and the registration form such a menu offers when a search finds nothing. On Android a worker can open only a case the phone already holds." | 15 |
| same page, the Android list | (none) | adds "- **Case list first**, for a menu that searches. In Web Apps a menu that searches opens on its Search screen or on its results." | 15 |
| same page, the differences paragraph | "Other features run on both and behave a little differently on each, such as a location question, …" | kept; adds "A menu set to **Search first** or **Results first** opens on its case list on Android." and, under part 06's G1 outcome A, "After a form, Android runs every destination that applies, in order, and Web Apps opens only the first." | 15 |
| `nested-menus.mdx` | (none) | part 06 §15.2's sentence | 15 |
| `deep-links.mdx` | "a registration form shown only when Search has no matches cannot be a link destination." | read; stays true (part 05: a menu's registration from its case list is offered only after a search finds nothing) | none |
| `mcp/tools.mdx`, the case-write section | the `caseWrite` `mode` example and "`mode` is required on those five kinds" | "A field's `caseWrite` names one write to `{caseType, property}`; `get_field` returns `caseWrites`, every write whose value is the field's answer. `capture-link(#form/<question>)` saves a capture's file as a link." with `via`, `onlyIfChanged` and the `worker-record` target on the case change rows (part 07 §4.2) | 15 |
| `mcp/tools.mdx`, the case change rows | `add_case_operations`, `update_case_operation`, `get_case_operations`, `remove_case_operation`, `move_case_operation` | part 07 §4.2's descriptions: the own arm first and fixed, `via`, `onlyIfChanged`, the `worker-record` target, `placement` on reads | 15 |
| `mcp/tools.mdx`, the form and module rows | `create_form`, `update_form` (`open_condition`, `close_condition` as form logic, `case_list_registration`), `create_module`, `update_module` (`case_list_menu_item`), `configure_case_list` and `set_case_search_advanced` (`searchWorkflow`, `formsReadSearch`) | part 07 §4.2's descriptions | 15 |
| `mcp/tools.mdx`, the field rows | `add_fields`, `edit_field` (`field_list`, `plain_label`, `repeat_count` as a whole number) | part 07 §4.2 and part 04 §8.4 | 15 |
| `mcp/tools.mdx`, the after-submit paragraph and the link rows | "they are checked in order after the form closes and the first true condition is followed. …" | part 06 §15.2's text and a `set_form_otherwise` row | 15 |
| `mcp/tools.mdx`, every mutating row | (none) | "A result lists `identityMoves`, each move a change makes in where CommCare HQ keeps published answers, and `save_work` repeats them." | 15 |
| `mcp/tools.mdx`, `upload_app_to_hq`, `withdraw_deployment_confirmation` and the plan paragraph | the confirmations and refusals | part 03 §19's text (`accept_placement_moves`, `confirm_commtrack_off`, `placement_moves`, `app_changed_while_publishing`, `hq_placement_moves_changed`) | 15 |
| `mcp/tools.mdx`, the `get_app` row | "or where they run" | "where they run, or where workers go after a form" | 14 |

Pages read that need no change: `index.mdx`, `projects.mdx`, `languages.mdx`, `case-choices.mdx`,
`project-data.mdx`, `organization.mdx`, `automations.mdx`, `display-conditions.mdx`,
`cross-facility-referrals.mdx`, `commcare-connect.mdx`, `users-and-personas.mdx`, `deep-links.mdx`, and
every page under `claude-code/` and `mcp/` but `tools.mdx`. `content/docs/meta.json` gains no page.

## 9. The proof lane's documents, the research and the plans README

**`proof/README.md`**, each change in the pull request that makes the old text false, as part 08 §9.1
writes it: "Identity moves", "A, B and B-edit", "Configurations", "The run started by hand" (1); each
defect's row in "The defect rows" in the pull request that moves its entries (2, 3, 4, 7, 9, 10, 11), and
row 12 a reproduced row (8); "Targeted documents" with each pull request's documents (1, 3, 4, 5, 7, 8,
9, 10, 11); "The corpus" ("Platforms", the fuzz mapping) (3, extended in 4, 9, 10); "Native proofs" (3, 7,
11); "Walk stops" (10, by part 08's G2); "Known defects" (11); the tables that count documents, controls
and groups, and "Timings and what the lane is expected to take" (15, from part 08's G7).

**`proof/CLAUDE.md`**: the witness bullet (1) and "The register is strict"'s sentence (11), as part 08
§9.2 writes them.

**`docs/research/2026-09-26-hq-round-trip/harness-findings.md`**, "Found while planning step 5" (a new
section after "Found while planning step 4", written in this plan's own pull request, as step 4's was in
#803):
part 08 §9.3's items; part 01's claims corrected and its Nova defects; part 03's finding N1 (the
`VIEW_FORM_ATTACHMENT` check missing a relation's link column); part 04's findings; part 05's C1 to C3
and its Nova defect; part 06's claim 1 under its G1 outcome A, or its withdrawal under outcome B; part
09's three (the `publish-placement` kind is a trigger change, not a CHECK; step 4's test image read a
constraint and columns by name; HQ's `previous` refusal lives in
`helpers/validators.py::FormBaseValidator.validate_for_module`); and this part's, listed under "Executed during planning" below. A bullet that names a gated run
is completed with the run's outcome in the pull request that holds the run; no other bullet moves.

**The inventory** (`docs/research/2026-09-26-hq-round-trip/inventory/*.md`): every row an entry edit
moves, in the entry's pull request (2, 3, 4, 7, 8, 9, 10, 11); the Counts table stays the research's.

**`docs/plans/hq-round-trip/README.md`**:

- This plan's own pull request, beneath the stack: the steps table's step 5 row reads "planned in
  full"; the pins sentence names step 5's plan beside steps 2 to 4; "Nova since the research" gains a
  "Step 5's plan reads `main` at `2f985ed6`. After `e9e6cd93`:" list (#803; #805 and #802; #809 to
  #825 with what step 5 builds on), and its closing paragraph gains "After `e9e6cd93`, #809 to #825 are
  step 4, which fixed the second half of defect 11, defects 18 and 19, defect 20's sync on form entry
  and finding 74; no other pull request in that span changed a defect's behavior."
- Pull request 15: the sentence "The register's other entries are defects 21, 23 to 28 and 30, which
  `OPEN_DEFECTS` gives to step 5." becomes "Step 5 fixed the register's other entries, defects 21, 23 to
  28 and 30 (["Step 5 is done"](#step-5-is-done))."
- Pull request 16: the steps table's step 5 row reads "done: ["Step 5 is done"](#step-5-is-done)"; "Step
  4 is done"'s "What step 4 left to later steps" names "Step 5 is done" for what step 5 took of it
  (CommTrack's confirmation and defect 21), its link to `5-case-writes-forms-navigation.md` pointing
  there; "Step 3 is done"'s list of where its deferrals went drops the step 5 plan's link in favor of
  "Step 5 is done"; and a new section "Step 5 is done" after "Step 4 is done":

> Step 5 made a form's case writes one concept with a place in CommCare HQ that a publish keeps, and
> its plan has left this directory. A form's case writes are its case operations, the form's own case
> among them, and a field's "Saves to" is that field's view of them; each case change, query repeat
> and advanced menu keeps the place in CommCare HQ the publish that first carries it records, and an
> edit that moves one says so on every editor before it saves. It fixed defects 21 to 30 (the search
> workflow; case writes as one concept; attachment mode; extension child cases; query repeat placement;
> form links; field lists; explicit preloads and plain labels; the menu concepts; whole-number counts),
> defect 12's links between cases of the same type at publish, and defect 20's CommTrack half. What
> endures lives where it is read:
>
> - **Case writes and placements**, `lib/domain` and `lib/commcare`: the own arm, `via`,
>   `onlyIfChanged`, the worker's record, `capture-link`, open and close conditions
>   (`lib/domain/CLAUDE.md`); `lib/commcare/placement.ts::planPlacements` and
>   `casePlacementPlan.ts::planFormCaseWire` (`lib/commcare/CLAUDE.md`, "Authored case-operation
>   emission"); `docs/architecture/complex-apps.md`, "Field id, case writes, and app-wide property
>   rename".
> - **Held placements and identity moves**, `lib/doc`: `holdPlacements`, `withIdentityMoves` and the
>   per-subject planners (`lib/doc/CLAUDE.md`), the kernel rule
>   `lib/db/placementAuthority.ts::placementChangeRefusal` (`lib/db/CLAUDE.md`), and the contract in
>   `docs/architecture/contracts.md`, "HQ deployment safety".
> - **Publish**, `lib/deployment`: the `publish-placement` app change, the placement offers,
>   `commtrack-off`, `same-type-child-links` and `lib/commcare/hq/publishedCaseBlocks.ts`
>   (`lib/deployment/CLAUDE.md`, "Placements").
> - **Advanced modules and extension child cases** (`lib/commcare/CLAUDE.md`, "Advanced modules";
>   `docs/architecture/complex-apps.md`, "Advanced modules").
> - **Questions**: query repeat placements, whole-number counts, `group.fieldList` and `plainLabel`
>   (`lib/commcare/CLAUDE.md`, "Repeat modes" and "Markdown itext").
> - **Menus and search**: `caseSearchConfig.workflow` and `formsReadSearch`,
>   `Module.caseListMenuItem` and `Module.caseListRegistrationForm`, and a claim as a case row
>   (`lib/domain/CLAUDE.md`, `lib/case-store/CLAUDE.md`, `docs/architecture/complex-apps.md`, "The
>   search workflow").
> - **Form links**: destinations in the author's order, `Form.otherwise`, `this-form` and the held-case
>   guard (`lib/commcare/CLAUDE.md`, "After-submit links"; `docs/architecture/complex-apps.md`).
> - **The proof lane**: every one of the register's entries in `proof/fixed-defects.json`, each still
>   showing on its retained control, `OPEN_DEFECTS` empty; the migration witnesses, their retained A
>   (`proof/migrations/`), HQ's reads of it (`proof/hq-reads/targeted-migration-*`) and the identity
>   moves scoped to them (`proof/README.md`, "Identity moves").
> - **What planning step 5 found**,
>   [`harness-findings.md`](../../research/2026-09-26-hq-round-trip/harness-findings.md), "Found while
>   planning step 5".
> - **What step 5 left to later steps**, each with its reason, in [`6-import.md`](6-import.md) and
>   [`7-rest-of-model.md`](7-rest-of-model.md).
> - **The baseline step 5's plan was written against**: `main` at `2f985ed6`, which is step 4's stack
>   (#809 to #825) merged and its cutover run, at the CommCare pins named under "Rules every plan
>   follows".
> - **The cutover's trace.** The cutover ran once, before the merge, and its scripts, its Job and its
>   runbook are removed; they stay in `main`'s history on the commit before the one that removed them.
>   What it left is the three ledgered migrations of step 5 with `caseWritesLedger.postgres.test.ts`
>   (`lib/case-store/migrations/`); each app's `fold-baseline:hq-round-trip-case-writes` row, the sixth
>   fold identity (`lib/db/CLAUDE.md`); the pure planners the fuzz mapping and step 6 read
>   (`lib/doc/fieldWriteOperations.ts`, `explicitPreloads.ts`, `repeatCountWraps.ts`, `groupFieldLists.ts`,
>   `searchWorkflowPlan.ts`); the form-link map `lib/doc/formLinkSemanticsMap.ts`, with the test that
>   holds every migrated app's links to their behavior before; each affected app's notice, cutover
>   `hq-round-trip-case-writes`, whose lead and reasons stay so stored rows render (`lib/notices/`); the
>   two public-docs sentences that name where workers go after a form as something Nova changed
>   (`content/docs/publishing.mdx`, "Updates to review", and the `get_app` row of
>   `content/docs/mcp/tools.mdx`); and its content-free evidence archive under the prefix
>   `hq-round-trip-case-writes/`, reports and IAM policy reads only, never deleted from
>   (`docs/architecture/deployment.md`, "Historical repairs").

The trace's reason list is the one part 09 registers, `form-link-removed` among them: part 06 §14.4 keeps
that removal for a link to an unoffered submenu whose parent is off the menu, which an author can still
make before the window and the dry run counts; production holds none today, so the reason ships whether
or not an app's notice names it, and stays so stored rows render.

## 10. The nova-plugin check

`../nova-plugin`, read-only for planning at `105836d` (`version` `2.3.0`), was swept by part 07 §6 by
claim, for every claim step 5 changes: search first, no matches, case list only, `caseWrite`, saves
to, attachment, preload, first true, otherwise, form link, field list, markdown, counts, queries, Save
to Case, close condition, registration, advanced, CommTrack, supply point, placement, the `confirm_`
keys, `save_work` and `begin_work`. The build, edit and autobuild skills and the autonomous agent send
the model to `get_agent_prompt` and `get_authoring_guide`, which Nova serves and which change with the
deploy. Every sentence step 5 makes false or incomplete is in `skills/upload_to_hq/SKILL.md` and the
README, and part 07 §6 lists the nine edits, `plugin.json` among them (`2.3.0` makes `2.4.0`: it teaches
new arguments and refusals).

The rule for the stack:

1. Pull request 13, which ships the last model-facing text, opens the plugin's pull request against
   the tool text it ships and runs the sweep again at the plugin's head then, by claim and never by
   part 07's list of files (G3 below).
2. The fix is one pull request in `../nova-plugin`, with `.claude-plugin/plugin.json` going from whatever
   it holds then to the next minor version (`2.3.0` makes `2.4.0`). It merges only after the Nova deploy
   carrying the stack is live (house rule 10 confirms it; part 07's G-A2).
3. Pull request 15 records that pull request's link and the repeated sweep's result in its description
   and in `docs/plans/hq-round-trip/README.md`'s "Step 5 is done" draft, which pull request 16 writes.
4. Part 03's supply-text, probe and flag-effect runs reach only the plugin's text, as part 07 §6
   writes each outcome.

## 11. The exit

Step 5 is done when every row below holds, each checked by a machine after the merge, from `main`, the
first nightly and production's read-only evidence; none needs a person's judgment, and none needs a
third run of anything.

| # | What holds | The check |
|---|---|---|
| 1 | **The registers are empty of live entries.** `proof/known-defects.json` is `[]`; `proof/fixed-defects.json` holds 1,017 entries (and any a run of part 08 §2.6 added, each on the control it retained); `OPEN_DEFECTS` is `{}`; every fixed entry shows on its control and on no document | `python3 -I -c "import json; assert json.load(open('proof/known-defects.json')) == []; print(len(json.load(open('proof/fixed-defects.json'))))"` at `main`; `proof/checks/test_registers.py` (`test_every_live_defect_is_a_later_steps` with `step > 5`) in `main`'s pull request lane; the register gate of the first nightly with every reader |
| 2 | **Proofs 1 to 5 pass on every Nova export, including a republish after each migration.** Every document of the corpus, the eight migration witnesses among them, passes the bar, the intent and manifest checks, configuration sensitivity and proofs 1 to 5, and proof 1 accepts each identity move only on the witnesses `proof/identity-moves.json` scopes it to | the lane on the merge commit (`gh run list --workflow ci.yml --branch main --limit 1`), and the first nightly with every reader (`gh run list --workflow proof-audit.yml --limit 1` green, or each group its issue names fixed and rerun alone by `python3 -m proof.lane.report`'s command until it is) |
| 3 | **The corpus and its lists are as planned.** 431 documents (430 under part 02's G4 outcome B), 108 controls, 25 walk stops or as part 08's G2 left them, eight directories under `proof/migrations/` | `proof/checks/test_corpus.py` (the census, the witness and identity-move tests) in the lane |
| 4 | **A held placement holds.** Emission of a document equals emission with its derived placements held; no payload but `holdPlacements` writes a held slot; the kernel refuses an editor's hold of a placement that can still express its target | `lib/commcare/__tests__/heldPlacementEmission.test.ts`, `lib/doc/__tests__/placementSlotsWrittenOnlyByHolds.test.ts`, `lib/db/__tests__/publishPlacementCommit.postgres.test.ts` in `main`'s CI |
| 5 | **Every platform difference step 5 adds is a row with its evidence.** | `lib/commcare/surface/__tests__/platformFeatures.test.ts`, `lib/preview/__tests__/platformCells.test.ts`, `lib/doc/__tests__/platformOfferParity.test.ts` in `main`'s CI |
| 6 | **Every existing app migrated and has its notice.** The cutover committed; every app, deleted ones included, has exactly one `fold-baseline:hq-round-trip-case-writes` row; `kysely_migration` holds the three step 5 migrations; every app with planned entries has exactly one notice row for `hq-round-trip-case-writes`; the deploy's runtime probe found nothing; the case-schema drift the dry run counted was written and none remains | the execute report and the post-migration dry run's `already-applied` line, archived under `gs://commcare-nova-cutover-evidence/hq-round-trip-case-writes/`; the deploy's `migrate` and `deploy` check-runs at `SUCCESS` on the merge commit (listed with `gh api …/check-runs` first); `scripts/scan-schema-drift.ts --prod` reports no drift |
| 7 | **The served contract is checked.** `MODEL_CONTEXT_VERSION` is `"v6-hq-round-trip-case-writes.13"`, `RUNTIME_VERSION` 18, `scripts/test-schema.ts` holds 61 entries; the billed check passed for every tool it named, or each refused schema was fixed and checked again; every served schema compiles; no public surface names a private HQ flag | `rg -n 'MODEL_CONTEXT_VERSION = "v6-hq-round-trip-case-writes.13"' lib/models.ts`, `rg -n 'RUNTIME_VERSION = 18' lib/db/appTests.ts`, the count of `SCHEMA_TESTS`; pull request 13's description recording the billed run's results; `lib/mcp/__tests__/servedSchemas.test.ts` and `lib/commcare/__tests__/projectSpaceCompatibilityBoundary.test.ts` in `main`'s CI |
| 8 | **The plan has left and its deferrals are written.** No file names this plan or its runbook; `docs/plans/hq-round-trip/` holds `README.md`, `6-import.md` and `7-rest-of-model.md`; the README reads step 5 done; no cutover tool, Job contract or allowlist arm remains; the `../nova-plugin` pull request is merged | `git ls-files docs/plans/hq-round-trip`; `git grep -l -E '5-case-writes-forms-navigation\|5-cutover-runbook\|hqRoundTripCaseWrites\|hq-round-trip-case-writes\.cjs' -- . ':!docs/research'` returns nothing (in the shell the pattern's bars are bare); `rg -n 'commcare-nova-hq-round-trip-case-writes' config scripts` returns nothing; `gh pr view <plugin pull request> --repo <nova-plugin repository> --json state` reads `MERGED` |

## Tests

This part adds no product code, so its tests are the checks its pull requests and its exit run; each
earns its boundary as `docs/testing.md` asks (the production contract, a plausible failure, the
observation that tells them apart). The feature tests are the owning parts'.

| Test or check | PR | Boundary and the failure it catches |
|---|---|---|
| `lib/commcare/__tests__/projectSpaceCompatibilityBoundary.test.ts`, unchanged | 4, 8, 15 | the public surfaces' files on disk against `HQ_PRIVATE_FEATURE_FLAG_SYMBOLS`: a docs sentence or a component naming `SAVE_ONLY_EDITED_FORM_FIELDS` or `DONT_INDEX_SAME_CASETYPE` once 4 and 8 add them to the probe |
| the production build (`npm run build`), which builds the docs pages through fumadocs | 15 | the real docs build: a page that fails to compile or a heading an MDX link names that 15 renamed |
| `proof/checks/test_registers.py::test_every_live_defect_is_a_later_steps`, with part 08 §2.4's `step > 5` | 11 | the real register: a step 5 entry left live, or a later registration given to step 5 |
| `scripts/infra/tests/test_deployment_policy.py` and `scripts/infra/__tests__/containerArtifacts.test.ts`, without the tool's rows | 16 | the deployment policy and the image contract as `main` holds them: an allowlist arm or a bundle line left behind that would let a stored execution run removed tooling |
| `lib/case-store/migrations/__tests__/caseWritesLedger.postgres.test.ts`, kept | 14, 16 | each of the three migrations from its prefix on real Postgres, after the tooling leaves: a later migration that breaks the sixth identity or the kinds |
| the hash run (`scripts/inspect-tool-schema-hashes.ts`) at each pull request's base and head | every | the served tool definitions as the provider receives them: a schema moved by a pull request that neither registers it nor moves `MODEL_CONTEXT_VERSION` |

Copy is not tested (`lib/agent/CLAUDE.md`: "Do not pin prose"); the contract and docs sentences are
held by G1 and G2 below, which read the files.

## Executed during planning

For this part: read-only. No file of the repository or of `../nova-plugin` was changed but this one,
and no Docker, lane, test suite, build or billed call ran.

1. **The counts at `main` `2f985ed6`**, by a `python3 -I` read of the JSON registers
   (`proof/known-defects.json` 271, `proof/fixed-defects.json` 746, `proof/walk-stops.json` 25,
   `proof/identity-moves.json` `[]`), `ls proof/controls | wc -l` (108), `proof/checks/registers.py::OPEN_DEFECTS`,
   `lib/models.ts::MODEL_CONTEXT_VERSION` (`"v5-hq-round-trip-platforms.12"`),
   `lib/db/appTests.ts::RUNTIME_VERSION` (17), and `scripts/test-schema.ts`' entries (55, names read);
   `../nova-plugin` at `105836d`, `plugin.json` `2.3.0`; the last migration at `main`,
   `20261101030000_hq_round_trip_platforms_media_format_validated`, so step 5's stamps sort after it.
2. **Every "Today" quote** was read in its file at `main` with `rg`, `sed` and `awk`, its section
   heading read above it: the root `CLAUDE.md`, `docs/architecture/contracts.md`, `complex-apps.md`,
   `lib/commcare/CLAUDE.md`, `lib/domain/CLAUDE.md`, `lib/domain/expression/CLAUDE.md`,
   `lib/doc/CLAUDE.md`, `lib/db/CLAUDE.md`, `lib/db/types.ts`, `lib/collab/CLAUDE.md`,
   `lib/deployment/CLAUDE.md`, `lib/export/CLAUDE.md`, `lib/case-store/CLAUDE.md`, `lib/preview/CLAUDE.md`,
   `lib/preview/app-tests/CLAUDE.md`, `lib/session/CLAUDE.md`, `lib/routing/CLAUDE.md`,
   `components/builder/CLAUDE.md`, and the public pages of §8. The terms a rewrite could make false
   were searched across every `CLAUDE.md`, `docs/architecture/` and `content/docs/`: `caseWrite`,
   `preload`, `searchFirst`, Search first, no-matches, `caseListOnly`, case-list-only, claim, "first
   true", "initial snapshot", attachment, `nova_subcases`, `__nova_`, otherwise, the kind set.
3. **The research's contracts table** (`docs/research/2026-09-26-hq-round-trip/README.md`, "Contracts
   this work changes") read whole, and each step 5 row matched to its sentence at `main` (§7.1).
4. **Anchored links into the pages step 5 renames sections of**, by `rg` over `content`, `components`,
   `lib` and `app`: one (`case-changes.mdx` to `case-workspace#let-people-work-with-several-cases-at-once`),
   whose heading step 5 keeps.
5. **The tests that read public docs**, by `rg -l content/docs` over the test files:
   `projectSpaceCompatibilityBoundary.test.ts` and `lib/preview/__tests__/platformCells.ts` (one
   anchor, `building-with-nova.mdx#preview-on-web-apps-and-android`, which step 5 keeps).
6. **The parts' sections** this part reconciles: every part's "Files by pull request", its contracts
   section and "What other parts read from this one", and the nine briefs' "Files touched", contracts
   and cross-area sections, reconciled against the second decisions (R1 to R20).
7. **The production scan's findings**, read in words from the planning scan part 09 ran with the
   person's yes (content-free, read-only), folded into §1, house rule 9 and §9 as R20 asks; no count,
   client datum or app identity enters this part.

**Claims corrected and Nova defects found while planning this part**, for
`harness-findings.md`, "Found while planning step 5":

- The research's contracts row on the `__nova_operations` container ("Step 2 renames every such node
  but the repeat-count snapshots, which step 5 removes") is already true at `main`: `lib/commcare/CLAUDE.md`'s
  `count_bound` says "No count setvalues or count snapshots remain", and the count helper is
  `nova_count_<repeatId>`. Step 5's half of the row is defect 30's direct `jr:count`.
- The research quotes "a reserved `__nova_subcases` container"; `main` says "a `nova_subcases` group"
  (step 2's rename).
- The research's table names the `publish-placement` fact in four files; `main` states it in two more,
  `lib/collab/CLAUDE.md` and the comment on the kinds in `lib/db/types.ts` (§7.1).
- The research quotes the form types sentence as "`survey` touches no case"; `main` says "`survey`
  opens no primary case; it may still update declared worker properties".
- `content/docs/case-changes.mdx` documents defect 26's symptom as product behavior ("if it names no
  case, CommCare HQ creates one"); no lane check reads docs, so it is recorded and rewritten (§8).

## Written and not yet run

Every run here is on GitHub's runners or a free local read, never a heavy run on the person's machine,
and none bills.

**G1. The contract sweep at pull request 15's head.** `git grep -n -E` over every `CLAUDE.md`,
`docs/architecture/`, `content/docs/` and `design/` for the names step 5 retires: `caseListOnly`,
`searchFirst`, `moduleOpensOnSearch`, `search-no-matches`, `isNoMatchesForm`, `noMatchesFormOf`,
`NoMatchesFormSetting`, `formEntry`, `caseWriteInventory`, `deriveCaseWriteInventory`,
`closeConditionPlacement`, `writerPreloadsFromLoadedCase`, `captureCaseWriteSchema`,
`PreloadedValueRow`, `CloseConditionSection`, `planFormLinkGuards`, `FORM_LINK_UNREACHABLE`,
`FORM_LINK_NO_FALLBACK`, `postSubmitDestinationsAdmitted`, `formLinkGraph`, `subcaseWire`,
`hqCaseActions`, `previewClaims`, `claimedCaseIds`, `formlessCaseListRoute`, `MM_CASE_PROPERTIES`
outside `lib/commcare`, and the phrases "first true", "initial snapshot", "Attachments saved to cases".

- *Outcome A, no hit outside `docs/research/`:* pull request 15 is complete as §7 and §8 write it.
- *Outcome B, a hit in a subtree `CLAUDE.md` or in `lib/db/types.ts`:* the sentence went false in the
  pull request whose behavior changed it; the replacement is written there as a fix-up (house rule 4),
  in the voice of §7's rows, and the restack rides the session's one push.
- *Outcome C, a hit in `docs/architecture/` or `content/docs/`:* the sentence is rewritten in pull
  request 15, in the voice of §8, and added to §8's table in the pull request's description.

**G2. The docs build and its links at pull request 15's head.** The pull request's own CI build.

- *Outcome A, the build passes:* the pages ship as written.
- *Outcome B, a page fails to compile or a link names a heading that no longer exists:* the page or the
  link is fixed in pull request 15; a heading another page links to keeps its old anchor through an
  explicit `{#id}` only where the page's own sentence still reads true under the old name, otherwise
  the link is re-pointed.

**G3. The `../nova-plugin` re-sweep at pull request 13's head.** `rg -i` over `skills`, `agents` and
`README.md` of the plugin at its head then, for every claim part 07 §6 lists, against the guide and
tool text pull request 13 ships.

- *Outcome A, no claim beyond part 07 §6's nine edits:* the plugin pull request carries those nine,
  version `2.4.0`, and pull request 15 records its link and "no further claim".
- *Outcome B, another sentence step 5 makes false:* its edit joins the same plugin pull request before
  it merges (still `2.4.0`, since it ships once), and pull request 15 records the added edit with the
  link.
- *Outcome C, the plugin's head moved past `2.3.0`:* the version goes to the next minor of whatever it
  holds, and the sweep runs over the new head as in A or B.

**G4. The exit, after the merge and the first nightly** (§11's checks).

- *Outcome A, every row holds:* step 5 is done; nothing else is written.
- *Outcome B, a lane or register row fails* (rows 1 to 5): the failing group is read from the
  nightly's issue or the CI run, fixed in an ordinary pull request with its own `/code-review medium`
  at the failing slice, and the row's check repeats; a served class showing on a document after its
  fix is part 08's G2 outcome B, landed by part 08 §2.6.
- *Outcome C, a production row fails* (row 6): the merge's deploy has run, so only forward. Drift the
  dry run did not count is written by the existing drift writer from `main` through
  `commcare-nova-case-type-schema-retirement`, and `scan-schema-drift.ts --prod` runs again. A missing
  notice or fold row is a defect of the transform, which the execute report names by app; it is written
  by a one-off scan and migrate pair over exactly those apps, run once locally and then on production
  through its own fenced Job from a maintenance image, and removed with its Job, bundle line and
  allowlist arm in the pull request after the run, as the repository's one-off repairs are.
- *Outcome D, the served contract or the removal fails* (rows 7, 8): fixed in an ordinary pull request;
  the plugin pull request waits until row 7 holds.

**Gated runs other parts own whose outcomes change rows here.** Each owner's part writes every outcome
in full; the rows of this part that move with it:

| Run (owner) | Outcome that changes this part | Rows here that change |
|---|---|---|
| G1 of part 08, the witnesses' retained A | B: a placement class has no read holding its block | §1 row 14's cutover column gains cause `placement-simplified` under `form-data-paths-move` for that class |
| G2 of part 08, served entries by hand | C: a stop added or rewritten in 10 | §1's totals (walk stops), §11 row 3 |
| G3 of part 08, the expander's defect 21 entry | B: it stays live in 10 | §1 rows 10 and 11's register cells and `OPEN_DEFECTS`, as written there |
| G4 of part 08, the advanced gate effects | B or C | §1 row 7's contents (default product details, or `APP_BUILDER_ADVANCED`'s effects); under C, row 7 also gains the `APP_BUILDER_ADVANCED` capability, probed at publish, and its catalog record, and §8's capability catalog row gains that record |
| G1 of part 03 (part 08's G4) | B or C | §1 row 7's or 10's contents (the product column's spelling), or §1 row 8's `COMMTRACK_OFF.consequence` first clause where no spelling holds; under C, §1 row 8's or 10's `commtrackReasons` widened with its witness document |
| G5 of part 08, Android and plain labels | B | §8's `building-with-nova.mdx` Preview row, as written there |
| G6 of part 08, identity moves | B or C | the notice's deployment lines (part 09) and §9's trace, by the moves written |
| G7 of part 08, CI cost | B or C | `proof/README.md`'s timing numbers (15); under C, §1 row 15's lane cell and `proof/README.md`'s timing rows read 13 shards with the measured end, and house rule 4's per-push numbers are restated from part 08 §8.3 |
| Decision 6's run (part 05's G1) | A, B or C; or an error or a stopped walk | §8's `case-workspace.mdx` "The case list in the menu" sentence; under the error outcome, the `where-workers-use-your-app.mdx` lists gain the refusal's bullet in part 05's words |
| G3 and G4 of part 05 | B | §8's `case-workspace.mdx` workflow paragraph drops a withdrawn choice, or gains "The search runs as the menu opens, since there's nothing to fill in."; under G3's B, `6-import.md` item 10's Search and menus line |
| G1 of part 06, several destinations | B or C | §8's `where-workers-use-your-app.mdx` differences row loses its after-submit sentence; `form-links.mdx` and `mcp/tools.mdx` take part 07's variants |
| G2 and G3 of part 06 | B | §8's `case-changes.mdx` link sentence (G2's variant, as written there); `form-links.mdx` loses a withdrawn shape; under G2's B, `6-import.md` item 10's Form links line |
| G2, G3 and G4 of part 03 | B or C | §8's `publishing.mdx` CommCare Supply bullet; under G3's B a sixth kind `same-type-links-kept` makes §7.8's "five kinds" read "six kinds" and §6's checklist gains that kind; under G4's B the capability, its catalog record and its offer leave §1 row 8 and §8; under G3's or G4's B, `6-import.md` item 10's Confirmations line and item 9's confirmations line |
| G5 of part 01, the Case Management save | B | §8's `case-changes.mdx` placement section, as written there; §6's checklist drops `onlyIfChanged`'s capability; §1 rows 4, 12 and 13 lose the capability, the switch and the input, and part 08 §5.1's document loses its `onlyIfChanged` write |
| G6 of part 02, the advanced open action's owner | B | §7.4's "Advanced modules" sentence "whose owner Nova writes because HQ's build leaves it unowned" becomes "which CommCare HQ leaves unowned, so it syncs to whoever holds the case it extends" |
| part 09's bundle, duration and heap-order runs | B | §2's pull request 14 file list (`Dockerfile`'s `COPY` lines), and house rule 9's image check |
| G-A1 of part 07, the billed check | B | house rule 7's question is asked again for the one refused schema; §11 row 7 waits on it |
| G-A2 of part 07, the plugin merge | B | §10 rule 2: the plugin pull request stays open until the repaired deploy is live |

## Files by pull request

This part's own files are pull request 15's and part of 16's; §2 lists every pull request's files,
this part's included.

- **This plan's own pull request**, beneath the stack: `docs/plans/hq-round-trip/5-case-writes-forms-navigation.md`
  (the outline replaced by the plan), `docs/plans/hq-round-trip/5-case-writes-forms-navigation/` (the
  ten parts), `docs/plans/hq-round-trip/6-import.md` and `7-rest-of-model.md` (the deferral notes the
  parts write "for the outlines"), `docs/plans/hq-round-trip/README.md` (§9's first bullet).
- **Pull request 15**: `docs/architecture/contracts.md`, `docs/architecture/complex-apps.md`; the
  `content/docs` pages of §8 marked 15; `proof/README.md` (the count tables, the timings), `proof/timings.json`;
  `docs/plans/hq-round-trip/README.md` (§9's second bullet).
- **Pull request 16**: `docs/plans/hq-round-trip/README.md` ("Step 5 is done" and §9's third bullet's
  link edits), `docs/plans/hq-round-trip/6-import.md`, `7-rest-of-model.md` (their citations of this
  plan), and the deletions of §2's pull request 16 list.

## Departures

| From | This part | Reason |
|---|---|---|
| Part 05's first draft (its decision 14 and §19): pull request 10 beneath pull request 7, renumbered by this part | the decisions' order kept, 7 and 8 beneath 10 (R1), which part 05 now follows | renumbering moves every part's numbers for no gain: pull request 7 emits advanced modules with no case list menu item beside their forms, 8 reads a menu item wherever a module holds one and holds its advanced arm with a Vitest witness, and 10, the first pull request where a module holds a menu item beside its forms, brings the advanced menu item, its flip and `targeted-commtrack-advanced` (§4) |
| Part 03's first ordering guard, "the case list menu item of an advanced module … first emitted in pull request 8" | first emitted in 10, with `targeted-commtrack-advanced` (part 08 §5.1, R1) | no document can hold the item beside an advanced module's forms before 10; 8 writes `commtrackReasons`' menu item arm over a reader that answers only a formless module until 10 |
| The case-writes brief and part 01's first draft: the operation's and own close's held slots, held-first `planPlacements` and the allocator's held paths in pull request 5 | in pull request 4, each slot with the concept it holds (R2); `holdPlacements`, the held rules and the moves stay in 5 | part 08 §5.2: the case-writes witness's B must keep A's placements in 4, or proof 1 shows moves no migration decides |
| This part's first draft: the query repeat's held slot in pull request 5 | in pull request 3 with the query placement (R2, part 04 §12, part 08 §5.2); its writer `holdPlacements` in 5 | a slot lands with the stored concept it holds; the query-repeats witness's spec writes its holds in 3, and nothing but a spec writes one until 5 |
| Every brief listing a public page in a feature pull request | public docs and the two architecture files in 15, but the notice's two passages in 14 | one deploy carries the stack, so a page between two heads reaches no reader; landing them together lets one pass of G1 and G2 hold them, as step 4 did |
| The authoring brief's `deep-links.mdx` rewrite | no change | part 05: the sentence stays true of a menu's registration from its case list |
| The authoring brief's repeat sentence ("each row keeps its answers with its case") | part 04 §8.3's text, which part 07 now uses too (R10) | part 04 owns the count placement and keeps a row's answers at its position (part 04, Departures); no part runs a row-identity check |
| The cutover brief's "skeleton pull request" | pull request 1, with part 08's lane mechanics; its capture test is deleted in 2, and the fixtures stay under `fixtures.digest.test.ts` until 16 (R17) | part 08 places the pre-step fixtures with the witnesses they are; 2 is the first pull request whose shapes `main`'s gate refuses, and the digest test keeps a fixture from drifting once the code that admitted it is gone |
| §2's pull request 3 list | pull request 3 also changes `lib/doc/types.ts` (`addField`'s payload refuses a key of `HELD_FIELD_KEYS`), `lib/domain/referenceSlots.ts` (`placement` classified `config`), `lib/preview/engine/types.ts` and `formPresentation.ts` (a query repeat's row relevance), `lib/preview/app-tests/CLAUDE.md` (the version 18 sentence §7.9 marks 3), `lib/commcare/xpath/wire/__tests__/instantFixture.ts` (the form-node projection's surface), `lib/commcare/__tests__/suiteDocArbitrary.ts` (the fuzz mapping), `proof/targeted/build.ts` (a spec's held placement laid on after the gate), `proof/native/producers/emit-container-evidence.ts`, `emit-expression-evidence.ts` (the native classes' inputs), `lib/agent/authoring/fieldBehavior.ts` and `output.ts` (a query repeat's `rows` in the one field read projection, where §2 names `lib/agent/tools/getField.ts`), and four tests that pinned a query snapshot reading an answer (`repeatContext.test.ts`, `evaluateForm.test.ts`, `journey.postgres.test.ts`, `e2e/tests/browser/preview-form-lifecycle-audit.spec.ts`) | each is the file the owning part's change reaches at the base; the reasons are part 04's and part 08's Departures |
| Part 08's first draft: in pull request 1, `emitCorpus.ts` applies the capture's empty placement record to D | in pull request 1 `capturePublish` returns `placements: []` and nothing applies it; pull request 6 moves the first publish's capture ahead of edit planning in `emitCorpus.ts` and `entryWriter.ts` and applies the record there (part 08 §1.3, §4.5) | at `main` the corpus plans D′ before the first publish's capture runs, so a record applied in pull request 1 would reach no edit; the move belongs with the kind that fills the record |
| Part 09's runbook check, "`git diff --stat <15>..<16> -- lib app` names only `lib/db/designSessions.ts`" | the same check with tests excluded (`':(exclude,glob)**/__tests__/**'`) | pull request 16 also edits `lib/db/__tests__/runHolderWriteGuard.test.ts`, removing the cutover writer's allowlist entry; the check's purpose is that the gate that migrated is the gate the deploy runs, which a test file does not change |
| §1 row 4: "no wire byte moves on a migrated document but targeted-load-time-values" | the corpus comparison of pull request 4 follows part 01 §18: a case-loading form that preloads changes its HQ JSON and its XForm, because `case_preload` leaves the JSON and each preload becomes the question's default setvalue at its place (`lib/commcare/formActions.ts::buildFormActions` writes no `case_preload`; `lib/domain/casePreload.ts::fieldPreload`) | the row reads only case blocks, update rows and Save to Case blocks; the preload's move is defect 28's fix, which part 01 §18 and part 08 name, so every other byte is the row's claim and the preloading forms' exports are the stated exception |
| §2's pull request 4 list | pull request 4 also adds `SAVE_ONLY_EDITED_FORM_FIELDS` to `proof/hq/test_flag_probe.py::PROBED_FLAGS` | the list mirrors `lib/commcare/projectSpaceCompatibility.ts`'s private flag symbols (`HQ_PRIVATE_FEATURE_FLAG_SYMBOLS`, which gains `save-only-edited-answers`; part 08's pull request 2 departure), and HQ's flag is domain-namespaced (`corehq/toggles/__init__.py::SAVE_ONLY_EDITED_FORM_FIELDS`, a `FeatureRelease` with `namespaces=[NAMESPACE_DOMAIN]`), so the probe reads it like the others |
| §2's pull request 4 list | further readers of the replaced concepts change under §2's importer rule: `lib/doc/{store,searchBlueprint,searchNoMatchesForm,formRecordName,identifierVerdicts,projectBuilderLanguageMutations,casePropertyRenameImpact}.ts`, `lib/doc/mutations/{index,referenceRewrites}.ts`, `lib/domain/{workerRecordRequirements,entryDatumSupplies,caseScalarTextGuard,standardCaseProperties,fieldValueType,fields/group,expression/formStructure}.ts`, `lib/commcare/{previousTaskProjection,index}.ts`, `lib/commcare/validator/rules/{app,fieldKindMatchesPropertyType,case-list/columnReferences}.ts`, `lib/preview/{unheldCaseSubmit,engine/engineController,engine/captureSubmissionValidation}.ts`, `lib/case-store/sql/dataTypeTokens.ts`, `lib/db/syncUsercaseRow.ts`, `components/preview/screens/FormScreen.tsx`, `components/builder/case-list-config/CaseListConfigWorkspace.tsx`, `lib/agent/{blueprintHelpers,contentProcessing,planningSchemas}.ts`, `lib/agent/authoring/{formPreparation,output}.ts`, `lib/agent/tools/{evaluateForm,shared/fieldAssembly}.ts`, `scripts/lib/blueprint-stats.ts`, `proof/checks/{intent,test_intent,test_proof3_behavior}.py` and `proof/native/producers/emit-expression-evidence.ts` | each read `Field.caseWrite`, `fieldCaseWrite`, `deriveCaseWriteInventory`, `closeConditionPlacement`, `declareCaseTypeForField` or the ordinary submission action, which pull request 4 deletes, so it changes with them |
| §7.5's capture URL node row: "a write whose value is `capture-link(#form/<question>)` emits a SIBLING node …, with the rest kept" | the bullet says the sibling is emitted for such a write in a basic slot, and adds that a Save to Case row has no sibling and calculates the same address over the capture | `lib/commcare/xform/captureUrlNode.ts`'s header: the builder emits the node where a basic action names it, and a Save to Case row's calculate is the address built where the row reads the capture (`xform/caseOps.ts`) |
| §7.6's `closeCondition.ts` row: "held once published in `Form.ownClosePlacement` …" | "`Form.ownClosePlacement` holds the block a published app keeps it in where it cannot share the own arm's place (no mutation payload carries a held placement)", followed by part 01 §23 item 5's stateable condition (`lib/commcare/placement.ts::statedCondition`: one question compared with one value) | no publish records a hold at pull request 4 (`holdPlacements` lands in 5, the publish recorder in 6), so "once published" would describe a later head; the slot and its reader are what pull request 4 holds (`lib/domain/placements.ts`'s header) |
| §7.7's case-operation row: "the bullets on `caseOperationMutations.ts`, `caseWriteChoices.ts`" | the `caseOperationMutations.ts` bullet gains the own arm (`own-first`, `own-case`); `caseWriteChoices.ts` is named in a new `fieldCaseWriteMutations.ts` bullet beside new bullets for `formTypeMutations.ts`, `fieldWriteOperations.ts` / `explicitPreloads.ts` and `casePlacements.ts`; write keys with `via` land in the merge-unit bullet (`caseWriteKeys.ts::caseWriteKeyId`) | `lib/doc/CLAUDE.md` held no `caseWriteChoices.ts` bullet at the base; the scaffolds bullet's `declareCaseTypeForField` chokepoint becomes `scaffolds.ts::catalogMutationsForOperations`, and two sentences false at the base leave with it: the per-surface field-birth test (`lib/doc/__tests__/multiplayerMerge.test.ts` holds none) and `expressionText.ts::resolveCloseFieldRef` (no such export) |
| §7.9's ordinary writer row: "Two operations never both write `external_id` of one case: the own case's change and every other operation of the form are independent, so the order they run in does not decide a value." | "No other operation writes the `external_id` the own arm writes: the own case's change and every other operation of the form are independent, so where HQ runs the own arm's block does not decide a value." | the validator refuses a write that duplicates the own arm's (`lib/commcare/validator/rules/caseOperations.ts::ownCaseIndependenceFindings`, `CASE_WRITE_DUPLICATE_PROPERTY` reason `own-case`); two other updates of one case may both write `external_id`, and they run in array order on the wire and in the envelope alike |
| §7.5, §7.8 and §7.9 name the rows they rewrite | pull request 4 also rewrites the subtree sentences its change makes false outside those rows: in `lib/commcare/CLAUDE.md` the subcase close-on-submit (live through `placement.ts::PlannedPlacement.sharesWith`), "Repeat-context subcase splice", the several-case own block, the worker record's `usercase_update` and the selected own-case id's carriers; in `lib/case-store/CLAUDE.md` the result's child records (`OperationEffectRecord`), the several-case blank rule (`blankSavesNothing`), the touch stamp and the entry ids (`CaseOperationProgram.entryCaseKeys`); in `lib/preview/CLAUDE.md` the two-state collapse, the case-write paragraph and the submission's authority paragraphs; in `lib/domain/CLAUDE.md` the catalog sentence (`planFieldCaseWrite` reads `parent_type`), the case-operation paragraph (the own arm, the worker-record target, `via`, `onlyIfChanged`, `placement`) and the several-case preload sentence | the root rule: a subtree contract is true at every head, and each of these named `deriveCaseWriteInventory`, `deriveCaseConfig`, `caseWriteAdmission.ts`, the ordinary submission action or an implicit preload, which pull request 4 removes |
| §1 row 4's checks: the corpus emission and tool schema hashes at the pull request's base | the base is `hq-round-trip-case-writes/03-repeats` at its head, `cd6dbfa2`; the comparison found four tools' schema hashes moved, `addFields`, `editField`, `updateCaseOperation` and `updateForm`, and `addCaseOperations`, `getCaseOperations`, `removeCaseOperation` and `moveCaseOperation` changed only their descriptions | `scripts/inspect-tool-schema-hashes.ts` hashes input schemas only; the three newly registered `test:schema` entries and the two changed prompts are as §1 row 4 states |
| §2's pull request 4 list: `lib/agent/tools/evaluateForm.ts` | `evaluate_form`'s `proposedValues` reports the kind, the case ids and `caseOperations: "not-evaluated"` | the engine no longer derives case writes (part 01 §19); the operation program is built and evaluated by the server at submission |
| §7.5's scaffolding row, part 02 §25's extension sentence word for word ("a Save to Case block whose case id is `uuid()`, or an advanced open action where an after-submit link carries the new case") | the sentence adds "(or the id an answer keys it by)" and "in a form of a menu already advanced, an extension create that an open action can express takes one whether or not a link carries it (`placement.ts::planPlacements`)"; the replaced run also drops "In particular, it ignores `OpenSubCaseAction.relationship`" (the new first sentence says it) and "HQ emits an inactive redundant block (`relevant="false()"`), which the local splicer omits" | a keyed create's Save to Case id is the answer's (`xform/caseOps.ts`, `authoredCaseIdCalculation`); a form of an advanced menu tries an open action for every create before Save to Case (`placement.ts`, the `advancedLoadOf` / open-action loop), carried or not; and no extension create takes a basic subcase any more (`lib/domain/basicCaseSlots.ts::subcaseReasons`, `subcase-link`), so no `never` extension action and no inert block exist |
| §7.5's subcases bullet: "kept; adds" | the bullet also loses "including source-emitted extensions" and the parenthesis "The unowned-`owner_id` sentinel is an advanced-module-only shape … which Nova never emits", replaced by a pointer to "Advanced modules" | both were false at pull request 7's head: an advanced open action writes `-` where HQ does not set its owner (`xform/advancedCaseBlocks.ts`, `UNOWNED_OWNER_ID`), and no basic subcase is an extension |
| §7.5's case-operation row: "'always lower to Save to Case blocks' becomes 'take the placement `planPlacements` gives them, emitted by `casePlacementPlan.ts`'" | the phrase is absent at the base (pull request 4 rewrote the section); the sentence "`xform/caseOps.ts` lowers typed `Form.caseOperations` into the authored XForm source" takes the replacement instead, "Each operation is a … `SaveToCase` wrapper" becomes "Each Save to Case block is …", and `planFormCaseWire`'s list reads "the basic or advanced form actions" | the two sentences carried the old meaning at the head; `casePlacementPlan.ts::FormCaseWirePlan` has a basic and an advanced arm |
| §7.7's `moduleKindMoves.ts` bullet, word for word | the bullet opens with the plan's words and keeps the planner's two moves and its reason's `chosenCasesRenamed` | `lib/doc/moduleKindMoves.ts::planModuleKindMoves` states a held kind a blocker meets and a carried create that turns a published menu advanced; the chain's load names move with the menu's move, which carries the fact |
| §7.8's case-store entry-id row | "Every create the entry gives a session datum takes the id the entry's session minted", with a later datum of one type keyed `new-child-case:<type>:<n>`, and the `uuidv7()` sentence restated as every other create | `lib/preview/engine/caseDataBindingHelpers.ts::entryNamedCreates` reads `planFormCaseWire`'s `datums`, numbered by `lib/domain/entryCaseIdentity.ts::entryNewCaseKeyNumbering` (`:1`, `:2`, …) |
| §2's pull request 10 list | pull request 10 also re-points, under §2's importer rule, the readers of the renamed concepts the list does not name: `lib/domain/advancedModule.ts`, `placementCopy.ts`, `basicCaseSlots.ts`, `expression/formStructure.ts`; `lib/doc/modulePatchMutations.ts`, `searchInputMutations.ts`, `caseTypeRetirement.ts`, `mutationIdentityAdmission.ts`, `mutationSequenceAdmission.ts`, `hooks/usePlatformNotes.ts`, `hooks/useDocEntityMaps.ts` (it returns `formOrder`), `hooks/useOfferedBatchRefusals.ts` (new); `lib/commcare/entryPointSuite.ts`, `suite/case-list/columns.ts`, `shortDetail.ts`, `suite/case-search/claim.ts`, `searchSession.ts`, validator `gate.ts`, `runner.ts`, `formLogicFindings.ts`, `hqJsonOracle.ts`, `suiteOracle.ts`, `rules/app.ts`, `rules/advancedModule.ts`; `lib/case-store/appTestNamespace.ts`, `postgres/submissionEnvelope.ts` (`applyLinkEffect` exported for the claim's `host` index); `lib/preview/app-tests/submission.ts`, `engine/caseDataBindingTypes.ts`, `entryPointLaunchTypes.ts`, `hooks/useFormEngine.ts`; `lib/routing/locationRecovery.ts`, `topologyRecovery.ts`, `components/builder/LocationRecoveryEffect.tsx`; `lib/agent/authoring/formPreparation.ts`, `tools/case-list-config/addSearchInputs.ts`, `updateSearchInput.ts`, `removeSearchInput.ts`, `tools/shared/caseListMenuItem.ts` (new); the builder's `CaseListConfigWorkspace.tsx`, `FormSettingsPanel.tsx`, `NoMatchesAfterSubmitSection.tsx`, `ModuleCaseTypeSection.tsx`, `FieldInspectorBody.tsx`, `PlatformNoteRow.tsx`, `findingDestination.ts`, `components/preview/screens/FormScreen.tsx`; the lane's `proof/checks/test_corpus.py` (`FIXED_DOCUMENTS` 392), `proof/hq/test_flag_probe.py`, `test_publish.py`, `proof/native/test_search_validation.py`, `producers/caseOrderScenarios.ts`, `emit-container-evidence.ts`, `proof/targeted/documents/caseWritesOneConcept.ts`, `proof/views/conftest.py`, `proof/timings.json` | each reads `caseListOnly`, `searchFirst`, `moduleOpensOnSearch`, `Form.entry`, a renamed code or a renamed module at the base, or names one in a comment, and §2 lists modules by the parts' "Files by pull request" sections, which name the concept's owners rather than every reader |
| §2's pull request 10 list: `lib/doc/identityMoveCopy.ts`, `lib/commcare/planPrivileges.ts`, `lib/doc/caseSearchConfigMutations.ts`, `components/builder/shared/checkErrorPresentation.ts`, `proof/walk-stops.json` | unchanged | the `forms-read-search` sentence and the blockers live in `lib/domain/placementCopy.ts` and `lib/domain/advancedModule.ts` (part 02's Departures); `commtrackReasons` reads `moduleKind.ts::advancedModulesWithCaseListMenuItem`, which pull request 10 points at `moduleHasCaseListMenuItem`; the other two read none of the renamed concepts; G2 is written as outcome A, which adds no stop (part 05's Departures) |
| §1 row 10: corpus 425 | 424 (392 fixed) | the one-document offset part 08 recorded at pull request 8, carried forward (part 08's Departures) |
| §1 row 11: corpus 431 | 430 (398 fixed, beside the default fuzz sample of 32) | the same one-document offset carried forward: `proof/checks/test_corpus.py::FIXED_DOCUMENTS` rises by the six documents of part 08 §5.1 and §4.2, from 392 to 398 (part 08's Departures) |
| §1 row 13 and §2's pull request 13 list: the hash run "at `main`", `updateCaseOperation.ts` changed | the hash run's `main` is `f00930ab`, the stack's merge-base, and the pull request's base the `12-builder` head `87fb24f7`; `updateCaseOperation.ts` is unchanged, and the change also reaches `editField.ts`, `shared/fieldAssembly.ts`, `blueprintHelpers.ts`, `authoring/formPreparation.ts` and `authoring/output.ts` | part 07's Departures, rows marked 13 |

## What other parts read from this one

- **Every part**: the stack's numbers and order (§1, §4, R1); that subtree sentences move with their
  behavior and architecture and public docs land in 15 (§7, §8); the model-addition checklist (§6);
  the house rules (§5); the targeted documents by part 08 §5.1's names (R6) and every shared function
  by its owner's name (R7).
- **Part 01**: the held slots of an operation and of the own close, `planPlacements`' held-first
  reading and the allocator's held paths land in 4, `holdPlacements` and the held rules in 5 (decision
  2, R2); the field-written extension create's placement `{save-to-case, [nova_subcases,
  nova_subcase_<n>]}` through pull request 6 (R5); C9 as part 09 §7.4 writes it, with
  `own-close-in-repeat` and `own-close-moved` (R15); its §28 public docs in 15; its §23 sentences
  placed as §7 writes them; `sameTypeChildCases.ts` new in 4 as its §28 lists it.
- **Part 02**: its files as §2's pull requests 4, 7, 8 and 10 give them, which part 02's own "Files by
  pull request" confirms; the held kind and its target in 7; no stored `Form.caseSelections` (R4); §7.4's
  "Advanced modules" paragraph and §7.5's rows hold its §25 text, and §8 holds its `case-changes.mdx`
  paragraph.
- **Part 03**: the kernel rule's editor half in 5 and its `publish-placement` arm in 6 (decision 3, R3);
  the advanced menu item first emitted in 10 (R1); `sameTypeChildCases.ts` new in 4 (part 01), read in
  8; its §19 texts placed in §7 and §8.
- **Part 04**: the query repeat's held slot in 3 and its writer, rule and planner in 5 (R2); its §8.2
  and §8.3 texts placed in 15; its row sentence used by part 07 too (R10).
- **Part 05**: the decisions' order is kept (R1); `scripts/test-schema.ts` holds 55 entries at `main`;
  its §15 texts placed in §7 and §8; the claim type's case-schema row written by the drift writer after
  the deploy (R16).
- **Part 06**: its §15.1 texts in 11 and §15.2 in 15; the after-submit surface and `set_form_otherwise`
  in 11 (R12); part 08's document names (`targeted-form-link-chain`, `targeted-form-link-otherwise`,
  `targeted-form-link-carried-case`); §14.4's removal kept with `form-link-removed` (R20).
- **Part 07**: §7.1's rows placed as its "PR" column gives; the billed question of house rule 7, over
  the nineteen entries (R11); the plugin pull request opened beside 13 and recorded in 15.
- **Part 08**: the lane row, the reader runs by hand, the first night and the register totals of §1 are
  its; this part adds no document; the corpus reaches 431 (thirty targeted, three producer documents), or 430 under part 02's G4
  outcome B.
- **Part 09**: the maintenance image from 15's head, `git diff --stat <15>..<16> -- lib app
  ':(exclude,glob)**/__tests__/**'` naming only `lib/db/designSessions.ts`, the runbook's variable for
  the image's commit; the two public passages in 14; the pre-step fixtures in 1 with the capture test
  deleted in 2 and the digest test kept to 16 (R17); `form-link-removed` registered after
  `form-link-target-moved`; "Step 5 is done" (§9).
- **For the outlines.** This part leaves nothing of its own to step 6 or step 7: it builds no feature.
  The parts' deferrals, each written into its outline by this plan's own pull request with its reason,
  are: for step 6, the import's readers of what step 5 writes (`publishedCaseBlocks` and the witnesses'
  retained HQ reads, the count placement, reversed `form_links` with an otherwise, the search workflow
  and the menu concepts, plain labels, `commtrack-off` and `same-type-child-links` at import), because
  step 5 builds no reader; and the import refuses an advanced form whose selections its menu's parent
  chain does not give, naming each, because step 6 stores no case selection (R4, part 02 decision 3).
  For step 7, the authored shapes step 5 does not emit: stored case selections (several selected cases
  per form, a second case chosen from another menu's list, auto-selection, computed datums) with the
  `commcare-user` list module, because no Nova document needs them before an imported advanced form
  (R4); the other arms of `Module.caseListRegistrationForm`, display-only and shadow menus as link
  targets, a case list menu item's media slot, and the HELD-NEW entries part 08 §7.1 leaves, because no
  step 5 shape needs them; and a child case type under more than one parent, because the catalog holds
  one `parent_type` per type and no step 5 document needs a second (part 01 §3.4, departure 20).
