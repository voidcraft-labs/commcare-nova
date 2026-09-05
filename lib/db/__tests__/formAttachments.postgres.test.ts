/**
 * Real-Postgres authority checks for attachment item routes.
 *
 * Project membership alone is intentionally insufficient: the URL app is
 * part of every row predicate so one editor cannot address app A's staged
 * row through app B's item URL inside the same shared Project.
 */

import { sql } from "kysely";
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, f, withUserSequences } from "@/lib/__tests__/docHelpers";
import { proseText } from "@/lib/domain/prose";

import { resolveAuthorizedAppSnapshot } from "../appAccess";
import {
	beginFormAttachmentPreparation,
	claimFormAttachmentPreparations,
	compensatePendingFormAttachmentInitiation,
	completeFormAttachmentPreparation,
	confirmFormAttachment,
	createPendingFormAttachment,
	deleteUnsubmittedFormAttachment,
	loadAuthorizedFormSubmissionSnapshot,
	loadFormAttachmentForEdit,
	purgeExpiredFormAttachments,
	recordFormAttachmentPreparationFailure,
	retargetStagedFormAttachment,
} from "../formAttachments";
import { setupAppStateTestDb } from "./appStateTestDb";

const h = setupAppStateTestDb("form_attachment_app_scope_");
const PROJECT = "capture-shared-project";
const ACTOR = "capture-shared-editor";

