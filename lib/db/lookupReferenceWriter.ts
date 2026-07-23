import type { Transaction } from "kysely";
import { type AppDatabase, setTransactionWriterVersion } from "@/lib/db/pg";
import { RUNTIME_CAPABILITIES } from "@/lib/runtimeCapabilities";

/**
 * Compatibility version declared by every authoritative app writer.
 *
 * This module is intentionally safe to load from plain Node/tsx inspectors:
 * `apps.ts` is part of their dependency graph. Its only callable API still
 * requires a server-owned Postgres transaction.
 *
 * S05a's production carrier extractor raises the manifest's ONE
 * `writerVersion` field to 1. Database floors and feature flags remain
 * independent controls; this declaration does not mutate either.
 */
export const CURRENT_LOOKUP_REFERENCE_WRITER_VERSION =
	RUNTIME_CAPABILITIES.writerVersion;

/**
 * Declare this deployment's lookup-reference writer capability for the current
 * transaction. The underlying GUC is transaction-local and resets at the
 * transaction boundary; callers must invoke this inside every authoritative
 * app-write transaction, never on a pooled session.
 */
export async function declareLookupReferenceWriter(
	tx: Transaction<AppDatabase>,
): Promise<void> {
	await setTransactionWriterVersion(
		tx,
		CURRENT_LOOKUP_REFERENCE_WRITER_VERSION,
	);
}
