# Step 5: Case writes, forms and navigation

Step 5 makes a form's case writes one concept with a place in CommCare HQ that a publish keeps, and
gives forms and menus CommCare's own meaning. A form's case writes are its case operations, the form's
own case among them, and a field's "Saves to" is that field's view of them; each case change, query
repeat and advanced menu keeps the place in CommCare HQ the publish that first carries it records, and
an edit that moves one says so on every editor before it saves. It fixes defect 21 (the search
workflow), defect 22 (case writes as one concept), defect 23 (attachment mode), defect 24 (extension
child cases), defect 25 (query repeat placement), defect 26 (form links), defect 27 (field lists),
defect 28 (explicit preloads and plain labels), defect 29 (the menu concepts) and defect 30
(whole-number counts); defect 20's CommTrack half (the `commtrack-off` confirmation); defect 12's
guard (links between cases of the same type, probed at publish with an offered move); and, found while
planning, the `VIEW_FORM_ATTACHMENT` check that misses a link shown through a relation (part 03, N1),
the durable search claim step 3 left to this step's search workflow, and the lane's
`_cheapest_edited`, which would compare nothing once the register empties (part 08 §1.1). It ships as
one stack of sixteen pull requests, one maintenance cutover with a fold horizon and one deploy, and it
leaves the known-defect register empty.

This file is the plan. It holds the baseline the plan was written against, every decision that
departs from the outline it replaces or from the research, the work items with where each is
planned in full, the stack, the cutover, the contracts and the exit. The detail (schemas, files,
manifest text, register moves, tests, copy) is in ten part files beside it,
[`5-case-writes-forms-navigation/`](5-case-writes-forms-navigation/). A session implementing one pull
request reads this file, that pull request's row and its file list in part 10, and every part the row
names. Nothing here or there is left to decide during implementation: where a run outstanding decides
a fact, every one of its outcomes is written out in full. Every claim about what a CommCare reader does
with Nova's export was read at the pins during planning; "Written and not yet run" below lists every
gated execution and where each outcome is written.

| Part | Holds |
|---|---|
| [01](5-case-writes-forms-navigation/01-case-writes.md) | Defect 22's one concept (the `own` arm, the write with `via` and `onlyIfChanged`, the `worker-record` target, open and close conditions as `Expression`s), defect 23 and the `capture-link` term, defect 28's preload half, defect 12's model side, the placement shapes, `planPlacements` and its eligibility conditions, held placements and `HELD_PLACEMENT_INEXPRESSIBLE`, the operations' move planner, the classes C1 to C11 |
| [02](5-case-writes-forms-navigation/02-advanced-and-extension.md) | One wire plan per form (`planFormCaseWire`), when a module is emitted advanced and its kind blockers, the held kind, the HQ JSON of advanced modules and forms, tags, eligibility, `nova_owner_<op>`, datums on both paths, defect 24, `FORM_LINK_NEEDS_NEW_CASE_DATUM`, every HQ advanced rule and where Nova holds it, CommTrack's wire triggers, the classes M1 to M3 |
| [03](5-case-writes-forms-navigation/03-publish-and-ledger.md) | `holdPlacements`, the kernel rule `placementChangeRefusal`, the `publish-placement` change kind and how a publish records it, open tabs' fold and the placement conflict, the two placement offers, defect 12 at publish, `commtrack-off`, `VIEW_FORM_ATTACHMENT` over link writes, `publishedCaseBlocks`, unread baselines, downloads, MCP |
| [04](5-case-writes-forms-navigation/04-questions.md) | Defect 25's query repeat placement, defect 30's whole-number counts, defect 27's `group.fieldList`, defect 28's markdown half (`plainLabel` and the `plain-text` feature), the classes Q1 to Q4 |
| [05](5-case-writes-forms-navigation/05-search-and-menus.md) | Defect 21's search workflow (`workflow`, `formsReadSearch`, `searchWireShape`), defect 29's `caseListMenuItem` and `caseListRegistrationForm`, the durable claim as a case row, the five platform rows, Preview's workflow, the case list menu item's gated run, the classes M1 to M6 |
| [06](5-case-writes-forms-navigation/06-form-links.md) | Defect 26: destinations in the author's order emitted reversed, `Form.otherwise`, `this-form`, the held-case guard, offered targets, `setFormOtherwise`, Preview's after-submit stack per platform, the map L1 to L7 |
| [07](5-case-writes-forms-navigation/07-authoring.md) | The one identity-move statement (`withIdentityMoves`, `IdentityMoveDialog`, `identityMoves` on the SA and MCP), the builder's surfaces, the tools tool by tool, the guide verbatim, `MODEL_CONTEXT_VERSION`, the billed schema check, the `../nova-plugin` sweep |
| [08](5-case-writes-forms-navigation/08-proof.md) | The lane mechanics of pull request 1, every register move by pull request, walk stops, the census, fixture mappings, the fuzz mapping, edit kinds, the thirty targeted documents and eight migration witnesses, native and reader tests, manifest flips, CI cost, reader runs by hand, the first night |
| [09](5-case-writes-forms-navigation/09-cutover.md) | The one cutover: its fold horizon, the pre-step fixtures, the transform in order, published placements, deployment lines, the ledger, the fleet transaction, postconditions, `catalog.ts`, blockers, the notice, the Job, the production scan's findings, the runbook, the removal |
| [10](5-case-writes-forms-navigation/10-stack-contracts.md) | The stack in full with files by pull request, ordering constraints, house rules, the model-addition checklist, every contract and docs sentence that changes, the nova-plugin check, the exit |

## The baseline this plan was written against

