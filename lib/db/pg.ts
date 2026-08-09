// Kysely typing + handle for the app-state tables (`apps`,
// `blueprint_entities`, `app_changes`, `events`, `threads`,
// `run_summaries`, `presence`, `user_settings`, the two monthly ledgers, media
// assets, and Project-scoped lookup data) — the storage layer behind every
// `lib/db` module. DDL lives in `lib/case-store/migrations/`; these types and
// their owning migration must move in lockstep.
//
// Runs on the SHARED case-store pool (one pool per instance — the connection
// budget in `lib/case-store/postgres/connection.ts`), the same pattern as
// `lib/auth/db.ts`. The pool's lifecycle is owned by the connection layer;
// this module never ends it.
//
// `withAppTx` is the one transaction entry point: every multi-statement
// read-modify-write in `lib/db` runs through it so deadlock/serialization
// retries are uniform. Lock ordering discipline: a transaction that touches an
// app row and any other row (credit months, entities, the stream) locks the
// APP ROW FIRST (`SELECT … FOR UPDATE`), so app-scoped transactions serialize
// per app and can't deadlock across tables.

import {
	type ColumnType,
	type IsolationLevel,
	type JSONColumnType,
	Kysely,
	PostgresDialect,
	type PostgresPool,
	sql,
	type Transaction,
} from "kysely";
import { getCaseStorePool } from "@/lib/case-store/postgres/connection";
import type { EntityRowKind } from "@/lib/db/blueprintRows";
import type { Mutation } from "@/lib/doc/types";
import type { CaseType, ConnectType, MediaAssetId, Uuid } from "@/lib/domain";
import type {
	LookupColumnId,
	LookupRowId,
	LookupTableId,
} from "@/lib/domain/lookupIds";
import type { Location } from "@/lib/routing/types";
import { delay } from "@/lib/utils/delay";

/** Server-set timestamp: read as `Date`, write as `Date`/ISO, omit when defaulted. */
type Timestamp = ColumnType<Date, Date | string | undefined, Date | string>;
/** `bigint` counters read through the shared nonnegative safe-integer boundary. */
type BigIntColumn = ColumnType<string | number, number, number>;
/** Lookup revisions stay exact decimal strings on every application boundary. */
type LookupRevisionColumn = ColumnType<string, string, string>;
/** Exact lookup revision with a database default, so INSERT may omit it. */
type DefaultedLookupRevisionColumn = ColumnType<
	string,
	string | undefined,
	string
>;
/** Server-defaulted branded UUIDv7 identity: optional on INSERT, immutable on UPDATE. */
type DefaultedUuidV7Column<Identity extends string> = ColumnType<
	Identity,
	Identity | undefined,
	never
>;

export interface AppsTable {
	id: string;
	owner: string;
	project_id: string;
	app_name: string;
	app_name_lower: string;
	connect_type: ConnectType | null;
	case_types: JSONColumnType<CaseType[] | null, string | null, string | null>;
	logo: MediaAssetId | null;
	module_count: number;
	form_count: number;
	mutation_seq: BigIntColumn;
	status: string;
	awaiting_input: boolean;
	error_type: string | null;
	deleted_at: ColumnType<
		Date | null,
		Date | string | null,
		Date | string | null
	>;
	recoverable_until: ColumnType<
		Date | null,
		Date | string | null,
		Date | string | null
	>;
	run_id: string | null;
	res_period: string | null;
	res_reserved: number | null;
	res_settled: boolean | null;
	res_user_id: string | null;
	res_run_id: string | null;
	lock_run_id: string | null;
	lock_actor_user_id: string | null;
	lock_expire_at: ColumnType<
		Date | null,
		Date | string | null,
		Date | string | null
	>;
	/** Server-minted generation of the current (or most recently reaped) holder.
	 * Concrete on every nonce-capable holder; null marks legacy/corrupt state. */
	run_holder_nonce: ColumnType<
		string | null,
		string | null | undefined,
		string | null
	>;
	created_at: Timestamp;
	updated_at: Timestamp;
}

export interface BlueprintEntitiesTable {
	app_id: string;
	uuid: Uuid;
	/** The kind union lives on `EntityRowKind` in `lib/db/blueprintRows.ts`
	 *  beside the decompose/assemble pair, and the SQL `CHECK` constraint
	 *  mirrors it. */
	kind: EntityRowKind;
	parent_uuid: Uuid | null;
	/** Index within the owning membership array at write time. Nested rows use
	 *  their parent's array; Blueprint-root and flat rows use their root array.
	 *  The array is the sequence, so every ordered kind — including the three
	 *  flat user collections — stores a real ordinal. */
	ordinal: number;
	// The entity record verbatim (a `Module` / `Form` / `Field` / `UserProperty`
	// / `UserType` / `Persona`); typed loosely here because every kind shares
	// one table — the assembler Zod-parses the assembled doc at the boundary,
	// not per row.
	data: JSONColumnType<Record<string, unknown>>;
}

export interface AppChangesTable {
	app_id: string;
	seq: BigIntColumn;
	batch_id: string;
	run_id: string | null;
	actor_id: string;
	kind: string;
	mutations: JSONColumnType<Mutation[]>;
	from_project_id: string | null;
	to_project_id: string | null;
	ts: Timestamp;
}

