// lib/db/formAttachments.ts
//
// The submission-scoped lane for files a worker attaches to a form in the
// running preview. Deliberately NOT `media_assets`: a captured photo is
// data, not an authoring asset, and putting it in the library would
// surface it in the media picker, count it against the export budget, and
// make it deletable through the library UI.
//
// ## Two tenancy axes, and why the second one exists
//
// `project_id` is the tenant, the same axis case rows use — every member
// of an app's Project sees the same submissions, so every member may read
// its attachments. `created_by` is narrower and load-bearing: it scopes
// all entry-key writes. The server-minted submission intent reserves rows
// through a client-minted `entry_key`; without the `created_by` filter a
// co-member in a shared Project could reserve or delete another member's
// in-flight captures by sending their entry key — reachable in a shared
// Project, not theoretical.
//
// **There is deliberately no `owner_id` column, and adding one would be a
// mistake.** `owner_id` is the CommCare case-owner — the persona a preview
// acts as — and `lib/case-store/CLAUDE.md` is explicit that it is never a
// tenant filter and never an authorization axis. Read access here is
// Project-wide to match case data, and which worker attached a file is
// already derivable from the submission's case rows. Copying it onto the
// attachment would put a second, staler copy of an authorization-adjacent
// fact one careless `where` clause away from the membership check — which
// is exactly how these two axes get conflated. The conflation is not
// hypothetical: this lane shipped with `settleSubmittedAttachments` passing
// `identity.ownerId` where `actorUserId` belonged, which authorized on
// authored blueprint content and matched zero rows under any persona. It
// survived every test because the two ids are the same string when
// previewing as yourself.
//
// ## Authorization order matches the media lane
//
// Membership first (`projectRoleForInTransaction` + `roleAllowsApp`),
// then the row lock. That is the same order `mediaAssets.ts` and
// `mediaDeletion.ts` take, which is what keeps the two lanes from
// deadlocking against each other. Every denial collapses to the same
// not-found shape: a caller must not be able to tell "exists in a Project
// you cannot see" from "does not exist".

import "server-only";

import { randomUUID } from "node:crypto";
import { type Selectable, sql } from "kysely";
import { roleAllowsApp } from "@/lib/auth/projectRoles";
import { isCaptureFieldKind } from "@/lib/domain";
import {
	captureAttachmentName,
	captureExtensionFor,
	captureInstancePathMatchesTemplate,
	captureObjectKeyFor,
	committedCapturePath,
	MAX_CAPTURE_ATTEMPTS_PER_MINUTE,
	MAX_CAPTURE_ROWS_PER_ENTRY,
	MAX_PROJECT_CAPTURE_BYTES,
	MAX_PROJECT_CAPTURE_ROWS,
	stagedCaptureObjectKeyFor,
} from "@/lib/domain/captureFormats";
import { loadAppInTransaction } from "./apps";
import {
	lockFormAttachmentEntry,
	lockFormAttachmentProjectQuota,
} from "./formAttachmentLocks";
import type { FormAttachmentsTable } from "./pg";
import { getAppDb, withAppTx } from "./pg";
import { projectRoleForInTransaction } from "./projectMembership";

/** Lifecycle of one staged capture. */
export type FormAttachmentStatus =
	| "pending"
	| "staged"
	| "promotion_pending"
	| "submitted";

export class FormAttachmentWriteRejectedError extends Error {
	readonly name = "FormAttachmentWriteRejectedError";
}

export interface FormAttachmentRecord {
	attachmentId: string;
	attachmentName: string;
	appId: string;
	projectId: string;
	createdBy: string;
	entryKey: string;
	fieldUuid: string;
	instancePath: string;
	originalFilename: string;
	extension: string;
	contentType: string;
	sizeBytes: number;
	gcsObjectKey: string;
	objectGeneration: string | null;
	objectChecksum: string | null;
	status: FormAttachmentStatus;
}

