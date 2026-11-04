/**
 * The migration ledger in the case-writes cutover's window (step 5's part
 * 09, sections 6 and 11): its read, the marker count, the classifier that
 * decides whether the cutover already ran, and the savepointed migrator that
 * applies the window's three ledgered migrations inside the fleet
 * transaction, so the DDL commits with the fleet or rolls back with it.
 * Step 4's ledger (`scripts/lib/hqRoundTripPlatforms/ledger.ts` at
 * `a8af778e`) with one phase: no validation follows a backfill, so the three
 * apply together, after the blocking scan, the already-applied check and the
 * before-images, and before the first write.
 *
 * Under Kysely's own migration lock the pending set must be exactly the
 * three names this cutover was reviewed against, and the run must apply
 * exactly them, so nothing unreviewed is ever applied.
 */

import { type Kysely, sql, type Transaction } from "kysely";
import { type Migration, Migrator } from "kysely/migration";
import { caseStoreMigrations } from "@/lib/case-store/migrations";
import type { AppDatabase } from "@/lib/db/pg";
import {
	HORIZON_MIGRATION,
	MARKER_BATCH_ID,
	PENDING_MIGRATIONS,
	type StopCode,
} from "./types";

type LedgerReader = Kysely<AppDatabase> | Transaction<AppDatabase>;

// ─── The reads every mode makes first (section 6) ─────────────────────────

/** What the migration ledger holds, read before any write. */
export interface MigrationLedgerState {
	/** The ledger already holds the fold horizon migration. */
	readonly horizonApplied: boolean;
	/** Every migration of this tree the ledger does not hold, in code-point
	 *  order of name. */
	readonly pendingMigrations: readonly string[];
}

/** Read the `public.kysely_migration` ledger with one plain `SELECT`. A
 *  database the migrator never touched has no ledger and pends every
 *  migration. */
export async function readMigrationLedger(
	db: LedgerReader,
): Promise<MigrationLedgerState> {
	const exists = await sql<{ present: boolean }>`
		SELECT pg_catalog.to_regclass('public.kysely_migration') IS NOT NULL AS present
	`.execute(db);
	const applied = new Set<string>();
	if (exists.rows[0]?.present === true) {
		const rows = await sql<{ name: string }>`
			SELECT name FROM public.kysely_migration
		`.execute(db);
		for (const row of rows.rows) applied.add(row.name);
	}
	return {
		horizonApplied: applied.has(HORIZON_MIGRATION),
		pendingMigrations: Object.keys(caseStoreMigrations)
			.filter((name) => !applied.has(name))
			.sort(compareNames),
	};
}

/** How many apps the fleet holds, deleted ones included, and how many of
 *  them carry this cutover's fold-baseline marker. */
export interface MarkerCount {
	readonly apps: number;
	readonly marked: number;
}

/** Count the apps whose `public.app_changes` hold a row with this cutover's
 *  marker batch id, beside every app. */
export async function readMarkerCount(db: LedgerReader): Promise<MarkerCount> {
	const row = await sql<{ apps: string; marked: string }>`
		SELECT
			count(*)::text AS apps,
			count(*) FILTER (WHERE EXISTS (
				SELECT 1 FROM public.app_changes AS marker
				WHERE marker.app_id = app.id AND marker.batch_id = ${MARKER_BATCH_ID}
			))::text AS marked
		FROM public.apps AS app
	`.execute(db);
	return {
		apps: Number(row.rows[0]?.apps ?? "0"),
		marked: Number(row.rows[0]?.marked ?? "0"),
	};
}

/**
 * What the two reads decide: the horizon migration present and every app
 * marked is `already-applied`; neither present goes on; anything between is
 * `partially-applied`, which no committed run leaves, because the migration
 * and the markers commit together.
 */
export type AppliedState = "already-applied" | "partially-applied" | "go-on";

export function classifyApplied(
	ledger: Pick<MigrationLedgerState, "horizonApplied">,
	markers: MarkerCount,
): AppliedState {
	if (ledger.horizonApplied) {
		return markers.marked === markers.apps
			? "already-applied"
			: "partially-applied";
	}
	return markers.marked === 0 ? "go-on" : "partially-applied";
}