/** Immutable canonical snapshot establishing one explicit app-change fold
 * horizon. Runtime may read these rows but only a schema migration inserts
 * them; database triggers reject update/delete. */
export interface AppChangeFoldBaselinesTable {
	app_id: string;
	seq: BigIntColumn;
	project_id: string;
	snapshot: JSONColumnType<Record<string, unknown>>;
	snapshot_digest: string;
	created_at: Timestamp;
}

export interface EventsTable {
	id: ColumnType<string | number, never, never>;
	app_id: string;
	run_id: string;
	ts: BigIntColumn;
	seq: number;
	source: string;
	kind: string;
	event: JSONColumnType<Record<string, unknown>>;
}

/**
 * Chat threads — one row per CONVERSATION (not per run; a thread spans many
 * runs). `messages` is the full `UIMessage[]` transcript, server-written: the
 * incoming history upserts when a run claims the app, the assembled assistant
 * response appends at finalize. `active_stream_id` points at the in-flight
 * POST's durable chunk-log stream (the page-refresh resume handle) and is
 * cleared in the same finalize write. Timestamps are ISO-8601 text (this
 * table's convention); `updated_at` orders the thread list.
 */
export interface ThreadsTable {
	thread_id: string;
	/** Exactly one generation target: `app_id` XOR `design_session_id`
	 * (`threads_exactly_one_target`). A build thread stays design-session-
	 * targeted after materialization; the target resolver supplies the app. */
	app_id: string | null;
	design_session_id: string | null;
	created_at: string;
	updated_at: string;
	thread_type: string;
	summary: string;
	run_id: string;
	active_stream_id: string | null;
	/** Operational continuation binding; never selected into ordinary thread
	 * metadata/messages and cleared when its exact stream finishes unpaused. */
	active_holder_nonce: ColumnType<
		string | null,
		string | null | undefined,
		string | null
	>;
	messages: JSONColumnType<unknown[]>;
	/** Assistant message ids the server deliberately removed or reverted (a
	 * failed turn's claw-back, a re-drive claim's dead-partial trim) and has
	 * not re-authored since. The history-admission gate refuses a client copy
	 * of these ids; a fold snapshot that re-authors one clears it. */
	clawed_back_ids: JSONColumnType<string[], string | undefined, string>;
}

/**
 * The durable chat-stream chunk log — one row per flushed batch of UI message
 * chunks, `first_index` the stream-wide index of `chunks[0]`. Short-lived
 * operational state (pruned past the retention window), read back by the
 * resumable-stream endpoint. `chunks` holds AI SDK `UIMessageChunk` objects;
 * typed as the wire-opaque record shape here because the data layer never
 * inspects them.
 */
export interface ChatStreamChunksTable {
	stream_id: string;
	first_index: number;
	/** Exactly one generation target: `app_id` XOR `design_session_id`
	 * (`chat_stream_chunks_exactly_one_target`). */
	app_id: string | null;
	design_session_id: string | null;
	run_id: string;
	chunks: JSONColumnType<Record<string, unknown>[]>;
	terminal: boolean;
	/** The run's fold outcome, stamped on the terminal row by the writer's
	 * close ("completed" | "paused" | "failed" | "aborted" | "skip"). Null on
	 * non-terminal rows and on terminal rows sealed before this column
	 * existed. The dead-marker reconciler reads it to tell a finished turn
	 * whose marker-clear write was lost from a run that died mid-turn. */
	terminal_outcome: string | null;
	created_at: Timestamp;
}

export interface RunSummariesTable {
	/** Exactly one generation target: `app_id` XOR `design_session_id`
	 * (`run_summaries_exactly_one_target`); the old `(app_id, run_id)` primary
	 * key is now the pair of partial unique indexes `run_summaries_app_run` /
	 * `run_summaries_design_session_run`. */
	app_id: string | null;
	design_session_id: string | null;
	run_id: string;
	started_at: string;
	finished_at: string;
	prompt_mode: string;
	app_ready: boolean;
	module_count: number;
	step_count: number;
	model: string;
	input_tokens: BigIntColumn;
	output_tokens: BigIntColumn;
	cache_read_tokens: BigIntColumn;
	cache_write_tokens: BigIntColumn;
	cost_estimate: number;
	tool_call_count: number;
}

export interface PresenceTable {
	app_id: string;
	user_id: string;
	session_id: string;
	name: string;
	image: string | null;
	email: string;
	color: string;
	location: JSONColumnType<Location>;
	updated_at: Timestamp;
	expire_at: Timestamp;
}

export interface UserSettingsTable {
	user_id: string;
	commcare_username: string;
	commcare_api_key: string;
	commcare_server: string | null;
	approved_domains: JSONColumnType<{ name: string; displayName: string }[]>;
	updated_at: Timestamp;
}

export interface UsageMonthsTable {
	user_id: string;
	period: string;
	input_tokens: BigIntColumn;
	output_tokens: BigIntColumn;
	cost_estimate: number;
	request_count: number;
	updated_at: Timestamp;
}

export interface CreditMonthsTable {
	user_id: string;
	period: string;
	allowance: number;
	consumed: number;
	bonus: number;
	updated_at: Timestamp;
}

