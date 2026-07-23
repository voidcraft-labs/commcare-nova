/** Dormant S02c3 Project-move protocol against one shared Postgres database. */

import type { UIMessage } from "ai";
import type { Kysely } from "kysely";
import { Client } from "pg";
import { describe, expect, it } from "vitest";
import { PostgresCaseStore } from "@/lib/case-store/postgres/store";
import { HeuristicCaseGenerator } from "@/lib/case-store/sample/heuristic";
import type { Database } from "@/lib/case-store/sql/database";
import type { CaseType } from "@/lib/domain";
import {
	commitAppProjectMoveInTransaction,
	prepareAppProjectMoveInTransaction,
	repairAppCaseTenancy,
} from "../apps";
import {
	authorizeCaseMutationInTransaction,
	authorizeSystemSchemaMutationInTransaction,
} from "../caseMutationAuthorization";
import {
	BlueprintCommitRejectedError,
	CommitReauthError,
} from "../commitGuard";
import { setTransactionWriterVersion } from "../pg";
import { mergeThreadTurnMessages } from "../threads";
import { setupAppStateTestDb } from "./appStateTestDb";
import { createPerTestAppDb } from "./perTestAppDb";

const h = setupAppStateTestDb("project_move_");
const ACTOR = "move-owner";
const SOURCE_OWNER = "source-owner";
const SOURCE = "project-source";
const DESTINATION = "project-destination";

async function enableMoves(): Promise<void> {
	await h
		.db()
		.updateTable("lookup_reference_compatibility")
		.set({
			minimum_writer_version: 1,
			minimum_stream_receiver_version: 1,
			project_moves_enabled: true,
		})
		.where("id", "=", 1)
		.execute();
}

async function prepareMove(appId: string, actorUserId = ACTOR) {
	return h
		.db()
		.transaction()
		.execute(async (tx) => {
			await setTransactionWriterVersion(tx, 1);
			return prepareAppProjectMoveInTransaction(
				tx,
				{
					appId,
					expectedFromProjectId: SOURCE,
					toProjectId: DESTINATION,
					actorUserId,
				},
				1,
				1,
			);
		});
}

async function commitMove(
	appId: string,
	options: {
		assetIdMap?: ReadonlyMap<string, string>;
		attemptedRealIds?: ReadonlySet<string>;
		insideTransaction?: () => Promise<void>;
	} = {},
) {
	return h
		.db()
		.transaction()
		.execute(async (tx) => {
			await setTransactionWriterVersion(tx, 1);
			const result = await commitAppProjectMoveInTransaction(
				tx,
				{
					appId,
					expectedFromProjectId: SOURCE,
					toProjectId: DESTINATION,
					actorUserId: ACTOR,
					assetIdMap: options.assetIdMap ?? new Map(),
					attemptedRealIds: options.attemptedRealIds ?? new Set(),
				},
				{
					batchId: crypto.randomUUID(),
					declaredWriterVersion: 1,
					streamReceiverVersion: 1,
				},
			);
			await options.insideTransaction?.();
			return result;
		});
}

async function seedReadyAsset(args: {
	id: string;
	projectId: string;
	kind: "image" | "document";
}): Promise<void> {
	const extension = args.kind === "image" ? ".png" : ".pdf";
	const mimeType = args.kind === "image" ? "image/png" : "application/pdf";
	await h
		.db()
		.insertInto("media_assets")
		.values({
			id: args.id,
			project_id: args.projectId,
			owner: ACTOR,
			content_hash: args.id.padEnd(64, "a").slice(0, 64),
			mime_type: mimeType,
			extension,
			size_bytes: 256,
			dimensions:
				args.kind === "image"
					? JSON.stringify({ width: 32, height: 32 })
					: null,
			duration_ms: null,
			kind: args.kind,
			gcs_object_key: `projects/${args.projectId}/${args.id}${extension}`,
			original_filename:
				args.kind === "image" ? "field-photo.png" : "requirements.pdf",
			display_name: args.kind === "image" ? "Field photo" : "Requirements",
			status: "ready",
			extract:
				args.kind === "document"
					? JSON.stringify({
							status: "ready",
							version: 1,
							model: "test-extractor",
							truncated: false,
							charCount: 12,
							extractedAt: Date.now(),
							title: "Requirements",
							summary: "requirements",
						})
					: null,
		})
		.execute();
}

