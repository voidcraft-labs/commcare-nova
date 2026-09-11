import { randomBytes, randomUUID } from "node:crypto";

import type { UIMessage } from "ai";
import { betterAuth } from "better-auth";

import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import { getAuthDb } from "@/lib/auth/db";
import { ensurePersonalProject } from "@/lib/auth/provisionProject";
import { authMigrateOptions } from "@/lib/auth-migrate-options";
import { withProjectContext } from "@/lib/case-store";
import { getCaseStorePool } from "@/lib/case-store/postgres/connection";
import { createExplicitBlankApp } from "@/lib/db/appGenesis";
import {
	appendSyntheticBatch,
	claimAndReserveRun,
	clearRunLockAndSettle,
	completeAndSettleRun,
} from "@/lib/db/apps";
import { materializeCaseStoreSchemas } from "@/lib/db/materializeCaseStoreSchemas";
import {
	loadThread,
	persistResponseSnapshot,
	upsertThreadTurn,
} from "@/lib/db/threads";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import { proseText } from "@/lib/domain/prose";
import { createLookupRow, createLookupTable } from "@/lib/lookup/service";
import { buildUrl } from "@/lib/routing/location";
import {
	buildCaseChangesBlueprint,
	CASE_CHANGES_SEED,
	caseChangesRoute,
	identityProjectionRoute,
} from "./caseChangesSeed";
import {
	buildCaseWorkspaceBlueprint,
	CASE_WORKSPACE_SEED,
	caseWorkspaceCaseRows,
	caseWorkspaceHouseholdRows,
	caseWorkspaceRoutes,
	caseWorkspaceVisitRows,
} from "./caseWorkspaceSeed";
import {
	buildDeepLinksBlueprint,
	DEEP_LINKS_SEED,
	deepLinksRoute,
} from "./deepLinksSeed";
import {
	buildFormLinksBlueprint,
	FORM_LINKS_SEED,
	formLinksRoute,
} from "./formLinksSeed";
import {
	buildFormSectionsBlueprint,
	FORM_SECTIONS_SEED,
	formSectionsRoute,
} from "./formSectionsSeed";
import {
	buildLocalizationBlueprint,
	LOCALIZATION_SEED,
} from "./localizationSeed";

import {
	buildReactProfileBlueprint,
	reactProfileInitialRoute,
	reactProfileRoute,
} from "./reactProfileSeed";

import {
	buildSearchFirstBlueprint,
	SEARCH_FIRST_SEED,
	searchFirstRoutes,
} from "./searchFirstSeed";
import { buildSessionStorageState } from "./session";

import { SMOKE_TEXT } from "./smokeText";

/** One context per seed process, one actor/Project universe per scenario. */
export async function smokeSeedEnvironment(secret: string, baseUrl: string) {
	if (!process.env.NOVA_DB_LOCAL_URL)
		throw new Error("Smoke seeding requires the explicit local database URL");
	const pool = await getCaseStorePool();
	const ctx = await betterAuth({
		...authMigrateOptions(pool),
		secret,
		baseURL: baseUrl,
	}).$context;
	return { pool, ctx, secret, baseUrl };
}