export interface CreditGrantsTable {
	id: ColumnType<string | number, never, never>;
	user_id: string;
	amount: number;
	type: "reset" | "grant";
	actor: string;
	actor_email: string;
	reason: string | null;
	period: string;
	created_at: Timestamp;
}

export interface MediaAssetsTable {
	id: MediaAssetId;
	project_id: string;
	owner: string;
	content_hash: string;
	mime_type: string;
	extension: string;
	size_bytes: BigIntColumn;
	dimensions: JSONColumnType<
		{ width: number; height: number } | null,
		string | null,
		string | null
	>;
	duration_ms: ColumnType<string | number | null, number | null, number | null>;
	kind: string;
	gcs_object_key: string;
	original_filename: string;
	display_name: string | null;
	status: string;
	// `MediaAssetExtract` with `extractedAt` as epoch ms (jsonb carries no Date).
	extract: JSONColumnType<
		Record<string, unknown> | null,
		string | null,
		string | null
	>;
	created_at: Timestamp;
}

export interface MediaAssetRefsTable {
	project_id: string;
	asset_id: MediaAssetId;
	app_id: string;
}

/**
 * Exact conversation attachment references — one row per `(thread, asset)`,
 * replaced under the thread's own transcript transaction. The split half of
 * the media projection: `media_asset_refs` carries ONLY authored Blueprint
 * references, this table ONLY conversation carriers. Deletion checks both.
 */
export interface ThreadMediaRefsTable {
	thread_id: string;
	asset_id: MediaAssetId;
	project_id: string;
}

/** One successful pending-attempt id -> canonical ready asset replay record. */
export interface MediaUploadAliasesTable {
	attempt_asset_id: MediaAssetId;
	project_id: string;
	content_hash: string;
	canonical_asset_id: MediaAssetId;
	created_at: Timestamp;
	expires_at: Timestamp;
}

export interface LookupProjectStateTable {
	project_id: string;
	/** Project-wide invalidation clock; never coerce to a JavaScript number. */
	revision: DefaultedLookupRevisionColumn;
	updated_at: Timestamp;
}

export interface LookupTablesTable {
	project_id: string;
	id: DefaultedUuidV7Column<LookupTableId>;
	name: string;
	tag: string;
	/** Definition and row revisions are exact signed-int64 decimal strings. */
	definition_revision: LookupRevisionColumn;
	rows_revision: LookupRevisionColumn;
	/** Maintained with child writes under the locked table row. */
	column_count: number;
	row_count: ColumnType<number, number | undefined, number>;
	data_bytes: ColumnType<number, number | undefined, number>;
	created_by: string;
	updated_by: string;
	created_at: Timestamp;
	updated_at: Timestamp;
}

export type StoredLookupColumnDataType =
	| "text"
	| "int"
	| "decimal"
	| "date"
	| "time"
	| "datetime";

export interface LookupColumnsTable {
	project_id: string;
	table_id: LookupTableId;
	id: DefaultedUuidV7Column<LookupColumnId>;
	wire_name: string;
	label: string;
	data_type: StoredLookupColumnDataType;
	order_key: string;
}

export interface LookupRowsTable {
	project_id: string;
	table_id: LookupTableId;
	id: DefaultedUuidV7Column<LookupRowId>;
	order_key: string;
	/** UUID-keyed scalar cells; runtime validation owns the per-column shape. */
	values: JSONColumnType<Record<LookupColumnId, string | number>>;
	/** Postgres-generated `octet_length(values::text)`; never caller-written. */
	value_bytes: ColumnType<number, never, never>;
	created_by: string;
	updated_by: string;
	created_at: Timestamp;
	updated_at: Timestamp;
}

/** One exact app -> lookup-table target. Structural occurrence paths stay in memory. */
export interface LookupTableReferencesTable {
	project_id: string;
	table_id: LookupTableId;
	app_id: string;
}

/** One exact app -> lookup-column target; its parent table edge must also exist. */
export interface LookupColumnReferencesTable {
	project_id: string;
	table_id: LookupTableId;
	column_id: LookupColumnId;
	app_id: string;
}

export interface AppOrganizationStateTable {
	app_id: string;
	revision: DefaultedLookupRevisionColumn;
	location_count: ColumnType<number, number | undefined, number>;
	updated_at: Timestamp;
}

export interface AppLocationsTable {
	id: DefaultedUuidV7Column<string>;
	app_id: string;
	level_uuid: Uuid;
	parent_id: string | null;
	site_code: string;
	name: string;
	external_id: string | null;
	/** Postgres numeric columns are returned as exact decimal strings. */
	latitude: string | null;
	longitude: string | null;
	values: JSONColumnType<Record<string, string>>;
	archived_at: ColumnType<
		Date | null,
		Date | string | null | undefined,
		Date | string | null
	>;
	order_key: string;
	created_at: Timestamp;
	updated_at: Timestamp;
	created_by: string | null;
	updated_by: string | null;
}

export interface AppLocationReferencesTable {
	app_id: string;
	location_id: string;
}