/** A ledger and markers no committed run of this cutover leaves. */
export class CutoverPartiallyAppliedError extends Error {
	readonly name = "CutoverPartiallyAppliedError";
	readonly code = "partially-applied" satisfies StopCode;
}

/** The refusal of the `partially-applied` state, with its counts. */
export function partiallyApplied(
	ledger: Pick<MigrationLedgerState, "horizonApplied">,
	markers: MarkerCount,
): CutoverPartiallyAppliedError {
	return new CutoverPartiallyAppliedError(
		`${markers.marked} of ${markers.apps} apps carry the hq-round-trip-case-writes horizon, and the migration ledger ${ledger.horizonApplied ? "holds" : "does not hold"} ${HORIZON_MIGRATION}. No committed run of this cutover leaves that state, because the migration and the markers commit together, so it stopped without reading the fleet. Find out how the ledger or the markers moved, such as a database migrated by this branch's code, and restore the database from the window's restore point before running again.`,
	);
}

// ─── The ledger in the fleet transaction (section 11) ─────────────────────

/** What a ledger failure may say of itself: names and codes, never a text. */
export interface LedgerFailure {
	readonly migrationName?: string;
	readonly failureClass?: string;
	readonly sqlState?: string;
}

/**
 * The migration ledger was not the one this cutover was reviewed against, or
 * the ledgered DDL failed inside the transaction: either way the fleet rolled
 * back with nothing written and no migration applied. The `ledger` stop.
 */
export class CutoverLedgerError extends Error {
	readonly name = "CutoverLedgerError";
	readonly code = "ledger" satisfies StopCode;

	constructor(
		message: string,
		readonly failure: LedgerFailure = {},
		options?: ErrorOptions,
	) {
		super(message, options);
	}
}

/** Another run held the cutover's lock, or Kysely's migration lock, past the
 *  lock timeout. The `lock-timeout` stop. */
export class CutoverLockTimeoutError extends Error {
	readonly name = "CutoverLockTimeoutError";
	readonly code = "lock-timeout" satisfies StopCode;
}

/** Postgres's SQLSTATE for a lock wait that reached `lock_timeout`. */
export const LOCK_NOT_AVAILABLE = "55P03";

/**
 * Kysely's own migration lock key: `LOCK_ID` in
 * `node_modules/kysely/dist/dialect/postgres/postgres-adapter.js`.
 */
const KYSELY_MIGRATION_LOCK_ID = "3853314791062309107";