function recordFromRow(
	row: Selectable<FormAttachmentsTable>,
): FormAttachmentRecord {
	return {
		attachmentId: row.attachment_id,
		attachmentName: row.attachment_name,
		appId: row.app_id,
		projectId: row.project_id,
		createdBy: row.created_by,
		entryKey: row.entry_key,
		fieldUuid: row.field_uuid,
		instancePath: row.instance_path,
		originalFilename: row.original_filename,
		extension: row.extension,
		contentType: row.content_type,
		// pg returns `bigint` as a string; every consumer wants a number and
		// the value is capped at 4,000,000 by the upload gate.
		sizeBytes: Number(row.size_bytes),
		gcsObjectKey: row.gcs_object_key,
		objectGeneration: row.object_generation,
		objectChecksum: row.object_checksum,
		status: row.status as FormAttachmentStatus,
	};
}

/**
 * Mint a `pending` attachment row and return the key its bytes go to.
 *
 * The caller has already authorized `edit` on the app and resolved its
 * Project — this mirrors `createPendingAsset`, which likewise trusts its
 * route's gate rather than re-deriving one.
 *
 * The id is a fresh `randomUUID()` and the name derives from it plus the
 * validated extension. Neither is derived from the question, the node
 * path, or the repeat index — CommCare's own naming
 * (`MediaHandler.kt::saveFile` → `PropertyUtils::genUUID`) is not either,
 * and a field-derived name would collide across repeat instances exactly
 * where CommCare's does not.
 */
