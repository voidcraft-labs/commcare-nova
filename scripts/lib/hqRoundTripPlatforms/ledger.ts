/**
 * The migration ledger in the platforms cutover's window (part 09 §8): its
 * read, the one marker that the cutover already ran, and the two-phase
 * savepointed migrator that applies step 4's five ledgered migrations inside
 * the fleet transaction, so the DDL commits with the fleet or rolls back with
 * it.
 *
 * Phase 1 applies the column drop, the confirmation kind, the format column
 * and the capture size check, before the backfill; phase 2 applies the
 * format check's validation, after it. Under Kysely's own migration lock the
 * pending set must be exactly what each phase was reviewed to apply, so
 * nothing unreviewed is ever applied.
 */

import { type Kysely, sql, type Transaction } from "kysely";
import { type Migration, Migrator } from "kysely/migration";
import { caseStoreMigrations } from "@/lib/case-store/migrations";
import type { AppDatabase } from "@/lib/db/pg";

/** Step 4's five ledgered migrations, in the order they apply. */
export const STACK_MIGRATIONS = [
	"20261101000000_hq_round_trip_platforms_web_apps_read",
	"20261101010000_hq_round_trip_platforms_form_entry_sync",
	"20261101020000_hq_round_trip_platforms_media_format",
	"20261101025000_hq_round_trip_platforms_android_capture_size",
	"20261101030000_hq_round_trip_platforms_media_format_validated",
] as const;

/** The validation migration: applied only inside the fleet transaction, so its presence is the cutover's one marker. */
export const VALIDATED_MIGRATION = STACK_MIGRATIONS[4];

/** Phase 1's target: the first four. */
export const PHASE_ONE_TARGET = STACK_MIGRATIONS[3];

/** What the migration ledger holds, read before any write. */
export interface MigrationLedgerState {
	/** The ledger already holds the validation migration. */
	readonly validatedApplied: boolean;
	/** Every migration of this tree the ledger does not hold, by name. */
	readonly pendingMigrations: readonly string[];
}

/** Read the `kysely_migration` ledger with one plain `SELECT`. */
export async function readMigrationLedger(
	db: Kysely<AppDatabase> | Transaction<AppDatabase>,
): Promise<MigrationLedgerState> {
	const exists = await sql<{ present: boolean }>`
		SELECT to_regclass('public.kysely_migration') IS NOT NULL AS present
	`.execute(db);
	const applied = new Set<string>();
	if (exists.rows[0]?.present === true) {
		const rows = await sql<{ name: string }>`
			SELECT name FROM kysely_migration
		`.execute(db);
		for (const row of rows.rows) applied.add(row.name);
	}
	return {
		validatedApplied: applied.has(VALIDATED_MIGRATION),
		pendingMigrations: Object.keys(caseStoreMigrations)
			.filter((name) => !applied.has(name))
			.sort(),
	};
}

/** What a ledger failure may say of itself: names and codes, never a text. */
export interface LedgerFailure {
	readonly migrationName?: string;
	readonly failureClass?: string;
	readonly sqlState?: string;
}

/**
 * The migration ledger was not the one this cutover was reviewed against, or
 * the ledgered DDL failed inside the transaction: either way the fleet rolled
 * back with nothing written and no migration applied.
 */
export class CutoverLedgerError extends Error {
	readonly name = "CutoverLedgerError";

	constructor(
		message: string,
		readonly failure: LedgerFailure = {},
		options?: ErrorOptions,
	) {
		super(message, options);
	}
}

/** Another run held the cutover's lock, or Kysely's migration lock, past the lock timeout. */
export class CutoverLockTimeoutError extends Error {
	readonly name = "CutoverLockTimeoutError";
}

/** Postgres's SQLSTATE for a lock wait that reached `lock_timeout`. */
export const LOCK_NOT_AVAILABLE = "55P03";

/**
 * Kysely's own migration lock key: `LOCK_ID` in
 * `node_modules/kysely/dist/dialect/postgres/postgres-adapter.js`.
 */
const KYSELY_MIGRATION_LOCK_ID = "3853314791062309107";

export function namesText(names: readonly string[]): string {
	return names.length === 0 ? "none" : names.join(", ");
}

function sameNames(a: readonly string[], b: readonly string[]): boolean {
	return a.length === b.length && a.every((name, index) => name === b[index]);
}

/** The refusal of a ledger that is not the reviewed one, before anything is applied. */
export function unexpectedLedger(
	expected: readonly string[],
	found: readonly string[],
): CutoverLedgerError {
	return new CutoverLedgerError(
		`The migration ledger is not the one this cutover was reviewed against: it expected exactly ${namesText(expected)} to be pending and found ${namesText(found)}. The cutover stopped with nothing written and no migration applied. Compare a dry run's ledger line with main's migrations, and find out how the ledger moved before running again.`,
	);
}

/** Whether the ledger holds exactly the five pending, as the window requires. */
export function ledgerIsReviewed(ledger: MigrationLedgerState): boolean {
	return sameNames(ledger.pendingMigrations, STACK_MIGRATIONS);
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
		...(typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)
			? { sqlState: code }
			: {}),
	};
}

/**
 * Apply the stack's migrations through `target` on the fleet transaction,
 * where the ledger must pend exactly `expectedPending` and the run must apply
 * exactly `expectedApplied`. Step 3's `applyLedger` with a target.
 *
 * Kysely's lock is taken first as a transaction lock under the cutover's own
 * 15-second timeout: its adapter would otherwise wait up to an hour for it,
 * holding every row lock. Kysely releases its session lock in a `finally`
 * that cannot run in an aborted transaction, so each migration runs in its
 * own savepoint, rolled back when it throws so the release runs, and the
 * whole run in an outer one; on any failure the outer one is rolled back and
 * every session-level advisory lock released.
 */
export async function applyLedgerTo(
	tx: Transaction<AppDatabase>,
	target: string,
	expected: {
		readonly pending: readonly string[];
		readonly applied: readonly string[];
	},
): Promise<readonly string[]> {
	try {
		await sql`SELECT pg_advisory_xact_lock(${KYSELY_MIGRATION_LOCK_ID}::bigint)`.execute(
			tx,
		);
	} catch (error) {
		if ((error as { code?: unknown })?.code === LOCK_NOT_AVAILABLE) {
			throw new CutoverLockTimeoutError(
				"Another migration run held the database's migration lock for 15 seconds, so this run stopped with nothing written. Let that run finish, such as a deploy's migrate Job, then run again.",
				{ cause: error },
			);
		}
		throw error;
	}
	const ledger = await readMigrationLedger(tx);
	if (!sameNames(ledger.pendingMigrations, expected.pending)) {
		throw unexpectedLedger(expected.pending, ledger.pendingMigrations);
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
		await sql`SELECT pg_advisory_unlock_all()`.execute(tx);
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
	if (!sameNames(applied, expected.applied)) {
		throw new CutoverLedgerError(
			`The migrator applied ${namesText(applied)} where this cutover was reviewed to apply exactly ${namesText(expected.applied)}, so the whole fleet rolled back with nothing written, the migrations included.`,
		);
	}
	await sql`SET LOCAL lock_timeout = '15s'`.execute(tx);
	return applied;
}