/** Code-point order, so nothing depends on the database's collation. */
function compareNames(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

export function namesText(names: readonly string[]): string {
	return names.length === 0 ? "none" : names.join(", ");
}

function sameNames(a: readonly string[], b: readonly string[]): boolean {
	return a.length === b.length && a.every((name, index) => name === b[index]);
}

/** The refusal of a ledger that is not the reviewed one, before anything is
 *  applied (section 11's sentence). */
export function unexpectedLedger(
	expected: readonly string[],
	found: readonly string[],
): CutoverLedgerError {
	return new CutoverLedgerError(
		`The migration ledger is not the one this cutover was reviewed against: it expected exactly ${namesText(expected)} to be pending and found ${namesText(found)}. The cutover stopped with nothing written and no migration applied. Compare a dry run's ledger line with main's migrations, and find out how the ledger moved before running again.`,
	);
}

/** Whether the ledger pends exactly the window's three, as the run requires. */
export function ledgerIsReviewed(ledger: MigrationLedgerState): boolean {
	return sameNames(ledger.pendingMigrations, PENDING_MIGRATIONS);
}

function isSqlState(code: unknown): code is string {
	if (typeof code !== "string" || code.length !== 5) return false;
	for (const character of code) {
		const digit = character >= "0" && character <= "9";
		const upper = character >= "A" && character <= "Z";
		if (!digit && !upper) return false;
	}
	return true;
}

function ledgerFailureOf(
	migrationName: string | undefined,
	error: unknown,
): LedgerFailure {
	const code = (error as { code?: unknown } | null)?.code;
	return {
		...(migrationName === undefined ? {} : { migrationName }),
		failureClass:
			error instanceof Error ? error.constructor.name : typeof error,
		...(isSqlState(code) ? { sqlState: code } : {}),
	};
}

/**
 * Apply the window's three migrations through `target`, the fold horizon, on
 * the fleet transaction. The ledger must pend exactly the three, and the run
 * must apply exactly them; any other ledger throws the `ledger` stop.
 *
 * Kysely's lock is taken first as a transaction lock under the cutover's own
 * 15-second timeout: its adapter would otherwise wait up to an hour for it,
 * holding every row lock, and it sets that hour as the transaction's
 * `lock_timeout`, so the cutover's is set again after the run. Kysely
 * releases its session lock in a `finally` that cannot run in an aborted
 * transaction, so each migration runs in its own savepoint, rolled back when
 * it throws so the release runs, and the whole run in an outer one; on any
 * failure the outer one is rolled back and every session-level advisory lock
 * released.
 */
export async function applyLedgerTo(
	tx: Transaction<AppDatabase>,
	target: typeof HORIZON_MIGRATION,
): Promise<readonly string[]> {
	try {
		await sql`SELECT pg_catalog.pg_advisory_xact_lock(${KYSELY_MIGRATION_LOCK_ID}::bigint)`.execute(
			tx,
		);
	} catch (error) {
		if ((error as { code?: unknown } | null)?.code === LOCK_NOT_AVAILABLE) {
			throw new CutoverLockTimeoutError(
				"Another migration run held the database's migration lock for 15 seconds, so this run stopped with nothing written. Let that run finish, such as a deploy's migrate Job, then run again.",
				{ cause: error },
			);
		}
		throw error;
	}
	const ledger = await readMigrationLedger(tx);
	if (!ledgerIsReviewed(ledger)) {
		throw unexpectedLedger(PENDING_MIGRATIONS, ledger.pendingMigrations);
	}
	const thrown: { name: string; error: unknown }[] = [];
	const migrations: Record<string, Migration> = Object.fromEntries(
		Object.entries(caseStoreMigrations).map(([name, migration]) => [
			name,
			{
				up: async (db) => {
					await sql`SAVEPOINT cutover_ledger_migration`.execute(db);
					await sql`SET LOCAL lock_timeout = '15s'`.execute(db);
					try {
						await migration.up(db);
					} catch (error) {
						thrown.push({ name, error });
						await sql`ROLLBACK TO SAVEPOINT cutover_ledger_migration`.execute(
							db,
						);
						throw error;
					}
					await sql`RELEASE SAVEPOINT cutover_ledger_migration`.execute(db);
				},
			} satisfies Migration,
		]),
	);
	await sql`SAVEPOINT cutover_ledger`.execute(tx);
	const { error, results } = await new Migrator({
		db: tx as unknown as Kysely<unknown>,
		provider: { getMigrations: async () => migrations },
	}).migrateTo(target);
	const errored = results?.find((result) => result.status === "Error");
	const [failed] = thrown;
	if (error !== undefined || errored !== undefined) {
		await sql`ROLLBACK TO SAVEPOINT cutover_ledger`.execute(tx);
		await sql`SELECT pg_catalog.pg_advisory_unlock_all()`.execute(tx);
		const failure = ledgerFailureOf(
			failed?.name ?? errored?.migrationName,
			failed?.error ?? error,
		);
		throw new CutoverLedgerError(
			`${failure.migrationName === undefined ? "The migrator" : `The ledgered migration ${failure.migrationName}`} failed inside the fleet transaction with an error of class ${failure.failureClass ?? "unknown"}${failure.sqlState === undefined ? "" : ` (SQLSTATE ${failure.sqlState})`}, so the whole fleet rolled back with nothing written, the migration included. Its text is not printed, because a database error can quote stored content; reproduce it against a restored copy of the database to read it.`,
			failure,
			{ cause: failed?.error ?? error },
		);
	}
	await sql`RELEASE SAVEPOINT cutover_ledger`.execute(tx);
	const applied = (results ?? [])
		.filter((result) => result.status === "Success")
		.map((result) => result.migrationName);
	if (!sameNames(applied, PENDING_MIGRATIONS)) {
		throw new CutoverLedgerError(
			`The migrator applied ${namesText(applied)} where this cutover was reviewed to apply exactly ${namesText(PENDING_MIGRATIONS)}, so the whole fleet rolled back with nothing written, the migrations included.`,
		);
	}
	await sql`SET LOCAL lock_timeout = '15s'`.execute(tx);
	return applied;
}
