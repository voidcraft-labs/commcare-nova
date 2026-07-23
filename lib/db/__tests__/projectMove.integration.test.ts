/** Dormant S02c3 Project-move protocol against one shared Postgres database. */

import type { UIMessage } from "ai";
import { Client } from "pg";
import { describe, expect, it } from "vitest";
import {
	commitAppProjectMoveInTransaction,
	prepareAppProjectMoveInTransaction,
	repairAppCaseTenancy,
} from "../apps";
import {
	BlueprintCommitRejectedError,
	CommitReauthError,
} from "../commitGuard";
import { setTransactionWriterVersion } from "../pg";
import { ProjectMoveCompatibilityError } from "../projectMoveAdmission";
import { mergeThreadTurnMessages } from "../threads";
import { setupAppStateTestDb } from "./appStateTestDb";

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

describe("dormant atomic Project move", () => {
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

	it("keeps the production capability wrapper dormant at writer v0", async () => {
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
		).rejects.toBeInstanceOf(ProjectMoveCompatibilityError);
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