**Nova.** `main` at `2f985ed6` (#825), which is step 4's fifteen pull requests (#809 to #825) merged
and its cutover run on production. Since step 4's plan was written at `e9e6cd93`, `main` also gained
#803 (step 4's plan), #805 (smoke races) and #802 (body-parser). What step 4 and the steps before it
left that step 5 builds on:

- **Two stored concepts for case writes.** `Field.caseWrite` (`lib/domain/fields/base.ts::caseWriteSchema`,
  with `captureCaseWriteSchema`'s `mode` on the five capture kinds) beside `Form.caseOperations`
  (`lib/domain/forms.ts::caseOperationSchema`). `lib/domain/caseWriteInventory.ts::deriveCaseWriteInventory`
  buckets field writers into HQ's basic `FormActions`; every authored operation lowers to a Save to
  Case block under `nova_operations` (`lib/commcare/xform/caseOps.ts`);
  `lib/domain/closeCondition.ts::closeConditionPlacement` derives where a close is written and stores
  nothing; `lib/domain/casePreload.ts::writerPreloadsFromLoadedCase` preloads implicitly; and
  `lib/commcare/subcaseWire.ts::hqCaseActions` keeps an inert extension subcase (part 01 §1).
- **No stored placement anywhere.** Every module is `doc_type: "Module"`, and nothing in Nova reads
  case blocks out of a deployment's normalized baseline
  (`lib/deployment/hqSourceBaseline.ts::normalizeHqAppSource`, part 03 §1).
- **The app change log and the kernel.** `lib/db/types.ts::APP_CHANGE_KINDS` holds six kinds and
  `CLIENT_APP_CHANGE_KINDS` the first three; the closed set is the trigger function
  `public.nova_admit_app_change_insert()`, not a CHECK; `lib/db/canonicalCommitKernel.ts::commitCanonicalBatch`
  has no head fence; a 409 `commit_rejected` reloads the tab with a fixed toast (part 03 §1).
- **Step 4's ledger and probe.** `app_deployment_confirmations` holds four kinds, the last
  `form-entry-sync-off` (`20261101010000_hq_round_trip_platforms_form_entry_sync.ts`), with copy in
  `lib/publish/planFeatures.ts::PROJECT_SPACE_SETTINGS`; the project-space probe reads eleven flags
  that must be on and none that must be off (`lib/commcare/projectSpaceCompatibility.ts`). Step 4
  moved CommTrack's confirmation here, since no Nova document reached either CommTrack trigger before
  advanced modules (part 03 §1, §9).
- **Step 4's platform declaration and table.** `appSettings.runsOnlyOn`, read through
  `lib/domain/platforms.ts::declaredPlatforms`; `PLATFORM_FEATURES` holds `search-first` (the inline
  shape, unavailable on Android), a derived `skip-to-results`, `search` and `case-list-menu-item`
  (`caseListOnly`); `lib/doc/platformDeclaration.ts::declaredForContent` closes the fuzz mapping
  (part 05 §1.5, part 08 §4.3). Every app that declares Web Apps sends `cloudcare_enabled: true`, so a
  list-first searching module there is HQ's REFUSED class `list-first-with-web-apps`, which step 4
  registered and left to this step's search workflow (part 05 §1.2).
- **Search, menus and claims.** `searchWireShape` derives skip to results from the inputs and the
  filter; `caseListOnly`, `Form.entry` and `caseSearchConfig.searchFirst` are stored; a claim lives in
  the session only (`lib/session/previewClaims.ts`, `claimedCaseIds`), and Nova writes no claim row
  (part 05 §1).
- **Repeats, groups and labels.** Every query repeat is written in one shape, its membership a
  snapshot; `REPEAT_COUNT_TYPE` checks only a direct read, the rest go through a `nova_count_` carrier;
  the checker has had the integer type since step 3; every labelled group is a field list; every itext
  entry writes both a plain and a markdown form (part 04 §1.1, §2.1, §3.1, §4.1).
- **Form links.** "First true wins", made true by `lib/commcare/formLinkProjection.ts::planFormLinkGuards`'
  exclusive guards over Core's run-every-true-frame stack, with `postSubmit` as the fallback and
  `FORM_LINK_CIRCULAR` refusing cycles (part 06 §1).
- **Fold horizons and cutover tooling.** Five fold identities, step 3's horizon route
  (`733dd193`) and step 4's cutover with its postcondition fix (`a8af778e`), whose lesson this step's
  `catalog.ts` carries (part 09 §1, §21.2). The last migration at `main` is
  `20261101030000_hq_round_trip_platforms_media_format_validated`.
- **The registers.** `proof/known-defects.json` 271 entries (defect 21 37, 23 79, 24 26, 25 101, 26
  18, 27 3, 28 3, 30 4), `proof/fixed-defects.json` 746, `proof/walk-stops.json` 25,
  `proof/controls/` 108 directories, `proof/identity-moves.json` `[]`, and
  `proof/checks/registers.py::OPEN_DEFECTS` `{21: 5, 23: 5, 24: 5, 25: 5, 26: 5, 27: 5, 28: 5, 30: 5}`.
  The corpus holds 398 documents (part 08 §2.1, part 10's opening).
- **Versions.** `MODEL_CONTEXT_VERSION` `"v5-hq-round-trip-platforms.12"` (`lib/models.ts`), App
  Tests' `RUNTIME_VERSION` 17 (`lib/db/appTests.ts`), `scripts/test-schema.ts::SCHEMA_TESTS` 55
  entries, and `../nova-plugin` at `105836d` with `plugin.json` `2.3.0`.

**CommCare.** Every fact this plan relies on was read, and where reading left doubt it is planned as
a run, at the commits `proof/pins.json` names, unchanged since step 2: commcare-hq `d6c6e16d8ae1`,
commcare-core `8e9ba8d908e9`, commcare-android `7a5584475580`, commcare-connect `046c7fd78081`,
formplayer `24383ac71bfb`, and Vellum `01215f251c57`, the build HQ vendors at that pin, with js-xpath
at `v0.0.10`. The weekly pin pull request #734 is open and unmerged; the plan reads the pins `main`
names. Citations are `file::symbol`.

**Executed during planning.** Each part's "Executed during planning" gives what it read or ran and
what it showed; every run was content-free and ran on this machine, one of them reading production's
database read-only. The runs that decided the plan:

- **The CommCare reads at the pins**, in the checkouts, by `rg` and reading the enclosing function:
  HQ's basic and advanced case builders (`xform.py::XForm._create_casexml`,
  `_create_casexml_advanced`), its form action and advanced models and validators, its suite entries
  and end-of-form workflow (`suite_xml/sections/entries.py`, `suite_xml/post_process/workflow.py`), its
  form settings and Case List pages (`views/forms.py::_get_linkable_forms_context`,
  `details/case_claim.js`), its toggles; Vellum's model iteration, itext and repeat-count rules; Core's
  session stack (`CommCareSession.java::executeStackOperations`, `finishAndPop`) and form entry;
  Formplayer's menu session and end-of-form path (`MenuSession.getNextScreen`,
  `MenuSessionFactory.rebuildSessionFromFrame`); Android's widgets and case list detail (parts 01 §25,
  02 §28, 03, 04 §10, 05 §17, 06 §18, 07, 08, 09 §2). Several research and outline claims were
  corrected by these reads; each is recorded for `harness-findings.md`, "Found while planning step 5".
- **A census of the corpus's checked-in sources** (`producerDocuments`, `targetedDocuments`,
  `workforceDocuments`: 228 documents read in memory with the domain's readers, nothing emitted; the
  expander and fuzz generators read from their sources). It found field case writes in 79 documents,
  11 of them in attachment mode; case operations in 28, none with an extension link (every extension
  child is a field write); query repeats in 20, counts in 18, form links in 17 with no self-link; a
  user repeat inside a labelled group only in `targeted-labelled-group-repeat`; list first in 34
  documents (26 declaring both platforms, 8 Web Apps only, none Android only) and today's inline
  search first in 20, all Web Apps only; 8 no-matches forms and 38 case-list-only menus; and no fuzz
  generator drawing an attachment-mode write, an extension child, a form link, a close condition or a
  case-list-only menu. So the fixture mappings and the fuzz mapping are what part 08 §4.2 and §4.3
  give, and declaring the 26 both-declared list-first documents Android only was rejected (part 08
  §4.1, §4.2).
- **Reads of Nova's registers, manifest entries and history**: the 271 known entries by defect,
  check, document, control and reader (part 08 §2.1 and its appendix); every HELD-NEW entry step 5's
  shapes touch (part 08 §7.1); step 3's and step 4's cutover tooling at `733dd193` and `a8af778e`
  (part 09); and `../nova-plugin` at `105836d` (part 07 §6).
- **A content-free, read-only scan of production**, which the person approved; no count from it
  enters this plan, and each part states what it found where that decides something (part 09 §19).
  Production holds published apps, some with a deployment whose baseline Nova never read, so the rule
  that keeps today's placements for an unread baseline applies at the window; no stored baseline fails
  to read, and none holds an extension child's Save to Case block at Nova's path. It holds follow-up
  forms whose case operation closes the form's own case, so the cutover's C9 rewrites forms at the
  window; update operations on the own case, which stay operations; worker-record writes; and no
  capture write of any mode. Extension child writes exist only in unpublished apps and no link carries
  one, so no module becomes advanced; no basic child of its own menu's case type exists. Query repeats
  exist, some published and some the rule gives the count placement; every stored count already types
  as a whole number, and a count read directly from a Hidden Value exists. Form links exist in a few
  apps, none with two links, so no exclusivity guard, terminal else or link to an unoffered target
  meets an app, while a stored after-submit beside conditional links and stored destinations that
  never run both do. Labelled groups holding a user repeat exist and no section holds one; preloads
  that replace a default and later load-time readers of a preloaded writer exist; no-matches forms,
  case-list-only menus and a stored inline search first exist, and no module holds two no-matches
  forms. List-first searching menus exist in apps that declare Web Apps and in apps that declare
  Android only. Open private agent work exists, no mutation event row does, and apps carry history past
  their greatest fold baseline, so the horizon matters. The classes it did not count (part 01's (f)
  and (g), own closes under `forEach` or holding writes, query repeats reading their own rows, a
  published form holding the supply-point text, part 05 M1's last row, the no-matches label's overlay
  entries, an underscore worker property) keep both outcomes, decided by the advisory dry run.

