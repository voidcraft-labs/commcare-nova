# Step 2, part 02: The deployment ledger, work item B (the drift check), defect 5 and correction 15

Part of [step 2's plan](../2-emission-and-publish.md), which holds the baseline, the decisions, the stack and the exit. Citations are `file::symbol`; HQ paths are relative to `corehq/apps/app_manager` unless another app is named.

This section holds three things: the whole step's additive ledger schema (one
migration, landed by pull request 2 of the stack), work item B (pull request
4), and defect 5 with correction 15 (pull request 14, with its lane split in pull request 1).
Work items A and C use the tables defined here and are written in part 01,
Work item A: identity and the publish sequence, and part 03, Work item C:
publish gates. The cutover's step ids and notice reasons are part 10's (The
cutover and work item F), used here verbatim. The names below are the only
names for these things in step 2.

| Thing | Name |
|---|---|
| Tables | `app_deployment_identities`, `app_deployment_confirmations`, `app_deployment_baselines`, `project_space_resource_baselines` |
| Columns | `app_deployment_resources.remote_missing_at`, `app_deployments.offered_logo_content_hash`, `app_deployments.target_empty_case_list_text` |
| Failure codes | `hq_changed` (pull request 4), `hq_table_content_unsupported` (pull request 14), `hq_confirmation_needed` and `hq_app_version_below_floor` (pull request 13, work item C) |
| Preflight checks | `plan-features`, `target-app` (added to `lib/deployment/preflight.ts::PREFLIGHT_CHECK_IDS`) |
| Publish input | `lib/deployment/service.ts::PublishInput.confirm`, `PublishInput.discardRemoteChanges` (an array of `lib/deployment/types.ts::RemoteChangeDiscard`) |
| Refusal payload | `DeploymentAttemptRefusal.confirmationsNeeded`, `DeploymentAttemptRefusal.remoteChanges` |
| Route body | `confirm`, `discard_remote_changes` on `/api/commcare/upload` |
| MCP inputs | `confirm_plan_features`, `confirm_flat_location_fixture`, `discard_hq_changes` on `upload_app_to_hq` |
| Baseline origins | app: `create`, `push`, `cutover`, `unread`; table or place: `push`, `cutover`, `unread` |

## The ledger schema

### Decisions

- **One migration, additive only.** `lib/case-store/migrations/<timestamp>_hq_round_trip_deployment_ledger.ts`, registered in `lib/case-store/migrations/index.ts`, with a timestamp later than `20261004000000_app_test_lookup_definitions.ts`. It adds nullable columns and new tables and nothing else. Reason: the cutover Job applies it before the new image deploys, so the old image must run over it unchanged.
- **The notice tables are not in this file.** `app_migration_notices`, `app_migration_notice_key_readers` and `app_migration_notice_dismissals` are work item F's, in their own migration (part 10, Ledgered DDL). They appear below only in the privilege list.
- **No table gets a foreign key to `auth_organization` or a composite key touching `apps.project_id`.** `app_deployments` has neither, for the reason `lib/deployment/CLAUDE.md` ("Tenancy") gives, and the same reason binds here.
- **The app's source lives in Postgres as gzip `bytea`, in a table of its own.** Postgres because the baseline must commit in the same transaction as the mapping it describes (`lib/deployment/store.ts::recordRemoteResource`) and die with the deployment; `bytea` and not `jsonb` because `jsonb` refuses `\u0000` inside a string and an app source can hold one, and a baseline write must never fail after the import landed; its own table because `store.ts::readDeployment` and its siblings select whole rows, and no status read may load megabytes. Lookup table and place baselines stay `jsonb`: HQ holds both in its own Postgres JSON columns, which cannot hold `\u0000` either.
- **The stored app baseline is the normalized read, never the compared projection.** Storing only the keys the comparison reads would turn every later change to those key sets (steps 3 to 7 change them) into a false stop on every deployment, with nothing to recompute from.
- **A resource baseline is keyed by the HQ resource**, `(project_id, server, domain, kind, remote_id)`. Reason: Nova's places are app-scoped (`lib/case-store/migrations/20260802010000_organization_model.ts`, `PRIMARY KEY (app_id, id)`), so a key on the Nova resource could never be shared between two apps; keyed by the HQ resource, two apps whose live mappings name one HQ table or place share one row, which is exactly when sharing means anything. `project_id` stays in the key so one tenant's push never refreshes what another tenant compares against.
- **`app_deployment_baselines` carries no form-id column, and a publish makes no form-id read.** The cutover's one `ApplicationResource` read writes `app_deployment_identities` and nothing else (part 10, Reading HQ). The publish-time form-id comparison through `corehq/apps/api/resources/v0_4.py::ApplicationResource` is dropped: an app source read re-mints every form id (`models/applications.py::Application.scrub_source`), an update writes Nova's ids verbatim on every publish (`models/applications.py::overwrite_app_from_source` runs no scrub), and the only remedy the check could offer is that same overwrite. Every HQ edit that changes a form's id also changes its menu's form list, which the source comparison sees.
- **`app_deployments` gets no CommCare version column.** Nothing could refresh it (Check status reads `views/releases.py::current_app_version`, which carries no `build_spec`), so a stored value would keep asking a person to raise a version they already raised. The floor is an attempt-time fact.
- **No baseline row is deleted on supersession.** A superseded resource's baseline is never read again (a publish reads a baseline only through the HQ resource it is about to write), the rows are small, and a delete that asks "does any other app still name this id" would race that app's writer.

### DDL

```sql
-- (a) The explicit "CommCare HQ reports this app gone" fact.
ALTER TABLE app_deployment_resources
  ADD COLUMN remote_missing_at timestamptz(3),
  ADD CONSTRAINT app_deployment_resources_missing_is_an_apps
    CHECK (remote_missing_at IS NULL OR kind = 'app');

-- Preserve today's inference exactly: a persisted upload failure beside a live
-- app mapping has only ever meant "gone" (resources.ts::plannedInPlaceUpdate).
UPDATE app_deployment_resources r
   SET remote_missing_at = now()
  FROM app_deployments d
 WHERE r.deployment_id = d.id
   AND r.kind = 'app'
   AND r.superseded_at IS NULL
   AND d.phases -> 'upload' ->> 'status' = 'failed';

-- (b) What logo the deployment last told a person to upload in CommCare HQ.
ALTER TABLE app_deployments
  ADD COLUMN offered_logo_content_hash text
    CHECK (offered_logo_content_hash IS NULL OR btrim(offered_logo_content_hash) <> '');

-- (b2) Whether the project space's empty-list text flag was on when this deployment's last publish read it
--      (finding 65): the local archive writes the empty-list text exactly where HQ's build of that publish does.
ALTER TABLE app_deployments
  ADD COLUMN target_empty_case_list_text boolean;

-- (c) Ids a target holds that are not Nova's derivation.
CREATE TABLE app_deployment_identities (
  deployment_id    uuid NOT NULL REFERENCES app_deployments(id) ON DELETE CASCADE,
  entity_kind      text NOT NULL CHECK (entity_kind IN ('module', 'form')),
  -- module uuid (the hidden menu: emissionPlan.ts::syntheticModuleUuid of its form), or form uuid
  nova_entity_uuid uuid NOT NULL,
  unique_id        text CHECK (unique_id IS NULL
                     OR (btrim(unique_id) <> '' AND char_length(unique_id) <= 255)),
  xmlns            text CHECK (xmlns IS NULL
                     OR (btrim(xmlns) <> '' AND char_length(xmlns) <= 2048)),
  recorded_at      timestamptz(3) NOT NULL DEFAULT now(),
  PRIMARY KEY (deployment_id, entity_kind, nova_entity_uuid),
  CONSTRAINT app_deployment_identities_holds_an_override
    CHECK (unique_id IS NOT NULL OR xmlns IS NOT NULL),
  CONSTRAINT app_deployment_identities_xmlns_is_a_forms
    CHECK (xmlns IS NULL OR entity_kind = 'form')
);
CREATE UNIQUE INDEX app_deployment_identities_unique_id
  ON app_deployment_identities (deployment_id, entity_kind, unique_id)
  WHERE unique_id IS NOT NULL;
CREATE UNIQUE INDEX app_deployment_identities_xmlns
  ON app_deployment_identities (deployment_id, xmlns)
  WHERE xmlns IS NOT NULL;

-- (d) What a person confirmed about one project space, for one app.
CREATE TABLE app_deployment_confirmations (
  id            uuid PRIMARY KEY DEFAULT uuidv7(),
  deployment_id uuid NOT NULL REFERENCES app_deployments(id) ON DELETE CASCADE,
  kind          text NOT NULL CHECK (kind IN ('plan-feature', 'flat-location-fixture', 'connect-forwarder')),
  subject       text NOT NULL CHECK (subject ~ '^[a-z][a-z0-9-]{0,63}$'),
  confirmed_by  text NOT NULL CHECK (btrim(confirmed_by) <> ''),
  confirmed_at  timestamptz(3) NOT NULL DEFAULT now(),
  withdrawn_by  text,
  withdrawn_at  timestamptz(3),
  CONSTRAINT app_deployment_confirmations_withdrawal_is_attributed
    CHECK ((withdrawn_by IS NULL) = (withdrawn_at IS NULL)),
  CONSTRAINT app_deployment_confirmations_fixture_subject
    CHECK (kind <> 'flat-location-fixture' OR subject = 'flat-location-fixture'),
  CONSTRAINT app_deployment_confirmations_forwarder_subject
    CHECK (kind <> 'connect-forwarder' OR subject = 'connect-forwarder')
);
CREATE UNIQUE INDEX app_deployment_confirmations_live
  ON app_deployment_confirmations (deployment_id, kind, subject)
  WHERE withdrawn_at IS NULL;

-- (e) The app as CommCare HQ returned it when Nova last read it.
CREATE TABLE app_deployment_baselines (
  deployment_id    uuid PRIMARY KEY REFERENCES app_deployments(id) ON DELETE CASCADE,
  remote_app_id    text NOT NULL CHECK (btrim(remote_app_id) <> ''),
  origin           text NOT NULL CHECK (origin IN ('create', 'push', 'cutover', 'unread')),
  source_gzip      bytea,            -- gzip of the canonical JSON text of the normalized read
  source_bytes     integer CHECK (source_bytes > 0),               -- uncompressed length
  source_digest    text CHECK (source_digest ~ '^[0-9a-f]{64}$'),  -- sha256 of that text
  ownership        jsonb,            -- what Nova owned inside the overlay keys at that push
  observed_at      timestamptz(3) NOT NULL,   -- when CommCare HQ answered (or was asked, if unread)
  observed_by      text NOT NULL CHECK (btrim(observed_by) <> ''),
  discarded_digest text CHECK (discarded_digest ~ '^[0-9a-f]{64}$'),
  discarded_by     text,
  discarded_at     timestamptz(3),
  CONSTRAINT app_deployment_baselines_unread_holds_no_source CHECK (
        (origin = 'unread') = (source_gzip IS NULL)
    AND (source_gzip IS NULL) = (source_bytes IS NULL)
    AND (source_gzip IS NULL) = (source_digest IS NULL)
    AND (source_gzip IS NULL) = (ownership IS NULL)),
  CONSTRAINT app_deployment_baselines_discard_is_attributed CHECK (
        (discarded_digest IS NULL) = (discarded_by IS NULL)
    AND (discarded_by IS NULL) = (discarded_at IS NULL))
);

-- (f) A lookup table or a place as CommCare HQ returned it when a Nova app of
--     this Project last read it. Keyed by the HQ resource.
CREATE TABLE project_space_resource_baselines (
  project_id           text NOT NULL CHECK (btrim(project_id) <> ''),
  server               text NOT NULL CHECK (server IN ('production', 'india', 'eu')),
  domain               text NOT NULL CHECK (btrim(domain) <> '' AND char_length(domain) <= 255),
  kind                 text NOT NULL CHECK (kind IN ('lookup-table', 'location')),
  remote_id            text NOT NULL CHECK (btrim(remote_id) <> ''),
  origin               text NOT NULL CHECK (origin IN ('push', 'cutover', 'unread')),
  canonical            jsonb,        -- CanonicalLookupTable or CanonicalPlace; no row values
  digest               text CHECK (digest ~ '^[0-9a-f]{64}$'),
  observed_at          timestamptz(3) NOT NULL,
  observed_by          text NOT NULL CHECK (btrim(observed_by) <> ''),
  observed_from_app_id text NOT NULL CHECK (btrim(observed_from_app_id) <> ''),  -- provenance, no FK
  discarded_digest     text CHECK (discarded_digest ~ '^[0-9a-f]{64}$'),
  discarded_by         text,
  discarded_at         timestamptz(3),
  PRIMARY KEY (project_id, server, domain, kind, remote_id),
  CONSTRAINT project_space_resource_baselines_unread_holds_no_content CHECK (
        (origin = 'unread') = (canonical IS NULL)
    AND (canonical IS NULL) = (digest IS NULL)),
  CONSTRAINT project_space_resource_baselines_discard_is_attributed CHECK (
        (discarded_digest IS NULL) = (discarded_by IS NULL)
    AND (discarded_by IS NULL) = (discarded_at IS NULL))
);
```

Notes that are part of the decision:

- `remote_missing_at` is outside the column list of the trigger `app_deployment_resources_push_token` (`lib/case-store/migrations/20260906000000_deployment_push_tokens.ts`, `BEFORE UPDATE OF pushed_at, pushed_revision, remote_id`), so writing it rotates no push token. One assertion in `lib/case-store/migrations/__tests__/deploymentPushTokens.postgres.test.ts` holds that.
- The backfill keeps every existing deployment on the path it is on today: a persisted upload failure beside a live app mapping has only ever meant "gone", because `lib/deployment/stateMachine.ts::applyAttemptOutcome` persists no failure once a deployment displays as reached.
- The backfill is written for a shape that need not exist. Its `UPDATE` joins a live app mapping to a persisted upload failure, so where no deployment holds both it changes no row, and the migration's test seeds that shape to prove the statement. A deployment whose first upload failed before any mapping was written holds no `app_deployment_resources` row at all: the join skips it, it gets no `remote_missing_at` and (in the cutover) no baseline, and its next publish is a first publish.
- The ownership `adopted`, a `location` mapping and a baseline row two apps share are shapes the ledger admits whether or not any stored row has them. The migration changes none of them, and the tests below seed each one: no behavior of this part is proven by existing rows.
- `project_space_resource_baselines` needs no index beyond its primary key: every read is by `(project_id, server, domain, kind)` and a set of `remote_id`.
- `observed_at` is the interleaving guard: a baseline write lands only when its read is not older than the stored one (the upsert below).
- `discarded_*` records the last discard a person confirmed for that resource. It is the only durable trace of a destructive act a person confirmed, the same reason `adopted_by` exists.
- Nova has no runtime hard delete of an app (`lib/db/apps.ts` soft-deletes) and Project deletion is disabled, so `project_space_resource_baselines` has no deletion path. `lib/db/CLAUDE.md` gains the sentence that the future whole-tenant deletion lifecycle must list it.

### Row types (`lib/db/pg.ts`)

`lib/db/pg.ts::AppDatabase` gains the four tables. The two existing interfaces gain one column each.

```ts
export interface AppDeploymentResourcesTable {
  // existing columns, plus:
  remote_missing_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
}

export interface AppDeploymentsTable {
  // existing columns, plus:
  offered_logo_content_hash: ColumnType<string | null, string | null | undefined, string | null>;
  target_empty_case_list_text: ColumnType<boolean | null, boolean | null | undefined, boolean | null>;
}

export interface AppDeploymentIdentitiesTable {
  deployment_id: string;
  entity_kind: string;                 // 'module' | 'form', reasserted on read
  nova_entity_uuid: string;
  unique_id: string | null;
  xmlns: string | null;
  recorded_at: Timestamp;
}

export interface AppDeploymentConfirmationsTable {
  id: DefaultedUuidV7Column<string>;
  deployment_id: string;
  kind: string;                        // 'plan-feature' | 'flat-location-fixture' | 'connect-forwarder'
  subject: string;
  confirmed_by: string;
  confirmed_at: Timestamp;
  withdrawn_by: string | null;
  withdrawn_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
}

export interface AppDeploymentBaselinesTable {
  deployment_id: string;
  remote_app_id: string;
  origin: string;                      // 'create' | 'push' | 'cutover' | 'unread'
  source_gzip: Buffer | null;
  source_bytes: number | null;
  source_digest: string | null;
  ownership: JSONColumnType<Record<string, unknown> | null, string | null, string | null>;
  observed_at: ColumnType<Date, Date | string, Date | string>;
  observed_by: string;
  discarded_digest: string | null;
  discarded_by: string | null;
  discarded_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
}

export interface ProjectSpaceResourceBaselinesTable {
  project_id: string;
  server: string;
  domain: string;
  kind: string;                        // 'lookup-table' | 'location'
  remote_id: string;
  origin: string;                      // 'push' | 'cutover' | 'unread'
  canonical: JSONColumnType<Record<string, unknown> | null, string | null, string | null>;
  digest: string | null;
  observed_at: ColumnType<Date, Date | string, Date | string>;
  observed_by: string;
  observed_from_app_id: string;
  discarded_digest: string | null;
  discarded_by: string | null;
  discarded_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
}
```

