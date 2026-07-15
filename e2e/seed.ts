/**
 * Smoke-suite seed (local Postgres only).
 *
 * Run against the local compose Postgres (`NOVA_DB_LOCAL_URL`) BEFORE Playwright
 * starts. It writes the minimum an authenticated smoke run needs, then emits a
 * Playwright `storageState` carrying a forged-but-valid session cookie:
 *
 *   1. an `auth_user` row (the signed-in Dimagi user),
 *   2. an `auth_session` row (a live, non-expired session token),
 *   3. one `complete` app to open in the builder, plus a handful of throwaway
 *      `complete` apps for the delete test to consume — all via the real no-LLM
 *      `createApp`, so the suite never calls Anthropic.
 *
 * Auth state and app/thread/run state both live in Postgres now (one store).
 * The delete test mutates seeded state irreversibly, and Playwright retries
 * tests in CI; seeding several throwaway apps (one per possible attempt) keeps
 * the delete test idempotent so a retry always has a fresh app to delete.
 *
 * SAFETY: refuses to run unless `NOVA_DB_LOCAL_URL` is set — the one gate that
 * keeps its writes on the local Postgres, never the real Cloud SQL instance
 * (which holds BOTH auth and app state).
 */
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { betterAuth } from "better-auth";
import type { Pool } from "pg";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { ensurePersonalProject } from "@/lib/auth/provisionProject";
import { authMigrateOptions } from "@/lib/auth-migrate-options";
import {
	closeCaseStoreDatabase,
	getCaseStorePool,
} from "@/lib/case-store/postgres/connection";
import { appendSyntheticBatch, createApp } from "@/lib/db/apps";
import { appendThreadResponse, upsertThreadTurn } from "@/lib/db/threads";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import { DELETE_APP_COUNT } from "./lib/config";
import { MP_SEED, seedMultiplayerFixture } from "./lib/multiplayerSeed";
import { buildSessionStorageState } from "./lib/session";

/** Stable identifiers the tests assert against (mirrored in `authed.spec.ts`). */
export const SEED = {
	userId: "smoke-user",
	userEmail: "smoke@dimagi.com",
	userName: "Smoke Test User",
	openAppName: "Smoke — Open Me",
	deleteAppName: "Smoke — Delete Me",
	/** Module-bearing app with a settled conversation — the smoke asserts the
	 *  transcript hydrates into the docked chat on load, lists in the
	 *  Conversations view, and survives a New chat → reopen round trip. */
	threadsAppName: "Smoke — Conversations",
	threadUserText: "Smoke: build a visit tracker",
	threadAssistantText: "Smoke: the visit tracker is ready.",
} as const;

const AUTH_DIR = path.join(process.cwd(), "e2e", ".auth");
const STATE_FILE = path.join(AUTH_DIR, "state.json");
const SEED_FILE = path.join(AUTH_DIR, "seed.json");
/** The two-user multiplayer fixture manifest (`multiplayer.spec.ts` reads it). */
const MULTIPLAYER_FILE = path.join(AUTH_DIR, "multiplayer.json");

function requireEnv(name: string): string {
	const value = process.env[name];
	if (!value) {
		throw new Error(
			`e2e/seed.ts: ${name} is required but unset. Run this through scripts/smoke.sh, which boots the local Postgres and exports the smoke env.`,
		);
	}
	return value;
}

/**
 * Delete the seed's OWN auth rows (idempotency for the persistent local
 * Postgres volume). Scoped to the exact fixed ids/slug this seed creates —
 * children (sessions, members) before parents (users, organizations) for FK
 * order — so a re-run starts clean without a blanket truncate that could
 * disturb another suite sharing the pool. A fresh CI volume deletes nothing.
 */
