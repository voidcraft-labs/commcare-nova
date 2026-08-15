/**
 * Point-in-time package re-render for `requestReview`.
 *
 * The store requires a review to bind the exact package digest the reviewed
 * draft bound (`artifactStore.insertDesignReview`), and the loop moves the
 * digest on every answered question round and every new message: so a
 * draft persisted two rounds ago cannot be reviewed under TODAY's package.
 * Its own package is re-rendered instead: the persisted reference row names
 * exactly the messages, extracts, images, and claims it held, so the
 * rebuild runs the standard builder over the thread PREFIX those references
 * close over, seeds the persisted claims verbatim, and proves byte identity
 * by recomputing the digest. A mismatch (an attachment re-extracted or
 * deleted underneath the draft) returns null: the caller refuses honestly
 * rather than reviewing under sources the author never saw.
 */

import { readDesignSourcePackage } from "@/lib/agent/design/artifactStore";
import {
	type BuildSourcePackageArgs,
	buildDesignSourcePackage,
	type DesignSourcePackage,
	SourcePackageError,
} from "@/lib/agent/design/sourcePackage";
import { log } from "@/lib/logger";

export async function rebuildPackageForDigest(args: {
	designSessionId: string;
	projectId: string;
	threadId: string;
	digest: string;
	messages: BuildSourcePackageArgs["messages"];
	deps: BuildSourcePackageArgs["deps"];
}): Promise<DesignSourcePackage | null> {
	const persisted = await readDesignSourcePackage(
		args.designSessionId,
		args.digest,
	);
	if (persisted === null) return null;

	const referencedMessageIds = new Set<string>();
	const referencedAssetIds = new Set<string>();
	for (const ref of persisted.payload.sources) {
		if (ref.kind === "message") referencedMessageIds.add(ref.messageId);
		if (ref.kind === "attachment-extract" || ref.kind === "image") {
			referencedAssetIds.add(ref.assetId as string);
		}
	}

	/* The prefix boundary: the last message that contributed anything to the
	 * persisted package: a text block (its id is a message ref) or an
	 * attachment (an asset the package projected). Everything after it
	 * arrived later and is exactly what the rebuild must exclude. */
	let boundary = -1;
	args.messages.forEach((message, index) => {
		if (referencedMessageIds.has(message.id)) {
			boundary = index;
			return;
		}
		if (message.role !== "user") return;
		const attachments = (
			message.metadata as
				| { attachments?: Array<{ assetId?: unknown }> }
				| undefined
		)?.attachments;
		if (
			Array.isArray(attachments) &&
			attachments.some(
				(ref) =>
					typeof ref?.assetId === "string" &&
					referencedAssetIds.has(ref.assetId),
			)
		) {
			boundary = index;
		}
	});
	if (boundary < 0) return null;

	try {
		const rebuilt = await buildDesignSourcePackage({
			designSessionId: args.designSessionId,
			projectId: args.projectId,
			threadId: args.threadId,
			messages: args.messages.slice(0, boundary + 1),
			claims: persisted.payload.claims,
			deps: args.deps,
		});
		if (rebuilt.packageDigest !== args.digest) {
			log.warn("[designLoop] package re-render did not reproduce the digest", {
				designSessionId: args.designSessionId,
			});
			return null;
		}
		return rebuilt;
	} catch (err) {
		if (err instanceof SourcePackageError) {
			log.warn("[designLoop] package re-render could not project honestly", {
				designSessionId: args.designSessionId,
			});
			return null;
		}
		throw err;
	}
}
