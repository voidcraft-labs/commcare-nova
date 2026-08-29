/**
 * Read-only preflight and exact writer for Better Auth 1.7's issuer-scoped
 * account identity. Better Auth 1.6 keyed accounts by (providerId, accountId);
 * 1.7 requires issuer and a unique (issuer, accountId) key.
 *
 * Nova has one configured external sign-in provider, Google. The migration
 * therefore maps only the identities the application can actually create:
 * Google to its verified canonical issuer and credential rows to Better
 * Auth's local credential namespace. Every other legacy provider blocks.
 */

import type { Pool, PoolClient, QueryResultRow } from "pg";

export const GOOGLE_ACCOUNT_ISSUER = "https://accounts.google.com";
export const CREDENTIAL_ACCOUNT_ISSUER = "local:credential";

const ACCOUNT_INDEX = "auth_account_issuer_accountId_uidx";
const COMPATIBILITY_FUNCTION = "nova_fill_auth_account_issuer_v17";
const COMPATIBILITY_TRIGGER = "nova_auth_account_issuer_v17";

type Queryable = Pool | PoolClient;

interface ProviderCountRow extends QueryResultRow {
	readonly provider: string;
	readonly count: number;
}

interface CountRow extends QueryResultRow {
	readonly count: number;
}

interface ColumnRow extends QueryResultRow {
	readonly is_nullable: "YES" | "NO";
}

interface IndexRow extends QueryResultRow {
	readonly indexdef: string;
}

export type BetterAuthAccountIdentityState =
	| "absent"
	| "legacy-ready"
	| "current"
	| "blocked";

