/**
 * Real-Postgres authority checks for attachment item routes.
 *
 * Project membership alone is intentionally insufficient: the URL app is
 * part of every row predicate so one editor cannot address app A's staged
 * row through app B's item URL inside the same shared Project.
 */

import { describe, expect, it } from "vitest";
import {
	confirmFormAttachment,
	deleteUnsubmittedFormAttachment,
	loadFormAttachmentForEdit,
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
				status: "staged",
				last_promotion_error: null,
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