export async function createPendingFormAttachment(args: {
	appId: string;
	projectId: string;
	expectedAppMutationSeq: number;
	createdBy: string;
	entryKey: string;
	fieldUuid: string;
	instancePath: string;
	originalFilename: string;
	extension: string;
	contentType: string;
	sizeBytes: number;
}): Promise<{
	attachmentId: string;
	attachmentName: string;
	objectKey: string;
}> {
	const attachmentId = randomUUID();
	const attachmentName = captureAttachmentName(attachmentId, args.extension);
	const objectKey = stagedCaptureObjectKeyFor(
		args.projectId,
		attachmentId,
		args.extension,
	);
	await withAppTx(async (tx) => {
		const app = await tx
			.selectFrom("apps")
			.select(["project_id", "mutation_seq", "deleted_at"])
			.where("id", "=", args.appId)
			.forShare()
			.executeTakeFirst();
		if (app?.project_id !== args.projectId || app.deleted_at !== null) {
			throw new FormAttachmentWriteRejectedError(
				"The app changed Projects. Reload and attach the file again.",
			);
		}
		if (Number(app.mutation_seq) !== args.expectedAppMutationSeq) {
			throw new FormAttachmentWriteRejectedError(
				"The form changed while the upload started. Reload and attach the file again.",
			);
		}
		const committed = await loadAppInTransaction(tx, args.appId);
		const field = committed?.blueprint.fields[args.fieldUuid];
		const committedPath =
			committed === null
				? undefined
				: committedCapturePath(committed.blueprint, args.fieldUuid);
		if (
			field === undefined ||
			!isCaptureFieldKind(field.kind) ||
			committedPath === undefined ||
			!captureInstancePathMatchesTemplate(
				args.instancePath,
				committedPath.instancePathTemplate,
			) ||
			captureExtensionFor(field.kind, args.originalFilename) !== args.extension
		) {
			throw new FormAttachmentWriteRejectedError(
				"The capture question changed while the upload started. Reload and attach the file again.",
			);
		}
		const role = await projectRoleForInTransaction(
			tx,
			args.createdBy,
			args.projectId,
		);
		if (role === null || !roleAllowsApp(role, "edit")) {
			throw new FormAttachmentWriteRejectedError("App not found.");
		}
		await lockFormAttachmentEntry(tx, {
			appId: args.appId,
			actorUserId: args.createdBy,
			entryKey: args.entryKey,
		});
		await lockFormAttachmentProjectQuota(tx, args.projectId);
		const rate = await sql<{ attempt_count: number | string }>`
			INSERT INTO form_attachment_rate_limits (
				project_id,
				actor_user_id,
				window_started_at,
				attempt_count
			) VALUES (
				${args.projectId},
				${args.createdBy},
				date_trunc('minute', now()),
				1
			)
			ON CONFLICT (project_id, actor_user_id) DO UPDATE SET
				attempt_count = CASE
					WHEN form_attachment_rate_limits.window_started_at =
						date_trunc('minute', now())
					THEN form_attachment_rate_limits.attempt_count + 1
					ELSE 1
				END,
				window_started_at = date_trunc('minute', now())
			RETURNING attempt_count
		`.execute(tx);
		if (Number(rate.rows[0]?.attempt_count) > MAX_CAPTURE_ATTEMPTS_PER_MINUTE) {
			throw new FormAttachmentWriteRejectedError(
				"Too many attachment attempts started at once. Wait a moment and try again.",
			);
		}
		const [entryCountRow, projectUsageRow] = await Promise.all([
			tx
				.selectFrom("form_attachments")
				.select((eb) => eb.fn.countAll<string>().as("count"))
				.where("app_id", "=", args.appId)
				.where("project_id", "=", args.projectId)
				.where("created_by", "=", args.createdBy)
				.where("entry_key", "=", args.entryKey)
				.executeTakeFirstOrThrow(),
			tx
				.selectFrom("form_attachments")
				.select((eb) => [
					eb.fn.countAll<string>().as("count"),
					eb.fn
						.coalesce(eb.fn.sum<string>("size_bytes"), sql<string>`0`)
						.as("bytes"),
				])
				.where("project_id", "=", args.projectId)
				.executeTakeFirstOrThrow(),
		]);
		if (Number(entryCountRow.count) >= MAX_CAPTURE_ROWS_PER_ENTRY) {
			throw new FormAttachmentWriteRejectedError(
				"This form entry has too many attachment attempts. Clear unused files or start the form again.",
			);
		}
		if (Number(projectUsageRow.count) >= MAX_PROJECT_CAPTURE_ROWS) {
			throw new FormAttachmentWriteRejectedError(
				"This Project has reached its captured-file record allowance.",
			);
		}
		if (
			Number(projectUsageRow.bytes) + args.sizeBytes >
			MAX_PROJECT_CAPTURE_BYTES
		) {
			throw new FormAttachmentWriteRejectedError(
				"This Project has reached its captured-file storage allowance.",
			);
		}
		await tx
			.insertInto("form_attachments")
			.values({
				attachment_id: attachmentId,
				attachment_name: attachmentName,
				app_id: args.appId,
				project_id: args.projectId,
				created_by: args.createdBy,
				entry_key: args.entryKey,
				field_uuid: args.fieldUuid,
				instance_path: args.instancePath,
				original_filename: args.originalFilename,
				extension: args.extension,
				content_type: args.contentType,
				size_bytes: args.sizeBytes,
				gcs_object_key: objectKey,
				object_generation: null,
				object_checksum: null,
				status: "pending",
				last_promotion_error: null,
			})
			.execute();
	});
	return { attachmentId, attachmentName, objectKey };
}

/**
 * Read one attachment for an edit-authorized member of a known Project.
 *
 * Exists so confirm can measure the stored object BEFORE flipping the
 * row: doing it the other way round would either hold a transaction open
 * across a GCS round trip, or commit a placeholder size that an
 * idempotent retry then declines to correct.
 */
export async function loadFormAttachmentForEdit(args: {
	attachmentId: string;
	actorUserId: string;
	expectedAppId: string;
	expectedProjectId: string;
}): Promise<FormAttachmentRecord | null> {
	return withAppTx(async (tx) => {
		const role = await projectRoleForInTransaction(
			tx,
			args.actorUserId,
			args.expectedProjectId,
		);
		if (role === null || !roleAllowsApp(role, "edit")) return null;
		const row = await tx
			.selectFrom("form_attachments")
			.selectAll()
			.where("attachment_id", "=", args.attachmentId)
			.where("app_id", "=", args.expectedAppId)
			.where("project_id", "=", args.expectedProjectId)
			.where("created_by", "=", args.actorUserId)
			.executeTakeFirst();
		return row === undefined ? null : recordFromRow(row);
	});
}

