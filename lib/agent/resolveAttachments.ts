/** Resolve only durable admitted evidence. Library state and extractor versions
 * are deliberately absent from this projection. */
import type { NovaUIMessage } from "@/lib/chat/attachmentRefs";
import {
	type RetainedSources,
	sourceProvenanceNotice,
	sourceReferenceKey,
} from "@/lib/chat/retainedSource";
import { wrapAttachment } from "./documentExtraction";

export function resolveAttachments(
	messages: NovaUIMessage[],
	retained: RetainedSources,
): NovaUIMessage[] {
	return messages.map((message) => {
		const attachments = message.metadata?.attachments ?? [];
		if (!attachments.length) return message;
		const parts = [...message.parts];
		for (const ref of attachments) {
			const retainedRef = retained.get(
				sourceReferenceKey(message.id, ref.assetId),
			);
			if (!retainedRef)
				throw new Error(
					"Conversation attachment has no retained source record",
				);
			const notice = sourceProvenanceNotice(retainedRef.provenance);
			if (notice)
				parts.push({ type: "text", text: `${ref.filename}: ${notice}` });
			const content = retainedRef.source?.content;
			if (!content) continue;
			parts.push(
				content.kind === "document"
					? {
							type: "text",
							text: wrapAttachment(
								ref.filename,
								content.text,
								content.truncated,
							),
						}
					: {
							type: "file",
							mediaType: content.mediaType,
							url: content.dataUrl,
							filename: ref.filename,
						},
			);
		}
		return { ...message, parts };
	});
}