function attachedMessage(
	id: string,
	attachments: Array<Record<string, unknown>>,
): UIMessage {
	return {
		id,
		role: "user",
		parts: [{ type: "text", text: "Use these files" }],
		metadata: { attachments, source: "browser" },
	} as UIMessage;
}

async function seedThread(
	appId: string,
	threadId: string,
	messages: readonly UIMessage[],
): Promise<void> {
	const now = new Date().toISOString();
	await h
		.db()
		.insertInto("threads")
		.values({
			thread_id: threadId,
			app_id: appId,
			created_at: now,
			updated_at: now,
			thread_type: "edit",
			summary: "Use these files",
			run_id: "historical-run",
			active_stream_id: null,
			active_holder_nonce: null,
			messages: JSON.stringify(messages),
		})
		.execute();
}

async function seedCase(
	appId: string,
	projectId: string | null,
): Promise<void> {
	await h.pool().query(
		`INSERT INTO cases
			(case_id, app_id, project_id, case_type, case_name, owner_id, status, properties)
		 VALUES ($1, $2, $3, 'household', 'Test household', $4, 'open', '{}'::jsonb)`,
		[crypto.randomUUID(), appId, projectId, ACTOR],
	);
}

function makeSystemSchemaStore(
	observedProjects: string[],
	db: Kysely<Database> = h.db() as unknown as Kysely<Database>,
): PostgresCaseStore {
	return new PostgresCaseStore({
		projectId: null,
		actorUserId: null,
		db,
		sampleGenerator: new HeuristicCaseGenerator(),
		authorizeSchemaMutation: async (tx, args) => {
			const scope = await authorizeSystemSchemaMutationInTransaction(tx, args);
			observedProjects.push(scope.projectId);
		},
	});
}

function makeActorCaseStore(db: Kysely<Database>): PostgresCaseStore {
	return new PostgresCaseStore({
		projectId: SOURCE,
		actorUserId: ACTOR,
		db,
		sampleGenerator: new HeuristicCaseGenerator(),
		authorizeMutation: authorizeCaseMutationInTransaction,
	});
}

function applyHouseholdSchema(store: PostgresCaseStore, appId: string) {
	const caseType: CaseType = { name: "household", properties: [] };
	return store.applySchemaChange({
		appId,
		caseType: caseType.name,
		caseTypeSchemas: new Map([[caseType.name, caseType]]),
	});
}

function insertHousehold(
	store: PostgresCaseStore,
	appId: string,
	name: string,
) {
	return store.insert({
		appId,
		row: {
			case_type: "household",
			case_name: name,
			status: "open",
			properties: {},
		},
	});
}