/**
 * Authorize the local-dev upload surrogate against the exact pending row.
 *
 * A Project role and a syntactically valid `captures-staged/...` key are not
 * enough: without this row-bound gate an editor could invent an object path,
 * borrow another member's attempt, or choose their own byte cap.
 */
export async function authorizePendingFormAttachmentUpload(args: {
	objectKey: string;
	actorUserId: string;
}): Promise<{ contentType: string; maxBytes: number } | null> {
	return withAppTx(async (tx) => {
		const candidate = await tx
			.selectFrom("form_attachments")
			.select(["app_id", "project_id", "entry_key"])
			.where("gcs_object_key", "=", args.objectKey)
			.where("created_by", "=", args.actorUserId)
			.where("status", "=", "pending")
			.executeTakeFirst();
		if (candidate === undefined) return null;
		const app = await tx
			.selectFrom("apps")
			.select(["project_id", "deleted_at"])
			.where("id", "=", candidate.app_id)
			.forShare()
			.executeTakeFirst();
		if (app?.project_id !== candidate.project_id || app.deleted_at !== null) {
			return null;
		}
		const role = await projectRoleForInTransaction(
			tx,
			args.actorUserId,
			candidate.project_id,
		);
		if (role === null || !roleAllowsApp(role, "edit")) return null;
		await lockFormAttachmentEntry(tx, {
			appId: candidate.app_id,
			actorUserId: args.actorUserId,
			entryKey: candidate.entry_key,
		});
		const row = await tx
			.selectFrom("form_attachments")
			.select(["content_type", "size_bytes"])
			.where("gcs_object_key", "=", args.objectKey)
			.where("created_by", "=", args.actorUserId)
			.where("status", "=", "pending")
			.forUpdate()
			.executeTakeFirst();
		return row === undefined
			? null
			: {
					contentType: row.content_type,
					maxBytes: Number(row.size_bytes),
				};
	});
}

export type ConfirmFormAttachmentResult =
	| { readonly kind: "staged"; readonly attachment: FormAttachmentRecord }
	| {
			readonly kind: "already_staged";
			readonly attachment: FormAttachmentRecord;
	  }
	| { readonly kind: "not_found" };

/**
 * Flip a `pending` row to `staged` once its bytes are known to exist.
 *
 * Until this commits, a form answer must not reference the attachment: a
 * `pending` row's object may not have been PUT, and a submission that
 * promoted it would carry a name with no bytes behind it.
 *
 * Idempotent on `staged` so a retried confirm after a lost response
 * returns the same answer instead of a spurious failure. The terminal
 * update repeats `status = 'pending'` as a compare-and-set, so two
 * concurrent confirms cannot both claim the transition.
 */
