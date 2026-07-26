import "server-only";

import { captureObjectKeyFor } from "@/lib/domain/captureFormats";
import { log } from "@/lib/logger";
import {
	copyAssetObjectIfAbsent,
	deleteAssetGeneration,
	getStoredObjectMetadata,
} from "@/lib/storage/media";
import {
	claimFormAttachmentPreparations,
	completeFormAttachmentDiscard,
	completeFormAttachmentPreparation,
	type FormAttachmentRecord,
	recordFormAttachmentPreparationFailure,
} from "./formAttachments";

const PREPARATION_CONCURRENCY = 5;

function durableKey(candidate: FormAttachmentRecord): string {
	return captureObjectKeyFor(
		candidate.projectId,
		candidate.attachmentId,
		candidate.extension,
	);
}

function metadataMatches(
	candidate: FormAttachmentRecord,
	metadata: {
		size: number;
		checksum: string;
		contentType: string;
	},
): boolean {
	return (
		metadata.size === candidate.sizeBytes &&
		metadata.checksum === candidate.objectChecksum &&
		metadata.contentType === candidate.contentType
	);
}

/**
 * Delete both possible object generations, then remove the discard row.
 *
 * A `discarding` row whose preparation worker crashed before recording the
 * final generation still has a deterministic destination. Metadata lookup
 * verifies the exact size/checksum/content type before deletion; a mismatch
 * fails closed and retains the row for investigation/retry.
 */
async function discardPreparedCandidate(
	candidate: FormAttachmentRecord,
): Promise<void> {
	let destinationGeneration = candidate.preparedGeneration;
	if (destinationGeneration === null) {
		const destination = await getStoredObjectMetadata(durableKey(candidate));
		if (destination !== null) {
			if (!metadataMatches(candidate, destination)) {
				throw new Error(
					"A discard destination does not match its immutable staged attachment.",
				);
			}
			destinationGeneration = destination.generation;
		}
	}
	if (destinationGeneration !== null) {
		await deleteAssetGeneration(durableKey(candidate), destinationGeneration);
	}
	if (candidate.objectGeneration !== null) {
		await deleteAssetGeneration(
			candidate.gcsObjectKey,
			candidate.objectGeneration,
		);
	}
	const completed = await completeFormAttachmentDiscard(
		candidate.attachmentId,
		candidate.preparedGeneration,
	);
	if (!completed) {
		throw new Error(
			"A discarded attachment changed after its exact objects were removed.",
		);
	}
}

type CandidateOutcome = "prepared" | "discarded" | "failed";

async function processCandidate(
	candidate: FormAttachmentRecord,
): Promise<CandidateOutcome> {
	try {
		if (candidate.status === "discarding") {
			await discardPreparedCandidate(candidate);
			return "discarded";
		}
		if (
			candidate.status !== "preparing" ||
			candidate.objectGeneration === null ||
			candidate.objectChecksum === null
		) {
			throw new Error(
				"A preparing attachment is missing immutable source identity.",
			);
		}
		const copied = await copyAssetObjectIfAbsent({
			sourceGcsObjectKey: candidate.gcsObjectKey,
			sourceGeneration: candidate.objectGeneration,
			destinationGcsObjectKey: durableKey(candidate),
			expectedSize: candidate.sizeBytes,
			expectedChecksum: candidate.objectChecksum,
			expectedContentType: candidate.contentType,
		});
		const completed = await completeFormAttachmentPreparation(
			candidate.attachmentId,
			copied.destinationGeneration,
		);
		if (completed === null) {
			// Ordinary Clear/expiry never removes a preparing row; this is a
			// defensive whole-tenant-deletion boundary. Do not leave the exact
			// generation created by this worker behind.
			await deleteAssetGeneration(
				durableKey(candidate),
				copied.destinationGeneration,
			);
			return "discarded";
		}
		if (completed.status === "discarding") {
			await discardPreparedCandidate(completed);
			return "discarded";
		}
		return "prepared";
	} catch (err) {
		const attempts = await recordFormAttachmentPreparationFailure(
			candidate.attachmentId,
			err,
		).catch((recordError: unknown) => {
			log.error("[attachments] preparation retry could not be recorded", {
				err: recordError,
				attachmentId: candidate.attachmentId,
			});
			return 0;
		});
		const context = {
			err,
			attachmentId: candidate.attachmentId,
			attempts,
			status: candidate.status,
		};
		if (attempts >= 10) {
			log.critical(
				"[attachments] durable preparation repeatedly failed",
				context,
			);
		} else {
			log.error(
				"[attachments] durable preparation failed and will retry",
				context,
			);
		}
		return "failed";
	}
}

/**
 * Process one bounded leased batch of pre-acceptance preparation/discard work.
 *
 * The request path scopes this to the exact selected attachment ids. The
 * scheduled maintenance path omits those filters and drains every due row.
 * Five workers cap GCS fan-out while avoiding a 50-attachment submission
 * paying one copy deadline serially.
 */
export async function preparePendingFormAttachments(args?: {
	appId?: string;
	entryKey?: string;
	actorUserId?: string;
	projectId?: string;
	attachmentIds?: readonly string[];
	limit?: number;
}): Promise<{ prepared: number; discarded: number; failed: number }> {
	const candidates = await claimFormAttachmentPreparations({
		...(args?.appId === undefined ? {} : { appId: args.appId }),
		...(args?.entryKey === undefined ? {} : { entryKey: args.entryKey }),
		...(args?.actorUserId === undefined
			? {}
			: { actorUserId: args.actorUserId }),
		...(args?.projectId === undefined
			? {}
			: { expectedProjectId: args.projectId }),
		...(args?.attachmentIds === undefined
			? {}
			: { attachmentIds: args.attachmentIds }),
		...(args?.limit === undefined ? {} : { limit: args.limit }),
	});
	const outcomes: CandidateOutcome[] = [];
	let cursor = 0;
	const workers = Array.from(
		{ length: Math.min(PREPARATION_CONCURRENCY, candidates.length) },
		async () => {
			while (cursor < candidates.length) {
				const candidate = candidates[cursor];
				cursor += 1;
				if (candidate !== undefined) {
					outcomes.push(await processCandidate(candidate));
				}
			}
		},
	);
	await Promise.all(workers);
	return {
		prepared: outcomes.filter((outcome) => outcome === "prepared").length,
		discarded: outcomes.filter((outcome) => outcome === "discarded").length,
		failed: outcomes.filter((outcome) => outcome === "failed").length,
	};
}
