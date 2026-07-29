/**
 * POST   /api/apps/[id]/attachments/[attachmentId] — confirm the upload
 * PATCH  /api/apps/[id]/attachments/[attachmentId] — repeat-path compaction
 * DELETE /api/apps/[id]/attachments/[attachmentId] — clear / replace
 *
 * POST is confirm; there is no other write this resource takes.
 *
 * Confirm is what makes an attachment referenceable. Until it commits the
 * row is `pending` and its object may never have been PUT, so a form
 * answer naming it could reach submission with no bytes behind it. The
 * client therefore sets the answer only after this returns.
 *
 * Delete is the clear-and-replace path. It is the one place Nova's lane
 * deliberately behaves BETTER than the runtime it mirrors: on a real
 * device, clearing a required capture deletes the bytes and leaves the
 * answer naming them (`FormController::saveAnswer` runs
 * `cleanCurrentMedia` before `FormEntryController::answerQuestion`
 * returns `ANSWER_REQUIRED_BUT_EMPTY` without committing). Here the
 * client clears its answer first and calls this second, so a failed
 * delete leaves a staged orphan — which the scheduled sweep and bucket TTL
 * reap — rather than a live answer pointing at nothing.
 */

import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { ApiError, handleApiError, readJsonBody } from "@/lib/apiError";
import { requireSession } from "@/lib/auth-utils";
import { resolveAppScope } from "@/lib/db/appAccess";
import {
	confirmFormAttachment,
	deleteUnsubmittedFormAttachment,
	FormAttachmentWriteRejectedError,
	loadFormAttachmentForEdit,
	retargetStagedFormAttachment,
} from "@/lib/db/formAttachments";
import { MAX_CAPTURE_BYTES } from "@/lib/domain/captureFormats";
import { log } from "@/lib/logger";
import {
	deleteAsset,
	deleteAssetGeneration,
	getStoredObjectMetadata,
} from "@/lib/storage/media";

const retargetBodySchema = z
	.object({
		expectedInstancePath: z.string().min(1).max(1024),
		instancePath: z.string().min(1).max(1024),
	})
	.strict();

const RETARGET_METADATA_MAX_BYTES = 3 * 1024;

export async function POST(
	req: NextRequest,
	{ params }: { params: Promise<{ id: string; attachmentId: string }> },
): Promise<NextResponse> {
	try {
		const { id: appId, attachmentId } = await params;
		const session = await requireSession(req);
		const { projectId } = await resolveAppScope(appId, session.user.id, "edit");

		// Read, then measure, then flip — in that order. The row's own key is
		// the authority on where the bytes went, never a client-supplied
		// path; and measuring first is what lets the flip record the REAL
		// size in one write. Flipping first and correcting after would either
		// hold the transaction open across a GCS round trip or leave a
		// placeholder that the idempotent retry path declines to overwrite.
		const existing = await loadFormAttachmentForEdit({
			attachmentId,
			actorUserId: session.user.id,
			expectedAppId: appId,
			expectedProjectId: projectId,
		});
		if (existing === null) throw new ApiError("Attachment not found", 404);

		const stored = await getStoredObjectMetadata(existing.gcsObjectKey);
		if (stored === null) {
			throw new ApiError(
				"The file didn't finish uploading. Attach it again.",
				409,
			);
		}
		if (
			stored.size > MAX_CAPTURE_BYTES ||
			stored.size !== existing.sizeBytes ||
			stored.contentType !== existing.contentType
		) {
			// Unreachable through the signed URL's byte-range binding, which
			// GCS enforces at the storage boundary. Kept as a fail-closed
			// backstop rather than an assumption.
			await deleteAssetGeneration(
				existing.gcsObjectKey,
				stored.generation,
			).catch((err: unknown) => {
				log.warn("[attachments] mismatched upload cleanup failed", { err });
			});
			throw new ApiError(
				"The uploaded file does not match the file selected by the form. Attach it again.",
				400,
			);
		}

		const confirmed = await confirmFormAttachment({
			attachmentId,
			actorUserId: session.user.id,
			expectedAppId: appId,
			expectedProjectId: projectId,
			sizeBytes: stored.size,
			objectGeneration: stored.generation,
			objectChecksum: stored.checksum,
		});
		if (confirmed.kind === "not_found") {
			throw new ApiError("Attachment not found", 404);
		}

		return NextResponse.json({
			ok: true,
			attachmentId: confirmed.attachment.attachmentId,
			attachmentName: confirmed.attachment.attachmentName,
			originalFilename: confirmed.attachment.originalFilename,
			sizeBytes: stored.size,
		});
	} catch (err) {
		if (err instanceof FormAttachmentWriteRejectedError) {
			return handleApiError(new ApiError(err.message, 409));
		}
		return handleApiError(
			err instanceof Error
				? err
				: new ApiError("Attachment request failed", 500),
		);
	}
}