export interface BetterAuthAccountIdentityReport {
	readonly state: BetterAuthAccountIdentityState;
	readonly accountCount: number;
	readonly providers: readonly ProviderCountRow[];
	readonly issuerColumnPresent: boolean;
	readonly issuerRequired: boolean;
	readonly issuerAccountIndexPresent: boolean;
	readonly projectedIdentityCollisions: number;
	readonly nullIssuers: number;
	readonly incorrectKnownIssuers: number;
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

async function accountTableExists(db: Queryable): Promise<boolean> {
	return (
		(await count(
			db,
			"SELECT COUNT(*)::int AS count FROM information_schema.tables WHERE table_schema = $1 AND table_name = $2",
			["public", "auth_account"],
		)) === 1
	);
}

async function readIssuerColumn(db: Queryable): Promise<ColumnRow | undefined> {
	const result = await db.query<ColumnRow>(
		"SELECT is_nullable FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 AND column_name = $3",
		["public", "auth_account", "issuer"],
	);
	return result.rows[0];
}

async function hasExactIssuerIndex(db: Queryable): Promise<boolean> {
	const result = await db.query<IndexRow>(
		"SELECT indexdef FROM pg_indexes WHERE schemaname = $1 AND tablename = $2 AND indexname = $3",
		["public", "auth_account", ACCOUNT_INDEX],
	);
	const definition = result.rows[0]?.indexdef;
	return (
		definition?.includes("CREATE UNIQUE INDEX") === true &&
		definition.includes('(issuer, "accountId")')
	);
}

/** Inspect the live schema and account identities without returning user IDs. */
export async function scanBetterAuthAccountIdentity(
	db: Queryable,
): Promise<BetterAuthAccountIdentityReport> {
	if (!(await accountTableExists(db))) {
		return {
			state: "absent",
			accountCount: 0,
			providers: [],
			issuerColumnPresent: false,
			issuerRequired: false,
			issuerAccountIndexPresent: false,
			projectedIdentityCollisions: 0,
			nullIssuers: 0,
			incorrectKnownIssuers: 0,
			issues: [],
		};
	}

	const providerResult = await db.query<ProviderCountRow>(
		'SELECT "providerId" AS provider, COUNT(*)::int AS count FROM public.auth_account GROUP BY "providerId" ORDER BY "providerId"',
	);
	const providers = providerResult.rows;
	const accountCount = providers.reduce((sum, row) => sum + row.count, 0);
	const unsupportedProviders = providers
		.map((row) => row.provider)
		.filter((provider) => provider !== "google" && provider !== "credential");
	const projectedIdentityCollisions = await count(
		db,
		`SELECT COUNT(*)::int AS count
		 FROM (
			 SELECT
				 CASE "providerId"
					 WHEN 'google' THEN $1
					 WHEN 'credential' THEN $2
				 END AS projected_issuer,
				 CASE WHEN "providerId" = 'credential' THEN "userId" ELSE "accountId" END AS projected_account_id
			 FROM public.auth_account
			 WHERE "providerId" IN ('google', 'credential')
			 GROUP BY 1, 2
			 HAVING COUNT(*) > 1
		 ) collisions`,
		[GOOGLE_ACCOUNT_ISSUER, CREDENTIAL_ACCOUNT_ISSUER],
	);

	const issuerColumn = await readIssuerColumn(db);
	const issuerColumnPresent = issuerColumn !== undefined;
	const issuerRequired = issuerColumn?.is_nullable === "NO";
	let nullIssuers = 0;
	let incorrectKnownIssuers = 0;
	let issuerAccountIndexPresent = false;
	if (issuerColumnPresent) {
		nullIssuers = await count(
			db,
			"SELECT COUNT(*)::int AS count FROM public.auth_account WHERE issuer IS NULL",
		);
		incorrectKnownIssuers = await count(
			db,
			`SELECT COUNT(*)::int AS count
			 FROM public.auth_account
			 WHERE ("providerId" = 'google' AND issuer <> $1)
				OR ("providerId" = 'credential' AND (issuer <> $2 OR "accountId" <> "userId"))`,
			[GOOGLE_ACCOUNT_ISSUER, CREDENTIAL_ACCOUNT_ISSUER],
		);
		issuerAccountIndexPresent = await hasExactIssuerIndex(db);
	}

	const issues: string[] = [];
	if (unsupportedProviders.length > 0) {
		issues.push(
			`unsupported legacy providers: ${unsupportedProviders.join(", ")}`,
		);
	}
	if (projectedIdentityCollisions > 0) {
		issues.push(
			`${projectedIdentityCollisions} projected issuer/account identity collision(s)`,
		);
	}
	if (issuerColumnPresent) {
		if (nullIssuers > 0)
			issues.push(`${nullIssuers} account row(s) lack issuer`);
		if (incorrectKnownIssuers > 0) {
			issues.push(
				`${incorrectKnownIssuers} known-provider account row(s) have the wrong issuer or credential identity`,
			);
		}
		if (!issuerRequired) issues.push("issuer is still nullable");
		if (!issuerAccountIndexPresent) {
			issues.push("the exact unique issuer/account index is absent or drifted");
		}
	}

	const state: BetterAuthAccountIdentityState =
		issues.length > 0
			? "blocked"
			: issuerColumnPresent
				? "current"
				: "legacy-ready";
	return {
		state,
		accountCount,
		providers,
		issuerColumnPresent,
		issuerRequired,
		issuerAccountIndexPresent,
		projectedIdentityCollisions,
		nullIssuers,
		incorrectKnownIssuers,
		issues,
	};
}

function assertReady(report: BetterAuthAccountIdentityReport): void {
	if (report.state === "blocked") {
		throw new Error(
			`Better Auth account identity migration blocked: ${report.issues.join("; ")}`,
		);
	}
}

/**
 * Converge a populated 1.6 account table before Better Auth's 1.7 schema
 * migrator runs. The trigger is the rolling-deploy bridge: a still-serving
 * 1.6 revision omits issuer on insert, while 1.7 always supplies it.
 */
export async function migrateBetterAuthAccountIdentity(
	pool: Pool,
): Promise<BetterAuthAccountIdentityReport> {
	const initial = await scanBetterAuthAccountIdentity(pool);
	assertReady(initial);
	if (initial.state === "absent") return initial;

	const client = await pool.connect();
	try {
		await client.query("BEGIN");
		await client.query(
			"LOCK TABLE public.auth_account IN ACCESS EXCLUSIVE MODE",
		);
		const locked = await scanBetterAuthAccountIdentity(client);
		assertReady(locked);
		if (locked.state === "legacy-ready") {
			await client.query(
				"ALTER TABLE public.auth_account ADD COLUMN IF NOT EXISTS issuer text",
			);
		}
		await client.query(`
			CREATE OR REPLACE FUNCTION public.${COMPATIBILITY_FUNCTION}()
			RETURNS trigger
			LANGUAGE plpgsql
			AS $$
			BEGIN
				IF NEW.issuer IS NULL THEN
					CASE NEW."providerId"
						WHEN 'google' THEN
							NEW.issuer := '${GOOGLE_ACCOUNT_ISSUER}';
						WHEN 'credential' THEN
							NEW.issuer := '${CREDENTIAL_ACCOUNT_ISSUER}';
							NEW."accountId" := NEW."userId";
						ELSE
							RAISE EXCEPTION 'Legacy auth account provider % has no reviewed issuer mapping', NEW."providerId";
					END CASE;
				END IF;
				RETURN NEW;
			END;
			$$
		`);
		await client.query(
			`DROP TRIGGER IF EXISTS ${COMPATIBILITY_TRIGGER} ON public.auth_account`,
		);
		await client.query(`
			CREATE TRIGGER ${COMPATIBILITY_TRIGGER}
			BEFORE INSERT ON public.auth_account
			FOR EACH ROW EXECUTE FUNCTION public.${COMPATIBILITY_FUNCTION}()
		`);
		if (locked.state === "legacy-ready") {
			await client.query(
				`UPDATE public.auth_account
				 SET issuer = $1
				 WHERE "providerId" = 'google' AND issuer IS NULL`,
				[GOOGLE_ACCOUNT_ISSUER],
			);
			await client.query(
				`UPDATE public.auth_account
				 SET issuer = $1, "accountId" = "userId"
				 WHERE "providerId" = 'credential'`,
				[CREDENTIAL_ACCOUNT_ISSUER],
			);
			await client.query(
				"ALTER TABLE public.auth_account ALTER COLUMN issuer SET NOT NULL",
			);
			await client.query(
				`CREATE UNIQUE INDEX "${ACCOUNT_INDEX}" ON public.auth_account (issuer, "accountId")`,
			);
		}
		const converged = await scanBetterAuthAccountIdentity(client);
		if (converged.state !== "current") {
			throw new Error(
				`Better Auth account identity migration did not converge: ${converged.issues.join("; ")}`,
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

export function renderBetterAuthAccountIdentityReport(
	report: BetterAuthAccountIdentityReport,
): string {
	return JSON.stringify(report, null, 2);
}
