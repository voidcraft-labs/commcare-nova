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
	renewFormAttachmentDiscardLease,
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
): Promise<"discarded" | "superseded"> {
	const lease = await renewFormAttachmentDiscardLease(
		candidate.attachmentId,
		candidate.preparationAttempts,
	);
	if (lease.kind === "superseded") return "superseded";
	const ownedCandidate = lease.kind === "leased" ? lease.attachment : candidate;
	let destinationGeneration = ownedCandidate.preparedGeneration;
	if (destinationGeneration === null) {
		const destination = await getStoredObjectMetadata(
			durableKey(ownedCandidate),
		);
		if (destination !== null) {
			if (!metadataMatches(ownedCandidate, destination)) {
				throw new Error(
					"A discard destination does not match its immutable staged attachment.",
				);
			}
			destinationGeneration = destination.generation;
		}
	}
	if (destinationGeneration !== null) {
		await deleteAssetGeneration(
			durableKey(ownedCandidate),
			destinationGeneration,
		);
	}
	if (ownedCandidate.objectGeneration !== null) {
		await deleteAssetGeneration(
			ownedCandidate.gcsObjectKey,
			ownedCandidate.objectGeneration,
		);
	}
	const completed = await completeFormAttachmentDiscard(
		ownedCandidate.attachmentId,
		ownedCandidate.preparationAttempts,
		ownedCandidate.preparedGeneration,
	);
	return completed.kind === "superseded" ? "superseded" : "discarded";
}

type CandidateOutcome = "prepared" | "discarded" | "failed" | "superseded";

async function processCandidate(
	candidate: FormAttachmentRecord,
): Promise<CandidateOutcome> {
	try {
		if (candidate.status === "discarding") {
			return await discardPreparedCandidate(candidate);
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
			candidate.preparationAttempts,
			copied.destinationGeneration,
		);
		if (completed.kind === "gone") {
			// A globally absent row is the one state that proves no newer
			// preparation/submission owner exists. Only that proof may delete
			// the deterministic generation this worker observed.
			await deleteAssetGeneration(
				durableKey(candidate),
				copied.destinationGeneration,
			);
			return "discarded";
		}
		if (completed.kind === "superseded") {
			// The destination is deterministic and therefore shared with the
			// newer attempt. A stale worker must never delete the winner's bytes.
			return "superseded";
		}
		if (completed.kind === "discarding") {
			return await discardPreparedCandidate(completed.attachment);
		}
		return "prepared";
	} catch (err) {
		const failure = await recordFormAttachmentPreparationFailure(
			candidate.attachmentId,
			candidate.preparationAttempts,
			err,
		).catch((recordError: unknown) => {
			log.error("[attachments] preparation retry could not be recorded", {
				err: recordError,
				attachmentId: candidate.attachmentId,
			});
			return { kind: "recorded" as const, attempts: 0 };
		});
		if (failure.kind !== "recorded") {
			log.warn("[attachments] stale preparation failure was not recorded", {
				attachmentId: candidate.attachmentId,
				status: candidate.status,
				preparationAttempt: candidate.preparationAttempts,
				outcome: failure.kind,
			});
			return "superseded";
		}
		const context = {
			err,
			attachmentId: candidate.attachmentId,
			attempts: failure.attempts,
			status: candidate.status,
		};
		if (failure.attempts >= 10) {
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
}): Promise<{
	prepared: number;
	discarded: number;
	failed: number;
	superseded: number;
}> {
	const claimScope = {
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
	};
	const requestedLimit = Math.min(Math.max(args?.limit ?? 100, 1), 500);
	const outcomes: CandidateOutcome[] = [];
	while (outcomes.length < requestedLimit) {
		const waveLimit = Math.min(
			PREPARATION_CONCURRENCY,
			requestedLimit - outcomes.length,
		);
		// Lease only work this wave can begin immediately. Holding dozens of
		// five-minute leases behind five workers is indistinguishable from a
		// crash to another scheduler execution.
		const candidates = await claimFormAttachmentPreparations({
			...claimScope,
			limit: waveLimit,
		});
		if (candidates.length === 0) break;
		outcomes.push(...(await Promise.all(candidates.map(processCandidate))));
		if (candidates.length < waveLimit) break;
	}
	return {
		prepared: outcomes.filter((outcome) => outcome === "prepared").length,
		discarded: outcomes.filter((outcome) => outcome === "discarded").length,
		failed: outcomes.filter((outcome) => outcome === "failed").length,
		superseded: outcomes.filter((outcome) => outcome === "superseded").length,
	};
}
