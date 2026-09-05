// Applies Nova's auth-app migrations (the Nova-OWNED auth tables Better Auth's
// migrator doesn't manage — see `lib/auth/migrations`). Run from the migrate
// entrypoint AFTER Better Auth's own migrator. Kept in its own ledger table
// (`auth_app_kysely_migration`) so it's independent of the case-store ledger and
// Better Auth's introspection. Mirrors `lib/case-store/migrate.ts`'s shape.

import { type Kysely, sql } from "kysely";
import { Migrator } from "kysely/migration";
import { MCP_RESOURCE_URL } from "@/lib/hostnames";
import { authAppMigrationProvider } from "./migrations";

export async function runAuthAppMigrations(db: Kysely<unknown>): Promise<void> {
	const migrator = new Migrator({
		db,
		provider: authAppMigrationProvider,
		migrationTableName: "auth_app_kysely_migration",
		migrationLockTableName: "auth_app_kysely_migration_lock",
	});
	const { error, results } = await migrator.migrateToLatest();

	const failed = results?.find((r) => r.status === "Error");
	if (error === undefined && failed === undefined) {
		// This is ongoing resource configuration, not the retired 1.7 client
		// backfill. New databases need the same resource the runtime registers
		// clients against. Preserve any existing operator policy on that row.
		await sql`
			INSERT INTO public.auth_oauth_resource
				(id, identifier, name, "accessTokenTtl", "refreshTokenTtl",
				 "signingAlgorithm", "signingKeyId", "allowedScopes", "customClaims",
				 "dpopBoundAccessTokensRequired", disabled, "policyVersion", metadata,
				 "createdAt", "updatedAt")
			VALUES (gen_random_uuid()::text, ${MCP_RESOURCE_URL}, ${MCP_RESOURCE_URL},
				NULL, NULL, NULL, NULL, NULL, NULL, false, false, 1, NULL, now(), now())
			ON CONFLICT (identifier) DO NOTHING
		`.execute(db);
		return;
	}

	const applied =
		results?.map((r) => `${r.migrationName} (${r.status})`).join(", ") ??
		"(none)";
	const reason =
		error instanceof Error
			? error.message
			: String(error ?? "(no error object)");
	throw new Error(
		[
			failed
				? `Auth-app migration "${failed.migrationName}" failed.`
				: "The auth-app migrator failed.",
			"",
			`    reason:  ${reason}`,
			`    applied: ${applied}`,
			"",
			"Hint: inspect the failing module under `lib/auth/migrations/` and re-run",
			"`npm run db:migrate` against a scratch database to reproduce.",
		].join("\n"),
	);
}