async function clearSeedAuthRows(pool: Pool): Promise<void> {
	const userIds = [
		SEED.userId,
		MP_SEED.userA.id,
		MP_SEED.userB.id,
		MP_SEED.userC.id,
		MP_SEED.userD.id,
	];
	// Every org this seed touches: the shared multiplayer Project + the personal
	// Project `ensurePersonalProject` mints for the single-user seed. Deleting
	// the org (not just its membership) lets `ensurePersonalProject` recreate it
	// WITH its owner membership — deleting only the membership would strand the
	// org and leave the re-run's user unable to resolve app scope.
	const orgSlugs = [
		`mp-shared-${MP_SEED.userA.id}`,
		...userIds.map((id) => `personal-${id}`),
	];
	await pool.query(`DELETE FROM auth_session WHERE "userId" = ANY($1)`, [
		userIds,
	]);
	await pool.query(`DELETE FROM auth_member WHERE "userId" = ANY($1)`, [
		userIds,
	]);
	await pool.query(
		`DELETE FROM auth_member WHERE "organizationId" IN
		(SELECT id FROM auth_organization WHERE slug = ANY($1))`,
		[orgSlugs],
	);
	await pool.query(`DELETE FROM auth_organization WHERE slug = ANY($1)`, [
		orgSlugs,
	]);
	await pool.query(`DELETE FROM auth_user WHERE id = ANY($1)`, [userIds]);
}