export async function confirmFormAttachment(args: {
	attachmentId: string;
	actorUserId: string;
	expectedAppId: string;
	expectedProjectId: string;
	sizeBytes: number;
	objectGeneration: string;
	objectChecksum: string;
}): Promise<ConfirmFormAttachmentResult> {
	return withAppTx(async (tx) => {
		const candidate = await tx
			.selectFrom("form_attachments")
			.select(["app_id", "entry_key"])
			.where("attachment_id", "=", args.attachmentId)
			.where("app_id", "=", args.expectedAppId)
			.where("project_id", "=", args.expectedProjectId)
			.where("created_by", "=", args.actorUserId)
			.executeTakeFirst();
		if (candidate === undefined) return { kind: "not_found" };
		const app = await tx
			.selectFrom("apps")
			.select(["project_id", "deleted_at"])
			.where("id", "=", candidate.app_id)
			.forShare()
			.executeTakeFirst();
		if (app?.project_id !== args.expectedProjectId || app.deleted_at !== null) {
			return { kind: "not_found" };
		}
		const role = await projectRoleForInTransaction(
			tx,
			args.actorUserId,
			args.expectedProjectId,
		);
		if (role === null || !roleAllowsApp(role, "edit")) {
			return { kind: "not_found" };
		}
		await lockFormAttachmentEntry(tx, {
			appId: args.expectedAppId,
			actorUserId: args.actorUserId,
			entryKey: candidate.entry_key,
		});
		await lockFormAttachmentProjectQuota(tx, args.expectedProjectId);
		const row = await tx
			.selectFrom("form_attachments")
			.selectAll()
			.where("attachment_id", "=", args.attachmentId)
			.where("app_id", "=", args.expectedAppId)
			.where("project_id", "=", args.expectedProjectId)
			.where("created_by", "=", args.actorUserId)
			.forUpdate()
			.executeTakeFirst();
		if (row === undefined) return { kind: "not_found" };
		const current = recordFromRow(row);
		if (current.status === "staged") {
			if (
				current.objectGeneration !== args.objectGeneration ||
				current.objectChecksum !== args.objectChecksum ||
				current.sizeBytes !== args.sizeBytes
			) {
				return { kind: "not_found" };
			}
			return { kind: "already_staged", attachment: current };
		}
		if (current.status !== "pending") return { kind: "not_found" };
		if (current.sizeBytes !== args.sizeBytes) {
			throw new FormAttachmentWriteRejectedError(
				"The uploaded file does not match the size selected by the form. Attach it again.",
			);
		}
		const committed = await loadAppInTransaction(tx, args.expectedAppId);
		const field = committed?.blueprint.fields[current.fieldUuid];
		const committedPath =
			committed === null
				? undefined
				: committedCapturePath(committed.blueprint, current.fieldUuid);
		if (
			field === undefined ||
			!isCaptureFieldKind(field.kind) ||
			committedPath === undefined ||
			!captureInstancePathMatchesTemplate(
				current.instancePath,
				committedPath.instancePathTemplate,
			) ||
			captureExtensionFor(field.kind, current.originalFilename) !==
				current.extension
		) {
			throw new FormAttachmentWriteRejectedError(
				"The capture question changed before the upload finished. Reload and attach it again.",
			);
		}
		const projectBytes = await tx
			.selectFrom("form_attachments")
			.select((eb) =>
				eb.fn
					.coalesce(eb.fn.sum<string>("size_bytes"), sql<string>`0`)
					.as("bytes"),
			)
			.where("project_id", "=", args.expectedProjectId)
			.where("attachment_id", "!=", args.attachmentId)
			.executeTakeFirstOrThrow();
		if (
			Number(projectBytes.bytes) + args.sizeBytes >
			MAX_PROJECT_CAPTURE_BYTES
		) {
			throw new FormAttachmentWriteRejectedError(
				"This Project has reached its captured-file storage allowance.",
			);
		}
		const staged = await tx
			.updateTable("form_attachments")
			.set({
				status: "staged",
				size_bytes: args.sizeBytes,
				object_generation: args.objectGeneration,
				object_checksum: args.objectChecksum,
			})
			.where("attachment_id", "=", args.attachmentId)
			.where("app_id", "=", args.expectedAppId)
			.where("project_id", "=", args.expectedProjectId)
			.where("created_by", "=", args.actorUserId)
			.where("status", "=", "pending")
			.returningAll()
			.executeTakeFirst();
		if (staged === undefined) return { kind: "not_found" };
		return { kind: "staged", attachment: recordFromRow(staged) };
	});
}

/**
 * Delete one not-yet-submitted attachment — the clear and replace path.
 *
 * Returns the row so the caller can remove its object; storage cleanup is
 * deliberately the caller's, after the metadata commits, matching
 * `deleteAsset`'s contract. A `submitted` row is never deletable here: it
 * is part of a submission's durable record, and removing it would leave
 * an answer naming bytes that no longer exist.
 *
 * Scoped to the acting member's own rows for the same reason submission
 * reservation is.
 */
