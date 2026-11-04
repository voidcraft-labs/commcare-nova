# Step 5, part 09: The cutover, its notice and its runbook

Part of [step 5's plan](../5-case-writes-forms-navigation.md) ("Case writes, forms and navigation"),
which holds the baseline, the decisions, the stack and the exit. This part plans pull request 14, the
cutover, and pull request 16, the removal of its tooling and of this plan, in full. It also plans the
three things the cutover needs earlier in the stack: the pre-step fixtures and the facts `main`'s own
code derives from them, committed in pull request 1 beside part 08's migration witnesses; the deletion
of their capture test in pull request 2, the first pull request that changes a stored shape; and the
identity module of operations made from field writes, which pull request 4 adds with part 01's model.

Citations are `path::symbol` for Nova at `main` `2f985ed6` (#825, step 4's fifteen pull requests merged
and its cutover run on production). Nova's own history is read with `git show` at `733dd193` (#789, step
3's cutover, whose fold horizon this cutover follows), `a8af778e` (#823, step 4's cutover, squashed with
its postcondition fix `93aef6232a`) and `2f985ed6^` (step 4's runbook as it ran). CommCare is read in the
checkouts at the pins `proof/pins.json` names, unchanged since step 2: commcare-hq `d6c6e16d8ae1` (paths
under `corehq/apps/app_manager/` unless rooted at `corehq/`), commcare-core `8e9ba8d908e9`,
commcare-android `7a5584475580`, formplayer `24383ac71bfb`, commcare-connect `046c7fd78081` and Vellum
`01215f251c57`. This part makes four CommCare claims of its own (section 2); every placement, link,
repeat and search fact is another part's, cited there. At `main`, `lib/models.ts::MODEL_CONTEXT_VERSION`
is `"v5-hq-round-trip-platforms.12"` and `lib/db/appTests.ts::RUNTIME_VERSION` is `17`; the cutover moves
neither (decision 14 of step 5's plan).

Pull request numbers are the stack's: 1 lane mechanics, 2 attachment mode removed, 3 repeats, 4 case
writes as one concept, 5 held placements and identity moves, 6 publish placements, 7 advanced modules and
extension child cases, 8 CommTrack and same-type child links at publish, 9 groups and labels, 10 search
workflow, menu concepts and claims, 11 form links, 12 builder, 13 agent, 14 cutover, 15 contracts and
public docs, 16 removal of the cutover tooling and of this plan. Parts are named by file number: 01 case
writes, 02 advanced and extension, 03 publish and ledger, 04 questions, 05 search and menus, 06 form
links, 07 authoring, 08 proof, 10 the stack and contracts.

One production read informs this part: the content-free, read-only scan of decision 16, run during
planning with the person's yes. No count from it enters the plan. Each choice it decided is stated as
the plan, in words, at its place (section 19 lists them). Where it met nothing but an author can still
make the shape before the window, the class ships, production holds none today, and the advisory dry run
counts it. Where it counted nothing, both outcomes stand and the advisory dry run decides between them.

| Section | Owns | Pull request |
|---|---|---|
| 1 | why a fold horizon | 14 |
| 2 | the CommCare facts the migration and its copy rely on | 14 |
| 3 | what else holds state the cutover touches | 14 |
| 4 | the write path | 14 |
| 5 | the pre-step fixtures, main's facts and the frozen copies | 1, 2, 14 |
| 6 | scripts, layout, arguments, already applied | 14 |
| 7 | the transform, in order | 4, 14 |
| 8 | published placements | 14 |
| 9 | deployment lines | 14 |
| 10 | derived identities, the plan, its digest and the report | 4, 14 |
| 11 | the ledger in the window | 14 |
| 12 | the case store | 14 |
| 13 | the fleet transaction, step by step | 14 |
| 14 | postconditions | 14 |
| 15 | `catalog.ts` and the heap-order test | 14 |
| 16 | the blockers | 14 |
| 17 | the notice | 14 |
| 18 | where it runs: the Job, the allowlist arm, the bundle | 14 |
| 19 | the production scan and what it decides | planning |
| 20 | the runbook | 14 |
| 21 | decided follow-ups: old app-test namespaces, step 4's postcondition fix, the review rule | 14 |
| 22 | the removal and the cutover's trace | 16 |

**This part is the registry.** The cutover id, the fold identity, the step ids, the change kinds, the
blocker codes, the stop codes, the deployment causes, the notice reasons with their `detail` keys and
copy, the Job, the tool and the ledger migration names below are spelled once here; other parts use
these strings verbatim. The names of code another pull request lands are that part's, cited here.

---

## Decisions in brief

1. **A fold horizon, the sixth identity.** Marker batch `fold-baseline:hq-round-trip-case-writes`, actor
   `system:hq-round-trip-case-writes`, cutover id `hq-round-trip-case-writes`: one marker row and one
   baseline snapshot per app, deleted apps included. Step 5 removes stored keys that every earlier
   document and many history rows hold, so neither a `blueprint-migration` batch nor a suffix rewrite is
   possible (section 1).
2. **Step 3's form** (decision 12 of step 5's plan): a raw read of each app's persisted carriers, a
   structure phase over raw JSON, the head parse, a semantics phase of production planners over the
   parsed document, and step 3's `writeApp`. Held placements enter each app as part of its whole migrated
   document and its baseline snapshot, never as mutations (sections 4 and 7).
3. **The transform is production code plus the cutover's own steps.** The planners the fuzz mapping
   also calls, and part 06's link map, live in `lib/doc` and stay after pull request 16
   (`operationsFromFieldWrites`, `planExplicitPreloads`, `planRepeatCountWraps`, `planGroupFieldLists`,
   `authoredSearchWorkflow`, `mapFormLinkSemantics`). The cutover's own code is the structure steps, the close-condition lift, the
   three own-case classes C9 to C11, the extension placement and retarget, the placement step, the
   judgement and the deployment lines (section 7).
4. **The old shape is held by fixtures captured while `main` admits them.** Pull request 1 commits each
   pre-step fixture with the facts `main`'s own code derives from it (`facts.json`: each unit's
   placement, each field's preload, each group's label, each search's wire shape). Pull request 2
   deletes the capture test with the code it compares against; the fixtures and facts stay under a
   digest test until pull request 16. Every frozen copy the cutover carries is tested against those
   facts (section 5).
5. **Published means reached `uploaded` with a live app mapping** (`superseded_at` null; a mapping marked
   missing on CommCare HQ still counts, part 03), read from its drift baseline (section 8.1).
6. **A unit is held at the placement today's emission gives it** (computed by the frozen classifier),
   where a readable baseline of a published deployment carries a block at that placement's identity
   (`lib/commcare/hq/publishedCaseBlocks.ts::publishedCaseBlocks`, part 03), or for every unit that
   placement can still express where a published deployment's baseline is `unread` (decision 5 of step
   5's plan, deployment reason `placements-kept-unread`; production holds such a deployment, so the rule
   applies at the window). A stored baseline whose bytes fail gunzip, their digest or their parse is the
   blocker `baseline-unreadable`, repaired by refreshing that deployment; production holds none today.
   Creates a link carries, of any relationship, forms of a module made advanced, query repeats the rule
   gives the count placement and the other classes of section 8.5 are never held (section 8).
7. **The frozen classifier is checked on production.** Where a published deployment's pushed revision
   equals the app's head, its readable baseline must carry every unit at the placement the frozen
   classifier gives; the dry run counts every difference, and the runbook settles each before the window
   (section 8.6, gated run G6).
8. **Private agent work is discarded and mutation events archived**, as step 3's cutover did, because
   staged batches and event rows carry mutation payloads the head schema refuses; each app that had any
   gets `unsaved-assistant-work-discarded` (section 3).
