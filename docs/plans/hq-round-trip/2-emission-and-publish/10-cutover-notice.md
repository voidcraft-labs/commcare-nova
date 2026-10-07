# Step 2, part 10: The cutover and work item F (the migration notice)

Part of [step 2's plan](../2-emission-and-publish.md), which holds the baseline, the decisions, the stack and the exit. Citations are `file::symbol`; HQ paths are relative to `corehq/apps/app_manager` unless another app is named.

Step 2 changes the stored shape of every Nova document once, in one direct maintenance cutover, and tells each app's members what changed in a notice. This part owns two things, each with its own block at the end:

| Part | Owns | Pull request |
|---|---|---|
| The cutover | The fold-horizon DDL, the scan and migrate scripts, the HQ reads, the matching, the ordered transform, the fleet write, the runbook, the removal | 2 (skeleton, with an empty step list), every later pull request that changes a stored shape (its step), 16 (removal) |
| Work item F | The notice tables, the entries union, the builder, home and MCP surfaces | 2 |

Every fix that changes a stored document adds its transform step, its notice reason and its fixture expectations in its own pull request. This part fixes the mechanism, the order of the steps and the names they use, so that at every point of the stack the migrate script is complete for the shape that point reads.

**This part is the registry.** A step id, a step's place in the order, a notice reason's name and its kind are spelled once, in "The transform steps, in order", "Changes that write nothing and still get a line" and the two reason tables of work item F. Every other part of this plan uses these step ids and reason strings verbatim, and uses none that is not listed here. A reason's copy lives in exactly one place: this part's copy table for the reasons it lists, and the owning part's block for the rest, as the reason tables say.

Nothing here rests on a CommCare fact executed during planning except where it says so. The HQ reads are read at commcare-hq `d6c6e16d8ae1`.

## Why this is a fold-horizon cutover

It is a choice between the two routes the contract offers, and the plan states it as one.

The governing sentences:

- `docs/architecture/contracts.md`, "Valid by construction": "When a stored shape changes incompatibly, the same release either migrates the replayable suffix or atomically establishes an explicit fold horizon whose earlier rows remain opaque audit history. A horizon expected to support later replay owns an immutable, complete Project-bearing persisted baseline keyed to its exact app sequence".
- `docs/architecture/contracts.md`, "Direct maintenance cutover": "A persisted-shape change that the old and new revisions cannot both read is not forced through a rolling compatibility layer. Its advisory production scan runs first. The exceptional operator runbook then blocks ingress and every independent writer, drains in-flight work, proves the database quiescent, and reruns the blocking scan under the migration's locks. Only that frozen proof authorizes the one final-shape migration. The exact new image then deploys and proves it can read the shape before writers and ingress resume."
- `docs/architecture/contracts.md`, "New top-level blueprint collections": "An incompatible persisted mutation or document change uses the direct maintenance cutover and an explicit fold horizon. Older rows remain opaque audit history and old clients reload; runtime code does not retain a second parser or reducer to make them live."
- `lib/db/CLAUDE.md`: "A blueprint-shape migration converts every replayable app change; no runtime reader accepts an alternate stored dialect. Advancing the fold horizon is not a route a future migration can simply take", and "Adding another baseline identity needs new DDL."

What step 2 changes, and what each kind of change rules out:

| Kind of change | In step 2 | Old document parses under the new schema | Old history rows replay under the new `mutationSchema` |
|---|---|---|---|
| Removed keys | `searchButtonLabel`, `hint_media`, `validate_msg_media`, `label_media` on groups and repeats | no, for every app that holds one | no, for every `addField`, `addModule`, `updateField` or search patch row that carries one |
| New required slots | `localization.wireCodes`, `appSettings`, the three tile cell slots | no, for every app that holds the parent | no, for every row that installs the parent |
| Narrowed rules held in the validator | ids, duplicate option values, empty forms, time ordering, reserved input names, sort ownership | yes, and the gate then refuses the app on every read (`lib/db/canonicalCommitKernel.ts::loadStrictAppSnapshotFromRowInTransaction`) | yes |
| New optional slots | `hiddenFromMenu`, `postSubmit` members, a search prompt's `sortColumnId` | yes | yes |

The first two rows decide it.

- **A `blueprint-migration` batch is impossible.** `lib/db/apps.ts::appendSyntheticBatch` loads its source through the current strict schema, which no pre-step app holding a removed key or lacking a required slot passes. The new mutation dialect also has no patch key that says "clear `hint_media`", and no earlier row that carries a removed key replays after such a batch.
- **Rewriting the suffix in place is possible and rejected.** It is the route `lib/db/CLAUDE.md` words as the norm. It needs a frozen rewrite of every mutation kind whose payload changes. A patch whose only key was a removed one becomes empty, and a batch that becomes `[]` breaks the non-empty envelope rule. Immutable baselines must be rewritten with their trigger disabled. Every recorded digest of a historical snapshot (`authoring_checkpoints.committed_snapshot_digest`, `design_committed_slices.committed_snapshot_digest`) is left wrong. Step 2 changes many payloads; the suffix rewrite suited one.
- **Decision: one fold horizon per app**, deleted apps included. Each app's head is transformed once, proved (it parses, passes the absolute gate and export readiness, and equals the planned target), and history starts again from an immutable baseline. Reason: it is the only one of the two that stays correct as each fix adds its document migration, its proof is one statement per app, and it has two full precedents in the tree (`lib/case-store/migrations/20260728000000_canonical_identity_foundation/frozenDatabaseMigration.ts`, `scripts/lib/repairAuthoringBaselines.ts::repairAuthoringBaselineInTransaction`).

The horizon's identity: `app_changes.batch_id = 'fold-baseline:hq-round-trip-emission'`, `actor_id = 'system:hq-round-trip-emission'`, `run_id NULL`, kind `fold-baseline`, mutations `[]`. The batch id is the idempotency latch (`UNIQUE (app_id, batch_id)`).

Three alternatives considered and rejected:

| Alternative | Why not |
|---|---|
| Two releases (keep each key, repair, remove later) | A staged rollout, and the old rows still fail to replay after the second release. |
| A ledgered Kysely migration that transforms inside the deploy's own migrate Job | It freezes the transform in the tree for good, and it cannot call HQ or decrypt a key. `scripts/migrate.ts` already says historical repairs are explicit scan and migrate commands under `scripts/`. |
| A horizon only for the apps that need one | Every app lacks `appSettings`, so every app needs one. Uniform is simpler to prove. |

Why the data must be in its final shape before the new image deploys: this deploy's migrate Job (`scripts/migrate.ts::main`) runs from the new image while the old revision serves, and ends in `lib/db/runtimeDatabaseProbe.ts::runCanonicalRuntimeDatabaseProbe`, which decodes every `apps` row (deleted ones included) with the new schema, reruns the empty-batch gate, and fails the deploy on any finding. The probe proves the head document only. It does not fold history, compare `case_type_schemas`, or parse a baseline, so the cutover's own postconditions carry those. A later deploy that changes nothing in the migration image's import graph reuses the prior Execution (`scripts/rollout/migration-gate.py::admit_migration`) and is not a second proof.

## What else holds old-shape state, and what the cutover does with each

| Holder | Today | The cutover |
|---|---|---|
| Open builder tabs | A `fold-baseline` row in a stream suffix makes the client reauthorize and reload the whole app (`lib/collab/CLAUDE.md`, "Reload reconciliation"); `NEXT_DEPLOYMENT_ID` hard-reloads a stale client. | Nothing new. Edits a tab queued and had not saved are in the old dialect; the new server's admission refuses them and the reconciler drops them through its rejected-batch path. |
| Private agent work | `authoring_workspaces` rows with `status = 'open'` hold staged steps in the old dialect against an old base, and `authoring_sessions.active_candidate_id` points at one. | Clears every pointer, then abandons every open workspace and every open `design_change_sets` row, app-bound or not. The session, its plan and its conversation stay; the next edit opens a candidate from the saved app. Each app that had such a row gets the document reason `unsaved-assistant-work-discarded`, because the window's announcement reaches only the people who read it. |
| A build that has not saved its first app | A pre-app build session holds an open genesis workspace whose steps are old-dialect mutations. | Ends the session exactly as `lib/db/designSessions.ts::discardDesignSession` ends one (state `abandoned`, the hold refunded, transcript kept). Reason: no saved app exists to reopen a candidate from, and its reviewed steps cannot replay. `lib/agent/build/progress.ts::deriveDesignBuildStage` already shows such a session as ended. It gets no notice row, because a notice belongs to an app and none exists; the session's own page says it ended, and the window's announcement says unsaved builds will not survive. |
| Event log | `lib/log/reader.ts::decodeEvents` parses a whole run strictly and `lib/log/types.ts::mutationEventSchema` embeds `mutationSchema`, so one old-dialect mutation event fails the read of its run. | Archives every `mutation` event into the existing `archived-mutation` arm (`lib/log/types.ts::archivedMutationEventSchema`), bytes preserved. |
| Live stream log, presence | `chat_stream_chunks` holds `data-mutations` chunks; `threads` hold stream holders. | Clears holders, deletes the chunks and presence rows. No run is alive. |
| Running app tests | `lib/db/appTests.ts` refuses a test whose `blueprint_seq` is not the app's current sequence. | Nothing: the horizon advances every sequence, so every running test ends by that rule. |
| Thread transcripts | `lib/chat/sanitizeToolParts.ts::sanitizeHistoricalToolParts` drops or converts a tool part whose tool is gone or whose schema narrowed. | No rewrite. |
| Stored model contexts | `lib/models.ts::MODEL_CONTEXT_VERSION` decides whether a provider checkpoint is reused. | From step 2 `MODEL_CONTEXT_VERSION` is bumped in each pull request of the stack that changes the tool catalog, because narrowed tool inputs remove historical calls from the model's view; part 11, The model-addition checklist, item 13, is the one list of those pull requests and of the value each sets. The first is pull request 5 (`update_app`). The file is never this block's. |
| Preview snapshots in app tests | `lib/db/appTests.ts::RUNTIME_VERSION` is 14. | From step 2 it is 15, set in pull request 2. Reason: the horizon itself changes the document every stored snapshot was taken over, so the bump belongs to the cutover and no later pull request of the stack moves it again. |
| Entry-point links | `lib/deployment/entryPointLinks.ts` refuses a new link when the manifest's `sourceSequence` is not the app's sequence. | Nothing stored. Every deployment's manifest goes stale by the horizon's `+1`, so new links need a republish. The notice says so (`deep-links-need-republish`). |
| Staged captures | An unsubmitted `form_attachments.instance_path` is checked against the committed document's path template (`lib/db/formAttachments.ts`); an in-flight Preview submission is fenced by `form_submission_intents.app_mutation_seq` (`lib/db/caseMutationAuthorization.ts`). | Nothing. A capture staged under a renamed question expires by the existing seven-day rule; an in-flight submission is refused by the existing fence. |

Three runtime reads fold at a sequence that the horizon puts behind an old-shape baseline. Each is fixed in pull request 2, permanently, because the same defect follows every later step's horizon:

| Reader | Today | From step 2 |
|---|---|---|
| `lib/agent/build/orchestrator.ts`, the `head?.state.kind === "finished"` branch | `loadCanonicalBlueprintAtSequence(finished.appSeq)` and sends that snapshot as `data-done`. | When `finished.appSeq` precedes the app's greatest `app_change_fold_baselines.seq`, it answers from the current saved app (`contracts.md`: "The session's recovery address resolves to the saved app"). |
| `lib/agent/change-set/materializeGenesis.ts::readMaterializedGenesisReceipt` | Folds a committed genesis set at sequence 1 with the checkpoint's digest. | The same rule: behind a later baseline it reads the saved app and skips the digest comparison, which no longer names a readable document. |
| `app/api/apps/[id]/stream/route.ts` | A cursor below the horizon whose suffix holds an old-dialect row answers `protocol-failure` and logs an error for each open tab. | It reads the greatest baseline sequence above the cursor before parsing any suffix row, and answers `reload` (`reloadAndClose`) without parsing rows behind it. |

The rule lives once, in `lib/agent/change-set/baseLoader.ts`, as `greatestFoldBaselineSeq(appId)`, read by the three callers.

## Ledgered DDL

Ordinary, additive, immutable migrations under `lib/case-store/migrations/`, registered in `migrations/index.ts`, each with a timestamp later than `20261004000000_app_test_lookup_definitions.ts`, with `lib/db/pg.ts::AppDatabase` and `lib/db/privilegeConvergence.ts` moved in the same pull request. All of it is safe under the old revision (new tables, nullable columns, functions whose output is unchanged while the new column is NULL), which matters because the cutover Job applies it while the old image is the deployed one. The timestamps order the files as the table lists them: fold horizon, then notices, then the deployment ledger, then `app_settings`.

| File | Holds | Pull request |
|---|---|---|
| `<timestamp>_hq_round_trip_fold_horizon.ts` | `CREATE OR REPLACE` of both admit functions with the new identity arm | 2 |
| `<timestamp>_app_migration_notices.ts` | the three notice tables | 2 |
| `<timestamp>_hq_round_trip_deployment_ledger.ts` | the deployment ledger (part 02, The ledger schema) | 2 |
| `<timestamp>_app_settings.ts` | `apps.app_settings` and the replaced snapshot function | 5 (part 04, Defect 7: saved and incomplete forms differ by export path) |

**The two admit functions.** `nova_admit_app_change_fold_baseline_insert` (the trigger on `app_change_fold_baselines`) and `nova_require_app_change_fold_baseline` (the trigger on `app_changes`) both hardcode the operator identities (`lib/case-store/migrations/20260914080000_authoring_fold_horizon.ts`), so both are replaced. Each function body is copied whole from that migration with one change, a third operator arm beside the two that exist:

```sql
-- in nova_admit_app_change_fold_baseline_insert
((marker.batch_id = 'fold-baseline:canonical-identity-foundation' AND marker.actor_id = 'system:canonical-identity-foundation')
 OR (marker.batch_id = 'fold-baseline:unified-authoring' AND marker.actor_id = 'system:unified-authoring')
 OR (marker.batch_id = 'fold-baseline:hq-round-trip-emission' AND marker.actor_id = 'system:hq-round-trip-emission'))
AND marker.run_id IS NULL

-- in nova_require_app_change_fold_baseline
((NEW.batch_id = 'fold-baseline:canonical-identity-foundation' AND NEW.actor_id = 'system:canonical-identity-foundation')
 OR (NEW.batch_id = 'fold-baseline:unified-authoring' AND NEW.actor_id = 'system:unified-authoring')
 OR (NEW.batch_id = 'fold-baseline:hq-round-trip-emission' AND NEW.actor_id = 'system:hq-round-trip-emission'))
AND NEW.run_id IS NULL
```

Every other check stays: the inserted snapshot equals `nova_current_app_change_fold_snapshot(app_id)` as text, the root and every entity row carry the inserting transaction's `xmin`, the digest and Project match. The runtime role's grant on `app_change_fold_baselines` stays read-only.

**The snapshot function.** `BlueprintDoc.appSettings` is the one new root slot of step 2, held in one new column so the root-slot list is paid once (step 7 adds its settings to the same object). `<timestamp>_app_settings.ts`:

```sql
ALTER TABLE apps ADD COLUMN app_settings jsonb
  CHECK (app_settings IS NULL OR jsonb_typeof(app_settings) = 'object');
```

followed by `CREATE OR REPLACE FUNCTION nova_current_app_change_fold_snapshot(text)`, the body of `20260914060000_complete_fold_snapshots.ts` whole, with one more concatenation after the `localization` one:

```sql
|| CASE WHEN app.app_settings IS NULL THEN '{}'::jsonb
        ELSE jsonb_build_object('appSettings', app.app_settings) END
```

Without it the admit trigger refuses every new baseline, because it compares the inserted snapshot with this function's output; `20260914060000_complete_fold_snapshots.ts` exists because localization was once added without it. The column is nullable only because the DDL lands while the old revision serves. `appSettings` is required in the document, and the cutover's postcondition is that no `apps` row holds a NULL `app_settings`. The other places that name the root slots by hand move in the same pull request: `lib/db/blueprintRows.ts::blueprintScalars` and `::assembleBlueprint`, `lib/db/canonicalCommitKernel.ts::PERSISTED_BLUEPRINT_APP_COLUMNS` and `::denormalize`, `lib/db/persistedJson.ts`, `lib/db/runtimeDatabaseProbe.ts::readRuntimeProbeCarriers`, `lib/db/mediaDeletion.ts`, `lib/db/appGenesis.ts`.

**The notice tables.** `<timestamp>_app_migration_notices.ts`:

```sql
CREATE TABLE IF NOT EXISTS app_migration_notices (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  app_id text NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  cutover text NOT NULL CHECK (btrim(cutover) <> ''),
  entries jsonb NOT NULL CHECK (jsonb_typeof(entries) = 'array' AND jsonb_array_length(entries) > 0),
  created_at timestamptz(3) NOT NULL DEFAULT now(),
  CONSTRAINT app_migration_notices_once UNIQUE (app_id, cutover)
);

CREATE TABLE IF NOT EXISTS app_migration_notice_key_readers (
  cutover text NOT NULL CHECK (btrim(cutover) <> ''),
  user_id text NOT NULL CHECK (btrim(user_id) <> ''),
  server text NOT NULL CHECK (server IN ('production', 'india', 'eu')),
  domain text NOT NULL CHECK (btrim(domain) <> ''),
  first_used_at timestamptz(3) NOT NULL,
  last_used_at timestamptz(3) NOT NULL CHECK (last_used_at >= first_used_at),
  PRIMARY KEY (cutover, user_id, server, domain)
);
CREATE INDEX IF NOT EXISTS app_migration_notice_key_readers_user
  ON app_migration_notice_key_readers (user_id);

CREATE TABLE IF NOT EXISTS app_migration_notice_dismissals (
  id uuid PRIMARY KEY DEFAULT uuidv7(),
  user_id text NOT NULL CHECK (btrim(user_id) <> ''),
  surface text NOT NULL CHECK (surface IN ('app', 'key-reader')),
  notice_id uuid REFERENCES app_migration_notices(id) ON DELETE CASCADE,
  cutover text,
  dismissed_at timestamptz(3) NOT NULL DEFAULT now(),
  CONSTRAINT app_migration_notice_dismissals_subject CHECK (
        (surface = 'app') = (notice_id IS NOT NULL)
    AND (surface = 'key-reader') = (cutover IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS app_migration_notice_dismissals_app
  ON app_migration_notice_dismissals (notice_id, user_id) WHERE surface = 'app';
CREATE UNIQUE INDEX IF NOT EXISTS app_migration_notice_dismissals_key_reader
  ON app_migration_notice_dismissals (cutover, user_id) WHERE surface = 'key-reader';
```

All three tables are created by this ledgered migration and by nothing else. No statement of it runs ahead of the ledger: the advisory run writes nothing, so no table has to exist before the window ("The key-readers record").

| Decision | Reason |
|---|---|
| No `project_id` column | A notice belongs to its app and reaches the tenant through `apps.project_id` at read time, so a Project move needs no update and the table adds nothing that references `apps.project_id` (the rule `lib/case-store/migrations/20260806000000_deployments.ts` states in its header). |
| `UNIQUE (app_id, cutover)` | The writer's idempotency latch. This step's `cutover` is `hq-round-trip-emission`; steps 3 to 7 each write their own row, so the mechanism is built once. |
| Key readers are keyed by `cutover`, not by a notice | A key is used per project space, not per app, and a deployment the execute run reads may give its app no entry at all. Keyed this way every key the execute run sent has a row whether or not any app has an entry, the home page asks "which rows name me" by index, and no row joins to an app the person may no longer reach. |
| `first_used_at` and `last_used_at` | The execute run sends one key several times: four reads per deployment, their retries, and every deployment of that project space. The row holds the span from that run's first send of the key to its last, and the home line states it. Only the execute run writes a row ("The key-readers record"). |
| A dismissal names a notice or a cutover | A person can be both a member of the app and the person whose key read its project space. Dismissing the home line leaves the app's notice showing, and the reverse. |
| No expiry | A member who first opens the app a year later still learns what changed. Rows go with the app (`ON DELETE CASCADE`). |

Runtime capabilities (`lib/db/privilegeConvergence.ts`):

| Table | List | Reason |
|---|---|---|
| `app_migration_notices`, `app_migration_notice_key_readers` | `RUNTIME_READ_ONLY_TABLES` | Only a migrate script writes them, as the migration role, so serving code cannot forge one. Between the cutover's DDL and the deploy's privilege convergence the runtime role holds no grant on either table, and nothing in the old revision reads them. |
| `app_migration_notice_dismissals` | `RUNTIME_APPEND_ONLY_TABLES` | A dismissal is inserted and never undone. |

None is row-locked in serving code, which `lib/db/__tests__/runtimeRowLockPrivileges.test.ts` requires of those classes. `lib/db/pg.ts::AppDatabase` gains `AppMigrationNoticesTable`, `AppMigrationNoticeKeyReadersTable` and `AppMigrationNoticeDismissalsTable`.

## Scripts and their layout

```
scripts/scan-hq-round-trip-cutover.ts       read-only, documents and ledger only, no HQ request, no key
scripts/migrate-hq-round-trip-cutover.ts    the Job's entrypoint; a dry run unless told otherwise
scripts/lib/hqRoundTripCutover/
  oldShape.ts          the one reader of the pre-step shape: raw carriers in, no current schema
  transform.ts         pure: raw carriers -> { target, changes }, running steps/ in the fixed order
  steps/<step>.ts      one module per document migration, registered in transform.ts
  legacyLanguageWireCodes.ts  frozen copy of the pre-step wire-code grouping, read by steps/languageWireCodes.ts
  behavior.ts          pure: one selection function per no-write document reason, over the migrated document
  questionPaths.ts     the Nova side of the matcher, walked from the raw pre-step carriers
  matching.ts          pure: HQ menus and forms <-> Nova menus and forms
  hqRead.ts            credential order, request classification, bounded retry, concurrency
  kmsDecrypt.ts        one decrypt call per use of a key
  lookupTags.ts        pure: the Project-level tag rename
  holders.ts           settles lapsed and paused holders through the production reapers
  plan.ts              fleet source -> CutoverPlan and its digest
  writer.ts            the one fleet transaction
  notice.ts            changes and deployment outcomes -> notice rows
  report.ts            the content-free report, and the --debug-details form
  __tests__/           *.test.ts (pure), *.postgres.test.ts (writer), fixtures/pre-step/
```

Both scripts follow the house conventions: first line `import "./lib/loadEnv";`, `commander` for arguments, `scripts/lib/main.ts::runMain`, and `closeCaseStoreDatabase()` in a `finally`.

**`oldShape.ts`.** The transform reads the persisted carriers as JSON data, as `lib/db/persistedJson.ts` reads them, and never through `blueprintDocSchema`. It checks only what each step relies on (a form row is an object with a `uuid`; a field row has a `kind`). Reason: the old schema is gone from the tree once the stack lands, a frozen copy of it would be a second dialect to maintain, and the fleet is known to pass the pre-step gate because every deploy's probe proved it. The proof of the output is the new schema and the new gate.

No production function is ever handed a pre-step document. `lib/commcare/emissionPlan.ts::emissionPlan`, `lib/commcare/xform/caseOps.ts::collectFieldLocations`, `lib/db/classifyCaseTypeChanges.ts::classifyCaseTypeChanges` and every reducer under `lib/doc/mutations` take a hydrated `BlueprintDoc` of the tree's current schema, which a pre-step document is not at the head of the stack. So:

- a step that needs a production rewrite (removing a search input, splitting an option value) reimplements it over the raw rows in its own module, and a pure test holds its output equal to the production function's over the same frozen fixture, wherever that fixture parses under the current schema once the step's own keys are set aside;
- `questionPaths.ts` walks the raw carriers itself ("The matching algorithm");
- the case-schema check compares stored rows with the target's derivation and reads no old document ("After the last step").

**Arguments.**

| Script | Argument | Meaning |
|---|---|---|
| scan | (none) | Scans the local database. |
| scan | `--prod` | Reads production as the operator's gcloud identity (`scripts/lib/prodDb.ts::targetProdDb`, read only). |
| scan | `--app <id>` | One app. |
| scan | `--debug-details` | Requires `--app`. Prints that app's entity ids and names. Never used against production output that leaves the operator's terminal. |
| migrate | (none) | The dry run: builds the full plan, HQ reads included, and prints the report and `planDigest`. It writes nothing: no DDL, no row, no key-readers record ("The key-readers record"). This is the advisory scan with HQ reads and the Job's stored default. |
| migrate | `--settle-holders` | Settles every lapsed or paused run holder through the production reapers, prints counts, and exits. Writes only what an ordinary claim on the old revision would write. |
| migrate | `--rehearse` | Applies the ledgered DDL, builds the plan, prints `planDigest`, runs the whole fleet transaction and ends it in a sentinel rollback, so beyond the DDL it leaves nothing, the key-readers rows included. Only inside the window, since it takes the locks. |
| migrate | `--execute --expect-plan-digest <sha256>` | Applies the ledgered DDL, rebuilds the plan, refuses when its digest is not the expected one (it prints the new digest and stops with nothing written), then runs the writer and commits. It is the only mode that leaves a key-readers row. |
| migrate | `--transient-as-unreadable` | With `--rehearse` or `--execute`, in a second window only: a deployment still transient after its attempts is classed `unreadable`. |
| migrate | `--without-hq` | Local databases, the clone rehearsal and tests only: makes no HQ request, decrypts nothing, and classes every deployment `unreadable`. The Job's allowlist does not admit it. |
| migrate | `--prove-decrypt <ciphertext>` | Local only: decrypts the one given ciphertext through `kmsDecrypt.ts` and prints `ok` or `failed`, never the plaintext. Opens no database connection. The Job's allowlist does not admit it. |

The scan makes no HQ request and decrypts nothing, by decision: a member's key is decrypted only inside the Job. It runs the transform with every deployment classed `unreadable`, exactly as `--without-hq` does, so step `app-settings` writes `true` for both settings there; its blocker counts are exact for every code, because no blocker depends on an HQ read. `--prod --execute` does not exist on either script; a production write runs only through the Job.

**Already applied, checked first.** Every mode of the migrate script first reads, in one statement, how many `apps` rows carry the marker batch `fold-baseline:hq-round-trip-emission`. All of them: it prints `already-applied` and exits 0, with no HQ request, no decrypt and no plan, because the old-shape reader must never run over new-shape rows. Some and not all: it refuses, since that state cannot come from this writer. None: it goes on. The fleet transaction repeats the count under its locks.

**The plan and its digest.** `plan.ts` builds one `CutoverPlan` for the fleet:

```ts
interface CutoverPlan {
  readonly format: "hq-round-trip-emission-1";
  readonly apps: readonly AppPlan[];               // ordered by app id
  readonly lookupTagRenames: readonly TagRename[]; // ordered by Project id, then table uuid
  readonly digest: string;                         // lib/utils/canonicalJson.ts::canonicalJsonDigest of everything above
}
interface AppPlan {
  readonly appId: string; readonly projectId: string;
  readonly baseSeq: number; readonly baseDigest: string;   // of the raw carriers as read
  readonly targetDigest: string;                            // canonicalJsonDigest(target)
  readonly blockers: readonly CutoverBlocker[];             // content-free codes
  readonly changes: readonly DocumentChange[];
  readonly caseSchemaRewrites: readonly string[];           // case types whose stored schema row step option-values moves, sorted
  readonly discardsPrivateWork: boolean;                    // an open workspace or change set of this app is abandoned
  readonly deployments: readonly DeploymentPlan[];          // ordered by deployment id
}
interface DeploymentPlan {
  readonly deploymentId: string; readonly server: string; readonly domain: string;
  readonly outcome: "read-in-full" | "no-form-ids" | "deleted" | "unsupported" | "unreadable" | "transient";
  readonly buildSpecVersion: string | null;                 // the source read's buildSpecVersion (HQ's build_spec.version); null when no source was read
  readonly identities: readonly DeploymentIdentityOverride[];
  readonly appBaseline: {                                   // null for "deleted"
    readonly origin: "cutover" | "unread";
    readonly normalizedSource: string | null;               // canonical JSON text; null when unread
    readonly sourceDigest: string | null;
    readonly ownership: AppOwnership | null;                // as hqImportApplication returns it
    readonly observedAt: string;
    readonly observedBy: string;                            // user id whose key answered, or the system actor
  } | null;
  readonly resourceBaselines: readonly {
    readonly kind: "lookup-table" | "location"; readonly remoteId: string;
    readonly origin: "cutover" | "unread";
    readonly canonical: CanonicalLookupTable | CanonicalPlace | null;
    readonly digest: string | null;
    readonly observedAt: string; readonly observedBy: string;
    readonly observedFromAppId: string;
  }[];
  readonly keyUses: readonly { userId: string; firstUsedAt: string; lastUsedAt: string }[];
  readonly notices: readonly DeploymentNoticeReason[];
}
```

- **What the writer needs is in the plan.** `source_gzip` and `source_bytes` are computed by the writer from `normalizedSource`; every other column of `app_deployment_baselines` and `project_space_resource_baselines` (part 02, The ledger schema) is a field above. `app_deployment_baselines` has no form-id column, so the plan carries none: the stored form ids the cutover reads go to `app_deployment_identities` and nowhere else.
- **Ownership.** `plan.ts` calls `lib/deployment/importApplication.ts::hqImportApplication` over the app's target document with the deployment's identity overrides and the source it read, and stores the `AppOwnership` that call returns. So the Job runs the new emitter once per readable deployment; the body it builds is discarded.
- **`observedFromAppId`** for a resource two apps of one Project share in one project space is the lowest app id whose deployment read it, and `observedBy` is the member whose key answered that app's read.
- **In the digest:** `sourceDigest`, `ownership`, each resource's `digest` and `canonical`, `origin`, `outcome`, `identities`, `notices`, `caseSchemaRewrites`, `discardsPrivateWork`. **Outside it:** `normalizedSource` (its digest stands for it), every `observedAt`, every `observedBy`, `observedFromAppId` and `keyUses`, because which member's key answered and when may differ between two runs that read the same state.

- The digest is what makes the frozen proof exact: the execute run rebuilds the plan from the database and from HQ and refuses when anything moved since the rehearsal.
- A baseline enters the digest as the digest of its normalized form (form ids as positions; part 02, Work item B: the drift check and its baselines). The raw source cannot be digested, because every source read carries fresh form ids (`models/applications.py::Application.scrub_source`, `util.py::update_form_unique_ids`).
- The plan holds normalized app sources, which are client content. It lives in the Job's memory for one execution; the only place a source is written is its `app_deployment_baselines` row.

**The report.** Content-free by construction: stable ids, codes and counts, never an authored name, never a source. Both scripts print it as one JSON object; the migrate script's also carries the HQ half. A list of the entities a step or a line touches (the forms whose generated data paths move, each root keyed create with the operations that look its cases up, each question a step renames) is the report's detail and never part of that object: the report gives the count per app, and `--debug-details --app <id>` prints that app's entities by id and name, on the operator's terminal only. Where another part says the advisory scan names or lists such entities, this is where and how.

| Section | The scan prints | The Job's dry run adds |
|---|---|---|
| Fleet | apps scanned, apps deleted, apps with a deployment | `planDigest`, peak RSS and duration (the capacity proof) |
| Transform steps | for each step id in order, the count of apps it changes and the count of changes | |
| Behavior lines | for each no-write reason, the count of apps and entries | |
| Generated data paths (from pull request 7) | per app, the count of forms whose generated-node plan holds a renamed node, a block inside a group or a new leaf (`nova_caseid_`, `nova_trimmed_`), and the count of forms where the plan's `nova_count_` or `nova_constraint_message_` name differs from today's (expected 0) (part 05, Reserved names and wrapper containers (defect 13)) | |
| Root keyed creates (from pull request 6) | per app, the count of root creates that carry `idFrom` and the count of operations that target the same case type by expression (part 05, The root create id (defect 13)) | |
| Blockers | for each blocker code, the count and the app ids | |
| Holders | apps and design sessions with a live holder; with a lapsed or paused holder | |
| Private work | open `authoring_workspaces` and `design_change_sets` that will be abandoned, and the apps they belong to; pre-app build sessions that will end | |
| Case schemas | per app, the case types whose stored schema row step `option-values` moves | |
| Lookup tags | per Project id, each table uuid whose tag is renamed, the referencing app ids, and each live mapping whose `pushed_identity` is the old tag | each mapped HQ table that holds a field property, a row attribute or is not global |
| Deployments | count per server; the count of live `app` mappings with a null `pushed_revision` | count per outcome class; for every deployment its id, class and CommCare version (the source read's `buildSpecVersion`) beside the floor (`2.57`), with the count below it; unpaired menus and forms per deployment as counts; each key use as user id, server, domain and time, which are content-free, so the execution log is the operator's record of the keys an advisory run or a rehearsal sent |
| Settings | | apps whose `showSavedForms` or `showIncompleteForms` will be `false`; deployments whose HQ value changes at their next publish; deployments that get `worker-settings-reset-at-next-publish` |

Exit status is 1 when any blocker, live holder or transient outcome exists.

**Blockers** (each stops the cutover before its first write, for a person to resolve in the owning app or the owning step's code; none is expected):

| Code | Meaning |
|---|---|
| `target-parse`, `target-gate`, `target-export-readiness` | The transformed document fails `blueprintDocSchema`, `mutationCommitVerdict(target, [], lookupContext)` or `exportReadinessFindings`. |
| `case-schema-change` | A stored `case_type_schemas` row differs from what the new code derives from the target, for a case type that step `option-values` did not change, or in anything but the option sets that step changed; or a case type is added or retired; or the planned rewrite would change an index. The cutover writes no case row. It rewrites a schema row only for the option sets step `option-values` moves ("After the last step"). |
| `unresolved-relative-path` | A relative path in an XPath text run names a renamed question and does not resolve through the form tree. |
| `link-identifier-reserved` | A link identifier starts with an underscore, or is `instance`, `bind` or `parsererror`. It is the index name on cases already in HQ and in Nova's case store, so the cutover never renames it. |
| `reserved-property-write` | A case property named `instance`, `bind` or `parsererror` is written by a block in a form's source. A property name is the identity of data on existing cases. |
| `app-mapping-without-pushed-revision` | A live `app` mapping made before step 2 holds a null `pushed_revision`. `remoteAppHoldsContent` (part 01, A3. The publish sequence) is sound only while none does; today's one writer never makes one. |
| `lookup-tag-unparsable` | A renamed tag fails `lib/lookup/schema.ts::lookupTagSchema`. |

## Reading HQ

The cutover is the only place in step 2 where a key other than the acting person's reads HQ. It has no acting person.

**Where the reads run.** In one Cloud Run Job, `commcare-nova-hq-round-trip-cutover`, as the migration identity (`nova-migrate@`), so members' decrypted keys and their apps' sources stay in one process inside the project for the length of one execution. The same Job makes one advisory dry run before the window (the person's decision), then the rehearsal and the execute inside it. Those three are the only runs that send a member's key: the scan, `--settle-holders`, the already-applied exit and `--without-hq` send none. Rejected: a maintainer's machine holding decrypted keys and app sources; a Job under the runtime identity, which may only read `app_change_fold_baselines` and so would have to hand client content to the writer through a new store.

**The grant.** `roles/cloudkms.cryptoKeyDecrypter` (decrypt only) for `nova-migrate@` on the key `commcare-api-keys` alone, never on the key ring or the project, with an IAM condition that expires it (`request.time < timestamp("...")`). It is granted twice, each for a few hours: once for the advisory run, once for the window. The runbook revokes it in its closing step whether or not it has expired. This rests on reading Google's IAM Conditions support for Cloud KMS resources; the runbook confirms it when it makes the first grant, and the decided fallback is the same binding without a condition, revoked by the command that follows the Job's exit. `nova-migrate@` is also the identity of every deploy's migrate Job, so no merge happens while a grant stands.

**The decrypt.** `kmsDecrypt.ts` calls the KMS REST `:decrypt` method with `google-auth-library`, which the Cloud SQL connector already brings into the maintenance bundle. It does not import `lib/commcare/encryption.ts`. Reason: the maintenance image holds only `*.cjs` bundles with no `node_modules` (`Dockerfile`, stage `maintenance`), and no bundle there carries a gax client today. A key is decrypted at the moment of each use, kept in process memory only, and never placed in the plan, the digest input, a log line or an error.

**What is read, per deployment with a live app mapping** (deployments of deleted Nova apps included, so a restored app keeps its ids):

| Read | Client | Gives | HQ requires |
|---|---|---|---|
| App source | `lib/commcare/hq/appSource.ts::readHqAppSource` (created in pull request 3; part 01, A3. The publish sequence) | `doc_type`, each menu's `unique_id` and case type in order, each form's `xmlns` in order, each form's XForm from `_attachments`, `build_spec`, `langs`, `profile` | edit-apps (`views/apps.py::app_source`) |
| Form ids | `hqRead.ts::readHqApplicationFormIds`, new and removed with the tooling: the detail of `ApplicationResource` at `/a/<domain>/api/v0.4/application/<app id>/`, through `lib/commcare/hq/readJson.ts::readHqJson` | each menu's `unique_id`, each form's stored `unique_id` and `xmlns` in order (`corehq/apps/api/resources/v0_4.py::ApplicationResource.dehydrate_module`) | API access and the `access_api` permission |
| Lookup tables | `lib/commcare/hq/lookupTables.ts::listHqLookupTables`, then `lib/commcare/hq/lookupTables.ts::readHqLookupTableRows` (part 02, Defect 5: the lookup push), which reads `corehq/apps/fixtures/resources/v0_1.py::FixtureResource` filtered by `fixture_type_id` | each live `lookup-table` mapping's definition and rows | edit-data |
| Places | `lib/commcare/hq/locations.ts::listHqLocations` | each live `location` mapping's place | locations access |

Why two reads for identity: the source read mints a fresh `unique_id` for every form on every read and leaves menu ids and `xmlns` untouched, so it never shows the stored form ids; `ApplicationResource` shows them as stored.

**Credential order.** For each deployment: its `created_by` while a current member of the app's Project, then every other current member in the order they joined (`auth_member."createdAt"`, then `userId`). A member is skipped, with no request, when they have no stored key, their stored `commcare_server` is not the deployment's, or their `approved_domains` does not hold the deployment's domain (`lib/db/settings.ts::resolveUploadTarget`'s three facts). Each of the four reads falls back separately: a 401 or 403 on one read moves that read to the next member and leaves the others where they are.

**Classification of one request.** `lib/commcare/hq/readJson.ts::readHqJson` folds every failure into a status today (a network failure becomes 503, an unparsable body 502), which cannot tell transient from unreadable. `lib/commcare/hq/http.ts::CommCareApiError` gains an optional `cause: "network" | "timeout" | "malformed"`, set where `readHqJson` and `readHqCollection` synthesize a status. That field is permanent: the drift read (part 02, Work item B: the drift check and its baselines) needs the same distinction. `hqRead.ts` maps to:

```ts
type HqReadOutcome<T> =
  | { kind: "ok"; value: T }
  | { kind: "refused"; status: 401 | 403 }          // next credential
  | { kind: "gone" }                                 // the app is deleted, in either form
  | { kind: "unsupported"; docType: string }         // a linked or a remote app
  | { kind: "transient"; cause: "no-answer" | "timeout" | "5xx" | "429" | "edge" }
  | { kind: "unreadable"; cause: "redirect" | "400" | "malformed" | "other-status" };
```

- `gone`, for the source read: a 404, or a 200 whose `doc_type` ends `-Deleted`. HQ's ordinary delete is soft: `util.py::app_doc_types` holds the `-Deleted` types, so `dbaccessors.py::get_app` wraps such a document and the source read answers 200 for it. A reader that classed by 404 alone would file every soft-deleted app as readable.
- `unsupported`, for the source read: a 200 whose `doc_type` is neither `Application` nor a `-Deleted` type, which is a linked or a remote app. It is `readHqAppSource`'s own `unsupported` answer (part 01, A3. The publish sequence).
- `malformed`: a body that is not JSON or fails the reader's shape check, a missing `build_spec` included.
- For the form id read a 404 is `gone` too; it changes nothing about the deployment's class when the source read answered.
- `edge`: `lib/commcare/hq/http.ts::isEdgeRefusal`. The status is a proxy's and HQ never saw the request, so it says nothing about the key.

**Attempts.** Each request gets up to three attempts on a transient outcome (wait 2 s, then 8 s, honoring `Retry-After` up to 60 s), each under `lib/commcare/hq/deadline.ts::withHqRequestDeadline`. At most eight requests are in flight per HQ server. No database lock spans an HQ request: every read finishes before the write transaction opens (`lib/deployment/CLAUDE.md`, "No lock spans the CommCare HQ round trips").

**Classification of one deployment.**

| Class | When | What the cutover records |
|---|---|---|
| `read-in-full` | The source read and the form id read both answered, and the two aligned. | Identity overrides for every paired menu and form; a `cutover` baseline. |
| `no-form-ids` | The source read answered; and every credential's form id read was refused, or that read's outcome is `gone` or `unreadable`, or a module came back as `{error}`, or a form's `xmlns` at its position differs between the two reads. HQ answers 401 to that read both for a space without API access and for a temporary API cutoff (`corehq/apps/api/resources/__init__.py::HqBaseResource.dispatch`), and Nova does not read HQ's wording to tell them apart. | Menu ids and `xmlns`; no form `unique_id` for the affected forms; a `cutover` baseline. Notice `form-ids-change-once`, naming the affected forms. |
| `deleted` | The source read answered `gone`. | `remote_missing_at` on the live app mapping with the folded `remote_app_missing` failure; no baseline. Notice `ended-app-deleted`. |
| `unsupported` | The source read answered `unsupported`. | No identity rows; an `unread` baseline (`observed_by = 'system:hq-round-trip-emission'`), so the ledger's rule that every live app mapping has a baseline or `remote_missing_at` holds. Notice `hq-app-not-nova-made` and no other identity or drift notice: publish refuses such an app outright with `hq_app_state_unknown` (part 01, A3. The publish sequence), so "the next publish asks before it writes" would be untrue for it. |
| `unreadable` | Every credential was refused on the source read, no credential qualifies, or the outcome is `unreadable`. | No identity rows; an `unread` baseline (`observed_by = 'system:hq-round-trip-emission'`). Notices `ids-change-once-unreadable` and `next-publish-asks-before-overwriting`. |
| `transient` | A read is still transient after its attempts. | Nothing. **One transient deployment stops the cutover before its first write.** The Job exits 1 naming the deployment ids, and the window closes with nothing changed. A second window passes `--transient-as-unreadable`. |

A table or place read that fails for a reason other than transient gives that resource an `unread` baseline and leaves the deployment's class alone.

**The key-readers record.** The person's decision is that each use of a member's key is recorded and shown to that member. The plan meets it for the run that changes anything, and states the one gap it leaves.

- **The advisory run writes nothing**, and neither does a rehearsal: the dry run opens no write transaction, and the rehearsal's rows go with its sentinel rollback. A run that stops (a digest refusal, a transient deployment, a blocker, a live holder) writes nothing either.
- **The execute run records each member whose key it sent**, answered or refused, one row per member, server and domain, inside the fleet transaction beside the notices (step 10), as the migration role:
  ```sql
  INSERT INTO app_migration_notice_key_readers (cutover, user_id, server, domain, first_used_at, last_used_at)
  VALUES ('hq-round-trip-emission', $1, $2, $3, $4, $5)
  ON CONFLICT (cutover, user_id, server, domain) DO UPDATE
    SET first_used_at = LEAST(app_migration_notice_key_readers.first_used_at, EXCLUDED.first_used_at),
        last_used_at  = GREATEST(app_migration_notice_key_readers.last_used_at, EXCLUDED.last_used_at)
  ```
  Reason for writing it in the fleet transaction: the record then exists exactly when the cutover does, the table needs no statement ahead of the ledgered migration, and a restore of the window's backup needs no row re-inserted by hand.
- **Why that is enough in the ordinary case.** The advisory run and the rehearsal read with the same credential order as the execute run, so the members whose keys they send are the same members unless a Project's membership or a stored key changed in between. The runbook holds the advisory run to within three days of the window, and repeats it when the window slips, to keep that interval short.
- **The gap, stated.** A member whose key only the advisory run used, because they left the Project, changed their key or lost the domain before the window, gets no home line. This narrows the decision as worded (each use recorded and shown), and it is decided, for one reason: showing an advisory use would need a row written before the window, and the advisory run writes nothing. The use is not unrecorded: every run prints each key use in its content-free report (user id, server, domain and time), and the runbook archives the advisory run's and each rehearsal's execution log with the cutover's evidence.

A row is keyed to the cutover and the project space, never to an app, so a key use needs no notice to hang from and a member who can no longer reach the app is still told. The home page shows that member a line until they dismiss it (work item F).

## The matching algorithm

Matching pairs what HQ holds with Nova's entities so an existing project space keeps its menu ids, form ids and `xmlns`.

**Inputs.**

- **Nova side**, per form of the PRE-migration document, before any transform step runs: the set of authored leaf paths. Its definition is the set of `location.path.toXPath()` over `lib/commcare/xform/caseOps.ts::collectFieldLocations(doc, formUuid)` for fields that are not containers, per form of `lib/commcare/emissionPlan.ts::emissionPlan(doc)`. Reason: an authored question's path is its container chain's ids and its own id, which is what the pre-step emitter wrote, so no frozen copy of the old emitter is needed; and the id steps rename question ids, so the paths must be taken first.
  - `questionPaths.ts` computes that set from the raw carriers and calls neither function, because neither accepts a pre-step document at the head of the stack. It walks module order, each module's form order, each form's `fieldOrder` from the root, and each field's `id` and `kind`; a container (a field with a `fieldOrder` entry) adds its `id` as a path step and no leaf; a query-bound repeat adds the step `item` after its own; the hidden no-matches menu is the menu made for the raw module's no-matches form, with the uuid `lib/commcare/emissionPlan.ts::syntheticModuleUuid` gives it (that function takes a uuid, not a document).
  - A pure test, written in pull request 2 where the pre-step schema is still the tree's, holds `questionPaths.ts`'s output equal to the definition above for every frozen fixture, and commits the result beside each fixture as `paths.json`. From then on the test holds `questionPaths.ts` to `paths.json`, which needs no production function.
- **HQ side**, per form of the source read: parse the XForm with `lib/commcare/xmlParse.ts`, take the first child of the model's first `<instance>`, and collect the path of every element that has no element child. Drop every subtree whose root element's name starts with `__nova_` (the pre-step validator refuses that prefix on an authored id, so nothing authored is lost). Drop a leaf the Nova form does not hold whose name starts with `nova_count_` or `nova_constraint_message_`. `matching.ts` holds its own three literals, `__nova_`, `nova_count_` and `nova_constraint_message_`, and imports none of them from `lib/commcare`: pull request 7 deletes `lib/commcare/constants.ts::RESERVED_XFORM_NODE_PREFIX` and folds `lib/commcare/xform/repeatCountNode.ts::repeatCountNodeName` and `lib/commcare/xform/constraintMessage.ts::ConstraintMessageNames` into `generatedNodes.ts` (part 05, Reserved names and wrapper containers (defect 13)), and the matcher reads forms HQ holds from before the step. Those three symbols are named here only as where the pre-step emitter got the names. These are element names read from the parsed tree, never a pattern over XML text. Without the two `nova_` exclusions a form whose every question has a reference-bearing validation message would hold exactly half shared paths and fail the rule below.

**Forms.**

1. For every HQ form and every Nova form, count the paths they share.
2. A pair is a candidate when the shared count is more than half of the HQ form's path set.
3. Take candidates in descending shared count. Ties break by equal position (the same menu index and form index on both sides), then lower HQ position, then lower Nova position.
4. A form already taken on either side is skipped.
5. An HQ form with an empty path set shares nothing, so it is never a candidate and stays unpaired. It takes its derived ids and `xmlns` once, under `menu-id-changes-once`. Nothing is lost by that: a form with no authored question has no submissions whose `xmlns` a report could depend on that Nova could tell apart from another empty form.

**Menus**, after the forms. This is the research's rule, unchanged: one to one, by matched forms.

1. For every pair of an HQ menu and a Nova menu that share at least one paired form, count those forms. Take pairs in descending count; ties break by equal position, then lower HQ menu position, then lower Nova menu position. A menu already taken on either side is skipped.
2. A Nova menu with no forms pairs with an untaken HQ menu at its position that has the same case type and no forms.
3. Nova's hidden no-matches menu is a Nova menu like any other here; its uuid is `lib/commcare/emissionPlan.ts::syntheticModuleUuid` of its form.
4. A menu whose forms are all unpaired is unpaired, and takes its derived id once under `menu-id-changes-once`.

**Alignment of the two reads.** By menu `unique_id`, then form position, and the form's `xmlns` in `ApplicationResource` must equal the source's at that position. A mismatch leaves that form's stored id unknown.

**What is recorded** (`app_deployment_identities`, sparse, written only by the cutover):

- one `module` row per paired menu whose HQ `unique_id` differs from the derivation;
- one `form` row per paired form, with HQ's `xmlns` where it differs from the derivation and HQ's `unique_id` where the reads aligned and it differs;
- a value equal to the derivation is dropped through the same pure function publish's `targetWireIdentity` is tested against;
- an unpaired entity gets no row and takes derived ids at its next publish, once (notice `menu-id-changes-once`, naming each);
- an HQ id equal to the derived id of a different entity of the same app is never recorded: that entity takes its derived id (and, for a form, its derived `xmlns`) once under `menu-id-changes-once`, and the cutover goes on. Two entities of one export can then never share an id. It is no blocker, because HQ holds the id and nothing a person could change in the app or in a step resolves it.

## The transform steps, in order

A step is one module under `scripts/lib/hqRoundTripCutover/steps/`:

```ts
interface CutoverStep {
  readonly id: string;
  apply(doc: RawDocument, ctx: StepContext): readonly DocumentChange[];   // mutates a private copy
}
interface DocumentChange {
  readonly reason: DocumentNoticeReason;        // closed enum, work item F
  readonly entity: NoticeEntityRef;
  readonly detail?: Readonly<Record<string, string>>;
}
```

`transform.ts` runs them in the order below. The order is fixed because the steps interact: identity additions first, then removals, then renames (later steps name questions), then semantic moves, then case lists, then the settings step that takes the HQ-read values. A step that changes nothing a person or a worker sees returns no change. The steps run only after the matcher's Nova side has been taken from the untouched document.

- Every step is registered in `transform.ts`, and only a step that rewrites the stored document is a step. A change that writes nothing has no step: its line comes from `behavior.ts` ("Changes that write nothing and still get a line").
- `time-ordering` (13) runs before `hidden-from-menu` (14). That is the single order, and it overrides any sentence in this plan that puts them the other way: `time-ordering` only replaces comparisons and writes no flag, and `hidden-from-menu`, the only step that sets the flag, must see every `match-none` it wrote.
- A pull request inserts its step at its row's position, never at the end.

| # | Step id | Pull request | Rewrites | Notice reason, and what it names |
|---|---|---|---|---|
| 1 | `language-wire-codes` | 3 | Writes `localization.wireCodes` on every app with a stored localization root, as today's grouping gives the codes, so no deployed code moves. The step (`steps/languageWireCodes.ts`) reads today's grouping from `scripts/lib/hqRoundTripCutover/legacyLanguageWireCodes.ts::legacyWireCodes(localization)`, a frozen copy of what `lib/commcare/languageWire.ts::planLanguageWire` computes today, because that file no longer has it. | none |
| 2 | `media-slots` | 14 | Deletes `hint_media`, `validate_msg_media`, and `label_media` on groups and repeats. The asset stays in the Project's library. | `media-slot-removed`: the form, the field, the slot and the media kind |
| 3 | `hidden-inert-default` | 14 | Removes a Hidden Value's `default_value` that is structurally the one-part text `''` beside no `calculate` (the retired `HIDDEN_INERT_VALUE`). | `hidden-value-saves-blank`, only for a field that writes a case property the form does not preload (`lib/domain/casePreload.ts::writerPreloadsFromLoadedCase`): the form, the field, the property |
| 4 | `search-button-label` | 12 | Deletes `searchButtonLabel` and each language's `search-button` translation entry. | `search-button-text-changed`: every menu with a search, with its former text (the stored label, or "Search" where none was stored) |
| 5 | `question-ids` | 10 | Renames each question id the narrowed grammar refuses (a leading underscore, a leading `XML`, `meta` in any case, and finding 43's `instance`, `bind`, `parsererror`) through `lib/domain/questionId.ts::editorSafeQuestionId` (new in pull request 10; part 08, Defect 15: identifiers HQ's editors refuse), suffixed until free among its siblings, valid sibling ids taken first. References that store the uuid follow by construction. A relative path in an XPath text run is re-resolved step by step against the form tree with the Lezer parser and its renamed step rewritten; an unresolved match is the blocker `unresolved-relative-path`. | `question-renamed`: the form, the field, `from`, `to` |
| 6 | `case-operation-ids` | 10 | Renames each case operation id the question grammar refuses, the same way. Link identifiers are never renamed (blocker `link-identifier-reserved`). | `case-operation-renamed`: the form, `from`, `to` |
| 7 | `connect-ids` | 10 | Renames each Connect block id the grammar refuses, unique across the app and shortened at the tail so the id with its suffix fits 50 characters. | `connect-block-renamed`: the form, the block kind, `from`, `to` |
| 8 | `entry-point-ids` | 10 | Rewrites each entry-point id that is not a fixed point of HQ's slug rule, unique across the app, `entry` when nothing survives. | `entry-point-renamed`: the entry point, `from`, `to` |
| 9 | `option-values` (finding 44) | 10 | In each select, the first option holding a value keeps it and each later one becomes `lib/domain/idSlug.ts::suffixUntilFree(value, taken)` (`yes_2`), with a field and its catalog property kept in agreement, by a planner in the step module written to the rules of `scripts/lib/selectOptionValueRepair.ts::planSelectOptionValueRepair` (part 08, Finding 44: duplicate option values, gives the allocation). No case row is rewritten. A catalog property's option set is part of its case type's stored schema, so the step returns the case types it touched and the writer rewrites those schema rows ("After the last step"). | `option-value-split`: the form and the field, or the app with the case type and property for a catalog list; the shared value, the new value |
| 10 | `empty-forms` (finding 31) | 10 | Adds one Label to each form that holds fields and no question: at the root, or inside the first section of a sectioned form, id `note` suffixed until free, text "This form has no questions yet." as the Label's own text. | `empty-form-label-added`: the form |
| 11 | `root-create-id` | 6 | Writes `target: { kind: "new" }` on each root create that carries `idFrom`. It touches no link target: a link whose target is kind `new` cannot be stored, because the gate refuses every one (part 05, The root create id (defect 13), decides it). | `root-create-id-generated`: the form, the operation, the case type, the key field. And `case-lookup-by-key-stops` for each operation of the app whose target is an expression over that case type: the form, the operation |
| 12 | `reserved-search-inputs` | 12 | Per menu, removing first and then renaming what remains. (a) Removes each own-key input whose name is in the reserved set (the surface's `csql-key` family minus `case_id` and `owner_id`, including a name that starts with `indices.`, and including an own-key input named `_xpath_query`, since a rename would make it start searching a property of the new name): every `when-input-present` over it takes its absent branch and every read of it becomes the empty string. That is the rewrite the production `removeSearchInput` reducer applies (`lib/doc/mutations/modules.ts`, with the dependents `lib/doc/searchInputMutations.ts::searchInputRemovalDependencies` finds), reimplemented over raw rows in the step module; a pure test holds the step's output equal to the reducer's over a fixture that parses under the current schema. (b) Renames each remaining input named `_xpath_query`, whose name is only a handle, to `_xpath_query_2` (suffixed until free). | `search-input-renamed`: the menu, the input, `from`, `to`. `search-input-removed`: the menu, the input, and the count of expressions that changed |
| 13 | `time-ordering` (defect 6) | 14 | Replaces, in place and with no simplification afterwards: a Predicate `gt`, `gte`, `lt`, `lte` or `between` with a time operand by `{ kind: "match-none" }`; a form-logic `<`, `<=`, `>`, `>=` with a time operand by `false()`, outermost first, re-parsed through `lib/commcare/xpath/expressionAst.ts::parseXPathExpression`; a CSQL `is-blank` on `date_opened`, `closed_on` or `last_modified`, or a fixed non-date value compared with one, by `match-none`. A runtime value is not migrated: the emitter guards it. No simple search input is migrated, settled at source: range mode is stored only on the `date-range` input, and `lib/domain/modules.ts::SEARCH_INPUT_TYPE_PROPERTY_TYPES` admits that input over `date` and `datetime` properties alone, so no stored input ranges over a time. | `time-comparison-never-true`: the carrier (field, form link, menu or form) and the comparison's printed text. `search-term-matches-nothing`: the menu and the term |
| 14 | `hidden-from-menu` | 12 | For each menu and form whose `displayCondition` is `match-none`, or an `and` whose first clause is `match-none` (step 13 can have just made one): sets `hiddenFromMenu: true` and keeps the remaining clauses as the condition. | `hidden-from-menu-set`: the menu or form, saying its condition already kept it off every device's menu, and what opens it on each platform |
| 15 | `post-submit` | 12 | Writes the nearest offered destination on each form whose effective destination is not offered (`previous` in a multi-select menu to `module`; `previous` or `module` under a multi-select parent to `firstMenu`). Writes `firstMenu` on each no-matches form that holds `app_home`, which sends the same bytes. | `after-submit-destination-moved`: the form, `from`, `to`, for the first kind only, including forms that relied on the default |
| 16 | `id-mapping-keys` | 11 | Removes each `id-mapping` entry whose `value` holds `&`, `<`, `>`, `"` or `'`, with its translations. | `id-mapping-entry-removed` |
| 17 | `date-patterns` | 11 | Turns each date column whose pattern is outside HQ's five into a calculated column that shows the same text, moving its order rule to a hidden plain column over the same property. | `date-column-became-calculation` |
| 18 | `tile-hidden-calculated-sort` | 11 | Removes the `sort` of each column `CASE_TILE_HIDDEN_CALCULATED_SORT` refuses in a tile list: a column hidden from Results that carries an order rule and is calculated or attribute-backed (it reads `case_id`, `owner_id` or `status`), as part 07, The corrected tile clause, scopes it. The column stays, with its place on Details. | `tile-order-rule-removed`: the menu and the column, with `detail.shape` (`calculated` or the property name) |
| 19 | `sort-property-ownership` | 11 | Removes a second order rule on one property, or moves a rule to the first column over its property. | `order-rule-removed-same-property`, `order-rule-moved-to-first-column` |
| 20 | `tile-cells` | 11 | Fills `horizontalAlign: "left"`, `verticalAlign: "top"`, `fontSize: "medium"` on every tile cell missing one. | `tile-cell-defaults-set` |
| 21 | `app-settings` | 5 | Writes `appSettings`. For each of `showSavedForms` and `showIncompleteForms`, over the app's deployments classed `read-in-full` or `no-form-ids` (a `deleted`, `unsupported` or `unreadable` deployment is not counted, though a deleted app's source carries a profile, because nothing will be published over it): `true` when there is none; otherwise `true` only when every one's `profile.properties` holds `yes` for `cc-show-saved` or `cc-show-incomplete`; otherwise `false`. This is the one document value that depends on an HQ read. | `android-form-lists-setting-stored`: the app, for any app with such a deployment, with both values |

Steps 16 to 20 are specified in part 07 (part 07, What this part moves, in one table, names the block of each); their copy is there.

### After the last step

1. The target is parsed with `lib/domain/blueprint.ts::blueprintDocSchema` and hydrated (`lib/doc/fieldParent.ts::hydratePersistedBlueprint`).
2. It is judged by `lib/doc/commitVerdicts.ts::mutationCommitVerdict(target, [], lookupContext)` with that Project's lookup definitions, read once per Project and never once per app, and by `::exportReadinessFindings`, the genesis writer's own pair.
3. **The case-schema check** reads no old document, so no production classifier is handed one. `plan.ts` derives the target's case schemas with the production derivation (`lib/case-store/store.ts::buildCaseTypeMap(target)`, the map the commit kernel hands the case store) and compares them, per case type, with the app's stored `case_type_schemas` rows:
   - equal: nothing to do, which is every case type of every app that step `option-values` leaves alone;
   - different only in the option sets of properties step `option-values` changed, on a case type that step returned: the case type joins `AppPlan.caseSchemaRewrites`, and the writer rewrites that one row in the fleet transaction through the case store's `applySchemaChangePhaseA(tx, { appId, caseType, caseTypeSchemas: buildCaseTypeMap(target), syncedSeq: baseSeq + 1 })`, the transactional admission `lib/db/appGenesis.ts` and `lib/db/canonicalCommitKernel.ts` call, so the stored row equals what a commit of the target would have written. An option set is no index input, so the returned `completeAfterCommit()` has nothing to do; the writer still awaits it after the commit, and a plan-time derivation whose index set differs from the stored row's is the blocker below;
   - anything else, an added or a retired case type included: blocker `case-schema-change`.
   Reason for accepting the one difference: the alternative, leaving the catalog property's duplicate values in place, makes the target fail the gate rule the step exists to satisfy.
4. `behavior.ts` reads the migrated document and returns the no-write lines below.

A second application of the transform to its own output changes nothing.

## Changes that write nothing and still get a line

These change what a worker, an export or a person sees with no stored change. `behavior.ts` emits the document lines from the migrated document, one exported selection function per reason, each added by the pull request that owns the reason; `notice.ts` emits the deployment lines from the documents and the deployment plans, with no probe of HQ. None of them is a step and none changes the document.

| Reason | Kind | Names | Says |
|---|---|---|---|
| `validation-now-enforced` (defect 8) | document | each barcode and secret question that holds a validation | Its validation now runs; workers see its message when an answer does not pass. |
| `follow-up-now-touches-case` (defect 14) | document | each follow-up form with no write, no close, no preload, no child case and no worker-record write in a single-select menu | Submitting it now moves its case's last-modified date, which case update rules and data forwarding in HQ read. |
| `close-moves-to-save-to-case` (defect 14) | document | each close form in a single-select menu whose close condition a Case Management tab cannot state (placement `save-to-case`; part 06, 2. Close conditions the Case Management tab cannot state). A close in a multi-select menu gets no line: it is already a Save to Case close | Its close is written another way; the HQ form shows no close in Case Management, and its next publish asks about one more plan feature. |
| `lookup-choices-order-changes` (defect 14) | document | each lookup-backed search input | Its choices are listed in the order of their labels, not the table's row order. |
| `survey-menu-takes-case-type` (defect 14) | document | each survey-only menu that has a case type | HQ shows that case type on the menu from the next publish. |
| `case-list-order-changes`, `case-list-search-matches-hidden-fields`, `hidden-order-column-not-in-sort-menu`, `record-id-column-now-shows` | document | part 07, What this part moves, in one table | |
| `local-archive-changes` (defect 9, findings 34 and 40) | document | every app, entity the app | Part 04, the blocks of defect 9, finding 34 and finding 40: what a file downloaded from Nova now needs and resets. |
| `case-name-now-checked` (finding 33) | document | each form with a basic create or rename whose case name comes from a question a worker answers | A blank case name, or one over 255 characters, now shows the worker the runtime's invalid-answer message on that question, where nothing on the device checked it before. |
| `unsaved-assistant-work-discarded` | document | each app with an open `authoring_workspaces` or `design_change_sets` row the cutover abandons, entity the app | Work the assistant had not saved was not kept; the saved app is unchanged. Written by `notice.ts` from `AppPlan.discardsPrivateWork`, not by `behavior.ts`, because it is a fact of the database and not of the document. |
| `data-paths-move-once` (defect 13) | deployment | every deployment | The next publish moves the data path of every value Nova adds to a form (`__nova_*` becomes `nova_*`, case blocks sit inside groups), once. HQ form exports show those columns under their new names from then on. |
| `deep-links-need-republish` | deployment | every deployment of an app that has entry points | Links already shared keep opening. New ones can be made after the next publish there. |
| `next-publish-overwrites-hq-edits` (part 02, Work item B: the drift check and its baselines) | deployment | every deployment with a `cutover` baseline | The first publish writes over anything changed in HQ before the cutover; after that Nova asks first. |
| `next-publish-asks-before-overwriting` (part 02, Work item B: the drift check and its baselines) | deployment | every deployment with an `unread` baseline of any kind | Nova could not read what is there, so the next publish asks before it writes. |
| `next-publish-asks-more` (part 03, C2. Plan features: the per-privilege confirmation, C3 and C5) | deployment | each deployment whose app needs a plan feature, the flat location list or a newly checked capability | What the next publish will ask about. |
| `commcare-version-below-floor` (part 03, C1. The version floor) | deployment | each deployment whose app is below 2.57, with its version | The next publish waits until the app's CommCare version is raised in HQ. |
| `logo-upload-in-hq` (part 03, C6. Defect 14: logos) | deployment | each deployment of an app with a logo | After the next publish the logo shows once it is uploaded in HQ. |
| `setting-changes-at-next-publish` (defect 7) | deployment | each deployment whose `cc-show-saved` or `cc-show-incomplete` differs from the stored value | The Android home screen there changes at the next publish. |
| `settings-unknown-unreadable` (defect 7) | deployment | each `unreadable` deployment | Nova could not read its two settings there; the next publish sets them to the app's. |
| `worker-settings-reset-at-next-publish` (finding 40) | deployment | each `read-in-full` or `no-form-ids` deployment whose `profile.properties` holds no value (absent, null or empty) for at least one of `cc-fuzzy-search-enabled`, `cc-autoup-freq` and `cc-enable-tts` | After the next publish each app update resets those three worker settings. The publish seeds the keys only where the target holds no value, and HQ's build then writes each with `force`. Written by `notice.ts` from the deployment plan's source, with no further HQ request. |
| `hq-app-not-nova-made` (part 01, A3. The publish sequence) | deployment | each `unsupported` deployment | The app there is a linked app, so Nova cannot publish to it. |
| `lookup-table-content-unsupported` (defect 5) | deployment | each deployment whose mapped table holds a field property, a row attribute or is not global | Its next publish stops until the table gets a new export tag. |

The identity reasons (`menu-id-changes-once`, `form-ids-change-once`, `ids-change-once-unreadable`, `ended-app-deleted`) are in "The matching algorithm" and part 01, A1. Derived ids, and why `Form.xmlns` is not stored.

Two changes a person could notice get no line, each for a stated reason:

- **Finding 48** (a search answer holding both quote marks). On Android the worker got no results before, under the app's generic error text, and gets no results now, under the empty-results message. No stored thing and no result changes, it depends on one answer and not on the app, and the builder and `content/docs/case-workspace.mdx` say it.
- **Defect 3** (HQ's exports and data dictionary list the properties case operations write). It only adds: no column, property or report a person has in HQ changes or leaves. `content/docs/publishing.mdx` says it.

## Job steps outside the per-app transform

Three writes belong to the Job and not to a document:

| Step | What | Where specified |
|---|---|---|
| Lookup tag rename | For every `lookup_tables` row whose tag contains `casedb` or `ledgerdb`, referenced or not: `lookupTags.ts::renamedReservedTag(tag, takenTags)`, written through `lib/lookup/writerTransaction.ts` inside the fleet transaction with `updated_by = 'system:hq-round-trip-emission'`, so the definition revision advances. No document changes: a reference is the table's uuid. It runs before the per-app gate, because an app that references such a table fails the new gate until the rename. Notice `lookup-tag-renamed` on each referencing app. | Part 02, Defect 5: the lookup push |
| Deployment identities and `remote_missing_at` | `app_deployment_identities` rows per "The matching algorithm"; for a `deleted` deployment, `remote_missing_at` and the folded `remote_app_missing` failure. | Part 01, A3. The publish sequence |
| Baselines | `app_deployment_baselines` (`origin` `cutover` or `unread`) and `project_space_resource_baselines` (`cutover` or `unread`), upserted in `(kind, remote_id)` order under the `observed_at` rule. `observed_by` is the user id whose key answered. | Part 02, The ledger schema |

The cutover writes these with raw statements in `writer.ts` as the migration role, never through `lib/deployment/store.ts`: every store writer re-proves an acting member under the app lock, and the cutover has none. `app_deployment_identities` being read-only to the runtime role depends on that.

## The fleet transaction, step by step

Before it opens, in this order: the already-applied count ("Scripts and their layout"); the ledgered DDL (`lib/case-store/migrate.ts::runCaseStoreMigrationsWithReport`, the same `Migrator` and ledger the deploy uses, under `--rehearse` or `--execute` only); the fleet read; the HQ reads; the plan and its digest check. Nothing but the DDL is written before the transaction opens.

One transaction for the whole fleet. Reason: the event, stream and workspace statements are fleet-wide anyway; a failure at any point rolls everything back, so "failure after the first write" can only mean failure after the commit; and the canonical-identity cutover ran this way over a larger rewrite.

1. `pg_advisory_xact_lock` on the cutover's key; `SET LOCAL lock_timeout`.
2. **The blocking scan under the migration's locks.** Lock every `apps` row `FOR UPDATE` in id order, and every `design_sessions` row. For each app, re-read `mutation_seq` and the raw carriers and compare with the plan's `baseSeq` and `baseDigest`; any difference stops the run. Refuse any present run holder or unsettled reservation (`lib/db/runLiveness.ts::runLeaseState`, `::designSessionLeaseState`). The actor generation gate is not taken: with ingress closed and no holder present, nothing contends for it.
3. **Already applied, re-checked under the locks.** The count every mode makes first is repeated here. Any app carrying the marker batch stops the run with nothing written: the first check let this run through, so a marker now means another writer ran in between.
4. **Archive mutation events**, the canonical cutover's statement verbatim, with its cardinality and byte-preservation check:
   ```sql
   UPDATE events SET kind = 'archived-mutation',
     event = jsonb_build_object('kind', 'archived-mutation', 'runId', event -> 'runId', 'ts', event -> 'ts',
                                'seq', event -> 'seq', 'source', event -> 'source', 'archived', event)
   WHERE kind = 'mutation';
   ```
5. **Clear live streams.** `UPDATE threads SET active_stream_id = NULL, active_holder_nonce = NULL WHERE active_stream_id IS NOT NULL OR active_holder_nonce IS NOT NULL`; `DELETE FROM chat_stream_chunks`; `DELETE FROM presence`.
6. **Abandon private work**, in this order because of the foreign key:
   - `UPDATE authoring_sessions SET active_candidate_id = NULL WHERE active_candidate_id IS NOT NULL`. Without it, `getWork` and `getWorkSnapshot` reopen the abandoned candidate and fold its base at a pre-horizon sequence, which no longer parses.
   - `UPDATE authoring_workspaces SET status = 'abandoned', updated_at = now() WHERE status = 'open'`.
   - `UPDATE design_change_sets SET status = 'abandoned', updated_at = now() WHERE status = 'open'`.
   - For each active pre-app build session that held open work: the writes of `lib/db/designSessions.ts::discardDesignSession`, through a new in-transaction function `abandonPreAppDesignSessionInTransaction(tx, row)` that `discardDesignSession` also calls from step 2 on, so the two cannot drift.
7. **Rename lookup tags** (above).
8. **Per app**, in id order:
   - rewrite the `case_type_schemas` row of each case type in `caseSchemaRewrites` ("After the last step");
   - write the root slots from `lib/db/blueprintRows.ts::blueprintScalars(target)`, `app_settings` among them, and the columns `lib/db/canonicalCommitKernel.ts::denormalize` derives;
   - delete and reinsert every `blueprint_entities` row from `::decomposeBlueprint(target)`, so every row carries this transaction's `xmin`;
   - rebuild what the commit kernel maintains beside the entity write: exact media references (`::replaceExactMediaReferencesForApp`), lookup edges, location references and `::applyOrganizationCommitIntegrity`;
   - set `mutation_seq = baseSeq + 1`. `apps.updated_at` is not set: bumping it would reorder every Project's app list by cutover order;
   - insert the marker `app_changes` row;
   - insert the baseline as `nova_current_app_change_fold_snapshot(app_id)` with its SQL digest, never a snapshot built in JavaScript, so the trigger's text comparison cannot disagree on key order.
9. **Ledger rows**: identities, `remote_missing_at`, baselines.
10. **Notices and key readers**: one `app_migration_notices` row per app that has at least one entry, and one `app_migration_notice_key_readers` row per member, server and domain in any deployment's `keyUses` ("The key-readers record"). Under `--rehearse` both go with the rollback.
11. **Postconditions** (below), still inside the transaction.
12. `pg_notify('nova_app_stream', {appId, seq})` per app, then commit. Under `--rehearse` the transaction ends in a sentinel rollback here instead, as `runCanonicalRuntimeDatabaseProbe` does.

## Postconditions

Checked inside the transaction; any failure rolls the fleet back.

- Every app loads through `lib/db/canonicalCommitKernel.ts::loadAppInTransaction` (strict parse and the gate), and its `canonicalJsonDigest` equals the plan's `targetDigest`.
- `lib/agent/change-set/baseLoader.ts::loadCanonicalBlueprintAtSequence` at the new sequence, with `targetDigest` expected, folds from the new baseline.
- Every app's stored `case_type_schemas` rows equal what the new code derives from its target document, the rewritten rows included.
- No case row changed: the count and a digest of `cases` per app equal what was captured before step 4.
- No `apps` row holds a NULL `app_settings`.
- The count and the bytes of archived events equal what was captured before step 4, and no `events` row has `kind = 'mutation'`.
- No `authoring_workspaces` or `design_change_sets` row is `open`; no `authoring_sessions.active_candidate_id` is set.
- No `lookup_tables` row has a tag `lib/lookup/constants.ts::isReservedInstanceTag` refuses.
- Every deployment with a live app mapping has a baseline row or `remote_missing_at`.
- Every app with a planned entry has exactly one notice row for `hq-round-trip-emission`.
- Every member in any deployment's `keyUses` has an `app_migration_notice_key_readers` row for that server and domain whose span covers this run's use.

Assertions are about the transformation, never about the database the migration was cut from: schema placement and NULL `case_types` differ between a migrated test database and production.

## Where it runs

One Job, `commcare-nova-hq-round-trip-cutover`, in `config/deployment-jobs.json`: service account `nova-migrate@`, the resources of `commcare-nova-historical-repair` (4 CPU, 8Gi, `NODE_OPTIONS=--max-old-space-size=7168`, 3000 s, VPC egress to private ranges only, so HQ's public hosts are reached directly), `NOVA_DB_WORKLOAD=migration`, and `GOOGLE_CLOUD_PROJECT` for the key name. The explicit heap is a lesson the canonical-identity cutover paid for. Stored arguments `["hq-round-trip-cutover.cjs"]`, the dry run.

Allowlisted overrides in `scripts/rollout/deploy-cloud-run.py::_effective_execution_args`, exact:

- `(tool)`
- `(tool, "--settle-holders")`
- `(tool, "--rehearse")` and `(tool, "--rehearse", "--transient-as-unreadable")`
- `(tool, "--execute", "--expect-plan-digest", <64 hex>)` and the same with `"--transient-as-unreadable"` appended

`--without-hq` and `--prove-decrypt` are refused: they exist for a `docker run` of the image on the operator's machine, which the allowlist does not govern.

The bundle is one `esbuild` line in `Dockerfile` stage `maintenance-build` (`--outfile=hq-round-trip-cutover.cjs`). The migration role's connection limit is one (`scripts/infra/CLAUDE.md`), so the cutover Job and a deploy's migrate Job can never overlap.

## Deploy order and the operator runbook

The runbook is `docs/plans/hq-round-trip/2-cutover-runbook.md`, written in pull request 2 and completed as steps land. The pipeline holds no maintenance posture code (`scripts/rollout/deploy-cloud-run.py` has no posture or recovery action since #563), so the posture is hand-run commands, as the contract's "exceptional operator runbook" says.

**Three artifacts from two trees.**

- The **maintenance image** is built by hand (`docker build --target maintenance`) from the head commit of pull request 15's branch, the one beneath the removal. That commit never reaches `main`, because the merge squashes. The operator runs `manage-deployment.py job --image <digest>` and `deploy-cloud-run.py --execute-job` from a checkout of that same commit, because the Job contract and the allowlist arm exist only there.
- The **migration image** and the **application image** are built by Cloud Build from `main`'s tip after `gh stack merge <top> --squash`, whose tree is pull request 16's.

What has to hold, each a runbook check:

1. Pull request 16 differs from 15 only in tooling paths. `git diff --stat <15>..<16> -- lib app` shows nothing. Otherwise the gate that migrated is not the gate that probes.
2. `main` is frozen from the image build to the merge. A rebase of the stack after the image is built changes the tree, so the image is rebuilt and the advisory run repeated.
3. After the first `--rehearse`, every migration file of the stack "has run anywhere" and is immutable (`contracts.md`, "Instant migration"): its ledger rows commit outside the sentinel rollback. A fix to a stack migration after that point is a new migration file. Nothing is immutable earlier: the advisory run applies no DDL.
4. No deploy from `main` runs between the first `--rehearse` and the merge: the ledger then names migration files `main` does not hold, and Kysely's `Migrator` refuses a ledger with an executed migration it cannot find. The advisory run applies no ledgered migration and writes nothing, so a deploy between it and the window is safe.
5. The advisory run is within three days of the window. When the window slips past that, step 1(c) is repeated before it opens. Reason: the advisory run records no key use, and the short interval is what keeps the members whose keys it sent the same as the members the execute run records ("The key-readers record").

**The order.**

| # | Step | Reason |
|---|---|---|
| 1 | **Before the window.** (a) Read the key's IAM policy and the project's `roles/cloudkms.*` bindings. (b) Prove one decrypt in the real image against the development project's key: `docker run` the maintenance image with the operator's application default credentials mounted, `GOOGLE_CLOUD_PROJECT=commcare-nova-dev`, and `hq-round-trip-cutover.cjs --prove-decrypt <ciphertext>`, where the ciphertext is one `commcare_api_key` value copied from the operator's own row in the local development database. It prints `ok` or `failed`. (c) No more than three days before the window: make the first expiring grant; run `scan --prod` and the Job's dry run (the advisory scan with HQ reads, which writes nothing); revoke; archive that execution's log, which lists each key use. (d) Resolve every blocker in the owning app or the owning step's code, and repeat (c) if a step changed. (e) Rehearse on a clone: restore the latest automated backup to a temporary Cloud SQL instance in the same project; reach it through the Cloud SQL Auth Proxy on the operator's machine; `docker run` the maintenance image against the proxy with `NOVA_DB_LOCAL_URL` set to it, `NOVA_DB_WORKLOAD=migration`, and `hq-round-trip-cutover.cjs --rehearse --without-hq`; record its duration and peak RSS; delete the instance. The clone rehearsal makes no HQ request and decrypts nothing, so it uses no member's key and classes every deployment `unreadable`; what it proves is the transform, the gate and the fleet write over production's documents. (f) Announce the window to members, saying private unsaved work will not survive it. | The contract's advisory production scan. The clone rehearsal is the strongest dry run short of the window, and a local run of the image is not subject to the Job's allowlist. |
| 2 | **Open the window.** Confirm the advisory run is no more than three days old. Detach the public serverless NEG from the load balancer's backend service; pause the capture-cleanup Scheduler job; make the second grant. | Detaching the NEG leaves Cloud Run's own ingress setting alone, so the pipeline's `--ingress` flag cannot reopen it. |
| 3 | **Drain.** Run `scan --prod` until its Holders section reports no live holder; that section is read from the database alone, so polling it sends no member's key and starts no Job execution. Then the Job with `--settle-holders`, then `scan --prod` reporting no holder at all. | A run is not tied to its request and its lease heartbeat is a server timer (`lib/agent/generationContext.ts::startRunLeaseHeartbeat`), so a run in flight keeps working and committing with the NEG detached, for at most `cloudRunRequestSeconds` (3600 s, `config/runtime-capabilities.json`). Waiting is bounded at that hour; scaling the service to zero is not used, because `scripts/rollout/deploy-cloud-run.py::scaling_prestate` refuses a deploy that starts in manual scaling. Nothing reaps a lapsed or paused holder with ingress closed (reaping is claim-driven), and a fleet cutover cannot skip an app, so the Job settles them through `lib/db/apps.ts::reapScannedTargets` and `lib/db/designSessions.ts::reapStaleDesignSessionRun`. A paused build becomes reapable when its staleness window (`buildStalenessSeconds`, 600 s) has passed. |
| 4 | **Restore point.** An on-demand Cloud SQL backup, its id recorded. | The contract's verified restore point. |
| 5 | **Frozen proof.** `--rehearse`; record `planDigest`, peak RSS and duration. | The contract's blocking scan under the migration's locks, with the real writes rolled back. |
| 6 | **Migrate.** `--execute --expect-plan-digest <d>`. | Before the commit any failure rolls back and the window can simply close: reattach, resume, revoke. The additive DDL is safe under the old revision. After the commit, going forward is the plan; until the merge the restore point of step 4 remains a way back. |
| 7 | **Post-migration scan.** Revoke the grant. Then the Job's dry run prints `already-applied`, which shows it needs no key: that exit comes before any decrypt or HQ request. Resume the capture-cleanup Scheduler job. | `cloudbuild.yaml`'s `prerequisites` step runs `scripts/infra/manage-deployment.py check`, whose `::scheduler_findings` requires the job enabled, so a paused job would fail the deploy. This departs from the contract's order for one writer, stated: the contract resumes writers after the new image has proved it reads the shape, and the capture-cleanup worker resumes before the deploy because the deploy cannot start without it. Its database authority is `form_attachments` only, so it reads and writes nothing whose shape changed. |
| 8 | **Deploy.** `gh stack merge <top> --squash`. The migrate Job finds the ledger applied, converges privileges (which grants the new tables to the runtime role), and its probe proves every app parses and passes the gate under the new image; then the new revision takes all traffic. | The contract: the exact new image proves it can read the shape before ingress resumes. |
| 9 | **Resume.** Reattach the NEG as soon as `deploy` reports the candidate ready at 100%. Run the three public probes by hand. If the build's `verify` step gave up while the NEG was detached, re-run the build for the merge commit: the migration gate reuses its successful execution, the deploy makes one more revision of the same image, and `verify` passes. | `cloudbuild.yaml`'s `verify` step probes the public hostnames about a minute after `deploy` finishes, and the contract keeps ingress closed until the new image has proved it reads the shape. Reopening ingress before the deploy is not an alternative: the old revision would serve new-shape data and birth apps in the old shape. |
| 10 | **Close.** Archive the Job's execution evidence, then delete the Job definition (`docs/architecture/deployment.md`, "Historical repairs"). Watch the deploy check on the merge commit. | |

**Rollback decision.** Until the merge, the restore point of step 4 can be restored and the old revision reattached with nothing lost but what the capture-cleanup worker removed after step 7, which is expired staged captures only. A restore also removes the key-readers rows, which the execute run wrote in the fleet transaction; the cutover that follows a restore writes them again for the keys it sends, and the archived execution logs keep the content-free list of every use in between. After the new revision serves, the only way is forward.

**What the operator must confirm**, because none of it is in the repo:

- who holds decrypt on `commcare-api-keys` today, from the IAM read of step 1;
- the two grants, their expiry times and their revocation;
- the advisory run's date, no more than three days before the window, and its archived execution log;
- the window's length and its announcement;
- the load balancer's backend service and NEG names;
- the restore point's id;
- the diff check between pull requests 15 and 16, and that `main` stayed frozen;
- from the advisory report: every deployment's CommCare version against 2.57. HQ's default for a new app is not read by the cutover, and a deployment's version is HQ's default on the day that app was made, not today's. The version of the most recently created deployment in the report is the best indication available; whatever the default is, a new app below the floor stops at publish with the step to raise it in HQ.

**Local databases** go through the same script, with the condition every script that reaches `server-only` needs (`package.json`, `db:migrate`): `NOVA_DB_WORKLOAD=migration npx tsx --conditions=react-server scripts/migrate-hq-round-trip-cutover.ts --rehearse --without-hq`, then `NOVA_DB_WORKLOAD=migration npx tsx --conditions=react-server scripts/migrate-hq-round-trip-cutover.ts --execute --expect-plan-digest <d> --without-hq`. A local deployment then stops at its next publish and offers the discard. A database created fresh from the migrations needs nothing.

## Removal

The top pull request of the stack (16) removes every one-off part: both scripts, `scripts/lib/hqRoundTripCutover/` with its tests and fixtures, the `Dockerfile` bundle line, the Job in `config/deployment-jobs.json`, its allowlist arm and their infra tests, the `scripts/README.md` and `docs/architecture/deployment.md` entries, the runbook, and this plan. The squash merge leaves each script on `main`'s history and none on its tip, with one deploy. A later removal pull request would be a second deploy that exists only because of the split. Removal in the same stack is decided (part 11, The stack): the tooling leaves before a separate cleanup pull request would, and that is safe here because the run precedes the merge.

What stays: the DDL (immutable), the two contract sentences, `lib/notices/`, the three notice surfaces, `CommCareApiError.cause`, `greatestFoldBaselineSeq` and its three callers, `abandonPreAppDesignSessionInTransaction`.

## Block: the cutover

**Today.** Nova has no way to change the stored shape of every document at once without one of the two precedents' hand-built writers. The admit trigger accepts exactly three baseline identities (`lib/case-store/migrations/20260914080000_authoring_fold_horizon.ts`), and no script decrypts a member's HQ key or reads HQ outside a person's own publish.

**Fix.** One fold-horizon cutover per the subsections above: marker `fold-baseline:hq-round-trip-emission`, actor `system:hq-round-trip-emission`; one Job; one fleet transaction; the ordered transform; the HQ reads under the creator-then-members order; the plan digest as the frozen proof.

**Files.**
- Domain: none of its own (each step's fix owns its schema change).
- Doc and mutations: none.
- Validator: none.
- Emitters: `lib/commcare/hq/http.ts` (`CommCareApiError.cause`), `lib/commcare/hq/readJson.ts`, `lib/commcare/hq/readCollection.ts`.
- Storage: `<timestamp>_hq_round_trip_fold_horizon.ts` (the notice migration is work item F's; the deployment ledger migration is part 02, The ledger schema's; `<timestamp>_app_settings.ts` is defect 7's, in part 04), `lib/case-store/migrations/index.ts`, `lib/db/pg.ts`, `lib/db/privilegeConvergence.ts`, `lib/db/designSessions.ts` (`abandonPreAppDesignSessionInTransaction`), `lib/agent/change-set/baseLoader.ts` (`greatestFoldBaselineSeq`), `lib/agent/build/orchestrator.ts`, `lib/agent/change-set/materializeGenesis.ts`, `app/api/apps/[id]/stream/route.ts`, `lib/log/types.ts` (the archived arm's comment), `lib/db/appTests.ts` (`RUNTIME_VERSION` 15). `lib/models.ts` is not this block's: `MODEL_CONTEXT_VERSION` is bumped in each pull request that changes the tool catalog (part 11, The model-addition checklist, item 13).
- Scripts and infrastructure (removed by pull request 16): `scripts/scan-hq-round-trip-cutover.ts`, `scripts/migrate-hq-round-trip-cutover.ts`, `scripts/lib/hqRoundTripCutover/**`, `Dockerfile`, `config/deployment-jobs.json`, `scripts/rollout/deploy-cloud-run.py`, `scripts/infra/tests/`, `scripts/infra/__tests__/containerArtifacts.test.ts`, `scripts/README.md`.
- Preview, builder, SA and MCP tools: none.
- Docs: `docs/plans/hq-round-trip/2-cutover-runbook.md`, `docs/architecture/deployment.md` (the Job, while it exists). `docs/architecture/contracts.md`, "Direct maintenance cutover", gains two sentences in pull request 2 that stay after the removal: a writer the deploy's own prerequisite check requires enabled, and whose database authority holds nothing of the changed shape, resumes before the deploy; and an advisory scan writes nothing, also when it reads an external system with a member's stored credential inside the migration Job; the migration itself records each credential it uses.
- CLAUDE.md: `lib/db/CLAUDE.md` (the admit routine accepts four identities, naming the `hq-round-trip-emission` pair; the paragraph that words the suffix rewrite as the norm keeps that wording and gains this horizon as a stated choice; the pre-horizon read rule), `lib/log/CLAUDE.md` and `lib/log/types.ts` ("A mutation event written before a fold horizon"), `lib/collab/CLAUDE.md` (the stream route's reload below a horizon).

**Stored shape and migration.** This block is the migration. Schema change of its own: one migration file holding the two admit functions. Every document change is a step in the ordered list, owned by its fix. The block's own notice reason is `unsaved-assistant-work-discarded`, naming each app whose open private work was abandoned.

**Register.** None. The cutover holds no symptom the lane reproduces.

**Spelling rule.** None.

**Identity.** What moves once in HQ for a deployment made before step 2 is decided by the matching and listed in part 01, A1. Derived ids, and why `Form.xmlns` is not stored: nothing for a paired entity whose ids were recorded; a form's `unique_id` once in a `no-form-ids` deployment; derived ids and `xmlns` once for an unpaired entity and for every entity of an `unreadable` deployment. Every emitted node's data path moves once at each deployment's next publish. `proof/identity-moves.json` gains no entry: proof 1 compares two exports of one document by one revision, so a migration moves both sides alike.

**Control.** None.

**Nova tests.** "The tests that carry the cutover", below.

**Lane.** The lane cannot prove the cutover (below). Locally the pull request runs `npm run proof -- -k "case-operation-query or targeted-custom-tile"` to show two documents unmoved by the skeleton. CI's full lane must show both registers exactly as the pull request beneath left them.

## Work item F: the migration notice

**Today.** Nova has no per-app notice: no table (`lib/db/pg.ts::AppDatabase` lists none), no component, and nothing a member can dismiss about an app. What exists nearby is something else: `authoring_checkpoints.migration_report` (`lib/db/migrationOutcome.ts`, the case-data consequence of one checkpoint), `components/builder/PreviewSetupNotice.tsx` (authored setup gaps), `components/builder/AccessStatus.tsx` (access phases). Nova sends no mail.

**Fix.**

*Entries.* `lib/notices/migrationNotice.ts`, a new directory outside `lib/db` because the builder and MCP both read the type and `lib/db` is server-only:

```ts
const entityRef = z.strictObject({
  type: z.enum(["app", "module", "form", "field", "caseListColumn", "searchInput", "language",
                "entryPoint", "lookupTable", "location"]),
  uuid: uuidSchema.optional(),            // absent only for "app" and "language"
  languageTag: languageTagSchema.optional(),
  nameAtMigration: z.string().max(200),   // shown when the entity no longer exists
});
const deploymentRef = z.strictObject({
  deploymentId: uuidSchema,
  server: z.enum(COMMCARE_SERVER_IDS),    // lib/commcare/servers.ts
  domain: z.string().min(1),
});
export const migrationNoticeEntrySchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("document"), reason: z.enum(DOCUMENT_NOTICE_REASONS),
                   entity: entityRef, detail: z.record(z.string(), z.string().max(200)).optional() }),
  z.strictObject({ kind: z.literal("deployment"), reason: z.enum(DEPLOYMENT_NOTICE_REASONS),
                   deployment: deploymentRef, entities: z.array(entityRef).optional(),
                   detail: z.record(z.string(), z.string().max(200)).optional() }),
]);
```

A case operation, a Connect block and an option are named by their form or field entity with the id in `detail`. A `detail` value longer than 200 characters is cut at 200. Authored names are stored (`nameAtMigration`) because an entity may be renamed or removed before a member reads the notice; they are client content, stay in the row, and never reach a log line or a report.

*The closed reason enum.* Both lists are closed, and each reason has one renderer in `lib/notices/migrationNoticeCopy.ts`, typed `satisfies Record<MigrationNoticeReason, (entry) => NoticeLine>`, the same obligation validator messages carry. A fix adds its reason and its renderer in its own pull request; pull request 2 ships the enums holding only `unsaved-assistant-work-discarded` and `deep-links-need-republish`, and each later pull request adds the reasons the tables below give it.

| `DOCUMENT_NOTICE_REASONS` | Added in | Its copy is in |
|---|---|---|
| `unsaved-assistant-work-discarded` | 2 | this part |
| `android-form-lists-setting-stored`, `validation-now-enforced` | 5 | this part |
| `local-archive-changes` | 5 | part 04, the blocks of defect 9, finding 34 and finding 40 (its three sentences) |
| `root-create-id-generated`, `case-lookup-by-key-stops` | 6 | part 05, The root create id (defect 13) (its two lines) |
| `follow-up-now-touches-case`, `close-moves-to-save-to-case`, `case-name-now-checked` | 9 | this part |
| `question-renamed`, `case-operation-renamed`, `connect-block-renamed`, `entry-point-renamed`, `option-value-split`, `empty-form-label-added` | 10 | part 08: Defect 15: identifiers HQ's editors refuse; Finding 44: duplicate option values; Finding 31: a form with no question |
| `id-mapping-entry-removed`, `date-column-became-calculation`, `tile-order-rule-removed`, `order-rule-removed-same-property`, `order-rule-moved-to-first-column`, `tile-cell-defaults-set`, `case-list-order-changes`, `case-list-search-matches-hidden-fields`, `hidden-order-column-not-in-sort-menu`, `record-id-column-now-shows` | 11 | part 07, in the block that What this part moves, in one table, names for each reason |
| `search-button-text-changed`, `search-input-renamed`, `search-input-removed`, `hidden-from-menu-set`, `after-submit-destination-moved`, `lookup-choices-order-changes`, `survey-menu-takes-case-type` | 12 | this part |
| `media-slot-removed`, `hidden-value-saves-blank`, `time-comparison-never-true`, `search-term-matches-nothing` | 14 | part 08: Defect 16: three media slots leave the model; The Hidden Value with neither a calculate nor a default; Defect 6: ordering a time, and the three system dates in CSQL |
| `lookup-tag-renamed` | 14 | part 02, Defect 5: the lookup push |

| `DEPLOYMENT_NOTICE_REASONS` | Added in | Its copy is in |
|---|---|---|
| `deep-links-need-republish` | 2 | this part |
| `menu-id-changes-once`, `form-ids-change-once`, `ids-change-once-unreadable`, `ended-app-deleted` | 3 | part 01, A1. Derived ids, and why `Form.xmlns` is not stored |
| `hq-app-not-nova-made` | 3 | this part |
| `next-publish-overwrites-hq-edits`, `next-publish-asks-before-overwriting` | 4 | part 02, Work item B: the drift check and its baselines |
| `setting-changes-at-next-publish`, `settings-unknown-unreadable` | 5 | this part |
| `worker-settings-reset-at-next-publish` | 5 | part 04, Finding 40: an HQ settings save writes its defaults into the profile |
| `data-paths-move-once` | 7 | this part |
| `commcare-version-below-floor`, `next-publish-asks-more`, `logo-upload-in-hq` | 13 | part 03: C1. The version floor; C2. Plan features: the per-privilege confirmation; C6. Defect 14: logos |
| `lookup-table-content-unsupported` | 14 | part 02, Defect 5: the lookup push |

A block of another part that only describes what a line says, where this part's copy table quotes it, is describing this part's line.

*Store.* `lib/notices/store.ts` (server-only):

| Function | Does |
|---|---|
| `readAppNoticesInTransaction(tx, { appId, userId })` | The app's notices with no `app` dismissal by that user, newest first. The caller has already resolved `view` on the app (`lib/db/appAccess.ts::resolveAppScopeInTransaction`); the store does no authorization of its own, as `lib/deployment/store.ts` does not. |
| `readAppDeploymentNoticeEntriesInTransaction(tx, { appId })` | The deployment entries of every notice of the app, dismissed or not, each with its notice's `created_at`. The Publishing card reads these, because the card outlives the dialog's dismissal. Same caller rule. |
| `readKeyReaderNotices(userId)` | Rows of `app_migration_notice_key_readers` for the user whose `cutover` has no `key-reader` dismissal by that user, each as `{ cutover, server, domain, firstUsedAt, lastUsedAt }`. It selects no `apps` or `app_migration_notices` column. It is the user's own key and their own project space, so it needs no Project check, and it never names an app: the person may have left the Project. |
| `dismissAppNotice({ appId, noticeId, userId })` | Inserts a dismissal with `surface = 'app'` only `WHERE EXISTS` a notice with that id and that `app_id`, `ON CONFLICT DO NOTHING`, and returns whether the notice exists. The `appId` is the app whose `view` the caller resolved, so a notice id from another app dismisses nothing. |
| `dismissKeyReaderNotices({ userId })` | One `key-reader` dismissal for each distinct `cutover` `readKeyReaderNotices` returns. |

No serving code writes a notice or a key-readers row. The cutover inserts both through raw statements in `scripts/lib/hqRoundTripCutover/` as the migration role.

*Access rule, stated once.* Any current member of the app's Project, at any role including viewer, reads the app's notices and dismisses for themselves. A dismissal is per member and changes nothing for anyone else. A member who joins later sees the notice until they dismiss it.

*Surfaces.*

| Surface | What it shows | Where |
|---|---|---|
| Builder chip | A quiet chip in the header band beside `BuilderAccessStatus`, portaled like the other builder controls (`components/builder/CLAUDE.md`, "The header is the app's"). Nothing opens by itself. | `app/(app)/build/[id]` loads the undismissed notices in its authorized snapshot read and passes them to `BuilderProvider`. `components/builder/notices/AppNoticeChip.tsx` |
| Builder dialog | Deployment entries first, grouped by project space; then document entries grouped by reason in transform order. Each line comes from the renderer. An entity's name links to the entity where it still exists, and shows `nameAtMigration` where it does not. One button dismisses for this member. | `components/builder/notices/AppNoticeDialog.tsx` (from `components/shadcn/dialog`), `appNoticeModel.ts` (pure grouping and ordering) |
| Publishing card | The deployment entries of one project space as a note on its card, since that is where a person decides the next publish. It stays after the dialog is dismissed. A deployment's entries are hidden when its live `app` mapping's `pushed_at` is later than their notice's `created_at`, which is the stored fact that a publish has happened there since; a deployment with no live `app` mapping, or one never pushed, keeps them. | `components/builder/app-setup/PublishingSection.tsx`, `publishingSectionModel.ts`, which takes each deployment's `pushedAt` from the deployment state the section already loads (`lib/deployment/types.ts`) and the entries with `createdAt` from `readAppDeploymentNoticeEntriesInTransaction`, loaded by the builder page beside the undismissed notices |
| Home line | For a person whose key read a project space: one line beside the invitations banner, with its own dismissal. It names the project spaces and never an app. | `app/(app)/(site)/page.tsx`, `components/notices/KeyReaderNotice.tsx` |
| MCP `get_app` | `notices`: for each undismissed notice `{ id, created_at, summary: { <reason>: count }, lines: [{ reason, text, entity_uuid?, deployment? }], truncated }`, the first 50 lines rendered. `get_app` is the read an MCP client makes before working on an app and already carries `LARGE_RESULT_META`. `list_apps` and `search_apps` stay enumeration only. | `lib/mcp/tools/getApp.ts::registerGetApp`, scope `nova.read` as today |
| MCP `dismiss_app_notice` | `{ app_id, notice_id }`. The tool resolves `view` on the app, not `edit`, so a viewer can dismiss, and passes that app id to the store. Lets a member who works only through MCP dismiss; without it "dismissible per member" would be false for them. It writes Nova state and reads or writes nothing in HQ, so it sits under `nova.write` with the other Nova write tools and carries no `oauthScopeChallenge`. | `lib/mcp/tools/dismissAppNotice.ts` |

Dismissals go through Server Actions, `dismissAppNoticeAction({ appId, noticeId })`, which resolves `view` on `appId` for the session's user before it calls the store, and `dismissKeyReaderNoticesAction()`, which takes no argument and acts for the session's user, beside `lib/deployment/actions.ts`'s pattern, with plain JSON arguments (a `Map`, `Set` or `File` argument makes React send multipart, which the edge refuses). This work item adds no `/api` route, so `lib/hostnames.ts` needs no entry; a new route would need one.

Not a surface: the Solutions Architect's context. The notice is addressed to a person, the person chatting is in the builder where the chip shows, and the edit turn's prompt prefix is cache-bearing (`lib/agent/CLAUDE.md`, "Provider contract").

*Copy*, in Nova's voice: sentence case, no em dashes, no ellipsis, consequences stated calmly with the next step.

| Where | Copy |
|---|---|
| Chip | "1 update to review" / "2 updates to review" (the count of notices) |
| Dialog title | "What changed in this app" |
| Dialog lead | One renderer per `cutover` value in `migrationNoticeCopy.ts`, typed over the known cutovers, so steps 3 to 7 each add theirs. For `hq-round-trip-emission`: "Nova changed how it writes apps for CommCare HQ on 6 October. Here is what that means for this app." The date is the notice's `created_at`, rendered as day and month in the viewer's locale and time zone; it is never written into the copy. |
| Dialog button | "Got it" |
| Group heading, a project space | "At the next publish to field-ops" |
| Publishing card note | "The next publish here does a few things once." then the lines |
| Home line | "Nova read field-ops on CommCare HQ with your saved key on 6 October, to keep its apps' IDs steady through an update." Button "Got it". With several spaces: "Nova read field-ops and 2 more project spaces on CommCare HQ with your saved key on 6 October, to keep their apps' IDs steady through an update." The dates are the least `first_used_at` and the greatest `last_used_at` of the rows shown, rendered as day and month in the viewer's locale and time zone. One execute run writes each row, so both nearly always fall on one day; when they do not (a run across midnight in the viewer's zone, or rows of a later step's cutover) the line reads "between 6 and 7 October". The line says "read" for a key HQ refused as well: the key was sent, which is what the person is owed. |
| MCP dismissal result | "Dismissed for you. Other members still see it." |

Renderer copy for the reasons whose copy is this part's, per the reason tables. Every other reason's copy is in its owning block and is not repeated here.

| Reason | Line |
|---|---|
| `search-button-text-changed` | "Patients: the search button now reads "Search All Cases". It read "Find a patient" before. CommCare HQ always shows its own text there." |
| `unsaved-assistant-work-discarded` | "Changes the assistant was still working on here were not saved before this update. The saved app is unchanged. Ask again to pick the work back up." |
| `case-name-now-checked` | "Register: workers now see a message when the case name from Full name is blank or longer than 255 characters. CommCare can't save a case with a name like that." |
| `search-input-renamed` | "Patients: the search input _xpath_query is now _xpath_query_2. CommCare reads the earlier name as part of the search itself." |
| `search-input-removed` | "Patients: the search input include_closed was removed. CommCare reads that name as part of the search request, so it never searched a property. 2 expressions that read it now treat it as empty." |
| `hidden-from-menu-set` | "Archive: this menu is now marked as not on the menu. Its display condition already kept it off the menu on every device. On Android, after-submit links and deep links still open it. In Web Apps, a deep link opens it only when the link ignores display conditions, and an after-submit link stops at the menu that holds it, as before." The platform split is part 06's (11. `hiddenFromMenu`: a menu or form that is not on the menu); the line never says a link reaches the item without naming the platform. |
| `after-submit-destination-moved` | "Visit: after submitting, workers now go to the first menu. CommCare HQ doesn't offer "back to the case list" for a menu that selects several cases." |
| `follow-up-now-touches-case` | "Review: submitting it now updates its case's last-modified date, even when nothing changes. Case update rules and data forwarding in CommCare HQ see that." |
| `close-moves-to-save-to-case` | "Discharge: its close is now written as a case change in the form. CommCare HQ shows no close on its Case Management tab, and the next publish asks about one more plan feature." |
| `lookup-choices-order-changes` | "Patients, Clinic: its choices are now listed by label, not in the table's row order." |
| `survey-menu-takes-case-type` | "Surveys: CommCare HQ shows this menu's case type, household, from the next publish." |
| `validation-now-enforced` | "Intake, Card number: its validation now runs on this barcode question. Workers see its message when an answer doesn't pass." |
| `android-form-lists-setting-stored` | "This app now states whether Android shows saved and incomplete forms: saved forms off, incomplete forms on. Nova took both from your project spaces. They are yours to change in App settings." |
| `data-paths-move-once` | "The next publish to field-ops moves the form data that Nova adds to each form to new names, once. Form exports in CommCare HQ show those columns under the new names from then on." |
| `deep-links-need-republish` | "Links to field-ops that you already shared keep working. New ones are ready after the next publish there." |
| `setting-changes-at-next-publish` | "field-ops shows saved forms on Android today. This app now has them off, so that changes at the next publish there. Turn it back on in App settings to keep it." |
| `settings-unknown-unreadable` | "Nova couldn't read field-ops, so it could not tell whether Android shows saved and incomplete forms there. The next publish there sets them to this app's settings. They are yours to change in App settings." |
| `hq-app-not-nova-made` | "The app on field-ops is a linked app in CommCare HQ, so Nova can't publish to it there. You can publish to another project space." |

**Files.**
- Domain: `lib/notices/migrationNotice.ts`, `lib/notices/migrationNoticeCopy.ts`, `lib/notices/store.ts`, `lib/notices/actions.ts`.
- Doc and mutations, validator, emitters, Preview: none.
- Storage: `<timestamp>_app_migration_notices.ts`, `lib/case-store/migrations/index.ts`, `lib/db/pg.ts`, `lib/db/privilegeConvergence.ts`.
- Builder: `components/builder/notices/AppNoticeChip.tsx`, `AppNoticeDialog.tsx`, `appNoticeModel.ts`; `components/builder/BuilderHeader.tsx`, `BuilderProvider.tsx`; `components/builder/app-setup/PublishingSection.tsx`, `publishingSectionModel.ts`; `components/notices/KeyReaderNotice.tsx`; `app/(app)/(site)/page.tsx`; the builder page under `app/(app)/build/[id]`.
- SA and MCP tools: `lib/mcp/tools/getApp.ts`, `lib/mcp/tools/dismissAppNotice.ts`, the MCP tool registration. No Solutions Architect tool schema changes, so this work item calls for no `npm run test:schema` run; the implementer asks the person before running it for any reason, because it bills one live request per schema.
- Docs: `content/docs/publishing.mdx` (what a notice about a project space means and what the next publish does), `content/docs/mcp/tools.mdx` (`get_app`'s `notices`, `dismiss_app_notice`), `design/` where the chip is a new primitive use. In `../nova-plugin`, the `show`, `edit` and `upload_to_hq` skills relay a non-empty `notices` to the person, in the plugin's own pull request, merged after the Nova deploy is live.
- CLAUDE.md: `lib/db/CLAUDE.md` (the three tables and their capabilities), `components/builder/CLAUDE.md` (the chip in the header band), `lib/mcp` tool headers.

**Stored shape and migration.** The three tables above, additive. No document shape changes and no transform step. The cutover writes the rows; nothing backfills.

**Register.** None: a notice is no symptom the lane runs.

**Spelling rule.** None.

**Identity.** None; `proof/identity-moves.json` gains no entry.

**Control.** None.

**Nova tests.**

| Test | Boundary |
|---|---|
| `migrationNoticeEntrySchema` accepts each reason's real entry and refuses an unknown reason and an extra key | pure |
| Every reason renders with present and absent details and with a removed entity, through the real renderer; no line holds an em dash or an ellipsis | pure |
| `appNoticeModel` grouping and ordering; the Publishing card's selection of one space's deployment entries, kept while `pushedAt` is null or not later than the notice's `createdAt` and hidden once it is later; the lead renderer exists for every known `cutover`; the home line's one-day and two-day forms | pure (state model) |
| A member reads; a non-member's resolution fails before the store; a dismissal hides it for that member only; a second dismissal is a no-op; a dismissal naming another app's notice id inserts nothing; an `app` dismissal leaves the home line and the reverse; `readAppDeploymentNoticeEntriesInTransaction` still returns a dismissed notice's deployment entries; a key-readers row with no notice at all shows on the home line, and the line's span is the least first use and the greatest last use of the rows shown; the notice follows the app across a Project move (`commitAppProjectMove`) and is then read by the destination's members; app deletion cascades; after privilege convergence the runtime role's `INSERT INTO app_migration_notices` fails with `42501` while its dismissal insert succeeds | real Postgres: `lib/notices/__tests__/store.postgres.test.ts` |
| `get_app` returns a seeded notice with its summary and truncation; `dismiss_app_notice` removes it for the caller, a viewer included; a caller outside the Project gets the ordinary access error with no hint that a notice exists; a token without `nova.write` gets `scope_missing` | real Postgres through the MCP SDK transport: `lib/mcp/__tests__/appNotices.postgres.test.ts` |
| A seeded notice shows the chip, the dialog lists its lines, "Got it" removes the chip, and it stays gone after a reload; the home line shows for a seeded key reader and dismisses | Playwright: `e2e/` smoke |

**Lane.** Nothing in the lane changes. Locally the pull request runs the two documents named in the cutover's block; CI's full lane must show both registers unchanged.

## The tests that carry the cutover

**The lane cannot.** For every document the lane publishes A, B and B-edit from one revision of Nova into a fresh project space (`proof/README.md`, "A, B and B-edit"), so it never sees a deployment made by the pre-step emitter and republished by the post-step one. A retained control holds pre-fix exports and no document. The lane holds no Nova Postgres state at all: no `apps` rows, history, baselines, workspaces or ledger. So "an existing project space keeps its menu ids, form ids and `xmlns`", and everything about stored shape, is harm in a system the lane does not run. Its proof is Nova's own tests.

**Frozen pre-step fixtures.** Pull request 2 captures them at its own head, before any shape change, under `scripts/lib/hqRoundTripCutover/__tests__/fixtures/pre-step/`. They must be complete at pull request 2, because no later pull request can check a new fixture against the pre-step schema and gate.

- **Corpus fixtures**: for each document below, the pre-step raw carriers, the `export/<configuration>/create.body` the pre-step emitter sent, and `paths.json` ("The matching algorithm"). The seven are named by what they must hold; where a named document does not hold it at pull request 2's head, the implementer takes the corpus document that does and records the choice in the manifest.

  | Document | Holds |
  |---|---|
  | `case-operation-query` | case operations, a query repeat (the `item` step), a root create with `idFrom` |
  | `targeted-custom-tile` | a tile list with cells missing the three slots |
  | `targeted-form-links-hidden-and-fallback` | a hidden no-matches menu, form links, a fallback destination |
  | `targeted-invalid-connect-ids` | a Connect app with ids the grammar refuses |
  | `targeted-invalid-question-ids` | question ids the grammar refuses |
  | `targeted-search-hq-compile` | a lookup-backed search input, reserved input names, a search button label |
  | `localization-optional` | several languages with a stored localization root |

- **Hand-built fixtures**: one per row of the step table, one per blocker code and one per no-write reason, each holding the shape that row, code or reason names, plus one holding an open workspace's app. A deployment reason's fixture carries the controlled source read that produces it; `worker-settings-reset-at-next-publish` has one whose `profile.properties` lacks `cc-autoup-freq`. `manifest.json` lists every fixture with its digest and the step ids, blocker codes and reasons it witnesses. A test holds the files to the manifest, and a second test requires every registered step id, every blocker code and every reason of both enums to name at least one fixture, so a later pull request that registers a step with no witness fails.
- Each fixture is checked against the pre-step schema and gate at capture. They are the only witnesses of the old shape once the tree changes. A later pull request adds expectations for its step and never edits a fixture.

| Test | Boundary |
|---|---|
| Every step over its fixtures: the stored document and each notice line; the whole transform's output parses under the new schema and passes the gate and export readiness; a second application changes nothing; authored question paths are equal before and after for every question a step does not rename; the derived case schemas of the target equal the fixture's stored rows except for the option sets step `option-values` changed, and a fixture with any other difference yields `case-schema-change`; each step that reimplements a production rewrite over raw rows (`reserved-search-inputs`, `option-values`) equals the production function over the same fixture; `questionPaths.ts` equals each fixture's `paths.json` | pure |
| The matcher on fixtures built to hit each rule: more than half of the HQ form's paths, descending shared count, equal position, HQ position, Nova position, a form already taken, a form with no questions left unpaired; menus by descending count of shared paired forms with both tie-breaks (equal position, then HQ menu position, then Nova menu position) and a menu already taken on either side skipped, a menu with no forms, a menu whose forms are all unpaired, the hidden no-matches menu, a form whose every question has a reference-bearing validation message; the two-read alignment with a failed module and a moved `xmlns`; an HQ id equal to another entity's derived id is not recorded and that entity is named under `menu-id-changes-once` | pure |
| `renamedReservedTag`; the plan digest is stable across runs, does not move when only a read time or the answering member differs, and moves when one app, one deployment outcome, one ownership or one baseline moves; the report holds no authored string from any fixture; the scan's transform equals the `--without-hq` transform | pure |
| Each read outcome with real client code: ok; 401 and 403 falling to the next member in join order, per read; a member on another server, with no stored key, or whose `approved_domains` lacks the domain skipped with no request; 404 and a 200 with a `-Deleted` `doc_type` as `gone`; a `LinkedApplication` `doc_type` as `unsupported`, classed with an `unread` baseline and the one notice `hq-app-not-nova-made`; a form id read answering 404, a redirect, a 400 and an unparsable body, each classing the deployment `no-form-ids`; 5xx then success within three attempts; still transient after them; `Retry-After` honored; a redirect, a 400, an unparsable body and an edge refusal page; no more than eight requests in flight per server, proved by holding responses on owned promises; the source and `ApplicationResource` bodies built from a fixture's `create.body` with form ids changed as HQ's create changes them | controlled HQ responses |
| The decrypt call: the request shape, a refused grant surfacing as a stop, no plaintext in any thrown error | controlled responses from a local peer standing in for the KMS endpoint |
| The fleet write, starting from the previous migration prefix and then applying the new migrations: several apps including a soft-deleted one and one with NULL `case_types`; the admit trigger accepts the new identity and refuses an invented one; an app that changed after the plan stops the run with nothing written; a live holder stops it; a wrong `--expect-plan-digest` stops it; an app with a duplicate option value has its `case_type_schemas` row rewritten and no case row touched; a transient deployment stops it and `--transient-as-unreadable` proceeds; a failure injected after each statement group leaves the database byte-identical; `--rehearse` leaves the data unchanged, no key-readers row, and the DDL applied | real Postgres: `scripts/lib/hqRoundTripCutover/__tests__/writer.postgres.test.ts` |
| After the commit: every app loads and folds from its new baseline; `runCanonicalRuntimeDatabaseProbe` reports no finding; mutation events read back as `archived-mutation` with their bytes preserved; stored `case_type_schemas` equal what the new code derives; `apps.updated_at` is unchanged; a second run in every mode reports `already-applied` with no HQ request and no decrypt, proved by a peer that fails the test on any request; a database where some apps carry the marker and some do not is refused | real Postgres, same file |
| The scan: its counts per step, blocker and holder over a seeded pre-step database; the count of live `app` mappings with a null `pushed_revision`, and the blocker `app-mapping-without-pushed-revision` when it is not zero; it makes no HQ request | real Postgres: `scan.postgres.test.ts` |
| Key uses: a dry run, a rehearsal that rolls back, a run refused on its digest and a run that stops on a transient deployment each leave no key-readers row, and the dry run leaves the database byte-identical with no table created; an execute run leaves one row per member, server and domain whose key it sent, a refused key included, with the span from its first send to its last, and none for a member it skipped; a member whose key only an earlier dry run sent (removed from the Project before the execute run) has no row; every run's report lists each key use | real Postgres with controlled HQ responses: `keyUses.postgres.test.ts` |
| `notice.ts` over deployment plans: each deployment reason from its class and its read source, with no HQ request; `worker-settings-reset-at-next-publish` for a `read-in-full` or `no-form-ids` deployment that lacks one of the three keys or holds one null or empty, none for one that holds all three, none for an `unreadable`, `unsupported` or `deleted` one | pure |
| Private work: `authoring_sessions.active_candidate_id` is NULL for every abandoned candidate, and `getWork` on such a session answers from the saved app and opens a new candidate at the new head; a pre-app build session ends as a discarded one does, its hold refunded, and its page shows the ended stage; each app that had an open workspace or change set has the `unsaved-assistant-work-discarded` entry and no other app does | real Postgres: `privateWork.postgres.test.ts` |
| Holders: a lapsed edit, a stale build and a paused build past its window are settled by `--settle-holders` with their holds refunded, then the write proceeds; a live holder is left alone and stops the write | real Postgres: `holders.postgres.test.ts` |
| Pre-horizon reads: the finished-build branch, `readMaterializedGenesisReceipt` at sequence 1, and the stream route with a cursor below the horizon whose suffix holds an old-dialect row, each answering from the saved app or with `reload` and logging no error | real Postgres: `lib/agent/change-set/__tests__/preHorizonReads.postgres.test.ts`, kept after the removal |
| The ledger writes: identity rows drop a value equal to the derivation; a `deleted` deployment has `remote_missing_at` and no baseline; an `unreadable` one has an `unread` baseline; every baseline column equals the plan's field, `source_gzip` inflating to `normalizedSource` and `ownership` equal to what `hqImportApplication` returns for the target over that read; shared resource baselines upsert under the `observed_at` rule with the lowest reading app id as `observed_from_app_id`; an HQ id equal to another entity's derived id writes no identity row; notice rows match the plan; `getEntryPointLink` after the horizon answers that the app needs a publish; a first publish after the cutover to a `read-in-full` deployment sends the recorded ids and `xmlns` | real Postgres with controlled HQ responses: `ledger.postgres.test.ts` |
| The lookup tag rename over a real Project with a referencing app advances the definition revision, leaves the reference intact, and leaves no refused tag | real Postgres |
| The Job contract, each allowlisted argument shape and each refused shape (`--without-hq` and `--prove-decrypt` among them); the bundle's entrypoint starting and exiting cleanly on a dry run with no database write | infra: `scripts/infra/tests/`, `scripts/infra/__tests__/containerArtifacts.test.ts` |

Two checks cannot live in a test and are runbook steps: that pull request 16's tree equals pull request 15's outside tooling paths (the tree that would hold the test is the one that removes it), and one real decrypt in the real image against the development project's key (runbook step 1b).
