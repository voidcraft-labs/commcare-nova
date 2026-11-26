import { sql, type Transaction } from "kysely";

/** The revocation watermark may have no row yet. Consent reads and current
 * private-data writes must serialize against its very first insertion too. */
export async function lockOAuthGrantGate<T>(
	tx: Transaction<T>,
	userId: string,
	clientId: string,
	mode: "read" | "revoke",
) {
	const key = sql`hashtextextended(jsonb_build_array('nova-oauth-grant',${userId}::text,${clientId}::text)::text,0)`;
	if (mode === "read")
		await sql`SELECT pg_advisory_xact_lock_shared(${key})`.execute(tx);
	else await sql`SELECT pg_advisory_xact_lock(${key})`.execute(tx);
}
