/** A contention-capable app-state pool. Callers finish or cancel their work
 * before destroy; teardown never polls for unowned background requests. */
import type { Kysely } from "kysely";
import { buildIsolatedDb } from "@/lib/case-store/sql/__tests__/perTestDatabase";
import type { AppDatabase } from "@/lib/db/pg";

export interface PerTestAppDb {
	readonly appDb: Kysely<AppDatabase>;
	destroy(): Promise<void>;
}

export function createPerTestAppDb(uri: string): PerTestAppDb {
	const { db, destroy } = buildIsolatedDb<AppDatabase>(uri, {
		max: 4,
		connectionTimeoutMillis: 10_000,
		query_timeout: 10_000,
	});
	return { appDb: db, destroy };
}
