import "server-only";

import { captureObjectKeyFor } from "@/lib/domain/captureFormats";
import { log } from "@/lib/logger";
import {
	copyAssetObjectIfAbsent,
	deleteAssetGeneration,
} from "@/lib/storage/media";
import {
	claimFormAttachmentPromotions,
	completeFormAttachmentPromotion,
	recordFormAttachmentPromotionFailure,
} from "./formAttachments";

/** Process one bounded leased batch of durable capture promotions. */
export async function promotePendingFormAttachments(args?: {
	appId?: string;
	entryKey?: string;
	actorUserId?: string;
	projectId?: string;
	limit?: number;
}): Promise<{ promoted: number; failed: number }> {
	const candidates = await claimFormAttachmentPromotions({
		...(args?.appId === undefined ? {} : { appId: args.appId }),
		...(args?.entryKey === undefined ? {} : { entryKey: args.entryKey }),
		...(args?.actorUserId === undefined
			? {}
			: { actorUserId: args.actorUserId }),
		...(args?.projectId === undefined
			? {}
			: { expectedProjectId: args.projectId }),
		...(args?.limit === undefined ? {} : { limit: args.limit }),
	});
	let promoted = 0;
	let failed = 0;
	for (const candidate of candidates) {
		try {
			if (
				candidate.objectGeneration === null ||
				candidate.objectChecksum === null
			) {
				throw new Error(
					"A promotion-pending attachment is missing immutable source identity.",
				);
			}
			const durable = captureObjectKeyFor(
				candidate.projectId,
				candidate.attachmentId,
				candidate.extension,
			);
			const copied = await copyAssetObjectIfAbsent({
				sourceGcsObjectKey: candidate.gcsObjectKey,
				sourceGeneration: candidate.objectGeneration,
				destinationGcsObjectKey: durable,
				expectedSize: candidate.sizeBytes,
				expectedChecksum: candidate.objectChecksum,
				expectedContentType: candidate.contentType,
			});
			const completed = await completeFormAttachmentPromotion(
				candidate.attachmentId,
				copied.destinationGeneration,
			);
			if (completed === null) continue;
			promoted++;
			await deleteAssetGeneration(
				candidate.gcsObjectKey,
				candidate.objectGeneration,
			).catch((err: unknown) => {
				log.warn("[attachments] exact staging-generation cleanup failed", {
					err,
					attachmentId: candidate.attachmentId,
				});
			});
		} catch (err) {
			failed++;
			const attempts = await recordFormAttachmentPromotionFailure(
				candidate.attachmentId,
				err,
			).catch((recordError: unknown) => {
				log.error("[attachments] promotion retry could not be recorded", {
					err: recordError,
					attachmentId: candidate.attachmentId,
				});
				return 0;
			});
			const context = {
				err,
				attachmentId: candidate.attachmentId,
				attempts,
			};
			if (attempts >= 10) {
				log.critical(
					"[attachments] durable promotion repeatedly failed",
					context,
				);
			} else {
				log.error("[attachments] durable promotion failed and will retry", {
					...context,
				});
			}
		}
	}
	return { promoted, failed };
}
