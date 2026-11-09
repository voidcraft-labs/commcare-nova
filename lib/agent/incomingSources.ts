import { createHash } from "node:crypto";
import type { IncomingSourceReference } from "@/lib/chat/sourceAdmission";
import { loadAssetsByIds, type MediaAssetRecord } from "@/lib/db/mediaAssets";
import {
	EXTRACTOR_VERSION,
	extractGcsObjectKeyFor,
	isDocumentKind,
	isModelReadableImageMimeType,
	type MediaAssetId,
} from "@/lib/domain/multimedia";
import { downloadAssetBytes, readTextObject } from "@/lib/storage/media";
import { EXTRACT_MAX_BYTES } from "./documentExtraction";
import { MAX_IMAGE_BYTES } from "./sources";

export class IncomingSourceUnavailableError extends Error {
	readonly name = "IncomingSourceUnavailableError";
	constructor(
		readonly filename: string,
		options?: ErrorOptions,
	) {
		super(
			`I couldn't read "${filename}", so this message hasn't been sent. You can retry preparation in the Library, or remove the file and send again.`,
			options,
		);
	}
}

/** Request-local evidence, read before a claim or question-round consumption.
 * This is not durable retention of a conversation's sources. */
export type AdmittedSource = {
	readonly asset: MediaAssetRecord;
	readonly content:
		| {
				readonly kind: "document";
				readonly text: string;
				readonly truncated: boolean;
				readonly version: number;
		  }
		| {
				readonly kind: "image";
				readonly mediaType: string;
				readonly dataUrl: string;
				readonly bytesDigest: string;
		  };
};
export type AdmittedSources = ReadonlyMap<MediaAssetId, AdmittedSource>;

/** Admission never starts or retries extraction. A ready chip is advisory:
 * verify the authorized stored content, then hand these exact bytes to either
 * executor so a second read cannot silently turn a new source into a placeholder. */
export async function admitIncomingSources(args: {
	readonly references: readonly IncomingSourceReference[];
	readonly projectId: string;
	readonly signal?: AbortSignal;
}): Promise<AdmittedSources> {
	const refs = args.references.map(({ ref }) => ref);
	const admitted = new Map<MediaAssetId, AdmittedSource>();
	if (refs.length === 0) return admitted;
	const assets = await loadAssetsByIds(
		[...new Set(refs.map((ref) => ref.assetId))],
		args.projectId,
	);
	const byId = new Map(assets.map((asset) => [asset.id, asset]));
	for (const ref of refs) {
		args.signal?.throwIfAborted();
		const asset = byId.get(ref.assetId);
		if (
			!asset ||
			asset.project_id !== args.projectId ||
			asset.status !== "ready" ||
			asset.kind !== ref.kind
		)
			throw new IncomingSourceUnavailableError(ref.filename);
		if (admitted.has(ref.assetId)) continue;
		try {
			if (isDocumentKind(asset.kind)) {
				if (
					asset.extract?.status !== "ready" ||
					asset.extract.version < EXTRACTOR_VERSION
				)
					throw new IncomingSourceUnavailableError(ref.filename);
				const text = await readTextObject(
					extractGcsObjectKeyFor(
						args.projectId,
						asset.contentHash,
						asset.extract.version,
					),
					EXTRACT_MAX_BYTES,
					args.signal,
				);
				if (!text?.trim())
					throw new IncomingSourceUnavailableError(ref.filename);
				admitted.set(ref.assetId, {
					asset,
					content: {
						kind: "document",
						text,
						truncated: asset.extract.truncated,
						version: asset.extract.version,
					},
				});
			} else {
				if (
					asset.kind !== "image" ||
					!isModelReadableImageMimeType(asset.mimeType)
				)
					throw new IncomingSourceUnavailableError(ref.filename);
				const bytes = await downloadAssetBytes(
					asset.gcsObjectKey,
					MAX_IMAGE_BYTES,
					args.signal,
				);
				if (bytes.length === 0)
					throw new IncomingSourceUnavailableError(ref.filename);
				admitted.set(ref.assetId, {
					asset,
					content: {
						kind: "image",
						mediaType: asset.mimeType,
						dataUrl: `data:${asset.mimeType};base64,${bytes.toString("base64")}`,
						bytesDigest: createHash("sha256").update(bytes).digest("hex"),
					},
				});
			}
		} catch (error) {
			args.signal?.throwIfAborted();
			if (error instanceof IncomingSourceUnavailableError) throw error;
			throw new IncomingSourceUnavailableError(ref.filename, { cause: error });
		}
	}
	return admitted;
}
