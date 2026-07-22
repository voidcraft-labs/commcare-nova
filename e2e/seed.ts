/**
 * Smoke-suite seed (local Postgres only).
 *
 * Run against the local compose Postgres (`NOVA_DB_LOCAL_URL`) BEFORE Playwright
 * starts. It writes the minimum an authenticated smoke run needs, then emits a
 * Playwright `storageState` carrying a forged-but-valid session cookie:
 *
 *   1. an `auth_user` row (the signed-in Dimagi user),
 *   2. an `auth_session` row (a live, non-expired session token),
 *   3. one `complete` app to open in the builder, a populated patient workspace
 *      for Search / Results / Details visual QA, plus a handful of throwaway
 *      `complete` apps for the delete test to consume — all via real no-LLM
 *      storage paths, so the suite never calls a model.
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
import type { UIMessage } from "ai";
import { betterAuth } from "better-auth";
import type { Pool } from "pg";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { ensurePersonalProject } from "@/lib/auth/provisionProject";
import { authMigrateOptions } from "@/lib/auth-migrate-options";
import { withProjectContext } from "@/lib/case-store";
import {
	closeCaseStoreDatabase,
	getCaseStorePool,
} from "@/lib/case-store/postgres/connection";
import {
	appendSyntheticBatch,
	claimAndReserveRun,
	clearRunLockAndSettle,
	completeAndSettleRun,
	createApp,
} from "@/lib/db/apps";
import { materializeCaseStoreSchemas } from "@/lib/db/materializeCaseStoreSchemas";
import { appendThreadResponse, upsertThreadTurn } from "@/lib/db/threads";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import {
	buildCaseWorkspaceBlueprint,
	CASE_WORKSPACE_SEED,
	caseWorkspaceCaseRows,
	caseWorkspaceRoutes,
} from "./lib/caseWorkspaceSeed";
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
	olderThreadUserText: "Smoke: add an intake notes field",
	olderThreadAssistantText: "Smoke: the intake notes field is ready.",
	/** Module-bearing app for chat-scroll behavior: a tall settled conversation
	 *  (opens on load) plus a tall conversation paused on a waiting two-question
	 *  askQuestions card. Its sends are network-stubbed in the spec, so the
	 *  fixture never risks a model call. */
	scrollAppName: "Smoke — Scroll",
	scrollThreadUserText: "Smoke: tune the follow-up schedule",
	scrollThreadAssistantText: "Smoke: the follow-up schedule is tuned.",
	scrollQuestionThreadUserText: "Smoke: reshape the referral flow",
	scrollQuestionHeader: "Referral flow details",
	scrollQuestionOneText: "Who initiates a referral?",
	scrollQuestionTwoText: "When should a referral close?",
	scrollQuestionFinalOption: "After the visit is logged",
} as const;

const AUTH_DIR = path.join(process.cwd(), "e2e", ".auth");
const STATE_FILE = path.join(AUTH_DIR, "state.json");
const SEED_FILE = path.join(AUTH_DIR, "seed.json");
/** The two-user multiplayer fixture manifest (`multiplayer.spec.ts` reads it). */
const MULTIPLAYER_FILE = path.join(AUTH_DIR, "multiplayer.json");

/** A tall, realistic transcript makes the smoke fixture exercise the initial
 * bottom position instead of accidentally passing because two messages fit in
 * the rail. The final assistant turn is appended separately through the same
 * writer a completed run uses. */
function tallThreadHistory(prefix: string, firstUserText: string): UIMessage[] {
	const messages: UIMessage[] = [
		{
			id: `${prefix}-user-0`,
			role: "user",
			parts: [{ type: "text", text: firstUserText }],
		},
	];
	for (let turn = 1; turn <= 7; turn++) {
		messages.push(
			{
				id: `${prefix}-assistant-${turn}`,
				role: "assistant",
				parts: [
					{
						type: "text",
						text: `Smoke fixture response ${turn}: I reviewed the requested workflow and updated the app design with the relevant form details.`,
					},
				],
			},
			{
				id: `${prefix}-user-${turn}`,
				role: "user",
				parts: [
					{
						type: "text",
						text: `Smoke fixture follow-up ${turn}: please keep refining this conversation so the transcript remains tall enough to scroll.`,
					},
				],
			},
		);
	}
	return messages;
}