export async function deleteUnsubmittedFormAttachment(args: {
	attachmentId: string;
	actorUserId: string;
	expectedAppId: string;
	expectedProjectId: string;
}): Promise<FormAttachmentRecord | null> {
	return withAppTx(async (tx) => {
		const candidate = await tx
			.selectFrom("form_attachments")
			.select(["app_id", "entry_key"])
			.where("attachment_id", "=", args.attachmentId)
			.where("app_id", "=", args.expectedAppId)
			.where("project_id", "=", args.expectedProjectId)
			.where("created_by", "=", args.actorUserId)
			.executeTakeFirst();
		if (candidate === undefined) return null;
		const app = await tx
			.selectFrom("apps")
			.select(["project_id", "deleted_at"])
			.where("id", "=", candidate.app_id)
			.forShare()
			.executeTakeFirst();
		if (app?.project_id !== args.expectedProjectId || app.deleted_at !== null) {
			return null;
		}
		const role = await projectRoleForInTransaction(
			tx,
			args.actorUserId,
			args.expectedProjectId,
		);
		if (role === null || !roleAllowsApp(role, "edit")) return null;
		await lockFormAttachmentEntry(tx, {
			appId: args.expectedAppId,
			actorUserId: args.actorUserId,
			entryKey: candidate.entry_key,
		});
		const deleted = await tx
			.deleteFrom("form_attachments")
			.where("attachment_id", "=", args.attachmentId)
			.where("app_id", "=", args.expectedAppId)
			.where("project_id", "=", args.expectedProjectId)
			.where("created_by", "=", args.actorUserId)
			.where("status", "in", ["pending", "staged"])
			.returningAll()
			.executeTakeFirst();
		return deleted === undefined ? null : recordFromRow(deleted);
	});
}

/**
 * Reproject one staged attachment after a repeat instance is removed.
 *
 * The attachment id is stable; `instance_path` is positional UI state. Repeat
 * compaction moves the answer and its stable React instance together, then
 * this entry-locked CAS moves the server row before a queued submit can read
 * it. Pending uploads are cancelled instead, and durable submission rows are
 * immutable.
 */
