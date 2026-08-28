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
 *      for Search / Results / Details visual QA, retry-isolated case-change
 *      universes, plus throwaway `complete` apps for destructive journeys —
 *      all via real no-LLM storage paths, so the suite never calls a model.
 *
 * Auth state and app/thread/run state both live in Postgres now (one store).
 * Several journeys mutate seeded state irreversibly, and Playwright retries
 * tests in CI; seeding one isolated target per possible attempt keeps every
 * retry away from the preceding attempt's already-changed state.
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
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import { getAuthDb } from "@/lib/auth/db";
import { ensurePersonalProject } from "@/lib/auth/provisionProject";
import { authMigrateOptions } from "@/lib/auth-migrate-options";
import { withProjectContext } from "@/lib/case-store";
import {
	closeCaseStoreDatabase,
	getCaseStorePool,
} from "@/lib/case-store/postgres/connection";
import { createExplicitBlankApp } from "@/lib/db/appGenesis";
import {
	appendSyntheticBatch,
	claimAndReserveRun,
	clearRunLockAndSettle,
	completeAndSettleRun,
} from "@/lib/db/apps";
import { materializeCaseStoreSchemas } from "@/lib/db/materializeCaseStoreSchemas";
import { persistResponseSnapshot, upsertThreadTurn } from "@/lib/db/threads";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import { proseText } from "@/lib/domain/prose";
import { createLookupRow, createLookupTable } from "@/lib/lookup/service";
import { buildUrl } from "@/lib/routing/location";
import {
	buildCaseChangesBlueprint,
	CASE_CHANGES_SEED,
	caseChangesRoute,
	identityProjectionRoute,
} from "./lib/caseChangesSeed";
import {
	buildCaseWorkspaceBlueprint,
	CASE_WORKSPACE_SEED,
	caseWorkspaceCaseRows,
	caseWorkspaceHouseholdRows,
	caseWorkspaceRoutes,
	caseWorkspaceVisitRows,
} from "./lib/caseWorkspaceSeed";
import {
	CASE_CHANGES_FIXTURE_COUNT,
	DELETE_APP_COUNT,
	FORM_LINKS_FIXTURE_COUNT,
	MOVE_APP_COUNT,
	ORGANIZATION_FIXTURE_COUNT,
} from "./lib/config";
import {
	buildFormLinksBlueprint,
	FORM_LINKS_SEED,
	formLinksRoute,
} from "./lib/formLinksSeed";
import {
	buildFormSectionsBlueprint,
	FORM_SECTIONS_SEED,
	formSectionsRoute,
} from "./lib/formSectionsSeed";
import { MP_SEED, seedMultiplayerFixture } from "./lib/multiplayerSeed";
import {
	buildReactProfileBlueprint,
	reactProfileInitialRoute,
	reactProfileRoute,
} from "./lib/reactProfileSeed";
import { buildSessionStorageState } from "./lib/session";

/** Stable identifiers the tests assert against (mirrored in `authed.spec.ts`). */
export const SEED = {
	userId: "smoke-user",
	userEmail: "smoke@dimagi.com",
	userName: "Smoke Test User",
	viewerUserId: "smoke-viewer",
	viewerUserEmail: "smoke-viewer@dimagi.com",
	viewerUserName: "Smoke Test Viewer",
	openAppName: "Smoke — Open Me",
	organizationAppName: "Smoke — Organization",
	deleteAppName: "Smoke — Delete Me",
	/** Cross-Project move journey: one app plus a second Project the seeded user
	 *  also owns, so the spec drives a real move between two governed places. */
	moveAppName: "Smoke — Move Me",
	moveProjectName: "Smoke Destination",
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
	/** A real sequence-one app activated by a completely scripted chat stream.
	 * The browser test exercises the design/build UI without reaching a model. */
	designBuildAppName: "Smoke — Scripted Design Build",
} as const;

/** Fixed slug so a re-run replaces the destination Project rather than piling up. */
const MOVE_DESTINATION_SLUG = `move-destination-${SEED.userId}`;

const AUTH_DIR = path.join(process.cwd(), "e2e", ".auth");
const STATE_FILE = path.join(AUTH_DIR, "state.json");
const VIEWER_STATE_FILE = path.join(AUTH_DIR, "state-viewer.json");
const SEED_FILE = path.join(AUTH_DIR, "seed.json");
/** The two-user multiplayer fixture manifest (`multiplayer.spec.ts` reads it). */
const MULTIPLAYER_FILE = path.join(AUTH_DIR, "multiplayer.json");