/**
 * One app, published to one CommCare HQ project space.
 *
 * Keyed by `(app_id, project_id, server, domain)`: all four pick out a
 * different publication, since the same app in another Project belongs to
 * another tenant and CommCare HQ's US, India, and EU installations share
 * no account database.
 *
 * `project_id` deliberately does NOT take the composite tenant key `cases`
 * uses: the auth-app tenancy migration keeps an exact catalog of everything
 * referencing `apps.project_id` and blocks additions, so a second one would
 * fail the migration job. Coherence comes from
 * `lib/deployment/store.ts::lockAppForDeploymentWrite`, which compares the
 * locked app's Project before any write, and from the Project move updating
 * these rows in the same transaction.
 */
export interface AppDeploymentsTable {
	id: DefaultedUuidV7Column<string>;
	app_id: string;
	project_id: string;
	server: string;
	domain: string;
	state: string;
	resume_phase: string | null;
	phases: JSONColumnType<Record<string, unknown>>;
	created_by: string;
	created_at: Timestamp;
	updated_at: Timestamp;
	last_observed_at: ColumnType<
		Date | null,
		Date | string | null | undefined,
		Date | string | null
	>;
}

/**
 * What Nova calls a resource, and what CommCare HQ calls the same thing.
 *
 * The ownership ledger: Nova repoints or updates only what it created, and
 * never infers ownership from a name. A row whose `superseded_at` is set
 * names a resource a later publish left behind on the target project
 * space, kept precisely so the author can be told it is still there.
 */
export interface AppDeploymentResourcesTable {
	id: DefaultedUuidV7Column<string>;
	deployment_id: string;
	kind: string;
	nova_resource_id: string;
	remote_id: string;
	ownership: string;
	pushed_revision: ColumnType<
		string | number | null,
		number | null | undefined,
		number | null
	>;
	pushed_at: ColumnType<
		Date | null,
		Date | string | null | undefined,
		Date | string | null
	>;
	remote_revision: ColumnType<
		string | number | null,
		number | null | undefined,
		number | null
	>;
	remote_observed_at: ColumnType<
		Date | null,
		Date | string | null | undefined,
		Date | string | null
	>;
	superseded_at: ColumnType<
		Date | null,
		Date | string | null | undefined,
		Date | string | null
	>;
	created_at: Timestamp;
}

/**
 * One private Atomic Change Set — the mutable authority row for a slice
 * executor's durable staging workspace (`lib/agent/change-set/`).
 *
 * `base_project_id` is the CAPTURED base scope, never live tenancy: a
 * Project move deliberately strands open sets (their commit rejects), so
 * no move transaction touches these rows. `design_session_id` is bound to
 * `design_sessions(id)`; the remaining design/plan identity columns stay
 * opaque until the orchestrator unit adds its tables and foreign keys.
 */
export interface DesignChangeSetsTable {
	id: string;
	design_session_id: string;
	design_revision_id: string;
	design_revision_digest: string;
	build_plan_id: string;
	build_plan_digest: string;
	slice_id: string;
	attempt_id: string;
	kind: string;
	app_id: string | null;
	proposed_app_id: string | null;
	base_seq: ColumnType<string | number | null, number | null, never>;
	base_project_id: string;
	base_snapshot_digest: string;
	revision: ColumnType<string | number, number | undefined, number>;
	next_ordinal: ColumnType<string | number, number | undefined, number>;
	exclusive_kind: string | null;
	owner_user_id: string;
	owner_run_id: string;
	status: string;
	committed_seq: ColumnType<string | number | null, number | null, number>;
	committed_batch_id: string | null;
	committed_snapshot_digest: string | null;
	created_at: Timestamp;
	updated_at: Timestamp;
}

/** One durable staging request — the idempotency ledger's receipt row. */
export interface DesignChangeSetRequestsTable {
	change_set_id: string;
	request_id: string;
	tool_name: string;
	input_digest: string;
	expected_revision: BigIntColumn;
	resulting_revision: BigIntColumn;
	status: string;
	rejection_code: string | null;
	/** The exact `StageRequestReceipt` — read as `::text`, strict-parsed. */
	receipt: JSONColumnType<Record<string, unknown>>;
	created_at: Timestamp;
}

/** One admitted staged step — exact canonical mutations, append-only. */
export interface DesignChangeSetStepsTable {
	change_set_id: string;
	ordinal: BigIntColumn;
	request_id: string;
	tool_name: string;
	/** Exact admitted batch — read as `::text` through mutation admission. */
	mutations: JSONColumnType<Mutation[]>;
	mutation_digest: string;
	intent_ids: JSONColumnType<string[]>;
	read_set: JSONColumnType<Record<string, unknown>[]>;
	created_at: Timestamp;
}

/** A step's stage ranges — names + mutation spans, never duplicated bytes. */
export interface DesignChangeSetStepStagesTable {
	change_set_id: string;
	step_ordinal: BigIntColumn;
	stage_ordinal: number;
	stage_name: string;
	mutation_start: number;
	mutation_count: number;
}

/** One private handle binding — `@name` → server-minted canonical UUID. */
export interface DesignChangeSetHandlesTable {
	change_set_id: string;
	handle: string;
	uuid: string;
	entity_kind: string;
	binding_request_id: string;
	created_at: Timestamp;
}