export async function retargetStagedFormAttachment(args: {
	attachmentId: string;
	actorUserId: string;
	expectedAppId: string;
	expectedProjectId: string;
	expectedInstancePath: string;
	instancePath: string;
}): Promise<FormAttachmentRecord | null> {
	return withAppTx(async (tx) => {
		const candidate = await tx
			.selectFrom("form_attachments")
			.select(["app_id", "entry_key"])
			.where("attachment_id", "=", args.attachmentId)
			.where("app_id", "=", args.expectedAppId)
			.where("project_id", "=", args.expectedProjectId)
			.where("created_by", "=", args.actorUserId)
			.executeTakeFirst();
		if (candidate === undefined) return null;
		const app = await tx
			.selectFrom("apps")
			.select(["project_id", "deleted_at"])
			.where("id", "=", candidate.app_id)
			.forShare()
			.executeTakeFirst();
		if (app?.project_id !== args.expectedProjectId || app.deleted_at !== null) {
			return null;
		}
		const role = await projectRoleForInTransaction(
			tx,
			args.actorUserId,
			args.expectedProjectId,
		);
		if (role === null || !roleAllowsApp(role, "edit")) return null;
		await lockFormAttachmentEntry(tx, {
			appId: args.expectedAppId,
			actorUserId: args.actorUserId,
			entryKey: candidate.entry_key,
		});
		const row = await tx
			.selectFrom("form_attachments")
			.selectAll()
			.where("attachment_id", "=", args.attachmentId)
			.where("app_id", "=", args.expectedAppId)
			.where("project_id", "=", args.expectedProjectId)
			.where("created_by", "=", args.actorUserId)
			.forUpdate()
			.executeTakeFirst();
		if (row === undefined || row.status !== "staged") return null;
		const current = recordFromRow(row);
		if (current.instancePath === args.instancePath) return current;
		if (current.instancePath !== args.expectedInstancePath) {
			throw new FormAttachmentWriteRejectedError(
				"The repeat row changed again while its attachment moved. Attach the file again.",
			);
		}
		const committed = await loadAppInTransaction(tx, args.expectedAppId);
		const field = committed?.blueprint.fields[current.fieldUuid];
		const committedPath =
			committed === null
				? undefined
				: committedCapturePath(committed.blueprint, current.fieldUuid);
		if (
			field === undefined ||
			!isCaptureFieldKind(field.kind) ||
			committedPath === undefined ||
			!captureInstancePathMatchesTemplate(
				args.expectedInstancePath,
				committedPath.instancePathTemplate,
			) ||
			!captureInstancePathMatchesTemplate(
				args.instancePath,
				committedPath.instancePathTemplate,
			)
		) {
			throw new FormAttachmentWriteRejectedError(
				"The capture question changed while its repeat row moved. Reload and attach the file again.",
			);
		}
		const updated = await tx
			.updateTable("form_attachments")
			.set({ instance_path: args.instancePath })
			.where("attachment_id", "=", args.attachmentId)
			.where("app_id", "=", args.expectedAppId)
			.where("project_id", "=", args.expectedProjectId)
			.where("created_by", "=", args.actorUserId)
			.where("status", "=", "staged")
			.where("instance_path", "=", args.expectedInstancePath)
			.returningAll()
			.executeTakeFirst();
		if (updated === undefined) {
			throw new FormAttachmentWriteRejectedError(
				"The attachment changed while its repeat row moved. Attach it again.",
			);
		}
		return recordFromRow(updated);
	});
}

/**
 * Lease retryable durable-intent rows.
 *
 * `SKIP LOCKED` lets overlapping cleanup jobs share work without copying the
 * same source concurrently. A crashed worker's lease expires, at which point
 * the create-only destination verification makes the retry safe.
 */
export async function claimFormAttachmentPromotions(args?: {
	appId?: string;
	entryKey?: string;
	actorUserId?: string;
	expectedProjectId?: string;
	limit?: number;
}): Promise<readonly FormAttachmentRecord[]> {
	return withAppTx(async (tx) => {
		const now = new Date();
		let query = tx
			.selectFrom("form_attachments")
			.select("attachment_id")
			.where("status", "=", "promotion_pending")
			.where("next_promotion_at", "<=", now)
			.orderBy("next_promotion_at")
			.orderBy("attachment_id")
			.limit(Math.min(Math.max(args?.limit ?? 100, 1), 500))
			.forUpdate()
			.skipLocked();
		if (args?.appId !== undefined) {
			query = query.where("app_id", "=", args.appId);
		}
		if (args?.entryKey !== undefined) {
			query = query.where("entry_key", "=", args.entryKey);
		}
		if (args?.actorUserId !== undefined) {
			query = query.where("created_by", "=", args.actorUserId);
		}
		if (args?.expectedProjectId !== undefined) {
			query = query.where("project_id", "=", args.expectedProjectId);
		}
		const claimed = await query.execute();
		if (claimed.length === 0) return [];
		const rows = await tx
			.updateTable("form_attachments")
			.set((eb) => ({
				promotion_attempts: eb("promotion_attempts", "+", 1),
				next_promotion_at: new Date(now.getTime() + 5 * 60 * 1000),
			}))
			.where(
				"attachment_id",
				"in",
				claimed.map((row) => row.attachment_id),
			)
			.where("status", "=", "promotion_pending")
			.returningAll()
			.execute();
		return rows.map(recordFromRow);
	});
}