describe("form submission authorization snapshot", () => {
	it("returns one committed app snapshot only after fresh edit authorization", async () => {
		const appId = await h.seedApp({
			id: "capture-authorized-snapshot-app",
			owner: "capture-authorized-snapshot-owner",
			project_id: PROJECT,
			app_name: "Authorized submission snapshot",
		});
		await h.seedProjectMember(ACTOR, PROJECT, "editor");

		await expect(
			loadAuthorizedFormSubmissionSnapshot({
				appId,
				actorUserId: ACTOR,
				entryKey: crypto.randomUUID(),
			}),
		).resolves.toMatchObject({
			kind: "current",
			projectId: PROJECT,
			app: {
				blueprint: { appName: "Authorized submission snapshot" },
				mutation_seq: 0,
			},
		});
	});

	it("reauthorizes before returning a durable replay receipt", async () => {
		const appId = await h.seedApp({
			id: "capture-replay-authorization-app",
			owner: "capture-replay-authorization-owner",
			project_id: PROJECT,
		});
		const entryKey = crypto.randomUUID();
		const formUuid = testUuid(crypto.randomUUID());
		await h
			.db()
			.insertInto("form_submission_intents")
			.values({
				app_id: appId,
				project_id: PROJECT,
				created_by: ACTOR,
				entry_key: entryKey,
				form_uuid: formUuid,
				app_mutation_seq: 0,
				request_digest: "accepted-request",
				result: JSON.stringify({
					childCaseIds: [],
					operations: [],
				}),
			})
			.execute();

		await expect(
			loadAuthorizedFormSubmissionSnapshot({
				appId,
				actorUserId: ACTOR,
				entryKey,
			}),
		).rejects.toThrow("App not found.");

		await h.seedProjectMember(ACTOR, PROJECT, "editor");
		await expect(
			loadAuthorizedFormSubmissionSnapshot({
				appId,
				actorUserId: ACTOR,
				entryKey,
			}),
		).resolves.toEqual({
			kind: "replay",
			projectId: PROJECT,
			/* The role the snapshot proved, carried out so a caller needing it
			 * (Preview's project-space resolution) does not re-read it. */
			role: "editor",
			receipt: {
				formUuid,
				requestDigest: "accepted-request",
				result: {
					childCaseIds: [],
					operations: [],
				},
			},
		});
	});

	it("replays before hydrating form, capture, and persona topology that was deleted after acceptance", async () => {
		const formUuid = testUuid("10000000-0000-4000-8000-000000000001");
		const fieldUuid = testUuid("10000000-0000-4000-8000-000000000002");
		const userTypeUuid = testUuid("10000000-0000-4000-8000-000000000003");
		const personaUuid = testUuid("10000000-0000-4000-8000-000000000004");
		const base = buildDoc({
			appName: "Deleted accepted topology",
			modules: [
				{
					name: "Visits",
					forms: [
						{
							uuid: formUuid,
							name: "Visit",
							type: "survey",
							fields: [
								f({
									uuid: fieldUuid,
									id: "photo",
									kind: "image",
									label: proseText("Photo"),
								}),
							],
						},
					],
				},
			],
		});
		const doc = withUserSequences({
			...base,
			userTypes: {
				[userTypeUuid]: {
					uuid: userTypeUuid,
					name: "Worker",
					values: {},
				},
			},
			personas: {
				[personaUuid]: {
					uuid: personaUuid,
					name: "Test worker",
					userTypeUuid,
					values: {},
				},
			},
		});
		const appId = await h.seedAppWithBlueprint(doc, {
			id: "capture-replay-deleted-topology-app",
			owner: "capture-replay-deleted-topology-owner",
			projectId: PROJECT,
		});
		await h.seedProjectMember(ACTOR, PROJECT, "editor");
		const entryKey = crypto.randomUUID();
		const acceptedResult = {
			primaryCaseId: crypto.randomUUID(),
			childCaseIds: [],
			operations: [],
		};
		await h
			.db()
			.insertInto("form_submission_intents")
			.values({
				app_id: appId,
				project_id: PROJECT,
				created_by: ACTOR,
				entry_key: entryKey,
				form_uuid: formUuid,
				app_mutation_seq: 0,
				request_digest: "accepted-before-topology-delete",
				result: JSON.stringify(acceptedResult),
			})
			.execute();

		const deleted = await h
			.db()
			.deleteFrom("blueprint_entities")
			.where("app_id", "=", appId)
			.where("kind", "in", ["form", "field", "user_type", "persona"])
			.returning("kind")
			.execute();
		expect(new Set(deleted.map((row) => row.kind))).toEqual(
			new Set(["form", "field", "user_type", "persona"]),
		);

		await expect(
			loadAuthorizedFormSubmissionSnapshot({
				appId,
				actorUserId: ACTOR,
				entryKey,
			}),
		).resolves.toEqual({
			kind: "replay",
			projectId: PROJECT,
			/* The role the snapshot proved, carried out so a caller needing it
			 * (Preview's project-space resolution) does not re-read it. */
			role: "editor",
			receipt: {
				formUuid,
				requestDigest: "accepted-before-topology-delete",
				result: acceptedResult,
			},
		});
	});

	it("authorizes attachment initiation before exposing Project or topology drift", async () => {
		const fieldUuid = testUuid(crypto.randomUUID());
		const doc = buildDoc({
			modules: [
				{
					name: "Visits",
					forms: [
						{
							name: "Visit",
							type: "survey",
							fields: [
								f({
									uuid: fieldUuid,
									id: "photo",
									kind: "image",
									label: proseText("Photo"),
								}),
							],
						},
					],
				},
			],
		});
		const appId = await h.seedAppWithBlueprint(doc, {
			id: "capture-initiation-authorization-app",
			owner: "capture-initiation-authorization-owner",
			projectId: PROJECT,
		});
		const initiate = () =>
			createPendingFormAttachment({
				appId,
				projectId: "attacker-claimed-project",
				expectedAppMutationSeq: 99,
				createdBy: ACTOR,
				entryKey: crypto.randomUUID(),
				fieldUuid,
				instancePath: "/data/photo",
				originalFilename: "photo.png",
				extension: ".png",
				contentType: "image/png",
				sizeBytes: 3,
			});

		await expect(initiate()).rejects.toThrow("App not found.");
		await h.seedProjectMember(ACTOR, PROJECT, "editor");
		await expect(initiate()).rejects.toThrow("The app changed Projects.");
	});
});

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
				field_uuid: testUuid(crypto.randomUUID()),
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