9. **Three ledgered migrations, one phase**, inside the fleet transaction before the first app is
   written (decision 11 of step 5's plan; section 11).
10. **The fleet transaction writes no case schema row.** The planned schema differences (each app's
    `commcare-case-claim` row, link-written capture properties, derivation drift) converge through the
    existing drift writer after the deploy and before ingress reopens; any other difference is the
    blocker `case-schema-unplanned` (section 12). *Departure* from the search-and-menus brief's M6, which
    materialized the claim row inside the cutover; part 05's M6 adopts it.
11. **Every catalog read names its relation**, through one module, `catalog.ts`, whose Postgres test
    reproduces the heap order behind step 4's postcondition fix (sections 15 and 21.2).
12. **Its own Job**, `commcare-nova-hq-round-trip-case-writes`, whose stored arguments are its dry run; no
    media bucket, no KMS key, no CommCare HQ read (section 18).
13. **The notice** gains cutover `hq-round-trip-case-writes`, its lead, eighteen document reasons
    (decision 13's sixteen, which hold C9's `form-became-close-form`, part 06's `form-link-removed` and the
    stored capture reads' `capture-saves-link-not-name`, section 7.4) and three
    deployment reasons, extends
    `next-publish-asks-more` with `commtrack-off` and `same-type-child-links`, and reuses `unsaved-assistant-work-discarded` and `deep-links-need-republish` (section 17).
14. **No version of its own.** Pull request 3 moves `RUNTIME_VERSION` to 18 and the authoring pull
    requests move `MODEL_CONTEXT_VERSION`; the horizon's `+1` also ends every App Test in flight at its
    next step ("The app changed since this test began. Start a new test of the saved app.").
15. **The review rule.** A fix made after the cutover pull request's review, during the advisory runs or
    the window, lands as its own commit with its own `/code-review medium` over that commit, findings
    fixed, before `gh stack merge`; ingress never reopens on an unreviewed fix (section 21.3).
16. **Old app-test namespaces: no work** (section 21.1).
17. **No announcement step**: Nova is dogfooded by its own author.

---

## 1. Why a fold horizon

Every canonical fold strictly parses its baseline and every mutation it replays
(`lib/db/canonicalMutationFold.ts::foldSuffixCore` parses `app_change_fold_baselines.snapshot` with
`blueprintDocSchema`; `lib/db/persistedJson.ts::parsePersistedAppChangeEnvelope` parses each row's
mutations with `mutationSchema`). Step 5 changes the stored shape incompatibly, and every one of these
changes lands in a strict object:

- a capture write's `mode` and then every field's `caseWrite` leave the field schemas (pull requests 2
  and 4, part 01 §3.1);
- the structured `Form.closeCondition` (`{field, answer, operator}`) becomes an `Expression` (pull request
  4, part 01 §3.5);
- `Form.entry`, `Module.caseListOnly` and `caseSearchConfig.searchFirst` are replaced by
  `Module.caseListRegistrationForm`, `Module.caseListMenuItem`, `caseSearchConfig.workflow` and
  `formsReadSearch` (pull request 10, part 05 §3, §8, §9);
- a stored `postSubmit` beside links and an overlapping link list change meaning (pull request 11, part
  06 §3).

`formSchema`, `moduleSchema`, every field kind and the ordinary search arm are `z.strictObject`, so every
immutable fold baseline that holds one of those keys fails the parse, and so does every `app_changes` row
whose mutations carry one (`updateField` with `caseWrite`, `updateForm` with `entry` or the old
`closeCondition`, `updateModule` with `caseListOnly` or `searchFirst`, the case-operation change and form
link kinds). A `blueprint-migration` batch is impossible, because the synthetic writer
(`lib/db/apps.ts::appendSyntheticBatchInTransaction`) loads its source through the strict head schema. A
suffix rewrite is rejected for step 2's and step 3's reasons (`lib/db/CLAUDE.md`, "Advancing the fold
horizon"): it would rewrite every changed mutation kind and every recorded snapshot digest, and moving a
historical field write into an operation needs the form as it stood at that row. So the contract's other
route is taken (`docs/architecture/contracts.md`, "Valid by construction"): one explicit horizon per app.

**The DDL.** Migration `20261110020000_hq_round_trip_case_writes_fold_horizon` (pull request 14),
registered in `lib/case-store/migrations/index.ts` as
`"20261110020000_hq_round_trip_case_writes_fold_horizon": hqRoundTripCaseWritesFoldHorizon`. Its `up` runs
`CREATE OR REPLACE FUNCTION public.nova_admit_app_change_fold_baseline_insert()` and `CREATE OR REPLACE
FUNCTION public.nova_require_app_change_fold_baseline()`, each body copied whole from
`lib/case-store/migrations/20261020000000_hq_round_trip_expressions_fold_horizon.ts` with one more operator
arm after the `hq-round-trip-expressions` arm:

```sql
OR (marker.batch_id = 'fold-baseline:hq-round-trip-case-writes'
    AND marker.actor_id = 'system:hq-round-trip-case-writes')
```

and the same over `NEW.batch_id` / `NEW.actor_id` in `nova_require_app_change_fold_baseline`. Both names
are schema-qualified (`public.`), unlike the step 3 migration's, so no search path can shadow them; every
other check of both bodies stays as it is. `CREATE OR REPLACE` keeps each function's oid, owner, ACL and
trigger, so `lib/db/privilegeConvergence.ts` needs no change. Its `down` throws: "This migration is
forward-only: the case-writes fold horizon is history every app now starts from."

No pull request of the stack adds an `apps` root column (every new slot is entity data or optional inside
an existing column), so `nova_current_app_change_fold_snapshot` keeps its definition from
`20261015030000_app_settings.ts`. A pull request that adds one replaces that function in its own
migration, as `20261015030000_app_settings.ts` did, and joins section 11's table.

`lib/db/CLAUDE.md` (pull request 14): "accepts exactly five identities" becomes "accepts exactly six
identities", the list gains "and the paired `fold-baseline:hq-round-trip-case-writes` /
`system:hq-round-trip-case-writes` operator cutover", "each of the last two starting each app from the
document its transform yields" becomes "each of the last three …", and a paragraph follows the
`hq-round-trip-platforms` paragraph: "The `hq-round-trip-case-writes` horizon takes the
`hq-round-trip-expressions` horizon's route: a field's case write (with a capture's attachment mode), a
form's no-matches entry, a module's case-list flag and Search first are keys the head schema no longer
holds, and a form's structured close condition is a shape it no longer parses, so no earlier document
parses and no earlier mutation that carries one replays; each app starts from its
`fold-baseline:hq-round-trip-case-writes` row." Part 10 §7.7 carries the same sentence.

## 2. What CommCare does at the pins (only what the migration and its copy rely on)

1. **A basic subcase's path and datum follow its position in `actions.subcases`, inert ones included.**
   `models/form_actions.py::OpenSubCaseAction.form_element_name` is `'subcase_{}'.format(self.id)`, the
   `IndexedSchema` index (`models/base.py::IndexedSchema.with_id`), and
   `models/forms.py::FormBase.session_var_for_action` uses `self.actions.subcases.index(action)`, plus one
   when the form opens a case. Both count a `never` subcase, so removing today's inert extension subcase
   moves every later basic subcase's `subcase_<i>` node and its `case_id_new_<type>_<i>` datum (the
   deployment cause `subcase-renumbered`, section 9). `xform.py::XForm._create_casexml` nests a subcase
   under `subcase_<i>` only where its repeat context holds more than one
   (`count_subcases_per_repeat_context`, `nest = repeat_context_count[...] > 1`).
2. **HQ's build refuses `previous` after submit beside inline search (and where a menu's and its
   parent's multi-select differ), never beside non-inline search first.**
   `helpers/validators.py::FormBaseValidator.validate_for_module`'s `WORKFLOW_PREVIOUS` arm appends
   `mismatch multi select form links` where `module.is_multi_select() ^
   module.root_module.is_multi_select()`, and `workflow previous inline search` where
   `self.form.requires_case() and module_uses_inline_search(module)`; `util.py::module_uses_inline_search`
   requires `module_offers_search`, `inline_search` and `auto_launch`. Moving a menu from the case list
   first to search first changes no multi-select setting. So moving a list-first menu to the non-inline
   search first keeps every stored `postSubmit: "previous"` and every built-in otherwise of `previous`
   admissible at HQ.
3. **HQ's editor retires the case list first beside search.** `corehq/toggles/__init__.py::
   CASE_SEARCH_DEPRECATED_NORMAL_CASE_LIST` is a `StaticToggle` tagged `TAG_DEPRECATED` under
   `SYNC_SEARCH_CASE_CLAIM`. The notice states only that CommCare HQ no longer offers the case list first
   for a menu that searches in Web Apps (part 05 §2.1 holds the editor's behavior).
4. **An attachment block does nothing without `MM_CASE_PROPERTIES`.**
   `corehq/form_processor/backends/sql/update_strategy.py::SqlCaseUpdateStrategy._apply_attachments_action`
   returns at once when `toggles.MM_CASE_PROPERTIES.enabled(self.case.domain)` is false. So a project space
   whose app published an attachment-mode write either has the flag (the case's attachment keeps its last
   file) or never stored one; `case-attachments-stop` reads true in both (section 17).

**Claims corrected.** The cutover brief cited the `previous` refusal as
`FormBaseValidator.validate_post_form_workflow`; at the pin the arm is in
`FormBaseValidator.validate_for_module` (read in place). The outline and the brief spoke of "the
publish-placement kind CHECK"; there is none: `app_changes.kind` is closed by the trigger function
`nova_admit_app_change_insert()`, which part 03's migration replaces.

## 3. What else holds state the cutover touches

| Holder | Today | The cutover |
|---|---|---|
| Open builder tabs | a `fold-baseline` row in a stream suffix makes the stream route answer `reload` (`lib/agent/change-set/baseLoader.ts::greatestFoldBaselineSeq`); `NEXT_DEPLOYMENT_ID` reloads a stale client | nothing new: ingress is closed through the window, and every tab reloads into the migrated app |
| Private agent work: open `authoring_workspaces`, `authoring_sessions.active_candidate_id`, open `design_change_sets` | staged steps in step 4's dialect | abandoned and cleared by step 3's statements (step `private-work`, section 13); each app that had any gets `unsaved-assistant-work-discarded`. Part 07 adds no tool sentence for work begun before the cutover |
| Pre-app build sessions holding open work | old-dialect genesis steps | ended through `lib/db/designSessions.ts::abandonPreAppDesignSessionInTransaction`, exported for the cutover's lifetime; no notice (no app) |
| `events` rows of kind `mutation` | `lib/log/types.ts::mutationEventSchema` embeds `mutationSchema` | archived to kind `archived-mutation` by step 3's statement (`733dd193:scripts/lib/hqRoundTripExpressions/writer.ts`, step `archive-events`) |
| `chat_stream_chunks`, `presence`, `threads.active_*` | stream holders | cleared (step `clear-streams`) |
| Run leases, paused runs, unsettled reservations | `apps` lease columns, `design_sessions` | settled by `--settle-holders` through `lib/db/apps.ts::reapStaleRun` and `lib/db/designSessions.ts::reapStaleDesignSessionRun` (exported for the cutover's lifetime, returning `Promise<StaleRunReapOutcome \| "failed">` as #789 and #823 did); any left stops the write (`holder`) |
| Actor generation gates | `lib/db/actorGenerationGate.ts` | not taken: the fleet transaction claims, settles and releases no holder, and with ingress closed no lifecycle path runs (step 4's reasoning) |
| App Tests | runtime 17 at `main`, 18 from pull request 3 | nothing: the horizon's `+1` refuses every running test at its next step; `finish` still disposes |
| App-test namespaces | copies of eleven tables with their checks | nothing (section 21.1) |
| Retained App Test sessions holding `claimedCaseIds` | runtime 17 | nothing: part 05 §10.8 (no M7); `retainedState.ts` drops the stored key |
| Entry-point manifests | refused when their `sourceSequence` differs from the app's | `deep-links-need-republish` on every live deployment of an app with entry points (section 9) |
| Deployment ledger (deployments, resources, baselines, identities, confirmations) | Nova's own and HQ's reads | read, never written. The `commtrack-off` kind is admitted by the window's DDL; no confirmation row is written, because a person's answer cannot be made up and the next publish asks |
| `case_type_schemas`, expression indexes | equal `main`'s derivation (runbook step 1(a)) | never written by the fleet transaction; the planned differences converge after the deploy (section 12) |
| `cases`, `parked_case_values`, `case_indices` | case rows | never written. No class changes a stored row: an extension edge is already stored as `extension` (`lib/case-store/CLAUDE.md`, the envelope persists the authored relationship), and a claim is a new row a later claim writes |
| Lookup, location and media reference edges | kernel-maintained | rewritten per app by `writeApp` through the kernel's own functions |
| Staged captures, in-flight submissions | fenced by path and `app_mutation_seq` | nothing; a staged capture of the old sequence is refused at submit |

## 4. The write path

The writer is step 3's `writeApp` (`733dd193:scripts/lib/hqRoundTripExpressions/writer.ts::writeApp`),
copied, with this cutover's marker pair. Per app, in code-point order of id, inside the fleet
transaction:

1. `lookupContextForAuthoritativeWrite(tx, projectId, extractLookupReferenceTargets(target))`.
2. `UPDATE apps SET ...denormalize(toPersistableDoc(target)), mutation_seq = baseSeq + 1 WHERE id = appId`
   (`updated_at` left as it stood: nobody edited the app).
3. `DELETE FROM blueprint_entities WHERE app_id = appId`, then one insert of
   `lib/db/blueprintRows.ts::decomposeBlueprint(toPersistableDoc(target))`.
4. `replaceExactMediaReferencesForApp(tx, { appId, projectId, candidateDoc: target })`,
   `replaceLookupReferenceEdges(tx, { appId, projectId, targets })`,
   `applyOrganizationCommitIntegrity(tx, { appId, previousDoc: target, candidateDoc: target })` (no class
   changes an organization level, location property or place).
5. `INSERT INTO app_changes (app_id, seq, batch_id, run_id, actor_id, kind, mutations, from_project_id,
   to_project_id) VALUES (appId, baseSeq + 1, 'fold-baseline:hq-round-trip-case-writes', NULL,
   'system:hq-round-trip-case-writes', 'fold-baseline', '[]', NULL, NULL)`.
6. `INSERT INTO app_change_fold_baselines (app_id, seq, project_id, snapshot, snapshot_digest) SELECT
   app.id, baseSeq + 1, app.project_id, current.snapshot, nova_app_change_fold_snapshot_digest(current.snapshot)
   FROM apps AS app, LATERAL (SELECT nova_current_app_change_fold_snapshot(app.id) AS snapshot) AS current
   WHERE app.id = appId`.

Why not the synthetic writer: its source load is the strict head parse, which no stored app passes
(section 1). Why holds ride the document: part 03's kernel rule (`lib/db/placementAuthority.ts::
placementChangeRefusal`) governs mutation batches; a horizon writes no batch, and decision 12 of step 5's
plan makes every hold the cutover records part of the baseline snapshot. `lib/db/__tests__/
runHolderWriteGuard.test.ts`'s allowlist of `apps` writers gains `scripts/lib/hqRoundTripCaseWrites/
writer.ts` for the cutover's lifetime (step 3 added its writer the same way), and pull request 16 removes
it.

## 5. The pre-step fixtures, main's facts and the frozen copies

### 5.1 Why fixtures, and why in pull request 1

The cutover's tests must hold documents in the shape `main` stores, admitted by `main`'s schema and gate,
and the answers `main`'s own code gives about them (where each case write lands, which writer `main`
preloads, which group label shows, which search shape `main` emits). Once a pull request of the stack
changes those shapes or that code, neither can be produced again. So pull request 1, which changes no
stored shape, commits them (with part 08, whose witnesses are the first eight); `git diff --stat
2f985ed6..<1> -- lib app ':(exclude,glob)**/__tests__/**'` names no file of the cutover's (runbook check 5).
This departs from step 4 (whose sources parsed at the head) and follows step 3's pull request 2.

### 5.2 The fixtures (pull request 1)

`scripts/lib/hqRoundTripCaseWrites/__tests__/fixtures/pre-step/<id>.json`, each the stored document
(`toPersistableDoc`) of an app `main` admits, with explicit identities:

| Fixture | Source | Holds (the classes of section 7 it feeds) |
|---|---|---|
| `targeted-migration-search-workflow` | part 08 §5.2, the emitted `document.json` | M1 to M5 of part 05 |
| `targeted-migration-case-writes` | same | C1 to C3, C6 (on close form Close, its static-select close condition), C8 (with close form Close in repeat, whose close condition reads a question in a repeat), the several-case wrapper, and C9's writeless arm: the follow-up Discharge holds a conditional `close` operation on its own case with no writes (the shape the scan found in production), migrated to a close form whose close condition is the operation's, the operation removed, and its own close held through `Form.ownClosePlacement` at the removed operation's path. C9's arms holding writes and under `forEach` are `pre-step-own-close-operation`'s |
| `targeted-migration-attachment` | same | C4, C5 |
| `targeted-migration-extension-children` | same | M1 to M3 of part 02, C2's extension buckets |
| `targeted-migration-query-repeats` | same | Q1 |
| `targeted-migration-form-links` | same | L1 to L4, in an app declared for both platforms |
| `targeted-migration-groups-preloads` | same | Q4, C7 |
| `targeted-migration-repeat-counts` | same | Q2, Q3 |
| `pre-step-own-close-operation` | this part, `buildDoc` | C9: a follow-up holding a `close` operation on `session` with a condition and no writes; a second follow-up whose session `close` operation holds two writes; a third whose session `close` operation runs under `forEach` (section 7.4's `own-close-in-repeat`); a close form with a structured close condition and a session `close` operation (section 7.4). Part 08's case-writes witness holds only the first arm |
| `pre-step-duplicate-own-write` | this part | C10: a follow-up whose `update` operation on `session` writes `review_status`, which a field also writes |
| `pre-step-registration-updates-own` | this part | C11: a registration whose `update` operation's target is an `expression` reading a Hidden Value `new_id` that calculates the `new-case` datum |
| `pre-step-renamed-concepts` | this part | M2 and M3 (`caseListOnly` true and false), M4 (a case list icon on a module without `caseListOnly`), M5 with a target language whose overlay holds the no-matches form's label |
| `pre-step-search-results` | this part | part 05 M1's last row: a search with no visible field and no effective filter in an app declaring both |
| `pre-step-otherwise-unoffered` | this part | L3, L5 and L6: a several-case form with a conditional link and a stored `postSubmit` that `main` admits beside links only through `postSubmitDestinationsAdmitted`'s several-case waiver, which the head's `otherwiseDestinationsOffered` does not offer (L3, L6); and a form in child menu Household members whose link to child menu Member notes carries the parent menu's selected household, datums on a menu link as `main` admits (L5). The form-links witness holds neither shape: `main`'s export of the L5 link shows a refused manifest use and HQ's form settings save drops the L6 fallback, which would need a live register entry |
| `pre-step-preload-readers` | this part | C7's `load-time-value-reads-case`: a later Hidden Value default and a query repeat's ids query reading a preloaded writer |

`fixtures/pre-step/digests.json` maps each file to its `canonicalJsonDigest`.

### 5.3 The facts `main` derives (pull request 1)

`fixtures/pre-step/facts.json`, written by the capture test under `main`'s code and committed:

```ts
interface PreStepFacts {
	readonly format: "hq-round-trip-case-writes-pre-step-facts-1";
	readonly fixtures: Readonly<Record<string, {
		/** Every case block main's emission writes, per form: the unit it carries and where. */
		readonly placements: readonly {
			readonly formUuid: Uuid;
			/** `own`, `usercase`, `child:<caseType>:<repeat uuid|root>`, `extension:<caseType>:<repeat uuid|root>`,
			 *  `operation:<uuid>`, `own-close`, `query-repeat:<field uuid>`. */
			readonly unit: string;
			/** main's emitted identity: `basic-own`, `basic-usercase`, `basic-subcase:<index>`,
			 *  `basic-subcase-row`, `save-to-case:<repeat uuid|root>:<path joined by />`, `model-iteration:<item path>`. */
			readonly emitted: string;
		}[];
		/** Field uuids main's `writerPreloadsFromLoadedCase` preloads, per form. */
		readonly preloadedWriters: Readonly<Record<Uuid, readonly Uuid[]>>;
		/** Group uuids whose label main's `groupLabelShows` holds. */
		readonly labelledGroups: readonly Uuid[];
		/** Per module with a search: main's `searchWireShape` arm. */
		readonly searchShapes: Readonly<Record<Uuid, "search-first" | "skip-to-results" | "list-first">>;
	}>>;
}
```

The capture test reads them from `main`'s own functions: `lib/domain/caseWriteInventory.ts::
deriveCaseWriteInventory` with `lib/commcare/subcaseWire.ts::hqCaseActions` for basic slots, the emitted
XForm (`lib/commcare/compiler.ts`, parsed with `lib/commcare/xmlParse.ts`, walked as elements) for every
element carrying Vellum's role `SaveToCase` and for model-iteration rows,
`lib/domain/casePreload.ts::writerPreloadsFromLoadedCase`, the emitted XForm again for each `group`
element carrying `appearance="field-list"` (`main`'s builder writes it exactly where the group's label
registers in some language, the rule `lib/domain/platformUses.ts::groupLabelShows` restates and
`platformQuestionPages.test.ts` holds equal), and
`lib/commcare/suite/case-search/searchWireShape.ts::searchWireShape`. Pull request 1 changes no `lib`
file, so `groupLabelShows`, module-private at `main`, is read through the emission it agrees with.

### 5.4 The tests that hold them

- `scripts/lib/hqRoundTripCaseWrites/__tests__/fixtures.capture.test.ts` (pull request 1, deleted by
  pull request 2): `it("admits each pre-step fixture under main's schema and absolute gate")` (each file
  parses with `blueprintDocSchema` and `mutationCommitVerdict(doc, [], lookupContext)` finds nothing);
  `it("records the facts main's own code derives from each fixture")` (recomputes `facts.json` and
  compares it byte for byte; `NOVA_WRITE_PRE_STEP_FACTS=1` writes it instead, run once by the author).
  Pull request 2 deletes the file because attachment mode, the first shape it parses, leaves there.
- `scripts/lib/hqRoundTripCaseWrites/__tests__/fixtures.digest.test.ts` (pull request 1, kept to pull
  request 16): every fixture and `facts.json` match `digests.json`, and `digests.json` names exactly the
  files present. A fixture cannot drift once the code that admitted it is gone.
- `scripts/lib/hqRoundTripCaseWrites/__tests__/frozen.test.ts` (pull request 14): each frozen copy
  (section 5.5) reproduces `facts.json` over every fixture read raw (`oldShape.ts::readRawDocument`).

### 5.5 The frozen copies (pull request 14)

`scripts/lib/hqRoundTripCaseWrites/frozen/`, each a copy of `main`'s rule over a `RawDocument`, importing
no head module whose rule step 5 changes:

| File | Copy of (at `2f985ed6`) | Used by |
|---|---|---|
| `caseWriteInventory.ts` | `lib/domain/caseWriteInventory.ts::deriveCaseWriteInventory`'s bucket rules (own case, usercase, children by `(type, nearest repeat)`, the extension relationship from the catalog) | C1 to C3 (section 7.3), today's placement (section 8.2) |
| `todaysPlacements.ts` | `lib/commcare/subcaseWire.ts::hqCaseActions`' index rules, `lib/commcare/xform/generatedNodes.ts::planGeneratedNodes`' Save to Case names (`nova_operations`, `nova_subcases/nova_subcase_<n>`, `nova_update_selected_cases`, `nova_condition_close/nova_close`, with its suffixing), `lib/domain/closeCondition.ts::closeConditionPlacement` | section 8.2 |
| `casePreload.ts` | `lib/domain/casePreload.ts::writerPreloadsFromLoadedCase` | C7 |
| `groupLabel.ts` | `lib/domain/platformUses.ts::groupLabelShows` (module-private at `main`) | Q4, passed to `planGroupFieldLists` |

The search classes need no frozen copy: part 05 identifies them with `visibleSearchInputs` and
`effectiveFilterForEmission`, which step 5 does not change, and `frozen.test.ts` holds that the
semantics step's facts reproduce `facts.json`'s `searchShapes` for every fixture.

## 6. Scripts, layout, arguments, already applied

```
scripts/scan-hq-round-trip-case-writes.ts       read-only scan: holders, the plan, the blockers
scripts/migrate-hq-round-trip-case-writes.ts    the Job's entrypoint; a dry run unless told otherwise
scripts/lib/hqRoundTripCaseWrites/
  oldShape.ts       step 3's (733dd193:scripts/lib/hqRoundTripExpressions/oldShape.ts), copied: carriers -> RawDocument, no schema
  structure.ts      the structure phase: its steps over raw JSON, the lifted facts, the head parse and hydration
  steps/            one module per semantic step of section 7
  frozen/           section 5.5
  placements.ts     section 8: today's placements, the baseline match, the holds, the frozen check
  deployments.ts    section 9
  judge.ts          step judge-target
  transform.ts      transformApp, judgeTarget
  source.ts         the fleet read
  plan.ts           fleet source -> CaseWritesCutoverPlan and its digest
  holders.ts        step 4's (a8af778e:scripts/lib/hqRoundTripPlatforms/holders.ts), copied
  ledger.ts         step 4's ledger read and savepointed migrator, one phase
  catalog.ts        every pg_catalog read, each naming its relation (section 15)
  writer.ts         the one fleet transaction
  notice.ts         changes and deployment lines -> notice entries
  report.ts         the content-free JSON Lines report
  run.ts            the modes
  types.ts          step ids, change kinds, blocker codes, stop codes, causes
  __tests__/        section "Tests"; fixtures/pre-step/ from pull request 1
```

Both scripts follow the house conventions: first line `import "./lib/loadEnv";`, `commander`,
`scripts/lib/main.ts::runMain`, and `closeCaseStoreDatabase()` from `lib/case-store/postgres/connection.ts`
in a `finally`.

| Script | Argument | Meaning |
|---|---|---|
| scan | (none) / `--prod` | the plan over the local database or production (`scripts/lib/prodDb.ts::targetProdDb`), in one `REPEATABLE READ, READ ONLY` transaction of plain `SELECT`s; it prints no digest |
| scan | `--app <id>` | one app |
| scan | `--debug-details` | with `--app`: each blocker's places by entity id and name with each finding's message, and the planned changes with names, on the operator's terminal only, never archived |
| migrate | (none) | the dry run: the fleet read, the full plan, the report and `planDigest`; writes nothing and applies no DDL. The Job's stored arguments |
| migrate | `--settle-holders` | settles every lapsed or paused holder through the production reapers (`holders.ts::settleHolders`), prints counts and exits |
| migrate | `--rehearse` | the whole fleet transaction, the ledger included, ending in a sentinel rollback; local databases and tests only, refused by the Job's arm |
| migrate | `--execute --expect-plan-digest <64 hex>` | builds the plan, refuses with nothing written on a different digest, writes and commits |

`--prod` exists only on the scan, which never writes. A production write runs only through the Job.

**Already applied, checked first.** Every mode first reads the ledger (`ledger.ts::readMigrationLedger`,
one plain `SELECT` of `public.kysely_migration`) and counts `public.app_changes` rows whose `batch_id` is
the marker: the horizon migration present and every app marked prints `already-applied` and exits 0; the
migration present with some app unmarked stops as `partially-applied`, which no committed run can leave
(the migration and the markers commit together); neither present goes on. The writer repeats both reads
under its locks.

## 7. The transform, in order

```ts
// scripts/lib/hqRoundTripCaseWrites/transform.ts
export interface StepContext {
	readonly appId: string;
	readonly projectId: string;
	readonly lookupContext: LookupValidationContext;                // the Project's definitions, read once per Project
	readonly mediaRecords: ReadonlyMap<MediaAssetId, MediaAssetRecord>; // for export readiness
	readonly deployments: readonly PublishedDeployment[];           // section 8.1; [] for an unpublished app
	readonly storedSchemas: ReadonlyMap<string, string>;            // active case_type_schemas rows, canonical text, by case type
}
export interface AppTransform {
	readonly target: BlueprintDoc | null;                // null where a blocker stopped the transform
	readonly changes: readonly PlannedChange[];         // { step, kind, entityUuid, detail counts }: content-free
	readonly held: readonly HeldUnit[];                 // section 8.3
	readonly pathMoves: readonly PathMove[];            // section 9
	readonly notice: readonly MigrationNoticeEntry[];   // with names; never printed
	readonly blockers: readonly CutoverBlocker[];
	readonly schemaChanges: readonly PlannedSchemaChange[]; // section 12
	readonly discardsPrivateWork: boolean;
}
export function transformApp(raw: RawDocument, ctx: StepContext): AppTransform;
/** Step judge-target alone, over any target: the blockers it finds, empty where the target is clean. */
export function judgeTarget(raw: RawDocument, target: BlueprintDoc, ctx: StepContext): readonly CutoverBlocker[];
```

The source is each app's persisted carriers (`PERSISTED_BLUEPRINT_APP_COLUMNS` and the `::text` carriers
of `apps`, every `blueprint_entities` row), assembled by `oldShape.ts::readRawDocument` through no schema.
Two phases, step 3's shape: **structure** rewrites raw JSON until the head schema can read it, lifting each
old fact the semantics phase needs into `LiftedFacts`; then the head parse; then **semantics**, production
planners over the parsed document. Where a semantic step's planner returns mutations, the step applies
them with `lib/doc/commitVerdicts.ts::prepareMutationCandidate(doc, admitMutationBatch(mutations))`, the
reducer every editor's commit uses, and a candidate with an admission issue
(`preparedCandidateHasAdmissionIssue`) is the blocker `transform-admission`. The gate runs once, at
`judge-target`. A blocker stops that app's transform; the app is reported with every other blocker the
judgement can still find over the document the steps before it left (step 3's correction), and the plan has
no target for it.

```ts
// scripts/lib/hqRoundTripCaseWrites/structure.ts
export interface FieldWriteFact {      // the type lib/doc/fieldWriteOperations.ts exports (part 01, pull request 4)
	readonly fieldUuid: Uuid;
	readonly caseType: string;
	readonly property: string;
	readonly capture: boolean;          // a capture kind: its value is `capture-link`
}
export interface LiftedFacts {
	/** Every field write, per form, in data-tree order. */
	readonly fieldWrites: ReadonlyMap<Uuid, readonly FieldWriteFact[]>;
	/** Capture fields whose stored mode was `attachment` (C5's notice and deployment line). */
	readonly attachmentFields: ReadonlySet<Uuid>;
	/** Modules whose stored `caseSearchConfig.searchFirst` was `true`. */
	readonly searchFirst: ReadonlySet<Uuid>;
	/** The frozen preload rule's writers, per form (C7). */
	readonly preloadedWriters: ReadonlyMap<Uuid, readonly Uuid[]>;
	/** Groups whose label the frozen label rule shows (Q4). */
	readonly labelledGroups: ReadonlySet<Uuid>;
	/** Today's placement of every unit (section 8.2). */
	readonly todaysPlacements: ReadonlyMap<string, TodaysPlacement>;
	/** Case list media M4 deleted, per module: report only. */
	readonly deadCaseListMedia: ReadonlyMap<Uuid, readonly ("icon" | "audioLabel")[]>;
}
export function structurePhase(raw: RawDocument): { readonly persisted: unknown; readonly facts: LiftedFacts; readonly changes: readonly PlannedChange[]; readonly notice: readonly MigrationNoticeEntry[]; readonly blockers: readonly CutoverBlocker[] };
```

| # | Step id | Phase | What it does | Functions it calls | Blockers | Notice reasons |
|---|---|---|---|---|---|---|
| 1 | `renamed-concepts` | structure | part 05's M2 to M5 over raw JSON (section 7.1) | raw JSON only | `renamed-concept-conflict` | none |
| 2 | `capture-link-writes` | structure | C4, C5: every capture `caseWrite` loses `mode`; an `attachment` one is recorded | raw JSON only | none | `capture-saves-link` |
| 3 | `close-condition-expression` | structure | C6: the structured close condition becomes an `Expression` | raw JSON only | none | none |
| 4 | `field-writes-lifted` | structure | every field's `caseWrite` leaves the field into `LiftedFacts.fieldWrites`; the frozen preload, label and placement rules have read the raw document as read, before step 1 | `frozen/*` | none | none |
| 5 | `search-first-lifted` | structure | every stored `caseSearchConfig.searchFirst` leaves into `LiftedFacts.searchFirst` | raw JSON only | none | none |
| | head parse | | `blueprintDocSchema.parse`, then `lib/doc/fieldParent.ts::hydratePersistedBlueprint` | | `structure-parse` | |
| 6 | `writes-into-operations` | semantics | stored capture reads, C9, C1 to C3 (with C4, C5 values and part 02's extension creates), C10 (section 7.4) | `lib/doc/fieldWriteOperations.ts::operationsFromFieldWrites`, `lib/doc/caseOperationOrder.ts::caseOperationConditionalGuardUuids` | `transform-admission`, `capture-write-unlinkable`, `own-close-in-repeat`, `own-close-condition-reads-case` | `capture-saves-link-not-name`, `form-became-close-form` |
| 7 | `form-link-semantics` | semantics | L1 to L6 with L4's removal (L8 under part 06's G2 outcome B) | `lib/doc/formLinkSemanticsMap.ts::mapFormLinkSemantics` | none (the map is total, section 7.5) | `form-links-conditions-written`, `form-link-otherwise-set`, `after-submit-destination-dropped`, `form-link-target-moved`, `form-link-removed`, `form-link-datums-dropped` |
| 8 | `extension-children` | semantics | part 02's M1 to M3: carried creates, the retargets, the held kind left to the next publish (section 7.6) | `lib/commcare/formLinkProjection.ts::linkCarriedCreates`, `lib/domain/advancedModule.ts::advancedKindBlockers`, `lib/commcare/moduleKind.ts::emittedModuleKind`, `lib/domain/formLinkTargets.ts::menuTargetOffered` and `nearestOfferedMenu` | `transform-admission` | `module-made-advanced`, `form-link-goes-to-menu` |
| 9 | `explicit-preloads` | semantics | C7 | `lib/doc/explicitPreloads.ts::planExplicitPreloads` | `transform-admission` | `starting-value-reads-case`, `load-time-value-reads-case` |
| 10 | `search-workflow` | semantics | part 05's M1 | `lib/doc/searchWorkflowPlan.ts::authoredSearchWorkflow` | `transform-admission` | `menu-opens-on-search` |
| 11 | `query-repeat-placement` | semantics | Q1: the effective placement; holds are step 15's | `effectiveQueryRepeatPlacement`, `queryRepeatPlacementNeeds` (part 04) | none | `repeat-rows-follow-query` |
| 12 | `repeat-counts` | semantics | Q2's wrap; Q3's notice | `lib/doc/repeatCountWraps.ts::planRepeatCountWraps`, `lib/domain/repeatCount.ts::directRepeatCountReference` | `transform-admission` | `repeat-count-whole-number`, `repeat-count-node-removed` |
| 13 | `field-list-flags` | semantics | Q4 | `lib/doc/groupFieldLists.ts::planGroupFieldLists` with the frozen label rule | `transform-admission` | `group-shows-one-per-screen` |
| 14 | `blank-comparisons` | semantics | a refused comparison of an answer with `''` becomes a blank test (section 7.12) | `lib/domain/referenceSlots.ts::rewriteExpressionSlotValues`, `lib/domain/expression/typeChecker.ts::checkExpression` | none | none |
| 15 | `placements` | semantics | section 8: every hold the published deployments give | `lib/commcare/hq/publishedCaseBlocks.ts::publishedCaseBlocks`, `lib/commcare/placement.ts::planPlacements`, `lib/doc/placementHolds.ts::holdExpresses`, `lib/commcare/casePlacementPlan.ts::planFormCaseWire` | `baseline-unreadable`, `placement-path-mismatch` | none (section 9's lines carry it) |
| 16 | `judge-target` | | section 7.14 | | `target-parse`, `target-gate`, `target-export-readiness`, `case-schema-unplanned`, `not-idempotent` | none |
| 17 | `deployment-lines` | | writes nothing; selects each live deployment's lines (section 9) | | none | `deep-links-need-republish`, `placements-kept-unread`, `form-data-paths-move`, `case-attachments-stop`, `next-publish-asks-more` |

**Order.** Every structure step runs before the head parse, because the head schema cannot read any of
the keys they remove. Within semantics: operations exist (6) before links are mapped (7), because the
map's invariants and `linkCarriedCreates` read operations; links are mapped (7) before extension
placement (8), part 06's order (§14.2: "the map before the extension retargets"); preloads (9) read the
own arm step 6 wrote; the blank comparisons (14) follow every step that can change what an answer types as;
the placement step (15) runs last over every unit in place.

**The cutover brief's fixed point dissolves into this order.** The brief ran its steps 6 and 8 as a fixed
point because a retarget might change which links carry a case. Part 06 holds that `linkCarriedCreates`
answers the same before and after `mapFormLinkSemantics` (the map changes targets and datums only of menu
targets, which carry no created case), and part 02's retargets target menus `nearestOfferedMenu` gives and
drop carried values, which neither adds a carried create nor breaks an invariant the map left. So one
ordered pass is the fixed point; step 16's `not-idempotent` check holds it per app.

### 7.1 `renamed-concepts` (structure; part 05 §14)

Over each module's and form's raw JSON:

- **M2**: `caseListOnly: true` → `caseListMenuItem: { icon?, audioLabel? }`, carrying `caseListConfig.icon`
  and `caseListConfig.audioLabel` into it and deleting them from `caseListConfig`.
- **M3**: `caseListOnly: false` → the key deleted.
- **M4**: `caseListConfig.icon` / `caseListConfig.audioLabel` on a module without `caseListOnly: true` →
  deleted; recorded in `LiftedFacts.deadCaseListMedia` for the report, no notice. The media edges follow
  in `writeApp` (`replaceExactMediaReferencesForApp`), so an asset referenced only there loses its last
  reference.
- **M5**: a form with `entry: { kind: "search-no-matches", label? }` → its module gains
  `caseListRegistrationForm: { kind: "after-empty-search", formUuid, label? }` and the form's `entry` is
  deleted. Each target language's entry of `localization`'s overlay under unit
  `form:<formUuid>:entry-label` moves to unit `makeTranslationUnitId("module", moduleUuid,
  "case-list-registration-label")` with its value, provenance, review state and source fingerprint
  unchanged.
- Blocker `renamed-concept-conflict`: a module holding two such forms, which `SEARCH_NO_MATCHES_DUPLICATE`
  refuses at every commit at `main`. A guard: the stored document is one the gate never admitted.

No wire byte moves, so no notice.

### 7.2 `capture-link-writes`, `close-condition-expression`, `field-writes-lifted`, `search-first-lifted` (structure)

- **C4, C5** (part 01 §22): a capture field's `caseWrite.mode` is deleted; where it was `"attachment"`
  the field joins `LiftedFacts.attachmentFields` and gets a `capture-saves-link` entry (field, `detail.form`
  the form's name, `detail.property`).
- **C6** (part 01 §22): a form's `closeCondition: { field, answer, operator? }` becomes the `Expression`
  `eq(term field, A)` where `operator` is `=` or absent, and `multi-select-contains(term field, [A], any)`
  where it is `selected`; `A` is the `choice` leaf of the field's inline option whose value is `answer`,
  else the literal `answer`. Written as the JSON of `lib/domain/expression/types.ts`' arms, the same
  structure the parser would build, so it parses. No notice: the same close runs.
- **Lift**: before step 1, the frozen rules run over the raw document as read, so each sees `main`'s shape
  untouched: the preload
  rule (`frozen/casePreload.ts`) fills `preloadedWriters`, the label rule (`frozen/groupLabel.ts`)
  `labelledGroups`, and the placement classifier (`frozen/todaysPlacements.ts`, section 8.2)
  `todaysPlacements`. Then every field's `caseWrite` (`{caseType, property}`) leaves into
  `fieldWrites[formUuid]` in data-tree order, `capture` true for the five capture kinds.
- **`searchFirst`**: every module's `caseSearchConfig.searchFirst: true` leaves into `searchFirst`.

### 7.3 The head parse

`blueprintDocSchema.parse(persisted)` then `hydratePersistedBlueprint`. A failure is the blocker
`structure-parse`, a defect of the structure phase (a key it should have removed or rewritten), its report
line carrying the Zod issue codes and their paths (entity ids and keys, never values).

### 7.4 `writes-into-operations` (semantics; part 01 §22, part 02 §23)

In this order, per form:

0. **Stored capture reads.** A stored operation's write whose whole value is a bare read of a capture
   question saved the captured file's name at `main`; the head saves a capture only as the link to its file.
   The write's value becomes `{ kind: "term", term: { kind: "capture-link", field } }` through an
   `update-write` patch (change `capture-write-linked`), and the question gets one
   `capture-saves-link-not-name` per form and property (field, `detail.form`, `detail.property`), as C5's
   `capture-saves-link` is one per question. A write to a reserved property is left to the gate's own
   `CASE_OPERATION_RESERVED_PROPERTY`. Where the link can't be saved, the blocker `capture-write-unlinkable`
   names the place: a case's name (`case-name`) or a standard property CommCare keeps as the case's own text
   (`external-id`, the validator's `isWritableStandardCaseProperty`, which `CAPTURE_CASE_WRITE_STANDARD_PROPERTY`
   reads), or a property whose type holds no text (`property-type`, the inferred type, which the rewrite leaves
   unchanged since a capture's answer and its link both hold no type opinion). The author's remedy is to save
   the file to a property of its own in today's builder.
1. **C9** (part 01 class (a); production holds the shape, so C9 rewrites forms at the window, section 19.1). For each `followup` or `close` form holding
   `close` operations whose target is `{ kind: "session" }`:
   - an operation with `forEach` is the blocker `own-close-in-repeat` (its close would run once per row,
     which no close condition states); the author's remedy is to remove the operation and set the form's
     close condition in today's builder;
   - each operation's term is its condition and-ed with each condition it inherits from a conditional
     retype of the case before it (`lib/doc/caseOperationOrder.ts::caseOperationConditionalGuardUuids`,
     the guard `main`'s emission gave it), each read in its own operation's row and written in the form's
     vocabulary: a `prop` read of the row (no `via`, or `self`) becomes `{ kind: "form-case", caseType:
     <module's case type>, property }`, and one through parent links to the case at that many hops above
     it becomes `form-case` of that case's type, which `lib/commcare/xform/formCaseRead.ts` prints as the
     same `index/parent` walk. Only the term and expression kinds the form's close condition holds pass
     (`FORM_CLOSE_TERMS`: literals, the form's answers and choices, the form's reads of its case, the
     worker and the session's values; `FORM_CLOSE_EXPRESSIONS`: the operators that read no row of their
     own). A read of a case of another type (`other-case`), through another link (`linked-case`), of a case a
     retype before the operation gave another type (`retyped-case`), of the cases linked below or rows of its
     own (`count`, `exists`, `missing`: `related-cases`), or of anything only a case change has, such as the
     row's links or type or another change's created id (`case-change-value`), is the blocker
     `own-close-condition-reads-case`, whose remedy is to rewrite the condition over the form's answers, its
     case and the cases above it, or to remove the operation and set the form's close condition;
   - the form's type becomes `close`, and its `closeCondition` becomes the `or` (`lib/domain/expression/
     reduction.ts::reduceOr`) of the close it already had (a close form's own: absent means every
     submission) and each such operation's term (absent means every submission); any absent term
     makes the whole absent;
   - each such operation without `writes` is removed;
   - each such operation with `writes` becomes an `update` operation on `{ kind: "session" }` with the same
     `uuid`, `id`, `condition` and `writes`, so its Save to Case block keeps its path and its writes keep
     their condition (part 01 §22's C9 states the same rule);
   - in a published app, section 8 holds the own close (`Form.ownClosePlacement`) at the path the first
     removed operation had today, so its block stays where HQ holds it; where every such operation
     carried writes, the own close takes its simplest placement unheld, and a published deployment's line
     names the cause `own-close-moved`;
   - a follow-up form C9 makes a close form gets `form-became-close-form` (form, no `detail`), since its
     type is what an author reads in the builder and the SA and MCP read through `Form.type`; a close form
     keeps its type, and its close condition gains only the closes it already ran, so it gets no line (the
     same close runs, as C6's rewrite).
2. **C1 to C3 and part 02's extension creates.** `operationsFromFieldWrites(doc, formUuid,
   facts.fieldWrites.get(formUuid) ?? [])` returns the mutations that give the form: the own arm at index
   0 on every registration, follow-up and close form of a module with a case type (`name` the bare read
   of the `case_name` writer, `writes` every other writer of the module's type, a capture's value
   `capture-link`); a `create` per `(caseType, nearest repeat)` child bucket of the frozen inventory (`name`
   its `case_name` writer, the rest as writes, one `parent` link to the own case whose relationship is the
   catalog's, `child` or `extension`, `forEach` the repeat); one worker-record `update` for the usercase
   bucket; in part 01's order (the own arm at 0, then scope by scope in
   `caseOperationMultiplicityScopes` order the stored operations of that scope followed by its new creates
   in bucket order, the worker-record update after the root scope's operations). Operation UUIDs and ids
   are section 10.1's.
3. **C10** (part 01 class (f); the planning scan did not count it, so the advisory dry run says whether
   it has work). Every other operation's write whose target
   is the form's own case and whose key the own arm writes is removed; an operation left with no write,
   name, owner, link, rename or retype is removed. Today the ordinary action ran last on every platform,
   so the field's value already replaced it: no notice.

An `update` operation whose target is the form's own case otherwise stays an operation (part 01's class
(e), which production holds): its writes are not folded into the own arm, and only C10 removes a write
the own arm also makes.

C11 (part 01 class (g); not counted by the planning scan, decided by the advisory dry run) changes
nothing in the document; section 8.5 places it.

### 7.5 `form-link-semantics` (semantics; part 06 §14)

`mapFormLinkSemantics(doc)` returns the mapped document and its changes. Each change is a notice entry on
the form (entity `form`):

| Change (part 06) | Reason | `detail` |
|---|---|---|
| `conditions-written` | `form-links-conditions-written` | `links` (count) |
| `otherwise-set` (L2, L3) | `form-link-otherwise-set` | `to` (a name) or `toDestination` (an `OtherwiseDestination` word) |
| `otherwise-set` with `from` (L6) | `form-link-otherwise-set` | `toDestination`, `from` (the word it replaced) |
| `after-submit-dropped` | `after-submit-destination-dropped` | none |
| `target-moved` (L4) | `form-link-target-moved` | `from`, `to` (names) |
| `target-moved` with `cause: "carried-not-a-case"` (L8, under part 06's G2 outcome B) | `form-link-target-moved` | `from` (the destination form's name), `to` (the menu's name), `cause` |
| `link-removed` (L4's off-the-menu arm, part 06 §14.4) | `form-link-removed` | `to` (the submenu's name) |
| `datums-dropped` | `form-link-datums-dropped` | `to` (a name) |

L7 has no notice (part 06 §14.3).

**L4's off-the-menu arm** (part 06 §14.4). A link to a submenu HQ does not offer whose parent is off the
menu has no offered menu to retarget to. Production holds no such link today, but nothing at `main`
refuses the shape, so an author can make one until the window and the advisory dry run counts it. So the
map stays total and the cutover has no blocker for form links: the map removes each such link and
normalizes the form as `planFormLinkRemove` does, its change is `link-removed { formUuid, linkUuid, to }`,
and `DOCUMENT_NOTICE_REASONS` holds `form-link-removed` after `form-link-target-moved`, entity the form,
`detail.to` the submenu's name, with section 17's copy. Where the dry run finds none, the reason ships and
no app gets the line.

What the scan found for the other classes, in words (part 06 §14.4): production holds form links. A
stored `postSubmit` beside conditional links that becomes the otherwise exists (L3), and stored after-submit destinations that never run exist (L3's deletion,
`after-submit-destination-dropped`), so those lines meet apps at the window. No form holds two or more
links, no exclusivity guard is written, no terminal unconditional link follows a conditional one, no link
targets a menu HQ does not offer, no menu link carries values, no otherwise is unoffered and no self link
exists, so L1, L2, L4, L5 and L6 meet no app today; each ships, the dry run counts it, and an author can
make its shape until the window.

Every other outcome of part 06's gated runs changes the map, not this step: the cutover calls
`mapFormLinkSemantics` as pull request 11 lands it, and maps any change kind part 06 adds onto the reasons
above as part 06 names it.

### 7.6 `extension-children` (semantics; part 02 §23)

Over the document step 7 leaves:

- **M1, carried.** For each form `f`, `carried = linkCarriedCreates(doc, f)`, over every create of `f`
  whatever its relationship (an extension bucket's create, a child bucket's, or a stored operation's), as
  part 02 §23 asks. A carried create needs no
  stored change: `emittedModuleKind` makes its module advanced where `advancedKindBlockers(doc, m)` is
  empty, and the module gets `module-made-advanced` (module, `detail.caseType` the create's type) once.
  Where a blocker holds, the gate would refuse the document (`FORM_LINK_NEEDS_NEW_CASE_DATUM`, part 02
  §15), so each link of `f` that carries the create is retargeted: to `{ type: "module", moduleUuid:
  <the target form's menu> }` where `menuTargetOffered(doc, f's module, that menu)`, else
  `nearestOfferedMenu(doc, f's module, that menu)`, else the link is removed and the form is normalized as
  `lib/doc/formLinkMutations.ts::planFormLinkRemove` normalizes it; its `datums` are dropped in every case.
  Each retarget is a `form-link-goes-to-menu` entry on `f` (`detail.to` the menu's name, absent for a
  removal, which reads as the app home; `detail.caseType`). The retarget writes through
  `planFormLinkUpdate` and `planFormLinkRemove` (part 06 §9), so it is the production edit an author would
  make.
- **M1, published and not carried, M1 otherwise, M2, M3**: no document change here; section 8 holds or
  leaves each placement and section 9 names the causes `extension-case-moved`, `subcase-renumbered` and
  `module-made-advanced`.
- No module kind is held: the next publish records it (part 02 §5). No Save to Case placement of a
  carried create is held, whichever branch it takes, and no basic placement of a form of a module M1
  makes advanced is held (section 8.5).

**What production holds.** Production holds extension child writes (as field writes, and operations with
an extension link), in unpublished apps only, and no create of any relationship that an after-submit link
carries into a form of its case type. So no module becomes advanced at the window and
`module-made-advanced` meets no app today. An author can still make a carried create until the window, so
the step ships whole and the advisory dry run counts it: each module it finds gets
`module-made-advanced`, and a carried create that is not an extension (part 02's decision 11) is listed
apart in the report's `steps` line so the person reviews it there. With no carried create, none meets a
blocker either: the retarget branch writes nothing today and stays the transform's guard, and where the
dry run finds one, each link that carried it is retargeted and named by `form-link-goes-to-menu`.

### 7.7 `explicit-preloads` (semantics; part 01 §11, §22 C7)

`planExplicitPreloads(doc, formUuid, facts.preloadedWriters.get(formUuid) ?? [])` gives each listed writer
`default_value` = the `form-case` read of its property, replacing any default; a Hidden Value with a
`calculate` is never listed (the frozen rule excludes it). Notice entries (field):

- `starting-value-reads-case` for each writer whose `default_value` the step replaced (`detail.form`,
  `detail.property`);
- `load-time-value-reads-case` for each field of the same form, later in data-tree order, whose
  `default_value`, or whose query repeat's ids query (part 04), reads a listed writer
  (`steps/explicitPreloads.ts::laterLoadTimeReaders`, a walk of the form's fields in data-tree order over
  `lib/domain/expression/children.ts::expressionChildren` for a `field` term naming a writer); `detail.form`
  and `detail.reads` (the writer's name).

### 7.8 `search-workflow` (semantics; part 05 §14 M1)

For each module with an effective ordinary search (owner-only configurations untouched), the facts
`{ searchFirst: facts.searchFirst.has(m), hasVisibleInput:
lib/domain/modules.ts::visibleSearchInputs(module.caseListConfig.searchInputs ?? []).length > 0,
hasEffectiveFilter: lib/domain/expression/simplify.ts::effectiveFilterForEmission(
substituteUnansweredSearchInputs(module.caseListConfig.filter)) !== undefined, declaresWebApps:
lib/domain/platforms.ts::declaresWebApps(doc) }`, the predicates `main`'s `searchWireShape` reads (part 05
§14), go to `authoredSearchWorkflow`, whose `workflow` and `formsReadSearch` are written by one
`updateModule` with a `caseSearchConfig` patch. Where its answer holds `webAppsOpensOn`,
the module gets `menu-opens-on-search` (module, `detail.opensOn` `search` or `results`).

### 7.9 `query-repeat-placement` (semantics; part 04 §7.1 Q1)

Nothing is written here: a query repeat's effective placement is derived (`effectiveQueryRepeatPlacement`).
Every query repeat whose effective placement is the count placement gets `repeat-rows-follow-query`
(field, `detail.form`), in any app. Holds are section 8's.

### 7.10 `repeat-counts` (semantics; part 04 §7.1 Q2, Q3)

`planRepeatCountWraps(doc)` wraps each count part 04 §2.3 refuses in `int(…)`; each wrapped repeat gets
`repeat-count-whole-number` (field, `detail.form`). `int(…)` types `int` over every argument, so the wrap
meets no blocker of its own (a departure from the cutover brief's `repeat-count-refused`). Each count that
`directRepeatCountReference` reads straight from a Hidden Value calculated as an integer, whose
`nova_count_<repeat>` node therefore leaves the wire, gets `repeat-count-node-removed` (field,
`detail.form`, `detail.hidden` the Hidden Value's name) in an app with a published deployment.

### 7.11 `field-list-flags` (semantics; part 04 §7.1 Q4)

`planGroupFieldLists(doc, (d, g) => facts.labelledGroups.has(g))` gives `fieldList: true` to each group
whose label the frozen rule shows and that holds no user-controlled repeat at any depth, and leaves every
other group without the key (never `false`); sections take no flag. Each labelled group left without it
gets `group-shows-one-per-screen` (field, `detail.form`). A section holding a user repeat is refused by the
gate at `main` and at the head alike, so the brief's `section-holds-user-repeat` guard is not a code of
its own: such a document meets `target-gate`.

### 7.12 `blank-comparisons` (semantics)

At `main` a Hidden Value that no field's own Saves to wrote was untyped, so a case operation's condition
could compare it with the blank text `''`. The head types it by the operations that save it (part 01,
decision 32), and the checker then refuses the comparison of a number, date, time or location with text
(`CASE_OPERATION_EXPRESSION_TYPE`, `incompatible-values`). Over every expression slot of every question,
form and menu, each comparison the checker refuses whose operands are a bare read of an answer and `''`
becomes a blank test: `eq(x, '')` (either order) `is-blank(x)`, and `neq(x, '')` `not(is-blank(x))`.

On a device the two ask the same of every value but a yes/no. Core reads the node as `""` when blank or not
relevant, a `Double` for a number, a `Date` for a date, and a `String` otherwise
(`XPathPathExpr.java::unpackValue`); `XPathEqExpr.java::testEquality` compares a `Double` with `''` as
numbers, `''` reading as `NaN` (`FunctionUtils.java::toNumeric`), and a `Date` or a `String` as text, so
only the blank read equals `''`, exactly where `is-blank`'s `string-length(string(x)) = 0` holds. A
`Boolean` equals `''` when false, where its text is `"false"`, so the step rewrites only an answer that
never holds one: a visible question; a Hidden Value without a calculation (a starting value is cast
through its bind's class, `SetValueAction.java::processAction`); and one whose calculation's every result
types as a value other than yes/no, or reads such an answer (`Recalculate.java::wrapData` makes a
`BooleanData` only of a `Boolean` result under Nova's binds). Any other comparison stays and meets
`target-gate`, the author's to rewrite. The step writes the registered slots in place
(`lib/domain/referenceSlots.ts::rewriteExpressionSlotValues`), since no one mutation addresses an expression
by its slot; the same condition runs, so it plans `blank-test-written` and no notice. It runs after every
step that can change what an answer types as.

### 7.13 `placements` (semantics)

Section 8.

### 7.14 `judge-target`

Over the document every step left:

- `toPersistableDoc`, then `blueprintDocSchema.parse` (`target-parse`, a defect);
- `mutationCommitVerdict(target, [], ctx.lookupContext)`, the absolute gate (`target-gate`, its line
  carrying each finding's code and `details.reason`);
- `exportReadinessFindings(target, ctx.lookupContext, ctx.mediaRecords)` (`target-export-readiness`);
- the case-schema comparison of section 12 (`case-schema-unplanned`);
- idempotence: `transformApp` over the target's own carriers (`oldShape.ts::readRawDocument` of
  `decomposeBlueprint(toPersistableDoc(target))`) returns no change and the same document under
  `canonicalJsonDigest` (`not-idempotent`).

## 8. Published placements

### 8.1 Published deployments

For each app, `source.ts` reads every `public.app_deployments` row whose record
`lib/deployment/stateMachine.ts::deploymentDisplaysAsReached(record, "uploaded")` holds and that has a
`public.app_deployment_resources` row of kind `app` with `superseded_at IS NULL`. A mapping marked missing
on CommCare HQ (`remote_missing_at` set) still counts: the project space keeps that app's submissions under
the same `xmlns` (part 03, "What other parts read"). With each: its `public.app_deployment_baselines` row
(`origin`, `source_gzip`, `source_digest`, `observed_at`), its identity overrides
(`public.app_deployment_identities`), its `server` and `domain`, and the `app` resource's
`pushed_revision`.

```ts
interface PublishedDeployment {
	readonly deploymentId: string;
	readonly server: DeploymentServer;
	readonly domain: string;
	readonly baseline:
		| { readonly kind: "readable"; readonly source: unknown; readonly sourceDigest: string; readonly observedAt: string }
		| { readonly kind: "shell" }      // origin `create`: an empty app, no form
		| { readonly kind: "unknown"; readonly why: "unread" | "absent" }
		| { readonly kind: "unreadable"; readonly why: "gunzip" | "digest" | "parse" };
	readonly overrides: readonly WireIdentityOverride[];   // lib/commcare/wireIdentity.ts
	readonly pushedRevision: number | null;
}
```

A baseline of origin `push` or `cutover` whose `source_gzip` gunzips to text whose SHA-256 is
`source_digest` and which parses as JSON is `readable`, its source JSON parsed once. Origin `unread` and a
published deployment with no baseline row are `unknown`: Nova never read what the project space holds, so
the baseline is unknown rather than empty (part 03 §12). A stored baseline of origin `push` or `cutover`
whose bytes fail gunzip, their digest or their parse is `unreadable`, and its app meets the blocker
`baseline-unreadable` (section 16): those bytes were stored as a read of CommCare HQ and no longer
verify, which is a fault to repair before the window rather than a state to plan around, and refreshing
the deployment reads CommCare HQ again (part 03). Production holds no such baseline today (the
planning scan); the advisory dry run counts any. Every `readable` baseline's `sourceDigest` and
`observedAt`, and every `unknown` or `unreadable` one's `why`, enter the plan digest.

### 8.2 Today's placement of each unit

The units are the target's case operations (the own arm and every operation step 6 made included), each
form's own close where today's emission placed it apart (`closeConditionPlacement`'s `save-to-case` arm,
and C9's removed operations), and each query repeat. `frozen/todaysPlacements.ts::todaysPlacements(raw)`,
run over the raw document in step 4, gives each unit the placement `main`'s emission gave it, keyed by the
same unit keys as section 10.1's identities so each key names one unit of the target:

| Unit key | Today's placement (`main`'s rule, frozen) |
|---|---|
| `own` | `{basic, slot: "own"}` in a one-case form; in a several-case form the Save to Case block at `main`'s selected-cases path (`nova_update_selected_cases`, in its iteration), whose exact path `facts.json` holds for `targeted-migration-case-writes`'s Batch form |
| `usercase` | `{basic, slot: "usercase"}` |
| `child:<type>:<repeat or root>` | `{basic, slot: "subcase", index: i}`, `i` the bucket's position in `main`'s `actions.subcases` counting inert extension subcases; `{basic, slot: "subcase-row"}` where its repeat context holds one subcase |
| `extension:<type>:<repeat or root>` | `{save-to-case, repeat?, path: ["nova_subcases", "nova_subcase_<n>"]}` (the inert basic subcase beside it reaches no unit) |
| `operation:<uuid>` (a stored operation) | `{save-to-case, repeat?, path: ["nova_operations", <name>]}`, the name `main`'s `planGeneratedNodes` gives it |
| `own-close` | `{save-to-case, repeat?, path: ["nova_operations", "nova_condition_close", "nova_close"]}` with `main`'s suffixing, where `closeConditionPlacement` gave `save-to-case`; none otherwise |
| `operation:<uuid>` removed by C9 | the path the operation had, which section 8.3 gives the own close |
| `query-repeat:<uuid>` | model iteration |

### 8.3 The holds

For each unit `U` of form `F` with today's placement `T(U)`:

1. **Carried.** A `readable` baseline carries `U` when `publishedCaseBlocks(source).get(xmlns)` (`xmlns` =
   `targetWireIdentity(overrides).formXmlns(F)`) lists a block at `T(U)`'s identity: `basic-own` of the
   module's case type for `own`; `basic-usercase` for `usercase`; `basic-subcase` with `index`, `caseType`
   and `repeatContext` equal for a subcase; the same with `path` equal to its `repeatContext` for a
   subcase row; a `save-to-case` block whose path is the unit's scope path joined with `T(U).path` and
   whose `caseType` is the unit's, or `null`; for a query repeat, its row's data path among
   `modelIterationRows`. Paths are the target's data paths, so a question renamed since the push leaves
   its unit uncarried, and that unit's path moves at the next publish as it would have before step 5.
2. **Held.** `U` is held at `T(U)` where some `readable` published baseline carries it, or where some
   published deployment's baseline is `unknown` (decision 5 of step 5's plan), and in either case
   `holdExpresses(target, entry)` holds for the entry `{target: U's target, placement: T(U)}`. A unit
   that already holds a placement keeps it, so a second application holds the same.
3. **Not held** are exactly the exceptions of section 8.5. Any other unit that should be held but whose
   `T(U)` the head cannot express is the blocker `placement-path-mismatch`, a defect of the stack (part 01
   §22).
4. **Unpublished apps** hold nothing.

Holds are written by one `holdPlacements` mutation per app (part 03 §2.2, applied through the reducer
like every step's mutations; the kernel rule does not apply, because no batch reaches the kernel),
in document order: `case-operation` entries for operations, an `own-close` entry for a form's own close,
and `query-repeat` entries with `"model-iteration"`. No `module-kind` entry is ever written (no module is
advanced before step 5).

### 8.4 The verification

After the holds, for each form with a held unit, `planFormCaseWire(target, F)` (part 02) must emit each held
unit at exactly `T(U)`'s identity: the slot and index for a basic one, the scope and every path segment for
a Save to Case one. A difference is `placement-path-mismatch`. The postcondition of section 14 repeats it
over the stored target and the locked baselines.

### 8.5 The units never held

| Class | Why | Its cause in section 9 |
|---|---|---|
| a create a link carries, of any relationship (part 02 M1): made advanced, or with its links retargeted where a blocker holds | the inert subcase that gave its datum goes; the advanced open action is its new place, which a held Save to Case path could not express, and a retargeted create's Save to Case placement is never held either, even where a baseline holds its `nova_subcases` block | `extension-case-moved` for an extension; `module-made-advanced` for a form of a module made advanced |
| every unit of a form of a module M1 makes advanced (part 02 M3) | the module's next publish writes advanced actions and records them | `module-made-advanced` |
| a basic child whose `main` index counted an inert extension subcase (part 02 M2) | the index no longer exists; held instead at the head's index where the baseline carried it at the old one (part 02 §23), so it moves once | `subcase-renumbered` |
| the own arm of a registration under part 01's C11 | the basic own slot is ineligible (`case-changed-before-create`) | `case-changed-before-create` |
| a query repeat the rule gives the count placement (part 04 Q1) | model iteration is defect 25's shape and `QUERY_REPEAT_MODEL_ITERATION_SHAPE` refuses it; under decision 5 as well (part 04 §7.1) | `repeat-rows-follow-query` |
| the own close where C9's operations all held writes | its path stays with the `update` operation the writes became | `own-close-moved` |

### 8.6 The frozen classifier, checked on production

For each `readable` published deployment whose `pushedRevision` equals the app's `mutation_seq` at the fleet
read (no edit since that push), the dry run compares `T(U)` for every unit with what the baseline carries,
both ways: a unit the baseline does not carry at `T(U)`, and a baseline block at an identity no unit's
`T(U)` names. The report's `placements` line counts `frozenChecked` (deployments) and `frozenDisagrees`
(units and blocks); `--debug-details` names them by form. Gated run G6 settles a non-zero count before the
window.

**What production holds.** Published apps exist, with baselines of origin `cutover` and `push`, and
production holds a published deployment whose baseline is `unread`. So decision 5's rule applies at the
window: each such app holds every unit today's placement can express, its query repeats the rule gives
the count placement move to it unheld (section 8.5), and each such deployment gets
`placements-kept-unread`; the runbook records in words that some published apps kept today's placements
this way. Production holds no baseline that fails gunzip, its digest or its parse, so
`baseline-unreadable` meets no app today; the dry run counts any.

No published baseline holds a `nova_subcases` block, so no HQ app holds an extension child's Save to
Case block at Nova's path, no extension path is held at the window, and from step 5 no export writes one.
An author can still publish one until the window closes ingress, so the rule ships and the dry run counts
it: such a block is held at its path unless a link carries its create (section 8.5); production holds none
today.

## 9. Deployment lines

`deployment-lines` writes nothing. Over each **live** deployment (a live `app` mapping, published or not),
in the order of `DEPLOYMENT_NOTICE_REASONS`:

- **`deep-links-need-republish`** (existing), on every live deployment of an app with entry points
  (`lib/domain/entryPoints.ts::entryPointInventory` non-empty): the horizon's `+1` makes every manifest's
  `sourceSequence` stale.
- **`placements-kept-unread`** (new; part 03's reason and copy), no `detail`, on each published deployment
  whose baseline is `unknown`.
- **`form-data-paths-move`** (new), on each published deployment where at least one case block or answer
  path moves at its next publish: `detail.forms` (the count of forms with a move) and `detail.causes` (the
  comma-joined cause ids present, in the order below). For a `readable` baseline, a move is a block
  `publishedCaseBlocks` lists that the head emission of the same form (`planFormCaseWire` over the target)
  no longer writes at that identity, and a model-iteration row the head writes as a count placement; for
  an `unknown` one, it is a unit whose `T(U)` the head no longer emits, which only section 8.5's classes
  can be. Causes, each from the unit today's placement put at that identity:

  | Cause | When |
  |---|---|
  | `subcase-renumbered` | a basic child after an inert extension subcase (part 02 M2) |
  | `extension-case-moved` | a carried extension create (part 02 M1) |
  | `module-made-advanced` | any unit of a form of a module M1 makes advanced (part 02 M3) |
  | `repeat-rows-follow-query` | a query repeat moved to the count placement (part 04 Q1) |
  | `count-node-removed` | a count repeat whose `nova_count_<repeat>` node leaves the wire (part 04 Q3) |
  | `case-changed-before-create` | part 01's C11 |
  | `own-close-moved` | C9's own close, where its operations held writes |
  | `placement-simplified` | a block at an identity no unit of today's document holds there (the document changed since that push); it moved at the next publish before step 5 too, and is listed so the line is complete |

- **`case-attachments-stop`** (new), on each published deployment whose app held an attachment-mode write
  (`LiftedFacts.attachmentFields` non-empty) and whose baseline is `unknown`, or `readable` with a block of
  `publishedCaseBlocks` whose `properties` map one of those fields' properties to the capture question's
  own data path, which is how `main` wrote attachment mode (`lib/commcare/formActions.ts::
  caseUpdateQuestionPath` names the upload question, and HQ's build turns that update into an
  `<attachment>` block): `detail.properties` (the count of properties).
- **`next-publish-asks-more`** (existing), on each published deployment where the target needs a
  confirmation or capability its last publish did not:
  - `detail.settings` holding `commtrack-off` where part 03's
    `lib/commcare/planPrivileges.ts::commtrackReasons(target)` is non-empty (part 03 §18 class 3);
  - `detail.capabilities` holding `same-type-child-links` where part 03's
    `lib/commcare/sameTypeChildCases.ts::sameTypeBasicChildCases(target)` is non-empty and none of those
    creates is held (part 03 §18 class 4);
  - `detail.planFeatures` holding each plan feature `lib/commcare/planPrivileges.ts::requiredPlanFeatures`
    names for the target that today's placements did not need: in practice `save_to_case`, where today's
    placements put no unit of the app in a Save to Case block and the target's put one there (C11's own
    arm, or an own close C9 left without its path).

**The supply-point text.** The planning scan did not count a published form holding the supply-point
text, so both outcomes stand and the advisory dry run decides between them: *where it finds none*, no line
carries `commtrack-off` and the runbook says so in words; *where it finds some*, each live deployment of
such an app gets it. No app holds an advanced module before the window, and no migration makes one whose
case list menu item is on (part 02 makes advanced only modules whose forms need it, and no carried create
exists in production, section 7.6), so the menu arm adds no line in either outcome.

**Same-type children.** Production holds no basic child of its module's own case type (defect 12's
shape), so no line carries `same-type-child-links` at the window. An author can make one until the window,
so the class ships and the dry run counts it: each live deployment of a published app whose migrated
document holds an unheld one gets the line, and its next publish probes the flag; production holds none
today.

**Attachment mode.** Production holds no capture write of any mode, so no `capture-saves-link` or
`case-attachments-stop` line is written today. Both reasons ship, with C5's transform: `main` serves until
the window closes ingress, so an author can add an attachment-mode write until then, and the window's dry
run counts it; each such field then gets its document line and each published deployment of its app its
deployment line. Production holds none today.

## 10. Derived identities, the plan, its digest and the report

### 10.1 Operations made from field writes (pull request 4)

Every identity the cutover writes is derived, so the dry run and `--execute` build the same plan and the
fuzz mapping draws nothing (part 08 §4.3). `lib/domain/caseWriteOperationIdentity.ts` (new, pull request
4, kept after pull request 16), after `lib/domain/datetimeSplitIdentity.ts`:

```ts
import { v5 as uuidv5 } from "uuid";
import type { Uuid } from "./uuid";

/**
 * The UUIDv5 namespace of the case operations made from a form's field writes: the own arm, a child or
 * extension create per bucket, the worker-record update. Derived, never random, so the same
 * migration planned twice (a dry run and its execution, or a fuzz draw mapped twice) names the same
 * operations.
 */
export const CASE_WRITE_OPERATION_NAMESPACE_UUID = "2d4b57b2-18ff-430a-b230-8eec087cdfc1";
const CASE_WRITE_OPERATION_VERSION = "nova-case-writes-op-v1";

/** `own`, `usercase`, `child:<case type>:<repeat uuid or root>`, `extension:<case type>:<repeat uuid or root>`. */
export type CaseWriteOperationUnit =
	| "own"
	| "usercase"
	| `child:${string}:${string}`
	| `extension:${string}:${string}`;

/** The name is the JSON array of the version, the app, the form and the unit, with the attempt
 *  appended after the first, so a UUID already taken in the document is stepped around. */
export function caseWriteOperationUuid(
	appId: string,
	formUuid: Uuid,
	unit: CaseWriteOperationUnit,
	attempt = 0,
): Uuid;
```

`operationsFromFieldWrites` takes the first attempt whose UUID no entity of the document holds (the global
entity-UUID namespace, `lib/domain/authoredIdentities.ts`). The operations' `id`s are the ones part 01
gives (the own arm the module's case type made unique, a create its type made unique, through
`lib/domain/idSlug.ts::suffixUntilFree` over the form's operation ids). The unit keys are section 8.2's,
so each held placement finds its operation by key.

### 10.2 The plan

```ts
interface CaseWritesCutoverPlan {
	readonly format: "hq-round-trip-case-writes-1";
	readonly apps: readonly AppPlan[];       // every app, deleted ones included, in code-point order of id
	readonly digest: string;                 // lib/utils/canonicalJson.ts::canonicalJsonDigest of { format, apps }
}
interface AppPlan {
	readonly appId: string;
	readonly projectId: string;
	readonly deleted: boolean;
	readonly baseSeq: number;
	readonly baseDigest: string;             // oldShape.ts::rawDocumentDigest of the carriers as read
	readonly targetDigest: string | null;    // canonicalJsonDigest(toPersistableDoc(target)); null where blocked
	readonly deployments: readonly {
		readonly deploymentId: string;
		readonly baseline: "readable" | "shell" | "unread" | "absent" | "unreadable";
		readonly sourceDigest: string | null;
		readonly observedAt: string | null;
	}[];
	readonly changes: readonly PlannedChange[];   // { step, kind, entityUuid, detail: counts }
	readonly held: readonly HeldUnit[];           // { target: "case-operation" | "own-close" | "query-repeat", formUuid, uuid, placement }
	readonly pathMoves: readonly PathMove[];      // { deploymentId, forms, causes }
	readonly notice: readonly MigrationNoticeEntry[];
	readonly blockers: readonly CutoverBlocker[]; // { code, count, findingCodes }
	readonly schemaChanges: readonly PlannedSchemaChange[]; // { caseType, cause, properties: count }
	readonly discardsPrivateWork: boolean;
}
```

The digest covers everything the writer writes and every input that decides it, and nothing in it comes
from outside the database: a baseline's bytes enter as its `sourceDigest` and its `observedAt`, so a
baseline that moved moves the digest. The batch id and actor are the marker pair; the advisory lock key is
`pg_advisory_xact_lock(hashtextextended('cutover:hq-round-trip-case-writes', 0))`.

`types.ts` holds the registries:

```ts
export const STRUCTURE_STEPS = ["renamed-concepts", "capture-link-writes", "close-condition-expression", "field-writes-lifted", "search-first-lifted"] as const;
export const SEMANTIC_STEPS = ["writes-into-operations", "form-link-semantics", "extension-children", "explicit-preloads", "search-workflow", "query-repeat-placement", "repeat-counts", "field-list-flags", "placements", "judge-target", "deployment-lines"] as const;
export const BLOCKER_CODES = ["renamed-concept-conflict", "structure-parse", "transform-admission", "own-close-in-repeat", "baseline-unreadable", "placement-path-mismatch", "target-parse", "target-gate", "target-export-readiness", "case-schema-unplanned", "not-idempotent"] as const;
export const STOP_CODES = ["blocker", "holder", "app-changed", "baseline-changed", "digest", "ledger", "partially-applied", "lock-timeout", "error"] as const;
export const PATH_MOVE_CAUSES = ["subcase-renumbered", "extension-case-moved", "module-made-advanced", "repeat-rows-follow-query", "count-node-removed", "case-changed-before-create", "own-close-moved", "placement-simplified"] as const;
export const SCHEMA_CAUSES = ["claim-type-row", "capture-link-property", "derivation-drift"] as const;
export const WRITER_STEPS = ["lock", "blocking-scan", "already-applied", "before-images", "ledger", "archive-events", "clear-streams", "private-work", "apps", "notices", "postconditions", "finish"] as const;
```

### 10.3 The report

Content-free JSON Lines in step 4's framing: each line `{ report: "hq-round-trip-case-writes", mode,
section, ... }`, one Cloud Logging entry a line, printed as made:

- `fleet`: apps, deleted apps, `planDigest` (null in the scan), `fleetSeqDigest` (the digest of every
  `[appId, mutation_seq]`), `ledger` (`horizonApplied`, `pendingMigrations`), plan milliseconds, peak RSS,
  database size;
- `structure`: per structure step, apps and entities changed; M4's dead media count; M5's overlay entries
  moved;
- `steps`: per semantic step and change kind, apps and entities; non-extension carried creates apart;
- `placements`: published apps, deployments by baseline kind, units held by target and by source
  (`carried`, `unknown-baseline`), units not held by section 8.5's class, `frozenChecked`,
  `frozenDisagrees`;
- `path-moves`: per cause, deployments and forms;
- `notice`: per reason, entries and apps;
- `schema`: per section 12 cause, apps, case types and properties, and the count against the stored rows
  as the drift scan will count them;
- `holders`, `private-work` (open workspaces, change sets, active candidates, pre-app sessions, mutation
  events);
- one `blocker` line per code: count, app ids, finding codes;
- under `--rehearse` and `--execute`, `writer`: each writer step's milliseconds, the WAL and growth,
  `migrationsApplied`;
- `outcome` last: `ok`, `already-applied`, or `stopped` with any of the stop codes, or `error` with its
  `errorClass`.

App ids, deployment ids, migration names, step ids, codes and counts only: never a name, a label, an
expression, a property or a value. A run that throws still prints its `outcome` line; its stderr holds
this cutover's own message or the error's class alone.

## 11. The ledger in the window

| Migration | Pull request | What it does | Why in the window |
|---|---|---|---|
| `20261110000000_hq_round_trip_case_writes_publish_placement` | 6 (part 03 §4.2) | `CREATE OR REPLACE FUNCTION public.nova_admit_app_change_insert()` with `'publish-placement'` in the closed kind set and its arm | additive in effect; it rides the window so the ledger moves once |
| `20261110010000_hq_round_trip_case_writes_commtrack_confirmation` | 8 (part 03 §9) | `app_deployment_confirmations_kind_check` widened with `'commtrack-off'`, and `app_deployment_confirmations_commtrack_subject` | additive |
| `20261110020000_hq_round_trip_case_writes_fold_horizon` | 14 (section 1) | the sixth fold identity | the markers need it |

No other pull request of the stack adds a ledgered migration. One that does takes a stamp that sorts in
pull request order before the horizon's and joins this table; `writer.postgres.test.ts`, which starts
from `main`'s migration prefix, holds the reviewed set to the stack's.

**One phase.** No validation follows a backfill, so `ledger.ts::applyLedgerTo(tx,
"20261110020000_hq_round_trip_case_writes_fold_horizon")` (step 4's, `a8af778e:scripts/lib/
hqRoundTripPlatforms/ledger.ts`, with one target) runs after the blocking scan, the already-applied check
and the before-images, and before the first write: Kysely's migration lock, the pending set checked, `new
Migrator({ db: tx, provider }).migrateTo(target)` with each migration in its own savepoint inside an outer
one, `SET LOCAL lock_timeout = '15s'` again after Kysely's lock. The pending set must be exactly the three
names, and the run must apply exactly them; any other ledger stops with `ledger` and nothing written:
"The migration ledger is not the one this cutover was reviewed against: it expected exactly {names} to be
pending and found {names}. The cutover stopped with nothing written and no migration applied. Compare a
dry run's ledger line with main's migrations, and find out how the ledger moved before running again."

After the commit the deploy's migrate Job applies none of them and runs its runtime probe. A deploy from
`main` between the execute run and the merge would meet a ledger naming migrations `main` lacks, which
Kysely's `Migrator` refuses (runbook check 3).

## 12. The case store

The fleet transaction writes no case schema row. `judge-target` compares
`lib/case-store/store.ts::buildCaseTypeMap(toPersistableDoc(target))` with the app's active
`public.case_type_schemas` rows through `scripts/lib/schemaDrift.ts::computeSchemaDrift`'s comparison (the
function the drift scan and writer use, so the cutover's count and the writer's work are one computation),
and each difference must be one of the planned causes:

| Cause | What | Why it is planned |
|---|---|---|
| `claim-type-row` | the `commcare-case-claim` row is missing (`missingRow`, no properties) | part 05 §10.2 puts the claim type in `buildCaseTypeMap` from pull request 10 and makes every new app hold its row from genesis; existing apps gain it through the drift writer after the deploy (part 05's M6) |
| `capture-link-property` | a property only attachment-mode writers wrote, now written as a link (text) | C5; whether `main` materialized an attachment slot decides whether it is `added` or `refined`, and the line counts both |
| `derivation-drift` | a difference the merged code derives from an unchanged document | counted as step 4's `schema-drift` line counted it |

Any other difference is `case-schema-unplanned`, a defect of the stack: field writes moved into operations
must derive the same property types (part 01's obligation, its `buildCaseTypeMap` equality test).

`computeSchemaDrift` skips a missing worker's-record row (`USERCASE_CASE_TYPE`, "made by the first sync that
touches it"); it does **not** skip `commcare-case-claim`, so the drift writer creates that row in every app
it reads (part 05's pull request 10 leaves that function's loop as it is; section "What other parts read").

**Convergence after the deploy, before ingress reopens** (runbook step 9): the existing drift writer
(`schema-drift.cjs --execute` on `commcare-nova-case-type-schema-retirement`) re-syncs every planned
difference, the claim rows included, and the drift scan after it reports none. *Departure* from the
search-and-menus brief's M6, which materialized the claim row inside the cutover (part 05's M6 adopts it): the fleet transaction's postcondition that every
schema row equals its before-image is what proves it touched no case data, step 3's and step 4's windows
converged schema drift this same way, and no request reads a claim row while ingress is closed.

## 13. The fleet transaction, step by step

Before it opens: the already-applied reads; the ledger read; the fleet read in one `REPEATABLE READ, READ
ONLY` transaction (`source.ts`: every app's carriers, deleted ones included; every published deployment
with its baseline, overrides and pushed revision, section 8.1; each Project's lookup definitions and media
records; the private-work census; every active `case_type_schemas` row); the transforms; the plan and its
digest check under `--execute`: "This run's plan has digest {d}, not the {expected} the dry run printed,
so it wrote nothing. Something in the database moved after the dry run. Compare the two runs' reports,
then run the dry run again and pass its digest." A plan holding any blocker refuses too.

Then one transaction, the writer's named steps:

1. `lock`: the advisory lock; `SET LOCAL lock_timeout = '15s'`; `pg_current_wal_lsn()`.
2. `blocking-scan`: every `public.apps` row `FOR UPDATE` in id order; every `public.design_sessions` row
   `FOR UPDATE`; every published deployment's `public.app_deployment_baselines` row `FOR SHARE`. The locked
   app ids equal the plan's, and each app's `mutation_seq` and raw digest equal the plan's
   (`app-changed`); each baseline's `source_digest`, `observed_at` and origin equal the plan's
   (`baseline-changed`); `holders.ts::readHolderCensus` is empty (`holder`). A row-lock wait past
   `lock_timeout` stops as `lock-timeout` (#823's correction). Each stop writes nothing.
3. `already-applied`: the two reads of section 6, under the locks.
4. `before-images`: every `public.case_type_schemas` row as text; the `cases` count per app (read from the
   case store's own relation, `nova_case_runtime.cases` where it exists, else `public.cases`, as
   `nova_create_app_test_namespace` resolves it); every `public.app_deployment_*` row as text.
5. `ledger`: section 11.
6. `archive-events`: step 3's statement, `UPDATE events SET kind = 'archived-mutation', event =
   jsonb_build_object('kind', 'archived-mutation', 'runId', event -> 'runId', 'ts', event -> 'ts', ...)
   WHERE kind = 'mutation'` (`733dd193:scripts/lib/hqRoundTripExpressions/writer.ts`).
7. `clear-streams`: step 3's statements over `chat_stream_chunks`, `presence` and `threads.active_*`.
8. `private-work`: step 3's `abandonPrivateWork`: each pre-app session that holds open work ends through
   `abandonPreAppDesignSessionInTransaction`; `authoring_sessions.active_candidate_id` cleared; open
   `authoring_workspaces` and `design_change_sets` set `abandoned`.
9. `apps`: per app in code-point order of id, section 4's `writeApp`.
10. `notices`: one `INSERT INTO app_migration_notices (app_id, cutover, entries) VALUES (<app id>,
    'hq-round-trip-case-writes', <entries>)` per app with at least one entry, its entries parsed by
    `lib/notices/migrationNotice.ts::migrationNoticeEntriesSchema` first.
11. `postconditions`: section 14.
12. `finish`: `pg_database_size(current_database())` and `pg_wal_lsn_diff` from step 1's position; under
    `--execute`, `notifyAppStream` for each app at `baseSeq + 1`; under `--rehearse`, the sentinel
    rollback; commit.

**Capacity.** Like step 3's: every entity row of every app rewritten and one baseline snapshot per app. Step
3's archived execute report (`gs://commcare-nova-cutover-evidence/hq-round-trip-expressions/`, its `writer`
line) bounds it, and the runbook compares that with the instance's free storage before the window.

## 14. Postconditions

Inside the transaction; any failure rolls everything back, the DDL with it:

- Every app, deleted ones included, loads through `lib/db/canonicalCommitKernel.ts::loadAppInTransaction`
  (strict schema and the absolute gate), and its `canonicalJsonDigest` is its `targetDigest`.
- Each app has the marker row at `baseSeq + 1` (kind `fold-baseline`, `mutations '[]'`, `run_id` null) and
  its baseline row, and `lib/agent/change-set/baseLoader.ts::loadCanonicalBlueprintAtSequence(tx, { appId,
  seq: baseSeq + 1, expectedDigest: targetDigest })` folds to it.
- Every held placement in the stored target equals the plan's, `planFormCaseWire` emits each at its
  identity (section 8.4), and each one held because a baseline carried it is still carried by the locked
  baselines.
- `events` holds no `mutation` row; no open workspace, open change set or active candidate; no stream
  holder.
- Every `case_type_schemas` row and every `app_deployment_*` row equals its before-image; every app's
  `cases` count is unchanged.
- Exactly the planned notice rows.
- The ledger holds the three migrations, and through `catalog.ts` (section 15):
  `routineDefinition(tx, "public", "nova_admit_app_change_fold_baseline_insert()")` and
  `routineDefinition(tx, "public", "nova_require_app_change_fold_baseline()")` each hold
  `'fold-baseline:hq-round-trip-case-writes'`; `routineDefinition(tx, "public",
  "nova_admit_app_change_insert()")` holds `'publish-placement'`;
  `constraintDefinition(tx, "public", "app_deployment_confirmations", "app_deployment_confirmations_kind_check")`
  holds `'commtrack-off'`, and `constraintDefinition(tx, "public", "app_deployment_confirmations",
  "app_deployment_confirmations_commtrack_subject")` exists.

Outside it, two measurements complete the proof, each a runbook step: the deploy's migrate Job's runtime
probe (`lib/db/runtimeDatabaseProbe.ts::runCanonicalRuntimeDatabaseProbe`: every app decoded by the new
image and gated), and the drift scan reporting none after the drift writer (section 12).

## 15. `catalog.ts` and the heap-order test

### 15.1 The module

`scripts/lib/hqRoundTripCaseWrites/catalog.ts` holds every `pg_catalog` read the cutover and its tests make,
and each names its relation by schema and name, never by a constraint or routine name alone and never
through the session's `search_path`:

```ts
/** pg_get_constraintdef of the named constraint of the named relation. */
export async function constraintDefinition(
	tx: Kysely<AppDatabase> | Transaction<AppDatabase>,
	schema: "public",
	table: string,
	constraint: string,
): Promise<string>;
// SELECT pg_catalog.pg_get_constraintdef(c.oid) AS definition
// FROM pg_catalog.pg_constraint AS c
// WHERE c.conrelid = pg_catalog.to_regclass(pg_catalog.format('%I.%I', ${schema}, ${table}))
//   AND c.conname = ${constraint}

/** Every constraint of the named relation, by name, with its definition (for byte-identical images). */
export async function relationConstraints(tx, schema: "public", table: string): Promise<ReadonlyMap<string, string>>;

/** pg_get_functiondef of the routine the schema-qualified signature names. */
export async function routineDefinition(tx, schema: "public", signature: string): Promise<string>;
// SELECT pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure(pg_catalog.format('%I.%s', ${schema}, ${signature})))

/** Every routine of the schema, by signature, with its definition (for byte-identical images). */
export async function schemaRoutines(tx, schema: "public"): Promise<ReadonlyMap<string, string>>;
// WHERE p.pronamespace = pg_catalog.to_regnamespace(${schema})
```

Each throws where `to_regclass`, `to_regprocedure` or `to_regnamespace` answers null, or where no row
answers: "The catalog has no {kind} {name} on {schema}.{relation}, which this cutover reads to prove its
migrations applied. The cutover stopped; compare the ledger with main's migrations." Production keeps
`cases` in `nova_case_runtime`; the cutover reads no catalog row of it. Part 05's own checks follow the same
rule (`public.case_type_schemas`).

### 15.2 The test

`scripts/lib/hqRoundTripCaseWrites/__tests__/catalog.postgres.test.ts`, real Postgres, a per-test database
(`lib/db/__tests__/appStateTestDb.ts::setupAppStateTestDb("case_writes_catalog_", { authSchema:
"migrated", caseStoreMigrationsBefore: "20261110000000_hq_round_trip_case_writes_publish_placement" })`),
in this order:

1. `VACUUM FULL pg_catalog.pg_constraint` and `VACUUM FULL pg_catalog.pg_proc`, so each heap is compacted
   and later tuples are appended after the existing ones.
2. **The app-test namespace decoy.** `SELECT public.nova_create_app_test_namespace(gen_random_uuid())`
   gives a real namespace `nova_app_test_<hex>` (it copies `apps`, `case_type_schemas` and the other test
   tables with their constraints, as production's do). Inside that namespace the test also creates
   `app_deployment_confirmations (LIKE public.app_deployment_confirmations INCLUDING CONSTRAINTS)` and the
   three routines `nova_admit_app_change_insert()`, `nova_admit_app_change_fold_baseline_insert()` and
   `nova_require_app_change_fold_baseline()` with their bodies as `public` holds them before the
   migrations (read through `routineDefinition` and re-targeted at the namespace).
3. `ALTER DATABASE <the per-test database> SET enable_indexscan = off` (the per-test database dies with the
   test, so the setting does not outlive it; step 4's harness set it on a shared database) and `SET
   enable_indexscan = off` for the session.
4. The three migrations, through the production `Migrator`: the commtrack migration drops and re-adds
   `public.app_deployment_confirmations_kind_check`, and the other two replace their routines, so each live
   tuple is appended after the decoy's.
5. **The precondition, observed by `ctid`, never assumed**: the decoy's `pg_constraint` row for
   `app_deployment_confirmations_kind_check` has a lower `ctid` than the live one, and a name-only read
   (`SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname =
   'app_deployment_confirmations_kind_check' LIMIT 1`) returns the decoy's four-kind definition; the same
   for `pg_proc` and `nova_admit_app_change_insert`, whose name-only read returns the decoy's body without
   `'publish-placement'`.
6. Then every `catalog.ts` function returns the live definition: `constraintDefinition` holds
   `'commtrack-off'`, `routineDefinition` holds `'publish-placement'` and the marker, `relationConstraints`
   of `public.app_deployment_confirmations` lists the live constraints only, and `schemaRoutines` of
   `public` holds none of the namespace's routines. Each function throws its sentence for a missing
   relation, constraint and routine.

`writer.postgres.test.ts` seeds the same decoy, and its `databaseImage` reads every constraint and routine
through `relationConstraints` and `schemaRoutines` (section "Tests"), so the byte-identical assertion after a
failure at each writer step sees the live objects, never the namespace's copies (the gap section 21.2
records in step 4's test). Gated run G5 is this test's first CI run.

## 16. The blockers

Each stops the cutover before its first write, for the remedy its row names. The advisory runs are where
each is first met; a non-zero count there is an ordinary result, and the dry run in the window must count
none. The person is the fleet's author during dogfooding, so an author's remedy is theirs, made in today's
builder before the window. A blocker in a deleted app is resolved by restoring the app, making the change,
and deleting it again.

| Code | Meaning | Remedy |
|---|---|---|
| `renamed-concept-conflict` | a module holds two no-matches forms, a document `main`'s gate never admitted | a data repair: remove one form's no-matches entry in today's builder |
| `capture-write-unlinkable` | a stored operation saves a capture's bare answer as a case's name or external id, or to a property whose type holds no text, where the head's link to the file can't be saved (section 7.4, clause 0) | the author's: save the file to a property of its own in today's builder |
| `own-close-in-repeat` | a follow-up's `close` operation on the form's own case runs once per repeat row | the author's: remove that operation and set the form's close condition (a close form) in today's builder |
| `own-close-condition-reads-case` | a `close` operation on the form's own case, or a retype it follows, has a condition reading what the form's close condition can't: another type's case, one linked other than through parent links, its case under a type a retype gave it, the cases linked below it, or a value only a case change has (section 7.4) | the author's: rewrite the condition over the form's answers, its case and the cases above it, or remove the operation and set the form's close condition in today's builder |
| `baseline-unreadable` | a published deployment's stored baseline fails gunzip, its digest or its parse (section 8.1); production holds none today | a data repair: refresh that deployment, which reads CommCare HQ again (part 03's remedy); then the dry run repeats |
| `structure-parse`, `transform-admission`, `placement-path-mismatch`, `target-parse`, `case-schema-unplanned`, `not-idempotent` | a defect of the stack | fixed in the pull request that owns the step, with the review rule of section 21.3 |
| `target-gate`, `target-export-readiness` | the target fails the absolute gate or export readiness; the line carries the finding codes and `details.reason` | the author's where the finding is about the app (its message names the move; the rules below); a defect of the stack where a step should have changed it |

**Blockers by rule**, each met as `target-gate` with its code and each the author's, since each needs a
choice only the author can make:

| Rule | The author's remedy |
|---|---|
| a query repeat whose query reads answers inside its own rows, a `CYCLE` once it takes the count placement (part 04 §7.1 (a)) | read the answer from outside the repeat, or make the repeat a user repeat |
| a query repeat whose stored `relevant` stops type-checking at the row, after part 04's rewrite (part 04 §7.1 (b)) | rewrite the condition over the row's own values |
| under part 02's G4 outcome B, a write of a worker property whose slug starts with `_` (`WORKER_PROPERTY_WRITE_NAME`) | rename the property so it starts with a letter (`main`'s publish could not have published it: HQ's build refuses the basic write) |

The planning scan did not count these three shapes, so both outcomes stand and the advisory dry run
decides between them: *where it finds none*, it counts no blocker by rule, and the rules ship for whatever
changes before the window; *where it finds some*, each is named only in the evidence archive (by app id and
finding code, with places through `--debug-details` on the operator's terminal) and resolved by its remedy
before the window, as step 4's were.

Stops that are not an app's: `holder`, `app-changed`, `baseline-changed`, `digest`, `ledger`,
`partially-applied`, `lock-timeout`, `error`.

## 17. The notice

### 17.1 The cutover, its lead and its reasons

`lib/notices/migrationNotice.ts::MIGRATION_NOTICE_CUTOVERS` becomes `["hq-round-trip-emission",
"hq-round-trip-expressions", "hq-round-trip-platforms", "hq-round-trip-case-writes"]`, and
`lib/notices/migrationNoticeCopy.ts::MIGRATION_NOTICE_LEADS` gains:

> `On ${day}, Nova changed how it stores what forms save to cases, where workers go after a form, and how some questions are counted and shown. Here is what that means for this app.`

`NOTICE_ENTITY_TYPES` is unchanged: every line names a module, form or field, and a link or an operation
is named in `detail`. `lib/notices/store.ts` reads the table tolerantly, so earlier rows keep rendering.

`DOCUMENT_NOTICE_REASONS` gains eighteen reasons after `media-not-played-removed` and before
`lookup-tag-renamed`, in step order (decision 13 of step 5's plan, which holds C9's `form-became-close-form`, section 7.4,
with part 06's `form-link-removed`, section 7.5, and the stored capture reads' `capture-saves-link-not-name`,
section 7.4): `capture-saves-link`, `capture-saves-link-not-name`,
`form-became-close-form`, `form-links-conditions-written`, `form-link-otherwise-set`,
`after-submit-destination-dropped`, `form-link-target-moved`, `form-link-removed`,
`form-link-datums-dropped`, `module-made-advanced`, `form-link-goes-to-menu`,
`starting-value-reads-case`, `load-time-value-reads-case`, `menu-opens-on-search`,
`repeat-rows-follow-query`, `repeat-count-whole-number`, `repeat-count-node-removed`,
`group-shows-one-per-screen`.

`DEPLOYMENT_NOTICE_REASONS` gains three after `data-paths-move-once` and before
`expressions-sent-at-next-publish`: `placements-kept-unread`, `form-data-paths-move`,
`case-attachments-stop` (what is kept, then what moves, then what stops). The reused reasons:
`unsaved-assistant-work-discarded` (document, the app), `deep-links-need-republish` and
`next-publish-asks-more` (deployment).

Every other reason name in the briefs maps onto these (decision 13): the case-writes brief's
`attachment-to-link` is `capture-saves-link`, `preload-replaced-default` is `starting-value-reads-case`,
`preload-later-reader` is `load-time-value-reads-case`, and `case-writes-held` has no line (a kept
placement changes nothing anyone sees); the form-links brief's `form-link-conditions-explicit`,
`form-link-otherwise`, `form-link-unused-after-submit-removed`, `form-link-target-moved-to-parent`,
`form-link-carried-values-removed` and `form-otherwise-moved` are part 06 §14.3's mapping; the questions
brief's `query-repeat-rows-follow-form` and `group-one-question-per-screen` are `repeat-rows-follow-query`
and `group-shows-one-per-screen`.

### 17.2 The copy

`{Name}` is the entity's current name, or its `nameAtMigration` where it no longer exists; `{form}` and the
other lower-case names come from `detail`. Without `detail.form`, a line opens with the entity. A value an
older renderer does not know falls back to the sentence without it, as step 4's renderers do. Each reason
has exactly one renderer. Every line follows `design/readme.md`, "Content fundamentals": sentence case, no
em dash, no ellipsis in a control, what changed, what a worker or a person sees, and what is theirs to do.
The control names are part 07's (**Saves to**, **Otherwise**, **When this menu opens**, **Show on one
screen**).

| Reason | Entity | `detail` | Copy |
|---|---|---|---|
| `capture-saves-link` | field | `form`, `property` | "{form}, {Question}: it now saves a link to the file in {property}, where it saved the file itself on the case. Files already saved on cases stay there." Without `property`: "…it now saves a link to the file on the case, where it saved the file itself. …" |
| `capture-saves-link-not-name` (section 7.4) | field | `form`, `property` | "{form}, {Question}: it now saves a link to the file in {property}, where it saved the file's name. Cases saved before keep the name." Without `property`: "…it now saves a link to the file on the case, where it saved the file's name. …" |
| `form-became-close-form` (section 7.4) | form | none | "{Form} is now a close form, because one of its case changes already closed its case. Its close condition says when, and workers see no difference." |
| `form-links-conditions-written` | form | `links` | "{Form}: Nova wrote out the full condition of {links} of its after-submit destinations, so the same one runs as before." With `links` 1: "…of one of its after-submit destinations…"; without: "…of its after-submit destinations…" |
| `form-link-otherwise-set` | form | `to` or `toDestination`; `from` (L6) | "{Form}: when no destination applies, workers now go to {to}, set as the form's Otherwise. That is where they went before." With `from`: "{Form}: when no destination applies, workers now go to {to}, set as the form's Otherwise, because CommCare HQ doesn't offer {from} there." `toDestination` and `from` read through `OTHERWISE_DESTINATION_WORDS`: `firstMenu` "the first menu", `module` "this form's menu", `parentMenu` "the menu above this form's menu", `previous` "the screen before the form"; an unknown word reads "where its Otherwise says" |
| `after-submit-destination-dropped` | form | none | "{Form}: its After submit setting never ran, because one of its destinations always did, so Nova removed it." |
| `form-link-target-moved` | form | `from`, `to`; `cause` (L8) | "{Form}: its destination {from} now opens {to}, which holds it, because CommCare HQ can't link to {from} from here. Workers open {from} from {to}." Without names: "{Form}: one of its destinations now opens the menu that holds it, because CommCare HQ can't link there from here." With `cause` `carried-not-a-case` (part 06 §19.2, under its G2 outcome B), the renderer reads `cause` with its own sentence, since the reason's sentence is false for it: "{Form}: its destination {from} now opens {to}, the menu that holds it, because the value it carried isn't a case {from} can open. Workers choose the case there." An unknown `cause` reads as the sentence without it |
| `form-link-removed` (section 7.5; part 06 §14.4's copy) | form | `to` | "{Form}: its destination {to} is gone, because CommCare HQ can't link to {to} from here and the menu that holds it is hidden. Workers can still open {to} from its own menu." |
| `form-link-datums-dropped` | form | `to` | "{Form}: its destination {to} no longer carries cases, because a menu reads none." |
| `module-made-advanced` | module | `caseType` | "{Module}'s forms now create each new {caseType} case so the next form can open it. CommCare HQ shows this menu as an advanced menu from the next publish." |
| `form-link-goes-to-menu` | form | `to` (absent for the app home), `caseType` | "{Form}: after it, workers now go to {to} and choose the new {caseType} case there, because CommCare HQ can't take that case straight to the next form in this menu." Without `to`: "{Form}: after it, workers now go to the app home and open the new {caseType} case from its menu, because CommCare HQ can't take that case straight to the next form in this menu." |
| `starting-value-reads-case` | field | `form`, `property` | "{form}, {Question}: its starting value now reads the case's {property}, which you can change. That is what workers already saw, because the case's value replaced it when the form opened." |
| `load-time-value-reads-case` | field | `form`, `reads` | "{form}, {Question}: when the form opens, it now reads {reads} after {reads} takes the case's value. Before, it read the starting value {reads} had before the case's value replaced it." |
| `menu-opens-on-search` | module | `opensOn` | part 05 §14's two sentences: `search` "{Module} now opens on its Search screen in Web Apps, and workers see the case list after they search. CommCare HQ no longer offers the case list first for a menu that searches in Web Apps. On Android it still opens on the case list."; `results` "{Module} now opens on the cases its search finds in Web Apps, and workers can search again from there. CommCare HQ no longer offers the case list first for a menu that searches in Web Apps. On Android it still opens on the case list." Another or no `opensOn` reads as `search` |
| `repeat-rows-follow-query` | field | `form` | "{form}, {Repeat}: its rows now follow its query as the form is filled in, where they were the records found when the form opened." |
| `repeat-count-whole-number` | field | `form` | part 04 §7.2: "{form}, {Repeat}: its count is now written as int(...), so it always counts a whole number of rows. Workers see the same rows wherever the count was already whole." |
| `repeat-count-node-removed` | field | `form`, `hidden` | part 04 §7.2: "{form}, {Repeat}: it now reads its count straight from {hidden}, so its submissions no longer carry a copy of that count. CommCare HQ's form exports stop filling that column from your next publish." |
| `group-shows-one-per-screen` | field | `form` | "{form}, {Group}: on Android its questions now show one per screen, so workers can add rows to the repeat inside it. Web Apps shows them as before." |
| `placements-kept-unread` (deployment) | | none | part 03 §16: "Nova couldn't read the app {space} last received, so it kept where every form of this app saves its case changes there. Publishing again keeps them in the same places." |
| `form-data-paths-move` (deployment) | | `forms`, `causes` | "The next publish to {space} moves where {forms} forms of this app save some of their answers or case changes, because Nova changed how it writes them. CommCare HQ's form exports show those columns under their new names from then on." With `forms` 1: "…where one form of this app saves some of its answers or case changes…"; without: "…where some forms of this app save…". Where `causes` holds `module-made-advanced`, it adds: " CommCare HQ shows a menu of this app as an advanced menu from then on." |
| `case-attachments-stop` (deployment) | | `properties` | "From the next publish to {space}, this app saves a link to each captured file where it saved the file on the case. Files already on cases stay, and CommCare HQ's case exports gain a column for each link." |

**`next-publish-asks-more`** (existing), as part 03 §16 gives it: `detail.settings` holding `commtrack-off`
adds `COMMTRACK_OFF.label` ("CommCare Supply turned off") to the confirmed labels after
`FORM_ENTRY_SYNC_OFF.label`, and the sentence "CommCare HQ adds steps to this app where {space} has
CommCare Supply on, so Nova asks whether it's off."; `detail.capabilities` holding `same-type-child-links`
adds the capability's label ("Links between cases of the same type"), as every capability does, and the
sentence "{space} has to keep the link from a new case to the case of the same type it was made from, so
Nova checks that before the next publish there." The comment above the renderer names both ids.

### 17.3 Public docs that move with the notice (pull request 14)

A notice row names what changed from the moment the cutover commits, so these two passages land with it
(step 4's recorded exception to public docs landing in pull request 15; part 10 places every other
paragraph of the same files):

- `content/docs/publishing.mdx`, "Updates to review", first sentence: "When Nova changes how it stores,
  checks or writes apps, or where they run, an app it changed shows an update to review in the builder's
  header." becomes "When Nova changes how it stores, checks or writes apps, where they run, or where
  workers go after a form, an app it changed shows an update to review in the builder's header."
- `content/docs/mcp/tools.mdx`, the `get_app` row: "such as what Nova changed when it changed how it
  stores, checks or writes apps, or where they run" becomes "such as what Nova changed when it changed how
  it stores, checks or writes apps, where they run, or where workers go after a form".

## 18. Where it runs

**The Job.** `config/deployment-jobs.json` gains the contract `commcare-nova-hq-round-trip-case-writes`:
`serviceAccount` `nova-migrate@commcare-nova.iam.gserviceaccount.com`, `command` `["node"]`, `args`
`["hq-round-trip-case-writes.cjs"]` (the dry run), `tasks` 1, `parallelism` 1, `maxRetries` 0, `timeout`
`"7200s"`, `cpu` `"4"`, `memory` `"8Gi"`, `vpc` true, and `env` exactly `commcare-nova-historical-repair`'s
(`NOVA_DB_WORKLOAD` `migration`, `NOVA_DB_USER`, `NOVA_DB_INSTANCE_CONNECTION_NAME`, `NOVA_DB_NAME`,
`NOVA_MIGRATION_DB_USER`, `NOVA_RUNTIME_DB_USER`, `NOVA_CAPTURE_CLEANUP_DB_USER`, `NOVA_AUDIT_DB_USER`,
`NODE_OPTIONS` `--max-old-space-size=7168`, with the values that contract holds). No `NOVA_MEDIA_BUCKET`,
no KMS key: the cutover reads Nova's database alone.

- **Why its own Job.** Its stored arguments are this tool's dry run, so no execution runs another tool by
  omission (step 4's reason); `commcare-nova-historical-repair` stores `language-identity-repair.cjs`.
- **Why `7200s`.** The plan emits every form of every published app (`planFormCaseWire` for the
  verification and the deployment lines) and judges every app twice (the idempotence check); no planning
  read measured that. The advisory dry run measures it (gated run G3).

**The allowlist arm** (`scripts/rollout/deploy-cloud-run.py::_effective_execution_args`): a branch for
`short_name == "commcare-nova-hq-round-trip-case-writes"` admits exactly `(tool, "--settle-holders")` and
`(tool, "--execute", "--expect-plan-digest", <64 lowercase hex>)`, `tool = "hq-round-trip-case-writes.cjs"`;
with no override the Job runs its stored dry run. `PLAN_DIGEST_RE = re.compile(r"^[0-9a-f]{64}$")` returns
beside `APP_ID_RE` (#789 and #823 added it, #791 and #825 removed it). Every other shape is refused:
`--rehearse`, `--prod`, `--app`, `--debug-details`, `--execute` without a digest, a digest of 63 or 65
characters, an uppercase or newline-ended digest, a trailing argument, flags reordered, and the tool on
any other Job.

**The bundle.** One line in `Dockerfile` stage `maintenance-build`, after `schema-drift.cjs`:

```
RUN npx esbuild scripts/migrate-hq-round-trip-case-writes.ts \
      --bundle --platform=node --target=node24 --format=cjs \
      --conditions=react-server --tsconfig=tsconfig.json --external:pg-native \
      --outfile=hq-round-trip-case-writes.cjs
```

and three `.dockerignore` lines after `!scripts/lib/prodDb.ts`: `!scripts/migrate-hq-round-trip-case-writes.ts`,
`!scripts/lib/hqRoundTripCaseWrites/` and `scripts/lib/hqRoundTripCaseWrites/__tests__/`. Whether the
bundle reaches `sharp` at load (through export readiness's media imports) is gated run G2.

**The exports.** `lib/db/designSessions.ts::abandonPreAppDesignSessionInTransaction` and
`reapStaleDesignSessionRun` are exported for the cutover's lifetime, the latter returning
`Promise<StaleRunReapOutcome | "failed">` (the reap's outcome from `refundStaleDesignSessionRun`,
`"state_changed"` for a non-build identity, `"failed"` where it logged a failure), exactly as #789 did.

**The maintenance image** is built by hand (`docker build --platform=linux/amd64 --target=maintenance`)
from the head of pull request 15, contracts and public docs, the one beneath the removal; that commit never
reaches `main`, because the merge squashes. The operator manages the Job and runs the scan from a checkout
of that same commit.

## 19. The production scan and what it decides

Decision 16 of step 5's plan: content-free, read-only, run during planning with the person's yes, every
app loaded through `lib/db/apps.ts::loadSchemaAdmittedAppForInspection` inside one `READ ONLY, REPEATABLE
READ` transaction, live and soft-deleted, printing named counts only; no count enters the repo. The
classes it counts, without a statement or a value of production's:

| Class | What it counts | Decides (place) |
|---|---|---|
| S0, the fleet | apps, deleted apps; apps with history past their greatest fold baseline; apps without a fold baseline; app load failures by error class | that the horizon matters (section 1) |
| S1, field writes | by several-case module, capture kind and mode (published apart), worker record, child and extension type; child buckets of the module's own type; forms whose basic child follows an extension bucket | C1 to C5's size, `case-attachments-stop` (section 9), part 02 M2 |
| S2, operations | by action (published apart); `close` on `session` on a follow-up or close form (part 01 (a)); `update` on `session` (part 01 (e)); session targets in several-case modules; operations with an extension link; same-type creates linking the session case as a child | C9 (section 7.4), part 03's same-type line (section 9) |
| S3, extension children | forms and modules with extension writes (published apart); links carrying them, by matching kind; source modules M1 would make advanced; target forms and modules | section 7.6 |
| S4, query repeats | total, published; nested, query reading an answer, ancestor relevance reading one; those the rule gives the count placement | sections 7.9, 8.5 |
| S5, repeat counts | typed whole, needing a wrap, untyped; naming an integer question, a Hidden Value, another kind; another expression | section 7.10 |
| S6, form links | forms with links, with two or more, with a conditional link; each of L1 to L6 and L4's removal; links with datums and with a literal datum; self links | section 7.5 |
| S7, groups and sections | groups; labelled groups taking the flag; labelled groups holding a user repeat; sections holding one | section 7.11 |
| S8, preloads | preloaded writers; defaults replaced; later load-time readers and the writers they read; Hidden Value writers with a calculate | section 7.7 |
| S9, renamed concepts | no-matches forms and modules holding two; `caseListOnly` true and stored false; dead case list media; stored `searchFirst` | section 7.1 |
| S10, search workflow | list-first searching modules by declaration; derived skip to results | section 7.8, part 05 §14 |
| S11, the deployment ledger | deployments; published (section 8.1, a mapping marked missing on CommCare HQ included), live and deleted apps; baselines by origin, unreadable; baselines naming `nova_subcases` | sections 8, 9, `baseline-unreadable` (section 16) |
| S12, operational | open workspaces; events of kind `mutation`; app-test namespaces; open App Test sessions, expired, and holding claimed case ids; apps with history past their greatest fold baseline | sections 3, 13, 21.1 |

The planning scan did not count part 01's classes (f) and (g), session `close` operations under `forEach`
or holding writes, query repeats reading their own rows or whose `relevant` stops type-checking at the row,
a published form holding the supply-point text, part 05 M1's last row, or overlay entries of the no-matches
label. The cutover's own scan and the advisory dry run count every class in their `structure`, `steps`,
`placements`, `path-moves` and `blocker` lines (runbook step 1(c), (d)), so those are first counted there;
at their places both outcomes stand, and the dry run decides.

What the scan found is folded into the plan, in words, at each place it decides something: sections 7.4,
7.5, 7.6, 8.1, 8.6, 9, 16 and 19.1 below. Every load and analysis succeeded. Every class ships whatever
production holds today, because the window's dry run decides per app over what production holds then, and
`main` serves until the window closes ingress, so an author can still make any shape `main`'s gate admits.
S0 found that every app has a fold baseline and that apps carry history past their greatest one, so
the horizon of section 1 matters.

### 19.1 The classes whose outcome changes only what the window writes

- **C9, C10, C11** (part 01 §22, §26). Production holds part 01's class (a), a `close` operation on the
  form's own case on a follow-up or close form, so C9 runs at the window as section 7.4 writes it.
  `CASE_OPERATION_CLOSES_OWN_CASE` (part 01) lands in pull request 4, and because one deploy carries the
  stack and the cutover runs before it, C9 migrates every stored instance before the head's gate reads
  it. Production also holds `update`
  operations on the form's own case (class (e)); they stay operations. The planning scan did not count
  classes (f) and (g), so the advisory dry run decides whether C10 and C11 have work: where it finds none,
  that class writes nothing and stays the transform's guard, and the rule it guards lands in pull request 4
  all the same; where it finds some, the class runs as section 7.4 writes it, and under (g) the cause
  `case-changed-before-create` can appear in `form-data-paths-move`. Nor did it count session `close`
  operations under `forEach` or holding writes: where the dry run finds none under `forEach`,
  `own-close-in-repeat` is a guard; where it finds some, each is the author's blocker before the window;
  each one holding writes becomes an `update` with them and its deployments take `own-close-moved`.

- **Query repeats and counts** (part 04 §7.1). Production holds query repeats, some in published apps,
  and some the rule gives the count placement (nested ones, and ones whose query reads a form answer; none
  under an ancestor whose relevance reads an answer). So each of those gets `repeat-rows-follow-query`, each
  published one the deployment cause of it, and each published query repeat the rule gives model iteration
  is held there. Every stored count already types as a whole number, so no count is wrapped and no
  `repeat-count-whole-number` line is written today; the class ships, because `main`'s `REPEAT_COUNT_TYPE`
  checks only a direct read and an author can store such a count until the window, and the dry run counts
  it; production holds none today. Production holds a count naming a Hidden Value calculated as a whole
  number, so `repeat-count-node-removed` is written where its app has a published deployment, with the
  cause `count-node-removed`.

- **Groups** (part 04 Q4). Labelled groups take `fieldList`, and production holds labelled groups with a
  user repeat at some depth, so each of those gets `group-shows-one-per-screen`; they are exactly the
  groups defect 27 left unusable on Android. No section holds a user repeat, and the gate refuses that
  shape at `main`, so no section meets `target-gate` for it.

- **Preloads** (part 01 C7). Production holds preloaded writers, some with a default the step replaces and
  some read by a later load-time value, so `starting-value-reads-case` and `load-time-value-reads-case`
  both meet apps at the window. Hidden Value writers with a `calculate` exist and get no default.

- **Renamed concepts and the search workflow** (part 05 §14). Production holds no-matches forms, so M5
  meets apps, and no module holding two of them; since the gate refuses that shape at every commit, no
  author can make one before the window, and `renamed-concept-conflict` is a guard no app meets. The scan
  did not count overlay entries of the no-matches label, so the dry run decides: where it finds none, M5's
  overlay move is a no-op; where it finds some, each moves and the `structure` line counts them. Production
  holds case-list-only modules and a stored `caseListOnly: false`, so M2 and M3 meet apps. Production holds
  no dead case list media, so M4 changes nothing today; an author can still make some until the window, so
  M4 ships and the dry run counts it, each a report count; production holds none today. Production holds
  list-first searching modules in apps that declare Web Apps (both platforms, and Web Apps only), so
  `menu-opens-on-search` meets apps at the window with `opensOn` `search`; list-first modules in apps that
  declare Android only keep list first as `workflow: "listFirst"`, and a stored inline `searchFirst` (in
  Web-Apps-only apps, with a visible field) becomes `formsReadSearch: true`. The scan did not count part 05
  M1's last row, so the dry run decides whether any line carries `opensOn` `results`: where it finds none,
  the row and its sentence still ship and no app gets that line; where it finds some, each such module gets
  it. A derived skip to results exists only in soft-deleted apps, which the cutover migrates like every
  app.

- **Operational.** Production holds open private agent work, so `private-work` abandons it and each such
  app gets `unsaved-assistant-work-discarded`. Production holds no event of kind `mutation`, so
  `archive-events` updates no row today; its statement stays, and the dry run's `private-work` line counts
  any written before the window. Production holds app-test namespaces and undisposed App Test sessions past
  their expiry, some holding claimed case ids; they change nothing the cutover writes (sections 3 and
  21.1).

## 20. The runbook

`docs/plans/hq-round-trip/5-cutover-runbook.md`, written in pull request 14 from this section in step 4's
runbook's form (`2f985ed6^:docs/plans/hq-round-trip/4-cutover-runbook.md`) and removed by pull request 16.
`<15>` and `<16>` are the heads of those pull requests; `$IMAGE` the maintenance image's digest reference;
`$JOB` `commcare-nova-hq-round-trip-case-writes`; `$DRIFT_JOB` `commcare-nova-case-type-schema-retirement`,
whose contract admits `schema-drift.cjs --execute` with an optional `--app <id>`; `$EVIDENCE` a local
directory whose files go to `gs://commcare-nova-cutover-evidence/hq-round-trip-case-writes/` at each step's
end; `$MAIN_TREE` a checkout of `main`'s tip.

**The operator's environment**, as step 4's window ran:

- every `gcloud storage` command runs with `CLOUDSDK_PYTHON=/opt/homebrew/bin/python3.11` (the evidence
  copies and listings);
- the installed gcloud has no `gcloud builds retry`, so a retry is the REST call
  `curl --fail --silent --show-error -X POST -H "Authorization: Bearer $(gcloud auth print-access-token)"
  -H 'content-type: application/json' --data '{"name":"projects/commcare-nova/locations/us-central1/builds/<id>","projectId":"commcare-nova","id":"<id>"}'
  https://cloudbuild.googleapis.com/v1/projects/commcare-nova/locations/us-central1/builds/<id>:retry`,
  whose answer names the new build;
- after the NEG is reattached the load balancer answers 200 only after about 2.5 minutes, so each public
  probe of step 10 retries every 15 seconds for up to 5 minutes before it counts as a failure.

**Checks.**

1. **The trees.** `git diff --stat <15>..<16> -- lib app ':(exclude,glob)**/__tests__/**'` names only
   `lib/db/designSessions.ts`; otherwise the gate that migrated is not the gate that probes. Tests are
   excluded because pull request 16 also edits `lib/db/__tests__/runHolderWriteGuard.test.ts` (its
   allowlist entry for the cutover's writer), which changes no gate. It runs on a stack rebased on `main`'s
   current tip.
2. **`main` is frozen** from the image build to the merge: `git ls-remote origin refs/heads/main` prints
   the same commit at step 1(b) and at step 8. A rebase after the image is built changes `<15>`: the image
   is built again, both Jobs are made again from it, and the dry run is repeated.
3. **No deploy from `main`** between the execute run and the merge: `gcloud builds list
   --project=commcare-nova --region=us-central1 --filter='create_time>"<execute start, RFC 3339 UTC>"'
   --format='value(id,substitutions.COMMIT_SHA,status)'` lists no build before the merge commit's.
4. **The advisory dry run is at most three days old** when the window opens (its evidence file name
   carries its moment); past three days, step 1(c) to (f) repeat.
5. **Pull request 1 changed no product code of the cutover's**: `git diff --stat 2f985ed6..<1> -- lib app
   ':(exclude,glob)**/__tests__/**'` names nothing, so the facts `main` derived are `main`'s.

**The order.** There is no announcement step.

| # | Step |
|---|---|
| 1 | **Before the window.** (a) From `$MAIN_TREE`: `npx tsx --conditions=react-server scripts/scan-schema-drift.ts --prod` and `npx tsx scripts/scan-case-type-schema-retirement.ts --prod` report zero, or the repair each prints runs first; `CLOUDSDK_PYTHON=/opt/homebrew/bin/python3.11 gcloud storage ls gs://commcare-nova-cutover-evidence/hq-round-trip-expressions/` names step 3's execute report, whose `writer` line gives its WAL and growth, and `gcloud sql instances describe nova-cases --project=commcare-nova --format='value(settings.dataDiskSizeGb,settings.storageAutoResize)'` shows room for them. (b) From a clean checkout of `<15>`: the image built, pushed, its digest resolved; `docker run --rm --platform=linux/amd64 --entrypoint=node "$IMAGE" hq-round-trip-case-writes.cjs --help` exits 0; for each of `$JOB` and `$DRIFT_JOB`: `python3 scripts/infra/manage-deployment.py job --job <job> --image "$IMAGE"`, then with `--apply`, then `python3 scripts/rollout/deploy-cloud-run.py --verify-job --project=commcare-nova --region=us-central1 --job=<job> --image="$IMAGE" --wait-seconds=120`. (c) The scan, `npx tsx --conditions=react-server scripts/scan-hq-round-trip-case-writes.ts --prod > $EVIDENCE/scan-<moment>.jsonl`. (d) The Job's dry run, the full advisory plan; its report saved. (e) Its `placements` line's `frozenDisagrees` read (gated run G6). (f) Each blocker resolved by its remedy (section 16); (c) to (e) repeat until the dry run's outcome is `ok`; its `schema` and `path-moves` lines recorded. |
| 2 | **Open.** Detach `nova-neg` from `nova-backend`; pause the `commcare-nova-capture-cleanup` Scheduler job. |
| 3 | **Drain.** The scan until its `holders` line counts no live holder (at most `cloudRunRequestSeconds`, 3600 s); the Job with `--settle-holders`; the scan counting no holder at all. A paused build becomes reapable once `buildStalenessSeconds` (600 s) has passed. |
| 4 | **Restore point.** `gcloud sql backups create --instance=nova-cases --project=commcare-nova --description=hq-round-trip-case-writes-restore-point`; its id from `gcloud sql backups list --instance=nova-cases --project=commcare-nova --filter='description=hq-round-trip-case-writes-restore-point' --format='value(id)'`. |
| 5 | **Dry run.** The Job with no override; `planDigest` recorded; outcome `ok`; `jq -c '.[].jsonPayload \| select(.section == "fleet") \| .ledger'` prints `{"horizonApplied":false,"pendingMigrations":["20261110000000_hq_round_trip_case_writes_publish_placement","20261110010000_hq_round_trip_case_writes_commtrack_confirmation","20261110020000_hq_round_trip_case_writes_fold_horizon"]}`; its `schema` line recorded as the drift step 9 expects. A `pendingMigrations` naming anything else: close the window and find out how the ledger moved. |
| 6 | **Migrate.** The Job with `--execute --expect-plan-digest <digest>`; its `writer` line (each writer step's duration, the WAL, the growth, `migrationsApplied` naming the three); outcome `ok`. A `stopped` outcome with `digest` means the database moved after step 5: compare the two reports, then repeat step 5 and pass its new digest, or close the window. Any other stop or error rolled back whole, the DDL with it; a dry run then tells it apart from a commit whose acknowledgement was lost (`already-applied` means the commit landed: go on to step 7). |
| 7 | **Post-migration.** The Job's dry run prints `already-applied`; the Scheduler job resumed; `python3 scripts/infra/manage-deployment.py check` passes. Any code fix made since the cutover pull request's review has its own `/code-review medium` over its commit, findings fixed, before step 8 (section 21.3). |
| 8 | **Deploy.** `git ls-remote origin refs/heads/main` is step 1(b)'s commit; `gh stack merge <top> --squash`. List the merge commit's check runs first (`gh api repos/voidcraft-labs/commcare-nova/commits/<merge sha>/check-runs --jq '.check_runs[] \| {name, app: .app.name, status, conclusion}'`) and watch the deploy check by the name and app that list shows; an empty list is an error to look into, never a reason to keep waiting. `gcloud builds describe <build id> --project=commcare-nova --region=us-central1 --format=json \| jq '.steps[] \| {id, status}'` shows `migrate` and `deploy` at `SUCCESS`; `verify` fails while the NEG is detached. |
| 9 | **Converge.** From `$MAIN_TREE` at the merge commit (`git -C $MAIN_TREE pull --ff-only`, `npm ci`): `npx tsx --conditions=react-server scripts/scan-schema-drift.ts --prod > $EVIDENCE/drift-before-<moment>.txt` names exactly the apps of step 5's `schema` line, a missing `commcare-case-claim` row among them for every app it reads. Then the drift writer, `python3 scripts/rollout/deploy-cloud-run.py --execute-job --project=commcare-nova --region=us-central1 --job=$DRIFT_JOB --image="$IMAGE" --wait-seconds=3060 --execution-arg=schema-drift.cjs --execution-arg=--execute`, its execution's log saved; then the same scan into `$EVIDENCE/drift-after-<moment>.txt` reports no drift. An app the writer could not converge (it isolates each app's failure) runs again with `--execution-arg=--app --execution-arg=<id>` until the scan reports none (gated run G7). Ingress reopens only on the zero scan. |
| 10 | **Resume.** Reattach the NEG; its describe into `$EVIDENCE/neg-after.txt` names `nova-neg`; retry the merge commit's build with the REST call above, whose `verify` passes; the three public probes of `cloudbuild.yaml`'s `verify` step, each retried every 15 seconds for up to 5 minutes: `curl --fail --silent --show-error --max-time 30 https://commcare.app/ >/dev/null`, the same for `https://docs.commcare.app/`, and the MCP `initialize` POST to `https://mcp.commcare.app/mcp`, which answers `401` with a `www-authenticate` header holding `Bearer` and `resource_metadata=`. |
| 11 | **Close.** For each of `$JOB` and `$DRIFT_JOB`: its definition and executions to `$EVIDENCE` (`gcloud run jobs describe` and `gcloud run jobs executions list`, `--format=json`); the evidence copied with `CLOUDSDK_PYTHON=/opt/homebrew/bin/python3.11 gcloud storage cp -r $EVIDENCE/* gs://commcare-nova-cutover-evidence/hq-round-trip-case-writes/`; `gcloud run jobs delete <job> --project=commcare-nova --region=us-central1 --quiet`. `$DRIFT_JOB`'s contract stays in `config/deployment-jobs.json`. |

**The commands every step uses** are step 4's runbook's, with this cutover's names: running the tool
(`python3 scripts/rollout/deploy-cloud-run.py --execute-job --project=commcare-nova --region=us-central1
--job=$JOB --image="$IMAGE" --wait-seconds=7260`, an override adding one `--execution-arg=<word>` per word
of an admitted shape, the first `hq-round-trip-case-writes.cjs`; `--wait-seconds` is the contract's
`timeout` plus 60 and moves with it); the execution and its report (`gcloud run jobs executions list` for
the name, then `gcloud logging read` filtered by `resource.labels.job_name="commcare-nova-hq-round-trip-case-writes"`,
the execution name and `jsonPayload.report="hq-round-trip-case-writes"`, into `$EVIDENCE/<execution>.json`,
read by `section` with `jq`); the NEG (`gcloud compute backend-services remove-backend nova-backend
--global --network-endpoint-group=nova-neg --network-endpoint-group-region=us-central1
--project=commcare-nova` and `add-backend` with the same flags, each followed by the describe into
`$EVIDENCE/neg-<before or after>.txt`); the Scheduler job (`gcloud scheduler jobs pause
commcare-nova-capture-cleanup --project=commcare-nova --location=us-central1`, and `resume`). Each blocked
app's places come from `npx tsx --conditions=react-server scripts/scan-hq-round-trip-case-writes.ts --prod
--app <id> --debug-details`, on the operator's terminal only, never into the evidence.

**The window**: about 5 minutes to open, up to 70 to drain, 10 for the restore point, the dry run, the
execute run, 10 for step 7, about 20 for the deploy, 10 to converge, and 15 to resume (the load
balancer's 2.5 minutes and the probes' retries inside it). The dry run and the execute run each take about
the advisory dry run's duration, so the operator plans 2 hours 30 minutes plus twice that. A stop before
the commit (a blocker, a holder, a moved app or baseline, a digest, a ledger, a lock wait, an error) closes
the window with nothing written and no DDL applied: reattach and resume.

**Rollback.** Before step 6's commit nothing needs restoring: the DDL rolls back with the fleet. After the
commit and until the merge, the ledger holds migrations `main` lacks: a window that closes in that span
without merging restores runbook step 4's restore point before `main` deploys again (`gcloud sql backups restore <backup
id> --restore-instance=nova-cases --project=commcare-nova`, waiting for `gcloud sql operations list
--instance=nova-cases --project=commcare-nova --limit=1 --format='value(operationType,status)'` to print
`RESTORE_VOLUME	DONE`), then the dry run shows `horizonApplied` false, the Scheduler job resumed, the NEG
reattached. What is lost is only what the capture cleanup removed after step 7. Once the merge's deploy has
started, the only way is forward: a probe failure at step 8 leaves ingress closed, and the fix ships as a
pull request with its own review (section 21.3) whose deploy passes the probe.

**What the operator records**, each in the evidence prefix: the prerequisite scans of step 1(a) and the
capacity figures read there; every scan and dry-run report with its `fleetSeqDigest`; each blocker
cleared and G6's outcome; `<15>`, `<16>`, the image's digest, check 1's diff, `main`'s commit at step 1(b)
and step 8; the NEG before and after; the restore point's id; the window's `planDigest`; the execute report
(durations, WAL, growth, peak RSS); the post-migration `already-applied`; any fix's review; the merge
commit, its build, the retry; the drift scans before and after and the writer's log; both Jobs' definitions
and executions. Where a class section 19 names meets nothing at the window, the runbook's record says so in
words.

**Local databases** go through the same script from a checkout of `<15>`:
`NOVA_DB_WORKLOAD=migration npx tsx --conditions=react-server scripts/migrate-hq-round-trip-case-writes.ts
--rehearse`, then `--execute --expect-plan-digest <d>` with the digest a dry run prints, then
`NOVA_DB_WORKLOAD=migration npx tsx --conditions=react-server scripts/migrate-schema-drift.ts --execute`
for the drift its `schema` line counted. A database made fresh from the migrations needs nothing.

## 21. Decided follow-ups

### 21.1 Old app-test namespaces: no work

`nova_create_app_test_namespace` copies `form_attachments` with its constraints, so a namespace made before
step 4's window holds `form_attachments_size_check` at `size_bytes <= 4000000`. No write reaches it: every
non-finish step of a test made before step 4's deploy is refused by `RUNTIME_VERSION` ("Nova's test runtime
changed. Start a new test."); `finish` disposes the namespace without writing into it
(`lib/preview/app-tests/service.ts`, the `finish` action returns before `withAppTestContext`); and pull
request 3 moves the version to 18, which fences step 4's namespaces the same way. What the copies still do
is collide with catalog reads by name alone, which `catalog.ts` removes (section 15). Disposing expired
namespaces across the fleet would change the App Test lifecycle (`lib/preview/app-tests/CLAUDE.md`: "There
is no background claim of physical deletion at 24 hours"), which no step of this plan asks for; so step 5
does nothing else, and no outline gains an item.

### 21.2 Step 4's postcondition fix, and its lesson

Read at `93aef6232a` ("Read the postcondition's checks from the live tables, not by name alone"; squashed
into `a8af778e`). `writer.ts::checkPostconditions` gained `AND conrelid = 'media_assets'::regclass` and `AND
conrelid = 'form_attachments'::regclass` on its two `pg_constraint` reads and replaced the
`information_schema.columns` read with `pg_attribute WHERE attrelid = 'app_deployments'::regclass ... AND
NOT attisdropped`. Its test seeded a namespace with `nova_create_app_test_namespace`, ran `VACUUM FULL
pg_constraint`, and set `enable_indexscan = off` by `ALTER DATABASE` and per session.

- **The writer change was correct.** `conrelid` with `conname` is unique, so each read returned the live
  row whatever the heap order. It resolved `'media_assets'::regclass` through `search_path`; the Job's path
  never holds an app-test namespace (`withAppTestNamespace` sets its path `LOCAL` inside its own
  transaction), so the reads were right, but implicitly. `catalog.ts` names the schema.
- **The test's reproduction was right**: the namespace's copy of the 4,000,000 check preceded the
  window's re-added check in the compacted heap, and with index scans off a name-only read returned the copy
  first.
- **A gap it left (a Nova defect in tooling now removed).** Three name-only reads stayed in its tests:
  `postgresSeed.ts::databaseImage` read `form_attachments_size_check` by `conname` alone, and
  `writer.postgres.test.ts` read `media_assets_ready_media_format` by name and columns through
  `information_schema.columns`. With the namespace the fix itself added, `databaseImage` read the
  namespace's unchanged copy, so its "a failure after each numbered step leaves the database byte-identical"
  assertion could not see the live size check: a rollback that left it widened would have passed. Its
  `ALTER DATABASE ... SET enable_indexscan = off` also persisted for later tests of that harness database
  (cost only). The tooling is gone from `main`, so nothing is repaired; step 5 carries the lesson, in the
  product reads and in the tests' (section 15), and part 08 records it in `harness-findings.md`, "Found while
  planning step 5".

### 21.3 The review rule

Step 4's postcondition fix was made during its window and squashed into the cutover pull request after
that pull request's review, so it never had a review of its own. Section 21.2's reading is that review,
done during this planning: it found the three name-only reads in the fix's tests, a Nova defect in tooling
now removed. This rule keeps a fix from reaching the window unreviewed again.

The cutover pull request takes `/code-review medium` like every pull request of the stack, and its
description names `catalog.ts`, `writer.ts`'s postconditions and `catalog.postgres.test.ts` as the review's
first files. A fix made after that review (during the advisory runs or the window) lands as its own commit
on the cutover pull request with its own `/code-review medium` over that commit's range, findings fixed,
before `gh stack merge`; runbook step 7 says so, and the window never reopens ingress on an unreviewed fix.
A fix found after the merge's deploy started ships as a pull request with its own review.

## 22. The removal and the cutover's trace

Pull request 16, at the top of the stack, removes: both scripts and `scripts/lib/hqRoundTripCaseWrites/`
with its tests and `fixtures/pre-step/`; the `Dockerfile` `maintenance-build` line and the three
`.dockerignore` lines; the Job contract; the allowlist branch and `PLAN_DIGEST_RE` with their rows in
`test_deployment_policy.py` and `containerArtifacts.test.ts`; the `scripts/README.md` entry; the
`docs/architecture/deployment.md` paragraph; `runHolderWriteGuard.test.ts`'s allowlist entry; the runbook;
and this plan (`docs/plans/hq-round-trip/5-case-writes-forms-navigation.md` and its directory). It makes
`abandonPreAppDesignSessionInTransaction` and `reapStaleDesignSessionRun` module-private again with today's
bodies (the latter `Promise<void>`). The Jobs are already deleted by runbook step 11. Part 10 writes
`docs/plans/hq-round-trip/README.md`'s "Step 5 is done" from the trace below.

What stays, the cutover's trace:

- the three migrations of section 11 and `lib/case-store/migrations/__tests__/caseWritesLedger.postgres.test.ts`
  (immutable history);
- `lib/domain/caseWriteOperationIdentity.ts` and the `lib/doc` planners of decision 3 with their tests (the
  fuzz mapping and step 6's import read them);
- the cutover id, its lead, the eighteen document reasons, the three deployment reasons, the two
  `next-publish-asks-more` ids and `OTHERWISE_DESTINATION_WORDS` (stored rows render for good);
- each app's `fold-baseline:hq-round-trip-case-writes` row and its baseline snapshot;
- `lib/commcare/hq/publishedCaseBlocks.ts` (part 03) and the witnesses' retained reads
  (`proof/hq-reads/targeted-migration-*`, part 08);
- the two docs sentences of section 17.3;
- the evidence prefix `hq-round-trip-case-writes/`, content-free reports only, never deleted from.

---

## Tests

They run Nova's own code and prove what it does to Nova's database and to a stored document; none is
offered as proof of what a CommCare reader does with an app, which the lane holds (part 08's witnesses
republish each migrated shape over its retained A). Each starts from a contract, a plausible failure, and
the observation that tells them apart (`docs/testing.md`). All live in
`scripts/lib/hqRoundTripCaseWrites/__tests__/` unless named.

| Test | Proves (the failure it catches) | Boundary |
|---|---|---|
| `fixtures.capture.test.ts` (pull request 1; deleted by 2) | each pre-step fixture is a document `main` admits, and `facts.json` is what `main`'s own code derives (a fixture no stored app could be, or a fact typed by hand) | pure, at `main`'s code |
| `fixtures.digest.test.ts` (pull requests 1 to 16) | the fixtures and `facts.json` are the bytes pull request 1 committed (a fixture edited after the code that admitted it left) | pure |
| `frozen.test.ts` | each frozen copy reproduces `facts.json` over every fixture read raw: placements unit by unit, preloaded writers, labelled groups; and the search facts the semantics step computes reproduce `searchShapes` (a frozen copy that drifted from `main`'s emission) | pure |
| `structure.test.ts` | M2 to M5 with the overlay entry moved and its fingerprint unchanged; `renamed-concept-conflict` over a planted raw document with two no-matches forms; C4 and C5 with the attachment record; C6 for `=`, absent and `selected`, with a choice leaf and with a literal; the lift in data-tree order with `capture` set; `searchFirst` lifted; the head parse succeeding on every fixture; a planted leftover old key giving `structure-parse` (a key the head schema refuses left in place) | pure |
| `transform.test.ts` | each semantic step and its notice entries: C9 (a writeless operation, one holding writes, a close form with a condition, an operation under `forEach` as `own-close-in-repeat`); C1 to C3 in part 01's order with section 10.1's UUIDs and ids; C10; a session `update` operation left an operation (class (e)); every change kind of `mapFormLinkSemantics` onto its reason, `from` and `link-removed` included; an extension create carried into an advanced module, one whose module a blocker holds (retargeted to the target's menu, to the nearest offered menu, and removed to the app home), and a non-extension carried create listed apart; a replaced default and later readers through a default and a query repeat's ids query; each row of part 05 M1's table including `results`; Q1's line, Q2's wrap, Q3's line only in a published app; Q4 with a translated-only label and a user repeat two levels down; `judgeTarget` over planted targets (`case-schema-unplanned`, `not-idempotent`, `target-gate` with its code); a second application writes nothing; `it("migrates each witness's pre-step document to its spec's document")`, the witness specs from `proof/targeted/documents/migrations.ts`, each published over `proof/hq-reads/<id>/app-source.json` as a `readable` baseline | pure |
| `placements.test.ts` | over `proof/hq-reads/targeted-migration-*/app-source.json` as readable baselines: every unit held at today's placement; a question renamed since the push leaves its unit unheld; `shell`, `unread` and `absent` baselines; an `unreadable` baseline for each of gunzip, digest and parse giving `baseline-unreadable`; a mapping marked missing on CommCare HQ counted as published; two deployments, one carrying and one not; identity overrides changing the `xmlns`; each class of section 8.5 left unheld; the verification giving `placement-path-mismatch` for a planted emission difference; the frozen check counting zero over a document unchanged since its push and one over a planted baseline missing a block | pure, over real HQ reads |
| `deployments.test.ts` | each line of section 9 and its absence; every cause; `next-publish-asks-more` with each id and with neither | pure |
| `notice.test.ts` | each change to its entry, parsed by `migrationNoticeEntriesSchema`; a name longer than `NOTICE_TEXT_MAX` left out of `detail` and `nameAtMigration` truncated as step 4's did | pure |
| `plan.test.ts`, `report.test.ts` | the digest is stable across runs and moves with a base sequence, a base digest, a target, a hold, a baseline's digest or `observedAt`, a blocker; every report line holds no authored string from any fixture (each fixture's names hold a sentinel the test searches every line for) | pure |
| `run.test.ts` | the modes and arguments; `already-applied` and `partially-applied` from the two reads | pure, with a fake ledger reader |
| `catalog.postgres.test.ts` | section 15.2 (a catalog read that resolves by name alone, under production's heap order) | real Postgres |
| `writer.postgres.test.ts` | from `main`'s migration prefix (`caseStoreMigrationsBefore` the publish-placement migration), seeded through `postgresSeed.ts` (raw SQL, because the head's writers cannot write the old shapes), with section 15.2's decoy present: apps from the fixtures, one deleted; a published app with a `push` baseline gzipped from `proof/hq-reads/targeted-migration-case-writes/app-source.json` with its digest, one `create`, one `unread`; in a second seed, one whose digest fails, which the plan refuses with `baseline-unreadable` and nothing written; open private work, a `mutation` event, entry points; the ledger pending exactly the three and any other ledger refused; a live holder, a moved app, a moved baseline, a wrong digest and a lock wait each stopping with nothing written and no DDL; a failure injected after each writer step leaving `databaseImage` byte-identical, `databaseImage` reading every constraint and routine through `catalog.ts`; `--rehearse` leaving nothing; after the commit every app loading, folding from its baseline to its target, and `runCanonicalRuntimeDatabaseProbe` finding nothing; `case_type_schemas` byte-identical and `computeSchemaDrift` then naming each app's claim row and nothing unplanned; the notice rows; a second run in every mode `already-applied` | real Postgres |
| `scan.postgres.test.ts` | the scan's lines over a seeded pre-step database, run as a role holding only `SELECT` (a scan that locks or writes) | real Postgres |
| `holders.postgres.test.ts` | step 4's cases (`a8af778e:scripts/lib/hqRoundTripPlatforms/__tests__/`), adapted to `source.ts`, `run.ts` and `ledger.ts`: holders settle through the production reapers, and a live holder stops the write | real Postgres |
| `lib/case-store/migrations/__tests__/caseWritesLedger.postgres.test.ts` (kept after 16) | the horizon migration from its prefix: a sixth-identity baseline admitted, a marker with the right batch and another actor refused, every earlier identity still admitted, `down` throwing its sentence; the function addressed as `'public.nova_admit_app_change_fold_baseline_insert()'::regprocedure` | real Postgres |
| `lib/agent/change-set/__tests__/preHorizonReads.postgres.test.ts` | a reader behind an app's sixth horizon answers from the current saved app, over an app with three horizons | real Postgres |
| `lib/domain/__tests__/caseWriteOperationIdentity.test.ts` (pull request 4) | the namespace's value, the name's JSON, determinism, the attempt stepping around a taken UUID | pure |
| `lib/db/__tests__/runHolderWriteGuard.test.ts` | the allowlist names `scripts/lib/hqRoundTripCaseWrites/writer.ts` (pull request 14) and no longer (16) | pure |
| `scripts/infra/tests/test_deployment_policy.py::test_hq_round_trip_case_writes_admits_its_runbook_shapes_and_nothing_else` | the stored dry run with no override; the two admitted overrides; every refused shape of section 18; the tool refused on `commcare-nova-migrate` and `commcare-nova-historical-repair` | infra |
| `scripts/infra/__tests__/containerArtifacts.test.ts`, new test "the HQ round-trip case-writes cutover runs a maintenance bundle of its migrate script on its own Job" | the bundle line, the Job contract (`args`, `maxRetries` 0, `serviceAccount`, `env`), the three `.dockerignore` lines; the existing self-contained-bundle test runs the new bundle's `--help` with no `node_modules` | infra |
| `lib/notices/__tests__/migrationNoticeCopy.test.ts`, `migrationNotice.test.ts`, `components/builder/notices/__tests__/appNoticeModel.test.ts` | every new reason with present and absent details and a removed entity; `form-link-target-moved` with and without `cause: "carried-not-a-case"`; `OTHERWISE_DESTINATION_WORDS` holding exactly `OTHERWISE_DESTINATIONS`; the lead; the reasons' places in both orders; `next-publish-asks-more` with `commtrack-off` and `same-type-child-links`; the dialog grouping four cutovers' notices | pure (the notice model, never the DOM) |

The cutover adds no lane group and moves no proof timing. Five things are proven by the real system in the
runbook and by no test: check 1; the bundle in the built image (step 1(b)); the frozen classifier against
production's baselines (G6); the fleet transaction's duration over production's rows (G3); and the drift
writer converging exactly the planned differences (G7).

## Departures

- **From the cutover brief's C3**: a unit is held at the placement today's emission gave it where a
  baseline carries a block at that identity, not at whichever head-emitted candidate placement a baseline
  carries. Decision 5 already requires the frozen classifier, so one computation serves both kinds of
  baseline, and no production function enumerates a unit's candidate placements.
- **From the cutover brief's baseline reading**: a published deployment with no baseline row is read as
  unknown and keeps today's placements (part 03 §12), not as carrying nothing; a stored baseline whose bytes
  fail gunzip, their digest or their parse is the blocker `baseline-unreadable`, repaired by refreshing that
  deployment, not read as carrying nothing (section 8.1).
- **From the cutover brief's step order**: `search-workflow` and `field-list-flags` are semantic steps over the
  parsed document (part 05 and part 04 pass facts to production planners), and only the keys the head
  schema refuses are lifted in the structure phase; the brief's steps 6 and 8 fixed point is one ordered pass,
  because part 06's map leaves `linkCarriedCreates` unchanged.
- **From the search-and-menus brief's M6** (part 05's M6 adopts this part's rule): the claim row converges
  through the drift writer after the deploy, not inside the fleet transaction (section 12).
- **From the case-writes brief's C9** (part 01 adopts this part's rule): a session `close` operation holding
  writes becomes an `update` with them, so its writes keep their condition and path; C9 covers close forms as
  well as follow-ups (the planning scan's class counts both); an operation under `forEach` is the blocker
  `own-close-in-repeat`. A session `update` operation is not folded into the own arm; only C10 removes a
  write the own arm also makes.
- **Blocker codes**: the brief's `write-unplaceable`, `extension-unplaceable`, `preload-default-refused`,
  `repeat-count-refused` and `section-holds-user-repeat` are dropped (each case meets `transform-admission`,
  `target-gate` or nothing, sections 7.10 and 7.11); `structure-parse`, `own-close-in-repeat` and
  `baseline-unreadable` are added. `form-link-unmappable` is not registered: part 06's map is total and
  removes the one link it cannot retarget (section 7.5).
- **The pre-step fixtures land in pull request 1 with part 08's witnesses**, not in a skeleton pull request of
  their own, and HQ's reads of them are `proof/hq-reads/<witness id>/app-source.json`, not
  `fixtures/pre-step-hq/` (part 08's departure, adopted). The capture test leaves in pull request 2, and
  `facts.json` records what `main`'s code derives, which the brief did not hold.
- **The C10 fixture writes `review_status`** (section 5.2), where the plan wrote `status`: `main`'s gate
  refuses a write of `status`, a reserved case property
  (`lib/domain/standardCaseProperties.ts::FORBIDDEN_CASE_WRITE_PROPERTIES`, which a field's write meets
  in `lib/commcare/caseWriteAdmission.ts`, and `::FORBIDDEN_CASE_OPERATION_WRITE_PROPERTIES`, which an
  operation's write meets), and the class is the same under any property the own arm also writes.
- **The C11 fixture's operation target reads a Hidden Value `new_id` that calculates the `new-case`
  datum** (section 5.2), where the plan read the datum in the target directly: `main`'s gate refuses a
  `new-case` session-datum term in an operation's target, a record slot that reads only the case chosen
  in an earlier menu (`lib/domain/expression/typeChecker.ts::chosenCaseAdmission`), so the target reads
  the Hidden Value, which holds the id of the case the registration creates.
- **The frozen classifier's production check** (section 8.6, G6) is not in the research or the brief.
- **New causes**: `own-close-moved` (C9) and `case-changed-before-create` (part 01's C11) join the brief's.
- **Copy**: `form-link-otherwise-set` reads `from` (part 06 §14.3); `menu-opens-on-search` has two sentences
  by `opensOn` (part 05 §14); `repeat-count-whole-number` is part 04's; the brief's `form-links-conditions-written`
  ("every link whose condition holds now runs") is rewritten to be true under every outcome of part 06's G1.
- **`catalog.ts`'s functions** are `constraintDefinition`, `relationConstraints`, `routineDefinition` and
  `schemaRoutines`; the brief's `constraintValidated` and `columnPresent` are dropped, since no step 5 read
  needs them.
- **Claims corrected**: the `previous` refusal's HQ function (section 2); the outline's "publish-placement kind
  CHECK" (a trigger function).

- **C6 over a question in a repeat writes `count(<repeat answer>[. = <value>]) > 0`**, not the literal
  `eq(field, answer)`: the head checker refuses a single-value comparison of a repeat answer in
  `form_close_condition` (`many-values`), and the existential count is the meaning `main`'s close
  read had (part 08's case-writes witness holds it).

- **C9 rewrites the document directly, not through a mutation batch** (section 7.4): turning a `close`
  into an `update` with the same uuid is a removal and a fresh claim of that uuid, which
  `lib/doc/mutationIdentityAdmission.ts::mutationIdentityAdmissionIssue` refuses (no claim but a form
  link's reintroduces a removed identity), and no operation patch changes an action
  (`lib/doc/types.ts::caseOperationPatchSchemaFor` omits `action`). `steps/writesIntoOperations.ts`
  replaces the form in place, the converted operation keeping its position, and `judge-target`'s gate
  holds the result as it holds every step's. C1 to C3 and C10 still apply through
  `prepareMutationCandidate`.
- **C10 removes an emptied `update`, never a `close`**: "an operation left with no write, name, owner,
  link, rename or retype" lists an update's facets; a close with no write still closes, so removing it
  would drop a close. On a registration the own case is the own arm (`{ kind: "op" }`,
  `lib/doc/fieldCaseWriteMutations.ts::ownCaseLinkTarget`), so an operation reaching it through an
  expression target is C11's, not C10's.
- **`extension-children` asks the gate's own rule which carried creates to retarget**
  (`lib/commcare/validator/rules/advancedModule.ts::formLinkNeedsNewCaseDatum`), read again after every
  retarget, rather than retargeting every carried create of a module `advancedKindBlockers` blocks: the
  rule also refuses a carried create an advanced form cannot open (`openActionIneligibility`, part 02
  §23's `ineligible` cause), and it skips the carried creates a basic form already gives a session value
  (a registration's own case on its basic slot, a basic subcase at the root), which need no change. A
  carried create is listed (`carried-create`, or `non-extension-carried-create` apart) only where it is
  one of `lib/domain/advancedEntryDatums.ts::advancedKindTriggers`'s, for the same reason. The otherwise
  link, which `planFormLinkUpdate` and `planFormLinkRemove` do not address, is retargeted or cleared
  through `planSetOtherwise`, the production edit for that slot; a link found again after its retarget
  (a condition reading the new case) is removed.
- **The per-step cases of the first three semantic steps sit in `__tests__/stepsCasesLinks.test.ts`**, not
  `transform.test.ts`, so the steps' tasks own disjoint files.
- **Section 9's readable moves read the head's HQ import file** (`expandDoc` under the deployment's
  `targetWireIdentity(overrides)`, lookup tables named by `identityLookupWireNaming`, which no block path
  reads) through `publishedCaseBlocks`, the reader the baseline is read by, where the plan named
  `planFormCaseWire` alone: a baseline carries each operation's `nova_guard_<id>_<kind>` blocks, which
  `FormCaseWirePlan.saveToCase` does not list, so the plan alone would count every guard as moved. Section
  8.4's verification reads `planFormCaseWire` as written (`placements.ts::emitsAt`).
- **C11's class covers the form's other basic slots** whose `placementIneligibility` is `own-not-basic`
  (its subcases and the worker's record), not the own arm alone: once the own arm leaves the basic own
  slot no basic subcase can stay, so holding them would be `placement-path-mismatch` on every C11
  registration with a child (shown on `targeted-migration-case-writes`' Register with a planted change of
  its new case). They move with the own arm, cause `case-changed-before-create`.
- **The inert basic subcase `main` wrote beside each extension's Save to Case block** leaves the wire with
  cause `extension-case-moved` (on a readable baseline, its block no longer written; on an unknown one,
  every extension unit not of another class): no cause of section 9 names it otherwise, and it is part
  02's extension change. On `targeted-migration-extension-children`'s HQ read this gives
  `subcase-renumbered`, `extension-case-moved` and `module-made-advanced` over two forms
  (`deployments.test.ts`); proof 1 on the witness (G9) remains the check that each move is named.
- **Two unheld classes beside section 8.5's**, each with cause `placement-simplified`: `merged`, a
  field-write bucket that joined an operation the form already held (`operationsFromFieldWrites`' join),
  which is that operation's own unit; and `gone`, a unit the target holds nothing for (an operation C10
  removed, or a form or query repeat that left). Neither has a hold target, so neither is
  `placement-path-mismatch`. A unit no readable baseline carries, with no unknown baseline, is
  `not-carried`.
- **A renumbered child under an unknown baseline is left unheld** at the head's index: the plan holds it
  at the head's index only where a baseline carried it at the old one, and an unknown baseline carries
  nothing Nova read.
- **The placement step reads the raw document and the app's `mutation_seq`** beside the target, the facts
  and the deployments: C9's removed operations are read from the raw document (the own close takes the
  first removed one's path), and the frozen check of section 8.6 compares `pushedRevision` with the
  sequence. Where `main` also wrote that form's own close apart, the `own-close` unit's placement is the
  one held, since one own close keeps one path. It takes step 8's carried creates as an input
  (`PlacementInput.carriedCreates`), because a retargeted create is no longer one `linkCarriedCreates`
  returns.
- **The frozen check's block side skips the inert extension subcase and model-iteration rows**: the first
  reaches no unit (section 8.2), and a row only a query repeat unit can name (the several-case form's
  selected-cases repeat is model iteration too, and is no unit).
- **G4, outcome A**: every placement class of section 8.2 has a read in `proof/hq-reads/` whose block
  `publishedCaseBlocks` finds: the basic own slot, the worker's record, a root subcase by index and a
  repeat's row subcase (`targeted-migration-case-writes`' Register and Visit), Save to Case blocks at the
  root, keyed, under a condition and in a repeat with their guards, the own close in `nova_condition_close`,
  C9's removed operation's path, the several-case form's selected-cases block (the same read), the
  extension's `nova_subcases` block beside its inert subcase (`targeted-migration-extension-children`), and
  three model-iteration rows (`targeted-migration-query-repeats`). `placements.test.ts` reads them as
  written.
- **`placement-path-mismatch` is planted as today's placement the head cannot express** (the own case as a
  basic subcase): the verification arm cannot be reached by a consistent document, since `holdExpresses`
  and `planFormCaseWire` read one placement plan; the step keeps it as the stack's backstop.
- **`next-publish-asks-more`'s `planFeatures` compares Save to Case alone**, the plan's "in practice": today's
  placements say whether any unit stood in a Save to Case block, and nothing of today's emission says
  which other features its last publish confirmed.
- **`StepContext` carries three fields more than section 7 lists**: `liveDeployments` (every live
  deployment, published or not, which step 17's `deep-links-need-republish` names and section 8.1's
  published list does not hold), `mutationSeq` (the frozen check's sequence, a `PlacementInput` field)
  and `discardsPrivateWork` (which `entriesForApp` needs to end the notice and `AppTransform` returns).
  The Project's lookup naming is derived from `lookupContext` rather than carried.
- **Idempotence counts edits, not reports**: step 8's `carried-create`, `non-extension-carried-create`
  and `module-made-advanced` describe the head's derivation of a document no step changed ("a carried
  create needs no stored change", section 7.6), so a second application reports them again; the check
  refuses every other change kind and a moved digest. Its inner run judges nothing and writes no
  deployment line (its structure phase cannot lift what the first run read, an attachment write's mode
  among them, so its own schema comparison would misname a planned difference), and it runs only over a
  target the gate, export readiness and the schema comparison admit, since the steps' emission-reading
  planners are not defined over a refused one.
- **A blocked app is judged without idempotence**, and a `target-parse` refusal ends the judgement: the
  remaining steps would change a document a blocker left, and the gate is not defined over one the head
  schema refuses. The head parse's own refusal judges nothing, since no document exists to judge. A
  blocked app plans no hold, path move or notice entry; its changes up to the blocker stay in the plan.
- **`derivation-drift` is a property both sides carry whose derived spec moved** (`refined` or
  `retyped`): `main`'s derivation is not in the tree, and runbook step 1(a)'s zero drift scan makes the
  stored rows `main`'s. A property gained or lost, a missing row of any type but the claim's, and a
  stored spec no arm emits are `case-schema-unplanned`, each finding code the difference's kind and
  never a property name.
- **`compareStoredSchemas`**: `scripts/lib/schemaDrift.ts::computeSchemaDrift` now reads its rows and
  calls this pure comparison, its loop unchanged, so the judgement compares `ctx.storedSchemas` with the
  drift writer's own computation.
- **Three witness specs are compared modulo two things the cutover writes**: `targeted-migration-
  search-workflow`, `-form-links` and `-attachment` build each own case with `buildDoc`'s identity
  rather than `caseWriteOperationUuid`'s, and leave every hold to the record their first publish over A
  writes. The transform's target equals each of those specs without the own case's uuid and the holds,
  and B (the HQ application of the document as its first publish over A records it) is byte-equal for
  all eight; the other five equal their specs exactly. Rewriting the three specs through
  `migrateFieldWrites` and `heldAt` would move their corpus documents, which this pull request does not.
- **The plan carries no field for an unreadable baseline's cause**: section 8.1 enters "every `unknown` or
  `unreadable` one's `why`" in the digest, and section 10.2's `AppPlan.deployments` has only `baseline`,
  `sourceDigest` and `observedAt`. An unknown baseline's cause is its `baseline` value (`unread`,
  `absent`), and an unreadable one's enters through its app's `baseline-unreadable` blocker, whose finding
  codes name it (`baseline-unreadable:<why>`, `placements.ts`). So the digest moves with each cause, and
  the plan keeps section 10.2's shape.
- **The placement postcondition of section 14 runs step 15 again** (`placements.ts::placements`) over
  the stored target, the raw carriers the blocking scan proved unchanged, and the deployments read under
  its locks. It requires no blocker, no hold left to write (the digest unchanged) and exactly the plan's
  `held`, sources included. That repeats section 8.4's emission check, and proves each `carried` hold is
  still carried by a locked baseline, through the production rule rather than a restated one.
  `transform.ts::transformApp` now also returns the step's counts and the carried creates step 8 found
  (`PlacementTrace`), which the report's `placements` line and that re-run read.
- **The writer's `lock` step sets `lock_timeout` before it takes the advisory lock**, step 3's order, so a
  second run waits 15 seconds for the first and stops as `lock-timeout`. Section 13 lists the two the
  other way round.
- **The blocker refusal's sentence** is the writer's own, since section 13 gives none: "The plan holds
  blockers in {n} apps ({codes}), so the cutover wrote nothing. Resolve each by the remedy its code names
  in the dry run's blocker lines, then run the dry run again and pass its digest."
- **The writer's `already-applied` stop is its own error** (`CutoverAlreadyAppliedError`, code
  `already-applied`), not a stop code, because section 10.3 makes `already-applied` an outcome rather than
  a `stopped` reason. A `partially-applied` ledger under the locks throws `ledger.ts::partiallyApplied`.
- **`next-publish-asks-more`'s `commtrack-off` and `same-type-child-links` were already rendered**:
  pull request 8 added both sentences (`dad3cf3c`, `lib/notices/migrationNoticeCopy.ts`, the renderer's
  `settings.includes("commtrack-off")` and `capabilities.includes("same-type-child-links")` arms), so pull
  request 14 checked that the reason's renderer reads them as section 17.2 writes and changed nothing there.
- **The `lib/deployment/CLAUDE.md` "Baselines" sentence** (the unread baseline's held placements,
  `placements-kept-unread`, the query repeat exception and a remote-missing mapping counted as published) is
  marked 14 in part 10 §7.8 but missing from part 10 §2's file list for pull request 14; pull request 14
  writes it, since the contract describes the behavior this pull request's writer leaves.
- **The shared interfaces live in `types.ts`**, `LiftedFacts` among them, where section 6's layout gives
  `types.ts` the registries alone: the structure phase, the steps, `placements.ts`, `deployments.ts`,
  `judge.ts` and `transform.ts` all read them, and one module beneath them keeps the tasks' files disjoint
  and the import graph acyclic. `structure.ts` re-exports `LiftedFacts`, the structure phase's output.
- **The question and search steps' cases sit in `__tests__/stepsQuestionsSearch.test.ts`** beside
  `stepsCasesLinks.test.ts` and `transform.test.ts`: `explicit-preloads`, `search-workflow`,
  `query-repeat-placement`, `repeat-counts` and `field-list-flags`, so each per-step suite has one owner and
  `transform.test.ts` keeps the whole transform's order, judged stop and idempotence.
- **`oldShape.ts`'s tests read each pre-step fixture through `__tests__/rawFixture.ts`**, a helper the
  Tests section does not list: it lays a fixture out as the carriers the cutover reads (the `apps` root
  columns as text and one `blueprint_entities` row per entity, as `lib/db/blueprintRows.ts::decomposeBlueprint`
  does, without its head schema parse) and hands them to `oldShape.ts::readRawDocument`, so every suite
  meets a document the way the transform does.
- **G2 ran during pull request 14's implementation, outcome A**, where Written and not yet run puts it in
  the pull request's CI: `containerArtifacts.test.ts`'s self-contained-bundle test runs
  `hq-round-trip-case-writes.cjs --help` with no `node_modules` and passes, and esbuild's metafile for the
  `maintenance-build` line lists `pg-native` as the bundle's one external package and no `sharp` or `@img`
  input. The bundle line stands without `--external:sharp`, stage `maintenance` takes no `COPY --from=deps`
  line, and runbook step 1(b) adds no `require("sharp")` check. The pull request's CI runs the same test
  again.

- **The fold horizon migration runs as two `sql` calls**, one per `CREATE OR REPLACE FUNCTION`, where
  `20261020000000` ran both in one: `lib/case-store/CLAUDE.md`'s one-statement rule. Each body is
  `20261020000000`'s with the `public.` prefix on its name and the one case-writes arm; no later migration
  redefines either function. `lib/agent/change-set/__tests__/foldHorizonFixture.ts` gains
  `writeHqRoundTripCaseWritesHorizon`, sharing one write with the expressions horizon's, since the extended
  `preHorizonReads.postgres.test.ts` has no other way to write the sixth horizon.
- **`parseHead` takes the app id** (`parseHead(appId, persisted)`): `oldShape.ts::RawDocument` carries none and
  `lib/domain/blueprint.ts`'s schema requires one; the structure phase's `persisted` is the rewritten
  `RawDocument`, assembled by `oldShape.ts::rawDocumentAssembly`.
- **A module with two no-matches forms moves the first in `formOrder`** and drops the others' `entry` keys
  beside `renamed-concept-conflict`, so the rest of the document is still judged; the blocker already leaves
  the app with no target. **An empty stored no-matches label is dropped**: `caseListRegistrationFormSchema`
  requires a non-empty label, and at `main` an empty one read as the form's name, as an absent one does.
- **`LiftedFacts.fieldWrites` holds an entry for every form**, empty where nothing writes, so C1 gives every
  case form its own arm. **`structure-parse` finding codes** are `<zod code>:<path>`, with the sorted keys of
  an unrecognized-keys issue appended; no value or message is kept.
- **`LiftedFacts.todaysPlacements` is keyed by `placementUnitKey(formUuid, unit)`** (`<formUuid>|<unit>`),
  since section 8.2's unit keys `own`, `usercase` and `own-close` repeat across forms, and **`TodaysPlacement`
  carries `guards`**, the `nova_guard_<id>_<kind>` blocks `main` wrote beside an operation, which `facts.json`
  lists under the operation's unit. `PlannedChange.kind` is a string each step module spells, since this part
  enumerates no registry of change kinds.
- **The frozen placements of a several-case form** give a child bucket only its Save to Case placement under
  `nova_selected_cases/item`: HQ writes no basic case block in a multi-select menu (commcare-hq
  `corehq/apps/app_manager/xform.py::XForm._create_casexml` turns `default_case_management` off when
  `module.is_multi_select()`). A URL-mode capture counts as an own-case writer of such a form, as a publish
  with an attachment target emitted it. No fixture holds either shape. `frozen/rawForms.ts` holds the raw
  reads the four frozen copies share.
- **What a question or search step records as a change**: only what it writes (`starting-value-written`,
  `workflow-written`, `count-wrapped`, `field-list-set`); `load-time-value-reads-case`,
  `repeat-rows-follow-query`, `repeat-count-node-removed`, `group-shows-one-per-screen` and row 6's
  `menu-opens-on-search` are notice entries alone, so the judgement's idempotence compares the digest and the
  edits, never the notice. `starting-value-reads-case` is written only where a starting value was replaced
  (part 01 §22 C7). `search-workflow` skips a menu whose stored search already holds `workflow` or
  `formsReadSearch`, which `main` could not store. `repeat-count-node-removed` names only a direct,
  unmaterialized count into a Hidden Value (part 04 §7.1 Q3), and the count wrap reads the Project's lookup
  types through `lookupTypeIndex(ctx.lookupContext)`.
- **The notice's missing details read a general phrase** where section 17.2 gives none: "one of its
  destinations" for a link with no `to`, "its case property" for a starting value with no property, "the
  value that holds it" for a count node with no hidden name, "the new case" with no case type; an unknown
  Otherwise word reads "where its Otherwise says" without the "set as the form's Otherwise" clause, and an
  unknown `from` reads "the place it was set to". `repeat-count-whole-number`'s copy names the expression
  `int(...)`, which the copy test's voice check exempts as an expression, not an ellipsis.
- **`notice.ts::entriesForApp` drops exact duplicate lines** (by `canonicalJsonText`) beside one
  `module-made-advanced` per module, and **`nextPublishAsksMore` takes `PlanFeatureId[]`**:
  `lib/publish/planFeatures.ts` has no `save_to_case` id, and the Save to Case privilege is
  `advanced-case-actions`.
- **Catalog reads name what a missing object lives on** (`public.<table>` for a constraint, `public` for a
  relation or routine, `this database` for a schema), throw where a map read's reg* resolves and no row
  answers, and leave aggregates out of `schemaRoutines` (`pg_get_functiondef` refuses them).
  `classifyApplied` reads markers without the horizon migration as `partially-applied` and the horizon over a
  fleet of no apps as `already-applied`. `SettleOutcome` gains `failed`, since the exported
  `reapStaleDesignSessionRun` returns `"failed"`, and `holders.ts` reads the session lease columns from
  `lib/db/actorGenerationGate.ts::DESIGN_SESSION_LEASE_COLUMNS`.
- **The fleet read**: live deployments exclude a mapping CommCare HQ reported missing, as steps 3 and 4 did,
  while published ones include it (section 8.1); an app discards private work where it has an open workspace,
  an open change set or an active candidate (section 3's three kinds). Entry points are read from the
  document, which holds them. The report prints design-session ids as counts only, gives each path-move cause
  its deployments and their forms, counts the drift scan from the planned schema changes, and owns its
  always-printed `outcome` line (`report.ts::reported`); `databaseImage` orders rows by their text
  (`COLLATE "C"`).
- **The modes take a `RunDependencies` object** (the ledger and marker reads, the fleet snapshot, the holder
  census, the reapers, the writer), so `run.test.ts` drives every mode with the real `planFleet` and a
  database handle that throws on use. The dry run and the scan also exit 1 on a blocker or a holder, as step
  4's did; a failed postcondition reports the class `postcondition`; `--debug-details` also prints the holds,
  path moves, notice entries and schema changes. `__tests__/storedSchemas.ts` seeds the stored case schemas
  the scan and holders tests share.
- **An operation unit held at a basic subcase reads its rows through its `forEach` repeat**
  (`placements.ts::emitsAt`): a second application over a target whose child create the first held at
  `subcase-row` under an unknown baseline reads that create as an operation unit, whose key names no repeat,
  so the verification found its block nowhere and the judgement refused every such app as `not-idempotent`.
  `transform.test.ts` holds the case for an `unread` and an `absent` baseline.
- **`MISSING_CHILD_CASE_MODULE` is removed** (the advisory scan's first blocker class). The rule refused a
  form that creates child cases of a type no module lists. `main` counted only a field's own `caseWrite` as
  such a create, while the head counts every create operation, so every create a person authored as an
  operation at `main` met the rule for the first time at `target-gate`. CommCare HQ's app validator asks a
  subcase for its case type and nothing more (`corehq/apps/app_manager/helpers/validators.py::
  FormValidator.check_actions`), so the rule answered no wire fact. The gate stays the one arbiter for
  all three editors, so no editor refuses the shape on its own either. A planned record still needs no
  module, and removing a type's last module still retires its record or names what still uses the type
  (`lib/doc/caseTypeRetirement.ts`).
- **A question's kind fits a declared integer-to-decimal or choice-to-text property** (the second class). The
  head counts every operation write whose value is a question's bare answer as that question's Saves to, and
  `FIELD_KIND_PROPERTY_TYPE_MISMATCH` asked an exact match of kind and declared type, where `main` held the
  same write, as an operation's, to `ruleSets.ts::isWriteAssignable`: an integer into a decimal property and
  a single select into a text one were admitted at `main` and refused at the head. The kind rule now also
  admits exactly those two directions (`fieldKindMatchesPropertyType.ts::declaredTypeHolds`), whose values
  the declared type's readers read back; free text into a declared choice property stays refused, since a
  choice question starting on it may meet a value it doesn't offer. Writers of an undeclared property agree
  (`FIELD_KIND_WRITERS_DISAGREE`, the inferred property type, and the writer opinions a case operation's
  write reads) on the one of their types that holds every other (`ruleSets.ts::agreedStorageType`), the join
  Hidden Values already used. Since an integer writer beside a decimal one makes the property hold decimal
  numbers, a whole-number question can't start on it: `IntegerData.cast` reads its starting value with
  `Integer.parseInt` and stops the form on `2.5`. The new rule `WHOLE_NUMBER_STARTS_ON_DECIMAL`
  (`lib/commcare/validator/rules/wholeNumberStart.ts`) refuses an integer question whose starting value
  types as a decimal. Starting such a question blank is no remedy, since a blank answer on a one-case form
  saves blank and clears the case's value (`lib/commcare/xform/caseBlocks.ts::updateBlock`, HQ's
  `XFormCaseBlock.add_case_updates`, Core's `CaseXmlParser.updateCase`), so `planFieldCaseWrite` refuses a
  new save whose question can't open on the case's value (`lib/domain/startingValueFit.ts`), a choice
  question on a property holding other values included, and C7's `planExplicitPreloads` writes main's
  starting values unchanged for the rule to judge.
- **A Hidden Value's branches are held to the property only where one would break a reader** (the advisory
  scan's Hidden Value class). Decision 32 stands: a Hidden Value is the typed writer of the first property an
  operation saves its answer to, so a calculation `main` admitted beside an operation, giving several choices
  and a blank from different branches into a text property, or text and several choices into an untyped
  one, met `HIDDEN_VALUE_WRITER_TYPE_MISMATCH` at the head. `inference.ts::hiddenWriterVerdicts` now holds
  every branch to the property only where it is a type a loading question casts
  (`casePropertyTypes.ts::CASTING_PROPERTY_TYPES`, moved from the rule: a date, time, number or location,
  whose text a question can't read stops the form) or several choices, which Nova's case store keeps as a
  list and can't hold other text in. A text or single choice property takes whatever text one branch gives,
  so it judges the Hidden Value by its whole inferred value through `isWriteAssignable`, as `main` judged
  the operation that saved it and as an operation's own write still is: a date saved to a text property
  stays refused, and a calculation whose branches agree on no one type is admitted. A Hidden-only
  disagreement is refused only where it names a type a question casts.
- **Step `blank-comparisons` is added** (section 7.12, step 14; placements, the judgement and the
  deployment lines become 15 to 17). Decision 32 types a Hidden Value saved to a number, date, time or
  location property as that type, so a case operation condition comparing it with `''`, which `main` admitted
  over the untyped value, met `incompatible-values`. The step rewrites each such refused comparison as a
  blank test, which a device runs identically for every value but a yes/no (section 7.12's proof), and
  leaves an answer that can hold a yes/no to `target-gate`.
- **Stored capture reads become links** (section 7.4, clause 0; the advisory scan's capture class). The
  head saves a capture only as the link to its file, and an operation authored at `main` whose write saved
  a capture's bare answer, the file's name, met the checker's `capture-answer` refusal. The step writes the
  link in its place, with the new document reason `capture-saves-link-not-name`, and makes the new blocker
  `capture-write-unlinkable` of a place where the link can't be saved: a case's name or external id
  (`CAPTURE_CASE_WRITE_STANDARD_PROPERTY` at the head) or a property whose type holds no text. The rewrite
  leaves every inferred property type as it was, since a capture's answer and its link both hold no type
  opinion (`inference.ts::writerOfValue`). The fixture `pre-step-capture-answer-written` holds the shape.
- **C9 reads its conditions as the form does, and keeps a retype's guard** (section 7.4; the advisory scan's
  close class). The form's close condition refuses a `prop` read through a relation (`typeChecker.ts::
  termAdmission`, `prop-relation`) and reads no row, so C9 writes each read of the operation's row, and of a
  case above it through parent links, as `form-case`, passes only the term and expression kinds the form's
  close condition holds, and makes the new blocker `own-close-condition-reads-case` of anything else,
  naming what it reads, rather than leaving it to `target-gate`. A read of the row after a retype is refused
  too: the operation reads it under the retyped type, whose properties the form's read under the module's
  type need not name. Each close's term also takes the condition of a
  conditional retype it followed (`caseOperationConditionalGuardUuids`), which `main`'s emission made its
  guard; a read of the fleet found no such close, nor a close over a question in a repeat (C6's
  departure above), and the fixture `pre-step-close-reads-cases` holds the own and the parent read. The
  head's case-operation emission printed no `form-case` read, so a close form whose close condition reads
  its case and whose close is a Save to Case close stopped emission: `lib/commcare/xform/caseOps.ts`
  now binds the form's read (`formCaseRead.ts::formCasePropertyRead`) where it prints the own close.

## Executed during planning

Light reads on this machine; one production read, approved by the person.

1. Nova history: `733dd193` (step 3's `writer.ts`: `WRITER_STEPS`, `abandonPrivateWork`, `writeApp`,
   `applyLedger`; `oldShape.ts`), `a8af778e` (step 4's `writer.ts::checkPostconditions`,
   `__tests__/postgresSeed.ts::databaseImage`, `writer.postgres.test.ts`'s namespace, `VACUUM FULL` and
   `enable_indexscan` lines and its name-only reads), `2f985ed6^` (step 4's runbook as run), and `2f985ed6`
   (the removal's message).
2. Nova at `main`: `lib/notices/migrationNotice.ts` and `migrationNoticeCopy.ts` (the reason lists, the
   `next-publish-asks-more` renderer's `settings`, `planFeatures` and `capabilities`, the leads),
   `lib/db/CLAUDE.md`'s fold identities, `20261020000000_hq_round_trip_expressions_fold_horizon.ts`,
   `lib/case-store/migrations/` (the last applied, `20261101030000`), `20261004000000_app_test_lookup_definitions.ts`
   (what a namespace copies), `config/deployment-jobs.json` (`commcare-nova-historical-repair`'s contract),
   `scripts/rollout/deploy-cloud-run.py`'s arms, `Dockerfile`'s maintenance stages, `.dockerignore`,
   `scripts/lib/schemaDrift.ts` (the worker's-record skip), `scripts/migrate-schema-drift.ts`,
   `lib/commcare/formActions.ts::caseUpdateQuestionPath`, `lib/domain/datetimeSplitIdentity.ts`,
   `lib/domain/expression/reduction.ts`, `lib/db/__tests__/appStateTestDb.ts::setupAppStateTestDb`,
   `lib/deployment/stateMachine.ts::deploymentDisplaysAsReached`, `lib/db/appTests.ts`' refusals,
   `content/docs/publishing.mdx` and `content/docs/mcp/tools.mdx`.
3. The CommCare checkouts at the pins, read in place: the four facts of section 2.
4. The content-free, read-only production scan of decision 16, run with the person's yes; section 19 lists
   its classes, and its findings are folded in, in words, at each place they decide.

## Written and not yet run

G1 is the production scan, run during planning (Executed during planning, item 4). Every run below is on
GitHub's runners or production's Cloud Run, never a load on the person's machine; none bills a model call.

**G2. Does the bundle reach `sharp` at load** (pull request 14's CI, `containerArtifacts.test.ts`'s
self-contained-bundle test, which runs each bundle's `--help` with no `node_modules`).

- *Outcome A:* it passes: the bundle line stands without `--external:sharp`.
- *Outcome B:* it fails on `sharp`: the line takes `--external:sharp`, stage `maintenance` takes step 4's three
  `COPY --from=deps` lines (`node_modules/sharp`, `node_modules/@img`, `node_modules/detect-libc`), the test
  runs `--help` from a directory whose `node_modules` holds only those three and checks them, and runbook
  step 1(b) adds `docker run --rm --platform=linux/amd64 --entrypoint=node "$IMAGE" -e 'require("sharp")'`.
  Pull request 16 removes the three lines with the rest.

**G3. The plan's duration** (runbook step 1(d), the advisory dry run).

- *Outcome A:* its `fleet` line's plan milliseconds are at most 3,600,000: `7200s` stands.
- *Outcome B:* above: the window is not opened; the contract's `timeout` becomes twice the measured seconds
  plus 1,800, rounded up to a whole minute, in pull request 14's `config/deployment-jobs.json`, under the
  review rule; `--wait-seconds` moves with it (the timeout plus 60); the image is built again and step 1
  repeats.

**G4. HQ's reads of the pre-step placements** (part 08's G1, pull request 1's CI and its second commit).

- *Outcome A:* every placement class of section 8.2 has a read whose block `publishedCaseBlocks` finds:
  `placements.test.ts` reads them as written.
- *Outcome B:* a class has no read holding its block (HQ's read drops or rewrites it): that class is never
  held; `placements.ts` gives it the simplest placement, its deployments get `form-data-paths-move` with cause
  `placement-simplified`, section 8.5's table gains the class with "HQ's read does not keep it", and part 08
  rewrites that witness's migrated spec.
- *Outcome C:* a pre-step spec is refused by `main` or its capture stops: part 08 corrects it in the first
  commit; this part's capture test reruns over the corrected fixture.

**G5. The heap-order precondition** (pull request 14's CI, `catalog.postgres.test.ts`).

- *Outcome A:* the `ctid` precondition holds and the name-only control reads the decoy: the test proves
  `catalog.ts`.
- *Outcome B:* the precondition fails on CI's Postgres: the test fails loudly as a harness defect, and the
  seeding moves: the decoy is created after the `VACUUM FULL`s and the live objects are dropped and re-created
  after it, repeated until the `ctid` order holds. The cutover does not ship on a test whose precondition is
  assumed.

**G6. The frozen classifier against production's baselines** (runbook step 1(e), the advisory dry run's
`placements` line).

- *Outcome A:* `frozenDisagrees` is zero: section 8 stands.
- *Outcome B:* some disagree. For each, `--debug-details` names the form and unit, and the operator reads the
  deployment's `pushed_at` against step 4's deploy. Where the push came from older code (before step 4's
  deploy) and the app has not changed since, the baseline is what that code wrote: the match of section 8.3
  already decides each unit by what the baseline carries, so nothing changes, and the evidence records it.
  Where the push came from `main`'s code, the frozen copy differs from `main` on a shape the fixtures lacked:
  a defect of pull request 14, fixed there under the review rule with a planted raw document of that shape in
  `frozen.test.ts` (its expected placement read from the production baseline's block identity, which carries
  no content); the image is built again and step 1 repeats.

**G7. The drift writer converges the planned differences** (runbook step 9, after the deploy).

- *Outcome A:* the scan before names exactly step 5's `schema` line, and the scan after reports none:
  ingress reopens.
- *Outcome B:* an app the writer could not converge: it runs again with `--app <id>` until the scan reports
  none. A difference the dry run did not plan is recorded and explained after the window; the writer still
  runs, because past the deploy the only way is forward, and a defect it reveals ships as a pull request with
  its own review. Ingress stays closed until the scan is zero.

**G8. The advisory dry run's blockers** (runbook step 1(d) to (f)).

- *Outcome A:* the outcome is `ok`: the window is planned.
- *Outcome B:* blockers: each is resolved by its remedy in section 16 (the author's in today's builder; a
  defect in pull request 14 under the review rule), and (c) to (e) repeat until `ok`.

**G9. The witnesses' moves against the notice** (part 08's G6, pull requests 2, 3, 4, 7, 9, 10 and 11).

- *Outcome A:* every identity move proof 1 shows on a witness is one a cause of section 9 names: the notice
  stands.
- *Outcome B:* a move no cause names, which the migration decides: `PATH_MOVE_CAUSES` gains a cause named for
  it in pull request 14, the `form-data-paths-move` renderer needs no change (it names counts), and part 08
  writes the move.
- *Outcome C:* an expected move does not happen: nothing changes here, because each cause is computed from the
  emission and so writes nothing where nothing moves.

## Files by pull request

**Pull request 1 (with part 08).** New: `scripts/lib/hqRoundTripCaseWrites/__tests__/fixtures/pre-step/`
holding the eight witnesses' documents (part 08 writes them from the emitted `document.json`) and
`pre-step-own-close-operation.json`, `pre-step-duplicate-own-write.json`,
`pre-step-registration-updates-own.json`, `pre-step-renamed-concepts.json`, `pre-step-search-results.json`,
`pre-step-otherwise-unoffered.json`, `pre-step-preload-readers.json`; `facts.json`; `digests.json`;
`__tests__/fixtures.capture.test.ts`; `__tests__/fixtures.digest.test.ts`. No `lib` or `app` file.

**Pull request 2.** Deleted: `scripts/lib/hqRoundTripCaseWrites/__tests__/fixtures.capture.test.ts`.

**Pull request 4.** New: `lib/domain/caseWriteOperationIdentity.ts`,
`lib/domain/__tests__/caseWriteOperationIdentity.test.ts` (beside part 01's and part 08's
`lib/doc/fieldWriteOperations.ts`, which calls it).

**Pull request 14, the cutover.**

- Storage: `lib/case-store/migrations/20261110020000_hq_round_trip_case_writes_fold_horizon.ts` (new),
  `lib/case-store/migrations/index.ts`, `lib/case-store/migrations/__tests__/caseWritesLedger.postgres.test.ts`
  (new), `lib/agent/change-set/__tests__/preHorizonReads.postgres.test.ts`, `lib/db/designSessions.ts` (two
  exports), `lib/db/__tests__/runHolderWriteGuard.test.ts`, `lib/db/CLAUDE.md` (section 1's sentences).
- Notice: `lib/notices/migrationNotice.ts`, `lib/notices/migrationNoticeCopy.ts`,
  `lib/notices/__tests__/migrationNotice.test.ts`, `lib/notices/__tests__/migrationNoticeCopy.test.ts`,
  `components/builder/notices/__tests__/appNoticeModel.test.ts`.
- Docs kept: `content/docs/publishing.mdx`, `content/docs/mcp/tools.mdx` (section 17.3's two passages).
- Scripts and the runbook, new, deleted by pull request 16: `scripts/scan-hq-round-trip-case-writes.ts`,
  `scripts/migrate-hq-round-trip-case-writes.ts`, `scripts/lib/hqRoundTripCaseWrites/**` (section 6's layout and
  the tests above), `docs/plans/hq-round-trip/5-cutover-runbook.md`.
- Infrastructure and docs, edited, their additions removed by pull request 16: `config/deployment-jobs.json`
  (the contract), `Dockerfile` (the bundle line), `.dockerignore` (three lines),
  `scripts/rollout/deploy-cloud-run.py` (the branch, `PLAN_DIGEST_RE`),
  `scripts/infra/tests/test_deployment_policy.py`, `scripts/infra/__tests__/containerArtifacts.test.ts`,
  `scripts/README.md` (the entry), `docs/architecture/deployment.md` ("Historical repairs" gains: "The HQ
  round-trip case-writes cutover runs on its own Job, `commcare-nova-hq-round-trip-case-writes`, from the
  maintenance image as `hq-round-trip-case-writes.cjs`. With no override the Job runs the dry run, which writes
  nothing; `--settle-holders` and `--execute --expect-plan-digest <digest>` are its only other admitted
  shapes. Its runbook is `docs/plans/hq-round-trip/5-cutover-runbook.md`; the tool, the Job, the runbook and
  this paragraph leave together once the cutover has run.").

**Pull request 16, the removal.**

- Deleted: both scripts, `scripts/lib/hqRoundTripCaseWrites/**` (its `fixtures/pre-step/` included),
  `docs/plans/hq-round-trip/5-cutover-runbook.md`, `docs/plans/hq-round-trip/5-case-writes-forms-navigation.md`
  and `docs/plans/hq-round-trip/5-case-writes-forms-navigation/`.
- Edited, their pull request 14 additions removed: `config/deployment-jobs.json`, `Dockerfile`,
  `.dockerignore`, `scripts/rollout/deploy-cloud-run.py`, `scripts/infra/tests/test_deployment_policy.py`,
  `scripts/infra/__tests__/containerArtifacts.test.ts`, `scripts/README.md`, `docs/architecture/deployment.md`,
  `lib/db/__tests__/runHolderWriteGuard.test.ts`.
- Edited otherwise: `lib/db/designSessions.ts` (both functions module-private, `reapStaleDesignSessionRun`
  returning `Promise<void>`). `docs/plans/hq-round-trip/README.md` and the step 6 and 7 outlines are part 10's,
  from section 22's trace.

**What this part takes from beneath it**, each named in the pull request that adds it: the witnesses, their
retained A and HQ's reads (1, part 08); `lib/doc/repeatCountWraps.ts::planRepeatCountWraps`,
`effectiveQueryRepeatPlacement`, `queryRepeatPlacementNeeds`, `QUERY_REPEAT_PLACEMENTS` and the query
repeat's `placement` slot (3, part 04); `lib/doc/fieldWriteOperations.ts::operationsFromFieldWrites` with
`FieldWriteFact`, `lib/doc/explicitPreloads.ts::planExplicitPreloads`, the own arm, the operation's
`placement` slot and `Form.ownClosePlacement` with `lib/domain/placements.ts::casePlacementSchema` and
`ownClosePlacementSchema`, the `capture-link` term, `Form.openCondition` and `closeCondition` as
`Expression`s, `lib/commcare/placement.ts::planPlacements` and part 02's `planFormCaseWire` basic and Save
to Case arms (4); `holdPlacements` with its `case-operation`, `own-close` and `query-repeat` targets,
`lib/doc/placementHolds.ts::holdExpresses` (5, part 03); `publishedCaseBlocks`, the publish-placement
migration (6); `linkCarriedCreates`, `emittedModuleKind`, `advancedKindBlockers`, `Module.heldKind` and
`holdPlacements`' `module-kind` target (7); `commtrackReasons`,
`sameTypeBasicChildCases`, `COMMTRACK_OFF`, the CommTrack migration (8); `planGroupFieldLists`,
`Field.fieldList` (9); `authoredSearchWorkflow`, `caseListMenuItem`, `caseListRegistrationForm`, the claim
type in `buildCaseTypeMap` (10); `mapFormLinkSemantics`, `Form.otherwise`, `OTHERWISE_DESTINATIONS`,
`menuTargetOffered`, `nearestOfferedMenu`, `planFormLinkUpdate`, `planFormLinkRemove` (11). From `main` as it
stands: `scripts/lib/schemaDrift.ts::computeSchemaDrift`, `schema-drift.cjs`, the
`commcare-nova-case-type-schema-retirement` contract and its allowlist arm.

## What other parts read from this one

| Part | Reads |
|---|---|
| 01, case writes (4, 5) | section 7.4: C9's rule for an operation holding writes and for close forms, `own-close-in-repeat`, the cause `own-close-moved`, the document reason `form-became-close-form` for a follow-up form C9 makes a close form, and class (e)'s session `update` operations left as operations; `FieldWriteFact` as the type `operationsFromFieldWrites` takes, and section 10.1's identity module it calls; section 8's holds over the own arm and the own close, and `placement-path-mismatch` for a hold `planPlacements` cannot express |
| 02, advanced and extension (7) | section 7.6's use of `linkCarriedCreates` and `advancedKindBlockers` over every create whatever its relationship, its retargets through part 06's planners, no Save to Case hold of a carried create and no basic hold in a module made advanced (section 8.5), no `module-kind` hold, the causes `extension-case-moved`, `subcase-renumbered` and `module-made-advanced` |
| 03, publish and ledger (5, 6, 8) | section 8.1's definition of published (a mapping marked missing included), the unread rule's two `unknown` kinds (`unread`, `absent`) and the blocker `baseline-unreadable` for stored bytes that fail gunzip, digest or parse, `holdPlacements` written once per app through the reducer with no kernel batch (section 8.3), `placements-kept-unread`'s place in `DEPLOYMENT_NOTICE_REASONS`, the `next-publish-asks-more` ids, the two migrations applied in section 11's one phase |
| 04, questions (3, 9) | section 7's use of `lib/doc/repeatCountWraps.ts::planRepeatCountWraps` (part 04's name, which part 08's fuzz mapping also calls), `planGroupFieldLists` with the frozen label rule, Q1 holding only model iteration, and section 17.2's use of its copy |
| 05, search and menus (10) | sections 7.1 and 7.8; `menu-opens-on-search` rendered with part 05's two sentences by `detail.opensOn`; that `computeSchemaDrift` does not skip `commcare-case-claim` (section 12), so M6's claim row is the planned difference `claim-type-row` the drift writer converges after the deploy |
| 06, form links (11) | section 7.5's mapping, `OTHERWISE_DESTINATION_WORDS`, `form-link-removed` registered after `form-link-target-moved` with §14.4's copy, and no form-link blocker; under part 06's G2 outcome B, L8's `cause: "carried-not-a-case"` rendered with §19.2's sentence on `form-link-target-moved`; the retargets of section 7.6 written through `planFormLinkUpdate` and `planFormLinkRemove` |
| 07, authoring (12, 13) | the control names section 17.2 uses; that no tool carries a sentence for work begun before the cutover |
| 08, proof (1, 2) | the fixtures of section 5.2 beside its witnesses (`pre-step-own-close-operation` holding C9's writes and `forEach` arms, which the case-writes witness does not), `facts.json`, `digests.json` and the two tests in pull request 1; the capture test's deletion in pull request 2; `transform.test.ts`'s planner test and `placements.test.ts` over `proof/hq-reads`; G4 and G9 as this part's landing of its G1 and G6; for `harness-findings.md`, "Found while planning step 5": step 4's test read constraints and columns by name (section 21.2), the publish-placement kind is a trigger, and the `previous` refusal's HQ function (section 2) |
| 10, stack and contracts (14 to 16) | the files above; `lib/db/CLAUDE.md`'s six identities in pull request 14; the deployment paragraph; section 22's trace for "Step 5 is done", whose eighteen document reasons include `form-link-removed`, `form-became-close-form` and `capture-saves-link-not-name`; the blocker list of section 16, which holds `baseline-unreadable` and no form-link blocker; that pull request 1 changes no `lib` or `app` file (check 5) and pull request 2 deletes the capture test; the review rule |
| **For the outlines** | Step 6 (import): its drift merge inherits the unread rule, and it reads placements from HQ's own source through `publishedCaseBlocks`, needing no frozen classifier, because an imported app has no Nova emission before it; the witnesses' retained reads stay for its tests. Step 7: nothing from this part |
