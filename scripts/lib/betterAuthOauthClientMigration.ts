/** Better Auth 1.7 OAuth client and protected-resource preflight and writer. */

import { randomUUID } from "node:crypto";
import type { Pool, PoolClient, QueryResultRow } from "pg";
import { MCP_RESOURCE_URL } from "@/lib/hostnames";

const ROLLING_APPLICATION_TYPE_FUNCTION =
	"nova_fill_oauth_client_application_type_v17";
const ROLLING_APPLICATION_TYPE_TRIGGER =
	"nova_oauth_client_application_type_v17";
const ROLLING_RESOURCE_LINK_FUNCTION = "nova_link_oauth_client_resource_v17";
const ROLLING_RESOURCE_LINK_TRIGGER = "nova_oauth_client_resource_v17";

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
	readonly clientCredentialsScopesColumnPresent: boolean;
	readonly legacyPublicColumnPresent: boolean;
	readonly legacyTypeColumnPresent: boolean;
	readonly rollingDeployTriggerCount: number;
	readonly nativeClients: number;
	readonly webClients: number;
	readonly pendingClients: number;
	readonly unclassifiableClients: number;
	readonly pendingClientCredentialsScopes: number;
	readonly resourceSchemaPresent: boolean;
	readonly resourceRegistered: boolean;
	readonly linkedClients: number;
	readonly unlinkedClients: number;
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

async function hasNamedTable(
	db: Queryable,
	tableName: string,
): Promise<boolean> {
	return (
		(await count(
			db,
			"SELECT COUNT(*)::int AS count FROM information_schema.tables WHERE table_schema = $1 AND table_name = $2",
			["public", tableName],
		)) === 1
	);
}

