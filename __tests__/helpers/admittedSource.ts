import type { AdmittedSources } from "@/lib/agent/incomingSources";
import type { RetainedSource } from "@/lib/chat/retainedSource";
import { asMediaAssetId, EXTRACTOR_VERSION } from "@/lib/domain/multimedia";

/** Explicit request-boundary evidence for storage tests. The production writer
 * still checks the live asset under its own lock; this is not a DB substitute. */
export function admittedDocument(
	assetId: string,
	projectId = "project-test",
	text = "Collect the visit date.",
): AdmittedSources {
	const id = asMediaAssetId(assetId);
	return new Map([
		[
			id,
			{
				asset: {
					id,
					project_id: projectId,
					owner: "owner-test",
					contentHash: assetId.padEnd(64, "a").slice(0, 64),
					mimeType: "application/pdf",
					extension: ".pdf",
					sizeBytes: 128,
					kind: "pdf",
					gcsObjectKey: `projects/${projectId}/${assetId}.pdf`,
					originalFilename: "requirements.pdf",
					status: "ready",
					created_at: new Date(0),
				},
				content: {
					kind: "document",
					text,
					version: EXTRACTOR_VERSION,
					truncated: false,
				},
			},
		],
	]);
}
export function retainedDocument(assetId: string): RetainedSource {
	const admitted = admittedDocument(assetId).get(asMediaAssetId(assetId));
	if (!admitted) throw new Error("Missing fixture source");
	return {
		kind: "pdf",
		filename: admitted.asset.originalFilename,
		mimeType: admitted.asset.mimeType,
		contentHash: admitted.asset.contentHash,
		content: admitted.content,
	};
}