Nothing was run in HQ, Core, Formplayer, Android, Connect, a browser or the lane.

**Written and not yet run.** Each part states its design as the plan's and says in place where a run
is outstanding; this list is every such place.

- **Core's order across placements** (part 01 G1, pull request 4, `CaseOperationRuntimeTest`).
  Outcome A, Core indexes a new case to one created later: §12.4 stands. Outcome B: the basic own and
  subcase slots gain the condition `case-linked-before-create`. Written in part 01 §26.
- **A child's condition on its own repeat's question** (part 01 G3, pull request 4's run by hand).
  Outcome A: §12.1 stands. Outcome B: a child's condition is stateable only over a question in no
  repeat. Part 01 §26.
- **The form builder keeps the explicit preload** (part 01 G4, pull request 4's proof 4). Outcome A:
  defect 28's entries move. Outcome B: the preload's spelling follows the save, with a control retained
  where the pre-fix bytes must keep showing the class. Part 01 §26, part 08 §2.6.
- **The Case Management save keeps `update_mode: edit`** (part 01 G5, pull request 4's proof 4).
  Outcome A: the flip stands. Outcome B: `onlyIfChanged` is refused everywhere, its capability and
  inputs are withdrawn, and step 7's outline gains it. Part 01 §26, part 07, part 10 §8.
- **HQ keeps Nova's advanced JSON** (part 02 G2, pull request 7's proof 4). Outcome A: section 7
  stands; B: Nova writes the saved spelling; C: the changed shape leaves advanced actions and its entry
  is REFUSED. Part 02 §29.
- **A question named like the block HQ appends** (part 02 G3, pull request 7). Outcome A: the clause
  `appended-name-taken` joins eligibility; B: nothing changes. Part 02 §29.
- **A worker property whose slug starts with `_`** (part 02 G4, pull request 7). Outcome A: the clause
  `worker-property-name` sends the write to Save to Case; B: the code `WORKER_PROPERTY_WRITE_NAME`
  refuses it, `targeted-worker-underscore-write` leaves and the corpus holds 430; C: nothing changes.
  Part 02 §29, part 08 §5.1, part 09 §16.
- **The owner of an extension-only open action** (part 02 G6, pull request 7). Outcome A: the worker
  owns it; B: it stays unowned and every surface says so. Part 02 §29, part 07, part 10 §8.
- **CommCare Supply's effect** (part 03 G1, part 08 G4; pull request 7's lane and pull request 10's).
  Outcome A: the effects are written and held; B: the product column's spelling is corrected, or the
  consequence names a build failure; C: `commtrackReasons` widens to the shape the run shows; under
  part 08's G4 outcome C the build reads `APP_BUILDER_ADVANCED`: publish probes the flag, the gate
  entry takes the probe, a space without it is refused `project_space_incompatible`, and part 02's
  decision 19 is replaced in pull request 7.
  Part 03, "Written and not yet run"; part 08 G4.
- **The supply-point text after a form-builder save** (part 03 G2, pull request 8). Outcome A: text
  nodes and attributes are read; B: attributes only; C: the text arm goes. Part 03, part 10 §8.
- **The project-space list reads `DONT_INDEX_SAME_CASETYPE`** (part 03 G3, pull request 8). Outcome
  A: the inverted probe ships; B: a sixth confirmation kind `same-type-links-kept` replaces it. Part 03,
  part 10 §7.8.
- **The flag's effect on Nova's same-type child** (part 03 G4, pull request 8). Outcome A: the
  capability, refusal and offer stand; B: they leave pull request 8. Part 03.
- **The migration tests' heap-order precondition** (part 03, pull requests 6 and 8; part 09 G5, pull
  request 14's `catalog.postgres.test.ts`). Outcome A: the tests prove the schema-qualified reads; B:
  the seeding moves until the precondition holds. Part 03, part 09.
- **The editor saves and served readers over query repeats and counts** (part 04 G1, pull request 3's
  run by hand). Outcome A: §1.4, §1.5 stand; B: the emitter writes the save's spelling; C: the count
  placement drops its wrapper and moves answer paths; D: an incomplete emission is fixed. Part 04 §11.
- **Core's reading of the count placement and direct counts** (part 04 G2, pull request 3's lane).
  Outcomes A, B1 (an index setvalue), B2 (rows past the end stay), C (a row keeps its record) and D
  (a direct Hidden Value count keeps its carrier). Part 04 §11, part 07.
- **Field lists and plain labels on every reader** (part 04 G3 with part 08 G5, pull request 9).
  Outcome A: the cells stand; B: Android formats a plain label, read DIFFERENT; C1: a kind loses
  `plainLabel`; C2: `FIELD_LIST_UNLABELLED`; D: a cell follows its reader. Part 04 §11, part 07, part
  08 G5.
- **The case list menu item on every reader** (part 05 G1, pull request 10's run by hand, decision 6
  of the decisions). Outcome A: "Redirecting after sync" and the first menu; B: the screen before the
  choice; C: an empty list; a walk that errors or stops makes the item beside forms refusable there;
  and the device half. Part 05 §18, part 07, part 10 §8.
- **Every document whose searching menu turns search first** (part 05 G2 with part 08 G2 and G3, the
  same dispatch). Outcome A: the moved entries show on their controls only, stops keep their causes,
  and the expander's defect 21 entry moves in pull request 10; B: new or changed stops in pull request
  10, or the expander entry moves in pull request 11; C: Android's reading of search first is
  corrected. Part 05 §18, part 08.
- **HQ's Case List page keeps each workflow** (part 05 G3, pull request 10's proof 4). Outcome A:
  stands; B: the shape is REFUSED with `SEARCH_WORKFLOW_NOT_KEPT_<SHAPE>` and migrated. Part 05, part 07.
- **A Search screen with no visible field** (part 05 G4, the G1 dispatch). Outcome A: stands; B: the
  search runs on its own, or a device reads `auto_launch`. Part 05, part 07.
- **Claim rows against HQ's restore fixtures** (part 05 G6, pull request 10's CI). Outcome A: equal
  closures; B: the old seed's departure is named. Part 05 §18.
