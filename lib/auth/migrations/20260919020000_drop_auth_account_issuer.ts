// Drops `auth_account.issuer`, the last of the (issuer, "accountId") account
// identity Better Auth used in 1.7.0 through 1.7.2.
//
// Better Auth identifies an account by ("providerId", "accountId") and neither
// reads nor writes `issuer`. The column held a value derived from "providerId"
// for accounts those releases created and NULL for every account since, so
// nothing is lost with it. A database created after those releases never held
// the column, which is why the drop is conditional.

import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
	await sql`
		ALTER TABLE public.auth_account DROP COLUMN IF EXISTS issuer
	`.execute(db);
}

export async function down(): Promise<void> {
	throw new Error(
		"Dropping auth_account.issuer is forward-only: the values it held are gone, and Better Auth no longer reads the column.",
	);
}
