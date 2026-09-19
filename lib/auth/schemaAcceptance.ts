// Better Auth checks its tables when a process starts and refuses every auth
// request while they differ from what it expects: a managed table or column is
// missing, or a managed table holds a required column Better Auth never writes.
// A new revision would discover that only after taking traffic. The migrate
// entrypoint asks the same question first, while a failure still stops the
// deploy.

import { getMigrations } from "better-auth/db/migration";
import type { Pool } from "pg";
import { authMigrateOptions } from "@/lib/auth-migrate-options";

export async function assertBetterAuthAcceptsSchema(pool: Pool): Promise<void> {
	const { schemaProblems, toBeCreated, toBeAdded } = await getMigrations(
		authMigrateOptions(pool),
	);
	const findings = [
		...schemaProblems,
		...toBeCreated.map(({ table }) => `Table "${table}" is missing.`),
		...toBeAdded.flatMap(({ table, fields }) =>
			Object.keys(fields).map(
				(field) => `Column "${field}" is missing from table "${table}".`,
			),
		),
	];
	if (findings.length === 0) return;
	throw new Error(
		[
			"The migrated database is not one Better Auth will serve.",
			"",
			...findings.map((finding) => `    ${finding}`),
			"",
			"Better Auth makes this check when a process starts and refuses every",
			"sign-in and session read until it passes, so the new revision would go",
			"dark for everyone. Its own migrator has already run, which means a Nova",
			"migration or an earlier Better Auth release left the tables this way.",
			"",
			"Hint: a column Better Auth does not write must accept NULL or carry a",
			"default. Fix it in a migration under `lib/case-store/migrations/` or",
			"`lib/auth/migrations/` and re-run `npm run db:migrate`.",
		].join("\n"),
	);
}
