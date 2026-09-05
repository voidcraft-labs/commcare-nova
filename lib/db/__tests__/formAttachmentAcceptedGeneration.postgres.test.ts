import type { Kysely } from "kysely";
import { describe, expect, it, vi } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { PostgresCaseStore } from "@/lib/case-store/postgres/store";
import { prepareCaptureSubmissionBytes } from "@/lib/case-store/postgres/submissionAttachments";
import { HeuristicCaseGenerator } from "@/lib/case-store/sample/heuristic";
import type { Database } from "@/lib/case-store/sql/database";
import { captureObjectKeyFor } from "@/lib/domain/captureFormats";
import { preparePendingFormAttachments } from "../formAttachmentPreparation";
import { setupAppStateTestDb } from "./appStateTestDb";

interface StoredGeneration {
	readonly bytes: Buffer;
	readonly size: number;
	readonly checksum: string;
	readonly contentType: string;
}

const storage = vi.hoisted(() => {
	const objects = new Map<string, Map<string, StoredGeneration>>();
	const currentGeneration = new Map<string, string>();
	const deleted: Array<{ key: string; generation: string }> = [];
	let firstCopyStarted: (() => void) | undefined;
	let releaseFirstCopy: (() => void) | undefined;
	let firstCopyStartedPromise = Promise.resolve();
	let releaseFirstCopyPromise = Promise.resolve();
	let copyCalls = 0;

	const reset = () => {
		objects.clear();
		currentGeneration.clear();
		deleted.length = 0;
		copyCalls = 0;
		firstCopyStartedPromise = new Promise<void>((resolve) => {
			firstCopyStarted = resolve;
		});
		releaseFirstCopyPromise = new Promise<void>((resolve) => {
			releaseFirstCopy = resolve;
		});
	};

	return {
		objects,
		currentGeneration,
		deleted,
		reset,
		firstCopyStarted: () => firstCopyStartedPromise,
		releaseFirstCopy: () => releaseFirstCopy?.(),
		copy: vi.fn(
			async (args: {
				sourceGcsObjectKey: string;
				sourceGeneration: string;
				destinationGcsObjectKey: string;
				expectedSize: number;
				expectedChecksum: string;
				expectedContentType: string;
			}) => {
				copyCalls += 1;
				const source = objects
					.get(args.sourceGcsObjectKey)
					?.get(args.sourceGeneration);
				if (
					source === undefined ||
					source.size !== args.expectedSize ||
					source.checksum !== args.expectedChecksum ||
					source.contentType !== args.expectedContentType
				) {
					throw new Error("stateful fake rejected mismatched source bytes");
				}
				let destinationGeneration = currentGeneration.get(
					args.destinationGcsObjectKey,
				);
				const replay = destinationGeneration !== undefined;
				if (destinationGeneration === undefined) {
					destinationGeneration = "accepted-generation-41";
					objects.set(
						args.destinationGcsObjectKey,
						new Map([[destinationGeneration, source]]),
					);
					currentGeneration.set(
						args.destinationGcsObjectKey,
						destinationGeneration,
					);
				}
				if (copyCalls === 1) {
					firstCopyStarted?.();
					await releaseFirstCopyPromise;
				}
				return { destinationGeneration, replay };
			},
		),
		deleteGeneration: vi.fn(async (key: string, generation: string) => {
			deleted.push({ key, generation });
			objects.get(key)?.delete(generation);
			if (currentGeneration.get(key) === generation) {
				currentGeneration.delete(key);
			}
		}),
		getMetadata: vi.fn(async (key: string) => {
			const generation = currentGeneration.get(key);
			const value =
				generation === undefined
					? undefined
					: objects.get(key)?.get(generation);
			return value === undefined || generation === undefined
				? null
				: { ...value, generation };
		}),
	};
});

vi.mock("@/lib/storage/media", () => ({
	copyAssetObjectIfAbsent: storage.copy,
	deleteAssetGeneration: storage.deleteGeneration,
	getStoredObjectMetadata: storage.getMetadata,
}));

const h = setupAppStateTestDb("accepted_capture_generation_");
const APP_ID = "capture-generation-app";
const PROJECT_ID = "capture-generation-project";
const ACTOR_ID = "capture-generation-editor";
const ENTRY_KEY = "77777777-7777-4777-8777-777777777777";
const ATTACHMENT_ID = "55555555-5555-4555-8555-555555555555";
const FIELD_UUID = testUuid("88888888-8888-4888-8888-888888888888");
const FORM_UUID = testUuid("66666666-6666-4666-8666-666666666666");
const SOURCE_GENERATION = "source-generation-17";
const SOURCE_KEY = `captures-staged/${PROJECT_ID}/${ATTACHMENT_ID}.png`;
const DESTINATION_KEY = captureObjectKeyFor(PROJECT_ID, ATTACHMENT_ID, ".png");
const SOURCE_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);
const SOURCE_CHECKSUM = "crc32c-source";

