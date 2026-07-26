/**
 * Real-Postgres authority checks for attachment item routes.
 *
 * Project membership alone is intentionally insufficient: the URL app is
 * part of every row predicate so one editor cannot address app A's staged
 * row through app B's item URL inside the same shared Project.
 */

import { describe, expect, it } from "vitest";
import {
	beginFormAttachmentPreparation,
	claimFormAttachmentPreparations,
	compensatePendingFormAttachmentInitiation,
	completeFormAttachmentPreparation,
	confirmFormAttachment,
	deleteUnsubmittedFormAttachment,
	loadFormAttachmentForEdit,
	purgeExpiredFormAttachments,
	recordFormAttachmentPreparationFailure,
	retargetStagedFormAttachment,
} from "../formAttachments";
import { setupAppStateTestDb } from "./appStateTestDb";

const h = setupAppStateTestDb("form_attachment_app_scope_");
const PROJECT = "capture-shared-project";
const ACTOR = "capture-shared-editor";

describe("form attachment URL-app authority", () => {
	it("cannot read or mutate app A's row through app B in the same Project", async () => {
		const appA = await h.seedApp({
			id: "capture-app-a",
			owner: ACTOR,
			project_id: PROJECT,
		});
		const appB = await h.seedApp({
			id: "capture-app-b",
			owner: ACTOR,
			project_id: PROJECT,
		});
		await h.seedProjectMember(ACTOR, PROJECT, "editor");
		const attachmentId = crypto.randomUUID();
		await h
			.db()
			.insertInto("form_attachments")
			.values({
				attachment_id: attachmentId,
				attachment_name: `${attachmentId}.png`,
				app_id: appA,
				project_id: PROJECT,
				created_by: ACTOR,
				entry_key: crypto.randomUUID(),
				field_uuid: crypto.randomUUID(),
				instance_path: "/data/photo",
				original_filename: "photo.png",
				extension: ".png",
				content_type: "image/png",
				size_bytes: 3,
				gcs_object_key: `captures-staged/${PROJECT}/${attachmentId}.png`,
				object_generation: "17",
				object_checksum: "checksum",
				prepared_generation: null,
				status: "staged",
				last_preparation_error: null,
				expires_at: new Date(Date.now() + 60_000),
			})
			.execute();

		const scope = {
			attachmentId,
			actorUserId: ACTOR,
			expectedAppId: appB,
			expectedProjectId: PROJECT,
		};
		await expect(loadFormAttachmentForEdit(scope)).resolves.toBeNull();
		await expect(
			confirmFormAttachment({
				...scope,
				sizeBytes: 3,
				objectGeneration: "17",
				objectChecksum: "checksum",
			}),
		).resolves.toEqual({ kind: "not_found" });
		await expect(
			retargetStagedFormAttachment({
				...scope,
				expectedInstancePath: "/data/photo",
				instancePath: "/data/other",
			}),
		).resolves.toBeNull();
		await expect(deleteUnsubmittedFormAttachment(scope)).resolves.toBeNull();

		const unchanged = await h
			.db()
			.selectFrom("form_attachments")
			.select(["app_id", "instance_path", "status"])
			.where("attachment_id", "=", attachmentId)
			.executeTakeFirstOrThrow();
		expect(unchanged).toEqual({
			app_id: appA,
			instance_path: "/data/photo",
			status: "staged",
		});
	});
});