/** The immutable committed-slice receipt, inserted by the commit sidecar. */
export interface DesignCommittedSlicesTable {
	id: string;
	design_session_id: string;
	design_revision_id: string;
	design_revision_digest: string;
	build_plan_id: string;
	build_plan_digest: string;
	slice_id: string;
	slice_attempt_id: string;
	change_set_id: string;
	app_id: string;
	seq: BigIntColumn;
	batch_id: string;
	committed_snapshot_digest: string;
	owning_intent_ids: JSONColumnType<string[]>;
	mutation_count: number;
	committed_at: Timestamp;
}

/**
 * One append-only orchestration transition — the chain the build
 * orchestrator folds into its current state (`lib/agent/build/`). Every
 * event names its predecessor by id AND digest; the partial unique index on
 * `(design_session_id, predecessor_event_id)` makes two continuations
 * structurally unable to advance the same state. Raw holder nonces never
 * land here — `holder_nonce_digest` is the safe audit projection.
 */
export interface DesignOrchestrationEventsTable {
	design_session_id: string;
	revision: BigIntColumn;
	event_id: string;
	predecessor_event_id: string | null;
	predecessor_digest: string | null;
	run_id: string;
	holder_nonce_digest: string;
	kind: string;
	/** The strict per-kind state payload — read as `::text`, strict-parsed. */
	payload: JSONColumnType<Record<string, unknown>>;
	created_at: Timestamp;
}

/**
 * One bounded executor run over one build slice — the mutable
 * execution-control row (`lib/agent/build/executor.ts`). Input identities
 * are immutable; only `status` (+ failure metadata and the once-set
 * `change_set_id`) moves. A partial unique index permits one `running`
 * attempt per `(design_session_id, build_plan_id, slice_id)`.
 */
export interface DesignSliceAttemptsTable {
	id: string;
	design_session_id: string;
	design_revision_id: string;
	design_revision_digest: string;
	build_plan_id: string;
	build_plan_digest: string;
	slice_id: string;
	attempt: number;
	base_kind: string;
	base_app_id: string | null;
	base_proposed_app_id: string | null;
	base_seq: BigIntColumn | null;
	base_snapshot_digest: string;
	change_set_id: string | null;
	executor_model: string;
	prompt_version: string;
	brief_digest: string;
	status: string;
	failure_code: string | null;
	created_at: Timestamp;
	updated_at: Timestamp;
}

export interface DesignExternalActionReceiptsTable {
	id: string;
	design_session_id: string;
	build_plan_id: string;
	external_action_id: string;
	project_id: string;
	app_id: string | null;
	action_digest: string;
	outcome: string;
	evidence: JSONColumnType<Record<string, unknown>>;
	completed_at: Timestamp;
}

/**
 * One persisted design source package — references, normalized claims, and
 * the canonical digest over the exact projection the models consumed
 * (`lib/agent/design/sourcePackage.ts`). Raw extracts and transcripts are
 * never duplicated here. `design_session_id` is bound to
 * `design_sessions(id)`.
 */
export interface DesignSourcePackagesTable {
	id: string;
	design_session_id: string;
	project_id: string;
	package_digest: string;
	created_by_run_id: string;
	/** The `PersistedSourcePackage` — read as `::text`, strict-parsed. */
	payload: JSONColumnType<Record<string, unknown>>;
	created_at: Timestamp;
}

/** One immutable Design Contract revision — lifecycle fixed at insert;
 *  acceptance is a NEW accepted row, never an update. */
export interface DesignRevisionsTable {
	id: string;
	design_session_id: string;
	revision: BigIntColumn;
	parent_revision_id: string | null;
	lifecycle: string;
	artifact_digest: string;
	contract_digest: string;
	source_package_digest: string;
	producer_model: string;
	prompt_version: string;
	created_by_run_id: string;
	/** The full `DesignArtifactEnvelope<AppDesignContract>` — `::text` read. */
	envelope: JSONColumnType<Record<string, unknown>>;
	created_at: Timestamp;
}

/** One independent fresh-context review of one exact contract revision. */
export interface DesignReviewsTable {
	id: string;
	design_session_id: string;
	design_revision_id: string;
	review_ordinal: number;
	reviewed_revision_digest: string;
	artifact_digest: string;
	producer_model: string;
	prompt_version: string;
	created_by_run_id: string;
	/** The full `DesignArtifactEnvelope<DesignReview>` — `::text` read. */
	envelope: JSONColumnType<Record<string, unknown>>;
	created_at: Timestamp;
}

/** Exactly one disposition per dispositioned finding, naming the revision
 *  that resolved it. */
export interface DesignReviewDispositionsTable {
	review_id: string;
	finding_id: string;
	status: string;
	resulting_revision_id: string;
	/** The exact `FindingDisposition` — `::text` read, strict-parsed. */
	payload: JSONColumnType<Record<string, unknown>>;
	created_at: Timestamp;
}

/** One immutable build plan, digest-bound to its accepted revision. */
export interface DesignBuildPlansTable {
	id: string;
	design_session_id: string;
	design_revision_id: string;
	design_revision_digest: string;
	plan_digest: string;
	artifact_digest: string;
	producer_model: string;
	prompt_version: string;
	created_by_run_id: string;
	/** The full `DesignArtifactEnvelope<BuildPlan>` — `::text` read. */
	envelope: JSONColumnType<Record<string, unknown>>;
	created_at: Timestamp;
}

