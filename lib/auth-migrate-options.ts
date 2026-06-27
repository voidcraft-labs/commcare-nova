// Schema-only Better Auth options for the migrate Job (`getMigrations(...)
// .runMigrations()`). Deliberately MCP-FREE: it does NOT import
// `novaMcpPlugin` (whose graph pulls the whole MCP tool/dispatch surface),
// so the esbuild-bundled `scripts/migrate.ts` stays lean. The generated schema
// depends only on the model `modelName` map + the set of table-defining plugins
// — NOT on behavioral config — so the scopes / key-length / rate-limit options
// the runtime `lib/auth.ts` carries are omitted here.
//
// Drift safety: table names come from the shared `AUTH_TABLE_NAMES`, so they
// can't diverge from the runtime config; the plugin SET must be kept in sync
// with `lib/auth.ts` by hand, and the auth integration tests (which run the
// real auth against this migrated schema) fail loudly if a needed table is
// missing.

import { apiKey } from "@better-auth/api-key";
import { oauthProvider } from "@better-auth/oauth-provider";
import type { BetterAuthOptions } from "better-auth";
import { admin, jwt, organization } from "better-auth/plugins";
import type { Pool } from "pg";
import { AUTH_TABLE_NAMES, ORGANIZATION_SCHEMA } from "./auth-schema-shared";

export function authMigrateOptions(database: Pool): BetterAuthOptions {
	return {
		// `getMigrations` runs plugin init (the oauth-provider plugin builds a URL
		// from baseURL), so both are required — but neither affects the generated
		// tables.
		secret: process.env.BETTER_AUTH_SECRET ?? "migrate-only-secret-unused",
		baseURL: process.env.BETTER_AUTH_URL ?? "http://localhost",
		database,
		user: {
			modelName: AUTH_TABLE_NAMES.user,
			// Adds the `lastActiveAt` column the runtime's `touchUser` writes — MUST
			// match `lib/auth.ts` user.additionalFields.
			additionalFields: {
				lastActiveAt: { type: "date", required: false, input: false },
			},
		},
		session: { modelName: AUTH_TABLE_NAMES.session },
		account: { modelName: AUTH_TABLE_NAMES.account },
		verification: { modelName: AUTH_TABLE_NAMES.verification },
		rateLimit: { storage: "database", modelName: AUTH_TABLE_NAMES.rateLimit },
		plugins: [
			admin(),
			jwt({ schema: { jwks: { modelName: AUTH_TABLE_NAMES.jwks } } }),
			oauthProvider({
				// loginPage/consentPage are required by the plugin's type + init, but
				// don't affect the generated schema.
				loginPage: "/",
				consentPage: "/consent",
				schema: {
					oauthClient: { modelName: AUTH_TABLE_NAMES.oauthClient },
					oauthConsent: { modelName: AUTH_TABLE_NAMES.oauthConsent },
					oauthRefreshToken: {
						modelName: AUTH_TABLE_NAMES.oauthRefreshToken,
					},
					oauthAccessToken: { modelName: AUTH_TABLE_NAMES.oauthAccessToken },
				},
			}),
			apiKey({ schema: { apikey: { modelName: AUTH_TABLE_NAMES.apikey } } }),
			// Organization → "Projects" tenancy. Schema-only mirror of the runtime
			// config in lib/auth.ts: the generated tables depend on the modelNames
			// + the teams flag, NOT on roles/ac (static AC adds no table), so those
			// are omitted here. MUST stay in sync with lib/auth.ts's plugin set.
			organization({
				teams: { enabled: false },
				schema: ORGANIZATION_SCHEMA,
				sendInvitationEmail: async () => {},
			}),
		],
	} satisfies BetterAuthOptions;
}