- **Several destinations that hold** (part 06 G1, pull request 11's run by hand). Outcome A: Web Apps
  opens only the first, the feature `after-submit-several-destinations` lands; B: Web Apps runs the
  chain and the feature is not added (or runs it in another order); C: Android also opens only the
  first. Part 06 §19.1, part 07, part 10 §8.
- **The held-case guard** (part 06 G2). Outcome A: stands; B: a static rule
  `FORM_LINK_DATUM_NOT_A_CASE` and migration class L8 replace the guard. Part 06 §19.2, part 09 §17.
- **HQ's editors keep every new link shape** (part 06 G3). Outcome A: stands; B: each changed shape is
  refused with its own code and `mapFormLinkSemantics` stays total. Part 06 §19.3.
- **The billed schema check** (part 07 G-A1, once at pull request 13's head, nineteen tools, on the
  person's yes). Outcome A: each accepted; B: a refused construct is replaced and that tool alone asked
  again. Part 07, part 10 house rule 7; part 04 G5 and part 05 G5 are its rows.
- **The plugin merge waits for the deploy** (part 07 G-A2, the deploy check-run on the merge commit).
  Outcome A, the deploy succeeds: the `../nova-plugin` pull request merges. Outcome B, it fails or rolls
  back: the plugin pull request stays open and merges after the repaired deploy is live. Part 07, part
  10 §10.
- **The witnesses' retained A and HQ's reads of it** (part 08 G1, part 09 G4, pull request 1).
  Outcome A: every placement class has a read; B: a class HQ's read drops is never held and takes
  cause `placement-simplified`; C: a pre-step spec is corrected. Part 08, part 09.
- **Served entries by hand** (part 08 G2, pull requests 2, 3, 7, 10 and 11). Outcome A: each moved
  class shows on its control only; B: the fix is completed, never re-registered; C: a stop is added or
  rewritten in pull request 10. Part 08.
- **The identity moves from each witness's evidence** (part 08 G6, part 09 G9, pull requests 2, 3, 4,
  7, 9, 10 and 11). Outcome A: written as expected; B: an unforeseen move is a defect or joins the
  notice; C: an expected move that does not happen is dropped. Part 08, part 09.
- **CI cost** (part 08 G7, pull request 15's fresh dispatch). Outcome A: the gate ends within the
  expected end, and `proof/timings.json`'s `no-readers` profile and the README's timings are written
  from it; B: a heavy step 5 document is observed in pieces and the README states the measured end; C:
  `plan fit` gives a thirteenth shard, and the timing rows read 13 shards. Part 08.
- **The bundle and `sharp`** (part 09 G2, pull request 14's CI). Outcome A: the bundle loads with no
  `node_modules` and its line stands; B: it takes `--external:sharp` and stage `maintenance` takes step
  4's three `COPY` lines. Part 09.
- **The plan's duration** (part 09 G3, the advisory dry run). Outcome A: at most an hour, and `7200s`
  stands; B: the Job's timeout becomes twice the measured seconds plus 1,800, the image is built again
  and runbook step 1 repeats before the window. Part 09.
- **The frozen classifier against production's baselines** (part 09 G6, runbook step 1(e)). Outcome
  A: `frozenDisagrees` is zero and section 8 stands; B: each disagreement is settled before the window,
  a push from older code recorded and one from `main`'s code fixed in pull request 14. Part 09 §8.6.
- **The drift writer converges the planned differences** (part 09 G7, after the deploy). Outcome A:
  the scan after reports none and ingress reopens; B: an app it could not converge runs again with
  `--app <id>` until the scan reports none, and ingress stays closed until then. Part 09.
- **The advisory dry run's blockers and uncounted classes** (part 09 G8, part 04 G4, part 03, part 01
  §26, part 05 §14). Every class the planning scan did not count is decided here, each outcome
  written in its part. Outcome A: the dry run's outcome is `ok` and the window is planned; B: each
  blocker is resolved by part 09 §16's remedy and runbook step 1(c) to (e) repeats until `ok`.
- **The contract sweep, the docs build and the plugin re-sweep** (part 10 G1 to G3, pull requests 15
  and 13). Outcome A: no hit outside `docs/research/`, the build passes, and the plugin pull request
  carries part 07 §6's nine edits; B and C: each hit, failed page or further claim is fixed in the pull
  request part 10 names for it, and a plugin head past `2.3.0` takes its next minor. Part 10.
- **The exit** (part 10 G4, after the merge and the first nightly). Outcome A: every row of part 10
  §11 holds and step 5 is done; B to D: a failing lane, register, production, contract or removal row is
  fixed forward as part 10 writes, and its check repeats. Part 10.
- **The first nightly after the merge**, the whole lane with every reader (part 08 G8, §8.5). Outcome
  A: it passes, and one pull request refreshes the `readers` profile and the README's timings from it;
  B: its issue names each failing group, fixed in its own pull request at that slice before part 10
  §11's rows 1 and 2 are checked again. Part 08.

## What changed from the outline, and why

The outline fixed the step's scope. Planning it against the code as it stands changed these. Each
is a decision; the part named gives its evidence.

1. **Case writes are one stored concept.** `Field.caseWrite` leaves the document in pull request 4; a
   form writes case data only through `Form.caseOperations`, and a field's "Saves to" is
   `lib/domain/caseWriteViews.ts::fieldCaseWriteViews`, derived and never stored. Deriving operations
   from field writes would keep defect 22 (part 01 decision 1).
2. **The form's own case is the `own` operation arm,** first on every registration, follow-up and close
   form, its lifecycle the form's type. No other operation writes, retypes or closes what it writes, so
   its first place in the array and Case Management's block, which HQ appends last, cannot disagree;
   the shapes that rule refuses are migrated (part 01 decisions 2, 3, §5.3).
3. **Open and close conditions are `Expression`s,** not a literal widened to a choice as the outline
   had it: a second condition grammar would stand beside the one `Expression`, and a Save to Case close
   already takes any condition. A comparison with a static select holds a `choice` leaf, so an option
   edit reprints it (part 01 decision 4, §27).
4. **`via` and `onlyIfChanged` belong to the own arm** (and, from pull request 7, an advanced load),
   since no other operation takes a Case Management slot; `onlyIfChanged` asks the capability **Save
   only answers that changed** at publish (part 01 decisions 5, 12, §27).
5. **The worker's record is a target,** `{kind: "worker-record"}`, of at most one update per form, and
   **a captured file reaches a case only as the term `capture-link`;** attachment mode and its
   capability leave in pull request 2, before the model change (part 01 decisions 6, 7).
6. **A preload is a default value** that reads the case, written when a writer of the own case is born
   on a one-case loading form and edited like any default; Nova never writes `case_preload` again (part
   01 decision 11).
7. **Placements are stored shapes, held from the publish that first carries them.** A basic slot, an
   advanced action and its tag, or a Save to Case path, held on an operation, on a form's own close,
   on a query repeat and on a module's kind. Each held slot lands with the concept it holds (pull
   requests 3, 4 and 7), every mutation payload omits it, and only `holdPlacements` writes one, from
   pull request 5 (part 01 decision 8, part 03 decision 1, part 10 decision 2).
8. **One placement procedure and one wire plan per form.** `lib/commcare/placement.ts::planPlacements`
   gives every subject its placement, held first, then the simplest eligible under a closed list of
   conditions; `lib/commcare/casePlacementPlan.ts::planFormCaseWire` turns those into the actions, the
   blocks, the generated nodes and the datums, so they cannot disagree (part 01 decision 9, part 02
   decision 1).
9. **Who may change a hold is one kernel rule.** `lib/db/placementAuthority.ts::placementChangeRefusal`
   lets a publish or a migration record any hold, and an editor only move a hold its own batch makes
   inexpressible or restore exactly the hold the target's latest recording wrote, which is how undo
   puts a published place back. It reads documents and recordings, so a forged autosave and a stale
   undo meet it alike (part 03 decision 3, part 01 §27 item 17).
10. **`publish-placement` is a seventh app change kind,** admitted by replacing the trigger function
    (there is no CHECK), written after preflight and before anything is sent at the head the publish
    emitted, behind a head fence that reloads and re-runs preflight up to three times. The recorded
    document is what the publish sends, and recording a derived placement changes no emitted byte
    (part 03 decisions 4, 6, 7).
11. **Open tabs fold a recorded placement as a peer's change and keep undo;** an edit composed before
    the record is refused with the typed reason `placement-recorded` and offered again, re-planned, in
    the identity-move dialog with the publish lead, not toasted (part 03 decisions 8, 9, part 07
    decision 4).
12. **One identity-move statement on every editor.** `lib/doc/identityMoves.ts::withIdentityMoves`
    composes the module-kind, operation and query-repeat planners; the builder states the moves in one
    `IdentityMoveDialog` before any dispatch, review, undo or redo; the SA and MCP state them in
    `identityMoves` and `saveWork` repeats them, asking no confirmation, since the work stages privately
    and `saveWork` is the commit (part 07 decisions 1 to 5). Placements are shown, never chosen (part 07
    decision 6).
13. **A module is advanced exactly when its kind is held or a link carries a create no basic placement
    gives a datum,** and no kind blocker holds. There is no stored `Form.caseSelections`: an advanced
    form's loads are derived from its menu's parent chain, and stored selections go to step 7 (part 02
    decisions 2, 3, §6.3).
14. **HQ's advanced rules are eligibility, not refusals.** Four kind blockers keep a menu basic; an
    operation an advanced action cannot express takes a Save to Case block; the one rule with no
    fallback is the new code `FORM_LINK_NEEDS_NEW_CASE_DATUM` (part 02 decisions 4, 8, 13, §16).
15. **Preloads stay defaults in an advanced form,** since HQ appends a preload after every setvalue
    and a module turning advanced would otherwise change what a later default reads (part 02 decision
    9, §11).
16. **An extension child case is a create with an `extension` link:** a Save to Case block, or an
    advanced open action where a link carries it; the inert subcase goes, basic subcases renumber, and
    carrying applies to every create a link carries. An extension-only open action owned by the worker
    writes `owner_id` through `nova_owner_<op>` (part 02 decisions 10 to 12).
17. **Nova publishes advanced modules without `APP_BUILDER_ADVANCED`,** which gates only adding one in
    HQ's editor (part 02 decision 19).
18. **Defect 12 is the probed capability `same-type-child-links`,** whose flag must be off, read by a
    new `featureFlagsOff` arm of the probe, with the offered move to Save to Case and no validator rule;
    until pull request 8 such a create takes Save to Case (part 03 decision 11, part 01 decision 13,
    §27 item 19).
19. **CommTrack is the fifth confirmation kind, `commtrack-off`,** asked for an advanced menu whose
    case list is its menu item or a form whose decoded source holds the supply-point text; HQ's third
    trigger, `show_product_stock`, is unreachable from a Nova export and is no reason (part 03 decision
    12, part 02 decision 16).
20. **Two placement offers share one shape,** `save-to-case` and `same-type-child-links`, each all or
    nothing, digest-named and recorded before preflight; downloads record nothing (part 03 decisions 10,
    16).
21. **A published deployment whose baseline Nova never read keeps today's placements,** computed by a
    frozen copy of today's classifier, held and named `placements-kept-unread`; a query repeat the
    rule gives the count placement is the one exception, and a stored baseline that fails to read is
    the blocker `baseline-unreadable`. A deployment whose live mapping is marked missing on HQ counts as
    published (part 03 decision 15, part 09 decisions 5, 6).
22. **A query repeat's placement is decided by a structural rule,** not the research's load-time
    analysis. Model iteration is written as Vellum writes it; the count placement keeps the wrapper and
    its `item` rows, so no answer path moves, and a row past the end is hidden. A row keeps its
    position, not its record. There is no `setQueryRepeatPlacement`; `holdPlacements` carries the target
    (part 04 decisions 1 to 6, Departures).
23. **A repeat count is a whole number by the checker's expectation;** the integer type the outline
    asked for has existed since step 3. A direct count needs no copy (part 04 decisions 7, 8, §2.1).
24. **`group.fieldList` decides the field list,** born where the label has text and no user repeat sits
    inside, with `FIELD_LIST_USER_REPEAT` refusing such a repeat at any depth (part 04 decision 9).
25. **`plainLabel` turns markdown off on labels and inline choices only;** hints, help and validation
    messages carry no flag and keep their markdown form: no runtime reads a hint's or a validation
    message's, and Android renders a help text's, which Nova always writes. A new feature `plain-text`
    states the Web Apps difference. Preview renders no author HTML (part 04 decisions 10, 11, the decisions'
    resolution 2).
26. **The search workflow is two authored slots,** `caseSearchConfig.workflow?: "listFirst" |
    "skipToResults"` with absence as search first on every declaration, and `formsReadSearch?: true`
    for HQ's inline shape. `searchWireShape` maps them totally and derives nothing; every stored
    document keeps its wire but list first in an app that declares Web Apps, which is defect 21's fix
    (part 05 decisions 1 to 3).
27. **Five platform rows move,** with `list-first` new, `search-first` redefined as the non-inline
    workflow, `skip-to-results` authored and `forms-read-search` the new id of the inline row; the
    outline's ambient entry stays ambient and list first is a feature through a new export-use entry;
    `HISTORICAL_PLATFORM_CAUSE_WORDS` keeps step 4's stored notice rows rendering (part 05 decision 4,
    Departures).
