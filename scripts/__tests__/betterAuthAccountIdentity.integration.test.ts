import { getMigrations } from "better-auth/db/migration";
import { describe, expect, it } from "vitest";
import { authMigrateOptions } from "@/lib/auth-migrate-options";
import { setupPerTestDatabase } from "@/lib/case-store/sql/__tests__/perTestDatabase";
import {
	GOOGLE_ACCOUNT_ISSUER,
	migrateBetterAuthAccountIdentity,
	scanBetterAuthAccountIdentity,
} from "@/scripts/lib/betterAuthAccountIdentity";

const dbHandle = setupPerTestDatabase({
	databaseNamePrefix: "better_auth_identity_",
});

async function createLegacyAccountTable(): Promise<void> {
	await dbHandle.pool.query(`
		CREATE TABLE public.auth_account (
			id text PRIMARY KEY,
			"accountId" text NOT NULL,
			"providerId" text NOT NULL,
			"userId" text NOT NULL,
			"createdAt" timestamptz NOT NULL DEFAULT now(),
			"updatedAt" timestamptz NOT NULL DEFAULT now()
		)
	`);
}

async function seedGoogleAccount(
	id: string,
	accountId: string,
	userId: string,
): Promise<void> {
	await dbHandle.pool.query(
		`INSERT INTO public.auth_account (id, "accountId", "providerId", "userId")
		 VALUES ($1, $2, 'google', $3)`,
		[id, accountId, userId],
	);
}

describe("Better Auth account identity scan-then-migrate", () => {
	it("no-ops before Better Auth creates a fresh account table", async () => {
		expect((await scanBetterAuthAccountIdentity(dbHandle.pool)).state).toBe(
			"absent",
		);
		expect((await migrateBetterAuthAccountIdentity(dbHandle.pool)).state).toBe(
			"absent",
		);
	});

	it("backfills Google, admits the 1.7 migrator, and protects a rolling insert", async () => {
		await createLegacyAccountTable();
		await seedGoogleAccount("account-a", "google-sub-a", "user-a");

		const before = await scanBetterAuthAccountIdentity(dbHandle.pool);
		expect(before).toMatchObject({
			state: "legacy-ready",
			accountCount: 1,
			providers: [{ provider: "google", count: 1 }],
		});

		const migrated = await migrateBetterAuthAccountIdentity(dbHandle.pool);
		expect(migrated).toMatchObject({
			state: "current",
			issuerRequired: true,
			issuerAccountIndexPresent: true,
		});

		// The production deploy runs Better Auth's generic migration next. This
		// proves it accepts the exact issuer column/index instead of planning a
		// conflicting schema change or throwing UnsafeMigrationError.
		const { runMigrations } = await getMigrations(
			authMigrateOptions(dbHandle.pool),
		);
		await runMigrations();

		// Simulate a request that reaches the old 1.6 revision after the schema
		// Job commits: it omits issuer, and the rolling-deploy trigger supplies it.
		await seedGoogleAccount("account-b", "google-sub-b", "user-b");
		const inserted = await dbHandle.pool.query<{
			issuer: string;
		}>("SELECT issuer FROM public.auth_account WHERE id = $1", ["account-b"]);
		expect(inserted.rows[0]?.issuer).toBe(GOOGLE_ACCOUNT_ISSUER);
		expect((await scanBetterAuthAccountIdentity(dbHandle.pool)).state).toBe(
			"current",
		);
	});

	it("fails closed on an unmapped legacy provider without changing the schema", async () => {
		await createLegacyAccountTable();
		await dbHandle.pool.query(
			`INSERT INTO public.auth_account (id, "accountId", "providerId", "userId")
			 VALUES ('account-a', 'subject-a', 'unreviewed', 'user-a')`,
		);

		const report = await scanBetterAuthAccountIdentity(dbHandle.pool);
		expect(report.state).toBe("blocked");
		expect(report.issues).toContain("unsupported legacy providers: unreviewed");
		await expect(
			migrateBetterAuthAccountIdentity(dbHandle.pool),
		).rejects.toThrow(/unsupported legacy providers: unreviewed/);
		const issuerColumn = await dbHandle.pool.query(
			"SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'auth_account' AND column_name = 'issuer'",
		);
		expect(issuerColumn.rowCount).toBe(0);
	});

	it("blocks projected identity collisions before any write", async () => {
		await createLegacyAccountTable();
		await seedGoogleAccount("account-a", "same-sub", "user-a");
		await seedGoogleAccount("account-b", "same-sub", "user-b");

		const report = await scanBetterAuthAccountIdentity(dbHandle.pool);
		expect(report).toMatchObject({
			state: "blocked",
			projectedIdentityCollisions: 1,
		});
		await expect(
			migrateBetterAuthAccountIdentity(dbHandle.pool),
		).rejects.toThrow(/projected issuer\/account identity collision/);
	});
});
