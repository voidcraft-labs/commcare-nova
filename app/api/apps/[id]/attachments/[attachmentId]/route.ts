/**
 * POST   /api/apps/[id]/attachments/[attachmentId] — confirm the upload
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
 * delete leaves a staged orphan — which reconciliation discards and the
 * bucket TTL reaps — rather than a live answer pointing at nothing.
 */

import { type NextRequest, NextResponse } from "next/server";
import { ApiError, handleApiError } from "@/lib/apiError";
import { requireSession } from "@/lib/auth-utils";
import { resolveAppScope } from "@/lib/db/appAccess";
import {
	confirmFormAttachment,
	deleteUnsubmittedFormAttachment,
	loadFormAttachmentForEdit,
} from "@/lib/db/formAttachments";
import { MAX_CAPTURE_BYTES } from "@/lib/domain/captureFormats";
import { log } from "@/lib/logger";
import { deleteAsset, getStoredObjectSize } from "@/lib/storage/media";

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
			expectedProjectId: projectId,
		});
		if (existing === null) throw new ApiError("Attachment not found", 404);

		const stored = await getStoredObjectSize(existing.gcsObjectKey);
		if (stored === null) {
			throw new ApiError(
				"The file didn't finish uploading. Attach it again.",
				409,
			);
		}
		if (stored > MAX_CAPTURE_BYTES) {
			// Unreachable through the signed URL's byte-range binding, which
			// GCS enforces at the storage boundary. Kept as a fail-closed
			// backstop rather than an assumption.
			await deleteAsset(existing.gcsObjectKey).catch((err: unknown) => {
				log.warn("[attachments] oversize cleanup failed", { err });
			});
			throw new ApiError("That file is larger than the 4 MB limit.", 400);
		}

		const confirmed = await confirmFormAttachment({
			attachmentId,
			actorUserId: session.user.id,
			expectedProjectId: projectId,
			sizeBytes: stored,
		});
		if (confirmed.kind === "not_found") {
			throw new ApiError("Attachment not found", 404);
		}

		return NextResponse.json({
			ok: true,
			attachmentId: confirmed.attachment.attachmentId,
			attachmentName: confirmed.attachment.attachmentName,
			originalFilename: confirmed.attachment.originalFilename,
			sizeBytes: stored,
		});
	} catch (err) {
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
			expectedProjectId: projectId,
		});
		if (deleted === null) {
			// Already gone, submitted, or another member's — one shape for all
			// three, so a caller cannot probe which.
			return NextResponse.json({ ok: true });
		}
		// Metadata first, bytes second: an orphaned object is reaped by the
		// staging TTL, while an orphaned ROW would describe bytes that exist
		// with nothing able to reach them.
		await deleteAsset(deleted.gcsObjectKey).catch((err: unknown) => {
			log.warn("[attachments] object cleanup failed", {
				err,
				attachmentId,
			});
		});
		return NextResponse.json({ ok: true });
	} catch (err) {
		return handleApiError(
			err instanceof Error
				? err
				: new ApiError("Attachment request failed", 500),
		);
	}
}