28. **A search with no visible field never falls into search first by accident:** a planner writes
    `skipToResults`, and a list-first menu with no visible field in an app that declares Web Apps
    migrates to skip to results, not search first (part 05 decisions 6, 13).
29. **The menu concepts are renamed and widened.** `Module.caseListMenuItem` replaces `caseListOnly`
    and its media and is admitted beside forms; `Module.caseListRegistrationForm` replaces
    `Form.entry`, its `kind` stored now so step 7's arms need no migration (part 05 decisions 7, 8).
30. **A claim is a case row,** an open `commcare-case-claim` case with a `host` index, as HQ's claim
    is, lasting until a person releases it from Preview's identity menu (part 05 decision 9).
31. **The case list menu item's Web Apps reading is one gated run with three written outcomes,** read
    again at the pins rather than assumed from step 4 (part 05 decision 11, §18).
32. **Form links run every destination that holds, in the author's order, emitted reversed;** Web Apps
    opens only the first, stated as the feature `after-submit-several-destinations`. The otherwise is
    its own slot, running when no destination that may not run runs; `postSubmit` holds only beside no
    destinations; `this-form` is a target and cycles are admitted; a carried case must be on the device;
    and Nova admits only the targets HQ's form settings page offers (part 06 decisions 1 to 7).
33. **Pull request 11 carries the whole after-submit surface** with `setFormOtherwise`, in part 07's
    words, because each piece reads what the model change removes (part 06 decision 11, the decisions'
    R12).
34. **The stack keeps the decisions' order:** advanced modules (7) and CommTrack (8) sit beneath search
    and menus (10), so the advanced module's case list menu item beside forms, its flip and its lane
    witness land in 10 (part 10 decision 1, part 05 decision 14).
35. **One cutover with a fold horizon, step 3's form.** Step 5 removes keys every earlier document holds,
    so no `blueprint-migration` batch can be written; the old shape is held by pre-step fixtures captured
    in pull request 1 while `main` admits them; private agent work is discarded with its notice (part
    09 decisions 1 to 4, 8).
36. **The fleet transaction writes no case schema row:** the claim type's row and every planned
    difference converge through the existing drift writer after the deploy and before ingress reopens
    (part 09 decision 10, the decisions' R16).
37. **A republish after each migration is observed on a witness.** Eight migration witnesses retain
    the export of an app from before step 5, and proof 1 accepts only the identity moves scoped to each,
    a departure from `proof/identity-moves.json` being empty by design (part 08 decision 5, Departures).
38. **No step 5 pull request leaves a live entry;** every entry moves to the fixed register on its
    retained control, and an outcome that would add one fixes or refuses the shape instead (part 08
    decisions 1, 3).
39. **The fuzz sample keeps its draws;** each generator maps a drawn step 5 shape through the pure
    planners the cutover uses, kept in `lib/doc` after the tooling leaves (part 08 decision 12, part
    09 decision 3).
40. **Versions:** `MODEL_CONTEXT_VERSION` moves to `"v6-hq-round-trip-case-writes.<n>"` in each pull
    request that changes a served tool or the guide, and the stack deploys `.13`; `RUNTIME_VERSION`
    moves once, to 18, in pull request 3; the billed schema check is asked once, at pull request 13's
    head (part 10 decisions 5, 6).
41. **Old app-test namespaces need no work,** and step 4's postcondition fix, which never had a review
    of its own, is reviewed here (part 09 §21.2) and carried as a lesson: every catalog read names its
    relation through `catalog.ts`, whose test reproduces the heap order, and any fix made after the
    cutover pull request's review gets its own `/code-review medium` before the merge (part 09 §21.3).
42. **The notice names what an author or worker can see change.** A change the model makes everywhere
    alike (field writes shown as operations, renamed menu concepts, a duplicate write C10 removes) gets
    no line, and the execute report counts every entity changed (part 09 §10.3).
43. **A child case type under more than one parent is step 7's** (the research's "Also held" list),
    because the catalog keeps one `parent_type` per type, and a `create` already links to a case of any
    declared type (part 01 §3.4, departure 20).
