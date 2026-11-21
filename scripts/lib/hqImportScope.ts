/**
 * The one repair that gives `nova.hq.import` to the grants that existed when
 * the scope was added, shared by its read-only scan and its writer, so the
 * scan counts exactly the rows the writer changes.
 *
 * API keys are repaired before the migration, OAuth after the deploy. Each
 * phase is one transaction. The key cutoff is taken before the key pass,
 * and the later cutoff is the new revision's creation time rounded down.
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
 *   reach. Only a client already registered at the cutoff and a grant that dates
 *   from before it are eligible. A consent or client edited since is also left.
 *   Nova repairs API keys before the form that offers Import exists. Every key
 *   verification also updates its updatedAt. The later catch-up takes a key only where both
 *   dates prove it predates that form.
 *   A grant holding one HQ scope or neither is left as it is, and its
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

/** The pre-deploy key pass and the post-deploy OAuth and key catch-up. */
export type RepairPhase = "keys" | "oauth";

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

/** The provider dates token issuance to the second. Use a whole UTC second
 * from before the new revision first received traffic, unchanged on a retry. */
export function importScopeCutoff(text: string): Date {
	const before = new Date(text);
	if (
		!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(text) ||
		!Number.isFinite(before.getTime()) ||
		before.toISOString() !== text.replace("Z", ".000Z") ||
		before.getTime() > Date.now()
	)
		throw new Error("Use a past UTC cutoff in YYYY-MM-DDTHH:mm:ssZ form.");
	return before;
}

function kindStatements(
	before: Date,
	phase: RepairPhase,
): readonly KindStatement[] {
	const existed = sql`"createdAt" < ${before}`;
	const untouched = sql`(${existed} AND "updatedAt" < ${before})`;
	// In the scan these predicates describe the rows as they will stand after
	// the client and consent updates. The writer uses exactly the same tests.
	const clientEligible = (table: string) => sql`EXISTS (
   SELECT 1 FROM auth_oauth_client c WHERE c."clientId" = ${sql.ref(`${table}.clientId`)}
    AND (c.scopes IS NULL OR c.scopes ? ${IMPORT_SCOPE}
     OR (c."createdAt" < ${before} AND (c."updatedAt" IS NULL OR c."updatedAt" < ${before}))))`;
	const currentConsent = sql`EXISTS (
  SELECT 1 FROM auth_oauth_consent c WHERE c."userId" = auth_oauth_refresh_token."userId"
    AND c."clientId" = auth_oauth_refresh_token."clientId"
    AND c."referenceId" IS NOT DISTINCT FROM auth_oauth_refresh_token."referenceId"
    AND (c.scopes ? ${IMPORT_SCOPE} OR (c."createdAt" < ${before} AND c."updatedAt" < ${before}
      AND ${readsAndWritesHq(sql`c.scopes`)})))`;
	/* Rotation preserves authorizationCodeId. A new authorization by the same
	 * user and client gets a different one. Once a token in the family held
	 * Import, a later token lacking it may be deliberately downscoped. */
	const existingRefresh = sql`(${existed} OR (
   EXISTS (SELECT 1 FROM auth_oauth_refresh_token ancestor
       WHERE ancestor."authorizationCodeId" = auth_oauth_refresh_token."authorizationCodeId"
         AND ancestor."clientId" = auth_oauth_refresh_token."clientId"
         AND ancestor."userId" = auth_oauth_refresh_token."userId"
         AND ancestor."createdAt" < ${before}
         AND ${readsAndWritesHq(sql`ancestor.scopes`)})
   AND NOT EXISTS (SELECT 1 FROM auth_oauth_refresh_token previous
       WHERE previous."authorizationCodeId" = auth_oauth_refresh_token."authorizationCodeId"
         AND previous.scopes ? ${IMPORT_SCOPE})
 ))`;
	return [
		{
			kind: "client",
			table: "auth_oauth_client",
			changes: sql`(${existed} AND ("updatedAt" IS NULL OR "updatedAt" < ${before}) AND scopes IS NOT NULL AND NOT (scopes ? ${IMPORT_SCOPE}))`,
			set: sql`scopes = scopes || ${ADDED}, "updatedAt" = now()`,
		},
		{
			kind: "consent",
			table: "auth_oauth_consent",
			changes: sql`(${clientEligible("auth_oauth_consent")} AND ${untouched} AND ${readsAndWritesHq(sql`scopes`)})`,
			set: sql`scopes = scopes || ${ADDED}, "updatedAt" = now()`,
		},
		{
			kind: "refresh-token",
			table: "auth_oauth_refresh_token",
			changes: sql`(${clientEligible("auth_oauth_refresh_token")} AND ${currentConsent} AND ${existingRefresh} AND revoked IS NULL AND "expiresAt" > now() AND ${readsAndWritesHq(sql`scopes`)})`,
			set: sql`scopes = scopes || ${ADDED}`,
		},
		{
			kind: "api-key",
			table: "auth_apikey",
			changes: sql`(${phase === "keys" ? existed : untouched} AND enabled IS TRUE AND jsonb_typeof(${KEY_SCOPES}) = 'array' AND ${readsAndWritesHq(KEY_SCOPES)})`,
			set: sql`permissions = jsonb_set(permissions::jsonb, '{scope}', ${KEY_SCOPES} || ${ADDED})::text, "updatedAt" = now()`,
		},
	];
}

/** Each kind's count, read in the caller's transaction. */
async function countKinds<DB>(
	db: Kysely<DB>,
	statements: readonly KindStatement[],
): Promise<KindCount[]> {
	const counts: KindCount[] = [];
	for (const statement of statements) {
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
	options: {
		readonly execute: boolean;
		readonly before: Date;
		readonly phase: RepairPhase;
	},
): Promise<ImportScopeRepair> {
	const statements = kindStatements(options.before, options.phase).filter(
		({ kind }) => options.phase === "oauth" || kind === "api-key",
	);
	return db.transaction().execute(async (tx) => {
		if (!options.execute)
			await sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`.execute(
				tx,
			);
		if (options.execute) await sql`SET LOCAL lock_timeout = '5s'`.execute(tx);
		if (options.phase === "keys" && options.execute) {
			// The ledger migration requires ACCESS EXCLUSIVE on this table. It cannot
			// commit (and the scope-aware revision cannot serve) between this read and write.
			await sql`LOCK TABLE public.app_deployments IN ACCESS SHARE MODE`.execute(
				tx,
			);
		}
		if (options.phase === "oauth" && options.execute) {
			// A concurrent edit to the client's scope list or its person's consent
			// must be ordered with the token update that depends on that row.
			await sql`LOCK TABLE public.auth_oauth_client, public.auth_oauth_consent IN SHARE ROW EXCLUSIVE MODE`.execute(
				tx,
			);
		}
		const { rows } = await sql<{
			applied: boolean;
		}>`SELECT to_regclass('public.app_deployment_media_paths') IS NOT NULL AS applied`.execute(
			tx,
		);
		if (rows[0]?.applied !== (options.phase === "oauth"))
			throw new Error(
				options.phase === "keys"
					? "The key repair must finish before the bring-in migration."
					: "The OAuth repair runs after the bring-in deployment serves all traffic.",
			);
		if (!options.execute)
			return { written: false, kinds: await countKinds(tx, statements) };
		const kinds: KindCount[] = [];
		for (const statement of statements) {
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