describe("form attachment authored-path retarget", () => {
	it("accepts the row's stored old path when only the destination matches the current capture template", async () => {
		const fieldUuid = testUuid(crypto.randomUUID());
		const doc = buildDoc({
			modules: [
				{
					name: "Visits",
					forms: [
						{
							name: "Visit",
							type: "survey",
							fields: [
								f({
									uuid: fieldUuid,
									id: "evidence",
									kind: "image",
									label: proseText("Evidence"),
								}),
							],
						},
					],
				},
			],
		});
		const appId = await h.seedAppWithBlueprint(doc, {
			id: "capture-authored-retarget-app",
			owner: ACTOR,
			projectId: PROJECT,
		});
		const attachmentId = crypto.randomUUID();
		await h
			.db()
			.insertInto("form_attachments")
			.values({
				attachment_id: attachmentId,
				attachment_name: `${attachmentId}.png`,
				app_id: appId,
				project_id: PROJECT,
				created_by: ACTOR,
				entry_key: crypto.randomUUID(),
				field_uuid: fieldUuid,
				// The row was staged before the author renamed `photo` to
				// `evidence`; only this stored CAS coordinate remains old.
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
			retargetStagedFormAttachment({
				attachmentId,
				actorUserId: ACTOR,
				expectedAppId: appId,
				expectedProjectId: PROJECT,
				expectedInstancePath: "/data/photo",
				instancePath: "/data/evidence",
			}),
		).resolves.toMatchObject({ instancePath: "/data/evidence" });
		await expect(
			h
				.db()
				.selectFrom("form_attachments")
				.select("instance_path")
				.where("attachment_id", "=", attachmentId)
				.executeTakeFirstOrThrow(),
		).resolves.toEqual({ instance_path: "/data/evidence" });
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
			field_uuid: testUuid(crypto.randomUUID()),
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
	it("re-proves edit membership before a staged row can enter preparation", async () => {
		const owner = "capture-preparation-owner";
		const appId = await h.seedApp({
			id: "capture-prepare-revoked-app",
			owner,
			project_id: PROJECT,
		});
		await h.seedProjectMember(ACTOR, PROJECT, "editor");
		const entryKey = crypto.randomUUID();
		const attachmentId = crypto.randomUUID();
		const fieldUuid = testUuid(crypto.randomUUID());
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

		// The actual initial Submit gate admits this actor and releases its
		// transaction. Revoke membership in that exact race window before the
		// preparation transaction begins: the durable-copy transition must use
		// current authority, not the earlier authorized snapshot.
		await expect(
			resolveAuthorizedAppSnapshot(appId, ACTOR, "edit"),
		).resolves.toMatchObject({
			projectId: PROJECT,
			actorUserId: ACTOR,
			canEdit: true,
		});
		await sql`
			DELETE FROM auth_member
			WHERE "userId" = ${ACTOR}
				AND "organizationId" = ${PROJECT}
		`.execute(h.db());

		await expect(
			beginFormAttachmentPreparation({
				appId,
				projectId: PROJECT,
				actorUserId: ACTOR,
				entryKey,
				formUuid: testUuid(crypto.randomUUID()),
				requestDigest: "request-after-revocation",
				attachments: [
					{
						attachmentName: `${attachmentId}.png`,
						fieldUuid,
						instancePath: "/data/photo",
					},
				],
			}),
		).rejects.toThrow("App not found.");
		await expect(
			h
				.db()
				.selectFrom("form_attachments")
				.select(["status", "next_preparation_at"])
				.where("attachment_id", "=", attachmentId)
				.executeTakeFirstOrThrow(),
		).resolves.toEqual({
			status: "staged",
			next_preparation_at: null,
		});
	});

	it("keeps a recovery row when Clear wins after preparation starts", async () => {
		const appId = await h.seedApp({
			id: "capture-prepare-clear-app",
			owner: ACTOR,
			project_id: PROJECT,
		});
		await h.seedProjectMember(ACTOR, PROJECT, "editor");
		const entryKey = crypto.randomUUID();
		const attachmentId = crypto.randomUUID();
		const fieldUuid = testUuid(crypto.randomUUID());
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
				formUuid: testUuid(crypto.randomUUID()),
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
		const [claimed] = await claimFormAttachmentPreparations({
			attachmentIds: [attachmentId],
		});
		if (claimed === undefined) {
			throw new Error("The preparing attachment must be claimable.");
		}
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
			completeFormAttachmentPreparation(
				attachmentId,
				claimed.preparationAttempts,
				"23",
			),
		).resolves.toMatchObject({
			kind: "discarding",
			attachment: {
				status: "discarding",
				preparedGeneration: "23",
			},
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
		const fieldUuid = testUuid(crypto.randomUUID());
		const intent = {
			appId,
			projectId: PROJECT,
			actorUserId: ACTOR,
			entryKey,
			formUuid: testUuid(crypto.randomUUID()),
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
		const [failedLease] = await claimFormAttachmentPreparations({
			attachmentIds: [attachmentId],
		});
		if (failedLease === undefined) {
			throw new Error("The first preparation lease must be claimable.");
		}
		await expect(
			claimFormAttachmentPreparations({
				attachmentIds: [attachmentId],
			}),
		).resolves.toHaveLength(0);
		await expect(
			recordFormAttachmentPreparationFailure(
				attachmentId,
				failedLease.preparationAttempts,
				new Error("first copy failed"),
			),
		).resolves.toEqual({
			kind: "recorded",
			attempts: failedLease.preparationAttempts,
		});
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

	it("fences an expired duplicate after the newer attempt prepares and submits", async () => {
		const appId = await h.seedApp({
			id: "capture-expired-duplicate-app",
			owner: ACTOR,
			project_id: PROJECT,
		});
		const attachmentId = crypto.randomUUID();
		await h
			.db()
			.insertInto("form_attachments")
			.values({
				attachment_id: attachmentId,
				attachment_name: `${attachmentId}.png`,
				app_id: appId,
				project_id: PROJECT,
				created_by: ACTOR,
				entry_key: crypto.randomUUID(),
				field_uuid: testUuid(crypto.randomUUID()),
				instance_path: "/data/photo",
				original_filename: "photo.png",
				extension: ".png",
				content_type: "image/png",
				size_bytes: 3,
				gcs_object_key: `captures-staged/${PROJECT}/${attachmentId}.png`,
				object_generation: "17",
				object_checksum: "checksum",
				prepared_generation: null,
				status: "preparing",
				last_preparation_error: null,
				next_preparation_at: new Date(Date.now() - 1_000),
				expires_at: new Date(Date.now() + 60_000),
			})
			.execute();

		const [stale] = await claimFormAttachmentPreparations({
			attachmentIds: [attachmentId],
		});
		if (stale === undefined) throw new Error("The first lease must exist.");
		await h
			.db()
			.updateTable("form_attachments")
			.set({ next_preparation_at: new Date(Date.now() - 1_000) })
			.where("attachment_id", "=", attachmentId)
			.execute();
		const [winner] = await claimFormAttachmentPreparations({
			attachmentIds: [attachmentId],
		});
		if (winner === undefined)
			throw new Error("The expired lease must be reclaimed.");
		expect(winner.preparationAttempts).toBe(stale.preparationAttempts + 1);

		await expect(
			completeFormAttachmentPreparation(
				attachmentId,
				winner.preparationAttempts,
				"23",
			),
		).resolves.toMatchObject({
			kind: "prepared",
			attachment: {
				status: "prepared",
				preparedGeneration: "23",
			},
		});
		await expect(
			completeFormAttachmentPreparation(
				attachmentId,
				stale.preparationAttempts,
				"23",
			),
		).resolves.toEqual({ kind: "superseded" });
		await expect(
			recordFormAttachmentPreparationFailure(
				attachmentId,
				stale.preparationAttempts,
				new Error("late stale failure"),
			),
		).resolves.toEqual({ kind: "superseded" });

		await h
			.db()
			.updateTable("form_attachments")
			.set({
				status: "submitted",
				prepared_generation: null,
				submitted_at: new Date(),
			})
			.where("attachment_id", "=", attachmentId)
			.execute();
		await expect(
			completeFormAttachmentPreparation(
				attachmentId,
				stale.preparationAttempts,
				"23",
			),
		).resolves.toEqual({ kind: "superseded" });
		await expect(
			h
				.db()
				.selectFrom("form_attachments")
				.select([
					"status",
					"prepared_generation",
					"preparation_attempts",
					"last_preparation_error",
				])
				.where("attachment_id", "=", attachmentId)
				.executeTakeFirstOrThrow(),
		).resolves.toEqual({
			status: "submitted",
			prepared_generation: null,
			preparation_attempts: winner.preparationAttempts,
			last_preparation_error: null,
		});
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
			field_uuid: testUuid(crypto.randomUUID()),
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

		await expect(purgeExpiredFormAttachments(1)).resolves.toEqual({
			processed: 1,
			transitioned: 0,
			objects: [
				{
					objectKey: `captures-staged/${PROJECT}/${stagedId}.png`,
					objectGeneration: "17",
				},
			],
		});
		await expect(
			h
				.db()
				.selectFrom("form_attachments")
				.select("status")
				.where("attachment_id", "=", discardedId)
				.executeTakeFirstOrThrow(),
		).resolves.toEqual({ status: "discarding" });
	});

	it("continues across more than one recoverable-only expiry batch", async () => {
		const appId = await h.seedApp({
			id: "capture-expiry-recoverable-batches-app",
			owner: ACTOR,
			project_id: PROJECT,
		});
		const now = Date.now();
		const attachmentIds = Array.from({ length: 3 }, () => crypto.randomUUID());
		await h
			.db()
			.insertInto("form_attachments")
			.values(
				attachmentIds.map((attachmentId, index) => ({
					attachment_id: attachmentId,
					attachment_name: `${attachmentId}.png`,
					app_id: appId,
					project_id: PROJECT,
					created_by: ACTOR,
					entry_key: crypto.randomUUID(),
					field_uuid: testUuid(crypto.randomUUID()),
					instance_path: "/data/photo",
					original_filename: "photo.png",
					extension: ".png",
					content_type: "image/png",
					size_bytes: 3,
					gcs_object_key: `captures-staged/${PROJECT}/${attachmentId}.png`,
					object_generation: "17",
					object_checksum: "checksum",
					prepared_generation: "23",
					status: "prepared" as const,
					last_preparation_error: null,
					next_preparation_at: null,
					created_at: new Date(now - 10 * 24 * 60 * 60 * 1_000),
					expires_at: new Date(now - 3_000 + index),
				})),
			)
			.execute();

		await expect(purgeExpiredFormAttachments(2)).resolves.toEqual({
			processed: 2,
			transitioned: 2,
			objects: [],
		});
		await expect(purgeExpiredFormAttachments(2)).resolves.toEqual({
			processed: 1,
			transitioned: 1,
			objects: [],
		});
		await expect(purgeExpiredFormAttachments(2)).resolves.toEqual({
			processed: 0,
			transitioned: 0,
			objects: [],
		});
		const rows = await h
			.db()
			.selectFrom("form_attachments")
			.select(["attachment_id", "status"])
			.where("attachment_id", "in", attachmentIds)
			.orderBy("attachment_id")
			.execute();
		expect(rows).toHaveLength(3);
		expect(rows.every((row) => row.status === "discarding")).toBe(true);
	});
});
