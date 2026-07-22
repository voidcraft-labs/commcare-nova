import type { Transaction } from "kysely";
import {
	type AppDatabase,
	setTransactionRuntimeReaderVersion,
} from "@/lib/db/pg";
import { RUNTIME_CAPABILITIES } from "@/lib/runtimeCapabilities";

/** This revision's runtime-reader capability, authored only in the manifest. */
export const CURRENT_RUNTIME_READER_VERSION =
	RUNTIME_CAPABILITIES.runtimeReaderVersion;

/**
 * Declare this deployment's runtime-reader version for a transaction that may
 * create or replace an app run holder. The setting is transaction-local; the
 * database holder-identity trigger decides whether the write is a new holder
 * (stamp and floor-check), the same holder (preserve), or a release (clear).
 */
export async function declareRuntimeReader(
	tx: Transaction<AppDatabase>,
): Promise<void> {
	await setTransactionRuntimeReaderVersion(tx, CURRENT_RUNTIME_READER_VERSION);
}
