// Kysely typing + handle for the app-state tables (`apps`,
// `blueprint_entities`, `accepted_mutations`, `events`, `threads`,
// `run_summaries`, `presence`, `user_settings`, the two monthly ledgers, and
// media assets) — the storage layer behind every `lib/db` module. DDL lives in
// `lib/case-store/migrations/20260708000000_app_state.ts`; the two must move
// in lockstep.
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
/** `bigint` columns come back from pg as strings; every reader `Number(...)`s. */
type BigIntColumn = ColumnType<string | number, number, number>;

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

export interface ThreadsTable {
	app_id: string;
	thread_id: string;
	created_at: string;
	thread_type: string;
	summary: string;
	run_id: string;
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
	fresh_edit: boolean;
	app_ready: boolean;
	cache_expired: boolean;
	module_count: number;
	step_count: number;
	model: string;
	input_tokens: BigIntColumn;
	output_tokens: BigIntColumn;
	cache_read_tokens: BigIntColumn;
	cache_write_tokens: BigIntColumn;
	cost_estimate: number;
	actual_cost: number;
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
	actual_cost: number;
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
// `(appId)` for a presence change. Payloads are capped at 8000 bytes by
// Postgres, so the data itself never rides the channel: the relay SELECTs
// rows since its cursor on each poke. A NOTIFY issued inside a transaction is
// delivered only on commit, which is exactly the ordering the stream needs.

/** One channel for committed mutation batches, one for presence churn, one
 *  for chat-stream chunk flushes. */
export const APP_STREAM_CHANNEL = "nova_app_stream";
export const PRESENCE_CHANNEL = "nova_presence";
export const CHAT_STREAM_CHANNEL = "nova_chat_stream";

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

/** Poke the presence channel (plain connection — presence writes aren't transactional). */
export async function notifyPresence(appId: string): Promise<void> {
	const db = await getAppDb();
	await sql`SELECT pg_notify(${PRESENCE_CHANNEL}, ${JSON.stringify({ appId })})`.execute(
		db,
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