44. **The departures each part records and accepted:** part 01 §27; part 02 §27; part 03, Departures
    (holds in pull request 5, undo to the recorded hold, the conflict offered again, the recorded
    document sent, `baseline-unreadable`); part 04, Departures; part 05's Departures (no App Test
    session rewrite, the registration label unit); part 06's Departures table; part 07 §8; part 08,
    Departures (the witnesses as the cutover's republished documents, `flagsOff`, the split targeted
    document, the case-writes witness's two close forms, the form-links witness holding L1 to L4,
    the capture's record applied from pull request 6); part 09, Departures (the blocker codes, the
    frozen classifier's production check, the new causes, the C10 and C11 fixtures' shapes); part 10, Departures (the tests excluded from the removal's diff check).

The plan's own pull request writes into the later outlines what moves there, each with its reason
(part 10, "For the outlines"): into `6-import.md`, the import's readers of what step 5 writes
(`publishedCaseBlocks` and the witnesses' retained HQ reads, the count placement, reversed
`form_links` with an otherwise, the search workflow and the menu concepts, plain labels,
`commtrack-off` and `same-type-child-links` at import), and the import's refusal of an advanced form
whose selections its menu's chain does not give (parts 01, 03, 04, 05, 08, 09); into
`7-rest-of-model.md`, stored case selections with the `commcare-user` list module, the other arms of
`Module.caseListRegistrationForm`, a case list entry's media slot in `setMenuMedia`, display-only and
shadow menus as link targets, a child case type under more than one parent, and the HELD-NEW entries part 08 §7.1 leaves (parts 02, 05, 07, 08).

## Work items

| Item | What it settles | Part |
|---|---|---|
| A. Case writes as one concept | Defect 22, defect 23, defect 28's preload half, the own arm, `via`, `onlyIfChanged`, the worker's record, conditions, `capture-link` | 01 |
| B. Placements and holds | The placement shapes, `planPlacements`, held slots, `HELD_PLACEMENT_INEXPRESSIBLE`, the operations' moves, defect 12's model side | 01 |
| C. Advanced modules and extension children | `planFormCaseWire`, the module kind and its blockers, the held kind, HQ's JSON, tags, eligibility, defect 24, `FORM_LINK_NEEDS_NEW_CASE_DATUM` | 02 |
| D. Publish and the ledger | `holdPlacements`, the kernel rule, `publish-placement`, the fold and conflict, the offers, defect 12 at publish, defect 20's `commtrack-off`, N1, unread baselines | 03 |
| E. Repeats | Defect 25's query repeat placement, defect 30's whole-number counts | 04 |
| F. Groups and labels | Defect 27's `fieldList`, defect 28's `plainLabel` and `plain-text` | 04 |
| G. Search and menus | Defect 21's workflow, defect 29's menu concepts, durable claims, the five platform rows | 05 |
| H. Form links | Defect 26: order, otherwise, `this-form`, the guard, offered targets, Preview's stack | 06 |
| I. Authoring | The identity-move statement, the builder, the SA and MCP, the guide, versions, the billed check, the nova-plugin sweep | 07 |
| J. Proof | Lane mechanics, registers to empty, witnesses, census, fuzz mapping, targeted documents, reader runs | 08 |
| K. The cutover and notice | The horizon, the transform, published placements, the ledger, blockers, the notice, the runbook, the removal | 09 |
| L. The stack and contracts | Files by pull request, ordering, house rules, contracts and docs, the exit | 10 |

## Proof

Part 08 holds this in full.

- **The known register goes from 271 to 0 and the fixed register from 746 to 1,017.** Every entry
  moves to `proof/fixed-defects.json` on its retained control in the pull request that takes its
  symptom off its document, none deleted: defect 23's 79 in 2, defect 25's 101 and defect 30's 4 in 3,
  defect 28's 3 in 4, defect 24's 26 in 7, defect 27's 3 in 9, defect 21's 37 in 10 and defect 26's 18
  in 11; the known register reads 192, 87, 84, 58, 55, 18 and 0. Under part 08's G3 outcome B one
  defect 21 entry stays live in 10 and moves in 11, so the exit is the same (§2.3, §2.5).
- **`OPEN_DEFECTS` is `{}` from pull request 11,** losing each defect with its last entry, and
  `test_every_live_defect_is_a_later_steps` asserts every remaining step is greater than 5 (§2.4). No
  step 5 pull request adds a live entry: an outcome that would show a class on a document after its
  fix fixes or refuses the shape, and where the pre-fix bytes must keep showing it, a control is
  retained and the class registered directly as fixed (§2.6).
- **Walk stops stay at 25** unless pull request 10's run shows a new `search-refused` stop or a changed
  cause (part 08 G2 outcome C); `tile-grouped-search` and `prompt-widgets` are expected to keep theirs,
  and `case-operation-link`'s stop stays (§3).
- **Controls stay at 108;** no control is retained for a defect in step 5 but under §2.6's rule.
- **Thirty targeted documents and three producer documents** take the corpus from 398 to 431 (430
  under part 02's G4 outcome B): the eight migration witnesses in 1, and twenty-two documents of new
  shapes in 3, 4, 5, 7, 8, 9, 10 and 11, each named once in part 08 §5.1 and used by that name in every
  part; none needs a control (§5.1).
- **Eight migration witnesses** under `proof/migrations/<id>/`, each retaining the export of an app
  from before its migration with HQ's reads of it under `proof/hq-reads/targeted-migration-*`; proof 1
  compares that A with Nova's republish of the migrated document and accepts only the identity moves
  `proof/identity-moves.json` scopes to it, each written from the witness's own evidence (§1.2, §5.2,
  G1, G6).
- **The census test, the fuzz mapping and the edit kinds** hold each new shape to some document:
  `holdPlacements` and `setFormOtherwise` get edit-kind generators, and from pull request 5 the corpus
  judges a candidate batch by the kernel rule as well as the gate (§4.3 to §4.6).
- **Native classes and lane tests** land with the change they hold: `ContainerRuntimeTest`,
  `RepeatCountRuntimeTest`, `CaseOperationRuntimeTest`, `CaseCaptureRuntimeTest`,
  `AdvancedFormRuntimeTest` and `FormLinkRuntimeTest`, with lane tests of HQ's advanced rules, search
  workflow offers, form link targets and Android's form reads (§6).
- **Where the lane runs.** Every pull request runs the 13.5-minute row of 12 shards in CI without the
  served readers, plus its targeted documents. The served readers run by hand on GitHub's runners at
  the heads of pull requests 1, 2, 3, 4, 7, 9, 10 and 11 and once over the union at the top before the
  merge, never on the person's machine (§8.4).
- **The first nightly after the merge** is the whole lane with every reader over the merged stack,
  about 13.5 hours plus about half an hour for the new documents, so the merge is made Monday to Friday;
  its issue lists every failing group with its rerun line (§8.5, G8).

## The stack

One `gh stack` chain on the latest `origin/main`, cut after this plan's own pull request merges, each
pull request reviewed and undrafted, merged together for one deploy. Part 10 gives each pull request's
contents, files, register moves, cutover classes, lane cost and checks.

| # | Pull request | Parts |
|---|---|---|
| 1 | Lane mechanics: `_cheapest_edited`'s fallback to a control, identity moves scoped to the eight migration witnesses with their retained A, the capture's placement record hook (an empty list nothing applies), the `commtrackEnabled` verdict key, runs by hand naming a control, the cutover's pre-step fixtures and the facts `main` derives; no product code | 08, 09 |
| 2 | Attachment mode removed: the mode, its capability and probe, `attachmentSlots.ts`; defect 23's 79 moves; the fixtures' capture test deleted; `MODEL_CONTEXT_VERSION` `.2` | 01, 03, 07, 08 |
| 3 | Repeats: the query placement rule and both emissions, the held `placement` slot, whole-number counts and direct counts, Preview; defects 25 and 30 move; `RUNTIME_VERSION` 18; `.3` | 04, 07, 08 |
| 4 | Case writes as one concept: `Field.caseWrite` leaves; the own arm, writes, `worker-record`, `capture-link`, conditions, explicit preloads; placement shapes and held slots; `planPlacements`; `planFormCaseWire`'s basic and Save to Case arms; N1; defect 28 moves; `.4` | 01, 02, 03, 07, 08 |
| 5 | Held placements and identity moves: `holdPlacements`, the kernel rule's editor half, the held rules, `withIdentityMoves`, `IdentityMoveDialog`, undo and redo, `identityMoves` on the SA and MCP; `.5` | 01, 03, 04, 07, 08 |
| 6 | Publish placements: the `publish-placement` kind and its migration, recording before anything is sent, the head fence, the frame fold and conflict replay, the `save-to-case` offer, `publishedCaseBlocks`; the capture records the first publish's holds, its capture moved ahead of edit planning | 03, 07, 08 |
| 7 | Advanced modules and extension child cases: the advanced arm, `emittedModuleKind`, the held kind, HQ's JSON, tags, eligibility, `FORM_LINK_NEEDS_NEW_CASE_DATUM`; defect 24 moves; six targeted documents; `.7` | 02, 03, 07, 08 |
| 8 | CommTrack and same-type child links at publish: `commtrack-off` and its migration, `same-type-child-links` with `featureFlagsOff` and its offer, the `flagsOff` verdict key | 02, 03, 08 |
| 9 | Groups and labels: `group.fieldList`, `FIELD_LIST_USER_REPEAT`, `plainLabel`, the `plain-text` feature; defect 27 moves | 04, 08 |
| 10 | Search workflow, menu concepts and claims: `workflow`, `formsReadSearch`, `caseListMenuItem` beside forms, `caseListRegistrationForm`, claim rows, the five platform rows, the advanced menu item; defect 21 moves; `.10` | 05, 02, 07, 08 |
| 11 | Form links: the author's order emitted reversed, `Form.otherwise`, `this-form`, the guard, offered targets, Preview's stack, the after-submit surface; defect 26 moves; `OPEN_DEFECTS` `{}`; `.11` | 06, 07, 08 |
| 12 | Builder: the case changes, Saves to, This form's case, Show on one screen, Format text, the Rows editor | 07, 04 |
| 13 | Agent: the new authoring inputs, the final guide; `.13`, the deployed value; the billed schema check asked once; the `../nova-plugin` pull request opened beside it | 07 |
| 14 | Cutover: the scan and migrate scripts, the transform, the horizon migration, `catalog.ts`, the postconditions, the notice, the Job, the allowlist arm, the bundle, the runbook; the notice's two public passages | 09, 03 |
| 15 | Contracts and public docs; the timings; the plugin pull request's link; the maintenance image is built from this head | 10 |
| 16 | Removal of the cutover tooling and of this plan | 09, 10 |

**CI.** A stacked pull request never reads its base's records (`proof/ci/store-keys.mjs`), and pull
request 1 changes the observation's partition (`proof/store/queue.py`), so every pull request runs the
13.5-minute row of 12 shards on every push. A push to pull request k starts 17 − k lane runs: a push to
pull request 1, or cutting the stack, is 192 shard-jobs against about twenty concurrent runners, about
ninety minutes of the whole account, and over four hours while a scheduled lane with the readers holds
fourteen of them. So pull request 1 is settled on its own branch before the stack is cut (its lane, its
tests, G1's retention and its run by hand), a fix-up goes to the pull request it belongs in, a
session's pushes are batched into one, no restack is pushed while a scheduled reader lane runs, and the
reader runs by hand restack nothing (part 08 §8, part 10 house rules 4 and 5).

## The cutover

One direct maintenance cutover (`docs/architecture/contracts.md`), planned in full in part 09, in step
3's form. It reads Nova's database alone: no media bucket, no KMS key and no CommCare HQ state.

- **A fold horizon, the sixth identity.** Marker batch `fold-baseline:hq-round-trip-case-writes`,
  actor `system:hq-round-trip-case-writes`, one marker row and one baseline snapshot per app, deleted
  apps included, because every strict fold would fail on the keys step 5 removes and the synthetic
  writer loads its source through the head schema (part 09 §1).
- **One Job of its own**, `commcare-nova-hq-round-trip-case-writes`, whose stored arguments are its dry
  run; its allowlist arm admits only `--settle-holders` and `--execute --expect-plan-digest <64 hex>`, so
  an execute run refuses any plan but the one the dry run printed; timeout `7200s` unless the advisory
  dry run's duration raises it (part 09 §18, G3). The maintenance image is built by hand from pull
  request 15's head, and `main` is frozen from the image build to the merge.
- **The transform, in order.** A raw read of each app's carriers; five structure steps over raw JSON
  (`renamed-concepts`, `capture-link-writes`, `close-condition-expression`, `field-writes-lifted`,
  `search-first-lifted`); the head parse; nine semantic steps through production planners
  (`writes-into-operations` with C9 to C11, `form-link-semantics`, `extension-children`,
  `explicit-preloads`, `search-workflow`, `query-repeat-placement`, `repeat-counts`,
  `field-list-flags`, `placements`); `judge-target` (schema, gate, export readiness, an unchanged case
  store, idempotence); and `deployment-lines`. Every identity is derived, so the dry run and the
  execute run build one plan (part 09 §7, §10).
- **Published placements.** A unit is held at the placement today's emission gave it, computed by the
  frozen classifier, where a readable published baseline carries a block at that identity
  (`publishedCaseBlocks`) or where a published deployment's baseline is unread; carried creates, forms
  of a module made advanced, query repeats moving to the count placement and the classes of part 09
  §8.5 are never held. The classifier is checked against production's own baselines before the window
  (part 09 §8, G6).
- **The ledger.** Three migrations apply in one phase inside the fleet transaction before the first app
  is written: `20261110000000_hq_round_trip_case_writes_publish_placement`,
  `20261110010000_hq_round_trip_case_writes_commtrack_confirmation` and
  `20261110020000_hq_round_trip_case_writes_fold_horizon`; any other pending set stops with nothing
  written (part 09 §11).
- **The fleet transaction** locks every app and design session, archives mutation events, clears
  streams, discards private agent work, writes each app, writes the notices, and checks its
  postconditions inside, every catalog read naming its relation through `catalog.ts`; any failure rolls
  back everything, the DDL with it (part 09 §13 to §15).
- **Blockers**: `renamed-concept-conflict`, `own-close-in-repeat` and `baseline-unreadable` with their
  remedies, the stack's own defects (`structure-parse`, `transform-admission`,
  `placement-path-mismatch`, `target-parse`, `case-schema-unplanned`, `not-idempotent`), and the
  target's gate and export findings, among them three by rule (a query repeat reading its own rows, a
  query repeat condition that stops type-checking at the row, and under part 02's G4 outcome B an
  underscore worker property). The advisory dry run counts each, and each is resolved before the window
  (part 09 §16).
