import { z } from "zod";
import { DOCUMENT_KINDS, mediaAssetIdSchema } from "@/lib/domain/multimedia";

/** Server-owned evidence of a successful library read, separate from user attachments. */
export const selectedSourceDocumentSchema = z.strictObject({
	assetId: mediaAssetIdSchema,
	kind: z.enum(DOCUMENT_KINDS),
	filename: z.string().min(1).max(255),
	mimeType: z.string().min(1).max(255),
	contentHash: z.string().min(1),
	extractVersion: z.number().int().positive(),
	extractDigest: z.string().min(1),
	revision: z.string().min(1),
});
export type SelectedSourceDocument = z.infer<
	typeof selectedSourceDocumentSchema
>;
export const selectedSourceDocumentsSchema = z.array(
	selectedSourceDocumentSchema,
);