describe("form attachment initiation compensation", () => {
	it("compensates only the exact still-pending initiation generation", async () => {
		const appId = await h.seedApp({
			id: "capture-compensation-app",
			owner: ACTOR,
			project_id: PROJECT,
		});
		const entryKey = crypto.randomUUID();
		const attachmentId = crypto.randomUUID();
		const objectKey = `captures-staged/${PROJECT}/${attachmentId}.png`;
		const baseRow = {
			attachment_id: attachmentId,
			attachment_name: `${attachmentId}.png`,
			app_id: appId,
			project_id: PROJECT,
			created_by: ACTOR,
			entry_key: entryKey,
			field_uuid: crypto.randomUUID(),
			instance_path: "/data/photo",
			original_filename: "photo.png",
			extension: ".png",
			content_type: "image/png",
			size_bytes: 3,
			gcs_object_key: objectKey,
			object_generation: null,
			object_checksum: null,
			prepared_generation: null,
			status: "pending",
			last_preparation_error: null,
			expires_at: new Date(Date.now() + 60_000),
		} as const;
		await h.db().insertInto("form_attachments").values(baseRow).execute();

		const exactAttempt = {
			attachmentId,
			attachmentName: baseRow.attachment_name,
			appId,
			projectId: PROJECT,
			createdBy: ACTOR,
			entryKey,
			fieldUuid: baseRow.field_uuid,
			instancePath: baseRow.instance_path,
			objectKey,
		};
		await expect(
			compensatePendingFormAttachmentInitiation({
				...exactAttempt,
				objectKey: `${objectKey}.other`,
			}),
		).resolves.toBe(false);
		await expect(
			h
				.db()
				.selectFrom("form_attachments")
				.select("status")
				.where("attachment_id", "=", attachmentId)
				.executeTakeFirst(),
		).resolves.toEqual({ status: "pending" });

		await expect(
			compensatePendingFormAttachmentInitiation(exactAttempt),
		).resolves.toBe(true);
		await expect(
			h
				.db()
				.selectFrom("form_attachments")
				.select("attachment_id")
				.where("attachment_id", "=", attachmentId)
				.executeTakeFirst(),
		).resolves.toBeUndefined();

		const stagedAttachmentId = crypto.randomUUID();
		const stagedObjectKey = `captures-staged/${PROJECT}/${stagedAttachmentId}.png`;
		await h
			.db()
			.insertInto("form_attachments")
			.values({
				...baseRow,
				attachment_id: stagedAttachmentId,
				attachment_name: `${stagedAttachmentId}.png`,
				gcs_object_key: stagedObjectKey,
				object_generation: "17",
				object_checksum: "checksum",
				status: "staged",
			})
			.execute();
		await expect(
			compensatePendingFormAttachmentInitiation({
				...exactAttempt,
				attachmentId: stagedAttachmentId,
				attachmentName: `${stagedAttachmentId}.png`,
				objectKey: stagedObjectKey,
			}),
		).resolves.toBe(false);
		await expect(
			h
				.db()
				.selectFrom("form_attachments")
				.select(["status", "object_generation"])
				.where("attachment_id", "=", stagedAttachmentId)
				.executeTakeFirst(),
		).resolves.toEqual({ status: "staged", object_generation: "17" });
	});
});

describe("form attachment preparation concurrency", () => {
	it("keeps a recovery row when Clear wins after preparation starts", async () => {
		const appId = await h.seedApp({
			id: "capture-prepare-clear-app",
			owner: ACTOR,
			project_id: PROJECT,
		});
		await h.seedProjectMember(ACTOR, PROJECT, "editor");
		const entryKey = crypto.randomUUID();
		const attachmentId = crypto.randomUUID();
		const fieldUuid = crypto.randomUUID();
		await h
			.db()
			.insertInto("form_attachments")
			.values({
				attachment_id: attachmentId,
				attachment_name: `${attachmentId}.png`,
				app_id: appId,
				project_id: PROJECT,
				created_by: ACTOR,
				entry_key: entryKey,
				field_uuid: fieldUuid,
				instance_path: "/data/photo",
				original_filename: "photo.png",
				extension: ".png",
				content_type: "image/png",
				size_bytes: 3,
				gcs_object_key: `captures-staged/${PROJECT}/${attachmentId}.png`,
				object_generation: "17",
				object_checksum: "checksum",
				prepared_generation: null,
				status: "staged",
				last_preparation_error: null,
				expires_at: new Date(Date.now() + 60_000),
			})
			.execute();

		await expect(
			beginFormAttachmentPreparation({
				appId,
				projectId: PROJECT,
				actorUserId: ACTOR,
				entryKey,
				formUuid: crypto.randomUUID(),
				requestDigest: "request-a",
				attachments: [
					{
						attachmentName: `${attachmentId}.png`,
						fieldUuid,
						instancePath: "/data/photo",
					},
				],
			}),
		).resolves.toEqual({
			kind: "prepare",
			attachmentIds: [attachmentId],
		});
		const lease = await h
			.db()
			.selectFrom("form_attachments")
			.select(["status", "next_preparation_at"])
			.where("attachment_id", "=", attachmentId)
			.executeTakeFirstOrThrow();
		expect(lease).toMatchObject({
			status: "preparing",
			next_preparation_at: expect.any(Date),
		});

		const cleared = await deleteUnsubmittedFormAttachment({
			attachmentId,
			actorUserId: ACTOR,
			expectedAppId: appId,
			expectedProjectId: PROJECT,
		});
		expect(cleared).toMatchObject({ status: "discarding" });
		expect(cleared?.preparedGeneration).toBeNull();

		// The copy that already held the lease may finish after Clear. Its
		// generation is recorded on the discard row rather than promoted or
		// orphaned, giving the same worker/scheduler an exact cleanup target.
		await expect(
			completeFormAttachmentPreparation(attachmentId, "23"),
		).resolves.toMatchObject({
			status: "discarding",
			preparedGeneration: "23",
		});
		await expect(
			h
				.db()
				.selectFrom("form_attachments")
				.select(["status", "prepared_generation"])
				.where("attachment_id", "=", attachmentId)
				.executeTakeFirstOrThrow(),
		).resolves.toEqual({
			status: "discarding",
			prepared_generation: "23",
		});
	});

	it("lets a user retry a recorded failure immediately without stealing an active lease", async () => {
		const appId = await h.seedApp({
			id: "capture-prepare-foreground-retry-app",
			owner: ACTOR,
			project_id: PROJECT,
		});
		const entryKey = crypto.randomUUID();
		const attachmentId = crypto.randomUUID();
		const fieldUuid = crypto.randomUUID();
		const intent = {
			appId,
			projectId: PROJECT,
			actorUserId: ACTOR,
			entryKey,
			formUuid: crypto.randomUUID(),
			requestDigest: "request-retry",
			attachments: [
				{
					attachmentName: `${attachmentId}.png`,
					fieldUuid,
					instancePath: "/data/photo",
				},
			],
		};
		await h
			.db()
			.insertInto("form_attachments")
			.values({
				attachment_id: attachmentId,
				attachment_name: `${attachmentId}.png`,
				app_id: appId,
				project_id: PROJECT,
				created_by: ACTOR,
				entry_key: entryKey,
				field_uuid: fieldUuid,
				instance_path: "/data/photo",
				original_filename: "photo.png",
				extension: ".png",
				content_type: "image/png",
				size_bytes: 3,
				gcs_object_key: `captures-staged/${PROJECT}/${attachmentId}.png`,
				object_generation: "17",
				object_checksum: "checksum",
				prepared_generation: null,
				status: "staged",
				last_preparation_error: null,
				expires_at: new Date(Date.now() + 60_000),
			})
			.execute();

		await beginFormAttachmentPreparation(intent);
		await expect(
			claimFormAttachmentPreparations({
				attachmentIds: [attachmentId],
			}),
		).resolves.toHaveLength(1);
		await recordFormAttachmentPreparationFailure(
			attachmentId,
			new Error("first copy failed"),
		);
		const backedOff = await h
			.db()
			.selectFrom("form_attachments")
			.select(["last_preparation_error", "next_preparation_at"])
			.where("attachment_id", "=", attachmentId)
			.executeTakeFirstOrThrow();
		expect(backedOff.last_preparation_error).toBe("first copy failed");
		if (backedOff.next_preparation_at === null) {
			throw new Error("A recorded preparation failure must schedule backoff.");
		}
		expect(backedOff.next_preparation_at.getTime()).toBeGreaterThan(Date.now());

		await beginFormAttachmentPreparation(intent);
		await expect(
			claimFormAttachmentPreparations({
				attachmentIds: [attachmentId],
			}),
		).resolves.toHaveLength(1);
	});
});