- **A notice on every affected app**, cutover `hq-round-trip-case-writes`, its lead "On ${day}, Nova
  changed how it stores what forms save to cases, where workers go after a form, and how some questions
  are counted and shown. Here is what that means for this app.", seventeen document reasons, three new
  deployment reasons (`placements-kept-unread`, `form-data-paths-move`, `case-attachments-stop`),
  `next-publish-asks-more` extended with `commtrack-off` and `same-type-child-links`, and the reused
  `unsaved-assistant-work-discarded` and `deep-links-need-republish` (part 09 §17).
- **Private work is discarded** with its notice, as step 3's cutover did, because staged batches carry
  payloads the head schema refuses; the horizon also ends every App Test in flight at its next step.
  There is no announcement: Nova is dogfooded by its author (part 09 decisions 8, 14, 17).
- **The case store is untouched in the window.** Every planned schema difference (each app's
  `commcare-case-claim` row, link-written capture properties, derivation drift) is counted by the dry
  run and written after the deploy, before ingress reopens, by the existing drift writer through
  `commcare-nova-case-type-schema-retirement`, and the drift scan must then read zero (part 09 §12, G7).
- **The window** takes about two hours thirty minutes plus twice the advisory dry run's duration; the
  advisory dry run is at most three days old when it opens. Before the commit, rollback is the
  transaction's; after it and before the merge, the restore point; once the deploy starts, only forward
  (part 09 §20).