### Privileges (`lib/db/privilegeConvergence.ts`)

| Table | List | Reason |
|---|---|---|
| `app_deployment_identities` | `RUNTIME_READ_ONLY_TABLES` | Step 2's only writer is the cutover, as the migration role. "A publish writes no identity row" is a privilege, not a convention. Step 6 raises it when imports write. |
| `app_deployment_confirmations` | `RUNTIME_INSERT_UPDATE_TABLES` | Inserted on confirm, updated on withdraw, never deleted, never row-locked. |
| `app_deployment_baselines` | `RUNTIME_INSERT_UPDATE_TABLES` | Upserted only. Serialized by the deployment row's `FOR UPDATE`, never locked itself. |
| `project_space_resource_baselines` | `RUNTIME_INSERT_UPDATE_TABLES` | Upserted only. |
| `app_migration_notices`, `app_migration_notice_key_readers` | `RUNTIME_READ_ONLY_TABLES` | Work item F. |
| `app_migration_notice_dismissals` | `RUNTIME_APPEND_ONLY_TABLES` | Work item F. |

`app_deployments` and `app_deployment_resources` stay read-write. The upserts are written with Kysely's `insertInto(...).onConflict(...doUpdateSet(...))`, which the source guard `lib/db/__tests__/runtimeRowLockPrivileges.test.ts` reads as INSERT plus UPDATE (its row-lock pattern matches `FOR UPDATE` and `FOR SHARE` only), both of which the insert-update class grants. `AUDIT_SELECT_PUBLIC_TABLES` does not change: the frozen scanner reads none of these.

### What a Project move does (`lib/db/apps.ts::commitAppProjectMoveInTransaction`)

| Table or column | Reaches the tenant through | On app deletion | In a Project move |
|---|---|---|---|
| `app_deployment_resources.remote_missing_at` | its deployment | cascades with the deployment | nothing |
| `app_deployments.offered_logo_content_hash` | the row's own `project_id` | cascades | nothing more: the row is already re-tenanted, and a content hash survives the move's asset-id remap (the reason the column is a hash and not an asset id) |
| `app_deployments.target_empty_case_list_text` | the row's own `project_id` | cascades | nothing more: it is a fact of the project space, which the move does not change |
| `app_deployment_identities` | `deployment_id` (CASCADE) | cascades | nothing |
| `app_deployment_confirmations` | `deployment_id` (CASCADE) | cascades | nothing. A confirmation is about the project space, so it stays true for the destination's members. |
| `app_deployment_baselines` | `deployment_id` (CASCADE) | cascades | nothing |
| `project_space_resource_baselines` | its own `project_id` | not removed | copy, never move: `INSERT ... SELECT` the source Project's `location` rows whose `(server, domain, remote_id)` a live `location` mapping of the moving app names, with the destination `project_id`, `ON CONFLICT (project_id, server, domain, kind, remote_id) DO UPDATE` with exactly the store's upsert below: `origin`, `canonical`, `digest`, `observed_at`, `observed_by` and `observed_from_app_id` take the copied row's values, each `discarded_*` column is `COALESCE(EXCLUDED.<column>, <the destination row's>)`, and the guard is `WHERE project_space_resource_baselines.observed_at <= EXCLUDED.observed_at`. So the newer read wins, an inserted copy carries the source row's `discarded_*`, and a destination row keeps its own discard record unless the copied row holds one. One statement shape for both writers is the reason. Source rows stay, because another app there may share the place. No `lookup-table` row is copied: an app that references lookup tables cannot move. |
| the notice tables | `apps(id)` or the notice | cascade | nothing |

### Domain types (`lib/deployment/types.ts`)

Each block below is headed by the pull request that lands it. A name is never declared before the file it imports from exists, so every pull request of the stack typechecks at its own head.

```ts
// ---- Pull request 2 (with the ledger) ----

export const DEPLOYMENT_CONFIRMATION_KINDS = ["plan-feature", "flat-location-fixture", "connect-forwarder"] as const;
export type DeploymentConfirmationKind = (typeof DEPLOYMENT_CONFIRMATION_KINDS)[number];

export interface DeploymentConfirmation {
  readonly kind: DeploymentConfirmationKind;
  /** A plain string here: `PlanFeatureId` does not exist until pull request 13. */
  readonly subject: string;
  readonly confirmedBy: string;
  /** `auth_user.name` by left join, or "A former member"; every projection shows this and never `confirmedBy`. */
  readonly confirmedByName: string;
  readonly confirmedAt: string;
}

export interface DeploymentResource {
  // existing fields, plus:
  /** Set when CommCare HQ reported this app gone; null for every other kind. */
  readonly remoteMissingAt: string | null;
}

export interface DeploymentRecord {
  // existing fields, plus:
  readonly offeredLogoContentHash: string | null;
}

export interface DeploymentWithResources {
  // existing fields, plus the live (not withdrawn) confirmations:
  readonly confirmations: readonly DeploymentConfirmation[];
}

/**
 * One id this target holds that is not Nova's derivation. Never part of DeploymentWithResources.
 * Pull request 3 moves this shape to `lib/commcare/wireIdentity.ts::WireIdentityOverride` and
 * makes this name its alias (part 01, A1. Derived ids, and why `Form.xmlns` is not stored), because `lib/commcare` imports nothing from
 * `lib/deployment`.
 */
export interface DeploymentIdentityOverride {
  readonly entityKind: "module" | "form";
  readonly novaEntityUuid: string;
  readonly uniqueId: string | null;
  readonly xmlns: string | null;     // forms only
}

/** What Nova's upload owned inside the overlay keys when a baseline was recorded. */
export interface AppOwnership {
  readonly addOns: readonly string[];
  readonly profileProperties: readonly string[];
  readonly profileCustomProperties: readonly string[];
  readonly autoGpsCapture: boolean;
}

export type AppBaseline =
  | {
      readonly origin: "create" | "push" | "cutover";
      readonly remoteAppId: string;
      /** The normalized read (hqSourceBaseline.ts::normalizeHqAppSource). */
      readonly source: unknown;
      readonly sourceDigest: string;
      readonly ownership: AppOwnership;
      readonly observedAt: string;
      readonly observedBy: string;
    }
  | {
      readonly origin: "unread";
      readonly remoteAppId: string;
      readonly observedAt: string;
      readonly observedBy: string;
    };

export interface CanonicalLookupTable {
  readonly remoteId: string;
  readonly tag: string;
  readonly isGlobal: boolean;
  readonly fields: readonly { readonly name: string; readonly properties: readonly string[] }[];
  readonly itemAttributes: readonly string[];
  readonly rowCount: number;
  readonly rowsDigest: string;       // sha256 over the rows in HQ's order; see "Lookup table baselines"
  readonly definitionDigest: string; // sha256 over tag, isGlobal, fields and itemAttributes
  readonly digest: string;           // sha256 over everything above except remoteId
}

export interface CanonicalPlace {
  readonly remoteId: string;
  readonly name: string;
  readonly siteCode: string;
  readonly locationTypeCode: string;
  readonly parentRemoteId: string | null;
  readonly latitude: string | null;  // as CommCare HQ returned it
  readonly longitude: string | null;
  readonly ownedData: Readonly<Record<string, unknown>>;  // location_data restricted to ownedKeys
  readonly ownedKeys: readonly string[];                  // the place-information slugs that push modeled
  readonly digest: string;           // sha256 over everything above except remoteId
}

export type ResourceBaseline =
  | {
      readonly origin: "push" | "cutover";
      readonly kind: "lookup-table" | "location";
      readonly remoteId: string;
      readonly canonical: CanonicalLookupTable | CanonicalPlace;
      readonly digest: string;
      readonly observedAt: string;
    }
  | {
      readonly origin: "unread";
      readonly kind: "lookup-table" | "location";
      readonly remoteId: string;
      readonly observedAt: string;
    };

// ---- Pull request 4 (work item B) ----

/** Names one HQ table or place a baseline is kept for. */
export interface ResourceBaselineRef {
  readonly kind: "lookup-table" | "location";
  readonly remoteId: string;
}

/** What a caller names when a person chose to write over an HQ-side change. */
export interface RemoteChangeDiscard {
  readonly kind: "app" | "lookup-table" | "location";
  readonly novaResourceId: string;
  readonly observedDigest: string;
}

/** One HQ-side change a refusal lists. Defined in full under "The refusal, the discard and the copy". */
export interface DeploymentRemoteChange { /* kind, novaResourceId, name, identity, parts, observedDigest, baselineKnown */ }

/**
 * A discard a person confirmed, recorded with the baseline its push produces.
 * It carries no person: `discarded_by` is `scope.actorUserId` and
 * `discarded_at` is the transaction's `now()`.
 */
export interface BaselineDiscardWrite {
  readonly digest: string;           // the HQ state the person chose to write over
}

/** What a store writer takes. Gzip and digests are computed before the transaction. */
export interface AppBaselineWrite {
  readonly origin: "create" | "push" | "unread";
  readonly remoteAppId: string;
  readonly sourceGzip: Buffer | null;
  readonly sourceBytes: number | null;
  readonly sourceDigest: string | null;
  readonly ownership: AppOwnership | null;
  readonly observedAt: string;
  readonly discard: BaselineDiscardWrite | null;
}

export interface ResourceBaselineWrite {
  readonly origin: "push" | "unread";
  readonly kind: "lookup-table" | "location";
  readonly remoteId: string;
  readonly canonical: CanonicalLookupTable | CanonicalPlace | null;
  readonly digest: string | null;
  readonly observedAt: string;
  readonly discard: BaselineDiscardWrite | null;
}

// ---- Pull request 13 (work item C, with lib/publish/planFeatures.ts) ----

/** What a caller names when a person confirmed it. `PlanFeatureId` is lib/publish/planFeatures.ts's. */
export type DeploymentConfirmationKey =
  | { readonly kind: "plan-feature"; readonly subject: PlanFeatureId }
  | { readonly kind: "flat-location-fixture" }
  | { readonly kind: "connect-forwarder" };
```

Which pull request lands which type, and why:

| Lands in | Types | Reason |
|---|---|---|
| pull request 2 | `DEPLOYMENT_CONFIRMATION_KINDS`, `DeploymentConfirmationKind`, `DeploymentConfirmation` (with `subject: string`), `DeploymentWithResources.confirmations`, `DeploymentResource.remoteMissingAt`, `DeploymentRecord.offeredLogoContentHash`, `DeploymentRecord.targetEmptyCaseListText` (`boolean | null`: null until a publish has read the flag), the `DeploymentIdentityOverride` interface, and the baseline read types `AppOwnership`, `AppBaseline`, `CanonicalLookupTable`, `CanonicalPlace`, `ResourceBaseline` | Each is the read side of a column or table the migration adds, and none imports a file a later pull request creates. The read mappings that fill them land in the same pull request (see the store tables below), so pull request 3 adds behavior over a field that already exists. |
| pull request 3 | `DeploymentIdentityOverride` becomes the alias of `lib/commcare/wireIdentity.ts::WireIdentityOverride` | part 01, A1. Derived ids, and why `Form.xmlns` is not stored, owns the shape from then on. |
| pull request 4 | `ResourceBaselineRef`, `RemoteChangeDiscard`, `DeploymentRemoteChange`, `BaselineDiscardWrite`, `AppBaselineWrite`, `ResourceBaselineWrite`, `PublishInput.discardRemoteChanges`, `DeploymentAttemptRefusal.remoteChanges` | They are the comparison's and the writers' types, and the writers need `lib/deployment/hqSourceBaseline.ts`. |
| pull request 13 | `DeploymentConfirmationKey`, `PublishInput.confirm`, `DeploymentConfirmationNeeded`, `DeploymentAttemptRefusal.confirmationsNeeded` | `PlanFeatureId` is declared in `lib/publish/planFeatures.ts`, which pull request 13 creates (part 03, C2. Plan features: the per-privilege confirmation). A pull request 2 type cannot import it. |

The failure codes land with their producers, each in the same three places (`lib/deployment/types.ts::DEPLOYMENT_FAILURE_CODES`, `lib/mcp/errors.ts::UploadErrorType`, `lib/mcp/tools/uploadAppToHq.ts::UPLOAD_ERROR_TAGS`, where the `satisfies Record` makes a missed one a compile error):

| Code | Lands in | Producer |
|---|---|---|
| `hq_changed` | pull request 4 | work item B |
| `hq_table_content_unsupported` | pull request 14 | defect 5 |
| `hq_confirmation_needed`, `hq_app_version_below_floor` | pull request 13 | work item C (part 03, C1. The version floor, and C2. Plan features: the per-privilege confirmation) |

A baseline's `observed_by` and `discarded_by` are `scope.actorUserId`, and a resource baseline's `observed_from_app_id` is `scope.appId`; a writer never takes any of the three from its caller. A `create` baseline's `ownership` is the ownership of the shell body `hqImportApplication` returned for the create (no add-on, no profile key, `autoGpsCapture` as the shell carried it), which satisfies the CHECK that a stored source has one.

### Store functions (`lib/deployment/store.ts`)

Unless stated, each is one `store.ts::withDeploymentRow` transaction: the app row `FOR SHARE` with the Project and role re-proved (`store.ts::lockAppForDeploymentWrite`), the deployment row `FOR UPDATE`, the fold on the fresh row, commit. None holds a lock across an HQ request. `withAppTx` re-runs its body on a serialization or deadlock retry, which is why gzip and digests arrive computed.

Each row names the pull request that lands it. Where part 01 or part 03 is named, that part owns the function's text and this table states only what the ledger needs of it.

Changed:

| Function | Change | Tables written in the one transaction | Lands in |
|---|---|---|---|
| `loadResources` and its three callers, `readDeploymentsForApp`, `readDeployment` and `loadWithinTransaction` | also load live confirmations (`withdrawn_at IS NULL`) for the same deployment ids, left-joined to `auth_user` on `confirmed_by` so each carries `confirmedByName` (`auth_user.name`, the join `lib/projects/membership.ts::listProjectMembers` makes, or "A former member" when that user no longer exists); `toDeploymentResource` maps `remote_missing_at`; `toDeploymentRecord` maps the logo hash | none | pull request 2 |
| `writeResourceMapping` | its conflict arm also sets `remote_missing_at = NULL` | `app_deployment_resources` | pull request 3 (part 01, A3. The publish sequence) |
| `applyDeploymentObservation` | Under the same remote-id and push-token guard: an `upload` outcome that failed with `remote_app_missing` sets `remote_missing_at = now` on the active app mapping; a succeeded `upload` outcome clears it. | as today | pull request 3 (part 01, A3. The publish sequence) |
| `recordRemoteResource(scope, target, input)` | `input` gains the required `baseline: AppBaselineWrite` (which carries the discard, as `ResourceBaselineWrite` does) | `app_deployment_resources`, `app_deployment_baselines`, `app_deployments` | pull request 4 |
| `recordRemoteResource(scope, target, input)` | `input` gains `offeredLogoContentHash?: string \| null` (the column is written only when the field is present; `null` clears it) | `app_deployments` | pull request 13 (part 03, C6. Defect 14: logos) |
| `recordPushedResources(scope, target, inputs, outcome, baselines?)` | `baselines: readonly ResourceBaselineWrite[]`, upserted in `(kind, remote_id)` order (two apps of a Project can write overlapping sets, and a fixed order keeps them from deadlocking). Allowed with every outcome status. | `app_deployment_resources`, `project_space_resource_baselines`, `app_deployments` | pull request 4 |
| `foldDeploymentAttempt(scope, target, phase, outcome, { ensure?, confirmations? })` | `confirmations` (allowed only with a succeeded `preflight`) are inserted `ON CONFLICT (deployment_id, kind, subject) WHERE withdrawn_at IS NULL DO NOTHING`, with `confirmed_by = scope.actorUserId`, whether or not the fold changed the record | `app_deployments`, `app_deployment_confirmations` | pull request 13 (part 03, C2. Plan features: the per-privilege confirmation) |

New:

| Function | Transaction | Reads or writes | Lands in |
|---|---|---|---|
| `recordCreatedRemoteApp(scope, target, { remoteId, baseline })` | `withDeploymentRow`, `ensure: false` | `writeResourceMapping` for the `app` kind with `pushedRevision: null`, `remoteRevision: null`; `notifyAppDeployments`. Folds no rung. From pull request 4 it also takes `baseline` and upserts the `create` (or `unread`) baseline in the same transaction. | pull request 3 (part 01, A3. The publish sequence); the `baseline` argument in pull request 4 |
| `readDeploymentIdentityOverrides(scope, target)` | none (plain read, `view`) | `app_deployment_identities` joined to the target's deployment. Empty for a target with no deployment. | pull request 3 (part 01, A1. Derived ids, and why `Form.xmlns` is not stored) |
| `readReachedDeploymentTargets(scope)` | none (plain read, `view`) | Replaces `readDeploymentPreviewRecords` for the download resolver: for each deployment that displays as reached and whose app mapping is live and not missing, `{ server, domain, hqAppId }`. | pull request 3 (part 01, A5. Downloads by project space) |
| `markResourceBaselinesUnread(scope, target, refs)` | `withDeploymentRow` | Upserts `unread` rows for resources a push may have changed and Nova could not read back. `refs` is `readonly ResourceBaselineRef[]` (`lib/deployment/types.ts`). | pull request 4 |
| `readAppBaseline(scope, target)` | none (plain read, `edit`) | One row. Gunzips and verifies `source_digest` outside any transaction; a mismatch is logged at `error` and returned as `unread`. `edit`, not `view`: the row holds HQ app source. | pull request 4 |
| `readResourceBaselines(scope, target, refs)` | none (plain read, `edit`) | Rows of this Project and target for the `(kind, remote_id)` pairs in `refs` (`readonly ResourceBaselineRef[]`). A pair with no row is absent from the result, and the caller treats it as `unread`. | pull request 4 |
| `withdrawDeploymentConfirmation(scope, target, { kind, subject })` | `withDeploymentRow`, `ensure: false` | `UPDATE app_deployment_confirmations SET withdrawn_by, withdrawn_at` where live; returns the view. A no-op when nothing is live. | pull request 13 (part 03, C2. Plan features: the per-privilege confirmation) |

The Project-move copy in `lib/db/apps.ts::commitAppProjectMoveInTransaction` and its test land in pull request 2 with the table it copies. Until pull request 4 writes a baseline the copy moves no row, and its test seeds the rows it copies.

The baseline upsert, the same shape for both tables:

```sql
INSERT INTO app_deployment_baselines (...) VALUES (...)
ON CONFLICT (deployment_id) DO UPDATE SET
  remote_app_id = EXCLUDED.remote_app_id, origin = EXCLUDED.origin,
  source_gzip = EXCLUDED.source_gzip, source_bytes = EXCLUDED.source_bytes,
  source_digest = EXCLUDED.source_digest, ownership = EXCLUDED.ownership,
  observed_at = EXCLUDED.observed_at, observed_by = EXCLUDED.observed_by,
  discarded_digest = CASE WHEN EXCLUDED.remote_app_id = app_deployment_baselines.remote_app_id
                          THEN COALESCE(EXCLUDED.discarded_digest, app_deployment_baselines.discarded_digest)
                          ELSE EXCLUDED.discarded_digest END,
  -- discarded_by and discarded_at the same way; the inserted values are
  -- scope.actorUserId and now() when the write carries a discard, else NULL