/** Mark one successfully copied generation durable. Idempotent/CAS guarded. */
export async function completeFormAttachmentPromotion(
	attachmentId: string,
	destinationGeneration: string,
): Promise<FormAttachmentRecord | null> {
	return withAppTx(async (tx) => {
		const row = await tx
			.selectFrom("form_attachments")
			.selectAll()
			.where("attachment_id", "=", attachmentId)
			.where("status", "=", "promotion_pending")
			.forUpdate()
			.executeTakeFirst();
		if (row === undefined) return null;
		const durableKey = captureObjectKeyFor(
			row.project_id,
			row.attachment_id,
			row.extension,
		);
		const updated = await tx
			.updateTable("form_attachments")
			.set({
				status: "submitted",
				submitted_at: new Date(),
				gcs_object_key: durableKey,
				object_generation: destinationGeneration,
				next_promotion_at: null,
				last_promotion_error: null,
			})
			.where("attachment_id", "=", attachmentId)
			.where("status", "=", "promotion_pending")
			.returningAll()
			.executeTakeFirst();
		return updated === undefined ? null : recordFromRow(updated);
	});
}

/** Preserve the row and schedule another promotion after a transient failure. */
export async function recordFormAttachmentPromotionFailure(
	attachmentId: string,
	error: unknown,
): Promise<number> {
	const message =
		error instanceof Error
			? error.message.slice(0, 2000)
			: String(error).slice(0, 2000);
	const db = await getAppDb();
	const updated = await db
		.updateTable("form_attachments")
		.set({
			last_promotion_error: message,
			next_promotion_at: sql<Date>`now() + make_interval(
				secs => least(
					21600,
					60 * power(
						2,
						least(greatest(promotion_attempts - 1, 0), 8)
					)
				)::integer
			)`,
		})
		.where("attachment_id", "=", attachmentId)
		.where("status", "=", "promotion_pending")
		.returning("promotion_attempts")
		.executeTakeFirst();
	return updated?.promotion_attempts ?? 0;
}

/**
 * Read one attachment for a Project member. Read access is Project-wide
 * (`view`), matching case data: a co-member opening a shared app sees the
 * same submissions and therefore the same attachments.
 */
export async function loadFormAttachmentForActor(args: {
	attachmentId: string;
	actorUserId: string;
}): Promise<FormAttachmentRecord | null> {
	return withAppTx(async (tx) => {
		const row = await tx
			.selectFrom("form_attachments")
			.selectAll()
			.where("attachment_id", "=", args.attachmentId)
			.executeTakeFirst();
		if (row === undefined) return null;
		const role = await projectRoleForInTransaction(
			tx,
			args.actorUserId,
			row.project_id,
		);
		if (role === null || !roleAllowsApp(role, "view")) return null;
		return recordFromRow(row);
	});
}

/**
 * Drop expired non-submitted rows and hand back their object keys.
 *
 * Metadata hygiene only. The bytes have an independent, traffic-
 * independent guarantee — the bucket lifecycle rule on the staging prefix
 * (`lib/storage/media.ts::applyMediaBucketLifecycle`) — because a Project
 * that never writes again must still stop holding a worker's
 * photographs. This sweep exists so the table does not accumulate rows
 * describing bytes GCS has already reaped.
 *
 * Called by the scheduled capture-maintenance job and opportunistically,
 * failure-swallowed, by the initiate route. The two paths share this one
 * bounded deletion primitive.
 */
export async function purgeExpiredFormAttachments(
	limit = 200,
): Promise<readonly { objectKey: string; objectGeneration: string | null }[]> {
	const db = await getAppDb();
	const deleted = await db
		.deleteFrom("form_attachments")
		.where("status", "in", ["pending", "staged"])
		.where((eb) =>
			eb(
				"attachment_id",
				"in",
				eb
					.selectFrom("form_attachments")
					.select("attachment_id")
					.where("status", "in", ["pending", "staged"])
					.where("expires_at", "<", new Date())
					.limit(limit),
			),
		)
		.returning(["gcs_object_key", "object_generation"])
		.execute();
	return deleted.map((row) => ({
		objectKey: row.gcs_object_key,
		objectGeneration: row.object_generation,
	}));
}
