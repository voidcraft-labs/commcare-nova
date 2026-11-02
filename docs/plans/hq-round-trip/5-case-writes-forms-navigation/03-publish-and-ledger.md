# Step 5, part 03: Publish and the ledger

Part of [step 5's plan](../5-case-writes-forms-navigation.md), which holds the baseline, the decisions,
the exit and the stack. Stack references use the sixteen pull requests by number. This part plans what a
publish records, refuses and offers about where CommCare HQ keeps each case write: the one mutation that
writes a held placement (`holdPlacements`) and the rule that decides who may write it, the
`publish-placement` app change and how a publish records it, how open builder tabs fold it and how an
edit composed before it is refused and offered again, the placement moves a publish offers, defect 12's
links between cases of the same type, CommTrack's confirmation (`commtrack-off`), the
`VIEW_FORM_ATTACHMENT` check over link writes, the reader of the case blocks a deployment's drift
baseline holds, published deployments whose baseline Nova could not read, and what the HQ import file and
the `.ccz` carry. It plans its share of pull requests 5, 6 and 8 in full, names the lines it adds to pull
requests 2, 4, 7, 10, 14 and 15, and names what each hands to other parts.

Citations are `path::symbol`: Nova at `main` `2f985ed6` (#825), and the Dimagi checkouts at the pins
`proof/pins.json` names, unchanged since step 2: commcare-hq `d6c6e16d8ae1`, commcare-core
`8e9ba8d908e9`, commcare-android `7a5584475580`, formplayer `24383ac71bfb`, commcare-connect
`046c7fd78081`, Vellum `01215f251c57`. Every CommCare fact below was read at those commits for this part.

Versions at `2f985ed6`: `lib/models.ts::MODEL_CONTEXT_VERSION` is `"v5-hq-round-trip-platforms.12"` and
`lib/db/appTests.ts::RUNTIME_VERSION` is `17`. Nothing in this part moves either. Every tool it changes
(`upload_app_to_hq`, `withdraw_deployment_confirmation`, `check_project_space_compatibility`,
`compile_app`) is served by MCP alone, and the Solutions Architect holds no deployment tool
(`lib/deployment/CLAUDE.md`, "Surfaces"), so this part adds no `scripts/test-schema.ts` entry;
`lib/mcp/__tests__/servedSchemas.test.ts` holds what a client receives. The authoring guide's one
paragraph about identity moves is part 07's.

| Section | Owns | Pull request |
|---|---|---|
| 2 | the `holdPlacements` mutation, its reducer, admission, diff and history rules | 5 (module kind arm: 7) |
| 3 | who may change a held placement: `placementChangeRefusal` and the recorded holds it reads | 5 (the publish kind joins in 6) |
| 4 | the `publish-placement` app change kind and its database admission | 6 |
| 5 | recording placements at publish: `placementsToHold`, `recordPublishPlacements`, the head fence, `reloadHead` | 6 |
| 6 | open tabs: the frame fold that keeps undo, the placement conflict, and the tab's recorded holds | 6 (recorded holds: 5) |
| 7 | the placement moves a publish offers | 6 (`save-to-case`), 8 (`same-type-child-links`) |
| 8 | defect 12: links between cases of the same type | 8 |
| 9 | CommTrack: the `commtrack-off` confirmation | 8 (the menu item's lane witness: 10) |
| 10 | `VIEW_FORM_ATTACHMENT` over link writes | 4 |
| 11 | what a deployment's baseline holds: `publishedCaseBlocks` | 6 |
| 12 | published deployments with an unread baseline | 14 (part 09 runs it) |
| 13 | the HQ import file and the `.ccz` | 6 and 8 |
| 14 | MCP and scopes | 6 and 8 |
| 15 | Preview | none |
| 16 | every string this part adds or changes | 4, 5, 6, 8, 14 |
| 17 | what this part needs of the proof lane | 5, 6, 8 and 10 (part 08 holds the lane detail) |
| 18 | migration classes for the one cutover | 14 |
| 19 | contracts and docs these changes make false | 5, 6, 8, 15 |

---

## Decisions in brief

1. **One mutation writes every held placement: `holdPlacements`** (decision 4). Its entries are
   `{target, placement | null}` over four targets: a case operation, a form's own close, a query
   repeat, and a module's kind. No other mutation's payload carries a held slot, so every editor, the
   publish, the cutover's repairs and the diff writer reach a hold one way. The reducer computes
   nothing: whoever writes the mutation computed the value.
2. **A history step carries exactly the hold changes the kernel admits an editor.** Part 07's
   `BlueprintDocState.applyHistoryStep` derives each inverse so it carries only a move its own batch
   makes necessary or the restore of the hold the target's latest recording wrote. So undoing an edit
   that moved a placement puts the change and its hold back where the published app has them, and
   undoing the removal of a held operation re-creates it with its recorded hold. The tab knows the
   recorded holds because its document read carries them (section 6.3).
3. **Who may change a held placement is one prev/next rule in the kernel**,
   `lib/db/placementAuthority.ts::placementChangeRefusal` (decision 4, P2): `publish-placement` and
   `blueprint-migration` may change any hold; an editor's batch may change one only where (a) the same
   batch makes the earlier hold inexpressible, or (b) it restores, for that target, exactly the hold
   the latest recording wrote (the latest `publish-placement` or `blueprint-migration` row, else the
   greatest fold baseline's snapshot). Everything else is refused. It reads the documents and the
   recordings, not the mutations, so a forged autosave and a stale undo meet it alike.
4. **`publish-placement` is a seventh app change kind**, placed after `chat`. Its row holds a nonempty
   batch of `holdPlacements` only, no run, null Project-move columns, and the publishing person as actor.
   The database enforces all of that in `public.nova_admit_app_change_insert()`, replaced by migration
   `20261110000000_hq_round_trip_case_writes_publish_placement` (decision 11); `app_changes.kind` has no
   CHECK constraint to widen.
5. **`CLIENT_APP_CHANGE_KINDS` splits in two**: `EDITOR_APP_CHANGE_KINDS` (`autosave | mcp | chat`, the
   kinds an editor's own batch commits under) and `COLLABORATION_FRAME_KINDS` (those three plus
   `publish-placement`, the kinds a browser tab folds without a reload). The one constant answered two
   questions, and from step 5 the answers differ.
6. **A publish records the placements it emits after preflight passes and before anything is sent**,
   as one `publish-placement` change at the head it emitted. The kernel commits it only while the app's
   head is still that revision; where the head moved, the publish reads the new head through the
   caller's `reloadHead` and runs preflight again, three times at most, then refuses
   `app_changed_while_publishing` with nothing sent. A stop after the record keeps the holds.
7. **The recorded document is what the publish sends.** The prepared export boundary is reused with the
   recorded document and sequence in place of the old ones, so the pushed revision, the entry-point
   manifest's sequence and the emitted bytes all name the document that holds the placements. Recording
   a derived placement changes no emitted byte, which a property test holds.
8. **Open tabs fold a `publish-placement` frame as a peer's change**, keeping undo; no tab reloads.
9. **An edit composed before the record is refused with a typed reason and offered again.** The kernel
   carries the gate's finding codes on its refusal; the PUT route answers 409 `commit_rejected` with
   `reason: "placement-recorded"` when every finding is a held-placement finding; the reconciler keeps
   the rejected human batches, reloads as today, and hands them to the builder's
   `onPlacementConflict` handler, part 07's
   `components/builder/placementConflictReplay.ts::replayAfterPlacementConflict`, which calls part 07's
   `planConflictReplay` over the reloaded document and opens part 07's `IdentityMoveDialog` with the publish lead. A toast
   says so only where nothing can be offered. Every other 409 behaves as today.
10. **Two placement offers, one shape, all or nothing**: `save-to-case` (every case change held in a Save
    to Case block moves to Case Management, for a project space whose plan may lack Save to Case) and
    `same-type-child-links` (every new case of its module's own type held in a basic subcase moves to a
    Save to Case block, for a project space that drops that link). Each is a pure function of the
    document, carries a digest the person's acceptance names back, and is recorded by the publish as a
    `publish-placement` change before preflight.
11. **Defect 12 is a probed capability, `same-type-child-links`**, whose flag `DONT_INDEX_SAME_CASETYPE`
    must be off (decision 8). The probe plan gains `featureFlagsOff`, read through the same project-space
    list as the eleven required flags, inverted. A project space with the flag on refuses
    `project_space_incompatible` with the `same-type-child-links` offer. No validator rule: the shape is
    valid everywhere the flag is off.
12. **CommTrack is a fifth confirmation kind, `commtrack-off`** (decision 7), asked for an app with an
    advanced menu whose case list menu item is on, or with a form whose emitted source, decoded, holds
    the text `instance('commcaresession')/session/data/supply_point_id`. HQ's third trigger,
    `show_product_stock`, is unreachable and is no reason. Migration
    `20261110010000_hq_round_trip_case_writes_commtrack_confirmation` widens the kind CHECK. The
    confirmation lands in pull request 8; the case list menu item beside an advanced module's forms
    first exists in pull request 10, which brings that arm's lane witness.
13. **`VIEW_FORM_ATTACHMENT` reads link writes wherever they are placed and through any relation**: the
    `attachment-links` capability asks for every link write some case list or detail column shows,
    including a calculated column in a module of another case type that reads it through a relation,
    which today's predicate misses (finding N1), and every link write a form's label, hint or other prose
    prints, which both platforms render as a tap target inside a markdown link.
14. **`lib/commcare/hq/publishedCaseBlocks.ts` is the one reader of the case blocks HQ's build of each
    published form writes**, keyed by the form's `xmlns`, read from a deployment's normalized baseline.
    The cutover uses it now and step 6's import later.
15. **A published deployment whose baseline Nova could not read keeps today's placement for every
    operation and query repeat of its app** (decision 5), computed by a frozen copy of today's
    classifier in the cutover tooling and named by the deployment reason `placements-kept-unread`.
    Production holds such a deployment, so the rule applies at the window. A query repeat whose rule
    gives the count placement is the one exception: it moves to the count placement with its notice
    and deployment lines. A baseline whose stored bytes fail gunzip, digest or parse is the cutover
    blocker `baseline-unreadable`, repaired by refreshing that deployment; production holds none.
16. **Downloads record nothing.** The HQ import file and the `.ccz` emit each target's effective
    placement (held, else the simplest) and never write a `publish-placement` change; the import file's
    guide gains a CommCare Supply step and a same-type links step, and offers no move.
17. **MCP gains `accept_placement_moves` and `confirm_commtrack_off` on `upload_app_to_hq`** under its
    existing `nova.hq.write` scope challenge, two refusal tags, `placement_moves` in the refusal and the
    pre-publish check, and `placements` on every answer.

---

## 1. What Nova does today

**The app change log.** `lib/db/types.ts::APP_CHANGE_KINDS` is `["autosave", "mcp", "chat",
"blueprint-migration", "fold-baseline", "project-move"]`; `CLIENT_APP_CHANGE_KINDS` is the first three, and
its type `ClientAppChangeKind` is both what the canonical kernel accepts
(`lib/db/canonicalCommitKernel.ts::CanonicalCommitRequest.kind`) and what the browser frame carries.
`BlueprintMutationAppChangeKind` is `ClientAppChangeKind | "blueprint-migration"`. The comment on
`APP_CHANGE_KINDS` reads "Browser reconciliation accepts only the first three kinds". The database has no
CHECK on `app_changes.kind`: the BEFORE INSERT trigger function `nova_admit_app_change_insert()`
(installed by
`lib/case-store/migrations/20260728000000_canonical_identity_foundation/frozenDatabaseMigration.ts`,
trigger `app_changes_admit_insert`) raises on any kind outside the six, then admits `fold-baseline` only
empty and `project-move` only at the locked head, and refuses an empty batch for every other kind.
`lib/db/privilegeConvergence.ts` names the function by name and signature, not by body, and the frozen
foundation migration's catalog verifier (`assertFrozenFoldBaselineCatalog`) runs only inside that
migration and its tests, which is why step 2's and step 3's horizon migrations could replace a sibling
function with `CREATE OR REPLACE`
(`20261020000000_hq_round_trip_expressions_fold_horizon.ts`). Persisted rows parse through
`lib/db/persistedJson.ts` (`APP_CHANGE_KIND_SET`).

**The kernel.** `lib/db/canonicalCommitKernel.ts::commitCanonicalBatch` (behind
`lib/db/apps.ts::commitGuardedBatch`) locks the app row, reads the dedup latch, asserts the expected
Project, reauthorizes `edit`, refuses a non-chat writer while an initial build owns the app, refuses an
empty batch, refuses a batch whose targets a peer removed, prepares the candidate and runs the absolute
gate on the fresh head, and writes through `writeCommittedBatch` (entity diff, `app_changes` row, `apps`
update, `pg_notify` in the transaction). It applies the batch to the fresh head and has no head fence,
except the private-workspace sidecar's `baseSeq` ("The saved app changed after this private work began.
Discard and restart from the current app."). A gate refusal throws
`lib/db/commitGuard.ts::BlueprintCommitRejectedError` with `lib/doc/commitVerdicts.ts::describeCommitFindings`'
text; the error carries the text only. `lib/db/apps.ts::appendSyntheticBatch` is the repair and migration
writer: an expected base sequence, a batch derived by `lib/doc/diffDocsToMutations.ts::diffDocsToMutations`,
always kind `blueprint-migration`.

**The browser.** `lib/collab/mutationFrame.ts::mutationFrameEnvelopeSchema` admits
`kind: z.enum(["autosave", "mcp", "chat"])`. The stream route (`app/api/apps/[id]/stream/route.ts`, the
suffix loop) turns a row of those three kinds into a frame and treats any other kind as a disruptive
change that reloads the tab. The reconciler (`lib/collab/reconciler.ts`) classifies a frame as an echo
only when its `batchId` awaits echo or it is this tab's own chat run (`isEcho`); every other frame is
remote (`applyRemote`): `confirmedDoc` advances and the displayed document re-folds the human batches,
which rebases undo. A PUT answered 409 `commit_rejected` (`app/api/apps/[id]/route.ts`, from
`BlueprintCommitRejectedError`) is terminal for that batch and every later human batch over it: the
reconciler settles their watches as `conflict`, drops the store's queued commands and local history
(`lib/doc/store.ts::discardUncommittedCommandState`), reloads, and `lib/doc/hooks/useAutoSave.ts` shows
the fixed toast "App reloaded / This app changed in a way that conflicts with your edits. …". The
provider maps the 409 to `{ ok: false, kind: "commitRejected" }` and reads nothing else of the body
(`lib/collab/ReconcilerProvider.tsx`). `frameMayTouchCaseData` counts every mutation but a cosmetic
`updateField` as touching case data.

**History.** `lib/doc/store.ts::recordHistoryStep` records `{ forward, inverse }`, the inverse derived as
the document delta through `diffDocsToMutations` (or a direct field-patch or rename inverse). Undo and
redo apply the recorded batch through the ordinary write path after
`lib/routing/historyStep.ts::undoRedoGateVerdict`.

**Publish.** `lib/deployment/service.ts::publishAppToHq(input)` takes `doc` and `compiledAtSeq` from its
caller (`app/api/commcare/upload/route.ts` reads `app.mutation_seq` after `resolveAppAccess(…, "edit")`;
`lib/mcp/tools/uploadAppToHq.ts` reads it through `lib/mcp/loadApp.ts::loadAppBlueprint`) and writes
nothing to the document. Its order: `readDeployment`, `runDeploymentPreflight`
(`lib/deployment/preflight.ts`, checks `PREFLIGHT_CHECK_IDS`), the preflight fold with
`ensure: true`, `beginDeploymentContentWrite`, `onUploadStarted`, the shell create on a first publish, the
resource pushes, the second read, `hqImportApplication` over `preflight.ready.prepared`, the import, the
read-back baseline, `recordRemoteResource({ pushedRevision: input.compiledAtSeq, … })`, and the
entry-point manifest with `sourceSequence: input.compiledAtSeq`. `preflight.ready.prepared` is
`lib/export/boundaryValidation.ts::PreparedExportBoundary`, whose `doc` is the input document and whose
`compiledAtSeq` stamps a `.ccz` profile (`lib/commcare/compiler.ts`, `archiveVersion`).

**Confirmations.** `lib/deployment/confirmations.ts::requiredConfirmations` lists the plan features
(`lib/commcare/planPrivileges.ts::requiredPlanFeatures`), then `flat-location-fixture`,
`connect-forwarder` and `form-entry-sync-off`. `save_to_case` is the plan feature
`advanced-case-actions` ("Save to Case", Advanced and Enterprise), asked where
`lib/commcare/xform/caseOps.ts::formEmitsSaveToCase` holds for a form, with `whereMissing: null`.
`app_deployment_confirmations.kind` holds four kinds through `app_deployment_confirmations_kind_check`,
last widened by `20261101010000_hq_round_trip_platforms_form_entry_sync.ts`. Setting copy is
`lib/publish/planFeatures.ts::PROJECT_SPACE_SETTINGS`, keyed by `PROJECT_SPACE_SETTING_KINDS`.

**Project-space capabilities.** `lib/commcare/projectSpaceCompatibility.ts::projectSpaceCompatibilityProbePlan`
maps semantic capabilities to required-on flags (`HQ_PRIVATE_FEATURE_FLAG_SYMBOLS`, eleven, each resolved
through its gate entry by `lib/commcare/surface/gates.ts::domainFeatureFlag`, which refuses any toggle not
keyed by project space alone because HQ's filter counts a flag on for the requesting user as on for every
project space). `lib/commcare/client.ts::aggregatePrivateProbeState` reads each flag's presence in the
filtered project-space list, after the unfiltered list proves the target visible. There is no flag a
capability needs off. `VIEW_FORM_ATTACHMENT` is already checked: capability `attachment-links`, required
where `linkWriteIsShown(doc, field)` holds, a capture field whose `caseWrite.mode === "url"` shown by a
column of a module whose own case type is the write's (a plain column naming the property, or a
calculated column whose `prop` term names that type and property with `via` absent or `self`).

**The drift baseline.** `app_deployment_baselines` holds one row per deployment (`origin` `create |
push | cutover | unread`, `source_gzip`, `source_digest`, ownership).
`lib/deployment/hqSourceBaseline.ts::normalizeHqAppSource` keeps HQ's whole app source, with each form's
minted id and every reference to it replaced by its position token `m<i>.f<j>` and its XForm attachment
re-keyed by that token. Nothing in Nova reads case blocks out of it.

**Where a write lands today.** No document stores a placement: a field's `caseWrite` lowers to HQ's
basic `FormActions`, or to the derived Save to Case wrapper in a several-case form; every
`Form.caseOperations` entry is a Save to Case block under `nova_operations`; an extension child case is a
Save to Case block beside an inert basic subcase; a close on a condition the Case Management tab cannot
state is a Save to Case `nova_close` block; every module is `doc_type: "Module"`. Parts 01 and 02 change
all of that; this part records and guards what they decide.

**Downloads.** `lib/export/localArchive.ts::compileLocalArchive` (the `.ccz`, offered for a reached
deployment) and the HQ import file (`lib/commcare/multimedia/hqJsonExportArchive.ts::hqImportFileGuide`
over `lib/publish/manualImportGuide.ts`) write nothing to the document.

**MCP.** `upload_app_to_hq` and `withdraw_deployment_confirmation` declare
`scopeChallenge: oauthScopeChallenge(ctx, SCOPES.hqWrite)` and call `assertScope(ctx, SCOPES.hqWrite, …)`;
`check_project_space_compatibility` uses `hqRead`.

---

## 2. The `holdPlacements` mutation

Pull request 5 adds the mutation with three targets; pull request 7 adds the fourth with
`Module.heldKind`, because part 02 lands that slot there (its section 5), with the emission that can
write it, and a target joins the mutation with the slot it writes.

### 2.1 Targets and the slots they write

| Target | Slot it writes | Value | Shape owner | From |
|---|---|---|---|---|
| `case-operation` | `placement` on an entry of `Form.caseOperations` (every arm, the own arm included) | `CasePlacement` | part 01, `lib/domain/placements.ts::casePlacementSchema` | 5 |
| `own-close` | `Form.ownClosePlacement` | `{ kind: "save-to-case", repeat?, path }` | part 01, `lib/domain/placements.ts::ownClosePlacementSchema` | 5 |
| `query-repeat` | `placement` on a `query_bound` repeat | `"model-iteration" \| "count"` | part 04, `QUERY_REPEAT_PLACEMENTS` | 5 |
| `module-kind` | `Module.heldKind` | `"advanced"` | part 02 | 7 |

The placement slots land with the stored concept each holds: part 04's query repeat `placement` in pull
request 3, part 01's operation `placement` and `Form.ownClosePlacement` in pull request 4, part 02's
`heldKind` in pull request 7. In pull requests 3 and 4 a hold is written only by test fixtures and specs;
no mutation writes one until this mutation lands in pull request 5.

### 2.2 The stored shape

`lib/doc/types.ts` gains, inside `mutationSchema`'s union:

```ts
/** One held placement, set or cleared. `null` clears the target's held slot. */
export const placementHoldSchema = z.discriminatedUnion("target", [
	z.strictObject({
		target: z.literal("case-operation"),
		formUuid: uuidSchema,
		operationUuid: uuidSchema,
		placement: casePlacementSchema.nullable(),
	}),
	z.strictObject({
		target: z.literal("own-close"),
		formUuid: uuidSchema,
		placement: ownClosePlacementSchema.nullable(),
	}),
	z.strictObject({
		target: z.literal("query-repeat"),
		fieldUuid: uuidSchema,
		placement: queryRepeatPlacementSchema.nullable(),
	}),
	// From pull request 7:
	z.strictObject({
		target: z.literal("module-kind"),
		moduleUuid: uuidSchema,
		placement: z.literal("advanced").nullable(),
	}),
]);
export type PlacementHoldEntry = z.infer<typeof placementHoldSchema>;

export const holdPlacementsMutationSchema = z
	.strictObject({
		kind: z.literal("holdPlacements"),
		holds: z.array(placementHoldSchema).min(1),
	})
	.superRefine((mutation, ctx) => {
		const seen = new Set<string>();
		mutation.holds.forEach((hold, index) => {
			const key = placementTargetKey(hold);
			if (seen.has(key)) {
				ctx.addIssue({ code: "custom", path: ["holds", index], message: "duplicate-target" });
			}
			seen.add(key);
		});
	});
```

`lib/doc/placementHolds.ts` (new, pull request 5) holds the target vocabulary every other module reads:

```ts
export type PlacementTarget =
	| { readonly target: "case-operation"; readonly formUuid: Uuid; readonly operationUuid: Uuid }
	| { readonly target: "own-close"; readonly formUuid: Uuid }
	| { readonly target: "query-repeat"; readonly fieldUuid: Uuid }
	| { readonly target: "module-kind"; readonly moduleUuid: Uuid };
/** `case-operation:<form>:<operation>`, `own-close:<form>`, `query-repeat:<field>`, `module-kind:<module>`. */
export function placementTargetKey(target: PlacementTarget): string;
/** Every held slot of the document, keyed by target key, in document order. */
export function readPlacementHolds(doc: BlueprintDoc): ReadonlyMap<string, PlacementHoldEntry>;
/** Whether the target still exists in the document. */
export function placementTargetExists(doc: BlueprintDoc, target: PlacementTarget): boolean;
/** Whether `held` can still express the target as `doc` holds it (section 3). */
export function holdExpresses(doc: BlueprintDoc, entry: PlacementHoldEntry): boolean;
/** A batch without its `holdPlacements` mutations. */
export function withoutPlacementHolds(batch: AdmittedMutationBatch): AdmittedMutationBatch;
/** The finding codes that mean a held placement no longer expresses its target. */
export const PLACEMENT_CONFLICT_CODES: ReadonlySet<string>;
/** The hold each target's latest recording wrote, keyed by target key; a target no recording holds is absent. */
export type RecordedPlacementHolds = ReadonlyMap<string, PlacementHold>;
```

`PlacementHold` (a `PlacementHoldEntry` whose `placement` is not `null`) is declared here and re-exported
by `lib/commcare/placementHolds.ts` (section 5.1). `lib/doc/placementHolds.ts` reads part 01's
`lib/commcare/placement.ts`, so it joins `biome.json`'s allowlist for `lib/commcare` in pull request 5.
`lib/db/placementAuthority.ts` reads only `lib/doc/placementHolds` and `lib/domain`, so it needs no entry.

Document order is `doc.moduleOrder`, then each module's `kind` slot, then its forms in `formOrder`, then
each form's operations in array order, its own close, then its query repeats in field order.

`PLACEMENT_CONFLICT_CODES` holds `HELD_PLACEMENT_INEXPRESSIBLE` (part 01's code, which covers an
operation, an own close and a held module kind) and `QUERY_REPEAT_MODEL_ITERATION_SHAPE` (part 04's code).

### 2.3 The reducer and admission

- `lib/doc/mutations/placements.ts::applyHoldPlacements(draft, mutation)` (new), registered in
  `lib/doc/mutations/index.ts`: for each entry in order, find the target's slot and set it to
  `placement`, or delete the key where `placement` is `null`. It computes nothing.
- Target admission (`lib/doc/mutationTargetAdmission.ts`, the module `mutationTargetsInvalid` reads)
  refuses an entry whose form is missing, whose operation is not in that form's `caseOperations`, whose
  field is missing or is not a `query_bound` repeat, or whose module is missing. A refused target is the
  kernel's existing "This app changed while you were editing…" refusal, which is what a stale hold on a
  target a peer removed should meet.
- The reference index needs no bucket: no consumer asks who holds a placement.
- `lib/doc/incrementalValidationScope.ts` gives a batch that holds `holdPlacements` the whole-module
  scope of each target's module (a query repeat's and an own close's through their form), which part
  01's placement rules need anyway.
- `lib/collab/ReconcilerProvider.tsx::frameMayTouchCaseData` returns `false` for a `holdPlacements`
  mutation: a hold changes no case schema, so a publish's frame triggers no case-data refetch.

### 2.4 No other mutation writes a held slot

Every other mutation's payload schema refuses the four slots: `addForm` and `updateForm.patch`
(`ownClosePlacement`), `caseOperationChange` add and its patches (`placement` on every arm), `addField` and
`updateField.patch` (`placement`), `addModule` and `updateModule.patch` (`heldKind`). A duplicated form,
field or operation (`lib/doc/duplicateFieldMutations.ts` and the form and operation duplicate planners) is a
new target and starts unheld. So a hold enters a document only through `holdPlacements`, the cutover's
writer (which writes whole documents, decision 12) and import (step 6). Part 01, part 02 and part 04 write
their schemas this way; this part's test
(`lib/doc/__tests__/placementSlotsWrittenOnlyByHolds.test.ts`, section 20) holds all of them.

### 2.5 The diff writer

`lib/doc/diffDocsToMutations.ts::diffDocsToMutations(from, to)` emits, after every structural mutation, at
most one `holdPlacements` naming each target present in `to` whose held value differs from `from`'s
(`null` where `to` holds none), in document order. A target removed with its owner emits nothing, and a
target created in the same diff is added without its slot (section 2.4) and then held. So
`appendSyntheticBatch`, which replays the diff and refuses a target its replay does not reproduce
("The requested repair cannot be represented as a deterministic mutation batch."), carries holds exactly.

### 2.6 History

A history step records the `holdPlacements` its batch carried, forward and inverse, and part 07's
`lib/doc/store.ts::BlueprintDocState.applyHistoryStep` derives each inverse so it carries only the hold
changes section 3's rule admits under an editor's kind:

- **Arm (a), a move the step needs.** Where the step leaves a held placement unable to express its target,
  part 07 runs the kept batch through `lib/doc/identityMoves.ts::withIdentityMoves`, which appends the move
  and states it in the one `IdentityMoveDialog` (decision 3) before the step commits.
- **Arm (b), the restore of the recorded hold.** An inverse entry that sets a target's hold to exactly the
  hold its latest recording wrote is kept. So undoing an edit that moved a placement puts the change and its
  hold back where the published app has them, and undoing the removal of a held operation, own close or
  query repeat re-creates the target unheld (section 2.4) and, in the same batch, restores its recorded hold.
- **Every other hold change is dropped** from the step: a restore of a hold no recording wrote (an editor's
  earlier move, with no publish since), or one a publish has since replaced. The content change is kept,
  and part 07's toast says the hold stayed.

Part 07 reads the recorded holds from the tab's record (section 6.3), the same values the kernel reads from
the database, so a step it derives is a step the kernel admits. Where a publish lands between the step and
its commit, the kernel's refusal is section 6.2's placement conflict, offered again like any other edit.

Rejected: a history step that never carries a hold, so undo keeps the new place. Undoing an identity move
would leave the answers where the undone edit put them, a path change the person took back, and undoing the
removal of a held operation would re-create it unheld, so the next publish would move a path that nothing
about the operation changed.

Rejected: an inverse that restores whatever hold the target had before the step. Where that hold was itself
an editor's move with no publish since, the restore replaces a hold that can still express its target with
one CommCare HQ never received.

---

## 3. Who may change a held placement

Pull request 5 adds the rule for the editor kinds, with `blueprint-migration` rows and fold baseline
snapshots as the recordings it reads; pull request 6 admits `publish-placement` beside
`blueprint-migration` and reads its rows as recordings too.

```ts
// lib/db/placementAuthority.ts (new, pure)
export const PLACEMENT_CHANGE_REFUSAL =
	"Nova keeps each case change where CommCare HQ last received it, and only a publish records a new place. This change would move one that can stay where it is, so nothing was saved. Reload the app and make the change again.";

/**
 * The target keys whose change only a recording can admit: every key rules 1 to 4 below leave
 * undecided. The kernel reads the recorded holds for these keys alone.
 */
export function placementChangesToJustify(
	prev: BlueprintDoc,
	next: BlueprintDoc,
	kind: BlueprintMutationAppChangeKind,
): readonly string[];

/**
 * Who may change a held placement, decided over the documents and the recordings rather than the
 * mutations: a forged autosave, a stale undo inverse and an identity move all meet it alike.
 */
export function placementChangeRefusal(
	prev: BlueprintDoc,
	next: BlueprintDoc,
	kind: BlueprintMutationAppChangeKind,
	recorded: RecordedPlacementHolds,
): string | null;
```

The rule, for every target key in the union of `readPlacementHolds(prev)` and `readPlacementHolds(next)`:

1. `kind` is `publish-placement` or `blueprint-migration`: admitted.
2. The target exists in `prev` and not in `next` (its owner was removed): not a change; skip.
3. The held values are equal (`lib/doc/deepEqual.ts::deepEqual`): skip.
4. **Arm (a), a move.** `prev` holds `h` and `next` holds another value or none: let `probe` be `next` with
   this target's slot set back to `h`. Where `holdExpresses(probe, { …target, placement: h })` does not
   hold, admitted: the batch made `h` inexpressible, and it moved it.
5. **Arm (b), a restore.** `next` holds exactly the hold `recorded` gives the key (`deepEqual`): admitted.
   This is the undo of an identity move (from the moved hold back to the recorded one) and the re-creation
   of a removed held target with its hold (from none to the recorded one).
6. Otherwise refused: a hold an editor gains that no recording wrote, the replacement or clearing of a hold
   that can still express its target, and the restore of a hold the latest recording did not write.

A refusal is `PLACEMENT_CHANGE_REFUSAL`, once, whatever the number of targets.

**What a recording is.** `lib/db/placementRecords.ts::readRecordedPlacementHolds` (new, pull request 5):

```ts
/**
 * The hold the latest recording wrote for each target: the newest `publish-placement` or
 * `blueprint-migration` row above the app's greatest fold baseline whose `holdPlacements` names the
 * target, else the hold that baseline's snapshot holds, for each of `keys`. A key whose latest
 * recording cleared it, or that no recording names, is absent. An empty `keys` reads nothing.
 */
export async function readRecordedPlacementHolds(
	db: Kysely<Database> | Transaction<Database>,
	appId: string,
	keys: readonly string[],
): Promise<RecordedPlacementHolds>;
```

It reads `public.app_change_fold_baselines` for the app's greatest `seq`, then the app's
`public.app_changes` rows of kind `publish-placement` or `blueprint-migration` above that `seq` whose
`mutations @> '[{"kind":"holdPlacements"}]'`, newest first, through the `(app_id, seq)` key; the baseline's
`snapshot` is parsed (`lib/db/canonicalMutationFold.ts`'s baseline parse) only where some asked key has no
such row. Every table is named with its schema. A fold baseline is a recording because the cutover writes
its holds into each app's baseline snapshot, not as mutations (decision 12).

`holdExpresses` (section 2.2) dispatches by target to the predicate each owner's gate rule reads, so the
kernel and the gate cannot disagree about what "can express" means:

| Target | Expresses where | Owner |
|---|---|---|
| `case-operation`, `own-close` | `lib/commcare/placement.ts::placementExpresses(doc, formUuid, subject, held)` | part 01 |
| `query-repeat` | `lib/domain/queryRepeatPlacement.ts::queryRepeatPlacementExpresses(formStructure(doc, formUuid), fieldUuid, held)` | part 04 |
| `module-kind` | `lib/domain/advancedModule.ts::heldKindExpresses(doc, moduleUuid)` | part 02 |

**Where the kernel calls it.** `commitCanonicalBatch`, after `prepareMutationCandidate` and before
`evaluatePreparedMutationCandidate`, inside the commit transaction:

```ts
if (kind === "publish-placement" && mutations.some((m) => m.kind !== "holdPlacements")) {
	throw new Error("[commitCanonicalBatch] a publish-placement batch holds only holdPlacements");
}
const toJustify = placementChangesToJustify(freshDoc, prepared.nextDoc, kind);
const recorded =
	toJustify.length === 0 ? NO_RECORDED_HOLDS : await readRecordedPlacementHolds(trx, appId, toJustify);
const placementRefusal = placementChangeRefusal(freshDoc, prepared.nextDoc, kind, recorded);
if (placementRefusal !== null) throw new BlueprintCommitRejectedError(placementRefusal);
```

The first check is an invariant (only `recordPublishPlacements` writes the kind), so it throws a plain
`Error`, not a person's refusal. The recordings are read under the app lock the kernel already holds, so no
publish can land between the read and the write. An edit that changes no hold, and every move, reads
nothing. `appendSyntheticBatch` does not call the rule: its kind is always `blueprint-migration`, which the
rule admits whole.

Rejected: a per-mutation allowlist ("only `publish-placement` may carry `holdPlacements`"). Identity moves
and restores are `holdPlacements` too, written under an editor's kind, and the line between them and a
forged hold is whether the old hold can still express its target or the new one is what was recorded,
which only the documents and the recordings say.

---

## 4. The `publish-placement` app change kind

Pull request 6.

### 4.1 Types

`lib/db/types.ts`:

```ts
/**
 * The final durable app-change vocabulary. Browser tabs fold the first four kinds as frames; the rest
 * are server-only state transitions that force clients to reauthorize and reload.
 */
export const APP_CHANGE_KINDS = [
	"autosave",
	"mcp",
	"chat",
	"publish-placement",
	"blueprint-migration",
	"fold-baseline",
	"project-move",
] as const;
export type AppChangeKind = (typeof APP_CHANGE_KINDS)[number];

/** The kinds an editor's own batch commits under. */
export const EDITOR_APP_CHANGE_KINDS = ["autosave", "mcp", "chat"] as const;
export type EditorAppChangeKind = (typeof EDITOR_APP_CHANGE_KINDS)[number];

/** The kinds a browser tab folds as frames, without a reload. */
export const COLLABORATION_FRAME_KINDS = [...EDITOR_APP_CHANGE_KINDS, "publish-placement"] as const;
export type CollaborationFrameKind = (typeof COLLABORATION_FRAME_KINDS)[number];
export function isCollaborationFrameKind(kind: string): kind is CollaborationFrameKind;

export type BlueprintMutationAppChangeKind = CollaborationFrameKind | "blueprint-migration";
```

`CLIENT_APP_CHANGE_KINDS` and `ClientAppChangeKind` are removed; their importers
(`lib/agent/change-set/commit.ts`, `lib/db/applyBlueprintChange.ts`, `lib/db/canonicalCommitKernel.ts`)
take `EditorAppChangeKind`. The `AppChangeDoc` union's first arm already takes
`BlueprintMutationAppChangeKind`, which now includes the new kind.

`lib/db/persistedJson.ts` parses the kind through its mutation-bearing arm (`APP_CHANGE_KIND_SET` follows
the constant) and adds one refusal: a `publish-placement` row with a `run_id`, or whose batch holds a
mutation other than `holdPlacements`, fails with "app_changes row of kind publish-placement holds something
other than placement holds". The database refuses the same rows (section 4.2), so this guards a reader
against a row written before a broken migration, not a writer.

### 4.2 The database admission

`lib/case-store/migrations/20261110000000_hq_round_trip_case_writes_publish_placement.ts`, registered in
`lib/case-store/migrations/index.ts` as
`"20261110000000_hq_round_trip_case_writes_publish_placement": hqRoundTripCaseWritesPublishPlacement`:

```ts
// A publish records where CommCare HQ keeps each case write as its own app change kind,
// `publish-placement`: a nonempty batch of placement holds, no run, written at the head the publish
// emitted. The function body is the canonical identity foundation's whole, with the kind added to the
// closed set and one arm for the new kind. Additive in effect: every row the revision before writes
// still passes.

import { type Kysely, sql } from "kysely";

/** Admit `publish-placement` app changes that hold only placement holds. */
export async function up(db: Kysely<unknown>): Promise<void> {
	await sql`
		CREATE OR REPLACE FUNCTION public.nova_admit_app_change_insert()
		RETURNS trigger
		LANGUAGE plpgsql
		VOLATILE
		NOT LEAKPROOF
		SET search_path = pg_catalog
		AS $function$
		DECLARE
			current_project_id text;
			current_head bigint;
		BEGIN
			IF NEW.kind NOT IN (
				'autosave',
				'mcp',
				'chat',
				'publish-placement',
				'blueprint-migration',
				'fold-baseline',
				'project-move'
			) THEN
				RAISE EXCEPTION 'app_changes insert has an unsupported kind';
			END IF;
			IF btrim(NEW.batch_id) = ''
				OR btrim(NEW.actor_id) = ''
				OR (NEW.run_id IS NOT NULL AND btrim(NEW.run_id) = '')
			THEN
				RAISE EXCEPTION 'app_changes insert has a blank envelope identity';
			END IF;
			IF NEW.kind = 'fold-baseline' THEN
				IF NEW.mutations <> '[]'::jsonb THEN
					RAISE EXCEPTION 'fold-baseline app changes must be empty';
				END IF;
				RETURN NEW;
			END IF;
			IF NEW.kind = 'project-move' THEN
				SELECT app.project_id, app.mutation_seq
				INTO current_project_id, current_head
				FROM public.apps AS app
				WHERE app.id = NEW.app_id
				FOR UPDATE;
				IF NOT FOUND
					OR current_project_id IS DISTINCT FROM NEW.from_project_id
					OR NEW.seq IS DISTINCT FROM current_head + 1
				THEN
					RAISE EXCEPTION
						'project-move app change does not start at the locked app Project/head';
				END IF;
				RETURN NEW;
			END IF;
			IF NEW.mutations = '[]'::jsonb THEN
				RAISE EXCEPTION
					'non-move non-baseline app changes must contain mutations';
			END IF;
			IF NEW.kind = 'publish-placement' THEN
				IF NEW.run_id IS NOT NULL OR jsonb_typeof(NEW.mutations) <> 'array' THEN
					RAISE EXCEPTION
						'publish-placement app changes hold only placement holds and no run';
				END IF;
				IF EXISTS (
					SELECT 1
					FROM jsonb_array_elements(NEW.mutations) AS mutation
					WHERE jsonb_typeof(mutation) <> 'object'
						OR mutation->>'kind' IS DISTINCT FROM 'holdPlacements'
				) THEN
					RAISE EXCEPTION
						'publish-placement app changes hold only placement holds and no run';
				END IF;
			END IF;
			RETURN NEW;
		END
		$function$
	`.execute(db);
}

/** Forward only: undoing it would refuse publish placements already in apps' histories. */
export async function down(): Promise<void> {
	throw new Error(
		"This migration is forward-only: undoing it would refuse publish placements already in apps' histories.",
	);
}
```

- The body is the frozen one (`frozenDatabaseMigration.ts`, the `CREATE FUNCTION nova_admit_app_change_insert()`
  block) copied whole, with `'publish-placement'` in the closed set and the last arm added after the
  empty-batch arm, so the empty-batch refusal keeps its message for every kind. The two arms are nested
  `IF`s because SQL does not order an `OR`'s operands, and `jsonb_array_elements` raises on a non-array.
- The function is named `public.nova_admit_app_change_insert()`, schema-qualified, so no search path entry
  can shadow it, and `CREATE OR REPLACE` keeps its oid, owner, ACL and trigger
  (`app_changes_admit_insert`), so `lib/db/privilegeConvergence.ts` needs no change.
- Additive in effect: every row the previous revision writes still passes. Replay-safe by construction.
- Decision 11 applies it in the cutover window's ledger phase, inside the fleet transaction, with the
  step's other two ledgered migrations (part 09); after that commit the deploy's migrate Job applies none.

---

## 5. Recording placements at publish

Pull request 6, with the module kind from pull request 7.

### 5.1 Which placements a publish records

`lib/commcare/placementHolds.ts` (new, client-safe, read by the publish, the proof capture and the tests):

```ts
/** A hold that sets a value: what a publish records (declared in `lib/doc/placementHolds.ts`). */
export type { PlacementHold } from "@/lib/doc/placementHolds";

/**
 * Every placement the emission of `doc` derives and `doc` does not hold yet, in document order: the
 * holds a publish records so that every later emission keeps the paths this one sends.
 */
export function placementsToHold(doc: BlueprintDoc): readonly PlacementHold[];
```

In document order (section 2.2):

- a `module-kind` hold for a module whose `lib/commcare/moduleKind.ts::emittedModuleKind(doc, moduleUuid)`
  is `"advanced"` and whose `heldKind` is absent (part 02, from pull request 7);
- a `case-operation` hold for each operation whose `PlannedPlacement.held` is `false` in
  `lib/commcare/placement.ts::appPlacements(doc)` (part 01's recorder derivation, over `planPlacements` for
  each form), at its `placement`;
- an `own-close` hold where that form's placements hold the `"own-close"` subject unheld (the form's own
  close has its own block and `ownClosePlacement` is absent);
- a `query-repeat` hold for each `query_bound` repeat with no `placement`, at
  `lib/domain/queryRepeatPlacement.ts::effectiveQueryRepeatPlacement(formStructure(doc, formUuid), fieldUuid)`.

This needs one property of part 01's `planPlacements`: for a derived Save to Case placement it returns the
exact `path` the emitter writes, allocator names included, so the hold pins the bytes this publish sends.

No hold a publish records is a carried create's Save to Case block. From pull request 7 a create that part
02's `lib/commcare/formLinkProjection.ts::linkCarriedCreates` holds cannot express a Save to Case placement
(part 02 section 14.5, part 01's expressibility predicate), and a document whose carried create has no
other placement is refused by `FORM_LINK_NEEDS_NEW_CASE_DATUM`, so no committed document hands one to
`placementsToHold`. Before pull request 7 an extension create still takes part 02 section 14.4's interim
`nova_subcases` block, and one deploy carries the stack, so no publish runs on that interim.

**The invariant.** Emitting `doc` and emitting `doc` with `placementsToHold(doc)` applied give the same HQ
import body and the same `.ccz` bytes but for the version the sequence stamps.
`lib/commcare/__tests__/heldPlacementEmission.test.ts` holds it over the xform fuzz arbitrary (section 20).
Everything below rests on it.

### 5.2 The writer

`lib/deployment/placements.ts` (new, server-only):

```ts
export type RecordPlacementsOutcome =
	| { readonly kind: "recorded"; readonly seq: number; readonly doc: BlueprintDoc; readonly count: number }
	| { readonly kind: "head-moved" }
	| { readonly kind: "refused"; readonly message: string };

/**
 * Record `holds` as one `publish-placement` change, only while the app's head is `expectedHeadSeq`.
 * The only writer of the kind.
 */
export async function recordPublishPlacements(input: {
	readonly scope: DeploymentScope;
	readonly expectedHeadSeq: number;
	readonly holds: readonly PlacementHold[];
}): Promise<RecordPlacementsOutcome>;
```

It throws on an empty `holds` (no caller passes one; a no-op change is never written) and calls

```ts
commitGuardedBatch({
	appId: scope.appId,
	batchId: crypto.randomUUID(),
	mutations: admitMutationBatch([{ kind: "holdPlacements", holds }]),
	actorUserId: scope.actorUserId,
	kind: "publish-placement",
	expectedProjectId: scope.projectId,
	expectedHeadSeq,
});
```

It maps `AppHeadMovedError` to `{ kind: "head-moved" }`, and `BlueprintCommitRejectedError` to
`{ kind: "refused", message }`. A refusal whose error carries finding codes (section 6.2) is a gate
refusal of the emitter's own derivation over a valid document, an invariant breach: it is also logged with
`log.error("[publish] the placements a publish derived failed the gate", …)` so Sentry groups it. The
other refusal a person can meet here is the kernel's build-lease refusal ("This app's reviewed initial
build has not finished. …"). Every other error propagates; nothing has been sent.

### 5.3 The kernel's head fence

`lib/db/canonicalCommitKernel.ts`:

```ts
interface CanonicalCommitBase { /* every field the request has today but kind */ }
export type CanonicalCommitRequest =
	| (CanonicalCommitBase & { readonly kind: EditorAppChangeKind; readonly expectedHeadSeq?: never })
	| (CanonicalCommitBase & { readonly kind: "publish-placement"; readonly expectedHeadSeq: number });
```

After the app lock and the latch read, a `publish-placement` request whose `fresh.mutation_seq` is not
`expectedHeadSeq` throws `AppHeadMovedError` (new, `lib/db/commitGuard.ts`):

```ts
/** A publish's placements were emitted from a head that is no longer the app's. Nothing was written. */
export class AppHeadMovedError extends Error {
	constructor(readonly expectedSeq: number, readonly headSeq: number) {
		super(`The app's head moved from ${expectedSeq} to ${headSeq} before the publish recorded its placements.`);
		this.name = "AppHeadMovedError";
	}
}
```

Every other kernel step runs as for `mcp`: the Project expectation, the `edit` reauthorization, the build
lease, the empty-batch refusal, target admission, the placement rule (which admits the kind), the absolute
gate, media and lookup edges, the write and the NOTIFY. `chatRunHolder` is refused on the kind by the
existing non-chat arm. `lib/db/apps.ts::commitGuardedBatch` passes the union through.

### 5.4 Where the publish records it

`PublishInput` (`lib/deployment/service.ts`) gains:

```ts
/** Reads the app's current head again, under the caller's own access check. */
readonly reloadHead: () => Promise<{ readonly doc: BlueprintDoc; readonly seq: number }>;
/**
 * A placement offer a person accepted after a refusal offered it (section 7), named by its reason and
 * digest. Never defaulted from an earlier attempt.
 */
readonly acceptPlacementMoves?: AcceptPlacementMoves;
```

and `PublishOutcomeShared` gains `readonly placements: { readonly recorded: number; readonly moved: number }`,
the holds this attempt recorded and how many of them an accepted offer moved; both are 0 where it recorded
nothing.

`publishAppToHq`'s head, before today's first line after `readDeployment`:

```
let doc = input.doc, seq = input.compiledAtSeq, recorded = 0, moved = 0

1. if input.acceptPlacementMoves:
     offer = placementMoveOffer(doc, accept.reason)
     offer === null                → nothing left to move (an earlier attempt moved them); go on
     offer.digest !== accept.digest → refuse hq_placement_moves_changed, refusal.placementMoves = view(offer)
     else r = recordPublishPlacements({ holds: offer.holds, expectedHeadSeq: seq })
          head-moved → (doc, seq) = await input.reloadHead(); recompute the offer once from step 1;
                       a second head-moved refuses app_changed_while_publishing
          refused    → refuse app_not_ready with r.message
          recorded   → (doc, seq) = (r.doc, r.seq); recorded += r.count; moved = r.count

2. for attempt in 1..3:
     preflight = runDeploymentPreflight({ doc, compiledAtSeq: seq, … })
     preflight refused → return today's refusal (placements = { recorded, moved })
     holds = placementsToHold(doc)
     holds empty → break
     r = recordPublishPlacements({ holds, expectedHeadSeq: seq })
     recorded → (doc, seq) = (r.doc, r.seq); recorded += r.count
                prepared = { ...preflight.ready.prepared, doc, compiledAtSeq: seq }; break
     head-moved → (doc, seq) = await input.reloadHead(); continue
     refused  → refuse app_not_ready with r.message
   three head-moved answers → refuse app_changed_while_publishing

3. today's sequence from logoStep on, reading `prepared` for the boundary, `doc` wherever today reads
   `input.doc`, and `seq` wherever today reads `input.compiledAtSeq` (recordRemoteResource's
   pushedRevision, the entry-point manifest's sourceSequence).
```

Each refusal before the record goes through today's preflight refusal block, which this pull request
lifts into one helper, `preflightRefusal(input, target, existing, failure, extras)`, so the new refusals
fold and report exactly as a blocked preflight does.

Reasons:

- **After preflight, before any write to CommCare HQ.** Every stop a person can decide differently is
  settled first, so a refused publish records nothing it did not need, and the shell create comes after,
  so no HQ app ever holds content whose placements Nova did not record. A later stop (the version floor,
  a push failure, `hq_changed` at the second read, an import HQ refuses, the HQ app gone,
  `hq_plan_lacks_web_apps`) keeps the holds: the next publish carries them, which is the research's rule.
- **Only while the head is the revision emitted.** The kernel's literal head compare under the app lock is
  the fence; a moved head means the preflight read a document that is no longer the app, so the publish
  emits again.
- **Three attempts.** An unbounded loop could run preflight's HQ reads forever against a busy app. Two
  saves landing inside two successive preflights is already unusual, and the refusal is a person's retry
  with nothing sent.
- **The recorded document goes out.** The holds are the emitter's own derivation, so the prepared boundary
  (lookups, media, compatibility, confirmations) stays true; replacing its `doc` and `compiledAtSeq` makes
  the HQ body come from the document that holds the placements and the pushed revision name it, so a deep
  link checked after this publish (`getEntryPointLink`'s sequence compare) passes without a second publish.
- **Two concurrent publishes** to two project spaces both preflight at `s`; the first records `s → s+1`,
  the second meets `head-moved`, reloads, preflights at `s+1`, finds nothing to hold and sends. Both send
  the same placements.

`DEPLOYMENT_FAILURE_CODES` (`lib/deployment/types.ts`) gains `app_changed_while_publishing` and
`hq_placement_moves_changed`, both at phase `preflight`, each with a doc comment in today's style. Copy is in
section 16.

### 5.5 The callers' `reloadHead`

- `app/api/commcare/upload/route.ts`: `reloadHead: async () => { const fresh = await
  resolveAppAccess(body.appId, session.user.id, "edit"); return { doc:
  hydratePersistedBlueprint(fresh.app.blueprint as PersistableDoc), seq: fresh.app.mutation_seq }; }`. A
  lost edit capability throws `AppAccessError`, which the route answers as it does today.
- `lib/mcp/tools/uploadAppToHq.ts`: `reloadHead: async () => { const { doc, app } = await
  loadAppBlueprint(appId, ctx.userId, "edit"); return { doc, seq: app.mutation_seq }; }`.
- Tests construct it through `lib/deployment/__tests__/publishFixtures.ts::reloadHeadFor(appId, userId)`,
  which reads the app row the same way.

### 5.6 Edge cases

- Everything held: no change is written, and the outcome's `placements.recorded` is 0.
- A refused publish before preflight passes records nothing; one refused after the record keeps the holds.
- An initial build in flight: the kernel's build-lease refusal becomes `app_not_ready` with its sentence,
  nothing recorded and nothing sent.
- A Project move between the route's read and the record: the kernel's Project expectation refuses as it
  does for any stale writer, and the publish answers as today for a moved app.
- A deleted operation's hold goes with the operation. Undoing the deletion restores it with the hold its
  latest recording wrote (section 3, arm (b)); an operation made anew is a new target, and the next publish
  records it.
- A Project move carries holds with the document: nothing is per Project.
- A private authoring workspace (`begin_work`) opened before the record is staled by its sidecar's
  `baseSeq`, as by any committed change; `upload_app_to_hq`'s description says so.

---

## 6. Open tabs: the frame fold and the placement conflict

Pull request 6, but for the tab's recorded holds (section 6.3), which land in pull request 5 with the rule
that reads them.

### 6.1 The fold keeps undo

- `lib/collab/mutationFrame.ts`: `kind: z.enum(COLLABORATION_FRAME_KINDS)`; `MutationFrame.kind:
  CollaborationFrameKind`.
- `app/api/apps/[id]/stream/route.ts`: the suffix loop's frame arm tests `isCollaborationFrameKind(change.kind)`
  in place of the three literals; every other kind stays disruptive.
- `lib/collab/reconciler.ts`: no change in classification. A `publish-placement` frame's `batchId` is
  server-minted and never awaits echo, and `isEcho`'s chat arm does not match it, so it is remote:
  `applyRemote` advances `confirmedDoc`, re-folds the human batches and rebases undo. The publishing tab
  folds its own change the same way. No tab reloads, and every undo step stays. A `publish-placement`
  frame's entries are recordings, so `applyRemote` also sets each into the tab's recorded holds (section
  6.3) before the re-fold.
- A tab running the previous build meets the frame through its own schema, which refuses the kind: the
  provider disowns the source and reloads (today's behavior), and the deploy's `NEXT_DEPLOYMENT_ID`
  hard-reloads it anyway. No compatibility arm.

### 6.2 An edit composed before the record

A batch composed over a document that held nothing carries no move, so once a `publish-placement` change
lands under it, the gate on the fresh head refuses it with a held-placement finding. The refusal is a
conflict, as an edit a peer's change invalidates is, and the person is offered the edit again with its
moves.

**The server says why.**

- `BlueprintCommitRejectedError` gains `readonly findingCodes: readonly string[]` and `readonly
  placementRule: boolean` (constructor `(message, options?: { findingCodes?: readonly string[];
  placementRule?: true })`, defaults `[]` and `false`). The kernel's gate refusal and
  `appendSyntheticBatch`'s set `findingCodes` from `verdict.findings.map((finding) => finding.code)`; the
  kernel's placement rule refusal (section 3) sets `placementRule`, since a restore the latest recording no
  longer matches is the same race as a move a publish made necessary.
- The PUT route (`app/api/apps/[id]/route.ts`) answers `{ error, type: "commit_rejected", reason:
  "placement-recorded" }` when `placementRule` holds, or `findingCodes` is nonempty and every code is in
  `PLACEMENT_CONFLICT_CODES`, and today's body otherwise. The reason is a typed tag, so no client reads
  the prose.

**The tab keeps the edit and offers it again.**

- `PutOutcome`'s `commitRejected` arm gains `readonly reason: "placement-recorded" | null`;
  `ReconcilerProvider`'s 409 branch reads `body.reason === "placement-recorded"`.
- The reconciler's `commitRejected` branch, where `reason` is `"placement-recorded"`, first collects the
  replay: the mutations of each human batch of `sentPending` from the rejected one on (exactly the batches
  it settles as `conflict`), then the store's queued human commands, read through a new store accessor
  `lib/doc/store.ts::queuedCommandMutations()` before `discardUncommittedCommandState()` clears them. Then
  it runs today's branch unchanged (settle, discard, `observe({ kind: "conflict", cause:
  "placement-recorded" })`, `onConflictReload`, `requestReload`). When that reload completes with the
  person still an editor, it calls the new dependency `onPlacementConflict(replay)` once; a reload that
  ends view-only or revoked drops the replay.
- `SaveSignal`'s `conflict` arm gains `readonly cause?: "placement-recorded"`. `useAutoSave` shows no toast
  for that cause (the builder owns what the person sees); every other conflict shows today's toast.
- The builder registers `onPlacementConflict` through `ReconcilerProvider`; part 07's
  `components/builder/placementConflictReplay.ts::replayAfterPlacementConflict(replay)` (new, its pull
  request 6) supplies it. It calls part 07's pure
  `lib/doc/identityMoves.ts::planConflictReplay(doc, replay, recordedHolds)` (pull request 6, tested in
  `lib/doc/__tests__/identityMoves.test.ts`), which joins the replay into one batch, drops every hold change
  this part's `lib/doc/placementHolds.ts::admittedHoldChanges` does not admit over the reloaded document and
  its recorded holds (section 6.3, the derivation part 07's `applyHistoryStep` uses), and plans the rest
  with `withIdentityMoves(doc, batch)` over the reloaded document; `replayAfterPlacementConflict` then runs
  `useBlueprintMutations`' gate on the planned batch. Where the planned batch is admitted and states
  at least one move, it sets part 07's `pendingIdentityMove` with origin `conflict`, and the
  `IdentityMoveDialog` opens with the lead `placement-recorded` (copy in section 16): **Make the change**
  dispatches the planned batch as one human command, one undo step; **Leave it** drops it, leaving the app
  as the publish left it (both buttons are part 07's copy). Where the batch is not admitted, or states no
  move, nothing is dispatched and the placement toast (section 16) says the app reloaded and the change can
  be made again.
- Chat and MCP writers meet the same gate finding through their ordinary refusal path, with
  `describeCommitFindings`' text; their next attempt plans over the folded document and states the move
  (part 07).

Rejected: rendering the server's message in today's toast. `describeCommitFindings` writes a request's
refusal ("Fix this problem, then try again"), not a reload's, and a toast cannot offer the change again.
Rejected: rebasing the rejected batch silently. The edit now moves where CommCare HQ keeps some answers,
which the person has to see before it commits (decision 3).

### 6.3 The tab's recorded holds

Pull request 5. Arm (b) of section 3 admits a restore only to what the latest recording wrote, and a
document does not say which of its holds a recording wrote and which an editor's move wrote. So the tab
reads the recordings with its document:

- The kernel's reader of the hold each target's latest recording wrote is
  `lib/db/placementRecords.ts::readRecordedPlacementHolds` (section 3), exported for this read as for the
  kernel's. `lib/db/appAccess.ts::resolveAuthorizedAppSnapshot` calls it, in its locked transaction, over
  the target keys the document it returns holds (`readPlacementHolds`), and returns the result as
  `recordedHolds`, the name the builder's app load carries it by (part 07 §2.5). Those keys suffice: a history step
  restores only what the session itself changed, so every target a step can restore was held when the tab
  read its document, or was recorded later by a `publish-placement` frame the tab folds. An app that holds
  nothing reads nothing more; otherwise the cost is one indexed query of its recording rows above its
  greatest fold baseline, and that baseline's snapshot only where a held target has no such row.
- `lib/collab/appReadSnapshot.ts::appReadSnapshotSchema` gains `recordedHolds:
  z.array(placementHoldSchema)` (the entries with a placement, in document order), so the `GET
  /api/apps/{id}` reload and the builder page's first render (`app/(app)/build/[id]/[[...path]]/page.tsx`,
  through `initialAccess`) carry one shape.
- `lib/collab/reconciler.ts` keeps the record beside `confirmedDoc`, replaced whole on every reload and
  updated entry by entry by a `publish-placement` frame (section 6.1, pull request 6). A
  `blueprint-migration` row is a reload boundary today, so its recordings arrive with the reload.
- The reconciler hands the record to the store through `lib/doc/store.ts::setRecordedPlacementHolds`
  (new), which sets part 07's `BlueprintDocState.recordedHolds`, a `RecordedPlacementHolds` keyed by
  `placementTargetKey` (each key names its target's uuids). Part 07's `applyHistoryStep` and
  `planConflictReplay` read it through this part's
  `lib/doc/placementHolds.ts::admittedHoldChanges(doc, batch, recordedHolds)` (new in pull request 5, the
  client half of section 3's arms over the same `holdExpresses`), so a history step or a replay carries
  only what the kernel admits.

The record is the same value the kernel reads from the database at commit, under the app lock. A tab whose
record is behind (a publish it has not folded yet) at worst keeps a restore the kernel then refuses with
`placementRule`, which section 6.2 answers as a placement conflict.

Rejected: a route the tab asks for the recordings at its first undo. It is a second read on the path a
person waits on, and a new `/api/*` route that `lib/hostnames.ts` must allow, for a value the document
read can carry in the same transaction.

---

## 7. Placement moves a publish offers

The `save-to-case` offer lands in pull request 6; the `same-type-child-links` offer in pull request 8.

### 7.1 One shape

`lib/publish/placementMoves.ts` (new, client-safe):

```ts
export const PLACEMENT_OFFER_REASONS = ["save-to-case", "same-type-child-links"] as const;
export type PlacementOfferReason = (typeof PLACEMENT_OFFER_REASONS)[number];

/** One move as a person reads it. */
export interface PlacementMoveView {
	/** The form's name, trimmed, or its id. */
	readonly form: string;
	/** The case change, in words: "makes a new household case". */
	readonly change: string;
	/** The whole sentence the dialog and MCP show. */
	readonly sentence: string;
}

export interface PlacementMoveOfferView {
	readonly reason: PlacementOfferReason;
	/** 64 lower case hex. */
	readonly digest: string;
	readonly moves: readonly PlacementMoveView[];
	/** True where a move puts a new case in a basic subcase, which asks for Child Cases. */
	readonly asksChildCases: boolean;
}

export const acceptPlacementMovesSchema = z.strictObject({
	reason: z.enum(PLACEMENT_OFFER_REASONS),
	digest: z.string().regex(/^[0-9a-f]{64}$/),
});
export type AcceptPlacementMoves = z.infer<typeof acceptPlacementMovesSchema>;
```

`PlacementOfferReason` is named apart from part 01's `PlacementMoveReason`, which names why an edit moves
a placement.

`lib/deployment/placementMoves.ts` (new, server-only):

```ts
export interface PlacementMoveOffer extends PlacementMoveOfferView {
	/** What accepting records, in document order: the moved targets, then the moves they force. */
	readonly holds: readonly PlacementHold[];
}
export function placementMoveOffer(doc: BlueprintDoc, reason: PlacementOfferReason): PlacementMoveOffer | null;
export function placementMoveOfferView(offer: PlacementMoveOffer): PlacementMoveOfferView;
```

- `holds` is the reason's own holds followed by every hold `withIdentityMoves(doc, [holdPlacements(those)])`
  appends (a basic subcase renumbered after one moves out, for instance), each listed as a move.
- `digest` is `lib/utils/canonicalJson.ts::canonicalJsonDigest({ reason, holds: holds.map((hold) =>
  [placementTargetKey(hold), heldValueBefore, hold.placement]) })`, so an unrelated edit leaves it and any
  change to what moves changes it.
- `change` comes from `describeCaseChange(doc, target)` in the same module: a create reads "makes a new
  {type} case", an update "updates the {type} case", a close "closes the {type} case", the own arm "saves
  to this form's {type} case", a worker-record write "saves to the worker's record", the own close "closes
  this form's case".
- Both offers are pure functions of the document, so accepting one needs no HQ read, and the service applies
  it before preflight (section 5.4).

### 7.2 `save-to-case`

**What it moves.** Let `S` be every `case-operation` and `own-close` target whose effective placement is a
Save to Case block, in document order.

1. `S` empty: `null`.
2. Some target in `S` is not held: `null`. An unheld target already takes the simplest placement that
   expresses it, so it has nothing simpler.
3. `D'` is `doc` with every hold in `S` cleared. Where `planPlacements` over `D'` gives every target in
   `S` a placement other than Save to Case, keeps every module's emitted kind
   (`emittedModuleKind(D', m) === emittedModuleKind(doc, m)`), and puts no create whose case type is its
   module's case type in a basic subcase (`sameTypeBasicChildCases(D')`, section 8), the offer holds
   those placements; otherwise `null`.

So the offer is all or nothing: a partial move changes submission paths and still needs the privilege, a
cost with nothing bought. It never changes a module's kind, which would move every placement of its forms.
It never puts a new case of its module's own type in a basic subcase, which a project space with
`DONT_INDEX_SAME_CASETYPE` on would refuse next (section 8), so a project space lacking `save_to_case` with
that flag on meets the true constraint instead of two offers that undo each other. *Departure* from the
research's "which publish offers where a basic slot can express them", for that loop.

`asksChildCases` is true where some move lands in a basic subcase: HQ's `child_cases` privilege then
counts that form (`planPrivileges.ts`, `child_cases` counts basic subcases), so the next preflight may ask
for Child Cases, which more plans include. The copy says so.

**When it is offered.**

- On an `hq_confirmation_needed` refusal whose needs hold the unconfirmed plan feature
  `advanced-case-actions`: `refusal.placementMoves` is the offer's view where it is not `null`.
- On the pre-publish check (`service.ts::projectSpaceConfirmations`, behind the compatibility route and
  MCP's `check_project_space_compatibility`) while that row is `needs_confirmation`:
  `ProjectSpaceConfirmationChecks` gains `readonly placement_moves: PlacementMoveOfferView | null`.
- The `advanced-case-actions` need's `whereMissing` (`confirmations.ts::requiredConfirmations`, today
  `null`) becomes `saveToCaseWhereMissing(offer !== null, formNames)` (section 16).

**After it lands.** The moves are held by the `publish-placement` change, `formEmitsSaveToCase` no longer
holds for those forms, the need drops, and the publish goes on in the same request.

### 7.3 `same-type-child-links`

Let `S` be `sameTypeBasicChildCases(doc)` (section 8). The offer moves each to its Save to Case candidate,
the `save-to-case` entry of part 01's `lib/commcare/placement.ts::placementCandidates(doc, formUuid,
subject)` with the path the allocator gives it, plus the moves those force through `withIdentityMoves` (a
later basic subcase renumbered down). `null` where `S` is empty. Part 01 guarantees a Save to Case candidate
for every operation (its section 15), so the offer exists whenever `S` is nonempty. It holds those
placements, replacing holds that can still express their targets, which only a publish may record, and the
publish records it.

**When it is offered.** On a `project_space_incompatible` refusal whose report holds the
`same-type-child-links` capability as `missing` or as `unverified`: the move resolves both, since a Save to
Case block keeps the link whatever the flag says. The offer's copy says the plan then needs Save to Case,
which the next refusal asks for where it is not confirmed.

### 7.4 Accepting is idempotent

The service recomputes the offer from the head it holds: `null` (an earlier attempt recorded the moves, or
nothing is left to move) goes on without writing; a different digest refuses `hq_placement_moves_changed`
with the current offer; the same digest records. A retry after a refusal that already recorded the moves
cannot fail on its own acceptance.

### 7.5 Surfaces

- `DeploymentAttemptRefusal` gains `readonly placementMoves: PlacementMoveOfferView | null`, non-null only
  on the three refusals above (`hq_confirmation_needed` with the Save to Case need and an offer,
  `project_space_incompatible` with the same-type capability, `hq_placement_moves_changed`). Every builder
  of a refusal sets it (`preflightRefusal`, `refused`, `remoteAppGoneOutcome`).
- `app/api/commcare/upload/route.ts`: body `acceptPlacementMoves?: unknown`, read by
  `readAcceptPlacementMoves`: absent or `null` → `undefined`; a value `acceptPlacementMovesSchema` admits →
  itself; anything else → `ApiError("The move to accept has to name the reason and digest the publish
  offered.", 400)`. The response gains `placements` (`outcome.placements`); `refusal` already carries the
  offer.
- `components/builder/PublishDialog.tsx`: state `acceptMoves: AcceptPlacementMoves | null`, cleared with
  `confirmations` (close, destination change) and after every response, since a landed publish or a refusal
  whose `placements.moved > 0` recorded them and any other refusal is answered afresh. A
  `PlacementMoveChoice` section under a refused status whose `refusal.placementMoves` is non-null and
  `canEdit`: the offer's heading and body, one row per move sentence, one `Checkbox` (`@/components/shadcn`)
  labelled "Move them and publish". For `save-to-case` it is mutually exclusive with the
  `advanced-case-actions` row's "This project space has it": ticking one unticks the other, and the upload
  sends `acceptPlacementMoves` without that confirmation. `components/builder/publishOutcome.ts` reads
  `placementMoves` and `placements`.
- MCP: section 14.

---

## 8. Defect 12: links between cases of the same type

Pull request 8.

**HQ facts.**

| Fact | Source |
|---|---|
| A basic form's subcases are written by `XForm._create_casexml`; each gets a parent index to the form's own case only `if case_block is not None and (index_same_casetype or subcase.case_type != form.get_case_type())`, where `index_same_casetype = not DONT_INDEX_SAME_CASETYPE.enabled(self.domain)` | `corehq/apps/app_manager/xform.py::XForm._create_casexml` |
| That is the flag's only reader outside tests; advanced open actions (`_create_casexml_advanced`) and Save to Case blocks (written by the form's source) are untouched by it | `rg DONT_INDEX_SAME_CASETYPE` over commcare-hq: `corehq/toggles/__init__.py` and `xform.py` |
| The flag is a `StaticToggle`, slug `dont_index_same_casetype`, `TAG_DEPRECATED`, namespaces `[NAMESPACE_DOMAIN]` | `corehq/toggles/__init__.py::DONT_INDEX_SAME_CASETYPE` |
| The project-space list filters by any toggle slug in `toggles.all_toggle_slugs()`, keeping a domain where the slug is in `toggles_dict(username=…, domain=…)` | `corehq/apps/api/resources/v0_5.py::UserDomainsResource.get_object_list`; `corehq/toggles/__init__.py::toggles_dict` |
| A subcase's block name is `subcase_<id>`, its index in `subcases` | `corehq/apps/app_manager/models/form_actions.py::OpenSubCaseAction.form_element_name` |

**The predicate.** Part 01 writes it in pull request 4 (its section 15):
`lib/commcare/sameTypeChildCases.ts::sameTypeBasicChildCases(doc)`, every operation placed (held or
simplest) in a basic subcase slot whose case type is its form's module case type, as `{ formUuid,
operationUuid }` in document order. It reads `planPlacements`, so it cannot disagree with the emitted
`subcases`. This part reads it in pull request 8 and names each entry for the person:

```ts
// lib/commcare/projectSpaceCompatibility.ts (pull request 8)
/** One reason per same-type basic child, in document order (copy in section 16). */
export function sameTypeChildReasons(doc: BlueprintDoc): string[];
```

Each reason names the form, the case type (`lib/domain/forms.ts::operationCaseType`), and whether the form
registers the case it links to or works on one it loads (the form's type), which the two sentences of
section 16 say.

**The capability.** `lib/publish/projectSpaceCompatibility.ts`: `ProjectSpaceCapabilityId` and
`CAPABILITY_IDS` gain `"same-type-child-links"`, and `PROJECT_SPACE_CAPABILITIES` gains

```ts
"same-type-child-links": {
	id: "same-type-child-links",
	label: "Links between cases of the same type",
	description: "Keeps the link from a new case to the case of the same type it was made from.",
},
```

required where `sameTypeBasicChildCases(doc)` is nonempty, its reasons `sameTypeChildReasons(doc)`. The report's
"It doesn't support … Ask a project-space administrator or Dimagi Support to enable that support" reads
true for it: Dimagi turning the flag off is the support.

**The probe reads a flag that must be off.** `lib/commcare/projectSpaceCompatibility.ts`:

- `HqPrivateFeatureFlagId` gains `"same-type-links-dropped"`; `HQ_PRIVATE_FEATURE_FLAG_SYMBOLS` gains
  `"same-type-links-dropped": "DONT_INDEX_SAME_CASETYPE"`, resolved through `domainFeatureFlag` like the
  eleven. Its gate entry is keyed by project space alone, so the user-level merge in `toggles_dict` cannot
  reach it, the guard `domainFeatureFlag` already holds.
- `HqProjectSpaceCapabilityProbePlan` and `HqProjectSpaceAdvisoryProbePlan` gain `readonly featureFlagsOff:
  readonly HqPrivateFeatureFlagRequirement[]`; every existing plan entry passes `[]`; the
  `same-type-child-links` entry passes `featureFlags: []`, `featureFlagsOff:
  [HQ_PRIVATE_FEATURE_FLAGS["same-type-links-dropped"]]`, `runtimeProbes: []`.
- `lib/commcare/client.ts`: the probe collects `featureFlagsOff` beside `featureFlags` into the one map of
  flags it reads; `aggregatePrivateProbeState` reads an off flag inverted: `available` (listed, so on) is
  `missing`, `missing` (not listed after the unfiltered list proved the target visible) is `available`,
  `unverified` stays.

**The refusal.** `project_space_incompatible` as today, its report naming the capability, and
`refusal.placementMoves` the `same-type-child-links` offer (section 7.3).

**Why a probe, not a confirmation.** The flag is a domain toggle the project-space list filters by, the read
the probe already makes for eleven flags, and a person cannot read a staff-only toggle. Gated run G3
confirms the filter answers for this slug, and G4 that the flag changes HQ's build of Nova's form.

**Why refuse, not emit differently per project space.** A placement is the document's, one per operation
across every project space the app is published to (the research's "Case writes"): a per-target emission
would give one operation two submission paths.

**Ordering.** No document holds a basic subcase of its own module's type before step 5
(`proof/targeted/__tests__/unproducedInputs.test.ts`, "a basic child case of its own menu's case type").
Part 01's placement procedure would make one producible from pull request 4, while this check lands in
pull request 8, and the lane's sensitivity flip of `DONT_INDEX_SAME_CASETYPE` would then show a build
difference Nova's publish accepts. So until pull request 8, part 01's basic subcase eligibility excludes a
create whose case type is its module's case type (it takes Save to Case), and the `unproducedInputs` bullet
stays until then; pull request 8 lifts the exclusion in `lib/commcare/placement.ts` with the capability,
the offer, the lane's `flagsOff` verdict key and gated runs G3 and G4, and moves the bullet (section 17).
One deploy carries the stack, so no published app sees the interim placement.

---

## 9. CommTrack: the `commtrack-off` confirmation

Pull request 8.

**HQ facts.**

| Fact | Source |
|---|---|
| `Application.commtrack_enabled` reads the project space's `Domain.commtrack_enabled` | `corehq/apps/app_manager/models/applications.py::Application.commtrack_enabled` |
| Under it, the case list menu item of an `AdvancedModule` gets a `product_id` datum after its `case_id_case_<type>` datum, with the `product_short` detail | `corehq/apps/app_manager/suite_xml/sections/entries.py::EntriesHelper.entry_for_module` (the `elif isinstance(module, AdvancedModule)` branch, `if self.app.commtrack_enabled`) |
| Under it, any form whose `source` contains `session_var('supply_point_id')`'s text gets a `supply_point_id` datum from the `commtrack-supply-point` user data, with assertions | same function; `corehq/apps/app_manager/xpath.py::session_var` (`instance('commcaresession')/session/data/supply_point_id`); `EntriesHelper.get_userdata_autoselect` |
| Under it, an advanced form whose last load or update action has `show_product_stock` gets a `product_id` datum | `entries.py` (`if module.get_app().commtrack_enabled:` … `last_action.show_product_stock`) |
| `show_product_stock` defaults false; HQ's advanced case configuration offers it only where CommTrack is on | `corehq/apps/app_manager/models/form_actions.py::LoadUpdateAction.show_product_stock`; `static/app_manager/js/forms/advanced/actions.js`; `templates/app_manager/partials/forms/case_config_advanced.html` |
| Under CommTrack, HQ's build fails an advanced module with at least one form, whose case list is shown (or one of whose forms' load or update actions has `show_product_stock`), when its product short detail has no columns (`no product detail`); the check loops over `module.get_forms()`, so a formless module never meets it | `corehq/apps/app_manager/helpers/validators.py::AdvancedModuleValidator.get_case_errors` |
| No API key reads `Domain.commtrack_enabled`: its readers are session pages and the admin-only `DomainMetadataResource` | `corehq/apps/api/domain_metadata.py` (`AdminResourceMeta`) |
| The `COMMTRACK` toggle is not the setting: the toggle page's save function sets the domain flag, and `make_domain_commtrack` sets both, so either can be on with the other off | `corehq/toggles/__init__.py::COMMTRACK`, `_commtrackify`; `corehq/apps/commtrack/util.py::make_domain_commtrack` |

**The predicate.** `lib/commcare/planPrivileges.ts`, beside `formEntrySyncReasons`:

```ts
/**
 * The reasons CommCare Supply is asked about, in document order. Where a project space has it on, HQ's
 * build adds steps Nova did not write (`suite_xml/sections/entries.py::EntriesHelper.entry_for_module`):
 * a `product_id` datum on an advanced menu's case list menu item, and a datum from the worker's supply
 * point, with assertions, on a form whose stored source holds
 * `instance('commcaresession')/session/data/supply_point_id`. No API key reads the setting.
 */
export function commtrackReasons(doc: BlueprintDoc): string[];
```

- One sentence per module `lib/commcare/moduleKind.ts::advancedModulesWithCaseListMenuItem(doc)` returns
  (part 02, pull request 8): every module emitted advanced whose case list menu item is on, wherever a
  module holds one. Until pull request 10 that reader reads today's `caseListOnly`, so only a module with
  no forms can hold the item; from pull request 10 it reads part 05's `moduleHasCaseListMenuItem`
  (`Module.caseListMenuItem`, admitted beside forms there).
- One sentence per form whose emitted HQ source holds the text in some decoded text node or attribute
  value: `lib/commcare/xform/supplyPointText.ts::formSourceHoldsSupplyPointText(source: string): boolean`
  (new) parses the source with `lib/commcare/xmlParse.ts::parseXml`, walks every element's attribute values
  and text nodes as the DOM decodes them, and tests `includes(SUPPLY_POINT_SESSION_TEXT)` on each, the
  substring test HQ makes, never a parse of XPath. The sources are the `_attachments` of
  `expandDoc(doc, …)` with `identityLookupWireNaming()` and no attachment target, the emission the other
  emission-reading predicates of the module use, so every place text lands (prose in every language,
  option labels, literals, a computed datum if step 7 builds one) is covered by construction.
- Empty for an app with neither.

Nova's serializer writes every `'` as `&apos;` (`lib/commcare/serializeXml.ts`), so Nova's own bytes never
match HQ's test; a form-builder save writes them plainly (finding 68), after which the stored source can.
So the predicate reads the decoded text, a superset of what a save can leave. Gated run G2 settles whether a
save writes them plainly in a label's text node as in an attribute.

No third trigger: Nova writes `show_product_stock: false`, HQ's page writes `true` only through a control it
shows where CommTrack is on, and a person's change there changes `modules`, which the drift check compares at
the next publish.

**The copy and the kind.** `lib/publish/planFeatures.ts`: `COMMTRACK_OFF: ProjectSpaceSettingConfirmation`
(section 16), `PROJECT_SPACE_SETTING_KINDS` gains `"commtrack-off"` last, `PROJECT_SPACE_SETTINGS` maps it.

**Every surface, mirroring step 4's `form-entry-sync-off`.**

- `lib/deployment/types.ts`: `DEPLOYMENT_CONFIRMATION_KINDS` takes it from `PROJECT_SPACE_SETTING_KINDS`;
  `DeploymentConfirmationKey` gains `{ readonly kind: "commtrack-off" }`;
  `deploymentConfirmationKeySchema` gains `z.strictObject({ kind: z.literal("commtrack-off") })`.
- `lib/deployment/confirmations.ts`: `requiredConfirmations` appends, after sync on form entry, `{ kind:
  "commtrack-off", subject: "commtrack-off", label: COMMTRACK_OFF.label, plans: "", consequence:
  COMMTRACK_OFF.consequence, reasons, whereMissing: COMMTRACK_OFF.whereMissing }` where `commtrackReasons`
  is nonempty; `confirmationKeyOf` gains the arm; `ProjectSpaceConfirmationChecks` gains `readonly
  commtrack_off: ProjectSpaceSettingCheck | null`, filled by `setting("commtrack-off")`. `confirmationLabel`
  reads `PROJECT_SPACE_SETTINGS` by kind and needs no change.
- `components/builder/app-setup/publishingSectionModel.ts`: `requestKey` and `requestOrder`
  (`PLAN_FEATURE_IDS.length + 3`), `confirmationRequests` (where `checks.commtrack_off?.state ===
  "needs_confirmation"`), `withLandedConfirmations`. `components/builder/PublishPanel.tsx` copies
  `commtrack_off: body.commtrack_off ?? null`. `PublishDialog.tsx::ConfirmationChoice` reads the record by
  kind and needs no change.
- `app/api/commcare/project-space-compatibility/route.ts`: its header comment names `commtrack_off`.
- `lib/db/pg.ts::AppDeploymentConfirmationsTable.kind`'s comment lists five kinds.
- `components/docs/ProjectSpaceCapabilityCatalog.tsx` reads `Object.values(PROJECT_SPACE_SETTINGS)`: no
  edit.
- MCP and the import file: sections 13 and 14.

**The migration.** `lib/case-store/migrations/20261110010000_hq_round_trip_case_writes_commtrack_confirmation.ts`,
registered as `"20261110010000_hq_round_trip_case_writes_commtrack_confirmation":
hqRoundTripCaseWritesCommtrackConfirmation`:

```ts
// A publish asks a person to confirm that a project space has CommCare Supply turned off, for an app
// with an advanced menu whose case list is its own menu item, or a form whose source text names the
// session's supply point: a fifth confirmation kind, `commtrack-off`, stored under its own name as
// subject. Additive in effect: every row the revision before writes still passes both constraints.

import { type Kysely, sql } from "kysely";

/** A person may confirm that a project space has CommCare Supply turned off. */
export async function up(db: Kysely<unknown>): Promise<void> {
	await sql`ALTER TABLE public.app_deployment_confirmations
		DROP CONSTRAINT app_deployment_confirmations_kind_check,
		ADD CONSTRAINT app_deployment_confirmations_kind_check CHECK (kind IN
			('plan-feature', 'flat-location-fixture', 'connect-forwarder', 'form-entry-sync-off', 'commtrack-off')),
		ADD CONSTRAINT app_deployment_confirmations_commtrack_subject
			CHECK (kind <> 'commtrack-off' OR subject = 'commtrack-off')`.execute(db);
}

/** Forward only: undoing it would delete what people confirmed. */
export async function down(): Promise<void> {
	throw new Error(
		"This migration is forward-only: undoing it would delete what people confirmed about their project spaces.",
	);
}
```

The table is schema-qualified; `ALTER TABLE … DROP CONSTRAINT` names a constraint of that table only, so no
catalog read by a bare constraint name happens. The ledger applies it once in the window (decision 11);
no `IF EXISTS` is needed for a migration the ledger records.

**Why a confirmation, not a probe.** No API key reads the setting, and the `COMMTRACK` toggle can be on with
the setting off or off with it on, so a toggle read would answer the wrong question in both directions.

**Ordering.** HQ's first trigger needs an advanced module whose case list menu item is on. Pull request 7
emits advanced modules with no menu item beside their forms, and `Module.caseListMenuItem` beside forms
first exists in pull request 10 (part 05). Before then a module with its case list as a menu item has no
forms, so it is advanced only through a held kind, which no corpus document holds. So:

- Pull request 7's lane meets only the `product_short` detail HQ adds to every advanced module under
  CommTrack; no verdict requires CommCare Supply off before pull request 8, so the flip is accepted and held to
  its effects (G1's first half, part 08's G4).
- Pull request 8 lands the confirmation with both arms. Its menu-item arm is witnessed by Vitest until pull
  request 10: `lib/commcare/__tests__/planPrivileges.test.ts` and
  `proof/targeted/__tests__/publishChecks.test.ts` build a formless module whose kind is held advanced and
  whose case list is its menu item, and assert the reason and the `commtrack-off` need.
- Pull request 10 brings the lane witness, `targeted-commtrack-advanced` (part 08), whose verdict requires
  CommCare Supply off, and G1's second half reads the `product_id` datum there.

So no pull request's lane meets a CommTrack difference its verdict accepts without knowing it.

---

## 10. `VIEW_FORM_ATTACHMENT` over link writes

Pull request 4, where a link write becomes a write of an operation. (Pull request 2, which removes
attachment mode, drops `linkWriteIsShown`'s `mode === "url"` test with the `case-attachments` capability;
part 01 lists that change.)

The check stays the `attachment-links` probe of the readable domain toggle `VIEW_FORM_ATTACHMENT`
(`corehq/apps/reports/views.py::_can_view_form_attachment`: HQ serves a form attachment to anyone the
view's checks pass where the toggle is on, and otherwise only to a person with submission history). From
pull request 4 its predicate reads every link write, whatever its placement:

```ts
// lib/commcare/projectSpaceCompatibility.ts
/** Every link write's landing `(caseType, property)`, in document order. */
export function linkWriteDestinations(doc: BlueprintDoc): readonly { readonly caseType: string; readonly property: string }[];
/** Whether some case list or detail column shows, or some form's prose prints, the link a write lands. */
export function linkWriteIsShown(doc: BlueprintDoc, destination: { caseType: string; property: string }): boolean;
```

- A link write is a write whose value is part 01's `capture-link` term. It lands at
  `relationDestinationCaseType(write.via, operationCaseType, doc.caseTypes)`
  (`lib/domain/expression/rewrite.ts`), the operation's case type (the module's for the own arm) or the
  ancestor its `via` reaches.
- It is shown where a column that `caseListColumnTextShows` admits reads that destination: a plain column
  of a module of that case type naming the property, or a calculated column with a `prop` term whose
  landing case type (`relationDestinationCaseType(term.via, term.caseType, doc.caseTypes)`, the reader
  `lib/commcare/distanceSearches.ts` uses) and property are the write's, in a module of any case type.
- It is printed where a form field's prose (every slot `lib/domain/expressionSource.ts::proseSurfaceReads`
  lists: label, hint, help, validation message and option labels, in every language) holds a `case-ref` part
  naming that type and property, or a `field-ref` part to a field whose `calculate` or `default_value`
  reads it (a `form-case` term naming that type and property, or a `prop` term whose landing case type and
  property are the write's). Prose is not parsed as markdown: every printed reference counts, inside a
  markdown link or not.

The second clause fixes finding N1: a child menu's calculated column that shows its parent's photo link asks
nothing of the project space today, though a worker opens the link there. The third clause covers a form
that prints the link. A bare link a form prints is not a tap target: neither Web Apps
(`markdown-it({ breaks: true })`, no linkify) nor Android (Markwon with no linkify plugin;
`Linkify.PHONE_NUMBERS` only when the text holds ☎) auto-links one. A markdown link is: Web Apps renders
`[text](url)` with `target=_blank` (`corehq/apps/cloudcare/static/cloudcare/js/markdown.js::initMd`, its
`link_open` rule), over the caption Formplayer sends with its outputs already filled
(`PromptToJson.java::parseCaption`), and Android sets `LinkMovementMethod` on every question text with a
markdown form (commcare-android `views/widgets/QuestionWidget.java::setQuestionText`), which Nova writes for
every itext entry. So `[Open photo](<output value="#case/photo_link"/>)` hands the worker the link, and the worker
who opens it needs the toggle as much as one who taps a column. Counting every printed reference, not only
one inside a markdown link, keeps the predicate on Nova's typed prose without parsing markdown, and a printed
address the worker copies reaches the same attachment view. The probe plan's `attachment-links` reason
becomes "The app shows a link to a captured file in a case list, its details or a form."

---

## 11. What a deployment's baseline holds: `publishedCaseBlocks`

Pull request 6. The cutover (part 09) reads published placements with it, and step 6's import reads an
imported app's placements the same way.

**What a baseline carries.** A `push` or `cutover` baseline holds HQ's whole app source after Nova's push:
each form's `actions` (basic `FormActions` or advanced), each module's `doc_type`, and each form's XForm
under `_attachments`, where every Save to Case block is an element carrying Vellum's `role` attribute
`SaveToCase`. HQ's stored XForm holds no basic or advanced case block: HQ's build writes those from
`actions` (`xform.py::XForm._create_casexml`, `_create_casexml_advanced`). A `create` baseline holds an empty
shell; an `unread` one holds nothing.

```ts
// lib/commcare/hq/publishedCaseBlocks.ts (new; in the wire boundary, it reads HQ's vocabulary)
export type PublishedCaseBlock =
	| { readonly kind: "basic-own"; readonly path: "case"; readonly caseType: string;
		readonly opens: boolean; readonly closes: boolean; readonly properties: ReadonlyMap<string, string> }
	| { readonly kind: "basic-usercase"; readonly path: "commcare_usercase";
		readonly properties: ReadonlyMap<string, string> }
	| { readonly kind: "basic-subcase"; readonly index: number; readonly path: string;
		readonly repeatContext: string | null; readonly caseType: string;
		readonly relationship: "child" | "extension"; readonly properties: ReadonlyMap<string, string> }
	| { readonly kind: "advanced"; readonly action: "load" | "open"; readonly tag: string;
		readonly path: string; readonly caseType: string; readonly properties: ReadonlyMap<string, string> }
	| { readonly kind: "save-to-case"; readonly path: string; readonly caseType: string | null };

export interface PublishedForm {
	readonly xmlns: string;
	readonly blocks: readonly PublishedCaseBlock[];
	/** The data path of each model-iteration repeat's row (`…/item`), as Vellum writes the shape. */
	readonly modelIterationRows: readonly string[];
}

/** Every case block HQ's build of each form writes, keyed by the form's `xmlns`. */
export function publishedCaseBlocks(normalizedSource: unknown): ReadonlyMap<string, PublishedForm>;
```

- `properties` maps each written property to the question path HQ reads it from
  (`ConditionalCaseUpdate.question_path`).
- Paths are data paths relative to the instance root, segments joined by `/`.
- **Basic blocks** follow `xform.py::XForm._create_casexml`: the own block (`case`) when `open_case`,
  `update_case` or `close_case` is active and the form uses default case management; `commcare_usercase`
  when `usercase_update` writes a property; each `subcases[i]` at `subcase_<i>` under its repeat
  (`repeatContext/subcase_<i>`), or at the repeat itself where it is that repeat's only subcase (`nest =
  repeat_context_count[…] > 1`; outside a repeat `nest` is always true).
- **Advanced blocks** follow `_create_casexml_advanced` and its `get_action_path`: `case_<tag>`
  (`models/form_actions.py`, the advanced action's `form_element_name`) at the root or in its repeat.
- **Save to Case blocks** are read from the form's XForm with `parseXml`, walked as elements, never matched
  as text: each element with Vellum's `role` `SaveToCase`, its path from the data root, and its
  `vellum:case_type` where it holds a literal (otherwise `null`).
- **Model-iteration rows** are each element with Vellum's `role` `Repeat` holding the `ids`, `count` and
  `current_index` attributes and an `item` child: the shape part 04's model iteration emits (Vellum's
  `modeliteration.js`), by the `item` row's path.
- **Forms are keyed by `xmlns`**, never by position: the baseline's form tokens are positions at that push,
  and a form's `xmlns` is its identity (`lib/commcare/wireIdentity.ts::derivedFormXmlns`, or the
  deployment's `app_deployment_identities` override through `targetWireIdentity`).
- A source that is not an application, or a form with no `xmlns`, is skipped and counted by the caller,
  never guessed: the reader returns only what it read.

Part 09's cutover brief called the same reader `baselineCaseBlocks(normalizedSource, xmlns)`; it reads
`publishedCaseBlocks(source).get(xmlns)`.

---

## 12. Published deployments with an unread baseline

Decision 5. Part 09's cutover runs it in pull request 14; this section fixes the rule.

**The rule.** For an app with at least one published deployment (part 09 §8.1, which counts a deployment
whose live app mapping is marked missing on CommCare HQ, since the project space keeps its submissions
under the same `xmlns`) whose baseline Nova could not read (origin `unread`, or no baseline row at all),
the cutover holds, for every operation, own close and query repeat of the app, the placement today's
emission gives it, where that placement can still express the target in the head document:

- the placement comes from a frozen copy, in the cutover tooling, of today's classifier (part 09's
  `frozen/todaysPlacements.ts::todaysPlacements`, its §8.2): the bucket rules of
  `lib/domain/caseWriteInventory.ts::deriveCaseWriteInventory` (own case, usercase, children by
  `(type, repeat)`) and today's Save to Case paths (`nova_operations`, `nova_subcases/nova_subcase_<n>`,
  the several-case wrapper, `nova_condition_close/nova_close`);
- a query repeat holds `model-iteration` where `queryRepeatPlacementNeeds` is empty. One whose rule gives
  the count placement is the exception: keeping model iteration would hold the shape
  `QUERY_REPEAT_MODEL_ITERATION_SHAPE` refuses, which is defect 25 itself, so it takes the count placement
  unheld, as any published query repeat with that rule does, with its document notice line
  `repeat-rows-follow-query` and the deployment line `form-data-paths-move` with cause
  `repeat-rows-follow-query` (part 04 §7.1, part 09 §8.5);
- defect 24's exceptions move as they do for a readable baseline (part 02: the inert subcase goes and a
  basic child after it moves up; a carried extension child moves to an advanced open action).

The deployment's notice line is `placements-kept-unread` (section 16).

**A baseline whose bytes cannot be read is a blocker.** A baseline row whose `source_gzip` fails gunzip,
whose text fails its `source_digest`, or whose source fails to parse is the cutover blocker
`baseline-unreadable` (part 09 §16). Its remedy is refreshing that deployment, which reads CommCare HQ's app
again; the cutover runs once the blocker is gone. Production holds none, so the blocker meets no app today;
the advisory dry run counts it before the window.

**Why.** An unread baseline is unknown, not empty. Reading it as carrying nothing would move every case
change of the app to its simplest placement, changing submission paths the project space may hold. Keeping
today's placement keeps every path today's publishes sent. *Departure* from the research, which records only
operations a baseline carries, for that reason. A row whose bytes fail is not an unread baseline: it claims a
read Nova made, so the failure is damage, not absence, and neither reading it as carrying nothing (part 09's
brief) nor as unread would be true; the blocker sends it to the refresh that repairs it.

**What production holds.** The content-free scan (part 09, decision 16) found a published deployment whose
baseline is `unread`, so the rule applies at the window: each such app keeps today's placements, each such
deployment gets its `placements-kept-unread` line, and the runbook records in words that some published apps
kept today's placements this way. The cutover's dry run decides per app at the window, and step 6's drift
merge inherits the rule.

---

## 13. The HQ import file and the `.ccz`

**Both read and never record.** The `.ccz` (`lib/export/localArchive.ts::compileLocalArchive`), the HQ
import file (`lib/commcare/multimedia/hqJsonExportArchive.ts`), `/api/compile/*` and MCP's `compile_app`
emit each target's effective placement through the same `planPlacements` the publish reads, and none writes
a `publish-placement` change. Only `publishAppToHq` writes one. Reasons: the `.ccz` is offered for a reached
deployment, so its held placements are the paths HQ's build there holds, and an unheld target takes the
placement the next publish records; the import file makes a new HQ app with no continuity, and a record made
for it would bind every later publish to a project space Nova never saw. Neither offers a move: a move is a
document edit, and downloads are reads.

**The `.ccz` and the two HQ build effects.** Nova's own suite and case blocks make the `.ccz`; HQ's build
never runs on it. So neither `DONT_INDEX_SAME_CASETYPE` nor CommTrack changes a `.ccz`, and neither check
applies to it.

**The import file's guide** (`lib/publish/manualImportGuide.ts`), pull request 8:

- `ManualImportStepKind` and `STEP_KINDS` gain `"commtrack-off"` and `"same-type-child-links"`.
- `ManualImportGuideInput` gains `readonly commtrack: boolean` (`commtrackReasons(doc).length > 0`) and
  `readonly sameTypeChildLinks: readonly string[]` (the forms `sameTypeBasicChildCases` names, by name).
- `manualImportGuide` writes `same-type-child-links` after `capabilities` and `commtrack-off` after
  `form-entry-sync-off`, each where its input holds (copy in section 16).
- `hqImportFileGuide` leaves `same-type-child-links` out of the `capabilities` step: that step says Dimagi can
  turn a feature on, and this capability is a flag Dimagi turns off, so it gets its own step.
- The plan-features step already lists Save to Case where an effective placement uses it
  (`requiredPlanFeatures`).
- An import file made for a project space with the flag on cannot be detected (it has no target); its step
  says to ask.

---

## 14. MCP and scopes

| Tool | Scope | From step 5 |
|---|---|---|
| `upload_app_to_hq` | `nova.hq.write` (its existing `oauthScopeChallenge` and `assertScope`) | `accept_placement_moves` (6), `confirm_commtrack_off` (8); refusal `placement_moves`; `placements` on every answer; tags `app_changed_while_publishing`, `hq_placement_moves_changed` (6); it now changes the saved app, which the route-level `nova.write` floor already grants |
| `check_project_space_compatibility` | `nova.hq.read` | returns `placement_moves` (6) and `commtrack_off` (8); the report holds `same-type-child-links` where required (8) |
| `withdraw_deployment_confirmation` | `nova.hq.write` | `kind` takes `commtrack-off` from `DEPLOYMENT_CONFIRMATION_KINDS` (8) |
| `compile_app` | unchanged | emits effective placements and records none |

`lib/mcp/tools/uploadAppToHq.ts`:

```ts
accept_placement_moves: acceptPlacementMovesSchema
	.optional()
	.describe(
		"Send only after a refusal returned placement_moves, with its reason and digest, once the user agreed to move those case changes.",
	),
confirm_commtrack_off: z.boolean().optional().describe(CONFIRM_DESCRIPTION),
```

`confirmationKeys` maps `confirm_commtrack_off: true` to `{ kind: "commtrack-off" }`. The refusal envelope
gains `placement_moves: { reason, digest, moves: [{ form, change, sentence }] } | null` (names and sentences
only, never a wire path) and every answer `placements: { recorded, moved }`. `UPLOAD_ERROR_TAGS` and
`lib/mcp/errors.ts::UploadErrorType` gain `app_changed_while_publishing` and `hq_placement_moves_changed`.
The descriptions gain the sentences of section 16. `lib/mcp/__tests__/servedSchemas.test.ts` holds what a
client receives; no `test:schema` entry, since none of these tools is the Solutions Architect's.

---

## 15. Preview

Nothing here changes what Preview plays. Preview reads placement only for "save only if changed" and close
timing, which do not depend on it (part 01). CommTrack's datums and the dropped same-type index are HQ build
effects in project spaces Nova's publish refuses or asks about; Preview plays the app as the publish sends it
where the person confirmed CommCare Supply off and the probe found the flag off. No platform table row and no
Preview cell: neither is a platform difference.

---

## 16. Copy

Every string follows `design/readme.md`, "Content fundamentals": sentence case, no em dash, what happened,
what it means, and the next step offered rather than ordered.

**Publish refusals** (`DeploymentFailure.message`; `details` as stated):

| Code | Message | Details |
|---|---|---|
| `app_changed_while_publishing` | "This app kept changing while Nova got it ready to publish, so nothing was sent. Publish again once the edits settle." | none |
| `hq_placement_moves_changed` | "The case changes Nova offered to move have changed since you agreed, so nothing was moved or sent. Here's what would move now." | the current offer's move sentences |
| `app_not_ready` (from the record) | the kernel's sentence, unchanged | none |

**The kernel's placement refusal** (`PLACEMENT_CHANGE_REFUSAL`, section 3): "Nova keeps each case change where
CommCare HQ last received it, and only a publish records a new place. This change would move one that can stay
where it is, so nothing was saved. Reload the app and make the change again."

**The placement conflict** (section 6.2):

- `IdentityMoveDialog` lead `placement-recorded` (part 07 places it above the move rows): "A publish just
  recorded where CommCare HQ keeps these answers, so your change now moves them."
- The toast where nothing can be offered: title "App reloaded", body "A publish just recorded where CommCare HQ
  keeps some answers your change moves. We loaded the latest version; make the change again to see what it
  moves."
- The move rows, the dialog's buttons and the toast for a history step that kept a hold are part 07's copy;
  this part adds no sentence to them. Undoing a move puts the change back where the publish recorded it
  (section 2.6), so no row needs to warn that undo keeps the new place.

**The `save-to-case` offer** (section 7.2):

- Heading: "Move these case changes"
- Body: "Your project space's plan may not include Save to Case. Nova can save these case changes the way CommCare
  HQ's Case Management settings do instead, which every plan keeps. Moving them changes where CommCare HQ keeps
  their answers in every project space this app is published to, so form exports show them under new columns
  from the next version. Answers already submitted stay where they are."
- Where `asksChildCases`: the body ends "Where a moved change makes a new case, the publish then asks whether
  the plan includes Child Cases, which more plans do."
- Checkbox: "Move them and publish"
- Move sentences: "In {form}, the change that {change} moves from a Save to Case block to Case Management." and,
  for a move the first forces, "In {form}, the change that {change} stays in Case Management, in a new place."
- `saveToCaseWhereMissing(true, …)`: "Where the plan doesn't include it, Nova can move these case changes to
  CommCare HQ's Case Management settings, which every plan keeps. Choose that when you publish."
- `saveToCaseWhereMissing(false, forms)`: "Where the plan doesn't include it, the app can't go to this project
  space as it is: {forms} make case changes only Save to Case can hold." (`{forms}` through
  `lib/publish/planFeatures.ts::namesInWords`.)

**The `same-type-child-links` offer** (section 7.3):

- Heading: "Save these new cases with Save to Case"
- Body, capability `missing`: "This project space drops the link from a new case to the case of the same type
  it was made from. Save to Case blocks keep that link everywhere. Moving these changes where CommCare HQ keeps
  their answers in every project space this app is published to, and the project space's plan then needs Save
  to Case."
- Body, capability `unverified`: "Nova couldn't check whether this project space keeps the link from a new case
  to the case of the same type it was made from. Save to Case blocks keep that link everywhere. Moving these
  changes where CommCare HQ keeps their answers in every project space this app is published to, and the
  project space's plan then needs Save to Case."
- Checkbox: "Move them and publish"
- Move sentences: "In {form}, the change that {change} moves from Case Management to a Save to Case block." and
  the forced-move sentence above.

**The capability** (section 8): label "Links between cases of the same type"; description "Keeps the link from a
new case to the case of the same type it was made from."; reasons "{form} makes a {type} case linked to the
{type} case it works on." and "{form} makes a {type} case linked to the {type} case it registers."

**CommCare Supply** (section 9; gated run G2's outcomes B and C change it as written there):

```ts
export const COMMTRACK_OFF: ProjectSpaceSettingConfirmation = {
	label: "CommCare Supply turned off",
	consequence:
		"With it on, CommCare HQ adds steps this app doesn't have: an advanced menu's case list asks workers to choose a product first, and a form that names the session's supply point opens only for workers assigned one.",
	question: (space) =>
		`Does “${space}” have CommCare Supply turned off? It's off unless Dimagi turned it on for the project space.`,
	confirmLabel: "It's off",
	whereMissing:
		"Only Dimagi Support can turn CommCare Supply off, and that changes every app in the project space. Where it stays on, you can turn off the case list menu item of each advanced menu named here and take the supply point text out of each form named here, and then the setting no longer matters to this app.",
};
```

`commtrackReasons` sentences: "{menu} shows its case list as its own menu item, in a menu CommCare HQ builds as
advanced." and "{form} holds the text instance('commcaresession')/session/data/supply_point_id, which CommCare
HQ reads as the session's supply point." (`{menu}` is the module's name, trimmed, or its id, as
`formEntrySyncReasons` names a module.)

**Notices** (`lib/notices/migrationNoticeCopy.ts`):

- `next-publish-asks-more`: `settings` holding `commtrack-off` adds `COMMTRACK_OFF.label` to the confirmed
  labels and the sentence "CommCare HQ adds steps to this app where {space} has CommCare Supply on, so Nova
  asks whether it's off."; `capabilities` holding `same-type-child-links` adds the capability's label, as every
  capability does, and the sentence "{space} has to keep the link from a new case to the case of the same type
  it was made from, so Nova checks that before the next publish there."
- `placements-kept-unread` (deployment, no `detail`), a new `DEPLOYMENT_NOTICE_REASONS` entry after
  `data-paths-move-once` (part 09 places it among its own new reasons): "Nova couldn't read the app {space}
  last received, so it kept where every form of this app saves its case changes there. Publishing again keeps
  them in the same places."

**The HQ import file's steps** (section 13):

- `same-type-child-links`, title "Links between cases of the same type": "{forms} make a case linked to a case
  of the same type. A few older project spaces drop that link, and there those forms lose it." / "It helps to
  ask Dimagi Support whether this project space keeps it: {support email}."
- `commtrack-off`, title "CommCare Supply": "CommCare HQ adds steps this app doesn't have where the project
  space has CommCare Supply on." / "It helps to check with Dimagi Support that it's off: {support email}. It's
  off unless Dimagi turned it on."

`{support email}` is `PROJECT_SPACE_COMPATIBILITY_SUPPORT_EMAIL`.

**The upload route's 400** (section 7.5): "The move to accept has to name the reason and digest the publish
offered."

**MCP descriptions** (section 14):

- `upload_app_to_hq` gains, after the confirmations sentence: "The first upload of a case change records where
  CommCare HQ keeps it, which changes the saved app (`placements.recorded`); work begun with `begin_work` before
  then has to begin again. If a refusal carries `placement_moves`, show the user each move's `sentence`, and
  send `accept_placement_moves` with its `reason` and `digest` only when the user agrees: the move changes where
  CommCare HQ keeps those answers in every project space the app is published to. `hq_placement_moves_changed`
  means the offer changed since; show the new one. `app_changed_while_publishing` means the app kept changing
  while Nova prepared the upload; upload again." The confirmations sentence's list reads "(a plan feature, the
  flat location list, a Connect forwarder, Sync Cases On Form Entry turned off, CommCare Supply turned off)",
  and its `confirm_*` list gains `confirm_commtrack_off`.
- `check_project_space_compatibility` gains: "`commtrack_off` says whether the project space's CommCare Supply
  setting needs confirming, and `placement_moves`, where present, lists the case changes Nova can move so the
  app doesn't need Save to Case."
- `withdraw_deployment_confirmation`'s `kind` description lists `commtrack-off`.

---

## 17. What this part needs of the proof lane

Part 08 holds the lane's detail and the one list of document names (decision 15); this section names what
this part's changes need there.

- **The capture moves with publish** (pull request 6; `proof/CLAUDE.md`'s rule, part 08's D5).
  `proof/corpus/publish.ts` returns `placementsToHold(D)` as the record its first publish writes;
  `proof/corpus/emitCorpus.ts` applies it through the production reducer (`prepareMutationCandidate` with one
  `holdPlacements`) before the edit batch is planned, so `document.json` holds D as stored after its first
  publish and B is a republish over held placements. An edit the holds cannot express is planned with its
  moves by `withIdentityMoves`, as an author's would be.
- **The corpus judges an edit by the kernel's rule** (part 08's `proof/corpus/editBatches.ts::judgeProposal`).
  It calls `placementChangeRefusal(D, D′, "autosave", readPlacementHolds(D))`: D is the document as stored
  after its first publish, so its holds are exactly what that publish recorded, the value the kernel would
  read from the database.
- **Verdict keys.** `NovaPublishVerdict.minimumConfiguration.commtrackEnabled?: false` (decision 7; part 08
  lands the reading in pull request 1, and pull request 8 writes it where `requiredConfirmations` holds a
  `commtrack-off` need). `minimumConfiguration.flagsOff?: readonly string[]` and `capabilities[].flagsOff`
  (pull request 8): the symbols of every `featureFlagsOff` entry of the probe plan, written only where
  nonempty. `proof/checks/corpus.py::verdict_lacks` appends "CommCare Supply off" for a configuration with
  `commtrack` on under `commtrackEnabled: false`, and "{SYMBOL} off" for each `flagsOff` symbol the
  configuration has on; it refuses a `commtrackEnabled` other than `false` and a `flagsOff` that is not a list
  of strings with `CorpusLayoutError`, as it refuses `syncCasesOnFormEntry`. `proof/corpus/entryWriter.ts`
  refuses a document whose `projectSettings.commtrack` is `true` while its verdict requires CommCare Supply
  off. The corpus field is `projectSettings.commtrack` (`proof/corpus/documents.ts`) and the configuration's
  `commtrack` (`proof/corpus/configurations.ts`); only the verdict key is `commtrackEnabled`, and "CommCare
  Supply off" is the word part 08 §1.4 writes for it.
- **Targeted documents** (names as part 08 gives them):
  - `targeted-held-placement` (pull request 5): form "Update", whose own update holds a basic slot, and form
    "Weigh", whose operation holds Save to Case because it writes a computed value; D′ adds to Update a write
    the basic slot cannot hold and removes Weigh's computed write. Proofs 1 and 5 hold the move inside the
    footprint and Weigh's held path unchanged though its simplest placement is now basic.
  - `targeted-supply-point-text` (pull request 8): a survey form with the supply-point text in a label (two
    languages) and in a calculate's string literal. Proof 4's two Vellum saves and G2.
  - `targeted-same-type-child` (pull request 8): form A, a follow-up whose create of its module's own type
    takes a basic subcase (its verdict's `flagsOff` holds `DONT_INDEX_SAME_CASETYPE`); form B, a follow-up
    whose create of its own type carries a write condition, so a Save to Case block is its simplest
    placement, the accepted counterpart whose index the flag leaves alone. G3 and G4.
  - `targeted-commtrack-advanced` (pull request 10, where the case list menu item beside forms first exists):
    an advanced module (a carried create) whose case list menu item is on beside its forms, with no filter so
    part 02's `case-list-menu-item-narrowed` blocker leaves it advanced, and with part 02's default product
    column; both platforms; its verdict requires CommCare Supply off. G1's second half.
  - G1's first half needs no new document: it reads every advanced document part 02 adds in pull request 7.
- **Gate and manifest entries** (`lib/commcare/surface/entries/`, with their inventory rows):
  - `gates.json` `project-space-setting/Domain.commtrack_enabled`: `content` becomes "at publish of an app with
    an advanced module whose case list menu item is on, or with a form whose source text, decoded, holds
    `instance('commcaresession')/session/data/supply_point_id` (HQ's substring test,
    `entries.py::entry_for_module`); import asks the same from step 6"; `effects` from G1 (the `product_short`
    detail from pull request 7's run, the menu item's `product_id` datum from pull request 10's); `preflight`
    unchanged. `docs/research/2026-09-26-hq-round-trip/inventory/gates.md`'s publish-checks paragraph the same.
  - `gates.json` `toggle/DONT_INDEX_SAME_CASETYPE`: `preflight.cell` "flag probe; refuse same-type basic child
    cases and offer Save to Case"; `effects` from G4.
  - `forms-and-case-writes/subcase-of-the-module-s-own-case-type-in-a-project-space-with` stays REFUSED; its
    `dispositionCell` gains "publish refuses it with the offered move to Save to Case
    (`same-type-child-links`)". Part 08 owns the manifest judge's flag-dependent value class.
  - `gates.json` `toggle/VIEW_FORM_ATTACHMENT`: `preflight.cell`'s clause becomes "for an app that shows a link
    write in a case list or detail, read through any relation, or prints it in a form" (pull request 4).
  - `menus-and-case-lists/advancedmodule-product-details-equal-to-the-default-single-name` stays INERT: part
    02's emitter writes the default.
- **`proof/hq/test_flag_probe.py`** gains `DONT_INDEX_SAME_CASETYPE` (G3).
- **`proof/editors/test_commtrack_supply_point_text.py`** (new, G2): `targeted-supply-point-text` published,
  saved in HQ's form builder, built with CommTrack on and off; asserts the `supply_point_id` datum and its
  assertions appear after the save with CommTrack on and in no other of the four builds.
- **`proof/targeted/__tests__/unproducedInputs.test.ts`**: the bullets "a basic child case of its own menu's
  case type" and "defect 20's `product_id` datum" move, with their cases, to
  `proof/targeted/__tests__/publishChecks.test.ts` (new, pull request 8), which tries each through
  `requiredConfirmations` and `projectSpaceCompatibilityProbePlan` with an HTTP peer in the file's style: the
  same-type create refused under the peer's flag-on answer and accepted under flag-off; the advanced menu item
  asking `commtrack-off`, over a formless module whose kind is held advanced (the Vitest witness of that arm
  until `targeted-commtrack-advanced` lands in pull request 10). The "defect 23 without `MM_CASE_PROPERTIES`"
  bullet leaves with attachment mode (pull request 2). The supply-point read bullet stays.
- **No register entry moves for this part.** The register holds no defect 12, 20 or 22 entry; defect 23's and
  24's entries, which this part's predicates touch, move with parts 01 and 02.

---

## 18. Migration classes for the one cutover

Part 09 runs every class inside its fleet transaction and writes the holds in each app's whole migrated
document (decision 12). This part contributes:

1. **Published placements from baselines.** Each operation, own close and query repeat whose path some
   published deployment's baseline carries (part 09 §8.3, through `publishedCaseBlocks`) is held at that
   placement; one not carried takes the simplest, unheld. No notice for a kept placement: nothing changes on
   the wire.
2. **Unread baselines** (section 12): every operation, own close and query repeat of such an app keeps
   today's placement, but a query repeat whose rule gives the count placement, which moves with
   `repeat-rows-follow-query` and its `form-data-paths-move` line; deployment reason
   `placements-kept-unread`. Production holds such a deployment, so this class writes holds and lines at the
   window.
3. **CommCare Supply asks more.** A published app holding a form whose decoded emitted source holds the
   supply-point text (a label or a literal can hold it today) gets, on each live deployment,
   `next-publish-asks-more` with `detail.settings` holding `commtrack-off`. No app holds an advanced module
   before the cutover, and no migration makes a module advanced with its case list menu item on (part 02
   makes advanced only modules whose forms need it, and production holds no carried create that would), so
   the menu arm adds no line. The planning scan did not count published forms holding the text, so both
   outcomes stay, and the advisory dry run decides them: where it finds none, the class writes no line at the
   window and the runbook says so in words; where it finds some, those deployments get the line.
4. **Same-type links checked.** A published app whose migrated document holds a create of its module's own
   type in a basic subcase (an operation no baseline carries, which takes the simplest) gets, on each live
   deployment, `next-publish-asks-more` with `detail.capabilities` holding `same-type-child-links`, and its
   next publish probes the flag. The dry run counts it; production holds none today, so the class writes no
   line unless an author makes the shape before the window.
5. **DDL**: the two migrations of sections 4.2 and 9, ledgered, additive in effect, applied in the window's one
   ledger phase with the fold horizon migration (decision 11).

Blockers: one from this part, `baseline-unreadable` (section 12), for a baseline row whose bytes fail gunzip,
digest or parse; production holds none today. Part 09 lists it among its blockers with its remedy.

---

## 19. Contracts and docs these changes make false

**Pull request 5:**

- `lib/doc/CLAUDE.md` gains, in its mutations paragraph: "`holdPlacements` is the only mutation that writes a
  held placement (an operation's `placement`, a form's `ownClosePlacement`, a query repeat's `placement`, a
  module's `heldKind`); no other payload carries those slots, a duplicate starts unheld, `diffDocsToMutations`
  emits it last, and a history step carries only the hold changes the kernel admits an editor: a move its
  batch needs, or the restore of the hold the latest recording wrote (`applyHistoryStep`, reading the
  recorded holds `setRecordedPlacementHolds` gives the store)." `lib/db/CLAUDE.md` gains the rule:
  "`placementAuthority.ts::placementChangeRefusal` decides who may change a held placement: a publish or a
  migration may change any hold; an editor's batch may move a hold the same batch makes inexpressible, or
  restore exactly the hold the target's latest recording wrote (the latest `publish-placement` or
  `blueprint-migration` row, else the greatest fold baseline's snapshot, read by
  `placementRecords.ts::readRecordedPlacementHolds` under the app lock); everything else is refused."
- `lib/collab/CLAUDE.md`: the read snapshot's paragraph gains "`recordedHolds`, the hold each held
  target's latest recording wrote, read in the snapshot's transaction; the reconciler keeps it beside
  `confirmedDoc` and hands it to the store for undo and redo."

**Pull request 6:**

- Root `CLAUDE.md`: "its mutation-bearing `autosave` / `mcp` / `chat` rows also feed multiplayer, while
  `blueprint-migration` / `fold-baseline` / `project-move` are server-only reload boundaries" becomes "its
  mutation-bearing `autosave` / `mcp` / `chat` / `publish-placement` rows also feed multiplayer, while
  `blueprint-migration` / `fold-baseline` / `project-move` are server-only reload boundaries".
- `lib/db/CLAUDE.md`: "Its closed kind set is `autosave`, `mcp`, `chat`, `blueprint-migration`,
  `fold-baseline`, and `project-move`. The first four carry …" becomes "Its closed kind set is `autosave`,
  `mcp`, `chat`, `publish-placement`, `blueprint-migration`, `fold-baseline`, and `project-move`. The first five
  carry …", with: "`publish-placement` is written only by
  `lib/deployment/placements.ts::recordPublishPlacements`, through the canonical kernel at an expected head, and
  holds only `holdPlacements` and no run; `nova_admit_app_change_insert` admits the kind set and that shape."
  "The browser collaboration wire accepts only `autosave | mcp | chat`;" becomes "… only `autosave | mcp | chat
  | publish-placement`;".
- `lib/collab/CLAUDE.md`: "The client frame admits exactly `autosave | mcp | chat`;" becomes "The client frame
  admits exactly `autosave | mcp | chat | publish-placement`; a `publish-placement` frame is always remote, so it
  folds like a peer's change, keeps undo, and sets its holds into the recorded holds;". The 409 bullet gains: "A 409 with `reason:
  "placement-recorded"` keeps the rejected human batches and, after the reload, hands them to the builder,
  which offers them again with their moves."
- `lib/deployment/CLAUDE.md`: "One publish lifecycle" gains "After preflight passes and before anything is
  sent, a publish records every placement its emission derives that the document does not hold, as one
  `publish-placement` change at the head it emitted; where the head moved it reads the head again and runs
  preflight again, three times at most. The pushed revision is that change's." A new section "Placements" states
  sections 5, 7 and 11 in present tense.
- `lib/db/types.ts`'s comment on the kinds (section 4.1).

**Pull request 8:**

- `lib/deployment/CLAUDE.md`: "Confirmations live in `app_deployment_confirmations`, four kinds (…)" becomes
  "… five kinds (`plan-feature`, `flat-location-fixture`, `connect-forwarder`, `form-entry-sync-off`,
  `commtrack-off`)"; the `plan-features` paragraph's list gains "and CommCare Supply turned off for an app with
  an advanced menu whose case list is its own menu item, or a form whose source text names the session's supply
  point (`planPrivileges.ts::commtrackReasons`)".
- `lib/commcare/CLAUDE.md`: the capability list sentence gains "links between cases of the same type" (part 01
  drops "attachments saved to cases" in pull request 2); a paragraph for `commtrackReasons` beside
  `formEntrySyncReasons`'; the probe paragraph gains "A flag the app needs off (`DONT_INDEX_SAME_CASETYPE`) is
  read the same way, inverted."
- `docs/research/2026-09-26-hq-round-trip/inventory/gates.md`: section 17's paragraph.

**Pull request 15** (part 10 places them):

- `docs/architecture/contracts.md`: "`app_changes` has its own exact envelope admission: the closed kind set is
  `autosave | mcp | chat | blueprint-migration | fold-baseline | project-move`. The first four carry a nonempty
  admitted mutation batch and null Project-move columns;" becomes "… the closed kind set is `autosave | mcp |
  chat | publish-placement | blueprint-migration | fold-baseline | project-move`. The first five carry a
  nonempty admitted mutation batch and null Project-move columns; `publish-placement` is written only by a
  publish, at the head it emitted and before anything reaches CommCare HQ, and holds only placement holds;".
- `docs/architecture/contracts.md`: "The browser collaboration frame is intentionally narrower: it accepts only
  `autosave | mcp | chat`." becomes "… it accepts only `autosave | mcp | chat | publish-placement`, which open
  tabs fold without a reload, keeping their undo history."
- `docs/architecture/contracts.md` gains, beside the identity-edit rules: "A case write's placement is held from
  the publish that first carries it. Only a publish records or replaces a held placement that can still express
  its write; an edit the held placement cannot express moves it, as an identity edit stated before it commits,
  and undoing that edit puts it back where the publish recorded it."
- `content/docs/publishing.mdx`, "What the project space's plan includes": "Three project-space settings are
  asked about the same way" becomes "Four project-space settings …", with a fourth bullet: "**CommCare Supply
  turned off**, for an app with an advanced menu whose case list is its own menu item, or a form whose text
  names the session's supply point. CommCare HQ adds steps to those where it's on, and only Dimagi Support can
  turn it off." A new subsection, "Where CommCare HQ keeps your case changes": "The first time Nova publishes a
  form, it records where CommCare HQ keeps each of its case changes, so publishing again keeps them there and
  your exports keep their columns. If a change you make can't stay there, Nova says what moves before it saves,
  and undoing the change puts it back. When a project space's plan doesn't include Save to Case, Nova offers to move the case changes that don't
  need it, and the move applies wherever the app is published."
- `content/docs/project-space-compatibility.mdx`: the catalog entry for links between cases of the same type
  (the attachments entry leaves with part 01's pull request 2).
- `content/docs/mcp/tools.mdx`: the `upload_app_to_hq` row gains section 16's sentences; the
  `withdraw_deployment_confirmation` row's `kind` list gains `commtrack-off`; the paragraph on what a project
  space's plan includes names `confirm_commtrack_off`.

**`../nova-plugin`** (part 07 owns the sweep): `skills/upload_to_hq` gains the placement offer, CommCare
Supply and the two refusal codes; its `plugin.json` bump rides that repository's pull request, merged after
Nova's deploy.

---

## 20. Tests

Each file, what it proves and the boundary it earns (`docs/testing.md`). Ordinary tests run without Docker;
`.postgres.test.ts` files run against real Postgres.

**Pull request 4**

- `lib/commcare/__tests__/projectSpaceCompatibility.test.ts` (pure, over documents built by
  `lib/__tests__/docHelpers.ts::buildDoc`): "asks for links to captured files where a child menu's calculated
  column reads its parent's link" (finding N1, asked nothing before); "asks nothing where that column reads
  another property of the parent"; "asks where a plain column of the write's own type shows it, whatever the
  write's placement"; "asks where a form label prints the link inside a markdown link"; "asks where a label
  prints a hidden field that reads the parent's link"; "asks nothing where a label prints another property".
  The failure caught: a link a worker opens in a project space that never let them.

**Pull request 5**

- `lib/doc/__tests__/holdPlacements.test.ts` (pure, production admission and reducer through
  `prepareMutationCandidate`): "sets, replaces and clears each target's held slot"; "refuses a hold whose form,
  operation, field or module is missing"; "refuses a query repeat target that is not a query repeat"; "refuses
  one target named twice in one mutation". Boundary: the state model.
- `lib/doc/__tests__/placementSlotsWrittenOnlyByHolds.test.ts` (pure, admission): "refuses a held slot written
  by any other mutation", one case per payload of section 2.4; "a duplicated form, field and operation start
  unheld". The failure caught: a second door to a hold that the kernel rule would have to guess about.
- `lib/doc/__tests__/diffDocsToMutations.placementHolds.test.ts` (pure): "emits one trailing holdPlacements for
  every hold that differs"; "emits nothing for a hold removed with its owner"; "replays a created and held
  operation exactly".
- `lib/doc/__tests__/placementHolds.test.ts` (new, pure): `readPlacementHolds` lists every held slot in
  document order under its `placementTargetKey`; `holdExpresses` answers, for each target kind, exactly what
  its owner's predicate answers (section 3's table), so the kernel and the gate cannot disagree about what
  "can express" means.
- `lib/db/__tests__/placementAuthority.test.ts` (pure, over built documents): one case per rule of section 3
  ("admits any change under publish-placement and blueprint-migration", "skips a target removed with its owner",
  "refuses a hold an editor gains that no recording wrote", "refuses an editor replacing a hold that can still
  express its target", "admits an editor moving a hold its edit made inexpressible", "admits an editor
  restoring the recorded hold after a move", "admits an editor re-creating a removed target with its recorded
  hold", "refuses an editor restoring a hold the latest recording did not write", one per target kind);
  `placementChangesToJustify` names exactly the keys rules 1 to 4 leave undecided; and on every case, this
  part's `lib/doc/placementHolds.ts::admittedHoldChanges` keeps exactly the hold changes the rule admits, so the
  tab and the kernel cannot disagree. Part 07's `identityMoves.test.ts` and `historyStep.test.ts` (its
  section 9) hold the history steps that read it.
- `lib/db/__tests__/placementRecords.postgres.test.ts` (new, real Postgres): the newest recording row above
  the greatest fold baseline wins; a row at or below that baseline is not read; the baseline snapshot answers
  a key no row names; a row that cleared a target leaves it absent; editor rows (`autosave`, `mcp`, `chat`)
  never count; an empty key list issues no query; the tables are read schema-qualified.
- `lib/db/__tests__/commitGuardedBatch.postgres.test.ts` (existing, real Postgres): "refuses an autosave that
  gains a hold, writing nothing"; "refuses an autosave that replaces an expressible hold"; "admits an autosave
  that moves a hold its edit made inexpressible"; "admits an autosave restoring the hold the greatest fold
  baseline's snapshot holds"; "admits an autosave re-creating a removed held operation with its recorded
  hold"; "refuses an autosave restoring an editor's earlier move"; "admits a synthetic migration that gains a
  hold". The kernel is the boundary a forged PUT meets.
- `lib/db/__tests__/projectMembership.postgres.test.ts` (existing, the `resolveAuthorizedAppSnapshot` suite):
  "the snapshot carries the recorded hold of every held target, and reads no fold baseline for an app that
  holds nothing".
- `lib/collab/__tests__/appReadSnapshot.test.ts` (existing): "parses recordedHolds and refuses a malformed
  entry".

**Pull request 6**

- `lib/case-store/migrations/__tests__/publishPlacementKind.postgres.test.ts` (new, a database from the
  migration prefix): before the migration a `publish-placement` insert is refused by the trigger; after it, a
  nonempty `holdPlacements` row is admitted, and an empty one, one holding another mutation kind, one with a
  `run_id`, and an unknown kind are refused; every earlier kind is admitted as before. The function is read as
  `'public.nova_admit_app_change_insert()'::regprocedure`, never by bare name. The test first creates a decoy
  schema `nova_app_test_decoy` holding a same-named function and table, runs `VACUUM FULL pg_proc` and
  `SET enable_indexscan = off` so a by-name catalog scan would meet the decoy first, and asserts the decoy is
  unchanged afterward. The failure caught: a migration or test that resolves a catalog object by name alone.
- `lib/db/__tests__/publishPlacementCommit.postgres.test.ts` (new): "a publish-placement commit at the head
  writes the row, the entities, the NOTIFY and the folded document"; "at a moved head it throws AppHeadMovedError
  and writes nothing"; "a publish-placement batch holding another mutation throws"; "a gate refusal carries its
  finding codes".
- `lib/db/__tests__/persistedJson.test.ts` (existing): "parses a publish-placement row"; "refuses one holding
  another mutation or a run".
- `lib/collab/__tests__/mutationFrame.test.ts` (existing): "admits a publish-placement frame".
- `app/api/apps/[id]/stream/__tests__/stream.postgres.test.ts` (existing): "delivers a publish-placement row in
  the suffix as a frame, not a reload".
- `lib/collab/__tests__/reconciler.test.ts` (existing, the reconciler's state machine): "folds a
  publish-placement frame from the tab's own user as remote, re-folding pending work and keeping undo"; "a
  publish-placement frame sets its holds into the recorded holds"; "a placement-recorded 409 hands the
  rejected human batches and queued commands to onPlacementConflict after the reload"; "drops the replay when
  the reload ends view-only"; "any other 409 behaves as before".
- `lib/collab/__tests__/ReconcilerProvider.test.ts` (existing): "maps a 409 with reason placement-recorded to
  the typed outcome"; "a holdPlacements frame does not refetch case data".
- `app/api/apps/[id]/__tests__/route.test.ts` (existing): "answers a held-placement refusal and a placement
  rule refusal with reason placement-recorded, and any other with none".
- `lib/commcare/__tests__/heldPlacementEmission.test.ts` (new, property over `xformDocArbitrary.ts`): "emits the
  same HQ body and .ccz bytes but for the version with placementsToHold applied". The invariant decision 7 rests
  on.
- `lib/deployment/__tests__/placementMoves.test.ts` (new, pure): `placementsToHold` with nothing, some and all
  held; `placementMoveOffer("save-to-case")` all or nothing, refusing an unheld target, a kind change and a
  same-type basic subcase; the digest stable under an unrelated edit and changed by a move.
- `lib/commcare/hq/__tests__/publishedCaseBlocks.test.ts` (new, pure over real HQ reads in
  `proof/hq-reads/publish/` and HQ's own subcase fixtures `multiple_subcase_repeat.xml` and
  `subcase-repeat.xml`): each block path and kind; forms keyed by `xmlns`, not position; an override `xmlns`;
  a model-iteration row; a malformed source skipped. HQ's reads are the boundary: a reader proven only on
  Nova's own output would prove nothing about HQ's.
- `lib/deployment/__tests__/publishSequence.postgres.test.ts` (existing, real Postgres and an HTTP peer): "a
  first publish records its placements before the shell create, with nothing sent at the record";
  "pushed_revision and the manifest's sequence are the record's"; "an autosave restoring the hold the publish
  recorded is admitted after the publish"; "a head moved once reads the head again,
  preflights and sends"; "a head moved three times refuses app_changed_while_publishing with nothing sent";
  "a version-floor stop keeps the holds"; "an accepted Save to Case offer records, drops the need and lands in
  one request"; "a stale digest refuses hq_placement_moves_changed with the current offer"; "a retry naming an
  offer already recorded goes on".
- `lib/mcp/__tests__/uploadAppToHq.postgres.test.ts` (existing): the refusal's `placement_moves`, `placements`
  on every answer, the two tags.
- `lib/mcp/__tests__/servedSchemas.test.ts` (existing): `accept_placement_moves` and the descriptions.
- `components/builder/__tests__/publishOutcome.test.ts` (existing): reads `placementMoves` and `placements`.
- `e2e/tests/multiplayer/multiplayer.spec.ts` (existing, Playwright): "a publish's placements fold into open
  tabs and offer a stranded edit again": tabs A and B open one app with an unheld operation; B goes offline
  (`context.setOffline(true)`) and makes an edit the basic slot cannot express; the test records the publish's
  placements through `recordPublishPlacements` against the local database; A folds the frame without a reload
  and undoes an earlier step; B comes back online, its save meets the 409, and the `IdentityMoveDialog` opens
  with the publish lead; **Make the change** commits the edit with its move; undoing it in B puts the
  operation back at the place the publish recorded. The only boundary that proves a browser tab folds the
  frame, offers the edit again and undoes it to the recorded place.
- `e2e/tests/browser/publishing.spec.ts` (existing): "offers to move Save to Case changes and publishes once
  the person ticks Move them and publish".

**Pull request 7**

- `lib/doc/__tests__/holdPlacements.test.ts` and `lib/db/__tests__/placementAuthority.test.ts` gain the
  `module-kind` cases; `lib/deployment/__tests__/placementMoves.test.ts` gains "holds a module made advanced".

**Pull request 8**

- `lib/case-store/migrations/__tests__/commtrackConfirmation.postgres.test.ts` (new, step 4's
  `formEntrySyncConfirmation.postgres.test.ts` shape, `checkConstraintVerdicts` over
  `'public.app_deployment_confirmations'::regclass`, with the decoy and heap order above): the previous
  revision's rows pass; `commtrack-off` with its own subject passes; with another subject it is refused.
- `lib/commcare/__tests__/planPrivileges.test.ts` (existing): `commtrackReasons` over an advanced module with
  and without its menu item (a formless module whose kind is held advanced, the shape that holds a menu item
  before pull request 10), a label and a literal holding the text, and a label holding a near miss.
- `lib/commcare/xform/__tests__/supplyPointText.test.ts` (new, pure): the text in an attribute and in a text
  node, decoded from `&apos;`, is found; a split or near text is not.
- `lib/commcare/__tests__/projectSpaceCompatibilityProbe.test.ts` (existing, an HTTP peer): "reads an off flag
  inverted: listed is missing, absent is available, an unreadable list is unverified".
- `lib/deployment/__tests__/publishGates.postgres.test.ts` (existing): "asks commtrack-off, stores it once a
  publish passes, and withdraws it"; "refuses a same-type basic child where the flag is on, with the offer";
  "passes where it is off"; "offers the move where the list cannot be read"; "an accepted same-type offer
  records, then asks Save to Case where it is not confirmed".
- `lib/deployment/__tests__/placementMoves.test.ts` gains the `same-type-child-links` offer, with a later basic
  subcase renumbered by the move.
- `components/builder/app-setup/__tests__/publishingSectionModel.test.ts` (existing): the `commtrack-off`
  request in its order.
- `lib/publish/__tests__/manualImportGuide.test.ts` (existing): the two steps where their inputs hold, and the
  same-type capability absent from the capabilities step.
- `lib/mcp/__tests__/{uploadAppToHq,deploymentTools,compatibility}.postgres.test.ts` (existing):
  `confirm_commtrack_off`, the withdraw kind, `commtrack_off` in the check.
- `lib/commcare/__tests__/projectSpaceCompatibility.test.ts` (existing): `sameTypeChildReasons` names a
  registration's and a follow-up's same-type child with the two sentences of section 16.
- `proof/targeted/__tests__/publishChecks.test.ts` (new) and `unproducedInputs.test.ts` (section 17).
- `e2e/tests/browser/publishing.spec.ts` (existing): "asks whether CommCare Supply is off for a form whose label
  names the session's supply point".

**Pull request 10**

- `lib/commcare/__tests__/planPrivileges.test.ts` gains the advanced module whose case list menu item stands
  beside its forms, read through part 05's `moduleHasCaseListMenuItem`.
- `e2e/tests/browser/publishing.spec.ts` gains "asks whether CommCare Supply is off for an advanced menu whose
  case list is its own menu item".

---

## Departures

From the outline (`5-case-writes-forms-navigation.md` at `2f985ed6`), the research and the owner brief:

- **`holdPlacements` and its kernel rule land in pull request 5, not 6.** The stack table puts this part in
  pull requests 6 and 8, but part 01's identity moves in pull request 5 write holds through this mutation
  (decision 4), and the rule has to guard the mutation from its first commit. The plan's decisions place them
  there; the held slots land earlier, with the concepts they hold (pull requests 3 and 4), and the module kind
  target joins in pull request 7 with its slot.
- **The `VIEW_FORM_ATTACHMENT` rebase lands in pull request 4**, where a link write becomes an operation's
  write: the model change forces it, so it rides that pull request.
- **Undo restores a hold only to what was recorded.** Part 01's brief let any undo inverse carry the hold back;
  the owner brief's kernel rule refused every replacement of an expressible hold, so undo would have kept the
  moved place. The rule gains arm (b), which admits exactly the restore of the hold the target's latest
  recording wrote, so undoing a move or a removal puts the published place back, and nothing else an editor
  writes can replace a hold. The tab learns the recordings with its document (section 6.3).
- **The placement conflict is offered again, not only toasted.** The owner brief showed the server's sentence in
  today's toast; decision 3 puts the publish lead in the one `IdentityMoveDialog`, so the reconciler keeps the
  rejected batches and the builder offers them with their moves, with a typed 409 reason instead of prose. The
  toast stays only where nothing can be offered.
- **The recorded document is what the publish sends.** The owner brief kept `prepared` as preflight built it;
  this part swaps in the recorded document and sequence, so the HQ body, the pushed revision and the deep-link
  manifest name one document.
- **The database admission checks the new kind's shape** (only `holdPlacements`, no run), beyond the closed
  kind set the owner brief changed.
- **Migration names follow decision 11** (`20261110000000_…_publish_placement`,
  `20261110010000_…_commtrack_confirmation`), not the owner brief's `20261201…` stamps.
- **`placements` on the outcome**, not `movedPlacements` on the refusal: a landed publish records too, and MCP
  reports both.
- **The Save to Case offer never changes a module's kind** and refuses an unheld Save to Case target, beyond the
  owner brief's all-or-nothing rule; it keeps the brief's same-type exclusion, a departure from the research's
  "which publish offers where a basic slot can express them".
- **The same-type offer is attached to an `unverified` capability too**: the move resolves it whatever the flag.
- **A baseline whose bytes fail is the blocker `baseline-unreadable`** (section 12): part 09's brief read it as
  carrying nothing, and this part's first reading took it as unread. It claims a read Nova made, so its failure
  is damage a refresh repairs, and production holds none.
- **Gated run G1 has three outcomes and G3 two**, merging the proof brief's G4 outcome B into G1 and folding
  the user-level concern of the owner brief's G3 into `domainFeatureFlag`'s existing guard.
- **The import file gives the same-type capability its own step**, out of the capabilities step whose remedy
  is the opposite.
- **Names reconciled**: the flag id is `same-type-links-dropped` (part 01's brief said
  `same-type-child-index`); the offer reason type is `PlacementOfferReason`, apart from part 01's
  `PlacementMoveReason`; the baseline reader is `publishedCaseBlocks` (part 09's brief said
  `baselineCaseBlocks`); the lane verdict key is `commtrackEnabled` (decision 7); targeted documents take part
  08's names (`targeted-held-placement`, `targeted-commtrack-advanced`); the placement schemas and predicates
  are part 01's (`casePlacementSchema`, `ownClosePlacementSchema`, `placementExpresses`,
  `placementCandidates`); the module kind's are part 02's (`emittedModuleKind`, `heldKindExpresses`,
  `advancedModulesWithCaseListMenuItem`); `sameTypeBasicChildCases` is part 01's, which this part reads; the
  conflict handler is part 07's `components/builder/placementConflictReplay.ts::replayAfterPlacementConflict`
  over its pure `lib/doc/identityMoves.ts::planConflictReplay` (no builder host; the handler has no test
  of its own), the client half of section 3's arms is this part's
  `lib/doc/placementHolds.ts::admittedHoldChanges` (pull request 5), and the recorded holds are `recordedHolds` in the read
  snapshot and in the store.
- **Ordering guards**: a basic subcase of a module's own type is first emitted in pull request 8 with its
  check, and the case list menu item of an advanced module beside its forms in pull request 10, where
  `Module.caseListMenuItem` is admitted beside forms; pull request 8's CommCare Supply confirmation reads the
  menu item wherever a module holds one, with a Vitest witness until pull request 10's lane witness. So no
  pull request's lane accepts a build difference its verdict does not know.

- **`toggle/SAVE_ONLY_EDITED_FORM_FIELDS` keeps `preflight.kind: "precondition"`** with the cell
  "flag probe; save-only-edited-answers", not `{kind: "capability"}`:
  `lib/commcare/surface/schema.ts::gatePreflightSchema` admits none, precondition, confirmation and
  refusal, every other probed flag is a precondition, and `surface/__tests__/gates.test.ts`'s
  flag-probe check covers precondition gates only. Its content cell reads HELD.
- **`proof/hq/test_flag_probe.py`'s user-alone test runs under
  `override_settings(DISABLE_RANDOM_TOGGLES=False)`**: HQ's `settings.py` sets
  `DISABLE_RANDOM_TOGGLES = UNIT_TESTING`, and `corehq/toggles/__init__.py::PredictablyRandomToggle.enabled`
  (which `FeatureRelease` inherits) returns False under it before reading stored state, so the first
  `FeatureRelease` the probe asks would read off in the harness while production reads it on.
- **`linkWriteDestinations` lists each destination once** and reads the operation's case type as
  `retype ?? operationCaseType`, as `lib/domain/caseWriteViews.ts` does.

From pull request 5's implementation:

- **`placementTargetKey` lives in `lib/doc/types.ts`** and `lib/doc/placementHolds.ts` re-exports it: the
  mutation's own `superRefine` reads it, and `placementHolds.ts` imports `commitVerdicts.ts`, which imports
  `types.ts`, so declaring it in `placementHolds.ts` would make `types.ts` part of an import cycle.
- **The kernel rule's per-change decision is exported from `lib/doc/placementHolds.ts`**
  (`placementHoldChanges` for rules 2 and 3, `holdChangeMoves` for arm (a), `holdChangeRestores` for arm (b),
  `holdChangeAdmitted`), so `lib/db/placementAuthority.ts` and `admittedHoldChanges` read one answer. Arm (b)
  admits only a held value: where no recording names a target, clearing its hold is no restore (the rule's
  literal reading, "`next` holds exactly the hold `recorded` gives").
- **`admittedHoldChanges` judges each entry on the candidate of the batch as kept**, and judges again after
  any drop, so every entry it keeps is admitted over the document the returned batch makes; a batch target
  admission refuses with its content is returned whole for the gate to refuse.
- **Target admission also refuses one target held by two `holdPlacements` of one batch** (part 01 §13.1's
  "two entries for one target in a batch"), beside the schema's refusal within one mutation.
- **`updateField` naming `placement` gets a sentence** in `types.ts::reportHeldPlacementInPayload`, as the
  form and operation payloads already did, instead of Zod's "Unrecognized key".
- **No form or operation duplicate planner exists at the base**: the only duplicate is
  `duplicateFieldMutations`, so section 2.4's test covers a duplicated field; a form or an operation is new
  only through `addForm` and `caseOperationChange` add, whose payloads the same test refuses with a hold.
- **`holdPlacements` takes no reference-index carriers, claims no identity, moves no sequence, and leaves
  Preview's case-write projection alone** (`store.ts::affectsCaseWriteProjection` answers `false`): a hold
  changes where HQ keeps a write, not what is written.
- **`biome.json`'s `lib/commcare` allowlist gains only `lib/doc/placementMoves.ts`, `lib/doc/identityMoves.ts`
  and `lib/doc/placementHolds.ts`.** `lib/db/placementAuthority.ts` reads only `lib/doc/placementHolds` and
  `lib/domain`, and `lib/doc/queryRepeatPlacement.ts` only `lib/doc` and `lib/domain`, so neither is listed
  and the emission boundary stays as narrow as the code needs (part 10 §2 named `placementAuthority.ts`).
- **In pull request 5 a recording is a `blueprint-migration` row or the greatest fold baseline's snapshot.**
  The `publish-placement` kind lands in pull request 6 (`lib/db/types.ts`'s kind set at the base has no such
  kind), so `lib/db/placementAuthority.ts::PLACEMENT_RECORDING_KINDS` is `["blueprint-migration"]` and
  `placementRecords.ts::readRecordedPlacementHolds` reads those rows above the greatest fold baseline and that
  baseline's snapshot; pull request 6 adds `publish-placement` to the list. Section 19's pull request 5
  sentences were written to match: `lib/db/CLAUDE.md`'s rule reads "a migration may change any hold" and names
  "the latest `blueprint-migration` row that names it, else the greatest fold baseline's snapshot", and
  `lib/doc/CLAUDE.md`'s `holdPlacements` sentence names no `publish-placement`. Pull request 6 restores the
  publish arm in both, beside its kind-set sentences.
- **`lib/doc/CLAUDE.md`'s `holdPlacements` sentence omits "a module's `heldKind`"**: `Module.heldKind` and
  its target land with part 02 in pull request 7 (`lib/doc/placementHolds.ts::PlacementTarget` holds the case
  operation, the own close and the query repeat only), so pull request 7 adds the menu to the sentence.

From pull request 6's implementation:

- **`PLACEMENT_CONFLICT_CODES` also holds `CASE_PLACEMENT_SHARED`** (section 2.2 names
  `HELD_PLACEMENT_INEXPRESSIBLE` and `QUERY_REPEAT_MODEL_ITERATION_SHAPE`; part 07 §2.6 reads "its part 01
  siblings"). A publish's recording alone turns a stale edit's hold change into it:
  `lib/doc/__tests__/placementHolds.test.ts` ("PLACEMENT_CONFLICT_CODES") restores two held subcases (the
  undo of removing the first) over a head where a publish recorded a peer's new child at the second place,
  the first free one on the head it published. The gate refuses that with `HELD_PLACEMENT_INEXPRESSIBLE` and
  `CASE_PLACEMENT_SHARED` together (`lib/commcare/placement.ts::placementIneligibility`'s claimed subcase
  index, `lib/commcare/validator/rules/casePlacement.ts::sharedFindings`), and admits it over the same head
  before the recording. Without the second code the route's "every code" test fails and the edit is lost to
  today's toast. `HELD_BLOCK_PATH_TAKEN` stays out: a publish can raise it too (a stale edit adds a question
  named as a segment the publish then records; `xform/generatedNodes.ts::planGeneratedNodes` steps an unheld
  name around an authored one but never moves a held segment, `casePlacement.ts::blockPathFindings`), but it
  names an authored name, which only a rename resolves. No move does, so `withIdentityMoves` plans none,
  and the `placement-recorded` lead ("your change now moves them") would be false. It keeps today's
  conflict.
- **The tab advances its recorded holds through `lib/doc/store.ts::recordPlacementHolds(holds)`** (section
  6.1's "sets each into the tab's recorded holds"): an entry holding a placement becomes its target's
  recorded hold and a clearing entry removes the target from the record, so the merge has one home and the
  reconciler hands it the frame's entries. `queuedCommandMutations()` returns the queue's mutations
  flattened in the order they were made, without clearing it. Both are tested in
  `lib/doc/__tests__/store.test.ts`.
- **The decoy test rewrites the public function's catalog tuple to put the decoy first.** Section 20 has the
  test create the decoy and run `VACUUM FULL pg_proc` "so a by-name catalog scan would meet the decoy first",
  but the decoy is created after the template's migrations, so its `pg_proc` tuple lies after the public
  function's, and `VACUUM FULL` keeps live tuples in heap order. So
  `lib/case-store/migrations/__tests__/publishPlacementKind.postgres.test.ts` runs `VACUUM FULL pg_proc`, then
  `ALTER FUNCTION public.nova_admit_app_change_insert() SET search_path = pg_catalog` (the setting it already
  holds), whose new tuple version lands after every packed tuple; it turns off index, index-only and bitmap
  scans, puts `nova_app_test_decoy` first on the search path, and checks the order a sequential scan meets
  before and after `up`, failing as a harness defect where the decoy is not first. Not yet run: it needs the
  Docker Postgres, so its first run is CI's.
- **The kernel's publish-placement shape check runs before the candidate is prepared**, not between
  `prepareMutationCandidate` and the placement rule as section 3's listing places it: a batch the invariant
  refuses is never reduced, and the check is still before the placement rule. The head fence runs right after
  the latch read and before the dedup return, so a retried batch at a moved head throws `AppHeadMovedError`
  rather than answering with a head the record was not made at; `recordPublishPlacements` mints a batch id per
  attempt, so no caller retries one.
- **`lib/db/__tests__/admittedWriterTestHelpers.ts::CommitGuardedBatchProposalArgs` omits `mutations` from
  each arm of the request**: `CanonicalCommitRequest` is now a union, and `Omit` over a union keeps only the
  keys common to both arms, which no arm accepts back. `heldPlacementApp.ts::appendChangeRow` takes
  `publish-placement` too, as a raw recording row with no run.
- **`placementsToHold` records no hold for a field-written child kept as HQ's inert subcase** (section 5.1;
  part 02 section 14.4's interim, an extension child or a child of a several-case form, where
  `lib/domain/basicCaseSlots.ts::PlannedBasicSubcase.inSource` holds). Its placement reads
  `{save-to-case, path: ["nova_subcases", "nova_subcase_<n>"]}` while the create also keeps its `subcases`
  entry, and no one hold expresses both: holding that path makes `basicCaseSlots` keep the held block and
  take the create out of `subcases`, which renumbers every later subcase and changes the HQ body
  (`heldPlacementEmission.test.ts` failed on `case-extension-registration` before the exclusion). Section
  5.1 already says no publish runs on that interim, since pull request 7 removes it in the same deploy.
- **`heldPlacementEmission.test.ts` holds the invariant over two corpora**, the xform fuzz arbitrary and
  `lib/commcare/__tests__/emissionFixtures.ts`. The fuzz arbitrary places every case change in a Case
  Management slot and draws no Save to Case placement (60 runs: own slots, subcase rows and query repeats
  only), so section 5.1's property that `planPlacements` returns the exact Save to Case path the emitter
  writes is proven over the admitted emission fixtures, whose case operation, capture and extension
  documents give derived Save to Case paths and own closes in blocks of their own. It holds there with no
  change to `placement.ts`. The test copies each fixture document first:
  `noMatchesWireFixture("multiple-home")` edits its document after `admitNoMatchesDoc` has read it, so the
  per-document plan memos it hands over describe a single-case menu.
- **`publishedCaseBlocks` follows HQ's `_create_casexml` for the own block, not section 11's shorter
  sentence.** HQ writes the own `case` block wherever an action of the form is active, the form requires or
  opens a case, and default case management is on (`bind_case_id` makes the block non-empty), so a
  follow-up whose only active action is a subcase or the worker's record has one too; subcases, an update and
  a close are read only under default case management, which a menu that selects several cases turns off
  unless the form opens a case. `properties` holds HQ's own keys (`name` for the case's name, `external_id`)
  and HQ's question paths as stored; block paths and `repeatContext` are relative data paths. A form whose
  blocks hang on what the source does not say is left out: a data registry case load
  (`supports_data_registry` is a project-space privilege), an advanced form under an enabled visit schedule,
  a shadow form, and two forms sharing an `xmlns`.
- **Advanced blocks are proven over HQ's own advanced fixtures only**: no retained HQ read holds an advanced
  form with actions (`proof/hq-reads/hq-built` holds two with none, which the test reads as writing no
  block). `lib/commcare/hq/__tests__/fixtures/` holds HQ's app sources, stored XForms and the XForms its build
  makes of them at the `commcare-hq` pin, and the test requires every block the reader finds to stand in
  HQ's build at its path. `biome.json` excludes that folder, so the copies stay HQ's bytes.
- **An offer's holds are `holdPlacements` entries, not only `PlacementHold`s, and `recordPublishPlacements`
  takes entries** (sections 5.2, 7.1). An own close is in `S` where it has a Save to Case block of its own,
  and `ownClosePlacementSchema` holds only a Save to Case block: in Case Management the close shares the own
  case's block (`PlannedPlacement.sharesWith`) and has no slot to hold, so moving it clears its hold. The
  offer's entry for it is `{ target: "own-close", formUuid, placement: null }`, and the digest's third
  element is `null` there. Every hold `placementsToHold` returns still holds a value.
- **The `save-to-case` offer has no module-kind clause** (section 7.2, rule 3). `emittedModuleKind` lands with
  part 02's advanced modules in pull request 7, and until then every module is basic, so no move can change
  a module's kind. Pull request 7 adds the clause with the function.
- **`placementMoveOffer(doc, "same-type-child-links")` is `null` in pull request 6.** The parameter keeps the
  whole `PlacementOfferReason` so `acceptPlacementMovesSchema` stays total over both reasons; an acceptance
  naming the same-type reason meets a `null` offer and goes on, as a retry does. Pull request 8 gives the arm
  its offer.
- **An offer is `null` where a forced move is not a case change in Case Management.** Section 7.1 lists every
  hold `withIdentityMoves` appends as a move; where one would be a query repeat's (no case change to name) or a
  Save to Case block (the publish would still need Save to Case), the offer is `null`, as rule 3's all or
  nothing reads.
- **`saveToCaseWhereMissing(false, forms)` agrees with one form** ("Visit makes case changes only Save to Case
  can hold"), and names the forms through `placementMoves.ts::saveToCaseFormNames`, the forms
  `planPrivileges.ts`'s `save_to_case` rule asks about (a Save to Case placement whose block the source
  writes). `confirmationChecks` takes the offer as a third argument and sets `placement_moves` only while the
  Save to Case row needs confirming, so the pre-publish check and the refusal read one rule
  (`confirmations.ts::asksSaveToCase`).
- **Root `CLAUDE.md`'s mental model 3 names no advanced menu yet** (10-stack-contracts section 7.2): pull
  request 6 records case changes and query repeats only, and pull request 7 adds "and which menus it holds as
  advanced" with the module-kind hold. The `lib/deployment` map row reads the same way.
- **`publishFixtures.ts::reloadHeadFor` loads `lib/db/appAccess` on its first call**, so
  `proof/hq/publishCaptureDocuments.ts`, which builds its documents from the same file and reads no database,
  never loads the database modules.
- **`PLACEMENT_CONFLICT_CODES` was already at the base**: pull request 5 put it in
  `lib/doc/placementHolds.ts` with `HELD_PLACEMENT_INEXPRESSIBLE` and `QUERY_REPEAT_MODEL_ITERATION_SHAPE`
  (at `7b7ba964`), with `setRecordedPlacementHolds`, `appPlacements`, `effectiveQueryRepeatPlacement` and
  `sameTypeBasicChildCases`. Pull request 6 adds no second set: the PUT route
  (`app/api/apps/[id]/route.ts`) reads that one, and the only change to it is the sibling decision in the
  first entry of this list (`CASE_PLACEMENT_SHARED` in, `HELD_BLOCK_PATH_TAKEN` out).
- **The proof lane's capture computes its record rather than reading one a writer committed.** In Nova the
  record is what `recordPublishPlacements` commits after preflight (section 5.4), but
  `proof/corpus/publish.ts::capturePublish` rebuilds the publish against the HQ peer rather than calling
  `publishAppToHq`, and writes no `app_changes` row. So it computes section 17's `placementsToHold(D)` as
  `proof/corpus/editBatches.ts::firstPublishRecord(D)` (one `holdPlacements`, or none), prepares D as stored
  before the publish, applies the record through Nova's commit gate (`recordedDocument`, the whole gate
  rather than section 17's reducer alone, so a record the gate would refuse stops the capture), prepares and
  sends the document that leaves, and returns the record as `PublishCapture.placements` (and
  `RepublishCapture.placements` over a retained A). `proof/corpus/emitCorpus.ts` applies the same pure
  record to D before it plans D′ (`afterFirstPublish`), so the capture and the emitter cannot read two
  records.
- **The footprint test's `holdPlacements` exemption is gone.** At the base no producer or workforce document
  held a placement, so `proof/corpus/__tests__/footprint.test.ts` expected the census to miss
  `holdPlacements` and left it to `targeted-held-placement`. Each fixed document is now edited as stored
  after its first publish (`editBatches.ts::afterFirstPublish`), which holds the Case Management slots its
  case changes take, so the kind's generator has a move to make: the census expects no missing kind, and the
  workforce-free census expects only the five removal kinds.
- **The multiplayer scenario holds Grace's save on its way rather than taking her tab offline** (section 20
  names `context.setOffline(true)`). An offline save is a network failure, which the reconciler reports
  (`lib/collab/reconciler.ts`'s `onSaveError` on an `autosave-put` network failure, sent by
  `ReconcilerProvider.tsx` through `lib/clientErrorReporter.ts::reportClientError`), and the strict error
  guard fails any page that attempts a client report (`e2e/lib/errorGuard.ts`). So
  `e2e/tests/multiplayer/multiplayer.spec.ts` routes her first save after the edit and lets it go only after
  the publish recorded and Ada undid: the edit is composed before the record and reaches the server after it,
  the race of section 6.2, with no report. Her stream stays up, so her tab folds the record before its save
  is refused, as a tab that reconnects first does.
- **The scenario records the placements in a child process.** `recordPublishPlacements` is server-only
  (`lib/deployment/placements.ts` imports `server-only`, whose default export throws outside the
  `react-server` condition), and Playwright loads specs under plain Node. `e2e/lib/recordPublishPlacements.ts`
  runs under `tsx --conditions=react-server`, as `e2e/seed.ts` does: it reads the head under an `edit` check,
  as the upload route's `reloadHead` does, takes `placementsToHold` of it and records at that head. It
  refuses without `NOVA_DB_LOCAL_URL`.
- **The multiplayer scenario signs in with the seeded session cookies, not `GET /api/dev/login`.** The suite
  runs the production build, where that route 404s (`app/api/dev/login/route.ts` outside
  `NODE_ENV=development`), and every multiplayer scenario opens its members from the storage states
  `e2e/lib/multiplayerSeed.ts` writes (`e2e/CLAUDE.md`). That seed gains the scenario's case app in each
  scenario's Project: a follow-up form whose one write saves `village` as it is, its own case change unheld.
- **The publishing component test's offer is the refusal's body**, as every refusal in
  `e2e/tests/browser/publishing.spec.ts` is: the peer starts no Nova server, so the offer is built from
  `lib/publish/placementMoves.ts`'s sentences for one held Save to Case create a basic slot expresses, and
  `lib/deployment/__tests__/placementMoves.test.ts` holds its derivation. The spec's other refusals gain
  `placementMoves: null`, which `DeploymentAttemptRefusal` now requires.
- **The builder registers its replay through the reconciler's context**, not as a prop of
  `ReconcilerProvider`: `BuilderProvider` mounts the provider above `BuilderLayout`, and the handler needs hooks
  inside that subtree, so `lib/collab/context.ts` gains an optional `registerPlacementConflictHandler` (latest
  registration wins; its cleanup clears only its own), which `ReconcilerProvider` always supplies and a leaf
  `BuilderLayout` renders registers.
- **MCP serves the offer in one shape on both tools.** `check_project_space_compatibility` returns
  `placement_moves` as `upload_app_to_hq`'s refusal does, `{reason, digest, moves: [{form, change, sentence}]}`,
  so what a client sees in the check is what `accept_placement_moves` answers; the browser route keeps the raw
  view the dialog reads. `app_not_ready` is built as an `invalid_input` answer carrying `placements` rather than
  thrown, because a publish can record holds before a later stop; the gates before the publish carry
  `placements {0, 0}` and `placement_moves: null`.
- **The pre-publish check's offer stands only while Save to Case needs confirming, on every surface.**
  `components/builder/app-setup/publishingSectionModel.ts::withLandedConfirmations` drops `placement_moves`
  once the landed publish recorded the Save to Case confirmation, as `confirmations.ts::confirmationChecks`
  does, and `PublishPanel` reads the check's `placement_moves`. `PublishPlacements` lives in
  `lib/deployment/types.ts`, so the client's `publishOutcome.ts` reads it without naming the server-only
  `service.ts`.
- **The commit request's test helpers distribute over its arms.** `admittedWriterTestHelpers.ts::Unadmitted`
  omits `mutations` from each arm separately, and the three Postgres suites that wrapped `commitGuardedBatch`
  with an inline `Omit` read it, because an `Omit` over the union merges the two arms' `kind`.
- **A reload keeps what the tab knew of a target its document no longer holds.** Section 6.3 has the
  reconciler replace the recorded holds whole on every reload, on the reading that a history step restores
  only what the session changed. A placement conflict's replay (pull request 6) outlives the reload that
  clears history: an undo that re-creates a held change the session removed earlier, turned away by a
  publish's recording, is handed back over a document that no longer holds the change, so the reload reads
  no recording of it and `planConflictReplay` dropped the restore the commit kernel admits, giving the
  re-created change a newly planned place with no stated move. `lib/collab/reconciler.ts::reloadedRecordedHolds`
  replaces what the tab knew of every target the reloaded document holds and keeps the rest, because a
  publish and a migration record only targets their document holds, so the latest recording of a target the
  document does not hold is still the one the tab read. A fold baseline written since then answers for every
  target its snapshot does not hold; a restore planned from a kept entry there is refused by the kernel,
  which reads the baseline, rather than placed silently. The snapshot read is unchanged: an app that holds
  nothing still reads nothing more. `lib/collab/__tests__/reconciler.test.ts` holds both halves.
- **The no-matches fixture makes a new document for each edit.** `noMatchesWireFixture`'s `home` and
  `multiple-home` scenarios edited the document `noMatchesDoc` had already planned, and every plan is memoized
  per document object, so an in-process reader of `emissionFixtures()` was handed plans of the document before
  the edit. Each edit now spreads a new document; the corpus emitted with `--jobs 2` before and after the
  change is identical byte for byte (410 documents), and `heldPlacementEmission.test.ts` reads the fixture's
  document without a copy.
- **Rule 3's kind clause never decides an offer** (section 7.2, pull request 7). `saveToCaseOffer`
  (`lib/deployment/placementMoves.ts`) compares `emittedModuleKind` over `D'` and `doc` for every menu
  and returns `null` where one differs, as rule 3 states, but no admitted document reaches that
  branch: clearing case-change holds cannot change a menu's kind. A held kind is not a case-change
  hold and stays. What makes an unheld menu advanced is a carried create a basic form gives no
  session value (`lib/domain/advancedEntryDatums.ts::computeKindTriggers`), and
  `lib/domain/basicCaseSlots.ts::basicCaseSlots` ignores a carried create's held Save to Case block
  when it decides that (the `carried` set it is handed), so the trigger reads no hold either. And the
  planner keeps no Save to Case hold of a carried create in an advanced menu: it plans the open
  action (`placement.ts::planPlacements` answers `held: false` there). The clause stays as the plan's guard, and
  `lib/deployment/__tests__/placementMoves.test.ts` holds the case it admits: a menu held advanced
  whose extension create's block moves to its open action, the menu staying advanced. No test makes
  the clause refuse, because no admitted document gives it one.
- **The `same-type-child-links` reason was already there, so pull request 8 fills its arm** (section 7.3
  and the files of pull request 8 add the reason). Pull request 6 put it in
  `lib/publish/placementMoves.ts::PLACEMENT_OFFER_REASONS`, and `lib/deployment/placementMoves.ts::placementMoveOffer`
  answered it `null` (the departure above). Pull request 8 adds no reason and changes no schema: the
  arm now returns `sameTypeChildLinksOffer(doc)`. The service's acceptance before preflight hands the
  accepted reason to `placementMoveOffer` and treats both reasons alike, so it needs no new branch.
- **The same-type exclusion pull request 8 lifts is the domain's** (the files of pull request 8 name "part
  01's `lib/commcare/placement.ts` (the same-type exclusion lifted)"). It is
  `lib/domain/basicCaseSlots.ts::sameTypeExclusions`, which `basicCaseSlots`,
  `placement.ts::planAdvancedCore` and `lib/domain/advancedEntryDatums.ts::advancedEntryActions` call;
  pull request 8 removes it and the three calls, the advanced arm included, since
  `DONT_INDEX_SAME_CASETYPE` touches only a basic subcase's index
  (`corehq/apps/app_manager/xform.py::XForm._create_casexml`). Part 01's departure 48 holds the
  evidence.
- **Two notice and guide tests sit in files section 20 does not name.** The `next-publish-asks-more`
  lines for `commtrack-off` and `same-type-child-links` are cases of the existing
  `lib/notices/__tests__/migrationNoticeCopy.test.ts`, beside the line for `form-entry-sync-off`. The
  import file's two settings-off steps (links between cases of the same type as a step of their own,
  out of the capabilities step, and CommCare Supply) are held at `hqImportFileGuide`, which decides them,
  in the new `lib/commcare/multimedia/__tests__/hqImportFileGuideSettingsOff.test.ts`, while
  `lib/publish/__tests__/manualImportGuide.test.ts` keeps the steps' copy.
- **The same-type value class reads the configurations an app JSON was sent under.** Section 17 has
  `own_case_type_where_same_type_unindexed` read the configuration's flags, which no value-class reader
  was handed. `proof/checks/manifest_value_classes.py::App` takes the configurations, and the class
  answers True where one turns `DONT_INDEX_SAME_CASETYPE` on, False where none does, and None only where
  a reading names none; part 08's departures hold how `manifest_usage.py` threads them.

---

## Executed during planning

Nothing was run in HQ, Core, a reader or a lane for this part. Read only, at the pins and at `2f985ed6`:

- `corehq/apps/app_manager/xform.py::XForm._create_casexml` (the subcase loop, `nest`, the
  `index_same_casetype` test) and `_create_casexml_advanced`; `corehq/toggles/__init__.py`
  (`DONT_INDEX_SAME_CASETYPE`, `VIEW_FORM_ATTACHMENT`, `all_toggle_slugs`, `toggles_dict`);
  `corehq/apps/api/resources/v0_5.py::UserDomainsResource.get_object_list`;
  `corehq/apps/app_manager/suite_xml/sections/entries.py` (both CommTrack branches and
  `get_userdata_autoselect`); `corehq/apps/app_manager/xpath.py::session_var`;
  `corehq/apps/app_manager/models/applications.py::Application.commtrack_enabled`;
  `corehq/apps/app_manager/models/form_actions.py` (`OpenSubCaseAction.form_element_name`, the advanced
  `form_element_name`, `LoadUpdateAction.show_product_stock`); `helpers/validators.py::AdvancedModuleValidator.get_case_errors` (`no product detail`);
  `corehq/apps/api/domain_metadata.py` (`AdminResourceMeta`); `corehq/apps/reports/views.py::_can_view_form_attachment`;
  `corehq/apps/cloudcare/static/cloudcare/js/markdown.js` (`initMd`, its `link_open` rule); formplayer
  `api/json/PromptToJson.java::parseCaption`; commcare-android `views/widgets/QuestionWidget.java`
  (`setQuestionText`, `Linkify.PHONE_NUMBERS`) and `CommCareApplication.java::getMarkwonInstance`.
- Nova: `lib/db/types.ts`, `canonicalCommitKernel.ts`, `apps.ts::appendSyntheticBatch`, `commitGuard.ts`,
  `privilegeConvergence.ts`; the frozen admission function and the frozen catalog verifier's callers;
  `lib/collab/mutationFrame.ts`, `reconciler.ts` (`isEcho`, `applyRemote`, the `commitRejected` branch),
  `ReconcilerProvider.tsx` (the 409 branch, `frameMayTouchCaseData`); `lib/doc/hooks/useAutoSave.ts`;
  `lib/doc/store.ts` (`recordHistoryStep`, `discardUncommittedCommandState`); `app/api/apps/[id]/route.ts`
  and its stream route; `lib/deployment/service.ts`, `preflight.ts`, `confirmations.ts`, `types.ts`;
  `lib/export/boundaryValidation.ts`; `lib/commcare/projectSpaceCompatibility.ts`, `client.ts`,
  `surface/gates.ts::domainFeatureFlag`, `planPrivileges.ts`, `wireIdentity.ts`; `lib/publish/planFeatures.ts`,
  `projectSpaceCompatibility.ts`, `manualImportGuide.ts`; `lib/mcp/tools/uploadAppToHq.ts`, `errors.ts`;
  `app/api/commcare/upload/route.ts`; `lib/notices/migrationNotice.ts`, `migrationNoticeCopy.ts`;
  `proof/corpus/publish.ts`, `configurations.ts`, `documents.ts`, `entryWriter.ts`,
  `proof/checks/corpus.py::verdict_lacks`, `proof/observe/sensitivity.py::flip_plan`,
  `proof/targeted/__tests__/unproducedInputs.test.ts`; `lib/commcare/surface/entries/gates.json`;
  `lib/db/canonicalMutationFold.ts` (the fold baseline's parse), `lib/db/appAccess.ts::resolveAuthorizedAppSnapshot`,
  `lib/collab/appReadSnapshot.ts`.

The production scan (part 09 ran it, decision 16, content-free and read-only, with the person's yes) decided
three of this part's places, in words: production holds a published deployment whose baseline is `unread`,
so section 12's rule applies at the window; it holds no baseline whose bytes fail, so `baseline-unreadable`
meets no app today; and it holds no same-type basic child, so section 18's class 4 writes no line today. It
did not count published forms holding the supply-point text, which section 18's class 3 leaves to the
advisory dry run.

Found while reading, for `harness-findings.md`, "Found while planning step 5":

- *Claim corrected:* the owner brief cites `xform.py::XForm._create_casexml_1`; the function at the pin is
  `XForm._create_casexml`.
- *Claim corrected:* there is no CHECK on `app_changes.kind`; the closed set is the trigger function
  `nova_admit_app_change_insert()`.
- *Claim corrected:* the proof brief's `projectSettings.commtrackEnabled`; the corpus field is
  `projectSettings.commtrack`, and only the verdict key is `commtrackEnabled`.
- *Nova defect (N1):* `linkWriteIsShown` asks nothing for a calculated column, in a module of another case
  type, that shows a link write through a relation. Fixed in pull request 4 (section 10).

---

## Written and not yet run

**G1. CommCare Supply's effect on advanced modules and an advanced menu's case list menu item** (decision 7;
the proof brief's G4, which part 08 runs as its G4). Where: two lane runs, each whole because its emission
moves documents' keys, through the CommTrack flip of configuration sensitivity
(`proof/observe/sensitivity.py::flip_plan`'s CommTrack arm), effects written with `python3 -m
proof.checks.sensitivity effects <outputs>/proof-out-*/blocks/* --corpus <corpus>`. The first half is pull
request 7's run over every advanced document part 02 adds; the second is pull request 10's run over
`targeted-commtrack-advanced`, the first document whose advanced module holds its case list menu item beside
its forms.

- *Outcome A* (expected from `entries.py` and `AdvancedModule.get_details`): in pull request 7 the flip adds
  the `product_short` detail to every advanced module and changes nothing else; no verdict requires CommCare
  Supply off before pull request 8, so the flips are accepted and held to their effects. In pull request 10 the
  flipped build's case list entry carries a `product_id` datum after `case_id_case_<type>`, with the
  `product_short` detail; `accepts` refuses the flip because the verdict requires CommCare Supply off, and its
  differences are held to the effects. Lands in: `gates.json`'s `project-space-setting/Domain.commtrack_enabled`
  `effects` (the detail in pull request 7, the datum in pull request 10); the confirmation and its copy stand
  as written.
- *Outcome B*: the flipped build fails `validate_app()` with `no product detail` though part 02's emitter
  writes HQ's default single `name` product column from pull request 7
  (`advancedmodule-product-details-equal-to-the-default-single-name`). Then the emitter is wrong, not the
  confirmation: the column is corrected to the spelling HQ's check reads in the pull request whose run shows
  the failure, and that run repeats. If no spelling prevents it at the pin, `COMMTRACK_OFF.consequence`'s
  first clause becomes "With it on, CommCare HQ can't build this app, because an advanced menu's case list
  then needs a product list", the effects record the build error, and part 02's notes say so.
- *Outcome C*: the flip changes the build of a document whose verdict does not require CommCare Supply off
  and that neither arm names. Then `commtrackReasons` misses a trigger HQ reads: it is widened to that shape, with that
  document as its witness, in pull request 8 where pull request 7's run shows it and in pull request 10 where
  that run does, and the miss is a claim corrected in `harness-findings.md`.

**G2. Does a form-builder save leave the supply-point text plain in a label?** (the wire brief's G5). Where: pull
request 8's lane, proof 4's two Vellum saves over `targeted-supply-point-text`, then
`proof/editors/test_commtrack_supply_point_text.py`'s builds with CommTrack on and off.

- *Outcome A* (both the label's text node and the calculate's attribute hold the text after the save, and the
  build with CommTrack on gives the form the supply-point datum): `formSourceHoldsSupplyPointText` reads text
  nodes and attribute values, as written.
- *Outcome B* (only the attribute): the predicate reads attribute values only; the label no longer makes a
  reason; the targeted document keeps its label as the accepted counterpart (asked nothing); the gate entry's
  content says "an attribute of a form's source, decoded"; the copy stands.
- *Outcome C* (neither: no save leaves text HQ's substring test matches): the text arm goes. `commtrackReasons`
  keeps the advanced menu arm alone; `COMMTRACK_OFF.consequence` becomes "With it on, CommCare HQ adds a step
  this app doesn't have: an advanced menu's case list asks workers to choose a product first."; its
  `whereMissing` loses "and take the supply point text out of each form named here"; the gate entry and the
  inventory row drop the text clause; migration class 3 is removed from the cutover; the import-file step and
  the notice sentence stand.

**G3. The project-space list reads `DONT_INDEX_SAME_CASETYPE`** (decision 8). Where: pull request 8's lane,
`proof/hq/test_flag_probe.py` with the toggle added: on for one project space and off for another, each read
through the filtered list as for the eleven.

- *Outcome A* (listed exactly where it is on for the space): the inverted probe ships as written.
- *Outcome B* (the filter refuses the deprecated slug, or never lists a space it is on for): the probe cannot read
  it. The check becomes a sixth confirmation kind, `same-type-links-kept`: the CommCare Supply migration's CHECK
  lists six kinds and gains `app_deployment_confirmations_same_type_subject CHECK (kind <> 'same-type-links-kept'
  OR subject = 'same-type-links-kept')`; `PROJECT_SPACE_SETTINGS` gains `SAME_TYPE_LINKS_KEPT` (label "Links
  between cases of the same type kept"; consequence "Where it's off, CommCare HQ drops the link from each new case
  to the case of the same type it was made from."; question "Does “{space}” keep the link between a case and a new
  case of the same type? It does unless Dimagi turned that off for an older project space."; confirmLabel "It
  does"; whereMissing "Only Dimagi Support can change it. Where it stays off, Nova can save these new cases with
  Save to Case, which keeps the link."); MCP gains `confirm_same_type_links_kept`; the offer rides that need's
  `hq_confirmation_needed` refusal; `featureFlagsOff`, the inverted read and the capability are not built; the
  lane's `flagsOff` verdict key stays, since the harness still turns the flag on.

**G4. The flag's effect on Nova's same-type basic child** (part 01's G6). Where: pull request 8's lane, the
sensitivity flip of `DONT_INDEX_SAME_CASETYPE` over `targeted-same-type-child`.

- *Outcome A* (form A's subcase block loses its `<index>` and its bind; form B's Save to Case block is unchanged):
  the effects go into `gates.json`'s `toggle/DONT_INDEX_SAME_CASETYPE`; the capability, refusal and offer stand.
- *Outcome B* (no difference on form A): the capability, its refusal, the `same-type-child-links` offer,
  `featureFlagsOff`, the `flagsOff` verdict key and G3 leave pull request 8; `PLACEMENT_OFFER_REASONS` keeps
  `save-to-case` alone; the gate entry keeps `effects: []`; the `unproducedInputs` bullet stays, rewritten to say
  the build ignores the flag for Nova's shape; part 01's ordering exclusion is lifted all the same; and the claim
  that the flag drops the index is recorded corrected in `harness-findings.md`.

**The two migration tests' heap-order precondition** (sections 4.2 and 9's tests). Where: pull request 6's and 8's
CI. *Outcome A*: a by-name catalog read meets the decoy first and the tests prove the schema-qualified reads.
*Outcome B*: the precondition does not hold on CI's Postgres: the test fails loudly as a harness defect and takes
part 09's remedy for its own G5 (seeding order changed until the precondition holds); no test ships on an
assumed precondition.

**The cutover's advisory dry run** (part 09's runbook, before the window) decides what the planning scan left
open or what an author can still change. Section 18's class 3: *where it finds no published form holding the
supply-point text*, the class writes no line and the runbook says so in words; *where it finds some*, each
of those apps' live deployments gets `next-publish-asks-more` with `commtrack-off`. Section 18's class 4 and
`baseline-unreadable`: *where it finds none, as production holds today*, nothing is written and no blocker
stands; *where it finds some*, the class writes its lines, and each unreadable baseline blocks until its
deployment is refreshed. Section 12's rule: it names each app that keeps today's placements, which production
holds today.

---

## Files by pull request

**Pull request 2** (part 01's): `lib/commcare/projectSpaceCompatibility.ts` (`linkWriteIsShown` loses its mode
test with `case-attachments`).

**Pull request 4** (part 01's): `lib/commcare/projectSpaceCompatibility.ts` (`linkWriteDestinations`,
`linkWriteIsShown` over link writes, relations and form prose, the probe plan's `attachment-links` reason); `lib/commcare/surface/entries/gates.json`
(`toggle/VIEW_FORM_ATTACHMENT`'s clause) and `docs/research/2026-09-26-hq-round-trip/inventory/gates.md`;
`lib/commcare/__tests__/projectSpaceCompatibility.test.ts`.

**Pull request 5** (with parts 01, 07, 08):

- New: `lib/doc/placementHolds.ts`, `lib/doc/mutations/placements.ts`,
  `lib/db/placementAuthority.ts`, `lib/db/placementRecords.ts`.
- Changed: `lib/doc/types.ts` (`placementHoldSchema`, `holdPlacementsMutationSchema` with three targets),
  `lib/doc/mutations/index.ts`, `lib/doc/mutationTargetAdmission.ts`, `lib/doc/incrementalValidationScope.ts`,
  `lib/doc/diffDocsToMutations.ts`, `lib/doc/store.ts` (`setRecordedPlacementHolds`, which sets part 07's
  `recordedHolds` that its `applyHistoryStep` reads through this part's `admittedHoldChanges`), `lib/db/canonicalCommitKernel.ts` (the rule's call and the recordings read),
  `lib/db/appAccess.ts` (`recordedHolds` in `resolveAuthorizedAppSnapshot`),
  `lib/collab/appReadSnapshot.ts`, `app/api/apps/[id]/route.ts` (the GET's `recordedHolds`),
  `app/(app)/build/[id]/[[...path]]/page.tsx` (`initialAccess`), `lib/collab/reconciler.ts` (the record
  beside `confirmedDoc`), `lib/collab/ReconcilerProvider.tsx` (`frameMayTouchCaseData`, the record handed to
  the store), `biome.json` (the `lib/commcare` allowlist gains `lib/doc/placementHolds.ts` and
  `lib/db/placementAuthority.ts`), `lib/doc/CLAUDE.md`, `lib/db/CLAUDE.md`, `lib/collab/CLAUDE.md`.
- Tests: `lib/doc/__tests__/{holdPlacements,placementSlotsWrittenOnlyByHolds,diffDocsToMutations.placementHolds,placementHolds}.test.ts`
  (new), `lib/db/__tests__/placementAuthority.test.ts` (new), `lib/db/__tests__/placementRecords.postgres.test.ts`
  (new), `lib/db/__tests__/commitGuardedBatch.postgres.test.ts`, `lib/db/__tests__/projectMembership.postgres.test.ts`,
  `lib/collab/__tests__/appReadSnapshot.test.ts`.

**Pull request 6: Publish placements** (with part 08):

- New: `lib/case-store/migrations/20261110000000_hq_round_trip_case_writes_publish_placement.ts`,
  `lib/commcare/placementHolds.ts`, `lib/commcare/hq/publishedCaseBlocks.ts`, `lib/deployment/placements.ts`,
  `lib/deployment/placementMoves.ts`, `lib/publish/placementMoves.ts`,
  `components/builder/placementConflictReplay.ts` (part 07's `replayAfterPlacementConflict`, the
  `onPlacementConflict` handler; no test of its own; `planConflictReplay` is tested in `identityMoves.test.ts`).
- Changed: `lib/case-store/migrations/index.ts`; `lib/db/types.ts`, `lib/db/persistedJson.ts`,
  `lib/db/canonicalCommitKernel.ts`, `lib/db/commitGuard.ts`, `lib/db/apps.ts`, `lib/db/applyBlueprintChange.ts`,
  `lib/db/placementRecords.ts` (`publish-placement` rows read as recordings),
  `lib/agent/change-set/commit.ts`; `lib/doc/placementHolds.ts` (`PLACEMENT_CONFLICT_CODES`), `lib/doc/store.ts`
  (`queuedCommandMutations`); `lib/collab/mutationFrame.ts`, `lib/collab/reconciler.ts` (the frame's holds
  into the record, the replay), `lib/collab/ReconcilerProvider.tsx`, `lib/doc/hooks/useAutoSave.ts`;
  `app/api/apps/[id]/route.ts`,
  `app/api/apps/[id]/stream/route.ts`; `lib/deployment/service.ts`, `lib/deployment/types.ts`,
  `lib/deployment/confirmations.ts`; `app/api/commcare/upload/route.ts`,
  `app/api/commcare/project-space-compatibility/route.ts`; `lib/mcp/tools/uploadAppToHq.ts`,
  `lib/mcp/tools/checkProjectSpaceCompatibility.ts`, `lib/mcp/errors.ts`; `components/builder/PublishDialog.tsx`,
  `components/builder/publishOutcome.ts`, part 07's `IdentityMoveDialog` (the `placement-recorded` lead and
  **Leave it**, part 07's pull request 6);
  `proof/corpus/publish.ts`, `proof/corpus/emitCorpus.ts` (part 08's D5); `CLAUDE.md`, `lib/db/CLAUDE.md`,
  `lib/collab/CLAUDE.md`, `lib/deployment/CLAUDE.md`.
- Tests: `lib/case-store/migrations/__tests__/publishPlacementKind.postgres.test.ts`,
  `lib/db/__tests__/publishPlacementCommit.postgres.test.ts`, `lib/commcare/__tests__/heldPlacementEmission.test.ts`,
  `lib/deployment/__tests__/placementMoves.test.ts`, `lib/commcare/hq/__tests__/publishedCaseBlocks.test.ts` (new);
  `lib/db/__tests__/persistedJson.test.ts`, `lib/collab/__tests__/{mutationFrame,reconciler,ReconcilerProvider}.test.ts`,
  `app/api/apps/[id]/__tests__/route.test.ts`, `app/api/apps/[id]/stream/__tests__/stream.postgres.test.ts`,
  `lib/deployment/__tests__/publishSequence.postgres.test.ts`, `lib/deployment/__tests__/publishFixtures.ts`
  (`reloadHeadFor`), `lib/mcp/__tests__/{uploadAppToHq.postgres,servedSchemas}.test.ts`,
  `components/builder/__tests__/publishOutcome.test.ts`, `proof/corpus/__tests__/publish.test.ts`,
  `e2e/tests/multiplayer/multiplayer.spec.ts`, `e2e/tests/browser/publishing.spec.ts`.

**Pull request 7** (part 02's): `lib/doc/types.ts` (the `module-kind` arm), `lib/doc/placementHolds.ts` (its
dispatch to `heldKindExpresses`), `lib/commcare/placementHolds.ts` (module kinds held through
`emittedModuleKind`); the tests of section 20. G1's first half runs in this pull request's lane (part 08's
G4).

**Pull request 8: CommTrack and same-type child links at publish** (with parts 02 and 08):

- New: `lib/case-store/migrations/20261110010000_hq_round_trip_case_writes_commtrack_confirmation.ts`,
  `lib/commcare/xform/supplyPointText.ts`, `proof/editors/test_commtrack_supply_point_text.py`,
  `proof/targeted/__tests__/publishChecks.test.ts`.
- Changed: `lib/case-store/migrations/index.ts`; `lib/commcare/planPrivileges.ts` (`commtrackReasons`, reading
  part 02's `advancedModulesWithCaseListMenuItem`), `lib/commcare/projectSpaceCompatibility.ts` (the
  capability, `featureFlagsOff`, `sameTypeChildReasons` over part 01's `sameTypeBasicChildCases`),
  `lib/commcare/client.ts`,
  `lib/commcare/multimedia/hqJsonExportArchive.ts`; `lib/publish/planFeatures.ts` (`COMMTRACK_OFF`),
  `lib/publish/projectSpaceCompatibility.ts`, `lib/publish/manualImportGuide.ts`, `lib/publish/placementMoves.ts`;
  `lib/deployment/types.ts`, `lib/deployment/confirmations.ts`, `lib/deployment/placementMoves.ts`,
  `lib/deployment/service.ts`; `lib/db/pg.ts`; `lib/notices/migrationNoticeCopy.ts`;
  `app/api/commcare/project-space-compatibility/route.ts`; `lib/mcp/tools/uploadAppToHq.ts`,
  `lib/mcp/tools/withdrawDeploymentConfirmation.ts`, `lib/mcp/tools/checkProjectSpaceCompatibility.ts`;
  `components/builder/PublishPanel.tsx`, `components/builder/app-setup/publishingSectionModel.ts`,
  `components/builder/PublishDialog.tsx`; part 01's `lib/commcare/placement.ts` (the same-type exclusion
  lifted) and `lib/commcare/__tests__/compilerEvidence.ts` (its same-type subcase assertion dropped, part 01
  §28), so `sameTypeBasicChildCases`, which part 01 lands in pull request 4, lists an unheld same-type create
  from here;
  `proof/corpus/publish.ts`, `proof/corpus/entryWriter.ts`, `proof/checks/corpus.py`, `proof/hq/test_flag_probe.py`,
  `proof/targeted/__tests__/unproducedInputs.test.ts`, the targeted documents of section 17;
  `lib/commcare/surface/entries/gates.json`, `forms-and-case-writes.json`,
  `docs/research/2026-09-26-hq-round-trip/inventory/gates.md`; `lib/commcare/CLAUDE.md`,
  `lib/deployment/CLAUDE.md`.
- Tests: section 20's pull request 8 list.

**Pull request 10** (part 05's): `lib/commcare/__tests__/planPrivileges.test.ts` and
`e2e/tests/browser/publishing.spec.ts` (the advanced menu item beside forms, section 20);
`lib/commcare/surface/entries/gates.json` (`project-space-setting/Domain.commtrack_enabled`'s menu-item
effect from G1's second half, over part 08's `targeted-commtrack-advanced`).

**Pull request 14** (part 09's): the frozen classifier for unread baselines, the query repeat exception, the
`placements-kept-unread` reason with its copy and the `baseline-unreadable` blocker, in part 09's files.

**Pull request 15** (part 10's): `docs/architecture/contracts.md`, `content/docs/publishing.mdx`,
`content/docs/project-space-compatibility.mdx`, `content/docs/mcp/tools.mdx`.

---

## What other parts read from this one

- **Part 01** (case writes): `holdPlacements` is the only writer of `placement` and `ownClosePlacement`, so its
  identity moves emit it and its schemas refuse the slots elsewhere, `caseOperationChange` `add` included
  (section 2.4); the slots are stored from pull request 4. The kernel rule reads its
  `lib/commcare/placement.ts::placementExpresses(doc, formUuid, subject, placement)`, the same predicate its
  `HELD_PLACEMENT_INEXPRESSIBLE` rule reads; the recorder reads `appPlacements`, whose derived Save to Case
  placement carries the exact path the emitter writes; the same-type offer reads `placementCandidates`; until
  pull request 8 its basic subcase eligibility excludes a create of its module's own type, and
  `unproducedInputs.test.ts`'s same-type bullet stays until then. Section 3's two editor arms are the rule
  its identity moves and their undo meet: a move its batch needs, or the restore of the recorded hold (section
  2.6). Its `sameTypeBasicChildCases` is read here.
- **Part 02** (advanced): the `module-kind` arm lands with `heldKind` in pull request 7, and
  `lib/domain/advancedModule.ts::heldKindExpresses(doc, moduleUuid)` is the predicate the kernel rule reads;
  `lib/commcare/moduleKind.ts::emittedModuleKind` is read by `placementsToHold` and the `save-to-case` offer,
  and `advancedModulesWithCaseListMenuItem` (pull request 8) by `commtrackReasons`; the case list menu item of
  an advanced module beside its forms is first emitted in pull request 10, with the default product column
  part 02 writes from pull request 7 (G1).
- **Part 04** (questions): no `setQueryRepeatPlacement`; a query repeat's held `placement` is stored from pull
  request 3 and written by a mutation only through `holdPlacements` from pull request 5;
  `queryRepeatPlacementExpresses` and `effectiveQueryRepeatPlacement` are read here;
  `QUERY_REPEAT_MODEL_ITERATION_SHAPE` is a placement conflict code; the undo of a query repeat's move is
  section 3's arm (b); an unread baseline's count-placed query repeat moves (section 12).
- **Part 05** (search and menus): `moduleHasCaseListMenuItem` (`Module.caseListMenuItem`, beside forms from
  pull request 10) is what part 02's `advancedModulesWithCaseListMenuItem` reads from then, for
  `commtrackReasons`.
- **Part 07** (authoring): `IdentityMoveDialog` gains the `placement-recorded` lead, with **Make the change**
  and **Leave it**; its `components/builder/placementConflictReplay.ts::replayAfterPlacementConflict`
  supplies `onPlacementConflict`, the handler the reconciler calls with every rejected human batch and the
  queued commands, plans through its `planConflictReplay`, and sets `pendingIdentityMove` with origin
  `conflict`; `applyHistoryStep` and `planConflictReplay` keep exactly section 3's arms through this part's
  `lib/doc/placementHolds.ts::admittedHoldChanges` over `BlueprintDocState.recordedHolds`, which
  `setRecordedPlacementHolds` sets from the `recordedHolds` the app load carries, read by this part's
  `readRecordedPlacementHolds` (section 6.3); the publish dialog's `PlacementMoveChoice`; the nova-plugin
  sweep of section 19.
- **Part 08** (proof): the capture's record (D5), the verdict keys `commtrackEnabled` (reading in pull request 1,
  writing in pull request 8) and `flagsOff` (pull request 8, a key the proof brief does not name), the four
  targeted documents (`targeted-held-placement` in pull request 5, `targeted-same-type-child` with its two
  forms and `targeted-supply-point-text` in pull request 8, `targeted-commtrack-advanced` in pull request 10),
  `test_flag_probe.py`, `test_commtrack_supply_point_text.py`, `publishChecks.test.ts`, the gate entries,
  gated runs G2 to G4 in pull request 8's lane and G1 in pull requests 7 and 10; the corpus judge passes
  `readPlacementHolds(D)` as the record (section 17).
- **Part 09** (cutover): the two migrations' names and bodies for its ledger phase; `publishedCaseBlocks` in place
  of `baselineCaseBlocks`; the unread rule of section 12 with its query repeat exception; the blocker
  `baseline-unreadable` for a baseline row whose bytes fail gunzip, digest or parse, remedied by refreshing that
  deployment; the notice reason `placements-kept-unread` with its copy; `commtrackReasons` and part 01's
  `sameTypeBasicChildCases` for the `next-publish-asks-more` lines; and this part's reading that a deployment
  whose live app mapping is marked missing on CommCare HQ still counts as published, because the project space
  keeps its submissions under the same `xmlns`.
- **Part 10** (stack and contracts): this part's pull request split (5, 6, 8 with lines in 2, 4, 7, 10, 14, 15),
  the contracts sentences of section 19, and the ordering guards.
- **For the outlines.** Step 6 (import): `publishedCaseBlocks` is the reader its import matches case
  transactions with; import asks `commtrack-off` with the same predicate over the imported source, and probes
  `same-type-child-links` for an imported same-type basic child, because import is the other way an app reaches
  a project space; its drift merge inherits the unread rule; ending a deployment (step 6's) decides which
  deployments stop counting as published. Step 7: a computed datum reading `supply_point_id`, if it builds one,
  is caught by `commtrackReasons`' decoded-text arm without change, because the predicate walks the emitted
  source.