async function seedSettledThread(args: {
	appId: string;
	threadId: string;
	prefix: string;
	firstUserText: string;
	finalAssistantText: string;
	threadType: "build" | "edit";
	projectId: string;
}): Promise<void> {
	const streamId = randomUUID();
	const runId = randomUUID();
	const claimed = await claimAndReserveRun(
		args.appId,
		args.threadType,
		runId,
		SEED.userId,
		0,
		args.projectId,
	);
	const written = await upsertThreadTurn({
		appId: args.appId,
		threadId: args.threadId,
		runId,
		streamId,
		holderNonce: claimed.holderNonce,
		threadType: args.threadType,
		messages: tallThreadHistory(args.prefix, args.firstUserText),
	});
	if (!written) throw new Error("e2e/seed.ts: thread seed write failed");
	const releaseOutcome =
		args.threadType === "build"
			? await completeAndSettleRun(args.appId, runId, claimed.holderNonce)
			: await clearRunLockAndSettle(args.appId, runId, claimed.holderNonce);
	if (releaseOutcome !== "owned") {
		throw new Error(`e2e/seed.ts: thread seed lost holder (${releaseOutcome})`);
	}
	await appendThreadResponse({
		appId: args.appId,
		threadId: args.threadId,
		streamId,
		responseMessage: {
			id: `${args.prefix}-assistant-final`,
			role: "assistant",
			parts: [{ type: "text", text: args.finalAssistantText }],
		},
	});
}

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

	/* Full Search / Results / Details visual-QA fixture. The authored ids and
	 * patient values are stable; the app + case ids are minted by their real
	 * stores and written into seed.json for exact deep links. Materialize before
	 * inserting so the fixture exercises the same schema gate as live case data. */
	const caseWorkspaceAppId = await createApp(
		SEED.userId,
		seedProjectId,
		randomUUID(),
		{ appName: CASE_WORKSPACE_SEED.appName, status: "complete" },
	);
	const caseWorkspaceDoc = toPersistableDoc(
		buildCaseWorkspaceBlueprint(caseWorkspaceAppId),
	);
	await appendSyntheticBatch({
		appId: caseWorkspaceAppId,
		expectedBaseSeq: 0,
		targetDoc: caseWorkspaceDoc,
		authority: { kind: "user", actorUserId: SEED.userId },
	});
	await materializeCaseStoreSchemas({
		appId: caseWorkspaceAppId,
		blueprint: caseWorkspaceDoc,
		// A newly-created app starts at seq 0; appendSyntheticBatch advances it once.
		syncedSeq: 1,
	});
	const caseStore = await withProjectContext(seedProjectId, SEED.userId);
	const caseWorkspaceCaseIds: string[] = [];
	for (const row of caseWorkspaceCaseRows()) {
		const inserted = await caseStore.insert({
			appId: caseWorkspaceAppId,
			row,
		});
		caseWorkspaceCaseIds.push(inserted.caseId);
	}
	const firstCaseId = caseWorkspaceCaseIds[0];
	if (!firstCaseId) {
		throw new Error("e2e/seed.ts: patient workspace seeded no case rows");
	}
	const caseWorkspace = {
		appId: caseWorkspaceAppId,
		moduleUuid: CASE_WORKSPACE_SEED.moduleUuid,
		caseType: CASE_WORKSPACE_SEED.caseType,
		columnUuids: CASE_WORKSPACE_SEED.columns,
		searchInputUuids: CASE_WORKSPACE_SEED.searchInputs,
		caseIds: caseWorkspaceCaseIds,
		caseCount: caseWorkspaceCaseIds.length,
		routes: caseWorkspaceRoutes(caseWorkspaceAppId, firstCaseId),
	};
	/* The conversations fixture: a module-bearing app (docked chat) plus two
	 * tall, settled conversations written through the real thread store (turn
	 * upsert + response append, live marker cleared) — exactly the rows finished
	 * runs leave. The builder must hydrate the newest transcript on load and
	 * switch to the older one without exposing the prior transcript. */
	const threadsAppId = await createApp(
		SEED.userId,
		seedProjectId,
		randomUUID(),
		{ appName: SEED.threadsAppName, status: "complete" },
	);
	await appendSyntheticBatch({
		appId: threadsAppId,
		expectedBaseSeq: 0,
		authority: { kind: "user", actorUserId: SEED.userId },
		targetDoc: toPersistableDoc(
			buildDoc({
				appId: threadsAppId,
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
	});
	const olderThreadId = randomUUID();
	await seedSettledThread({
		appId: threadsAppId,
		threadId: olderThreadId,
		prefix: "smoke-older",
		firstUserText: SEED.olderThreadUserText,
		finalAssistantText: SEED.olderThreadAssistantText,
		threadType: "edit",
		projectId: seedProjectId,
	});
	const threadId = randomUUID();
	await seedSettledThread({
		appId: threadsAppId,
		threadId,
		prefix: "smoke-current",
		firstUserText: SEED.threadUserText,
		finalAssistantText: SEED.threadAssistantText,
		threadType: "build",
		projectId: seedProjectId,
	});
	/* Stable ordering even when both writes land in the same millisecond. */
	await pool.query(
		`UPDATE threads SET updated_at = CASE
			WHEN thread_id = $1 THEN $3
			WHEN thread_id = $2 THEN $4
			ELSE updated_at
		END
		WHERE thread_id = ANY($5)`,
		[
			olderThreadId,
			threadId,
			new Date(Date.now() - 60_000).toISOString(),
			new Date().toISOString(),
			[olderThreadId, threadId],
		],
	);
	/* The scroll fixture: same module-bearing shape as the conversations app,
	 * with the two transcripts the scroll spec drives — a settled conversation
	 * that opens on load, and an older one paused on a WAITING askQuestions
	 * card. The paused round persists exactly as a real one does: the turn
	 * upsert marks the thread live, and the response append (the assistant
	 * message carrying the input-available tool part) retires the marker — so
	 * opening it must not attempt a stream resume. */
	const scrollAppId = await createApp(
		SEED.userId,
		seedProjectId,
		randomUUID(),
		{ appName: SEED.scrollAppName, status: "complete" },
	);
	await appendSyntheticBatch({
		appId: scrollAppId,
		expectedBaseSeq: 0,
		authority: { kind: "user", actorUserId: SEED.userId },
		targetDoc: toPersistableDoc(
			buildDoc({
				appId: scrollAppId,
				appName: SEED.scrollAppName,
				modules: [
					{
						uuid: "0f000000-0000-4000-8000-000000000011",
						name: "Referrals",
						forms: [
							{
								uuid: "0f000000-0000-4000-8000-000000000012",
								name: "Log referral",
								type: "survey",
								fields: [
									f({
										uuid: "0f000000-0000-4000-8000-000000000013",
										kind: "text",
										id: "referral_notes",
										label: "Referral notes",
									}),
								],
							},
						],
					},
				],
			}),
		),
	});
	const scrollQuestionThreadId = randomUUID();
	{
		const streamId = randomUUID();
		const runId = randomUUID();
		const claimed = await claimAndReserveRun(
			scrollAppId,
			"edit",
			runId,
			SEED.userId,
			0,
			seedProjectId,
		);
		const written = await upsertThreadTurn({
			appId: scrollAppId,
			threadId: scrollQuestionThreadId,
			runId,
			streamId,
			holderNonce: claimed.holderNonce,
			threadType: "edit",
			messages: tallThreadHistory(
				"smoke-scroll-q",
				SEED.scrollQuestionThreadUserText,
			),
		});
		if (!written) {
			throw new Error("e2e/seed.ts: scroll question thread seed write failed");
		}
		const releaseOutcome = await clearRunLockAndSettle(
			scrollAppId,
			runId,
			claimed.holderNonce,
		);
		if (releaseOutcome !== "owned") {
			throw new Error(
				`e2e/seed.ts: scroll question thread lost holder (${releaseOutcome})`,
			);
		}
		await appendThreadResponse({
			appId: scrollAppId,
			threadId: scrollQuestionThreadId,
			streamId,
			responseMessage: {
				id: "smoke-scroll-q-assistant-final",
				role: "assistant",
				parts: [
					{ type: "step-start" },
					{
						type: "text",
						text: "Smoke: two quick questions before I make the change.",
					},
					{
						type: "tool-askQuestions",
						toolCallId: "smoke-scroll-q-ask-1",
						state: "input-available",
						input: {
							header: SEED.scrollQuestionHeader,
							questions: [
								{
									question: SEED.scrollQuestionOneText,
									options: [
										{ label: "Community health workers" },
										{ label: "Facility staff" },
									],
								},
								{
									question: SEED.scrollQuestionTwoText,
									options: [
										{ label: SEED.scrollQuestionFinalOption },
										{ label: "After thirty days" },
									],
								},
							],
						},
					},
				],
			} as UIMessage,
		});
	}
	const scrollThreadId = randomUUID();
	await seedSettledThread({
		appId: scrollAppId,
		threadId: scrollThreadId,
		prefix: "smoke-scroll",
		firstUserText: SEED.scrollThreadUserText,
		finalAssistantText: SEED.scrollThreadAssistantText,
		threadType: "edit",
		projectId: seedProjectId,
	});
	/* Stable ordering even when both writes land in the same millisecond. */
	await pool.query(
		`UPDATE threads SET updated_at = CASE
			WHEN thread_id = $1 THEN $3
			WHEN thread_id = $2 THEN $4
			ELSE updated_at
		END
		WHERE thread_id = ANY($5)`,
		[
			scrollQuestionThreadId,
			scrollThreadId,
			new Date(Date.now() - 60_000).toISOString(),
			new Date().toISOString(),
			[scrollQuestionThreadId, scrollThreadId],
		],
	);
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
			{
				...SEED,
				openAppId,
				caseWorkspace,
				deleteAppIds,
				threadsAppId,
				olderThreadId,
				scrollAppId,
				scrollQuestionThreadId,
				baseUrl,
			},
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
		`[seed] user=${SEED.userId} openApp=${openAppId} deleteApps=${deleteAppIds.length}\n[seed] caseWorkspace app=${caseWorkspace.appId} cases=${caseWorkspace.caseCount} results=${caseWorkspace.routes.results}\n[seed] wrote ${path.relative(process.cwd(), STATE_FILE)} + ${path.relative(process.cwd(), SEED_FILE)}\n[seed] multiplayer app=${multiplayer.appId} project=shared users=${multiplayer.userA.id},${multiplayer.userB.id}`,
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