describe("form attachment expiry", () => {
	it("does not let an existing discard row starve later staged expiry", async () => {
		const appId = await h.seedApp({
			id: "capture-expiry-fairness-app",
			owner: ACTOR,
			project_id: PROJECT,
		});
		const now = Date.now();
		const discardedId = crypto.randomUUID();
		const stagedId = crypto.randomUUID();
		const common = {
			app_id: appId,
			project_id: PROJECT,
			created_by: ACTOR,
			field_uuid: crypto.randomUUID(),
			instance_path: "/data/photo",
			original_filename: "photo.png",
			extension: ".png",
			content_type: "image/png",
			size_bytes: 3,
			object_generation: "17",
			object_checksum: "checksum",
			prepared_generation: null,
			last_preparation_error: null,
			created_at: new Date(now - 3_000),
		};
		await h
			.db()
			.insertInto("form_attachments")
			.values([
				{
					...common,
					attachment_id: discardedId,
					attachment_name: `${discardedId}.png`,
					entry_key: crypto.randomUUID(),
					gcs_object_key: `captures-staged/${PROJECT}/${discardedId}.png`,
					status: "discarding",
					next_preparation_at: new Date(now + 60_000),
					expires_at: new Date(now - 2_000),
				},
				{
					...common,
					attachment_id: stagedId,
					attachment_name: `${stagedId}.png`,
					entry_key: crypto.randomUUID(),
					gcs_object_key: `captures-staged/${PROJECT}/${stagedId}.png`,
					status: "staged",
					next_preparation_at: null,
					expires_at: new Date(now - 1_000),
				},
			])
			.execute();

		await expect(purgeExpiredFormAttachments(1)).resolves.toEqual([
			{
				objectKey: `captures-staged/${PROJECT}/${stagedId}.png`,
				objectGeneration: "17",
			},
		]);
		await expect(
			h
				.db()
				.selectFrom("form_attachments")
				.select("status")
				.where("attachment_id", "=", discardedId)
				.executeTakeFirstOrThrow(),
		).resolves.toEqual({ status: "discarding" });
	});
});
