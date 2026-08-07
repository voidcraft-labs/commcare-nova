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
import { isCaptureFieldKind, type Uuid } from "@/lib/domain";
import {
	captureAttachmentName,
	captureExtensionFor,
	captureInstancePathMatchesTemplate,
	committedCapturePath,
	MAX_CAPTURE_ATTEMPTS_PER_MINUTE,
	MAX_CAPTURE_ROWS_PER_ENTRY,
	MAX_PROJECT_CAPTURE_BYTES,
	MAX_PROJECT_CAPTURE_ROWS,
	stagedCaptureObjectKeyFor,
} from "@/lib/domain/captureFormats";
import { loadAppInTransaction } from "./apps";
import {
	lockFormAttachmentProjectQuota,
	lockFormSubmissionEntry,
} from "./formAttachmentLocks";
import { safePersistedSequence } from "./persistedJson";
import type { FormAttachmentsTable } from "./pg";
import { getAppDb, withAppTx } from "./pg";
import { projectRoleForInTransaction } from "./projectMembership";
import type { AppDoc } from "./types";

/** Lifecycle of one staged capture. */
export type FormAttachmentStatus =
	| "pending"
	| "staged"
	| "preparing"
	| "prepared"
	| "discarding"
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
	fieldUuid: Uuid;
	instancePath: string;
	originalFilename: string;
	extension: string;
	contentType: string;
	sizeBytes: number;
	gcsObjectKey: string;
	objectGeneration: string | null;
	objectChecksum: string | null;
	preparedGeneration: string | null;
	status: FormAttachmentStatus;
	/** Monotonic lease token. Every destructive/completing worker write must
	 *  compare this exact attempt so an expired duplicate cannot act for a
	 *  newer lease. */
	preparationAttempts: number;
}

export interface FormSubmissionReceiptRecord {
	readonly formUuid: Uuid;
	readonly requestDigest: string;
	readonly result: unknown;
}

export type AuthorizedFormSubmissionSnapshot =
	| {
			readonly kind: "replay";
			readonly projectId: string;
			/** The caller's proven role, so a caller needs no second read. */
			readonly role: string;
			readonly receipt: FormSubmissionReceiptRecord;
	  }
	| {
			readonly kind: "current";
			readonly projectId: string;
			readonly role: string;
			readonly app: AppDoc;
	  };

/**
 * Establish the complete server-authoritative submission read world.
 *
 * The ordering is deliberate and is shared by both replay and a new submit:
 * app placement lock → fresh Project membership → durable entry receipt.
 * Current blueprint topology and `mutation_seq` are loaded only when no
 * receipt exists. A response-lost retry therefore cannot be rejected because
 * a peer subsequently removed the form, capture question, or persona, while a
 * non-member never observes any of those facts.
 */