- **Pull request 16** removes the scripts, the tooling, the Job contract, the allowlist arm, the bundle
  line, the runbook and this plan. The three migrations, `lib/domain/caseWriteOperationIdentity.ts`, the
  `lib/doc` planners the fuzz mapping and step 6 read, the notice's copy, each app's fold-baseline row,
  `publishedCaseBlocks`, the witnesses' reads, the two docs sentences and the evidence prefix stay (part
  09 §22).

## Contracts

Part 10 gives each sentence as it reads today and its replacement, each in the pull request whose
behavior makes it false. In brief:

- The root `CLAUDE.md`: mental model 3 names the identities a publish records (where HQ keeps each
  case change and query repeat, and which menus it holds as advanced); the `lib/db` row adds
  `publish-placement` to the kinds that feed multiplayer; the `lib/deployment` row says a publish
  records placements before anything is sent (§7.2, pull request 6).
- `docs/architecture/contracts.md` (pull request 15): the kind set gains `publish-placement`, the
  collaboration frame folds it keeping undo, the field bullet says a form writes case data only through
  its case operations, the attachment bullet becomes "A captured file reaches a case only as a link",
  "HQ deployment safety" gains a held-placement bullet with the undo clause, and the submission
  envelope holds the operations in array order (§7.3).
- `docs/architecture/complex-apps.md` (pull request 15): the case-write sections, the worker's record,
  "The search workflow", registration from the case list, claims, captures as `capture-link`,
  after-submit links, form sections, counted repeats, extension cases, and a new "Advanced modules"
  section (§7.4).
- Every subtree contract moves with its behavior: `lib/commcare/CLAUDE.md` (the capability list, the
  `commtrackReasons` paragraph, `count_bound` and `query_bound`, markdown itext, field lists, the
  case-management scaffolding, a new "Advanced modules" section, the search shapes),
  `lib/domain/CLAUDE.md` and `lib/domain/expression/CLAUDE.md`, `lib/doc/CLAUDE.md`, `lib/db/CLAUDE.md`
  (the kinds, the kernel rule, five confirmation kinds, the sixth fold identity), `lib/collab/CLAUDE.md`,
  `lib/db/types.ts`' comment, `lib/deployment/CLAUDE.md` (a new "Placements" section, `commtrack-off`,
  the unread rule), `lib/export/CLAUDE.md`, `lib/case-store/CLAUDE.md` (the submission, claims as rows,
  extension edges), the Preview, App Tests, session and routing contracts, and part 07's rows for the
  builder and agent contracts (§7.5 to §7.10). Three research rows `main` already makes false are
  recorded as claims corrected (§7.1).
- The public docs, in Nova's voice, in pull request 15 with one recorded exception (the notice's two
  passages, in pull request 14): `case-changes.mdx` (This form's case, where CommCare HQ keeps each
  change, a link that opens the case it creates), `attachments.mdx`, `publishing.mdx`,
  `project-space-compatibility.mdx`, `building-with-nova.mdx`, `form-sections.mdx`, `form-links.mdx`,
  `case-workspace.mdx` (When this menu opens, The case list in the menu), `where-workers-use-your-app.mdx`,
  `nested-menus.mdx` and `mcp/tools.mdx` (§8). No sentence names a private HQ flag.
- `proof/README.md` and `proof/CLAUDE.md`, each in the pull request that makes the old text false;
  `harness-findings.md`, "Found while planning step 5", in this plan's pull request, each gated bullet
  completed in its run's pull request (§9).
- `docs/plans/hq-round-trip/README.md`: step 5 "planned in full" in this plan's pull request, its register
  sentence in 15, and "Step 5 is done" in 16 (§9).
- `../nova-plugin` (read at `105836d`): `skills/upload_to_hq/SKILL.md` and the README hold the sentences
  step 5 makes false; one pull request, opened beside pull request 13 after a re-sweep by claim, bumps
  `plugin.json` to `2.4.0` and merges only after the deploy is live (§10, part 07 §6).

## Exit

Each row is checked by a machine after the merge, from `main`, the first nightly and production's
read-only evidence (part 10 §11).

- `proof/known-defects.json` is `[]`, `proof/fixed-defects.json` holds 1,017 entries (and any a §2.6
  run added, each on its control), `OPEN_DEFECTS` is `{}`, and every fixed entry shows on its control
  and on no document.
- Proofs 1 to 5 pass on every Nova export, including a republish after each migration: every corpus
  document, the eight witnesses among them, passes the bar, intent, manifest, configuration sensitivity
  and proofs 1 to 5, and proof 1 accepts each identity move only on the witnesses it is scoped to.
- The corpus holds 431 documents (430 under part 02's G4 outcome B), 108 controls, 25 walk stops or as
  part 08's G2 left them, and eight directories under `proof/migrations/`.
- A held placement holds: emission of a document equals emission with its derived placements held, no
  payload but `holdPlacements` writes a held slot, and the kernel refuses an editor's hold of a
  placement that can still express its target.
- Every platform difference step 5 adds is a row with its evidence, held by `platformFeatures.test.ts`,
  `platformCells.test.ts` and `platformOfferParity.test.ts`.
- Every existing app migrated, deleted ones included, has exactly one
  `fold-baseline:hq-round-trip-case-writes` row and its notice; `kysely_migration` holds the three
  migrations; the deploy's runtime probe found nothing; the counted case-schema drift was written and
  none remains.
- `MODEL_CONTEXT_VERSION` is `"v6-hq-round-trip-case-writes.13"`, `RUNTIME_VERSION` 18,
  `scripts/test-schema.ts` holds 61 entries, the billed check passed for every tool it named, every
  served schema compiles, and no public surface names a private HQ flag.
- No file names this plan or its runbook, `docs/plans/hq-round-trip/` holds the README and the step 6
  and 7 outlines, the README reads step 5 done, no cutover tool, Job contract or allowlist arm remains,
  and the `../nova-plugin` pull request is merged.
- The first nightly over `main` after the deploy, the whole lane with every reader over the merged
  stack, holds.