/** Case-aware starter for the organization journey. Its single follow-up form
 * lets the browser author both fixed-place and reverse-hop case owners after it
 * has built the location tree; no model call or test-only UI path is involved. */
function buildOrganizationBlueprint(appId: string) {
	const doc = buildDoc({
		appName: SEED.organizationAppName,
		caseTypes: [
			{
				name: "patient",
				properties: [{ name: "case_name", label: "Name" }],
			},
		],
		modules: [
			{
				name: "Patients",
				caseType: "patient",
				caseListConfig: caseListConfig([
					{ field: "case_name", header: "Name" },
				]),
				forms: [
					{
						name: "Visit",
						type: "followup",
						fields: [f({ kind: "text", id: "note", label: proseText("Note") })],
					},
				],
			},
		],
	});
	doc.appId = appId;
	return doc;
}

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
		target: { kind: "app", appId: args.appId },
		threadId: args.threadId,
		runId,
		streamId,
		holderNonce: claimed.holderNonce,
		threadType: args.threadType,
		messages: tallThreadHistory(args.prefix, args.firstUserText),
		expectedProjectId: args.projectId,
	});
	if (!written) throw new Error("e2e/seed.ts: thread seed write failed");
	const releaseOutcome =
		args.threadType === "build"
			? await completeAndSettleRun(args.appId, runId, claimed.holderNonce)
			: await clearRunLockAndSettle(args.appId, runId, claimed.holderNonce);
	if (releaseOutcome !== "owned") {
		throw new Error(`e2e/seed.ts: thread seed lost holder (${releaseOutcome})`);
	}
	await persistResponseSnapshot({
		target: { kind: "app", appId: args.appId },
		threadId: args.threadId,
		streamId,
		expectedProjectId: args.projectId,
		clearMarker: true,
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
		SEED.viewerUserId,
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
		MOVE_DESTINATION_SLUG,
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

/**
 * A second Project the seeded user owns — the move journey's destination.
 * Mirrors `ensurePersonalProject`'s shape without the `personal` marker, so the
 * Project switcher and the placement policy both treat it as an ordinary
 * shared Project.
 */
async function seedMoveDestinationProject(): Promise<string> {
	const db = await getAuthDb();
	const organizationId = randomUUID();
	await db.transaction().execute(async (tx) => {
		await tx
			.insertInto("auth_organization")
			.values({
				id: organizationId,
				name: SEED.moveProjectName,
				slug: MOVE_DESTINATION_SLUG,
				logo: null,
				metadata: null,
				createdAt: new Date(),
			})
			.execute();
		await tx
			.insertInto("auth_member")
			.values({
				id: randomUUID(),
				organizationId,
				userId: SEED.userId,
				role: "owner",
				createdAt: new Date(),
			})
			.execute();
	});
	return organizationId;
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
	const viewerToken = randomBytes(32).toString("hex");
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
	await ctx.adapter.create({
		model: "user",
		forceAllowId: true,
		data: {
			id: SEED.viewerUserId,
			name: SEED.viewerUserName,
			email: SEED.viewerUserEmail,
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
			token: viewerToken,
			userId: SEED.viewerUserId,
			expiresAt,
			createdAt: now,
			updatedAt: now,
			ipAddress: "",
			userAgent: "smoke-test-viewer",
		},
	});

	// Personal Project for the seeded user — apps are tenant-scoped by it and the
	// listing reads (P2) query by project_id, so the seeded apps must carry the
	// same Project the user's session resolves to.
	const seedProjectId = await ensurePersonalProject(SEED.userId);
	await ensurePersonalProject(SEED.viewerUserId);
	await ctx.adapter.create({
		model: "member",
		data: {
			organizationId: seedProjectId,
			userId: SEED.viewerUserId,
			role: "viewer",
			createdAt: now,
		},
	});

	// App state → Postgres, via the real no-LLM create path (status
	// `complete`), one throwaway "delete me" app per possible Playwright attempt.
	const { appId: openAppId } = await createExplicitBlankApp(
		SEED.userId,
		seedProjectId,
		randomUUID(),
		{
			name: SEED.openAppName,
			status: "complete",
		},
	);
	const reactProfile =
		process.env.NOVA_REACT_PROFILE === "1"
			? await (async () => {
					const { appId, baseSeq } = await createExplicitBlankApp(
						SEED.userId,
						seedProjectId,
						randomUUID(),
						{
							name: "React profile large app",
							status: "complete",
						},
					);
					const fixture = buildReactProfileBlueprint(appId, {
						casePropertyCount:
							process.env.NOVA_REACT_PROFILE_CASE_PROPERTIES === undefined
								? undefined
								: Number(process.env.NOVA_REACT_PROFILE_CASE_PROPERTIES),
					});
					await appendSyntheticBatch({
						appId,
						expectedBaseSeq: baseSeq,
						targetDoc: toPersistableDoc(fixture.doc),
						authority: { kind: "user", actorUserId: SEED.userId },
					});
					return {
						appId,
						moduleUuid: fixture.moduleUuid,
						initialFormUuid: fixture.initialFormUuid,
						initialRoute: reactProfileInitialRoute(appId, fixture),
						targetFormUuid: fixture.targetFormUuid,
						targetFieldUuid: fixture.targetFieldUuid,
						targetRoute: reactProfileRoute(appId, fixture),
					};
				})()
			: undefined;
	const organizationAppIds: string[] = [];
	const organizationCaseChangeRoutes: string[] = [];
	for (let i = 0; i < ORGANIZATION_FIXTURE_COUNT; i++) {
		const { appId, baseSeq } = await createExplicitBlankApp(
			SEED.userId,
			seedProjectId,
			randomUUID(),
			{
				name: SEED.organizationAppName,
				status: "complete",
			},
		);
		const organizationDoc = buildOrganizationBlueprint(appId);
		await appendSyntheticBatch({
			appId,
			expectedBaseSeq: baseSeq,
			targetDoc: toPersistableDoc(organizationDoc),
			authority: { kind: "user", actorUserId: SEED.userId },
		});
		const moduleUuid = organizationDoc.moduleOrder[0];
		const formUuid = organizationDoc.formOrder[moduleUuid]?.[0];
		if (moduleUuid === undefined || formUuid === undefined) {
			throw new Error("Organization smoke fixture has no follow-up form.");
		}
		organizationAppIds.push(appId);
		organizationCaseChangeRoutes.push(
			buildUrl(`/build/${appId}`, {
				kind: "form-operations",
				moduleUuid,
				formUuid,
			}),
		);
	}

	/* Full Search / Results / Details visual-QA fixture. The authored ids and
	 * patient values are stable; the app + case ids are minted by their real
	 * stores and written into seed.json for exact deep links. Materialize before
	 * inserting so the fixture exercises the same schema gate as live case data. */
	const { appId: caseWorkspaceAppId, baseSeq: caseWorkspaceGenesisSeq } =
		await createExplicitBlankApp(SEED.userId, seedProjectId, randomUUID(), {
			name: CASE_WORKSPACE_SEED.appName,
			status: "complete",
		});
	const caseWorkspaceDoc = toPersistableDoc(
		buildCaseWorkspaceBlueprint(caseWorkspaceAppId),
	);
	await appendSyntheticBatch({
		appId: caseWorkspaceAppId,
		expectedBaseSeq: caseWorkspaceGenesisSeq,
		targetDoc: caseWorkspaceDoc,
		authority: { kind: "user", actorUserId: SEED.userId },
	});
	await materializeCaseStoreSchemas({
		appId: caseWorkspaceAppId,
		blueprint: caseWorkspaceDoc,
		syncedSeq: caseWorkspaceGenesisSeq + 1,
	});
	const caseStore = await withProjectContext(
		seedProjectId,
		SEED.userId,
		SEED.userId,
	);
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
	/* The grouped module's own population. Households land first so their
	 * minted ids can be the visits' `parent` connection — the same edge
	 * `string(./index/parent)` reads on the device. */
	const householdIds: string[] = [];
	for (const row of caseWorkspaceHouseholdRows()) {
		const inserted = await caseStore.insert({
			appId: caseWorkspaceAppId,
			row,
		});
		householdIds.push(inserted.caseId);
	}
	for (const row of caseWorkspaceVisitRows(householdIds)) {
		await caseStore.insert({ appId: caseWorkspaceAppId, row });
	}
	/* One Project data table for the smoke's primary gesture: open the
	 * workspace, open the table, then bind a select to a column of it. Written
	 * through the real service so its counters, order keys, and revisions are
	 * the ones a live table has — a hand-inserted row would let the workspace
	 * read a table no writer could have produced. */
	const lookupScope = {
		projectId: seedProjectId,
		actorId: SEED.userId,
		role: "owner" as const,
	};
	const referralTable = await createLookupTable(lookupScope, {
		name: CASE_WORKSPACE_SEED.lookupTableName,
		tag: CASE_WORKSPACE_SEED.lookupTableTag,
		columns: [
			{
				wireName: "code",
				label: CASE_WORKSPACE_SEED.lookupValueColumnLabel,
				dataType: "text",
			},
			{
				wireName: "destination",
				label: CASE_WORKSPACE_SEED.lookupLabelColumnLabel,
				dataType: "text",
			},
			{
				wireName: "opening_time",
				label: CASE_WORKSPACE_SEED.lookupTimeColumnLabel,
				dataType: "time",
			},
			{
				wireName: "last_verified",
				label: CASE_WORKSPACE_SEED.lookupDatetimeColumnLabel,
				dataType: "datetime",
			},
		],
	});
	const referralColumns = referralTable.columns;
	let referralRevision = referralTable.tableRevision;
	for (const [code, destination] of [
		["chc", "Community health centre"],
		["dh", "District hospital"],
	] as const) {
		const receipt = await createLookupRow(lookupScope, {
			tableId: referralTable.id,
			expectedTableRevision: referralRevision,
			toIndex: 0,
			values: {
				[referralColumns[0].id]: code,
				[referralColumns[1].id]: destination,
				[referralColumns[2].id]: "09:30:00.125+05:30",
				[referralColumns[3].id]: "2026-07-26T14:45:00-04:00",
			},
		});
		referralRevision = receipt.tableRevision;
	}
	/* A second, intentionally row-less table guards the zero-row authoring
	 * contract: its schema remains visible and selectable even before the
	 * first row is added. */
	await createLookupTable(lookupScope, {
		name: CASE_WORKSPACE_SEED.emptyLookupTableName,
		tag: CASE_WORKSPACE_SEED.emptyLookupTableTag,
		columns: [
			{
				wireName: "tier",
				label: CASE_WORKSPACE_SEED.emptyLookupColumnLabel,
				dataType: "text",
			},
		],
	});

	const caseWorkspace = {
		appId: caseWorkspaceAppId,
		moduleUuid: CASE_WORKSPACE_SEED.moduleUuid,
		caseType: CASE_WORKSPACE_SEED.caseType,
		columnUuids: CASE_WORKSPACE_SEED.columns,
		searchInputUuids: CASE_WORKSPACE_SEED.searchInputs,
		tile: CASE_WORKSPACE_SEED.tile,
		caseIds: caseWorkspaceCaseIds,
		caseCount: caseWorkspaceCaseIds.length,
		routes: caseWorkspaceRoutes(caseWorkspaceAppId, firstCaseId),
	};
	/* The case-changes journey mutates both its blueprint and saved rows. Seed a
	 * complete, isolated universe for every possible Playwright attempt so a
	 * retry never inherits the prior attempt's reordered operations, added
	 * connection, retyped row, or submission effects. */
	const caseChanges: {
		appId: string;
		route: string;
		identityProjectionRoute: string;
		caseId: string;
		viewerStateFile: string;
	}[] = [];
	for (let attempt = 0; attempt < CASE_CHANGES_FIXTURE_COUNT; attempt++) {
		const { appId: caseChangesAppId, baseSeq: caseChangesGenesisSeq } =
			await createExplicitBlankApp(SEED.userId, seedProjectId, randomUUID(), {
				name: CASE_CHANGES_SEED.appName,
				status: "complete",
			});
		const caseChangesLookup = await createLookupTable(
			{
				projectId: seedProjectId,
				actorId: SEED.userId,
				role: "owner",
			},
			{
				name: `Case change flags ${attempt + 1}`,
				tag: `case_change_flags_${attempt + 1}`,
				columns: [
					{
						wireName: "status",
						label: "Status",
						dataType: "text",
					},
				],
			},
		);
		const caseChangesLookupColumn = caseChangesLookup.columns[0];
		if (caseChangesLookupColumn === undefined) {
			throw new Error("e2e/seed.ts: case-change lookup seeded no column");
		}
		const caseChangesDoc = toPersistableDoc(
			buildCaseChangesBlueprint(caseChangesAppId, {
				tableId: caseChangesLookup.id,
				columnId: caseChangesLookupColumn.id,
			}),
		);
		await appendSyntheticBatch({
			appId: caseChangesAppId,
			expectedBaseSeq: caseChangesGenesisSeq,
			targetDoc: caseChangesDoc,
			authority: { kind: "user", actorUserId: SEED.userId },
		});
		await materializeCaseStoreSchemas({
			appId: caseChangesAppId,
			blueprint: caseChangesDoc,
			syncedSeq: caseChangesGenesisSeq + 1,
		});
		const caseChangesPatient = await caseStore.insert({
			appId: caseChangesAppId,
			row: {
				case_type: CASE_CHANGES_SEED.caseType,
				case_name: "Smoke patient",
				status: "open",
				properties: { last_note: "Before submission" },
			},
		});
		caseChanges.push({
			appId: caseChangesAppId,
			route: caseChangesRoute(caseChangesAppId),
			identityProjectionRoute: identityProjectionRoute(caseChangesAppId),
			caseId: caseChangesPatient.caseId,
			viewerStateFile: VIEWER_STATE_FILE,
		});
	}

	/* The after-submit journey authors a link and submits twice into its one
	 * case row, so every attempt gets its own app and row too. */
	const formLinks: { appId: string; route: string; caseId: string }[] = [];
	for (let attempt = 0; attempt < FORM_LINKS_FIXTURE_COUNT; attempt++) {
		const { appId: formLinksAppId, baseSeq: formLinksGenesisSeq } =
			await createExplicitBlankApp(SEED.userId, seedProjectId, randomUUID(), {
				name: FORM_LINKS_SEED.appName,
				status: "complete",
			});
		const formLinksDoc = toPersistableDoc(
			buildFormLinksBlueprint(formLinksAppId),
		);
		await appendSyntheticBatch({
			appId: formLinksAppId,
			expectedBaseSeq: formLinksGenesisSeq,
			targetDoc: formLinksDoc,
			authority: { kind: "user", actorUserId: SEED.userId },
		});
		await materializeCaseStoreSchemas({
			appId: formLinksAppId,
			blueprint: formLinksDoc,
			syncedSeq: formLinksGenesisSeq + 1,
		});
		const formLinksPatient = await caseStore.insert({
			appId: formLinksAppId,
			row: {
				case_type: FORM_LINKS_SEED.caseType,
				case_name: FORM_LINKS_SEED.caseName,
				status: "open",
				properties: { [FORM_LINKS_SEED.property]: "Before submission" },
			},
		});
		formLinks.push({
			appId: formLinksAppId,
			route: formLinksRoute(formLinksAppId),
			caseId: formLinksPatient.caseId,
		});
	}

	/* The sections journey runs a form split into two pages in Preview and
	 * changes nothing durable, so one app serves every attempt. */
	const { appId: formSectionsAppId, baseSeq: formSectionsGenesisSeq } =
		await createExplicitBlankApp(SEED.userId, seedProjectId, randomUUID(), {
			name: FORM_SECTIONS_SEED.appName,
			status: "complete",
		});
	const formSectionsDoc = toPersistableDoc(
		buildFormSectionsBlueprint(formSectionsAppId),
	);
	await appendSyntheticBatch({
		appId: formSectionsAppId,
		expectedBaseSeq: formSectionsGenesisSeq,
		targetDoc: formSectionsDoc,
		authority: { kind: "user", actorUserId: SEED.userId },
	});
	const formSections = {
		appId: formSectionsAppId,
		route: formSectionsRoute(formSectionsAppId),
	};

	/* The conversations fixture: a module-bearing app (docked chat) plus two
	 * tall, settled conversations written through the real thread store (turn
	 * upsert + response append, live marker cleared) — exactly the rows finished
	 * runs leave. The builder must hydrate the newest transcript on load and
	 * switch to the older one without exposing the prior transcript. */
	const { appId: threadsAppId, baseSeq: threadsGenesisSeq } =
		await createExplicitBlankApp(SEED.userId, seedProjectId, randomUUID(), {
			name: SEED.threadsAppName,
			status: "complete",
		});
	await appendSyntheticBatch({
		appId: threadsAppId,
		expectedBaseSeq: threadsGenesisSeq,
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
										label: proseText("Visit notes"),
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
	const { appId: scrollAppId, baseSeq: scrollGenesisSeq } =
		await createExplicitBlankApp(SEED.userId, seedProjectId, randomUUID(), {
			name: SEED.scrollAppName,
			status: "complete",
		});
	await appendSyntheticBatch({
		appId: scrollAppId,
		expectedBaseSeq: scrollGenesisSeq,
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
										label: proseText("Referral notes"),
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
			target: { kind: "app", appId: scrollAppId },
			threadId: scrollQuestionThreadId,
			runId,
			streamId,
			holderNonce: claimed.holderNonce,
			threadType: "edit",
			messages: tallThreadHistory(
				"smoke-scroll-q",
				SEED.scrollQuestionThreadUserText,
			),
			expectedProjectId: seedProjectId,
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
		await persistResponseSnapshot({
			target: { kind: "app", appId: scrollAppId },
			threadId: scrollQuestionThreadId,
			streamId,
			expectedProjectId: seedProjectId,
			clearMarker: true,
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

	/* Free design/build UI journey. The app row and canonical blueprint are real,
	 * but every chat response that reveals it is scripted in Playwright. Keep the
	 * row generating so its app-status stream cannot unlock direct editing before
	 * the scripted data-done frame ends the initial build. */
	const designBuildRunId = randomUUID();
	const designBuildHolderNonce = randomUUID();
	const designBuildReceipt = await createExplicitBlankApp(
		SEED.userId,
		seedProjectId,
		designBuildRunId,
		{
			name: SEED.designBuildAppName,
			status: "generating",
			runHolderNonce: designBuildHolderNonce,
		},
	);
	const designBuildActivation = {
		eventVersion: 1 as const,
		designSessionId: randomUUID(),
		appId: designBuildReceipt.appId,
		projectId: seedProjectId,
		role: "owner",
		canEdit: true,
		seq: 1 as const,
		batchId: randomUUID(),
		changeSetId: randomUUID(),
		snapshotDigest: designBuildReceipt.snapshotDigest,
		blueprint: designBuildReceipt.blueprint,
		starter: null,
	};
	const deleteAppIds: string[] = [];
	for (let i = 0; i < DELETE_APP_COUNT; i++) {
		deleteAppIds.push(
			(
				await createExplicitBlankApp(SEED.userId, seedProjectId, randomUUID(), {
					name: SEED.deleteAppName,
					status: "complete",
				})
			).appId,
		);
	}

	/* Cross-Project move journey: the seeded user owns a second Project, so the
	 * destination list is non-empty and the database's dual-`delete` +
	 * owner-retention rules are satisfied. */
	const moveDestinationProjectId = await seedMoveDestinationProject();
	const moveAppIds: string[] = [];
	for (let i = 0; i < MOVE_APP_COUNT; i++) {
		moveAppIds.push(
			(
				await createExplicitBlankApp(SEED.userId, seedProjectId, randomUUID(), {
					name: SEED.moveAppName,
					status: "complete",
				})
			).appId,
		);
	}

	// Emit storageState (consumed by the `authed` Playwright project) + a seed
	// manifest the tests read for the concrete ids.
	const storageState = buildSessionStorageState({ token, secret, baseUrl });
	const viewerStorageState = buildSessionStorageState({
		token: viewerToken,
		secret,
		baseUrl,
	});
	await mkdir(AUTH_DIR, { recursive: true });
	await writeFile(STATE_FILE, JSON.stringify(storageState, null, 2));
	await writeFile(
		VIEWER_STATE_FILE,
		JSON.stringify(viewerStorageState, null, 2),
	);
	await writeFile(
		SEED_FILE,
		JSON.stringify(
			{
				...SEED,
				openAppId,
				reactProfile,
				organizationAppIds,
				organizationCaseChangeRoutes,
				caseWorkspace,
				caseChanges,
				formLinks,
				formSections,
				deleteAppIds,
				threadsAppId,
				olderThreadId,
				scrollAppId,
				scrollQuestionThreadId,
				designBuildActivation,
				moveAppIds,
				moveDestinationProjectId,
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
		`[seed] user=${SEED.userId} viewer=${SEED.viewerUserId} openApp=${openAppId} deleteApps=${deleteAppIds.length}\n[seed] caseWorkspace app=${caseWorkspace.appId} cases=${caseWorkspace.caseCount} results=${caseWorkspace.routes.results}\n[seed] wrote ${path.relative(process.cwd(), STATE_FILE)} + ${path.relative(process.cwd(), VIEWER_STATE_FILE)} + ${path.relative(process.cwd(), SEED_FILE)}\n[seed] multiplayer app=${multiplayer.appId} project=shared users=${multiplayer.userA.id},${multiplayer.userB.id}`,
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