async function main(): Promise<void> {
	// Hard guard: only ever touch the local Postgres. `NOVA_DB_LOCAL_URL` is the
	// ONLY safety gate now — it protects BOTH the auth tables and the app-state
	// tables. Without it, a stray run with a real Cloud SQL connector would
	// write a forged session AND throwaway apps into production.
	if (!process.env.NOVA_DB_LOCAL_URL) {
		throw new Error(
			"e2e/seed.ts refuses to run without NOVA_DB_LOCAL_URL — it is the only guard keeping the seed's auth AND app-state writes on the local Postgres, never the real Cloud SQL instance.",
		);
	}
	const secret = requireEnv("BETTER_AUTH_SECRET");
	const baseUrl = process.env.SMOKE_BASE_URL ?? "http://localhost:3000";

	const now = new Date();
	// Opaque secret shared between the session row and the cookie.
	const token = randomBytes(32).toString("hex");
	const expiresAt = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000);

	// Auth state → Postgres, written through Better Auth's own adapter (same
	// schema config as production via `authMigrateOptions`). `getSession` loads
	// the user by `userId` and the session by its `token` field; the email-domain
	// allowlist only gates user *creation*, so a directly-seeded row reads fine.
	const pool = await getCaseStorePool();
	const auth = betterAuth({ ...authMigrateOptions(pool), secret });
	const ctx = await auth.$context;

	// The case-store Postgres volume PERSISTS across local runs (compose named
	// volume), so a re-run re-inserting the seed's FIXED-id rows would 23505 on
	// the primary key. Delete this seed's own rows first (children before
	// parents for FK order) so every run starts from a clean slate — scoped to
	// the exact ids/emails/slug the seed owns, never a blanket truncate that
	// could disturb a concurrent suite. A fresh CI volume no-ops these deletes.
	await clearSeedAuthRows(pool);

	await ctx.adapter.create({
		model: "user",
		forceAllowId: true,
		data: {
			id: SEED.userId,
			name: SEED.userName,
			email: SEED.userEmail,
			emailVerified: true,
			image: null,
			role: "user",
			banned: false,
			createdAt: now,
			updatedAt: now,
			lastActiveAt: now,
		},
	});
	await ctx.adapter.create({
		model: "session",
		data: {
			token,
			userId: SEED.userId,
			expiresAt,
			createdAt: now,
			updatedAt: now,
			ipAddress: "",
			userAgent: "smoke-test",
		},
	});

	// Personal Project for the seeded user — apps are tenant-scoped by it and the
	// listing reads (P2) query by project_id, so the seeded apps must carry the
	// same Project the user's session resolves to.
	const seedProjectId = await ensurePersonalProject(SEED.userId);

	// App state → Postgres, via the real no-LLM create path (status
	// `complete`), one throwaway "delete me" app per possible Playwright attempt.
	const openAppId = await createApp(SEED.userId, seedProjectId, randomUUID(), {
		appName: SEED.openAppName,
		status: "complete",
	});
	/* The conversations fixture: a module-bearing app (docked chat — the
	 * thread affordances live in the sidebar header) plus one settled
	 * conversation written through the real thread store (turn upsert +
	 * response append, live marker cleared) — exactly the rows a finished run
	 * leaves. The builder must hydrate the transcript on load. */
	const threadsAppId = await createApp(
		SEED.userId,
		seedProjectId,
		randomUUID(),
		{ appName: SEED.threadsAppName, status: "complete" },
	);
	await appendSyntheticBatch(
		threadsAppId,
		toPersistableDoc(
			buildDoc({
				appName: SEED.threadsAppName,
				modules: [
					{
						uuid: "0f000000-0000-4000-8000-000000000001",
						name: "Visits",
						forms: [
							{
								uuid: "0f000000-0000-4000-8000-000000000002",
								name: "Log visit",
								type: "survey",
								fields: [
									f({
										uuid: "0f000000-0000-4000-8000-000000000003",
										kind: "text",
										id: "visit_notes",
										label: "Visit notes",
									}),
								],
							},
						],
					},
				],
			}),
		),
	);
	const threadId = randomUUID();
	const threadStreamId = randomUUID();
	const written = await upsertThreadTurn({
		appId: threadsAppId,
		threadId,
		runId: randomUUID(),
		streamId: threadStreamId,
		threadType: "build",
		messages: [
			{
				id: "smoke-m1",
				role: "user",
				parts: [{ type: "text", text: SEED.threadUserText }],
			},
		],
	});
	if (!written) throw new Error("e2e/seed.ts: thread seed write failed");
	await appendThreadResponse({
		appId: threadsAppId,
		threadId,
		streamId: threadStreamId,
		responseMessage: {
			id: "smoke-m2",
			role: "assistant",
			parts: [{ type: "text", text: SEED.threadAssistantText }],
		},
	});
	const deleteAppIds: string[] = [];
	for (let i = 0; i < DELETE_APP_COUNT; i++) {
		deleteAppIds.push(
			await createApp(SEED.userId, seedProjectId, randomUUID(), {
				appName: SEED.deleteAppName,
				status: "complete",
			}),
		);
	}

	// Emit storageState (consumed by the `authed` Playwright project) + a seed
	// manifest the tests read for the concrete ids.
	const storageState = buildSessionStorageState({ token, secret, baseUrl });
	await mkdir(AUTH_DIR, { recursive: true });
	await writeFile(STATE_FILE, JSON.stringify(storageState, null, 2));
	await writeFile(
		SEED_FILE,
		JSON.stringify(
			{ ...SEED, openAppId, deleteAppIds, threadsAppId, baseUrl },
			null,
			2,
		),
	);

	// Two-user shared-Project fixture for the multiplayer acceptance spec —
	// reuses the same Better Auth instance (adapter + secret) and the same
	// cookie signer, and writes a `complete` shared app both members co-edit.
	const multiplayer = await seedMultiplayerFixture({
		ctx,
		secret,
		baseUrl,
		authDir: AUTH_DIR,
		writeFile,
		pathJoin: path.join,
	});
	await writeFile(MULTIPLAYER_FILE, JSON.stringify(multiplayer, null, 2));

	console.log(
		`[seed] user=${SEED.userId} openApp=${openAppId} deleteApps=${deleteAppIds.length}\n[seed] wrote ${path.relative(process.cwd(), STATE_FILE)} + ${path.relative(process.cwd(), SEED_FILE)}\n[seed] multiplayer app=${multiplayer.appId} project=shared users=${multiplayer.userA.id},${multiplayer.userB.id}`,
	);

	// Release the pg pool so the process exits promptly — an open pool would
	// otherwise keep the event loop alive and stall the
	// `tsx e2e/seed.ts && playwright test` chain.
	await closeCaseStoreDatabase();
}

main()
	.then(() => process.exit(0))
	.catch((err) => {
		console.error(err);
		process.exit(1);
	});