WHERE app_deployment_baselines.remote_app_id <> EXCLUDED.remote_app_id
   OR app_deployment_baselines.observed_at <= EXCLUDED.observed_at;
```

The `WHERE` is the fold's precondition. Publish A reads back, publish B imports, reads back and records, then A records late: without the guard A's older read would replace B's and the next publish would stop over Nova's own push. With it the stored baseline is always the newest read, which is HQ's actual state. `project_space_resource_baselines` uses `observed_at <= EXCLUDED.observed_at` alone (its key already holds the remote id).

Not in `store.ts`: the cutover's writes (identity rows, `cutover` and `unread` baselines, `remote_missing_at` with the folded `remote_app_missing` failure for a deleted app). The cutover has no acting member, so it cannot build a `DeploymentScope` or pass `lockAppForDeploymentWrite`. It writes raw statements in `scripts/lib/hqRoundTripCutover/writer.ts` as the migration role, inside its one fleet transaction. Its `observed_by` is the user id whose stored key answered the read, or `system:hq-round-trip-emission` for an `unread` row no key could read. The runtime role's read-only privilege on `app_deployment_identities` depends on this split.

Pure selectors (`lib/deployment/resources.ts`): defined in part 01, A3. The publish sequence (`plannedInPlaceUpdate`, `remoteAppHoldsContent`, `publishedRemoteApp`, `nextPublishAction`), pull request 3. This part reads `plannedInPlaceUpdate` to decide whether the `target-app` edge runs, and restates none of them.

`lib/deployment/service.ts::refreshDeployment` also allows an observation when the active mapping's `remoteMissingAt` is set, and `stateMachine.ts::deploymentIsObservable` is unchanged; both are part 01's, in pull request 3.

### Tests for the schema and the store

| Contract | Boundary |
|---|---|
| Every CHECK and partial unique index refuses what it names (an `unread` baseline with a source, a discard with no person, two live confirmations of one subject, an identity row with neither id, `remote_missing_at` on a table mapping); the backfill marks exactly live app mappings beside a failed upload, and leaves untouched a superseded mapping, a table mapping, a reached deployment, and a deployment that failed its upload and holds no resource row; writing `remote_missing_at` rotates no push token | real Postgres: new `lib/case-store/migrations/__tests__/deploymentLedger.postgres.test.ts`, and one assertion in `deploymentPushTokens.postgres.test.ts` |
| Each case lands with the function it exercises. Pull request 2: a seeded live confirmation is read with its `confirmedByName`, a withdrawn one is omitted, and one whose user no longer exists reads "A former member"; `remoteMissingAt` and `offeredLogoContentHash` are read as stored. Pull request 3: `recordCreatedRemoteApp` folds no rung. Pull request 4: mapping and baseline commit together or not at all; the `observed_at` guard keeps the newer read when two publishes record out of order; two apps mapping one HQ table share one row and write it without deadlock; an `adopted` table mapping and an `adopted` place mapping write and read their baselines as `nova-created` ones do; `readAppBaseline` returns `unread` for a row whose digest does not match; `recordCreatedRemoteApp` writes the `create` baseline with its mapping. Pull request 13: a confirmation given with a succeeded preflight is stored once, and a withdrawal makes the next read omit it | real Postgres: `lib/deployment/__tests__/store.postgres.test.ts` |
| A Project move copies the moving app's place baselines to the destination, leaves the source rows, keeps the newer row on conflict, and carries a discard record by the upsert's rule (pull request 2, over seeded rows) | real Postgres: `lib/db/__tests__/projectMove.postgres.test.ts` |
| The runtime role cannot insert into `app_deployment_identities` and cannot delete from the three insert-update tables | real Postgres: `lib/db/__tests__/privilegeConvergence.postgres.test.ts`, which derives from the lists |

## Work item B: the drift check and its baselines

### The decisions

1. **A baseline is HQ's own read, never what Nova sent.** Every baseline is the normalized form of what HQ returned when Nova read it: right after Nova's push (`push`), right after the shell create (`create`), or at the cutover (`cutover`). The check then compares one HQ read with another. Reason: HQ serializes every property its models declare and an update replaces `modules` whole (`models/applications.py::_merge_source_into_app`), so comparing a sent body with a read would need HQ's defaults modeled in TypeScript, and any gap in that model is a false stop on every publish. Executed during planning in the lane's HQ: two reads of an unchanged app are identical once each read's form ids are replaced by position, after a create, after an update and after the media upload, and each form's attachment text is byte-equal to what Nova uploaded.
2. **Every drift decision is made in preflight, before any write.** Reason: a stop at the app after tables and places were already pushed would leave them overwritten. `lib/deployment/CLAUDE.md` already requires that everything a person could have decided differently is settled before the first write.
3. **One refusal, `hq_changed`, lists every change of every kind.** It is all or nothing, like a name clash: one unconfirmed change stops the whole publish. Two codes would force a caller to pick one.
4. **A discard is bound to the state the person saw.** The request names each resource with the digest of HQ's state as the refusal showed it. A digest HQ has since left is refused again with the new one. Nothing is stored until the push it authorizes lands.
5. **An `unread` baseline always stops and offers the discard.** This is stricter than "stop only if HQ holds something else" for tables and places. Reason: the alternative is the sent-versus-read model decision 1 rejects, for a state that needs a failed read to arise.
6. **XForm attachments are compared as exact text.** Reason: executed during planning, HQ returns the uploaded bytes unchanged, so no canonical XML form is needed for read against read; and a parse that erased some of what HQ's form builder re-spells would be a partial second copy of the lane's spelling rules, which decision 7 declines.
7. **A save in an HQ editor that changes no value can still stop the next publish.** HQ's saves write keys Nova does not, and Vellum re-spells XML. Executed during planning on `navigation-base`, on a project space with the Web Apps and Save to Case privileges and no other, each save made through HQ's own page over Nova's publish with nothing changed, and the two source reads compared under the projection below:

   | Save in CommCare HQ, nothing changed | What the comparison finds | Outcome |
   |---|---|---|
   | App Settings | `profile` and `last_modified` only, neither compared | proceeds |
   | Case Management (a form) | `last_modified` only | proceeds |
   | Add-ons | one add-on Nova's body sets (`advanced_itemsets`) reads differently | stops, part `settings` |
   | Menu settings | media and case-list-form label keys added under the menu | stops, part `menu` |
   | Case List, Case Detail | per-column layout keys added, and for the Case List three tile keys and `parent_select.module_id` | stops, part `menu` |
   | Form settings | media keys and `post_form_workflow_fallback` added under the form | stops, part `form` |
   | Form builder (Vellum) | the form's attachment text | stops, part `form` |

   Accepted, for three reasons: someone did save the app in HQ; the discard is one confirmation; and porting the lane's spelling rules (`proof/rules/`) into the publish path would be a second copy that drifts from the first. The stop's copy and the public docs say so. The retained reads below keep one read after each of these saves, so the table is held by HQ's own answers on every pull request.
8. **Nova does not use a definition probe** (see "Defect 5: the lookup push" below).
9. **Step 2 offers the discard and nothing else.** Bringing HQ's change into Nova is step 6.
10. **A shell is exempt from the stop, except for menus.** While a deployment's stored app baseline has origin `create` (a shell with no content yet), the app comparison reads only `modules`. A menu added in HQ stops with `hq_changed`; any other change, such as raising the CommCare version in the app's settings, does not. Reason: nothing of Nova's is there to protect, and the version floor's own next step (raise the version in HQ, part 03, C1. The version floor) would otherwise always be followed by a discard prompt. Executed during planning: an App Settings save over a shell left `modules` empty and moved only `profile` and `last_modified`, and a menu added by HQ's own model is a `modules` difference. A failed read after the create records `unread`, which stops as decision 5 says: the exemption belongs to a shell Nova read, never to one it could not.

### The pure modules

All three are pure, hold no I/O and no `server-only`, import types only from `lib/deployment/types.ts` and `lib/commcare`, and are reached by unit tests with no database. The two comparison modules return typed parts and hold no copy; every sentence a person reads is in `remoteChanges.ts`.

**`lib/deployment/hqSourceBaseline.ts`**

```ts
/** The stored form of one app source read. Returns { malformed } for anything that is not an Application source. */
export function normalizeHqAppSource(source: unknown):
  | { readonly normalized: unknown; readonly text: string; readonly digest: string; readonly bytes: number }
  | { readonly malformed: string };

/** What is compared: the normalized read restricted to what Nova writes, under one ownership descriptor. */
export function ownedProjection(normalized: unknown, ownership: AppOwnership): unknown;

export type AppChangePart =
  | { readonly kind: "name" | "languages" | "settings" | "text" | "menu-list" }
  | { readonly kind: "menu"; readonly menu: number; readonly name: string }
  | { readonly kind: "form"; readonly menu: number; readonly form: number; readonly name: string };

/**
 * Empty when nothing Nova writes differs. Both sides are projected with the BASELINE's ownership.
 * With `shell: true` (the stored baseline's origin is `create`) only `modules` is projected,
 * and a difference there is the one part `menu-list`.
 */
export function diffHqAppSource(input: {
  readonly baseline: unknown;                  // a normalized read
  readonly current: unknown;                   // a normalized read
  readonly ownership: AppOwnership;            // the baseline's
  readonly shell: boolean;                     // the stored baseline's origin is `create`
  readonly schemaDefault: SchemaDefaultReader; // lib/commcare/surface/schemaDefaults.ts::schemaPropertyDefault in production
}): readonly AppChangePart[];
```

`diffHqAppSource` reads `readHqAppSource`'s `raw` (part 01, A3. The publish sequence, under `readHqAppSource`) through `normalizeHqAppSource` and never the reader's parsed fields, so a field the reader does not name is still compared.

`normalizeHqAppSource` returns the source with exactly these changes, and `text` is its canonical JSON (`lib/utils/canonicalJson.ts::canonicalJsonText`), `digest` the sha256 of that text:

| Change | Why |
|---|---|
| Each form's `unique_id` replaced by its position token `m<i>.f<j>` | Every read mints a fresh id for every form (`models/applications.py::Application.scrub_source`, `util.py::update_form_unique_ids`), a shadow form's among them. Executed during planning: neither of two reads serves the stored id. |
| Each value at the four form-id reference paths replaced by the token of the form it names, or `{ "unresolved": <value> }` when it names none: `modules[*].case_list_form.form_id`, `modules[*].forms[*].form_links[*].form_id`, `modules[*].forms[*].shadow_parent_form_id`, `modules[*].schedule_phases[*].forms[*].form_id` | `models/base.py::form_id_references`, filled by `models/base.py::FormIdProperty`, which holds exactly these four paths at the pin. All four were executed during planning in the lane's HQ: the form link on a corpus document, and the other three on `navigation-base` after HQ's own models gave it a case-list form, an advanced menu with a shadow form and a two-phase visit schedule, and a report menu. Each read rewrote every one of those references to the id that same read minted for the form it names, and the two reads normalized to the same text and digest. Nova emits none of the last three; they reach a read only when a person adds them in CommCare HQ, where an unstable digest would make a confirmed discard unusable. |
| Each form's attachment re-keyed from `<that read's id>.xml` to `<token>.xml`; every other attachment removed | A form's attachment follows its minted id. Attachments no current form owns stay in HQ for good and are served under stable keys on every read, and a shadow form owns no attachment (both executed during planning), so attachments are paired through the forms of the same response and never by key set or count. |
| `admin_password` and `admin_password_charset` removed | `models/applications.py::ApplicationBase.admin_password` is a salted hash, and every read carries both keys (executed during planning). Nova stores no secret it does not need. |
| `modules[*].report_configs[*].uuid` removed | `util.py::update_report_module_ids` mints one per read (executed during planning: two reads of one report menu served four different uuids for its two configs). `report_slug` is kept: where the stored slug is empty each read fills it with the stored uuid, the same value every time, and a slug a person set is served as set. |

Everything else is kept as HQ returned it, including module `unique_id`, form `xmlns`, `last_modified`, `build_spec` and `multimedia_map`, so step 6's reader can read a stored baseline unchanged. `models/case_list.py::DetailColumn.endpoint_action_id` is declared with `FormIdProperty` and no path expression, so it registers no reference: executed during planning, a column that names a form by its stored id is served with that stored id on every read, while the form's own `unique_id` beside it is minted afresh. It is kept as returned, and it is stable.

**`lib/deployment/hqResourceBaseline.ts`**

