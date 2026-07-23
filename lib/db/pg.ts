// Kysely typing + handle for the app-state tables (`apps`,
// `blueprint_entities`, `accepted_mutations`, `events`, `threads`,
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
	type JSONColumnType,
	Kysely,
	PostgresDialect,
	type PostgresPool,
	sql,
	type Transaction,
} from "kysely";
import { getCaseStorePool } from "@/lib/case-store/postgres/connection";
import type { Mutation } from "@/lib/doc/types";
import type { CaseType, ConnectType } from "@/lib/domain";
import type { Location } from "@/lib/routing/types";
import { delay } from "@/lib/utils/delay";

/** Server-set timestamp: read as `Date`, write as `Date`/ISO, omit when defaulted. */
type Timestamp = ColumnType<Date, Date | string | undefined, Date | string>;
/** Caller-required timestamp: unlike `Timestamp`, INSERT has no undefined arm. */
type RequiredTimestamp = ColumnType<Date, Date | string, Date | string>;
/** Legacy `bigint` counters whose bounded readers intentionally `Number(...)`. */
type BigIntColumn = ColumnType<string | number, number, number>;
/** Lookup revisions stay exact decimal strings on every application boundary. */
type LookupRevisionColumn = ColumnType<string, string, string>;
/** Exact lookup revision with a database default, so INSERT may omit it. */
type DefaultedLookupRevisionColumn = ColumnType<
	string,
	string | undefined,
	string
>;
/** Server-defaulted UUIDv7 identity: optional on INSERT, immutable on UPDATE. */
type DefaultedUuidV7Column = ColumnType<string, string | undefined, never>;
/** Server-only UUIDv7 default: callers may omit it but cannot supply identity. */
type ServerDefaultedUuidV7Column = ColumnType<string, undefined, never>;

export interface AppsTable {
	id: string;
	owner: string;
	project_id: string | null;
	app_name: string;
	app_name_lower: string;
	connect_type: ConnectType | null;
	case_types: JSONColumnType<CaseType[] | null, string | null, string | null>;
	logo: string | null;
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
	/** Database-stamped capability of the exact currently-present run holder. */
	run_runtime_reader_version: ColumnType<number | null, undefined, never>;
	created_at: Timestamp;
	updated_at: Timestamp;
}

export interface BlueprintEntitiesTable {
	app_id: string;
	uuid: string;
	kind: "module" | "form" | "field";
	parent_uuid: string | null;
	/** Index within the parent's membership array at write time — the arrays
	 *  round-trip byte-identically (display sequence is still derived from the
	 *  entities' fractional `order` keys, exactly as before; this preserves the
	 *  array itself, including position-seeded backfill inputs). */
	ordinal: number;
	// The entity record verbatim (a `Module` / `Form` / `Field`); typed loosely
	// here because the three kinds share one table — the assembler Zod-parses
	// the assembled doc at the boundary, not per row.
	data: JSONColumnType<Record<string, unknown>>;
}

export interface AcceptedMutationsTable {
	app_id: string;
	seq: BigIntColumn;
	batch_id: string;
	run_id: string | null;
	actor_id: string;
	kind: string;
	mutations: JSONColumnType<Mutation[]>;
	ts: Timestamp;
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
	app_id: string;
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
	app_id: string;
	run_id: string;
	chunks: JSONColumnType<Record<string, unknown>[]>;
	terminal: boolean;
	created_at: Timestamp;
}

export interface RunSummariesTable {
	app_id: string;
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
	id: string;
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
	asset_id: string;
	app_id: string;
}

export interface MediaReferenceIndexStateTable {
	singleton: boolean;
	audited_complete_at: ColumnType<Date | null, Date | null, Date | null>;
}

export interface LookupProjectStateTable {
	project_id: string;
	/** Project-wide invalidation clock; never coerce to a JavaScript number. */
	revision: DefaultedLookupRevisionColumn;
	updated_at: Timestamp;
}

export interface LookupTablesTable {
	project_id: string;
	id: DefaultedUuidV7Column;
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
	table_id: string;
	id: DefaultedUuidV7Column;
	wire_name: string;
	label: string;
	data_type: StoredLookupColumnDataType;
	order_key: string;
}

export interface LookupRowsTable {
	project_id: string;
	table_id: string;
	id: DefaultedUuidV7Column;
	order_key: string;
	/** UUID-keyed scalar cells; runtime validation owns the per-column shape. */
	values: JSONColumnType<Record<string, string | number>>;
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
	table_id: string;
	app_id: string;
}

/** One exact app -> lookup-column target; its parent table edge must also exist. */
export interface LookupColumnReferencesTable {
	project_id: string;
	table_id: string;
	column_id: string;
	app_id: string;
}

/**
 * A live builder stream's receiver-version lease. `connection_id` is minted by
 * the server/database, never accepted as client identity.
 */
