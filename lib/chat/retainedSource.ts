/** Model-readable source content, owned by a conversation rather than a Library row. */
import { z } from "zod";
import { CHAT_ATTACHMENT_KINDS } from "./attachmentRefs";

export const sourceContentSchema = z.discriminatedUnion("kind", [
	z.strictObject({
		kind: z.literal("document"),
		text: z.string().min(1),
		truncated: z.boolean(),
		version: z.number().int().positive(),
	}),
	z.strictObject({
		kind: z.literal("image"),
		mediaType: z.enum(["image/png", "image/jpeg", "image/gif", "image/webp"]),
		dataUrl: z.string().min(1),
		bytesDigest: z.string().regex(/^[a-f0-9]{64}$/),
	}),
]);
export type SourceContent = z.infer<typeof sourceContentSchema>;
export const retainedSourceSchema = z.strictObject({
	kind: z.enum(CHAT_ATTACHMENT_KINDS),
	filename: z.string().min(1).max(255),
	mimeType: z.string().min(1).max(255),
	contentHash: z.string().min(1),
	content: sourceContentSchema,
});
export type RetainedSource = z.infer<typeof retainedSourceSchema>;
export type SourceProvenance =
	| "admitted"
	| "verified-legacy"
	| "migration-baseline"
	| "unavailable";
export interface RetainedSourceReference {
	readonly messageId: string;
	readonly assetId: string;
	readonly filename?: string;
	readonly revision: string | null;
	readonly provenance: SourceProvenance;
	readonly source: RetainedSource | null;
}
export function sourceReferenceKey(messageId: string, assetId: string): string {
	return JSON.stringify([messageId, assetId]);
}
export type RetainedSources = ReadonlyMap<string, RetainedSourceReference>;
export function sourceProvenanceNotice(
	provenance: SourceProvenance,
): string | null {
	if (provenance === "migration-baseline")
		return "This file was retained when conversation source history was introduced. Its original extracted text was not recorded, so this is the version available at migration, not a verified copy of what the earlier conversation read.";
	if (provenance === "unavailable")
		return "This older source could not be retained. Attach a current file in a new message to use it in this conversation.";
	return null;
}

export function selectedSourceReferenceKey(
	assetId: string,
	revision: string,
): string {
	return `${sourceReferenceKey("", assetId)}:${revision}`;
}