```ts
export type LookupChangePart =
  | { readonly kind: "deleted" }
  | { readonly kind: "renamed"; readonly tag: string }   // the tag HQ's table carries now
  | { readonly kind: "definition" }
  | { readonly kind: "rows" };

export type PlaceChangePart = {
  readonly kind: "missing" | "name" | "site-code" | "level" | "parent" | "coordinates" | "information";
};

export function canonicalLookupTable(table: HqLookupTable, rows: readonly HqFixtureRow[]): CanonicalLookupTable;
/** The digest of a table's definition alone, for the cases where its rows are not read. */
export function lookupDefinitionDigest(table: HqLookupTable): string;
export function canonicalPlace(place: HqLocation, ownedKeys: readonly string[]): CanonicalPlace;

/**
 * The digest of "CommCare HQ no longer holds this", so an absence can be
 * confirmed like any other state: sha256 of the canonical JSON text of
 * { "absent": true }.
 */
export const ABSENT_RESOURCE_DIGEST: string;

/** Needs no baseline: where the mapped table is now. Null when it still holds Nova's tag. */
export function lookupIdentityChange(input: {
  readonly mappedRemoteId: string;
  readonly tag: string;                          // Nova's tag for the table
  readonly tables: readonly HqLookupTable[];     // the whole list read
}): { readonly kind: "deleted" } | { readonly kind: "renamed"; readonly tag: string } | null;

/** Empty, or one `definition` part. `current` is the table that holds the tag and the mapped id. */
export function lookupDefinitionChange(
  baseline: CanonicalLookupTable, current: HqLookupTable,
): readonly LookupChangePart[];

/** Empty, or one `rows` part. Called only when the two functions above found nothing. */
export function lookupRowsChange(
  baseline: CanonicalLookupTable,
  rows: { readonly totalCount: number; readonly rows: readonly HqFixtureRow[] },
): readonly LookupChangePart[];

/** `current` is null for a place the inventory read does not list. One part per field that differs. */
export function placeChange(baseline: CanonicalPlace, current: HqLocation | null): readonly PlaceChangePart[];
```

**`lib/deployment/remoteChanges.ts`**

```ts
export function decideRemoteChanges(input: {
  readonly observed: readonly DeploymentRemoteChange[];        // everything preflight collected
  readonly discards: readonly RemoteChangeDiscard[];           // lib/deployment/types.ts
}): { readonly proceed: true; readonly confirmed: readonly DeploymentRemoteChange[] }
  | { readonly proceed: false; readonly remoteChanges: readonly DeploymentRemoteChange[] };

/** Every sentence a part becomes. The copy table below is their whole content. */
export function describeAppChange(part: AppChangePart): string;
export function describeLookupChange(part: LookupChangePart, novaTag: string): string;
export function describePlaceChange(part: PlaceChangePart): string;
/** At most 20 lines; past 20 the last line is "and N more". */
export function boundedParts(lines: readonly string[]): readonly string[];
```

`decideRemoteChanges` proceeds only when every observed change is named by a discard whose `kind`, `novaResourceId` and `observedDigest` all match. A discard naming something that did not change is ignored. Preflight builds each `DeploymentRemoteChange.parts` with the three `describe` functions and `boundedParts`.

**The ownership descriptor.** There is one producer: `lib/deployment/importApplication.ts::hqImportApplication` returns the `AppOwnership` of the body beside the body, so the descriptor is derived from the bytes Nova sends and can never name a key the body does not hold. Every consumer here (the `push` and `create` baselines, the second read, the cutover) reads it from that return and from nowhere else.

- In pull request 4, `hqImportApplication` computes it with new `lib/commcare/appOwnership.ts::appOwnershipOf(appJson)`: the `add_ons` slugs the body sets, the `profile.properties` and `profile.custom_properties` keys it writes, and whether it writes `auto_gps_capture`, as the emitter stands at that head.
- Pull request 5 (defects 4 and 7) replaces that call with the `ownership` that `lib/commcare/targetOverlay.ts::projectApplicationForTarget` returns, and deletes `lib/commcare/appOwnership.ts` with its test, whose cases move to `lib/commcare/__tests__/targetOverlay.test.ts`. Nothing else in this section changes, because no consumer names the producer.

### What is compared and what is ignored

`ownedProjection` keeps:

| Kept | Rule |
|---|---|
| `modules` | deep, whole, with tokens in place of form ids |
| each form's attachment | exact text, under its token |
| `name`, `langs`, `application_version`, `location_fixture_restore` | as written |
| `translations` | In pull request 4, whole: the body at that head replaces the key whole (`lib/commcare/hqShells.ts::applicationShell`), so every key is one Nova writes. From pull request 5, per language, only the keys `lib/commcare/appStringKeys.ts::translationKeyOwner(key, codes)` does not answer `"target"` for, where `codes` is the union of the BASELINE read's `langs` and the current read's `langs`, the same set for both projections. The language-name class depends on the codes, which is why one set is used for both sides. The function is imported and never restated here. |
| `add_ons` | only `ownership.addOns` |
| `profile.properties`, `profile.custom_properties` | only `ownership.profileProperties` and `ownership.profileCustomProperties` |
| `auto_gps_capture` | only when `ownership.autoGpsCapture` |

Everything else is ignored: every key an update never writes (`models/applications.py::ApplicationBase._update_excluded_fields` plus `build_spec` and `_attachments`, which includes `multimedia_map`, `build_profiles`, `date_created`, `family_id`), `last_modified` (stamped by every save), `logo_refs` (Nova writes none from step 2), and every target-owned key Nova never sends (`cloudcare_enabled`, `case_sharing`, `use_grid_menus`, `custom_assertions` and the rest of the Application document).

**The shell.** While the stored app baseline's origin is `create`, `ownedProjection` keeps `modules` only (decision 10): any menu in the shell is `hq_changed` with the one part `menu-list`, and every other difference proceeds, the attachments, `name`, `langs`, `translations`, `add_ons`, `profile` and the CommCare version among them. The first push replaces the baseline with one of origin `push`, from which the whole table above applies.

The comparison projects BOTH the stored baseline and HQ's current read with the BASELINE's descriptor, at check time, with the code as it then stands. So a later step that changes the kept sets, or a publish whose document now needs another add-on, never reads as a change, and no version number for the comparison is needed.

**The schema-growth rule.** `diffHqAppSource` walks both projections as structure and has one rule beyond equality. At an object that carries a `doc_type`, a key present on one side and absent from the other is no difference when its value is the default `lib/commcare/surface/surface.json` records for `schema:<doc_type>.<key>`, or, for a key the manifest does not list, when its value is empty (null, false, zero, an empty string, list or map). At a position the manifest types as `DictProperty` or `SchemaDictProperty`, every key is content. Reason: HQ's serialization writes every declared property, so a property HQ adds to a model appears in every later read of every app, and without this rule each such HQ release would stop every deployment's next publish for a change nobody made. Executed during planning: a stored `navigation-base` document stripped of every declared key that held its manifest default (246 keys across the app, its menus, forms, details and columns) read back equal to the unstripped read everywhere but at one key, `Detail.display` under a menu's `ref_details`, which HQ fills from the detail's position and the manifest records as null. So a declared property a stored document lacks does read at the manifest's default, with that one exception, and the lane holds the premise at every pin (the retained reads below). Cost, accepted: a person who sets a property HQ's model gained after the baseline was read, to an empty value or its default, is not seen. New `lib/commcare/surface/schemaDefaults.ts` exports `type SchemaDefaultReader = (docType: string, key: string) => { readonly known: boolean; readonly default: unknown; readonly isMap: boolean }` and `schemaPropertyDefault`, the one production value of that type. It reads the manifest item `schema:<docType>.<key>`: `known` is whether the item exists, `default` is its `default`, and `isMap` is whether its `type` is `DictProperty` or `SchemaDictProperty`. Tests pass a hand-built reader.

**What a part names.** `parts` on a change is at most 20 lines (`remoteChanges.ts::boundedParts`), in Nova's voice, named from HQ's current read. These are all of them:

| Part | Sentence |
|---|---|
| app, `form` | "The form `<name>` in the menu `<menu name>`" |
| app, `menu` | "The menu `<name>`" |
| app, `menu-list` | "The list of menus" |
| app, `name` | "The app's name" |
| app, `languages` | "The app's languages" |
| app, `settings` (any difference in `application_version`, `location_fixture_restore`, `add_ons`, `profile` or `auto_gps_capture`) | "A setting this app writes" |
| app, `text` (any difference in `translations`) | "Text this app writes" |
| table, `definition` | "Its columns changed in CommCare HQ." |
| table, `rows` | "Its rows changed in CommCare HQ." |
| table, `deleted` | "CommCare HQ no longer has this table. Publishing makes it again." |
| table, `renamed` | "This table now has the tag `<tag>` in CommCare HQ. Publishing makes a new table under `<Nova's tag>` and leaves that one where it is." |
| place, `name` | "Its name changed." |
| place, `site-code` | "Its site code changed." |
| place, `level` | "Its level changed." |
| place, `parent` | "It moved under another place." |
| place, `coordinates` | "Its coordinates changed." |
| place, `information` | "Its place information changed." |
| place, `missing` | "CommCare HQ no longer lists this place. It was archived or deleted there. Publishing makes it again if it was deleted. If it was archived, CommCare HQ refuses the publish while the place stays archived there." |

An app change lists one line per differing menu or form, in HQ's order, then the app-level lines. A change whose baseline is `unread` has no parts; the dialog shows the `baselineKnown: false` sentence in their place.

### Lookup table baselines

- **Reads.** The definition comes from `fixtures/resources/v0_1.py::LookupTableResource`, which returns `id`, `is_global`, `tag`, `fields` (each a name with its properties) and `item_attributes`. The rows come from `fixtures/resources/v0_1.py::FixtureResource` filtered by `fixture_type_id`, in HQ's own order (`fixtures/models.py::LookupTableRowManager.iter_rows`). Everything in this block was executed during planning through those resources in the lane's HQ, with an API key:
  - the definition read returns exactly those five keys, with neither a description nor an indexed flag, 20 tables a page unless `limit` is sent, and it answers without the lookup-table privilege;
  - the rows read returns at most 1,000 rows a page whatever `limit` asks: over a table of 1,005 rows, no `limit`, `limit=0`, `limit=1000` and `limit=5000` each answered the first 1,000 in `sort_key` order with `meta.total_count` 1005 and a relative `meta.next`;
  - `fixtures/resources/v0_1.py::LookupTableItemResource` is not used: asked for one table's rows by `data_type_id` it answered every row of the project space.