export async function createSmokeBuilders(
	environment: Awaited<ReturnType<typeof smokeSeedEnvironment>>,
) {
	const { pool, ctx, secret, baseUrl } = environment;
	const identity = randomUUID();
	const SEED = {
		...SMOKE_TEXT,
		userId: `smoke-${identity}`,
		userEmail: `smoke-${identity}@dimagi.com`,
		viewerUserId: `viewer-${identity}`,
		viewerUserEmail: `viewer-${identity}@dimagi.com`,
	};
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
							fields: [
								f({ kind: "text", id: "note", label: proseText("Note") }),
							],
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
	function tallThreadHistory(
		prefix: string,
		firstUserText: string,
	): UIMessage[] {
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

	/** Each assistant response must first be written by its owning server run.
	 * Incoming history is untrusted, so a fresh thread deliberately drops it. */
	async function seedTallThreadTurn(args: {
		appId: string;
		threadId: string;
		prefix: string;
		firstUserText: string;
		threadType: "build" | "edit";
		projectId: string;
	}) {
		const history = tallThreadHistory(args.prefix, args.firstUserText);
		for (let index = 0; index < history.length; index += 2) {
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
				messages: history.slice(0, index + 1),
				expectedProjectId: args.projectId,
			});
			if (!written)
				throw new Error("e2e/seed.ts: thread turn seed write failed");
			const responseMessage = history[index + 1];
			if (responseMessage === undefined) return { streamId, runId, claimed };
			await persistResponseSnapshot({
				target: { kind: "app", appId: args.appId },
				threadId: args.threadId,
				streamId,
				expectedProjectId: args.projectId,
				responseMessage,
				clearMarker: true,
			});
			const released =
				args.threadType === "build"
					? await completeAndSettleRun(args.appId, runId, claimed.holderNonce)
					: await clearRunLockAndSettle(args.appId, runId, claimed.holderNonce);
			if (released !== "owned")
				throw new Error(
					`e2e/seed.ts: thread history lost holder (${released})`,
				);
		}
		throw new Error("e2e/seed.ts: tall history must end with a user message");
	}

	async function assertTallThreadStored(appId: string, threadId: string) {
		const thread = await loadThread(
			{ kind: "app", appId },
			threadId,
			SEED.userId,
		);
		if (
			thread?.messages.length !== 16 ||
			thread.messages.filter((message) => message.role === "assistant")
				.length !== 8
		)
			throw new Error(
				"e2e/seed.ts: tall transcript did not retain every server-authored response",
			);
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
		const { streamId, runId, claimed } = await seedTallThreadTurn(args);
		const releaseOutcome =
			args.threadType === "build"
				? await completeAndSettleRun(args.appId, runId, claimed.holderNonce)
				: await clearRunLockAndSettle(args.appId, runId, claimed.holderNonce);
		if (releaseOutcome !== "owned") {
			throw new Error(
				`e2e/seed.ts: thread seed lost holder (${releaseOutcome})`,
			);
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
		await assertTallThreadStored(args.appId, args.threadId);
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
					slug: `move-destination-${SEED.userId}`,
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

	const now = new Date();
	// Opaque secret shared between the session row and the cookie.
	const token = randomBytes(32).toString("hex");
	const viewerToken = randomBytes(32).toString("hex");
	const expiresAt = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000);

	// Auth state → Postgres, written through Better Auth's own adapter (same
	// schema config as production via `authMigrateOptions`). `getSession` loads
	// the user by `userId` and the session by its `token` field; the email-domain
	// allowlist only gates user *creation*, so a directly-seeded row reads fine.

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

	const storageState = buildSessionStorageState({ token, secret, baseUrl });
	const viewerStorageState = buildSessionStorageState({
		token: viewerToken,
		secret,
		baseUrl,
	});
	const common = {
		...SEED,
		projectId: seedProjectId,
		baseUrl,
		storageState,
		viewerStorageState,
	};
	const caseStore = await withProjectContext(
		seedProjectId,
		SEED.userId,
		SEED.userId,
	);
	async function seedReactProfile() {
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
	}
	async function seedCaseWorkspace(workspaceProjectId: string) {
		/* Full Search / Results / Details visual-QA fixture. The authored ids and
		 * patient values are stable; the app + case ids are minted by their real
		 * stores and written into seed.json for exact deep links. Materialize before
		 * inserting so the fixture exercises the same schema gate as live case data. */
		const { appId: caseWorkspaceAppId, baseSeq: caseWorkspaceGenesisSeq } =
			await createExplicitBlankApp(
				SEED.userId,
				workspaceProjectId,
				randomUUID(),
				{
					name: CASE_WORKSPACE_SEED.appName,
					status: "complete",
				},
			);
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
			workspaceProjectId,
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
			projectId: workspaceProjectId,
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
		return caseWorkspace;
	}

	async function seedOpen() {
		const { appId: openAppId } = await createExplicitBlankApp(
			SEED.userId,
			seedProjectId,
			randomUUID(),
			{
				name: SEED.openAppName,
				status: "complete",
			},
		);

		return { openAppId };
	}
	const builders = {
		auth: async () => {
			return {};
		},
		open: seedOpen,
		"app-list": async () => ({
			...(await seedOpen()),
			moveDestinationProjectId: await seedMoveDestinationProject(),
		}),
		organization: async () => {
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

			return {
				organizationAppId: appId,
				organizationCaseChangeRoute: buildUrl(`/build/${appId}`, {
					kind: "form-operations",
					moduleUuid,
					formUuid,
				}),
			};
		},
		workspace: async () => {
			return { caseWorkspace: await seedCaseWorkspace(seedProjectId) };
		},
		"case-changes": async () => {
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
					name: "Case change flags",
					tag: "case_change_flags",
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
			return {
				caseChanges: {
					appId: caseChangesAppId,
					route: caseChangesRoute(caseChangesAppId),
					identityProjectionRoute: identityProjectionRoute(caseChangesAppId),
					caseId: caseChangesPatient.caseId,
				},
			};
		},
		"form-links": async () => {
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
			return {
				formLinks: {
					appId: formLinksAppId,
					route: formLinksRoute(formLinksAppId),
					caseId: formLinksPatient.caseId,
				},
			};
		},
		"deep-links": async () => {
			const { appId, baseSeq } = await createExplicitBlankApp(
				SEED.userId,
				seedProjectId,
				randomUUID(),
				{ name: DEEP_LINKS_SEED.appName, status: "complete" },
			);
			const blueprint = toPersistableDoc(buildDeepLinksBlueprint(appId));
			await appendSyntheticBatch({
				appId,
				expectedBaseSeq: baseSeq,
				targetDoc: blueprint,
				authority: { kind: "user", actorUserId: SEED.userId },
			});
			await materializeCaseStoreSchemas({
				appId,
				blueprint,
				syncedSeq: baseSeq + 1,
			});
			const distractor = await caseStore.insert({
				appId,
				row: {
					case_type: DEEP_LINKS_SEED.caseType,
					case_name: DEEP_LINKS_SEED.distractorName,
					status: "open",
					properties: {},
				},
			});
			const selected = await caseStore.insert({
				appId,
				row: {
					case_type: DEEP_LINKS_SEED.caseType,
					case_name: DEEP_LINKS_SEED.selectedName,
					status: "open",
					properties: {},
				},
			});
			return {
				deepLinks: {
					appId,
					route: deepLinksRoute(appId),
					selectedCaseId: selected.caseId,
					distractorCaseId: distractor.caseId,
				},
			};
		},
		"search-first": async () => {
			const { appId: searchFirstAppId, baseSeq: searchFirstGenesisSeq } =
				await createExplicitBlankApp(SEED.userId, seedProjectId, randomUUID(), {
					name: SEARCH_FIRST_SEED.appName,
					status: "complete",
				});
			const searchFirstDoc = toPersistableDoc(
				buildSearchFirstBlueprint(searchFirstAppId),
			);
			await appendSyntheticBatch({
				appId: searchFirstAppId,
				expectedBaseSeq: searchFirstGenesisSeq,
				targetDoc: searchFirstDoc,
				authority: { kind: "user", actorUserId: SEED.userId },
			});
			await materializeCaseStoreSchemas({
				appId: searchFirstAppId,
				blueprint: searchFirstDoc,
				syncedSeq: searchFirstGenesisSeq + 1,
			});
			const searchFirstPatient = await caseStore.insert({
				appId: searchFirstAppId,
				row: {
					case_type: SEARCH_FIRST_SEED.caseType,
					case_name: SEARCH_FIRST_SEED.caseName,
					status: "open",
					properties: {},
				},
			});
			return {
				searchFirst: {
					appId: searchFirstAppId,
					routes: searchFirstRoutes(searchFirstAppId),
					caseId: searchFirstPatient.caseId,
				},
			};
		},
		localization: async () => {
			const { appId, baseSeq } = await createExplicitBlankApp(
				SEED.userId,
				seedProjectId,
				randomUUID(),
				{
					name: LOCALIZATION_SEED.appName,
					status: "complete",
				},
			);
			await appendSyntheticBatch({
				appId,
				expectedBaseSeq: baseSeq,
				targetDoc: toPersistableDoc(buildLocalizationBlueprint(appId)),
				authority: { kind: "user", actorUserId: SEED.userId },
			});
			return { localizationAppId: appId };
		},
		sections: async () => {
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

			return { formSections };
		},
		threads: async () => {
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

			return { threadsAppId, olderThreadId };
		},
		scroll: async () => {
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
				const { streamId, runId, claimed } = await seedTallThreadTurn({
					appId: scrollAppId,
					threadId: scrollQuestionThreadId,
					prefix: "smoke-scroll-q",
					firstUserText: SEED.scrollQuestionThreadUserText,
					threadType: "edit",
					projectId: seedProjectId,
				});
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
				await assertTallThreadStored(scrollAppId, scrollQuestionThreadId);
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

			return { scrollAppId, scrollQuestionThreadId };
		},
		design: async () => {
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

			const continuationDesignId = randomUUID();
			const continuationMessages = [
				{
					id: "saved-design-request",
					role: "user",
					parts: [
						{
							type: "text",
							text: "Keep farmer correction under Farmer search.",
						},
					],
				},
				{
					id: "saved-design-stop",
					role: "assistant",
					parts: [
						{
							type: "text",
							text: "The design needs another turn to finish. Your decisions and pending corrections are saved. Send a message to continue.",
						},
					],
				},
			];
			await pool.query(
				`INSERT INTO design_sessions (id,mode,project_id,owner_user_id,proposed_app_id,state,last_error_type) VALUES ($1,'build',$2,$3,$4,'active','design-step-budget')`,
				[continuationDesignId, seedProjectId, SEED.userId, randomUUID()],
			);
			const now = new Date().toISOString();
			await pool.query(
				`INSERT INTO threads (thread_id,design_session_id,created_at,updated_at,thread_type,summary,run_id,messages) VALUES ($1,$2,$3,$3,'build','Farmer correction design',$4,$5::jsonb)`,
				[
					randomUUID(),
					continuationDesignId,
					now,
					randomUUID(),
					JSON.stringify(continuationMessages),
				],
			);
			return { designBuildActivation, continuationDesignId };
		},
		delete: async () => {
			const { openAppId } = await seedOpen();
			const { appId: deleteAppId } = await createExplicitBlankApp(
				SEED.userId,
				seedProjectId,
				randomUUID(),
				{ name: SEED.deleteAppName, status: "complete" },
			);
			return { deleteAppId, openAppId };
		},
		move: async () => {
			const { openAppId } = await seedOpen();
			const moveDestinationProjectId = await seedMoveDestinationProject();
			const { appId: moveAppId } = await createExplicitBlankApp(
				SEED.userId,
				seedProjectId,
				randomUUID(),
				{ name: SEED.moveAppName, status: "complete" },
			);
			return { openAppId, moveDestinationProjectId, moveAppId };
		},
		"member-role": async () => {
			const receipt = await createExplicitBlankApp(
				SEED.userId,
				seedProjectId,
				randomUUID(),
				{ name: "Role refresh", status: "complete" },
			);
			const db = await getAuthDb();
			await db
				.updateTable("auth_member")
				.set({ role: "editor" })
				.where("userId", "=", SEED.viewerUserId)
				.where("organizationId", "=", seedProjectId)
				.executeTakeFirstOrThrow();
			const moduleUuid = receipt.blueprint.moduleOrder[0];
			if (!moduleUuid) throw new Error("Role fixture has no module");
			return {
				appId: receipt.appId,
				moduleUuid,
				userB: { id: SEED.viewerUserId },
			};
		},

		"react-profile": async () => {
			return { reactProfile: await seedReactProfile() };
		},
	};
	return { common, builders };
}
export type SmokeBuilders = Awaited<ReturnType<typeof createSmokeBuilders>>;
export type SmokeCommon = SmokeBuilders["common"];
export type SmokeProfile = keyof SmokeBuilders["builders"];
export type SmokeProfileData = {
	[K in SmokeProfile]: Awaited<ReturnType<SmokeBuilders["builders"][K]>>;
};
