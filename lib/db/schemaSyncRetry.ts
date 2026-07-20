/**
 * Bounded transient-retry for a single `applySchemaChange` call — shared by the
 * two additive schema-sync sites: the chat-completion `materializeCaseStoreSchemas`
 * and `applyBlueprintChange`'s post-commit sweep.
 *
 * Both sites are additive (idempotent UPSERT + index diff, no per-row
 * migration) and both SWALLOW their terminal failure (log + move on) rather
 * than failing the surrounding run — the point-of-use `withSchemaHeal` is the
 * final backstop. This retry SHRINKS the window the heal has to cover: a ~200ms
 * Cloud SQL blip that would otherwise leave `case_type_schemas` unsynced (and
 * make the heal's own first attempt hit the same blip and re-throw
 * `SchemaNotSyncedError` on a "completed" build) is absorbed here. A
 * deterministic fault (e.g. an identifier collision) is NOT retried — it would
 * fail identically, so it surfaces on the first attempt for the caller to
 * swallow without burning the backoff budget.
 */

import { delay } from "@/lib/utils/delay";

/**
 * Bounded retry budget for one per-case-type sync, applied ONLY to transient
 * failures. The underlying `applySchemaChange` is an idempotent UPSERT + index
 * diff, so retrying turns most transient blips into a successful sync.
 */
const PER_TYPE_SYNC_ATTEMPTS = 3;
const RETRY_BACKOFF_MS = 150;

/**
 * SQLSTATE / Node errno codes that mark a TRANSIENT Postgres / connection
 * failure worth retrying. Postgres query errors carry a SQLSTATE on
 * `error.code`; connector / socket failures carry a Node errno string. A
 * deterministic application fault (e.g. an identifier-collision throw) is a
 * plain `Error` with no `code`, so it falls through as non-transient.
 *
 * Conservative by design: an unrecognized transient error simply isn't retried
 * (the point-of-use heal is still the backstop), whereas retrying a
 * deterministic fault would waste the whole backoff budget. Widen only for
 * codes known to be transient.
 */
const TRANSIENT_DB_ERROR_CODES: ReadonlySet<string> = new Set([
	// Node socket errnos — connector / network blips.
	"ECONNREFUSED",
	"ECONNRESET",
	"ETIMEDOUT",
	"EPIPE",
	"ENOTFOUND",
	"EAI_AGAIN",
	// SQLSTATE class 08 — connection exception.
	"08000",
	"08001",
	"08003",
	"08004",
	"08006",
	"08007",
	"08P01",
	// 57Pxx — server shutting down / not yet accepting connections.
	"57P01",
	"57P02",
	"57P03",
	// Concurrency faults — safe to retry an idempotent UPSERT.
	"40001",
	"40P01",
]);

/**
 * Whether `error` (or its wrapped `cause`) is a transient Postgres / connection
 * fault worth retrying. The pg driver / Cloud SQL connector surface the
 * SQLSTATE or socket errno on `.code`; a wrapped blip carries it on
 * `.cause.code` one level down. We unwrap a single level — deeper nesting is
 * rare and the point-of-use heal is the backstop regardless.
 */
export function isTransientDbError(error: unknown): boolean {
	const layers = [
		error,
		(error as { cause?: unknown } | null | undefined)?.cause,
	];
	for (const layer of layers) {
		const code = (layer as { code?: unknown } | null | undefined)?.code;
		if (typeof code === "string" && TRANSIENT_DB_ERROR_CODES.has(code)) {
			return true;
		}
	}
	return false;
}

/**
 * Run `attempt`, retrying only TRANSIENT failures up to `PER_TYPE_SYNC_ATTEMPTS`.
 * A non-transient (deterministic) error rethrows immediately on the first
 * attempt — no wasted backoff — so the caller reaches its swallow without
 * delay. Linear backoff bounds the worst-case added latency for a genuinely
 * transient fault. The caller is responsible for swallowing the terminal throw
 * (both sites log + move on rather than fail the run).
 */
export async function withTransientRetry<T>(
	attempt: () => Promise<T>,
): Promise<T> {
	let lastError: unknown;
	for (let i = 1; i <= PER_TYPE_SYNC_ATTEMPTS; i++) {
		try {
			return await attempt();
		} catch (error) {
			if (i >= PER_TYPE_SYNC_ATTEMPTS || !isTransientDbError(error)) {
				throw error;
			}
			lastError = error;
			await delay(RETRY_BACKOFF_MS * i);
		}
	}
	// Unreachable — the final attempt either returned or threw above; the
	// rethrow keeps the compiler's all-paths-return proof honest.
	throw lastError;
}