export interface LookupStreamCapabilityLeasesTable {
	app_id: string;
	connection_id: ServerDefaultedUuidV7Column;
	receiver_version: number;
	expires_at: RequiredTimestamp;
	created_at: Timestamp;
}

/**
 * The one persistent compatibility row. Floors only increase; ordinary feature
 * flags may turn back off for emergency response without lowering a floor. The
 * run-holder nonce switch is a protocol cutover and is irreversible once true.
 */
export interface LookupReferenceCompatibilityTable {
	id: ColumnType<1, 1 | undefined, never>;
	minimum_writer_version: ColumnType<number, number | undefined, number>;
	minimum_stream_receiver_version: ColumnType<
		number,
		number | undefined,
		number
	>;
	minimum_runtime_reader_version: ColumnType<
		number,
		number | undefined,
		number
	>;
	continuous_registry_traffic_since: ColumnType<
		Date | null,
		Date | string | null | undefined,
		Date | string | null
	>;
	run_holder_nonce_enforced: ColumnType<boolean, boolean | undefined, boolean>;
	carrier_commits_enabled: ColumnType<boolean, boolean | undefined, boolean>;
	destructive_schema_actions_enabled: ColumnType<
		boolean,
		boolean | undefined,
		boolean
	>;
	project_moves_enabled: ColumnType<boolean, boolean | undefined, boolean>;
	updated_at: Timestamp;
}

/** One explicitly prepared uninterrupted traffic epoch per runtime target. */
export interface RuntimeReaderTrafficEpochsTable {
	target_version: number;
	continuous_traffic_since: ColumnType<Date, undefined, never>;
}

export interface AppDatabase {
	apps: AppsTable;
	blueprint_entities: BlueprintEntitiesTable;
	accepted_mutations: AcceptedMutationsTable;
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
	media_reference_index_state: MediaReferenceIndexStateTable;
	lookup_project_state: LookupProjectStateTable;
	lookup_tables: LookupTablesTable;
	lookup_columns: LookupColumnsTable;
	lookup_rows: LookupRowsTable;
	lookup_table_references: LookupTableReferencesTable;
	lookup_column_references: LookupColumnReferencesTable;
	lookup_stream_capability_leases: LookupStreamCapabilityLeasesTable;
	lookup_reference_compatibility: LookupReferenceCompatibilityTable;
	runtime_reader_traffic_epochs: RuntimeReaderTrafficEpochsTable;
}

/**
 * The custom Postgres setting read by the database writer-version guards.
 * Keep this literal in lockstep with the immutable migration that creates the
 * guards; migrations must not import mutable runtime constants.
 */
export const WRITER_VERSION_GUC = "nova.writer_version";

/** Transaction-local declaration consumed by the run-holder stamp trigger. */
export const RUNTIME_READER_VERSION_GUC = "nova.runtime_reader_version";

/**
 * Declare this code's compatibility version for the CURRENT transaction.
 * `set_config(..., true)` is PostgreSQL's parameterized `SET LOCAL`: the value
 * resets on commit/rollback and cannot leak through the shared connection pool.
 */
export async function setTransactionWriterVersion(
	tx: Transaction<AppDatabase>,
	version: number,
): Promise<void> {
	if (
		!Number.isSafeInteger(version) ||
		version < 0 ||
		version > 2_147_483_647
	) {
		throw new RangeError("writer version must be a nonnegative int4");
	}
	await sql`SELECT set_config(${WRITER_VERSION_GUC}, ${String(version)}, true)`.execute(
		tx,
	);
}

/**
 * Declare this code's runtime-reader compatibility for the CURRENT transaction
 * before every holder-touching DML, including same-holder heartbeats and
 * terminal writes. Absence is the deployed-v0 signal. A declared v1 holder
 * must carry the server-minted nonce; an unchanged declared generation
 * preserves its original stamp rather than restamping it.
 */
export async function setTransactionRuntimeReaderVersion(
	tx: Transaction<AppDatabase>,
	version: number,
): Promise<void> {
	if (
		!Number.isSafeInteger(version) ||
		version < 0 ||
		version > 2_147_483_647
	) {
		throw new RangeError("runtime reader version must be a nonnegative int4");
	}
	await sql`
		SELECT set_config(
			${RUNTIME_READER_VERSION_GUC},
			${String(version)},
			true
		)
	`.execute(tx);
}

let injectedForTests: Kysely<AppDatabase> | null = null;

/**
 * Test-only seam: point `getAppDb` at a specific handle (a per-test Postgres
 * from the testcontainers harness). Pass `null` to clear.
 */
export function __setAppDbForTests(db: Kysely<AppDatabase> | null): void {
	injectedForTests = db;
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
): Promise<T> {
	const db = await getAppDb();
	for (let attempt = 0; ; attempt++) {
		try {
			return await db.transaction().execute(body);
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
