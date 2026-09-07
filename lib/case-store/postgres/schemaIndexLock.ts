/** Coordinate the physical index resource without holding a waiting snapshot. */
import { type Kysely, sql } from "kysely";
import { delay } from "@/lib/utils/delay";
import type { Database } from "../sql/database";
import { caseSchemaIndexLockScope } from "./indexIdentity";

async function tableScope(connection: Kysely<Database>): Promise<string> {
	const result = await sql<{
		relation: string | null;
	}>`SELECT to_regclass('cases')::oid::text AS relation`.execute(connection);
	const relation = result.rows[0]?.relation;
	if (relation === undefined || relation === null)
		throw new Error("Case index coordination requires the cases table");
	return `nova:case-schema-index-table:${relation}`;
}

/** The callback runs on an already-owned connection outside a transaction.
 * Use the physical relation OID so relocated and search-path-resolved tables
 * share ownership. No schema read or DDL runs before table ownership is held.
 * Blocking advisory SELECTs retain the snapshot an in-flight partial index
 * build must wait for. Each failed try finishes before waiting in JavaScript,
 * releasing its statement snapshot. Phase A keeps its existing per-type lock. */
export async function withCaseSchemaIndexDdlLock<T>(
	connection: Kysely<Database>,
	appId: string,
	caseType: string,
	operation: () => Promise<T>,
): Promise<T> {
	const table = await tableScope(connection);
	while (true) {
		const result = await sql<{
			acquired: boolean;
		}>`SELECT pg_try_advisory_lock(hashtextextended(${table}, 0)) AS acquired`.execute(
			connection,
		);
		if (result.rows[0]?.acquired) break;
		await delay(10);
	}
	try {
		const scope = caseSchemaIndexLockScope(appId, caseType);
		// Keep the existing per-type lock as the lifecycle fence, including callers
		// from an older serving revision during rollout overlap.
		while (true) {
			const result = await sql<{
				acquired: boolean;
			}>`SELECT pg_try_advisory_lock(hashtextextended(${scope}, 0)) AS acquired`.execute(
				connection,
			);
			if (result.rows[0]?.acquired) break;
			await delay(10);
		}
		try {
			return await operation();
		} finally {
			await sql`SELECT pg_advisory_unlock(hashtextextended(${scope}, 0))`.execute(
				connection,
			);
		}
	} finally {
		await sql`SELECT pg_advisory_unlock(hashtextextended(${table}, 0))`.execute(
			connection,
		);
	}
}