async function waitForBlockedLocks(
	observer: Client,
	minimum: number,
): Promise<void> {
	const deadline = Date.now() + 5_000;
	while (Date.now() < deadline) {
		const result = await observer.query<{ count: string }>(`
			SELECT count(*)::text AS count
			FROM pg_locks AS locks
			JOIN pg_stat_activity AS activity ON activity.pid = locks.pid
			WHERE activity.datname = current_database()
			  AND NOT locks.granted
		`);
		if (Number(result.rows[0]?.count ?? 0) >= minimum) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error(`Timed out waiting for ${minimum} blocked database lock(s).`);
}

describe("dormant atomic Project move", () => {
	it("schema-first holds the app placement through Phase A before a Project move", async () => {
		const appId = await h.seedApp({
			id: "app-schema-first-move",
			owner: ACTOR,
			project_id: SOURCE,
		});
		await h.seedProjectMember(ACTOR, DESTINATION, "owner");
		await enableMoves();
		const observedProjects: string[] = [];
		const schemaDb = createPerTestAppDb(h.uri());
		const store = makeSystemSchemaStore(
			observedProjects,
			schemaDb.appDb as unknown as Kysely<Database>,
		);
		const gateKey = 9_081_201;
		const gate = new Client({ connectionString: h.uri() });
		await gate.connect();
		await gate.query("SELECT pg_advisory_lock($1)", [gateKey]);
		await gate.query(`
			CREATE FUNCTION test_pause_schema_first() RETURNS trigger
			LANGUAGE plpgsql AS $$
			BEGIN
				PERFORM pg_advisory_xact_lock(${gateKey});
				RETURN NEW;
			END
			$$;
			CREATE TRIGGER test_pause_schema_first_trigger
				BEFORE INSERT OR UPDATE ON case_type_schemas
				FOR EACH ROW EXECUTE FUNCTION test_pause_schema_first();
		`);

		const schema = applyHouseholdSchema(store, appId);
		let gateHeld = true;
		let move: Promise<unknown> | undefined;
		try {
			await waitForBlockedLocks(gate, 1);
			move = commitMove(appId);
			// The schema transaction waits on the advisory test gate while holding
			// `apps FOR SHARE`; the move must queue behind that app-row fence.
			await waitForBlockedLocks(gate, 2);
			await gate.query("SELECT pg_advisory_unlock($1)", [gateKey]);
			gateHeld = false;
			await expect(schema).resolves.toMatchObject({ migrated: 0 });
			await expect(move).resolves.toEqual({ kind: "moved" });
		} finally {
			if (gateHeld) {
				await gate
					.query("SELECT pg_advisory_unlock($1)", [gateKey])
					.catch(() => {});
			}
			await Promise.allSettled([schema, ...(move ? [move] : [])]);
			await gate.end().catch(() => {});
			await schemaDb.destroy();
		}

		expect(observedProjects).toEqual([SOURCE]);
		expect((await h.readAppRow(appId))?.project_id).toBe(DESTINATION);
	}, 15_000);

	it("move-first makes a waiting system schema write bind the destination Project", async () => {
		const appId = await h.seedApp({
			id: "app-move-first-schema",
			owner: ACTOR,
			project_id: SOURCE,
		});
		await h.seedProjectMember(ACTOR, DESTINATION, "owner");
		await enableMoves();
		const observedProjects: string[] = [];
		const schemaDb = createPerTestAppDb(h.uri());
		const store = makeSystemSchemaStore(
			observedProjects,
			schemaDb.appDb as unknown as Kysely<Database>,
		);
		let markMoveInside!: () => void;
		const moveInside = new Promise<void>((resolve) => {
			markMoveInside = resolve;
		});
		let allowMoveCommit!: () => void;
		const moveCommitAllowed = new Promise<void>((resolve) => {
			allowMoveCommit = resolve;
		});
		const observer = new Client({ connectionString: h.uri() });
		await observer.connect();

		const move = commitMove(appId, {
			insideTransaction: async () => {
				markMoveInside();
				await moveCommitAllowed;
			},
		});
		let schema: Promise<unknown> | undefined;
		try {
			await moveInside;
			schema = applyHouseholdSchema(store, appId);
			await waitForBlockedLocks(observer, 1);
			allowMoveCommit();
			await expect(move).resolves.toEqual({ kind: "moved" });
			await expect(schema).resolves.toMatchObject({ migrated: 0 });
		} finally {
			allowMoveCommit();
			await Promise.allSettled([move, ...(schema ? [schema] : [])]);
			await observer.end().catch(() => {});
			await schemaDb.destroy();
		}

		expect(observedProjects).toEqual([DESTINATION]);
		expect((await h.readAppRow(appId))?.project_id).toBe(DESTINATION);
	}, 15_000);

	it("case-writer-first commits in the source placement before the move rehomes its row", async () => {
		const appId = await h.seedApp({
			id: "app-case-writer-first",
			owner: ACTOR,
			project_id: SOURCE,
		});
		await h.seedProjectMember(ACTOR, DESTINATION, "owner");
		await enableMoves();
		await applyHouseholdSchema(makeSystemSchemaStore([]), appId);
		const writerDb = createPerTestAppDb(h.uri());
		const store = makeActorCaseStore(
			writerDb.appDb as unknown as Kysely<Database>,
		);
		const gateKey = 9_081_203;
		const gate = new Client({ connectionString: h.uri() });
		await gate.connect();
		await gate.query("SELECT pg_advisory_lock($1)", [gateKey]);
		await gate.query(`
			CREATE FUNCTION test_pause_case_writer_first() RETURNS trigger
			LANGUAGE plpgsql AS $$
			BEGIN
				PERFORM pg_advisory_xact_lock(${gateKey});
				RETURN NEW;
			END
			$$;
			CREATE TRIGGER test_pause_case_writer_first_trigger
				BEFORE INSERT ON cases
				FOR EACH ROW EXECUTE FUNCTION test_pause_case_writer_first();
		`);

		const write = insertHousehold(store, appId, "Writer first");
		let gateHeld = true;
		let move: Promise<unknown> | undefined;
		try {
			await waitForBlockedLocks(gate, 1);
			move = commitMove(appId);
			// The writer already reauthorized and holds `apps FOR SHARE`; the move
			// must wait for that source-bound transaction to commit.
			await waitForBlockedLocks(gate, 2);
			await gate.query("SELECT pg_advisory_unlock($1)", [gateKey]);
			gateHeld = false;

			await expect(write).resolves.toMatchObject({
				caseId: expect.any(String),
			});
			await expect(move).resolves.toEqual({ kind: "moved" });
		} finally {
			if (gateHeld) {
				await gate
					.query("SELECT pg_advisory_unlock($1)", [gateKey])
					.catch(() => {});
			}
			await Promise.allSettled([write, ...(move ? [move] : [])]);
			await gate.end().catch(() => {});
			await writerDb.destroy();
		}

		expect((await h.readAppRow(appId))?.project_id).toBe(DESTINATION);
		const cases = await h
			.pool()
			.query<{ project_id: string }>(
				"SELECT project_id FROM cases WHERE app_id = $1",
				[appId],
			);
		expect(cases.rows).toEqual([{ project_id: DESTINATION }]);
	}, 15_000);

	it("move-first makes a waiting source-bound case writer reject without a stray row", async () => {
		const appId = await h.seedApp({
			id: "app-move-first-case-writer",
			owner: ACTOR,
			project_id: SOURCE,
		});
		await h.seedProjectMember(ACTOR, DESTINATION, "owner");
		await enableMoves();
		await applyHouseholdSchema(makeSystemSchemaStore([]), appId);
		const writerDb = createPerTestAppDb(h.uri());
		const store = makeActorCaseStore(
			writerDb.appDb as unknown as Kysely<Database>,
		);
		const observer = new Client({ connectionString: h.uri() });
		await observer.connect();
		let markMoveInside!: () => void;
		const moveInside = new Promise<void>((resolve) => {
			markMoveInside = resolve;
		});
		let allowMoveCommit!: () => void;
		const moveCommitAllowed = new Promise<void>((resolve) => {
			allowMoveCommit = resolve;
		});

		const move = commitMove(appId, {
			insideTransaction: async () => {
				markMoveInside();
				await moveCommitAllowed;
			},
		});
		let write: Promise<unknown> | undefined;
		try {
			await moveInside;
			write = insertHousehold(store, appId, "Too late");
			await waitForBlockedLocks(observer, 1);
			allowMoveCommit();

			await expect(move).resolves.toEqual({ kind: "moved" });
			await expect(write).rejects.toMatchObject({
				name: "AppAccessError",
				reason: "not_found",
			});
		} finally {
			allowMoveCommit();
			await Promise.allSettled([move, ...(write ? [write] : [])]);
			await observer.end().catch(() => {});
			await writerDb.destroy();
		}

		expect((await h.readAppRow(appId))?.project_id).toBe(DESTINATION);
		const cases = await h
			.pool()
			.query<{ count: string }>(
				"SELECT count(*)::text AS count FROM cases WHERE app_id = $1",
				[appId],
			);
		expect(cases.rows[0]?.count).toBe("0");
	}, 15_000);

	it("moves the complete tenant closure atomically and preserves transcript metadata", async () => {
		const appId = await h.seedApp({
			id: "app-atomic-move",
			owner: ACTOR,
			project_id: SOURCE,
			app_name: "Atomic move",
		});
		await h.seedProjectMember(ACTOR, DESTINATION, "owner");
		// A source owner is allowed to move even when another source owner is not
		// retained at the destination.
		await h.seedProjectMember(SOURCE_OWNER, SOURCE, "owner");

		const sourceLogo = "source-logo";
		const destinationLogo = "destination-logo";
		const sourceImage = "source-chat-image";
		const destinationImage = "destination-chat-image";
		const sourceDocument = "source-chat-document";
		const destinationDocument = "destination-chat-document";
		for (const [id, projectId, kind] of [
			[sourceLogo, SOURCE, "image"],
			[destinationLogo, DESTINATION, "image"],
			[sourceImage, SOURCE, "image"],
			[destinationImage, DESTINATION, "image"],
			[sourceDocument, SOURCE, "document"],
			[destinationDocument, DESTINATION, "document"],
		] as const) {
			await seedReadyAsset({ id, projectId, kind });
		}
		await h
			.db()
			.updateTable("apps")
			.set({ logo: sourceLogo })
			.where("id", "=", appId)
			.execute();

		const missingHistorical = "missing-historical-document";
		const originalMessages = [
			attachedMessage("message-1", [
				{
					assetId: sourceImage,
					kind: "image",
					filename: "field-photo.png",
					mimeType: "image/png",
					title: "Field photo",
				},
				{
					assetId: sourceDocument,
					kind: "pdf",
					filename: "requirements.pdf",
					mimeType: "application/pdf",
					summary: "Requirements summary",
				},
				{
					assetId: missingHistorical,
					kind: "pdf",
					filename: "deleted.pdf",
					mimeType: "application/pdf",
				},
			]),
		];
		await seedThread(appId, "thread-atomic", originalMessages);
		await seedCase(appId, SOURCE);
		await seedCase(appId, null);
		await h
			.db()
			.insertInto("presence")
			.values({
				app_id: appId,
				user_id: ACTOR,
				session_id: "session-move",
				name: "Mover",
				image: null,
				email: "mover@dimagi.com",
				color: "blue",
				location: JSON.stringify({ surface: "app" }),
				expire_at: new Date(Date.now() + 60_000),
			})
			.execute();
		await enableMoves();

		const listener = new Client({ connectionString: h.uri() });
		const channels: string[] = [];
		const onNotification = (message: { channel: string }) => {
			channels.push(message.channel);
		};
		await listener.connect();
		listener.on("notification", onNotification);
		try {
			await listener.query("LISTEN nova_app_stream");
			await listener.query("LISTEN nova_presence");
			const result = await commitMove(appId, {
				assetIdMap: new Map([
					[sourceLogo, destinationLogo],
					[sourceImage, destinationImage],
					[sourceDocument, destinationDocument],
				]),
				attemptedRealIds: new Set([
					sourceLogo,
					sourceImage,
					sourceDocument,
					missingHistorical,
				]),
				insideTransaction: async () => {
					const outside = await listener.query<{
						project_id: string;
					}>("SELECT project_id FROM apps WHERE id = $1", [appId]);
					expect(outside.rows[0]?.project_id).toBe(SOURCE);
					expect(channels).toEqual([]);
				},
			});
			expect(result).toEqual({ kind: "moved" });
			for (let attempt = 0; attempt < 100 && channels.length < 2; attempt++) {
				await new Promise((resolve) => setTimeout(resolve, 5));
			}
			expect(new Set(channels)).toEqual(
				new Set(["nova_app_stream", "nova_presence"]),
			);
		} finally {
			listener.off("notification", onNotification);
			await listener.end();
		}

		const app = await h.readAppRow(appId);
		expect(app).toMatchObject({
			project_id: DESTINATION,
			logo: destinationLogo,
		});
		expect(Number(app?.mutation_seq)).toBe(1);
		const cases = await h
			.pool()
			.query<{ project_id: string }>(
				"SELECT project_id FROM cases WHERE app_id = $1 ORDER BY case_id",
				[appId],
			);
		expect(cases.rows.map((row) => row.project_id)).toEqual([
			DESTINATION,
			DESTINATION,
		]);
		const presenceCount = await h
			.db()
			.selectFrom("presence")
			.select(({ fn }) => fn.countAll().as("count"))
			.where("app_id", "=", appId)
			.executeTakeFirstOrThrow();
		expect(Number(presenceCount.count)).toBe(0);

		const storedThread = await h
			.db()
			.selectFrom("threads")
			.select("messages")
			.where("thread_id", "=", "thread-atomic")
			.executeTakeFirstOrThrow();
		const expectedMessages = structuredClone(originalMessages) as Array<{
			metadata: { attachments: Array<{ assetId: string }> };
		}>;
		expectedMessages[0].metadata.attachments[0].assetId = destinationImage;
		expectedMessages[0].metadata.attachments[1].assetId = destinationDocument;
		expect(storedThread.messages).toEqual(expectedMessages);

		const destinationEdges = await h
			.db()
			.selectFrom("media_asset_refs")
			.select("asset_id")
			.where("app_id", "=", appId)
			.where("asset_id", "in", [
				destinationLogo,
				destinationImage,
				destinationDocument,
			])
			.orderBy("asset_id")
			.execute();
		expect(destinationEdges.map((edge) => edge.asset_id)).toEqual(
			[destinationLogo, destinationImage, destinationDocument].sort(),
		);
		const migration = await h
			.db()
			.selectFrom("accepted_mutations")
			.select(["seq", "actor_id", "kind"])
			.where("app_id", "=", appId)
			.executeTakeFirstOrThrow();
		expect(migration).toMatchObject({ actor_id: ACTOR, kind: "migration" });
		expect(Number(migration.seq)).toBe(1);

		// Move-first order: a stale source-Project history writer cannot restore
		// source ids after the atomic thread rewrite.
		await expect(
			mergeThreadTurnMessages({
				appId,
				threadId: "thread-atomic",
				messages: originalMessages,
				expectedProjectId: SOURCE,
			}),
		).resolves.toBe(false);
		expect(
			(
				await h
					.db()
					.selectFrom("threads")
					.select("messages")
					.where("thread_id", "=", "thread-atomic")
					.executeTakeFirstOrThrow()
			).messages,
		).toEqual(expectedMessages);
	});

	it("requires owner retention for a non-owner admin and fails closed on an ownerless source", async () => {
		const appId = await h.seedApp({
			id: "app-admin-governance",
			owner: SOURCE_OWNER,
			project_id: SOURCE,
		});
		await h.seedProjectMember(ACTOR, SOURCE, "admin");
		await h.seedProjectMember(ACTOR, DESTINATION, "admin");
		await enableMoves();

		await expect(prepareMove(appId)).rejects.toBeInstanceOf(CommitReauthError);
		await h.seedProjectMember(SOURCE_OWNER, DESTINATION, "viewer");
		await expect(prepareMove(appId)).resolves.toMatchObject({ kind: "ready" });

		await h.seedProjectMember(SOURCE_OWNER, SOURCE, "admin");
		await expect(prepareMove(appId)).rejects.toBeInstanceOf(CommitReauthError);
	});

	it("classifies live, stale-paused, and corrupt holders solely through runLeaseState", async () => {
		const live = await h.seedApp({
			id: "app-live-run",
			owner: ACTOR,
			project_id: SOURCE,
			status: "generating",
			run_id: "run-live",
			updated_at: new Date(),
		});
		const stalePaused = await h.seedApp({
			id: "app-stale-paused-run",
			owner: ACTOR,
			project_id: SOURCE,
			status: "generating",
			awaiting_input: true,
			run_id: "run-stale-paused",
			updated_at: new Date(Date.now() - 20 * 60_000),
		});
		const corrupt = await h.seedApp({
			id: "app-corrupt-run",
			owner: ACTOR,
			project_id: SOURCE,
			status: "generating",
			run_id: null,
			updated_at: new Date(Date.now() - 20 * 60_000),
		});
		await h.seedProjectMember(ACTOR, DESTINATION, "owner");
		await enableMoves();

		await expect(prepareMove(live)).resolves.toEqual({ kind: "busy" });
		await expect(prepareMove(stalePaused)).resolves.toEqual({
			kind: "reapable",
			identity: { mode: "build", runId: "run-stale-paused", nonce: null },
		});
		await expect(prepareMove(corrupt)).resolves.toEqual({
			kind: "corrupt_holder",
		});
	});

	it("rejects deleted apps and active incompatible stream leases", async () => {
		const deleted = await h.seedApp({
			id: "app-deleted-move",
			owner: ACTOR,
			project_id: SOURCE,
			deleted_at: new Date(),
		});
		const leased = await h.seedApp({
			id: "app-old-stream",
			owner: ACTOR,
			project_id: SOURCE,
		});
		await h.seedProjectMember(ACTOR, DESTINATION, "owner");
		await enableMoves();
		await h
			.db()
			.insertInto("lookup_stream_capability_leases")
			.values({
				app_id: leased,
				receiver_version: 0,
				expires_at: new Date(Date.now() + 60_000),
			})
			.execute();

		await expect(prepareMove(deleted)).rejects.toBeInstanceOf(
			BlueprintCommitRejectedError,
		);
		await expect(prepareMove(leased)).rejects.toMatchObject({
			name: "ProjectMoveCompatibilityError",
			code: "incompatible_receiver",
		});
	});

	it("uses the shared production capability after the test explicitly enables moves", async () => {
		const appId = await h.seedApp({
			id: "app-production-dormant",
			owner: ACTOR,
			project_id: SOURCE,
		});
		await h.seedProjectMember(ACTOR, DESTINATION, "owner");
		await enableMoves();

		const { prepareAppProjectMove } = await import("../apps");
		await expect(
			prepareAppProjectMove({
				appId,
				expectedFromProjectId: SOURCE,
				toProjectId: DESTINATION,
				actorUserId: ACTOR,
			}),
		).resolves.toEqual({
			kind: "ready",
			requiredAssetIds: [],
			historicalAssetIds: [],
		});
	});

	it("same-Project repair follows the fresh app Project on both sides of a true move", async () => {
		const appId = await h.seedApp({
			id: "app-repair-race",
			owner: ACTOR,
			project_id: SOURCE,
		});
		await h.seedProjectMember(ACTOR, DESTINATION, "owner");
		await seedCase(appId, DESTINATION);

		await expect(repairAppCaseTenancy(appId, ACTOR)).resolves.toEqual({
			projectId: SOURCE,
			moved: 1,
		});
		await enableMoves();
		await expect(commitMove(appId)).resolves.toEqual({ kind: "moved" });
		await seedCase(appId, SOURCE);
		await expect(repairAppCaseTenancy(appId, ACTOR)).resolves.toEqual({
			projectId: DESTINATION,
			moved: 1,
		});
		const projects = await h
			.pool()
			.query<{ project_id: string }>(
				"SELECT project_id FROM cases WHERE app_id = $1",
				[appId],
			);
		expect(new Set(projects.rows.map((row) => row.project_id))).toEqual(
			new Set([DESTINATION]),
		);
		const migrationCount = await h
			.db()
			.selectFrom("accepted_mutations")
			.select(({ fn }) => fn.countAll().as("count"))
			.where("app_id", "=", appId)
			.executeTakeFirstOrThrow();
		expect(Number(migrationCount.count)).toBe(1);
	});
});