export async function loadAuthorizedFormSubmissionSnapshot(args: {
	appId: string;
	actorUserId: string;
	entryKey: string;
}): Promise<AuthorizedFormSubmissionSnapshot> {
	return withAppTx(async (tx) => {
		const appRow = await tx
			.selectFrom("apps")
			.select(["project_id", "deleted_at"])
			.where("id", "=", args.appId)
			.forShare()
			.executeTakeFirst();
		if (!appRow || appRow.deleted_at !== null) {
			throw new FormAttachmentWriteRejectedError("App not found.");
		}
		const role = await projectRoleForInTransaction(
			tx,
			args.actorUserId,
			appRow.project_id,
		);
		if (role === null || !roleAllowsApp(role, "edit")) {
			throw new FormAttachmentWriteRejectedError("App not found.");
		}
		const receipt = await tx
			.selectFrom("form_submission_intents")
			.select(["form_uuid", "request_digest", "result"])
			.where("app_id", "=", args.appId)
			.where("project_id", "=", appRow.project_id)
			.where("created_by", "=", args.actorUserId)
			.where("entry_key", "=", args.entryKey)
			.executeTakeFirst();
		if (receipt !== undefined) {
			if (receipt.result === null) {
				throw new Error(
					"A committed form submission intent is missing its atomic result.",
				);
			}
			return {
				kind: "replay",
				projectId: appRow.project_id,
				role,
				receipt: {
					formUuid: receipt.form_uuid,
					requestDigest: receipt.request_digest,
					result: receipt.result,
				},
			};
		}
		const app = await loadAppInTransaction(tx, args.appId);
		if (app === null || app.project_id !== appRow.project_id) {
			throw new FormAttachmentWriteRejectedError("App not found.");
		}
		return {
			kind: "current",
			projectId: appRow.project_id,
			role,
			app,
		};
	});
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
		preparedGeneration: row.prepared_generation,
		status: row.status as FormAttachmentStatus,
		preparationAttempts: row.preparation_attempts,
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
	fieldUuid: Uuid;
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
		if (!app || app.deleted_at !== null) {
			throw new FormAttachmentWriteRejectedError("App not found.");
		}
		const role = await projectRoleForInTransaction(
			tx,
			args.createdBy,
			app.project_id,
		);
		if (role === null || !roleAllowsApp(role, "edit")) {
			throw new FormAttachmentWriteRejectedError("App not found.");
		}
		if (app.project_id !== args.projectId) {
			throw new FormAttachmentWriteRejectedError(
				"The app changed Projects. Reload and attach the file again.",
			);
		}
		if (
			safePersistedSequence(
				app.mutation_seq,
				`apps.mutation_seq for app ${args.appId}`,
			) !== args.expectedAppMutationSeq
		) {
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
		await lockFormSubmissionEntry(tx, {
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
				prepared_generation: null,
				status: "pending",
				last_preparation_error: null,
			})
			.execute();
	});
	return { attachmentId, attachmentName, objectKey };
}

const INITIATION_COMPENSATION_LOCK_TIMEOUT = "1s";
const INITIATION_COMPENSATION_STATEMENT_TIMEOUT = "2s";

/**
 * Best-effort compensation for a pending row whose signed URL was never issued.
 *
 * The server passes the complete just-created attempt identity rather than only
 * its primary key. The single DELETE is the race fence: it may remove exactly
 * that generation only while it is still `pending`; a concurrent transition
 * that somehow won first makes the CAS a no-op instead of deleting staged or
 * durable evidence. Short transaction-local timeouts keep a signing failure
 * from turning into an unbounded request wait. A timeout/error is deliberately
 * caller-swallowed because `expires_at` plus the scheduled sweep is the durable
 * fallback.
 */