describe("accepted capture generation storage race", () => {
	it("preserves the winner's exact bytes when an expired worker resumes after atomic submission", async () => {
		storage.reset();
		storage.copy.mockClear();
		storage.deleteGeneration.mockClear();
		storage.getMetadata.mockClear();
		storage.objects.set(
			SOURCE_KEY,
			new Map([
				[
					SOURCE_GENERATION,
					{
						bytes: SOURCE_BYTES,
						size: SOURCE_BYTES.length,
						checksum: SOURCE_CHECKSUM,
						contentType: "image/png",
					},
				],
			]),
		);
		storage.currentGeneration.set(SOURCE_KEY, SOURCE_GENERATION);

		await h.seedApp({
			id: APP_ID,
			owner: ACTOR_ID,
			project_id: PROJECT_ID,
		});
		await h.seedProjectMember(ACTOR_ID, PROJECT_ID, "editor");
		await h
			.db()
			.insertInto("form_attachments")
			.values({
				attachment_id: ATTACHMENT_ID,
				attachment_name: `${ATTACHMENT_ID}.png`,
				app_id: APP_ID,
				project_id: PROJECT_ID,
				created_by: ACTOR_ID,
				entry_key: ENTRY_KEY,
				field_uuid: FIELD_UUID,
				instance_path: "/data/photo",
				original_filename: "photo.png",
				extension: ".png",
				content_type: "image/png",
				size_bytes: SOURCE_BYTES.length,
				gcs_object_key: SOURCE_KEY,
				object_generation: SOURCE_GENERATION,
				object_checksum: SOURCE_CHECKSUM,
				prepared_generation: null,
				status: "preparing",
				next_preparation_at: new Date(Date.now() - 1_000),
				last_preparation_error: null,
				expires_at: new Date(Date.now() + 60_000),
			})
			.execute();

		const staleWorker = preparePendingFormAttachments({
			attachmentIds: [ATTACHMENT_ID],
			limit: 1,
		});
		await storage.firstCopyStarted();

		// Model a crashed worker's lease expiring after it copied the immutable
		// destination but before its completion update returned.
		await h
			.db()
			.updateTable("form_attachments")
			.set({ next_preparation_at: new Date(Date.now() - 1_000) })
			.where("attachment_id", "=", ATTACHMENT_ID)
			.execute();

		const intent = {
			entryKey: ENTRY_KEY,
			formUuid: FORM_UUID,
			expectedAppMutationSeq: 0,
			requestDigest: "accepted-generation-request",
			attachments: [
				{
					attachmentName: `${ATTACHMENT_ID}.png`,
					fieldUuid: FIELD_UUID,
					instancePath: "/data/photo",
				},
			],
			allowedAttachments: [
				{
					fieldUuid: FIELD_UUID,
					instancePathTemplate: "/data/photo",
					captureKind: "image" as const,
					acceptedFormats: [{ extension: ".png", contentType: "image/png" }],
				},
			],
		};
		await prepareCaptureSubmissionBytes({
			appId: APP_ID,
			projectId: PROJECT_ID,
			actorUserId: ACTOR_ID,
			intent,
		});

		const store = new PostgresCaseStore({
			projectId: PROJECT_ID,
			actorUserId: ACTOR_ID,
			ownerId: ACTOR_ID,
			db: h.db() as unknown as Kysely<Database>,
			sampleGenerator: new HeuristicCaseGenerator(),
		});
		await store.applySubmission({
			appId: APP_ID,
			ordinary: { kind: "none" },
			submissionReceipt: {
				entryKey: intent.entryKey,
				formUuid: intent.formUuid,
				expectedAppMutationSeq: intent.expectedAppMutationSeq,
				blueprintDigest: "0".repeat(64),
				requestDigest: intent.requestDigest,
			},
			captureIntent: intent,
		});

		storage.releaseFirstCopy();
		await expect(staleWorker).resolves.toEqual({
			prepared: 0,
			discarded: 0,
			failed: 0,
			superseded: 1,
		});

		const accepted = await h
			.db()
			.selectFrom("form_attachments")
			.select([
				"status",
				"object_generation",
				"prepared_generation",
				"preparation_attempts",
			])
			.where("attachment_id", "=", ATTACHMENT_ID)
			.executeTakeFirstOrThrow();
		expect(accepted).toEqual({
			status: "submitted",
			object_generation: "accepted-generation-41",
			prepared_generation: null,
			preparation_attempts: 2,
		});
		expect(
			storage.objects.get(DESTINATION_KEY)?.get("accepted-generation-41")
				?.bytes,
		).toEqual(SOURCE_BYTES);
		expect(storage.deleteGeneration).not.toHaveBeenCalledWith(
			DESTINATION_KEY,
			"accepted-generation-41",
		);
		expect(storage.currentGeneration.get(DESTINATION_KEY)).toBe(
			"accepted-generation-41",
		);
		expect(storage.copy).toHaveBeenCalledTimes(2);
	});
});