- **Client changes, all in pull request 4** (defect 5 reuses them in pull request 14 and adds nothing to the client's read side).
  - `lib/commcare/hq/lookupTables.ts::HqLookupTable`, which already carries `isGlobal`, gains `fieldProperties: Readonly<Record<string, readonly string[]>>` (each field's property names, in HQ's order, keyed by field name) and `itemAttributes: readonly string[]`. `toHqLookupTable` discards both today.
  - New `lib/commcare/hq/lookupTables.ts::HqFixtureRow`:

    ```ts
    export interface HqFixtureRow {
      readonly id: string;
      readonly fields: Readonly<Record<string,
        string | readonly { readonly value: string; readonly properties: Readonly<Record<string, string>> }[]>>;
    }
    ```

  - New `lib/commcare/hq/lookupTables.ts::readHqLookupTableRows(creds, domain, tableId)` reads the filtered collection through `lib/commcare/hq/readCollection.ts::readHqCollection` and returns `{ totalCount, rows }` in order, or a `CommCareApiError`. It accepts both shapes `FixtureResource.dehydrate_fields` answers: `{ <name>: <value> }` for a row whose every field holds one value (`fixtures/models.py::LookupTableRow.fields_without_attributes`), and, for a row in which some field holds more than one, `{ <name>: { field_list: [{ field_value, properties }] } }` for every field of that row, the single-valued ones too. Any other shape is a `CommCareApiError`. A cell Nova's workbook leaves blank is stored as one empty value and reads `""`.
  - **What the rows read does not show.** In the first shape a single value's properties are dropped (a row holding `pine` with the property `family` read `"pine"`), and neither shape carries a row's attribute values or its owners. A table can hold a field property or a row attribute only when its definition names one, and owners take effect only on a table that is not global, so every such table is one defect 5 refuses before any comparison (below).
  - **When the rows read fails.** A row that holds a field with no value makes HQ's row serializer raise, and the whole filtered read fails. HQ's table editor produces exactly that when it adds a column (every existing row gets the new field with no value). The comparison never reaches the rows read in that case, because the added column is a definition change (row 4 below). A row left that way under an unchanged definition, which only a write through HQ's row API can produce, is a failed read: `hq_resource_state_unknown`, naming the table.
- **What the canonical value holds.** `CanonicalLookupTable`: the tag, whether it is global, the fields with their properties, the row attributes, the row count, one digest over the ordered rows, and `definitionDigest` over the first four. No row values are stored.
  - A row is digested as its field names sorted, each with its value, or, for a multi-valued field, with its ordered list of `[value, properties as sorted [name, value] pairs]`. `rowsDigest` is the sha256 of the canonical JSON text of the list of rows so spelled, in HQ's order.
  - Row `id` is left out: Nova's own push keeps a row's id only while HQ keeps the table and the row's content is unchanged (`fixtures/upload/run_upload.py::Mutation.process`). Executed during planning with Nova's captured workbook: a second push of the same workbook kept the table's id and every row's id, and a push HQ answered by making the table again gave every row a new one.
- **Which tables are compared.** Each planned table for which this deployment has a live `lookup-table` mapping whose `pushedIdentity` is the planned tag. `M` is that mapping's `remoteId`.
- **Which baseline is read.** The row for `M`. Because the key is the HQ resource, a sibling app's push that only replaced rows refreshed that same row, so app B never reads app A's push as a change (executed: a replacing push whose definition HQ already holds keeps the table's id, whether or not its rows differ). A live mapping with no baseline row for `M` is `unread`.
- **A table under Nova's tag whose id is not `M` is not a drift change.** It is today's name clash: `lib/deployment/lookupResourcePlan.ts::planLookupResourcePush` compares the id and refuses with `hq_resource_conflict` until the person adopts it, and that is so whether a person re-created the table in HQ or a sibling app's push changed its definition (HQ deletes and re-creates a table whenever an upload's definition matches no table under the tag, `fixtures/upload/run_upload.py::table_key`; executed for a description, an indexed field and a deleted table, each of which left the tag under a new id). The adoption is the person's decision to write over it, so no discard is asked on top of it and no comparison runs for an adopted table in that publish.
- **The comparison, in order, stopping at the first that applies:**

  | # | HQ's state | Function | Part | `baselineKnown` | `observedDigest` | Rows read |
  |---|---|---|---|---|---|---|
  | 1 | no table holds the tag, and no table has id `M` | `lookupIdentityChange` | `deleted` | true | `ABSENT_RESOURCE_DIGEST` | no |
  | 2 | no table holds the tag, and the table with id `M` carries another tag (executed: a rename saved through HQ's table editor view, `fixtures/views.py::update_tables`, kept the table's id and its rows' ids) | `lookupIdentityChange` | `renamed` | true | `lookupDefinitionDigest` of that table | no |
  | 3 | the table under the tag has id `M`, and the baseline is `unread` | none | none | false | `lookupDefinitionDigest` of the table | no |
  | 4 | `isGlobal`, `fields` with their properties, or `itemAttributes` differ from the baseline | `lookupDefinitionChange` | `definition` | true | `lookupDefinitionDigest` of the table | no: after HQ's table editor adds a column the filtered rows read fails (above), and the definition read still answers and shows the new column |
  | 5 | `meta.total_count` differs from `rowCount`, else the rows digest differs | `lookupRowsChange` | `rows` | true | the `digest` of `canonicalLookupTable(table, rows)` | yes |

  Rows 1 and 2 need no baseline content, so they apply to an `unread` baseline too. In rows 2 to 4 the discard is bound to the definition the person was shown and not to the rows, which were not read; the push replaces the rows either way.
- **What a confirmed discard does.** For a changed definition or rows, Nova's replacing upload writes its own. For a deleted table, the upload creates it again. For a renamed table, the upload creates a new table under Nova's tag and the renamed one stays in HQ; the part says so. The API cannot change a tag: a PUT naming another tag answered 400 "Lookup table tag cannot be changed" (`fixtures/resources/v0_1.py::LookupTableResource.obj_update`), and one naming the same tag answered 204.
- **What step 2 does not change.** A mapping stays per deployment, so app B is still asked to adopt a table app A pushed. Step 6 moves adoption to the Project table and the target together.

### Place baselines

- **Reads.** `lib/commcare/hq/locations.ts::listHqLocations` gains `latitude` and `longitude`, which `locations/resources/v0_6.py::LocationResource` returns and Nova does not read today. The organization edge already makes this one inventory read. Everything in this block was executed during planning through that resource in the lane's HQ, with an API key, over places the resource itself created and that HQ's own models then archived, deleted or edited where a person would in HQ.
- **The list is ordered by `last_modified`, so its order moves with every save.** A place Nova updated moved to the end of the next read. Places are paired by `location_id` and never by position, and two reads with nothing between them are equal.
- **What the canonical value holds.** `CanonicalPlace`: name, site code, level code, parent's HQ id, latitude and longitude as HQ returned them, and `location_data` restricted to `ownedKeys`, the place-information slugs the recording push modeled. At a push, `ownedKeys` is the sorted keys of that place's `lib/deployment/locationResourcePlan.ts::PlannedPlace.values`, which `locationResourcePlan.ts::plannedPlacesFor` fills with every property that applies at the place's level; it is empty when the app models no place information. The current read is projected onto the BASELINE's `ownedKeys`. Unmodeled `location_data` keys are not compared, because Nova's push reads and keeps them (`lib/deployment/CLAUDE.md`). `last_modified` is not used: `locations/resources/v0_6.py::LocationResource._update` saves on every call, so an update that sent a place its own values back moved that place's `last_modified` and no other field.
- **Coordinates are compared as HQ's strings.** HQ stores ten decimal places (`locations/models.py::SQLLocation.latitude`) and the list returns each as a string with all ten: a place sent `12.5` and `-1.123456789012345` read back `"12.5000000000"` and `"-1.1234567890"`, and a place with none reads `null`. Read against read needs no rounding model.
- **Which places are compared.** Each planned place with a live `location` mapping, by the mapping's `remoteId`. `placeChange` returns one part per field that differs (`name`, `site-code`, `level`, `parent`, `coordinates`, `information`). The observed digest is the `digest` of `canonicalPlace(current, <the baseline's ownedKeys>)`. For an `unread` baseline, or a live mapping with no baseline row, there are no parts, `baselineKnown` is false, and the observed digest is that of `canonicalPlace(current, <this push's ownedKeys>)`.
- **A place missing from the read** is archived or deleted and counts as changed, with the part `missing` and the observed digest `ABSENT_RESOURCE_DIGEST`, whatever its baseline. No API-key read tells the two apart: an archived place and a deleted one are both absent from the list, absent from a list filtered by their site code, and a 404 on their own URL. A confirmed discard lets the push run, and it plans a create, as `lib/deployment/locationResourcePlan.ts` does today for a mapped place HQ no longer lists:
  - a deleted place is created again under a new HQ id;
  - for an archived one HQ refuses the create and writes nothing, with "Location with same name and parent already exists." when the name and parent are the ones it still holds and "another location already uses this site code" otherwise. That is the push's own refusal with HQ's sentence. The part's sentence says so before the person confirms (the copy table above).
  - Nova never sends an update by id to a place the list does not show: HQ accepts one for an archived place (202), changes it and leaves it archived, so workers would never receive what the ledger would then record as pushed.
- **Levels have no baseline.** Nova never writes one, and HQ accepts no write there: a POST to `locations/resources/v0_5.py::LocationTypeResource` answered 401 and its list read answered the levels.

### Where the check runs

The edges of `lib/deployment/preflight.ts::runDeploymentPreflight` from step 2, in order. Only the parts this section owns are spelled out.

| Edge | What work item B adds | Can refuse with |
|---|---|---|
| `hq-connection`, `app-readiness`, `plan-features` | nothing | as today for the first two; `plan-features` is part 03's (C2. Plan features: the per-privilege confirmation), `hq_confirmation_needed` from pull request 13 |
| `project-data` | after `lib/deployment/lookupResourcePlan.ts::planLookupResourcePush` and (from pull request 14) defect 5's content check: for each planned table this deployment has a live `lookup-table` mapping for under the planned tag, whether or not HQ still holds that tag, `readResourceBaselines` and the comparison above. Differences are collected, not refused here. | `hq_resource_state_unknown`, `hq_resource_conflict`; from pull request 14 also `hq_table_content_unsupported` |
| `organization` | for each planned place with a live `location` mapping, `readResourceBaselines` and the place comparison, collected | `hq_resource_state_unknown`, `hq_organization_mismatch`, `hq_resource_conflict` |
| `project-space-compatibility` | nothing | `project_space_incompatible` |
| `target-app` (the edge and its source read are pull request 3's, part 01, A3. The publish sequence; blocking, only when `resources.ts::plannedInPlaceUpdate` names an app) | Pull request 3 already makes the one `lib/commcare/hq/appSource.ts::readHqAppSource` call here, which also serves the version floor and the overlays, and handles `gone` (a 404, or a `doc_type` ending `-Deleted`) and `unsupported`. Pull request 4 adds: `readAppBaseline`, `normalizeHqAppSource` of the read's `raw`, and `diffHqAppSource`, collected. While the stored app baseline's origin is `create`, `ownedProjection` keeps `modules` only: any menu in the shell is `hq_changed` (part `menu-list`), every other difference proceeds. A failed read after the create records `unread`, which stops as usual. | `remote_app_missing`, `hq_app_state_unknown`; from pull request 13 also `hq_app_version_below_floor` |
| the verdict | `remoteChanges.ts::decideRemoteChanges` over everything the three edges collected. An `unread` baseline is a change with `baselineKnown: false`. | `hq_changed` |
| attention edges | nothing | never refuse |

Rules that hold across the edges:

- A baseline or HQ read that fails is a blocking `hq_resource_state_unknown` or `hq_app_state_unknown`. It is never "no change".
- `readHqAppSource`'s bound (64 MiB, 67,108,864 bytes) and shape check are part 01's (A3, `readHqAppSource`), landed in pull request 3; any failure of either is `hq_app_state_unknown`. Pull request 4 only reads its `raw`.
- A live `app`, `lookup-table` or `location` mapping with no baseline row for the resource it names (possible only if the cutover skipped it) is treated as `unread`.
- A refusal folds as preflight refusals do today: nothing for a first publish, `foldDeploymentAttempt` otherwise. Nothing was sent to HQ but reads.

**The second read.** After the resource pushes and before the import, `lib/deployment/service.ts::publishAppToHq` reads the source again only when a table or place was pushed in between, normalizes it, and runs `diffHqAppSource({ baseline: <the normalized earlier read>, current: <the normalized second read>, ownership, shell })`. The earlier read is the one this publish already holds: the `target-app` read for an app that was there, and the read after the shell create for an app this publish created, because a first publish creates and reads its shell before the resource pushes (part 01, A3. The publish sequence, steps 5 to 10). `shell` is whether the stored baseline's origin is `create`, as at `target-app`; it is always true for an app this publish created, so that comparison reads `modules` only. A non-empty result stops at `upload` with `hq_changed`; a difference only in ignored keys proceeds, and the import's overlays are then computed on the second read. `ownership` is the stored baseline's, or, when that baseline is `unread`, the ownership `hqImportApplication` returns for this publish's body built over the second read. The digests of the two reads are not compared: a settings-page save or anything else that stamps `last_modified` would then stop a publish after its tables and places were already pushed, over a change the comparison ignores and no person could have decided (decision 2). With no resource push, the earlier read is the read immediately before the import.

**After the write.** Once the import answers, Nova reads the source back before the media upload, normalizes it, and `recordRemoteResource` writes the mapping, the `push` baseline with this body's ownership, the discard if one was used, and the `uploaded` fold in one transaction. A failed read-back writes an `unread` baseline and adds a warning; the app landed. The media upload that follows moves nothing the comparison reads: executed during planning on `case-list-inline`, a read before it and a read after it differ at `multimedia_map`, `media_form_errors` and `last_modified` only. Tables and places do the same through `recordPushedResources`: `lib/deployment/service.ts::pushLookupTables` reads each pushed table's rows after its existing re-list, and `pushLocations` makes one inventory read after its last batch. A push that stops partway records baselines for what the re-list finds and `markResourceBaselinesUnread` for the rest.

Requests a publish adds: a first publish makes the shell create, a source read, the update and a source read; a republish with nothing to push makes a source read, the update and a source read; either one that pushes tables or places makes one more source read, one rows read per pushed table before and after, and one place inventory read after.

### The refusal, the discard and the copy

```ts
// lib/deployment/service.ts (server-only)
export interface PublishInput {
  // existing fields, plus (confirm is work item C's and lands in pull request 13):
  readonly confirm?: readonly DeploymentConfirmationKey[];
  /**
   * HQ-side changes the person chose to write over, each bound to the state
   * they were shown. A digest for a state HQ has since left is refused with
   * the new state's digest.
   */
  readonly discardRemoteChanges?: readonly RemoteChangeDiscard[];
}

// lib/deployment/types.ts (RemoteChangeDiscard is defined there too, above)
export interface DeploymentRemoteChange {
  readonly kind: "app" | "lookup-table" | "location";
  readonly novaResourceId: string;
  readonly name: string;               // the author's name for it
  readonly identity: string;           // HQ app id, tag, or site code
  readonly parts: readonly string[];   // what changed, in Nova's voice, bounded; empty when baselineKnown is false
  readonly observedDigest: string;     // the digest to send back
  readonly baselineKnown: boolean;     // false for an 'unread' baseline
}

// lib/deployment/types.ts (exists today; the last two fields are new)
export interface DeploymentAttemptRefusal {
  readonly phase: DrivenDeploymentPhase;
  readonly failure: DeploymentFailure;
  readonly resourceConflicts: readonly DeploymentResourceConflict[];
  /** Non-empty exactly for `hq_confirmation_needed`. Work item C adds it in pull request 13. */
  readonly confirmationsNeeded: readonly DeploymentConfirmationNeeded[];
  /** Non-empty exactly for `hq_changed`. */
  readonly remoteChanges: readonly DeploymentRemoteChange[];
}
```

The observed digest, per kind:

- **App:** the `digest` of the whole normalized current read, the same value whether or not a baseline exists. It covers keys the comparison ignores, so a save in CommCare HQ of a key Nova ignores between the refusal and the resend refuses again, with the new digest and the same parts. Reason for keeping the whole-read digest: one definition serves a known and an `unread` baseline (an `unread` one has no ownership to project with), the person confirmed against exactly the state Nova read, and a second refusal in preflight costs one more confirmation and has written nothing. This is the opposite choice from the second read, where a stop would follow a resource push.
- **Table:** per the comparison table under "Lookup table baselines".
- **Place:** per "Place baselines".

Per resource, on every publish:

| HQ's current state | Outcome |
|---|---|
| equal to the baseline under the comparison | proceed |
| differs, and `discardRemoteChanges` names this resource with the current digest | proceed; the push writes over HQ; the new baseline (read after the push) is written with `discarded_digest`, `discarded_by`, `discarded_at` |
| differs otherwise, including a discard that names an older digest | refuse `hq_changed` at `preflight`, listing every changed resource with its current digest |
| baseline `unread` | as "differs", with `baselineKnown: false` |
| app baseline of origin `create` (a shell with no content yet) | the app comparison reads only `modules`: a menu added in HQ is "differs" (`hq_changed`, part `menu-list`); any other change, such as a raised CommCare version, is "equal" and proceeds. A failed read after the create recorded `unread`, the row above. |

A retry after a failed push needs the same digest again, which is still valid while HQ has not moved. A later HQ change stops again, because the new baseline is HQ's state after Nova's push.

Copy, in Nova's voice (`lib/deployment/service.ts` builds the failure; the dialog renders the list; the sentence for each part is in the table under "What is compared and what is ignored"):

| Where | Text |
|---|---|
| `hq_changed` message | "Something this app publishes isn't the same in CommCare HQ as when Nova last published it, so Nova stopped before sending anything. A save in CommCare HQ can show up here even when it changed no value. You can publish over what's listed below, which replaces it with this app's version." |
| A change with `baselineKnown: false` | "Nova couldn't confirm what its last publish left here, so it can't tell whether anything changed." |
| The discard control in the dialog | Checkbox per change: "Publish over this". Button: "Publish over these changes" |
| Warning after a failed read-back | "Nova published the app but couldn't read it back, so the next publish will ask before it writes over what's there." |
| `hq_changed` at `upload` | "CommCare HQ's copy of this app changed while Nova was publishing its lookup tables and places, so Nova stopped before sending the app. Publishing again checks what is there now and lists anything that changed." |

### The 7-day App Preview statement

HQ keeps each form's last validation verdict for 7 days under a key built from the app id and the form's id (`models/forms.py::CachedStringProperty.set`, `models/forms.py::FormBase.validate_form`), and clears it only when a form is saved through its own editor path (`models/forms.py::FormSource.__set__`) or an app is reverted (`models/applications.py::Application.make_reversion_to_copy`). An import clears nothing. From step 2 a form keeps its id across publishes, so a form that failed its check in HQ before Nova wrote over it keeps reading as failing there.

Executed during planning in the lane's HQ, on `navigation-base`, one state after another:

| State of the app in HQ | The form's own check | The download of the unbuilt app (`views/cli.py::direct_ccz` with `latest=save`, the reference Formplayer installs an app by its id from, `util/SessionUtils.java::getReferenceToLatest`) | A new version (`models/applications.py::ApplicationBase.make_build`) |
|---|---|---|---|
| Nova's publish | passes | 200, the archive | built |
| one form's source replaced with a broken one through the path the form builder's save writes it (`models/forms.py::FormSource.__set__`), then checked | fails | 400, "Cannot make new version" | refused |
| Nova's publish over it: the form is Nova's again | still fails, with the old error | still 400 | built |
| that form opened and saved once in HQ's form builder (Vellum, through the editor driver), nothing changed | passes: the cached verdict is gone | 200, the archive | built |

A new version builds because `make_build` validates a copy under a new id, which has no cached verdict ("built" here is `make_build` run through its validation and its build files to the pruning task it queues last). The same holds in reverse: over a verdict cached as passing, an imported broken form still read as passing on the unbuilt app while a new version was refused. So what the stale verdict reaches is the unbuilt app, never a build a worker installs.

Executed end to end through Formplayer as well, with HQ's own download view answering Formplayer's install request for the unbuilt app: in the third state Formplayer answered the client an error whose text is HQ's "Cannot make new version" with the old form's validation error, and showed no menu; in the fourth it installed the archive and showed the app's first menu. That is what a person sees in App Preview.

- **This is a limit, and it is HQ's.** No request an API key can make clears the cached verdict: at the pin `clear_validation_cache` is called from the form's editor save, from an app revert and from the check itself when the cached text does not parse, and from nowhere else. Tried during planning: the import (leaves it), and a save in the form builder (clears it, and is a signed-in page's request, which the next publish then lists as a change to that form, decision 7). Giving the form a new id would also escape it, and would break every HQ-side reference part 01 keeps stable (part 01, A1. Derived ids, and why `Form.xmlns` is not stored), so Nova does not.
- **The statement** appears on the landed outcome of every publish that wrote over an app without knowing it unchanged: a publish that followed a confirmed discard of the app, and a publish whose stored app baseline, before it, had origin `cutover` (edits made in HQ before the cutover are written over without a stop). It is a line on the landed outcome in the dialog and `app_preview_note` in `upload_app_to_hq`'s success payload: "CommCare HQ keeps each form's last check for up to 7 days. If a form had failed that check in CommCare HQ before this publish replaced it, App Preview there can keep refusing to open the app for that long, with the old error. Making a new version in CommCare HQ checks the app afresh. Saving the form once in CommCare HQ's form builder clears the old check, and Nova's next publish then asks before replacing that form."
- `content/docs/publishing.mdx` carries the same sentences in its section on publishing over HQ's changes.
- It is not shown on other publishes. Reason: without an HQ-side edit to a form there is no earlier rejected version for the cache to hold.
- The statement is tied to the app, not to a table or place, because only a write over the app can replace a form HQ may have checked. A publish that discards only table or place changes carries no statement.
- **Lane.** New case in `proof/hq/test_publish.py`, `test_a_cached_form_verdict_outlives_an_import_and_a_new_version_checks_afresh`: the four states above, through HQ's import, `direct_ccz` and `make_build`. New case in the Formplayer package, `proof/formplayer/test_preview_install.py`: Formplayer's install of the unbuilt app in the third and fourth states, with the archive request answered by HQ's `direct_ccz` over the unit's state in place of the harness's stored archive, showing the error and then the menu. New case in `proof/editors/test_vellum.py`: a form builder save of the form in the third state clears the cached verdict and the download answers 200.

### What the check cannot close

State each in `lib/deployment/CLAUDE.md` and the first two in `content/docs/publishing.mdx`.

- **No compare-and-swap.** HQ's import takes no expected version (`views/app_import_api.py::_handle_import_app`), so the update cannot be made conditional. Executed during planning: an update sent after a save in HQ, carrying `expected_version`, `version` and `if_match` fields that name the earlier version, answered 200 and wrote over the save. An HQ save between Nova's last source read and its import is overwritten unseen. An HQ save between the import and the read-back becomes part of the baseline and is overwritten unseen by the next publish. Each window is one round trip wide.
- **A crash between the import and `recordRemoteResource`** leaves HQ updated and the baseline old. The next publish stops with `hq_changed` over Nova's own push. This is the same class as today's "import landed, mapping not recorded", and for an update it is no longer silent. The stop's copy does not claim a person made the change.
- **A table's description and indexed-field flags** are invisible to the check (see "Defect 5: the lookup push" below).
- **A change to a shell other than a menu** is not seen (decision 10). The first content publish writes over it, and nothing of Nova's or of a person's app content was there.
- **Edits made in HQ before the cutover** are inside the `cutover` baseline, so the first publish after it writes over them without a stop. The cutover's notice names every deployment this applies to.

### Surfaces

- **Route.** `app/api/commcare/upload/route.ts` reads `discard_remote_changes`, an array of `{ kind, novaResourceId, observedDigest }`, with the strictness of `readAdoptResourceIds` (a malformed entry refuses the request). No new `/api` route is added, so `lib/hostnames.ts` gains no entry.
- **Dialog.** `components/builder/PublishDialog.tsx` gains `RemoteChangeChoice` beside `ResourceConflictChoice`: one row per change with its name, its identity, its parts and a checkbox, built from `@/components/shadcn`. The ticks live in the dialog's state for the resend. `components/builder/publishOutcome.ts::publishOutcome` carries `remoteChanges` on its `refused` arm.
- **MCP.** `upload_app_to_hq` (`nova.hq.write` through `lib/mcp/scopes.ts::oauthScopeChallenge`, unchanged) gains the input `discard_hq_changes: { kind: "app" | "lookup-table" | "location", nova_resource_id: string, observed_digest: string }[]`, described as "Send only after an `hq_changed` refusal listed them, the user saw the list, and said to write over each." The refusal is the error envelope `error_type: "hq_changed"` with `remote_changes: [{ kind, nova_resource_id, name, hq_name, parts, observed_digest, baseline_known }]` (`hq_name` is `DeploymentRemoteChange.identity`), structured like `lib/mcp/tools/uploadAppToHq.ts::makeConflictError`'s. `lib/mcp/errors.ts::UploadErrorType` and `uploadAppToHq.ts::UPLOAD_ERROR_TAGS` gain `hq_changed`; the `satisfies Record` makes a missed one a compile error. This changes a tool's input schema: the implementer asks the person before running `npm run test:schema`, which bills one live request per schema.
- **`../nova-plugin`.** Its `upload_to_hq` skill tells a model how to publish, so its prose gains the `hq_changed` flow in the plugin's own pull request, merged after the Nova deploy is live.
- **No durable surface.** A change is an attempt's refusal, never stored state, so `get_deployment` and the Publishing section show nothing for it.

### The cutover's baselines

A step of the cutover Job, outside the per-app transform, written by `scripts/lib/hqRoundTripCutover/writer.ts` in the fleet transaction. HQ is read while ingress and writers are stopped, so no publish can land between a read and its baseline.

- **App.** For every deployment with a live app mapping, the source read the identity step already makes is normalized with `normalizeHqAppSource` and stored with `origin: 'cutover'` and the ownership `hqImportApplication` returns for the body Nova would now send for the migrated document over that read (so an HQ-side edit to a key Nova stops writing in step 2 never stops a publish). A deployment no credential can read gets `origin: 'unread'`, and so does one whose source read answers `unsupported` (a linked or a remote app), so that every live app mapping has a baseline or `remote_missing_at`. A deployment whose app HQ reports gone gets no baseline. A deployment with no resource row (its first upload failed before any mapping was written) is read for nothing and gets no baseline of any kind and no notice line. The cutover writes no `create` baseline: it creates no shell.
- **Tables and places.** For every live `lookup-table` and `location` mapping, the definition, rows and place are read and stored with `origin: 'cutover'`; an unreadable one is `unread`. Rows shared by two deployments are upserted under the same `observed_at` rule.
- **Notice.** The reasons are part 10's (Changes that write nothing and still get a line), verbatim. Each deployment with a `cutover` baseline gets `next-publish-overwrites-hq-edits` (its first publish writes over anything edited in HQ before the cutover); each deployment with an `unread` baseline of any kind gets `next-publish-asks-before-overwriting`, naming what could not be read. Part 10 excepts an `unsupported` deployment, which gets `hq-app-not-nova-made` alone, because publish refuses such an app outright and never reaches a discard.

### The retained HQ reads (`proof/hq-reads/`)

The comparator is TypeScript and HQ runs in the lane's Python, and a proof shard mounts no `node_modules`, so no Nova TypeScript runs inside a shard. The proof is in two halves that meet at committed files: HQ writes every answer the comparison reads, and Nova's production functions run over those answers. No test of the comparison reads an HQ answer a person wrote. Each resource and view named here was dispatched this way during planning, in the lane's HQ, and every HQ behavior this part states was read from its answer; the files below are the retained form of those runs.

- **How a read is made.** New `proof/hq/operations.py::api_request(state, method, path, ...)` dispatches through HQ's own URLconf to the resource or view, carrying an API key (an `HQApiKey` made for the unit's web user) on a request attached as every harness request is (`proof/hq/requests.py`). HQ's API-key authentication, its permission check and its privilege check all run. Two things the harness must answer for that, both found by running it:
  - the Couch view `users/by_domain`, which HQ's API rate limiter reads to count a project space's users: `proof/hq/couch.py::VIEWS` gains it, transcribed from the view's `map.js` at the pin as the other views are;
  - the rate limiter's own counters, which HQ keeps in Redis: new seam `proof/hq/seams.py::api_rate_limits` answers each request as within its limits and records each count it was asked to make. The count is HQ's accounting of the request, outside what a read returns.
- **What the lane writes and guards.** Two new tests regenerate every file on every pull request and compare it byte for byte with the committed one, so a pin move that changes any HQ answer fails there. Each read runs as its own named determinism operation (`proof/hq/determinism.py`). Executed during planning: under that seam a source read is byte-identical across two runs of the same operations, and two reads made as two operations of one run differ at every form's `unique_id` and attachment key, as two reads do in production.
  - `proof/hq/test_retained_reads.py` (HQ alone):

    | Under `proof/hq-reads/` | What HQ answered |
    |---|---|
    | `<document>/app-source.json`, `app-source-again.json` | two reads of the unchanged app, for `navigation-base`, `search-registration-link` (a form link), `case-list-inline` (media), `targeted-hq-side-state` and `targeted-hq-side-lookup` (the lookup table, which pull request 1 moves out of `targeted-hq-side-state`) |
    | `<document>/app-source-after-<save>.json` | one read after each HQ-side save the document's `hq-side.json` names |
    | `case-list-inline/app-source-after-media.json` | the read after Nova's media upload |
    | `hq-built/app-source.json`, `app-source-again.json` | `navigation-base` after HQ's own models give it a case-list form, an advanced menu holding two forms, a shadow form of the first and a two-phase visit schedule, and a report menu with two configs, one with a slug: all four reference paths and the report uuids |
    | `shell/app-source.json`, `app-source-with-a-menu.json` | part 01's shell created from `navigation-base`'s body, and the same shell after HQ's own model adds a menu |
    | `<document>/lookup-tables.json`, `fixture-rows-<tag>.json` | the definition list and each table's filtered rows |
    | `lookups/` | a plain global table; a table that is not global with a field property, a row attribute, a row whose every field holds one value and a row holding two values in one field (both row shapes); a table of 1,005 rows (the first page and the page its `meta.next` names); the definition read after HQ's table editor adds a column, with the rows read's failure recorded as the exception HQ raised; the definition read after the editor renames the tag |
    | `places/` | the inventory after the resource's own PATCH creates a parent and a child with and without coordinates; after an update that sends one place its own values; after one place is archived and after one is deleted; HQ's two refusals of a create over an archived place; HQ's refusal of a write to a level |
    | `lookup-upload/` | the upload view's answer with the lookup-table privilege withheld (status, `Content-Type` and the page's title), and its JSON answers to Nova's workbook, to a file that is no workbook and to a request with no file |

    The same file asserts that `corehq.apps.app_manager.models.form_id_references` holds exactly the four paths the normalization names, so a fifth path at a new pin fails there, and it holds the schema-growth rule's premise: a stored document stripped of every declared key at its manifest default reads back equal except at the keys the test names (`Detail.display` at this pin).
  - `proof/editors/test_retained_reads.py` (HQ's pages, through the editor driver): `navigation-base/app-source-after-<page>-save.json` for each save of decision 7's table, made with nothing changed through `proof/editors/conftest.py::save_section` and `proof/editors/vellum.py::open_and_save`, each in a fork of Nova's publish; and `shell/app-source-after-settings-save.json`.
- **Vitest consumes them.** `lib/deployment/__tests__/hqSourceBaseline.test.ts`, `hqResourceBaseline.test.ts`, `lib/commcare/__tests__/hqLookupTables.test.ts` and `hqLocations.test.ts` run the production functions over those files. A case whose input must be a state HQ cannot be put in by the lane (a key HQ's model gains at a later pin) is built by editing a retained read, and the test says which key it edited.

### Work item B, the standard block

**Today.** Nova compares nothing and stores no copy of anything it pushed. It reads the app source before an update and uses only its profile (at this pull request's base, pull request 3's `readHqAppSource` at the `target-app` edge already returns the whole body as `raw`, and nothing compares it); `lib/deployment/service.ts::pushLookupTables` uploads with `replace: true` over whatever the tag holds; `pushLocations` writes over each place.

**Fix.** The decisions and design above: HQ-read baselines for the app, each table and each place; the comparison in preflight; `hq_changed` with `remoteChanges`; `discardRemoteChanges` bound to the observed digest; the read-back after each write.

**Files.**

- Domain: none.
- Doc and mutations: none.
- Validator: none.
- Emitters: `lib/commcare/appOwnership.ts` (new; pull request 5 deletes it, see "The ownership descriptor"), `lib/commcare/surface/schemaDefaults.ts` (new), `lib/commcare/hq/lookupTables.ts`, `lib/commcare/hq/locations.ts`. `lib/commcare/hq/appSource.ts` (`readHqAppSource`) and `lib/commcare/hq/readJson.ts` (the size bound) landed in pull request 3 (part 01, A3. The publish sequence) and do not change here.
- Deployment: `lib/deployment/hqSourceBaseline.ts`, `hqResourceBaseline.ts`, `remoteChanges.ts` (new); `types.ts`, `store.ts`, `preflight.ts`, `service.ts`, `importApplication.ts`, `lookupResourcePlan.ts`, `locationResourcePlan.ts`, `index.ts`.
- Database: none in pull request 4. The migration and its `index.ts` line, `lib/db/pg.ts`, `lib/db/privilegeConvergence.ts` and the Project-move copy in `lib/db/apps.ts` with its test all landed in pull request 2.
- Preview: none.
- Builder: `components/builder/PublishDialog.tsx`, `components/builder/publishOutcome.ts`, `app/api/commcare/upload/route.ts`; `e2e/tests/browser/publishing.spec.ts`, `e2e/lib/publishing-client.tsx`, `e2e/lib/publishing-boundary.ts`.
- SA and MCP tools: `lib/mcp/tools/uploadAppToHq.ts`, `lib/mcp/errors.ts`; `../nova-plugin`'s `upload_to_hq` skill in its own pull request.
- Proof: `proof/hq/test_retained_reads.py`, `proof/editors/test_retained_reads.py`, `proof/hq/operations.py` (`api_request` and the reads built on it), `proof/hq/couch.py` (`users/by_domain`), `proof/hq/seams.py` (`api_rate_limits`), `proof/hq/test_publish.py` (the cached-verdict case), `proof/formplayer/test_preview_install.py`, `proof/editors/test_vellum.py` (the form builder save over a cached verdict), `proof/hq-reads/`, `proof/corpus/publish.ts`, `proof/corpus/targetPeer.ts`, `proof/observe/publish.py`, `proof/README.md`.
- Docs: `content/docs/publishing.mdx`, `content/docs/mcp/tools.mdx`, `docs/architecture/contracts.md`.
- CLAUDE.md: `lib/deployment/CLAUDE.md` ("Preflight is a graph with two kinds of edge", "Ownership, and why superseded rows are kept", "One publish lifecycle", and a new section on baselines with the windows above), `lib/db/CLAUDE.md` (the new tables and the deletion-lifecycle sentence), `components/builder/CLAUDE.md`.

**Stored shape and migration.** The two ledger tables this work item uses (`app_deployment_baselines`, `project_space_resource_baselines`) are in the one additive migration. No document shape changes, so the cutover's transform has no step for it. The cutover Job's baseline step writes the rows above. Notice reasons: `next-publish-overwrites-hq-edits` and `next-publish-asks-before-overwriting`, each naming the deployment (server and project space) and, for the second, what could not be read.

**Register.** None. No register entry belongs to work item B: the lane holds no difference for "Nova wrote over an HQ edit without asking" as a class of its own (the entries on `targeted-hq-side-state` are defect 1's, 4's and 5's, each fixed elsewhere).

**Spelling rule.** None.

**Identity.** None moves in HQ. `proof/identity-moves.json` gains no entry: proof 1 compares two exports of one document by one revision, and a baseline is Nova's own state, in no export.

**Control.** None: no register entry moves. The exit clause "a second publish stops when HQ's copy changed since the first" is held in three places, each of which runs HQ:

- the retained reads, HQ's own answers before and after each save, which the production comparison must call equal or tell apart exactly as decision 7's table and each document's `hq-side.json` say;
- the lane's capture, whose republish of every `hqSide` document is refused over an assumed state that `proof/observe/publish.py` proves equal to what HQ holds before it applies anything (`CapturedSourceNotHeld`, `CapturedResourcesNotHeld`);
- the lane's B, which lands in HQ only through the recorded discard and is then built and run as every B is.

**Nova tests.** These run Nova's own code. Where a row's input is an HQ answer, it is one HQ gave (the retained reads); a row over "a peer" proves what Nova sends, in what order, and what it stores, never what HQ does.

| Contract | Boundary |
|---|---|
| Two retained reads of one app normalize to the same text and digest, for each of the five documents and for the HQ-built pair that holds all four reference paths and two report configs; the retained read after each save of decision 7's table gives that table's outcome and part (equal under `diffHqAppSource` after App Settings and Case Management while the digest differs; `settings`, `menu` or `form` after the others); the read after each `hq-side.json` save names the right part; the read after the media upload is equal; no attachment outside the current forms and no `admin_password` is in the normalized text; with `shell: true` the retained shell is equal to itself after an App Settings save, and against the shell with a menu yields the one part `menu-list` | pure, over `proof/hq-reads/`: `lib/deployment/__tests__/hqSourceBaseline.test.ts` |
| The schema-growth rule, over a retained read edited to add one key the test names: at its manifest default it is no change, at another value it is one, and an added map key is one. With `shell: true`, a retained shell edited to raise `build_spec.version`, change the name and change the profile is equal | pure, over edited retained reads: the same file |
| Table comparison order (identity, then definition, then count, then rows digest) with the part and observed digest each case yields, over HQ's retained answers: the plain table against itself, against the read after the editor added a column (`definition`, rows never read), against the read after the rename (`renamed`) and against a list without it (`deleted`); both retained row shapes digest, the multi-valued one by its ordered values and sorted properties, and row ids never enter the digest; the two pages of the 1,005-row table digest as one list; place projection onto the baseline's `ownedKeys`; coordinates as HQ's strings; the inventory after a no-change update is equal though its order and `last_modified` moved; an archived place and a deleted one are each `missing` | pure, over `proof/hq-reads/lookups/` and `proof/hq-reads/places/`: `lib/deployment/__tests__/hqResourceBaseline.test.ts` |
| `decideRemoteChanges`: equal, differs, confirmed for this digest, confirmed for an older digest, `unread`, one of several unconfirmed; each `describe` function returns the copy table's sentence for every part kind; `boundedParts` at 20 and 21 lines | pure: `lib/deployment/__tests__/remoteChanges.test.ts` |
| `appOwnershipOf` names exactly the overlay keys of the body it is given | pure: `lib/commcare/__tests__/appOwnership.test.ts` (pull request 5 moves its cases to `targetOverlay.test.ts`) |
| `schemaPropertyDefault` answers `known`, `default` and `isMap` from the manifest for a declared property, a map property and a key the manifest does not list | pure: `lib/commcare/surface/__tests__/schemaDefaults.test.ts` |
| What a publish sends and stores: a changed source stops before any write request and lists every change; a discard with the shown digest lands and records `discarded_*`; a discard with an older digest is refused with the new one; a source whose compared keys moved during the resource push stops at `upload`, and so does a shell this publish created that is given a menu during the push; an ignored-key save during the resource push does not stop; an ignored-key save between the refusal and the resend refuses again with the new digest and the same parts; a table gone from the list stops with the `deleted` part and is sent again after its discard; a table under Nova's tag with another id is `hq_resource_conflict` and never a discard offer; a failed read-back lands the app with an `unread` baseline and the next publish stops with `baselineKnown: false`; a shell left by an earlier try whose CommCare version was then raised is filled with no stop, and the same shell given a menu stops with `hq_changed` and the part `menu-list`; a shell whose read after the create failed stops with `baselineKnown: false`; a publish over a `cutover` baseline and one after an app discard carry the App Preview line, and no other does; three publishes in a row of an unchanged app make no stop | real Postgres with a peer that serves HQ's retained reads, whole or with the one edit a case names, and records every request (the peer of `__tests__/helpers/httpPeer.ts`, documents from `lib/deployment/__tests__/publishFixtures.ts`): `proof/corpus/__tests__/publish.postgres.test.ts` |
| `readHqLookupTableRows` follows `meta.next` across the two retained pages, stops at the count, parses both retained row shapes, and returns an error for a failed page and for any other row shape; `listHqLookupTables` returns `fieldProperties` and `itemAttributes` from the retained definition list | a peer serving `proof/hq-reads/lookups/`: `lib/commcare/__tests__/hqLookupTables.test.ts` |
| `listHqLocations` returns `latitude` and `longitude` as HQ's strings, and null where HQ holds none | a peer serving `proof/hq-reads/places/`: `lib/commcare/__tests__/hqLocations.test.ts` |
| The `refused` arm carries `remoteChanges`; the landed arm carries the App Preview line only after an app discard or over a `cutover` baseline | pure state model: `components/builder/__tests__/publishOutcome.test.ts` |
| `discard_hq_changes` in, the `hq_changed` envelope out, `app_preview_note` on the success payload | real Postgres with a peer: `lib/mcp/__tests__/uploadAppToHq.postgres.test.ts` |
| The dialog lists the changes with their parts, resends with the ticked digests, and shows the landed outcome with the App Preview line | Playwright, browser component test against its controlled boundary (`e2e/lib/publishing-boundary.ts`): a new case in `e2e/tests/browser/publishing.spec.ts` |

**Lane.** `proof/corpus/publish.ts::publishStep` calls the production preflight and comparison (it restates nothing). `proof/corpus/targetPeer.ts` answers the reads a publish now makes (the full source, the table list, the filtered rows, the place inventory) from an assumed remote state it builds from the document's `hq-side.json`. For a document with `hqSide`, the capture's republish is refused with `hq_changed`, the capture records that refusal in the document's sidecar and resends with the listed digests, as a person confirming would, so B still lands. `proof/observe/publish.py` verifies each assumed state against HQ's real state before it applies a captured body, raising `CapturedResourcesNotHeld` (new in this pull request, `proof/hq/operations.py`) for tables and places, beside pull request 3's `CapturedSourceNotHeld` for the app source, when one does not hold. Controls replay in their legacy capture layout. The pull request runs locally `npm run proof -- proof/hq/test_retained_reads.py proof/editors/test_retained_reads.py proof/hq/test_publish.py proof/formplayer/test_preview_install.py proof/editors/test_vellum.py` and the checks over `navigation-base`, `case-list-inline` and `targeted-hq-side-state`. CI's full lane must show the register unchanged by this pull request (613 entries less whatever earlier pull requests of the stack moved), every `hqSide` document's B landing through a recorded discard, and the retained reads byte-equal.

## Defect 5: the lookup push

**Today.** `lib/deployment/service.ts::pushLookupTables` uploads one workbook with `replace: true`, and `lib/commcare/lookup/workbook.ts::typesSheetRows` writes every table as global with no field property, row attribute or indexed flag, so the push over an adopted or HQ-edited table deletes it and creates it again without that content. `lib/lookup/constants.ts::isReservedInstanceTag` compares whole names only, so a tag that contains `casedb` or `ledgerdb` is admitted. `lib/commcare/hq/lookupTables.ts::uploadLookupTableWorkbook` reports an OK answer that is not JSON as `mayHaveLanded: true`. `lib/commcare/lookup/workbook.ts::MAX_HQ_FIXTURE_SHEET_NAME_LENGTH` and `lib/export/boundaryValidation.ts::hasUnpushableTag` refuse a 32-character tag.

**Fix.**

1. **Refuse from what an API-key read shows.** `lib/deployment/lookupResourcePlan.ts::RemoteLookupTable` gains `isGlobal`, `fieldProperties` and `itemAttributes`, and `planLookupResourcePush` returns a third outcome, `{ ok: false, unsupported: [...] }`, for every planned table whose tag exists in HQ (Nova's own, adopted, or being adopted) and whose HQ copy has a field property, a row attribute, or is not global. The definition read shows all three (executed: a table that is not global, with a field property and a row attribute, read back with `is_global: false`, the property under its field and the attribute in `item_attributes`). Preflight's `project-data` edge turns it into `hq_table_content_unsupported`, naming each table and what it holds. It is checked before the drift comparison, so such a table never shows a discard offer, and neither `adoptResourceIds` nor `discardRemoteChanges` resolves it. The one exit until step 7: give Nova's table a new export tag, so the push creates its own table and leaves HQ's. Copy: "The table `<name>` holds `<field properties | row attributes | rows limited to certain users>` in CommCare HQ, which Nova can't keep yet. Publishing would remove them, so Nova stopped before sending anything. Giving the table a new export tag in Project data makes Nova publish its own table and leave this one as it is."
   - "Not global" covers every table whose row owners take effect. Executed during planning through `fixtures/fixturegenerators.py::ItemListsProvider.__call__` for two workers over one table with one row owned by the first: while the table was global both workers received every row; once it was not, the owner received the owned row and the other worker none.
   - Owners on a global table are therefore inert. No API-key read returns them (the rows read of an owned row shows its fields and nothing else), and a push drops them even where it keeps the table and its rows: executed, Nova's captured workbook pushed over a global table whose row had an owner kept the table's id and every row's id and left no owner. `content/docs/project-data.mdx` says so.
2. **No definition probe.** A `replace=false` upload of a table's definition with no rows was considered as a way to make HQ compare the parts Nova cannot read. Executed during planning on HQ's upload (`fixtures/upload/run_upload.py::_run_upload`): on a table with rows it refuses a mismatch and leaves the table untouched, but on a table with no rows it deletes and re-creates the table (a described, rowless table lost its description and got a new id), and for a tag HQ does not hold it creates an empty table, each answered as success. A probe is therefore itself a write that can destroy what it is meant to protect, guarded only by a row count read moments earlier. Nova sends none.
3. **A description and indexed-field flags are stated, never detected.** No API-key read returns a field's indexed flag or a table's description (executed: the definition read returns each field's name and properties and nothing more, and the read of a described table carries no description), and no workbook can carry a description at all (`fixtures/upload/workbook.py::_FixtureWorkbook.iter_tables` builds the table without one; executed: HQ's own download of a described table, uploaded back unchanged, made the table again under a new id with no description, with and without "replace"). Both are part of HQ's table key (`fixtures/upload/run_upload.py::table_key`: whether it is global, the tag, the fields with their properties and indexed flags, the row attributes, the description), so a push over a table that has either re-creates it. Executed with Nova's captured workbook: over an identical table the push kept the table's id and every row's id; over the same table given a description, and over it given an indexed field, the push left the tag under a new id with the description or the flag gone. From step 2:
   - the adoption confirmation (`PublishDialog.tsx::ResourceConflictChoice` and the `hq_resource_conflict` envelope) says: "Taking over this table replaces its rows with this app's each time you publish. If it has a description or indexed fields in CommCare HQ, publishing removes them: CommCare HQ doesn't show those to Nova, and a lookup upload can't carry a description."
   - the discard confirmation for a `lookup-table` change carries the same second sentence as its last part: from pull request 14 `remoteChanges.ts::describeLookupChange`'s caller appends `remoteChanges.ts::LOOKUP_DISCARD_NOTE` ("If it has a description or indexed fields in CommCare HQ, publishing removes them: CommCare HQ doesn't show those to Nova, and a lookup upload can't carry a description.") to every `lookup-table` change except a `renamed` one, whose table the push leaves alone.
   - for a table Nova already pushes, with no visible change, there is no stop. After the push, when the re-list shows the table under a new HQ id although the definition Nova pushed equals the baseline's, HQ made the table again. Every part of HQ's table key that Nova can read was equal, so what differed was a description or an indexed flag, or the table was deleted in HQ in the one round trip between preflight's read and the push. The landed outcome carries a warning that is true in each case: "CommCare HQ made the table `<name>` again during this publish. If it had a description or indexed fields there, they are gone: Nova can't read or keep either yet."
   - `content/docs/project-data.mdx` states all of it. Step 7 carries the indexed flag. `docs/research/2026-09-26-hq-round-trip/harness-findings.md` records the description loss under "What HQ does itself".
4. **"Upgrade Required" is reported as nothing landed.** Executed during planning by dispatching HQ's upload view (`fixtures/views.py::upload_fixture_api`, with its decorators) with an API key and Nova's captured workbook:

   | The project space and the request | HTTP status | `Content-Type` | Body | Tables afterwards |
   |---|---|---|---|---|
   | plan without lookup tables | 200 | `text/html; charset=utf-8` | HQ's "Upgrade Required" page | none |
   | plan with lookup tables | 200 | `application/json` | `{ "code": 200, "message": ... }` | the table |
   | plan with lookup tables, a file that is no workbook | 200 | `application/json` | `{ "code": 405, "message": ... }` | not read |
   | plan with lookup tables, no file | 200 | `application/json` | `{ "code": 405, "message": ... }` | not read |

   The view answers JSON on every path and carries its verdict in the body's `code`, at HTTP 200. The plan check in front of it (`fixtures/dispatcher.py::require_can_edit_fixtures` through `corehq/apps/accounting/decorators.py::requires_privilege_with_fallback`) answers the plan page before the view runs. So an OK answer that is not JSON was produced before anything was written.
   - In `uploadLookupTableWorkbook`, an OK response whose `Content-Type` is not JSON returns `{ success: false, status: 426, message: "", mayHaveLanded: false, upgradeRequired: true }` without attempting `res.json()`; `FixtureUploadRefusal` gains `upgradeRequired: boolean`, false on every other arm.
   - The reported `status` is 426, a value this adapter chooses for the arm. It is not 402, because `lib/deployment/service.ts::lookupUploadFailure` reads the body code 402 as HQ's "took only part" verdict.
   - There is no arm for an HTML answer with another status: HQ sends the plan page as 200 and nothing else as HTML from this URL.
   - A body that claims JSON and does not parse keeps `mayHaveLanded: true`.
   - `lookupUploadFailure` tests `refusal.upgradeRequired` first, before its permission and partial arms.
   - `lookupUploadFailure` gains the sentence: "The plan for `<domain>` doesn't include lookup tables, so CommCare HQ took none of this app's and the app was not sent. Nothing on the project space changed."
   - No read warns of this first: the definition list read answers 200 on a plan without lookup tables (executed). The plan-feature confirmation is part 03's (C2. Plan features: the per-privilege confirmation).
5. **The 31-character cap goes.** HQ's reader finds a data sheet by its title, read as a plain attribute with no length check (`corehq/util/workbook_json/excel.py::WorkbookJSONReader.get_worksheet`), and a tag holds 32 characters (`fixtures/models.py::LookupTable.tag`). HQ does not refuse a longer one: it answers a 33-character tag with a 500 (correction 15, below), so the cap of 32 is Nova's to hold, and Nova already holds it. Delete `MAX_HQ_FIXTURE_SHEET_NAME_LENGTH` and its throw in `lib/commcare/lookup/workbook.ts::buildLookupWorkbook`, `lib/export/boundaryValidation.ts::lookupHqSheetNameFindings`, the length half of `hasUnpushableTag` (the `types` half stays), and the code `LOOKUP_TAG_TOO_LONG_FOR_HQ` from `lib/commcare/validator/errors.ts`, `lib/commcare/validator/gate.ts` and `lib/doc/userFacingErrors.ts`. `lib/commcare/lookup/textWorkbook.ts` writes the sheet name as given and does not change. Executed during planning, with workbooks that writer made:
   - HQ's upload view took a workbook whose data sheet is named by a 32-character tag (`code` 200), made the table under that tag with both rows, and on a second upload of the same workbook found the same table and kept its id and its rows' ids; a 31-character tag was taken the same way.
   - HQ's definition read returned the 32-character tag, and HQ's restore wrote the table as `item-list:<tag>` with a `<tag>_list` of both rows.
   - Core, Formplayer and Android each listed both rows of a table under a 32-character tag in a select (the planned spelling written by hand into `targeted-lookup-reserved-tags`: Core and Formplayer over HQ's build and HQ's restore, Android over the local archive).
6. **Tags that contain `casedb` or `ledgerdb` are refused, case-sensitively.** `isReservedInstanceTag` gains: the tag contains `casedb` or `ledgerdb`, compared as written. Reason: commcare-core `org/commcare/core/process/CommCareInstanceInitializer.java::generateRoot` tests the instance reference with `String.contains` on `ledgerdb`, then `casedb`, then `fixture`, so a lookup instance whose reference contains either of the first two is given the ledger or case database instead of its table. A lookup reference always contains `fixture`, so those two words are the whole rule. Executed during planning on every runtime, over `targeted-lookup-reserved-tags` (two selects, each over a two-row table):

   | Tags | Core (HQ's build, HQ's restore) | Formplayer (HQ's build, HQ's restore) | Android (the local archive and its restore) |
   |---|---|---|---|
   | as emitted today: `clinic_casedb_codes`, `stock_ledgerdb_codes` | the register's two entries: neither select reads its table | the form does not open: "Make sure the 'clinic_casedb_codes' lookup table is available, and that its contents are accessible to the current user." | the form opens and its first question raises "Error Occurred" with the same sentence and no choices |
   | split: `clinic_case_db_codes`, `stock_ledger_db_codes` | both selects list both rows | both selects list both rows | both selects list both rows |
   | another case: `clinic_CaseDB_codes`, `stock_LedgerDB_codes` | both selects list both rows | both selects list both rows | both selects list both rows |

   The test is case-sensitive on every runtime, and every rename leaves a table behind in HQ, so the rule refuses only tags that break. The existing whole-name comparison stays case-insensitive for its own reason. `lib/lookup/schema.ts::wireIdentifierSchema`'s message and `LOOKUP_TAG_RESERVED_BY_RUNTIME`'s message say "contains `casedb`" or "contains `ledgerdb`" where that is the cause. The SA and MCP lookup tools reach the same schema through `lib/lookup/authoringBatch.ts`, so their refusal changes with it; no tool description names a tag rule and no tool schema changes.

**Files.**

- Domain: `lib/lookup/constants.ts`, `lib/lookup/schema.ts`.
- Doc and mutations: `lib/doc/userFacingErrors.ts`.
- Validator: `lib/commcare/validator/lookupReferences.ts`, `lib/commcare/validator/errors.ts`, `lib/commcare/validator/gate.ts`.
- Emitters: `lib/commcare/lookup/workbook.ts`, `lib/commcare/hq/lookupTables.ts` (the upload arm only; `fieldProperties` and `itemAttributes` on `HqLookupTable` landed in pull request 4), `lib/export/boundaryValidation.ts`.
- Tests changed: `lib/export/__tests__/boundaryValidation.test.ts` and `proof/corpus/__tests__/publishReadiness.test.ts` (their `LOOKUP_TAG_TOO_LONG_FOR_HQ` cases go), `lib/commcare/__tests__/reservedInstanceTags.test.ts` (a referenced table whose tag contains `casedb` is a `LOOKUP_TAG_RESERVED_BY_RUNTIME` finding with the "contains" message), `lib/lookup/__tests__/reservedTags.test.ts`.
- Deployment: `lib/deployment/lookupResourcePlan.ts`, `preflight.ts`, `service.ts`, `types.ts` (`hq_table_content_unsupported`), `remoteChanges.ts` (`LOOKUP_DISCARD_NOTE`).
- Preview: none.
- Builder: `components/builder/PublishDialog.tsx` (the adoption sentence, the unsupported-content refusal, the rebuilt-table warning); `e2e/tests/browser/publishing.spec.ts`.
- SA and MCP tools: `lib/mcp/tools/uploadAppToHq.ts`, `lib/mcp/errors.ts` (`hq_table_content_unsupported`, the adoption sentence in the conflict envelope). No input schema changes for defect 5.
- Cutover: `scripts/lib/hqRoundTripCutover/lookupTags.ts` (new, pure), `writer.ts`, `notice.ts`.
- Proof: `proof/targeted/documents/hqSideState.ts`, `proof/targeted/documents/hqSideLookup.ts` (new in pull request 1; its `republish` statement becomes `"stops"` with `stopCode: "hq_table_content_unsupported"` here; `proof/corpus/documents.ts::HqSideSaves` is not edited, since its `republish` has been `"proceeds" | "discards" | "stops"` with `stopCode` since pull request 5: part 04, Defect 4: a republish overwrites values kept in HQ), `proof/targeted/documents/lookupReservedTags.ts`, `proof/targeted/index.ts`, `proof/checks/test_hq_side.py`, `proof/hq/test_lookup_upload.py`, `proof/hq/couch.py` (`groups/by_user`), `proof/hq/test_retained_reads.py` and `proof/hq-reads/lookup-upload/` (the retained upload answers, which pull request 4 wrote and this one consumes), `proof/formplayer/test_lookup_tags.py`, `proof/android/predicates.py`, `proof/native/test_lookup_workbook.py`, `proof/known-defects.json`, `proof/fixed-defects.json`, `proof/README.md` (its "What the lane does not observe" loses defect 5's two items, which the lane observes from here).
- Docs: `content/docs/project-data.mdx` (the reserved names, the removed 31-character sentence, what a push removes), `content/docs/publishing.mdx`, `docs/architecture/complex-apps.md`, `docs/research/2026-09-26-hq-round-trip/harness-findings.md`.
- CLAUDE.md: `lib/lookup/CLAUDE.md` (a 32-character tag pushes; the substring rule), `lib/commcare/CLAUDE.md`, `lib/export/CLAUDE.md`, `lib/deployment/CLAUDE.md` (its sentence that only HQ's explicit format refusal proves nothing landed gains the plan page as a second proof).

**Stored shape and migration.** No schema changes and no document changes: a reference to a table is its UUID. One Project-level rename runs as a step of the cutover Job, outside the per-app transform:

- `scripts/lib/hqRoundTripCutover/lookupTags.ts::renamedReservedTag(tag, takenTags)` is pure: replace each `casedb` with `case_db` and each `ledgerdb` with `ledger_db`, left to right; truncate to `lib/lookup/constants.ts::LOOKUP_MAX_TAG_LENGTH`; if the Project already holds that tag, append `_2`, `_3` and so on up to `_99` to the tag truncated to make room, and return `null` when none of those is free. Inserting an underscore cannot create a new occurrence (neither word overlaps itself or the other) and a prefix of a string with no occurrence has none, so one pass suffices. The result is parsed with `lib/lookup/schema.ts::lookupTagSchema`; a failure blocks the scan (`lookup-tag-unparsable`), and so does a `null` (`lookup-tag-rename-collision`). Each is part 10's Project-level blocker, naming the Project and the table (part 10, Scripts and their layout, under "The plan-time gate and the planned renames"); `lookupTags.test.ts` carries both arms, whether or not any stored tag reaches them. `plan.ts` computes the Project's rename map before it judges any app, and judges every app of the Project against lookup definitions that already carry the new tags, so an app that references such a table is not stopped by `LOOKUP_TAG_RESERVED_BY_RUNTIME` in the scan or in any mode of the Job (part 10, Scripts and their layout, under "The plan-time gate and the planned renames").
- The writer renames every `lookup_tables` row whose tag contains either substring, referenced or not, to the tag the plan's map holds for it, inside the fleet transaction, through `lib/lookup/writerTransaction.ts` (`lockLookupProjectState`, `advanceLookupProjectRevision`, `updateLockedLookupTable`, `notifyCommittedLookupMutation`), so the definition revision advances and open builders refetch, with `updated_by` `system:hq-round-trip-emission`. Postcondition: no `lookup_tables` row has a tag `isReservedInstanceTag` refuses.
- No ledger write. The next publish plans a `nova-created` push under the new tag, supersedes the old mapping, and `lib/deployment/resources.ts::leftBehindResources` reports the old table from its `pushed_identity`, all existing behavior.
- The scan lists each such table by its Project id and table uuid, with the ids of the apps that reference it (`lookup_table_references`) and each live `app_deployment_resources` row whose `pushed_identity` is the old tag. The old and the new tag are authored text, so they stay out of the report: `--debug-details --app <id>` prints them for a referencing app (part 10, Scripts and their layout, under "The report"). The Job's dry run (not the scan, which makes no HQ request and decrypts nothing) also lists each mapped HQ table that holds a field property, a row attribute or is not global.
- Notice reasons: `lookup-tag-renamed` on each referencing app, naming the table, the old tag, the new tag and why, and for each project space that the next publish creates the new table there and leaves the old one, which Nova cannot rename or remove; `lookup-table-content-unsupported` on each deployment whose mapped table holds content Nova cannot keep, naming the table and that its next publish stops until the table gets a new export tag.

**Register.** Nine entries move to `proof/fixed-defects.json`.

| Entries | Check | Control |
|---|---|---|
| `d5-reserved-substrings-evaluate`, `d5-reserved-substrings-form-instance-source-ledgerdb` | intent, manifest | `targeted-lookup-reserved-tags` |
| `d5-table-content-table-id`, `-description`, `-field-properties`, `-row-attributes`, `-row-ids`, `-row-attribute-values`, `-row-owners` | proof 1, artifact `project` | `targeted-hq-side-state` |

**Spelling rule.** None. `proof/rules/lookup_fields_unshown.py` concerns detail columns, not the push.

**Identity.** One thing moves once in HQ for existing deployments: a renamed table's next publish creates a table under the new tag, with a new HQ id, and leaves the old one. `proof/identity-moves.json` gains no entry: a move there accepts its path on every document (`proof/checks/registers.py::accepted_moves`), so one for `/lookup_tables/*/id` would hide the very regression this fix removes, and the rename happens to Project data before any export, where proof 1 never sees it.

**Control.** `targeted-hq-side-state` keeps showing the seven table-content classes on its retained pre-fix bytes (replayed in its legacy capture layout), and `targeted-lookup-reserved-tags` the two reserved-substring classes. A directory a fixed entry names is never re-retained.

**Nova tests.** These run Nova's own code. What HQ and the runtimes do is proven by the lane and the reader tests under "Lane" below.

| Contract | Boundary |
|---|---|
| `isReservedInstanceTag`: `my_casedb_x` and `xledgerdb` refused, `my_CaseDB` admitted, whole names still refused in any case | pure: `lib/lookup/__tests__/reservedTags.test.ts`; the validator's finding and its "contains" message in `lib/commcare/__tests__/reservedInstanceTags.test.ts` |
| `planLookupResourcePush` returns `unsupported` for a field property, a row attribute and a not-global table, for Nova's own, adopted and being-adopted tables alike, and never for a tag HQ does not hold; over HQ's retained definition list it names the retained table that holds all three | pure, with `proof/hq-reads/lookups/` for the last clause: `lib/deployment/__tests__/lookupResourcePlan.test.ts` |
| What a publish sends and stores: over such a table it refuses with `hq_table_content_unsupported` before any write request and offers no discard; adopting does not resolve it; a table the re-list shows under a new id after a push of an unchanged definition lands with the made-again warning | real Postgres with a peer that records every request (the peer of `__tests__/helpers/httpPeer.ts`, documents from `lib/deployment/__tests__/publishFixtures.ts`): `proof/corpus/__tests__/publish.postgres.test.ts` |
| HQ's retained plan-page answer (200, `text/html`) is `mayHaveLanded: false`, `upgradeRequired: true`; HQ's retained JSON answers keep their arms (`code` 200 lands, `code` 405 is the format refusal); a 200 that claims JSON and does not parse stays `mayHaveLanded: true`; the failure's sentence says nothing changed | a peer serving `proof/hq-reads/lookup-upload/`: `lib/commcare/__tests__/hqLookupTables.test.ts` |
| A 32-character tag builds a workbook, and the export boundary reports no finding for it | pure: `lib/commcare/lookup/__tests__/workbook.test.ts` |
| `renamedReservedTag`: each substring, both in one tag, truncation at 32, the collision suffix, `null` when `_2` to `_99` are all taken, a result that still parses | pure: `scripts/lib/hqRoundTripCutover/__tests__/lookupTags.test.ts` |
| The rename over a real Project with a referencing app advances the definition revision, leaves the reference intact, and leaves no refused tag | real Postgres: `scripts/lib/hqRoundTripCutover/__tests__/writer.postgres.test.ts` over the frozen pre-step fixtures |
| The dialog shows the adoption sentence and the unsupported-content refusal | Playwright, browser component test against its controlled boundary: a second new case in `e2e/tests/browser/publishing.spec.ts` |

**Lane.**

- **Pull request 1 (lane mechanics) splits `targeted-hq-side-state`.** The district table and its `lookupTable` save move to a new document, `targeted-hq-side-lookup` (`proof/targeted/documents/hqSideLookup.ts`); `targeted-hq-side-state` keeps the translation, location-capture and build-profile saves. The seven `d5-table-content-*` entries change `document` to `targeted-hq-side-lookup` and keep `control` `targeted-hq-side-state`, whose retained bytes still hold the table. Reason: those seven need the republish to stop, while defect 1's and defect 4's entries on the same document need it to land, so one document cannot serve both once this fix exists.
- **Pull request 4 (drift).** `targeted-hq-side-lookup`'s republish is refused with `hq_changed` (the definition differs), the capture confirms it, B lands, and the seven entries still show. They stay live.
- **Pull request 14 (this fix).** `targeted-hq-side-lookup`'s republish is Nova's refusal `hq_table_content_unsupported`. `proof/targeted/documents/hqSideLookup.ts` changes its `republish` statement from `"discards"` (pull request 5's, part 04, Defect 4: a republish overwrites values kept in HQ) to `"stops"` with `stopCode: "hq_table_content_unsupported"`, the third value `proof/corpus/documents.ts::HqSideSaves.republish` has declared since pull request 5, which no document states before this one. A capture whose outcome differs from the statement, or whose stop carries another code than `stopCode`, fails the emission, so the statement moves with the fix. The capture records the refusal and no B export exists. `proof/checks/test_hq_side.py` asserts HQ's table is identical before and after the attempt: same table id, description, field properties, row attributes, row ids and owners. The nine entries move to the fixed register in the same pull request.
- **Reserved tags and the 32-character tag, on every runtime.** `targeted-lookup-reserved-tags` is rewritten with the split tags, one of them padded to 32 characters (`clinic_case_db_codes_0123456789a`, `stock_ledger_db_codes`), so it stays in the corpus as a passing witness: Nova's real push of a 32-character tag goes through HQ's upload, HQ's restore serves it, Core's sessions run it on both paths, and the intent check counts two rows in each table. `proof/native/test_lookup_workbook.py`'s lookup family gains a 32-character tag as well, read by HQ's workbook parser. Two reader tests land with it, each the run made by hand during planning (the table under item 6):
  - `proof/formplayer/test_lookup_tags.py`: over HQ's build and HQ's restore of the rewritten document, the form opens and each select lists its two rows; the same with the tables renamed to the other-case tags in a fork (the tables through HQ's models, the form's source through the editor path, as the spelling rules' tests write a spelling); and over the control's retained bytes the form does not open.
  - `proof/android/predicates.py`, a new case: the rewritten document's local archive lists two rows in each select; the other-case archive does the same; the control's `local.ccz` raises the "lookup table is available" error at its first question.
- **The plan page and the upload's own answers.** New cases in `proof/hq/test_lookup_upload.py`, through `proof/hq/operations.py::api_request`: with the lookup-table privilege withheld the upload view answers 200 `text/html` with the "Upgrade Required" title and HQ holds no table afterwards; with it, the three JSON answers of item 4's table. The page's template names a script bundle the image's editor build does not make (`hqwebapp/js/base`); the test answers that one manifest read with a bundle name and records that it did, since the script is not what is read. The answers are the retained files Nova's adapter test consumes.
- **Owners.** A new case in the same file: `ItemListsProvider.__call__` for two workers over a table with one owned row, global and then not, and Nova's captured workbook pushed over the global one, as executed under item 1. `proof/hq/couch.py::VIEWS` gains `groups/by_user` from its `map.js`, which HQ reads to find a worker's groups.
- **A description and an indexed field.** A new case in the same file: Nova's captured workbook pushed over an identical table, a described one and an indexed one, and HQ's own download of the described table uploaded back, as executed under item 3.
- **Local run:** `npm run proof -- proof/checks/test_hq_side.py proof/hq/test_lookup_upload.py proof/formplayer/test_lookup_tags.py proof/native/test_lookup_workbook.py`, `python3 -m unittest proof.android.predicates` on the Android reader's runtime, and the checks over `targeted-hq-side-lookup`, `targeted-lookup-reserved-tags` and `targeted-hq-side-state`.
- **CI's full lane must show:** no defect 5 entry in `proof/known-defects.json`; all nine held on their controls from `proof/fixed-defects.json`; no unregistered difference on `targeted-hq-side-lookup` or `targeted-lookup-reserved-tags`; `index.json`'s document ids changed only by the one added document (pull request 1) and none here.

## Correction 15: Nova holds the 32-character tag cap itself

**Today.** The research says HQ's upload reads a 32-character sheet name, and defect 5's fix above removes the 31-character cap on that ground. The lane ran the rest of it: HQ's upload checks no length, its column holds 32 characters (`fixtures/models.py::LookupTable.tag`, `CharIdField(max_length=32)`), and a 33-character tag is not refused but fails inside the view with a database error that HQ answers as a 500, leaving no table (`proof/views/test_lookup_upload.py::test_hqs_upload_reads_a_table_whose_tag_holds_32_characters_and_fails_on_33`, through HQ's own upload view: 32 characters answers 200 twice and holds the table, 33 answers 500 and holds none). HQ's own table page enforces 31 (`fixtures/const.py::LOOKUP_TABLE_TAG_MAX_LENGTH`), which `harness-findings.md` records under "What HQ does itself". So the only cap a push can rely on is the client's, and Nova's must be exactly 32. Nova holds it today in two places: `lib/lookup/constants.ts::LOOKUP_MAX_TAG_LENGTH` (32), read by `lib/lookup/schema.ts::lookupTagSchema` for every write path (the builder, the SA and MCP lookup tools through `lib/lookup/authoringBatch.ts`, and the raw CSV replacement), and the `lookup_tables` check `char_length(tag) BETWEEN 1 AND 32` (`lib/case-store/migrations/20260722053000_lookup_tables.ts`). Nothing proves that the two stay at 32 once defect 5 removes the export boundary's own 31.

**Fix.** The cap stays 32, held by Nova, and is pinned to HQ's column by a test, so neither side can move without the lane saying so.

- `LOOKUP_MAX_TAG_LENGTH` and the table's check are unchanged, and the constant's comment says why it is 32: HQ's upload takes a 32-character tag and fails on a longer one with a 500 instead of refusing it, so a longer tag would reach HQ as a server error.
- `scripts/lib/hqRoundTripCutover/lookupTags.ts::renamedReservedTag` truncates to that constant (defect 5, "Stored shape and migration"), so the cutover's renames stay inside it.
- No other writer of a tag exists: every tag reaches the database through `lookupTagSchema` or the cutover's rename.

**Files.** `lib/lookup/constants.ts` (the comment), `lib/lookup/__tests__/reservedTags.test.ts` (the length arm), `lib/case-store/migrations/__tests__/` (the check), `proof/views/test_lookup_upload.py` (unchanged; it is the proof), `lib/lookup/CLAUDE.md` (the sentence that replaces "one past what a CommCare HQ data sheet can be named for": a tag holds 32 characters, the length HQ's upload stores, and Nova refuses a longer one because HQ answers it with a server error). Domain beyond these, doc and mutations, validator, emitters, Preview, builder, SA and MCP tools: none.

**Stored shape and migration.** None: no stored tag can exceed 32, since the table's check has held that from its first migration.

**Register.** None. HQ's 500 is an answer to a tag Nova never sends, so no corpus document shows it; the lane's view test holds HQ's side.

**Spelling rule.** None. **Identity.** None. No entry in `proof/identity-moves.json`. **Control.** None.

**Nova tests.** Pure: `lookupTagSchema` accepts a 32-character tag and refuses a 33-character one with the length message; `renamedReservedTag` never returns more than 32 characters (its existing truncation cases). Real Postgres: inserting a 33-character tag into `lookup_tables` fails the check. A pure test pins `LOOKUP_MAX_TAG_LENGTH` to 32 with a comment naming the lane test, so a change to it is a reviewed change against HQ's column.

**Lane.** `npm run proof -- proof/views/test_lookup_upload.py`: HQ's upload holds a 32-character tag's table across two uploads and answers 500 with no table for 33. The weekly pin pull request runs it, so a change to HQ's column length fails there first. With defect 5's fix, `targeted-lookup-reserved-tags` pushes a 32-character tag through Nova's real publish on every pull request (defect 5, "Lane"). Pull request 14, with defect 5.
