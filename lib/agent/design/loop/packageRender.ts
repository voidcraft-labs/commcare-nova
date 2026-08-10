/**
 * The loop's conversation-shaped package rendering.
 *
 * The one-shot pipeline rendered the whole source package into a single
 * prompt. The loop rides a CONVERSATION, so the same content is decomposed
 * onto the messages that carry it: each user message's text parts are
 * replaced by their delimited, coordinate-labeled source blocks, and the
 * documents and images that message attached follow inside it. The
 * projection of one message depends only on that message's own content, so
 * a message's rendering is byte-stable from the turn it first appears,
 * which is what keeps the provider's cached prefix intact as the thread
 * grows.
 *
 * Seeded claims deliberately do NOT ride the messages: they are cumulative
 * (every answered round re-derives them), so a stable-prefix rendering
 * would go stale. They ride the per-turn state message instead: the
 * volatile tail that is re-billed every turn anyway.
 */

import type { UIMessage } from "ai";
import type { DesignGateState } from "@/lib/agent/design/loop/gates";
import {
	imageSourceLabel,
	renderAttachmentSource,
	renderRequestBlockSource,
} from "@/lib/agent/design/prompts";
import type { DesignReview } from "@/lib/agent/design/review";
import type {
	DesignSourcePackage,
	SourceClaimSeed,
} from "@/lib/agent/design/sourcePackage";

type PackageImage = DesignSourcePackage["images"][number];

export const DESIGN_STATE_MESSAGE_HEADING =
	"# Design session state (server-derived)";

export interface DesignWorkspaceStateSummary {
	readonly artifactKind: "contract" | "revision" | "plan";
	readonly revision: number;
	readonly stepCount: number;
	readonly counts: Readonly<Record<string, number>>;
	readonly missingRootFields: readonly string[];
}

export interface MessageSourceProjection {
	/** The delimited source text replacing the message's text parts. */
	readonly text: string;
	/** Images this message attached, riding as label + file part pairs. */
	readonly images: readonly PackageImage[];
}

/** The asset ids a message's metadata names, read defensively (parts and
 *  metadata arrive from the client). */
function messageAssetIds(message: UIMessage): string[] {
	const attachments = (
		message.metadata as
			| { attachments?: Array<{ assetId?: unknown }> }
			| undefined
	)?.attachments;
	if (!Array.isArray(attachments)) return [];
	return attachments.flatMap((ref) =>
		typeof ref?.assetId === "string" ? [ref.assetId] : [],
	);
}

/**
 * Which package content belongs to which user message. Attachments follow
 * the FIRST message that referenced them: the same dedupe rule the package
 * builder applies: so the projection and the package agree on ownership.
 */
export function projectPackageOntoMessages(
	pkg: DesignSourcePackage,
	messages: readonly UIMessage[],
): Map<string, MessageSourceProjection> {
	const blocksByMessage = new Map<string, string[]>();
	for (const block of pkg.request.blocks) {
		const lines = blocksByMessage.get(block.ref.messageId) ?? [];
		lines.push(...renderRequestBlockSource(block));
		blocksByMessage.set(block.ref.messageId, lines);
	}
	const attachmentsById = new Map(
		pkg.attachments.map((attachment) => [
			attachment.assetId as string,
			attachment,
		]),
	);
	const imagesById = new Map(
		pkg.images.map((image) => [image.assetId as string, image]),
	);

	const projections = new Map<string, MessageSourceProjection>();
	const claimedAssets = new Set<string>();
	for (const message of messages) {
		if (message.role !== "user") continue;
		const lines = [...(blocksByMessage.get(message.id) ?? [])];
		const images: PackageImage[] = [];
		for (const assetId of messageAssetIds(message)) {
			if (claimedAssets.has(assetId)) continue;
			claimedAssets.add(assetId);
			const attachment = attachmentsById.get(assetId);
			if (attachment) {
				if (lines.length > 0) lines.push("");
				lines.push(...renderAttachmentSource(attachment));
				continue;
			}
			const image = imagesById.get(assetId);
			if (image) images.push(image);
		}
		if (lines.length === 0 && images.length === 0) {
			continue;
		}
		projections.set(message.id, {
			text: lines.join("\n"),
			images,
		});
	}
	return projections;
}