/**
 * One design session — the pre-app generation target (mode `build`) or a
 * design-aware edit's artifact scope (mode `edit`, whose bound app row stays
 * the sole run/credit authority). A build session carries the same holder +
 * reservation nullable column groups the `apps` row carries; the migration's
 * CHECKs make a partial group, a holder on an edit session, and authority
 * columns on a terminal session unrepresentable. Lifecycle writers live in
 * `lib/db/designSessions.ts` and mirror the app run protocol exactly.
 */
export interface DesignSessionsTable {
	id: string;
	mode: string;
	project_id: string;
	owner_user_id: string;
	proposed_app_id: string | null;
	app_id: string | null;
	state: string;
	awaiting_input: ColumnType<boolean, boolean | undefined, boolean>;
	run_id: string | null;
	run_holder_nonce: string | null;
	run_actor_user_id: string | null;
	run_mode: string | null;
	run_lease_expires_at: ColumnType<
		Date | null,
		Date | string | null | undefined,
		Date | string | null
	>;
	res_period: string | null;
	res_reserved: number | null;
	res_settled: boolean | null;
	res_user_id: string | null;
	res_run_id: string | null;
	last_error_type: string | null;
	active_design_revision_id: string | null;
	active_build_plan_id: string | null;
	created_at: Timestamp;
	updated_at: Timestamp;
}

/** Committed design provenance — intent → implementation coordinate. */
export interface AppChangeIntentsTable {
	app_id: string;
	seq: BigIntColumn;
	design_session_id: string;
	design_revision_id: string;
	build_plan_id: string;
	slice_id: string;
	intent_id: string;
	coordinate_kind: string;
	coordinate_payload: JSONColumnType<Record<string, unknown>>;
	created_at: Timestamp;
}

/**
 * One file a worker attached to a form in the running preview.
 *
 * A submission-scoped lane, deliberately NOT `media_assets`: a captured
 * photo is data, not an authoring asset. Tenancy is `(app_id,
 * project_id)` like case rows; `created_by` is the narrower axis that
 * keeps entry reservation and clear/replace on the acting member's rows.
 */
export interface FormAttachmentsTable {
	attachment_id: string;
	/** The value the form answer holds — `<attachment_id><extension>`. */
	attachment_name: string;
	app_id: string;
	project_id: string;
	created_by: string;
	/** One form entry (an `activateForm`), the idempotency/reservation scope. */
	entry_key: string;
	field_uuid: Uuid;
	/** Concrete engine path, so replace/clear targets one repeat instance. */
	instance_path: string;
	original_filename: string;
	extension: string;
	content_type: string;
	size_bytes: BigIntColumn;
	gcs_object_key: string;
	/** Immutable GCS generation captured at confirm; null only while pending. */
	object_generation: string | null;
	/** GCS CRC32C used to prove an idempotent destination is the same bytes. */
	object_checksum: string | null;
	/** Verified deterministic final-key generation before atomic acceptance. */
	prepared_generation: string | null;
	/** `pending` | `staged` | `preparing` | `prepared` | `discarding` | `submitted`. */
	status: string;
	preparation_attempts: ColumnType<number, number | undefined, number>;
	last_preparation_error: string | null;
	next_preparation_at: ColumnType<
		Date | null,
		Date | string | null | undefined,
		Date | string | null
	>;
	created_at: Timestamp;
	/** Bounds every unsubmitted state; submitted rows are never swept. */
	expires_at: Timestamp;
	submitted_at: Timestamp | null;
}

/** One committed preview submission, keyed by the form-entry generation. */
export interface FormSubmissionIntentsTable {
	app_id: string;
	project_id: string;
	created_by: string;
	entry_key: string;
	form_uuid: Uuid;
	app_mutation_seq: BigIntColumn;
	request_digest: string;
	/** Null exists only inside the transaction while the envelope executes. */
	result: JSONColumnType<Record<string, unknown> | null, string | null, string>;
	created_at: Timestamp;
}

/** One bounded fixed-minute initiation counter per Project actor. */
export interface FormAttachmentRateLimitsTable {
	project_id: string;
	actor_user_id: string;
	window_started_at: Timestamp;
	attempt_count: number;
}