export async function PATCH(
	req: NextRequest,
	{ params }: { params: Promise<{ id: string; attachmentId: string }> },
): Promise<NextResponse> {
	try {
		const { id: appId, attachmentId } = await params;
		const session = await requireSession(req);
		const { projectId } = await resolveAppScope(appId, session.user.id, "edit");
		const body = await readJsonBody(req, RETARGET_METADATA_MAX_BYTES);
		if (body === null) throw new ApiError("Invalid JSON body", 400);
		const parsed = retargetBodySchema.safeParse(body);
		if (!parsed.success) {
			throw new ApiError("Invalid attachment path request", 400);
		}
		const moved = await retargetStagedFormAttachment({
			attachmentId,
			actorUserId: session.user.id,
			expectedAppId: appId,
			expectedProjectId: projectId,
			expectedInstancePath: parsed.data.expectedInstancePath,
			instancePath: parsed.data.instancePath,
		});
		if (moved === null) throw new ApiError("Attachment not found", 404);
		return NextResponse.json({
			ok: true,
			instancePath: moved.instancePath,
		});
	} catch (err) {
		if (err instanceof FormAttachmentWriteRejectedError) {
			return handleApiError(new ApiError(err.message, 409));
		}
		return handleApiError(
			err instanceof Error
				? err
				: new ApiError("Attachment request failed", 500),
		);
	}
}

export async function DELETE(
	req: NextRequest,
	{ params }: { params: Promise<{ id: string; attachmentId: string }> },
): Promise<NextResponse> {
	try {
		const { id: appId, attachmentId } = await params;
		const session = await requireSession(req);
		const { projectId } = await resolveAppScope(appId, session.user.id, "edit");
		const deleted = await deleteUnsubmittedFormAttachment({
			attachmentId,
			actorUserId: session.user.id,
			expectedAppId: appId,
			expectedProjectId: projectId,
		});
		if (deleted === null) {
			// Already gone, submitted, foreign-app, or another member's — one
			// not-found shape for all four, so a caller cannot probe which.
			throw new ApiError("Attachment not found", 404);
		}
		if (deleted.status !== "discarding") {
			// Pending/staged metadata first, bytes second: an orphaned source
			// remains covered by the staging lifecycle. Preparing/prepared rows
			// instead stay `discarding`; scheduled maintenance owns exact
			// source+final cleanup before it metadata-deletes them.
			const cleanup =
				deleted.objectGeneration === null
					? deleteAsset(deleted.gcsObjectKey)
					: deleteAssetGeneration(
							deleted.gcsObjectKey,
							deleted.objectGeneration,
						);
			await cleanup.catch((err: unknown) => {
				log.warn("[attachments] object cleanup failed", {
					err,
					attachmentId,
				});
			});
		}
		return NextResponse.json({ ok: true });
	} catch (err) {
		return handleApiError(
			err instanceof Error
				? err
				: new ApiError("Attachment request failed", 500),
		);
	}
}