/**
 * Replace each projected user message's text parts with its source
 * rendering, and append its images as label + file part pairs. Messages
 * without a projection (and every non-user message) pass through by
 * reference, so the transform is deterministic and prefix-stable.
 */
export function applySourceProjection<M extends UIMessage>(
	messages: readonly M[],
	projections: ReadonlyMap<string, MessageSourceProjection>,
): M[] {
	return messages.flatMap((message): M[] => {
		if (message.role !== "user") return [message];
		const projection = projections.get(message.id);
		if (projection === undefined) return [message];
		const parts: UIMessage["parts"] = [];
		if (projection.text.length > 0) {
			parts.push({ type: "text", text: projection.text });
		}
		for (const image of projection.images) {
			parts.push({ type: "text", text: imageSourceLabel(image) });
			parts.push({
				type: "file",
				mediaType: image.mediaType,
				url: image.dataUrl,
			});
		}
		/* Non-text parts the message already carried (files a future composer
		 * might attach directly) survive after the source rendering. */
		const carried = message.parts.filter((part) => part.type !== "text");
		return [{ ...message, parts: [...parts, ...carried] }];
	});
}

/**
 * The per-turn state message: the volatile tail that makes resume
 * explicit, never assumed. It carries the open findings and a bounded durable
 * workspace checkpoint; exact candidate/source content stays recoverable
 * through inspectDesignWorkspace. A redrive, process loss, or provider
 * compaction therefore cannot erase accepted authoring work or force a large
 * artifact back into one prompt tail.
 */
export function renderDesignStateMessage(args: {
	gates: DesignGateState;
	claims: readonly SourceClaimSeed[];
	/** Reviews of the head draft whose findings await disposition, included
	 *  when the thread does not carry them. */
	openReviews: readonly DesignReview[] | null;
	/** Private staged authoring survives provider compaction and process loss.
	 * This bounded summary tells the model where to resume; exact items remain
	 * available through inspectDesignWorkspace. */
	workspace: DesignWorkspaceStateSummary | null;
}): string {
	const lines: string[] = [
		DESIGN_STATE_MESSAGE_HEADING,
		"",
		args.gates.expectedNext,
	];
	if (args.gates.blockingQuestions.length > 0) {
		lines.push("", "Blocking open questions on the accepted design:");
		for (const question of args.gates.blockingQuestions) {
			lines.push(`- ${question}`);
		}
	}
	lines.push("", "## Seeded claims (reuse these ids exactly)");
	lines.push(
		args.claims.length > 0 ? JSON.stringify(args.claims, null, 1) : "None yet.",
	);
	if (args.openReviews && args.openReviews.length > 0) {
		lines.push("", "## Review findings awaiting disposition");
		lines.push(
			JSON.stringify(
				args.openReviews.map((review) => ({
					summary: review.summary,
					findings: review.findings,
				})),
				null,
				1,
			),
		);
	}
	if (args.workspace) {
		lines.push("", "## Durable authoring workspace");
		lines.push(
			JSON.stringify(
				{
					artifactKind: args.workspace.artifactKind,
					revision: args.workspace.revision,
					stepCount: args.workspace.stepCount,
					counts: args.workspace.counts,
					missingRootFields: args.workspace.missingRootFields,
					instruction:
						"Continue from this workspace revision. Use inspectDesignWorkspace for exact root or collection items; revision and plan workspaces also expose their immutable source contract. Do not recreate saved stages.",
				},
				null,
				1,
			),
		);
	}
	return lines.join("\n");
}
