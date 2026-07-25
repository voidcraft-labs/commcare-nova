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
// the writes. Submit-time reconciliation deletes the staged rows a
// submission did NOT name, and `entry_key` is a client-minted value.
// Without the `created_by` filter a co-member in a shared Project could
// delete another member's in-flight captures by sending their entry key —
// reachable in a shared Project, not theoretical.
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
import type { Selectable, Transaction } from "kysely";
import { roleAllowsApp } from "@/lib/auth/projectRoles";
import {
	captureAttachmentName,
	captureObjectKeyFor,
	stagedCaptureObjectKeyFor,
} from "@/lib/domain/captureFormats";
import type { AppDatabase, FormAttachmentsTable } from "./pg";
import { getAppDb, withAppTx } from "./pg";
import { projectRoleForInTransaction } from "./projectMembership";

/** Lifecycle of one staged capture. */
export type FormAttachmentStatus = "pending" | "staged" | "submitted";

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
	const db = await getAppDb();
	await db
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
			status: "pending",
		})
		.execute();
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
			.where("project_id", "=", args.expectedProjectId)
			.where("created_by", "=", args.actorUserId)
			.executeTakeFirst();
		return row === undefined ? null : recordFromRow(row);
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
	expectedProjectId: string;
	sizeBytes: number;
}): Promise<ConfirmFormAttachmentResult> {
	return withAppTx(async (tx) => {
		const role = await projectRoleForInTransaction(
			tx,
			args.actorUserId,
			args.expectedProjectId,
		);
		if (role === null || !roleAllowsApp(role, "edit")) {
			return { kind: "not_found" };
		}
		const row = await tx
			.selectFrom("form_attachments")
			.selectAll()
			.where("attachment_id", "=", args.attachmentId)
			.where("project_id", "=", args.expectedProjectId)
			.where("created_by", "=", args.actorUserId)
			.forUpdate()
			.executeTakeFirst();
		if (row === undefined) return { kind: "not_found" };
		const current = recordFromRow(row);
		if (current.status === "staged") {
			return { kind: "already_staged", attachment: current };
		}
		if (current.status !== "pending") return { kind: "not_found" };
		const staged = await tx
			.updateTable("form_attachments")
			.set({ status: "staged", size_bytes: args.sizeBytes })
			.where("attachment_id", "=", args.attachmentId)
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
 * Scoped to the acting member's own rows for the same reason
 * reconciliation is.
 */
export async function deleteUnsubmittedFormAttachment(args: {
	attachmentId: string;
	actorUserId: string;
	expectedProjectId: string;
}): Promise<FormAttachmentRecord | null> {
	return withAppTx(async (tx) => {
		const role = await projectRoleForInTransaction(
			tx,
			args.actorUserId,
			args.expectedProjectId,
		);
		if (role === null || !roleAllowsApp(role, "edit")) return null;
		const deleted = await tx
			.deleteFrom("form_attachments")
			.where("attachment_id", "=", args.attachmentId)
			.where("project_id", "=", args.expectedProjectId)
			.where("created_by", "=", args.actorUserId)
			.where("status", "!=", "submitted")
			.returningAll()
			.executeTakeFirst();
		return deleted === undefined ? null : recordFromRow(deleted);
	});
}

export interface ReconcileFormAttachmentsResult {
	/** Rows promoted to `submitted`, in no particular order. */
	readonly promoted: readonly FormAttachmentRecord[];
	/** Rows deleted because the submission did not name them. */
	readonly discarded: readonly FormAttachmentRecord[];
}

/**
 * Settle one form entry's attachments against the names its submission
 * actually carried.
 *
 * This is the whole compensation story, and it lives here rather than in
 * a hook on the preview engine for a reason worth stating: the engine
 * fires nothing on a value change or a repeat removal, and adding
 * notification points to `setValueAt` / `removeRepeat` / `reset` /
 * `deactivate` would be four places to forget. Reconciling once, against
 * the submitted answer set, cannot be forgotten — and it preserves the
 * platform's retention semantics, where a question that goes irrelevant
 * KEEPS its value (`FormSession::serialize` serializes with
 * respect-relevance off) rather than losing it the moment a condition
 * flips.
 *
 * It deliberately diverges from CommCare in one direction. The real
 * runtime enumerates the session's media DIRECTORY, not the answers
 * (`FormSubmissionHelper::getMultiPartFormBody`), so a capture the worker
 * deleted — or one stranded by a deleted repeat instance — still uploads,
 * still consumes one of the 50 attachment slots, and lands in HQ
 * referenced by nothing. Nova promotes only what the submission named.
 * That is not Nova being clever: replicating the orphan upload would ship
 * a known platform defect into a lane that has no reason to inherit it.
 *
 * `keptNames` is treated as a filter over the caller's own rows, never as
 * authority: a name that does not belong to this entry, member, and
 * Project simply does not match, so a forged list can neither promote nor
 * preserve someone else's attachment.
 *
 * It carries the names whose bytes the caller has ALREADY copied to their
 * durable key — not merely the names the submission mentioned. That is
 * what lets the promotion below name the durable key inside this
 * transaction: a name only reaches here once its object exists, so a
 * failed copy resolves as "not promoted" rather than as a submitted row
 * pointing at a key nothing ever wrote.
 */
export async function reconcileFormAttachments(args: {
	appId: string;
	entryKey: string;
	actorUserId: string;
	expectedProjectId: string;
	keptNames: readonly string[];
	tx?: Transaction<AppDatabase>;
}): Promise<ReconcileFormAttachmentsResult> {
	const run = async (
		tx: Transaction<AppDatabase>,
	): Promise<ReconcileFormAttachmentsResult> => {
		const role = await projectRoleForInTransaction(
			tx,
			args.actorUserId,
			args.expectedProjectId,
		);
		if (role === null || !roleAllowsApp(role, "edit")) {
			return { promoted: [], discarded: [] };
		}
		const rows = await tx
			.selectFrom("form_attachments")
			.selectAll()
			.where("app_id", "=", args.appId)
			.where("entry_key", "=", args.entryKey)
			.where("created_by", "=", args.actorUserId)
			.where("project_id", "=", args.expectedProjectId)
			.where("status", "!=", "submitted")
			.forUpdate()
			.execute();
		const kept = new Set(args.keptNames);
		const promoted: FormAttachmentRecord[] = [];
		const discarded: FormAttachmentRecord[] = [];
		for (const row of rows) {
			const record = recordFromRow(row);
			// A `pending` row is discarded even when named: its bytes were
			// never confirmed to exist, so promoting it would mint an answer
			// pointing at nothing.
			if (kept.has(record.attachmentName) && record.status === "staged") {
				promoted.push(record);
			} else {
				discarded.push(record);
			}
		}
		for (const record of promoted) {
			// Safe to name the durable key here because the caller has already
			// copied the bytes to it — that ordering is the contract, and it
			// is why `keptNames` carries only what was successfully copied. A
			// row therefore never names an object that does not exist.
			await tx
				.updateTable("form_attachments")
				.set({
					status: "submitted",
					submitted_at: new Date(),
					gcs_object_key: captureObjectKeyFor(
						record.projectId,
						record.attachmentId,
						record.extension,
					),
				})
				.where("attachment_id", "=", record.attachmentId)
				.execute();
		}
		if (discarded.length > 0) {
			await tx
				.deleteFrom("form_attachments")
				.where(
					"attachment_id",
					"in",
					discarded.map((r) => r.attachmentId),
				)
				.execute();
		}
		return { promoted, discarded };
	};
	return args.tx ? run(args.tx) : withAppTx(run);
}

/**
 * The not-yet-submitted attachments a settlement would consider, without
 * changing anything.
 *
 * Settlement copies bytes to their durable key BEFORE promoting the row,
 * so it needs to know what it is about to copy. Read-only and unlocked on
 * purpose: `reconcileFormAttachments` re-reads the same rows `FOR UPDATE`
 * and re-filters by name and status, so anything that changed in between
 * simply is not promoted. This read can be stale; it cannot be wrong.
 */
export async function listSettlementCandidates(args: {
	appId: string;
	entryKey: string;
	actorUserId: string;
	expectedProjectId: string;
}): Promise<readonly FormAttachmentRecord[]> {
	const db = await getAppDb();
	const rows = await db
		.selectFrom("form_attachments")
		.selectAll()
		.where("app_id", "=", args.appId)
		.where("entry_key", "=", args.entryKey)
		.where("created_by", "=", args.actorUserId)
		.where("project_id", "=", args.expectedProjectId)
		.where("status", "=", "staged")
		.execute();
	return rows.map(recordFromRow);
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
 * Called opportunistically and failure-swallowed by the initiate route,
 * the same shape as `purgeExpiredMediaUploadAliases`. There is no cron in
 * this repo to hang it on.
 */
export async function purgeExpiredFormAttachments(
	limit = 200,
): Promise<readonly string[]> {
	const db = await getAppDb();
	const deleted = await db
		.deleteFrom("form_attachments")
		.where("status", "!=", "submitted")
		.where((eb) =>
			eb(
				"attachment_id",
				"in",
				eb
					.selectFrom("form_attachments")
					.select("attachment_id")
					.where("status", "!=", "submitted")
					.where("expires_at", "<", new Date())
					.limit(limit),
			),
		)
		.returning("gcs_object_key")
		.execute();
	return deleted.map((r) => r.gcs_object_key);
}
