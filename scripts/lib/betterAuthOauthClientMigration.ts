/** Better Auth 1.7 OAuth client application-type preflight and writer. */

import type { Pool, PoolClient, QueryResultRow } from "pg";

const COMPATIBILITY_FUNCTION = "nova_fill_oauth_client_application_type_v17";
const COMPATIBILITY_TRIGGER = "nova_oauth_client_application_type_v17";

type Queryable = Pool | PoolClient;

interface CountRow extends QueryResultRow {
	readonly count: number;
}

export type BetterAuthOauthClientMigrationState =
	| "absent"
	| "legacy-ready"
	| "current"
	| "blocked";

export interface BetterAuthOauthClientMigrationReport {
	readonly state: BetterAuthOauthClientMigrationState;
	readonly clientCount: number;
	readonly applicationTypeColumnPresent: boolean;
	readonly nativeClients: number;
	readonly webClients: number;
	readonly pendingClients: number;
	readonly unclassifiableClients: number;
	readonly issues: readonly string[];
}

async function count(
	db: Queryable,
	statement: string,
	values: readonly unknown[] = [],
): Promise<number> {
	const result = await db.query<CountRow>(statement, [...values]);
	return result.rows[0]?.count ?? 0;
}

async function hasTable(db: Queryable): Promise<boolean> {
	return (
		(await count(
			db,
			"SELECT COUNT(*)::int AS count FROM information_schema.tables WHERE table_schema = $1 AND table_name = $2",
			["public", "auth_oauth_client"],
		)) === 1
	);
}

async function hasColumn(db: Queryable, column: string): Promise<boolean> {
	return (
		(await count(
			db,
			"SELECT COUNT(*)::int AS count FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 AND column_name = $3",
			["public", "auth_oauth_client", column],
		)) === 1
	);
}

const LOOPBACK_REDIRECT =
	"^http://(localhost|127[.]0[.]0[.]1|[[]::1[]])(:[0-9]+)?/";
const WEB_REDIRECT = "^https://";

function allRedirectsMatch(expression: string): string {
	return `jsonb_array_length("redirectUris") > 0
		AND NOT EXISTS (
			SELECT 1 FROM jsonb_array_elements_text("redirectUris") AS redirect(uri)
			WHERE redirect.uri !~ ${expression}
		)`;
}

/** Inspect only aggregate client classifications; redirect URIs are not returned. */
export async function scanBetterAuthOauthClients(
	db: Queryable,
): Promise<BetterAuthOauthClientMigrationReport> {
	if (!(await hasTable(db))) {
		return {
			state: "absent",
			clientCount: 0,
			applicationTypeColumnPresent: false,
			nativeClients: 0,
			webClients: 0,
			pendingClients: 0,
			unclassifiableClients: 0,
			issues: [],
		};
	}

	const applicationTypeColumnPresent = await hasColumn(db, "applicationType");
	const clientCount = await count(
		db,
		"SELECT COUNT(*)::int AS count FROM public.auth_oauth_client",
	);
	let nativeClients = 0;
	let webClients = 0;
	let pendingClients = clientCount;
	if (applicationTypeColumnPresent) {
		nativeClients = await count(
			db,
			`SELECT COUNT(*)::int AS count FROM public.auth_oauth_client WHERE "applicationType" = 'native'`,
		);
		webClients = await count(
			db,
			`SELECT COUNT(*)::int AS count FROM public.auth_oauth_client WHERE "applicationType" = 'web'`,
		);
		pendingClients = await count(
			db,
			`SELECT COUNT(*)::int AS count FROM public.auth_oauth_client WHERE "applicationType" IS NULL`,
		);
	}
	const pendingPredicate = applicationTypeColumnPresent
		? '"applicationType" IS NULL AND '
		: "";
	const unclassifiableClients = await count(
		db,
		`SELECT COUNT(*)::int AS count
		 FROM public.auth_oauth_client
		 WHERE ${pendingPredicate}NOT (${allRedirectsMatch("$1")})
			AND NOT (${allRedirectsMatch("$2")})`,
		[LOOPBACK_REDIRECT, WEB_REDIRECT],
	);
	const invalidCurrentTypes = applicationTypeColumnPresent
		? await count(
				db,
				`SELECT COUNT(*)::int AS count
				 FROM public.auth_oauth_client
				 WHERE "applicationType" IS NOT NULL
					AND "applicationType" NOT IN ('native', 'web')`,
			)
		: 0;

	const issues: string[] = [];
	if (unclassifiableClients > 0) {
		issues.push(
			`${unclassifiableClients} client(s) have redirect URIs that cannot be classified safely`,
		);
	}
	if (invalidCurrentTypes > 0) {
		issues.push(
			`${invalidCurrentTypes} client(s) have an invalid application type`,
		);
	}
	const state: BetterAuthOauthClientMigrationState =
		issues.length > 0
			? "blocked"
			: !applicationTypeColumnPresent || pendingClients > 0
				? "legacy-ready"
				: "current";
	return {
		state,
		clientCount,
		applicationTypeColumnPresent,
		nativeClients,
		webClients,
		pendingClients,
		unclassifiableClients,
		issues,
	};
}