async function hasTable(db: Queryable): Promise<boolean> {
	return hasNamedTable(db, "auth_oauth_client");
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
			clientCredentialsScopesColumnPresent: false,
			legacyPublicColumnPresent: false,
			legacyTypeColumnPresent: false,
			rollingDeployTriggerCount: 0,
			nativeClients: 0,
			webClients: 0,
			pendingClients: 0,
			unclassifiableClients: 0,
			pendingClientCredentialsScopes: 0,
			resourceSchemaPresent: false,
			resourceRegistered: false,
			linkedClients: 0,
			unlinkedClients: 0,
			issues: [],
		};
	}

	const applicationTypeColumnPresent = await hasColumn(db, "applicationType");
	const clientCredentialsScopesColumnPresent = await hasColumn(
		db,
		"clientCredentialsScopes",
	);
	const legacyPublicColumnPresent = await hasColumn(db, "public");
	const legacyTypeColumnPresent = await hasColumn(db, "type");
	const rollingDeployTriggerCount = await count(
		db,
		`SELECT COUNT(*)::int AS count
		 FROM pg_catalog.pg_trigger
		 WHERE NOT tgisinternal
		   AND tgname = ANY($1::text[])`,
		[
			[
				"nova_auth_account_issuer_v17",
				ROLLING_APPLICATION_TYPE_TRIGGER,
				ROLLING_RESOURCE_LINK_TRIGGER,
			],
		],
	);
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
	const pendingClientCredentialsScopes = clientCredentialsScopesColumnPresent
		? await count(
				db,
				`SELECT COUNT(*)::int AS count
				 FROM public.auth_oauth_client
				 WHERE "clientCredentialsScopes" IS NULL`,
			)
		: clientCount;
	const invalidClientCredentialsScopes = clientCredentialsScopesColumnPresent
		? await count(
				db,
				`SELECT COUNT(*)::int AS count
				 FROM public.auth_oauth_client
				 WHERE "clientCredentialsScopes" IS NOT NULL
				   AND jsonb_typeof("clientCredentialsScopes") <> 'array'`,
			)
		: 0;
	const resourceSchemaPresent =
		(await hasNamedTable(db, "auth_oauth_resource")) &&
		(await hasNamedTable(db, "auth_oauth_client_resource"));
	const resourceRowCount = resourceSchemaPresent
		? await count(
				db,
				"SELECT COUNT(*)::int AS count FROM public.auth_oauth_resource WHERE identifier = $1",
				[MCP_RESOURCE_URL],
			)
		: 0;
	const registeredResourceCount = resourceSchemaPresent
		? await count(
				db,
				`SELECT COUNT(*)::int AS count
				 FROM public.auth_oauth_resource
				 WHERE identifier = $1 AND disabled IS NOT TRUE`,
				[MCP_RESOURCE_URL],
			)
		: 0;
	const resourceRegistered = registeredResourceCount === 1;
	const linkedClients = resourceSchemaPresent
		? await count(
				db,
				`SELECT COUNT(DISTINCT c."clientId")::int AS count
				 FROM public.auth_oauth_client AS c
				 JOIN public.auth_oauth_client_resource AS link
				   ON link."clientId" = c."clientId"
				  AND link."resourceId" = $1`,
				[MCP_RESOURCE_URL],
			)
		: 0;
	const unlinkedClients = resourceSchemaPresent
		? await count(
				db,
				`SELECT COUNT(*)::int AS count
				 FROM public.auth_oauth_client AS c
				 WHERE NOT EXISTS (
					SELECT 1
					FROM public.auth_oauth_client_resource AS link
					WHERE link."clientId" = c."clientId"
					  AND link."resourceId" = $1
				 )`,
				[MCP_RESOURCE_URL],
			)
		: clientCount;

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
	if (invalidClientCredentialsScopes > 0) {
		issues.push(
			`${invalidClientCredentialsScopes} client(s) have non-array client credential scopes`,
		);
	}
	if (resourceSchemaPresent && resourceRowCount > 1) {
		issues.push("the MCP protected resource is registered more than once");
	}
	if (
		resourceSchemaPresent &&
		resourceRowCount === 1 &&
		registeredResourceCount === 0
	) {
		issues.push("the MCP protected resource is disabled");
	}
	const state: BetterAuthOauthClientMigrationState =
		issues.length > 0
			? "blocked"
			: !applicationTypeColumnPresent ||
					!clientCredentialsScopesColumnPresent ||
					pendingClients > 0 ||
					pendingClientCredentialsScopes > 0 ||
					!resourceSchemaPresent ||
					!resourceRegistered ||
					unlinkedClients > 0
				? "legacy-ready"
				: "current";
	return {
		state,
		clientCount,
		applicationTypeColumnPresent,
		clientCredentialsScopesColumnPresent,
		legacyPublicColumnPresent,
		legacyTypeColumnPresent,
		rollingDeployTriggerCount,
		nativeClients,
		webClients,
		pendingClients,
		unclassifiableClients,
		pendingClientCredentialsScopes,
		resourceSchemaPresent,
		resourceRegistered,
		linkedClients,
		unlinkedClients,
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
	if (
		initial.state === "current" &&
		!initial.legacyPublicColumnPresent &&
		!initial.legacyTypeColumnPresent
	) {
		return initial;
	}
	if (!initial.applicationTypeColumnPresent) {
		throw new Error(
			"Better Auth OAuth client migration requires the 1.7 schema migrator to add applicationType first",
		);
	}
	if (!initial.clientCredentialsScopesColumnPresent) {
		throw new Error(
			"Better Auth OAuth client migration requires the 1.7 clientCredentialsScopes column first",
		);
	}
	if (!initial.resourceSchemaPresent) {
		throw new Error(
			"Better Auth OAuth client migration requires the 1.7 protected-resource tables first",
		);
	}

	const client = await pool.connect();
	try {
		await client.query("BEGIN");
		await client.query(
			"LOCK TABLE public.auth_oauth_resource, public.auth_oauth_client, public.auth_oauth_client_resource IN ACCESS EXCLUSIVE MODE",
		);
		const locked = await scanBetterAuthOauthClients(client);
		assertReady(locked);
		const needsRollingBridge =
			locked.legacyPublicColumnPresent || locked.legacyTypeColumnPresent;

		// Better Auth 1.7 makes protected resources first-class and defaults
		// per-client enforcement ON. Seed Nova's one resource in the migration
		// itself, then link every existing DCR client before the 1.7 runtime can
		// issue or refresh a token. New 1.7 registrations create this link in the
		// plugin's own transaction.
		await client.query(
			`INSERT INTO public.auth_oauth_resource
				(id, identifier, name, "accessTokenTtl", "refreshTokenTtl",
				 "signingAlgorithm", "signingKeyId", "allowedScopes", "customClaims",
				 "dpopBoundAccessTokensRequired", disabled, "policyVersion", metadata,
				 "createdAt", "updatedAt")
			 VALUES ($1, $2, $2, NULL, NULL, NULL, NULL, NULL, NULL,
				 false, false, 1, NULL, now(), now())
			 ON CONFLICT (identifier) DO NOTHING`,
			[randomUUID(), MCP_RESOURCE_URL],
		);
		await client.query(
			`INSERT INTO public.auth_oauth_client_resource
				(id, "clientId", "resourceId", metadata, "createdAt")
			 SELECT 'nova-mcp-' || md5(c."clientId" || '|' || $1), c."clientId", $1, NULL, now()
			 FROM public.auth_oauth_client AS c
			 ON CONFLICT ("clientId", "resourceId") DO NOTHING`,
			[MCP_RESOURCE_URL],
		);

		if (needsRollingBridge) {
			await client.query(`
				CREATE OR REPLACE FUNCTION public.${ROLLING_APPLICATION_TYPE_FUNCTION}()
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
					IF NEW."clientCredentialsScopes" IS NULL THEN
						NEW."clientCredentialsScopes" := '[]'::jsonb;
					END IF;
					RETURN NEW;
				END;
				$$
			`);
			await client.query(
				`DROP TRIGGER IF EXISTS ${ROLLING_APPLICATION_TYPE_TRIGGER} ON public.auth_oauth_client`,
			);
			await client.query(`
				CREATE TRIGGER ${ROLLING_APPLICATION_TYPE_TRIGGER}
				BEFORE INSERT ON public.auth_oauth_client
				FOR EACH ROW EXECUTE FUNCTION public.${ROLLING_APPLICATION_TYPE_FUNCTION}()
			`);
			// The migration job runs while the old 1.6 revision still serves. Link
			// any client it registers after the backfill; once 1.7 owns traffic, its
			// native registration transaction observes the existing link and no-ops.
			await client.query(`
				CREATE OR REPLACE FUNCTION public.${ROLLING_RESOURCE_LINK_FUNCTION}()
				RETURNS trigger
				LANGUAGE plpgsql
				SECURITY DEFINER
				SET search_path = pg_catalog
				AS $$
				BEGIN
					INSERT INTO public.auth_oauth_client_resource
						(id, "clientId", "resourceId", metadata, "createdAt")
					VALUES (
						'nova-mcp-' || md5(NEW."clientId" || '|' || '${MCP_RESOURCE_URL}'),
						NEW."clientId",
						'${MCP_RESOURCE_URL}',
						NULL,
						now()
					)
					ON CONFLICT ("clientId", "resourceId") DO NOTHING;
					RETURN NEW;
				END;
				$$
			`);
			await client.query(
				`DROP TRIGGER IF EXISTS ${ROLLING_RESOURCE_LINK_TRIGGER} ON public.auth_oauth_client`,
			);
			await client.query(`
				CREATE TRIGGER ${ROLLING_RESOURCE_LINK_TRIGGER}
				AFTER INSERT ON public.auth_oauth_client
				FOR EACH ROW EXECUTE FUNCTION public.${ROLLING_RESOURCE_LINK_FUNCTION}()
			`);
		}
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
		await client.query(
			`UPDATE public.auth_oauth_client
			 SET "clientCredentialsScopes" = '[]'::jsonb
			 WHERE "clientCredentialsScopes" IS NULL`,
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

/**
 * Remove the two OAuth-client columns retired by Better Auth 1.7 and detach
 * every rolling-deploy trigger. This is a post-traffic finalizer, not part of
 * the pre-deploy migration: the old 1.6 revision names both columns in its
 * inserts and omits the new identity fields, so the bridge must remain until
 * that revision has zero traffic and its requests have drained.
 */
export async function finalizeBetterAuth17OauthClients(
	pool: Pool,
): Promise<BetterAuthOauthClientMigrationReport> {
	const initial = await scanBetterAuthOauthClients(pool);
	assertReady(initial);
	if (initial.state !== "current") {
		throw new Error(
			`Better Auth OAuth client finalization requires a current 1.7 data model; state=${initial.state}`,
		);
	}
	if (
		!initial.legacyPublicColumnPresent &&
		!initial.legacyTypeColumnPresent &&
		initial.rollingDeployTriggerCount === 0
	) {
		return initial;
	}

	const client = await pool.connect();
	try {
		await client.query("BEGIN");
		await client.query(
			"LOCK TABLE public.auth_account, public.auth_oauth_client IN ACCESS EXCLUSIVE MODE",
		);
		const locked = await scanBetterAuthOauthClients(client);
		assertReady(locked);
		if (locked.state !== "current") {
			throw new Error(
				`Better Auth OAuth client finalization lost its current precondition; state=${locked.state}`,
			);
		}
		await client.query(
			`ALTER TABLE public.auth_oauth_client
			 DROP COLUMN IF EXISTS "public",
			 DROP COLUMN IF EXISTS "type"`,
		);
		await client.query(
			"DROP TRIGGER IF EXISTS nova_auth_account_issuer_v17 ON public.auth_account",
		);
		await client.query(
			`DROP TRIGGER IF EXISTS ${ROLLING_APPLICATION_TYPE_TRIGGER} ON public.auth_oauth_client`,
		);
		await client.query(
			`DROP TRIGGER IF EXISTS ${ROLLING_RESOURCE_LINK_TRIGGER} ON public.auth_oauth_client`,
		);
		const finalized = await scanBetterAuthOauthClients(client);
		if (
			finalized.state !== "current" ||
			finalized.legacyPublicColumnPresent ||
			finalized.legacyTypeColumnPresent ||
			finalized.rollingDeployTriggerCount !== 0
		) {
			throw new Error(
				"Better Auth OAuth client finalization did not remove the retired columns and rolling-deploy triggers",
			);
		}
		await client.query("COMMIT");
		return finalized;
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