export interface AppDatabase {
	apps: AppsTable;
	blueprint_entities: BlueprintEntitiesTable;
	app_changes: AppChangesTable;
	app_change_fold_baselines: AppChangeFoldBaselinesTable;
	events: EventsTable;
	threads: ThreadsTable;
	chat_stream_chunks: ChatStreamChunksTable;
	run_summaries: RunSummariesTable;
	presence: PresenceTable;
	user_settings: UserSettingsTable;
	usage_months: UsageMonthsTable;
	credit_months: CreditMonthsTable;
	credit_grants: CreditGrantsTable;
	media_assets: MediaAssetsTable;
	media_asset_refs: MediaAssetRefsTable;
	media_upload_aliases: MediaUploadAliasesTable;
	form_attachments: FormAttachmentsTable;
	form_attachment_rate_limits: FormAttachmentRateLimitsTable;
	form_submission_intents: FormSubmissionIntentsTable;
	lookup_project_state: LookupProjectStateTable;
	lookup_tables: LookupTablesTable;
	lookup_columns: LookupColumnsTable;
	lookup_rows: LookupRowsTable;
	lookup_table_references: LookupTableReferencesTable;
	lookup_column_references: LookupColumnReferencesTable;
	app_organization_state: AppOrganizationStateTable;
	app_locations: AppLocationsTable;
	app_location_references: AppLocationReferencesTable;
	app_deployments: AppDeploymentsTable;
	app_deployment_resources: AppDeploymentResourcesTable;
	design_change_sets: DesignChangeSetsTable;
	design_change_set_requests: DesignChangeSetRequestsTable;
	design_change_set_steps: DesignChangeSetStepsTable;
	design_change_set_step_stages: DesignChangeSetStepStagesTable;
	design_change_set_handles: DesignChangeSetHandlesTable;
	design_committed_slices: DesignCommittedSlicesTable;
	app_change_intents: AppChangeIntentsTable;
	design_source_packages: DesignSourcePackagesTable;
	design_revisions: DesignRevisionsTable;
	design_reviews: DesignReviewsTable;
	design_review_dispositions: DesignReviewDispositionsTable;
	design_build_plans: DesignBuildPlansTable;
	design_sessions: DesignSessionsTable;
	design_orchestration_events: DesignOrchestrationEventsTable;
	design_slice_attempts: DesignSliceAttemptsTable;
	design_external_action_receipts: DesignExternalActionReceiptsTable;
	thread_media_refs: ThreadMediaRefsTable;
}

let injectedForTests: Kysely<AppDatabase> | null = null;

/**
 * Test-only seam: point `getAppDb` at a specific handle (a per-test Postgres
 * from the testcontainers harness). Pass `null` to clear.
 */
export function __setAppDbForTests(db: Kysely<AppDatabase> | null): void {
	injectedForTests = db;
}

let injectedPoolForTests: unknown = null;

/**
 * Test-only seam for the POOL behind `getAppPool`. Separate from the handle
 * above because a session advisory lock needs one checked-out connection it
 * can hold statements on, which a Kysely wrapper cannot hand back.
 */
export function __setAppPoolForTests(pool: unknown): void {
	injectedPoolForTests = pool;
}

/**
 * The pool app-state work runs on, for the rare caller that needs a
 * connection rather than a query interface — today only the session advisory
 * lock, which must hold one session across several transactions.
 */
export async function getAppPool(): Promise<
	Awaited<ReturnType<typeof getCaseStorePool>>
> {
	if (injectedPoolForTests !== null) {
		return injectedPoolForTests as Awaited<ReturnType<typeof getCaseStorePool>>;
	}
	return getCaseStorePool();
}

/**
 * The `Kysely<AppDatabase>` handle for app-state reads/writes, on the shared
 * pool. A fresh wrapper each call (cheap — no connection opens until a query);
 * the cached resource is the POOL, owned by `getCaseStorePool` — caching a
 * pool-derived handle here would survive `closeCaseStoreDatabase` and throw
 * "Cannot use a pool after calling end" on every later query.
 */
export async function getAppDb(): Promise<Kysely<AppDatabase>> {
	if (injectedForTests) return injectedForTests;
	const pool = await getCaseStorePool();
	return new Kysely<AppDatabase>({
		dialect: new PostgresDialect({ pool: pool as unknown as PostgresPool }),
	});
}

/** Postgres SQLSTATEs worth a bounded in-process retry: deadlock and
 * serialization failure. Everything else propagates on the first attempt. */
function isRetryableTxError(err: unknown): boolean {
	const code = (err as { code?: unknown })?.code;
	return code === "40P01" || code === "40001";
}

const TX_RETRY_DELAYS_MS = [50, 150, 400];

/**
 * Run `body` in a transaction with a bounded deadlock/serialization retry.
 * The body re-runs from scratch on a retry, so it must stay pure of external
 * side effects.
 * Domain rejections (`OutOfCreditsError`, commit-gate errors) are not
 * retryable SQLSTATEs, so they propagate on the first attempt.
 */
export async function withAppTx<T>(
	body: (tx: Transaction<AppDatabase>) => Promise<T>,
	options?: {
		readonly isolationLevel?: IsolationLevel;
		/** Absolute wall-clock deadline for this transaction. PostgreSQL 18's
		 * transaction timeout is the rollback authority; retry attempts consume
		 * the same deadline rather than receiving a fresh budget. */
		readonly deadlineAt?: number;
	},
): Promise<T> {
	const db = await getAppDb();
	for (let attempt = 0; ; attempt++) {
		try {
			const transaction = db.transaction();
			const executeBody = async (tx: Transaction<AppDatabase>): Promise<T> => {
				if (options?.deadlineAt !== undefined) {
					const remainingMs = Math.floor(options.deadlineAt - Date.now());
					if (remainingMs <= 0) {
						throw new Error(
							"The transaction deadline expired before it began.",
						);
					}
					await sql`SELECT set_config('transaction_timeout', ${`${remainingMs}ms`}, true)`.execute(
						tx,
					);
				}
				return body(tx);
			};
			return await (options?.isolationLevel === undefined
				? transaction
				: transaction.setIsolationLevel(options.isolationLevel)
			).execute(executeBody);
		} catch (err) {
			if (attempt === TX_RETRY_DELAYS_MS.length || !isRetryableTxError(err)) {
				throw err;
			}
			await delay(TX_RETRY_DELAYS_MS[attempt]);
		}
	}
}