function assertReady(report: BetterAuthOauthClientMigrationReport): void {
	if (report.state === "blocked") {
		throw new Error(
			`Better Auth OAuth client migration blocked: ${report.issues.join("; ")}`,
		);
	}
}

/** Run after Better Auth's schema migrator has added applicationType. */
export async function migrateBetterAuthOauthClients(
	pool: Pool,
): Promise<BetterAuthOauthClientMigrationReport> {
	const initial = await scanBetterAuthOauthClients(pool);
	assertReady(initial);
	if (initial.state === "absent") return initial;
	if (!initial.applicationTypeColumnPresent) {
		throw new Error(
			"Better Auth OAuth client migration requires the 1.7 schema migrator to add applicationType first",
		);
	}

	const client = await pool.connect();
	try {
		await client.query("BEGIN");
		await client.query(
			"LOCK TABLE public.auth_oauth_client IN ACCESS EXCLUSIVE MODE",
		);
		const locked = await scanBetterAuthOauthClients(client);
		assertReady(locked);

		await client.query(`
			CREATE OR REPLACE FUNCTION public.${COMPATIBILITY_FUNCTION}()
			RETURNS trigger
			LANGUAGE plpgsql
			AS $$
			BEGIN
				IF NEW."applicationType" IS NULL THEN
					IF jsonb_array_length(NEW."redirectUris") > 0
						AND NOT EXISTS (
							SELECT 1 FROM jsonb_array_elements_text(NEW."redirectUris") AS redirect(uri)
							WHERE redirect.uri !~ '${LOOPBACK_REDIRECT}'
						) THEN
						NEW."applicationType" := 'native';
					ELSIF jsonb_array_length(NEW."redirectUris") > 0
						AND NOT EXISTS (
							SELECT 1 FROM jsonb_array_elements_text(NEW."redirectUris") AS redirect(uri)
							WHERE redirect.uri !~ '${WEB_REDIRECT}'
						) THEN
						NEW."applicationType" := 'web';
					ELSE
						RAISE EXCEPTION 'Legacy OAuth client redirect URIs have no reviewed application type';
					END IF;
				END IF;
				RETURN NEW;
			END;
			$$
		`);
		await client.query(
			`DROP TRIGGER IF EXISTS ${COMPATIBILITY_TRIGGER} ON public.auth_oauth_client`,
		);
		await client.query(`
			CREATE TRIGGER ${COMPATIBILITY_TRIGGER}
			BEFORE INSERT ON public.auth_oauth_client
			FOR EACH ROW EXECUTE FUNCTION public.${COMPATIBILITY_FUNCTION}()
		`);
		await client.query(
			`UPDATE public.auth_oauth_client
			 SET "applicationType" = 'native'
			 WHERE "applicationType" IS NULL AND ${allRedirectsMatch("$1")}`,
			[LOOPBACK_REDIRECT],
		);
		await client.query(
			`UPDATE public.auth_oauth_client
			 SET "applicationType" = 'web'
			 WHERE "applicationType" IS NULL AND ${allRedirectsMatch("$1")}`,
			[WEB_REDIRECT],
		);
		const converged = await scanBetterAuthOauthClients(client);
		if (converged.state !== "current") {
			throw new Error(
				`Better Auth OAuth client migration did not converge: ${converged.issues.join("; ")}`,
			);
		}
		await client.query("COMMIT");
		return converged;
	} catch (error) {
		await client.query("ROLLBACK");
		throw error;
	} finally {
		client.release();
	}
}

export function renderBetterAuthOauthClientReport(
	report: BetterAuthOauthClientMigrationReport,
): string {
	return JSON.stringify(report, null, 2);
}
