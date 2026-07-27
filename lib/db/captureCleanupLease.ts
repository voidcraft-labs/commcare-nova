import "server-only";

import type { Pool, PoolClient } from "pg";
import { getCaseStorePool } from "@/lib/case-store/postgres/connection";

/**
 * Session-level advisory lock for the one global capture-cleanup worker.
 *
 * Cloud Scheduler delivery is at-least-once. The active worker
 * holds this lock on one checked-out pool connection for its whole run. Before
 * it reserves the work connection, a loser observes `false`, destroys its
 * session, and exits without touching maintenance rows.
 */
const CAPTURE_CLEANUP_ADVISORY_LOCK = "nova:capture-cleanup:v1";

export const CAPTURE_CLEANUP_WORK_CONNECTION_TIMEOUT_MS = 10_000;
export const CAPTURE_CLEANUP_WORK_CONNECTION_RETRY_MS = 100;

export type ExclusiveCaptureCleanupResult<T> =
	| { readonly kind: "ran"; readonly value: T }
	| { readonly kind: "already-running" }
	| { readonly kind: "saturated" };

export interface ExclusiveCaptureCleanupOptions {
	readonly workConnectionTimeoutMs?: number;
	readonly workConnectionRetryMs?: number;
	readonly now?: () => number;
	readonly sleep?: (milliseconds: number) => Promise<void>;
}

function asError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}

/** PostgreSQL SQLSTATE `53300` covers max_connections and role connection
 * limits. It is an expected no-op only before this process owns the lock. */
export function isDatabaseConnectionSaturatedError(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		(error as { readonly code?: unknown }).code === "53300"
	);
}

function defaultSleep(milliseconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/**
 * Once this process owns the advisory lock, ensure its pool already holds the
 * second physical connection maintenance needs. With cleanup CONNECTION LIMIT
 * 3, two losing probes can briefly fill the role before they observe the lock
 * and close. Retry only that admission race; a bounded failure is fatal.
 */
async function prewarmCaptureCleanupWorkConnection(
	pool: Pool,
	options: ExclusiveCaptureCleanupOptions,
): Promise<void> {
	const timeoutMs =
		options.workConnectionTimeoutMs ??
		CAPTURE_CLEANUP_WORK_CONNECTION_TIMEOUT_MS;
	const retryMs =
		options.workConnectionRetryMs ?? CAPTURE_CLEANUP_WORK_CONNECTION_RETRY_MS;
	const now = options.now ?? Date.now;
	const sleep = options.sleep ?? defaultSleep;
	const deadline = now() + timeoutMs;

	for (;;) {
		try {
			const workClient = await pool.connect();
			// Return the admitted physical session to this SAME pool. The next
			// Kysely query reuses it instead of racing for a fourth role session.
			workClient.release();
			return;
		} catch (error) {
			if (!isDatabaseConnectionSaturatedError(error)) throw error;
			if (now() >= deadline) {
				throw Object.assign(
					new Error(
						`Capture cleanup owned the advisory lock but could not reserve its work connection within ${timeoutMs}ms.`,
						{ cause: asError(error) },
					),
					{ code: "53300" },
				);
			}
			await sleep(retryMs);
		}
	}
}

export async function withExclusiveCaptureCleanupWorker<T>(
	maintenance: () => Promise<T>,
	options: ExclusiveCaptureCleanupOptions = {},
): Promise<ExclusiveCaptureCleanupResult<T>> {
	let pool: Pool;
	pool = await getCaseStorePool();
	let client: PoolClient;
	try {
		client = await pool.connect();
	} catch (error) {
		if (isDatabaseConnectionSaturatedError(error)) {
			return { kind: "saturated" };
		}
		throw error;
	}

	try {
		const lock = await client.query<{ acquired: boolean }>(
			`SELECT pg_try_advisory_lock(
				hashtextextended($1::text, 0::bigint)
			) AS acquired`,
			[CAPTURE_CLEANUP_ADVISORY_LOCK],
		);
		if (lock.rows[0]?.acquired !== true) {
			client.release(true);
			return { kind: "already-running" };
		}
	} catch (error) {
		client.release(asError(error));
		throw error;
	}

	let outcome:
		| { readonly ok: true; readonly value: T }
		| { readonly ok: false; readonly error: unknown };
	try {
		await prewarmCaptureCleanupWorkConnection(pool, options);
		outcome = { ok: true, value: await maintenance() };
	} catch (error) {
		outcome = { ok: false, error };
	}

	let unlockError: Error | undefined;
	try {
		const unlock = await client.query<{ unlocked: boolean }>(
			`SELECT pg_advisory_unlock(
				hashtextextended($1::text, 0::bigint)
			) AS unlocked`,
			[CAPTURE_CLEANUP_ADVISORY_LOCK],
		);
		if (unlock.rows[0]?.unlocked !== true) {
			unlockError = new Error(
				"Capture cleanup advisory lock was not held by its owner session.",
			);
		}
	} catch (error) {
		unlockError = asError(error);
	}

	if (unlockError !== undefined) {
		// A session whose unlock failed must not return to the pool: the
		// session-level lock may still be attached to it indefinitely.
		client.release(unlockError);
		if (!outcome.ok) {
			throw new AggregateError(
				[outcome.error, unlockError],
				"Capture cleanup failed and its advisory lock could not be released.",
			);
		}
		throw unlockError;
	}

	client.release();
	if (!outcome.ok) {
		throw outcome.error;
	}
	return { kind: "ran", value: outcome.value };
}
