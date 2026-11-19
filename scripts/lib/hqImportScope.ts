/**
 * The one repair that gives `nova.hq.import` to the grants that existed when
 * the scope was added, shared by its read-only scan and its writer, so the
 * scan counts exactly the rows the writer changes.
 *
 * Four kinds of row change, in one transaction, and a second run changes
 * nothing:
 *
 * - an OAuth client row whose own scope list lacks the scope. That list is
 *   the client's capability set: `@better-auth/oauth-provider` refuses an
 *   authorize asking for a scope outside it (`authorizeEndpoint`, against
 *   `client.scopes ?? opts.scopes`) and refuses a refresh whose stored scopes
 *   it doesn't cover (`handleRefreshTokenGrant` → `validateClientScopes`).
 *   A null list takes the server's own list, so it is left as it is. A row a
 *   client's metadata document wrote is rewritten from the server's list the
 *   next time this process reads the document, and the repair gives it the
 *   same scope now, so a refresh in between is never refused.
 * - a consent row, a live refresh token (not revoked, so not rotated, and
 *   not expired) and an enabled API key, each only where it already holds both
 *   `nova.hq.read` and `nova.hq.write`: the person approved reading and
 *   writing CommCare HQ with their key, and bringing apps in is that same
 *   reach. A grant holding one HQ scope or neither is left as it is, and its
 *   person is asked at consent, or edits the key, as for any scope.
 *
 * Access tokens are left: each holds the scopes it was issued with for at most
 * an hour, and a refresh of the repaired token replaces it.
 */

import { type Kysely, type RawBuilder, sql } from "kysely";
import type { NovaApiKeyScope } from "../../lib/auth-public";

export const IMPORT_SCOPE = "nova.hq.import" satisfies NovaApiKeyScope;
const HQ_READ = "nova.hq.read" satisfies NovaApiKeyScope;
const HQ_WRITE = "nova.hq.write" satisfies NovaApiKeyScope;

/** The kinds of row the repair reads, in the order it reports them. */
export type GrantKind = "client" | "consent" | "refresh-token" | "api-key";

/** How many rows of one kind the repair changes, or would, and how many it leaves. */
export interface KindCount {
	readonly kind: GrantKind;
	readonly changes: number;
	readonly leaves: number;
}

/** What one run did, or would do. */
export interface ImportScopeRepair {
	/** Whether the run wrote: false on a dry run. */
	readonly written: boolean;
	readonly kinds: readonly KindCount[];
}

/** The terminal label of each kind. */
export const KIND_LABELS: Record<GrantKind, string> = {
	client: "OAuth clients",
	consent: "OAuth consents",
	"refresh-token": "OAuth refresh tokens",
	"api-key": "API keys",
};

/** One kind's table, the rows of it the repair changes, and the change. */
interface KindStatement {
	readonly kind: GrantKind;
	readonly table: string;
	readonly changes: RawBuilder<unknown>;
	readonly set: RawBuilder<unknown>;
}

const ADDED = sql`${JSON.stringify([IMPORT_SCOPE])}::jsonb`;

/** A jsonb scope array holding both HQ scopes and not the import scope. */
function readsAndWritesHq(list: RawBuilder<unknown>): RawBuilder<unknown> {
	return sql`(${list} ? ${HQ_READ} AND ${list} ? ${HQ_WRITE} AND NOT (${list} ? ${IMPORT_SCOPE}))`;
}

/** An API key's scopes: the plugin keeps `{"scope": [...]}` as JSON text. */
const KEY_SCOPES = sql`(permissions::jsonb -> 'scope')`;

const KINDS: readonly KindStatement[] = [
	{
		kind: "client",
		table: "auth_oauth_client",
		changes: sql`(scopes IS NOT NULL AND NOT (scopes ? ${IMPORT_SCOPE}))`,
		set: sql`scopes = scopes || ${ADDED}, "updatedAt" = now()`,
	},
	{
		kind: "consent",
		table: "auth_oauth_consent",
		changes: readsAndWritesHq(sql`scopes`),
		set: sql`scopes = scopes || ${ADDED}, "updatedAt" = now()`,
	},
	{
		kind: "refresh-token",
		table: "auth_oauth_refresh_token",
		changes: sql`(revoked IS NULL AND "expiresAt" > now() AND ${readsAndWritesHq(sql`scopes`)})`,
		set: sql`scopes = scopes || ${ADDED}`,
	},
	{
		kind: "api-key",
		table: "auth_apikey",
		changes: sql`(enabled IS TRUE AND jsonb_typeof(${KEY_SCOPES}) = 'array' AND ${readsAndWritesHq(KEY_SCOPES)})`,
		set: sql`permissions = jsonb_set(permissions::jsonb, '{scope}', ${KEY_SCOPES} || ${ADDED})::text, "updatedAt" = now()`,
	},
];

/** Each kind's count, read in the caller's transaction. */
async function countKinds<DB>(db: Kysely<DB>): Promise<KindCount[]> {
	const counts: KindCount[] = [];
	for (const statement of KINDS) {
		const { rows } = await sql<{ changes: number; total: number }>`
			SELECT count(*) FILTER (WHERE ${statement.changes})::int AS changes,
				count(*)::int AS total
			FROM ${sql.table(statement.table)}
		`.execute(db);
		const [row] = rows;
		const changes = row?.changes ?? 0;
		counts.push({
			kind: statement.kind,
			changes,
			leaves: (row?.total ?? 0) - changes,
		});
	}
	return counts;
}

/**
 * Read, or with `execute` make, the repair in one transaction. A dry run reads
 * every kind in one read-only snapshot and writes nothing. A run that writes
 * changes each kind's rows with one statement whose condition is the one the
 * dry run counts, at read committed, so a row a concurrent refresh rotates
 * while the run waits for it is read again and left once it is revoked.
 */
export async function repairImportScope<DB>(
	db: Kysely<DB>,
	options: { readonly execute: boolean },
): Promise<ImportScopeRepair> {
	if (!options.execute)
		return db.transaction().execute(async (tx) => {
			await sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`.execute(
				tx,
			);
			return { written: false, kinds: await countKinds(tx) };
		});
	return db.transaction().execute(async (tx) => {
		const kinds: KindCount[] = [];
		for (const statement of KINDS) {
			const updated = await sql`
				UPDATE ${sql.table(statement.table)}
				SET ${statement.set}
				WHERE ${statement.changes}
			`.execute(tx);
			const changes = Number(updated.numAffectedRows ?? 0);
			const { rows } = await sql<{ total: number }>`
				SELECT count(*)::int AS total FROM ${sql.table(statement.table)}
			`.execute(tx);
			kinds.push({
				kind: statement.kind,
				changes,
				leaves: (rows[0]?.total ?? 0) - changes,
			});
		}
		return { written: true, kinds };
	});
}

/** The run's report for the terminal: one line per kind. */
export function repairLines(repair: ImportScopeRepair): string[] {
	const verb = repair.written ? "changed" : "would change";
	return repair.kinds.map(
		(count) =>
			`  ${KIND_LABELS[count.kind].padEnd(22)} ${verb} ${count.changes}, leaves ${count.leaves}`,
	);
}