export async function compensatePendingFormAttachmentInitiation(args: {
	attachmentId: string;
	attachmentName: string;
	appId: string;
	projectId: string;
	createdBy: string;
	entryKey: string;
	fieldUuid: Uuid;
	instancePath: string;
	objectKey: string;
}): Promise<boolean> {
	return withAppTx(async (tx) => {
		await sql`
			SELECT
				set_config(
					'lock_timeout',
					${INITIATION_COMPENSATION_LOCK_TIMEOUT},
					true
				),
				set_config(
					'statement_timeout',
					${INITIATION_COMPENSATION_STATEMENT_TIMEOUT},
					true
				)
		`.execute(tx);
		const deleted = await tx
			.deleteFrom("form_attachments")
			.where("attachment_id", "=", args.attachmentId)
			.where("attachment_name", "=", args.attachmentName)
			.where("app_id", "=", args.appId)
			.where("project_id", "=", args.projectId)
			.where("created_by", "=", args.createdBy)
			.where("entry_key", "=", args.entryKey)
			.where("field_uuid", "=", args.fieldUuid)
			.where("instance_path", "=", args.instancePath)
			.where("gcs_object_key", "=", args.objectKey)
			.where("status", "=", "pending")
			.where("object_generation", "is", null)
			.where("object_checksum", "is", null)
			.returning("attachment_id")
			.executeTakeFirst();
		return deleted !== undefined;
	});
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
		if (
			!app ||
			app.deleted_at !== null ||
			app.project_id !== candidate.project_id
		) {
			return null;
		}
		const role = await projectRoleForInTransaction(
			tx,
			args.actorUserId,
			candidate.project_id,
		);
		if (role === null || !roleAllowsApp(role, "edit")) return null;
		await lockFormSubmissionEntry(tx, {
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
		if (
			!app ||
			app.deleted_at !== null ||
			app.project_id !== args.expectedProjectId
		) {
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
		await lockFormSubmissionEntry(tx, {
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
 * Establish the DB half of pre-acceptance durability before any GCS copy.
 *
 * The current app/Project edit authority is re-proved in this transaction,
 * after the route's earlier admission check and before any row can enter
 * `preparing`. The entry advisory lock then serializes this transition with
 * Clear, retarget, and the terminal submission transaction. Once a row is
 * `preparing`, every deterministic final-key copy has a durable recovery
 * record before it can exist. A request crash can therefore be resumed by
 * scheduled maintenance; no copied object is ever orphaned merely because its
 * request disappeared.
 */
export async function beginFormAttachmentPreparation(args: {
	appId: string;
	projectId: string;
	actorUserId: string;
	entryKey: string;
	formUuid: Uuid;
	requestDigest: string;
	attachments: ReadonlyArray<{
		attachmentName: string;
		fieldUuid: Uuid;
		instancePath: string;
	}>;
}): Promise<
	| { readonly kind: "replay" }
	| { readonly kind: "prepare"; readonly attachmentIds: readonly string[] }
> {
	return withAppTx(async (tx) => {
		// Keep the repo-wide writer lock order: app row, Project-membership
		// gate/row, then the entry advisory lock and attachment rows.
		const app = await tx
			.selectFrom("apps")
			.select(["project_id", "deleted_at"])
			.where("id", "=", args.appId)
			.forShare()
			.executeTakeFirst();
		if (!app || app.deleted_at !== null || app.project_id !== args.projectId) {
			throw new FormAttachmentWriteRejectedError("App not found.");
		}
		const role = await projectRoleForInTransaction(
			tx,
			args.actorUserId,
			args.projectId,
		);
		if (role === null || !roleAllowsApp(role, "edit")) {
			throw new FormAttachmentWriteRejectedError("App not found.");
		}
		await lockFormSubmissionEntry(tx, {
			appId: args.appId,
			actorUserId: args.actorUserId,
			entryKey: args.entryKey,
		});
		const prior = await tx
			.selectFrom("form_submission_intents")
			.select(["form_uuid", "request_digest", "result"])
			.where("app_id", "=", args.appId)
			.where("project_id", "=", args.projectId)
			.where("created_by", "=", args.actorUserId)
			.where("entry_key", "=", args.entryKey)
			.forUpdate()
			.executeTakeFirst();
		if (prior !== undefined) {
			if (
				prior.form_uuid !== args.formUuid ||
				prior.request_digest !== args.requestDigest
			) {
				throw new FormAttachmentWriteRejectedError(
					"This form entry was already submitted with different answers. Start a new form entry before submitting again.",
				);
			}
			if (prior.result === null) {
				throw new Error(
					"A committed form submission intent is missing its atomic result.",
				);
			}
			return { kind: "replay" };
		}

		const names = args.attachments.map(
			(attachment) => attachment.attachmentName,
		);
		if (new Set(names).size !== names.length) {
			throw new FormAttachmentWriteRejectedError(
				"A form submission cannot name the same attachment more than once.",
			);
		}
		const rows = await tx
			.selectFrom("form_attachments")
			.selectAll()
			.where("app_id", "=", args.appId)
			.where("project_id", "=", args.projectId)
			.where("created_by", "=", args.actorUserId)
			.where("entry_key", "=", args.entryKey)
			.forUpdate()
			.execute();
		const byName = new Map(rows.map((row) => [row.attachment_name, row]));
		const now = new Date();
		const selected = args.attachments.map((attachment) => {
			const row = byName.get(attachment.attachmentName);
			if (
				row === undefined ||
				!["staged", "preparing", "prepared"].includes(row.status) ||
				row.expires_at <= now ||
				row.field_uuid !== attachment.fieldUuid ||
				row.instance_path !== attachment.instancePath ||
				row.object_generation === null ||
				row.object_checksum === null
			) {
				throw new FormAttachmentWriteRejectedError(
					"An attachment named by this form is no longer ready for this entry. Attach it again.",
				);
			}
			return row;
		});
		const stagedIds = selected
			.filter((row) => row.status === "staged")
			.map((row) => row.attachment_id);
		const foregroundRetryIds = selected
			.filter(
				(row) =>
					row.status === "preparing" && row.last_preparation_error !== null,
			)
			.map((row) => row.attachment_id);
		const dueIds = [...stagedIds, ...foregroundRetryIds];
		if (dueIds.length > 0) {
			await tx
				.updateTable("form_attachments")
				.set({
					status: "preparing",
					next_preparation_at: now,
					last_preparation_error: null,
				})
				.where("attachment_id", "in", dueIds)
				// A user retry may bypass scheduled backoff only after a worker
				// recorded its failure. An active lease has no error and remains
				// fenced from concurrent foreground copies.
				.where((eb) =>
					eb.or([
						eb("status", "=", "staged"),
						eb.and([
							eb("status", "=", "preparing"),
							eb("last_preparation_error", "is not", null),
						]),
					]),
				)
				.execute();
		}
		return {
			kind: "prepare",
			attachmentIds: selected.map((row) => row.attachment_id),
		};
	});
}

/** Confirm every selected row is durably prepared (or already submitted). */
export async function formAttachmentsArePrepared(args: {
	appId: string;
	projectId: string;
	actorUserId: string;
	entryKey: string;
	attachmentIds: readonly string[];
}): Promise<boolean> {
	if (args.attachmentIds.length === 0) return true;
	const db = await getAppDb();
	const rows = await db
		.selectFrom("form_attachments")
		.select(["attachment_id", "status", "prepared_generation"])
		.where("app_id", "=", args.appId)
		.where("project_id", "=", args.projectId)
		.where("created_by", "=", args.actorUserId)
		.where("entry_key", "=", args.entryKey)
		.where("attachment_id", "in", args.attachmentIds)
		.execute();
	return (
		rows.length === args.attachmentIds.length &&
		rows.every(
			(row) =>
				(row.status === "prepared" && row.prepared_generation !== null) ||
				row.status === "submitted",
		)
	);
}

/**
 * Delete one not-yet-submitted attachment — the clear and replace path.
 *
 * Pending/staged rows may be deleted immediately because their source prefix
 * has a GCS lifecycle fallback. Preparing/prepared rows instead become
 * `discarding`: their deterministic final copy is outside that lifecycle,
 * so metadata must survive until exact source/destination cleanup completes.
 * A `submitted` row is never deletable here.
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
		if (
			!app ||
			app.deleted_at !== null ||
			app.project_id !== args.expectedProjectId
		) {
			return null;
		}
		const role = await projectRoleForInTransaction(
			tx,
			args.actorUserId,
			args.expectedProjectId,
		);
		if (role === null || !roleAllowsApp(role, "edit")) return null;
		await lockFormSubmissionEntry(tx, {
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
		if (row === undefined || row.status === "submitted") return null;
		if (row.status === "pending" || row.status === "staged") {
			const deleted = await tx
				.deleteFrom("form_attachments")
				.where("attachment_id", "=", args.attachmentId)
				.where("status", "=", row.status)
				.returningAll()
				.executeTakeFirst();
			return deleted === undefined ? null : recordFromRow(deleted);
		}
		if (row.status === "discarding") return recordFromRow(row);
		const discard = await tx
			.updateTable("form_attachments")
			.set({
				status: "discarding",
				// Preserve a live preparation lease. The copy call has a strict
				// request timeout shorter than that lease, so the original worker
				// gets first responsibility for deleting any generation it creates.
				next_preparation_at:
					row.status === "preparing"
						? row.next_preparation_at
						: sql<Date>`now()`,
				last_preparation_error: null,
			})
			.where("attachment_id", "=", args.attachmentId)
			.where("status", "=", row.status)
			.returningAll()
			.executeTakeFirst();
		return discard === undefined ? null : recordFromRow(discard);
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
		if (
			!app ||
			app.deleted_at !== null ||
			app.project_id !== args.expectedProjectId
		) {
			return null;
		}
		const role = await projectRoleForInTransaction(
			tx,
			args.actorUserId,
			args.expectedProjectId,
		);
		if (role === null || !roleAllowsApp(role, "edit")) return null;
		await lockFormSubmissionEntry(tx, {
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
			// The caller may have lost the response to an earlier successful
			// move. Return the locked row's authoritative coordinate so it can
			// advance its CAS and continue toward the newest desired path.
			return current;
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
				args.instancePath,
				committedPath.instancePathTemplate,
			) ||
			captureExtensionFor(field.kind, current.originalFilename) !==
				current.extension
		) {
			throw new FormAttachmentWriteRejectedError(
				"The capture question changed while its attachment moved. Attach the file again.",
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
 * Lease retryable preparation or discard rows.
 *
 * `SKIP LOCKED` lets overlapping maintenance jobs share work without copying
 * or deleting the same generation concurrently. A crashed worker's lease
 * expires; create-only copy plus exact destination verification makes replay
 * safe.
 */
export async function claimFormAttachmentPreparations(args?: {
	appId?: string;
	entryKey?: string;
	actorUserId?: string;
	expectedProjectId?: string;
	attachmentIds?: readonly string[];
	limit?: number;
}): Promise<readonly FormAttachmentRecord[]> {
	if (args?.attachmentIds?.length === 0) return [];
	return withAppTx(async (tx) => {
		const now = new Date();
		let query = tx
			.selectFrom("form_attachments")
			.select("attachment_id")
			.where("status", "in", ["preparing", "discarding"])
			.where("next_preparation_at", "<=", now)
			.orderBy("next_preparation_at")
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
		if (args?.attachmentIds !== undefined) {
			query = query.where("attachment_id", "in", args.attachmentIds);
		}
		const claimed = await query.execute();
		if (claimed.length === 0) return [];
		const rows = await tx
			.updateTable("form_attachments")
			.set((eb) => ({
				preparation_attempts: eb("preparation_attempts", "+", 1),
				next_preparation_at: new Date(now.getTime() + 5 * 60 * 1000),
			}))
			.where(
				"attachment_id",
				"in",
				claimed.map((row) => row.attachment_id),
			)
			.where("status", "in", ["preparing", "discarding"])
			.returningAll()
			.execute();
		return rows.map(recordFromRow);
	});
}

/**
 * Record the verified final generation without accepting the submission.
 *
 * Clear may win after the copy lease. In that serial order the row remains
 * `discarding`, but recording the generation gives the same worker and every
 * scheduled retry an exact deletion target.
 */
export type FormAttachmentPreparationCompletion =
	| {
			readonly kind: "prepared" | "discarding";
			readonly attachment: FormAttachmentRecord;
	  }
	| { readonly kind: "superseded" }
	| { readonly kind: "gone" };

export async function completeFormAttachmentPreparation(
	attachmentId: string,
	expectedPreparationAttempt: number,
	destinationGeneration: string,
): Promise<FormAttachmentPreparationCompletion> {
	return withAppTx(async (tx) => {
		const row = await tx
			.selectFrom("form_attachments")
			.selectAll()
			.where("attachment_id", "=", attachmentId)
			.forUpdate()
			.executeTakeFirst();
		if (row === undefined) return { kind: "gone" };
		if (
			row.preparation_attempts !== expectedPreparationAttempt ||
			(row.status !== "preparing" && row.status !== "discarding")
		) {
			return { kind: "superseded" };
		}
		const updated = await tx
			.updateTable("form_attachments")
			.set({
				status: row.status === "preparing" ? "prepared" : "discarding",
				prepared_generation: destinationGeneration,
				next_preparation_at:
					row.status === "preparing" ? null : sql<Date>`now()`,
				last_preparation_error: null,
			})
			.where("attachment_id", "=", attachmentId)
			.where("status", "=", row.status)
			.where("preparation_attempts", "=", expectedPreparationAttempt)
			.returningAll()
			.executeTakeFirst();
		if (updated === undefined) return { kind: "superseded" };
		const attachment = recordFromRow(updated);
		return {
			kind: attachment.status === "prepared" ? "prepared" : "discarding",
			attachment,
		};
	});
}

export type FormAttachmentDiscardLease =
	| { readonly kind: "leased"; readonly attachment: FormAttachmentRecord }
	| { readonly kind: "superseded" }
	| { readonly kind: "gone" };

/**
 * Re-prove the exact discard attempt immediately before deleting objects.
 *
 * A delete is irreversible and therefore cannot rely on the lease snapshot
 * returned minutes earlier. Extending the same attempt's lease under a row
 * lock prevents an expired duplicate from deleting for a newer attempt.
 */
export async function renewFormAttachmentDiscardLease(
	attachmentId: string,
	expectedPreparationAttempt: number,
): Promise<FormAttachmentDiscardLease> {
	return withAppTx(async (tx) => {
		const row = await tx
			.selectFrom("form_attachments")
			.selectAll()
			.where("attachment_id", "=", attachmentId)
			.forUpdate()
			.executeTakeFirst();
		if (row === undefined) return { kind: "gone" };
		if (
			row.status !== "discarding" ||
			row.preparation_attempts !== expectedPreparationAttempt
		) {
			return { kind: "superseded" };
		}
		const renewed = await tx
			.updateTable("form_attachments")
			.set({ next_preparation_at: sql<Date>`now() + interval '5 minutes'` })
			.where("attachment_id", "=", attachmentId)
			.where("status", "=", "discarding")
			.where("preparation_attempts", "=", expectedPreparationAttempt)
			.returningAll()
			.executeTakeFirst();
		return renewed === undefined
			? { kind: "superseded" }
			: { kind: "leased", attachment: recordFromRow(renewed) };
	});
}

export type FormAttachmentDiscardCompletion =
	| { readonly kind: "discarded" }
	| { readonly kind: "superseded" }
	| { readonly kind: "gone" };

/** Remove a discard row only after all of its exact objects are gone. */
export async function completeFormAttachmentDiscard(
	attachmentId: string,
	expectedPreparationAttempt: number,
	preparedGeneration: string | null,
): Promise<FormAttachmentDiscardCompletion> {
	return withAppTx(async (tx) => {
		const row = await tx
			.selectFrom("form_attachments")
			.select(["status", "preparation_attempts", "prepared_generation"])
			.where("attachment_id", "=", attachmentId)
			.forUpdate()
			.executeTakeFirst();
		if (row === undefined) return { kind: "gone" };
		if (
			row.status !== "discarding" ||
			row.preparation_attempts !== expectedPreparationAttempt ||
			row.prepared_generation !== preparedGeneration
		) {
			return { kind: "superseded" };
		}
		const deleted = await tx
			.deleteFrom("form_attachments")
			.where("attachment_id", "=", attachmentId)
			.where("status", "=", "discarding")
			.where("preparation_attempts", "=", expectedPreparationAttempt)
			.where(
				"prepared_generation",
				preparedGeneration === null ? "is" : "=",
				preparedGeneration,
			)
			.returning("attachment_id")
			.executeTakeFirst();
		return deleted === undefined
			? { kind: "superseded" }
			: { kind: "discarded" };
	});
}

export type FormAttachmentPreparationFailureResult =
	| { readonly kind: "recorded"; readonly attempts: number }
	| { readonly kind: "superseded" }
	| { readonly kind: "gone" };

/** Preserve the row and schedule another preparation/discard attempt. */
export async function recordFormAttachmentPreparationFailure(
	attachmentId: string,
	expectedPreparationAttempt: number,
	error: unknown,
): Promise<FormAttachmentPreparationFailureResult> {
	const message =
		error instanceof Error
			? error.message.slice(0, 2000)
			: String(error).slice(0, 2000);
	return withAppTx(async (tx) => {
		const updated = await tx
			.updateTable("form_attachments")
			.set({
				last_preparation_error: message,
				next_preparation_at: sql<Date>`now() + make_interval(
					secs => least(
						21600,
						60 * power(
							2,
							least(greatest(preparation_attempts - 1, 0), 8)
						)
					)::integer
				)`,
			})
			.where("attachment_id", "=", attachmentId)
			.where("preparation_attempts", "=", expectedPreparationAttempt)
			.where("status", "in", ["preparing", "discarding"])
			.returning("preparation_attempts")
			.executeTakeFirst();
		if (updated !== undefined) {
			return {
				kind: "recorded",
				attempts: updated.preparation_attempts,
			};
		}
		const exists = await tx
			.selectFrom("form_attachments")
			.select("attachment_id")
			.where("attachment_id", "=", attachmentId)
			.executeTakeFirst();
		return exists === undefined ? { kind: "gone" } : { kind: "superseded" };
	});
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
 * Retire a bounded batch of expired unsubmitted rows.
 *
 * Pending/staged rows are metadata-deleted immediately and hand their staging
 * object back to the caller; GCS lifecycle is the independent byte backstop.
 * Preparing/prepared rows instead become `discarding` because a deterministic
 * final-key copy may exist outside that lifecycle. The scheduled maintenance
 * worker deletes exact source/destination generations and only then removes
 * those rows. A live preparation lease is preserved so expiry cannot race an
 * in-flight copy and lose its cleanup record.
 */
export interface PurgedExpiredFormAttachments {
	/** Rows selected and transitioned/deleted in this bounded batch. */
	readonly processed: number;
	/** Recoverable durable rows moved to `discarding`. */
	readonly transitioned: number;
	/** Directly deleted pending/staged source objects for caller cleanup. */
	readonly objects: readonly {
		readonly objectKey: string;
		readonly objectGeneration: string | null;
	}[];
}

export async function purgeExpiredFormAttachments(
	limit = 200,
): Promise<PurgedExpiredFormAttachments> {
	return withAppTx(async (tx) => {
		const expired = await tx
			.selectFrom("form_attachments")
			.selectAll()
			// `discarding` is already owned by the retry queue. Including it
			// here would let a permanently failing early discard fill every
			// expiry batch and starve later pending/staged rows forever.
			.where("status", "in", ["pending", "staged", "preparing", "prepared"])
			.where("expires_at", "<", new Date())
			.orderBy("expires_at")
			.orderBy("attachment_id")
			.limit(Math.min(Math.max(limit, 1), 500))
			.forUpdate()
			.skipLocked()
			.execute();
		const directlyDeletable = expired.filter(
			(row) => row.status === "pending" || row.status === "staged",
		);
		const recoverable = expired.filter(
			(row) => row.status === "preparing" || row.status === "prepared",
		);
		const deleted =
			directlyDeletable.length === 0
				? []
				: await tx
						.deleteFrom("form_attachments")
						.where(
							"attachment_id",
							"in",
							directlyDeletable.map((row) => row.attachment_id),
						)
						.where("status", "in", ["pending", "staged"])
						.returning(["gcs_object_key", "object_generation"])
						.execute();
		for (const row of recoverable) {
			await tx
				.updateTable("form_attachments")
				.set({
					status: "discarding",
					next_preparation_at:
						row.status === "preparing"
							? row.next_preparation_at
							: sql<Date>`now()`,
					last_preparation_error: null,
				})
				.where("attachment_id", "=", row.attachment_id)
				.where("status", "=", row.status)
				.execute();
		}
		return {
			processed: expired.length,
			transitioned: recoverable.length,
			objects: deleted.map((row) => ({
				objectKey: row.gcs_object_key,
				objectGeneration: row.object_generation,
			})),
		};
	});
}
