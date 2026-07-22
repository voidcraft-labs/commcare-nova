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
 * Declare this deployment's runtime-reader version before any transaction DML
 * that may touch an app run holder—including same-holder and terminal writes.
 * The setting is transaction-local; absence is the deployed-v0 signal. The
 * database holder-identity trigger decides whether the write is a new holder
 * (stamp and floor-check), the same holder (preserve), or a release (clear).
 */
export async function declareRuntimeReader(
	tx: Transaction<AppDatabase>,
): Promise<void> {
	await setTransactionRuntimeReaderVersion(tx, CURRENT_RUNTIME_READER_VERSION);
}