// ── Realtime pokes ──────────────────────────────────────────────────
//
// LISTEN/NOTIFY carries only the POKE — `(appId, seq)` for a committed batch,
// `(appId)` for a presence change, `(projectId, revision)` for lookup
// invalidation. Payloads are capped at 8000 bytes by Postgres, so the data
// itself never rides the channel: relays SELECT authoritative rows on each
// poke. A NOTIFY issued inside a transaction is delivered only on commit,
// which is exactly the ordering the streams need.

/** One channel per poke kind, all consumed by the shared dedicated listener. */
export const APP_STREAM_CHANNEL = "nova_app_stream";
export const PRESENCE_CHANNEL = "nova_presence";
export const CHAT_STREAM_CHANNEL = "nova_chat_stream";
export const LOOKUP_STREAM_CHANNEL = "nova_lookup_stream";
export const ORGANIZATION_STREAM_CHANNEL = "nova_organization_stream";

/** Poke the stream channel from INSIDE the commit transaction. */
export async function notifyAppStream(
	tx: Transaction<AppDatabase>,
	appId: string,
	seq: number,
): Promise<void> {
	await sql`SELECT pg_notify(${APP_STREAM_CHANNEL}, ${JSON.stringify({ appId, seq })})`.execute(
		tx,
	);
}

/** Poke the stream channel's run-lifecycle-STATUS lane from INSIDE the
 * transaction that changes `apps.status`. Same channel as the mutation poke
 * (one LISTEN covers both), distinguished by the `statusChanged` marker so
 * the relay re-reads the app row instead of the mutation log. Today only
 * build completion sends it: that is the one transition that changes a
 * connected tab's pricing (`generating` → `complete` releases the client's
 * build-rate latch), and without it the release rides the relay's ~10 s
 * reauthorization cadence. The other transitions (`error`, a re-drive's
 * `generating`) move between build-priced states and stay on the cadence. */
export async function notifyAppStatus(
	tx: Transaction<AppDatabase>,
	appId: string,
): Promise<void> {
	await sql`SELECT pg_notify(${APP_STREAM_CHANNEL}, ${JSON.stringify({ appId, statusChanged: true })})`.execute(
		tx,
	);
}

/** Poke the stream channel's DEPLOYMENT lane from INSIDE the transaction
 * that writes a deployment record. Same channel as the mutation poke (one
 * LISTEN covers both), distinguished by the `deploymentChanged` marker so
 * the relay re-resolves what Preview may name for `commcare_project`
 * instead of re-reading the mutation log. This is how a co-member's open
 * tab learns a publish landed (or an observation walked a deployment back)
 * without a page load: the server-side identity resolvers always read the
 * table fresh, so the browser's copy is the one that needs the poke. */
export async function notifyAppDeployments(
	tx: Transaction<AppDatabase>,
	appId: string,
): Promise<void> {
	await sql`SELECT pg_notify(${APP_STREAM_CHANNEL}, ${JSON.stringify({ appId, deploymentChanged: true })})`.execute(
		tx,
	);
}

/** Poke lookup subscribers from INSIDE the mutation transaction. Revisions
 * stay strings so JSON never rounds a signed-int64 value. */
export async function notifyLookupProject(
	tx: Transaction<AppDatabase>,
	projectId: string,
	revision: string,
): Promise<void> {
	await sql`SELECT pg_notify(${LOOKUP_STREAM_CHANNEL}, ${JSON.stringify({ projectId, revision })})`.execute(
		tx,
	);
}

/** Poke organization subscribers after one app-scoped tree revision commits. */
export async function notifyAppOrganization(
	tx: Transaction<AppDatabase>,
	appId: string,
	revision: string,
): Promise<void> {
	await sql`SELECT pg_notify(${ORGANIZATION_STREAM_CHANNEL}, ${JSON.stringify({ appId, revision })})`.execute(
		tx,
	);
}

/** Poke presence subscribers from INSIDE the presence mutation transaction. */
export async function notifyPresence(
	tx: Transaction<AppDatabase>,
	appId: string,
): Promise<void> {
	await sql`SELECT pg_notify(${PRESENCE_CHANNEL}, ${JSON.stringify({ appId })})`.execute(
		tx,
	);
}

/** Poke a chat stream's tailers after a chunk-batch insert (plain connection —
 *  the append is a single INSERT, so there is no transaction to ride; issued
 *  after the insert resolves, so a tailer's re-SELECT sees the rows). */
export async function notifyChatStream(streamId: string): Promise<void> {
	const db = await getAppDb();
	await sql`SELECT pg_notify(${CHAT_STREAM_CHANNEL}, ${JSON.stringify({ streamId })})`.execute(
		db,
	);
}
