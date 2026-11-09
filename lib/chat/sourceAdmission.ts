import { z } from "zod";
import { mediaAssetIdSchema } from "@/lib/domain/multimedia";
import type { AttachmentRef, NovaUIMessage } from "./attachmentRefs";

export interface IncomingSourceReference {
	readonly messageId: string;
	readonly ref: AttachmentRef;
}

/** Stored message identities keep their historical sources. Every newly
 * supplied reference, including a question reply or several client messages,
 * must be admitted before that request can claim a run. */
export function incomingSourceReferences(
	messages: readonly NovaUIMessage[],
	previous: readonly NovaUIMessage[],
): IncomingSourceReference[] {
	const stored = new Map(
		previous.map((message) => [
			message.id,
			message.metadata?.attachments ?? [],
		]),
	);
	return messages.flatMap((message) =>
		(message.metadata?.attachments ?? [])
			.filter(
				(ref) =>
					!stored
						.get(message.id)
						?.some(
							(old) => old.assetId === ref.assetId && old.kind === ref.kind,
						),
			)
			.map((ref) => ({ messageId: message.id, ref })),
	);
}

export const sourceAdmissionRejectionSchema = z.object({
	code: z.literal("source_not_admitted"),
	error: z.string(),
	references: z.array(
		z.object({ messageId: z.string(), assetId: mediaAssetIdSchema }),
	),
});

export class SourceAdmissionRejectionError extends Error {
	readonly name = "SourceAdmissionRejectionError";
	constructor(
		readonly rejection: z.infer<typeof sourceAdmissionRejectionSchema>,
	) {
		super(rejection.error);
	}
}

/** Called only by the explicit "Send without files" action. Keep every word,
 * answer and admitted historical reference; remove exactly the rejected refs. */
export function removeRejectedSources(
	messages: readonly NovaUIMessage[],
	rejection: z.infer<typeof sourceAdmissionRejectionSchema>,
): NovaUIMessage[] {
	return messages.map((message) => {
		if (!message.metadata?.attachments) return message;
		const attachments = message.metadata.attachments.filter(
			(ref) =>
				!rejection.references.some(
					(item) =>
						item.messageId === message.id && item.assetId === ref.assetId,
				),
		);
		return { ...message, metadata: { ...message.metadata, attachments } };
	});
}
